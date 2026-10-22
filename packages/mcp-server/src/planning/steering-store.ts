/**
 * The durable audit sink for the steering inbox (phase 53, SOTA-09).
 *
 * `SteeringInbox` appends every `queued` and `acknowledged` transition to a `SteeringHistorySink`.
 * This module is the Postgres-backed implementation of that port, over the append-only table
 * `planning_steering_audit` (migration version 33, see `index-store.ts`).
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
 */
import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { redact } from "../redact.ts";
import { errnoCode } from "./index.ts";
import { STEERING_ACTIONS, type SteeringAuditEntry, type SteeringHistorySink, type SteeringOutcome, type SteeringPriority } from "./steering.ts";

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
	/** The payload hash stored under `(directive_id, transition)`, or null when no row holds that key. */
	payloadSha256Of(directiveId: string, transition: SteeringAuditTransition): Promise<string | null>;
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

export class SteeringAuditSink implements SteeringHistorySink {
	constructor(private readonly sql: SteeringAuditSql) {}

	/** The port method `SteeringInbox` calls. A failed write throws a {@link SteeringAuditFailure}. */
	async append(entry: SteeringAuditEntry): Promise<void> {
		const result = await this.record(entry);
		if (!result.ok) throw result.error;
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
			const stored = await this.sql.payloadSha256Of(row.directiveId, row.transition);
			if (stored === row.payloadSha256) return { ok: true, value: { inserted: false } };
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
			if ((await this.sql.payloadSha256Of(row.directiveId, row.transition)) === row.payloadSha256) {
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
					directive_id, transition, outcome, confirmed, author_principal, author_kind,
					target_session_id, body_redacted, action, priority, plan_phase, plan_plan,
					conflicts_with_active_plan, directive_created_at_ms, payload_sha256, recorded_at
				)
				values (
					${row.directiveId}, ${row.transition}, ${row.outcome}, ${row.confirmed}, ${row.authorPrincipal}, ${row.authorKind},
					${row.targetSessionId}, ${row.bodyRedacted}, ${row.action}, ${row.priority}, ${row.planPhase}, ${row.planPlan},
					${row.conflictsWithActivePlan}, ${row.directiveCreatedAtMs}, ${row.payloadSha256}, ${row.recordedAt}
				)
				on conflict (directive_id, transition) do nothing
				returning id`;
			return written.length === 1;
		},
		async payloadSha256Of(directiveId: string, transition: SteeringAuditTransition): Promise<string | null> {
			const rows = await sql`
				select payload_sha256 from planning_steering_audit
				where directive_id = ${directiveId} and transition = ${transition}`;
			const stored = rows[0]?.payload_sha256;
			return typeof stored === "string" ? stored : null;
		},
	};
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
	const fields = {
		directiveId: entry.directiveId,
		transition: "acknowledged" as const,
		outcome: entry.outcome,
		confirmed: entry.confirmed,
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
	const stored: Record<string, string | number | boolean | null> = {
		...fields,
		recordedAt: fields.recordedAt.toISOString(),
	};
	return createHash("sha256").update(canonicalJson(stored)).digest("hex");
}

/** JSON with keys in code-unit order, so the same fields always produce the same bytes. */
function canonicalJson(fields: Readonly<Record<string, string | number | boolean | null>>): string {
	const sorted: Record<string, string | number | boolean | null> = {};
	for (const key of Object.keys(fields).sort()) sorted[key] = fields[key] ?? null;
	return JSON.stringify(sorted);
}
