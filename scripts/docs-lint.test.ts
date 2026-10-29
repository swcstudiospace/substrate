import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brokenRelativeLinks, lintDocs, missingTitle } from "./docs-lint.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const made: string[] = [];

afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A repository tree in a temp directory: each key is a path relative to the root, each value the file text. */
function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "substrate-docs-lint-"));
	made.push(root);
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, name)), { recursive: true });
		writeFileSync(join(root, name), text);
	}
	return root;
}

describe("brokenRelativeLinks", () => {
	const here = "/repo/docs";
	const present = ["/repo/docs/a.md", "/repo/README.md"];
	const exists = (path: string): boolean => present.includes(path);

	test("flags a target that resolves to no file and accepts one that does", () => {
		expect(brokenRelativeLinks("[a](a.md) [b](missing.md) [c](../README.md)", here, exists)).toEqual(["missing.md"]);
	});

	test("strips the anchor before the existence check", () => {
		expect(brokenRelativeLinks("[a](a.md#top) [b](missing.md#top)", here, exists)).toEqual(["missing.md#top"]);
	});

	test("does not check anchors alone, absolute paths or URLs with a scheme", () => {
		const text = "[a](#top) [b](/etc/passwd) [c](https://example.com/x.md) [d](mailto:someone@example.com)";
		expect(brokenRelativeLinks(text, here, exists)).toEqual([]);
	});

	test("skips fenced code blocks, including a longer fence that holds a shorter one, and resumes after them", () => {
		const text = ["```md", "[a](missing.md)", "```", "[b](gone.md)", "````md", "```", "[c](missing.md)", "```", "````", "[d](also-gone.md)"].join("\n");
		expect(brokenRelativeLinks(text, here, exists)).toEqual(["gone.md", "also-gone.md"]);
	});

	test("skips inline code but not a link whose text is code", () => {
		const text = "`[a](missing.md)` and ``[b](`x`.md)`` and [`c`](gone.md)";
		expect(brokenRelativeLinks(text, here, exists)).toEqual(["gone.md"]);
	});
});

describe("missingTitle", () => {
	test("accepts a level-1 heading and rejects a document without one", () => {
		expect(missingTitle("# Title\n\ntext\n")).toBe(false);
		expect(missingTitle("text\n\n## Section\n")).toBe(true);
		expect(missingTitle("#Title\n")).toBe(true);
		expect(missingTitle("")).toBe(true);
	});

	test("looks for the title after YAML front matter, and does not take front matter text for it", () => {
		expect(missingTitle("---\nname: x\n---\n\n# Title\n")).toBe(false);
		expect(missingTitle("---\n# a comment: x\n---\n\ntext\n")).toBe(true);
	});

	test("does not count a heading inside a code fence", () => {
		expect(missingTitle("```sh\n# not a title\n```\n")).toBe(true);
	});
});

describe("lintDocs", () => {
	test("reports broken links in docs, planning archives and root documents, and says which file and target", () => {
		const root = tree({
			"README.md": "# Readme\n[a](docs/a.md) [b](docs/nope.md)\n",
			"docs/a.md": "# A\n[up](../README.md) [anchor](#x)\n",
			".planning/milestones/v1-ROADMAP.md": "no title here\n[x](MILESTONES.md)\n",
		});
		expect(lintDocs(root).brokenLinks).toEqual([
			{ file: "README.md", target: "docs/nope.md" },
			{ file: ".planning/milestones/v1-ROADMAP.md", target: "MILESTONES.md" },
		]);
	});

	test("requires a title in docs, live planning files and phase files but not in archives or the root documents", () => {
		const root = tree({
			"README.md": "no title\n",
			"docs/a.md": "# A\n",
			"docs/sub/b.md": "text only\n",
			".planning/STATE.md": "---\nstatus: x\n---\n# State\n",
			".planning/ROADMAP.md": "text only\n",
			".planning/phases/70-x/70-CONTEXT.md": "text only\n",
			".planning/milestones/v1.0-phases/01-x/01-01-PLAN.md": "text only\n",
			".planning/research/notes.md": "text only\n",
		});
		expect(lintDocs(root).missingTitles).toEqual(["docs/sub/b.md", ".planning/ROADMAP.md", ".planning/phases/70-x/70-CONTEXT.md"]);
	});

	test("serves text through the injected reader", () => {
		const root = tree({ "docs/a.md": "# A\n" });
		const result = lintDocs(root, () => "[x](missing.md)\n");
		expect(result.brokenLinks).toEqual([{ file: "docs/a.md", target: "missing.md" }]);
		expect(result.missingTitles).toEqual(["docs/a.md"]);
	});

	test("finds nothing in a repository without docs or planning trees", () => {
		expect(lintDocs(tree({ "other.txt": "x" }))).toEqual({ brokenLinks: [], missingTitles: [] });
	});
});

describe("the committed documents", () => {
	test("have no broken relative link and every docs page and live planning file has a level-1 title", () => {
		expect(existsSync(join(REPO_ROOT, "docs"))).toBe(true);
		const { brokenLinks, missingTitles } = lintDocs(REPO_ROOT);
		expect(brokenLinks.map(({ file, target }) => `${file}: ${target}`)).toEqual([]);
		expect(missingTitles).toEqual([]);
	});
});
