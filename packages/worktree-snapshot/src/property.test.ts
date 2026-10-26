/**
 * Randomised round trips with a seeded PRNG: random tree A, snapshot, replace the worktree with a
 * random tree B (file/directory/symlink/executable changes, including a path that is a directory in
 * one tree and a file in the other), restore A, and require the exact file state of A again.
 */
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { restore } from "./restore.ts";
import { planRestore } from "./plan.ts";
import { snapshot } from "./snapshot.ts";
import { cleanupTemp, dirHash, expectWorktreeMatches, FIXED_NOW, type FileSpec, makeRepo, seeded, writeFiles } from "./testkit.ts";

afterAll(cleanupTemp);
setDefaultTimeout(600_000);

const ITERATIONS = 60;
const NAMES = ["a", "b", "c", "d"];

function randomTree(rand: () => number): Record<string, FileSpec> {
	const pick = <T>(values: readonly T[]): T => values[Math.floor(rand() * values.length)] as T;
	const tree: Record<string, FileSpec> = {};
	const count = 2 + Math.floor(rand() * 9);
	for (let n = 0; n < count; n++) {
		const depth = 1 + Math.floor(rand() * 3);
		const path = Array.from({ length: depth }, () => pick(NAMES)).join("/");
		const clash = Object.keys(tree).some((other) => other === path || path.startsWith(`${other}/`) || other.startsWith(`${path}/`));
		if (clash) continue;
		const kind = rand();
		if (kind < 0.15) tree[path] = { link: `target-${Math.floor(rand() * 3)}` };
		else tree[path] = { content: `content-${Math.floor(rand() * 3)}\n`, exec: rand() < 0.2 };
	}
	return tree;
}

function clearWorktree(dir: string): void {
	for (const name of readdirSync(dir)) if (name !== ".git") rmSync(join(dir, name), { recursive: true, force: true });
}

test(`${ITERATIONS} seeded random trees restore to exactly their snapshot`, async () => {
	const dir = makeRepo();
	let typeConflicts = 0;
	let withDeletes = 0;
	for (let i = 0; i < ITERATIONS; i++) {
		const rand = seeded(7000 + i);
		const a = randomTree(rand);
		const b = randomTree(rand);

		clearWorktree(dir);
		writeFiles(dir, a);
		const snapA = await snapshot({ worktree: dir, now: FIXED_NOW });
		const stateA = dirHash(dir);

		clearWorktree(dir);
		writeFiles(dir, b);
		const plan = await planRestore({ worktree: dir, target: snapA, now: FIXED_NOW });
		const writes = new Set(plan.operations.filter((op) => op.op !== "delete").map((op) => op.path));
		const deletes = plan.operations.filter((op) => op.op === "delete").map((op) => op.path);
		if (deletes.length > 0) withDeletes++;
		const conflict = deletes.some((path) => [...writes].some((write) => write.startsWith(`${path}/`) || path.startsWith(`${write}/`)));
		if (conflict) typeConflicts++;

		const result = await restore({ worktree: dir, target: snapA, id: `prop-${String(i).padStart(4, "0")}`, now: FIXED_NOW });

		expect(result.plan.operations).toEqual(plan.operations);
		expect((await snapshot({ worktree: dir, now: FIXED_NOW })).tree).toBe(snapA.tree);
		expect(dirHash(dir)).toBe(stateA);
		expectWorktreeMatches(dir, snapA);
	}
	// The generator must actually exercise deletions and directory/file swaps, or the property proves little.
	expect(withDeletes).toBeGreaterThan(ITERATIONS / 4);
	expect(typeConflicts).toBeGreaterThan(0);
});
