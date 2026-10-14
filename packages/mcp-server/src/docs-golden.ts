/**
 * The offline docs-golden harness (uplift-3 N5): the real `searchDocs` over
 * a question-aware `RagflowFake` seeded from a small Markdown corpus.
 *
 * `scripts/docs-golden.ts` holds the fixtures, the scorer and the CLI; this
 * module holds the part that must live inside `mcp-server` — the store lock
 * (`store-lock.test.ts`) lets no file outside this package import the
 * RAGFlow client or its fake, and the rehearsal fixtures (`rehearsal-skills.ts`)
 * already follow the same split.
 *
 * What the offline run proves, and what it cannot: the fake retrieves by
 * lexical overlap between the question and each paragraph, so a passing
 * fixture proves the **pipeline** — scope isolation (only the fixture's
 * datasets are retrieved), citation provenance (source URL and commit from
 * the ingest record), ordering and the cap, redaction of a planted
 * placeholder, and the scorer itself — never the deployment's relevance.
 * Relevance is what `--live` is for.
 *
 * The corpus is `fixtures/docs-golden/corpus/<dataset>/<slug>.md`; a
 * document's source URL is `https://example.com/<dataset>/<slug>` and its
 * document id `golden-<dataset>-<slug>`, so a fixture can name both without
 * a manifest. Every document is "recorded" with one commit, the one the
 * caller passes, so `dataset_commit` and the per-document commit are both
 * exercised exactly as the service exercises them.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { searchDocs, type SearchReply } from "./docs-search.ts";
import { RagflowFake, type FakeChunk } from "./ragflow-fake.ts";
import type { EventInput } from "./types.ts";

/** The reserved host every corpus document is cited under (RFC 2606), as the fake's own seeds are. */
export const GOLDEN_SOURCE_HOST = "https://example.com";

export interface GoldenDocument {
	dataset: string;
	slug: string;
	source_url: string;
	document_id: string;
	/** The file name, which is what RAGFlow reports as `document_keyword`. */
	name: string;
	body: string;
}

export interface GoldenCorpus {
	documents: GoldenDocument[];
}

/** Every `<dataset>/<slug>.md` under `dir`, in sorted order. Datasets without a directory simply have no documents. */
export function loadGoldenCorpus(dir: string): GoldenCorpus {
	const documents: GoldenDocument[] = [];
	for (const dataset of readdirSync(dir).sort()) {
		const datasetDir = join(dir, dataset);
		if (!statSync(datasetDir).isDirectory()) continue;
		for (const file of readdirSync(datasetDir).sort()) {
			if (!file.endsWith(".md")) continue;
			const slug = file.slice(0, -".md".length);
			documents.push({
				dataset,
				slug,
				source_url: `${GOLDEN_SOURCE_HOST}/${dataset}/${slug}`,
				document_id: `golden-${dataset}-${slug}`,
				name: file,
				body: readFileSync(join(datasetDir, file), "utf8"),
			});
		}
	}
	return { documents };
}

/** Words that carry no signal for the toy retriever. */
const STOPWORDS: Record<string, true> = {
	the: true,
	and: true,
	for: true,
	are: true,
	was: true,
	what: true,
	which: true,
	who: true,
	where: true,
	when: true,
	how: true,
	does: true,
	that: true,
	this: true,
	with: true,
	from: true,
	into: true,
	its: true,
	one: true,
	every: true,
	through: true,
	under: true,
	while: true,
	never: true,
	only: true,
	any: true,
	all: true,
};

/** The lower-cased words of three letters or more that are not stopwords. */
export function terms(text: string): Set<string> {
	const out = new Set<string>();
	for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
		if (word.length >= 3 && STOPWORDS[word] !== true) out.add(word);
	}
	return out;
}

/**
 * One document's best paragraph for a question, scored as the share of the
 * question's terms the paragraph contains, with the nearest preceding
 * heading as the chunk's heading path. `null` when no paragraph shares a
 * term: the document is not retrieved at all, which is what lets an
 * unanswerable fixture come back empty.
 */
export function lexicalChunk(document: GoldenDocument, question: string): FakeChunk | null {
	const wanted = terms(question);
	if (wanted.size === 0) return null;
	let heading = "";
	let best: { score: number; paragraph: string; heading: string } | null = null;
	for (const paragraph of document.body.split(/\n\s*\n/)) {
		const text = paragraph.trim();
		if (text.length === 0) continue;
		if (text.startsWith("#")) {
			heading = text.replace(/^#+\s*/, "");
			continue;
		}
		let shared = 0;
		for (const term of terms(text)) if (wanted.has(term)) shared += 1;
		if (shared === 0) continue;
		const score = shared / wanted.size;
		if (best === null || score > best.score) best = { score, paragraph: text.replace(/\s+/g, " "), heading };
	}
	if (best === null) return null;
	return {
		content: best.paragraph,
		document_name: document.name,
		document_id: document.document_id,
		chunk_id: `chunk-${document.document_id}`,
		heading_path: best.heading,
		source_url: document.source_url,
		score: Number(best.score.toFixed(4)),
	};
}

/**
 * A recording fake whose retrieval answers the question from the corpus:
 * for the dataset asked, every document with a matching paragraph, best
 * first. The fake's own three datasets are the scope; a corpus directory
 * named after one of them fills it.
 */
export function goldenFake(corpus: GoldenCorpus): RagflowFake {
	const fake = new RagflowFake();
	fake.answer = (datasetId, question) => {
		const dataset = fake.datasets.find((entry) => entry.id === datasetId);
		if (dataset === undefined) return [];
		const chunks: FakeChunk[] = [];
		for (const document of corpus.documents) {
			if (document.dataset !== dataset.name) continue;
			const chunk = lexicalChunk(document, question);
			if (chunk !== null) chunks.push(chunk);
		}
		return chunks.sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
	};
	return fake;
}

export interface GoldenSearchOptions {
	/** The commit every corpus document is recorded under, and every dataset pinned at. */
	commit: string;
	/** The shared retrieval budget; the service default when omitted. */
	budgetMs?: number;
}

export interface GoldenSearchResult {
	reply: SearchReply;
	/** The dataset ids the search actually retrieved — the scope-isolation proof. */
	retrievedDatasetIds: string[];
	events: EventInput[];
}

/**
 * Run one fixture's question through the real `searchDocs` against the
 * corpus-backed fake, with every corpus document recorded (source URL and
 * commit) and every dataset pinned, exactly as the service would wire a
 * deployment that ingested this corpus at `commit`.
 */
export async function searchGoldenOffline(
	corpus: GoldenCorpus,
	fixture: { question: string; datasets: readonly string[] },
	options: GoldenSearchOptions,
): Promise<GoldenSearchResult> {
	const fake = goldenFake(corpus);
	const events: EventInput[] = [];
	const provenance: Record<string, { source_url: string; commit: string }> = {};
	for (const document of corpus.documents) provenance[document.document_id] = { source_url: document.source_url, commit: options.commit };
	const pins = Object.fromEntries(
		fake.datasets.map((dataset) => [dataset.id, { dataset: dataset.name, dataset_id: dataset.id, version: "golden", commit: options.commit }]),
	);
	const reply = await searchDocs(
		{
			config: { url: "http://ragflow.test", apiKey: "golden" },
			datasetNames: fixture.datasets,
			pins,
			emit: async (event) => {
				events.push(event);
				return { stored: false };
			},
			surface: "omp",
			fetchImpl: fake.fetch,
			provenanceOf: (documentId) => provenance[documentId],
			...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
		},
		fixture.question,
	);
	const retrievedDatasetIds: string[] = [];
	for (const body of fake.retrievals()) {
		if (body !== null && typeof body === "object" && "dataset_ids" in body && Array.isArray(body.dataset_ids)) {
			for (const id of body.dataset_ids) if (typeof id === "string") retrievedDatasetIds.push(id);
		}
	}
	return { reply, retrievedDatasetIds, events };
}
