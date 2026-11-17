/**
 * The checkpoint trigger policy as a table: every trigger, the rate-limit boundary, the unchanged-tree skip,
 * steering dedupe and the baseline-once rule. Pure: numbers in, a decision out.
 */
import { describe, expect, test } from "bun:test";
import {
	CHECKPOINT_HOOK_TRIGGERS,
	HOOK_TRIGGERS,
	PLAN_STEP_MIN_INTERVAL_MS,
	type PolicyCheckpoint,
	TURN_MIN_INTERVAL_MS,
	directiveKey,
	shouldCheckpoint,
} from "./trigger-policy.ts";

const NOW = 1_800_000_000_000;
const TREE_A = "a".repeat(40);
const TREE_B = "b".repeat(40);

const at = (agoMs: number, over: Partial<PolicyCheckpoint> = {}): PolicyCheckpoint => ({ treeId: TREE_A, takenAtMs: NOW - agoMs, ...over });

describe("the defaults", () => {
	test("the documented limits", () => {
		expect(TURN_MIN_INTERVAL_MS).toBe(60_000);
		expect(PLAN_STEP_MIN_INTERVAL_MS).toBe(10_000);
		expect([...CHECKPOINT_HOOK_TRIGGERS]).toEqual(["turn", "plan-step", "steering", "baseline"]);
		// `context` is a hook trigger that prints a digest; it is never a checkpoint trigger, so the policy has no row for it.
		expect([...HOOK_TRIGGERS]).toEqual([...CHECKPOINT_HOOK_TRIGGERS, "context"]);
	});
});

describe("manual and pre-restore are always taken", () => {
	for (const trigger of ["manual", "pre-restore"] as const) {
		test(`${trigger}: taken even when the tree is unchanged and a checkpoint was just made`, () => {
			expect(shouldCheckpoint({ trigger, nowMs: NOW, last: at(0), lastOfTrigger: at(0, { trigger }), currentTreeId: TREE_A }).take).toBe(true);
		});
	}
});

describe("baseline is taken once", () => {
	test("taken when the session has no checkpoint", () => {
		expect(shouldCheckpoint({ trigger: "baseline", nowMs: NOW })).toEqual({ take: true, reason: "baseline: the session has no checkpoint yet" });
	});
	test("skipped when the session already has any checkpoint, however old", () => {
		const decision = shouldCheckpoint({ trigger: "baseline", nowMs: NOW, last: at(86_400_000, { trigger: "manual" }), currentTreeId: TREE_B });
		expect(decision).toEqual({ take: false, reason: "baseline: the session already has a checkpoint" });
	});
});

describe("turn: one per minute", () => {
	test("the first turn is taken", () => {
		expect(shouldCheckpoint({ trigger: "turn", nowMs: NOW }).take).toBe(true);
	});
	test("one millisecond short of the interval is skipped", () => {
		const decision = shouldCheckpoint({ trigger: "turn", nowMs: NOW, last: at(59_999, { trigger: "turn" }), lastOfTrigger: at(59_999, { trigger: "turn" }), currentTreeId: TREE_B });
		expect(decision.take).toBe(false);
		expect(decision.reason).toContain("rate limited");
		expect(decision.reason).toContain("59999 ms");
	});
	test("exactly the interval is taken", () => {
		const last = at(60_000, { trigger: "turn" });
		expect(shouldCheckpoint({ trigger: "turn", nowMs: NOW, last, lastOfTrigger: last, currentTreeId: TREE_B }).take).toBe(true);
	});
	test("the limit counts turn checkpoints only: a recent manual checkpoint does not suppress a turn", () => {
		const decision = shouldCheckpoint({
			trigger: "turn",
			nowMs: NOW,
			last: at(1_000, { trigger: "manual", treeId: TREE_A }),
			lastOfTrigger: at(300_000, { trigger: "turn" }),
			currentTreeId: TREE_B,
		});
		expect(decision.take).toBe(true);
	});
	test("with no lastOfTrigger, a recent last of another trigger does not rate-limit", () => {
		expect(shouldCheckpoint({ trigger: "turn", nowMs: NOW, last: at(1_000, { trigger: "plan-step" }), currentTreeId: TREE_B }).take).toBe(true);
	});
	test("with no lastOfTrigger, a recent last of the same (or unknown) trigger rate-limits", () => {
		expect(shouldCheckpoint({ trigger: "turn", nowMs: NOW, last: at(1_000, { trigger: "turn" }), currentTreeId: TREE_B }).take).toBe(false);
		expect(shouldCheckpoint({ trigger: "turn", nowMs: NOW, last: at(1_000), currentTreeId: TREE_B }).take).toBe(false);
	});
	test("a checkpoint with no recorded time cannot rate-limit", () => {
		expect(shouldCheckpoint({ trigger: "turn", nowMs: NOW, last: { treeId: TREE_A, trigger: "turn" }, currentTreeId: TREE_B }).take).toBe(true);
	});
	test("a clock that moved backwards does not suppress", () => {
		expect(shouldCheckpoint({ trigger: "turn", nowMs: NOW, last: at(-5_000, { trigger: "turn" }), currentTreeId: TREE_B }).take).toBe(true);
	});
	test("minIntervalMs replaces the default; a nonsense value falls back to it", () => {
		const last = at(5_000, { trigger: "turn" });
		expect(shouldCheckpoint({ trigger: "turn", nowMs: NOW, last, minIntervalMs: 5_000, currentTreeId: TREE_B }).take).toBe(true);
		expect(shouldCheckpoint({ trigger: "turn", nowMs: NOW, last, minIntervalMs: 5_001, currentTreeId: TREE_B }).take).toBe(false);
		expect(shouldCheckpoint({ trigger: "turn", nowMs: NOW, last, minIntervalMs: Number.NaN, currentTreeId: TREE_B }).take).toBe(false);
		expect(shouldCheckpoint({ trigger: "turn", nowMs: NOW, last, minIntervalMs: -1, currentTreeId: TREE_B }).take).toBe(false);
	});
});

describe("plan-step: one per ten seconds", () => {
	test("9999 ms is skipped, 10000 ms is taken", () => {
		const recent = at(9_999, { trigger: "plan-step" });
		const due = at(10_000, { trigger: "plan-step" });
		expect(shouldCheckpoint({ trigger: "plan-step", nowMs: NOW, last: recent, lastOfTrigger: recent, currentTreeId: TREE_B }).take).toBe(false);
		expect(shouldCheckpoint({ trigger: "plan-step", nowMs: NOW, last: due, lastOfTrigger: due, currentTreeId: TREE_B }).take).toBe(true);
	});
	test("a turn limit does not apply: 30 s after the last plan step is taken", () => {
		const last = at(30_000, { trigger: "plan-step" });
		expect(shouldCheckpoint({ trigger: "plan-step", nowMs: NOW, last, lastOfTrigger: last, currentTreeId: TREE_B }).take).toBe(true);
	});
});

describe("steering: one per directive, otherwise unlimited", () => {
	const key = directiveKey("dir-1");
	test("a directive already checkpointed is skipped", () => {
		const decision = shouldCheckpoint({ trigger: "steering", nowMs: NOW, directiveKey: key, seenDirectiveKeys: new Set([key]), currentTreeId: TREE_B });
		expect(decision).toEqual({ take: false, reason: "steering: this directive already has a checkpoint" });
	});
	test("a different directive is taken immediately after another one", () => {
		const last = at(0, { trigger: "steering" });
		const decision = shouldCheckpoint({
			trigger: "steering",
			nowMs: NOW,
			last,
			lastOfTrigger: last,
			directiveKey: directiveKey("dir-2"),
			seenDirectiveKeys: new Set([key]),
			currentTreeId: TREE_B,
		});
		expect(decision.take).toBe(true);
	});
	test("with no directive id there is nothing to dedupe on: taken", () => {
		expect(shouldCheckpoint({ trigger: "steering", nowMs: NOW, seenDirectiveKeys: new Set([key]) }).take).toBe(true);
	});
	test("an unchanged tree still skips a new directive", () => {
		const decision = shouldCheckpoint({ trigger: "steering", nowMs: NOW, last: at(0), directiveKey: directiveKey("dir-3"), currentTreeId: TREE_A });
		expect(decision.take).toBe(false);
		expect(decision.reason).toContain("unchanged");
	});
});

describe("an unchanged tree skips every automatic trigger", () => {
	for (const trigger of ["turn", "plan-step", "steering"] as const) {
		test(`${trigger}: same tree id as the last checkpoint is skipped, a different one is taken`, () => {
			const last = at(10 * 60_000, { trigger: "manual", treeId: TREE_A });
			expect(shouldCheckpoint({ trigger, nowMs: NOW, last, currentTreeId: TREE_A })).toEqual({
				take: false,
				reason: `${trigger}: the worktree is unchanged since the last checkpoint`,
			});
			expect(shouldCheckpoint({ trigger, nowMs: NOW, last, currentTreeId: TREE_B }).take).toBe(true);
		});
	}
	test("without currentTreeId only the cheap rules run, so an unchanged tree is not yet known", () => {
		expect(shouldCheckpoint({ trigger: "turn", nowMs: NOW, last: at(10 * 60_000) }).take).toBe(true);
	});
	test("a session with no checkpoint has no tree to compare", () => {
		expect(shouldCheckpoint({ trigger: "turn", nowMs: NOW, currentTreeId: TREE_A }).take).toBe(true);
	});
});

describe("directiveKey", () => {
	test("is the id behind a prefix when it fits the 64-character limit", () => {
		expect(directiveKey("dir-1")).toBe("directive:dir-1");
		expect(directiveKey("x".repeat(54))).toHaveLength(64);
	});
	test("hashes an id that would not fit, deterministically and within the limit", () => {
		const long = "y".repeat(200);
		const key = directiveKey(long);
		expect(key).toMatch(/^directive:h\.[0-9a-f]{16}$/);
		expect(key.length).toBeLessThanOrEqual(64);
		expect(directiveKey(long)).toBe(key);
		expect(directiveKey(`${long}z`)).not.toBe(key);
	});
});
