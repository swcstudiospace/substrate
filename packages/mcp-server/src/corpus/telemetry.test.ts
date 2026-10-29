/**
 * Retrieval telemetry: what a row keeps (and never keeps), and a recorder that a slow, failing or absent database can neither
 * slow down nor fail a search through.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { SearchCitation } from "../docs-search.ts";
import { defined } from "../test-support.ts";
import { FakeReflectStore } from "./reflect-testkit.ts";
import { RETRIEVAL_KEY_CHARS, RETRIEVAL_MAX_RETURNED, RETRIEVAL_QUERY_TEXT_CHARS, type ReflectStore } from "./reflect-store.ts";
import { LOG_EVERY, MAX_PENDING_WRITES, RetrievalRecorder, normalizeQuery, queryHash, queryTextOf, retrievalRowOf } from "./telemetry.ts";

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
		const row = retrievalRowOf({ surface: "omp", question: "How do plans work?", backend: "lightrag", reply: { chunks }, shadow: null });
		expect(row.returned).toHaveLength(RETRIEVAL_MAX_RETURNED);
		expect(row.returned[0]).toEqual({ key: "acme/app:docs/d0.md", score: 0.9 });
		expect(row).toMatchObject({ surface: "omp", backend: "lightrag", topScore: 0.9, returnedCount: 12, degraded: false, rerank: null, queryText: "How do plans work?" });
		expect(JSON.stringify(row)).not.toContain("the cited text");
	});

	test("a citation that is not a corpus document is keyed by its source URL, cut to the key limit", () => {
		const long = citation("plan.md", 0.4, { source_url: `https://example.com/${"p".repeat(500)}` });
		const row = retrievalRowOf({ surface: "omp", question: "q", backend: "lightrag", reply: { chunks: [long] }, shadow: null });
		expect(defined(row.returned[0], "the returned key").key).toHaveLength(RETRIEVAL_KEY_CHARS);
	});

	test("an answer with no citation has a null best score, a zero count and keeps its degraded flag", () => {
		const row = retrievalRowOf({ surface: "omp", question: "q", backend: "ragflow", reply: { chunks: [], degraded: true }, shadow: null });
		expect(row).toMatchObject({ topScore: null, returnedCount: 0, returned: [], degraded: true });
	});

	test("a shadow note is stored with the order and the number of positions it would move", () => {
		const row = retrievalRowOf({ surface: "omp", question: "q", backend: "lightrag", reply: { chunks: [corpusCitation("a.md", 0.5)] }, shadow: { mode: "shadow", order: ["acme/app:a.md"], moved: 0 } });
		expect(row.rerank).toEqual({ mode: "shadow", order: ["acme/app:a.md"], moved: 0 });
	});
});

describe("RetrievalRecorder", () => {
	const row = retrievalRowOf({ surface: "omp", question: "q", backend: "lightrag", reply: { chunks: [] }, shadow: null });

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

	test("with no index the row is dropped and counted", () => {
		const { recorder: rec } = recorder(null);
		rec.record(row);
		expect(rec.counters().dropped).toBe(1);
	});
});
