/**
 * pinSnapshot's metadata trailer and listPinned() against real git repositories.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { SnapshotPolicyError } from "./errors.ts";
import { MAX_METADATA_BYTES, METADATA_TRAILER } from "./pin.ts";
import { listPinned, pinSnapshot, snapshot } from "./snapshot.ts";
import { cleanupTemp, FIXED_NOW, git, makeRepo, writeFiles } from "./testkit.ts";
import type { Snapshot } from "./types.ts";

afterAll(cleanupTemp);
setDefaultTimeout(60_000);

const ID_A = "ckpt_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ID_B = "ckpt_bbbbbbbbbbbbbbbbbbbbbbbbbb";

async function repoWithSnapshot(): Promise<{ dir: string; snap: Snapshot }> {
	const dir = makeRepo();
	writeFiles(dir, { "a.txt": "alpha\n" });
	return { dir, snap: await snapshot({ worktree: dir, now: FIXED_NOW }) };
}

describe("pinSnapshot metadata", () => {
	test("a pin without metadata lists with metadata null and no error, and its commit message is unchanged", async () => {
		const { dir, snap } = await repoWithSnapshot();
		const pin = await pinSnapshot({ worktree: dir, snapshot: snap, id: ID_A, now: FIXED_NOW });
		const listed = await listPinned({ worktree: dir, now: FIXED_NOW });
		expect(listed).toEqual([
			{
				id: ID_A,
				ref: `refs/substrate/checkpoints/${ID_A}`,
				commit: pin.commit,
				tree: snap.tree,
				createdAt: "2026-01-01T00:00:00.000Z",
				metadata: null,
				metadataError: null,
			},
		]);
		expect(git(dir, ["log", "-1", "--format=%B", pin.commit]).trim()).toBe(`substrate checkpoints ${ID_A}`);
	});

	test("metadata round-trips as canonical JSON in a commit trailer", async () => {
		const { dir, snap } = await repoWithSnapshot();
		const metadata = { seq: 3, ckpt_id: ID_A, nested: { z: 1, a: [true, null, "é"] }, skipped: undefined };
		const pin = await pinSnapshot({ worktree: dir, snapshot: snap, id: ID_A, metadata, now: FIXED_NOW });
		const message = git(dir, ["log", "-1", "--format=%B", pin.commit]);
		expect(message).toContain(`${METADATA_TRAILER}: {"ckpt_id":"${ID_A}","nested":{"a":[true,null,"é"],"z":1},"seq":3}`);
		const [entry] = await listPinned({ worktree: dir, now: FIXED_NOW });
		expect(entry?.metadata).toEqual({ ckpt_id: ID_A, nested: { a: [true, null, "é"], z: 1 }, seq: 3 });
		expect(entry?.metadataError).toBeNull();
	});

	test("key order does not change the pinned commit (canonical JSON)", async () => {
		const { dir, snap } = await repoWithSnapshot();
		const one = await pinSnapshot({ worktree: dir, snapshot: snap, id: ID_A, metadata: { a: 1, b: { c: 2, d: 3 } }, now: FIXED_NOW });
		const two = await pinSnapshot({ worktree: dir, snapshot: snap, id: ID_B, metadata: { b: { d: 3, c: 2 }, a: 1 }, now: FIXED_NOW });
		// Different ids give different messages; compare the trailer line instead.
		const trailer = (commit: string): string =>
			git(dir, ["log", "-1", "--format=%B", commit]).split("\n").find((line) => line.startsWith(METADATA_TRAILER)) ?? "";
		expect(trailer(one.commit)).toBe(trailer(two.commit));
	});

	test("an idempotent re-pin keeps the metadata the pin was created with", async () => {
		const { dir, snap } = await repoWithSnapshot();
		const first = await pinSnapshot({ worktree: dir, snapshot: snap, id: ID_A, metadata: { seq: 1 }, now: FIXED_NOW });
		const again = await pinSnapshot({ worktree: dir, snapshot: snap, id: ID_A, metadata: { seq: 2 }, now: FIXED_NOW });
		expect(again.commit).toBe(first.commit);
		const [entry] = await listPinned({ worktree: dir });
		expect(entry?.metadata).toEqual({ seq: 1 });
	});

	test("metadata above 4 KiB of canonical JSON is refused and no ref is created", async () => {
		const { dir, snap } = await repoWithSnapshot();
		// 2-byte characters: the cap is on UTF-8 bytes, not on string length.
		const big = { text: "é".repeat(MAX_METADATA_BYTES / 2) };
		await expect(pinSnapshot({ worktree: dir, snapshot: snap, id: ID_A, metadata: big })).rejects.toBeInstanceOf(SnapshotPolicyError);
		expect(await listPinned({ worktree: dir })).toEqual([]);
		// Exactly at the cap is accepted: `{"t":"..."}` is 8 bytes of structure.
		const fits = { t: "x".repeat(MAX_METADATA_BYTES - 8) };
		await pinSnapshot({ worktree: dir, snapshot: snap, id: ID_A, metadata: fits });
		expect((await listPinned({ worktree: dir }))[0]?.metadata).toEqual(fits);
	});

	test("values that are not plain JSON are refused", async () => {
		const { dir, snap } = await repoWithSnapshot();
		const bad: unknown[] = [{ n: Number.NaN }, { n: Number.POSITIVE_INFINITY }, { d: new Date(0) }, { f: () => 1 }, { b: 1n }, [], null, "text"];
		for (const metadata of bad) {
			await expect(
				pinSnapshot({ worktree: dir, snapshot: snap, id: ID_A, metadata: metadata as Record<string, unknown> }),
			).rejects.toBeInstanceOf(SnapshotPolicyError);
		}
		const deep: Record<string, unknown> = {};
		let cursor = deep;
		for (let i = 0; i < 20; i++) {
			const next: Record<string, unknown> = {};
			cursor.n = next;
			cursor = next;
		}
		await expect(pinSnapshot({ worktree: dir, snapshot: snap, id: ID_A, metadata: deep })).rejects.toBeInstanceOf(SnapshotPolicyError);
		expect(await listPinned({ worktree: dir })).toEqual([]);
	});
});

describe("listPinned", () => {
	test("lists every checkpoint sorted by ref and never lists safety or restore-target pins", async () => {
		const { dir, snap } = await repoWithSnapshot();
		await pinSnapshot({ worktree: dir, snapshot: snap, id: ID_B, metadata: { seq: 2 }, now: FIXED_NOW });
		await pinSnapshot({ worktree: dir, snapshot: snap, id: ID_A, metadata: { seq: 1 }, now: FIXED_NOW });
		git(dir, ["update-ref", "refs/substrate/safety/safety-0001", snap.headCommit ?? "HEAD"]);
		const listed = await listPinned({ worktree: dir });
		expect(listed.map((entry) => entry.id)).toEqual([ID_A, ID_B]);
	});

	test("a corrupt trailer is reported on its entry and never hides the others", async () => {
		const { dir, snap } = await repoWithSnapshot();
		await pinSnapshot({ worktree: dir, snapshot: snap, id: ID_A, metadata: { seq: 1 }, now: FIXED_NOW });
		const corrupt = async (id: string, message: string): Promise<void> => {
			const commit = git(dir, ["commit-tree", snap.tree, "-m", message]).trim();
			git(dir, ["update-ref", `refs/substrate/checkpoints/${id}`, commit]);
		};
		await corrupt("corrupt-json-1", `x\n\n${METADATA_TRAILER}: {not json`);
		await corrupt("corrupt-array-1", `x\n\n${METADATA_TRAILER}: [1,2]`);
		await corrupt("corrupt-twice-1", `x\n\n${METADATA_TRAILER}: {"a":1}\n${METADATA_TRAILER}: {"a":2}`);
		await corrupt("corrupt-large-1", `x\n\n${METADATA_TRAILER}: {"a":"${"y".repeat(MAX_METADATA_BYTES)}"}`);
		const listed = await listPinned({ worktree: dir });
		const byId = new Map(listed.map((entry) => [entry.id, entry]));
		expect(byId.get(ID_A)?.metadata).toEqual({ seq: 1 });
		expect(byId.get("corrupt-json-1")).toMatchObject({ metadata: null, metadataError: "the metadata trailer is not valid JSON" });
		expect(byId.get("corrupt-array-1")).toMatchObject({ metadata: null, metadataError: "the metadata trailer is not a JSON object" });
		expect(byId.get("corrupt-twice-1")).toMatchObject({ metadata: null, metadataError: "the metadata trailer appears more than once" });
		expect(byId.get("corrupt-large-1")?.metadataError).toContain("exceeds");
		expect(listed).toHaveLength(5);
	});

	test("a ref whose name is not a valid pin id is not a checkpoint of ours", async () => {
		const { dir, snap } = await repoWithSnapshot();
		const pin = await pinSnapshot({ worktree: dir, snapshot: snap, id: ID_A, now: FIXED_NOW });
		git(dir, ["update-ref", "refs/substrate/checkpoints/short", pin.commit]);
		expect((await listPinned({ worktree: dir })).map((entry) => entry.id)).toEqual([ID_A]);
	});

	test("an empty repository lists nothing", async () => {
		const dir = makeRepo();
		expect(await listPinned({ worktree: dir })).toEqual([]);
	});
});
