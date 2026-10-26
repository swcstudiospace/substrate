/**
 * The durable steering inbox (phase 58): the audit log rebuilds the inbox after a restart, and a directive nobody acknowledges
 * expires to `declined:timeout`. Every collaborator is deterministic: a fake SQL port that honours the unique key and answers
 * the read port from its own rows, and an injected clock. No database, no network, no timers.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_STEERING_ACK_TTL_S,
	DEFAULT_STEERING_EXPIRY_SWEEP_S,
	STEERING_ACK_TTL_BOUNDS_S,
	STEERING_ACK_TTL_ENV,
	STEERING_AUDIT_ATTEMPTS,
	STEERING_EXPIRY_BATCH,
	STEERING_EXPIRY_SWEEP_BOUNDS_S,
	STEERING_EXPIRY_SWEEP_ENV,
	SteeringInbox,
	loadSteeringExpirySettings,
	type SteeringAuditEntry,
	type SteeringClock,
	type SteeringHistorySink,
} from "./steering.ts";
import {
	SteeringAuditConflictError,
	SteeringAuditReadError,
	SteeringAuditSink,
	STEERING_READ_LIMIT_MAX,
	restoreSteeringInbox,
	type SteeringAuditReadQuery,
	type SteeringAuditReadSql,
	type SteeringAuditRow,
	type SteeringAuditSql,
	type SteeringAuditTransition,
	type SteeringSavedRow,
	type SteeringStoredAckRow,
	type SteeringStoredDirectiveRow,
} from "./steering-store.ts";
import { listSteering } from "./steering-tools.ts";

const HUMAN = "ops.lead";
const WORKER = "worker-a";
const OTHER = "worker-b";
const T0 = 1_000_000;
const TTL = 10_000;

class ManualClock implements SteeringClock {
	constructor(private now: number) {}
	nowMs(): number {
		return this.now;
	}
}

/** Honours `(directive_id, transition)` uniqueness, and answers the read port from the rows it holds. */
class DurableSql implements SteeringAuditSql, SteeringAuditReadSql {
	readonly rows: SteeringAuditRow[] = [];
	failInsert: unknown = null;
	failReads: unknown = null;
	insertAttempts = 0;

	async insertAbsent(row: SteeringAuditRow): Promise<boolean> {
		this.insertAttempts += 1;
		if (this.failInsert !== null) throw this.failInsert;
		if (this.find(row.directiveId, row.transition) !== undefined) return false;
		this.rows.push({ ...row });
		return true;
	}

	async savedRow(directiveId: string, transition: SteeringAuditTransition): Promise<SteeringSavedRow | null> {
		const row = this.find(directiveId, transition);
		return row === undefined ? null : { payloadSha256: row.payloadSha256, recordedAt: row.recordedAt };
	}

	async readOpen(query: SteeringAuditReadQuery): Promise<SteeringStoredDirectiveRow[]> {
		if (this.failReads !== null) throw this.failReads;
		return this.queued(query.sessionId)
			.filter((row) => this.find(row.directiveId, "acknowledged") === undefined)
			.sort((a, b) => (a.directiveCreatedAtMs ?? 0) - (b.directiveCreatedAtMs ?? 0) || compare(a.directiveId, b.directiveId))
			.slice(0, query.limit)
			.map((row) => stored(row, null));
	}

	async readClosed(query: SteeringAuditReadQuery): Promise<SteeringStoredDirectiveRow[]> {
		if (this.failReads !== null) throw this.failReads;
		const closed: Array<{ row: SteeringAuditRow; ack: SteeringAuditRow }> = [];
		for (const row of this.queued(query.sessionId)) {
			const ack = this.find(row.directiveId, "acknowledged");
			if (ack !== undefined) closed.push({ row, ack });
		}
		return closed
			.sort((a, b) => b.ack.recordedAt.getTime() - a.ack.recordedAt.getTime() || compare(b.row.directiveId, a.row.directiveId))
			.slice(0, query.limit)
			.map(({ row, ack }) => stored(row, storedAck(ack)));
	}

	async savedAcknowledgement(directiveId: string): Promise<SteeringStoredAckRow | null> {
		if (this.failReads !== null) throw this.failReads;
		const ack = this.find(directiveId, "acknowledged");
		return ack === undefined ? null : storedAck(ack);
	}

	/** A row written behind the sink's back, as another process or a bad edit would. */
	seed(row: SteeringAuditRow): void {
		this.rows.push(row);
	}

	acknowledgedRows(): SteeringAuditRow[] {
		return this.rows.filter((row) => row.transition === "acknowledged");
	}

	private find(directiveId: string, transition: SteeringAuditTransition): SteeringAuditRow | undefined {
		return this.rows.find((row) => row.directiveId === directiveId && row.transition === transition);
	}

	private queued(sessionId: string | null): SteeringAuditRow[] {
		return this.rows.filter((row) => row.transition === "queued" && (sessionId === null || row.targetSessionId === sessionId));
	}
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function storedAck(row: SteeringAuditRow): SteeringStoredAckRow {
	return { outcome: row.outcome, confirmed: row.confirmed, reason: row.reason, recordedAt: row.recordedAt };
}

function stored(row: SteeringAuditRow, acknowledgement: SteeringStoredAckRow | null): SteeringStoredDirectiveRow {
	return {
		directiveId: row.directiveId,
		authorPrincipal: row.authorPrincipal,
		authorKind: row.authorKind,
		targetSessionId: row.targetSessionId,
		bodyRedacted: row.bodyRedacted,
		action: row.action,
		priority: row.priority,
		planPhase: row.planPhase,
		planPlan: row.planPlan,
		conflictsWithActivePlan: row.conflictsWithActivePlan,
		directiveCreatedAtMs: row.directiveCreatedAtMs,
		queuedAt: row.recordedAt,
		acknowledgement,
	};
}

function queuedRow(overrides: Partial<SteeringAuditRow> = {}): SteeringAuditRow {
	return {
		directiveId: "d-1",
		transition: "queued",
		outcome: null,
		confirmed: null,
		reason: null,
		authorPrincipal: HUMAN,
		authorKind: "human",
		targetSessionId: WORKER,
		bodyRedacted: "Hold the plan until the review lands.",
		action: "pause",
		priority: "normal",
		planPhase: null,
		planPlan: null,
		conflictsWithActivePlan: false,
		directiveCreatedAtMs: 1_000,
		payloadSha256: "seeded",
		recordedAt: new Date(T0),
		...overrides,
	};
}

function directive(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "d-1",
		author: { principalId: HUMAN, kind: "human" },
		createdAtMs: 1_000,
		priority: "normal",
		targetSessionId: WORKER,
		action: "pause",
		body: "Hold the plan until the review lands.",
		conflictsWithActivePlan: false,
		...overrides,
	};
}

interface ServerProcess {
	inbox: SteeringInbox;
	sink: SteeringAuditSink;
}

/** One server process: an inbox over the shared store, with its own memory. */
function processOver(sql: DurableSql, clock: SteeringClock, options: { ackTtlMs?: number | null } = {}): ServerProcess {
	const sink = new SteeringAuditSink(sql, sql);
	const ackTtlMs = options.ackTtlMs === null ? undefined : (options.ackTtlMs ?? TTL);
	const inbox = new SteeringInbox({
		history: sink,
		clock,
		policy: { allowlist: [HUMAN], ratePerMin: 100, ...(ackTtlMs === undefined ? {} : { ackTtlMs }) },
	});
	return { inbox, sink };
}

class CountingHistory implements SteeringHistorySink {
	readonly appended: SteeringAuditEntry[] = [];
	async append(entry: SteeringAuditEntry): Promise<void> {
		this.appended.push(entry);
	}
}

describe("restore from the audit log", () => {
	test("a restart reloads queued directives, in priority order, and writes no audit row", async () => {
		const sql = new DurableSql();
		const before = processOver(sql, new ManualClock(T0));
		expect((await before.inbox.enqueue(directive({ id: "d-1" }))).ok).toBe(true);
		expect((await before.inbox.enqueue(directive({ id: "d-2", priority: "high", createdAtMs: 2_000 }))).ok).toBe(true);
		const rowsBefore = sql.rows.length;

		const after = processOver(sql, new ManualClock(T0 + 5));
		const restored = await restoreSteeringInbox(after.inbox, after.sink, { limit: 10 });

		expect(restored).toEqual({ ok: true, value: { report: { restored: ["d-1", "d-2"], unchanged: [], skipped: [] }, truncated: false } });
		expect(after.inbox.pendingFor(WORKER).map((entry) => entry.id)).toEqual(["d-2", "d-1"]);
		expect(after.inbox.get("d-1")).toMatchObject({ state: "queued", queuedAtMs: T0 });
		expect(sql.rows).toHaveLength(rowsBefore);
		expect(sql.insertAttempts).toBe(rowsBefore);
	});

	test("open directives exclude acknowledged ones, which come back through readRecent with their outcome", async () => {
		const sql = new DurableSql();
		const before = processOver(sql, new ManualClock(T0));
		await before.inbox.enqueue(directive({ id: "d-1" }));
		await before.inbox.enqueue(directive({ id: "d-2", createdAtMs: 2_000 }));
		expect((await before.inbox.acknowledge({ directiveId: "d-2", sessionId: WORKER, outcome: "declined" })).ok).toBe(true);

		const after = processOver(sql, new ManualClock(T0 + 50));
		const open = await restoreSteeringInbox(after.inbox, after.sink, { limit: 10 });
		expect(open).toMatchObject({ ok: true, value: { report: { restored: ["d-1"] } } });
		expect(after.inbox.get("d-2")).toBeNull();

		const recent = await after.sink.readRecent({ limit: 10 });
		expect(recent.ok).toBe(true);
		if (!recent.ok) return;
		expect((await after.inbox.restore(recent.value.entries)).restored).toEqual(["d-2"]);
		expect(after.inbox.get("d-2")).toMatchObject({ state: "acknowledged", outcome: "declined", confirmed: false, acknowledgedAtMs: T0 });
		expect(after.inbox.get("d-2")).not.toHaveProperty("reason");
		expect(after.inbox.pendingFor(WORKER).map((entry) => entry.id)).toEqual(["d-1"]);
	});

	test("a malformed row is skipped and named by field path, and the sound rows still load", async () => {
		const sql = new DurableSql();
		sql.seed(queuedRow({ directiveId: "bad-action", action: null, directiveCreatedAtMs: 1 }));
		sql.seed(queuedRow({ directiveId: "bad-author", authorKind: "agent", directiveCreatedAtMs: 2 }));
		sql.seed(queuedRow({ directiveId: "good", directiveCreatedAtMs: 3 }));
		const { inbox, sink } = processOver(sql, new ManualClock(T0));

		const restored = await restoreSteeringInbox(inbox, sink, { limit: 10 });

		expect(restored).toEqual({
			ok: true,
			value: {
				truncated: false,
				report: {
					restored: ["good"],
					unchanged: [],
					skipped: [
						{ index: 0, directiveId: "bad-action", code: "invalid-entry", issues: ["directive.action"] },
						{ index: 1, directiveId: "bad-author", code: "agent-author-refused", issues: [] },
					],
				},
			},
		});
		expect(inbox.get("bad-action")).toBeNull();
		expect(inbox.get("bad-author")).toBeNull();
		expect(inbox.get("good")).toMatchObject({ state: "queued" });
	});

	test("restore never throws on garbage and reports an ill-formed id as null", async () => {
		const { inbox } = processOver(new DurableSql(), new ManualClock(T0));

		const report = await inbox.restore([null, 42, "text", { directive: { id: "ok" } }, { directive: { id: "not valid!" } }]);

		expect(report.restored).toEqual([]);
		expect(report.skipped.map((skip) => [skip.index, skip.directiveId, skip.code])).toEqual([
			[0, null, "invalid-entry"],
			[1, null, "invalid-entry"],
			[2, null, "invalid-entry"],
			[3, "ok", "invalid-entry"],
			[4, null, "invalid-entry"],
		]);
	});

	test("restore is idempotent, upgrades a queued record to acknowledged, and never downgrades", async () => {
		const { inbox } = processOver(new DurableSql(), new ManualClock(T0));
		const queued = { directive: directive(), queuedAtMs: T0 };
		const acknowledged = { ...queued, acknowledgement: { atMs: T0 + 9, outcome: "applied", confirmed: true } };

		expect((await inbox.restore([queued])).restored).toEqual(["d-1"]);
		expect(await inbox.restore([queued])).toMatchObject({ restored: [], unchanged: ["d-1"] });
		expect((await inbox.restore([acknowledged])).restored).toEqual(["d-1"]);
		expect(inbox.get("d-1")).toMatchObject({ state: "acknowledged", outcome: "applied", confirmed: true, acknowledgedAtMs: T0 + 9 });
		expect(await inbox.restore([queued, acknowledged])).toMatchObject({ restored: [], unchanged: ["d-1", "d-1"] });
		expect(inbox.get("d-1")?.state).toBe("acknowledged");
	});

	test("restore never audits: a sink that rejects every append is never called", async () => {
		const inbox = new SteeringInbox({
			history: {
				append: async () => {
					throw new Error("restore must not audit");
				},
			},
			clock: new ManualClock(T0),
			policy: { allowlist: [HUMAN], ratePerMin: 10 },
		});

		expect((await inbox.restore([{ directive: directive(), queuedAtMs: T0 }])).restored).toEqual(["d-1"]);
	});

	test("the session filter reads only that session's directives", async () => {
		const sql = new DurableSql();
		sql.seed(queuedRow({ directiveId: "a-1", targetSessionId: WORKER, directiveCreatedAtMs: 1 }));
		sql.seed(queuedRow({ directiveId: "b-1", targetSessionId: OTHER, directiveCreatedAtMs: 2 }));
		const { inbox, sink } = processOver(sql, new ManualClock(T0));

		const restored = await restoreSteeringInbox(inbox, sink, { sessionId: OTHER, limit: 10 });

		expect(restored).toMatchObject({ ok: true, value: { report: { restored: ["b-1"] } } });
		expect(inbox.get("a-1")).toBeNull();
	});

	test("a page is bounded, oldest creation time first then by id, and says when it was cut", async () => {
		const sql = new DurableSql();
		sql.seed(queuedRow({ directiveId: "d-b", directiveCreatedAtMs: 5 }));
		sql.seed(queuedRow({ directiveId: "d-a", directiveCreatedAtMs: 5 }));
		sql.seed(queuedRow({ directiveId: "d-0", directiveCreatedAtMs: 9 }));
		const { sink } = processOver(sql, new ManualClock(T0));

		const cut = await sink.readOpenDirectives({ limit: 2 });
		const whole = await sink.readOpenDirectives({ limit: 3 });

		expect(cut.ok && cut.value.truncated).toBe(true);
		expect(cut.ok && cut.value.entries.map((entry) => entry.directive.id)).toEqual(["d-a", "d-b"]);
		expect(whole.ok && whole.value.truncated).toBe(false);
		expect(whole.ok && whole.value.entries.map((entry) => entry.directive.id)).toEqual(["d-a", "d-b", "d-0"]);
	});

	test("recent closed directives come newest acknowledgement first", async () => {
		const sql = new DurableSql();
		for (const [id, ackAt] of [["d-1", 10], ["d-2", 30], ["d-3", 20]] as const) {
			sql.seed(queuedRow({ directiveId: id }));
			sql.seed(queuedRow({ directiveId: id, transition: "acknowledged", outcome: "applied", confirmed: false, authorPrincipal: null, authorKind: null, bodyRedacted: null, action: null, priority: null, conflictsWithActivePlan: null, directiveCreatedAtMs: null, recordedAt: new Date(ackAt) }));
		}
		const { sink } = processOver(sql, new ManualClock(T0));

		const recent = await sink.readRecent({ limit: 2 });

		expect(recent.ok && recent.value.entries.map((entry) => entry.directive.id)).toEqual(["d-2", "d-3"]);
		expect(recent.ok && recent.value.truncated).toBe(true);
	});

	test("a read refuses a bad query, reports a missing port, and carries the driver's code on failure", async () => {
		const sql = new DurableSql();
		const { sink } = processOver(sql, new ManualClock(T0));

		for (const limit of [0, -1, 1.5, STEERING_READ_LIMIT_MAX + 1, Number.NaN]) {
			const result = await sink.readOpenDirectives({ limit });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("INVALID_QUERY");
		}
		const badSession = await sink.readOpenDirectives({ sessionId: "has space", limit: 1 });
		expect(badSession.ok === false && badSession.error.code).toBe("INVALID_QUERY");

		const writeOnly = await new SteeringAuditSink(sql).readOpenDirectives({ limit: 1 });
		expect(writeOnly.ok === false && writeOnly.error).toBeInstanceOf(SteeringAuditReadError);
		expect(writeOnly.ok === false && writeOnly.error.code).toBe("READ_UNAVAILABLE");

		sql.failReads = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
		const driver = await sink.readOpenDirectives({ limit: 1 });
		expect(driver.ok === false && driver.error.code).toBe("ECONNRESET");
		const { inbox } = processOver(sql, new ManualClock(T0));
		const restored = await restoreSteeringInbox(inbox, sink, { limit: 1 });
		expect(restored.ok === false && restored.error.code).toBe("ECONNRESET");
	});
});

describe("acknowledgement deadline", () => {
	async function queuedAt(sql: DurableSql, clock: ManualClock, ids: string[] = ["d-1"]) {
		const owner = processOver(sql, clock);
		for (const id of ids) expect((await owner.inbox.enqueue(directive({ id }))).ok).toBe(true);
		return owner;
	}

	test("one millisecond before the deadline nothing expires; at the deadline the directive is declined for timeout, audited first", async () => {
		const sql = new DurableSql();
		const clock = new ManualClock(T0);
		const { inbox } = await queuedAt(sql, clock);

		expect(await inbox.expireStale(T0 + TTL - 1)).toEqual({ ttlMs: TTL, checked: 1, expired: [], adopted: [], failed: [], deferred: 0 });
		expect(inbox.pendingFor(WORKER)).toHaveLength(1);
		expect(sql.acknowledgedRows()).toHaveLength(0);

		const report = await inbox.expireStale(T0 + TTL);

		expect(report.expired).toEqual(["d-1"]);
		expect(inbox.pendingFor(WORKER)).toEqual([]);
		expect(inbox.get("d-1")).toMatchObject({ state: "acknowledged", outcome: "declined", confirmed: false, reason: "timeout", acknowledgedAtMs: T0 + TTL });
		const [row] = sql.acknowledgedRows();
		expect(row).toMatchObject({ directiveId: "d-1", outcome: "declined", confirmed: false, reason: "timeout", targetSessionId: WORKER });
		expect(row?.recordedAt.getTime()).toBe(T0 + TTL);
	});

	test("the audit append happens before the directive leaves the pending set", async () => {
		const clock = new ManualClock(T0);
		let pendingAtAppend = null as number | null;
		const history: SteeringHistorySink = {
			append: async (entry) => {
				if (entry.event === "acknowledged") pendingAtAppend = inbox.pendingFor(WORKER).length;
			},
		};
		const inbox: SteeringInbox = new SteeringInbox({ history, clock, policy: { allowlist: [HUMAN], ratePerMin: 10, ackTtlMs: TTL } });
		await inbox.restore([{ directive: directive(), queuedAtMs: T0 }]);

		await inbox.expireStale(T0 + TTL);

		expect(pendingAtAppend).toBe(1);
		expect(inbox.pendingFor(WORKER)).toEqual([]);
	});

	test("an audit failure keeps the directive pending and is reported; the next pass closes it", async () => {
		const sql = new DurableSql();
		const clock = new ManualClock(T0);
		const { inbox } = await queuedAt(sql, clock);
		const attemptsBefore = sql.insertAttempts;
		sql.failInsert = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });

		const failed = await inbox.expireStale(T0 + TTL + 1);

		expect(failed.expired).toEqual([]);
		expect(failed.failed).toEqual([{ directiveId: "d-1", lastErrorCode: "ECONNRESET" }]);
		expect(sql.insertAttempts - attemptsBefore).toBe(STEERING_AUDIT_ATTEMPTS);
		expect(inbox.get("d-1")?.state).toBe("queued");
		expect(inbox.pendingFor(WORKER)).toHaveLength(1);

		sql.failInsert = null;
		expect((await inbox.expireStale(T0 + TTL + 2)).expired).toEqual(["d-1"]);
		expect(sql.acknowledgedRows()).toHaveLength(1);
	});

	test("an outage ends the pass, so a down store is not hammered, and the rest are deferred", async () => {
		const sql = new DurableSql();
		const { inbox } = await queuedAt(sql, new ManualClock(T0), ["d-1", "d-2", "d-3"]);
		const attemptsBefore = sql.insertAttempts;
		sql.failInsert = Object.assign(new Error("down"), { code: "ECONNRESET" });

		const report = await inbox.expireStale(T0 + TTL);

		expect(report.failed).toEqual([{ directiveId: "d-1", lastErrorCode: "ECONNRESET" }]);
		expect(report.deferred).toBe(2);
		expect(sql.insertAttempts - attemptsBefore).toBe(STEERING_AUDIT_ATTEMPTS);
	});

	test("running it twice changes nothing the second time", async () => {
		const sql = new DurableSql();
		const { inbox } = await queuedAt(sql, new ManualClock(T0), ["d-1", "d-2"]);

		const first = await inbox.expireStale(T0 + TTL);
		const rows = sql.rows.length;
		const second = await inbox.expireStale(T0 + TTL + 5_000);

		expect(first.expired).toEqual(["d-1", "d-2"]);
		expect(second).toEqual({ ttlMs: TTL, checked: 0, expired: [], adopted: [], failed: [], deferred: 0 });
		expect(sql.rows).toHaveLength(rows);
	});

	test("two processes expiring one directive write one row; the second sees a same-payload repeat and succeeds", async () => {
		const sql = new DurableSql();
		const clock = new ManualClock(T0);
		await queuedAt(sql, clock);
		const first = processOver(sql, new ManualClock(T0 + 1));
		const second = processOver(sql, new ManualClock(T0 + 2));
		await restoreSteeringInbox(first.inbox, first.sink, { limit: 10 });
		await restoreSteeringInbox(second.inbox, second.sink, { limit: 10 });

		const a = await first.inbox.expireStale(T0 + TTL + 300);
		const b = await second.inbox.expireStale(T0 + TTL + 900);

		expect(a.expired).toEqual(["d-1"]);
		expect(b).toMatchObject({ expired: ["d-1"], adopted: [], failed: [] });
		expect(sql.acknowledgedRows()).toHaveLength(1);
		expect(second.inbox.get("d-1")).toMatchObject({ state: "acknowledged", outcome: "declined", reason: "timeout" });
	});

	test("a human acknowledgement saved elsewhere first is adopted, not overwritten", async () => {
		const sql = new DurableSql();
		await queuedAt(sql, new ManualClock(T0));
		const stale = processOver(sql, new ManualClock(T0 + 1));
		await restoreSteeringInbox(stale.inbox, stale.sink, { limit: 10 });
		const human = processOver(sql, new ManualClock(T0 + 100));
		await restoreSteeringInbox(human.inbox, human.sink, { limit: 10 });
		expect((await human.inbox.acknowledge({ directiveId: "d-1", sessionId: WORKER, outcome: "applied" })).ok).toBe(true);

		const report = await stale.inbox.expireStale(T0 + TTL);

		expect(report).toMatchObject({ expired: [], adopted: ["d-1"], failed: [] });
		expect(stale.inbox.get("d-1")).toMatchObject({ state: "acknowledged", outcome: "applied", acknowledgedAtMs: T0 + 100 });
		expect(stale.inbox.get("d-1")).not.toHaveProperty("reason");
		expect(sql.acknowledgedRows()).toHaveLength(1);
		expect(sql.acknowledgedRows()[0]?.outcome).toBe("applied");
	});

	test("a conflict that cannot be read back leaves the directive pending, and is not retried", async () => {
		const sql = new DurableSql();
		await queuedAt(sql, new ManualClock(T0));
		const human = processOver(sql, new ManualClock(T0 + 100));
		await restoreSteeringInbox(human.inbox, human.sink, { limit: 10 });
		await human.inbox.acknowledge({ directiveId: "d-1", sessionId: WORKER, outcome: "applied" });
		let appends = 0;
		const sink = new SteeringAuditSink(sql);
		const stale = new SteeringInbox({
			history: {
				append: async (entry) => {
					appends += 1;
					await sink.append(entry);
				},
			},
			clock: new ManualClock(T0),
			policy: { allowlist: [HUMAN], ratePerMin: 10, ackTtlMs: TTL },
		});
		await stale.restore([{ directive: directive(), queuedAtMs: T0 }]);

		const report = await stale.expireStale(T0 + TTL);

		expect(report.failed).toEqual([{ directiveId: "d-1", lastErrorCode: "AUDIT_CONFLICT" }]);
		expect(appends).toBe(1);
		expect(stale.get("d-1")?.state).toBe("queued");
	});

	test("one pass closes at most the batch bound, oldest first, and defers the rest", async () => {
		const history = new CountingHistory();
		const inbox = new SteeringInbox({ history, clock: new ManualClock(T0), policy: { allowlist: [HUMAN], ratePerMin: 10, ackTtlMs: TTL } });
		const total = STEERING_EXPIRY_BATCH + 1;
		const entries = Array.from({ length: total }, (_, index) => ({ directive: directive({ id: `d-${String(index).padStart(3, "0")}` }), queuedAtMs: T0 }));
		await inbox.restore(entries);

		const first = await inbox.expireStale(T0 + TTL);
		const second = await inbox.expireStale(T0 + TTL);

		expect(first.expired).toHaveLength(STEERING_EXPIRY_BATCH);
		expect(first.expired[0]).toBe("d-000");
		expect(first.deferred).toBe(1);
		expect(second).toMatchObject({ expired: ["d-100"], deferred: 0 });
		expect(history.appended).toHaveLength(total);
	});

	test("with no TTL in the policy nothing expires and nothing is audited", async () => {
		const history = new CountingHistory();
		const inbox = new SteeringInbox({ history, clock: new ManualClock(T0), policy: { allowlist: [HUMAN], ratePerMin: 10 } });
		await inbox.restore([{ directive: directive(), queuedAtMs: T0 }]);

		expect(await inbox.expireStale(T0 + 10 * TTL)).toEqual({ ttlMs: null, checked: 1, expired: [], adopted: [], failed: [], deferred: 0 });
		expect(history.appended).toEqual([]);
	});

	test("a bad clock reading or a bad TTL is refused, not guessed", () => {
		const { inbox } = processOver(new DurableSql(), new ManualClock(T0));
		for (const nowMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => inbox.expireStale(nowMs)).toThrow(RangeError);
		for (const ackTtlMs of [0, -5, 1.5, Number.NaN]) {
			expect(() => new SteeringInbox({ history: new CountingHistory(), clock: new ManualClock(T0), policy: { allowlist: [], ratePerMin: 1, ackTtlMs } })).toThrow(RangeError);
		}
	});

	test("an expired directive stays visible to its session with the reason, and a restart restores it from the log", async () => {
		const sql = new DurableSql();
		const { inbox } = await queuedAt(sql, new ManualClock(T0));
		await inbox.expireStale(T0 + TTL);
		const wiring = { enabled: true, clock: new ManualClock(T0), settingsErrors: [], inbox };

		expect(listSteering(wiring, { session_id: WORKER })).toMatchObject({
			status: "listed",
			directives: [{ id: "d-1", state: "acknowledged", outcome: "declined", reason: "timeout", acknowledged_at_ms: T0 + TTL }],
		});

		const restarted = processOver(sql, new ManualClock(T0 + TTL + 1));
		const recent = await restarted.sink.readRecent({ limit: 10 });
		expect(recent.ok).toBe(true);
		if (!recent.ok) return;
		await restarted.inbox.restore(recent.value.entries);
		expect(restarted.inbox.get("d-1")).toMatchObject({ state: "acknowledged", outcome: "declined", reason: "timeout", acknowledgedAtMs: T0 + TTL });
		expect(await restartedOpen(restarted)).toEqual([]);
	});

	async function restartedOpen(process: ServerProcess): Promise<string[]> {
		const open = await process.sink.readOpenDirectives({ limit: 10 });
		return open.ok ? open.value.entries.map((entry) => String(entry.directive.id)) : ["read failed"];
	}
});

describe("the payload hash covers the reason", () => {
	const ack = (reason?: "timeout"): SteeringAuditEntry => ({
		event: "acknowledged",
		atMs: T0,
		directiveId: "d-1",
		targetSessionId: WORKER,
		outcome: "declined",
		confirmed: false,
		...(reason === undefined ? {} : { reason }),
	});

	async function hashOf(entry: SteeringAuditEntry): Promise<string | undefined> {
		const sql = new DurableSql();
		await new SteeringAuditSink(sql).append(entry);
		return sql.rows[0]?.payloadSha256;
	}

	test("the same entry with and without a reason hashes differently, and the same reason hashes the same", async () => {
		const plain = await hashOf(ack());
		const timeout = await hashOf(ack("timeout"));

		expect(timeout).not.toBe(plain);
		expect(await hashOf(ack("timeout"))).toBe(timeout);
	});

	test("a row without a reason keeps the hash it had before the column existed", async () => {
		const legacy = {
			action: null,
			authorKind: null,
			authorPrincipal: null,
			bodyRedacted: null,
			confirmed: false,
			conflictsWithActivePlan: null,
			directiveCreatedAtMs: null,
			directiveId: "d-1",
			outcome: "declined",
			planPhase: null,
			planPlan: null,
			priority: null,
			recordedAt: new Date(T0).toISOString(),
			targetSessionId: WORKER,
			transition: "acknowledged",
		};

		expect(await hashOf(ack())).toBe(createHash("sha256").update(JSON.stringify(legacy)).digest("hex"));
	});

	test("a changed reason under the same key is a conflict, and the saved row is left alone", async () => {
		const sql = new DurableSql();
		await new SteeringAuditSink(sql).append(ack());

		const result = await new SteeringAuditSink(sql).record(ack("timeout"));

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toBeInstanceOf(SteeringAuditConflictError);
		expect(sql.rows).toHaveLength(1);
		expect(sql.rows[0]?.reason).toBeNull();
	});

	test("the reason is written to its column, and an applied acknowledgement cannot carry one", async () => {
		const sql = new DurableSql();
		await new SteeringAuditSink(sql).append(ack("timeout"));
		expect(sql.rows[0]?.reason).toBe("timeout");

		const appliedWithReason: SteeringAuditEntry = {
			event: "acknowledged",
			atMs: T0,
			directiveId: "d-1",
			targetSessionId: WORKER,
			outcome: "applied",
			confirmed: false,
			reason: "timeout",
		};
		const applied = await new SteeringAuditSink(new DurableSql()).record(appliedWithReason);
		expect(applied.ok).toBe(false);
	});
});

describe("expiry settings", () => {
	test("unset keys take the defaults, in milliseconds", () => {
		expect(loadSteeringExpirySettings({})).toEqual({ ok: true, settings: { ackTtlMs: DEFAULT_STEERING_ACK_TTL_S * 1_000, expirySweepMs: DEFAULT_STEERING_EXPIRY_SWEEP_S * 1_000 } });
		expect(DEFAULT_STEERING_ACK_TTL_S).toBe(86_400);
		expect(DEFAULT_STEERING_EXPIRY_SWEEP_S).toBe(60);
	});

	test("set keys are whole seconds within inclusive bounds", () => {
		expect(loadSteeringExpirySettings({ [STEERING_ACK_TTL_ENV]: "3600", [STEERING_EXPIRY_SWEEP_ENV]: "15" })).toEqual({
			ok: true,
			settings: { ackTtlMs: 3_600_000, expirySweepMs: 15_000 },
		});
		expect(loadSteeringExpirySettings({ [STEERING_ACK_TTL_ENV]: String(STEERING_ACK_TTL_BOUNDS_S.min) })).toMatchObject({ ok: true });
		expect(loadSteeringExpirySettings({ [STEERING_ACK_TTL_ENV]: String(STEERING_ACK_TTL_BOUNDS_S.max) })).toMatchObject({ ok: true });
		expect(loadSteeringExpirySettings({ [STEERING_EXPIRY_SWEEP_ENV]: String(STEERING_EXPIRY_SWEEP_BOUNDS_S.max) })).toMatchObject({ ok: true });
	});

	test("malformed and out-of-range values are typed errors naming the key, never echoing the value", () => {
		expect(loadSteeringExpirySettings({ [STEERING_ACK_TTL_ENV]: "soon", [STEERING_EXPIRY_SWEEP_ENV]: "0" })).toEqual({
			ok: false,
			errors: [
				{ key: STEERING_ACK_TTL_ENV, reason: "not-integer" },
				{ key: STEERING_EXPIRY_SWEEP_ENV, reason: "out-of-range", min: STEERING_EXPIRY_SWEEP_BOUNDS_S.min, max: STEERING_EXPIRY_SWEEP_BOUNDS_S.max },
			],
		});
		expect(loadSteeringExpirySettings({ [STEERING_ACK_TTL_ENV]: String(STEERING_ACK_TTL_BOUNDS_S.min - 1) })).toEqual({
			ok: false,
			errors: [{ key: STEERING_ACK_TTL_ENV, reason: "out-of-range", min: STEERING_ACK_TTL_BOUNDS_S.min, max: STEERING_ACK_TTL_BOUNDS_S.max }],
		});
		expect(loadSteeringExpirySettings({ [STEERING_ACK_TTL_ENV]: "" })).toEqual({ ok: false, errors: [{ key: STEERING_ACK_TTL_ENV, reason: "not-integer" }] });
	});
});
