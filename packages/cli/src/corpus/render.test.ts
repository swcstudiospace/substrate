import { describe, expect, test } from "bun:test";
import type { CorpusEntry, RepoReport } from "@substrate/corpus";
import type { Inventory } from "./inventory.ts";
import { LIST_LIMIT, REPO_LIMIT, renderIngest, renderInventory, renderPlan } from "./render.ts";
import { planOf } from "./testkit.ts";

function entry(repo: string, path: string, over: Partial<CorpusEntry> = {}): CorpusEntry {
	return { repo, path, kind: "doc", tier: 1, sha256: "a".repeat(64), bytes: 10, source: "fs", ...over };
}

function repoReport(repo: string, over: Partial<RepoReport> = {}): RepoReport {
	return { repo, dir: `/src/${repo}`, source: "fs", files: 1, bytes: 10, complete: true, ...over };
}

function inventory(repos: RepoReport[], entries: CorpusEntry[], over: Partial<Inventory["scope"]> = {}): Inventory {
	return {
		entries,
		paths: new Map(),
		sources: ["fs"],
		maxTier: 2,
		scope: { coverage: [], maxTier: 2, ...over },
		report: {
			checkouts: repos.length + 2,
			repos,
			collapsed: { clones: 1, worktrees: 1, identical: 3, identicalGroups: 1, identicalCopies: [] },
			skipped: [],
			skippedByReason: { empty: 2, binary: 1 },
			emptyCollections: 0,
			notes: ["one note"],
		},
	};
}

describe("renderInventory", () => {
	test("totals by tier and kind, the collapse and skip counts, and the repositories that were not read completely", () => {
		const text = renderInventory(
			inventory(
				[repoReport("Acme/A"), repoReport("Acme/B", { complete: false, incomplete: "git ls-files failed" })],
				[entry("Acme/A", "README.md", { kind: "readme" }), entry("Acme/A", "docs/x.md", { tier: 2 }), entry("Acme/A", "docs/y.md")],
			),
		);
		expect(text).toContain("3 documents, 30 bytes, 2 repositories (4 checkouts found)");
		expect(text).toContain("by tier: 1: 2, 2: 1");
		expect(text).toContain("by kind: doc 2, readme 1");
		expect(text).toContain("collapsed: 1 clone, 1 linked worktree, 3 identical copies in 1 group");
		expect(text).toContain("skipped: 3 (empty 2, binary 1)");
		expect(text).toContain("not read completely (left out of a plan's coverage): 1");
		expect(text).toContain("Acme/B [fs]: git ls-files failed");
		expect(text).toContain("one note");
	});

	test("an empty scan says none instead of printing blank lists", () => {
		const text = renderInventory({ ...inventory([], []), report: { ...inventory([], []).report, skippedByReason: {}, notes: [] } });
		expect(text).toContain("0 documents");
		expect(text).toContain("by tier: none");
		expect(text).toContain("skipped: none");
	});

	test("says how many repositories were covered with no documents left", () => {
		const base = inventory([repoReport("local/c1", { files: 0, bytes: 0 })], []);
		const text = renderInventory({ ...base, report: { ...base.report, emptyCollections: 1 } });
		expect(text).toContain("empty: 1 repository read completely with no documents");
	});

	test("the repository list is cut at the limit with the number left out, largest first", () => {
		const repos = Array.from({ length: REPO_LIMIT + 5 }, (_, i) => repoReport(`o/r${String(i).padStart(3, "0")}`, { files: i }));
		const text = renderInventory(inventory(repos, []));
		expect(text).toContain("... and 5 more");
		expect(text.indexOf(`o/r${String(REPO_LIMIT + 4).padStart(3, "0")}`)).toBeLessThan(text.indexOf("o/r100"));
		expect(text).not.toContain("o/r000");
	});
});

describe("renderPlan and renderIngest", () => {
	test("a rename shows where it came from, and the coverage line names the pairs", () => {
		const plan = planOf([{ action: "rename", repo: "Acme/A", path: "docs/new.md", renamedFrom: "docs/old.md" }]);
		const text = renderPlan(plan, inventory([], [], { coverage: [{ repo: "Acme/A", source: "fs" }], maxTier: 1 }));
		expect(text).toContain("rename (1):");
		expect(text).toContain("Acme/A:docs/new.md  (from docs/old.md)");
		expect(text).toContain("coverage: 1 repository/source pair read completely, tier <= 1");
	});

	test("an empty coverage and the pairs that were left out are printed with their reasons", () => {
		const plan = planOf([{ action: "update", repo: "Acme/A", path: "README.md" }]);
		const text = renderPlan(plan, inventory([repoReport("Acme/B", { source: "github", complete: false, incomplete: "the tree is truncated" })], []));
		expect(text).toContain("update 1");
		expect(text).toContain("update (1):");
		expect(text).toContain("coverage is empty: nothing will be tombstoned");
		expect(text).toContain("Acme/B [github]: the tree is truncated");
	});

	test("ingest problems are listed per status up to the limit", () => {
		const problems = Array.from({ length: LIST_LIMIT + 3 }, (_, i) => ({ repo: "Acme/A", path: `p${i}.md`, status: "failed" as const, reason: "plane-unavailable" }));
		const text = renderIngest({ counts: { ingested: 2, updated: 0, unchanged: 0, tombstoned: 0, refused: 0, failed: problems.length }, problems, manifestVersion: 4 });
		expect(text).toContain(`failed ${LIST_LIMIT + 3}`);
		expect(text).toContain(`failed (${LIST_LIMIT + 3}):`);
		expect(text).toContain("... and 3 more");
		expect(text).not.toContain("refused (");
	});
});
