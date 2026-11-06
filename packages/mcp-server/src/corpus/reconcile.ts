/**
 * The corpus reconcile (v1.7 phase 65): compares the manifest's active rows with what the docs plane holds. The manifest and
 * the plane are a dual write (the plane takes the document, then the manifest records it), so a document can be gone from
 * the plane while its row says it is there, and a document can sit in the plane with no row that owns it. Both are drift;
 * this module finds it and, only on request, repairs it.
 *
 * What a repair does, and what it never does:
 * - A row whose plane document is gone is marked removed WITHOUT calling the plane (there is nothing to delete), so the next
 *   plan offers its path as an `add` and the next sync puts the document back.
 * - A `corpus:`-named plane document no active row owns is deleted with the ingest's rules: it is confirmed by the plane,
 *   and a delete that fails or is not confirmed is not counted as repaired. The count of repaired documents is smaller
 *   than the count found, and the next run finds the rest again.
 * - A plane document whose name does not start with `corpus:` is never named, listed or touched: the listing keeps only the
 *   ids of such documents, to recognise one that a corpus row shares.
 *
 * Absence of evidence is not evidence of absence. A row is `missingInPlane` only when the plane listing is complete (no
 * page bound, time bound or unreadable entry cut it short) and a direct lookup of its id says it is gone. A lookup that
 * fails leaves the row alone. A plane document is an orphan only when every active row was
 * read (a manifest larger than {@link RECONCILE_MAX_ROWS} is read in part, so a document its unread rows own would look
 * unowned). Either gap makes the reply `truncated` instead.
 *
 * Runs under the same lock as the ingest, so a repair never overlaps a plane write.
 */
import { CORPUS_NAME_PREFIX, CORPUS_PROTOCOL, RECONCILE_MAX_ITEMS, corpusDocumentName, type CorpusReconcileResponse } from "@substrate/corpus";
import type { LightragBulkPlane, PlaneListedDocument } from "../planes/lightrag-bulk.ts";
import { reportSilent } from "../silent-failures.ts";
import { withCorpusLock } from "./ingest.ts";
import type { CorpusStore, ManifestRow } from "./store.ts";

/** Most active rows one reconcile reads. A manifest beyond it is judged for missing documents only, never for orphans. */
export const RECONCILE_MAX_ROWS = 100_000;
/** How long missing-row lookups may run before the rest are left unconfirmed. The ingest lock is held for the whole reconcile. */
const RECONCILE_LOOKUP_BUDGET_MS = 8_000;

/** The plane documents a listing named, as `diffPlane` reads them: `PlaneListing` without its failure arm. */
interface PlaneSnapshot {
	documents: readonly PlaneListedDocument[];
	otherDocumentIds: readonly string[];
	truncated: boolean;
}

interface PlaneDrift {
	/** Active rows whose plane document the (complete) listing does not hold. */
	missing: ManifestRow[];
	/** `corpus:` plane documents no active row owns, by id and name, ordered by name. */
	orphans: PlaneListedDocument[];
	/** Active rows compared: those that name a plane document. */
	checked: number;
}

/**
 * The drift between `rows` and a plane listing. Pure. A plane document is owned by a row when the row's `docs_document_id`
 * is its id, or when its name is the one the row's current content would be stored under (a duplicate-content record names a
 * row's document under another id). `rowsComplete` says `rows` is every active row.
 */
export function diffPlane(rows: readonly ManifestRow[], plane: PlaneSnapshot, rowsComplete: boolean): PlaneDrift {
	const present = new Set<string>([...plane.documents.map((document) => document.id), ...plane.otherDocumentIds]);
	const ownedIds = new Set<string>();
	const ownedNames = new Set<string>();
	const missing: ManifestRow[] = [];
	let checked = 0;
	for (const row of rows) {
		ownedNames.add(corpusDocumentName(row.repo, row.path, row.sha256));
		if (row.documentId === null) continue;
		ownedIds.add(row.documentId);
		checked += 1;
		if (!plane.truncated && !present.has(row.documentId)) missing.push(row);
	}
	const orphans: PlaneListedDocument[] = [];
	if (rowsComplete) {
		const seen = new Set<string>();
		for (const document of plane.documents) {
			if (!document.name.startsWith(CORPUS_NAME_PREFIX) || ownedIds.has(document.id) || ownedNames.has(document.name) || seen.has(document.id)) continue;
			seen.add(document.id);
			orphans.push(document);
		}
		orphans.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	}
	return { missing, orphans, checked };
}

interface ReconcileDeps {
	store: CorpusStore;
	plane: LightragBulkPlane;
	signal?: AbortSignal | undefined;
}

type ReconcileFailure = { ok: false; reason: "corpus.index-unavailable" | "corpus.plane-unreachable"; detail?: string };

type ReconcileResult = { ok: true; body: CorpusReconcileResponse } | ReconcileFailure;

/**
 * Marks each reported row removed so the next plan offers it as an `add`. The row is read again first: it is marked only
 * when it is still the active row the drift described (same plane document, same content), so a row an earlier step of this
 * request or another door changed is left alone. A row that cannot be read or marked is simply not counted.
 */
async function requeue(store: CorpusStore, missing: readonly ManifestRow[]): Promise<number> {
	let requeued = 0;
	for (const reported of missing) {
		try {
			const current = await store.rowFor(reported.repo, reported.path);
			if (current === null || current.state !== "active" || current.documentId !== reported.documentId || current.sha256 !== reported.sha256) continue;
			if (await store.markTombstoned(reported.repo, reported.path)) requeued += 1;
		} catch {
			// The row stays active; the next run reports it again.
		}
	}
	return requeued;
}

/**
 * Deletes the reported orphans from the plane and returns how many the plane confirmed. An orphan is re-checked against the
 * manifest right before the delete (a document an active row holds now is kept), and only a `corpus:` name is ever sent.
 */
async function deleteOrphans(deps: ReconcileDeps, orphans: readonly PlaneListedDocument[]): Promise<number> {
	const ids: string[] = [];
	for (const orphan of orphans) {
		if (!orphan.name.startsWith(CORPUS_NAME_PREFIX)) continue;
		try {
			if ((await deps.store.activeReferences(orphan.id)) > 0) continue;
		} catch (cause: unknown) {
			reportSilent("reconcile.reference-check", cause);
			continue;
		}
		ids.push(orphan.id);
	}
	if (ids.length === 0) return 0;
	try {
		const outcome = await deps.plane.deleteDocuments(ids);
		const asked = new Set(ids);
		return outcome.deleted.filter((id) => asked.has(id)).length;
	} catch {
		return 0;
	}
}

async function run(deps: ReconcileDeps, execute: boolean): Promise<ReconcileResult> {
	let rows: ManifestRow[];
	let rowsComplete = false;
	try {
		const page = await deps.store.activeRows(RECONCILE_MAX_ROWS);
		rows = page.rows;
		rowsComplete = !page.truncated;
	} catch {
		return { ok: false, reason: "corpus.index-unavailable" };
	}
	const listing = await deps.plane.listDocuments({ signal: deps.signal });
	if (!listing.ok) return { ok: false, reason: "corpus.plane-unreachable", detail: listing.reason };

	const drift = diffPlane(rows, listing, rowsComplete);
	const gone: ManifestRow[] = [];
	let lookupFailed = false;
	let unlooked = false;
	const started = Date.now();
	let lookups = 0;
	for (const row of drift.missing) {
		if (row.documentId === null) continue;
		if (lookups >= RECONCILE_MAX_ITEMS || Date.now() - started >= RECONCILE_LOOKUP_BUDGET_MS) {
			unlooked = true;
			continue;
		}
		lookups += 1;
		let looked: "present" | "absent" | "unknown" = "unknown";
		try {
			looked = await deps.plane.lookupDocument(row.documentId, { signal: deps.signal });
		} catch {
			looked = "unknown";
		}
		if (looked === "absent") gone.push(row);
		else if (looked === "unknown") lookupFailed = true;
	}
	// One bound for the whole run: RECONCILE_MAX_ITEMS keys in total, missing rows and orphans together. Missing rows take first
	// (marking one removed needs no plane delete); orphans take what is left. Whatever the bound cuts is reported truncated.
	const missing = gone.slice(0, RECONCILE_MAX_ITEMS);
	const orphans = drift.orphans.slice(0, RECONCILE_MAX_ITEMS - missing.length);
	const truncated = listing.truncated || !rowsComplete || gone.length + drift.orphans.length > RECONCILE_MAX_ITEMS || lookupFailed || unlooked;

	// Rows first: marking one removed needs no plane delete, so a slow or failing plane delete cannot hold that repair back.
	// The lookup above already confirmed the id is gone; a failed lookup never reaches here.
	const requeued = execute ? await requeue(deps.store, missing) : 0;
	const deleted = execute ? await deleteOrphans(deps, orphans) : 0;

	let manifestVersion = 0;
	try {
		manifestVersion = await deps.store.manifestVersion();
	} catch {
		// The repairs are done and recorded; the version is only a freshness hint, so a failed read does not fail the reply.
	}
	return {
		ok: true,
		body: {
			protocol: CORPUS_PROTOCOL,
			drift: {
				missingInPlane: missing.map((row) => ({ repo: row.repo, path: row.path })),
				orphansInPlane: orphans.map((orphan) => orphan.name),
				checked: drift.checked,
				truncated,
			},
			repaired: { requeued, deleted },
			manifestVersion,
		},
	};
}

/** The reconcile, under the corpus lock. Never throws for a plane or manifest failure: those are the result's reasons. */
export function reconcileCorpus(deps: ReconcileDeps, execute: boolean): Promise<ReconcileResult> {
	return withCorpusLock(() => run(deps, execute));
}
