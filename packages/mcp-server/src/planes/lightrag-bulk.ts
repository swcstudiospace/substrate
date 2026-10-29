/**
 * The LightRAG bulk plane: many documents in one request, one pipeline wait,
 * one id map, and delete by id. `docs_ingest` keeps its per-page upload, scan,
 * poll and track-status loop (`lightrag.ts`); this module is the path the
 * corpus ingest uses so thousands of documents do not pay that loop each.
 *
 * Endpoint map (LightRAG v1.5.7, recorded in
 * `__fixtures__/lightrag-v1.5.7-routes.json` as route `texts`):
 * - insert: `POST /documents/texts` `{ texts, file_sources }` (equal length,
 *   same order) answers `{ status, message, track_id }`. A same-name document
 *   is HTTP 409 for the WHOLE request (nothing is enqueued), so a batch with a
 *   clash is retried one document at a time.
 * - wait: `GET /documents/pipeline_status` until idle (`pollParseStatus`), once
 *   for the whole batch.
 * - map: `GET /documents/track_status/{track_id}` once per accepted request;
 *   each listed document is matched to its input by `file_path`.
 * - delete: `DELETE /documents/delete_document` (`deleteDocuments` of
 *   `lightrag.ts`), 50 ids per request. The clear-all route is refused by the
 *   one choke point in `lightrag.ts` and is never built here.
 *
 * Document identity (upstream source, not guessed). For a known `file_source`
 * `apipeline_enqueue_documents` derives the document id from the NAME, not the
 * text: `compute_mdhash_id(file_path_canonical, prefix="doc-")`
 * (lightrag/pipeline.py:996-999 at v1.5.7; the text hash at lightrag.py:1927 is
 * `ainsert_custom_chunks`, which `/documents/texts` does not call). The same
 * text under another name is NOT stored twice: the content-hash dedup
 * (pipeline.py:1233-1265) enqueues nothing and writes a FAILED `dup-...` record
 * under this call's track id whose metadata names the original
 * (`is_duplicate`, `duplicate_kind: content_hash`, `original_doc_id`;
 * pipeline.py:1340-1409). Such a document is therefore `ingested` with the
 * ORIGINAL's id and `reason: "duplicate-content"`, so the caller knows the
 * plane document is shared with another name. Two names with equal text in one
 * batch resolve the same way (the later name points at the earlier one).
 *
 * Every function returns result values and never throws: a transport failure,
 * an open breaker or a timeout is a closed reason on the affected documents.
 */
import type { LightragConfig } from "../config.ts";
import { deleteDocuments as deleteLightragDocuments, lightragCall, pollParseStatus, type FetchLike } from "./lightrag.ts";

export interface BulkTextDocument {
	name: string;
	text: string;
}

export interface BulkDocumentOutcome {
	name: string;
	status: "ingested" | "failed";
	documentId?: string | undefined;
	reason?: string | undefined;
}

export interface LightragBulkPlane {
	insertBatch(docs: readonly BulkTextDocument[], options?: { signal?: AbortSignal | undefined }): Promise<BulkDocumentOutcome[]>;
	deleteDocuments(ids: readonly string[]): Promise<{ deleted: string[]; failed: Array<{ id: string; reason: string }> }>;
}

// The reasons a failed outcome carries: `plane-unavailable`, `timeout`, `rejected`, `conflict`, `pipeline-failed`
// (optionally `pipeline-failed: <short plane message>`), `unknown-document` and `duplicate-content`. An ingested
// outcome carries `reason: "duplicate-content"` when its plane document is shared with another name.

/** Most documents one `POST /documents/texts` carries from this client. */
export const BULK_MAX_DOCUMENTS_PER_REQUEST = 100;
/** Most text-plus-name bytes one request carries; a single larger document is `rejected`. */
export const BULK_MAX_BYTES_PER_REQUEST = 4_000_000;
/** Most ids one delete request carries. */
export const BULK_MAX_DELETE_IDS = 50;

const BATCH_BASE_TIMEOUT_MS = 30_000;
const BATCH_PER_DOCUMENT_TIMEOUT_MS = 2_000;
const BATCH_MAX_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 1_000;
const POLL_REQUEST_TIMEOUT_MS = 4_000;
const DELETE_REQUEST_TIMEOUT_MS = 8_000;
const DELETE_BUSY_RETRIES = 5;
const ERROR_DETAIL_MAX = 200;
const PARSE_TIMEOUT = "parse-timeout";
// How many idle reads of the track status may list a document as absent before it is `unknown-document`: the enqueue behind the insert answer runs in the background.
const ABSENT_STATUS_READS = 3;
const NO_DOCUMENT = { dataset_id: "", document_id: "" };

/**
 * The time one batch of `count` documents may take, for the insert request and
 * for the pipeline wait alike: 30 s plus 2 s per document, never above 300 s.
 */
export function bulkTimeoutMs(count: number): number {
	return Math.min(BATCH_MAX_TIMEOUT_MS, BATCH_BASE_TIMEOUT_MS + BATCH_PER_DOCUMENT_TIMEOUT_MS * Math.max(0, count));
}

// JS `\s` and Python `str.strip()` differ at U+0085 (Python only) and U+FEFF (JS only); an edge of either kind is refused.
const EDGE_SPACE = /^[\s\u0085]|[\s\u0085]$/;

/** A parser hint upstream may strip from the basename: `name.[engine].ext`. Refused whole: whether a bracket is a hint depends on the server's engines. */
const PARSER_HINT_SHAPE = /\.\[[^\]]*\]\.[^.]+$/;

/**
 * Whether upstream accepts `name` as a `file_source` UNCHANGED. The server
 * builds document names with this, because the name is the document's identity
 * and a silently rewritten name would map a result to the wrong document.
 *
 * Mirrors `/documents/texts` (lightrag_api_routers_document_routes.py v1.5.7):
 * `reject_unsafe_document_source` (:212-226) refuses control characters
 * (U+0000-U+001F, U+007F), lone surrogates, U+FFFE and U+FFFF; then
 * `normalize_file_path` (:245-254) strips whitespace, maps `""`/`no-file-path`
 * to `unknown_source` (which the route answers 400), keeps only the final path
 * component (`Path(...).name`, so a `/` would drop the directories) and strips a
 * recognised `[engine]` parser hint (lightrag/parser/routing.py:62, :1085-1099).
 * The route also requires the normalised names of one request to be unique.
 */
export function isAcceptableFileSource(name: string): boolean {
	if (name.length === 0) return false;
	for (let index = 0; index < name.length; index += 1) {
		const unit = name.charCodeAt(index);
		if (unit <= 0x1f || unit === 0x7f || unit === 0xfffe || unit === 0xffff) return false;
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = name.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) {
			return false;
		}
	}
	if (EDGE_SPACE.test(name)) return false;
	if (name === "no-file-path" || name === "unknown_source" || name === "." || name === "..") return false;
	if (name.includes("/")) return false;
	return !PARSER_HINT_SHAPE.test(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shorten(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, ERROR_DETAIL_MAX);
}

function defaultSleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function ingested(name: string, documentId: string, reason?: string): BulkDocumentOutcome {
	return { name, status: "ingested", documentId, ...(reason === undefined ? {} : { reason }) };
}

function failed(name: string, reason: string): BulkDocumentOutcome {
	return { name, status: "failed", reason };
}

interface Prepared {
	index: number;
	name: string;
	text: string;
	bytes: number;
}

interface Accepted {
	trackId: string;
	docs: Prepared[];
}

interface Slot {
	doc: Prepared;
	trackId: string;
	last: "none" | "absent" | "active";
}

interface Context {
	config: LightragConfig;
	fetchImpl: FetchLike;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	signal?: AbortSignal | undefined;
}

type Outcomes = Array<BulkDocumentOutcome | undefined>;

/** Whether the caller's signal has fired. Read fresh on every call: a signal can fire during an await, so a narrowed `?.aborted` must not be reused. */
function aborted(context: Pick<Context, "signal">): boolean {
	return context.signal?.aborted === true;
}

/**
 * A client-side failure reason from `lightrag.ts` (`lightrag 409`, `lightrag
 * circuit open`, `lightrag unreachable: ...`, `parse-timeout`, ...) as one of the
 * closed bulk reasons. An aborted caller signal is always `timeout`.
 */
function closedReason(raw: string, context: Pick<Context, "signal">): string {
	if (aborted(context)) return "timeout";
	if (raw === "lightrag 409") return "conflict";
	if (/^lightrag (400|413|422)$/.test(raw) || /^lightrag (failure|failed|error)\b/.test(raw)) return "rejected";
	if (raw.startsWith("parse-failed")) {
		const detail = shorten(raw.replace(/^parse-failed:?\s*/, ""));
		return detail.length > 0 ? `pipeline-failed: ${detail}` : "pipeline-failed";
	}
	if (raw === PARSE_TIMEOUT || /timed out|timeout/i.test(raw)) return "timeout";
	return "plane-unavailable";
}

/** The request body size and count rules: split in input order, never above either limit. */
function splitRequests(docs: readonly Prepared[]): Prepared[][] {
	const groups: Prepared[][] = [];
	let current: Prepared[] = [];
	let bytes = 0;
	for (const doc of docs) {
		if (current.length > 0 && (current.length >= BULK_MAX_DOCUMENTS_PER_REQUEST || bytes + doc.bytes > BULK_MAX_BYTES_PER_REQUEST)) {
			groups.push(current);
			current = [];
			bytes = 0;
		}
		current.push(doc);
		bytes += doc.bytes;
	}
	if (current.length > 0) groups.push(current);
	return groups;
}

/**
 * One request for `docs`, appended to `accepted` when the plane takes it. A
 * same-name 409 refuses the whole request, so a multi-document request is
 * retried document by document; a 413 (the server's `MAX_TEXTS_PER_REQUEST`) is
 * retried in halves. Everything else fails the documents with a closed reason.
 */
async function submit(context: Context, docs: Prepared[], accepted: Accepted[], outcomes: Outcomes): Promise<void> {
	if (aborted(context)) {
		for (const doc of docs) outcomes[doc.index] = failed(doc.name, "timeout");
		return;
	}
	const answered = await lightragCall(context.config, context.fetchImpl, "/documents/texts", {
		method: "POST",
		json: true,
		body: JSON.stringify({ texts: docs.map((doc) => doc.text), file_sources: docs.map((doc) => doc.name) }),
		timeoutMs: bulkTimeoutMs(docs.length),
	});
	if (answered.ok) {
		const trackId = isRecord(answered.body) && typeof answered.body.track_id === "string" ? answered.body.track_id.trim() : "";
		if (trackId.length === 0) {
			for (const doc of docs) outcomes[doc.index] = failed(doc.name, "plane-unavailable");
			return;
		}
		accepted.push({ trackId, docs });
		return;
	}
	if (docs.length > 1 && !aborted(context)) {
		if (answered.reason === "lightrag 409") {
			for (const doc of docs) await submit(context, [doc], accepted, outcomes);
			return;
		}
		if (answered.reason === "lightrag 413") {
			const middle = Math.ceil(docs.length / 2);
			await submit(context, docs.slice(0, middle), accepted, outcomes);
			await submit(context, docs.slice(middle), accepted, outcomes);
			return;
		}
	}
	const reason = closedReason(answered.reason, context);
	for (const doc of docs) outcomes[doc.index] = failed(doc.name, reason);
}

type IdleReading = { kind: "idle" } | { kind: "busy" } | { kind: "failed"; reason: string };

/** One read of the pipeline state, through the helper `docs_ingest` waits with. */
async function pollIdleOnce(context: Context): Promise<IdleReading> {
	const polled = await pollParseStatus(context.config, NO_DOCUMENT, context.fetchImpl, {
		maxPolls: 1,
		timeoutMs: POLL_REQUEST_TIMEOUT_MS,
		sleep: context.sleep,
	});
	if (polled.ok) return { kind: "idle" };
	if (polled.reason === PARSE_TIMEOUT) return { kind: "busy" };
	return { kind: "failed", reason: closedReason(polled.reason, context) };
}

/** Wait until the pipeline is idle, for at most {@link bulkTimeoutMs} of `count` documents. */
async function waitIdle(context: Context, count: number): Promise<{ ok: true } | { ok: false; reason: string }> {
	const budgetMs = bulkTimeoutMs(count);
	const started = context.now();
	for (;;) {
		const reading = await pollIdleOnce(context);
		if (reading.kind === "idle") return { ok: true };
		if (reading.kind === "failed") return { ok: false, reason: reading.reason };
		if (context.now() - started >= budgetMs) return { ok: false, reason: "timeout" };
		await context.sleep(POLL_INTERVAL_MS);
	}
}

/** One document `GET /documents/track_status/{track_id}` lists, with what duplicate detection added. */
interface TrackedDocument {
	id: string;
	status: string;
	filePath: string;
	errorMsg: string;
	duplicate?: { kind: string; originalId?: string; originalStatus?: string };
}

const SUMMARY_DUPLICATE = /^\[DUPLICATE:([a-z_]+)\](?: Original document: (\S+))?/;
const ERROR_ORIGINAL = /Original doc_id: ([^,\s]+), Status: (\S+)/;

/** The duplicate facts of one status record: its metadata first, the summary and error text as fallback. */
function duplicateOf(entry: Record<string, unknown>, summary: string, errorMsg: string): TrackedDocument["duplicate"] {
	const metadata = isRecord(entry.metadata) ? entry.metadata : undefined;
	const fromSummary = SUMMARY_DUPLICATE.exec(summary);
	if (metadata?.is_duplicate !== true && fromSummary === null) return undefined;
	const fromError = ERROR_ORIGINAL.exec(errorMsg);
	const metaKind = typeof metadata?.duplicate_kind === "string" ? metadata.duplicate_kind : undefined;
	const metaOriginal = typeof metadata?.original_doc_id === "string" && metadata.original_doc_id.length > 0 ? metadata.original_doc_id : undefined;
	const originalId = metaOriginal ?? fromSummary?.[2] ?? fromError?.[1];
	const originalStatus = fromError?.[2]?.toLowerCase();
	return {
		kind: metaKind ?? fromSummary?.[1] ?? "unknown",
		...(originalId === undefined ? {} : { originalId }),
		...(originalStatus === undefined ? {} : { originalStatus }),
	};
}

function readTracked(body: unknown): TrackedDocument[] | null {
	if (!isRecord(body) || !Array.isArray(body.documents)) return null;
	const tracked: TrackedDocument[] = [];
	for (const entry of body.documents as unknown[]) {
		if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.file_path !== "string") continue;
		const errorMsg = typeof entry.error_msg === "string" ? entry.error_msg : "";
		const summary = typeof entry.content_summary === "string" ? entry.content_summary : "";
		const duplicate = duplicateOf(entry, summary, errorMsg);
		tracked.push({
			id: entry.id,
			status: typeof entry.status === "string" ? entry.status.toLowerCase() : "",
			filePath: entry.file_path,
			errorMsg,
			...(duplicate === undefined ? {} : { duplicate }),
		});
	}
	return tracked;
}

/**
 * The outcome one tracked document settles a slot with, or `undefined` while the
 * plane is still working on it. A failed `content_hash` duplicate is the same
 * text already stored under another name: `ingested` with the original's id.
 * `failedPlaneIds` collects the ids of documents that failed in the pipeline so
 * a duplicate that points at one of them is not reported as ingested.
 */
function settleEntry(name: string, entry: TrackedDocument, failedPlaneIds: Set<string>): BulkDocumentOutcome | undefined {
	if (entry.status === "processed") return ingested(name, entry.id);
	if (entry.status !== "failed") return undefined;
	const duplicate = entry.duplicate;
	if (duplicate === undefined) {
		failedPlaneIds.add(entry.id);
		const detail = shorten(entry.errorMsg);
		return failed(name, detail.length > 0 ? `pipeline-failed: ${detail}` : "pipeline-failed");
	}
	if (duplicate.kind !== "content_hash") return failed(name, "conflict");
	if (duplicate.originalId === undefined || duplicate.originalStatus === "failed") return failed(name, "duplicate-content");
	return ingested(name, duplicate.originalId, "duplicate-content");
}

/** Read each accepted request's track status once and settle what it lists; returns the slots still open. */
async function readStatuses(context: Context, pending: readonly Slot[], outcomes: Outcomes, failedPlaneIds: Set<string>): Promise<Slot[]> {
	const byTrack = new Map<string, Slot[]>();
	for (const slot of pending) byTrack.set(slot.trackId, [...(byTrack.get(slot.trackId) ?? []), slot]);
	const open: Slot[] = [];
	for (const [trackId, slots] of byTrack) {
		const answered = await lightragCall(context.config, context.fetchImpl, `/documents/track_status/${encodeURIComponent(trackId)}`, {
			method: "GET",
			timeoutMs: POLL_REQUEST_TIMEOUT_MS,
		});
		const tracked = answered.ok ? readTracked(answered.body) : null;
		if (tracked === null) {
			const reason = answered.ok ? "plane-unavailable" : closedReason(answered.reason, context);
			for (const slot of slots) outcomes[slot.doc.index] = failed(slot.doc.name, reason);
			continue;
		}
		for (const slot of slots) {
			const entries = tracked.filter((entry) => entry.filePath === slot.doc.name);
			const entry = entries.find((candidate) => candidate.status === "processed") ?? entries[0];
			if (entry === undefined) {
				open.push({ ...slot, last: "absent" });
				continue;
			}
			const settled = settleEntry(slot.doc.name, entry, failedPlaneIds);
			if (settled === undefined) open.push({ ...slot, last: "active" });
			else outcomes[slot.doc.index] = settled;
		}
	}
	return open;
}

/**
 * The one pipeline wait of a batch. Polls until the pipeline is idle, reads the
 * track statuses, and, when the plane has not listed a document yet (the
 * enqueue runs in the background) or still works on it, waits again within the
 * same budget. A document an idle plane still does not list after a few reads
 * was never enqueued: `unknown-document`. Anything else still open at the bound
 * is `timeout`.
 */
async function settleAll(context: Context, groups: readonly Accepted[], outcomes: Outcomes, failedPlaneIds: Set<string>): Promise<void> {
	let pending: Slot[] = groups.flatMap((group) => group.docs.map((doc): Slot => ({ doc, trackId: group.trackId, last: "none" })));
	const budgetMs = bulkTimeoutMs(pending.length);
	const started = context.now();
	let idleReads = 0;
	while (pending.length > 0) {
		if (aborted(context)) {
			for (const slot of pending) outcomes[slot.doc.index] = failed(slot.doc.name, "timeout");
			return;
		}
		const reading = await pollIdleOnce(context);
		if (reading.kind === "failed") {
			for (const slot of pending) outcomes[slot.doc.index] = failed(slot.doc.name, reading.reason);
			return;
		}
		const exhausted = context.now() - started >= budgetMs;
		if (reading.kind === "idle" || exhausted) {
			if (reading.kind === "idle") idleReads += 1;
			pending = await readStatuses(context, pending, outcomes, failedPlaneIds);
			if (reading.kind === "idle" && idleReads >= ABSENT_STATUS_READS) {
				for (const slot of pending) if (slot.last === "absent") outcomes[slot.doc.index] = failed(slot.doc.name, "unknown-document");
				pending = pending.filter((slot) => slot.last !== "absent");
			}
		}
		if (pending.length === 0) return;
		if (exhausted) {
			for (const slot of pending) {
				const reason = reading.kind === "idle" && slot.last === "absent" ? "unknown-document" : "timeout";
				outcomes[slot.doc.index] = failed(slot.doc.name, reason);
			}
			return;
		}
		await context.sleep(POLL_INTERVAL_MS);
	}
}

/** A fetch that also aborts when the caller's signal does. */
function withSignal(base: FetchLike, signal: AbortSignal | undefined): FetchLike {
	if (signal === undefined) return base;
	return (input, init) => base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
}

/**
 * Delete one request's ids. The route answers `deletion_started` without
 * looking the ids up and the background job skips an id it does not hold, so an
 * unknown id counts as deleted (deleting twice is a no-op). A `busy` answer (a
 * writer holds the pipeline) waits for idle and retries a bounded number of
 * times. The deletion itself runs in the background and holds the destructive
 * slot, which would answer the next insert with a 409; the pipeline is waited on
 * to idle before this returns.
 */
async function deleteRequest(context: Context, ids: string[]): Promise<{ deleted: true } | { deleted: false; reason: string }> {
	for (let attempt = 0; attempt <= DELETE_BUSY_RETRIES; attempt += 1) {
		const answered = await deleteLightragDocuments(context.config, "", ids, context.fetchImpl, DELETE_REQUEST_TIMEOUT_MS);
		if (answered.ok) {
			// Started counts as deleted; a wait that fails here only delays the next request, which handles `busy` itself.
			await waitIdle(context, ids.length);
			return { deleted: true };
		}
		if (answered.retryable !== true) {
			return { deleted: false, reason: answered.reason.includes("not_allowed") ? "rejected" : closedReason(answered.reason, context) };
		}
		if (attempt === DELETE_BUSY_RETRIES) break;
		const idle = await waitIdle(context, ids.length);
		if (!idle.ok) return { deleted: false, reason: idle.reason };
	}
	return { deleted: false, reason: "plane-unavailable" };
}

export function createLightragBulkPlane(
	config: LightragConfig,
	deps: { fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): LightragBulkPlane {
	const baseFetch: FetchLike = deps.fetch ?? fetch;
	const sleep = deps.sleep ?? defaultSleep;
	const now = deps.now ?? Date.now;

	return {
		async insertBatch(docs, options = {}) {
			const context: Context = { config, fetchImpl: withSignal(baseFetch, options.signal), sleep, now, signal: options.signal };
			const outcomes: Outcomes = Array.from({ length: docs.length }, (): BulkDocumentOutcome | undefined => undefined);
			const prepared: Prepared[] = [];
			const seen = new Set<string>();
			docs.forEach((doc, index) => {
				const text = doc.text.trim();
				const bytes = Buffer.byteLength(text) + Buffer.byteLength(doc.name);
				if (!isAcceptableFileSource(doc.name) || text.length === 0 || bytes > BULK_MAX_BYTES_PER_REQUEST) {
					outcomes[index] = failed(doc.name, "rejected");
				} else if (seen.has(doc.name)) {
					// The route requires unique names in one request; the later one is the clash.
					outcomes[index] = failed(doc.name, "conflict");
				} else {
					seen.add(doc.name);
					prepared.push({ index, name: doc.name, text, bytes });
				}
			});

			const accepted: Accepted[] = [];
			for (const group of splitRequests(prepared)) await submit(context, group, accepted, outcomes);

			const failedPlaneIds = new Set<string>();
			if (accepted.length > 0) await settleAll(context, accepted, outcomes, failedPlaneIds);

			// A duplicate whose original failed in this batch has no plane document behind it.
			return outcomes.map((outcome, index): BulkDocumentOutcome => {
				const name = docs[index]?.name ?? "";
				if (outcome === undefined) return failed(name, "plane-unavailable");
				if (outcome.status === "ingested" && outcome.reason === "duplicate-content" && outcome.documentId !== undefined && failedPlaneIds.has(outcome.documentId)) {
					return failed(name, "pipeline-failed");
				}
				return outcome;
			});
		},

		async deleteDocuments(ids) {
			const context: Context = { config, fetchImpl: baseFetch, sleep, now };
			const deleted: string[] = [];
			const failures: Array<{ id: string; reason: string }> = [];
			const unique: string[] = [];
			const seen = new Set<string>();
			for (const raw of ids) {
				const id = raw.trim();
				if (id.length === 0) failures.push({ id: raw, reason: "rejected" });
				else if (!seen.has(id)) {
					seen.add(id);
					unique.push(id);
				}
			}
			for (let start = 0; start < unique.length; start += BULK_MAX_DELETE_IDS) {
				const chunk = unique.slice(start, start + BULK_MAX_DELETE_IDS);
				const result = await deleteRequest(context, chunk);
				if (result.deleted) deleted.push(...chunk);
				else for (const id of chunk) failures.push({ id, reason: result.reason });
			}
			return { deleted, failed: failures };
		},
	};
}
