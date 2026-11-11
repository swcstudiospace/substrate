/**
 * Restart-proof steering replays (phase 77, L77-01 to L77-04; phase 67 restart hint), against a disposable PostgreSQL.
 *
 * Each "restart" is a new `IndexStore`, a new `Substrate` and a new in-process reply index over the same database, so nothing
 * but the audit tables can answer a replay. The durable sink is the audit table's own: `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE`
 * is on and the `steering-audit` opt-in creates steps 33 to 34 and 44 to 45. Skipped without `SUBSTRATE_TEST_PG_URL`.
 */
import { SQL } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { IndexStore } from "../index-store.ts";
import { auditToolCalls, createObservability } from "../observe.ts";
import { Substrate } from "../service.ts";
import { defined } from "../test-support.ts";
import { issueLiveSession } from "./live-session.test-support.ts";
import { steeringRecordsFromEntries } from "./steering.ts";
import type { SessionStatePort, SessionTransitionResult } from "./steering-delivery.ts";
import { acknowledgeSteeringWithState, queueSteering, type LiveSessionAuditPort, type SteeringWriteResult } from "./steering-tools.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const describeLive = PG_URL ? describe : describe.skip;
const RUN = `ut-steer-idem-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
/** This run's own database. The shared test database keeps its opt-ins off, and this file turns the audit table on. */
const DATABASE = `substrate_steer_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const REPO = `tests/${RUN}`;

/** The test database's URL, with this run's database name in place of the shared one. */
function urlFor(database: string): string {
	const url = new URL(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
	url.pathname = `/${database}`;
	return url.toString();
}
/** Issues the session it owns. Acknowledgements are operator commands, so they run as the operator. */
const OWNER = { surface: "cursor", isOperator: false } as const;
const OPERATOR = { surface: "omp", isOperator: true } as const;
// A key is scoped to its surface (D77-02), so each test names its own keys: a reused key is a different request.
const KEY = (name: string) => `${RUN}-${name}`;

/** Counts the session transitions an acknowledgement drives, and answers each as an applied move. */
class CountingSessionPort implements SessionStatePort {
	calls = 0;
	applyTransition(): SessionTransitionResult {
		this.calls += 1;
		return { ok: true, changed: true };
	}
}

interface Instance {
	service: Substrate;
	index: IndexStore;
	leaseSeconds: number;
	stop(): Promise<void>;
}

const instances: Instance[] = [];
let control: SQL;
let db: SQL;

async function instance(): Promise<Instance> {
	const directory = await mkdtemp(join(tmpdir(), "substrate-steer-idem-"));
	const env = {
		SUBSTRATE_PLANNING_STEERING: "on",
		SUBSTRATE_PLANNING_STEERING_PRINCIPALS: "omp",
		SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE: "on",
		SUBSTRATE_STEERING_SESSIONS_TABLE: "off",
		SUBSTRATE_CACHE: "0",
		SUBSTRATE_BUDGETS: "off",
		SUBSTRATE_BUDGET_READ_BURST: "200",
		SUBSTRATE_BUDGET_WRITE_BURST: "200",
		SUBSTRATE_AUDIT_PATH: join(directory, "audit.jsonl"),
	};
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const index = new IndexStore(urlFor(DATABASE), { migrationOptIns: { "steering-audit": true, "steering-sessions": false } });
	const port: LiveSessionAuditPort = {
		auditCalls: (caller, calls, transport) => auditToolCalls(observability, caller.surface, calls, transport),
	};
	const service = new Substrate(config, { index, greptime: null, mirror: null, eventBus: () => null }, observability.observer, port);
	await service.startSteering();
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		service.steeringWaiters.closeAll();
		service.stopEventBus();
		observability.stop();
		try {
			await index.close();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	};
	const h: Instance = { service, index, leaseSeconds: config.liveSessionLeaseS, stop };
	instances.push(h);
	return h;
}

/** A live session of the test repository, issued through the instance's own authority. */
async function issueSession(h: Instance): Promise<{ sessionId: string; sessionBinding: string }> {
	const entry = await issueLiveSession(h.index.liveSessions({ leaseSeconds: h.leaseSeconds }), { caller: OWNER, repoId: REPO, steering: "PRIVATE-DIRECTION", planningHash: "PRIVATE-PLAN" });
	return entry;
}

const queue = (sessionId: string, overrides: Record<string, unknown> = {}) => ({
	target_session_id: sessionId,
	action: "pause" as const,
	priority: "normal" as const,
	body: "PRIVATE-REPLAY-COMMAND",
	conflicts_with_active_plan: false,
	...overrides,
});

/** The directive id of a queued reply. Any other answer fails the test with the status it got. */
function queuedId(result: SteeringWriteResult): string {
	if (result.status !== "queued") throw new Error(`expected a queued reply, got ${result.status}`);
	return result.directive_id;
}

async function countRows(sessionId: string, transition: "queued" | "acknowledged"): Promise<number> {
	const rows = await db`select count(*)::int as n from planning_steering_audit where target_session_id = ${sessionId} and transition = ${transition}`;
	return Number(rows[0]?.n ?? 0);
}

function ackInput(entry: { sessionId: string; sessionBinding: string }, directiveId: string, key: string | undefined) {
	return {
		directive_id: directiveId,
		session_id: entry.sessionId,
		outcome: "applied" as const,
		session_binding: entry.sessionBinding,
		...(key === undefined ? {} : { idempotency_key: key }),
	};
}

afterEach(async () => {
	for (const h of instances.splice(0).reverse()) await h.stop();
});

beforeAll(async () => {
	control = new SQL(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
	await control.unsafe(`create database "${DATABASE}"`);
	db = new SQL(urlFor(DATABASE));
	const bootstrap = new IndexStore(urlFor(DATABASE), { migrationOptIns: { "steering-audit": true, "steering-sessions": false } });
	try {
		await bootstrap.migrate();
	} finally {
		await bootstrap.close();
	}
});

afterAll(async () => {
	if (!PG_URL || !control) return;
	try {
		await db.close();
		await control.unsafe(`drop database if exists "${DATABASE}" with (force)`);
	} finally {
		await control.close();
	}
});

describeLive("keyed steering replays survive a restart (controlled PostgreSQL)", () => {
	test("a keyed queue replays after a restart with its original reply, and a different request under the key is refused", async () => {
		const key = KEY("queue-replay");
		const first = await instance();
		const entry = await issueSession(first);
		const original = await queueSteering(first.service.steering, OPERATOR, queue(entry.sessionId, { idempotency_key: key }));
		expect(original).toMatchObject({ status: "queued", sequence: expect.any(Number) });
		await first.stop();

		const second = await instance();
		const replay = await queueSteering(second.service.steering, OPERATOR, queue(entry.sessionId, { idempotency_key: key }));
		expect(replay).toEqual(original);
		expect(await countRows(entry.sessionId, "queued")).toBe(1);

		const conflict = await queueSteering(second.service.steering, OPERATOR, queue(entry.sessionId, { idempotency_key: key, body: "PRIVATE-OTHER-COMMAND" }));
		expect(conflict).toEqual({ status: "refused", error: { code: "idempotency-conflict" } });
		expect(await countRows(entry.sessionId, "queued")).toBe(1);
	});

	test("a keyed acknowledgement replays after a restart with the same reply, and drives no second session move", async () => {
		const key = KEY("ack-replay");
		const first = await instance();
		const entry = await issueSession(first);
		const directiveId = queuedId(await queueSteering(first.service.steering, OPERATOR, queue(entry.sessionId)));
		const firstPort = new CountingSessionPort();
		const original = await acknowledgeSteeringWithState(first.service.steering, OPERATOR, ackInput(entry, directiveId, key), firstPort);
		expect(original).toMatchObject({
			status: "acknowledged",
			directive_id: directiveId,
			session_state: { status: "applied", state: "PAUSED" },
			checkpoint_hint: { trigger: "steering", directive_id: directiveId },
		});
		expect(firstPort.calls).toBe(1);
		await first.stop();

		const second = await instance();
		const secondPort = new CountingSessionPort();
		const replay = await acknowledgeSteeringWithState(second.service.steering, OPERATOR, ackInput(entry, directiveId, key), secondPort);
		expect(replay).toEqual(original);
		expect(secondPort.calls).toBe(0);
		expect(await countRows(entry.sessionId, "acknowledged")).toBe(1);
	});

	test("a keyed queue retried after its directive was acknowledged before a restart replays, and is not refused", async () => {
		const key = KEY("queue-after-ack");
		const first = await instance();
		const entry = await issueSession(first);
		const original = await queueSteering(first.service.steering, OPERATOR, queue(entry.sessionId, { idempotency_key: key }));
		const directiveId = queuedId(original);
		await acknowledgeSteeringWithState(first.service.steering, OPERATOR, ackInput(entry, directiveId, undefined), new CountingSessionPort());
		await first.stop();

		const second = await instance();
		const replay = await queueSteering(second.service.steering, OPERATOR, queue(entry.sessionId, { idempotency_key: key }));
		expect(replay).toEqual(original);
		expect(await countRows(entry.sessionId, "queued")).toBe(1);
	});

	test("a keyed acknowledgement retried under another request after a restart is refused, and moves nothing", async () => {
		const key = KEY("ack-conflict");
		const first = await instance();
		const entry = await issueSession(first);
		const directiveId = queuedId(await queueSteering(first.service.steering, OPERATOR, queue(entry.sessionId)));
		await acknowledgeSteeringWithState(first.service.steering, OPERATOR, ackInput(entry, directiveId, key), new CountingSessionPort());
		await first.stop();

		const second = await instance();
		const port = new CountingSessionPort();
		const other = await acknowledgeSteeringWithState(second.service.steering, OPERATOR, { ...ackInput(entry, directiveId, key), outcome: "declined" }, port);
		expect(other).toEqual({ status: "refused", error: { code: "idempotency-conflict" } });
		expect(port.calls).toBe(0);
		expect(await countRows(entry.sessionId, "acknowledged")).toBe(1);
	});

	test("a session move committed before a restart is still listed with its checkpoint hint", async () => {
		const first = await instance();
		const entry = await issueSession(first);
		const directiveId = queuedId(await queueSteering(first.service.steering, OPERATOR, queue(entry.sessionId)));
		await acknowledgeSteeringWithState(first.service.steering, OPERATOR, ackInput(entry, directiveId, undefined), new CountingSessionPort());
		await first.stop();

		const second = await instance();
		const page = await second.index.steeringAudit().readRecent({ sessionId: entry.sessionId, limit: 10 });
		if (!page.ok) throw new Error(`durable listing failed: ${page.error.code}`);
		const records = steeringRecordsFromEntries(page.value.entries);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ state: "acknowledged", directive: { id: directiveId }, sessionMoved: true });
	});

	test("delivery sequence is kept across a restart, and a directive queued after it sorts last", async () => {
		const first = await instance();
		const entry = await issueSession(first);
		const firstId = queuedId(await queueSteering(first.service.steering, OPERATOR, queue(entry.sessionId)));
		const secondId = queuedId(await queueSteering(first.service.steering, OPERATOR, queue(entry.sessionId)));
		const inbox = defined(first.service.steering.inbox, "steering inbox");
		const firstSequence = defined(inbox.sequenceOf(firstId), "first sequence");
		const secondSequence = defined(inbox.sequenceOf(secondId), "second sequence");
		expect(firstSequence).toBeLessThan(secondSequence);
		await first.stop();

		const second = await instance();
		const restored = defined(second.service.steering.inbox, "restored steering inbox");
		expect(restored.sequenceOf(firstId)).toBe(firstSequence);
		expect(restored.sequenceOf(secondId)).toBe(secondSequence);
		const thirdId = queuedId(await queueSteering(second.service.steering, OPERATOR, queue(entry.sessionId)));
		const thirdSequence = defined(restored.sequenceOf(thirdId), "third sequence");
		expect(thirdSequence).toBeGreaterThan(secondSequence);
		expect(restored.queuedFor(entry.sessionId).map((item) => item.record.directive.id)).toEqual([firstId, secondId, thirdId]);
	});
});
