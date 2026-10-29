/**
 * Self-supervised retrieval evaluation (v1.7 phase 70).
 *
 * `generateGolden` turns documents into search questions with no labels: a document's own title, its section headings and its
 * opening sentence are what someone who wants that document would type, and the document's key is the expected answer. The
 * set therefore grows with the corpus. `scoreRun` folds the ranked answers of any retriever (the offline lexical one in
 * `eval-lexical.ts`, or the live `docs_search` route) into recall at k, mean reciprocal rank and latency percentiles.
 *
 * Everything here is pure and deterministic: documents are visited in key order, and a cap is applied with a seeded
 * generator, so the same corpus and options give the same queries on every machine.
 */
import { documentKey } from "./protocol.ts";

/** A document as the generator reads it: where it lives and what it says. */
export interface EvalDocument {
	repo: string;
	path: string;
	text: string;
}

export type GoldenKind = "title" | "heading" | "lead";

export interface GoldenQuery {
	query: string;
	/** The `repo:path` key of the one document that should be found. */
	expected: string;
	kind: GoldenKind;
}

/** Queries one document yields at most. */
export const GOLDEN_QUERIES_PER_DOCUMENT = 3;
/** A query shorter than this many words is too vague to point at one document. */
export const GOLDEN_MIN_WORDS = 3;
/** The opening sentence is cut to this many words. */
export const GOLDEN_LEAD_WORDS = 12;
/** The default cap on queries in one set; a larger corpus is sampled with the seed. */
export const GOLDEN_DEFAULT_MAX_QUERIES = 2000;
/** The default seed of the sampling generator. */
export const GOLDEN_DEFAULT_SEED = 1;
/** The most characters of one document the generator reads. */
export const EVAL_MAX_TEXT_CHARS = 200_000;

export interface GenerateGoldenOptions {
	/** Queries per document, default {@link GOLDEN_QUERIES_PER_DOCUMENT}. */
	perDocument?: number | undefined;
	/** Cap on the whole set, default {@link GOLDEN_DEFAULT_MAX_QUERIES}. */
	maxQueries?: number | undefined;
	/** Seed of the selection used when a cap bites, default {@link GOLDEN_DEFAULT_SEED}. */
	seed?: number | undefined;
}

/** What a markdown document says about itself. */
export interface DocumentOutline {
	/** The first level-1 heading, or null. */
	title: string | null;
	/** Every level-2 heading in order. */
	headings: string[];
	/** The first sentence of the first paragraph, cut to {@link GOLDEN_LEAD_WORDS} words, or null. */
	lead: string | null;
}

/** Inline markdown reduced to the words a reader sees. */
export function plainText(markdown: string): string {
	return markdown
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/`+([^`]*)`+/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/[*_~]+/g, "")
		.replace(/\s+#+\s*$/, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Words of a plain string, split on whitespace. */
export function wordsOf(text: string): string[] {
	return text.split(/\s+/).filter((word) => word.length > 0);
}

const FENCE = /^\s{0,3}(```|~~~)/;
const BLOCK_START = /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||<|---+\s*$|\*\*\*+\s*$|\[[^\]]+\]:)/;

/** The lines of a document without its YAML front matter, as `[line, insideFence]` pairs. */
function bodyLines(text: string): Array<{ line: string; fenced: boolean }> {
	const lines = text.slice(0, EVAL_MAX_TEXT_CHARS).replace(/\r\n?/g, "\n").split("\n");
	let start = 0;
	if (lines[0]?.trim() === "---") {
		const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
		if (close > 0) start = close + 1;
	}
	const out: Array<{ line: string; fenced: boolean }> = [];
	let fence: string | null = null;
	for (const line of lines.slice(start)) {
		const marker = FENCE.exec(line)?.[1];
		if (marker !== undefined) {
			// A fence closes only on its own marker, so a ``` inside a ~~~ block stays text.
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
			out.push({ line, fenced: true });
			continue;
		}
		out.push({ line, fenced: fence !== null });
	}
	return out;
}

/** The first sentence of `paragraph`, cut to {@link GOLDEN_LEAD_WORDS} words, with the closing punctuation removed. */
function leadSentence(paragraph: string): string {
	const sentence = /^(.+?[.!?])(\s|$)/.exec(paragraph)?.[1] ?? paragraph;
	return wordsOf(sentence).slice(0, GOLDEN_LEAD_WORDS).join(" ").replace(/[.!?:;,]+$/, "");
}

/** The title, level-2 headings and opening sentence of a markdown document. Headings and paragraphs inside code fences are ignored. */
export function outlineOf(text: string): DocumentOutline {
	let title: string | null = null;
	const headings: string[] = [];
	// A holder, not a `let`: an assignment inside the closure would otherwise narrow the variable to `null` at the return below.
	const found: { lead: string | null } = { lead: null };
	let paragraph: string[] = [];
	const flush = (): void => {
		if (found.lead === null && paragraph.length > 0) found.lead = leadSentence(plainText(paragraph.join(" ")));
		paragraph = [];
	};
	for (const { line, fenced } of bodyLines(text)) {
		if (fenced) {
			flush();
			continue;
		}
		const heading = /^\s{0,3}(#{1,2})\s+(.+)$/.exec(line);
		if (heading !== null) {
			flush();
			const label = plainText(heading[2] ?? "");
			if (label.length === 0) continue;
			if (heading[1] === "#") title ??= label;
			else headings.push(label);
			continue;
		}
		if (line.trim() === "" || BLOCK_START.test(line)) {
			flush();
			continue;
		}
		paragraph.push(line.trim());
	}
	flush();
	return { title, headings, lead: found.lead !== null && found.lead.length > 0 ? found.lead : null };
}

/** Lower-cased words of a query, for comparing two phrasings. */
function normalised(text: string): string {
	return wordsOf(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")).join(" ");
}

/** A small deterministic generator (mulberry32); the same seed gives the same sequence on every runtime. */
export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** `count` indexes out of `0..length-1`, chosen with `random`, in ascending order. */
function sampleIndexes(length: number, count: number, random: () => number): number[] {
	const all = Array.from({ length }, (_, index) => index);
	for (let i = 0; i < Math.min(count, length); i++) {
		const j = i + Math.floor(random() * (length - i));
		const swap = all[i] ?? 0;
		all[i] = all[j] ?? 0;
		all[j] = swap;
	}
	return all.slice(0, Math.min(count, length)).sort((a, b) => a - b);
}

const KIND_RANK: Readonly<Record<GoldenKind, number>> = { title: 0, lead: 1, heading: 2 };

/**
 * The questions a corpus asks about itself. Per document, up to three: its level-1 title, each level-2 heading joined with
 * the title, and the first sentence of its first paragraph cut to twelve words. Over the per-document cap the title is kept
 * and the rest are chosen with the seed.
 *
 * A question is dropped, never guessed, when it cannot name one document: fewer than three words, a phrase that occurs in
 * more than one document's title, or the same phrase asked by two different documents (copies and archives of one page).
 */
export function generateGolden(docs: readonly EvalDocument[], options: GenerateGoldenOptions = {}): GoldenQuery[] {
	const perDocument = Math.max(1, Math.floor(options.perDocument ?? GOLDEN_QUERIES_PER_DOCUMENT));
	const maxQueries = Math.max(0, Math.floor(options.maxQueries ?? GOLDEN_DEFAULT_MAX_QUERIES));
	const random = seededRandom(options.seed ?? GOLDEN_DEFAULT_SEED);
	const ordered = docs
		.map((doc) => ({ key: documentKey(doc.repo, doc.path), outline: outlineOf(doc.text) }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const titles = ordered.map((doc) => normalised(doc.outline.title ?? ""));
	const inTitles = (query: string): number => {
		const needle = ` ${normalised(query)} `;
		return titles.reduce((count, title) => (` ${title} `.includes(needle) ? count + 1 : count), 0);
	};

	const candidates: GoldenQuery[] = [];
	for (const { key, outline } of ordered) {
		const own: GoldenQuery[] = [];
		const title = outline.title;
		if (title !== null) own.push({ query: title, expected: key, kind: "title" });
		for (const heading of outline.headings) own.push({ query: title === null ? heading : `${title} ${heading}`, expected: key, kind: "heading" });
		if (outline.lead !== null) own.push({ query: outline.lead, expected: key, kind: "lead" });
		// Title first, then the lead, then headings in document order: the order a reader meets them is the order kept.
		own.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
		const usable = own.filter((candidate) => wordsOf(candidate.query).length >= GOLDEN_MIN_WORDS && inTitles(candidate.query) <= 1);
		const kept =
			usable.length <= perDocument
				? usable
				: [...usable.slice(0, 1), ...sampleIndexes(usable.length - 1, perDocument - 1, random).map((index) => usable[index + 1] as GoldenQuery)];
		candidates.push(...kept);
	}

	// The same phrase from two documents points at neither.
	const owners = new Map<string, Set<string>>();
	for (const candidate of candidates) {
		const phrase = normalised(candidate.query);
		const set = owners.get(phrase) ?? new Set<string>();
		set.add(candidate.expected);
		owners.set(phrase, set);
	}
	const unambiguous = candidates.filter((candidate) => (owners.get(normalised(candidate.query))?.size ?? 0) === 1);
	if (unambiguous.length <= maxQueries) return unambiguous;
	return sampleIndexes(unambiguous.length, maxQueries, random).map((index) => unambiguous[index] as GoldenQuery);
}

/** One question's outcome: the keys a retriever returned best first, and how long it took. */
export interface QueryResult {
	query: string;
	expected: string;
	ranked: readonly string[];
	latencyMs: number;
}

/** The share of questions whose expected key is among the first `k` answers. 0 for no questions. */
export function recallAtK(results: readonly QueryResult[], k: number): number {
	if (results.length === 0) return 0;
	const hits = results.filter((result) => result.ranked.slice(0, Math.max(0, k)).includes(result.expected)).length;
	return hits / results.length;
}

/** Mean reciprocal rank: 1 for first place, 1/2 for second, and so on; 0 for a miss. 0 for no questions. */
export function mrr(results: readonly QueryResult[]): number {
	if (results.length === 0) return 0;
	let total = 0;
	for (const result of results) {
		const index = result.ranked.indexOf(result.expected);
		if (index >= 0) total += 1 / (index + 1);
	}
	return total / results.length;
}

/** The nearest-rank percentile (`p` in 0..100) of `latencies`. 0 for no samples; a non-finite sample is ignored. */
export function percentile(latencies: readonly number[], p: number): number {
	const sorted = latencies.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
	if (sorted.length === 0) return 0;
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length)));
	return sorted[rank - 1] ?? 0;
}

export interface RunScore {
	queries: number;
	recall1: number;
	recall5: number;
	recall10: number;
	mrr: number;
	p50Ms: number;
	p95Ms: number;
}

/** Every metric of one run. */
export function scoreRun(results: readonly QueryResult[]): RunScore {
	const latencies = results.map((result) => result.latencyMs);
	return {
		queries: results.length,
		recall1: recallAtK(results, 1),
		recall5: recallAtK(results, 5),
		recall10: recallAtK(results, 10),
		mrr: mrr(results),
		p50Ms: percentile(latencies, 50),
		p95Ms: percentile(latencies, 95),
	};
}
