import { describe, expect, test } from "bun:test";
import { DeadlineError, sharedDeadline } from "./deadline.ts";
import { LIGHTRAG_EMPTY_ANSWER, type LightragSettled, retryableLightragFailure, runLightragAttempts, settleLightrag } from "./lightrag-attempts.ts";
import { LIGHTRAG_CIRCUIT_OPEN } from "./planes/lightrag.ts";

type Outcome = { ok: true } | { ok: false; reason: string; code?: string };

/** An attempt that plays its script one step per call; the last step repeats. An `Error` step rejects. */
function scripted(steps: readonly (Outcome | Error)[]): { calls: () => number; attempt: () => Promise<LightragSettled<Outcome>> } {
	let count = 0;
	return {
		calls: () => count,
		attempt: () => {
			const step = steps[Math.min(count, steps.length - 1)] ?? { ok: false, reason: "no script" };
			count += 1;
			return settleLightrag<Outcome>(step instanceof Error ? Promise.reject(step) : Promise.resolve(step));
		},
	};
}

const POLICY = { maxRetries: 2, retryBaseMs: 1 };

describe("runLightragAttempts: the one retry policy for every LightRAG query", () => {
	test("success after a retry: the retry's answer is the outcome, and the plane was asked twice", async () => {
		const script = scripted([{ ok: false, reason: "lightrag 503" }, { ok: true }]);
		const outcome = await runLightragAttempts(script.attempt, POLICY, sharedDeadline(0, "docs budget"));
		expect(outcome).toEqual({ status: "fulfilled", value: { ok: true } });
		expect(script.calls()).toBe(2);
	});

	test("the retry cap: a plane that never answers is asked the first attempt plus maxRetries, then the last failure stands", async () => {
		const script = scripted([{ ok: false, reason: "lightrag 500" }]);
		const outcome = await runLightragAttempts(script.attempt, POLICY, sharedDeadline(0, "docs budget"));
		expect(script.calls()).toBe(POLICY.maxRetries + 1);
		expect(outcome).toEqual({ status: "fulfilled", value: { ok: false, reason: "lightrag 500" } });
	});

	test("a breaker refusal and an empty answer are never retried, and neither is a spent budget", async () => {
		const refused: Outcome[] = [
			{ ok: false, reason: LIGHTRAG_CIRCUIT_OPEN },
			{ ok: false, reason: "lightrag: unexpected response shape", code: LIGHTRAG_EMPTY_ANSWER },
			{ ok: false, reason: LIGHTRAG_EMPTY_ANSWER },
		];
		for (const outcome of refused) {
			const script = scripted([outcome]);
			await runLightragAttempts(script.attempt, POLICY, sharedDeadline(0, "docs budget"));
			expect(script.calls()).toBe(1);
		}
		const spent = scripted([new DeadlineError(1, "docs budget")]);
		await runLightragAttempts(spent.attempt, POLICY, sharedDeadline(0, "docs budget"));
		expect(spent.calls()).toBe(1);
	});

	test("a zero-chunk answer is asked once, even when a retry would have answered", async () => {
		const script = scripted([{ ok: false, reason: "lightrag: unexpected response shape", code: LIGHTRAG_EMPTY_ANSWER }, { ok: true }]);
		const outcome = await runLightragAttempts(script.attempt, POLICY, sharedDeadline(0, "docs budget"));
		expect(script.calls()).toBe(1);
		expect(outcome).toEqual({ status: "fulfilled", value: { ok: false, reason: "lightrag: unexpected response shape", code: LIGHTRAG_EMPTY_ANSWER } });
	});

	test("a 500 and a timeout are real failures: each is retried under the policy", async () => {
		for (const reason of ["lightrag 500", "lightrag unreachable: The operation timed out."]) {
			const script = scripted([{ ok: false, reason }]);
			const outcome = await runLightragAttempts(script.attempt, POLICY, sharedDeadline(0, "docs budget"));
			expect(script.calls()).toBe(POLICY.maxRetries + 1);
			expect(outcome).toEqual({ status: "fulfilled", value: { ok: false, reason } });
		}
	});

	test("the total budget caps the chain: a backoff the budget ends starts no further attempt", async () => {
		const started = performance.now();
		const cap = sharedDeadline(50, "docs budget");
		const script = scripted([{ ok: false, reason: "lightrag 503" }]);
		try {
			await runLightragAttempts(script.attempt, { maxRetries: 2, retryBaseMs: 5_000 }, cap);
		} finally {
			cap.clear();
		}
		expect(script.calls()).toBe(1);
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	test("a rejected attempt is retried like a failure, unless it is the budget's own DeadlineError", () => {
		expect(retryableLightragFailure({ status: "rejected", reason: new Error("socket reset") })).toBe(true);
		expect(retryableLightragFailure({ status: "rejected", reason: new DeadlineError(1, "docs budget") })).toBe(false);
		expect(retryableLightragFailure({ status: "fulfilled", value: { ok: true } })).toBe(false);
		expect(retryableLightragFailure({ status: "fulfilled", value: { ok: false, reason: "lightrag 500" } })).toBe(true);
		expect(retryableLightragFailure({ status: "fulfilled", value: { ok: false, reason: "lightrag circuit open" } })).toBe(false);
		expect(retryableLightragFailure({ status: "fulfilled", value: { ok: false, reason: "lightrag: unexpected response shape", code: LIGHTRAG_EMPTY_ANSWER } })).toBe(false);
		expect(retryableLightragFailure({ status: "fulfilled", value: { ok: false, reason: "lightrag unreachable: The operation timed out." } })).toBe(true);
	});
});
