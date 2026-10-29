/**
 * Test helpers: real git repositories in temporary directories. Imported only by tests.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommandRunner } from "./git.ts";

const made: string[] = [];

export function cleanupTemp(): void {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A fresh temporary directory, resolved so it equals what git prints. */
export function tempDir(prefix = "substrate-fleet-"): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	made.push(dir);
	return dir;
}

export function defined<T>(value: T | null | undefined, label: string): T {
	if (value === null || value === undefined) throw new Error(`expected ${label} to be defined`);
	return value;
}

export function git(dir: string, args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

export function write(dir: string, file: string, content: string): void {
	const full = join(dir, file);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
}

export function commit(dir: string, file: string, content: string, message = `edit ${file}`): string {
	write(dir, file, content);
	git(dir, ["add", "--", file]);
	git(dir, ["commit", "-q", "-m", message]);
	return git(dir, ["rev-parse", "HEAD"]);
}

function configure(dir: string): void {
	git(dir, ["config", "user.email", "test@example.invalid"]);
	git(dir, ["config", "user.name", "Fleet Test"]);
	git(dir, ["config", "core.excludesFile", "/dev/null"]);
	git(dir, ["config", "commit.gpgsign", "false"]);
}

export interface TestRepo {
	/** The primary checkout. */
	dir: string;
	/** The bare repository it pushes to as `origin`. */
	origin: string;
}

/** A repository with one commit on `main`, pushed to a bare origin whose HEAD is `main`. */
export function makeRepo(): TestRepo {
	const base = tempDir();
	const origin = join(base, "remotes", "acme", "widgets.git");
	mkdirSync(origin, { recursive: true });
	git(origin, ["init", "-q", "--bare", "--initial-branch=main"]);
	const dir = join(base, "repos", "widgets");
	mkdirSync(dir, { recursive: true });
	git(dir, ["init", "-q", "--initial-branch=main"]);
	configure(dir);
	git(dir, ["remote", "add", "origin", origin]);
	commit(dir, "README.md", "hello\n", "init");
	git(dir, ["push", "-q", "origin", "main"]);
	git(dir, ["remote", "set-head", "origin", "main"]);
	return { dir, origin };
}

/** A linked worktree on a new branch cut from `main`, at `<root>/<name>`. */
export function addWorktree(repo: TestRepo, root: string, name: string, branch = name): string {
	const path = join(root, name);
	git(repo.dir, ["worktree", "add", "-q", "-b", branch, path, "main"]);
	configure(path);
	return path;
}

/** A runner for `gh` that answers `pr list` from a table keyed by branch, and records the calls. */
export function fakeGh(table: Record<string, Array<{ state: string; headRefOid: string; number: number }>>, calls: string[][] = []): CommandRunner {
	return async (args) => {
		calls.push(args);
		const head = args[args.indexOf("--head") + 1] ?? "";
		const prs = table[head];
		if (prs === undefined) return { code: 0, stdout: "[]", stderr: "" };
		return { code: 0, stdout: JSON.stringify(prs), stderr: "" };
	};
}
