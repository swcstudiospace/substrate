/**
 * snapshot(), pinSnapshot() and readPinnedSnapshot() against real git repositories.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SnapshotPolicyError, UnsupportedPathError } from "./errors.ts";
import { planRestore } from "./plan.ts";
import { manifestOf } from "./tree.ts";
import { pinSnapshot, readPinnedSnapshot, snapshot } from "./snapshot.ts";
import { cleanupTemp, FIXED_NOW, git, makeRepo, tempDir, writeFiles } from "./testkit.ts";

afterAll(cleanupTemp);
setDefaultTimeout(60_000);

const GOLDEN_MANIFEST = "dff53b118db5b46fa56130976c896cd03534a95761d6266e8e942e9e8d452f4d";

function goldenRepo(): string {
	const dir = makeRepo();
	writeFiles(dir, {
		"a.txt": "alpha\n",
		"bin/run.sh": { content: "#!/bin/sh\necho hi\n", exec: true },
		link: { link: "a.txt" },
	});
	return dir;
}

describe("snapshot", () => {
	test("manifest golden value for a fixed tree (accidental format changes fail)", async () => {
		const dir = goldenRepo();
		const snap = await snapshot({ worktree: dir, now: FIXED_NOW });
		expect(snap.manifestSha256).toBe(GOLDEN_MANIFEST);
		expect(snap.entries).toEqual([
			{ path: "a.txt", mode: "100644", type: "blob", sha: "4a58007052a65fbc2fc3f910f2855f45a4058e74" },
			{ path: "bin/run.sh", mode: "100755", type: "blob", sha: "4163036efa65bd4a469e752267498f01ea36a55c" },
			{ path: "link", mode: "120000", type: "blob", sha: "8d14cbf983b3fad683171c9418998d9f68340823" },
		]);
		expect(manifestOf(snap.entries)).toBe(GOLDEN_MANIFEST);
		expect(snap.version).toBe(1);
		expect(snap.tree).toMatch(/^[0-9a-f]{40}$/);
		expect(snap.skipped).toEqual([]);
		expect(snap.branch).toBe("main");
		expect(snap.headCommit).toBe(git(dir, ["rev-parse", "HEAD"]).trim());
		expect(snap.createdAt).toBe("2026-01-01T00:00:00.000Z");
	});

	test("createdAt is not part of any hash and the result is deterministic", async () => {
		const dir = goldenRepo();
		const first = await snapshot({ worktree: dir, now: FIXED_NOW });
		const second = await snapshot({ worktree: dir, now: () => new Date("2030-05-05T05:05:05.000Z") });
		expect(second.createdAt).toBe("2030-05-05T05:05:05.000Z");
		expect(second.tree).toBe(first.tree);
		expect(second.manifestSha256).toBe(first.manifestSha256);
	});

	test("the real index, HEAD, branch, refs and stash are untouched, and no temporary index is left", async () => {
		const dir = goldenRepo();
		git(dir, ["add", "a.txt"]);
		writeFiles(dir, { "untracked.txt": "u\n" });
		const observe = () => ({
			index: createHash("sha256").update(readFileSync(join(dir, ".git", "index"))).digest("hex"),
			head: git(dir, ["rev-parse", "HEAD"]),
			branch: git(dir, ["symbolic-ref", "HEAD"]),
			refs: git(dir, ["for-each-ref"]),
			stash: git(dir, ["stash", "list"]),
		});
		const before = observe();
		const snap = await snapshot({ worktree: dir, now: FIXED_NOW });
		await planRestore({ worktree: dir, target: snap, now: FIXED_NOW });
		expect(observe()).toEqual(before);
		expect(readdirSync(join(dir, ".git")).filter((name) => name.startsWith("substrate-index-"))).toEqual([]);
		expect(snap.entries.map((entry) => entry.path)).toContain("untracked.txt");
	});

	test("secret patterns, node_modules, build output and logs are excluded; secrets and big files are reported", async () => {
		const dir = makeRepo();
		writeFiles(dir, {
			"src/ok.ts": "export const ok = 1;\n",
			".env": "TOKEN=hunter2-placeholder\n",
			".env.local": "X=1\n",
			"deploy/id_rsa": "private-key-placeholder\n",
			"deploy/id_ed25519.pub": "pub\n",
			"keys/server.pem": "pem\n",
			"keys/store.p12": "p12\n",
			"keys/app.keystore": "ks\n",
			"credentials.prod.json": "{}\n",
			"node_modules/pkg/index.js": "module.exports = 1;\n",
			"debug.log": "log\n",
			"dist/out.js": "out\n",
			"build/out.js": "out\n",
			"big.bin": "x".repeat(100),
		});
		const snap = await snapshot({ worktree: dir, policy: { maxFileBytes: 50 }, now: FIXED_NOW });
		expect(snap.entries.map((entry) => entry.path)).toEqual(["src/ok.ts"]);
		expect(snap.skipped).toEqual([
			{ path: ".env", reason: "secret-pattern" },
			{ path: ".env.local", reason: "secret-pattern" },
			{ path: "big.bin", reason: "too-large" },
			{ path: "credentials.prod.json", reason: "secret-pattern" },
			{ path: "deploy/id_ed25519.pub", reason: "secret-pattern" },
			{ path: "deploy/id_rsa", reason: "secret-pattern" },
			{ path: "keys/app.keystore", reason: "secret-pattern" },
			{ path: "keys/server.pem", reason: "secret-pattern" },
			{ path: "keys/store.p12", reason: "secret-pattern" },
		]);
	});

	test("an excluded file's content never reaches the object database", async () => {
		const dir = makeRepo();
		const secret = "secret-content-that-must-not-be-stored-1234\n";
		const big = "b".repeat(200);
		writeFiles(dir, { ".env": secret, "big.bin": big, "ok.txt": "ok\n" });
		await snapshot({ worktree: dir, policy: { maxFileBytes: 100 }, now: FIXED_NOW });
		for (const content of [secret, big]) {
			const result = Bun.spawnSync(["git", "-C", dir, "hash-object", "--stdin"], { stdin: Buffer.from(content) });
			const id = result.stdout.toString().trim();
			expect(Bun.spawnSync(["git", "-C", dir, "cat-file", "-e", id], { stderr: "pipe" }).exitCode).not.toBe(0);
		}
	});

	test("gitignored files are excluded unless allowlisted; an ignored secret is still reported", async () => {
		const dir = makeRepo();
		writeFiles(dir, {
			".gitignore": ".env\nignored.txt\n.planning/\nscratch/\n",
			".env": "A=1\n",
			"ignored.txt": "i\n",
			".planning/plan.md": "plan\n",
			"scratch/tmp.txt": "t\n",
			"kept.txt": "k\n",
		});
		const snap = await snapshot({ worktree: dir, now: FIXED_NOW });
		expect(snap.entries.map((entry) => entry.path)).toEqual([".gitignore", ".planning/plan.md", "kept.txt"]);
		expect(snap.skipped).toEqual([{ path: ".env", reason: "secret-pattern" }]);
		const custom = await snapshot({ worktree: dir, policy: { ignoredAllowlist: ["scratch/"] }, now: FIXED_NOW });
		expect(custom.entries.map((entry) => entry.path)).toEqual([".gitignore", "kept.txt", "scratch/tmp.txt"]);
	});

	test("extra exclusions add to the defaults and never replace them", async () => {
		const dir = makeRepo();
		writeFiles(dir, { ".env": "A=1\n", "vault/token.txt": "t\n", "keep.txt": "k\n", "cache/x": "c\n" });
		const snap = await snapshot({
			worktree: dir,
			policy: { extraSecretPatterns: ["token.txt"], extraExcludeDirs: ["cache"] },
			now: FIXED_NOW,
		});
		expect(snap.entries.map((entry) => entry.path)).toEqual(["keep.txt"]);
		expect(snap.skipped.map((entry) => entry.path)).toEqual([".env", "vault/token.txt"]);
	});

	test("a nested repository and a tracked gitlink are reported as unsupported-submodule, never dropped silently", async () => {
		const dir = makeRepo();
		writeFiles(dir, { "keep.txt": "k\n" });
		const nested = join(dir, "vendor", "lib");
		mkdirSync(nested, { recursive: true });
		git(nested, ["init", "-q"]);
		writeFileSync(join(nested, "file.txt"), "inner\n");
		git(dir, ["update-index", "--add", "--cacheinfo", `160000,${git(dir, ["rev-parse", "HEAD"]).trim()},sub/mod`]);
		const snap = await snapshot({ worktree: dir, now: FIXED_NOW });
		expect(snap.entries.map((entry) => entry.path)).toEqual(["keep.txt"]);
		expect(snap.skipped).toEqual([
			{ path: "sub/mod", reason: "unsupported-submodule" },
			{ path: "vendor/lib", reason: "unsupported-submodule" },
		]);
	});

	test("a name that is not UTF-8 or that contains a newline is refused with a typed error", async () => {
		const bad = makeRepo();
		writeFileSync(Buffer.concat([Buffer.from(`${bad}/bad-`), Buffer.from([0xff, 0xfe]), Buffer.from(".txt")]), "x");
		const error = await snapshot({ worktree: bad, now: FIXED_NOW }).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(UnsupportedPathError);
		expect((error as UnsupportedPathError).code).toBe("unsupported-path");

		const newline = makeRepo();
		writeFileSync(join(newline, "a\nb.txt"), "x");
		await expect(snapshot({ worktree: newline, now: FIXED_NOW })).rejects.toBeInstanceOf(UnsupportedPathError);
	});

	test("a tracked file below a directory that became a symlink does not break the snapshot", async () => {
		const dir = makeRepo();
		writeFiles(dir, { "d/f.txt": "f\n", "other.txt": "o\n" });
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "files"]);
		const outside = tempDir();
		writeFileSync(join(outside, "f.txt"), "outside\n");
		rmSync(join(dir, "d"), { recursive: true });
		symlinkSync(outside, join(dir, "d"));
		const snap = await snapshot({ worktree: dir, now: FIXED_NOW });
		expect(snap.entries.map((entry) => `${entry.mode} ${entry.path}`)).toEqual(["120000 d", "100644 other.txt"]);
	});

	test("works in a linked worktree and reports its branch", async () => {
		const dir = makeRepo();
		const linked = join(tempDir(), "linked");
		git(dir, ["worktree", "add", "-q", "-b", "other", linked]);
		writeFiles(linked, { "only-here.txt": "x\n" });
		const snap = await snapshot({ worktree: linked, now: FIXED_NOW });
		expect(snap.branch).toBe("other");
		expect(snap.entries.map((entry) => entry.path)).toEqual(["only-here.txt"]);
	});

	test("a path that is not the top level of a working tree is refused", async () => {
		const dir = makeRepo();
		mkdirSync(join(dir, "sub"));
		await expect(snapshot({ worktree: join(dir, "sub"), now: FIXED_NOW })).rejects.toBeInstanceOf(SnapshotPolicyError);
	});

	test("an invalid policy is a SnapshotPolicyError", async () => {
		const dir = makeRepo();
		await expect(snapshot({ worktree: dir, policy: { maxFileBytes: 0 } })).rejects.toBeInstanceOf(SnapshotPolicyError);
		await expect(snapshot({ worktree: dir, policy: { ignoredAllowlist: ["../x"] } })).rejects.toBeInstanceOf(SnapshotPolicyError);
		await expect(snapshot({ worktree: dir, policy: { extraSecretPatterns: [""] } })).rejects.toBeInstanceOf(SnapshotPolicyError);
	});
});

describe("pinSnapshot and readPinnedSnapshot", () => {
	test("pins the tree under refs/substrate/checkpoints with a fixed identity, idempotently", async () => {
		const dir = goldenRepo();
		const snap = await snapshot({ worktree: dir, now: FIXED_NOW });
		const pin = await pinSnapshot({ worktree: dir, snapshot: snap, id: "ckpt-0001", now: FIXED_NOW });
		expect(pin.ref).toBe("refs/substrate/checkpoints/ckpt-0001");
		expect(git(dir, ["rev-parse", `${pin.ref}^{tree}`]).trim()).toBe(snap.tree);
		expect(git(dir, ["log", "-1", "--format=%an|%ae|%cn|%ce|%at|%P", pin.ref]).trim()).toBe(
			"Substrate Snapshot|snapshot@substrate.invalid|Substrate Snapshot|snapshot@substrate.invalid|1767225600|",
		);
		const again = await pinSnapshot({ worktree: dir, snapshot: snap, id: "ckpt-0001", now: () => new Date("2031-01-01T00:00:00Z") });
		expect(again).toEqual(pin);
		// The HEAD branch and the real refs are untouched.
		expect(git(dir, ["for-each-ref", "--format=%(refname)"]).trim().split("\n").sort()).toEqual([
			"refs/heads/main",
			"refs/substrate/checkpoints/ckpt-0001",
		]);
	});

	test("rejects ids outside ^[A-Za-z0-9._-]{8,64}$ and a second tree under an existing id", async () => {
		const dir = goldenRepo();
		const snap = await snapshot({ worktree: dir, now: FIXED_NOW });
		for (const id of ["short", "has space 1", "../escape-id", "a".repeat(65), ".hidden-id1", "name.lock", "semi;colon1"]) {
			await expect(pinSnapshot({ worktree: dir, snapshot: snap, id })).rejects.toBeInstanceOf(SnapshotPolicyError);
		}
		await pinSnapshot({ worktree: dir, snapshot: snap, id: "ckpt-0002", now: FIXED_NOW });
		writeFiles(dir, { "a.txt": "changed\n" });
		const changed = await snapshot({ worktree: dir, now: FIXED_NOW });
		await expect(pinSnapshot({ worktree: dir, snapshot: changed, id: "ckpt-0002", now: FIXED_NOW })).rejects.toBeInstanceOf(
			SnapshotPolicyError,
		);
	});

	test("rejects a snapshot whose manifest does not match its tree", async () => {
		const dir = goldenRepo();
		const snap = await snapshot({ worktree: dir, now: FIXED_NOW });
		await expect(
			pinSnapshot({ worktree: dir, snapshot: { ...snap, manifestSha256: "0".repeat(64) }, id: "ckpt-0003" }),
		).rejects.toBeInstanceOf(SnapshotPolicyError);
	});

	test("a pinned snapshot survives gc and can be read back", async () => {
		const dir = goldenRepo();
		const snap = await snapshot({ worktree: dir, now: FIXED_NOW });
		const pin = await pinSnapshot({ worktree: dir, snapshot: snap, id: "ckpt-0004", now: FIXED_NOW });
		git(dir, ["reflog", "expire", "--expire=now", "--all"]);
		git(dir, ["gc", "-q", "--prune=now"]);
		const back = await readPinnedSnapshot({ worktree: dir, ref: pin.ref, now: FIXED_NOW });
		expect(back.tree).toBe(snap.tree);
		expect(back.manifestSha256).toBe(snap.manifestSha256);
		expect(back.entries).toEqual(snap.entries);
		await expect(readPinnedSnapshot({ worktree: dir, ref: "refs/heads/main" })).rejects.toBeInstanceOf(SnapshotPolicyError);
		await expect(readPinnedSnapshot({ worktree: dir, ref: "refs/substrate/checkpoints/nothere-01" })).rejects.toBeInstanceOf(
			SnapshotPolicyError,
		);
	});
});
