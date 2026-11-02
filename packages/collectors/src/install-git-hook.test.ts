/**
 * The installer copies the hook and bakes this checkout's collectors directory
 * into it, which is how an installed hook finds `emit.ts` for the event spool.
 * `--check` writes nothing.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CORPUS_BLOCK_BEGIN,
	CORPUS_BLOCK_END,
	CORPUS_HOOKS,
	corpusHookBlock,
	installCorpusHooks,
	installRepos,
	uninstallCorpusHooks,
} from "./install-git-hook.ts";

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

function hookPath(repo: string, hook: string): string {
	return join(repo, ".git", "hooks", hook);
}

describe("corpus hint hooks", () => {
	test("--corpus installs the three hooks beside post-commit, executable, each holding only our block", () => {
		const repo = emptyRepo();

		const installed = run("--corpus", repo);

		expect(installed.code).toBe(0);
		expect(existsSync(hookPath(repo, "post-commit"))).toBe(true);
		for (const hook of CORPUS_HOOKS) {
			const body = readFileSync(hookPath(repo, hook), "utf8");
			expect(body.startsWith("#!/bin/sh\n")).toBe(true);
			expect(body).toContain(CORPUS_BLOCK_BEGIN);
			expect(body).toContain(CORPUS_BLOCK_END);
			expect(body).toContain(`(${hook})`);
			expect(body).toContain('corpus hint --repo "$top"');
			expect(statSync(hookPath(repo, hook)).mode & 0o777).toBe(0o755);
		}
	});

	test("without --corpus no hint hook is written", () => {
		const repo = emptyRepo();
		run(repo);
		for (const hook of CORPUS_HOOKS) expect(existsSync(hookPath(repo, hook))).toBe(false);
	});

	test("a hook that is not ours is reported and left alone, and the others are still installed", () => {
		const repo = emptyRepo();
		const foreign = "#!/bin/sh\necho my own post-merge\n";
		writeFileSync(hookPath(repo, "post-merge"), foreign, { mode: 0o755 });

		const reports = installCorpusHooks(repo, { check: false });

		expect(reports.find((report) => report.hook === "post-merge")).toMatchObject({ state: "foreign" });
		expect(readFileSync(hookPath(repo, "post-merge"), "utf8")).toBe(foreign);
		expect(reports.filter((report) => report.state === "installed").map((report) => report.hook)).toEqual(["post-checkout", "post-rewrite"]);
		expect(run("--corpus", repo).code).toBe(1);
	});

	test("a second install refreshes in place and --check writes nothing", () => {
		const repo = emptyRepo();
		installCorpusHooks(repo, { check: false });
		const before = readFileSync(hookPath(repo, "post-rewrite"), "utf8");

		expect(installCorpusHooks(repo, { check: true }).every((report) => report.state === "present")).toBe(true);
		expect(installCorpusHooks(repo, { check: false }).every((report) => report.state === "refreshed")).toBe(true);
		expect(readFileSync(hookPath(repo, "post-rewrite"), "utf8")).toBe(before);

		const fresh = emptyRepo();
		expect(installCorpusHooks(fresh, { check: true }).every((report) => report.state === "absent")).toBe(true);
		expect(existsSync(hookPath(fresh, "post-merge"))).toBe(false);
	});

	test("uninstall removes only our block: a file of nothing else is deleted, other lines are kept", () => {
		const repo = emptyRepo();
		installCorpusHooks(repo, { check: false });
		const path = hookPath(repo, "post-checkout");
		writeFileSync(path, `${readFileSync(path, "utf8")}echo added after ours\n`, { mode: 0o755 });

		const reports = uninstallCorpusHooks(repo);

		expect(reports.map((report) => report.state)).toEqual(["removed", "removed", "removed"]);
		expect(existsSync(hookPath(repo, "post-merge"))).toBe(false);
		expect(existsSync(hookPath(repo, "post-rewrite"))).toBe(false);
		const kept = readFileSync(path, "utf8");
		expect(kept).toContain("echo added after ours");
		expect(kept).not.toContain(CORPUS_BLOCK_BEGIN);
		expect(uninstallCorpusHooks(repo).filter((report) => report.state === "absent")).toHaveLength(2);
	});

	test("uninstall never touches a foreign hook or a damaged block", () => {
		const repo = emptyRepo();
		writeFileSync(hookPath(repo, "post-merge"), "#!/bin/sh\necho mine\n", { mode: 0o755 });
		writeFileSync(hookPath(repo, "post-rewrite"), `#!/bin/sh\n${CORPUS_BLOCK_BEGIN}\necho half\n`, { mode: 0o755 });

		const reports = uninstallCorpusHooks(repo);

		expect(reports.map((report) => report.state)).toEqual(["foreign", "absent", "foreign"]);
		expect(readFileSync(hookPath(repo, "post-merge"), "utf8")).toBe("#!/bin/sh\necho mine\n");
		expect(readFileSync(hookPath(repo, "post-rewrite"), "utf8")).toContain("echo half");
	});

	test("a reversed or repeated marker pair is left untouched", () => {
		const repo = emptyRepo();
		const path = hookPath(repo, "post-merge");
		const reversed = `#!/bin/sh\n${CORPUS_BLOCK_END}\necho keep\n${CORPUS_BLOCK_BEGIN}\n`;
		writeFileSync(path, reversed, { mode: 0o755 });
		expect(installCorpusHooks(repo, { check: false }).find((report) => report.hook === "post-merge")).toMatchObject({ state: "foreign", detail: "our block is damaged" });
		expect(readFileSync(path, "utf8")).toBe(reversed);
		const repeated = `#!/bin/sh\n${CORPUS_BLOCK_BEGIN}\n${CORPUS_BLOCK_BEGIN}\n${CORPUS_BLOCK_END}\n`;
		writeFileSync(path, repeated, { mode: 0o755 });
		expect(installCorpusHooks(repo, { check: false }).find((report) => report.hook === "post-merge")?.state).toBe("foreign");
		expect(readFileSync(path, "utf8")).toBe(repeated);
	});

	test("install creates a missing core.hooksPath; a status check does not", () => {
		const repo = emptyRepo();
		const hooks = join(repo, "custom-hooks");
		const configured = Bun.spawnSync(["git", "-C", repo, "config", "core.hooksPath", hooks]);
		expect(configured.exitCode).toBe(0);
		expect(installCorpusHooks(repo, { check: true }).every((report) => report.state === "absent")).toBe(true);
		expect(existsSync(hooks)).toBe(false);
		expect(installCorpusHooks(repo, { check: false }).every((report) => report.state === "installed")).toBe(true);
		expect(existsSync(join(hooks, "post-merge"))).toBe(true);
	});

	test("a directory that is not a repository is reported for every hook", () => {
		const dir = mkdtempSync(join(tmpdir(), "install-hook-plain-"));
		expect(installCorpusHooks(dir, { check: false }).map((report) => report.state)).toEqual(["not-a-repo", "not-a-repo", "not-a-repo"]);
	});

	test("a CLI path with shell metacharacters is never written into the script", () => {
		const block = corpusHookBlock("post-merge", "/tmp/x; rm -rf /");
		expect(block).not.toContain("rm -rf");
		expect(block).toContain("__SUBSTRATE_CLI__");
	});

	test("the installed hook runs the hint command for the repository's top level, in the foreground under SUBSTRATE_HOOK_WAIT, and exits 0 whatever the command does", () => {
		const repo = emptyRepo();
		installCorpusHooks(repo, { check: false });
		const bin = mkdtempSync(join(tmpdir(), "install-hook-bin-"));
		const log = join(bin, "calls.log");
		const stub = join(bin, "substrate");
		writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 7\n`);
		chmodSync(stub, 0o755);
		const subdir = join(repo, "docs");
		mkdirSync(subdir);

		const result = Bun.spawnSync(["sh", hookPath(repo, "post-merge")], {
			cwd: subdir,
			env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, SUBSTRATE_HOOK_WAIT: "1" },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe("");
		expect(result.stderr.toString()).toBe("");
		const top = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--show-toplevel"]).stdout.toString().trim();
		expect(readFileSync(log, "utf8")).toBe(`corpus hint --repo ${top}\n`);
	});

	test("with no substrate command and no CLI at the baked path the hook does nothing and exits 0", () => {
		const repo = emptyRepo();
		installCorpusHooks(repo, { check: false, cliPath: "/nonexistent/cli/index.ts" });
		const bin = mkdtempSync(join(tmpdir(), "install-hook-empty-"));

		const result = Bun.spawnSync(["sh", hookPath(repo, "post-checkout")], {
			cwd: repo,
			env: { PATH: `${bin}:/usr/bin:/bin`, HOME: bin, SUBSTRATE_HOOK_WAIT: "1" },
		});

		expect(result.exitCode).toBe(0);
	});
});

describe("installRepos keeps going past a failing repository", () => {
	test("one failing repository does not stop the others, which still get their hook", () => {
		const bad = emptyRepo();
		const good = emptyRepo();
		const alsoGood = emptyRepo();
		// A directory where the hook file belongs: reading it throws, as an unreadable hook would.
		mkdirSync(hookPath(bad, "post-commit"), { recursive: true });
		const lines: string[] = [];
		const outcome = installRepos([bad, good, alsoGood], { write: (text) => lines.push(text) });
		for (const repo of [good, alsoGood]) {
			const hook = hookPath(repo, "post-commit");
			expect(statSync(hook).isFile()).toBe(true);
			expect(statSync(hook).mode & 0o111).not.toBe(0);
		}
		expect(outcome.failures).toBe(1);
		expect(lines.length).toBe(3);
		expect(lines[0]?.startsWith(`✗ ${bad} — install failed: `)).toBe(true);
		expect(lines.slice(1)).toEqual([`✓ ${good} — installed\n`, `✓ ${alsoGood} — installed\n`]);
	});

	test("the failing repository is named in the result with a one-line reason", () => {
		const bad = emptyRepo();
		mkdirSync(hookPath(bad, "post-commit"), { recursive: true });
		const outcome = installRepos([bad], { write: () => {} });
		expect(outcome.errors.length).toBe(1);
		const failure = outcome.errors[0];
		expect(failure?.repo).toBe(bad);
		expect(failure?.reason.length).toBeGreaterThan(0);
		expect(failure?.reason).not.toContain("\n");
		expect(failure?.reason).not.toMatch(/:\/\//);
		expect(outcome.failures).toBe(1);
	});

	test("with no failure the result is unchanged: no errors, the same line per repository", () => {
		const repo = emptyRepo();
		const lines: string[] = [];
		const outcome = installRepos([repo], { write: (text) => lines.push(text) });
		expect(outcome).toEqual({ failures: 0, errors: [] });
		expect(lines).toEqual([`✓ ${repo} — installed\n`]);
		const again: string[] = [];
		expect(installRepos([repo], { write: (text) => again.push(text) })).toEqual({ failures: 0, errors: [] });
		expect(again).toEqual([`✓ ${repo} — refreshed\n`]);
	});

	test("the CLI exits 1 for a failing repository, names it, and still installs the others", () => {
		const bad = emptyRepo();
		const good = emptyRepo();
		mkdirSync(hookPath(bad, "post-commit"), { recursive: true });
		const result = run(bad, good);
		expect(result.code).toBe(1);
		expect(result.out).toContain(`✗ ${bad} — install failed: `);
		expect(result.out).toContain(`✓ ${good} — installed`);
		expect(existsSync(hookPath(good, "post-commit"))).toBe(true);
	});

	test("a repository with several problems is counted once in failures, not once per problem", () => {
		const repo = emptyRepo();
		writeFileSync(hookPath(repo, "post-commit"), "#!/bin/sh\necho mine\n");
		writeFileSync(hookPath(repo, "post-merge"), "#!/bin/sh\necho mine\n");
		writeFileSync(hookPath(repo, "post-checkout"), "#!/bin/sh\necho mine\n");
		const lines: string[] = [];
		const outcome = installRepos([repo], { corpus: true, write: (text) => lines.push(text) });
		expect(outcome).toEqual({ failures: 1, errors: [] });
		expect(lines.some((line) => line.includes(`${repo} — post-merge foreign`))).toBe(true);
		expect(lines.some((line) => line.includes(`${repo} — post-checkout foreign`))).toBe(true);
	});
});
