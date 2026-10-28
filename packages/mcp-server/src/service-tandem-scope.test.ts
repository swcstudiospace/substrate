/**
 * The two off-by-default recall policies of v1.6 phase 57c, proved through `Substrate` (the library layers have
 * their own suites: `tandem-recall.test.ts`, `docs-search.test.ts`, `recall-snapshot.test.ts`):
 *
 *   - `SUBSTRATE_DOCS_TANDEM`: off is exactly today's docs answer and cache key; on merges Hindsight hits into the
 *     LightRAG citations, carries the tandem note, is never stored or replayed, moves the cache key, and a failing
 *     Hindsight only leaves its items out.
 *   - `SUBSTRATE_BRIEF_RECALL_SCOPE=graph`: off is exactly today's brief and cache keys; on adds only the claimed
 *     graph's recalled lines, under their own budget, under their own cache arguments, so one graph's lines are
 *     never served to another graph's brief.
 *
 * Every store is a fake and no clock or network is read: LightRAG is a stand-in `fetch`, Hindsight is the recording fake.
 */
import { describe, expect, test } from "bun:test";
import { MEMORY_GENERATION_KEY, ReadThroughCache, cacheKey, classOf, snapshotKey, type CacheKeyClass, type CacheRedis } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { HindsightFake } from "./hindsight-fake.ts";
import { resolveRecallBanks } from "./memory-recall.ts";
import { clearEnsuredBanks, type FetchLike } from "./planes/hindsight.ts";
import { GRAPH_RECALL_MAX_HITS, RECALL_TITLE_PREFIX, buildRecallQuery, fanoutSnapshotArgs } from "./recall-snapshot.ts";
import { Substrate } from "./service.ts";

class FakeRedis implements CacheRedis {
	readonly values = new Map<string, string>();
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
	keysOf(klass: CacheKeyClass): string[] {
		return [...this.values.keys()].filter((key) => classOf(key) === klass);
	}
}

function setEnv(values: Record<string, string>): () => void {
	const saved = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
	for (const [name, value] of Object.entries(values)) process.env[name] = value;
	return () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

/** Hindsight env for one test; restored afterwards. The service reads it at call time. */
async function withHindsight<T>(banks: string, body: () => Promise<T>): Promise<T> {
	const restore = setEnv({ HINDSIGHT_URL: "http://fake", HINDSIGHT_API_KEY: "test-bearer", HINDSIGHT_BANKS: banks });
	clearEnsuredBanks();
	try {
		return await body();
	} finally {
		restore();
	}
}

// ── docs search: tandem ──────────────────────────────────────────────────────

const QUESTION = "where is the plan?";
const MEMORY_TEXT = "Remembered: the planner reads PLAN.md before it plans.";

interface LightragStandIn {
	queries: string[];
	fetch: FetchLike;
}

/** A LightRAG `/query` stand-in: one chunk, and the raw body of every query it got. */
function lightragServing(): LightragStandIn {
	const queries: string[] = [];
	const fetch: FetchLike = async (input, init) => {
		const url = new URL(String(input));
		if (init?.method !== "POST" || url.pathname !== "/query") return Response.json({ detail: "no route" }, { status: 404 });
		queries.push(String(init.body));
		return Response.json({ status: "success", data: { chunks: [{ content: "The planner reads the plan.", document_name: "plan.md", document_id: "doc-lightrag", heading_path: "Plan", score: 0.9 }] } });
	};
	return { queries, fetch };
}

function seedMemories(fake: HindsightFake, texts: readonly string[] = [MEMORY_TEXT]): void {
	fake.seed(
		"sub-omp",
		texts.map((text, index) => ({ id: `m${index}`, text, document_id: `mwd_m${index}`, type: "world", tags: [], metadata: { scope: "repo:acme/app" }, score: 0.9 - index / 10 })),
	);
}

interface DocsWorld {
	substrate: Substrate;
	cache: ReadThroughCache;
	redis: FakeRedis;
	fake: HindsightFake;
	lightrag: LightragStandIn;
	/** The class and arguments of every cache read the service made. */
	reads: Array<{ klass: string; args: Record<string, unknown> }>;
}

function docsWorld(env: Record<string, string>, shared: Partial<Pick<DocsWorld, "redis" | "fake" | "lightrag">> & { hindsightFetch?: FetchLike } = {}): DocsWorld {
	const redis = shared.redis ?? new FakeRedis();
	const fake = shared.fake ?? new HindsightFake();
	const lightrag = shared.lightrag ?? lightragServing();
	const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
	const reads: DocsWorld["reads"] = [];
	const original = cache.getOrLoad.bind(cache) as (request: unknown) => Promise<unknown>;
	Reflect.set(cache, "getOrLoad", (request: { klass: string; args: Record<string, unknown> }) => {
		reads.push({ klass: request.klass, args: request.args });
		return original(request);
	});
	const substrate = new Substrate(
		loadConfig({ RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k", LIGHTRAG_URL: "http://lightrag.test", SUBSTRATE_DOCS_BACKEND: "lightrag", ...env }),
		{
			index: null,
			greptime: null,
			cache,
			lightragFetch: lightrag.fetch,
			hindsightFetch: shared.hindsightFetch ?? fake.fetch,
			ragflowFetch: async () => {
				throw new Error("RAGFlow is not part of this test");
			},
		},
	);
	return { substrate, cache, redis, fake, lightrag, reads };
}

const docsReads = (w: DocsWorld) => w.reads.filter((read) => read.klass === "docs-search");

/** The argument names the docs-search cache key carried before phase 57c. */
const TODAYS_KEY_PARTS = ["backend", "datasets", "degraded", "pins", "planning_hash", "question", "repo_id"];

describe("docs search with tandem OFF", () => {
	test("the reply and the cache key are today's: no tandem key anywhere, Hindsight is never asked, the answer is replayed", async () => {
		await withHindsight("sub-omp", async () => {
			const variants: Array<Record<string, string>> = [{}, { SUBSTRATE_DOCS_TANDEM: "off" }];
			for (const env of variants) {
				const w = docsWorld(env);
				seedMemories(w.fake);
				const first = await w.substrate.searchDocs({ question: QUESTION }, "omp");
				expect(first.backend).toBe("lightrag");
				expect(first.degraded).toBeUndefined();
				expect(Object.hasOwn(first, "tandem")).toBe(false);
				expect(first.chunks.map((chunk) => chunk.snippet)).toEqual(["The planner reads the plan."]);
				expect(first.chunks.every((chunk) => chunk.origin === undefined && chunk.derived === undefined)).toBe(true);
				expect(w.fake.requests).toEqual([]);

				const [read] = docsReads(w);
				expect(Object.keys(read?.args ?? {}).sort()).toEqual(TODAYS_KEY_PARTS);
				expect(w.redis.keysOf("docs-search")).toEqual([cacheKey("docs-search", "omp", "0", read?.args)]);

				// Stored, so the same question is answered from the cache.
				const second = await w.substrate.searchDocs({ question: QUESTION }, "omp");
				expect(second).toEqual(first);
				expect(w.lightrag.queries).toHaveLength(1);
			}
		});
	});
});

describe("docs search with tandem ON", () => {
	test("Hindsight is asked too: hits are merged with their origin, the tandem note is carried, and the cache key moves", async () => {
		await withHindsight("sub-omp", async () => {
			const w = docsWorld({ SUBSTRATE_DOCS_TANDEM: "on" });
			seedMemories(w.fake);

			const reply = await w.substrate.searchDocs({ question: QUESTION }, "omp");

			expect(reply.backend).toBe("lightrag");
			expect(reply.degraded).toBeUndefined();
			expect(reply.tandem).toEqual({ lightrag: 1, hindsight: 1, deduplicated: 0, leg: "ok" });
			expect(reply.chunks.map((chunk) => chunk.origin).sort()).toEqual(["hindsight", "lightrag"]);
			expect(reply.chunks.find((chunk) => chunk.origin === "hindsight")).toMatchObject({ derived: true, snippet: MEMORY_TEXT });
			expect(w.fake.recalls()).toHaveLength(1);

			const [read] = docsReads(w);
			expect(read?.args).toHaveProperty("tandem", true);
			expect(Object.keys(read?.args ?? {}).sort()).toEqual([...TODAYS_KEY_PARTS, "tandem"].sort());
		});
	});

	test("a tandem reply is never stored or replayed: a memory forgotten in between is gone from the next answer", async () => {
		await withHindsight("sub-omp", async () => {
			const w = docsWorld({ SUBSTRATE_DOCS_TANDEM: "on" });
			seedMemories(w.fake);
			const first = await w.substrate.searchDocs({ question: QUESTION }, "omp");
			expect(first.tandem?.hindsight).toBe(1);
			expect(w.redis.keysOf("docs-search")).toEqual([]);

			// The memory is forgotten: its document is deleted and the memory generation moves, as `memoryForget` does.
			const bank = w.fake.banks.get("sub-omp");
			if (bank === undefined) throw new Error("the seeded bank is missing");
			bank.memories.length = 0;
			await w.cache.bump(MEMORY_GENERATION_KEY);

			const second = await w.substrate.searchDocs({ question: QUESTION }, "omp");
			// Asked LightRAG again (not replayed), and nothing of the forgotten memory is left.
			expect(w.lightrag.queries).toHaveLength(2);
			expect(second.tandem).toEqual({ lightrag: 1, hindsight: 0, deduplicated: 0, leg: "empty" });
			expect(second.chunks.map((chunk) => chunk.origin)).toEqual(["lightrag"]);
			expect(JSON.stringify(second)).not.toContain(MEMORY_TEXT);
			expect(w.redis.keysOf("docs-search")).toEqual([]);
		});
	});

	test("flipping the flag never answers from a plain reply stored before it, nor the reverse", async () => {
		await withHindsight("sub-omp", async () => {
			const off = docsWorld({});
			seedMemories(off.fake);
			const plain = await off.substrate.searchDocs({ question: QUESTION }, "omp");
			expect(Object.hasOwn(plain, "tandem")).toBe(false);
			expect(off.redis.keysOf("docs-search")).toHaveLength(1);

			const on = docsWorld({ SUBSTRATE_DOCS_TANDEM: "on" }, { redis: off.redis, fake: off.fake, lightrag: off.lightrag });
			const merged = await on.substrate.searchDocs({ question: QUESTION }, "omp");
			expect(merged.tandem?.leg).toBe("ok");
			expect(off.lightrag.queries).toHaveLength(2);
			// The tandem reply stored nothing and left the plain entry where it was.
			expect(off.redis.keysOf("docs-search")).toHaveLength(1);

			const again = await off.substrate.searchDocs({ question: QUESTION }, "omp");
			expect(Object.hasOwn(again, "tandem")).toBe(false);
			expect(off.lightrag.queries).toHaveLength(2);
		});
	});

	test("SUBSTRATE_DOCS_TANDEM_LIMIT bounds the Hindsight items merged", async () => {
		await withHindsight("sub-omp", async () => {
			const w = docsWorld({ SUBSTRATE_DOCS_TANDEM: "on", SUBSTRATE_DOCS_TANDEM_LIMIT: "2" });
			seedMemories(w.fake, ["first remembered fact about the plan", "second remembered fact about review", "third remembered fact about deploys"]);
			const reply = await w.substrate.searchDocs({ question: QUESTION }, "omp");
			expect(reply.tandem).toMatchObject({ lightrag: 1, hindsight: 2, leg: "ok" });
			expect(reply.chunks.filter((chunk) => chunk.origin === "hindsight")).toHaveLength(2);
		});
	});

	test("a Hindsight failure is fail-open: the LightRAG answer is served whole, not degraded, with an empty leg", async () => {
		await withHindsight("sub-omp", async () => {
			const refusing = docsWorld({ SUBSTRATE_DOCS_TANDEM: "on" });
			seedMemories(refusing.fake);
			refusing.fake.failRecallWith = 500;
			const unreachable = docsWorld({ SUBSTRATE_DOCS_TANDEM: "on" }, {
				hindsightFetch: async () => {
					throw new Error("connection refused");
				},
			});
			for (const w of [refusing, unreachable]) {
				const reply = await w.substrate.searchDocs({ question: QUESTION }, "omp");
				expect(reply.backend).toBe("lightrag");
				expect(reply.degraded).toBeUndefined();
				expect(reply.fallback).toBeUndefined();
				expect(reply.chunks.map((chunk) => chunk.snippet)).toEqual(["The planner reads the plan."]);
				expect(reply.tandem).toEqual({ lightrag: 1, hindsight: 0, deduplicated: 0, leg: "empty" });
			}
		});
	});
});

// ── the brief: graph scope ───────────────────────────────────────────────────

const REPO = "acme/app";
const OWN_BANK = "sub-grok-bot";
const CONFIGURED = ["sub-omp", "sub-hermes", "sub-cursor", OWN_BANK];
const REQUEST = { repo: REPO, surface: "grok-bot" } as const;
const GRAPH_ONE = { ...REQUEST, graph_id: "ut-1" } as const;
const GRAPH_TWO = { ...REQUEST, graph_id: "ut-2" } as const;
const ENFORCE = { SUBSTRATE_BRIEF_RECALL: "enforce" };
const SCOPED = { ...ENFORCE, SUBSTRATE_BRIEF_RECALL_SCOPE: "graph" };
const RECALL_PATH = /\/memories\/recall$/;

/**
 * Three repo-scoped lines in the own bank, and in one other bank four lines of graph ut-1 (one more than the graph
 * budget) and one line of graph ut-2. The other banks hold nothing, so the lines that surface are exactly the ones the
 * policy selects.
 */
function seedBriefBanks(fake: HindsightFake): void {
	const repoLine = (id: string, text: string, score: number) => ({ id, text, document_id: `${id}-doc`, tags: [], metadata: { scope: `repo:${REPO}` }, score });
	const graphLine = (graph: string, id: string, text: string, score: number) => ({ id, text, document_id: `${id}-doc`, tags: [], metadata: { scope: `graph:${graph}`, graph_id: graph }, score });
	fake.seed(OWN_BANK, [repoLine("own-1", "own rule one", 0.95), repoLine("own-2", "own rule two", 0.94), repoLine("own-3", "own rule three", 0.93)]);
	fake.seed("sub-omp", [
		graphLine("ut-1", "g1-a", "ut-1 note alpha", 0.8),
		graphLine("ut-1", "g1-b", "ut-1 note beta", 0.7),
		graphLine("ut-1", "g1-c", "ut-1 note gamma", 0.6),
		graphLine("ut-1", "g1-d", "ut-1 note delta", 0.5),
		graphLine("ut-2", "g2-a", "ut-2 note only", 0.9),
	]);
	for (const bank of ["sub-hermes", "sub-cursor"]) fake.seed(bank, []);
}

interface BriefWorld {
	substrate: Substrate;
	redis: FakeRedis;
	fake: HindsightFake;
}

function briefWorld(env: Record<string, string>, shared: { redis?: FakeRedis; fake?: HindsightFake } = {}): BriefWorld {
	const redis = shared.redis ?? new FakeRedis();
	const fake = shared.fake ?? new HindsightFake();
	if (shared.fake === undefined) seedBriefBanks(fake);
	const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
	const substrate = new Substrate(loadConfig(env), { index: null, greptime: null, cache, hindsightFetch: fake.fetch });
	return { substrate, redis, fake };
}

/** The recall section's lines: the title names the banks and the age, then one line per hit, last in the brief. */
function recalledLines(text: string): string[] {
	const lines = text.split("\n");
	const at = lines.findIndex((line) => line.startsWith(RECALL_TITLE_PREFIX));
	if (at === -1) throw new Error("the brief carries no recall section");
	return lines.slice(at + 1);
}

const brief = async (w: BriefWorld, request: { repo: string; surface: "grok-bot"; graph_id?: string }): Promise<string> => (await w.substrate.briefDetailed(request, undefined, request.surface)).text;
const recallCalls = (fake: HindsightFake): number => fake.requests.filter((request) => RECALL_PATH.test(request.path)).length;

function fanoutBanks(surface: string): string[] {
	const resolved = resolveRecallBanks(surface, CONFIGURED, "sub-");
	if ("refused" in resolved) throw new Error(resolved.refused);
	return [...resolved.banks].sort();
}

/** The `recall-snapshot` key one fan-out lives under, with both generations unset (each reads as 0). */
function fanoutKey(extra: Record<string, unknown> = {}): string {
	return cacheKey("recall-snapshot", "grok-bot", "0:0", { ...fanoutSnapshotArgs(REPO, fanoutBanks("grok-bot"), buildRecallQuery(REPO, [])), ...extra });
}

const OWN_LINES = ["- own rule one", "- own rule two", "- own rule three"];
const BRIEF_SNAPSHOT_ARGS = { repo: REPO, branch: null, recall: "enforce", recallBank: OWN_BANK } as const;

describe("the brief's recall with SUBSTRATE_BRIEF_RECALL_SCOPE off", () => {
	test("graph-tagged memories change nothing: the lines, the fan-out key and the brief keys are today's", async () => {
		await withHindsight(CONFIGURED.join(","), async () => {
			for (const env of [ENFORCE, { ...ENFORCE, SUBSTRATE_BRIEF_RECALL_SCOPE: "off" }]) {
				const w = briefWorld(env);
				const text = await brief(w, GRAPH_ONE);
				expect(recalledLines(text)).toEqual(OWN_LINES);
				expect(text).not.toContain("[graph");
				expect(text).not.toContain("ut-1 note");
				// No `graph` argument in the fan-out key, no `recallScope` in the brief's.
				expect(w.redis.keysOf("recall-snapshot")).toEqual([fanoutKey()]);
				expect(w.redis.keysOf("brief-snapshot")).toEqual([snapshotKey("brief-snapshot", "grok-bot", { ...BRIEF_SNAPSHOT_ARGS, graph_id: "ut-1" })]);
			}
		});
	});
});

describe("the brief's recall with SUBSTRATE_BRIEF_RECALL_SCOPE=graph", () => {
	test("only the claimed graph's lines are added, after the own-bank lines, under their own budget", async () => {
		await withHindsight(CONFIGURED.join(","), async () => {
			const w = briefWorld(SCOPED);
			const text = await brief(w, GRAPH_ONE);
			// The own bank's three lines keep their three; the graph gets its own budget of three, so the fourth ut-1 line is cut
			// and the other graph's line never appears.
			expect(GRAPH_RECALL_MAX_HITS).toBe(3);
			expect(recalledLines(text)).toEqual([...OWN_LINES, "- [graph ut-1] ut-1 note alpha", "- [graph ut-1] ut-1 note beta", "- [graph ut-1] ut-1 note gamma"]);
			expect(text).not.toContain("ut-1 note delta");
			expect(text).not.toContain("ut-2 note only");
		});
	});

	test("the fan-out and the brief are keyed by the graph, so one graph's lines are never served to another", async () => {
		await withHindsight(CONFIGURED.join(","), async () => {
			const w = briefWorld(SCOPED);
			const one = await brief(w, GRAPH_ONE);
			expect(recallCalls(w.fake)).toBe(CONFIGURED.length);
			expect(w.redis.keysOf("recall-snapshot")).toEqual([fanoutKey({ graph: "ut-1" })]);

			// Same repo, same surface, another graph: its own fan-out, its own entry, none of ut-1's lines.
			const two = await brief(w, GRAPH_TWO);
			expect(recallCalls(w.fake)).toBe(CONFIGURED.length * 2);
			expect(recalledLines(two)).toEqual([...OWN_LINES, "- [graph ut-2] ut-2 note only"]);
			expect(two).not.toContain("ut-1 note");
			expect(one).not.toContain("ut-2 note only");

			// A brief that names no graph gets the plain fan-out and no graph line, from an entry of its own.
			const none = await brief(w, REQUEST);
			expect(recalledLines(none)).toEqual(OWN_LINES);
			expect(recallCalls(w.fake)).toBe(CONFIGURED.length * 3);
			expect([...w.redis.keysOf("recall-snapshot")].sort()).toEqual([fanoutKey({ graph: "ut-1" }), fanoutKey({ graph: "ut-2" }), fanoutKey()].sort());

			// The brief's own keys carry the scope, so an unscoped brief is never served as a scoped one.
			expect(w.redis.keysOf("brief-snapshot")).toContain(snapshotKey("brief-snapshot", "grok-bot", { ...BRIEF_SNAPSHOT_ARGS, graph_id: "ut-1", recallScope: "graph" }));
			expect(w.redis.keysOf("brief-snapshot")).not.toContain(snapshotKey("brief-snapshot", "grok-bot", { ...BRIEF_SNAPSHOT_ARGS, graph_id: "ut-1" }));
		});
	});

	test("an unscoped brief stored beforehand is not served to a scoped one over the same cache", async () => {
		await withHindsight(CONFIGURED.join(","), async () => {
			const off = briefWorld(ENFORCE);
			const plain = await brief(off, GRAPH_ONE);
			expect(recalledLines(plain)).toEqual(OWN_LINES);

			const scoped = briefWorld(SCOPED, { redis: off.redis, fake: off.fake });
			const text = await brief(scoped, GRAPH_ONE);
			expect(recalledLines(text)).toEqual([...OWN_LINES, "- [graph ut-1] ut-1 note alpha", "- [graph ut-1] ut-1 note beta", "- [graph ut-1] ut-1 note gamma"]);

			// And the reverse: the scoped entry does not leak graph lines into the unscoped brief.
			expect(recalledLines(await brief(off, GRAPH_ONE))).toEqual(OWN_LINES);
		});
	});
});
