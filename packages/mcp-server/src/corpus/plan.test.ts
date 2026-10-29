import { describe, expect, test } from "bun:test";
import type { CorpusEntry, CorpusScope } from "@substrate/corpus";
import { planCorpus, planRepos } from "./plan.ts";
import { makeRow, sha256Hex } from "./testkit.ts";

const REPO = "swcstudiospace/agent-substrate";
const SCOPE: CorpusScope = { coverage: [{ repo: REPO, source: "fs" }], maxTier: 3 };

function entry(path: string, content: string, over: Partial<CorpusEntry> = {}): CorpusEntry {
	return { repo: REPO, path, kind: "doc", tier: 1, sha256: sha256Hex(content), bytes: content.length, source: "fs", ...over };
}

describe("planCorpus: the six actions", () => {
	test("an entry with no row is an add, the same sha is unchanged, a different sha is a change", () => {
		const rows = [makeRow({ repo: REPO, path: "docs/same.md", sha256: sha256Hex("same") }), makeRow({ repo: REPO, path: "docs/edited.md", sha256: sha256Hex("old") })];
		const plan = planCorpus([entry("docs/new.md", "new"), entry("docs/same.md", "same"), entry("docs/edited.md", "new text")], SCOPE, rows);
		expect(plan.counts).toEqual({ add: 1, change: 1, update: 0, rename: 0, tombstone: 0, unchanged: 1 });
		expect(plan.items).toEqual([
			{ action: "change", repo: REPO, path: "docs/edited.md", sha256: sha256Hex("new text") },
			{ action: "add", repo: REPO, path: "docs/new.md", sha256: sha256Hex("new") },
		]);
	});

	test("the same bytes under another source, kind or tier is an update, not unchanged and not a change", () => {
		const rows = [
			makeRow({ repo: REPO, path: "a.md", sha256: sha256Hex("a"), source: "github" }),
			makeRow({ repo: REPO, path: "b.md", sha256: sha256Hex("b"), kind: "doc" }),
			makeRow({ repo: REPO, path: "c.md", sha256: sha256Hex("c"), tier: 2 }),
		];
		const plan = planCorpus([entry("a.md", "a"), entry("b.md", "b", { kind: "runbook" }), entry("c.md", "c")], SCOPE, rows);
		expect(plan.counts).toEqual({ add: 0, change: 0, update: 3, rename: 0, tombstone: 0, unchanged: 0 });
		expect(plan.items.map((item) => item.action)).toEqual(["update", "update", "update"]);
	});

	test("an active row inside the coverage that the scan did not report is a tombstone", () => {
		const rows = [makeRow({ repo: REPO, path: "docs/gone.md", sha256: sha256Hex("gone") }), makeRow({ repo: REPO, path: "docs/kept.md", sha256: sha256Hex("kept") })];
		const plan = planCorpus([entry("docs/kept.md", "kept")], SCOPE, rows);
		expect(plan.counts).toEqual({ add: 0, change: 0, update: 0, rename: 0, tombstone: 1, unchanged: 1 });
		expect(plan.items).toEqual([{ action: "tombstone", repo: REPO, path: "docs/gone.md", sha256: sha256Hex("gone") }]);
	});

	test("the same text at a new path is one rename, naming the row it moved from, not an add plus a tombstone", () => {
		const rows = [makeRow({ repo: REPO, path: "docs/old-name.md", sha256: sha256Hex("moved") })];
		const plan = planCorpus([entry("docs/new-name.md", "moved")], SCOPE, rows);
		expect(plan.counts).toEqual({ add: 0, change: 0, update: 0, rename: 1, tombstone: 0, unchanged: 0 });
		expect(plan.items).toEqual([{ action: "rename", repo: REPO, path: "docs/new-name.md", sha256: sha256Hex("moved"), renamedFrom: "docs/old-name.md" }]);
	});

	test("renames pair one to one: two removed rows and one new copy leave one tombstone", () => {
		const rows = [makeRow({ repo: REPO, path: "a.md", sha256: sha256Hex("t") }), makeRow({ repo: REPO, path: "b.md", sha256: sha256Hex("t") })];
		const plan = planCorpus([entry("c.md", "t")], SCOPE, rows);
		expect(plan.counts).toMatchObject({ rename: 1, tombstone: 1, add: 0 });
		expect(plan.items).toEqual([
			{ action: "tombstone", repo: REPO, path: "b.md", sha256: sha256Hex("t") },
			{ action: "rename", repo: REPO, path: "c.md", sha256: sha256Hex("t"), renamedFrom: "a.md" },
		]);
	});

	test("a rename never crosses repositories", () => {
		const other = "swcstudiospace/programming-desk";
		const rows = [makeRow({ repo: other, path: "docs/a.md", sha256: sha256Hex("t") })];
		const plan = planCorpus([entry("docs/b.md", "t")], { ...SCOPE, coverage: [...SCOPE.coverage, { repo: other, source: "fs" }] }, rows);
		expect(plan.counts).toMatchObject({ add: 1, tombstone: 1, rename: 0 });
	});

	test("a change is not a rename candidate: the same text appearing as a change leaves the removed row a tombstone", () => {
		const rows = [makeRow({ repo: REPO, path: "docs/gone.md", sha256: sha256Hex("t") }), makeRow({ repo: REPO, path: "docs/edited.md", sha256: sha256Hex("before") })];
		const plan = planCorpus([entry("docs/edited.md", "t")], SCOPE, rows);
		expect(plan.counts).toMatchObject({ change: 1, tombstone: 1, rename: 0 });
	});

	test("a tombstoned row whose key reappears is an add", () => {
		const rows = [makeRow({ repo: REPO, path: "docs/back.md", sha256: sha256Hex("text"), state: "tombstoned" })];
		const plan = planCorpus([entry("docs/back.md", "text")], SCOPE, rows);
		expect(plan.counts).toMatchObject({ add: 1, unchanged: 0, change: 0, update: 0 });
		expect(plan.items).toEqual([{ action: "add", repo: REPO, path: "docs/back.md", sha256: sha256Hex("text") }]);
	});

	test("a tombstoned row nobody reports stays as it is: it is not tombstoned again", () => {
		const rows = [makeRow({ repo: REPO, path: "docs/dead.md", state: "tombstoned" })];
		expect(planCorpus([], SCOPE, rows).items).toEqual([]);
	});
});

describe("planCorpus: only a covered (repo, source) pair is judged", () => {
	const rows = [
		makeRow({ repo: REPO, path: "docs/in-scope.md", tier: 1, source: "fs" }),
		makeRow({ repo: REPO, path: "docs/tier3.md", tier: 3, source: "fs" }),
		makeRow({ repo: REPO, path: "docs/from-github.md", tier: 1, source: "github" }),
		makeRow({ repo: "swcstudiospace/other", path: "docs/elsewhere.md", tier: 1, source: "fs" }),
	];

	test("only the row inside every limit is a tombstone when the scan reports nothing", () => {
		const plan = planCorpus([], { coverage: [{ repo: REPO, source: "fs" }], maxTier: 2 }, rows);
		expect(plan.items.map((item) => item.path)).toEqual(["docs/in-scope.md"]);
	});

	test("a row whose source is not in the covered pair is never tombstoned, even in a covered repository", () => {
		const fsOnly = planCorpus([], { coverage: [{ repo: REPO, source: "fs" }], maxTier: 3 }, rows);
		expect(fsOnly.items.map((item) => item.path)).toEqual(["docs/in-scope.md", "docs/tier3.md"]);
		const both = planCorpus(
			[],
			{
				coverage: [
					{ repo: REPO, source: "fs" },
					{ repo: REPO, source: "github" },
				],
				maxTier: 1,
			},
			rows,
		);
		expect(both.items.map((item) => item.path).sort()).toEqual(["docs/from-github.md", "docs/in-scope.md"]);
	});

	test("a repository left out of the coverage (it failed to read or was cut by --max-repos) keeps every row", () => {
		const plan = planCorpus([], { coverage: [{ repo: "swcstudiospace/unrelated", source: "fs" }], maxTier: 3 }, rows);
		expect(plan.items).toEqual([]);
		expect(plan.counts.tombstone).toBe(0);
	});

	test("an empty coverage plans the entries and tombstones nothing", () => {
		const plan = planCorpus([entry("docs/new.md", "new"), entry("docs/elsewhere.md", "changed", { repo: "swcstudiospace/other" })], { coverage: [], maxTier: 3 }, rows);
		expect(plan.counts).toMatchObject({ add: 1, change: 1, tombstone: 0 });
		expect(plan.items.some((item) => item.action === "tombstone")).toBe(false);
	});

	test("an entry from a repo outside the coverage is still planned as an add or a change, but nothing else of that repo is judged", () => {
		const plan = planCorpus([entry("docs/elsewhere.md", "changed", { repo: "swcstudiospace/other" })], { coverage: [{ repo: REPO, source: "fs" }], maxTier: 3 }, rows);
		expect(plan.items.filter((item) => item.repo === "swcstudiospace/other")).toEqual([
			{ action: "change", repo: "swcstudiospace/other", path: "docs/elsewhere.md", sha256: sha256Hex("changed") },
		]);
		expect(plan.items.filter((item) => item.action === "tombstone").map((item) => item.path)).toEqual(["docs/in-scope.md", "docs/tier3.md"]);
	});
});

describe("planRepos", () => {
	test("names the repositories the entries mention and the coverage lists, once each", () => {
		const repos = planRepos([entry("a.md", "a"), entry("b.md", "b", { repo: "acme/other" })], {
			coverage: [
				{ repo: REPO, source: "fs" },
				{ repo: REPO, source: "github" },
				{ repo: "acme/third", source: "fs" },
			],
			maxTier: 3,
		});
		expect([...repos].sort()).toEqual([REPO, "acme/other", "acme/third"].sort());
	});
});
