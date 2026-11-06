/**
 * A LightRAG result that came from a corpus document cites that document's repository and path; every other result is
 * untouched. The corpus dataset is searched by default and has its own row in the dataset table.
 */
import { describe, expect, test } from "bun:test";
import { corpusDocumentName } from "@substrate/corpus";
import { DATASET_TRIGGERS } from "../docs-datasets.ts";
import { DEFAULT_SEARCH_DATASET_NAMES, searchDocs, type ManifestCommitRecord } from "../docs-search.ts";
import { defined } from "../test-support.ts";
import { sha256Hex } from "./testkit.ts";

const NO_GRAPH = { mode: "hybrid" as const, counts: { entities: 0, relations: 0 }, provenance: { entities: [], relations: 0 } };
const SHA = sha256Hex("body");
const NAME = corpusDocumentName("swcstudiospace/agent-substrate", "docs/data planes.md", SHA);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
/** The manifest's row for the document `NAME` names: active, at `COMMIT`, holding the content `NAME` carries. */
const RECORD: ManifestCommitRecord = { commit: COMMIT, sha256: SHA, state: "active" };
const HEAD_URL = "https://github.com/swcstudiospace/agent-substrate/blob/HEAD/docs/data%20planes.md";

async function search(
	chunks: Array<{ content: string; document_name: string; source_url?: string; heading_path?: string; score: number }>,
	manifestCommit?: (repo: string, path: string) => Promise<ManifestCommitRecord | null>,
) {
	return searchDocs(
		{
			config: null,
			backend: "lightrag",
			lightragConfig: { url: "http://lightrag.test" },
			datasetNames: ["agent-substrate", "corpus"],
			lightragRetrieve: async () => ({ ok: true, chunks, detail: NO_GRAPH }),
			emit: async () => ({ stored: false }),
			surface: "omp",
			...(manifestCommit === undefined ? {} : { manifestCommit }),
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

	test("a corpus document whose manifest row records a commit cites that commit, not HEAD", async () => {
		const lookups: string[] = [];
		const reply = await search([{ content: "The planes are described here.", document_name: NAME, source_url: NAME, score: 0.9 }], async (repo, path) => {
			lookups.push(`${repo}:${path}`);
			return RECORD;
		});
		expect(defined(reply.chunks[0], "the citation")).toMatchObject({
			title: "swcstudiospace/agent-substrate:docs/data planes.md",
			source_url: `https://github.com/swcstudiospace/agent-substrate/blob/${COMMIT}/docs/data%20planes.md`,
			dataset: "corpus",
			commit: COMMIT,
		});
		expect(lookups).toEqual(["swcstudiospace/agent-substrate:docs/data planes.md"]);
	});

	test("a chunk indexed from an older version is cited at HEAD, not at the newer commit", async () => {
		const older = corpusDocumentName("swcstudiospace/agent-substrate", "docs/data planes.md", sha256Hex("older body"));
		const reply = await search([{ content: "The planes were described here.", document_name: older, source_url: older, score: 0.9 }], async () => RECORD);
		expect(defined(reply.chunks[0], "the citation")).toMatchObject({ source_url: HEAD_URL, commit: "dataset-pin:corpus:unrecorded", dataset: "corpus" });
	});

	test("a tombstoned document is cited at HEAD, not at its commit", async () => {
		const reply = await search([{ content: "The planes are described here.", document_name: NAME, source_url: NAME, score: 0.9 }], async (): Promise<ManifestCommitRecord> => ({ ...RECORD, state: "tombstoned" }));
		expect(defined(reply.chunks[0], "the citation")).toMatchObject({ source_url: HEAD_URL, commit: "dataset-pin:corpus:unrecorded", dataset: "corpus" });
	});

	test("a corpus document whose manifest row records no commit cites HEAD", async () => {
		const reply = await search([{ content: "The planes are described here.", document_name: NAME, source_url: NAME, score: 0.9 }], async () => null);
		expect(defined(reply.chunks[0], "the citation").source_url).toBe(HEAD_URL);
	});

	test("a recorded value that is not a full 40-character commit name cites HEAD", async () => {
		for (const recorded of ["0123456", "g".repeat(40), `${COMMIT}0`]) {
			const reply = await search([{ content: "The planes are described here.", document_name: NAME, source_url: NAME, score: 0.9 }], async () => ({ ...RECORD, commit: recorded }));
			expect(defined(reply.chunks[0], "the citation").source_url).toBe(HEAD_URL);
		}
	});

	test("a manifest lookup that throws or rejects still answers the search, with the document cited at HEAD", async () => {
		const throwing = (): Promise<ManifestCommitRecord | null> => {
			throw new Error("manifest unreachable");
		};
		for (const lookup of [throwing, () => Promise.reject(new Error("manifest unreachable"))]) {
			const reply = await search([{ content: "The planes are described here.", document_name: NAME, source_url: NAME, heading_path: "Intro > Planes", score: 0.9 }], lookup);
			expect(reply.degraded).toBeUndefined();
			expect(reply.chunks).toHaveLength(1);
			expect(defined(reply.chunks[0], "the citation")).toMatchObject({ source_url: HEAD_URL, dataset: "corpus", heading_path: "Intro > Planes", snippet: "The planes are described here." });
		}
	});

	test("the same path in another repository is not cited at this repository's commit", async () => {
		const other = corpusDocumentName("someone-else/agent-substrate", "docs/data planes.md", sha256Hex("body"));
		const reply = await search(
			[
				{ content: "Ours.", document_name: NAME, source_url: NAME, score: 0.9 },
				{ content: "Theirs.", document_name: other, source_url: other, score: 0.8 },
			],
			async (repo) => (repo === "swcstudiospace/agent-substrate" ? RECORD : null),
		);
		expect(reply.chunks).toMatchObject([
			{ title: "swcstudiospace/agent-substrate:docs/data planes.md", source_url: `https://github.com/swcstudiospace/agent-substrate/blob/${COMMIT}/docs/data%20planes.md` },
			{ title: "someone-else/agent-substrate:docs/data planes.md", source_url: "https://github.com/someone-else/agent-substrate/blob/HEAD/docs/data%20planes.md" },
		]);
	});

	test("a document with several chunks is looked up once per reply", async () => {
		const lookups: string[] = [];
		const other = corpusDocumentName("swcstudiospace/agent-substrate", "docs/other.md", sha256Hex("other"));
		const reply = await search(
			[
				{ content: "First.", document_name: NAME, source_url: NAME, score: 0.9 },
				{ content: "Second.", document_name: NAME, source_url: NAME, score: 0.8 },
				{ content: "Other.", document_name: other, source_url: other, score: 0.7 },
			],
			async (repo, path) => {
				lookups.push(`${repo}:${path}`);
				return RECORD;
			},
		);
		expect(reply.chunks).toHaveLength(3);
		expect(lookups.sort()).toEqual(["swcstudiospace/agent-substrate:docs/data planes.md", "swcstudiospace/agent-substrate:docs/other.md"]);
	});

	test("a manifest lookup that never answers is abandoned at its deadline, and the document is cited at HEAD", async () => {
		const started = performance.now();
		const reply = await search([{ content: "The planes are described here.", document_name: NAME, source_url: NAME, score: 0.9 }], () => new Promise<ManifestCommitRecord | null>(() => undefined));
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(reply.degraded).toBeUndefined();
		expect(defined(reply.chunks[0], "the citation")).toMatchObject({ source_url: HEAD_URL, commit: "dataset-pin:corpus:unrecorded", dataset: "corpus" });
	});
});

describe("the corpus dataset", () => {
	test("is searched by default and has a trigger row", () => {
		expect(DEFAULT_SEARCH_DATASET_NAMES).toContain("corpus");
		expect(Object.hasOwn(DATASET_TRIGGERS, "corpus")).toBe(true);
	});
});
