/**
 * Which acknowledged steering directives this worktree's hook has already acted on (v1.7, phase 67).
 *
 * `substrate session hook steering` reads each acknowledged directive's `checkpoint_hint` from the server and takes the
 * checkpoint it names. The server keeps returning an acknowledged directive for as long as it lives, so the hook needs a
 * memory of what it has consumed, or every run would hash the worktree again for the same hint. The checkpoints
 * themselves already dedupe (one per directive key, and none for an unchanged tree); this file also stops the
 * re-reading and the re-hashing.
 *
 * It is a cache of decisions already made: losing it costs one skipped checkpoint per hint, never a second checkpoint, so
 * every read problem is "nothing consumed" and every write problem is ignored by the caller. A decision (taken, or skipped
 * because the tree was unchanged) is kept for as long as the server still lists the directive, because a skipped hint has
 * no checkpoint key to stop it later: forgetting it would let an old hint checkpoint unrelated edits. `retainListed` drops
 * the decisions of directives the server no longer lists; `CONSUMED_HARD_MAX` is only the last resort that keeps the file
 * small.
 *
 * The file lives in the worktree's git directory, beside the pending journal and never inside it (the journal rejects
 * files it did not write). Two hooks racing can overwrite each other's decisions: each writes its own temporary file and
 * renames it over this one, so the last rename wins and can drop every id the other recorded, not only the newest. The
 * checkpoint lock still admits one checkpoint per directive.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/** The last resort: a session never remembers more than this many consumed ids, newest kept. */
export const CONSUMED_HARD_MAX = 5_000;
/** The server's directive id bound (`DIRECTIVE_ID_RE` in `packages/mcp-server/src/planning/steering-rest.ts`). */
const MAX_ID_CHARS = 128;
/** Room for the JSON punctuation of one id and of the envelope around the list. */
const ID_OVERHEAD_CHARS = 4;
const ENVELOPE_OVERHEAD_CHARS = 1_024;
/** A file larger than this cannot have been written by `writeConsumed`, whatever the ids are. */
export const CONSUMED_STATE_MAX_BYTES = CONSUMED_HARD_MAX * (MAX_ID_CHARS + ID_OVERHEAD_CHARS) + ENVELOPE_OVERHEAD_CHARS;
const STATE_DIR_NAME = "substrate-steering";

/** Beside the pending journal; historical checkpoint labels and live incarnations have independent caches. */
export function consumedPath(pendingDir: string, sessionId: string, steeringSessionId: string): string {
	const digest = createHash("sha256").update(JSON.stringify([sessionId, steeringSessionId])).digest("hex");
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
	if (text.length > CONSUMED_STATE_MAX_BYTES) return [];
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return [];
	}
	if (typeof value !== "object" || value === null || !("directive_ids" in value) || !Array.isArray(value.directive_ids)) return [];
	return value.directive_ids.filter((id): id is string => typeof id === "string" && id.length > 0).slice(-CONSUMED_HARD_MAX);
}

/**
 * The decisions worth keeping: those of directives the server still lists. Call it only with a listing that was read
 * completely; a failed or partial read must leave the stored decisions alone (absence of a read is not absence of a directive).
 */
export function retainListed(ids: readonly string[], listed: ReadonlySet<string>): string[] {
	return ids.filter((id) => listed.has(id));
}

/** Write the consumed ids atomically, keeping the newest `CONSUMED_HARD_MAX`. Throws on an I/O error; the hook ignores it. */
export function writeConsumed(path: string, sessionId: string, steeringSessionId: string, ids: readonly string[]): void {
	const body = JSON.stringify({ version: 2, session_id: sessionId, steering_session_id: steeringSessionId, directive_ids: ids.slice(-CONSUMED_HARD_MAX) });
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	// A name only this writer uses: a shared one would let two writers interleave their bodies in one file.
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		try {
			writeSync(fd, body);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
	} catch (error) {
		// The temporary is this writer's own (the `wx` open above made it), so removing it cannot touch another writer's file.
		rmSync(temporary, { force: true });
		throw error;
	}
}
