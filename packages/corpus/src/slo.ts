/**
 * The docs plane's service-level objectives (v1.7 phase 70): how fresh the corpus is, how fast it ingests, how well it retrieves,
 * and, once a threshold is set, how far behind its source the newest sync ran. The thresholds are flags, so the server's
 * `fabric_status` row and `substrate corpus eval` read them through the same two functions and cannot disagree about a breach.
 */

export interface SloThresholds {
	/** The newest manifest change may be at most this many seconds old (`SUBSTRATE_DOCS_SLO_FRESHNESS_S`). */
	freshnessS: number;
	/** The golden set's recall at 5 may not fall below this (`SUBSTRATE_DOCS_SLO_RECALL5`). */
	recall5: number;
	/** An ingest request that sent documents may not average below this many documents per second (`SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S`). */
	ingestDocsPerS: number;
	/** The newest `docs.sync` note's lag may be at most this many seconds (`SUBSTRATE_DOCS_SLO_SYNC_LAG_S`). Unset, the lag is shown and never judged. */
	syncLagS?: number;
}

export const SLO_DEFAULTS: Readonly<SloThresholds> = { freshnessS: 86_400, recall5: 0.6, ingestDocsPerS: 0.2 };

/** A reading is `null` when nothing has measured it yet; a missing reading is never a breach. */
export interface SloReadings {
	freshnessS: number | null;
	recall5: number | null;
	ingestDocsPerS: number | null;
	syncLagS?: number | null;
}

export const SLO_BREACHES = ["freshness", "recall5", "ingest", "sync"] as const;
export type SloBreach = (typeof SLO_BREACHES)[number];

/** A whole number of 1 or more, rounded down; anything else is `undefined`. */
function optionalWhole(raw: string | undefined): number | undefined {
	const value = Number(raw?.trim());
	return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
	const value = Number(raw?.trim());
	return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function unitInterval(raw: string | undefined, fallback: number): number {
	const value = Number(raw?.trim());
	return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;
}

/** The thresholds an environment sets. Anything unset, empty, not a number or out of range is the default, so a typo never disables a check. The sync lag has no default: unset, it is not an objective and no verdict is drawn. */
export function loadSloThresholds(env: Record<string, string | undefined>): SloThresholds {
	const syncLagS = optionalWhole(env.SUBSTRATE_DOCS_SLO_SYNC_LAG_S);
	return {
		freshnessS: optionalWhole(env.SUBSTRATE_DOCS_SLO_FRESHNESS_S) ?? SLO_DEFAULTS.freshnessS,
		recall5: unitInterval(env.SUBSTRATE_DOCS_SLO_RECALL5, SLO_DEFAULTS.recall5),
		ingestDocsPerS: positiveNumber(env.SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S, SLO_DEFAULTS.ingestDocsPerS),
		...(syncLagS === undefined ? {} : { syncLagS }),
	};
}

/** Which objectives the readings breach, in {@link SLO_BREACHES} order. A reading exactly on its threshold holds. */
export function sloBreaches(readings: SloReadings, thresholds: SloThresholds): SloBreach[] {
	const breaches: SloBreach[] = [];
	if (readings.freshnessS !== null && readings.freshnessS > thresholds.freshnessS) breaches.push("freshness");
	if (readings.recall5 !== null && readings.recall5 < thresholds.recall5) breaches.push("recall5");
	if (readings.ingestDocsPerS !== null && readings.ingestDocsPerS < thresholds.ingestDocsPerS) breaches.push("ingest");
	const lag = readings.syncLagS ?? null;
	if (lag !== null && thresholds.syncLagS !== undefined && lag > thresholds.syncLagS) breaches.push("sync");
	return breaches;
}

/** Floor on the wall time a throughput is divided by, so a request answered inside the clock's resolution is not infinitely fast. */
export const INGEST_MIN_ELAPSED_MS = 1;

/**
 * Documents per second of one ingest request's wall time. 0 when nothing was sent, and for a request that sent documents never
 * more than `sent` per {@link INGEST_MIN_ELAPSED_MS}. A negative or non-finite elapsed time reads as the floor.
 */
export function ingestDocsPerSecond(sent: number, elapsedMs: number): number {
	if (!Number.isFinite(sent) || sent <= 0) return 0;
	const elapsed = Number.isFinite(elapsedMs) ? Math.max(INGEST_MIN_ELAPSED_MS, elapsedMs) : INGEST_MIN_ELAPSED_MS;
	return (sent * 1000) / elapsed;
}

/** `payload.golden_recall5` of a `docs.canary` event: a finite number in [0, 1], else `null` (a malformed report is ignored, never stored). */
export function goldenRecallOf(payload: Record<string, unknown>): number | null {
	const value = payload.golden_recall5;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}
