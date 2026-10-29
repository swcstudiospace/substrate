import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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
