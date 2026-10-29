import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_PROTOCOL, isRecord, type GhRunner, type GitRunner, type IngestStatus, type PlanItem } from "@substrate/corpus";
import { defined, fakeGit, tempDir, writeTree } from "../../../corpus/src/test-support.ts";
import { runCorpus, USAGE } from "./index.ts";
import { CorpusStub, fakeGhOwner, ingestOf, planOf, statusOf, type Reply, type Seen } from "./testkit.ts";

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

const HEAD = "e".repeat(40);

function rec(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} is not an object`);
	return value;
}

function list(value: unknown, label: string): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error(`${label} is not a list`);
	return value.map((item) => rec(item, label));
}

interface Fixture {
	root: string;
	alpha: string;
	beta: string;
	runner: GitRunner;
}

/** Two checkouts under one root: Acme/Alpha with two documents and Acme/Beta with one. */
function fixture(options: { betaLsFails?: boolean; owner?: string } = {}): Fixture {
	const root = tempDir("corpus-cli-");
	dirs.push(root);
	writeTree(root, {
		"alpha/.git/HEAD": "",
		"alpha/README.md": "# alpha\n",
		"alpha/docs/guide.md": "guide\n",
		"beta/.git/HEAD": "",
		"beta/README.md": "# beta\n",
	});
	const alpha = join(root, "alpha");
	const beta = join(root, "beta");
	const owner = options.owner ?? "Acme";
	const base = { branch: "main", remoteDefault: "main", head: HEAD };
	const runner = fakeGit({
		[alpha]: { ...base, origin: `git@github.com:${owner}/Alpha.git`, files: ["README.md", "docs/guide.md"] },
		[beta]: { ...base, origin: `git@github.com:${owner}/Beta.git`, files: ["README.md"], ...(options.betaLsFails === true ? { lsFilesFails: true } : {}) },
	});
	return { root, alpha, beta, runner };
}

interface RunOptions {
	env?: Record<string, string | undefined>;
	runner?: GitRunner;
	gh?: GhRunner;
	readFile?: (path: string) => Uint8Array;
}

async function run(argv: string[], options: RunOptions = {}): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCorpus(argv, {
		url: stub.url,
		token: "tok-1",
		timeoutMs: 2000,
		env: options.env ?? {},
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		runner: options.runner,
		gh: options.gh,
		readFile: options.readFile,
	});
	return { code, out: out.join(""), err: err.join("") };
}

function addsFor(body: unknown): PlanItem[] {
	return list(rec(body, "request").entries, "entries").map((entry) => ({
		action: "add" as const,
		repo: String(entry.repo),
		path: String(entry.path),
		sha256: String(entry.sha256),
	}));
}

function planAllAdd(): void {
	stub.on("POST /corpus/plan", (seen) => ({ status: 200, body: planOf(addsFor(seen.body)) }));
}

function ingestParts(seen: Seen): { documents: Record<string, unknown>[]; tombstones: Record<string, unknown>[] } {
	const request = rec(seen.body, "ingest request");
	return { documents: list(request.documents, "documents"), tombstones: list(request.tombstones, "tombstones") };
}

/** Answers an ingest request: every document and tombstone gets `status`, except those `failing` names. */
function answerIngest(failing: (repo: string, path: string) => boolean = () => false, failure: { status: IngestStatus; reason: string } = { status: "failed", reason: "plane-unavailable" }) {
	return (seen: Seen): Reply => {
		const { documents, tombstones } = ingestParts(seen);
		const row = (item: Record<string, unknown>, ok: IngestStatus) => {
			const repo = String(item.repo);
			const path = String(item.path);
			return failing(repo, path) ? { repo, path, status: failure.status, reason: failure.reason } : { repo, path, status: ok };
		};
		return { status: 200, body: ingestOf([...documents.map((d) => row(d, "ingested")), ...tombstones.map((t) => row(t, "tombstoned"))]) };
	};
}

async function planScope(argv: string[], options: RunOptions): Promise<Record<string, unknown>> {
	planAllAdd();
	const result = await run(["plan", ...argv], options);
	expect(result.code).toBe(0);
	const sent = defined(stub.requests("/corpus/plan").at(-1), "plan request");
	return rec(rec(sent.body, "request").scope, "scope");
}

describe("substrate corpus scan", () => {
	test("prints the inventory without contacting a server", async () => {
		const { root, runner } = fixture();
		const result = await run(["scan", "--root", root], { runner });
		expect(result.code).toBe(0);
		expect(result.out).toContain("3 documents");
		expect(result.out).toContain("2 repositories");
		expect(result.out).toContain("by tier: 1: 3");
		expect(result.out).toContain("Acme/Alpha  2 files");
		expect(stub.seen).toEqual([]);
	});

	test("--json prints the report, with the entries only when --entries is given", async () => {
		const { root, runner } = fixture();
		const plain = rec(JSON.parse((await run(["scan", "--root", root, "--json"], { runner })).out), "output");
		expect("entries" in plain).toBe(false);
		const report = rec(plain.report, "report");
		expect(rec(report.totals, "totals").files).toBe(3);
		expect(rec(report.scope, "scope").repos).toEqual(["Acme/Alpha", "Acme/Beta"]);
		const full = rec(JSON.parse((await run(["scan", "--root", root, "--json", "--entries"], { runner })).out), "output");
		expect(list(full.entries, "entries").map((e) => `${e.repo}:${e.path}`)).toEqual(["Acme/Alpha:README.md", "Acme/Alpha:docs/guide.md", "Acme/Beta:README.md"]);
	});

	test("default roots come from SUBSTRATE_CORPUS_ROOTS, and --root replaces them", async () => {
		const a = fixture();
		const b = fixture({ owner: "Other" });
		const runner: GitRunner = (args, cwd) => (cwd.startsWith(a.root) ? a.runner(args, cwd) : b.runner(args, cwd));
		const env = { SUBSTRATE_CORPUS_ROOTS: `${a.root}:${b.root}` };
		const both = rec(rec(JSON.parse((await run(["scan", "--json"], { env, runner })).out), "o").report, "r");
		expect(list(both.repos, "repos").map((r) => r.repo)).toEqual(["Acme/Alpha", "Acme/Beta", "Other/Alpha", "Other/Beta"]);
		const only = rec(rec(JSON.parse((await run(["scan", "--json", "--root", a.root], { env, runner })).out), "o").report, "r");
		expect(list(only.repos, "repos").map((r) => r.dir)).toEqual([a.alpha, a.beta]);
	});

	test("the usage errors exit 2 before anything is read or sent", async () => {
		const { root, runner } = fixture();
		const cases: string[][] = [
			["scan", "--tier", "4"],
			["scan", "--tier"],
			["scan", "--max-bytes", "0"],
			["scan", "--max-repos", "x"],
			["scan", "--source", "ftp"],
			["scan", "--source", "github"],
			["scan", "--source", "greptile"],
			["scan", "--bogus"],
			["scan", "stray"],
			["scan", "--json=1"],
			["plan", "--entries"],
			["ingest", "--batch-docs", "0"],
			["ingest", "--batch-bytes", "-5"],
			["frobnicate"],
			[],
		];
		for (const argv of cases) {
			const result = await run(argv.length > 0 && argv[0] !== "frobnicate" ? [...argv, "--root", root] : argv, { runner });
			expect({ argv, code: result.code }).toEqual({ argv, code: 2 });
		}
		expect(stub.seen).toEqual([]);
	});

	test("--help prints the usage and exits 0", async () => {
		const result = await run(["--help"]);
		expect(result.code).toBe(0);
		expect(result.out).toBe(USAGE);
		expect((await run(["scan", "--help"])).out).toBe(USAGE);
	});
});

describe("substrate corpus plan", () => {
	test("sends the entries without bodies, the scope the scan read completely, and prints the counts", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		const result = await run(["plan", "--root", root], { runner });
		expect(result.code).toBe(0);
		const sent = defined(stub.requests("/corpus/plan")[0], "request");
		expect(sent.authorization).toBe("Bearer tok-1");
		const body = rec(sent.body, "request");
		expect(body.protocol).toBe(CORPUS_PROTOCOL);
		const entries = list(body.entries, "entries");
		expect(entries).toHaveLength(3);
		for (const entry of entries) {
			expect(Object.keys(entry).sort()).toEqual(["bytes", "commit", "kind", "path", "repo", "sha256", "source", "tier"]);
		}
		expect(body.scope).toEqual({ repos: ["Acme/Alpha", "Acme/Beta"], maxTier: 2, sources: ["fs"] });
		expect(result.out).toContain("plan: add 3, change 0, rename 0, tombstone 0, unchanged 0");
		expect(result.out).toContain("add (3):");
		expect(stub.seen).toHaveLength(1);
	});

	test("lists the first 20 items of an action and says how many were left out", async () => {
		const { root, runner } = fixture();
		const items: PlanItem[] = Array.from({ length: 25 }, (_, i) => ({ action: "add", repo: "Acme/Alpha", path: `docs/p${String(i).padStart(2, "0")}.md` }));
		stub.on("POST /corpus/plan", () => ({ status: 200, body: planOf(items) }));
		const result = await run(["plan", "--root", root], { runner });
		expect(result.out.split("\n").filter((line) => line.startsWith("  Acme/Alpha:docs/p"))).toHaveLength(20);
		expect(result.out).toContain("... and 5 more");
		expect(result.out).toContain("add (25):");
	});

	test("--json prints the server's plan", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		const result = await run(["plan", "--root", root, "--json"], { runner });
		expect(rec(JSON.parse(result.out), "plan").manifestVersion).toBe(7);
	});

	test("--server overrides the configured URL", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		const result = await run(["plan", "--root", root, "--server", `${stub.url}/`], { runner });
		expect(result.code).toBe(0);
		expect(stub.requests("/corpus/plan")).toHaveLength(1);
	});

	describe("the scope never covers what the scan did not read", () => {
		test("a tier-1 scan declares tier 1, so documents ingested at tier 2 are not judged", async () => {
			const { root, runner } = fixture();
			const scope = await planScope(["--root", root, "--tier", "1"], { runner });
			expect(scope.maxTier).toBe(1);
		});

		test("a repository that failed to read is left out of the scope", async () => {
			const { root, runner } = fixture({ betaLsFails: true });
			const scope = await planScope(["--root", root], { runner });
			expect(scope.repos).toEqual(["Acme/Alpha"]);
			const sent = rec(defined(stub.requests("/corpus/plan")[0], "request").body, "request");
			expect(list(sent.entries, "entries").every((e) => e.repo === "Acme/Alpha")).toBe(true);
		});

		test("one source only declares only that source and its own repositories", async () => {
			const exportDir = tempDir("greptile-");
			dirs.push(exportDir);
			writeTree(exportDir, { "Acme/Gamma/architecture.md": "# gamma\n" });
			const { runner } = fixture();
			const scope = await planScope(["--source", "greptile", "--greptile-dir", exportDir], { runner });
			expect(scope).toEqual({ repos: ["Acme/Gamma"], maxTier: 2, sources: ["greptile"] });
		});

		test("--max-repos leaves the repositories it cut out of the scope", async () => {
			const gh = fakeGhOwner({ "Acme/One": { files: { "README.md": "one\n" } }, "Acme/Two": { files: { "README.md": "two\n" } } });
			const scope = await planScope(["--source", "github", "--github-owner", "Acme", "--max-repos", "1"], { gh });
			expect(scope).toEqual({ repos: ["Acme/One"], maxTier: 2, sources: ["github"] });
		});

		test("a truncated GitHub tree leaves its repository out, while local clones stay in and are not read twice", async () => {
			const { root, runner } = fixture();
			const gh = fakeGhOwner({
				"Acme/Alpha": { files: { "README.md": "api copy\n" } },
				"Acme/Zed": { files: { "README.md": "zed\n" }, truncated: true },
			});
			const scope = await planScope(["--root", root, "--source", "fs,github", "--github-owner", "Acme"], { runner, gh });
			expect(scope).toEqual({ repos: ["Acme/Alpha", "Acme/Beta"], maxTier: 2, sources: ["fs", "github"] });
			const sent = rec(defined(stub.requests("/corpus/plan")[0], "request").body, "request");
			const sources = list(sent.entries, "entries").map((e) => `${e.repo}:${e.source}`);
			expect(sources).toContain("Acme/Alpha:fs");
			expect(sources).not.toContain("Acme/Alpha:github");
			expect(sources).toContain("Acme/Zed:github");
		});
	});

	test("a failed request exits 1 with the reason, never a stack", async () => {
		const { root, runner } = fixture();
		stub.on("POST /corpus/plan", () => ({ status: 401, body: {} }));
		const denied = await run(["plan", "--root", root], { runner });
		expect(denied.code).toBe(1);
		expect(denied.err).toContain("401");
		stub.on("POST /corpus/plan", () => ({ status: 503, body: { error: "corpus.disabled" } }));
		const off = await run(["plan", "--root", root], { runner });
		expect(off.code).toBe(1);
		expect(off.err).toContain("corpus off");
	});
});

describe("substrate corpus ingest", () => {
	test("without --execute it prints the plan, says it is a dry run and sends nothing but the plan", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		stub.on("POST /corpus/ingest", () => ({ status: 200, body: ingestOf([]) }));
		const result = await run(["ingest", "--root", root], { runner });
		expect(result.code).toBe(0);
		expect(result.out).toContain("add 3");
		expect(result.out).toContain("dry run");
		expect(stub.requests("/corpus/ingest")).toEqual([]);
		expect(stub.requests("/corpus/plan")).toHaveLength(1);
	});

	test("--execute sends each document's text in batches bounded by --batch-docs", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		stub.on("POST /corpus/ingest", answerIngest());
		const result = await run(["ingest", "--root", root, "--execute", "--batch-docs", "2"], { runner });
		expect(result.code).toBe(0);
		const requests = stub.requests("/corpus/ingest").map((seen) => ingestParts(seen));
		expect(requests.map((r) => r.documents.length)).toEqual([2, 1]);
		expect(requests.every((r) => r.tombstones.length === 0)).toBe(true);
		const bodies = Object.fromEntries(requests.flatMap((r) => r.documents).map((d) => [`${d.repo}:${d.path}`, d.body]));
		expect(bodies).toEqual({ "Acme/Alpha:README.md": "# alpha\n", "Acme/Alpha:docs/guide.md": "guide\n", "Acme/Beta:README.md": "# beta\n" });
		expect(result.out).toContain("ingest: ingested 3, unchanged 0, tombstoned 0, refused 0, failed 0");
	});

	test("--batch-bytes closes a batch before it passes the byte bound, and a flag beats the environment", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		stub.on("POST /corpus/ingest", answerIngest());
		await run(["ingest", "--root", root, "--execute", "--batch-bytes", "10"], { runner });
		expect(stub.requests("/corpus/ingest").map((s) => ingestParts(s).documents.length)).toEqual([1, 1, 1]);
		stub.seen = [];
		await run(["ingest", "--root", root, "--execute"], { runner, env: { SUBSTRATE_CORPUS_BATCH_DOCS: "1" } });
		expect(stub.requests("/corpus/ingest")).toHaveLength(3);
		stub.seen = [];
		await run(["ingest", "--root", root, "--execute", "--batch-docs", "3"], { runner, env: { SUBSTRATE_CORPUS_BATCH_DOCS: "1" } });
		expect(stub.requests("/corpus/ingest")).toHaveLength(1);
	});

	test("a failed document makes the exit code 1 and is listed with its reason, while a refusal is reported without failing the run", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		stub.on("POST /corpus/ingest", answerIngest((repo) => repo === "Acme/Beta"));
		const failed = await run(["ingest", "--root", root, "--execute"], { runner });
		expect(failed.code).toBe(1);
		expect(failed.out).toContain("failed (1):");
		expect(failed.out).toContain("Acme/Beta:README.md  [plane-unavailable]");
		stub.on("POST /corpus/ingest", answerIngest((repo) => repo === "Acme/Beta", { status: "refused", reason: "secret-findings" }));
		const refused = await run(["ingest", "--root", root, "--execute"], { runner });
		expect(refused.code).toBe(0);
		expect(refused.out).toContain("refused (1):");
		expect(refused.out).toContain("[secret-findings]");
	});

	test("tombstones go last, and a rename's old row is removed only when the new document was recorded", async () => {
		const { root, runner } = fixture();
		const items: PlanItem[] = [
			{ action: "rename", repo: "Acme/Alpha", path: "docs/guide.md", sha256: "a".repeat(64), renamedFrom: "docs/old-guide.md" },
			{ action: "tombstone", repo: "Acme/Alpha", path: "old/gone.md" },
		];
		stub.on("POST /corpus/plan", () => ({ status: 200, body: planOf(items) }));
		stub.on("POST /corpus/ingest", answerIngest());
		const good = await run(["ingest", "--root", root, "--execute"], { runner });
		expect(good.code).toBe(0);
		const sent = stub.requests("/corpus/ingest").map((s) => ingestParts(s));
		expect(sent).toHaveLength(2);
		expect(defined(sent[0], "batch").documents.map((d) => d.path)).toEqual(["docs/guide.md"]);
		const last = defined(sent[1], "tombstone request");
		expect(last.documents).toEqual([]);
		expect(last.tombstones).toEqual([
			{ repo: "Acme/Alpha", path: "docs/old-guide.md" },
			{ repo: "Acme/Alpha", path: "old/gone.md" },
		]);
		expect(good.out).toContain("tombstoned 2");

		stub.seen = [];
		stub.on("POST /corpus/ingest", answerIngest((_repo, path) => path === "docs/guide.md"));
		const bad = await run(["ingest", "--root", root, "--execute"], { runner });
		expect(bad.code).toBe(1);
		const afterFailure = stub.requests("/corpus/ingest").map((s) => ingestParts(s));
		expect(defined(afterFailure[1], "tombstone request").tombstones).toEqual([{ repo: "Acme/Alpha", path: "old/gone.md" }]);
	});

	test("a file that changed after the scan is not sent, because its hash is no longer the planned one", async () => {
		const { root, alpha, runner } = fixture();
		planAllAdd();
		stub.on("POST /corpus/ingest", answerIngest());
		const seenReads = new Map<string, number>();
		const readFile = (path: string): Uint8Array => {
			const count = (seenReads.get(path) ?? 0) + 1;
			seenReads.set(path, count);
			return path === join(alpha, "README.md") && count > 1 ? new TextEncoder().encode("rewritten\n") : readFileSync(path);
		};
		const result = await run(["ingest", "--root", root, "--execute"], { runner, readFile });
		expect(result.code).toBe(1);
		expect(result.out).toContain("Acme/Alpha:README.md  [changed-since-scan]");
		const sentPaths = stub.requests("/corpus/ingest").flatMap((s) => ingestParts(s).documents.map((d) => `${d.repo}:${d.path}`));
		expect(sentPaths).not.toContain("Acme/Alpha:README.md");
		expect(sentPaths).toHaveLength(2);
	});

	test("GitHub documents are sent from the bodies fetched during the scan", async () => {
		const gh = fakeGhOwner({ "Acme/Zed": { files: { "README.md": "zed readme\n" } } });
		planAllAdd();
		stub.on("POST /corpus/ingest", answerIngest());
		const result = await run(["ingest", "--source", "github", "--github-owner", "Acme", "--execute"], { gh });
		expect(result.code).toBe(0);
		const documents = stub.requests("/corpus/ingest").flatMap((s) => ingestParts(s).documents);
		expect(documents).toHaveLength(1);
		expect(documents[0]).toMatchObject({ repo: "Acme/Zed", path: "README.md", source: "github", body: "zed readme\n" });
	});

	test("a request that fails as a whole stops the run, and the documents in it are failed", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		stub.on("POST /corpus/ingest", () => ({ status: 503, body: { error: "corpus.disabled" } }));
		const result = await run(["ingest", "--root", root, "--execute", "--batch-docs", "1"], { runner });
		expect(result.code).toBe(1);
		expect(stub.requests("/corpus/ingest")).toHaveLength(1);
		expect(result.err).toContain("corpus off");
		expect(result.out).toContain("[request-disabled]");
	});

	test("a plan with nothing to do sends no ingest request", async () => {
		const { root, runner } = fixture();
		stub.on("POST /corpus/plan", () => ({ status: 200, body: planOf([], 3) }));
		const result = await run(["ingest", "--root", root, "--execute"], { runner });
		expect(result.code).toBe(0);
		expect(stub.requests("/corpus/ingest")).toEqual([]);
		expect(result.out).toContain("ingest: ingested 0, unchanged 0, tombstoned 0, refused 0, failed 0");
	});
});

describe("substrate corpus status", () => {
	test("prints the manifest summary, and --json the raw answer", async () => {
		stub.on("GET /corpus/status", () => ({ status: 200, body: statusOf() }));
		const text = await run(["status"]);
		expect(text.code).toBe(0);
		expect(text.out).toContain("corpus: 5 rows, 4 active, 1 tombstoned");
		expect(text.out).toContain("last ingest: 2026-10-29T10:00:00.000Z");
		expect(text.out).toContain("Acme/Alpha  4 active  1 tombstoned");
		expect(rec(JSON.parse((await run(["status", "--json"])).out), "status").total).toBe(5);
	});

	test("a server that refuses exits 1", async () => {
		stub.on("GET /corpus/status", () => ({ status: 403, body: {} }));
		const result = await run(["status"]);
		expect(result.code).toBe(1);
		expect(result.err).toContain("403");
	});
});
