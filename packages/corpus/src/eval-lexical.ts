/**
 * The offline retriever the CI harness measures (v1.7 phase 70).
 *
 * CI cannot reach a live docs plane, so a deterministic lexical retriever over a fixture corpus stands in. It does not say how
 * good embeddings are; it guards the pipeline logic around them: the inputs that reach ranking (tokenising, the title weight),
 * the collapse of exact duplicates to one result, and the re-rank step. A change that breaks any of the three moves the metrics
 * `scripts/docs-eval.ts` compares with its baseline.
 *
 * No randomness, no clock, no network: the same documents and query always give the same hits in the same order.
 */
import { outlineOf, wordsOf } from "./eval.ts";

export interface LexicalDocument {
	/** The `repo:path` key. */
	key: string;
	text: string;
}

export interface LexicalHit {
	key: string;
	score: number;
}

/** A re-rank step: the collapsed, scored hits in, the order to answer in out. The authority scores plug in here. */
export type Rerank = (hits: readonly LexicalHit[]) => readonly LexicalHit[];

export interface LexicalSearchOptions {
	/** Applied after exact duplicates collapse and before the limit. */
	rerank?: Rerank | undefined;
	/** The most hits returned, default {@link LEXICAL_DEFAULT_LIMIT}. */
	limit?: number | undefined;
}

/** BM25 term-frequency saturation. */
export const BM25_K1 = 1.2;
/** BM25 length normalisation. */
export const BM25_B = 0.75;
/** The title's tokens are counted this many extra times, so a document titled for a query outranks one that merely mentions it. */
export const TITLE_EXTRA_WEIGHT = 2;
/** The default number of hits a search returns. */
export const LEXICAL_DEFAULT_LIMIT = 10;

/** Words that carry no topic. */
const STOP_WORDS: ReadonlySet<string> = new Set([
	"a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "in", "is", "it", "its", "of", "on", "or", "that", "the", "this", "to", "was", "were", "will", "with",
]);

/** Lower-cased alphanumeric words with the stop words removed. */
export function tokenize(text: string): string[] {
	return wordsOf(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")).filter((token) => !STOP_WORDS.has(token));
}

interface IndexedDocument {
	key: string;
	length: number;
	frequencies: Map<string, number>;
	/** Documents with the same group are byte-for-byte the same text. */
	group: string;
}

export interface LexicalIndex {
	readonly size: number;
	search(query: string, options?: LexicalSearchOptions): LexicalHit[];
}

/** Builds the index. Two documents with the same text are searched as one: the smaller key answers for both. */
export function createLexicalIndex(docs: readonly LexicalDocument[]): LexicalIndex {
	const indexed: IndexedDocument[] = [];
	const documentFrequency = new Map<string, number>();
	let totalLength = 0;
	for (const doc of docs) {
		const title = outlineOf(doc.text).title;
		const tokens = [...tokenize(doc.text), ...(title === null ? [] : Array.from({ length: TITLE_EXTRA_WEIGHT }, () => tokenize(title)).flat())];
		const frequencies = new Map<string, number>();
		for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
		for (const token of frequencies.keys()) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
		indexed.push({ key: doc.key, length: tokens.length, frequencies, group: doc.text });
		totalLength += tokens.length;
	}
	const averageLength = indexed.length === 0 ? 0 : totalLength / indexed.length;
	const groupOf = new Map(indexed.map((doc) => [doc.key, doc.group]));

	return {
		size: indexed.length,
		search(query, options = {}) {
			const limit = Math.max(0, Math.floor(options.limit ?? LEXICAL_DEFAULT_LIMIT));
			const terms = [...new Set(tokenize(query))];
			const scored: LexicalHit[] = [];
			for (const doc of indexed) {
				let score = 0;
				for (const term of terms) {
					const tf = doc.frequencies.get(term);
					if (tf === undefined) continue;
					const df = documentFrequency.get(term) ?? 0;
					const idf = Math.log(1 + (indexed.length - df + 0.5) / (df + 0.5));
					const norm = 1 - BM25_B + BM25_B * (averageLength === 0 ? 1 : doc.length / averageLength);
					score += (idf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * norm);
				}
				if (score > 0) scored.push({ key: doc.key, score });
			}
			scored.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

			// Exact duplicates collapse to the lexically smallest key, which holds the position of the group's best hit.
			const smallest = new Map<string, string>();
			for (const hit of scored) {
				const group = groupOf.get(hit.key) ?? hit.key;
				const current = smallest.get(group);
				if (current === undefined || hit.key < current) smallest.set(group, hit.key);
			}
			const seen = new Set<string>();
			const collapsed: LexicalHit[] = [];
			for (const hit of scored) {
				const group = groupOf.get(hit.key) ?? hit.key;
				if (seen.has(group)) continue;
				seen.add(group);
				collapsed.push({ key: smallest.get(group) ?? hit.key, score: hit.score });
			}
			const ordered = options.rerank === undefined ? collapsed : [...options.rerank(collapsed)];
			return ordered.slice(0, limit);
		},
	};
}
