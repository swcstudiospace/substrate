import { describe, expect, test } from "bun:test";
import { classify, hasDocExtension, isExcludedSegment } from "./classify.ts";
import { DIGEST_PATH, DOC_KINDS, type DocKind, type DocTier, isDocKind } from "./protocol.ts";

type Row = [path: string, kind: DocKind, tier: DocTier];

const ROWS: Row[] = [
	// Rule 1: `.planning` documents.
	[".planning/STATE.md", "planning-state", 1],
	[".planning/ROADMAP.md", "planning-roadmap", 1],
	[".planning/REQUIREMENTS.md", "planning-requirements", 1],
	[".planning/PROJECT.md", "planning-project", 1],
	[".planning/MILESTONES.md", "planning-milestones", 1],
	[".planning/RETROSPECTIVE.md", "planning-milestones", 2],
	[".planning/milestones/v1.6-MILESTONE-AUDIT.md", "planning-audit", 2],
	[".planning/milestones/v1.6-ROADMAP.md", "planning-archive", 3],
	[".planning/milestones/v1.6-phases/60-x/60-CONTEXT.md", "planning-archive", 3],
	[".planning/phases/63-corpus-atlas/63-CONTEXT.md", "planning-context", 2],
	[".planning/phases/63-corpus-atlas/63-01-SUMMARY.md", "planning-summary", 2],
	[".planning/phases/63-corpus-atlas/63-VERIFICATION.md", "planning-verification", 2],
	[".planning/phases/63-corpus-atlas/63-01-PLAN.md", "planning-plan", 3],
	[".planning/phases/63-corpus-atlas/63-RESEARCH.md", "planning-research", 2],
	[".planning/phases/63-corpus-atlas/notes.md", "planning-other", 3],
	[".planning/research/stack.md", "planning-research", 2],
	[".planning/research/deep/stack.md", "planning-research", 2],
	[".planning/TODO.md", "planning-other", 2],
	[".planning/workstreams/a/STATE.md", "planning-other", 3],
	// A monorepo keeps `.planning` below the root, and the rules apply from that directory.
	["packages/app/.planning/STATE.md", "planning-state", 1],
	["packages/app/.planning/phases/1-x/1-CONTEXT.md", "planning-context", 2],
	// Matching is on the lowercased path.
	[".Planning/state.MD", "planning-state", 1],
	// Rule 2.
	["AGENTS.md", "agents", 1],
	["packages/x/CLAUDE.md", "agents", 1],
	["skills/foo/SKILL.md", "skill", 1],
	// Rule 3: changelogs are tier 1 at the root and tier 2 deeper.
	["CHANGELOG.md", "changelog", 1],
	["HISTORY.md", "changelog", 1],
	["RELEASES.md", "changelog", 1],
	["packages/x/CHANGELOG.md", "changelog", 2],
	["docs/changelog-2026.md", "changelog", 2],
	// Rule 4.
	["docs/adr/0001-use-bun.md", "adr", 1],
	["architecture/decisions/0002.md", "adr", 1],
	["ops/runbooks/restore.md", "runbook", 1],
	["docs/runbooks/restore.md", "runbook", 1],
	// Rule 5.
	["docs/corpus.md", "doc", 1],
	["docs/deep/nested/page.mdx", "doc", 1],
	["docs/research/notes.md", "doc", 2],
	["docs/README.md", "doc", 1],
	// Rule 6.
	["README.md", "readme", 1],
	["readme.rst", "readme", 1],
	["packages/corpus/README.md", "readme", 2],
	// Rule 7.
	["notes/ideas.md", "other", 3],
	["guide.adoc", "other", 3],
	["packages/x/docs/page.md", "other", 3],
	// The repository digest has its own virtual path; only that exact path is a digest.
	[".substrate/digest.md", "digest", 1],
	[".Substrate/Digest.md", "digest", 1],
	["packages/x/.substrate/digest.md", "other", 3],
	[".substrate/other.md", "other", 3],
];

describe("classify", () => {
	test.each(ROWS)("%s -> %s tier %d", (path, kind, tier) => {
		expect(classify(path)).toEqual({ kind, tier });
	});

	test("an extension outside .md, .mdx, .rst and .adoc is not a documentation candidate", () => {
		for (const path of ["src/index.ts", "README", "docs/diagram.png", "LICENSE", "notes.txt", "docs/a.md.bak"]) {
			expect(classify(path)).toBeNull();
		}
		expect(hasDocExtension("Page.MDX")).toBe(true);
		expect(hasDocExtension("page.md5")).toBe(false);
	});

	test("an excluded directory anywhere in the path removes the file, whatever its name", () => {
		const excluded = [
			"node_modules",
			".git",
			"dist",
			"build",
			"target",
			"vendor",
			".venv",
			"venv",
			"__pycache__",
			".next",
			".cache",
			"coverage",
			"site-packages",
			"third_party",
		];
		for (const segment of excluded) {
			expect(classify(`${segment}/README.md`)).toBeNull();
			expect(classify(`packages/x/${segment}/docs/page.md`)).toBeNull();
			expect(isExcludedSegment(segment.toUpperCase())).toBe(true);
		}
		expect(classify(".planning/vendor/STATE.md")).toBeNull();
		// A file named like an excluded directory is only a name.
		expect(classify("docs/build.md")).toEqual({ kind: "doc", tier: 1 });
		expect(isExcludedSegment("docs")).toBe(false);
	});

	test("the root flag overrides the single-segment default for root-sensitive rules", () => {
		expect(classify("README.md", { root: false })).toEqual({ kind: "readme", tier: 2 });
		expect(classify("sub/README.md", { root: true })).toEqual({ kind: "readme", tier: 1 });
		expect(classify("sub/CHANGELOG.md", { root: true })).toEqual({ kind: "changelog", tier: 1 });
	});

	test("backslash separators and leading ./ are read as the same path", () => {
		expect(classify(".\\docs\\adr\\0001.md")).toEqual({ kind: "adr", tier: 1 });
		expect(classify("./README.md")).toEqual({ kind: "readme", tier: 1 });
	});

	test("the digest kind is a known kind, and the digest path is the only way to get it", () => {
		expect(isDocKind("digest")).toBe(true);
		expect(DOC_KINDS.filter((kind) => kind === "digest")).toHaveLength(1);
		for (const [path] of ROWS) {
			if (classify(path)?.kind === "digest") expect(path.toLowerCase()).toBe(DIGEST_PATH);
		}
	});
});
