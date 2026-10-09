/**
 * RAGFlow HTTP client — the one seam every docs door uses (D25-14, D25-23).
 *
 * The substrate never talks to the RAGFlow MCP server (0.26.1 is broken,
 * #16369): this client calls RAGFlow's HTTP API with `RAGFLOW_URL` and
 * `RAGFLOW_API_KEY`, sending the key only as `Authorization: Bearer` to the
 * configured origin and never following a cross-origin redirect. Tests inject
 * a fake transport; no test performs a real network call.
 *
 * ── RESEARCH note (Task 1, D25-17) ──────────────────────────────────────────
 * No live calls were made for this note: it is recorded from local sources
 * only — the shapes a prior live session observed (a seed client covering
 * upload/documents/parse/delete/list, a retrieval probe) and the integration
 * notes beside the other deployment. Deployed version tag: 0.27.1
 * (infiniflow/ragflow).
 *
 * Confirmed shapes at 0.27.1:
 * - Auth is `Authorization: Bearer <key>` on every call.
 * - Every response is an envelope `{code, message, data}`; `code` 0 (or
 *   absent) is success, anything else is a failure. Observed body codes:
 *   109 = authentication, 108 = permission, 101/102 = bad argument.
 * - Retrieval: `POST /api/v1/retrieval` with `{question, dataset_ids, page,
 *   page_size, similarity_threshold}` (plus optional `top_k` and
 *   `vector_similarity_weight`); the answer is `{code, data: {chunks, total}}`
 *   where each chunk carries `{id, content, document_id, dataset_id,
 *   similarity}` and often `document_keyword` (the file name).
 * - Dataset list: `GET /api/v1/datasets?page=&page_size=` answers
 *   `{code, data: [...], total}`; rows carry at least `{id, name}`.
 * - Dataset create: `POST /api/v1/datasets` with `{name, description,
 *   chunk_method: "naive"}` (a fuller `parser_config` body is accepted on
 *   some versions and rejected on others — the client retries minimal).
 *   The embedding model is set with `PUT /api/v1/datasets/{id}`
 *   `{embedding_model}`.
 * - Document list: `GET /api/v1/datasets/{id}/documents?page=&page_size=`
 *   answers `{code, data: {docs: [...]}}`; each doc carries `{id, name}` and
 *   a parse-run field `run` with string values `UNSTART`/`FAIL`/`CANCEL`/
 *   `DONE` (numeric `0`/`2`/`4` seen for the same states).
 * - Upload: `POST /api/v1/datasets/{id}/documents` as multipart with each
 *   file in a `file` field.
 * - Metadata: `PUT /api/v1/datasets/{id}/documents/{doc}` with
 *   `{meta_fields}`.
 * - Parse: `POST /api/v1/datasets/{id}/chunks` with `{document_ids}`.
 * - Delete: `DELETE /api/v1/datasets/{id}/documents` with `{ids}`.
 * - Health probe: `GET /api/v1/datasets?page=1&page_size=1`. Never the
 *   system health endpoints — on the operator's deployment they block the
 *   single API worker for minutes while it retries an unreachable store.
 *
 * D25-17 enforcement choice ("only the current version is searchable"):
 * neither a document enable/disable flag nor a retrieval `document_ids`
 * filter appears in the observed sources, so the client does NOT assume
 * either. The default is preference 3, a post-filter against the manifest
 * (plan 25-02), using the confirmed `run` + `meta_fields` reads above.
 * Preferences 1 and 2 stay OPEN for the operator live step (plan 25-01
 * verification): confirm against the deployed 0.27.1 tag whether a document
 * status toggle or a retrieval-side filter exists before later plans build
 * on it. The single-document status endpoint is likewise unconfirmed —
 * status is read through the document list.
 */
import type { RagflowConfig } from "../config.ts";
import { redact, redactKnown } from "../redact.ts";

export class RagflowError extends Error {}

/** Injectable transport; tests pass a fake, production passes `fetch`. */
export type RagflowFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Follows only same-origin redirects, and at most this many. */
const MAX_REDIRECTS = 3;
/** RAGFlow error text is redacted, then cut to this many characters (D25-03). */
const MAX_ERROR_TEXT = 200;

function cut(text: string): string {
	return text.length > MAX_ERROR_TEXT ? text.slice(0, MAX_ERROR_TEXT) : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return "";
}

function numberField(record: Record<string, unknown>, keys: string[]): number {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return 0;
}

export interface RetrievalHit {
	chunkId: string;
	documentId: string;
	datasetId: string;
	content: string;
	score: number;
	documentName: string | undefined;
	raw: unknown;
}

export interface RagflowDatasetSummary {
	id: string;
	name: string;
	embeddingModel: string | undefined;
}

export interface RagflowDocument {
	id: string;
	name: string;
	/** Parse-run state: UNSTART/FAIL/CANCEL/DONE (see the RESEARCH note). */
	run: string;
	metaFields: Record<string, unknown>;
	raw: unknown;
}

export interface UploadFile {
	filename: string;
	content: string | Uint8Array;
	contentType?: string;
}

export interface UploadedDocument {
	documentId: string;
	name: string | undefined;
}

export class RagflowClient {
	private readonly origin: string;
	private readonly apiKey: string;
	private readonly timeoutMs: number;
	private readonly transport: RagflowFetch;

	constructor(config: RagflowConfig, transport: RagflowFetch = fetch) {
		this.origin = config.url.replace(/\/+$/, "");
		this.apiKey = config.apiKey ?? "";
		this.timeoutMs = config.timeoutMs;
		this.transport = transport;
	}

	/** Whether the client holds a URL and a key. A `problem` config never does. */
	get configured(): boolean {
		return this.origin.length > 0 && this.apiKey.length > 0;
	}

	/** Redact first, then cut, so a cut can never leave half a secret (D25-02). */
	private sanitized(text: string): string {
		return cut(redact(redactKnown(text, [this.apiKey, this.origin])));
	}

	private async send(url: string, init: { method: string; body?: string | FormData; contentType?: string }): Promise<Response> {
		try {
			return await this.transport(url, {
				method: init.method,
				headers: {
					authorization: `Bearer ${this.apiKey}`,
					...(init.contentType ? { "content-type": init.contentType } : {}),
				},
				body: init.body,
				redirect: "manual",
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (cause) {
			// AbortSignal.timeout() aborts with TimeoutError; an aborted fetch
			// surfaces AbortError. Both mean the configured budget ran out.
			if (cause instanceof DOMException && (cause.name === "AbortError" || cause.name === "TimeoutError")) {
				throw new RagflowError(`ragflow timeout after ${this.timeoutMs}ms`);
			}
			throw new RagflowError(`ragflow unreachable: ${this.sanitized(String(cause))}`);
		}
	}

	private async readBody(response: Response): Promise<unknown> {
		const text = await response.text();
		if (!response.ok) throw new RagflowError(`ragflow ${response.status}: ${this.sanitized(text)}`);
		let body: unknown;
		try {
			body = JSON.parse(text) as unknown;
		} catch {
			throw new RagflowError("ragflow returned non-JSON");
		}
		const envelope = asRecord(body);
		if (envelope && typeof envelope.code === "number" && envelope.code !== 0) {
			const message = typeof envelope.message === "string" ? envelope.message : "";
			throw new RagflowError(`ragflow error ${envelope.code}: ${this.sanitized(message)}`);
		}
		if (envelope && "data" in envelope) return envelope.data;
		return body;
	}

	private async request(
		path: string,
		init: { method: string; json?: unknown; form?: FormData },
	): Promise<unknown> {
		let url = new URL(path, this.origin);
		const body: string | FormData | undefined = init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json));
		const contentType = init.form ? undefined : init.json === undefined ? undefined : "application/json";
		for (let redirects = 0; ; redirects += 1) {
			const response = await this.send(url.toString(), { method: init.method, body, contentType });
			if (response.status < 300 || response.status >= 400) return this.readBody(response);
			const location = response.headers.get("location");
			const next = location ? new URL(location, url) : null;
			// The refusal names no URL: the reason never carries it (D25-03).
			if (!next || next.origin !== this.origin) throw new RagflowError("ragflow refused a cross-origin redirect");
			if (redirects >= MAX_REDIRECTS) throw new RagflowError("ragflow redirected too many times");
			url = next;
		}
	}

	/**
	 * Search explicitly named datasets. `datasetIds` must be non-empty —
	 * callers resolve registry names to ids first, so other tenants' datasets
	 * can never be searched (D25-01).
	 */
	async retrieval(options: {
		question: string;
		datasetIds: string[];
		pageSize: number;
		similarityThreshold?: number;
	}): Promise<RetrievalHit[]> {
		if (options.datasetIds.length === 0) {
			throw new RagflowError("ragflow retrieval needs explicit dataset_ids");
		}
		const data = await this.request("/api/v1/retrieval", {
			method: "POST",
			json: {
				question: options.question,
				dataset_ids: options.datasetIds,
				page: 1,
				page_size: options.pageSize,
				...(options.similarityThreshold === undefined
					? {}
					: { similarity_threshold: options.similarityThreshold }),
			},
		});
		const holder = asRecord(data);
		const chunks = Array.isArray(data) ? data : (holder ? holder.chunks : undefined);
		if (!Array.isArray(chunks)) throw new RagflowError("ragflow returned no chunks");
		const hits: RetrievalHit[] = [];
		for (const chunk of chunks) {
			const record = asRecord(chunk);
			if (!record) throw new RagflowError("ragflow returned no chunks");
			const content = stringField(record, ["content"]);
			const chunkId = stringField(record, ["id", "chunk_id"]);
			if (!content || !chunkId) continue;
			hits.push({
				chunkId,
				documentId: stringField(record, ["document_id", "doc_id"]),
				datasetId: stringField(record, ["dataset_id"]),
				content,
				score: numberField(record, ["similarity", "score", "weight"]),
				documentName: stringField(record, ["document_keyword", "docnm_kwd"]) || undefined,
				raw: chunk,
			});
		}
		return hits;
	}

	/** First page of the dataset list (page_size 100): enough for the registry. */
	async listDatasets(): Promise<RagflowDatasetSummary[]> {
		const data = await this.request("/api/v1/datasets?page=1&page_size=100", { method: "GET" });
		const holder = asRecord(data);
		const rows = Array.isArray(data) ? data : (holder ? holder.datasets : undefined);
		if (!Array.isArray(rows)) throw new RagflowError("ragflow returned no datasets");
		const out: RagflowDatasetSummary[] = [];
		for (const row of rows) {
			const record = asRecord(row);
			if (!record) throw new RagflowError("ragflow returned no datasets");
			const id = stringField(record, ["id"]);
			const name = stringField(record, ["name"]);
			if (!id || !name) continue;
			out.push({ id, name, embeddingModel: stringField(record, ["embedding_model"]) || undefined });
		}
		return out;
	}

	/** First page of a dataset's documents with their parse-run state. */
	async listDocuments(datasetId: string, page = 1, pageSize = 100): Promise<RagflowDocument[]> {
		const data = await this.request(
			`/api/v1/datasets/${encodeURIComponent(datasetId)}/documents?page=${page}&page_size=${pageSize}`,
			{ method: "GET" },
		);
		const holder = asRecord(data);
		const rows = Array.isArray(data) ? data : (holder ? (holder.docs ?? holder.documents) : undefined);
		if (!Array.isArray(rows)) throw new RagflowError("ragflow returned no documents");
		const out: RagflowDocument[] = [];
		for (const row of rows) {
			const record = asRecord(row);
			if (!record) throw new RagflowError("ragflow returned no documents");
			const id = stringField(record, ["id"]);
			if (!id) continue;
			const meta = asRecord(record.meta_fields) ?? {};
			out.push({ id, name: stringField(record, ["name"]), run: String(record.run ?? ""), metaFields: meta, raw: row });
		}
		return out;
	}

	/** Upload files as multipart `file` fields; returns the created documents. */
	async uploadDocuments(datasetId: string, files: UploadFile[]): Promise<UploadedDocument[]> {
		const form = new FormData();
		for (const file of files) {
			form.append(
				"file",
				new Blob([file.content], { type: file.contentType ?? "text/plain" }),
				file.filename,
			);
		}
		const data = await this.request(`/api/v1/datasets/${encodeURIComponent(datasetId)}/documents`, {
			method: "POST",
			form,
		});
		const holder = asRecord(data);
		const rows = Array.isArray(data) ? data : (holder ? (holder.documents ?? holder.document_ids) : undefined);
		if (!Array.isArray(rows)) return [];
		const out: UploadedDocument[] = [];
		for (const row of rows) {
			if (typeof row === "string") {
				out.push({ documentId: row, name: undefined });
				continue;
			}
			const record = asRecord(row);
			if (!record) continue;
			const documentId = stringField(record, ["id", "document_id"]);
			if (documentId) out.push({ documentId, name: stringField(record, ["name"]) || undefined });
		}
		return out;
	}

	/** Queue parsing for already-uploaded documents. */
	async parseDocuments(datasetId: string, documentIds: string[]): Promise<void> {
		await this.request(`/api/v1/datasets/${encodeURIComponent(datasetId)}/chunks`, {
			method: "POST",
			json: { document_ids: documentIds },
		});
	}

	/** Record idempotency metadata on a document. */
	async updateDocument(
		datasetId: string,
		documentId: string,
		patch: { name?: string; metaFields?: Record<string, unknown> },
	): Promise<void> {
		await this.request(
			`/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}`,
			{
				method: "PUT",
				json: {
					...(patch.name === undefined ? {} : { name: patch.name }),
					...(patch.metaFields === undefined ? {} : { meta_fields: patch.metaFields }),
				},
			},
		);
	}

	/** Delete documents of old versions. */
	async deleteDocuments(datasetId: string, documentIds: string[]): Promise<void> {
		await this.request(`/api/v1/datasets/${encodeURIComponent(datasetId)}/documents`, {
			method: "DELETE",
			json: { ids: documentIds },
		});
	}

	/**
	 * Resolve a registry name to its id, creating the dataset with the
	 * configured embedding model when missing. Search never calls this —
	 * only the first ingest into a dataset does (D25-14).
	 */
	async ensureDataset(
		name: string,
		options: { description?: string; embeddingModel?: string; chunkMethod?: string } = {},
	): Promise<string> {
		const existing = (await this.listDatasets()).find((dataset) => dataset.name === name);
		if (existing) {
			if (options.embeddingModel && existing.embeddingModel !== options.embeddingModel) {
				await this.request(`/api/v1/datasets/${encodeURIComponent(existing.id)}`, {
					method: "PUT",
					json: { embedding_model: options.embeddingModel },
				});
			}
			return existing.id;
		}
		const chunkMethod = options.chunkMethod ?? "naive";
		const full = {
			name,
			...(options.description === undefined ? {} : { description: options.description.slice(0, 500) }),
			chunk_method: chunkMethod,
			parser_config: {
				chunk_token_num: 512,
				delimiter: "\n",
				html4excel: false,
				layout_recognize: "DeepDOC",
				raptor: { use_raptor: false },
			},
		};
		let data: unknown;
		try {
			data = await this.request("/api/v1/datasets", { method: "POST", json: full });
		} catch {
			// Some versions reject parser_config keys — fall back to defaults.
			data = await this.request("/api/v1/datasets", {
				method: "POST",
				json: {
					name,
					...(options.description === undefined ? {} : { description: options.description.slice(0, 500) }),
					chunk_method: chunkMethod,
				},
			});
		}
		const created = asRecord(data) ?? {};
		const id = stringField(created, ["id", "dataset_id"]);
		if (!id) throw new RagflowError("ragflow created a dataset without an id");
		if (options.embeddingModel) {
			await this.request(`/api/v1/datasets/${encodeURIComponent(id)}`, {
				method: "PUT",
				json: { embedding_model: options.embeddingModel },
			});
		}
		return id;
	}
}
