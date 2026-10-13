/**
 * uplift-2 R6: the RAGFlow docs plane speaks the documented HTTP API shapes
 * (the fake enforces them), versions and pins survive a restart through the
 * v2 state file, the dataset list and `docs_search` answers are cached and
 * invalidated by a refresh, superseded documents are pruned only behind the
 * flag, and `POST /docs/merge-trigger` answers 202 at once with the ingest
 * in the background (`?wait=1` keeps the synchronous answer).
 *
 * Everything here runs against `RagflowFake`; no network, no store. The
 * live proof stays operator-gated (Phase 25 G1–G4).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_TTL, DOCS_GENERATION_KEY, ReadThroughCache, type CacheRedis } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { DATASET_LIST_TTL_MS, DatasetListCache, createVersionStore, recordVersion, resolveDatasets, versionsFromJson, versionsToJson } from "./docs-datasets.ts";
import { ingestDocs, loadIngestRecords, saveIngestRecords, type IngestDeps, type IngestRecord } from "./docs-ingest.ts";
import { searchDocs } from "./docs-search.ts";
import { createObservability } from "./observe.ts";
import {
	DATASET_CHUNK_METHOD,
	DATASET_EMBEDDING_MODEL,
	DEFAULT_RETRIEVAL_KNOBS,
	createDataset,
	deleteDocuments,
	documentName,
	parseDocuments,
	pollParseStatus,
	retrieveChunks,
	uploadDocument,
	type FetchLike,
} from "./planes/ragflow.ts";
import { RagflowFake } from "./ragflow-fake.ts";
import { createHttpServer, type HttpServerOptions } from "./server.ts";
import { Substrate } from "./service.ts";
import type { EventInput } from "./types.ts";

const CONFIG = { url: "http://ragflow.test", apiKey: "test-key" };
const PAGE = { path: "docs/data-planes.md", source_url: "https://example.com/agent-substrate/data-planes", body: "The substrate is the only door." };
const UNIT_FILE = join(import.meta.dir, "../../../infra/vps/substrate-mcp.service");

function eventSink() {
	const events: EventInput[] = [];
	const emit = async (event: EventInput): Promise<unknown> => {
		events.push(event);
		return { stored: false };
	};
	return { events, emit };
}

/** A redis that remembers every command, so a generation bump is observable. */
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

function ingestHarness(fake: RagflowFake, over: Partial<IngestDeps> = {}) {
	const { events, emit } = eventSink();
	const seen = new Map<string, IngestRecord>();
	const lines: string[] = [];
	const deps: IngestDeps = {
		config: CONFIG,
		emit,
		surface: "omp",
		seen,
		poll: { intervalMs: 0 },
		fetchImpl: fake.fetch,
		log: (line) => lines.push(line),
		...over,
	};
	return { events, seen, lines, ingest: (pages: typeof PAGE[]) => ingestDocs(deps, { dataset: "agent-substrate", commit: "c1", pages }) };
}

describe("the client speaks the documented shapes (fake-enforced)", () => {
	test("upload is one multipart `file` part named from the page path, then a meta_fields PATCH", async () => {
		const fake = new RagflowFake();
		const uploaded = await uploadDocument(
			CONFIG,
			{ dataset_id: "ds-berlin-agent-substrate", name: documentName("docs/data-planes.md"), content: "body text", metadata: { source_url: "https://example.com/x", commit: "c1", heading_path: "" } },
			fake.fetch,
		);
		if (!uploaded.ok) throw new Error(`expected upload: ${uploaded.reason}`);
		expect(uploaded.document_id).toBe("doc-upload-1");
		const [post, patch] = fake.requests;
		expect(post?.method).toBe("POST");
		expect(post?.path).toBe("/api/v1/datasets/ds-berlin-agent-substrate/documents");
		expect(post?.body).toEqual({ multipart: { file: [{ name: "docs__data-planes.md", bytes: 9 }] } });
		expect(patch?.method).toBe("PATCH");
		expect(patch?.path).toBe("/api/v1/datasets/ds-berlin-agent-substrate/documents/doc-upload-1");
		expect(patch?.body).toEqual({ meta_fields: { source_url: "https://example.com/x", commit: "c1", heading_path: "" } });
		expect(fake.uploads[0]).toMatchObject({ name: "docs__data-planes.md", content: "body text", metadata: { source_url: "https://example.com/x" } });
		expect(fake.documents["doc-upload-1"]?.run).toBe("UNSTART");
	});

	test("the fake refuses the pre-R6 JSON upload body with the documented failure", async () => {
		const fake = new RagflowFake();
		const response = await fake.fetch("http://ragflow.test/api/v1/datasets/ds-berlin-agent-substrate/documents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ content: "x", metadata: {} }),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ code: 101, message: "No file part!" });
		const gone = await fake.fetch("http://ragflow.test/api/v1/documents/doc-1/parse");
		expect(gone.status).toBe(404);
	});

	test("a failed meta_fields PATCH deletes the orphan and is the upload's reason", async () => {
		const fake = new RagflowFake();
		fake.failMetaWith = 500;
		const uploaded = await uploadDocument(
			CONFIG,
			{ dataset_id: "ds-berlin-agent-substrate", name: "a.md", content: "x", metadata: { source_url: "u", commit: "c", heading_path: "" } },
			fake.fetch,
		);
		if (uploaded.ok) throw new Error("expected a reason");
		expect(uploaded.reason).toBe("ragflow meta_fields: ragflow 500");
		expect(fake.deleted).toEqual(["doc-upload-1"]);
	});

	test("parse is the chunks call with document_ids; the status poll reads `run` from list-by-id", async () => {
		const fake = new RagflowFake();
		const uploaded = await uploadDocument(CONFIG, { dataset_id: "ds-berlin-agent-substrate", name: "a.md", content: "x", metadata: { source_url: "u", commit: "c", heading_path: "" } }, fake.fetch);
		if (!uploaded.ok) throw new Error(uploaded.reason);
		// Never parsed: the document stays UNSTART and the poll times out rather than passing.
		const unparsed = await pollParseStatus(CONFIG, { dataset_id: "ds-berlin-agent-substrate", document_id: uploaded.document_id }, fake.fetch, { maxPolls: 3, intervalMs: 0 });
		expect(unparsed).toEqual({ ok: false, reason: "parse-timeout" });
		const started = await parseDocuments(CONFIG, "ds-berlin-agent-substrate", [uploaded.document_id], fake.fetch);
		expect(started).toEqual({ ok: true });
		expect(fake.parses()).toEqual([{ document_ids: ["doc-upload-1"] }]);
		expect(fake.documents["doc-upload-1"]?.run).toBe("RUNNING");
		const parsed = await pollParseStatus(CONFIG, { dataset_id: "ds-berlin-agent-substrate", document_id: uploaded.document_id }, fake.fetch, { intervalMs: 0 });
		expect(parsed).toEqual({ ok: true });
		const polls = fake.requests.filter((request) => request.method === "GET" && request.path === "/api/v1/datasets/ds-berlin-agent-substrate/documents");
		expect(polls.length).toBeGreaterThanOrEqual(2);
		expect(polls.every((request) => request.query.id === "doc-upload-1")).toBe(true);
		expect(fake.documents["doc-upload-1"]?.run).toBe("DONE");
	});

	test("a FAIL run state is a named failure, and the business code is read under HTTP 200", async () => {
		const fake = new RagflowFake();
		fake.parseBehavior = "fail";
		const uploaded = await uploadDocument(CONFIG, { dataset_id: "ds-berlin-agent-substrate", name: "a.md", content: "x", metadata: { source_url: "u", commit: "c", heading_path: "" } }, fake.fetch);
		if (!uploaded.ok) throw new Error(uploaded.reason);
		await parseDocuments(CONFIG, "ds-berlin-agent-substrate", [uploaded.document_id], fake.fetch);
		const failed = await pollParseStatus(CONFIG, { dataset_id: "ds-berlin-agent-substrate", document_id: uploaded.document_id }, fake.fetch, { intervalMs: 0 });
		if (failed.ok) throw new Error("expected a failure");
		expect(failed.reason).toStartWith("parse-failed: FAIL");
		const unknown = await parseDocuments(CONFIG, "ds-berlin-agent-substrate", ["doc-nope"], fake.fetch);
		expect(unknown).toEqual({ ok: false, reason: "ragflow code 102: You don't own the document doc-nope." });
	});

	test("delete is the documented DELETE with ids", async () => {
		const fake = new RagflowFake();
		const uploaded = await uploadDocument(CONFIG, { dataset_id: "ds-berlin-agent-substrate", name: "a.md", content: "x", metadata: { source_url: "u", commit: "c", heading_path: "" } }, fake.fetch);
		if (!uploaded.ok) throw new Error(uploaded.reason);
		expect(await deleteDocuments(CONFIG, "ds-berlin-agent-substrate", [uploaded.document_id], fake.fetch)).toEqual({ ok: true });
		const call = fake.requests[fake.requests.length - 1];
		expect(call?.method).toBe("DELETE");
		expect(call?.path).toBe("/api/v1/datasets/ds-berlin-agent-substrate/documents");
		expect(call?.body).toEqual({ ids: ["doc-upload-1"] });
		expect(fake.deleted).toEqual(["doc-upload-1"]);
		expect(await deleteDocuments(CONFIG, "ds-berlin-agent-substrate", [], fake.fetch)).toEqual({ ok: true });
		expect(fake.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
	});

	test("retrieval carries the three documented knobs — RAGFlow's defaults, or the env overrides", async () => {
		const fake = new RagflowFake();
		const outcome = await retrieveChunks(CONFIG, { question: "q", dataset_ids: ["ds-berlin-agent-substrate"] }, fake.fetch);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(fake.retrievals()[0]).toEqual({
			question: "q",
			dataset_ids: ["ds-berlin-agent-substrate"],
			page: 1,
			page_size: 10,
			similarity_threshold: 0.2,
			vector_similarity_weight: 0.3,
			top_k: 1024,
		});
		// The documented chunk names map onto the citation's fields.
		expect(outcome.chunks[0]).toMatchObject({ document_name: "data-planes.md", chunk_id: "chunk-ds-berlin-agent-substrate-1", score: 0.91 });
		expect(outcome.chunks[0]?.source_url).toBeUndefined();

		const config = loadConfig({ SUBSTRATE_DOCS_SIMILARITY_THRESHOLD: "0.35", SUBSTRATE_DOCS_VECTOR_WEIGHT: "0.5", SUBSTRATE_DOCS_TOP_K: "256" });
		expect(config.docsRetrieval).toEqual({ similarityThreshold: 0.35, vectorSimilarityWeight: 0.5, topK: 256 });
		await retrieveChunks(CONFIG, { question: "q", dataset_ids: ["ds-berlin-agent-substrate"], retrieval: config.docsRetrieval }, fake.fetch);
		expect(fake.retrievals()[1]).toMatchObject({ similarity_threshold: 0.35, vector_similarity_weight: 0.5, top_k: 256 });
		// Junk and out-of-range values fall back to RAGFlow's own defaults.
		expect(loadConfig({ SUBSTRATE_DOCS_SIMILARITY_THRESHOLD: "7", SUBSTRATE_DOCS_VECTOR_WEIGHT: "x", SUBSTRATE_DOCS_TOP_K: "0" }).docsRetrieval).toEqual(DEFAULT_RETRIEVAL_KNOBS);
	});

	test("dataset create sends the documented chunk_method with the pinned model; a taken name is never reused", async () => {
		const fake = new RagflowFake();
		const created = await createDataset(CONFIG, "kanbanos", fake.fetch);
		if (!created.ok) throw new Error(created.reason);
		expect(fake.requests[0]?.body).toEqual({ name: "kanbanos", embedding_model: DATASET_EMBEDDING_MODEL, chunk_method: DATASET_CHUNK_METHOD });
		expect(DATASET_CHUNK_METHOD).toBe("naive");
		// The reference suffixes a duplicate; resolve-by-name is what keeps us from making one.
		const again = await createDataset(CONFIG, "kanbanos", fake.fetch);
		if (!again.ok) throw new Error(again.reason);
		expect(fake.datasets.map((dataset) => dataset.name)).toContain("kanbanos(1)");
		const resolved = await resolveDatasets({ config: CONFIG, fetchImpl: fake.fetch }, ["kanbanos"]);
		if (!resolved.ok) throw new Error(resolved.reason);
		expect(resolved.datasets[0]).toEqual({ name: "kanbanos", id: created.id, created: false });
		// The list is read with the documented pagination query.
		expect(fake.datasetLists()[0]?.query).toEqual({ page: "1", page_size: "100" });
	});
});

describe("durable versions and real pins", () => {
	test("the state file round-trips records and versions at version 2 and migrates a version-1 file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-docs-state-"));
		try {
			const file = join(dir, "docs-ingest.json");
			writeFileSync(file, JSON.stringify({ version: 1, records: { "ds-1::https://example.com/a": { sha: "s1", dataset_id: "ds-1", source_url: "https://example.com/a", document_id: "doc-1" } } }));
			const v1 = await loadIngestRecords(file);
			expect(v1.problem).toBeUndefined();
			expect(v1.records.size).toBe(1);
			expect(v1.versions.size).toBe(0);
			const versions = createVersionStore();
			recordVersion(versions, { dataset: "agent-substrate", dataset_id: "ds-1", version: "v1", commit: "c1", content_sha256: "s", ingested_at: "2026-10-13T00:00:00.000Z" });
			await saveIngestRecords(file, v1.records, versions);
			const written = JSON.parse(readFileSync(file, "utf8")) as { version: number; versions: unknown };
			expect(written.version).toBe(2);
			expect(written.versions).toEqual(versionsToJson(versions));
			const v2 = await loadIngestRecords(file);
			expect(v2.records.get("ds-1::https://example.com/a")?.document_id).toBe("doc-1");
			expect(v2.versions.get("agent-substrate")?.[0]?.commit).toBe("c1");
			// Malformed rows are skipped, never thrown on.
			expect(versionsFromJson({ x: [{ dataset: 1 }, null], y: "no" }).size).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("citations carry the real commit pin as dataset_commit after one recorded version, and the pin survives a restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-docs-state-"));
		try {
			const env = { RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k", SUBSTRATE_DOCS_STATE_FILE: join(dir, "docs-ingest.json") };
			// `Substrate` polls at the production cadence (2 s between polls): one poll keeps the test inside the runner's budget.
			const fake = new RagflowFake();
			fake.parseDonePolls = 1;
			const first = new Substrate(loadConfig(env), { index: null, greptime: null, ragflowFetch: fake.fetch });
			const before = await first.searchDocs({ question: "who reads RAGFlow?", datasets: ["agent-substrate"] }, "omp");
			expect(before.chunks[0]?.commit).toBe("dataset-pin:agent-substrate:unrecorded");
			expect(before.chunks[0]?.dataset_commit).toBeUndefined();
			const ingested = await first.ingestDocs({ dataset: "agent-substrate", commit: "c-real", pages: [PAGE] }, "omp");
			if (!ingested.ok) throw new Error(ingested.reason);
			const ownId = ingested.results[0]?.document_id ?? "";
			const recorded = await first.recordDocsVersion({ dataset: "agent-substrate", commit: "c-real", content_sha256: "sha-real" }, "omp");
			if (!recorded.ok) throw new Error(recorded.reason);
			// The plane serves the document this process uploaded and one it never recorded.
			const seeded = fake.chunks["ds-berlin-agent-substrate"]?.[0];
			if (!seeded) throw new Error("expected a seeded chunk");
			fake.chunks["ds-berlin-agent-substrate"] = [{ ...seeded, document_id: ownId, chunk_id: "chunk-own" }, seeded];
			const after = await first.searchDocs({ question: "who reads RAGFlow?", datasets: ["agent-substrate"] }, "omp");
			expect(after.chunks.length).toBe(2);
			// Every citation names the dataset's recorded version separately …
			expect(after.chunks.every((citation) => citation.dataset_commit === "c-real")).toBe(true);
			// … while `commit` is the document's own, or an honest marker (Greptile round 2).
			const byDocument = Object.fromEntries(after.chunks.map((citation) => [citation.document_id, citation.commit]));
			expect(byDocument[ownId]).toBe("c-real");
			expect(byDocument[seeded.document_id ?? ""]).toBe("dataset-pin:agent-substrate:unrecorded");

			// A new process: pins hydrate from the file, idempotency holds.
			const second = new Substrate(loadConfig(env), { index: null, greptime: null, ragflowFetch: fake.fetch });
			const restarted = await second.searchDocs({ question: "who reads RAGFlow?", datasets: ["agent-substrate"] }, "omp");
			expect(restarted.chunks.map((citation) => [citation.document_id, citation.commit, citation.dataset_commit])).toEqual(after.chunks.map((citation) => [citation.document_id, citation.commit, citation.dataset_commit]));
			const newest = await second.latestDocsVersion("agent-substrate");
			expect(newest).toMatchObject({ version: "v1", commit: "c-real", content_sha256: "sha-real" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a chunk without a source URL is cited from the ingest record of its document, redacted", async () => {
		const fake = new RagflowFake();
		fake.chunks["ds-berlin-agent-substrate"] = [{ content: "clean", document_name: "a.md", document_id: "doc-rec", chunk_id: "c", source_url: "", score: 0.5 }];
		const { emit } = eventSink();
		const reply = await searchDocs(
			{
				config: CONFIG,
				emit,
				fetchImpl: fake.fetch,
				datasetNames: ["agent-substrate"],
				provenanceOf: (id) => (id === "doc-rec" ? { source_url: "https://example.com/sk-proj-abcdefghij1234567890", commit: "c-doc" } : undefined),
			},
			"q",
		);
		expect(reply.chunks[0]?.source_url).toStartWith("https://example.com/");
		expect(reply.chunks[0]?.source_url).not.toContain("sk-proj-");
		expect(reply.chunks[0]?.commit).toBe("c-doc");
		const unknown = await searchDocs({ config: CONFIG, emit, fetchImpl: fake.fetch, datasetNames: ["agent-substrate"] }, "q");
		expect(unknown.chunks[0]?.source_url).toBe("dataset:agent-substrate");
	});

	test("Greptile round 1: a citation names its own document's commit, never the dataset's newest pin", async () => {
		// The fake serves whatever `chunks` holds: after each ingest, point the
		// dataset's chunks at the documents the plane actually holds, as a
		// retrieval over an unpruned corpus would.
		const fake = new RagflowFake();
		fake.parseDonePolls = 1;
		const chunkFor = (documentId: string) => ({ content: `from ${documentId}`, document_name: "data-planes.md", document_id: documentId, chunk_id: `chunk-${documentId}`, source_url: "", score: 0.5 });
		const substrate = new Substrate(loadConfig({ RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" }), { index: null, greptime: null, ragflowFetch: fake.fetch });
		const old = await substrate.ingestDocs({ dataset: "agent-substrate", commit: "c-old", pages: [PAGE] }, "omp");
		if (!old.ok) throw new Error(old.reason);
		const oldId = old.results[0]?.document_id ?? "";
		const recordedOld = await substrate.recordDocsVersion({ dataset: "agent-substrate", commit: "c-old", content_sha256: "sha-old" }, "omp");
		if (!recordedOld.ok) throw new Error(recordedOld.reason);
		// Prune is off (default): the replaced document stays on the plane.
		const fresh = await substrate.ingestDocs({ dataset: "agent-substrate", commit: "c-new", pages: [{ ...PAGE, body: `${PAGE.body} More.` }] }, "omp");
		if (!fresh.ok) throw new Error(fresh.reason);
		const newId = fresh.results[0]?.document_id ?? "";
		expect(fresh.results[0]?.superseded_document_id).toBe(oldId);
		const recordedNew = await substrate.recordDocsVersion({ dataset: "agent-substrate", commit: "c-new", content_sha256: "sha-new" }, "omp");
		if (!recordedNew.ok) throw new Error(recordedNew.reason);
		fake.chunks["ds-berlin-agent-substrate"] = [chunkFor(oldId), chunkFor(newId), chunkFor("doc-unknown")];

		const reply = await substrate.searchDocs({ question: "which commit?", datasets: ["agent-substrate"] }, "omp");
		const byId = Object.fromEntries(reply.chunks.map((citation) => [citation.document_id, citation.commit]));
		// The replaced-but-unpruned document cites its own, older commit.
		expect(byId[oldId]).toBe("c-old");
		// The new document cites the new commit.
		expect(byId[newId]).toBe("c-new");
		// A document the records never uploaded is not stamped with the pin
		// either (Greptile round 2): it may predate or postdate it.
		expect(byId["doc-unknown"]).toBe("dataset-pin:agent-substrate:unrecorded");
		// The dataset's newest recorded version travels on every citation, as its own field.
		expect(reply.chunks.every((citation) => citation.dataset_commit === "c-new")).toBe(true);
		// Both recorded documents carry the ingest record's source URL.
		expect(reply.chunks.filter((citation) => citation.document_id !== "doc-unknown").every((citation) => citation.source_url === PAGE.source_url)).toBe(true);

		// A direct ingest without a commit: the record has none, and the
		// citation says so rather than borrowing the dataset's newest pin.
		const bare = await substrate.ingestDocs({ dataset: "agent-substrate", pages: [{ ...PAGE, source_url: "https://example.com/agent-substrate/bare", body: "bare" }] }, "omp");
		if (!bare.ok) throw new Error(bare.reason);
		const bareId = bare.results[0]?.document_id ?? "";
		fake.chunks["ds-berlin-agent-substrate"] = [chunkFor(bareId)];
		const bareReply = await substrate.searchDocs({ question: "which commit?", datasets: ["agent-substrate"] }, "omp");
		expect(bareReply.chunks[0]?.commit).toBe("dataset-pin:agent-substrate:unpinned");
		expect(bareReply.chunks[0]?.dataset_commit).toBe("c-new");
	});

	test("the lineage of replaced documents round-trips the state file, and a prune drops the pruned one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-docs-state-"));
		try {
			const file = join(dir, "docs-ingest.json");
			const env = { RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k", SUBSTRATE_DOCS_STATE_FILE: file };
			const fake = new RagflowFake();
			fake.parseDonePolls = 1;
			const first = new Substrate(loadConfig(env), { index: null, greptime: null, ragflowFetch: fake.fetch });
			const v1 = await first.ingestDocs({ dataset: "agent-substrate", commit: "c1", pages: [PAGE] }, "omp");
			const v2 = await first.ingestDocs({ dataset: "agent-substrate", commit: "c2", pages: [{ ...PAGE, body: "two" }] }, "omp");
			if (!v1.ok || !v2.ok) throw new Error("expected both ingests");
			const loaded = await loadIngestRecords(file);
			const record = [...loaded.records.values()][0];
			expect(record).toMatchObject({ document_id: v2.results[0]?.document_id, commit: "c2", superseded: [{ document_id: v1.results[0]?.document_id, commit: "c1" }] });
			// A new process resolves the old document from the hydrated lineage.
			const second = new Substrate(loadConfig(env), { index: null, greptime: null, ragflowFetch: fake.fetch });
			fake.chunks["ds-berlin-agent-substrate"] = [{ content: "x", document_name: "d", document_id: v1.results[0]?.document_id ?? "", chunk_id: "c", source_url: "", score: 1 }];
			const reply = await second.searchDocs({ question: "q", datasets: ["agent-substrate"] }, "omp");
			expect(reply.chunks[0]?.commit).toBe("c1");
			// With the prune on, the deleted predecessor is not kept in the lineage.
			const pruning = new Substrate(loadConfig({ ...env, SUBSTRATE_DOCS_PRUNE_SUPERSEDED: "1" }), { index: null, greptime: null, ragflowFetch: fake.fetch });
			const v3 = await pruning.ingestDocs({ dataset: "agent-substrate", commit: "c3", pages: [{ ...PAGE, body: "three" }] }, "omp");
			if (!v3.ok) throw new Error(v3.reason);
			expect(v3.results[0]?.pruned_document_id).toBe(v2.results[0]?.document_id);
			const after = await loadIngestRecords(file);
			expect([...after.records.values()][0]).toMatchObject({ commit: "c3", superseded: [{ document_id: v1.results[0]?.document_id, commit: "c1" }] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("cached reads", () => {
	test("the dataset list is served from memory for 60 s, and dropped by a create or a failed list", async () => {
		const fake = new RagflowFake();
		let now = 1_000_000;
		const cache = new DatasetListCache(DATASET_LIST_TTL_MS, () => now);
		const a = await cache.list(CONFIG, fake.fetch);
		const b = await cache.list(CONFIG, fake.fetch);
		expect(a.ok && b.ok).toBe(true);
		expect(fake.datasetLists()).toHaveLength(1);
		now += DATASET_LIST_TTL_MS - 1;
		await cache.list(CONFIG, fake.fetch);
		expect(fake.datasetLists()).toHaveLength(1);
		now += 2;
		await cache.list(CONFIG, fake.fetch);
		expect(fake.datasetLists()).toHaveLength(2);
		// A create invalidates: the next resolve sees the new dataset at once.
		const resolved = await resolveDatasets({ config: CONFIG, fetchImpl: fake.fetch, datasets: cache }, ["clippyos"]);
		if (!resolved.ok) throw new Error(resolved.reason);
		expect(resolved.datasets[0]?.created).toBe(true);
		const afterCreate = await cache.list(CONFIG, fake.fetch);
		expect(afterCreate.ok && afterCreate.datasets.some((dataset) => dataset.name === "clippyos")).toBe(true);
		expect(fake.datasetLists()).toHaveLength(3);
		// That read refilled the cache, and a held list is served for its TTL
		// whatever the plane does meanwhile — the plane is only asked once the
		// hold expires. A failure on that fetch is returned, not masked, and is
		// never held: the very next call reaches the plane again instead of
		// serving anything from before the failure.
		fake.failListWith = 503;
		await cache.list(CONFIG, fake.fetch);
		expect(fake.datasetLists()).toHaveLength(3);
		now += DATASET_LIST_TTL_MS + 1;
		expect(await cache.list(CONFIG, fake.fetch)).toEqual({ ok: false, reason: "ragflow 503" });
		expect(fake.datasetLists()).toHaveLength(4);
		fake.failListWith = null;
		const recovered = await cache.list(CONFIG, fake.fetch);
		expect(recovered.ok).toBe(true);
		expect(fake.datasetLists()).toHaveLength(5);
		// Concurrent callers share the in-flight fetch.
		cache.invalidate();
		await Promise.all([cache.list(CONFIG, fake.fetch), cache.list(CONFIG, fake.fetch)]);
		expect(fake.datasetLists()).toHaveLength(6);
	});

	test("one docs_search costs N retrievals with the list cached, and 0 plane calls on a cache hit", async () => {
		const fake = new RagflowFake();
		const redis = new FakeRedis();
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		const substrate = new Substrate(loadConfig({ RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" }), { index: null, greptime: null, ragflowFetch: fake.fetch, cache });
		const first = await substrate.searchDocs({ question: "who reads  RAGFlow?" }, "omp");
		expect(first.degraded).toBeUndefined();
		expect(fake.datasetLists()).toHaveLength(1);
		expect(fake.retrievals()).toHaveLength(3);
		expect(redis.commands.filter((command) => command.startsWith("SET substrate:v1:docs-search:"))).toHaveLength(1);
		expect(redis.commands.find((command) => command.startsWith("SET substrate:v1:docs-search:"))).toEndWith(`ttl=${CACHE_TTL["docs-search"]}`);
		const before = fake.requests.length;
		// Same question up to whitespace and case: a hit, no plane call at all.
		const second = await substrate.searchDocs({ question: "  Who reads RAGFlow? " }, "omp");
		expect(second.chunks).toEqual(first.chunks);
		expect(fake.requests.length).toBe(before);
		expect(cache.health().hits).toBe(1);
	});

	test("a degraded answer is never stored, and an ingest or a recorded version bumps gen:docs", async () => {
		const fake = new RagflowFake();
		const redis = new FakeRedis();
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		const substrate = new Substrate(loadConfig({ RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" }), { index: null, greptime: null, ragflowFetch: fake.fetch, cache });
		fake.failRetrievalWith = 503;
		const degraded = await substrate.searchDocs({ question: "q" }, "omp");
		expect(degraded.degraded).toBe(true);
		expect(redis.commands.some((command) => command.startsWith("SET substrate:v1:docs-search:"))).toBe(false);
		fake.failRetrievalWith = null;
		await substrate.searchDocs({ question: "q" }, "omp");
		expect(redis.commands.filter((command) => command.startsWith("SET substrate:v1:docs-search:"))).toHaveLength(1);

		const ingested = await substrate.ingestDocs({ dataset: "agent-substrate", pages: [PAGE] }, "omp");
		if (!ingested.ok) throw new Error(ingested.reason);
		expect(redis.commands.filter((command) => command === `INCR ${DOCS_GENERATION_KEY}`)).toHaveLength(1);
		const recorded = await substrate.recordDocsVersion({ dataset: "agent-substrate", commit: "c", content_sha256: "s" }, "omp");
		if (!recorded.ok) throw new Error(recorded.reason);
		expect(redis.commands.filter((command) => command === `INCR ${DOCS_GENERATION_KEY}`)).toHaveLength(2);
		// The bumped generation (and the new pin) make the next search a miss that stores again.
		const retrievalsBefore = fake.retrievals().length;
		await substrate.searchDocs({ question: "q" }, "omp");
		expect(fake.retrievals().length).toBe(retrievalsBefore + 3);
		expect(redis.commands.filter((command) => command.startsWith("SET substrate:v1:docs-search:"))).toHaveLength(2);
	});

	test("the docs-search class rejects a malformed cached value", async () => {
		const redis = new FakeRedis();
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
		let loads = 0;
		const load = async () => {
			loads += 1;
			return { chunks: [], untrusted: "n" };
		};
		await cache.getOrLoad({ klass: "docs-search", surface: "omp", args: { q: 1 }, generations: [DOCS_GENERATION_KEY], load });
		const key = [...redis.values.keys()].find((entry) => entry.startsWith("substrate:v1:docs-search:")) ?? "";
		redis.values.set(key, JSON.stringify({ v: { nope: true } }));
		await cache.getOrLoad({ klass: "docs-search", surface: "omp", args: { q: 1 }, generations: [DOCS_GENERATION_KEY], load });
		expect(loads).toBe(2);
	});
});

describe("bounded growth: SUBSTRATE_DOCS_PRUNE_SUPERSEDED", () => {
	test("off (the default) keeps the superseded document and makes no delete call", async () => {
		const fake = new RagflowFake();
		expect(loadConfig({}).docsPruneSuperseded).toBe(false);
		const { ingest } = ingestHarness(fake);
		const first = await ingest([PAGE]);
		if (!first.ok) throw new Error(first.reason);
		const changed = await ingest([{ ...PAGE, body: `${PAGE.body} More.` }]);
		if (!changed.ok) throw new Error(changed.reason);
		expect(changed.results[0]).toMatchObject({ status: "replaced", superseded_document_id: first.results[0]?.document_id });
		expect(changed.results[0]?.pruned_document_id).toBeUndefined();
		expect(fake.requests.some((request) => request.method === "DELETE")).toBe(false);
		expect(Object.keys(fake.documents)).toHaveLength(2);
	});

	test("on, the superseded document is deleted after the replacement parsed, and the result says so", async () => {
		const fake = new RagflowFake();
		expect(loadConfig({ SUBSTRATE_DOCS_PRUNE_SUPERSEDED: "1" }).docsPruneSuperseded).toBe(true);
		const { events, ingest } = ingestHarness(fake, { prune: true });
		const first = await ingest([PAGE]);
		if (!first.ok) throw new Error(first.reason);
		expect(fake.deleted).toEqual([]);
		const changed = await ingest([{ ...PAGE, body: `${PAGE.body} More.` }]);
		if (!changed.ok) throw new Error(changed.reason);
		const superseded = first.results[0]?.document_id ?? "";
		expect(changed.results[0]).toMatchObject({ status: "replaced", superseded_document_id: superseded, pruned_document_id: superseded });
		expect(fake.deleted).toEqual([superseded]);
		// The delete ran after the replacement's parse completed, never before.
		const order = fake.requests.map((request) => `${request.method} ${request.path.split("/").pop()}`);
		expect(order.indexOf("DELETE documents")).toBeGreaterThan(order.lastIndexOf("GET documents"));
		expect(Object.keys(fake.documents)).toHaveLength(1);
		const note = events.filter((event) => event.kind === "note").pop();
		expect(note?.payload).toMatchObject({ superseded_document_ids: [superseded], pruned_document_ids: [superseded] });
	});

	test("a failed prune is recorded on the result and logged, and the ingest still succeeds", async () => {
		const fake = new RagflowFake();
		const { events, lines, ingest } = ingestHarness(fake, { prune: true });
		const first = await ingest([PAGE]);
		if (!first.ok) throw new Error(first.reason);
		fake.failDeleteWith = 500;
		const changed = await ingest([{ ...PAGE, body: `${PAGE.body} More.` }]);
		if (!changed.ok) throw new Error(`expected success: ${changed.reason}`);
		expect(changed.results[0]?.status).toBe("replaced");
		expect(changed.results[0]?.pruned_document_id).toBeUndefined();
		expect(changed.results[0]?.prune).toBe("failed: ragflow 500");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("not pruned");
		expect(events.some((event) => event.kind === "warning")).toBe(false);
		expect(Object.keys(fake.documents)).toHaveLength(2);
	});

	// Greptile round 2: page A lands and prunes its predecessor, then page B
	// fails at upload. The fake has no per-document failure knob, so the
	// wrapper refuses the one multipart upload whose file carries B's name.
	const PAGE_B = { path: "docs/b.md", source_url: "https://example.com/agent-substrate/b", body: "page b" };
	const failingUploadOf = (fake: RagflowFake, fileName: string): FetchLike => async (input, init) => {
		if (init?.body instanceof FormData && init.body.getAll("file").some((part) => part instanceof File && part.name === fileName)) {
			return Response.json({ code: 100, message: "injected upload failure" }, { status: 500 });
		}
		return fake.fetch(input, init);
	};

	test("Greptile round 2: a page failing after an earlier page pruned its predecessor reports changed: true; a refusal that touched nothing reports false", async () => {
		const fake = new RagflowFake();
		const { seen, ingest } = ingestHarness(fake, { prune: true, fetchImpl: failingUploadOf(fake, documentName(PAGE_B.path)) });
		const first = await ingest([PAGE]);
		if (!first.ok) throw new Error(first.reason);
		expect(first.changed).toBe(true);
		const oldId = first.results[0]?.document_id ?? "";
		const partial = await ingest([{ ...PAGE, body: `${PAGE.body} More.` }, PAGE_B]);
		if (partial.ok) throw new Error("expected page B to fail");
		expect(partial.page).toBe(PAGE_B.path);
		expect(partial.changed).toBe(true);
		// Page A landed, its predecessor is gone from the plane, and the record names the surviving document.
		expect(fake.deleted).toEqual([oldId]);
		const record = seen.get(`ds-berlin-agent-substrate::${PAGE.source_url}`);
		expect(record?.document_id).not.toBe(oldId);
		expect(fake.documents[record?.document_id ?? ""]).toBeDefined();
		// Nothing stored: an unchanged hash, and a gate refusal before any upload.
		const skipped = await ingest([{ ...PAGE, body: `${PAGE.body} More.` }]);
		if (!skipped.ok) throw new Error(skipped.reason);
		expect(skipped.changed).toBe(false);
		const gated = await ingest([{ ...PAGE_B, path: "private/b.md" }]);
		if (gated.ok) throw new Error("expected a refusal");
		expect(gated).toMatchObject({ reason: "outside-roots", changed: false });
		// B failing as the first page of a call stored nothing either.
		const nothing = await ingest([PAGE_B]);
		if (nothing.ok) throw new Error("expected page B to fail");
		expect(nothing.changed).toBe(false);
	});

	test("Greptile round 2: the service persists the records and bumps gen:docs after a partial failure, so a restart never names the pruned document", async () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-docs-state-"));
		try {
			const file = join(dir, "docs-ingest.json");
			const env = { RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k", SUBSTRATE_DOCS_STATE_FILE: file, SUBSTRATE_DOCS_PRUNE_SUPERSEDED: "1" };
			const fake = new RagflowFake();
			fake.parseDonePolls = 1;
			const redis = new FakeRedis();
			const cache = new ReadThroughCache({ redis, enabled: true, log: () => {} });
			const bumps = () => redis.commands.filter((command) => command === `INCR ${DOCS_GENERATION_KEY}`).length;
			const first = new Substrate(loadConfig(env), { index: null, greptime: null, ragflowFetch: failingUploadOf(fake, documentName(PAGE_B.path)), cache });
			const v1 = await first.ingestDocs({ dataset: "agent-substrate", commit: "c1", pages: [PAGE] }, "omp");
			if (!v1.ok) throw new Error(v1.reason);
			const oldId = v1.results[0]?.document_id ?? "";
			expect(bumps()).toBe(1);
			const partial = await first.ingestDocs({ dataset: "agent-substrate", commit: "c2", pages: [{ ...PAGE, body: "two" }, PAGE_B] }, "omp");
			if (partial.ok) throw new Error("expected page B to fail");
			expect(partial.changed).toBe(true);
			// The failure still invalidated cached searches and saved page A's new record.
			expect(bumps()).toBe(2);
			expect(fake.deleted).toEqual([oldId]);
			const saved = (await loadIngestRecords(file)).records.get(`ds-berlin-agent-substrate::${PAGE.source_url}`);
			expect(saved?.commit).toBe("c2");
			expect(saved?.document_id).not.toBe(oldId);
			expect(fake.documents[saved?.document_id ?? ""]).toBeDefined();
			// A restart re-submitting page A's old content replaces the recorded
			// document rather than answering `unchanged` for the deleted one.
			const second = new Substrate(loadConfig(env), { index: null, greptime: null, ragflowFetch: fake.fetch, cache });
			const resubmitted = await second.ingestDocs({ dataset: "agent-substrate", commit: "c1", pages: [PAGE] }, "omp");
			if (!resubmitted.ok) throw new Error(resubmitted.reason);
			expect(resubmitted.results[0]).toMatchObject({ status: "replaced", superseded_document_id: saved?.document_id });
			expect(resubmitted.results[0]?.document_id).not.toBe(oldId);
			expect(bumps()).toBe(3);
			// A refusal that touched nothing neither persists nor bumps.
			const gated = await second.ingestDocs({ dataset: "agent-substrate", pages: [{ ...PAGE_B, path: "private/b.md" }] }, "omp");
			if (gated.ok) throw new Error("expected a refusal");
			expect(gated.changed).toBe(false);
			expect(bumps()).toBe(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the asynchronous merge-trigger", () => {
	async function serve(fake: RagflowFake, docs: string, env: Record<string, string> = {}, options: HttpServerOptions = {}) {
		const fullEnv = { SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k", ...env };
		const config = loadConfig(fullEnv);
		const observability = createObservability(config, fullEnv);
		await observability.start();
		const substrate = new Substrate(config, { index: null, greptime: null, ragflowFetch: fake.fetch as FetchLike }, observability.observer);
		const server = createHttpServer(substrate, config, observability, { docsIngestBaseDir: docs, ...options });
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		return {
			substrate,
			post: (path: string, body: unknown, headers: Record<string, string> = { authorization: "Bearer tok-omp" }) =>
				fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
			stop: () => {
				const closed = Promise.withResolvers<void>();
				observability.stop();
				server.close(() => closed.resolve());
				return closed.promise;
			},
		};
	}

	function fixture(): string {
		const root = mkdtempSync(join(tmpdir(), "substrate-docs-"));
		writeFileSync(join(root, "README.md"), "The substrate is the only door.");
		return root;
	}

	/** A fake whose parse never finishes until released, so the job is observably in flight. */
	function gatedFake(): { fake: RagflowFake; release: () => void } {
		const fake = new RagflowFake();
		const inner = fake.fetch;
		const gate = Promise.withResolvers<void>();
		let released = false;
		const gated: FetchLike = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (!released && (init?.method ?? "GET") === "GET" && /\/documents\?/.test(url)) await gate.promise;
			return inner(input, init);
		};
		// Swap the fetch the server sees for the gated one; the fake records as before.
		Object.defineProperty(fake, "fetch", { value: gated });
		return {
			fake,
			release: () => {
				released = true;
				gate.resolve();
			},
		};
	}

	test("answers 202 at once with a job id, runs the ingest in the background, and records the version", async () => {
		const { fake, release } = gatedFake();
		const docs = fixture();
		const { substrate, post, stop } = await serve(fake, docs);
		try {
			const started = Date.now();
			const response = await post("/docs/merge-trigger", { commit: "c-merge", content_sha256: "sha-merge" });
			const body = (await response.json()) as { accepted: boolean; job: string; dataset: string; commit: string; queued?: boolean };
			expect(response.status).toBe(202);
			// Measured 3 ms through the service; the bound leaves room for a loaded CI host.
			expect(Date.now() - started).toBeLessThan(500);
			expect(body).toMatchObject({ accepted: true, dataset: "agent-substrate", commit: "c-merge" });
			expect(body.job).toStartWith("docs-refresh-");
			expect(body.queued).toBeUndefined();
			// Nothing recorded yet: the parse is still gated.
			expect(await substrate.latestDocsVersion("agent-substrate")).toBeUndefined();

			// The same identity while it runs: the same job, marked queued.
			const repeat = await post("/docs/merge-trigger", { commit: "c-merge", content_sha256: "sha-merge" });
			const repeatBody = (await repeat.json()) as { job: string; queued?: boolean };
			expect(repeat.status).toBe(202);
			expect(repeatBody.job).toBe(body.job);
			expect(repeatBody.queued).toBe(true);
			// A different identity queues behind it under a new id.
			const next = await post("/docs/merge-trigger", { commit: "c-merge-2", content_sha256: "sha-merge-2" });
			const nextBody = (await next.json()) as { job: string; queued?: boolean };
			expect(next.status).toBe(202);
			expect(nextBody.job).not.toBe(body.job);
			expect(nextBody.queued).toBe(true);

			release();
			// `?wait=1` on the queued identity joins that job and answers its outcome.
			const waited = await post("/docs/merge-trigger?wait=1", { commit: "c-merge-2", content_sha256: "sha-merge-2" });
			const waitedBody = (await waited.json()) as { ok: boolean; version?: { version: string; commit: string }; job: string };
			expect(waited.status).toBe(200);
			expect(waitedBody.job).toBe(nextBody.job);
			expect(waitedBody.version).toMatchObject({ version: "v2", commit: "c-merge-2" });
			// Both jobs ran in order and recorded their versions; the first upload served both.
			expect(await substrate.latestDocsVersion("agent-substrate")).toMatchObject({ version: "v2", commit: "c-merge-2" });
			expect(fake.uploads).toHaveLength(1);
			// The first identity is now idempotent on the record — answered 200 without a job.
			const again = await post("/docs/merge-trigger", { commit: "c-merge-2", content_sha256: "sha-merge-2" });
			expect(again.status).toBe(200);
			const againBody = (await again.json()) as { idempotent?: boolean };
			expect(againBody.idempotent).toBe(true);
		} finally {
			await stop();
			rmSync(docs, { recursive: true, force: true });
		}
	});

	test("the refusals are unchanged: 401 untokened, 403 off-loopback-only guest, 400 bad body; ?wait=1 answers 503 on a refused ingest", async () => {
		const fake = new RagflowFake();
		const docs = fixture();
		writeFileSync(join(docs, "README.md"), "password: hunter2 in the shipped config");
		const { post, stop } = await serve(fake, docs, { SUBSTRATE_VM_GUEST: "" });
		try {
			expect((await post("/docs/merge-trigger", { commit: "c", content_sha256: "s" }, {})).status).toBe(401);
			expect((await post("/docs/merge-trigger", { dataset: "nope", commit: "c", content_sha256: "s" })).status).toBe(400);
			expect((await post("/docs/merge-trigger", { commit: "c" })).status).toBe(400);
			const refused = await post("/docs/merge-trigger?wait=1", { commit: "c-leak", content_sha256: "sha-leak" });
			expect(refused.status).toBe(503);
			const refusedBody = (await refused.json()) as { ok: boolean; reason: string };
			expect(refusedBody).toMatchObject({ ok: false, reason: "secret-findings" });
			expect(fake.uploads).toHaveLength(0);
		} finally {
			await stop();
			rmSync(docs, { recursive: true, force: true });
		}
		const guest = await serve(fake, docs, { SUBSTRATE_VM_GUEST: "1" });
		try {
			expect((await guest.post("/docs/merge-trigger", { commit: "c", content_sha256: "s" })).status).toBe(403);
		} finally {
			await guest.stop();
		}
	});

	test("a background job's failure is logged, recorded on ?wait=1, and records no version", async () => {
		const fake = new RagflowFake();
		fake.parseBehavior = "fail";
		const docs = fixture();
		const lines: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			lines.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		const { substrate, post, stop } = await serve(fake, docs);
		try {
			const accepted = await post("/docs/merge-trigger", { commit: "c-fail", content_sha256: "sha-fail" });
			expect(accepted.status).toBe(202);
			const waited = await post("/docs/merge-trigger?wait=1", { commit: "c-fail", content_sha256: "sha-fail" });
			expect(waited.status).toBe(503);
			const body = (await waited.json()) as { ok: boolean; reason: string };
			expect(body.ok).toBe(false);
			expect(body.reason).toStartWith("parse-failed");
			expect(await substrate.latestDocsVersion("agent-substrate")).toBeUndefined();
			expect(lines.some((line) => line.includes("docs merge-trigger") && line.includes("failed"))).toBe(true);
		} finally {
			process.stderr.write = original;
			await stop();
			rmSync(docs, { recursive: true, force: true });
		}
	});

	test("an agent-skills trigger is the fast-forward evidence: its citations stop carrying pin_age_ms", async () => {
		const fake = new RagflowFake();
		const docs = fixture();
		const { substrate, post, stop } = await serve(fake, docs);
		try {
			const recorded = await substrate.recordDocsVersion({ dataset: "agent-skills", commit: "skill-pin", content_sha256: "s" }, "omp");
			if (!recorded.ok) throw new Error(recorded.reason);
			const before = await substrate.searchDocs({ question: "skills?", datasets: ["agent-skills"] }, "omp");
			expect(before.chunks.every((citation) => typeof citation.pin_age_ms === "number")).toBe(true);
			const noop = await post("/docs/merge-trigger", { dataset: "agent-skills", commit: "c-ff", content_sha256: "sha-ff" });
			expect(noop.status).toBe(200);
			const after = await substrate.searchDocs({ question: "skills?", datasets: ["agent-skills"] }, "omp");
			expect(after.chunks.every((citation) => citation.pin_age_ms === undefined)).toBe(true);
		} finally {
			await stop();
			rmSync(docs, { recursive: true, force: true });
		}
	});
});

describe("the unit", () => {
	test("substrate-mcp.service sets the docs state file under StateDirectory", () => {
		const unit = readFileSync(UNIT_FILE, "utf8");
		expect(unit).toContain("Environment=SUBSTRATE_DOCS_STATE_FILE=/var/lib/substrate/docs-ingest.json");
		expect(unit).toContain("StateDirectory=substrate");
	});
});
