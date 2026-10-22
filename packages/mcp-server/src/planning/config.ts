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

export const DEFAULT_PRESENCE_TTL_S = 90;
export const DEFAULT_MAX_FILES = 500;
export const DEFAULT_MAX_BYTES = 262_144;

/** Inclusive bounds. Outside them the value is refused, not clamped. */
export const PLANNING_BOUNDS = {
	presenceTtlS: { min: 1, max: 86_400 },
	maxFiles: { min: 1, max: 10_000 },
	maxBytes: { min: 1_024, max: 4_194_304 },
} as const;

export interface PlanningLimits {
	presenceTtlS: number;
	maxFiles: number;
	maxBytes: number;
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

	const root = (env[PLANNING_ROOT_ENV] ?? "").trim();
	if (root.includes("\0")) errors.push({ key: PLANNING_ROOT_ENV, reason: "invalid-characters" });
	else if (root !== "" && !isAbsolute(root)) errors.push({ key: PLANNING_ROOT_ENV, reason: "not-absolute" });

	if (errors.length > 0) return { ok: false, errors };
	const limits: PlanningLimits = { presenceTtlS, maxFiles, maxBytes };
	if (root === "") return { ok: true, settings: { enabled: false, ...limits } };
	return { ok: true, settings: { enabled: true, root, ...limits } };
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

/** Where completion checkpoints are kept durably (phase 53, SOTA-09). Unset or blank keeps them in memory. See `checkpoint-store.ts`. */
export const PLANNING_CHECKPOINT_DIR_ENV = "SUBSTRATE_PLANNING_CHECKPOINT_DIR";

export type CheckpointDirectoryResult = { ok: true; directory: string | null } | { ok: false; errors: PlanningConfigError[] };

/** Parse the checkpoint directory. Set but relative or containing a NUL is an error; the path is never echoed. */
export function loadCheckpointDirectory(env: Readonly<Record<string, string | undefined>>): CheckpointDirectoryResult {
	const directory = (env[PLANNING_CHECKPOINT_DIR_ENV] ?? "").trim();
	if (directory.includes("\0")) return { ok: false, errors: [{ key: PLANNING_CHECKPOINT_DIR_ENV, reason: "invalid-characters" }] };
	if (directory !== "" && !isAbsolute(directory)) return { ok: false, errors: [{ key: PLANNING_CHECKPOINT_DIR_ENV, reason: "not-absolute" }] };
	return { ok: true, directory: directory === "" ? null : directory };
}
