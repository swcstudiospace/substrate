import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRepoAllowed, CredentialScopeError, credentialValue, REPO_ALLOWLIST_ENV, RepoNotAllowedError, type RepoAllowlist, repoAllowlistFromEnv } from "./repo-allowlist.ts";
import { type ScopedGitRunner, scopedGit } from "./repo-executor.ts";
import { REPO_REGISTRY_ENV, type RepoScope, repoScopeFromEnv } from "./repo-scope.ts";

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
	a: string;
	b: string;
	scope: RepoScope;
}

/** Two registered repositories, `owner/a` and `owner/b`, each with one checkout on this host. */
function fixture(): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-allow-")));
	const a = join(root, "a", "checkout");
	const b = join(root, "b", "checkout");
	mkdirSync(a, { recursive: true });
	mkdirSync(b, { recursive: true });
	const parsed = repoScopeFromEnv({
		[REPO_REGISTRY_ENV]: JSON.stringify({
			"owner/a": { checkouts: [a], worktrees: [] },
			"owner/b": { checkouts: [b], worktrees: [] },
		}),
	});
	if (!parsed.ok) throw new Error(parsed.problem);
	return { a, b, scope: parsed.value };
}

function allowlistFromEnv(env: Record<string, string | undefined>): RepoAllowlist {
	const parsed = repoAllowlistFromEnv(env);
	if (!parsed.ok) throw new Error(parsed.problem);
	return parsed.value;
}

function allowlistOf(json: unknown): RepoAllowlist {
	return allowlistFromEnv({ [REPO_ALLOWLIST_ENV]: JSON.stringify(json) });
}

const ARGS = ["status", "--porcelain"] as const;

describe("a repository outside the session allowlist is refused before any git spawn", () => {
	test("a disallowed repository, a path inside it, and every repository when the allowlist is unset are refused", () => {
		const f = fixture();
		const session = { id: "s1", allowlist: allowlistOf({ s1: { "owner/a": "TOKEN_A" } }) };

		const named = recorder();
		expect(scopedGit({ scope: f.scope, surface: null, repo: "owner/b", path: null, args: ARGS, session }, named.run)).toEqual({ ok: false, reason: "repo-not-granted" });
		expect(named.calls).toEqual([]);

		const byPath = recorder();
		expect(scopedGit({ scope: f.scope, surface: null, repo: null, path: f.b, args: ARGS, session }, byPath.run)).toEqual({ ok: false, reason: "repo-not-granted" });
		expect(byPath.calls).toEqual([]);

		const unset = recorder();
		const unsetSession = { id: "s1", allowlist: allowlistFromEnv({}) };
		expect(scopedGit({ scope: f.scope, surface: null, repo: "owner/a", path: null, args: ARGS, session: unsetSession }, unset.run)).toEqual({ ok: false, reason: "repo-not-granted" });
		expect(unset.calls).toEqual([]);

		const allowed = recorder();
		expect(scopedGit({ scope: f.scope, surface: null, repo: "owner/a", path: null, args: ARGS, session }, allowed.run).ok).toBe(true);
		expect(allowed.calls.length).toBe(1);
	});
});

describe("an unknown repository is refused exactly like a disallowed one", () => {
	test("the same refusal, the same error, and no spawn for a repository that does not exist and one that exists but is not allowed", () => {
		const f = fixture();
		const list = allowlistOf({ s1: { "owner/a": "TOKEN_A" } });
		const session = { id: "s1", allowlist: list };

		const unknown = recorder();
		const disallowed = recorder();
		const unknownOutcome = scopedGit({ scope: f.scope, surface: null, repo: "owner/ghost", path: null, args: ARGS, session }, unknown.run);
		const disallowedOutcome = scopedGit({ scope: f.scope, surface: null, repo: "owner/b", path: null, args: ARGS, session }, disallowed.run);
		expect(unknownOutcome).toEqual(disallowedOutcome);
		expect(unknown.calls).toEqual([]);
		expect(disallowed.calls).toEqual([]);

		const messages = ["owner/ghost", "owner/b"].map((repo) => {
			try {
				assertRepoAllowed(list, "s1", repo);
				return null;
			} catch (error) {
				expect(error).toBeInstanceOf(RepoNotAllowedError);
				return (error as Error).message;
			}
		});
		expect(messages[0]).toBe("repository is not allowed for this session");
		expect(messages[1]).toBe(messages[0]);
	});
});

describe("a credential scoped to one repository cannot be used for another", () => {
	test("the grant for repo A resolves A's credential and throws when asked for repo B's", () => {
		const list = allowlistOf({ s1: { "owner/a": "TOKEN_A", "owner/b": "TOKEN_B" } });
		const env = { TOKEN_A: "secret-a", TOKEN_B: "secret-b" };
		const grantA = assertRepoAllowed(list, "s1", "owner/a");

		expect(credentialValue(grantA, "owner/a", env)).toBe("secret-a");
		expect(() => credentialValue(grantA, "owner/b", env)).toThrow(CredentialScopeError);
	});

	test("a git call for repo A runs with only repo A's credential in its env", () => {
		const f = fixture();
		const session = { id: "s1", allowlist: allowlistOf({ s1: { "owner/a": "TOKEN_A", "owner/b": "TOKEN_B" } }) };
		const previous = { a: process.env.TOKEN_A, b: process.env.TOKEN_B };
		process.env.TOKEN_A = "secret-a";
		process.env.TOKEN_B = "secret-b";
		try {
			const rec = recorder();
			expect(scopedGit({ scope: f.scope, surface: null, repo: "owner/a", path: null, args: ARGS, session }, rec.run).ok).toBe(true);
			expect(rec.calls[0]?.env.SUBSTRATE_REPO_CREDENTIAL).toBe("secret-a");
			expect(Object.values(rec.calls[0]?.env ?? {})).not.toContain("secret-b");
		} finally {
			if (previous.a === undefined) delete process.env.TOKEN_A;
			else process.env.TOKEN_A = previous.a;
			if (previous.b === undefined) delete process.env.TOKEN_B;
			else process.env.TOKEN_B = previous.b;
		}
	});
});
