/**
 * Client-side bearer resolution for one surface.
 *
 * Order: the `SUBSTRATE_TOKEN` value in the environment, else the first line
 * of the file named by the token-file variable, else the first line of the
 * per-surface file in the tokens dir (the `SUBSTRATE_TOKENS_DIR` value or the
 * built-in default below), else no bearer, as today.
 *
 * The CLI, the collector emit path, the parity probe and the UAT runner share
 * this module; claude-ultrathink `brief.ts` carries the same rule in its own
 * repo. Any read problem means no token (fail-open): hooks and collectors
 * must never block an agent over an unreadable file. The value is never
 * logged here; callers must not log it either.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/** Built-in tokens dir, used when the environment names none. A plain path constant. */
export const DEFAULT_TOKENS_DIR = "/etc/substrate/tokens";

/** Token files hold one short value; anything larger is not one. */
const MAX_TOKEN_FILE_BYTES = 4096;

/** Caller-controlled surfaces are validated before they are joined to a path. */
const SURFACE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The first line of a file, trimmed, or null when there is nothing usable.
 *
 * Missing paths, directories, oversize or unreadable files, and empty first
 * lines all mean null. Never throws, never logs.
 */
export function firstLine(path: string): string | null {
	try {
		const info = statSync(path);
		// A token file is a few bytes. Anything larger, or not a regular file
		// at all, is not one, and reading it whole would be trusting a file
		// this is meant to be sceptical of.
		if (!info.isFile() || info.size === 0 || info.size > MAX_TOKEN_FILE_BYTES) return null;
		const buffer = Buffer.alloc(info.size);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buffer, 0, info.size, 0);
		} finally {
			closeSync(fd);
		}
		const line = buffer.toString("utf8").split("\n", 1)[0]?.trim() ?? "";
		return line ? line : null;
	} catch {
		// An unreadable token file is not an error. Treated as absent, which
		// leaves the previous anonymous behaviour rather than failing a hook.
		return null;
	}
}

/**
 * The bearer for a surface, or null when none is configured.
 *
 * `read` is injectable so tests can prove the order and the surface
 * validation without touching the filesystem.
 */
export function resolveBearer(
	surface: string,
	env: Record<string, string | undefined> = process.env,
	read: (path: string) => string | null = firstLine,
): string | null {
	const direct = env.SUBSTRATE_TOKEN?.trim();
	if (direct) return direct;
	const file = env.SUBSTRATE_TOKEN_FILE?.trim();
	if (file) {
		const viaFile = read(file);
		if (viaFile) return viaFile;
	}
	if (!SURFACE_NAME.test(surface)) return null;
	const dir = env.SUBSTRATE_TOKENS_DIR?.trim() || DEFAULT_TOKENS_DIR;
	return read(join(dir, surface));
}
