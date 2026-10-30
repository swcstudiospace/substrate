/**
 * The per-process index the re-rank reads (v1.7 phase 66): which corpus documents are active, which of them a newer one
 * supersedes, and how readers rated them. It is built from the manifest and the feedback table and cached, never per search.
 *
 * - The manifest snapshot is keyed by the manifest version: it is rebuilt (one bounded read of the active rows and one pure
 *   `detectSupersession` pass) only when `manifestVersion()` moved, and the version itself is checked at most once per
 *   {@link VERSION_CHECK_MS}.
 * - The feedback counts are one grouped query, cached for {@link FEEDBACK_TTL_MS}.
 * - A clear (`invalidate`, `invalidateFeedback`) moves a generation and drops the held snapshot, so a load that finishes after
 *   the clear does not publish. It does not forget the load in flight: lookups keep joining it. A clear while a load runs sets
 *   a follow-up owed flag; when that load settles, exactly one follow-up starts and the flag clears. Two clears of one flight
 *   still start one follow-up. A clear while nothing is loading leaves the next lookup to read again.
 * - A manifest with more active rows than {@link AUTHORITY_MAX_ROWS} gives a `partial` snapshot: the copy comparison of
 *   supersession is off for it, because a copy group cut by the cap may have had a third member.
 * - Every read is fail-open: a store that fails keeps the last snapshot, and with none the lookup is null, so a search is
 *   answered exactly as it would be with the re-rank off. A failed read is not retried before the next check time, so a
 *   database that is down is asked once per interval, not once per search.
 */
import { detectSupersession, documentKey, scoreDocument, type FeedbackCounts, type SupersessionRow } from "@substrate/corpus";
import { staleByFeedback, type AuthorityLookup } from "./rank.ts";
import { FEEDBACK_MAX_KEYS, type ReflectStore } from "./reflect-store.ts";
import type { ActiveRows, CorpusStore, ManifestRow } from "./store.ts";

/** The most active rows one snapshot reads. A document past the cap is never flagged or re-ranked, never wrongly so. */
export const AUTHORITY_MAX_ROWS = 100_000;
/** How long a snapshot is trusted before the manifest version is read again, ms. */
export const VERSION_CHECK_MS = 30_000;
/** How long the feedback counts are cached, ms. */
export const FEEDBACK_TTL_MS = 60_000;
/** The longest a search waits for the index to load; past it the search is answered without it while the load finishes. */
export const LOOKUP_BUDGET_MS = 500;

const DAY_MS = 86_400_000;
const NO_FEEDBACK: FeedbackCounts = { helpful: 0, unhelpful: 0, stale: 0, wrong: 0, duplicate: 0 };

interface Held {
	tier: ManifestRow["tier"];
	kind: ManifestRow["kind"];
	ingestedAtMs: number | null;
}

export interface Snapshot {
	version: number;
	rows: Map<string, Held>;
	/** Key of a superseded document -> key of the document that supersedes it. */
	superseded: Map<string, string>;
	/** True when the rows are not every active row (the read cap cut them), so no copy comparison was made. */
	partial: boolean;
	/** When the version was last confirmed, ms. */
	checkedAt: number;
}

export interface AuthorityIndexDeps {
	/** The manifest, or null while the corpus is off or there is no index. */
	store: () => CorpusStore | null;
	/** The feedback table, or null when there is none: every document then has no feedback. */
	reflect: () => ReflectStore | null;
	now: () => number;
	/** The longest a lookup waits for a load, ms; {@link LOOKUP_BUDGET_MS} when omitted. A test seam. */
	budgetMs?: number;
}

function supersessionRowOf(row: ManifestRow): SupersessionRow {
	return {
		repo: row.repo,
		path: row.path,
		sha256: row.sha256,
		tier: row.tier,
		kind: row.kind,
		source: row.source,
		// A row with no time reads as the oldest, so it is never mistaken for the newer copy of anything.
		updatedAt: row.ingestedAt ?? new Date(0).toISOString(),
		...(row.supersededBy === null ? {} : { supersededBy: row.supersededBy }),
	};
}

export function snapshotOf(version: number, active: ActiveRows, checkedAt: number): Snapshot {
	const held = new Map<string, Held>();
	for (const row of active.rows) {
		const at = row.ingestedAt === null ? Number.NaN : Date.parse(row.ingestedAt);
		held.set(documentKey(row.repo, row.path), { tier: row.tier, kind: row.kind, ingestedAtMs: Number.isFinite(at) ? at : null });
	}
	return { version, rows: held, superseded: detectSupersession(active.rows.map(supersessionRowOf), { compareCopies: !active.truncated }), partial: active.truncated, checkedAt };
}

export class AuthorityIndex {
	private snapshot: Snapshot | null = null;
	/** Do not read the manifest again before this time, ms; set after a failed read. */
	private retryManifestAt = 0;
	private loading: Promise<void> | null = null;
	/** Moves with every clear of the manifest snapshot; a load that began under an older value publishes nothing. */
	private manifestGeneration = 0;
	/** A clear arrived while `loading` ran; one follow-up starts when that load settles. */
	private manifestFollowUp = false;
	private feedback: { counts: Map<string, FeedbackCounts>; loadedAt: number } | null = null;
	private retryFeedbackAt = 0;
	private loadingFeedback: Promise<void> | null = null;
	private feedbackGeneration = 0;
	/** A clear arrived while `loadingFeedback` ran; one follow-up starts when that load settles. */
	private feedbackFollowUp = false;
	/** After a lookup ran out of budget, lookups do not wait for a load until this time, ms: a stalled database costs one budget, not one per search. */
	private noWaitUntil = 0;

	constructor(private readonly deps: AuthorityIndexDeps) {}

	/** Drops what is held so the next lookup reads again: called after this process changed the manifest or the feedback. */
	invalidate(): void {
		this.manifestGeneration += 1;
		this.snapshot = null;
		this.retryManifestAt = 0;
		if (this.loading !== null) this.manifestFollowUp = true;
		this.invalidateFeedback();
	}

	/** Drops the feedback counts: a verdict was stored. An in-flight load is joined, then followed by one fresh read. */
	invalidateFeedback(): void {
		this.feedbackGeneration += 1;
		this.feedback = null;
		this.retryFeedbackAt = 0;
		if (this.loadingFeedback !== null) this.feedbackFollowUp = true;
	}

	/**
	 * The lookup for one answer, or null when there is no manifest or it could not be read in time. Never rejects. It waits for
	 * a load at most the budget ({@link LOOKUP_BUDGET_MS}); once a load has outlived the budget, the next lookups within
	 * {@link VERSION_CHECK_MS} do not wait for it at all and answer from what is held.
	 */
	async lookup(): Promise<AuthorityLookup | null> {
		if (this.deps.store() === null) return null;
		const loads = Promise.all([this.ensureManifest(), this.ensureFeedback()]);
		if (this.deps.now() >= this.noWaitUntil) {
			const expired = Promise.withResolvers<"timeout">();
			const timer = setTimeout(() => expired.resolve("timeout"), this.deps.budgetMs ?? LOOKUP_BUDGET_MS);
			timer.unref();
			try {
				const outcome = await Promise.race([loads.then(() => "loaded" as const), expired.promise]);
				if (outcome === "timeout") this.noWaitUntil = this.deps.now() + VERSION_CHECK_MS;
			} finally {
				clearTimeout(timer);
			}
		}
		const snapshot = this.snapshot;
		if (snapshot === null) return null;
		const feedback = this.feedback?.counts ?? new Map<string, FeedbackCounts>();
		const now = this.deps.now();
		return (key) => {
			const row = snapshot.rows.get(key);
			if (row === undefined) return null;
			const counts = feedback.get(key) ?? NO_FEEDBACK;
			const supersededBy = snapshot.superseded.get(key) ?? null;
			const authority = scoreDocument({
				tier: row.tier,
				kind: row.kind,
				ageDays: row.ingestedAtMs === null ? null : Math.max(0, (now - row.ingestedAtMs) / DAY_MS),
				supersededBy,
				feedback: counts,
			});
			return { authority, stale: supersededBy !== null || staleByFeedback(counts), supersededBy };
		};
	}

	private ensureManifest(): Promise<void> {
		const now = this.deps.now();
		const held = this.snapshot;
		if ((held !== null && now - held.checkedAt < VERSION_CHECK_MS) || now < this.retryManifestAt) return Promise.resolve();
		if (this.loading === null) this.loading = this.startManifest();
		return this.loading;
	}

	/** One manifest load. When it settles, a clear that arrived during it starts exactly one follow-up. */
	private startManifest(): Promise<void> {
		// The promise a lookup joined does not resolve until a follow-up owed by a clear during this load has settled too.
		// Otherwise the search returns the empty snapshot the clear dropped, with time still left in its budget.
		const load = this.refreshManifest().then(async () => {
			if (this.loading !== load) return;
			if (this.manifestFollowUp) {
				this.manifestFollowUp = false;
				const next = this.startManifest();
				this.loading = next;
				await next;
				return;
			}
			this.loading = null;
		});
		return load;
	}

	private async refreshManifest(): Promise<void> {
		const store = this.deps.store();
		if (store === null) return;
		const generation = this.manifestGeneration;
		const started = this.deps.now();
		try {
			const version = await store.manifestVersion();
			if (generation !== this.manifestGeneration) return;
			const held = this.snapshot;
			if (held !== null && held.version === version) {
				held.checkedAt = started;
				return;
			}
			const active = await store.activeRows(AUTHORITY_MAX_ROWS);
			// A change made while the rows were being read: what was read may predate it, so none of it is kept.
			if (generation !== this.manifestGeneration) return;
			this.snapshot = snapshotOf(version, active, started);
		} catch {
			// Fail-open: keep what is held and ask again after the interval. A read the process has since cleared says nothing about now.
			if (generation === this.manifestGeneration) this.retryManifestAt = started + VERSION_CHECK_MS;
		}
	}

	private ensureFeedback(): Promise<void> {
		const now = this.deps.now();
		const held = this.feedback;
		if ((held !== null && now - held.loadedAt < FEEDBACK_TTL_MS) || now < this.retryFeedbackAt) return Promise.resolve();
		if (this.loadingFeedback === null) this.loadingFeedback = this.startFeedback();
		return this.loadingFeedback;
	}

	/** One feedback load. When it settles, a clear that arrived during it starts exactly one follow-up. */
	private startFeedback(): Promise<void> {
		const load = this.refreshFeedback().then(async () => {
			if (this.loadingFeedback !== load) return;
			if (this.feedbackFollowUp) {
				this.feedbackFollowUp = false;
				const next = this.startFeedback();
				this.loadingFeedback = next;
				await next;
				return;
			}
			this.loadingFeedback = null;
		});
		return load;
	}

	private async refreshFeedback(): Promise<void> {
		const store = this.deps.reflect();
		const generation = this.feedbackGeneration;
		const started = this.deps.now();
		if (store === null) {
			this.feedback = { counts: new Map(), loadedAt: started };
			return;
		}
		try {
			const counts = await store.feedbackCounts(FEEDBACK_MAX_KEYS);
			if (generation === this.feedbackGeneration) this.feedback = { counts, loadedAt: started };
		} catch {
			if (generation === this.feedbackGeneration) this.retryFeedbackAt = started + FEEDBACK_TTL_MS;
		}
	}
}
