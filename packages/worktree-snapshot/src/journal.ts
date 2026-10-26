/**
 * The restore journal: one JSON file, written atomically (temp file, fsync, rename) before the
 * first change and removed when the restore ends. It holds paths and object ids only, never file
 * contents. A journal that outlives its process marks a crashed restore for `recoverRestore`.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { SnapshotPolicyError } from "./errors.ts";
import { isObjectId, isValidId } from "./paths.ts";
import { resolvePolicy } from "./policy.ts";
import type { RepoContext } from "./runner.ts";
import type { ResolvedPolicy } from "./types.ts";

export const JOURNAL_FILE = "restore-journal.json";

export type JournalState = "applying" | "rolling-back";

export type Journal = {
	version: 1;
	id: string;
	state: JournalState;
	startedAt: string;
	targetTree: string;
	safetyTree: string;
	safetyRef: string;
	targetRef: string;
	policy: ResolvedPolicy;
	/** The planned operations (kind and path only), for audit; recovery recomputes from the trees. */
	operations: { op: string; path: string }[];
};

function isInside(parent: string, child: string): boolean {
	return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/**
 * The journal directory: `<git dir>/substrate-restore` unless one is given. A directory inside the
 * working tree (other than the git directory) is refused: the journal would show up in snapshots.
 */
export function resolveJournalDir(ctx: RepoContext, journalDir?: string): string {
	if (journalDir === undefined) return join(ctx.gitDir, "substrate-restore");
	const dir = resolve(journalDir);
	if (isInside(ctx.root, dir) && !isInside(ctx.gitDir, dir)) {
		throw new SnapshotPolicyError("journalDir must not be inside the working tree");
	}
	return dir;
}

export function writeJournal(dir: string, journal: Journal): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, JOURNAL_FILE);
	const temporary = `${path}.tmp`;
	const fd = openSync(temporary, "w", 0o600);
	try {
		writeSync(fd, JSON.stringify(journal));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
}

export function removeJournal(dir: string): void {
	rmSync(join(dir, JOURNAL_FILE), { force: true });
	rmSync(join(dir, `${JOURNAL_FILE}.tmp`), { force: true });
}

export function journalExists(dir: string): boolean {
	try {
		readFileSync(join(dir, JOURNAL_FILE));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Read and validate the journal; null when there is none. A malformed journal is an error. */
export function readJournal(dir: string): Journal | null {
	let text: string;
	try {
		text = readFileSync(join(dir, JOURNAL_FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let value: Partial<Journal> | null;
	try {
		value = JSON.parse(text) as Partial<Journal> | null;
	} catch (cause) {
		throw new SnapshotPolicyError("the restore journal is not valid JSON", { cause });
	}
	if (
		value === null ||
		typeof value !== "object" ||
		value.version !== 1 ||
		(value.state !== "applying" && value.state !== "rolling-back") ||
		typeof value.id !== "string" ||
		!isValidId(value.id) ||
		typeof value.startedAt !== "string" ||
		!isObjectId(value.targetTree) ||
		!isObjectId(value.safetyTree) ||
		typeof value.safetyRef !== "string" ||
		typeof value.targetRef !== "string" ||
		typeof value.policy !== "object" ||
		value.policy === null ||
		!Array.isArray(value.operations)
	) {
		throw new SnapshotPolicyError("the restore journal is malformed");
	}
	const stored = value.policy as Partial<ResolvedPolicy>;
	const policy = resolvePolicy({
		maxFileBytes: stored.maxFileBytes,
		extraSecretPatterns: stored.secretPatterns,
		extraExcludeDirs: stored.excludeDirs,
		extraExcludeGlobs: stored.excludeGlobs,
		ignoredAllowlist: stored.ignoredAllowlist,
	});
	const operations: { op: string; path: string }[] = [];
	for (const operation of value.operations as unknown[]) {
		if (
			typeof operation === "object" &&
			operation !== null &&
			"op" in operation &&
			"path" in operation &&
			typeof operation.op === "string" &&
			typeof operation.path === "string"
		) {
			operations.push({ op: operation.op, path: operation.path });
		}
	}
	return { ...(value as Journal), policy, operations };
}
