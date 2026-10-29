import { describe, expect, test } from "bun:test";
import type { CorpusEntry, RepoDigest, RepoReport } from "@substrate/corpus";
import type { Inventory } from "./inventory.ts";
import { GAP_TEXT_LIMIT, LIST_LIMIT, REFLECT_PREVIEW_LIMIT, REPO_LIMIT, printable, renderGaps, renderIngest, renderInventory, renderPlan, renderReflectOutcome, renderReflectPlan } from "./render.ts";
import type { ReflectCollection } from "./reflect.ts";
import { gapsOf, planOf } from "./testkit.ts";

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

describe("printable", () => {
	test("writes every control character as an escape and leaves ordinary text, including non-ASCII, alone", () => {
		expect(printable("docs/a b.md")).toBe("docs/a b.md");
		expect(printable("docs/caf\u00e9-\u{1F600}.md")).toBe("docs/caf\u00e9-\u{1F600}.md");
		expect(printable("a\u001b[2Jb\nc\td\u007fe\u0085f\u2028g")).toBe("a\\x1b[2Jb\\x0ac\\x09d\\x7fe\\x85f\\u2028g");
	});

	test("a tracked file name with an escape sequence or a newline cannot rewrite the terminal or forge a report line", () => {
		const hostile = "docs/\u001b[2J\u001b[Hingest: ingested 999\nrefused (0):.md";
		const text = renderIngest({
			counts: { ingested: 0, updated: 0, unchanged: 0, tombstoned: 0, refused: 1, failed: 0 },
			problems: [{ repo: "Acme/A", path: hostile, status: "refused", reason: "bad-path" }],
			manifestVersion: 1,
		});
		expect(text).not.toContain("\u001b");
		expect(text.split("\n").filter((line) => line.startsWith("ingest:"))).toHaveLength(1);
		expect(text).toContain("Acme/A:docs/\\x1b[2J\\x1b[Hingest: ingested 999\\x0arefused (0):.md  [bad-path]");
		const plan = renderPlan(planOf([{ action: "add", repo: "Acme/A", path: hostile }]), inventory([repoReport("Acme/A")], []));
		expect(plan).not.toContain("\u001b");
	});
});

describe("renderReflectPlan, renderReflectOutcome and renderGaps", () => {
	function digest(repo: string): RepoDigest {
		return { repo, path: ".substrate/digest.md", text: `# Documentation digest: ${repo}\n`, key: `corpus-digest:${repo}`, sha256: "ab".repeat(32) };
	}

	test("a dry run shows the text of the first digests only and says how many texts were left out; an executed run shows none", () => {
		const collection: ReflectCollection = {
			digests: Array.from({ length: REFLECT_PREVIEW_LIMIT + 2 }, (_, index) => digest(`Acme/R${index}`)),
			skipped: [{ repo: "Acme/Bad\u001b", reason: "roadmap-empty" }],
			notes: ["a note\nwith a break"],
			checkouts: 9,
		};
		const dry = renderReflectPlan(collection, false);
		expect(dry).toContain(`reflect: ${REFLECT_PREVIEW_LIMIT + 2} digests from 9 checkouts found (dry run)`);
		expect(dry.split("\n").filter((line) => line.startsWith("--- Acme/R"))).toHaveLength(REFLECT_PREVIEW_LIMIT);
		expect(dry).toContain("Acme/R0  ".concat(String(digest("Acme/R0").text.length), " chars  sha abababababab"));
		expect(dry).toContain("... and 2 more digest texts (see --json)");
		expect(dry).toContain("Acme/Bad\\x1b  [roadmap-empty]");
		expect(dry).toContain("a note\\x0awith a break");
		expect(dry).not.toContain("\u001b");
		const executed = renderReflectPlan(collection, true);
		expect(executed).not.toContain("---");
		expect(executed).not.toContain("(dry run)");
	});

	test("the outcome lists counts, refused and failed digests with their reasons, and what was not sent", () => {
		const text = renderReflectOutcome({
			counts: { stored: 1, unchanged: 2, refused: 1, failed: 1 },
			problems: [
				{ repo: "Acme/A", status: "refused", reason: "secret-findings" },
				{ repo: "Acme/B", status: "failed" },
			],
			notSent: 3,
			manifestVersion: 4,
		});
		expect(text).toContain("reflect: stored 1, unchanged 2, refused 1, failed 1");
		expect(text).toContain("Acme/A  refused  [secret-findings]");
		expect(text).toContain("Acme/B  failed\n");
		expect(text).toContain("not sent: 3 digests");
	});

	test("gaps are escaped, long query text is cut and the cut list is announced", () => {
		const long = "q".repeat(GAP_TEXT_LIMIT + 50);
		const text = renderGaps(gapsOf([{ queryHash: "a".repeat(40), text: long, searches: 2, lastSeen: "2026-10-29T00:00:00.000Z", best: 0 }], true));
		expect(text).toContain("(the list is cut at the server limit)");
		expect(text).toContain(`"${"q".repeat(GAP_TEXT_LIMIT)}..."`);
		expect(text).toContain(`${"a".repeat(12)}  2 searches  best 0.000`);
		expect(renderGaps(gapsOf([]))).toBe("gaps: 0 queries the corpus could not answer well\n");
	});
});
