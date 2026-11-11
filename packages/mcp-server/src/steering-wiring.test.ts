/**
 * Live steering and liveness, wired through `Substrate` (phase 58): the four settings, the durable inbox (restore at boot with
 * no audit row, the expiry timer and its shutdown), the `steering` notice on `docs_search`, the one hint per queued directive,
 * the acknowledgement driving a session state, and the planning observer's baseline and liveness wiring. Every test runs on
 * in-memory ports, injected timers and an injected clock: no network, no database, no real delay.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.ts";
import { searchReplyStorable } from "./docs-search.ts";
import { createMcpServer, type McpCaller } from "./mcp.ts";
import { RecordingPresenceBackend } from "./planning/backend.fixtures.ts";
import type { PlanningTimers } from "./planning/observer.ts";
import { DragonflyPresenceStore } from "./planning/presence-dragonfly.ts";
import { SteeringInbox } from "./planning/steering.ts";
import type { SessionStateOutcome, SessionStatePort } from "./planning/steering-delivery.ts";
import {
	SteeringAuditSink,
	type SteeringAuditReadQuery,
	type SteeringAuditReadSql,
	type SteeringAuditRow,
	type SteeringAuditSql,
	type SteeringAuditTransition,
	type SteeringSavedRow,
	type SteeringStoredAckRow,
	type SteeringStoredDirectiveRow,
	type SteeringKeyedAckSaved,
	type SteeringKeyedQueueSaved,
	type SteeringSessionRow,
} from "./planning/steering-store.ts";
import { FakeTree, TREE_ROOT } from "./planning/tree.fixtures.ts";
import { IndexStore } from "./index-store.ts";
import type { EventInput } from "./types.ts";
import { Substrate } from "./service.ts";
import { auditToolCalls, createObservability } from "./observe.ts";
import { createTestLiveSessionAuthority, issueLiveSession, type TestLiveSessionAuthority } from "./planning/live-session.test-support.ts";
import { LiveSessionStatePort } from "./planning/session-state.ts";
import { LiveSessionBoundaryError } from "./planning/steering-tools.ts";
import { AuditUnavailableError, type AuditRecord } from "@substrate/audit";
import type { LiveSessionAccess, LiveSessionSnapshot } from "./planning/steering-sessions-store.ts";

const T0 = 1_800_000_000_000;
const OPERATOR: McpCaller = { surface: "omp", isOperator: true };
const STEERING_ON = { SUBSTRATE_PLANNING_STEERING: "on", SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "omp", SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE: "on" };
const TOKEN = "ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";

class ManualClock {
	constructor(private now: number) {}
	nowMs = (): number => this.now;
	set(ms: number): void {
		this.now = ms;
	}
}

class FakeTimers implements PlanningTimers {
	runs: Array<() => Promise<unknown>> = [];
	intervals: number[] = [];
	cleared = 0;

	setInterval(run: () => Promise<unknown>, ms: number): number {
		this.runs.push(run);
		this.intervals.push(ms);
		return this.runs.length;
	}

	clearInterval(): void {
		this.cleared += 1;
	}
}

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** The audit table in memory: the write port and the read port over one list of rows. */
class FakeAuditSql implements SteeringAuditSql, SteeringAuditReadSql {
	readonly rows: SteeringAuditRow[] = [];
	readonly sessions: SteeringSessionRow[] = [];
	insertAttempts = 0;
	failReads: Error | null = null;

	async insertAbsent(row: SteeringAuditRow): Promise<boolean> {
		this.insertAttempts += 1;
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
		return this.queued(query.sessionId)
			.flatMap((row) => {
				const ack = this.find(row.directiveId, "acknowledged");
				return ack === undefined ? [] : [stored(row, storedAck(ack, this.sessions))];
			})
			.slice(0, query.limit);
	}

	async savedAcknowledgement(directiveId: string): Promise<SteeringStoredAckRow | null> {
		const ack = this.find(directiveId, "acknowledged");
		return ack === undefined ? null : storedAck(ack, this.sessions);
	}

	async insertSessionOutcome(row: SteeringSessionRow): Promise<void> {
		if (this.sessions.some((saved) => saved.directiveId === row.directiveId)) return;
		this.sessions.push({ ...row });
	}

	async savedKeyedQueue(surface: string, key: string): Promise<SteeringKeyedQueueSaved | null> {
		if (this.failReads !== null) throw this.failReads;
		const row = this.rows.find((candidate) => candidate.transition === "queued" && candidate.idempotencySurface === surface && candidate.idempotencyKey === key);
		if (row === undefined) return null;
		return { directiveId: row.directiveId, targetSessionId: row.targetSessionId, queuedAtMs: row.recordedAt.getTime(), deliverySequence: row.deliverySequence, fingerprint: row.idempotencyFingerprint ?? "" };
	}

	async savedKeyedAcknowledgement(surface: string, key: string): Promise<SteeringKeyedAckSaved | null> {
		if (this.failReads !== null) throw this.failReads;
		const ack = this.rows.find((candidate) => candidate.transition === "acknowledged" && candidate.idempotencySurface === surface && candidate.idempotencyKey === key);
		if (ack === undefined) return null;
		if (ack.outcome === null || ack.confirmed === null) throw new Error("keyed acknowledgement row without an outcome");
		const saved = this.sessions.find((row) => row.directiveId === ack.directiveId);
		return {
			directiveId: ack.directiveId,
			outcome: ack.outcome,
			confirmed: ack.confirmed,
			fingerprint: ack.idempotencyFingerprint ?? "",
			deliverySequence: this.find(ack.directiveId, "queued")?.deliverySequence ?? null,
			session: saved === undefined ? null : sessionOutcomeOf(saved),
			checkpointHint: saved?.checkpointHint ?? false,
		};
	}

	async maxDeliverySequence(): Promise<number> {
		if (this.failReads !== null) throw this.failReads;
		return this.rows.reduce((max, row) => Math.max(max, row.deliverySequence ?? 0), 0);
	}

	async targetSessionOf(directiveId: string): Promise<string | null> {
		if (this.failReads !== null) throw this.failReads;
		return this.find(directiveId, "queued")?.targetSessionId ?? null;
	}

	acknowledged(): SteeringAuditRow[] {
		return this.rows.filter((row) => row.transition === "acknowledged");
	}

	private find(directiveId: string, transition: SteeringAuditTransition): SteeringAuditRow | undefined {
		return this.rows.find((row) => row.directiveId === directiveId && row.transition === transition);
	}

	private queued(sessionId: string | null): SteeringAuditRow[] {
		return this.rows.filter((row) => row.transition === "queued" && (sessionId === null || row.targetSessionId === sessionId));
	}
}

function storedAck(row: SteeringAuditRow, sessions: readonly SteeringSessionRow[]): SteeringStoredAckRow {
	const moved = sessions.some((saved) => saved.directiveId === row.directiveId && saved.sessionStatus === "applied");
	return { outcome: row.outcome, confirmed: row.confirmed, reason: row.reason, recordedAt: row.recordedAt, sessionMoved: moved };
}

/** The session outcome a fake movement row holds, in the shape the reply carries. */
function sessionOutcomeOf(row: SteeringSessionRow): SessionStateOutcome {
	if (row.sessionStatus === "unchanged") return { status: "unchanged" };
	if (row.sessionState === null) throw new Error("session row without a state");
	if (row.sessionStatus === "applied") return { status: "applied", state: row.sessionState };
	if (row.refusalReason === null) throw new Error("refused session row without a reason");
	return { status: "refused", state: row.sessionState, reason: row.refusalReason };
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
		deliverySequence: row.deliverySequence,
		queuedAt: row.recordedAt,
		acknowledgement,
	};
}

/** A directive as the inbox takes it. */
function directive(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "d-1",
		author: { principalId: "omp", kind: "human" },
		createdAtMs: T0,
		priority: "normal",
		targetSessionId: "sess-a",
		action: "redirect",
		body: "Hold the plan until the review lands.",
		conflictsWithActivePlan: false,
		...overrides,
	};
}

/** Rows a previous server process left in the table: its inbox over the shared sql. */
async function seedPreviousProcess(sql: FakeAuditSql, directives: Array<Record<string, unknown>>): Promise<void> {
	const previous = new SteeringInbox({
		history: new SteeringAuditSink(sql, sql),
		clock: { nowMs: () => T0 },
		policy: { allowlist: ["omp"], ratePerMin: 100 },
	});
	for (const entry of directives) expect((await previous.enqueue(entry)).ok).toBe(true);
}


interface Harness {
	substrate: Substrate;
	sql: FakeAuditSql;
	clock: ManualClock;
	timers: FakeTimers;
	lines: string[];
	authority: TestLiveSessionAuthority;
	session: { sessionId: string; sessionBinding: string; access: LiveSessionAccess; snapshot: LiveSessionSnapshot };
	auditRecords: AuditRecord[];
}

async function harness(env: Record<string, string | undefined> = {}, options: { sql?: FakeAuditSql; sessionState?: SessionStatePort | null; missingAudit?: boolean; failingAudit?: boolean } = {}): Promise<Harness> {
	const sql = options.sql ?? new FakeAuditSql();
	const clock = new ManualClock(T0);
	const timers = new FakeTimers();
	const lines: string[] = [];
	const authority = createTestLiveSessionAuthority({ nowMs: T0 });
	const session = await issueLiveSession(authority, { caller: OPERATOR });
	const config = loadConfig({ ...STEERING_ON, SUBSTRATE_PLANNING_STEERING_ACK_TTL_S: "60", SUBSTRATE_PLANNING_STEERING_EXPIRY_SWEEP_S: "5", ...env });
	const observability = createObservability(config, {});
	const auditRecords: AuditRecord[] = [];
	const append = observability.audit.append.bind(observability.audit);
	spyOn(observability.audit, "append").mockImplementation(async (input) => {
		if (options.failingAudit && input.mode === "fail-closed") throw new AuditUnavailableError(input.tool, "isolated audit failure");
		const written = await append(input);
		auditRecords.push(written.record);
		return written;
	});
	const substrate = new Substrate(config, {
		index: null, greptime: null,
		planning: { presence: null, emit: async () => true },
		steering: { liveSessions: authority, history: null, durable: new SteeringAuditSink(sql, sql), ...(options.sessionState !== undefined ? { sessionState: options.sessionState } : {}), timers, nowMs: clock.nowMs, report: (line) => lines.push(line) },
	}, observability.observer, options.missingAudit ? undefined : {
		auditCalls: (caller, calls, transport) => auditToolCalls(observability, caller.surface, calls, transport),
	});
	return { substrate, sql, clock, timers, lines, authority, session, auditRecords };
}

async function connect(substrate: Substrate, caller: McpCaller): Promise<Client> {
	const server = createMcpServer(substrate, caller);
	const client = new Client({ name: "steering-wiring-test", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
	const result = await client.callTool({ name, arguments: args });
	const content = result.content as Array<{ type: string; text?: string }>;
	return { isError: result.isError === true, body: JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown> };
}

const QUEUE_ARGS = { target_session_id: "sess-a", action: "pause", priority: "normal", body: "Hold the migration.", conflicts_with_active_plan: false };

/** Stderr is captured for the test and restored after it. */
function captureStderr(): { text: () => string; restore: () => void } {
	const written: string[] = [];
	const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	}) as never);
	return { text: () => written.join(""), restore: () => spy.mockRestore() };
}

describe("the settings", () => {
	test("the four names default to the documented values", () => {
		const config = loadConfig({});
		expect(config.steeringExpiry).toEqual({ ok: true, settings: { ackTtlMs: 86_400_000, expirySweepMs: 60_000 } });
		expect(config.planningBaseline).toEqual({ ok: true, directory: null });
		expect(config.planningLiveness).toEqual({ ok: true, settings: { intervalMs: 0 } });
	});

	test("a malformed or out-of-range value is a typed problem naming its key, never clamped", () => {
		const config = loadConfig({
			SUBSTRATE_PLANNING_STEERING_ACK_TTL_S: "59",
			SUBSTRATE_PLANNING_STEERING_EXPIRY_SWEEP_S: "soon",
			SUBSTRATE_PLANNING_BASELINE_DIR: "relative/baselines",
			SUBSTRATE_PLANNING_LIVENESS_INTERVAL_MS: "3600001",
		});
		expect(config.steeringExpiry).toEqual({
			ok: false,
			errors: [
				{ key: "SUBSTRATE_PLANNING_STEERING_ACK_TTL_S", reason: "out-of-range", min: 60, max: 2_592_000 },
				{ key: "SUBSTRATE_PLANNING_STEERING_EXPIRY_SWEEP_S", reason: "not-integer" },
			],
		});
		expect(config.planningBaseline).toEqual({ ok: false, errors: [{ key: "SUBSTRATE_PLANNING_BASELINE_DIR", reason: "not-absolute" }] });
		expect(config.planningLiveness).toEqual({ ok: false, errors: [{ key: "SUBSTRATE_PLANNING_LIVENESS_INTERVAL_MS", reason: "out-of-range", min: 0, max: 3_600_000 }] });
	});

	test("a bad expiry setting makes the steering tools answer misconfigured, and builds no inbox", async () => {
		const stderr = captureStderr();
		try {
			const { substrate, session } = await harness({ SUBSTRATE_PLANNING_STEERING_ACK_TTL_S: "5" });
			expect(substrate.steering.inbox).toBeNull();
			expect(substrate.steering.settingsErrors).toEqual([{ key: "SUBSTRATE_PLANNING_STEERING_ACK_TTL_S", reason: "out-of-range", min: 60, max: 2_592_000 }]);
			const client = await connect(substrate, OPERATOR);
			expect(await call(client, "steering_list", { session_id: session.sessionId })).toMatchObject({ isError: true, body: { status: "misconfigured" } });
			expect(stderr.text()).toContain("SUBSTRATE_PLANNING_STEERING_ACK_TTL_S");
		} finally {
			stderr.restore();
		}
	});
});

describe("the durable inbox", () => {
	test("boot restores the open directives, writes no audit row, and starts the expiry timer at the sweep interval", async () => {
		const sql = new FakeAuditSql();
		await seedPreviousProcess(sql, [directive({ id: "d-1" }), directive({ id: "d-2", priority: "high", createdAtMs: T0 + 1 })]);
		const rowsBefore = sql.rows.length;
		const attemptsBefore = sql.insertAttempts;
		const { substrate, timers, lines } = await harness({}, { sql });
		expect(substrate.steering.inbox?.get("d-1")).toBeNull();

		const started = await substrate.startSteering();

		expect(started).toMatchObject({ restored: 2, skipped: 0, truncated: false, readFailed: null, sweeping: true });
		expect(substrate.steering.inbox?.pendingFor("sess-a").map((entry) => entry.id)).toEqual(["d-2", "d-1"]);
		expect(sql.rows).toHaveLength(rowsBefore);
		expect(sql.insertAttempts).toBe(attemptsBefore);
		expect(timers.intervals).toEqual([5_000]);
		expect(lines).toEqual([]);
	});

	test("a read that fails is reported, the inbox starts empty and boot goes on; the rows stay in the table", async () => {
		const sql = new FakeAuditSql();
		await seedPreviousProcess(sql, [directive()]);
		sql.failReads = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
		const { substrate } = await harness({}, { sql });
		const stderr = captureStderr();
		try {
			const started = await substrate.startSteering();
			expect(started.readFailed).toBe("ECONNREFUSED");
			expect(started.restored).toBe(0);
			expect(started.sweeping).toBe(true);
			expect(stderr.text()).toContain("steering restore failed (ECONNREFUSED)");
			expect(stderr.text()).not.toContain("connection refused");
		} finally {
			stderr.restore();
		}
		expect(substrate.steering.inbox?.pendingFor("sess-a")).toEqual([]);
		expect(sql.rows).toHaveLength(1);
	});

	test("an expiry pass closes a directive nobody acknowledged as declined:timeout, and shutdown clears the timer for good", async () => {
		const sql = new FakeAuditSql();
		await seedPreviousProcess(sql, [directive()]);
		const { substrate, clock, timers } = await harness({}, { sql });
		await substrate.startSteering();
		const tick = timers.runs[0];
		if (tick === undefined) throw new Error("the expiry timer was not started");

		clock.set(T0 + 59_999);
		await tick();
		expect(substrate.steering.inbox?.get("d-1")?.state).toBe("queued");
		expect(sql.acknowledged()).toEqual([]);

		clock.set(T0 + 60_000);
		await tick();
		expect(substrate.steering.inbox?.get("d-1")).toMatchObject({ state: "acknowledged", outcome: "declined", reason: "timeout" });
		expect(sql.acknowledged()).toMatchObject([{ directiveId: "d-1", outcome: "declined", reason: "timeout" }]);

		await seedPreviousProcess(sql, [directive({ id: "d-2" })]);
		await substrate.steering.inbox?.restore([{ directive: directive({ id: "d-2" }), queuedAtMs: T0 }]);
		await substrate.stopSteering();
		expect(timers.cleared).toBe(1);
		clock.set(T0 + 10 * 60_000);
		await tick();
		expect(sql.acknowledged()).toHaveLength(1);
		expect(substrate.steering.inbox?.get("d-2")?.state).toBe("queued");
	});

	test("with no durable sink there is nothing to restore and no timer: the inbox is as it was before", async () => {
		const timers = new FakeTimers();
		const entries: unknown[] = [];
		const history = { append: async (entry: unknown) => void entries.push(entry) };
		const substrate = new Substrate(loadConfig(STEERING_ON), { index: null, greptime: null, planning: { presence: null, emit: async () => true }, steering: { history: history as never, timers } });
		expect(await substrate.startSteering()).toEqual({ restored: 0, skipped: 0, truncated: false, readFailed: null, sweeping: false });
		expect(timers.runs).toEqual([]);
		expect(substrate.steering.inbox).not.toBeNull();
	});

	test("with steering off nothing is built: no inbox, no timer, no read", async () => {
		const sql = new FakeAuditSql();
		const { substrate, timers } = await harness({ SUBSTRATE_PLANNING_STEERING: "off" }, { sql });
		expect(substrate.steering.inbox).toBeNull();
		expect(await substrate.startSteering()).toMatchObject({ restored: 0, sweeping: false });
		expect(timers.runs).toEqual([]);
	});

	/** A real `IndexStore` whose connection is a fake that records the statements it is sent and answers with no rows. */
	function indexOverFakeConnection(): { store: IndexStore; statements: string[] } {
		const statements: string[] = [];
		const store = new IndexStore("postgres://u@localhost/x");
		// The pool is private, so the connection is swapped through the seam the migration tests also use.
		const internals: { sql: unknown } = store as unknown as { sql: unknown };
		internals.sql = (strings: TemplateStringsArray) => {
			statements.push(strings.join("?"));
			return Promise.resolve([]);
		};
		return { store, statements };
	}

	test("production wiring: with the opt-in on and an index, the inbox is built over the audit table and restored from it at boot", async () => {
		const { store, statements } = indexOverFakeConnection();
		const substrate = new Substrate(loadConfig(STEERING_ON), { index: store, greptime: null, planning: { presence: null, emit: async () => true } });
		expect(substrate.steering.inbox).not.toBeNull();
		expect(statements).toEqual([]);

		const started = await substrate.startSteering();

		expect(started).toMatchObject({ restored: 0, readFailed: null, sweeping: true });
		expect(statements).toHaveLength(2);
		expect(statements[0]).toContain("max(delivery_sequence)");
		expect(statements[1]).toContain("from planning_steering_audit");
		expect(statements[1]).toContain("q.transition = 'queued'");
		await substrate.stopSteering();
	});

	test("production wiring: with the opt-in off nothing is built over the index, so no statement is ever sent", async () => {
		const { store, statements } = indexOverFakeConnection();
		const substrate = new Substrate(loadConfig({ ...STEERING_ON, SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE: "off" }), { index: store, greptime: null, planning: { presence: null, emit: async () => true } });
		expect(substrate.steering.inbox).toBeNull();
		expect(await substrate.startSteering()).toMatchObject({ restored: 0, sweeping: false });
		expect(statements).toEqual([]);
	});
});

describe("the steering notice on docs_search", () => {
	async function search(h: Harness) {
		return h.substrate.searchDocs({ question: "", session_id: "historical-label", steering_session_id: h.session.sessionId }, "omp", { caller: OPERATOR, sessionBinding: h.session.sessionBinding });
	}

	test("an issued session sees at most three redacted entries, never selected by historical attribution", async () => {
		const h = await harness();
		await seedPreviousProcess(h.sql, [
			directive({ id: "d-1", targetSessionId: h.session.sessionId, body: `deploy with ${TOKEN}` }),
			directive({ id: "d-2", targetSessionId: h.session.sessionId, priority: "high", action: "pause", createdAtMs: T0 + 1 }),
			directive({ id: "d-3", targetSessionId: h.session.sessionId, createdAtMs: T0 + 2 }),
			directive({ id: "d-4", targetSessionId: h.session.sessionId, createdAtMs: T0 + 3 }),
			directive({ id: "d-other", targetSessionId: "historical-label" }),
		]);
		await h.substrate.startSteering();
		h.clock.set(T0 + 4_000);
		const reply = await search(h);
		expect(reply.steering?.count).toBe(4);
		expect(reply.steering?.entries.map((entry) => entry.id)).toEqual(["d-2", "d-1", "d-3"]);
		expect(reply.steering?.entries[0]).toMatchObject({ id: "d-2", action: "pause", priority: "high", age_ms: 4_000 });
		expect(JSON.stringify(reply)).not.toContain(TOKEN);
		expect(JSON.stringify(reply)).not.toContain(h.session.sessionBinding);
		expect(searchReplyStorable(reply)).toBe(false);
		expect(searchReplyStorable({ chunks: [], untrusted: "x" })).toBe(true);
		expect(searchReplyStorable({ chunks: [], untrusted: "x", steering: { count: 1, entries: [], untrusted: "x" } })).toBe(false);
		expect((await h.substrate.searchDocs({ question: "", session_id: h.session.sessionId }, "omp")).steering).toBeUndefined();
	});

	test("empty, acknowledged and disabled notices are absent; closed targets refuse", async () => {
		const h = await harness();
		expect((await search(h)).steering).toBeUndefined();
		await seedPreviousProcess(h.sql, [directive({ targetSessionId: h.session.sessionId })]);
		await h.substrate.startSteering();
		expect((await search(h)).steering?.count).toBe(1);
		await h.substrate.steering.inbox?.acknowledge({ directiveId: "d-1", sessionId: h.session.sessionId, outcome: "declined" });
		expect((await search(h)).steering).toBeUndefined();
		await h.authority.close(h.session.access);
		await expect(search(h)).rejects.toMatchObject({ refusal: { status: "refused", error: { code: "not-found" } } });
		expect((await search(await harness({ SUBSTRATE_PLANNING_STEERING: "off" }))).steering).toBeUndefined();
	});

	test("a failed inbox read degrades only the notice after binding succeeds", async () => {
		const h = await harness();
		const inbox = h.substrate.steering.inbox;
		if (inbox === null) throw new Error("expected an inbox");
		const broken = spyOn(inbox, "recordsFor").mockImplementation(() => { throw new Error("inbox unreadable"); });
		const stderr = captureStderr();
		try {
			const reply = await search(h);
			expect(reply.steering).toBeUndefined();
			expect(reply.chunks).toEqual([]);
			expect(stderr.text()).toContain("steering notice skipped");
		} finally { stderr.restore(); broken.mockRestore(); }
	});

	test("MCP passes the explicit live selector and proof to the service", async () => {
		const h = await harness();
		await seedPreviousProcess(h.sql, [directive({ targetSessionId: h.session.sessionId })]);
		await h.substrate.startSteering();
		const reply = await call(await connect(h.substrate, OPERATOR), "docs_search", {
			question: "", session_id: "historical-label", steering_session_id: h.session.sessionId, session_binding: h.session.sessionBinding,
		});
		expect(reply).toMatchObject({ isError: false, body: { steering: { count: 1, entries: [{ id: "d-1", action: "redirect", priority: "normal" }] } } });
		expect(h.auditRecords.some((record) => record.tool === "docs_search")).toBe(true);
	});
});

describe("queued hints and shared authoritative acknowledgement state", () => {
	async function shared(options: { sessionState?: SessionStatePort | null } = {}) {
		const h = await harness({}, options);
		const events: EventInput[] = [];
		spyOn(h.substrate, "emit").mockImplementation((async (event: EventInput) => {
			events.push(event);
			return { event: { id: `ev-${events.length}` }, stored: true };
		}) as never);
		const client = await connect(h.substrate, OPERATOR);
		const queue = (action: "pause" | "redirect" | "annotate" = "pause") => call(client, "steering_queue", { ...QUEUE_ARGS, target_session_id: h.session.sessionId, action });
		const ack = (directiveId: unknown, outcome = "applied") => call(client, "steering_acknowledge", { directive_id: directiveId, session_id: h.session.sessionId, outcome });
		const state = async () => {
			const read = await h.authority.read(h.session.access, "private-read");
			if (!read.ok) throw new Error("expected active issued session");
			return read.snapshot.session.state;
		};
		return { ...h, client, queue, ack, state, events };
	}

	test("each queued directive publishes exactly one allowlisted hint without body or command metadata", async () => {
		const h = await shared();
		const first = await h.queue();
		const second = await h.queue("redirect");
		expect(first.body.status).toBe("queued");
		expect(second.body.status).toBe("queued");
		const hints = h.events.filter((event) => event.payload?.action === "steering.queued");
		expect(hints).toHaveLength(2);
		expect(hints.map((event) => event.payload?.directive_id)).toEqual([first.body.directive_id, second.body.directive_id]);
		for (const hint of hints) {
			expect(hint).toMatchObject({ kind: "note", surface: "substrate" });
			expect(Object.keys(hint.payload ?? {}).sort()).toEqual(["action", "directive_id", "non_blocking", "session_id"]);
			expect(JSON.stringify(hint)).not.toContain("Hold the migration");
			expect(JSON.stringify(hint)).not.toContain(h.session.sessionBinding);
		}
	});

	test("a bound nonoperator queue is forbidden without a hint; hint storage failure does not undo an audited queue", async () => {
		const h = await shared();
		const emit = spyOn(h.substrate, "emit").mockImplementation((async () => ({ stored: false })) as never);
		const nonoperator = await connect(h.substrate, { surface: "omp", isOperator: false });
		expect(await call(nonoperator, "steering_queue", { ...QUEUE_ARGS, target_session_id: h.session.sessionId, session_binding: h.session.sessionBinding })).toMatchObject({ isError: true, body: { status: "forbidden", reason: "operator-required" } });
		expect(emit.mock.calls.filter(([event]) => event.payload?.action === "steering.queued")).toHaveLength(0);
		expect(await h.queue()).toMatchObject({ isError: false, body: { status: "queued" } });
		expect(emit.mock.calls.filter(([event]) => event.payload?.action === "steering.queued")).toHaveLength(1);
	});

	test("pause and redirect apply authority state and the docs transition sees the same state", async () => {
		for (const [action, target] of [["pause", "PAUSED"], ["redirect", "CONTEXT_REFRESH"]] as const) {
			const h = await shared();
			expect(h.substrate.sessionState).toBeInstanceOf(LiveSessionStatePort);
			const queued = await h.queue(action);
			expect(await h.ack(queued.body.directive_id)).toMatchObject({ isError: false, body: { status: "acknowledged", session_state: { status: "applied", state: target }, checkpoint_hint: { trigger: "steering" } } });
			expect(await h.state()).toBe(target);
			const notes = h.events.filter((event) => event.payload?.action === "docs.steering");
			expect(notes).toHaveLength(1);
			expect(notes[0]).toMatchObject({ surface: "omp", session_id: h.session.sessionId, payload: { state: target, previous_state: "ACTIVE", directive_id: queued.body.directive_id, via: "steering_acknowledge" } });
			expect(await call(h.client, "docs_steering_session", { session_id: h.session.sessionId, session_binding: h.session.sessionBinding, repo_id: "owner/name", state: target, previous_state: target })).toMatchObject({ isError: false, body: { state: target } });
		}
	});

	test("owner transitions and acknowledgements share state, and resume permits another pause", async () => {
		const h = await shared();
		for (const state of ["PAUSED", "RESUMED"] as const) {
			expect((await call(h.client, "docs_steering_session", { session_id: h.session.sessionId, session_binding: h.session.sessionBinding, repo_id: "owner/name", state })).isError).toBe(false);
		}
		expect(await h.state()).toBe("RESUMED");
		expect(await h.ack((await h.queue()).body.directive_id)).toMatchObject({ body: { session_state: { status: "applied", state: "PAUSED" } } });
		expect(await h.state()).toBe("PAUSED");
	});

	test("annotate, declined and already-held states produce no transition note or checkpoint hint", async () => {
		for (const [action, outcome, initial] of [["annotate", "applied", "ACTIVE"], ["pause", "declined", "ACTIVE"], ["pause", "applied", "PAUSED"], ["redirect", "applied", "CONTEXT_REFRESH"]] as const) {
			const h = await shared();
			if (initial !== "ACTIVE") await h.authority.transition(h.session.access, { repoId: "owner/name", state: initial }, "owner-transition");
			const acknowledged = await h.ack((await h.queue(action)).body.directive_id, outcome);
			expect(acknowledged).toMatchObject({ isError: false, body: { status: "acknowledged", session_state: { status: "unchanged" } } });
			expect(acknowledged.body).not.toHaveProperty("checkpoint_hint");
			expect(await h.state()).toBe(initial);
			expect(h.events.filter((event) => event.payload?.action === "docs.steering")).toHaveLength(0);
		}
	});

	test("an invalid redirect preserves acknowledgement, paused state and absence of hint", async () => {
		const h = await shared();
		await h.authority.transition(h.session.access, { repoId: "owner/name", state: "PAUSED" }, "owner-transition");
		const queued = await h.queue("redirect");
		const acknowledged = await h.ack(queued.body.directive_id);
		expect(acknowledged).toMatchObject({ isError: false, body: { status: "acknowledged", outcome: "applied", session_state: { status: "refused", state: "CONTEXT_REFRESH", reason: "invalid-transition" } } });
		expect(acknowledged.body).not.toHaveProperty("checkpoint_hint");
		expect(await h.state()).toBe("PAUSED");
		expect(h.substrate.steering.inbox?.get(String(queued.body.directive_id))?.state).toBe("acknowledged");
		expect(h.events.filter((event) => event.payload?.action === "docs.steering")).toHaveLength(0);
	});

	test("unknown targets cannot queue; close after queue prevents acknowledgement", async () => {
		const h = await shared();
		expect(await call(h.client, "steering_queue", { ...QUEUE_ARGS, target_session_id: `ls_${"f".repeat(64)}` })).toMatchObject({ isError: true, body: { status: "refused", error: { code: "not-found" } } });
		const queued = await h.queue();
		await h.authority.close(h.session.access);
		expect(await h.ack(queued.body.directive_id)).toMatchObject({ isError: true, body: { status: "refused", error: { code: "not-found" } } });
		expect(h.substrate.steering.inbox?.get(String(queued.body.directive_id))?.state).toBe("queued");
	});

	test("an explicitly null state port preserves the plain acknowledgement", async () => {
		const h = await shared({ sessionState: null });
		const acknowledged = await h.ack((await h.queue()).body.directive_id);
		expect(acknowledged).toMatchObject({ isError: false, body: { status: "acknowledged", outcome: "applied" } });
		expect(acknowledged.body).not.toHaveProperty("session_state");
		expect(acknowledged.body).not.toHaveProperty("checkpoint_hint");
	});

	for (const mode of ["missingAudit", "failingAudit"] as const) test(`direct lifecycle mutation fails closed with ${mode}`, async () => {
		const h = await harness({}, { [mode]: true });
		await expect(h.substrate.closeLiveSession(OPERATOR, { session_id: h.session.sessionId }, { sessionBinding: h.session.sessionBinding })).rejects.toMatchObject({ refusal: { status: "refused", error: { code: "audit-unavailable" } } });
		expect((await h.authority.read(h.session.access, "private-read")).ok).toBe(true);
		await expect(h.substrate.closeLiveSession(OPERATOR, { session_id: `ls_${"f".repeat(64)}` })).rejects.toBeInstanceOf(LiveSessionBoundaryError);
		await expect(h.substrate.closeLiveSession(OPERATOR, { session_id: `ls_${"e".repeat(64)}` })).rejects.toMatchObject({ refusal: { status: "refused", error: { code: "not-found" } } });
	});
});

describe("the planning observer's baseline and liveness", () => {
	const made: string[] = [];
	afterEach(async () => {
		await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	function planningTree(): FakeTree {
		return new FakeTree({
			[`${TREE_ROOT}/.git/config`]: '[remote "origin"]\n\turl = git@github.com:swcstudiospace/agent-substrate.git\n',
			[`${TREE_ROOT}/.git/HEAD`]: "ref: refs/heads/gsd/v16-58-live-steering\n",
			[`${TREE_ROOT}/.planning/STATE.md`]: "# State\n",
		});
	}

	function planningSubstrate(env: Record<string, string>, backend: RecordingPresenceBackend, tree: FakeTree): Substrate {
		return new Substrate(loadConfig({ SUBSTRATE_PLANNING_ROOT: TREE_ROOT, ...env }), {
			index: null,
			greptime: null,
			planning: { presence: new DragonflyPresenceStore(backend), fs: tree, emit: async () => true },
		});
	}

	test("a quiet scan writes a liveness record whenever presence is on", async () => {
		const backend = new RecordingPresenceBackend();
		const substrate = planningSubstrate({}, backend, planningTree());
		await substrate.planningObserver.scan();
		expect(backend.writes).toHaveLength(1);
		const record = JSON.parse(backend.values.get(backend.writes[0]?.key ?? "") ?? "{}") as Record<string, unknown>;
		expect(record["livenessMs"]).toBe(backend.clockMs);
		expect("lastHeartbeatMs" in record).toBe(true);
	});

	test("the liveness interval comes from the setting: an hour apart is not due, then due", async () => {
		const backend = new RecordingPresenceBackend();
		// The interval never exceeds a third of the freshness window, so a window of three hours leaves the hour as is.
		const substrate = planningSubstrate({ SUBSTRATE_PLANNING_LIVENESS_INTERVAL_MS: "3600000", SUBSTRATE_PLANNING_PRESENCE_TTL_S: "10800" }, backend, planningTree());
		expect(await substrate.planningObserver.scan()).toMatchObject({ liveness: { state: "written" } });
		backend.clockMs += 1_000;
		expect(await substrate.planningObserver.scan()).toMatchObject({ liveness: { state: "not-due" } });
		backend.clockMs += 3_600_000;
		expect(await substrate.planningObserver.scan()).toMatchObject({ liveness: { state: "written" } });
	});

	test("a bad liveness setting is named once at boot and the default (every scan) applies", async () => {
		const stderr = captureStderr();
		try {
			const backend = new RecordingPresenceBackend();
			const substrate = planningSubstrate({ SUBSTRATE_PLANNING_LIVENESS_INTERVAL_MS: "often" }, backend, planningTree());
			expect(stderr.text()).toContain("SUBSTRATE_PLANNING_LIVENESS_INTERVAL_MS");
			expect(await substrate.planningObserver.scan()).toMatchObject({ liveness: { state: "written" } });
			backend.clockMs += 1;
			expect(await substrate.planningObserver.scan()).toMatchObject({ liveness: { state: "written" } });
		} finally {
			stderr.restore();
		}
	});

	test("with a baseline directory, shutdown flushes the baseline to a file there; with none, nothing is written", async () => {
		const dir = await mkdtemp(join(tmpdir(), "steering-wiring-"));
		made.push(dir);
		const backend = new RecordingPresenceBackend();
		const substrate = planningSubstrate({ SUBSTRATE_PLANNING_BASELINE_DIR: dir }, backend, planningTree());
		await substrate.planningObserver.scan();
		await substrate.stopPlanning();
		const files = await readdir(dir);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^wt-[0-9a-f]{24}\.baseline\.json$/);

		const bare = planningSubstrate({}, new RecordingPresenceBackend(), planningTree());
		await bare.planningObserver.scan();
		await bare.stopPlanning();
		expect(await readdir(dir)).toHaveLength(1);
	});

	test("a bad baseline directory is named at boot and the baseline stays in memory", async () => {
		const stderr = captureStderr();
		try {
			const substrate = planningSubstrate({ SUBSTRATE_PLANNING_BASELINE_DIR: "relative/dir" }, new RecordingPresenceBackend(), planningTree());
			expect(stderr.text()).toContain("SUBSTRATE_PLANNING_BASELINE_DIR");
			expect((await substrate.planningObserver.scan()).state).toBe("observed");
			await substrate.stopPlanning();
		} finally {
			stderr.restore();
		}
	});
});

describe("acknowledged directives after a restart", () => {
	/** Prior inbox process over the same audit rows; live authority is supplied independently. */
	async function acknowledgedByPreviousProcess(sql: FakeAuditSql, sessionId: string): Promise<void> {
		const previous = new SteeringInbox({
			history: new SteeringAuditSink(sql, sql),
			clock: { nowMs: () => T0 },
			policy: { allowlist: ["omp"], ratePerMin: 100 },
		});
		expect((await previous.enqueue(directive({ targetSessionId: sessionId }))).ok).toBe(true);
		expect((await previous.acknowledge({ directiveId: "d-1", sessionId, outcome: "applied" })).ok).toBe(true);
	}

	test("the route still lists a directive that was acknowledged before the restart, with no checkpoint hint (the audit holds no transition result)", async () => {
		const { substrate, session, sql, authority } = await harness();
		await acknowledgedByPreviousProcess(sql, session.sessionId);
		await substrate.startSteering();
		expect(substrate.steering.inbox?.get("d-1")).toBeNull();
		const durable = await substrate.readLiveDirectives(OPERATOR, { sessionId: session.sessionId, status: "acknowledged" }, session.sessionBinding);
		expect(durable).toMatchObject({ history: "durable", history_truncated: false, directives: [
			{ id: "d-1", status: "acknowledged", outcome: "applied", checkpoint_hint: null },
		] });
		const other = await issueLiveSession(authority, { caller: OPERATOR });
		expect((await substrate.readLiveDirectives(OPERATOR, { sessionId: other.sessionId, status: "acknowledged" }, other.sessionBinding)).directives).toEqual([]);
	});

	test("without the audit table only the inbox exists, and the answer says so", async () => {
		const authority = createTestLiveSessionAuthority();
		const session = await issueLiveSession(authority, { caller: OPERATOR });
		const config = loadConfig(STEERING_ON);
		const observability = createObservability(config, {});
		const substrate = new Substrate(config, { index: null, greptime: null, planning: { presence: null, emit: async () => true }, steering: { liveSessions: authority, history: { append: async () => undefined } } }, observability.observer, {
			auditCalls: (caller, calls, transport) => auditToolCalls(observability, caller.surface, calls, transport),
		});
		expect(await substrate.readLiveDirectives(OPERATOR, { sessionId: session.sessionId, status: "acknowledged" }, session.sessionBinding)).toEqual({ directives: [], history: "memory-only", history_truncated: false });
	});

	test("a history that cannot be read is unavailable, not an empty list", async () => {
		const { substrate, session, sql } = await harness();
		await acknowledgedByPreviousProcess(sql, session.sessionId);
		sql.failReads = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
		expect(await substrate.readLiveDirectives(OPERATOR, { sessionId: session.sessionId, status: "acknowledged" }, session.sessionBinding)).toEqual({ directives: [], history: "unavailable", history_truncated: false });
	});
});
