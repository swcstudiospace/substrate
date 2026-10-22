/**
 * Plan 25-01 Task 2: docs_search returns at most 10 cited redacted results
 * with untrusted framing and a URL-listing note event; errors yield empty
 * plus reason. Proved against the recording fake.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CircuitBreaker, gatedFetch, type DocsSearchSample, type PlaneGate } from "@substrate/observability";
import { ReadThroughCache, type CacheRedis } from "./cache.ts";
import { attachGraphHints, citationProvenanceCounts, planningGraphCounts, searchDocs, searchReplyStorable, SNIPPET_CAP, UNTRUSTED_DOCS_NOTICE, type SearchCitation, type SearchReply } from "./docs-search.ts";
import type { DatasetListSource } from "./docs-datasets.ts";
import { RagflowFake, type FakeChunk } from "./ragflow-fake.ts";
import { ragflowOp } from "./planes/ragflow.ts";
import type { EventInput } from "./types.ts";
import { selectRetrievalBackend } from "./types.ts";
import { lightragFromEnv, loadConfig, resolveDocsBackend } from "./config.ts";
import { createMcpServer } from "./mcp.ts";
import { Substrate } from "./service.ts";
import { goldenFake, searchGoldenOffline } from "./docs-golden.ts";

const CONFIG = { url: "http://ragflow.test", apiKey: "test-key" };

function harness(fake: RagflowFake, pins?: Record<string, { dataset: string; dataset_id: string; version: string; commit: string }>) {
	const events: EventInput[] = [];
	const emit = async (event: EventInput): Promise<unknown> => {
		events.push(event);
		return { stored: false };
	};
	const search = (question: string): Promise<SearchReply> =>
		searchDocs({ config: CONFIG, emit, fetchImpl: fake.fetch, ...(pins ? { pins } : {}) }, question);
	return { events, search };
}

describe("docs_search", () => {
	test("returns cited redacted results with untrusted framing and a URL-listing event", async () => {
		const fake = new RagflowFake();
		const { events, search } = harness(fake);
		const reply = await search("who reads RAGFlow?");
		expect(reply.degraded).toBeUndefined();
		expect(reply.untrusted).toBe(UNTRUSTED_DOCS_NOTICE);
		expect(reply.chunks.length).toBeGreaterThan(0);
		expect(reply.chunks.length).toBeLessThanOrEqual(10);
		for (const citation of reply.chunks) {
			expect(citation.title).toBeString();
			expect(citation.source_url).toBeString();
			expect(citation.snippet.length).toBeLessThanOrEqual(SNIPPET_CAP);
		}
		const notes = events.filter((event) => event.kind === "note");
		expect(notes).toHaveLength(1);
		const payload = notes[0]?.payload ?? {};
		expect(payload.action).toBe("docs.search");
		expect(payload.urls).toEqual(reply.chunks.map((citation) => citation.source_url));
		expect(notes[0]?.repo).toBeFalsy();
	});

	test("Greptile round 2: an unrecorded document never borrows the dataset pin as its commit; the pin travels as dataset_commit", async () => {
		const fake = new RagflowFake();
		fake.chunkShape = "minimal";
		const { search } = harness(fake, {
			"ds-berlin-agent-substrate": {
				dataset: "agent-substrate",
				dataset_id: "ds-berlin-agent-substrate",
				version: "v3",
				commit: "abc123",
			},
		});
		const reply = await search("pin fallback?");
		expect(reply.chunks.length).toBeGreaterThan(0);
		// No ingest record for this document: it may predate or postdate v3.
		expect(reply.chunks[0]?.commit).toBe("dataset-pin:agent-substrate:unrecorded");
		expect(reply.chunks[0]?.commit).not.toBe("abc123");
		expect(reply.chunks[0]?.dataset_commit).toBe("abc123");
	});

	test("names the pin gap instead of inventing a commit", async () => {
		const fake = new RagflowFake();
		const { search } = harness(fake);
		const reply = await search("no pins yet?");
		expect(reply.chunks.length).toBeGreaterThan(0);
		expect(reply.chunks[0]?.commit).toBe("dataset-pin:agent-substrate:unrecorded");
		// No recorded version: nothing to present as the dataset's commit either.
		expect(reply.chunks[0]?.dataset_commit).toBeUndefined();
	});

	test("redacts snippets before reply", async () => {
		const fake = new RagflowFake();
		fake.chunks["ds-berlin-agent-substrate"] = [
			{
				content: "paste sk-proj-abcdefghij1234567890 into RAGFlow",
				document_name: "leak.md",
				document_id: "doc-leak",
				chunk_id: "chunk-leak",
				source_url: "https://example.com/leak",
				score: 0.99,
			},
		];
		const { search } = harness(fake);
		const reply = await search("where is the key?");
		const leaked = reply.chunks.find((citation) => citation.document_id === "doc-leak");
		expect(leaked?.snippet).toBeString();
		expect(leaked?.snippet).not.toContain("sk-proj-");
		expect(leaked?.snippet).toContain("[REDACTED]");
	});

	test("an error yields empty plus reason with a warning event", async () => {
		const fake = new RagflowFake();
		fake.failRetrievalWith = 503;
		const { events, search } = harness(fake);
		const reply = await search("who reads RAGFlow?");
		expect(reply).toMatchObject({ chunks: [], degraded: true });
		expect(typeof reply.reason).toBe("string");
		const warnings = events.filter((event) => event.kind === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.payload).toMatchObject({ action: "docs.search", reason: reply.reason });
	});

	test("an unconfigured plane yields empty plus reason", async () => {
		const events: EventInput[] = [];
		const reply = await searchDocs(
			{
				config: null,
				emit: async (event: EventInput): Promise<unknown> => {
					events.push(event);
					return { stored: false };
				},
			},
			"who reads RAGFlow?",
		);
		expect(reply).toMatchObject({ chunks: [], degraded: true, reason: "ragflow-not-configured" });
		expect(events).toHaveLength(1);
	});
});

describe("docs_search wiring", () => {
	test("Substrate.searchDocs serves citations and degrades when unconfigured", async () => {
		const fake = new RagflowFake();
		const live = new Substrate(loadConfig({ RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" }), {
			index: null,
			greptime: null,
			ragflowFetch: fake.fetch,
		});
		const reply = await live.searchDocs({ question: "who reads RAGFlow?" }, "omp");
		expect(reply.degraded).toBeUndefined();
		expect(reply.chunks.length).toBeGreaterThan(0);

		const bare = new Substrate(loadConfig({}), { index: null, greptime: null });
		const degraded = await bare.searchDocs({ question: "who reads RAGFlow?" }, "omp");
		expect(degraded).toMatchObject({ chunks: [], degraded: true, reason: "ragflow-not-configured" });
	});

	test("docs_search is callable over MCP", async () => {
		const fake = new RagflowFake();
		const substrate = new Substrate(loadConfig({ RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" }), {
			index: null,
			greptime: null,
			ragflowFetch: fake.fetch,
		});
		const server = createMcpServer(substrate, "omp");
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		try {
			const tools = (await client.listTools()).tools;
			expect(tools.some((tool) => tool.name === "docs_search")).toBe(true);
			const result = await client.callTool({ name: "docs_search", arguments: { question: "who reads RAGFlow?" } });
			const content = result.content as Array<{ type: string; text?: string }>;
			const reply = JSON.parse(content[0]?.text ?? "{}") as { chunks?: unknown[]; untrusted?: string };
			expect(Array.isArray(reply.chunks) && reply.chunks.length > 0).toBe(true);
			expect(typeof reply.untrusted).toBe("string");
		} finally {
			await client.close();
			await server.close();
		}
	});
});

describe("docs_search metadata redaction", () => {
	test("title, source URL and heading path are redacted like snippets", async () => {
		const fake = new RagflowFake();
		fake.chunks["ds-berlin-agent-substrate"] = [
			{
				content: "clean body",
				document_name: "sk-proj-abcdefghij1234567890",
				document_id: "doc-meta",
				chunk_id: "chunk-meta",
				heading_path: "sk-proj-abcdefghij1234567890",
				source_url: "https://example.com/sk-proj-abcdefghij1234567890",
				score: 0.99,
			},
		];
		const { search } = harness(fake);
		const reply = await search("where is the key?");
		const cited = reply.chunks.find((citation) => citation.document_id === "doc-meta");
		expect(cited?.title).not.toContain("sk-proj-");
		expect(cited?.source_url).not.toContain("sk-proj-");
		expect(cited?.heading_path).not.toContain("sk-proj-");
	});
});

/** A redis that remembers every command, so the cache's store decision is observable. */
class FakeRedis implements CacheRedis {
	readonly values = new Map<string, string>();
	readonly commands: string[] = [];
	async get(key: string): Promise<string | null> {
		this.commands.push(`GET ${key}`);
		return this.values.get(key) ?? null;
	}
	async set(key: string, value: string, ttlSeconds: number): Promise<void> {
		this.commands.push(`SET ${key} ttl=${ttlSeconds}`);
		this.values.set(key, value);
	}
	async incr(key: string): Promise<number> {
		this.commands.push(`INCR ${key}`);
		const next = Number(this.values.get(key) ?? "0") + 1;
		this.values.set(key, String(next));
		return next;
	}
}

describe("docs_search fan-out under one budget (uplift-3 N5)", () => {
	const SLOW = "ds-hamm-programming-desk";
	/** A budget the deadline timer — the code under test's own, not the test's — enforces quickly. */
	const BUDGET_MS = 100;

	/**
	 * The slow dataset answers only when `gate` is resolved — never, unless
	 * the test resolves it; `arrived` settles when its retrieval reaches the
	 * fake. Every other dataset answers at once.
	 */
	function stall(fake: RagflowFake, slow: string = SLOW): { gate: PromiseWithResolvers<FakeChunk[]>; arrived: Promise<void> } {
		const gate = Promise.withResolvers<FakeChunk[]>();
		const arrived = Promise.withResolvers<void>();
		fake.answer = (datasetId) => {
			if (datasetId !== slow) return fake.chunks[datasetId] ?? [];
			arrived.resolve();
			return gate.promise;
		};
		return { gate, arrived: arrived.promise };
	}

	/** The dataset list as the service's 60 s cache would hold it, so the list itself never consumes the breaker's probe. */
	function listedBy(fake: RagflowFake): DatasetListSource {
		return {
			list: async () => ({ ok: true, datasets: fake.datasets.map((dataset) => ({ id: dataset.id, name: dataset.name })) }),
			invalidate: () => {},
		};
	}

	test("a dataset that outlives the budget is degraded alone: the others' citations arrive within the budget", async () => {
		const fake = new RagflowFake();
		// Never released: a dataset whose transport hangs past the budget.
		stall(fake);
		const events: EventInput[] = [];
		const emit = async (event: EventInput): Promise<unknown> => {
			events.push(event);
			return { stored: false };
		};
		const started = performance.now();
		const reply = await searchDocs({ config: CONFIG, emit, fetchImpl: fake.fetch, budgetMs: BUDGET_MS }, "who reads RAGFlow?");
		const elapsed = performance.now() - started;

		// Within the budget plus tolerance, not the per-call 4 s timeout the stalled dataset would cost.
		expect(elapsed).toBeLessThan(BUDGET_MS * 10);
		expect(reply.degraded).toBeUndefined();
		expect(reply.degraded_datasets).toEqual([{ dataset: "programming-desk", reason: `deadline (${BUDGET_MS} ms docs budget)` }]);
		// Both other datasets answered: their four seeded chunks, still score-sorted.
		expect(reply.chunks).toHaveLength(4);
		// The fake serves no URL metadata (none is documented), so the proof is the document ids.
		expect(reply.chunks.map((citation) => citation.document_id).sort()).toEqual(
			["doc-ds-berlin-agent-substrate-1", "doc-ds-berlin-agent-substrate-2", "doc-ds-leipzig-agent-skills-1", "doc-ds-leipzig-agent-skills-2"],
		);
		expect(reply.chunks.map((citation) => citation.score)).toEqual([0.91, 0.91, 0.83, 0.83]);
		// Not stored by the answer cache: the next caller retries the missing dataset.
		expect(searchReplyStorable(reply)).toBe(false);
		// Still one note, naming the two datasets that answered and the one that did not.
		const notes = events.filter((event) => event.kind === "note");
		expect(notes).toHaveLength(1);
		expect(notes[0]?.payload).toMatchObject({
			action: "docs.search",
			dataset_ids: ["ds-berlin-agent-substrate", "ds-leipzig-agent-skills"],
			count: 4,
			degraded_datasets: [{ dataset: "programming-desk", reason: `deadline (${BUDGET_MS} ms docs budget)` }],
		});
		expect(events.filter((event) => event.kind === "warning")).toHaveLength(0);
	});

	test("a dataset that fails is degraded alone; the reply is `degraded: true` only when every dataset failed", async () => {
		const fake = new RagflowFake();
		fake.answer = (datasetId) => {
			if (datasetId === SLOW) throw new Error("boom");
			return fake.chunks[datasetId] ?? [];
		};
		const { events, search } = harness(fake);
		const partial = await search("who reads RAGFlow?");
		expect(partial.degraded).toBeUndefined();
		expect(partial.chunks).toHaveLength(4);
		expect(partial.degraded_datasets?.map((entry) => entry.dataset)).toEqual(["programming-desk"]);
		expect(partial.degraded_datasets?.[0]?.reason).toStartWith("ragflow unreachable:");
		expect(searchReplyStorable(partial)).toBe(false);

		fake.failRetrievalWith = 503;
		const all = await search("who reads RAGFlow?");
		expect(all).toMatchObject({ chunks: [], degraded: true, reason: "ragflow 503" });
		expect(all.degraded_datasets?.map((entry) => entry.dataset)).toEqual(["agent-substrate", "programming-desk", "agent-skills"]);
		expect(all.degraded_datasets?.every((entry) => entry.reason === "ragflow 503")).toBe(true);
		expect(searchReplyStorable(all)).toBe(false);
		const warnings = events.filter((event) => event.kind === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.payload).toMatchObject({ action: "docs.search", reason: "ragflow 503" });
	});

	test("a reply every dataset answered carries no degraded_datasets and is storable", async () => {
		const fake = new RagflowFake();
		const { search } = harness(fake);
		const reply = await search("who reads RAGFlow?");
		expect(reply.degraded_datasets).toBeUndefined();
		expect(searchReplyStorable(reply)).toBe(true);
	});

	test("the retrievals leave together: each dataset answers only once every retrieval has arrived", async () => {
		const fake = new RagflowFake();
		const everyoneArrived = Promise.withResolvers<void>();
		let seen = 0;
		fake.answer = async (datasetId) => {
			seen += 1;
			if (seen === fake.datasets.length) everyoneArrived.resolve();
			// A sequential client never gets all three in flight: its first
			// retrieval would wait for a second it has not started, miss the
			// budget, and the assertions below would name it.
			await everyoneArrived.promise;
			return fake.chunks[datasetId] ?? [];
		};
		const reply = await searchDocs({ config: CONFIG, emit: async () => ({ stored: false }), fetchImpl: fake.fetch, budgetMs: BUDGET_MS }, "who reads RAGFlow?");
		expect(reply.degraded_datasets).toBeUndefined();
		expect(reply.chunks).toHaveLength(6);
		expect(fake.retrievals()).toHaveLength(3);
		expect(fake.maxInFlight).toBe(3);
	});

	test("Greptile round 1 (PR #61): a half-open breaker probes with the first dataset alone, then the siblings fan out and return citations", async () => {
		const fake = new RagflowFake();
		// A real breaker, opened by one failure and already past its open window.
		let now = 1_000_000;
		const breaker = new CircuitBreaker("ragflow", { enabled: true, failureThreshold: 1, openMs: 1000 }, () => now);
		breaker.onFailure("ragflow 503");
		now += 1000;
		expect(breaker.state()).toBe("half-open");
		const gate: PlaneGate = { plane: "ragflow", breaker, observe: null };
		const fetchImpl = gatedFetch(gate, fake.fetch, ragflowOp);
		// The probe settles only when released, so the siblings' departure is observable.
		const { gate: probeGate, arrived } = stall(fake, "ds-berlin-agent-substrate");
		const pending = searchDocs(
			{ config: CONFIG, emit: async () => ({ stored: false }), fetchImpl, datasets: listedBy(fake), budgetMs: 2_000, breakerState: () => breaker.state() },
			"who reads RAGFlow?",
		);
		await arrived;
		// Only the probe has left; nobody was refused `ragflow circuit open`.
		expect(fake.retrievals()).toHaveLength(1);
		expect(breaker.state()).toBe("half-open");
		probeGate.resolve(fake.chunks["ds-berlin-agent-substrate"] ?? []);
		const reply = await pending;
		// The probe closed the breaker; the siblings ran after it and answered.
		expect(breaker.state()).toBe("closed");
		expect(reply.degraded).toBeUndefined();
		expect(reply.degraded_datasets).toBeUndefined();
		expect(reply.chunks).toHaveLength(6);
		expect(fake.retrievals()).toHaveLength(3);
		expect(fake.maxInFlight).toBe(2);
	});

	test("Greptile round 1 (PR #61): the half-open probe still shares the budget — a stalled probe costs one budget, not a budget per dataset", async () => {
		const fake = new RagflowFake();
		let now = 1_000_000;
		const breaker = new CircuitBreaker("ragflow", { enabled: true, failureThreshold: 1, openMs: 1000 }, () => now);
		breaker.onFailure("ragflow 503");
		now += 1000;
		const fetchImpl = gatedFetch({ plane: "ragflow", breaker, observe: null }, fake.fetch, ragflowOp);
		// Never released: the probe hangs past the budget. The deadline settles
		// it, and the siblings — which only leave after it — find the same
		// expired deadline, so the whole search still costs one budget and
		// nothing reaches the plane behind a probe that never came back.
		stall(fake, "ds-berlin-agent-substrate");
		const started = performance.now();
		const reply = await searchDocs(
			{ config: CONFIG, emit: async () => ({ stored: false }), fetchImpl, datasets: listedBy(fake), budgetMs: BUDGET_MS, breakerState: () => breaker.state() },
			"who reads RAGFlow?",
		);
		expect(performance.now() - started).toBeLessThan(BUDGET_MS * 10);
		expect(reply.degraded).toBe(true);
		expect(reply.degraded_datasets?.map((entry) => entry.dataset)).toEqual(["agent-substrate", "programming-desk", "agent-skills"]);
		expect(reply.degraded_datasets?.every((entry) => entry.reason === `deadline (${BUDGET_MS} ms docs budget)`)).toBe(true);
		// The breaker is still probing, so the siblings were refused at the gate: one retrieval reached the fake.
		expect(fake.retrievals()).toHaveLength(1);
		expect(breaker.state()).toBe("half-open");
	});

	/** A fetch that refuses the first retrieval of `datasetId` the way an open gate does, then serves normally. */
	function refusingOnce(fake: RagflowFake, datasetId: string): typeof fetch {
		let refused = false;
		return (async (input: string | URL | Request, init?: RequestInit) => {
			const body = typeof init?.body === "string" ? init.body : "";
			if (!refused && String(input).endsWith("/api/v1/retrieval") && body.includes(datasetId)) {
				refused = true;
				const open = new Error("circuit open");
				open.name = "BreakerOpenError";
				throw open;
			}
			return fake.fetch(input, init);
		}) as unknown as typeof fetch;
	}

	test("Greptile round 1 (PR #61): a sibling refused `ragflow circuit open` while the breaker has since closed is retried once and answers", async () => {
		const fake = new RagflowFake();
		const reply = await searchDocs(
			{ config: CONFIG, emit: async () => ({ stored: false }), fetchImpl: refusingOnce(fake, "ds-leipzig-agent-skills"), budgetMs: 2_000, breakerState: () => "closed" },
			"who reads RAGFlow?",
		);
		expect(reply.degraded).toBeUndefined();
		expect(reply.degraded_datasets).toBeUndefined();
		expect(reply.chunks).toHaveLength(6);
		// Two first attempts reached the plane (the third was refused at the gate), plus the retry.
		expect(fake.retrievals()).toHaveLength(3);
	});

	test("a `ragflow circuit open` refusal stands when the breaker is still not closed, and without breakerState nothing is retried", async () => {
		for (const state of [() => "open" as const, undefined]) {
			const fake = new RagflowFake();
			const reply = await searchDocs(
				{ config: CONFIG, emit: async () => ({ stored: false }), fetchImpl: refusingOnce(fake, "ds-leipzig-agent-skills"), budgetMs: 2_000, ...(state ? { breakerState: state } : {}) },
				"who reads RAGFlow?",
			);
			expect(reply.degraded_datasets).toEqual([{ dataset: "agent-skills", reason: "ragflow circuit open" }]);
			expect(reply.chunks).toHaveLength(4);
		}
	});

	test("a closed breaker never serialises: all three leave together even with breakerState supplied", async () => {
		const fake = new RagflowFake();
		const everyoneArrived = Promise.withResolvers<void>();
		let seen = 0;
		fake.answer = async (datasetId) => {
			seen += 1;
			if (seen === fake.datasets.length) everyoneArrived.resolve();
			await everyoneArrived.promise;
			return fake.chunks[datasetId] ?? [];
		};
		const reply = await searchDocs(
			{ config: CONFIG, emit: async () => ({ stored: false }), fetchImpl: fake.fetch, budgetMs: BUDGET_MS, breakerState: () => "closed" },
			"who reads RAGFlow?",
		);
		expect(reply.chunks).toHaveLength(6);
		expect(fake.maxInFlight).toBe(3);
	});

	test("budget 0 keeps the per-call timeout only: a slow dataset is waited for", async () => {
		const fake = new RagflowFake();
		const { gate, arrived } = stall(fake);
		const pending = searchDocs({ config: CONFIG, emit: async () => ({ stored: false }), fetchImpl: fake.fetch, budgetMs: 0 }, "slow?");
		// Release the slow dataset only once the search has reached it and is waiting.
		await arrived;
		gate.resolve(fake.chunks[SLOW] ?? []);
		const reply = await pending;
		expect(reply.degraded_datasets).toBeUndefined();
		expect(reply.chunks).toHaveLength(6);
	});

	test("Substrate.searchDocs: a partially served reply is not cached, and the configured budget reaches the search", async () => {
		const fake = new RagflowFake();
		stall(fake);
		const redis = new FakeRedis();
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		const config = loadConfig({ RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k", SUBSTRATE_DOCS_SEARCH_BUDGET_MS: String(BUDGET_MS) });
		expect(config.docsSearchBudgetMs).toBe(BUDGET_MS);
		expect(loadConfig({}).docsSearchBudgetMs).toBe(4000);
		expect(loadConfig({ SUBSTRATE_DOCS_SEARCH_BUDGET_MS: "soon" }).docsSearchBudgetMs).toBe(4000);
		const substrate = new Substrate(config, { index: null, greptime: null, ragflowFetch: fake.fetch, cache });
		const first = await substrate.searchDocs({ question: "who reads RAGFlow?" }, "omp");
		expect(first.degraded_datasets?.map((entry) => entry.dataset)).toEqual(["programming-desk"]);
		expect(redis.commands.some((command) => command.startsWith("SET substrate:v1:docs-search:"))).toBe(false);
		// The slow dataset recovers: the next search loads again and is stored.
		fake.answer = null;
		const second = await substrate.searchDocs({ question: "who reads RAGFlow?" }, "omp");
		expect(second.degraded_datasets).toBeUndefined();
		expect(second.chunks).toHaveLength(6);
		expect(redis.commands.filter((command) => command.startsWith("SET substrate:v1:docs-search:"))).toHaveLength(1);
	});
});

describe("docs_search outcome metrics (uplift-3 N5)", () => {
	test("Substrate.searchDocs reports one sample per search: hit/empty/degraded, cached or loaded, with the citation provenance split", async () => {
		const fake = new RagflowFake();
		const redis = new FakeRedis();
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		const samples: DocsSearchSample[] = [];
		const substrate = new Substrate(
			loadConfig({ RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" }),
			{ index: null, greptime: null, ragflowFetch: fake.fetch, cache },
			{ docsSearch: (sample) => samples.push(sample) },
		);

		// Loaded, then served from the cache: same answer, different `cached`.
		await substrate.searchDocs({ question: "who reads RAGFlow?" }, "grok-bot");
		await substrate.searchDocs({ question: "who reads RAGFlow?" }, "grok-bot");
		// Nothing matched: a real answer with no citations.
		fake.answer = () => [];
		await substrate.searchDocs({ question: "nothing here" }, "omp");
		// Every dataset failed.
		fake.failRetrievalWith = 503;
		await substrate.searchDocs({ question: "down" }, "omp");

		expect(samples.map((sample) => [sample.surface, sample.outcome, sample.cached])).toEqual([
			["grok-bot", "hit", false],
			["grok-bot", "hit", true],
			["omp", "empty", false],
			["omp", "degraded", false],
		]);
		// The fake's documents have no ingest record, so every citation is `unrecorded` —
		// counted on the cache hit too, since it returned them as well.
		expect(samples[0]?.citations).toEqual({ unrecorded: 6 });
		expect(samples[1]?.citations).toEqual({ unrecorded: 6 });
		expect(samples[2]?.citations).toEqual({});
		expect(samples[3]?.citations).toEqual({});
		expect(samples.every((sample) => sample.durationMs >= 0)).toBe(true);
	});

	test("citationProvenanceCounts reads the markers cite writes", () => {
		const citation = { title: "", source_url: "", heading_path: "", snippet: "", score: 0, document_id: "", chunk_id: "" };
		expect(
			citationProvenanceCounts([
				{ ...citation, commit: "abc123" },
				{ ...citation, commit: "dataset-pin:agent-substrate:unrecorded" },
				{ ...citation, commit: "dataset-pin:agent-skills:unpinned" },
				{ ...citation, commit: "dataset-pin:agent-skills:unpinned" },
			]),
		).toEqual({ recorded: 1, unrecorded: 1, unpinned: 2 });
	});
});

describe("docs backend selection (LightRAG cutover)", () => {
	test("selectRetrievalBackend: an explicit preference wins when available", () => {
		expect(selectRetrievalBackend({ ragflow: true, lightrag: true }, "lightrag")).toBe("lightrag");
		expect(selectRetrievalBackend({ ragflow: true, lightrag: true }, "ragflow")).toBe("ragflow");
	});

	test("selectRetrievalBackend: ragflow keeps today's default; lightrag is the fallback; null when bare", () => {
		expect(selectRetrievalBackend({ ragflow: true, lightrag: false })).toBe("ragflow");
		expect(selectRetrievalBackend({ ragflow: true, lightrag: true })).toBe("ragflow");
		expect(selectRetrievalBackend({ ragflow: false, lightrag: true })).toBe("lightrag");
		expect(selectRetrievalBackend({ ragflow: false, lightrag: false })).toBeNull();
	});

	test("selectRetrievalBackend: an unavailable preference falls back instead of stranding the search", () => {
		expect(selectRetrievalBackend({ ragflow: true, lightrag: false }, "lightrag")).toBe("ragflow");
		expect(selectRetrievalBackend({ ragflow: false, lightrag: true }, "ragflow")).toBe("lightrag");
		expect(selectRetrievalBackend({ ragflow: false, lightrag: false }, "lightrag")).toBeNull();
	});

	test("resolveDocsBackend: LIGHTRAG_URL presence means lightrag, else ragflow", () => {
		expect(resolveDocsBackend({})).toEqual({ backend: "ragflow", rejected: null });
		expect(resolveDocsBackend({ LIGHTRAG_URL: "http://lightrag.test:8000" })).toEqual({ backend: "lightrag", rejected: null });
		expect(resolveDocsBackend({ LIGHTRAG_URL: "   " })).toEqual({ backend: "ragflow", rejected: null });
	});

	test("resolveDocsBackend: an explicit SUBSTRATE_DOCS_BACKEND wins; a typo is rejected without switching", () => {
		expect(resolveDocsBackend({ LIGHTRAG_URL: "http://lightrag.test", SUBSTRATE_DOCS_BACKEND: "ragflow" })).toEqual({
			backend: "ragflow",
			rejected: null,
		});
		expect(resolveDocsBackend({ SUBSTRATE_DOCS_BACKEND: "LightRAG" })).toEqual({ backend: "lightrag", rejected: null });
		expect(resolveDocsBackend({ SUBSTRATE_DOCS_BACKEND: "lightragg" })).toEqual({ backend: "ragflow", rejected: "lightragg" });
		expect(resolveDocsBackend({ LIGHTRAG_URL: "http://lightrag.test", SUBSTRATE_DOCS_BACKEND: "weaviate" })).toEqual({
			backend: "lightrag",
			rejected: "weaviate",
		});
	});

	test("lightragFromEnv: null without a URL; keyless reach is a URL alone; trims the URL; never echoes the key", () => {
		expect(lightragFromEnv({})).toBeNull();
		expect(lightragFromEnv({ LIGHTRAG_API_KEY: "k" })).toBeNull();
		expect(lightragFromEnv({ LIGHTRAG_URL: "http://lightrag.test" })).toEqual({ url: "http://lightrag.test" });
		const config = lightragFromEnv({ LIGHTRAG_URL: "http://lightrag.test/", LIGHTRAG_API_KEY: "k" });
		expect(config).toEqual({ url: "http://lightrag.test", apiKey: "k" });
		expect(JSON.stringify(config)).not.toContain("k-secret");
	});
});

describe("search graph metadata (LightRAG path)", () => {
	const HINTS = [
		{ phase: "25-lightrag", entities: ["Access path", "RAGFlow datasets"], relations: [{ source: "Access path", target: "RAGFlow datasets", kind: "links-to" }] },
	];

	/**
	 * Plants the two headings the graph tests hint against in every dataset,
	 * through the fake's own seed table. Serving seeds turns on the
	 * `heading_path` echo, and nothing else is served, so each citation's
	 * heading is exactly the one planted here.
	 */
	function seedHeadings(fake: RagflowFake): void {
		fake.serveUploadsAsChunks = true;
		for (const dataset of fake.datasets) {
			const sourceUrl = `https://example.com/${dataset.name}/graph`;
			fake.seeds.push(
				{ dataset_id: dataset.id, document_id: `doc-${dataset.id}-1`, content: "The substrate is the only door to the data planes.", source_url: sourceUrl, heading_path: "Access path", score: 0.91 },
				{ dataset_id: dataset.id, document_id: `doc-${dataset.id}-2`, content: "Callers cite the source, not the chunk.", source_url: sourceUrl, heading_path: "RAGFlow datasets", score: 0.83 },
			);
		}
	}

	test("planningGraphCounts reports distinct entities and every relation", () => {
		expect(planningGraphCounts([])).toEqual({ entities: 0, relations: 0 });
		expect(planningGraphCounts(HINTS)).toEqual({ entities: 2, relations: 1 });
		expect(
			planningGraphCounts([
				...HINTS,
				{ phase: "25-other", entities: ["Access path", "Fresh entity"], relations: [] },
			]),
		).toEqual({ entities: 3, relations: 1 });
	});

	test("attachGraphHints names hinted headings and counts the coverage", () => {
		expect(attachGraphHints([], undefined)).toBeUndefined();
		const chunks: SearchCitation[] = [
			{ title: "a", source_url: "s", heading_path: "Access path", commit: "c", snippet: "s", score: 1, document_id: "d", chunk_id: "k" },
			{ title: "b", source_url: "s", heading_path: "Elsewhere", commit: "c", snippet: "s", score: 0.5, document_id: "e", chunk_id: "j" },
		];
		const stats = attachGraphHints(chunks, HINTS);
		expect(stats).toEqual({ entities: 2, relations: 1 });
		expect(chunks[0]?.graph).toEqual({ entities: ["Access path"], relations: 1 });
		expect(chunks[1]?.graph).toBeUndefined();
	});

	test("a search with graph hints returns graph counts and names the hinted headings", async () => {
		const fake = new RagflowFake();
		seedHeadings(fake);
		const events: EventInput[] = [];
		const reply = await searchDocs(
			{ config: CONFIG, emit: async (event) => ((events.push(event)), { stored: false }), fetchImpl: fake.fetch, graphHints: HINTS },
			"who reads RAGFlow?",
		);
		expect(reply.degraded).toBeUndefined();
		expect(reply.graph).toEqual({ entities: 2, relations: 1 });
		// Both seed headings are hinted, so every citation carries graph
		// metadata; the relation count rides the source heading only.
		for (const citation of reply.chunks) {
			expect(citation.graph?.entities).toEqual([citation.heading_path]);
		}
		const access = reply.chunks.filter((citation) => citation.heading_path === "Access path");
		const datasets = reply.chunks.filter((citation) => citation.heading_path === "RAGFlow datasets");
		expect(access.length).toBeGreaterThan(0);
		expect(datasets.length).toBeGreaterThan(0);
		expect(access.every((citation) => citation.graph?.relations === 1)).toBe(true);
		expect(datasets.every((citation) => citation.graph?.relations === undefined)).toBe(true);
		// The citations themselves are unchanged: still capped, still framed.
		expect(reply.chunks.length).toBeLessThanOrEqual(10);
		expect(reply.untrusted).toBe(UNTRUSTED_DOCS_NOTICE);
		const notes = events.filter((event) => event.kind === "note");
		expect(notes).toHaveLength(1);
		expect(notes[0]?.payload).toMatchObject({ action: "docs.search", graph: { entities: 2, relations: 1 } });
	});

	test("a search without graph hints serves the pure RAGFlow reply: no graph, no citation graph", async () => {
		const fake = new RagflowFake();
		const reply = await searchDocs({ config: CONFIG, emit: async () => ({ stored: false }), fetchImpl: fake.fetch }, "who reads RAGFlow?");
		expect(reply.graph).toBeUndefined();
		expect(reply.chunks.length).toBeGreaterThan(0);
		expect(reply.chunks.every((citation) => citation.graph === undefined)).toBe(true);
	});

	test("an unhinted heading stays graph-free while its hinted sibling is named", async () => {
		const fake = new RagflowFake();
		seedHeadings(fake);
		const reply = await searchDocs(
			{
				config: CONFIG,
				emit: async () => ({ stored: false }),
				fetchImpl: fake.fetch,
				graphHints: [{ phase: "25-lightrag", entities: ["Access path"], relations: [] }],
			},
			"who reads RAGFlow?",
		);
		expect(reply.graph).toEqual({ entities: 1, relations: 0 });
		const access = reply.chunks.filter((citation) => citation.heading_path === "Access path");
		const datasets = reply.chunks.filter((citation) => citation.heading_path === "RAGFlow datasets");
		expect(access.length).toBeGreaterThan(0);
		expect(datasets.length).toBeGreaterThan(0);
		expect(access.every((citation) => citation.graph?.entities?.includes("Access path"))).toBe(true);
		expect(datasets.every((citation) => citation.graph === undefined)).toBe(true);
	});

	test("golden: a .planning snippet survives the offline harness with graph metadata", async () => {
		const corpus = {
			documents: [
				{
					dataset: "agent-substrate",
					slug: "planning-graph",
					source_url: "https://example.com/agent-substrate/planning-graph",
					document_id: "doc-planning-graph",
					name: "planning-graph.md",
					body: "# Planning graph\n\nThe lightrag backend serves planning relations.",
				},
			],
		};
		const offline = await searchGoldenOffline(corpus, { question: "lightrag backend planning relations", datasets: ["agent-substrate"] }, { commit: "golden" });
		expect(offline.retrievedDatasetIds).toEqual(["ds-berlin-agent-substrate"]);
		expect(offline.reply.chunks).toHaveLength(1);
		expect(offline.reply.chunks[0]?.heading_path).toBe("Planning graph");
		expect(offline.reply.untrusted).toBe(UNTRUSTED_DOCS_NOTICE);
		expect(offline.reply.graph).toBeUndefined();
		// Same corpus through the LightRAG-shaped call: the heading the hint
		// names carries graph metadata, and the reply reports the coverage.
		const fake = goldenFake(corpus);
		const hinted = await searchDocs(
			{
				config: { url: "http://ragflow.test", apiKey: "golden" },
				emit: async () => ({ stored: false }),
				surface: "omp",
				fetchImpl: fake.fetch,
				provenanceOf: () => ({ source_url: "https://example.com/agent-substrate/planning-graph", commit: "golden" }),
				graphHints: [{ phase: "golden", entities: ["Planning graph"], relations: [] }],
			},
			"lightrag backend planning relations",
		);
		expect(hinted.chunks).toHaveLength(1);
		expect(hinted.graph).toEqual({ entities: 1, relations: 0 });
		expect(hinted.chunks[0]?.graph).toEqual({ entities: ["Planning graph"] });
	});

	test("backend graph entity names are redacted before the reply serves them", async () => {
		const reply = await searchDocs(
			{
				config: null,
				backend: "lightrag",
				lightragConfig: { url: "http://lightrag.test" },
				datasetNames: ["agent-substrate"],
				lightragDatasets: { list: async () => ({ ok: true, datasets: [{ id: "ds-1", name: "agent-substrate" }] }), invalidate: () => {} },
				lightragRetrieve: async () => ({
					ok: true,
					chunks: [{ content: "The planner reads the key.", document_name: "plan.md", document_id: "doc-1", heading_path: "Plan", score: 0.9 }],
					detail: { mode: "hybrid", counts: { entities: 1, relations: 0 }, provenance: { entities: ["key sk-proj-abcdefghij1234567890"], relations: 0 } },
				}),
				emit: async () => ({ stored: false }),
				surface: "omp",
			},
			"which key does the planner use?",
		);
		expect(JSON.stringify(reply)).not.toContain("sk-proj-");
		expect(reply.chunks[0]?.graph?.entities[0]).toContain("[REDACTED]");
	});

	test("LightRAG search never consults the RAGFlow dataset list", async () => {
		let ragflowListings = 0;
		const reply = await searchDocs(
			{
				config: { url: "http://ragflow.test", apiKey: "test-key" },
				backend: "lightrag",
				lightragConfig: { url: "http://lightrag.test" },
				datasetNames: ["agent-substrate"],
				datasets: {
					list: async () => {
						ragflowListings += 1;
						return { ok: false, reason: "ragflow-unreachable" };
					},
					invalidate: () => undefined,
				},
				lightragRetrieve: async () => ({
					ok: true,
					chunks: [{ content: "The planner reads the plan.", document_name: "plan.md", document_id: "doc-1", heading_path: "Plan", score: 0.9 }],
					detail: { mode: "hybrid", counts: { entities: 0, relations: 0 }, provenance: { entities: [], relations: 0 } },
				}),
				emit: async () => ({ stored: false }),
				surface: "omp",
			},
			"where is the plan?",
		);
		expect(ragflowListings).toBe(0);
		expect(reply.degraded ?? false).toBe(false);
		expect(reply.chunks).toHaveLength(1);
	});
});
