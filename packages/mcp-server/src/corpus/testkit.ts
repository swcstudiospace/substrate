/**
 * Test doubles for the corpus module: an in-memory manifest that behaves like the Postgres one, and a fake LightRAG bulk plane
 * that follows the upstream rules the real plane documents (a same-name document is a conflict, the same text under another
 * name answers the original's id, an unknown id counts as deleted). Both write to one shared log, so a test can assert the
 * order of a plane write, a manifest write and a plane delete.
 */
import { createHash } from "node:crypto";
import { CORPUS_NAME_PREFIX, type CorpusDocument, type CorpusEntry } from "@substrate/corpus";
import type { BulkDocumentOutcome, BulkTextDocument, LightragBulkPlane, PlaneListedDocument, PlaneListing } from "../planes/lightrag-bulk.ts";
import { planeDocumentIdForName } from "./names.ts";
import type { ActiveLeaves, ActiveRows, CorpusStatusSummary, CorpusStore, ManifestRow, RecordedDocument, RefreshedMetadata } from "./store.ts";

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A document whose sha256 and size describe its body, so it passes the integrity check unless a test breaks it on purpose. */
export function makeDocument(repo: string, path: string, body: string, over: Partial<CorpusDocument> = {}): CorpusDocument {
	return { repo, path, kind: "doc", tier: 1, sha256: sha256Hex(body), bytes: Buffer.byteLength(body, "utf8"), source: "fs", commit: "c0ffee1", body, ...over };
}

export function entryOf(document: CorpusDocument): CorpusEntry {
	const { body: _body, ...entry } = document;
	return entry;
}

export function makeRow(over: Partial<ManifestRow> & Pick<ManifestRow, "repo" | "path">): ManifestRow {
	return {
		kind: "doc",
		tier: 1,
		sha256: sha256Hex(`${over.repo}:${over.path}`),
		bytes: 10,
		source: "fs",
		commit: null,
		state: "active",
		documentId: `doc-${over.path}`,
		manifestSeq: 1,
		supersededBy: null,
		ingestedAt: null,
		...over,
	};
}

export class FakeStore implements CorpusStore {
	readonly rows = new Map<string, ManifestRow>();
	/** Keys whose `recordIngested` throws once, as a database that went away between the plane write and the manifest write. */
	readonly failRecordOnce = new Set<string>();
	/** The instants `status()` reports; a test sets them to age the manifest. */
	lastIngestAt: string | null = null;
	newestChangeAt: string | null = null;
	/** When true `activeRows` throws, as a database that stopped answering. */
	failActiveRows = false;
	private seq = 0;

	constructor(private readonly log: string[] = []) {}

	private key(repo: string, path: string): string {
		return `${repo}\n${path}`;
	}

	seed(row: ManifestRow): void {
		this.seq += 1;
		this.rows.set(this.key(row.repo, row.path), { ...row, manifestSeq: this.seq });
	}

	row(repo: string, path: string): ManifestRow | undefined {
		return this.rows.get(this.key(repo, path));
	}

	async rowsForRepos(repos: readonly string[]): Promise<ManifestRow[]> {
		return [...this.rows.values()].filter((row) => repos.includes(row.repo));
	}

	async rowFor(repo: string, path: string): Promise<ManifestRow | null> {
		return this.row(repo, path) ?? null;
	}

	async recordIngested(row: RecordedDocument): Promise<void> {
		const key = this.key(row.repo, row.path);
		if (this.failRecordOnce.delete(key)) throw new Error("connection lost");
		this.log.push(`record:${row.path}`);
		this.seq += 1;
		this.rows.set(key, { ...row, commit: row.commit ?? null, supersededBy: row.supersededBy ?? null, ingestedAt: new Date(0).toISOString(), state: "active", manifestSeq: this.seq });
	}

	async refreshMetadata(row: RefreshedMetadata): Promise<boolean> {
		const held = this.row(row.repo, row.path);
		if (held === undefined || held.state !== "active" || held.sha256 !== row.sha256) return false;
		this.log.push(`refresh:${row.path}`);
		this.seq += 1;
		this.rows.set(this.key(row.repo, row.path), { ...held, kind: row.kind, tier: row.tier, source: row.source, commit: row.commit ?? null, supersededBy: row.supersededBy ?? null, manifestSeq: this.seq });
		return true;
	}

	async markTombstoned(repo: string, path: string): Promise<boolean> {
		const row = this.row(repo, path);
		if (row === undefined || row.state !== "active") return false;
		this.log.push(`tombstone:${path}`);
		this.seq += 1;
		this.rows.set(this.key(repo, path), { ...row, state: "tombstoned", manifestSeq: this.seq });
		return true;
	}

	async activeReferences(documentId: string): Promise<number> {
		return [...this.rows.values()].filter((row) => row.state === "active" && row.documentId === documentId).length;
	}

	async activeRows(limit: number): Promise<ActiveRows> {
		if (this.failActiveRows) throw new Error("connection lost");
		const active = [...this.rows.values()]
			.filter((row) => row.state === "active")
			.sort((left, right) => (left.repo === right.repo ? (left.path < right.path ? -1 : 1) : left.repo < right.repo ? -1 : 1))
			.slice(0, limit);
		const all = [...this.rows.values()].filter((row) => row.state === "active");
		return { rows: active, truncated: all.length > limit };
	}

	async manifestVersion(): Promise<number> {
		return this.seq;
	}

	/** Counts every read, so a test can say whether a path asked the manifest at all. */
	leafReads = 0;

	async activeLeaves(limit: number): Promise<ActiveLeaves> {
		this.leafReads += 1;
		const active = [...this.rows.values()].filter((row) => row.state === "active").map(({ repo, path, sha256 }) => ({ repo, path, sha256 }));
		return { manifestVersion: this.seq, leaves: active.slice(0, limit), truncated: active.length > limit };
	}

	async status(): Promise<CorpusStatusSummary> {
		this.statusReads += 1;
		const rows = [...this.rows.values()];
		const active = rows.filter((row) => row.state === "active");
		return {
			total: rows.length,
			active: active.length,
			tombstoned: rows.length - active.length,
			byRepo: [],
			byKind: [],
			byTier: [],
			lastIngestAt: this.lastIngestAt,
			newestChangeAt: this.newestChangeAt,
			manifestVersion: this.seq,
		};
	}

	/** How many times each way of reading it was used, so a test can say which one a path paid for. */
	statusReads = 0;
	newestReads = 0;

	async newestIngestAt(): Promise<string | null> {
		this.newestReads += 1;
		return this.lastIngestAt;
	}
}

export class FakePlane implements LightragBulkPlane {
	/** Plane documents by name. Two names may hold one id when their text was identical. */
	readonly documents = new Map<string, { id: string; text: string }>();
	readonly batches: string[][] = [];
	readonly deletes: string[][] = [];
	/** Names answered `failed` with this reason. */
	readonly failNames = new Map<string, string>();
	/** Ids whose deletion is refused: the document stays and the id is reported failed. */
	readonly failDeleteIds = new Set<string>();
	/** Ids whose deletion ran but whose completion wait failed (a timeout, a fenced plane): reported failed, the document is gone. */
	readonly unconfirmedDeleteIds = new Set<string>();
	unavailable = false;
	maxInFlight = 0;
	private inFlight = 0;
	private readonly holds = new Map<string, Promise<void>>();
	/** Every plane call as it starts and ends, in order (the shared log only holds the effects). */
	readonly calls: string[] = [];

	constructor(private readonly log: string[] = []) {}

	/**
	 * Delays the answer for a document name until the returned function is called. The plane decides the outcome when the
	 * batch arrives (identical text answers the existing document's id) and only the answer is late, as on a busy pipeline.
	 */
	hold(name: string): () => void {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.holds.set(name, promise);
		return resolve;
	}

	async insertBatch(docs: readonly BulkTextDocument[]): Promise<BulkDocumentOutcome[]> {
		this.inFlight += 1;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		this.batches.push(docs.map((doc) => doc.name));
		for (const doc of docs) this.calls.push(`insert-start:${doc.name}`);
		// Two microtask turns: every worker the caller started is in flight before the first batch settles.
		await Promise.resolve();
		await Promise.resolve();
		const outcomes = docs.map((doc): BulkDocumentOutcome => {
			if (this.unavailable) return { name: doc.name, status: "failed", reason: "plane-unavailable" };
			const forced = this.failNames.get(doc.name);
			if (forced !== undefined) return { name: doc.name, status: "failed", reason: forced };
			if (this.documents.has(doc.name)) return { name: doc.name, status: "failed", reason: "conflict" };
			const same = [...this.documents.values()].find((held) => held.text === doc.text);
			if (same !== undefined) {
				this.documents.set(doc.name, same);
				this.log.push(`plane:${doc.name}`);
				return { name: doc.name, status: "ingested", documentId: same.id, reason: "duplicate-content" };
			}
			const id = planeDocumentIdForName(doc.name);
			this.documents.set(doc.name, { id, text: doc.text });
			this.log.push(`plane:${doc.name}`);
			return { name: doc.name, status: "ingested", documentId: id };
		});
		await Promise.all(docs.map((doc) => this.holds.get(doc.name)));
		this.inFlight -= 1;
		for (const doc of docs) this.calls.push(`insert-end:${doc.name}`);
		return outcomes;
	}

	async deleteDocuments(ids: readonly string[]): Promise<{ deleted: string[]; failed: Array<{ id: string; reason: string }> }> {
		this.deletes.push([...ids]);
		this.calls.push(`delete-start:${ids.join(",")}`);
		const deleted: string[] = [];
		const failed: Array<{ id: string; reason: string }> = [];
		for (const id of ids) {
			if (this.failDeleteIds.has(id)) {
				failed.push({ id, reason: "plane-unavailable" });
				continue;
			}
			for (const [name, held] of [...this.documents]) if (held.id === id) this.documents.delete(name);
			this.log.push(`delete:${id}`);
			if (this.unconfirmedDeleteIds.has(id)) failed.push({ id, reason: "timeout" });
			else deleted.push(id);
		}
		return { deleted, failed };
	}

	/** The plane document ids that exist now. */
	liveIds(): Set<string> {
		return new Set([...this.documents.values()].map((held) => held.id));
	}

	/** Answers `listDocuments` with this failure reason while set. */
	listFailure: string | null = null;
	/** Makes `listDocuments` report an incomplete read, as a plane with more pages than the bound. */
	listTruncated = false;
	/** Ids the listing omits even though the plane still holds them. */
	hiddenFromListing = new Set<string>();
	/** Ids whose lookup fails closed. */
	lookupUnknown = new Set<string>();

	/** The plane's listing: one entry per distinct id (a shared document is listed once, under its first name). Never fails unless `listFailure` is set. */
	async listDocuments(): Promise<PlaneListing> {
		this.calls.push("list");
		if (this.listFailure !== null) return { ok: false, reason: this.listFailure };
		const documents: PlaneListedDocument[] = [];
		const otherDocumentIds: string[] = [];
		const seen = new Set<string>();
		for (const [name, held] of this.documents) {
			if (seen.has(held.id) || this.hiddenFromListing.has(held.id)) continue;
			seen.add(held.id);
			if (name.startsWith(CORPUS_NAME_PREFIX)) documents.push({ id: held.id, name });
			else otherDocumentIds.push(held.id);
		}
		return { ok: true, documents, otherDocumentIds, truncated: this.listTruncated };
	}

	async lookupDocument(id: string): Promise<"present" | "absent" | "unknown"> {
		this.calls.push(`lookup:${id}`);
		if (this.lookupUnknown.has(id)) return "unknown";
		return this.liveIds().has(id) ? "present" : "absent";
	}

	/** A document the plane lost while the manifest still lists it. */
	vanish(name: string): void {
		this.documents.delete(name);
	}

	/** A document the plane holds that no manifest row owns (a killed run, or another door's upload). Returns its id. */
	plant(name: string, text: string = name): string {
		const id = planeDocumentIdForName(name);
		this.documents.set(name, { id, text });
		return id;
	}
}
