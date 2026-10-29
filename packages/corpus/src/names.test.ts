import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { sourceUrl } from "./protocol.ts";
import {
	MAX_DOCUMENT_BYTES,
	MAX_PATH_LENGTH,
	MAX_REPO_LENGTH,
	corpusDocumentName,
	documentRefusal,
	isSafeCorpusName,
	isValidPath,
	isValidRepo,
	localRepoId,
	parseCorpusDocumentName,
	stripRemoteImages,
} from "./names.ts";

const SHA = createHash("sha256").update("body").digest("hex");

describe("repo and path guards", () => {
	test("owner/name and local/<directory> are repos; everything else is not", () => {
		for (const repo of ["swcstudiospace/agent-substrate", "a/b", "local/my notes", "local/dir.with.dots"]) expect({ repo, valid: isValidRepo(repo) }).toEqual({ repo, valid: true });
		for (const repo of ["", "single", "a/b/c", "local/", "local/a/b", "local/a:b", "local/..", "https://github.com/a/b", "owner/na me", `a/${"x".repeat(250)}`]) {
			expect({ repo, valid: isValidRepo(repo) }).toEqual({ repo, valid: false });
		}
	});

	test("a path is accepted only in normal form", () => {
		for (const path of ["README.md", "docs/a.md", ".planning/phases/63-x/63-CONTEXT.md", "docs/a:b@c.md"]) expect({ path, valid: isValidPath(path) }).toEqual({ path, valid: true });
		const bad = ["", "/abs.md", "docs/../x.md", "../x.md", "docs//x.md", "./x.md", "docs/./x.md", "docs\\x.md", "docs/\u0000x.md", "docs/a\nb.md", "docs/", "x".repeat(MAX_PATH_LENGTH + 1)];
		for (const path of bad) expect({ path: path.slice(0, 20), valid: isValidPath(path) }).toEqual({ path: path.slice(0, 20), valid: false });
		expect(isValidPath("x".repeat(MAX_PATH_LENGTH))).toBe(true);
	});
});

describe("localRepoId", () => {
	test("a directory name that already satisfies the repo rule keeps its label, so recorded rows keep their identity", () => {
		for (const name of ["notes", "my notes", "dir.with.dots", "ünïcode", "a".repeat(100), "-lead", ".hidden"]) {
			expect({ name, label: localRepoId(name) }).toEqual({ name, label: `local/${name}` });
		}
	});

	test("every other name becomes a valid label: colons, slashes, control characters, dots, a very long name", () => {
		const names = ["backup:2026", "a/b", "tab\tname", "..", ".", "a".repeat(300), "é".repeat(250), "a\\b", "x:".repeat(200)];
		for (const name of names) {
			const label = localRepoId(name);
			expect({ name: name.slice(0, 20), valid: isValidRepo(label), shorter: label.length <= MAX_REPO_LENGTH }).toEqual({ name: name.slice(0, 20), valid: true, shorter: true });
			expect(label).not.toBe(`local/${name}`);
		}
	});

	test("the slug is the name with unsafe characters replaced by a dash and leading dots and dashes removed, then the name's hash", () => {
		const hash = (name: string) => createHash("sha256").update(name, "utf8").digest("hex").slice(0, 8);
		expect(localRepoId("backup:2026")).toBe(`local/backup-2026-${hash("backup:2026")}`);
		expect(localRepoId("my notes:old")).toBe(`local/my-notes-old-${hash("my notes:old")}`);
		expect(localRepoId("a/b")).toBe(`local/a-b-${hash("a/b")}`);
		// Nothing is left of these after the trim, so the slug falls back to a fixed word.
		expect(localRepoId("..")).toBe(`local/collection-${hash("..")}`);
		expect(localRepoId(":")).toBe(`local/collection-${hash(":")}`);
	});

	test("two different names that slug to the same text get different labels", () => {
		const labels = new Set(["a:b", "a/b", "a\u0001b", "a\\b"].map(localRepoId));
		expect(labels.size).toBe(4);
		expect(localRepoId("a:b")).not.toBe(localRepoId("a/b"));
	});

	test("a 300-character name is cut so the whole label is exactly the length limit and the hash survives", () => {
		const name = `${"a".repeat(299)}:`;
		const label = localRepoId(name);
		expect(label).toHaveLength(MAX_REPO_LENGTH);
		expect(label.endsWith(`-${createHash("sha256").update(name, "utf8").digest("hex").slice(0, 8)}`)).toBe(true);
		expect(isValidRepo(label)).toBe(true);
	});

	test("the same name always gives the same label", () => {
		expect(localRepoId("backup:2026")).toBe(localRepoId("backup:2026"));
	});
});

describe("corpus document names", () => {
	test("a name carries the repo, the path and the first 12 hex of the sha, and parses back to them", () => {
		const name = corpusDocumentName("swcstudiospace/agent-substrate", "docs/data-planes.md", SHA);
		expect(name).toBe(`corpus:swcstudiospace%2Fagent-substrate:docs%2Fdata-planes.md@${SHA.slice(0, 12)}`);
		expect(parseCorpusDocumentName(name)).toEqual({ repo: "swcstudiospace/agent-substrate", path: "docs/data-planes.md", sha12: SHA.slice(0, 12) });
	});

	test("the encoding is reversible for a path holding a percent sign, a colon and an at sign", () => {
		for (const path of ["docs/100%/a.md", "docs/a%2Fb.md", "notes/12:30@home.md", "%25.md"]) {
			const name = corpusDocumentName("local/my notes", path, SHA);
			expect({ path, parsed: parseCorpusDocumentName(name)?.path }).toEqual({ path, parsed: path });
		}
	});

	test("a name the plane accepts has no slash left in it, which is the reason for the encoding", () => {
		const name = corpusDocumentName("a/b", "deep/er/path.md", SHA);
		expect(name.includes("/")).toBe(false);
		expect(isSafeCorpusName(name)).toBe(true);
	});

	test("a path the plane would alter is unsafe, not rewritten: an edge space, and a parser hint at the end", () => {
		expect(isSafeCorpusName(corpusDocumentName("a/b", "docs/ a.md", SHA))).toBe(true);
		expect(isSafeCorpusName(corpusDocumentName("a/b", "docs/a.md ", SHA))).toBe(true);
		expect(isSafeCorpusName(` ${corpusDocumentName("a/b", "a.md", SHA)}`)).toBe(false);
		expect(isSafeCorpusName(corpusDocumentName("a/b", "x.[docling].md", SHA.replace(/./g, "a")))).toBe(false);
	});

	test("what is not a corpus name does not parse", () => {
		for (const name of ["docs/readme.md", "corpus:", "corpus:a%2Fb", "corpus:a%2Fb:path", "corpus:a%2Fb:path@xyz", "corpus:nonsense:path@aaaaaaaaaaaa", `corpus:a%2Fb:@${SHA.slice(0, 12)}`]) {
			expect({ name, parsed: parseCorpusDocumentName(name) }).toEqual({ name, parsed: null });
		}
	});

	test("a citation built from a parsed name points at the same URL the corpus protocol builds for the document", () => {
		const parsed = parseCorpusDocumentName(corpusDocumentName("swcstudiospace/agent-substrate", "docs/a b.md", SHA));
		expect(parsed && sourceUrl(parsed.repo, parsed.path)).toBe("https://github.com/swcstudiospace/agent-substrate/blob/HEAD/docs/a%20b.md");
	});
});

describe("stripRemoteImages", () => {
	test("counts tags and markdown images, keeps local paths", () => {
		const stripped = stripRemoteImages('A <img src="http://x/y.png"> B ![c](https://x/z.png) D ![e](./f.png)');
		expect(stripped.stripped).toBe(2);
		expect(stripped.body).toContain("./f.png");
	});
});

describe("documentRefusal", () => {
	const ok = { repo: "Acme/Alpha", path: "docs/a.md", sha256: SHA, body: "# a\n" };

	test("a well-formed document passes", () => {
		expect(documentRefusal(ok)).toBeNull();
	});

	test("the first rule broken names the reason: repo, path, size, plane name, empty text", () => {
		expect(documentRefusal({ ...ok, repo: "no-slash" })).toBe("bad-repo");
		expect(documentRefusal({ ...ok, path: "docs\\a.md" })).toBe("bad-path");
		expect(documentRefusal({ ...ok, body: "x".repeat(MAX_DOCUMENT_BYTES + 1) })).toBe("too-large");
		expect(documentRefusal({ ...ok, path: "docs/x.[docling].md" })).toBe("unsafe-name");
		expect(documentRefusal({ ...ok, body: "  \n" })).toBe("empty-document");
	});

	test("the size cap is in bytes, not characters, and is exact", () => {
		expect(documentRefusal({ ...ok, body: "x".repeat(MAX_DOCUMENT_BYTES) })).toBeNull();
		expect(documentRefusal({ ...ok, body: "é".repeat(MAX_DOCUMENT_BYTES / 2 + 1) })).toBe("too-large");
	});

	test("a body that is only remote images is empty once they are stripped", () => {
		expect(documentRefusal({ ...ok, body: "![logo](https://example.com/x.png)\n" })).toBe("empty-document");
		expect(documentRefusal({ ...ok, body: "![logo](./x.png)\n" })).toBeNull();
	});
});
