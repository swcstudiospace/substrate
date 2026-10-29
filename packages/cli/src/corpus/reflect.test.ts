import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_PROTOCOL, isRecord, MAX_REFLECT_DIGESTS, type GitRunner, type RepoDigest } from "@substrate/corpus";
import { defined, fakeGit, tempDir, writeTree } from "../../../corpus/src/test-support.ts";
import { createCorpusClient } from "./client.ts";
import { collectDigests, executeReflect } from "./reflect.ts";
import { CorpusStub, reflectOf } from "./testkit.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HEAD = "f".repeat(40);
const STATE = "---\nmilestone: v1.7\nstatus: executing\n---\n\n## Decisions\n\n- first decision\n- second decision\n";
const ROADMAP = "# Roadmap\n\n- [ ] Phase 1: open work\n- [x] Phase 0: done work\n";
const MAX_BYTES = 100_000;

function make(files: Record<string, string | Uint8Array>): string {
	const root = tempDir("corpus-reflect-");
	dirs.push(root);
	writeTree(root, files);
	return root;
}

function runnerFor(root: string, repos: Record<string, string | null>): GitRunner {
	return fakeGit(
		Object.fromEntries(
			Object.entries(repos).map(([name, slug]) => [
				join(root, name),
				{ head: HEAD, branch: "main", remoteDefault: "main", ...(slug === null ? {} : { origin: `git@github.com:${slug}.git` }) },
			]),
		),
	);
}

describe("collectDigests", () => {
	test("digests each checkout that has a readable STATE, skips the rest with a closed reason and counts the ones without a STATE", () => {
		const root = make({
			"alpha/.git/HEAD": "",
			"alpha/.planning/STATE.md": STATE,
			"alpha/.planning/ROADMAP.md": ROADMAP,
			"beta/.git/HEAD": "",
			"beta/README.md": "# beta\n",
			"gamma/.git/HEAD": "",
			"gamma/.planning/STATE.md": STATE,
			"gamma/.planning/ROADMAP.md": "",
			"delta/.git/HEAD": "",
			"delta/.planning/STATE.md": Uint8Array.of(0xff, 0xfe, 0x41),
		});
		const runner = runnerFor(root, { alpha: "Acme/Alpha", beta: "Acme/Beta", gamma: "Acme/Gamma", delta: "Acme/Delta" });
		const result = collectDigests({ roots: [root], repos: [], maxBytes: MAX_BYTES, runner });
		expect(result.digests.map((digest) => digest.repo)).toEqual(["Acme/Alpha"]);
		expect(result.skipped).toEqual([
			{ repo: "Acme/Delta", reason: "state-invalid-utf8" },
			{ repo: "Acme/Gamma", reason: "roadmap-empty" },
		]);
		expect(result.notes).toContain("1 checkout without .planning/STATE.md not reflected");
		expect(result.checkouts).toBe(4);
		const digest = defined(result.digests[0], "alpha digest");
		expect(digest.key).toBe("corpus-digest:Acme/Alpha");
		expect(digest.text).toContain("- Milestone: v1.7");
		expect(digest.text).toContain("- second decision");
		expect(digest.text).toContain("- Phase 1: open work");
		expect(digest.text).not.toContain("done work");
	});

	test("reads the working tree, so a change on disk changes the digest and the same files give the same digest", () => {
		const root = make({ "alpha/.git/HEAD": "", "alpha/.planning/STATE.md": STATE });
		const runner = runnerFor(root, { alpha: "Acme/Alpha" });
		const first = collectDigests({ roots: [root], repos: [], maxBytes: MAX_BYTES, runner });
		const again = collectDigests({ roots: [root], repos: [], maxBytes: MAX_BYTES, runner });
		expect(defined(again.digests[0], "again").sha256).toBe(defined(first.digests[0], "first").sha256);
		writeTree(root, { "alpha/.planning/STATE.md": `${STATE}- third decision\n` });
		const changed = collectDigests({ roots: [root], repos: [], maxBytes: MAX_BYTES, runner });
		expect(defined(changed.digests[0], "changed").sha256).not.toBe(defined(first.digests[0], "first").sha256);
	});

	test("--repo limits the run, reports a repository without a STATE or not found, and ignores the others silently", () => {
		const root = make({
			"alpha/.git/HEAD": "",
			"alpha/.planning/STATE.md": STATE,
			"beta/.git/HEAD": "",
			"beta/README.md": "# beta\n",
			"gamma/.git/HEAD": "",
			"gamma/.planning/STATE.md": STATE,
		});
		const runner = runnerFor(root, { alpha: "Acme/Alpha", beta: "Acme/Beta", gamma: "Acme/Gamma" });
		const result = collectDigests({ roots: [root], repos: ["Acme/Alpha", "Acme/Beta", "Acme/Missing"], maxBytes: MAX_BYTES, runner });
		expect(result.digests.map((digest) => digest.repo)).toEqual(["Acme/Alpha"]);
		expect(result.skipped).toEqual([
			{ repo: "Acme/Beta", reason: "no-state" },
			{ repo: "Acme/Missing", reason: "not-found" },
		]);
	});

	test("a planning file that is too large or unreadable leaves its repository out instead of digesting half of it", () => {
		const root = make({
			"big/.git/HEAD": "",
			"big/.planning/STATE.md": STATE,
			"big/.planning/ROADMAP.md": "x".repeat(500),
			"ok/.git/HEAD": "",
			"ok/.planning/STATE.md": STATE,
		});
		const runner = runnerFor(root, { big: "Acme/Big", ok: "Acme/Ok" });
		const result = collectDigests({ roots: [root], repos: [], maxBytes: 400, runner });
		expect(result.digests.map((digest) => digest.repo)).toEqual(["Acme/Ok"]);
		expect(result.skipped).toEqual([{ repo: "Acme/Big", reason: "roadmap-too-large" }]);
		const failing = collectDigests({
			roots: [root],
			repos: ["Acme/Ok"],
			maxBytes: MAX_BYTES,
			runner,
			readFile: () => {
				throw new Error("disk went away");
			},
		});
		expect(failing.digests).toEqual([]);
		expect(failing.skipped).toEqual([{ repo: "Acme/Ok", reason: "state-unreadable" }]);
	});

	test("a label that a checkout and a copy collection both yield is not digested", () => {
		const rootA = make({ "x/.git/HEAD": "", "x/.planning/STATE.md": STATE });
		const rootB = make({ "x/README.md": "# a plain copy\n" });
		const runner = runnerFor(rootA, { x: null });
		const result = collectDigests({ roots: [rootA, rootB], repos: [], maxBytes: MAX_BYTES, runner });
		expect(result.digests).toEqual([]);
		expect(result.skipped.map((skip) => skip.reason)).toEqual(["duplicate-label"]);
	});

	test("a root that is not a directory is a note, not a failure of the run", () => {
		const root = make({ "alpha/.git/HEAD": "", "alpha/.planning/STATE.md": STATE });
		const runner = runnerFor(root, { alpha: "Acme/Alpha" });
		const result = collectDigests({ roots: [root, join(root, "nope")], repos: [], maxBytes: MAX_BYTES, runner });
		expect(result.digests).toHaveLength(1);
		expect(result.notes.some((note) => note.includes("is not a directory"))).toBe(true);
	});
});

describe("executeReflect", () => {
	const stub = new CorpusStub();
	afterAll(() => stub.stop());

	const client = () => createCorpusClient({ url: stub.url, token: "tok-1", timeoutMs: 2000 });

	function digest(repo: string): RepoDigest {
		return { repo, path: ".substrate/digest.md", text: `# digest ${repo}\n`, key: `corpus-digest:${repo}`, sha256: "a".repeat(64) };
	}

	function sentRepos(seen: { body: unknown }): string[] {
		if (!isRecord(seen.body) || !Array.isArray(seen.body.digests)) throw new Error("not a reflect request");
		return seen.body.digests.map((item) => (isRecord(item) ? String(item.repo) : ""));
	}

	test("sends repo, text and sha256 only and counts each answer", async () => {
		stub.seen = [];
		stub.on("POST /corpus/reflect", () => ({
			status: 200,
			body: reflectOf([
				{ repo: "Acme/A", status: "stored" },
				{ repo: "Acme/B", status: "unchanged" },
				{ repo: "Acme/C", status: "refused", reason: "secret-findings" },
				{ repo: "Acme/D", status: "failed", reason: "plane-unavailable" },
			]),
		}));
		const outcome = await executeReflect({ digests: ["Acme/A", "Acme/B", "Acme/C", "Acme/D"].map(digest), client: client() });
		expect(outcome.fatal).toBeNull();
		expect(outcome.summary.counts).toEqual({ stored: 1, unchanged: 1, refused: 1, failed: 1 });
		expect(outcome.summary.problems).toEqual([
			{ repo: "Acme/C", status: "refused", reason: "secret-findings" },
			{ repo: "Acme/D", status: "failed", reason: "plane-unavailable" },
		]);
		expect(outcome.summary.manifestVersion).toBe(11);
		const sent = defined(stub.requests("/corpus/reflect")[0], "request");
		expect(sent.authorization).toBe("Bearer tok-1");
		expect(sent.body).toEqual({
			protocol: CORPUS_PROTOCOL,
			digests: ["Acme/A", "Acme/B", "Acme/C", "Acme/D"].map((repo) => ({ repo, text: `# digest ${repo}\n`, sha256: "a".repeat(64) })),
		});
	});

	test("a digest the server gave no answer for is failed, never stored", async () => {
		stub.on("POST /corpus/reflect", () => ({ status: 200, body: reflectOf([{ repo: "Acme/A", status: "stored" }]) }));
		const outcome = await executeReflect({ digests: [digest("Acme/A"), digest("Acme/B")], client: client() });
		expect(outcome.summary.counts).toEqual({ stored: 1, unchanged: 0, refused: 0, failed: 1 });
		expect(outcome.summary.problems).toEqual([{ repo: "Acme/B", status: "failed", reason: "no-result" }]);
	});

	test("more digests than the server accepts go in several requests of at most the limit", async () => {
		stub.seen = [];
		stub.on("POST /corpus/reflect", (seen) => ({ status: 200, body: reflectOf(sentRepos(seen).map((repo) => ({ repo, status: "stored" as const }))) }));
		const many = Array.from({ length: MAX_REFLECT_DIGESTS + 3 }, (_, index) => digest(`Acme/R${index}`));
		const outcome = await executeReflect({ digests: many, client: client() });
		const requests = stub.requests("/corpus/reflect");
		expect(requests.map((seen) => sentRepos(seen).length)).toEqual([MAX_REFLECT_DIGESTS, 3]);
		expect(outcome.summary.counts.stored).toBe(MAX_REFLECT_DIGESTS + 3);
	});

	test("a request that fails as a whole stops the run and counts what was not sent", async () => {
		stub.seen = [];
		let calls = 0;
		stub.on("POST /corpus/reflect", (seen) => {
			calls += 1;
			return calls === 1 ? { status: 200, body: reflectOf(sentRepos(seen).map((repo) => ({ repo, status: "stored" as const }))) } : { status: 503, body: { error: "unavailable" } };
		});
		const many = Array.from({ length: MAX_REFLECT_DIGESTS * 2 + 5 }, (_, index) => digest(`Acme/R${index}`));
		const outcome = await executeReflect({ digests: many, client: client() });
		expect(outcome.fatal?.kind).toBe("unavailable");
		expect(outcome.summary.counts.stored).toBe(MAX_REFLECT_DIGESTS);
		expect(outcome.summary.notSent).toBe(MAX_REFLECT_DIGESTS + 5);
		expect(stub.requests("/corpus/reflect")).toHaveLength(2);
	});

	test("no digests means no request", async () => {
		stub.seen = [];
		const outcome = await executeReflect({ digests: [], client: client() });
		expect(outcome.summary.counts).toEqual({ stored: 0, unchanged: 0, refused: 0, failed: 0 });
		expect(stub.seen).toEqual([]);
	});
});
