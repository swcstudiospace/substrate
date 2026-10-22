/**
 * The steering audit sink: idempotent appends, conflicts on a saved key, typed failures, redaction, complete
 * payloads, and no environment reads. The SQL port is a deterministic fake that honours the unique key; no database.
 */
import { describe, expect, test } from "bun:test";
import { REDACTED } from "../redact.ts";
import { STEERING_RETRY_STATE_MAX, SteeringInbox, type SteeringAuditEntry, type SteeringDirective } from "./steering.ts";
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

/**
 * Honours `(directive_id, transition)` uniqueness and keeps the hash of each saved row. `failWith` makes every call reject.
 * `failInsert` rejects an insert before it commits. `loseReplyAfterCommit` commits the insert, then rejects its reply.
 */
class FakeAuditSql implements SteeringAuditSql {
	readonly rows: SteeringAuditRow[] = [];
	failWith: unknown = null;
	failInsert: unknown = null;
	loseReplyAfterCommit = false;
	/** Rejects the read-back only, so a committed row can be left unconfirmed. */
	failReadBack: unknown = null;
	private readonly hashes = new Map<string, string>();

	async insertAbsent(row: SteeringAuditRow): Promise<boolean> {
		if (this.failWith !== null) throw this.failWith;
		if (this.failInsert !== null) throw this.failInsert;
		const key = keyOf(row.directiveId, row.transition);
		if (this.hashes.has(key)) return false;
		this.hashes.set(key, row.payloadSha256);
		this.rows.push({ ...row });
		if (this.loseReplyAfterCommit) throw Object.assign(new Error("reply lost after commit"), { code: "ECONNRESET" });
		return true;
	}

	async payloadSha256Of(directiveId: string, transition: SteeringAuditTransition): Promise<string | null> {
		if (this.failReadBack !== null) throw this.failReadBack;
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

describe("SteeringAuditSink: a lost reply after a committed write", () => {
	const inboxOver = (sql: FakeAuditSql) =>
		new SteeringInbox({
			history: new SteeringAuditSink(sql),
			clock: { nowMs: () => 1_000_000 },
			policy: { allowlist: [HUMAN], ratePerMin: 10 },
		});

	test("a committed insert whose reply was lost resolves to acknowledged, not left queued", async () => {
		const sql = new FakeAuditSql();
		const inbox = inboxOver(sql);
		expect((await inbox.enqueue(directive())).ok).toBe(true);
		sql.loseReplyAfterCommit = true;

		const result = await inbox.acknowledge({ directiveId: "d-1", sessionId: WORKER, outcome: "declined" });

		expect(result.ok).toBe(true);
		expect(inbox.get("d-1")).toMatchObject({ state: "acknowledged", outcome: "declined" });
		expect(sql.rows.map((row) => row.transition)).toEqual(["queued", "acknowledged"]);
	});

	test("an absent row leaves the directive queued, and a later attempt acknowledges it", async () => {
		const sql = new FakeAuditSql();
		const inbox = inboxOver(sql);
		expect((await inbox.enqueue(directive())).ok).toBe(true);
		sql.failInsert = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });

		expect(await inbox.acknowledge({ directiveId: "d-1", sessionId: WORKER, outcome: "declined" })).toEqual({
			ok: false,
			error: { code: "audit-unavailable", attempts: 2, lastErrorCode: "ECONNRESET" },
		});
		expect(inbox.get("d-1")).toMatchObject({ state: "queued" });

		sql.failInsert = null;
		expect((await inbox.acknowledge({ directiveId: "d-1", sessionId: WORKER, outcome: "declined" })).ok).toBe(true);
		expect(inbox.get("d-1")).toMatchObject({ state: "acknowledged" });
	});
});

describe("SteeringAuditSink: a retry after a lost reply keeps the acknowledgement's content", () => {
	test("a retry after a lost reply uses the same time and hash, and resolves to acknowledged with no AUDIT_CONFLICT", async () => {
		const sql = new FakeAuditSql();
		let now = 1_000_000;
		const inbox = new SteeringInbox({
			history: new SteeringAuditSink(sql),
			clock: { nowMs: () => now },
			policy: { allowlist: [HUMAN], ratePerMin: 10 },
		});
		expect((await inbox.enqueue(directive())).ok).toBe(true);

		// The first acknowledgement commits, loses its reply, and cannot confirm the row: both attempts fail.
		sql.loseReplyAfterCommit = true;
		sql.failReadBack = Object.assign(new Error("read-back reset"), { code: "ECONNRESET" });
		now = 2_000;
		expect((await inbox.acknowledge({ directiveId: "d-1", sessionId: WORKER, outcome: "declined" })).ok).toBe(false);
		expect(inbox.get("d-1")).toMatchObject({ state: "queued" });

		// The retry happens later, on a clock that has moved on, and the database is healthy again.
		sql.loseReplyAfterCommit = false;
		sql.failReadBack = null;
		now = 5_000;
		const retried = await inbox.acknowledge({ directiveId: "d-1", sessionId: WORKER, outcome: "declined" });

		expect(retried.ok).toBe(true);
		expect(inbox.get("d-1")).toMatchObject({ state: "acknowledged", acknowledgedAtMs: 2_000 });
		const acknowledgedRows = sql.rows.filter((row) => row.transition === "acknowledged");
		expect(acknowledgedRows).toHaveLength(1);
		expect(acknowledgedRows[0]?.recordedAt.getTime()).toBe(2_000);
	});
});

describe("SteeringAuditSink: a queue retry after a lost reply keeps the queue's time", () => {
	test("a queue retry after a failed attempt uses the same time and hash, and succeeds with no AUDIT_CONFLICT", async () => {
		const sql = new FakeAuditSql();
		let now = 1_000_000;
		const inbox = new SteeringInbox({
			history: new SteeringAuditSink(sql),
			clock: { nowMs: () => now },
			policy: { allowlist: [HUMAN], ratePerMin: 10 },
		});

		// The queue row commits, loses its reply, and cannot be confirmed: both attempts fail.
		sql.loseReplyAfterCommit = true;
		sql.failReadBack = Object.assign(new Error("read-back reset"), { code: "ECONNRESET" });
		now = 2_000;
		expect(await inbox.enqueue(directive())).toMatchObject({ ok: false, error: { code: "audit-unavailable" } });
		expect(inbox.get("d-1")).toBeNull();

		// The retry happens later, on a moved clock, with the database healthy again.
		sql.loseReplyAfterCommit = false;
		sql.failReadBack = null;
		now = 5_000;
		const retried = await inbox.enqueue(directive());

		expect(retried.ok).toBe(true);
		expect(inbox.get("d-1")).toMatchObject({ state: "queued", queuedAtMs: 2_000 });
		const queuedRows = sql.rows.filter((row) => row.transition === "queued");
		expect(queuedRows).toHaveLength(1);
		expect(queuedRows[0]?.recordedAt.getTime()).toBe(2_000);
	});
});

describe("SteeringInbox: retry state stays bounded while the sink is down", () => {
	test("a sink that stays down through a thousand failed queues keeps the retry state under the cap, and a recovered sink accepts a retry with the same time", async () => {
		const sql = new FakeAuditSql();
		let now = 1_000_000;
		const inbox = new SteeringInbox({
			history: new SteeringAuditSink(sql),
			clock: { nowMs: () => now },
			policy: { allowlist: [HUMAN], ratePerMin: 10 },
		});
		sql.failWith = Object.assign(new Error("sink down"), { code: "ECONNRESET" });

		let lastFailedAtMs = now;
		for (let i = 0; i < 1000; i++) {
			now += 1;
			lastFailedAtMs = now;
			expect((await inbox.enqueue(directive({ id: `down-${i}` }))).ok).toBe(false);
		}
		expect(inbox.retryStateSize()).toBeLessThanOrEqual(STEERING_RETRY_STATE_MAX);

		// The sink recovers. The most recent failure is still within the cap, so its retry keeps the time it first used.
		sql.failWith = null;
		now += 10_000;
		expect((await inbox.enqueue(directive({ id: "down-999" }))).ok).toBe(true);
		expect(inbox.get("down-999")).toMatchObject({ state: "queued", queuedAtMs: lastFailedAtMs });
	});
});
