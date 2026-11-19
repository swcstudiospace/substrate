/**
 * Plan 25-01 Task 2: docs_search returns at most 10 cited redacted results
 * with untrusted framing and a URL-listing note event; errors yield empty
 * plus reason. Proved against the recording fake.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { reposSeam } from "./planning/tree.fixtures.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CircuitBreaker, gatedFetch, type DocsSearchSample, type PlaneGate } from "@substrate/observability";
import { ReadThroughCache, type CacheRedis } from "./cache.ts";
import { attachGraphHints, citationProvenanceCounts, lightragDocumentDataset, planningGraphCounts, searchDocs, searchReplyStorable, SNIPPET_CAP, UNTRUSTED_DOCS_NOTICE, type DatasetPin, type SearchCitation, type SearchReply } from "./docs-search.ts";
import { documentProvenance, nodeIo, readSkillsCheckoutPages, skillsCheckoutRoots, type IngestRecord, type ScanIo } from "./docs-ingest.ts";
import type { FakeChunk } from "./docs-plane-fake.ts";
import { searchGoldenOffline } from "./docs-golden.ts";
import { datasetIdentity } from "./dataset-identity.ts";
 import type { GreptimeClient } from "./greptime.ts";
 import { HindsightFake } from "./hindsight-fake.ts";
 import type { DerivedMemoryHit } from "./memory-recall.ts";
 import { lightragOp, type FetchLike } from "./planes/lightrag.ts";
 import type { EventInput } from "./types.ts";
 import { selectRetrievalBackend } from "./types.ts";
 import { lightragFromEnv, loadConfig, resolveDocsBackend } from "./config.ts";
 import { createMcpServer } from "./mcp.ts";
 import { Substrate } from "./service.ts";
 import { auditToolCalls, createObservability, type McpToolCall } from "./observe.ts";
 import { createTestLiveSessionAuthority, issueLiveSession } from "./planning/live-session.test-support.ts";
 
const CONFIG = { url: "http://lightrag.test", apiKey: "test-key" };
const LIGHTRAG_CONFIG = { url: "http://lightrag.test", apiKey: "test-key" };
 
/** The three datasets the LightRAG fake serves: the scope a search over every fake dataset names. */
 const FAKE_DATASETS = ["agent-substrate", "programming-desk", "agent-skills"];
 
/**
 * v1.5.7 LightRAG plane double for docs_search (single retrieval).
 * Serves `POST /query` (one retrieval for the whole scope, `{ query, mode, top_k, only_need_context }`)
 * plus the ingest routes (`/documents/upload`, `/documents/text`, `/documents/scan`,
 * `/documents/pipeline_status`, `/documents/track_status/:id`) so refresh and search share one fake.
 * Kept local to this file because DocsPlaneFake still speaks the retired `/api/v1/retrieval` shape.
 */
class LightragFake {
	readonly datasets = [
		{ id: "ds-lightrag-agent-substrate", name: "agent-substrate" },
		{ id: "ds-lightrag-programming-desk", name: "programming-desk" },
		{ id: "ds-lightrag-agent-skills", name: "agent-skills" },
	];
	readonly queries: string[] = [];
	readonly uploads: Array<{ name: string; content: string; metadata: Record<string, string> }> = [];
	readonly seeds: Array<{ document_id: string; content: string; source_url?: string; heading_path?: string; score?: number }> = [];
	failRetrievalWith: number | null = null;
	failUploadWhen: ((content: string) => boolean) | null = null;
	chunkShape: "full" | "minimal" = "full";
	serveUploadsAsChunks = false;
	parseDonePolls = 1;
	answer: ((question: string) => FakeChunk[] | Promise<FakeChunk[]>) | null = null;
	inFlight = 0;
	maxInFlight = 0;
	private trackCount = 0;
	private readonly trackToDoc = new Map<string, string>();
	readonly chunks: Record<string, FakeChunk[]> = {
		"ds-lightrag-agent-substrate": [
			{ content: "agent-substrate doc one body about data planes.", document_name: "data-planes.md", document_id: "doc-substrate-1", chunk_id: "chunk-substrate-1", heading_path: "Data planes", source_url: "https://example.com/agent-substrate/data-planes", score: 0.91 },
			{ content: "agent-substrate doc two body about the gate.", document_name: "gate.md", document_id: "doc-substrate-2", chunk_id: "chunk-substrate-2", heading_path: "Gate", source_url: "https://example.com/agent-substrate/gate", score: 0.83 },
		],
		"ds-lightrag-programming-desk": [
			{ content: "programming-desk doc one body about architecture.", document_name: "architecture.md", document_id: "doc-desk-1", chunk_id: "chunk-desk-1", heading_path: "Architecture", source_url: "https://example.com/programming-desk/architecture", score: 0.91 },
			{ content: "programming-desk doc two body about the desk.", document_name: "desk.md", document_id: "doc-desk-2", chunk_id: "chunk-desk-2", heading_path: "Desk", source_url: "https://example.com/programming-desk/desk", score: 0.83 },
		],
		"ds-lightrag-agent-skills": [
			{ content: "agent-skills doc one body about review.", document_name: "review.md", document_id: "doc-skills-1", chunk_id: "chunk-skills-1", heading_path: "Review", source_url: "https://example.com/agent-skills/review", score: 0.91 },
			{ content: "agent-skills doc two body about skills.", document_name: "skills.md", document_id: "doc-skills-2", chunk_id: "chunk-skills-2", heading_path: "Skills", source_url: "https://example.com/agent-skills/skills", score: 0.83 },
		],
	};
	readonly fetch: FetchLike = async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = (init?.method ?? "GET").toUpperCase();
		if (method === "POST" && url.pathname === "/query") return this.query(init);
		if (method === "POST" && url.pathname === "/documents/upload") return this.upload(init);
		if (method === "POST" && url.pathname === "/documents/text") return this.textUpload(init);
		if (method === "POST" && url.pathname === "/documents/scan") return Response.json({ status: "success" });
		if (method === "GET" && url.pathname === "/documents/pipeline_status") return Response.json({ busy: false });
		if (method === "GET" && url.pathname.startsWith("/documents/track_status/")) {
			const track = decodeURIComponent(url.pathname.slice("/documents/track_status/".length));
			const doc = this.trackToDoc.get(track);
			if (doc === undefined) return Response.json({ documents: [], total_count: 0 });
			return Response.json({ documents: [{ id: doc, status: "processed" }], total_count: 1 });
		}
		return Response.json({ detail: `fake has no route for ${method} ${url.pathname}` }, { status: 404 });
	};
	private async query(init?: RequestInit): Promise<Response> {
		let question = "";
		if (typeof init?.body === "string" && init.body.length > 0) {
			try {
				const body = JSON.parse(init.body) as Record<string, unknown>;
				if (typeof body["query"] === "string") question = body["query"];
			} catch { /* ignore */ }
		}
		this.queries.push(question);
		if (this.failRetrievalWith !== null) return new Response("unavailable", { status: this.failRetrievalWith });
		this.inFlight += 1;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		try {
			const served = this.answer !== null ? await this.answer(question) : this.serveUploadsAsChunks ? this.uploadChunks() : this.allChunks();
			const chunks = served.map((chunk) => this.chunkShape === "minimal" ? { content: chunk.content, document_keyword: chunk.document_name } : {
				content: chunk.content,
				document_name: chunk.document_name,
				document_id: chunk.document_id ?? "",
				chunk_id: chunk.chunk_id ?? "",
				heading_path: chunk.heading_path ?? "",
				source_url: chunk.source_url ?? "",
				file_path: chunk.source_url ?? "",
				score: chunk.score ?? 0,
			});
			return Response.json({ status: "success", data: { chunks, entities: [], relations: [] } });
		} finally { this.inFlight -= 1; }
	}
	/** Every query body served, in order (the single-retrieval analogue of the old per-dataset retrievals). */
	queriesCount(): number { return this.queries.length; }
	private allChunks(): FakeChunk[] { return [...this.chunks["ds-lightrag-agent-substrate"] ?? [], ...this.chunks["ds-lightrag-programming-desk"] ?? [], ...this.chunks["ds-lightrag-agent-skills"] ?? []]; }
	private uploadChunks(): FakeChunk[] {
		const fromUploads: FakeChunk[] = this.uploads.map((upload, index) => ({ content: upload.content, document_name: upload.name, document_id: this.trackToDoc.get(this.trackFor(index + 1)) ?? `doc-upload-${index + 1}`, chunk_id: `chunk-upload-${index + 1}`, heading_path: upload.metadata["heading_path"] ?? "", source_url: upload.metadata["source_url"] ?? "", score: 0.9 }));
		const fromSeeds: FakeChunk[] = this.seeds.map((seed) => ({ content: seed.content, document_name: seed.document_id, document_id: seed.document_id, chunk_id: `chunk-seed-${seed.document_id}`, heading_path: seed.heading_path ?? "", source_url: seed.source_url ?? "", score: seed.score ?? 0.5 }));
		return [...fromUploads, ...fromSeeds];
	}
	private trackFor(n: number): string { return `trk-${n}`; }
	private async upload(init?: RequestInit): Promise<Response> {
		if (!(init?.body instanceof FormData)) return Response.json({ detail: "no file part" }, { status: 400 });
		const parts: Array<{ name: string; text: string }> = [];
		for (const part of init.body.getAll("file")) if (part instanceof Blob) parts.push({ name: part instanceof File ? part.name : "file", text: await part.text() });
		const sourceUrl = String(init.body.get("source_url") ?? "");
		const commit = String(init.body.get("commit") ?? "");
		const heading = String(init.body.get("heading_path") ?? "");
		for (const part of parts) {
			if (this.failUploadWhen?.(part.text)) return new Response("upload refused", { status: 500 });
			this.trackCount += 1;
			const track = this.trackFor(this.trackCount);
			const doc = `doc-${part.name.replace(/[^a-zA-Z0-9]/g, "-")}-${this.trackCount}`;
			this.trackToDoc.set(track, doc);
			this.uploads.push({ name: part.name, content: part.text, metadata: { source_url: sourceUrl, commit, heading_path: heading } });
		}
		return Response.json({ status: "success", data: { track_id: this.trackFor(this.trackCount) } });
	}
	private async textUpload(init?: RequestInit): Promise<Response> {
		let body: Record<string, unknown> = {};
		if (typeof init?.body === "string" && init.body.length > 0) { try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { /* ignore */ } }
		const content = typeof body["text"] === "string" ? body["text"] : "";
		const name = typeof body["file_source"] === "string" ? body["file_source"] : "doc.md";
		const sourceUrl = typeof body["source_url"] === "string" ? body["source_url"] : "";
		const commit = typeof body["commit"] === "string" ? body["commit"] : "";
		const heading = typeof body["heading_path"] === "string" ? body["heading_path"] : "";
		if (this.failUploadWhen?.(content)) return new Response("upload refused", { status: 500 });
		this.trackCount += 1;
		const track = this.trackFor(this.trackCount);
		const doc = `doc-${name.replace(/[^a-zA-Z0-9]/g, "-")}-${this.trackCount}`;
		this.trackToDoc.set(track, doc);
		this.uploads.push({ name, content, metadata: { source_url: sourceUrl, commit, heading_path: heading } });
		return Response.json({ status: "success", data: { track_id: track } });
	}
}
function lightragRecordsFor(chunksByDoc: Record<string, string>): Map<string, IngestRecord> {
	const records = new Map<string, IngestRecord>();
	for (const [documentId, datasetName] of Object.entries(chunksByDoc)) {
		const identity = datasetIdentity(datasetName);
		const sourceUrl = `https://example.com/${datasetName}/${documentId}`;
		records.set(`lightrag::${identity}::${sourceUrl}`, { sha: `sha-${documentId}`, dataset_id: identity, source_url: sourceUrl, document_id: documentId, version: 1 });
	}
	return records;
}
function harness(fake: LightragFake, pins?: Record<string, { dataset: string; dataset_id: string; version: string; commit: string }>, records?: Map<string, IngestRecord>) {
 	const events: EventInput[] = [];
 	const emit = async (event: EventInput): Promise<unknown> => {
 		events.push(event);
 		return { stored: false };
 	};
	const search = (question: string): Promise<SearchReply> =>
		searchDocs({ config: CONFIG, backend: "lightrag", lightragConfig: LIGHTRAG_CONFIG, lightragFetch: fake.fetch, lightragDatasets: { list: async () => ({ ok: true, datasets: fake.datasets.map((dataset) => ({ id: dataset.id, name: dataset.name })) }), invalidate: () => undefined }, lightragRetry: { maxRetries: 0, retryBaseMs: 1 }, emit, datasetNames: FAKE_DATASETS, ...(pins ? { pins } : {}), ...(records ? { lightragRecords: records } : {}) }, question);
	return { events, search };
}
describe("docs_search", () => {
	test("returns cited redacted results with untrusted framing and a URL-listing event", async () => {
		const fake = new LightragFake();
		const { events, search } = harness(fake);
		const reply = await search("who reads lightrag?");
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
		const fake = new LightragFake();
		const { search } = harness(fake, {
			"agent-substrate": {
				dataset: "agent-substrate",
				dataset_id: "ds-lightrag-agent-substrate",
				version: "v3",
				commit: "abc123",
			},
		}, lightragRecordsFor({ "doc-substrate-1": "agent-substrate", "doc-substrate-2": "agent-substrate", "doc-desk-1": "programming-desk", "doc-desk-2": "programming-desk", "doc-skills-1": "agent-skills", "doc-skills-2": "agent-skills" }));
		const reply = await search("pin fallback?");
		expect(reply.chunks.length).toBeGreaterThan(0);
		// No ingest record for this document: it may predate or postdate v3.
		const substrateChunks = reply.chunks.filter((chunk) => chunk.document_id.startsWith("doc-substrate"));
		expect(substrateChunks.length).toBeGreaterThan(0);
		expect(substrateChunks[0]?.commit).toBe("dataset-pin:agent-substrate:unrecorded");
		expect(substrateChunks[0]?.commit).not.toBe("abc123");
		expect(substrateChunks[0]?.dataset_commit).toBe("abc123");
		// A chunk no record names is unattributed and cites no pin.
		const orphan = reply.chunks.find((chunk) => chunk.document_id === "doc-unknown");
		expect(orphan).toBeUndefined();
	});

	test("names the pin gap instead of inventing a commit", async () => {
		const fake = new LightragFake();
		const { search } = harness(fake);
		const reply = await search("no pins yet?");
		expect(reply.chunks.length).toBeGreaterThan(0);
		// No LightRAG record names these documents: the pin gap is the unattributed marker.
		expect(reply.chunks[0]?.commit).toBe("dataset-pin:unattributed:unrecorded");
		// No recorded version: nothing to present as the dataset's commit either.
		expect(reply.chunks[0]?.dataset_commit).toBeUndefined();
	});

	test("redacts snippets before reply", async () => {
		const fake = new LightragFake();
		fake.chunks["ds-lightrag-agent-substrate"] = [
			{
				content: "paste sk-proj-abcdefghij1234567890 into lightrag",
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
		const fake = new LightragFake();
		fake.failRetrievalWith = 503;
		const { events, search } = harness(fake);
		const reply = await search("who reads lightrag?");
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
				datasetNames: FAKE_DATASETS,
				emit: async (event: EventInput): Promise<unknown> => {
					events.push(event);
					return { stored: false };
				},
			},
			"who reads lightrag?",
		);
		expect(reply).toMatchObject({ chunks: [], degraded: true, reason: "lightrag-not-configured" });
		expect(events).toHaveLength(1);
	});
});

describe("docs_search wiring", () => {
	test("Substrate.searchDocs serves citations and degrades when unconfigured", async () => {
		const fake = new LightragFake();
		const live = new Substrate(loadConfig({ LIGHTRAG_URL: "http://lightrag.test", LIGHTRAG_API_KEY: "k" }), {
			index: null,
			greptime: null,
			lightragFetch: fake.fetch,
		});
		const reply = await live.searchDocs({ question: "who reads lightrag?" }, "omp");
		expect(reply.degraded).toBeUndefined();
		expect(reply.chunks.length).toBeGreaterThan(0);

		const bare = new Substrate(loadConfig({}), { index: null, greptime: null });
		const degraded = await bare.searchDocs({ question: "who reads lightrag?" }, "omp");
		expect(degraded).toMatchObject({ chunks: [], degraded: true, reason: "lightrag-not-configured" });
	});

	test("docs_search is callable over MCP", async () => {
		const fake = new LightragFake();
		const substrate = new Substrate(loadConfig({ LIGHTRAG_URL: "http://lightrag.test", LIGHTRAG_API_KEY: "k" }), {
			index: null,
			greptime: null,
			lightragFetch: fake.fetch,
		});
		const server = createMcpServer(substrate, "omp");
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		try {
			const tools = (await client.listTools()).tools;
			expect(tools.some((tool) => tool.name === "docs_search")).toBe(true);
			const result = await client.callTool({ name: "docs_search", arguments: { question: "who reads lightrag?" } });
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
		const fake = new LightragFake();
		fake.chunks["ds-lightrag-agent-substrate"] = [
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
	/** A budget the deadline timer — the code under test's own, not the test's — enforces quickly. */
	const BUDGET_MS = 100;

	/**
	 * The single query answers only when `gate` is resolved — never, unless
	 * the test resolves it; `arrived` settles when the query reaches the fake.
	 */
	function stall(fake: LightragFake): { gate: PromiseWithResolvers<FakeChunk[]>; arrived: Promise<void> } {
		const gate = Promise.withResolvers<FakeChunk[]>();
		const arrived = Promise.withResolvers<void>();
		fake.answer = () => {
			arrived.resolve();
			return gate.promise;
		};
		return { gate, arrived: arrived.promise };
	}

	/** The dataset list as the service's 60 s cache would hold it. */
	function listedBy(fake: LightragFake): { list: () => Promise<{ ok: true; datasets: Array<{ id: string; name: string }> }>; invalidate: () => void } {
		return {
			list: async () => ({ ok: true, datasets: fake.datasets.map((dataset) => ({ id: dataset.id, name: dataset.name })) }),
			invalidate: () => {},
		};
	}

	function lightragDeps(fake: LightragFake, extra: Record<string, unknown> = {}) {
		return { config: CONFIG, backend: "lightrag" as const, lightragConfig: LIGHTRAG_CONFIG, lightragFetch: fake.fetch, lightragDatasets: listedBy(fake), datasetNames: FAKE_DATASETS, lightragRetry: { maxRetries: 0, retryBaseMs: 1 }, emit: async () => ({ stored: false }), ...extra };
	}

	test("a query that outlives the budget is degraded: the search returns degraded within the budget", async () => {
		const fake = new LightragFake();
		// Never released: a query whose transport hangs past the budget.
		stall(fake);
		const events: EventInput[] = [];
		const emit = async (event: EventInput): Promise<unknown> => {
			events.push(event);
			return { stored: false };
		};
		const started = performance.now();
		const reply = await searchDocs(lightragDeps(fake, { emit, budgetMs: BUDGET_MS }), "who reads lightrag?");
		const elapsed = performance.now() - started;

		// Within the budget plus tolerance, not the per-call 4 s timeout.
		expect(elapsed).toBeLessThan(BUDGET_MS * 10);
		expect(reply.degraded).toBe(true);
		expect(reply.chunks).toHaveLength(0);
		expect(reply.degraded_datasets).toEqual([{ dataset: "agent-substrate", reason: `deadline (${BUDGET_MS} ms docs budget)` }]);
		// Not stored by the answer cache: the next caller retries.
		expect(searchReplyStorable(reply)).toBe(false);
		expect(events.filter((event) => event.kind === "warning")).toHaveLength(1);
		expect(events.filter((event) => event.kind === "note")).toHaveLength(0);
	});

	test("a query that fails is degraded: the reply is `degraded: true` with the failure reason", async () => {
		const fake = new LightragFake();
		const { events, search } = harness(fake);
		fake.failRetrievalWith = 503;
		const all = await search("who reads lightrag?");
		expect(all).toMatchObject({ chunks: [], degraded: true, reason: "lightrag 503" });
		expect(all.degraded_datasets).toEqual([{ dataset: "agent-substrate", reason: "lightrag 503" }]);
		expect(searchReplyStorable(all)).toBe(false);
		const warnings = events.filter((event) => event.kind === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.payload).toMatchObject({ action: "docs.search", reason: "lightrag 503" });
	});

	test("a reply the query answered carries no degraded_datasets and is storable", async () => {
		const fake = new LightragFake();
		const { search } = harness(fake);
		const reply = await search("who reads lightrag?");
		expect(reply.degraded_datasets).toBeUndefined();
		expect(reply.degraded).toBeUndefined();
		expect(searchReplyStorable(reply)).toBe(true);
		expect(reply.chunks).toHaveLength(6);
	});

	test("the query is a single retrieval: one /query serves the whole scope", async () => {
		const fake = new LightragFake();
		const reply = await searchDocs(lightragDeps(fake, { emit: async () => ({ stored: false }), budgetMs: BUDGET_MS }), "who reads lightrag?");
		expect(reply.degraded_datasets).toBeUndefined();
		expect(reply.chunks).toHaveLength(6);
		expect(fake.queries).toHaveLength(1);
		expect(fake.maxInFlight).toBe(1);
	});

	test("Greptile round 1 (PR #61): a half-open breaker still serves the single query and closes on success", async () => {
		const fake = new LightragFake();
		// A real breaker, opened by one failure and already past its open window.
		let now = 1_000_000;
		const breaker = new CircuitBreaker("lightrag", { enabled: true, failureThreshold: 1, openMs: 1000 }, () => now);
		breaker.onFailure("lightrag 503");
		now += 1000;
		expect(breaker.state()).toBe("half-open");
		const gate: PlaneGate = { plane: "lightrag", breaker, observe: null };
		const fetchImpl = gatedFetch(gate, fake.fetch, lightragOp);
		const reply = await searchDocs(
			lightragDeps(fake, { lightragFetch: fetchImpl, budgetMs: 2_000, lightragBreakerState: () => breaker.state(), emit: async () => ({ stored: false }) }),
			"who reads lightrag?",
		);
		// The single query probed the plane; success closed the breaker.
		expect(breaker.state()).toBe("closed");
		expect(reply.degraded).toBeUndefined();
		expect(reply.chunks).toHaveLength(6);
		expect(fake.queries).toHaveLength(1);
	});

	test("Greptile round 1 (PR #61): a stalled query still shares the budget — one budget, not a budget per dataset", async () => {
		const fake = new LightragFake();
		let now = 1_000_000;
		const breaker = new CircuitBreaker("lightrag", { enabled: true, failureThreshold: 1, openMs: 1000 }, () => now);
		breaker.onFailure("lightrag 503");
		now += 1000;
		const fetchImpl = gatedFetch({ plane: "lightrag", breaker, observe: null }, fake.fetch, lightragOp);
		// Never released: the query hangs past the budget.
		stall(fake);
		const started = performance.now();
		const reply = await searchDocs(
			lightragDeps(fake, { lightragFetch: fetchImpl, budgetMs: BUDGET_MS, lightragBreakerState: () => breaker.state(), emit: async () => ({ stored: false }) }),
			"who reads lightrag?",
		);
		expect(performance.now() - started).toBeLessThan(BUDGET_MS * 10);
		expect(reply.degraded).toBe(true);
		expect(reply.degraded_datasets).toEqual([{ dataset: "agent-substrate", reason: `deadline (${BUDGET_MS} ms docs budget)` }]);
		// One query reached the fake.
		expect(fake.queries).toHaveLength(1);
	});

	/** A fetch that refuses the first query the way an open gate does, then serves normally. */
	function refusingOnce(fake: LightragFake): typeof fetch {
		let refused = false;
		return (async (input: string | URL | Request, init?: RequestInit) => {
			if (!refused && String(input).includes("/query")) {
				refused = true;
				const open = new Error("circuit open");
				open.name = "BreakerOpenError";
				throw open;
			}
			return fake.fetch(input, init);
		}) as unknown as typeof fetch;
	}

	test("Greptile round 1 (PR #61): a refusal `lightrag circuit open` while the breaker has since closed is retried once and answers", async () => {
		const fake = new LightragFake();
		const reply = await searchDocs(
			lightragDeps(fake, { lightragFetch: refusingOnce(fake), budgetMs: 2_000, lightragBreakerState: () => "closed" as const, emit: async () => ({ stored: false }) }),
			"who reads lightrag?",
		);
		expect(reply.degraded).toBeUndefined();
		expect(reply.chunks).toHaveLength(6);
		// The refused attempt plus the retry.
		expect(fake.queries).toHaveLength(1);
	});

	test("a `lightrag circuit open` refusal stands when the breaker is still not closed, and without breakerState nothing is retried", async () => {
		// Breaker open at search time: the plane is never asked, so there is no degraded dataset to name.
		{
			const fake = new LightragFake();
			const reply = await searchDocs(
				lightragDeps(fake, {
					lightragFetch: refusingOnce(fake),
					budgetMs: 2_000,
					emit: async () => ({ stored: false }),
					lightragBreakerState: () => "open" as const,
				}),
				"who reads lightrag?",
			);
			expect(reply.degraded).toBe(true);
			expect(reply.reason).toBe("lightrag circuit open");
			expect(reply.chunks).toHaveLength(0);
			expect(reply.degraded_datasets).toBeUndefined();
			expect(fake.queries).toHaveLength(0);
		}
		// No breakerState: the gated fetch refuses once and nothing retries it.
		{
			const fake = new LightragFake();
			const reply = await searchDocs(
				lightragDeps(fake, {
					lightragFetch: refusingOnce(fake),
					budgetMs: 2_000,
					emit: async () => ({ stored: false }),
				}),
				"who reads lightrag?",
			);
			expect(reply.degraded).toBe(true);
			expect(reply.chunks).toHaveLength(0);
			expect(reply.degraded_datasets).toEqual([{ dataset: "agent-substrate", reason: "lightrag circuit open" }]);
			expect(fake.queries).toHaveLength(0);
		}
	});

	test("a closed breaker never serialises: the single query leaves at once with breakerState supplied", async () => {
		const fake = new LightragFake();
		const reply = await searchDocs(
			lightragDeps(fake, { budgetMs: BUDGET_MS, lightragBreakerState: () => "closed" as const, emit: async () => ({ stored: false }) }),
			"who reads lightrag?",
		);
		expect(reply.chunks).toHaveLength(6);
		expect(fake.queries).toHaveLength(1);
		expect(fake.maxInFlight).toBe(1);
	});

	test("budget 0 keeps the per-call timeout only: a slow query is waited for", async () => {
		const fake = new LightragFake();
		const { gate, arrived } = stall(fake);
		const pending = searchDocs(lightragDeps(fake, { emit: async () => ({ stored: false }), budgetMs: 0 }), "slow?");
		// Release the query only once the search has reached it and is waiting.
		await arrived;
		gate.resolve(fake.chunks["ds-lightrag-agent-substrate"] ?? []);
		const reply = await pending;
		expect(reply.degraded_datasets).toBeUndefined();
		expect(reply.chunks.length).toBeGreaterThan(0);
	});

	test("Substrate.searchDocs: a degraded reply is not cached, and the configured budget reaches the search", async () => {
		const fake = new LightragFake();
		stall(fake);
		const redis = new FakeRedis();
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		const seam = reposSeam();
		const config = loadConfig({ ...seam.env, LIGHTRAG_URL: "http://lightrag.test", LIGHTRAG_API_KEY: "k", SUBSTRATE_DOCS_SEARCH_BUDGET_MS: String(BUDGET_MS) });
		expect(config.docsSearchBudgetMs).toBe(BUDGET_MS);
		expect(loadConfig({}).docsSearchBudgetMs).toBe(4000);
		expect(loadConfig({ SUBSTRATE_DOCS_SEARCH_BUDGET_MS: "soon" }).docsSearchBudgetMs).toBe(4000);
		const substrate = new Substrate(config, { index: null, greptime: null, lightragFetch: fake.fetch, cache, ...seam.stores });
		const first = await substrate.searchDocs({ question: "who reads lightrag?" }, "omp");
		expect(first.degraded).toBe(true);
		expect(redis.commands.some((command) => command.startsWith("SET substrate:v1:docs-search:"))).toBe(false);
		// The query recovers: the next search loads again and is stored.
		fake.answer = null;
		const second = await substrate.searchDocs({ question: "who reads lightrag?" }, "omp");
		expect(second.degraded_datasets).toBeUndefined();
		expect(second.chunks).toHaveLength(6);
		expect(redis.commands.filter((command) => command.startsWith("SET substrate:v1:docs-search:"))).toHaveLength(1);
	});
});

describe("docs_search outcome metrics (uplift-3 N5)", () => {
	test("Substrate.searchDocs reports one sample per search: hit/degraded, cached or loaded, with the citation provenance split", async () => {
		const fake = new LightragFake();
		const redis = new FakeRedis();
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		const samples: DocsSearchSample[] = [];
		const seam = reposSeam();
		const substrate = new Substrate(
			loadConfig({ ...seam.env, LIGHTRAG_URL: "http://lightrag.test", LIGHTRAG_API_KEY: "k" }),
			{ index: null, greptime: null, lightragFetch: fake.fetch, cache, ...seam.stores },
			{ docsSearch: (sample) => samples.push(sample) },
		);

		// Loaded, then served from the cache: same answer, different `cached`.
		await substrate.searchDocs({ question: "who reads lightrag?" }, "grok-bot");
		await substrate.searchDocs({ question: "who reads lightrag?" }, "grok-bot");
		// Nothing matched: a /query envelope with no chunks is a shape failure, never a silent empty answer.
		fake.answer = () => [];
		await substrate.searchDocs({ question: "nothing here" }, "omp");
		// The query failed.
		fake.answer = null;
		fake.failRetrievalWith = 503;
		await substrate.searchDocs({ question: "down" }, "omp");

		expect(samples.map((sample) => [sample.surface, sample.outcome, sample.cached])).toEqual([
			["grok-bot", "hit", false],
			["grok-bot", "hit", true],
			["omp", "degraded", false],
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
		expect(selectRetrievalBackend({ lightrag: true }, "lightrag")).toBe("lightrag");
		expect(selectRetrievalBackend({ lightrag: false }, "lightrag")).toBeNull();
	});

	test("selectRetrievalBackend: lightrag keeps today's default; lightrag is the fallback; null when bare", () => {
		expect(selectRetrievalBackend({ lightrag: true })).toBe("lightrag");
		expect(selectRetrievalBackend({ lightrag: true })).toBe("lightrag");
		expect(selectRetrievalBackend({ lightrag: false })).toBeNull();
		expect(selectRetrievalBackend({ lightrag: false })).toBeNull();
	});

	test("selectRetrievalBackend: an unavailable preference falls back instead of stranding the search", () => {
		expect(selectRetrievalBackend({ lightrag: true }, "lightrag")).toBe("lightrag");
		expect(selectRetrievalBackend({ lightrag: false }, "lightrag")).toBeNull();
		expect(selectRetrievalBackend({ lightrag: false }, "lightrag")).toBeNull();
	});

	test("resolveDocsBackend: LIGHTRAG_URL presence means lightrag, else lightrag", () => {
		expect(resolveDocsBackend({})).toEqual({ backend: "lightrag", rejected: null });
		expect(resolveDocsBackend({ LIGHTRAG_URL: "http://lightrag.test:8000" })).toEqual({ backend: "lightrag", rejected: null });
		expect(resolveDocsBackend({ LIGHTRAG_URL: "   " })).toEqual({ backend: "lightrag", rejected: null });
	});

	test("resolveDocsBackend: an explicit SUBSTRATE_DOCS_BACKEND wins; a typo is rejected without switching", () => {
		expect(resolveDocsBackend({ LIGHTRAG_URL: "http://lightrag.test", SUBSTRATE_DOCS_BACKEND: "lightrag" })).toEqual({
			backend: "lightrag",
			rejected: null,
		});
		expect(resolveDocsBackend({ SUBSTRATE_DOCS_BACKEND: "LightRAG" })).toEqual({ backend: "lightrag", rejected: null });
		expect(resolveDocsBackend({ SUBSTRATE_DOCS_BACKEND: "lightragg" })).toEqual({ backend: "lightrag", rejected: "lightragg" });
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

describe("LightRAG search and the lightrag plane", () => {
	/** A LightRAG `/query` stand-in: answers one chunk with `chunk` and records the raw body of every query it gets. */
	function lightragServing(chunk: string) {
		const queries: string[] = [];
		const fetch: FetchLike = async (input, init) => {
			const url = new URL(String(input));
			if (init?.method !== "POST" || url.pathname !== "/query") return Response.json({ detail: "no route" }, { status: 404 });
			queries.push(String(init.body));
			return Response.json({ status: "success", data: { chunks: [{ content: chunk, document_name: "plan.md", document_id: "doc-lightrag", heading_path: "Plan", score: 0.9 }] } });
		};
		return { fetch, queries };
	}

	test("a LightRAG search still retrieves while the lightrag breaker is open", async () => {
		const lightrag = new CircuitBreaker("lightrag", { enabled: true, failureThreshold: 1, openMs: 60_000 });
		lightrag.onFailure("lightrag 503");
		expect(lightrag.state()).toBe("open");
		let retrievals = 0;
		const reply = await searchDocs(
			{
				config: { url: "http://lightrag.test", apiKey: "test-key" },
				backend: "lightrag",
				lightragConfig: { url: "http://lightrag.test" },
				datasetNames: ["agent-substrate"],
				breakerState: () => lightrag.state(),
				lightragRetrieve: async () => {
					retrievals += 1;
					return {
						ok: true,
						chunks: [{ content: "The planner reads the plan.", document_name: "plan.md", document_id: "doc-1", heading_path: "Plan", score: 0.9 }],
						detail: { mode: "hybrid", counts: { entities: 0, relations: 0 }, provenance: { entities: [], relations: 0 } },
					};
				},
				emit: async () => ({ stored: false }),
				surface: "omp",
			},
			"where is the plan?",
		);
		expect(retrievals).toBe(1);
		expect(reply.degraded).toBeUndefined();
		expect(reply.chunks).toHaveLength(1);
	});

	test("Substrate.searchDocs on LightRAG answers from the LightRAG fetch", async () => {
		const serving = lightragServing("Served by LightRAG.");
		const substrate = new Substrate(
			loadConfig({ LIGHTRAG_URL: "http://lightrag.test", LIGHTRAG_API_KEY: "k", SUBSTRATE_DOCS_BACKEND: "lightrag" }),
			{ index: null, greptime: null, lightragFetch: serving.fetch },
		);
		const reply = await substrate.searchDocs({ question: "where is the plan?" }, "omp");
		expect(reply.degraded).toBeUndefined();
		expect(reply.backend).toBe("lightrag");
		expect(reply.chunks.map((citation) => citation.snippet)).toEqual(["Served by LightRAG."]);
		expect(serving.queries).toHaveLength(1);
	});

	test("with the LightRAG breaker open, a LightRAG search is refused as lightrag circuit open and the LightRAG fake gets no call", async () => {
		const lightrag = lightragServing("Served by LightRAG.");
		const breaker = new CircuitBreaker("lightrag", { enabled: true, failureThreshold: 1, openMs: 60_000 });
		breaker.onFailure("lightrag unreachable");
		expect(breaker.state()).toBe("open");
		const reply = await searchDocs(
			{
				config: null,
				backend: "lightrag",
				lightragConfig: { url: "http://lightrag.test" },
				datasetNames: ["agent-substrate"],
				lightragFetch: lightrag.fetch,
				lightragBreakerState: () => breaker.state(),
				emit: async () => ({ stored: false }),
				surface: "omp",
			},
			"where is the plan?",
		);
		expect(reply.degraded).toBe(true);
		expect(reply.reason).toBe("lightrag circuit open");
		expect(reply.chunks).toHaveLength(0);
		expect(lightrag.queries).toHaveLength(0);
	});

	test("Substrate.searchDocs on the LightRAG backend is refused as lightrag circuit open while the LightRAG breaker is open, and LightRAG gets no call", async () => {
		const lightrag = lightragServing("Served by LightRAG.");
		const substrate = new Substrate(
			loadConfig({ LIGHTRAG_URL: "http://lightrag.test", LIGHTRAG_API_KEY: "k", SUBSTRATE_DOCS_BACKEND: "lightrag" }),
			{ index: null, greptime: null, lightragFetch: lightrag.fetch },
		);
		const lightragBreaker = substrate.planes.gate("lightrag").breaker;
		for (let failures = 0; failures < substrate.config.breaker.failureThreshold; failures += 1) lightragBreaker?.onFailure("lightrag unreachable");
		expect(lightragBreaker?.state()).toBe("open");
		const reply = await substrate.searchDocs({ question: "where is the plan?" }, "omp");
		expect(reply.degraded).toBe(true);
		expect(reply.reason).toBe("lightrag circuit open");
		expect(lightrag.queries).toHaveLength(0);
	});

	test("a LightRAG search the RAG machine refuses never reaches the LightRAG plane: Hindsight answers, or the degraded reply does", async () => {
		const lightrag = lightragServing("Served by LightRAG.");
		let recalled: DerivedMemoryHit[] = [{ bank: "sub-cursor", id: "mem-1", text: "The plan lives in PLAN.md.", derived: true, document_id: "mwd_1", tags: [], score: 0.8 }];
		const deps = {
			config: null,
			backend: "lightrag" as const,
			lightragConfig: { url: "http://lightrag.test" },
			datasetNames: ["agent-substrate"],
			lightragFetch: lightrag.fetch,
			lightragCooling: true,
			lightragHindsight: async () => recalled,
			emit: async () => ({ stored: false }),
			surface: "omp" as const,
		};
		const served = await searchDocs(deps, "where is the plan?");
		expect(served).toMatchObject({ backend: "hindsight", fallback: "hindsight", degraded: true, reason: "rag breaker open" });
		expect(served.chunks).toHaveLength(1);
		recalled = [];
		const degraded = await searchDocs(deps, "where is the plan?");
		expect(degraded).toMatchObject({ degraded: true, reason: "rag breaker open" });
		expect(degraded.backend).toBeUndefined();
		expect(lightrag.queries).toHaveLength(0);
	});

	test("docs ingest on the LightRAG backend is refused while the lightrag breaker is open, because ingest shares the LightRAG fetch and gate", async () => {
		const uploads: string[] = [];
		const lightragIngest: FetchLike = async (input, init) => {
			const url = new URL(String(input));
			if (init?.method === "POST" && url.pathname === "/documents/upload") {
				uploads.push(await ((init.body as FormData).get("file") as Blob).text());
				return Response.json({ status: "success", data: { track_id: `trk-${uploads.length}` } });
			}
			if (init?.method === "POST" && url.pathname === "/documents/scan") return Response.json({ status: "success" });
			if (url.pathname === "/documents/pipeline_status") return Response.json({ busy: false });
			if (url.pathname.startsWith("/documents/track_status/")) return Response.json({ documents: [{ id: `doc-${url.pathname.split("/").pop()}`, status: "processed" }], total_count: 1 });
			return Response.json({ detail: "no route" }, { status: 404 });
		};
		const seam = reposSeam(["agent-substrate"]);
		const substrate = new Substrate(loadConfig({ ...seam.env, LIGHTRAG_URL: "http://lightrag.test", SUBSTRATE_DOCS_BACKEND: "lightrag" }), { index: null, greptime: null, lightragFetch: lightragIngest, ...seam.stores });
		const lightrag = substrate.planes.gate("lightrag").breaker;
		for (let failures = 0; failures < substrate.config.breaker.failureThreshold; failures += 1) lightrag?.onFailure("lightrag 503");
		expect(lightrag?.state()).toBe("open");
		const outcome = await substrate.ingestDocs(
			{ dataset: "agent-substrate", commit: "c1", pages: [{ path: "docs/plan.md", body: "# Plan\n\nThe planner reads the plan.", source_url: "https://example.com/plan" }] },
			"omp",
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toContain("lightrag circuit open");
		expect(uploads).toHaveLength(0);
	});
});

describe("LightRAG search retries and the Hindsight fallback", () => {
	const LIGHTRAG = { url: "http://lightrag.test" };
	/** Two retries on a 1 ms base: the backoff runs, and the tests stay quick. */
	const RETRY = { maxRetries: 2, retryBaseMs: 1 };
	const RECALLED: DerivedMemoryHit[] = [
		{ bank: "sub-cursor", id: "mem-1", text: "The plan lives in PLAN.md.", derived: true, document_id: "mwd_1", tags: [], score: 0.8 },
	];
	const NO_GRAPH = { mode: "hybrid" as const, counts: { entities: 0, relations: 0 }, provenance: { entities: [], relations: 0 } };

	test("a LightRAG retrieval that fails once is retried, and the retry's chunks are served, not degraded", async () => {
		let attempts = 0;
		const reply = await searchDocs(
			{
				config: null,
				backend: "lightrag",
				lightragConfig: LIGHTRAG,
				datasetNames: ["agent-substrate"],
				lightragRetry: RETRY,
				lightragRetrieve: async () => {
					attempts += 1;
					if (attempts === 1) return { ok: false, reason: "lightrag 503" };
					return {
						ok: true,
						chunks: [{ content: "The planner reads the plan.", document_name: "plan.md", document_id: "doc-1", heading_path: "Plan", score: 0.9 }],
						detail: NO_GRAPH,
					};
				},
				emit: async () => ({ stored: false }),
				surface: "omp",
			},
			"where is the plan?",
		);
		expect(attempts).toBe(2);
		expect(reply.degraded).toBeUndefined();
		expect(reply.fallback).toBeUndefined();
		expect(reply.backend).toBe("lightrag");
		expect(reply.chunks.map((citation) => citation.snippet)).toEqual(["The planner reads the plan."]);
	});

	test("a LightRAG search that fails every attempt is answered from Hindsight: degraded, fallback hindsight, the LightRAG failure as the reason", async () => {
		let attempts = 0;
		const asked: string[] = [];
		const events: EventInput[] = [];
		const reply = await searchDocs(
			{
				config: null,
				backend: "lightrag",
				lightragConfig: LIGHTRAG,
				datasetNames: ["agent-substrate"],
				lightragRetry: RETRY,
				lightragRetrieve: async () => {
					attempts += 1;
					return { ok: false, reason: "lightrag 503" };
				},
				lightragHindsight: async (question) => {
					asked.push(question);
					return RECALLED;
				},
				emit: async (event) => {
					events.push(event);
					return { stored: false };
				},
				surface: "omp",
			},
			"where is the plan?",
		);
		expect(attempts).toBe(RETRY.maxRetries + 1);
		expect(asked).toEqual(["where is the plan?"]);
		expect(reply).toMatchObject({ degraded: true, backend: "hindsight", fallback: "hindsight", reason: "lightrag 503" });
		expect(reply.chunks).toHaveLength(1);
		expect(reply.chunks[0]).toMatchObject({
			source_url: "hindsight:sub-cursor/mwd_1",
			snippet: "The plan lives in PLAN.md.",
			commit: "dataset-pin:hindsight:unrecorded",
		});
		expect(events.map((event) => event.summary)).toEqual(["docs search failed: lightrag 503"]);
	});

	test("a LightRAG retry's backoff runs under the search budget: an expired budget ends the retries after the one attempt made, not after the full backoff", async () => {
		let attempts = 0;
		const started = performance.now();
		const reply = await searchDocs(
			{
				config: null,
				backend: "lightrag",
				lightragConfig: LIGHTRAG,
				datasetNames: ["agent-substrate"],
				lightragRetry: { maxRetries: 2, retryBaseMs: 5000 },
				budgetMs: 50,
				lightragRetrieve: async () => {
					attempts += 1;
					return { ok: false, reason: "lightrag 503" };
				},
				emit: async () => ({ stored: false }),
				surface: "omp",
			},
			"where is the plan?",
		);
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(attempts).toBe(1);
		expect(reply).toMatchObject({ degraded: true, reason: "lightrag 503" });
	}, 20_000);

	test("a LightRAG search that fails and Hindsight answers nothing, throws, or is not wired is the degraded reply with the LightRAG reason", async () => {
		let attempts = 0;
		const search = (lightragHindsight?: (question: string) => Promise<readonly DerivedMemoryHit[]>): Promise<SearchReply> =>
			searchDocs(
				{
					config: null,
					backend: "lightrag",
					lightragConfig: LIGHTRAG,
					datasetNames: ["agent-substrate"],
					lightragRetry: RETRY,
					lightragRetrieve: async () => {
						attempts += 1;
						return { ok: false, reason: "lightrag 503" };
					},
					...(lightragHindsight !== undefined ? { lightragHindsight } : {}),
					emit: async () => ({ stored: false }),
					surface: "omp",
				},
				"where is the plan?",
			);
		const degraded: SearchReply = {
			chunks: [],
			untrusted: UNTRUSTED_DOCS_NOTICE,
			degraded: true,
			reason: "lightrag 503",
			degraded_datasets: [{ dataset: "agent-substrate", reason: "lightrag 503" }],
		};
		expect(await search(async () => [])).toEqual(degraded);
		expect(
			await search(async () => {
				throw new Error("hindsight down");
			}),
		).toEqual(degraded);
		expect(await search()).toEqual(degraded);
		expect(attempts).toBe(3 * (RETRY.maxRetries + 1));
	});

	test("Substrate.searchDocs answers from Hindsight once the LightRAG plane has failed its retries", async () => {
		const restore = hindsightEnv("sub-cursor");
		try {
			const hindsight = new HindsightFake();
			hindsight.seed("sub-cursor", [{ id: "m1", text: "the plan lives in PLAN.md", document_id: "mwd_1", tags: ["cursor"], metadata: {}, score: 0.9 }]);
			let queries = 0;
			const lightragDown: FetchLike = async (input, init) => {
				const url = new URL(String(input));
				if (init?.method !== "POST" || url.pathname !== "/query") return Response.json({ detail: "no route" }, { status: 404 });
				queries += 1;
				return new Response("unavailable", { status: 503 });
			};
			const substrate = new Substrate(
				loadConfig({
					LIGHTRAG_URL: "http://lightrag.test",
					LIGHTRAG_API_KEY: "k",
					SUBSTRATE_DOCS_BACKEND: "lightrag",
					SUBSTRATE_RAG_RETRY_BASE_MS: "1",
				}),
				{ index: null, greptime: null, lightragFetch: lightragDown, hindsightFetch: hindsight.fetch },
			);
			const reply = await substrate.searchDocs({ question: "where is the plan?" }, "cursor");
			expect(reply).toMatchObject({ degraded: true, backend: "hindsight", fallback: "hindsight" });
			expect(reply.reason).toMatch(/^lightrag/);
			expect(reply.chunks.map((citation) => citation.source_url)).toEqual(["hindsight:sub-cursor/mwd_1"]);
			expect(queries).toBeGreaterThan(1);
			expect(hindsight.recalls()).toHaveLength(1);
		} finally {
			restore();
		}
	});

	test("an unconfigured LightRAG plane is answered from Hindsight when recall finds something, else degraded with its reason", async () => {
		const deps = {
			config: null,
			backend: "lightrag" as const,
			lightragConfig: null,
			datasetNames: ["agent-substrate"],
			emit: async () => ({ stored: false }),
			surface: "omp" as const,
		};
		const served = await searchDocs({ ...deps, lightragHindsight: async () => RECALLED }, "where is the plan?");
		expect(served).toMatchObject({ degraded: true, backend: "hindsight", fallback: "hindsight", reason: "lightrag-not-configured" });
		expect(served.chunks.map((citation) => citation.source_url)).toEqual(["hindsight:sub-cursor/mwd_1"]);
		expect(searchReplyStorable(served)).toBe(false);
		const nothing = await searchDocs({ ...deps, lightragHindsight: async () => [] }, "where is the plan?");
		expect(nothing).toEqual({ chunks: [], untrusted: UNTRUSTED_DOCS_NOTICE, degraded: true, reason: "lightrag-not-configured" });
	});
});

describe("search graph metadata (LightRAG path)", () => {
	const HINTS = [
		{ phase: "25-lightrag", entities: ["Access path", "lightrag datasets"], relations: [{ source: "Access path", target: "lightrag datasets", kind: "links-to" }] },
	];

	/**
	 * Plants the two headings the graph tests hint against in every dataset,
	 * through the fake's own seed table. Serving seeds means nothing else
	 * is served, so each citation's heading is exactly the one planted here.
	 */
	function seedHeadings(fake: LightragFake): void {
		fake.serveUploadsAsChunks = true;
		for (const dataset of fake.datasets) {
			const sourceUrl = `https://example.com/${dataset.name}/graph`;
			fake.seeds.push(
				{ document_id: `doc-${dataset.id}-1`, content: "The substrate is the only door to the data planes.", source_url: sourceUrl, heading_path: "Access path", score: 0.91 },
				{ document_id: `doc-${dataset.id}-2`, content: "Callers cite the source, not the chunk.", source_url: sourceUrl, heading_path: "lightrag datasets", score: 0.83 },
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
		const fake = new LightragFake();
		seedHeadings(fake);
		const events: EventInput[] = [];
		const reply = await searchDocs(
			{
				config: CONFIG,
				backend: "lightrag",
				lightragConfig: LIGHTRAG_CONFIG,
				lightragFetch: fake.fetch,
				lightragDatasets: { list: async () => ({ ok: true, datasets: fake.datasets.map((dataset) => ({ id: dataset.id, name: dataset.name })) }), invalidate: () => undefined },
				lightragRetry: { maxRetries: 0, retryBaseMs: 1 },
				datasetNames: FAKE_DATASETS,
				emit: async (event) => {
					events.push(event);
					return { stored: false };
				},
				graphHints: HINTS,
			},
			"who reads lightrag?",
		);
		expect(reply.degraded).toBeUndefined();
		expect(reply.graph).toEqual({ entities: 2, relations: 1 });
		// Both seed headings are hinted, so every citation carries graph
		// metadata; the relation count rides the source heading only.
		for (const citation of reply.chunks) {
			expect(citation.graph?.entities).toEqual([citation.heading_path]);
		}
		const access = reply.chunks.filter((citation) => citation.heading_path === "Access path");
		const datasets = reply.chunks.filter((citation) => citation.heading_path === "lightrag datasets");
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

	test("a search without graph hints serves the pure lightrag reply: no graph, no citation graph", async () => {
		const fake = new LightragFake();
		const reply = await searchDocs({ config: CONFIG, backend: "lightrag", lightragConfig: LIGHTRAG_CONFIG, lightragFetch: fake.fetch, lightragDatasets: { list: async () => ({ ok: true, datasets: fake.datasets.map((dataset) => ({ id: dataset.id, name: dataset.name })) }), invalidate: () => undefined }, lightragRetry: { maxRetries: 0, retryBaseMs: 1 }, emit: async () => ({ stored: false }), datasetNames: FAKE_DATASETS }, "who reads lightrag?");
		expect(reply.graph).toBeUndefined();
		expect(reply.chunks.length).toBeGreaterThan(0);
		expect(reply.chunks.every((citation) => citation.graph === undefined)).toBe(true);
	});

	test("an unhinted heading stays graph-free while its hinted sibling is named", async () => {
		const fake = new LightragFake();
		seedHeadings(fake);
		const reply = await searchDocs(
			{
				config: CONFIG,
				backend: "lightrag",
				lightragConfig: LIGHTRAG_CONFIG,
				lightragFetch: fake.fetch,
				lightragDatasets: { list: async () => ({ ok: true, datasets: fake.datasets.map((dataset) => ({ id: dataset.id, name: dataset.name })) }), invalidate: () => undefined },
				lightragRetry: { maxRetries: 0, retryBaseMs: 1 },
				datasetNames: FAKE_DATASETS,
				emit: async () => ({ stored: false }),
				graphHints: [{ phase: "25-lightrag", entities: ["Access path"], relations: [] }],
			},
			"who reads lightrag?",
		);
		expect(reply.graph).toEqual({ entities: 1, relations: 0 });
		const access = reply.chunks.filter((citation) => citation.heading_path === "Access path");
		const datasets = reply.chunks.filter((citation) => citation.heading_path === "lightrag datasets");
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
		expect(offline.retrievedDatasetIds).toContain("ds-berlin-agent-substrate");
		expect(offline.reply.chunks).toHaveLength(1);
		expect(offline.reply.chunks[0]?.heading_path).toBe("Planning graph");
		expect(offline.reply.untrusted).toBe(UNTRUSTED_DOCS_NOTICE);
		expect(offline.reply.graph).toBeUndefined();
		// Same corpus through the LightRAG-shaped call: the heading the hint
		// names carries graph metadata, and the reply reports the coverage.
		const hinted = await searchDocs(
			{
				config: { url: "http://lightrag.test", apiKey: "golden" },
				backend: "lightrag",
				lightragConfig: { url: "http://lightrag.test", apiKey: "golden" },
				lightragRetrieve: async () => ({
					ok: true as const,
					chunks: [{ content: "The lightrag backend serves planning relations.", document_name: "planning-graph.md", document_id: "doc-planning-graph", heading_path: "Planning graph", score: 0.9 }],
					detail: { mode: "hybrid" as const, counts: { entities: 0, relations: 0 }, provenance: { entities: [], relations: 0 } },
				}),
				datasetNames: ["agent-substrate"],
				emit: async () => ({ stored: false }),
				surface: "omp",
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

	test("LightRAG search never consults the lightrag dataset list", async () => {
		let lightragListings = 0;
		const reply = await searchDocs(
			{
				config: { url: "http://lightrag.test", apiKey: "test-key" },
				backend: "lightrag",
				lightragConfig: { url: "http://lightrag.test" },
				datasetNames: ["agent-substrate"],
				datasets: {
					list: async () => {
						lightragListings += 1;
						return { ok: false, reason: "lightrag-unreachable" };
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
		expect(lightragListings).toBe(0);
		expect(reply.degraded ?? false).toBe(false);
		expect(reply.chunks).toHaveLength(1);
	});
});

describe("LightRAG citations are attributed per dataset (P2-6)", () => {
	const SUBSTRATE_URL = "file:///checkout/agent-substrate/docs/plan.md";
	const SKILLS_URL = "file:///checkout/agent-skills/demo-skill/SKILL.md";
	const ORPHAN_URL = "file:///checkout/agent-substrate/docs/orphan.md";
	/**
	 * One LightRAG knowledge base holds both datasets. Each dataset's document sits under its own `lightrag::` record, keyed by
	 * the identity the ingest writes. The orphan lightrag record (no `lightrag::` prefix) names a document, never a LightRAG dataset.
	 */
	const records = new Map<string, IngestRecord>([
		[
			`lightrag::swcstudiospace/agent-substrate::${SUBSTRATE_URL}`,
			{ sha: "sha-substrate", dataset_id: "swcstudiospace/agent-substrate", source_url: SUBSTRATE_URL, document_id: "doc-substrate", commit: "sub-doc", version: 1 },
		],
		[
			`lightrag::swcstudiospace/agent-skills::${SKILLS_URL}`,
			{ sha: "sha-skills", dataset_id: "swcstudiospace/agent-skills", source_url: SKILLS_URL, document_id: "doc-skills", commit: "skills-doc", version: 1 },
		],
		[`agent-substrate::${ORPHAN_URL}`, { sha: "sha-orphan", dataset_id: "agent-substrate", source_url: ORPHAN_URL, document_id: "doc-lightrag", commit: "lightrag-doc", version: 1 }],
	]);
	const pins: Record<string, DatasetPin> = {
		"agent-substrate": { dataset: "agent-substrate", dataset_id: "agent-substrate", version: "v3", commit: "sub-pin", ingested_at: "2026-11-01T00:00:00.000Z" },
		"agent-skills": { dataset: "agent-skills", dataset_id: "agent-skills", version: "v7", commit: "skills-pin", ingested_at: "2026-11-01T00:00:00.000Z" },
	};
	/** A LightRAG search answering one chunk per document id, scored in the order given. */
	const search = (documentIds: string[], datasetNames: string[]) =>
		searchDocs(
			{
				config: { url: "http://lightrag.test", apiKey: "test-key" },
				backend: "lightrag",
				lightragConfig: { url: "http://lightrag.test" },
				datasetNames,
				pins,
				lightragRecords: records,
				provenanceOf: (documentId) => documentProvenance(records, documentId),
				lightragRetrieve: async () => ({
					ok: true,
					chunks: documentIds.map((document_id, index) => ({ content: `chunk from ${document_id}`, document_name: `${document_id}.md`, document_id, heading_path: "H", score: 0.9 - index * 0.1 })),
					detail: { mode: "hybrid", counts: { entities: 0, relations: 0 }, provenance: { entities: [], relations: 0 } },
				}),
				emit: async () => ({ stored: false }),
				surface: "omp",
			},
			"where is the plan?",
		);

	test("each chunk carries its own dataset's pin and its own record's commit", async () => {
		const reply = await search(["doc-substrate", "doc-skills"], ["agent-substrate", "agent-skills"]);
		expect(reply.backend).toBe("lightrag");
		expect(reply.chunks.find((chunk) => chunk.document_id === "doc-substrate")).toMatchObject({ source_url: SUBSTRATE_URL, commit: "sub-doc", dataset_commit: "sub-pin" });
		expect(reply.chunks.find((chunk) => chunk.document_id === "doc-skills")).toMatchObject({ source_url: SKILLS_URL, commit: "skills-doc", dataset_commit: "skills-pin" });
	});

	test("a chunk no LightRAG record names is unattributed and cites no dataset's pin; a lightrag record names none", async () => {
		const reply = await search(["doc-lightrag", "doc-nowhere"], ["agent-substrate", "agent-skills"]);
		const orphan = reply.chunks.find((chunk) => chunk.document_id === "doc-lightrag");
		expect(orphan).toMatchObject({ source_url: ORPHAN_URL, commit: "lightrag-doc" });
		expect(orphan?.dataset_commit).toBeUndefined();
		const nowhere = reply.chunks.find((chunk) => chunk.document_id === "doc-nowhere");
		expect(nowhere).toMatchObject({ source_url: "dataset:unattributed", commit: "dataset-pin:unattributed:unrecorded" });
		expect(nowhere?.dataset_commit).toBeUndefined();
	});

	test("a superseded LightRAG document is still attributed to the dataset its record is keyed under", () => {
		const superseded = new Map<string, IngestRecord>([
			[
				`lightrag::swcstudiospace/agent-skills::${SKILLS_URL}`,
				{ sha: "sha-skills-v2", dataset_id: "swcstudiospace/agent-skills", source_url: SKILLS_URL, document_id: "doc-skills-v2", commit: "skills-v2", superseded: [{ document_id: "doc-skills", commit: "skills-doc" }], version: 2 },
			],
		]);
		expect(lightragDocumentDataset(superseded, "doc-skills")).toBe("swcstudiospace/agent-skills");
		expect(lightragDocumentDataset(superseded, "doc-lightrag")).toBeUndefined();
	});
});

describe("docs_search after an agent-skills refresh (phase 42)", () => {
	/** A checkout in the library layout: each `<name>/` holds its `SKILL.md` and a `references/` tree. */
	function skillsCheckout(files: Record<string, string>): string {
		const root = mkdtempSync(join(tmpdir(), "substrate-skills-"));
		for (const [path, body] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), body);
		}
		return root;
	}

	/**
	 * The refresh the merge-trigger route runs for agent-skills: the trigger is noted, then the job runs and is awaited.
	 * `io` is the file system the scan reads through; a test passes one that cannot read a path.
	 */
	function refresh(substrate: Substrate, checkout: string, commit: string, io: ScanIo = nodeIo) {
		substrate.noteDocsTrigger("agent-skills");
		return substrate.startDocsRefresh(
			{
				dataset: "agent-skills",
				commit,
				content_sha256: `sha-${commit}`,
				roots: () => skillsCheckoutRoots(checkout),
				pages: (roots) => readSkillsCheckoutPages(checkout, roots, io),
			},
			"omp",
			{ wait: true },
		);
	}

	test("docs_search answers from the new agent-skills version after the refresh", async () => {
		const fake = new LightragFake();
		fake.serveUploadsAsChunks = true;
		fake.parseDonePolls = 1;
		const checkout = skillsCheckout({
			"demo-skill/SKILL.md": "---\nname: demo-skill\n---\nDemo skill body.\n",
			"demo-skill/references/api.md": "The demo API reference.\n",
		});
		try {
			const substrate = new Substrate(loadConfig({ LIGHTRAG_URL: "http://lightrag.test", LIGHTRAG_API_KEY: "k" }), { index: null, greptime: null, lightragFetch: fake.fetch });
			const outcome = await refresh(substrate, checkout, "skills-v2");
			expect(outcome.status).toBe(200);
			const reply = await substrate.searchDocs({ question: "demo API reference" }, "omp");
			const cited = reply.chunks.filter((chunk) => chunk.source_url.endsWith("/demo-skill/references/api.md"));
			expect(cited).toHaveLength(1);
			expect(cited[0]).toMatchObject({ commit: "skills-v2", dataset_commit: "skills-v2" });
			expect(cited[0]?.pin_age_ms).toBeUndefined();
			expect(reply.chunks.some((chunk) => chunk.source_url.endsWith("/demo-skill/SKILL.md"))).toBe(true);
		} finally {
			rmSync(checkout, { recursive: true, force: true });
		}
	});

	test("a checkout that cannot be read keeps the pinned version serving, with its age", async () => {
		const fake = new LightragFake();
		fake.serveUploadsAsChunks = true;
		fake.parseDonePolls = 1;
		const checkout = skillsCheckout({ "demo-skill/SKILL.md": "Demo skill body.\n" });
		try {
			const substrate = new Substrate(loadConfig({ LIGHTRAG_URL: "http://lightrag.test", LIGHTRAG_API_KEY: "k" }), { index: null, greptime: null, lightragFetch: fake.fetch });
			expect((await refresh(substrate, checkout, "skills-v1")).status).toBe(200);
			rmSync(checkout, { recursive: true, force: true });
			const failed = await refresh(substrate, checkout, "skills-v2");
			expect(failed.status).toBe(503);
			expect(failed.body).toMatchObject({ ok: false, reason: "checkout-unreadable" });
			const reply = await substrate.searchDocs({ question: "demo skill" }, "omp");
			const cited = reply.chunks.find((chunk) => chunk.source_url.endsWith("/demo-skill/SKILL.md"));
			expect(cited).toMatchObject({ commit: "skills-v1", dataset_commit: "skills-v1" });
			expect(typeof cited?.pin_age_ms).toBe("number");
		} finally {
			rmSync(checkout, { recursive: true, force: true });
		}
	});

	test("an unreadable references directory fails the refresh: the pinned version keeps serving and no version is recorded", async () => {
		const fake = new LightragFake();
		fake.serveUploadsAsChunks = true;
		fake.parseDonePolls = 1;
		const checkout = skillsCheckout({
			"demo-skill/SKILL.md": "Demo skill body.\n",
			"demo-skill/references/api.md": "The demo API reference.\n",
		});
		try {
			const substrate = new Substrate(loadConfig({ LIGHTRAG_URL: "http://lightrag.test", LIGHTRAG_API_KEY: "k" }), { index: null, greptime: null, lightragFetch: fake.fetch });
			expect((await refresh(substrate, checkout, "skills-v1")).status).toBe(200);
			// The references tree exists but its listing is denied: the scan fails rather than yielding SKILL.md alone under a fresh version.
			const unreadable: ScanIo = {
				...nodeIo,
				readdir: (path, options) => (path.endsWith(join("demo-skill", "references")) ? Promise.reject(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })) : nodeIo.readdir(path, options)),
			};
			const failed = await refresh(substrate, checkout, "skills-v2", unreadable);
			expect(failed.status).toBe(503);
			expect(failed.body).toMatchObject({ ok: false, reason: "checkout-unreadable" });
			expect(await substrate.latestDocsVersion("agent-skills")).toMatchObject({ commit: "skills-v1" });
			const reply = await substrate.searchDocs({ question: "demo API reference" }, "omp");
			const cited = reply.chunks.find((chunk) => chunk.source_url.endsWith("/demo-skill/references/api.md"));
			expect(cited).toMatchObject({ commit: "skills-v1", dataset_commit: "skills-v1" });
		} finally {
			rmSync(checkout, { recursive: true, force: true });
		}
	});

	/**
	 * Skills whose references outweigh one ingest call's 5 MB: `count` skills, each a small SKILL.md and a 900 KB
	 * reference, so every page is under the 1 MB page limit. A reference's content starts with its skill's name.
	 */
	function wideSkills(count: number): Record<string, string> {
		const files: Record<string, string> = {};
		for (let n = 1; n <= count; n += 1) {
			files[`skill-${n}/SKILL.md`] = `---\nname: skill-${n}\n---\nSkill ${n} body.\n`;
			files[`skill-${n}/references/api.md`] = `skill-${n} reference ${"x".repeat(900_000)}\n`;
		}
		return files;
	}

	test("a checkout whose references exceed one call's 5 MB refreshes in several calls and records the version", async () => {
		const fake = new LightragFake();
		fake.serveUploadsAsChunks = true;
		fake.parseDonePolls = 1;
		const checkout = skillsCheckout(wideSkills(6));
		try {
			const substrate = new Substrate(loadConfig({ LIGHTRAG_URL: "http://lightrag.test", LIGHTRAG_API_KEY: "k" }), { index: null, greptime: null, lightragFetch: fake.fetch });
			const outcome = await refresh(substrate, checkout, "skills-wide");
			expect(outcome.status).toBe(200);
			expect(await substrate.latestDocsVersion("agent-skills")).toMatchObject({ commit: "skills-wide" });
			// Twelve pages (a SKILL.md and a reference each) reached the plane, and together they outweigh one call's limit.
			expect(fake.uploads).toHaveLength(12);
			expect(fake.uploads.reduce((sum, upload) => sum + upload.content.length, 0)).toBeGreaterThan(5_000_000);
		} finally {
			rmSync(checkout, { recursive: true, force: true });
		}
	});

	test("a refresh whose later call fails keeps the prior pin, and the earlier call's pages are reported as stored", async () => {
		const fake = new LightragFake();
		fake.serveUploadsAsChunks = true;
		fake.parseDonePolls = 1;
		const prior = skillsCheckout({ "skill-1/SKILL.md": "Skill one body v1.\n" });
		const wide = skillsCheckout(wideSkills(6));
		try {
			const substrate = new Substrate(loadConfig({ LIGHTRAG_URL: "http://lightrag.test", LIGHTRAG_API_KEY: "k" }), { index: null, greptime: null, lightragFetch: fake.fetch });
			expect((await refresh(substrate, prior, "skills-v1")).status).toBe(200);
			// The plane refuses the last skill's reference. It sits in the second call, so the first call has already stored its pages.
			fake.failUploadWhen = (content) => content.startsWith("skill-6 reference");
			const failed = await refresh(substrate, wide, "skills-v2");
			expect(failed.status).toBe(503);
			expect(failed.body).toMatchObject({ ok: false, stored: true });
			expect(failed.body).not.toMatchObject({ reason: "call-too-large" });
			// No version is recorded for the failed refresh: the pin keeps the prior version.
			expect(await substrate.latestDocsVersion("agent-skills")).toMatchObject({ version: "v1", commit: "skills-v1" });
			// The first call's page is searchable under its own commit while the dataset pin still names the prior one.
			const reply = await substrate.searchDocs({ question: "skill one reference" }, "omp");
			const stored = reply.chunks.find((chunk) => chunk.source_url.endsWith("/skill-1/references/api.md"));
			expect(stored).toMatchObject({ commit: "skills-v2", dataset_commit: "skills-v1" });
			expect(typeof stored?.pin_age_ms).toBe("number");
		} finally {
			rmSync(prior, { recursive: true, force: true });
			rmSync(wide, { recursive: true, force: true });
		}
	});
});

/** Point the Hindsight reads at the fake: recall reads the environment at call time. */
function hindsightEnv(banks: string): () => void {
	const names = ["HINDSIGHT_URL", "HINDSIGHT_API_KEY", "HINDSIGHT_BANKS"];
	const saved = new Map(names.map((name) => [name, process.env[name]]));
	process.env.HINDSIGHT_URL = "http://fake";
	process.env.HINDSIGHT_API_KEY = "test-bearer";
	process.env.HINDSIGHT_BANKS = banks;
	return () => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
}

/**
 * A ledger seam answering the reads a docs search reaches, recording the
 * session reads. A `failure` makes every read reject with that message.
 */
function ledgerStub(rows: Array<Record<string, unknown>>, failure?: string): { greptime: GreptimeClient; reads: Array<[string, string]> } {
	const reads: Array<[string, string]> = [];
	const stub = {
		ensureAppendMode: async () => true,
		lastHash: async (): Promise<string | null> => null,
		insertEvent: async () => {},
		readEvents: async (column: "session_id" | "graph_id", value: string) => {
			reads.push([column, value]);
			if (failure !== undefined) throw new Error(failure);
			return rows;
		},
	};
	// The seam takes the full client; these tests reach only the four methods the stub implements.
	const greptime: GreptimeClient = stub as never;
	return { greptime, reads };
}

/** Seven rows in time order, one second apart, all in session `s-1`. */
function sessionRows(count: number): Array<Record<string, unknown>> {
	return Array.from({ length: count }, (_, index) => ({
		id: `evt-${index}`,
		ts: 1_700_000_000_000 + index * 1000,
		kind: "note",
		surface: "cursor",
		summary: `event ${index}`,
		session_id: "s-1",
	}));
}

describe("docs_search context uses issued live authority", () => {
	let restoreEnv: () => void = () => {};
	beforeEach(() => { restoreEnv = hindsightEnv("sub-cursor"); });
	afterEach(() => { restoreEnv(); });

	function recallable() {
		const hindsight = new HindsightFake();
		hindsight.seed("sub-cursor", [
			{ id: "m1", text: "fence the lease", document_id: "mwd_1", tags: ["cursor"], metadata: {}, score: 0.4 },
			{ id: "m2", text: "quote every version", document_id: "mwd_2", tags: ["cursor"], metadata: {}, score: 0.9 },
			{ id: "m3", text: "rotate the bearer", document_id: "mwd_3", tags: ["cursor"], metadata: {}, score: 0.7 },
			{ id: "m4", text: "drain the outbox", document_id: "mwd_4", tags: ["cursor"], metadata: {}, score: 0.8 },
		]);
		return hindsight;
	}

	async function contextRig(_backend: "lightrag", options: { failure?: string; hang?: boolean; cache?: ReadThroughCache; hindsight?: HindsightFake; budgetMs?: number } = {}) {
		const hindsight = options.hindsight ?? recallable();
		const authority = createTestLiveSessionAuthority();
		const caller = { surface: "cursor", isOperator: false } as const;
		const session = await issueLiveSession(authority, { caller, steering: "PRIVATE-CONTEXT-DIRECTION", planningHash: "PRIVATE-CONTEXT-HASH" });
		const rows = sessionRows(7).map((row) => ({ ...row, session_id: session.sessionId }));
		const { greptime, reads } = ledgerStub([
			...rows,
			{ ...rows[0], id: "foreign-surface-row", surface: "hermes" },
			{ ...rows[0], id: "historical-row", session_id: "historical-label" },
		], options.failure);
		if (options.hang) Object.assign(greptime, { readEvents: () => new Promise<never>(() => {}) });
		const queries: string[] = [];
		const config = loadConfig({
			LIGHTRAG_URL: "http://lightrag.test", LIGHTRAG_API_KEY: "k",
			...(options.budgetMs === undefined ? {} : { HINDSIGHT_SEARCH_RECALL_BUDGET_MS: String(options.budgetMs) }),
		});
		const observability = createObservability(config, {});
		const batches: McpToolCall[][] = [];
		const substrate = new Substrate(config, {
			index: null, greptime, hindsightFetch: hindsight.fetch,
			lightragFetch: async (_input, init) => {
				queries.push(String(init?.body));
				return Response.json({ status: "success", data: { chunks: [{ content: "The planner reads the plan.", document_name: "plan.md", document_id: "doc-lightrag", heading_path: "Plan", score: 0.9 }] } });
			},
			cache: options.cache ?? new ReadThroughCache({ redis: null, enabled: false, log: () => {} }),
			steering: { history: null, liveSessions: authority },
		}, observability.observer, { auditCalls: (principal, calls, transport) => {
			batches.push(calls);
			return auditToolCalls(observability, principal.surface, calls, transport);
		} });
		const input = { question: "who reads lightrag?", session_id: "historical-label", steering_session_id: session.sessionId, context: true };
		const live = { caller, sessionBinding: session.sessionBinding };
		return { substrate, session, authority, caller, input, live, reads, hindsight, queries, batches };
	}

	for (const backend of ["lightrag", "lightrag"] as const) describe(backend, () => {
		test("proved context keeps the best three memories and last five exact-owner/live ledger rows", async () => {
			const h = await contextRig(backend);
			const reply = await h.substrate.searchDocs(h.input, h.caller.surface, h.live);
			expect(reply.degraded).toBeUndefined();
			expect(reply.chunks.length).toBeGreaterThan(0);
			expect(reply.context?.untrusted).toBe(UNTRUSTED_DOCS_NOTICE);
			expect(reply.context?.degraded).toBeUndefined();
			expect(reply.context?.memories.map((memory) => memory.id)).toEqual(["m2", "m4", "m3"]);
			expect(reply.context?.memories[0]).toEqual({ id: "m2", text: "quote every version", scope: null, repo: null });
			expect(reply.context?.events.map((event) => event.id)).toEqual(["evt-2", "evt-3", "evt-4", "evt-5", "evt-6"]);
			expect(reply.context?.events[0]).toEqual({ id: "evt-2", ts: new Date(1_700_000_002_000).toISOString(), kind: "note", surface: "cursor", summary: "event 2" });
			expect(h.reads).toEqual([["session_id", h.session.sessionId]]);
			expect(h.batches).toHaveLength(1);
			expect(JSON.stringify(reply)).not.toContain(h.session.sessionBinding);
			if (backend === "lightrag") {
				expect(reply.backend).toBe("lightrag");
				expect(reply.chunks.map((citation) => citation.snippet)).toEqual(["The planner reads the plan."]);
				expect(h.queries).toHaveLength(1);
				expect(JSON.parse(h.queries[0] ?? "{}").mode).toBe("hybrid");
			}
		});

		for (const context of [undefined, false]) test(`context=${context} starts neither recall nor ledger`, async () => {
			const h = await contextRig(backend);
			const reply = await h.substrate.searchDocs({ question: h.input.question, session_id: h.input.session_id, ...(context === undefined ? {} : { context }) }, h.caller.surface);
			expect(reply.chunks.length).toBeGreaterThan(0);
			expect(reply).not.toHaveProperty("context");
			expect(h.hindsight.recalls()).toEqual([]);
			expect(h.reads).toEqual([]);
			expect(h.batches).toEqual([]);
		});

		test("historical attribution alone recalls public context but never reads a private ledger", async () => {
			const h = await contextRig(backend);
			for (const session_id of [undefined, h.session.sessionId, "s".repeat(600)]) {
				const reply = await h.substrate.searchDocs({ question: h.input.question, session_id, context: true }, h.caller.surface);
				expect(reply.context?.events).toEqual([]);
				expect(reply.context?.degraded).toBe("no-session");
				expect(reply.context?.memories).toHaveLength(3);
			}
			expect(h.reads).toEqual([]);
		});

		test("recall failure retains chunks and live events while naming degradation", async () => {
			const hindsight = recallable(); hindsight.failRecallWith = 503;
			const h = await contextRig(backend, { hindsight });
			const reply = await h.substrate.searchDocs(h.input, h.caller.surface, h.live);
			expect(reply.degraded).toBeUndefined();
			expect(reply.chunks.length).toBeGreaterThan(0);
			expect(reply.context?.memories).toEqual([]);
			expect(reply.context?.degraded).toStartWith("recall: hindsight recall failed");
			expect(reply.context?.events).toHaveLength(5);
		});

		test("ledger failure retains chunks and memories and names unavailable ledger", async () => {
			const h = await contextRig(backend, { failure: "greptime unreachable" });
			const reply = await h.substrate.searchDocs(h.input, h.caller.surface, h.live);
			expect(reply.degraded).toBeUndefined();
			expect(reply.chunks.length).toBeGreaterThan(0);
			expect(reply.context?.memories).toHaveLength(3);
			expect(reply.context?.events).toEqual([]);
			expect(reply.context?.degraded).toBe("ledger: unavailable");
			expect(h.reads).toEqual([["session_id", h.session.sessionId]]);
		});

		test("a stalled ledger is cut at its budget, not a stalled answer", async () => {
			const h = await contextRig(backend, { hang: true });
			const started = performance.now();
			const reply = await h.substrate.searchDocs(h.input, h.caller.surface, h.live);
			expect(reply.chunks.length).toBeGreaterThan(0);
			expect(reply.context?.events).toEqual([]);
			expect(reply.context?.degraded).toContain("ledger");
			expect(performance.now() - started).toBeLessThan(3000);
		});

		test("private context and proof never enter shared cache; ordinary public search still caches chunks", async () => {
			const redis = new FakeRedis();
			const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
			const h = await contextRig(backend, { cache });
			const first = await h.substrate.searchDocs(h.input, h.caller.surface, h.live);
			const second = await h.substrate.searchDocs(h.input, h.caller.surface, h.live);
			expect(first.context?.memories).toHaveLength(3);
			expect(second.context?.events).toHaveLength(5);
			expect(searchReplyStorable(first)).toBe(false);
			expect([...redis.values.keys()].filter((key) => key.startsWith("substrate:v1:docs-search:"))).toEqual([]);
			expect(JSON.stringify([...redis.values])).not.toContain(h.session.sessionBinding);
			expect(JSON.stringify([...redis.values])).not.toContain("PRIVATE-CONTEXT");
			await h.substrate.searchDocs({ question: h.input.question }, h.caller.surface);
			const stored = [...redis.values].filter(([key]) => key.startsWith("substrate:v1:docs-search:"));
			expect(stored).toHaveLength(1);
			expect(JSON.parse(stored[0]?.[1] ?? "{}").v).not.toHaveProperty("context");
		});

		test("MCP forwards the separate historical label, live selector and proof", async () => {
			const h = await contextRig(backend);
			const server = createMcpServer(h.substrate, h.caller);
			const client = new Client({ name: "substrate-context-test", version: "0.0.0" });
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
			try {
				const result = await client.callTool({ name: "docs_search", arguments: { ...h.input, session_binding: h.session.sessionBinding } });
				expect(result.isError).not.toBe(true);
				const content = result.content as Array<{ type: string; text?: string }>;
				const reply: { context?: { memories: unknown[]; events: unknown[] } } = JSON.parse(content[0]?.text ?? "{}");
				expect(reply.context?.memories).toHaveLength(3);
				expect(reply.context?.events).toHaveLength(5);
			} finally { await client.close(); await server.close(); }
		});

		test("anonymous historical context reads neither recall bank nor private ledger", async () => {
			const h = await contextRig(backend);
			const reply = await h.substrate.searchDocs({ question: h.input.question, session_id: h.session.sessionId, context: true }, null);
			expect(reply.chunks.length).toBeGreaterThan(0);
			expect(reply.context?.memories).toEqual([]);
			expect(reply.context?.events).toEqual([]);
			expect(reply.context?.degraded).toBe("recall: no recall bank for surface unattributed: configure HINDSIGHT_BANKS; no-session");
			expect(h.hindsight.recalls()).toEqual([]);
			expect(h.reads).toEqual([]);
		});

		test("unconfigured recall and empty recall preserve private event context distinctly", async () => {
			delete process.env.HINDSIGHT_URL;
			const unavailable = await contextRig(backend);
			const degraded = await unavailable.substrate.searchDocs(unavailable.input, unavailable.caller.surface, unavailable.live);
			expect(degraded.context?.memories).toEqual([]);
			expect(degraded.context?.degraded).toBe("recall: hindsight is not configured");
			expect(degraded.context?.events).toHaveLength(5);
			process.env.HINDSIGHT_URL = "http://fake";
			const hindsight = new HindsightFake(); hindsight.seed("sub-cursor", []);
			const empty = await contextRig(backend, { hindsight });
			const reply = await empty.substrate.searchDocs(empty.input, empty.caller.surface, empty.live);
			expect(reply.context?.memories).toEqual([]);
			expect(reply.context).not.toHaveProperty("degraded");
			expect(reply.context?.events).toHaveLength(5);
		});

		test("one deadline bounds recall without discarding live event context", async () => {
			const hindsight = recallable(); hindsight.recallDeafMs["sub-cursor"] = 2000;
			const h = await contextRig(backend, { hindsight, budgetMs: 200 });
			const started = performance.now();
			const reply = await h.substrate.searchDocs(h.input, h.caller.surface, h.live);
			expect(reply.chunks.length).toBeGreaterThan(0);
			expect(reply.context?.memories).toEqual([]);
			expect(reply.context?.degraded).toContain("recall deadline");
			expect(reply.context?.events).toHaveLength(5);
			expect(performance.now() - started).toBeLessThan(1200);
		});
	});
});

describe("docs_search tandem recall (phase 57c)", () => {
	const NO_GRAPH = { mode: "hybrid" as const, counts: { entities: 0, relations: 0 }, provenance: { entities: [], relations: 0 } };
	const LIGHTRAG_CHUNKS = [
		{ content: "The planner reads the plan.", document_name: "plan.md", document_id: "doc-1", source_url: "https://example.com/plan", score: 0.9 },
		{ content: "Briefs are cached per graph.", document_name: "brief.md", document_id: "doc-2", source_url: "https://example.com/brief", score: 0.5 },
	];
	const memoryHit = (n: number, extra: Partial<DerivedMemoryHit> = {}): DerivedMemoryHit => ({
		bank: "sub-cursor",
		id: `mem-${n}`,
		text: `Remembered fact ${n}.`,
		derived: true,
		document_id: `mwd_${n}`,
		tags: [],
		score: 0.9 - n / 10,
		...extra,
	});
	const ON = { enabled: true, hindsight_limit: 5, budget_ms: 1500 };

	function harness(over: {
		recall?: (question: string) => Promise<readonly DerivedMemoryHit[]>;
		tandem?: { enabled: boolean; hindsight_limit: number; budget_ms: number };
		chunks?: typeof LIGHTRAG_CHUNKS;
		failLightrag?: boolean;
	}) {
		const events: EventInput[] = [];
		const asked: string[] = [];
		const recall = over.recall;
		const run = (): Promise<SearchReply> =>
			searchDocs(
				{
					config: null,
					backend: "lightrag",
					lightragConfig: { url: "http://lightrag.test" },
					datasetNames: ["agent-substrate"],
					lightragRetry: { maxRetries: 0, retryBaseMs: 1 },
					lightragRetrieve: async () =>
						over.failLightrag === true ? { ok: false, reason: "lightrag 503" } : { ok: true, chunks: over.chunks ?? LIGHTRAG_CHUNKS, detail: NO_GRAPH },
					...(recall !== undefined
						? {
								lightragHindsight: (question: string) => {
									asked.push(question);
									return recall(question);
								},
							}
						: {}),
					...(over.tandem !== undefined ? { tandem: over.tandem } : {}),
					emit: async (event: EventInput) => {
						events.push(event);
						return { stored: false };
					},
					surface: "omp",
				},
				"where is the plan?",
			);
		return { run, events, asked };
	}

	test("LightRAG up and tandem on: Hindsight is asked too and merged with provenance, not degraded, never storable", async () => {
		const { run, events, asked } = harness({
			tandem: ON,
			recall: async () => [memoryHit(1, { graph_id: "g-1", session_id: "s-1", node_id: "n-1" }), memoryHit(2)],
		});
		const reply = await run();
		expect(asked).toEqual(["where is the plan?"]);
		expect(reply.degraded).toBeUndefined();
		expect(reply.fallback).toBeUndefined();
		expect(reply.backend).toBe("lightrag");
		expect(reply.tandem).toEqual({ lightrag: 2, hindsight: 2, deduplicated: 0, leg: "ok" });
		// Fused order: the two rank-1 items tie (hindsight first), then the two rank-2 items.
		expect(reply.chunks.map((citation) => citation.source_url)).toEqual([
			"hindsight:sub-cursor/mwd_1",
			"https://example.com/plan",
			"hindsight:sub-cursor/mwd_2",
			"https://example.com/brief",
		]);
		const [first, second] = reply.chunks;
		expect(first).toMatchObject({
			origin: "hindsight",
			derived: true,
			snippet: "Remembered fact 1.",
			provenance: { bank: "sub-cursor", document_id: "mwd_1", graph_id: "g-1", session_id: "s-1", node_id: "n-1" },
		});
		expect(second).toMatchObject({ origin: "lightrag", snippet: "The planner reads the plan.", document_id: "doc-1", provenance: { bank: "lightrag", document_id: "doc-1" } });
		expect(Object.hasOwn(second as object, "derived")).toBe(false);
		// A memory can be forgotten at any moment: a tandem reply is never stored or replayed.
		expect(searchReplyStorable(reply)).toBe(false);
		const note = events.find((event) => event.kind === "note");
		expect(note?.payload).toMatchObject({ action: "docs.search", backend: "lightrag", count: 4, tandem: { lightrag: 2, hindsight: 2, deduplicated: 0, leg: "ok" } });
		expect(events.filter((event) => event.kind === "warning")).toEqual([]);
	});

	test("a memory that repeats a chunk is deduplicated and counted in the note", async () => {
		const { run } = harness({ tandem: ON, recall: async () => [memoryHit(1, { text: "the planner   reads the PLAN." }), memoryHit(2)] });
		const reply = await run();
		expect(reply.tandem).toEqual({ lightrag: 2, hindsight: 1, deduplicated: 1, leg: "ok" });
		expect(reply.chunks).toHaveLength(3);
	});

	test("the Hindsight limit bounds the memories merged", async () => {
		const { run } = harness({ tandem: { ...ON, hindsight_limit: 2 }, recall: async () => [1, 2, 3, 4].map((n) => memoryHit(n)) });
		const reply = await run();
		expect(reply.tandem?.hindsight).toBe(2);
	});

	test("the merged list is capped at ten and keeps at least two memories", async () => {
		const many = Array.from({ length: 12 }, (_, i) => ({ content: `lightrag chunk ${i}`, document_name: `d${i}`, document_id: `doc-${i}`, source_url: `https://example.com/${i}`, score: 1 - i / 100 }));
		const { run } = harness({ tandem: ON, chunks: many as typeof LIGHTRAG_CHUNKS, recall: async () => [memoryHit(1), memoryHit(2), memoryHit(3)] });
		const reply = await run();
		expect(reply.chunks).toHaveLength(10);
		expect(reply.chunks.filter((citation) => citation.origin === "hindsight").length).toBeGreaterThanOrEqual(2);
		expect(reply.chunks.filter((citation) => citation.origin === "lightrag").length).toBeGreaterThanOrEqual(2);
	});

	test("tandem off, or absent: Hindsight is not asked, and the reply is the LightRAG reply, storable, with no tandem key", async () => {
		const baseline = await harness({ recall: async () => [memoryHit(1)] }).run();
		for (const tandem of [undefined, { ...ON, enabled: false }]) {
			const { run, asked } = harness({ ...(tandem !== undefined ? { tandem } : {}), recall: async () => [memoryHit(1)] });
			const reply = await run();
			expect(asked).toEqual([]);
			expect(Object.hasOwn(reply, "tandem")).toBe(false);
			expect(reply).toEqual(baseline);
			expect(reply.chunks.every((citation) => !Object.hasOwn(citation, "origin"))).toBe(true);
			expect(searchReplyStorable(reply)).toBe(true);
		}
		expect(baseline.chunks.map((citation) => citation.snippet)).toEqual(["The planner reads the plan.", "Briefs are cached per graph."]);
	});

	test("tandem on but no Hindsight reader wired: the plain LightRAG reply, no tandem key", async () => {
		const reply = await harness({ tandem: ON }).run();
		expect(Object.hasOwn(reply, "tandem")).toBe(false);
		expect(reply.chunks).toHaveLength(2);
		expect(searchReplyStorable(reply)).toBe(true);
	});

	test("a Hindsight failure is fail-open: the LightRAG chunks are served, not degraded, and the reply is still never storable", async () => {
		for (const recall of [
			async (): Promise<readonly DerivedMemoryHit[]> => {
				throw new Error("hindsight down");
			},
			(): Promise<readonly DerivedMemoryHit[]> => {
				throw new Error("sync throw");
			},
		]) {
			const { run, events } = harness({ tandem: ON, recall });
			const reply = await run();
			expect(reply.degraded).toBeUndefined();
			expect(reply.fallback).toBeUndefined();
			expect(reply.backend).toBe("lightrag");
			expect(reply.chunks.map((citation) => citation.snippet)).toEqual(["The planner reads the plan.", "Briefs are cached per graph."]);
			expect(reply.tandem).toEqual({ lightrag: 2, hindsight: 0, deduplicated: 0, leg: "failed" });
			expect(searchReplyStorable(reply)).toBe(false);
			expect(events.filter((event) => event.kind === "warning")).toEqual([]);
		}
	});

	test("a Hindsight leg that outlives its own budget is left out; the search does not wait for it", async () => {
		const { run } = harness({ tandem: { ...ON, budget_ms: 10 }, recall: () => new Promise<never>(() => {}) });
		const started = performance.now();
		const reply = await run();
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(reply.degraded).toBeUndefined();
		expect(reply.tandem).toEqual({ lightrag: 2, hindsight: 0, deduplicated: 0, leg: "timeout" });
		expect(reply.chunks).toHaveLength(2);
		expect(searchReplyStorable(reply)).toBe(false);
	});

	test("a breaker refusal or an empty recall (no hits) is an empty leg, not a failure of the reply", async () => {
		const reply = await harness({ tandem: ON, recall: async () => [] }).run();
		expect(reply.tandem).toEqual({ lightrag: 2, hindsight: 0, deduplicated: 0, leg: "empty" });
		expect(reply.degraded).toBeUndefined();
		expect(searchReplyStorable(reply)).toBe(false);
	});

	test("Hindsight is asked while LightRAG is still retrieving: LightRAG cannot answer until Hindsight has been called", async () => {
		const hindsightAsked = Promise.withResolvers<void>();
		const reply = await searchDocs(
			{
				config: null,
				backend: "lightrag",
				lightragConfig: { url: "http://lightrag.test" },
				datasetNames: ["agent-substrate"],
				lightragRetry: { maxRetries: 0, retryBaseMs: 1 },
				lightragRetrieve: async () => {
					// A sequential search would never call Hindsight until this returns: the test would time out.
					await hindsightAsked.promise;
					return { ok: true, chunks: LIGHTRAG_CHUNKS, detail: NO_GRAPH };
				},
				lightragHindsight: async () => {
					hindsightAsked.resolve();
					return [memoryHit(1)];
				},
				tandem: ON,
				emit: async () => ({ stored: false }),
				surface: "omp",
			},
			"where is the plan?",
		);
		expect(reply.tandem).toEqual({ lightrag: 2, hindsight: 1, deduplicated: 0, leg: "ok" });
	});

	test("LightRAG down with tandem on: the existing Hindsight fallback answers exactly as before, with no tandem note", async () => {
		const recall = async (): Promise<readonly DerivedMemoryHit[]> => [memoryHit(1)];
		const off = await harness({ failLightrag: true, recall }).run();
		const on = await harness({ failLightrag: true, recall, tandem: ON }).run();
		expect(on).toEqual(off);
		expect(on).toMatchObject({ degraded: true, backend: "hindsight", fallback: "hindsight", reason: "lightrag 503" });
		expect(Object.hasOwn(on, "tandem")).toBe(false);
		expect(on.chunks.map((citation) => citation.source_url)).toEqual(["hindsight:sub-cursor/mwd_1"]);
		expect(searchReplyStorable(on)).toBe(false);
	});
});

describe("LightRAG context replies are never cached (phase 46 SC1)", () => {
	let restoreEnv: () => void = () => {};
	beforeEach(() => {
		restoreEnv = hindsightEnv("sub-cursor");
	});
	afterEach(() => restoreEnv());

	/** A LightRAG `/query` stand-in: answers one chunk and counts every query it gets. */
	function lightragPlane(): { fetch: FetchLike; queries: () => number } {
		let queries = 0;
		const fetch: FetchLike = async (input, init) => {
			const url = new URL(String(input));
			if (init?.method !== "POST" || url.pathname !== "/query") return Response.json({ detail: "no route" }, { status: 404 });
			queries += 1;
			return Response.json({ status: "success", data: { chunks: [{ content: "Served by LightRAG.", document_name: "plan.md", document_id: "doc-lightrag", heading_path: "Plan", score: 0.9 }] } });
		};
		return { fetch, queries: () => queries };
	}

	function recallable(): HindsightFake {
		const hindsight = new HindsightFake();
		hindsight.seed("sub-cursor", [
			{ id: "m1", text: "fence the lease", document_id: "mwd_1", tags: ["cursor"], metadata: {}, score: 0.4 },
			{ id: "m2", text: "quote every version", document_id: "mwd_2", tags: ["cursor"], metadata: {}, score: 0.9 },
			{ id: "m3", text: "rotate the bearer", document_id: "mwd_3", tags: ["cursor"], metadata: {}, score: 0.7 },
			{ id: "m4", text: "drain the outbox", document_id: "mwd_4", tags: ["cursor"], metadata: {}, score: 0.8 },
		]);
		return hindsight;
	}

	test("a LightRAG context reply is never stored: the cache keeps the chunks, and a repeat recalls its own memories", async () => {
		const lightragConfig = loadConfig({ LIGHTRAG_URL: "http://lightrag.test", SUBSTRATE_DOCS_BACKEND: "lightrag" });
		const lightrag = lightragPlane();
		const redis = new FakeRedis();
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		const { greptime } = ledgerStub(sessionRows(7));
		const substrate = new Substrate(lightragConfig, {
			index: null,
			greptime,
			lightragFetch: lightrag.fetch,
			hindsightFetch: recallable().fetch,
			cache,
		});
		const request = { question: "where is the plan?", session_id: "s-1", context: true };
		const first = await substrate.searchDocs(request, "cursor");
		expect(first.context?.memories).toHaveLength(3);
		const stored = [...redis.values].filter(([key]) => key.startsWith("substrate:v1:docs-search:"));
		expect(stored).toHaveLength(1);
		const envelope: { v?: Record<string, unknown> } = JSON.parse(stored[0]?.[1] ?? "{}");
		expect(envelope.v).toBeDefined();
		expect(Object.hasOwn(envelope.v ?? {}, "context")).toBe(false);
		const second = await substrate.searchDocs(request, "cursor");
		expect(second.chunks).toEqual(first.chunks);
		expect(second.context?.memories).toHaveLength(3);
		expect(lightrag.queries()).toBe(1);
	});
});
