import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_PROTOCOL, EMBEDDING_REASONS, isRecord, isValidRepo, localRepoId, MAX_INGEST_DOCUMENTS, MAX_INGEST_TOMBSTONES, type GhRunner, type GitRunner, type IngestStatus, type PlanItem } from "@substrate/corpus";
import { defined, fakeGit, tempDir, writeTree } from "../../../corpus/src/test-support.ts";
import { runCorpus, USAGE } from "./index.ts";
import { CorpusStub, fakeGhOwner, ingestOf, neardupOf, planOf, statusOf, type Reply, type Seen } from "./testkit.ts";

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
		expect(rec(report.scope, "scope").coverage).toEqual([
			{ repo: "Acme/Alpha", source: "fs" },
			{ repo: "Acme/Beta", source: "fs" },
		]);
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
	test("sends the entries without bodies, the coverage the scan read completely, and prints the counts", async () => {
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
		expect(body.scope).toEqual({
			coverage: [
				{ repo: "Acme/Alpha", source: "fs" },
				{ repo: "Acme/Beta", source: "fs" },
			],
			maxTier: 2,
		});
		expect(result.out).toContain("plan: add 3, change 0, update 0, rename 0, tombstone 0, unchanged 0");
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

	describe("the coverage never includes what the scan did not read", () => {
		test("a tier-1 scan declares tier 1, so documents ingested at tier 2 are not judged", async () => {
			const { root, runner } = fixture();
			const scope = await planScope(["--root", root, "--tier", "1"], { runner });
			expect(scope.maxTier).toBe(1);
		});

		test("a repository that failed to read is left out of the coverage", async () => {
			const { root, runner } = fixture({ betaLsFails: true });
			const scope = await planScope(["--root", root], { runner });
			expect(scope.coverage).toEqual([{ repo: "Acme/Alpha", source: "fs" }]);
			const sent = rec(defined(stub.requests("/corpus/plan")[0], "request").body, "request");
			expect(list(sent.entries, "entries").every((e) => e.repo === "Acme/Alpha")).toBe(true);
		});

		test("an empty folder whose name is not a valid label is covered under a safe label and does not block the valid repository", async () => {
			const { root, runner } = fixture();
			writeTree(root, { "backup:2026/.keep": "" });
			const scope = await planScope(["--root", root], { runner });
			const labels = list(scope.coverage, "coverage").map((pair) => String(pair.repo));
			expect(labels).toEqual(["Acme/Alpha", "Acme/Beta", localRepoId("backup:2026")]);
			for (const label of labels) expect({ label, valid: isValidRepo(label) }).toEqual({ label, valid: true });
		});

		test("a label that two folders under the roots yield is read from both but left out of the coverage, in either root order", async () => {
			const parent = tempDir("corpus-cli-");
			dirs.push(parent);
			writeTree(parent, { "a/notes/.keep": "", "b/notes/docs/guide.md": "guide\n", "c/alpha/.git/HEAD": "", "c/alpha/README.md": "# alpha\n" });
			const runner = fakeGit({ [join(parent, "c", "alpha")]: { origin: "git@github.com:Acme/Alpha.git", branch: "main", remoteDefault: "main", head: HEAD, files: ["README.md"] } });
			for (const order of [["a", "b", "c"], ["b", "a", "c"]]) {
				stub.seen = [];
				const roots = order.flatMap((name) => ["--root", join(parent, name)]);
				const scope = await planScope(roots, { runner });
				expect(scope.coverage).toEqual([{ repo: "Acme/Alpha", source: "fs" }]);
				const sent = rec(defined(stub.requests("/corpus/plan")[0], "request").body, "request");
				expect(list(sent.entries, "entries").map((e) => `${e.repo}:${e.path}`)).toEqual(["Acme/Alpha:README.md", "local/notes:docs/guide.md"]);
			}
		});

		test("one source only declares its own pairs", async () => {
			const exportDir = tempDir("greptile-");
			dirs.push(exportDir);
			writeTree(exportDir, { "Acme/Gamma/architecture.md": "# gamma\n" });
			const { runner } = fixture();
			const scope = await planScope(["--source", "greptile", "--greptile-dir", exportDir], { runner });
			expect(scope).toEqual({ coverage: [{ repo: "Acme/Gamma", source: "greptile" }], maxTier: 2 });
		});

		test("--max-repos leaves the repositories it cut out of the coverage", async () => {
			const gh = fakeGhOwner({ "Acme/One": { files: { "README.md": "one\n" } }, "Acme/Two": { files: { "README.md": "two\n" } } });
			const scope = await planScope(["--source", "github", "--github-owner", "Acme", "--max-repos", "1"], { gh });
			expect(scope).toEqual({ coverage: [{ repo: "Acme/One", source: "github" }], maxTier: 2 });
		});

		test("a repository read from disk is not covered for a Greptile export that the cap left unread", async () => {
			const exportDir = tempDir("greptile-");
			dirs.push(exportDir);
			writeTree(exportDir, { "Acme/Alpha/architecture.md": "# alpha\n", "Acme/Beta/architecture.md": "# beta\n" });
			const { root, runner } = fixture();
			const scope = await planScope(["--root", root, "--source", "fs,greptile", "--greptile-dir", exportDir, "--max-repos", "1"], { runner });
			expect(scope.coverage).toEqual([
				{ repo: "Acme/Alpha", source: "fs" },
				{ repo: "Acme/Alpha", source: "greptile" },
				{ repo: "Acme/Beta", source: "fs" },
			]);
		});

		test("a truncated GitHub tree leaves its pair out, while local clones stay in and are not read twice", async () => {
			const { root, runner } = fixture();
			const gh = fakeGhOwner({
				"Acme/Alpha": { files: { "README.md": "api copy\n" } },
				"Acme/Zed": { files: { "README.md": "zed\n" }, truncated: true },
			});
			const scope = await planScope(["--root", root, "--source", "fs,github", "--github-owner", "Acme"], { runner, gh });
			expect(scope).toEqual({
				coverage: [
					{ repo: "Acme/Alpha", source: "fs" },
					{ repo: "Acme/Beta", source: "fs" },
				],
				maxTier: 2,
			});
			const sent = rec(defined(stub.requests("/corpus/plan")[0], "request").body, "request");
			const sources = list(sent.entries, "entries").map((e) => `${e.repo}:${e.source}`);
			expect(sources).toContain("Acme/Alpha:fs");
			expect(sources).not.toContain("Acme/Alpha:github");
			expect(sources).toContain("Acme/Zed:github");
		});

		test("a scan that read nothing completely still plans its entries with an empty coverage, and says what was left out", async () => {
			const gh = fakeGhOwner({ "Acme/Zed": { files: { "README.md": "zed\n" }, truncated: true } });
			planAllAdd();
			const result = await run(["plan", "--source", "github", "--github-owner", "Acme"], { gh });
			expect(result.code).toBe(0);
			const body = rec(defined(stub.requests("/corpus/plan")[0], "request").body, "request");
			expect(body.scope).toEqual({ coverage: [], maxTier: 2 });
			expect(list(body.entries, "entries").map((e) => `${e.repo}:${e.path}`)).toEqual(["Acme/Zed:README.md"]);
			expect(result.out).toContain("coverage is empty");
			expect(result.out).toContain("Acme/Zed [github]: the tree is truncated");
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
		expect(result.out).toContain("ingest: ingested 3, updated 0, unchanged 0, tombstoned 0, refused 0, failed 0");
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

	test("a failed or a refused document makes the exit code 1 and is listed with its reason; only a run where every item ended well exits 0", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		stub.on("POST /corpus/ingest", answerIngest((repo) => repo === "Acme/Beta"));
		const failed = await run(["ingest", "--root", root, "--execute"], { runner });
		expect(failed.code).toBe(1);
		expect(failed.out).toContain("failed (1):");
		expect(failed.out).toContain("Acme/Beta:README.md  [plane-unavailable]");
		stub.on("POST /corpus/ingest", answerIngest((repo) => repo === "Acme/Beta", { status: "refused", reason: "secret-findings" }));
		const refused = await run(["ingest", "--root", root, "--execute"], { runner });
		expect(refused.code).toBe(1);
		expect(refused.out).toContain("refused (1):");
		expect(refused.out).toContain("[secret-findings]");
		stub.on("POST /corpus/ingest", answerIngest());
		expect((await run(["ingest", "--root", root, "--execute"], { runner })).code).toBe(0);
	});

	test("a rename to a name the plane would alter keeps the old row: nothing is deleted, the new document is refused with the server's reason, the exit is 1", async () => {
		const root = tempDir("corpus-cli-");
		dirs.push(root);
		writeTree(root, { "alpha/.git/HEAD": "", "alpha/docs/x.[docling].md": "# moved\n", "alpha/README.md": "# alpha\n" });
		const runner = fakeGit({ [join(root, "alpha")]: { origin: "git@github.com:Acme/Alpha.git", branch: "main", remoteDefault: "main", head: HEAD, files: ["README.md", "docs/x.[docling].md"] } });
		const items: PlanItem[] = [{ action: "rename", repo: "Acme/Alpha", path: "docs/x.[docling].md", renamedFrom: "docs/old.md" }];
		stub.on("POST /corpus/plan", () => ({ status: 200, body: planOf(items) }));
		stub.on("POST /corpus/ingest", answerIngest());
		const result = await run(["ingest", "--root", root, "--execute"], { runner });
		expect(result.code).toBe(1);
		expect(stub.requests("/corpus/ingest")).toEqual([]);
		expect(result.out).toContain("refused (1):");
		expect(result.out).toContain("Acme/Alpha:docs/x.[docling].md  [unsafe-name]");
		expect(result.out).toContain("tombstoned 0");
	});

	test("a document whose path the server would refuse a whole request for is refused here and never sent", async () => {
		const root = tempDir("corpus-cli-");
		dirs.push(root);
		writeTree(root, { "alpha/.git/HEAD": "", "alpha/README.md": "# alpha\n", "alpha/docs\\odd.md": "odd\n" });
		const runner = fakeGit({ [join(root, "alpha")]: { origin: "git@github.com:Acme/Alpha.git", branch: "main", remoteDefault: "main", head: HEAD, files: ["README.md", "docs\\odd.md"] } });
		stub.on("POST /corpus/plan", (seen) => ({ status: 200, body: planOf(addsFor(seen.body)) }));
		stub.on("POST /corpus/ingest", answerIngest());
		const result = await run(["ingest", "--root", root, "--execute"], { runner });
		expect(result.code).toBe(1);
		const sent = stub.requests("/corpus/ingest").flatMap((s) => ingestParts(s).documents.map((d) => String(d.path)));
		expect(sent).toEqual(["README.md"]);
		expect(result.out).toContain("Acme/Alpha:docs\\odd.md  [bad-path]");
	});

	test("the tombstones go first as a request of their own, and a rename's old row is removed before the new document is sent", async () => {
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
		const first = defined(sent[0], "tombstone request");
		expect(first.documents).toEqual([]);
		expect(first.tombstones).toEqual([
			{ repo: "Acme/Alpha", path: "docs/old-guide.md" },
			{ repo: "Acme/Alpha", path: "old/gone.md" },
		]);
		const second = defined(sent[1], "document request");
		expect(second.documents.map((d) => d.path)).toEqual(["docs/guide.md"]);
		expect(second.tombstones).toEqual([]);
		expect(good.out).toContain("tombstoned 2");
	});

	test("a rename whose old row could not be removed is not inserted, because the plane would link it to the old document", async () => {
		const { root, runner } = fixture();
		const items: PlanItem[] = [{ action: "rename", repo: "Acme/Alpha", path: "docs/guide.md", renamedFrom: "docs/old-guide.md" }];
		stub.on("POST /corpus/plan", () => ({ status: 200, body: planOf(items) }));
		stub.on("POST /corpus/ingest", answerIngest((_repo, path) => path === "docs/old-guide.md"));
		const result = await run(["ingest", "--root", root, "--execute"], { runner });
		expect(result.code).toBe(1);
		const sent = stub.requests("/corpus/ingest").map((s) => ingestParts(s));
		expect(sent).toHaveLength(1);
		expect(defined(sent[0], "tombstone request").documents).toEqual([]);
		expect(result.out).toContain("Acme/Alpha:docs/guide.md  [rename-source-not-removed]");
	});

	test("a rename whose new document is not in the scan keeps its old row", async () => {
		const { root, runner } = fixture();
		const items: PlanItem[] = [{ action: "rename", repo: "Acme/Alpha", path: "docs/missing.md", renamedFrom: "docs/old-guide.md" }];
		stub.on("POST /corpus/plan", () => ({ status: 200, body: planOf(items) }));
		stub.on("POST /corpus/ingest", answerIngest());
		const result = await run(["ingest", "--root", root, "--execute"], { runner });
		expect(result.code).toBe(1);
		expect(stub.requests("/corpus/ingest")).toEqual([]);
		expect(result.out).toContain("Acme/Alpha:docs/missing.md  [not-in-scan]");
	});

	test("tombstones are split into requests no larger than the server accepts", async () => {
		const { root, runner } = fixture();
		const items: PlanItem[] = Array.from({ length: MAX_INGEST_TOMBSTONES + 1 }, (_, i) => ({ action: "tombstone", repo: "Acme/Alpha", path: `old/t${i}.md` }));
		stub.on("POST /corpus/plan", () => ({ status: 200, body: planOf(items) }));
		stub.on("POST /corpus/ingest", answerIngest());
		const result = await run(["ingest", "--root", root, "--execute"], { runner });
		expect(result.code).toBe(0);
		const sent = stub.requests("/corpus/ingest").map((s) => ingestParts(s));
		expect(sent.map((request) => request.tombstones.length)).toEqual([MAX_INGEST_TOMBSTONES, 1]);
		expect(sent.every((request) => request.documents.length === 0)).toBe(true);
	});

	test("--batch-docs above the server limit is lowered to it, so no request is refused for its size", async () => {
		const root = tempDir("corpus-cli-");
		dirs.push(root);
		const tracked = Array.from({ length: MAX_INGEST_DOCUMENTS + 5 }, (_, i) => `docs/d${String(i).padStart(3, "0")}.md`);
		writeTree(root, { "big/.git/HEAD": "", ...Object.fromEntries(tracked.map((rel) => [`big/${rel}`, `${rel}\n`])) });
		const runner = fakeGit({ [join(root, "big")]: { origin: "git@github.com:Acme/Big.git", branch: "main", remoteDefault: "main", head: HEAD, files: tracked } });
		planAllAdd();
		stub.on("POST /corpus/ingest", answerIngest());
		const result = await run(["ingest", "--root", root, "--execute", "--batch-docs", "100000"], { runner });
		expect(result.code).toBe(0);
		expect(stub.requests("/corpus/ingest").map((s) => ingestParts(s).documents.length)).toEqual([MAX_INGEST_DOCUMENTS, 5]);
		expect(result.err).toContain("above the server limit");
	});

	test("an update is sent with its body like an add, and the answer is counted as updated", async () => {
		const { root, runner } = fixture();
		stub.on("POST /corpus/plan", () => ({ status: 200, body: planOf([{ action: "update", repo: "Acme/Alpha", path: "README.md" }]) }));
		stub.on("POST /corpus/ingest", (seen) => ({
			status: 200,
			body: ingestOf(ingestParts(seen).documents.map((d) => ({ repo: String(d.repo), path: String(d.path), status: "updated" as const }))),
		}));
		const result = await run(["ingest", "--root", root, "--execute"], { runner });
		expect(result.code).toBe(0);
		const documents = stub.requests("/corpus/ingest").flatMap((s) => ingestParts(s).documents);
		expect(documents).toHaveLength(1);
		expect(documents[0]).toMatchObject({ repo: "Acme/Alpha", path: "README.md", body: "# alpha\n" });
		expect(result.out).toContain("update 1");
		expect(result.out).toContain("updated 1");
	});

	test("a document that starts with a byte-order mark is sent with a body that hashes to the planned sha256", async () => {
		const root = tempDir("corpus-cli-");
		dirs.push(root);
		writeTree(root, { "alpha/.git/HEAD": "", "alpha/README.md": Uint8Array.of(0xef, 0xbb, 0xbf, 0x23, 0x20, 0x61, 0x0a) });
		const runner = fakeGit({ [join(root, "alpha")]: { origin: "git@github.com:Acme/Alpha.git", branch: "main", remoteDefault: "main", head: HEAD, files: ["README.md"] } });
		planAllAdd();
		stub.on("POST /corpus/ingest", answerIngest());
		const result = await run(["ingest", "--root", root, "--execute"], { runner });
		expect(result.code).toBe(0);
		const document = defined(stub.requests("/corpus/ingest").flatMap((s) => ingestParts(s).documents)[0], "document");
		expect(createHash("sha256").update(new TextEncoder().encode(String(document.body))).digest("hex")).toBe(String(document.sha256));
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
		expect(result.out).toContain("ingest: ingested 0, updated 0, unchanged 0, tombstoned 0, refused 0, failed 0");
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

describe("substrate corpus plan --neardup", () => {
	const ALPHA_README = { repo: "Acme/Alpha", path: "README.md" };
	const BETA_README = { repo: "Acme/Beta", path: "README.md" };
	const pairOf = (similarity: number, a = ALPHA_README, b = BETA_README) => ({ a, b, similarity });

	function neardupBody(index = 0): Record<string, unknown> {
		return rec(defined(stub.requests("/corpus/neardup")[index], "neardup request").body, "neardup request");
	}

	function neardupAnswers(reply: Reply): void {
		stub.on("POST /corpus/neardup", () => reply);
	}

	test("sends one request with the excerpts the plan would write, in order, and prints the advisory section after the plan", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		neardupAnswers({ status: 200, body: neardupOf([pairOf(0.9731)]) });
		const result = await run(["plan", "--root", root, "--neardup"], { runner });
		expect(result.code).toBe(0);
		expect(stub.requests("/corpus/neardup")).toHaveLength(1);
		expect(defined(stub.requests("/corpus/neardup")[0], "request").authorization).toBe("Bearer tok-1");
		const body = neardupBody();
		expect(body.protocol).toBe(CORPUS_PROTOCOL);
		expect("threshold" in body).toBe(false);
		expect(body.items).toEqual([
			{ repo: "Acme/Alpha", path: "README.md", text: "# alpha\n" },
			{ repo: "Acme/Alpha", path: "docs/guide.md", text: "guide\n" },
			{ repo: "Acme/Beta", path: "README.md", text: "# beta\n" },
		]);
		expect(result.out.startsWith("plan: add 3, change 0")).toBe(true);
		expect(result.out.slice(result.out.indexOf("near-duplicates"))).toBe(
			"near-duplicates (advisory: no document is dropped on this signal)\n" +
				"  0.9731  Acme/Alpha:README.md  ~  Acme/Beta:README.md\n" +
				"model: test-model, dimension: 3\n" +
				"compared: 3 documents, skipped (empty text): 0\n",
		);
		expect(result.err).toBe("");
	});

	test("sends only the plan request when --neardup is absent", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		const result = await run(["plan", "--root", root], { runner });
		expect(result.code).toBe(0);
		expect(stub.requests("/corpus/neardup")).toEqual([]);
		expect(result.out).not.toContain("near-duplicates");
	});

	test("--threshold is sent as given and --neardup-max limits the excerpts and says so", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		neardupAnswers({ status: 200, body: neardupOf([], { compared: 2 }) });
		const result = await run(["plan", "--root", root, "--neardup", "--threshold", "0.8", "--neardup-max", "2"], { runner });
		expect(result.code).toBe(0);
		const body = neardupBody();
		expect(body.threshold).toBe(0.8);
		expect(list(body.items, "items").map((item) => item.path)).toEqual(["README.md", "docs/guide.md"]);
		expect(result.out).toContain("compared the first 2 of 3 documents (--neardup-max)");
		expect(result.out).toContain("no pair is at or above the threshold");
	});

	test("the bounds of the options are accepted: threshold 0.5 and 1, a maximum of 1 and of 1000", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		neardupAnswers({ status: 200, body: neardupOf([]) });
		for (const threshold of ["0.5", "1", ".75", "0.92"]) {
			stub.seen = [];
			expect((await run(["plan", "--root", root, "--neardup", "--threshold", threshold], { runner })).code).toBe(0);
			expect(neardupBody().threshold).toBe(Number(threshold));
		}
		for (const max of ["1", "1000"]) {
			stub.seen = [];
			expect((await run(["plan", "--root", root, "--neardup", "--neardup-max", max], { runner })).code).toBe(0);
			expect(list(neardupBody().items, "items")).toHaveLength(Math.min(3, Number(max)));
		}
	});

	test("a document from GitHub is counted as not compared and its text never leaves", async () => {
		const { root, runner } = fixture();
		const gh = fakeGhOwner({ "Acme/Gamma": { files: { "README.md": "gamma secret\n" } } });
		planAllAdd();
		neardupAnswers({ status: 200, body: neardupOf([]) });
		const result = await run(["plan", "--root", root, "--source", "fs,github", "--github-owner", "Acme", "--neardup"], { runner, gh });
		expect(result.code).toBe(0);
		expect(list(neardupBody().items, "items").map((item) => item.repo)).toEqual(["Acme/Alpha", "Acme/Alpha", "Acme/Beta"]);
		expect(JSON.stringify(stub.requests("/corpus/neardup"))).not.toContain("gamma secret");
		expect(result.out).toContain("1 document from GitHub was not compared");
	});

	test("a file that cannot be read is counted as not compared and never fails the command", async () => {
		const { root, runner } = fixture();
		let armed = false;
		stub.on("POST /corpus/plan", (seen) => {
			// The scan is over once the plan is asked for; from here a read of the guide fails.
			armed = true;
			return { status: 200, body: planOf(addsFor(seen.body)) };
		});
		neardupAnswers({ status: 200, body: neardupOf([], { compared: 2 }) });
		const readFile = (path: string): Uint8Array => {
			if (armed && path.endsWith("guide.md")) throw new Error("EACCES: permission denied");
			return readFileSync(path);
		};
		const result = await run(["plan", "--root", root, "--neardup"], { runner, readFile });
		expect(result.code).toBe(0);
		expect(list(neardupBody().items, "items").map((item) => item.path)).toEqual(["README.md", "README.md"]);
		expect(result.out).toContain("1 document could not be read and was not compared");
	});

	test("only the documents the plan writes are compared: a tombstone is not, a rename is", async () => {
		const { root, runner } = fixture();
		const items: PlanItem[] = [
			{ action: "rename", repo: "Acme/Alpha", path: "README.md", renamedFrom: "old.md" },
			{ action: "tombstone", repo: "Acme/Alpha", path: "docs/guide.md" },
		];
		stub.on("POST /corpus/plan", () => ({ status: 200, body: planOf(items, 1) }));
		neardupAnswers({ status: 200, body: neardupOf([], { compared: 1 }) });
		await run(["plan", "--root", root, "--neardup"], { runner });
		expect(list(neardupBody().items, "items").map((item) => item.path)).toEqual(["README.md"]);
	});

	test("with nothing to compare it says so, sends no request and exits 0", async () => {
		const { root, runner } = fixture();
		stub.on("POST /corpus/plan", () => ({ status: 200, body: planOf([], 3) }));
		const result = await run(["plan", "--root", root, "--neardup"], { runner });
		expect(result.code).toBe(0);
		expect(result.out).toContain("near-duplicates: nothing to compare\n");
		expect(result.out).not.toContain("advisory");
		expect(stub.requests("/corpus/neardup")).toEqual([]);
		const json = rec(rec(JSON.parse((await run(["plan", "--root", root, "--neardup", "--json"], { runner })).out), "plan").neardup, "neardup");
		expect(json).toMatchObject({ model: null, dimension: null, compared: 0, pairs: [], notCompared: { github: 0, unreadable: 0, overLimit: 0 } });
	});

	test("--json adds one key, neardup, holding the reply and what was not compared; without --neardup the output is the plan unchanged", async () => {
		const { root, runner } = fixture();
		const plan = planOf([{ action: "add", repo: "Acme/Alpha", path: "README.md" }, { action: "add", repo: "Acme/Beta", path: "README.md" }]);
		stub.on("POST /corpus/plan", () => ({ status: 200, body: plan }));
		const reply = neardupOf([pairOf(0.95)], { compared: 2 });
		neardupAnswers({ status: 200, body: reply });
		const plain = await run(["plan", "--root", root, "--json"], { runner });
		expect(plain.out).toBe(`${JSON.stringify(plan, null, 2)}\n`);
		expect(stub.requests("/corpus/neardup")).toEqual([]);
		const asked = await run(["plan", "--root", root, "--neardup", "--json"], { runner });
		expect(asked.code).toBe(0);
		const parsed = rec(JSON.parse(asked.out), "plan");
		expect(Object.keys(parsed)).toEqual([...Object.keys(plan), "neardup"]);
		expect(parsed.neardup).toEqual({ ...reply, notCompared: { github: 0, unreadable: 0, overLimit: 0 } });
		expect(asked.out).not.toContain("advisory");
	});

	test.each(EMBEDDING_REASONS.map((reason) => [reason] as const))("when the embedding service cannot answer (%s) the plan is still printed, one line on stderr names the reason, and the exit is 1", async (reason) => {
		const { root, runner } = fixture();
		planAllAdd();
		neardupAnswers({ status: 503, body: { error: "the embedding service could not answer", reason: "corpus.embeddings-unavailable", detail: reason } });
		const result = await run(["plan", "--root", root, "--neardup"], { runner });
		expect(result.code).toBe(1);
		expect(result.out).toContain("plan: add 3");
		expect(result.out).not.toContain("near-duplicates");
		const lines = result.err.split("\n").filter((line) => line !== "");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(reason);
	});

	test("a failed comparison is also exit 1 in --json, with { error } under neardup", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		neardupAnswers({ status: 503, body: { error: "x", reason: "corpus.embeddings-unavailable", detail: "timeout" } });
		const result = await run(["plan", "--root", root, "--neardup", "--json"], { runner });
		expect(result.code).toBe(1);
		const parsed = rec(JSON.parse(result.out), "plan");
		expect(parsed.manifestVersion).toBe(7);
		const neardup = rec(parsed.neardup, "neardup");
		expect(Object.keys(neardup)).toEqual(["error"]);
		expect(String(neardup.error)).toContain("timeout");
	});

	test("a refusal, a missing route and an answer of the wrong shape are each exit 1 with the plan printed", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		const answers: Reply[] = [
			{ status: 400, body: { error: "the threshold is not a number from 0.5 to 1", reason: "bad-threshold" } },
			{ status: 401, body: {} },
			{ status: 200, body: { protocol: CORPUS_PROTOCOL, pairs: "none" } },
		];
		for (const answer of answers) {
			neardupAnswers(answer);
			const result = await run(["plan", "--root", root, "--neardup"], { runner });
			expect(result.code).toBe(1);
			expect(result.out).toContain("plan: add 3");
			expect(result.err.split("\n").filter((line) => line !== "")).toHaveLength(1);
		}
		stub.routes.delete("POST /corpus/neardup");
		expect((await run(["plan", "--root", root, "--neardup"], { runner })).code).toBe(1);
	});

	test("a plan that failed exits 1 and compares nothing", async () => {
		const { root, runner } = fixture();
		stub.on("POST /corpus/plan", () => ({ status: 503, body: { error: "x", reason: "corpus.disabled" } }));
		const result = await run(["plan", "--root", root, "--neardup"], { runner });
		expect(result.code).toBe(1);
		expect(stub.requests("/corpus/neardup")).toEqual([]);
	});

	test("at most 50 pairs are listed, then a count of the rest", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		const pairs = Array.from({ length: 60 }, (_, index) => pairOf(0.99 - index / 1000, ALPHA_README, { repo: "Acme/Beta", path: `copy-${index}.md` }));
		neardupAnswers({ status: 200, body: neardupOf(pairs, { truncated: true }) });
		const result = await run(["plan", "--root", root, "--neardup"], { runner });
		const listed = result.out.split("\n").filter((line) => /^ {2}\d\.\d{4} {2}/.test(line));
		expect(listed).toHaveLength(50);
		expect(listed[0]).toBe("  0.9900  Acme/Alpha:README.md  ~  Acme/Beta:copy-0.md");
		expect(result.out).toContain("  ... and 10 more");
		expect(result.out).toContain("more pairs matched than the server returned");
	});

	test("the skipped count is what the server did not embed", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		neardupAnswers({ status: 200, body: neardupOf([], { compared: 2, skipped: [{ repo: "Acme/Alpha", path: "README.md", reason: "empty" }] }) });
		const result = await run(["plan", "--root", root, "--neardup"], { runner });
		expect(result.out).toContain("compared: 2 documents, skipped (empty text): 1");
	});

	test("a name from the server cannot carry a control character into the report", async () => {
		const { root, runner } = fixture();
		planAllAdd();
		const hostile = { repo: "Acme/Alpha", path: "x\u001b[2Jevil\n  0.9999  forged.md" };
		neardupAnswers({ status: 200, body: neardupOf([pairOf(0.97, hostile, BETA_README)], { model: "m\u001b]0;title\u0007" }) });
		const result = await run(["plan", "--root", root, "--neardup"], { runner });
		expect(result.out).not.toContain("\u001b");
		expect(result.out).not.toContain("\u0007");
		expect(result.out).toContain("Acme/Alpha:x\\x1b[2Jevil\\x0a  0.9999  forged.md  ~  Acme/Beta:README.md");
		expect(result.out.split("\n").filter((line) => line.startsWith("  0.9999"))).toEqual([]);
		expect(result.out).toContain("model: m\\x1b]0;title\\x07");
	});

	test("the usage errors exit 2 before anything is read or sent, and ingest, scan and status do not accept --neardup", async () => {
		const { root, runner } = fixture();
		const withRoot: string[][] = [
			["plan", "--neardup", "--threshold", "0.49"],
			["plan", "--neardup", "--threshold", "1.01"],
			["plan", "--neardup", "--threshold", "abc"],
			["plan", "--neardup", "--threshold", "-1"],
			["plan", "--neardup", "--threshold", "0.9x"],
			["plan", "--neardup", "--threshold"],
			["plan", "--neardup", "--neardup-max", "0"],
			["plan", "--neardup", "--neardup-max", "1001"],
			["plan", "--neardup", "--neardup-max", "x"],
			["plan", "--neardup", "--neardup-max", "1.5"],
			["plan", "--threshold", "0.9"],
			["plan", "--neardup-max", "5"],
			["plan", "--neardup=1"],
			["ingest", "--neardup"],
			["ingest", "--neardup", "--execute"],
			["ingest", "--threshold", "0.9"],
			["scan", "--neardup"],
		];
		for (const argv of withRoot) {
			const result = await run([...argv, "--root", root], { runner });
			expect({ argv, code: result.code }).toEqual({ argv, code: 2 });
		}
		expect((await run(["status", "--neardup"])).code).toBe(2);
		expect(stub.seen).toEqual([]);
	});
});
