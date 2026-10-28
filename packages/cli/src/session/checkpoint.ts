/**
 * Local checkpoints of a session (v1.6, phase 61). A checkpoint is the exact file state of the worktree,
 * pinned as `refs/substrate/checkpoints/<worktree scope>/<ckpt id>` by `@substrate/worktree-snapshot`, with its session,
 * `seq`, trigger and transcript pointer stored as a metadata trailer in the pinned commit. Those refs ARE
 * the local checkpoint registry: listing, choosing a rollback target and rolling back all work with the
 * server unreachable.
 *
 * `createCheckpoint` snapshots the worktree, pins it, then tells the server (`session_checkpoint`). A server
 * failure is NOT a checkpoint failure: the local checkpoint stands and a pending record is journaled
 * (`pending.ts`) so `substrate session sync` can record it later; replay sends the same ckpt id and seq, so
 * it is harmless. Only a local failure (the snapshot or the pin) throws.
 *
 * `seq` is the highest local seq of the session plus one, and `prev_ckpt_id` is the checkpoint it follows.
 * Asking for a seq that already exists returns that checkpoint instead of making another (idempotent by
 * session and seq) and offers it to the server again.
 *
 * The sequence is allocated under `<git dir>/substrate-checkpoint.lock`: the list of existing checkpoints,
 * the choice of `seq` and the pin happen while one process holds it, so two processes sharing a git
 * directory can never pin the same seq (the ledger key `ckpt:s.<session>:<seq>` would have deduped one
 * of them silently). The snapshot, which is slow, is taken before the lock; the server call after it.
 * It is NOT the restore lock (a rollback takes its pre-restore checkpoint during a restore). A lock that
 * stays busy past its bounded wait fails the call with `WorktreeBusyError`; nothing was pinned.
 */
import { realpathSync } from "node:fs";
import {
	CHECKPOINT_TRIGGERS,
	type CheckpointTrigger,
	type RandomBytes,
	type TranscriptRef,
	buildCheckpointEvent,
	newCheckpointId,
	parseTranscriptRef,
} from "../../../mcp-server/src/session-events.ts";
import {
	CHECKPOINT_LOCK_FILE,
	type Clock,
	GitCommandError,
	type LockWait,
	type PinnedCheckpoint,
	type Runner,
	type SkippedPath,
	type SnapshotPolicy,
	acquireWorktreeLockWithin,
	listPinned,
	pinSnapshot,
	readPinnedSnapshot,
	snapshot,
	spawnRunner,
} from "../../../worktree-snapshot/src/index.ts";
import { CKPT_ID_PATTERN, type RollbackServerClient } from "./client.ts";
import { PendingJournalError, resolvePendingDir, writePending, type CheckpointRecord } from "./pending.ts";

export type PlanRef = { phase?: string; step?: string };

/** A checkpoint read back from its pinned ref and metadata trailer. */
export interface LocalCheckpoint {
	ckpt_id: string;
	ref: string;
	commit: string;
	tree: string;
	createdAt: string;
	seq: number;
	trigger: CheckpointTrigger;
	session_id: string;
	transcript_ref?: TranscriptRef;
	prev_ckpt_id?: string;
	plan_ref?: PlanRef;
	file_count?: number;
	skipped_count?: number;
	/** Epoch milliseconds when the snapshot was pinned, from the injected clock. Absent on a checkpoint pinned before the field existed. */
	taken_at_ms?: number;
}

/** A pinned ref under `refs/substrate/checkpoints/` that is not a usable checkpoint (no or corrupt metadata). */
export interface InvalidCheckpoint {
	id: string;
	reason: string;
}

export interface LocalCheckpoints {
	/** Sorted by session, then seq. */
	checkpoints: LocalCheckpoint[];
	invalid: InvalidCheckpoint[];
}

export type CheckpointErrorCode = "invalid-input" | "seq-conflict";

export class CheckpointError extends Error {
	readonly code: CheckpointErrorCode;
	constructor(code: CheckpointErrorCode, message: string) {
		super(message);
		this.name = "CheckpointError";
		this.code = code;
	}
}

type Rec = Record<string, unknown>;

function readLocal(entry: PinnedCheckpoint): LocalCheckpoint | string {
	if (entry.metadataError !== null) return entry.metadataError;
	const meta: Rec | null = entry.metadata;
	if (meta === null) return "the checkpoint ref has no metadata";
	if (meta.ckpt_id !== entry.id || !CKPT_ID_PATTERN.test(entry.id)) return "the metadata ckpt_id does not match the ref";
	const seq = meta.seq;
	if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return "the metadata seq is not a positive integer";
	const trigger = meta.trigger;
	if (typeof trigger !== "string" || !(CHECKPOINT_TRIGGERS as readonly string[]).includes(trigger)) return "the metadata trigger is not a known trigger";
	const sessionId = meta.session_id;
	if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 512) return "the metadata session_id is not valid";
	const out: LocalCheckpoint = {
		ckpt_id: entry.id,
		ref: entry.ref,
		commit: entry.commit,
		tree: entry.tree,
		createdAt: entry.createdAt,
		seq,
		trigger: trigger as CheckpointTrigger,
		session_id: sessionId,
	};
	if (meta.transcript_ref !== undefined) {
		try {
			out.transcript_ref = parseTranscriptRef(meta.transcript_ref);
		} catch {
			return "the metadata transcript_ref is not valid";
		}
	}
	if (meta.prev_ckpt_id !== undefined) {
		if (typeof meta.prev_ckpt_id !== "string" || !CKPT_ID_PATTERN.test(meta.prev_ckpt_id)) return "the metadata prev_ckpt_id is not valid";
		out.prev_ckpt_id = meta.prev_ckpt_id;
	}
	if (meta.plan_ref !== undefined) {
		const plan = meta.plan_ref as Rec | null;
		if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return "the metadata plan_ref is not valid";
		const ref: PlanRef = {};
		if (typeof plan.phase === "string") ref.phase = plan.phase;
		if (typeof plan.step === "string") ref.step = plan.step;
		out.plan_ref = ref;
	}
	if (typeof meta.file_count === "number" && Number.isSafeInteger(meta.file_count) && meta.file_count >= 0) out.file_count = meta.file_count;
	if (typeof meta.skipped_count === "number" && Number.isSafeInteger(meta.skipped_count) && meta.skipped_count >= 0) out.skipped_count = meta.skipped_count;
	if (typeof meta.taken_at_ms === "number" && Number.isSafeInteger(meta.taken_at_ms) && meta.taken_at_ms >= 0) out.taken_at_ms = meta.taken_at_ms;
	return out;
}

/** The local checkpoint registry: every usable checkpoint pinned in this worktree, and every ref that is not one. */
export async function listLocalCheckpoints(params: { worktree: string; run?: Runner; now?: Clock }): Promise<LocalCheckpoints> {
	const checkpoints: LocalCheckpoint[] = [];
	const invalid: InvalidCheckpoint[] = [];
	for (const entry of await listPinned(params)) {
		const parsed = readLocal(entry);
		if (typeof parsed === "string") invalid.push({ id: entry.id, reason: parsed });
		else checkpoints.push(parsed);
	}
	checkpoints.sort((a, b) => (a.session_id === b.session_id ? a.seq - b.seq || (a.ckpt_id < b.ckpt_id ? -1 : 1) : a.session_id < b.session_id ? -1 : 1));
	return { checkpoints, invalid };
}

/** The checkpoints of one session, ascending by seq. */
export function checkpointsOfSession(all: readonly LocalCheckpoint[], sessionId: string): LocalCheckpoint[] {
	return all.filter((checkpoint) => checkpoint.session_id === sessionId).sort((a, b) => a.seq - b.seq);
}

export type CheckpointServerStatus =
	| { status: "recorded"; event_id: string; stored: boolean }
	/** The server was not reached or refused; the record is in the pending journal for `substrate session sync`. */
	| { status: "pending"; code: string; message: string }
	/** The server was not reached and the pending journal could not take the record either. */
	| { status: "unrecorded"; code: string; message: string; journal_error: string };

export interface CheckpointResult {
	checkpoint: LocalCheckpoint;
	/** False when a checkpoint with this session and seq already existed and was returned. */
	created: boolean;
	server: CheckpointServerStatus;
	/** Paths the snapshot policy left out (secret-pattern, too-large, ...). Empty for an existing checkpoint. */
	skipped: SkippedPath[];
	file_count: number;
}

export interface CreateCheckpointParams {
	worktree: string;
	sessionId: string;
	trigger: CheckpointTrigger;
	transcriptRef?: TranscriptRef;
	planRef?: PlanRef;
	/** The surface whose bearer delivers a pending record later. */
	surface: string;
	client: RollbackServerClient;
	now: Clock;
	randomBytes: RandomBytes;
	run?: Runner;
	/** Override the pending journal directory (default: `<git dir>/substrate-pending`). */
	pendingDir?: string;
	policy?: SnapshotPolicy;
	/** Ask for this seq. An existing checkpoint with it is returned; a seq at or below the highest, not existing, is refused. */
	seq?: number;
	/** How long to wait for the checkpoint lock when another process holds it (default 100 tries, 50 ms apart); tests inject `sleep`. */
	lockWait?: LockWait;
}

/**
 * Create (or find) a checkpoint and offer it to the server. Throws `CheckpointError` for invalid input and
 * the snapshot library's errors for a local failure; a server failure never throws.
 */
export async function createCheckpoint(params: CreateCheckpointParams): Promise<CheckpointResult> {
	const run = params.run ?? spawnRunner;
	const { sessionId, trigger } = params;
	if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 512) {
		throw new CheckpointError("invalid-input", "the session id must be a non-empty string of at most 512 characters");
	}
	if (!(CHECKPOINT_TRIGGERS as readonly string[]).includes(trigger)) {
		throw new CheckpointError("invalid-input", `the trigger must be one of ${CHECKPOINT_TRIGGERS.join(", ")}`);
	}
	let transcriptRef: TranscriptRef | undefined;
	if (params.transcriptRef !== undefined) {
		try {
			transcriptRef = parseTranscriptRef(params.transcriptRef);
		} catch (cause) {
			throw new CheckpointError("invalid-input", `transcript_ref: ${cause instanceof Error ? cause.message : "invalid"}`);
		}
	}
	// A first look, before the slow snapshot: a seq that already exists is answered without one, and a refused seq fails early.
	const early = decideSeq((await listLocalCheckpoints({ worktree: params.worktree, run, now: params.now })).checkpoints, sessionId, params.seq);
	if (early.kind === "found") return offerExisting(params, run, early.found);

	const snap = await snapshot({ worktree: params.worktree, policy: params.policy, now: params.now, run });
	// When the files were pinned: a checkpoint the server hears of hours later cuts memory at THIS instant, not at its record time.
	const takenAtMs = params.now().getTime();
	const ckptId = newCheckpointId(params.randomBytes);

	// The decision that counts: list, choose the seq and pin while holding the checkpoint lock, so a concurrent
	// process cannot take the same seq between the list and the pin.
	const lock = await acquireWorktreeLockWithin(await resolveGitDir(params.worktree, run), params.now, {
		...params.lockWait,
		file: CHECKPOINT_LOCK_FILE,
		label: "checkpoint",
	});
	let record: CheckpointRecord;
	let checkpoint: LocalCheckpoint;
	try {
		const decision = decideSeq((await listLocalCheckpoints({ worktree: params.worktree, run, now: params.now })).checkpoints, sessionId, params.seq);
		// Another process made this seq while this one was snapshotting: it is that process's checkpoint now.
		if (decision.kind === "found") {
			lock.release();
			return await offerExisting(params, run, decision.found);
		}
		const { seq, last } = decision;
		record = {
			ckpt_id: ckptId,
			seq,
			trigger,
			git_tree: snap.tree,
			...(snap.headCommit === null ? {} : { git_base_commit: snap.headCommit }),
			// The contract caps a branch name at 200 characters; a longer name is left out, not truncated.
			...(snap.branch === null || snap.branch.length > 200 ? {} : { branch: snap.branch }),
			manifest_sha256: snap.manifestSha256,
			file_count: snap.entries.length,
			skipped_count: snap.skipped.length,
			...(transcriptRef === undefined ? {} : { transcript_ref: transcriptRef }),
			...(params.planRef === undefined ? {} : { plan_ref: params.planRef }),
			...(last === undefined ? {} : { prev_ckpt_id: last.ckpt_id }),
			taken_at_ms: takenAtMs,
		};
		try {
			// The same validation the ledger event goes through, before anything is pinned.
			buildCheckpointEvent(sessionId, record);
		} catch (cause) {
			throw new CheckpointError("invalid-input", cause instanceof Error ? cause.message : "the checkpoint is not valid");
		}
		const pin = await pinSnapshot({
			worktree: params.worktree,
			snapshot: snap,
			id: ckptId,
			metadata: {
				ckpt_id: ckptId,
				seq,
				trigger,
				session_id: sessionId,
				transcript_ref: transcriptRef,
				prev_ckpt_id: record.prev_ckpt_id,
				plan_ref: params.planRef,
				file_count: record.file_count,
				skipped_count: record.skipped_count,
				taken_at_ms: takenAtMs,
			},
			now: params.now,
			run,
		});
		checkpoint = {
			ckpt_id: ckptId,
			ref: pin.ref,
			commit: pin.commit,
			tree: snap.tree,
			createdAt: params.now().toISOString(),
			seq,
			trigger,
			session_id: sessionId,
			...(transcriptRef === undefined ? {} : { transcript_ref: transcriptRef }),
			...(record.prev_ckpt_id === undefined ? {} : { prev_ckpt_id: record.prev_ckpt_id }),
			...(params.planRef === undefined ? {} : { plan_ref: params.planRef }),
			file_count: record.file_count,
			skipped_count: record.skipped_count,
			taken_at_ms: takenAtMs,
		};
	} finally {
		lock.release();
	}
	const server = await offerToServer(params, run, record);
	return { checkpoint, created: true, server, skipped: snap.skipped, file_count: record.file_count };
}

type SeqDecision = { kind: "found"; found: LocalCheckpoint } | { kind: "new"; seq: number; last: LocalCheckpoint | undefined };

/** What a request for `requested` (or the next seq) means given the checkpoints that exist: an existing checkpoint, or the seq to make and the one it follows. */
function decideSeq(all: readonly LocalCheckpoint[], sessionId: string, requested: number | undefined): SeqDecision {
	const existing = checkpointsOfSession(all, sessionId);
	const last = existing[existing.length - 1];
	const highest = last?.seq ?? 0;
	if (requested !== undefined) {
		if (!Number.isSafeInteger(requested) || requested < 1) throw new CheckpointError("invalid-input", "seq must be a positive integer");
		const found = existing.find((checkpoint) => checkpoint.seq === requested);
		if (found !== undefined) return { kind: "found", found };
		if (requested <= highest) throw new CheckpointError("seq-conflict", `seq ${requested} is not taken but the session is already at seq ${highest}`);
	}
	return { kind: "new", seq: requested ?? highest + 1, last };
}

/** The worktree's own git directory (per linked worktree, like the checkpoint scope), where the checkpoint lock lives. */
async function resolveGitDir(worktree: string, run: Runner): Promise<string> {
	const result = await run(["git", "-C", worktree, "rev-parse", "--absolute-git-dir"]);
	const gitDir = result.code === 0 ? result.stdout.toString("utf8").trim() : "";
	if (gitDir.length === 0) throw new GitCommandError("cannot resolve the git directory of the worktree");
	return realpathSync(gitDir);
}

async function offerExisting(params: CreateCheckpointParams, run: Runner, found: LocalCheckpoint): Promise<CheckpointResult> {
	const snap = await readPinnedSnapshot({ worktree: params.worktree, ref: found.ref, now: params.now, run });
	const pinnedMs = found.taken_at_ms ?? Date.parse(found.createdAt);
	const takenAt = Number.isSafeInteger(pinnedMs) && pinnedMs > 0 ? pinnedMs : undefined;
	const record: CheckpointRecord = {
		ckpt_id: found.ckpt_id,
		seq: found.seq,
		trigger: found.trigger,
		git_tree: found.tree,
		manifest_sha256: snap.manifestSha256,
		file_count: found.file_count ?? snap.entries.length,
		skipped_count: found.skipped_count ?? 0,
		...(found.transcript_ref === undefined ? {} : { transcript_ref: found.transcript_ref }),
		...(found.plan_ref === undefined ? {} : { plan_ref: found.plan_ref }),
		...(found.prev_ckpt_id === undefined ? {} : { prev_ckpt_id: found.prev_ckpt_id }),
		// A checkpoint pinned before the field existed has only its commit time (whole seconds, never later than the pin); an epoch commit time means unknown and is left out.
		...(takenAt === undefined ? {} : { taken_at_ms: takenAt }),
	};
	const server = await offerToServer(params, run, record);
	return { checkpoint: found, created: false, server, skipped: [], file_count: record.file_count };
}

/** Record with the server; on any failure journal it. Never throws. */
async function offerToServer(params: CreateCheckpointParams, run: Runner, record: CheckpointRecord): Promise<CheckpointServerStatus> {
	const result = await params.client.recordCheckpoint({ ...record, session_id: params.sessionId });
	if (result.ok) return { status: "recorded", event_id: result.value.event_id, stored: result.value.stored };
	const { code, message } = result.error;
	try {
		const dir = params.pendingDir ?? (await resolvePendingDir(params.worktree, run));
		writePending(dir, {
			version: 1,
			kind: "checkpoint",
			id: record.ckpt_id,
			session_id: params.sessionId,
			surface: params.surface,
			queued_at: params.now().toISOString(),
			attempts: 1,
			last_error: `${code}: ${message}`.slice(0, 300),
			record,
		});
		return { status: "pending", code, message };
	} catch (error) {
		// The local checkpoint stands either way; report that the ledger will not hear of it until it is re-offered.
		const journalError = error instanceof PendingJournalError ? error.message : "the pending journal could not be written";
		return { status: "unrecorded", code, message, journal_error: journalError };
	}
}
