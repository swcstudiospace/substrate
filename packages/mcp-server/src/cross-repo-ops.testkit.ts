/**
 * Fixtures for the cross-repository operation tests: two real git repositories registered through the same env variables
 * production reads, a runner that records ref writes and can intercept a git call, and small readers for the outcome. Shared by
 * `cross-repo-ops.test.ts` (in-memory store) and `cross-repo-ops.pg.test.ts` (live Postgres). No production code imports this.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BranchFanoutRequest, CrossRepoDeps, CrossRepoOperation, CrossRepoOutcome, CrossRepoStore } from "./cross-repo-ops.ts";
import { MemoryCrossRepoStore } from "./cross-repo-fake.ts";
import { defaultScopedGitRunner, type ScopedGitResult, type ScopedGitRunner } from "./repo-executor.ts";
import { REPO_REGISTRY_ENV, REPO_SCOPES_ENV, type RepoScope, repoScopeFromEnv } from "./repo-scope.ts";
import type { Surface } from "./types.ts";

export const BRANCH = "feature/x";

/** One git call, for setup and for reading state. Throws on a non-zero exit: a broken fixture must fail loudly. */
export function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd, encoding: "utf8" }).trim();
}

/** The value of `ref` in `dir`, or null when it does not exist. */
export function refIn(dir: string, ref: string): string | null {
	const run = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: dir, encoding: "utf8" });
	return run.status === 0 ? run.stdout.trim() : null;
}

export interface Repos {
	root: string;
	checkoutA: string;
	checkoutB: string;
	scope: RepoScope;
	/** The environment the registry and the grants were read from. The engine is given the parsed scope, never this environment. */
	env: Readonly<Record<string, string>>;
}

/**
 * Two registered repositories on disk, each with one commit on `main`. The registry and the grants come from the env, as in production.
 * `null` grants leave `SUBSTRATE_REPO_SCOPES` unset, so scoping is off.
 */
export function repos(grants: Record<string, string[]> | null = { omp: ["owner/a", "owner/b"] }): Repos {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "cross-repo-")));
	const make = (name: string): string => {
		const checkout = join(root, name, "checkout");
		mkdirSync(join(root, name, "worktrees"), { recursive: true });
		mkdirSync(checkout, { recursive: true });
		git(checkout, ["init", "-q", "-b", "main"]);
		writeFileSync(join(checkout, "README"), `${name}\n`);
		git(checkout, ["add", "README"]);
		git(checkout, ["commit", "-q", "-m", "init"]);
		return checkout;
	};
	const checkoutA = make("a");
	const checkoutB = make("b");
	const registry = {
		"owner/a": { checkouts: [checkoutA], worktrees: [join(root, "a", "worktrees")] },
		"owner/b": { checkouts: [checkoutB], worktrees: [join(root, "b", "worktrees")] },
	};
	const env: Record<string, string> = { [REPO_REGISTRY_ENV]: JSON.stringify(registry) };
	if (grants !== null) env[REPO_SCOPES_ENV] = JSON.stringify(grants);
	const parsed = repoScopeFromEnv(env);
	if (!parsed.ok) throw new Error(parsed.problem);
	return { root, checkoutA, checkoutB, scope: parsed.value, env };
}

export interface World extends Repos {
	store: MemoryCrossRepoStore;
}

/** {@link repos} with an in-memory store, whose write count the unit tests assert on. */
export function world(grants?: Record<string, string[]> | null): World {
	return { ...repos(grants), store: new MemoryCrossRepoStore() };
}

export interface WriteCall {
	cwd: string;
	args: readonly string[];
}

/** An injected interception: return a result to replace the real git call, or undefined to let it run. */
export type Intercept = (args: readonly string[], cwd: string, env: Record<string, string>) => ScopedGitResult | undefined;

/**
 * The real git runner, with a record of every ref write and an optional interception. A write is recorded before the
 * interception runs, so a call that the interception crashes or fails is still counted.
 */
export function runnerWith(intercept?: Intercept): { run: ScopedGitRunner; writes: WriteCall[] } {
	const writes: WriteCall[] = [];
	const run: ScopedGitRunner = (args, cwd, env) => {
		if (args[0] === "update-ref") writes.push({ cwd, args: [...args] });
		const forced = intercept?.(args, cwd, env);
		return forced ?? defaultScopedGitRunner(args, cwd, env);
	};
	return { run, writes };
}

export const FAILED: ScopedGitResult = { code: 1, stdout: "", stderr: "injected failure" };

export function depsFor(w: Repos & { store: CrossRepoStore }, run: ScopedGitRunner, surface: Surface | null = "omp"): CrossRepoDeps {
	return { scope: w.scope, surface, store: w.store, run };
}

export function request(overrides: Partial<BranchFanoutRequest> = {}): BranchFanoutRequest {
	return { key: "op-1", branch: BRANCH, repos: [{ repo: "owner/a", base: "main" }, { repo: "owner/b", base: "main" }], ...overrides };
}

export function opOf(outcome: CrossRepoOutcome): CrossRepoOperation {
	if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);
	return outcome.operation;
}

export function orFail(op: CrossRepoOperation | null): CrossRepoOperation {
	if (op === null) throw new Error("expected a stored operation");
	return op;
}

export function stepStates(op: CrossRepoOperation): string[] {
	return op.steps.map((step) => `${step.repo}:${step.state}${step.detail === null ? "" : `/${step.detail}`}`);
}
