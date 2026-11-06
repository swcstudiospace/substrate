/**
 * The file a path names once symlinks are followed. The event buffer's alias check needs it, and it reads the disk, so only the entry
 * point that runs the server (and the release preflight, which must agree with it) passes it to `loadConfig` as the `realDestination`
 * probe. `loadConfig` itself reads no filesystem.
 */
import { readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Hops followed before a symlink chain counts as a loop (the kernel's SYMLOOP_MAX). */
const MAX_LINK_HOPS = 40;

/**
 * A path that does not exist yet is placed under its real parent directory; a dangling link is followed to its target. A chain longer
 * than `MAX_LINK_HOPS` is a loop, and the path is kept as written.
 */
export function diskDestination(path: string): string {
	return destinationFrom(resolve(path), 0);
}

function destinationFrom(absolute: string, hops: number): string {
	try {
		return realpathSync(absolute);
	} catch {
		if (hops >= MAX_LINK_HOPS) return absolute;
		const target = linkTargetOf(absolute);
		if (target !== null) return destinationFrom(resolve(dirname(absolute), target), hops + 1);
		const parent = dirname(absolute);
		return parent === absolute ? absolute : join(destinationFrom(parent, hops), basename(absolute));
	}
}

function linkTargetOf(path: string): string | null {
	try {
		return readlinkSync(path);
	} catch {
		return null;
	}
}
