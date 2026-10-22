/**
 * The durable audit sink for the steering inbox (phase 53, SOTA-09).
 *
 * `SteeringInbox` appends every `queued` and `acknowledged` transition to a `SteeringHistorySink`.
 * This module is the Postgres-backed implementation of that port, over the append-only table
 * `planning_steering_audit` (migration version 33, see `index-store.ts`).
 *
 * What it guarantees:
 * - Append-only. There is no update or delete method, and none is needed.
 * - Idempotent. The unique key `(directive_id, transition)` makes a repeated write a no-op. The SQL
 *   port reports whether a row was written, and a repeat is `inserted: false`, never an error.
 * - Redacted. The body is passed through the shared `redact()` before it is stored.
 * - Tamper-evident. `payload_sha256` is the SHA-256 of the canonical JSON of the stored fields.
 * - Never swallowed. A failed write returns a `SteeringAuditError` carrying the driver's error code.
 *   `append` throws that same error, so `SteeringInbox` reports `audit-unavailable` with the code.
 * - No environment reads. The sink receives its SQL port by injection and reads nothing else.
 */
import { createHash } from "node:crypto";
import type { SQL } from "bun";
import { redact } from "../redact.ts";
import { errnoCode } from "./index.ts";
import type { SteeringAuditEntry, SteeringHistorySink, SteeringOutcome } from "./steering.ts";

export const STEERING_AUDIT_TABLE = "planning_steering_audit";

export type SteeringAuditTransition = "queued" | "acknowledged";
export type SteeringAuthorKind = "human" | "agent";

/**
 * One row as the SQL port writes it. An `acknowledged` row carries no author and no body: the
 * acknowledgement entry names only the directive, and the directive's author and body live on its
 * `queued` row.
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
	payloadSha256: string;
	recordedAt: Date;
}

/** The injected SQL port. The Bun-backed adapter is {@link bunSteeringAuditSql}; tests inject a fake. */
export interface SteeringAuditSql {
	/**
	 * Inserts the row unless `(directive_id, transition)` already holds one. Resolves `true` when this
	 * call wrote the row and `false` when the key was already present. Rejects with the driver's error.
	 */
	insertAbsent(row: SteeringAuditRow): Promise<boolean>;
}

/** A failed audit write. `code` is the driver's error code, or `UNKNOWN` when the cause carries none. */
export class SteeringAuditError extends Error {
	readonly code: string;

	constructor(code: string, cause: unknown) {
		super("steering audit write failed", { cause });
		this.name = "SteeringAuditError";
		this.code = code;
	}
}

export type SteeringAuditResult = { ok: true; value: { inserted: boolean } } | { ok: false; error: SteeringAuditError };

export class SteeringAuditSink implements SteeringHistorySink {
	constructor(private readonly sql: SteeringAuditSql) {}

	/** The port method `SteeringInbox` calls. A failed write throws a {@link SteeringAuditError}. */
	async append(entry: SteeringAuditEntry): Promise<void> {
		const result = await this.record(entry);
		if (!result.ok) throw result.error;
	}

	/** Writes one transition and reports the outcome as a value, for callers that do not use the port. */
	async record(entry: SteeringAuditEntry): Promise<SteeringAuditResult> {
		try {
			const row = toAuditRow(entry);
			const inserted = await this.sql.insertAbsent(row);
			return { ok: true, value: { inserted } };
		} catch (cause) {
			return { ok: false, error: new SteeringAuditError(errnoCode(cause), cause) };
		}
	}
}

/** The Bun SQL adapter. The statement is idempotent: a row that already exists is left untouched. */
export function bunSteeringAuditSql(sql: SQL): SteeringAuditSql {
	return {
		async insertAbsent(row: SteeringAuditRow): Promise<boolean> {
			const written = await sql`
				insert into planning_steering_audit (
					directive_id, transition, outcome, confirmed, author_principal, author_kind,
					target_session_id, body_redacted, payload_sha256, recorded_at
				)
				values (
					${row.directiveId}, ${row.transition}, ${row.outcome}, ${row.confirmed}, ${row.authorPrincipal}, ${row.authorKind},
					${row.targetSessionId}, ${row.bodyRedacted}, ${row.payloadSha256}, ${row.recordedAt}
				)
				on conflict (directive_id, transition) do nothing
				returning id`;
			return written.length === 1;
		},
	};
}

function toAuditRow(entry: SteeringAuditEntry): SteeringAuditRow {
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
			recordedAt: recordedAtOf(entry.atMs),
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
		recordedAt: recordedAtOf(entry.atMs),
	};
	return { ...fields, payloadSha256: payloadSha256(fields) };
}

function recordedAtOf(atMs: number): Date {
	if (!Number.isSafeInteger(atMs) || atMs < 0) throw new RangeError("audit atMs must be a non-negative integer");
	return new Date(atMs);
}

/** SHA-256 over the canonical JSON of the stored fields. `recordedAt` enters as its ISO-8601 text. */
function payloadSha256(fields: Omit<SteeringAuditRow, "payloadSha256">): string {
	const stored: Record<string, string | boolean | null> = {
		...fields,
		recordedAt: fields.recordedAt.toISOString(),
	};
	return createHash("sha256").update(canonicalJson(stored)).digest("hex");
}

/** JSON with keys in code-unit order, so the same fields always produce the same bytes. */
function canonicalJson(fields: Readonly<Record<string, string | boolean | null>>): string {
	const sorted: Record<string, string | boolean | null> = {};
	for (const key of Object.keys(fields).sort()) sorted[key] = fields[key] ?? null;
	return JSON.stringify(sorted);
}
