/**
 * Crash injection: the restore is stopped before every operation of a fixed plan (SimulatedCrash
 * leaves the journal and performs no rollback). The worktree must then be the pre-restore state
 * (crash before the first operation) or a partial state that recoverRestore completes to the target
 * idempotently, and the safety ref must restore the pre-restore state exactly.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RestoreFailedError, RestoreRecoveryRequiredError, SimulatedCrash, SnapshotPolicyError } from "./errors.ts";
import { planRestore } from "./plan.ts";
import { readPinnedSnapshot, snapshot } from "./snapshot.ts";
import { recoverRestore, restore } from "./restore.ts";
import { mutateToB, SCENARIO_POLICY, writeScenarioA } from "./scenario.ts";
import { cleanupTemp, expectWorktreeMatches, FIXED_NOW, fileStateHash, git, makeRepo } from "./testkit.ts";
import type { Snapshot } from "./types.ts";

afterAll(cleanupTemp);
setDefaultTimeout(300_000);

const opts = { policy: SCENARIO_POLICY, now: FIXED_NOW };
const journalPath = (dir: string): string => join(dir, ".git", "substrate-restore", "restore-journal.json");
const lockPath = (dir: string): string => join(dir, ".git", "substrate-restore.lock");

async function scenario(): Promise<{ dir: string; snapA: Snapshot; preTree: string; preState: string }> {
	const dir = makeRepo();
	writeScenarioA(dir);
	const snapA = await snapshot({ worktree: dir, ...opts });
	mutateToB(dir);
	const pre = await snapshot({ worktree: dir, ...opts });
	return { dir, snapA, preTree: pre.tree, preState: fileStateHash(dir) };
}

const crashAt = (index: number) => ({
	beforeOp: (i: number): void => {
		if (i === index) throw new SimulatedCrash(`crash before operation ${index}`);
	},
});

describe("crash at every operation index", () => {
	test("is recoverable forward, and the safety ref restores the pre-restore state exactly", async () => {
		const { dir, snapA, preTree, preState } = await scenario();
		const planned = await planRestore({ worktree: dir, target: snapA, ...opts });
		const total = planned.operations.length;
		expect(total).toBeGreaterThan(8);

		for (let index = 0; index < total; index++) {
			const id = `crash-run-${String(index).padStart(3, "0")}`;
			const crashed = await restore({ worktree: dir, target: snapA, id, ...opts, hooks: crashAt(index) }).catch(
				(caught: unknown) => caught,
			);
			expect(crashed).toBeInstanceOf(SimulatedCrash);

			// The journal survives in state "applying"; the lock does not.
			const journal = JSON.parse(readFileSync(journalPath(dir), "utf8")) as { state: string; safetyTree: string; operations: unknown[] };
			expect(journal.state).toBe("applying");
			expect(journal.safetyTree).toBe(preTree);
			expect(journal.operations.length).toBe(total);
			expect(existsSync(lockPath(dir))).toBe(false);

			// Either nothing was applied yet, or the worktree is a partial state strictly between the two.
			const partial = (await snapshot({ worktree: dir, ...opts })).tree;
			expect(partial === preTree).toBe(index === 0);
			expect(partial).not.toBe(snapA.tree);

			// A new restore must not run on top of an interrupted one.
			await expect(restore({ worktree: dir, target: snapA, id: `${id}-again`, ...opts })).rejects.toBeInstanceOf(
				RestoreRecoveryRequiredError,
			);

			const recovered = await recoverRestore({ worktree: dir, now: FIXED_NOW });
			expect(recovered).toMatchObject({ recovered: true, direction: "forward", tree: snapA.tree, id });
			expect((await snapshot({ worktree: dir, ...opts })).tree).toBe(snapA.tree);
			expectWorktreeMatches(dir, snapA);
			expect(existsSync(journalPath(dir))).toBe(false);
			expect(existsSync(lockPath(dir))).toBe(false);
			expect(git(dir, ["for-each-ref", "--format=%(refname)", "refs/substrate/restore-target"]).trim()).toBe("");

			// The safety ref brings back the pre-restore state, byte for byte (and the next iteration starts from it).
			if (recovered.recovered === false) throw new Error("unreachable");
			const safety = await readPinnedSnapshot({ worktree: dir, ref: recovered.safetyRef, now: FIXED_NOW });
			expect(safety.tree).toBe(preTree);
			await restore({ worktree: dir, target: safety, id: `${id}-back`, ...opts });
			expect((await snapshot({ worktree: dir, ...opts })).tree).toBe(preTree);
			expect(fileStateHash(dir)).toBe(preState);
		}
	});
});

describe("recoverRestore", () => {
	test("returns recovered:false when there is no journal", async () => {
		const { dir } = await scenario();
		expect(await recoverRestore({ worktree: dir, now: FIXED_NOW })).toEqual({ recovered: false });
	});

	test("refuses a malformed journal", async () => {
		const { dir } = await scenario();
		mkdirSync(join(dir, ".git", "substrate-restore"), { recursive: true });
		writeFileSync(journalPath(dir), "not json");
		await expect(recoverRestore({ worktree: dir, now: FIXED_NOW })).rejects.toBeInstanceOf(SnapshotPolicyError);
		writeFileSync(journalPath(dir), JSON.stringify({ version: 1, state: "applying" }));
		await expect(recoverRestore({ worktree: dir, now: FIXED_NOW })).rejects.toBeInstanceOf(SnapshotPolicyError);
		expect(existsSync(journalPath(dir))).toBe(true);
	});

	test("removes the temporary file a crash left next to a destination", async () => {
		const { dir, snapA } = await scenario();
		const planned = await planRestore({ worktree: dir, target: snapA, ...opts });
		const index = planned.operations.findIndex((operation) => operation.path === "README.md");
		expect(index).toBeGreaterThanOrEqual(0);
		const id = "crash-temp-0001";
		await expect(restore({ worktree: dir, target: snapA, id, ...opts, hooks: crashAt(index) })).rejects.toBeInstanceOf(
			SimulatedCrash,
		);
		const junk = join(dir, `README.md.substrate-${id}.tmp`);
		writeFileSync(junk, "half written");

		await recoverRestore({ worktree: dir, now: FIXED_NOW });

		expect(existsSync(junk)).toBe(false);
		expect((await snapshot({ worktree: dir, ...opts })).tree).toBe(snapA.tree);
	});

	test("completes an interrupted rollback when the journal state is rolling-back", async () => {
		const { dir, snapA, preTree, preState } = await scenario();
		await expect(
			restore({ worktree: dir, target: snapA, id: "crash-roll-0001", ...opts, hooks: crashAt(4) }),
		).rejects.toBeInstanceOf(SimulatedCrash);
		const journal = JSON.parse(readFileSync(journalPath(dir), "utf8")) as Record<string, unknown>;
		writeFileSync(journalPath(dir), JSON.stringify({ ...journal, state: "rolling-back" }));

		const recovered = await recoverRestore({ worktree: dir, now: FIXED_NOW });

		expect(recovered).toMatchObject({ recovered: true, direction: "rollback", tree: preTree });
		expect((await snapshot({ worktree: dir, ...opts })).tree).toBe(preTree);
		expect(fileStateHash(dir)).toBe(preState);
		expect(existsSync(journalPath(dir))).toBe(false);
	});

	test("a handled failure while recovering rolls back to the safety snapshot", async () => {
		const { dir, snapA, preTree, preState } = await scenario();
		await expect(
			restore({ worktree: dir, target: snapA, id: "crash-fail-0001", ...opts, hooks: crashAt(5) }),
		).rejects.toBeInstanceOf(SimulatedCrash);

		const error = await recoverRestore({
			worktree: dir,
			now: FIXED_NOW,
			hooks: {
				beforeOp: (index) => {
					if (index === 1) throw new Error("recovery failed on purpose");
				},
			},
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(RestoreFailedError);
		expect((error as RestoreFailedError).rolledBack).toBe(true);
		expect((await snapshot({ worktree: dir, ...opts })).tree).toBe(preTree);
		expect(fileStateHash(dir)).toBe(preState);
		expect(existsSync(journalPath(dir))).toBe(false);
	});

	test("a crash during recovery keeps the journal and a second recovery finishes the job", async () => {
		const { dir, snapA } = await scenario();
		await expect(
			restore({ worktree: dir, target: snapA, id: "crash-twice-001", ...opts, hooks: crashAt(2) }),
		).rejects.toBeInstanceOf(SimulatedCrash);
		await expect(recoverRestore({ worktree: dir, now: FIXED_NOW, hooks: crashAt(3) })).rejects.toBeInstanceOf(SimulatedCrash);
		expect(existsSync(journalPath(dir))).toBe(true);

		const recovered = await recoverRestore({ worktree: dir, now: FIXED_NOW });

		expect(recovered).toMatchObject({ recovered: true, direction: "forward", tree: snapA.tree });
		expect((await snapshot({ worktree: dir, ...opts })).tree).toBe(snapA.tree);
		expectWorktreeMatches(dir, snapA);
	});
});
