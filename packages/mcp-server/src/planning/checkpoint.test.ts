/**
 * Completion checkpoints: the key covers phase, step and file hash; recording is idempotent; resume
 * skips completed steps and re-runs a step whose file changed without writing a duplicate record.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
	completionKey,
	InMemoryCompletionStore,
	planResume,
	recordCompletion,
	type CompletionRecord,
	type ResumeResult,
} from "./checkpoint.ts";

const PHASE = "53";
const STEP_A = "53-01-PLAN";
const STEP_B = "53-02-PLAN";
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);

function unwrap(result: ResumeResult) {
	if (!result.ok) throw new Error(`planResume failed: ${result.error.code}`);
	return result.plan;
}

describe("completionKey", () => {
	test("is the sha256 of the phase, step and file hash joined with newlines", () => {
		const expected = createHash("sha256").update(`${PHASE}\n${STEP_A}\n${HASH_1}`).digest("hex");
		expect(completionKey({ phase: PHASE, step: STEP_A, fileHash: HASH_1 })).toBe(expected);
	});

	test("the same inputs give the same key, and a changed file hash gives a different key", () => {
		const first = completionKey({ phase: PHASE, step: STEP_A, fileHash: HASH_1 });
		expect(completionKey({ phase: PHASE, step: STEP_A, fileHash: HASH_1 })).toBe(first);
		expect(completionKey({ phase: PHASE, step: STEP_A, fileHash: HASH_2 })).not.toBe(first);
	});
});

describe("recordCompletion", () => {
	test("recording the same completion twice leaves one record, and the second call reports exists", async () => {
		const store = new InMemoryCompletionStore();
		const input = { phase: PHASE, step: STEP_A, fileHash: HASH_1, recordedAtMs: 100 };

		const first = await recordCompletion(store, input);
		const second = await recordCompletion(store, { ...input, recordedAtMs: 999 });

		expect(first.outcome).toBe("inserted");
		expect(second).toEqual({ outcome: "exists", key: first.key });
		const stored = await store.list(PHASE);
		expect(stored).toHaveLength(1);
		expect(stored[0]?.recordedAtMs).toBe(100);
	});

	test("a malformed completion is refused before anything is written", async () => {
		const store = new InMemoryCompletionStore();
		await expect(
			recordCompletion(store, { phase: PHASE, step: STEP_A, fileHash: "not-a-hash", recordedAtMs: 1 }),
		).rejects.toThrow();
		expect(await store.list(PHASE)).toEqual([]);
	});
});

describe("planResume", () => {
	test("completed steps are skipped and the rest run, in order", async () => {
		const store = new InMemoryCompletionStore();
		await recordCompletion(store, { phase: PHASE, step: STEP_A, fileHash: HASH_1, recordedAtMs: 1 });

		const plan = unwrap(
			planResume({
				phase: PHASE,
				steps: [
					{ step: STEP_A, fileHash: HASH_1 },
					{ step: STEP_B, fileHash: HASH_1 },
				],
				lastCheckpoint: await store.list(PHASE),
			}),
		);

		expect(plan.completed.map((skip) => skip.step)).toEqual([STEP_A]);
		expect(plan.run).toEqual([
			{
				step: STEP_B,
				fileHash: HASH_1,
				key: completionKey({ phase: PHASE, step: STEP_B, fileHash: HASH_1 }),
				fileChanged: false,
			},
		]);
	});

	test("a step whose file hash changed re-runs and is flagged, and no duplicate completion record is written", async () => {
		const store = new InMemoryCompletionStore();
		await recordCompletion(store, { phase: PHASE, step: STEP_A, fileHash: HASH_1, recordedAtMs: 1 });

		// The file changed since the checkpoint.
		const resumed = unwrap(
			planResume({ phase: PHASE, steps: [{ step: STEP_A, fileHash: HASH_2 }], lastCheckpoint: await store.list(PHASE) }),
		);
		expect(resumed.completed).toEqual([]);
		expect(resumed.run).toEqual([
			{
				step: STEP_A,
				fileHash: HASH_2,
				key: completionKey({ phase: PHASE, step: STEP_A, fileHash: HASH_2 }),
				fileChanged: true,
			},
		]);

		// The executor runs the step and records it against the new hash, twice to prove idempotence.
		const first = await recordCompletion(store, { phase: PHASE, step: STEP_A, fileHash: HASH_2, recordedAtMs: 2 });
		const again = await recordCompletion(store, { phase: PHASE, step: STEP_A, fileHash: HASH_2, recordedAtMs: 3 });
		expect(first.outcome).toBe("inserted");
		expect(again.outcome).toBe("exists");

		const records = await store.list(PHASE);
		expect(records.filter((record) => record.fileHash === HASH_2)).toHaveLength(1);
		expect(records).toHaveLength(2);

		// On the next resume the step is complete against its current hash.
		const after = unwrap(planResume({ phase: PHASE, steps: [{ step: STEP_A, fileHash: HASH_2 }], lastCheckpoint: records }));
		expect(after.run).toEqual([]);
		expect(after.completed).toEqual([{ step: STEP_A, key: first.key }]);
	});

	test("a checkpoint for another phase does not complete a step here", async () => {
		const store = new InMemoryCompletionStore();
		await recordCompletion(store, { phase: "52", step: STEP_A, fileHash: HASH_1, recordedAtMs: 1 });
		const plan = unwrap(
			planResume({ phase: PHASE, steps: [{ step: STEP_A, fileHash: HASH_1 }], lastCheckpoint: await store.list("52") }),
		);
		expect(plan.completed).toEqual([]);
		expect(plan.run.map((run) => run.step)).toEqual([STEP_A]);
	});

	test("a checkpoint record whose key does not match its fields is refused", () => {
		const forged: CompletionRecord = {
			key: "f".repeat(64),
			phase: PHASE,
			step: STEP_A,
			fileHash: HASH_1,
			recordedAtMs: 1,
		};
		expect(planResume({ phase: PHASE, steps: [], lastCheckpoint: [forged] })).toEqual({
			ok: false,
			error: { code: "checkpoint-key-mismatch", key: forged.key },
		});
	});

	test("a step name listed twice is refused", () => {
		expect(
			planResume({
				phase: PHASE,
				steps: [
					{ step: STEP_A, fileHash: HASH_1 },
					{ step: STEP_A, fileHash: HASH_2 },
				],
				lastCheckpoint: [],
			}),
		).toEqual({ ok: false, error: { code: "duplicate-step", step: STEP_A } });
	});
});
