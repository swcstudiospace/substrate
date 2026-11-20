/**
 * The durable audit sink for the steering inbox (phase 53, SOTA-09).
 *
 * `SteeringInbox` appends every `queued` and `acknowledged` transition to a `SteeringHistorySink`.
 * This module is the Postgres-backed implementation of that port, over the append-only table
 * `planning_steering_audit` (migration version 33, see `index-store.ts`; version 34 adds the nullable `reason` column).
 *
 * What it guarantees:
 * - Append-only. There is no update or delete method, and none is needed. Application-level only: a
 *   DB-level REVOKE or trigger is an operator decision.
 * - Complete. A queued row stores every field that changes what the directive asks for (action, priority,
 *   plan reference, conflict flag, creation time), so two directives that differ in any of them hash differently.
 * - Idempotent by key, never by guess. The unique key `(directive_id, transition)` makes a repeated write a
 *   no-op only when the stored payload hash equals the new one. A different payload under a saved key is a
 *   {@link SteeringAuditConflictError}, and the write is refused.
 * - Redacted. The body is passed through the shared `redact()` before it is stored.
 * - Tamper-evident. `payload_sha256` is the SHA-256 of the canonical JSON of the stored fields.
 * - Never swallowed. A failed write returns a typed error carrying the driver's code (or `AUDIT_CONFLICT`).
 *   `append` throws that same error, so `SteeringInbox` reports `audit-unavailable` with the code.
 * - No environment reads by the sink. The SQL port is injected. The one env reader here,
 *   {@link steeringAuditTableEnabled}, is called by configuration, never by the sink.
 * - The log is also the durable directive store. {@link SteeringAuditSink.readOpenDirectives} and
 *   {@link SteeringAuditSink.readRecent} read bounded, ordered pages back for `SteeringInbox.restore`, and
 *   {@link restoreSteeringInbox} runs the restart path. There is no second directive table. Reads go through
 *   {@link SteeringAuditReadSql}, a separate port, so a write-only sink stays valid.
 */
import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { redact } from "../redact.ts";
import { errnoCode } from "./index.ts";
import { SESSION_ID_RE } from "./presence.ts";
import type {
	STEERING_ACTIONS,
	SteeringAckReason,
	SteeringAuditEntry,
	SteeringHistorySink,
	SteeringInbox,
	SteeringOutcome,
	SteeringPriority,
	SteeringRestoreReport,
	SteeringIdempotencyStore,
	SteeringReplayClaim,
	SteeringReplayRecord,
	SteeringUnit,
} from "./steering.ts";
import { STEERING_OUTCOMES, type SteeringKeyedRequest } from "./steering.ts";
import { SESSION_STATE_NAMES, type SessionStateName, type SessionStateOutcome, type SessionTransitionRefusalReason } from "./steering-delivery.ts";

export const STEERING_AUDIT_TABLE = "planning_steering_audit";
/** The opt-in that makes `migrate()` create the audit table. Off creates nothing. */
export const STEERING_AUDIT_TABLE_ENV = "SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE";

export type SteeringAuditTransition = "queued" | "acknowledged";
export type SteeringAuthorKind = "human" | "agent";
export type SteeringAction = (typeof STEERING_ACTIONS)[number];

/**
 * One row as the SQL port writes it. An `acknowledged` row carries no author, body or directive fields: the
 * acknowledgement names only the directive, and everything about the directive lives on its `queued` row.
 */
export interface SteeringAuditRow {
	directiveId: string;
	transition: SteeringAuditTransition;
	outcome: SteeringOutcome | null;
	/** The acknowledgement's confirm flag. Null on a queued row, a boolean on an acknowledged row. */
	confirmed: boolean | null;
	authorPrincipal: string | null;
	authorKind: SteeringAuthorKind | null;
	targetSessionId: string;
	bodyRedacted: string | null;
	/** Queued rows only. Every field below changes the directive's meaning, so each is stored and hashed. */
	action: SteeringAction | null;
	priority: SteeringPriority | null;
	planPhase: string | null;
	planPlan: string | null;
	conflictsWithActivePlan: boolean | null;
	directiveCreatedAtMs: number | null;
	/** Acknowledged rows only, and only a system acknowledgement has one (migration 34). Null is left out of the payload hash, so a row hashed before the column existed keeps its hash. */
	reason: SteeringAckReason | null;
	/** Queued rows only (migration 44): the directive's delivery sequence, restored as stored. Hashed when present, so a row written before the column keeps its hash. */
	deliverySequence: number | null;
	/** Keyed commands only (migration 44): the caller surface, the key and the request fingerprint. All null for an unkeyed row. Hashed when present. */
	idempotencySurface: string | null;
	idempotencyKey: string | null;
	idempotencyFingerprint: string | null;
	payloadSha256: string;
	recordedAt: Date;
}

/** A row as saved: the payload hash it was written with, and the transition time it carries. */
export interface SteeringSavedRow {
	payloadSha256: string;
	recordedAt: Date;
}

/** A session-state result as the movement table stores it (migration 45). `sessionState` is null for `unchanged`. */
export interface SteeringSessionRow {
	directiveId: string;
	sessionStatus: SessionStateOutcome["status"];
	sessionState: SessionStateName | null;
	refusalReason: SessionTransitionRefusalReason | null;
	checkpointHint: boolean;
	recordedAt: Date;
}

/** A queued row a key names (phase 77): what a keyed queue replays from. */
export interface SteeringKeyedQueueSaved {
	directiveId: string;
	targetSessionId: string;
	queuedAtMs: number;
	deliverySequence: number | null;
	fingerprint: string;
}

/** An acknowledged row a key names (phase 77), with its queued row's sequence and its session-state result (null when none was recorded). */
export interface SteeringKeyedAckSaved {
	directiveId: string;
	outcome: SteeringOutcome;
	confirmed: boolean;
	fingerprint: string;
	deliverySequence: number | null;
	session: SessionStateOutcome | null;
	checkpointHint: boolean;
}

/** The durable side of the keyed replies (phase 77) and of the session step (phase 67). {@link SteeringAuditSink} implements it. */
export interface SteeringDurableReplies {
	savedKeyedQueue(surface: string, key: string): Promise<SteeringKeyedQueueSaved | null>;
	savedKeyedAcknowledgement(surface: string, key: string): Promise<SteeringKeyedAckSaved | null>;
	recordSessionOutcome(directiveId: string, session: SessionStateOutcome, checkpointHint: boolean, atMs: number): Promise<void>;
}

/** The refusal reasons a stored session outcome may carry. */
const SESSION_REFUSAL_REASONS: readonly SessionTransitionRefusalReason[] = ["not-found", "session-unavailable", "invalid-transition"];

/** The injected SQL port. The Bun-backed adapter is {@link bunSteeringAuditSql}; tests inject a fake. */
export interface SteeringAuditSql {
	/**
	 * Inserts the row unless `(directive_id, transition)` already holds one. Resolves `true` when this call wrote
	 * the row and `false` when the key was already present. Rejects with the driver's error.
	 */
	insertAbsent(row: SteeringAuditRow): Promise<boolean>;
	/** The row saved under `(directive_id, transition)`, or null when no row holds that key. */
	savedRow(directiveId: string, transition: SteeringAuditTransition): Promise<SteeringSavedRow | null>;
	/** Inserts the session-state result of an acknowledgement (migration 45). A repeat for one directive is a no-op. Rejects with the driver's error. */
	insertSessionOutcome(row: SteeringSessionRow): Promise<void>;
}

/** Bounds for a read page. The sink asks the port for one more row than `limit` to learn whether the page was cut. */
export const STEERING_READ_LIMIT_MAX = 5_000;
/** The page size {@link restoreSteeringInbox} callers should start from. */
export const DEFAULT_STEERING_RESTORE_LIMIT = 1_000;

/** An acknowledgement row as the read port returns it. Columns are normalised to text, boolean, null or Date; nothing is validated yet. */
export interface SteeringStoredAckRow {
	outcome: string | null;
	confirmed: boolean | null;
	reason: string | null;
	/** True when the acknowledgement's session step committed a movement (migration 45). False when no movement row exists. */
	sessionMoved: boolean;
	recordedAt: Date;
}

/** A queued row, joined to its acknowledgement row when it has one. `queuedAt` is the queued row's `recorded_at`. */
export interface SteeringStoredDirectiveRow {
	directiveId: string;
	authorPrincipal: string | null;
	authorKind: string | null;
	targetSessionId: string;
	bodyRedacted: string | null;
	action: string | null;
	priority: string | null;
	planPhase: string | null;
	planPlan: string | null;
	conflictsWithActivePlan: boolean | null;
	directiveCreatedAtMs: number | null;
	deliverySequence: number | null;
	queuedAt: Date;
	acknowledgement: SteeringStoredAckRow | null;
	/** The queued row's delivery sequence, or null when it has none (written before the column existed). */
	deliverySequence?: number | null;
}

export interface SteeringAuditReadQuery {
	/** Only directives for this session, or null for all. */
	sessionId: string | null;
	limit: number;
	/** `readOpen` only: start strictly after this (creation time, directive id). Null or absent starts at the oldest. `readClosed` ignores it. */
	after?: SteeringReadCursor | null;
}

/** The injected read port. {@link bunSteeringAuditReadSql} is the Postgres adapter; tests inject a fake. */
export interface SteeringAuditReadSql {
	/** Queued rows with no acknowledged row, oldest creation time first, then by directive id. At most `limit` rows. */
	readOpen(query: SteeringAuditReadQuery): Promise<SteeringStoredDirectiveRow[]>;
	/** Queued rows that have an acknowledged row, most recently acknowledged first, then by directive id descending. At most `limit` rows. */
	readClosed(query: SteeringAuditReadQuery): Promise<SteeringStoredDirectiveRow[]>;
	/** The acknowledged row saved for a directive, or null. */
	savedAcknowledgement(directiveId: string): Promise<SteeringStoredAckRow | null>;
	/** The queued row a key names (phase 77): its fingerprint, sequence and queue time. Null when no row holds the key. */
	savedKeyedQueue(surface: string, key: string): Promise<SteeringKeyedQueueSaved | null>;
	/** The acknowledged row a key names, with its queued row's sequence and session-state result. Null when no row holds the key. */
	savedKeyedAcknowledgement(surface: string, key: string): Promise<SteeringKeyedAckSaved | null>;
	/** The largest delivery sequence any row holds; 0 when none does. */
	maxDeliverySequence(): Promise<number>;
	/** The session a directive was queued for, from the durable log; null when no queued row holds the id. */
	targetSessionOf(directiveId: string): Promise<string | null>;
}

/** A driver failure. `code` is the driver's error code, or `UNKNOWN` when the cause carries none. */
export class SteeringAuditError extends Error {
	readonly code: string;

	constructor(code: string, cause: unknown) {
		super("steering audit write failed", { cause });
		this.name = "SteeringAuditError";
		this.code = code;
	}
}

/** The key is already held by a row with a different payload: the same transition was saved with other content. */
export class SteeringAuditConflictError extends Error {
	readonly code = "AUDIT_CONFLICT";
	readonly directiveId: string;
	readonly transition: SteeringAuditTransition;

	constructor(directiveId: string, transition: SteeringAuditTransition) {
		super("steering audit key already holds a different payload");
		this.name = "SteeringAuditConflictError";
		this.directiveId = directiveId;
		this.transition = transition;
	}
}

export type SteeringAuditFailure = SteeringAuditError | SteeringAuditConflictError;

export type SteeringAuditResult = { ok: true; value: { inserted: boolean } } | { ok: false; error: SteeringAuditFailure };

/** A read that could not run. `code` is `INVALID_QUERY`, `READ_UNAVAILABLE` (no read port was supplied) or the driver's error code. */
export class SteeringAuditReadError extends Error {
	readonly code: string;

	constructor(code: string, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SteeringAuditReadError";
		this.code = code;
	}
}

export interface SteeringReadOptions {
	/** Only directives for this planning session. Absent reads every session. */
	sessionId?: string;
	/** 1..{@link STEERING_READ_LIMIT_MAX}. */
	limit: number;
}

/** Where an open-directive page starts: strictly after the directive with this creation time and id, in the read's order. */
export interface SteeringReadCursor {
	createdAtMs: number;
	directiveId: string;
}

/** The options of {@link SteeringAuditSink.readOpenDirectives}: the common ones, and the page's start. */
export interface SteeringOpenReadOptions extends SteeringReadOptions {
	/** Absent reads from the oldest open directive. */
	after?: SteeringReadCursor;
}

/** One directive in the shape `SteeringInbox.restore` takes. Fields are as stored; `restore` validates them. */
export interface SteeringRestoreCandidate {
	directive: Record<string, unknown>;
	queuedAtMs: number;
	/** The delivery sequence the row holds (migration 44). Absent on a row written before it; such a row takes restore order. */
	deliverySequence?: number;
	acknowledgement?: { atMs: number; outcome: string | null; confirmed: boolean | null; reason?: string; sessionMoved?: boolean };
}

export interface SteeringReadPage {
	entries: SteeringRestoreCandidate[];
	/** True when more rows matched than `limit`. The page holds the first `limit` of them in the stated order. */
	truncated: boolean;
}

export type SteeringReadResult = { ok: true; value: SteeringReadPage } | { ok: false; error: SteeringAuditReadError };

export class SteeringAuditSink implements SteeringHistorySink, SteeringDurableReplies {
	constructor(
		private readonly sql: SteeringAuditSql,
		private readonly reads: SteeringAuditReadSql | null = null,
	) {}

	/** The port method `SteeringInbox` calls. A failed write throws a {@link SteeringAuditFailure}. `unit` is the store's open transaction for a keyed queue. */
	async append(entry: SteeringAuditEntry, unit?: SteeringUnit): Promise<void> {
		const result = await this.record(entry, unit);
		if (!result.ok) throw result.error;
	}

	/** The time a transition was saved with, for a retry to reuse. Errors keep their driver code, for the inbox to report. */
	async savedAtMs(event: "queued" | "acknowledged", directiveId: string): Promise<number | null> {
		const saved = await this.sql.savedRow(directiveId, event);
		return saved === null ? null : saved.recordedAt.getTime();
	}

	/**
	 * The acknowledgement saved for a directive, as `SteeringInbox` reads it back when an expiry loses a race. Null when none is
	 * saved, or when this sink has no read port. A driver failure rejects with its code.
	 */
	async readAcknowledgement(directiveId: string): Promise<SteeringRestoreCandidate["acknowledgement"] | null> {
		if (this.reads === null) return null;
		const saved = await this.reads.savedAcknowledgement(directiveId);
		return saved === null ? null : acknowledgementCandidate(saved);
	}

	/** The queued row a key names (phase 77), or null. A read failure rejects with its code, so a replay is never guessed. */
	savedKeyedQueue(surface: string, key: string): Promise<SteeringKeyedQueueSaved | null> {
		return this.requireReads().savedKeyedQueue(surface, key);
	}

	/** The acknowledged row a key names, with its queued row's sequence and its session-state result, or null. A read failure rejects with its code. */
	savedKeyedAcknowledgement(surface: string, key: string): Promise<SteeringKeyedAckSaved | null> {
		return this.requireReads().savedKeyedAcknowledgement(surface, key);
	}

	/**
	 * Records the session-state result of one acknowledgement (phase 67 restart hint, phase 77 replay). Written once, after the
	 * session port answers. A failure rejects with its code; the acknowledgement it describes stands without the record.
	 */
	async recordSessionOutcome(directiveId: string, session: SessionStateOutcome, checkpointHint: boolean, atMs: number): Promise<void> {
		if (!Number.isSafeInteger(atMs) || atMs < 0) throw new RangeError("session outcome atMs must be a non-negative integer");
		await this.sql.insertSessionOutcome({
			directiveId,
			sessionStatus: session.status,
			sessionState: session.status === "unchanged" ? null : session.state,
			refusalReason: session.status === "refused" ? session.reason : null,
			checkpointHint,
			recordedAt: new Date(atMs),
		});
	}

	/** The largest delivery sequence the table holds, 0 when none does. A read failure is returned as a value, like the other reads. */
	async readSequenceFloor(): Promise<{ ok: true; value: number } | { ok: false; error: SteeringAuditReadError }> {
		if (this.reads === null) return { ok: false, error: new SteeringAuditReadError("READ_UNAVAILABLE", "this audit sink was built without a read port") };
		try {
			return { ok: true, value: await this.reads.maxDeliverySequence() };
		} catch (cause) {
			return { ok: false, error: new SteeringAuditReadError(errnoCode(cause), "steering audit read failed", cause) };
		}
	}

	private requireReads(): SteeringAuditReadSql {
		if (this.reads === null) throw new SteeringAuditReadError("READ_UNAVAILABLE", "this audit sink was built without a read port");
		return this.reads;
	}

	/**
	 * The session a directive was queued for, read from the durable log (phase 77, L77-02). The live-session boundary uses it when the
	 * inbox no longer holds an acknowledged directive, so a keyed replay is answered and not refused as unknown. A read failure rejects.
	 */
	targetSessionOf(directiveId: string): Promise<string | null> {
		return this.requireReads().targetSessionOf(directiveId);
	}

	/**
	 * Queued directives with no acknowledged row, oldest creation time first then by directive id: what a restart must
	 * reload. Bounded by `limit`, with `truncated` set when more matched.
	 */
	readOpenDirectives(options: SteeringOpenReadOptions): Promise<SteeringReadResult> {
		const { after } = options;
		if (after !== undefined && (!Number.isSafeInteger(after.createdAtMs) || after.createdAtMs < 0 || after.directiveId === "")) {
			return Promise.resolve(readFailure("INVALID_QUERY", "after must name a non-negative integer creation time and a directive id"));
		}
		return this.readPage(options, (reads, query) => reads.readOpen({ ...query, after: after ?? null }));
	}

	/** The most recently closed directives, newest acknowledgement first then by directive id descending, for the audit view. Bounded like {@link readOpenDirectives}. */
	readRecent(options: SteeringReadOptions): Promise<SteeringReadResult> {
		return this.readPage(options, (reads, query) => reads.readClosed(query));
	}

	private async readPage(
		options: SteeringReadOptions,
		run: (reads: SteeringAuditReadSql, query: SteeringAuditReadQuery) => Promise<SteeringStoredDirectiveRow[]>,
	): Promise<SteeringReadResult> {
		const { sessionId = null, limit } = options;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > STEERING_READ_LIMIT_MAX) {
			return readFailure("INVALID_QUERY", `limit must be an integer from 1 to ${STEERING_READ_LIMIT_MAX}`);
		}
		if (sessionId !== null && !SESSION_ID_RE.test(sessionId)) return readFailure("INVALID_QUERY", "sessionId is not a valid session id");
		if (this.reads === null) return readFailure("READ_UNAVAILABLE", "this audit sink was built without a read port");
		try {
			const rows = await run(this.reads, { sessionId, limit: limit + 1 });
			return { ok: true, value: { entries: rows.slice(0, limit).map(restoreCandidate), truncated: rows.length > limit } };
		} catch (cause) {
			return { ok: false, error: new SteeringAuditReadError(errnoCode(cause), "steering audit read failed", cause) };
		}
	}

	/** Writes one transition and reports the outcome as a value. A same-payload repeat is `inserted: false`. `unit` is a transaction the store opened: the write goes through it. */
	async record(entry: SteeringAuditEntry, unit?: SteeringUnit): Promise<SteeringAuditResult> {
		let row: SteeringAuditRow;
		try {
			row = toAuditRow(entry);
		} catch (cause) {
			return { ok: false, error: new SteeringAuditError(errnoCode(cause), cause) };
		}
		const port = unit === undefined ? this.sql : bunSteeringAuditSql(unit as SQL);
		try {
			if (await port.insertAbsent(row)) return { ok: true, value: { inserted: true } };
			const stored = await port.savedRow(row.directiveId, row.transition);
			if (stored?.payloadSha256 === row.payloadSha256) return { ok: true, value: { inserted: false } };
			return { ok: false, error: new SteeringAuditConflictError(row.directiveId, row.transition) };
		} catch (cause) {
			return this.recoverOrFail(port, row, cause);
		}
	}

	/**
	 * A failed write may have committed with only its reply lost. The saved row decides: one carrying this payload means
	 * the transition happened, so it is reported as recorded. No such row, or a read-back that also fails, is the original
	 * failure, and the transition stays held for a retry.
	 */
	private async recoverOrFail(port: SteeringAuditSql, row: SteeringAuditRow, cause: unknown): Promise<SteeringAuditResult> {
		try {
			if ((await port.savedRow(row.directiveId, row.transition))?.payloadSha256 === row.payloadSha256) {
				return { ok: true, value: { inserted: false } };
			}
		} catch {
			// Nothing is known to be saved, so the original write failure is the one reported below.
		}
		return { ok: false, error: new SteeringAuditError(errnoCode(cause), cause) };
	}
}

/** The Bun SQL adapter. The insert leaves an existing key untouched; the read-back returns its stored hash. */
export function bunSteeringAuditSql(sql: SQL): SteeringAuditSql {
	return {
		async insertAbsent(row: SteeringAuditRow): Promise<boolean> {
			const written = await sql`
				insert into planning_steering_audit (
					directive_id, transition, outcome, confirmed, reason, author_principal, author_kind,
					target_session_id, body_redacted, action, priority, plan_phase, plan_plan,
					conflicts_with_active_plan, directive_created_at_ms, delivery_sequence,
					idempotency_surface, idempotency_key, idempotency_fingerprint, payload_sha256, recorded_at
				)
				values (
					${row.directiveId}, ${row.transition}, ${row.outcome}, ${row.confirmed}, ${row.reason}, ${row.authorPrincipal}, ${row.authorKind},
					${row.targetSessionId}, ${row.bodyRedacted}, ${row.action}, ${row.priority}, ${row.planPhase}, ${row.planPlan},
					${row.conflictsWithActivePlan}, ${row.directiveCreatedAtMs}, ${row.deliverySequence},
					${row.idempotencySurface}, ${row.idempotencyKey}, ${row.idempotencyFingerprint}, ${row.payloadSha256}, ${row.recordedAt}
				)
				on conflict (directive_id, transition) do nothing
				returning id`;
			return written.length === 1;
		},
		async savedRow(directiveId: string, transition: SteeringAuditTransition): Promise<SteeringSavedRow | null> {
			const rows = await sql`
				select payload_sha256, recorded_at from planning_steering_audit
				where directive_id = ${directiveId} and transition = ${transition}`;
			const saved = rows[0];
			if (saved === undefined) return null;
			return { payloadSha256: String(saved.payload_sha256), recordedAt: new Date(saved.recorded_at) };
		},
		async insertSessionOutcome(row: SteeringSessionRow): Promise<void> {
			await sql`
				insert into planning_steering_movements (directive_id, session_status, session_state, refusal_reason, checkpoint_hint, recorded_at)
				values (${row.directiveId}, ${row.sessionStatus}, ${row.sessionState}, ${row.refusalReason}, ${row.checkpointHint}, ${row.recordedAt})
				on conflict (directive_id) do nothing`;
		},
	};
}

/**
 * The Bun SQL read adapter. Both listings are bounded by `limit` and ordered, and neither writes. A queued row with no
 * acknowledged row is open; the unique `(directive_id, transition)` key makes the join at most one row wide. A keyed lookup
 * reads the partial unique key `(transition, idempotency_surface, idempotency_key)`, and a stored value that is not one of the
 * closed sets throws rather than being replayed.
 */
export function bunSteeringAuditReadSql(sql: SQL): SteeringAuditReadSql {
	return {
		async readOpen(query: SteeringAuditReadQuery): Promise<SteeringStoredDirectiveRow[]> {
			// `after` is the keyset cursor: the page starts strictly after that (creation time, id), in the order below. Null reads from the start.
			const afterMs = query.after?.createdAtMs ?? null;
			const afterId = query.after?.directiveId ?? null;
			const rows = await sql`
				select q.directive_id, q.author_principal, q.author_kind, q.target_session_id, q.body_redacted, q.action, q.priority,
					q.plan_phase, q.plan_plan, q.conflicts_with_active_plan, q.directive_created_at_ms, q.recorded_at, q.delivery_sequence
				from planning_steering_audit q
				where q.transition = 'queued'
					and (${query.sessionId}::text is null or q.target_session_id = ${query.sessionId}::text)
					and (${afterMs}::bigint is null or (q.directive_created_at_ms, q.directive_id) > (${afterMs}::bigint, ${afterId}::text))
					and not exists (
						select 1 from planning_steering_audit a where a.directive_id = q.directive_id and a.transition = 'acknowledged'
					)
				order by q.directive_created_at_ms asc, q.directive_id asc
				limit ${query.limit}`;
			return (rows as Array<Record<string, unknown>>).map((row) => storedDirectiveRow(row, null));
		},
		async readClosed(query: SteeringAuditReadQuery): Promise<SteeringStoredDirectiveRow[]> {
			const rows = await sql`
				select q.directive_id, q.author_principal, q.author_kind, q.target_session_id, q.body_redacted, q.action, q.priority,
					q.plan_phase, q.plan_plan, q.conflicts_with_active_plan, q.directive_created_at_ms, q.recorded_at, q.delivery_sequence,
					a.outcome as ack_outcome, a.confirmed as ack_confirmed, a.reason as ack_reason, a.recorded_at as ack_recorded_at,
					m.session_status as ack_session_status
				from planning_steering_audit q
				join planning_steering_audit a on a.directive_id = q.directive_id and a.transition = 'acknowledged'
				left join planning_steering_movements m on m.directive_id = a.directive_id
				where q.transition = 'queued'
					and (${query.sessionId}::text is null or q.target_session_id = ${query.sessionId}::text)
				order by a.recorded_at desc, q.directive_id desc
				limit ${query.limit}`;
			return (rows as Array<Record<string, unknown>>).map((row) =>
				storedDirectiveRow(row, {
					outcome: textOrNull(row.ack_outcome),
					confirmed: booleanOrNull(row.ack_confirmed),
					reason: textOrNull(row.ack_reason),
					recordedAt: new Date(row.ack_recorded_at as string | number | Date),
					sessionMoved: textOrNull(row.ack_session_status) === "applied",
				}),
			);
		},
		async savedAcknowledgement(directiveId: string): Promise<SteeringStoredAckRow | null> {
			const rows = (await sql`
				select a.outcome, a.confirmed, a.reason, a.recorded_at, m.session_status
				from planning_steering_audit a
				left join planning_steering_movements m on m.directive_id = a.directive_id
				where a.directive_id = ${directiveId} and a.transition = 'acknowledged'`) as Array<Record<string, unknown>>;
			const saved = rows[0];
			if (saved === undefined) return null;
			return {
				outcome: textOrNull(saved.outcome),
				confirmed: booleanOrNull(saved.confirmed),
				reason: textOrNull(saved.reason),
				recordedAt: new Date(saved.recorded_at as string | number | Date),
				sessionMoved: textOrNull(saved.session_status) === "applied",
			};
		},
		async savedKeyedQueue(surface: string, key: string): Promise<SteeringKeyedQueueSaved | null> {
			const rows = (await sql`
				select directive_id, target_session_id, recorded_at, delivery_sequence, idempotency_fingerprint
				from planning_steering_audit
				where transition = 'queued' and idempotency_surface = ${surface} and idempotency_key = ${key}`) as Array<Record<string, unknown>>;
			const saved = rows[0];
			if (saved === undefined) return null;
			return {
				directiveId: String(saved.directive_id),
				targetSessionId: String(saved.target_session_id),
				queuedAtMs: new Date(saved.recorded_at as string | number | Date).getTime(),
				deliverySequence: integerOrNull(saved.delivery_sequence),
				fingerprint: String(saved.idempotency_fingerprint),
			};
		},
		async savedKeyedAcknowledgement(surface: string, key: string): Promise<SteeringKeyedAckSaved | null> {
			const rows = (await sql`
				select a.directive_id, a.outcome, a.confirmed, a.idempotency_fingerprint, q.delivery_sequence,
					m.session_status, m.session_state, m.refusal_reason, m.checkpoint_hint
				from planning_steering_audit a
				join planning_steering_audit q on q.directive_id = a.directive_id and q.transition = 'queued'
				left join planning_steering_movements m on m.directive_id = a.directive_id
				where a.transition = 'acknowledged' and a.idempotency_surface = ${surface} and a.idempotency_key = ${key}`) as Array<Record<string, unknown>>;
			const saved = rows[0];
			if (saved === undefined) return null;
			return {
				directiveId: String(saved.directive_id),
				outcome: steeringOutcomeOf(saved.outcome),
				confirmed: booleanOrNull(saved.confirmed) === true,
				fingerprint: String(saved.idempotency_fingerprint),
				deliverySequence: integerOrNull(saved.delivery_sequence),
				session: sessionOutcomeOf(textOrNull(saved.session_status), textOrNull(saved.session_state), textOrNull(saved.refusal_reason)),
				checkpointHint: booleanOrNull(saved.checkpoint_hint) === true,
			};
		},
		async maxDeliverySequence(): Promise<number> {
			const rows = await sql`select coalesce(max(delivery_sequence), 0) as max_sequence from planning_steering_audit`;
			return integerOrNull(rows[0]?.max_sequence) ?? 0;
		},
		async targetSessionOf(directiveId: string): Promise<string | null> {
			const rows = await sql`select target_session_id from planning_steering_audit where directive_id = ${directiveId} and transition = 'queued'`;
			return rows[0] === undefined ? null : String(rows[0].target_session_id);
		},
	};
}

/**
 * The restart path: reads the open directives (bounded by `options.limit`) and loads them into `inbox`. Nothing is
 * audited. A failed read loads nothing and is returned as a value; `truncated` says more open directives exist than were read.
 * One read only: {@link restoreSteeringInboxPaged} reads every page.
 */
export async function restoreSteeringInbox(
	inbox: SteeringInbox,
	sink: SteeringAuditSink,
	options: SteeringReadOptions,
): Promise<{ ok: true; value: { report: SteeringRestoreReport; truncated: boolean } } | { ok: false; error: SteeringAuditReadError }> {
	const floor = await sink.readSequenceFloor();
	if (!floor.ok) return floor;
	inbox.seedSequence(floor.value);
	const page = await sink.readOpenDirectives(options);
	if (!page.ok) return page;
	return { ok: true, value: { report: await inbox.restore(page.value.entries), truncated: page.value.truncated } };
}

/** The most pages {@link restoreSteeringInboxPaged} reads when the caller names no cap: with {@link DEFAULT_STEERING_RESTORE_LIMIT} rows each, 50,000 open directives. */
export const DEFAULT_STEERING_RESTORE_MAX_PAGES = 50;

/** Why a paged restore stopped before the open directives were exhausted. `page-cap`: the cap was hit with more still open. `read-failed`: a later page could not be read. `no-cursor`: a page could not name where the next one starts. */
export type SteeringRestoreStop = "page-cap" | "read-failed" | "no-cursor";

/** The longest a boot restore may wait on the audit store, in ms, before it gives up. The inbox then starts empty, and no directive from a read that answers later is loaded. */
export const STEERING_RESTORE_DEADLINE_MS = 10_000;

/** The `SteeringAuditReadError` code of a restore that ran past its deadline. */
export const STEERING_RESTORE_TIMEOUT_CODE = "timeout";

export interface SteeringRestorePagedOptions extends SteeringReadOptions {
	/** The most pages read, 1 or more. Absent: {@link DEFAULT_STEERING_RESTORE_MAX_PAGES}. */
	maxPages?: number;
	/** The wait budget of the whole restore, the floor read and every page together, in ms, 1 or more. Absent: {@link STEERING_RESTORE_DEADLINE_MS}. */
	deadlineMs?: number;
}

export type SteeringRestorePagedResult =
	| { ok: true; value: { report: SteeringRestoreReport; truncated: boolean; pages: number; stoppedBy: SteeringRestoreStop | null } }
	| { ok: false; error: SteeringAuditReadError };

/**
 * The restart path over every page: reads the open directives `options.limit` at a time, oldest first, each page starting
 * after the last directive of the one before (keyset, so a page never repeats and never skips), and loads them into `inbox`.
 * It stops when a page is not cut, or at `maxPages`; a stop with directives still open is a named truncation (`stoppedBy`),
 * never silent. A directive stays open while it is restored, so the cursor, not the read, is what advances. A first page
 * that cannot be read loads nothing and is returned as a value. A later page that cannot be read keeps the earlier pages
 * and reports `stoppedBy: "read-failed"`. Nothing is audited.
 *
 * Every read runs under one deadline. A restore that is still reading when it passes returns a `timeout` read error, and no
 * directive is loaded: the abandoned reads are discarded when they answer, so the inbox is never filled after the caller gave up.
 */
export async function restoreSteeringInboxPaged(inbox: SteeringInbox, sink: SteeringAuditSink, options: SteeringRestorePagedOptions): Promise<SteeringRestorePagedResult> {
	const maxPages = options.maxPages ?? DEFAULT_STEERING_RESTORE_MAX_PAGES;
	if (!Number.isSafeInteger(maxPages) || maxPages < 1) return { ok: false, error: new SteeringAuditReadError("INVALID_QUERY", "maxPages must be an integer of 1 or more") };
	const deadlineMs = options.deadlineMs ?? STEERING_RESTORE_DEADLINE_MS;
	if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) return { ok: false, error: new SteeringAuditReadError("INVALID_QUERY", "deadlineMs must be an integer of 1 or more") };
	const read = await withDeadline(readOpenPages(inbox, sink, options, maxPages), deadlineMs);
	if (read === DEADLINE) return { ok: false, error: new SteeringAuditReadError(STEERING_RESTORE_TIMEOUT_CODE, `steering restore did not finish within ${deadlineMs} ms`) };
	if (!read.ok) return read;
	// Loaded in one step once every read is whole, so a restore that gave up leaves no directive behind.
	const loaded = await inbox.restore(read.value.entries);
	return { ok: true, value: { report: loaded, truncated: read.value.stoppedBy !== null, pages: read.value.pages, stoppedBy: read.value.stoppedBy } };
}

const DEADLINE: unique symbol = Symbol("steering-restore-deadline");

/** Settles with `work`, or with {@link DEADLINE} once `ms` has passed. The timer is cleared as soon as `work` settles. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof DEADLINE> {
	const expired = Promise.withResolvers<typeof DEADLINE>();
	const timer = setTimeout(expired.resolve, ms, DEADLINE);
	try {
		return await Promise.race([work, expired.promise]);
	} finally {
		clearTimeout(timer);
	}
}

interface OpenPages {
	entries: SteeringRestoreCandidate[];
	pages: number;
	stoppedBy: SteeringRestoreStop | null;
}

/**
 * The floor and every page of open directives, read but not loaded. Read failures are returned as values, as the reads return them.
 * The floor is raised on the inbox as soon as it is read: that only moves the sequence counter up, so it holds even when a later
 * read fails or the restore gives up, and a directive queued afterwards still sorts after every stored one.
 */
async function readOpenPages(inbox: SteeringInbox, sink: SteeringAuditSink, options: SteeringRestorePagedOptions, maxPages: number): Promise<{ ok: true; value: OpenPages } | { ok: false; error: SteeringAuditReadError }> {
	const floor = await sink.readSequenceFloor();
	if (!floor.ok) return floor;
	inbox.seedSequence(floor.value);
	const entries: SteeringRestoreCandidate[] = [];
	let after: SteeringReadCursor | undefined;
	let pages = 0;
	let stoppedBy: SteeringRestoreStop | null = null;
	for (;;) {
		const page = await sink.readOpenDirectives({ ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }), limit: options.limit, ...(after === undefined ? {} : { after }) });
		if (!page.ok) {
			if (pages === 0) return page;
			stoppedBy = "read-failed";
			break;
		}
		entries.push(...page.value.entries);
		pages += 1;
		if (!page.value.truncated) break;
		const next = cursorAfter(page.value.entries);
		if (next === null || (after !== undefined && next.createdAtMs === after.createdAtMs && next.directiveId === after.directiveId)) {
			stoppedBy = "no-cursor";
			break;
		}
		if (pages >= maxPages) {
			stoppedBy = "page-cap";
			break;
		}
		after = next;
	}
	return { ok: true, value: { entries, pages, stoppedBy } };
}

/** Where the page after `entries` starts: the last entry's creation time and id, or null when the last entry carries neither as the read ordered them. */
function cursorAfter(entries: readonly SteeringRestoreCandidate[]): SteeringReadCursor | null {
	const last = entries[entries.length - 1]?.directive;
	if (last === undefined) return null;
	const { createdAtMs, id } = last;
	if (typeof createdAtMs !== "number" || !Number.isSafeInteger(createdAtMs) || createdAtMs < 0 || typeof id !== "string" || id === "") return null;
	return { createdAtMs, directiveId: id };
}

function readFailure(code: string, message: string): SteeringReadResult {
	return { ok: false, error: new SteeringAuditReadError(code, message) };
}

/** The stored row as the inbox's restore entry. A `null` column stays `null`, so `restore` rejects the entry instead of this guessing. */
function restoreCandidate(row: SteeringStoredDirectiveRow): SteeringRestoreCandidate {
	const directive: Record<string, unknown> = {
		id: row.directiveId,
		author: { principalId: row.authorPrincipal, kind: row.authorKind },
		createdAtMs: row.directiveCreatedAtMs,
		priority: row.priority,
		targetSessionId: row.targetSessionId,
		action: row.action,
		body: row.bodyRedacted,
		conflictsWithActivePlan: row.conflictsWithActivePlan,
	};
	// Either half present makes a plan reference, so a half-written pair fails validation instead of vanishing.
	if (row.planPhase !== null || row.planPlan !== null) directive.planRef = { phase: row.planPhase, plan: row.planPlan };
	const candidate: SteeringRestoreCandidate = { directive, queuedAtMs: row.queuedAt.getTime() };
	// The stored delivery sequence is restored as stored, so a restart keeps the order the inbox gave. A null is left out.
	if (row.deliverySequence !== null) candidate.deliverySequence = row.deliverySequence;
	if (row.acknowledgement !== null) candidate.acknowledgement = acknowledgementCandidate(row.acknowledgement);
	return candidate;
}

function acknowledgementCandidate(row: SteeringStoredAckRow): NonNullable<SteeringRestoreCandidate["acknowledgement"]> {
	const ack: NonNullable<SteeringRestoreCandidate["acknowledgement"]> = {
		atMs: row.recordedAt.getTime(),
		outcome: row.outcome,
		confirmed: row.confirmed,
	};
	if (row.reason !== null) ack.reason = row.reason;
	if (row.sessionMoved) ack.sessionMoved = true;
	return ack;
}

function storedDirectiveRow(row: Record<string, unknown>, acknowledgement: SteeringStoredAckRow | null): SteeringStoredDirectiveRow {
	return {
		directiveId: String(row.directive_id),
		authorPrincipal: textOrNull(row.author_principal),
		authorKind: textOrNull(row.author_kind),
		targetSessionId: String(row.target_session_id),
		bodyRedacted: textOrNull(row.body_redacted),
		action: textOrNull(row.action),
		priority: textOrNull(row.priority),
		planPhase: textOrNull(row.plan_phase),
		planPlan: textOrNull(row.plan_plan),
		conflictsWithActivePlan: booleanOrNull(row.conflicts_with_active_plan),
		directiveCreatedAtMs: integerOrNull(row.directive_created_at_ms),
		deliverySequence: integerOrNull(row.delivery_sequence),
		queuedAt: new Date(row.recorded_at as string | number | Date),
		acknowledgement,
	};
}

function textOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

/** A bigint column arrives as a number, a bigint or decimal text depending on the driver setting; anything else is null. */
function integerOrNull(value: unknown): number | null {
	if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
	if (typeof value === "bigint") return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
	if (typeof value === "string" && /^[0-9]+$/.test(value)) {
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) ? parsed : null;
	}
	return null;
}

function isSteeringOutcome(value: string): value is SteeringOutcome {
	return (STEERING_OUTCOMES as readonly string[]).includes(value);
}

/** The outcome of a stored acknowledgement. A value outside the closed set throws: an unknown row is never replayed as an answer. */
function steeringOutcomeOf(value: unknown): SteeringOutcome {
	if (typeof value === "string" && isSteeringOutcome(value)) return value;
	throw new RangeError("stored acknowledgement outcome is not a steering outcome");
}

function isSessionStateName(value: string | null): value is SessionStateName {
	return value !== null && (SESSION_STATE_NAMES as readonly string[]).includes(value);
}

function isRefusalReason(value: string | null): value is SessionTransitionRefusalReason {
	return value !== null && (SESSION_REFUSAL_REASONS as readonly string[]).includes(value);
}

/**
 * The session-state result a movement row holds, in the shape the reply carries. A row with no movement is `null`: the
 * acknowledgement was written but its session step was not recorded. A value outside the closed sets throws.
 */
function sessionOutcomeOf(status: string | null, state: string | null, reason: string | null): SessionStateOutcome | null {
	if (status === null) return null;
	if (status === "unchanged") return { status: "unchanged" };
	if (!isSessionStateName(state)) throw new RangeError("stored session state is not a session state");
	if (status === "applied") return { status: "applied", state };
	if (status === "refused" && isRefusalReason(reason)) return { status: "refused", state, reason };
	throw new RangeError("stored session status is not a session outcome");
}

/** `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE`: on or 1/true/yes creates the audit table at `migrate()`. Anything else is off. */
export function steeringAuditTableEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
	return /^(1|true|yes|on)$/i.test(env[STEERING_AUDIT_TABLE_ENV]?.trim() ?? "");
}

function toAuditRow(entry: SteeringAuditEntry): SteeringAuditRow {
	const recordedAt = recordedAtOf(entry.atMs);
	if (entry.event === "queued") {
		const { directive } = entry;
		if (entry.deliverySequence !== undefined && (!Number.isSafeInteger(entry.deliverySequence) || entry.deliverySequence < 1)) {
			throw new RangeError("delivery sequence must be a positive integer");
		}
		const fields = {
			directiveId: directive.id,
			transition: "queued" as const,
			outcome: null,
			confirmed: null,
			reason: null,
			authorPrincipal: directive.author.principalId,
			authorKind: directive.author.kind,
			targetSessionId: directive.targetSessionId,
			bodyRedacted: redact(directive.body),
			action: directive.action,
			priority: directive.priority,
			planPhase: directive.planRef?.phase ?? null,
			planPlan: directive.planRef?.plan ?? null,
			conflictsWithActivePlan: directive.conflictsWithActivePlan,
			directiveCreatedAtMs: directive.createdAtMs,
			deliverySequence: entry.deliverySequence ?? null,
			...keyedFieldsOf(entry.idempotency),
			recordedAt,
		};
		return { ...fields, payloadSha256: payloadSha256(fields) };
	}
	if (entry.reason !== undefined && entry.outcome !== "declined") throw new RangeError("only a declined acknowledgement carries a reason");
	const fields = {
		directiveId: entry.directiveId,
		transition: "acknowledged" as const,
		outcome: entry.outcome,
		confirmed: entry.confirmed,
		reason: entry.reason ?? null,
		authorPrincipal: null,
		authorKind: null,
		targetSessionId: entry.targetSessionId,
		bodyRedacted: null,
		action: null,
		priority: null,
		planPhase: null,
		planPlan: null,
		conflictsWithActivePlan: null,
		directiveCreatedAtMs: null,
		deliverySequence: null,
		...keyedFieldsOf(entry.idempotency),
		recordedAt,
	};
	return { ...fields, payloadSha256: payloadSha256(fields) };
}

/** The keyed-command columns of a row: all null for an unkeyed command, so an unkeyed row's payload is what it was before. */
function keyedFieldsOf(keyed: SteeringKeyedRequest | undefined): Pick<SteeringAuditRow, "idempotencySurface" | "idempotencyKey" | "idempotencyFingerprint"> {
	if (keyed === undefined) return { idempotencySurface: null, idempotencyKey: null, idempotencyFingerprint: null };
	return { idempotencySurface: keyed.surface, idempotencyKey: keyed.key, idempotencyFingerprint: keyed.fingerprint };
}

function recordedAtOf(atMs: number): Date {
	if (!Number.isSafeInteger(atMs) || atMs < 0) throw new RangeError("audit atMs must be a non-negative integer");
	return new Date(atMs);
}

/** SHA-256 over the canonical JSON of the stored fields. `recordedAt` enters as its ISO-8601 text. */
function payloadSha256(fields: Omit<SteeringAuditRow, "payloadSha256">): string {
	const { reason, deliverySequence, idempotencySurface, idempotencyKey, idempotencyFingerprint, ...rest } = fields;
	const stored: Record<string, string | number | boolean | null> = {
		...rest,
		recordedAt: fields.recordedAt.toISOString(),
	};
	// Each of these is part of the hash whenever present, so a changed value under one key is a conflict. Omitted when null, so a
	// row hashed before its column existed keeps its hash and a same-payload retry of it still matches.
	if (reason !== null) stored.reason = reason;
	if (deliverySequence !== null) stored.deliverySequence = deliverySequence;
	if (idempotencySurface !== null) stored.idempotencySurface = idempotencySurface;
	if (idempotencyKey !== null) stored.idempotencyKey = idempotencyKey;
	if (idempotencyFingerprint !== null) stored.idempotencyFingerprint = idempotencyFingerprint;
	return createHash("sha256").update(canonicalJson(stored)).digest("hex");
}

/** JSON with keys in code-unit order, so the same fields always produce the same bytes. */
function canonicalJson(fields: Readonly<Record<string, string | number | boolean | null>>): string {
	const sorted: Record<string, string | number | boolean | null> = {};
	for (const key of Object.keys(fields).sort()) sorted[key] = fields[key] ?? null;
	return JSON.stringify(sorted);
}

/** A column that must hold a whole number: the sequence counter and the replay times. A value that is not one is a driver fault, thrown. */
function requiredInteger(value: unknown): number {
	const parsed = integerOrNull(value);
	if (parsed === null) throw new RangeError("stored steering sequence or time is not a whole number");
	return parsed;
}

/**
 * The Bun SQL store for the delivery sequence counter and the keyed-queue replay records (migration 43). A sequence is taken with one
 * upsert, so two processes never take the same number. A keyed queue is one transaction: expired records are pruned, the scope key is
 * claimed by insert (a key another transaction holds makes this one wait, then lose), the queued audit row is written through the same
 * transaction, and the oldest records beyond the cap are deleted. A refused audit write rolls the claim back with it.
 */
export function bunSteeringIdempotencyStore(sql: SQL): SteeringIdempotencyStore {
	return {
		async nextSequence(sessionId: string): Promise<number> {
			const rows = await sql`
				insert into planning_steering_sequence (target_session_id, last_sequence)
				values (${sessionId}, 1)
				on conflict (target_session_id) do update set last_sequence = planning_steering_sequence.last_sequence + 1
				returning last_sequence`;
			return requiredInteger(rows[0]?.last_sequence);
		},
		async advancePast(sessionId: string, sequence: number): Promise<void> {
			await sql`
				insert into planning_steering_sequence (target_session_id, last_sequence)
				values (${sessionId}, ${sequence})
				on conflict (target_session_id) do update set last_sequence = greatest(planning_steering_sequence.last_sequence, excluded.last_sequence)`;
		},
		async findReplay(scopeKey: string, nowMs: number): Promise<SteeringReplayRecord | null> {
			const rows = (await sql`
				select fingerprint, directive_json, sequence, queued_at_ms, expires_at_ms
				from planning_steering_replay
				where scope_key = ${scopeKey} and expires_at_ms > ${nowMs}`) as Array<Record<string, unknown>>;
			const row = rows[0];
			return row === undefined ? null : replayRecord(row, scopeKey);
		},
		async claimReplay(record: SteeringReplayRecord, nowMs: number, cap: number, queue: (unit: SteeringUnit) => Promise<void>): Promise<SteeringReplayClaim> {
			return sql.begin(async (tx): Promise<SteeringReplayClaim> => {
				await tx`delete from planning_steering_replay where expires_at_ms <= ${nowMs}`;
				const claimed = await tx`
					insert into planning_steering_replay (scope_key, target_session_id, fingerprint, directive_json, sequence, queued_at_ms, expires_at_ms)
					values (${record.scopeKey}, ${record.directive.targetSessionId}, ${record.fingerprint}, ${JSON.stringify(record.directive)}, ${record.sequence}, ${record.queuedAtMs}, ${record.expiresAtMs})
					on conflict (scope_key) do nothing
					returning scope_key`;
				if (claimed.length === 0) {
					const rows = (await tx`
						select fingerprint, directive_json, sequence, queued_at_ms, expires_at_ms
						from planning_steering_replay
						where scope_key = ${record.scopeKey}`) as Array<Record<string, unknown>>;
					const held = rows[0];
					if (held === undefined) throw new Error("a held replay claim could not be read");
					return { claimed: false, held: replayRecord(held, record.scopeKey) };
				}
				await queue(tx);
				await tx`
					delete from planning_steering_replay
					where scope_key in (
						select scope_key from planning_steering_replay
						order by queued_at_ms desc, scope_key desc
						offset ${cap}
					)`;
				return { claimed: true };
			});
		},
	};
}

/** A replay row as the record it was saved as. A row whose directive does not parse is a driver fault, thrown. */
function replayRecord(row: Record<string, unknown>, scopeKey: string): SteeringReplayRecord {
	const directive = SteeringDirectiveSchema.safeParse(JSON.parse(String(row.directive_json)));
	if (!directive.success) throw new RangeError("stored steering replay record does not hold a directive");
	return {
		scopeKey,
		fingerprint: String(row.fingerprint),
		directive: directive.data,
		sequence: requiredInteger(row.sequence),
		queuedAtMs: requiredInteger(row.queued_at_ms),
		expiresAtMs: requiredInteger(row.expires_at_ms),
	};
}
