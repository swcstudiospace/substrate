/**
 * A bounded walk of one directory tree: bytes on disk and the newest modification time.
 *
 * Bounds are part of the contract, not a tuning knob: a worktree with a million files must not stall
 * an inventory. When either cap is hit the walk reports nothing (`bytes` and `lastActivityMs` are
 * null) and says why, because a partial total or a partial "newest time" would read as a fact. The
 * prune classifier treats an unknown activity time as "not idle", so a cap can only keep a worktree.
 *
 * Each inode is counted once (`dev:ino`), so a dependency tree full of hardlinks (pnpm, bun) is not
 * counted per link. Symlinks are measured as links and never followed. Bytes are allocated blocks;
 * directories themselves are not counted. That is the tree's size, not what removing it frees: an inode
 * that is also linked from outside the tree (a dependency store, another worktree) stays on disk. With
 * `links: true` the walk also reports, per inode, how many of its links it found, and `exclusiveBytes`
 * turns the tables of every tree being removed together into the space that removal certainly frees.
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
	/** Also return the link table `exclusiveBytes` needs (default false). */
	links?: boolean;
}

/** One hardlinked inode as a walk saw it: its link count on disk, the links inside the tree, and its allocated bytes. */
export interface InodeLinks {
	nlink: number;
	found: number;
	bytes: number;
}

export interface TreeLinks {
	/** Allocated bytes of files with a single link: removing the tree frees them. */
	soleBytes: number;
	/** Inodes with more than one link, by `dev:ino`. */
	shared: Map<string, InodeLinks>;
}

export interface Measurement {
	bytes: number | null;
	lastActivityMs: number | null;
	/** Why the numbers are null, or a caveat about what was skipped. */
	note: string | null;
	entries: number;
	/** Present when `links` was asked for and the walk completed. */
	links: TreeLinks | null;
}

/**
 * Bytes that removing all of `trees` together certainly frees: single-link files, plus every hardlinked inode whose
 * links on disk are all inside the trees (the sum of what the trees found equals its link count). An inode with a
 * link elsewhere is left out, so this is a lower bound; a tree that could not be walked contributes nothing.
 */
export function exclusiveBytes(trees: readonly TreeLinks[]): number {
	let total = 0;
	const merged = new Map<string, InodeLinks>();
	for (const tree of trees) {
		total += tree.soleBytes;
		for (const [key, inode] of tree.shared) {
			const seen = merged.get(key);
			if (seen === undefined) merged.set(key, { ...inode });
			else seen.found += inode.found;
		}
	}
	for (const inode of merged.values()) {
		if (inode.found === inode.nlink) total += inode.bytes;
	}
	return total;
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
	const shared = new Map<string, InodeLinks>();
	const stack: string[] = [root];
	let bytes = 0;
	let newest = 0;
	let entries = 0;
	let soleBytes = 0;
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
			if (entries > maxEntries) return { bytes: null, lastActivityMs: null, note: `size walk stopped after ${maxEntries} entries`, entries, links: null };
			if (entries % YIELD_EVERY === 0) {
				await turn();
				if (now() - started > maxMs) return { bytes: null, lastActivityMs: null, note: `size walk stopped after ${maxMs} ms`, entries, links: null };
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
				const known = shared.get(key);
				if (known !== undefined) {
					known.found += 1;
					continue;
				}
				shared.set(key, { nlink: info.nlink, found: 1, bytes: info.blocks * 512 });
			} else soleBytes += info.blocks * 512;
			bytes += info.blocks * 512;
		}
	}
	if (entries === 0 && unreadable > 0) return { bytes: null, lastActivityMs: null, note: "directory could not be read", entries, links: null };
	return {
		bytes,
		// An unreadable directory may hide newer files, so the newest time is then unknown rather than low.
		lastActivityMs: newest > 0 && unreadable === 0 ? newest : null,
		note: unreadable > 0 ? `${unreadable} entries could not be read and were skipped` : null,
		entries,
		// A tree with an unreadable directory is not a complete account of its links, so it offers no table.
		links: options.links === true && unreadable === 0 ? { soleBytes, shared } : null,
	};
}
