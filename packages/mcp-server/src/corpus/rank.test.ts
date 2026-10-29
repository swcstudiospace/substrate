/**
 * The re-rank of one docs answer, as a pure function: what each mode leaves alone, what `on` annotates and in which order it
 * puts the corpus citations.
 */
import { describe, expect, test } from "bun:test";
import { documentKey, scoreDocument } from "@substrate/corpus";
import type { SearchCitation } from "../docs-search.ts";
import { defined } from "../test-support.ts";
import { type AuthorityLookup, type DocAuthority, STALE_FEEDBACK_MIN, corpusKeyOf, reflectCitations, staleByFeedback } from "./rank.ts";

const REPO = "swcstudiospace/agent-substrate";

function citation(title: string, score: number, over: Partial<SearchCitation> = {}): SearchCitation {
	return {
		title,
		source_url: `https://github.com/${REPO}/blob/HEAD/${title.slice(title.indexOf(":") + 1)}`,
		heading_path: "",
		commit: "dataset-pin:corpus:unrecorded",
		snippet: `text of ${title}`,
		score,
		document_id: "",
		chunk_id: `chunk-${title}`,
		dataset: "corpus",
		...over,
	};
}

const doc = (path: string, score: number): SearchCitation => citation(`${REPO}:${path}`, score);
const keyOf = (path: string): string => documentKey(REPO, path);
const plain = (score: number): SearchCitation => ({ ...citation("plan.md", score), source_url: "https://example.com/plan", dataset: "agent-substrate" });

function lookupOf(entries: Record<string, DocAuthority>): AuthorityLookup {
	const known = new Map(Object.entries(entries));
	return (key) => known.get(key) ?? null;
}

const authority = (value: number, over: Partial<DocAuthority> = {}): DocAuthority => ({ authority: value, stale: false, supersededBy: null, ...over });

describe("corpusKeyOf", () => {
	test("a corpus citation's title is its manifest key", () => {
		expect(corpusKeyOf(doc("docs/a.md", 0.5))).toBe(keyOf("docs/a.md"));
	});

	test("a citation of another dataset, or a title that is not a repo and a path, names no document", () => {
		expect(corpusKeyOf(plain(0.5))).toBeNull();
		expect(corpusKeyOf(citation("no colon here", 0.5))).toBeNull();
		expect(corpusKeyOf(citation("not a repo:docs/a.md", 0.5))).toBeNull();
		expect(corpusKeyOf(citation(`${REPO}:../escape.md`, 0.5))).toBeNull();
	});
});

describe("reflectCitations", () => {
	const better = doc("docs/better.md", 0.7);
	const worse = doc("docs/worse.md", 0.8);
	const known = lookupOf({ [keyOf("docs/better.md")]: authority(1), [keyOf("docs/worse.md")]: authority(0.2) });

	test("off returns the very citations it was given and never consults the lookup", () => {
		const chunks = [worse, better];
		const result = reflectCitations(chunks, () => {
			throw new Error("the lookup must not be read");
		}, "off");
		expect(result.chunks).toBe(chunks);
		expect(result.rerank).toBeUndefined();
		expect(result.shadow).toBeUndefined();
	});

	test("shadow answers with the citations untouched and reports the order on would give and how many positions move", () => {
		const chunks = [worse, better];
		const result = reflectCitations(chunks, known, "shadow");
		expect(result.chunks).toBe(chunks);
		expect(result.chunks[0]).toBe(worse);
		expect(result.shadow).toEqual({ mode: "shadow", order: [keyOf("docs/better.md"), keyOf("docs/worse.md")], moved: 2 });
		expect(result.rerank).toBeUndefined();
	});

	test("on re-orders by score times authority, annotates each corpus citation and reports the positions moved", () => {
		const result = reflectCitations([worse, better], known, "on");
		expect(result.chunks.map((chunk) => chunk.title)).toEqual([`${REPO}:docs/better.md`, `${REPO}:docs/worse.md`]);
		expect(result.chunks[0]).toMatchObject({ stale: false, superseded_by: null });
		expect(result.rerank).toEqual({ applied: true, moved: 2 });
	});

	test("a citation that is not a corpus document keeps its place, and so does a corpus document the manifest does not hold", () => {
		const unknown = doc("docs/unknown.md", 0.6);
		const middle = plain(0.75);
		const result = reflectCitations([worse, middle, better, unknown], known, "on");
		expect(result.chunks.map((chunk) => chunk.title)).toEqual([`${REPO}:docs/better.md`, "plan.md", `${REPO}:docs/worse.md`, `${REPO}:docs/unknown.md`]);
		expect(result.chunks[1]).toBe(middle);
		expect(result.chunks[3]).toBe(unknown);
		expect("stale" in defined(result.chunks[3], "the unknown citation")).toBe(false);
	});

	test("equal adjusted scores keep the plane's order, and nothing moves", () => {
		const first = doc("docs/first.md", 0.6);
		const second = doc("docs/second.md", 0.6);
		const equal = lookupOf({ [keyOf("docs/first.md")]: authority(0.5), [keyOf("docs/second.md")]: authority(0.5) });
		const result = reflectCitations([first, second], equal, "on");
		expect(result.chunks.map((chunk) => chunk.title)).toEqual([first.title, second.title]);
		expect(result.rerank).toEqual({ applied: true, moved: 0 });
		expect(reflectCitations([first, second], equal, "shadow").shadow?.moved).toBe(0);
	});

	test("a superseded document drops below the document that replaces it, and its citation names the replacement", () => {
		const input = { tier: 1, kind: "doc", ageDays: null, feedback: { helpful: 0, unhelpful: 0, stale: 0, wrong: 0, duplicate: 0 } } as const;
		const replacement = keyOf("docs/new-guide.md");
		const lookup = lookupOf({
			[keyOf("docs/old-guide.md")]: authority(scoreDocument({ ...input, supersededBy: replacement }), { stale: true, supersededBy: replacement }),
			[replacement]: authority(scoreDocument({ ...input, supersededBy: null })),
		});
		const result = reflectCitations([doc("docs/old-guide.md", 0.9), doc("docs/new-guide.md", 0.85)], lookup, "on");
		expect(result.chunks.map((chunk) => chunk.title)).toEqual([`${REPO}:docs/new-guide.md`, `${REPO}:docs/old-guide.md`]);
		expect(result.chunks[1]).toMatchObject({ stale: true, superseded_by: replacement });
		expect(result.chunks[0]).toMatchObject({ stale: false, superseded_by: null });
	});

	test("an answer with no corpus document the manifest holds is returned as the array it came in, in every mode", () => {
		const chunks = [plain(0.9), doc("docs/unknown.md", 0.5)];
		for (const mode of ["off", "shadow", "on"] as const) {
			const result = reflectCitations(chunks, lookupOf({}), mode);
			expect({ mode, same: result.chunks === chunks, rerank: result.rerank, shadow: result.shadow }).toEqual({ mode, same: true, rerank: undefined, shadow: undefined });
		}
	});
});

describe("staleByFeedback", () => {
	test("needs the minimum number of stale reports and more of them than helpful ones", () => {
		expect(staleByFeedback({ stale: STALE_FEEDBACK_MIN - 1, helpful: 0 })).toBe(false);
		expect(staleByFeedback({ stale: STALE_FEEDBACK_MIN, helpful: STALE_FEEDBACK_MIN })).toBe(false);
		expect(staleByFeedback({ stale: STALE_FEEDBACK_MIN, helpful: STALE_FEEDBACK_MIN - 1 })).toBe(true);
	});
});
