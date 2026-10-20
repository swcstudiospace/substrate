import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkScratch,
	commit,
	COMMIT_MESSAGE_MAX,
	commitArgv,
	execFileRunner,
	type GitSite,
	gitPush,
	originMatches,
	PR_BODY_MAX,
	PR_TITLE_MAX,
	prCreate,
	prCreateArgv,
	pushArgv,
	type RunResult,
	type Runner,
	scratchPaths,
} from "./hostfns.ts";
import type { GraphView } from "./substrate.ts";
import { MemoryTaskStore, type TaskRecord } from "./tasks.ts";

const GID = "ut-a-12345678";
const NID = "n1";
const WT = `/var/lib/substrate/worktrees/${GID}`;
const GD = `/var/lib/substrate/repo/.git/worktrees/${GID}`;
const BRANCH = `substrate/${GID}`;
const REPO = "swcstudiospace/agent-substrate";
const SITE: GitSite = { worktree: WT, gitDir: GD };

/** The argv every host git call starts with: the site pinned by path, hooks and fsmonitor off. */
function guard(site: GitSite): string[] {
	return ["git", "-C", site.worktree, `--git-dir=${site.gitDir}`, `--work-tree=${site.worktree}`, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
}
const GUARD_LEN = guard(SITE).length;

type Fixture = { root: string; worktree: string; gitDir: string };
const made: string[] = [];
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A host-shaped worktree under a temp root: `<root>/<gid>/.git` is a gitdir file into a real `.git/worktrees/` directory. */
function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "substrate-hostfns-"));
	made.push(root);
	const worktree = join(root, GID);
	const gitDir = join(root, "repo", ".git", "worktrees", GID);
	mkdirSync(worktree);
	mkdirSync(gitDir, { recursive: true });
	writeFileSync(join(worktree, ".git"), `gitdir: ${gitDir}\n`);
	writeFileSync(join(gitDir, "gitdir"), `${join(worktree, ".git")}\n`);
	return { root, worktree, gitDir: realpathSync(gitDir) };
}

const FIXTURE = fixture();
const FIXTURE_SITE: GitSite = { worktree: FIXTURE.worktree, gitDir: FIXTURE.gitDir };

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
	return {
		graph_id: GID,
		node_id: NID,
		identifier: "SWC-42",
		repo: REPO,
		session_id: NID,
		prompt_count: 1,
		turn_in_flight: true,
		last_stop_reason: null,
		exit_code: null,
		released: false,
		pending_approvals: [],
		opened_at: "2026-09-25T00:00:00Z",
		last_error: null,
		seeded: [],
		resumes: 0,
		stale_approvals: 0,
		pr_url: null,
		pr_number: null,
		synced_at: null,
		sync_by: null,
		approvals_allowed: 0,
		approvals_denied: 0,
		...overrides,
	};
}

const GRAPH: GraphView = { graph_id: GID, repo: REPO, branch: "main", nodes: [] };

/** A fake runner keyed by the argv after the git guard (or the full argv for gh). Every call is recorded. */
function fakeRunner(replies: Record<string, Partial<RunResult>>): { run: Runner; calls: string[][] } {
	const calls: string[][] = [];
	const run: Runner = async (argv) => {
		calls.push([...argv]);
		const key = argv[0] === "git" ? argv.slice(GUARD_LEN).join(" ") : argv.join(" ");
		const reply = replies[key];
		if (!reply) return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
		return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
	};
	return { run, calls };
}

const CLEAN_REPLIES = {
	"rev-parse --abbrev-ref HEAD": { stdout: `${BRANCH}\n` },
	"remote get-url origin": { stdout: "https://github.com/swcstudiospace/agent-substrate.git\n" },
	"diff --name-only origin/main...HEAD": { stdout: "packages/host/src/x.ts\nREADME.md\n" },
	[`push origin ${BRANCH}`]: { stdout: "", stderr: "To github.com:x\n * [new branch]" },
};

function ctx(
	replies: Record<string, Partial<RunResult>>,
	storeRecord: TaskRecord | null = record(),
	graph: GraphView | null = GRAPH,
	worktreeRoot: string = FIXTURE.root,
) {
	const store = new MemoryTaskStore();
	if (storeRecord) store.save(storeRecord);
	const runner = fakeRunner(replies);
	return {
		store,
		calls: runner.calls,
		ctx: { graphId: GID, nodeId: NID, store, substrate: { graphGet: async () => graph }, run: runner.run, worktreeRoot },
	};
}

describe("argv builders (T-03-07-01)", () => {
	test("pushArgv is exactly git -C <worktree> --git-dir --work-tree with hooks and fsmonitor off, then push origin substrate/<gid>: no --force, no colon refspec", () => {
		expect(pushArgv(SITE, GID)).toEqual([
			"git",
			"-C",
			WT,
			`--git-dir=${GD}`,
			`--work-tree=${WT}`,
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
			"push",
			"origin",
			BRANCH,
		]);
		expect(pushArgv(SITE, GID).some((a) => a.includes("--force") || a === "-f")).toBe(false);
		expect(pushArgv(SITE, GID).some((a) => a.includes(":"))).toBe(false);
		expect(() => pushArgv(SITE, "../etc")).toThrow(/graph id/);
	});

	test("prCreateArgv is gh pr create --repo --head substrate/<gid> --base --title --body; refuses long title/body and a bad repo slug", () => {
		const argv = prCreateArgv({ repo: REPO, graphId: GID, base: "main", title: "t", body: "b" });
		expect(argv).toEqual(["gh", "pr", "create", "--repo", REPO, "--head", BRANCH, "--base", "main", "--title", "t", "--body", "b"]);
		expect(() => prCreateArgv({ repo: REPO, graphId: GID, base: "main", title: "x".repeat(PR_TITLE_MAX + 1), body: "b" })).toThrow(/title/);
		expect(() => prCreateArgv({ repo: REPO, graphId: GID, base: "main", title: "t", body: "x".repeat(PR_BODY_MAX + 1) })).toThrow(/body/);
		expect(() => prCreateArgv({ repo: REPO, graphId: GID, base: "main", title: "", body: "b" })).toThrow(/title/);
		expect(() => prCreateArgv({ repo: "no-slash", graphId: GID, base: "main", title: "t", body: "b" })).toThrow(/repo/);
		expect(() => prCreateArgv({ repo: "a/../b", graphId: GID, base: "main", title: "t", body: "b" })).toThrow(/repo/);
		expect(() => prCreateArgv({ repo: REPO, graphId: GID, base: "--force", title: "t", body: "b" })).toThrow(/base/);
		expect(() => prCreateArgv({ repo: REPO, graphId: GID, base: "a..b", title: "t", body: "b" })).toThrow(/base/);
		expect(PR_TITLE_MAX).toBe(256);
		expect(PR_BODY_MAX).toBe(20_000);
	});

	test("commitArgv is two argvs: add -A with the .substrate-* exclude pathspec, then commit -m with a fixed identity; long messages refused", () => {
		const [add, commitArgs] = commitArgv(SITE, "03-07 smoke");
		expect(add).toEqual([...guard(SITE), "add", "-A", "--", ".", ":(exclude,glob)**/.substrate-*"]);
		expect(commitArgs).toEqual([
			...guard(SITE),
			"-c",
			"user.name=substrate claude-code",
			"-c",
			"user.email=claude-code@substrate.local",
			"commit",
			"-m",
			"03-07 smoke",
		]);
		expect(() => commitArgv(SITE, "x".repeat(COMMIT_MESSAGE_MAX + 1))).toThrow(/message/);
		expect(() => commitArgv(SITE, "   ")).toThrow(/message/);
		expect(() => commitArgv(SITE, "-m evil")).toThrow(/message/);
		expect(COMMIT_MESSAGE_MAX).toBe(2_000);
	});
});

describe("scratch guard (T-03-07-07)", () => {
	test("scratchPaths keeps the paths whose last segment starts with .substrate-", () => {
		const diff = "a/b.ts\n.substrate-hook-input.json\nsrc/.substrate-x/keep.ts\nsrc/deep/.substrate-scratch\nsubstrate-not-dot.txt\n\n";
		expect(scratchPaths(diff)).toEqual([".substrate-hook-input.json", "src/deep/.substrate-scratch"]);
		expect(scratchPaths("")).toEqual([]);
	});

	test("checkScratch runs git diff --name-only origin/<base>...HEAD and refuses naming the scratch files; a failed diff refuses too", async () => {
		const dirty = fakeRunner({ "diff --name-only origin/main...HEAD": { stdout: "x.ts\n.substrate-hook-input.json\n" } });
		const refused = await checkScratch({ graphId: GID, base: "main", run: dirty.run, worktreeRoot: FIXTURE.root });
		expect(refused).toEqual({ ok: false, reason: "branch contains substrate scratch files: .substrate-hook-input.json", paths: [".substrate-hook-input.json"] });
		expect(dirty.calls).toEqual([[...guard(FIXTURE_SITE), "diff", "--name-only", "origin/main...HEAD"]]);

		const clean = fakeRunner({ "diff --name-only origin/main...HEAD": { stdout: "x.ts\n" } });
		expect(await checkScratch({ graphId: GID, base: "main", run: clean.run, worktreeRoot: FIXTURE.root })).toEqual({ ok: true });

		const broken = fakeRunner({ "diff --name-only origin/main...HEAD": { code: 128, stderr: "fatal: bad revision" } });
		const failed = await checkScratch({ graphId: GID, base: "main", run: broken.run, worktreeRoot: FIXTURE.root });
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.reason).toContain("bad revision");
	});

	test("git-push refuses a branch with scratch files before any push argv runs", async () => {
		const c = ctx({ ...CLEAN_REPLIES, "diff --name-only origin/main...HEAD": { stdout: "x.ts\nsrc/.substrate-hook-input.json\n" } });
		const result = await gitPush(c.ctx);
		expect(result).toEqual({ error: "branch contains substrate scratch files: src/.substrate-hook-input.json" });
		expect(c.calls.some((argv) => argv.includes("push"))).toBe(false);
	});
});

describe("gitPush executor (T-03-07-01)", () => {
	test("pushes only when HEAD is substrate/<gid>, origin names the graph's repo and the diff is clean", async () => {
		const c = ctx(CLEAN_REPLIES);
		const result = await gitPush(c.ctx);
		expect(result).toEqual({ pushed: BRANCH, output: "To github.com:x\n * [new branch]" });
		expect(c.calls.at(-1)).toEqual([...guard(FIXTURE_SITE), "push", "origin", BRANCH]);
		// The origin check is exact: this owner/repo on github.com, https or scp form, optional .git.
		expect(originMatches("git@github.com:SWCstudiospace/agent-substrate.git", REPO)).toBe(true);
		expect(originMatches("https://github.com/other/agent-substrate.git", REPO)).toBe(false);
	});

	test("origin must be exactly the repo: a foreign host or a longer path ending in the slug is refused", async () => {
		expect(originMatches("https://github.com/swcstudiospace/agent-substrate", REPO)).toBe(true);
		expect(originMatches("https://github.com/SWCstudiospace/Agent-Substrate.git", REPO)).toBe(true);
		expect(originMatches("https://evil.example/swcstudiospace/agent-substrate.git", REPO)).toBe(false);
		expect(originMatches("https://github.com/evil/swcstudiospace/agent-substrate.git", REPO)).toBe(false);
		expect(originMatches("http://github.com/swcstudiospace/agent-substrate.git", REPO)).toBe(false);
		expect(originMatches("ssh://git@github.com/swcstudiospace/agent-substrate.git", REPO)).toBe(false);
		expect(originMatches("https://github.com/swcstudiospace/agent-substrate/extra", REPO)).toBe(false);

		const c = ctx({ ...CLEAN_REPLIES, "remote get-url origin": { stdout: "https://evil.example/swcstudiospace/agent-substrate.git\n" } });
		expect(await gitPush(c.ctx)).toEqual({ error: `origin does not name ${REPO}` });
		expect(c.calls.some((argv) => argv.includes("push"))).toBe(false);
	});

	test("refuses when HEAD is not substrate/<gid>", async () => {
		const c = ctx({ ...CLEAN_REPLIES, "rev-parse --abbrev-ref HEAD": { stdout: "main\n" } });
		expect(await gitPush(c.ctx)).toEqual({ error: `worktree is on main, not ${BRANCH}` });
		expect(c.calls.some((argv) => argv.includes("push"))).toBe(false);
	});

	test("refuses when origin does not name the graph's repo", async () => {
		const c = ctx({ ...CLEAN_REPLIES, "remote get-url origin": { stdout: "https://github.com/someone-else/fork.git\n" } });
		const result = await gitPush(c.ctx);
		expect(result).toEqual({ error: `origin does not name ${REPO}` });
		expect(c.calls.some((argv) => argv.includes("push"))).toBe(false);
	});

	test("refuses a node without a task record, and a graph the index does not know", async () => {
		const noRecord = ctx(CLEAN_REPLIES, null);
		expect(await gitPush(noRecord.ctx)).toEqual({ error: `no task for node ${NID} in this VM` });
		expect(noRecord.calls).toEqual([]);
		const noGraph = ctx(CLEAN_REPLIES, record(), null);
		expect(await gitPush(noGraph.ctx)).toEqual({ error: `graph ${GID} is not registered` });
		expect(noGraph.calls).toEqual([]);
	});

	test("a base branch git refuses is a refusal, not a throw, and runs no git call", async () => {
		const c = ctx(CLEAN_REPLIES, record(), { ...GRAPH, branch: "main.lock" });
		expect(await gitPush(c.ctx)).toEqual({ error: `graph ${GID} names no valid base branch` });
		expect(c.calls).toEqual([]);

		const scratch = fakeRunner({});
		expect(await checkScratch({ graphId: GID, base: "main.lock", run: scratch.run, worktreeRoot: FIXTURE.root })).toEqual({
			ok: false,
			reason: 'invalid base branch "main.lock"',
			paths: [],
		});
		expect(scratch.calls).toEqual([]);
	});

	test("a failed push returns its exit code and a capped output tail, never throws", async () => {
		const c = ctx({ ...CLEAN_REPLIES, [`push origin ${BRANCH}`]: { code: 1, stderr: "! [rejected] non-fast-forward" } });
		const result = await gitPush(c.ctx);
		expect(result).toEqual({ error: "git push exited 1: ! [rejected] non-fast-forward" });
	});
});

describe("worktree .git trust boundary: the guest can rewrite .git through the mount", () => {
	/** Points the worktree's `.git` file at `target`. */
	function pointAt(f: Fixture, target: string): void {
		rmSync(join(f.worktree, ".git"));
		writeFileSync(join(f.worktree, ".git"), `gitdir: ${target}\n`);
	}

	const refusals: Array<[string, (f: Fixture) => void]> = [
		["a missing .git", (f) => rmSync(join(f.worktree, ".git"))],
		[
			"a .git directory",
			(f) => {
				rmSync(join(f.worktree, ".git"));
				mkdirSync(join(f.worktree, ".git"));
			},
		],
		[
			"a .git symlink to a valid gitdir file",
			(f) => {
				const pointer = join(f.root, "pointer");
				writeFileSync(pointer, `gitdir: ${f.gitDir}\n`);
				rmSync(join(f.worktree, ".git"));
				symlinkSync(pointer, join(f.worktree, ".git"));
			},
		],
		[
			"a gitdir outside any .git/worktrees/ directory",
			(f) => {
				const elsewhere = join(f.root, "elsewhere");
				mkdirSync(elsewhere);
				pointAt(f, elsewhere);
			},
		],
		["a gitdir that escapes .git/worktrees/ by traversal", (f) => pointAt(f, `${f.gitDir}/../../..`)],
		[
			"a gitdir inside the worktree",
			(f) => {
				const inner = join(f.worktree, "evil", ".git", "worktrees", "x");
				mkdirSync(inner, { recursive: true });
				pointAt(f, inner);
			},
		],
		[
			"a gitdir that does not exist",
			(f) => pointAt(f, join(f.root, "missing", ".git", "worktrees", GID)),
		],
		["a relative gitdir", (f) => pointAt(f, `../repo/.git/worktrees/${GID}`)],
		[
			"a gitdir that names a file",
			(f) => {
				const file = join(f.root, "repo", ".git", "worktrees", "file");
				writeFileSync(file, "");
				pointAt(f, file);
			},
		],
		[
			"a gitdir with no back-pointer",
			(f) => rmSync(join(f.gitDir, "gitdir")),
		],
		[
			"a gitdir registered to another graph's worktree",
			(f) => {
				const other = join(f.root, `${GID}-other`);
				const otherGitDir = join(f.root, "repo", ".git", "worktrees", `${GID}-other`);
				mkdirSync(other);
				mkdirSync(otherGitDir, { recursive: true });
				writeFileSync(join(otherGitDir, "gitdir"), `${join(other, ".git")}\n`);
				pointAt(f, otherGitDir);
			},
		],
	];

	for (const [name, plant] of refusals) {
		test(`gitPush refuses ${name} and runs no git call`, async () => {
			const f = fixture();
			plant(f);
			const c = ctx(CLEAN_REPLIES, record(), GRAPH, f.root);
			expect(await gitPush(c.ctx)).toEqual({ error: expect.stringMatching(/^worktree \.git /) });
			expect(c.calls).toEqual([]);
		});
	}

	test("commit refuses a worktree whose .git is a directory, before any git call", async () => {
		const f = fixture();
		rmSync(join(f.worktree, ".git"));
		mkdirSync(join(f.worktree, ".git"));
		const c = ctx({}, record(), GRAPH, f.root);
		expect(await commit({ ...c.ctx, message: "m" })).toEqual({ error: "worktree .git is not a regular file" });
		expect(c.calls).toEqual([]);
	});
});

describe("host git runner environment", () => {
	test("the production runner passes the system-config and prompt guards in the environment", async () => {
		const result = await execFileRunner(["sh", "-c", 'printf "%s|%s" "$GIT_CONFIG_NOSYSTEM" "$GIT_TERMINAL_PROMPT"']);
		expect(result).toEqual({ code: 0, stdout: "1|0", stderr: "" });
	});
});

describe("prCreate executor (T-03-07-05)", () => {
	const PR_ARGV = ["gh", "pr", "create", "--repo", REPO, "--head", BRANCH, "--base", "main", "--title", "Title", "--body", "Body"].join(" ");

	test("runs gh pr create with the graph's repo/base and records pr_url and pr_number", async () => {
		const c = ctx({ [PR_ARGV]: { stdout: `Creating pull request for ${BRANCH} into main in ${REPO}\n\nhttps://github.com/${REPO}/pull/41\n` } });
		const result = await prCreate({ ...c.ctx, title: "Title", body: "Body" });
		expect(result).toEqual({ pr_url: `https://github.com/${REPO}/pull/41`, pr_number: 41, existing: false });
		expect(c.calls).toEqual([PR_ARGV.split(" ")]);
		expect(c.store.get(GID, NID)?.pr_url).toBe(`https://github.com/${REPO}/pull/41`);
		expect(c.store.get(GID, NID)?.pr_number).toBe(41);
	});

	test("returns the recorded URL without running gh when pr_url is already set", async () => {
		const c = ctx({}, record({ pr_url: `https://github.com/${REPO}/pull/7`, pr_number: 7 }));
		expect(await prCreate({ ...c.ctx, title: "Title", body: "Body" })).toEqual({ pr_url: `https://github.com/${REPO}/pull/7`, pr_number: 7, existing: true });
		expect(c.calls).toEqual([]);
	});

	test("refuses an over-long title or body and a missing record before running gh", async () => {
		const c = ctx({});
		expect(await prCreate({ ...c.ctx, title: "x".repeat(PR_TITLE_MAX + 1), body: "b" })).toEqual({ error: `title exceeds ${PR_TITLE_MAX} characters` });
		expect(await prCreate({ ...c.ctx, title: "t", body: "x".repeat(PR_BODY_MAX + 1) })).toEqual({ error: `body exceeds ${PR_BODY_MAX} characters` });
		const noRecord = ctx({}, null);
		expect(await prCreate({ ...noRecord.ctx, title: "t", body: "b" })).toEqual({ error: `no task for node ${NID} in this VM` });
		expect(c.calls).toEqual([]);
	});

	test("a gh failure or an output without the repo's PR URL records nothing", async () => {
		const c = ctx({ [PR_ARGV]: { code: 1, stderr: "pull request create failed: GraphQL: A pull request already exists" } });
		expect(await prCreate({ ...c.ctx, title: "Title", body: "Body" })).toEqual({
			error: "gh pr create exited 1: pull request create failed: GraphQL: A pull request already exists",
		});
		expect(c.store.get(GID, NID)?.pr_url).toBeNull();
		const wrong = ctx({ [PR_ARGV]: { stdout: "https://github.com/other/repo/pull/3\n" } });
		expect(await prCreate({ ...wrong.ctx, title: "Title", body: "Body" })).toEqual({ error: "gh pr create printed no pull request URL for swcstudiospace/agent-substrate" });
		expect(wrong.store.get(GID, NID)?.pr_number).toBeNull();
	});
});

describe("commit executor (c:hostfn_commit)", () => {
	test("runs add (with the exclude pathspec) then commit on the host worktree and returns the new sha", async () => {
		const c = ctx({
			"add -A -- . :(exclude,glob)**/.substrate-*": {},
			"-c user.name=substrate claude-code -c user.email=claude-code@substrate.local commit -m 03-07 smoke": { stdout: "[substrate/x 1234567] 03-07 smoke\n" },
			"rev-parse HEAD": { stdout: "1234567890abcdef1234567890abcdef12345678\n" },
		});
		expect(await commit({ ...c.ctx, message: "03-07 smoke" })).toEqual({ committed: true, sha: "1234567890abcdef1234567890abcdef12345678" });
		expect(c.calls.map((argv) => argv.slice(GUARD_LEN).join(" "))).toEqual([
			"add -A -- . :(exclude,glob)**/.substrate-*",
			"-c user.name=substrate claude-code -c user.email=claude-code@substrate.local commit -m 03-07 smoke",
			"rev-parse HEAD",
		]);
	});

	test("refuses a message over the limit or a missing record before running git; a git failure is reported", async () => {
		const c = ctx({});
		expect(await commit({ ...c.ctx, message: "x".repeat(COMMIT_MESSAGE_MAX + 1) })).toEqual({ error: `message exceeds ${COMMIT_MESSAGE_MAX} characters` });
		expect(c.calls).toEqual([]);
		const noRecord = ctx({}, null);
		expect(await commit({ ...noRecord.ctx, message: "m" })).toEqual({ error: `no task for node ${NID} in this VM` });
		const nothing = ctx({
			"add -A -- . :(exclude,glob)**/.substrate-*": {},
			"-c user.name=substrate claude-code -c user.email=claude-code@substrate.local commit -m m": { code: 1, stdout: "nothing to commit, working tree clean\n" },
		});
		expect(await commit({ ...nothing.ctx, message: "m" })).toEqual({ error: "git commit exited 1: nothing to commit, working tree clean" });
	});
});

describe("host git plumbing carries no credential value (32-03, D32-07)", () => {
	test("a full commit→push→pr-create sequence records no planted value in any argv or output, with fixed targets", async () => {
		const planted = "hb_test_4a7e1b5d48f09f2c6e9b2d5f807163c3";
		const store = new MemoryTaskStore();
		store.save(record());
		const calls: string[][] = [];
		const outputs: string[] = [];
		const run: Runner = async (argv) => {
			calls.push([...argv]);
			const key = argv[0] === "git" ? argv.slice(GUARD_LEN).join(" ") : argv.join(" ");
			let reply: RunResult;
			if (key.startsWith("gh pr create")) {
				reply = { code: 0, stdout: `https://github.com/${REPO}/pull/99\n`, stderr: "" };
			} else if (key === "rev-parse --abbrev-ref HEAD") {
				reply = { code: 0, stdout: `${BRANCH}\n`, stderr: "" };
			} else if (key === "remote get-url origin") {
				reply = { code: 0, stdout: `https://github.com/${REPO}.git\n`, stderr: "" };
			} else if (key === "diff --name-only origin/main...HEAD") {
				reply = { code: 0, stdout: "packages/host/src/x.ts\n", stderr: "" };
			} else if (key === "rev-parse HEAD") {
				reply = { code: 0, stdout: "1234567890abcdef1234567890abcdef12345678\n", stderr: "" };
			} else if (key.startsWith("push origin ") || key.startsWith("add -A") || key.includes("commit -m")) {
				reply = { code: 0, stdout: "", stderr: "" };
			} else {
				return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
			}
			outputs.push(`${reply.stdout}${reply.stderr}`);
			return reply;
		};
		const base = { graphId: GID, nodeId: NID, store, substrate: { graphGet: async () => GRAPH }, run, worktreeRoot: FIXTURE.root };
		expect(await commit({ ...base, message: "worked node" })).toEqual({ committed: true, sha: "1234567890abcdef1234567890abcdef12345678" });
		const pushed = await gitPush(base);
		expect(pushed).toEqual({ pushed: BRANCH, output: "" });
		expect(await prCreate({ ...base, title: "Worked node", body: "proof" })).toEqual({
			pr_url: `https://github.com/${REPO}/pull/99`,
			pr_number: 99,
			existing: false,
		});
		// Fixed targets: the worktree, the branch, origin, the graph's repo and base.
		const flat = calls.map((argv) => argv.join(" "));
		expect(flat).toContain(`${guard(FIXTURE_SITE).join(" ")} push origin ${BRANCH}`);
		expect(flat.some((cmd) => cmd.includes(`--repo ${REPO}`) && cmd.includes("--base main") && cmd.includes(`--head ${BRANCH}`))).toBe(true);
		expect(flat.some((cmd) => cmd.includes(":(exclude,glob)**/.substrate-*"))).toBe(true);
		// No credential value anywhere in the plumbing.
		expect(calls.flat().some((arg) => arg.includes(planted))).toBe(false);
		expect(outputs.some((out) => out.includes(planted))).toBe(false);
	});
});
