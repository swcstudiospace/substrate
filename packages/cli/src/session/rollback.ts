/**
 * Roll a worktree back to a local checkpoint and record it in the ledger (v1.6, phase 61). The server
 * never touches a worktree: this module does every file operation through `@substrate/worktree-snapshot`
 * and only reports ids, digests and counts.
 *
 * Flow, in order:
 *  1. `recoverRestore`: finish any restore a crashed process left behind, and report it. Every run starts
 *     here, so the worktree is never left half restored without anyone being told.
 *  2. Resolve the target from the LOCAL checkpoint registry (the pinned refs): a ckpt id, a seq number, or
 *     `previous` (the session's newest checkpoint). An unknown target, or one that belongs to another
 *     session, is refused.
 *  3. Ask the server for a plan (unless `offline`). An unreachable server is not an error: the rollback
 *     goes on from the local refs, reports the checkpoint as UNANCHORED, and queues its ledger commit.
 *     An anchor status `mismatch`, or a ledger record that disagrees with the local ref, refuses.
 *  4. `planRestore`: the exact changes and counts. A dry run stops here and changes nothing.
 *  5. Drift (the worktree is not at any checkpoint of the session: it matches none of their trees, so it
 *     differs from the newest one by changes no checkpoint holds) refuses unless `force`. Right after a
 *     rollback the worktree IS at the target's tree, so rolling back again is not drift. Refusals are
 *     reported to the server, fail-open.
 *  6. Take a `pre-restore` checkpoint of the current state BEFORE any file is touched.
 *  7. `restore()` with the drift tree. On failure the outcome is reported honestly: rolled back or not,
 *     the safety ref, and the command that recovers.
 *  8. The transcript step, through the injected `TranscriptPort`. The port never rewrites a transcript;
 *     it moves a leaf or leaves a marker and says which.
 *  9. `session_rollback_commit` with the plan digest. `stale-plan` re-plans ONCE; a second change stops.
 *     Whenever the ledger commit cannot be delivered the files stay as restored and the commit is queued
 *     in the pending journal (status `commit-pending`, exit 4), delivered later by `substrate session sync`.
 */
import {
	type RandomBytes,
	type RollbackRefusalReason,
	type RollbackTranscriptOutcome,
	type TranscriptRef,
	ROLLBACK_REFUSAL_REASONS,
	ROLLBACK_TRANSCRIPT_OUTCOMES,
	newRollbackId,
} from "../../../mcp-server/src/session-events.ts";
import {
	type Clock,
	type RestoreHooks,
	type RestoreOperation,
	type RestorePlan,
	type RestoreResult,
	type Runner,
	type Snapshot,
	type SnapshotPolicy,
	GitCommandError,
	RestoreDriftError,
	RestoreFailedError,
	RestoreRecoveryRequiredError,
	SimulatedCrash,
	WorktreeBusyError,
	WorktreeSnapshotError,
	planRestore,
	readPinnedSnapshot,
	snapshot,
	recoverRestore,
	restore,
	spawnRunner,
} from "../../../worktree-snapshot/src/index.ts";
import {
	type AnchorStatus,
	CKPT_ID_PATTERN,
	type CommitRollbackOk,
	type CommittedRollbackFields,
	ROLLBACK_ID_PATTERN,
	type RollbackPlan,
	type RollbackServerClient,
	isUnreachable,
	offlineClient,
} from "./client.ts";
import {
	type CheckpointResult,
	type CheckpointServerStatus,
	type LocalCheckpoint,
	type LocalCheckpoints,
	checkpointsOfSession,
	createCheckpoint,
	listLocalCheckpoints,
} from "./checkpoint.ts";
import { PendingJournalError, resolvePendingDir, writePending } from "./pending.ts";

/** The command to run when a restore was interrupted or could not be rolled back. */
export const RECOVER_COMMAND = "substrate session recover";

const MAX_PLAN_OPERATIONS_SHOWN = 200;
const MAX_DRIFT_SHOWN = 50;
const MAX_DETAIL_CHARS = 200;

// ---------------------------------------------------------------------------
// Transcript port
// ---------------------------------------------------------------------------

export interface TranscriptRewindRequest {
	sessionId: string;
	surface: string;
	rollbackId: string;
	targetCkptId: string;
	/** The target checkpoint's transcript pointer, when it has one. */
	transcriptRef?: TranscriptRef;
}

export interface TranscriptRewindResult {
	outcome: RollbackTranscriptOutcome;
	detail?: string;
}

/** The transcript half of a rollback. Implemented per surface; it never rewrites a transcript. */
export interface TranscriptPort {
	rewind(request: TranscriptRewindRequest): Promise<TranscriptRewindResult>;
}

/** The port for a surface with no transcript adapter: the outcome is `unsupported` and the files are still restored. */
export const unsupportedTranscriptPort: TranscriptPort = {
	rewind: async () => ({ outcome: "unsupported", detail: "no transcript adapter is wired for this surface; only the files were rolled back" }),
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type RollbackStatus = "dry-run" | "committed" | "commit-pending" | "refused" | "failed";

export interface OperationSummary {
	op: RestoreOperation["op"];
	path: string;
}

export interface PlanSummary {
	counts: { add: number; modify: number; delete: number; chmod: number; retype: number; total: number };
	operations: OperationSummary[];
	operations_truncated: boolean;
	drift_count: number;
	drift: OperationSummary[];
	ignored_count: number;
}

export interface RecoveredInfo {
	id: string;
	direction: "forward" | "rollback";
	files: { added: number; modified: number; deleted: number };
	safety_ref: string;
}

export interface FailureInfo {
	code: string;
	message: string;
	/** Whether any path was touched; null when unknown. */
	modified: boolean | null;
	/** Whether the pre-restore state was put back and verified; null when unknown. */
	rolled_back: boolean | null;
	safety_ref: string | null;
	/** The command that finishes or undoes an interrupted restore, or null when none is needed. */
	recover: string | null;
}

export type LedgerState = "committed" | "pending" | "not-recorded" | "not-attempted" | "refusal-recorded" | "refusal-not-recorded";

export interface LedgerInfo {
	state: LedgerState;
	event_id?: string;
	message?: string;
}

export interface AnchorInfo {
	status: AnchorStatus;
	reasons: string[];
	/** `server`: from the plan. `local`: no plan was obtained, so nothing is known to be anchored. */
	source: "server" | "local";
}

export interface RollbackResult {
	status: RollbackStatus;
	session_id: string;
	rollback_id: string | null;
	target: { ckpt_id: string; seq: number; trigger: string } | null;
	/** `local-only`: the rollback ran from local refs without a server plan. */
	mode: "server" | "local-only";
	local_only_reason?: "offline" | "server-unreachable";
	anchor: AnchorInfo | null;
	recovered: RecoveredInfo | null;
	plan?: PlanSummary;
	/** Dry run only: the reasons a real run would refuse. */
	blocked_by?: RollbackRefusalReason[];
	refusal?: { reason: RollbackRefusalReason; detail: string };
	failure?: FailureInfo;
	pre_restore?: { ckpt_id: string; tree: string; server: CheckpointServerStatus["status"] };
	restore?: { safety_ref: string; files: { added: number; modified: number; deleted: number }; operations_total: number };
	transcript?: TranscriptRewindResult;
	memory_preview?: RollbackPlan["memory"];
	memory?: CommitRollbackOk["memory"];
	ledger: LedgerInfo;
	warnings: string[];
}

export type RollbackInputErrorCode = "invalid-target" | "invalid-session";

export class RollbackInputError extends Error {
	readonly code: RollbackInputErrorCode;
	constructor(code: RollbackInputErrorCode, message: string) {
		super(message);
		this.name = "RollbackInputError";
		this.code = code;
	}
}

export interface RollbackParams {
	worktree: string;
	sessionId: string;
	/** A ckpt id, a seq number (or its decimal string), or `previous`. */
	target: string | number;
	dryRun: boolean;
	force: boolean;
	offline: boolean;
	surface: string;
	client: RollbackServerClient;
	transcript: TranscriptPort;
	now: Clock;
	randomBytes: RandomBytes;
	run?: Runner;
	pendingDir?: string;
	policy?: SnapshotPolicy;
	/** Test seam, passed to `restore` (a thrown SimulatedCrash simulates a dead process). */
	hooks?: RestoreHooks;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function summarisePlan(plan: RestorePlan): PlanSummary {
	const shown = (operations: readonly RestoreOperation[], max: number): OperationSummary[] =>
		operations.slice(0, max).map((operation) => ({ op: operation.op, path: operation.path }));
	return {
		counts: { ...plan.counts },
		operations: shown(plan.operations, MAX_PLAN_OPERATIONS_SHOWN),
		operations_truncated: plan.operations.length > MAX_PLAN_OPERATIONS_SHOWN,
		drift_count: plan.drift.length,
		drift: shown(plan.drift, MAX_DRIFT_SHOWN),
		ignored_count: plan.ignored.length,
	};
}

/** What the ledger records as file counts: a mode change or a type change is a modification. */
function filesOf(counts: RestorePlan["counts"]): { added: number; modified: number; deleted: number } {
	return { added: counts.add, modified: counts.modify + counts.chmod + counts.retype, deleted: counts.delete };
}

type Resolution = { ok: true; checkpoint: LocalCheckpoint } | { ok: false; reason: RollbackRefusalReason; detail: string; ckptId?: string };

function resolveTarget(target: string | number, all: readonly LocalCheckpoint[], mine: readonly LocalCheckpoint[]): Resolution {
	const text = String(target).trim();
	if (text === "previous") {
		const newest = mine[mine.length - 1];
		return newest === undefined
			? { ok: false, reason: "target-not-found", detail: "this session has no local checkpoint to go back to" }
			: { ok: true, checkpoint: newest };
	}
	if (/^[0-9]+$/.test(text)) {
		const seq = Number(text);
		const found = Number.isSafeInteger(seq) ? mine.find((checkpoint) => checkpoint.seq === seq) : undefined;
		return found === undefined
			? { ok: false, reason: "target-not-found", detail: `this session has no local checkpoint with seq ${text}` }
			: { ok: true, checkpoint: found };
	}
	if (CKPT_ID_PATTERN.test(text)) {
		const found = all.find((checkpoint) => checkpoint.ckpt_id === text);
		if (found === undefined) return { ok: false, reason: "target-not-found", detail: `no local checkpoint ${text}`, ckptId: text };
		if (!mine.includes(found)) return { ok: false, reason: "not-authorized", detail: `checkpoint ${text} belongs to another session`, ckptId: text };
		return { ok: true, checkpoint: found };
	}
	throw new RollbackInputError("invalid-target", "the target must be a checkpoint id (ckpt_...), a seq number, or `previous`");
}

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

export async function rollback(params: RollbackParams): Promise<RollbackResult> {
	const run = params.run ?? spawnRunner;
	const { sessionId, surface } = params;
	if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 512) {
		throw new RollbackInputError("invalid-session", "the session id must be a non-empty string of at most 512 characters");
	}
	let rollbackId = newRollbackId(params.randomBytes);
	const warnings: string[] = [];
	const out: RollbackResult = {
		status: "failed",
		session_id: sessionId,
		rollback_id: rollbackId,
		target: null,
		mode: "server",
		anchor: null,
		recovered: null,
		ledger: { state: "not-attempted" },
		warnings,
	};
	let client: RollbackServerClient = params.offline ? offlineClient() : params.client;
	let plan: RollbackPlan | null = null;

	const failed = (code: string, message: string, extra: Partial<FailureInfo> = {}): RollbackResult => {
		out.status = "failed";
		out.failure = { code, message, modified: null, rolled_back: null, safety_ref: null, recover: null, ...extra };
		return out;
	};

	/** Refuse, and tell the server unless this is offline: fail-open, the refusal stands either way. */
	const refuse = async (reason: RollbackRefusalReason, detail: string, ckptId?: string): Promise<RollbackResult> => {
		out.status = "refused";
		out.refusal = { reason, detail: detail.slice(0, MAX_DETAIL_CHARS) };
		const targetId = ckptId ?? out.target?.ckpt_id;
		if (params.dryRun || params.offline || out.mode === "local-only" || targetId === undefined) return out;
		const reported = await client.commitRollback({
			session_id: sessionId,
			rollback_id: rollbackId,
			target_ckpt_id: targetId,
			...(plan === null ? {} : { plan_digest: plan.plan_digest }),
			outcome: "refused",
			reason,
			detail: out.refusal.detail,
		});
		out.ledger = reported.ok
			? { state: "refusal-recorded", event_id: reported.value.event_id }
			: { state: "refusal-not-recorded", message: `${reported.error.code}: ${reported.error.message}` };
		return out;
	};

	// 1. Finish an interrupted restore first, so the worktree is whole before anything else is decided.
	try {
		const recovered = await recoverRestore({ worktree: params.worktree, now: params.now, run });
		if (recovered.recovered) {
			out.recovered = { id: recovered.id, direction: recovered.direction, files: filesOf(recovered.counts), safety_ref: recovered.safetyRef };
			warnings.push(
				recovered.direction === "forward"
					? `an interrupted restore (${recovered.id}) was completed before this run`
					: `an interrupted rollback (${recovered.id}) was completed before this run: the worktree is back at its state before that restore`,
			);
		}
	} catch (error) {
		if (error instanceof SimulatedCrash) throw error;
		// A worktree that is not a git repository (or a broken git) fails here before any restore is involved.
		if (error instanceof GitCommandError) return failed("git-failed", messageOf(error));
		return failed("recovery-failed", `an interrupted restore could not be recovered: ${messageOf(error)}`, restoreFailureFields(error));
	}

	// 2. The target, from the local registry.
	let local: LocalCheckpoints;
	try {
		local = await listLocalCheckpoints({ worktree: params.worktree, run, now: params.now });
	} catch (error) {
		return failed("checkpoint-registry-failed", messageOf(error));
	}
	const mine = checkpointsOfSession(local.checkpoints, sessionId);
	const resolved = resolveTarget(params.target, local.checkpoints, mine);
	if (!resolved.ok) return refuse(resolved.reason, resolved.detail, resolved.ckptId);
	const target = resolved.checkpoint;
	// The baseline the worktree is compared with: the session's newest checkpoint whose tree the worktree has
	// now, else its newest checkpoint. Changes since the baseline are drift.
	let baseline: LocalCheckpoint;
	try {
		const current = await snapshot({ worktree: params.worktree, policy: params.policy, now: params.now, run });
		baseline = [...mine].reverse().find((checkpoint) => checkpoint.tree === current.tree) ?? mine[mine.length - 1] ?? target;
	} catch (error) {
		return failed("snapshot-failed", `the worktree could not be snapshotted: ${messageOf(error)}`);
	}
	out.target = { ckpt_id: target.ckpt_id, seq: target.seq, trigger: target.trigger };

	let targetSnapshot: Snapshot;
	try {
		targetSnapshot = await readPinnedSnapshot({ worktree: params.worktree, ref: target.ref, now: params.now, run });
	} catch (error) {
		return failed("target-unreadable", `the checkpoint ${target.ckpt_id} cannot be read: ${messageOf(error)}`);
	}

	// 3. The server's plan, or the local-only fallback.
	if (params.offline) {
		out.mode = "local-only";
		out.local_only_reason = "offline";
	} else {
		const planned = await client.planRollback({ session_id: sessionId, target_ckpt_id: target.ckpt_id, rollback_id: rollbackId });
		if (planned.ok) {
			plan = planned.value.plan;
		} else if (isUnreachable(planned.error)) {
			out.mode = "local-only";
			out.local_only_reason = "server-unreachable";
			client = offlineClient();
			warnings.push(`the server could not be reached (${planned.error.code}); rolling back from the local checkpoint, which is unanchored`);
		} else if (planned.error.code === "unauthorized") {
			return refuse("not-authorized", `${planned.error.message} (use --offline to roll back from the local checkpoint without the server)`);
		} else if ((ROLLBACK_REFUSAL_REASONS as readonly string[]).includes(planned.error.code)) {
			return refuse(planned.error.code as RollbackRefusalReason, planned.error.message);
		} else {
			return failed(planned.error.code, `the server could not plan the rollback: ${planned.error.message} (use --offline to roll back from the local checkpoint)`);
		}
	}
	if (plan !== null) {
		if (plan.session_id !== sessionId || plan.target.ckpt_id !== target.ckpt_id) {
			return failed("bad-plan", "the server answered with a plan for a different session or checkpoint");
		}
		if (plan.target.git_tree !== target.tree || plan.target.manifest_sha256 !== targetSnapshot.manifestSha256) {
			return refuse("hash-mismatch", "the local checkpoint does not match the ledger record of it; it may have been altered");
		}
		if (ROLLBACK_ID_PATTERN.test(plan.rollback_id)) rollbackId = plan.rollback_id;
		out.rollback_id = rollbackId;
		out.anchor = plan.anchor === null
			? { status: "unverified", reasons: ["the server returned no anchor status"], source: "server" }
			: { status: plan.anchor.status, reasons: plan.anchor.reasons, source: "server" };
		out.memory_preview = plan.memory;
	} else {
		out.anchor = {
			status: "unanchored",
			reasons: [out.local_only_reason === "offline" ? "offline: the ledger was not consulted" : "the server was unreachable: the ledger was not consulted"],
			source: "local",
		};
	}
	const anchor: AnchorInfo = out.anchor;

	// 4. The exact local plan.
	let restorePlan: RestorePlan;
	try {
		restorePlan = await planRestore({ worktree: params.worktree, target: targetSnapshot, expectedCurrentTree: baseline.tree, policy: params.policy, now: params.now, run });
	} catch (error) {
		return failed("plan-failed", messageOf(error));
	}
	out.plan = summarisePlan(restorePlan);

	const blockers: Array<{ reason: RollbackRefusalReason; detail: string }> = [];
	if (anchor.status === "mismatch" && plan !== null) {
		const why = anchor.reasons.join("; ") || "the on-chain root does not match the ledger";
		if (params.force) warnings.push(`anchor mismatch overridden by --force: ${why}`);
		else blockers.push({ reason: "hash-mismatch", detail: `the checkpoint's anchor does not verify (${why}); pass --force to override` });
	}
	if (restorePlan.drift.length > 0) {
		const detail = `the worktree is not at any checkpoint of this session: ${restorePlan.drift.length} path(s) changed since the newest one; run \`substrate session checkpoint\` first or pass --force`;
		if (params.force) warnings.push(`drift overridden by --force: ${restorePlan.drift.length} path(s) changed outside any checkpoint`);
		else blockers.push({ reason: "drift-detected", detail });
	}

	// 5. A dry run reports and stops: it writes nothing, neither files nor ledger.
	if (params.dryRun) {
		out.status = "dry-run";
		out.blocked_by = blockers.map((blocker) => blocker.reason);
		return out;
	}
	const firstBlocker = blockers[0];
	if (firstBlocker !== undefined) return refuse(firstBlocker.reason, firstBlocker.detail);

	// 6. The pre-restore checkpoint, before any file is touched.
	let pre: CheckpointResult;
	try {
		pre = await createCheckpoint({
			worktree: params.worktree,
			sessionId,
			trigger: "pre-restore",
			surface,
			client,
			now: params.now,
			randomBytes: params.randomBytes,
			run,
			pendingDir: params.pendingDir,
			policy: params.policy,
		});
	} catch (error) {
		return failed("pre-restore-failed", `the pre-restore checkpoint could not be taken; no file was changed: ${messageOf(error)}`, { modified: false });
	}
	out.pre_restore = { ckpt_id: pre.checkpoint.ckpt_id, tree: pre.checkpoint.tree, server: pre.server.status };
	if (pre.server.status !== "recorded") {
		warnings.push(`the pre-restore checkpoint is local only for now (${pre.server.code}); it is in the pending journal`);
		if (isUnreachable({ code: pre.server.code, message: "", retryable: true })) client = offlineClient();
	}

	// 7. The restore.
	let restored: RestoreResult;
	try {
		restored = await restore({
			worktree: params.worktree,
			target: targetSnapshot,
			id: rollbackId,
			expectedCurrentTree: baseline.tree,
			force: params.force,
			policy: params.policy,
			now: params.now,
			run,
			hooks: params.hooks,
		});
	} catch (error) {
		if (error instanceof SimulatedCrash) throw error;
		if (error instanceof RestoreDriftError) return refuse("drift-detected", error.message);
		if (error instanceof WorktreeBusyError) return refuse("session-busy", error.message);
		if (error instanceof RestoreRecoveryRequiredError) {
			return failed(error.code, `${error.message}; run \`${RECOVER_COMMAND}\``, { recover: RECOVER_COMMAND });
		}
		const fields = restoreFailureFields(error);
		const code = error instanceof WorktreeSnapshotError ? error.code : "unexpected";
		return failed(code, messageOf(error), fields);
	}
	const files = filesOf(restored.plan.counts);
	out.restore = { safety_ref: restored.safetyRef, files, operations_total: restored.plan.counts.total };

	// 8. The transcript. The files are already restored, so a failing port must not undo or fail the rollback.
	let transcript: TranscriptRewindResult;
	try {
		transcript = await params.transcript.rewind({
			sessionId,
			surface,
			rollbackId,
			targetCkptId: target.ckpt_id,
			...(target.transcript_ref === undefined ? {} : { transcriptRef: target.transcript_ref }),
		});
		if (!(ROLLBACK_TRANSCRIPT_OUTCOMES as readonly string[]).includes(transcript.outcome)) {
			transcript = { outcome: "unsupported", detail: "the transcript adapter returned an unknown outcome" };
		}
	} catch (error) {
		transcript = { outcome: "unsupported", detail: `the transcript adapter failed: ${messageOf(error).slice(0, MAX_DETAIL_CHARS)}` };
		warnings.push("the transcript step failed; the files were restored and the ledger records the transcript as unsupported");
	}
	out.transcript = transcript;

	// 9. The ledger commit.
	const fields: CommittedRollbackFields = {
		from_ckpt_id: baseline.ckpt_id,
		pre_restore_tree: pre.checkpoint.tree,
		pre_restore_ckpt_id: pre.checkpoint.ckpt_id,
		files,
		transcript: transcript.outcome,
		...(plan === null ? { local_only: true } : {}),
	};
	let digest: string | null = plan?.plan_digest ?? null;
	let lastError: { code: string; message: string } | null = null;
	if (plan === null || out.mode === "local-only") {
		lastError = { code: "offline", message: "no plan was obtained from the server" };
	} else {
		for (let attempt = 0; digest !== null && attempt < 2; attempt++) {
			const committed = await client.commitRollback({
				session_id: sessionId,
				rollback_id: rollbackId,
				target_ckpt_id: target.ckpt_id,
				plan_digest: digest,
				outcome: "committed",
				...fields,
			});
			if (committed.ok) {
				out.status = "committed";
				out.ledger = { state: "committed", event_id: committed.value.event_id };
				if (committed.value.memory !== undefined) out.memory = committed.value.memory;
				return out;
			}
			lastError = committed.error;
			if (committed.error.code !== "stale-plan") break;
			if (attempt === 1) {
				digest = null;
				lastError = { code: "stale-plan", message: "the plan changed again after one re-plan" };
				break;
			}
			const replanned = await client.planRollback({ session_id: sessionId, target_ckpt_id: target.ckpt_id, rollback_id: rollbackId });
			if (!replanned.ok) {
				lastError = replanned.error;
				break;
			}
			plan = replanned.value.plan;
			digest = plan.plan_digest;
			out.memory_preview = plan.memory;
		}
	}

	// The files stay as restored; the ledger commit is queued so `substrate session sync` can deliver it.
	out.status = "commit-pending";
	const reason = lastError ?? { code: "unknown", message: "the commit was not delivered" };
	try {
		const dir = params.pendingDir ?? (await resolvePendingDir(params.worktree, run));
		writePending(dir, {
			version: 1,
			kind: "rollback",
			id: rollbackId,
			session_id: sessionId,
			surface,
			queued_at: params.now().toISOString(),
			attempts: 1,
			last_error: `${reason.code}: ${reason.message}`.slice(0, 300),
			commit: { target_ckpt_id: target.ckpt_id, plan_digest: digest, ...fields },
		});
		out.ledger = { state: "pending", message: `${reason.code}: ${reason.message}` };
	} catch (error) {
		const detail = error instanceof PendingJournalError ? error.message : "the pending journal could not be written";
		out.ledger = { state: "not-recorded", message: `${reason.code}: ${reason.message}; and the commit could not be queued (${detail})` };
	}
	return out;
}

/** The fields a restore failure carries, when it is one the library reports. */
function restoreFailureFields(error: unknown): Partial<FailureInfo> {
	if (error instanceof RestoreFailedError) {
		return {
			modified: error.modified,
			rolled_back: error.rolledBack,
			safety_ref: error.safetyRef,
			recover: error.modified && !error.rolledBack ? RECOVER_COMMAND : null,
		};
	}
	return {};
}
