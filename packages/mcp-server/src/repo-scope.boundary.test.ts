/**
 * Phase 72 boundary tests at the doors: the service (worktree list and drift, shared by REST and MCP) and the corpus replies.
 * Two repositories, one credential granted only the first. Each test names the boundary it proves.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusProofReply, corpusStatusReply, type CorpusServiceDeps } from "./corpus/service.ts";
import type { CorpusRootKeeper } from "./corpus/root.ts";
import type { CorpusStore } from "./corpus/store.ts";
import { loadConfig } from "./config.ts";
import { REPO_REGISTRY_ENV, REPO_SCOPES_ENV, type RepoScope, repoScopeFromEnv } from "./repo-scope.ts";
import { Substrate } from "./service.ts";
import { MemoryWorktreeRegistry } from "./worktree-registry-fake.ts";
import type { ReportedWorktree, WorktreeListQuery } from "./worktree-registry.ts";


interface Two {
	root: string;
	a: string;
	b: string;
	registry: string;
}

/** `owner/a` and `owner/b`, each with a checkout that carries a `.git` entry so it reads as a checkout. */
function twoRepos(): Two {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-boundary-")));
	const make = (name: string) => {
		const checkout = join(root, name, "checkout");
		mkdirSync(join(checkout, ".git"), { recursive: true });
		mkdirSync(join(root, name, "worktrees"), { recursive: true });
		return checkout;
	};
	const a = make("a");
	const b = make("b");
	const registry = JSON.stringify({
		"owner/a": { checkouts: [a], worktrees: [join(root, "a", "worktrees")] },
		"owner/b": { checkouts: [b], worktrees: [join(root, "b", "worktrees")] },
	});
	return { root, a, b, registry };
}

function scopeEnv(repos: Two, grants: Record<string, string[]>): Record<string, string | undefined> {
	return { [REPO_REGISTRY_ENV]: repos.registry, [REPO_SCOPES_ENV]: JSON.stringify(grants), SUBSTRATE_WORKTREE_REGISTRY: "on" };
}

function scopeOf(env: Record<string, string | undefined>): RepoScope {
	const parsed = repoScopeFromEnv(env);
	if (!parsed.ok) throw new Error(parsed.problem);
	return parsed.value;
}

function reported(repo: string, path: string): ReportedWorktree {
	return {
		path,
		repo,
		branch: "feature/x",
		head: "a".repeat(40),
		base: "b".repeat(40),
		dirty: false,
		ahead: 0,
		behind: 0,
		last_commit_at: null,
		size_bytes: null,
		locked: false,
		primary: false,
		pr_state: "none",
	};
}

async function seededRegistry(): Promise<MemoryWorktreeRegistry> {
	const store = new MemoryWorktreeRegistry();
	const seenAt = new Date();
	await store.report({
		host: "host-1",
		reportedAt: seenAt,
		seenAt,
		ttlS: 30 * 86_400,
		worktrees: [reported("owner/a", "/w/a-1"), reported("owner/b", "/w/b-1")],
	});
	return store;
}

const ALL: WorktreeListQuery = { repo: null, host: null, state: "all", limit: 100 };

describe("worktree list (criterion 2: a credential reads only its own repository's worktrees)", () => {
	test("boundary: an unfiltered scoped list returns only the granted repository's rows, filtered in the store", async () => {
		const repos = twoRepos();
		const substrate = new Substrate(loadConfig(scopeEnv(repos, { omp: ["owner/a"] })), { index: null, greptime: null, worktrees: await seededRegistry() });
		const outcome = await substrate.listWorktrees(ALL, "omp");
		expect(outcome.ok).toBe(true);
		expect(outcome.ok && outcome.worktrees.map((row) => row.repo)).toEqual(["owner/a"]);
	});

	test("boundary: naming another repository is refused at the door, with no rows read", async () => {
		const repos = twoRepos();
		const substrate = new Substrate(loadConfig(scopeEnv(repos, { omp: ["owner/a"] })), { index: null, greptime: null, worktrees: await seededRegistry() });
		const outcome = await substrate.listWorktrees({ ...ALL, repo: "owner/b" }, "omp");
		expect(outcome).toMatchObject({ ok: false, status: 403, body: { error: "repo-not-granted" } });
	});

	test("boundary: an anonymous caller under scoping reads no rows", async () => {
		const repos = twoRepos();
		const substrate = new Substrate(loadConfig(scopeEnv(repos, { omp: ["owner/a"] })), { index: null, greptime: null, worktrees: await seededRegistry() });
		expect(await substrate.listWorktrees(ALL, null)).toEqual({ ok: true, worktrees: [], truncated: false });
	});

	test("scoping off lists every repository, as before", async () => {
		const repos = twoRepos();
		const env = { [REPO_REGISTRY_ENV]: repos.registry, SUBSTRATE_WORKTREE_REGISTRY: "on" };
		const substrate = new Substrate(loadConfig(env), { index: null, greptime: null, worktrees: await seededRegistry() });
		const outcome = await substrate.listWorktrees({ ...ALL, repo: "owner/b" }, null);
		expect(outcome.ok && outcome.worktrees.map((row) => row.repo)).toEqual(["owner/b"]);
	});
});

describe("drift scan (criterion 1 at the API: a repository outside the grant is refused before any git call)", () => {
	test("boundary: a path inside another repository is refused and runs no git", async () => {
		const repos = twoRepos();
		const substrate = new Substrate(loadConfig(scopeEnv(repos, { omp: ["owner/a"] })), { index: null, greptime: null });
		const spawn = spyOn(Bun, "spawnSync");
		try {
			const outcome = await substrate.scopedDriftScan({ repo: "owner/a", path: repos.b }, "omp");
			expect(outcome).toMatchObject({ ok: false, status: 403, body: { error: "repo-not-granted" } });
			expect(spawn.mock.calls.filter(([argv]) => Array.isArray(argv) && argv[0] === "git")).toHaveLength(0);
		} finally {
			spawn.mockRestore();
		}
	});

	test("boundary: a symlink inside a granted directory that points into another repository is refused and runs no git", async () => {
		const repos = twoRepos();
		const link = join(repos.root, "a", "worktrees", "to-b");
		symlinkSync(repos.b, link);
		const substrate = new Substrate(loadConfig(scopeEnv(repos, { omp: ["owner/a"] })), { index: null, greptime: null });
		const spawn = spyOn(Bun, "spawnSync");
		try {
			const outcome = await substrate.scopedDriftScan({ repo: "owner/a", path: link }, "omp");
			expect(outcome).toMatchObject({ ok: false, body: { error: "repo-not-granted" } });
			expect(spawn.mock.calls.filter(([argv]) => Array.isArray(argv) && argv[0] === "git")).toHaveLength(0);
		} finally {
			spawn.mockRestore();
		}
	});

	test("a granted path is scanned, reading the resolved target", async () => {
		const repos = twoRepos();
		const substrate = new Substrate(loadConfig(scopeEnv(repos, { omp: ["owner/a"] })), { index: null, greptime: null });
		const outcome = await substrate.scopedDriftScan({ repo: "owner/a", path: repos.a }, "omp");
		expect(outcome.ok).toBe(true);
	});
});

describe("corpus (criterion 2: a credential cannot read another repository's corpus)", () => {
	function corpusDeps(scope: RepoScope, reads: { count: number }): CorpusServiceDeps {
		return {
			settings: { enabled: true, concurrency: 1, batchDocs: 20, batchBytes: 1_000_000, freshMaxAgeS: 0 },
			vmGuest: false,
			// A refused door never reaches the manifest, so the store is only a presence marker for the gate.
			store: {} as CorpusStore,
			plane: null,
			emit: async () => undefined,
			roots: {
				read: async () => {
					reads.count += 1;
					return { ok: false };
				},
			} as unknown as CorpusRootKeeper,
			anchor: { ports: () => ({}) as never },
			repoScope: scope,
		};
	}

	test("boundary: the proof of another repository's document is refused before the corpus tree is read", async () => {
		const repos = twoRepos();
		const reads = { count: 0 };
		const deps = corpusDeps(scopeOf(scopeEnv(repos, { omp: ["owner/a"] })), reads);
		expect(await corpusProofReply(deps, { repo: "owner/b", path: "README.md" }, "omp")).toMatchObject({ ok: false, status: 403, body: { reason: "repo-not-granted" } });
		expect(reads.count).toBe(0);
	});

	test("boundary: the proof of a granted repository's document reads the tree", async () => {
		const repos = twoRepos();
		const reads = { count: 0 };
		const deps = corpusDeps(scopeOf(scopeEnv(repos, { omp: ["owner/a"] })), reads);
		await corpusProofReply(deps, { repo: "owner/a", path: "README.md" }, "omp");
		expect(reads.count).toBe(1);
	});

	test("boundary: the cross-repository status is refused to a scoped caller, with no manifest read", async () => {
		const repos = twoRepos();
		const reads = { count: 0 };
		const deps = corpusDeps(scopeOf(scopeEnv(repos, { omp: ["owner/a"] })), reads);
		expect(await corpusStatusReply(deps, "omp")).toMatchObject({ ok: false, status: 403, body: { reason: "all-repos-not-granted" } });
		expect(reads.count).toBe(0);
	});
});
