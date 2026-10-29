/**
 * The corpus bulk ingest (v1.7 phase 63): puts new and changed documents into the docs plane in batches, removes tombstoned
 * ones, and keeps the manifest (`corpus_documents`) in step. Called by `POST /corpus/ingest` and the `corpus_ingest` tool.
 *
 * Safety rules the order of work encodes:
 * - Nothing leaves this module for the plane unless the gates pass (`corpusGate`), the body hashes to its entry's sha256, and
 *   the redactor's secret findings are clean. A refused document is never sent and never recorded.
 * - A document the manifest already holds at that sha is `unchanged` and not sent, so a re-run is a no-op and a killed run
 *   resumes with only what it had not recorded.
 * - The manifest row is written after the plane accepted the document and BEFORE the document it supersedes is deleted, so a
 *   crash leaves the old document, or the old and the new, never neither.
 * - A plane document is deleted only when no other active row holds its id (identical text under two names shares one id).
 * - A plane failure marks the affected documents `failed` and records nothing, so a retry sends only them.
 *
 * Tombstones run before the documents: a rename is a tombstone and an add of the same text, and deleting the old document
 * first makes the plane store the text under its new name, so a search citation names the new path.
 */
import { createHash } from "node:crypto";
import { CORPUS_PROTOCOL, documentKey, sourceUrl, type CorpusDocument, type CorpusIngestRequest, type CorpusIngestResponse, type CorpusIngestResultItem, type IngestStatus } from "@substrate/corpus";
import { findingRules, stripRemoteImages } from "../docs-ingest.ts";
import type { BulkDocumentOutcome, BulkTextDocument, LightragBulkPlane } from "../planes/lightrag-bulk.ts";
import type { EventInput, Surface } from "../types.ts";
import { corpusDocumentName, isSafeCorpusName, planeDocumentIdForName } from "./names.ts";
import type { CorpusStore, ManifestRow } from "./store.ts";
import { MAX_DOCUMENT_BYTES } from "./validate.ts";

/** Why a document is refused before anything is sent. Closed. */
export const REFUSAL_REASONS = ["too-large", "empty-document", "sha-mismatch", "unsafe-name", "secret-findings"] as const;

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

/** Decides one document: refused, unchanged, or ready to send. A store read that fails fails the document, never the request. */
async function prepareDocument(deps: CorpusIngestDeps, tally: Tally, document: CorpusDocument): Promise<PreparedDocument | null> {
	const bytes = Buffer.byteLength(document.body, "utf8");
	if (bytes > MAX_DOCUMENT_BYTES) {
		refuse(tally, document, "too-large");
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
		settle(tally, document.repo, document.path, "unchanged", { documentId: prior.documentId });
		return null;
	}
	const name = corpusDocumentName(document.repo, document.path, document.sha256);
	if (!isSafeCorpusName(name)) {
		refuse(tally, document, "unsafe-name");
		return null;
	}
	const text = stripRemoteImages(document.body).body;
	if (text.trim().length === 0) {
		refuse(tally, document, "empty-document");
		return null;
	}
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
 * deleted and the document written again, once, so the row records a document the plane has just processed.
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

/** Sends one batch, records the rows the plane accepted, then deletes the plane documents those rows superseded. Never throws. */
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
	const superseded = new Set<string>();
	for (const item of batch) {
		const { repo, path } = item.document;
		let outcome: BulkDocumentOutcome = byName.get(item.name) ?? { name: item.name, status: "failed", reason: "plane-unavailable" };
		if (outcome.status === "failed" && outcome.reason === "conflict") outcome = await resolveConflict(deps, item);
		if (outcome.status !== "ingested") {
			settle(tally, repo, path, "failed", { reason: failureReason(outcome.reason) });
			continue;
		}
		if (outcome.documentId === undefined || outcome.documentId.length === 0) {
			settle(tally, repo, path, "failed", { reason: "pipeline-failed" });
			continue;
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
			// resolves it above, so nothing is lost and nothing is sent twice unrecorded.
			settle(tally, repo, path, "failed", { reason: "manifest-unavailable" });
			continue;
		}
		settle(tally, repo, path, "ingested", { documentId: outcome.documentId });
		const old = item.prior?.documentId;
		if (old !== undefined && old !== null && old !== outcome.documentId) superseded.add(old);
	}
	await deleteSuperseded(deps, tally, superseded);
}

/** Deletes the superseded plane documents nobody references any more; a failure leaves an orphan that is counted, never a failed document. */
async function deleteSuperseded(deps: CorpusIngestDeps, tally: Tally, ids: ReadonlySet<string>): Promise<void> {
	const unreferenced: string[] = [];
	for (const id of ids) {
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
 * Tombstones: deletes the plane documents no other active row shares, then marks the rows. A key with no active row is
 * `unchanged`. A plane delete that fails leaves its row active, so the retry deletes again (the plane counts an unknown id
 * as deleted).
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
	const counts: Record<IngestStatus, number> = { ingested: 0, unchanged: 0, tombstoned: 0, refused: 0, failed: 0 };
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
		summary: `corpus ingest: ${counts.ingested} ingested, ${counts.unchanged} unchanged, ${counts.tombstoned} tombstoned, ${counts.refused} refused, ${counts.failed} failed`,
		session_id: deps.sessionId,
		payload: {
			action: "docs.corpus.ingest",
			ingested: counts.ingested,
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
 * The ingest. Request bounds and field shapes were checked by `parseIngestRequest`; the gates by `corpusGate`. Returns one
 * result per document and tombstone, in request order, and never throws for a plane or manifest failure.
 */
export async function ingestCorpus(deps: CorpusIngestDeps, request: CorpusIngestRequest): Promise<CorpusIngestResponse> {
	const tally: Tally = { results: new Map(), rules: new Map(), orphaned: 0, batches: 0 };
	await tombstone(deps, tally, request.tombstones);

	const prepared: PreparedDocument[] = [];
	for (const document of request.documents) {
		const item = await prepareDocument(deps, tally, document);
		if (item !== null) prepared.push(item);
	}
	const batches = chunkByLimits(prepared, deps.settings.batchDocs, deps.settings.batchBytes);
	await runBounded(batches, deps.settings.concurrency, (batch) => sendBatch(deps, tally, batch));

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
