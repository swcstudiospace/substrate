/**
 * The filesystem watcher (v1.7 phase 65): a bounded set of directory watches whose events only mark a repository dirty.
 *
 * A change event never reads a file and never throws: the callback records "this repository changed" and returns; the
 * sync that follows (debounced by the `Coalescer`) does the reading. When the host runs out of watches (`ENOSPC`, the
 * inotify limit, or `EMFILE`) every watch is closed and the watcher reports `degraded: "inotify-limit"`, so the command
 * carries on with its periodic sweep alone instead of holding a partial set that looks like full coverage. Any other watch
 * failure drops that one directory and is counted. Watching is read-only toward every repository.
 *
 * Pure of the environment: the directories, the cap, the clock and the factory are parameters.
 */
import { watch } from "node:fs";
import { hasDocExtension } from "./classify.ts";

/** The upper bound of the watch cap a caller may pass; the setting layer clamps below it. */
const MAX_WATCH_DIRS = 20_000;

export interface WatchTarget {
	/** The repository label a change in `dir` marks dirty. */
	repo: string;
	dir: string;
}

interface WatchHandle {
	close(): void;
}

/** Starts one directory watch. `listener` gets the changed file name (null when the platform gives none); `onError` the watch's own failure. */
export type WatchFactory = (dir: string, listener: (filename: string | null) => void, onError: (error: Error) => void) => WatchHandle;

export const defaultWatchFactory: WatchFactory = (dir, listener, onError) => {
	const handle = watch(dir, { persistent: false }, (_event, filename) => listener(filename === null ? null : String(filename)));
	handle.on("error", onError);
	return handle;
};

interface WatcherOptions {
	dirs: readonly WatchTarget[];
	/** Called with the repository label of every relevant change; it must not read files. */
	onChange: (repo: string, atMs: number) => void;
	watchFactory: WatchFactory;
	clock: () => number;
	/** The most directories watched; the rest are left to the sweep. */
	max: number;
}

const WATCH_DEGRADED = ["inotify-limit"] as const;
type WatchDegraded = (typeof WATCH_DEGRADED)[number];

interface WatcherState {
	/** Directories with a live watch. */
	watching: number;
	/** Directories left unwatched because of the cap or a watch that failed to start. */
	unwatched: number;
	degraded: WatchDegraded | null;
}

export interface Watcher {
	/** Replaces the watched set (after a sweep found new directories). A limit hit earlier stays: the watcher remains degraded. */
	replace(dirs: readonly WatchTarget[]): WatcherState;
	state(): WatcherState;
	close(): void;
}

function isLimitError(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOSPC" || error.code === "EMFILE");
}

/** A directory event is relevant when the file is a documentation file, or when the platform names no file or a bare directory name. */
function isRelevant(filename: string | null): boolean {
	return filename === null || hasDocExtension(filename) || !filename.includes(".");
}

export function createWatcher(options: WatcherOptions): Watcher {
	const handles: WatchHandle[] = [];
	let degraded: WatchDegraded | null = null;
	let total = 0;
	const max = Math.max(0, Math.min(Math.floor(options.max), MAX_WATCH_DIRS));

	const closeAll = (): void => {
		for (const handle of handles.splice(0)) {
			try {
				handle.close();
			} catch {
				// A watch that cannot be closed is already gone.
			}
		}
	};

	const open = (dirs: readonly WatchTarget[]): void => {
		closeAll();
		const unique = new Map<string, WatchTarget>();
		for (const target of dirs) if (!unique.has(target.dir)) unique.set(target.dir, target);
		total = unique.size;
		if (degraded !== null) return;
		for (const target of unique.values()) {
			if (handles.length >= max) break;
			try {
				const handle = options.watchFactory(
					target.dir,
					(filename) => {
						if (isRelevant(filename)) options.onChange(target.repo, options.clock());
					},
					(error) => {
						// A watch that fails later (the directory was removed) stops reporting; the sweep still covers it.
						if (isLimitError(error)) {
							degraded = "inotify-limit";
							closeAll();
						}
					},
				);
				handles.push(handle);
			} catch (cause) {
				// Any other failure (the directory is gone, no permission) leaves just that directory to the sweep.
				if (isLimitError(cause)) {
					degraded = "inotify-limit";
					closeAll();
					return;
				}
			}
		}
	};

	open(options.dirs);
	const state = (): WatcherState => ({ watching: handles.length, unwatched: total - handles.length, degraded });
	return {
		replace(dirs) {
			open(dirs);
			return state();
		},
		state,
		close: closeAll,
	};
}
