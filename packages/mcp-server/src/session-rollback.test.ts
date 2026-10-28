/**
 * session_checkpoint, session_rollback_plan and session_rollback_commit (v1.6 phase 61), service level and MCP level.
 *
 * Everything runs over a real `Substrate` (and, for the MCP half, a real MCP server and client over an in-memory
 * transport) with an in-memory ledger and memory index and the repo's recording Hindsight fake: no network, no
 * database, no clock of our own. Memory entries are placed relative to the target checkpoint event's `ts`, so the
 * tests do not depend on the wall clock either.
 */
import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import type { GreptimeClient } from "./greptime.ts";
import { FORGET_ACTION, forgetIdFor } from "./memory-forget.ts";
import { Substrate } from "./service.ts";
import {
	MAX_CLIENT_CLOCK_SKEW_MS,
	MAX_TAKEN_AT_AGE_MS,
	FORGET_BATCH_ACTION,
	checkpointCut,
	deriveRollbackId,
	rollbackPlanDigest,
	sessionRollbackPlan,
	type CheckpointResult,
	type CommitResult,
	type PlanResult,
	type RollbackCaller,
	type RollbackFailure,
	type RollbackPlan,
} from "./session-rollback.ts";
import { parseSessionEventPayload } from "./session-events.ts";
import { GIT_TREE, SESSION, bankOf, checkpointRequest, ckptId, connect, connectAs, entry, rbId, rollbackDepsOf, seedDocuments, withPlaneEnv, world, type World } from "./session-rollback.testkit.ts";
import type { MemoryEntry, SubstrateEvent, Surface } from "./types.ts";

const ME: RollbackCaller = { surface: "claude-code", isOperator: false };
const OTHER: RollbackCaller = { surface: "hermes", isOperator: false };
const OPERATOR: RollbackCaller = { surface: "omp", isOperator: true };

function plain(result: CheckpointResult | PlanResult | CommitResult): Record<string, unknown> {
	return result as unknown as Record<string, unknown>;
}

function errorOf(result: CheckpointResult | PlanResult | CommitResult): RollbackFailure["error"] {
	if (result.ok) throw new Error("expected a failure, got an answer");
	return result.error;
}

function planOf(result: PlanResult): RollbackPlan {
	if (!result.ok) throw new Error(`expected a plan, got ${result.error.code}`);
	return result.plan;
}

async function record(w: World, n: number, caller: RollbackCaller = ME, over: Record<string, unknown> = {}, session = SESSION): Promise<{ event_id: string; ts: number }> {
	const result = await w.substrate.sessionCheckpoint(checkpointRequest(n, over, session), caller);
	if (!result.ok) throw new Error(`checkpoint ${n} was not recorded: ${result.error.code} ${result.error.message}`);
	const event = w.ledger.events.find((candidate) => candidate.id === result.event_id);
	if (event === undefined) throw new Error("the recorded event is not in the ledger");
	return { event_id: result.event_id, ts: Date.parse(event.ts) };
}

async function plan(w: World, target: number, caller: RollbackCaller = ME, rollback?: string): Promise<RollbackPlan> {
	const result = await w.substrate.sessionRollbackPlan({ session_id: SESSION, target_ckpt_id: ckptId(target), ...(rollback !== undefined ? { rollback_id: rollback } : {}) }, caller);
	if (!result.ok) throw new Error(`plan failed: ${result.error.code} ${result.error.message}`);
	return result.plan;
}

function commitInput(p: RollbackPlan, over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		session_id: SESSION,
		rollback_id: p.rollback_id,
		target_ckpt_id: p.target.ckpt_id,
		plan_digest: p.plan_digest,
		outcome: "committed",
		from_ckpt_id: ckptId(2),
		pre_restore_tree: "c".repeat(40),
		pre_restore_ckpt_id: ckptId(3),
		files: { added: 1, modified: 2, deleted: 3 },
		transcript: "marker-only",
		...over,
	};
}

const at = (ms: number): string => new Date(ms).toISOString();

/**
 * Memory around the target checkpoint: two of the caller's entries written after it, one before it, one written after it by
 * another surface, and one after it in another session. Returns the ids by role.
 */
function seedMemory(w: World, targetTs: number): { mineAfter: string[]; mineBefore: string; otherWriter: string; otherSession: string } {
	const entries: MemoryEntry[] = [
		entry({ id: "mem_after_1", created: at(targetTs + 60_000) }),
		entry({ id: "mem_after_2", created: at(targetTs + 61_000) }),
		entry({ id: "mem_before", created: at(targetTs - 60_000) }),
		entry({ id: "mem_other_writer", created: at(targetTs + 62_000), writer: "hermes" }),
		entry({ id: "mem_other_session", created: at(targetTs + 63_000), session_id: "another-session" }),
	];
	w.index.entries.push(...entries);
	return { mineAfter: ["mem_after_1", "mem_after_2"], mineBefore: "mem_before", otherWriter: "mem_other_writer", otherSession: "mem_other_session" };
}

describe("session_checkpoint", () => {
	test("records one note as the caller's surface, in the session's chain, with the chain position the server observed", async () => {
		const w = world();
		const earlier = await w.substrate.emit({ surface: "claude-code", kind: "shell", summary: "ran a test", session_id: SESSION });
		const forged = { event_id: "evt_forged", hash: "f".repeat(64) };

		const result = await w.substrate.sessionCheckpoint(checkpointRequest(1, { chain_head: forged }), ME);

		expect(result).toMatchObject({ ok: true, ckpt_id: ckptId(1), stored: true });
		const stored = w.ledger.byAction("session.checkpoint");
		expect(stored).toHaveLength(1);
		const event = stored[0] as SubstrateEvent;
		expect(event).toMatchObject({ surface: "claude-code", kind: "note", session_id: SESSION, prev: earlier.event.hash });
		// The client's pointer is replaced by the server's own reading of the ledger.
		expect(parseSessionEventPayload(event.payload, { stored: true })).toMatchObject({ ckpt_id: ckptId(1), chain_head: { event_id: earlier.event.id, hash: earlier.event.hash } });
		expect(JSON.stringify(event.payload)).not.toContain("evt_forged");
		expect(plain(result)["event_id"]).toBe(event.id);
	});

	test("leaves the chain position out when the ledger cannot say what it is, and still records", async () => {
		const w = world();
		await w.substrate.emit({ surface: "claude-code", kind: "shell", summary: "ran a test", session_id: SESSION });
		// Only the head read fails: the replay lookup is a different query shape (kind note, no limit 1).
		const original = w.ledger.queryEvents.bind(w.ledger);
		w.ledger.queryEvents = async (query) => {
			if (query.limit === 1) throw new Error("head read failed");
			return original(query);
		};

		const result = await w.substrate.sessionCheckpoint(checkpointRequest(1, { chain_head: { event_id: "evt_forged", hash: "f".repeat(64) } }), ME);

		expect(result.ok).toBe(true);
		const payload = (w.ledger.byAction("session.checkpoint")[0] as SubstrateEvent).payload;
		expect(payload["chain_head"]).toBeUndefined();
	});

	test("a checkpoint id already recorded answers with the existing event and writes nothing, whatever the idempotency mode", async () => {
		for (const mode of ["off", "enforce"]) {
			const w = world({ SUBSTRATE_EVENT_IDEMPOTENCY: mode });
			const first = await w.substrate.sessionCheckpoint(checkpointRequest(1), ME);
			const again = await w.substrate.sessionCheckpoint(checkpointRequest(1), ME);

			expect(plain(first)["stored"]).toBe(true);
			expect(again).toMatchObject({ ok: true, ckpt_id: ckptId(1), stored: false, event_id: plain(first)["event_id"] });
			expect(w.ledger.byAction("session.checkpoint")).toHaveLength(1);
		}
	});

	test("under enforce the ledger's own key also dedupes an exact replay that the lookup cannot see", async () => {
		const w = world({ SUBSTRATE_EVENT_IDEMPOTENCY: "enforce" });
		const first = await w.substrate.sessionCheckpoint(checkpointRequest(1), ME);
		// A ledger read that misses the first checkpoint (the bounded window): only the key can catch the replay.
		const original = w.ledger.queryEvents.bind(w.ledger);
		w.ledger.queryEvents = async (query) => (query.match?.["kind"] === "note" ? [] : original(query));

		const again = await w.substrate.sessionCheckpoint(checkpointRequest(1), ME);

		expect(again).toMatchObject({ ok: true, stored: false, event_id: plain(first)["event_id"] });
		expect(w.ledger.byAction("session.checkpoint")).toHaveLength(1);
	});

	test("a retry that arrives while the first write is still slow waits for it: one event, the second answer is the existing one", async () => {
		const w = world();
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const { promise: inFirstWrite, resolve: entered } = Promise.withResolvers<void>();
		const original = w.ledger.insertEvent.bind(w.ledger);
		w.ledger.insertEvent = async (event) => {
			if (event.payload["action"] === "session.checkpoint") {
				entered();
				await gate;
			}
			return original(event);
		};

		const first = w.substrate.sessionCheckpoint(checkpointRequest(1), ME);
		await inFirstWrite;
		// The first call is inside its ledger write: its checkpoint is not readable yet. The retry starts now.
		const retry = w.substrate.sessionCheckpoint(checkpointRequest(1), ME);
		release();
		const [a, b] = await Promise.all([first, retry]);

		expect(w.ledger.byAction("session.checkpoint")).toHaveLength(1);
		expect(a).toMatchObject({ ok: true, stored: true });
		expect(b).toMatchObject({ ok: true, stored: false, event_id: plain(a)["event_id"] });
	});

	test("a different checkpoint at an already-recorded seq is recorded under its own event, with a warning, even under enforce", async () => {
		const w = world({ SUBSTRATE_EVENT_IDEMPOTENCY: "enforce" });
		await w.substrate.sessionCheckpoint(checkpointRequest(1), ME);

		const second = await w.substrate.sessionCheckpoint(checkpointRequest(1, { ckpt_id: ckptId(9) }), ME);

		expect(second).toMatchObject({ ok: true, ckpt_id: ckptId(9), stored: true });
		expect((plain(second)["warnings"] as string[]).join(" ")).toContain("already recorded");
		expect(w.ledger.byAction("session.checkpoint").map((event) => event.payload["ckpt_id"])).toEqual([ckptId(1), ckptId(9)]);
	});

	test("a seq or prev_ckpt_id that contradicts the newest recorded checkpoint is a warning, never a failure", async () => {
		const w = world();
		await record(w, 1);
		await record(w, 2);

		const late = await w.substrate.sessionCheckpoint(checkpointRequest(5, { seq: 1, prev_ckpt_id: ckptId(7) }), ME);

		expect(late.ok).toBe(true);
		const warnings = plain(late)["warnings"] as string[];
		expect(warnings.some((warning) => warning.includes("does not follow the newest"))).toBe(true);
		expect(warnings.some((warning) => warning.includes("prev_ckpt_id"))).toBe(true);
		expect(w.ledger.byAction("session.checkpoint")).toHaveLength(3);
		// A clean continuation carries no warnings key at all.
		const clean = await w.substrate.sessionCheckpoint(checkpointRequest(3, { prev_ckpt_id: ckptId(2) }), ME);
		expect(plain(clean)["warnings"]).toBeUndefined();
	});

	test("an implausible taken_at_ms is recorded, ignored, and named in a warning; a plausible one carries none", async () => {
		const w = world();
		const tooOld = await w.substrate.sessionCheckpoint(checkpointRequest(1, { taken_at_ms: Date.now() - 31 * 24 * 3_600_000 }), ME);
		expect(tooOld).toMatchObject({ ok: true, stored: true });
		expect((plain(tooOld)["warnings"] as string[]).join(" ")).toContain("taken_at_ms is more than 30 days before the record time");
		const future = await w.substrate.sessionCheckpoint(checkpointRequest(2, { taken_at_ms: Date.now() + 300_000 }), ME);
		expect((plain(future)["warnings"] as string[]).join(" ")).toContain("taken_at_ms is more than 30 seconds after the record time");
		const fine = await w.substrate.sessionCheckpoint(checkpointRequest(3, { taken_at_ms: Date.now() - 3_600_000 }), ME);
		expect(plain(fine)["warnings"]).toBeUndefined();
		// The field is part of the stored payload either way; only the cut ignores a bad one.
		expect(w.ledger.byAction("session.checkpoint").map((event) => typeof event.payload["taken_at_ms"])).toEqual(["number", "number", "number"]);
		const ignoredPlan = await plan(w, 1);
		const target = w.ledger.byAction("session.checkpoint")[0] as SubstrateEvent;
		expect(w.index.selectBounds.at(-1)).toEqual([at(Date.parse(target.ts)), null]);
		expect(ignoredPlan.target.ckpt_id).toBe(ckptId(1));
		expect((await w.substrate.sessionCheckpoint(checkpointRequest(4, { taken_at_ms: -5 }), ME)).ok).toBe(false);
	});

	test("a checkpoint id recorded by another surface in the session is a conflict, and nothing is written", async () => {
		const w = world();
		await record(w, 1, OTHER);

		const result = await w.substrate.sessionCheckpoint(checkpointRequest(1), ME);

		expect(errorOf(result).code).toBe("conflict");
		expect(w.ledger.byAction("session.checkpoint")).toHaveLength(1);
	});

	test("every hostile or malformed request is an answer naming the field, and writes nothing", async () => {
		const w = world();
		const cases: Array<[unknown, string, string]> = [
			[null, "invalid-request", "JSON object"],
			[checkpointRequest(1, { session_id: "" }), "invalid-request", "session_id"],
			[checkpointRequest(1, { session_id: "x".repeat(600) }), "invalid-request", "at most"],
			[checkpointRequest(1, { session_id: "bad\nsession" }), "invalid-request", "control"],
			[checkpointRequest(1, { git_tree: "not-hex" }), "invalid-payload", "git_tree"],
			[checkpointRequest(1, { ckpt_id: "../../etc/passwd" }), "invalid-payload", "ckpt_id"],
			[checkpointRequest(1, { seq: 0 }), "invalid-payload", "seq"],
			[checkpointRequest(1, { trigger: "whenever" }), "invalid-payload", "trigger"],
			[checkpointRequest(1, { file_content: "secret text" }), "invalid-payload", "file_content"],
			[checkpointRequest(1, { transcript_ref: { surface: "claude-code", session_locator: "/home/me/transcript.jsonl" } }), "invalid-payload", "session_locator"],
			[{ ...checkpointRequest(1), action: "session.rollback" }, "invalid-payload", "action"],
		];
		for (const [input, code, fragment] of cases) {
			const error = errorOf(await w.substrate.sessionCheckpoint(input, ME));
			expect(error.code as string).toBe(code);
			expect(error.message).toContain(fragment);
		}
		expect(w.ledger.events).toHaveLength(0);
	});

	test("a ledger that cannot store the note is ledger-down and retryable; one that cannot be read is too", async () => {
		const down = world();
		down.ledger.failInsert = "connection refused";
		const stored = errorOf(await down.substrate.sessionCheckpoint(checkpointRequest(1), ME));
		expect(stored).toMatchObject({ code: "ledger-down", retryable: true });

		const unreadable = world();
		unreadable.ledger.failQuery = "greptime timed out";
		expect(errorOf(await unreadable.substrate.sessionCheckpoint(checkpointRequest(1), ME))).toMatchObject({ code: "ledger-down", retryable: true });

		const none = new Substrate(loadConfig({}), { index: null, greptime: null });
		expect(errorOf(await none.sessionCheckpoint(checkpointRequest(1), ME))).toMatchObject({ code: "ledger-down", retryable: true });
	});

	test("finds the session's checkpoints past the first page of notes", async () => {
		const w = world();
		await record(w, 1);
		// 600 newer notes of the session, each with its own `ts`, so the page bound can move past them.
		const base = Date.now() + 1_000;
		for (let n = 0; n < 600; n++) {
			const event = { id: `evt_filler_${n}`, ts: at(base + n), surface: "claude-code", session_id: SESSION, kind: "note", summary: "filler", payload: { action: "filler" }, hash: "0".repeat(64), prev: null } as unknown as SubstrateEvent;
			w.ledger.events.push(event);
		}

		const replay = await w.substrate.sessionCheckpoint(checkpointRequest(1), ME);

		expect(replay).toMatchObject({ ok: true, stored: false });
		expect(w.ledger.byAction("session.checkpoint")).toHaveLength(1);
	});
});

describe("session_rollback_plan", () => {
	test("answers the target, the later checkpoints, the anchor verdict and the memory a rollback would forget", async () => {
		const w = world();
		const target = await record(w, 1);
		await record(w, 2);
		await record(w, 3);
		seedMemory(w, target.ts);

		const result = await w.substrate.sessionRollbackPlan({ session_id: SESSION, target_ckpt_id: ckptId(1) }, ME);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { plan: p } = result;
		expect(p.session_id).toBe(SESSION);
		expect(p.rollback_id).toMatch(/^rb_[0-9a-z]{26}$/);
		expect(p.target).toMatchObject({ ckpt_id: ckptId(1), seq: 1, event_id: target.event_id, git_tree: GIT_TREE });
		expect(p.target.event_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(p.later_checkpoints).toEqual([
			{ ckpt_id: ckptId(2), seq: 2 },
			{ ckpt_id: ckptId(3), seq: 3 },
		]);
		// Solana is not configured in this world: the verdict is a status with its reason, and the plan still stands.
		expect(p.anchor?.status).toBe("unverified");
		expect(p.anchor?.reasons.join(" ")).toContain("Solana");
		expect(p.memory).toEqual({ would_forget: 2, sample_ids: ["mem_after_1", "mem_after_2"], truncated: false });
		expect(p.plan_digest).toMatch(/^[0-9a-f]{64}$/);
		// The server writes nothing while planning, and no entry text or path is in the answer.
		expect(w.ledger.events).toHaveLength(3);
		expect(JSON.stringify(p)).not.toContain("a fact");
	});

	test("another surface's checkpoint and an unknown one answer alike: not-found", async () => {
		const w = world();
		await record(w, 1, OTHER);

		const foreign = errorOf(await w.substrate.sessionRollbackPlan({ session_id: SESSION, target_ckpt_id: ckptId(1) }, ME));
		const unknown = errorOf(await w.substrate.sessionRollbackPlan({ session_id: SESSION, target_ckpt_id: ckptId(2) }, ME));
		const otherSession = errorOf(await w.substrate.sessionRollbackPlan({ session_id: "another-session", target_ckpt_id: ckptId(1) }, OTHER));

		expect(foreign.code).toBe("not-found");
		expect(unknown.code).toBe("not-found");
		expect(otherSession.code).toBe("not-found");
		expect(foreign.message.replace(ckptId(1), "<id>")).toBe(unknown.message.replace(ckptId(2), "<id>"));
		// An operator may plan for any surface.
		const operator = await w.substrate.sessionRollbackPlan({ session_id: SESSION, target_ckpt_id: ckptId(1) }, OPERATOR);
		expect(operator.ok).toBe(true);
	});

	test("the memory part is restricted to the session and to the caller's surface; an operator sees every writer", async () => {
		const w = world();
		const target = await record(w, 1);
		const ids = seedMemory(w, target.ts);

		const mine = await plan(w, 1);
		expect(mine.memory.would_forget).toBe(2);
		expect(mine.memory.sample_ids).toEqual(ids.mineAfter);
		const operator = await plan(w, 1, OPERATOR);
		expect(operator.memory.would_forget).toBe(3);
		expect(operator.memory.sample_ids).toContain(ids.otherWriter);
		expect(operator.memory.sample_ids).not.toContain(ids.otherSession);
		expect(operator.plan_digest).not.toBe(mine.plan_digest);
		// An entry created in the very millisecond of the checkpoint is kept: a tie keeps the entry.
		w.index.entries.push(entry({ id: "mem_tie", created: at(target.ts) }));
		expect((await plan(w, 1)).memory.would_forget).toBe(2);
	});

	test("a checkpoint that carries taken_at_ms cuts memory at the earlier of that time and its record time", async () => {
		const w = world();
		const taken = Date.now() - 3_600_000;
		const late = await record(w, 1, ME, { taken_at_ms: taken });
		w.index.entries.push(
			entry({ id: "mem_before_taken", created: at(taken - 1_800_000) }),
			entry({ id: "mem_between", created: at(taken + 1_800_000) }),
			entry({ id: "mem_after_record", created: at(late.ts + 60_000) }),
		);

		const p = await plan(w, 1);

		expect(p.memory.sample_ids).toEqual(["mem_between", "mem_after_record"]);
		expect(w.index.selectBounds[0]).toEqual([at(taken), null]);
		// The same checkpoint without the field cuts at its record time, and keeps what was written in between.
		const onTime = await record(w, 2);
		w.index.entries.push(entry({ id: "mem_after_second", created: at(onTime.ts + 60_000) }));
		expect((await plan(w, 2)).memory.sample_ids).toEqual(["mem_after_record", "mem_after_second"]);
	});

	test("checkpointCut honours taken_at_ms from 30 days before to 30 seconds after the record time, and takes the earlier instant", () => {
		const record = 1_800_000_000_000;
		expect(checkpointCut(record, undefined)).toEqual({ cutMs: record, ignored: null });
		expect(checkpointCut(record, record - 5_000)).toEqual({ cutMs: record - 5_000, ignored: null });
		expect(checkpointCut(record, record - MAX_TAKEN_AT_AGE_MS)).toEqual({ cutMs: record - MAX_TAKEN_AT_AGE_MS, ignored: null });
		expect(checkpointCut(record, record - MAX_TAKEN_AT_AGE_MS - 1)).toEqual({ cutMs: record, ignored: expect.stringContaining("more than 30 days before") });
		// Slightly ahead of the record time is clock skew: honoured, but the record time is still the earlier instant.
		expect(checkpointCut(record, record + MAX_CLIENT_CLOCK_SKEW_MS)).toEqual({ cutMs: record, ignored: null });
		expect(checkpointCut(record, record + MAX_CLIENT_CLOCK_SKEW_MS + 1)).toEqual({ cutMs: record, ignored: expect.stringContaining("more than 30 seconds after") });
	});

	test("shows at most twenty sample ids but counts every entry", async () => {
		const w = world();
		const target = await record(w, 1);
		for (let n = 0; n < 30; n++) w.index.entries.push(entry({ id: `mem_${String(n).padStart(3, "0")}`, created: at(target.ts + 1_000 + n) }));

		const p = await plan(w, 1);

		expect(p.memory.would_forget).toBe(30);
		expect(p.memory.sample_ids).toHaveLength(20);
	});

	test("the rollback id is the one given, else the same for the same inputs and new when a newer checkpoint exists", async () => {
		const w = world();
		await record(w, 1);
		await record(w, 2);

		const first = await plan(w, 1);
		const second = await plan(w, 1);
		const given = await plan(w, 1, ME, rbId(7));
		await record(w, 3);
		const afterNewer = await plan(w, 1);

		expect(second.rollback_id).toBe(first.rollback_id);
		expect(first.rollback_id).toBe(deriveRollbackId(SESSION, ckptId(1), ckptId(2)));
		expect(given.rollback_id).toBe(rbId(7));
		expect(afterNewer.rollback_id).not.toBe(first.rollback_id);
	});

	test("the digest does not cover the later checkpoints, so the client's pre-restore checkpoint does not make a commit stale", async () => {
		const w = world();
		const target = await record(w, 1);
		await record(w, 2);
		seedMemory(w, target.ts);
		const before = await plan(w, 1, ME, rbId(1));

		await record(w, 3, ME, { trigger: "pre-restore" });
		const after = await plan(w, 1, ME, rbId(1));

		expect(after.later_checkpoints).toHaveLength(2);
		expect(before.later_checkpoints).toHaveLength(1);
		expect(after.plan_digest).toBe(before.plan_digest);
		// It does cover the rollback id, and the entries that would be forgotten.
		expect((await plan(w, 1, ME, rbId(2))).plan_digest).not.toBe(before.plan_digest);
		w.index.entries.push(entry({ id: "mem_new", created: at(target.ts + 90_000) }));
		expect((await plan(w, 1, ME, rbId(1))).plan_digest).not.toBe(before.plan_digest);
		expect(rollbackPlanDigest({ rollbackId: rbId(1), sessionId: SESSION, targetCkptId: ckptId(1), targetEventHash: before.target.event_hash, entryIds: ["mem_after_2", "mem_after_1"] })).toBe(before.plan_digest);
	});

	test("an index that cannot be read is unavailable and retryable; no index means nothing to forget", async () => {
		const w = world();
		await record(w, 1);
		w.index.failSelect = "connection reset";
		expect(errorOf(await w.substrate.sessionRollbackPlan({ session_id: SESSION, target_ckpt_id: ckptId(1) }, ME))).toMatchObject({ code: "unavailable", retryable: true });

		const noIndex = new Substrate(loadConfig({}), { index: null, greptime: w.ledger as unknown as GreptimeClient });
		const result = planOf(await noIndex.sessionRollbackPlan({ session_id: SESSION, target_ckpt_id: ckptId(1) }, ME));
		expect(result.memory).toEqual({ would_forget: 0, sample_ids: [], truncated: false });
	});

	test("a ledger that cannot be read is ledger-down", async () => {
		const w = world();
		w.ledger.failQuery = "greptime timed out";
		expect(errorOf(await w.substrate.sessionRollbackPlan({ session_id: SESSION, target_ckpt_id: ckptId(1) }, ME))).toMatchObject({ code: "ledger-down", retryable: true });
	});

	test("the anchor check is bounded and fails open: a slow or failing verifier leaves anchor null and the plan stands", async () => {
		const w = world();
		await record(w, 1);
		const input = { session_id: SESSION, target_ckpt_id: ckptId(1) };
		const never = { ...rollbackDepsOf(w.substrate), anchorTimeoutMs: 1, verifyAnchor: () => new Promise<never>(() => {}) };
		const throwing = { ...rollbackDepsOf(w.substrate), verifyAnchor: async () => Promise.reject(new Error("rpc down")) };
		const odd = { ...rollbackDepsOf(w.substrate), verifyAnchor: async () => ({ status: "surely-fine", reasons: [] }) };
		const noisy = { ...rollbackDepsOf(w.substrate), verifyAnchor: async () => ({ status: "anchored", reasons: Array.from({ length: 50 }, () => "r".repeat(500)) }) };

		for (const deps of [never, throwing, odd]) {
			expect(planOf(await sessionRollbackPlan(deps, input, ME)).anchor).toBeNull();
		}
		const bounded = planOf(await sessionRollbackPlan(noisy, input, ME));
		expect(bounded.anchor?.reasons).toHaveLength(20);
		expect(bounded.anchor?.reasons[0]).toHaveLength(200);
	});

	test("rejects unknown keys and malformed ids", async () => {
		const w = world();
		await record(w, 1);
		for (const input of [
			{ session_id: SESSION, target_ckpt_id: ckptId(1), extra: 1 },
			{ session_id: SESSION, target_ckpt_id: "ckpt_short" },
			{ session_id: SESSION, target_ckpt_id: ckptId(1), rollback_id: "rb_nope" },
			{ target_ckpt_id: ckptId(1) },
			"nope",
		]) {
			expect(errorOf(await w.substrate.sessionRollbackPlan(input, ME)).code).toBe("invalid-request");
		}
	});
});

describe("session_rollback_commit: refused", () => {
	test("appends one session.rollback.refused warning and answers its event id", async () => {
		const w = world();
		await record(w, 1);
		const detail = `${"drift in src/a.ts and C:\\Users\\me\\b.ts\n".repeat(20)}`;

		const result = await w.substrate.sessionRollbackCommit(
			{ session_id: SESSION, rollback_id: rbId(1), target_ckpt_id: ckptId(1), outcome: "refused", reason: "drift-detected", detail },
			ME,
		);

		expect(result.ok).toBe(true);
		const refusals = w.ledger.byAction("session.rollback.refused");
		expect(refusals).toHaveLength(1);
		const event = refusals[0] as SubstrateEvent;
		expect(event).toMatchObject({ kind: "warning", surface: "claude-code", session_id: SESSION });
		expect(plain(result)["event_id"]).toBe(event.id);
		const payload = parseSessionEventPayload(event.payload, { stored: true });
		expect(payload).toMatchObject({ action: "session.rollback.refused", reason: "drift-detected", to_ckpt_id: ckptId(1) });
		const stored = "detail" in payload ? (payload.detail ?? "") : "";
		expect(stored.length).toBeLessThanOrEqual(300);
		expect(stored).not.toContain("\n");
		expect(stored).not.toContain("src/a.ts");
		expect(stored).not.toContain("Users");
		expect(stored).toContain("[path]");
		// A repeated refusal is a new fact, not a replay.
		await w.substrate.sessionRollbackCommit({ session_id: SESSION, rollback_id: rbId(1), target_ckpt_id: ckptId(1), outcome: "refused", reason: "drift-detected" }, ME);
		expect(w.ledger.byAction("session.rollback.refused")).toHaveLength(2);
	});

	test("a reason outside the contract, a missing outcome and an unknown key are refused before anything is written", async () => {
		const w = world();
		const base = { session_id: SESSION, rollback_id: rbId(1), target_ckpt_id: ckptId(1) };
		for (const input of [
			{ ...base, outcome: "refused", reason: "because" },
			{ ...base, outcome: "refused" },
			{ ...base, outcome: "maybe" },
			{ ...base, outcome: "refused", reason: "hash-mismatch", plan_digest: "nope" },
			{ ...base, outcome: "refused", reason: "hash-mismatch", files: {} },
		]) {
			expect(errorOf(await w.substrate.sessionRollbackCommit(input, ME)).code).toBe("invalid-request");
		}
		expect(w.ledger.events).toHaveLength(0);
	});

	test("a ledger that cannot store the refusal is ledger-down", async () => {
		const w = world();
		w.ledger.failInsert = "down";
		const result = await w.substrate.sessionRollbackCommit({ session_id: SESSION, rollback_id: rbId(1), target_ckpt_id: ckptId(1), outcome: "refused", reason: "ledger-down" }, ME);
		expect(errorOf(result)).toMatchObject({ code: "ledger-down", retryable: true });
	});
});

describe("session_rollback_commit: committed", () => {
	test("forgets what the caller wrote after the checkpoint, keeps the rest, deletes the plane documents and records the totals once", async () => {
		await withPlaneEnv(async () => {
			const w = world();
			const target = await record(w, 1);
			await record(w, 2);
			const ids = seedMemory(w, target.ts);
			seedDocuments(w.plane, w.index.entries);
			const p = await plan(w, 1);

			const result = await w.substrate.sessionRollbackCommit(commitInput(p), ME);

			expect(result).toMatchObject({ ok: true, memory: { superseded_entries: 2, forgotten_documents: 2, plane_pending: false, truncated: false } });
			expect(w.index.forgotten().sort()).toEqual(ids.mineAfter);
			for (const kept of [ids.mineBefore, ids.otherWriter, ids.otherSession]) {
				expect((await w.index.readEntry(kept))?.superseded_by).toBeUndefined();
			}
			// The plane documents of the forgotten entries are gone; the others remain.
			const documents = (bank: string): string[] => (w.plane.banks.get(bank)?.memories ?? []).map((memory) => memory.document_id ?? "");
			expect(documents(bankOf("claude-code"))).toEqual(["idem-mem_before", "idem-mem_other_session"]);
			expect(documents(bankOf("hermes"))).toEqual(["idem-mem_other_writer"]);
			const deletes = w.plane.requests.filter((request) => request.method === "DELETE");
			expect(deletes.map((request) => request.path.split("/").pop()).sort()).toEqual(["idem-mem_after_1", "idem-mem_after_2"]);
			// Recall afterwards excludes them: the index no longer selects them and the rollback point selects none.
			expect((await plan(w, 1, ME, rbId(99))).memory.would_forget).toBe(0);

			const rollbacks = w.ledger.byAction("session.rollback");
			expect(rollbacks).toHaveLength(1);
			const event = rollbacks[0] as SubstrateEvent;
			expect(event).toMatchObject({ kind: "note", surface: "claude-code", session_id: SESSION });
			expect(plain(result)["event_id"]).toBe(event.id);
			expect(parseSessionEventPayload(event.payload, { stored: true })).toMatchObject({
				action: "session.rollback",
				rollback_id: p.rollback_id,
				from_ckpt_id: ckptId(2),
				to_ckpt_id: ckptId(1),
				target_event_id: target.event_id,
				target_hash: p.target.event_hash,
				files_added: 1,
				files_modified: 2,
				files_deleted: 3,
				memory: { superseded_entries: 2, forgotten_documents: 2 },
				transcript: "marker-only",
			});
			// The forget left its own note, tied to the rollback and the checkpoint, and no entry text.
			const forgets = w.ledger.byAction(FORGET_ACTION);
			expect(forgets).toHaveLength(1);
			expect(forgets[0]?.payload).toMatchObject({ reason: "rollback", rollback_id: p.rollback_id, checkpoint_id: ckptId(1), session_id: SESSION, entry_count: 2 });
			expect(JSON.stringify(w.ledger.events.map((candidate) => candidate.payload))).not.toContain("a fact");
		});
	});

	test("a changed plan answers stale-plan and changes nothing", async () => {
		const w = world();
		const target = await record(w, 1);
		seedMemory(w, target.ts);
		const p = await plan(w, 1);
		w.index.entries.push(entry({ id: "mem_late", created: at(target.ts + 120_000) }));
		const eventsBefore = w.ledger.events.length;

		const result = await w.substrate.sessionRollbackCommit(commitInput(p), ME);

		expect(errorOf(result).code).toBe("stale-plan");
		expect(w.index.marks).toHaveLength(0);
		expect(w.index.forgotten()).toEqual([]);
		expect(w.ledger.events).toHaveLength(eventsBefore);
		// Planning again gives a digest that commits.
		const again = await plan(w, 1, ME, p.rollback_id);
		expect((await w.substrate.sessionRollbackCommit(commitInput(again), ME)).ok).toBe(true);
		expect(w.index.forgotten()).toHaveLength(3);
	});

	test("a rollback delivered late forgets only what the old timeline wrote: until_ms bounds the selection, and a commit with another bound than its plan is stale", async () => {
		const w = world();
		const target = await record(w, 1);
		w.index.entries.push(
			entry({ id: "mem_old_1", created: at(target.ts + 1_000) }),
			entry({ id: "mem_old_2", created: at(target.ts + 2_000) }),
			entry({ id: "mem_new_timeline", created: at(target.ts + 3_000) }),
		);
		const bounded = planOf(await w.substrate.sessionRollbackPlan({ session_id: SESSION, target_ckpt_id: ckptId(1), until_ms: target.ts + 2_000 }, ME));
		expect(bounded.memory.sample_ids).toEqual(["mem_old_1", "mem_old_2"]);
		// The digest covers the entry ids, so the bound reaches it through them.
		const unbounded = await plan(w, 1);
		expect(unbounded.memory.sample_ids).toEqual(["mem_old_1", "mem_old_2", "mem_new_timeline"]);
		expect(unbounded.plan_digest).not.toBe(bounded.plan_digest);

		// The commit drops the bound its plan had: it would forget the new timeline too, so it is stale.
		const stale = await w.substrate.sessionRollbackCommit(commitInput(bounded), ME);
		expect(errorOf(stale).code).toBe("stale-plan");
		expect(w.index.marks).toHaveLength(0);

		const result = await w.substrate.sessionRollbackCommit(commitInput(bounded, { until_ms: target.ts + 2_000 }), ME);
		expect(result).toMatchObject({ ok: true, memory: { superseded_entries: 2 } });
		expect(w.index.forgotten().sort()).toEqual(["mem_old_1", "mem_old_2"]);
		expect((await w.index.readEntry("mem_new_timeline"))?.superseded_by).toBeUndefined();
		expect(w.index.selectBounds.every(([, until]) => until === null || until === at(target.ts + 2_000))).toBe(true);
	});

	test("a bad until_ms is refused before anything is forgotten, on a commit as on a plan, and a refusal takes none", async () => {
		const w = world();
		const target = await record(w, 1);
		seedMemory(w, target.ts);
		const p = await plan(w, 1);
		const bad: Array<[unknown, string]> = [
			[Date.now() + 120_000, "more than 30 seconds in the future"],
			[target.ts - 1, "before the checkpoint's memory cut"],
			[1.5, "non-negative integer"],
			[-1, "non-negative integer"],
			["soon", "non-negative integer"],
		];
		for (const [value, fragment] of bad) {
			const planned = errorOf(await w.substrate.sessionRollbackPlan({ session_id: SESSION, target_ckpt_id: ckptId(1), until_ms: value }, ME));
			expect(planned.code).toBe("invalid-request");
			expect(planned.message).toContain(fragment);
			const committed = errorOf(await w.substrate.sessionRollbackCommit(commitInput(p, { until_ms: value }), ME));
			expect(committed.code).toBe("invalid-request");
			expect(committed.message).toContain(fragment);
		}
		expect(w.index.marks).toHaveLength(0);
		expect(w.ledger.byAction("session.rollback")).toHaveLength(0);
		const refused = await w.substrate.sessionRollbackCommit({ session_id: SESSION, rollback_id: p.rollback_id, target_ckpt_id: p.target.ckpt_id, outcome: "refused", reason: "drift-detected", until_ms: target.ts + 1_000 }, ME);
		expect(errorOf(refused).message).toContain("unknown key");
	});

	test("a checkpoint recorded late forgets the memory written between taking and recording it", async () => {
		const w = world();
		const taken = Date.now() - 3_600_000;
		await record(w, 1, ME, { taken_at_ms: taken });
		w.index.entries.push(entry({ id: "mem_between", created: at(taken + 1_800_000) }), entry({ id: "mem_before_taken", created: at(taken - 1_800_000) }));
		const p = await plan(w, 1);
		expect(p.memory.sample_ids).toEqual(["mem_between"]);

		const result = await w.substrate.sessionRollbackCommit(commitInput(p), ME);
		expect(result).toMatchObject({ ok: true, memory: { superseded_entries: 1 } });
		expect(w.index.forgotten()).toEqual(["mem_between"]);
	});

	test("a committed rollback without a digest, with a malformed digest or with bad fields is refused before anything is forgotten", async () => {
		const w = world();
		const target = await record(w, 1);
		seedMemory(w, target.ts);
		const p = await plan(w, 1);
		const { plan_digest: _digest, ...withoutDigest } = commitInput(p);

		const cases: Array<[Record<string, unknown>, string]> = [
			[withoutDigest, "plan_digest is required"],
			[commitInput(p, { plan_digest: "ABC" }), "plan_digest"],
			[commitInput(p, { files: { added: -1, modified: 0, deleted: 0 } }), "files.added"],
			[commitInput(p, { files: { added: 1, modified: 0 } }), "files.deleted"],
			[commitInput(p, { transcript: "rewrote-it" }), "transcript"],
			[commitInput(p, { pre_restore_tree: "tree" }), "pre_restore_tree"],
			[commitInput(p, { from_ckpt_id: "ckpt_x" }), "from_ckpt_id"],
			[commitInput(p, { extra: true }), "unknown key"],
			[commitInput(p, { local_only: "yes" }), "local_only"],
		];
		for (const [input, fragment] of cases) {
			const error = errorOf(await w.substrate.sessionRollbackCommit(input, ME));
			expect(error.code).toBe("invalid-request");
			expect(error.message).toContain(fragment);
		}
		expect(w.index.marks).toHaveLength(0);
		expect(w.ledger.byAction("session.rollback")).toHaveLength(0);
	});

	test("a repeat of the same rollback id answers the earlier result without forgetting again", async () => {
		await withPlaneEnv(async () => {
			const w = world();
			const target = await record(w, 1);
			seedMemory(w, target.ts);
			seedDocuments(w.plane, w.index.entries);
			const p = await plan(w, 1);
			const first = await w.substrate.sessionRollbackCommit(commitInput(p), ME);
			const marks = w.index.marks.length;
			const requests = w.plane.requests.length;
			const notes = w.ledger.events.length;

			const again = await w.substrate.sessionRollbackCommit(commitInput(p), ME);

			expect(again).toMatchObject({ ok: true, event_id: plain(first)["event_id"], replayed: true, memory: { superseded_entries: 2, forgotten_documents: 2, plane_pending: false, truncated: false } });
			expect(w.index.marks).toHaveLength(marks);
			expect(w.plane.requests).toHaveLength(requests);
			expect(w.ledger.events).toHaveLength(notes);
			expect(w.ledger.byAction("session.rollback")).toHaveLength(1);
		});
	});

	test("two identical commits in flight are one commit", async () => {
		const w = world();
		const target = await record(w, 1);
		seedMemory(w, target.ts);
		const p = await plan(w, 1);

		const [a, b] = await Promise.all([w.substrate.sessionRollbackCommit(commitInput(p), ME), w.substrate.sessionRollbackCommit(commitInput(p), ME)]);

		expect(plain(a)["event_id"]).toBe(plain(b)["event_id"]);
		expect(w.ledger.byAction("session.rollback")).toHaveLength(1);
		expect(w.index.marks).toHaveLength(1);
	});

	test("a rollback id used by another surface or for another target is a conflict", async () => {
		const w = world();
		const target = await record(w, 1);
		await record(w, 2);
		seedMemory(w, target.ts);
		const p = await plan(w, 1);
		await w.substrate.sessionRollbackCommit(commitInput(p), ME);

		const foreign = await w.substrate.sessionRollbackCommit(commitInput(p), OTHER);
		const otherTarget = await w.substrate.sessionRollbackCommit(commitInput(p, { target_ckpt_id: ckptId(2) }), ME);

		expect(errorOf(foreign).code).toBe("conflict");
		expect(errorOf(otherTarget).code).toBe("conflict");
		expect(w.ledger.byAction("session.rollback")).toHaveLength(1);
	});

	test("a checkpoint that is not the caller's answers not-found and forgets nothing; an operator may commit for any surface", async () => {
		const w = world();
		const target = await record(w, 1, OTHER);
		const ids = seedMemory(w, target.ts);
		const p = await plan(w, 1, OPERATOR);

		const refused = await w.substrate.sessionRollbackCommit(commitInput(p), ME);
		expect(errorOf(refused).code).toBe("not-found");
		expect(w.index.marks).toHaveLength(0);

		const result = await w.substrate.sessionRollbackCommit(commitInput(p), OPERATOR);
		expect(result).toMatchObject({ ok: true, memory: { superseded_entries: 3 } });
		expect(w.index.forgotten().sort()).toEqual([...ids.mineAfter, ids.otherWriter].sort());
		expect(w.ledger.byAction("session.rollback")[0]?.surface).toBe("omp");
	});

	test("an index that fails to mark is forget-incomplete: nothing is recorded, the marks are idempotent and the retry completes", async () => {
		const w = world();
		const target = await record(w, 1);
		seedMemory(w, target.ts);
		w.index.failMark = "connection dropped";
		const p = await plan(w, 1);

		const failed = await w.substrate.sessionRollbackCommit(commitInput(p), ME);

		expect(errorOf(failed)).toMatchObject({ code: "forget-incomplete", retryable: true, done: { superseded_entries: 0, forgotten_documents: 0, plane_pending: false } });
		expect(w.ledger.byAction("session.rollback")).toHaveLength(0);
		w.index.failMark = null;
		const retried = await w.substrate.sessionRollbackCommit(commitInput(p), ME);
		expect(retried).toMatchObject({ ok: true, memory: { superseded_entries: 2 } });
		expect(w.ledger.byAction("session.rollback")).toHaveLength(1);
	});

	test("a forget that stops part way carries what was done into the retry, so the recorded totals are the real ones", async () => {
		const w = world();
		const target = await record(w, 1);
		for (let n = 0; n < 120; n++) w.index.entries.push(entry({ id: `mem_${String(n).padStart(3, "0")}`, created: at(target.ts + 1_000 + n) }));
		const p = await plan(w, 1);
		expect(p.memory.would_forget).toBe(120);
		// Batches of 50: the first lands, the second's connection drops.
		w.index.markFailsAfter = 1;

		const failed = await w.substrate.sessionRollbackCommit(commitInput(p), ME);

		expect(errorOf(failed)).toMatchObject({ code: "forget-incomplete", retryable: true, done: { superseded_entries: 50 } });
		expect(w.index.forgotten()).toHaveLength(50);
		expect(w.ledger.byAction("session.rollback")).toHaveLength(0);
		w.index.markFailsAfter = null;
		// The plan moved (50 are gone): the old digest is stale, a fresh plan commits.
		expect(errorOf(await w.substrate.sessionRollbackCommit(commitInput(p), ME)).code).toBe("stale-plan");
		const again = await plan(w, 1, ME, p.rollback_id);
		expect(again.memory.would_forget).toBe(70);

		const done = await w.substrate.sessionRollbackCommit(commitInput(again), ME);

		expect(done).toMatchObject({ ok: true, memory: { superseded_entries: 120, truncated: false } });
		expect(w.index.forgotten()).toHaveLength(120);
		const event = w.ledger.byAction("session.rollback")[0] as SubstrateEvent;
		expect(event.payload["memory"]).toMatchObject({ superseded_entries: 120 });
	});

	test("a rollback the ledger could not record after the forget says so, keeps the marks and records the right totals on the retry", async () => {
		const w = world();
		const target = await record(w, 1);
		seedMemory(w, target.ts);
		const p = await plan(w, 1);
		w.ledger.failInsertFor = (event) => event.payload["action"] === "session.rollback";

		const failed = await w.substrate.sessionRollbackCommit(commitInput(p), ME);

		expect(errorOf(failed)).toMatchObject({ code: "ledger-down", retryable: true, done: { superseded_entries: 2 } });
		expect(w.index.forgotten()).toHaveLength(2);
		w.ledger.failInsertFor = null;
		const fresh = await plan(w, 1, ME, p.rollback_id);
		const retried = await w.substrate.sessionRollbackCommit(commitInput(fresh), ME);
		expect(retried).toMatchObject({ ok: true, memory: { superseded_entries: 2 } });
		expect(w.ledger.byAction("session.rollback")).toHaveLength(1);
	});

	test("a forget whose ledger note cannot be recorded stops the commit: its rows are marked and nothing else would remember the batch", async () => {
		const w = world();
		const target = await record(w, 1);
		seedMemory(w, target.ts);
		const p = await plan(w, 1);
		w.ledger.failInsertFor = (event) => event.payload["action"] === FORGET_ACTION;

		const failed = await w.substrate.sessionRollbackCommit(commitInput(p), ME);

		expect(errorOf(failed)).toMatchObject({ code: "forget-incomplete", retryable: true });
		expect(errorOf(failed).message).toContain("could not be recorded");
		// Never reported as a finished rollback.
		expect(w.ledger.byAction("session.rollback")).toHaveLength(0);
		expect(w.index.forgotten()).toHaveLength(2);
	});

	test("a forget note that fails once is repeated with the same request, and the commit completes with the real totals", async () => {
		const w = world();
		const target = await record(w, 1);
		seedMemory(w, target.ts);
		const p = await plan(w, 1);
		let failures = 1;
		w.ledger.failInsertFor = (event) => event.payload["action"] === FORGET_ACTION && failures-- > 0;

		const result = await w.substrate.sessionRollbackCommit(commitInput(p), ME);

		expect(result).toMatchObject({ ok: true, memory: { superseded_entries: 2 } });
		expect(w.ledger.byAction(FORGET_ACTION)).toHaveLength(1);
		expect(w.ledger.byAction("session.rollback")).toHaveLength(1);
		// The repeat is the same forget call: one forget id on the note, and no second mark.
		expect(w.index.marks).toHaveLength(1);
	});

	test("a forget batch is on record before its rows are marked, so a note that never lands does not lose it: the next plan lists the batch and the commit finishes it", async () => {
		const w = world();
		const target = await record(w, 1);
		seedMemory(w, target.ts);
		const p = await plan(w, 1);
		w.ledger.failInsertFor = (event) => event.payload["action"] === FORGET_ACTION;

		const failed = await w.substrate.sessionRollbackCommit(commitInput(p), ME);

		expect(errorOf(failed).code).toBe("forget-incomplete");
		// The record exists, names the same forget id the marks carry, and the rows are marked.
		expect(w.ledger.byAction(FORGET_BATCH_ACTION)).toHaveLength(1);
		expect(w.ledger.byAction(FORGET_ACTION)).toHaveLength(0);
		expect(w.index.forgotten()).toHaveLength(2);
		w.ledger.failInsertFor = null;

		// The marked rows no longer match the index selection, yet the plan still lists them: they belong to an unfinished batch.
		const again = await plan(w, 1, ME, p.rollback_id);
		expect(again.memory.would_forget).toBe(2);
		const done = await w.substrate.sessionRollbackCommit(commitInput(again), ME);

		expect(done).toMatchObject({ ok: true, memory: { superseded_entries: 2 } });
		expect(w.ledger.byAction(FORGET_ACTION)).toHaveLength(1);
		expect(w.ledger.byAction(FORGET_BATCH_ACTION)).toHaveLength(1);
		expect(w.ledger.byAction("session.rollback")).toHaveLength(1);
		// Finished as the same call: no second mark.
		expect(w.index.marks).toHaveLength(1);
		// Once finished, a plan of the same rollback no longer lists the batch.
		expect((await plan(w, 1, ME, p.rollback_id)).memory.would_forget).toBe(0);
	});

	test("a forget batch note naming entries that are not the caller's, not this session's, not after the cut or not there is ignored, and nothing of it is forgotten", async () => {
		const w = world();
		const target = await record(w, 1);
		const ids = seedMemory(w, target.ts);
		const p = await plan(w, 1);
		// Well formed and hash-true, as a note written around the emit door would be: each names one entry the caller may not forget.
		for (const forged of [[ids.otherWriter], [ids.mineBefore], [ids.otherSession], ["mem_does_not_exist"]]) {
			await w.substrate.emit({
				surface: "claude-code",
				kind: "note",
				summary: "forged forget batch",
				session_id: SESSION,
				payload: {
					action: FORGET_BATCH_ACTION,
					forget_id: forgetIdFor({ reason: "rollback", entry_ids: forged, rollback_id: p.rollback_id, checkpoint_id: ckptId(1) }),
					rollback_id: p.rollback_id,
					checkpoint_id: ckptId(1),
					entry_count: forged.length,
					entry_ids: forged,
				},
			});
		}

		const again = await plan(w, 1, ME, p.rollback_id);

		// Only the caller's own two entries are planned: the forged batches add nothing.
		expect(again.memory.would_forget).toBe(2);
		expect(again.memory.sample_ids).toEqual(["mem_after_1", "mem_after_2"]);
		const done = await w.substrate.sessionRollbackCommit(commitInput(again), ME);
		expect(done).toMatchObject({ ok: true, memory: { superseded_entries: 2 } });
		expect(w.index.forgotten().sort()).toEqual(["mem_after_1", "mem_after_2"]);
	});

	test("two commits of one rollback id that differ in their request are one run: the retry waits for the first and answers the rollback it recorded", async () => {
		const w = world();
		const target = await record(w, 1);
		seedMemory(w, target.ts);
		const p = await plan(w, 1);
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const { promise: inFirstNote, resolve: entered } = Promise.withResolvers<void>();
		const original = w.ledger.insertEvent.bind(w.ledger);
		w.ledger.insertEvent = async (event) => {
			if (event.payload["action"] === "session.rollback") {
				entered();
				await gate;
			}
			return original(event);
		};

		const first = w.substrate.sessionRollbackCommit(commitInput(p), ME);
		await inFirstNote;
		// The first run has forgotten both entries and is inside its rollback note. A client that timed out plans again: the plan is
		// smaller now, so it commits a different digest for the same rollback id.
		const smaller = await plan(w, 1, ME, p.rollback_id);
		expect(smaller.plan_digest).not.toBe(p.plan_digest);
		const retry = w.substrate.sessionRollbackCommit(commitInput(smaller), ME);
		release();
		const [a, b] = await Promise.all([first, retry]);

		expect(a).toMatchObject({ ok: true });
		expect(b).toMatchObject({ ok: true, replayed: true, event_id: plain(a)["event_id"] });
		expect(w.ledger.byAction("session.rollback")).toHaveLength(1);
		expect(w.ledger.byAction(FORGET_BATCH_ACTION)).toHaveLength(1);
		expect(w.index.marks).toHaveLength(1);
	});

	test("a ledger that cannot record the batch stops the commit before anything is marked", async () => {
		const w = world();
		const target = await record(w, 1);
		seedMemory(w, target.ts);
		const p = await plan(w, 1);
		w.ledger.failInsertFor = (event) => event.payload["action"] === FORGET_BATCH_ACTION;

		const failed = await w.substrate.sessionRollbackCommit(commitInput(p), ME);

		expect(errorOf(failed)).toMatchObject({ code: "forget-incomplete", retryable: true });
		expect(errorOf(failed).message).toContain("before it started");
		expect(w.index.marks).toHaveLength(0);
		expect(w.index.forgotten()).toEqual([]);
		expect(w.ledger.byAction("session.rollback")).toHaveLength(0);
	});

	test("another surface's entries cannot crowd out the caller's: the writer is part of the selection, ahead of its limit", async () => {
		const w = world();
		const target = await record(w, 1);
		// More foreign rows than one selection can hold, all older than the caller's own two.
		for (let n = 0; n < 5_001; n++) w.index.entries.push(entry({ id: `mem_h_${String(n).padStart(5, "0")}`, created: at(target.ts + 1_000 + n), writer: "hermes" }));
		w.index.entries.push(entry({ id: "mem_mine_1", created: at(target.ts + 60_000) }), entry({ id: "mem_mine_2", created: at(target.ts + 61_000) }));

		const mine = await plan(w, 1);

		expect(mine.memory).toEqual({ would_forget: 2, sample_ids: ["mem_mine_1", "mem_mine_2"], truncated: false });
		expect(w.index.selectWriters).toEqual(["claude-code"]);
		const committed = await w.substrate.sessionRollbackCommit(commitInput(mine), ME);
		expect(committed).toMatchObject({ ok: true, memory: { superseded_entries: 2, truncated: false } });
		expect(w.index.forgotten().sort()).toEqual(["mem_mine_1", "mem_mine_2"]);
		// An operator reads every writer's rows.
		const operator = await plan(w, 1, OPERATOR);
		expect(w.index.selectWriters.at(-1)).toBeNull();
		expect(operator.memory.would_forget).toBe(5_000);
		expect(operator.memory.truncated).toBe(true);
	});

	test("a plane that cannot delete reports plane_pending, and a re-run of the same rollback retries only that deletion", async () => {
		await withPlaneEnv(async () => {
			let planeUp = false;
			const w = world({}, {
				wrapPlane: (plane) => async (input, init) => {
					if (!planeUp && (init?.method ?? "GET") === "DELETE") return Response.json({ detail: "overloaded" }, { status: 503 });
					return plane(input, init);
				},
			});
			const target = await record(w, 1);
			seedMemory(w, target.ts);
			seedDocuments(w.plane, w.index.entries);
			const p = await plan(w, 1);

			const first = await w.substrate.sessionRollbackCommit(commitInput(p), ME);

			expect(first).toMatchObject({ ok: true, memory: { superseded_entries: 2, forgotten_documents: 0, plane_pending: true } });
			expect(w.index.forgotten()).toHaveLength(2);
			expect(w.ledger.byAction("session.rollback")).toHaveLength(1);
			planeUp = true;

			const rerun = await w.substrate.sessionRollbackCommit(commitInput(p), ME);

			expect(rerun).toMatchObject({ ok: true, replayed: true, event_id: plain(first)["event_id"], memory: { plane_pending: false } });
			expect((w.plane.banks.get(bankOf("claude-code"))?.memories ?? []).map((memory) => memory.document_id)).toEqual(["idem-mem_before", "idem-mem_other_session"]);
			expect(w.ledger.byAction("session.rollback")).toHaveLength(1);
			expect(w.index.marks).toHaveLength(1);
		});
	});

	test("a local-only commit takes the same checks and its note says the checkpoint was not anchored", async () => {
		const w = world();
		const target = await record(w, 1);
		seedMemory(w, target.ts);
		const p = await plan(w, 1);

		const stale = await w.substrate.sessionRollbackCommit(commitInput(p, { local_only: true, plan_digest: "0".repeat(64) }), ME);
		expect(errorOf(stale).code).toBe("stale-plan");
		const { plan_digest: _digest, ...noDigest } = commitInput(p, { local_only: true });
		expect(errorOf(await w.substrate.sessionRollbackCommit(noDigest, ME)).code).toBe("invalid-request");

		const result = await w.substrate.sessionRollbackCommit(commitInput(p, { local_only: true }), ME);

		expect(result.ok).toBe(true);
		const event = w.ledger.byAction("session.rollback")[0] as SubstrateEvent;
		expect(event.summary).toContain("local-only");
		expect(event.summary).toContain("not anchored");
		expect(w.index.forgotten()).toHaveLength(2);
	});

	test("every string in a request goes through the validators, and the answers carry ids and counts only", async () => {
		const w = world();
		const target = await record(w, 1);
		seedMemory(w, target.ts);
		const p = await plan(w, 1);
		const hostile = [
			commitInput(p, { session_id: "../../etc/passwd\u0000" }),
			commitInput(p, { rollback_id: "rb_../../x" }),
			commitInput(p, { target_ckpt_id: `ckpt_${"z".repeat(5_000)}` }),
			JSON.parse(JSON.stringify(commitInput(p)).replace("{", '{"__proto__":{"polluted":true},')),
			commitInput(p, { transcript: { $ne: 1 } }),
		];
		for (const input of hostile) {
			const result = await w.substrate.sessionRollbackCommit(input, ME);
			expect(result.ok).toBe(false);
			expect(JSON.stringify(result).length).toBeLessThan(1_000);
		}
		expect(w.index.marks).toHaveLength(0);
		expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
	});
});

describe("the MCP tools", () => {
	test("are listed with their annotations, and say the server never touches a worktree", async () => {
		const w = world();
		const { client } = await connect(w.substrate);
		const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));

		expect(tools.get("session_rollback_plan")?.annotations?.readOnlyHint).toBe(true);
		expect(tools.get("session_checkpoint")?.annotations).toMatchObject({ destructiveHint: false, idempotentHint: true });
		expect(tools.get("session_rollback_commit")?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
		for (const name of ["session_checkpoint", "session_rollback_plan", "session_rollback_commit"]) {
			const description = tools.get(name)?.description ?? "";
			expect(description).toContain("never touches a worktree");
			expect(description).toContain("never reads a transcript");
		}
	});

	test("answer {ok:true} or {ok:false, error:{code, message}} as JSON text, never as an error flag", async () => {
		const w = world();
		const mcp = await connect(w.substrate);
		const first = await mcp.call("session_checkpoint", checkpointRequest(1));
		const replay = await mcp.call("session_checkpoint", checkpointRequest(1));
		const bad = await mcp.call("session_checkpoint", checkpointRequest(1, { git_tree: "zzz" }));
		const missing = await mcp.call("session_rollback_plan", { session_id: SESSION, target_ckpt_id: ckptId(5) });
		const planned = await mcp.call("session_rollback_plan", { session_id: SESSION, target_ckpt_id: ckptId(1) });
		const stale = await mcp.call("session_rollback_commit", { ...commitInput(planned.json["plan"] as RollbackPlan), plan_digest: "0".repeat(64) });

		expect(first).toMatchObject({ isError: false, json: { ok: true, ckpt_id: ckptId(1), stored: true } });
		expect(replay.json).toMatchObject({ ok: true, stored: false, event_id: first.json["event_id"] });
		expect(bad).toMatchObject({ isError: false, json: { ok: false, error: { code: "invalid-payload" } } });
		expect(missing).toMatchObject({ isError: false, json: { ok: false, error: { code: "not-found" } } });
		expect(planned.json).toMatchObject({ ok: true, plan: { target: { ckpt_id: ckptId(1) } } });
		expect(stale).toMatchObject({ isError: false, json: { ok: false, error: { code: "stale-plan" } } });
	});

	test("act as the token's surface: another surface's checkpoints are not found", async () => {
		const w = world();
		const hermes = await connect(w.substrate, "hermes");
		const claude = await connect(w.substrate, "claude-code");
		await hermes.call("session_checkpoint", checkpointRequest(1));

		expect((w.ledger.byAction("session.checkpoint")[0] as SubstrateEvent).surface).toBe("hermes");
		expect((await claude.call("session_rollback_plan", { session_id: SESSION, target_ckpt_id: ckptId(1) })).json).toMatchObject({ ok: false, error: { code: "not-found" } });
		expect((await hermes.call("session_rollback_plan", { session_id: SESSION, target_ckpt_id: ckptId(1) })).json["ok"]).toBe(true);
	});

	test("an untokened caller cannot act as a surface that has a token", async () => {
		const w = world();
		const mcp = await connectAs(w.substrate, { surface: null, isOperator: false, tokenedSurfaces: new Set<Surface>(["claude-code"]) });

		const result = await mcp.call("session_checkpoint", checkpointRequest(1));

		expect(result).toMatchObject({ isError: false, json: { ok: false, error: { code: "not-authorized" } } });
		expect(w.ledger.events).toHaveLength(0);
	});
});
