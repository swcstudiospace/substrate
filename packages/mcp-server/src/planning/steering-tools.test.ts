import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../config.ts";
import { createMcpServer, type McpCaller } from "../mcp.ts";
import { auditToolCalls, createObservability } from "../observe.ts";
import { Substrate } from "../service.ts";
import { createTestLiveSessionAuthority, issueLiveSession } from "./live-session.test-support.ts";
import { acknowledgeSteering, acknowledgeSteeringWithState, listSteering, queueSteering, type LiveSessionAuditPort, type SteeringWriteResult } from "./steering-tools.ts";
import type { SteeringAuditEntry, SteeringHistorySink } from "./steering.ts";
import type { SessionStatePort } from "./steering-delivery.ts";
import { nextQueuedDirective } from "./steering-waiters.ts";

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

/** The id and sequence of a keyed queue that was applied. Anything else fails the test with the refusal it got. */
function keyedQueued(result: SteeringWriteResult): { directive_id: string; sequence: number } {
	if (result.status !== "queued" || result.sequence === undefined) throw new Error(`test keyed queue refused: ${result.status}`);
	return { directive_id: result.directive_id, sequence: result.sequence };
}
const keyed = (sessionId: string, key: string, overrides: Record<string, unknown> = {}) => ({ ...queue(sessionId, overrides), idempotency_key: key });

describe("keyed steering commands (phase 77)", () => {
	test("a replayed keyed queue returns the original reply and writes nothing", async () => {
		const h = await fixture();
		const args = keyed(h.row.sessionId, "queue-key-0001");
		const original = await queueSteering(h.substrate.steering, OPERATOR, args);
		const audited = h.history.entries.length;
		expect(await queueSteering(h.substrate.steering, OPERATOR, args)).toEqual(original);
		expect(h.history.entries).toHaveLength(audited);
		expect(h.substrate.steering.inbox?.recordsFor(h.row.sessionId)).toHaveLength(1);
		expect(keyedQueued(original).directive_id).toMatch(/^idem-[a-f0-9]{64}$/);
	});

	test("a replay keeps its sequence after later commands are queued", async () => {
		const h = await fixture();
		const first = keyedQueued(await queueSteering(h.substrate.steering, OPERATOR, keyed(h.row.sessionId, "queue-key-0001")));
		const second = keyedQueued(await queueSteering(h.substrate.steering, OPERATOR, keyed(h.row.sessionId, "queue-key-0002", { body: "Second." })));
		expect(second.sequence).toBeGreaterThan(first.sequence);
		expect(keyedQueued(await queueSteering(h.substrate.steering, OPERATOR, keyed(h.row.sessionId, "queue-key-0001")))).toEqual(first);
	});

	test("the same key with a different request is refused and writes nothing", async () => {
		const h = await fixture();
		keyedQueued(await queueSteering(h.substrate.steering, OPERATOR, keyed(h.row.sessionId, "queue-key-0001")));
		const audited = h.history.entries.length;
		const conflict = { status: "refused" as const, error: { code: "idempotency-conflict" as const } };
		expect(await queueSteering(h.substrate.steering, OPERATOR, keyed(h.row.sessionId, "queue-key-0001", { body: "A different instruction." }))).toEqual(conflict);
		expect(await queueSteering(h.substrate.steering, OPERATOR, keyed(h.row.sessionId, "queue-key-0001", { action: "annotate" }))).toEqual(conflict);
		expect(await queueSteering(h.substrate.steering, OPERATOR, keyed(h.sibling.sessionId, "queue-key-0001"))).toEqual(conflict);
		expect(h.history.entries).toHaveLength(audited);
		expect(h.substrate.steering.inbox?.recordsFor(h.row.sessionId).map((record) => record.directive.body)).toEqual(["Review schema first."]);
	});

	test("the same key from another surface is a different command", async () => {
		const h = await fixture({ SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "omp,codex" });
		const mine = keyedQueued(await queueSteering(h.substrate.steering, OPERATOR, keyed(h.row.sessionId, "queue-key-0001")));
		const theirs = keyedQueued(await queueSteering(h.substrate.steering, { surface: "codex", isOperator: true }, keyed(h.row.sessionId, "queue-key-0001")));
		expect(theirs.directive_id).not.toBe(mine.directive_id);
	});

	test("an unkeyed queue keeps its reply shape and a fresh id, and is never deduplicated", async () => {
		const h = await fixture();
		const first = await queueSteering(h.substrate.steering, OPERATOR, queue(h.row.sessionId));
		const second = await queueSteering(h.substrate.steering, OPERATOR, queue(h.row.sessionId));
		if (first.status !== "queued" || second.status !== "queued") throw new Error("test queue refused");
		expect(Object.keys(first).sort()).toEqual(["directive_id", "queued_at_ms", "status", "target_session_id"]);
		expect(second.directive_id).not.toBe(first.directive_id);
		expect(h.history.entries.filter((entry) => entry.event === "queued")).toHaveLength(2);
	});

	test("a replayed keyed acknowledgement returns the stored reply and writes no second row", async () => {
		const h = await fixture();
		const queuedDirective = keyedQueued(await queueSteering(h.substrate.steering, OPERATOR, keyed(h.row.sessionId, "queue-key-0001")));
		const args = { directive_id: queuedDirective.directive_id, session_id: h.row.sessionId, outcome: "declined" as const, idempotency_key: "ack-key-0001" };
		const first = await acknowledgeSteering(h.substrate.steering, OPERATOR, args);
		expect(first).toMatchObject({ status: "acknowledged", outcome: "declined", confirmed: false, sequence: queuedDirective.sequence });
		const audited = h.history.entries.length;
		expect(await acknowledgeSteering(h.substrate.steering, OPERATOR, args)).toEqual(first);
		expect(h.history.entries).toHaveLength(audited);
	});

	test("a replayed keyed acknowledgement that moved the session does not move it again", async () => {
		const h = await fixture();
		const queuedDirective = keyedQueued(await queueSteering(h.substrate.steering, OPERATOR, keyed(h.row.sessionId, "queue-key-0002", { action: "pause" })));
		const moves: string[] = [];
		const port: SessionStatePort = { applyTransition: (sessionKey, target) => { moves.push(`${sessionKey}:${target}`); return { ok: true, changed: true }; } };
		const args = { directive_id: queuedDirective.directive_id, session_id: h.row.sessionId, outcome: "applied" as const, idempotency_key: "ack-key-0002" };
		const first = await acknowledgeSteeringWithState(h.substrate.steering, OPERATOR, args, port);
		expect(first).toMatchObject({ status: "acknowledged", sequence: queuedDirective.sequence, session_state: { status: "applied", state: "PAUSED" } });
		expect(await acknowledgeSteeringWithState(h.substrate.steering, OPERATOR, args, port)).toEqual(first);
		expect(moves).toEqual([`${h.row.sessionId}:PAUSED`]);
	});

	test("a keyed acknowledgement with another outcome under the same key is refused", async () => {
		const h = await fixture();
		const queuedDirective = keyedQueued(await queueSteering(h.substrate.steering, OPERATOR, keyed(h.row.sessionId, "queue-key-0001")));
		const args = { directive_id: queuedDirective.directive_id, session_id: h.row.sessionId, outcome: "declined" as const, idempotency_key: "ack-key-0001" };
		await acknowledgeSteering(h.substrate.steering, OPERATOR, args);
		expect(await acknowledgeSteering(h.substrate.steering, OPERATOR, { ...args, outcome: "applied" as const })).toEqual({ status: "refused", error: { code: "idempotency-conflict" } });
	});

	test("two identical keyed acknowledgements running at once apply the directive once", async () => {
		const h = await fixture();
		const queuedDirective = keyedQueued(await queueSteering(h.substrate.steering, OPERATOR, keyed(h.row.sessionId, "queue-key-0003")));
		const args = { directive_id: queuedDirective.directive_id, session_id: h.row.sessionId, outcome: "declined" as const, idempotency_key: "ack-key-0003" };
		const [a, b] = await Promise.all([acknowledgeSteering(h.substrate.steering, OPERATOR, args), acknowledgeSteering(h.substrate.steering, OPERATOR, args)]);
		expect(b).toEqual(a);
		expect(a).toMatchObject({ status: "acknowledged" });
		expect(h.history.entries.filter((entry) => entry.event === "acknowledged")).toHaveLength(1);
	});

	test("a keyed command refused by the audit is not kept: the retry applies it", async () => {
		const h = await fixture();
		h.history.failing = true;
		expect(await queueSteering(h.substrate.steering, OPERATOR, keyed(h.row.sessionId, "queue-key-0004"))).toMatchObject({ status: "refused", error: { code: "audit-unavailable" } });
		h.history.failing = false;
		const retried = keyedQueued(await queueSteering(h.substrate.steering, OPERATOR, keyed(h.row.sessionId, "queue-key-0004")));
		expect(retried.sequence).toEqual(expect.any(Number));
		expect(h.history.entries.filter((entry) => entry.event === "queued")).toHaveLength(1);
	});

	test("two distinct keyed commands are delivered in sequence order, and a replay does not reorder them", async () => {
		const h = await fixture();
		const inbox = h.substrate.steering.inbox;
		if (inbox === null) throw new Error("test inbox missing");
		const first = keyedQueued(await queueSteering(h.substrate.steering, OPERATOR, keyed(h.row.sessionId, "queue-key-0005", { body: "First." })));
		const second = keyedQueued(await queueSteering(h.substrate.steering, OPERATOR, keyed(h.row.sessionId, "queue-key-0006", { body: "Second." })));
		expect(second.sequence).toBeGreaterThan(first.sequence);
		expect(nextQueuedDirective(inbox, h.row.sessionId, null)?.record.directive.id).toBe(first.directive_id);
		expect(nextQueuedDirective(inbox, h.row.sessionId, first.directive_id)?.record.directive.id).toBe(second.directive_id);
		expect(nextQueuedDirective(inbox, h.row.sessionId, second.directive_id)).toBeNull();
		await queueSteering(h.substrate.steering, OPERATOR, keyed(h.row.sessionId, "queue-key-0005", { body: "First." }));
		expect(inbox.queuedFor(h.row.sessionId).map((entry) => entry.record.directive.id)).toEqual([first.directive_id, second.directive_id]);
	});

	test("the MCP tools expose idempotency_key, and an MCP replay answers the same reply", async () => {
		const h = await fixture();
		const operator = await h.connect(OPERATOR);
		const tools = (await operator.listTools()).tools;
		for (const name of ["steering_queue", "steering_acknowledge"]) expect(tools.find((tool) => tool.name === name)?.inputSchema.properties).toHaveProperty("idempotency_key");
		const args = { ...queue(h.row.sessionId), idempotency_key: "mcp-key-0001" };
		const once = await call(operator, "steering_queue", args);
		expect(once).toMatchObject({ isError: false, body: { status: "queued", sequence: expect.any(Number) } });
		expect(await call(operator, "steering_queue", args)).toEqual(once);
	});
});
