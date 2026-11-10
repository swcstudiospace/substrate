import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { loadConfig } from "./config.ts";
import type { McpToolCall } from "./observe.ts";
import { Substrate } from "./service.ts";
import { issueLiveSession } from "./planning/live-session.test-support.ts";
import { acknowledgeSteeringWithState, listSteering, LiveSessionBoundaryError, queueSteering } from "./planning/steering-tools.ts";
import { AUTH_OWNER, AUTH_FOREIGN, AUTH_OPERATOR, OWNER, OPERATOR, UNKNOWN, NOT_FOUND, issued, call, toolValue, settle, serveLive, cleanupLiveHarness } from "./live-session-consumer.test-support.ts";

const serve = (extra: Record<string, string | undefined> = {}, missingAudit = false) => serveLive(extra, { missingAudit });
afterEach(cleanupLiveHarness);

describe("real live consumers", () => {
	test("REST issue, metadata discovery, proof reads, heartbeat and terminal close", async () => {
		const h = await serve();
		const created = await h.post("/steering/sessions", { repo_id: "owner/name", state: "ACTIVE", steering: "PRIVATE-DIRECTION-MARKER", planning_hash: "PRIVATE-PLAN-MARKER" });
		expect(created.status).toBe(200);
		const entry = issued(await created.json());
		const proof = { ...AUTH_OWNER, "x-substrate-session-binding": entry.session_binding };
		const metadata = await (await h.get("/steering/sessions?repo_id=owner/name")).json();
		expect(JSON.stringify(metadata)).not.toContain("PRIVATE-");
		expect(JSON.stringify(metadata)).not.toContain("pending_directives");
		expect(JSON.stringify(metadata)).not.toContain(entry.session_binding);
		expect((await h.get(`/steering/directives?session_id=${entry.session_id}`, proof)).status).toBe(200);
		const denied = await Promise.all([
			h.get(`/steering/directives?session_id=${entry.session_id}`),
			h.get(`/steering/directives?session_id=${entry.session_id}`, { ...AUTH_OWNER, "x-substrate-session-binding": "0".repeat(64) }),
			h.get(`/steering/directives?session_id=${entry.session_id}`, { ...AUTH_FOREIGN, "x-substrate-session-binding": entry.session_binding }),
			h.get(`/steering/directives?session_id=${UNKNOWN}`),
		]);
		for (const response of denied) { expect(response.status).toBe(404); expect(await response.json()).toEqual(NOT_FOUND); expect(response.headers.get("retry-after")).toBeNull(); }
		expect((await h.post("/steering/sessions/heartbeat", { session_id: entry.session_id }, proof)).status).toBe(200);
		expect((await h.post("/steering/sessions/close", { session_id: entry.session_id }, proof)).status).toBe(200);
		const closed = await h.get(`/steering/directives?session_id=${entry.session_id}`, proof);
		expect(closed.status).toBe(404); expect(await closed.json()).toEqual(NOT_FOUND);
	});

	test("unknown registration cannot take over, and admitted required audit cannot be absent", async () => {
		const h = await serve({}, true);
		await expect(h.substrate.updateLiveSession(OWNER, { repo_id: "owner/name", state: "ACTIVE" })).rejects.toMatchObject({ refusal: { error: { code: "audit-unavailable" } } });
		await expect(h.substrate.updateLiveSession(OWNER, { session_id: UNKNOWN, repo_id: "owner/name", state: "ACTIVE" })).rejects.toMatchObject({ refusal: NOT_FOUND });
		const row = await issueLiveSession(h.authority, { caller: OWNER });
		expect((await listSteering(h.substrate.steering, OWNER, { session_id: row.sessionId })).status).toBe("refused");
		const unchanged = await h.authority.read(row.access, "private-read");
		expect(unchanged.ok).toBe(true);
	});

	test("MCP preflight precedes fail-closed audit, refusal cancels unrelated batch members", async () => {
		const h = await serve(); h.setAuditFailure(true);
		const reply = await h.rpc([call(1, "steering_session_close", { session_id: UNKNOWN }), call(2, "events_emit", { kind: "note", summary: "must not run" })]);
		const responses = z.array(z.object({ id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() })).parse(reply);
		expect(toolValue(responses[0])).toEqual(NOT_FOUND);
		expect(responses[1]?.error).toMatchObject({ message: "batch not dispatched" });
		expect(h.batches).toHaveLength(0);
		expect(h.ledger.events.some((event) => event.summary === "must not run")).toBe(false);
		const row = await issueLiveSession(h.authority, { caller: OWNER });
		const refused = await h.post("/steering/sessions/close", { session_id: row.sessionId }, { ...AUTH_OWNER, "x-substrate-session-binding": row.sessionBinding });
		expect(refused.status).toBe(503); expect(await refused.json()).toEqual({ status: "refused", error: { code: "audit-unavailable" } });
		expect((await h.authority.read(row.access, "private-read")).ok).toBe(true);
	});

	for (const mode of ["off", "shadow"]) test(`mandatory principal budget precedes directive lookup and all audits in ${mode}`, async () => {
		const h = await serve({ SUBSTRATE_BUDGETS: mode, SUBSTRATE_BUDGET_WRITE_BURST: "1", SUBSTRATE_BUDGET_WRITE_RPS: "0.01" });
		const inbox = h.substrate.steering.inbox;
		if (inbox === null) throw new Error("missing test inbox");
		const lookup = spyOn(inbox, "get"); const read = spyOn(h.authority, "read");
		const first = await h.post("/steering/acknowledge", { directive_id: "absent-one", outcome: "applied" }, AUTH_OPERATOR);
		expect(first.status).toBe(404);
		const lookups = lookup.mock.calls.length; const records = h.ledger.events.length;
		const limited = await h.post("/steering/acknowledge", { directive_id: "absent-two", outcome: "applied" }, AUTH_OPERATOR);
		expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).not.toBeNull();
		expect(lookup.mock.calls.length).toBe(lookups); expect(read).not.toHaveBeenCalled(); expect(h.ledger.events).toHaveLength(records); expect(h.batches).toHaveLength(0);
	});

	test("all batch costs reserve before any lookup; one-use dispatch charges and audits once", async () => {
		const h = await serve({ SUBSTRATE_BUDGET_READ_BURST: "2", SUBSTRATE_BUDGET_READ_RPS: "0.01" });
		const row = await issueLiveSession(h.authority, { caller: OWNER });
		const args = { session_id: row.sessionId, session_binding: row.sessionBinding };
		const calls: McpToolCall[] = [{ id: 1, tool: "steering_list", args }, { id: 2, tool: "steering_list", args }];
		const prepared = await h.substrate.prepareLiveBatch(OWNER, calls);
		if (!prepared.ok) throw new Error("expected prepared batch");
		const audited = await h.substrate.auditPreparedBatch(prepared.batch, calls, "mcp");
		if (!audited.ok) throw new Error("expected audited dispatch");
		expect((await listSteering(h.substrate.steering, OWNER, args, audited.dispatch)).status).toBe("listed");
		expect((await listSteering(h.substrate.steering, OWNER, args, audited.dispatch)).status).toBe("listed");
		expect(await listSteering(h.substrate.steering, OWNER, args, audited.dispatch)).toEqual(NOT_FOUND);
		expect(h.batches).toHaveLength(1);
		const read = spyOn(h.authority, "read"); read.mockClear();
		const next = await h.substrate.prepareLiveBatch(OWNER, calls);
		expect(next).toMatchObject({ ok: false, refusal: { error: { code: "principal-rate-limited" } } });
		expect(read).not.toHaveBeenCalled(); expect(h.batches).toHaveLength(1);
	});

	test("REST and HTTP MCP generic audit records omit live target plaintext", async () => {
		const h = await serve(); const row = await issueLiveSession(h.authority, { caller: OWNER });
		const proof = { ...AUTH_OWNER, "x-substrate-session-binding": row.sessionBinding };
		expect((await h.post("/steering/sessions/heartbeat", { session_id: row.sessionId }, proof)).status).toBe(200);
		expect(toolValue(await h.rpc(call(1, "steering_list", { session_id: row.sessionId, session_binding: row.sessionBinding })))).toMatchObject({ status: "listed" });
		expect(h.batches).toHaveLength(2);
		const privateRecords = h.auditRecords.filter((record) => ["steering_session_heartbeat", "steering_list"].includes(record.tool));
		expect(privateRecords).toHaveLength(2);
		for (const record of privateRecords) { expect(record.session_id).toBeNull(); expect(record.arg_digest).not.toBeNull(); }
		expect(JSON.stringify(privateRecords)).not.toContain(row.sessionId); expect(JSON.stringify(privateRecords)).not.toContain(row.sessionBinding);
	});

	test("actually emitted transition, ack, retrieval and close events remain safe through sibling historical queries", async () => {
		const h = await serve();
		await h.substrate.emit({ surface: OWNER.surface, kind: "note", summary: "historical checkpoint", session_id: "historical-checkpoint-label", payload: { action: "session.checkpoint", historical: "LEGACY-PUBLISHED-PAYLOAD" } });
		const historicalBefore = structuredClone(h.ledger.events.find((event) => event.session_id === "historical-checkpoint-label"));
		const entry = issued(toolValue(await h.rpc(call(1, "docs_steering_session", { repo_id: "owner/name", state: "ACTIVE", steering: "PRIVATE-DIRECTION-MARKER", planning_hash: "PRIVATE-PLAN-MARKER" }))));
		const queued = await queueSteering(h.substrate.steering, OPERATOR, { target_session_id: entry.session_id, action: "pause", priority: "normal", body: "PRIVATE-DIRECTIVE-MARKER", conflicts_with_active_plan: false });
		if (queued.status !== "queued") throw new Error("expected queued directive");
		const ack = await acknowledgeSteeringWithState(h.substrate.steering, OPERATOR, { directive_id: queued.directive_id, session_id: entry.session_id, outcome: "applied" }, h.substrate.sessionState);
		expect(ack).toMatchObject({ status: "acknowledged", session_state: { status: "applied" } });
		expect(toolValue(await h.rpc(call(2, "docs_steering_session", { session_id: entry.session_id, session_binding: entry.session_binding, repo_id: "owner/name", state: "RESUMED" })))).toMatchObject({ status: "updated" });
		await h.substrate.searchDocs({ question: "public question", steering_session_id: entry.session_id }, OWNER.surface, { caller: OWNER, sessionBinding: entry.session_binding });
		await h.substrate.closeLiveSession(OWNER, { session_id: entry.session_id, session_binding: entry.session_binding });
		// Same-surface sibling has its own proof but intentionally supplies none to the historical query APIs.
		const sibling = await issueLiveSession(h.authority, { caller: OWNER });
		const rest = await h.post("/events/query", { session_id: entry.session_id, include_payload: true });
		expect(rest.status).toBe(200);
		const mcpRows = toolValue(await h.rpc(call(3, "events_query", { session_id: entry.session_id, include_payload: true })));
		const payloads = z.object({ events: z.array(z.object({ summary: z.string(), payload: z.record(z.string(), z.unknown()) })) });
		for (const response of [await rest.json(), mcpRows]) {
			const rows = payloads.parse(response).events;
			expect(rows.length).toBeGreaterThanOrEqual(5);
			expect(rows.some((row) => row.payload.via === "steering_acknowledge")).toBe(true);
			expect(rows.some((row) => row.payload.action === "docs.search")).toBe(true);
			expect(rows.some((row) => row.payload.action === "steering.session_ended")).toBe(true);
			for (const row of rows) {
				const allowed = row.payload.action === "docs.steering"
					? ["action", "repo_id", "session_id", "state", "updated_at", "previous_state", "non_blocking", "directive_id", "via"]
					: row.payload.action === "docs.search" ? ["action", "session_id", "repo_id", "non_blocking"]
					: row.payload.action === "steering.queued" ? ["action", "directive_id", "session_id", "non_blocking"]
					: ["action", "session_id", "repo_id", "closed_at", "non_blocking"];
				expect(Object.keys(row.payload).every((key) => allowed.includes(key))).toBe(true);
			}
			const encoded = JSON.stringify(rows);
			for (const secret of ["PRIVATE-DIRECTION-MARKER", "PRIVATE-PLAN-MARKER", "PRIVATE-DIRECTIVE-MARKER", entry.session_binding, sibling.sessionBinding]) expect(encoded).not.toContain(secret);
			for (const key of ["planning_hash", "binding_proof_hash", "session_binding", "pending_directives", "augmented_question"]) expect(encoded).not.toContain(key);
		}
		const historical = await h.post("/events/query", { session_id: "historical-checkpoint-label", include_payload: true }, AUTH_FOREIGN);
		expect(historical.status).toBe(200); expect(JSON.stringify(await historical.json())).toContain("LEGACY-PUBLISHED-PAYLOAD");
		expect(h.ledger.events.find((event) => event.session_id === "historical-checkpoint-label")).toEqual(historicalBefore);
	});

	test("private docs bypass result cache and refuse after a delayed ledger read loses authority", async () => {
		const h = await serve({ LIGHTRAG_URL: undefined }); const row = await issueLiveSession(h.authority, { caller: OWNER, steering: "private direction" });
		const release = Promise.withResolvers<void>(); h.ledger.readBarrier = release.promise;
		const pending = h.substrate.searchDocs({ question: "public question", steering_session_id: row.sessionId, context: true }, OWNER.surface, { caller: OWNER, sessionBinding: row.sessionBinding });
		await settle(() => h.ledger.reads > 0);
		await h.authority.close(row.access); release.resolve();
		await expect(pending).rejects.toMatchObject({ refusal: NOT_FOUND });
		expect(h.cacheReads.mock.calls.some(([request]) => request.klass === "docs-search")).toBe(false);
		expect(JSON.stringify(h.cacheReads.mock.calls)).not.toContain("private direction");
	});

	test("historical labels do not authorize docs or brief, and historical session.end cannot revoke", async () => {
		const h = await serve(); const row = await issueLiveSession(h.authority, { caller: OWNER, steering: "PRIVATE-DIRECTION-MARKER" });
		const before = h.ledger.reads;
		const historical = await h.substrate.searchDocs({ question: "q", session_id: row.sessionId, context: true }, OWNER.surface);
		expect(h.ledger.reads).toBe(before); expect(historical.steering).toBeUndefined();
		await h.substrate.emit({ surface: OWNER.surface, kind: "session.end", summary: "historical only", session_id: row.sessionId });
		expect((await h.authority.read(row.access, "private-read")).ok).toBe(true);
		const denied = await h.post("/brief", { repo: "owner/name", steering_session_id: row.sessionId }, { ...AUTH_OWNER, "if-none-match": "*" });
		expect(denied.status).toBe(404); expect(await denied.json()).toEqual(NOT_FOUND);
		const proof = { caller: OWNER, sessionBinding: row.sessionBinding };
		await h.authority.close(row.access);
		await expect(h.substrate.briefConditional({ repo: "owner/name", surface: OWNER.surface, steering_session_id: row.sessionId }, "*", "full", OWNER.surface, proof)).rejects.toBeInstanceOf(LiveSessionBoundaryError);
	});

	test("operator policy follows binding; acknowledgement remains effective if close wins state application", async () => {
		const h = await serve(); const row = await issueLiveSession(h.authority, { caller: OWNER });
		const input = { target_session_id: row.sessionId, action: "pause" as const, priority: "normal" as const, body: "Hold", conflicts_with_active_plan: false };
		expect(await queueSteering(h.substrate.steering, OWNER, { ...input, session_binding: row.sessionBinding })).toEqual({ status: "forbidden", reason: "operator-required" });
		const queued = await queueSteering(h.substrate.steering, OPERATOR, input);
		if (queued.status !== "queued") throw new Error("expected queue");
		const original = h.history.append.bind(h.history);
		spyOn(h.history, "append").mockImplementation(async (entry) => { await original(entry); await h.authority.close(row.access); });
		const ack = await acknowledgeSteeringWithState(h.substrate.steering, OPERATOR, { directive_id: queued.directive_id, session_id: row.sessionId, outcome: "applied" }, h.substrate.sessionState);
		expect(ack.status).toBe("acknowledged"); expect(ack.session_state?.status).toBe("refused"); expect(ack.checkpoint_hint).toBeUndefined();
	});

	test("held waits observe cross-process close and clean the waiter without a private or timeout success", async () => {
		const h = await serve(); const row = await issueLiveSession(h.authority, { caller: OWNER });
		const pending = h.get(`/steering/wait?session_id=${row.sessionId}&timeout_ms=10000`, { ...AUTH_OWNER, "x-substrate-session-binding": row.sessionBinding });
		await settle(() => h.substrate.steeringWaiters.size === 1);
		const started = performance.now(); await h.authority.close(row.access);
		const response = await pending;
		expect(response.status).toBe(404); expect(await response.json()).toEqual(NOT_FOUND); expect(performance.now() - started).toBeLessThan(1500); expect(h.substrate.steeringWaiters.size).toBe(0);
	});
	test("brief release cannot become 304 after revocation while cached/public sections await", async () => {
		const h = await serve(); const row = await issueLiveSession(h.authority, { caller: OWNER, steering: "private direction" });
		const release = Promise.withResolvers<void>(); h.ledger.sqlBarrier = release.promise;
		const pending = h.substrate.briefConditional({ repo: "owner/name", surface: OWNER.surface, steering_session_id: row.sessionId }, "*", "full", OWNER.surface, { caller: OWNER, sessionBinding: row.sessionBinding });
		await settle(() => h.ledger.sqlReads > 0);
		await h.authority.close(row.access); release.resolve();
		await expect(pending).rejects.toMatchObject({ refusal: NOT_FOUND });
	});

	test("authority outage after docs work is sanitized 503, never a degraded private success", async () => {
		const h = await serve({ LIGHTRAG_URL: undefined }); const row = await issueLiveSession(h.authority, { caller: OWNER });
		const release = Promise.withResolvers<void>(); h.ledger.readBarrier = release.promise;
		const pending = h.post("/docs/search", { question: "q", steering_session_id: row.sessionId, context: true }, { ...AUTH_OWNER, "x-substrate-session-binding": row.sessionBinding });
		await settle(() => h.ledger.reads > 0); h.authority.unavailable = true; release.resolve();
		const response = await pending;
		expect(response.status).toBe(503); expect(await response.json()).toEqual({ status: "refused", error: { code: "session-unavailable" } });
	});

	test("live private docs results do not use the shared docs cache even with a configured backend", async () => {
		const h = await serve(); const row = await issueLiveSession(h.authority, { caller: OWNER, steering: "private ranking direction" });
		await h.substrate.searchDocs({ question: "public question", steering_session_id: row.sessionId }, OWNER.surface, { caller: OWNER, sessionBinding: row.sessionBinding });
		expect(h.cacheReads.mock.calls.some(([request]) => request.klass === "docs-search" || request.klass === "memory-search")).toBe(false);
	});

	test("expiry and missing authority are terminal, uniform resource and service failures", async () => {
		const h = await serve(); const row = await issueLiveSession(h.authority, { caller: OWNER });
		h.authority.advance(3_600_001);
		const expired = await h.get(`/steering/directives?session_id=${row.sessionId}`, { ...AUTH_OWNER, "x-substrate-session-binding": row.sessionBinding });
		expect(expired.status).toBe(404); expect(await expired.json()).toEqual(NOT_FOUND);
		const absent = new Substrate(loadConfig({}), { index: null, greptime: null });
		await expect(absent.searchDocs({ question: "q", steering_session_id: row.sessionId }, OWNER.surface, { caller: OWNER, sessionBinding: row.sessionBinding })).rejects.toMatchObject({ refusal: { status: "refused", error: { code: "session-unavailable" } } });
	});
	test("REST queue reports its committed receipt when close wins during the audited append", async () => {
		const h = await serve(); const row = await issueLiveSession(h.authority, { caller: OWNER });
		const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
		const append = h.history.append.bind(h.history);
		spyOn(h.history, "append").mockImplementation(async (entry) => { entered.resolve(); await release.promise; await append(entry); });
		const notified = spyOn(h.substrate, "onSteeringQueued");
		const pending = h.post("/steering/queue", { session_id: row.sessionId, action: "pause", body: "private queued command" }, AUTH_OPERATOR);
		try { await entered.promise; expect((await h.authority.close(row.access)).ok).toBe(true); }
		finally { release.resolve(); }
		const response = await pending;
		expect(response.status).toBe(200);
		const receipt = z.object({ status: z.literal("queued"), directive_id: z.string(), target_session_id: z.string() }).parse(await response.json());
		expect(receipt.target_session_id).toBe(row.sessionId);
		expect(h.substrate.steering.inbox?.recordsFor(row.sessionId)).toHaveLength(1);
		expect(h.history.entries).toHaveLength(1); expect(notified).toHaveBeenCalledTimes(1);
		expect(h.batches.filter((batch) => batch.some((call) => call.tool === "steering_queue"))).toHaveLength(1);
		const closed = await h.get(`/steering/directives?session_id=${row.sessionId}`, { ...AUTH_OWNER, "x-substrate-session-binding": row.sessionBinding });
		expect(closed.status).toBe(404); expect(await closed.json()).toEqual(NOT_FOUND);
	});

	test("issuance returns its one-time creator receipt after concurrent close without reviving identity", async () => {
		const h = await serve();
		const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
		const emit = h.substrate.emit.bind(h.substrate);
		spyOn(h.substrate, "emit").mockImplementation(async (event, options) => {
			const result = await emit(event, options);
			if (event.payload !== null && typeof event.payload === "object" && "action" in event.payload && event.payload.action === "docs.steering") {
				entered.resolve(); await release.promise;
			}
			return result;
		});
		const pending = h.post("/steering/sessions", { repo_id: "owner/name", state: "ACTIVE", steering: "PRIVATE-DIRECTION-MARKER", planning_hash: "PRIVATE-PLAN-MARKER" });
		try {
			await entered.promise;
			const rows = await h.authority.listVisible(OWNER, { limit: 1 });
			if (!rows.ok || rows.sessions[0] === undefined) throw new Error("expected committed issued identity");
			expect((await h.authority.close({ caller: OPERATOR, sessionId: rows.sessions[0].session_id })).ok).toBe(true);
		} finally { release.resolve(); }
		const response = await pending;
		expect(response.status).toBe(200);
		const body: unknown = await response.json(); const entry = issued(body);
		expect(body).toMatchObject({ status: "issued", event_stored: true });
		expect(body).not.toHaveProperty("steering"); expect(body).not.toHaveProperty("planning_hash");
		const proof = { ...AUTH_OWNER, "x-substrate-session-binding": entry.session_binding };
		const denied = await h.get(`/steering/directives?session_id=${entry.session_id}`, proof);
		expect(denied.status).toBe(404); expect(await denied.json()).toEqual(NOT_FOUND);
		const renewed = await h.post("/steering/sessions/heartbeat", { session_id: entry.session_id }, proof);
		expect(renewed.status).toBe(404); expect(await renewed.json()).toEqual(NOT_FOUND);
	});
});
