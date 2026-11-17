import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { defined, fakeGit, tempDir, writeTree } from "../../../corpus/src/test-support.ts";
import { collectInventory } from "./inventory.ts";
import { fakeGhOwner } from "./testkit.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
	const root = tempDir("inventory-");
	dirs.push(root);
	writeTree(root, files);
	return root;
}

const BASE = { maxTier: 2 as const, maxBytes: 1_000_000, maxRepos: 50 };

describe("collectInventory", () => {
	test("merges the sources into one sorted list and the (repository, source) pairs read completely", async () => {
		const root = tree({ "alpha/.git/HEAD": "", "alpha/README.md": "# alpha\n" });
		const exportDir = tree({ "Acme/Gamma/architecture.md": "# gamma\n" });
		const runner = fakeGit({ [join(root, "alpha")]: { origin: "git@github.com:Acme/Alpha.git", files: ["README.md"], branch: "main" } });
		const gh = fakeGhOwner({ "Acme/Zed": { files: { "README.md": "zed\n" } } });
		const inventory = await collectInventory({
			...BASE,
			roots: [root],
			sources: ["fs", "github", "greptile"],
			githubOwner: "Acme",
			greptileDir: exportDir,
			runner,
			gh,
		});
		expect(inventory.entries.map((e) => `${e.repo}:${e.path}:${e.source}`)).toEqual([
			"Acme/Alpha:README.md:fs",
			"Acme/Gamma:architecture.md:greptile",
			"Acme/Zed:README.md:github",
		]);
		expect(inventory.scope).toEqual({
			coverage: [
				{ repo: "Acme/Alpha", source: "fs" },
				{ repo: "Acme/Gamma", source: "greptile" },
				{ repo: "Acme/Zed", source: "github" },
			],
			maxTier: 2,
		});
		expect(inventory.paths.has("Acme/Alpha:README.md")).toBe(true);
		expect(inventory.paths.has("Acme/Zed:README.md")).toBe(false);
	});

	test("a repository read from a local clone is not read again through the API", async () => {
		const root = tree({ "alpha/.git/HEAD": "", "alpha/README.md": "# alpha\n" });
		const runner = fakeGit({ [join(root, "alpha")]: { origin: "git@github.com:Acme/Alpha.git", files: ["README.md"], branch: "main" } });
		const calls: string[] = [];
		const inner = fakeGhOwner({ "Acme/Alpha": { files: { "README.md": "from api\n" } } });
		const gh: typeof inner = async (args) => {
			calls.push(args.join(" "));
			return inner(args);
		};
		const withClone = await collectInventory({ ...BASE, roots: [root], sources: ["fs", "github"], githubOwner: "Acme", runner, gh });
		expect(withClone.entries.map((e) => e.source)).toEqual(["fs"]);
		expect(calls.some((call) => call.includes("Acme/Alpha/"))).toBe(false);
		// Without the filesystem source nothing covers the clone, so the API reads it.
		const apiOnly = await collectInventory({ ...BASE, roots: [root], sources: ["github"], githubOwner: "Acme", runner, gh });
		expect(apiOnly.entries.map((e) => e.source)).toEqual(["github"]);
	});

	test("when two sources report the same repository and path the first is kept and the clash is noted", async () => {
		const root = tree({ "alpha/.git/HEAD": "", "alpha/architecture.md": "# from the clone\n" });
		const exportDir = tree({ "Acme/Alpha/architecture.md": "# from greptile\n" });
		const runner = fakeGit({ [join(root, "alpha")]: { origin: "git@github.com:Acme/Alpha.git", files: ["architecture.md"], branch: "main" } });
		const inventory = await collectInventory({ ...BASE, maxTier: 3, roots: [root], sources: ["fs", "greptile"], greptileDir: exportDir, runner });
		expect(inventory.entries).toHaveLength(1);
		expect(defined(inventory.entries[0], "entry").source).toBe("fs");
		expect(inventory.report.notes.some((note) => note.includes("Acme/Alpha:architecture.md") && note.includes("more than one source"))).toBe(true);
	});

	test("a repository that is complete in one source and not in another is covered for the first source only", async () => {
		const exportDir = tree({ "Acme/Same/x.md": "x\n" });
		const gh = fakeGhOwner({ "Acme/Same": { files: { "README.md": "r\n" }, truncated: true } });
		const inventory = await collectInventory({ ...BASE, roots: [], sources: ["github", "greptile"], githubOwner: "Acme", greptileDir: exportDir, gh });
		expect(inventory.scope.coverage).toEqual([{ repo: "Acme/Same", source: "greptile" }]);
		expect(inventory.entries).toHaveLength(2);
	});

	test("an entry whose path the server would refuse is skipped as bad-path, and the rest of the repository is still planned and covered", async () => {
		const root = tree({ "alpha/.git/HEAD": "", "alpha/README.md": "# alpha\n", "alpha/docs/we\\ird.md": "odd\n" });
		const runner = fakeGit({ [join(root, "alpha")]: { origin: "git@github.com:Acme/Alpha.git", files: ["README.md", "docs/we\\ird.md"], branch: "main" } });
		const inventory = await collectInventory({ ...BASE, roots: [root], sources: ["fs"], runner });
		expect(inventory.entries.map((e) => e.path)).toEqual(["README.md"]);
		expect(inventory.report.skippedByReason).toEqual({ "bad-path": 1 });
		expect(inventory.report.skipped).toEqual([{ repo: "Acme/Alpha", path: "docs/we\\ird.md", reason: "bad-path" }]);
		expect(inventory.scope.coverage).toEqual([{ repo: "Acme/Alpha", source: "fs" }]);
	});

	test("skip counts add up across sources and the filesystem collapse counts are kept", async () => {
		const root = tree({ "c1/docs/a.md": "same\n", "c2/docs/a.md": "same\n", "c1/docs/empty.md": "" });
		const exportDir = tree({ "o/r/empty.md": "" });
		const inventory = await collectInventory({ ...BASE, roots: [root], sources: ["fs", "greptile"], greptileDir: exportDir, runner: fakeGit({}) });
		expect(inventory.report.skippedByReason).toEqual({ empty: 2 });
		expect(inventory.report.collapsed.identical).toBe(1);
		expect(inventory.report.collapsed.identicalCopies).toEqual([{ keep: "local/c1:docs/a.md", copies: ["local/c2:docs/a.md"] }]);
	});

	test("an emptied collection is covered with zero entries and counted", async () => {
		const root = tree({ "c1/notes.txt": "no documents left\n", "c2/docs/a.md": "a\n" });
		const inventory = await collectInventory({ ...BASE, roots: [root], sources: ["fs"], runner: fakeGit({}) });
		expect(inventory.entries.map((e) => e.repo)).toEqual(["local/c2"]);
		expect(inventory.scope.coverage).toEqual([
			{ repo: "local/c1", source: "fs" },
			{ repo: "local/c2", source: "fs" },
		]);
		expect(inventory.report.emptyCollections).toBe(1);
	});
});
