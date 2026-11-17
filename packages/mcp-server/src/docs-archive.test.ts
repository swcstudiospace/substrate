/**
 * The RAGFlow archive writer and checksum verifier (SOTA-02, Phase 46, Task 3), driven by the RAGFlow fake and a real
 * git repository. The checks are behavioural: a verified round trip, a refusal on each kind of drift, refusals that
 * happen before any write, and a page whose committed bytes no longer match the hash the ingest recorded.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ragflowArchiveFromEnv } from "./config.ts";
import { archiveRagflow, gitAtCommit, MANIFEST_FILE, ragflowArchiveSource, verifyArchive, type ArchiveDeps, type RagflowArchiveSource } from "./docs-archive.ts";
import { changeSha, saveIngestRecords, stripRemoteImages, type IngestRecord } from "./docs-ingest.ts";
import { RagflowFake } from "./ragflow-fake.ts";

const CONFIG = { url: "http://ragflow.test", apiKey: "test-key" };
const DATASET = "ds-berlin-agent-substrate";
const SOURCE = "https://example.com/plan";
const PAGE = "# Plan\n\nThe plan lives in PLAN.md.\n";
const QUERIES = [
	{ id: "q-01", question: "where is the plan?" },
	{ id: "q-02", question: "who reads the plan?" },
];
/** A release root that does not exist, so `refusedMount` never compares against this machine's /opt tree. */
const NO_RELEASE_ROOT = join(tmpdir(), "substrate-archive-test-no-release-root");

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "substrate-archive-"));
	scratch.push(dir);
	return dir;
}

/** A git repo holding one page under `docs/`, committed; returns its root and the commit that holds it. */
function repoWith(body: string): { root: string; commit: string } {
	const root = scratchDir();
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs", "plan.md"), body);
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
	git("init", "-q");
	git("add", "docs/plan.md");
	git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "page");
	return { root, commit: git("rev-parse", "HEAD") };
}

/** The docs state file the archive copies, holding the page's ingest record under the given hash. */
async function stateFile(root: string, sha: string): Promise<string> {
	const file = join(root, "docs-ingest.json");
	const record: IngestRecord = { sha, dataset_id: DATASET, source_url: SOURCE, document_id: "doc-plan", version: 1 };
	await saveIngestRecords(file, new Map([[`${DATASET}::${SOURCE}`, record]]));
	return file;
}

/** A RAGFlow plane holding the page as one document with its ingest metadata, and a retrieval answer for it. */
function plane(commit: string): RagflowFake {
	const fake = new RagflowFake();
	fake.documents["doc-plan"] = { id: "doc-plan", dataset_id: DATASET, name: "docs__plan.md", run: "DONE", polls: 0, meta_fields: { source_url: SOURCE, commit, heading_path: "Plan" } };
	fake.chunks[DATASET] = [{ document_id: "doc-plan", document_name: "docs__plan.md", content: PAGE, source_url: SOURCE, heading_path: "Plan", score: 0.9 }];
	return fake;
}

function depsFor(source: RagflowArchiveSource, repoRoot: string, stateFilePath: string | null, overrides: Partial<ArchiveDeps> = {}): ArchiveDeps {
	return { source, stateFile: stateFilePath, queries: QUERIES, repoRoot, releaseRoot: NO_RELEASE_ROOT, allowRootfs: true, ...overrides };
}

/** A complete, verified archive of the page, for the verifier tests to drift. */
async function archived(): Promise<{ dir: string }> {
	const repo = repoWith(PAGE);
	const file = await stateFile(repo.root, changeSha(stripRemoteImages(PAGE).body, undefined));
	const dir = join(scratchDir(), "archive");
	const outcome = await archiveRagflow(depsFor(ragflowArchiveSource(CONFIG, plane(repo.commit).fetch), repo.root, file), dir);
	if (!outcome.ok) throw new Error(outcome.reason);
	return { dir };
}

describe("RAGFlow archive writer", () => {
	test("the manifest checksums every file it lists, reads back verified, and names no RAGFlow hostname or key", async () => {
		const repo = repoWith(PAGE);
		const file = await stateFile(repo.root, changeSha(stripRemoteImages(PAGE).body, undefined));
		const dir = join(scratchDir(), "archive");
		const outcome = await archiveRagflow(depsFor(ragflowArchiveSource(CONFIG, plane(repo.commit).fetch), repo.root, file), dir);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.page_mismatches).toBe(0);
		expect(verifyArchive(dir)).toEqual({ ok: true, mismatches: [] });

		const manifestBytes = readFileSync(join(dir, MANIFEST_FILE));
		expect(outcome.manifest_sha256).toBe(createHash("sha256").update(manifestBytes).digest("hex"));
		const manifest = JSON.parse(manifestBytes.toString("utf8")) as { files: Array<{ path: string; bytes: number; sha256: string }> };
		expect(manifest.files.map((entry) => entry.path)).toEqual(
			expect.arrayContaining(["baseline/q-01.json", "baseline/q-02.json", "inventory/agent-substrate.json", "pages.json", "state/docs-ingest.json"]),
		);
		for (const entry of manifest.files) {
			const data = readFileSync(join(dir, entry.path));
			expect(data.length).toBe(entry.bytes);
			expect(createHash("sha256").update(data).digest("hex")).toBe(entry.sha256);
		}
		expect(manifestBytes.toString("utf8")).not.toContain("ragflow.test");
		expect(manifestBytes.toString("utf8")).not.toContain("test-key");

		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "baseline", "q-01.json")).mode & 0o777).toBe(0o600);
		const pages = JSON.parse(readFileSync(join(dir, "pages.json"), "utf8")) as { checks: Array<{ document_id: string; match: boolean }> };
		expect(pages.checks).toEqual([expect.objectContaining({ document_id: "doc-plan", match: true })]);
	});

	test("a page whose committed bytes differ from its recorded hash is reported, and the archive itself still verifies", async () => {
		const repo = repoWith(PAGE);
		const file = await stateFile(repo.root, changeSha(stripRemoteImages("# Plan\n\nAn older body.\n").body, undefined));
		const dir = join(scratchDir(), "archive");
		const outcome = await archiveRagflow(depsFor(ragflowArchiveSource(CONFIG, plane(repo.commit).fetch), repo.root, file), dir);
		if (!outcome.ok) throw new Error(outcome.reason);
		expect(outcome.page_mismatches).toBe(1);
		const pages = JSON.parse(readFileSync(join(dir, "pages.json"), "utf8")) as { checks: Array<Record<string, unknown>> };
		expect(pages.checks[0]).toMatchObject({ document_id: "doc-plan", match: false });
		expect(pages.checks[0]?.recorded_sha256).not.toBe(pages.checks[0]?.git_sha256);
		expect(verifyArchive(dir).ok).toBe(true);
	});

	test("refusals come before any write: an unset directory, no docs state, a non-empty target and a root-filesystem target", async () => {
		const repo = repoWith(PAGE);
		const file = await stateFile(repo.root, changeSha(stripRemoteImages(PAGE).body, undefined));
		const source = ragflowArchiveSource(CONFIG, plane(repo.commit).fetch);

		expect(await archiveRagflow(depsFor(source, repo.root, file), null)).toEqual({
			ok: false,
			reason: expect.stringContaining("SUBSTRATE_RAGFLOW_ARCHIVE_DIR"),
		});
		expect(await archiveRagflow(depsFor(source, repo.root, null), join(scratchDir(), "no-state"))).toEqual({
			ok: false,
			reason: expect.stringContaining("SUBSTRATE_DOCS_STATE_FILE"),
		});

		const busy = join(scratchDir(), "busy");
		mkdirSync(busy);
		writeFileSync(join(busy, "keep.txt"), "already here");
		expect(await archiveRagflow(depsFor(source, repo.root, file), busy)).toEqual({ ok: false, reason: expect.stringContaining("not empty") });
		expect(readFileSync(join(busy, "keep.txt"), "utf8")).toBe("already here");
		expect(existsSync(join(busy, MANIFEST_FILE))).toBe(false);

		const onRoot = join(scratchDir(), "root-disk");
		expect(await archiveRagflow(depsFor(source, repo.root, file, { allowRootfs: false, dev: () => 7 }), onRoot)).toEqual({
			ok: false,
			reason: expect.stringContaining("root filesystem"),
		});
		expect(existsSync(onRoot)).toBe(false);
	});

	test("a directory on another filesystem is accepted without the root-filesystem override", async () => {
		const repo = repoWith(PAGE);
		const file = await stateFile(repo.root, changeSha(stripRemoteImages(PAGE).body, undefined));
		const dir = join(scratchDir(), "mounted");
		const outcome = await archiveRagflow(
			depsFor(ragflowArchiveSource(CONFIG, plane(repo.commit).fetch), repo.root, file, { allowRootfs: false, dev: (path) => (path === "/" ? 1 : 2) }),
			dir,
		);
		expect(outcome.ok).toBe(true);
		expect(verifyArchive(dir).ok).toBe(true);
	});

	test("a RAGFlow listing failure and a failed baseline query each refuse the whole archive, and nothing is written", async () => {
		const repo = repoWith(PAGE);
		const file = await stateFile(repo.root, changeSha(stripRemoteImages(PAGE).body, undefined));
		const real = ragflowArchiveSource(CONFIG, plane(repo.commit).fetch);

		const listing = join(scratchDir(), "listing");
		const unreachable: RagflowArchiveSource = { ...real, listDatasets: async () => ({ ok: false, reason: "ragflow: unreachable" }) };
		expect(await archiveRagflow(depsFor(unreachable, repo.root, file), listing)).toEqual({ ok: false, reason: "ragflow: unreachable" });
		expect(existsSync(listing)).toBe(false);

		const baseline = join(scratchDir(), "baseline");
		const partial: RagflowArchiveSource = {
			...real,
			retrieve: (question, ids) => (question === "who reads the plan?" ? Promise.resolve({ ok: false, reason: "ragflow 500" }) : real.retrieve(question, ids)),
		};
		expect(await archiveRagflow(depsFor(partial, repo.root, file), baseline)).toEqual({ ok: false, reason: "baseline q-02: ragflow 500" });
		expect(existsSync(baseline)).toBe(false);
	});

	test("the git reader passes only a commit hash and a repo-relative path to git, and reads the page as committed", () => {
		const repo = repoWith(PAGE);
		const read = gitAtCommit(repo.root);
		expect(read(repo.commit, "docs/plan.md")?.toString("utf8")).toBe(PAGE);
		expect(read(`--output=${join(scratchDir(), "written")}`, "docs/plan.md")).toBeNull();
		expect(read(repo.commit, "../outside.md")).toBeNull();
	});
});

describe("RAGFlow archive verifier", () => {
	test("passes on an untouched archive", async () => {
		const { dir } = await archived();
		expect(verifyArchive(dir)).toEqual({ ok: true, mismatches: [] });
	});

	test("fails on a one-byte change to a listed file and names the file", async () => {
		const { dir } = await archived();
		const target = join(dir, "baseline", "q-01.json");
		const changed = Buffer.from(readFileSync(target));
		changed[changed.length - 2] = (changed[changed.length - 2] ?? 0) ^ 0x01;
		writeFileSync(target, changed);
		expect(verifyArchive(dir)).toEqual({
			ok: false,
			mismatches: [{ path: "baseline/q-01.json", reason: "sha256 differs from the manifest" }],
		});
	});

	test("fails on a file the manifest does not list", async () => {
		const { dir } = await archived();
		writeFileSync(join(dir, "stray.txt"), "not in the manifest");
		expect(verifyArchive(dir)).toEqual({
			ok: false,
			mismatches: [{ path: "stray.txt", reason: "unlisted: the manifest does not name this file" }],
		});
	});

	test("fails on a manifest entry that climbs out of the archive directory", async () => {
		const { dir } = await archived();
		const manifestPath = join(dir, MANIFEST_FILE);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { files: unknown[] };
		manifest.files.push({ path: "../escape.txt", bytes: 0, sha256: createHash("sha256").update("").digest("hex") });
		writeFileSync(manifestPath, JSON.stringify(manifest));
		expect(verifyArchive(dir)).toEqual({
			ok: false,
			mismatches: [{ path: "../escape.txt", reason: "unsafe path: it leaves the archive directory" }],
		});
	});

	test("fails when the manifest is missing", async () => {
		const { dir } = await archived();
		rmSync(join(dir, MANIFEST_FILE));
		expect(verifyArchive(dir)).toEqual({ ok: false, mismatches: [{ path: MANIFEST_FILE, reason: "manifest missing or unreadable" }] });
	});
});

describe("RAGFlow archive environment", () => {
	test("the directory is unset unless named, and the root-filesystem override accepts only 1, true or yes", () => {
		expect(ragflowArchiveFromEnv({})).toEqual({ dir: null, allowRootfs: false });
		expect(ragflowArchiveFromEnv({ SUBSTRATE_RAGFLOW_ARCHIVE_DIR: "   " })).toEqual({ dir: null, allowRootfs: false });
		expect(ragflowArchiveFromEnv({ SUBSTRATE_RAGFLOW_ARCHIVE_DIR: "/mnt/archive" }).dir).toBe("/mnt/archive");
		for (const value of ["1", "true", "YES"]) expect(ragflowArchiveFromEnv({ SUBSTRATE_RAGFLOW_ARCHIVE_ALLOW_ROOTFS: value }).allowRootfs).toBe(true);
		for (const value of ["0", "no", "on", ""]) expect(ragflowArchiveFromEnv({ SUBSTRATE_RAGFLOW_ARCHIVE_ALLOW_ROOTFS: value }).allowRootfs).toBe(false);
	});
});
