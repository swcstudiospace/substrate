import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ScopedGitRunner, scopedGit } from "./repo-executor.ts";
import { REPO_REGISTRY_ENV, REPO_SCOPES_ENV, type RepoScope, repoScopeFromEnv } from "./repo-scope.ts";
import type { Surface } from "./types.ts";

interface Call {
	args: readonly string[];
	cwd: string;
	env: Record<string, string>;
}

/** A runner that records each call and never spawns git: a refusal must leave `calls` empty. */
function recorder(): { run: ScopedGitRunner; calls: Call[] } {
	const calls: Call[] = [];
	const run: ScopedGitRunner = (args, cwd, env) => {
		calls.push({ args, cwd, env });
		return { code: 0, stdout: "", stderr: "" };
	};
	return { run, calls };
}

interface Fixture {
	root: string;
	a: { checkout: string; worktrees: string };
	b: { checkout: string; worktrees: string };
}

function fixture(): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-exec-")));
	const make = (name: string) => {
		const checkout = join(root, name, "checkout");
		const worktrees = join(root, name, "worktrees");
		mkdirSync(checkout, { recursive: true });
		mkdirSync(worktrees, { recursive: true });
		return { checkout, worktrees };
	};
	return { root, a: make("a"), b: make("b") };
}

function scopeFor(f: Fixture, grants: Record<string, string[]> | null): RepoScope {
	const env: Record<string, string | undefined> = {
		[REPO_REGISTRY_ENV]: JSON.stringify({
			"owner/a": { checkouts: [f.a.checkout], worktrees: [f.a.worktrees] },
			"owner/b": { checkouts: [f.b.checkout], worktrees: [f.b.worktrees] },
		}),
	};
	if (grants !== null) env[REPO_SCOPES_ENV] = JSON.stringify(grants);
	const parsed = repoScopeFromEnv(env);
	if (!parsed.ok) throw new Error(parsed.problem);
	return parsed.value;
}

const ARGS = ["status", "--porcelain"] as const;

describe("scopedGit refusals run no git", () => {
	test("boundary: a path inside no registered repository is refused before the runner is called", () => {
		const f = fixture();
		const { run, calls } = recorder();
		const outcome = scopedGit({ scope: scopeFor(f, { omp: ["owner/a"] }), surface: "omp", repo: null, path: join(f.root, "stray"), args: ARGS }, run);
		expect(outcome).toEqual({ ok: false, reason: "path-not-registered" });
		expect(calls).toHaveLength(0);
	});

	test("boundary: a surface not granted the repository is refused before the runner is called", () => {
		const f = fixture();
		const { run, calls } = recorder();
		const outcome = scopedGit({ scope: scopeFor(f, { omp: ["owner/a"] }), surface: "cursor", repo: null, path: f.a.checkout, args: ARGS }, run);
		expect(outcome).toEqual({ ok: false, reason: "repo-not-granted" });
		expect(calls).toHaveLength(0);
	});

	test("boundary: a named repository that is not registered is refused before the runner is called", () => {
		const f = fixture();
		const { run, calls } = recorder();
		const outcome = scopedGit({ scope: scopeFor(f, { omp: ["owner/a", "owner/zzz"] }), surface: "omp", repo: "owner/zzz", path: null, args: ARGS }, run);
		expect(outcome).toEqual({ ok: false, reason: "repo-not-registered" });
		expect(calls).toHaveLength(0);
	});

	test("boundary: a path that belongs to a repository other than the one named is refused before the runner is called", () => {
		const f = fixture();
		const { run, calls } = recorder();
		const outcome = scopedGit({ scope: scopeFor(f, { omp: ["owner/a", "owner/b"] }), surface: "omp", repo: "owner/b", path: f.a.checkout, args: ARGS }, run);
		expect(outcome).toEqual({ ok: false, reason: "path-repo-mismatch" });
		expect(calls).toHaveLength(0);
	});

	test("boundary: with scoping off, an unregistered path is still refused, because a cross-repository step needs a registration", () => {
		const f = fixture();
		const { run, calls } = recorder();
		const outcome = scopedGit({ scope: scopeFor(f, null), surface: null, repo: null, path: join(f.root, "stray"), args: ARGS }, run);
		expect(outcome).toEqual({ ok: false, reason: "path-not-registered" });
		expect(calls).toHaveLength(0);
	});
});

describe("scopedGit granted calls", () => {
	test("a granted path runs git in its resolved target, with discovery ceilinged at the registered directory's parent", () => {
		const f = fixture();
		const { run, calls } = recorder();
		const target = join(f.a.checkout, "src");
		mkdirSync(target);
		const outcome = scopedGit({ scope: scopeFor(f, { omp: ["owner/a"] }), surface: "omp", repo: null, path: target, args: ARGS }, run);
		expect(outcome).toMatchObject({ ok: true, repo: "owner/a", target, root: f.a.checkout });
		expect(calls).toEqual([{ args: ARGS, cwd: target, env: { GIT_CEILING_DIRECTORIES: dirname(f.a.checkout) } }]);
	});

	test("a named repository with no path runs in its registered checkout", () => {
		const f = fixture();
		const { run, calls } = recorder();
		const outcome = scopedGit({ scope: scopeFor(f, { omp: ["owner/a"] }), surface: "omp", repo: "owner/a", path: null, args: ARGS }, run);
		expect(outcome).toMatchObject({ ok: true, repo: "owner/a", root: f.a.checkout, target: f.a.checkout });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cwd).toBe(f.a.checkout);
	});

	test("scoping off places a registered path without a grant, as the registry alone allows", () => {
		const f = fixture();
		const { run, calls } = recorder();
		const surface: Surface | null = null;
		const outcome = scopedGit({ scope: scopeFor(f, null), surface, repo: null, path: f.b.checkout, args: ARGS }, run);
		expect(outcome).toMatchObject({ ok: true, repo: "owner/b" });
		expect(calls).toHaveLength(1);
	});
});

describe("scopedGit refuses a nested checkout under a registered checkout", () => {
	test("a checkout nested under a registered checkout is refused by name before the runner is called, and the outer checkout still runs", () => {
		const f = fixture();
		mkdirSync(join(f.a.checkout, ".git"));
		const nested = join(f.a.checkout, "vendor", "lib");
		mkdirSync(join(nested, ".git"), { recursive: true });
		mkdirSync(join(nested, "src"));
		const scope = scopeFor(f, { omp: ["owner/a"] });
		const { run, calls } = recorder();
		expect(scopedGit({ scope, surface: "omp", repo: null, path: nested, args: ARGS }, run)).toEqual({ ok: false, reason: "nested-checkout" });
		expect(scopedGit({ scope, surface: "omp", repo: null, path: join(nested, "src"), args: ARGS }, run)).toEqual({ ok: false, reason: "nested-checkout" });
		expect(calls).toHaveLength(0);
		const outer = scopedGit({ scope, surface: "omp", repo: "owner/a", path: null, args: ARGS }, run);
		expect(outer).toMatchObject({ ok: true, repo: "owner/a", root: f.a.checkout });
		expect(calls).toEqual([{ args: ARGS, cwd: f.a.checkout, env: { GIT_CEILING_DIRECTORIES: dirname(f.a.checkout) } }]);
	});
});

describe("scopedGit refuses a nested checkout under a plain registered directory, and an unnamed linked worktree", () => {
	test("a nested checkout (a .git directory) under a registered plain directory is refused by name, and no git runs in it", () => {
		const f = fixture();
		// a.checkout has no .git of its own: it is a plain directory, and the repository nested in it is not registered.
		const nested = join(f.a.checkout, "vendor", "lib");
		mkdirSync(join(nested, ".git"), { recursive: true });
		const scope = scopeFor(f, { omp: ["owner/a"] });
		const { run, calls } = recorder();
		expect(scopedGit({ scope, surface: "omp", repo: null, path: nested, args: ARGS }, run)).toEqual({ ok: false, reason: "nested-checkout" });
		expect(calls).toHaveLength(0);
		const registered = scopedGit({ scope, surface: "omp", repo: "owner/a", path: null, args: ARGS }, run);
		expect(registered).toMatchObject({ ok: true, repo: "owner/a", root: f.a.checkout, target: f.a.checkout });
		expect(calls.map((call) => call.cwd)).toEqual([f.a.checkout]);
	});

	test("a linked worktree (a .git file) directly under a registered worktrees directory is refused by name, and no git runs in it", () => {
		const f = fixture();
		const linked = join(f.a.worktrees, "feat");
		mkdirSync(linked);
		writeFileSync(join(linked, ".git"), "gitdir: /elsewhere/.git/worktrees/feat\n");
		const scope = scopeFor(f, { omp: ["owner/a"] });
		const { run, calls } = recorder();
		expect(scopedGit({ scope, surface: "omp", repo: null, path: linked, args: ARGS }, run)).toEqual({ ok: false, reason: "nested-checkout" });
		expect(calls).toHaveLength(0);
	});

	test("a linked worktree is placed once the registry names it as a checkout of its own", () => {
		const f = fixture();
		const linked = join(f.a.worktrees, "feat");
		mkdirSync(linked);
		writeFileSync(join(linked, ".git"), "gitdir: /elsewhere/.git/worktrees/feat\n");
		const env: Record<string, string | undefined> = {
			[REPO_REGISTRY_ENV]: JSON.stringify({ "owner/a": { checkouts: [f.a.checkout, linked], worktrees: [f.a.worktrees] } }),
			[REPO_SCOPES_ENV]: JSON.stringify({ omp: ["owner/a"] }),
		};
		const parsed = repoScopeFromEnv(env);
		if (!parsed.ok) throw new Error(parsed.problem);
		const { run, calls } = recorder();
		expect(scopedGit({ scope: parsed.value, surface: "omp", repo: null, path: linked, args: ARGS }, run)).toMatchObject({ ok: true, repo: "owner/a", root: linked, target: linked });
		expect(calls.map((call) => call.cwd)).toEqual([linked]);
	});
});
