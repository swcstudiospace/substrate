import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { defaultGitRunner, discoverRepos, githubSlug, repoFromOrigin, stripCredentials } from "./discover.ts";
import { isValidRepo, localRepoId } from "./names.ts";
import { defined, fakeGit, tempDir, writeTree } from "./test-support.ts";

const dirs: string[] = [];
function fixture(files: Record<string, string>): string {
	const root = tempDir();
	dirs.push(root);
	writeTree(root, files);
	return root;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("origin parsing", () => {
	test.each([
		["https://github.com/Acme/Widgets.git", "Acme/Widgets"],
		["https://github.com/Acme/Widgets", "Acme/Widgets"],
		["https://github.com/Acme/Widgets/", "Acme/Widgets"],
		["git@github.com:Acme/Widgets.git", "Acme/Widgets"],
		["github.com:Acme/Widgets", "Acme/Widgets"],
		["ssh://git@github.com/Acme/Widgets.git", "Acme/Widgets"],
		["ssh://git@github.com:22/Acme/Widgets.git", "Acme/Widgets"],
		["git://github.com/Acme/Widgets.git", "Acme/Widgets"],
		["https://x-access-token:abc123@github.com/Acme/Widgets.git", "Acme/Widgets"],
		["https://user@github.com/acme/widgets.git", "acme/widgets"],
	])("%s is %s", (origin, slug) => {
		expect(githubSlug(origin)).toBe(slug);
		expect(repoFromOrigin(origin, "ignored")).toBe(slug);
	});

	test("an origin that is not GitHub, or malformed, is local/<directory name>", () => {
		for (const origin of ["https://gitlab.com/a/b.git", "git@bitbucket.org:a/b.git", "/srv/git/a.git", "https://github.com/onlyowner", "https://github.com/a/b/c"]) {
			expect(githubSlug(origin)).toBeNull();
			expect(repoFromOrigin(origin, "mirror")).toBe("local/mirror");
		}
		expect(repoFromOrigin(null, "mirror")).toBe("local/mirror");
	});

	test("credentials are removed from a URL and a scp-style address is kept", () => {
		expect(stripCredentials("https://user:s3cret@example.com/a/b.git")).toBe("https://example.com/a/b.git");
		expect(stripCredentials("https://tokenonly@example.com/a.git")).toBe("https://example.com/a.git");
		expect(stripCredentials("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
	});
});

describe("discoverRepos", () => {
	test("a checkout's repo comes from its origin, with credentials stripped from the recorded origin", () => {
		const root = fixture({ "a/.git/HEAD": "", "a/README.md": "# a" });
		const a = join(root, "a");
		const found = discoverRepos([root], {
			run: fakeGit({ [a]: { origin: "https://bot:topsecret@github.com/Acme/Alpha.git", branch: "main", remoteDefault: "main" } }),
		});
		const checkout = defined(found.checkouts[0], "checkout");
		expect(checkout.repo).toBe("Acme/Alpha");
		expect(checkout.origin).toBe("https://github.com/Acme/Alpha.git");
		expect(checkout.branch).toBe("main");
		expect(checkout.linked).toBe(false);
		expect(JSON.stringify(found)).not.toContain("topsecret");
	});

	test("a directory with no origin is local/<directory name> and a detached head has no branch", () => {
		const root = fixture({ "scratch/.git/HEAD": "" });
		const dir = join(root, "scratch");
		const found = discoverRepos([root], { run: fakeGit({ [dir]: { branch: null, head: null } }) });
		const checkout = defined(found.checkouts[0], "checkout");
		expect(checkout.repo).toBe("local/scratch");
		expect(checkout.origin).toBeNull();
		expect(checkout.branch).toBeNull();
		expect(checkout.head).toBeNull();
		expect(checkout.headTimeMs).toBeNull();
	});

	test("a linked worktree and its main checkout collapse to one, and the collapse is recorded", () => {
		const root = fixture({ "main/.git/HEAD": "", "wt/.git": "gitdir: ../main/.git/worktrees/wt" });
		const main = join(root, "main");
		const wt = join(root, "wt");
		const common = join(main, ".git");
		const found = discoverRepos([root], {
			run: fakeGit({
				[main]: { origin: "git@github.com:Acme/Alpha.git", commonDir: common, branch: "main", remoteDefault: "main", time: 100 },
				[wt]: { origin: "git@github.com:Acme/Alpha.git", commonDir: common, gitDir: join(common, "worktrees", "wt"), branch: "feature", remoteDefault: "main", time: 900 },
			}),
		});
		expect(found.found).toBe(2);
		expect(found.checkouts.map((c) => c.dir)).toEqual([main]);
		expect(found.collapsed.worktrees).toBe(1);
		expect(found.collapsed.clones).toBe(0);
		expect(found.collapsed.records).toEqual([{ kind: "worktree", dir: wt, into: main, repo: "Acme/Alpha" }]);
		expect(found.notes.some((note) => note.includes(wt) && note.includes(main))).toBe(true);
	});

	test("clones of one origin collapse to the one on its default branch, even when another has a newer commit", () => {
		const root = fixture({ "old/.git/HEAD": "", "new-feature/.git/HEAD": "", "other/.git/HEAD": "" });
		const old = join(root, "old");
		const feature = join(root, "new-feature");
		const other = join(root, "other");
		const found = discoverRepos([root], {
			run: fakeGit({
				[old]: { origin: "https://github.com/Acme/Alpha.git", branch: "main", remoteDefault: "main", time: 100 },
				[feature]: { origin: "git@github.com:Acme/Alpha.git", branch: "wip", remoteDefault: "main", time: 5000 },
				[other]: { origin: "https://github.com/Acme/Beta.git", branch: "main", remoteDefault: "main", time: 1 },
			}),
		});
		expect(found.checkouts.map((c) => c.dir)).toEqual([old, other]);
		expect(found.collapsed.clones).toBe(1);
		expect(found.collapsed.records[0]).toEqual({ kind: "clone", dir: feature, into: old, repo: "Acme/Alpha" });
	});

	test("among clones on the default branch the newest HEAD wins, and a tie goes to the shortest path", () => {
		const root = fixture({ "a-newer/.git/HEAD": "", "b/.git/HEAD": "", "cc/.git/HEAD": "", "d/.git/HEAD": "" });
		const origin = "https://github.com/Acme/Alpha.git";
		const common = { origin, branch: "main", remoteDefault: "main" };
		const newer = join(root, "a-newer");
		const b = join(root, "b");
		const cc = join(root, "cc");
		const d = join(root, "d");
		const found = discoverRepos([root], {
			run: fakeGit({
				[newer]: { ...common, time: 500 },
				[b]: { ...common, time: 100 },
				[cc]: { ...common, time: 100 },
				[d]: { ...common, time: 100 },
			}),
		});
		expect(found.checkouts.map((c) => c.dir)).toEqual([newer]);
		const tie = discoverRepos([root], {
			run: fakeGit({
				[newer]: { ...common, time: 100 },
				[b]: { ...common, time: 100 },
				[cc]: { ...common, time: 100 },
				[d]: { ...common, time: 100 },
			}),
		});
		// `b` and `d` are the shortest; the lexically smaller one is kept so the choice never depends on listing order.
		expect(tie.checkouts.map((c) => c.dir)).toEqual([b]);
	});

	test("the default branch falls back to main, then master, when origin/HEAD is not set", () => {
		const root = fixture({ "a/.git/HEAD": "", "b/.git/HEAD": "" });
		const a = join(root, "a");
		const b = join(root, "b");
		const origin = "https://github.com/Acme/Alpha.git";
		const found = discoverRepos([root], {
			run: fakeGit({
				[a]: { origin, branch: "master", hasMain: false, time: 1 },
				[b]: { origin, branch: "main", time: 1 },
			}),
		});
		// `a` is on master and master is its default (no main exists); `b` is on main and main is its default: both are on their default, the shorter-tied sorted path `a` wins.
		expect(found.checkouts.map((c) => c.dir)).toEqual([a]);
		const second = discoverRepos([root], {
			run: fakeGit({
				[a]: { origin, branch: "master", time: 1 },
				[b]: { origin, branch: "main", time: 1 },
			}),
		});
		// Here `a` has a main branch, so master is not its default, and `b` is the canonical one.
		expect(second.checkouts.map((c) => c.dir)).toEqual([b]);
	});

	test("checkouts without an origin that share a directory name share a label and collapse", () => {
		const root = fixture({ "x/proj/.git/HEAD": "", "y/proj/.git/HEAD": "" });
		const x = join(root, "x", "proj");
		const y = join(root, "y", "proj");
		const found = discoverRepos([root], { run: fakeGit({ [x]: { branch: "main", time: 1 }, [y]: { branch: "main", time: 1 } }) });
		expect(found.checkouts).toHaveLength(1);
		expect(found.collapsed.clones).toBe(1);
	});

	test("a copy collection with documentation is reported, and a nested checkout is found by the same discovery", () => {
		const root = fixture({
			"copies/pile/README.md": "# pile",
			"copies/pile/sub/guide.md": "# guide",
			"copies/repo-wt/.git": "gitdir: /elsewhere/.git/worktrees/repo-wt",
			"copies/repo-wt/README.md": "# repo",
			"empty/notes.txt": "no docs here",
		});
		const wt = join(root, "copies", "repo-wt");
		const found = discoverRepos([root], { run: fakeGit({ [wt]: { branch: "main", remoteDefault: "main" } }) });
		expect(found.checkouts.map((c) => c.dir)).toEqual([wt]);
		// `copies` is the topmost directory holding documentation outside the nested checkout: one collection, labelled by its name.
		// `empty` holds no documentation and no checkout, and stays a collection so the scan covers it with zero entries.
		expect(found.collections).toEqual([
			{ dir: join(root, "copies"), repo: "local/copies" },
			{ dir: join(root, "empty"), repo: "local/empty" },
		]);
	});

	test("a collection whose last document was removed is still a collection, and a container of checkouts is not", () => {
		const root = fixture({ "c1/docs/.keep": "", "c2/guide.md": "# guide", "work/app/.git/HEAD": "", "emptied/.keep": "" });
		const found = discoverRepos([root], { run: fakeGit({ [join(root, "work", "app")]: { branch: "main" } }) });
		expect(found.collections.map((c) => c.repo)).toEqual(["local/c1", "local/c2", "local/emptied"]);
		expect(found.checkouts).toHaveLength(1);
	});

	test("an empty folder whose name is not a valid label is labelled by localRepoId, so the scope built from it is valid", () => {
		const root = fixture({ "backup:2026/.keep": "", "c1/guide.md": "# guide" });
		const found = discoverRepos([root], { run: fakeGit({}) });
		expect(found.collections.map((c) => c.repo)).toEqual([localRepoId("backup:2026"), "local/c1"]);
		for (const collection of found.collections) expect(isValidRepo(collection.repo)).toBe(true);
		expect(found.duplicates).toEqual([]);
	});

	test("a checkout with no origin is labelled by localRepoId too", () => {
		const root = fixture({ "my:repo/.git/HEAD": "" });
		const found = discoverRepos([root], { run: fakeGit({ [join(root, "my:repo")]: { branch: "main" } }) });
		expect(defined(found.checkouts[0], "checkout").repo).toBe(localRepoId("my:repo"));
		expect(repoFromOrigin(null, "my:repo")).toBe(localRepoId("my:repo"));
	});

	test("an empty folder and a folder with documents that share a label are both kept and reported, whichever root comes first", () => {
		const root = fixture({ "a/notes/.keep": "", "b/notes/guide.md": "# guide" });
		const a = join(root, "a");
		const b = join(root, "b");
		const forward = discoverRepos([a, b], { run: fakeGit({}) });
		expect(forward.collections).toEqual([
			{ dir: join(a, "notes"), repo: "local/notes" },
			{ dir: join(b, "notes"), repo: "local/notes" },
		]);
		expect(forward.duplicates).toEqual([{ repo: "local/notes", dirs: [join(a, "notes"), join(b, "notes")] }]);
		const backward = discoverRepos([b, a], { run: fakeGit({}) });
		expect(backward.duplicates).toEqual([{ repo: "local/notes", dirs: [join(b, "notes"), join(a, "notes")] }]);
		for (const found of [forward, backward]) {
			const note = defined(found.notes.find((text) => text.startsWith("duplicate-label:")), "the duplicate-label note");
			expect(note).toContain("local/notes");
			expect(note).toContain("a/notes");
			expect(note).toContain("b/notes");
			expect(note.includes(root)).toBe(false);
		}
	});

	test("a checkout and a copy collection that map to one label are a duplicate, not a collapse", () => {
		const root = fixture({ "a/notes/.git/HEAD": "", "b/notes/guide.md": "# guide" });
		const checkout = join(root, "a", "notes");
		const found = discoverRepos([join(root, "a"), join(root, "b")], { run: fakeGit({ [checkout]: { branch: "main" } }) });
		expect(found.checkouts.map((c) => c.dir)).toEqual([checkout]);
		expect(found.collections.map((c) => c.dir)).toEqual([join(root, "b", "notes")]);
		expect(found.duplicates).toEqual([{ repo: "local/notes", dirs: [checkout, join(root, "b", "notes")] }]);
		expect(found.collapsed.records).toEqual([]);
	});

	test("distinct labels are never reported as duplicates", () => {
		const root = fixture({ "a/notes/guide.md": "# a", "b/other/guide.md": "# b" });
		expect(discoverRepos([join(root, "a"), join(root, "b")], { run: fakeGit({}) }).duplicates).toEqual([]);
	});

	test("a collection of linked worktrees of one repository collapses like any other", () => {
		const root = fixture({
			"collection/a/.git": "gitdir: x",
			"collection/b/.git": "gitdir: y",
		});
		const a = join(root, "collection", "a");
		const b = join(root, "collection", "b");
		const common = "/shared/.git";
		const found = discoverRepos([root], {
			run: fakeGit({
				[a]: { origin: "git@github.com:Acme/Alpha.git", commonDir: common, gitDir: `${common}/worktrees/a`, branch: "main", remoteDefault: "main" },
				[b]: { origin: "git@github.com:Acme/Alpha.git", commonDir: common, gitDir: `${common}/worktrees/b`, branch: "wip", remoteDefault: "main" },
			}),
		});
		expect(found.checkouts.map((c) => c.dir)).toEqual([a]);
		expect(found.collapsed.worktrees).toBe(1);
		expect(found.collections).toEqual([]);
	});

	test("a root with documents of its own and no checkout is one collection; a container of checkouts, or of directories, is not", () => {
		const pile = fixture({ "README.md": "# r", "docs/a.md": "# a" });
		const piled = discoverRepos([pile], { run: fakeGit({}) });
		expect(piled.collections).toHaveLength(1);
		expect(defined(piled.collections[0], "collection").dir).toBe(pile);
		const container = fixture({ "a/.git/HEAD": "", "README.md": "# loose" });
		const found = discoverRepos([container], { run: fakeGit({ [join(container, "a")]: { branch: "main" } }) });
		expect(found.collections).toEqual([]);
		expect(found.checkouts).toHaveLength(1);
		const parent = fixture({ "one/README.md": "# 1", "two/README.md": "# 2" });
		const split = discoverRepos([parent], { run: fakeGit({}) });
		expect(split.collections.map((c) => c.dir)).toEqual([join(parent, "one"), join(parent, "two")]);
	});

	test("depth bounds the search and excluded directories are never entered", () => {
		const root = fixture({ "l1/l2/l3/l4/.git/HEAD": "", "node_modules/pkg/.git/HEAD": "", "ok/.git/HEAD": "" });
		const run = fakeGit({
			[join(root, "l1/l2/l3/l4")]: { branch: "main" },
			[join(root, "node_modules/pkg")]: { branch: "main" },
			[join(root, "ok")]: { branch: "main" },
		});
		expect(discoverRepos([root], { run }).checkouts.map((c) => c.dir)).toEqual([join(root, "ok")]);
		expect(discoverRepos([root], { run, depth: 4 }).checkouts).toHaveLength(2);
	});

	test("a missing root is noted, and a directory reached through two roots is found once", () => {
		const root = fixture({ "a/.git/HEAD": "" });
		const run = fakeGit({ [join(root, "a")]: { branch: "main" } });
		const found = discoverRepos([root, join(root, "a"), `${root}/missing`], { run });
		expect(found.checkouts).toHaveLength(1);
		expect(found.notes.some((note) => note.includes("missing"))).toBe(true);
	});

	test("the default runner runs real git without a shell", () => {
		const root = fixture({});
		const result = defaultGitRunner(["rev-parse", "--is-inside-work-tree"], root);
		expect(typeof result.code).toBe("number");
		expect(defaultGitRunner(["definitely-not-a-git-command"], root).code).not.toBe(0);
	});
});
