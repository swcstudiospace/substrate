import { SQL } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { IndexStore, MIGRATION_STEPS } from "./index-store.ts";
import { auditToolCalls, createObservability, type Observability } from "./observe.ts";
import { Substrate } from "./service.ts";
import { defined } from "./test-support.ts";
import { issueLiveSession } from "./planning/live-session.test-support.ts";
import { listSteering, LiveSessionBoundaryError, queueSteering, type LiveCallFailure, type LiveSessionAuditPort } from "./planning/steering-tools.ts";
import type { LiveSessionAuthority } from "./planning/steering-sessions-store.ts";
import type { SteeringAuditEntry, SteeringHistorySink } from "./planning/steering.ts";
import { SteeringWaiters, type SteeringWaitRequest, type SteeringWaitResult, type SteeringWaitTimers } from "./planning/steering-waiters.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const describeLive = PG_URL ? describe : describe.skip;
const RUN = `ut-restart-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const REPO = `tests/${RUN}`;
const OWNER = { surface: "cursor", isOperator: false } as const;
const FOREIGN = { surface: "hermes", isOperator: false } as const;
const OPERATOR = { surface: "omp", isOperator: true } as const;
const NOT_FOUND = { status: "refused", error: { code: "not-found" } } as const;
const UNAVAILABLE = { status: "refused", error: { code: "session-unavailable" } } as const;
const DIRECTION = "PRIVATE-RESTART-DIRECTION";
const PLAN_HASH = "PRIVATE-RESTART-PLAN";

class History implements SteeringHistorySink {
	readonly entries: SteeringAuditEntry[] = [];
	async append(entry: SteeringAuditEntry): Promise<void> { this.entries.push(structuredClone(entry)); }
}

// The cross-instance revocation case deliberately measures production 1000ms slices against PostgreSQL's real clock.
// Await timer registration/results rather than sleeping for a guessed SQL/admission duration.
class WaitTimers implements SteeringWaitTimers {
	readonly delays: number[] = [];
	readonly active = new Map<number, { run: () => void; timer?: NodeJS.Timeout }>();
	readonly held = Promise.withResolvers<void>();
	cleared = 0;
	private sequence = 0;
	constructor(private readonly realClock = false) {}
	set(run: () => void, ms: number): number {
		this.delays.push(ms);
		const handle = ++this.sequence;
		this.active.set(handle, { run, ...(this.realClock ? { timer: setTimeout(run, ms) } : {}) });
		this.held.resolve();
		return handle;
	}
	clear(handle: unknown): void {
		const key = handle as number;
		const entry = defined(this.active.get(key), "timer cleared exactly once");
		this.active.delete(key);
		this.cleared++;
		clearTimeout(entry.timer);
	}
	expire(): void { defined(this.active.values().next().value, "held wait timer").run(); }
}

/** Pause a real waiter result, never an authority answer, immediately before the service's final SQL read. */
class ReleaseBarrierWaiters extends SteeringWaiters {
	readonly reached = Promise.withResolvers<SteeringWaitResult>();
	readonly release = Promise.withResolvers<void>();
	override async wait(request: SteeringWaitRequest): Promise<SteeringWaitResult> {
		const result = await super.wait(request);
		this.reached.resolve(result);
		await this.release.promise;
		return result;
	}
	override closeAll(): void { super.closeAll(); this.release.resolve(); }
}

type Outcome<T> = { value: T } | { refusal: LiveCallFailure };
function outcome<T>(work: Promise<T>): Promise<Outcome<T>> {
	return work.then((value) => ({ value }), (cause: unknown) => {
		if (!(cause instanceof LiveSessionBoundaryError)) throw cause;
		return { refusal: cause.refusal };
	});
}


interface Instance {
	service: Substrate;
	pool: SQL;
	index: IndexStore;
	history: History;
	observability: Observability;
	authority: LiveSessionAuthority;
	disconnect(): Promise<void>;
	stop(): Promise<void>;
}
const instances: Instance[] = [];

async function instance(options: { waiters?: SteeringWaiters; sql?: SQL } = {}): Promise<Instance> {
	const directory = await mkdtemp(join(tmpdir(), "substrate-live-restart-"));
	const env = {
		SUBSTRATE_PLANNING_STEERING: "on",
		SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "omp",
		SUBSTRATE_STEERING_SESSIONS_TABLE: "off",
		SUBSTRATE_STEERING_AUDIT_TABLE: "off",
		SUBSTRATE_CACHE: "0",
		SUBSTRATE_BUDGETS: "off",
		SUBSTRATE_BUDGET_READ_BURST: "200",
		SUBSTRATE_BUDGET_WRITE_BURST: "200",
		SUBSTRATE_AUDIT_PATH: join(directory, "audit.jsonl"),
	};
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	// Every instance owns a different pool, boundary, inbox, audit chain and waiter registry.
	const pool = options.sql ?? new SQL(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"), { max: 1 });
	const index = new IndexStore(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"), {
		sql: pool, migrationOptIns: { "steering-audit": false, "steering-sessions": false },
	});
	const history = new History();
	const port: LiveSessionAuditPort = {
		auditCalls: (caller, calls, transport) => auditToolCalls(observability, caller.surface, calls, transport),
	};
	// No authority override: exercise the production IndexStore.liveSessions factory in Substrate.
	const service = new Substrate(config, {
		index, greptime: null, mirror: null, eventBus: () => null,
		steering: { history, ...(options.waiters === undefined ? {} : { waiters: options.waiters }) },
	}, observability.observer, port);
	let disconnected = false;
	let stopped = false;
	const disconnect = async () => {
		if (disconnected) return;
		disconnected = true;
		await index.close();
	};
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		service.steeringWaiters.closeAll();
		service.stopEventBus();
		observability.stop();
		try { await disconnect(); }
		finally { await rm(directory, { recursive: true, force: true }); }
	};
	const h = { service, pool, index, history, observability, disconnect, stop, authority: index.liveSessions({ leaseSeconds: config.liveSessionLeaseS }) };
	instances.push(h);
	return h;
}

async function issue(h: Instance, repoId = REPO) {
	return issueLiveSession(h.authority, { caller: OWNER, repoId, steering: DIRECTION, planningHash: PLAN_HASH });
}
function listed(h: Instance, sessionId: string, sessionBinding?: string) {
	return listSteering(h.service.steering, OWNER, { session_id: sessionId, ...(sessionBinding === undefined ? {} : { session_binding: sessionBinding }) });
}
async function queue(h: Instance, sessionId: string) {
	const result = await queueSteering(h.service.steering, OPERATOR, {
		target_session_id: sessionId, action: "pause", priority: "normal", body: "PRIVATE-RESTART-COMMAND", conflicts_with_active_plan: false,
	});
	if (result.status !== "queued") throw new Error("expected real audited steering queue");
	return result;
}

let control: SQL;
describeLive("HARD-S1 durable service restart and independent-instance release (controlled PostgreSQL)", () => {
	beforeAll(async () => {
		const url = defined(PG_URL, "SUBSTRATE_TEST_PG_URL");
		control = new SQL(url);
		const bootstrap = new IndexStore(url, { migrationOptIns: { "steering-audit": false, "steering-sessions": false } });
		try { await bootstrap.migrate(); }
		finally { await bootstrap.close(); }
	});
	afterEach(async () => {
		for (const h of instances.splice(0).reverse()) await h.stop();
	});
	afterAll(async () => {
		if (!PG_URL || !control) return;
		try {
			// Test-owned SQL cleanup only. No product deletion/pruning API exists for security tombstones.
			await control`delete from live_session_bindings where repo_id = ${REPO}`;
		} finally { await control.close(); }
	});

	test("teardown/reconstruction preserves owner proof, canonical state and terminal tombstone with cache migration off", async () => {
		const first = await instance();
		const entry = await issue(first);
		const sibling = await issue(first);
		expect(first.index.migrationOptIns["steering-sessions"]).toBe(false);
		expect(first.service.config.cacheEnabled).toBe(false);
		const receipt = await first.service.updateLiveSession(OWNER, {
			session_id: entry.sessionId, session_binding: entry.sessionBinding, repo_id: REPO, state: "PAUSED", previous_state: "ACTIVE",
		});
		expect(receipt).toMatchObject({ status: "updated", session_id: entry.sessionId, state: "PAUSED", event_stored: false });
		expect(JSON.stringify(receipt)).not.toContain(DIRECTION);
		expect(JSON.stringify(receipt)).not.toContain(PLAN_HASH);
		expect(JSON.stringify(receipt)).not.toContain(entry.sessionBinding);
		const canonical: Array<{ state: string; steering: string; planning_hash: string }> = await control`
			select state, steering, planning_hash from live_session_bindings where session_id = ${entry.sessionId}`;
		expect(canonical[0]).toEqual({ state: "PAUSED", steering: DIRECTION, planning_hash: PLAN_HASH });
		expect(first.observability.audit.recent().some((record) => record.tool === "docs_steering_session" && record.decision === "allowed")).toBe(true);
		await first.stop();

		const reboot = await instance();
		expect(reboot.pool).not.toBe(first.pool);
		expect(reboot.service.steering.inbox).not.toBe(first.service.steering.inbox);
		expect(await listed(reboot, entry.sessionId, entry.sessionBinding)).toMatchObject({ status: "listed", session_state: { state: "PAUSED" } });
		for (const proof of [undefined, "0".repeat(64), sibling.sessionBinding]) expect(await listed(reboot, entry.sessionId, proof)).toEqual(NOT_FOUND);
		expect(await listSteering(reboot.service.steering, FOREIGN, { session_id: entry.sessionId, session_binding: entry.sessionBinding })).toEqual(NOT_FOUND);
		const closed = await reboot.service.closeLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding });
		expect(closed.status).toBe("closed");
		await reboot.stop();

		const again = await instance();
		expect(await listed(again, entry.sessionId, entry.sessionBinding)).toEqual(NOT_FOUND);
		expect(await outcome(again.service.heartbeatLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding }))).toEqual({ refusal: NOT_FOUND });
		expect(await outcome(again.service.updateLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding, repo_id: REPO, state: "ACTIVE" }))).toEqual({ refusal: NOT_FOUND });
		expect(await listSteering(again.service.steering, OPERATOR, { session_id: entry.sessionId })).toEqual(NOT_FOUND);
		const rows: Array<{ owner_surface: string; closed_at: Date | string | null; steering: string | null; planning_hash: string | null }> = await control`
			select owner_surface, closed_at, steering, planning_hash from live_session_bindings where session_id = ${entry.sessionId}`;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ owner_surface: OWNER.surface, steering: null, planning_hash: null });
		expect(new Date(defined(rows[0]?.closed_at)).toISOString()).toBe(closed.closed_at);
		expect(await listed(again, sibling.sessionId, sibling.sessionBinding)).toMatchObject({ status: "listed" });
		for (const h of [first, reboot, again]) expect(JSON.stringify(h.observability.audit.recent())).not.toContain(entry.sessionBinding);
	});

	for (const operation of ["heartbeat", "transition"] as const) {
		test(`close racing independent-pool ${operation} reports its actual committed effect without revival`, async () => {
			const a = await instance(); const b = await instance(); const entry = await issue(a);
			// A deliberate still-active lease baseline distinguishes a real renewal even within one JS millisecond.
			const before: Array<{ expires_at: Date | string }> = await control`
				update live_session_bindings set expires_at = expires_at - interval '60 seconds'
				where session_id = ${entry.sessionId} returning expires_at`;
			const originalExpiry = new Date(defined(before[0], "pre-race lease").expires_at).toISOString();
			const mutation = operation === "heartbeat"
				? outcome(b.service.heartbeatLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding }))
				: outcome(b.service.updateLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding, repo_id: REPO, state: "PAUSED", previous_state: "ACTIVE" }));
			const [closed, result] = await Promise.all([
				a.service.closeLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding }), mutation,
			]);
			expect(closed.status).toBe("closed");
			const rows: Array<{ state: string; expires_at: Date | string; closed_at: Date | string; steering: string | null; planning_hash: string | null }> = await control`
				select state, expires_at, closed_at, steering, planning_hash from live_session_bindings where session_id = ${entry.sessionId}`;
			expect(rows).toHaveLength(1);
			const row = defined(rows[0], "retained terminal binding");
			expect(new Date(row.closed_at).toISOString()).toBe(closed.closed_at);
			expect(row.steering).toBeNull(); expect(row.planning_hash).toBeNull();
			if ("refusal" in result) {
				expect(result.refusal).toEqual(NOT_FOUND);
				// A 404 means the mutation did NOT commit; close preserves state and lease as evidence.
				expect(row.state).toBe("ACTIVE");
				expect(new Date(row.expires_at).toISOString()).toBe(originalExpiry);
			} else {
				const receipt = result.value;
				expect(receipt.status).toBe(operation === "heartbeat" ? "renewed" : "updated");
				if (receipt.status !== "renewed" && receipt.status !== "updated") throw new Error("expected committed mutation receipt");
				expect(receipt.session_id).toBe(entry.sessionId);
				expect(new Date(row.expires_at).toISOString()).toBe(receipt.expires_at);
				expect(receipt.expires_at).not.toBe(originalExpiry);
				expect(row.state).toBe(operation === "heartbeat" ? "ACTIVE" : "PAUSED");
				expect(JSON.stringify(receipt)).not.toContain(DIRECTION);
				expect(JSON.stringify(receipt)).not.toContain(PLAN_HASH);
				expect(JSON.stringify(receipt)).not.toContain(entry.sessionBinding);
			}
			for (const h of [a, b]) {
				expect(await listed(h, entry.sessionId, entry.sessionBinding)).toEqual(NOT_FOUND);
				expect(await outcome(h.service.heartbeatLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding }))).toEqual({ refusal: NOT_FOUND });
			}
		});
	}

	for (const afterCommit of ["close", "outage"] as const) {
		test(`a committed transition retains its public receipt when ${afterCommit} wins before delivery`, async () => {
			const a = await instance(); const b = await instance(); const entry = await issue(a);
			const committed = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
			const emit = a.service.emit.bind(a.service);
			const barrier = spyOn(a.service, "emit").mockImplementation(async (input, options) => {
				const result = await emit(input, options);
				committed.resolve();
				await release.promise;
				return result;
			});
			const pending = outcome(a.service.updateLiveSession(OWNER, {
				session_id: entry.sessionId, session_binding: entry.sessionBinding, repo_id: REPO, state: "PAUSED", previous_state: "ACTIVE",
			}));
			try {
				await committed.promise;
				const rows: Array<{ state: string }> = await control`select state from live_session_bindings where session_id = ${entry.sessionId}`;
				expect(rows[0]?.state).toBe("PAUSED");
				if (afterCommit === "close") await b.service.closeLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding });
				else await a.disconnect();
				release.resolve();
				const result = await pending;
				expect(result).toMatchObject({ value: { status: "updated", session_id: entry.sessionId, state: "PAUSED", event_stored: false } });
				expect(JSON.stringify(result)).not.toContain(DIRECTION); expect(JSON.stringify(result)).not.toContain(PLAN_HASH);
				expect(await listed(b, entry.sessionId, entry.sessionBinding)).toMatchObject(afterCommit === "close" ? NOT_FOUND : { status: "listed", session_state: { state: "PAUSED" } });
			} finally { release.resolve(); await pending; barrier.mockRestore(); }
		});
	}

	test("queue committed before independent close returns a queued receipt rather than falsely claiming refusal", async () => {
		const a = await instance(); const b = await instance(); const entry = await issue(a);
		const inbox = defined(a.service.steering.inbox, "real inbox");
		const committed = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
		const enqueueReceipt = inbox.enqueueReceipt.bind(inbox);
		const barrier = spyOn(inbox, "enqueueReceipt").mockImplementation(async (input, key) => {
			const result = await enqueueReceipt(input, key);
			committed.resolve();
			await release.promise;
			return result;
		});
		const pending = queueSteering(a.service.steering, OPERATOR, {
			target_session_id: entry.sessionId, action: "pause", priority: "normal", body: "PRIVATE-RESTART-COMMAND", conflicts_with_active_plan: false,
		});
		try {
			await committed.promise;
			expect(inbox.queuedFor(entry.sessionId)).toHaveLength(1);
			await b.service.closeLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding });
			release.resolve();
			const receipt = await pending;
			expect(receipt).toMatchObject({ status: "queued", target_session_id: entry.sessionId });
			if (receipt.status !== "queued") throw new Error("expected committed queue receipt");
			expect(inbox.get(receipt.directive_id)?.state).toBe("queued");
			expect(JSON.stringify(receipt)).not.toContain("PRIVATE-RESTART-COMMAND");
			expect(await listed(a, entry.sessionId, entry.sessionBinding)).toEqual(NOT_FOUND);
			expect(await listSteering(b.service.steering, OPERATOR, { session_id: entry.sessionId })).toEqual(NOT_FOUND);
		} finally { release.resolve(); await pending; barrier.mockRestore(); }
	});

	test("SQL-time expiry overrides an already-admitted independent service and cannot be renewed or re-registered", async () => {
		const a = await instance(); const b = await instance(); const entry = await issue(a);
		expect(await listed(b, entry.sessionId, entry.sessionBinding)).toMatchObject({ status: "listed" });
		await control`update live_session_bindings set expires_at = clock_timestamp() - interval '1 second' where session_id = ${entry.sessionId}`;
		expect(await listed(a, entry.sessionId, entry.sessionBinding)).toEqual(NOT_FOUND);
		expect(await listed(b, entry.sessionId, entry.sessionBinding)).toEqual(NOT_FOUND);
		expect(await outcome(b.service.heartbeatLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding }))).toEqual({ refusal: NOT_FOUND });
		expect(await outcome(b.service.updateLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding, repo_id: REPO, state: "ACTIVE" }))).toEqual({ refusal: NOT_FOUND });
		const discovery = await b.service.listLiveSessions(OWNER, { repoId: REPO, limit: 200 });
		expect(discovery.sessions.some((row) => row.session_id === entry.sessionId)).toBe(false);
		const rows: Array<{ n: number; expired: boolean }> = await control`
			select count(*)::int as n, bool_and(expires_at < clock_timestamp()) as expired from live_session_bindings where session_id = ${entry.sessionId}`;
		expect(rows[0]).toEqual({ n: 1, expired: true });
	});

	test("a held wait observes close from an independent service without any local wake or shared authority map", async () => {
		const timers = new WaitTimers(true); const waiters = new SteeringWaiters({ timers });
		const a = await instance({ waiters }); const b = await instance(); const entry = await issue(a);
		const abort = new AbortController();
		const pending = outcome(a.service.waitLiveDirectives(OWNER, { sessionId: entry.sessionId, after: null, timeoutMs: 10000 }, entry.sessionBinding, abort.signal));
		try {
			await timers.held.promise;
			expect(waiters.size).toBe(1);
			expect(getEventListeners(abort.signal, "abort")).toHaveLength(1);
			const started = performance.now();
			expect((await b.service.closeLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding })).status).toBe("closed");
			expect(await pending).toEqual({ refusal: NOT_FOUND });
			expect(performance.now() - started).toBeLessThan(2000);
			expect(waiters.size).toBe(0);
			expect(b.service.steeringWaiters.size).toBe(0);
			expect(timers.delays.length).toBeGreaterThan(0);
			expect(timers.delays.every((ms) => ms > 0 && ms <= 1000)).toBe(true);
			expect(timers.active.size).toBe(0);
			expect(timers.cleared).toBe(timers.delays.length);
			expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
			expect(a.observability.audit.recent().filter((record) => record.tool === "steering_wait")).toHaveLength(1);
		} finally { abort.abort(); await pending; }
	});

	for (const failure of ["close", "expiry", "outage"] as const) {
		test(`SQL ${failure} before a queued directive's final wait release suppresses private bytes`, async () => {
			const timers = new WaitTimers(); const waiters = new ReleaseBarrierWaiters({ timers });
			const a = await instance({ waiters }); const b = await instance(); const entry = await issue(a);
			const abort = new AbortController();
			const pending = outcome(a.service.waitLiveDirectives(OWNER, { sessionId: entry.sessionId, after: null, timeoutMs: 10000 }, entry.sessionBinding, abort.signal));
			try {
				await timers.held.promise;
				expect(waiters.size).toBe(1);
				const queued = await queue(a, entry.sessionId);
				waiters.notify(entry.sessionId);
				expect(await waiters.reached.promise).toMatchObject({ status: "directive", record: { directive: { id: queued.directive_id, body: "PRIVATE-RESTART-COMMAND" } } });
				if (failure === "close") await b.service.closeLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding });
				else if (failure === "expiry") await control`update live_session_bindings set expires_at = clock_timestamp() - interval '1 second' where session_id = ${entry.sessionId}`;
				else await a.disconnect();
				waiters.release.resolve();
				const result = await pending;
				expect(result).toEqual({ refusal: failure === "outage" ? UNAVAILABLE : NOT_FOUND });
				expect(JSON.stringify(result)).not.toContain("PRIVATE-RESTART-COMMAND");
				expect(waiters.size).toBe(0); expect(timers.active.size).toBe(0);
				expect(timers.cleared).toBe(1); expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
				if (failure === "outage") expect(await listed(b, entry.sessionId, entry.sessionBinding)).toMatchObject({ status: "listed" });
			} finally { waiters.release.resolve(); abort.abort(); await pending; }
		});
	}

	for (const release of ["timeout", "close", "immediate"] as const) {
		test(`authority outage at ${release} wait release is unavailable, never a successful directive/closed/timeout`, async () => {
			const timers = new WaitTimers(); const waiters = new ReleaseBarrierWaiters({ timers });
			const a = await instance({ waiters }); const entry = await issue(a);
			if (release === "immediate") await queue(a, entry.sessionId);
			const abort = new AbortController();
			const pending = outcome(a.service.waitLiveDirectives(OWNER, { sessionId: entry.sessionId, after: null, timeoutMs: 10000 }, entry.sessionBinding, abort.signal));
			try {
				if (release !== "immediate") {
					await timers.held.promise;
					expect(waiters.size).toBe(1);
					if (release === "timeout") timers.expire();
					else waiters.closeSession(entry.sessionId);
				}
				expect((await waiters.reached.promise).status).toBe(release === "immediate" ? "directive" : release === "close" ? "closed" : "timeout");
				await a.disconnect(); waiters.release.resolve();
				expect(await pending).toEqual({ refusal: UNAVAILABLE });
				expect(waiters.size).toBe(0); expect(timers.active.size).toBe(0);
				expect(timers.cleared).toBe(release === "immediate" ? 0 : 1);
				expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
			} finally { waiters.release.resolve(); abort.abort(); await pending; }
		});
	}

	test("actual migration37 stale rows cannot grant or revive across reconstructed services without a cache adapter", async () => {
		const schema = `ut_live_restart_${randomBytes(8).toString("hex")}`;
		await control.unsafe(`create schema ${schema}`);
		try {
			const sql = () => new SQL(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"), { max: 1, connection: { search_path: schema } });
			const a = await instance({ sql: sql() });
			await a.pool.unsafe(defined(MIGRATION_STEPS.find((step) => step.version === 37), "migration37").sql);
			await a.pool.unsafe(defined(MIGRATION_STEPS.find((step) => step.version === 42), "migration42").sql);
			const unissuedId = `ls_${randomBytes(32).toString("hex")}`;
			await a.pool`insert into steering_sessions (surface, session_id, repo_id, state, steering, planning_hash, updated_at)
				values (${OWNER.surface}, ${unissuedId}, ${REPO}, 'ACTIVE', 'STALE-LEGACY-DIRECTION', 'STALE-LEGACY-PLAN', clock_timestamp())`;
			const entry = await issue(a);
			await a.service.closeLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding });
			await a.pool`insert into steering_sessions (surface, session_id, repo_id, state, steering, updated_at)
				values (${OWNER.surface}, ${entry.sessionId}, ${REPO}, 'ACTIVE', 'DELAYED-LEGACY-RESURRECTION', clock_timestamp())`;
			await a.stop();
			const reboot = await instance({ sql: sql() });
			expect(reboot.index.migrationOptIns["steering-sessions"]).toBe(false);
			expect(await listed(reboot, unissuedId, "0".repeat(64))).toEqual(NOT_FOUND);
			expect(await listed(reboot, entry.sessionId, entry.sessionBinding)).toEqual(NOT_FOUND);
			expect(await outcome(reboot.service.updateLiveSession(OWNER, { session_id: unissuedId, session_binding: "0".repeat(64), repo_id: REPO, state: "ACTIVE" }))).toEqual({ refusal: NOT_FOUND });
			expect(await outcome(reboot.service.heartbeatLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding }))).toEqual({ refusal: NOT_FOUND });
			const discovery = await reboot.service.listLiveSessions(OWNER, { repoId: REPO, limit: 200 });
			expect(discovery.sessions).toEqual([]);
			const legacy: Array<{ n: number }> = await reboot.pool`select count(*)::int as n from steering_sessions`;
			expect(legacy[0]?.n).toBe(2);
			const tombstones: Array<{ session_id: string; closed_at: Date | string | null }> = await reboot.pool`select session_id, closed_at from live_session_bindings`;
			expect(tombstones).toHaveLength(1); expect(tombstones[0]?.session_id).toBe(entry.sessionId); expect(tombstones[0]?.closed_at).not.toBeNull();
			await reboot.stop();
		} finally { await control.unsafe(`drop schema ${schema} cascade`); }
	});

	test("a real missing authority schema fails service reads, issuance and mutation closed despite another pool's grant", async () => {
		const good = await instance(); const entry = await issue(good);
		// pg_temp-only resolution cannot see public authority tables. Never drop/rename a shared security table.
		const absent = await instance({ sql: new SQL(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"), { max: 1, connection: { search_path: "pg_temp" } }) });
		const schema: Array<{ relation: string | null }> = await absent.pool`select to_regclass('live_session_bindings')::text as relation`;
		expect(schema[0]?.relation).toBeNull();
		expect(await listed(absent, entry.sessionId, entry.sessionBinding)).toEqual(UNAVAILABLE);
		expect(await outcome(absent.service.updateLiveSession(OWNER, { repo_id: REPO, state: "ACTIVE" }))).toEqual({ refusal: UNAVAILABLE });
		expect(await outcome(absent.service.heartbeatLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding }))).toEqual({ refusal: UNAVAILABLE });
		expect(await outcome(absent.service.closeLiveSession(OWNER, { session_id: entry.sessionId, session_binding: entry.sessionBinding }))).toEqual({ refusal: UNAVAILABLE });
		expect(await listed(good, entry.sessionId, entry.sessionBinding)).toMatchObject({ status: "listed" });
	});
});

// Overlapping storage-level proofs intentionally stay in planning/live-session-authority.pg.test.ts:
// "lost commit responses never report issuance/close success even when PostgreSQL committed";
// "active and terminal collisions retry fresh independent pairs and never change existing binding";
// "clock after lock wait refuses lease expired while transaction was waiting" and the stale previous-state race.
// This suite adds actual Substrate consumers, isolated real generic audits, teardown and wait release boundaries.
// Authored coverage only: all PostgreSQL connections and checks are deferred to the parent's guarded test run.
