/**
 * The doors of the docs learning loop: a verdict on a document, the digest ingest and the gap report. Every store is a fake;
 * what these show is the gates, the closed reasons, one bad item never failing the rest, and the Hindsight leg being best effort.
 */
import { describe, expect, test } from "bun:test";
import { CORPUS_PROTOCOL, DIGEST_PATH, MAX_DIGEST_CHARS, MAX_GAPS_LIMIT, MAX_REFLECT_DIGESTS, DEFAULT_GAPS_LIMIT, corpusDocumentName, documentKey, type CorpusReflectResponse } from "@substrate/corpus";
import type { AnchorVerifyPorts } from "../anchor-verify-deps.ts";
import type { CorpusSettings } from "../config.ts";
import type { EventInput, Surface } from "../types.ts";
import { defined } from "../test-support.ts";
import { CorpusRootKeeper, corpusRoot, type RootClock } from "./root.ts";
import { FakeReflectStore } from "./reflect-testkit.ts";
import {
	type ReflectReply,
	type ReflectServiceDeps,
	type RetainOutcome,
	corpusGapsReply,
	corpusReflectReply,
	docsFeedbackReply,
	gapsLimitOf,
	parseFeedbackRequest,
	parseReflectRequest,
	REFLECT_RETAIN_BUDGET_MS,
	REFLECT_RETAIN_CONCURRENCY,
	digestSessionOf,
} from "./reflect-service.ts";
import { FakePlane, FakeStore, makeRow, sha256Hex } from "./testkit.ts";

const REPO = "swcstudiospace/agent-substrate";
const OTHER = "swcstudiospace/other";
const OPEN: CorpusSettings = { enabled: true, concurrency: 4, batchDocs: 20, batchBytes: 1_000_000, freshMaxAgeS: 172_800 };

/** The anchor check is never reached by these doors; a port that throws proves it. */
const UNUSED_PORTS: AnchorVerifyPorts = {
	ledger: null,
	rowToEvent: () => {
		throw new Error("not used");
	},
	rpc: () => {
		throw new Error("not used");
	},
	solana: { pubkey: null, problem: null },
	operatorSurfaces: new Set<string>(),
	nowMs: () => 0,
};

interface Retained {
	repo: string;
	text: string;
	surface: Surface;
}

function world(over: Partial<ReflectServiceDeps> = {}, retain: (input: Retained) => RetainOutcome = () => ({ ok: true })) {
	const store = new FakeStore();
	const plane = new FakePlane();
	const reflect = new FakeReflectStore();
	const retained: Retained[] = [];
	const deps: ReflectServiceDeps = {
		settings: OPEN,
		vmGuest: false,
		store,
		plane,
		emit: async () => undefined,
		roots: new CorpusRootKeeper({ store: () => store, emit: async () => ({ stored: true }) }),
		anchor: { ports: () => UNUSED_PORTS },
		reflect,
		gapScore: 0.2,
		retainDigest: async (input) => {
			retained.push({ repo: input.repo, text: input.text, surface: input.surface });
			return retain(input);
		},
		...over,
	};
	return { store, plane, reflect, retained, deps };
}

const digest = (repo: string, text: string) => ({ repo, text, sha256: sha256Hex(text) });
const request = (...digests: Array<{ repo: string; text: string; sha256: string }>) => ({ protocol: CORPUS_PROTOCOL, digests });

function ok<T>(reply: ReflectReply<T>): T {
	if (!reply.ok) throw new Error(`expected an answer, got ${reply.status} ${reply.body.reason}`);
	return reply.body;
}

describe("parseFeedbackRequest", () => {
	test("reads the document key at its first colon, the verdict and an optional session, and ignores the note", () => {
		expect(parseFeedbackRequest({ document: `${REPO}:docs/a.md`, verdict: "helpful", session_id: " s-1 ", note: "great" })).toEqual({ ok: true, value: { repo: REPO, path: "docs/a.md", verdict: "helpful", sessionId: "s-1" } });
		expect(parseFeedbackRequest({ document: `${REPO}:docs/a.md`, verdict: "wrong" })).toMatchObject({ ok: true, value: { sessionId: null } });
	});

	test("each closed refusal names what is wrong", () => {
		expect(parseFeedbackRequest("text")).toMatchObject({ ok: false, reason: "bad-request" });
		expect(parseFeedbackRequest({ verdict: "helpful" })).toMatchObject({ ok: false, reason: "bad-document" });
		for (const document of ["no-colon", ":docs/a.md", `${REPO}:`, `${REPO}:../x.md`, "not a repo:docs/a.md"]) {
			expect(parseFeedbackRequest({ document, verdict: "helpful" })).toMatchObject({ ok: false, reason: "bad-document" });
		}
		expect(parseFeedbackRequest({ document: `${REPO}:a.md`, verdict: "great" })).toMatchObject({ ok: false, reason: "bad-verdict" });
		expect(parseFeedbackRequest({ document: `${REPO}:a.md`, verdict: "helpful", session_id: 7 })).toMatchObject({ ok: false, reason: "bad-request" });
	});
});

describe("docsFeedbackReply", () => {
	const body = { document: `${REPO}:docs/a.md`, verdict: "stale" };

	test("stores a verdict for an active manifest document and echoes what was stored", async () => {
		const { store, reflect, deps } = world();
		store.seed(makeRow({ repo: REPO, path: "docs/a.md" }));
		const reply = ok(await docsFeedbackReply(deps, { ...body, session_id: "s-1" }, "omp"));
		expect(reply).toEqual({ protocol: CORPUS_PROTOCOL, document: `${REPO}:docs/a.md`, verdict: "stale", stored: true });
		expect([...reflect.feedback.values()]).toMatchObject([{ documentKey: `${REPO}:docs/a.md`, verdict: "stale", surface: "omp", sessionId: "omp/s-1" }]);
	});

	test("a document that is not an active manifest row is unknown-document, 404, and nothing is stored", async () => {
		const { store, reflect, deps } = world();
		store.seed(makeRow({ repo: REPO, path: "docs/gone.md", state: "tombstoned" }));
		for (const path of ["docs/missing.md", "docs/gone.md"]) {
			const reply = await docsFeedbackReply(deps, { document: `${REPO}:${path}`, verdict: "helpful" }, "omp");
			expect(reply).toMatchObject({ ok: false, status: 404, body: { reason: "unknown-document" } });
		}
		expect(reflect.feedback.size).toBe(0);
	});

	test("one verdict per session and document: a repeat replaces it, another session adds one", async () => {
		const { store, reflect, deps } = world();
		store.seed(makeRow({ repo: REPO, path: "docs/a.md" }));
		await docsFeedbackReply(deps, { ...body, session_id: "s-1" }, "omp");
		await docsFeedbackReply(deps, { ...body, verdict: "helpful", session_id: "s-1" }, "omp");
		expect(reflect.feedback.size).toBe(1);
		expect([...reflect.feedback.values()][0]?.verdict).toBe("helpful");
		await docsFeedbackReply(deps, { ...body, session_id: "s-2" }, "omp");
		expect(reflect.feedback.size).toBe(2);
	});

	test("the same session id from two surfaces is two verdicts: one surface never overwrites another's", async () => {
		const { store, reflect, deps } = world();
		store.seed(makeRow({ repo: REPO, path: "docs/a.md" }));
		await docsFeedbackReply(deps, { ...body, session_id: "shared" }, "omp");
		await docsFeedbackReply(deps, { ...body, verdict: "wrong", session_id: "shared" }, "claude-code");
		expect(reflect.feedback.size).toBe(2);
	});

	test("without a session id there is one verdict per surface and document", async () => {
		const { store, reflect, deps } = world();
		store.seed(makeRow({ repo: REPO, path: "docs/a.md" }));
		await docsFeedbackReply(deps, body, "omp");
		await docsFeedbackReply(deps, { ...body, verdict: "duplicate" }, "omp");
		expect([...reflect.feedback.values()]).toMatchObject([{ verdict: "duplicate", sessionId: "omp/surface" }]);
	});

	test("the gates answer first: anonymous 401, flag off 503, VM guest 403, no index 503", async () => {
		const closed = world({ settings: { ...OPEN, enabled: false } });
		expect(await docsFeedbackReply(closed.deps, body, "omp")).toMatchObject({ status: 503, body: { reason: "corpus.disabled" } });
		expect(await docsFeedbackReply(world().deps, body, null)).toMatchObject({ status: 401, body: { reason: "unauthenticated" } });
		expect(await docsFeedbackReply(world({ vmGuest: true }).deps, body, "omp")).toMatchObject({ status: 403, body: { reason: "vm-guest" } });
		expect(await docsFeedbackReply(world({ reflect: null }).deps, body, "omp")).toMatchObject({ status: 503, body: { reason: "corpus.index-unavailable" } });
		expect(await docsFeedbackReply(world({ store: null }).deps, body, "omp")).toMatchObject({ status: 503, body: { reason: "corpus.index-unavailable" } });
	});

	test("a store that fails is index-unavailable, never an exception", async () => {
		const { store, deps } = world();
		store.rowFor = async () => {
			throw new Error("connection lost");
		};
		expect(await docsFeedbackReply(deps, body, "omp")).toMatchObject({ status: 503, body: { reason: "corpus.index-unavailable" } });
	});

	test("a request the parser refuses is a 400 with its closed reason", async () => {
		expect(await docsFeedbackReply(world().deps, { document: "x", verdict: "helpful" }, "omp")).toMatchObject({ status: 400, body: { reason: "bad-document" } });
	});
});

describe("parseReflectRequest", () => {
	test("refuses a request that is not a request: protocol, shape, empty and over the bound", () => {
		expect(parseReflectRequest(null)).toMatchObject({ ok: false, reason: "bad-request" });
		expect(parseReflectRequest({ protocol: 2, digests: [] })).toMatchObject({ ok: false, reason: "bad-protocol" });
		expect(parseReflectRequest({ protocol: CORPUS_PROTOCOL, digests: "x" })).toMatchObject({ ok: false, reason: "bad-request" });
		expect(parseReflectRequest(request())).toMatchObject({ ok: false, reason: "empty-request" });
		const tooMany = Array.from({ length: MAX_REFLECT_DIGESTS + 1 }, (_, index) => digest(`acme/r${index}`, "x"));
		expect(parseReflectRequest(request(...tooMany))).toMatchObject({ ok: false, reason: "too-many-digests" });
	});

	test("judges each digest by itself and keeps the order: one bad digest never refuses the request", () => {
		const text = "# Digest\nA digest.";
		const parsed = parseReflectRequest({
			protocol: CORPUS_PROTOCOL,
			digests: [
				"not an object",
				{ repo: "no spaces allowed", text, sha256: sha256Hex(text) },
				{ repo: REPO, text: 12, sha256: sha256Hex(text) },
				{ repo: REPO, text: "x".repeat(MAX_DIGEST_CHARS + 1), sha256: sha256Hex(text) },
				{ repo: REPO, text, sha256: "not-a-hash" },
				digest(REPO, text),
				digest(REPO, text),
			],
		});
		expect(parsed.ok).toBe(true);
		const items = parsed.ok ? parsed.items : [];
		expect(items.map((item) => (item.ready ? "ready" : item.reason))).toEqual(["bad-digest", "bad-repo", "bad-digest", "too-large", "bad-sha256", "ready", "duplicate-entry"]);
	});
});

describe("corpusReflectReply", () => {
	const text = "# agent-substrate\nMilestone v1.7, phase 66.\n- open: ship the docs reflect";

	test("stores a digest as the corpus document (repo, DIGEST_PATH), kind digest, through the ingest path, and retains it", async () => {
		const { store, plane, retained, deps } = world();
		const reply = ok(await corpusReflectReply(deps, request(digest(REPO, text)), "omp"));
		expect(reply.results).toEqual([{ repo: REPO, status: "stored" }]);
		expect(store.row(REPO, DIGEST_PATH)).toMatchObject({ kind: "digest", tier: 1, source: "fs", state: "active", sha256: sha256Hex(text) });
		expect(plane.batches).toEqual([[corpusDocumentName(REPO, DIGEST_PATH, sha256Hex(text))]]);
		expect(retained).toEqual([{ repo: REPO, text, surface: "omp" }]);
		expect(reply.manifestVersion).toBeGreaterThan(0);
	});

	test("a repeat of the same digest is unchanged: nothing is sent to the plane, and it is retained again under the same memory session", async () => {
		const { plane, retained, deps } = world();
		await corpusReflectReply(deps, request(digest(REPO, text)), "omp");
		const again = ok(await corpusReflectReply(deps, request(digest(REPO, text)), "omp"));
		expect(again.results).toEqual([{ repo: REPO, status: "unchanged" }]);
		expect(plane.batches).toHaveLength(1);
		expect(retained).toHaveLength(2);
		expect(retained[1]?.text).toBe(text);
	});

	test("a Hindsight leg that failed is owed: the next run of the unchanged digest retains it again and reports the leg only while it is still owed", async () => {
		let answer: RetainOutcome = { ok: false, reason: "memory-write-failed" };
		const { deps, retained } = world({}, () => answer);
		const first = ok(await corpusReflectReply(deps, request(digest(REPO, text)), "omp"));
		expect(first.results).toEqual([{ repo: REPO, status: "stored", reason: "hindsight:memory-write-failed" }]);
		answer = { ok: true };
		const second = ok(await corpusReflectReply(deps, request(digest(REPO, text)), "omp"));
		expect(second.results).toEqual([{ repo: REPO, status: "unchanged" }]);
		expect(retained).toHaveLength(2);
		answer = { ok: false, reason: "pending" };
		const third = ok(await corpusReflectReply(deps, request(digest(REPO, text)), "omp"));
		expect(third.results).toEqual([{ repo: REPO, status: "unchanged", reason: "hindsight:pending" }]);
	});

	test("digests retain under a session of their content: two repeats share one, a changed digest has its own", () => {
		expect(digestSessionOf(sha256Hex(text))).toBe(digestSessionOf(sha256Hex(text)));
		expect(digestSessionOf(sha256Hex(text))).not.toBe(digestSessionOf(sha256Hex(`${text}\n- open`)));
	});

	test("a changed digest replaces the plane document and is retained again", async () => {
		const { plane, retained, store, deps } = world();
		await corpusReflectReply(deps, request(digest(REPO, text)), "omp");
		const next = `${text}\n- open: write the runbook`;
		const reply = ok(await corpusReflectReply(deps, request(digest(REPO, next)), "omp"));
		expect(reply.results).toEqual([{ repo: REPO, status: "stored" }]);
		expect(store.row(REPO, DIGEST_PATH)?.sha256).toBe(sha256Hex(next));
		expect(plane.liveIds().size).toBe(1);
		expect(retained.map((entry) => entry.text)).toEqual([text, next]);
	});

	test("a Hindsight refusal is the digest's reason while its plane document stays stored", async () => {
		const { store, deps } = world({}, () => ({ ok: false, reason: "rbac.no-grant" }));
		const reply = ok(await corpusReflectReply(deps, request(digest(REPO, text)), "omp"));
		expect(reply.results).toEqual([{ repo: REPO, status: "stored", reason: "hindsight:rbac.no-grant" }]);
		expect(store.row(REPO, DIGEST_PATH)?.state).toBe("active");
	});

	test("a Hindsight leg that is pending or not configured is the digest's reason too, never a bare stored", async () => {
		for (const reason of ["pending", "not-configured"]) {
			const { deps } = world({}, () => ({ ok: false, reason }));
			const reply = ok(await corpusReflectReply(deps, request(digest(REPO, text)), "omp"));
			expect(reply.results).toEqual([{ repo: REPO, status: "stored", reason: `hindsight:${reason}` }]);
		}
	});

	test("stored digests share one retain budget and do not each wait 5s", async () => {
		let clock = 1_000;
		const waits: number[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const { deps } = world({
			now: () => clock,
			retainDigest: async (input) => {
				waits.push(input.waitMs ?? -1);
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await Promise.resolve();
				inFlight -= 1;
				if ((input.waitMs ?? 0) > 0) clock += REFLECT_RETAIN_BUDGET_MS;
				return { ok: false, reason: "pending" };
			},
		});
		const digests = Array.from({ length: REFLECT_RETAIN_CONCURRENCY * 2 }, (_, index) => digest(`local/repo-${index}`, `${text} ${index}`));
		const reply = ok(await corpusReflectReply(deps, request(...digests), "omp"));
		expect(maxInFlight).toBe(REFLECT_RETAIN_CONCURRENCY);
		expect(waits.slice(0, REFLECT_RETAIN_CONCURRENCY).every((ms) => ms === REFLECT_RETAIN_BUDGET_MS)).toBe(true);
		expect(waits.slice(REFLECT_RETAIN_CONCURRENCY).every((ms) => ms === 0)).toBe(true);
		expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(digests.length * 5_000);
		expect(reply.results.every((result) => result.status === "stored" && result.reason === "hindsight:pending")).toBe(true);
	});

	test("one bad digest never fails the others: each is reported in request order with its own reason", async () => {
		const { store, deps } = world();
		const leaky = `# Notes\nuse ghp_${"a".repeat(40)} to push`;
		const reply = ok(
			await corpusReflectReply(
				deps,
				request(digest("no spaces allowed", text), digest(REPO, text), { repo: OTHER, text, sha256: sha256Hex("something else") }, digest("swcstudiospace/third", leaky), digest(REPO, "again")),
				"omp",
			),
		);
		expect(reply.results).toEqual([
			{ repo: "no spaces allowed", status: "refused", reason: "bad-repo" },
			{ repo: REPO, status: "stored" },
			{ repo: OTHER, status: "refused", reason: "sha-mismatch" },
			{ repo: "swcstudiospace/third", status: "refused", reason: "secret-findings" },
			{ repo: REPO, status: "refused", reason: "duplicate-entry" },
		]);
		expect(store.row(OTHER, DIGEST_PATH)).toBeUndefined();
		expect(store.row("swcstudiospace/third", DIGEST_PATH)).toBeUndefined();
	});

	test("a request whose every digest is bad answers each one and touches neither plane nor manifest", async () => {
		const { store, plane, retained, deps } = world();
		const reply = ok(await corpusReflectReply(deps, request(digest("bad repo", text)), "omp"));
		expect(reply.results).toEqual([{ repo: "bad repo", status: "refused", reason: "bad-repo" }]);
		expect(plane.batches).toEqual([]);
		expect(store.rows.size).toBe(0);
		expect(retained).toEqual([]);
	});

	test("a plane that is down fails the digest with the ingest's reason and retains nothing", async () => {
		const { plane, retained, deps } = world();
		plane.unavailable = true;
		const reply = ok(await corpusReflectReply(deps, request(digest(REPO, text)), "omp"));
		expect(reply.results).toEqual([{ repo: REPO, status: "failed", reason: "plane-unavailable" }]);
		expect(retained).toEqual([]);
	});

	test("the gates answer first: anonymous 401, flag off 503, VM guest 403, no plane 503, no index 503", async () => {
		const body = request(digest(REPO, text));
		expect(await corpusReflectReply(world().deps, body, null)).toMatchObject({ status: 401 });
		expect(await corpusReflectReply(world({ settings: { ...OPEN, enabled: false } }).deps, body, "omp")).toMatchObject({ status: 503, body: { reason: "corpus.disabled" } });
		expect(await corpusReflectReply(world({ vmGuest: true }).deps, body, "omp")).toMatchObject({ status: 403 });
		expect(await corpusReflectReply(world({ plane: null }).deps, body, "omp")).toMatchObject({ status: 503, body: { reason: "corpus.backend-unavailable" } });
		expect(await corpusReflectReply(world({ store: null }).deps, body, "omp")).toMatchObject({ status: 503, body: { reason: "corpus.index-unavailable" } });
	});

	test("a request the parser refuses is a 400 and nothing is sent", async () => {
		const { plane, deps } = world();
		expect(await corpusReflectReply(deps, request(), "omp")).toMatchObject({ status: 400, body: { reason: "empty-request" } });
		expect(plane.batches).toEqual([]);
	});

	test("the response type carries only the closed members", async () => {
		const { deps } = world();
		const reply: CorpusReflectResponse = ok(await corpusReflectReply(deps, request(digest(REPO, text)), "omp"));
		expect(Object.keys(reply).sort()).toEqual(["manifestVersion", "protocol", "results"]);
		expect(documentKey(REPO, DIGEST_PATH)).toBe(`${REPO}:.substrate/digest.md`);
	});
});

describe("corpusReflectReply and the root cache", () => {
	const text = "# agent-substrate\nMilestone v1.7, phase 66.";

	class ManualClock implements RootClock {
		readonly timers: Array<() => void> = [];
		now(): number {
			return 5_000_000;
		}
		setTimer(run: () => void): void {
			this.timers.push(run);
		}
	}

	async function flush(): Promise<void> {
		for (let turn = 0; turn < 40; turn++) await Promise.resolve();
	}

	function keepered() {
		const base = world();
		const clock = new ManualClock();
		const rootEvents: EventInput[] = [];
		const roots = new CorpusRootKeeper({
			store: () => base.store,
			emit: async (event) => {
				rootEvents.push(event);
				return { stored: true };
			},
			clock,
		});
		return { ...base, clock, rootEvents, roots, deps: { ...base.deps, roots } };
	}

	test("a stored digest drops the cached root and owes one root event that covers the digest", async () => {
		const { roots, clock, rootEvents, deps } = keepered();
		await roots.read();
		expect(roots.peek()).not.toBeNull();
		ok(await corpusReflectReply(deps, request(digest(REPO, text)), "omp"));
		expect(roots.peek()).toBeNull();
		expect(clock.timers).toHaveLength(1);
		defined(clock.timers[0], "the scheduled root timer")();
		await flush();
		expect(rootEvents).toHaveLength(1);
		expect(defined(rootEvents[0], "the root event").payload).toMatchObject({ root: corpusRoot([{ repo: REPO, path: DIGEST_PATH, sha256: sha256Hex(text) }]).root, count: 1 });
	});

	test("the cache is unavailable while the digest writes, and a digest write that failed owes the event too", async () => {
		const { roots, clock, store, deps } = keepered();
		const duringWrite: boolean[] = [];
		const original = store.recordIngested.bind(store);
		store.recordIngested = async (row) => {
			duringWrite.push(roots.peek() === null);
			return original(row);
		};
		await roots.read();
		ok(await corpusReflectReply(deps, request(digest(REPO, text)), "omp"));
		expect(duringWrite).toEqual([true]);

		const failing = keepered();
		failing.store.recordIngested = async () => {
			throw new Error("connection lost");
		};
		const reply = ok(await corpusReflectReply(failing.deps, request(digest(REPO, text)), "omp"));
		expect(reply.results).toEqual([{ repo: REPO, status: "failed", reason: "manifest-unavailable" }]);
		expect(failing.clock.timers).toHaveLength(1);
		expect(clock.timers).toHaveLength(1);
	});

	test("a repeat that changed nothing schedules no event", async () => {
		const { roots, clock, deps } = keepered();
		ok(await corpusReflectReply(deps, request(digest(REPO, text)), "omp"));
		clock.timers.length = 0;
		await roots.read();
		ok(await corpusReflectReply(deps, request(digest(REPO, text)), "omp"));
		expect(clock.timers).toEqual([]);
	});
});

describe("gaps", () => {
	const row = (queryHash: string, topScore: number | null, over: { degraded?: boolean; text?: string | null } = {}) => ({
		surface: "omp",
		queryHash,
		queryText: over.text === undefined ? `text of ${queryHash}` : over.text,
		backend: "lightrag",
		returned: [],
		topScore,
		returnedCount: topScore === null ? 0 : 1,
		degraded: over.degraded ?? false,
		rerank: null,
	});

	test("gapsLimitOf clamps to the documented range and falls back to the default for anything that is not a whole number", () => {
		expect(gapsLimitOf(null)).toBe(DEFAULT_GAPS_LIMIT);
		expect(gapsLimitOf("")).toBe(DEFAULT_GAPS_LIMIT);
		expect(gapsLimitOf("abc")).toBe(DEFAULT_GAPS_LIMIT);
		expect(gapsLimitOf("2.5")).toBe(DEFAULT_GAPS_LIMIT);
		expect(gapsLimitOf("-3")).toBe(DEFAULT_GAPS_LIMIT);
		expect(gapsLimitOf("0")).toBe(1);
		expect(gapsLimitOf("7")).toBe(7);
		expect(gapsLimitOf("100000")).toBe(MAX_GAPS_LIMIT);
	});

	test("lists the queries whose best score was none or below the gap score, most searched first, and leaves out answered ones and degraded searches", async () => {
		const { reflect, deps } = world();
		for (const item of [row("hash-none", null), row("hash-none", null), row("hash-none", null), row("hash-low", 0.1), row("hash-low", 0.15), row("hash-good", 0.9), row("hash-mixed", 0.1), row("hash-mixed", 0.5), row("hash-down", null, { degraded: true })]) {
			await reflect.appendRetrieval(item);
		}
		const reply = ok(await corpusGapsReply(deps, null, "omp"));
		expect(reply.gaps.map((gap) => ({ hash: gap.queryHash, searches: gap.searches, best: gap.best }))).toEqual([
			{ hash: "hash-none", searches: 3, best: null },
			{ hash: "hash-low", searches: 2, best: 0.15 },
		]);
		expect(reply.truncated).toBe(false);
		expect(defined(reply.gaps[0], "the first gap").text).toBe("text of hash-none");
	});

	test("a redacted-away query text is null, and the limit truncates", async () => {
		const { reflect, deps } = world();
		await reflect.appendRetrieval(row("a", null, { text: null }));
		await reflect.appendRetrieval(row("b", null));
		const reply = ok(await corpusGapsReply(deps, "1", "omp"));
		expect(reply.gaps).toHaveLength(1);
		expect(reply.truncated).toBe(true);
		const all = ok(await corpusGapsReply(deps, "5", "omp"));
		expect(all.gaps.find((gap) => gap.queryHash === "a")?.text).toBeNull();
	});

	test("the reply carries the shadow report over the window: what the re-rank would have moved, and the searches that would have moved most", async () => {
		const { reflect, deps } = world();
		const shadowed = (queryHash: string, moved: number, over: { degraded?: boolean } = {}) => ({
			...row(queryHash, 0.9, over),
			rerank: { mode: "shadow" as const, order: [`repo:docs/${queryHash}.md`, "repo:docs/other.md"], moved },
		});
		await reflect.appendRetrieval(shadowed("none-moved", 0));
		await reflect.appendRetrieval(shadowed("small", 1));
		await reflect.appendRetrieval(shadowed("large", 4));
		await reflect.appendRetrieval(shadowed("down", 9, { degraded: true }));
		await reflect.appendRetrieval(row("unshadowed", 0.9));
		const shadow = ok(await corpusGapsReply(deps, null, "omp")).shadow;
		expect(shadow).toEqual({
			days: 30,
			searches: 3,
			movedSearches: 2,
			moved: 5,
			largest: [
				{ queryHash: "large", text: "text of large", at: expect.any(String), moved: 4, order: ["repo:docs/large.md", "repo:docs/other.md"] },
				{ queryHash: "small", text: "text of small", at: expect.any(String), moved: 1, order: ["repo:docs/small.md", "repo:docs/other.md"] },
			],
		});
	});

	test("with no shadow note the report is all zeros and lists nothing", async () => {
		const { reflect, deps } = world();
		await reflect.appendRetrieval(row("plain", 0.9));
		expect(ok(await corpusGapsReply(deps, null, "omp")).shadow).toEqual({ days: 30, searches: 0, movedSearches: 0, moved: 0, largest: [] });
	});

	test("a lower gap score shrinks the report", async () => {
		const { reflect, deps } = world({ gapScore: 0.05 });
		await reflect.appendRetrieval(row("low", 0.1));
		expect(ok(await corpusGapsReply(deps, null, "omp")).gaps).toEqual([]);
	});

	test("at a gap score of zero a query that returned no citation is still a gap, and a scored one is not", async () => {
		const { reflect, deps } = world({ gapScore: 0 });
		await reflect.appendRetrieval(row("none", null));
		await reflect.appendRetrieval(row("scored-low", 0.01));
		await reflect.appendRetrieval(row("scored-zero", 0));
		const gaps = ok(await corpusGapsReply(deps, null, "omp")).gaps;
		expect(gaps.map((gap) => gap.queryHash)).toEqual(["none"]);
	});

	test("the gates answer first, and a store that fails is index-unavailable", async () => {
		expect(await corpusGapsReply(world().deps, null, null)).toMatchObject({ status: 401 });
		expect(await corpusGapsReply(world({ settings: { ...OPEN, enabled: false } }).deps, null, "omp")).toMatchObject({ status: 503, body: { reason: "corpus.disabled" } });
		expect(await corpusGapsReply(world({ reflect: null }).deps, null, "omp")).toMatchObject({ status: 503, body: { reason: "corpus.index-unavailable" } });
		const { reflect, deps } = world();
		reflect.gaps = async () => {
			throw new Error("connection lost");
		};
		expect(await corpusGapsReply(deps, null, "omp")).toMatchObject({ status: 503, body: { reason: "corpus.index-unavailable" } });
	});
});
