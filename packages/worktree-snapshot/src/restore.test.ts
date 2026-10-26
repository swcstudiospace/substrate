/**
 * planRestore() and restore() against real git repositories.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { applyOperation, makeApplyContext } from "./apply.ts";
import {
	PathConflictError,
	RestoreDriftError,
	RestoreFailedError,
	RestoreRecoveryRequiredError,
	RestoreVerifyError,
	SnapshotPolicyError,
	UnsupportedPathError,
	WorktreeBusyError,
} from "./errors.ts";
import { assertSafeRelativePath } from "./paths.ts";
import { planRestore } from "./plan.ts";
import { readPinnedSnapshot, snapshot } from "./snapshot.ts";
import { recoverRestore, restore } from "./restore.ts";
import { openRepo, type Runner, spawnRunner } from "./runner.ts";
import { mutateToB, SCENARIO_EXCLUDED_B, SCENARIO_POLICY, writeScenarioA } from "./scenario.ts";
import {
	cleanupTemp,
	dirHash,
	expectWorktreeMatches,
	FIXED_NOW,
	fileStateHash,
	git,
	makeRepo,
	tempDir,
	writeFiles,
} from "./testkit.ts";
import type { RestoreOperation, Snapshot } from "./types.ts";

afterAll(cleanupTemp);
setDefaultTimeout(60_000);

let counter = 0;
const nextId = (): string => `restore-${String(++counter).padStart(4, "0")}`;

const opts = { policy: SCENARIO_POLICY, now: FIXED_NOW };

const indexHash = (dir: string): string => createHash("sha256").update(readFileSync(join(dir, ".git", "index"))).digest("hex");

function substrateRefs(dir: string): string[] {
	return git(dir, ["for-each-ref", "--format=%(refname)", "refs/substrate"]).trim().split("\n").filter(Boolean);
}

/** A scenario repo in state B with the state A snapshot taken before the mutation. */
async function scenario(): Promise<{ dir: string; snapA: Snapshot; preTree: string; preState: string }> {
	const dir = makeRepo();
	writeScenarioA(dir);
	const snapA = await snapshot({ worktree: dir, ...opts });
	mutateToB(dir);
	const pre = await snapshot({ worktree: dir, ...opts });
	return { dir, snapA, preTree: pre.tree, preState: fileStateHash(dir) };
}

describe("restore: round trip", () => {
	test("restores tracked, modified, deleted, renamed, chmod, symlink and untracked files byte for byte", async () => {
		const { dir, snapA, preTree } = await scenario();
		expect(snapA.entries.map((entry) => entry.path)).toContain("bin.dat");
		const before = { index: indexHash(dir), head: git(dir, ["rev-parse", "HEAD"]), stash: git(dir, ["stash", "list"]) };
		const id = nextId();

		const result = await restore({ worktree: dir, target: snapA, id, ...opts });

		expect((await snapshot({ worktree: dir, ...opts })).tree).toBe(snapA.tree);
		expect(result.verifiedTree).toBe(snapA.tree);
		expectWorktreeMatches(dir, snapA);
		const counts = result.plan.counts;
		expect(counts.add).toBeGreaterThan(0);
		expect(counts.modify).toBeGreaterThan(0);
		expect(counts.delete).toBeGreaterThan(0);
		expect(counts.chmod).toBeGreaterThan(0);
		expect(counts.retype).toBeGreaterThan(0);
		expect(counts.total).toBe(result.plan.operations.length);

		// Directories the restore emptied and the target does not have are gone.
		expect(existsSync(join(dir, "new"))).toBe(false);
		expect(existsSync(join(dir, "extra"))).toBe(false);
		expect(readFileSync(join(dir, "notes", "todo.txt"), "utf8")).toBe("todo\n");

		// Excluded and skipped paths are exactly as the mutation left them.
		for (const [path, content] of Object.entries(SCENARIO_EXCLUDED_B)) {
			expect(readFileSync(join(dir, path), "utf8")).toBe(content);
		}

		// Index, HEAD and stash are untouched; journal, lock and target pin are gone; the safety ref remains.
		expect(indexHash(dir)).toBe(before.index);
		expect(git(dir, ["rev-parse", "HEAD"])).toBe(before.head);
		expect(git(dir, ["stash", "list"])).toBe(before.stash);
		expect(existsSync(join(dir, ".git", "substrate-restore", "restore-journal.json"))).toBe(false);
		expect(existsSync(join(dir, ".git", "substrate-restore.lock"))).toBe(false);
		expect(substrateRefs(dir)).toEqual([`refs/substrate/safety/${id}`]);
		expect(result.safetyRef).toBe(`refs/substrate/safety/${id}`);
		expect(result.safety.tree).toBe(preTree);
	});

	test("the safety snapshot restores the pre-restore state exactly", async () => {
		const { dir, snapA, preTree, preState } = await scenario();
		const first = await restore({ worktree: dir, target: snapA, id: nextId(), ...opts });
		const safety = await readPinnedSnapshot({ worktree: dir, ref: first.safetyRef, now: FIXED_NOW });
		expect(safety.tree).toBe(preTree);

		await restore({ worktree: dir, target: safety, id: nextId(), ...opts });

		expect((await snapshot({ worktree: dir, ...opts })).tree).toBe(preTree);
		expect(fileStateHash(dir)).toBe(preState);
	});

	test("restoring the current state changes nothing and still verifies", async () => {
		const dir = makeRepo();
		writeScenarioA(dir);
		const snapA = await snapshot({ worktree: dir, ...opts });
		const before = dirHash(dir);
		const result = await restore({ worktree: dir, target: snapA, id: nextId(), ...opts });
		expect(result.plan.operations).toEqual([]);
		expect(dirHash(dir)).toBe(before);
	});

	test("files deleted under a directory that the target holds as one file restore exactly, and the safety snapshot undoes it", async () => {
		const dir = makeRepo();
		writeFiles(dir, { c: "target file\n", keep: "k\n" });
		const snapA = await snapshot({ worktree: dir, ...opts });
		rmSync(join(dir, "c"));
		writeFiles(dir, { "c/a/x.txt": "x\n", "c/a/y.txt": "y\n", "c/b/z.txt": "z\n" });
		const preState = fileStateHash(dir);

		const result = await restore({ worktree: dir, target: snapA, id: nextId(), ...opts });

		expect(result.verifiedTree).toBe(snapA.tree);
		expect(readFileSync(join(dir, "c"), "utf8")).toBe("target file\n");
		expect(readFileSync(join(dir, "keep"), "utf8")).toBe("k\n");

		const safety = await readPinnedSnapshot({ worktree: dir, ref: result.safetyRef, now: FIXED_NOW });
		await restore({ worktree: dir, target: safety, id: nextId(), ...opts });
		expect(fileStateHash(dir)).toBe(preState);
		expect(readFileSync(join(dir, "c", "a", "x.txt"), "utf8")).toBe("x\n");
	});
});

describe("planRestore", () => {
	test("lists exactly the operations the real restore performs and writes nothing", async () => {
		const { dir, snapA } = await scenario();
		const before = dirHash(dir);
		const refsBefore = git(dir, ["for-each-ref"]);
		const indexBefore = indexHash(dir);

		const plan = await planRestore({ worktree: dir, target: snapA, ...opts });

		expect(dirHash(dir)).toBe(before);
		expect(git(dir, ["for-each-ref"])).toBe(refsBefore);
		expect(indexHash(dir)).toBe(indexBefore);
		expect(readdirSync(join(dir, ".git")).filter((name) => name.startsWith("substrate"))).toEqual([]);
		expect(plan.drift).toEqual([]);
		expect(plan.targetTree).toBe(snapA.tree);

		const seen: RestoreOperation[] = [];
		const result = await restore({
			worktree: dir,
			target: snapA,
			id: nextId(),
			...opts,
			hooks: { beforeOp: (_index, operation) => void seen.push(operation) },
		});
		expect(seen).toEqual(plan.operations);
		expect(result.plan.operations).toEqual(plan.operations);
		expect(result.plan.counts).toEqual(plan.counts);
	});

	test("orders deletes that make room first, then writes, then the remaining deletes", async () => {
		const { dir, snapA } = await scenario();
		const plan = await planRestore({ worktree: dir, target: snapA, ...opts });
		const kinds = plan.operations.map((operation) => operation.op === "delete");
		const firstWrite = kinds.indexOf(false);
		const lastWrite = kinds.lastIndexOf(false);
		// Everything between the first and last write is a write; deletes only appear around them.
		expect(kinds.slice(firstWrite, lastWrite + 1).every((isDelete) => !isDelete)).toBe(true);
		const paths = plan.operations.map((operation) => `${operation.op} ${operation.path}`);
		expect(paths.indexOf("delete swapdir")).toBeLessThan(paths.indexOf("add swapdir/child.txt"));
		expect(paths.indexOf("retype swap")).toBeGreaterThan(-1);
		expect(paths).toContain("delete src/helpers.ts");
		expect(paths).toContain("add src/util.ts");
	});

	test("drift lists what changed outside the session; restore refuses it unless forced", async () => {
		const dir = makeRepo();
		writeScenarioA(dir);
		const snapA = await snapshot({ worktree: dir, ...opts });
		writeFiles(dir, { "session.txt": "work of the session\n" });
		const sessionEnd = await snapshot({ worktree: dir, ...opts });
		writeFiles(dir, { "README.md": "edited by somebody else\n" });

		const plan = await planRestore({ worktree: dir, target: snapA, expectedCurrentTree: sessionEnd.tree, ...opts });
		expect(plan.drift.map((operation) => `${operation.op} ${operation.path}`)).toEqual(["modify README.md"]);

		const before = dirHash(dir);
		const error = await restore({
			worktree: dir,
			target: snapA,
			id: nextId(),
			expectedCurrentTree: sessionEnd.tree,
			...opts,
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(RestoreDriftError);
		expect((error as RestoreDriftError).code).toBe("restore-drift");
		expect((error as RestoreDriftError).drift.map((operation) => operation.path)).toEqual(["README.md"]);
		expect(dirHash(dir)).toBe(before);
		expect(substrateRefs(dir)).toEqual([]);

		await restore({
			worktree: dir,
			target: snapA,
			id: nextId(),
			expectedCurrentTree: sessionEnd.tree,
			force: true,
			...opts,
		});
		expect((await snapshot({ worktree: dir, ...opts })).tree).toBe(snapA.tree);
		expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("readme v1\n");
	});

	test("no drift when the worktree is what the session expects", async () => {
		const { dir, snapA, preTree } = await scenario();
		const result = await restore({ worktree: dir, target: snapA, id: nextId(), expectedCurrentTree: preTree, ...opts });
		expect(result.plan.drift).toEqual([]);
	});

	test("a target tree with a .git, .. or absolute entry is refused before anything is read or written", async () => {
		const dir = makeRepo();
		const hash = (content: string): string =>
			Bun.spawnSync(["git", "-C", dir, "hash-object", "-w", "--stdin"], { stdin: Buffer.from(content) }).stdout.toString().trim();
		const mktree = (text: string): string =>
			Bun.spawnSync(["git", "-C", dir, "mktree"], { stdin: Buffer.from(text) }).stdout.toString().trim();
		const inner = mktree(`100644 blob ${hash("x\n")}\tx\n`);
		for (const name of [".git", "..", ".GIT"]) {
			const tree = mktree(`040000 tree ${inner}\t${name}\n`);
			const foreign: Snapshot = {
				version: 1,
				tree,
				headCommit: null,
				branch: null,
				manifestSha256: "0".repeat(64),
				entries: [],
				skipped: [],
				createdAt: "",
			};
			await expect(planRestore({ worktree: dir, target: foreign })).rejects.toBeInstanceOf(UnsupportedPathError);
			await expect(restore({ worktree: dir, target: foreign, id: nextId() })).rejects.toBeInstanceOf(UnsupportedPathError);
		}
		expect(readdirSync(dir).sort()).toEqual([".git"]);
	});

	test("a target whose manifest does not match its tree is refused", async () => {
		const { dir, snapA } = await scenario();
		await expect(
			restore({ worktree: dir, target: { ...snapA, manifestSha256: "f".repeat(64) }, id: nextId(), ...opts }),
		).rejects.toBeInstanceOf(SnapshotPolicyError);
	});
});

describe("restore: exclusions", () => {
	test("files created after the snapshot are deleted; excluded and skipped paths are never touched", async () => {
		const dir = makeRepo();
		writeFiles(dir, { "keep.txt": "keep\n", "u.txt": "untracked\n", ".env": "SECRET=a\n", "big.dat": "x".repeat(100) });
		const snapA = await snapshot({ worktree: dir, ...opts });
		expect(snapA.skipped.map((entry) => entry.path)).toEqual([".env", "big.dat"]);
		rmSync(join(dir, "u.txt"));
		writeFiles(dir, {
			"later.txt": "later\n",
			".env": "SECRET=changed\n",
			".env.later": "NEW=1\n",
			"node_modules/x/y.js": "y\n",
			"big.dat": "z".repeat(200),
			"deploy/id_rsa": "private\n",
		});

		await restore({ worktree: dir, target: snapA, id: nextId(), ...opts });

		expect(readFileSync(join(dir, "u.txt"), "utf8")).toBe("untracked\n");
		expect(existsSync(join(dir, "later.txt"))).toBe(false);
		expect(readFileSync(join(dir, ".env"), "utf8")).toBe("SECRET=changed\n");
		expect(existsSync(join(dir, ".env.later"))).toBe(true);
		expect(existsSync(join(dir, "node_modules", "x", "y.js"))).toBe(true);
		expect(readFileSync(join(dir, "big.dat"), "utf8")).toBe("z".repeat(200));
		expect(existsSync(join(dir, "deploy", "id_rsa"))).toBe(true);
		// The directory that held only an excluded file stays.
		expect(existsSync(join(dir, "deploy"))).toBe(true);
	});

	test("a file above maxFileBytes that sits where the target needs a file fails and rolls back", async () => {
		const dir = makeRepo();
		writeFiles(dir, { "grow.txt": "small\n", "other.txt": "o\n" });
		const snapA = await snapshot({ worktree: dir, ...opts });
		writeFiles(dir, { "grow.txt": "g".repeat(100), "other.txt": "changed\n" });
		const preState = fileStateHash(dir);

		const error = await restore({ worktree: dir, target: snapA, id: nextId(), ...opts }).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(RestoreFailedError);
		expect((error as RestoreFailedError).rolledBack).toBe(true);
		expect((error as RestoreFailedError).modified).toBe(true);
		expect(((error as RestoreFailedError).cause as Error).constructor).toBe(PathConflictError);
		expect(fileStateHash(dir)).toBe(preState);
		expect(readFileSync(join(dir, "grow.txt"), "utf8")).toBe("g".repeat(100));
	});

	test("a directory holding an excluded file cannot be replaced by a file; the restore rolls back", async () => {
		const dir = makeRepo();
		writeFiles(dir, { cfg: "a file\n" });
		const snapA = await snapshot({ worktree: dir, ...opts });
		rmSync(join(dir, "cfg"));
		writeFiles(dir, { "cfg/.env": "S=1\n" });
		const preState = fileStateHash(dir);

		const error = await restore({ worktree: dir, target: snapA, id: nextId(), ...opts }).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(RestoreFailedError);
		expect((error as RestoreFailedError).rolledBack).toBe(true);
		expect(fileStateHash(dir)).toBe(preState);
	});
});

describe("restore: failure handling", () => {
	test("a handled failure mid-apply ends rolled back to the pre-restore tree", async () => {
		const { dir, snapA, preTree, preState } = await scenario();
		const id = nextId();

		const error = await restore({
			worktree: dir,
			target: snapA,
			id,
			...opts,
			hooks: {
				beforeOp: (index) => {
					if (index === 3) throw new Error(`boom while restoring in ${dir}`);
				},
			},
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(RestoreFailedError);
		const failed = error as RestoreFailedError;
		expect(failed.code).toBe("restore-failed");
		expect(failed.rolledBack).toBe(true);
		expect(failed.modified).toBe(true);
		expect(failed.safetyRef).toBe(`refs/substrate/safety/${id}`);
		expect(failed.message).not.toContain(dir);
		expect((await snapshot({ worktree: dir, ...opts })).tree).toBe(preTree);
		expect(fileStateHash(dir)).toBe(preState);
		expect(existsSync(join(dir, ".git", "substrate-restore", "restore-journal.json"))).toBe(false);
		expect(existsSync(join(dir, ".git", "substrate-restore.lock"))).toBe(false);
		expect(substrateRefs(dir)).toEqual([`refs/substrate/safety/${id}`]);
	});

	test("a restored file that does not hash to its blob fails verification and is rolled back", async () => {
		const { dir, snapA, preTree, preState } = await scenario();
		let corrupted = false;
		const run: Runner = async (argv, options) => {
			const result = await spawnRunner(argv, options);
			if (!corrupted && argv.includes("cat-file") && argv.includes("blob") && options?.stdoutFile !== undefined) {
				corrupted = true;
				appendFileSync(options.stdoutFile, "CORRUPT");
			}
			return result;
		};

		const error = await restore({ worktree: dir, target: snapA, id: nextId(), run, ...opts }).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(RestoreVerifyError);
		expect(error).toBeInstanceOf(RestoreFailedError);
		const failed = error as RestoreVerifyError;
		expect(failed.code).toBe("restore-verify");
		expect(failed.rolledBack).toBe(true);
		expect(failed.paths.length).toBe(1);
		expect((await snapshot({ worktree: dir, ...opts })).tree).toBe(preTree);
		expect(fileStateHash(dir)).toBe(preState);
	});

	test("an invalid id is refused before anything happens", async () => {
		const { dir, snapA } = await scenario();
		await expect(restore({ worktree: dir, target: snapA, id: "short", ...opts })).rejects.toBeInstanceOf(SnapshotPolicyError);
		expect(substrateRefs(dir)).toEqual([]);
	});

	test("a pending journal blocks a new restore until recoverRestore has run", async () => {
		const { dir, snapA } = await scenario();
		const journalDir = join(dir, ".git", "substrate-restore");
		mkdirSync(journalDir, { recursive: true });
		writeFileSync(join(journalDir, "restore-journal.json"), "{}");
		await expect(restore({ worktree: dir, target: snapA, id: nextId(), ...opts })).rejects.toBeInstanceOf(
			RestoreRecoveryRequiredError,
		);
		expect(existsSync(join(journalDir, "restore-journal.json"))).toBe(true);
	});

	test("a journal directory inside the working tree is refused", async () => {
		const { dir, snapA } = await scenario();
		await expect(
			restore({ worktree: dir, target: snapA, id: nextId(), journalDir: join(dir, "journal"), ...opts }),
		).rejects.toBeInstanceOf(SnapshotPolicyError);
	});
});

describe("restore: lock", () => {
	test("a second restore on a busy worktree throws WorktreeBusyError", async () => {
		const { dir, snapA } = await scenario();
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const first = restore({
			worktree: dir,
			target: snapA,
			id: nextId(),
			...opts,
			hooks: {
				beforeOp: async (index) => {
					if (index === 0) {
						entered.resolve();
						await gate.promise;
					}
				},
			},
		});
		await entered.promise;
		expect(existsSync(join(dir, ".git", "substrate-restore.lock"))).toBe(true);

		const second = await restore({ worktree: dir, target: snapA, id: nextId(), ...opts }).catch((caught: unknown) => caught);
		expect(second).toBeInstanceOf(WorktreeBusyError);
		expect((second as WorktreeBusyError).code).toBe("worktree-busy");
		await expect(recoverRestore({ worktree: dir, now: FIXED_NOW })).rejects.toBeInstanceOf(WorktreeBusyError);

		gate.resolve();
		await first;
		expect(existsSync(join(dir, ".git", "substrate-restore.lock"))).toBe(false);
		expect((await snapshot({ worktree: dir, ...opts })).tree).toBe(snapA.tree);
	});

	function writeLock(dir: string, fields: Record<string, unknown>): string {
		const path = join(dir, ".git", "substrate-restore.lock");
		writeFileSync(
			path,
			JSON.stringify({ pid: 2147483646, startedAt: "2020-01-01T00:00:00.000Z", procStart: null, host: hostname(), token: "deadbeef", ...fields }),
		);
		return path;
	}

	test("a lock whose owner process is gone is stale and is broken", async () => {
		const { dir, snapA } = await scenario();
		const path = writeLock(dir, {});
		await restore({ worktree: dir, target: snapA, id: nextId(), ...opts });
		expect(existsSync(path)).toBe(false);
		expect((await snapshot({ worktree: dir, ...opts })).tree).toBe(snapA.tree);
	});

	test("a lock from another host or one that cannot be parsed is never broken automatically", async () => {
		const { dir, snapA } = await scenario();
		const path = writeLock(dir, { host: `${hostname()}-elsewhere` });
		await expect(restore({ worktree: dir, target: snapA, id: nextId(), ...opts })).rejects.toBeInstanceOf(WorktreeBusyError);
		writeFileSync(path, "not json");
		await expect(restore({ worktree: dir, target: snapA, id: nextId(), ...opts })).rejects.toBeInstanceOf(WorktreeBusyError);
		expect(existsSync(path)).toBe(true);
	});

	test("a live owner with a different process start time (pid reuse) is stale", async () => {
		const { dir, snapA } = await scenario();
		if (!existsSync(`/proc/${process.pid}/stat`)) return;
		const path = writeLock(dir, { pid: process.pid, procStart: "1" });
		await restore({ worktree: dir, target: snapA, id: nextId(), ...opts });
		expect(existsSync(path)).toBe(false);
	});
});

describe("restore: path safety", () => {
	test("assertSafeRelativePath refuses .., absolute, empty-segment and .git paths", () => {
		for (const path of ["../x", "a/../b", "/etc/passwd", "a//b", "", "./a", ".git/hooks/x", "a/.GIT/x", "a\0b"]) {
			expect(() => assertSafeRelativePath(path)).toThrow(UnsupportedPathError);
		}
		expect(() => assertSafeRelativePath("a/.gitignore")).not.toThrow();
		expect(() => assertSafeRelativePath("dir/file.txt")).not.toThrow();
	});

	test("applyOperation refuses to escape the worktree and to write or delete through a symlink", async () => {
		const dir = makeRepo();
		const outside = tempDir();
		writeFileSync(join(outside, "victim.txt"), "keep me\n");
		symlinkSync(outside, join(dir, "link"));
		const blob = Bun.spawnSync(["git", "-C", dir, "hash-object", "-w", "--stdin"], { stdin: Buffer.from("payload\n") })
			.stdout.toString()
			.trim();
		const repo = await openRepo({ worktree: dir });
		const ctx = makeApplyContext(repo, "restore-path-1", blob);

		const add = (path: string): RestoreOperation => ({ op: "add", path, mode: "100644", sha: blob });
		await expect(applyOperation(ctx, add("../evil.txt"))).rejects.toBeInstanceOf(UnsupportedPathError);
		await expect(applyOperation(ctx, add("/tmp/evil.txt"))).rejects.toBeInstanceOf(UnsupportedPathError);
		await expect(applyOperation(ctx, add(".git/hooks/pre-commit"))).rejects.toBeInstanceOf(UnsupportedPathError);
		await expect(applyOperation(ctx, add("link/pwn.txt"))).rejects.toBeInstanceOf(UnsupportedPathError);
		await expect(applyOperation(ctx, { op: "delete", path: "link/victim.txt", previousMode: "100644" })).rejects.toBeInstanceOf(
			UnsupportedPathError,
		);

		expect(readdirSync(outside)).toEqual(["victim.txt"]);
		expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("keep me\n");
		expect(existsSync(join(dir, "..", "evil.txt"))).toBe(false);
		expect(existsSync(join(dir, ".git", "hooks", "pre-commit"))).toBe(false);
	});

	test("a symlink to a directory is replaced by the directory without writing through it", async () => {
		const dir = makeRepo();
		writeFiles(dir, { "a/b.txt": "b\n", "z.txt": "z\n" });
		const snapA = await snapshot({ worktree: dir, ...opts });
		const outside = tempDir();
		writeFileSync(join(outside, "keep.txt"), "outside\n");
		rmSync(join(dir, "a"), { recursive: true });
		symlinkSync(outside, join(dir, "a"));

		await restore({ worktree: dir, target: snapA, id: nextId(), ...opts });

		expect(readFileSync(join(dir, "a", "b.txt"), "utf8")).toBe("b\n");
		expect(readdirSync(outside)).toEqual(["keep.txt"]);
		expect((await snapshot({ worktree: dir, ...opts })).tree).toBe(snapA.tree);
	});

	test("error messages never contain file contents", async () => {
		const dir = makeRepo();
		writeFiles(dir, { "grow.txt": "small\n" });
		const snapA = await snapshot({ worktree: dir, ...opts });
		writeFiles(dir, { "grow.txt": "TOP-SECRET-CONTENT".repeat(10) });
		const error = await restore({ worktree: dir, target: snapA, id: nextId(), ...opts }).catch((caught: unknown) => caught);
		expect((error as Error).message).not.toContain("TOP-SECRET-CONTENT");
		expect((error as Error).message).not.toContain(dir);
		expect((error as Error).message).toContain("grow.txt");
	});
});
