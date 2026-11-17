import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { GitResult, GitRunner } from "./discover.ts";

/** Narrows a value a test already knows is present (an indexed element, a Map hit, a find result) and fails the test with a clear message when it is not. */
export function defined<T>(value: T | null | undefined, what = "value"): T {
	if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
	return value;
}

export function tempDir(prefix = "corpus-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Writes `files` (relative path to text or bytes) below `root`, creating directories. */
export function writeTree(root: string, files: Record<string, string | Uint8Array>): void {
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content);
	}
}

export function linkFile(root: string, rel: string, target: string): void {
	const abs = join(root, rel);
	mkdirSync(dirname(abs), { recursive: true });
	symlinkSync(target, abs);
}

export interface FakeRepo {
	origin?: string;
	/** Absolute shared git directory; defaults to `<dir>/.git`. */
	commonDir?: string;
	/** Absolute own git directory; defaults to the common one (a linked worktree sets its own). */
	gitDir?: string;
	head?: string | null;
	branch?: string | null;
	/** The branch `refs/remotes/origin/HEAD` points at; absent means there is no such ref. */
	remoteDefault?: string;
	/** Whether `refs/heads/main` exists when there is no remote default. Default true. */
	hasMain?: boolean;
	/** Commit time in seconds. */
	time?: number;
	/** Tracked files, as `git ls-files` lists them. */
	files?: string[];
	lsFilesFails?: boolean;
}

export interface FakeGit extends GitRunner {
	calls: Array<{ args: string[]; cwd: string }>;
}

const FAILED: GitResult = { code: 128, stdout: "" };

/** A git runner that answers the exact commands discovery and scan use from `repos`, keyed by checkout directory. */
export function fakeGit(repos: Record<string, FakeRepo>): FakeGit {
	const byDir = new Map(Object.entries(repos).map(([dir, repo]) => [resolve(dir), repo]));
	const calls: FakeGit["calls"] = [];
	const run = ((args: string[], cwd: string): GitResult => {
		calls.push({ args, cwd });
		const repo = byDir.get(resolve(cwd));
		if (repo === undefined) return FAILED;
		const ok = (stdout: string): GitResult => ({ code: 0, stdout });
		switch (args.join(" ")) {
			case "remote get-url origin":
				return repo.origin === undefined ? { code: 2, stdout: "" } : ok(`${repo.origin}\n`);
			case "rev-parse --git-dir --git-common-dir": {
				const common = repo.commonDir ?? join(resolve(cwd), ".git");
				return ok(`${repo.gitDir ?? common}\n${common}\n`);
			}
			case "rev-parse --verify -q HEAD":
				return repo.head === null ? FAILED : ok(`${repo.head ?? "a".repeat(40)}\n`);
			case "symbolic-ref --short -q HEAD":
				return repo.branch === null ? { code: 1, stdout: "" } : ok(`${repo.branch ?? "main"}\n`);
			case "log -1 --format=%ct":
				return ok(`${repo.time ?? 1_700_000_000}\n`);
			case "symbolic-ref --short -q refs/remotes/origin/HEAD":
				return repo.remoteDefault === undefined ? { code: 1, stdout: "" } : ok(`origin/${repo.remoteDefault}\n`);
			case "show-ref --verify -q refs/heads/main":
				return repo.hasMain === false ? { code: 1, stdout: "" } : ok("");
			case "ls-files -z":
				if (repo.lsFilesFails === true) return FAILED;
				return ok((repo.files ?? []).map((file) => `${file}\0`).join(""));
			default:
				return FAILED;
		}
	}) as FakeGit;
	run.calls = calls;
	return run;
}

/** Runs real git with a fixed identity and no user or system configuration; throws with git's message on a non-zero exit. */
export function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH ?? "",
			HOME: cwd,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Corpus Test",
			GIT_AUTHOR_EMAIL: "corpus@example.invalid",
			GIT_COMMITTER_NAME: "Corpus Test",
			GIT_COMMITTER_EMAIL: "corpus@example.invalid",
		},
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

/** Stages everything and commits it in `dir`. */
export function commitAll(dir: string, message: string): void {
	runGit(dir, ["add", "-A"]);
	runGit(dir, ["commit", "-q", "-m", message]);
}

/** A bare origin and two clones of it, in a fresh directory; `local` is the checkout under test, `other` pushes "from another machine". */
export interface GitWorld {
	root: string;
	origin: string;
	local: string;
	other: string;
	/** An empty directory for mirrors. */
	mirrors: string;
}

export function gitWorld(files: Record<string, string | Uint8Array>): GitWorld {
	const root = tempDir("corpus-git-");
	const origin = join(root, "origin.git");
	const seed = join(root, "seed");
	const local = join(root, "local");
	const other = join(root, "other");
	runGit(root, ["init", "-q", "--bare", "-b", "main", origin]);
	// A real server that supports partial clones; the mirror clone asks for no blobs.
	runGit(origin, ["config", "uploadpack.allowFilter", "true"]);
	runGit(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
	runGit(root, ["init", "-q", "-b", "main", seed]);
	writeTree(seed, files);
	commitAll(seed, "seed");
	runGit(seed, ["remote", "add", "origin", origin]);
	runGit(seed, ["push", "-q", "origin", "main"]);
	runGit(root, ["clone", "-q", origin, local]);
	runGit(root, ["clone", "-q", origin, other]);
	const mirrors = join(root, "mirrors");
	return { root, origin, local, other, mirrors };
}

/** A hash of every path, file content and symlink target below `dir` (`.git` included), to prove a command wrote nothing. */
export function fingerprint(dir: string): string {
	const hash = createHash("sha256");
	const walk = (current: string, prefix: string): void => {
		for (const name of readdirSync(current).sort()) {
			const abs = join(current, name);
			const rel = `${prefix}/${name}`;
			const stat = lstatSync(abs);
			hash.update(`${rel}\0`);
			if (stat.isDirectory()) walk(abs, rel);
			else if (stat.isSymbolicLink()) hash.update(readlinkSync(abs));
			else hash.update(readFileSync(abs));
		}
	};
	walk(dir, "");
	return hash.digest("hex");
}
