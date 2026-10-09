/**
 * Anchor periods (D-09): half-open UTC hours [HH:00:00.000, HH+1:00:00.000) bucketed by ingest
 * time. An event at exactly HH:00:00.000 belongs to hour HH.
 */

export const HOUR_MS = 3_600_000;

/** Start (epoch ms) of the hour containing `ms`. */
export function hourStart(ms: number): number {
	return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** Exclusive end (epoch ms) of the hour starting at `hourStartMs`. */
export function hourEnd(hourStartMs: number): number {
	return hourStartMs + HOUR_MS;
}

/** `YYYY-MM-DDTHH:00:00.000Z` for the hour containing `ms`. */
export function hourIso(ms: number): string {
	return new Date(hourStart(ms)).toISOString();
}

/** An hour is closed once its end plus the lag has passed. */
export function isClosed(hourStartMs: number, nowMs: number, lagMs: number): boolean {
	return nowMs >= hourEnd(hourStartMs) + lagMs;
}

/** Every closed hour from the one containing `fromMs` up to `nowMs`, ascending. */
export function closedHours(fromMs: number, nowMs: number, lagMs: number): number[] {
	const out: number[] = [];
	for (let h = hourStart(fromMs); isClosed(h, nowMs, lagMs); h += HOUR_MS) out.push(h);
	return out;
}
