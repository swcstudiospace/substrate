import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { documentKey, type CorpusEntry } from "./protocol.ts";
import { buildScope, type CheckoutRead, scanRoots, SkipLog } from "./scan.ts";
import { type FakeGit, fakeGit, tempDir, writeTree } from "./test-support.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HEAD = "c".repeat(40);

/** Three checkouts under one root, each with a README, plus a copy collection. */
function fixture(): { root: string; runner: FakeGit } {
	const root = tempDir();
	dirs.push(root);
	writeTree(root, {
		"alpha/.git/HEAD": "",
		"alpha/README.md": "# alpha\n",
		"beta/.git/HEAD": "",
		"beta/README.md": "# beta\n",
		"gamma/.git/HEAD": "",
		"gamma/README.md": "# gamma\n",
		"loose/README.md": "# loose\n",
	});
	const base = { head: HEAD, branch: "main", remoteDefault: "main", files: ["README.md"] };
	const runner = fakeGit({
		[join(root, "alpha")]: { ...base, origin: "git@github.com:Acme/Alpha.git" },
		[join(root, "beta")]: { ...base, origin: "git@github.com:Acme/Beta.git" },
		[join(root, "gamma")]: { ...base, origin: "git@github.com:Acme/Gamma.git" },
	});
	return { root, runner };
}

describe("scanRoots with a repository filter", () => {
	test("reads only the named repositories and covers only those", async () => {
		const { root, runner } = fixture();
		const result = await scanRoots({ roots: [root], runner, repos: ["Acme/Beta"] });

		expect(result.entries.map((entry) => documentKey(entry.repo, entry.path))).toEqual(["Acme/Beta:README.md"]);
		expect(result.report.repos.map((repo) => repo.repo)).toEqual(["Acme/Beta"]);
		expect(buildScope({ reports: result.report.repos, maxTier: 2 }).coverage).toEqual([{ repo: "Acme/Beta", source: "fs" }]);
		// No file of another repository was listed, so none was read.
		expect(runner.calls.filter((call) => call.args[0] === "ls-files").map((call) => call.cwd)).toEqual([join(root, "beta")]);
	});

	test("a copy collection is selected by its label too", async () => {
		const { root, runner } = fixture();
		const result = await scanRoots({ roots: [root], runner, repos: ["local/loose"] });
		expect(result.entries.map((entry) => entry.repo)).toEqual(["local/loose"]);
	});

	test("a label that matches nothing is noted and never covered", async () => {
		const { root, runner } = fixture();
		const result = await scanRoots({ roots: [root], runner, repos: ["Acme/Alpha", "Acme/Missing"] });
		expect(result.report.repos.map((repo) => repo.repo)).toEqual(["Acme/Alpha"]);
		expect(result.report.notes).toContain("repo-not-found: Acme/Missing is not below the roots");
	});

	test("without a filter every repository is read, as before", async () => {
		const { root, runner } = fixture();
		const result = await scanRoots({ roots: [root], runner });
		expect(result.report.repos).toHaveLength(4);
		expect(result.report.notes.some((note) => note.startsWith("repo-not-found"))).toBe(false);
	});
});

describe("scanRoots with a checkout reader", () => {
	function supplied(entries: CorpusEntry[], problems: string[] = []): CheckoutRead {
		const skips = new SkipLog();
		skips.add({ repo: "Acme/Alpha", path: "docs/skipped.md", reason: "binary" });
		return {
			entries,
			paths: new Map(entries.map((entry) => [documentKey(entry.repo, entry.path), `git-blob:${"a".repeat(40)}@/mirror`])),
			skips,
			problems,
		};
	}

	const entry: CorpusEntry = { repo: "Acme/Alpha", path: "docs/from-mirror.md", kind: "doc", tier: 1, sha256: "d".repeat(64), bytes: 9, source: "fs", commit: HEAD };

	test("the supplied entries replace the working-tree scan of that checkout only", async () => {
		const { root, runner } = fixture();
		const seen: string[] = [];
		const result = await scanRoots({
			roots: [root],
			runner,
			repos: ["Acme/Alpha", "Acme/Beta"],
			readCheckout: (checkout) => {
				seen.push(checkout.repo);
				return checkout.repo === "Acme/Alpha" ? supplied([entry]) : null;
			},
		});

		expect(seen.sort()).toEqual(["Acme/Alpha", "Acme/Beta"]);
		expect(result.entries.map((e) => documentKey(e.repo, e.path))).toEqual(["Acme/Alpha:docs/from-mirror.md", "Acme/Beta:README.md"]);
		expect(result.paths.get("Acme/Alpha:docs/from-mirror.md")).toStartWith("git-blob:");
		expect(result.report.skippedByReason).toEqual({ binary: 1 });
		expect(runner.calls.filter((call) => call.args[0] === "ls-files").map((call) => call.cwd)).toEqual([join(root, "beta")]);
	});

	test("a problem from the reader leaves the repository out of the coverage", async () => {
		const { root, runner } = fixture();
		const result = await scanRoots({
			roots: [root],
			runner,
			repos: ["Acme/Alpha"],
			readCheckout: () => supplied([entry], ["git diff failed in the checkout"]),
		});
		const repo = result.report.repos[0];
		expect(repo?.complete).toBe(false);
		expect(repo?.incomplete).toContain("git diff failed");
		expect(buildScope({ reports: result.report.repos, maxTier: 2 }).coverage).toEqual([]);
	});
});
