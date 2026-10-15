import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applySnapshot,
	coverageRows,
	createState,
	diffTotals,
	formatFooter,
	formatSummary,
	formatWidget,
	knownClients,
	parseHealthz,
	parseMetrics,
	PROBE_TIMEOUT_MS,
	probe,
	readTokenNames,
	refresh,
	resolveToken,
	safeText,
	shouldPoll,
	surfaceTotals,
	type FetchLike,
	type ProbeDeps,
	type Snapshot,
	type State,
} from "./substrate-status.ts";

const TOKEN = "TEST-TOKEN-VALUE";
const STARTED = "2026-10-13T21:32:58.788Z";
const LATER = "2026-10-14T08:00:00.000Z";
/** Real timers on purpose, the rare exception to deterministic time control: these cases check the 3000 ms client timeout against the platform clock, the behaviour the spec names. */
const SLOW_TEST_MS = 10_000;

/** Synthetic GET /metrics body, field names as the real payload uses them. */
function metricsFixture(startedAt: string, omp: { req: number; emit: number; tool: number }) {
	return {
		startedAt,
		metrics: [
			{
				kind: "counter",
				name: "substrate.request.total",
				points: [
					{ attributes: { surface: "omp", route: "/brief", status: "2xx" }, value: omp.req },
					{ attributes: { surface: "omp", route: "/healthz", status: "2xx" }, value: 999 },
					{ attributes: { surface: "grok-bot", route: "/brief", status: "2xx" }, value: 7 },
				],
			},
			{
				kind: "counter",
				name: "substrate.emit.total",
				points: [{ attributes: { surface: "omp", kind: "note", outcome: "stored" }, value: omp.emit }],
			},
			{
				kind: "counter",
				name: "substrate.tool.calls",
				points: [{ attributes: { surface: "omp", tool: "brief", decision: "allowed" }, value: omp.tool }],
			},
			{
				kind: "histogram",
				name: "substrate.request.duration",
				points: [
					{ attributes: { surface: "omp", route: "/brief", status: "2xx" }, count: omp.req, sum: 500, min: 1, max: 9, bucketCounts: [0, 1] },
					{ attributes: { surface: "omp", route: "/metrics", status: "2xx" }, count: 50, sum: 900, min: 1, max: 9, bucketCounts: [] },
				],
			},
			{
				kind: "histogram",
				name: "substrate.brief.duration",
				points: [{ attributes: { surface: "omp", outcome: "ok" }, count: omp.req, sum: 300, min: 1, max: 9, bucketCounts: [] }],
			},
		],
	};
}

/** Synthetic GET /healthz body with planes, cache and capacity.ledger.tables. */
function healthFixture(ragflowOk = true) {
	return {
		index: true,
		greptime: true,
		planes: {
			greptime: { ok: true, breaker: { plane: "greptime", state: "closed", failures: 0, openedAt: null, lastErrorAt: null, lastError: null }, lastErrorAt: null },
			index: { ok: true, breaker: { state: "closed" } },
			ragflow: { ok: ragflowOk, breaker: { state: ragflowOk ? "closed" : "open" } },
		},
		cache: { enabled: true, connected: true, mode: "on", hits: 74, misses: 471, bypasses: 0, errors: 0, cooldownUntil: null },
		capacity: {
			index: null,
			ledger: {
				bytes: 2966041,
				rows: 27914,
				tables: [
					{ name: "agent_events", rows: 15466 },
					{ name: "anchors", rows: 0 },
				],
			},
		},
	};
}

function snapshot(at: number, startedAt: string, omp: { req: number; emit: number; tool: number }, ragflowOk = true): Snapshot {
	const metrics = parseMetrics(metricsFixture(startedAt, omp));
	const health = parseHealthz(healthFixture(ragflowOk));
	if (!metrics || !health) throw new Error("fixture did not parse");
	return { at, metrics, health };
}

/** A snapshot whose request counter is given per surface, for coverage and change tests. */
function countsBySurface(at: number, counts: Record<string, number>): Snapshot {
	const metrics = parseMetrics({
		startedAt: STARTED,
		metrics: [
			{
				kind: "counter",
				name: "substrate.request.total",
				points: Object.entries(counts).map(([surface, value]) => ({ attributes: { surface, route: "/brief", status: "2xx" }, value })),
			},
		],
	});
	const health = parseHealthz(healthFixture());
	if (!metrics || !health) throw new Error("fixture did not parse");
	return { at, metrics, health };
}

/** A fake fetch that answers /metrics and /healthz from the fixtures and records each Authorization header. */
function fakeFetch(seen: Array<string | undefined>, metrics = metricsFixture(STARTED, { req: 10, emit: 4, tool: 3 })): FetchLike {
	return async (url, init) => {
		const headers = init.headers as Record<string, string>;
		seen.push(headers.authorization);
		const body = url.endsWith("/metrics") ? metrics : healthFixture();
		return new Response(JSON.stringify(body), { status: 200 });
	};
}

/** Delays every answer by `delayMs` before handing the request to `inner`. */
function delayed(inner: FetchLike, delayMs: number): FetchLike {
	return async (url, init) => {
		await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		return inner(url, init);
	};
}

const refusedFetch: FetchLike = async () => {
	throw new TypeError("connection refused");
};

const denyFetch: FetchLike = async () => new Response("", { status: 401 });

describe("parsing", () => {
	test("surface totals sum per surface and skip monitoring routes", () => {
		const parsed = parseMetrics(metricsFixture(STARTED, { req: 10, emit: 4, tool: 3 }));
		if (!parsed) throw new Error("metrics fixture did not parse");
		const omp = surfaceTotals(parsed, "omp");
		expect(omp.req).toBe(10);
		expect(omp.emit).toBe(4);
		expect(omp.tool).toBe(3);
		expect(omp.requestDuration).toEqual({ count: 10, sum: 500 });
		expect(omp.briefDuration).toEqual({ count: 10, sum: 300 });
		expect(surfaceTotals(parsed, "grok-bot").req).toBe(7);
		expect(surfaceTotals(parsed, "absent").req).toBe(0);
	});

	test("parseMetrics rejects a body without startedAt", () => {
		expect(parseMetrics({ metrics: [] })).toBeNull();
	});

	test("parseHealthz reads planes, breaker state, cache and the anchors row", () => {
		const health = parseHealthz(healthFixture(false));
		expect(health).not.toBeNull();
		expect(health?.planes.greptime).toEqual({ ok: true, breaker: "closed" });
		expect(health?.planes.ragflow).toEqual({ ok: false, breaker: "open" });
		expect(health?.cacheHits).toBe(74);
		expect(health?.cacheMisses).toBe(471);
		expect(health?.ledgerRows).toBe(27914);
		expect(health?.anchorRows).toBe(0);
		expect(parseHealthz({})).toBeNull();
	});
});

describe("diff and restart", () => {
	test("diffTotals gives the per-field difference", () => {
		expect(diffTotals({ req: 10, emit: 4, tool: 3 }, { req: 15, emit: 4, tool: 5 })).toEqual({ req: 5, emit: 0, tool: 2 });
	});

	test("diffTotals never returns a negative delta", () => {
		expect(diffTotals({ req: 100, emit: 0, tool: 0 }, { req: 5, emit: 0, tool: 0 }).req).toBe(0);
	});

	test("a changed startedAt resets the baseline with no negative delta", () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 100, emit: 50, tool: 20 }), 1_000);
		applySnapshot(state, snapshot(2_000, LATER, { req: 5, emit: 1, tool: 0 }), 2_000);
		expect(state.lastDelta).toEqual({ req: 0, emit: 0, tool: 0 });
		expect(state.last?.metrics.startedAt).toBe(LATER);
		applySnapshot(state, snapshot(3_000, LATER, { req: 9, emit: 1, tool: 0 }), 3_000);
		expect(state.lastDelta).toEqual({ req: 4, emit: 0, tool: 0 });
	});
});

describe("footer and widget", () => {
	test("checking before any probe has completed", () => {
		expect(formatFooter(createState("session-1"), 1_000)).toBe("substrate · checking");
	});

	test("an error before any good snapshot shows no counts and no zeros", async () => {
		const state = createState("session-1");
		await refresh(state, { fetchImpl: refusedFetch, env: {}, readFile: () => null, now: () => 1_000 });
		const footer = formatFooter(state, 2_000);
		expect(footer).toContain("ERROR (unreachable)");
		expect(footer).toContain("no data yet");
		expect(footer).not.toMatch(/\d req|\+\d/);
	});

	test("an error after a good poll shows the last good time and no counts", async () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		applySnapshot(state, snapshot(2_000, STARTED, { req: 12, emit: 9, tool: 3 }), 2_000);
		await refresh(state, { fetchImpl: refusedFetch, env: {}, readFile: () => null, now: () => 3_000 });
		const footer = formatFooter(state, 3_000);
		expect(footer).toContain("ERROR (unreachable)");
		expect(footer).toContain("last good");
		expect(footer).toContain("/substrate retries");
		expect(footer).not.toContain("omp +");
	});

	test("NOT_OBSERVED_IN_WINDOW while omp is unchanged, never IN_USE", () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		applySnapshot(state, snapshot(2_000, STARTED, { req: 10, emit: 4, tool: 3 }), 2_000);
		const footer = formatFooter(state, 2_000);
		expect(footer).toContain("NOT_OBSERVED_IN_WINDOW");
		expect(footer).not.toContain("IN_USE");
	});

	test("IN_USE after an omp change, back to NOT_OBSERVED_IN_WINDOW once five minutes pass", () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		applySnapshot(state, snapshot(2_000, STARTED, { req: 12, emit: 9, tool: 3 }), 2_000);
		expect(formatFooter(state, 3_000)).toContain("IN_USE");
		expect(formatFooter(state, 2_000 + 5 * 60_000)).toContain("NOT_OBSERVED_IN_WINDOW");
	});

	test("the footer shows the last poll's omp change", () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		applySnapshot(state, snapshot(2_000, STARTED, { req: 12, emit: 9, tool: 3 }), 2_000);
		expect(formatFooter(state, 3_000)).toContain("omp +2 req +5 emit");
	});

	test("a plane that is down is named, and usage is still reported", () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }, false), 1_000);
		applySnapshot(state, snapshot(2_000, STARTED, { req: 12, emit: 4, tool: 3 }, false), 2_000);
		const footer = formatFooter(state, 2_500);
		expect(footer).toContain("ragflow down");
		expect(footer).toContain("IN_USE");
	});

	test("ACCESS_DENIED shows no counts", async () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		await refresh(state, { fetchImpl: denyFetch, env: {}, readFile: () => null, now: () => 2_000 });
		const footer = formatFooter(state, 2_000);
		expect(footer).toContain("ACCESS_DENIED auth required");
		expect(footer).not.toContain("omp +");
	});

	test("the footer never exceeds 79 characters, even for a long error reason", () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		state.lastProbe = { ok: false, reason: "x".repeat(200), at: 2_000 };
		expect(formatFooter(state, 2_000).length).toBeLessThanOrEqual(79);
	});

	test("the widget is empty until omp changes, then states its cap and shows the change", () => {
		const state = createState("session-1");
		expect(formatWidget(state)).toEqual([]);
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		const at = new Date(2026, 9, 13, 10, 5).getTime();
		applySnapshot(state, snapshot(at, STARTED, { req: 15, emit: 6, tool: 4 }), at);
		const lines = formatWidget(state);
		expect(lines[0]).toContain("cap 3");
		expect(lines.slice(1)).toEqual(["10:05  +5 req  +2 emit  +1 tool"]);
	});

	test("the widget keeps only the last three changes", () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 0, emit: 0, tool: 0 }), 1_000);
		for (let step = 1; step <= 4; step++) {
			applySnapshot(state, snapshot(1_000 + step * 1_000, STARTED, { req: step, emit: 0, tool: 0 }), 1_000 + step * 1_000);
		}
		expect(formatWidget(state).slice(1)).toHaveLength(3);
	});
});

describe("usage, coverage and /substrate", () => {
	test("the summary states the usage definition on screen", () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		const text = formatSummary(state, 1_000).join("\n");
		expect(text).toContain("IN_USE");
		expect(text).toContain("NOT_OBSERVED_IN_WINDOW");
		expect(text).toContain("last 5 min");
	});

	test("a known client with no counters is NOT_INSTRUMENTED; one with counters is not", () => {
		const state = createState("session-1");
		state.known = ["omp", "grok-bot", "codex"];
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		const coverage = Object.fromEntries(coverageRows(state, 1_000).map((row) => [row.name, row.coverage]));
		expect(coverage.codex).toBe("NOT_INSTRUMENTED");
		expect(coverage["grok-bot"]).not.toBe("NOT_INSTRUMENTED");
		expect(coverage.omp).not.toBe("NOT_INSTRUMENTED");
	});

	test("a client with a change in the window is OBSERVED, and NO_ACTIVITY_IN_WINDOW after five minutes", () => {
		const state = createState("session-1");
		state.known = ["omp", "grok-bot"];
		applySnapshot(state, countsBySurface(1_000, { omp: 10, "grok-bot": 7 }), 1_000);
		applySnapshot(state, countsBySurface(2_000, { omp: 10, "grok-bot": 9 }), 2_000);
		const grokAt = (now: number) => coverageRows(state, now).find((row) => row.name === "grok-bot")?.coverage;
		expect(grokAt(2_500)).toBe("OBSERVED");
		expect(grokAt(2_000 + 5 * 60_000)).toBe("NO_ACTIVITY_IN_WINDOW");
	});

	test("a counted surface outside the known list is flagged, not dropped", () => {
		const state = createState("session-1");
		state.known = ["omp"];
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		const flagged = coverageRows(state, 1_000).find((row) => row.name === "grok-bot");
		expect(flagged?.coverage).toBe("UNREGISTERED_CLIENT");
	});

	test("partial coverage names the NOT_INSTRUMENTED clients", () => {
		const state = createState("session-1");
		state.known = ["omp", "codex"];
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		const text = formatSummary(state, 1_000).join("\n");
		expect(text).toContain("NOT_INSTRUMENTED: codex");
		expect(text).toContain("covers observed clients only");
	});

	test("control characters in a surface name are not printed", () => {
		const state = createState("session-1");
		state.known = ["omp"];
		applySnapshot(state, countsBySurface(1_000, { omp: 10, "ev\u001b[2Jil": 3 }), 1_000);
		const text = formatSummary(state, 1_000).join("\n");
		expect(text).not.toContain("\u001b");
		expect(text).toContain("unregistered");
	});

	test("a credential-like value in a health record never reaches the summary or the footer", () => {
		const state = createState("session-1");
		const raw = healthFixture();
		const health = parseHealthz({
			...raw,
			token: "CANARY-TOKEN-VALUE",
			planes: { ...raw.planes, ragflow: { ok: true, breaker: { state: "closed" }, token: "CANARY-TOKEN-VALUE" } },
		});
		const metrics = parseMetrics(metricsFixture(STARTED, { req: 10, emit: 4, tool: 3 }));
		if (!health || !metrics) throw new Error("fixture did not parse");
		applySnapshot(state, { at: 1_000, metrics, health }, 1_000);
		expect(formatSummary(state, 1_000).join("\n")).not.toContain("CANARY-TOKEN-VALUE");
		expect(formatFooter(state, 1_000)).not.toContain("CANARY-TOKEN-VALUE");
	});

	test("an error shows last-known counters labelled as such, a retry line, and no usage claim", async () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		await refresh(state, { fetchImpl: refusedFetch, env: {}, readFile: () => null, now: () => 2_000 });
		const text = formatSummary(state, 2_000).join("\n");
		expect(text).toContain("last known");
		expect(text).toContain("retry: run /substrate again");
		expect(text).toContain("omp: UNKNOWN");
	});

	test("an error before any good poll prints no counters", async () => {
		const state = createState("session-1");
		await refresh(state, { fetchImpl: refusedFetch, env: {}, readFile: () => null, now: () => 1_000 });
		const text = formatSummary(state, 1_000).join("\n");
		expect(text).toContain("ERROR");
		expect(text).not.toMatch(/req \d/);
	});

	test("access denied prints no counters", async () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		await refresh(state, { fetchImpl: denyFetch, env: {}, readFile: () => null, now: () => 2_000 });
		const text = formatSummary(state, 2_000).join("\n");
		expect(text).toContain("ACCESS_DENIED");
		expect(text).not.toMatch(/req \d/);
	});

	test("a counted surface outside the known list keeps its counters in the summary", () => {
		const state = createState("session-1");
		state.known = ["omp"];
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		expect(formatSummary(state, 1_000).join("\n")).toContain("grok-bot req 7, emit 0, tool 0");
	});

	test("after a failed poll, each client's coverage stays as it was at the last good poll", async () => {
		const state = createState("session-1");
		state.known = ["omp"];
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		applySnapshot(state, snapshot(2_000, STARTED, { req: 12, emit: 4, tool: 3 }), 2_000);
		const later = 2_000 + 10 * 60_000;
		await refresh(state, { fetchImpl: refusedFetch, env: {}, readFile: () => null, now: () => later });
		expect(formatSummary(state, later).join("\n")).toContain("omp: OBSERVED");
	});
});

describe("known clients and terminal text", () => {
	test("token file names are the known list, omp first, and names that are not plain are left out", () => {
		const names = knownClients({ SUBSTRATE_TOKENS_DIR: "/tokens" }, (dir) =>
			dir === "/tokens" ? ["codex", "omp", "bad name!", "grok-bot"] : null,
		);
		expect(names).toEqual(["omp", "codex", "grok-bot"]);
	});

	test("an unreadable tokens dir leaves omp as the only known client", () => {
		expect(knownClients({}, () => null)).toEqual(["omp"]);
	});

	test("safeText drops control and bidi-override characters", () => {
		expect(safeText("a\u001b[31mb\u202ec\u0007")).toBe("a[31mbc");
	});

	test("a folder in the tokens dir is not a client; a symlinked token file is", () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-tokens-"));
		try {
			writeFileSync(join(dir, "codex"), "token");
			mkdirSync(join(dir, "backup"));
			symlinkSync(join(dir, "codex"), join(dir, "pi"));
			expect(readTokenNames(dir)?.sort()).toEqual(["codex", "pi"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("poll throttle", () => {
	test("false at 29 s, true at 31 s", () => {
		expect(shouldPoll(29_000, 0, 30_000)).toBe(false);
		expect(shouldPoll(31_000, 0, 30_000)).toBe(true);
	});

	test("true when no poll has run yet", () => {
		expect(shouldPoll(0, null, 30_000)).toBe(true);
	});
});

describe("probe", () => {
	test("the client timeout is 3000 ms", () => {
		expect(PROBE_TIMEOUT_MS).toBe(3000);
	});

	test("a probe that resolves after 2000 ms still succeeds", async () => {
		const started = Date.now();
		const result = await probe({ fetchImpl: delayed(fakeFetch([]), 2000), env: {}, readFile: () => null, now: () => 7 });
		expect(result.ok).toBe(true);
		expect(Date.now() - started).toBeLessThan(PROBE_TIMEOUT_MS);
	}, SLOW_TEST_MS);

	test("a request that never answers is unreachable with reason timeout after the client timeout", async () => {
		const fetchImpl = (_url: string, init: RequestInit): Promise<Response> =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		const started = Date.now();
		const result = await probe({ fetchImpl, env: {}, readFile: () => null, now: () => 5 });
		expect(result).toEqual({ ok: false, reason: "timeout" });
		expect(Date.now() - started).toBeGreaterThanOrEqual(PROBE_TIMEOUT_MS - 50);
	}, SLOW_TEST_MS);

	test("a refused connection is unreachable", async () => {
		expect(await probe({ fetchImpl: refusedFetch, env: {}, readFile: () => null })).toEqual({ ok: false, reason: "unreachable" });
	});

	test("a non-2xx answer other than auth gives http <status>", async () => {
		const fetchImpl = async (): Promise<Response> => new Response("", { status: 503 });
		expect(await probe({ fetchImpl, env: {}, readFile: () => null })).toEqual({ ok: false, reason: "http 503" });
	});

	test("a 401 with no token is auth required", async () => {
		expect(await probe({ fetchImpl: denyFetch, env: {}, readFile: () => null })).toEqual({ ok: false, reason: "auth required" });
	});

	test("a 401 with a token sent is auth failed, and the token never appears in the rendered text", async () => {
		const deps: ProbeDeps = { fetchImpl: denyFetch, env: { SUBSTRATE_TOKEN: TOKEN }, readFile: () => null, now: () => 1 };
		const result = await probe(deps);
		expect(result).toEqual({ ok: false, reason: "auth failed" });

		const state = createState("session-1");
		await refresh(state, deps);
		expect(formatFooter(state, 2)).not.toContain(TOKEN);
		const summary = formatSummary(state, 2).join("\n");
		expect(summary).toContain("auth failed");
		expect(summary).toContain("hint:");
		for (const output of [formatFooter(state, 2), summary, JSON.stringify(result)]) {
			expect(output).not.toContain(TOKEN);
		}
	});

	test("the token travels only as the Authorization header and never appears in output", async () => {
		const seen: Array<string | undefined> = [];
		const deps: ProbeDeps = { fetchImpl: fakeFetch(seen), env: { SUBSTRATE_TOKEN: TOKEN }, readFile: () => null, now: () => 42 };
		const result = await probe(deps);
		expect(result.ok).toBe(true);
		expect(seen).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);

		const state = createState("session-1");
		if (result.ok) applySnapshot(state, result.snapshot, 42);
		const outputs = [formatFooter(state, 42), ...formatWidget(state), ...formatSummary(state, 42), JSON.stringify(result)];
		for (const output of outputs) expect(output).not.toContain(TOKEN);
	});

	test("two overlapping refresh calls issue one probe, and both see its result", async () => {
		const seen: Array<string | undefined> = [];
		const state = createState("session-1");
		const deps: ProbeDeps = { fetchImpl: fakeFetch(seen), env: {}, readFile: () => null, now: () => 1_000 };
		const first = refresh(state, deps);
		const second = refresh(state, deps);
		expect(second).toBe(first);
		await Promise.all([first, second]);
		expect(seen).toHaveLength(2); // one /metrics and one /healthz
		expect(state.last).not.toBeNull();
	});

	test("refresh keeps the last good snapshot when a later poll fails", async () => {
		const state: State = createState("session-1");
		await refresh(state, { fetchImpl: fakeFetch([]), env: {}, readFile: () => null, now: () => 1_000 });
		expect(state.last).not.toBeNull();
		await refresh(state, { fetchImpl: refusedFetch, env: {}, readFile: () => null, now: () => 2_000 });
		expect(state.lastProbe).toEqual({ ok: false, reason: "unreachable", at: 2_000 });
		expect(state.last).not.toBeNull();
		expect(formatSummary(state, 2_000).join("\n")).toContain("req 10");
	});
});

describe("token resolution", () => {
	test("SUBSTRATE_TOKEN wins over the token file and the tokens dir", () => {
		const calls: string[] = [];
		const readFile = (path: string): string | null => {
			calls.push(path);
			return "from-file";
		};
		expect(resolveToken({ SUBSTRATE_TOKEN: TOKEN, SUBSTRATE_TOKEN_FILE: "/x/y" }, readFile)).toBe(TOKEN);
		expect(calls).toEqual([]);
	});

	test("SUBSTRATE_TOKEN_FILE is read before the tokens dir", () => {
		expect(resolveToken({ SUBSTRATE_TOKEN_FILE: "/x/y" }, (path) => (path === "/x/y" ? "file-token" : null))).toBe("file-token");
	});

	test("falls back to the omp file in the tokens dir, then null", () => {
		expect(resolveToken({ SUBSTRATE_TOKENS_DIR: "/d" }, (path) => (path === "/d/omp" ? "dir-token" : null))).toBe("dir-token");
		expect(resolveToken({}, () => null)).toBeNull();
	});
});
