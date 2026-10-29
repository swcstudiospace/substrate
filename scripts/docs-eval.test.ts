/**
 * The offline retrieval harness runs here, inside `bun test`, so CI guards ranking, de-duplication and the re-rank step with
 * no workflow step of its own (docs/ci.md). Nothing in this file opens a socket: the live tier is driven through a fake fetch.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateGolden, isRecord, scoreRun, sourceUrl, type LexicalHit, type QueryResult, type RunScore } from "../packages/corpus/src/index.ts";
import {
	baselineOf,
	BASELINE_PATH,
	collectLocalDocuments,
	compareToBaseline,
	duplicateCollapseFailures,
	loadFixtureDocuments,
	main,
	measureGoldenRecall,
	MRR_TOLERANCE,
	parseArgs,
	parseBaselines,
	RECALL5_TOLERANCE,
	reportLive,
	runOffline,
	runServer,
	USAGE,
	type Baseline,
	type EvalIo,
} from "./docs-eval.ts";
import { defined } from "./test-support.ts";

const made: string[] = [];
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "substrate-docs-eval-"));
	made.push(root);
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, name)), { recursive: true });
		writeFileSync(join(root, name), text);
	}
	return root;
}

interface Capture {
	io: EvalIo;
	out: string[];
	err: string[];
	requests: Array<{ url: string; body: unknown }>;
}

function capture(overrides: Partial<EvalIo> = {}, answer?: (question: string) => Response): Capture {
	const out: string[] = [];
	const err: string[] = [];
	const requests: Array<{ url: string; body: unknown }> = [];
	const io: EvalIo = {
		env: {},
		fetchImpl: async (url, init) => {
			const body: unknown = JSON.parse(String(init?.body ?? "null"));
			requests.push({ url, body });
			if (answer === undefined) throw new Error("no network in this test");
			return answer(isRecord(body) ? String(body.question) : "");
		},
		stdout: (line) => out.push(line),
		stderr: (line) => err.push(line),
		now: () => 0,
		...overrides,
	};
	return { io, out, err, requests };
}

function scoreOf(overrides: Partial<RunScore>): RunScore {
	return { queries: 100, recall1: 1, recall5: 1, recall10: 1, mrr: 1, p50Ms: 0, p95Ms: 0, ...overrides };
}

const BASE: Baseline = { queries: 100, recall1: 0.9, recall5: 0.95, recall10: 1, mrr: 0.9 };

describe("the committed offline harness (what CI guards)", () => {
	test("runs against the fixtures and the committed baseline, offline, in a few seconds, and passes", async () => {
		const run = capture();
		const began = performance.now();
		const code = await main([], run.io);
		// It runs fixtures in memory and takes a few seconds; the bound only catches a run that waits on something it should not (a network call, a timer), so it is generous enough for a loaded runner.
		expect(performance.now() - began).toBeLessThan(60_000);
		expect({ code, out: run.out, err: run.err }).toMatchObject({ code: 0, err: [] });
		expect(run.out.at(-1)).toBe("docs eval: within the baseline");
		expect(run.requests).toEqual([]);
	});

	test("the committed baselines are ones the parser accepts and the current runs do not fall below", async () => {
		const baselines = defined(parseBaselines(readFileSync(BASELINE_PATH, "utf8")), "committed baseline");
		const docs = loadFixtureDocuments();
		const lexical = await runOffline(docs, () => 0);
		const server = await runServer(docs, () => 0);
		expect(compareToBaseline(lexical.score, baselines.lexical).failures).toEqual([]);
		expect(compareToBaseline(server.score, baselines.server).failures).toEqual([]);
		expect(baselineOf(lexical.score).queries).toBeGreaterThanOrEqual(baselines.lexical.queries);
		expect(baselineOf(server.score).queries).toBeGreaterThanOrEqual(baselines.server.queries);
	});

	test("--json prints one parseable object with the verdict", async () => {
		const run = capture();
		expect(await main(["--json"], run.io)).toBe(0);
		expect(run.out).toHaveLength(1);
		const body: unknown = JSON.parse(defined(run.out[0]));
		expect(body).toMatchObject({ mode: "offline", ok: true, failures: [] });
		expect(isRecord(body) && isRecord(body.score) ? Number(body.score.queries) : 0).toBeGreaterThan(50);
	});
});

describe("the fixture corpus and the generator over it", () => {
	const docs = loadFixtureDocuments();
	const golden = generateGolden(docs);

	test("is about thirty documents from three repositories, with an archive copy, a title in two repositories and a near-duplicate", () => {
		expect(docs.length).toBeGreaterThanOrEqual(28);
		expect(new Set(docs.map((doc) => doc.repo)).size).toBe(3);
		const live = defined(docs.find((doc) => doc.path === "docs/backup-restore.md"));
		const archive = defined(docs.find((doc) => doc.path.startsWith("milestones/") && doc.path.endsWith("backup-restore.md")));
		expect(archive.text).toBe(live.text);
		expect(docs.filter((doc) => doc.text.startsWith("# Incident response handbook")).map((doc) => doc.repo).sort()).toEqual(["acme/atlas", "acme/harbor"]);
		expect(docs.filter((doc) => doc.text.startsWith("# Cache tuning")).length).toBe(2);
	});

	test("asks a good number of questions, names the canonical copy of a copied page and never a title two pages share", () => {
		expect(golden.length).toBeGreaterThan(60);
		const expected = new Set(golden.map((query) => query.expected));
		expect(expected.has("acme/atlas:docs/backup-restore.md")).toBe(true);
		expect(expected.has("acme/atlas:milestones/v1.1/docs/backup-restore.md")).toBe(false);
		expect(golden.some((query) => query.query === "Incident response handbook")).toBe(false);
		expect(golden.some((query) => query.query === "Getting started")).toBe(false);
		expect(golden.some((query) => query.query === "Rate limiting and burst budgets" && query.expected === "acme/atlas:docs/rate-limiting.md")).toBe(true);
	});

	test("a manifest entry that points outside the fixture directory is refused, not read", () => {
		const root = tree({ "manifest.json": JSON.stringify({ documents: [{ repo: "a/b", path: "../../../../etc/hostname" }] }) });
		expect(() => loadFixtureDocuments(root)).toThrow("outside the fixture directory");
	});

	test("a manifest entry with no file is an error that names it", () => {
		const root = tree({ "manifest.json": JSON.stringify({ documents: [{ repo: "a/b", path: "gone.md" }] }) });
		expect(() => loadFixtureDocuments(root)).toThrow();
	});
});

describe("what the harness catches", () => {
	const docs = loadFixtureDocuments();
	const baselines = defined(parseBaselines(readFileSync(BASELINE_PATH, "utf8")), "committed baseline");
	const reversed = (hits: readonly LexicalHit[]): readonly LexicalHit[] => [...hits].reverse();

	test("a re-rank that puts the best hit last fails the comparison, in the retriever alone and through the server's search code", async () => {
		const lexical = compareToBaseline((await runOffline(docs, () => 0, reversed)).score, baselines.lexical);
		expect(lexical.ok).toBe(false);
		expect(lexical.failures.join(" ")).toMatch(/MRR fell|recall@5 fell/);
		const server = compareToBaseline((await runServer(docs, () => 0, reversed)).score, baselines.server);
		expect(server.ok).toBe(false);
		expect(server.failures.join(" ")).toMatch(/MRR fell|recall@5 fell/);
	});

	test("a re-rank that drops the leading hit fails it too, on both paths", async () => {
		expect(compareToBaseline((await runOffline(docs, () => 0, (hits) => hits.slice(1))).score, baselines.lexical).ok).toBe(false);
		expect(compareToBaseline((await runServer(docs, () => 0, (hits) => hits.slice(1))).score, baselines.server).ok).toBe(false);
	});

	test("an identity re-rank changes nothing: the hook is a seam, not a behaviour", async () => {
		expect((await runOffline(docs, () => 0, (hits) => hits)).score).toEqual((await runOffline(docs, () => 0)).score);
		expect((await runServer(docs, () => 0, (hits) => hits)).score).toEqual((await runServer(docs, () => 0)).score);
	});

	test("the server path is the production search code: it answers the retriever's best hit first and never more than ten documents", async () => {
		const lexical = await runOffline(docs, () => 0);
		const server = await runServer(docs, () => 0);
		expect(server.score.queries).toBe(lexical.score.queries);
		for (const result of server.results) {
			expect(result.ranked.length).toBeLessThanOrEqual(10);
			expect(new Set(result.ranked).size).toBe(result.ranked.length);
		}
		expect(server.results.map((result) => result.ranked[0])).toEqual(lexical.results.map((result) => result.ranked[0]));
	});

	test("the shipped pipeline collapses every group of identical documents to its smallest key, on both paths", async () => {
		expect((await runOffline(docs, () => 0)).duplicateFailures).toEqual([]);
		expect((await runServer(docs, () => 0)).duplicateFailures).toEqual([]);
	});

	test("the golden set scores a hit on any copy of a page: it asks the archive copy's questions through the canonical one", async () => {
		const run = await runOffline(docs, () => 0);
		const asked = run.golden.filter((question) => question.expected === "acme/atlas:docs/backup-restore.md");
		expect(asked.length).toBeGreaterThan(0);
		for (const question of asked) expect(question.alsoExpected).toEqual(["acme/atlas:milestones/v1.1/docs/backup-restore.md"]);
	});

	test("a retriever that answers both copies of a page, or the wrong one, is reported", async () => {
		const copies: Array<{ repo: string; path: string; text: string }> = [
			{ repo: "r/a", path: "docs/x.md", text: "# Same page\n\nwords\n" },
			{ repo: "r/a", path: "milestones/docs/x.md", text: "# Same page\n\nwords\n" },
			{ repo: "r/a", path: "docs/y.md", text: "# Other page\n\nelse\n" },
		];
		expect(await duplicateCollapseFailures(copies, () => ["r/a:docs/x.md", "r/a:milestones/docs/x.md"])).toEqual([
			"r/a:docs/x.md = r/a:milestones/docs/x.md answered as r/a:docs/x.md, r/a:milestones/docs/x.md",
		]);
		expect(await duplicateCollapseFailures(copies, () => ["r/a:milestones/docs/x.md"])).toHaveLength(1);
		expect(await duplicateCollapseFailures(copies, () => ["r/a:docs/y.md"])).toEqual(["r/a:docs/x.md = r/a:milestones/docs/x.md answered as nothing"]);
		expect(await duplicateCollapseFailures(copies, async () => ["r/a:docs/x.md", "r/a:docs/y.md"])).toEqual([]);
	});
});

describe("compareToBaseline", () => {
	test("a fall of exactly the tolerance passes and a hair more fails, for recall at 5 and for MRR", () => {
		expect(compareToBaseline(scoreOf({ recall5: 0.95 - RECALL5_TOLERANCE, mrr: 0.9, queries: 100 }), BASE).ok).toBe(true);
		expect(compareToBaseline(scoreOf({ recall5: 0.95 - RECALL5_TOLERANCE - 0.001, mrr: 0.9 }), BASE).failures).toEqual([
			"recall@5 fell from 0.95 to 0.929 (allowed fall 0.02)",
		]);
		expect(compareToBaseline(scoreOf({ recall5: 0.95, mrr: 0.9 - MRR_TOLERANCE }), BASE).ok).toBe(true);
		expect(compareToBaseline(scoreOf({ recall5: 0.95, mrr: 0.9 - MRR_TOLERANCE - 0.001 }), BASE).failures).toEqual([
			"MRR fell from 0.9 to 0.869 (allowed fall 0.03)",
		]);
	});

	test("an improvement passes and says how to record it, an unchanged run says nothing", () => {
		const better = compareToBaseline(scoreOf({ recall5: 0.99, mrr: 0.95 }), BASE);
		expect(better.ok).toBe(true);
		expect(better.hints).toHaveLength(1);
		expect(better.hints[0]).toContain("--write-baseline");
		expect(compareToBaseline(scoreOf({ recall5: 0.95, mrr: 0.9, queries: 100 }), BASE)).toEqual({ ok: true, failures: [], hints: [] });
	});

	test("fewer questions than the baseline asked fails: a generator that loses questions must not read as a pass", () => {
		expect(compareToBaseline(scoreOf({ recall5: 0.95, mrr: 0.9, queries: 99 }), BASE).failures).toEqual(["the golden set shrank from 100 to 99 questions"]);
		expect(compareToBaseline(scoreOf({ recall5: 0.95, mrr: 0.9, queries: 120 }), BASE).hints).toHaveLength(1);
	});
});

describe("the failure path of main", () => {
	function baselineFile(contents: string): string {
		const root = tree({ "baseline.json": contents });
		return join(root, "baseline.json");
	}

	test("a doctored baseline that asks for more than the fixtures give exits 1, names the failure and which baseline it was", async () => {
		const high = { queries: 5000, recall1: 1, recall5: 1, recall10: 1, mrr: 1 };
		const fine = { queries: 1, recall1: 0, recall5: 0, recall10: 0, mrr: 0 };
		for (const [lexical, server, failing] of [
			[high, fine, "lexical"],
			[fine, high, "server"],
		] as const) {
			const run = capture({ baselinePath: baselineFile(JSON.stringify({ lexical, server })) });
			expect(await main([], run.io)).toBe(1);
			expect(run.out.filter((line) => line.startsWith("FAIL "))).toEqual([expect.stringMatching(new RegExp(`^FAIL ${failing}: the golden set shrank from 5000 to`))]);
			expect(run.out.at(-1)).toBe("docs eval: REGRESSION against the baseline");
		}
	});

	test("a missing or unreadable baseline exits 1 with the way to record one", async () => {
		for (const path of [join(tmpdir(), "substrate-docs-eval-no-such-baseline.json"), baselineFile("not json"), baselineFile(JSON.stringify({ queries: 1 })), baselineFile(JSON.stringify({ lexical: BASE }))]) {
			const run = capture({ baselinePath: path });
			expect(await main([], run.io)).toBe(1);
			expect(run.err.join("\n")).toContain("--write-baseline");
		}
	});

	test("--write-baseline records the run, and the next run against it passes", async () => {
		const path = baselineFile("{}");
		const write = capture({ baselinePath: path });
		expect(await main(["--write-baseline"], write.io)).toBe(0);
		const written = defined(parseBaselines(readFileSync(path, "utf8")), "written baseline");
		expect(written.lexical.queries).toBeGreaterThan(50);
		expect(written.server.queries).toBe(written.lexical.queries);
		const again = capture({ baselinePath: path });
		expect(await main([], again.io)).toBe(0);
	});
});

describe("parseBaselines and parseArgs", () => {
	const entry = '{"queries":3,"recall1":0.5,"recall5":1,"recall10":1,"mrr":0.75}';
	const parsedEntry = { queries: 3, recall1: 0.5, recall5: 1, recall10: 1, mrr: 0.75 };

	test("a baseline file needs a lexical and a server entry, each with a whole question count and four scores in [0, 1]", () => {
		expect(parseBaselines(`{"lexical":${entry},"server":${entry}}`)).toEqual({ lexical: parsedEntry, server: parsedEntry });
		const bad = '{"queries":1,"recall1":2,"recall5":0,"recall10":0,"mrr":0}';
		const short = '{"queries":1,"recall1":0,"recall5":0,"recall10":0}';
		const fractional = '{"queries":1.5,"recall1":0,"recall5":0,"recall10":0,"mrr":0}';
		for (const text of ["", "[]", "null", entry, `{"lexical":${entry}}`, `{"server":${entry}}`, `{"lexical":${entry},"server":${bad}}`, `{"lexical":${short},"server":${entry}}`, `{"lexical":${entry},"server":${fractional}}`]) {
			expect(parseBaselines(text)).toBeNull();
		}
	});

	test("the accepted command lines, and a usage line for the rest", () => {
		expect(parseArgs([])).toEqual({ mode: "offline", json: false, writeBaseline: false });
		expect(parseArgs(["--json"])).toEqual({ mode: "offline", json: true, writeBaseline: false });
		expect(parseArgs(["--write-baseline"])).toEqual({ mode: "offline", json: false, writeBaseline: true });
		expect(parseArgs(["--live", "http://127.0.0.1:7410"])).toEqual({ mode: "live", json: false, url: "http://127.0.0.1:7410" });
		expect(parseArgs(["--json", "--live", "https://substrate.example"])).toEqual({ mode: "live", json: true, url: "https://substrate.example" });
		for (const bad of [["--live"], ["--live", "ftp://x"], ["--live", "not a url"], ["--write-baseline", "--json"], ["--nope"], ["--live", "http://a", "extra"]]) {
			expect(parseArgs(bad)).toEqual({ error: USAGE });
		}
	});
});

describe("collectLocalDocuments", () => {
	test("reads every Markdown file under docs in path order with repository-relative paths, and nothing else", () => {
		const root = tree({
			"docs/b.md": "# B\n",
			"docs/a.md": "# A\n",
			"docs/runbooks/r.md": "# R\n",
			"docs/image.png": "x",
			"docs/notes.txt": "x",
			"README.md": "# outside docs\n",
		});
		const scan = collectLocalDocuments(root, "acme/atlas");
		expect(scan.docs.map((doc) => `${doc.repo}:${doc.path}`)).toEqual(["acme/atlas:docs/a.md", "acme/atlas:docs/b.md", "acme/atlas:docs/runbooks/r.md"]);
		expect(scan.incomplete).toEqual([]);
	});

	test("a bound that cut the walk is reported by name, and a walk within its bounds reports nothing", () => {
		const root = tree({ "docs/a.md": "# A\n", "docs/b.md": "# B\n", "docs/c.md": "# C\n", "docs/d1/d2/d3.md": "# D\n" });
		const files = collectLocalDocuments(root, "acme/atlas", "docs", { maxFiles: 2, maxDepth: 8 });
		expect(files.docs).toHaveLength(2);
		expect(files.incomplete).toEqual(["file-limit"]);
		const depth = collectLocalDocuments(root, "acme/atlas", "docs", { maxFiles: 10, maxDepth: 1 });
		expect(depth.docs.map((doc) => doc.path)).toEqual(["docs/a.md", "docs/b.md", "docs/c.md"]);
		expect(depth.incomplete).toEqual(["depth-limit"]);
		expect(collectLocalDocuments(root, "acme/atlas", "docs", { maxFiles: 4, maxDepth: 2 }).incomplete).toEqual([]);
	});
});

describe("the live tier", () => {
	const root = tree({
		"docs/alpha.md": "# Alpha backup drill\n\nWe restore nightly snapshots.\n",
		"docs/beta.md": "# Beta rate limits\n\nTokens refill every hundred milliseconds.\n",
	});
	const alpha = sourceUrl("acme/atlas", "docs/alpha.md");
	const beta = sourceUrl("acme/atlas", "docs/beta.md");
	const env = { SUBSTRATE_TOKEN: "test-bearer", SUBSTRATE_DOCS_EVAL_REPO: "acme/atlas" };

	test("without the bearer it exits 2 with the usage line and never opens a socket", async () => {
		const run = capture({ repoRoot: root });
		expect(await main(["--live", "http://127.0.0.1:7410"], run.io)).toBe(2);
		expect(run.err).toEqual([USAGE]);
		expect(run.requests).toEqual([]);
	});

	test("a server that finds every document passes with exit 0, and the bearer is never printed", async () => {
		const run = capture({ repoRoot: root, env }, (question) => Response.json({ chunks: [{ source_url: question.includes("Alpha") || question.includes("restore") ? alpha : beta }] }));
		expect(await main(["--live", "http://127.0.0.1:7410"], run.io)).toBe(0);
		expect(run.out.join("\n")).toContain("recall@5=1.000");
		expect(run.out.join("\n")).toContain("asked 4, answered 4, failed 0, degraded 0");
		expect(run.requests.length).toBe(4);
		expect(run.requests.every((request) => request.url === "http://127.0.0.1:7410/docs/search")).toBe(true);
		expect(`${run.out.join("\n")}${run.err.join("\n")}`).not.toContain("test-bearer");
	});

	test("a server that finds too little breaches the recall SLO with exit 1, and the threshold is the flag's", async () => {
		const wrong = capture({ repoRoot: root, env }, () => Response.json({ chunks: [{ source_url: alpha }] }));
		expect(await main(["--live", "http://127.0.0.1:7410"], wrong.io)).toBe(1);
		expect(wrong.out.some((line) => line.startsWith("FAIL recall@5 0.500 is under the SLO 0.6"))).toBe(true);
		const lenient = capture({ repoRoot: root, env: { ...env, SUBSTRATE_DOCS_SLO_RECALL5: "0.4" } }, () => Response.json({ chunks: [{ source_url: alpha }] }));
		expect(await main(["--live", "http://127.0.0.1:7410"], lenient.io)).toBe(0);
	});

	test("questions that failed or came back degraded make the exit 3, never a pass on the answered ones", async () => {
		const down = capture({ repoRoot: root, env }, () => new Response("no", { status: 503 }));
		expect(await main(["--live", "http://127.0.0.1:7410"], down.io)).toBe(3);
		expect(down.err.join("\n")).toContain("not every question could be scored");
		const degraded = capture({ repoRoot: root, env }, () => Response.json({ chunks: [], degraded: true }));
		expect(await main(["--live", "http://127.0.0.1:7410", "--json"], degraded.io)).toBe(3);
		expect(JSON.parse(defined(degraded.out[0]))).toMatchObject({ mode: "live", degraded: 4, answered: 0 });
	});

	test("reportLive is 1 for a breach and 0 for a pass when every question was answered", () => {
		const results: QueryResult[] = [{ query: "q", expected: "a:b.md", ranked: ["a:b.md"], latencyMs: 1 }];
		const quiet = { env: {}, stdout: () => undefined, stderr: () => undefined };
		expect(reportLive(1, { results, failed: 0, degraded: 0, aborted: null, skippedUnsafe: 0 }, true, quiet)).toBe(0);
		const miss: QueryResult[] = [{ query: "q", expected: "a:b.md", ranked: [], latencyMs: 1 }];
		expect(reportLive(1, { results: miss, failed: 0, degraded: 0, aborted: null, skippedUnsafe: 0 }, true, quiet)).toBe(1);
		expect(scoreRun(miss).recall5).toBe(0);
	});

	describe("a question that looks like it carries a credential", () => {
		// Assembled at run time so no credential-shaped literal sits in the source.
		const KEY = ["sk", "proj", "x".repeat(40)].join("-");
		const keys = sourceUrl("acme/atlas", "docs/keys.md");
		const answerKeys = (): Response => Response.json({ chunks: [{ source_url: keys }] });
		const sentOf = (run: Capture): unknown[] => run.requests.map((request) => (isRecord(request.body) ? request.body.question : null));

		test("is not sent by --live, the others are, and both outputs say how many were held back", async () => {
			const leaky = tree({ "docs/keys.md": `# Secret handling guide\n\nOur key is ${KEY} for the service.\n` });
			const human = capture({ repoRoot: leaky, env }, answerKeys);
			expect(await main(["--live", "http://127.0.0.1:7410"], human.io)).toBe(0);
			expect(sentOf(human)).toEqual(["Secret handling guide"]);
			expect(human.out.join("\n")).toContain("1 question was not sent: it looks like it contains a credential (the same check ingest applies)");
			expect(`${human.out.join("\n")}${human.err.join("\n")}${JSON.stringify(human.requests)}`).not.toContain(KEY);
			const json = capture({ repoRoot: leaky, env }, answerKeys);
			await main(["--live", "http://127.0.0.1:7410", "--json"], json.io);
			expect(JSON.parse(defined(json.out[0]))).toMatchObject({ asked: 2, answered: 1, failed: 0, skippedUnsafe: 1 });
		});

		test("when every question is held back nothing is sent and the run is unscored: exit 3, never a pass", async () => {
			const allLeaky = tree({ "docs/keys.md": `# Key ${KEY} here\n` });
			const run = capture({ repoRoot: allLeaky, env }, answerKeys);
			expect(await main(["--live", "http://127.0.0.1:7410"], run.io)).toBe(3);
			expect(run.requests).toEqual([]);
			expect(`${run.out.join("\n")}${run.err.join("\n")}`).not.toContain(KEY);
		});

		test("the canary sends nothing for it, says so on stderr, and reports nothing when none could be asked", async () => {
			const leaky = tree({ "docs/keys.md": `# Secret handling guide\n\nOur key is ${KEY} for the service.\n` });
			const some = capture({ repoRoot: leaky, env }, answerKeys);
			expect(await measureGoldenRecall("http://127.0.0.1:7410", "test-bearer", some.io)).toMatchObject({ recall5: 1 });
			expect(sentOf(some)).toEqual(["Secret handling guide"]);
			expect(some.err.join("\n")).toContain("docs canary: 1 question was not sent");
			const allLeaky = tree({ "docs/keys.md": `# Key ${KEY} here\n` });
			const none = capture({ repoRoot: allLeaky, env }, answerKeys);
			expect(await measureGoldenRecall("http://127.0.0.1:7410", "test-bearer", none.io)).toBeNull();
			expect(none.requests).toEqual([]);
		});
	});

	test("a scan of docs/ that a bound cut is partial: the canary measures nothing and says why, and the script labels the verdict", async () => {
		const deep = tree({
			"docs/alpha.md": "# Alpha backup drill\n\nWe restore nightly snapshots.\n",
			"docs/a/b/c/d/e/f/g/h/i/too-deep.md": "# Too deep to be read\n",
		});
		const answered = capture({ repoRoot: deep, env }, () => Response.json({ chunks: [{ source_url: alpha }] }));
		expect(await measureGoldenRecall("http://127.0.0.1:7410", "test-bearer", answered.io)).toBeNull();
		expect(answered.err.join("\n")).toContain("the scan of docs/ was partial (depth-limit)");

		const whole = capture({ repoRoot: root, env }, () => Response.json({ chunks: [{ source_url: alpha }] }));
		expect(await measureGoldenRecall("http://127.0.0.1:7410", "test-bearer", whole.io)).toMatchObject({ asked: 4 });
		expect(whole.err).toEqual([]);

		const passing = capture({ repoRoot: deep, env: { ...env, SUBSTRATE_DOCS_SLO_RECALL5: "0.4" } }, () => Response.json({ chunks: [{ source_url: alpha }] }));
		expect(await main(["--live", "http://127.0.0.1:7410"], passing.io)).toBe(0);
		expect(passing.out.some((line) => line.startsWith("PARTIAL recall@5"))).toBe(true);
		expect(passing.err.join("\n")).toContain("the scan of docs/ was partial (depth-limit)");
		const asJson = capture({ repoRoot: deep, env: { ...env, SUBSTRATE_DOCS_SLO_RECALL5: "0.4" } }, () => Response.json({ chunks: [{ source_url: alpha }] }));
		await main(["--live", "http://127.0.0.1:7410", "--json"], asJson.io);
		expect(JSON.parse(defined(asJson.out[0]))).toMatchObject({ partial: true, incomplete: ["depth-limit"] });
		const full = capture({ repoRoot: root, env: { ...env, SUBSTRATE_DOCS_SLO_RECALL5: "0.4" } }, () => Response.json({ chunks: [{ source_url: alpha }] }));
		await main(["--live", "http://127.0.0.1:7410", "--json"], full.io);
		expect(JSON.parse(defined(full.out[0]))).toMatchObject({ partial: false, incomplete: [] });
	});
});
