/**
 * `substrate corpus eval` through `runCorpus`: a real working tree scanned with a fake git, and a loopback stub standing in for
 * the server's `POST /docs/search`. The exit code is what a timer reads, so each of its values has a test.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { isRecord, sourceUrl, type GitRunner } from "@substrate/corpus";
import { fakeGit, tempDir, writeTree } from "../../../corpus/src/test-support.ts";
import { runCorpus, USAGE } from "./index.ts";
import { CorpusStub, type Reply, type Seen } from "./testkit.ts";

const stub = new CorpusStub();
const dirs: string[] = [];
afterAll(() => stub.stop());
beforeEach(() => {
	stub.seen = [];
	stub.routes.clear();
});
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GUIDE = sourceUrl("Acme/Alpha", "docs/guide.md");
const README = sourceUrl("Acme/Alpha", "README.md");

function tree(): { root: string; runner: GitRunner } {
	const root = tempDir("corpus-eval-");
	dirs.push(root);
	writeTree(root, {
		"alpha/.git/HEAD": "",
		"alpha/README.md": "# Alpha project overview\n\nAlpha is a sample project for tests.\n",
		"alpha/docs/guide.md": "# Backup restore drill guide\n\nWe restore nightly snapshots.\n",
	});
	const runner = fakeGit({
		[join(root, "alpha")]: { branch: "main", remoteDefault: "main", head: "e".repeat(40), origin: "git@github.com:Acme/Alpha.git", files: ["README.md", "docs/guide.md"] },
	});
	return { root, runner };
}

async function run(argv: string[], options: { env?: Record<string, string | undefined>; token?: string | undefined; runner: GitRunner }): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCorpus(argv, {
		url: stub.url,
		token: "token" in options ? options.token : "tok-1",
		timeoutMs: 2000,
		env: options.env ?? {},
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		runner: options.runner,
	});
	return { code, out: out.join(""), err: err.join("") };
}

function questionOf(seen: Seen): string {
	return isRecord(seen.body) ? String(seen.body.question) : "";
}

/** The guide when the question is about it, the README otherwise: a search that works. */
function goodSearch(seen: Seen): Reply {
	const question = questionOf(seen);
	return { status: 200, body: { chunks: [{ source_url: question.includes("estore") || question.includes("Backup") ? GUIDE : README }] } };
}

describe("substrate corpus eval", () => {
	test("is in the usage text, and an unknown flag for it is a usage error", async () => {
		expect(USAGE).toContain("substrate corpus eval");
		const { root, runner } = tree();
		const bad = await run(["eval", "--root", root, "--source", "github"], { runner });
		expect(bad.code).toBe(2);
		expect(bad.err).toContain("unknown flag --source");
	});

	test("without --server it counts the questions from the scan, asks nothing and exits 0", async () => {
		const { root, runner } = tree();
		const result = await run(["eval", "--root", root], { runner });
		expect(result).toMatchObject({ code: 0, err: "" });
		expect(result.out).toBe("documents read: 2\nquestions it would ask: 4 (add --server URL to ask them)\n");
		expect(stub.seen).toEqual([]);
		const json = await run(["eval", "--root", root, "--json"], { runner });
		expect(JSON.parse(json.out)).toMatchObject({ mode: "dry-run", documents: 2, questions: 4 });
	});

	test("with --server it asks POST /docs/search as the token and exits 0 when the objective holds", async () => {
		stub.on("POST /docs/search", goodSearch);
		const { root, runner } = tree();
		const result = await run(["eval", "--root", root, "--server", stub.url], { runner });
		expect(result.code).toBe(0);
		expect(result.out).toContain("questions: 4, answered 4, failed 0, degraded 0");
		expect(result.out).toContain("recall@5 holds the objective 0.6");
		expect(stub.seen).toHaveLength(4);
		expect(stub.seen.every((seen) => seen.path === "/docs/search" && seen.authorization === "Bearer tok-1")).toBe(true);
		expect(`${result.out}${result.err}`).not.toContain("tok-1");
	});

	test("exits 1 when recall at 5 is under the objective, and the flag moves the objective", async () => {
		stub.on("POST /docs/search", () => ({ status: 200, body: { chunks: [{ source_url: README }] } }));
		const { root, runner } = tree();
		const breach = await run(["eval", "--root", root, "--server", stub.url], { runner });
		expect(breach.code).toBe(1);
		expect(breach.out).toContain("FAIL recall@5 0.500 is under the objective 0.6");
		const lenient = await run(["eval", "--root", root, "--server", stub.url], { runner, env: { SUBSTRATE_DOCS_SLO_RECALL5: "0.4" } });
		expect(lenient.code).toBe(0);
	});

	test("a server that cannot answer exits 1 with the failures on stderr, never a pass", async () => {
		stub.on("POST /docs/search", () => ({ status: 503, body: { error: "down" } }));
		const { root, runner } = tree();
		const result = await run(["eval", "--root", root, "--server", stub.url], { runner });
		expect(result.code).toBe(1);
		expect(result.err).toContain("question(s) failed");
	});

	test("--server needs a token and an http(s) URL: both are usage errors that ask nothing", async () => {
		const { root, runner } = tree();
		const noToken = await run(["eval", "--root", root, "--server", stub.url], { runner, token: undefined });
		expect(noToken.code).toBe(2);
		expect(noToken.err).toContain("needs a token");
		const badUrl = await run(["eval", "--root", root, "--server", "ftp://nowhere"], { runner });
		expect(badUrl.code).toBe(2);
		expect(badUrl.err).toContain("http(s) URL");
		expect(stub.seen).toEqual([]);
	});

	test("--max-queries caps the questions asked, and a number that is not positive is a usage error", async () => {
		stub.on("POST /docs/search", goodSearch);
		const { root, runner } = tree();
		const capped = await run(["eval", "--root", root, "--server", stub.url, "--max-queries", "2"], { runner });
		expect(capped.out).toContain("questions: 2, answered 2");
		expect(stub.seen).toHaveLength(2);
		for (const value of ["0", "-1", "many"]) {
			const bad = await run(["eval", "--root", root, "--max-queries", value], { runner });
			expect(bad.code).toBe(2);
		}
		const high = await run(["eval", "--root", root, "--max-queries", "999999"], { runner });
		expect(high.code).toBe(0);
		expect(high.err).toContain("above the limit; asking 500");
	});
});
