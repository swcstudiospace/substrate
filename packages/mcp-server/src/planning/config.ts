/**
 * Planning plane settings (phase 52, SOTA-08; multi-root, v1.7). Environment only.
 *
 * `SUBSTRATE_PLANNING_ROOTS` is a comma-separated list of absolute checkout paths whose `.planning/`
 * the plane reads. Each entry is trimmed, blank entries are dropped, and a relative or duplicate entry
 * refuses the whole list. Unset or blank means the plane is disabled: nothing is read and no default path
 * exists. Each checkout is keyed by `planningSessionId` (`checkout.ts`). The numeric settings have documented
 * defaults. A value that is set but is not a plain integer in range is an error, never a silent fallback. A
 * blank numeric value counts as malformed, because it was set on purpose.
 */
import { createHash } from "node:crypto";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { planningSessionId } from "./checkout.ts";
import type { PlanningFs } from "./index.ts";

export const PLANNING_ROOTS_ENV = "SUBSTRATE_PLANNING_ROOTS";
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

/** One checkout the plane reads: `root` is the absolute path as given (trimmed); `key` is `planningSessionId(root)`, the page and state key. */
export interface PlanningCheckout {
	root: string;
	key: string;
}

export type PlanningSettings = (PlanningLimits & { enabled: false; checkouts: readonly [] }) | (PlanningLimits & { enabled: true; checkouts: readonly PlanningCheckout[] });

export type PlanningConfigReason = "not-absolute" | "invalid-characters" | "duplicate" | "not-integer" | "out-of-range";

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

	const checkouts = checkoutsSetting(env, errors);

	if (errors.length > 0) return { ok: false, errors };
	const limits: PlanningLimits = { presenceTtlS, maxFiles, maxBytes, scanIntervalMs };
	if (checkouts.length === 0) return { ok: true, settings: { enabled: false, checkouts: [], ...limits } };
	return { ok: true, settings: { enabled: true, checkouts, ...limits } };
}

/**
 * The hasher `planningSessionId` needs. It reads only `sha256` from a PlanningFs, and this is the same digest as
 * `nodePlanningFs()` in fs.ts. fs.ts is not imported here: it reaches position.ts, which imports this file.
 */
const CHECKOUT_HASHER = { sha256: (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex") } as PlanningFs;

/**
 * `SUBSTRATE_PLANNING_ROOTS`: split on commas, each entry trimmed, blank entries dropped. Duplicates are compared as
 * resolved paths, so `/a` and `/a/` collide. Each refusal reason is reported once, and the value is never echoed.
 */
function checkoutsSetting(env: Readonly<Record<string, string | undefined>>, errors: PlanningConfigError[]): PlanningCheckout[] {
	const reasons = new Set<PlanningConfigReason>();
	const seen = new Set<string>();
	const checkouts: PlanningCheckout[] = [];
	const entries = (env[PLANNING_ROOTS_ENV] ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
	for (const root of entries) {
		if (root.includes("\0")) reasons.add("invalid-characters");
		else if (!isAbsolute(root)) reasons.add("not-absolute");
		else if (seen.has(resolvePath(root))) reasons.add("duplicate");
		else {
			seen.add(resolvePath(root));
			checkouts.push({ root, key: planningSessionId(CHECKOUT_HASHER, root) });
		}
	}
	for (const reason of reasons) errors.push({ key: PLANNING_ROOTS_ENV, reason });
	return checkouts;
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
