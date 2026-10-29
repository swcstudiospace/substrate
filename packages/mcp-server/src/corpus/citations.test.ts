/**
 * A LightRAG result that came from a corpus document cites that document's repository and path; every other result is
 * untouched. The corpus dataset is searched by default and has its own row in the dataset table.
 */
import { describe, expect, test } from "bun:test";
import { DATASET_TRIGGERS } from "../docs-datasets.ts";
import { DEFAULT_SEARCH_DATASET_NAMES, searchDocs } from "../docs-search.ts";
import { defined } from "../test-support.ts";
import { corpusDocumentName } from "./names.ts";
import { sha256Hex } from "./testkit.ts";

const NO_GRAPH = { mode: "hybrid" as const, counts: { entities: 0, relations: 0 }, provenance: { entities: [], relations: 0 } };
const NAME = corpusDocumentName("swcstudiospace/agent-substrate", "docs/data planes.md", sha256Hex("body"));

async function search(chunks: Array<{ content: string; document_name: string; source_url?: string; heading_path?: string; score: number }>) {
	return searchDocs(
		{
			config: null,
			backend: "lightrag",
			lightragConfig: { url: "http://lightrag.test" },
			datasetNames: ["agent-substrate", "corpus"],
			lightragRetrieve: async () => ({ ok: true, chunks, detail: NO_GRAPH }),
			emit: async () => ({ stored: false }),
			surface: "omp",
		},
		"where are the data planes described?",
	);
}

describe("corpus citations", () => {
	test("a result whose file path is a corpus document name cites its repo and path, dataset corpus, and keeps LightRAG's heading", async () => {
		const reply = await search([{ content: "The planes are described here.", document_name: NAME, source_url: NAME, heading_path: "Intro > Planes", score: 0.9 }]);
		const citation = defined(reply.chunks[0], "the citation");
		expect(citation).toMatchObject({
			title: "swcstudiospace/agent-substrate:docs/data planes.md",
			source_url: "https://github.com/swcstudiospace/agent-substrate/blob/HEAD/docs/data%20planes.md",
			dataset: "corpus",
			heading_path: "Intro > Planes",
			snippet: "The planes are described here.",
		});
	});

	test("a corpus name given only as the document name is recognised, and a local repo gets a corpus:// URL", async () => {
		const local = corpusDocumentName("local/my notes", "notes/a.md", sha256Hex("x"));
		const reply = await search([{ content: "Local notes.", document_name: local, score: 0.5 }]);
		expect(reply.chunks[0]).toMatchObject({ source_url: "corpus://local/my notes/notes/a.md", dataset: "corpus" });
	});

	test("a result that is not a corpus document is cited exactly as before, with no dataset member", async () => {
		const reply = await search([{ content: "Plain page.", document_name: "plan.md", source_url: "https://example.com/plan", score: 0.4 }]);
		const citation = defined(reply.chunks[0], "the citation");
		expect(citation.source_url).toBe("https://example.com/plan");
		expect("dataset" in citation).toBe(false);
	});
});

describe("the corpus dataset", () => {
	test("is searched by default and has a trigger row", () => {
		expect(DEFAULT_SEARCH_DATASET_NAMES).toContain("corpus");
		expect(Object.hasOwn(DATASET_TRIGGERS, "corpus")).toBe(true);
	});
});
