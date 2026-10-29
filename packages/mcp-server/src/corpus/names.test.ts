import { describe, expect, test } from "bun:test";
import { sourceUrl } from "@substrate/corpus";
import { corpusDocumentName, isSafeCorpusName, parseCorpusDocumentName, planeDocumentIdForName } from "./names.ts";
import { sha256Hex } from "./testkit.ts";

const SHA = sha256Hex("body");

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

	test("the plane document id is doc- plus the MD5 of the name", () => {
		expect(planeDocumentIdForName("abc")).toBe("doc-900150983cd24fb0d6963f7d28e17f72");
	});
});
