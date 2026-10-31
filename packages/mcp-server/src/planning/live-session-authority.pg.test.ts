import { SQL, type TransactionSQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { IndexStore, MIGRATION_STEPS } from "../index-store.ts";
import { defined } from "../test-support.ts";
import { bunLiveSessionAuthority, type LiveSessionAuthority, type LiveSessionCaller } from "./steering-sessions-store.ts";
import { issueLiveSession } from "./live-session.test-support.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const describeLive = PG_URL ? describe : describe.skip;
const RUN = `ut-live-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const repo = `tests/${RUN}`;
const owner: LiveSessionCaller = { surface: "omp", isOperator: false };
const other: LiveSessionCaller = { surface: "cursor", isOperator: false };
const operator: LiveSessionCaller = { surface: "cursor", isOperator: true };
const denied = { ok: false, error: { code: "not-found" } } as const;
const unavailable = { ok: false, error: { code: "session-unavailable" } } as const;
let first: IndexStore;
let second: IndexStore;
let raw: SQL;
let poolA: SQL;
let poolB: SQL;
let a: LiveSessionAuthority;
let b: LiveSessionAuthority;

async function issued(authority = a, caller = owner, repoId = repo) {
	return issueLiveSession(authority, { caller, repoId, steering: "private-direction-marker", planningHash: "private-plan-marker" });
}

async function observeLockWait(pid: number) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const rows: Array<{ wait_event_type: string | null }> = await raw`select wait_event_type from pg_stat_activity where pid = ${pid}`;
		if (rows[0]?.wait_event_type === "Lock") return;
		// PostgreSQL lock acquisition is external to the JS clock; bounded polling observes the actual wait, not a guessed delay.
		await Bun.sleep(10);
	}
	throw new Error("test did not observe the intended row-lock wait");
}

describeLive("durable live-session authority against controlled PostgreSQL (two independent pools)", () => {
	beforeAll(async () => {
		const url = defined(PG_URL, "SUBSTRATE_TEST_PG_URL");
		poolA = new SQL(url, { max: 1 });
		poolB = new SQL(url, { max: 1 });
		raw = new SQL(url);
		first = new IndexStore(url, { sql: poolA, migrationOptIns: { "steering-audit": false, "steering-sessions": false } });
		second = new IndexStore(url, { sql: poolB, migrationOptIns: { "steering-audit": false, "steering-sessions": false } });
		await first.migrate();
		await second.migrate();
		a = first.liveSessions({ leaseSeconds: 3600 });
		b = second.liveSessions({ leaseSeconds: 3600 });
	});

	afterAll(async () => {
		if (!PG_URL) return;
		// Test-owned rows only; product authority deliberately has no delete/prune API.
		if (raw) await raw`delete from live_session_bindings where repo_id like ${`tests/${RUN}%`}`;
		if (first) await first.close();
		if (second) await second.close();
		if (raw) await raw.close();
	});

	test("factory issuance with cache opt-in off persists hash-only canonical state and survives reconnect", async () => {
		const entry = await issued();
		expect(first.migrationOptIns["steering-sessions"]).toBe(false);
		expect(entry.sessionId).toMatch(/^ls_[a-f0-9]{64}$/);
		expect(entry.sessionBinding).toMatch(/^[a-f0-9]{64}$/);
		expect(entry.sessionId.slice(3)).not.toBe(entry.sessionBinding);
		const rows: Array<Record<string, unknown>> = await raw`select * from live_session_bindings where session_id = ${entry.sessionId}`;
		const persisted = defined(rows[0], "issued row");
		const expectedHash = createHash("sha256").update(`substrate.live-session-binding.v1\0${entry.sessionId}\0${entry.sessionBinding}`).digest("hex");
		expect(persisted.binding_proof_hash).toBe(expectedHash);
		expect(JSON.stringify(persisted)).not.toContain(entry.sessionBinding);
		expect(await b.read(entry.access, "private-read")).toEqual({ ok: true, snapshot: entry.snapshot });
		const reboot = new IndexStore(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		try {
			expect(await reboot.liveSessions({ leaseSeconds: 3600 }).read(entry.access, "private-read")).toEqual({ ok: true, snapshot: entry.snapshot });
		} finally { await reboot.close(); }
		expect(await b.read({ caller: entry.access.caller, sessionId: entry.access.sessionId }, "private-read")).toEqual(denied);
		expect(await b.read({ ...entry.access, sessionBinding: "0".repeat(64) }, "private-read")).toEqual(denied);
		expect(await b.read({ ...entry.access, caller: other }, "private-read")).toEqual(denied);
		expect(await b.read({ ...entry.access, sessionId: `ls_${"0".repeat(64)}` }, "private-read")).toEqual(denied);
		expect(await b.read({ ...entry.access, sessionId: "00000000-0000-4000-8000-000000000000" }, "private-read")).toEqual(denied);
	});

	test("step42 is idempotent with no cache backfill and cannot erase terminal identity", async () => {
		const entry = await issued();
		expect((await a.close(entry.access)).ok).toBe(true);
		const step = defined(MIGRATION_STEPS.find((item) => item.version === 42), "migration 42");
		await raw.unsafe(step.sql);
		await raw.unsafe(step.sql);
		const rows: Array<{ closed_at: string | Date | null }> = await raw`select closed_at from live_session_bindings where session_id = ${entry.sessionId}`;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.closed_at).not.toBeNull();
		expect(await b.read(entry.access, "private-read")).toEqual(denied);
	});

	test("state is canonical across pools; immutable owner/repo and omitted private fields persist", async () => {
		const entry = await issued();
		const changed = await b.transition(entry.access, { repoId: repo, state: "PAUSED", previousState: "ACTIVE" }, "owner-transition");
		if (!changed.ok) throw new Error("expected committed transition");
		expect(changed.snapshot.session).toMatchObject({ state: "PAUSED", steering: "private-direction-marker", planning_hash: "private-plan-marker" });
		expect(await a.read(entry.access, "private-read")).toEqual({ ok: true, snapshot: changed.snapshot });
		expect(await a.transition(entry.access, { repoId: `${repo}-foreign`, state: "RESUMED" }, "owner-transition")).toEqual(denied);
		expect(await a.transition({ ...entry.access, caller: other }, { repoId: repo, state: "RESUMED" }, "owner-transition")).toEqual(denied);
		const rows: Array<{ owner_surface: string; repo_id: string }> = await raw`select owner_surface, repo_id from live_session_bindings where session_id = ${entry.sessionId}`;
		expect(rows[0]).toEqual({ owner_surface: "omp", repo_id: repo });
	});

	test("operator observation and ack do not renew, operator heartbeat/ordinary transition need owner proof", async () => {
		const entry = await issued();
		const access = { caller: operator, sessionId: entry.sessionId };
		expect((await b.read(access, "private-read")).ok).toBe(true);
		expect((await b.read(access, "operator-queue")).ok).toBe(true);
		const changed = await b.transition(access, { repoId: repo, state: "PAUSED" }, "operator-ack");
		if (!changed.ok) throw new Error("expected operator ack transition");
		expect(changed.snapshot.expiresAt).toBe(entry.snapshot.expiresAt);
		expect(await b.heartbeat(access)).toEqual(denied);
		expect(await b.transition(access, { repoId: repo, state: "RESUMED" }, "owner-transition")).toEqual(denied);
		expect(await a.transition(entry.access, { repoId: repo, state: "RESUMED" }, "operator-ack")).toEqual(denied);
	});

	test("two stale previous-state transitions cannot both commit", async () => {
		const entry = await issued();
		const results = await Promise.all([a.transition(entry.access, { repoId: repo, state: "PAUSED", previousState: "ACTIVE" }, "owner-transition"),
			b.transition(entry.access, { repoId: repo, state: "CONTEXT_REFRESH", previousState: "ACTIVE" }, "owner-transition")]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok && result.error.code === "invalid-transition")).toHaveLength(1);
	});

	test("close racing heartbeat and transition never resurrects; tombstone persists after reconnect", async () => {
		const entry = await issued();
		const results = await Promise.all([a.close(entry.access), b.heartbeat(entry.access), b.transition(entry.access, { repoId: repo, state: "PAUSED" }, "owner-transition")]);
		expect(results[0]?.ok).toBe(true);
		expect(await a.read(entry.access, "private-read")).toEqual(denied);
		expect(await b.heartbeat(entry.access)).toEqual(denied);
		expect(await b.close(entry.access)).toEqual(denied);
		expect(await b.read({ caller: operator, sessionId: entry.sessionId }, "private-read")).toEqual(denied);
		const rows: Array<Record<string, unknown>> = await raw`select * from live_session_bindings where session_id = ${entry.sessionId}`;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.owner_surface).toBe("omp");
		expect(rows[0]?.steering).toBeNull();
		expect(rows[0]?.planning_hash).toBeNull();
		const closed = results[0];
		if (closed?.ok && "closedAt" in closed) expect(new Date(rows[0]?.closed_at as string | Date).toISOString()).toBe(closed.closedAt);
	});

	test("clock after lock wait refuses lease expired while transaction was waiting", async () => {
		const entry = await issued();
		const pids: Array<{ pid: number }> = await poolB`select pg_backend_pid() as pid`;
		const { promise: ready, resolve: announce } = Promise.withResolvers<void>();
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const blocker = poolA.begin(async (tx) => {
			await tx`select session_id from live_session_bindings where session_id = ${entry.sessionId} for update`;
			announce();
			await gate;
			// Stamp expiry after the waiting transaction began. now() would incorrectly authorize it; post-lock wall time cannot.
			await tx`update live_session_bindings set expires_at = clock_timestamp() where session_id = ${entry.sessionId}`;
		});
		await ready;
		const heartbeat = b.heartbeat(entry.access);
		try {
			await observeLockWait(defined(pids[0], "backend pid").pid);
		} finally { release(); await blocker; }
		expect(await heartbeat).toEqual(denied);
		expect(await a.heartbeat(entry.access)).toEqual(denied);
		const rows: Array<{ n: number }> = await raw`select count(*)::int as n from live_session_bindings where session_id = ${entry.sessionId}`;
		expect(rows[0]?.n).toBe(1);
	});

	test("active and terminal collisions retry fresh independent pairs and never change existing binding", async () => {
		const entry = await issued();
		for (const terminal of [false, true]) {
			if (terminal) expect((await a.close(entry.access)).ok).toBe(true);
			let calls = 0;
			const authority = bunLiveSessionAuthority(poolB, { leaseSeconds: 3600, randomBytes: (size) => {
				calls += 1;
				return calls === 1 ? Buffer.from(entry.sessionId.slice(3), "hex") : randomBytes(size);
			} });
			const next = await issued(authority, other);
			expect(calls).toBe(4);
			expect(next.sessionId).not.toBe(entry.sessionId);
			const rows: Array<{ owner_surface: string; binding_proof_hash: string }> = await raw`select owner_surface, binding_proof_hash from live_session_bindings where session_id = ${entry.sessionId}`;
			expect(rows[0]?.owner_surface).toBe("omp");
			expect(rows[0]?.binding_proof_hash).toBe(createHash("sha256").update(`substrate.live-session-binding.v1\0${entry.sessionId}\0${entry.sessionBinding}`).digest("hex"));
		}
	});

	test("discovery owner/repo/active filters precede limit and public metadata remains text-free", async () => {
		const scoped = `${repo}-discovery`;
		const foreign = await issued(a, other, scoped);
		const owned = await issued(a, owner, scoped);
		const closed = await issued(a, owner, scoped);
		await a.close(closed.access);
		const expired = await issued(a, owner, scoped);
		await raw`update live_session_bindings set expires_at = clock_timestamp() - interval '1 second' where session_id = ${expired.sessionId}`;
		const visible = await b.listVisible(owner, { repoId: scoped, limit: 1 });
		if (!visible.ok) throw new Error("expected metadata discovery");
		expect(visible.sessions.map((session) => session.session_id)).toEqual([owned.sessionId]);
		const publicRows = await b.listMetadata({ repoId: scoped, limit: 1 });
		if (!publicRows.ok || !publicRows.nextCursor) throw new Error("expected paginated public metadata");
		const page2 = await b.listMetadata({ repoId: scoped, limit: 1, cursor: publicRows.nextCursor });
		if (!page2.ok) throw new Error("expected second page");
		expect([...publicRows.sessions, ...page2.sessions].map((session) => session.session_id).sort()).toEqual([foreign.sessionId, owned.sessionId].sort());
		expect(JSON.stringify(publicRows)).not.toContain("private");
		expect(Object.keys(publicRows.sessions[0] ?? {}).sort()).toEqual(["expires_at", "repo_id", "session_id", "state", "surface", "updated_at"]);
	});

	test("legacy SQL rows cannot grant an unissued identity or revive a closed binding", async () => {
		const connection = await raw.reserve();
		try {
			// Connection-local historical schema fixture; the authority uses this same connection and could see these rows.
			await connection`create temporary table steering_sessions (
				surface text not null, session_id text not null, repo_id text not null, state text not null,
				steering text, planning_hash text, updated_at timestamptz not null, primary key (surface, session_id)
			)`;
			const authority = bunLiveSessionAuthority(connection, { leaseSeconds: 3600 });
			const unissuedId = `ls_${randomBytes(32).toString("hex")}`;
			await connection`
				insert into steering_sessions (surface, session_id, repo_id, state, steering, updated_at)
				values ('omp', ${unissuedId}, ${repo}, 'ACTIVE', 'legacy-private-direction', clock_timestamp())`;
			expect(await authority.read({ caller: owner, sessionId: unissuedId, sessionBinding: randomBytes(32).toString("hex") }, "private-read")).toEqual(denied);
			const entry = await issued(authority);
			await connection`delete from steering_sessions where session_id = ${unissuedId}`;
			expect((await authority.read(entry.access, "private-read")).ok).toBe(true);
			expect((await authority.close(entry.access)).ok).toBe(true);
			await connection`
				insert into steering_sessions (surface, session_id, repo_id, state, steering, updated_at)
				values ('omp', ${entry.sessionId}, ${repo}, 'ACTIVE', 'stale-legacy-private-direction', clock_timestamp())`;
			const legacyRows: Array<{ session_id: string }> = await connection`select session_id from steering_sessions`;
			expect(legacyRows.map((item) => item.session_id)).toContain(entry.sessionId);
			expect(await authority.read(entry.access, "private-read")).toEqual(denied);
			expect(await authority.heartbeat(entry.access)).toEqual(denied);
		} finally {
			await connection`drop table if exists pg_temp.steering_sessions`;
			connection.release();
		}
	});

	test("lost commit responses never report issuance/close success even when PostgreSQL committed", async () => {
		const lostResponse = Object.assign(
			(strings: TemplateStringsArray, ...values: unknown[]) => poolB(strings, ...values),
			{ begin: async (callback: (tx: TransactionSQL) => Promise<unknown>) => {
				await poolB.begin(callback);
				throw new Error("simulated lost commit response");
			} },
		) as unknown as SQL;
		const authority = bunLiveSessionAuthority(lostResponse, { leaseSeconds: 3600 });
		const scoped = `${repo}-lost-response`;
		expect(await authority.issue({ caller: owner, repoId: scoped, state: "ACTIVE" })).toEqual(unavailable);
		const rows: Array<{ session_id: string }> = await raw`select session_id from live_session_bindings where repo_id = ${scoped}`;
		expect(rows).toHaveLength(1);
		const orphan = defined(rows[0], "committed but undisclosed issuance");
		expect(await a.read({ caller: owner, sessionId: orphan.session_id }, "private-read")).toEqual(denied);
		const entry = await issued();
		expect(await authority.close(entry.access)).toEqual(unavailable);
		expect(await a.read(entry.access, "private-read")).toEqual(denied);
		expect(await a.close(entry.access)).toEqual(denied);
	});

	test("unavailable pool cannot fall back to another adapter's successful cached grant", async () => {
		const entry = await issued();
		const disconnected = new SQL(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		const authority = bunLiveSessionAuthority(disconnected, { leaseSeconds: 3600 });
		await disconnected.close();
		expect(await authority.read(entry.access, "private-read")).toEqual(unavailable);
		expect(await authority.close(entry.access)).toEqual(unavailable);
		expect((await a.read(entry.access, "private-read")).ok).toBe(true);
	});
});
