/**
 * Docs version cutter (D25-17).
 *
 * `finalize(dataset, commit, pathsPresent)` cuts one refresh run into a
 * version: the commit's pages become current, absent pages stop being
 * searchable, the version list keeps the last five, and documents belonging
 * to none of the last five are deleted from RAGFlow.
 *
 * Searchability uses the 25-01-researched mechanism, preference 3:
 * post-filter against the manifest (no enable/disable flag and no retrieval
 * `document_ids` filter appear in the observed 0.27.1 sources). Absent pages
 * simply join no version, so {@link currentDocumentIds} — the set search.ts
 * intersects hits with — excludes them.
 *
 * A version is cut only after every page's parse finished: finalize verifies
 * each present page's documents report `run: DONE` and refuses the cut
 * otherwise. `pages` carries the run's own ingest snapshot, so an overlapping
 * run cannot cross-record commits; paths without a snapshot read the latest
 * manifest entry (unchanged-page reuse). Pruning also drops path entries no
 * live version references — except entries with documents still parsing from
 * another run, whose in-flight work survives the cut — so a restored page
 * re-uploads instead of reusing deleted ids. Any failure leaves the previous
 * version current — the manifest
 * is written once, after every RAGFlow call succeeds. `finalize` is
 * attributed as `docs_ingest` under the same writer rule as ingestPage.
 */
import { dropDatasetId, findDataset, loadRegistry } from "./registry.ts";
import type { DatasetEntry } from "./registry.ts";
import { RagflowError } from "./ragflow.ts";
import type { RagflowDocument } from "./ragflow.ts";
import { loadManifest, saveManifest, withDatasetLock } from "./manifest.ts";
import type { DocsManifest, DocsRagflow } from "./manifest.ts";
import { isStaleDatasetId, resolveIngestDatasetId } from "./ingest.ts";

/** Only the last five versions survive (D25-17). */
export const KEEP_VERSIONS = 5;

export interface FinalizePageSnapshot {
	/** Repo-relative path this refresh run ingested. */
	path: string;
	/** Content hash this run's ingestPage result reported. */
	hash: string;
	/** Document ids this run's ingestPage result reported. */
	documentIds: string[];
}

export interface FinalizeInput {
	dataset: string;
	commit: string;
	/** Repo-relative paths present at this commit (refused pages simply absent). */
	pathsPresent: string[];
	/**
	 * Per-run snapshot: what this refresh run's own ingestPage calls reported
	 * (`uploaded` and `unchanged` results both carry documentIds). A snapshot
	 * entry wins over the latest manifest.paths, so an overlapping run that
	 * re-ingested the same page cannot cross-record commits into this cut.
	 * Paths without a snapshot fall back to manifest.paths, preserving
	 * unchanged-page reuse for drivers that only snapshot changed pages.
	 */
	pages?: FinalizePageSnapshot[];
	surface: string;
	isSubstrateOrOperator: boolean;
}

export interface FinalizeDeps {
	registry?: readonly DatasetEntry[];
	client: DocsRagflow;
	stateDir?: string;
	env?: Record<string, string | undefined>;
	embeddingModel?: string;
}

export type FinalizeResult =
	| {
			status: "version-cut";
			dataset: string;
			datasetId: string;
			commit: string;
			paths: string[];
			versions: number;
			deletedDocumentIds: string[];
	  }
	| { status: "refused"; reason: "forbidden" | "unknown-dataset" | "outside-roots" }
	| {
			status: "failed";
			reason: "ragflow-error" | "ragflow-timeout" | "ragflow-unreachable" | "ragflow-bad-response";
			message: string;
	  };

const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

function failedFrom(error: unknown): FinalizeResult {
	if (error instanceof RagflowError) {
		const message = error.message;
		if (message.startsWith("ragflow timeout")) return { status: "failed", reason: "ragflow-timeout", message };
		if (message.startsWith("ragflow unreachable")) {
			return { status: "failed", reason: "ragflow-unreachable", message };
		}
		if (/non-JSON|no chunks|no datasets|no documents|cross-origin|redirected/.test(message)) {
			return { status: "failed", reason: "ragflow-bad-response", message };
		}
		return { status: "failed", reason: "ragflow-error", message };
	}
	if (error instanceof FinalizeHalt) return { status: "failed", reason: "ragflow-error", message: error.message };
	throw error;
}

/** A cut precondition failed after RAGFlow calls already succeeded: no throw
 * past the lock, just a `failed` result with the manifest untouched. */
class FinalizeHalt extends Error {}

async function listAllDocuments(client: DocsRagflow, datasetId: string): Promise<RagflowDocument[]> {
	const all: RagflowDocument[] = [];
	let page = 1;
	for (;;) {
		const docs = await client.listDocuments(datasetId, page, 100);
		all.push(...docs);
		if (docs.length < 100) return all;
		page += 1;
	}
}

export async function finalize(input: FinalizeInput, deps: FinalizeDeps): Promise<FinalizeResult> {
	if (!input.isSubstrateOrOperator) return { status: "refused", reason: "forbidden" };
	if (!COMMIT_PATTERN.test(input.commit)) return { status: "refused", reason: "outside-roots" };
	const registry = deps.registry ?? loadRegistry();
	if (!findDataset(registry, input.dataset)) return { status: "refused", reason: "unknown-dataset" };

	const locked = async (): Promise<FinalizeResult> => {
			const datasetId = await resolveIngestDatasetId(registry, deps.client, input.dataset, deps.embeddingModel);
			const manifest = await loadManifest(input.dataset, {
				stateDir: deps.stateDir,
				env: deps.env,
				client: deps.client,
				datasetId,
			});
			const listed = await listAllDocuments(deps.client, datasetId);
			const runById = new Map(listed.map((doc) => [doc.id, doc.run]));
			// The cut needs every present page parsed: any document still
			// queued, failed, or missing blocks the version (D25-20). Ids come
			// from the run's own snapshot when present, so an overlapping run
			// that re-ingested the same page cannot cross-record commits.
			const snapshots: Record<string, FinalizePageSnapshot> = Object.fromEntries(
				(input.pages ?? []).map((page) => [page.path, page]),
			);
			const idsFor = (path: string): string[] =>
				snapshots[path]?.documentIds ?? manifest.paths[path]!.documentIds;
			const paths = input.pathsPresent.filter(
				(path) => snapshots[path] !== undefined || manifest.paths[path] !== undefined,
			);
			for (const path of paths) {
				for (const id of idsFor(path)) {
					const run = runById.get(id);
					if (run !== "DONE") {
						throw new FinalizeHalt(
							`refusing to cut ${input.commit}: document ${id} for ${path} reports run ${run ?? "missing"}`,
						);
					}
				}
			}
			const documentIds = [...new Set(paths.flatMap((path) => idsFor(path)))];
			const versions = [
				...manifest.versions,
				{
					commit: input.commit,
					paths,
					documentIds,
					cutAt: new Date().toISOString(),
				},
			].slice(-KEEP_VERSIONS);
			const live = new Set(versions.flatMap((version) => version.documentIds));
			// In-flight protection: the dataset lock covers one ingestPage or one
			// finalize, not a whole refresh, so another run may have uploaded a
			// page (manifest.paths updated, documents still parsing) that this
			// cut does not cover. Only a parse that is still running
			// (UNSTART, RUNNING, or RAGFlow's "0") keeps its path entry and
			// its document ids. FAIL, CANCEL, and a document the list no
			// longer has are abandoned, so a removed file does not stay
			// searchable. Snapshot-replaced documents still prune as before.
			const protectedIds = new Set<string>();
			const protectedPaths = new Set<string>();
			const inFlight = new Set(["UNSTART", "RUNNING", "0"]);
			for (const [path, entry] of Object.entries(manifest.paths)) {
				if (snapshots[path] !== undefined) continue;
				if (entry.documentIds.length === 0) continue;
				const parsing = entry.documentIds.some((id) => inFlight.has(runById.get(id) ?? ""));
				if (!parsing) continue;
				protectedPaths.add(path);
				for (const id of entry.documentIds) protectedIds.add(id);
			}
			const stale = listed.map((doc) => doc.id).filter((id) => !live.has(id) && !protectedIds.has(id));
			if (stale.length > 0) await deps.client.deleteDocuments(datasetId, stale);
			// This run's own snapshot wins for paths it covers: the just-cut
			// version resolves through `manifest.paths`, so the entry must hold
			// this run's documents — not an overlapping run's newer entry, which
			// would cross-record commits into the cut.
			const nextPaths = { ...manifest.paths };
			for (const path of paths) {
				const snapshot = snapshots[path];
				if (snapshot === undefined) continue;
				const prev = nextPaths[path];
				nextPaths[path] = {
					hash: snapshot.hash,
					documentIds: [...snapshot.documentIds],
					meta: prev?.meta ?? [],
					updatedCommit: input.commit,
				};
			}
			// Drop path entries no live version references: their documents are
			// gone, so an unchanged re-ingest must upload fresh documents rather
			// than reuse deleted ids (which would fail the cut above forever).
			const livePaths = new Set(versions.flatMap((version) => version.paths));
			for (const path of Object.keys(nextPaths)) {
				if (!livePaths.has(path) && !protectedPaths.has(path)) delete nextPaths[path];
			}
			const next: DocsManifest = { ...manifest, current: input.commit, versions, paths: nextPaths };
			await saveManifest(input.dataset, next, { stateDir: deps.stateDir, env: deps.env });
			return {
				status: "version-cut",
				dataset: input.dataset,
				datasetId,
				commit: input.commit,
				paths,
				versions: versions.length,
				deletedDocumentIds: stale,
			};
	};
	try {
		return await withDatasetLock(input.dataset, locked);
	} catch (error) {
		// Same stale-id recovery as ingestPage: drop the cached id and
		// resolve again (listing misses, so ensureDataset recreates) once.
		if (!isStaleDatasetId(error)) return failedFrom(error);
		dropDatasetId(input.dataset);
		try {
			return await withDatasetLock(input.dataset, locked);
		} catch (retryError) {
			return failedFrom(retryError);
		}
	}
}
