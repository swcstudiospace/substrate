/**
 * The server half of session checkpoints and rollback (v1.6, phase 61): the logic behind the MCP tools
 * `session_checkpoint`, `session_rollback_plan` and `session_rollback_commit`.
 *
 * The server NEVER touches a worktree and NEVER reads a transcript. It records ids, digests and counts in the
 * ledger (the `session.*` notes of `session-events.ts`), computes which memory a rollback would take out of force,
 * and takes it out of force (`memory-forget.ts`) when the client says the files were restored. The client does
 * every file operation.
 *
 * Every function here is dependency-injected (`SessionRollbackDeps`): the ledger reads, the event append, the
 * anchor check, the memory selection and the forget are ports, so the whole module is proved with fakes and no
 * network, clock or database. `service.ts` builds the ports (`Substrate.sessionCheckpoint`, `sessionRollbackPlan`
 * and `sessionRollbackCommit`).
 *
 * Results are `{ ok: true, ... }` or `{ ok: false, error: { code, message, retryable? } }`; a bad request, a missing
 * checkpoint, a stale plan and a ledger outage are all answers, never thrown. Codes:
 *
 * - `invalid-request`   the request is malformed (unknown key, bad id, missing digest)
 * - `invalid-payload`   the checkpoint or rollback fields break the `session-events.ts` contract
 * - `not-found`         no such checkpoint for this session on the caller's surface (a foreign surface's checkpoint
 *                       is never revealed, so it answers exactly like an unknown one)
 * - `conflict`          an id is already used by another surface or for another target
 * - `stale-plan`        the plan changed since the client asked; NOTHING was changed, plan again
 * - `ledger-down`       the ledger could not be read or written (retryable)
 * - `unavailable`       the memory index could not be read (retryable); nothing was changed
 * - `forget-incomplete` the memory forget stopped part way (retryable); the marks are idempotent
 *
 * The plan digest covers what the rollback decides (the rollback id, the session, the target checkpoint and its
 * event hash, and the entries that would be forgotten) and NOTHING the rollback itself creates: the client takes a
 * pre-restore checkpoint between planning and committing, and a digest over the checkpoint list would make every
 * rollback answer `stale-plan`.
 */
import { CHECKPOINT_VERIFY_STATUSES } from "./checkpoint-verify.ts";
import { sharedDeadline } from "./deadline.ts";
import { IdempotencyRefusal, InvalidEventError, canonicalJson, normalizeIdentifier, sha256Hex } from "./event.ts";
import {
	FORGET_ACTION,
	FORGET_PAYLOAD_ENTRY_IDS,
	ForgetError,
	MAX_ROLLBACK_SELECT_LIMIT,
	parseForgetPayload,
	type ForgetPayload,
	type ForgetReport,
	type ForgetRequest,
} from "./memory-forget.ts";
import { redact } from "./redact.ts";
import {
	ROLLBACK_REFUSAL_REASONS,
	ROLLBACK_TRANSCRIPT_OUTCOMES,
	SESSION_CHECKPOINT_ACTION,
	SESSION_ROLLBACK_ACTION,
	SessionEventError,
	buildCheckpointEvent,
	buildRollbackEvent,
	buildRollbackRefusedEvent,
	parseCheckpointPayload,
	parseRollbackPayload,
	type CheckpointPayload,
	type RefusedPayload,
	type RollbackPayload,
	type RollbackRefusalReason,
	type SessionEventDraft,
	type RollbackTranscriptOutcome,
	type TranscriptRef,
} from "./session-events.ts";
import type { EventInput, Surface, SubstrateEvent } from "./types.ts";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Checkpoints listed as `later_checkpoints`; the list is informational. */
export const MAX_LATER_CHECKPOINTS = 1_000;
/** Entry ids a plan shows. */
export const MAX_SAMPLE_IDS = 20;
/** Reasons and characters of an anchor verdict a plan carries. */
export const MAX_ANCHOR_REASONS = 20;
export const MAX_ANCHOR_REASON_CHARS = 200;
/** One forget call names at most this many entries, so its ledger note carries every id and a re-run can reproduce it. */
export const FORGET_BATCH_SIZE = FORGET_PAYLOAD_ENTRY_IDS;
/** Forget calls one commit may make: 100 batches cover the index's own selection cap (`MAX_ROLLBACK_SELECT_LIMIT`). */
export const MAX_FORGET_BATCHES = 100;
/** Earlier forget notes whose plane deletions one run retries. */
export const MAX_PLANE_RETRY_GROUPS = 20;
/** How long a plan waits for the anchor check before answering without it. */
export const DEFAULT_ANCHOR_TIMEOUT_MS = 4_000;

const MAX_SESSION_ID_CHARS = 512;
const MAX_MESSAGE_CHARS = 400;
const MAX_KEY_ECHO_CHARS = 64;
const CKPT_ID = /^ckpt_[0-9a-z]{26}$/;
const ROLLBACK_ID = /^rb_[0-9a-z]{26}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// ---------------------------------------------------------------------------
// Ports and result shapes
// ---------------------------------------------------------------------------

/** The notes of one session, newest first. `complete` is false when the bounded read stopped before the session's start. */
export interface SessionNotes {
	events: readonly SubstrateEvent[];
	complete: boolean;
}

/** One memory entry a rollback could forget: its id and the surface that wrote it. */
export interface RollbackEntryRef {
	id: string;
	writer: string;
}

/** The entries a selection found, and whether more matched than were returned. */
export interface EntrySelection {
	entries: readonly RollbackEntryRef[];
	truncated: boolean;
}

/** What the ledger append answers (`Substrate.emit`'s shape, narrowed to what is read). */
export interface EmitOutcome {
	event: { id: string; hash: string };
	stored: boolean;
	error?: string;
	deduplicated?: true;
}

export interface SessionRollbackDeps {
	/** The session's `note` events, newest first, payloads included. Throws when the ledger cannot be read. */
	readSessionNotes(sessionId: string): Promise<SessionNotes>;
	/** The newest event of the session (the ledger chain position), or null for an empty session. May throw: the caller treats that as unobservable. */
	chainHead(sessionId: string): Promise<{ event_id: string; hash: string } | null>;
	/** Append one event as the caller's surface. */
	emit(input: EventInput): Promise<EmitOutcome>;
	/** The anchor verdict of one checkpoint event. May throw or be slow: a plan answers without it. */
	verifyAnchor(eventId: string, sessionId: string, surface: Surface): Promise<{ status: string; reasons: readonly string[] }>;
	/** Entries of the session created strictly after `afterIso` and still in force (no index: none). Throws when the index cannot be read. */
	selectEntries(sessionId: string, afterIso: string): Promise<EntrySelection>;
	/** `Substrate.memoryForget`. */
	forget(request: ForgetRequest, caller: { surface: Surface; session_id: string }): Promise<ForgetReport>;
	/** Bound on the anchor check; 0 or less means unbounded. */
	anchorTimeoutMs: number;
}

/** Who is calling: the authenticated surface, and whether the token is an operator's. */
export interface RollbackCaller {
	surface: Surface;
	isOperator: boolean;
}

export type RollbackErrorCode =
	| "invalid-request"
	| "invalid-payload"
	| "not-found"
	| "conflict"
	| "stale-plan"
	| "ledger-down"
	| "unavailable"
	| "forget-incomplete";

export interface RollbackFailure {
	ok: false;
	error: {
		code: RollbackErrorCode;
		message: string;
		retryable?: true;
		/** `forget-incomplete`: what the stopped run had already done. */
		done?: { superseded_entries: number; forgotten_documents: number; plane_pending: boolean };
	};
}

export interface CheckpointOk {
	ok: true;
	ckpt_id: string;
	event_id: string;
	/** False when the checkpoint was already recorded (a replay): `event_id` is the existing one. */
	stored: boolean;
	/** A seq or `prev_ckpt_id` that disagrees with the session's newest recorded checkpoint, or a collision handled by not trusting the idempotency key. Never a failure. */
	warnings?: string[];
}
export type CheckpointResult = CheckpointOk | RollbackFailure;

export interface RollbackPlan {
	rollback_id: string;
	session_id: string;
	target: {
		ckpt_id: string;
		seq: number;
		event_id: string;
		event_hash: string;
		git_tree: string;
		manifest_sha256: string;
		transcript_ref?: TranscriptRef;
	};
	later_checkpoints: Array<{ ckpt_id: string; seq: number }>;
	anchor: { status: (typeof CHECKPOINT_VERIFY_STATUSES)[number]; reasons: string[] } | null;
	memory: { would_forget: number; sample_ids: string[]; truncated: boolean };
	plan_digest: string;
}
export type PlanResult = { ok: true; plan: RollbackPlan } | RollbackFailure;

export interface CommitOk {
	ok: true;
	event_id: string;
	memory?: { superseded_entries: number; forgotten_documents: number; plane_pending: boolean; truncated: boolean };
	/** True when this answer replays an earlier commit of the same rollback id: nothing was forgotten again. */
	replayed?: true;
}
export type CommitResult = CommitOk | RollbackFailure;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A refusal raised deep in a helper and answered at the public edge. */
class Refusal extends Error {
	constructor(readonly failure: RollbackFailure) {
		super(failure.error.message);
		this.name = "RollbackRefusal";
	}
}

const clip = (text: string, max = MAX_MESSAGE_CHARS): string => redact(text).slice(0, max);

function describe(cause: unknown): string {
	return clip(cause instanceof Error ? cause.message : String(cause), 300);
}

function failure(code: RollbackErrorCode, message: string, extra: Partial<RollbackFailure["error"]> = {}): RollbackFailure {
	return { ok: false, error: { code, message: clip(message), ...extra } };
}

function refuse(code: RollbackErrorCode, message: string, extra: Partial<RollbackFailure["error"]> = {}): never {
	throw new Refusal(failure(code, message, extra));
}

const RETRYABLE = { retryable: true } as const;

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** A plain JSON object whose keys are all in `allowed`. A hostile key is named only in a bounded, redacted form. */
function strictObject(input: unknown, allowed: readonly string[], what: string): Rec {
	if (!isPlainObject(input)) refuse("invalid-request", `${what} must be a JSON object`);
	for (const key of Object.keys(input)) {
		if (!allowed.includes(key)) refuse("invalid-request", `${what}: unknown key "${clip(key, MAX_KEY_ECHO_CHARS)}"; allowed: ${allowed.join(", ")}`);
	}
	return input;
}

function patternField(value: unknown, name: string, pattern: RegExp, what: string): string {
	if (typeof value !== "string") refuse("invalid-request", `${name} is required and must be a string`);
	if (!pattern.test(value)) refuse("invalid-request", `${name} must be ${what}`);
	return value;
}

const ckptIdField = (value: unknown, name: string): string => patternField(value, name, CKPT_ID, '"ckpt_" followed by 26 characters of 0-9 a-z');
const rollbackIdField = (value: unknown, name: string): string => patternField(value, name, ROLLBACK_ID, '"rb_" followed by 26 characters of 0-9 a-z');

/** A session id the ledger stores unchanged: non-empty, bounded, no control characters, and `normalizeIdentifier` leaves it as it is. */
function sessionIdField(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) refuse("invalid-request", "session_id is required and must be a non-empty string");
	if (value.length > MAX_SESSION_ID_CHARS) refuse("invalid-request", `session_id must be at most ${MAX_SESSION_ID_CHARS} characters`);
	if (CONTROL_CHARS.test(value)) refuse("invalid-request", "session_id must not contain control characters");
	if (normalizeIdentifier(value) !== value) refuse("invalid-request", "session_id is not a valid identifier (it would be altered by redaction or length limits)");
	return value;
}

function countField(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) refuse("invalid-request", `${name} must be a non-negative integer`);
	return value;
}

function ownedBy(event: SubstrateEvent, caller: RollbackCaller): boolean {
	return caller.isOperator || event.surface === caller.surface;
}

/** `new Set` of ids in first-seen order. */
function distinct(ids: readonly string[]): string[] {
	return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Reading the session
// ---------------------------------------------------------------------------

interface CheckpointRecord {
	event: SubstrateEvent;
	payload: CheckpointPayload;
}

async function readNotes(deps: SessionRollbackDeps, sessionId: string): Promise<SessionNotes> {
	try {
		return await deps.readSessionNotes(sessionId);
	} catch (cause) {
		return refuse("ledger-down", `the event ledger could not be read: ${describe(cause)}`, RETRYABLE);
	}
}

/** The stored payload without the ledger's reserved `_ik`. */
function storedPayload(event: SubstrateEvent): Rec {
	const { _ik: _dropped, ...rest } = event.payload;
	return rest;
}

/** Every well-formed `session.checkpoint` in `events`, in the order given (newest first). */
function checkpointsIn(events: readonly SubstrateEvent[]): CheckpointRecord[] {
	const out: CheckpointRecord[] = [];
	for (const event of events) {
		if (event.kind !== "note" || event.payload["action"] !== SESSION_CHECKPOINT_ACTION) continue;
		try {
			out.push({ event, payload: parseCheckpointPayload(storedPayload(event)) });
		} catch (cause) {
			// A note that claims the action but breaks the contract (an older writer, or one that bypassed the tool)
			// is not a checkpoint anyone can roll back to: skipped, never a failure of the request that found it.
			if (!(cause instanceof SessionEventError)) throw cause;
		}
	}
	return out;
}

function rollbackIn(events: readonly SubstrateEvent[], rollbackId: string): { event: SubstrateEvent; payload: RollbackPayload } | null {
	for (const event of events) {
		if (event.kind !== "note" || event.payload["action"] !== SESSION_ROLLBACK_ACTION || event.payload["rollback_id"] !== rollbackId) continue;
		try {
			return { event, payload: parseRollbackPayload(storedPayload(event)) };
		} catch (cause) {
			if (!(cause instanceof SessionEventError)) throw cause;
		}
	}
	return null;
}

/** The checkpoint `ckptId` of this session, emitted by the caller's surface (an operator: any). Absent and foreign answer alike. */
function resolveTarget(notes: SessionNotes, ckptId: string, caller: RollbackCaller): { target: CheckpointRecord; visible: CheckpointRecord[] } {
	const visible = checkpointsIn(notes.events).filter((record) => ownedBy(record.event, caller));
	const target = visible.find((record) => record.payload.ckpt_id === ckptId);
	if (target === undefined) {
		refuse(
			"not-found",
			`no checkpoint ${ckptId} was recorded for this session by your surface${notes.complete ? "" : " in the part of the session the ledger read covered (it is bounded)"}`,
		);
	}
	return { target, visible };
}

// ---------------------------------------------------------------------------
// session_checkpoint
// ---------------------------------------------------------------------------

/**
 * Record one checkpoint as a `session.checkpoint` note of the caller's surface, in the session's own hash chain.
 *
 * The ledger chain position (`chain_head`: the session's newest event at the time of the call) is attached by the
 * SERVER from the ledger, replacing anything the client sent: a pointer the server cannot observe is not evidence, so
 * when the head cannot be read it is left out. A checkpoint id already recorded in the session answers `stored: false`
 * with the existing event and writes nothing, whatever `SUBSTRATE_EVENT_IDEMPOTENCY` is. A seq or `prev_ckpt_id` that
 * contradicts the session's newest recorded checkpoint is a warning in the result, not a failure: a client may record
 * offline and late.
 */
export async function sessionCheckpoint(deps: SessionRollbackDeps, input: unknown, caller: RollbackCaller): Promise<CheckpointResult> {
	try {
		if (!isPlainObject(input)) return failure("invalid-request", "the request must be a JSON object");
		const { session_id: rawSession, ...rest } = input;
		const sessionId = sessionIdField(rawSession);
		let payload: CheckpointPayload;
		try {
			payload = parseCheckpointPayload({ action: SESSION_CHECKPOINT_ACTION, ...rest });
		} catch (cause) {
			if (cause instanceof SessionEventError) return failure("invalid-payload", cause.message);
			throw cause;
		}

		const notes = await readNotes(deps, sessionId);
		const known = checkpointsIn(notes.events);
		const same = known.find((record) => record.payload.ckpt_id === payload.ckpt_id);
		if (same !== undefined) {
			if (!ownedBy(same.event, caller)) {
				return failure("conflict", `checkpoint id ${payload.ckpt_id} is already recorded for this session by another surface`);
			}
			// Already recorded: the lookup, not the ledger's idempotency mode, makes a replay free.
			return { ok: true, ckpt_id: payload.ckpt_id, event_id: same.event.id, stored: false };
		}

		const warnings: string[] = [];
		const mine = known.filter((record) => ownedBy(record.event, caller));
		let newest: CheckpointRecord | undefined;
		for (const record of mine) if (newest === undefined || record.payload.seq > newest.payload.seq) newest = record;
		let keepKey = true;
		if (newest !== undefined) {
			if (payload.seq <= newest.payload.seq) {
				warnings.push(`seq ${payload.seq} does not follow the newest recorded checkpoint (seq ${newest.payload.seq}); recorded anyway`);
			}
			if (payload.prev_ckpt_id !== undefined && payload.prev_ckpt_id !== newest.payload.ckpt_id) {
				warnings.push(`prev_ckpt_id does not name the newest recorded checkpoint (${newest.payload.ckpt_id}); recorded anyway`);
			} else if (payload.prev_ckpt_id === undefined) {
				warnings.push(`no prev_ckpt_id although checkpoint ${newest.payload.ckpt_id} is already recorded; recorded anyway`);
			}
		}
		if (mine.some((record) => record.payload.seq === payload.seq)) {
			// The ledger's key for a checkpoint is (session, seq): under an idempotency mode it would answer this
			// DIFFERENT checkpoint with the other one's event and drop it. Recorded without a key instead.
			keepKey = false;
			warnings.push(`seq ${payload.seq} is already recorded for another checkpoint; recorded under its own event without an idempotency key`);
		}

		let head: { event_id: string; hash: string } | null = null;
		try {
			head = await deps.chainHead(sessionId);
		} catch {
			// Fail open: the chain position is evidence worth having, not a condition of recording the checkpoint.
			head = null;
		}

		const { action: _action, chain_head: _clientHead, ...fields } = payload;
		let draft: SessionEventDraft<CheckpointPayload>;
		try {
			draft = buildCheckpointEvent(sessionId, { ...fields, ...(head !== null ? { chain_head: head } : {}) });
		} catch (cause) {
			if (cause instanceof SessionEventError) return failure("invalid-payload", cause.message);
			throw cause;
		}

		let emitted: EmitOutcome;
		try {
			emitted = await deps.emit({
				surface: caller.surface,
				kind: draft.kind,
				summary: draft.summary,
				actor: "agent",
				session_id: sessionId,
				payload: { ...draft.payload },
				...(keepKey && draft.idempotency_key !== undefined ? { idempotency_key: draft.idempotency_key } : {}),
			});
		} catch (cause) {
			if (cause instanceof InvalidEventError || cause instanceof IdempotencyRefusal) return failure("invalid-payload", describe(cause));
			throw cause;
		}
		if (!emitted.stored) return failure("ledger-down", `the checkpoint was not recorded: ${clip(emitted.error ?? "the event ledger did not store it")}`, RETRYABLE);
		return {
			ok: true,
			ckpt_id: payload.ckpt_id,
			event_id: emitted.event.id,
			stored: emitted.deduplicated !== true,
			...(warnings.length > 0 ? { warnings } : {}),
		};
	} catch (cause) {
		if (cause instanceof Refusal) return cause.failure;
		throw cause;
	}
}

// ---------------------------------------------------------------------------
// session_rollback_plan
// ---------------------------------------------------------------------------

/** `rb_` plus 26 characters of 0-9 a-f: the same plan inputs always name the same rollback. */
export function deriveRollbackId(sessionId: string, targetCkptId: string, newestCkptId: string | null): string {
	return `rb_${sha256Hex(canonicalJson({ v: 1, session_id: sessionId, target: targetCkptId, newest: newestCkptId })).slice(0, 26)}`;
}

/**
 * The digest the commit must present. It covers the rollback id, the session, the target checkpoint and its event
 * hash, the sha256 of the sorted entry ids that would be forgotten, and their count. It does NOT cover the later
 * checkpoints or anything the rollback creates (see the module comment).
 */
export function rollbackPlanDigest(input: {
	rollbackId: string;
	sessionId: string;
	targetCkptId: string;
	targetEventHash: string;
	entryIds: readonly string[];
}): string {
	const sorted = [...new Set(input.entryIds)].sort();
	return sha256Hex(
		canonicalJson({
			v: 1,
			rollback_id: input.rollbackId,
			session_id: input.sessionId,
			target_ckpt_id: input.targetCkptId,
			target_event_hash: input.targetEventHash,
			forget_ids_sha256: sha256Hex(canonicalJson(sorted)),
			would_forget: sorted.length,
		}),
	);
}

async function anchorOf(deps: SessionRollbackDeps, target: CheckpointRecord, sessionId: string): Promise<RollbackPlan["anchor"]> {
	const deadline = sharedDeadline(deps.anchorTimeoutMs, "anchor verification");
	try {
		const verdict = await deadline.race(deps.verifyAnchor(target.event.id, sessionId, target.event.surface));
		const status = (CHECKPOINT_VERIFY_STATUSES as readonly string[]).includes(verdict.status) ? (verdict.status as (typeof CHECKPOINT_VERIFY_STATUSES)[number]) : null;
		if (status === null) return null;
		return { status, reasons: verdict.reasons.slice(0, MAX_ANCHOR_REASONS).map((reason) => clip(String(reason), MAX_ANCHOR_REASON_CHARS)) };
	} catch {
		// Fail open: the anchor verdict informs the client, it never blocks the plan (a slow devnet, an unconfigured
		// Solana or an unreadable ledger all leave `anchor: null`, which the client reports as unverified).
		return null;
	} finally {
		deadline.clear();
	}
}

interface PlanContext {
	sessionId: string;
	rollbackId: string;
	target: CheckpointRecord;
	visible: readonly CheckpointRecord[];
	notes: SessionNotes;
}

interface BuiltPlan {
	plan: RollbackPlan;
	/** Every entry that would be forgotten (the plan shows twenty). */
	entryIds: string[];
	truncated: boolean;
}

async function selectEntries(deps: SessionRollbackDeps, ctx: PlanContext, caller: RollbackCaller): Promise<{ ids: string[]; truncated: boolean }> {
	let selection: EntrySelection;
	try {
		selection = await deps.selectEntries(ctx.sessionId, ctx.target.event.ts);
	} catch (cause) {
		return refuse("unavailable", `the memory index could not be read, so the rollback's memory part cannot be planned: ${describe(cause)}`, RETRYABLE);
	}
	// Entries written by another surface in this session are not this caller's to forget (an operator may).
	const mine = selection.entries.filter((entry) => caller.isOperator || entry.writer === caller.surface);
	return { ids: distinct(mine.map((entry) => entry.id)), truncated: selection.truncated };
}

async function buildPlan(deps: SessionRollbackDeps, ctx: PlanContext, caller: RollbackCaller, withAnchor: boolean): Promise<BuiltPlan> {
	const { target } = ctx;
	const selected = await selectEntries(deps, ctx, caller);
	const later = ctx.visible
		.filter((record) => record.payload.seq > target.payload.seq)
		.sort((a, b) => a.payload.seq - b.payload.seq || (a.payload.ckpt_id < b.payload.ckpt_id ? -1 : 1))
		.slice(0, MAX_LATER_CHECKPOINTS)
		.map((record) => ({ ckpt_id: record.payload.ckpt_id, seq: record.payload.seq }));
	const plan: RollbackPlan = {
		rollback_id: ctx.rollbackId,
		session_id: ctx.sessionId,
		target: {
			ckpt_id: target.payload.ckpt_id,
			seq: target.payload.seq,
			event_id: target.event.id,
			event_hash: target.event.hash,
			git_tree: target.payload.git_tree,
			manifest_sha256: target.payload.manifest_sha256,
			...(target.payload.transcript_ref !== undefined ? { transcript_ref: target.payload.transcript_ref } : {}),
		},
		later_checkpoints: later,
		anchor: withAnchor ? await anchorOf(deps, target, ctx.sessionId) : null,
		memory: { would_forget: selected.ids.length, sample_ids: selected.ids.slice(0, MAX_SAMPLE_IDS), truncated: selected.truncated },
		plan_digest: rollbackPlanDigest({
			rollbackId: ctx.rollbackId,
			sessionId: ctx.sessionId,
			targetCkptId: target.payload.ckpt_id,
			targetEventHash: target.event.hash,
			entryIds: selected.ids,
		}),
	};
	return { plan, entryIds: selected.ids, truncated: selected.truncated };
}

function newestSeqRecord(records: readonly CheckpointRecord[]): CheckpointRecord | null {
	let newest: CheckpointRecord | null = null;
	for (const record of records) {
		if (newest === null || record.payload.seq > newest.payload.seq) newest = record;
	}
	return newest;
}

/**
 * Plan a rollback (read only): the target checkpoint (it must belong to the session and to the caller's surface),
 * the later checkpoints, the anchor verdict (fail open, bounded), the memory the rollback would forget, and the
 * digest the commit must present. Nothing is written.
 */
export async function sessionRollbackPlan(deps: SessionRollbackDeps, input: unknown, caller: RollbackCaller): Promise<PlanResult> {
	try {
		const rec = strictObject(input, ["session_id", "target_ckpt_id", "rollback_id"], "the request");
		const sessionId = sessionIdField(rec["session_id"]);
		const targetCkptId = ckptIdField(rec["target_ckpt_id"], "target_ckpt_id");
		const given = rec["rollback_id"] === undefined ? null : rollbackIdField(rec["rollback_id"], "rollback_id");
		const notes = await readNotes(deps, sessionId);
		const { target, visible } = resolveTarget(notes, targetCkptId, caller);
		const rollbackId = given ?? deriveRollbackId(sessionId, targetCkptId, newestSeqRecord(visible)?.payload.ckpt_id ?? null);
		const built = await buildPlan(deps, { sessionId, rollbackId, target, visible, notes }, caller, true);
		return { ok: true, plan: built.plan };
	} catch (cause) {
		if (cause instanceof Refusal) return cause.failure;
		throw cause;
	}
}

// ---------------------------------------------------------------------------
// session_rollback_commit
// ---------------------------------------------------------------------------

type CommittedRequest = {
	outcome: "committed";
	session_id: string;
	rollback_id: string;
	target_ckpt_id: string;
	plan_digest: string | null;
	from_ckpt_id: string;
	pre_restore_tree: string;
	pre_restore_ckpt_id: string;
	files: { added: number; modified: number; deleted: number };
	transcript: RollbackTranscriptOutcome;
	local_only: boolean;
};

type RefusedRequest = {
	outcome: "refused";
	session_id: string;
	rollback_id: string;
	target_ckpt_id: string;
	reason: RollbackRefusalReason;
	detail?: string;
};

const COMMON_KEYS = ["session_id", "rollback_id", "target_ckpt_id", "plan_digest", "outcome"] as const;
const COMMITTED_KEYS = [...COMMON_KEYS, "from_ckpt_id", "pre_restore_tree", "pre_restore_ckpt_id", "files", "transcript", "local_only"] as const;
const REFUSED_KEYS = [...COMMON_KEYS, "reason", "detail"] as const;

function parseCommit(input: unknown): CommittedRequest | RefusedRequest {
	if (!isPlainObject(input)) refuse("invalid-request", "the request must be a JSON object");
	const outcome = input["outcome"];
	if (outcome !== "committed" && outcome !== "refused") refuse("invalid-request", 'outcome is required and must be "committed" or "refused"');
	const rec = strictObject(input, outcome === "committed" ? COMMITTED_KEYS : REFUSED_KEYS, "the request");
	const session_id = sessionIdField(rec["session_id"]);
	const rollback_id = rollbackIdField(rec["rollback_id"], "rollback_id");
	const target_ckpt_id = ckptIdField(rec["target_ckpt_id"], "target_ckpt_id");
	const digest = rec["plan_digest"] === undefined || rec["plan_digest"] === null ? null : patternField(rec["plan_digest"], "plan_digest", HEX_64, "64 lowercase hex characters");
	if (outcome === "refused") {
		const reason = rec["reason"];
		if (typeof reason !== "string" || !(ROLLBACK_REFUSAL_REASONS as readonly string[]).includes(reason)) {
			return refuse("invalid-request", `reason is required and must be one of: ${ROLLBACK_REFUSAL_REASONS.join(", ")}`);
		}
		let detail: string | undefined;
		if (rec["detail"] !== undefined) {
			if (typeof rec["detail"] !== "string" || rec["detail"].length === 0) refuse("invalid-request", "detail must be a non-empty string");
			// Redacted, stripped of anything path-shaped (a token with a slash) and cut BEFORE it becomes a payload: a refusal's
			// free text is the one place a file path or a secret could ride into the ledger.
			detail = redact(rec["detail"]).replace(/\S*[\\/]\S*/g, "[path]").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300).trim();
			if (detail.length === 0) detail = undefined;
		}
		return { outcome: "refused", session_id, rollback_id, target_ckpt_id, reason: reason as RollbackRefusalReason, ...(detail !== undefined ? { detail } : {}) };
	}
	const files = strictObject(rec["files"], ["added", "modified", "deleted"], "files");
	const transcript = rec["transcript"];
	if (typeof transcript !== "string" || !(ROLLBACK_TRANSCRIPT_OUTCOMES as readonly string[]).includes(transcript)) {
		refuse("invalid-request", `transcript is required and must be one of: ${ROLLBACK_TRANSCRIPT_OUTCOMES.join(", ")}`);
	}
	if (rec["local_only"] !== undefined && typeof rec["local_only"] !== "boolean") refuse("invalid-request", "local_only must be a boolean");
	return {
		outcome: "committed",
		session_id,
		rollback_id,
		target_ckpt_id,
		plan_digest: digest,
		from_ckpt_id: ckptIdField(rec["from_ckpt_id"], "from_ckpt_id"),
		pre_restore_tree: patternField(rec["pre_restore_tree"], "pre_restore_tree", /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "40 or 64 lowercase hex characters"),
		pre_restore_ckpt_id: ckptIdField(rec["pre_restore_ckpt_id"], "pre_restore_ckpt_id"),
		files: { added: countField(files["added"], "files.added"), modified: countField(files["modified"], "files.modified"), deleted: countField(files["deleted"], "files.deleted") },
		transcript: transcript as RollbackTranscriptOutcome,
		local_only: rec["local_only"] === true,
	};
}

async function commitRefused(deps: SessionRollbackDeps, request: RefusedRequest, caller: RollbackCaller): Promise<CommitResult> {
	let draft: SessionEventDraft<RefusedPayload>;
	try {
		draft = buildRollbackRefusedEvent({
			reason: request.reason,
			to_ckpt_id: request.target_ckpt_id,
			...(request.detail !== undefined ? { detail: request.detail } : {}),
		});
	} catch (cause) {
		if (cause instanceof SessionEventError) return failure("invalid-payload", cause.message);
		throw cause;
	}
	let emitted: EmitOutcome;
	try {
		emitted = await deps.emit({ surface: caller.surface, kind: draft.kind, summary: draft.summary, actor: "agent", session_id: request.session_id, payload: { ...draft.payload } });
	} catch (cause) {
		if (cause instanceof InvalidEventError || cause instanceof IdempotencyRefusal) return failure("invalid-payload", describe(cause));
		throw cause;
	}
	if (!emitted.stored) return failure("ledger-down", `the refusal was not recorded: ${clip(emitted.error ?? "the event ledger did not store it")}`, RETRYABLE);
	return { ok: true, event_id: emitted.event.id };
}

interface Totals {
	superseded: number;
	deleted: number;
	pending: number;
}

/** The `memory.forget` notes this caller's surface wrote for one rollback, newest first, parsed. */
function forgetNotesOf(events: readonly SubstrateEvent[], rollbackId: string, caller: RollbackCaller): ForgetPayload[] {
	const out: ForgetPayload[] = [];
	for (const event of events) {
		if (event.surface !== caller.surface || event.kind !== "note" || event.payload["action"] !== FORGET_ACTION || event.payload["rollback_id"] !== rollbackId) continue;
		try {
			out.push(parseForgetPayload(storedPayload(event)));
		} catch (cause) {
			if (!(cause instanceof ForgetError)) throw cause;
		}
	}
	return out;
}

/** What earlier runs of this rollback already did, from their forget notes: per forget call the most it ever superseded, and every document it deleted. */
function priorTotals(notes: readonly ForgetPayload[]): Totals {
	const perCall = new Map<string, number>();
	let deleted = 0;
	for (const note of notes) {
		const superseded = note.counts.marked + note.counts.already_forgotten;
		perCall.set(note.forget_id, Math.max(perCall.get(note.forget_id) ?? 0, superseded));
		deleted += note.plane.deleted;
	}
	let superseded = 0;
	for (const value of perCall.values()) superseded += value;
	return { superseded, deleted, pending: 0 };
}

/**
 * Retry the plane deletions earlier forget calls of this rollback left pending. A forget call is reproduced exactly
 * (same reason, entries, rollback and checkpoint ids, so the same forget id): the entries are already marked, so only
 * the plane deletion runs again. A call whose note could not carry every entry id cannot be reproduced and stays pending.
 */
async function retryPendingPlane(
	deps: SessionRollbackDeps,
	notes: readonly ForgetPayload[],
	sessionId: string,
	caller: RollbackCaller,
): Promise<{ pending: boolean; deleted: number }> {
	const latest = new Map<string, ForgetPayload>();
	for (const note of notes) if (!latest.has(note.forget_id)) latest.set(note.forget_id, note);
	let pending = false;
	let deleted = 0;
	let retried = 0;
	for (const note of latest.values()) {
		if (note.plane.pending === 0) continue;
		if (retried >= MAX_PLANE_RETRY_GROUPS || note.entry_ids.length !== note.entry_count) {
			pending = true;
			continue;
		}
		retried++;
		try {
			const report = await deps.forget(
				{
					reason: note.reason,
					entry_ids: note.entry_ids,
					actor: note.actor,
					session_id: sessionId,
					...(note.checkpoint_id !== undefined ? { checkpoint_id: note.checkpoint_id } : {}),
					...(note.rollback_id !== undefined ? { rollback_id: note.rollback_id } : {}),
				},
				{ surface: caller.surface, session_id: sessionId },
			);
			deleted += report.plane.deleted;
			if (report.plane_pending > 0) pending = true;
		} catch {
			// The retry is best effort and idempotent: the entries are already out of force, so a failing retry only
			// leaves the deletion pending, reported as such, and the next run tries again.
			pending = true;
		}
	}
	return { pending, deleted };
}

function tally(report: ForgetReport, into: Totals): void {
	for (const entry of report.entries) {
		if (entry.outcome === "marked" || (entry.outcome === "already_forgotten" && entry.forgotten_by === report.forget_id)) into.superseded++;
	}
	into.deleted += report.plane.deleted;
	into.pending += report.plane_pending;
}

/**
 * Forget every selected entry in batches of {@link FORGET_BATCH_SIZE}, selecting again while the selection was
 * truncated, under a hard cap on batches. A forget that throws or a cap that is hit stops the run and answers
 * `forget-incomplete`: what was marked stays marked (the marks are idempotent), so the retry is safe.
 */
async function forgetSelected(
	deps: SessionRollbackDeps,
	ctx: PlanContext,
	caller: RollbackCaller,
	first: BuiltPlan,
	done: Totals,
): Promise<{ run: Totals; truncated: boolean }> {
	const run: Totals = { superseded: 0, deleted: 0, pending: 0 };
	const attempted = new Set<string>();
	let ids = first.entryIds;
	let truncated = first.truncated;
	let batches = 0;
	const incomplete = (why: string): never =>
		refuse("forget-incomplete", `${why}; ${attempted.size} entries were handled before it stopped. Marks are idempotent: plan again and commit again to continue`, {
			...RETRYABLE,
			done: { superseded_entries: done.superseded + run.superseded, forgotten_documents: done.deleted + run.deleted, plane_pending: run.pending > 0 },
		});
	for (;;) {
		const fresh = ids.filter((id) => !attempted.has(id));
		if (fresh.length === 0) break;
		for (let at = 0; at < fresh.length; at += FORGET_BATCH_SIZE) {
			if (batches >= MAX_FORGET_BATCHES) incomplete(`the cap of ${MAX_FORGET_BATCHES} forget batches was reached`);
			const chunk = fresh.slice(at, at + FORGET_BATCH_SIZE);
			batches++;
			let report: ForgetReport;
			try {
				report = await deps.forget(
					{
						reason: "rollback",
						entry_ids: chunk,
						actor: "agent",
						session_id: ctx.sessionId,
						checkpoint_id: ctx.target.payload.ckpt_id,
						rollback_id: ctx.rollbackId,
					},
					{ surface: caller.surface, session_id: ctx.sessionId },
				);
			} catch (cause) {
				return incomplete(`the memory forget failed (${describe(cause)})`);
			}
			for (const id of chunk) attempted.add(id);
			tally(report, run);
		}
		if (!truncated) break;
		try {
			const again = await selectEntries(deps, ctx, caller);
			ids = again.ids;
			truncated = again.truncated;
		} catch (cause) {
			if (cause instanceof Refusal) return incomplete(cause.failure.error.message);
			throw cause;
		}
	}
	// A selection that is still truncated but offers nothing new (the entries left belong to other surfaces): reported, not looped on.
	return { run, truncated };
}

const inflight = new Map<string, Promise<CommitResult>>();

async function commitCommitted(deps: SessionRollbackDeps, request: CommittedRequest, caller: RollbackCaller): Promise<CommitResult> {
	const sessionId = request.session_id;
	const notes = await readNotes(deps, sessionId);

	// An earlier commit of this rollback id answers again without forgetting again (only a pending plane deletion is retried).
	const existing = rollbackIn(notes.events, request.rollback_id);
	if (existing !== null) {
		if (!ownedBy(existing.event, caller)) refuse("conflict", `rollback id ${request.rollback_id} is already used by another surface`);
		if (existing.payload.to_ckpt_id !== request.target_ckpt_id) refuse("conflict", `rollback id ${request.rollback_id} was already used for another target checkpoint`);
		const retry = await retryPendingPlane(deps, forgetNotesOf(notes.events, request.rollback_id, caller), sessionId, caller);
		return {
			ok: true,
			event_id: existing.event.id,
			memory: {
				superseded_entries: existing.payload.memory.superseded_entries,
				forgotten_documents: existing.payload.memory.forgotten_documents,
				plane_pending: retry.pending,
				truncated: false,
			},
			replayed: true,
		};
	}

	const { target, visible } = resolveTarget(notes, request.target_ckpt_id, caller);

	// Everything the event will say is validated BEFORE anything is forgotten: a payload that fails after the forget would strand it.
	try {
		buildRollbackEvent(sessionId, {
			rollback_id: request.rollback_id,
			from_ckpt_id: request.from_ckpt_id,
			to_ckpt_id: target.payload.ckpt_id,
			target_event_id: target.event.id,
			target_hash: target.event.hash,
			pre_restore_tree: request.pre_restore_tree,
			pre_restore_ckpt_id: request.pre_restore_ckpt_id,
			files_added: request.files.added,
			files_modified: request.files.modified,
			files_deleted: request.files.deleted,
			memory: { superseded_entries: 0, forgotten_documents: 0 },
			transcript: request.transcript,
		});
	} catch (cause) {
		if (cause instanceof SessionEventError) return failure("invalid-payload", cause.message);
		throw cause;
	}
	if (request.plan_digest === null) {
		return failure("invalid-request", "plan_digest is required for a committed rollback: call session_rollback_plan first and present its plan_digest");
	}

	const ctx: PlanContext = { sessionId, rollbackId: request.rollback_id, target, visible, notes };
	const planned = await buildPlan(deps, ctx, caller, false);
	if (planned.plan.plan_digest !== request.plan_digest) {
		return failure("stale-plan", "the plan changed since it was computed (the target, or the memory the rollback would forget); nothing was changed: call session_rollback_plan again");
	}

	const earlier = forgetNotesOf(notes.events, request.rollback_id, caller);
	const prior = priorTotals(earlier);
	const retried = await retryPendingPlane(deps, earlier, sessionId, caller);
	const { run, truncated } = await forgetSelected(deps, ctx, caller, planned, prior);

	const superseded = prior.superseded + run.superseded;
	const deleted = prior.deleted + retried.deleted + run.deleted;
	let draft: SessionEventDraft<RollbackPayload>;
	try {
		draft = buildRollbackEvent(sessionId, {
			rollback_id: request.rollback_id,
			from_ckpt_id: request.from_ckpt_id,
			to_ckpt_id: target.payload.ckpt_id,
			target_event_id: target.event.id,
			target_hash: target.event.hash,
			pre_restore_tree: request.pre_restore_tree,
			pre_restore_ckpt_id: request.pre_restore_ckpt_id,
			files_added: request.files.added,
			files_modified: request.files.modified,
			files_deleted: request.files.deleted,
			memory: { superseded_entries: superseded, forgotten_documents: deleted },
			transcript: request.transcript,
		});
	} catch (cause) {
		if (cause instanceof SessionEventError) return failure("invalid-payload", cause.message);
		throw cause;
	}
	let emitted: EmitOutcome;
	try {
		emitted = await deps.emit({
			surface: caller.surface,
			kind: draft.kind,
			// The payload is a fixed contract with no room for a flag, so a local-only commit says so in the summary.
			summary: request.local_only ? `${draft.summary} (local-only: the checkpoint was not anchored)` : draft.summary,
			actor: "agent",
			session_id: sessionId,
			payload: { ...draft.payload },
			...(draft.idempotency_key !== undefined ? { idempotency_key: draft.idempotency_key } : {}),
		});
	} catch (cause) {
		if (cause instanceof InvalidEventError || cause instanceof IdempotencyRefusal) return failure("invalid-payload", describe(cause));
		throw cause;
	}
	if (!emitted.stored) {
		// The memory is already out of force; a retry re-derives these totals from the forget notes and records the rollback.
		return failure("ledger-down", `the memory was forgotten but the rollback was not recorded: ${clip(emitted.error ?? "the event ledger did not store it")}; commit again to record it`, {
			...RETRYABLE,
			done: { superseded_entries: superseded, forgotten_documents: deleted, plane_pending: run.pending > 0 || retried.pending },
		});
	}
	return {
		ok: true,
		event_id: emitted.event.id,
		memory: { superseded_entries: superseded, forgotten_documents: deleted, plane_pending: run.pending > 0 || retried.pending, truncated },
	};
}

/**
 * Record the outcome of a rollback the client carried out (or refused to carry out).
 *
 * `refused` appends one `session.rollback.refused` warning. `committed` re-computes the plan, answers `stale-plan`
 * (changing nothing) when its digest differs, forgets the memory written after the target in batches, and appends ONE
 * `session.rollback` note whose memory counts are the real totals. Idempotent by rollback id: a repeat finds the
 * existing note and answers with its counts without forgetting again. A forget that cannot complete emits nothing and
 * answers `forget-incomplete` (retryable). A local-only commit (`local_only`) takes the same checks; its note says the
 * checkpoint was not anchored.
 */
export async function sessionRollbackCommit(deps: SessionRollbackDeps, input: unknown, caller: RollbackCaller): Promise<CommitResult> {
	try {
		const request = parseCommit(input);
		if (request.outcome === "refused") return await commitRefused(deps, request, caller);
		// Two identical requests in flight in this process are one commit: the second waits for the first's answer.
		const key = sha256Hex(canonicalJson({ surface: caller.surface, operator: caller.isOperator, request }));
		const running = inflight.get(key);
		if (running !== undefined) return await running;
		const flight = commitCommitted(deps, request, caller).catch((cause: unknown): CommitResult => {
			if (cause instanceof Refusal) return cause.failure;
			throw cause;
		});
		inflight.set(key, flight);
		try {
			return await flight;
		} finally {
			inflight.delete(key);
		}
	} catch (cause) {
		if (cause instanceof Refusal) return cause.failure;
		throw cause;
	}
}

/** Upper bound of the index selection a plan reads (the index's own cap). Exported for the service's port. */
export const ROLLBACK_SELECTION_LIMIT = MAX_ROLLBACK_SELECT_LIMIT;
