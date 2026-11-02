/**
 * Phase 72 at the corpus CLI: a `--root`, a `--repo` or a hook directory the repository registry does not place is refused
 * before any git call or hook write. Unset, the commands run as they did. Each test names the boundary it proves. Git is
 * counted through the injected runner, which records every call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EventInput } from "../../../mcp-server/src/types.ts";
import { REPO_REGISTRY_ENV, REPO_SCOPES_ENV } from "../../../mcp-server/src/repo-scope.ts";
import { CORPUS_HOOKS } from "../../../collectors/src/install-git-hook.ts";
import { type FakeGit, fakeGit, runGit, tempDir, writeTree } from "../../../corpus/src/test-support.ts";
import { localGitPermitted } from "./scope.ts";
import { runCorpus } from "./index.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HEAD = "e".repeat(40);

/** A fresh directory that holds one checkout, `alpha`, with origin Acme/Alpha. Two of these never nest. */
function checkoutRoot(): string {
	const root = realpathSync(tempDir("corpus-scope-"));
	dirs.push(root);
	writeTree(root, { "alpha/.git/HEAD": "", "alpha/README.md": "# alpha\n" });
	return root;
}

/** A git runner that knows the checkout under `root` and counts every call. */
function gitFor(root: string): FakeGit {
	return fakeGit({ [join(root, "alpha")]: { branch: "main", remoteDefault: "main", head: HEAD, origin: "git@github.com:Acme/Alpha.git", files: ["README.md"] } });
}

/** A fresh, empty git repository. */
function gitRepo(): string {
	const dir = realpathSync(tempDir("corpus-scope-repo-"));
	dirs.push(dir);
	runGit(dir, ["init", "-q"]);
	return dir;
}

/** The registry the operator would write: each named repository is registered at one directory. */
function registry(entries: Record<string, string>): string {
	return JSON.stringify(Object.fromEntries(Object.entries(entries).map(([repo, dir]) => [repo, { checkouts: [dir], worktrees: [] }])));
}

interface Run {
	code: number;
	out: string;
	err: string;
	audits: EventInput[];
}

async function run(argv: string[], env: Record<string, string | undefined>, runner?: FakeGit): Promise<Run> {
	const out: string[] = [];
	const err: string[] = [];
	const audits: EventInput[] = [];
	const code = await runCorpus(argv, {
		url: "http://127.0.0.1:1",
		token: undefined,
		timeoutMs: 2000,
		env,
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		runner,
		audit: async (event) => {
			audits.push(event);
			return { kind: "stored" };
		},
	});
	return { code, out: out.join(""), err: err.join(""), audits };
}

function hooksPresent(repo: string): string[] {
	return CORPUS_HOOKS.filter((hook) => existsSync(join(repo, ".git", "hooks", hook)));
}

describe("substrate corpus refuses an unregistered root or repository before any git call", () => {
	test("boundary: scan over an unregistered --root spawns no git and exits 2 naming the path", async () => {
		const registered = checkoutRoot();
		const stray = checkoutRoot();
		const runner = gitFor(stray);
		const result = await run(["scan", "--root", stray], { [REPO_REGISTRY_ENV]: registry({ "owner/acme": registered }) }, runner);
		expect(result.code).toBe(2);
		expect(runner.calls).toHaveLength(0);
		expect(result.err).toContain("refused");
		expect(result.err).toContain(stray);
	});

	test("boundary: reflect --repo naming an unregistered repository spawns no git and exits 2", async () => {
		const registered = checkoutRoot();
		const runner = gitFor(registered);
		const result = await run(["reflect", "--repo", "owner/other", "--root", registered], { [REPO_REGISTRY_ENV]: registry({ "owner/acme": registered }) }, runner);
		expect(result.code).toBe(2);
		expect(runner.calls).toHaveLength(0);
	});

	test("boundary: hook install with an unregistered --repo writes no hook", async () => {
		const registered = checkoutRoot();
		const repo = gitRepo();
		const result = await run(["hook", "install", "--repo", repo], { [REPO_REGISTRY_ENV]: registry({ "owner/acme": registered }) });
		expect(result.code).toBe(2);
		expect(hooksPresent(repo)).toEqual([]);
	});

	test("boundary: hook status with an unregistered --repo runs no git", async () => {
		const registered = checkoutRoot();
		const repo = gitRepo();
		const result = await run(["hook", "status", "--repo", repo], { [REPO_REGISTRY_ENV]: registry({ "owner/acme": registered }) });
		expect(result.code).toBe(2);
		expect(result.out).toBe("");
	});

	test("boundary: a scoped surface that is not granted a registered root is refused before any git call", async () => {
		const root = checkoutRoot();
		const runner = gitFor(root);
		const env = { [REPO_REGISTRY_ENV]: registry({ "owner/acme": root }), [REPO_SCOPES_ENV]: JSON.stringify({ "claude-code": [] }) };
		const result = await run(["scan", "--root", root], env, runner);
		expect(result.code).toBe(2);
		expect(runner.calls).toHaveLength(0);
	});

	test("boundary: a malformed registry refuses the command before any git call", async () => {
		const root = checkoutRoot();
		const runner = gitFor(root);
		const result = await run(["scan", "--root", root], { [REPO_REGISTRY_ENV]: "{not json" }, runner);
		expect(result.code).toBe(2);
		expect(runner.calls).toHaveLength(0);
		expect(result.err).toContain("not valid JSON");
	});

	test("the refusal is audited as one warning that carries a digest of the path, never the path", async () => {
		const registered = checkoutRoot();
		const stray = checkoutRoot();
		const result = await run(["scan", "--root", stray], { [REPO_REGISTRY_ENV]: registry({ "owner/acme": registered }) }, gitFor(stray));
		expect(result.audits).toHaveLength(1);
		const payload = result.audits[0]?.payload ?? {};
		expect(payload).toMatchObject({ route: "scan", reason: "path-not-registered" });
		expect(JSON.stringify(result.audits)).not.toContain(stray);
	});
});

describe("substrate corpus runs as before for registered repositories, and when the registry is unset", () => {
	test("positive control: scan over a registered root proceeds and runs git", async () => {
		const root = checkoutRoot();
		const runner = gitFor(root);
		const result = await run(["scan", "--root", root], { [REPO_REGISTRY_ENV]: registry({ "owner/acme": root }) }, runner);
		expect(result.code).toBe(0);
		expect(runner.calls.length).toBeGreaterThan(0);
	});

	test("positive control: hook install with a registered --repo proceeds and writes the hooks", async () => {
		const repo = gitRepo();
		const result = await run(["hook", "install", "--repo", repo], { [REPO_REGISTRY_ENV]: registry({ "owner/hooked": repo }) });
		expect(result.code).toBe(0);
		expect(hooksPresent(repo)).toHaveLength(CORPUS_HOOKS.length);
	});

	test("default off: with the registry unset, scan over any root runs git exactly as before", async () => {
		const root = checkoutRoot();
		const runner = gitFor(root);
		const result = await run(["scan", "--root", root], {}, runner);
		expect(result.code).toBe(0);
		expect(runner.calls.length).toBeGreaterThan(0);
		expect(result.audits).toHaveLength(0);
	});

	test("default off: with the registry blank, scan over any root runs git exactly as before", async () => {
		const root = checkoutRoot();
		const runner = gitFor(root);
		const result = await run(["scan", "--root", root], { [REPO_REGISTRY_ENV]: "  " }, runner);
		expect(result.code).toBe(0);
		expect(runner.calls.length).toBeGreaterThan(0);
	});
});

describe("the top-level CLI reads cwd git only inside a registered checkout", () => {
	test("boundary: an unregistered cwd is not read when the registry is set", () => {
		const registered = checkoutRoot();
		const stray = checkoutRoot();
		expect(localGitPermitted({ [REPO_REGISTRY_ENV]: registry({ "owner/acme": registered }) }, stray)).toBe(false);
	});

	test("positive control: a registered cwd is read", () => {
		const registered = checkoutRoot();
		expect(localGitPermitted({ [REPO_REGISTRY_ENV]: registry({ "owner/acme": registered }) }, join(registered, "alpha"))).toBe(true);
	});

	test("default off: with the registry unset every cwd is read as before", () => {
		expect(localGitPermitted({}, checkoutRoot())).toBe(true);
	});

	test("a malformed registry reads no cwd git", () => {
		expect(localGitPermitted({ [REPO_REGISTRY_ENV]: "[]" }, checkoutRoot())).toBe(false);
	});
});
