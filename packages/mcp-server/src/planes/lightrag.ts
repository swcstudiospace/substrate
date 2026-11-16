/**
 * The LightRAG HTTP client, parallel to `ragflow.ts` (drop-in adapter).
 *
 * Reached ONLY through substrate-mcp, like the RAGFlow plane: no agent
 * config registers a LightRAG MCP server and no package outside
 * `mcp-server` imports this module. Every function mirrors the RAGFlow
 * plane's contract so callers can swap planes without reshaping data:
 * retrieval resolves to the exact `RagflowChunk` shape and
 * `RetrievalOutcome`, uploads resolve to `{ track_id }`, and every
 * failure is a `{ ok: false, reason }` — never a throw inside an agent's
 * turn, never a secret in a reason string.
 *
 * Endpoint map (LightRAG server v1.5.7; the contract is the upstream source,
 * recorded in `__fixtures__/lightrag-v1.5.7-routes.json` and enforced by
 * `lightrag.contract.test.ts`. No live server has been called yet):
 * - retrieve: `POST /query` `{ query, mode, top_k, only_need_context }`.
 *   Graph modes are `hybrid` and `mix` (both fuse local entity detail
 *   with global relation context); planning callers ask for graph
 *   explicitly via `mode` or the `/hybrid` / `/mix` question prefix.
 * - upload: `POST /documents/upload` (multipart field `file`), falling
 *   back to `POST /documents/text` when the upload route is absent. Both
 *   answer `{ status, message, track_id }`: the `track_id` is NOT a
 *   document id. A same-name document is HTTP 409 (replace needs an
 *   explicit delete first).
 * - document ids: `GET /documents/track_status/{track_id}` lists the real
 *   document ids once the background enqueue has written them.
 * - parse/scan: `POST /documents/scan` (the pipeline trigger; LightRAG
 *   has no per-document parse call, so `parseDocuments` keeps the
 *   RAGFlow `(datasetId, documentIds)` signature and fans in).
 * - poll: `GET /documents/pipeline_status` until `busy` is false.
 * - delete: `DELETE /documents/delete_document` `{ doc_ids }` (runs in the
 *   background). `DELETE /documents` is the clear-ALL route; the one
 *   choke point `call` refuses it before any network I/O, permanently.
 * - health: `GET /health`.
 *
 * Wire pattern matches `ragflow.ts`: one `call` with an injected
 * `fetchImpl` (production hands in a `gatedFetch` over the plane's
 * circuit breaker), `lightragOp` as the bounded metric label, and the
 * business `status` in the body checked independently of the HTTP
 * status. Auth is `X-API-Key` only: an `Authorization` bearer would be
 * validated as a JWT first and fail every call in API-key mode.
 */
import type { LightragConfig } from "../config.ts";
import { planningPageKey } from "../planning-hash-store.ts";
import { redact } from "../redact.ts";
import type { CitationGraphProvenance, PlanningGraphRelation, RagLightragChunk, SearchGraphStats } from "../types.ts";
import type { RagflowChunk } from "./ragflow.ts";

/** The LightRAG query modes; `hybrid` and `mix` are the graph modes. */
export type LightragQueryMode = "naive" | "local" | "global" | "hybrid" | "mix";

const QUERY_MODES: readonly string[] = ["naive", "local", "global", "hybrid", "mix"];

/** Whether a parsed value is one of the query modes this client sends. */
export function isLightragQueryMode(value: unknown): value is LightragQueryMode {
	return typeof value === "string" && QUERY_MODES.includes(value);
}

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
	if (path === "/health") return "health";
	if (path === "/documents/upload" || path === "/documents/text" || path === "/documents/texts") return "upload";
	if (path === "/documents/scan") return "scan";
	if (path === "/documents/pipeline_status") return "pipeline-status";
	if (path.startsWith("/documents/track_status/")) return "track-status";
	if (path === "/documents" || path.startsWith("/documents")) {
		if (method === "DELETE") return "document-delete";
		return "documents";
	}
	return "other";
}

/** The reason an open breaker gives a call it refused; callers do not retry it. */
export const LIGHTRAG_CIRCUIT_OPEN = "lightrag circuit open";

/** The reason a transport failure becomes; an open breaker is named as such. */
function unreachable(cause: unknown): string {
	if (cause instanceof Error && cause.name === "BreakerOpenError") return LIGHTRAG_CIRCUIT_OPEN;
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
	 * Query mode. Defaults to `config.queryMode` (`SUBSTRATE_LIGHTRAG_QUERY_MODE`),
	 * else `hybrid` (graph). `mix` is the deeper graph blend for planning
	 * passes that need multi-hop relations.
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
 * Resolve the query mode. Precedence, highest first: an explicit `mode`
 * the caller passed; a leading `/mix` or `/hybrid` question prefix (the
 * graph modes, stripped from the query, and honoured even when the
 * default is `naive`); `fallback` (the deployment's configured default,
 * `SUBSTRATE_LIGHTRAG_QUERY_MODE`); else the graph default (`hybrid`).
 */
export function resolveQueryMode(
	question: string,
	requested?: LightragQueryMode,
	fallback: LightragQueryMode = DEFAULT_QUERY_MODE,
): { mode: LightragQueryMode; query: string } {
	if (requested !== undefined) return { mode: requested, query: question };
	const head = question.trimStart().slice(0, 8).toLowerCase();
	for (const [prefix, mode] of Object.entries(QUERY_MODE_PREFIXES)) {
		if (head === prefix || head.startsWith(`${prefix} `) || head.startsWith(`${prefix}\n`)) {
			return { mode, query: question.replace(new RegExp(`^\\s*${prefix}\\s*`, "i"), "") };
		}
	}
	return { mode: fallback, query: question };
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

/** The reason the choke point gives a clear-all it refused before any network I/O. */
export const LIGHTRAG_CLEAR_ALL_REFUSED = "lightrag clear-all refused";

/**
 * Whether a request is LightRAG's clear-ALL route: a `DELETE` whose path is
 * `/documents` however it is spelled (trailing slash, query string,
 * fragment, dot segments, percent-encoding, case). Upstream
 * `DELETE /documents` deletes every document, entity, relationship and file
 * and ignores any body, so a per-document delete aimed at it would wipe the
 * index. A permanent denylist: nothing in this client may emit it.
 */
export function isClearAllRequest(method: string, path: string): boolean {
	if (method.toUpperCase() !== "DELETE") return false;
	const bare = path.replace(/^[a-z]+:\/\/[^/?#]+/i, "").replace(/[?#].*$/, "").replace(/\\/g, "/");
	let decoded = bare;
	try {
		decoded = decodeURIComponent(bare);
	} catch {
		// An undecodable path is judged by its raw text: the guard only ever refuses, so a malformed escape cannot loosen it.
	}
	const segments: string[] = [];
	for (const segment of decoded.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") segments.pop();
		else segments.push(segment);
	}
	return segments.length === 1 && segments[0]?.toLowerCase() === "documents";
}

/** The longest body detail a failed call carries. */
const FAILURE_DETAIL_CAP = 200;

/**
 * The cause an upstream non-2xx body names: FastAPI's `detail` when the body is JSON (a non-string `detail`, such as a
 * 422 validation list, is its JSON text), else the raw body text. Redacted, then capped, and absent when the body is
 * empty or unreadable. Never throws.
 */
async function failureDetail(response: Response): Promise<string | undefined> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		return undefined;
	}
	let picked = text;
	try {
		const parsed: unknown = JSON.parse(text);
		const detail = readMember(parsed, "detail");
		if (typeof detail === "string") picked = detail;
		else if (detail !== undefined) picked = JSON.stringify(detail) ?? text;
	} catch {
		// Not JSON: the raw text is the detail.
	}
	// Redact before the cap, so a token cut at the boundary is not left half-matched.
	const detail = redact(picked.trim()).slice(0, FAILURE_DETAIL_CAP);
	return detail.length > 0 ? detail : undefined;
}

/**
 * The single request choke point: every LightRAG call goes through here,
 * so the clear-all denylist and the auth header live in exactly one place.
 * Only `X-API-Key` is sent (never an `Authorization` bearer: upstream
 * `combined_auth` validates any bearer as a JWT first and answers 401 when
 * it is not one). The key is optional (`lightragFromEnv` allows keyless
 * reach) and never enters a reason string. Never throws: a transport
 * failure is the reason. A non-2xx answer other than 401/403 keeps its
 * `reason` (`lightrag <status>`, matched exactly elsewhere) and adds the
 * redacted, capped body as `detail`.
 */
async function call(
	config: LightragConfig,
	fetchImpl: FetchLike,
	path: string,
	init: { method: string; body?: RequestInit["body"]; json?: boolean; timeoutMs: number },
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string; detail?: string }> {
	if (isClearAllRequest(init.method, path)) return { ok: false, reason: LIGHTRAG_CLEAR_ALL_REFUSED };
	let response: Response;
	try {
		response = await fetchImpl(`${config.url}${path}`, {
			method: init.method,
			headers: {
				...(config.apiKey ? { "X-API-Key": config.apiKey } : {}),
				...(init.json ? { "content-type": "application/json" } : {}),
			},
			...(init.body !== undefined ? { body: init.body } : {}),
			signal: AbortSignal.timeout(init.timeoutMs),
		});
	} catch (cause) {
		return { ok: false, reason: unreachable(cause) };
	}
	if (response.status === 401 || response.status === 403) return { ok: false, reason: `lightrag ${response.status}` };
	if (!response.ok) {
		const detail = await failureDetail(response);
		return { ok: false, reason: `lightrag ${response.status}`, ...(detail !== undefined ? { detail } : {}) };
	}
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

/** `call`, exported for the contract test only: callers outside this plane use the typed functions below. */
export const lightragCall = call;

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
 * only_need_context: true }`). Graph modes (`hybrid`, the default unless
 * `config.queryMode` names another, and `mix`) fuse local entity detail with
 * global relation context — the planning pass asks for `mix` explicitly or
 * prefixes the question with `/mix`. A `naive` default (a LightRAG with no
 * real LLM, so no knowledge graph) retrieves vector chunks only.
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
	const resolved = resolveQueryMode(question, opts.mode, config.queryMode);
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

/**
 * The upload outcome. `track_id` is LightRAG's tracking id for the
 * enqueue, NOT a document id: resolve the real ids with
 * {@link resolveDocumentIds}. `conflict` marks HTTP 409: upstream refuses a
 * same-name document until the existing one is deleted.
 */
export type LightragUploadOutcome =
	| { ok: true; track_id: string }
	| { ok: false; reason: string; detail?: string; conflict?: true };

/** The reason an upload (or text insert) gets when LightRAG answers HTTP 409. */
export const LIGHTRAG_SAME_NAME_CONFLICT = "lightrag 409 same-name conflict";

function uploadTrackId(data: unknown): string | undefined {
	if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
	const trackId = readString(data, "track_id");
	return trackId !== undefined && trackId.trim().length > 0 ? trackId : undefined;
}

/** An upload failure as the outcome: HTTP 409 is the typed same-name conflict, anything else passes through. */
function uploadFailure(failure: { ok: false; reason: string; detail?: string }): LightragUploadOutcome {
	return failure.reason === "lightrag 409" ? { ok: false, reason: LIGHTRAG_SAME_NAME_CONFLICT, conflict: true } : failure;
}

/**
 * Upload one redacted page as a document (`POST /documents/upload`,
 * multipart form field `file`, → `{ status, message, track_id }`),
 * falling back to `POST /documents/text` (`{ text, file_source }`)
 * where the multipart route is absent. The ingest metadata travels as
 * trailing form fields on the upload and as members of the text body,
 * so retrieval can echo the source URL either way. A missing track id in
 * a success body is a shape failure, not a silent empty upload. HTTP 409
 * is the typed `conflict` outcome ({@link LIGHTRAG_SAME_NAME_CONFLICT}).
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
		const trackId = uploadTrackId(dataOf(uploaded.body));
		if (trackId === undefined) return { ok: false, reason: "lightrag: unexpected upload shape" };
		return { ok: true, track_id: trackId };
	}
	if (!uploaded.reason.startsWith("lightrag 404")) return uploadFailure(uploaded);
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
	if (!texted.ok) return uploadFailure(texted);
	const trackId = uploadTrackId(dataOf(texted.body));
	if (trackId === undefined) return { ok: false, reason: "lightrag: unexpected upload shape" };
	return { ok: true, track_id: trackId };
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
	/** The exact document name to store under, replacing the one derived from `checkout` and `path` (the bulk corpus scheme). */
	name?: string;
	/** The page's source URL (the scan's `file://` URL). */
	sourceUrl: string;
	/** The planning checkout key a `.planning/` page is held under: its document is named `<checkout>:<path>`. Other pages leave it unset. */
	checkout?: string;
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
			name: request.name ?? documentName(request.checkout === undefined ? request.path : planningPageKey(request.checkout, request.path)),
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
	/** Waits between polls; injected so tests never really wait. */
	sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
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
): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }> {
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
): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }> {
	void datasetId;
	void documentIds;
	return scanDocuments(config, fetchImpl, timeoutMs);
}

/** What one `GET /documents/pipeline_status` body says. */
type PipelineReading =
	| { kind: "idle" }
	| { kind: "busy" }
	| { kind: "failed"; detail: string }
	| { kind: "recovery"; message: string }
	| { kind: "unknown" };

/**
 * Read the pipeline state. Upstream `PipelineStatusResponse` (v1.5.7) has a
 * boolean `busy` and a `recovery_required` fence flag, and no `status`:
 * - `recovery_required: true` is the workspace fence: every mutation is
 *   refused with 503 until an operator clears it, so waiting is pointless;
 * - `busy: false` is idle, `busy: true` is busy. The response allows extra
 *   fields, so a truthy `scanning`, `destructive_busy` or a positive
 *   `pending_enqueues` also counts as busy when present: an upload's
 *   background enqueue has not landed in doc status yet;
 * - only when `busy` is absent, the legacy `status` / `pipeline_status`
 *   string is read (`idle|done|completed|success`, `failed|failure|error`,
 *   any other string is busy). This fallback exists for older servers and
 *   fakes; v1.5.7 never sends it;
 * - a body with neither shape is `unknown`, never a silent busy loop.
 */
function readPipeline(body: unknown): PipelineReading {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return { kind: "unknown" };
	const record = body as Record<string, unknown>;
	if (record.recovery_required === true) {
		const message =
			typeof record.recovery_message === "string" && record.recovery_message.length > 0
				? record.recovery_message
				: typeof record.recovery_kind === "string" && record.recovery_kind.length > 0
					? record.recovery_kind
					: "unspecified";
		return { kind: "recovery", message };
	}
	if (typeof record.busy === "boolean") {
		const pending = typeof record.pending_enqueues === "number" && record.pending_enqueues > 0;
		return record.busy || record.scanning === true || record.destructive_busy === true || pending ? { kind: "busy" } : { kind: "idle" };
	}
	const data = dataOf(body);
	if (data === null || typeof data !== "object") return { kind: "unknown" };
	const status = readString(data, "status", "pipeline_status");
	if (status === undefined) return { kind: "unknown" };
	const lower = status.toLowerCase();
	if (lower === "idle" || lower === "done" || lower === "completed" || lower === "success") return { kind: "idle" };
	if (lower === "failed" || lower === "failure" || lower === "error") {
		const message = readString(data, "message", "progress_msg", "error") ?? "";
		return { kind: "failed", detail: `${lower}${message ? ` ${message.slice(0, 200)}` : ""}` };
	}
	return { kind: "busy" };
}

/**
 * Poll the pipeline until idle (`GET /documents/pipeline_status`, idle
 * when `busy` is false). A busy pipeline past `maxPolls` is a
 * `parse-timeout` reason; a fenced workspace is `lightrag recovery
 * required: <message>` and stops at once; a body in no known shape is
 * `lightrag: unexpected pipeline shape` and stops at once — never a hang,
 * never a throw. After a delete the pipeline stays busy while the
 * background job runs, so a caller that needs the delete to be complete
 * polls with this same function. `document` is accepted for the RAGFlow
 * drop-in signature (the status is server-global) and never enters the
 * reason.
 */
export async function pollParseStatus(
	config: LightragConfig,
	document: { dataset_id: string; document_id: string },
	fetchImpl: FetchLike = fetch,
	opts: LightragPollOptions = {},
): Promise<{ ok: true } | { ok: false; reason: string; detail?: string }> {
	void document;
	const maxPolls = opts.maxPolls ?? 10;
	const intervalMs = opts.intervalMs ?? 100;
	const timeoutMs = opts.timeoutMs ?? 4000;
	const sleep = opts.sleep ?? defaultSleep;
	for (let poll = 0; poll < maxPolls; poll += 1) {
		const answered = await call(config, fetchImpl, "/documents/pipeline_status", { method: "GET", timeoutMs });
		if (!answered.ok) return answered;
		const reading = readPipeline(answered.body);
		if (reading.kind === "idle") return { ok: true };
		if (reading.kind === "failed") return { ok: false, reason: `parse-failed: ${reading.detail}` };
		if (reading.kind === "recovery") {
			return { ok: false, reason: `lightrag recovery required: ${redact(reading.message).slice(0, 200)}` };
		}
		if (reading.kind === "unknown") return { ok: false, reason: "lightrag: unexpected pipeline shape" };
		if (poll < maxPolls - 1 && intervalMs > 0) await sleep(intervalMs);
	}
	return { ok: false, reason: "parse-timeout" };
}

/** One member of a parsed JSON object, or undefined: narrowed with `in`, no assumed shape. */
function readMember(value: unknown, name: string): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	return name in value ? (value as Record<string, unknown>)[name] : undefined;
}

/** One document `GET /documents/track_status/{track_id}` lists. */
export interface LightragTrackedDocument {
	id: string;
	status?: string;
	file_path?: string;
	error_msg?: string;
}

export interface LightragTrackOptions {
	/** Most reads before giving up on the enqueue landing. Default 10. */
	maxPolls?: number;
	/** Wait between reads. Default 500 ms. */
	intervalMs?: number;
	/** Per-read timeout. Default 4000 ms. */
	timeoutMs?: number;
	/** Total budget across all reads and waits. Default 30000 ms. */
	deadlineMs?: number;
	/** Waits between reads; injected so tests never really wait. */
	sleep?: (ms: number) => Promise<void>;
	/** The clock for the deadline; injected so tests are deterministic. */
	now?: () => number;
}

export type LightragTrackOutcome =
	| { ok: true; ids: string[]; documents: LightragTrackedDocument[] }
	| { ok: false; reason: string; detail?: string };

/**
 * Resolve the real document ids behind an upload's `track_id`
 * (`GET /documents/track_status/{track_id}` → `{ track_id, documents: [{ id,
 * status, file_path, … }], total_count, status_summary }`). The upload
 * enqueues in the background, so the documents may not be listed yet: an
 * empty list is read again, up to `maxPolls` reads and `deadlineMs`, then
 * it is a reason — never a hang. Document ids, not track ids, are what
 * {@link deleteDocuments} needs.
 */
export async function resolveDocumentIds(
	config: LightragConfig,
	trackId: string,
	fetchImpl: FetchLike = fetch,
	opts: LightragTrackOptions = {},
): Promise<LightragTrackOutcome> {
	const id = trackId.trim();
	if (id.length === 0) return { ok: false, reason: "lightrag: empty track id" };
	const maxPolls = opts.maxPolls ?? 10;
	const intervalMs = opts.intervalMs ?? 500;
	const timeoutMs = opts.timeoutMs ?? 4000;
	const deadlineMs = opts.deadlineMs ?? 30_000;
	const sleep = opts.sleep ?? defaultSleep;
	const now = opts.now ?? Date.now;
	const started = now();
	for (let poll = 0; poll < maxPolls; poll += 1) {
		const remainingMs = deadlineMs - (now() - started);
		if (remainingMs <= 0) return { ok: false, reason: "lightrag: track_status deadline exceeded with no documents" };
		const answered = await call(config, fetchImpl, `/documents/track_status/${encodeURIComponent(id)}`, { method: "GET", timeoutMs: Math.min(timeoutMs, remainingMs) });
		if (!answered.ok) return answered;
		const listed = readMember(answered.body, "documents");
		if (!Array.isArray(listed)) return { ok: false, reason: "lightrag: unexpected track_status shape" };
		const documents: LightragTrackedDocument[] = [];
		for (const entry of listed) {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
			const documentId = readString(entry, "id");
			if (documentId === undefined || documentId.trim().length === 0) continue;
			const status = readString(entry, "status");
			const filePath = readString(entry, "file_path");
			const errorMsg = readString(entry, "error_msg");
			documents.push({
				id: documentId,
				...(status !== undefined ? { status } : {}),
				...(filePath !== undefined ? { file_path: filePath } : {}),
				...(errorMsg !== undefined ? { error_msg: redact(errorMsg).slice(0, 200) } : {}),
			});
		}
		if (documents.length > 0) return { ok: true, ids: documents.map((document) => document.id), documents };
		const leftMs = deadlineMs - (now() - started);
		if (leftMs <= 0) return { ok: false, reason: "lightrag: track_status deadline exceeded with no documents" };
		if (poll < maxPolls - 1 && intervalMs > 0) await sleep(Math.min(intervalMs, leftMs));
	}
	return { ok: false, reason: "lightrag: track_status listed no documents" };
}

/**
 * Delete documents by id (`DELETE /documents/delete_document`
 * `{ doc_ids, delete_file, delete_llm_cache: false }`; `delete_file` is false unless `options.deleteFile` is true). The ids
 * must be real document ids ({@link resolveDocumentIds}), never track ids.
 * Upstream strips and de-duplicates them and refuses an empty id; the
 * deletion runs in the background, so `ok` means `deletion_started`:
 * poll {@link pollParseStatus} for completion. `busy` (another writer
 * holds the pipeline) is `retryable`; any other status fails with a reason
 * naming it. NEVER the clear-all `DELETE /documents`: the choke point
 * refuses that path permanently. `datasetId` is accepted for the drop-in
 * signature and ignored on the wire.
 */
export async function deleteDocuments(
	config: LightragConfig,
	datasetId: string,
	documentIds: readonly string[],
	fetchImpl: FetchLike = fetch,
	timeoutMs = 8000,
	options: { deleteFile?: boolean } = {},
): Promise<{ ok: true } | { ok: false; reason: string; detail?: string; retryable?: true }> {
	void datasetId;
	if (documentIds.length === 0) return { ok: true };
	const ids = [...new Set(documentIds.map((documentId) => documentId.trim()))];
	if (ids.some((documentId) => documentId.length === 0)) return { ok: false, reason: "lightrag: empty document id" };
	const answered = await call(config, fetchImpl, "/documents/delete_document", {
		method: "DELETE",
		json: true,
		body: JSON.stringify({ doc_ids: ids, delete_file: options.deleteFile ?? false, delete_llm_cache: false }),
		timeoutMs,
	});
	if (!answered.ok) return { ok: false, reason: answered.reason, ...(answered.detail !== undefined ? { detail: answered.detail } : {}) };
	const rawStatus = readMember(answered.body, "status");
	const status = typeof rawStatus === "string" ? rawStatus : undefined;
	const rawMessage = readMember(answered.body, "message");
	const message = typeof rawMessage === "string" ? `: ${redact(rawMessage).slice(0, 200)}` : "";
	if (status === "deletion_started") return { ok: true };
	if (status === "busy") return { ok: false, reason: `lightrag delete busy${message}`, retryable: true };
	if (status === "not_allowed") return { ok: false, reason: `lightrag delete not_allowed${message}` };
	if (status === undefined) return { ok: false, reason: "lightrag: unexpected delete shape" };
	return { ok: false, reason: `lightrag delete: unexpected status ${status.slice(0, 40)}` };
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

/** The result of a LightRAG health probe. */
export interface LightragProbe {
	ok: boolean;
	/** Whether the indexing pipeline is busy, when the server said. */
	busy?: boolean;
	/** The server's core version, when it said. */
	version?: string;
	/** Why `ok` is false. Never carries the key. */
	reason?: string;
}

/**
 * Probe `GET /health`. Authenticated unless the deployment whitelists the
 * path: an unauthenticated caller gets only liveness fields (`status`,
 * versions, `pipeline_busy`), an authenticated one also the configuration.
 * `ok` is `status === "healthy"`; a refused key is `ok: false` with the
 * `lightrag 401`/`403` reason. Never throws.
 */
export async function probeLightrag(
	config: LightragConfig,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 4000,
): Promise<LightragProbe> {
	try {
		const answered = await call(config, fetchImpl, "/health", { method: "GET", timeoutMs });
		if (!answered.ok) return { ok: false, reason: answered.reason };
		const body = answered.body;
		if (body === null || typeof body !== "object" || Array.isArray(body)) {
			return { ok: false, reason: "lightrag: unexpected health shape" };
		}
		const status = readString(body, "status");
		if (status === undefined) return { ok: false, reason: "lightrag: unexpected health shape" };
		if (status !== "healthy") return { ok: false, reason: `lightrag health: ${status.slice(0, 40)}` };
		const busy = readMember(body, "pipeline_busy");
		const version = readString(body, "core_version", "api_version");
		return { ok: true, ...(typeof busy === "boolean" ? { busy } : {}), ...(version !== undefined ? { version } : {}) };
	} catch (cause) {
		// `call` never throws; this is for a fetch double that hands back a non-Response. It becomes the reason, not a swallowed error.
		return { ok: false, reason: unreachable(cause) };
	}
}

/** Snippets are redacted and capped before a tool or route replies (D25-04). */
export const LIGHTRAG_SNIPPET_CAP = 1200;

export type LightragToolOutcome =
	| { ok: true; chunks: RagLightragChunk[]; mode: LightragQueryMode }
	| { ok: false; reason: string; detail?: string };

/**
 * The query the `docs_lightrag_query` tool and `POST /docs/lightrag/query`
 * serve, over THIS client: the same mode resolution, top-k clamp and
 * `POST /query` body as `docs_search`, and the caller's gated `fetchImpl`
 * (so the plane's circuit breaker sees every call). Hits come back in the
 * query surface's `RagLightragChunk` shape, redacted and capped; an entry
 * without text is skipped and no usable entry is `lightrag: unexpected
 * response shape`.
 */
export async function queryForTool(
	config: LightragConfig,
	input: { question: string; mode?: LightragQueryMode; topK?: number },
	fetchImpl: FetchLike = fetch,
	timeoutMs = 4000,
): Promise<LightragToolOutcome> {
	const answered = await queryWithGraph(config, input.question, fetchImpl, {
		...(input.mode !== undefined ? { mode: input.mode } : {}),
		...(input.topK !== undefined ? { topK: input.topK } : {}),
		timeoutMs,
	});
	if (!answered.ok) return answered;
	const chunks: RagLightragChunk[] = [];
	for (const chunk of answered.chunks) {
		if (chunk.content.length === 0) continue;
		chunks.push({
			content: redact(chunk.content).slice(0, LIGHTRAG_SNIPPET_CAP),
			title: redact(chunk.document_name),
			sourceUrl: redact(chunk.source_url ?? "lightrag:unrecorded"),
			score: chunk.score ?? 0,
		});
	}
	if (chunks.length === 0) return { ok: false, reason: "lightrag: unexpected response shape" };
	return { ok: true, chunks, mode: answered.detail.mode };
}
