import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPO_ALLOWLIST_ENV, repoAllowlistFromEnv } from "./repo-allowlist.ts";
import { defaultScopedGitRunner, type ScopedGitRunner, type ScopedSession, scopedGit } from "./repo-executor.ts";
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

const CREDENTIAL_A = "REPO_EXEC_TEST_CREDENTIAL_A";
const CREDENTIAL_B = "REPO_EXEC_TEST_CREDENTIAL_B";
const UNRELATED = "REPO_EXEC_TEST_UNRELATED";

/** Runs `fn` with `vars` set in the parent environment, restoring each variable afterwards. */
function withParentEnv<T>(vars: Record<string, string>, fn: () => T): T {
	const saved = Object.keys(vars).map((name) => [name, process.env[name]] as const);
	Object.assign(process.env, vars);
	try {
		return fn();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

function sessionFor(): ScopedSession {
	const parsed = repoAllowlistFromEnv({ [REPO_ALLOWLIST_ENV]: JSON.stringify({ omp: { "owner/a": CREDENTIAL_A, "owner/b": CREDENTIAL_B } }) });
	if (!parsed.ok) throw new Error(parsed.problem);
	return { id: "omp", allowlist: parsed.value };
}

/**
 * The environment a real git child sees for one call. The `envdump` alias runs `env` in the child, so its output is exactly the
 * environment git handed to that child. The parent holds two repositories' credentials and one unrelated secret.
 */
function gitChildEnvironment(f: Fixture, repo: "owner/a" | "owner/b"): Record<string, string> {
	const outcome = withParentEnv({ [CREDENTIAL_A]: "secret-a", [CREDENTIAL_B]: "secret-b", [UNRELATED]: "unrelated-secret" }, () =>
		scopedGit(
			{ scope: scopeFor(f, { omp: ["owner/a", "owner/b"] }), surface: "omp", repo, path: null, args: ["-c", "alias.envdump=!env", "envdump"], session: sessionFor() },
			defaultScopedGitRunner,
		),
	);
	if (!outcome.ok || outcome.result.code !== 0) throw new Error(`git child did not run: ${JSON.stringify(outcome)}`);
	const child: Record<string, string> = {};
	for (const line of outcome.result.stdout.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0) child[line.slice(0, at)] = line.slice(at + 1);
	}
	return child;
}

describe("scopedGit child environment", () => {
	test("a git child for repo A receives its own credential and not repo B's", () => {
		const child = gitChildEnvironment(fixture(), "owner/a");
		expect(child.SUBSTRATE_REPO_CREDENTIAL).toBe("secret-a");
		expect(child[CREDENTIAL_B]).toBeUndefined();
		expect(Object.values(child)).not.toContain("secret-b");
		expect(child[UNRELATED]).toBeUndefined();
		expect(Object.values(child)).not.toContain("unrelated-secret");
	});

	test("a git child for repo B receives its own credential and not repo A's", () => {
		const child = gitChildEnvironment(fixture(), "owner/b");
		expect(child.SUBSTRATE_REPO_CREDENTIAL).toBe("secret-b");
		expect(child[CREDENTIAL_A]).toBeUndefined();
		expect(Object.values(child)).not.toContain("secret-a");
	});

	test("the git child keeps the variables git needs and the call's own git flags", () => {
		const f = fixture();
		const child = gitChildEnvironment(f, "owner/a");
		// git prepends its own exec path to the PATH of every child it runs, so the parent PATH is a suffix, not equal.
		expect((child.PATH ?? "").endsWith(process.env.PATH ?? "")).toBe(true);
		expect(child.HOME).toBe(process.env.HOME);
		expect(child.GIT_CEILING_DIRECTORIES).toBe(dirname(f.a.checkout));
		expect(child.GIT_TERMINAL_PROMPT).toBe("0");
		expect(child.GIT_OPTIONAL_LOCKS).toBe("0");
	});
});
