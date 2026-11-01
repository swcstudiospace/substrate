import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { bunLiveSessionAuthority, EXPIRY_PASS_LIMIT, type LiveSessionCaller, type LiveSessionOperation } from "./steering-sessions-store.ts";
import { createTestLiveSessionAuthority, issueLiveSession } from "./live-session.test-support.ts";

const owner: LiveSessionCaller = { surface: "omp", isOperator: false };
const foreign: LiveSessionCaller = { surface: "cursor", isOperator: false };
const operator: LiveSessionCaller = { surface: "cursor", isOperator: true };
const denied = { ok: false, error: { code: "not-found" } } as const;
const unavailable = { ok: false, error: { code: "session-unavailable" } } as const;
const NOW = "2026-10-31T00:00:00.000Z";
const id = `ls_${"ab".repeat(32)}`;
const proof = "cd".repeat(32);
const digest = createHash("sha256").update(`substrate.live-session-binding.v1\0${id}\0${proof}`).digest("hex");
const row = () => ({ session_id: id, owner_surface: "omp", repo_id: "owner/name", binding_proof_hash: digest,
	issued_at: NOW, expires_at: "2026-10-31T01:00:00.000Z", updated_at: NOW, state: "ACTIVE", closed_at: null,
	steering: "keep private", planning_hash: "plan-1" });

/** Scripted driver boundary for failures/order only; PostgreSQL tests prove actual SQL semantics. */
function scriptedSql(handler: (text: string, values: unknown[]) => unknown[], commitFailure = false) {
	const statements: string[] = [];
	const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
		const text = strings.join("?");
		statements.push(text);
		return handler(text, values);
	};
	const sql = Object.assign(query, { begin: async (fn: (tx: unknown) => Promise<unknown>) => {
		const result = await fn(query);
		if (commitFailure) throw new Error("driver text must not escape");
		return result;
	} }) as unknown as SQL;
	return { sql, statements };
}

describe("live authority driver boundary", () => {
	test("issue draws independent values, inserts only the domain hash and projects no reusable credential", async () => {
		let calls = 0;
		let insertValues: unknown[] = [];
		const driver = scriptedSql((text, values) => {
			if (text.includes("insert into")) { insertValues = values; return [row()]; }
			throw new Error("unexpected query");
		});
		const authority = bunLiveSessionAuthority(driver.sql, { leaseSeconds: 3600,
			randomBytes: (size) => { expect(size).toBe(32); return Buffer.alloc(size, ++calls === 1 ? 0xab : 0xcd); } });
		const result = await authority.issue({ caller: owner, repoId: "owner/name", state: "ACTIVE" });
		expect(result.ok).toBe(true);
		expect(calls).toBe(2);
		expect(insertValues).toContain(id);
		expect(insertValues).toContain(digest);
		expect(insertValues).not.toContain(proof);
		if (result.ok) {
			expect(result.sessionBinding).toBe(proof);
			expect(JSON.stringify(result.snapshot)).not.toContain(proof);
			expect(JSON.stringify(result.snapshot)).not.toContain(digest);
		}
	});

	test("four active or tombstone conflicts exhaust without upsert; every candidate gets a new pair", async () => {
		let draws = 0;
		const driver = scriptedSql(() => []);
		const authority = bunLiveSessionAuthority(driver.sql, { leaseSeconds: 3600, randomBytes: (n) => Buffer.alloc(n, ++draws) });
		expect(await authority.issue({ caller: owner, repoId: "owner/name", state: "ACTIVE" })).toEqual(unavailable);
		expect(draws).toBe(8);
		expect(driver.statements).toHaveLength(4);
		expect(driver.statements.every((text) => text.includes("on conflict (session_id) do nothing"))).toBe(true);
	});

	test("entropy and lost commit responses return no credential or driver diagnostics", async () => {
		const driver = scriptedSql(() => [row()], true);
		const authority = bunLiveSessionAuthority(driver.sql, { leaseSeconds: 3600 });
		expect(await authority.issue({ caller: owner, repoId: "owner/name", state: "ACTIVE" })).toEqual(unavailable);
		const broken = bunLiveSessionAuthority(driver.sql, { leaseSeconds: 3600, randomBytes: () => { throw new Error("entropy unavailable"); } });
		expect(await broken.issue({ caller: owner, repoId: "owner/name", state: "ACTIVE" })).toEqual(unavailable);
		const short = bunLiveSessionAuthority(driver.sql, { leaseSeconds: 3600, randomBytes: () => Buffer.alloc(1) });
		expect(await short.issue({ caller: owner, repoId: "owner/name", state: "ACTIVE" })).toEqual(unavailable);
	});

	test("all private methods fail closed on SQL failure including close commit", async () => {
		const driver = scriptedSql(() => { throw new Error("sensitive driver message"); });
		const authority = bunLiveSessionAuthority(driver.sql, { leaseSeconds: 3600 });
		const access = { caller: owner, sessionId: id, sessionBinding: proof };
		expect(await authority.read(access, "private-read")).toEqual(unavailable);
		expect(await authority.transition(access, { repoId: "owner/name", state: "PAUSED" }, "owner-transition")).toEqual(unavailable);
		expect(await authority.heartbeat(access)).toEqual(unavailable);
		expect(await authority.close(access)).toEqual(unavailable);
		expect(await authority.listVisible(owner, { limit: 10 })).toEqual(unavailable);
		expect(await authority.listMetadata({ repoId: "owner/name", limit: 10 })).toEqual(unavailable);
		const lost = scriptedSql((text) => text.includes("for update") ? [row()] : text.includes("clock_timestamp") ? [{ now: NOW }] : [{ closed_at: NOW }], true);
		expect(await bunLiveSessionAuthority(lost.sql, { leaseSeconds: 3600 }).close(access)).toEqual(unavailable);
	});

	test("SQL wall clock is fetched in a separate statement after row lock; expiry cannot renew", async () => {
		const driver = scriptedSql((text) => text.includes("for update") ? [row()] : [{ now: "2026-10-31T02:00:00.000Z" }]);
		const result = await bunLiveSessionAuthority(driver.sql, { leaseSeconds: 3600 }).heartbeat({ caller: owner, sessionId: id, sessionBinding: proof });
		expect(result).toEqual(denied);
		expect(driver.statements).toHaveLength(2);
		expect(driver.statements[0]).toContain("for update");
		expect(driver.statements[1]).toContain("select clock_timestamp() as now");
	});

	test("invalid transitions are disclosed only after proof/owner validation and repo cannot change", async () => {
		const driver = scriptedSql((text) => text.includes("for update") ? [row()] : [{ now: NOW }]);
		const authority = bunLiveSessionAuthority(driver.sql, { leaseSeconds: 3600 });
		const access = { caller: owner, sessionId: id, sessionBinding: proof };
		expect(await authority.transition({ caller: access.caller, sessionId: access.sessionId }, { repoId: "owner/name", state: "RESUMED" }, "owner-transition")).toEqual(denied);
		expect(await authority.transition(access, { repoId: "other/repo", state: "PAUSED" }, "owner-transition")).toEqual(denied);
		const invalid = await authority.transition(access, { repoId: "owner/name", state: "RESUMED" }, "owner-transition");
		expect(invalid.ok).toBe(false);
		if (!invalid.ok) expect(invalid.error.code).toBe("invalid-transition");
		expect(await authority.transition(access, { repoId: "owner/name", state: "PAUSED" }, "private-read")).toEqual(denied);
	});

	test("discovery SQL filters before cap and never selects private columns; cursor/limits bounded", async () => {
		const driver = scriptedSql(() => [row()]);
		const authority = bunLiveSessionAuthority(driver.sql, { leaseSeconds: 3600 });
		expect((await authority.listVisible(owner, { repoId: "owner/name", limit: 1 })).ok).toBe(true);
		const text = driver.statements.at(-1) ?? "";
		expect(text.indexOf("owner_surface =")).toBeLessThan(text.indexOf("limit"));
		expect(text.indexOf("repo_id =")).toBeLessThan(text.indexOf("limit"));
		expect(text).not.toContain("steering");
		expect(text).not.toContain("binding_proof_hash");
		expect(await authority.listVisible(owner, { limit: 201 })).toEqual(unavailable);
		expect(await authority.listMetadata({ repoId: "owner/name", limit: 1, cursor: "bad" })).toEqual(unavailable);
	});

	test("discovery runs one bounded expiry pass before the scan; a pass failure is unavailable and skips the scan", async () => {
		const failing = scriptedSql((text) => {
			if (text.includes("with due as")) throw new Error("sensitive driver message");
			return [];
		});
		expect(await bunLiveSessionAuthority(failing.sql, { leaseSeconds: 3600 }).listMetadata({ repoId: "owner/name", limit: 10 })).toEqual(unavailable);
		expect(failing.statements).toHaveLength(1);
		let passValues: unknown[] = [];
		const driver = scriptedSql((text, values) => {
			if (text.includes("with due as")) passValues = values;
			return [];
		});
		expect(await bunLiveSessionAuthority(driver.sql, { leaseSeconds: 3600 }).listMetadata({ repoId: "owner/name", limit: 10 })).toEqual({ ok: true, sessions: [] });
		expect(driver.statements).toHaveLength(2);
		expect(driver.statements[0]).toContain("for update skip locked");
		expect(driver.statements[1]).toContain("from live_session_bindings");
		expect(passValues).toEqual([EXPIRY_PASS_LIMIT]);
	});
});

describe("shared issued-session test authority contract", () => {
	test("same-surface sibling/foreign/malformed/missing proof and unknown IDs are indistinguishable", async () => {
		const authority = createTestLiveSessionAuthority();
		const issued = await issueLiveSession(authority, { steering: "private" });
		for (const access of [ { caller: issued.access.caller, sessionId: issued.access.sessionId }, { ...issued.access, sessionBinding: "0".repeat(64) },
			{ ...issued.access, sessionBinding: "bad" }, { ...issued.access, caller: foreign },
			{ ...issued.access, sessionId: `ls_${"0".repeat(64)}` }, { ...issued.access, sessionId: "arbitrary-uuid" } ]) {
			expect(await authority.read(access, "private-read")).toEqual(denied);
			expect(await authority.heartbeat(access)).toEqual(denied);
			expect(await authority.close(access)).toEqual(denied);
		}
	});
	test("operators bypass only explicit operations, never owner transitions/heartbeat or terminal state", async () => {
		const authority = createTestLiveSessionAuthority();
		const issued = await issueLiveSession(authority);
		const access = { caller: operator, sessionId: issued.sessionId };
		for (const operation of ["private-read", "operator-queue", "operator-ack"] as LiveSessionOperation[]) expect((await authority.read(access, operation)).ok).toBe(true);
		expect(await authority.heartbeat(access)).toEqual(denied);
		expect(await authority.transition(access, { repoId: "owner/name", state: "PAUSED" }, "owner-transition")).toEqual(denied);
		expect((await authority.close(access)).ok).toBe(true);
		expect(await authority.close(access)).toEqual(denied);
		expect(await authority.read(access, "private-read")).toEqual(denied);
	});
	test("canonical fields survive omitted updates; ack/read do not renew; expiry and close are terminal", async () => {
		const authority = createTestLiveSessionAuthority({ leaseSeconds: 10 });
		const issued = await issueLiveSession(authority, { steering: "private", planningHash: "plan" });
		authority.advance(1000);
		const changed = await authority.transition(issued.access, { repoId: "owner/name", state: "PAUSED", previousState: "ACTIVE" }, "owner-transition");
		expect(changed.ok).toBe(true);
		if (!changed.ok) throw new Error("expected transition");
		expect(changed.snapshot.session).toMatchObject({ steering: "private", planning_hash: "plan" });
		expect(changed.snapshot.expiresAt).not.toBe(issued.snapshot.expiresAt);
		authority.advance(1000);
		const ack = await authority.transition({ caller: operator, sessionId: issued.sessionId }, { repoId: "owner/name", state: "RESUMED" }, "operator-ack");
		if (!ack.ok) throw new Error("expected operator ack transition");
		expect(ack.snapshot.expiresAt).toBe(changed.snapshot.expiresAt);
		authority.advance(10000);
		expect(await authority.heartbeat(issued.access)).toEqual(denied);
		expect(await authority.read(issued.access, "private-read")).toEqual(denied);
	});
	test("metadata is cross-surface and text-free while visible discovery stays owner filtered", async () => {
		const authority = createTestLiveSessionAuthority();
		await issueLiveSession(authority, { caller: foreign, steering: "foreign-private" });
		const owned = await issueLiveSession(authority, { steering: "owner-private", planningHash: "private-plan" });
		const visible = await authority.listVisible(owner, { limit: 1, repoId: "owner/name" });
		if (!visible.ok) throw new Error("expected visible metadata");
		expect(visible.sessions.map((s) => s.session_id)).toEqual([owned.sessionId]);
		const publicRows = await authority.listMetadata({ limit: 10, repoId: "owner/name" });
		if (!publicRows.ok) throw new Error("expected public metadata");
		expect(publicRows.sessions).toHaveLength(2);
		expect(Object.keys(publicRows.sessions[0] ?? {}).sort()).toEqual(["expires_at", "repo_id", "session_id", "state", "surface", "updated_at"]);
		expect(JSON.stringify(publicRows)).not.toContain("private");
	});
});
