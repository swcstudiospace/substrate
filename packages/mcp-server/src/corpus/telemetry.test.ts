/**
 * Retrieval telemetry: what a row keeps (and never keeps), and a recorder that a slow, failing or absent database can neither
 * slow down nor fail a search through.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { SearchCitation } from "../docs-search.ts";
import { defined } from "../test-support.ts";
import { FakeReflectStore } from "./reflect-testkit.ts";
import { RETRIEVAL_KEY_CHARS, RETRIEVAL_MAX_RETURNED, RETRIEVAL_QUERY_TEXT_CHARS, type ReflectStore, type RetrievalRow } from "./reflect-store.ts";
import { LOG_EVERY, MAX_PENDING_WRITES, RetrievalRecorder, SWEEP_MAX_BATCHES, normalizeQuery, queryHash, queryTextOf, retrievalRowOf, sweepExpiredRetrievals } from "./telemetry.ts";

function citation(title: string, score: number, over: Partial<SearchCitation> = {}): SearchCitation {
	return { title, source_url: `https://example.com/${title}`, heading_path: "", commit: "dataset-pin:agent-substrate:unrecorded", snippet: "the cited text", score, document_id: "", chunk_id: title, ...over };
}

const corpusCitation = (path: string, score: number): SearchCitation => citation(`acme/app:${path}`, score, { dataset: "corpus" });

describe("the query hash and text", () => {
	test("two spellings of one question share a hash: case, outer blanks and runs of whitespace do not matter", () => {
		expect(normalizeQuery("  Where   IS the\tplan? ")).toBe("where is the plan?");
		expect(queryHash("  Where   IS the\tplan? ")).toBe(queryHash("where is the plan?"));
		expect(queryHash("where is the plan?")).toBe(createHash("sha256").update("where is the plan?", "utf8").digest("hex"));
		expect(queryHash("where is the plan")).not.toBe(queryHash("where is the plan?"));
	});

	test("the text is cut to 200 characters and keeps the caller's own case", () => {
		expect(queryTextOf("Where is the plan?")).toBe("Where is the plan?");
		expect(defined(queryTextOf("x".repeat(500)), "the cut text")).toHaveLength(RETRIEVAL_QUERY_TEXT_CHARS);
	});

	test("a cut never ends on half of a surrogate pair", () => {
		const text = queryTextOf(`${"a".repeat(RETRIEVAL_QUERY_TEXT_CHARS - 1)}\u{1F600}tail`);
		expect(defined(text, "the cut text")).toBe("a".repeat(RETRIEVAL_QUERY_TEXT_CHARS - 1));
	});

	test("a question holding a secret keeps no text at all, not even a masked one", () => {
		const secret = `use ghp_${"a".repeat(40)} to push`;
		expect(queryTextOf(secret)).toBeNull();
		expect(queryHash(secret)).toHaveLength(64);
	});

	test("a secret past the 200-character cut still keeps the text out: the whole query is checked, not only the part kept", () => {
		const secret = `${"word ".repeat(80)}ghp_${"a".repeat(40)}`;
		expect(queryTextOf(secret)).toBeNull();
	});

	test("an empty question has no text", () => {
		expect(queryTextOf("   ")).toBeNull();
	});
});

describe("retrievalRowOf", () => {
	test("keeps at most ten document keys with their scores, the best score, the count and the backend, and no citation text", () => {
		const chunks = Array.from({ length: 12 }, (_, index) => corpusCitation(`docs/d${index}.md`, 0.9 - index / 100));
		const row = retrievalRowOf({ surface: "omp", question: "How do plans work?", backend: "lightrag", reply: { chunks }, shadow: null, isPrivate: false });
		expect(row.returned).toHaveLength(RETRIEVAL_MAX_RETURNED);
		expect(row.returned[0]).toEqual({ key: "acme/app:docs/d0.md", score: 0.9 });
		expect(row).toMatchObject({ surface: "omp", backend: "lightrag", topScore: 0.9, returnedCount: 12, degraded: false, rerank: null, queryText: "How do plans work?" });
		expect(JSON.stringify(row)).not.toContain("the cited text");
	});

	test("a citation that is not a corpus document is keyed by its source URL, cut to the key limit", () => {
		const long = citation("plan.md", 0.4, { source_url: `https://example.com/${"p".repeat(500)}` });
		const row = retrievalRowOf({ surface: "omp", question: "q", backend: "lightrag", reply: { chunks: [long] }, shadow: null, isPrivate: false });
		expect(defined(row.returned[0], "the returned key").key).toHaveLength(RETRIEVAL_KEY_CHARS);
	});

	test("an answer with no citation has a null best score, a zero count and keeps its degraded flag", () => {
		const row = retrievalRowOf({ surface: "omp", question: "q", backend: "ragflow", reply: { chunks: [], degraded: true }, shadow: null, isPrivate: false });
		expect(row).toMatchObject({ topScore: null, returnedCount: 0, returned: [], degraded: true });
	});

	test("a shadow note is stored with the order and the number of positions it would move", () => {
		const row = retrievalRowOf({ surface: "omp", question: "q", backend: "lightrag", reply: { chunks: [corpusCitation("a.md", 0.5)] }, shadow: { mode: "shadow", order: ["acme/app:a.md"], moved: 0 }, isPrivate: false });
		expect(row.rerank).toEqual({ mode: "shadow", order: ["acme/app:a.md"], moved: 0 });
	});

	test("a private row keeps no query text and the hash of the question", () => {
		const row = retrievalRowOf({ surface: "omp", question: "How do plans work?", backend: "lightrag", reply: { chunks: [corpusCitation("a.md", 0.5)] }, shadow: null, isPrivate: true });
		expect(row.queryText).toBeNull();
		expect(row.queryHash).toBe(createHash("sha256").update("how do plans work?", "utf8").digest("hex"));
		expect(row.returned).toEqual([{ key: "acme/app:a.md", score: 0.5 }]);
		expect(JSON.stringify(row)).not.toContain("How do plans work");
	});
});

describe("RetrievalRecorder", () => {
	const row = retrievalRowOf({ surface: "omp", question: "q", backend: "lightrag", reply: { chunks: [] }, shadow: null, isPrivate: false });

	function recorder(store: ReflectStore | null, over: { writeBudgetMs?: number; maxPending?: number } = {}) {
		const lines: string[] = [];
		return { lines, recorder: new RetrievalRecorder({ store: () => store, log: (line) => lines.push(line), ...over }) };
	}

	test("a write is stored and counted", async () => {
		const store = new FakeReflectStore();
		const { recorder: rec } = recorder(store);
		rec.record(row);
		await rec.idle();
		expect(store.retrievals).toHaveLength(1);
		expect(rec.counters()).toEqual({ written: 1, failed: 0, timedOut: 0, dropped: 0 });
	});

	test("record returns before a database that never answers has, and the write is given up after its budget", async () => {
		const store = new FakeReflectStore();
		store.hangAppend = true;
		const { recorder: rec, lines } = recorder(store, { writeBudgetMs: 5 });
		const started = rec.counters();
		rec.record(row);
		// Nothing has settled yet: the caller was not made to wait for the write.
		expect(rec.counters()).toEqual(started);
		await rec.idle();
		expect(rec.counters()).toEqual({ written: 0, failed: 0, timedOut: 1, dropped: 0 });
		expect(lines).toHaveLength(1);
	});

	test("a store that throws is a counted failure and never an exception out of record", async () => {
		const store = new FakeReflectStore();
		store.failAppend = new Error("connection lost");
		const { recorder: rec, lines } = recorder(store);
		expect(() => rec.record(row)).not.toThrow();
		await rec.idle();
		expect(rec.counters()).toEqual({ written: 0, failed: 1, timedOut: 0, dropped: 0 });
		expect(lines[0]).toContain("connection lost");
	});

	test("a store that throws before it returns a promise is a failed write too", async () => {
		const throwing: ReflectStore = {
			appendRetrieval: () => {
				throw new Error("synchronous failure");
			},
			sweepRetrievals: async () => 0,
			upsertFeedback: async () => undefined,
			feedbackCounts: async () => new Map(),
			gaps: async () => [],
		};
		const { recorder: rec } = recorder(throwing);
		rec.record(row);
		await rec.idle();
		expect(rec.counters().failed).toBe(1);
	});

	test("failures are logged on the first and then on every hundredth, not once per search", async () => {
		const store = new FakeReflectStore();
		store.failAppend = new Error("down");
		const { recorder: rec, lines } = recorder(store);
		for (let i = 0; i < LOG_EVERY + 1; i += 1) {
			rec.record(row);
			await rec.idle();
		}
		expect(rec.counters().failed).toBe(LOG_EVERY + 1);
		expect(lines).toHaveLength(2);
	});

	test("writes past the in-flight bound are dropped and counted, not queued", async () => {
		const store = new FakeReflectStore();
		store.hangAppend = true;
		const { recorder: rec } = recorder(store, { writeBudgetMs: 5, maxPending: 2 });
		for (let i = 0; i < 4; i += 1) rec.record(row);
		expect(rec.counters().dropped).toBe(2);
		await rec.idle();
		expect(rec.counters().timedOut).toBe(2);
		expect(MAX_PENDING_WRITES).toBeGreaterThan(2);
	});

	test("a write that gave up waiting keeps its slot until the database call itself settles", async () => {
		class GatedStore extends FakeReflectStore {
			readonly gates: Array<() => void> = [];
			started = 0;
			override async appendRetrieval(next: RetrievalRow): Promise<void> {
				this.started += 1;
				const gate = Promise.withResolvers<void>();
				this.gates.push(gate.resolve);
				await gate.promise;
				return super.appendRetrieval(next);
			}
		}
		const store = new GatedStore();
		const { recorder: rec } = recorder(store, { writeBudgetMs: 5, maxPending: 2 });
		rec.record(row);
		rec.record(row);
		await rec.idle();
		expect(rec.counters().timedOut).toBe(2);
		// Both calls are still running: no third one may start behind them.
		for (let i = 0; i < 10; i += 1) rec.record(row);
		expect(store.started).toBe(2);
		expect(rec.counters().dropped).toBe(10);
		for (const release of store.gates.splice(0)) release();
		for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
		rec.record(row);
		expect(store.started).toBe(3);
		expect(rec.counters().dropped).toBe(10);
	});

	test("with no index the row is dropped and counted", () => {
		const { recorder: rec } = recorder(null);
		rec.record(row);
		expect(rec.counters().dropped).toBe(1);
	});
});

describe("sweepExpiredRetrievals", () => {
	const DAY = 86_400_000;
	const bare = (hash: string): RetrievalRow => ({ surface: "omp", queryHash: hash, queryText: null, backend: "lightrag", returned: [], topScore: null, returnedCount: 0, degraded: false, rerank: null });

	test("3,600 expired rows (an hour of one search a second) are all deleted in one sweep, in batches of the store's bound, yielding between them", async () => {
		const clock = { now: 1_000_000_000_000 };
		const store = new FakeReflectStore(() => clock.now);
		for (let index = 0; index < 3600; index += 1) await store.appendRetrieval(bare(`old-${index}`));
		clock.now += 31 * DAY;
		await store.appendRetrieval(bare("fresh"));
		let yields = 0;
		const batchSizes: number[] = [];
		const original = store.sweepRetrievals.bind(store);
		store.sweepRetrievals = async (days, batch) => {
			const removed = await original(days, batch);
			batchSizes.push(removed);
			return removed;
		};
		const deleted = await sweepExpiredRetrievals(store, {
			retentionDays: 30,
			batch: 1000,
			yieldTurn: async () => {
				yields += 1;
			},
		});
		expect(deleted).toBe(3600);
		expect(batchSizes).toEqual([1000, 1000, 1000, 600]);
		// A turn between two batches, none after the short one.
		expect(yields).toBe(3);
		expect(store.retrievals.map((entry) => entry.row.queryHash)).toEqual(["fresh"]);
	});

	test("a batch that comes back exactly full is followed by one more, which finds nothing", async () => {
		const clock = { now: 1_000_000_000_000 };
		const store = new FakeReflectStore(() => clock.now);
		for (let index = 0; index < 20; index += 1) await store.appendRetrieval(bare(`old-${index}`));
		clock.now += 31 * DAY;
		expect(await sweepExpiredRetrievals(store, { retentionDays: 30, batch: 10, yieldTurn: async () => undefined })).toBe(20);
		expect(store.retrievals).toEqual([]);
	});

	test("a store that never runs dry stops at the time budget, and the batch that was running is the last", async () => {
		let calls = 0;
		let now = 0;
		const endless = new FakeReflectStore();
		endless.sweepRetrievals = async (_days, batch) => {
			calls += 1;
			now += 700;
			return batch;
		};
		const deleted = await sweepExpiredRetrievals(endless, { retentionDays: 30, batch: 1000, now: () => now, yieldTurn: async () => undefined });
		// 700 ms per batch against a 2,000 ms budget: the third batch ends at 2,100 ms.
		expect(calls).toBe(3);
		expect(deleted).toBe(3000);
	});

	test("a store that never runs dry and is fast stops at the batch count", async () => {
		let calls = 0;
		const endless = new FakeReflectStore();
		endless.sweepRetrievals = async (_days, batch) => {
			calls += 1;
			return batch;
		};
		const deleted = await sweepExpiredRetrievals(endless, { retentionDays: 30, batch: 1000, now: () => 0, yieldTurn: async () => undefined });
		expect(calls).toBe(SWEEP_MAX_BATCHES);
		expect(deleted).toBe(SWEEP_MAX_BATCHES * 1000);
	});

	test("a store that fails on a later batch propagates its error to the caller, which reports a failed sweep", async () => {
		const failing = new FakeReflectStore();
		let calls = 0;
		failing.sweepRetrievals = async (_days, batch) => {
			calls += 1;
			if (calls === 2) throw new Error("connection lost");
			return batch;
		};
		await expect(sweepExpiredRetrievals(failing, { retentionDays: 30, batch: 10, now: () => 0, yieldTurn: async () => undefined })).rejects.toThrow("connection lost");
	});
});
