/**
 * Planning plane settings (phase 52, SOTA-08). Environment only.
 *
 * `SUBSTRATE_PLANNING_ROOT` is the absolute checkout whose `.planning/` the plane reads. Unset
 * or blank means the plane is disabled: nothing is read and no default path exists. The numeric
 * settings have documented defaults. A value that is set but is not a plain integer in range is
 * an error, never a silent fallback. A blank numeric value counts as malformed, because it was
 * set on purpose.
 */
import { isAbsolute } from "node:path";

export const PLANNING_ROOT_ENV = "SUBSTRATE_PLANNING_ROOT";
export const PLANNING_PRESENCE_TTL_ENV = "SUBSTRATE_PLANNING_PRESENCE_TTL_S";
export const PLANNING_MAX_FILES_ENV = "SUBSTRATE_PLANNING_MAX_FILES";
export const PLANNING_MAX_BYTES_ENV = "SUBSTRATE_PLANNING_MAX_BYTES";
export const PLANNING_SCAN_INTERVAL_ENV = "SUBSTRATE_PLANNING_SCAN_INTERVAL_MS";

export const DEFAULT_PRESENCE_TTL_S = 90;
export const DEFAULT_MAX_FILES = 500;
export const DEFAULT_MAX_BYTES = 262_144;
/** The observer's scan cadence: 15 s, so a change is seen within one interval and a scan stays cheap. */
export const DEFAULT_SCAN_INTERVAL_MS = 15_000;

/** Inclusive bounds. Outside them the value is refused, not clamped. */
export const PLANNING_BOUNDS = {
	presenceTtlS: { min: 1, max: 86_400 },
	maxFiles: { min: 1, max: 10_000 },
	maxBytes: { min: 1_024, max: 4_194_304 },
	/** One scan a second at the most often, and one an hour at the least often. */
	scanIntervalMs: { min: 1_000, max: 3_600_000 },
} as const;

export interface PlanningLimits {
	presenceTtlS: number;
	maxFiles: number;
	maxBytes: number;
	/** How often the planning observer scans, in milliseconds. */
	scanIntervalMs: number;
}

export type PlanningSettings = (PlanningLimits & { enabled: false }) | (PlanningLimits & { enabled: true; root: string });

export type PlanningConfigReason = "not-absolute" | "invalid-characters" | "not-integer" | "out-of-range";

export interface PlanningConfigError {
	key: string;
	reason: PlanningConfigReason;
	/** Present for `out-of-range` only. The value itself is never echoed. */
	min?: number;
	max?: number;
}

export type PlanningConfigResult = { ok: true; settings: PlanningSettings } | { ok: false; errors: PlanningConfigError[] };

/** Parse the planning settings from an environment map. Every bad key is reported, not just the first. */
export function loadPlanningSettings(env: Readonly<Record<string, string | undefined>>): PlanningConfigResult {
	const errors: PlanningConfigError[] = [];
	const presenceTtlS = integerSetting(env, PLANNING_PRESENCE_TTL_ENV, DEFAULT_PRESENCE_TTL_S, PLANNING_BOUNDS.presenceTtlS, errors);
	const maxFiles = integerSetting(env, PLANNING_MAX_FILES_ENV, DEFAULT_MAX_FILES, PLANNING_BOUNDS.maxFiles, errors);
	const maxBytes = integerSetting(env, PLANNING_MAX_BYTES_ENV, DEFAULT_MAX_BYTES, PLANNING_BOUNDS.maxBytes, errors);
	const scanIntervalMs = integerSetting(env, PLANNING_SCAN_INTERVAL_ENV, DEFAULT_SCAN_INTERVAL_MS, PLANNING_BOUNDS.scanIntervalMs, errors);

	const root = (env[PLANNING_ROOT_ENV] ?? "").trim();
	if (root.includes("\0")) errors.push({ key: PLANNING_ROOT_ENV, reason: "invalid-characters" });
	else if (root !== "" && !isAbsolute(root)) errors.push({ key: PLANNING_ROOT_ENV, reason: "not-absolute" });

	if (errors.length > 0) return { ok: false, errors };
	const limits: PlanningLimits = { presenceTtlS, maxFiles, maxBytes, scanIntervalMs };
	if (root === "") return { ok: true, settings: { enabled: false, ...limits } };
	return { ok: true, settings: { enabled: true, root, ...limits } };
}

/** The boot warnings for refused planning settings: each key and why, never the value. Empty when the settings are valid. */
export function planningConfigWarnings(result: PlanningConfigResult): string[] {
	if (result.ok) return [];
	return result.errors.map((error) => {
		const why = error.reason === "out-of-range" ? `out of range ${error.min}..${error.max}` : error.reason;
		return `${error.key} is ${why}; the planning plane stays off until it is fixed`;
	});
}

function integerSetting(
	env: Readonly<Record<string, string | undefined>>,
	key: string,
	fallback: number,
	bounds: { min: number; max: number },
	errors: PlanningConfigError[],
): number {
	const raw = env[key];
	if (raw === undefined) return fallback;
	if (!/^[0-9]+$/.test(raw)) {
		errors.push({ key, reason: "not-integer" });
		return fallback;
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
		errors.push({ key, reason: "out-of-range", min: bounds.min, max: bounds.max });
		return fallback;
	}
	return value;
}
