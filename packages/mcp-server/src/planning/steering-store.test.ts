/**
 * The steering audit sink: idempotent appends, conflicts on a saved key, typed failures, redaction, complete
 * payloads, and no environment reads. The SQL port is a deterministic fake that honours the unique key; no database.
 */
import { describe, expect, test } from "bun:test";
import { REDACTED } from "../redact.ts";
import { SteeringInbox, type SteeringAuditEntry, type SteeringDirective } from "./steering.ts";
import {
	SteeringAuditConflictError,
	SteeringAuditError,
	SteeringAuditSink,
	type SteeringAuditRow,
	type SteeringAuditSql,
	type SteeringAuditTransition,
} from "./steering-store.ts";

const HUMAN = "ops.lead";
const WORKER = "worker-a";
const SECRET = "ghp_" + "c".repeat(36);

/** Honours `(directive_id, transition)` uniqueness and keeps the hash of each saved row. `failWith` makes every call reject. */
class FakeAuditSql implements SteeringAuditSql {
	readonly rows: SteeringAuditRow[] = [];
	failWith: unknown = null;
	private readonly hashes = new Map<string, string>();

	async insertAbsent(row: SteeringAuditRow): Promise<boolean> {
		if (this.failWith !== null) throw this.failWith;
		const key = keyOf(row.directiveId, row.transition);
		if (this.hashes.has(key)) return false;
		this.hashes.set(key, row.payloadSha256);
		this.rows.push({ ...row });
		return true;
	}

	async payloadSha256Of(directiveId: string, transition: SteeringAuditTransition): Promise<string | null> {
		if (this.failWith !== null) throw this.failWith;
		return this.hashes.get(keyOf(directiveId, transition)) ?? null;
	}
}

function keyOf(directiveId: string, transition: SteeringAuditTransition): string {
	return `${directiveId}\u0000${transition}`;
}

function directive(overrides: Partial<SteeringDirective> = {}): SteeringDirective {
	return {
		id: "d-1",
		author: { principalId: HUMAN, kind: "human" },
		createdAtMs: 1_000,
		priority: "normal",
		targetSessionId: WORKER,
		action: "pause",
		body: "Hold the 53-01 plan until the review lands.",
		conflictsWithActivePlan: false,
		...overrides,
	};
}

function queuedEntry(overrides: Partial<SteeringDirective> = {}, atMs = 2_000): SteeringAuditEntry {
	return { event: "queued", atMs, directive: directive(overrides) };
}

function acknowledgedEntry(outcome: "applied" | "declined" = "applied", confirmed = false): SteeringAuditEntry {
	return { event: "acknowledged", atMs: 3_000, directiveId: "d-1", targetSessionId: WORKER, outcome, confirmed };
}

describe("SteeringAuditSink: idempotent appends", () => {
	test("the first write inserts one row carrying every field of the directive", async () => {
		const sql = new FakeAuditSql();
		const sink = new SteeringAuditSink(sql);

		const result = await sink.record(queuedEntry({ planRef: { phase: "53", plan: "53-01" } }));

		expect(result).toEqual({ ok: true, value: { inserted: true } });
		expect(sql.rows).toHaveLength(1);
		const [row] = sql.rows;
		expect(row).toMatchObject({
			directiveId: "d-1",
			transition: "queued",
			outcome: null,
			confirmed: null,
			authorPrincipal: HUMAN,
			authorKind: "human",
			targetSessionId: WORKER,
			bodyRedacted: "Hold the 53-01 plan until the review lands.",
			action: "pause",
			priority: "normal",
			planPhase: "53",
			planPlan: "53-01",
			conflictsWithActivePlan: false,
			directiveCreatedAtMs: 1_000,
		});
		expect(row?.recordedAt.getTime()).toBe(2_000);
		expect(row?.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("a repeated write of the same payload is an idempotent success, from a fresh sink over the same store", async () => {
		const sql = new FakeAuditSql();

		const first = await new SteeringAuditSink(sql).record(queuedEntry());
		const second = await new SteeringAuditSink(sql).record(queuedEntry());

		expect(first).toEqual({ ok: true, value: { inserted: true } });
		expect(second).toEqual({ ok: true, value: { inserted: false } });
		expect(sql.rows).toHaveLength(1);
		await expect(new SteeringAuditSink(sql).append(queuedEntry())).resolves.toBeUndefined();
		expect(sql.rows).toHaveLength(1);
	});

	test("queued and acknowledged transitions of one directive are two distinct rows", async () => {
		const sql = new FakeAuditSql();
		const sink = new SteeringAuditSink(sql);

		await sink.append(queuedEntry());
		await sink.append(acknowledgedEntry("declined"));

		expect(sql.rows.map((row) => row.transition)).toEqual(["queued", "acknowledged"]);
		expect(sql.rows[1]).toMatchObject({
			directiveId: "d-1",
			outcome: "declined",
			authorPrincipal: null,
			authorKind: null,
			bodyRedacted: null,
			action: null,
			targetSessionId: WORKER,
		});
	});
});

describe("SteeringAuditSink: a saved key never hides a different payload", () => {
	test("the same key with a different payload is a typed conflict, and the saved row is left as it was", async () => {
		const sql = new FakeAuditSql();
		await new SteeringAuditSink(sql).append(queuedEntry());

		const result = await new SteeringAuditSink(sql).record(queuedEntry({ body: "A different instruction." }));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBeInstanceOf(SteeringAuditConflictError);
		expect(result.error.code).toBe("AUDIT_CONFLICT");
		expect(sql.rows).toHaveLength(1);
		expect(sql.rows[0]?.bodyRedacted).toBe("Hold the 53-01 plan until the review lands.");
	});

	test("append throws the conflict, so the inbox reports audit-unavailable with the code", async () => {
		const sql = new FakeAuditSql();
		await new SteeringAuditSink(sql).append(queuedEntry());
		const inbox = new SteeringInbox({
			history: new SteeringAuditSink(sql),
			clock: { nowMs: () => 1_000_000 },
			policy: { allowlist: [HUMAN], ratePerMin: 10 },
		});

		const result = await inbox.enqueue({ ...directive({ body: "A different instruction." }), createdAtMs: 1_000 });

		expect(result).toEqual({ ok: false, error: { code: "audit-unavailable", attempts: 2, lastErrorCode: "AUDIT_CONFLICT" } });
	});
});

describe("SteeringAuditSink: typed failures", () => {
	test("a failing port surfaces a typed error to the caller and writes nothing", async () => {
		const sql = new FakeAuditSql();
		sql.failWith = Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" });
		const sink = new SteeringAuditSink(sql);

		const result = await sink.record(queuedEntry());

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBeInstanceOf(SteeringAuditError);
		expect(result.error.code).toBe("ECONNRESET");
		expect(sql.rows).toHaveLength(0);
	});

	test("a failing port with no driver code surfaces UNKNOWN, never a silent success", async () => {
		const sql = new FakeAuditSql();
		sql.failWith = new Error("no code here");
		const sink = new SteeringAuditSink(sql);

		await expect(sink.append(queuedEntry())).rejects.toMatchObject({ name: "SteeringAuditError", code: "UNKNOWN" });
	});

	test("the inbox refuses to queue a directive whose audit write fails, and the caller sees the code", async () => {
		const sql = new FakeAuditSql();
		sql.failWith = Object.assign(new Error("connection reset by peer"), { code: "ECONNRESET" });
		const inbox = new SteeringInbox({
			history: new SteeringAuditSink(sql),
			clock: { nowMs: () => 1_000_000 },
			policy: { allowlist: [HUMAN], ratePerMin: 10 },
		});

		const result = await inbox.enqueue(directive());

		expect(result).toEqual({
			ok: false,
			error: { code: "audit-unavailable", attempts: 2, lastErrorCode: "ECONNRESET" },
		});
		expect(inbox.get("d-1")).toBeNull();
		expect(sql.rows).toHaveLength(0);
	});
});

describe("SteeringAuditSink: stored content", () => {
	test("body text containing a secret-shaped value is stored redacted", async () => {
		const sql = new FakeAuditSql();
		const sink = new SteeringAuditSink(sql);

		await sink.append(queuedEntry({ body: `deploy with token ${SECRET} tonight` }));

		const [row] = sql.rows;
		expect(row?.bodyRedacted).toContain(REDACTED);
		expect(row?.bodyRedacted).not.toContain(SECRET);
	});

	test("two directives that differ only in one meaning-bearing field hash differently", async () => {
		const hashOf = async (overrides: Partial<SteeringDirective>): Promise<string | undefined> => {
			const sql = new FakeAuditSql();
			await new SteeringAuditSink(sql).append(queuedEntry(overrides));
			return sql.rows[0]?.payloadSha256;
		};
		const baseline = await hashOf({});

		expect(await hashOf({ action: "redirect" })).not.toBe(baseline);
		expect(await hashOf({ priority: "high" })).not.toBe(baseline);
		expect(await hashOf({ planRef: { phase: "53", plan: "53-01" } })).not.toBe(baseline);
		expect(await hashOf({ conflictsWithActivePlan: true })).not.toBe(baseline);
		expect(await hashOf({ createdAtMs: 1_001 })).not.toBe(baseline);
	});

	test("the payload hash is deterministic for the same fields and differs when a confirm flag changes", async () => {
		const applied = new FakeAuditSql();
		const repeated = new FakeAuditSql();
		const declined = new FakeAuditSql();
		await new SteeringAuditSink(applied).append(acknowledgedEntry("applied", true));
		await new SteeringAuditSink(repeated).append(acknowledgedEntry("applied", true));
		await new SteeringAuditSink(declined).append(acknowledgedEntry("applied", false));

		const hash = applied.rows[0]?.payloadSha256;
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(repeated.rows[0]?.payloadSha256).toBe(hash);
		expect(declined.rows[0]?.payloadSha256).not.toBe(hash);
	});

	test("the sink reads no environment variables", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(process, "env");
		Object.defineProperty(process, "env", {
			configurable: true,
			get(): never {
				throw new Error("environment read");
			},
		});
		try {
			const sql = new FakeAuditSql();
			await expect(new SteeringAuditSink(sql).append(queuedEntry())).resolves.toBeUndefined();
			expect(sql.rows).toHaveLength(1);
		} finally {
			if (descriptor !== undefined) Object.defineProperty(process, "env", descriptor);
		}
	});
});
