/**
 * Pure parsing of `/proc/<pid>/stat` start times. One copy for the lock identity check and for the
 * scripts that compare a process start against a recorded one (`scripts/` may import from
 * `packages/`, never the other way round). No filesystem access here: callers pass the text.
 */

/** Index of starttime (stat field 22) in the fields that follow the closing paren of comm: state is field 3. */
const START_TIME_INDEX = 19;

/**
 * Field 22 of `/proc/<pid>/stat` (process start time in clock ticks since boot), or null when the
 * text is truncated or not a stat line. The fields are read after the LAST `)` because comm may
 * itself hold spaces and parentheses.
 */
export function parseProcStatStartTicks(statText: string): number | null {
	const close = statText.lastIndexOf(")");
	if (close < 0) return null;
	const rest = statText
		.slice(close + 1)
		.trim()
		.split(/\s+/);
	const field = rest[START_TIME_INDEX];
	if (field === undefined || !/^\d+$/.test(field)) return null;
	const ticks = Number(field);
	return Number.isSafeInteger(ticks) ? ticks : null;
}

/**
 * Process start as an epoch in seconds: the boot time (`btime` in `/proc/stat`) plus the start ticks
 * over the tick rate. 100 is the Linux default `CLK_TCK` on every platform this runs on.
 */
export function procStartSeconds(btimeSeconds: number, statText: string, clockTicksPerSecond = 100): number | null {
	if (!(clockTicksPerSecond > 0)) return null;
	const ticks = parseProcStatStartTicks(statText);
	if (ticks === null) return null;
	return btimeSeconds + ticks / clockTicksPerSecond;
}
