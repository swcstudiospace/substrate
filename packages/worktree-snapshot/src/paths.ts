/** Path validation, ordering and blob hashing shared by the snapshot, plan and apply code. */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { UnsupportedPathError } from "./errors.ts";

const ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isValidId(id: string): boolean {
	// Also what git accepts as a ref component: no leading or trailing dot, no `..`, no `.lock` suffix.
	return typeof id === "string" && ID_RE.test(id) && !id.startsWith(".") && !id.endsWith(".") && !id.endsWith(".lock") && !id.includes("..");
}

export function isObjectId(value: unknown): value is string {
	return typeof value === "string" && OBJECT_ID_RE.test(value);
}

/**
 * Decode a path from git. Paths that are not valid UTF-8 or that contain a newline cannot be put in
 * the line-oriented manifest without ambiguity, so they are refused rather than mis-hashed.
 */
export function decodePath(bytes: Buffer): string {
	const text = bytes.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(bytes)) {
		throw new UnsupportedPathError(bytes.toString("latin1"), "the name is not valid UTF-8");
	}
	if (text.includes("\n") || text.includes("\r")) {
		throw new UnsupportedPathError(text, "the name contains a line break");
	}
	return text;
}

/**
 * A worktree-relative path that cannot escape the root or touch git metadata: non-empty, relative,
 * no empty, `.` or `..` segment, no NUL, and no `.git` segment in any
 * letter case (a restored `.git/hooks/x` would be code execution).
 */
export function assertSafeRelativePath(path: string): void {
	if (typeof path !== "string" || path.length === 0) throw new UnsupportedPathError(String(path), "empty path");
	if (path.includes("\0")) throw new UnsupportedPathError(path, "contains NUL");
	if (path.startsWith("/")) throw new UnsupportedPathError(path, "absolute path");
	for (const segment of path.split("/")) {
		if (segment === "" || segment === "." || segment === "..") {
			throw new UnsupportedPathError(path, "contains an empty, '.' or '..' segment");
		}
		if (segment.toLowerCase() === ".git") throw new UnsupportedPathError(path, "names git metadata");
	}
}

/** Byte-wise order of the UTF-8 encodings (UTF-16 string order differs above U+FFFF). */
export function comparePaths(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Every proper ancestor directory of a path, shallowest first: "a/b/c" gives "a", "a/b". */
export function ancestorsOf(path: string): string[] {
	const parts = path.split("/");
	const result: string[] = [];
	for (let i = 1; i < parts.length; i++) result.push(parts.slice(0, i).join("/"));
	return result;
}

export type HashAlgorithm = "sha1" | "sha256";

/** The hash a repository uses for objects, from the length of one of its object ids. */
export function algorithmFor(objectId: string): HashAlgorithm {
	return objectId.length === 64 ? "sha256" : "sha1";
}

/** The git blob id of a buffer: hash of `blob <size>\0<content>`. */
export function blobIdOf(content: Buffer, algorithm: HashAlgorithm): string {
	return createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest("hex");
}

/** The git blob id of a regular file, streamed. `size` is the lstat size taken just before. */
export async function blobIdOfFile(path: string, size: number, algorithm: HashAlgorithm): Promise<string> {
	const hash = createHash(algorithm).update(`blob ${size}\0`);
	let seen = 0;
	for await (const chunk of createReadStream(path)) {
		const buffer = chunk as Buffer;
		seen += buffer.length;
		hash.update(buffer);
	}
	// The file changed length while it was read: no id can match.
	return seen === size ? hash.digest("hex") : "";
}

/**
 * The temporary name for a write: `<dest>.substrate-<id>.tmp` in the destination directory, so the
 * final rename never crosses a filesystem. A very long basename falls back to a short hashed name.
 */
export function tempName(destination: string, id: string): string {
	const suffix = `.substrate-${id}.tmp`;
	const slash = destination.lastIndexOf("/");
	const base = destination.slice(slash + 1);
	if (Buffer.byteLength(base) + Buffer.byteLength(suffix) <= 255) return `${destination}${suffix}`;
	const short = createHash("sha256").update(base).digest("hex").slice(0, 16);
	return `${destination.slice(0, slash + 1)}.substrate-${id}-${short}.tmp`;
}
