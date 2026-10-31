import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AuditUnavailableError } from "@substrate/audit";
import { createHash } from "node:crypto";
import { loadConfig } from "../config.ts";
import { auditToolCalls, createObservability } from "../observe.ts";
import { Substrate } from "../service.ts";
import { createTestLiveSessionAuthority, issueLiveSession } from "./live-session.test-support.ts";
import { acknowledgeSteering, listSteering, queueSteering, type LiveSessionAuditPort } from "./steering-tools.ts";
import type { SteeringAuditEntry, SteeringHistorySink } from "./steering.ts";

const OWNER = { surface: "cursor", isOperator: false } as const;
const FOREIGN = { surface: "hermes", isOperator: false } as const;
const OPERATOR = { surface: "omp", isOperator: true } as const;
const NOT_FOUND = { status: "refused", error: { code: "not-found" } } as const;
const UNKNOWN = `ls_${"f".repeat(64)}`;
class History implements SteeringHistorySink {
	readonly entries: SteeringAuditEntry[] = [];
	async append(entry: SteeringAuditEntry): Promise<void> { this.entries.push(entry); }
}
const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });

async function fixture(extra: Record<string, string | undefined> = {}, missingAudit = false) {
	const env = { SUBSTRATE_PLANNING_STEERING: "on", SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "omp", ...extra };
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	stops.push(() => observability.stop());
	const authority = createTestLiveSessionAuthority({ nowMs: Date.now() });
	const history = new History();
	const audit = spyOn(observability.audit, "append");
	let calls = 0;
	const port: LiveSessionAuditPort = { auditCalls: async (caller, batch, transport) => { calls++; return auditToolCalls(observability, caller.surface, batch, transport); } };
	const substrate = new Substrate(config, { index: null, greptime: null, steering: { history, liveSessions: authority } }, observability.observer, missingAudit ? undefined : port);
	const refusal = spyOn(substrate, "emit");
	const row = await issueLiveSession(authority, { caller: OWNER });
	const sibling = await issueLiveSession(authority, { caller: OWNER });
	return { substrate, authority, row, sibling, history, audit, refusal, auditCalls: () => calls };
}
const queue = (sessionId: string, sessionBinding?: string) => ({ target_session_id: sessionId, action: "pause" as const, priority: "normal" as const, body: "PRIVATE-DIRECTIVE", conflicts_with_active_plan: false, ...(sessionBinding === undefined ? {} : { session_binding: sessionBinding }) });

describe("direct service helpers use issued identities", () => {
	test("owner proof reads; sibling proof and foreign caller cannot impersonate the public handle", async () => {
		const h = await fixture();
		expect((await queueSteering(h.substrate.steering, OPERATOR, queue(h.row.sessionId))).status).toBe("queued");
		expect(await listSteering(h.substrate.steering, OWNER, { session_id: h.row.sessionId, session_binding: h.row.sessionBinding })).toMatchObject({ status: "listed", directives: [{ body: "PRIVATE-DIRECTIVE" }], session_state: { state: "ACTIVE" } });
		for (const [caller, binding] of [[OWNER, undefined], [OWNER, h.sibling.sessionBinding], [FOREIGN, h.row.sessionBinding]] as const) {
			expect(await listSteering(h.substrate.steering, caller, { session_id: h.row.sessionId, ...(binding === undefined ? {} : { session_binding: binding }) })).toEqual(NOT_FOUND);
		}
	});

	test("proof-bound nonoperator writes stay operator-only and leave the inbox unchanged", async () => {
		const h = await fixture();
		expect(await queueSteering(h.substrate.steering, OWNER, queue(h.row.sessionId, h.row.sessionBinding))).toEqual({ status: "forbidden", reason: "operator-required" });
		expect(h.history.entries).toEqual([]);
		const queued = await queueSteering(h.substrate.steering, OPERATOR, queue(h.row.sessionId));
		if (queued.status !== "queued") throw new Error("test queue refused");
		expect(await acknowledgeSteering(h.substrate.steering, OWNER, { directive_id: queued.directive_id, session_id: h.row.sessionId, session_binding: h.row.sessionBinding, outcome: "applied" })).toEqual({ status: "forbidden", reason: "operator-required" });
		expect(h.history.entries.map(entry => entry.event)).toEqual(["queued"]);
		expect(h.substrate.steering.inbox?.get(queued.directive_id)?.state).toBe("queued");
	});

	for (const denied of ["missing", "wrong", "sibling", "foreign", "unknown", "expired", "closed"] as const) test(`${denied} queue, read and acknowledgement have identical refusal and no effect`, async () => {
		const h = await fixture();
		const queued = await queueSteering(h.substrate.steering, OPERATOR, queue(h.row.sessionId));
		if (queued.status !== "queued") throw new Error("test queue refused");
		if (denied === "expired") h.authority.advance(3600_000);
		if (denied === "closed") await h.authority.close(h.row.access);
		const sessionId = denied === "unknown" ? UNKNOWN : h.row.sessionId;
		const sessionBinding = denied === "missing" ? undefined : denied === "wrong" ? "0".repeat(64) : denied === "sibling" ? h.sibling.sessionBinding : h.row.sessionBinding;
		const caller = denied === "foreign" ? FOREIGN : OWNER;
		const args = { session_id: sessionId, ...(sessionBinding === undefined ? {} : { session_binding: sessionBinding }) };
		const before = h.history.entries.length;
		const audited = h.auditCalls();
		expect(await listSteering(h.substrate.steering, caller, args)).toEqual(NOT_FOUND);
		expect(await queueSteering(h.substrate.steering, caller, queue(sessionId, sessionBinding))).toEqual(NOT_FOUND);
		expect(await acknowledgeSteering(h.substrate.steering, caller, { ...args, directive_id: queued.directive_id, outcome: "applied" })).toEqual(NOT_FOUND);
		expect(h.history.entries).toHaveLength(before);
		expect(h.auditCalls()).toBe(audited);
		expect(h.substrate.steering.inbox?.get(queued.directive_id)?.state).toBe("queued");
	});

	test("operators override owner proof but never unknown or terminal targets", async () => {
		const h = await fixture();
		const queued = await queueSteering(h.substrate.steering, OPERATOR, queue(h.row.sessionId));
		if (queued.status !== "queued") throw new Error("test queue refused");
		expect(await acknowledgeSteering(h.substrate.steering, OPERATOR, { directive_id: queued.directive_id, outcome: "declined" })).toMatchObject({ status: "acknowledged" });
		expect((await listSteering(h.substrate.steering, OPERATOR, { session_id: h.row.sessionId })).status).toBe("listed");
		expect(await queueSteering(h.substrate.steering, OPERATOR, queue(UNKNOWN))).toEqual(NOT_FOUND);
		await h.authority.close(h.row.access);
		expect(await listSteering(h.substrate.steering, OPERATOR, { session_id: h.row.sessionId })).toEqual(NOT_FOUND);
	});

	for (const terminal of ["unknown", "expired", "closed"] as const) test(`operator override cannot reach ${terminal} through queue, acknowledgement or list`, async () => {
		const h = await fixture();
		const queued = await queueSteering(h.substrate.steering, OPERATOR, queue(h.row.sessionId));
		if (queued.status !== "queued") throw new Error("test queue refused");
		if (terminal === "expired") h.authority.advance(3600_000);
		if (terminal === "closed") await h.authority.close(h.row.access);
		const sessionId = terminal === "unknown" ? UNKNOWN : h.row.sessionId;
		expect(await queueSteering(h.substrate.steering, OPERATOR, queue(sessionId))).toEqual(NOT_FOUND);
		expect(await acknowledgeSteering(h.substrate.steering, OPERATOR, { directive_id: queued.directive_id, session_id: sessionId, outcome: "applied" })).toEqual(NOT_FOUND);
		expect(await listSteering(h.substrate.steering, OPERATOR, { session_id: sessionId })).toEqual(NOT_FOUND);
		expect(h.history.entries.map(entry => entry.event)).toEqual(["queued"]);
		expect(h.substrate.steering.inbox?.get(queued.directive_id)?.state).toBe("queued");
	});

	test("refusal audit failures do not decorate404 or disclose raw identifiers, proofs or bodies", async () => {
		const h = await fixture();
		for (const fails of [false, true]) {
			if (fails) h.refusal.mockImplementation(async () => { throw new Error("test refusal sink down"); });
			expect(await queueSteering(h.substrate.steering, OWNER, queue(h.row.sessionId, h.sibling.sessionBinding))).toEqual(NOT_FOUND);
		}
		const events = h.refusal.mock.calls.map(([event]) => event);
		expect(events).toHaveLength(2);
		for (const event of events) {
			expect(event).toMatchObject({ kind: "warning" });
			expect(event.payload).toEqual({ action: "steering.refused", operation: "steering_queue", caller_surface: "cursor", operator: false, target_sha256: createHash("sha256").update("substrate.live-session-refusal.v1\0").update(h.row.sessionId).digest("hex") });
			for (const secret of [h.row.sessionId, h.row.sessionBinding, h.sibling.sessionBinding, "PRIVATE-DIRECTIVE"]) expect(JSON.stringify(event)).not.toContain(secret);
		}
	});

	for (const mode of ["missing", "failing"] as const) test(`${mode} generic audit port blocks admitted mutation but cannot replace target404`, async () => {
		const h = await fixture({}, mode === "missing");
		if (mode === "failing") h.audit.mockImplementation(async input => { throw new AuditUnavailableError(input.tool, "test sink unavailable"); });
		expect(await queueSteering(h.substrate.steering, OPERATOR, queue(UNKNOWN))).toEqual(NOT_FOUND);
		expect(await queueSteering(h.substrate.steering, OPERATOR, queue(h.row.sessionId))).toEqual({ status: "refused", error: { code: "audit-unavailable" } });
		const issue = spyOn(h.authority, "issue");
		const transition = spyOn(h.authority, "transition");
		const heartbeat = spyOn(h.authority, "heartbeat");
		const close = spyOn(h.authority, "close");
		const args = { session_id: h.row.sessionId, session_binding: h.row.sessionBinding };
		await expect(h.substrate.updateLiveSession(OWNER, { repo_id: "owner/name", state: "ACTIVE" })).rejects.toMatchObject({ refusal: { error: { code: "audit-unavailable" } } });
		await expect(h.substrate.updateLiveSession(OWNER, { ...args, repo_id: "owner/name", state: "PAUSED" })).rejects.toMatchObject({ refusal: { error: { code: "audit-unavailable" } } });
		await expect(h.substrate.heartbeatLiveSession(OWNER, args)).rejects.toMatchObject({ refusal: { error: { code: "audit-unavailable" } } });
		await expect(h.substrate.closeLiveSession(OWNER, args)).rejects.toMatchObject({ refusal: { error: { code: "audit-unavailable" } } });
		expect(issue).not.toHaveBeenCalled(); expect(transition).not.toHaveBeenCalled(); expect(heartbeat).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
		expect(await h.authority.read(h.row.access, "private-read")).toMatchObject({ ok: true, snapshot: { session: { state: "ACTIVE" } } });
		expect(h.history.entries).toEqual([]);
	});

	for (const mode of ["off", "shadow"] as const) test(`principal limit in ${mode} precedes authority, inferred target and both audit sinks`, async () => {
		const h = await fixture({ SUBSTRATE_BUDGETS: mode, SUBSTRATE_BUDGET_WRITE_BURST: "1", SUBSTRATE_BUDGET_WRITE_RPS: "0.01" });
		const inbox = h.substrate.steering.inbox;
		if (inbox === null) throw new Error("missing inbox");
		const lookup = spyOn(inbox, "get");
		const read = spyOn(h.authority, "read");
		expect(await acknowledgeSteering(h.substrate.steering, OPERATOR, { directive_id: "absent-first", outcome: "declined" })).toEqual(NOT_FOUND);
		lookup.mockClear(); read.mockClear(); h.refusal.mockClear(); h.audit.mockClear();
		for (let n = 0; n < 100; n++) expect(await acknowledgeSteering(h.substrate.steering, OPERATOR, { directive_id: `random-${n}`, outcome: "declined" })).toMatchObject({ status: "refused", error: { code: "principal-rate-limited" } });
		expect(lookup).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(h.refusal).not.toHaveBeenCalled(); expect(h.audit).not.toHaveBeenCalled();
	});
});
