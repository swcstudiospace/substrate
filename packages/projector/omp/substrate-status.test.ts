import { describe, expect, test } from "bun:test";
import {
	applySnapshot,
	createState,
	diffTotals,
	formatFooter,
	formatSummary,
	formatWidget,
	parseHealthz,
	parseMetrics,
	probe,
	refresh,
	resolveToken,
	shouldPoll,
	surfaceTotals,
	type ProbeDeps,
	type Snapshot,
	type State,
} from "./substrate-status.ts";

const TOKEN = "TEST-TOKEN-VALUE";
const STARTED = "2026-10-13T21:32:58.788Z";
const LATER = "2026-10-14T08:00:00.000Z";

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

/** A fake fetch that answers /metrics and /healthz from the fixtures and records each Authorization header. */
function fakeFetch(seen: Array<string | undefined>, metrics = metricsFixture(STARTED, { req: 10, emit: 4, tool: 3 })) {
	return async (url: string, init: RequestInit): Promise<Response> => {
		const headers = init.headers as Record<string, string>;
		seen.push(headers.authorization);
		const body = url.endsWith("/metrics") ? metrics : healthFixture();
		return new Response(JSON.stringify(body), { status: 200 });
	};
}

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
	test("idle when omp deltas stay at zero", () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		expect(formatFooter(state, 2_000)).toBe("substrate · omp +0 req · +0 emit · idle");
	});

	test("healthy shows the last poll's deltas", () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		applySnapshot(state, snapshot(2_000, STARTED, { req: 12, emit: 9, tool: 3 }), 2_000);
		expect(formatFooter(state, 3_000)).toBe("substrate · omp +2 req · +5 emit · healthy");
	});

	test("idle again once five minutes pass without an omp delta", () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		applySnapshot(state, snapshot(2_000, STARTED, { req: 12, emit: 4, tool: 3 }), 2_000);
		expect(formatFooter(state, 2_000 + 5 * 60_000)).toBe("substrate · omp +2 req · +0 emit · idle");
	});

	test("degraded names the plane that is not ok", () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }, false), 1_000);
		expect(formatFooter(state, 2_000)).toBe("substrate · omp +0 req · +0 emit · degraded (ragflow)");
	});

	test("unreachable shows the reason", () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		state.lastProbe = { ok: false, reason: "timeout", at: 2_000 };
		expect(formatFooter(state, 2_000)).toBe("substrate · unreachable (timeout)");
	});

	test("widget is empty with no nonzero polls, and filled after one", () => {
		const state = createState("session-1");
		expect(formatWidget(state)).toEqual([]);
		applySnapshot(state, snapshot(1_000, STARTED, { req: 10, emit: 4, tool: 3 }), 1_000);
		const at = new Date(2026, 9, 13, 10, 5).getTime();
		applySnapshot(state, snapshot(at, STARTED, { req: 15, emit: 6, tool: 4 }), at);
		expect(formatWidget(state)).toEqual(["10:05  +5 req  +2 emit  +1 tool"]);
	});

	test("widget keeps only the last three nonzero polls", () => {
		const state = createState("session-1");
		applySnapshot(state, snapshot(1_000, STARTED, { req: 0, emit: 0, tool: 0 }), 1_000);
		for (let step = 1; step <= 4; step++) {
			applySnapshot(state, snapshot(1_000 + step * 1_000, STARTED, { req: step, emit: 0, tool: 0 }), 1_000 + step * 1_000);
		}
		expect(formatWidget(state)).toHaveLength(3);
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
	test("a request that never answers is unreachable with reason timeout", async () => {
		const fetchImpl = (_url: string, init: RequestInit): Promise<Response> =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		const result = await probe({ fetchImpl, env: {}, readFile: () => null, now: () => 5 });
		expect(result).toEqual({ ok: false, reason: "timeout" });
	});

	test("a refused connection is unreachable", async () => {
		const fetchImpl = async (): Promise<Response> => {
			throw new TypeError("connection refused");
		};
		expect(await probe({ fetchImpl, env: {}, readFile: () => null })).toEqual({ ok: false, reason: "unreachable" });
	});

	test("a non-2xx answer gives http <status>", async () => {
		const fetchImpl = async (): Promise<Response> => new Response("", { status: 503 });
		expect(await probe({ fetchImpl, env: {}, readFile: () => null })).toEqual({ ok: false, reason: "http 503" });
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

	test("refresh keeps the last good snapshot when a later poll fails", async () => {
		const state: State = createState("session-1");
		await refresh(state, { fetchImpl: fakeFetch([]), env: {}, readFile: () => null, now: () => 1_000 });
		expect(state.last).not.toBeNull();
		const refused = async (): Promise<Response> => {
			throw new TypeError("connection refused");
		};
		await refresh(state, { fetchImpl: refused, env: {}, readFile: () => null, now: () => 2_000 });
		expect(state.lastProbe).toEqual({ ok: false, reason: "unreachable", at: 2_000 });
		expect(state.last).not.toBeNull();
		expect(formatSummary(state, 2_000).join("\n")).toContain("last good snapshot: 1s ago");
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
