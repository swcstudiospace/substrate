/**
 * The production `PlanningFs` (phase 52): Node's promise API, read-only.
 *
 * Only "absent" (ENOENT, ENOTDIR) becomes null. Any other failure throws, and the index turns it
 * into an error record for that path. A symlink whose target cannot be stat'ed is reported as
 * `broken`, which the index records as unreadable.
 */
import { createHash } from "node:crypto";
import { type Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode, type DirEntry, type PlanningFs } from "./index.ts";

const ABSENT: Record<string, true> = { ENOENT: true, ENOTDIR: true };

function absentAsNull<T>(run: () => Promise<T>): Promise<T | null> {
	return run().catch((cause: unknown) => {
		if (ABSENT[errnoCode(cause)] === true) return null;
		throw cause;
	});
}

export function nodePlanningFs(): PlanningFs {
	return {
		realpath: (path) => absentAsNull(() => realpath(path)),
		async readDir(path) {
			const listed = await absentAsNull(() => readdir(path, { withFileTypes: true }));
			if (listed === null) return null;
			return Promise.all(listed.map(async (dirent): Promise<DirEntry> => ({ name: dirent.name, kind: await kindOf(join(path, dirent.name), dirent) })));
		},
		async statFile(path) {
			const found = await absentAsNull(() => stat(path));
			return found === null ? null : { isFile: found.isFile(), size: found.size };
		},
		readFile: (path) => readFile(path),
		sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
	};
}

async function kindOf(path: string, dirent: Dirent): Promise<DirEntry["kind"]> {
	if (dirent.isFile()) return "file";
	if (dirent.isDirectory()) return "dir";
	if (!dirent.isSymbolicLink()) return "other";
	try {
		const target = await stat(path);
		if (target.isFile()) return "file";
		return target.isDirectory() ? "dir" : "other";
	} catch {
		// A dangling or looping link: the index records it as an unreadable path.
		return "broken";
	}
}
