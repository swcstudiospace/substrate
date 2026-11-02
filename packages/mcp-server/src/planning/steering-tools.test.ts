import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../config.ts";
import { createMcpServer, type McpCaller } from "../mcp.ts";
import { auditToolCalls, createObservability } from "../observe.ts";
import { Substrate } from "../service.ts";
import { createTestLiveSessionAuthority, issueLiveSession } from "./live-session.test-support.ts";
import { acknowledgeSteering, listSteering, queueSteering, type LiveSessionAuditPort } from "./steering-tools.ts";
import type { SteeringAuditEntry, SteeringHistorySink } from "./steering.ts";

const OWNER = { surface: "cursor", isOperator: false } as const;
const OPERATOR = { surface: "omp", isOperator: true } as const;
class History implements SteeringHistorySink {
	readonly entries: SteeringAuditEntry[] = [];
	failing = false;
	async append(entry: SteeringAuditEntry): Promise<void> { if (this.failing) throw new Error("test history unavailable"); this.entries.push(entry); }
}
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
async function fixture(extra: Record<string, string | undefined> = {}, noHistory = false) {
	const env = { SUBSTRATE_PLANNING_STEERING: "on", SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "omp", ...extra };
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start(); cleanup.push(() => observability.stop());
	const authority = createTestLiveSessionAuthority({ nowMs: Date.now() });
	const row = await issueLiveSession(authority, { caller: OWNER });
	const sibling = await issueLiveSession(authority, { caller: OWNER });
	const history = new History();
	const batches: string[][] = [];
	const port: LiveSessionAuditPort = { auditCalls: async (caller, calls, transport) => { batches.push(calls.map(call => call.tool)); return auditToolCalls(observability, caller.surface, calls, transport); } };
	const substrate = new Substrate(config, { index: null, greptime: null, steering: { history: noHistory ? null : history, liveSessions: authority } }, observability.observer, port);
	async function connect(caller: McpCaller) {
		const server = createMcpServer(substrate, caller);
		const client = new Client({ name: "issued-steering-tools", version: "0.0.0" });
		const [a, b] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(b), client.connect(a)]);
		cleanup.push(async () => { await client.close(); await server.close(); });
		return client;
	}
	return { row, sibling, history, substrate, authority, batches, connect };
}
const queue = (sessionId: string, overrides: Record<string, unknown> = {}) => ({ target_session_id: sessionId, action: "redirect" as const, priority: "normal" as const, body: "Review schema first.", conflicts_with_active_plan: false, ...overrides });
async function call(client: Client, name: string, args: Record<string, unknown>) {
	const result = await client.callTool({ name, arguments: args });
	const content = result.content as Array<{ type: string; text?: string }>;
	return { isError: result.isError === true, body: JSON.parse(content.find(item => item.type === "text")?.text ?? "{}") as Record<string, unknown> };
}

describe("operator inbox policy behind the live boundary", () => {
	test("server assigns distinct directive IDs and the trusted operator authors the audit", async () => {
		const h = await fixture();
		const first = await queueSteering(h.substrate.steering, OPERATOR, queue(h.row.sessionId));
		const second = await queueSteering(h.substrate.steering, OPERATOR, queue(h.row.sessionId));
		if (first.status !== "queued" || second.status !== "queued") throw new Error("test queue refused");
		expect(first.directive_id).toMatch(/^[a-f0-9-]{36}$/);
		expect(second.directive_id).not.toBe(first.directive_id);
		expect(h.history.entries[0]).toMatchObject({ event: "queued", directive: { author: { principalId: "omp", kind: "human" }, targetSessionId: h.row.sessionId } });
		expect(h.batches).toEqual([["steering_queue"], ["steering_queue"]]);
	});

	test("surface allowlist is checked after bound operator admission", async () => {
		const h = await fixture({ SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "codex" });
		expect(await queueSteering(h.substrate.steering, OPERATOR, queue(h.row.sessionId))).toEqual({ status: "refused", error: { code: "principal-not-allowed" } });
		expect(h.history.entries).toEqual([]);
	});

	test("confirmation is required for a conflicting applied directive; declined needs no confirm", async () => {
		const h = await fixture();
		const queued = await queueSteering(h.substrate.steering, OPERATOR, { ...queue(h.row.sessionId), conflicts_with_active_plan: true });
		if (queued.status !== "queued") throw new Error("test queue refused");
		const args = { directive_id: queued.directive_id, session_id: h.row.sessionId, outcome: "applied" as const };
		expect(await acknowledgeSteering(h.substrate.steering, OPERATOR, args)).toEqual({ status: "refused", error: { code: "confirmation-required" } });
		expect(h.history.entries.map(entry => entry.event)).toEqual(["queued"]);
		expect(await acknowledgeSteering(h.substrate.steering, OPERATOR, { ...args, confirm: true })).toEqual({ status: "acknowledged", directive_id: queued.directive_id, outcome: "applied", confirmed: true });
		expect(h.history.entries.map(entry => entry.event)).toEqual(["queued", "acknowledged"]);
	});

	test("failed inbox audit holds queue and acknowledgement effects", async () => {
		const h = await fixture();
		h.history.failing = true;
		expect(await queueSteering(h.substrate.steering, OPERATOR, queue(h.row.sessionId))).toMatchObject({ status: "refused", error: { code: "audit-unavailable", attempts: 2 } });
		h.history.failing = false;
		const queued = await queueSteering(h.substrate.steering, OPERATOR, queue(h.row.sessionId));
		if (queued.status !== "queued") throw new Error("test queue refused");
		h.history.failing = true;
		expect(await acknowledgeSteering(h.substrate.steering, OPERATOR, { directive_id: queued.directive_id, outcome: "declined" })).toMatchObject({ status: "refused", error: { code: "audit-unavailable" } });
		expect(h.substrate.steering.inbox?.get(queued.directive_id)?.state).toBe("queued");
	});

	test("owner list is scoped and priority-ordered, with acknowledged history retained", async () => {
		const h = await fixture();
		const low = await queueSteering(h.substrate.steering, OPERATOR, queue(h.row.sessionId));
		const high = await queueSteering(h.substrate.steering, OPERATOR, { ...queue(h.row.sessionId), priority: "high" });
		await queueSteering(h.substrate.steering, OPERATOR, queue(h.sibling.sessionId));
		if (low.status !== "queued" || high.status !== "queued") throw new Error("test queue refused");
		await acknowledgeSteering(h.substrate.steering, OPERATOR, { directive_id: low.directive_id, outcome: "declined" });
		expect(await listSteering(h.substrate.steering, OWNER, { session_id: h.row.sessionId, session_binding: h.row.sessionBinding })).toMatchObject({ status: "listed", directives: [{ id: high.directive_id, state: "queued", outcome: null }, { id: low.directive_id, state: "acknowledged", outcome: "declined", confirmed: false }] });
	});
});

describe("canonical live updates and truthful committed receipts", () => {
	test("omitted private text/hash carry forward, while previous-state checks follow binding", async () => {
		const h = await fixture();
		const initial = await h.substrate.updateLiveSession(OWNER, { session_id: h.row.sessionId, session_binding: h.row.sessionBinding, repo_id: "owner/name", state: "ACTIVE", steering: "PRIVATE-DIRECTION", planning_hash: "PRIVATE-HASH" });
		expect(initial).toMatchObject({ status: "updated", state: "ACTIVE" });
		const moved = await h.substrate.updateLiveSession(OWNER, { session_id: h.row.sessionId, session_binding: h.row.sessionBinding, repo_id: "owner/name", previous_state: "ACTIVE", state: "PAUSED" });
		expect(moved).toMatchObject({ status: "updated", state: "PAUSED" });
		expect(await h.authority.read(h.row.access, "private-read")).toMatchObject({ ok: true, snapshot: { session: { state: "PAUSED", steering: "PRIVATE-DIRECTION", planning_hash: "PRIVATE-HASH" } } });
		expect(await h.substrate.updateLiveSession(OWNER, { session_id: h.row.sessionId, session_binding: h.row.sessionBinding, repo_id: "owner/name", previous_state: "ACTIVE", state: "RESUMED" })).toEqual({ status: "refused", error: { code: "invalid-transition" } });
		await expect(h.substrate.updateLiveSession(OWNER, { session_id: h.row.sessionId, session_binding: h.sibling.sessionBinding, repo_id: "owner/name", previous_state: "ACTIVE", state: "RESUMED" })).rejects.toMatchObject({ refusal: { status: "refused", error: { code: "not-found" } } });
		await expect(h.substrate.updateLiveSession(OWNER, { session_id: h.row.sessionId, session_binding: h.row.sessionBinding, repo_id: "other/repo", state: "RESUMED" })).rejects.toMatchObject({ refusal: { error: { code: "not-found" } } });
		for (const receipt of [initial, moved]) {
			expect(Object.keys(receipt).sort()).toEqual(["event_stored", "expires_at", "repo_id", "session_id", "state", "status", "updated_at"]);
			expect(JSON.stringify(receipt)).not.toContain("PRIVATE-");
			expect(JSON.stringify(receipt)).not.toContain(h.row.sessionBinding);
		}
	});

	test("closed identities cannot be re-registered or resurrected by the old public handle", async () => {
		const h = await fixture();
		await h.substrate.closeLiveSession(OWNER, { session_id: h.row.sessionId, session_binding: h.row.sessionBinding });
		await expect(h.substrate.updateLiveSession(OWNER, { session_id: h.row.sessionId, session_binding: h.row.sessionBinding, repo_id: "owner/name", state: "ACTIVE" })).rejects.toMatchObject({ refusal: { error: { code: "not-found" } } });
		const fresh = await h.substrate.updateLiveSession(OWNER, { repo_id: "owner/name", state: "ACTIVE" });
		expect(fresh).toMatchObject({ status: "issued" });
		if (fresh.status !== "issued") throw new Error("test issuance refused");
		expect(fresh.session_id).not.toBe(h.row.sessionId);
		expect(fresh.session_binding).not.toBe(h.row.sessionBinding);
	});

	for (const failure of ["close", "outage"] as const) test(`committed heartbeat remains renewed if ${failure} wins before response`, async () => {
		const h = await fixture();
		const heartbeat = h.authority.heartbeat.bind(h.authority);
		const committed: string[] = [];
		const effect = spyOn(h.authority, "heartbeat").mockImplementation(async access => {
			const result = await heartbeat(access);
			if (result.ok) {
				committed.push(result.snapshot.expiresAt);
				if (failure === "close") await h.authority.close(h.row.access);
				else h.authority.unavailable = true;
			}
			return result;
		});
		const receipt = await h.substrate.heartbeatLiveSession(OWNER, { session_id: h.row.sessionId, session_binding: h.row.sessionBinding });
		expect(effect).toHaveBeenCalledTimes(1);
		expect(committed).toHaveLength(1);
		const expiresAt = committed[0];
		if (expiresAt === undefined) throw new Error("expected one committed heartbeat expiry");
		expect(receipt).toEqual({ status: "renewed", session_id: h.row.sessionId, expires_at: expiresAt });
		expect(await listSteering(h.substrate.steering, OWNER, { session_id: h.row.sessionId, session_binding: h.row.sessionBinding })).toEqual({ status: "refused", error: { code: failure === "close" ? "not-found" : "session-unavailable" } });
	});

	for (const failure of ["close", "outage"] as const) test(`committed update remains public updated receipt after ${failure}`, async () => {
		const h = await fixture();
		const transition = h.authority.transition.bind(h.authority);
		const states: string[] = [];
		const effect = spyOn(h.authority, "transition").mockImplementation(async (access, input, operation) => {
			const result = await transition(access, input, operation);
			if (result.ok) {
				states.push(result.snapshot.session.state);
				if (failure === "close") await h.authority.close(h.row.access);
				else h.authority.unavailable = true;
			}
			return result;
		});
		const receipt = await h.substrate.updateLiveSession(OWNER, { session_id: h.row.sessionId, session_binding: h.row.sessionBinding, repo_id: "owner/name", state: "PAUSED", steering: "PRIVATE-COMMITTED-TEXT", planning_hash: "PRIVATE-COMMITTED-HASH" });
		expect(effect).toHaveBeenCalledTimes(1); expect(states).toEqual(["PAUSED"]);
		expect(receipt).toMatchObject({ status: "updated", session_id: h.row.sessionId, state: "PAUSED", event_stored: false });
		expect(JSON.stringify(receipt)).not.toContain("PRIVATE-"); expect(JSON.stringify(receipt)).not.toContain(h.row.sessionBinding);
		expect(await listSteering(h.substrate.steering, OWNER, { session_id: h.row.sessionId, session_binding: h.row.sessionBinding })).toEqual({ status: "refused", error: { code: failure === "close" ? "not-found" : "session-unavailable" } });
	});
});

describe("real registered MCP tools", () => {
	test("strict schemas refuse author/id spoofing without an inbox effect", async () => {
		const h = await fixture(); const client = await h.connect(OPERATOR);
		for (const extra of [{ principal_id: "omp" }, { author_kind: "human" }, { id: "caller-chosen" }]) expect((await client.callTool({ name: "steering_queue", arguments: { ...queue(h.row.sessionId), ...extra } })).isError).toBe(true);
		expect(h.history.entries).toEqual([]);
	});

	test("operator queue/list/ack works without a proof; owner list requires its independent proof", async () => {
		const h = await fixture(); const operator = await h.connect(OPERATOR); const owner = await h.connect(OWNER);
		const queued = await call(operator, "steering_queue", queue(h.row.sessionId));
		expect(queued.isError).toBe(false);
		const directiveId = String(queued.body.directive_id);
		expect(await call(owner, "steering_list", { session_id: h.row.sessionId, session_binding: h.row.sessionBinding })).toMatchObject({ isError: false, body: { status: "listed", directives: [{ id: directiveId }] } });
		expect(await call(owner, "steering_list", { session_id: h.row.sessionId, session_binding: h.sibling.sessionBinding })).toEqual({ isError: true, body: { status: "refused", error: { code: "not-found" } } });
		expect(await call(operator, "steering_acknowledge", { directive_id: directiveId, session_id: h.row.sessionId, outcome: "declined" })).toMatchObject({ isError: false, body: { status: "acknowledged" } });
	});

	test("an admitted owner still cannot use operator writes", async () => {
		const h = await fixture(); const owner = await h.connect(OWNER);
		expect(await call(owner, "steering_queue", { ...queue(h.row.sessionId), session_binding: h.row.sessionBinding })).toEqual({ isError: true, body: { status: "forbidden", reason: "operator-required" } });
		expect(h.history.entries).toEqual([]);
	});

	test("missing inbox history and invalid settings remain typed after authority admission", async () => {
		const absent = await fixture({}, true); const a = await absent.connect(OPERATOR);
		expect(await call(a, "steering_queue", queue(absent.row.sessionId))).toMatchObject({ isError: true, body: { status: "not-configured" } });
		expect(await call(a, "steering_list", { session_id: absent.row.sessionId })).toMatchObject({ body: { status: "not-configured" } });
		const invalid = await fixture({ SUBSTRATE_PLANNING_STEERING_RATE_PER_MIN: "ten" }); const b = await invalid.connect(OPERATOR);
		expect(await call(b, "steering_list", { session_id: invalid.row.sessionId })).toMatchObject({ isError: true, body: { status: "misconfigured", errors: [{ key: "SUBSTRATE_PLANNING_STEERING_RATE_PER_MIN", reason: "not-integer" }] } });
		expect(invalid.history.entries).toEqual([]);
	});

	test("tools remain opt-in and lifecycle tools are registered with steering", async () => {
		const on = await fixture(); const a = await on.connect(OPERATOR);
		expect((await a.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["steering_queue", "steering_acknowledge", "steering_list", "steering_session_heartbeat", "steering_session_close"]));
		const off = await fixture({ SUBSTRATE_PLANNING_STEERING: "off" }); const b = await off.connect(OPERATOR);
		expect((await b.listTools()).tools.map(tool => tool.name)).not.toContain("steering_queue");
	});
});

describe("keyed queue through the real boundary: a replay returns the original reply and writes nothing", () => {
	const KEY = "retry-key-0001";

	test("a keyed reply carries its sequence, and a replay returns the same reply with no second audit write", async () => {
		const h = await fixture();
		const keyed = { ...queue(h.row.sessionId), idempotency_key: KEY };
		const first = await queueSteering(h.substrate.steering, OPERATOR, keyed);
		const replay = await queueSteering(h.substrate.steering, OPERATOR, keyed);
		expect(first).toMatchObject({ status: "queued", target_session_id: h.row.sessionId, sequence: 1 });
		expect(replay).toEqual(first);
		expect(h.history.entries.map((entry) => entry.event)).toEqual(["queued"]);
	});

	test("an unkeyed queue keeps its reply shape, with no sequence", async () => {
		const h = await fixture();
		const queued = await queueSteering(h.substrate.steering, OPERATOR, queue(h.row.sessionId));
		if (queued.status !== "queued") throw new Error("test queue refused");
		expect(Object.keys(queued).sort()).toEqual(["directive_id", "queued_at_ms", "status", "target_session_id"]);
	});

	test("a key from another operator surface does not replay", async () => {
		const h = await fixture({ SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "omp,claude-code" });
		const keyed = { ...queue(h.row.sessionId), idempotency_key: KEY };
		const first = await queueSteering(h.substrate.steering, OPERATOR, keyed);
		const other = await queueSteering(h.substrate.steering, { surface: "claude-code", isOperator: true }, keyed);
		if (first.status !== "queued" || other.status !== "queued") throw new Error("test queue refused");
		expect(other.directive_id).not.toBe(first.directive_id);
		expect(other.sequence).toBe(2);
		expect(h.history.entries.map((entry) => entry.event)).toEqual(["queued", "queued"]);
	});

	test("the MCP steering_queue tool takes the key, and a repeat returns the original reply", async () => {
		const h = await fixture();
		const client = await h.connect(OPERATOR);
		const args = { ...queue(h.row.sessionId), idempotency_key: KEY };
		const first = await call(client, "steering_queue", args);
		const replay = await call(client, "steering_queue", args);
		expect(first.isError).toBe(false);
		expect(first.body).toMatchObject({ status: "queued", sequence: 1 });
		expect(replay.body).toEqual(first.body);
		expect(h.history.entries.map((entry) => entry.event)).toEqual(["queued"]);
	});

	test("a replayed keyed queue announces nothing: only the fresh queue wakes its session", async () => {
		const h = await fixture();
		const emit = spyOn(h.substrate, "emit");
		const first = await queueSteering(h.substrate.steering, OPERATOR, { ...queue(h.row.sessionId), idempotency_key: KEY });
		const announced = emit.mock.calls.length;
		const replay = await queueSteering(h.substrate.steering, OPERATOR, { ...queue(h.row.sessionId), idempotency_key: KEY });
		expect(replay).toEqual(first);
		expect(announced).toBeGreaterThan(0);
		expect(emit.mock.calls.length).toBe(announced);
	});
});
