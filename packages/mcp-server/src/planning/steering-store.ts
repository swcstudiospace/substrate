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
} from "./steering.ts";

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
	payloadSha256: string;
	recordedAt: Date;
}

/** A row as saved: the payload hash it was written with, and the transition time it carries. */
export interface SteeringSavedRow {
	payloadSha256: string;
	recordedAt: Date;
}

/** The injected SQL port. The Bun-backed adapter is {@link bunSteeringAuditSql}; tests inject a fake. */
export interface SteeringAuditSql {
	/**
	 * Inserts the row unless `(directive_id, transition)` already holds one. Resolves `true` when this call wrote
	 * the row and `false` when the key was already present. Rejects with the driver's error.
	 */
	insertAbsent(row: SteeringAuditRow): Promise<boolean>;
	/** The row saved under `(directive_id, transition)`, or null when no row holds that key. */
	savedRow(directiveId: string, transition: SteeringAuditTransition): Promise<SteeringSavedRow | null>;
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
	queuedAt: Date;
	acknowledgement: SteeringStoredAckRow | null;
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
	acknowledgement?: { atMs: number; outcome: string | null; confirmed: boolean | null; reason?: string };
}

export interface SteeringReadPage {
	entries: SteeringRestoreCandidate[];
	/** True when more rows matched than `limit`. The page holds the first `limit` of them in the stated order. */
	truncated: boolean;
}

export type SteeringReadResult = { ok: true; value: SteeringReadPage } | { ok: false; error: SteeringAuditReadError };

export class SteeringAuditSink implements SteeringHistorySink {
	constructor(
		private readonly sql: SteeringAuditSql,
		private readonly reads: SteeringAuditReadSql | null = null,
	) {}

	/** The port method `SteeringInbox` calls. A failed write throws a {@link SteeringAuditFailure}. */
	async append(entry: SteeringAuditEntry): Promise<void> {
		const result = await this.record(entry);
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

	/** Writes one transition and reports the outcome as a value. A same-payload repeat is `inserted: false`. */
	async record(entry: SteeringAuditEntry): Promise<SteeringAuditResult> {
		let row: SteeringAuditRow;
		try {
			row = toAuditRow(entry);
		} catch (cause) {
			return { ok: false, error: new SteeringAuditError(errnoCode(cause), cause) };
		}
		try {
			if (await this.sql.insertAbsent(row)) return { ok: true, value: { inserted: true } };
			const stored = await this.sql.savedRow(row.directiveId, row.transition);
			if (stored?.payloadSha256 === row.payloadSha256) return { ok: true, value: { inserted: false } };
			return { ok: false, error: new SteeringAuditConflictError(row.directiveId, row.transition) };
		} catch (cause) {
			return this.recoverOrFail(row, cause);
		}
	}

	/**
	 * A failed write may have committed with only its reply lost. The saved row decides: one carrying this payload means
	 * the transition happened, so it is reported as recorded. No such row, or a read-back that also fails, is the original
	 * failure, and the transition stays held for a retry.
	 */
	private async recoverOrFail(row: SteeringAuditRow, cause: unknown): Promise<SteeringAuditResult> {
		try {
			if ((await this.sql.savedRow(row.directiveId, row.transition))?.payloadSha256 === row.payloadSha256) {
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
					conflicts_with_active_plan, directive_created_at_ms, payload_sha256, recorded_at
				)
				values (
					${row.directiveId}, ${row.transition}, ${row.outcome}, ${row.confirmed}, ${row.reason}, ${row.authorPrincipal}, ${row.authorKind},
					${row.targetSessionId}, ${row.bodyRedacted}, ${row.action}, ${row.priority}, ${row.planPhase}, ${row.planPlan},
					${row.conflictsWithActivePlan}, ${row.directiveCreatedAtMs}, ${row.payloadSha256}, ${row.recordedAt}
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
	};
}

/**
 * The Bun SQL read adapter. Both listings are bounded by `limit` and ordered, and neither writes. A queued row with no
 * acknowledged row is open; the unique `(directive_id, transition)` key makes the join at most one row wide.
 */
export function bunSteeringAuditReadSql(sql: SQL): SteeringAuditReadSql {
	return {
		async readOpen(query: SteeringAuditReadQuery): Promise<SteeringStoredDirectiveRow[]> {
			// `after` is the keyset cursor: the page starts strictly after that (creation time, id), in the order below. Null reads from the start.
			const afterMs = query.after?.createdAtMs ?? null;
			const afterId = query.after?.directiveId ?? null;
			const rows = await sql`
				select q.directive_id, q.author_principal, q.author_kind, q.target_session_id, q.body_redacted, q.action, q.priority,
					q.plan_phase, q.plan_plan, q.conflicts_with_active_plan, q.directive_created_at_ms, q.recorded_at
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
					q.plan_phase, q.plan_plan, q.conflicts_with_active_plan, q.directive_created_at_ms, q.recorded_at,
					a.outcome as ack_outcome, a.confirmed as ack_confirmed, a.reason as ack_reason, a.recorded_at as ack_recorded_at
				from planning_steering_audit q
				join planning_steering_audit a on a.directive_id = q.directive_id and a.transition = 'acknowledged'
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
				}),
			);
		},
		async savedAcknowledgement(directiveId: string): Promise<SteeringStoredAckRow | null> {
			const rows = (await sql`
				select outcome, confirmed, reason, recorded_at from planning_steering_audit
				where directive_id = ${directiveId} and transition = 'acknowledged'`) as Array<Record<string, unknown>>;
			const saved = rows[0];
			if (saved === undefined) return null;
			return {
				outcome: textOrNull(saved.outcome),
				confirmed: booleanOrNull(saved.confirmed),
				reason: textOrNull(saved.reason),
				recordedAt: new Date(saved.recorded_at as string | number | Date),
			};
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
	const page = await sink.readOpenDirectives(options);
	if (!page.ok) return page;
	return { ok: true, value: { report: await inbox.restore(page.value.entries), truncated: page.value.truncated } };
}

/** The most pages {@link restoreSteeringInboxPaged} reads when the caller names no cap: with {@link DEFAULT_STEERING_RESTORE_LIMIT} rows each, 50,000 open directives. */
export const DEFAULT_STEERING_RESTORE_MAX_PAGES = 50;

/** Why a paged restore stopped before the open directives were exhausted. `page-cap`: the cap was hit with more still open. `read-failed`: a later page could not be read. `no-cursor`: a page could not name where the next one starts. */
export type SteeringRestoreStop = "page-cap" | "read-failed" | "no-cursor";

export interface SteeringRestorePagedOptions extends SteeringReadOptions {
	/** The most pages read, 1 or more. Absent: {@link DEFAULT_STEERING_RESTORE_MAX_PAGES}. */
	maxPages?: number;
}

export type SteeringRestorePagedResult =
	| { ok: true; value: { report: SteeringRestoreReport; truncated: boolean; pages: number; stoppedBy: SteeringRestoreStop | null } }
	| { ok: false; error: SteeringAuditReadError };

/**
 * The restart path over every page: reads the open directives `options.limit` at a time, oldest first, each page starting
 * after the last directive of the one before (keyset, so a page never repeats and never skips), and loads each into `inbox`.
 * It stops when a page is not cut, or at `maxPages`; a stop with directives still open is a named truncation (`stoppedBy`),
 * never silent. A directive stays open while it is restored, so the cursor, not the read, is what advances. A first page
 * that cannot be read loads nothing and is returned as a value. A later page that cannot be read leaves the earlier pages
 * loaded and reports `stoppedBy: "read-failed"`. Nothing is audited.
 */
export async function restoreSteeringInboxPaged(inbox: SteeringInbox, sink: SteeringAuditSink, options: SteeringRestorePagedOptions): Promise<SteeringRestorePagedResult> {
	const maxPages = options.maxPages ?? DEFAULT_STEERING_RESTORE_MAX_PAGES;
	if (!Number.isSafeInteger(maxPages) || maxPages < 1) return { ok: false, error: new SteeringAuditReadError("INVALID_QUERY", "maxPages must be an integer of 1 or more") };
	const report: SteeringRestoreReport = { restored: [], unchanged: [], skipped: [] };
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
		const loaded = await inbox.restore(page.value.entries);
		report.restored.push(...loaded.restored);
		report.unchanged.push(...loaded.unchanged);
		// An entry's index is within its page: offset it so the merged report points at the entry's place in the whole read.
		const offset = pages * options.limit;
		report.skipped.push(...loaded.skipped.map((skip) => ({ ...skip, index: skip.index + offset })));
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
	return { ok: true, value: { report, truncated: stoppedBy !== null, pages, stoppedBy } };
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

/** `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE`: on or 1/true/yes creates the audit table at `migrate()`. Anything else is off. */
export function steeringAuditTableEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
	return /^(1|true|yes|on)$/i.test(env[STEERING_AUDIT_TABLE_ENV]?.trim() ?? "");
}

function toAuditRow(entry: SteeringAuditEntry): SteeringAuditRow {
	const recordedAt = recordedAtOf(entry.atMs);
	if (entry.event === "queued") {
		const { directive } = entry;
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
		recordedAt,
	};
	return { ...fields, payloadSha256: payloadSha256(fields) };
}

function recordedAtOf(atMs: number): Date {
	if (!Number.isSafeInteger(atMs) || atMs < 0) throw new RangeError("audit atMs must be a non-negative integer");
	return new Date(atMs);
}

/** SHA-256 over the canonical JSON of the stored fields. `recordedAt` enters as its ISO-8601 text. */
function payloadSha256(fields: Omit<SteeringAuditRow, "payloadSha256">): string {
	const { reason, ...rest } = fields;
	const stored: Record<string, string | number | boolean | null> = {
		...rest,
		recordedAt: fields.recordedAt.toISOString(),
	};
	// Part of the hash whenever present, so a changed reason under one key is a conflict. Omitted when null, so a row hashed
	// before the column existed keeps its hash and a same-payload retry of it still matches.
	if (reason !== null) stored.reason = reason;
	return createHash("sha256").update(canonicalJson(stored)).digest("hex");
}

/** JSON with keys in code-unit order, so the same fields always produce the same bytes. */
function canonicalJson(fields: Readonly<Record<string, string | number | boolean | null>>): string {
	const sorted: Record<string, string | number | boolean | null> = {};
	for (const key of Object.keys(fields).sort()) sorted[key] = fields[key] ?? null;
	return JSON.stringify(sorted);
}
