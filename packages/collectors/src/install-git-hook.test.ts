/**
 * The installer copies the hook and bakes this checkout's collectors directory
 * into it, which is how an installed hook finds `emit.ts` for the event spool.
 * `--check` writes nothing.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALLER = join(import.meta.dir, "install-git-hook.ts");

function emptyRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "install-hook-"));
	const result = Bun.spawnSync(["git", "init", repo]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return repo;
}

function run(...args: string[]): { code: number; out: string } {
	const result = Bun.spawnSync(["bun", "--no-env-file", INSTALLER, ...args], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
	return { code: result.exitCode, out: result.stdout.toString() };
}

describe("install-git-hook", () => {
	test("installs an executable hook with the collectors directory baked in and no placeholder left", () => {
		const repo = emptyRepo();

		const installed = run(repo);

		expect(installed.code).toBe(0);
		const hook = join(repo, ".git", "hooks", "post-commit");
		const body = readFileSync(hook, "utf8");
		// A checkout path with shell metacharacters is never written into the script (the placeholder stays).
		const safe = /^[A-Za-z0-9._/@+-]+$/.test(import.meta.dir);
		expect(body).toContain(`\${SUBSTRATE_COLLECTORS_SRC:-${safe ? import.meta.dir : "__SUBSTRATE_COLLECTORS_SRC__"}}`);
		expect(body.includes("__SUBSTRATE_COLLECTORS_SRC__")).toBe(!safe);
		expect(statSync(hook).mode & 0o777).toBe(0o755);
	});

	test("a refresh rewrites the baked copy, and --check changes nothing", () => {
		const repo = emptyRepo();
		run(repo);
		const hook = join(repo, ".git", "hooks", "post-commit");
		const before = readFileSync(hook, "utf8");

		expect(run("--check", repo).out).toContain("present");
		expect(readFileSync(hook, "utf8")).toBe(before);
		expect(run(repo).out).toContain("refreshed");
		expect(readFileSync(hook, "utf8")).toBe(before);
	});

	test("--check on a repo without the hook installs nothing", () => {
		const repo = emptyRepo();

		expect(run("--check", repo).out).toContain("not installed");
		expect(existsSync(join(repo, ".git", "hooks", "post-commit"))).toBe(false);
	});
});
