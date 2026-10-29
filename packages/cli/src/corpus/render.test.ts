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

function inventory(repos: RepoReport[], entries: CorpusEntry[]): Inventory {
	return {
		entries,
		paths: new Map(),
		sources: ["fs"],
		maxTier: 2,
		scope: { repos: [], maxTier: 2, sources: ["fs"] },
		report: {
			checkouts: repos.length + 2,
			repos,
			collapsed: { clones: 1, worktrees: 1, identical: 3, identicalGroups: 1, identicalCopies: [] },
			skipped: [],
			skippedByReason: { empty: 2, binary: 1 },
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
		expect(text).toContain("not read completely (left out of a plan's scope): 1");
		expect(text).toContain("Acme/B: git ls-files failed");
		expect(text).toContain("one note");
	});

	test("an empty scan says none instead of printing blank lists", () => {
		const text = renderInventory({ ...inventory([], []), report: { ...inventory([], []).report, skippedByReason: {}, notes: [] } });
		expect(text).toContain("0 documents");
		expect(text).toContain("by tier: none");
		expect(text).toContain("skipped: none");
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
	test("a rename shows where it came from", () => {
		const plan = planOf([{ action: "rename", repo: "Acme/A", path: "docs/new.md", renamedFrom: "docs/old.md" }]);
		const text = renderPlan(plan, { repos: ["Acme/A"], maxTier: 1, sources: ["fs"] });
		expect(text).toContain("rename (1):");
		expect(text).toContain("Acme/A:docs/new.md  (from docs/old.md)");
		expect(text).toContain("scope: 1 repository read completely, tier <= 1, sources fs");
	});

	test("ingest problems are listed per status up to the limit", () => {
		const problems = Array.from({ length: LIST_LIMIT + 3 }, (_, i) => ({ repo: "Acme/A", path: `p${i}.md`, status: "failed" as const, reason: "plane-unavailable" }));
		const text = renderIngest({ counts: { ingested: 2, unchanged: 0, tombstoned: 0, refused: 0, failed: problems.length }, problems, manifestVersion: 4 });
		expect(text).toContain(`failed ${LIST_LIMIT + 3}`);
		expect(text).toContain(`failed (${LIST_LIMIT + 3}):`);
		expect(text).toContain("... and 3 more");
		expect(text).not.toContain("refused (");
	});
});
