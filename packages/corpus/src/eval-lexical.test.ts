import { describe, expect, test } from "bun:test";
import { createLexicalIndex, LEXICAL_DEFAULT_LIMIT, tokenize, type LexicalHit } from "./eval-lexical.ts";
import { defined } from "./test-support.ts";

describe("tokenize", () => {
	test("lower-cases, splits on anything that is not a letter or digit and drops the stop words", () => {
		expect(tokenize("The Quick-brown fox, and THE dog's 2 bones!")).toEqual(["quick", "brown", "fox", "dog", "s", "2", "bones"]);
		expect(tokenize("the and of")).toEqual([]);
		expect(tokenize("Café déjà-vu")).toEqual(["café", "déjà", "vu"]);
	});
});

describe("createLexicalIndex", () => {
	const keys = (hits: readonly LexicalHit[]): string[] => hits.map((hit) => hit.key);

	test("a document that has a query term is found and one that has none is not", () => {
		const index = createLexicalIndex([
			{ key: "r:a.md", text: "# Backup drill\n\nrestore the snapshot\n" },
			{ key: "r:b.md", text: "# Rate limits\n\nbucket tokens refill\n" },
		]);
		expect(index.size).toBe(2);
		expect(keys(index.search("snapshot restore"))).toEqual(["r:a.md"]);
		expect(keys(index.search("zebra"))).toEqual([]);
		expect(keys(index.search("the of"))).toEqual([]);
		expect(createLexicalIndex([]).search("anything")).toEqual([]);
	});

	test("the title counts for more than a mention: a long document titled for the query outranks a short one that only says it", () => {
		const index = createLexicalIndex([
			{ key: "r:mention.md", text: "# Notes\n\ntokens refill\n" },
			{ key: "r:titled.md", text: "# Tokens refill\n\nsteady rate across every hundred milliseconds window\n" },
		]);
		expect(keys(index.search("tokens refill"))).toEqual(["r:titled.md", "r:mention.md"]);
	});

	test("hits are best first, with a score that falls and ties broken by key whatever the input order", () => {
		const docs = [
			{ key: "r:z.md", text: "# Zeta topic\n\nalpha beta\n" },
			{ key: "r:y.md", text: "# Zeta topic\n\nalpha, beta\n" },
			{ key: "r:x.md", text: "# Other\n\nalpha\n" },
		];
		const forward = createLexicalIndex(docs).search("alpha beta");
		const backward = createLexicalIndex([...docs].reverse()).search("alpha beta");
		expect(keys(forward)).toEqual(["r:y.md", "r:z.md", "r:x.md"]);
		expect(forward).toEqual(backward);
		expect(defined(forward[0]).score).toBe(defined(forward[1]).score);
		expect(defined(forward[1]).score).toBeGreaterThan(defined(forward[2]).score);
	});

	test("exact duplicates collapse to one result under the lexically smallest key, and a near-duplicate stays", () => {
		const same = "# Backup drill\n\nrestore the snapshot nightly\n";
		const index = createLexicalIndex([
			{ key: "r:milestones/v1/backup.md", text: same },
			{ key: "r:docs/backup.md", text: same },
			{ key: "q:backup.md", text: same },
			{ key: "r:docs/backup-draft.md", text: `${same}\nOne more line.\n` },
			{ key: "r:docs/other.md", text: "# Other\n\nunrelated words\n" },
		]);
		const found = keys(index.search("backup drill restore snapshot"));
		expect(found).toHaveLength(2);
		expect(found).toContain("q:backup.md");
		expect(found).toContain("r:docs/backup-draft.md");
		expect(found).not.toContain("r:docs/backup.md");
		expect(found).not.toContain("r:milestones/v1/backup.md");
	});

	test("the re-rank step sees the collapsed hits, decides the order and runs before the limit", () => {
		const same = "# Backup drill\n\nrestore the snapshot\n";
		const index = createLexicalIndex([
			{ key: "r:a.md", text: same },
			{ key: "r:b.md", text: same },
			{ key: "r:c.md", text: "# Backup\n\nsnapshot\n" },
		]);
		let seen: LexicalHit[] = [];
		const reversed = index.search("backup drill restore snapshot", {
			rerank: (hits) => {
				seen = [...hits];
				return [...hits].reverse();
			},
		});
		expect(keys(seen)).toEqual(["r:a.md", "r:c.md"]);
		expect(keys(reversed)).toEqual(["r:c.md", "r:a.md"]);
		const limited = index.search("backup drill restore snapshot", { rerank: (hits) => [...hits].reverse(), limit: 1 });
		expect(keys(limited)).toEqual(["r:c.md"]);
	});

	test("a re-rank that boosts a lower hit moves it first without touching the scores it was given", () => {
		const index = createLexicalIndex([
			{ key: "r:a.md", text: "# Alpha alpha\n\nalpha\n" },
			{ key: "r:b.md", text: "# Beta\n\nalpha\n" },
		]);
		const plain = index.search("alpha");
		expect(keys(plain)).toEqual(["r:a.md", "r:b.md"]);
		const boosted = index.search("alpha", { rerank: (hits) => [...hits].sort((x, y) => (x.key === "r:b.md" ? -1 : y.key === "r:b.md" ? 1 : 0)) });
		expect(keys(boosted)).toEqual(["r:b.md", "r:a.md"]);
		expect(boosted).toEqual([defined(plain[1]), defined(plain[0])]);
	});

	test("the limit defaults to ten and a limit of zero answers nothing", () => {
		const docs = Array.from({ length: 12 }, (_, i) => ({ key: `r:d${String(i).padStart(2, "0")}.md`, text: `# Topic ${i}\n\nshared word\n` }));
		const index = createLexicalIndex(docs);
		expect(index.search("shared")).toHaveLength(LEXICAL_DEFAULT_LIMIT);
		expect(index.search("shared", { limit: 3 })).toHaveLength(3);
		expect(index.search("shared", { limit: 0 })).toEqual([]);
	});
});
