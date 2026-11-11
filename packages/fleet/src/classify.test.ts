import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { classifyForPrune, type PruneContext } from "./classify.ts";
import type { ClaimStatus } from "./claims.ts";
import { type CommandRunner, spawnGit } from "./git.ts";
import { createPrShared, inspectWorktree, listWorktrees, type WorktreeInfo } from "./inventory.ts";
import { addWorktree, cleanupTemp, commit, defined, fakeGh, git, makeRepo, tempDir } from "./testkit.ts";

afterAll(cleanupTemp);

const NOW = new Date("2026-10-29T12:00:00Z");
const OLD = "2026-09-01T00:00:00.000Z";
const HEAD = "a".repeat(40);

function ctx(overrides: Partial<PruneContext> = {}): PruneContext {
	return { cwd: "/somewhere/else", idleDays: 14, now: NOW, ...overrides };
}

/** A worktree that is safe to prune unless a test changes it. */
function info(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
	return {
		path: "/wts/one",
		repo: "acme/widgets",
		repo_dir: "/repos/widgets",
		branch: "one",
		head: HEAD,
		base: "b".repeat(40),
		dirty: false,
		ahead: 0,
		behind: 3,
		last_commit_at: OLD,
		last_activity_at: OLD,
		size_bytes: 1000,
		locked: false,
		primary: false,
		pr_state: "none",
		detached: false,
		prunable: false,
		default_ref: "origin/main",
		pushed: true,
		merged: true,
		pr_number: null,
		pr_head_sha: null,
		pr_merged_heads: [],
		ignored_work: [],
		notes: [],
		...overrides,
	};
}

describe("classifyForPrune", () => {
	test("clean, pushed, idle and merged is safe", () => {
		expect(classifyForPrune(info(), ctx())).toMatchObject({ class: "safe" });
	});

	test.each([
		["the primary checkout", { primary: true }, "primary"],
		["a dirty worktree", { dirty: true }, "uncommitted"],
		["a locked worktree", { locked: true }, "locked"],
		["a head that is not pushed", { pushed: false, merged: false }, "not pushed"],
		["a detached head with unpushed commits", { pushed: false, detached: true, branch: null }, "detached"],
	] as const)("%s is never", (_label, overrides, reason) => {
		const result = classifyForPrune(info(overrides), ctx());
		expect(result.class).toBe("never");
		expect(result.reasons.join(" ")).toContain(reason);
	});

	test("the current directory, or one inside the worktree, is never", () => {
		expect(classifyForPrune(info(), ctx({ cwd: "/wts/one" })).class).toBe("never");
		expect(classifyForPrune(info(), ctx({ cwd: "/wts/one/packages/x" })).class).toBe("never");
		expect(classifyForPrune(info(), ctx({ cwd: "/wts/one-other" })).class).toBe("safe");
	});

	test("idleness needs both the last commit and the newest file to be old, and unknown is not idle", () => {
		expect(classifyForPrune(info({ last_commit_at: "2026-10-25T00:00:00.000Z" }), ctx()).class).toBe("review");
		expect(classifyForPrune(info({ last_activity_at: "2026-10-28T00:00:00.000Z" }), ctx()).class).toBe("review");
		const unknown = classifyForPrune(info({ last_activity_at: null }), ctx());
		expect(unknown.class).toBe("review");
		expect(unknown.reasons.join(" ")).toContain("unknown");
	});

	test("a branch that gained commits after its pull request merged is review, never safe", () => {
		const advanced = info({ merged: false, pr_state: "merged", pr_number: 9, pr_head_sha: "c".repeat(40), pr_merged_heads: ["c".repeat(40)] });
		const result = classifyForPrune(advanced, ctx());
		expect(result.class).toBe("review");
		expect(result.reasons.join(" ")).toContain("advanced after its pull request merged");
	});

	test("a squash-merged branch is safe because HEAD equals the merged pull request head", () => {
		const squashed = info({ merged: false, pushed: false, pr_state: "merged", pr_number: 9, pr_head_sha: HEAD, pr_merged_heads: [HEAD] });
		const result = classifyForPrune(squashed, ctx());
		expect(result.class).toBe("safe");
		expect(result.reasons.join(" ")).toContain("merged pull request #9");
	});

	test("an unmerged branch or an unknown merge state is review", () => {
		expect(classifyForPrune(info({ merged: false, pr_state: "open" }), ctx()).class).toBe("review");
		const unknown = classifyForPrune(info({ merged: null, pr_state: "unknown" }), ctx());
		expect(unknown.class).toBe("review");
		expect(unknown.reasons.join(" ")).toContain("cannot prove");
	});

	test("ignored files that hold work make it review and name the first five paths", () => {
		const paths = [".env", ".planning/A.md", ".planning/B.md", "notes/c.txt", "notes/d.txt", "notes/e.txt", "notes/f.txt"];
		const result = classifyForPrune(info({ ignored_work: paths }), ctx());
		expect(result.class).toBe("review");
		const reason = result.reasons.find((text) => text.startsWith("ignored-files"));
		expect(reason).toContain(".env, .planning/A.md, .planning/B.md, notes/c.txt, notes/d.txt");
		expect(reason).not.toContain("notes/e.txt");
		expect(reason).toContain("and 2 more");
	});

	test("a missing directory is review with a pointer to git worktree prune", () => {
		const result = classifyForPrune(info({ prunable: true, pushed: false }), ctx());
		expect(result.class).toBe("review");
		expect(result.reasons.join(" ")).toContain("git worktree prune");
	});
});

describe("classification of real worktrees", () => {
	async function inspect(repoDir: string, path: string, gh: CommandRunner): Promise<WorktreeInfo> {
		const entry = defined((await listWorktrees(repoDir, spawnGit))?.find((item) => item.path === path), "entry");
		return inspectWorktree({ ...entry, repoDir }, { git: spawnGit, pr: createPrShared(gh) });
	}
	const later = (): PruneContext => ctx({ now: new Date(Date.now() + 40 * 24 * 3600 * 1000) });

	test("a repository with no origin is never safe to prune, even when HEAD is merged into its local main", async () => {
		const repo = makeRepo();
		git(repo.dir, ["remote", "remove", "origin"]);
		const path = addWorktree(repo, tempDir(), "local-only");
		commit(path, "l.txt", "1\n");
		git(repo.dir, ["merge", "-q", "--ff-only", "local-only"]);
		const result = classifyForPrune(await inspect(repo.dir, path, fakeGh({})), later());
		expect(result.class).toBe("never");
		expect(result.reasons).toContain("head is not pushed");
	});

	test("a squash-merged branch whose HEAD is the pull request head is safe; one that advanced is review", async () => {
		const repo = makeRepo();
		const root = tempDir();
		const squashed = addWorktree(repo, root, "squashed");
		const head = commit(squashed, "s.txt", "1\n");
		git(squashed, ["push", "-q", "origin", "squashed"]);
		// A squash merge puts a different commit on main; the branch's own commits never enter main.
		commit(repo.dir, "s.txt", "1\n", "squash of squashed");
		git(repo.dir, ["push", "-q", "origin", "main"]);

		const gh = fakeGh({ squashed: [{ state: "MERGED", headRefOid: head, number: 11 }] });
		const safe = await inspect(repo.dir, squashed, gh);
		expect(safe.merged).toBe(false);
		expect(classifyForPrune(safe, later()).class).toBe("safe");

		commit(squashed, "later.txt", "2\n");
		git(squashed, ["push", "-q", "origin", "squashed"]);
		const advanced = await inspect(repo.dir, squashed, gh);
		const result = classifyForPrune(advanced, later());
		expect(result.class).toBe("review");
		expect(result.reasons.join(" ")).toContain("advanced after its pull request merged");
	});

	test("a head merged only into a non-default base is not pushed once its branch is gone; one merged into the default branch still is", async () => {
		const repo = makeRepo();
		const root = tempDir();
		const stacked = addWorktree(repo, root, "stacked");
		const head = commit(stacked, "st.txt", "1\n");
		git(stacked, ["push", "-q", "origin", "stacked"]);
		// The branch is gone from origin and its remote-tracking ref is pruned: only a merged pull request can vouch for the head.
		git(stacked, ["push", "-q", "origin", "--delete", "stacked"]);
		git(stacked, ["update-ref", "-d", "refs/remotes/origin/stacked"]);
		commit(repo.dir, "other.txt", "x\n", "unrelated main work");
		git(repo.dir, ["push", "-q", "origin", "main"]);

		const onRelease = fakeGh({ stacked: [{ state: "MERGED", headRefOid: head, number: 14, baseRefName: "release" }] });
		const refused = classifyForPrune(await inspect(repo.dir, stacked, onRelease), later());
		expect(refused.class).toBe("never");
		expect(refused.reasons.join(" ")).toContain("head is not pushed");

		const onMain = fakeGh({ stacked: [{ state: "MERGED", headRefOid: head, number: 14, baseRefName: "main" }] });
		const counted = classifyForPrune(await inspect(repo.dir, stacked, onMain), later());
		expect(counted.reasons.join(" ")).not.toContain("head is not pushed");
		expect(counted.class).toBe("safe");
	});

	test("the primary checkout and the current directory are never, even when everything else is clean", async () => {
		const repo = makeRepo();
		const path = addWorktree(repo, tempDir(), "cwd-here");
		const gh = fakeGh({});
		const primary = await inspect(repo.dir, repo.dir, gh);
		expect(classifyForPrune(primary, later()).class).toBe("never");
		const linked = await inspect(repo.dir, path, gh);
		expect(classifyForPrune(linked, ctx({ cwd: join(path, "sub"), now: later().now })).class).toBe("never");
		expect(classifyForPrune(linked, later()).class).toBe("safe");
	});
});

describe("live graph claims", () => {
	const GRAPH = "ut-mu1-abcd1234";
	const live: ClaimStatus = { state: "live", graph_id: GRAPH, claims: [{ node_id: "n1", holder: { surface: "hermes", session_id: "s-1" }, expires_at: "2026-10-29T13:00:00.000Z" }] };

	test("a live claim makes an otherwise safe worktree never, and says who holds it", () => {
		const result = classifyForPrune(info(), ctx(), live);
		expect(result.class).toBe("never");
		expect(result.reasons.join(" ")).toContain(`live claim on graph ${GRAPH} (node n1, held by hermes, until 2026-10-29T13:00:00.000Z)`);
	});

	test("a claim that could not be checked is review, never safe", () => {
		const result = classifyForPrune(info(), ctx(), { state: "unverified", graph_id: GRAPH, reason: "server unreachable" });
		expect(result.class).toBe("review");
		expect(result.reasons.join(" ")).toContain("claims-unverified");
		expect(result.reasons.join(" ")).toContain("server unreachable");
	});

	test("no claim, or a worktree that is not a graph checkout, leaves the decision to the other facts", () => {
		expect(classifyForPrune(info(), ctx(), { state: "none", graph_id: GRAPH }).class).toBe("safe");
		expect(classifyForPrune(info(), ctx(), { state: "not-checked" }).class).toBe("safe");
		expect(classifyForPrune(info({ dirty: true }), ctx(), { state: "none", graph_id: GRAPH }).class).toBe("never");
	});
});
