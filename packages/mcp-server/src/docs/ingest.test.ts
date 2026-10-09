import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RagflowClient, RagflowError } from "./ragflow.ts";
import type {
	RagflowDatasetSummary,
	RagflowDocument,
	UploadedDocument,
	UploadFile,
} from "./ragflow.ts";
import { clearDatasetCache } from "./registry.ts";
import type { DatasetEntry } from "./registry.ts";
import {
	MAX_CONTENT_BYTES,
	hashPage,
	ingestPage,
	splitSections,
	stripImages,
} from "./ingest.ts";
import type { DocsRagflow } from "./manifest.ts";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
// Runtime-assembled fixtures, never credentials.
const SECRET = "ghp_" + "c".repeat(36);

const REGISTRY: DatasetEntry[] = [
	{
		name: "test-docs",
		slug: "ExampleOrg/test-docs",
		include: ["docs/**/*.md", "README.md"],
		exclude: ["docs/receipts/**"],
		trigger: "merge-to-main",
		datasetId: "ds-test",
	},
];

function url(commit: string, path: string): string {
	return `https://github.com/ExampleOrg/test-docs/blob/${commit}/${path}`;
}

function input(over: Record<string, unknown> = {}) {
	return {
		dataset: "test-docs",
		sourceUrl: url(COMMIT_A, "docs/guide.md"),
		commit: COMMIT_A,
		content: "# Guide\n\nHello.\n",
		surface: "substrate",
		isSubstrateOrOperator: true,
		...over,
	};
}

interface StoredDoc {
	id: string;
	name: string;
	run: string;
	metaFields: Record<string, unknown>;
	content: string;
}

class FakeRagflow implements DocsRagflow {
	datasets = new Map<string, { id: string; name: string; docs: Map<string, StoredDoc> }>();
	calls = {
		listDatasets: 0,
		listDocuments: 0,
		uploadDocuments: 0,
		parseDocuments: 0,
		updateDocument: 0,
		deleteDocuments: 0,
		ensureDataset: 0,
	};
	failUploadsWith: Error | null = null;
	failParsesWith: Error | null = null;
	ensureCalls: Array<{ name: string; embeddingModel?: string }> = [];
	seq = 0;

	totalCalls(): number {
		return Object.values(this.calls).reduce((a, b) => a + b, 0);
	}

	private dataset(id: string) {
		let found = [...this.datasets.values()].find((row) => row.id === id);
		if (!found) {
			found = { id, name: id, docs: new Map() };
			this.datasets.set(id, found);
		}
		return found;
	}

	async listDatasets(): Promise<RagflowDatasetSummary[]> {
		this.calls.listDatasets += 1;
		return [...this.datasets.values()].map((row) => ({
			id: row.id,
			name: row.name,
			embeddingModel: undefined,
		}));
	}

	async listDocuments(datasetId: string, page = 1, pageSize = 100): Promise<RagflowDocument[]> {
		this.calls.listDocuments += 1;
		const docs = [...(this.datasets.get(datasetId)?.docs.values() ?? [])];
		return docs.slice((page - 1) * pageSize, page * pageSize).map((doc) => ({
			id: doc.id,
			name: doc.name,
			run: doc.run,
			metaFields: { ...doc.metaFields },
			raw: {},
		}));
	}

	async uploadDocuments(datasetId: string, files: UploadFile[]): Promise<UploadedDocument[]> {
		this.calls.uploadDocuments += 1;
		if (this.failUploadsWith) throw this.failUploadsWith;
		const ds = this.dataset(datasetId);
		return files.map((file) => {
			this.seq += 1;
			const id = `doc-${this.seq}`;
			ds.docs.set(id, {
				id,
				name: file.filename,
				run: "UNSTART",
				metaFields: {},
				content: String(file.content),
			});
			return { documentId: id, name: file.filename };
		});
	}

	async parseDocuments(datasetId: string, documentIds: string[]): Promise<void> {
		this.calls.parseDocuments += 1;
		if (this.failParsesWith) throw this.failParsesWith;
		for (const id of documentIds) {
			const doc = this.datasets.get(datasetId)?.docs.get(id);
			if (doc) doc.run = "DONE";
		}
	}

	async updateDocument(
		datasetId: string,
		documentId: string,
		patch: { name?: string; metaFields?: Record<string, unknown> },
	): Promise<void> {
		this.calls.updateDocument += 1;
		const doc = this.datasets.get(datasetId)?.docs.get(documentId);
		if (!doc) throw new RagflowError("ragflow error 102: no such document");
		if (patch.name !== undefined) doc.name = patch.name;
		if (patch.metaFields !== undefined) doc.metaFields = { ...patch.metaFields };
	}

	async deleteDocuments(datasetId: string, documentIds: string[]): Promise<void> {
		this.calls.deleteDocuments += 1;
		for (const id of documentIds) this.datasets.get(datasetId)?.docs.delete(id);
	}

	async ensureDataset(
		name: string,
		options: { description?: string; embeddingModel?: string; chunkMethod?: string } = {},
	): Promise<string> {
		this.calls.ensureDataset += 1;
		this.ensureCalls.push({ name, embeddingModel: options.embeddingModel });
		const id = `id-${name}`;
		if (!this.datasets.has(id)) this.datasets.set(id, { id, name, docs: new Map() });
		return id;
	}
}

let stateDir = "";
let fake = new FakeRagflow();

beforeEach(async () => {
	clearDatasetCache();
	stateDir = await mkdtemp(join(tmpdir(), "docs-25-02-ingest-"));
	fake = new FakeRagflow();
});

async function expectPristine(): Promise<void> {
	expect(fake.totalCalls()).toBe(0);
	expect(await readdir(stateDir)).toEqual([]);
}

describe("stripImages", () => {
	test("every image class is replaced, links survive, count pinned", () => {
		const content = [
			"# T",
			"",
			"Remote ![Diagram](https://example.com/a.png) here.",
			"Local ![Shot](./img/shot.png) here.",
			'<img src="logo.png" alt="Logo">',
			'<picture><source srcset="a.webp" type="image/webp"><img src="a.png" alt="Photo"></picture>',
			"Data ![Inline](data:image/png;base64,iVBORw0KGgo=) here.",
			"Ref ![Alt text][logo] here.",
			"",
			"[logo]: https://example.com/logo.png",
			"[keep-link]: https://example.com/page",
			"A [link](https://example.com/page) and a [ref][keep-link] stay.",
			"",
		].join("\n");
		const { text, imagesStripped } = stripImages(content);
		expect(imagesStripped).toBe(6);
		expect(text).toContain("[image: Diagram]");
		expect(text).toContain("[image: Shot]");
		expect(text).toContain("[image: Logo]");
		expect(text).toContain("[image: Photo]");
		expect(text).toContain("[image: Inline]");
		expect(text).toContain("[image: Alt text]");
		expect(text).not.toContain("example.com/a.png");
		expect(text).not.toContain("data:image");
		expect(text).not.toContain("<img");
		expect(text).not.toContain("<picture");
		expect(text).not.toContain("<source");
		expect(text).not.toContain("[logo]:");
		// Links are kept, with their definitions.
		expect(text).toContain("[link](https://example.com/page)");
		expect(text).toContain("[ref][keep-link]");
		expect(text).toContain("[keep-link]: https://example.com/page");
	});

	test("an image without alt text leaves nothing", () => {
		const { text, imagesStripped } = stripImages("See ![](x.png) now.");
		expect(imagesStripped).toBe(1);
		expect(text).toBe("See  now.");
	});

	test("a definition shared with a link survives its image", () => {
		const { text } = stripImages("![Pic][shared]\n\n[shared]: https://example.com/s.png\n\nSee [it][shared].\n");
		expect(text).toContain("[image: Pic]");
		expect(text).toContain("[shared]: https://example.com/s.png");
	});

	test("a shortcut reference strips only with a definition", () => {
		const withDef = stripImages("See ![Pic] here.\n\n[Pic]: https://example.com/p.png\n");
		expect(withDef.imagesStripped).toBe(1);
		expect(withDef.text).toContain("[image: Pic]");
		const withoutDef = stripImages("See ![Pic] here.\n");
		expect(withoutDef.imagesStripped).toBe(0);
		expect(withoutDef.text).toContain("![Pic]");
	});

	test("balanced parens in the destination strip as one image", () => {
		const { text, imagesStripped } = stripImages("See ![plot](images/plot_(wide).png) now.");
		expect(imagesStripped).toBe(1);
		expect(text).toBe("See [image: plot] now.");
	});

	test("nested brackets in the alt text strip as one image", () => {
		const { text, imagesStripped } = stripImages("See ![outer [inner]](plot.png) now.");
		expect(imagesStripped).toBe(1);
		expect(text).toBe("See [image: outer [inner]] now.");
	});

	test("many shortcut references resolve against one definition set", () => {
		const refs = Array.from({ length: 20 }, (_, i) => `See ![Pic${i}] here.`).join("\n");
		const defs = Array.from({ length: 20 }, (_, i) => `[Pic${i}]: https://example.com/p${i}.png`).join("\n");
		const { text, imagesStripped } = stripImages(`${refs}\n\n${defs}\n`);
		expect(imagesStripped).toBe(20);
		expect(text).not.toContain("![Pic");
		expect(text).not.toContain("[Pic0]:");
	});

	test("an image nested inside a failed candidate stays literal", () => {
		// Single-pass scan: the outer candidate fails at end of input, so
		// its whole extent (including the nested `![inner](x.png)`) is
		// emitted literally instead of rescanning the inside.
		const content = "See ![outer ![inner](x.png) now.";
		const { text, imagesStripped } = stripImages(content);
		expect(imagesStripped).toBe(0);
		expect(text).toBe(content);
	});

	test("a nested candidate after a newline still strips", () => {
		const { text, imagesStripped } = stripImages("See ![unclosed\n![real](x.png) end.");
		expect(imagesStripped).toBe(1);
		expect(text).toBe("See ![unclosed\n[image: real] end.");
	});

	test("a long single line of unclosed images completes quickly", () => {
		// Unclosed destinations with no newline: the old scanner rescanned
		// to end of line per candidate (quadratic); the single pass emits
		// each failed extent literally once. Bare `![` repeats are avoided
		// here because they also scan the intentionally-untouched
		// reference regexes below, not the rewritten scanner.
		const big = "![a](x".repeat(34_000);
		const started = Date.now();
		const { text, imagesStripped } = stripImages(big);
		const elapsed = Date.now() - started;
		expect(text).toBe(big);
		expect(imagesStripped).toBe(0);
		expect(elapsed).toBeLessThan(5000);
	});
});

describe("splitSections", () => {
	const base = {
		path: "docs/guide.md",
		sourceUrl: url(COMMIT_A, "docs/guide.md"),
		commit: COMMIT_A,
		contentSha256: "hash",
	};

	test("preamble, breadcrumb, anchors, and first-H1 title", () => {
		const text = ["Intro.", "", "# Guide", "", "Body.", "", "## Part", "", "Deep.", "", "### Bit", "", "End."].join("\n");
		const split = splitSections({ ...base, text });
		expect(split.title).toBe("Guide");
		expect(split.sections.length).toBe(4);
		expect(split.sections[0]!.headingPath).toEqual([]);
		expect(split.sections[0]!.anchor).toBeNull();
		expect(split.sections[0]!.sourceUrl).toBe(base.sourceUrl);
		expect(split.sections[0]!.text.startsWith("Guide\n\nIntro.")).toBe(true);
		expect(split.sections[1]!.headingPath).toEqual(["Guide"]);
		expect(split.sections[1]!.sourceUrl).toBe(`${base.sourceUrl}#guide`);
		expect(split.sections[2]!.headingPath).toEqual(["Guide", "Part"]);
		expect(split.sections[2]!.text.startsWith("Guide / Part\n\n")).toBe(true);
		expect(split.sections[3]!.headingPath).toEqual(["Guide", "Part", "Bit"]);
		expect(split.sections.map((section) => section.index)).toEqual([0, 1, 2, 3]);
	});

	test("explicit title wins; no H1 falls back to the file name", () => {
		const named = splitSections({ ...base, text: "## Only\n\nBody.\n", title: "Given" });
		expect(named.title).toBe("Given");
		expect(named.sections[0]!.text.startsWith("Given\n\n")).toBe(true);
		const bare = splitSections({ ...base, text: "## Only\n\nBody.\n" });
		expect(bare.title).toBe("guide.md");
	});

	test("fenced `#` lines and H4 never split", () => {
		const text = ["# T", "", "```", "# not a heading", "```", "", "#### H4 stays", "", "Tail."].join("\n");
		const split = splitSections({ ...base, text });
		expect(split.sections.length).toBe(2);
		expect(split.sections[1]!.text).toContain("# not a heading");
		expect(split.sections[1]!.text).toContain("#### H4 stays");
	});
	test("repeated headings get GitHub-style unique anchors and non-ASCII letters survive", () => {
		const text = ["# Install", "", "First.", "", "## Install", "", "Second.", "", "## Install", "", "Third."].join("\n");
		const split = splitSections({ ...base, text });
		expect(split.sections.map((section) => section.anchor)).toEqual([null, "install", "install-1", "install-2"]);
		expect(split.sections[3]!.sourceUrl).toBe(`${base.sourceUrl}#install-2`);
		const umlaut = splitSections({ ...base, text: "# Über uns\n\nBody.\n" });
		expect(umlaut.sections[1]!.anchor).toBe("über-uns");
	});
});

describe("hashPage", () => {
	test("stable across commits, distinct across paths and texts", () => {
		const a = hashPage("final text", "docs/a.md");
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(hashPage("final text", "docs/a.md")).toBe(a);
		expect(hashPage("other text", "docs/a.md")).not.toBe(a);
		expect(hashPage("final text", "docs/b.md")).not.toBe(a);
	});

	test("title-only edits hash differently", () => {
		const a = hashPage("final text", "docs/a.md", "Guide");
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(hashPage("final text", "docs/a.md", "Guide")).toBe(a);
		expect(hashPage("final text", "docs/a.md", "Other")).not.toBe(a);
		expect(hashPage("final text", "docs/a.md")).not.toBe(a);
	});
});

describe("pipeline refusals never reach RAGFlow", () => {
	test("non substrate/operator callers are forbidden", async () => {
		const result = await ingestPage(input({ isSubstrateOrOperator: false }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(result).toEqual({ status: "refused", reason: "forbidden" });
		await expectPristine();
	});

	test("unknown dataset names refuse without a call", async () => {
		const result = await ingestPage(input({ dataset: "nope" }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(result).toEqual({ status: "refused", reason: "unknown-dataset" });
		await expectPristine();
	});

	test("missing and empty sources are no-source", async () => {
		for (const sourceUrl of ["", undefined]) {
			const result = await ingestPage(input({ sourceUrl }), {
				registry: REGISTRY,
				client: fake,
				stateDir,
			});
			expect(result).toEqual({ status: "refused", reason: "no-source" });
		}
		await expectPristine();
	});

	test("outside-roots covers host, slug, commit, traversal, and globs", async () => {
		const bad = [
			`http://gitlab.com/ExampleOrg/test-docs/blob/${COMMIT_A}/docs/guide.md`,
			`https://github.com/ExampleOrg/other/blob/${COMMIT_A}/docs/guide.md`,
			url(COMMIT_B, "docs/guide.md"),
			`https://github.com/ExampleOrg/test-docs/blob/${COMMIT_A}/docs/../guide.md`,
			`https://github.com/ExampleOrg/test-docs/blob/${COMMIT_A}/docs/%2E%2E/guide.md`,
			`https://github.com/ExampleOrg/test-docs/blob/${COMMIT_A}/src/code.ts`,
			`https://github.com/ExampleOrg/test-docs/blob/${COMMIT_A}/docs/receipts/r.md`,
			`https://github.com/ExampleOrg/test-docs/blob/nothex/docs/guide.md`,
		];
		for (const sourceUrl of bad) {
			const result = await ingestPage(input({ sourceUrl }), {
				registry: REGISTRY,
				client: fake,
				stateDir,
			});
			expect(result).toEqual({ status: "refused", reason: "outside-roots" });
		}
		const backslash = await ingestPage(
			input({ sourceUrl: `https://github.com/ExampleOrg/test-docs/blob/${COMMIT_A}/docs%5Cguide.md` }),
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(backslash).toEqual({ status: "refused", reason: "outside-roots" });
		await expectPristine();
	});

	test("percent-encoded paths match exclusions after decoding", async () => {
		// `%72` is `r`: the still-encoded path matches `docs/**/*.md` but
		// only the decoded `docs/receipts/r.md` hits the exclusion.
		// (`%52` decodes to `R`, a genuinely different path under
		// case-sensitive roots, so it is not refused here.)
		const bad = [
			`https://github.com/ExampleOrg/test-docs/blob/${COMMIT_A}/docs/%72eceipts/r.md`,
			`https://github.com/ExampleOrg/test-docs/blob/${COMMIT_A}/docs/receipts/%72.md`,
			`https://github.com/ExampleOrg/test-docs/blob/${COMMIT_A}/docs/%zz.md`,
			`https://github.com/ExampleOrg/test-docs/blob/${COMMIT_A}/docs/%/guide.md`,
			`https://github.com/ExampleOrg/test-docs/blob/${COMMIT_A}/docs/%2e%2e/guide.md`,
		];
		for (const sourceUrl of bad) {
			const result = await ingestPage(input({ sourceUrl }), {
				registry: REGISTRY,
				client: fake,
				stateDir,
			});
			expect(result).toEqual({ status: "refused", reason: "outside-roots" });
		}
		await expectPristine();
	});

	test("non-text content refuses: extension, NUL, lone surrogate", async () => {
		const byExt = await ingestPage(input({ sourceUrl: url(COMMIT_A, "docs/logo.png") }), {
			registry: [{ ...REGISTRY[0]!, include: ["docs/**"], exclude: [] }],
			client: fake,
			stateDir,
		});
		expect(byExt).toEqual({ status: "refused", reason: "not-text" });
		const nul = await ingestPage(input({ content: "# T\n\0\n" }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(nul).toEqual({ status: "refused", reason: "not-text" });
		const lone = await ingestPage(input({ content: `# T\n${String.fromCharCode(0xd800)}\n` }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(lone).toEqual({ status: "refused", reason: "not-text" });
		await expectPristine();
	});

	test("too-large covers post-strip bytes, title chars, and section count", async () => {
		const big = await ingestPage(input({ content: "a".repeat(MAX_CONTENT_BYTES + 1) }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(big).toEqual({ status: "refused", reason: "too-large" });
		const longTitle = await ingestPage(input({ title: "t".repeat(201) }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(longTitle).toEqual({ status: "refused", reason: "too-large" });
		const many = Array.from({ length: 201 }, (_, i) => `## S${i}\n\nBody.\n`).join("\n");
		const sections = await ingestPage(input({ content: `# T\n\n${many}` }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(sections).toEqual({ status: "refused", reason: "too-large" });
		await expectPristine();
	});

	test("a planted secret refuses with line+rule findings and no values", async () => {
		const content = `# Guide\n\nSee the token below.\n\n${SECRET}\n`;
		const result = await ingestPage(input({ content }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(result.status).toBe("refused");
		if (result.status !== "refused") throw new Error("unreachable");
		expect(result.reason).toBe("secret");
		expect(result.findings).toEqual([{ line: 5, rule: "github" }]);
		expect(JSON.stringify(result)).not.toContain(SECRET);
		expect(JSON.stringify(result)).not.toContain("c".repeat(36));
		await expectPristine();
	});

	test("alt text is redacted with the page", async () => {
		const result = await ingestPage(input({ content: `# T\n\n![${SECRET}](x.png)\n` }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(result.status).toBe("refused");
		if (result.status !== "refused") throw new Error("unreachable");
		expect(result.reason).toBe("secret");
		await expectPristine();
	});

	test("an explicit title carrying a secret refuses without a call", async () => {
		const result = await ingestPage(input({ title: SECRET }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(result.status).toBe("refused");
		if (result.status !== "refused") throw new Error("unreachable");
		expect(result.reason).toBe("secret");
		expect(result.findings).toEqual([{ line: 1, rule: "github" }]);
		expect(JSON.stringify(result)).not.toContain(SECRET);
		expect(JSON.stringify(result)).not.toContain("c".repeat(36));
		await expectPristine();
	});
	test("a secret in the file name refuses before upload names or titles", async () => {
		// Harmless content with no H1: without the path check the basename
		// fallback would publish the token as the title, upload name, and
		// source_url.
		const result = await ingestPage(
			input({ sourceUrl: url(COMMIT_A, `docs/${SECRET}.md`), content: "Just some docs.\n" }),
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(result.status).toBe("refused");
		if (result.status !== "refused") throw new Error("unreachable");
		expect(result.reason).toBe("secret");
		expect(result.findings).toEqual([{ line: 1, rule: "github" }]);
		expect(JSON.stringify(result)).not.toContain(SECRET);
		expect(JSON.stringify(result)).not.toContain("c".repeat(36));
		await expectPristine();
	});

	test("source URLs with credentials, query, or fragment refuse", async () => {
		const base = url(COMMIT_A, "docs/guide.md");
		const bad = [`${base}?token=abc`, `${base}#section`, base.replace("https://", "https://user:pass@")];
		for (const sourceUrl of bad) {
			const result = await ingestPage(input({ sourceUrl }), {
				registry: REGISTRY,
				client: fake,
				stateDir,
			});
			expect(result).toEqual({ status: "refused", reason: "outside-roots" });
		}
		await expectPristine();
	});

	test("an H1-derived title over the cap refuses", async () => {
		const result = await ingestPage(input({ content: `# ${"t".repeat(201)}\n\nBody.\n` }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(result).toEqual({ status: "refused", reason: "too-large" });
		await expectPristine();
	});
});

describe("pipeline success", () => {
	test("upload records hash, meta_fields, and the manifest", async () => {
		const content = `# Guide\n\nHello ![Alt](x.png).\n\n## Part\n\nBody.\n`;
		const result = await ingestPage(input({ content }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(result.status).toBe("uploaded");
		if (result.status !== "uploaded") throw new Error("unreachable");
		expect(result.sections).toBe(3);
		expect(result.imagesStripped).toBe(1);
		expect(result.redactions).toBe(0);
		expect(result.title).toBe("Guide");
		expect(result.documentIds.length).toBe(3);
		expect(result.contentSha256).toMatch(/^[0-9a-f]{64}$/);
		const docs = await fake.listDocuments("ds-test");
		expect(docs.length).toBe(3);
		expect(docs[0]!.metaFields).toMatchObject({
			path: "docs/guide.md",
			content_sha256: result.contentSha256,
			commit: COMMIT_A,
			title: "Guide",
			section_index: 0,
		});
		expect(docs[1]!.metaFields.source_url).toBe(`${url(COMMIT_A, "docs/guide.md")}#guide`);
		expect(docs[0]!.name).toContain("docs/guide.md");
		expect(docs[0]!.name).toContain(result.contentSha256.slice(0, 12));
		const uploaded = docs[1]!;
		const stored = fake.datasets.get("ds-test")!.docs.get(uploaded.id)!;
		expect(stored.content.startsWith("Guide\n\n")).toBe(true);
		expect(stored.content).toContain("[image: Alt]");
		// Manifest persisted under the tmp state dir.
		const saved = JSON.parse(
			await readFile(join(stateDir, "test-docs", "manifest.json"), "utf8"),
		) as { paths: Record<string, { hash: string; documentIds: string[] }> };
		expect(saved.paths["docs/guide.md"]!.hash).toBe(result.contentSha256);
		expect(saved.paths["docs/guide.md"]!.documentIds).toEqual(result.documentIds);
	});

	test("contextual hits redact in place and count", async () => {
		const value = "hunter2x9qwert";
		const result = await ingestPage(input({ content: `# T\n\npassword: ${value}\n` }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(result.status).toBe("uploaded");
		if (result.status !== "uploaded") throw new Error("unreachable");
		expect(result.redactions).toBe(1);
		const stored = fake.datasets.get("ds-test")!.docs.get(result.documentIds[0]!)!;
		expect(stored.content).not.toContain(value);
	});

	test("the cap measures stripped text: oversize raw still uploads", async () => {
		const raw = `![${"a".repeat(100)}](${"b".repeat(MAX_CONTENT_BYTES)})`;
		const result = await ingestPage(input({ content: `# T\n\n${raw}\n` }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(result.status).toBe("uploaded");
		if (result.status !== "uploaded") throw new Error("unreachable");
		expect(result.imagesStripped).toBe(1);
	});

	test("exactly the cap uploads; one byte more refuses", async () => {
		const exact = await ingestPage(input({ content: "a".repeat(MAX_CONTENT_BYTES) }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(exact.status).toBe("uploaded");
	});

	test("dry_run reports without side effects", async () => {
		const result = await ingestPage(input({ content: "# T\n\nBody ![A](x.png).\n", dryRun: true }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(result.status).toBe("dry_run");
		if (result.status !== "dry_run") throw new Error("unreachable");
		expect(result.sections).toBe(2);
		expect(result.imagesStripped).toBe(1);
		expect(result.wouldUpload).toBe(true);
		expect(result.contentSha256).toMatch(/^[0-9a-f]{64}$/);
		await expectPristine();
	});

	test("identical pages short-circuit; new commits hash the same", async () => {
		const first = await ingestPage(input(), { registry: REGISTRY, client: fake, stateDir });
		expect(first.status).toBe("uploaded");
		const second = await ingestPage(input(), { registry: REGISTRY, client: fake, stateDir });
		expect(second.status).toBe("unchanged");
		if (first.status !== "uploaded" || second.status !== "unchanged") throw new Error("unreachable");
		expect(second.documentIds).toEqual(first.documentIds);
		const moved = await ingestPage(input({ commit: COMMIT_B, sourceUrl: url(COMMIT_B, "docs/guide.md") }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(moved.status).toBe("unchanged");
		expect(fake.calls.uploadDocuments).toBe(1);
		expect(fake.calls.parseDocuments).toBe(1);
		const changed = await ingestPage(input({ content: "# Guide\n\nChanged.\n" }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(changed.status).toBe("uploaded");
		expect(fake.calls.uploadDocuments).toBe(2);
	});

	test("concurrent identical ingests produce one upload", async () => {
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				ingestPage(input(), { registry: REGISTRY, client: fake, stateDir }),
			),
		);
		expect(fake.calls.uploadDocuments).toBe(1);
		expect(fake.calls.parseDocuments).toBe(1);
		expect(results.filter((row) => row.status === "uploaded").length).toBe(1);
		expect(results.filter((row) => row.status === "unchanged").length).toBe(4);
	});

	test("a missing dataset is created once with the embedding model", async () => {
		const registry: DatasetEntry[] = [{ ...REGISTRY[0]!, name: "fresh", datasetId: undefined }];
		const fresh = { ...input(), dataset: "fresh", sourceUrl: url(COMMIT_A, "docs/guide.md") };
		const result = await ingestPage(fresh, {
			registry,
			client: fake,
			stateDir,
			embeddingModel: "test-model",
		});
		expect(result.status).toBe("uploaded");
		if (result.status !== "uploaded") throw new Error("unreachable");
		expect(result.datasetId).toBe("id-fresh");
		expect(fake.ensureCalls).toEqual([{ name: "fresh", embeddingModel: "test-model" }]);
	});

	test("RAGFlow failures map to failed without throwing", async () => {
		fake.failUploadsWith = new RagflowError("ragflow timeout after 10ms");
		const timed = await ingestPage(input(), { registry: REGISTRY, client: fake, stateDir });
		expect(timed).toEqual({
			status: "failed",
			reason: "ragflow-timeout",
			message: "ragflow timeout after 10ms",
		});
		fake.failUploadsWith = new RagflowError("ragflow error 109: bad");
		const errored = await ingestPage(input(), { registry: REGISTRY, client: fake, stateDir });
		expect(errored.status).toBe("failed");
	});

	test("a quiet title redaction applies in place and counts", async () => {
		const value = "hunter2x9qwert";
		const result = await ingestPage(input({ title: `password: ${value}`, content: "# Guide\n\nHello.\n" }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(result.status).toBe("uploaded");
		if (result.status !== "uploaded") throw new Error("unreachable");
		expect(result.redactions).toBe(1);
		expect(result.title).toBe("password: [REDACTED]");
		const docs = await fake.listDocuments("ds-test");
		expect(docs[0]!.metaFields.title).toBe("password: [REDACTED]");
		expect(JSON.stringify(docs)).not.toContain(value);
	});

	test("an explicit title's remote image is stripped before section text and counted", async () => {
		const remote = "https://example.com/diagram.png";
		const result = await ingestPage(
			input({ title: `Guide ![diagram](${remote})`, content: "# Ignored\n\nHello.\n" }),
			{ registry: REGISTRY, client: fake, stateDir },
		);
		expect(result.status).toBe("uploaded");
		if (result.status !== "uploaded") throw new Error("unreachable");
		expect(result.imagesStripped).toBe(1);
		expect(result.title).toBe("Guide [image: diagram]");
		const stored = [...fake.datasets.get("ds-test")!.docs.values()];
		const blob = JSON.stringify(stored);
		expect(blob).not.toContain(remote);
		expect(blob).toContain("[image: diagram]");
	});

	test("stored source URLs are canonical", async () => {
		const mixed = `https://GitHub.com/ExampleOrg/test-docs/blob/${COMMIT_A}/docs/guide.md`;
		const result = await ingestPage(input({ sourceUrl: mixed, content: "# Guide\n\nHello.\n" }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(result.status).toBe("uploaded");
		if (result.status !== "uploaded") throw new Error("unreachable");
		const docs = await fake.listDocuments("ds-test");
		expect(docs[0]!.metaFields.source_url).toBe(url(COMMIT_A, "docs/guide.md"));
	});

	test("decoded spaces re-encode in stored source URLs", async () => {
		const encoded = `https://github.com/ExampleOrg/test-docs/blob/${COMMIT_A}/docs/my%20file.md`;
		const result = await ingestPage(input({ sourceUrl: encoded, content: "# Guide\n\nHello.\n" }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(result.status).toBe("uploaded");
		if (result.status !== "uploaded") throw new Error("unreachable");
		expect(result.path).toBe("docs/my file.md");
		const docs = await fake.listDocuments("ds-test");
		expect(docs[0]!.metaFields.source_url).toBe(encoded);
		expect(docs[0]!.metaFields.path).toBe("docs/my file.md");
	});

	test("an H1-derived title at exactly the cap uploads", async () => {
		const result = await ingestPage(input({ content: `# ${"t".repeat(200)}\n\nBody.\n` }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(result.status).toBe("uploaded");
		if (result.status !== "uploaded") throw new Error("unreachable");
		expect([...result.title].length).toBe(200);
	});

	test("a title-only edit re-uploads; the same title short-circuits", async () => {
		const first = await ingestPage(input(), { registry: REGISTRY, client: fake, stateDir });
		expect(first.status).toBe("uploaded");
		const renamed = await ingestPage(input({ title: "New Title" }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(renamed.status).toBe("uploaded");
		if (renamed.status !== "uploaded") throw new Error("unreachable");
		expect(renamed.title).toBe("New Title");
		const same = await ingestPage(input({ title: "New Title" }), {
			registry: REGISTRY,
			client: fake,
			stateDir,
		});
		expect(same.status).toBe("unchanged");
		if (same.status !== "unchanged") throw new Error("unreachable");
		expect(same.documentIds).toEqual(renamed.documentIds);
	});

	test("failed and missing prior parses re-upload instead of short-circuiting", async () => {
		const first = await ingestPage(input(), { registry: REGISTRY, client: fake, stateDir });
		expect(first.status).toBe("uploaded");
		if (first.status !== "uploaded") throw new Error("unreachable");
		const stored = fake.datasets.get("ds-test")!;
		for (const id of first.documentIds) stored.docs.get(id)!.run = "FAIL";
		const retried = await ingestPage(input(), { registry: REGISTRY, client: fake, stateDir });
		expect(retried.status).toBe("uploaded");
		if (retried.status !== "uploaded") throw new Error("unreachable");
		expect(retried.documentIds).not.toEqual(first.documentIds);
		expect(fake.calls.uploadDocuments).toBe(2);
		expect(fake.calls.parseDocuments).toBe(2);
		// Documents deleted out of band re-upload too.
		for (const id of retried.documentIds) stored.docs.delete(id);
		const replaced = await ingestPage(input(), { registry: REGISTRY, client: fake, stateDir });
		expect(replaced.status).toBe("uploaded");
		expect(fake.calls.uploadDocuments).toBe(3);
	});
	test("a cached id rejected by RAGFlow is dropped and resolved again via ensureDataset", async () => {
		clearDatasetCache();
		const registry: DatasetEntry[] = [
			{
				name: "cache-docs",
				slug: "ExampleOrg/test-docs",
				include: ["docs/**/*.md"],
				exclude: [],
				trigger: "merge-to-main",
			},
		];
		// Strict like production: unknown ids are rejected instead of created.
		class StrictRagflow extends FakeRagflow {
			override async uploadDocuments(datasetId: string, files: UploadFile[]): Promise<UploadedDocument[]> {
				if (!this.datasets.has(datasetId)) throw new RagflowError("ragflow 404: no such dataset");
				return super.uploadDocuments(datasetId, files);
			}
			override async listDocuments(datasetId: string, page = 1, pageSize = 100): Promise<RagflowDocument[]> {
				if (!this.datasets.has(datasetId)) throw new RagflowError("ragflow 404: no such dataset");
				return super.listDocuments(datasetId, page, pageSize);
			}
		}
		const strict = new StrictRagflow();
		strict.datasets.set("ds-stale", { id: "ds-stale", name: "cache-docs", docs: new Map() });
		const page = (content: string) => ({
			dataset: "cache-docs",
			sourceUrl: url(COMMIT_A, "docs/guide.md"),
			commit: COMMIT_A,
			content,
			surface: "substrate",
			isSubstrateOrOperator: true,
		});
		const first = await ingestPage(page("# Guide\n\nHello.\n"), { registry, client: strict, stateDir });
		expect(first.status).toBe("uploaded");
		// Deleted out of band: RAGFlow rejects the cached id from here on.
		strict.datasets.delete("ds-stale");
		const second = await ingestPage(page("# Guide\n\nHello again.\n"), { registry, client: strict, stateDir });
		expect(second.status).toBe("uploaded");
		if (second.status !== "uploaded") throw new Error("unreachable");
		expect(second.datasetId).not.toBe("ds-stale");
		expect(strict.calls.ensureDataset).toBeGreaterThan(0);
	});

	test("the real client satisfies the DocsRagflow seam", () => {
		const wired: DocsRagflow = new RagflowClient({
			url: "http://localhost:9",
			apiKey: "test-key",
			timeoutMs: 1000,
			problem: null,
		});
		expect(wired).toBeDefined();
	});
});
