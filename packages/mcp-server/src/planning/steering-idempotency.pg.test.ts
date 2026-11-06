/**
 * The keyed-queue replay and the delivery sequence against PostgreSQL (migration 43, under the steering-audit opt-in). Each
 * IndexStore owns its own pool, so two stores are two server processes over one database. Gated on SUBSTRATE_TEST_PG_URL.
 */
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { IndexStore } from "../index-store.ts";
import { defined } from "../test-support.ts";
import { SteeringDirectiveSchema, SteeringInbox, type SteeringClock, type SteeringReplayRecord } from "./steering.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const describeLive = PG_URL ? describe : describe.skip;
const RUN = `ut-idem-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const HUMAN = `${RUN}-ops`;
const KEY = `${RUN}-key-0001`;
const RACE_KEY = `${RUN}-race-key`;
const TTL_MS = 86_400_000;
const CAP = 10_000;
const FINGERPRINT = createHash("sha256").update(RUN).digest("hex");
const wallClock: SteeringClock = { nowMs: () => Date.now() };

function directive(id: string, targetSessionId: string) {
	return SteeringDirectiveSchema.parse({
		id,
		author: { principalId: HUMAN, kind: "human" },
		createdAtMs: Date.now(),
		priority: "normal",
		targetSessionId,
		action: "pause",
		body: "Hold the plan until the review lands.",
		conflictsWithActivePlan: false,
	});
}

describeLive("steering replay and delivery sequence against PostgreSQL", () => {
	let first: IndexStore;
	let second: IndexStore;
	let raw: SQL;

	beforeAll(async () => {
		const url = defined(PG_URL, "SUBSTRATE_TEST_PG_URL");
		const migrationOptIns = { "steering-audit": true, "steering-sessions": false };
		first = new IndexStore(url, { migrationOptIns });
		second = new IndexStore(url, { migrationOptIns });
		await first.migrate();
		raw = new SQL(url);
	});

	afterAll(async () => {
		if (!PG_URL) return;
		// Test-owned rows only: every session this file names starts with RUN.
		if (raw) {
			const like = `${RUN}%`;
			await raw`delete from planning_steering_audit where target_session_id like ${like}`;
			await raw`delete from planning_steering_replay where target_session_id like ${like}`;
			await raw`delete from planning_steering_sequence where target_session_id like ${like}`;
			await raw.close();
		}
		if (first) await first.close();
		if (second) await second.close();
	});

	function inboxOver(index: IndexStore): SteeringInbox {
		return new SteeringInbox({
			history: index.steeringAudit(),
			clock: wallClock,
			policy: { allowlist: [HUMAN], ratePerMin: 100 },
			store: index.steeringIdempotency(),
		});
	}

	test("a saved replay is returned exactly by a second instance, and the sequence continues from the saved value", async () => {
		const session = `${RUN}-restart`;
		const now = Date.now();
		const writer = first.steeringIdempotency();
		const sequence = await writer.nextSequence(session);
		const record: SteeringReplayRecord = {
			scopeKey: JSON.stringify([HUMAN, session, "restart-key"]),
			fingerprint: FINGERPRINT,
			directive: directive(`${RUN}-restart-1`, session),
			queuedAtMs: now,
			sequence,
			expiresAtMs: now + TTL_MS,
		};
		expect(await writer.claimReplay(record, now, CAP, async () => {})).toEqual({ claimed: true });

		const restarted = second.steeringIdempotency();
		expect(await restarted.findReplay(record.scopeKey, now)).toEqual(record);
		expect(await restarted.nextSequence(session)).toBe(sequence + 1);
	});

	test("a claim whose unit fails keeps no replay record on either instance", async () => {
		const session = `${RUN}-refused`;
		const now = Date.now();
		const record: SteeringReplayRecord = {
			scopeKey: JSON.stringify([HUMAN, session, "refused-key"]),
			fingerprint: FINGERPRINT,
			directive: directive(`${RUN}-refused-1`, session),
			queuedAtMs: now,
			sequence: 1,
			expiresAtMs: now + TTL_MS,
		};
		await expect(
			first.steeringIdempotency().claimReplay(record, now, CAP, async () => {
				throw new Error("audit refused");
			}),
		).rejects.toThrow("audit refused");
		expect(await second.steeringIdempotency().findReplay(record.scopeKey, now)).toBeNull();
	});

	test("a keyed queue commits its audit row and replay record together, and a retry on the other instance replays", async () => {
		const session = `${RUN}-together`;
		const original = await inboxOver(first).enqueueReceipt(directive(`${RUN}-t1`, session), KEY);
		const retry = await inboxOver(second).enqueueReceipt(directive(`${RUN}-t2`, session), KEY);
		expect(original).toMatchObject({ ok: true, value: { replayed: false } });
		expect(retry).toMatchObject({ ok: true, value: { replayed: true, record: { directive: { id: `${RUN}-t1` } } } });
		const queued = await raw`select directive_id from planning_steering_audit where target_session_id = ${session} and transition = 'queued'`;
		expect(queued.map((row: { directive_id: string }) => row.directive_id)).toEqual([`${RUN}-t1`]);
	});

	test("two concurrent keyed commands through two instances queue one directive and both get its reply", async () => {
		const session = `${RUN}-race`;
		const [a, b] = await Promise.all([
			inboxOver(first).enqueueReceipt(directive(`${RUN}-race-a`, session), RACE_KEY),
			inboxOver(second).enqueueReceipt(directive(`${RUN}-race-b`, session), RACE_KEY),
		]);
		if (!a.ok || !b.ok) throw new Error("both keyed commands should be answered");
		expect(a.value.record.directive.id).toBe(b.value.record.directive.id);
		expect([`${RUN}-race-a`, `${RUN}-race-b`]).toContain(a.value.record.directive.id);
		expect([a.value.replayed, b.value.replayed].sort()).toEqual([false, true]);
		const queued = await raw`select directive_id from planning_steering_audit where target_session_id = ${session} and transition = 'queued'`;
		expect(queued.length).toBe(1);
	});
});
