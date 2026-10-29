import { describe, expect, test } from "bun:test";
import { documentKey, sourceUrl, SLO_DEFAULTS, type CorpusEntry, type EvalDocument } from "@substrate/corpus";
import { evaluateCorpus, EVAL_LISTED_PROBLEMS, readEvalDocuments, type EvalRequest } from "./eval.ts";
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
});

const DOCS: EvalDocument[] = [
	{ repo: "acme/atlas", path: "docs/guide.md", text: "# Backup restore drill guide\n\nWe restore nightly snapshots.\n" },
	{ repo: "acme/atlas", path: "README.md", text: "# Alpha project overview\n\nAlpha is a sample project for tests.\n" },
];
const GUIDE = sourceUrl("acme/atlas", "docs/guide.md");
const README = sourceUrl("acme/atlas", "README.md");

function request(over: Partial<EvalRequest> & { answer?: (question: string) => Response } = {}): EvalRequest {
	const { answer, ...rest } = over;
	return {
		documents: { docs: DOCS, unreadable: { count: 0, listed: [] } },
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
		const documents = { docs: DOCS, unreadable: { count: 2, listed: ["acme/atlas:x.md"] } };
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
		const outcome = await evaluateCorpus(request({ documents: { docs: [], unreadable: { count: 0, listed: [] } } }));
		expect(outcome.code).toBe(1);
		expect(outcome.warning).toContain("no question could be generated");
	});

	test("the number of questions is capped by maxQueries", async () => {
		const outcome = await evaluateCorpus(request({ server: null, maxQueries: 2 }));
		expect(outcome.text).toContain("questions it would ask: 2");
	});
});
