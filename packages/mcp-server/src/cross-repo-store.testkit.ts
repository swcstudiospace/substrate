/**
 * One set of cases for every `CrossRepoStore` adapter. `cross-repo-store.test.ts` runs it against the in-memory adapter and
 * `cross-repo-store.pg.test.ts` against Postgres (skipped without `SUBSTRATE_TEST_PG_URL`), so the fake cannot drift from the
 * SQL. Call it inside a `describe`; the cases register themselves with `test`.
 *
 * Every case names its own keys through the harness, so a run against a shared database never reads a row another case wrote.
 */
import { expect, test } from "bun:test";
import type { CrossRepoStore, NewCrossRepoOperation } from "./cross-repo-ops.ts";

export interface StoreHarness {
	store: CrossRepoStore;
	/** An operation key unique to this run and to `label`. */
	key(label: string): string;
}

const AT = new Date("2026-05-01T00:00:00.000Z");
const LATER = new Date("2026-05-01T00:05:00.000Z");

function newOperation(key: string, fingerprint = `fp-${key}`): NewCrossRepoOperation {
	return {
		key,
		fingerprint,
		branch: "feature/x",
		steps: [
			{ index: 0, repo: "owner/a", base: "main", plannedSha: "a".repeat(40) },
			{ index: 1, repo: "owner/b", base: "release", plannedSha: "b".repeat(40) },
		],
		at: AT,
	};
}

export function crossRepoStoreContract(harness: () => StoreHarness): void {
	test("create stores the operation running, with every step pending in index order", async () => {
		const { store, key } = harness();
		const k = key("create");
		const created = await store.create(newOperation(k));
		expect(created.inserted).toBe(true);
		expect(created.operation).toEqual({
			key: k,
			fingerprint: `fp-${k}`,
			branch: "feature/x",
			status: "running",
			createdAt: AT.toISOString(),
			updatedAt: AT.toISOString(),
			steps: [
				{ index: 0, repo: "owner/a", base: "main", plannedSha: "a".repeat(40), state: "pending", detail: null, updatedAt: AT.toISOString() },
				{ index: 1, repo: "owner/b", base: "release", plannedSha: "b".repeat(40), state: "pending", detail: null, updatedAt: AT.toISOString() },
			],
		});
	});

	test("create under a stored key returns the stored operation and stores nothing new", async () => {
		const { store, key } = harness();
		const k = key("dedupe");
		await store.create(newOperation(k, "first"));
		const again = await store.create({ ...newOperation(k, "second"), branch: "other" });
		expect(again.inserted).toBe(false);
		expect(again.operation.fingerprint).toBe("first");
		expect(again.operation.branch).toBe("feature/x");
	});

	test("load returns null for a key that was never created", async () => {
		const { store, key } = harness();
		expect(await store.load(key("absent"))).toBeNull();
	});

	test("moveStep moves a step only from a state the caller names, and reports whether it moved", async () => {
		const { store, key } = harness();
		const k = key("cas");
		await store.create(newOperation(k));
		expect(await store.moveStep(k, 0, ["pending"], "applying", null, AT)).toBe(true);
		expect(await store.moveStep(k, 0, ["pending"], "applying", null, AT)).toBe(false);
		expect((await store.load(k))?.steps[0]?.state).toBe("applying");
	});

	test("a detail is stored with its step and cleared by the next move that passes null", async () => {
		const { store, key } = harness();
		const k = key("detail");
		await store.create(newOperation(k));
		await store.moveStep(k, 1, ["pending"], "applying", null, AT);
		expect(await store.moveStep(k, 1, ["applying"], "parked", "apply-unknown", LATER)).toBe(true);
		expect((await store.load(k))?.steps[1]).toMatchObject({ state: "parked", detail: "apply-unknown", updatedAt: LATER.toISOString() });
		expect(await store.moveStep(k, 1, ["parked"], "compensating", null, LATER)).toBe(true);
		expect((await store.load(k))?.steps[1]).toMatchObject({ state: "compensating", detail: null });
	});

	test("moveStep for a step index the operation does not have is false and writes nothing", async () => {
		const { store, key } = harness();
		const k = key("no-step");
		await store.create(newOperation(k));
		expect(await store.moveStep(k, 7, ["pending"], "applying", null, AT)).toBe(false);
		expect((await store.load(k))?.steps.map((step) => step.state)).toEqual(["pending", "pending"]);
	});

	test("setStatus stores the status and the time it was set", async () => {
		const { store, key } = harness();
		const k = key("status");
		await store.create(newOperation(k));
		await store.setStatus(k, "needs-attention", LATER);
		expect(await store.load(k)).toMatchObject({ status: "needs-attention", updatedAt: LATER.toISOString() });
	});

	test("setStatus for a key that was never created is an error, not a silent no-op", async () => {
		const { store, key } = harness();
		await expect(store.setStatus(key("missing"), "done", AT)).rejects.toThrow();
	});
}
