/**
 * The LightRAG HTTP client, parallel to `ragflow.ts` (drop-in adapter).
 *
 * Reached ONLY through substrate-mcp, like the RAGFlow plane: no agent
 * config registers a LightRAG MCP server and no package outside
 * `mcp-server` imports this module. Every function mirrors the RAGFlow
 * plane's contract so callers can swap planes without reshaping data:
 * retrieval resolves to the exact `RagflowChunk` shape and
 * `RetrievalOutcome`, uploads resolve to `{ document_id }`, and every
 * failure is a `{ ok: false, reason }` — never a throw inside an agent's
 * turn, never a secret in a reason string.
 *
 * Endpoint map (LightRAG server, live-unattested — same caveat as the
 * RAGFlow plane's G1–G4 operator gate):
 * - retrieve: `POST /query` `{ query, mode, top_k, only_need_context }`.
 *   Graph modes are `hybrid` and `mix` (both fuse local entity detail
 *   with global relation context); planning callers ask for graph
 *   explicitly via `mode` or the `/hybrid` / `/mix` question prefix.
 * - upload: `POST /documents/upload` (multipart field `file`), falling
 *   back to `POST /documents/text` when the upload route is absent.
 * - parse/scan: `POST /documents/scan` (the pipeline trigger; LightRAG
 *   has no per-document parse call, so `parseDocuments` keeps the
 *   RAGFlow `(datasetId, documentIds)` signature and fans in).
 * - poll: `GET /documents/pipeline_status` until idle.
 *
 * Wire pattern matches `ragflow.ts`: one bearer-keyed `call` with an
 * injected `fetchImpl` (production hands in a `gatedFetch` over the
 * plane's circuit breaker), `lightragOp` as the bounded metric label,
 * and the business `code`/`status` in the body checked independently
 * of the HTTP status.
 */
import type { LightragConfig } from "../config.ts";
import type { CitationGraphProvenance, PlanningGraphRelation, SearchGraphStats } from "../types.ts";
import type { RagflowChunk } from "./ragflow.ts";

/** The LightRAG query modes; `hybrid` and `mix` are the graph modes. */
export type LightragQueryMode = "naive" | "local" | "global" | "hybrid" | "mix";

/** The default retrieval mode: graph (`hybrid`) so planning sees relations. */
export const DEFAULT_QUERY_MODE: LightragQueryMode = "hybrid";

/** The modes that fuse the knowledge graph (local + global). */
const GRAPH_MODE: Record<string, true> = { hybrid: true, mix: true };

/**
 * Whether a mode fuses the knowledge graph. `hybrid` is the default
 * graph blend; `mix` is the deeper multi-hop blend planning passes ask
 * for.
 */
export function isGraphMode(mode: LightragQueryMode): boolean {
	return GRAPH_MODE[mode] === true;
}

/**
 * The bounded operation label for one LightRAG request, from its method
 * and path. A fixed table, never the path itself: track and document ids
 * would otherwise become metric series.
 */
export function lightragOp(method: string, url: string): string {
	const path = url.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/\?.*$/, "");
	if (path === "/query") return "query";
	if (path === "/documents/upload" || path === "/documents/text") return "upload";
	if (path === "/documents/scan") return "scan";
	if (path === "/documents/pipeline_status") return "pipeline-status";
	if (path === "/documents" || path.startsWith("/documents")) {
		if (method === "DELETE") return "document-delete";
		return "documents";
	}
	return "other";
}

/** The reason a transport failure becomes; an open breaker is named as such. */
function unreachable(cause: unknown): string {
	if (cause instanceof Error && cause.name === "BreakerOpenError") return "lightrag circuit open";
	return `lightrag unreachable: ${String(cause instanceof Error ? cause.message : cause).slice(0, 200)}`;
}

// NOTE: the substrate's LightRAG reach is read ONLY by `lightragFromEnv`
// in `../config.ts` (`LIGHTRAG_URL` required, `LIGHTRAG_API_KEY`
// optional). This plane never defines its own reader — one reader, no
// drift — and the key never appears in a reason string.

/** Drop-in chunk shape: exactly the RAGFlow plane's chunk. */
export type LightragChunk = RagflowChunk;

export interface LightragRetrievalRequest {
	question: string;
	/**
	 * Query mode. Defaults to `hybrid` (graph). `mix` is the deeper graph
	 * blend for planning passes that need multi-hop relations.
	 */
	mode?: LightragQueryMode;
	/** Most chunks to ask for. Clamped to <= 10 on the wire (D25-03). */
	topK?: number;
	/**
	 * Accepted and ignored: LightRAG serves one knowledge base per
	 * server, so there is nothing to scope. Present only so RAGFlow
	 * call sites type-check unchanged.
	 */
	dataset_ids?: string[];
	/** Accepted and mapped to `top_k`, for RAGFlow call-site parity. */
	page_size?: number;
}

/** The most results one retrieval may ask for (D25-03). */
export const MAX_LIGHTRAG_TOP_K = 10;

const QUERY_MODE_PREFIXES: Readonly<Record<string, LightragQueryMode>> = {
	"/mix": "mix",
	"/hybrid": "hybrid",
};

/**
 * Resolve the query mode: an explicit `mode` wins, else a leading
 * `/mix` or `/hybrid` question prefix selects the graph mode and is
 * stripped from the query, else the graph default (`hybrid`).
 */
export function resolveQueryMode(
	question: string,
	requested?: LightragQueryMode,
): { mode: LightragQueryMode; query: string } {
	if (requested !== undefined) return { mode: requested, query: question };
	const head = question.trimStart().slice(0, 8).toLowerCase();
	for (const [prefix, mode] of Object.entries(QUERY_MODE_PREFIXES)) {
		if (head === prefix || head.startsWith(`${prefix} `) || head.startsWith(`${prefix}\n`)) {
			return { mode, query: question.replace(new RegExp(`^\\s*${prefix}\\s*`, "i"), "") };
		}
	}
	return { mode: DEFAULT_QUERY_MODE, query: question };
}

/** The fetch surface the plane client needs: injectable for rehearsal fakes. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * The business result inside a LightRAG body: `code: 0` (RAGFlow-style)
 * or `status: "success"` is success; any other code, or a
 * `status: "error" | "failed" | "failure"`, is a failure whatever the
 * HTTP status said. Bodies without either signal carry no verdict.
 */
function businessFailure(body: unknown): string | null {
	if (body === null || typeof body !== "object") return null;
	if ("code" in body) {
		const code = body.code;
		if (code === 0 || code === undefined || code === null || code === "0") return null;
		const message = "message" in body && typeof body.message === "string" ? `: ${body.message.slice(0, 200)}` : "";
		return `lightrag code ${String(code)}${message}`;
	}
	if ("status" in body && typeof body.status === "string") {
		const status = body.status.toLowerCase();
		if (status === "success" || status === "succeeded" || status === "ok") return null;
		if (status === "error" || status === "failed" || status === "failure") {
			const message = "message" in body && typeof body.message === "string" ? `: ${body.message.slice(0, 200)}` : "";
			return `lightrag ${status}${message}`;
		}
	}
	return null;
}

/** The `data` member of a success envelope, or the body itself. */
function dataOf(body: unknown): unknown {
	if (body !== null && typeof body === "object" && "data" in body) return body.data;
	return body;
}

/** One request with the API-key header; a transport failure is the reason. */
async function call(
	config: LightragConfig,
	fetchImpl: FetchLike,
	path: string,
	init: { method: string; body?: RequestInit["body"]; json?: boolean; timeoutMs: number },
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
	let response: Response;
	try {
		response = await fetchImpl(`${config.url}${path}`, {
			method: init.method,
			headers: {
				// LightRAG servers check `X-API-Key`; the bearer form is
				// sent alongside for deployments fronted by a gateway.
				// Neither header value ever enters a reason string. The key
				// is optional (`lightragFromEnv` allows keyless reach), so
				// both headers are omitted when it is absent — never a
				// `Bearer undefined` on the wire.
				...(config.apiKey ? { "x-api-key": config.apiKey, authorization: `Bearer ${config.apiKey}` } : {}),
				...(init.json ? { "content-type": "application/json" } : {}),
			},
			...(init.body !== undefined ? { body: init.body } : {}),
			signal: AbortSignal.timeout(init.timeoutMs),
		});
	} catch (cause) {
		return { ok: false, reason: unreachable(cause) };
	}
	if (response.status === 401 || response.status === 403) return { ok: false, reason: `lightrag ${response.status}` };
	if (!response.ok) return { ok: false, reason: `lightrag ${response.status}` };
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return { ok: false, reason: "lightrag: response was not JSON" };
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
 * Map one LightRAG context entry onto the exact `RagflowChunk` shape:
 * `title`/`file_path` become `document_name`, `snippet`/`text` become
 * `content`, `url` becomes `source_url`, `score` stays `score`. Entries
 * without usable text are skipped; entries without a title cite `"doc"`.
 */
function toChunk(entry: unknown): RagflowChunk | null {
	if (entry === null || typeof entry !== "object") return null;
	if (Array.isArray(entry)) return null;
	const content = readString(entry, "content", "text", "snippet", "excerpt", "chunk_content", "chunk");
	if (content === undefined) return null;
	const documentId = readString(entry, "document_id", "doc_id", "track_id");
	const chunkId = readString(entry, "chunk_id", "id", "chunkId");
	const headingPath = readString(entry, "heading_path", "heading");
	const sourceUrl = readString(entry, "source_url", "url", "source", "file_path", "file_source");
	const score = readNumber(entry, "score", "similarity", "similarity_score", "relevance_score", "rank_score");
	return {
		content,
		document_name: readString(entry, "document_name", "document_keyword", "title", "file_path", "file_source", "source") ?? "doc",
		...(documentId !== undefined ? { document_id: documentId } : {}),
		...(chunkId !== undefined ? { chunk_id: chunkId } : {}),
		...(headingPath !== undefined ? { heading_path: headingPath } : {}),
		...(sourceUrl !== undefined ? { source_url: sourceUrl } : {}),
		...(score !== undefined ? { score } : {}),
	};
}

/** Collect candidate context entries from the shapes `/query` may return. */
function contextEntries(data: unknown, body: unknown): unknown[] {
	if (Array.isArray(data)) return data;
	if (data !== null && typeof data === "object") {
		for (const key of ["contexts", "chunks", "documents", "results", "sources"]) {
			if (key in data && Array.isArray((data as Record<string, unknown>)[key])) {
				return (data as Record<string, unknown>)[key] as unknown[];
			}
		}
	}
	if (body !== null && typeof body === "object" && "response" in body) {
		const response = (body as Record<string, unknown>).response;
		if (Array.isArray(response)) return response;
		if (typeof response === "string" && response.length > 0) return [{ content: response }];
	}
	return [];
}

/**
 * Retrieve chunks for a question (`POST /query`, `{ query, mode, top_k,
 * only_need_context: true }`). Graph modes (`hybrid`, the default, and
 * `mix`) fuse local entity detail with global relation context — the
 * planning pass asks for `mix` explicitly or prefixes the question with
 * `/mix`.
 *
 * Transport, auth (401/403) and shape failures come back as
 * `{ ok: false, reason }` — never a throw inside an agent's turn. An
 * empty question is a reason, not a network call.
 * The success outcome carries the backend's graph `detail` beside the chunks.
 */
export async function retrieveChunks(
	config: LightragConfig,
	request: LightragRetrievalRequest,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 4000,
): Promise<LightragQueryOutcome> {
	return queryWithGraph(config, request.question, fetchImpl, {
		...(request.mode !== undefined ? { mode: request.mode } : {}),
		...(request.topK ?? request.page_size !== undefined ? { topK: request.topK ?? request.page_size ?? MAX_LIGHTRAG_TOP_K } : {}),
		timeoutMs,
	});
}

/**
 * Graph detail behind a `/query` envelope, in the canonical `types.ts`
 * vocabulary. `counts` feeds `SearchReply.graph`-shaped accounting;
 * `provenance` feeds `SearchCitation.provenance`-shaped attribution.
 * Empty lists mean the backend served chunks without graph attribution —
 * never undefined, per the `types.ts` contract.
 */
export interface LightragGraphDetail {
	mode: LightragQueryMode;
	counts: SearchGraphStats;
	provenance: CitationGraphProvenance;
}

function graphNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const names: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string") {
			if (entry.length > 0) names.push(entry);
		} else if (entry !== null && typeof entry === "object") {
			const edge = entry as Record<string, unknown>;
			const source = typeof edge.source === "string" ? edge.source : null;
			const target = typeof edge.target === "string" ? edge.target : null;
			const kind = typeof edge.kind === "string" ? edge.kind : null;
			if (source !== null && target !== null) names.push(kind ? `${source} -[${kind}]-> ${target}` : `${source} -> ${target}`);
			else {
				const name = readString(entry, "name", "entity", "label");
				if (name !== undefined) names.push(name);
			}
		}
	}
	return names;
}

function graphField(data: unknown, ...names: string[]): unknown {
	if (data === null || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	for (const name of names) {
		if (name in record) return record[name];
	}
	if ("graph" in record && record.graph !== null && typeof record.graph === "object") {
		const nested = record.graph as Record<string, unknown>;
		for (const name of names) {
			if (name in nested) return nested[name];
		}
	}
	return undefined;
}

/**
 * Read graph detail out of a `/query` envelope (`data.entities` /
 * `data.relations`, or the same under `data.graph`). Counts are what the
 * backend reported; 0 means none or unknown.
 */
export function readGraphDetail(data: unknown, mode: LightragQueryMode): LightragGraphDetail {
	const entities = graphNames(graphField(data, "entities"));
	const relations = graphNames(graphField(data, "relations", "relationships", "edges"));
	return {
		mode,
		counts: { entities: entities.length, relations: relations.length },
		provenance: { entities, relations: relations.length },
	};
}

export type LightragQueryOutcome =
	| { ok: true; chunks: RagflowChunk[]; detail: LightragGraphDetail }
	| { ok: false; reason: string };

/**
 * `retrieveChunks` with the graph detail kept: the docs-search dispatch
 * uses `chunks` for citations and `detail` for the reply-level graph
 * counts and per-citation provenance.
 */
export async function queryWithGraph(
	config: LightragConfig,
	question: string,
	fetchImpl: FetchLike = fetch,
	opts: { mode?: LightragQueryMode; topK?: number; timeoutMs?: number } = {},
): Promise<LightragQueryOutcome> {
	if (question.trim().length === 0) return { ok: false, reason: "lightrag: empty query" };
	const resolved = resolveQueryMode(question, opts.mode);
	if (resolved.query.trim().length === 0) return { ok: false, reason: "lightrag: empty query" };
	const topK = Math.max(1, Math.min(opts.topK ?? MAX_LIGHTRAG_TOP_K, MAX_LIGHTRAG_TOP_K));
	const answered = await call(config, fetchImpl, "/query", {
		method: "POST",
		json: true,
		body: JSON.stringify({ query: resolved.query, mode: resolved.mode, top_k: topK, only_need_context: true }),
		timeoutMs: opts.timeoutMs ?? 4000,
	});
	if (!answered.ok) return answered;
	const data = dataOf(answered.body);
	const chunks: RagflowChunk[] = [];
	for (const entry of contextEntries(data, answered.body)) {
		const chunk = toChunk(entry);
		if (chunk !== null) chunks.push(chunk);
	}
	if (chunks.length === 0) {
		// An actually empty payload is a shape failure, never a silent
		// empty answer.
		return { ok: false, reason: "lightrag: unexpected response shape" };
	}
	return { ok: true, chunks, detail: readGraphDetail(data, resolved.mode) };
}

/**
 * Injector-shaped retrieval for the docs-search LightRAG dispatch:
 * `(question, datasetIds, fetchImpl) → RetrievalOutcome` with the exact
 * `RagflowChunk` shape. LightRAG serves one knowledge base per server,
 * so `datasetIds` select nothing and are accepted-ignored (never the
 * RAGFlow throw): scope is a no-op, not an error, on this plane.
 */
export async function retrieveForSearch(
	config: LightragConfig,
	question: string,
	datasetIds: readonly string[],
	fetchImpl: FetchLike = fetch,
	timeoutMs = 4000,
): Promise<LightragQueryOutcome> {
	void datasetIds;
	return retrieveChunks(config, { question }, fetchImpl, timeoutMs);
}

/** The ingest metadata every upload carries, so retrieval can echo it. */
export interface LightragUploadMetadata {
	source_url: string;
	commit: string;
	heading_path: string;
	/**
	 * Planning-graph entities for this page (LightRAG planning scrape):
	 * carried so the vector insert keeps its graph attribution. Absent or
	 * empty means no graph bias — the upload shape is unchanged.
	 */
	graph_entities?: string[];
	/**
	 * Planning-graph relations for this page: the directed edges the scrape
	 * extracted, indexed with the document. Absent or empty means no edge
	 * bias — the upload shape is unchanged.
	 */
	graph_relations?: PlanningGraphRelation[];
}

export interface LightragUploadRequest {
	/** The document name on the plane: the page's repo path, flattened. */
	name: string;
	content: string;
	metadata: LightragUploadMetadata;
}

export type LightragUploadOutcome =
	| { ok: true; document_id: string }
	| { ok: false; reason: string };

function uploadDocumentId(data: unknown): string | undefined {
	if (data === null || typeof data !== "object") return undefined;
	if (Array.isArray(data)) {
		const first: unknown = data[0];
		if (first !== null && typeof first === "object") return readString(first, "track_id", "document_id", "doc_id", "id");
		return undefined;
	}
	const direct = readString(data, "track_id", "document_id", "doc_id", "id");
	if (direct !== undefined) return direct;
	if ("track_id" in data && typeof (data as Record<string, unknown>).track_id === "string") {
		return (data as Record<string, unknown>).track_id as string;
	}
	return undefined;
}

/**
 * Upload one redacted page as a document (`POST /documents/upload`,
 * multipart form field `file`, → `{ status, data: { track_id } }`),
 * falling back to `POST /documents/text` (`{ text, file_source }`)
 * where the multipart route is absent. The ingest metadata travels as
 * trailing form fields on the upload and as members of the text body,
 * so retrieval can echo the source URL either way. A missing id in a
 * success body is a shape failure, not a silent empty upload.
 */
export async function uploadDocument(
	config: LightragConfig,
	request: LightragUploadRequest,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 8000,
): Promise<LightragUploadOutcome> {
	const form = new FormData();
	form.append("file", new Blob([request.content], { type: "text/markdown" }), request.name);
	form.append("file_source", request.name);
	form.append("source_url", request.metadata.source_url);
	form.append("commit", request.metadata.commit);
	form.append("heading_path", request.metadata.heading_path);
	// Graph attribution rides along only when the scrape extracted it;
	// the form and the text fallback carry the same list, so a plane that
	// serves either route indexes the same vectors.
	const graphEntities = request.metadata.graph_entities?.filter((entity) => entity.length > 0) ?? [];
	if (graphEntities.length > 0) form.append("graph_entities", JSON.stringify(graphEntities));
	const graphRelations = request.metadata.graph_relations?.filter(
		(relation) => relation.source.length > 0 && relation.target.length > 0 && relation.kind.length > 0,
	) ?? [];
	if (graphRelations.length > 0) form.append("graph_relations", JSON.stringify(graphRelations));
	const uploaded = await call(config, fetchImpl, "/documents/upload", { method: "POST", body: form, timeoutMs });
	if (uploaded.ok) {
		const documentId = uploadDocumentId(dataOf(uploaded.body));
		if (documentId === undefined) return { ok: false, reason: "lightrag: unexpected upload shape" };
		return { ok: true, document_id: documentId };
	}
	if (!uploaded.reason.startsWith("lightrag 404")) return uploaded;
	const texted = await call(config, fetchImpl, "/documents/text", {
		method: "POST",
		json: true,
		body: JSON.stringify({
			text: request.content,
			file_source: request.name,
			source_url: request.metadata.source_url,
			commit: request.metadata.commit,
			heading_path: request.metadata.heading_path,
			...(graphEntities.length > 0 ? { graph_entities: graphEntities } : {}),
			...(graphRelations.length > 0 ? { graph_relations: graphRelations } : {}),
		}),
		timeoutMs,
	});
	if (!texted.ok) return texted;
	const documentId = uploadDocumentId(dataOf(texted.body));
	if (documentId === undefined) return { ok: false, reason: "lightrag: unexpected upload shape" };
	return { ok: true, document_id: documentId };
}

/**
 * Vector-ingest one planning-scrape page: the sanitized markdown becomes a
 * LightRAG document whose metadata carries the source URL, commit,
 * heading path and the scrape's graph entities, so the insert indexes the
 * same vectors the query path fuses (`hybrid`/`mix`). REST/JSON throughout,
 * via {@link uploadDocument} (multipart with a text fallback). A transport
 * or shape failure is a reason, never a throw.
 */
export interface StorePlanningPageRequest {
	/** The page's repo path, e.g. `.planning/phases/03-x/PLAN.md`. */
	path: string;
	/** The page's source URL (the scan's `file://` URL). */
	sourceUrl: string;
	/** Sanitized markdown to index. */
	body: string;
	/** The commit the ingest carries, or omitted for unpinned. */
	commit?: string;
	/** Heading path within the page, when the caller tracked one. */
	headingPath?: string;
	/** Graph entities the scrape extracted for this page. */
	entities?: readonly string[];
	/** Graph relations the scrape extracted for this page. */
	relations?: readonly PlanningGraphRelation[];
}

export async function storePlanningPage(
	config: LightragConfig,
	request: StorePlanningPageRequest,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 8000,
): Promise<LightragUploadOutcome> {
	return uploadDocument(
		config,
		{
			name: documentName(request.path),
			content: request.body,
			metadata: {
				source_url: request.sourceUrl,
				commit: request.commit ?? "unpinned",
				heading_path: request.headingPath ?? "",
				...(request.entities !== undefined && request.entities.length > 0 ? { graph_entities: [...request.entities] } : {}),
				...(request.relations !== undefined && request.relations.length > 0 ? { graph_relations: [...request.relations] } : {}),
			},
		},
		fetchImpl,
		timeoutMs,
	);
}

export interface LightragPollOptions {
	maxPolls?: number;
	intervalMs?: number;
	timeoutMs?: number;
}

/**
 * Trigger the LightRAG pipeline over newly uploaded documents
 * (`POST /documents/scan`). The plane scans the input directory rather
 * than named documents, so `documentIds` are accepted for the RAGFlow
 * drop-in signature and ignored on the wire.
 */
export async function scanDocuments(
	config: LightragConfig,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 8000,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const answered = await call(config, fetchImpl, "/documents/scan", {
		method: "POST",
		json: true,
		body: JSON.stringify({}),
		timeoutMs,
	});
	return answered.ok ? { ok: true } : answered;
}

/**
 * Start parsing uploaded documents. Drop-in alias for `scanDocuments`
 * keeping the RAGFlow `(datasetId, documentIds)` signature: LightRAG
 * has one knowledge base per server, so both arguments are accepted
 * and ignored on the wire.
 */
export async function parseDocuments(
	config: LightragConfig,
	datasetId: string,
	documentIds: readonly string[],
	fetchImpl: FetchLike = fetch,
	timeoutMs = 8000,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	void datasetId;
	void documentIds;
	return scanDocuments(config, fetchImpl, timeoutMs);
}

/**
 * Poll the pipeline until idle (`GET /documents/pipeline_status` →
 * `{ status: "idle" }`). A busy pipeline past `maxPolls` is a
 * `parse-timeout` reason; a failed pipeline names the plane's message —
 * never a hang, never a throw. `document_id` is accepted for the
 * RAGFlow drop-in signature (the status is server-global) and never
 * enters the reason.
 */
export async function pollParseStatus(
	config: LightragConfig,
	document: { dataset_id: string; document_id: string },
	fetchImpl: FetchLike = fetch,
	opts: LightragPollOptions = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
	void document;
	const maxPolls = opts.maxPolls ?? 10;
	const intervalMs = opts.intervalMs ?? 100;
	const timeoutMs = opts.timeoutMs ?? 4000;
	for (let poll = 0; poll < maxPolls; poll += 1) {
		const answered = await call(config, fetchImpl, "/documents/pipeline_status", { method: "GET", timeoutMs });
		if (!answered.ok) return answered;
		const data = dataOf(answered.body);
		const status = (data !== null && typeof data === "object" ? readString(data, "status", "pipeline_status") : undefined) ?? "";
		const idle = status.toLowerCase();
		if (idle === "idle" || idle === "done" || idle === "completed" || idle === "success") return { ok: true };
		if (idle === "failed" || idle === "failure" || idle === "error") {
			const message =
				data !== null && typeof data === "object" ? (readString(data, "message", "progress_msg", "error") ?? "") : "";
			return { ok: false, reason: `parse-failed: ${idle}${message ? ` ${message.slice(0, 200)}` : ""}` };
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
 * Delete documents by id (`DELETE /documents` `{ doc_ids }`). The only
 * destructive call on the plane; mirrors the RAGFlow prune's one caller
 * besides the upload's own clean-up. `datasetId` is accepted for the
 * drop-in signature and ignored on the wire.
 */
export async function deleteDocuments(
	config: LightragConfig,
	datasetId: string,
	documentIds: readonly string[],
	fetchImpl: FetchLike = fetch,
	timeoutMs = 8000,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	void datasetId;
	if (documentIds.length === 0) return { ok: true };
	const answered = await call(config, fetchImpl, "/documents", {
		method: "DELETE",
		json: true,
		body: JSON.stringify({ doc_ids: [...documentIds] }),
		timeoutMs,
	});
	return answered.ok ? { ok: true } : answered;
}

/**
 * The document name a page uploads under: its repo path with `/`
 * flattened to `__`, so `docs/a/README.md` and `README.md` never
 * collide and the suffix (`.md`) survives for the plane's type
 * detection. Identical to the RAGFlow plane's mapping so both planes
 * address the same logical document.
 */
export function documentName(path: string): string {
	return path.replace(/^\/+/, "").replace(/\//g, "__");
}
