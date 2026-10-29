/**
 * The corpus manifest against a real Postgres: the upsert, the state transitions, the version that only grows and the
 * reference count the delete decision rests on. None of that can be shown against a fake, so these tests skip unless a
 * database is given:
 *
 *     SUBSTRATE_TEST_PG_URL=postgres://… bun test corpus/store
 *
 * The table is the real migration; every row is namespaced to one run's repo names and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { IndexStore } from "../index-store.ts";
import { defined } from "../test-support.ts";
import type { CorpusStore, RecordedDocument } from "./store.ts";
import { toManifestRow } from "./store.ts";

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const MARKER = `ut-corpus-${Date.now().toString(36)}`;
const REPO = `${MARKER}/docs`;
const OTHER = `${MARKER}/other`;

const describeLive = PG_URL ? describe : describe.skip;

let index: IndexStore;
let store: CorpusStore;
let cleanup: SQL;

function doc(path: string, over: Partial<RecordedDocument> = {}): RecordedDocument {
	return { repo: REPO, path, kind: "doc", tier: 1, sha256: "a".repeat(64), bytes: 12, source: "fs", commit: "abc1234", documentId: `doc-${MARKER}-${path}`, ...over };
}

describe("toManifestRow", () => {
	const record = { repo: "a/b", path: "x.md", kind: "doc", tier: 2, sha256: "f".repeat(64), bytes: 5, source: "github", commit_sha: null, state: "active", docs_document_id: "doc-1", manifest_seq: "42" };

	test("reads a database row, with the bigint sequence as a string and a null commit", () => {
		expect(toManifestRow(record)).toEqual({ repo: "a/b", path: "x.md", kind: "doc", tier: 2, sha256: "f".repeat(64), bytes: 5, source: "github", commit: null, state: "active", documentId: "doc-1", manifestSeq: 42 });
	});

	test("a row holding a value outside the closed lists is dropped, never guessed at", () => {
		expect(toManifestRow({ ...record, kind: "wiki" })).toBeNull();
		expect(toManifestRow({ ...record, tier: 9 })).toBeNull();
		expect(toManifestRow({ ...record, source: "svn" })).toBeNull();
		expect(toManifestRow({ ...record, state: "deleted" })).toBeNull();
	});
});

describeLive("the corpus manifest against a live index", () => {
	beforeAll(async () => {
		index = new IndexStore(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
		await index.migrate();
		store = index.corpusStore();
		cleanup = new SQL(defined(PG_URL, "SUBSTRATE_TEST_PG_URL"));
	});

	afterAll(async () => {
		if (!PG_URL) return;
		await cleanup`delete from corpus_documents where repo like ${`${MARKER}/%`}`.catch(() => undefined);
		await cleanup.close().catch(() => undefined);
		await index.close().catch(() => undefined);
	});

	test("a recorded document round-trips through rowFor and rowsForRepos", async () => {
		await store.recordIngested(doc("README.md", { tier: 2, commit: undefined }));
		await store.recordIngested(doc("other.md", { repo: OTHER }));
		expect(await store.rowFor(REPO, "README.md")).toMatchObject({ repo: REPO, path: "README.md", kind: "doc", tier: 2, sha256: "a".repeat(64), bytes: 12, source: "fs", commit: null, state: "active", documentId: `doc-${MARKER}-README.md` });
		const scoped = await store.rowsForRepos([REPO]);
		expect(scoped.map((row) => row.path)).toEqual(["README.md"]);
		expect(await store.rowFor(REPO, "missing.md")).toBeNull();
		expect(await store.rowsForRepos([])).toEqual([]);
	});

	test("recording the same key again replaces the row in place and returns it to active", async () => {
		await store.recordIngested(doc("changing.md"));
		await store.recordIngested(doc("changing.md", { sha256: "b".repeat(64), documentId: `doc-${MARKER}-changing-2` }));
		const row = defined(await store.rowFor(REPO, "changing.md"), "the row");
		expect({ sha: row.sha256, id: row.documentId, state: row.state }).toEqual({ sha: "b".repeat(64), id: `doc-${MARKER}-changing-2`, state: "active" });
		const all = await store.rowsForRepos([REPO]);
		expect(all.filter((entry) => entry.path === "changing.md")).toHaveLength(1);
	});

	test("refreshMetadata rewrites kind, tier, source and commit of the active row at the same sha256 and bumps the version; any other state or sha is untouched", async () => {
		await store.recordIngested(doc("refresh.md", { source: "github", commit: "aaa1111" }));
		const before = await store.manifestVersion();
		const refreshed = { repo: REPO, path: "refresh.md", sha256: "a".repeat(64), kind: "runbook" as const, tier: 2 as const, source: "fs" as const, commit: "bbb2222" };
		expect(await store.refreshMetadata(refreshed)).toBe(true);
		expect(await store.rowFor(REPO, "refresh.md")).toMatchObject({ kind: "runbook", tier: 2, source: "fs", commit: "bbb2222", state: "active", documentId: `doc-${MARKER}-refresh.md` });
		expect(await store.manifestVersion()).toBeGreaterThan(before);
		expect(await store.refreshMetadata({ ...refreshed, sha256: "c".repeat(64) })).toBe(false);
		await store.markTombstoned(REPO, "refresh.md");
		expect(await store.refreshMetadata(refreshed)).toBe(false);
		expect(await store.refreshMetadata({ ...refreshed, path: "never-existed.md" })).toBe(false);
	});

	test("a tombstone changes an active row once, a second one is a no-op, and a re-record makes it active again", async () => {
		await store.recordIngested(doc("short-lived.md"));
		expect(await store.markTombstoned(REPO, "short-lived.md")).toBe(true);
		expect((await store.rowFor(REPO, "short-lived.md"))?.state).toBe("tombstoned");
		expect(await store.markTombstoned(REPO, "short-lived.md")).toBe(false);
		expect(await store.markTombstoned(REPO, "never-existed.md")).toBe(false);
		await store.recordIngested(doc("short-lived.md"));
		expect((await store.rowFor(REPO, "short-lived.md"))?.state).toBe("active");
	});

	test("the manifest version grows with every write that changes a row and never shrinks", async () => {
		const first = await store.manifestVersion();
		await store.recordIngested(doc("v1.md"));
		const second = await store.manifestVersion();
		await store.markTombstoned(REPO, "v1.md");
		const third = await store.manifestVersion();
		await store.markTombstoned(REPO, "v1.md");
		const fourth = await store.manifestVersion();
		expect(second).toBeGreaterThan(first);
		expect(third).toBeGreaterThan(second);
		expect(fourth).toBe(third);
		expect((await store.rowFor(REPO, "v1.md"))?.manifestSeq).toBe(third);
	});

	test("activeReferences counts only active rows that hold the plane document id", async () => {
		const shared = `doc-${MARKER}-shared`;
		await store.recordIngested(doc("one.md", { documentId: shared }));
		await store.recordIngested(doc("two.md", { documentId: shared }));
		expect(await store.activeReferences(shared)).toBe(2);
		await store.markTombstoned(REPO, "two.md");
		expect(await store.activeReferences(shared)).toBe(1);
		await store.markTombstoned(REPO, "one.md");
		expect(await store.activeReferences(shared)).toBe(0);
		expect(await store.activeReferences(`doc-${MARKER}-unknown`)).toBe(0);
	});

	test("status counts this run's rows by state, kind and tier, and names the manifest version", async () => {
		const status = await store.status();
		expect(status.total).toBe(status.active + status.tombstoned);
		expect(status.byRepo.find((entry) => entry.repo === REPO)?.tombstoned).toBeGreaterThan(0);
		expect(status.byKind.some((entry) => entry.kind === "doc" && entry.count > 0)).toBe(true);
		expect(status.byTier.some((entry) => entry.tier === 1 && entry.count > 0)).toBe(true);
		expect(status.manifestVersion).toBe(await store.manifestVersion());
		expect(typeof status.lastIngestAt).toBe("string");
	});
});
