import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AuditUnavailableError, type AuditRecord } from "@substrate/audit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.ts";
import { createMcpServer, type McpCaller } from "./mcp.ts";
import { auditToolCalls, createObservability } from "./observe.ts";
import { createTestLiveSessionAuthority, issueLiveSession } from "./planning/live-session.test-support.ts";
import { SteeringWaiters, type SteeringWaitTimers } from "./planning/steering-waiters.ts";
import type { LiveSessionAuditPort } from "./planning/steering-tools.ts";
import type { SteeringAuditEntry, SteeringHistorySink } from "./planning/steering.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import { defined } from "./test-support.ts";

const OWNER = { surface: "cursor", isOperator: false } as const;
const AUTH_OWNER = { authorization: "Bearer tok-steer-owner" };
const AUTH_OPERATOR = { authorization: "Bearer tok-steer-op" };
const AUTH_FOREIGN = { authorization: "Bearer tok-steer-other" };
const UNKNOWN = `ls_${"f".repeat(64)}`;
const NOT_FOUND = { status: "refused", error: { code: "not-found" } } as const;
class History implements SteeringHistorySink {
	readonly entries: SteeringAuditEntry[] = [];
	async append(entry: SteeringAuditEntry): Promise<void> { this.entries.push(entry); }
}
class FakeTimers implements SteeringWaitTimers {
	readonly live = new Map<number, () => void>();
	readonly delays: number[] = [];
	private sequence = 0;
	private readonly listeners = new Set<() => void>();
	set(run: () => void, ms: number): number { const id = ++this.sequence; this.delays.push(ms); this.live.set(id, run); this.announce(); return id; }
	clear(id: unknown): void { this.live.delete(id as number); this.announce(); }
	fire(): void { const [id, run] = defined([...this.live.entries()][0], "pending wait timer"); this.live.delete(id); run(); }
	/** A wait registers and releases exactly when its timer is armed or disarmed, so tests wait on those transitions. */
	onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	private announce(): void { for (const listener of [...this.listeners]) listener(); }
}
/**
 * Resolves once `condition` holds, re-checked on every timer arming or disarming. The wait is event-driven, so it does not
 * depend on how many event-loop turns the request spends in authority I/O; a condition that never holds ends at the test's timeout.
 */
async function settle(timers: FakeTimers, condition: () => boolean): Promise<void> {
	const reached = Promise.withResolvers<void>();
	const check = (): void => { if (condition()) reached.resolve(); };
	const off = timers.onChange(check);
	try { check(); await reached.promise; } finally { off(); }
}
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
async function serve(extra: Record<string, string | undefined> = {}) {
	const env = {
		SUBSTRATE_PLANNING_STEERING: "on", SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "omp", SUBSTRATE_BRIEF_SESSIONS: "on",
		SUBSTRATE_TOKEN_CURSOR: "tok-steer-owner", SUBSTRATE_TOKEN_OMP: "tok-steer-op", SUBSTRATE_TOKEN_HERMES: "tok-steer-other", SUBSTRATE_OPERATOR_TOKENS: "tok-steer-op",
		SUBSTRATE_BUDGETS: "off", ...extra,
	};
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const authority = createTestLiveSessionAuthority({ nowMs: Date.now() });
	const history = new History();
	const timers = new FakeTimers(); const waiters = new SteeringWaiters({ timers });
	const auditRecords: AuditRecord[] = [];
	let failingAudit = false;
	const append = observability.audit.append.bind(observability.audit);
	spyOn(observability.audit, "append").mockImplementation(async input => {
		if (failingAudit && input.mode === "fail-closed") throw new AuditUnavailableError(input.tool, "test sink unavailable");
		const written = await append(input); auditRecords.push(written.record); return written;
	});
	const audit: LiveSessionAuditPort = { auditCalls: (caller, calls, transport) => auditToolCalls(observability, caller.surface, calls, transport) };
	const substrate = new Substrate(config, { index: null, greptime: null, steering: { history, liveSessions: authority, waiters, report: () => undefined } }, observability.observer, audit);
	const server = createHttpServer(substrate, config, observability);
	const listening = Promise.withResolvers<void>(); server.listen(0, "127.0.0.1", listening.resolve); await listening.promise;
	const address = server.address(); if (address === null || typeof address === "string") throw new Error("missing test listener");
	const base = `http://127.0.0.1:${address.port}`;
	const get = (path: string, headers: Record<string, string> = AUTH_OWNER, signal?: AbortSignal) => fetch(`${base}${path}`, { headers, ...(signal === undefined ? {} : { signal }) });
	const post = (path: string, body: unknown, headers: Record<string, string> = AUTH_OWNER) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
	let stopped = false;
	const stop = async () => { if (stopped) return; stopped = true; waiters.closeAll(); const closed = Promise.withResolvers<void>(); server.close(() => closed.resolve()); await closed.promise; observability.stop(); };
	cleanup.push(stop);
	return { config, substrate, authority, history, waiters, timers, get, post, stop, auditRecords, failAudit: () => { failingAudit = true; } };
}
const proof = (binding: string, headers: Record<string, string> = AUTH_OWNER) => ({ ...headers, "x-substrate-session-binding": binding });
const queueBody = (id: string, extra: Record<string, unknown> = {}) => ({ session_id: id, action: "pause", body: "PRIVATE-DIRECTIVE", ...extra });
interface QueueTransport { post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response> }
async function queue(h: QueueTransport, sessionId: string, extra: Record<string, unknown> = {}) {
	const response = await h.post("/steering/queue", queueBody(sessionId, extra), AUTH_OPERATOR);
	expect(response.status).toBe(200);
	const body = await response.json() as { directive_id: string };
	return body.directive_id;
}
async function clientFor(substrate: Substrate, caller: McpCaller) {
	const server = createMcpServer(substrate, caller); const client = new Client({ name: "steering-http-parity", version: "0.0.0" });
	const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(b), client.connect(a)]);
	cleanup.push(async () => { await client.close(); await server.close(); }); return client;
}
async function tool(client: Client, name: string, args: Record<string, unknown>) {
	const result = await client.callTool({ name, arguments: args }); const content = result.content as Array<{ text?: string }>;
	return { isError: result.isError === true, body: JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown> };
}
async function fingerprint(response: Response) {
	// Only transport-generated headers are normalized; every application header remains part of the denial contract.
	const headers = Object.fromEntries([...response.headers].filter(([key]) => !["date", "connection", "keep-alive", "x-request-id", "x-correlation-id"].includes(key)));
	return { status: response.status, body: await response.text(), headers };
}

describe("real REST lifecycle and independent proof", () => {
	test("open returns proof once, metadata omits private fields, heartbeat renews, close is terminal", async () => {
		const h = await serve();
		const opened = await h.post("/steering/sessions", { repo_id: "owner/name", state: "ACTIVE", steering: "PRIVATE-DIRECTION", planning_hash: "PRIVATE-HASH" });
		expect(opened.status).toBe(200);
		const row = await opened.json() as { session_id: string; session_binding: string };
		expect(row.session_id).toMatch(/^ls_[a-f0-9]{64}$/); expect(row.session_binding).toMatch(/^[a-f0-9]{64}$/);
		const ownerHeaders = proof(row.session_binding);
		const metadata = await (await h.get("/steering/sessions?repo_id=owner/name")).json();
		expect(metadata).toMatchObject({ sessions: [{ session_id: row.session_id }] });
		for (const marker of ["PRIVATE-", row.session_binding, "pending_directives", "planning_hash"]) expect(JSON.stringify(metadata)).not.toContain(marker);
		expect((await h.get(`/steering/directives?session_id=${row.session_id}`, ownerHeaders)).status).toBe(200);
		const heartbeat = await h.post("/steering/sessions/heartbeat", { session_id: row.session_id }, ownerHeaders);
		expect(heartbeat.status).toBe(200); expect(JSON.stringify(await heartbeat.json())).not.toContain(row.session_binding);
		const closed = await h.post("/steering/sessions/close", { session_id: row.session_id }, ownerHeaders);
		expect(closed.status).toBe(200); expect(JSON.stringify(await closed.json())).not.toContain(row.session_binding);
		for (const headers of [ownerHeaders, AUTH_OPERATOR]) {
			const denied = await h.get(`/steering/directives?session_id=${row.session_id}`, headers);
			expect(denied.status).toBe(404); expect(await denied.json()).toEqual(NOT_FOUND);
		}
		expect((await h.post("/steering/sessions/heartbeat", { session_id: row.session_id }, ownerHeaders)).status).toBe(404);
		expect((await h.post("/steering/sessions/close", { session_id: row.session_id }, ownerHeaders)).status).toBe(404);
	});

	for (const operation of ["directives", "wait", "heartbeat", "close", "queue", "acknowledge", "docs", "brief"] as const) test(`${operation}: all well-shaped denied targets share status, bytes and application headers even if audit fails`, async () => {
		const h = await serve();
		const expired = await issueLiveSession(h.authority, { caller: OWNER });
		const expiredDirective = await queue(h, expired.sessionId);
		h.authority.advance(3600_000);
		const sibling = await issueLiveSession(h.authority, { caller: OWNER });
		const owner = await issueLiveSession(h.authority, { caller: OWNER });
		const closed = await issueLiveSession(h.authority, { caller: OWNER });
		const closedDirective = await queue(h, closed.sessionId);
		await h.authority.close(closed.access);
		const directive = await queue(h, owner.sessionId);
		const variants = [
			{ id: owner.sessionId, headers: AUTH_OWNER, directive },
			{ id: owner.sessionId, headers: proof(sibling.sessionBinding), directive },
			{ id: owner.sessionId, headers: proof(owner.sessionBinding, AUTH_FOREIGN), directive },
			{ id: UNKNOWN, headers: proof(owner.sessionBinding), directive: "absent-unknown" },
			{ id: expired.sessionId, headers: proof(expired.sessionBinding), directive: expiredDirective },
			{ id: closed.sessionId, headers: proof(closed.sessionBinding), directive: closedDirective },
		];
		const invoke = (v: typeof variants[number]) => {
			switch (operation) {
				case "directives": return h.get(`/steering/directives?session_id=${v.id}`, v.headers);
				case "wait": return h.get(`/steering/wait?session_id=${v.id}&timeout_ms=1000`, v.headers);
				case "heartbeat": return h.post("/steering/sessions/heartbeat", { session_id: v.id }, v.headers);
				case "close": return h.post("/steering/sessions/close", { session_id: v.id }, v.headers);
				case "queue": return h.post("/steering/queue", queueBody(v.id), v.headers);
				case "acknowledge": return h.post("/steering/acknowledge", { directive_id: v.directive, outcome: "applied" }, v.headers);
				case "docs": return h.post("/docs/search", { question: "public question", steering_session_id: v.id }, v.headers);
				case "brief": return h.post("/brief", { repo: "owner/name", session_id: "historical-label", steering_session_id: v.id }, v.headers);
			}
		};
		const before = h.history.entries.length; const audits = h.auditRecords.length;
		const baseline = await fingerprint(await invoke(defined(variants[0], "missing-proof variant")));
		expect(baseline.status).toBe(404); expect(JSON.parse(baseline.body)).toEqual(NOT_FOUND);
		for (const v of variants.slice(1)) expect(await fingerprint(await invoke(v))).toEqual(baseline);
		h.failAudit();
		for (const v of variants) expect(await fingerprint(await invoke(v))).toEqual(baseline);
		expect(h.history.entries).toHaveLength(before); expect(h.auditRecords).toHaveLength(audits);
		expect(h.waiters.size).toBe(0); expect(h.timers.live.size).toBe(0);
		expect(h.substrate.steering.inbox?.get(directive)?.state).toBe("queued");
	});

	test("anonymous401 and malformed400 are distinct from denied well-shaped targets", async () => {
		const h = await serve();
		for (const path of ["/steering/sessions", `/steering/directives?session_id=${UNKNOWN}`, `/steering/wait?session_id=${UNKNOWN}`, "/session/context?repo_id=owner/name"]) expect((await h.get(path, {})).status).toBe(401);
		for (const path of ["/steering/sessions", "/steering/sessions/heartbeat", "/steering/sessions/close", "/steering/queue", "/steering/acknowledge"]) expect((await h.post(path, {}, {})).status).toBe(401);
		expect((await h.get("/steering/directives")).status).toBe(400);
		expect((await h.get("/steering/wait?session_id=bad%20id")).status).toBe(400);
		expect((await h.post("/steering/queue", { ...queueBody(UNKNOWN), author: "spoof" }, AUTH_OPERATOR)).status).toBe(400);
		expect((await h.post("/steering/sessions", { repo_id: "owner/name", state: "ACTIVE", session_id: UNKNOWN })).status).toBe(400);
	});

	test("SQL authority outage is503, and admitted mutation audit failure has no effect", async () => {
		const h = await serve(); const row = await issueLiveSession(h.authority, { caller: OWNER });
		h.failAudit();
		const failed = await h.post("/steering/sessions/close", { session_id: row.sessionId }, proof(row.sessionBinding));
		expect(failed.status).toBe(503); expect(await failed.json()).toEqual({ status: "refused", error: { code: "audit-unavailable" } });
		expect((await h.authority.read(row.access, "private-read")).ok).toBe(true);
		h.authority.unavailable = true;
		const unavailable = await h.get(`/steering/directives?session_id=${row.sessionId}`, proof(row.sessionBinding));
		expect(unavailable.status).toBe(503); expect(await unavailable.json()).toEqual({ status: "refused", error: { code: "session-unavailable" } });
	});

	test("disabled steering routes remain absent rather than creating identities", async () => {
		const h = await serve({ SUBSTRATE_PLANNING_STEERING: "off" });
		for (const path of ["/steering/sessions", `/steering/directives?session_id=${UNKNOWN}`, `/steering/wait?session_id=${UNKNOWN}`]) expect((await h.get(path)).status).toBe(404);
		for (const path of ["/steering/sessions", "/steering/sessions/heartbeat", "/steering/sessions/close", "/steering/queue", "/steering/acknowledge"]) expect((await h.post(path, {}, AUTH_OPERATOR)).status).toBe(404);
		expect(await h.authority.listMetadata({ repoId: "owner/name", limit: 10 })).toEqual({ ok: true, sessions: [] });
	});
});

describe("unchanged operator/unkeyed and acknowledgement semantics", () => {
	test("bound nonoperator writes403, operator queue and directive-only ack commit state and honest hint", async () => {
		const h = await serve(); const row = await issueLiveSession(h.authority, { caller: OWNER });
		const forbidden = await h.post("/steering/queue", queueBody(row.sessionId), proof(row.sessionBinding));
		expect(forbidden.status).toBe(403); expect(await forbidden.json()).toEqual({ status: "forbidden", reason: "operator-required" });
		const id = await queue(h, row.sessionId);
		const acknowledged = await h.post("/steering/acknowledge", { directive_id: id, outcome: "applied" }, AUTH_OPERATOR);
		expect(acknowledged.status).toBe(200);
		expect(await acknowledged.json()).toMatchObject({ status: "acknowledged", session_state: { status: "applied", state: "PAUSED" }, checkpoint_hint: { trigger: "steering", directive_id: id } });
		const listed = await (await h.get(`/steering/directives?session_id=${row.sessionId}`, proof(row.sessionBinding))).json();
		expect(listed).toMatchObject({ directives: [{ id, status: "acknowledged", checkpoint_hint: { trigger: "steering", directive_id: id } }] });
	});

	test("illegal transition leaves acknowledgement intact and lists without a hint", async () => {
		const h = await serve(); const row = await issueLiveSession(h.authority, { caller: OWNER, state: "PAUSED" });
		const id = await queue(h, row.sessionId, { action: "redirect" });
		const reply = await (await h.post("/steering/acknowledge", { directive_id: id, outcome: "applied" }, AUTH_OPERATOR)).json();
		if (reply === null || typeof reply !== "object" || Array.isArray(reply)) throw new Error("expected acknowledgement object");
		expect(reply).toMatchObject({ status: "acknowledged", session_state: { status: "refused", reason: "invalid-transition" } });
		expect(Object.hasOwn(reply, "checkpoint_hint")).toBe(false);
		expect(await (await h.get(`/steering/directives?session_id=${row.sessionId}`, proof(row.sessionBinding))).json()).toMatchObject({ directives: [{ id, checkpoint_hint: null }] });
	});

	test("conflicting unkeyed acknowledgement requires explicit confirmation", async () => {
		const h = await serve(); const row = await issueLiveSession(h.authority, { caller: OWNER });
		const id = await queue(h, row.sessionId, { conflicts_with_active_plan: true });
		expect((await h.post("/steering/acknowledge", { directive_id: id, outcome: "applied" }, AUTH_OPERATOR)).status).toBe(409);
		expect((await h.post("/steering/acknowledge", { directive_id: id, outcome: "applied", confirm: true }, AUTH_OPERATOR)).status).toBe(200);
	});

	test("MCP and REST owner/sibling refusals are equivalent with trusted ports", async () => {
		const h = await serve(); const row = await issueLiveSession(h.authority, { caller: OWNER });
		const client = await clientFor(h.substrate, OWNER);
		expect(await tool(client, "steering_list", { session_id: row.sessionId })).toEqual({ isError: true, body: NOT_FOUND });
		expect(await (await h.get(`/steering/directives?session_id=${row.sessionId}`)).json()).toEqual(NOT_FOUND);
		expect(await tool(client, "steering_list", { session_id: row.sessionId, session_binding: row.sessionBinding })).toMatchObject({ isError: false, body: { status: "listed" } });
		expect(await tool(client, "steering_queue", { target_session_id: row.sessionId, session_binding: row.sessionBinding, action: "pause", priority: "normal", body: "hold", conflicts_with_active_plan: false })).toMatchObject({ isError: true, body: { status: "forbidden", reason: "operator-required" } });
	});
});

describe("bounded long-poll release and cleanup", () => {
	async function held() {
		const h = await serve(); const row = await issueLiveSession(h.authority, { caller: OWNER });
		const path = `/steering/wait?session_id=${row.sessionId}&timeout_ms=5000`;
		return { ...h, row, path, headers: proof(row.sessionBinding) };
	}
	test("already-queued directive returns immediately without registering timer", async () => {
		const h = await held(); await queue(h, h.row.sessionId);
		const response = await h.get(h.path, h.headers);
		expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ directive: { session_id: h.row.sessionId }, wait_ms: 5000 });
		expect(h.waiters.size).toBe(0); expect(h.timers.live.size).toBe(0);
	});
	test("queue wakes only the owner's held wait and releases all resources", async () => {
		const h = await held(); const pending = h.get(h.path, h.headers); await settle(h.timers, () => h.waiters.size === 1);
		expect(h.timers.delays.every(ms => ms <= 1000)).toBe(true);
		await queue(h, h.row.sessionId);
		expect((await pending).status).toBe(200); expect(h.waiters.size).toBe(0); expect(h.timers.live.size).toBe(0);
	});
	test("final timeout204 rechecks authority and does not recharge or retain a waiter", async () => {
		const h = await held(); let now = 0; const monotonic = spyOn(performance, "now").mockImplementation(() => now);
		try {
			const pending = h.get(h.path, h.headers); await settle(h.timers, () => h.waiters.size === 1);
			now = 5001; h.timers.fire(); const response = await pending;
			expect(response.status).toBe(204); expect(h.waiters.size).toBe(0); expect(h.timers.live.size).toBe(0);
			expect(h.auditRecords.filter(record => record.tool === "steering_wait")).toHaveLength(1);
		} finally { monotonic.mockRestore(); }
	});
	test("overlong waits clamp to the configured ceiling, with bounded internal timers; invalid timeout holds nothing", async () => {
		const h = await held();
		expect((await h.get(`/steering/wait?session_id=${h.row.sessionId}&timeout_ms=0`, h.headers)).status).toBe(400);
		expect(h.waiters.size).toBe(0);
		let now = 0; const monotonic = spyOn(performance, "now").mockImplementation(() => now);
		try {
			const pending = h.get(`/steering/wait?session_id=${h.row.sessionId}&timeout_ms=999999999`, h.headers);
			await settle(h.timers, () => h.waiters.size === 1);
			expect(h.timers.delays.every(ms => ms <= 1000)).toBe(true);
			now = h.config.steeringWaitMaxMs + 1; h.timers.fire();
			const response = await pending;
			expect(response.status).toBe(204);
			expect(response.headers.get("x-steering-wait-ms")).toBe(String(h.config.steeringWaitMaxMs));
			expect(h.waiters.size).toBe(0); expect(h.timers.live.size).toBe(0);
		} finally { monotonic.mockRestore(); }
	});
	for (const failure of ["close", "expiry", "outage"] as const) test(`${failure} before timeout cannot release204 or private directive bytes`, async () => {
		const h = await held(); const pending = h.get(h.path, h.headers); await settle(h.timers, () => h.waiters.size === 1);
		if (failure === "close") await h.authority.close(h.row.access);
		if (failure === "expiry") h.authority.advance(3600_000);
		if (failure === "outage") h.authority.unavailable = true;
		h.timers.fire(); const response = await pending;
		expect(response.status).toBe(failure === "outage" ? 503 : 404);
		expect(await response.json()).toEqual(failure === "outage" ? { status: "refused", error: { code: "session-unavailable" } } : NOT_FOUND);
		expect(h.waiters.size).toBe(0); expect(h.timers.live.size).toBe(0);
	});
	test("explicit service close wakes local waits immediately into terminal404", async () => {
		const h = await held(); const pending = h.get(h.path, h.headers); await settle(h.timers, () => h.waiters.size === 1);
		expect((await h.post("/steering/sessions/close", { session_id: h.row.sessionId }, h.headers)).status).toBe(200);
		expect((await pending).status).toBe(404); expect(h.waiters.size).toBe(0); expect(h.timers.live.size).toBe(0);
	});
	test("client abort and server shutdown leave no waiter or timer", async () => {
		const h = await held(); const abort = new AbortController();
		const pending = h.get(h.path, h.headers, abort.signal).catch((cause: unknown) => cause);
		await settle(h.timers, () => h.waiters.size === 1); abort.abort(); await pending; await settle(h.timers, () => h.waiters.size === 0);
		expect(h.timers.live.size).toBe(0);
		const another = h.get(h.path, h.headers); await settle(h.timers, () => h.waiters.size === 1); await h.stop();
		expect((await another).status).toBe(204); expect(h.waiters.size).toBe(0); expect(h.timers.live.size).toBe(0);
	});
});

describe("historical public digest and explicit private brief remain separate", () => {
	test("REST and MCP session_context preserve proof-free cross-session metadata and self label", async () => {
		const h = await serve(); const row = await issueLiveSession(h.authority, { caller: OWNER, steering: "PRIVATE-DIRECTION", planningHash: "PRIVATE-HASH" });
		const client = await clientFor(h.substrate, OWNER);
		const route = await (await h.get("/session/context?repo_id=owner/name&session_id=historical-label")).json() as Record<string, unknown>;
		const viaTool = await tool(client, "session_context", { repo_id: "owner/name", session_id: "historical-label" });
		expect(viaTool.isError).toBe(false);
		// `generated_at` and `age_s` are read from the clock at each request; a second boundary between the two calls must not fail the comparison.
		const strip = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, field: unknown) => key === "generated_at" || key === "age_s" ? undefined : field)) as unknown;
		expect(strip(viaTool.body)).toEqual(strip(route)); expect(route).toMatchObject({ repo_id: "owner/name", for_session: "historical-label" });
		for (const marker of ["PRIVATE-", row.sessionBinding]) expect(JSON.stringify(route)).not.toContain(marker);
	});
	test("digest malformed/anonymous/disabled behavior is unchanged", async () => {
		const h = await serve({ SUBSTRATE_BRIEF_SESSIONS: "off" });
		expect((await h.get("/session/context?repo_id=owner/name", {})).status).toBe(401);
		const disabled = await h.get("/session/context?repo_id=owner/name"); expect(disabled.status).toBe(503); expect(await disabled.json()).toMatchObject({ refused: true, reason: "session-context.disabled" });
		const client = await clientFor(h.substrate, OWNER);
		expect(await tool(client, "session_context", { repo_id: "owner/name" })).toMatchObject({ isError: true, body: { refused: true, reason: "session-context.disabled" } });
	});
	test("historical-only brief never reads a private directive; explicit owner proof gets request-local augmentation", async () => {
		const h = await serve(); const row = await issueLiveSession(h.authority, { caller: OWNER }); await queue(h, row.sessionId);
		const request = { surface: "cursor" as const, repo: "owner/name", session_id: "historical-label" };
		const historical = await h.substrate.brief(request);
		expect(historical).not.toContain("PRIVATE-DIRECTIVE");
		const privateText = await h.substrate.brief({ ...request, steering_session_id: row.sessionId }, { caller: OWNER, sessionBinding: row.sessionBinding });
		expect(privateText).toContain("PRIVATE-DIRECTIVE"); expect(privateText).not.toContain(row.sessionBinding);
		await expect(h.substrate.brief({ ...request, steering_session_id: row.sessionId }, { caller: OWNER })).rejects.toMatchObject({ refusal: NOT_FOUND });
		expect(await h.substrate.brief(request)).not.toContain("PRIVATE-DIRECTIVE");
	});
});
