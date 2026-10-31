import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { AuditUnavailableError } from "@substrate/audit";
import type { McpToolCall } from "./observe.ts";
import { defined } from "./test-support.ts";
import { issueLiveSession } from "./planning/live-session.test-support.ts";
import { listSteering, queueSteering } from "./planning/steering-tools.ts";
import { AUTH_OWNER, AUTH_FOREIGN, OWNER, OPERATOR, UNKNOWN, NOT_FOUND, call, cleanupLiveHarness, serveLive, toolValue } from "./live-session-consumer.test-support.ts";

const replySchema = z.object({ jsonrpc: z.literal("2.0"), id: z.number(), result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional() });
const operations = ["steering_list", "docs_steering_session", "steering_session_heartbeat", "steering_session_close", "docs_search", "memory_brief", "steering_queue", "steering_acknowledge"] as const;
const variants = ["missing", "wrong", "sibling", "foreign", "unknown", "expired", "closed"] as const;
afterEach(cleanupLiveHarness);

describe("HTTP MCP preflight and actual dispatch", () => {
	for (const tool of operations) test(`${tool}: owner proof succeeds, every invalid binding is the same no-effect refusal before audit`, async () => {
		const h = await serveLive();
		const expired = await issueLiveSession(h.authority, { caller: OWNER });
		const closed = await issueLiveSession(h.authority, { caller: OWNER });
		const directiveIds = new Map<string, string>();
		for (const selected of [expired, closed]) {
			const queued = await queueSteering(h.substrate.steering, OPERATOR, { target_session_id: selected.sessionId, action: "annotate", priority: "normal", body: "PRIVATE-MCP-BODY", conflicts_with_active_plan: false });
			if (queued.status !== "queued") throw new Error("fixture directive missing");
			directiveIds.set(selected.sessionId, queued.directive_id);
		}
		await h.authority.close(closed.access); h.authority.advance(3_600_001);
		const row = await issueLiveSession(h.authority, { caller: OWNER, steering: "PRIVATE-MCP-DIRECTION", planningHash: "PRIVATE-MCP-HASH" });
		const sibling = await issueLiveSession(h.authority, { caller: OWNER });
		const queued = await queueSteering(h.substrate.steering, OPERATOR, { target_session_id: row.sessionId, action: "annotate", priority: "normal", body: "PRIVATE-MCP-BODY", conflicts_with_active_plan: false });
		if (queued.status !== "queued") throw new Error("fixture directive missing");
		directiveIds.set(row.sessionId, queued.directive_id);
		const argsFor = (sessionId: string, binding?: string) => {
			const target = { session_id: sessionId, ...(binding === undefined ? {} : { session_binding: binding }) };
			switch (tool) {
				case "docs_steering_session": return { ...target, repo_id: "owner/name", state: "PAUSED" };
				case "docs_search": return { question: "public question", steering_session_id: sessionId, ...(binding === undefined ? {} : { session_binding: binding }) };
				case "memory_brief": return { repo: "owner/name", steering_session_id: sessionId, ...(binding === undefined ? {} : { session_binding: binding }) };
				case "steering_queue": return { target_session_id: sessionId, action: "pause", priority: "normal", body: "PRIVATE-MCP-BODY", conflicts_with_active_plan: false, ...(binding === undefined ? {} : { session_binding: binding }) };
				case "steering_acknowledge": return { ...target, directive_id: directiveIds.get(sessionId) ?? "unknown-directive", outcome: "applied" };
				default: return target;
			}
		};
		h.setAuditFailure(true);
		const refusedEnvelopes: unknown[] = [];
		for (const variant of variants) {
			const selected = variant === "expired" ? expired : variant === "closed" ? closed : row;
			const sessionId = variant === "unknown" ? UNKNOWN : selected.sessionId;
			const binding = variant === "missing" ? undefined : variant === "wrong" ? "0".repeat(64) : variant === "sibling" ? sibling.sessionBinding : selected.sessionBinding;
			const historyBefore = h.history.entries.length; const batchesBefore = h.batches.length;
			const reply = replySchema.parse(await h.rpc(call(17, tool, argsFor(sessionId, binding)), variant === "foreign" ? AUTH_FOREIGN : AUTH_OWNER));
			expect(reply.id).toBe(17); expect(toolValue(reply)).toEqual(NOT_FOUND);
			expect(z.object({ isError: z.literal(true) }).parse(reply.result).isError).toBe(true);
			refusedEnvelopes.push(reply);
			expect(h.batches.length).toBe(batchesBefore); expect(h.history.entries.length).toBe(historyBefore);
		}
		for (const reply of refusedEnvelopes) expect(reply).toEqual(refusedEnvelopes[0]);
		const baselineEnvelope = defined(h.rpcEnvelopes[0], "a refused HTTP MCP envelope");
		for (const envelope of h.rpcEnvelopes) expect(envelope).toEqual(baselineEnvelope);
		expect(await h.authority.read(row.access, "private-read")).toEqual({ ok: true, snapshot: row.snapshot });
		h.setAuditFailure(false);
		const reply = replySchema.parse(await h.rpc(call(18, tool, argsFor(row.sessionId, row.sessionBinding))));
		expect(reply.error).toBeUndefined();
		if (tool === "steering_queue" || tool === "steering_acknowledge") expect(toolValue(reply)).toEqual({ status: "forbidden", reason: "operator-required" });
		else expect(z.object({ isError: z.boolean().optional() }).parse(reply.result).isError).not.toBe(true);
	});

	for (const mode of ["off", "shadow"] as const) test(`mandatory principal429 cancels mixed batch before lookup/inference/audit with general budgets ${mode} and cache outage`, async () => {
		const principalNow = Date.now();
		const h = await serveLive({ SUBSTRATE_BUDGETS: mode, SUBSTRATE_BUDGET_READ_BURST: "1", SUBSTRATE_BUDGET_READ_RPS: "0.01" }, { nowMs: () => principalNow });
		const read = spyOn(h.authority, "read"); const list = spyOn(h.authority, "listVisible");
		const inbox = h.substrate.steering.inbox; if (inbox === null) throw new Error("missing inbox");
		const infer = spyOn(inbox, "get");
		h.cacheReads.mockImplementation(async () => { throw new Error("controlled cache outage"); });
		const body = [call(31, "steering_list", { session_id: UNKNOWN }), call(32, "steering_list", { session_id: UNKNOWN }), call(33, "events_emit", { kind: "note", summary: "NO-DISPATCH-MARKER" })];
		const replies = z.array(replySchema).parse(await h.rpc(body));
		expect(replies.map((reply) => reply.id).sort()).toEqual([31, 32, 33]);
		for (const reply of replies.filter((reply) => reply.id !== 33)) expect(toolValue(reply)).toMatchObject({ status: "refused", error: { code: "principal-rate-limited" } });
		expect(replies.find((reply) => reply.id === 33)?.error?.message).toBe("batch not dispatched");
		expect(read).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(infer).not.toHaveBeenCalled(); expect(h.batches).toHaveLength(0); expect(h.ledger.events).toHaveLength(0);
		// An over-capacity batch is rejected atomically, without spending the still-available single token.
		const row = await issueLiveSession(h.authority, { caller: OWNER });
		expect(toolValue(await h.rpc(call(34, "steering_list", { session_id: row.sessionId, session_binding: row.sessionBinding })))).toMatchObject({ status: "listed" });
		read.mockClear(); list.mockClear(); infer.mockClear();
		const eventsBeforeFlood = h.ledger.events.length;
		const auditsBeforeFlood = h.batches.length;
		for (let target = 0; target < 40; target++) {
			const reply = await h.rpc(call(100 + target, "steering_list", { session_id: `ls_${target.toString(16).padStart(64, "0")}` }));
			expect(toolValue(reply)).toMatchObject({ error: { code: "principal-rate-limited" } });
		}
		expect(read).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(infer).not.toHaveBeenCalled();
		expect(h.ledger.events).toHaveLength(eventsBeforeFlood); expect(h.batches).toHaveLength(auditsBeforeFlood);
	});

	test("one denied target cancels every batch member, notifications receive no invented response", async () => {
		const h = await serveLive(); h.setAuditFailure(true);
		const notification = { jsonrpc: "2.0", method: "tools/call", params: { name: "events_emit", arguments: { kind: "note", summary: "NO-NOTIFICATION-EFFECT" } } };
		const replies = z.array(replySchema).parse(await h.rpc([call(41, "steering_session_close", { session_id: UNKNOWN }), call(42, "events_emit", { kind: "note", summary: "NO-BATCH-EFFECT" }), notification]));
		expect(replies.map((reply) => reply.id).sort()).toEqual([41, 42]);
		expect(toolValue(replies.find((reply) => reply.id === 41))).toEqual(NOT_FOUND);
		expect(replies.find((reply) => reply.id === 42)?.error).toMatchObject({ message: "batch not dispatched" });
		expect(h.batches).toHaveLength(0); expect(h.ledger.events.some((event) => event.summary.startsWith("NO-"))).toBe(false);
	});

	test("identical HTTP calls each consume one debit/entry but the batch is audited exactly once", async () => {
		const h = await serveLive({ SUBSTRATE_BUDGET_READ_BURST: "2", SUBSTRATE_BUDGET_READ_RPS: "0.01" });
		const row = await issueLiveSession(h.authority, { caller: OWNER }); const args = { session_id: row.sessionId, session_binding: row.sessionBinding };
		const replies = z.array(replySchema).parse(await h.rpc([call(51, "steering_list", args), call(52, "steering_list", args)]));
		for (const reply of replies) expect(toolValue(reply)).toMatchObject({ status: "listed" });
		expect(replies.map((reply) => reply.id).sort()).toEqual([51, 52]); expect(h.batches).toHaveLength(1); expect(h.batches[0]).toHaveLength(2);
		expect(h.auditRecords.filter((record) => record.tool === "steering_list")).toHaveLength(2);
		const read = spyOn(h.authority, "read");
		expect(toolValue(await h.rpc(call(53, "steering_list", args)))).toMatchObject({ error: { code: "principal-rate-limited" } });
		expect(read).not.toHaveBeenCalled(); expect(h.batches).toHaveLength(1);
	});

	test("actual HTTP MCP dispatch rejects arguments changed after preflight without a second debit or mutation", async () => {
		const h = await serveLive({ SUBSTRATE_BUDGET_WRITE_BURST: "1", SUBSTRATE_BUDGET_WRITE_RPS: "0.01" });
		const row = await issueLiveSession(h.authority, { caller: OWNER });
		const execute = h.substrate.executeLiveCall.bind(h.substrate);
		spyOn(h.substrate, "executeLiveCall").mockImplementation((invocation, effect, dispatch) => execute({ ...invocation, args: { session_id: UNKNOWN } }, effect, dispatch));
		const heartbeat = spyOn(h.authority, "heartbeat");
		const args = { session_id: row.sessionId, session_binding: row.sessionBinding };
		expect(toolValue(await h.rpc(call(60, "steering_session_heartbeat", args)))).toEqual(NOT_FOUND);
		expect(heartbeat).not.toHaveBeenCalled(); expect(h.batches).toHaveLength(1);
		expect(toolValue(await h.rpc(call(61, "steering_session_heartbeat", args)))).toMatchObject({ error: { code: "principal-rate-limited" } });
		expect(heartbeat).not.toHaveBeenCalled(); expect(h.batches).toHaveLength(1);
		expect(await h.authority.read(row.access, "private-read")).toEqual({ ok: true, snapshot: row.snapshot });
	});

	test("prepared contexts are one-use, argument-bound, caller-bound and cannot silently reprepare", async () => {
		const h = await serveLive(); const row = await issueLiveSession(h.authority, { caller: OWNER });
		const args = { session_id: row.sessionId, session_binding: row.sessionBinding };
		const calls: McpToolCall[] = [{ id: 61, tool: "steering_list", args }];
		const prepared = await h.substrate.prepareLiveBatch(OWNER, calls); if (!prepared.ok) throw new Error("expected admitted preparation");
		await expect(h.substrate.auditPreparedBatch(prepared.batch, [{ ...defined(calls[0], "the prepared call"), args: { ...args, session_id: UNKNOWN } }], "mcp")).rejects.toMatchObject({ refusal: NOT_FOUND });
		await expect(h.substrate.auditPreparedBatch(prepared.batch, calls, "mcp")).rejects.toMatchObject({ refusal: NOT_FOUND });
		expect(h.batches).toHaveLength(0);
		const next = await h.substrate.prepareLiveBatch(OWNER, calls); if (!next.ok) throw new Error("expected admitted preparation");
		const audited = await h.substrate.auditPreparedBatch(next.batch, calls, "mcp"); if (!audited.ok) throw new Error("expected audited dispatch");
		expect(await listSteering(h.substrate.steering, OWNER, { ...args, session_id: UNKNOWN }, audited.dispatch)).toEqual(NOT_FOUND);
		expect(await listSteering(h.substrate.steering, { surface: "hermes", isOperator: false }, args, audited.dispatch)).toEqual(NOT_FOUND);
		expect(await listSteering(h.substrate.steering, OWNER, args, audited.dispatch)).toMatchObject({ status: "listed" });
		expect(await listSteering(h.substrate.steering, OWNER, args, audited.dispatch)).toEqual(NOT_FOUND); expect(h.batches).toHaveLength(1);
	});

	test("admitted required-audit failure dispatches no member and fail-closed audit precedes fail-open audit", async () => {
		const h = await serveLive(); const row = await issueLiveSession(h.authority, { caller: OWNER });
		const attempts: string[] = []; const append = h.observability.audit.append.bind(h.observability.audit);
		spyOn(h.observability.audit, "append").mockImplementation(async (input) => {
			attempts.push(input.tool);
			if (input.tool === "steering_session_close") throw new AuditUnavailableError(input.tool, "controlled outage");
			return append(input);
		});
		const replies = z.array(replySchema).parse(await h.rpc([call(71, "events_query", { limit: 1 }), call(72, "steering_session_close", { session_id: row.sessionId, session_binding: row.sessionBinding })]));
		expect(replies).toHaveLength(2); expect(attempts[0]).toBe("steering_session_close");
		for (const reply of replies) expect(reply.error).toBeDefined();
		expect((await h.authority.read(row.access, "private-read")).ok).toBe(true); expect(h.batches).toHaveLength(1);
	});

	test("failed refusal ledger and generic audit cannot decorate target refusal or log binding material", async () => {
		const h = await serveLive(); const row = await issueLiveSession(h.authority, { caller: OWNER });
		h.setAuditFailure(true);
		const diagnostics: unknown[] = [];
		spyOn(console, "warn").mockImplementation((...args) => { diagnostics.push(args); });
		spyOn(console, "error").mockImplementation((...args) => { diagnostics.push(args); });
		spyOn(h.ledger, "insertEvent").mockRejectedValue(new Error("controlled ledger unavailable"));
		const replies = [];
		for (const sessionId of [row.sessionId, UNKNOWN]) {
			const rest = await h.post("/steering/sessions/close", { session_id: sessionId }, { ...AUTH_OWNER, "x-substrate-session-binding": "0".repeat(64) });
			expect(rest.status).toBe(404); expect(await rest.json()).toEqual(NOT_FOUND);
			replies.push(toolValue(await h.rpc(call(901, "steering_session_close", { session_id: sessionId, session_binding: "0".repeat(64) }))));
		}
		expect(replies).toEqual([NOT_FOUND, NOT_FOUND]); expect(h.batches).toHaveLength(0);
		const encoded = JSON.stringify({ diagnostics, records: h.auditRecords, metrics: h.observability.snapshot() });
		expect(encoded).not.toContain(row.sessionBinding); expect(encoded).not.toContain(row.sessionId); expect(encoded).not.toContain(UNKNOWN);
		expect((await h.authority.read(row.access, "private-read")).ok).toBe(true);
	});

	test("real SSE transport retains every successful batch response and invents none for notifications", async () => {
		const h = await serveLive();
		const requests = [101, 102, 103].map((id) => ({ jsonrpc: "2.0", id, method: "ping" }));
		const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
		const replies = z.array(replySchema).parse(await h.rpc([...requests, notification]));
		expect(replies.map((reply) => reply.id).sort()).toEqual([101, 102, 103]);
		for (const reply of replies) { expect(reply.error).toBeUndefined(); expect(reply.result).toEqual({}); }
		expect(h.batches).toHaveLength(0); expect(h.auditRecords).toHaveLength(0);
	});

	test("non-live batches retain ordinary historical tool behavior and generic audit", async () => {
		const h = await serveLive(); const read = spyOn(h.authority, "read");
		const replies = z.array(replySchema).parse(await h.rpc([call(81, "events_emit", { kind: "note", summary: "PUBLIC-HISTORICAL-MARKER", session_id: "historical-label" }), call(82, "events_query", { session_id: "historical-label", include_payload: true })]));
		expect(replies.map((reply) => reply.id).sort()).toEqual([81, 82]); expect(replies.every((reply) => reply.error === undefined)).toBe(true);
		expect(h.ledger.events.some((event) => event.summary === "PUBLIC-HISTORICAL-MARKER")).toBe(true);
		expect(read).not.toHaveBeenCalled(); expect(h.batches).toHaveLength(0);
		expect(h.auditRecords.some((record) => record.tool === "events_emit" && record.session_id === "historical-label")).toBe(true);
	});
});
