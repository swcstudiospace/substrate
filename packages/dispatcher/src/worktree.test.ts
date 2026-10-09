import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertValidGraphId,
	assertValidRepo,
	ensureWorktree,
	GRAPH_ID_PATTERN,
	InvalidGraphIdError,
	InvalidRepoError,
	MIN_FREE_BYTES,
	parseGitHubSlug,
	worktreeBranch,
	type EnsureWorktreeInput,
	type GitResult,
	type WorktreeDeps,
} from "./worktree.ts";

const GRAPH_ID = "ut-mkts36-abcdef01";
const REPO = "swcstudiospace/agent-substrate";

const AMPLE = { bavail: 100 * 1024 ** 3 / 4096, bsize: 4096 };
const EMPTY_DISK = { bavail: 1, bsize: 4096 };

const tmpBases: string[] = [];
afterEach(() => {
	while (tmpBases.length > 0) {
		const base = tmpBases.pop();
		if (base !== undefined) rmSync(base, { recursive: true, force: true });
	}
});

interface FakeGit {
	calls: Array<{ args: string[]; cwd?: string }>;
	impl: (args: string[], options?: { cwd?: string }) => Promise<GitResult> | GitResult;
}

function fakeGit(impl: FakeGit["impl"]): FakeGit {
	return { calls: [], impl };
}

interface Roots {
	base: string;
	worktreeRoot: string;
	checkoutsRoot: string;
}

function makeRoots(): Roots {
	const base = mkdtempSync(join(tmpdir(), "dispatcher-worktree-"));
	tmpBases.push(base);
	const worktreeRoot = join(base, "worktrees");
	const checkoutsRoot = join(base, "checkouts");
	mkdirSync(worktreeRoot, { recursive: true });
	mkdirSync(checkoutsRoot, { recursive: true });
	return { base, worktreeRoot, checkoutsRoot };
}

function makeDeps(roots: Roots, overrides: Partial<WorktreeDeps> = {}, git?: FakeGit): { deps: WorktreeDeps; git: FakeGit } {
	const runner =
		git ??
		fakeGit(() => {
			throw new Error("unexpected git call");
		});
	const deps: WorktreeDeps = {
		worktreeRoot: roots.worktreeRoot,
		checkoutsRoot: roots.checkoutsRoot,
		statfs: () => AMPLE,
		exists: (path) => existsSync(path),
		runGit: (args, options) => {
			runner.calls.push({ args, cwd: options?.cwd });
			return runner.impl(args, options);
		},
		...overrides,
	};
	return { deps, git: runner };
}

const okGetUrl = (url: string): GitResult => ({ status: 0, stdout: `${url}\n`, stderr: "" });

describe("worktree gate literals", () => {
	test("GRAPH_ID_PATTERN matches the service literal", () => {
		expect(GRAPH_ID_PATTERN.source).toBe(/^ut-[a-z0-9]+-[0-9a-f]{8}$/.source);
		expect(GRAPH_ID_PATTERN.test(GRAPH_ID)).toBe(true);
	});

	test("refusal threshold is 5 GiB", () => {
		expect(MIN_FREE_BYTES).toBe(5 * 1024 ** 3);
	});

	test("branch helper", () => {
		expect(worktreeBranch(GRAPH_ID)).toBe(`substrate/${GRAPH_ID}`);
	});
});

describe("parseGitHubSlug (assumption A3)", () => {
	const cases: Array<[string, string | null]> = [
		["https://github.com/owner/name.git", "owner/name"],
		["https://github.com/owner/name", "owner/name"],
		["https://github.com/owner/name/", "owner/name"],
		["https://github.com/Owner/Name.git", "owner/name"],
		["git@github.com:owner/name.git", "owner/name"],
		["git@github.com:owner/name", "owner/name"],
		["https://gitlab.com/owner/name.git", null],
		["git@gitlab.com:owner/name.git", null],
		["https://github.com/owner.git", null],
		["https://github.com/owner/name/extra.git", null],
		["not a url", null],
		["", null],
	];
	for (const [url, expected] of cases) {
		test(`parses ${url || "(empty)"}`, () => {
			expect(parseGitHubSlug(url)).toBe(expected);
		});
	}
});

describe("graph_id gate runs before any join", () => {
	const badIds = [
		"../tmp",
		"../../etc/passwd",
		"",
		"ut-ABC-12345678",
		"UT-mkts36-abcdef01",
		"ut-mkts36-xyz",
		"ut-mkts36-abcdef0",
		"ut-mkts36-abcdef012",
		"ut-mk_ts36-abcdef01",
		"ut-mkts36-ABCDEFGH",
		"substrate/ut-mkts36-abcdef01",
	];
	for (const graphId of badIds) {
		test(`rejects ${graphId || "(empty)"}`, async () => {
			const roots = makeRoots();
			let statfsCalls = 0;
			const git = fakeGit(() => ({ status: 0, stdout: "", stderr: "" }));
			const { deps } = makeDeps(
				roots,
				{
					statfs: () => {
						statfsCalls += 1;
						return AMPLE;
					},
				},
				git,
			);
			expect(() => assertValidGraphId(graphId)).toThrow(InvalidGraphIdError);
			await expect(ensureWorktree({ graphId, repo: REPO }, deps)).rejects.toThrow(InvalidGraphIdError);
			expect(statfsCalls).toBe(0);
			expect(git.calls).toHaveLength(0);
			expect(readdirSync(roots.worktreeRoot)).toHaveLength(0);
		});
	}

	test("invalid repo throws before statfs or git", async () => {
		const roots = makeRoots();
		let statfsCalls = 0;
		const git = fakeGit(() => ({ status: 0, stdout: "", stderr: "" }));
		const { deps } = makeDeps(
			roots,
			{
				statfs: () => {
					statfsCalls += 1;
					return AMPLE;
				},
			},
			git,
		);
		for (const repo of ["../escape", "owner", "a/b/c", "own er/name", "owner/name;rm -rf"]) {
			expect(() => assertValidRepo(repo)).toThrow(InvalidRepoError);
			await expect(ensureWorktree({ graphId: GRAPH_ID, repo }, deps)).rejects.toThrow(InvalidRepoError);
		}
		expect(statfsCalls).toBe(0);
		expect(git.calls).toHaveLength(0);
	});
});

describe("disk gate", () => {
	test("under 5 GiB refuses low-disk before git runs", async () => {
		const roots = makeRoots();
		const git = fakeGit(() => ({ status: 0, stdout: "", stderr: "" }));
		const { deps } = makeDeps(roots, { statfs: () => EMPTY_DISK }, git);
		const input: EnsureWorktreeInput = { graphId: GRAPH_ID, repo: REPO };
		const result = await ensureWorktree(input, deps);
		expect(result).toEqual({ ok: false, outcome: "low-disk" });
		expect(git.calls).toHaveLength(0);
		expect(existsSync(join(roots.worktreeRoot, GRAPH_ID))).toBe(false);
	});

	test("exactly 5 GiB free proceeds", async () => {
		const roots = makeRoots();
		mkdirSync(join(roots.checkoutsRoot, "swcstudiospace", "agent-substrate"), { recursive: true });
		const git = fakeGit(() => ({ status: 0, stdout: "", stderr: "" }));
		const { deps } = makeDeps(
			roots,
			{ statfs: () => ({ bavail: MIN_FREE_BYTES / 4096, bsize: 4096 }) },
			git,
		);
		const result = await ensureWorktree({ graphId: GRAPH_ID, repo: REPO }, deps);
		expect(result.ok).toBe(true);
		expect(git.calls).toHaveLength(1);
	});
});

describe("existing worktree reuse", () => {
	test("matching https origin is reused without worktree add", async () => {
		const roots = makeRoots();
		const worktreePath = join(roots.worktreeRoot, GRAPH_ID);
		mkdirSync(worktreePath, { recursive: true });
		const git = fakeGit((args) => {
			expect(args).toEqual(["-C", worktreePath, "remote", "get-url", "origin"]);
			return okGetUrl("https://github.com/swcstudiospace/agent-substrate.git");
		});
		const { deps } = makeDeps(roots, {}, git);
		const result = await ensureWorktree({ graphId: GRAPH_ID, repo: REPO }, deps);
		expect(result).toEqual({ ok: true, path: worktreePath, reused: true });
		expect(git.calls).toHaveLength(1);
	});

	test("matching ssh origin is reused (assumption A3, second form)", async () => {
		const roots = makeRoots();
		const worktreePath = join(roots.worktreeRoot, GRAPH_ID);
		mkdirSync(worktreePath, { recursive: true });
		const git = fakeGit(() => okGetUrl("git@github.com:swcstudiospace/agent-substrate.git"));
		const { deps } = makeDeps(roots, {}, git);
		const result = await ensureWorktree({ graphId: GRAPH_ID, repo: REPO }, deps);
		expect(result).toEqual({ ok: true, path: worktreePath, reused: true });
	});

	test("origin comparison is case-insensitive", async () => {
		const roots = makeRoots();
		const worktreePath = join(roots.worktreeRoot, GRAPH_ID);
		mkdirSync(worktreePath, { recursive: true });
		const git = fakeGit(() => okGetUrl("https://github.com/SWCStudioSpace/Agent-Substrate"));
		const { deps } = makeDeps(roots, {}, git);
		const result = await ensureWorktree({ graphId: GRAPH_ID, repo: REPO }, deps);
		expect(result).toEqual({ ok: true, path: worktreePath, reused: true });
	});

	test("non-matching origin is path-conflict, not reuse", async () => {
		const roots = makeRoots();
		const worktreePath = join(roots.worktreeRoot, GRAPH_ID);
		mkdirSync(worktreePath, { recursive: true });
		const git = fakeGit(() => okGetUrl("https://github.com/other-org/other-repo.git"));
		const { deps } = makeDeps(roots, {}, git);
		const result = await ensureWorktree({ graphId: GRAPH_ID, repo: REPO }, deps);
		expect(result).toEqual({ ok: false, outcome: "path-conflict" });
	});

	test("unparseable origin is path-conflict, never silent reuse", async () => {
		const roots = makeRoots();
		const worktreePath = join(roots.worktreeRoot, GRAPH_ID);
		mkdirSync(worktreePath, { recursive: true });
		const git = fakeGit(() => okGetUrl("https://gitlab.com/swcstudiospace/agent-substrate.git"));
		const { deps } = makeDeps(roots, {}, git);
		const result = await ensureWorktree({ graphId: GRAPH_ID, repo: REPO }, deps);
		expect(result).toEqual({ ok: false, outcome: "path-conflict" });
	});

	test("get-url failure is git-failed", async () => {
		const roots = makeRoots();
		const worktreePath = join(roots.worktreeRoot, GRAPH_ID);
		mkdirSync(worktreePath, { recursive: true });
		const git = fakeGit(() => ({ status: 128, stdout: "", stderr: "not a git repository" }));
		const { deps } = makeDeps(roots, {}, git);
		const result = await ensureWorktree({ graphId: GRAPH_ID, repo: REPO }, deps);
		expect(result).toEqual({ ok: false, outcome: "git-failed" });
	});

	test("get-url throw is git-failed", async () => {
		const roots = makeRoots();
		const worktreePath = join(roots.worktreeRoot, GRAPH_ID);
		mkdirSync(worktreePath, { recursive: true });
		const git = fakeGit(() => {
			throw new Error("spawn ENOENT");
		});
		const { deps } = makeDeps(roots, {}, git);
		const result = await ensureWorktree({ graphId: GRAPH_ID, repo: REPO }, deps);
		expect(result).toEqual({ ok: false, outcome: "git-failed" });
	});
});

describe("new worktree creation", () => {
	test("missing base clone is no-checkout and never runs git", async () => {
		const roots = makeRoots();
		const git = fakeGit(() => ({ status: 0, stdout: "", stderr: "" }));
		const { deps } = makeDeps(roots, {}, git);
		const result = await ensureWorktree({ graphId: GRAPH_ID, repo: REPO }, deps);
		expect(result).toEqual({ ok: false, outcome: "no-checkout" });
		expect(git.calls).toHaveLength(0);
	});

	test("null repo is no-checkout and never runs git", async () => {
		const roots = makeRoots();
		const git = fakeGit(() => ({ status: 0, stdout: "", stderr: "" }));
		const { deps } = makeDeps(roots, {}, git);
		const result = await ensureWorktree({ graphId: GRAPH_ID, repo: null }, deps);
		expect(result).toEqual({ ok: false, outcome: "no-checkout" });
		expect(git.calls).toHaveLength(0);
	});

	test("worktree add runs as argv from the base clone", async () => {
		const roots = makeRoots();
		const checkoutPath = join(roots.checkoutsRoot, "swcstudiospace", "agent-substrate");
		mkdirSync(checkoutPath, { recursive: true });
		const worktreePath = join(roots.worktreeRoot, GRAPH_ID);
		const git = fakeGit(() => ({ status: 0, stdout: "Preparing worktree", stderr: "" }));
		const { deps } = makeDeps(roots, {}, git);
		const result = await ensureWorktree({ graphId: GRAPH_ID, repo: REPO }, deps);
		expect(result).toEqual({ ok: true, path: worktreePath, reused: false });
		expect(git.calls).toHaveLength(1);
		expect(git.calls[0]?.args).toEqual([
			"worktree",
			"add",
			"-B",
			`substrate/${GRAPH_ID}`,
			worktreePath,
			"origin/main",
		]);
		expect(git.calls[0]?.cwd).toBe(checkoutPath);
	});

	test("worktree add failure is git-failed", async () => {
		const roots = makeRoots();
		mkdirSync(join(roots.checkoutsRoot, "swcstudiospace", "agent-substrate"), { recursive: true });
		const git = fakeGit(() => ({ status: 128, stdout: "", stderr: "fatal: invalid reference" }));
		const { deps } = makeDeps(roots, {}, git);
		const result = await ensureWorktree({ graphId: GRAPH_ID, repo: REPO }, deps);
		expect(result).toEqual({ ok: false, outcome: "git-failed" });
	});

	test("worktree add throw is git-failed", async () => {
		const roots = makeRoots();
		mkdirSync(join(roots.checkoutsRoot, "swcstudiospace", "agent-substrate"), { recursive: true });
		const git = fakeGit(() => {
			throw new Error("spawn failed");
		});
		const { deps } = makeDeps(roots, {}, git);
		const result = await ensureWorktree({ graphId: GRAPH_ID, repo: REPO }, deps);
		expect(result).toEqual({ ok: false, outcome: "git-failed" });
	});
});
