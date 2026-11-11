import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { WORKTREE_FILES_MAX, WORKTREE_REPO_PATTERN } from "../../mcp-server/src/worktree-registry.ts";
import { type CommandRunner, spawnGit } from "./git.ts";
import { collectInventory, createPrShared, discoverRepos, inspectWorktree, listWorktrees, localRepoLabel, parseWorktreePorcelain, reloadWorktree } from "./inventory.ts";
import { addWorktree, cleanupTemp, commit, defined, fakeGh, git, makeRepo, type TestRepo, tempDir, write } from "./testkit.ts";

afterAll(cleanupTemp);

describe("parseWorktreePorcelain", () => {
	test("reads branch, detached, bare, locked and prunable blocks; the first is primary", () => {
		const text = [
			"worktree /srv/repo",
			"HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"branch refs/heads/main",
			"",
			"worktree /srv/wt/feature",
			"HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			"branch refs/heads/feature/x",
			"locked in use",
			"",
			"worktree /srv/wt/loose",
			"HEAD cccccccccccccccccccccccccccccccccccccccc",
			"detached",
			"prunable gitdir file points to non-existent location",
			"",
			"worktree /srv/bare.git",
			"bare",
			"",
		].join("\0");
		const entries = parseWorktreePorcelain(text);
		expect(entries.map((entry) => [entry.path, entry.branch, entry.primary])).toEqual([
			["/srv/repo", "main", true],
			["/srv/wt/feature", "feature/x", false],
			["/srv/wt/loose", null, false],
			["/srv/bare.git", null, false],
		]);
		expect(entries[1]?.locked).toBe(true);
		expect(entries[2]).toMatchObject({ detached: true, prunable: true, locked: false });
		expect(entries[3]?.bare).toBe(true);
	});

	test("a path or a lock reason that holds a newline stays in one piece", () => {
		const text = ["worktree /srv/repo", `HEAD ${"a".repeat(40)}`, "branch refs/heads/main", "", "worktree /srv/wt/two\nlines", `HEAD ${"b".repeat(40)}`, "branch refs/heads/two", "locked because\nreasons", "", ""].join("\0");
		const entries = parseWorktreePorcelain(text);
		expect(entries.map((entry) => [entry.path, entry.branch, entry.locked])).toEqual([
			["/srv/repo", "main", false],
			["/srv/wt/two\nlines", "two", true],
		]);
	});

	test("listWorktrees asks git for NUL-delimited records and keeps a path with a newline whole", async () => {
		const calls: string[][] = [];
		const runner: CommandRunner = async (args) => {
			calls.push(args);
			return { code: 0, stdout: `worktree /srv/wt/a\nb\0HEAD ${"c".repeat(40)}\0detached\0\0`, stderr: "" };
		};
		const listed = await listWorktrees("/srv/repo", runner);
		expect(calls).toEqual([["worktree", "list", "--porcelain", "-z"]]);
		expect(listed?.map((entry) => entry.path)).toEqual(["/srv/wt/a\nb"]);
	});
});

describe("discovery and inventory", () => {
	test("linked worktrees under a root collapse to one repository, and git finds the ones outside it", async () => {
		const repo = makeRepo();
		const root = join(tempDir(), "wts");
		mkdirSync(root);
		const inside = addWorktree(repo, root, "alpha");
		const elsewhere = addWorktree(repo, tempDir(), "beta");

		const discovery = await discoverRepos([root], { git: spawnGit });
		expect(discovery.repos).toHaveLength(1);
		expect(discovery.repos[0]?.commonDir).toBe(join(repo.dir, ".git"));

		const listed = defined(await listWorktrees(defined(discovery.repos[0], "repo").dir, spawnGit), "worktree list");
		expect(listed.map((entry) => entry.path).sort()).toEqual([repo.dir, inside, elsewhere].sort());

		const inventory = await collectInventory([root], { git: spawnGit });
		expect(inventory.worktrees.map((wt) => wt.path).sort()).toEqual([repo.dir, inside, elsewhere].sort());
		const primary = defined(inventory.worktrees.find((wt) => wt.path === repo.dir), "primary");
		expect(primary.primary).toBe(true);
		expect(primary.repo).toBe("acme/widgets");
	});

	test("a missing root is a note, not a failure, and a node_modules directory is not searched", async () => {
		const base = tempDir();
		mkdirSync(join(base, "node_modules", "pkg", ".git"), { recursive: true });
		const discovery = await discoverRepos([join(base, "absent"), base], { git: spawnGit });
		expect(discovery.repos).toEqual([]);
		expect(discovery.notes.join("\n")).toContain("does not exist");
	});

	test("a repository without a remote is named local/<directory>", async () => {
		const dir = join(tempDir(), "scratch");
		mkdirSync(dir);
		git(dir, ["init", "-q", "--initial-branch=main"]);
		git(dir, ["-c", "user.email=a@b.invalid", "-c", "user.name=n", "commit", "-q", "--allow-empty", "-m", "i"]);
		const inventory = await collectInventory([dir], { git: spawnGit, maxDepth: 0 });
		expect(inventory.worktrees[0]?.repo).toBe("local/scratch");
		expect(inventory.worktrees[0]?.default_ref).toBe("main");
	});
});

describe("inspectWorktree", () => {
	test("reports dirty, ahead and behind against the default branch and the merge base", async () => {
		const repo = makeRepo();
		const root = tempDir();
		const path = addWorktree(repo, root, "feat");
		const forkPoint = git(path, ["rev-parse", "HEAD"]);
		commit(path, "feature.txt", "work\n");
		commit(repo.dir, "main-only.txt", "x\n");
		git(repo.dir, ["push", "-q", "origin", "main"]);
		write(path, "scratch.txt", "untracked\n");

		const entry = defined((await listWorktrees(repo.dir, spawnGit))?.find((item) => item.path === path), "entry");
		const info = await inspectWorktree({ ...entry, repoDir: repo.dir }, { git: spawnGit });
		expect(info).toMatchObject({ branch: "feat", dirty: true, ahead: 1, behind: 1, base: forkPoint, default_ref: "origin/main", locked: false, primary: false, pushed: false, merged: false });
		expect(info.last_commit_at).not.toBeNull();
		expect(info.size_bytes).toBeGreaterThan(0);
		expect(info.pr_state).toBe("unknown");
	});

	test("pushed means origin/<branch> contains HEAD, and fails once a commit is added locally", async () => {
		const repo = makeRepo();
		const path = addWorktree(repo, tempDir(), "pub");
		commit(path, "a.txt", "1\n");
		git(path, ["push", "-q", "origin", "pub"]);
		const entry = defined((await listWorktrees(repo.dir, spawnGit))?.find((item) => item.path === path), "entry");
		const input = { ...entry, repoDir: repo.dir };
		expect((await inspectWorktree(input, { git: spawnGit, measure: false })).pushed).toBe(true);
		commit(path, "b.txt", "2\n");
		const after = await inspectWorktree({ ...input, head: git(path, ["rev-parse", "HEAD"]) }, { git: spawnGit, measure: false });
		expect(after.pushed).toBe(false);
		expect(after.dirty).toBe(false);
	});

	test("a repository with no origin never has a commit pushed, even one merged into its local main", async () => {
		const repo = makeRepo();
		git(repo.dir, ["remote", "remove", "origin"]);
		const path = addWorktree(repo, tempDir(), "local-only");
		commit(path, "l.txt", "1\n");
		git(repo.dir, ["merge", "-q", "--ff-only", "local-only"]);
		const entry = defined((await listWorktrees(repo.dir, spawnGit))?.find((item) => item.path === path), "entry");
		const info = await inspectWorktree({ ...entry, repoDir: repo.dir }, { git: spawnGit, measure: false });
		expect(info).toMatchObject({ default_ref: "main", merged: true, pushed: false });
	});

	test("a branch merged into the default branch is merged and counts as pushed without its own remote branch", async () => {
		const repo = makeRepo();
		const path = addWorktree(repo, tempDir(), "done");
		commit(path, "d.txt", "1\n");
		git(repo.dir, ["merge", "-q", "--no-ff", "-m", "merge done", "done"]);
		git(repo.dir, ["push", "-q", "origin", "main"]);
		const entry = defined((await listWorktrees(repo.dir, spawnGit))?.find((item) => item.path === path), "entry");
		const info = await inspectWorktree({ ...entry, repoDir: repo.dir }, { git: spawnGit, measure: false });
		expect(info).toMatchObject({ merged: true, pushed: true, ahead: 0 });
	});

	test("pull-request state comes from the injected gh, once per branch, and failure is unknown", async () => {
		const repo = makeRepo();
		const root = tempDir();
		const path = addWorktree(repo, root, "pr-branch");
		const head = commit(path, "p.txt", "1\n");
		const calls: string[][] = [];
		const gh = fakeGh({ "pr-branch": [{ state: "MERGED", headRefOid: head, number: 7 }] }, calls);
		const shared = createPrShared(gh);
		const entry = defined((await listWorktrees(repo.dir, spawnGit))?.find((item) => item.path === path), "entry");
		const input = { ...entry, repoDir: repo.dir };
		const first = await inspectWorktree(input, { git: spawnGit, pr: shared, measure: false });
		await inspectWorktree(input, { git: spawnGit, pr: shared, measure: false });
		expect(first).toMatchObject({ pr_state: "merged", pr_number: 7, pr_head_sha: head, pr_merged_heads: [head] });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("--head");

		const failing = createPrShared(async () => ({ code: 1, stdout: "", stderr: "not logged in" }));
		expect((await inspectWorktree(input, { git: spawnGit, pr: failing, measure: false })).pr_state).toBe("unknown");
	});

	test("a registered worktree whose directory is gone is prunable and not inspected further", async () => {
		const repo = makeRepo();
		const path = addWorktree(repo, tempDir(), "gone");
		const entry = defined((await listWorktrees(repo.dir, spawnGit))?.find((item) => item.path === path), "entry");
		const info = await inspectWorktree({ ...entry, path: join(path, "missing"), repoDir: repo.dir }, { git: spawnGit });
		expect(info.prunable).toBe(true);
		expect(info.size_bytes).toBeNull();
	});

	test("ignored files that hold work are listed, regenerable directories are not", async () => {
		const repo = makeRepo();
		write(repo.dir, ".gitignore", ".planning/\nnode_modules/\n");
		git(repo.dir, ["add", ".gitignore"]);
		git(repo.dir, ["commit", "-q", "-m", "ignore"]);
		git(repo.dir, ["push", "-q", "origin", "main"]);
		const path = addWorktree(repo, tempDir(), "notes");
		write(path, "node_modules/dep/index.js", "x\n");
		const entry = defined((await listWorktrees(repo.dir, spawnGit))?.find((item) => item.path === path), "entry");
		const input = { ...entry, repoDir: repo.dir };
		expect((await inspectWorktree(input, { git: spawnGit, measure: false })).ignored_work).toEqual([]);

		write(path, ".planning/STATE.md", "local\n");
		write(repo.dir, ".planning/STATE.md", "different\n");
		expect((await inspectWorktree(input, { git: spawnGit, measure: false })).ignored_work).toEqual([".planning/STATE.md"]);

		write(repo.dir, ".planning/STATE.md", "local\n");
		expect((await inspectWorktree(input, { git: spawnGit, measure: false })).ignored_work).toEqual([]);
	});
});

describe("inspectWorktree changed files (the registry report)", () => {
	async function inspectFiles(repo: TestRepo, path: string, runner: CommandRunner = spawnGit, files = true) {
		const entry = defined((await listWorktrees(repo.dir, spawnGit))?.find((item) => item.path === path), "entry");
		return inspectWorktree({ ...entry, repoDir: repo.dir }, { git: runner, measure: false, ignored: false, ...(files ? { files: true } : {}) });
	}
	/** A runner that fails one git subcommand the way a broken repository would, and runs the rest for real. */
	const failing =
		(command: string): CommandRunner =>
		async (args, cwd) =>
			args[0] === command ? { code: 128, stdout: "", stderr: "fatal: simulated failure" } : spawnGit(args, cwd);

	test("lists committed, renamed (a delete and an add), uncommitted and untracked files, sorted, and says nothing was cut", async () => {
		const repo = makeRepo();
		commit(repo.dir, "old-name.txt", "same content\nline two\nline three\n");
		commit(repo.dir, "docs/keep.md", "k\n");
		git(repo.dir, ["push", "-q", "origin", "main"]);
		const path = addWorktree(repo, tempDir(), "feat");
		git(path, ["mv", "old-name.txt", "new-name.txt"]);
		git(path, ["commit", "-q", "-m", "rename"]);
		commit(path, "src/new.ts", "x\n");
		write(path, "docs/keep.md", "changed\n");
		write(path, "scratch/untracked.txt", "u\n");

		const info = await inspectFiles(repo, path);
		expect(info.files).toEqual(["docs/keep.md", "new-name.txt", "old-name.txt", "scratch/untracked.txt", "src/new.ts"]);
		expect(info.files_truncated).toBe(false);
	});

	test("a scan that does not ask for the files does not list them", async () => {
		const repo = makeRepo();
		const path = addWorktree(repo, tempDir(), "quiet");
		commit(path, "a.txt", "a\n");
		const info = await inspectFiles(repo, path, spawnGit, false);
		expect(info.files).toBeUndefined();
		expect(info.files_truncated).toBeUndefined();
	});

	test("a list over the cap reports the first 200 in order and says it was cut; exactly 200 is not cut", async () => {
		const repo = makeRepo();
		const over = addWorktree(repo, tempDir(), "over");
		for (let index = 0; index < WORKTREE_FILES_MAX + 5; index += 1) write(over, `bulk/f${String(index).padStart(3, "0")}.txt`, "x\n");
		git(over, ["add", "-A"]);
		git(over, ["commit", "-q", "-m", "bulk"]);
		const cut = await inspectFiles(repo, over);
		expect(cut.files).toHaveLength(WORKTREE_FILES_MAX);
		expect(cut.files?.[0]).toBe("bulk/f000.txt");
		expect(cut.files?.at(-1)).toBe("bulk/f199.txt");
		expect(cut.files_truncated).toBe(true);

		const exact = addWorktree(repo, tempDir(), "exact");
		for (let index = 0; index < WORKTREE_FILES_MAX; index += 1) write(exact, `bulk/f${String(index).padStart(3, "0")}.txt`, "x\n");
		git(exact, ["add", "-A"]);
		git(exact, ["commit", "-q", "-m", "bulk"]);
		const whole = await inspectFiles(repo, exact);
		expect(whole.files).toHaveLength(WORKTREE_FILES_MAX);
		expect(whole.files_truncated).toBe(false);
	});

	test("a listing that fails is null with the warning `conflicts` gives, never an empty list: a failed diff, a failed status, and no merge base", async () => {
		const repo = makeRepo();
		const path = addWorktree(repo, tempDir(), "broken");
		commit(path, "a.txt", "a\n");

		const diff = await inspectFiles(repo, path, failing("diff"));
		expect(diff.files).toBeNull();
		expect(diff.notes).toContain("git diff failed: fatal: simulated failure");
		expect(diff.files_truncated).toBeUndefined();

		const status = await inspectFiles(repo, path, failing("status"));
		expect(status.files).toBeNull();
		expect(status.notes).toContain("git status failed: fatal: simulated failure");

		const noBase = await inspectFiles(repo, path, failing("merge-base"));
		expect(noBase.base).toBeNull();
		expect(noBase.files).toBeNull();
		expect(noBase.notes).toContain("no merge base: only uncommitted changes are listed");
	});

	test("a path the registry would refuse (a newline, a control character, over 400 characters) is dropped and counted, and the worktree and its other files stay", async () => {
		const repo = makeRepo();
		const path = addWorktree(repo, tempDir(), "hostile");
		write(path, "ok.txt", "ok\n");
		write(path, "bad\nname.txt", "x\n");
		write(path, "ctl\u0007.txt", "x\n");
		write(path, `${"d".repeat(200)}/${"e".repeat(200)}/long.txt`, "x\n");

		const info = await inspectFiles(repo, path);
		expect(info.files).toEqual(["ok.txt"]);
		expect(info.notes.some((note) => note.startsWith("3 changed paths were not reported"))).toBe(true);
	});
});

describe("localRepoLabel", () => {
	test("a directory name the registry accepts stays local/<name>", () => {
		expect(localRepoLabel("scratch")).toBe("local/scratch");
		expect(localRepoLabel("my_repo-2.0")).toBe("local/my_repo-2.0");
	});

	test.each([
		["my repo", /^local\/my-repo-[0-9a-f]{8}$/],
		["dépôt", /^local\/d-p-t-[0-9a-f]{8}$/],
		["日本語", /^local\/repo-[0-9a-f]{8}$/],
		[".hidden dir", /^local\/hidden-dir-[0-9a-f]{8}$/],
		["", /^local\/repo-[0-9a-f]{8}$/],
	])("%s becomes a label the registry accepts", (name, expected) => {
		const label = localRepoLabel(name);
		expect(label).toMatch(expected);
		expect(WORKTREE_REPO_PATTERN.test(label)).toBe(true);
		// Stable: the same directory is the same repository on every scan.
		expect(localRepoLabel(name)).toBe(label);
	});

	test("a name past the length limit is cut so the whole label still fits, and names that differ stay distinct", () => {
		const long = localRepoLabel(`${"x".repeat(150)} tail`);
		expect(WORKTREE_REPO_PATTERN.test(long)).toBe(true);
		expect(long.slice("local/".length)).toHaveLength(100);
		expect(localRepoLabel("a b")).not.toBe(localRepoLabel("a?b"));
	});

	test("a checkout with no remote in a directory called `my repo` is inventoried under a valid label", async () => {
		const dir = join(tempDir(), "my repo");
		mkdirSync(dir);
		git(dir, ["init", "-q", "--initial-branch=main"]);
		git(dir, ["-c", "user.email=a@b.invalid", "-c", "user.name=n", "commit", "-q", "--allow-empty", "-m", "i"]);
		const inventory = await collectInventory([dir], { git: spawnGit, maxDepth: 0 });
		const repo = defined(inventory.worktrees[0], "worktree").repo;
		expect(repo).toMatch(/^local\/my-repo-[0-9a-f]{8}$/);
		expect(WORKTREE_REPO_PATTERN.test(repo)).toBe(true);
	});
});

describe("reloadWorktree", () => {
	test("returns the head git lists now, not the one an earlier listing had", async () => {
		const repo = makeRepo();
		const path = addWorktree(repo, tempDir(), "moving");
		const before = defined((await listWorktrees(repo.dir, spawnGit))?.find((item) => item.path === path), "entry");
		const moved = commit(path, "m.txt", "m\n");
		const after = defined(await reloadWorktree(path, repo.dir, spawnGit), "reloaded");
		expect(after.head).toBe(moved);
		expect(after.head).not.toBe(before.head);
		expect(after).toMatchObject({ branch: "moving", detached: false, primary: false, repoDir: repo.dir });
	});

	test("is null for a path git no longer lists, and when git cannot list at all", async () => {
		const repo = makeRepo();
		expect(await reloadWorktree(join(tempDir(), "gone"), repo.dir, spawnGit)).toBeNull();
		const broken: CommandRunner = async () => ({ code: 128, stdout: "", stderr: "fatal" });
		expect(await reloadWorktree(repo.dir, repo.dir, broken)).toBeNull();
	});
});
