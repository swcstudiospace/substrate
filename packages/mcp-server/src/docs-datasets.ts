/**
 * DOCS-03: dataset resolve-by-name, refresh triggers and the skills-sync
 * degradation (D25-06, D25-07).
 *
 * Existing datasets are reused by name; creation happens only on a
 * name-miss with the pinned embedding model. Refresh records a version per
 * dataset and keeps the last five. The `agent-skills` refresh is driven by
 * skills-sync fast-forward evidence: with the sync unit not yet live there
 * is no evidence, so refresh degrades explicitly — one warning, and serve
 * from the last pinned version with the pin age in the reply.
 *
 * The hook has no timer and no surface: the sync tick's projection step
 * calls `noteSkillsSyncFastForward`, and search consults `isSyncLive`.
 *
 * uplift-2 R6: the version store is still a Map, but it now round-trips
 * through the docs state file (`versionsToJson` / `versionsFromJson`) so
 * pins and the merge-trigger's idempotency survive a restart, and every
 * reader of `GET /api/v1/datasets` goes through a `DatasetListSource` — in
 * production the 60 s `DatasetListCache`, invalidated by a create or a
 * failed list — instead of fetching the tenant's list per call.
 */
import { createDataset, listDatasets, type DatasetListOutcome, type FetchLike, type RagflowConfig } from "./planes/ragflow.ts";
import type { DatasetPin } from "./docs-search.ts";
import type { EventInput, Surface } from "./types.ts";

/** Every dataset this phase knows, with its refresh trigger. */
export const DATASET_TRIGGERS: Readonly<Record<string, string>> = {
	"agent-substrate": "merge to main of agent-substrate",
	"programming-desk": "merge to main of programming-desk",
	"agent-skills": "substrate-skills-sync fast-forward",
	kanbanos: "merge to main of kanbanos",
	desklanes: "merge to main of desklanes",
	clippyos: "merge to main of clippyos",
	auctioning: "merge to main of auctioning",
};

/** How many versions each dataset keeps (D25-06). */
export const DATASET_VERSION_RETENTION = 5;

export interface DatasetVersion {
	dataset: string;
	dataset_id: string;
	version: string;
	commit: string;
	content_sha256: string;
	ingested_at: string;
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

/** The search pins for every dataset with a recorded version. */
export function pinsFromVersions(store: VersionStore): Record<string, DatasetPin> {
	const pins: Record<string, DatasetPin> = {};
	for (const versions of store.values()) {
		const latest = versions[versions.length - 1];
		if (latest) pins[latest.dataset_id] = { dataset: latest.dataset, dataset_id: latest.dataset_id, version: latest.version, commit: latest.commit, ingested_at: latest.ingested_at };
	}
	return pins;
}

/**
 * The version lists as the docs state file stores them (`versions` member
 * of the v2 file): one JSON object keyed by dataset name.
 */
export function versionsToJson(store: VersionStore): Record<string, DatasetVersion[]> {
	return Object.fromEntries(store);
}

/** The version store a state file's `versions` member describes; malformed rows are skipped. */
export function versionsFromJson(value: unknown): VersionStore {
	const store = createVersionStore();
	if (value === null || typeof value !== "object" || Array.isArray(value)) return store;
	for (const [dataset, rows] of Object.entries(value)) {
		if (!Array.isArray(rows)) continue;
		const kept: DatasetVersion[] = [];
		for (const row of rows) {
			if (row === null || typeof row !== "object") continue;
			const candidate = row as Record<string, unknown>;
			if (
				typeof candidate.dataset !== "string" ||
				typeof candidate.dataset_id !== "string" ||
				typeof candidate.version !== "string" ||
				typeof candidate.commit !== "string" ||
				typeof candidate.content_sha256 !== "string" ||
				typeof candidate.ingested_at !== "string"
			) {
				continue;
			}
			kept.push({
				dataset: candidate.dataset,
				dataset_id: candidate.dataset_id,
				version: candidate.version,
				commit: candidate.commit,
				content_sha256: candidate.content_sha256,
				ingested_at: candidate.ingested_at,
			});
		}
		if (kept.length > 0) store.set(dataset, kept.slice(-DATASET_VERSION_RETENTION));
	}
	return store;
}

/**
 * Where a dataset list comes from. Production hands every reader the
 * `DatasetListCache`; the module tests and the default use the plane
 * directly, with nothing to invalidate.
 */
export interface DatasetListSource {
	list(config: RagflowConfig, fetchImpl: FetchLike | undefined): Promise<DatasetListOutcome>;
	/** Forget the held list: after a create, or after a failed list. */
	invalidate(): void;
}

export const DIRECT_DATASET_LIST: DatasetListSource = {
	list: (config, fetchImpl) => listDatasets(config, fetchImpl),
	invalidate: () => {},
};

/** How long one dataset list serves search, ingest and refresh before it is fetched again. */
export const DATASET_LIST_TTL_MS = 60_000;

/**
 * The in-process dataset list, held for `DATASET_LIST_TTL_MS` after a
 * successful fetch (uplift-2 R6). A failed list is never held and drops
 * whatever was held, so a plane that just answered an error is asked again
 * on the next call rather than served from before the error; a create
 * drops it too, so the new dataset is discoverable at once. Concurrent
 * callers during a fetch share the one in-flight request.
 */
export class DatasetListCache implements DatasetListSource {
	private held: { datasets: readonly { id: string; name: string }[]; expiresAt: number } | null = null;
	private inflight: Promise<DatasetListOutcome> | null = null;

	constructor(
		private readonly ttlMs: number = DATASET_LIST_TTL_MS,
		private readonly now: () => number = Date.now,
	) {}

	async list(config: RagflowConfig, fetchImpl: FetchLike | undefined): Promise<DatasetListOutcome> {
		const held = this.held;
		if (held && held.expiresAt > this.now()) return { ok: true, datasets: held.datasets.map((dataset) => ({ ...dataset })) };
		if (!this.inflight) {
			this.inflight = listDatasets(config, fetchImpl)
				.then((outcome) => {
					if (outcome.ok) this.held = { datasets: outcome.datasets.map((dataset) => ({ ...dataset })), expiresAt: this.now() + this.ttlMs };
					else this.held = null;
					return outcome;
				})
				.finally(() => {
					this.inflight = null;
				});
		}
		const outcome = await this.inflight;
		return outcome.ok ? { ok: true, datasets: outcome.datasets.map((dataset) => ({ ...dataset })) } : outcome;
	}

	invalidate(): void {
		this.held = null;
	}
}

export interface ResolvedDataset {
	name: string;
	id: string | null;
	created: boolean;
}

export interface ResolveDeps {
	config: RagflowConfig;
	fetchImpl?: FetchLike;
	/** Create on a name-miss. False rehearses discovery without creating (G2 owns real creation). */
	createOnMiss?: boolean;
	/** The dataset list reader; the plane directly when omitted. */
	datasets?: DatasetListSource;
}

/**
 * Discover-first resolve: match names against `GET /api/v1/datasets` and
 * create only on a name-miss (D25-06). A transport failure is a reason, not
 * a throw. A create invalidates the list source, so the next reader sees
 * the new dataset without waiting out the TTL.
 */
export async function resolveDatasets(
	deps: ResolveDeps,
	names: readonly string[],
): Promise<{ ok: true; datasets: ResolvedDataset[] } | { ok: false; reason: string }> {
	const source = deps.datasets ?? DIRECT_DATASET_LIST;
	const listed = await source.list(deps.config, deps.fetchImpl);
	if (!listed.ok) return { ok: false, reason: listed.reason };
	const datasets: ResolvedDataset[] = [];
	for (const name of names) {
		const match = listed.datasets.find((dataset) => dataset.name === name);
		if (match) {
			datasets.push({ name, id: match.id, created: false });
			continue;
		}
		if (deps.createOnMiss === false) {
			datasets.push({ name, id: null, created: false });
			continue;
		}
		const created = await createDataset(deps.config, name, deps.fetchImpl);
		source.invalidate();
		if (!created.ok) return { ok: false, reason: created.reason };
		datasets.push({ name, id: created.id, created: true });
	}
	return { ok: true, datasets };
}

export interface RefreshDeps {
	config: RagflowConfig;
	versions: VersionStore;
	emit: (event: EventInput) => Promise<unknown>;
	surface?: Surface | null;
	sessionId?: string;
	fetchImpl?: FetchLike;
	nowMs?: number;
	/** The dataset list reader; the plane directly when omitted. */
	datasets?: DatasetListSource;
}

/**
 * Refresh one dataset: resolve by name (creating on miss), then record the
 * version. Real product-dataset creation is a gated live step (G2), not
 * rehearsed away — the fake proves the convention, the operator approves
 * the deployment write.
 */
export async function refreshDataset(
	deps: RefreshDeps,
	input: { dataset: string; commit: string; content_sha256: string },
): Promise<{ ok: true; version: DatasetVersion; created: boolean } | { ok: false; reason: string }> {
	const resolved = await resolveDatasets({ config: deps.config, fetchImpl: deps.fetchImpl, ...(deps.datasets ? { datasets: deps.datasets } : {}) }, [input.dataset]);
	if (!resolved.ok) return { ok: false, reason: resolved.reason };
	const entry = resolved.datasets[0];
	if (!entry?.id) return { ok: false, reason: "unknown-dataset" };
	const prior = deps.versions.get(input.dataset) ?? [];
	const generation = prior.reduce((top, record) => {
		const n = Number(/^v(\d+)$/.exec(record.version)?.[1] ?? 0);
		return Math.max(top, Number.isFinite(n) ? n : 0);
	}, 0);
	const version: DatasetVersion = {
		dataset: input.dataset,
		dataset_id: entry.id,
		version: `v${generation + 1}`,
		commit: input.commit,
		content_sha256: input.content_sha256,
		ingested_at: new Date(deps.nowMs ?? Date.now()).toISOString(),
	};
	recordVersion(deps.versions, version);
	await deps.emit({
		surface: deps.surface ?? "claude-code",
		kind: "note",
		summary: `docs dataset ${input.dataset} refreshed to ${version.version}`,
		session_id: deps.sessionId ?? `docs-refresh:${version.version}`,
		payload: {
			action: "docs.ingest",
			dataset_id: entry.id,
			version: version.version,
			commit: input.commit,
			content_sha256: input.content_sha256,
		},
	});
	return { ok: true, version, created: entry.created };
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
