import { describe, expect, test } from "bun:test";
import {
	checkScratch,
	commit,
	COMMIT_MESSAGE_MAX,
	commitArgv,
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
const BRANCH = `substrate/${GID}`;
const REPO = "swcstudiospace/agent-substrate";

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

/** A fake runner keyed by the argv after `git -C <worktree>` (or the full argv for gh). Every call is recorded. */
function fakeRunner(replies: Record<string, Partial<RunResult>>): { run: Runner; calls: string[][] } {
	const calls: string[][] = [];
	const run: Runner = async (argv) => {
		calls.push([...argv]);
		const key = argv[0] === "git" && argv[1] === "-C" ? argv.slice(3).join(" ") : argv.join(" ");
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

function ctx(replies: Record<string, Partial<RunResult>>, storeRecord: TaskRecord | null = record(), graph: GraphView | null = GRAPH) {
	const store = new MemoryTaskStore();
	if (storeRecord) store.save(storeRecord);
	const runner = fakeRunner(replies);
	return {
		store,
		calls: runner.calls,
		ctx: { graphId: GID, nodeId: NID, store, substrate: { graphGet: async () => graph }, run: runner.run },
	};
}

describe("argv builders (T-03-07-01)", () => {
	test("pushArgv is exactly git -C <worktree> push origin substrate/<gid>: no --force, no colon refspec, only origin", () => {
		expect(pushArgv(GID)).toEqual(["git", "-C", WT, "push", "origin", BRANCH]);
		expect(pushArgv(GID).some((a) => a.includes("--force") || a === "-f")).toBe(false);
		expect(pushArgv(GID).some((a) => a.includes(":"))).toBe(false);
		expect(() => pushArgv("../etc")).toThrow(/graph id/);
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
		const [add, commitArgs] = commitArgv(GID, "03-07 smoke");
		expect(add).toEqual(["git", "-C", WT, "add", "-A", "--", ".", ":(exclude,glob)**/.substrate-*"]);
		expect(commitArgs).toEqual([
			"git",
			"-C",
			WT,
			"-c",
			"user.name=substrate claude-code",
			"-c",
			"user.email=claude-code@substrate.local",
			"commit",
			"-m",
			"03-07 smoke",
		]);
		expect(() => commitArgv(GID, "x".repeat(COMMIT_MESSAGE_MAX + 1))).toThrow(/message/);
		expect(() => commitArgv(GID, "   ")).toThrow(/message/);
		expect(() => commitArgv(GID, "-m evil")).toThrow(/message/);
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
		const refused = await checkScratch({ graphId: GID, base: "main", run: dirty.run });
		expect(refused).toEqual({ ok: false, reason: "branch contains substrate scratch files: .substrate-hook-input.json", paths: [".substrate-hook-input.json"] });
		expect(dirty.calls).toEqual([["git", "-C", WT, "diff", "--name-only", "origin/main...HEAD"]]);

		const clean = fakeRunner({ "diff --name-only origin/main...HEAD": { stdout: "x.ts\n" } });
		expect(await checkScratch({ graphId: GID, base: "main", run: clean.run })).toEqual({ ok: true });

		const broken = fakeRunner({ "diff --name-only origin/main...HEAD": { code: 128, stderr: "fatal: bad revision" } });
		const failed = await checkScratch({ graphId: GID, base: "main", run: broken.run });
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
		expect(c.calls.at(-1)).toEqual(["git", "-C", WT, "push", "origin", BRANCH]);
		// The origin check uses the dispatcher's rule (case-insensitive, .git ignored, path or scp suffix).
		expect(originMatches("git@github.com:SWCstudiospace/agent-substrate.git", REPO)).toBe(true);
		expect(originMatches("https://github.com/other/agent-substrate.git", REPO)).toBe(false);
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

	test("a failed push returns its exit code and a capped output tail, never throws", async () => {
		const c = ctx({ ...CLEAN_REPLIES, [`push origin ${BRANCH}`]: { code: 1, stderr: "! [rejected] non-fast-forward" } });
		const result = await gitPush(c.ctx);
		expect(result).toEqual({ error: "git push exited 1: ! [rejected] non-fast-forward" });
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
		expect(c.calls.map((argv) => argv.slice(3).join(" "))).toEqual([
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
