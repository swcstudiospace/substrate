/**
 * What the server reads from a `docs.sync` note (v1.7 phase 65), the one event the corpus CLI posts after each sync. The note
 * arrives through `POST /events` from any authenticated caller, so every field is untrusted: only `payload.lag_s` is read,
 * and only as a bounded, finite, non-negative number. Pure.
 */

/** The action the CLI names its sync note with. */
export const DOCS_SYNC_ACTION = "docs.sync";

/** The largest lag the gauge records, seconds: a year. A longer (or invented) value is clamped so one note cannot make the series meaningless. */
export const SYNC_LAG_MAX_SECONDS = 31_536_000;

/**
 * The lag, in whole seconds, a `docs.sync` payload reports, or null when the payload is not a sync note or carries no usable
 * `lag_s` (absent, not a number, not finite, negative). A number above {@link SYNC_LAG_MAX_SECONDS} is clamped to it.
 */
export function syncLagSeconds(payload: unknown): number | null {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
	const record = payload as Record<string, unknown>;
	if (record.action !== DOCS_SYNC_ACTION) return null;
	const lag = record.lag_s;
	if (typeof lag !== "number" || !Number.isFinite(lag) || lag < 0) return null;
	return Math.min(SYNC_LAG_MAX_SECONDS, Math.round(lag));
}
