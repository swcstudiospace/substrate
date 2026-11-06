/**
 * The durable journal of server calls that could not be delivered (v1.6, phase 61): checkpoint
 * records and rollback commits. The local checkpoint (a pinned git ref) and the restored files are
 * the facts; this journal only remembers that the ledger has not been told yet, so `substrate session
 * sync` can tell it later.
 *
 * One JSON file per item under `<git dir>/substrate-pending/` (the git directory is per worktree and
 * never part of a snapshot): `checkpoint-<ckpt id>.json` and `rollback-<rollback id>.json`. A write is
 * atomic (temp file, fsync, rename) with mode 0600 in a 0700 directory. A read is strict: a file that
 * is too large, not a regular file, not valid JSON or not exactly an item is REPORTED as corrupt and
 * skipped, never deleted and never trusted. The count is bounded (`MAX_PENDING_ITEMS`) and so is each
 * file (`MAX_PENDING_BYTES`); a full journal refuses the write with a typed error rather than growing.
 *
 * Replay is harmless to repeat because it sends the SAME idempotency inputs as the first attempt: the
 * checkpoint id and seq, or the rollback id. An item is removed only after the server acknowledges it.
 * A rollback commit queued without a plan digest (the server was never reached, so no plan existed)
 * is planned first at replay time to obtain one.
 */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../../../mcp-server/src/redact.ts";
import {
	type CheckpointPayload,
	ROLLBACK_TRANSCRIPT_OUTCOMES,
	SESSION_CHECKPOINT_ACTION,
	parseCheckpointPayload,
} from "../../../mcp-server/src/session-events.ts";
import { type Runner, spawnRunner } from "../../../worktree-snapshot/src/index.ts";
import {
	CKPT_ID_PATTERN,
	type CommittedRollbackFields,
	type PlanRollbackResult,
	ROLLBACK_ID_PATTERN,
	type RollbackServerClient,
	isUnreachable,
} from "./client.ts";

export const PENDING_DIR_NAME = "substrate-pending";
export const MAX_PENDING_ITEMS = 500;
export const MAX_PENDING_BYTES = 64 * 1024;
const MAX_ERROR_CHARS = 300;
const MAX_ATTEMPTS = 1_000_000;
/** Times `sync` sends a recorded commit again while the server still reports pending plane deletes, before it gives up and says so. */
export const MAX_PLANE_RETRIES = 5;

type PendingKind = "checkpoint" | "rollback";
export type CheckpointRecord = Omit<CheckpointPayload, "action">;

interface PendingBase {
	version: 1;
	session_id: string;
	/** The surface whose bearer delivers the item; the server binds the session to the caller. */
	surface: string;
	queued_at: string;
	attempts: number;
	last_error?: string;
}

/** `id` is the checkpoint id. Replay sends the same `ckpt_id` and `seq`, so the ledger key is unchanged. */
export interface PendingCheckpoint extends PendingBase {
	kind: "checkpoint";
	id: string;
	record: CheckpointRecord;
}

type PendingCommit = { target_ckpt_id: string; plan_digest: string | null } & CommittedRollbackFields;

/**
 * `id` is the rollback id. `commit.plan_digest` is null when no plan was ever obtained. `restoring` marks an item
 * written BEFORE its restore ran: a crash then leaves a record `recover` can finish (forward) or drop (rolled
 * back), and `sync` never delivers it while the restore is unfinished.
 */
export interface PendingRollback extends PendingBase {
	kind: "rollback";
	id: string;
	commit: PendingCommit;
	restoring?: true;
	/**
	 * Present once the server RECORDED this rollback but answered that its Hindsight deletes are still pending
	 * (`memory.plane_pending`): the record is kept so `sync` sends the same commit again, which is the only thing that makes the server
	 * retry them. The value is how many times it has been sent again since. At {@link MAX_PLANE_RETRIES} the record is dropped with a warning.
	 */
	plane_retries?: number;
}

export type PendingItem = PendingCheckpoint | PendingRollback;

type PendingErrorCode = "full" | "too-large" | "invalid" | "io";

export class PendingJournalError extends Error {
	readonly code: PendingErrorCode;
	constructor(code: PendingErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "PendingJournalError";
		this.code = code;
	}
}

/** `<git dir>/substrate-pending` of the worktree. The git directory is per worktree, so linked worktrees do not share a journal. */
export async function resolvePendingDir(worktree: string, run: Runner = spawnRunner): Promise<string> {
	const result = await run(["git", "-C", worktree, "rev-parse", "--absolute-git-dir"]);
	if (result.code !== 0) throw new PendingJournalError("io", "cannot resolve the git directory of the worktree");
	const gitDir = result.stdout.toString("utf8").trim();
	if (gitDir.length === 0) throw new PendingJournalError("io", "cannot resolve the git directory of the worktree");
	return join(realpathSync(gitDir), PENDING_DIR_NAME);
}

// ---------------------------------------------------------------------------
// Strict parse
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function fail(message: string): never {
	throw new PendingJournalError("invalid", message);
}

function rec(value: unknown, path: string): Rec {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${path} must be an object`);
	return value as Rec;
}

function exactKeys(value: Rec, path: string, required: readonly string[], optional: readonly string[]): void {
	for (const key of required) if (!(key in value)) fail(`${path}.${key} is missing`);
	for (const key of Object.keys(value)) {
		if (!required.includes(key) && !optional.includes(key)) fail(`${path}.${key} is not a known field`);
	}
}

function text(value: unknown, path: string, max: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) fail(`${path} must be a non-empty string of at most ${max} characters`);
	return value as string;
}

function count(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) fail(`${path} must be a non-negative integer`);
	return value as number;
}

function isoTime(value: unknown, path: string): string {
	const raw = text(value, path, 40);
	if (Number.isNaN(Date.parse(raw))) fail(`${path} must be an ISO 8601 time`);
	return raw;
}

function parseBase(value: Rec): PendingBase {
	return {
		version: 1,
		session_id: text(value.session_id, "session_id", 512),
		surface: text(value.surface, "surface", 64),
		queued_at: isoTime(value.queued_at, "queued_at"),
		attempts: count(value.attempts, "attempts", MAX_ATTEMPTS),
		...(value.last_error === undefined ? {} : { last_error: text(value.last_error, "last_error", MAX_ERROR_CHARS) }),
	};
}

function parseCommit(value: unknown): PendingCommit {
	const commit = rec(value, "commit");
	exactKeys(
		commit,
		"commit",
		["target_ckpt_id", "plan_digest", "from_ckpt_id", "pre_restore_tree", "pre_restore_ckpt_id", "files", "transcript"],
		["local_only", "until_ms"],
	);
	const ckpt = (key: string): string => {
		const id = text(commit[key], `commit.${key}`, 64);
		if (!CKPT_ID_PATTERN.test(id)) fail(`commit.${key} is not a checkpoint id`);
		return id;
	};
	const files = rec(commit.files, "commit.files");
	exactKeys(files, "commit.files", ["added", "modified", "deleted"], []);
	const transcript = text(commit.transcript, "commit.transcript", 32);
	if (!(ROLLBACK_TRANSCRIPT_OUTCOMES as readonly string[]).includes(transcript)) fail("commit.transcript is not a known outcome");
	const tree = text(commit.pre_restore_tree, "commit.pre_restore_tree", 64);
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree)) fail("commit.pre_restore_tree is not a git object id");
	const digest = commit.plan_digest === null ? null : text(commit.plan_digest, "commit.plan_digest", 256);
	if (commit.local_only !== undefined && typeof commit.local_only !== "boolean") fail("commit.local_only must be a boolean");
	const untilMs = commit.until_ms === undefined ? undefined : count(commit.until_ms, "commit.until_ms");
	return {
		target_ckpt_id: ckpt("target_ckpt_id"),
		plan_digest: digest,
		from_ckpt_id: ckpt("from_ckpt_id"),
		pre_restore_tree: tree,
		pre_restore_ckpt_id: ckpt("pre_restore_ckpt_id"),
		files: { added: count(files.added, "commit.files.added"), modified: count(files.modified, "commit.files.modified"), deleted: count(files.deleted, "commit.files.deleted") },
		transcript: transcript as PendingCommit["transcript"],
		...(commit.local_only === undefined ? {} : { local_only: commit.local_only }),
		...(untilMs === undefined ? {} : { until_ms: untilMs }),
	};
}

/** Parse one journal item exactly; throws `PendingJournalError("invalid")` naming the field. */
function parsePendingItem(value: unknown): PendingItem {
	const item = rec(value, "item");
	if (item.version !== 1) fail("version must be 1");
	if (item.kind === "checkpoint") {
		exactKeys(item, "item", ["version", "kind", "id", "session_id", "surface", "queued_at", "attempts", "record"], ["last_error"]);
		const id = text(item.id, "id", 64);
		if (!CKPT_ID_PATTERN.test(id)) fail("id is not a checkpoint id");
		let record: CheckpointRecord;
		try {
			const { action: _action, ...rest } = parseCheckpointPayload({ ...rec(item.record, "record"), action: SESSION_CHECKPOINT_ACTION });
			record = rest;
		} catch (cause) {
			if (cause instanceof PendingJournalError) throw cause;
			fail(`record: ${cause instanceof Error ? cause.message : "invalid"}`);
		}
		if (record.ckpt_id !== id) fail("record.ckpt_id does not match id");
		return { ...parseBase(item), kind: "checkpoint", id, record };
	}
	if (item.kind === "rollback") {
		exactKeys(item, "item", ["version", "kind", "id", "session_id", "surface", "queued_at", "attempts", "commit"], ["last_error", "restoring", "plane_retries"]);
		const id = text(item.id, "id", 64);
		if (!ROLLBACK_ID_PATTERN.test(id)) fail("id is not a rollback id");
		if (item.restoring !== undefined && item.restoring !== true) fail("restoring must be true when present");
		const planeRetries = item.plane_retries === undefined ? undefined : count(item.plane_retries, "plane_retries", MAX_PLANE_RETRIES);
		if (planeRetries !== undefined && item.restoring === true) fail("plane_retries and restoring cannot both be set: a commit the server recorded has a finished restore");
		return {
			...parseBase(item),
			kind: "rollback",
			id,
			commit: parseCommit(item.commit),
			...(item.restoring === true ? { restoring: true as const } : {}),
			...(planeRetries === undefined ? {} : { plane_retries: planeRetries }),
		};
	}
	return fail("kind must be checkpoint or rollback");
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const FILE_NAME = /^(checkpoint|rollback)-([A-Za-z0-9._-]{1,64})\.json$/;

function fileNameOf(kind: PendingKind, id: string): string {
	return `${kind}-${id}.json`;
}

function pendingFiles(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new PendingJournalError("io", "cannot read the pending journal directory", { cause: error });
	}
	// Temp files of an interrupted write end in .tmp; they are never items.
	return names.filter((name) => !name.endsWith(".tmp")).sort();
}

/**
 * Write one item atomically. Idempotent for the same kind and id (the file is replaced). Throws
 * `PendingJournalError`: `invalid` (the item is not valid), `too-large`, `full` (a NEW item beyond the
 * count bound) or `io`.
 */
export function writePending(dir: string, item: PendingItem): void {
	const checked = parsePendingItem(JSON.parse(JSON.stringify(item)) as unknown);
	const body = JSON.stringify(checked);
	if (Buffer.byteLength(body, "utf8") > MAX_PENDING_BYTES) throw new PendingJournalError("too-large", `the pending item exceeds ${MAX_PENDING_BYTES} bytes`);
	const name = fileNameOf(checked.kind, checked.id);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const files = pendingFiles(dir);
		if (!files.includes(name) && files.length >= MAX_PENDING_ITEMS) {
			throw new PendingJournalError("full", `the pending journal already holds ${MAX_PENDING_ITEMS} items; run \`substrate session sync\``);
		}
		const path = join(dir, name);
		const temporary = `${path}.tmp`;
		const fd = openSync(temporary, "w", 0o600);
		try {
			writeSync(fd, body);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
	} catch (error) {
		if (error instanceof PendingJournalError) throw error;
		throw new PendingJournalError("io", "cannot write the pending journal", { cause: error });
	}
}

export function removePending(dir: string, kind: PendingKind, id: string): void {
	rmSync(join(dir, fileNameOf(kind, id)), { force: true });
}

/**
 * Settle the rollbacks marked `restoring` after `recoverRestore` ran. `forward`: the restore finished, so the
 * mark is cleared and the commit is deliverable. Anything else for that id (rolled back) or, with no journal at
 * all (`recovered` null), every marked item: the restore did not take effect, so the commit is dropped.
 * Returns the ids it cleared and the ids it dropped.
 */
export function settleInterruptedRestores(dir: string, recovered: { id: string; direction: "forward" | "rollback" } | null): { completed: string[]; dropped: string[] } {
	const settled = { completed: [] as string[], dropped: [] as string[] };
	for (const item of listPending(dir).items) {
		if (item.kind !== "rollback" || item.restoring !== true) continue;
		if (recovered !== null && item.id !== recovered.id) continue;
		if (recovered !== null && recovered.direction === "forward") {
			const { restoring: _marked, ...rest } = item;
			writePending(dir, rest);
			settled.completed.push(item.id);
		} else {
			removePending(dir, "rollback", item.id);
			settled.dropped.push(item.id);
		}
	}
	return settled;
}

interface CorruptPending {
	file: string;
	reason: string;
}

interface PendingListing {
	items: PendingItem[];
	corrupt: CorruptPending[];
}

/** Every valid item, oldest first (checkpoints before rollbacks), and every file that was reported and skipped. */
export function listPending(dir: string): PendingListing {
	const items: PendingItem[] = [];
	const corrupt: CorruptPending[] = [];
	const files = pendingFiles(dir);
	for (const name of files.slice(0, MAX_PENDING_ITEMS)) {
		const match = FILE_NAME.exec(name);
		if (match === null) {
			corrupt.push({ file: name, reason: "not a pending journal file name" });
			continue;
		}
		const path = join(dir, name);
		try {
			const info = lstatSync(path);
			if (!info.isFile()) throw new PendingJournalError("invalid", "not a regular file");
			if (info.size > MAX_PENDING_BYTES) throw new PendingJournalError("invalid", `larger than ${MAX_PENDING_BYTES} bytes`);
			let value: unknown;
			try {
				value = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				throw new PendingJournalError("invalid", "not valid JSON");
			}
			const item = parsePendingItem(value);
			if (item.kind !== match[1] || item.id !== match[2]) throw new PendingJournalError("invalid", "the file name does not match its content");
			items.push(item);
		} catch (error) {
			const reason = error instanceof PendingJournalError ? error.message : "unreadable";
			corrupt.push({ file: name, reason });
		}
	}
	if (files.length > MAX_PENDING_ITEMS) corrupt.push({ file: "(directory)", reason: `more than ${MAX_PENDING_ITEMS} files; the rest were not read` });
	items.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "checkpoint" ? -1 : 1;
		if (a.kind === "checkpoint" && b.kind === "checkpoint") {
			if (a.session_id !== b.session_id) return a.session_id < b.session_id ? -1 : 1;
			return a.record.seq - b.record.seq;
		}
		return a.queued_at < b.queued_at ? -1 : a.queued_at > b.queued_at ? 1 : a.id < b.id ? -1 : 1;
	});
	return { items, corrupt };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

interface DeliveredPending {
	kind: PendingKind;
	id: string;
	event_id: string;
}

interface FailedPending {
	kind: PendingKind;
	id: string;
	code: string;
	message: string;
	retryable: boolean;
}

interface ReplayOutcome {
	delivered: DeliveredPending[];
	failed: FailedPending[];
	/** Items not attempted because an earlier call showed the server unreachable. */
	skipped: number;
	corrupt: CorruptPending[];
	/** Items left in the journal after this replay. */
	remaining: number;
	/** Rollbacks the server recorded whose Hindsight deletes are still pending: kept in the journal, sent again by the next sync (bounded). */
	plane_pending: Array<{ id: string; event_id: string; retries: number }>;
	/** Named conditions the operator must see: a rollback whose pending plane deletes were given up on. */
	warnings: string[];
}

interface ReplayParams {
	dir: string;
	/** The client for one surface: the bearer is per surface. */
	clientFor: (surface: string) => RollbackServerClient;
}

function noteAttempt(dir: string, item: PendingItem, error: { code: string; message: string }): void {
	const lastError = redact(`${error.code}: ${error.message}`).slice(0, MAX_ERROR_CHARS);
	try {
		writePending(dir, { ...item, attempts: Math.min(item.attempts + 1, MAX_ATTEMPTS), last_error: lastError });
	} catch {
		// Bookkeeping only: the item itself is intact and is retried on the next sync, so a failed note changes nothing.
	}
}

/**
 * Deliver every pending item once, checkpoints before rollbacks (a commit names its checkpoints). An
 * item is removed only after the server acknowledges it; a failure leaves it in place with its attempt
 * count. The first unreachable answer stops the run, so a down server costs one timeout, not one per item.
 */
export async function replayPending(params: ReplayParams): Promise<ReplayOutcome> {
	const { dir } = params;
	const listing = listPending(dir);
	const outcome: ReplayOutcome = { delivered: [], failed: [], skipped: 0, corrupt: listing.corrupt, remaining: 0, plane_pending: [], warnings: [] };
	let stopped = false;
	for (const item of listing.items) {
		if (stopped) {
			outcome.skipped++;
			continue;
		}
		if (item.kind === "rollback" && item.restoring === true) {
			// Its restore has not finished (or crashed): telling the ledger now could record a rollback the files never took.
			outcome.failed.push({ kind: "rollback", id: item.id, code: "restore-in-progress", message: "the restore of this rollback is not finished; run `substrate session recover`", retryable: false });
			continue;
		}
		const client = params.clientFor(item.surface);
		let failure: { code: string; message: string; retryable: boolean } | null = null;
		let eventId = "";
		let planePending = false;
		// The digest the server accepted for a rollback commit: a record kept for a plane retry must hold it, never the queued null.
		let acceptedDigest: string | null = null;
		if (item.kind === "checkpoint") {
			const result = await client.recordCheckpoint({ ...item.record, session_id: item.session_id });
			if (result.ok) eventId = result.value.event_id;
			else failure = result.error;
		} else {
			const plan = (): Promise<PlanRollbackResult> =>
				client.planRollback({
					session_id: item.session_id,
					target_ckpt_id: item.commit.target_ckpt_id,
					rollback_id: item.id,
					// The bound the rollback began with: a late sync plans (and commits) the same memory the first attempt would have.
					...(item.commit.until_ms === undefined ? {} : { until_ms: item.commit.until_ms }),
				});
			let digest = item.commit.plan_digest;
			if (digest === null) {
				const planned = await plan();
				if (planned.ok) digest = planned.value.plan.plan_digest;
				else failure = planned.error;
			}
			for (let attempt = 0; digest !== null && attempt < 2; attempt++) {
				const { plan_digest: _planned, ...fields } = item.commit;
				const committed = await client.commitRollback({
					session_id: item.session_id,
					rollback_id: item.id,
					plan_digest: digest,
					outcome: "committed",
					...fields,
				});
				if (committed.ok) {
					eventId = committed.value.event_id;
					planePending = committed.value.memory?.plane_pending === true;
					acceptedDigest = digest;
					failure = null;
					break;
				}
				failure = committed.error;
				// A changed plan is re-planned once; a second change is left for the next sync.
				if (committed.error.code !== "stale-plan" || attempt === 1) break;
				const replanned = await plan();
				if (!replanned.ok) {
					failure = replanned.error;
					break;
				}
				digest = replanned.value.plan.plan_digest;
			}
		}
		if (failure === null) {
			if (item.kind === "rollback" && planePending) {
				// The server recorded the rollback but its Hindsight deletes are not done, and it retries them only when it is sent this same
				// commit again: the record stays (a bounded number of times) instead of being treated as delivered.
				const retries = item.plane_retries === undefined ? 0 : item.plane_retries + 1;
				if (retries >= MAX_PLANE_RETRIES) {
					removePending(dir, item.kind, item.id);
					outcome.warnings.push(
						`plane-pending-exhausted: rollback ${item.id} is recorded (event ${eventId}) but the server still reports its Hindsight deletes pending after ${MAX_PLANE_RETRIES} retries; the pending record was dropped, so nothing retries them from this worktree: ask the operator to check the Hindsight plane`,
					);
					continue;
				}
				try {
					// The digest the server accepted is kept, so an offline rollback (queued with a null digest) re-sends the very commit it recorded.
					writePending(dir, { ...item, commit: { ...item.commit, plan_digest: acceptedDigest ?? item.commit.plan_digest }, plane_retries: retries, last_error: "plane-pending: the rollback is recorded; its Hindsight deletes are pending" });
				} catch {
					// Bookkeeping only: the record is intact and the next sync sends the commit again.
				}
				outcome.plane_pending.push({ id: item.id, event_id: eventId, retries });
				if (item.plane_retries === undefined) outcome.delivered.push({ kind: item.kind, id: item.id, event_id: eventId });
				continue;
			}
			removePending(dir, item.kind, item.id);
			outcome.delivered.push({ kind: item.kind, id: item.id, event_id: eventId });
			continue;
		}
		noteAttempt(dir, item, failure);
		outcome.failed.push({ kind: item.kind, id: item.id, code: failure.code, message: failure.message, retryable: failure.retryable });
		if (isUnreachable(failure)) stopped = true;
	}
	outcome.remaining = listPending(dir).items.length;
	return outcome;
}
