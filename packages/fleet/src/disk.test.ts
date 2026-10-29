import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDiskFloor, DiskFloorError, diskPressure, freeBytes } from "./disk.ts";
import { spawnGit } from "./git.ts";
import { addWorktree, cleanupTemp, makeRepo, tempDir } from "./testkit.ts";

afterAll(cleanupTemp);

const GIB = 1024 ** 3;

describe("assertDiskFloor", () => {
	test("refuses below the floor with a named error, accepts at it", () => {
		expect(() => assertDiskFloor("/x", 5, () => 5 * GIB - 1)).toThrow(DiskFloorError);
		expect(() => assertDiskFloor("/x", 5, () => 5 * GIB)).not.toThrow();
		try {
			assertDiskFloor("/x", 5, () => 2 * GIB);
		} catch (error) {
			expect(error).toBeInstanceOf(DiskFloorError);
			expect(error).toMatchObject({ name: "DiskFloorError", freeBytes: 2 * GIB, minFreeBytes: 5 * GIB, path: "/x" });
			expect(String(error)).toContain("2.0 GB free");
		}
	});

	test("freeBytes works for a path that does not exist yet by using its nearest existing parent", () => {
		const free = freeBytes(join(tempDir(), "not", "created", "yet"));
		expect(free).toBeGreaterThan(0);
	});
});

describe("diskPressure", () => {
	test("reports the least free space, flags it against the floor and lists linked worktrees largest first", async () => {
		const repo = makeRepo();
		const root = join(tempDir(), "wts");
		mkdirSync(root);
		const small = addWorktree(repo, root, "small");
		const large = addWorktree(repo, root, "large");
		writeFileSync(join(large, "blob.bin"), Buffer.alloc(256 * 1024, 7));
		writeFileSync(join(small, "tiny.txt"), "x");

		const low = await diskPressure([root], 5, { git: spawnGit, free: () => 3 * GIB });
		expect(low).toMatchObject({ freeBytes: 3 * GIB, minFreeBytes: 5 * GIB, ok: false });
		expect(low.worktrees.map((wt) => wt.path)).toEqual([large, small]);
		expect(low.worktrees.every((wt) => wt.path !== repo.dir)).toBe(true);
		expect(low.worktrees[0]?.bytes).toBeGreaterThan(low.worktrees[1]?.bytes ?? Number.POSITIVE_INFINITY);

		const high = await diskPressure([root], 5, { git: spawnGit, free: () => 50 * GIB });
		expect(high.ok).toBe(true);
	});

	test("with several roots the tightest filesystem decides", async () => {
		const free = (path: string): number => (path === "/tight" ? 1 * GIB : 100 * GIB);
		const result = await diskPressure(["/roomy", "/tight"], 5, { git: spawnGit, free });
		expect(result.freeBytes).toBe(1 * GIB);
		expect(result.ok).toBe(false);
		expect(result.worktrees).toEqual([]);
	});
});
