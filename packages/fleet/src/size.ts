/**
 * A bounded walk of one directory tree: bytes on disk and the newest modification time.
 *
 * Bounds are part of the contract, not a tuning knob: a worktree with a million files must not stall
 * an inventory. When either cap is hit the walk reports nothing (`bytes` and `lastActivityMs` are
 * null) and says why, because a partial total or a partial "newest time" would read as a fact. The
 * prune classifier treats an unknown activity time as "not idle", so a cap can only keep a worktree.
 *
 * Each inode is counted once (`dev:ino`), so a dependency tree full of hardlinks (pnpm, bun) is not
 * counted per link. Symlinks are measured as links and never followed. Bytes are allocated blocks,
 * which is what a removal frees; directories themselves are not counted.
 */
import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";

export const DEFAULT_MAX_ENTRIES = 500_000;
export const DEFAULT_MAX_MS = 20_000;
/** The walk gives the event loop a turn this often. */
const YIELD_EVERY = 2048;

export interface MeasureOptions {
	maxEntries?: number;
	maxMs?: number;
	/** Milliseconds clock; injected by tests. */
	now?: () => number;
}

export interface Measurement {
	bytes: number | null;
	lastActivityMs: number | null;
	/** Why the numbers are null, or a caveat about what was skipped. */
	note: string | null;
	entries: number;
}

async function turn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

export async function measureTree(root: string, options: MeasureOptions = {}): Promise<Measurement> {
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
	const now = options.now ?? Date.now;
	const started = now();
	const seen = new Set<string>();
	const stack: string[] = [root];
	let bytes = 0;
	let newest = 0;
	let entries = 0;
	let unreadable = 0;
	while (stack.length > 0) {
		const dir = stack.pop();
		if (dir === undefined) break;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			unreadable += 1;
			continue;
		}
		for (const name of names) {
			entries += 1;
			if (entries > maxEntries) return { bytes: null, lastActivityMs: null, note: `size walk stopped after ${maxEntries} entries`, entries };
			if (entries % YIELD_EVERY === 0) {
				await turn();
				if (now() - started > maxMs) return { bytes: null, lastActivityMs: null, note: `size walk stopped after ${maxMs} ms`, entries };
			}
			const full = join(dir, name);
			let info: Stats;
			try {
				info = lstatSync(full);
			} catch {
				unreadable += 1;
				continue;
			}
			if (info.mtimeMs > newest) newest = info.mtimeMs;
			if (info.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (info.nlink > 1) {
				const key = `${info.dev}:${info.ino}`;
				if (seen.has(key)) continue;
				seen.add(key);
			}
			bytes += info.blocks * 512;
		}
	}
	if (entries === 0 && unreadable > 0) return { bytes: null, lastActivityMs: null, note: "directory could not be read", entries };
	return {
		bytes,
		// An unreadable directory may hide newer files, so the newest time is then unknown rather than low.
		lastActivityMs: newest > 0 && unreadable === 0 ? newest : null,
		note: unreadable > 0 ? `${unreadable} entries could not be read and were skipped` : null,
		entries,
	};
}
