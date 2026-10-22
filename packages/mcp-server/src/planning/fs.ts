/**
 * The production `PlanningFs` (phase 52): Node's promise API, read-only.
 *
 * Only "absent" (ENOENT, ENOTDIR) becomes null. Any other failure throws, and the index turns it
 * into an error record for that path. A symlink whose target cannot be stat'ed is reported as
 * `broken`, which the index records as unreadable.
 *
 * A document is read through one descriptor (`openRead`): the real path that descriptor refers to
 * is checked before the first byte is read, so the bytes checked are the bytes read. This needs
 * `/proc/self/fd` (Linux). Where it is missing the read fails, which the index records per path.
 */
import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { type FileHandle, lstat, open, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { errnoCode, type DirEntry, type OpenResult, type PlanningFs } from "./index.ts";

const ABSENT: Record<string, true> = { ENOENT: true, ENOTDIR: true };
const READ_CHUNK = 65_536;

function absentAsNull<T>(run: () => Promise<T>): Promise<T | null> {
	return run().catch((cause: unknown) => {
		if (ABSENT[errnoCode(cause)] === true) return null;
		throw cause;
	});
}

export function nodePlanningFs(): PlanningFs {
	return {
		async probe(path) {
			const real = await absentAsNull(() => realpath(path));
			if (real === null) {
				// No target to follow: a link whose target is missing is dangling; no entry at all is absent.
				return (await absentAsNull(() => lstat(path))) === null ? { state: "absent" } : { state: "dangling" };
			}
			const target = await stat(real);
			return { state: "present", real, isFile: target.isFile(), isDir: target.isDirectory() };
		},
		async readDir(path) {
			const listed = await absentAsNull(() => readdir(path, { withFileTypes: true }));
			if (listed === null) return null;
			return listed.map((dirent): DirEntry => ({ name: dirent.name, kind: kindOf(dirent) }));
		},
		async statFile(path) {
			const found = await absentAsNull(() => stat(path));
			return found === null ? null : { isFile: found.isFile(), size: found.size };
		},
		readFile: (path) => readFile(path),
		openRead: openVerified,
		sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
	};
}

/**
 * Opens `path` and reads through that descriptor. `O_NONBLOCK` keeps a FIFO from blocking the open:
 * it then fails the regular-file check and is never read. The real path is what `/proc/self/fd`
 * names for the descriptor, so `accept` judges the file that is read, not the path that named it.
 */
async function openVerified(path: string, limit: number, accept: (real: string) => boolean): Promise<OpenResult> {
	const handle = await absentAsNull(() => open(path, constants.O_RDONLY | constants.O_NONBLOCK));
	if (handle === null) return { state: "absent" };
	try {
		const real = await readlink(`/proc/self/fd/${handle.fd}`);
		if (!accept(real)) return { state: "refused" };
		const info = await handle.stat();
		if (!info.isFile()) return { state: "opened", real, isFile: false, bytes: new Uint8Array(0) };
		return { state: "opened", real, isFile: true, bytes: await readAtMost(handle, limit) };
	} finally {
		await handle.close();
	}
}

/** Up to `limit` bytes from the descriptor's current position. Never more, whatever the file's size now is. */
async function readAtMost(handle: FileHandle, limit: number): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (total < limit) {
		const chunk = new Uint8Array(Math.min(READ_CHUNK, limit - total));
		const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
		if (bytesRead === 0) break;
		chunks.push(chunk.subarray(0, bytesRead));
		total += bytesRead;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

/** The kind of a listed entry, from the listing alone. A symlink is a `link`: the walk decides what it points at, when it needs to. */
function kindOf(dirent: Dirent): DirEntry["kind"] {
	if (dirent.isFile()) return "file";
	if (dirent.isDirectory()) return "dir";
	return dirent.isSymbolicLink() ? "link" : "other";
}
