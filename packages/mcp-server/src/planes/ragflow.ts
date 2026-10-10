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
 * Ported from `21652a2:packages/mcp-server/src/planes.ts` (D25-03): the
 * `planesFromEnv` trim plus trailing-slash strip, the
 * `authorization: Bearer` carriage, and the retrieval skeleton
 * (`POST {url}/api/v1/retrieval`, `{question, page, page_size}`,
 * `data.chunks[]`). The RESP client, `anchorMemoOnDevnet` and `teachable.ts`
 * are deliberately not ported.
 */
export interface RagflowConfig {
	url: string;
	apiKey: string;
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

/** One retrieval result, in either known response shape (U-01). */
export interface RagflowChunk {
	content: string;
	document_name: string;
	document_id?: string;
	chunk_id?: string;
	heading_path?: string;
	source_url?: string;
	score?: number;
}

export interface RetrievalRequest {
	question: string;
	/** Explicit dataset ids, resolved from configured names. Never empty. */
	dataset_ids: string[];
	page?: number;
	/** Clamped to <= 10 on the wire (D25-03). */
	page_size?: number;
}

export type RetrievalOutcome =
	| { ok: true; chunks: RagflowChunk[] }
	| { ok: false; reason: string };

/** The most results one retrieval may ask for (D25-03). */
export const MAX_RETRIEVAL_PAGE_SIZE = 10;
/**
 * The pinned embedding model for every dataset this phase creates (D25-06,
 * decided at 05-02). No chat model is registered; retrieval only.
 */
export const DATASET_EMBEDDING_MODEL = "tei-bge-small";

/** The fetch surface the plane client needs: injectable for rehearsal fakes. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Retrieve chunks for a question over explicit dataset ids.
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
	let response: Response;
	try {
		response = await fetchImpl(`${config.url}/api/v1/retrieval`, {
			method: "POST",
			headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
			body: JSON.stringify({
				question: request.question,
				dataset_ids: request.dataset_ids,
				page: request.page ?? 1,
				page_size: pageSize,
			}),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (cause) {
		return { ok: false, reason: `ragflow unreachable: ${String(cause instanceof Error ? cause.message : cause).slice(0, 200)}` };
	}
	if (!response.ok) return { ok: false, reason: `ragflow ${response.status}` };
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return { ok: false, reason: "ragflow: response was not JSON" };
	}
	if (body === null || typeof body !== "object" || !("data" in body)) {
		return { ok: false, reason: "ragflow: unexpected response shape" };
	}
	const data = body.data;
	if (data === null || typeof data !== "object" || !("chunks" in data) || !Array.isArray(data.chunks)) {
		return { ok: false, reason: "ragflow: unexpected response shape" };
	}
	const raw = data.chunks;
	const chunks: RagflowChunk[] = [];
	for (const entry of raw) {
		if (entry === null || typeof entry !== "object") continue;
		if (!("content" in entry) || typeof entry.content !== "string") continue;
		const documentName = "document_name" in entry && typeof entry.document_name === "string" ? entry.document_name : "doc";
		const documentId = "document_id" in entry && typeof entry.document_id === "string" ? entry.document_id : undefined;
		const chunkId = "chunk_id" in entry && typeof entry.chunk_id === "string" ? entry.chunk_id : undefined;
		const headingPath = "heading_path" in entry && typeof entry.heading_path === "string" ? entry.heading_path : undefined;
		const sourceUrl = "source_url" in entry && typeof entry.source_url === "string" ? entry.source_url : undefined;
		const score = "score" in entry && typeof entry.score === "number" ? entry.score : undefined;
		chunks.push({
			content: entry.content,
			document_name: documentName,
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

/**
 * Discover datasets by name (`GET /api/v1/datasets`), so creation only ever
 * happens on a name-miss (D25-06). Transport failures are a reason, not a throw.
 */
export async function listDatasets(
	config: RagflowConfig,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 4000,
): Promise<DatasetListOutcome> {
	let response: Response;
	try {
		response = await fetchImpl(`${config.url}/api/v1/datasets`, {
			method: "GET",
			headers: { authorization: `Bearer ${config.apiKey}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (cause) {
		return { ok: false, reason: `ragflow unreachable: ${String(cause instanceof Error ? cause.message : cause).slice(0, 200)}` };
	}
	if (!response.ok) return { ok: false, reason: `ragflow ${response.status}` };
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return { ok: false, reason: "ragflow: dataset list was not JSON" };
	}
	if (body === null || typeof body !== "object") {
		return { ok: false, reason: "ragflow: unexpected dataset list shape" };
	}
	const listed = "data" in body && Array.isArray(body.data)
		? body.data
		: "datasets" in body && Array.isArray(body.datasets)
			? body.datasets
			: null;
	if (!listed) return { ok: false, reason: "ragflow: unexpected dataset list shape" };
	const datasets: RagflowDataset[] = [];
	for (const entry of listed) {
		if (entry === null || typeof entry !== "object") continue;
		if (!("id" in entry) || !("name" in entry)) continue;
		if (typeof entry.id === "string" && typeof entry.name === "string") datasets.push({ id: entry.id, name: entry.name });
	}
	return { ok: true, datasets };
}

/** The ingest metadata every upload sends, so retrieval can echo it (U-03). */
export interface UploadMetadata {
	source_url: string;
	commit: string;
	heading_path: string;
}

export interface UploadRequest {
	dataset_id: string;
	content: string;
	metadata: UploadMetadata;
}

export type UploadOutcome =
	| { ok: true; document_id: string }
	| { ok: false; reason: string };

/**
 * Upload one redacted page. The exact parse paths are the rehearsal shape
 * (U-02): G1/G3 confirm them against the deployment.
 */
export async function uploadDocument(
	config: RagflowConfig,
	request: UploadRequest,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 8000,
): Promise<UploadOutcome> {
	let response: Response;
	try {
		response = await fetchImpl(`${config.url}/api/v1/datasets/${encodeURIComponent(request.dataset_id)}/documents`, {
			method: "POST",
			headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
			body: JSON.stringify({ content: request.content, metadata: request.metadata }),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (cause) {
		return { ok: false, reason: `ragflow unreachable: ${String(cause instanceof Error ? cause.message : cause).slice(0, 200)}` };
	}
	if (!response.ok) return { ok: false, reason: `ragflow ${response.status}` };
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return { ok: false, reason: "ragflow: upload answer was not JSON" };
	}
	if (body === null || typeof body !== "object" || !("data" in body)) {
		return { ok: false, reason: "ragflow: unexpected upload shape" };
	}
	const data = body.data;
	if (data === null || typeof data !== "object" || !("document_id" in data) || typeof data.document_id !== "string") {
		return { ok: false, reason: "ragflow: unexpected upload shape" };
	}
	return { ok: true, document_id: data.document_id };
}

export interface PollOptions {
	maxPolls?: number;
	intervalMs?: number;
	timeoutMs?: number;
}

/**
 * Poll a document's parse status until done. A parse that never finishes is
 * a timeout reason — never a hang, never a throw.
 */
export async function pollParseStatus(
	config: RagflowConfig,
	documentId: string,
	fetchImpl: FetchLike = fetch,
	opts: PollOptions = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const maxPolls = opts.maxPolls ?? 10;
	const intervalMs = opts.intervalMs ?? 100;
	const timeoutMs = opts.timeoutMs ?? 4000;
	for (let poll = 0; poll < maxPolls; poll += 1) {
		let response: Response;
		try {
			response = await fetchImpl(`${config.url}/api/v1/documents/${encodeURIComponent(documentId)}/parse`, {
				method: "GET",
				headers: { authorization: `Bearer ${config.apiKey}` },
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (cause) {
			return { ok: false, reason: `ragflow unreachable: ${String(cause instanceof Error ? cause.message : cause).slice(0, 200)}` };
		}
		if (!response.ok) return { ok: false, reason: `ragflow ${response.status}` };
		const body: unknown = await response.json().catch((): unknown => null);
		const status =
			body !== null && typeof body === "object" && "data" in body && body.data !== null && typeof body.data === "object" && "status" in body.data
				? body.data.status
				: null;
		if (status === "done") return { ok: true };
		if (poll < maxPolls - 1 && intervalMs > 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, intervalMs);
			await promise;
		}
	}
	return { ok: false, reason: "parse-timeout" };
}

export type CreateDatasetOutcome =
	| { ok: true; id: string }
	| { ok: false; reason: string };

/**
 * Create a dataset with the pinned embedding model (D25-06).
 *
 * Called only on a discovery name-miss: reuse first, create never as a
 * duplicate. Real product-dataset creation is a gated live step (G2).
 */
export async function createDataset(
	config: RagflowConfig,
	name: string,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 8000,
): Promise<CreateDatasetOutcome> {
	let response: Response;
	try {
		response = await fetchImpl(`${config.url}/api/v1/datasets`, {
			method: "POST",
			headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
			body: JSON.stringify({ name, embedding_model: DATASET_EMBEDDING_MODEL }),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (cause) {
		return { ok: false, reason: `ragflow unreachable: ${String(cause instanceof Error ? cause.message : cause).slice(0, 200)}` };
	}
	if (!response.ok) return { ok: false, reason: `ragflow ${response.status}` };
	const body: unknown = await response.json().catch((): unknown => null);
	const id =
		body !== null && typeof body === "object" && "data" in body && body.data !== null && typeof body.data === "object" && "id" in body.data
			? body.data.id
			: null;
	if (typeof id !== "string") return { ok: false, reason: "ragflow: unexpected dataset shape" };
	return { ok: true, id };
}
