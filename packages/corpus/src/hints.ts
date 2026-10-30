/**
 * The hint spool (v1.7 phase 65): how a git hook tells the watcher that a repository changed.
 *
 * A hint is one tiny JSON file in a spool directory outside every repository, written atomically (a temporary dot file,
 * then a rename) so a reader never sees half of one. The spool is bounded in count and in the size of a file; writing past
 * the bound says so and never throws, because a hook must not fail the user's git command. Lost hints cost nothing: the
 * periodic sweep and the reconcile run find what no hint reported.
 *
 * The count and the publish share one lock file inside the spool, so two hook processes cannot both pass the cap and write.
 * The lock does not need the spool's parent to be writable: writeHint creates the spool before taking it.
 */
import { closeSync, constants, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./guards.ts";

export const HINT_VERSION = 1;
export const MAX_HINT_FILES = 1000;
export const MAX_HINT_BYTES = 4096;
/** The longest repository directory a hint carries; a longer one cannot fit a file of {@link MAX_HINT_BYTES} anyway. */
export const MAX_HINT_DIR_BYTES = 2048;

const HINT_FILE = /^[0-9]{13}-[0-9a-f]{8}\.json$/;

export const HINT_REFUSALS = ["bad-directory", "too-large", "spool-full", "spool-unwritable"] as const;
export type HintRefusal = (typeof HINT_REFUSALS)[number];

export type HintWrite = { ok: true; file: string } | { ok: false; reason: HintRefusal };

export interface HintClock {
	nowMs: () => number;
	/** Eight lowercase hex digits. */
	random: () => string;
}

const HINT_LOCK_WAIT_MS = 30_000;
/** A lock with no owner pid yet is a writer between its open and its write. It is treated as held until it is this old. */
const HINT_LOCK_UNCLAIMED_STALE_MS = 5_000;

/** Milliseconds since the lock file was last written. Unreadable counts as zero, so a lock that cannot be read is never judged old. */
function lockAgeMs(path: string): number {
	try {
		return Date.now() - statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** Takes the lock inside the spool. A dead owner's lock is removed; a live one is waited on. Never exceeds the cap by giving up and writing anyway. */
function acquireHintLock(spoolDir: string): void {
	const path = join(spoolDir, ".lock");
	const started = Date.now();
	for (;;) {
		try {
			const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
			writeSync(fd, `${process.pid}\n`);
			closeSync(fd);
			return;
		} catch (cause) {
			const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
			if (code !== "EEXIST") throw cause;
			let owner = Number.NaN;
			try {
				owner = Number(readFileSync(path, "utf8"));
			} catch {
				owner = Number.NaN;
			}
			let alive = false;
			if (Number.isInteger(owner) && owner > 0) {
				try {
					process.kill(owner, 0);
					alive = true;
				} catch (killCause) {
					alive = killCause instanceof Error && "code" in killCause && killCause.code === "EPERM";
				}
			}
			if (!alive && Number.isInteger(owner) && owner > 0) {
				try {
					unlinkSync(path);
				} catch {
					// The holder released it between the read and the unlink.
				}
				continue;
			}
			if (!alive && lockAgeMs(path) > HINT_LOCK_UNCLAIMED_STALE_MS) {
				try {
					unlinkSync(path);
				} catch {
					// The writer finished and released it between the read and the unlink.
				}
				continue;
			}
			if (Date.now() - started > HINT_LOCK_WAIT_MS) throw new Error("hint lock wait exceeded");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
	}
}

function releaseHintLock(spoolDir: string): void {
	try {
		unlinkSync(join(spoolDir, ".lock"));
	} catch {
		// Already released. The next writer creates it again.
	}
}

/** Writes one hint for the repository at `dir`. Never throws; a refusal is a closed reason. */
export function writeHint(spoolDir: string, dir: string, clock: HintClock): HintWrite {
	if (dir === "" || dir.includes("\0") || Buffer.byteLength(dir, "utf8") > MAX_HINT_DIR_BYTES) return { ok: false, reason: "bad-directory" };
	const body = JSON.stringify({ v: HINT_VERSION, dir, at: Math.floor(clock.nowMs()) });
	if (Buffer.byteLength(body, "utf8") > MAX_HINT_BYTES) return { ok: false, reason: "too-large" };
	try {
		mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
		acquireHintLock(spoolDir);
	} catch {
		return { ok: false, reason: "spool-unwritable" };
	}
	try {
		const waiting = readdirSync(spoolDir).filter((name) => HINT_FILE.test(name)).length;
		if (waiting >= MAX_HINT_FILES) return { ok: false, reason: "spool-full" };
		const name = `${String(Math.floor(clock.nowMs())).padStart(13, "0")}-${clock.random()}.json`;
		const temporary = join(spoolDir, `.${name}.tmp`);
		writeFileSync(temporary, body, { mode: 0o600 });
		renameSync(temporary, join(spoolDir, name));
		return { ok: true, file: name };
	} catch {
		// A hook never reports; the closed reason is all a caller needs.
		return { ok: false, reason: "spool-unwritable" };
	} finally {
		releaseHintLock(spoolDir);
	}
}

export interface HintBatch {
	/** The distinct repository directories, oldest hint first. */
	dirs: string[];
	/** Hint files removed after reading, valid or not. */
	consumed: number;
	/** How many of those were malformed or too large and carried no directory. */
	dropped: number;
}

function parseHint(text: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		// A file that is not JSON is dropped by the caller.
		return null;
	}
	if (!isRecord(parsed) || parsed.v !== HINT_VERSION) return null;
	const dir = parsed.dir;
	return typeof dir === "string" && dir !== "" && !dir.includes("\0") ? dir : null;
}

/**
 * Reads and removes the hints waiting in the spool: at most {@link MAX_HINT_FILES} per call. A file that does not look
 * like a hint of ours is left alone; one that does but is malformed or oversized is removed, so it cannot fill the spool.
 * A directory that cannot be read yields an empty batch.
 */
export function readHints(spoolDir: string): HintBatch {
	let names: string[];
	try {
		names = readdirSync(spoolDir)
			.filter((name) => HINT_FILE.test(name))
			.sort()
			.slice(0, MAX_HINT_FILES);
	} catch {
		// No spool directory means no hint was ever written.
		return { dirs: [], consumed: 0, dropped: 0 };
	}
	const dirs: string[] = [];
	const seen = new Set<string>();
	let consumed = 0;
	let dropped = 0;
	for (const name of names) {
		const file = join(spoolDir, name);
		let dir: string | null = null;
		try {
			if (statSync(file).size <= MAX_HINT_BYTES) dir = parseHint(readFileSync(file, "utf8"));
			rmSync(file, { force: true });
		} catch {
			// The file vanished or cannot be removed; another reader owns it, so it is not counted.
			continue;
		}
		consumed += 1;
		if (dir === null) dropped += 1;
		else if (!seen.has(dir)) {
			seen.add(dir);
			dirs.push(dir);
		}
	}
	return { dirs, consumed, dropped };
}
