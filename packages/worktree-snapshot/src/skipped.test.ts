/**
 * A restore never deletes (or overwrites) a path the snapshot SKIPPED. A skipped path is absent from
 * the target tree because it was never captured, not because it did not exist when the snapshot was
 * taken; deleting it on restore would destroy data the checkpoint never held.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RestoreDriftError, SimulatedCrash, SnapshotPolicyError } from "./errors.ts";
import { planRestore } from "./plan.ts";
import { MAX_SKIPPED_BYTES, MAX_SKIPPED_ENTRIES, SKIPPED_TRAILER } from "./pin.ts";
import { recoverRestore, restore } from "./restore.ts";
import { pinSnapshot, readPinnedSnapshot, sameTreeIgnoringSkipped, snapshot } from "./snapshot.ts";
import { cleanupTemp, FIXED_NOW, git, makeRepo, writeFiles } from "./testkit.ts";
import type { SkippedPath, Snapshot } from "./types.ts";

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

function syntheticSkipped(count: number, pathLength = 90): SkippedPath[] {
	return Array.from({ length: count }, (_, index) => ({
		path: `${`certs/${String(index).padStart(6, "0")}-`.padEnd(pathLength, "c")}.pem`,
		reason: "secret-pattern" as const,
	}));
}

async function pinWithSkipped(skipped: SkippedPath[], id: string): Promise<{ dir: string; snap: Snapshot; ref: string }> {
	const dir = makeRepo();
	writeFiles(dir, { "keep.txt": "keep\n" });
	const snap = { ...(await snapshot({ worktree: dir, now: FIXED_NOW })), skipped };
	const { ref } = await pinSnapshot({ worktree: dir, snapshot: snap, id, now: FIXED_NOW });
	return { dir, snap, ref };
}

describe("a long skipped list cannot break pinning", () => {
	test("5,000 long paths (far over one 128 KiB argument) pin through stdin and read back whole", async () => {
		const skipped = syntheticSkipped(MAX_SKIPPED_ENTRIES);
		expect(Buffer.byteLength(JSON.stringify(skipped))).toBeGreaterThan(128 * 1024);
		const { dir, ref } = await pinWithSkipped(skipped, "ckpt-long-list-1");

		const message = git(dir, ["log", "-1", "--format=%B", ref]);
		expect(Buffer.byteLength(message)).toBeGreaterThan(128 * 1024);
		const pinned = await readPinnedSnapshot({ worktree: dir, ref, now: FIXED_NOW });
		expect(pinned.skipped).toEqual(skipped);
		expect(pinned.skippedTruncated).toBeUndefined();
	});

	test("a list over the entry cap keeps the first entries and the total, and the plan reports the truncation", async () => {
		const skipped = syntheticSkipped(MAX_SKIPPED_ENTRIES + 1);
		const { dir, ref } = await pinWithSkipped(skipped, "ckpt-long-list-2");

		const pinned = await readPinnedSnapshot({ worktree: dir, ref, now: FIXED_NOW });
		expect(pinned.skipped).toEqual(skipped.slice(0, MAX_SKIPPED_ENTRIES));
		expect(pinned.skippedTruncated).toEqual({ total: MAX_SKIPPED_ENTRIES + 1 });
		expect(git(dir, ["log", "-1", "--format=%B", ref])).toContain(`${SKIPPED_TRAILER}: {"truncated":true,"total":${MAX_SKIPPED_ENTRIES + 1},"entries":[`);

		const plan = await planRestore({ worktree: dir, target: pinned, now: FIXED_NOW });
		expect(plan.skippedTruncated).toEqual({ recorded: MAX_SKIPPED_ENTRIES, total: MAX_SKIPPED_ENTRIES + 1 });

		// Pinning the truncated snapshot again keeps the true total, not the recorded count.
		const again = await pinSnapshot({ worktree: dir, snapshot: pinned, id: "ckpt-long-list-3", now: FIXED_NOW });
		expect((await readPinnedSnapshot({ worktree: dir, ref: again.ref, now: FIXED_NOW })).skippedTruncated).toEqual({
			total: MAX_SKIPPED_ENTRIES + 1,
		});
	});

	test("a few very long paths are capped by size, so a listing never carries megabytes per checkpoint", async () => {
		const skipped = syntheticSkipped(600, 3000);
		const { dir, ref } = await pinWithSkipped(skipped, "ckpt-long-list-4");

		const pinned = await readPinnedSnapshot({ worktree: dir, ref, now: FIXED_NOW });
		expect(pinned.skippedTruncated).toEqual({ total: 600 });
		expect(pinned.skipped.length).toBeGreaterThan(0);
		expect(pinned.skipped.length).toBeLessThan(600);
		expect(pinned.skipped).toEqual(skipped.slice(0, pinned.skipped.length));
		expect(Buffer.byteLength(git(dir, ["log", "-1", "--format=%B", ref]))).toBeLessThan(MAX_SKIPPED_BYTES + 4096);
	});

	test("past the cap a skipped file is not protected (removed like a new file); the ones inside it still are", async () => {
		const middle = Array.from({ length: MAX_SKIPPED_ENTRIES }, (_, index) => ({
			path: `m-${String(index).padStart(5, "0")}`,
			reason: "too-large" as const,
		}));
		const skipped: SkippedPath[] = [{ path: "aa-early.bin", reason: "too-large" }, ...middle, { path: "zz-late.bin", reason: "too-large" }];
		const { dir, ref } = await pinWithSkipped(skipped, "ckpt-long-list-5");
		writeFiles(dir, { "aa-early.bin": "early\n", "zz-late.bin": "late\n", "keep.txt": "changed\n" });

		const pinned = await readPinnedSnapshot({ worktree: dir, ref, now: FIXED_NOW });
		expect(pinned.skipped).toHaveLength(MAX_SKIPPED_ENTRIES);
		const result = await restore({ worktree: dir, target: pinned, id: nextId(), now: FIXED_NOW });

		expect(result.plan.skippedTruncated).toEqual({ recorded: MAX_SKIPPED_ENTRIES, total: MAX_SKIPPED_ENTRIES + 2 });
		expect(result.plan.skippedInSnapshot).toEqual([{ path: "aa-early.bin", reason: "too-large" }]);
		expect(readFileSync(join(dir, "aa-early.bin"), "utf8")).toBe("early\n");
		expect(existsSync(join(dir, "zz-late.bin"))).toBe(false);
		expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("keep\n");
	});
});

describe("paths the expected checkpoint skipped are not drift", () => {
	test("a file a restore left in place is not drift against the checkpoint that skipped it; any other change still is", async () => {
		const { dir, snap } = await repoWithSkippedBigFile();
		writeFiles(dir, { "large.bin": "now small\n" });

		const strict = await planRestore({ worktree: dir, target: snap, expectedCurrentTree: snap.tree, ...opts });
		expect(strict.drift.map((operation) => operation.path)).toEqual(["large.bin"]);

		const aware = await planRestore({ worktree: dir, target: snap, expectedCurrentTree: snap.tree, expectedCurrentSkipped: snap.skipped, ...opts });
		expect(aware.drift).toEqual([]);

		writeFiles(dir, { "keep.txt": "edited\n" });
		const edited = await planRestore({ worktree: dir, target: snap, expectedCurrentTree: snap.tree, expectedCurrentSkipped: snap.skipped, ...opts });
		expect(edited.drift.map((operation) => operation.path)).toEqual(["keep.txt"]);

		await expect(restore({ worktree: dir, target: snap, id: nextId(), expectedCurrentTree: snap.tree, expectedCurrentSkipped: snap.skipped, ...opts })).rejects.toBeInstanceOf(
			RestoreDriftError,
		);
	});

	test("sameTreeIgnoringSkipped ignores exactly the skipped paths", async () => {
		const { dir, snap } = await repoWithSkippedBigFile();
		writeFiles(dir, { "large.bin": "now small\n" });
		const withLarge = await snapshot({ worktree: dir, ...opts });
		const same = (left: string, right: string, ignoreSkipped: SkippedPath[]): Promise<boolean> =>
			sameTreeIgnoringSkipped({ worktree: dir, left, right, ignoreSkipped, now: FIXED_NOW });

		expect(await same(withLarge.tree, snap.tree, [])).toBe(false);
		expect(await same(withLarge.tree, snap.tree, snap.skipped)).toBe(true);

		writeFiles(dir, { "keep.txt": "edited\n" });
		const edited = await snapshot({ worktree: dir, ...opts });
		expect(await same(edited.tree, snap.tree, snap.skipped)).toBe(false);
	});
});
