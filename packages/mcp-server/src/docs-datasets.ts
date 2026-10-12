/**
 * DOCS-03: dataset version pins and the skills-sync degradation (D25-06,
 * D25-07).
 *
 * Refresh records a version per dataset and keeps the last five. The
 * `agent-skills` refresh is driven by skills-sync fast-forward evidence:
 * with the sync unit not yet live there is no evidence, so refresh
 * degrades explicitly — one warning, and serve from the last pinned
 * version with the pin age in the reply.
 *
 * Dataset discovery and creation live behind the operator G2 gate, not in
 * this module: the runtime ingest path refuses unknown datasets and the
 * runbook owns creation.
 */
import type { FetchLike, RagflowConfig } from "./planes/ragflow.ts";
import type { DatasetPin } from "./docs-search.ts";
import type { EventInput, Surface } from "./types.ts";


/** How many versions each dataset keeps (D25-06). */
export const DATASET_VERSION_RETENTION = 5;

export interface DatasetVersion {
	dataset: string;
	dataset_id: string;
	version: string;
	commit: string;
	content_sha256: string;
	ingested_at: string;
	/**
	 * The served corpus: every document backing this pin, so search cites
	 * the pin commit only for chunks from these documents. Pins recorded
	 * without a manifest (older rows, resolve-first refreshes) cite
	 * nothing: their chunks read as unpinned rather than falsely current.
	 */
	documents?: VersionDocument[];
}

/** One served document inside a version pin. */
export interface VersionDocument {
	source_url: string;
	document_id: string;
	content_sha256: string;
}

/** Per-dataset version lists, newest last. */
export type VersionStore = Map<string, DatasetVersion[]>;

export function createVersionStore(): VersionStore {
	return new Map<string, DatasetVersion[]>();
}

/** Record a version, keeping the last five per dataset (D25-06). */
export function recordVersion(store: VersionStore, version: DatasetVersion): DatasetVersion[] {
	const kept = [...(store.get(version.dataset) ?? []), version].slice(-DATASET_VERSION_RETENTION);
	store.set(version.dataset, kept);
	return kept;
}

/** The newest recorded version for a dataset, if any. */
export function latestVersion(store: VersionStore, dataset: string): DatasetVersion | undefined {
	const versions = store.get(dataset) ?? [];
	return versions[versions.length - 1];
}

/** Fields a version finalize needs; the store supplies the monotonic number. */
export interface DatasetVersionFields {
	dataset: string;
	dataset_id: string;
	commit: string;
	content_sha256: string;
	ingested_at: string;
	documents?: VersionDocument[];
}

/**
 * Record the next version for a dataset with a store-derived monotonic
 * number, keeping the last five (D25-06). Shared by the resolve-first
 * refresh and the substrate ingest finalize so the two doors cannot fork
 * the numbering: only changed, fully-parsed corpora promote, and the
 * caller decides that — this helper only numbers and retains.
 */
export function recordDatasetVersion(store: VersionStore, fields: DatasetVersionFields): DatasetVersion {
	const prior = store.get(fields.dataset) ?? [];
	const generation = prior.reduce((top, record) => {
		const n = Number(/^v(\d+)$/.exec(record.version)?.[1] ?? 0);
		return Math.max(top, Number.isFinite(n) ? n : 0);
	}, 0);
	const version: DatasetVersion = { ...fields, version: `v${generation + 1}` };
	recordVersion(store, version);
	return version;
}

/** The search pins for every dataset with a recorded version. */
export function pinsFromVersions(store: VersionStore): Record<string, DatasetPin> {
	const pins: Record<string, DatasetPin> = {};
	for (const versions of store.values()) {
		const latest = versions[versions.length - 1];
		if (latest) pins[latest.dataset_id] = { dataset: latest.dataset, dataset_id: latest.dataset_id, version: latest.version, commit: latest.commit, ingested_at: latest.ingested_at, ...(latest.documents !== undefined ? { documents: latest.documents } : {}) };
	}
	return pins;
}


export interface RefreshDeps {
	config: RagflowConfig;
	versions: VersionStore;
	emit: (event: EventInput) => Promise<unknown>;
	surface?: Surface | null;
	sessionId?: string;
	fetchImpl?: FetchLike;
	nowMs?: number;
}

/**
 * Whether the Phase 22 skills-sync unit has produced fast-forward evidence.
 * The sync tick's projection step flips it via `noteSkillsSyncFastForward`;
 * until then the unit is not live and `agent-skills` serves degraded.
 */
export interface SkillsSyncTracker {
	fastForwardObserved: boolean;
	notLiveWarned: boolean;
}

export function createSkillsSyncTracker(): SkillsSyncTracker {
	return { fastForwardObserved: false, notLiveWarned: false };
}

/**
 * The refresh hook: call on sync fast-forward evidence (D25-07). No timer,
 * no surface — the tick calls this, and the first real fast-forward drives
 * the `agent-skills` refresh with no code change.
 */
export function noteSkillsSyncFastForward(tracker: SkillsSyncTracker): void {
	tracker.fastForwardObserved = true;
}

export function isSyncLive(tracker: SkillsSyncTracker): boolean {
	return tracker.fastForwardObserved;
}

export interface DegradedServe {
	dataset: string;
	pin: DatasetPin;
	pin_age_ms: number;
}

/**
 * Serve `agent-skills` from its last pin while the sync unit is not live:
 * one warning ever, then the pin with its age for the reply (D25-07). No
 * silent staleness — the pin age travels in the reply.
 */
export async function degradedAgentSkillsServe(
	deps: RefreshDeps,
	tracker: SkillsSyncTracker,
): Promise<{ ok: true; serve: DegradedServe } | { ok: false; reason: string }> {
	const pin = latestVersion(deps.versions, "agent-skills");
	if (!pin) return { ok: false, reason: "no-pinned-version" };
	const nowMs = deps.nowMs ?? Date.now();
	if (!tracker.notLiveWarned) {
		tracker.notLiveWarned = true;
		await deps.emit({
			surface: deps.surface ?? "claude-code",
			kind: "warning",
			summary: "docs dataset agent-skills serves its pinned version: skills-sync is not live",
			session_id: deps.sessionId ?? "docs-refresh:agent-skills",
			payload: { action: "docs.ingest", reason: "skills-sync-not-live", dataset_id: pin.dataset_id, version: pin.version },
		});
	}
	return {
		ok: true,
		serve: {
			dataset: "agent-skills",
			pin: { dataset: pin.dataset, dataset_id: pin.dataset_id, version: pin.version, commit: pin.commit, ingested_at: pin.ingested_at },
			pin_age_ms: Math.max(0, nowMs - Date.parse(pin.ingested_at)),
		},
	};
}
