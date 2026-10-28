/**
 * Bounded recall and cross-bank dedupe (uplift-2 R3), proven against the fake
 * banks server.
 *
 * A bank that misses the shared budget degrades the reply with a reason that
 * leads with `recall-timeout` — distinguishable from an outage — and the
 * `memory_search` leg runs under its own, shorter budget so a slow plane
 * costs a search at most that long. The same memory recalled from several
 * banks collapses to its best-scoring copy before the sort.
 */
import { describe, expect, test } from "bun:test";
import { ReadThroughCache, type CacheRedis } from "./cache.ts";
import { DEFAULT_RETAIN_TIMEOUT_MS, DEFAULT_SEARCH_RECALL_BUDGET_MS, loadConfig } from "./config.ts";
import { HindsightFake } from "./hindsight-fake.ts";
import { DEFAULT_RECALL_BUDGET_MS, dedupeHits, recallMemories, type RecallDeps } from "./memory-recall.ts";
import { mergeDerivedHits } from "./memory-search.ts";
import type { HindsightConfig, RecallHit } from "./planes/hindsight.ts";
import { DEFAULT_RETAIN_DRAIN_MS, DEFAULT_RETAIN_MAX_ATTEMPTS, DEFAULT_RETAIN_OUTBOX_MAX } from "./retain-outbox.ts";
import { Substrate } from "./service.ts";

const CONFIG: HindsightConfig = { url: "http://fake", apiKey: "test-bearer", bankPrefix: "sub-" };

function deps(fake: HindsightFake, banks: string[] | null = ["sub-hermes"]): RecallDeps {
	return { config: CONFIG, banks, fetchImpl: fake.fetch, budgetMs: 2000 };
}

function hit(id: string, text: string, score: number, documentId?: string): RecallHit {
	return { id, text, tags: [], metadata: {}, score, ...(documentId !== undefined ? { document_id: documentId } : {}) };
}

/** The Hindsight env the service reads at call time, restored afterwards. */
function hindsightEnv(): () => void {
	const names = ["HINDSIGHT_URL", "HINDSIGHT_API_KEY", "HINDSIGHT_BANKS"];
	const saved = new Map(names.map((name) => [name, process.env[name]]));
	process.env.HINDSIGHT_URL = "http://fake";
	process.env.HINDSIGHT_API_KEY = "test-bearer";
	process.env.HINDSIGHT_BANKS = "sub-hermes";
	return () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

describe("recall budget", () => {
	test("a bank that misses the budget degrades the reply with a recall-timeout reason", async () => {
		const fake = new HindsightFake();
		fake.seed("sub-cursor", [hit("c1", "fence the lease", 0.5, "mwd_c1")]);
		fake.seed("sub-hermes", [hit("h1", "rotate the key", 0.9, "mwd_h1")]);
		fake.recallDelayMs["sub-hermes"] = 30_000;
		const reply = await recallMemories({ ...deps(fake), budgetMs: 50 }, "lease", "cursor");
		expect(reply.degraded).toBe(true);
		expect(reply.reason?.startsWith("recall-timeout")).toBe(true);
		expect(reply.reason).toContain("sub-hermes");
		expect(reply.results.map((found) => found.bank)).toEqual(["sub-cursor"]);
	});

	test("an outage keeps the failed wording, so slow and down stay distinguishable", async () => {
		const fake = new HindsightFake();
		fake.seed("sub-cursor", [hit("c1", "fence the lease", 0.5, "mwd_c1")]);
		fake.failRecallWith = 503;
		const reply = await recallMemories(deps(fake, null), "lease", "cursor");
		expect(reply).toMatchObject({ results: [], degraded: true });
		expect(reply.reason?.startsWith("hindsight recall failed")).toBe(true);
	});

	test("the memory_search merge carries the recall-timeout reason over the index rows", async () => {
		const fake = new HindsightFake();
		fake.seed("sub-cursor", [hit("c1", "fence the lease", 0.5, "mwd_c1")]);
		fake.recallDelayMs["sub-cursor"] = 30_000;
		const recall = await recallMemories({ ...deps(fake, null), budgetMs: 50 }, "lease", "cursor");
		const merged = mergeDerivedHits([], recall, undefined, { surface: "cursor", repo: null });
		expect(merged).toMatchObject({ entries: [], derived: [], degraded: true });
		expect(merged.reason?.startsWith("recall-timeout")).toBe(true);
	});

	test("the search leg uses the shorter configured budget and the tool uses its own", async () => {
		const restore = hindsightEnv();
		try {
			const fake = new HindsightFake();
			fake.seed("sub-cursor", [hit("c1", "fence the lease", 0.5, "mwd_c1")]);
			fake.seed("sub-hermes", [hit("h1", "rotate the key", 0.9, "mwd_h1")]);
			// Slower than the search leg's budget, faster than the tool's.
			fake.recallDelayMs["sub-hermes"] = 150;
			const config = loadConfig({ HINDSIGHT_SEARCH_RECALL_BUDGET_MS: "40", HINDSIGHT_RECALL_BUDGET_MS: "2000" });
			const substrate = new Substrate(config, { index: null, greptime: null, hindsightFetch: fake.fetch });
			const searched = await substrate.searchMemory("lease", undefined, undefined, undefined, "cursor");
			expect(searched.degraded).toBe(true);
			expect(searched.reason?.startsWith("recall-timeout")).toBe(true);
			expect(searched.derived.map((found) => found.bank)).toEqual(["sub-cursor"]);
			const recalled = await substrate.recallMemories({ query: "lease" }, "cursor");
			expect(recalled.degraded).toBe(false);
			expect(recalled.results.map((found) => found.bank)).toEqual(["sub-hermes", "sub-cursor"]);
		} finally {
			restore();
		}
	});
});

/** The three commands the cache needs; the same shape `cache-swr.test.ts` uses (its helper is not exported, and importing a test file would re-run it). */
class MapRedis implements CacheRedis {
	private readonly values = new Map<string, string>();
	async get(key: string): Promise<string | null> {
		return this.values.get(key) ?? null;
	}
	async set(key: string, value: string): Promise<void> {
		this.values.set(key, value);
	}
	async incr(key: string): Promise<number> {
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}
}

describe("a search joining an in-flight recall keeps its own budget", () => {
	test("memory_recall in flight, memory_search with the short budget answers recall-timeout at its own deadline and starts no second load", async () => {
		const restore = hindsightEnv();
		try {
			const fake = new HindsightFake();
			// The caller's own bank (`sub-cursor`) is always recalled beside the configured one; an unseeded
			// bank answers 404, which is a partial recall and would degrade the tool's reply for a reason
			// unrelated to the waiter.
			fake.seed("sub-cursor", [hit("c1", "fence the lease", 0.5, "mwd_c1")]);
			fake.seed("sub-hermes", [hit("h1", "rotate the key", 0.9, "mwd_h1")]);
			// The recall tool's budget (2000) outlasts this bank's latency; the search leg's (40) does not.
			fake.recallDelayMs["sub-hermes"] = 300;
			const config = loadConfig({ HINDSIGHT_SEARCH_RECALL_BUDGET_MS: "40", HINDSIGHT_RECALL_BUDGET_MS: "2000" });
			// Single-flight lives in the cache layer: without one nothing is shared.
			const cache = new ReadThroughCache({ redis: new MapRedis(), enabled: true, log: () => {} });
			const substrate = new Substrate(config, { index: null, greptime: null, hindsightFetch: fake.fetch, cache });

			const recall = substrate.recallMemories({ query: "lease" }, "cursor");
			// Let the recall register its flight and send its one request.
			while (fake.recalls().length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			const started = Date.now();
			const searched = await substrate.searchMemory("lease", undefined, undefined, undefined, "cursor");
			expect(searched.degraded).toBe(true);
			expect(searched.reason?.startsWith("recall-timeout")).toBe(true);
			// Answered at its own deadline, well before the recall's 300 ms plane latency.
			expect(Date.now() - started).toBeLessThan(250);
			// It joined the recall's load rather than starting another.

			const recalled = await recall;
			expect(recalled.degraded).toBe(false);
			expect(recalled.results.map((found) => found.bank)).toEqual(["sub-hermes", "sub-cursor"]);
			// One load fans out once over every configured bank; a second load would query a bank twice.
			const banksQueried = fake.requests.filter((request) => request.path.endsWith("/memories/recall")).map((request) => request.path);
			expect(banksQueried.sort()).toEqual(["/v1/default/banks/sub-cursor/memories/recall", "/v1/default/banks/sub-hermes/memories/recall"]);
			expect(new Set(banksQueried).size).toBe(banksQueried.length);
		} finally {
			restore();
		}
	});
});

describe("cross-bank dedupe", () => {
	test("the same memory from two banks collapses to its best score, keeping that bank", () => {
		const scored = [
			{ bank: "sub-cursor", hit: hit("c1", "fence the lease", 0.4, "mwd_same") },
			{ bank: "sub-hermes", hit: hit("h1", "fence the lease", 0.8, "mwd_same") },
			{ bank: "sub-hermes", hit: hit("h2", "rotate the key", 0.6, "mwd_other") },
		];
		expect(dedupeHits(scored).map(({ bank, hit: found }) => [bank, found.document_id, found.score])).toEqual([
			["sub-hermes", "mwd_same", 0.8],
			["sub-hermes", "mwd_other", 0.6],
		]);
	});

	test("one document id in two banks with different text is two memories, never one (Greptile round 1)", () => {
		// `retainDocumentId` omits the writer: cursor's and hermes's different
		// facts about one subject share an id across their banks.
		const scored = [
			{ bank: "sub-cursor", hit: hit("c1", "cursor says fence first", 0.4, "subj_shared") },
			{ bank: "sub-hermes", hit: hit("h1", "hermes says rotate first", 0.8, "subj_shared") },
		];
		expect(dedupeHits(scored).map(({ bank, hit: found }) => [bank, found.id])).toEqual([
			["sub-cursor", "c1"],
			["sub-hermes", "h1"],
		]);
	});

	test("within one bank a document id collapses; across banks identical text collapses and a tie keeps the earlier bank", () => {
		const scored = [
			{ bank: "sub-cursor", hit: hit("c1", "same words", 0.5) },
			{ bank: "sub-hermes", hit: hit("h1", "same words", 0.5) },
			{ bank: "sub-hermes", hit: hit("h2", "other words", 0.2, "mwd_keyed") },
			{ bank: "sub-hermes", hit: hit("h3", "other words, newer copy", 0.7, "mwd_keyed") },
		];
		expect(dedupeHits(scored).map(({ bank, hit: found }) => [bank, found.id])).toEqual([
			["sub-cursor", "c1"],
			["sub-hermes", "h3"],
		]);
	});

	test("recallMemories applies the dedupe before the score sort", async () => {
		const fake = new HindsightFake();
		fake.seed("sub-cursor", [hit("c1", "fence the lease", 0.4, "mwd_same"), hit("c2", "own only", 0.3, "mwd_own")]);
		fake.seed("sub-hermes", [hit("h1", "fence the lease", 0.8, "mwd_same")]);
		const reply = await recallMemories(deps(fake), "lease", "cursor");
		expect(reply.degraded).toBe(false);
		expect(reply.results.map((found) => `${found.bank}:${found.document_id}:${found.score}`)).toEqual(["sub-hermes:mwd_same:0.8", "sub-cursor:mwd_own:0.3"]);
	});
});

describe("config knobs", () => {
	test("defaults", () => {
		const config = loadConfig({});
		expect(config.hindsightBudgets).toEqual({
			recallBudgetMs: DEFAULT_RECALL_BUDGET_MS,
			searchRecallBudgetMs: DEFAULT_SEARCH_RECALL_BUDGET_MS,
			retainTimeoutMs: DEFAULT_RETAIN_TIMEOUT_MS,
		});
		expect(config.hindsightBudgets).toEqual({ recallBudgetMs: 4000, searchRecallBudgetMs: 1500, retainTimeoutMs: 8000 });
		expect(config.retainOutbox).toEqual({
			path: null,
			max: DEFAULT_RETAIN_OUTBOX_MAX,
			maxAttempts: DEFAULT_RETAIN_MAX_ATTEMPTS,
			drainMs: DEFAULT_RETAIN_DRAIN_MS,
		});
		expect(config.retainOutbox).toMatchObject({ max: 10_000, maxAttempts: 10, drainMs: 30_000 });
	});

	test("values parse; junk, zero and negatives fall back", () => {
		const config = loadConfig({
			HINDSIGHT_RECALL_BUDGET_MS: "2500",
			HINDSIGHT_SEARCH_RECALL_BUDGET_MS: "0",
			HINDSIGHT_RETAIN_TIMEOUT_MS: "soon",
			SUBSTRATE_RETAIN_OUTBOX_PATH: " /var/lib/substrate/retain-outbox.jsonl ",
			SUBSTRATE_RETAIN_OUTBOX_MAX: "500",
			SUBSTRATE_RETAIN_MAX_ATTEMPTS: "-1",
			SUBSTRATE_RETAIN_DRAIN_MS: "1.5",
		});
		expect(config.hindsightBudgets).toEqual({ recallBudgetMs: 2500, searchRecallBudgetMs: 1500, retainTimeoutMs: 8000 });
		expect(config.retainOutbox).toEqual({ path: "/var/lib/substrate/retain-outbox.jsonl", max: 500, maxAttempts: 10, drainMs: 30_000 });
	});
});

describe("the forgotten-entry lookup spends the recall's own budget", () => {
	const named = (id: string, entry: string): RecallHit => ({ id, text: `text of ${entry}`, tags: [], metadata: { entry_id: entry }, score: 0.5, document_id: `mwd_${id}` });

	test("a lookup that never answers is cut at the budget: hits naming an entry are withheld and the reply says it timed out", async () => {
		const fake = new HindsightFake();
		fake.seed("sub-hermes", [named("h1", "mem_1"), hit("h2", "a hit that names no entry", 0.4, "mwd_h2")]);
		const started = Date.now();
		const reply = await recallMemories({ ...deps(fake), budgetMs: 60, forgotten: () => new Promise<ReadonlySet<string>>(() => {}) }, "text", "hermes");
		expect(Date.now() - started).toBeLessThan(1500);
		expect(reply.degraded).toBe(true);
		expect(reply.reason?.startsWith("recall-timeout")).toBe(true);
		expect(reply.reason).toContain("forgotten-entry check timed out");
		expect(reply.results.map((found) => found.text)).toEqual(["a hit that names no entry"]);
	});

	test("a lookup that throws still fails closed, with the unavailable wording and no timeout marker", async () => {
		const fake = new HindsightFake();
		fake.seed("sub-hermes", [named("h1", "mem_1")]);
		const reply = await recallMemories({ ...deps(fake), forgotten: async () => { throw new Error("index down"); } }, "text", "hermes");
		expect(reply.degraded).toBe(true);
		expect(reply.reason).toContain("forgotten-entry check unavailable");
		expect(reply.reason?.startsWith("recall-timeout")).toBe(false);
		expect(reply.results).toEqual([]);
	});

	test("a lookup that answers in time drops the forgotten entry and leaves the reply whole", async () => {
		const fake = new HindsightFake();
		fake.seed("sub-hermes", [named("h1", "mem_1"), named("h2", "mem_2")]);
		const reply = await recallMemories({ ...deps(fake), forgotten: async () => new Set(["mem_1"]) }, "text", "hermes");
		expect(reply.degraded).toBe(false);
		expect(reply.results.map((found) => found.text)).toEqual(["text of mem_2"]);
	});
});
