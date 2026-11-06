/**
 * The corpus reconcile (v1.7 phase 65): the pure drift rules, then the run against the in-memory manifest and the fake plane.
 * The rules that matter are the ones about absence: a missing document is only asserted from a complete listing, an orphan
 * only from a complete read of the manifest, and nothing outside the `corpus:` namespace is ever named or deleted.
 */
import { describe, expect, test } from "bun:test";
import { CORPUS_PROTOCOL, RECONCILE_MAX_ITEMS, corpusDocumentName, type CorpusDocument, type CorpusScope } from "@substrate/corpus";
import { defined } from "../test-support.ts";
import { ingestCorpus, type CorpusIngestSettings } from "./ingest.ts";
import { planCorpus } from "./plan.ts";
import { RECONCILE_MAX_ROWS, diffPlane, reconcileCorpus } from "./reconcile.ts";
import type { ManifestRow } from "./store.ts";
import { FakePlane, FakeStore, entryOf, makeDocument, makeRow, sha256Hex } from "./testkit.ts";

const REPO = "swcstudiospace/agent-substrate";
const SETTINGS: CorpusIngestSettings = { concurrency: 4, batchDocs: 20, batchBytes: 1_000_000 };
const SCOPE: CorpusScope = { coverage: [{ repo: REPO, source: "fs" }], maxTier: 3 };

const nameOf = (document: CorpusDocument): string => corpusDocumentName(document.repo, document.path, document.sha256);

function ingestDeps(store: FakeStore, plane: FakePlane) {
	return { store, plane, settings: SETTINGS, surface: "claude-code" as const, sessionId: "sess-reconcile", emit: async () => undefined };
}

/** A manifest and a plane that agree: every path was ingested through the real ingest. */
async function ingested(paths: readonly string[]) {
	const store = new FakeStore();
	const plane = new FakePlane();
	const documents = paths.map((path) => makeDocument(REPO, path, `body of ${path}`));
	await ingestCorpus(ingestDeps(store, plane), { protocol: CORPUS_PROTOCOL, documents, tombstones: [] });
	return { store, plane, documents };
}

function rowOf(path: string, documentId: string | null, over: Partial<ManifestRow> = {}): ManifestRow {
	return makeRow({ repo: REPO, path, sha256: sha256Hex(path), documentId, ...over });
}

function listed(row: ManifestRow, id: string = row.documentId ?? "doc-none") {
	return { id, name: corpusDocumentName(row.repo, row.path, row.sha256) };
}

describe("diffPlane", () => {
	test("a row whose plane document is listed, and a listed document its row owns, are both in agreement", () => {
		const row = rowOf("a.md", "doc-a");
		expect(diffPlane([row], { documents: [listed(row)], otherDocumentIds: [], truncated: false }, true)).toEqual({ missing: [], orphans: [], checked: 1 });
	});

	test("a row whose plane document is not in a complete listing is missing", () => {
		const row = rowOf("a.md", "doc-a");
		expect(diffPlane([row], { documents: [], otherDocumentIds: [], truncated: false }, true).missing).toEqual([row]);
	});

	test("two rows that share one plane document (identical text) are both present when it is listed once", () => {
		const first = rowOf("a.md", "doc-a");
		const second = rowOf("copy-of-a.md", "doc-a");
		const drift = diffPlane([first, second], { documents: [listed(first)], otherDocumentIds: [], truncated: false }, true);
		expect(drift).toEqual({ missing: [], orphans: [], checked: 2 });
	});

	test("a row that shares a document another door stored is present: foreign ids count as presence and their names are never seen", () => {
		const row = rowOf("a.md", "doc-foreign");
		const drift = diffPlane([row], { documents: [], otherDocumentIds: ["doc-foreign"], truncated: false }, true);
		expect(drift.missing).toEqual([]);
	});

	test("a corpus document no row owns by id or by name is an orphan; one carrying the name of a row's current content is owned, whatever its id", () => {
		const row = rowOf("a.md", "doc-a");
		const stale = { id: "doc-old", name: corpusDocumentName(REPO, "a.md", sha256Hex("an earlier version")) };
		const duplicateRecord = { id: "dup-1", name: corpusDocumentName(row.repo, row.path, row.sha256) };
		const drift = diffPlane([row], { documents: [listed(row), stale, duplicateRecord], otherDocumentIds: [], truncated: false }, true);
		expect(drift.orphans).toEqual([stale]);
	});

	test("orphans come out ordered by name, and never a name outside the corpus namespace", () => {
		const later = { id: "doc-z", name: corpusDocumentName(REPO, "z.md", sha256Hex("z")) };
		const earlier = { id: "doc-b", name: corpusDocumentName(REPO, "b.md", sha256Hex("b")) };
		const foreign = { id: "doc-f", name: "docs__readme.md" };
		const drift = diffPlane([], { documents: [later, foreign, earlier], otherDocumentIds: [], truncated: false }, true);
		expect(drift.orphans).toEqual([earlier, later]);
	});

	test("a truncated listing asserts no missing document, but an orphan it did show is still an orphan", () => {
		const row = rowOf("a.md", "doc-a");
		const stray = { id: "doc-x", name: corpusDocumentName(REPO, "x.md", sha256Hex("x")) };
		const drift = diffPlane([row], { documents: [stray], otherDocumentIds: [], truncated: true }, true);
		expect(drift.missing).toEqual([]);
		expect(drift.orphans).toEqual([stray]);
	});

	test("a partly read manifest asserts no orphan, because an unread row may own the document, but still finds a missing one", () => {
		const row = rowOf("a.md", "doc-a");
		const stray = { id: "doc-x", name: corpusDocumentName(REPO, "x.md", sha256Hex("x")) };
		const drift = diffPlane([row], { documents: [stray], otherDocumentIds: [], truncated: false }, false);
		expect(drift.orphans).toEqual([]);
		expect(drift.missing).toEqual([row]);
	});

	test("a row that never reached the plane (no document id) is neither compared nor missing", () => {
		const unplaced = rowOf("a.md", null);
		expect(diffPlane([unplaced], { documents: [], otherDocumentIds: [], truncated: false }, true)).toEqual({ missing: [], orphans: [], checked: 0 });
	});
});

describe("reconcileCorpus", () => {
	test("a dry run reports the missing row and the orphan and changes nothing", async () => {
		const { store, plane, documents } = await ingested(["a.md", "b.md"]);
		const lost = defined(documents[0], "a.md");
		plane.vanish(nameOf(lost));
		plane.plant(corpusDocumentName(REPO, "stray.md", sha256Hex("stray")));
		const deletesBefore = plane.deletes.length;

		const result = await reconcileCorpus({ store, plane }, false);
		if (!result.ok) throw new Error("expected a result");
		expect(result.body.drift).toEqual({ missingInPlane: [{ repo: REPO, path: "a.md" }], orphansInPlane: [corpusDocumentName(REPO, "stray.md", sha256Hex("stray"))], checked: 2, truncated: false });
		expect(result.body.repaired).toEqual({ requeued: 0, deleted: 0 });
		expect(store.row(REPO, "a.md")?.state).toBe("active");
		expect(plane.deletes).toHaveLength(deletesBefore);
	});

	test("execute marks the missing row removed without calling the plane, deletes the orphan, leaves a foreign document alone, and the next plan offers the row as an add", async () => {
		const { store, plane, documents } = await ingested(["a.md", "b.md"]);
		const lost = defined(documents[0], "a.md");
		plane.vanish(nameOf(lost));
		const orphanName = corpusDocumentName(REPO, "stray.md", sha256Hex("stray"));
		const orphanId = plane.plant(orphanName);
		const foreignId = plane.plant("docs__someone-elses.md");

		const result = await reconcileCorpus({ store, plane }, true);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.body.repaired).toEqual({ requeued: 1, deleted: 1 });
		expect(store.row(REPO, "a.md")?.state).toBe("tombstoned");
		expect(store.row(REPO, "b.md")?.state).toBe("active");
		// The plane was asked to delete the orphan and only the orphan: the lost row's document is already gone.
		expect(plane.deletes).toEqual([[orphanId]]);
		expect(plane.liveIds().has(foreignId)).toBe(true);

		const plan = planCorpus([entryOf(lost)], SCOPE, await store.rowsForRepos([REPO]));
		expect(plan.counts.add).toBe(1);
	});

	test("once repaired the document goes back through the ordinary ingest and the plane holds it again", async () => {
		const { store, plane, documents } = await ingested(["a.md"]);
		const lost = defined(documents[0], "a.md");
		plane.vanish(nameOf(lost));
		await reconcileCorpus({ store, plane }, true);
		const again = await ingestCorpus(ingestDeps(store, plane), { protocol: CORPUS_PROTOCOL, documents: [lost], tombstones: [] });
		expect(again.counts.ingested).toBe(1);
		expect(plane.documents.has(nameOf(lost))).toBe(true);
		expect(store.row(REPO, "a.md")?.state).toBe("active");
		const settled = await reconcileCorpus({ store, plane }, false);
		if (!settled.ok) throw new Error("expected a result");
		expect(settled.body.drift).toMatchObject({ missingInPlane: [], orphansInPlane: [] });
	});

	test("a live id missing from a complete listing is not marked removed, and a failed lookup leaves the row alone", async () => {
		const { store, plane, documents } = await ingested(["a.md", "b.md"]);
		const hidden = defined(documents[0], "a.md");
		const hiddenId = store.row(REPO, "a.md")?.documentId;
		if (hiddenId === null || hiddenId === undefined) throw new Error("expected a document id");
		plane.hiddenFromListing.add(hiddenId);
		const kept = await reconcileCorpus({ store, plane }, true);
		if (!kept.ok) throw new Error("expected a result");
		expect(kept.body.drift.missingInPlane).toEqual([]);
		expect(store.row(REPO, hidden.path)?.state).toBe("active");

		plane.hiddenFromListing.delete(hiddenId);
		plane.vanish(nameOf(hidden));
		plane.lookupUnknown.add(hiddenId);
		const unknown = await reconcileCorpus({ store, plane }, true);
		if (!unknown.ok) throw new Error("expected a result");
		expect(unknown.body.drift.missingInPlane).toEqual([]);
		expect(unknown.body.drift.truncated).toBe(true);
		expect(store.row(REPO, hidden.path)?.state).toBe("active");
	});

	test("a delete the plane refused, or did not confirm, is not counted as repaired and the orphan is reported again by the next run", async () => {
		const { store, plane } = await ingested(["a.md"]);
		const refused = plane.plant(corpusDocumentName(REPO, "refused.md", sha256Hex("refused")));
		const unconfirmed = plane.plant(corpusDocumentName(REPO, "unconfirmed.md", sha256Hex("unconfirmed")));
		plane.failDeleteIds.add(refused);
		plane.unconfirmedDeleteIds.add(unconfirmed);

		const first = await reconcileCorpus({ store, plane }, true);
		if (!first.ok) throw new Error("expected a result");
		expect(first.body.drift.orphansInPlane).toHaveLength(2);
		expect(first.body.repaired.deleted).toBe(0);

		// The unconfirmed one did go from the plane (the fake models a wait that timed out after the delete); the refused one did not.
		const second = await reconcileCorpus({ store, plane }, false);
		if (!second.ok) throw new Error("expected a result");
		expect(second.body.drift.orphansInPlane).toEqual([corpusDocumentName(REPO, "refused.md", sha256Hex("refused"))]);
	});

	test("an orphan an active row holds by the time of the delete is kept", async () => {
		class ClaimedStore extends FakeStore {
			override async activeReferences(): Promise<number> {
				return 1;
			}
		}
		const store = new ClaimedStore();
		const plane = new FakePlane();
		plane.plant(corpusDocumentName(REPO, "stray.md", sha256Hex("stray")));
		const result = await reconcileCorpus({ store, plane }, true);
		if (!result.ok) throw new Error("expected a result");
		expect(result.body.drift.orphansInPlane).toHaveLength(1);
		expect(result.body.repaired.deleted).toBe(0);
		expect(plane.deletes).toEqual([]);
	});

	test("a row that is no longer the one the drift described is left alone, and one that cannot be marked does not stop the others", async () => {
		const { store, plane, documents } = await ingested(["a.md", "b.md", "c.md"]);
		for (const document of documents) plane.vanish(nameOf(document));
		const raced = new (class extends FakeStore {
			override async rowFor(repo: string, path: string): Promise<ManifestRow | null> {
				const row = await super.rowFor(repo, path);
				// The row was rewritten (new content) after the drift was read.
				return row !== null && path === "a.md" ? { ...row, sha256: sha256Hex("rewritten") } : row;
			}
			override async markTombstoned(repo: string, path: string): Promise<boolean> {
				if (path === "b.md") throw new Error("connection lost");
				return super.markTombstoned(repo, path);
			}
		})();
		for (const row of store.rows.values()) raced.seed(row);

		const result = await reconcileCorpus({ store: raced, plane }, true);
		if (!result.ok) throw new Error("expected a result");
		expect(result.body.drift.missingInPlane.map((item) => item.path)).toEqual(["a.md", "b.md", "c.md"]);
		expect(result.body.repaired.requeued).toBe(1);
		expect(raced.row(REPO, "a.md")?.state).toBe("active");
		expect(raced.row(REPO, "b.md")?.state).toBe("active");
		expect(raced.row(REPO, "c.md")?.state).toBe("tombstoned");
	});

	test("a truncated plane listing asserts nothing missing, reports truncated, and execute still deletes the orphan it showed", async () => {
		const { store, plane, documents } = await ingested(["a.md"]);
		plane.vanish(nameOf(defined(documents[0], "a.md")));
		const orphanId = plane.plant(corpusDocumentName(REPO, "stray.md", sha256Hex("stray")));
		plane.listTruncated = true;
		const result = await reconcileCorpus({ store, plane }, true);
		if (!result.ok) throw new Error("expected a result");
		expect(result.body.drift.missingInPlane).toEqual([]);
		expect(result.body.drift.truncated).toBe(true);
		expect(result.body.repaired).toEqual({ requeued: 0, deleted: 1 });
		expect(plane.deletes).toEqual([[orphanId]]);
		expect(store.row(REPO, "a.md")?.state).toBe("active");
	});

	test("missing rows and orphans share one bound in total: more drift than RECONCILE_MAX_ITEMS is cut, reported truncated, and execute repairs only what it reported", async () => {
		const store = new FakeStore();
		const plane = new FakePlane();
		const missing = 300;
		const stray = 300;
		for (let index = 0; index < missing; index += 1) store.seed(rowOf(`gone-${index}.md`, `doc-gone-${index}`));
		for (let index = 0; index < stray; index += 1) plane.plant(corpusDocumentName(REPO, `stray-${String(index).padStart(4, "0")}.md`, sha256Hex(String(index))));
		const dry = await reconcileCorpus({ store, plane }, false);
		if (!dry.ok) throw new Error("expected a result");
		expect(dry.body.drift.missingInPlane).toHaveLength(missing);
		expect(dry.body.drift.orphansInPlane).toHaveLength(RECONCILE_MAX_ITEMS - missing);
		expect(dry.body.drift.truncated).toBe(true);
		expect(dry.body.repaired).toEqual({ requeued: 0, deleted: 0 });

		const executed = await reconcileCorpus({ store, plane }, true);
		if (!executed.ok) throw new Error("expected a result");
		expect(executed.body.repaired).toEqual({ requeued: missing, deleted: RECONCILE_MAX_ITEMS - missing });
		expect(executed.body.repaired.requeued + executed.body.repaired.deleted).toBe(RECONCILE_MAX_ITEMS);
		expect(plane.documents.size).toBe(stray - (RECONCILE_MAX_ITEMS - missing));
		expect(store.row(REPO, "gone-0.md")?.state).toBe("tombstoned");
	});

	test("a manifest larger than the read bound is judged for missing documents only: no orphan is asserted and none is deleted", async () => {
		const store = new FakeStore();
		const plane = new FakePlane();
		for (let index = 0; index < RECONCILE_MAX_ROWS + 1; index += 1) store.seed({ ...rowOf(`p-${index}.md`, `doc-${index}`), sha256: "a".repeat(64) });
		plane.plant(corpusDocumentName(REPO, "maybe-owned.md", sha256Hex("maybe-owned")));
		const result = await reconcileCorpus({ store, plane }, true);
		if (!result.ok) throw new Error("expected a result");
		expect(result.body.drift.orphansInPlane).toEqual([]);
		expect(result.body.drift.truncated).toBe(true);
		expect(result.body.drift.checked).toBe(RECONCILE_MAX_ROWS);
		expect(plane.deletes).toEqual([]);
		expect(result.body.repaired.requeued).toBe(RECONCILE_MAX_ITEMS);
	});

	test("a plane that cannot list is a named failure and nothing is changed; a manifest that cannot be read never reaches the plane", async () => {
		const { store, plane, documents } = await ingested(["a.md"]);
		plane.vanish(nameOf(defined(documents[0], "a.md")));
		plane.listFailure = "plane-unavailable";
		expect(await reconcileCorpus({ store, plane }, true)).toEqual({ ok: false, reason: "corpus.plane-unreachable", detail: "plane-unavailable" });
		expect(store.row(REPO, "a.md")?.state).toBe("active");

		plane.listFailure = null;
		store.failActiveRows = true;
		const listsBefore = plane.calls.filter((call) => call === "list").length;
		expect(await reconcileCorpus({ store, plane }, true)).toEqual({ ok: false, reason: "corpus.index-unavailable" });
		expect(plane.calls.filter((call) => call === "list")).toHaveLength(listsBefore);
	});

	test("it waits for an ingest in flight: the plane is not listed until the insert has been answered and recorded", async () => {
		const store = new FakeStore();
		const plane = new FakePlane();
		const slow = makeDocument(REPO, "slow.md", "slow body");
		const release = plane.hold(nameOf(slow));
		const ingesting = ingestCorpus(ingestDeps(store, plane), { protocol: CORPUS_PROTOCOL, documents: [slow], tombstones: [] });
		const reconciling = reconcileCorpus({ store, plane }, true);
		for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
		expect(plane.calls).not.toContain("list");
		release();
		await ingesting;
		const result = await reconciling;
		if (!result.ok) throw new Error("expected a result");
		expect(plane.calls.indexOf("list")).toBeGreaterThan(plane.calls.indexOf(`insert-end:${nameOf(slow)}`));
		// The document the ingest just wrote is owned, so it was not mistaken for an orphan.
		expect(result.body.drift).toMatchObject({ missingInPlane: [], orphansInPlane: [] });
		expect(plane.deletes).toEqual([]);
	});
});
