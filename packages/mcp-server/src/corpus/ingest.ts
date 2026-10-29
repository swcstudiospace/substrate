/**
 * The corpus bulk ingest (v1.7 phase 63): puts new and changed documents into the docs plane in batches, removes tombstoned
 * ones, and keeps the manifest (`corpus_documents`) in step. Called by `POST /corpus/ingest` and the `corpus_ingest` tool.
 *
 * One request runs in three phases, and requests on one process are serialised (single flight, held across the whole
 * request including its plane deletes):
 * - T, tombstones: for each row the plane document is deleted first (unless an active row that stays shares it) and the row
 *   is marked removed only after that deletion is confirmed. A deletion that fails or is not confirmed leaves the row active
 *   (`delete-failed`), so a retry plans it again.
 * - I, inserts and replacements: batches may run concurrently; each row is written after the plane accepted its document.
 *   Nothing is deleted from the plane in this phase, so no delete can overlap an insert whose text the plane may answer with
 *   a document that is about to disappear (identical text under another name shares one plane document id).
 * - S, superseded documents: only after every row of the request is recorded, the plane documents the changed documents
 *   replaced are deleted, when no active row holds their id. A crash between I and S leaves an orphan, never a dangling row.
 *
 * Other rules the order of work encodes:
 * - Nothing leaves this module for the plane unless the gates pass (`corpusGate`), the body hashes to its entry's sha256, and
 *   the redactor's secret findings are clean. A refused document is never sent and never recorded.
 * - A document the manifest already holds at that sha, source, kind and tier is `unchanged` and not sent, so a re-run is a
 *   no-op and a killed run resumes with only what it had not recorded. The same sha under another source, kind or tier is
 *   `updated`: the row is refreshed and the plane is not touched.
 * - A plane failure marks the affected documents `failed` and records nothing, so a retry sends only them.
 *
 * Tombstones run before the documents: a rename is a tombstone and an add of the same text, and deleting the old document
 * first makes the plane store the text under its new name, so a search citation names the new path.
 */
import { createHash } from "node:crypto";
import {
	CORPUS_PROTOCOL,
	DOCUMENT_REFUSALS,
	corpusDocumentName,
	documentKey,
	documentRefusal,
	sourceUrl,
	stripRemoteImages,
	type CorpusDocument,
	type CorpusIngestRequest,
	type CorpusIngestResponse,
	type CorpusIngestResultItem,
	type IngestStatus,
} from "@substrate/corpus";
import { findingRules } from "../docs-ingest.ts";
import type { BulkDocumentOutcome, BulkTextDocument, LightragBulkPlane } from "../planes/lightrag-bulk.ts";
import type { EventInput, Surface } from "../types.ts";
import { AsyncMutex } from "./mutex.ts";
import { planeDocumentIdForName } from "./names.ts";
import type { CorpusStore, ManifestRow } from "./store.ts";

/** Ingest requests on this process run one at a time: plane writes and deletes of two requests never interleave. */
const ingestLock = new AsyncMutex();

/** Why a document is refused before anything is sent. Closed. */
export const REFUSAL_REASONS = [...DOCUMENT_REFUSALS, "sha-mismatch", "secret-findings"] as const;

/** Why a document or tombstone failed after it was accepted for work; a retry sends only these. Closed. */
export const FAILURE_REASONS = ["plane-unavailable", "timeout", "rejected", "conflict", "pipeline-failed", "duplicate-content", "manifest-unavailable", "delete-failed"] as const;

const PLANE_FAILURES: readonly string[] = ["plane-unavailable", "timeout", "rejected", "conflict", "pipeline-failed", "duplicate-content"];

/** Why the whole request is refused before any work. The HTTP status is the route's answer. Closed. */
export const GATE_REASONS = ["unauthenticated", "vm-guest", "corpus.disabled", "corpus.backend-unavailable"] as const;
export type GateReason = (typeof GATE_REASONS)[number];

export interface CorpusGate {
	status: 401 | 403 | 503;
	reason: GateReason;
}

/** The request-level refusal, decided from the caller and the deployment alone. Null means the request may proceed. */
export function corpusGate(input: { enabled: boolean; surface: Surface | null; vmGuest: boolean; backendReady: boolean }): CorpusGate | null {
	if (input.surface === null) return { status: 401, reason: "unauthenticated" };
	if (!input.enabled) return { status: 503, reason: "corpus.disabled" };
	if (input.vmGuest) return { status: 403, reason: "vm-guest" };
	if (!input.backendReady) return { status: 503, reason: "corpus.backend-unavailable" };
	return null;
}

export interface CorpusIngestSettings {
	concurrency: number;
	batchDocs: number;
	batchBytes: number;
}

export interface CorpusIngestDeps {
	store: CorpusStore;
	plane: LightragBulkPlane;
	settings: CorpusIngestSettings;
	emit: (event: EventInput) => Promise<unknown>;
	surface: Surface;
	sessionId: string;
	signal?: AbortSignal | undefined;
}

/** A document that passed every check and waits to be sent. */
interface PreparedDocument {
	document: CorpusDocument;
	name: string;
	text: string;
	/** Bytes the batch budget counts: the text and the name. */
	size: number;
	/** The active row this document replaces, when it is a change. */
	prior: ManifestRow | null;
}

function sha256Of(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function failureReason(reason: string | undefined): string {
	if (reason === undefined || reason.length === 0) return "plane-unavailable";
	if (reason.startsWith("pipeline-failed")) return "pipeline-failed";
	return PLANE_FAILURES.includes(reason) ? reason : "plane-unavailable";
}

/**
 * Groups prepared documents into batches of at most `maxDocs` documents and `maxBytes` bytes, in order. A document larger than
 * `maxBytes` is a batch of its own: it is sent, not dropped.
 */
export function chunkByLimits<T extends { size: number }>(items: readonly T[], maxDocs: number, maxBytes: number): T[][] {
	const chunks: T[][] = [];
	let current: T[] = [];
	let bytes = 0;
	for (const item of items) {
		if (current.length > 0 && (current.length >= maxDocs || bytes + item.size > maxBytes)) {
			chunks.push(current);
			current = [];
			bytes = 0;
		}
		current.push(item);
		bytes += item.size;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

/** Runs `work` over `items` with at most `limit` in flight. `work` must not throw. */
async function runBounded<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const item = items[next];
			next += 1;
			if (item === undefined) return;
			await work(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
}

interface Tally {
	results: Map<string, CorpusIngestResultItem>;
	/** Rule names per refusal reason, for the refusal events (names only, never text). */
	rules: Map<string, Set<string>>;
	/** Superseded plane documents that could not be deleted: they stay on the plane, unreferenced. */
	orphaned: number;
	batches: number;
	/** Plane document ids the request's changed documents replaced; phase S deletes those nobody references. */
	superseded: Set<string>;
	/** Documents the plane answered `conflict` for (a same-name leftover); resolved after every batch has recorded. */
	conflicts: PreparedDocument[];
}

function settle(tally: Tally, repo: string, path: string, status: IngestStatus, extra: { reason?: string; documentId?: string | null } = {}): void {
	tally.results.set(documentKey(repo, path), {
		repo,
		path,
		status,
		...(extra.reason === undefined ? {} : { reason: extra.reason }),
		...(extra.documentId === undefined || extra.documentId === null ? {} : { documentId: extra.documentId }),
	});
}

function refuse(tally: Tally, document: CorpusDocument, reason: (typeof REFUSAL_REASONS)[number], rules?: readonly string[]): void {
	settle(tally, document.repo, document.path, "refused", { reason });
	if (rules !== undefined) {
		const known = tally.rules.get(reason) ?? new Set<string>();
		for (const rule of rules) known.add(rule);
		tally.rules.set(reason, known);
	}
}

/**
 * A document whose bytes the manifest already holds but whose source, kind or tier changed: refreshes those columns and the
 * commit, with no plane write. True when the document is settled here (`updated`, `refused` or `failed`); false when the
 * active row at that sha256 vanished meanwhile, so the document takes the full path.
 */
async function refreshMetadata(deps: CorpusIngestDeps, tally: Tally, document: CorpusDocument, prior: ManifestRow): Promise<boolean> {
	// The commit lands in the manifest and in citation URLs, so it gets the scan the full path gives a name and a URL.
	const rules = findingRules(`${sourceUrl(document.repo, document.path, document.commit)}\n${document.commit ?? ""}`);
	if (rules.length > 0) {
		refuse(tally, document, "secret-findings", rules);
		return true;
	}
	try {
		const refreshed = await deps.store.refreshMetadata({
			repo: document.repo,
			path: document.path,
			sha256: document.sha256,
			kind: document.kind,
			tier: document.tier,
			source: document.source,
			commit: document.commit,
		});
		if (!refreshed) return false;
	} catch {
		settle(tally, document.repo, document.path, "failed", { reason: "manifest-unavailable" });
		return true;
	}
	settle(tally, document.repo, document.path, "updated", { documentId: prior.documentId });
	return true;
}

/** Decides one document: refused, unchanged, or ready to send. A store read that fails fails the document, never the request. */
async function prepareDocument(deps: CorpusIngestDeps, tally: Tally, document: CorpusDocument): Promise<PreparedDocument | null> {
	const broken = documentRefusal(document);
	if (broken !== null) {
		refuse(tally, document, broken);
		return null;
	}
	if (sha256Of(document.body) !== document.sha256) {
		refuse(tally, document, "sha-mismatch");
		return null;
	}
	let prior: ManifestRow | null;
	try {
		prior = await deps.store.rowFor(document.repo, document.path);
	} catch {
		settle(tally, document.repo, document.path, "failed", { reason: "manifest-unavailable" });
		return null;
	}
	if (prior?.state === "active" && prior.sha256 === document.sha256) {
		if (prior.source === document.source && prior.kind === document.kind && prior.tier === document.tier) {
			settle(tally, document.repo, document.path, "unchanged", { documentId: prior.documentId });
			return null;
		}
		// The same bytes under another source, kind or tier: the manifest is refreshed and the plane is not touched.
		if (await refreshMetadata(deps, tally, document, prior)) return null;
		prior = null;
	}
	const name = corpusDocumentName(document.repo, document.path, document.sha256);
	const text = stripRemoteImages(document.body).body;
	const rules = findingRules(`${text}\n${name}\n${sourceUrl(document.repo, document.path, document.commit)}\n${document.commit ?? ""}`);
	if (rules.length > 0) {
		refuse(tally, document, "secret-findings", rules);
		return null;
	}
	return { document, name, text, size: Buffer.byteLength(text, "utf8") + Buffer.byteLength(name, "utf8"), prior: prior?.state === "active" ? prior : null };
}

function toBulk(item: PreparedDocument): BulkTextDocument {
	return { name: item.name, text: item.text };
}

/**
 * A same-name document the plane already holds but the manifest does not: an earlier run was killed between the plane write
 * and the manifest write. If an active row already shares that plane document it is live and is adopted; otherwise it is
 * deleted and the document written again, once, so the row records a document the plane has just processed. Runs after every
 * batch of the request has recorded its rows and one document at a time, so its delete never overlaps an insert and the
 * reference count it reads includes every row of the request.
 */
async function resolveConflict(deps: CorpusIngestDeps, item: PreparedDocument): Promise<BulkDocumentOutcome> {
	const id = planeDocumentIdForName(item.name);
	try {
		if ((await deps.store.activeReferences(id)) > 0) return { name: item.name, status: "ingested", documentId: id };
		const cleared = await deps.plane.deleteDocuments([id]);
		if (cleared.failed.length > 0) return { name: item.name, status: "failed", reason: "conflict" };
		const retried = await deps.plane.insertBatch([toBulk(item)], { signal: deps.signal });
		return retried.find((outcome) => outcome.name === item.name) ?? { name: item.name, status: "failed", reason: "plane-unavailable" };
	} catch {
		return { name: item.name, status: "failed", reason: "plane-unavailable" };
	}
}

/** Records one plane outcome: the row is written after the plane accepted the document, and the document it replaces is queued for phase S. */
async function recordOutcome(deps: CorpusIngestDeps, tally: Tally, item: PreparedDocument, outcome: BulkDocumentOutcome): Promise<void> {
	const { repo, path } = item.document;
	if (outcome.status !== "ingested") {
		settle(tally, repo, path, "failed", { reason: failureReason(outcome.reason) });
		return;
	}
	if (outcome.documentId === undefined || outcome.documentId.length === 0) {
		settle(tally, repo, path, "failed", { reason: "pipeline-failed" });
		return;
	}
	try {
		await deps.store.recordIngested({
			repo,
			path,
			kind: item.document.kind,
			tier: item.document.tier,
			sha256: item.document.sha256,
			bytes: item.document.bytes,
			source: item.document.source,
			commit: item.document.commit,
			documentId: outcome.documentId,
		});
	} catch {
		// The plane holds the document and the manifest does not: the next run finds the same name, answers `conflict` and
		// resolves it, so nothing is lost and nothing is sent twice unrecorded.
		settle(tally, repo, path, "failed", { reason: "manifest-unavailable" });
		return;
	}
	settle(tally, repo, path, "ingested", { documentId: outcome.documentId });
	const old = item.prior?.documentId;
	if (old !== undefined && old !== null && old !== outcome.documentId) tally.superseded.add(old);
}

/** Sends one batch and records the rows the plane accepted. It never deletes from the plane and never throws. */
async function sendBatch(deps: CorpusIngestDeps, tally: Tally, batch: readonly PreparedDocument[]): Promise<void> {
	tally.batches += 1;
	const failAll = (reason: string): void => {
		for (const item of batch) settle(tally, item.document.repo, item.document.path, "failed", { reason });
	};
	if (deps.signal?.aborted === true) return failAll("timeout");
	let outcomes: BulkDocumentOutcome[];
	try {
		outcomes = await deps.plane.insertBatch(batch.map(toBulk), { signal: deps.signal });
	} catch {
		return failAll("plane-unavailable");
	}
	const byName = new Map(outcomes.map((outcome) => [outcome.name, outcome]));
	for (const item of batch) {
		const outcome: BulkDocumentOutcome = byName.get(item.name) ?? { name: item.name, status: "failed", reason: "plane-unavailable" };
		if (outcome.status === "failed" && outcome.reason === "conflict") tally.conflicts.push(item);
		else await recordOutcome(deps, tally, item, outcome);
	}
}

/**
 * Phase S: deletes the plane documents the request's changes superseded, when no active row holds their id any more. The
 * count is read after every row of the request is recorded. A failure leaves an orphan that is counted, never a failed document.
 */
async function deleteSuperseded(deps: CorpusIngestDeps, tally: Tally): Promise<void> {
	const unreferenced: string[] = [];
	for (const id of tally.superseded) {
		try {
			if ((await deps.store.activeReferences(id)) === 0) unreferenced.push(id);
		} catch {
			tally.orphaned += 1;
		}
	}
	if (unreferenced.length === 0) return;
	try {
		const deleted = await deps.plane.deleteDocuments(unreferenced);
		tally.orphaned += deleted.failed.length;
	} catch {
		tally.orphaned += unreferenced.length;
	}
}

/**
 * Phase T, tombstones. The plane document goes first and the row second: a row is marked removed only after its plane
 * deletion is confirmed, or when the plane document is shared with an active row that stays (nothing to delete). A key with
 * no active row is `unchanged`. A plane deletion that fails or is not confirmed (`delete-failed`) leaves its row ACTIVE, so
 * a retry plans and deletes it again (the plane counts an unknown id as deleted).
 */
async function tombstone(deps: CorpusIngestDeps, tally: Tally, keys: ReadonlyArray<{ repo: string; path: string }>): Promise<void> {
	const active: ManifestRow[] = [];
	for (const { repo, path } of keys) {
		try {
			const row = await deps.store.rowFor(repo, path);
			if (row === null || row.state !== "active") settle(tally, repo, path, "unchanged");
			else active.push(row);
		} catch {
			settle(tally, repo, path, "failed", { reason: "manifest-unavailable" });
		}
	}
	const holders = new Map<string, ManifestRow[]>();
	for (const row of active) {
		if (row.documentId === null) continue;
		holders.set(row.documentId, [...(holders.get(row.documentId) ?? []), row]);
	}
	// An id is deleted only when every active row holding it is being tombstoned in this request.
	const toDelete: string[] = [];
	for (const [id, rows] of holders) {
		try {
			if ((await deps.store.activeReferences(id)) <= rows.length) toDelete.push(id);
		} catch {
			for (const row of rows) settle(tally, row.repo, row.path, "failed", { reason: "manifest-unavailable" });
			holders.delete(id);
		}
	}
	const undeleted = new Set<string>();
	if (toDelete.length > 0) {
		try {
			const outcome = await deps.plane.deleteDocuments(toDelete);
			for (const failure of outcome.failed) undeleted.add(failure.id);
		} catch {
			for (const id of toDelete) undeleted.add(id);
		}
	}
	for (const row of active) {
		const key = documentKey(row.repo, row.path);
		if (tally.results.has(key)) continue;
		if (row.documentId !== null && undeleted.has(row.documentId)) {
			settle(tally, row.repo, row.path, "failed", { reason: "delete-failed", documentId: row.documentId });
			continue;
		}
		try {
			await deps.store.markTombstoned(row.repo, row.path);
			settle(tally, row.repo, row.path, "tombstoned", { documentId: row.documentId });
		} catch {
			settle(tally, row.repo, row.path, "failed", { reason: "manifest-unavailable" });
		}
	}
}

function countOf(results: readonly CorpusIngestResultItem[]): Record<IngestStatus, number> {
	const counts: Record<IngestStatus, number> = { ingested: 0, updated: 0, unchanged: 0, tombstoned: 0, refused: 0, failed: 0 };
	for (const result of results) counts[result.status] += 1;
	return counts;
}

/** One `note` for the request (counts only) and one `warning` per refusal reason (reason, count, rule names). Never throws. */
async function report(deps: CorpusIngestDeps, tally: Tally, results: readonly CorpusIngestResultItem[], counts: Record<IngestStatus, number>, manifestVersion: number): Promise<void> {
	const safe = (event: EventInput): Promise<void> =>
		deps.emit(event).then(
			() => undefined,
			() => undefined,
		);
	await safe({
		surface: deps.surface,
		kind: "note",
		summary: `corpus ingest: ${counts.ingested} ingested, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.tombstoned} tombstoned, ${counts.refused} refused, ${counts.failed} failed`,
		session_id: deps.sessionId,
		payload: {
			action: "docs.corpus.ingest",
			ingested: counts.ingested,
			updated: counts.updated,
			unchanged: counts.unchanged,
			tombstoned: counts.tombstoned,
			refused: counts.refused,
			failed: counts.failed,
			batches: tally.batches,
			orphaned_documents: tally.orphaned,
			manifest_version: manifestVersion,
		},
	});
	const refusals = new Map<string, number>();
	for (const result of results) if (result.status === "refused" && result.reason !== undefined) refusals.set(result.reason, (refusals.get(result.reason) ?? 0) + 1);
	for (const [reason, count] of refusals) {
		const rules = [...(tally.rules.get(reason) ?? [])].sort();
		await safe({
			surface: deps.surface,
			kind: "warning",
			summary: `corpus ingest refused: ${reason}`,
			session_id: deps.sessionId,
			payload: { action: "docs.corpus.refused", status: "refused", reason, count, ...(rules.length > 0 ? { rules } : {}) },
		});
	}
}

/**
 * The ingest, one request, in three phases. Request bounds and field shapes were checked by `parseIngestRequest`; the gates by
 * `corpusGate`. Returns one result per document and tombstone, in request order, and never throws for a plane or manifest
 * failure. Requests on this process run one at a time (`ingestLock`), the lock held across the whole request including its
 * plane deletes.
 */
export function ingestCorpus(deps: CorpusIngestDeps, request: CorpusIngestRequest): Promise<CorpusIngestResponse> {
	return ingestLock.run(() => runIngest(deps, request));
}

async function runIngest(deps: CorpusIngestDeps, request: CorpusIngestRequest): Promise<CorpusIngestResponse> {
	const tally: Tally = { results: new Map(), rules: new Map(), orphaned: 0, batches: 0, superseded: new Set(), conflicts: [] };
	// Phase T: every tombstone, deletes included, finishes before the first insert.
	await tombstone(deps, tally, request.tombstones);

	// Phase I: inserts and replacements. Batches may run concurrently, but nothing here deletes from the plane.
	const prepared: PreparedDocument[] = [];
	for (const document of request.documents) {
		const item = await prepareDocument(deps, tally, document);
		if (item !== null) prepared.push(item);
	}
	const batches = chunkByLimits(prepared, deps.settings.batchDocs, deps.settings.batchBytes);
	await runBounded(batches, deps.settings.concurrency, (batch) => sendBatch(deps, tally, batch));
	// A same-name leftover is cleared and rewritten only once every batch has recorded its rows, one document at a time.
	for (const item of tally.conflicts) await recordOutcome(deps, tally, item, await resolveConflict(deps, item));

	// Phase S: only now, with every row of the request recorded, are the plane documents the changes superseded deleted.
	await deleteSuperseded(deps, tally);

	const results: CorpusIngestResultItem[] = [];
	for (const { repo, path } of [...request.documents, ...request.tombstones]) {
		const result = tally.results.get(documentKey(repo, path));
		if (result !== undefined) results.push(result);
	}
	const counts = countOf(results);
	let manifestVersion = 0;
	try {
		manifestVersion = await deps.store.manifestVersion();
	} catch {
		// The work is done and recorded; the version is only a freshness hint, so a failed read does not fail the reply.
	}
	await report(deps, tally, results, counts, manifestVersion);
	return { protocol: CORPUS_PROTOCOL, results, counts, manifestVersion };
}
