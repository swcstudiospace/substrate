import { describe, expect, test } from "bun:test";
import { documentKey, sourceUrl, SLO_DEFAULTS, type CorpusEntry, type EvalDocument } from "@substrate/corpus";
import { evaluateCorpus, EVAL_LISTED_PROBLEMS, readEvalDocuments, type EvalDocuments, type EvalRequest } from "./eval.ts";
import { defined } from "../../../corpus/src/test-support.ts";
import type { Inventory } from "./inventory.ts";

function entry(repo: string, path: string): CorpusEntry {
	return { repo, path, kind: "doc", tier: 1, sha256: "a".repeat(64), bytes: 10, source: "fs" };
}

function inventoryOf(files: Record<string, string | null>, repo = "acme/atlas"): Inventory {
	const entries = Object.keys(files).map((path) => entry(repo, path));
	return {
		entries,
		report: { checkouts: 1, repos: [], collapsed: { clones: 0, worktrees: 0, identical: 0, identicalGroups: 0, identicalCopies: [] }, skipped: [], skippedByReason: {}, emptyCollections: 0, notes: [] },
		// An entry mapped to null has no path on disk, as a GitHub document has none.
		paths: new Map(Object.entries(files).flatMap(([path, text]) => (text === null ? [] : [[documentKey(repo, path), `/work/${path}`] as [string, string]]))),
		sources: ["fs"],
		maxTier: 3,
		scope: { coverage: [], maxTier: 3 },
	};
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("readEvalDocuments", () => {
	test("reads the Markdown documents the scan listed, from their paths, and skips other files and documents with no path on disk", () => {
		const inventory = inventoryOf({ "docs/a.md": "# A doc here\n", "docs/B.MD": "# B doc here\n", "notes.txt": "plain", "docs/remote.md": null });
		const read = (path: string): Uint8Array => encode(path.endsWith("a.md") ? "# A doc here\n" : "# B doc here\n");
		const { docs, unreadable } = readEvalDocuments(inventory, read);
		expect(docs.map((doc) => `${doc.repo}:${doc.path}`)).toEqual(["acme/atlas:docs/a.md", "acme/atlas:docs/B.MD"]);
		expect(unreadable).toEqual({ count: 0, listed: [] });
	});

	test("a file that cannot be read is counted and named, and the others are still read", () => {
		const inventory = inventoryOf({ "a.md": "x", "b.md": "x", "c.md": "x" });
		const { docs, unreadable } = readEvalDocuments(inventory, (path) => {
			if (path.endsWith("b.md")) throw new Error("EACCES");
			return encode("# T here ok\n");
		});
		expect(docs.map((doc) => doc.path)).toEqual(["a.md", "c.md"]);
		expect(unreadable).toEqual({ count: 1, listed: ["acme/atlas:b.md"] });
	});

	test("names only the first few unreadable files and counts the rest", () => {
		const files = Object.fromEntries(Array.from({ length: EVAL_LISTED_PROBLEMS + 5 }, (_, i) => [`d${i}.md`, "x"]));
		const { unreadable } = readEvalDocuments(inventoryOf(files), () => {
			throw new Error("gone");
		});
		expect(unreadable.count).toBe(EVAL_LISTED_PROBLEMS + 5);
		expect(unreadable.listed).toHaveLength(EVAL_LISTED_PROBLEMS);
	});

	test("keeps a byte-order mark in the text it hands over", () => {
		const { docs } = readEvalDocuments(inventoryOf({ "a.md": "x" }), () => new Uint8Array([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x54]));
		expect(defined(docs[0]).text.startsWith("\ufeff")).toBe(true);
	});

	test("carries the repositories the scan did not read completely, from its report, with their source and reason", () => {
		const inventory = inventoryOf({ "a.md": "x" });
		inventory.report.repos = [
			{ repo: "acme/atlas", dir: "/w/atlas", source: "fs", files: 1, bytes: 1, complete: true },
			{ repo: "acme/beta", dir: "/w/beta", source: "fs", files: 0, bytes: 0, complete: false, incomplete: "git ls-files failed in /w/beta (exit 128)" },
			{ repo: "acme/gamma", dir: "github:acme/gamma", source: "github", files: 2, bytes: 9, complete: false },
		];
		const { incomplete } = readEvalDocuments(inventory, () => encode("# A doc here\n"));
		expect(incomplete).toEqual({
			count: 2,
			listed: [
				{ repo: "acme/beta", source: "fs", reason: "git ls-files failed in /w/beta (exit 128)" },
				{ repo: "acme/gamma", source: "github", reason: "incomplete" },
			],
		});
		expect(readEvalDocuments(inventoryOf({ "a.md": "x" }), () => encode("x")).incomplete).toEqual({ count: 0, listed: [] });
	});
});

const DOCS: EvalDocument[] = [
	{ repo: "acme/atlas", path: "docs/guide.md", text: "# Backup restore drill guide\n\nWe restore nightly snapshots.\n" },
	{ repo: "acme/atlas", path: "README.md", text: "# Alpha project overview\n\nAlpha is a sample project for tests.\n" },
];
const GUIDE = sourceUrl("acme/atlas", "docs/guide.md");
const README = sourceUrl("acme/atlas", "README.md");

const PLAIN_DOCUMENTS: EvalDocuments = { docs: DOCS, unreadable: { count: 0, listed: [] }, incomplete: { count: 0, listed: [] }, copies: { groups: [], unlisted: 0 } };

function request(over: Partial<EvalRequest> & { answer?: (question: string) => Response } = {}): EvalRequest {
	const { answer, ...rest } = over;
	return {
		documents: PLAIN_DOCUMENTS,
		maxQueries: 500,
		thresholds: { ...SLO_DEFAULTS },
		server: {
			url: "http://127.0.0.1:7410",
			token: "tok-1",
			fetchImpl: async (_url, init) => {
				const question = String(JSON.parse(String(init?.body)).question);
				return answer?.(question) ?? Response.json({ chunks: [{ source_url: question.includes("estore") || question.includes("Backup") ? GUIDE : README }] });
			},
		},
		json: false,
		now: () => 0,
		...rest,
	};
}

describe("evaluateCorpus", () => {
	test("without a server it only counts the questions and exits 0", async () => {
		const outcome = await evaluateCorpus(request({ server: null }));
		expect(outcome.code).toBe(0);
		expect(outcome.text).toBe("documents read: 2\nquestions it would ask: 4 (add --server URL to ask them)\n");
		expect(outcome.warning).toBe("");
		const json: unknown = JSON.parse((await evaluateCorpus(request({ server: null, json: true }))).text);
		expect(json).toMatchObject({ mode: "dry-run", documents: 2, questions: 4, warnings: [] });
	});

	test("a dry run still names the files it could not read, in both forms, and exits 0", async () => {
		const documents = { ...PLAIN_DOCUMENTS, unreadable: { count: 2, listed: ["acme/atlas:x.md"] } };
		const human = await evaluateCorpus(request({ server: null, documents }));
		expect(human.code).toBe(0);
		expect(human.warning).toContain("2 document(s) could not be read");
		expect(human.warning).toContain("acme/atlas:x.md, +1 more");
		const json = JSON.parse((await evaluateCorpus(request({ server: null, documents, json: true }))).text);
		expect(json.unreadable).toEqual({ count: 2, listed: ["acme/atlas:x.md"] });
		expect(json.warnings).toHaveLength(1);
	});

	test("a server that finds every document holds the objective: exit 0 with the metrics", async () => {
		const outcome = await evaluateCorpus(request());
		expect(outcome.code).toBe(0);
		expect(outcome.text).toContain("questions: 4, answered 4, failed 0, degraded 0");
		expect(outcome.text).toContain("recall@5=1.000");
		expect(outcome.text).toContain("recall@5 holds the objective 0.6");
		expect(outcome.warning).toBe("");
	});

	test("a recall under the objective is a breach: exit 1 and a FAIL line, and the threshold is the one given", async () => {
		const wrong = await evaluateCorpus(request({ answer: () => Response.json({ chunks: [{ source_url: README }] }) }));
		expect(wrong.code).toBe(1);
		expect(wrong.text).toContain("FAIL recall@5 0.500 is under the objective 0.6");
		const lenient = await evaluateCorpus(request({ answer: () => Response.json({ chunks: [{ source_url: README }] }), thresholds: { ...SLO_DEFAULTS, recall5: 0.4 } }));
		expect(lenient.code).toBe(0);
		const asJson = await evaluateCorpus(request({ answer: () => Response.json({ chunks: [{ source_url: README }] }), json: true }));
		expect(JSON.parse(asJson.text)).toMatchObject({ mode: "live", answered: 4, threshold: 0.6, breaches: ["recall5"] });
	});

	test("questions that failed or came back degraded make the exit 1 and are said in both forms, never a pass on the answered ones", async () => {
		const down = await evaluateCorpus(request({ answer: () => new Response("no", { status: 503 }) }));
		expect(down.code).toBe(1);
		expect(down.warning).toContain("question(s) failed");
		const degraded = await evaluateCorpus(request({ answer: () => Response.json({ chunks: [], degraded: true }), json: true }));
		expect(degraded.code).toBe(1);
		expect(JSON.parse(degraded.text)).toMatchObject({ degraded: 4, answered: 0 });
		expect(degraded.warning).toContain("degraded");
	});

	test("no documents means no questions, and a live run with none is not a pass", async () => {
		const outcome = await evaluateCorpus(request({ documents: { ...PLAIN_DOCUMENTS, docs: [] } }));
		expect(outcome.code).toBe(1);
		expect(outcome.warning).toContain("no question could be generated");
	});

	test("the number of questions is capped by maxQueries", async () => {
		const outcome = await evaluateCorpus(request({ server: null, maxQueries: 2 }));
		expect(outcome.text).toContain("questions it would ask: 2");
	});

	test("a scan that skipped a repository is partial: both forms name it, a pass is labelled partial, and the exit code is still the objective's", async () => {
		const incomplete = { count: 3, listed: [{ repo: "acme/gone", source: "fs", reason: "git ls-files failed in /w/gone (exit 128)\u001b[2J" }] };
		const documents = { ...PLAIN_DOCUMENTS, incomplete };
		const human = await evaluateCorpus(request({ documents }));
		expect(human.code).toBe(0);
		expect(human.text).toContain("not read completely: 3");
		expect(human.text).toContain("acme/gone [fs]: git ls-files failed in /w/gone (exit 128)\\x1b[2J");
		expect(human.text).toContain("+2 more");
		expect(human.text).not.toContain("\u001b");
		expect(human.text).toContain("recall@5 holds the objective 0.6 (partial: 3 repository(ies) not read completely)");
		expect(human.warning).toContain("partial scan: 3 repository(ies)");
		const asJson = JSON.parse((await evaluateCorpus(request({ documents, json: true }))).text);
		expect(asJson).toMatchObject({ mode: "live", partial: true, incomplete: { count: 3, listed: [{ repo: "acme/gone", source: "fs" }] }, breaches: [] });
		expect(asJson.warnings.some((line: string) => line.startsWith("partial scan"))).toBe(true);

		// A breach over a partial scan still exits 1 and carries the label.
		const breach = await evaluateCorpus(request({ documents, answer: () => Response.json({ chunks: [{ source_url: README }] }) }));
		expect(breach.code).toBe(1);
		expect(breach.text).toContain("FAIL recall@5 0.500 is under the objective 0.6 (partial: 3 repository(ies) not read completely)");

		// A dry run says so too, and a complete scan says nothing about it.
		const dry = await evaluateCorpus(request({ documents, server: null }));
		expect(dry.code).toBe(0);
		expect(dry.text).toContain("not read completely: 3");
		expect(JSON.parse((await evaluateCorpus(request({ documents, server: null, json: true }))).text)).toMatchObject({ mode: "dry-run", partial: true });
		const whole = await evaluateCorpus(request());
		expect(whole.text).not.toContain("partial");
		expect(JSON.parse((await evaluateCorpus(request({ json: true }))).text)).toMatchObject({ partial: false, incomplete: { count: 0, listed: [] } });
	});
});

describe("identical copies the scan collapsed", () => {
	const LOCAL_DOCS: EvalDocument[] = DOCS.map((doc) => ({ ...doc, repo: "local/c1" }));
	const KEEP = "local/c1:docs/guide.md";
	const COPY = "local/c2:docs/guide.md";
	const COPY_GUIDE = sourceUrl("local/c2", "docs/guide.md");
	const LOCAL_README = sourceUrl("local/c1", "README.md");
	// The plane kept the first ingested copy, which is the one in local/c2, and answers with it.
	const answerWithCopy = (question: string): Response => Response.json({ chunks: [{ source_url: question.includes("estore") || question.includes("Backup") ? COPY_GUIDE : LOCAL_README }] });

	test("readEvalDocuments carries the scan's copy groups and counts the copies its report cap left out", () => {
		const inventory = inventoryOf({ "docs/a.md": "x" }, "local/c1");
		inventory.report.collapsed = { clones: 0, worktrees: 0, identical: 3, identicalGroups: 1, identicalCopies: [{ keep: KEEP, copies: [COPY, "local/c3:docs/guide.md"] }] };
		expect(readEvalDocuments(inventory, () => encode("x")).copies).toEqual({ groups: [{ keep: KEEP, copies: [COPY, "local/c3:docs/guide.md"] }], unlisted: 1 });
		expect(readEvalDocuments(inventoryOf({ "docs/a.md": "x" }), () => encode("x")).copies).toEqual({ groups: [], unlisted: 0 });
	});

	test("a hit on a collapsed copy of the kept document scores as a hit", async () => {
		const documents: EvalDocuments = { ...PLAIN_DOCUMENTS, docs: LOCAL_DOCS, copies: { groups: [{ keep: KEEP, copies: [COPY] }], unlisted: 0 } };
		const outcome = await evaluateCorpus(request({ documents, answer: answerWithCopy }));
		expect(outcome.code).toBe(0);
		expect(outcome.text).toContain("recall@5=1.000");

		// Without the group the same correct answers are misses: the failure this carries across.
		const without = await evaluateCorpus(request({ documents: { ...documents, copies: { groups: [], unlisted: 0 } }, answer: answerWithCopy }));
		expect(without.code).toBe(1);
		expect(without.text).toContain("recall@5=0.500");
	});

	test("a group whose kept entry is not among the documents adds nothing", async () => {
		const documents: EvalDocuments = { ...PLAIN_DOCUMENTS, docs: LOCAL_DOCS, copies: { groups: [{ keep: "local/c9:docs/other.md", copies: [COPY] }], unlisted: 0 } };
		const outcome = await evaluateCorpus(request({ documents, answer: answerWithCopy }));
		expect(outcome.code).toBe(1);
		expect(outcome.text).toContain("recall@5=0.500");
	});

	test("copies the scan did not list are a warning in both forms, and do not change the exit code", async () => {
		const documents: EvalDocuments = { ...PLAIN_DOCUMENTS, copies: { groups: [], unlisted: 2 } };
		const human = await evaluateCorpus(request({ documents }));
		expect(human.code).toBe(0);
		expect(human.warning).toContain("2 identical copy(ies) are not listed by the scan");
		const json = JSON.parse((await evaluateCorpus(request({ documents, json: true }))).text);
		expect(json.warnings.some((line: string) => line.includes("identical copy(ies) are not listed"))).toBe(true);
	});
});

describe("a run that could not score is never reported as holding the objective", () => {
	const guideOnly = (question: string): Response => (question.includes("estore") || question.includes("Backup") ? Response.json({ chunks: [{ source_url: GUIDE }] }) : new Response("no", { status: 503 }));

	test("every search failing says the recall was not measured, in both forms, and exits 1", async () => {
		const answer = () => new Response("no", { status: 503 });
		const human = await evaluateCorpus(request({ answer }));
		expect(human.code).toBe(1);
		expect(human.text).toContain("recall@5 not measured (4 of 4 searches failed)");
		expect(human.text).not.toContain("holds the objective");
		expect(human.text).not.toContain("FAIL");
		const json = JSON.parse((await evaluateCorpus(request({ answer, json: true }))).text);
		expect(json).toMatchObject({ answered: 0, scored: false, verdict: "unscored", breaches: [] });
	});

	test("some searches failing is unscored too, with the numbers, and a partial scan keeps its label", async () => {
		const human = await evaluateCorpus(request({ answer: guideOnly }));
		expect(human.code).toBe(1);
		expect(human.text).toContain("recall@5 not measured (2 of 4 searches failed)");
		expect(human.text).not.toContain("holds the objective");
		const incomplete = { count: 1, listed: [{ repo: "acme/gone", source: "fs", reason: "gone" }] };
		const partial = await evaluateCorpus(request({ answer: guideOnly, documents: { ...PLAIN_DOCUMENTS, incomplete } }));
		expect(partial.text).toContain("recall@5 not measured (2 of 4 searches failed) (partial: 1 repository(ies) not read completely)");
		expect(JSON.parse((await evaluateCorpus(request({ answer: guideOnly, json: true }))).text)).toMatchObject({ answered: 2, scored: false, verdict: "unscored" });
	});

	test("degraded answers are named as such, and a breach among the answered ones still prints FAIL", async () => {
		const degraded = await evaluateCorpus(request({ answer: () => Response.json({ chunks: [], degraded: true }) }));
		expect(degraded.text).toContain("recall@5 not measured (4 of 4 searches were answered degraded)");
		const wrongAndDown = await evaluateCorpus(request({ answer: (question) => (question.includes("estore") || question.includes("Backup") ? Response.json({ chunks: [{ source_url: README }] }) : new Response("no", { status: 503 })) }));
		expect(wrongAndDown.code).toBe(1);
		expect(wrongAndDown.text).toContain("FAIL recall@5 0.000 is under the objective 0.6");
		expect(JSON.parse((await evaluateCorpus(request({ answer: () => new Response("no", { status: 503 }), json: true }))).text).verdict).toBe("unscored");
	});

	test("a run where every search answered is scored", async () => {
		const json = JSON.parse((await evaluateCorpus(request({ json: true }))).text);
		expect(json).toMatchObject({ scored: true, verdict: "holds" });
	});
});
