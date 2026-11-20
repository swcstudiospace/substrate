import { describe, expect, test } from "bun:test";
import { acknowledgeFingerprint, keyedDirectiveId, queueFingerprint, SteeringIdempotency, STEERING_IDEMPOTENCY_MAX_ENTRIES } from "./steering-idempotency.ts";

/** The grammar the inbox accepts for a directive id (steering.ts). */
const DIRECTIVE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const QUEUE = { action: "pause", priority: "normal", targetSessionId: "sess-a", body: "stop", planRef: null, conflictsWithActivePlan: false };

describe("keyed directive id", () => {
	test("is stable for one key from one surface, and differs across keys and surfaces", () => {
		expect(keyedDirectiveId("omp", "key-0001")).toBe(keyedDirectiveId("omp", "key-0001"));
		expect(keyedDirectiveId("omp", "key-0001")).not.toBe(keyedDirectiveId("omp", "key-0002"));
		expect(keyedDirectiveId("omp", "key-0001")).not.toBe(keyedDirectiveId("cursor", "key-0001"));
	});

	test("fits the directive id grammar the inbox accepts", () => {
		expect(keyedDirectiveId("omp", "key-0001")).toMatch(DIRECTIVE_ID_RE);
		expect(keyedDirectiveId("omp", "key-0001")).toMatch(/^idem-[a-f0-9]{64}$/);
	});
});

describe("request fingerprints", () => {
	test("equal requests share a queue fingerprint; any field change separates them", () => {
		const base = queueFingerprint(QUEUE);
		expect(queueFingerprint({ ...QUEUE })).toBe(base);
		for (const changed of [
			{ action: "redirect" },
			{ priority: "high" },
			{ targetSessionId: "sess-b" },
			{ body: "go" },
			{ planRef: { phase: "1", plan: "1-01" } },
			{ conflictsWithActivePlan: true },
		]) {
			expect(queueFingerprint({ ...QUEUE, ...changed })).not.toBe(base);
		}
	});

	test("an acknowledgement fingerprint covers the directive, session, outcome and confirm flag", () => {
		const base = { directiveId: "d1", sessionId: "s1", outcome: "applied", confirmed: false };
		const same = acknowledgeFingerprint(base);
		expect(acknowledgeFingerprint({ ...base })).toBe(same);
		expect(acknowledgeFingerprint({ ...base, outcome: "declined" })).not.toBe(same);
		expect(acknowledgeFingerprint({ ...base, confirmed: true })).not.toBe(same);
		expect(acknowledgeFingerprint({ ...base, directiveId: "d2" })).not.toBe(same);
		expect(acknowledgeFingerprint({ ...base, sessionId: "s2" })).not.toBe(same);
	});
});

describe("SteeringIdempotency", () => {
	test("remembers a reply and recalls a copy: changing the copy changes nothing", () => {
		const index = new SteeringIdempotency<{ n: number }>();
		index.remember("omp", "key-0001", "fp", { n: 1 });
		const first = index.recall("omp", "key-0001");
		expect(first).toEqual({ fingerprint: "fp", reply: { n: 1 } });
		if (first !== null) first.reply.n = 99;
		expect(index.recall("omp", "key-0001")?.reply).toEqual({ n: 1 });
	});

	test("a key is scoped by surface", () => {
		const index = new SteeringIdempotency<string>();
		index.remember("omp", "key-0001", "fp", "x");
		expect(index.recall("cursor", "key-0001")).toBeNull();
	});

	test("evicts the oldest reply past the bound, and re-keeping a key refreshes its place", () => {
		const index = new SteeringIdempotency<number>(2);
		index.remember("omp", "a-key-0001", "fp", 1);
		index.remember("omp", "b-key-0001", "fp", 2);
		index.remember("omp", "a-key-0001", "fp", 3);
		index.remember("omp", "c-key-0001", "fp", 4);
		expect(index.recall("omp", "a-key-0001")?.reply).toBe(3);
		expect(index.recall("omp", "b-key-0001")).toBeNull();
		expect(index.recall("omp", "c-key-0001")?.reply).toBe(4);
	});

	test("refuses a non-positive bound and the default bound is ten thousand", () => {
		expect(() => new SteeringIdempotency(0)).toThrow(RangeError);
		expect(STEERING_IDEMPOTENCY_MAX_ENTRIES).toBe(10_000);
	});

	test("runs bodies for one key one after another, and a failed body does not wedge the next", async () => {
		const index = new SteeringIdempotency<string>();
		const order: string[] = [];
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const slow = index.serialize("omp", "key-0001", async () => {
			order.push("slow:start");
			await gate;
			order.push("slow:end");
			return "slow";
		});
		const failing = index.serialize("omp", "key-0001", async () => {
			order.push("fail");
			throw new Error("boom");
		});
		const after = index.serialize("omp", "key-0001", async () => {
			order.push("after");
			return "after";
		});
		const other = index.serialize("omp", "key-0002", async () => {
			order.push("other");
			return "other";
		});
		expect(await other).toBe("other");
		release();
		expect(await slow).toBe("slow");
		await expect(failing).rejects.toThrow("boom");
		expect(await after).toBe("after");
		expect(order).toEqual(["slow:start", "other", "slow:end", "fail", "after"]);
	});
});
