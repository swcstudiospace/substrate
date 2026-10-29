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
import { searchReplyStorable, type SearchReply } from "./docs-search.ts";
import { createMcpServer, type McpCaller } from "./mcp.ts";
import { RecordingPresenceBackend } from "./planning/backend.fixtures.ts";
import { listRestDirectives } from "./planning/steering-rest.ts";
import type { PlanningTimers } from "./planning/observer.ts";
import { DragonflyPresenceStore } from "./planning/presence-dragonfly.ts";
import { SteeringInbox } from "./planning/steering.ts";
import type { SessionStateName, SessionStatePort, SessionTransitionResult } from "./planning/steering-delivery.ts";
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
} from "./planning/steering-store.ts";
import { FakeTree, TREE_ROOT } from "./planning/tree.fixtures.ts";
import { IndexStore } from "./index-store.ts";
import type { EventInput } from "./types.ts";
import { Substrate } from "./service.ts";

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
				return ack === undefined ? [] : [stored(row, storedAck(ack))];
			})
			.slice(0, query.limit);
	}

	async savedAcknowledgement(directiveId: string): Promise<SteeringStoredAckRow | null> {
		const ack = this.find(directiveId, "acknowledged");
		return ack === undefined ? null : storedAck(ack);
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

/** A port stub for the tests that inject one (the seam). It MIRRORS `steeringStateTransition` (event.ts); production wires the real `SteeringSessionRegistry`, which the last describe below drives. */
class StubSessionMachine implements SessionStatePort {
	readonly states = new Map<string, SessionStateName>();

	applyTransition(sessionKey: string, target: SessionStateName): SessionTransitionResult {
		const current = this.states.get(sessionKey) ?? "ACTIVE";
		const ok = current === target || (current === "ACTIVE" && (target === "CONTEXT_REFRESH" || target === "PAUSED")) || (current === "CONTEXT_REFRESH" && (target === "ACTIVE" || target === "PAUSED")) || (current === "PAUSED" && target === "RESUMED") || (current === "RESUMED" && (target === "ACTIVE" || target === "PAUSED"));
		if (!ok) return { ok: false, reason: `steering transition ${current} -> ${target} refused` };
		this.states.set(sessionKey, target);
		return { ok: true, changed: current !== target };
	}
}

interface Harness {
	substrate: Substrate;
	sql: FakeAuditSql;
	clock: ManualClock;
	timers: FakeTimers;
	lines: string[];
}

function harness(env: Record<string, string | undefined> = {}, options: { sql?: FakeAuditSql; sessionState?: SessionStatePort | null } = {}): Harness {
	const sql = options.sql ?? new FakeAuditSql();
	const clock = new ManualClock(T0);
	const timers = new FakeTimers();
	const lines: string[] = [];
	const substrate = new Substrate(loadConfig({ ...STEERING_ON, SUBSTRATE_PLANNING_STEERING_ACK_TTL_S: "60", SUBSTRATE_PLANNING_STEERING_EXPIRY_SWEEP_S: "5", ...env }), {
		index: null,
		greptime: null,
		planning: { presence: null, emit: async () => true },
		steering: { history: null, durable: new SteeringAuditSink(sql, sql), ...(options.sessionState !== undefined ? { sessionState: options.sessionState } : {}), timers, nowMs: clock.nowMs, report: (line) => lines.push(line) },
	});
	return { substrate, sql, clock, timers, lines };
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
			const { substrate } = harness({ SUBSTRATE_PLANNING_STEERING_ACK_TTL_S: "5" });
			expect(substrate.steering.inbox).toBeNull();
			expect(substrate.steering.settingsErrors).toEqual([{ key: "SUBSTRATE_PLANNING_STEERING_ACK_TTL_S", reason: "out-of-range", min: 60, max: 2_592_000 }]);
			const client = await connect(substrate, OPERATOR);
			expect(await call(client, "steering_list", { session_id: "sess-a" })).toMatchObject({ isError: true, body: { status: "misconfigured" } });
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
		const { substrate, timers, lines } = harness({}, { sql });
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
		const { substrate } = harness({}, { sql });
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
		const { substrate, clock, timers } = harness({}, { sql });
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
		const { substrate, timers } = harness({ SUBSTRATE_PLANNING_STEERING: "off" }, { sql });
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
		expect(statements).toHaveLength(1);
		expect(statements[0]).toContain("from planning_steering_audit");
		expect(statements[0]).toContain("q.transition = 'queued'");
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
	async function search(substrate: Substrate, sessionId: string | undefined): Promise<SearchReply> {
		return substrate.searchDocs({ question: "", ...(sessionId === undefined ? {} : { session_id: sessionId }) }, "omp");
	}

	test("a session with queued directives reads a count and at most three entries, and the reply is never storable", async () => {
		const sql = new FakeAuditSql();
		await seedPreviousProcess(sql, [
			directive({ id: "d-1", body: `deploy with ${TOKEN}` }),
			directive({ id: "d-2", priority: "high", action: "pause", createdAtMs: T0 + 1 }),
			directive({ id: "d-3", createdAtMs: T0 + 2 }),
			directive({ id: "d-4", createdAtMs: T0 + 3 }),
			directive({ id: "d-other", targetSessionId: "sess-b" }),
		]);
		const { substrate, clock } = harness({}, { sql });
		await substrate.startSteering();
		clock.set(T0 + 4_000);

		const reply = await search(substrate, "sess-a");

		expect(reply.steering?.count).toBe(4);
		expect(reply.steering?.entries.map((entry) => entry.id)).toEqual(["d-2", "d-1", "d-3"]);
		expect(reply.steering?.entries[0]).toMatchObject({ id: "d-2", action: "pause", priority: "high", age_ms: 4_000 });
		expect(JSON.stringify(reply)).not.toContain(TOKEN);
		expect(searchReplyStorable(reply)).toBe(false);
		// A reply is storable only without the notice: it is the notice that makes a reply per call.
		const base: SearchReply = { chunks: [], untrusted: "x" };
		expect(searchReplyStorable(base)).toBe(true);
		expect(searchReplyStorable({ ...base, steering: { count: 1, entries: [], untrusted: "x" } })).toBe(false);
	});

	test("it is absent for a session with nothing queued, with no session named, after an acknowledgement, and with steering off", async () => {
		const sql = new FakeAuditSql();
		await seedPreviousProcess(sql, [directive()]);
		const { substrate } = harness({}, { sql });
		await substrate.startSteering();
		expect(Object.hasOwn(await search(substrate, "sess-z"), "steering")).toBe(false);
		expect(Object.hasOwn(await search(substrate, undefined), "steering")).toBe(false);
		expect(Object.hasOwn(await search(substrate, "sess-a"), "steering")).toBe(true);

		await substrate.steering.inbox?.acknowledge({ directiveId: "d-1", sessionId: "sess-a", outcome: "declined" });
		expect(Object.hasOwn(await search(substrate, "sess-a"), "steering")).toBe(false);

		const off = harness({ SUBSTRATE_PLANNING_STEERING: "off" }, { sql });
		expect(Object.hasOwn(await search(off.substrate, "sess-a"), "steering")).toBe(false);
	});

	test("a fault reading the inbox never fails the search: the reply goes out without the notice", async () => {
		const sql = new FakeAuditSql();
		await seedPreviousProcess(sql, [directive()]);
		const { substrate } = harness({}, { sql });
		await substrate.startSteering();
		const inbox = substrate.steering.inbox;
		if (inbox === null) throw new Error("expected an inbox");
		const broken = spyOn(inbox, "recordsFor").mockImplementation(() => {
			throw new Error("inbox unreadable");
		});
		const stderr = captureStderr();
		try {
			const reply = await search(substrate, "sess-a");
			expect(Object.hasOwn(reply, "steering")).toBe(false);
			expect(reply.chunks).toEqual([]);
			expect(stderr.text()).toContain("steering notice skipped");
		} finally {
			stderr.restore();
			broken.mockRestore();
		}
	});

	test("over MCP the docs_search reply carries the notice", async () => {
		const sql = new FakeAuditSql();
		await seedPreviousProcess(sql, [directive()]);
		const { substrate } = harness({}, { sql });
		await substrate.startSteering();
		const client = await connect(substrate, OPERATOR);

		const reply = await call(client, "docs_search", { question: "", session_id: "sess-a" });
		expect(reply.body).toMatchObject({ steering: { count: 1, entries: [{ id: "d-1", action: "redirect", priority: "normal" }] } });
	});
});

describe("the hint for a queued directive", () => {
	test("each queued directive publishes one steering.queued note that names it and carries no body", async () => {
		const { substrate } = harness();
		const emitted: Array<{ kind: string; surface: string; payload?: Record<string, unknown> }> = [];
		const emit = spyOn(substrate, "emit").mockImplementation((async (event: { kind: string; surface: string; payload?: Record<string, unknown> }) => {
			emitted.push(event);
			return { stored: true };
		}) as never);
		try {
			const client = await connect(substrate, OPERATOR);
			const first = await call(client, "steering_queue", { ...QUEUE_ARGS, body: `Hold it, key ${TOKEN}` });
			const second = await call(client, "steering_queue", QUEUE_ARGS);
			expect(first.body.status).toBe("queued");
			expect(second.body.status).toBe("queued");

			const hints = emitted.filter((event) => event.payload?.["action"] === "steering.queued");
			expect(hints).toHaveLength(2);
			expect(hints.map((event) => event.payload?.["directive_id"])).toEqual([first.body.directive_id, second.body.directive_id]);
			for (const hint of hints) {
				expect(hint).toMatchObject({ kind: "note", surface: "substrate" });
				expect(JSON.stringify(hint)).not.toContain("Hold");
				expect(JSON.stringify(hint)).not.toContain(TOKEN);
			}
		} finally {
			emit.mockRestore();
		}
	});

	/** How many of the recorded `emit` calls are steering.queued hints. Other events are not this test's concern. */
	function hintsIn(calls: ReadonlyArray<readonly [EventInput, ...unknown[]]>): number {
		return calls.filter(([event]) => event.payload?.["action"] === "steering.queued").length;
	}

	test("a refused queue publishes no hint, and a hint the ledger cannot store never fails the queue", async () => {
		const { substrate } = harness();
		const emit = spyOn(substrate, "emit").mockImplementation((async () => ({ stored: false })) as never);
		try {
			const refused = await call(await connect(substrate, { surface: "omp", isOperator: false }), "steering_queue", QUEUE_ARGS);
			expect(refused).toMatchObject({ isError: true, body: { status: "forbidden" } });
			expect(hintsIn(emit.mock.calls)).toBe(0);

			const queued = await call(await connect(substrate, OPERATOR), "steering_queue", QUEUE_ARGS);
			expect(queued).toMatchObject({ isError: false, body: { status: "queued" } });
			expect(hintsIn(emit.mock.calls)).toBe(1);
		} finally {
			emit.mockRestore();
		}
	});
});

describe("an acknowledgement drives the session state", () => {
	async function queuedAndAcknowledged(machine: StubSessionMachine | null, action: "pause" | "redirect" | "annotate", outcome: "applied" | "declined") {
		const { substrate } = harness({}, { sessionState: machine });
		spyOn(substrate, "emit").mockImplementation((async () => ({ stored: true })) as never);
		const client = await connect(substrate, OPERATOR);
		const queued = await call(client, "steering_queue", { ...QUEUE_ARGS, action });
		const acknowledged = await call(client, "steering_acknowledge", { directive_id: queued.body.directive_id, session_id: "sess-a", outcome });
		return acknowledged;
	}

	test("pause applied reads PAUSED and redirect applied reads CONTEXT_REFRESH", async () => {
		const paused = new StubSessionMachine();
		expect(await queuedAndAcknowledged(paused, "pause", "applied")).toMatchObject({ isError: false, body: { status: "acknowledged", session_state: { status: "applied", state: "PAUSED" } } });
		expect(paused.states.get("sess-a")).toBe("PAUSED");

		const refreshed = new StubSessionMachine();
		expect(await queuedAndAcknowledged(refreshed, "redirect", "applied")).toMatchObject({ body: { session_state: { status: "applied", state: "CONTEXT_REFRESH" } } });
		expect(refreshed.states.get("sess-a")).toBe("CONTEXT_REFRESH");
	});

	test("annotate and declined leave the state alone", async () => {
		for (const [action, outcome] of [["annotate", "applied"], ["pause", "declined"]] as const) {
			const machine = new StubSessionMachine();
			expect(await queuedAndAcknowledged(machine, action, outcome)).toMatchObject({ body: { status: "acknowledged", session_state: { status: "unchanged" } } });
			expect(machine.states.size).toBe(0);
		}
	});

	test("a pause for an already PAUSED session reads unchanged and carries no checkpoint_hint", async () => {
		const machine = new StubSessionMachine();
		machine.states.set("sess-a", "PAUSED");
		const reply = await queuedAndAcknowledged(machine, "pause", "applied");
		expect(reply).toMatchObject({ isError: false, body: { status: "acknowledged", session_state: { status: "unchanged" } } });
		expect(Object.hasOwn(reply.body, "checkpoint_hint")).toBe(false);
		expect(machine.states.get("sess-a")).toBe("PAUSED");
	});

	test("a pause that moves the session still carries the checkpoint_hint", async () => {
		const reply = await queuedAndAcknowledged(new StubSessionMachine(), "pause", "applied");
		expect(reply).toMatchObject({ body: { session_state: { status: "applied", state: "PAUSED" }, checkpoint_hint: { trigger: "steering" } } });
	});

	test("with the port injected as null the reply is the plain acknowledgement: no session_state, no checkpoint_hint", async () => {
		const reply = await queuedAndAcknowledged(null, "pause", "applied");
		expect(reply).toMatchObject({ isError: false, body: { status: "acknowledged", outcome: "applied" } });
		expect(Object.hasOwn(reply.body, "session_state")).toBe(false);
		expect(Object.hasOwn(reply.body, "checkpoint_hint")).toBe(false);
	});
});

describe("the two steering mechanisms share one state model", () => {
	/** A substrate on the production default port: no port injected. Its `emit` is recorded and answers stored. */
	function shared() {
		const { substrate } = harness();
		const events: EventInput[] = [];
		spyOn(substrate, "emit").mockImplementation((async (event: EventInput) => {
			events.push(event);
			return { event: { id: `ev-${events.length}` }, stored: true };
		}) as never);
		/** The `docs.steering` notes only: the queue hint and other events are not this describe's concern. */
		const steeringNotes = () => events.filter((event) => event.payload?.["action"] === "docs.steering");
		return { substrate, steeringNotes };
	}

	const SESSION = { session_id: "sess-a", repo_id: "owner/name" };

	test("the registry is the default port while steering is on, and no port exists while it is off", () => {
		const on = harness().substrate;
		expect(on.sessionState).toBe(on.steeringSessions);
		const off = harness({ SUBSTRATE_PLANNING_STEERING: "off" }).substrate;
		expect(off.sessionState).toBeNull();
	});

	test("a pause acknowledged through the inbox changes the state docs_steering_session reports, and the ledger names the directive", async () => {
		const { substrate, steeringNotes } = shared();
		const client = await connect(substrate, OPERATOR);
		expect((await call(client, "docs_steering_session", { ...SESSION, state: "ACTIVE" })).isError).toBe(false);
		const queued = await call(client, "steering_queue", { ...QUEUE_ARGS, action: "pause" });
		const directiveId = String(queued.body.directive_id);
		expect(await call(client, "steering_list", { session_id: "sess-a" })).toMatchObject({ body: { status: "listed", session_state: { status: "held", state: "ACTIVE" } } });

		const acknowledged = await call(client, "steering_acknowledge", { directive_id: directiveId, session_id: "sess-a", outcome: "applied" });
		expect(acknowledged).toMatchObject({
			isError: false,
			body: { status: "acknowledged", session_state: { status: "applied", state: "PAUSED" }, checkpoint_hint: { trigger: "steering", directive_id: directiveId } },
		});

		// docs_steering_session's own state is PAUSED: the claim of previous_state PAUSED is checked against the stored state and holds.
		const reported = await call(client, "docs_steering_session", { ...SESSION, state: "PAUSED", previous_state: "PAUSED" });
		expect(reported).toMatchObject({ isError: false, body: { state: "PAUSED" } });
		expect(await call(client, "steering_list", { session_id: "sess-a" })).toMatchObject({ body: { session_state: { status: "held", state: "PAUSED" } } });

		// The ledger carries one note for the acknowledgement, with the directive id.
		const driven = steeringNotes().filter((event) => event.payload?.["directive_id"] === directiveId);
		expect(driven).toHaveLength(1);
		expect(driven[0]).toMatchObject({ surface: "omp", kind: "warning", session_id: "sess-a" });
		expect(driven[0]?.payload).toMatchObject({ state: "PAUSED", previous_state: "ACTIVE", via: "steering_acknowledge" });
	});

	test("the reverse reads: a state docs_steering_session sets is the state the inbox side sees, and a resume lets a later redirect apply", async () => {
		const { substrate } = shared();
		const client = await connect(substrate, OPERATOR);
		await call(client, "docs_steering_session", { ...SESSION, state: "ACTIVE" });
		await call(client, "docs_steering_session", { ...SESSION, state: "PAUSED" });
		await call(client, "docs_steering_session", { ...SESSION, state: "RESUMED" });
		expect(substrate.steeringSessions.get("omp", "sess-a")?.state).toBe("RESUMED");

		const queued = await call(client, "steering_queue", { ...QUEUE_ARGS, action: "pause" });
		const acknowledged = await call(client, "steering_acknowledge", { directive_id: queued.body.directive_id, session_id: "sess-a", outcome: "applied" });
		expect(acknowledged).toMatchObject({ body: { session_state: { status: "applied", state: "PAUSED" } } });
		expect(substrate.steeringSessions.get("omp", "sess-a")?.state).toBe("PAUSED");
	});

	test("a redirect for a PAUSED session is refused, the acknowledgement stands, no hint is given and the state is unchanged", async () => {
		const { substrate, steeringNotes } = shared();
		const client = await connect(substrate, OPERATOR);
		await call(client, "docs_steering_session", { ...SESSION, state: "PAUSED" });
		const queued = await call(client, "steering_queue", { ...QUEUE_ARGS, action: "redirect" });
		const directiveId = String(queued.body.directive_id);
		const notesBefore = steeringNotes().length;

		const acknowledged = await call(client, "steering_acknowledge", { directive_id: directiveId, session_id: "sess-a", outcome: "applied" });
		expect(acknowledged.isError).toBe(false);
		expect(acknowledged.body).toMatchObject({
			status: "acknowledged",
			outcome: "applied",
			session_state: { status: "refused", state: "CONTEXT_REFRESH", reason: "steering transition PAUSED -> CONTEXT_REFRESH refused" },
		});
		expect(Object.hasOwn(acknowledged.body, "checkpoint_hint")).toBe(false);
		expect(substrate.steeringSessions.get("omp", "sess-a")?.state).toBe("PAUSED");
		expect(steeringNotes()).toHaveLength(notesBefore);
		expect(substrate.steering.inbox?.get(directiveId)?.state).toBe("acknowledged");
	});

	test("a session the server holds no state for is reported as not registered, and the acknowledgement stands", async () => {
		const { substrate } = shared();
		const client = await connect(substrate, OPERATOR);
		const queued = await call(client, "steering_queue", { ...QUEUE_ARGS, action: "pause" });
		expect(await call(client, "steering_list", { session_id: "sess-a" })).toMatchObject({ body: { session_state: { status: "none" } } });

		const acknowledged = await call(client, "steering_acknowledge", { directive_id: queued.body.directive_id, session_id: "sess-a", outcome: "applied" });
		expect(acknowledged).toMatchObject({ isError: false, body: { status: "acknowledged", session_state: { status: "refused", state: "PAUSED", reason: "session not registered" } } });
		expect(Object.hasOwn(acknowledged.body, "checkpoint_hint")).toBe(false);
	});

	test("a pause for an already PAUSED session and a redirect for an already CONTEXT_REFRESH session are unchanged: no hint, no note, state kept", async () => {
		for (const [action, held] of [["pause", "PAUSED"], ["redirect", "CONTEXT_REFRESH"]] as const) {
			const { substrate, steeringNotes } = shared();
			const client = await connect(substrate, OPERATOR);
			await call(client, "docs_steering_session", { ...SESSION, state: held });
			const queued = await call(client, "steering_queue", { ...QUEUE_ARGS, action });
			const notesBefore = steeringNotes().length;

			const acknowledged = await call(client, "steering_acknowledge", { directive_id: queued.body.directive_id, session_id: "sess-a", outcome: "applied" });
			expect(acknowledged).toMatchObject({ isError: false, body: { status: "acknowledged", outcome: "applied", session_state: { status: "unchanged" } } });
			expect(Object.hasOwn(acknowledged.body, "checkpoint_hint")).toBe(false);
			expect(substrate.steeringSessions.get("omp", "sess-a")?.state).toBe(held);
			expect(steeringNotes()).toHaveLength(notesBefore);
		}
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
	/** A previous process queues `d-1` for `sess-a` and acknowledges it as applied, leaving both rows in the table. */
	async function acknowledgedByPreviousProcess(sql: FakeAuditSql): Promise<void> {
		const previous = new SteeringInbox({
			history: new SteeringAuditSink(sql, sql),
			clock: { nowMs: () => T0 },
			policy: { allowlist: ["omp"], ratePerMin: 100 },
		});
		expect((await previous.enqueue(directive())).ok).toBe(true);
		expect((await previous.acknowledge({ directiveId: "d-1", sessionId: "sess-a", outcome: "applied" })).ok).toBe(true);
	}

	test("the route still lists a directive that was acknowledged before the restart, with its checkpoint hint", async () => {
		const sql = new FakeAuditSql();
		await acknowledgedByPreviousProcess(sql);
		const { substrate } = harness({}, { sql });
		await substrate.startSteering();
		const inbox = substrate.steering.inbox;
		if (inbox === null) throw new Error("expected an inbox");
		// Boot restores open directives only, so the inbox no longer holds it; the in-memory view alone would lose the hint.
		expect(inbox.get("d-1")).toBeNull();
		expect(listRestDirectives(inbox, { sessionId: "sess-a", status: "acknowledged" })).toEqual([]);

		const durable = await substrate.durableAcknowledgedFor("sess-a");
		expect(durable).toMatchObject({ history: "durable", truncated: false });
		expect(listRestDirectives(inbox, { sessionId: "sess-a", status: "acknowledged" }, durable.records)).toMatchObject([
			{ id: "d-1", status: "acknowledged", outcome: "applied", checkpoint_hint: { trigger: "steering", directive_id: "d-1" } },
		]);
		// The history is read for the session asked about only.
		expect((await substrate.durableAcknowledgedFor("sess-b")).records).toEqual([]);
	});

	test("without the audit table only the inbox exists, and the answer says so", async () => {
		const history = { append: async (): Promise<void> => undefined };
		const substrate = new Substrate(loadConfig(STEERING_ON), { index: null, greptime: null, planning: { presence: null, emit: async () => true }, steering: { history } });
		expect(await substrate.durableAcknowledgedFor("sess-a")).toEqual({ records: [], history: "memory-only", truncated: false });
	});

	test("a history that cannot be read is unavailable, not an empty list", async () => {
		const sql = new FakeAuditSql();
		await acknowledgedByPreviousProcess(sql);
		sql.failReads = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
		const { substrate } = harness({}, { sql });
		expect(await substrate.durableAcknowledgedFor("sess-a")).toEqual({ records: [], history: "unavailable", truncated: false });
	});
});
