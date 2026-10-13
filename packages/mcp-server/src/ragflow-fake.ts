/**
 * The recording RAGFlow fake for rehearsal (D25-10).
 *
 * Serves the shapes the HTTP API reference documents
 * (https://ragflow.io/docs/http_api_reference, read 2026-10-13; uplift-2
 * R6) over an injected `fetch`, and records every request it receives.
 * Tests prove the client against it instead of the deployment; the live
 * proof (Phase 25 G1–G4) stays operator-gated, so the shapes are
 * live-unattested and this file is the contract the client is held to:
 *
 * - `POST /api/v1/datasets/{id}/documents` takes multipart `file` parts
 *   and answers `{code: 0, data: [{id, name, run: "UNSTART"}]}`; a JSON
 *   body — the pre-R6 rehearsal shape — is refused with the documented
 *   failure (`code: 101, "No file part!"`).
 * - `PATCH /api/v1/datasets/{id}/documents/{doc}` sets `meta_fields`.
 * - `POST /api/v1/datasets/{id}/chunks` starts parsing `document_ids`; an
 *   uploaded document that was never parsed stays `UNSTART` forever, so a
 *   client that skips the call times out instead of passing.
 * - `GET /api/v1/datasets/{id}/documents?id=` lists `{data: {docs}}` with
 *   the documented `run` progression (`RUNNING` → `DONE`, or `FAIL`).
 * - `DELETE /api/v1/datasets/{id}/documents` takes `{ids}`.
 * - `POST /api/v1/retrieval` answers documented chunks (`document_keyword`,
 *   `id`, `similarity`); no metadata echo, since none is documented.
 * - A dataset created under a taken name gets the documented numbered
 *   suffix, so a client that skips discovery is caught by its own dup.
 * - The pre-R6 `GET /api/v1/documents/{id}/parse` has no route (404).
 *
 * Anti-pattern gate: any retrieval missing `dataset_ids` fails, so a test
 * suite passing against this fake proves no unscoped retrieval exists.
 */
import type { RagflowChunk } from "./planes/ragflow.ts";

export interface FakeDataset {
	id: string;
	name: string;
	embedding_model: string;
	chunk_method?: string;
}

export interface RecordedRequest {
	method: string;
	path: string;
	/** JSON bodies as parsed; multipart bodies as `{multipart: {file: [{name, text}]}}`. */
	body: unknown;
	query: Record<string, string>;
}

export type FakeChunkShape = "full" | "minimal";

/**
 * A chunk the fake serves. `document_name`, `chunk_id` and `score` go out
 * under their documented names; `heading_path` and `source_url` are
 * accepted so existing fixtures type-check but are never served — the
 * reference documents no metadata on retrieval chunks.
 */
export interface FakeChunk extends RagflowChunk {
	source_url: string;
}

/** One document on the fake plane, with its documented `run` state. */
export interface FakeDocument {
	id: string;
	dataset_id: string;
	name: string;
	run: "UNSTART" | "RUNNING" | "DONE" | "FAIL";
	polls: number;
	meta_fields: Record<string, string>;
}

const BERLIN_ID = "ds-berlin-agent-substrate";
const HAMM_ID = "ds-hamm-programming-desk";
const LEIPZIG_ID = "ds-leipzig-agent-skills";

/** The documented built-in chunk methods (§Create dataset). */
const CHUNK_METHODS: Record<string, true> = {
	naive: true,
	book: true,
	email: true,
	laws: true,
	manual: true,
	one: true,
	paper: true,
	picture: true,
	presentation: true,
	qa: true,
	table: true,
	tag: true,
};

function seedChunks(datasetId: string, sourceUrl: string): FakeChunk[] {
	return [
		{
			content: "The substrate is the only door to the data planes.",
			document_name: "data-planes.md",
			document_id: `doc-${datasetId}-1`,
			chunk_id: `chunk-${datasetId}-1`,
			heading_path: "Access path",
			source_url: sourceUrl,
			score: 0.91,
		},
		{
			content: "Callers cite the source, not the chunk.",
			document_name: "data-planes.md",
			document_id: `doc-${datasetId}-2`,
			chunk_id: `chunk-${datasetId}-2`,
			heading_path: "RAGFlow datasets",
			source_url: sourceUrl,
			score: 0.83,
		},
	];
}

/** The documented failure envelope; HTTP 200 unless a status is given (§ERROR CODES). */
function failure(code: number, message: string, status = 200): Response {
	return Response.json({ code, message }, { status });
}

export class RagflowFake {
	readonly requests: RecordedRequest[] = [];
	/** Flip to serve the minimal shape (no ids, no score) — the U-01 version-swap arm. */
	chunkShape: FakeChunkShape = "full";
	/** When set, every retrieval answers with this status instead. */
	failRetrievalWith: number | null = null;
	/** When set, every dataset list answers with this status instead. */
	failListWith: number | null = null;
	/** When set, every document delete answers with this status instead. */
	failDeleteWith: number | null = null;
	/** When set, every `meta_fields` update answers with this status instead. */
	failMetaWith: number | null = null;
	readonly datasets: FakeDataset[] = [
		{ id: BERLIN_ID, name: "agent-substrate", embedding_model: "tei-bge-small", chunk_method: "naive" },
		{ id: HAMM_ID, name: "programming-desk", embedding_model: "tei-bge-small", chunk_method: "naive" },
		{ id: LEIPZIG_ID, name: "agent-skills", embedding_model: "tei-bge-small", chunk_method: "naive" },
	];
	/** Every uploaded document, in order; `metadata` fills in when its `meta_fields` PATCH lands. */
	readonly uploads: Array<{ dataset_id: string; document_id: string; name: string; content: string; metadata: Record<string, string> }> = [];
	/** Every document id a delete call removed, in order. */
	readonly deleted: string[] = [];
	/** Every document on the plane, by id. */
	readonly documents: Record<string, FakeDocument> = {};
	/** `done` parses after `parseDonePolls` polls; `never` stays running so timeout logic is provable; `fail` fails on the first poll. */
	parseBehavior: "done" | "never" | "fail" = "done";
	/**
	 * Polls before a `done` parse reads `DONE`. Two by default, so a poller
	 * provably re-reads; tests that drive ingest through `Substrate` — whose
	 * production cadence sleeps 2 s between polls — set 1 to stay inside the
	 * runner's 5 s budget.
	 */
	parseDonePolls = 2;
	private nextDoc = 1;
	/** A dataset's served chunks, by dataset id. Tests replace entries for redaction proofs. */
	readonly chunks: Record<string, FakeChunk[]> = {
		[BERLIN_ID]: seedChunks(BERLIN_ID, "https://example.com/agent-substrate/data-planes"),
		[HAMM_ID]: seedChunks(HAMM_ID, "https://example.com/programming-desk/architecture"),
		[LEIPZIG_ID]: seedChunks(LEIPZIG_ID, "https://example.com/agent-skills/review"),
	};

	/** A `fetch` over this fake, for injection into the plane client. */
	readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = (init?.method ?? "GET").toUpperCase();
		let body: unknown = null;
		let parts: Array<{ name: string; text: string }> | null = null;
		if (init?.body instanceof FormData) {
			parts = [];
			for (const part of init.body.getAll("file")) {
				if (part instanceof Blob) parts.push({ name: part instanceof File ? part.name : "file", text: await part.text() });
			}
			body = { multipart: { file: parts.map((part) => ({ name: part.name, bytes: Buffer.byteLength(part.text, "utf8") })) } };
		} else if (typeof init?.body === "string" && init.body.length > 0) {
			try {
				body = JSON.parse(init.body);
			} catch {
				body = init.body;
			}
		}
		const query = Object.fromEntries(url.searchParams.entries());
		this.requests.push({ method, path: url.pathname, body, query });
		const segments = url.pathname.split("/");
		if (method === "POST" && url.pathname === "/api/v1/retrieval") return this.retrieval(body);
		if (method === "GET" && url.pathname === "/api/v1/datasets") return this.datasetList();
		if (method === "POST" && url.pathname === "/api/v1/datasets") return this.createDataset(body);
		if (segments[1] === "api" && segments[2] === "v1" && segments[3] === "datasets" && segments[4]) {
			const datasetId = segments[4];
			if (segments[5] === "documents" && segments.length === 6) {
				if (method === "POST") return this.upload(datasetId, parts, body);
				if (method === "GET") return this.listDocuments(datasetId, query);
				if (method === "DELETE") return this.deleteDocuments(datasetId, body);
			}
			if (segments[5] === "documents" && segments.length === 7 && method === "PATCH") {
				return this.updateDocument(datasetId, segments[6] ?? "", body);
			}
			if (segments[5] === "chunks" && segments.length === 6 && method === "POST") return this.parse(datasetId, body);
		}
		return Response.json({ error: `fake has no route for ${method} ${url.pathname}` }, { status: 404 });
	};

	/** Every retrieval request body received, in order. */
	retrievals(): unknown[] {
		return this.requests.filter((request) => request.path === "/api/v1/retrieval").map((request) => request.body);
	}

	/** Every parse request body received, in order. */
	parses(): unknown[] {
		return this.requests.filter((request) => request.method === "POST" && request.path.endsWith("/chunks")).map((request) => request.body);
	}

	/** Every dataset-list request received, in order. */
	datasetLists(): RecordedRequest[] {
		return this.requests.filter((request) => request.method === "GET" && request.path === "/api/v1/datasets");
	}

	private retrieval(body: unknown): Response {
		if (this.failRetrievalWith !== null) return failure(100, "injected failure", this.failRetrievalWith);
		if (body === null || typeof body !== "object" || !("dataset_ids" in body) || !Array.isArray(body.dataset_ids) || body.dataset_ids.length === 0) {
			return failure(102, "`dataset_ids` is required.", 400);
		}
		const pageSize = "page_size" in body && typeof body.page_size === "number" ? body.page_size : 30;
		const out: Record<string, unknown>[] = [];
		for (const id of body.dataset_ids) {
			if (typeof id !== "string") continue;
			for (const chunk of this.chunks[id] ?? []) {
				if (this.chunkShape === "minimal") {
					out.push({ content: chunk.content, document_keyword: chunk.document_name });
				} else {
					out.push({
						content: chunk.content,
						content_ltks: chunk.content,
						document_id: chunk.document_id ?? "",
						document_keyword: chunk.document_name,
						highlight: chunk.content,
						id: chunk.chunk_id ?? "",
						image_id: "",
						important_keywords: [],
						dataset_id: id,
						positions: [],
						similarity: chunk.score ?? 0,
						term_similarity: chunk.score ?? 0,
						vector_similarity: chunk.score ?? 0,
					});
				}
			}
		}
		const page = out.slice(0, Math.max(0, pageSize));
		return Response.json({
			code: 0,
			data: {
				chunks: page,
				doc_aggs: [],
				total: out.length,
			},
		});
	}

	private datasetList(): Response {
		if (this.failListWith !== null) return failure(100, "injected failure", this.failListWith);
		return Response.json({
			code: 0,
			data: this.datasets.map((dataset) => ({
				id: dataset.id,
				name: dataset.name,
				embedding_model: dataset.embedding_model,
				chunk_method: dataset.chunk_method ?? "naive",
				document_count: Object.values(this.documents).filter((document) => document.dataset_id === dataset.id).length,
			})),
			total_datasets: this.datasets.length,
		});
	}

	private createDataset(body: unknown): Response {
		const name = body !== null && typeof body === "object" && "name" in body && typeof body.name === "string" ? body.name : "";
		if (!name) return failure(101, "Field: <name> - Message: <String should have at least 1 character> - Value: <>");
		const chunkMethod = body !== null && typeof body === "object" && "chunk_method" in body ? body.chunk_method : undefined;
		if (chunkMethod !== undefined && (typeof chunkMethod !== "string" || CHUNK_METHODS[chunkMethod] !== true)) {
			return failure(101, "Field: <chunk_method> - Message: <Input should be a valid chunk method>");
		}
		const embedding =
			body !== null && typeof body === "object" && "embedding_model" in body && typeof body.embedding_model === "string" ? body.embedding_model : "";
		// The reference: a taken name is created again with a numbered suffix,
		// never reused — so a client that skips discovery makes a duplicate.
		const taken = this.datasets.filter((dataset) => dataset.name.toLowerCase() === name.toLowerCase() || dataset.name.toLowerCase().startsWith(`${name.toLowerCase()}(`)).length;
		const created: FakeDataset = {
			id: `ds-created-${this.datasets.length + 1}-${name}`,
			name: taken === 0 ? name : `${name}(${taken})`,
			embedding_model: embedding,
			chunk_method: typeof chunkMethod === "string" ? chunkMethod : "naive",
		};
		this.datasets.push(created);
		this.chunks[created.id] = [];
		return Response.json({
			code: 0,
			data: { id: created.id, name: created.name, embedding_model: created.embedding_model, chunk_method: created.chunk_method, document_count: 0 },
		});
	}

	private upload(datasetId: string, parts: Array<{ name: string; text: string }> | null, body: unknown): Response {
		if (!this.datasets.some((dataset) => dataset.id === datasetId)) return failure(102, `You don't own the dataset ${datasetId}.`);
		// A JSON body is the pre-R6 rehearsal shape; the reference wants a file part.
		if (parts === null || parts.length === 0 || body === null || typeof body !== "object" || !("multipart" in body)) {
			return failure(101, "No file part!", 400);
		}
		const created: Array<Record<string, unknown>> = [];
		for (const part of parts) {
			const documentId = `doc-upload-${this.nextDoc}`;
			this.nextDoc += 1;
			const document: FakeDocument = { id: documentId, dataset_id: datasetId, name: part.name, run: "UNSTART", polls: 0, meta_fields: {} };
			this.documents[documentId] = document;
			this.uploads.push({ dataset_id: datasetId, document_id: documentId, name: part.name, content: part.text, metadata: document.meta_fields });
			created.push({
				chunk_method: "naive",
				created_by: "fake",
				dataset_id: datasetId,
				id: documentId,
				location: part.name,
				name: part.name,
				parser_config: { chunk_token_num: 128, delimiter: "\\n", html4excel: false, layout_recognize: "DeepDOC" },
				run: "UNSTART",
				size: Buffer.byteLength(part.text, "utf8"),
				thumbnail: "",
				type: "doc",
			});
		}
		return Response.json({ code: 0, data: created });
	}

	private updateDocument(datasetId: string, documentId: string, body: unknown): Response {
		if (this.failMetaWith !== null) return failure(100, "injected failure", this.failMetaWith);
		const document = this.documents[documentId];
		if (!document || document.dataset_id !== datasetId) return failure(102, `You don't own the document ${documentId}.`);
		if (body !== null && typeof body === "object" && "meta_fields" in body && body.meta_fields !== null && typeof body.meta_fields === "object") {
			for (const [key, value] of Object.entries(body.meta_fields)) {
				if (typeof value === "string") document.meta_fields[key] = value;
			}
		}
		return Response.json({ code: 0 });
	}

	private parse(datasetId: string, body: unknown): Response {
		if (body === null || typeof body !== "object" || !("document_ids" in body) || !Array.isArray(body.document_ids) || body.document_ids.length === 0) {
			return failure(102, "`document_ids` is required");
		}
		for (const id of body.document_ids) {
			const document = typeof id === "string" ? this.documents[id] : undefined;
			if (!document || document.dataset_id !== datasetId) return failure(102, `You don't own the document ${String(id)}.`);
		}
		for (const id of body.document_ids) {
			const document = typeof id === "string" ? this.documents[id] : undefined;
			if (document) {
				document.run = "RUNNING";
				document.polls = 0;
			}
		}
		return Response.json({ code: 0 });
	}

	private listDocuments(datasetId: string, query: Record<string, string>): Response {
		if (!this.datasets.some((dataset) => dataset.id === datasetId)) return failure(102, `You don't own the dataset ${datasetId}.`);
		const wanted = Object.values(this.documents).filter((document) => document.dataset_id === datasetId && (!query.id || document.id === query.id));
		for (const document of wanted) {
			if (document.run !== "RUNNING") continue;
			document.polls += 1;
			if (this.parseBehavior === "fail") document.run = "FAIL";
			else if (this.parseBehavior === "done" && document.polls >= this.parseDonePolls) document.run = "DONE";
		}
		return Response.json({
			code: 0,
			data: {
				docs: wanted.map((document) => ({
					chunk_count: document.run === "DONE" ? 1 : 0,
					id: document.id,
					knowledgebase_id: datasetId,
					location: document.name,
					name: document.name,
					meta_fields: { ...document.meta_fields },
					progress: document.run === "DONE" ? 1 : 0,
					progress_msg: document.run === "FAIL" ? "injected parse failure" : "",
					run: document.run,
					source_type: "local",
					status: "1",
					type: "doc",
				})),
				total_datasets: wanted.length,
			},
		});
	}

	private deleteDocuments(datasetId: string, body: unknown): Response {
		if (this.failDeleteWith !== null) return failure(100, "injected failure", this.failDeleteWith);
		if (!this.datasets.some((dataset) => dataset.id === datasetId)) return failure(102, `You don't own the dataset ${datasetId}.`);
		const ids = body !== null && typeof body === "object" && "ids" in body && Array.isArray(body.ids) ? body.ids : [];
		for (const id of ids) {
			if (typeof id !== "string") continue;
			const document = this.documents[id];
			if (!document || document.dataset_id !== datasetId) return failure(102, `Documents not found: ${id}`);
			delete this.documents[id];
			this.deleted.push(id);
		}
		return Response.json({ code: 0 });
	}
}
