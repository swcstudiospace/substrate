/**
 * The authority of a cited corpus document and the re-rank it drives (v1.7 phase 66, REFLECT-03 and REFLECT-04).
 *
 * Pure: `reflectCitations` takes the citations of one `docs_search` answer and a lookup from document key to what is known
 * about it. `off` and `shadow` return the answer's own citations untouched (`shadow` also reports what `on` would do); `on`
 * returns the citations annotated with `stale` and `superseded_by` and re-ordered by authority. It reads no store and no
 * clock, so the same inputs give the same answer.
 *
 * Only a citation that names a corpus document the manifest holds as an ACTIVE row is touched. Every other citation keeps its
 * place and its bytes, and an answer with no such citation is returned as the very array it came in.
 */
import { CORPUS_DATASET, documentKey, isValidPath, isValidRepo } from "@substrate/corpus";
import type { DocsRerankMode } from "../config.ts";
import type { SearchCitation } from "../docs-search.ts";

/** What the manifest, the supersession map and the feedback counts say about one cited document. */
export interface DocAuthority {
	/** `scoreDocument`, 0..1. */
	authority: number;
	stale: boolean;
	/** The key of the document that replaces this one, or null. */
	supersededBy: string | null;
}

/** Null when the manifest has no active row for the key: the citation is then left exactly as it was. */
export type AuthorityLookup = (key: string) => DocAuthority | null;

/**
 * The re-rank multiplies a citation's own score by `FLOOR + (1 - FLOOR) * authority`, so authority moves a citation by at
 * most half of its score: the plane's relevance still decides, authority only breaks near ties and demotes the doubtful.
 */
export const RERANK_AUTHORITY_FLOOR = 0.5;

/** A document is `stale` through feedback once this many readers called it stale and more did so than called it helpful. */
export const STALE_FEEDBACK_MIN = 3;

/** What `shadow` records: the order the corpus citations would take and how many positions would change. */
export interface ShadowNote {
	mode: "shadow";
	/** The keys of the re-ordered corpus citations, in the order `on` would answer them. */
	order: string[];
	moved: number;
}

export interface ReflectedCitations {
	chunks: SearchCitation[];
	/** Set only in `on` mode: the answer carries it as `rerank`. */
	rerank?: { applied: true; moved: number };
	/** Set only in `shadow` mode, for the telemetry row; the answer is not touched by it. */
	shadow?: ShadowNote;
}

/** The manifest key of the corpus document a citation names, or null for any other citation. */
export function corpusKeyOf(citation: Pick<SearchCitation, "dataset" | "title">): string | null {
	if (citation.dataset !== CORPUS_DATASET) return null;
	// A repository never holds a colon, so the first one separates it from the path.
	const colon = citation.title.indexOf(":");
	if (colon < 1) return null;
	const repo = citation.title.slice(0, colon);
	const path = citation.title.slice(colon + 1);
	return isValidRepo(repo) && isValidPath(path) ? documentKey(repo, path) : null;
}

/** Whether feedback alone marks a document stale. */
export function staleByFeedback(counts: { stale: number; helpful: number }): boolean {
	return counts.stale >= STALE_FEEDBACK_MIN && counts.stale > counts.helpful;
}

interface Scored {
	index: number;
	key: string;
	adjusted: number;
}

/**
 * `off` returns the citations as they came. `shadow` returns them as they came and reports the order `on` would take and how
 * many positions would change. `on` annotates the corpus citations the lookup knows and puts them in that order, in the
 * positions the corpus citations already held; every other citation stays where it was.
 */
export function reflectCitations(chunks: SearchCitation[], lookup: AuthorityLookup, mode: DocsRerankMode): ReflectedCitations {
	if (mode === "off") return { chunks };
	const scored: Scored[] = [];
	const annotated: SearchCitation[] = chunks.map((chunk, index) => {
		const key = corpusKeyOf(chunk);
		const known = key === null ? null : lookup(key);
		if (key === null || known === null) return chunk;
		scored.push({ index, key, adjusted: chunk.score * (RERANK_AUTHORITY_FLOOR + (1 - RERANK_AUTHORITY_FLOOR) * known.authority) });
		return { ...chunk, stale: known.stale, superseded_by: known.supersededBy };
	});
	if (scored.length === 0) return { chunks };

	// Highest adjusted score first; equal scores keep the order the plane gave them.
	const order = [...scored].sort((left, right) => right.adjusted - left.adjusted || left.index - right.index);
	// `scored` is built in citation order, so these are the corpus citations' positions, ascending.
	const slots = scored.map((entry) => entry.index);
	const moved = order.filter((entry, position) => entry.index !== slots[position]).length;
	if (mode === "shadow") return { chunks, shadow: { mode: "shadow", order: order.map((entry) => entry.key), moved } };

	const reordered = [...annotated];
	order.forEach((entry, position) => {
		const slot = slots[position];
		const citation = annotated[entry.index];
		if (slot !== undefined && citation !== undefined) reordered[slot] = citation;
	});
	return { chunks: reordered, rerank: { applied: true, moved } };
}
