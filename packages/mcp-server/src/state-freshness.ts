/**
 * Phase 100 (F1): the STATE freshness SLI gauge (pure, no I/O).
 *
 * `state_freshness_lag_seconds = now − max(stateMtime, lastSuccessIngest)`.
 * The service exposes it on the health snapshot; the alert threshold is
 * documented in `docs/observability.md` with no new alerting infra.
 * Fail-open: missing inputs yield an `unknown` reading, never an exception.
 */

/** Seconds without a successful STATE ingest before the state reads stale. Documented in `docs/observability.md`. */
export const STATE_FRESHNESS_STALE_AFTER_S = 300;

export interface StateFreshnessReading {
	/** Gauge seconds, or null when neither input is known. */
	lagSeconds: number | null;
	/** True only when a known lag exceeds {@link STATE_FRESHNESS_STALE_AFTER_S}. */
	stale: boolean;
	/** `unknown` when inputs are missing, `stale` + detail when over threshold, else null. */
	reason: string | null;
}

/**
 * Compute the gauge from the newest STATE.md mtime and the last successful
 * ingest instant (both epoch ms; either may be null when unknown). A clock
 * skew that puts the reference in the future clamps to zero. Never throws.
 */
export function computeStateFreshnessLag(input: {
	stateMtimeMs?: number | null;
	lastSuccessIngestAtMs?: number | null;
	nowMs: number;
}): StateFreshnessReading {
	try {
		const candidates = [input.stateMtimeMs, input.lastSuccessIngestAtMs].filter(
			(value): value is number => typeof value === "number" && Number.isFinite(value),
		);
		if (candidates.length === 0 || !Number.isFinite(input.nowMs)) {
			return { lagSeconds: null, stale: false, reason: "unknown: no STATE mtime or successful-ingest timestamp" };
		}
		const reference = Math.max(...candidates);
		const lagSeconds = Math.max(0, Math.floor((input.nowMs - reference) / 1000));
		if (lagSeconds > STATE_FRESHNESS_STALE_AFTER_S) {
			return { lagSeconds, stale: true, reason: `stale: no successful STATE ingest within ${STATE_FRESHNESS_STALE_AFTER_S}s` };
		}
		return { lagSeconds, stale: false, reason: null };
	} catch {
		return { lagSeconds: null, stale: false, reason: "unknown: freshness computation failed" };
	}
}
