/**
 * Per-worktree lock files: `<git dir>/substrate-restore.lock` (one restore at a time) and
 * `<git dir>/substrate-checkpoint.lock` (one checkpoint sequence allocation at a time). They are two
 * files, never one: a rollback takes its pre-restore checkpoint while the restore is in progress, so a
 * shared lock would deadlock. A lock is created atomically with its content (pid, process start time,
 * host, token). The content is written to a private temporary file with O_EXCL and hard-linked into
 * place, so another process never reads a half-written lock.
 *
 * A lock whose owner is gone is stale and is broken: same host and either the pid no longer exists
 * or (Linux, `/proc/<pid>/stat` field 22) the process start time differs, which catches pid reuse.
 * A lock on another host, or one that cannot be parsed, is never broken automatically.
 *
 * Residual race, accepted and documented: two processes that both judge the same lock stale and
 * break it at the same instant can, in the worst interleaving, remove a lock the faster one just
 * created. Breaking re-reads the renamed file and puts a live lock back when the token differs.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fsyncSync,
	linkSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { WorktreeBusyError } from "./errors.ts";

export const LOCK_FILE = "substrate-restore.lock";

/** The lock that serialises checkpoint sequence allocation (list, number, pin) of one worktree. */
export const CHECKPOINT_LOCK_FILE = "substrate-checkpoint.lock";

/** Which lock file to take and what to call its holder in messages; the default is the restore lock. */
export type LockOptions = { file?: string; label?: string };

/** How long `acquireWorktreeLockWithin` waits for a busy lock: `attempts` tries, `delayMs` apart. `sleep` is injectable for tests. */
export type LockWait = { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> };

export const DEFAULT_LOCK_ATTEMPTS = 100;
export const DEFAULT_LOCK_DELAY_MS = 50;

function realSleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

type LockContent = { pid: number; startedAt: string; procStart: string | null; host: string; token: string };

export type WorktreeLock = { token: string; release: () => void };

/** Field 22 of /proc/<pid>/stat (process start time in clock ticks), or null where unavailable. */
export function processStartTicks(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[19] ?? null;
	} catch {
		// Not Linux, or the process is gone: the caller falls back to the pid check alone.
		return null;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function parseLock(text: string): LockContent | null {
	try {
		const value = JSON.parse(text) as Partial<LockContent> | null;
		if (
			value !== null &&
			typeof value === "object" &&
			Number.isSafeInteger(value.pid) &&
			typeof value.token === "string" &&
			typeof value.host === "string" &&
			typeof value.startedAt === "string" &&
			(value.procStart === null || typeof value.procStart === "string")
		) {
			return value as LockContent;
		}
	} catch {
		// Unparseable content is reported by the caller as an unbreakable lock.
	}
	return null;
}

function isStale(lock: LockContent): boolean {
	if (lock.host !== hostname()) return false;
	if (!pidAlive(lock.pid)) return true;
	if (lock.procStart !== null) {
		const current = processStartTicks(lock.pid);
		return current !== null && current !== lock.procStart;
	}
	return false;
}

function tryCreate(path: string, content: LockContent): boolean {
	const temporary = `${path}.${content.token}.tmp`;
	const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	try {
		writeSync(fd, JSON.stringify(content));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		linkSync(temporary, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** Take the lock or throw WorktreeBusyError. Breaks a stale lock once. */
export function acquireWorktreeLock(gitDir: string, now: () => Date, options: LockOptions = {}): WorktreeLock {
	const file = options.file ?? LOCK_FILE;
	const label = options.label ?? "restore";
	const path = join(gitDir, file);
	const token = randomBytes(12).toString("hex");
	const content: LockContent = {
		pid: process.pid,
		startedAt: now().toISOString(),
		procStart: processStartTicks(process.pid),
		host: hostname(),
		token,
	};
	const release = (): void => {
		try {
			const held = parseLock(readFileSync(path, "utf8"));
			if (held?.token === token) rmSync(path, { force: true });
		} catch {
			// The lock file is already gone: nothing to release.
		}
	};
	if (tryCreate(path, content)) return { token, release };

	let existing: LockContent | null = null;
	try {
		existing = parseLock(readFileSync(path, "utf8"));
	} catch {
		// Released between the failed create and this read: retry the create below.
		if (tryCreate(path, content)) return { token, release };
	}
	if (existing === null) {
		throw new WorktreeBusyError(`the ${label} lock ${file} exists and cannot be read; remove it by hand if no ${label} is running`);
	}
	if (!isStale(existing)) {
		throw new WorktreeBusyError(`another ${label} holds the worktree lock (pid ${existing.pid} on ${existing.host} since ${existing.startedAt})`);
	}
	const broken = `${path}.stale-${token}`;
	renameSync(path, broken);
	const moved = parseLock(readFileSync(broken, "utf8"));
	if (moved?.token !== existing.token) {
		// We moved a lock somebody else created after our read: put it back if the path is free.
		try {
			linkSync(broken, path);
		} catch {
			// The path is taken again; that holder is the owner now.
		}
		rmSync(broken, { force: true });
		throw new WorktreeBusyError(`another ${label} took the worktree lock while a stale lock was being broken`);
	}
	rmSync(broken, { force: true });
	if (tryCreate(path, content)) return { token, release };
	throw new WorktreeBusyError(`another ${label} took the worktree lock while a stale lock was being broken`);
}

/**
 * `acquireWorktreeLock` that waits a bounded time for a live holder: up to `attempts` tries, `delayMs`
 * apart, then the last WorktreeBusyError is thrown. A stale lock is still broken on the first try that sees it.
 */
export async function acquireWorktreeLockWithin(gitDir: string, now: () => Date, options: LockOptions & LockWait = {}): Promise<WorktreeLock> {
	const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_LOCK_ATTEMPTS));
	const delayMs = options.delayMs ?? DEFAULT_LOCK_DELAY_MS;
	const sleep = options.sleep ?? realSleep;
	for (let attempt = 1; ; attempt += 1) {
		try {
			return acquireWorktreeLock(gitDir, now, options);
		} catch (error) {
			if (!(error instanceof WorktreeBusyError) || attempt >= attempts) throw error;
		}
		await sleep(delayMs);
	}
}
