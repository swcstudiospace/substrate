/**
 * The offline docs-golden harness (uplift-3 N5): the real `searchDocs` over
 * a question-aware `lightragFake` seeded from a small Markdown corpus.
 *
 * `scripts/docs-golden.ts` holds the fixtures, the scorer and the CLI; this
 * module holds the part that must live inside `mcp-server` — the store lock
 * (`store-lock.test.ts`) lets no file outside this package import the
 * lightrag client or its fake, and the rehearsal fixtures (`rehearsal-skills.ts`)
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
import { datasetIdentity } from "./dataset-identity.ts";
import { searchDocs, type SearchReply } from "./docs-search.ts";
import { DocsPlaneFake, type FakeChunk } from "./docs-plane-fake.ts";
import type { IngestRecord } from "./docs-ingest.ts";
import type { EventInput } from "./types.ts";

/** The reserved host every corpus document is cited under (RFC 2606), as the fake's own seeds are. */
export const GOLDEN_SOURCE_HOST = "https://example.com";

export interface GoldenDocument {
	dataset: string;
	slug: string;
	source_url: string;
	document_id: string;
	/** The file name, which is what lightrag reports as `document_keyword`. */
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
export function goldenFake(corpus: GoldenCorpus): DocsPlaneFake {
	const fake = new DocsPlaneFake();
	fake.echoHeadings = true;
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
	// The fake's own three datasets are the scope (see `goldenFake`); listing
	// them keeps the wire ids the fake ids scope isolation is proven over.
	// Pins are filed under the dataset name, the key the search cites.
	const pins = Object.fromEntries(
		fake.datasets.map((dataset) => [dataset.name, { dataset: dataset.name, dataset_id: dataset.id, version: "golden", commit: options.commit }]),
	);
	// LightRAG attributes a chunk to the dataset its ingest record names:
	// `lightrag::<dataset identity>::<source URL>` (`lightragDocumentDataset`).
	const lightragRecords = new Map<string, IngestRecord>();
	for (const document of corpus.documents) {
		const identity = datasetIdentity(document.dataset);
		lightragRecords.set(`lightrag::${identity}::${document.source_url}`, {
			sha: "golden",
			dataset_id: identity,
			source_url: document.source_url,
			document_id: document.document_id,
			version: 1,
		});
	}
	const retrievedDatasetIds: string[] = [];
	const reply = await searchDocs(
		{
			config: { url: "http://lightrag.test", apiKey: "golden" },
			backend: "lightrag",
			lightragConfig: { url: "http://lightrag.test", apiKey: "golden" },
			lightragDatasets: {
				list: async () => ({ ok: true, datasets: fake.datasets.map((dataset) => ({ id: dataset.id, name: dataset.name })) }),
				invalidate: () => undefined,
			},
			lightragRetrieve: async (_config, question, datasetIds) => {
				retrievedDatasetIds.push(...datasetIds);
				const chunks: FakeChunk[] = [];
				for (const id of datasetIds) chunks.push(...(await (fake.answer?.(id, question) ?? [])));
				chunks.sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
				return {
					ok: true,
					chunks,
					detail: { mode: "hybrid", counts: { entities: 0, relations: 0 }, provenance: { entities: [], relations: 0 } },
				};
			},
			lightragRecords,
			datasetNames: fixture.datasets,
			pins,
			emit: async (event) => {
				events.push(event);
				return { stored: false };
			},
			surface: "omp",
			provenanceOf: (documentId) => provenance[documentId],
			...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
		},
		fixture.question,
	);
	return { reply, retrievedDatasetIds, events };
}
