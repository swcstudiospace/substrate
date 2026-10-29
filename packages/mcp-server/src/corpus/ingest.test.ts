import { describe, expect, test } from "bun:test";
import { CORPUS_PROTOCOL, corpusDocumentName, type CorpusDocument, type CorpusIngestRequest } from "@substrate/corpus";
import type { EventInput } from "../types.ts";
import { defined } from "../test-support.ts";
import { chunkByLimits, corpusGate, ingestCorpus, type CorpusIngestSettings } from "./ingest.ts";
import { planeDocumentIdForName } from "./names.ts";
import { planCorpus } from "./plan.ts";
import { FakePlane, FakeStore, makeDocument, makeRow, sha256Hex } from "./testkit.ts";

const REPO = "swcstudiospace/agent-substrate";
const SETTINGS: CorpusIngestSettings = { concurrency: 4, batchDocs: 20, batchBytes: 1_000_000 };

function harness(settings: Partial<CorpusIngestSettings> = {}) {
	const log: string[] = [];
	const store = new FakeStore(log);
	const plane = new FakePlane(log);
	const events: EventInput[] = [];
	const run = (documents: CorpusDocument[], tombstones: Array<{ repo: string; path: string }> = []) => {
		const request: CorpusIngestRequest = { protocol: CORPUS_PROTOCOL, documents, tombstones };
		return ingestCorpus(
			{ store, plane, settings: { ...SETTINGS, ...settings }, surface: "claude-code", sessionId: "sess-corpus", emit: async (event) => void events.push(event) },
			request,
		);
	};
	return { log, store, plane, events, run };
}

const nameOf = (document: CorpusDocument): string => corpusDocumentName(document.repo, document.path, document.sha256);

describe("corpusGate", () => {
	const open = { enabled: true, surface: "claude-code" as const, vmGuest: false, backendReady: true };

	test("an open deployment and an authenticated caller pass", () => {
		expect(corpusGate(open)).toBeNull();
	});

	test("each closed refusal names its status: 401 anonymous, 503 flag off, 403 VM guest, 503 no backend", () => {
		expect(corpusGate({ ...open, surface: null })).toEqual({ status: 401, reason: "unauthenticated" });
		expect(corpusGate({ ...open, enabled: false })).toEqual({ status: 503, reason: "corpus.disabled" });
		expect(corpusGate({ ...open, vmGuest: true })).toEqual({ status: 403, reason: "vm-guest" });
		expect(corpusGate({ ...open, backendReady: false })).toEqual({ status: 503, reason: "corpus.backend-unavailable" });
	});

	test("an anonymous caller is told 401 even when the flag is off", () => {
		expect(corpusGate({ ...open, surface: null, enabled: false })?.status).toBe(401);
	});
});

describe("ingestCorpus: documents", () => {
	test("a new document is sent under its corpus name, recorded with the plane id, and reported ingested", async () => {
		const { store, plane, run } = harness();
		const document = makeDocument(REPO, "docs/a.md", "# A\nbody");
		const response = await run([document]);
		const id = planeDocumentIdForName(nameOf(document));
		expect(response.results).toEqual([{ repo: REPO, path: "docs/a.md", status: "ingested", documentId: id }]);
		expect(response.counts).toEqual({ ingested: 1, updated: 0, unchanged: 0, tombstoned: 0, refused: 0, failed: 0 });
		expect(plane.documents.get(nameOf(document))?.text).toBe("# A\nbody");
		expect(store.row(REPO, "docs/a.md")).toMatchObject({ sha256: document.sha256, state: "active", documentId: id, kind: "doc", tier: 1, source: "fs", commit: "c0ffee1" });
		expect(response.manifestVersion).toBe(await store.manifestVersion());
	});

	test("a body that does not hash to its entry's sha256 is refused and nothing is sent or recorded", async () => {
		const { store, plane, run } = harness();
		const response = await run([makeDocument(REPO, "docs/a.md", "real text", { sha256: sha256Hex("other text") })]);
		expect(response.results).toEqual([{ repo: REPO, path: "docs/a.md", status: "refused", reason: "sha-mismatch" }]);
		expect(plane.batches).toEqual([]);
		expect(store.rows.size).toBe(0);
	});

	test("a secret finding refuses that document alone; the others are sent and the refusal event carries rule names, never text", async () => {
		const { store, plane, events, run } = harness();
		const leaky = makeDocument(REPO, "docs/leaky.md", "paste sk-proj-abcdefghij1234567890 here");
		const clean = makeDocument(REPO, "docs/clean.md", "nothing secret");
		const response = await run([leaky, clean]);
		expect(response.results.map((result) => [result.path, result.status, result.reason])).toEqual([
			["docs/leaky.md", "refused", "secret-findings"],
			["docs/clean.md", "ingested", undefined],
		]);
		expect([...plane.documents.keys()]).toEqual([nameOf(clean)]);
		expect(store.row(REPO, "docs/leaky.md")).toBeUndefined();
		const warning = defined(events.find((event) => event.kind === "warning"), "the refusal warning");
		expect(warning.payload).toMatchObject({ action: "docs.corpus.refused", status: "refused", reason: "secret-findings", count: 1 });
		expect(JSON.stringify(events)).not.toContain("sk-proj-");
	});

	test("a document over the size cap, an empty one and one whose name the plane would alter are refused with their own reasons", async () => {
		const { plane, run } = harness();
		const huge = makeDocument(REPO, "docs/huge.md", "x".repeat(1_000_001));
		const empty = makeDocument(REPO, "docs/empty.md", "   \n");
		const hinted = makeDocument(REPO, "docs/x.[docling].md", "text");
		const response = await run([huge, empty, hinted]);
		expect(response.results.map((result) => result.reason)).toEqual(["too-large", "empty-document", "unsafe-name"]);
		expect(plane.batches).toEqual([]);
	});

	test("remote images are stripped before the text is sent", async () => {
		const { plane, run } = harness();
		const document = makeDocument(REPO, "docs/img.md", "before ![logo](https://example.com/x.png) after");
		await run([document]);
		expect(plane.documents.get(nameOf(document))?.text).toBe("before  after");
	});

	test("a document already recorded at the same sha is unchanged: nothing is sent, and a second identical run sends nothing", async () => {
		const { plane, run } = harness();
		const documents = [makeDocument(REPO, "docs/a.md", "a"), makeDocument(REPO, "docs/b.md", "b")];
		await run(documents);
		const sent = plane.batches.length;
		const again = await run(documents);
		expect(again.counts).toEqual({ ingested: 0, updated: 0, unchanged: 2, tombstoned: 0, refused: 0, failed: 0 });
		expect(plane.batches.length).toBe(sent);
	});

	test("the event for a request carries counts only, and the ledger gets no document text", async () => {
		const { events, run } = harness();
		await run([makeDocument(REPO, "docs/a.md", "unmistakable body text")]);
		const note = defined(events.find((event) => event.kind === "note"), "the request note");
		expect(note.payload).toMatchObject({ action: "docs.corpus.ingest", ingested: 1, unchanged: 0, tombstoned: 0, refused: 0, failed: 0, batches: 1, orphaned_documents: 0 });
		expect(JSON.stringify(events)).not.toContain("unmistakable");
	});
});

describe("ingestCorpus: batching", () => {
	const many = (count: number, size = 10) => Array.from({ length: count }, (_, index) => makeDocument(REPO, `docs/${String(index).padStart(3, "0")}.md`, `document ${index} ${"x".repeat(size)}`));

	test("chunking by document count: 45 documents at 20 per batch are batches of 20, 20 and 5", async () => {
		const { plane, run } = harness({ batchDocs: 20 });
		await run(many(45));
		expect(plane.batches.map((batch) => batch.length)).toEqual([20, 20, 5]);
	});

	test("chunking by bytes: a batch closes before the document that would pass the byte budget", () => {
		const items = [{ size: 400 }, { size: 400 }, { size: 400 }, { size: 100 }];
		expect(chunkByLimits(items, 20, 1000).map((chunk) => chunk.length)).toEqual([2, 2]);
		expect(chunkByLimits(items, 2, 100_000).map((chunk) => chunk.length)).toEqual([2, 2]);
	});

	test("a document larger than the byte budget is a batch of its own and is still sent", async () => {
		const { plane, run } = harness({ batchBytes: 100 });
		const response = await run(many(3, 200));
		expect(plane.batches.map((batch) => batch.length)).toEqual([1, 1, 1]);
		expect(response.counts.ingested).toBe(3);
	});

	test("at most `concurrency` batches are in flight, and every batch is sent", async () => {
		const { plane, run } = harness({ batchDocs: 1, concurrency: 3 });
		const response = await run(many(10));
		expect(plane.maxInFlight).toBe(3);
		expect(plane.batches).toHaveLength(10);
		expect(response.counts.ingested).toBe(10);
	});

	test("a concurrency of one sends the batches one after the other", async () => {
		const { plane, run } = harness({ batchDocs: 1, concurrency: 1 });
		await run(many(4));
		expect(plane.maxInFlight).toBe(1);
	});

	test("results come back in request order, documents then tombstones", async () => {
		const { store, run } = harness({ batchDocs: 1, concurrency: 4 });
		store.seed(makeRow({ repo: REPO, path: "old/gone.md", documentId: "doc-gone" }));
		const documents = many(5);
		const response = await run([...documents].reverse(), [{ repo: REPO, path: "old/gone.md" }]);
		expect(response.results.map((result) => result.path)).toEqual([...documents.map((document) => document.path)].reverse().concat("old/gone.md"));
	});
});

describe("ingestCorpus: plane failures and resuming", () => {
	test("a plane that is down fails every document, records none, and a retry sends only them", async () => {
		const { store, plane, run } = harness();
		const documents = [makeDocument(REPO, "docs/a.md", "a"), makeDocument(REPO, "docs/b.md", "b")];
		plane.unavailable = true;
		const failed = await run(documents);
		expect(failed.results.map((result) => [result.status, result.reason])).toEqual([
			["failed", "plane-unavailable"],
			["failed", "plane-unavailable"],
		]);
		expect(store.rows.size).toBe(0);
		plane.unavailable = false;
		const retried = await run(documents);
		expect(retried.counts.ingested).toBe(2);
	});

	test("one document the plane rejects does not stop the others; its reason is closed, never the plane's own text", async () => {
		const { plane, run } = harness();
		const good = makeDocument(REPO, "docs/good.md", "good");
		const bad = makeDocument(REPO, "docs/bad.md", "bad");
		plane.failNames.set(nameOf(bad), "pipeline-failed: ValueError at line 4 in /srv/lightrag/secret.py");
		const response = await run([bad, good]);
		expect(response.results.map((result) => [result.path, result.status, result.reason])).toEqual([
			["docs/bad.md", "failed", "pipeline-failed"],
			["docs/good.md", "ingested", undefined],
		]);
		plane.failNames.set(nameOf(bad), "something nobody listed");
		const second = await run([bad]);
		expect(second.results[0]).toMatchObject({ status: "failed", reason: "plane-unavailable" });
	});

	test("a run killed after the first batch resumes with only the documents it had not recorded", async () => {
		const { store, plane, run } = harness({ batchDocs: 2, concurrency: 1 });
		const documents = Array.from({ length: 6 }, (_, index) => makeDocument(REPO, `docs/${index}.md`, `doc ${index}`));
		// The first run recorded two batches before dying: its manifest holds four documents.
		await run(documents.slice(0, 4));
		expect(store.rows.size).toBe(4);
		plane.batches.length = 0;
		const resumed = await run(documents);
		expect(resumed.counts).toEqual({ ingested: 2, updated: 0, unchanged: 4, tombstoned: 0, refused: 0, failed: 0 });
		expect(plane.batches).toEqual([[nameOf(defined(documents[4], "document 4")), nameOf(defined(documents[5], "document 5"))]]);
	});

	test("a crash between the plane write and the manifest write leaves a state the next run repairs", async () => {
		const { store, plane, run } = harness();
		const document = makeDocument(REPO, "docs/a.md", "a");
		store.failRecordOnce.add(`${REPO}\ndocs/a.md`);
		const first = await run([document]);
		expect(first.results[0]).toMatchObject({ status: "failed", reason: "manifest-unavailable" });
		expect(store.row(REPO, "docs/a.md")).toBeUndefined();
		// The plane holds the document; the retry gets a same-name conflict, clears the stray document and writes it again.
		expect(plane.documents.has(nameOf(document))).toBe(true);
		const second = await run([document]);
		expect(second.results[0]).toMatchObject({ status: "ingested", documentId: planeDocumentIdForName(nameOf(document)) });
		expect(store.row(REPO, "docs/a.md")?.state).toBe("active");
		expect(plane.deletes).toEqual([[planeDocumentIdForName(nameOf(document))]]);
		expect([...plane.documents.keys()]).toEqual([nameOf(document)]);
	});

	test("a same-name conflict whose plane document another active row already uses is adopted, not deleted", async () => {
		const { store, plane, run } = harness();
		const document = makeDocument(REPO, "docs/a.md", "a");
		const id = planeDocumentIdForName(nameOf(document));
		plane.documents.set(nameOf(document), { id, text: "a" });
		store.seed(makeRow({ repo: REPO, path: "docs/copy.md", documentId: id }));
		const response = await run([document]);
		expect(response.results[0]).toMatchObject({ status: "ingested", documentId: id });
		expect(plane.deletes).toEqual([]);
	});
});

describe("ingestCorpus: changes and shared plane documents", () => {
	test("a changed document is written under its new name and recorded BEFORE the old plane document is deleted", async () => {
		const { log, store, plane, run } = harness();
		const before = makeDocument(REPO, "docs/a.md", "version one");
		await run([before]);
		const oldId = planeDocumentIdForName(nameOf(before));
		log.length = 0;
		const after = makeDocument(REPO, "docs/a.md", "version two");
		const response = await run([after]);
		const newId = planeDocumentIdForName(nameOf(after));
		expect(response.results[0]).toMatchObject({ status: "ingested", documentId: newId });
		expect(log).toEqual([`plane:${nameOf(after)}`, "record:docs/a.md", `delete:${oldId}`]);
		expect(store.row(REPO, "docs/a.md")).toMatchObject({ sha256: after.sha256, documentId: newId });
		expect([...plane.documents.keys()]).toEqual([nameOf(after)]);
	});

	test("when the new write fails the old document and the old row stay exactly as they were", async () => {
		const { store, plane, run } = harness();
		const before = makeDocument(REPO, "docs/a.md", "version one");
		await run([before]);
		const after = makeDocument(REPO, "docs/a.md", "version two");
		plane.failNames.set(nameOf(after), "timeout");
		const response = await run([after]);
		expect(response.results[0]).toMatchObject({ status: "failed", reason: "timeout" });
		expect(store.row(REPO, "docs/a.md")?.sha256).toBe(before.sha256);
		expect(plane.documents.has(nameOf(before))).toBe(true);
		expect(plane.deletes).toEqual([]);
	});

	test("a superseded plane document that another active row still uses is not deleted", async () => {
		const { store, plane, run } = harness();
		const shared = makeDocument(REPO, "docs/a.md", "same text");
		const twin = makeDocument(REPO, "docs/twin.md", "same text");
		await run([shared, twin]);
		// Identical text under two names is one plane document, held by both rows.
		const id = defined(store.row(REPO, "docs/a.md")?.documentId, "the shared id");
		expect(store.row(REPO, "docs/twin.md")?.documentId).toBe(id);
		await run([makeDocument(REPO, "docs/a.md", "now different")]);
		expect(plane.deletes).toEqual([]);
		expect(plane.documents.has(nameOf(twin))).toBe(true);
		expect(store.row(REPO, "docs/twin.md")?.state).toBe("active");
	});

	test("a superseded document that could not be deleted is an orphan on the plane, counted in the event, and the document still succeeded", async () => {
		const { events, plane, run } = harness();
		const before = makeDocument(REPO, "docs/a.md", "version one");
		await run([before]);
		plane.failDeleteIds.add(planeDocumentIdForName(nameOf(before)));
		const response = await run([makeDocument(REPO, "docs/a.md", "version two")]);
		expect(response.results[0]?.status).toBe("ingested");
		const note = defined(events.filter((event) => event.kind === "note").at(-1), "the note");
		expect(note.payload).toMatchObject({ orphaned_documents: 1 });
	});
});

describe("ingestCorpus: tombstones", () => {
	test("a tombstone deletes the plane document and marks the row tombstoned", async () => {
		const { store, plane, run } = harness();
		const document = makeDocument(REPO, "docs/a.md", "a");
		await run([document]);
		const id = planeDocumentIdForName(nameOf(document));
		const response = await run([], [{ repo: REPO, path: "docs/a.md" }]);
		expect(response.results).toEqual([{ repo: REPO, path: "docs/a.md", status: "tombstoned", documentId: id }]);
		expect(plane.documents.size).toBe(0);
		expect(store.row(REPO, "docs/a.md")?.state).toBe("tombstoned");
	});

	test("a key with no active row is unchanged: nothing is deleted, and repeating a tombstone changes nothing", async () => {
		const { store, plane, run } = harness();
		store.seed(makeRow({ repo: REPO, path: "docs/dead.md", state: "tombstoned", documentId: "doc-dead" }));
		const response = await run([], [{ repo: REPO, path: "docs/dead.md" }, { repo: REPO, path: "docs/never-seen.md" }]);
		expect(response.results.map((result) => result.status)).toEqual(["unchanged", "unchanged"]);
		expect(plane.deletes).toEqual([]);
	});

	test("a plane document shared with another active row is never deleted; the row is still tombstoned", async () => {
		const { store, plane, run } = harness();
		const first = makeDocument(REPO, "docs/a.md", "same text");
		const second = makeDocument(REPO, "docs/b.md", "same text");
		await run([first, second]);
		const response = await run([], [{ repo: REPO, path: "docs/a.md" }]);
		expect(response.results[0]?.status).toBe("tombstoned");
		expect(plane.deletes).toEqual([]);
		expect(store.row(REPO, "docs/a.md")?.state).toBe("tombstoned");
		expect(store.row(REPO, "docs/b.md")?.state).toBe("active");
		// The surviving row still has a plane document behind it; tombstoning it too now deletes the shared one.
		await run([], [{ repo: REPO, path: "docs/b.md" }]);
		expect(plane.deletes).toHaveLength(1);
	});

	test("tombstoning every holder of a shared plane document in one request deletes it once", async () => {
		const { plane, run } = harness();
		await run([makeDocument(REPO, "docs/a.md", "same text"), makeDocument(REPO, "docs/b.md", "same text")]);
		const response = await run([], [{ repo: REPO, path: "docs/a.md" }, { repo: REPO, path: "docs/b.md" }]);
		expect(response.counts.tombstoned).toBe(2);
		expect(plane.deletes).toHaveLength(1);
		expect(plane.deletes[0]).toHaveLength(1);
	});

	test("a plane delete that fails leaves the row active so a retry deletes again", async () => {
		const { store, plane, run } = harness();
		const document = makeDocument(REPO, "docs/a.md", "a");
		await run([document]);
		const id = planeDocumentIdForName(nameOf(document));
		plane.failDeleteIds.add(id);
		const failed = await run([], [{ repo: REPO, path: "docs/a.md" }]);
		expect(failed.results[0]).toMatchObject({ status: "failed", reason: "delete-failed" });
		expect(store.row(REPO, "docs/a.md")?.state).toBe("active");
		plane.failDeleteIds.clear();
		const retried = await run([], [{ repo: REPO, path: "docs/a.md" }]);
		expect(retried.results[0]?.status).toBe("tombstoned");
	});

	test("a rename (tombstone of the old path, document at the new one) leaves one plane document under the new name", async () => {
		const { store, plane, run } = harness();
		await run([makeDocument(REPO, "docs/old.md", "moved text")]);
		const moved = makeDocument(REPO, "docs/new.md", "moved text");
		const response = await run([moved], [{ repo: REPO, path: "docs/old.md" }]);
		expect(response.counts).toMatchObject({ ingested: 1, tombstoned: 1, failed: 0 });
		expect([...plane.documents.keys()]).toEqual([nameOf(moved)]);
		expect(store.row(REPO, "docs/old.md")?.state).toBe("tombstoned");
		expect(store.row(REPO, "docs/new.md")?.state).toBe("active");
	});
});

/** Lets every promise chain that can progress without a gate progress, so a test observes the state while a gate is held. */
async function flush(): Promise<void> {
	for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

describe("ingestCorpus: phases and single flight", () => {
	test("the shared-text race: a document added with the text a changed document leaves still points at a live plane document", async () => {
		const { store, plane, run } = harness({ batchDocs: 1, concurrency: 2 });
		await run([makeDocument(REPO, "docs/a.md", "text X")]);
		const sharedId = defined(store.row(REPO, "docs/a.md")?.documentId, "the id of text X");
		const changed = makeDocument(REPO, "docs/a.md", "text Y");
		const newcomer = makeDocument(REPO, "docs/b.md", "text X");
		// The plane answers the newcomer with text X's existing id at once, but the answer arrives after the changed
		// document's batch has been recorded: the window the old per-batch delete used.
		const release = plane.hold(nameOf(newcomer));
		const running = run([changed, newcomer]);
		await flush();
		expect(store.row(REPO, "docs/a.md")?.sha256).toBe(changed.sha256);
		release();
		const response = await running;
		expect(response.counts).toMatchObject({ ingested: 2, failed: 0 });
		expect(store.row(REPO, "docs/b.md")?.documentId).toBe(sharedId);
		expect(plane.liveIds().has(sharedId)).toBe(true);
		expect(plane.deletes).toEqual([]);
	});

	test("a superseded document nobody references any more is deleted only after the whole request is recorded", async () => {
		const { log, store, plane, run } = harness({ batchDocs: 1, concurrency: 2 });
		await run([makeDocument(REPO, "docs/a.md", "version one")]);
		const oldId = defined(store.row(REPO, "docs/a.md")?.documentId, "the old id");
		log.length = 0;
		await run([makeDocument(REPO, "docs/a.md", "version two"), makeDocument(REPO, "docs/b.md", "other")]);
		expect(plane.deletes.at(-1)).toEqual([oldId]);
		expect(log.at(-1)).toBe(`delete:${oldId}`);
		expect(log.filter((entry) => entry.startsWith("record:"))).toHaveLength(2);
	});

	test("a rename in one request deletes the old plane document first, so the new row cites the new name", async () => {
		const { store, plane, run } = harness();
		await run([makeDocument(REPO, "docs/old.md", "moved text")]);
		const oldId = defined(store.row(REPO, "docs/old.md")?.documentId, "the old id");
		plane.calls.length = 0;
		const moved = makeDocument(REPO, "docs/new.md", "moved text");
		const response = await run([moved], [{ repo: REPO, path: "docs/old.md" }]);
		expect(response.counts).toMatchObject({ ingested: 1, tombstoned: 1, failed: 0 });
		expect(plane.calls).toEqual([`delete-start:${oldId}`, `insert-start:${nameOf(moved)}`, `insert-end:${nameOf(moved)}`]);
		expect(store.row(REPO, "docs/new.md")?.documentId).toBe(planeDocumentIdForName(nameOf(moved)));
		expect(plane.liveIds().has(oldId)).toBe(false);
	});

	test("two requests at once do not interleave: the second one's plane calls start after the first one's end", async () => {
		const { store, plane, run } = harness();
		const first = makeDocument(REPO, "docs/a.md", "first body");
		const second = makeDocument(REPO, "docs/b.md", "second body");
		store.seed(makeRow({ repo: REPO, path: "docs/old.md", documentId: "doc-old" }));
		const release = plane.hold(nameOf(first));
		const one = run([first]);
		const two = run([second], [{ repo: REPO, path: "docs/old.md" }]);
		await flush();
		expect(plane.calls).toEqual([`insert-start:${nameOf(first)}`]);
		release();
		await Promise.all([one, two]);
		expect(plane.calls).toEqual([
			`insert-start:${nameOf(first)}`,
			`insert-end:${nameOf(first)}`,
			"delete-start:doc-old",
			`insert-start:${nameOf(second)}`,
			`insert-end:${nameOf(second)}`,
		]);
	});

	test("a same-name leftover is resolved after every batch has recorded: a row that shares its plane document is not left dangling", async () => {
		const { store, plane, run } = harness({ batchDocs: 1, concurrency: 2 });
		const stray = makeDocument(REPO, "docs/a.md", "text X");
		const twin = makeDocument(REPO, "docs/b.md", "text X");
		const strayId = planeDocumentIdForName(nameOf(stray));
		plane.documents.set(nameOf(stray), { id: strayId, text: "text X" });
		const release = plane.hold(nameOf(twin));
		const running = run([stray, twin]);
		await flush();
		release();
		const response = await running;
		expect(response.counts).toMatchObject({ ingested: 2, failed: 0 });
		expect(store.row(REPO, "docs/b.md")?.documentId).toBe(strayId);
		expect(store.row(REPO, "docs/a.md")?.documentId).toBe(strayId);
		expect(plane.liveIds().has(strayId)).toBe(true);
		expect(plane.deletes).toEqual([]);
	});

	test("a deletion the plane started but never confirmed leaves the row active as delete-failed, and a retry removes it", async () => {
		const { store, plane, run } = harness();
		const document = makeDocument(REPO, "docs/a.md", "a");
		await run([document]);
		plane.unconfirmedDeleteIds.add(planeDocumentIdForName(nameOf(document)));
		const unconfirmed = await run([], [{ repo: REPO, path: "docs/a.md" }]);
		expect(unconfirmed.results[0]).toMatchObject({ status: "failed", reason: "delete-failed" });
		expect(unconfirmed.counts).toMatchObject({ tombstoned: 0, failed: 1 });
		expect(store.row(REPO, "docs/a.md")?.state).toBe("active");
		plane.unconfirmedDeleteIds.clear();
		const retried = await run([], [{ repo: REPO, path: "docs/a.md" }]);
		expect(retried.results[0]?.status).toBe("tombstoned");
		expect(store.row(REPO, "docs/a.md")?.state).toBe("tombstoned");
	});
});

describe("ingestCorpus: updates", () => {
	test("the same bytes read from another source refresh the row with no plane upload, and a later filesystem-only removal works", async () => {
		const { store, plane, run } = harness();
		await run([makeDocument(REPO, "docs/a.md", "text", { source: "github", commit: "aaa1111" })]);
		const id = defined(store.row(REPO, "docs/a.md")?.documentId, "the plane id");
		const versionBefore = await store.manifestVersion();
		plane.batches.length = 0;
		const local = makeDocument(REPO, "docs/a.md", "text", { source: "fs", commit: "bbb2222", tier: 2 });
		const response = await run([local]);
		expect(response.results).toEqual([{ repo: REPO, path: "docs/a.md", status: "updated", documentId: id }]);
		expect(response.counts).toMatchObject({ updated: 1, ingested: 0, unchanged: 0 });
		expect(plane.batches).toEqual([]);
		expect(plane.deletes).toEqual([]);
		expect(store.row(REPO, "docs/a.md")).toMatchObject({ source: "fs", commit: "bbb2222", tier: 2, documentId: id, state: "active" });
		expect(await store.manifestVersion()).toBeGreaterThan(versionBefore);

		// A second identical run has nothing left to refresh, and the row now sits inside a filesystem-only coverage.
		expect((await run([local])).counts).toMatchObject({ unchanged: 1, updated: 0 });
		const rows = await store.rowsForRepos([REPO]);
		const plan = planCorpus([], { coverage: [{ repo: REPO, source: "fs" }], maxTier: 3 }, rows);
		expect(plan.items).toEqual([{ action: "tombstone", repo: REPO, path: "docs/a.md", sha256: local.sha256 }]);
		const removed = await run([], [{ repo: REPO, path: "docs/a.md" }]);
		expect(removed.results[0]?.status).toBe("tombstoned");
	});

	test("a refreshed commit that looks like a secret is refused and the row keeps its old values", async () => {
		const { store, run } = harness();
		await run([makeDocument(REPO, "docs/a.md", "text", { source: "github" })]);
		const response = await run([makeDocument(REPO, "docs/a.md", "text", { source: "fs", commit: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" })]);
		expect(response.results[0]).toMatchObject({ status: "refused", reason: "secret-findings" });
		expect(store.row(REPO, "docs/a.md")?.source).toBe("github");
	});
});
