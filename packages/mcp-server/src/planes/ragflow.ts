/**
 * The RAGFlow HTTP client, reached ONLY through substrate-mcp (D25-01).
 *
 * No agent config registers a RAGFlow MCP server and no package outside
 * `mcp-server` imports this module; `store-lock.test.ts` enforces both.
 * Retrieval always carries explicit `dataset_ids` with `page_size <= 10`
 * (D25-03): the acc30a8 stub shape — retrieval without `dataset_ids`
 * returning a raw body — is forbidden, and the recording fake in
 * `ragflow-fake.ts` fails any call that omits them.
 *
 * Shapes per the HTTP API reference (https://ragflow.io/docs/http_api_reference,
 * read 2026-10-13; uplift-2 R6), live-unattested: no call here has yet been
 * made against the deployment (Phase 25 G1–G4 stay operator-gated). The
 * sections relied on are named at each function. Two things the reference
 * states that every parser below honours: the HTTP status and the business
 * `code` in the body are separate signals (`code: 0` is success, anything
 * else a failure even under HTTP 200), and a dataset name that is already
 * taken is created again with a numbered suffix — which is why discovery by
 * name runs before every create.
 *
 * Every call goes out through the `fetchImpl` the caller injects; production
 * hands in a `gatedFetch` over the plane's circuit breaker (uplift-2 R2), and
 * `ragflowOp` is the bounded label that fetch records per route. An open
 * breaker surfaces as the reason `ragflow circuit open`, so docs search and
 * ingest degrade exactly as they do for an unreachable plane.
 */
export interface RagflowConfig {
	url: string;
	apiKey: string;
}

/**
 * The bounded operation label for one RAGFlow request, from its method and
 * path. A fixed table, never the path itself: dataset and document ids would
 * otherwise become metric series.
 */
export function ragflowOp(method: string, url: string): string {
	const path = url.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/\?.*$/, "");
	if (path === "/api/v1/retrieval") return "retrieve";
	if (path === "/api/v1/datasets") return method === "POST" ? "dataset-create" : "datasets";
	if (/^\/api\/v1\/datasets\/[^/]+\/documents$/.test(path)) {
		if (method === "POST") return "upload";
		if (method === "DELETE") return "document-delete";
		return "documents";
	}
	if (/^\/api\/v1\/datasets\/[^/]+\/documents\/[^/]+$/.test(path)) return "document-update";
	if (/^\/api\/v1\/datasets\/[^/]+\/chunks$/.test(path)) return "parse";
	return "other";
}

/** The reason a transport failure becomes; an open breaker is named as such. */
function unreachable(cause: unknown): string {
	if (cause instanceof Error && cause.name === "BreakerOpenError") return "ragflow circuit open";
	return `ragflow unreachable: ${String(cause instanceof Error ? cause.message : cause).slice(0, 200)}`;
}

/**
 * The substrate's RAGFlow reach, or null when it has none.
 *
 * Reads `RAGFLOW_URL` / `RAGFLOW_API_KEY` only (D25-02). `RAGFLOW_MCP_URL`
 * names the RAGFlow MCP transport this phase deliberately does not use
 * (self-host mode serves the tenant's datasets to any caller with no
 * dataset control), so it is never read here even when it is set.
 */
export function ragflowFromEnv(env: Record<string, string | undefined> = process.env): RagflowConfig | null {
	const url = env.RAGFLOW_URL?.trim();
	const apiKey = env.RAGFLOW_API_KEY?.trim();
	if (!url || !apiKey) return null;
	return { url: url.replace(/\/+$/, ""), apiKey };
}

/**
 * One retrieval result. The documented chunk names its document
 * `document_keyword`, its own id `id` and its score `similarity`; the
 * earlier rehearsal names (`document_name`, `chunk_id`, `score`) are still
 * read when present (U-01), as are `heading_path` and `source_url` should a
 * deployment echo document metadata on chunks — the reference does not
 * promise either. The contract fake omits both; the rehearsal stand-in
 * echoes them only when `serveUploadsAsChunks` is set.
 */
export interface RagflowChunk {
	content: string;
	document_name: string;
	document_id?: string;
	chunk_id?: string;
	heading_path?: string;
	source_url?: string;
	score?: number;
}

/**
 * The retrieval tuning the reference documents on `POST /api/v1/retrieval`
 * (§Retrieve chunks). The defaults are RAGFlow's own, so an unset knob
 * changes nothing on the wire but makes the choice explicit:
 * `similarity_threshold` 0.2; `vector_similarity_weight` 0.3 — the
 * "legacy fallback" of `keywords_similarity_weight` (0.7), the two summing
 * to 1; `top_k` 1024 — documented as a deprecated alias of `knn_top_k` with
 * the same default, kept because it is the name the reference lists first
 * and the deployment version is unattested.
 * `rerankId` is sent as `rerank_id` only when set: RAGFlow ships no reranker by default (D46-b).
 */
export interface RetrievalKnobs {
	similarityThreshold: number;
	vectorSimilarityWeight: number;
	topK: number;
	/** A reranker model id sent as `rerank_id`; absent means no reranker and no field on the wire. */
	rerankId?: string;
}

export const DEFAULT_RETRIEVAL_KNOBS: Readonly<RetrievalKnobs> = { similarityThreshold: 0.2, vectorSimilarityWeight: 0.3, topK: 1024 };

export interface RetrievalRequest {
	question: string;
	/** Explicit dataset ids, resolved from configured names. Never empty. */
	dataset_ids: string[];
	page?: number;
	/** Clamped to <= 10 on the wire (D25-03). */
	page_size?: number;
	/** The three documented tuning fields; RAGFlow's defaults when omitted. */
	retrieval?: RetrievalKnobs;
}

export type RetrievalOutcome =
	| { ok: true; chunks: RagflowChunk[] }
	| { ok: false; reason: string };

/** The most results one retrieval may ask for (D25-03). */
export const MAX_RETRIEVAL_PAGE_SIZE = 10;
/**
 * The pinned embedding model for every dataset this phase creates (D25-06,
 * decided at 05-02). No chat model is registered; retrieval only. The
 * reference documents `model_name@model_factory` as the format; whether the
 * deployment accepts this bare name is live-unattested (G2).
 */
export const DATASET_EMBEDDING_MODEL = "tei-bge-small";
/**
 * The documented built-in chunk method sent on create (§Create dataset,
 * `"naive"`: General, the server default). The 1.0 Go migration note on the
 * same page renames it `parser_id: "general"`; which backend the deployment
 * runs is live-unattested, so the canonical field is sent.
 */
export const DATASET_CHUNK_METHOD = "naive";

/** The fetch surface the plane client needs: injectable for rehearsal fakes. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * The business result inside a RAGFlow body (§ERROR CODES): `code: 0` is
 * success; any other code is a failure whatever the HTTP status said.
 */
function businessFailure(body: unknown): string | null {
	if (body === null || typeof body !== "object" || !("code" in body)) return null;
	const code = body.code;
	if (code === 0 || code === undefined || code === null) return null;
	const message = "message" in body && typeof body.message === "string" ? `: ${body.message.slice(0, 200)}` : "";
	return `ragflow code ${String(code)}${message}`;
}

/** The `data` member of a success envelope, or null. */
function dataOf(body: unknown): unknown {
	return body !== null && typeof body === "object" && "data" in body ? body.data : null;
}

/** One request with the bearer header; a transport failure is the reason. */
async function call(
	config: RagflowConfig,
	fetchImpl: FetchLike,
	path: string,
	init: { method: string; body?: RequestInit["body"]; json?: boolean; timeoutMs: number },
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
	let response: Response;
	try {
		response = await fetchImpl(`${config.url}${path}`, {
			method: init.method,
			headers: {
				authorization: `Bearer ${config.apiKey}`,
				...(init.json ? { "content-type": "application/json" } : {}),
			},
			...(init.body !== undefined ? { body: init.body } : {}),
			signal: AbortSignal.timeout(init.timeoutMs),
		});
	} catch (cause) {
		return { ok: false, reason: unreachable(cause) };
	}
	if (!response.ok) return { ok: false, reason: `ragflow ${response.status}` };
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return { ok: false, reason: "ragflow: response was not JSON" };
	}
	const failure = businessFailure(body);
	if (failure !== null) return { ok: false, reason: failure };
	return { ok: true, body };
}

function readString(entry: object, ...names: string[]): string | undefined {
	for (const name of names) {
		if (name in entry) {
			const value = (entry as Record<string, unknown>)[name];
			if (typeof value === "string") return value;
		}
	}
	return undefined;
}

function readNumber(entry: object, ...names: string[]): number | undefined {
	for (const name of names) {
		if (name in entry) {
			const value = (entry as Record<string, unknown>)[name];
			if (typeof value === "number" && Number.isFinite(value)) return value;
		}
	}
	return undefined;
}

/**
 * Retrieve chunks for a question over explicit dataset ids (§Retrieve
 * chunks: `POST /api/v1/retrieval`, `{question, dataset_ids, page,
 * page_size, similarity_threshold, vector_similarity_weight, top_k[, rerank_id]}` →
 * `{code, data: {chunks: [...]}}`).
 *
 * Transport and shape failures come back as `{ok: false, reason}` — never a
 * throw inside an agent's turn. An empty `dataset_ids` is a programmer error
 * (the anti-pattern gate) and throws before any network call.
 */
export async function retrieveChunks(
	config: RagflowConfig,
	request: RetrievalRequest,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 4000,
): Promise<RetrievalOutcome> {
	if (request.dataset_ids.length === 0) {
		throw new Error("retrieveChunks needs explicit dataset_ids; unscoped retrieval is forbidden");
	}
	const pageSize = Math.max(1, Math.min(request.page_size ?? MAX_RETRIEVAL_PAGE_SIZE, MAX_RETRIEVAL_PAGE_SIZE));
	const knobs = request.retrieval ?? DEFAULT_RETRIEVAL_KNOBS;
	const answered = await call(config, fetchImpl, "/api/v1/retrieval", {
		method: "POST",
		json: true,
		body: JSON.stringify({
			question: request.question,
			dataset_ids: request.dataset_ids,
			page: request.page ?? 1,
			page_size: pageSize,
			similarity_threshold: knobs.similarityThreshold,
			vector_similarity_weight: knobs.vectorSimilarityWeight,
			top_k: knobs.topK,
			...(knobs.rerankId !== undefined ? { rerank_id: knobs.rerankId } : {}),
		}),
		timeoutMs,
	});
	if (!answered.ok) return answered;
	const data = dataOf(answered.body);
	if (data === null || typeof data !== "object" || !("chunks" in data) || !Array.isArray(data.chunks)) {
		return { ok: false, reason: "ragflow: unexpected response shape" };
	}
	const chunks: RagflowChunk[] = [];
	for (const entry of data.chunks) {
		if (entry === null || typeof entry !== "object") continue;
		if (!("content" in entry) || typeof entry.content !== "string") continue;
		const documentId = readString(entry, "document_id");
		const chunkId = readString(entry, "id", "chunk_id");
		const headingPath = readString(entry, "heading_path");
		const sourceUrl = readString(entry, "source_url");
		const score = readNumber(entry, "similarity", "score");
		chunks.push({
			content: entry.content,
			document_name: readString(entry, "document_keyword", "document_name") ?? "doc",
			...(documentId !== undefined ? { document_id: documentId } : {}),
			...(chunkId !== undefined ? { chunk_id: chunkId } : {}),
			...(headingPath !== undefined ? { heading_path: headingPath } : {}),
			...(sourceUrl !== undefined ? { source_url: sourceUrl } : {}),
			...(score !== undefined ? { score } : {}),
		});
	}
	return { ok: true, chunks };
}

/** One dataset as the discovery endpoint names it. */
export interface RagflowDataset {
	id: string;
	name: string;
}

export type DatasetListOutcome =
	| { ok: true; datasets: RagflowDataset[] }
	| { ok: false; reason: string };

/** The most datasets one discovery page asks for; the tenant holds seven. */
const DATASET_LIST_PAGE_SIZE = 100;

/**
 * Discover datasets by name (§List datasets: `GET /api/v1/datasets?page=
 * &page_size=` → `{code, data: [{id, name, …}]}`), so creation only ever
 * happens on a name-miss (D25-06). Transport failures are a reason, not a
 * throw.
 */
export async function listDatasets(
	config: RagflowConfig,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 4000,
): Promise<DatasetListOutcome> {
	const answered = await call(config, fetchImpl, `/api/v1/datasets?page=1&page_size=${DATASET_LIST_PAGE_SIZE}`, {
		method: "GET",
		timeoutMs,
	});
	if (!answered.ok) return answered;
	const listed = dataOf(answered.body);
	if (!Array.isArray(listed)) return { ok: false, reason: "ragflow: unexpected dataset list shape" };
	const datasets: RagflowDataset[] = [];
	for (const entry of listed) {
		if (entry === null || typeof entry !== "object") continue;
		const id = readString(entry, "id");
		const name = readString(entry, "name");
		if (id !== undefined && name !== undefined) datasets.push({ id, name });
	}
	return { ok: true, datasets };
}

/** The ingest metadata every upload carries, so retrieval can echo it (U-03). */
export interface UploadMetadata {
	source_url: string;
	commit: string;
	heading_path: string;
}

export interface UploadRequest {
	dataset_id: string;
	/** The document name on the plane: the page's repo path, flattened by `documentName`. */
	name: string;
	content: string;
	metadata: UploadMetadata;
}

export type UploadOutcome =
	| { ok: true; document_id: string }
	| { ok: false; reason: string };

/**
 * The document name a page uploads under: its repo path with `/` flattened
 * to `__`, so `docs/a/README.md` and `README.md` never collide and the
 * suffix (`.md`) survives for the plane's type detection.
 */
export function documentName(path: string): string {
	return path.replace(/^\/+/, "").replace(/\//g, "__");
}

/**
 * Upload one redacted page as a document (§Upload documents: `POST
 * /api/v1/datasets/{dataset_id}/documents`, multipart form field `file`,
 * → `{code, data: [{id, name, run: "UNSTART", …}]}`), then attach the
 * ingest metadata (§Update document: `PATCH /api/v1/datasets/{dataset_id}/
 * documents/{document_id}` `{meta_fields}` → `{code: 0}`). The upload has
 * no metadata slot of its own, so the two calls are one operation here: a
 * document whose metadata could not be set is deleted again best-effort
 * (§Delete documents) and the reason returned, rather than left on the
 * plane without its source URL.
 */
export async function uploadDocument(
	config: RagflowConfig,
	request: UploadRequest,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 8000,
): Promise<UploadOutcome> {
	const dataset = encodeURIComponent(request.dataset_id);
	const form = new FormData();
	form.append("file", new Blob([request.content], { type: "text/markdown" }), request.name);
	const uploaded = await call(config, fetchImpl, `/api/v1/datasets/${dataset}/documents`, { method: "POST", body: form, timeoutMs });
	if (!uploaded.ok) return uploaded;
	const data = dataOf(uploaded.body);
	const first = Array.isArray(data) ? data[0] : null;
	const documentId = first !== null && typeof first === "object" ? readString(first, "id") : undefined;
	if (documentId === undefined) return { ok: false, reason: "ragflow: unexpected upload shape" };
	const tagged = await call(config, fetchImpl, `/api/v1/datasets/${dataset}/documents/${encodeURIComponent(documentId)}`, {
		method: "PATCH",
		json: true,
		body: JSON.stringify({ meta_fields: request.metadata }),
		timeoutMs,
	});
	if (!tagged.ok) {
		await deleteDocuments(config, request.dataset_id, [documentId], fetchImpl, timeoutMs);
		return { ok: false, reason: `ragflow meta_fields: ${tagged.reason}` };
	}
	return { ok: true, document_id: documentId };
}

/**
 * Start parsing uploaded documents (§Parse documents: `POST /api/v1/datasets/
 * {dataset_id}/chunks` `{document_ids}` → `{code: 0}`). Upload alone leaves
 * a document `UNSTART`; nothing is retrievable until this call ran.
 */
export async function parseDocuments(
	config: RagflowConfig,
	datasetId: string,
	documentIds: readonly string[],
	fetchImpl: FetchLike = fetch,
	timeoutMs = 8000,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const answered = await call(config, fetchImpl, `/api/v1/datasets/${encodeURIComponent(datasetId)}/chunks`, {
		method: "POST",
		json: true,
		body: JSON.stringify({ document_ids: [...documentIds] }),
		timeoutMs,
	});
	return answered.ok ? { ok: true } : answered;
}

export interface PollOptions {
	maxPolls?: number;
	intervalMs?: number;
	timeoutMs?: number;
}

/**
 * The documented `run` states of a listed document (§List documents), in
 * both the text and the numeric spelling the reference gives.
 */
const RUN_DONE: Record<string, true> = { DONE: true, "3": true };
const RUN_FAILED: Record<string, true> = { FAIL: true, "4": true, CANCEL: true, "2": true };

/**
 * Poll a document's parse state until done (§List documents: `GET /api/v1/
 * datasets/{dataset_id}/documents?id={document_id}` → `{code, data: {docs:
 * [{id, run, progress_msg, …}]}}`). `DONE` is success; `FAIL` or `CANCEL`
 * is a failure naming the plane's progress message; a parse that never
 * finishes is a timeout reason — never a hang, never a throw.
 */
export async function pollParseStatus(
	config: RagflowConfig,
	document: { dataset_id: string; document_id: string },
	fetchImpl: FetchLike = fetch,
	opts: PollOptions = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const maxPolls = opts.maxPolls ?? 10;
	const intervalMs = opts.intervalMs ?? 100;
	const timeoutMs = opts.timeoutMs ?? 4000;
	const path = `/api/v1/datasets/${encodeURIComponent(document.dataset_id)}/documents?id=${encodeURIComponent(document.document_id)}&page=1&page_size=1`;
	for (let poll = 0; poll < maxPolls; poll += 1) {
		const answered = await call(config, fetchImpl, path, { method: "GET", timeoutMs });
		if (!answered.ok) return answered;
		const data = dataOf(answered.body);
		const docs = data !== null && typeof data === "object" && "docs" in data && Array.isArray(data.docs) ? data.docs : null;
		if (docs === null) return { ok: false, reason: "ragflow: unexpected document list shape" };
		const listed = docs.find((entry) => entry !== null && typeof entry === "object" && readString(entry, "id") === document.document_id);
		if (listed === undefined || listed === null || typeof listed !== "object") return { ok: false, reason: "parse-status: document not listed" };
		const run = String(readString(listed, "run") ?? readNumber(listed, "run") ?? "").toUpperCase();
		if (RUN_DONE[run] === true) return { ok: true };
		if (RUN_FAILED[run] === true) {
			const message = readString(listed, "progress_msg") ?? "";
			return { ok: false, reason: `parse-failed: ${run}${message ? ` ${message.slice(0, 200)}` : ""}` };
		}
		if (poll < maxPolls - 1 && intervalMs > 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, intervalMs);
			await promise;
		}
	}
	return { ok: false, reason: "parse-timeout" };
}

/**
 * Delete documents by id (§Delete documents: `DELETE /api/v1/datasets/
 * {dataset_id}/documents` `{ids}` → `{code: 0}`). The only destructive call
 * on the plane; the superseded-document prune behind
 * `SUBSTRATE_DOCS_PRUNE_SUPERSEDED` is its one caller besides the upload's
 * own clean-up.
 */
export async function deleteDocuments(
	config: RagflowConfig,
	datasetId: string,
	documentIds: readonly string[],
	fetchImpl: FetchLike = fetch,
	timeoutMs = 8000,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (documentIds.length === 0) return { ok: true };
	const answered = await call(config, fetchImpl, `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents`, {
		method: "DELETE",
		json: true,
		body: JSON.stringify({ ids: [...documentIds] }),
		timeoutMs,
	});
	return answered.ok ? { ok: true } : answered;
}

export type CreateDatasetOutcome =
	| { ok: true; id: string }
	| { ok: false; reason: string };

/**
 * Create a dataset with the pinned embedding model and the documented
 * chunk method (§Create dataset: `POST /api/v1/datasets` `{name,
 * embedding_model, chunk_method}` → `{code, data: {id, …}}`) (D25-06).
 *
 * Called only on a discovery name-miss: reuse first, create never as a
 * duplicate — the reference suffixes a taken name instead of refusing it.
 * Real product-dataset creation is a gated live step (G2).
 */
export async function createDataset(
	config: RagflowConfig,
	name: string,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 8000,
): Promise<CreateDatasetOutcome> {
	const answered = await call(config, fetchImpl, "/api/v1/datasets", {
		method: "POST",
		json: true,
		body: JSON.stringify({ name, embedding_model: DATASET_EMBEDDING_MODEL, chunk_method: DATASET_CHUNK_METHOD }),
		timeoutMs,
	});
	if (!answered.ok) return answered;
	const data = dataOf(answered.body);
	const id = data !== null && typeof data === "object" ? readString(data, "id") : undefined;
	if (id === undefined) return { ok: false, reason: "ragflow: unexpected dataset shape" };
	return { ok: true, id };
}
