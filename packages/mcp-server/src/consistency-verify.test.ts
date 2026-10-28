/**
 * The cross-store consistency verifier (v1.6, phase 57, unit d): pure tests with fake readers.
 *
 * No database, no plane, no ledger, no network, no real delay. The clock is a constant (or a closure the test
 * advances), the timeout timer fires on `setImmediate` so a hanging reader is caught without waiting, and the
 * fakes count their calls so "never read", "read once" and "paged" are asserted rather than assumed.
 */
import { describe, expect, test } from "bun:test";
import {
	ConsistencyOptionError,
	DEFAULT_MAX_ENTRIES,
	FINDING_CODES,
	ReaderUnsupported,
	defaultDocumentId,
	formatReportJson,
	formatReportText,
	planRepairs,
	scrubReason,
	verifyConsistency,
	type ConsistencyOptions,
	type ConsistencyReaders,
	type ConsistencyReport,
	type IndexCursor,
	type LedgerWriteEvent,
	type Timer,
} from "./consistency-verify.ts";
import { contentHash, HASH_TENANT, HASH_VERSION_MARKER } from "./memory-write.ts";
import type { MemoryEntry } from "./types.ts";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const SECRET_TEXT = "SECRET-BODY-needle-7731";
const FORGOTTEN = `forgotten:fg_${"a".repeat(26)}`;

const bankFor = (writer: string): string => `sub-${writer}`;
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const immediateTimer: Timer = {
	after(_ms, fire) {
		const handle = setImmediate(fire);
		return () => clearImmediate(handle);
	},
};

function entry(id: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
	const base = {
		scope: "repo:acme/app",
		kind: "fact" as const,
		subject: undefined as string | undefined,
		text: SECRET_TEXT,
		writer: "hermes",
		...over,
	};
	return {
		id,
		scope: base.scope,
		kind: base.kind,
		text: base.text,
		writer: base.writer,
		...(base.subject !== undefined ? { subject: base.subject } : {}),
		actor: "agent",
		trust: "agent-claimed",
		ttl: "permanent",
		created: minutesAgo(30),
		version: 1,
		entry_hash: contentHash({ scope: base.scope, kind: base.kind, subject: base.subject ?? null, text: base.text, writer: base.writer }),
		needs_reverification: false,
		source_event: `evt-${id}`,
		idempotency_key: `key-${id}`,
		...over,
	};
}

const ledgerEvent = (e: MemoryEntry, offsetSeconds = 2): LedgerWriteEvent => ({
	id: `ev-${e.id}`,
	ts: new Date(Date.parse(e.created) + offsetSeconds * 1000).toISOString(),
	surface: e.writer,
	scope: e.scope,
	kind: e.kind,
});

interface World {
	entries: MemoryEntry[];
	/** bank -> document id -> the entry id the document names (`null`: no entry_id metadata). */
	docs: Map<string, Map<string, string | null>>;
	events: LedgerWriteEvent[];
	parked: ReadonlySet<string> | null | undefined;
	shared: Set<string>;
	calls: { pages: number; entryReads: number; lookups: number; lists: number; ledgerPages: number; shared: number };
	readers: ConsistencyReaders;
}

function world(entries: MemoryEntry[], setup: { docs?: "auto" | "none"; events?: "auto" | "none"; listing?: boolean; ledgerPageLimit?: number; listPageLimit?: number } = {}): World {
	const docs = new Map<string, Map<string, string | null>>();
	const events: LedgerWriteEvent[] = [];
	const w: World = {
		entries,
		docs,
		events,
		parked: undefined,
		shared: new Set(),
		calls: { pages: 0, entryReads: 0, lookups: 0, lists: 0, ledgerPages: 0, shared: 0 },
		readers: undefined as unknown as ConsistencyReaders,
	};
	if ((setup.docs ?? "auto") === "auto") {
		for (const e of entries) {
			if (e.superseded_by !== undefined || e.expired === true || !e.source_event) continue;
			const id = defaultDocumentId(e);
			if (id !== null) putDoc(w, bankFor(e.writer), id, e.id);
		}
	}
	if ((setup.events ?? "auto") === "auto") for (const e of entries) events.push(ledgerEvent(e));

	const listPageLimit = setup.listPageLimit ?? 1000;
	const plane: ConsistencyReaders["plane"] = {
		getDocument: async (bank, id) => {
			w.calls.lookups += 1;
			const entryId = w.docs.get(bank)?.get(id);
			if (entryId === undefined) return null;
			return entryId === null ? { id } : { id, entry_id: entryId };
		},
	};
	if (setup.listing !== false) {
		plane.listDocuments = async (bank, request) => {
			w.calls.lists += 1;
			const ids = [...(w.docs.get(bank)?.keys() ?? [])].sort();
			const from = request.cursor === null ? 0 : Number(request.cursor);
			const take = Math.min(request.limit, listPageLimit);
			const slice = ids.slice(from, from + take);
			return { ids: slice, next: from + take < ids.length ? String(from + take) : null };
		};
	}
	w.readers = {
		index: {
			page: async (request) => {
				w.calls.pages += 1;
				const sorted = [...w.entries].sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : a.id < b.id ? 1 : -1));
				const after = request.cursor;
				const rest = after === null ? sorted : sorted.filter((e) => e.created < after.before || (e.created === after.before && e.id < after.before_id));
				const slice = rest.slice(0, request.limit);
				const last = slice[slice.length - 1];
				const next: IndexCursor | null = last !== undefined && rest.length > request.limit ? { before: last.created, before_id: last.id } : null;
				return { entries: slice, next };
			},
			entry: async (id) => {
				w.calls.entryReads += 1;
				return w.entries.find((e) => e.id === id) ?? null;
			},
			documentShared: async (e) => {
				w.calls.shared += 1;
				return w.shared.has(e.id);
			},
		},
		plane,
		ledger: {
			memoryWrites: async (request) => {
				w.calls.ledgerPages += 1;
				const inside = w.events.filter((e) => e.ts >= request.since && e.ts <= request.until).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
				const from = request.cursor === null ? 0 : Number(request.cursor);
				const take = Math.min(request.limit, setup.ledgerPageLimit ?? 500);
				return { events: inside.slice(from, from + take), next: from + take < inside.length ? String(from + take) : null };
			},
		},
		outbox: { parkedEntryIds: async () => (w.parked === undefined ? new Set<string>() : w.parked) },
	};
	return w;
}

function putDoc(w: World, bank: string, id: string, entryId: string | null): void {
	const bankDocs = w.docs.get(bank) ?? new Map<string, string | null>();
	bankDocs.set(id, entryId);
	w.docs.set(bank, bankDocs);
}

const run = (w: World | ConsistencyReaders, over: Partial<ConsistencyOptions> = {}): Promise<ConsistencyReport> =>
	verifyConsistency("readers" in w ? w.readers : w, { now: () => NOW, bankFor, ...over });

const codes = (report: ConsistencyReport): string[] => report.findings.map((finding) => finding.code);

describe("a clean run", () => {
	test("three stores that agree report ok with exact counts and no findings", async () => {
		const w = world([entry("mem_a"), entry("mem_b", { subject: "deploy-window" }), entry("mem_c", { writer: "claude-code" })]);
		const report = await run(w);
		expect(report.ok).toBe(true);
		expect(report.findings).toEqual([]);
		expect(report.truncated).toBe(false);
		expect(report.schema).toBe(1);
		expect(report.generated_at).toBe("2026-10-26T12:00:00.000Z");
		expect(report.stores).toEqual({ index: { state: "ok" }, plane: { state: "ok" }, ledger: { state: "ok" } });
		expect(report.counts.entries_examined).toBe(3);
		expect(report.counts.entries_current).toBe(3);
		expect(report.counts.expected_in_plane).toBe(3);
		expect(report.counts.banks_examined).toBe(2);
		expect(report.counts.hash_checked).toBe(3);
		expect(report.counts.ledger_pairs).toBe(3);
		expect(report.coverage).toEqual({
			outbox: "known",
			plane_listing: "complete",
			ledger: "compared",
			banks: { configured: [], examined: ["sub-claude-code", "sub-hermes"], skipped: [], listing_truncated: [] },
			skipped_checks: [],
		});
		expect(Object.values(report.counts.findings_by_code).every((n) => n === 0)).toBe(true);
		expect(Object.keys(report.counts.findings_by_code).sort()).toEqual([...FINDING_CODES].sort());
	});

	test("an empty index is clean, not an error", async () => {
		const report = await run(world([]));
		expect(report.ok).toBe(true);
		expect(report.counts.entries_examined).toBe(0);
	});
});

describe("index_entry_missing_in_plane", () => {
	test("a current entry with no plane document is reported with its bank, document id and no content", async () => {
		const missing = entry("mem_gone", { subject: "runbook" });
		const w = world([entry("mem_ok"), missing]);
		w.docs.get("sub-hermes")?.delete(defaultDocumentId(missing) as string);
		const report = await run(w);
		expect(report.ok).toBe(false);
		expect(codes(report)).toEqual(["index_entry_missing_in_plane"]);
		const finding = report.findings[0];
		expect(finding).toMatchObject({ id: "mem_gone", entry_id: "mem_gone", bank: "sub-hermes", document_id: defaultDocumentId(missing), stores: ["index", "plane"] });
		expect(report.counts.findings_by_code.index_entry_missing_in_plane).toBe(1);
	});

	test("a listing that lacks a document the plane still has is confirmed by a point read, not reported", async () => {
		const e = entry("mem_late");
		const w = world([e], { docs: "none" });
		putDoc(w, "sub-hermes", "other", null);
		// The listing answers a stale page: the document is present for a point read only.
		const real = w.readers.plane.getDocument;
		w.readers.plane.getDocument = async (bank, id) => (id === defaultDocumentId(e) ? { id, entry_id: e.id } : real(bank, id));
		const report = await run(w);
		expect(codes(report)).not.toContain("index_entry_missing_in_plane");
	});

	test("a retain parked in the outbox is not reported, and is counted", async () => {
		const e = entry("mem_parked");
		const w = world([e], { docs: "none" });
		w.parked = new Set(["mem_parked"]);
		const report = await run(w);
		expect(report.findings).toEqual([]);
		expect(report.counts.parked_retains).toBe(1);
		expect(report.coverage.outbox).toBe("known");
		expect(w.calls.lookups).toBe(0);
	});

	test("an unreadable outbox is coverage, not a failed plane: the finding says a parked retain is not ruled out", async () => {
		const w = world([entry("mem_x")], { docs: "none" });
		w.readers.outbox = {
			parkedEntryIds: async () => {
				throw new Error("EACCES");
			},
		};
		const report = await run(w);
		expect(report.stores.plane.state).toBe("ok");
		expect(report.coverage.outbox).toBe("unknown");
		expect(codes(report)).toEqual(["index_entry_missing_in_plane"]);
		expect(report.findings[0]?.detail).toContain("parked retain is not ruled out");
	});

	test("a memory-only outbox (null) reads as unknown too", async () => {
		const w = world([entry("mem_x")], { docs: "none" });
		w.parked = null;
		const report = await run(w);
		expect(report.coverage.outbox).toBe("unknown");
		expect(codes(report)).toEqual(["index_entry_missing_in_plane"]);
	});

	test("superseded, expired, unsourced and underivable entries owe the plane nothing", async () => {
		const w = world(
			[
				entry("mem_sup", { superseded_by: "mem_newer" }),
				entry("mem_exp", { expired: true }),
				entry("mem_nosrc", { source_event: undefined }),
				entry("mem_nokey", { idempotency_key: undefined }),
			],
			{ docs: "none" },
		);
		const report = await run(w);
		expect(report.findings.filter((f) => f.code === "index_entry_missing_in_plane")).toEqual([]);
		expect(report.counts).toMatchObject({ skipped_expired: 1, skipped_unsourced: 1, skipped_underivable: 1, entries_superseded: 1, expected_in_plane: 0 });
	});
});

describe("forgotten entries", () => {
	test("a forgotten entry is absent from the plane on purpose and is NOT reported as missing", async () => {
		const w = world([entry("mem_f", { superseded_by: FORGOTTEN })], { docs: "none" });
		const report = await run(w);
		expect(report.ok).toBe(true);
		expect(report.findings).toEqual([]);
		expect(report.counts.entries_forgotten).toBe(1);
	});

	test("a forgotten entry whose document is still there is forgotten_entry_in_plane", async () => {
		const f = entry("mem_f", { superseded_by: FORGOTTEN });
		const w = world([f], { docs: "none" });
		putDoc(w, "sub-hermes", defaultDocumentId(f) as string, "mem_f");
		const report = await run(w);
		expect(codes(report)).toEqual(["forgotten_entry_in_plane"]);
		expect(report.findings[0]).toMatchObject({ id: "mem_f", bank: "sub-hermes", document_id: defaultDocumentId(f), stores: ["index", "plane"] });
	});

	test("a subject document a live entry still owns is shared, so it is left alone", async () => {
		const forgotten = entry("mem_old", { subject: "s", superseded_by: FORGOTTEN });
		const live = entry("mem_new", { subject: "s" });
		const w = world([forgotten, live]);
		expect(defaultDocumentId(forgotten)).toBe(defaultDocumentId(live));
		const report = await run(w);
		expect(report.findings).toEqual([]);
		expect(report.counts.shared_documents).toBe(1);
	});

	test("a forgotten entry's document confirmed shared by the index reader (outside the scanned set) is left alone", async () => {
		const forgotten = entry("mem_old", { subject: "s", superseded_by: FORGOTTEN });
		const w = world([forgotten], { docs: "none" });
		putDoc(w, "sub-hermes", defaultDocumentId(forgotten) as string, "mem_old");
		w.shared.add("mem_old");
		const report = await run(w);
		expect(report.findings).toEqual([]);
		expect(w.calls.shared).toBe(1);
	});
});

describe("plane_document_orphan and duplicate_document", () => {
	test("a document naming an entry the index lacks is an orphan", async () => {
		const w = world([entry("mem_a")]);
		putDoc(w, "sub-hermes", "ghost-doc", "mem_vanished");
		const report = await run(w);
		expect(codes(report)).toEqual(["plane_document_orphan"]);
		expect(report.findings[0]).toMatchObject({ id: "ghost-doc", entry_id: "mem_vanished", bank: "sub-hermes", document_id: "ghost-doc", stores: ["plane", "index"] });
	});

	test("a document naming a superseded entry nothing live shares is an orphan; one a live entry shares is not", async () => {
		const stale = entry("mem_stale", { superseded_by: "mem_next" });
		const w = world([stale], { docs: "none" });
		putDoc(w, "sub-hermes", "stale-doc", "mem_stale");
		expect(codes(await run(w))).toEqual(["plane_document_orphan"]);
		w.shared.add("mem_stale");
		expect((await run(w)).findings).toEqual([]);
	});

	test("a document with no entry_id metadata is an orphan without an entry id", async () => {
		const w = world([entry("mem_a")]);
		putDoc(w, "sub-hermes", "mystery", null);
		const report = await run(w);
		expect(codes(report)).toEqual(["plane_document_orphan"]);
		expect(report.findings[0]?.entry_id).toBeUndefined();
	});

	test("a forgotten entry's second document (under another id) is forgotten_entry_in_plane, not an orphan", async () => {
		const f = entry("mem_f", { superseded_by: FORGOTTEN });
		const w = world([f], { docs: "none" });
		putDoc(w, "sub-hermes", "second-doc", "mem_f");
		expect(codes(await run(w))).toEqual(["forgotten_entry_in_plane"]);
	});

	test("two documents for one entry is duplicate_document, and the document the entry should have is named", async () => {
		const e = entry("mem_a");
		const w = world([e]);
		putDoc(w, "sub-hermes", "stray-copy", "mem_a");
		const report = await run(w);
		expect(codes(report)).toEqual(["duplicate_document"]);
		expect(report.findings[0]).toMatchObject({ id: "mem_a", document_id: "stray-copy", expected_document_id: defaultDocumentId(e), stores: ["plane"] });
	});

	test("without a listing the orphan and duplicate checks are SKIPPED and ok is false: absence is never claimed", async () => {
		const w = world([entry("mem_a")], { listing: false });
		putDoc(w, "sub-hermes", "ghost-doc", "mem_vanished");
		const report = await run(w);
		expect(report.findings).toEqual([]);
		expect(report.coverage.plane_listing).toBe("unavailable");
		expect(report.coverage.skipped_checks).toEqual(["duplicate_document:plane_listing_unavailable", "plane_document_orphan:plane_listing_unavailable"]);
		expect(report.ok).toBe(false);
	});

	test("a listing the plane refuses as unsupported degrades the same way and still finds a missing document by lookup", async () => {
		const w = world([entry("mem_a")], { docs: "none" });
		w.readers.plane.listDocuments = async () => {
			throw new ReaderUnsupported("no such route");
		};
		const report = await run(w);
		expect(report.stores.plane.state).toBe("ok");
		expect(report.coverage.plane_listing).toBe("unavailable");
		expect(codes(report)).toEqual(["index_entry_missing_in_plane"]);
		expect(report.ok).toBe(false);
	});

	test("a document cap makes the listing partial and the run truncated, without false missing findings", async () => {
		const entries = [entry("mem_a"), entry("mem_b"), entry("mem_c")];
		const w = world(entries);
		const report = await run(w, { maxDocuments: 2 });
		expect(report.truncated).toBe(true);
		expect(report.coverage.plane_listing).toBe("partial");
		expect(report.counts.plane_documents_listed).toBe(2);
		expect(report.findings).toEqual([]);
		expect(report.ok).toBe(true);
	});

	test("listing pages are followed to the end", async () => {
		const entries = Array.from({ length: 5 }, (_, i) => entry(`mem_${i}`));
		const w = world(entries, { listPageLimit: 2 });
		const report = await run(w);
		expect(w.calls.lists).toBe(3);
		expect(report.counts.plane_documents_listed).toBe(5);
		expect(report.coverage.plane_listing).toBe("complete");
	});
});

describe("hash_mismatch", () => {
	test("a tampered body is reported; the v2 preimage and a hashless row are not", async () => {
		const tampered = entry("mem_t");
		tampered.text = "changed after the hash was taken";
		const v2 = entry("mem_v2");
		v2.entry_hash = contentHash({ scope: v2.scope, kind: v2.kind, subject: null, text: v2.text, writer: v2.writer, hv: HASH_VERSION_MARKER, tenant: HASH_TENANT });
		const legacy = entry("mem_legacy", { entry_hash: "" });
		const report = await run(world([tampered, v2, legacy]));
		expect(codes(report)).toEqual(["hash_mismatch"]);
		expect(report.findings[0]).toMatchObject({ id: "mem_t", stores: ["index"] });
		expect(report.counts.hash_checked).toBe(2);
		expect(report.counts.hash_unchecked).toBe(1);
		expect(JSON.stringify(report)).not.toContain("changed after");
	});

	test("a superseded or forgotten row's hash is checked too", async () => {
		const bad = entry("mem_s", { superseded_by: "mem_n" });
		bad.text = "different";
		expect(codes(await run(world([bad])))).toEqual(["hash_mismatch"]);
	});
});

describe("ledger comparison", () => {
	test("an entry with no accepted write event is index_entry_without_ledger_write", async () => {
		const e = entry("mem_a");
		const w = world([e], { events: "none" });
		const report = await run(w);
		expect(codes(report)).toEqual(["index_entry_without_ledger_write"]);
		expect(report.findings[0]).toMatchObject({ id: "mem_a", entry_id: "mem_a", stores: ["index", "ledger"] });
		expect(report.findings[0]?.detail).toContain("without an entry id");
	});

	test("an event with no entry is ledger_write_without_entry and names the event", async () => {
		const w = world([]);
		w.events.push({ id: "ev-orphan", ts: minutesAgo(120), surface: "hermes", scope: "repo:acme/app", kind: "fact" });
		const report = await run(w);
		expect(codes(report)).toEqual(["ledger_write_without_entry"]);
		expect(report.findings[0]).toMatchObject({ id: "ev-orphan", event_id: "ev-orphan", stores: ["ledger", "index"] });
		expect(report.findings[0]?.detail).toContain("idempotent replay");
	});

	describe("pairing by the entry id the event names", () => {
		const named = (e: MemoryEntry, namesEntry: string, offsetSeconds = 2): LedgerWriteEvent => ({ ...ledgerEvent(e, offsetSeconds), id: `ev-names-${namesEntry}`, entry_id: namesEntry });

		test("an exact entry id wins over a heuristic candidate that fits better by time", async () => {
			const a = entry("mem_a", { created: minutesAgo(30) });
			const b = entry("mem_b", { created: minutesAgo(45) });
			const w = world([a, b], { events: "none" });
			// By writer, scope, kind and time this event belongs to mem_a; it names mem_b.
			w.events.push(named(a, "mem_b"));
			const report = await run(w);
			expect(codes(report)).toEqual(["index_entry_without_ledger_write"]);
			expect(report.findings[0]).toMatchObject({ id: "mem_a", entry_id: "mem_a" });
			expect(report.counts.ledger_pairs).toBe(1);
			expect(report.counts.ledger_events_judged).toBe(1);
		});

		test("an exact entry id pairs even when the event is far outside the heuristic lag", async () => {
			const a = entry("mem_a");
			const w = world([a], { events: "none" });
			w.events.push(named(a, "mem_a", 600));
			const report = await run(w);
			expect(report.findings).toEqual([]);
			expect(report.counts.ledger_pairs).toBe(1);
		});

		test("a replayed write naming the same entry is a second event for it, not a finding", async () => {
			const a = entry("mem_a");
			const w = world([a], { events: "none" });
			w.events.push(named(a, "mem_a"), { ...named(a, "mem_a", 5), id: "ev-replay" });
			const report = await run(w);
			expect(report.findings).toEqual([]);
			expect(report.counts.ledger_pairs).toBe(1);
			expect(report.counts.ledger_events_judged).toBe(2);
		});

		test("a legacy event without entry_id still pairs by the heuristic beside an event that names its entry", async () => {
			const a = entry("mem_a", { created: minutesAgo(30) });
			const b = entry("mem_b", { created: minutesAgo(45) });
			const w = world([a, b], { events: "none" });
			w.events.push(named(a, "mem_a"), ledgerEvent(b));
			const report = await run(w);
			expect(report.findings).toEqual([]);
			expect(report.ok).toBe(true);
			expect(report.counts.ledger_pairs).toBe(2);
		});

		test("a replay naming an entry does not free that entry's legacy event for a neighbour: the neighbour is still reported", async () => {
			const a = entry("mem_a", { created: minutesAgo(30) });
			const b = entry("mem_b", { created: new Date(Date.parse(minutesAgo(30)) + 1000).toISOString() });
			const w = world([a, b], { events: "none" });
			// Only mem_a was ever audited, by an event written before entry_id existed; a replay 10 minutes later names it.
			w.events.push(ledgerEvent(a), named(a, "mem_a", 600));
			const report = await run(w);
			expect(codes(report)).toEqual(["index_entry_without_ledger_write"]);
			expect(report.findings[0]).toMatchObject({ id: "mem_b", entry_id: "mem_b" });
			expect(report.counts.ledger_pairs).toBe(1);
			expect(report.counts.ledger_events_judged).toBe(2);
		});

		test("an entry with only an event naming it is satisfied and takes no other entry's legacy event", async () => {
			const a = entry("mem_a", { created: minutesAgo(30) });
			const b = entry("mem_b", { created: minutesAgo(25) });
			const w = world([a, b], { events: "none" });
			w.events.push(named(a, "mem_a"), ledgerEvent(b));
			const report = await run(w);
			expect(report.findings).toEqual([]);
			expect(report.ok).toBe(true);
			expect(report.counts.ledger_pairs).toBe(2);
			expect(report.counts.ledger_events_judged).toBe(2);
		});

		test("an event naming an entry the index does not hold is reported and never takes another entry's slot", async () => {
			const a = entry("mem_a");
			const w = world([a], { events: "none" });
			w.events.push(named(a, "mem_gone"));
			const report = await run(w);
			expect(codes(report).sort()).toEqual(["index_entry_without_ledger_write", "ledger_write_without_entry"]);
			const orphan = report.findings.find((finding) => finding.code === "ledger_write_without_entry");
			expect(orphan).toMatchObject({ event_id: "ev-names-mem_gone", entry_id: "mem_gone", stores: ["ledger", "index"] });
			expect(orphan?.detail).toContain("mem_gone");
		});

		test("a malformed entry_id is no id: the event pairs like a legacy one", async () => {
			const a = entry("mem_a");
			const w = world([a], { events: "none" });
			w.events.push({ ...ledgerEvent(a), entry_id: 7 as unknown as string });
			const report = await run(w);
			expect(report.findings).toEqual([]);
			expect(report.counts.ledger_pairs).toBe(1);
		});
	});

	test("the event's scope is compared in canonical form", async () => {
		const e = entry("mem_a");
		const w = world([e], { events: "none" });
		w.events.push({ ...ledgerEvent(e), scope: "REPO:acme/app" });
		expect((await run(w)).findings).toEqual([]);
	});

	test("an event further than the slack from its entry does not pair", async () => {
		const e = entry("mem_a");
		const w = world([e], { events: "none" });
		w.events.push(ledgerEvent(e, 600));
		const report = await run(w);
		expect(codes(report).sort()).toEqual(["index_entry_without_ledger_write", "ledger_write_without_entry"]);
	});

	test("writes inside the grace window are not judged either way", async () => {
		const fresh = entry("mem_fresh", { created: new Date(NOW - 20_000).toISOString() });
		const w = world([fresh], { events: "none" });
		w.events.push({ id: "ev-fresh-orphan", ts: new Date(NOW - 10_000).toISOString(), surface: "claude-code", scope: "global", kind: "fact" });
		const report = await run(w);
		expect(report.findings).toEqual([]);
		expect(report.counts.ledger_entries_judged).toBe(0);
	});

	test("an entry whose writer is not a known surface cannot have an event and is not judged", async () => {
		const w = world([entry("mem_x", { writer: "not-a-surface" })], { events: "none" });
		expect((await run(w)).findings).toEqual([]);
	});

	test("entries older than the ledger window are not judged", async () => {
		const old = entry("mem_old", { created: new Date(NOW - 10 * 86_400_000).toISOString() });
		const w = world([old], { events: "none" });
		const report = await run(w);
		expect(report.findings).toEqual([]);
		expect(report.counts.ledger_entries_judged).toBe(0);
	});

	test("many events page through and pair; a reader that stops making progress is the ledger unreachable", async () => {
		const entries = Array.from({ length: 6 }, (_, i) => entry(`mem_${i}`, { created: minutesAgo(30 + i * 10) }));
		const w = world(entries, { ledgerPageLimit: 2 });
		const report = await run(w);
		expect(report.ok).toBe(true);
		expect(w.calls.ledgerPages).toBe(3);
		expect(report.counts.ledger_events_examined).toBe(6);

		const stuck = world(entries);
		stuck.readers.ledger.memoryWrites = async () => ({ events: [], next: "same" });
		const bad = await run(stuck);
		expect(bad.stores.ledger).toEqual({ state: "store_unreachable", reason: "memoryWrites: paging made no progress" });
	});

	test("a ledger event cap skips the comparison and says so", async () => {
		const w = world([entry("mem_a"), entry("mem_b", { created: minutesAgo(40) })]);
		const report = await run(w, { maxLedgerEvents: 1 });
		expect(report.coverage.ledger).toBe("partial");
		expect(report.coverage.skipped_checks).toEqual(["ledger_compare:ledger_event_cap"]);
		expect(report.truncated).toBe(true);
		expect(report.ok).toBe(false);
		expect(codes(report)).toEqual([]);
	});

	test("malformed events are counted, not trusted", async () => {
		const w = world([]);
		// Served as-is: the fake's own time filter would drop an unparsable ts before the verifier saw it.
		const bad: LedgerWriteEvent = { id: "ev-bad", ts: "not a date", surface: "hermes", scope: "global", kind: "fact" };
		w.readers.ledger.memoryWrites = async () => ({ events: [bad], next: null });
		const report = await run(w);
		expect(report.counts.ledger_events_malformed).toBe(1);
		expect(report.findings).toEqual([]);
	});
});

describe("bounds", () => {
	test("index pages are followed to the end and every entry is counted once", async () => {
		const entries = Array.from({ length: 7 }, (_, i) => entry(`mem_${i}`, { created: minutesAgo(30 + i) }));
		const w = world(entries);
		const report = await run(w, { pageSize: 2 });
		expect(w.calls.pages).toBe(4);
		expect(report.counts.entries_examined).toBe(7);
		expect(report.truncated).toBe(false);
	});

	test("the entry cap truncates the run and counts stay exact for what was examined", async () => {
		const entries = Array.from({ length: 7 }, (_, i) => entry(`mem_${i}`, { created: minutesAgo(30 + i) }));
		const w = world(entries);
		const report = await run(w, { maxEntries: 3, pageSize: 2 });
		expect(report.truncated).toBe(true);
		expect(report.counts.entries_examined).toBe(3);
		expect(report.counts.expected_in_plane).toBe(3);
		expect(report.ok).toBe(true);
		// The newest three are the ones examined.
		expect(report.counts.ledger_entries_judged).toBe(3);
	});

	test("exactly the cap is not truncated", async () => {
		const entries = Array.from({ length: 3 }, (_, i) => entry(`mem_${i}`, { created: minutesAgo(30 + i) }));
		const report = await run(world(entries), { maxEntries: 3 });
		expect(report.truncated).toBe(false);
	});

	test("the findings cap keeps the first sorted findings, flags truncated, and counts every finding", async () => {
		const entries = Array.from({ length: 5 }, (_, i) => entry(`mem_${i}`, { created: minutesAgo(30 + i) }));
		const report = await run(world(entries, { docs: "none" }), { maxFindings: 2 });
		expect(report.findings.map((f) => f.id)).toEqual(["mem_0", "mem_1"]);
		expect(report.counts.findings_total).toBe(5);
		expect(report.counts.findings_by_code.index_entry_missing_in_plane).toBe(5);
		expect(report.truncated).toBe(true);
		expect(report.ok).toBe(false);
	});

	test("--since leaves older entries out and ends the scan at the first one", async () => {
		const entries = [entry("mem_new", { created: minutesAgo(10) }), entry("mem_mid", { created: minutesAgo(60) }), entry("mem_old", { created: minutesAgo(600) })];
		const w = world(entries);
		const report = await run(w, { since: minutesAgo(120), pageSize: 1 });
		expect(report.counts.entries_examined).toBe(2);
		expect(report.scope.since).toBe(minutesAgo(120));
		expect(w.calls.pages).toBe(3);
		expect(report.truncated).toBe(false);
	});

	test("a bank filter keeps only that bank's entries, documents and events", async () => {
		const w = world([entry("mem_h"), entry("mem_c", { writer: "claude-code" })], { docs: "none" });
		const report = await run(w, { bank: "sub-claude-code" });
		expect(report.counts.entries_examined).toBe(1);
		expect(report.counts.banks_examined).toBe(1);
		expect(report.findings.map((f) => f.id)).toEqual(["mem_c"]);
		expect(report.scope.bank).toBe("sub-claude-code");
	});

	test("invalid options are refused with a typed error, not run", async () => {
		const w = world([]);
		await expect(run(w, { maxEntries: 0 })).rejects.toBeInstanceOf(ConsistencyOptionError);
		await expect(run(w, { maxEntries: 1_000_000 })).rejects.toBeInstanceOf(ConsistencyOptionError);
		await expect(run(w, { since: "yesterday-ish" })).rejects.toBeInstanceOf(ConsistencyOptionError);
		await expect(run(w, { bank: "" })).rejects.toBeInstanceOf(ConsistencyOptionError);
		expect(DEFAULT_MAX_ENTRIES).toBe(5000);
	});
});

describe("an unreachable store", () => {
	test("the index failing marks only the index and checks nothing else; never a crash, never clean", async () => {
		const w = world([entry("mem_a")]);
		w.readers.index.page = async () => {
			throw new Error("connect ECONNREFUSED 10.1.2.3:5432 at postgres://user:hunter2@db.internal:5432/app");
		};
		const report = await run(w);
		expect(report.ok).toBe(false);
		expect(report.stores.index.state).toBe("store_unreachable");
		expect(report.stores.plane).toEqual({ state: "not_checked" });
		expect(report.stores.ledger).toEqual({ state: "not_checked" });
		const reason = report.stores.index.reason ?? "";
		expect(reason).not.toContain("postgres://");
		expect(reason).not.toContain("hunter2");
		expect(reason).not.toContain("10.1.2.3");
		expect(w.calls.lookups).toBe(0);
	});

	test("the plane failing keeps the findings already made and still compares the ledger", async () => {
		const w = world([entry("mem_a"), entry("mem_b", { created: minutesAgo(40) })], { docs: "none", events: "none" });
		w.readers.plane.getDocument = async () => {
			throw new Error("hindsight GET /v1/default/banks/x: unreachable (fetch failed)");
		};
		const report = await run(w);
		expect(report.stores.plane.state).toBe("store_unreachable");
		expect(report.stores.plane.reason).toContain("getDocument");
		expect(report.stores.ledger).toEqual({ state: "ok" });
		expect(codes(report)).toEqual(["index_entry_without_ledger_write", "index_entry_without_ledger_write"]);
		expect(report.ok).toBe(false);
	});

	test("the ledger failing marks the ledger and keeps the plane findings", async () => {
		const w = world([entry("mem_a")], { docs: "none" });
		w.readers.ledger.memoryWrites = async () => {
			throw new Error("greptime: 503");
		};
		const report = await run(w);
		expect(report.stores.ledger.state).toBe("store_unreachable");
		expect(report.stores.plane).toEqual({ state: "ok" });
		expect(codes(report)).toEqual(["index_entry_missing_in_plane"]);
	});

	test("a reader that never answers is cut by the per-reader timeout", async () => {
		const w = world([entry("mem_a")]);
		w.readers.plane.listDocuments = () => new Promise<never>(() => undefined);
		const report = await run(w, { timer: immediateTimer, readerTimeoutMs: 5 });
		expect(report.stores.plane).toEqual({ state: "store_unreachable", reason: "listDocuments: timeout after 5ms" });
		expect(report.ok).toBe(false);
	});

	test("a reader that resolves before the timer is not timed out", async () => {
		const report = await run(world([entry("mem_a")]), { timer: immediateTimer, readerTimeoutMs: 5 });
		expect(report.ok).toBe(true);
	});

	test("the total deadline, by the injected clock, stops the run at the next read", async () => {
		let clock = NOW;
		const entries = [entry("mem_a"), entry("mem_b", { created: minutesAgo(40) })];
		const w = world(entries, { docs: "none" });
		const real = w.readers.plane.getDocument;
		w.readers.plane.getDocument = async (bank, id) => {
			clock += 10_000;
			return real(bank, id);
		};
		const report = await verifyConsistency(w.readers, { now: () => clock, bankFor, deadlineMs: 5000, concurrency: 1 });
		expect(report.stores.plane).toEqual({ state: "store_unreachable", reason: "getDocument: deadline_exceeded" });
		expect(report.findings).toHaveLength(1);
		expect(report.ok).toBe(false);
	});
});

describe("determinism and content hygiene", () => {
	test("the same stores in any read order give byte-identical JSON", async () => {
		const entries = Array.from({ length: 6 }, (_, i) => entry(`mem_${i}`, { created: minutesAgo(30 + i) }));
		const a = world(entries, { docs: "none", events: "none" });
		putDoc(a, "sub-hermes", "ghost-b", "nope");
		putDoc(a, "sub-hermes", "ghost-a", null);
		const b = world([...entries].reverse(), { docs: "none", events: "none" });
		putDoc(b, "sub-hermes", "ghost-a", null);
		putDoc(b, "sub-hermes", "ghost-b", "nope");
		const first = formatReportJson(await run(a, { concurrency: 4 }));
		const second = formatReportJson(await run(b, { concurrency: 1 }));
		expect(second).toBe(first);
		expect(first.endsWith("\n")).toBe(true);
		expect(JSON.parse(first).findings.length).toBeGreaterThan(6);
	});

	test("findings are sorted by code, bank and id", async () => {
		const report = await run(world([entry("mem_b"), entry("mem_a"), entry("mem_c")], { docs: "none", events: "none" }));
		const keys = report.findings.map((f) => `${f.code}|${f.id}`);
		expect(keys).toEqual([...keys].sort());
	});

	test("no finding, detail or status carries content, a subject or a store URL", async () => {
		const subject = "subject-needle-9921";
		const w = world([entry("mem_a", { subject }), entry("mem_t", { subject: "tamper" })], { docs: "none", events: "none" });
		w.entries[1]!.text = "tampered-needle";
		putDoc(w, "sub-hermes", "bad id with spaces & content-needle", null);
		const json = formatReportJson(await run(w));
		for (const needle of [SECRET_TEXT, subject, "tampered-needle", "content-needle", "http://", "https://"]) expect(json).not.toContain(needle);
		expect(json).toContain("invalid:");
	});

	test("the human summary is short, names the verdict and the counts, and carries no ids", async () => {
		const report = await run(world([entry("mem_a")], { docs: "none" }));
		const text = formatReportText(report);
		expect(text).toContain("DRIFT (1 finding)");
		expect(text).toContain("index_entry_missing_in_plane: 1");
		expect(text).not.toContain("mem_a");
		expect(text.split("\n").length).toBeLessThan(15);
		expect(formatReportText(await run(world([entry("mem_a")])))).toContain("CLEAN");
	});

	test("scrubReason redacts credentials and strips URLs and addresses", () => {
		const text = scrubReason("failed https://api.example.com/v1?token=abc at 10.0.0.9:8888\n again");
		expect(text).not.toContain("https://");
		expect(text).not.toContain("10.0.0.9");
		expect(text).not.toContain("\n");
		expect(scrubReason("word ".repeat(300)).length).toBe(200);
	});
});

describe("planRepairs", () => {
	async function messy(): Promise<ConsistencyReport> {
		const missing = entry("mem_missing", { created: minutesAgo(31) });
		const forgotten = entry("mem_forgotten", { superseded_by: FORGOTTEN, created: minutesAgo(32) });
		const tampered = entry("mem_tampered", { created: minutesAgo(33) });
		tampered.text = "changed";
		const dup = entry("mem_dup", { created: minutesAgo(34) });
		const w = world([missing, forgotten, tampered, dup], { events: "none" });
		w.docs.get("sub-hermes")?.delete(defaultDocumentId(missing) as string);
		putDoc(w, "sub-hermes", defaultDocumentId(forgotten) as string, "mem_forgotten");
		putDoc(w, "sub-hermes", "stray-copy", "mem_dup");
		putDoc(w, "sub-hermes", "orphan-doc", "mem_vanished");
		putDoc(w, "sub-hermes", "unlinked-doc", null);
		return run(w);
	}

	test("each finding implies at most one safe action as an instruction list, and nothing is executed", async () => {
		const report = await messy();
		const plan = planRepairs(report);
		expect(plan.schema).toBe(1);
		expect(plan.complete).toBe(true);
		const byAction = (name: string) => plan.actions.filter((a) => a.action === name);

		const [retain] = byAction("re_retain");
		expect(retain).toMatchObject({ class: "safe", finding: "index_entry_missing_in_plane", finding_id: "mem_missing" });
		expect(retain?.steps.map((s) => s.op)).toEqual(["read_entry", "require", "require", "retain_document"]);
		expect(retain?.steps[3]).toEqual({ op: "retain_document", entry_id: "mem_missing", bank: "sub-hermes", document_id: defaultDocumentId(entry("mem_missing")) as string });

		const [forget] = byAction("delete_forgotten_document");
		expect(forget).toMatchObject({ class: "safe", finding: "forgotten_entry_in_plane", finding_id: "mem_forgotten" });
		expect(forget?.steps.map((s) => (s.op === "require" ? `require:${s.condition}` : s.op))).toEqual([
			"read_entry",
			"require:entry_forgotten",
			"require:document_present",
			"require:document_not_shared",
			"delete_document",
		]);

		const orphans = byAction("delete_orphan_document");
		expect(orphans.map((a) => a.finding_id).sort()).toEqual(["mem_dup", "orphan-doc"]);
		expect(orphans.every((a) => a.class === "orphan")).toBe(true);
		const dupAction = orphans.find((a) => a.finding === "duplicate_document");
		expect(dupAction?.steps[0]).toMatchObject({ op: "require", condition: "document_orphaned", document_id: "stray-copy", expected_document_id: defaultDocumentId(entry("mem_dup")) as string });

		// The index row, the ledger and an unlinked document are never repaired automatically.
		const unrepairable = plan.unrepairable.map((u) => `${u.finding}:${u.finding_id}`).sort();
		expect(unrepairable).toEqual(
			[
				"hash_mismatch:mem_tampered",
				"plane_document_orphan:unlinked-doc",
				...report.findings.filter((f) => f.code === "index_entry_without_ledger_write").map((f) => `index_entry_without_ledger_write:${f.id}`),
			].sort(),
		);
		// The only writes any instruction names are plane writes.
		const ops = new Set(plan.actions.flatMap((a) => a.steps.map((s) => s.op)));
		expect([...ops].sort()).toEqual(["delete_document", "read_entry", "require", "retain_document"]);
	});

	test("a plan over a cut findings list or an unreachable store says it is not complete", async () => {
		const entries = Array.from({ length: 4 }, (_, i) => entry(`mem_${i}`, { created: minutesAgo(30 + i) }));
		const cut = await run(world(entries, { docs: "none" }), { maxFindings: 2 });
		expect(planRepairs(cut).complete).toBe(false);
		const w = world(entries, { docs: "none" });
		w.readers.ledger.memoryWrites = async () => {
			throw new Error("down");
		};
		expect(planRepairs(await run(w)).complete).toBe(false);
	});

	test("a clean report plans nothing", async () => {
		const plan = planRepairs(await run(world([entry("mem_a")])));
		expect(plan).toEqual({ schema: 1, generated_at: "2026-10-26T12:00:00.000Z", complete: true, actions: [], unrepairable: [] });
	});
});

describe("paging that does not move", () => {
	test("a ledger page with no write events but a moving cursor is not a stall", async () => {
		const w = world([entry("mem_a")]);
		const real = w.readers.ledger.memoryWrites;
		w.readers.ledger.memoryWrites = async (request) => (request.cursor === null ? { events: [], next: "1" } : real({ ...request, cursor: null }));
		const report = await run(w);
		expect(report.ok).toBe(true);
		expect(report.counts.ledger_pairs).toBe(1);
	});

	test("a plane listing that repeats itself is the plane unreachable, not an endless read", async () => {
		const w = world([entry("mem_a")]);
		w.readers.plane.listDocuments = async () => ({ ids: ["same"], next: "1" });
		const report = await run(w);
		expect(report.stores.plane).toEqual({ state: "store_unreachable", reason: "listDocuments: paging made no progress" });
	});

	test("an index page that comes back empty with a cursor is the index unreachable", async () => {
		const w = world([entry("mem_a")]);
		w.readers.index.page = async () => ({ entries: [], next: { before: minutesAgo(1), before_id: "x" } });
		const report = await run(w);
		expect(report.stores.index.state).toBe("store_unreachable");
		expect(report.stores.index.reason).toContain("empty page");
	});
});

describe("configured banks with no index row", () => {
	const configured = ["sub-hermes", "sub-swept"];

	test("a configured bank holding only orphan documents is reported as orphans; without the list it was never looked at", async () => {
		const w = world([entry("mem_a")]);
		putDoc(w, "sub-swept", "stray-one", "mem_gone");
		putDoc(w, "sub-swept", "stray-two", null);
		expect((await run(w)).ok).toBe(true);
		const report = await run(w, { configuredBanks: configured });
		expect(codes(report)).toEqual(["plane_document_orphan", "plane_document_orphan"]);
		expect(report.findings.map((finding) => [finding.bank, finding.document_id])).toEqual([
			["sub-swept", "stray-one"],
			["sub-swept", "stray-two"],
		]);
		expect(report.ok).toBe(false);
		expect(report.counts.banks_examined).toBe(2);
		expect(report.coverage.banks).toEqual({ configured, examined: configured, skipped: [], listing_truncated: [] });
	});

	test("an empty index with configured banks still lists every bank: the plane listing is complete, not not_checked", async () => {
		const w = world([]);
		putDoc(w, "sub-swept", "stray-one", "mem_gone");
		const report = await run(w, { configuredBanks: configured });
		expect(w.calls.lists).toBe(2);
		expect(report.coverage.plane_listing).toBe("complete");
		expect(codes(report)).toEqual(["plane_document_orphan"]);
	});

	test("a configured bank that cannot be read is skipped with a reason, the other banks are still read, and the verdict is not clean", async () => {
		const w = world([entry("mem_a")]);
		const list = w.readers.plane.listDocuments?.bind(w.readers.plane);
		w.readers.plane.listDocuments = async (bank, request) => {
			if (bank === "sub-swept") throw new Error("hindsight unreachable at https://hs.internal:8888/v1");
			return (list as NonNullable<typeof list>)(bank, request);
		};
		const report = await run(w, { configuredBanks: configured });
		expect(report.stores.plane).toEqual({ state: "ok" });
		expect(report.findings).toEqual([]);
		expect(report.ok).toBe(false);
		expect(report.coverage.plane_listing).toBe("partial");
		expect(report.coverage.banks.examined).toEqual(["sub-hermes"]);
		expect(report.coverage.banks.skipped).toEqual([{ bank: "sub-swept", reason: "listing failed: hindsight unreachable at <url>" }]);
		expect(report.coverage.skipped_checks).toEqual(["plane_bank_skipped:sub-swept:listing failed: hindsight unreachable at <url>"]);
		expect(report.counts.banks_examined).toBe(1);
		expect(JSON.stringify(report)).not.toContain("hs.internal");
		expect(formatReportText(report)).toContain("INCOMPLETE");
	});

	test("a plane with no document listing skips every configured bank and says so once", async () => {
		const w = world([], { listing: false });
		const report = await run(w, { configuredBanks: configured });
		expect(report.coverage.plane_listing).toBe("unavailable");
		expect(report.coverage.banks.examined).toEqual([]);
		expect(report.coverage.banks.skipped.map((skipped) => skipped.bank)).toEqual(configured);
		expect(report.coverage.skipped_checks).toEqual(["duplicate_document:plane_listing_unavailable", "plane_document_orphan:plane_listing_unavailable"]);
		expect(report.ok).toBe(false);
	});

	test("a document cap that cuts a configured bank's listing is reported per bank", async () => {
		const w = world([]);
		putDoc(w, "sub-swept", "stray-one", "mem_gone");
		putDoc(w, "sub-swept", "stray-two", "mem_gone");
		const report = await run(w, { configuredBanks: ["sub-swept"], maxDocuments: 1 });
		expect(report.truncated).toBe(true);
		expect(report.coverage.banks.listing_truncated).toEqual(["sub-swept"]);
		expect(formatReportText(report)).toContain("document listing cut short for 1 bank(s): sub-swept");
	});

	test("a bank filter restricts the run to that bank whatever is configured", async () => {
		const w = world([]);
		putDoc(w, "sub-swept", "stray-one", "mem_gone");
		const report = await run(w, { bank: "sub-hermes", configuredBanks: configured });
		expect(w.calls.lists).toBe(1);
		expect(report.findings).toEqual([]);
		expect(report.coverage.banks.examined).toEqual(["sub-hermes"]);
	});

	test("a configured bank name must not be empty", async () => {
		await expect(run(world([]), { configuredBanks: [""] })).rejects.toBeInstanceOf(ConsistencyOptionError);
	});
});
