/**
 * The six flags of the doc watch (v1.7 phase 65), read in this one file. Everything below `packages/corpus` takes its
 * directories and numbers as parameters and never reads the environment.
 *
 *   SUBSTRATE_CORPUS_MIRROR_DIR    where the blobless mirrors live       (default <state dir>/corpus-mirrors)
 *   SUBSTRATE_CORPUS_SPOOL         where git hooks leave their hints     (default <state dir>/corpus-hints)
 *   SUBSTRATE_CORPUS_DEBOUNCE_MS   quiet time that ends a burst           (default 2000, 100..60000)
 *   SUBSTRATE_CORPUS_MAX_WAIT_MS   longest a burst may last               (default 30000, 1000..600000, never below the debounce)
 *   SUBSTRATE_CORPUS_WATCH_MAX     most directories watched               (default 2000, 10..20000)
 *   SUBSTRATE_CORPUS_SWEEP_S       seconds between full sweeps            (default 900, 30..86400)
 *
 * `<state dir>` is `$XDG_STATE_HOME/substrate`, else `~/.local/state/substrate`. A number that is not a plain integer takes
 * its default; one outside its range is clamped to the nearest bound.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_DEBOUNCE_MS = 2000;
export const DEFAULT_MAX_WAIT_MS = 30_000;
export const DEFAULT_WATCH_MAX = 2000;
export const DEFAULT_SWEEP_S = 900;
export const MIN_SWEEP_S = 30;
export const MAX_SWEEP_S = 86_400;

export interface WatchSettings {
	mirrorDir: string;
	spoolDir: string;
	debounceMs: number;
	maxWaitMs: number;
	watchMax: number;
	sweepS: number;
}

function integer(text: string | undefined, fallback: number, min: number, max: number): number {
	const trimmed = text?.trim();
	if (trimmed === undefined || !/^[0-9]+$/.test(trimmed)) return fallback;
	const value = Number(trimmed);
	if (!Number.isSafeInteger(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function directory(text: string | undefined): string | null {
	const trimmed = text?.trim();
	return trimmed === undefined || trimmed === "" ? null : trimmed;
}

/** The state directory of Substrate on this machine; a relative `XDG_STATE_HOME` is ignored, as the XDG rules say. */
function stateDir(env: Record<string, string | undefined>): string {
	const xdg = directory(env.XDG_STATE_HOME);
	if (xdg?.startsWith("/")) return join(xdg, "substrate");
	return join(directory(env.HOME) ?? homedir(), ".local", "state", "substrate");
}

export function readWatchSettings(env: Record<string, string | undefined>): WatchSettings {
	const state = stateDir(env);
	const debounceMs = integer(env.SUBSTRATE_CORPUS_DEBOUNCE_MS, DEFAULT_DEBOUNCE_MS, 100, 60_000);
	return {
		mirrorDir: directory(env.SUBSTRATE_CORPUS_MIRROR_DIR) ?? join(state, "corpus-mirrors"),
		spoolDir: directory(env.SUBSTRATE_CORPUS_SPOOL) ?? join(state, "corpus-hints"),
		debounceMs,
		maxWaitMs: Math.max(debounceMs, integer(env.SUBSTRATE_CORPUS_MAX_WAIT_MS, DEFAULT_MAX_WAIT_MS, 1000, 600_000)),
		watchMax: integer(env.SUBSTRATE_CORPUS_WATCH_MAX, DEFAULT_WATCH_MAX, 10, 20_000),
		sweepS: integer(env.SUBSTRATE_CORPUS_SWEEP_S, DEFAULT_SWEEP_S, MIN_SWEEP_S, MAX_SWEEP_S),
	};
}
