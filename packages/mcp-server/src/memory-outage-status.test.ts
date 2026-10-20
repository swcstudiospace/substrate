/**
 * A memory write that the substrate cannot persist is answered 503, end to end (uplift-7 gap 3).
 *
 * `server.test.ts` pins the status mapping on its own. These tests take the path a caller
 * takes: `Substrate.writeMemory`, which turns an index outage into a `denied` reply with a
 * `store.*` reason, then `memoryWriteStatus`, which turns that reason into the HTTP status.
 * A dependent client reads that status to tell "the index is down" from "you may not write
 * this". The outage must come back as 503, never as 403.
 */
import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { memoryWriteStatus } from "./server.ts";
import { Substrate } from "./service.ts";

const entry = { scope: "graph:ut-1", kind: "fact" as const, text: "hermes finished n2", writer: "hermes" };

describe("a memory write during a substrate outage is answered 503", () => {
	test("an index that refuses the claim is store.write-failed, and that is 503", async () => {
		const failing = {
			claimWrite: async () => {
				throw new Error("connect ETIMEDOUT");
			},
		};
		const substrate = new Substrate(loadConfig({}), { index: failing as never, greptime: null });

		const result = await substrate.writeMemory({ ...entry, idempotency_key: "k-503-refused" });

		expect(result.outcome).toBe("denied");
		expect(result.reason).toBe("store.write-failed");
		expect(result.verified_persisted).toBe(false);
		expect(memoryWriteStatus(result)).toBe(503);
	});

	test("no index at all is store.unavailable, and that is 503 and not 403", async () => {
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: null });

		const result = await substrate.writeMemory({ ...entry, idempotency_key: "k-503-unavailable" });

		expect(result.outcome).toBe("denied");
		expect(result.reason).toBe("store.unavailable");
		expect(result.verified_persisted).toBe(false);
		expect(memoryWriteStatus(result)).toBe(503);
	});

	test("a policy refusal with the index present is still 403, not 503", async () => {
		// RBAC is decided before the store is touched, so a writer with no grant is refused
		// without any store call. The status therefore names the policy, not the outage.
		const substrate = new Substrate(loadConfig({}), { index: {} as never, greptime: null });

		const refused = await substrate.writeMemory({ ...entry, writer: "unknown" });

		expect(refused.reason).toBe("rbac.no-grant");
		expect(memoryWriteStatus(refused)).toBe(403);
	});
});
