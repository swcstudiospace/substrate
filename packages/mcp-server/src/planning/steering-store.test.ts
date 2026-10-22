/**
 * The steering audit sink: idempotent appends, typed failures, redaction, and no environment reads.
 * The SQL port is a deterministic fake that honours the unique key; no database is touched.
 */
import { describe, expect, test } from "bun:test";
import { REDACTED } from "../redact.ts";
import { SteeringInbox, type SteeringAuditEntry, type SteeringDirective } from "./steering.ts";
import {
	SteeringAuditError,
	SteeringAuditSink,
	type SteeringAuditRow,
	type SteeringAuditSql,
} from "./steering-store.ts";

const HUMAN = "ops.lead";
const WORKER = "worker-a";
const SECRET = "ghp_" + "c".repeat(36);

/** Honours `(directive_id, transition)` uniqueness. `failWith` makes every call reject until cleared. */
class FakeAuditSql implements SteeringAuditSql {
	readonly rows: SteeringAuditRow[] = [];
	failWith: unknown = null;
	private readonly keys = new Set<string>();

	async insertAbsent(row: SteeringAuditRow): Promise<boolean> {
		if (this.failWith !== null) throw this.failWith;
		const key = `${row.directiveId}\u0000${row.transition}`;
		if (this.keys.has(key)) return false;
		this.keys.add(key);
		this.rows.push({ ...row });
		return true;
	}
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

function acknowledgedEntry(outcome: "applied" | "declined" = "applied", atMs = 3_000): SteeringAuditEntry {
	return { event: "acknowledged", atMs, directiveId: "d-1", targetSessionId: WORKER, outcome, confirmed: false };
}

describe("SteeringAuditSink: idempotent appends", () => {
	test("the first write inserts one row carrying the directive's stored fields", async () => {
		const sql = new FakeAuditSql();
		const sink = new SteeringAuditSink(sql);

		const result = await sink.record(queuedEntry());

		expect(result).toEqual({ ok: true, value: { inserted: true } });
		expect(sql.rows).toHaveLength(1);
		const [row] = sql.rows;
		expect(row).toMatchObject({
			directiveId: "d-1",
			transition: "queued",
			outcome: null,
			authorPrincipal: HUMAN,
			authorKind: "human",
			targetSessionId: WORKER,
			bodyRedacted: "Hold the 53-01 plan until the review lands.",
		});
		expect(row?.recordedAt.getTime()).toBe(2_000);
		expect(row?.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("a repeated write of the same (directive_id, transition) is a no-op and reports no error", async () => {
		const sql = new FakeAuditSql();
		const sink = new SteeringAuditSink(sql);

		const first = await sink.record(queuedEntry());
		const second = await sink.record(queuedEntry());

		expect(first).toEqual({ ok: true, value: { inserted: true } });
		expect(second).toEqual({ ok: true, value: { inserted: false } });
		expect(sql.rows).toHaveLength(1);
		await expect(sink.append(queuedEntry())).resolves.toBeUndefined();
		expect(sql.rows).toHaveLength(1);
	});

	test("queued and acknowledged transitions of one directive are two distinct rows", async () => {
		const sql = new FakeAuditSql();
		const sink = new SteeringAuditSink(sql);

		await sink.append(queuedEntry());
		await sink.append(acknowledgedEntry("declined"));

		expect(sql.rows.map((row) => row.transition)).toEqual(["queued", "acknowledged"]);
		const acknowledged = sql.rows[1];
		expect(acknowledged).toMatchObject({
			directiveId: "d-1",
			outcome: "declined",
			authorPrincipal: null,
			authorKind: null,
			bodyRedacted: null,
			targetSessionId: WORKER,
		});
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

	test("the payload hash is deterministic and changes when a stored field changes", async () => {
		const applied = new FakeAuditSql();
		const repeated = new FakeAuditSql();
		const declined = new FakeAuditSql();
		await new SteeringAuditSink(applied).append(acknowledgedEntry("applied"));
		await new SteeringAuditSink(repeated).append(acknowledgedEntry("applied"));
		await new SteeringAuditSink(declined).append(acknowledgedEntry("declined"));

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
