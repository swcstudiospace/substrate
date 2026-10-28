/**
 * A restore never deletes (or overwrites) a path the snapshot SKIPPED. A skipped path is absent from
 * the target tree because it was never captured, not because it did not exist when the snapshot was
 * taken; deleting it on restore would destroy data the checkpoint never held.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SimulatedCrash, SnapshotPolicyError } from "./errors.ts";
import { planRestore } from "./plan.ts";
import { SKIPPED_TRAILER } from "./pin.ts";
import { recoverRestore, restore } from "./restore.ts";
import { pinSnapshot, readPinnedSnapshot, snapshot } from "./snapshot.ts";
import { cleanupTemp, FIXED_NOW, git, makeRepo, writeFiles } from "./testkit.ts";
import type { Snapshot } from "./types.ts";

afterAll(cleanupTemp);
setDefaultTimeout(60_000);

const BIG = "x".repeat(200);
const policy = { maxFileBytes: 100 };
const opts = { policy, now: FIXED_NOW };
const CKPT = "ckpt_skipped_aaaaaaaaaaaaaaaaaa";

let counter = 0;
const nextId = (): string => `skipped-${String(++counter).padStart(4, "0")}`;

/** large.bin is skipped (too large) when the snapshot is taken; keep.txt is captured. */
async function repoWithSkippedBigFile(): Promise<{ dir: string; snap: Snapshot }> {
	const dir = makeRepo();
	writeFiles(dir, { "keep.txt": "keep\n", "large.bin": BIG });
	const snap = await snapshot({ worktree: dir, ...opts });
	expect(snap.entries.map((entry) => entry.path)).toEqual(["keep.txt"]);
	expect(snap.skipped).toEqual([{ path: "large.bin", reason: "too-large" }]);
	return { dir, snap };
}

describe("restore leaves paths the snapshot skipped alone", () => {
	test("a file skipped for size, then shrunk below the limit, is neither planned for deletion nor deleted", async () => {
		const { dir, snap } = await repoWithSkippedBigFile();
		writeFiles(dir, { "large.bin": "now small\n", "keep.txt": "changed\n" });

		const plan = await planRestore({ worktree: dir, target: snap, ...opts });
		expect(plan.operations.map((operation) => `${operation.op} ${operation.path}`)).toEqual(["modify keep.txt"]);
		expect(plan.counts.delete).toBe(0);
		expect(plan.skippedInSnapshot).toEqual([{ path: "large.bin", reason: "too-large" }]);

		const result = await restore({ worktree: dir, target: snap, id: nextId(), ...opts });

		expect(readFileSync(join(dir, "large.bin"), "utf8")).toBe("now small\n");
		expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("keep\n");
		expect(result.plan.skippedInSnapshot).toEqual([{ path: "large.bin", reason: "too-large" }]);
		expect(result.verifiedTree).toBe(snap.tree);
	});

	test("the same holds through a pinned checkpoint, which records what was skipped without changing the tree or manifest", async () => {
		const { dir, snap } = await repoWithSkippedBigFile();
		const { ref } = await pinSnapshot({ worktree: dir, snapshot: snap, id: CKPT, now: FIXED_NOW });

		const pinned = await readPinnedSnapshot({ worktree: dir, ref, now: FIXED_NOW });
		expect(pinned.skipped).toEqual([{ path: "large.bin", reason: "too-large" }]);
		// The skipped list is not part of any hash.
		expect(pinned.tree).toBe(snap.tree);
		expect(pinned.manifestSha256).toBe(snap.manifestSha256);
		expect(git(dir, ["log", "-1", "--format=%B", ref])).toContain(`${SKIPPED_TRAILER}: [{"path":"large.bin","reason":"too-large"}]`);

		writeFiles(dir, { "large.bin": "now small\n" });
		await restore({ worktree: dir, target: pinned, id: nextId(), ...opts });
		expect(readFileSync(join(dir, "large.bin"), "utf8")).toBe("now small\n");
	});

	test("a pin of a snapshot that skipped nothing has no skipped trailer", async () => {
		const dir = makeRepo();
		writeFiles(dir, { "a.txt": "a\n" });
		const snap = await snapshot({ worktree: dir, now: FIXED_NOW });
		const { ref } = await pinSnapshot({ worktree: dir, snapshot: snap, id: CKPT, now: FIXED_NOW });
		expect(git(dir, ["log", "-1", "--format=%B", ref])).not.toContain(SKIPPED_TRAILER);
		expect((await readPinnedSnapshot({ worktree: dir, ref, now: FIXED_NOW })).skipped).toEqual([]);
	});

	test("a skipped-list trailer that cannot be read is refused, never read as 'nothing skipped'", async () => {
		const { dir, snap } = await repoWithSkippedBigFile();
		const commit = git(dir, ["commit-tree", snap.tree, "-m", `substrate safety x\n\n${SKIPPED_TRAILER}: not json`]).trim();
		git(dir, ["update-ref", "refs/substrate/safety/corrupt-skipped-1", commit]);
		await expect(
			readPinnedSnapshot({ worktree: dir, ref: "refs/substrate/safety/corrupt-skipped-1", now: FIXED_NOW }),
		).rejects.toBeInstanceOf(SnapshotPolicyError);
	});

	test("a path skipped by policy (secret pattern) is left alone when the restore policy no longer excludes it", async () => {
		const dir = makeRepo();
		writeFiles(dir, { "keep.txt": "keep\n", "app.token": "token-value\n" });
		const snap = await snapshot({ worktree: dir, policy: { extraSecretPatterns: ["*.token"] }, now: FIXED_NOW });
		expect(snap.skipped).toEqual([{ path: "app.token", reason: "secret-pattern" }]);
		writeFiles(dir, { "keep.txt": "changed\n" });

		// The restore policy has no `*.token` pattern, so app.token is in the current tree and absent from the target.
		const plan = await planRestore({ worktree: dir, target: snap, now: FIXED_NOW });
		expect(plan.counts.delete).toBe(0);
		expect(plan.skippedInSnapshot).toEqual([{ path: "app.token", reason: "secret-pattern" }]);

		await restore({ worktree: dir, target: snap, id: nextId(), now: FIXED_NOW });
		expect(readFileSync(join(dir, "app.token"), "utf8")).toBe("token-value\n");
		expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("keep\n");
	});

	test("an ordinary file created after the snapshot is still removed, next to a protected skipped file", async () => {
		const { dir, snap } = await repoWithSkippedBigFile();
		writeFiles(dir, { "large.bin": "now small\n", "extra.txt": "created later\n", "dir/new.txt": "new\n" });

		const plan = await planRestore({ worktree: dir, target: snap, ...opts });
		expect(plan.operations.filter((operation) => operation.op === "delete").map((operation) => operation.path)).toEqual([
			"dir/new.txt",
			"extra.txt",
		]);

		await restore({ worktree: dir, target: snap, id: nextId(), ...opts });

		expect(existsSync(join(dir, "extra.txt"))).toBe(false);
		expect(existsSync(join(dir, "dir"))).toBe(false);
		expect(readFileSync(join(dir, "large.bin"), "utf8")).toBe("now small\n");
	});

	test("recovering an interrupted restore also leaves the skipped path alone", async () => {
		const { dir, snap } = await repoWithSkippedBigFile();
		writeFiles(dir, { "large.bin": "now small\n", "extra.txt": "created later\n" });

		const crashed = await restore({
			worktree: dir,
			target: snap,
			id: nextId(),
			...opts,
			hooks: {
				beforeOp: (index: number): void => {
					if (index === 0) throw new SimulatedCrash("crash before the first operation");
				},
			},
		}).catch((caught: unknown) => caught);
		expect(crashed).toBeInstanceOf(SimulatedCrash);

		const recovered = await recoverRestore({ worktree: dir, now: FIXED_NOW });
		expect(recovered).toMatchObject({ recovered: true, direction: "forward" });
		expect(existsSync(join(dir, "extra.txt"))).toBe(false);
		expect(readFileSync(join(dir, "large.bin"), "utf8")).toBe("now small\n");
	});
});
