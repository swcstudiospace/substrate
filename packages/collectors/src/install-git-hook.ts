#!/usr/bin/env bun
/**
 * Install the post-commit collector into one or more repositories.
 *
 *   bun packages/collectors/src/install-git-hook.ts <repo> [repo...]
 *   bun packages/collectors/src/install-git-hook.ts --check <repo>
 *
 * Never clobbers an existing hook: if one is already there and is not ours, it
 * is left alone and reported, because a repo's own post-commit hook may be
 * doing something the owner cares about.
 */
import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const MARKER = "Agent Substrate — git post-commit collector";
const SOURCE = join(import.meta.dir, "git", "post-commit");

function hooksDir(repo: string): string | null {
	const result = spawnSync("git", ["-C", repo, "rev-parse", "--git-path", "hooks"], { encoding: "utf8" });
	if (result.status !== 0) return null;
	const relative = result.stdout.trim();
	return resolve(repo, relative);
}

type Status = "installed" | "already-ours" | "foreign-hook" | "not-a-repo";

function inspect(repo: string): { status: Status; path?: string } {
	const dir = hooksDir(repo);
	if (!dir) return { status: "not-a-repo" };
	const path = join(dir, "post-commit");
	if (!existsSync(path)) return { status: "installed", path };
	const existing = readFileSync(path, "utf8");
	return { status: existing.includes(MARKER) ? "already-ours" : "foreign-hook", path };
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const repos = args.filter((a) => !a.startsWith("--"));

if (repos.length === 0) {
	process.stderr.write("usage: install-git-hook.ts [--check] <repo> [repo...]\n");
	process.exit(2);
}

let failures = 0;
for (const repo of repos) {
	const { status, path } = inspect(repo);
	if (status === "not-a-repo") {
		process.stdout.write(`✗ ${repo} — not a git repository\n`);
		failures++;
		continue;
	}
	if (status === "foreign-hook") {
		process.stdout.write(`⚠ ${repo} — a different post-commit hook is already installed; left alone\n`);
		failures++;
		continue;
	}
	if (status === "already-ours") {
		if (!checkOnly && path) {
			copyFileSync(SOURCE, path);
			chmodSync(path, 0o755);
		}
		process.stdout.write(`✓ ${repo} — ${checkOnly ? "present" : "refreshed"}\n`);
		continue;
	}
	if (checkOnly) {
		process.stdout.write(`○ ${repo} — not installed\n`);
		continue;
	}
	if (path) {
		copyFileSync(SOURCE, path);
		chmodSync(path, 0o755);
		process.stdout.write(`✓ ${repo} — installed\n`);
	}
}

process.exit(failures > 0 ? 1 : 0);
