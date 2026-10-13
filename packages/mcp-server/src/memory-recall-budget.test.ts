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
		const merged = mergeDerivedHits([], recall);
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

describe("cross-bank dedupe", () => {
	test("the same document from two banks collapses to its best score, keeping that bank", () => {
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

	test("hits without a document id dedupe on text, and a tie keeps the earlier bank", () => {
		const scored = [
			{ bank: "sub-cursor", hit: hit("c1", "same words", 0.5) },
			{ bank: "sub-hermes", hit: hit("h1", "same words", 0.5) },
			{ bank: "sub-hermes", hit: hit("h2", "same words", 0.2, "mwd_keyed") },
		];
		expect(dedupeHits(scored).map(({ bank, hit: found }) => [bank, found.id])).toEqual([
			["sub-cursor", "c1"],
			["sub-hermes", "h2"],
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
