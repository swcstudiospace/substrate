import { describe, expect, test } from "bun:test";
import {
	generateGolden,
	GOLDEN_LEAD_WORDS,
	GOLDEN_QUERIES_PER_DOCUMENT,
	mrr,
	outlineOf,
	percentile,
	plainText,
	recallAtK,
	scoreRun,
	seededRandom,
	type EvalDocument,
	type QueryResult,
} from "./eval.ts";

function result(expected: string, ranked: string[], latencyMs = 1): QueryResult {
	return { query: `ask ${expected}`, expected, ranked, latencyMs };
}

describe("outlineOf", () => {
	const text = [
		"---",
		"title: ignored front matter",
		"---",
		"# Backup `drill` guide",
		"",
		"First sentence of the opening paragraph is here and it runs long enough to be cut. Second sentence.",
		"",
		"```md",
		"# Not a title",
		"## Not a heading",
		"```",
		"",
		"## Snapshot **schedule**",
		"",
		"Body text.",
		"",
		"## [Restore](restore.md) steps",
		"",
		"# A second level one is not the title",
	].join("\n");

	test("reads the first level-1 heading, every level-2 heading and the cut opening sentence, with markup removed", () => {
		const outline = outlineOf(text);
		expect(outline.title).toBe("Backup drill guide");
		expect(outline.headings).toEqual(["Snapshot schedule", "Restore steps"]);
		expect(outline.lead).toBe("First sentence of the opening paragraph is here and it runs long");
		expect(outline.lead?.split(" ")).toHaveLength(GOLDEN_LEAD_WORDS);
	});

	test("a document with no title, no paragraph or only a table says so with nulls", () => {
		expect(outlineOf("")).toEqual({ title: null, headings: [], lead: null });
		expect(outlineOf("| a | b |\n|---|---|\n| 1 | 2 |")).toEqual({ title: null, headings: [], lead: null });
	});

	test("a lead that ends before the cut keeps its own words and loses its full stop", () => {
		expect(outlineOf("# T\n\nShort lead here. More.").lead).toBe("Short lead here");
	});

	test("plainText keeps link text and code words and drops emphasis and tags", () => {
		expect(plainText("See [the **guide**](a.md) for `code` <b>now</b> ##")).toBe("See the guide for code now");
	});

	test("a fence closes only on a run of its own character at least as long as its opener, so a longer block holds a shorter example", () => {
		const outline = outlineOf(
			["# Doc title here", "", "Real lead sentence for this page.", "", "````md", "```js", "# Fake title in code", "## Fake heading in code", "```", "Paragraph inside the block.", "````", "", "## Real heading"].join("\n"),
		);
		expect(outline).toEqual({ title: "Doc title here", headings: ["Real heading"], lead: "Real lead sentence for this page" });
		// The example's own heading would be the lead if the block had closed early.
		expect(outlineOf("````\n```\n## inside\n```\n````\n## after").headings).toEqual(["after"]);
	});

	test("a closer with an info string does not close, and an unterminated fence runs to the end of the document", () => {
		expect(outlineOf("```\n```js\n## inside\n```\n## outside").headings).toEqual(["outside"]);
		expect(outlineOf("# Title of doc\n\n```\n## hidden heading\nstill code text").headings).toEqual([]);
		expect(outlineOf("```\n## hidden\n").lead).toBeNull();
	});

	test("a tilde fence is closed by tildes only, not by backticks or a shorter tilde run", () => {
		expect(outlineOf(["~~~~", "```", "## inside one", "~~~", "## inside two", "~~~~", "", "## After"].join("\n")).headings).toEqual(["After"]);
		// Not a fence at all: a backtick opener with a backtick in its info string is inline code.
		expect(outlineOf("``` not a fence `code`\n\n## Visible").headings).toEqual(["Visible"]);
	});
});

describe("generateGolden", () => {
	const alpha: EvalDocument = {
		repo: "r/a",
		path: "docs/alpha.md",
		text: "# Alpha backup drill\n\nWe restore nightly snapshots into scratch clusters.\n\n## Verify restore\n\nText.\n",
	};
	const beta: EvalDocument = { repo: "r/b", path: "docs/beta.md", text: "# Beta rate limits\n\nTokens refill every hundred milliseconds.\n" };

	test("a document yields its title, its opening sentence and each heading joined with the title, expecting its own key", () => {
		expect(generateGolden([alpha])).toEqual([
			{ query: "Alpha backup drill", expected: "r/a:docs/alpha.md", kind: "title" },
			{ query: "We restore nightly snapshots into scratch clusters", expected: "r/a:docs/alpha.md", kind: "lead" },
			{ query: "Alpha backup drill Verify restore", expected: "r/a:docs/alpha.md", kind: "heading" },
		]);
	});

	test("the order does not depend on the order of the documents", () => {
		expect(generateGolden([beta, alpha])).toEqual(generateGolden([alpha, beta]));
		expect(generateGolden([alpha, beta]).map((query) => query.expected)).toEqual([
			"r/a:docs/alpha.md",
			"r/a:docs/alpha.md",
			"r/a:docs/alpha.md",
			"r/b:docs/beta.md",
			"r/b:docs/beta.md",
		]);
	});

	test("a question under three words is dropped", () => {
		const short: EvalDocument = { repo: "r/s", path: "s.md", text: "# Short title\n\nTwo words.\n" };
		expect(generateGolden([short])).toEqual([]);
	});

	test("a title that two documents share is dropped for both, while their differing headings still ask", () => {
		const one: EvalDocument = { repo: "r/one", path: "g.md", text: "# Getting started here\n\n## Install tool\n" };
		const two: EvalDocument = { repo: "r/two", path: "g.md", text: "# Getting started here\n\n## Pick region\n" };
		expect(generateGolden([one, two])).toEqual([
			{ query: "Getting started here Install tool", expected: "r/one:g.md", kind: "heading" },
			{ query: "Getting started here Pick region", expected: "r/two:g.md", kind: "heading" },
		]);
	});

	test("an exact copy of a page, such as an archive, is one answer group asked once through its canonical copy", () => {
		const copy: EvalDocument = { ...alpha, path: "milestones/v1/docs/alpha.md" };
		const golden = generateGolden([alpha, copy]);
		expect(golden.map((query) => [query.query, query.expected])).toEqual(generateGolden([alpha]).map((query) => [query.query, query.expected]));
		for (const query of golden) expect(query.alsoExpected).toEqual(["r/a:milestones/v1/docs/alpha.md"]);
	});

	test("a title that is a phrase of another title is ambiguous too", () => {
		const longer: EvalDocument = { repo: "r/l", path: "l.md", text: "# Alpha backup drill checklist\n" };
		const titles = generateGolden([alpha, longer]).filter((query) => query.kind === "title");
		expect(titles.map((query) => query.expected)).toEqual(["r/l:l.md"]);
	});

	test("over the per-document cap the title is kept and the rest are chosen by the seed, in document order", () => {
		const headings = Array.from({ length: 8 }, (_, i) => `## Section number ${i + 1}`).join("\n\nText.\n\n");
		const many: EvalDocument = { repo: "r/m", path: "m.md", text: `# Many headings document\n\n${headings}\n` };
		const first = generateGolden([many], { seed: 7 });
		expect(first).toHaveLength(GOLDEN_QUERIES_PER_DOCUMENT);
		expect(first[0]?.kind).toBe("title");
		expect(generateGolden([many], { seed: 7 })).toEqual(first);
		const numbers = first.slice(1).map((query) => Number(query.query.split(" ").at(-1)));
		expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
		for (const query of first.slice(1)) expect(query.query).toMatch(/^Many headings document Section number [1-8]$/);
	});

	test("a cap on the whole set samples with the seed and is repeatable", () => {
		const docs: EvalDocument[] = Array.from({ length: 6 }, (_, i) => ({ repo: "r/x", path: `d${i}.md`, text: `# Unique topic number ${i}${"x".repeat(i)}\n` }));
		const all = generateGolden(docs);
		expect(all).toHaveLength(6);
		const capped = generateGolden(docs, { maxQueries: 2, seed: 3 });
		expect(capped).toHaveLength(2);
		expect(generateGolden(docs, { maxQueries: 2, seed: 3 })).toEqual(capped);
		for (const query of capped) expect(all).toContainEqual(query);
		expect(generateGolden(docs, { maxQueries: 0 })).toEqual([]);
	});

	test("copies of a page are one answer group: the canonical copy's retriever scores full recall at the default settings, and so does one that returns another copy", () => {
		const sections = Array.from({ length: 8 }, (_, i) => `## Section number ${i + 1}\n\nText.\n`).join("\n");
		const text = `# Many headings document\n\nThe opening sentence of this page.\n\n${sections}`;
		const first: EvalDocument = { repo: "r/m", path: "docs/m.md", text };
		const second: EvalDocument = { repo: "r/m", path: "archive/m.md", text };
		const golden = generateGolden([first, second]);
		expect(golden).toHaveLength(GOLDEN_QUERIES_PER_DOCUMENT);
		const canonical = "r/m:archive/m.md";
		for (const query of golden) {
			expect(query.expected).toBe(canonical);
			expect(query.alsoExpected).toEqual(["r/m:docs/m.md"]);
		}
		const asked = (ranked: string): QueryResult[] => golden.map((query) => ({ query: query.query, expected: query.expected, ...(query.alsoExpected === undefined ? {} : { alsoExpected: query.alsoExpected }), ranked: [ranked], latencyMs: 1 }));
		expect(scoreRun(asked(canonical)).recall5).toBe(1);
		expect(scoreRun(asked("r/m:docs/m.md")).recall5).toBe(1);
		expect(scoreRun(asked("r/other:x.md")).recall5).toBe(0);
	});

	test("a phrase two different pages both ask is dropped for both whatever each page would have sampled", () => {
		const own = (name: string): string => Array.from({ length: 8 }, (_, i) => `## ${name} part ${i + 1}\n\nText.\n`).join("\n");
		const one: EvalDocument = { repo: "r/one", path: "g.md", text: `# Getting started here\n\n${own("First")}\n## Shared part\n\nText.\n` };
		const two: EvalDocument = { repo: "r/two", path: "g.md", text: `# Getting started here\n\n${own("Second")}\n## Shared part\n\nText.\n` };
		for (let seed = 1; seed <= 25; seed++) {
			const golden = generateGolden([one, two], { seed });
			expect(golden.filter((query) => query.query.endsWith("Shared part"))).toEqual([]);
			expect(golden.length).toBeGreaterThan(0);
		}
	});
});

describe("seededRandom", () => {
	test("the same seed gives the same sequence in [0, 1), and another seed another one", () => {
		const a = seededRandom(5);
		const b = seededRandom(5);
		const sequence = [a(), a(), a()];
		expect([b(), b(), b()]).toEqual(sequence);
		for (const value of sequence) expect(value >= 0 && value < 1).toBe(true);
		expect(seededRandom(6)()).not.toBe(sequence[0]);
	});
});

describe("metrics", () => {
	const results = [
		result("X", ["X", "a"]),
		result("Y", ["a", "Y", "b"]),
		result("Z", ["a", "b", "c", "d", "e", "Z"]),
		result("W", ["a"]),
	];

	test("recall at k is the share of questions answered within the first k", () => {
		expect(recallAtK(results, 1)).toBe(0.25);
		expect(recallAtK(results, 5)).toBe(0.5);
		expect(recallAtK(results, 10)).toBe(0.75);
		expect(recallAtK(results, 0)).toBe(0);
		expect(recallAtK([], 5)).toBe(0);
	});

	test("MRR averages 1 over the rank of the expected key, and a miss adds nothing", () => {
		expect(mrr(results)).toBeCloseTo((1 + 1 / 2 + 1 / 6 + 0) / 4, 12);
		expect(mrr([])).toBe(0);
	});

	test("the rank is the first occurrence when a key is listed twice", () => {
		expect(mrr([result("A", ["b", "A", "A"])])).toBe(0.5);
	});

	test("percentile is nearest-rank, ignores non-finite samples and is 0 for none", () => {
		const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
		expect(percentile(latencies, 50)).toBe(50);
		expect(percentile(latencies, 95)).toBe(100);
		expect(percentile(latencies, 0)).toBe(10);
		expect(percentile(latencies, 100)).toBe(100);
		expect(percentile(latencies, 150)).toBe(100);
		expect(percentile([Number.NaN, 5], 50)).toBe(5);
		expect(percentile([], 50)).toBe(0);
		expect(percentile([3, 1, 2], 10)).toBe(1);
	});

	test("scoreRun folds every metric of a run", () => {
		const timed = [result("X", ["X"], 4), result("Y", ["a", "Y"], 1), result("Z", ["a"], 3), result("W", ["W"], 2)];
		const score = scoreRun(timed);
		expect(score.queries).toBe(4);
		expect(score.recall1).toBe(0.5);
		expect(score.recall5).toBe(0.75);
		expect(score.recall10).toBe(0.75);
		expect(score.mrr).toBeCloseTo((1 + 0.5 + 0 + 1) / 4, 12);
		expect(score.p50Ms).toBe(2);
		expect(score.p95Ms).toBe(4);
		expect(scoreRun([])).toEqual({ queries: 0, recall1: 0, recall5: 0, recall10: 0, mrr: 0, p50Ms: 0, p95Ms: 0 });
	});

	test("a hit on any copy of the expected page counts, at the best place among them", () => {
		const copied: QueryResult = { query: "q", expected: "A", alsoExpected: ["B", "C"], ranked: ["x", "C", "A"], latencyMs: 1 };
		expect(recallAtK([copied], 1)).toBe(0);
		expect(recallAtK([copied], 2)).toBe(1);
		expect(mrr([copied])).toBe(0.5);
		expect(recallAtK([{ ...copied, ranked: ["x", "y"] }], 5)).toBe(0);
	});
});
