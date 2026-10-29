/**
 * Which acknowledged steering directives this worktree's hook has already acted on (v1.7, phase 67).
 *
 * `substrate session hook steering` reads each acknowledged directive's `checkpoint_hint` from the server and takes the
 * checkpoint it names. The server keeps returning an acknowledged directive for as long as it lives, so the hook needs a
 * memory of what it has consumed, or every run would hash the worktree again for the same hint. The checkpoints
 * themselves already dedupe (one per directive key, and none for an unchanged tree); this file also stops the
 * re-reading and the re-hashing.
 *
 * The file lives in the worktree's git directory, beside the pending journal and never inside it (the journal rejects
 * files it did not write). It is a cache of decisions already made: losing it costs one skipped checkpoint per hint, never
 * a second checkpoint, so every read problem is "nothing consumed" and every write problem is ignored by the caller.
 * Two hooks racing can drop each other's newest id; the checkpoint lock still admits one checkpoint per directive.
 */
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/** A session remembers at most this many consumed ids, newest kept. */
export const CONSUMED_MAX = 200;
const STATE_DIR_NAME = "substrate-steering";
const MAX_STATE_BYTES = 64 * 1024;

/** `<git dir>/substrate-steering/consumed-<digest of the session id>.json`, derived from the pending journal's directory. */
export function consumedPath(pendingDir: string, sessionId: string): string {
	const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
	return join(dirname(pendingDir), STATE_DIR_NAME, `consumed-${digest}.json`);
}

/** The consumed directive ids, oldest first; an absent, oversized or malformed file is an empty list. */
export function readConsumed(path: string): string[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		// No file yet is the normal first run; an unreadable one is treated the same, since the policy still dedupes.
		return [];
	}
	if (text.length > MAX_STATE_BYTES) return [];
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return [];
	}
	if (typeof value !== "object" || value === null || !("directive_ids" in value) || !Array.isArray(value.directive_ids)) return [];
	return value.directive_ids.filter((id): id is string => typeof id === "string" && id.length > 0).slice(-CONSUMED_MAX);
}

/** Write the consumed ids atomically, keeping the newest `CONSUMED_MAX`. Throws on an I/O error; the hook ignores it. */
export function writeConsumed(path: string, sessionId: string, ids: readonly string[]): void {
	const body = JSON.stringify({ version: 1, session_id: sessionId, directive_ids: ids.slice(-CONSUMED_MAX) });
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.tmp`;
	const fd = openSync(temporary, "w", 0o600);
	try {
		writeSync(fd, body);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
}
