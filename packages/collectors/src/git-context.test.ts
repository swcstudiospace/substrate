/**
 * repoSlug and branchFor against real repos: https, ssh, `.git`-suffixed and
 * missing origins, plus a checked-out branch and an unborn HEAD.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchFor, repoSlug } from "./git-context.ts";

const made: string[] = [];
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function run(dir: string, args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

function tempRepo(origin?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "substrate-git-context-"));
	made.push(dir);
	run(dir, ["init", "--initial-branch=main"]);
	run(dir, ["config", "user.email", "test@example.invalid"]);
	run(dir, ["config", "user.name", "Substrate Test"]);
	run(dir, ["commit", "--allow-empty", "-m", "init"]);
	if (origin !== undefined) run(dir, ["remote", "add", "origin", origin]);
	return dir;
}

describe("repoSlug", () => {
	test("https origin", () => {
		expect(repoSlug(tempRepo("https://github.com/acme/widgets.git"))).toBe("acme/widgets");
	});

	test("https origin without a .git suffix", () => {
		expect(repoSlug(tempRepo("https://github.com/acme/widgets"))).toBe("acme/widgets");
	});

	test("ssh origin", () => {
		expect(repoSlug(tempRepo("git@github.com:acme/widgets.git"))).toBe("acme/widgets");
	});

	test("no origin gives undefined", () => {
		expect(repoSlug(tempRepo())).toBeUndefined();
	});

	test("not a repo gives undefined", () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-git-context-plain-"));
		made.push(dir);
		expect(repoSlug(dir)).toBeUndefined();
	});
});

describe("branchFor", () => {
	test("returns the checked-out branch", () => {
		const dir = tempRepo("https://github.com/acme/widgets.git");
		run(dir, ["checkout", "-b", "feature/x"]);
		expect(branchFor(dir)).toBe("feature/x");
	});

	test("an unborn HEAD gives undefined", () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-git-context-unborn-"));
		made.push(dir);
		run(dir, ["init", "--initial-branch=main"]);
		expect(branchFor(dir)).toBeUndefined();
	});

	test("not a repo gives undefined", () => {
		const dir = mkdtempSync(join(tmpdir(), "substrate-git-context-plain-"));
		made.push(dir);
		expect(branchFor(dir)).toBeUndefined();
	});
});
