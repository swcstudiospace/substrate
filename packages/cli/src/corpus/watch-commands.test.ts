import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultGitBytesRunner, isRecord, type GitBytesRunner, type GitRunner, type IngestStatus, type PlanItem } from "@substrate/corpus";
import { commitAll, defined, fakeGit, fingerprint, gitWorld, runGit, tempDir, writeTree } from "../../../corpus/src/test-support.ts";
import type { EmitDocsSync } from "./events.ts";
import { runCorpus } from "./index.ts";
import { CorpusStub, ingestOf, planOf, reconcileOf, type Reply, type Seen } from "./testkit.ts";

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
/** Mirrors need a real origin; these tests read the repositories as plain working trees. */
const noGit: GitBytesRunner = () => ({ code: 1, stdout: new Uint8Array(0), timedOut: false });

interface Fixture {
	root: string;
	runner: GitRunner;
	env: Record<string, string>;
	spool: string;
}

function fixture(): Fixture {
	const root = tempDir("corpus-watch-cli-");
	dirs.push(root);
	writeTree(root, { "alpha/.git/HEAD": "", "alpha/README.md": "# alpha\n", "alpha/docs/guide.md": "guide\n", "beta/.git/HEAD": "", "beta/README.md": "# beta\n" });
	const base = { branch: "main", remoteDefault: "main", head: HEAD };
	const runner = fakeGit({
		[join(root, "alpha")]: { ...base, origin: "git@github.com:Acme/Alpha.git", files: ["README.md", "docs/guide.md"] },
		[join(root, "beta")]: { ...base, origin: "git@github.com:Acme/Beta.git", files: ["README.md"] },
	});
	const state = tempDir("corpus-watch-state-");
	dirs.push(state);
	const spool = join(state, "hints");
	return { root, runner, env: { HOME: state, SUBSTRATE_CORPUS_MIRROR_DIR: join(state, "mirrors"), SUBSTRATE_CORPUS_SPOOL: spool }, spool };
}

interface RunOptions {
	env?: Record<string, string | undefined>;
	runner?: GitRunner;
	git?: GitBytesRunner;
	emit?: EmitDocsSync;
}

async function run(argv: string[], options: RunOptions = {}): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	let tick = 5_000_000;
	const code = await runCorpus(argv, {
		url: stub.url,
		token: "tok-1",
		timeoutMs: 2000,
		env: options.env ?? {},
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		runner: options.runner,
		git: options.git ?? noGit,
		emit: options.emit,
		now: () => {
			tick += 250;
			return tick;
		},
	});
	return { code, out: out.join(""), err: err.join("") };
}

function rec(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} is not an object`);
	return value;
}

function list(value: unknown, label: string): Record<string, unknown>[] {
	if (!Array.isArray(value)) throw new Error(`${label} is not a list`);
	return value.map((item) => rec(item, label));
}

function planAllAdd(): void {
	stub.on("POST /corpus/plan", (seen) => {
		const items: PlanItem[] = list(rec(seen.body, "request").entries, "entries").map((entry) => ({ action: "add" as const, repo: String(entry.repo), path: String(entry.path), sha256: String(entry.sha256) }));
		return { status: 200, body: planOf(items) };
	});
}

function answerIngest(refuse: (path: string) => boolean = () => false) {
	return (seen: Seen): Reply => {
		const request = rec(seen.body, "ingest request");
		const rows = [...list(request.documents, "documents"), ...list(request.tombstones, "tombstones")].map((row) => {
			const status: IngestStatus = refuse(String(row.path)) ? "refused" : "ingested";
			return { repo: String(row.repo), path: String(row.path), status, ...(status === "refused" ? { reason: "secret-findings" } : {}) };
		});
		return { status: 200, body: ingestOf(rows) };
	};
}

const syncEvents = (): Record<string, unknown>[] => stub.requests("/events").map((seen) => rec(seen.body, "event"));

describe("substrate corpus sync", () => {
	test("a dry run plans only the named repository, with coverage for it alone, and sends nothing else", async () => {
		const f = fixture();
		planAllAdd();

		const result = await run(["sync", "--repo", "Acme/Alpha", "--root", f.root], { runner: f.runner, env: f.env });

		expect(result.code).toBe(0);
		const request = rec(defined(stub.requests("/corpus/plan")[0], "a plan").body, "plan");
		expect(list(request.entries, "entries").map((entry) => entry.repo)).toEqual(["Acme/Alpha", "Acme/Alpha"]);
		expect(rec(request.scope, "scope").coverage).toEqual([{ repo: "Acme/Alpha", source: "fs" }]);
		expect(stub.requests("/corpus/ingest")).toHaveLength(0);
		expect(stub.requests("/events")).toHaveLength(0);
		expect(result.out).toContain("dry run");
	});

	test("--execute ingests the documents and reports one docs.sync event with the closed fields", async () => {
		const f = fixture();
		planAllAdd();
		stub.on("POST /corpus/ingest", answerIngest());
		stub.on("POST /events", () => ({ status: 200, body: { ok: true } }));

		const result = await run(["sync", "--repo", "Acme/Alpha", "--root", f.root, "--execute"], { runner: f.runner, env: f.env });

		expect(result.code).toBe(0);
		expect(list(rec(stub.requests("/corpus/ingest")[0]?.body, "ingest").documents, "documents").map((document) => document.path)).toEqual(["README.md", "docs/guide.md"]);
		const events = syncEvents();
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("note");
		expect("surface" in rec(events[0], "event")).toBe(false);
		expect(rec(events[0]?.payload, "payload")).toMatchObject({ action: "docs.sync", repo: "Acme/Alpha", trigger: "manual", outcome: "ok", added: 2, refused: 0, failed: 0 });
		expect(stub.requests("/events")[0]?.authorization).toBe("Bearer tok-1");
	});

	test("exits non-zero and says so when a document was refused, in the text and in --json", async () => {
		const f = fixture();
		planAllAdd();
		stub.on("POST /corpus/ingest", answerIngest((path) => path === "docs/guide.md"));

		const text = await run(["sync", "--repo", "Acme/Alpha", "--root", f.root, "--execute"], { runner: f.runner, env: f.env });
		expect(text.code).toBe(1);
		expect(text.out).toContain("refused");
		expect(text.out).toContain("docs/guide.md");

		const json = await run(["sync", "--repo", "Acme/Alpha", "--root", f.root, "--execute", "--json"], { runner: f.runner, env: f.env });
		expect(json.code).toBe(1);
		expect(rec(JSON.parse(json.out), "json")).toMatchObject({ outcome: "partial", ingest: { counts: { refused: 1 } } });
	});

	test("a lost event never fails the sync, but is shown", async () => {
		const f = fixture();
		planAllAdd();
		stub.on("POST /corpus/ingest", answerIngest());
		stub.on("POST /events", () => ({ status: 503, body: { error: "down" } }));

		const result = await run(["sync", "--repo", "Acme/Alpha", "--root", f.root, "--execute"], { runner: f.runner, env: f.env });

		expect(result.code).toBe(0);
		expect(result.out).toContain("docs.sync event not delivered (http-503)");
	});

	test("a repository that is not found is a failure of the request, never a quiet success", async () => {
		const f = fixture();
		planAllAdd();
		const result = await run(["sync", "--repo", "Acme/Nope", "--root", f.root], { runner: f.runner, env: f.env });
		expect(result.code).toBe(1);
		expect(result.out).toContain("repo-not-found: Acme/Nope");
		expect(stub.requests("/corpus/plan")).toHaveLength(0);
	});

	test("a server that refuses the plan fails the sync with the reason", async () => {
		const f = fixture();
		stub.on("POST /corpus/plan", () => ({ status: 401, body: { error: "no" } }));
		const result = await run(["sync", "--repo", "Acme/Alpha", "--root", f.root, "--execute"], { runner: f.runner, env: f.env });
		expect(result.code).toBe(1);
		expect(result.err).toContain("refused the credentials");
	});

	test("rejects a bad flag value with the usage exit code", async () => {
		const f = fixture();
		expect((await run(["sync", "--tier", "9"], { runner: f.runner, env: f.env })).code).toBe(2);
		expect((await run(["sync", "--bogus"], { runner: f.runner, env: f.env })).code).toBe(2);
	});
});

describe("substrate corpus reconcile", () => {
	test("a dry run plans, reports the drift and the problems, and repairs nothing", async () => {
		const f = fixture();
		planAllAdd();
		stub.on("POST /corpus/reconcile", () => ({
			status: 200,
			body: reconcileOf({ missingInPlane: [{ repo: "Acme/Alpha", path: "docs/guide.md" }], orphansInPlane: ["corpus:Acme%2FGone:old.md@aaaaaaaaaaaa"] }),
		}));

		const result = await run(["reconcile", "--root", f.root], { runner: f.runner, env: f.env });

		expect(result.code).toBe(0);
		expect(rec(stub.requests("/corpus/reconcile")[0]?.body, "reconcile")).toEqual({ protocol: 1, execute: false });
		expect(stub.requests("/corpus/ingest")).toHaveLength(0);
		expect(result.out).toContain("Acme/Alpha:docs/guide.md");
		expect(result.out).toContain("corpus:Acme%2FGone:old.md@aaaaaaaaaaaa");
		expect(result.out).toContain("dry run: nothing was changed");
	});

	test("--execute repairs first, then ingests what the fresh plan offers, and reports the repair", async () => {
		const f = fixture();
		planAllAdd();
		stub.on("POST /corpus/ingest", answerIngest());
		stub.on("POST /events", () => ({ status: 200, body: {} }));
		stub.on("POST /corpus/reconcile", () => ({ status: 200, body: reconcileOf({ missingInPlane: [{ repo: "Acme/Alpha", path: "docs/guide.md" }] }, { requeued: 1, deleted: 0 }) }));

		const result = await run(["reconcile", "--root", f.root, "--execute"], { runner: f.runner, env: f.env });

		expect(result.code).toBe(0);
		expect(stub.seen.map((seen) => seen.path)).toEqual(["/corpus/plan", "/corpus/reconcile", "/corpus/plan", "/corpus/ingest", "/events"]);
		expect(rec(stub.requests("/corpus/reconcile")[0]?.body, "reconcile")).toEqual({ protocol: 1, execute: true });
		expect(result.out).toContain("repaired: 1 rows requeued, 0 orphan documents deleted");
		expect(rec(syncEvents()[0]?.payload, "payload")).toMatchObject({ trigger: "reconcile", repo: "*" });
	});

	test("a server without the route fails the command", async () => {
		const f = fixture();
		planAllAdd();
		const result = await run(["reconcile", "--root", f.root], { runner: f.runner, env: f.env });
		expect(result.code).toBe(1);
		expect(result.err).toContain("corpus reconcile failed");
	});
});

describe("substrate corpus watch --once", () => {
	test("runs one sweep of every repository through the sync path and exits", async () => {
		const f = fixture();
		planAllAdd();
		stub.on("POST /corpus/ingest", answerIngest());
		stub.on("POST /events", () => ({ status: 200, body: {} }));

		const result = await run(["watch", "--once", "--root", f.root], { runner: f.runner, env: f.env });

		expect(result.code).toBe(0);
		expect(list(rec(stub.requests("/corpus/plan")[0]?.body, "plan").entries, "entries")).toHaveLength(3);
		expect(rec(syncEvents()[0]?.payload, "payload")).toMatchObject({ trigger: "sweep", repo: "*", outcome: "ok" });
		expect(result.out).toContain("all repositories synced (sweep): ok");
	});

	test("exits non-zero when the sweep failed or was only partial", async () => {
		const f = fixture();
		planAllAdd();
		stub.on("POST /corpus/ingest", answerIngest(() => true));
		const result = await run(["watch", "--once", "--root", f.root], { runner: f.runner, env: f.env });
		expect(result.code).toBe(1);
		expect(result.err).toContain("partial");
	});

	test("--sweep-s outside its range is a usage error", async () => {
		const f = fixture();
		expect((await run(["watch", "--once", "--sweep-s", "5", "--root", f.root], { runner: f.runner, env: f.env })).code).toBe(2);
		expect((await run(["watch", "--once", "--sweep-s", "99999", "--root", f.root], { runner: f.runner, env: f.env })).code).toBe(2);
	});
});

describe("substrate corpus hint", () => {
	test("writes one hint into the spool, prints nothing and exits 0", async () => {
		const f = fixture();
		const result = await run(["hint", "--repo", join(f.root, "alpha")], { env: f.env });
		expect(result).toEqual({ code: 0, out: "", err: "" });
		const files = readdirSync(f.spool);
		expect(files).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(f.spool, defined(files[0], "a hint file")), "utf8"))).toMatchObject({ v: 1, dir: join(f.root, "alpha") });
	});

	test("exits 0 even when the spool cannot be written, and says why on the error stream only", async () => {
		const f = fixture();
		writeFileSync(f.spool, "a file where the spool directory should be");
		const result = await run(["hint", "--repo", join(f.root, "alpha")], { env: f.env });
		expect(result.code).toBe(0);
		expect(result.out).toBe("");
		expect(result.err).toContain("spool-unwritable");
	});

	test("needs --repo", async () => {
		expect((await run(["hint"], { env: {} })).code).toBe(2);
	});
});

describe("substrate corpus hook", () => {
	function repo(): string {
		const dir = tempDir("corpus-hook-");
		dirs.push(dir);
		runGit(dir, ["init", "-q"]);
		return dir;
	}

	test("install, status and uninstall act on the three hint hooks only", async () => {
		const dir = repo();

		const installed = await run(["hook", "install", "--repo", dir]);
		expect(installed.code).toBe(0);
		expect(installed.out).toContain("post-merge: installed");
		expect(existsSync(join(dir, ".git", "hooks", "post-commit"))).toBe(false);

		const status = await run(["hook", "status", "--repo", dir]);
		expect(status.code).toBe(0);
		expect(status.out).toContain("post-rewrite: present");

		const removed = await run(["hook", "uninstall", "--repo", dir]);
		expect(removed.code).toBe(0);
		expect(removed.out).toContain("post-checkout: removed");
		expect(existsSync(join(dir, ".git", "hooks", "post-merge"))).toBe(false);
	});

	test("a hook that is not ours is reported, left alone and makes install exit 1", async () => {
		const dir = repo();
		const path = join(dir, ".git", "hooks", "post-checkout");
		writeFileSync(path, "#!/bin/sh\necho mine\n", { mode: 0o755 });

		const result = await run(["hook", "install", "--repo", dir]);

		expect(result.code).toBe(1);
		expect(result.out).toContain("post-checkout: foreign");
		expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\necho mine\n");
	});

	test("needs a known action and --repo; a directory that is not a repository exits 1", async () => {
		const dir = repo();
		expect((await run(["hook", "--repo", dir])).code).toBe(2);
		expect((await run(["hook", "enable", "--repo", dir])).code).toBe(2);
		expect((await run(["hook", "install"])).code).toBe(2);
		const plain = tempDir("corpus-hook-plain-");
		dirs.push(plain);
		expect((await run(["hook", "status", "--repo", plain])).code).toBe(1);
	});
});

describe("the default triggers are read-only toward every repository", () => {
	test("watch --once and reconcile --execute leave the .git and the tree of every checkout byte for byte as they were", async () => {
		const w = gitWorld({ "README.md": "# one\n", "docs/a.md": "a\n" });
		dirs.push(w.root);
		// A local edit, an untracked document, and a push made elsewhere that the checkout has not pulled.
		writeTree(w.local, { "docs/a.md": "a-local\n", "docs/new.md": "new\n" });
		writeTree(w.other, { "docs/b.md": "b\n" });
		commitAll(w.other, "remote only");
		runGit(w.other, ["push", "-q", "origin", "main"]);
		const checkouts = [w.local, w.other, join(w.root, "seed")];
		const before = checkouts.map((dir) => fingerprint(dir));
		const env = { HOME: w.root, SUBSTRATE_CORPUS_MIRROR_DIR: w.mirrors, SUBSTRATE_CORPUS_SPOOL: join(w.root, "spool") };
		planAllAdd();
		stub.on("POST /corpus/ingest", answerIngest());
		stub.on("POST /events", () => ({ status: 200, body: {} }));
		stub.on("POST /corpus/reconcile", () => ({ status: 200, body: reconcileOf() }));

		const watched = await run(["watch", "--once", "--root", w.root], { env, git: defaultGitBytesRunner });
		const reconciled = await run(["reconcile", "--execute", "--root", w.root], { env, git: defaultGitBytesRunner });

		expect(watched.code).toBe(0);
		expect(reconciled.code).toBe(0);
		expect(checkouts.map((dir) => fingerprint(dir))).toEqual(before);
		// The remote-only document did reach the plane, read through the mirror.
		const paths = stub.requests("/corpus/plan").flatMap((seen) => list(rec(seen.body, "plan").entries, "entries").map((entry) => `${entry.repo}:${entry.path}`));
		expect(paths).toContain("local/local:docs/b.md");
		expect(paths).toContain("local/local:docs/new.md");
		expect(existsSync(w.mirrors)).toBe(true);
	});
});
