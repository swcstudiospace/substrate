import { describe, expect, test } from "bun:test";
import type { ForgetMarkRead } from "./cache.ts";
import type { EventQuery } from "./greptime.ts";
import type { LedgerReads, ReconcileCache, ReconcileIndex } from "./cross-layer-reconcile.ts";
import { reconcileOptionsFor, runTick, scheduledDeps } from "./cross-layer-reconcile-run.ts";
import { FORGET_ACTION, forgetMarker } from "./memory-forget.ts";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const FORGET = "fg_0123456789abcdef0123456789";
const MARKER = forgetMarker(FORGET);
const OPTIONS = reconcileOptionsFor({ briefSnapshotTtlS: 3600 });

type Row = Record<string, unknown>;

/** The fields of the `--json` report the tick's exit depends on. */
interface TickReport {
	mismatches: { count: number; first: { layer: string; key: string; reason: string } | null };
	layers: { ledger: { forgetNotes: number; namedEntries: number } };
}

/** A `memory.forget` note row as the ledger stores it: the payload is JSON text, and `ts` is epoch milliseconds. */
function forgetRow(id: string, minutesAgo: number, entryIds: string[]): Row {
	return {
		id,
		ts: NOW - minutesAgo * 60_000,
		kind: "note",
		payload: JSON.stringify({
			action: FORGET_ACTION,
			forget_id: FORGET,
			reason: "operator",
			actor: "agent",
			entry_count: entryIds.length,
			entry_ids: entryIds,
			counts: { marked: entryIds.length, already_forgotten: 0, already_superseded: 0, missing: 0 },
			plane: { deleted: 0, absent: 0, pending: 0, skipped: 0 },
		}),
	};
}

/** The ledger's read path. It answers from its rows and records each window query. It has no write method. */
class FakeReads implements LedgerReads {
	readonly queries: EventQuery[] = [];
	constructor(
		readonly rows: Row[],
		private readonly failWith: string | null = null,
	) {}

	async queryEvents(query: EventQuery): Promise<Row[]> {
		this.queries.push(query);
		if (this.failWith !== null) throw new Error(this.failWith);
		return this.rows.map((row) => ({ ...row }));
	}

	async readEvent(id: string): Promise<Row | null> {
		return this.rows.find((row) => row.id === id) ?? null;
	}
}

/** The index: `superseded_by` per id. A non-null marker means the row is out of force. It records every mark it is asked to set. */
class FakeIndex implements ReconcileIndex {
	readonly rows = new Map<string, string | null>();
	readonly marks: Array<{ ids: string[]; marker: string }> = [];

	async memoryMarkers(ids: readonly string[]): Promise<Map<string, string | null>> {
		const out = new Map<string, string | null>();
		for (const id of ids) if (this.rows.has(id)) out.set(id, this.rows.get(id) ?? null);
		return out;
	}

	async markMemoryForgotten(ids: readonly string[], marker: string): Promise<string[]> {
		this.marks.push({ ids: [...ids], marker });
		return [];
	}

	/** No forget times in this fake, so no forget mark is ever in a window: the index -> ledger direction reads nothing here. */
	async forgetMarksBetween(_sinceIso: string, _untilIso: string, _limit: number): Promise<{ marks: Array<{ entryId: string; marker: string }>; truncated: boolean }> {
		return { marks: [], truncated: false };
	}
}

/** The cache's forget mark. It records every mark it is asked to set. */
class FakeCache implements ReconcileCache {
	readonly ttls: number[] = [];
	constructor(private readonly mark: ForgetMarkRead) {}

	async readForgetMark(): Promise<ForgetMarkRead> {
		return this.mark;
	}

	async markForget(ttlSeconds: number): Promise<void> {
		this.ttls.push(ttlSeconds);
	}

	readonly bumped: string[] = [];

	async bump(key: string): Promise<void> {
		this.bumped.push(key);
	}
}

/** `mem_a` is out of force under the forget's marker, as `memoryForget` leaves it. */
function consistentIndex(): FakeIndex {
	const index = new FakeIndex();
	index.rows.set("mem_a", MARKER);
	return index;
}

/** A cache mark set after the forget's note and still inside its lifetime: what `memoryForget` leaves behind. */
const FRESH_MARK: ForgetMarkRead = { state: "present", atMs: NOW - 29 * 60_000 };

describe("the scheduled cross-layer reconcile tick", () => {
	test("a clean run reads the ledger window and leaves all three layers as they were", async () => {
		const reads = new FakeReads([forgetRow("evt_forget", 30, ["mem_a"])]);
		const index = consistentIndex();
		const cache = new FakeCache(FRESH_MARK);
		const rowsBefore = JSON.stringify(reads.rows);
		const indexBefore = [...index.rows.entries()];

		const deps = scheduledDeps({ reads, index, cache }, () => NOW);
		const result = await runTick(deps, OPTIONS, true);

		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
		const body = JSON.parse(result.stdout) as TickReport;
		expect(body.mismatches.count).toBe(0);
		expect(body.layers.ledger.forgetNotes).toBe(1);
		expect(body.layers.ledger.namedEntries).toBe(1);
		// The tick reached the reconcile: it asked the ledger for the note-kind window once.
		expect(reads.queries).toHaveLength(1);
		expect(reads.queries[0]?.match).toEqual({ kind: "note" });
		// It wrote nothing: no index mark, no cache mark, no ledger row.
		expect(index.marks).toEqual([]);
		expect(cache.ttls).toEqual([]);
		expect(JSON.stringify(reads.rows)).toBe(rowsBefore);
		expect([...index.rows.entries()]).toEqual(indexBefore);
		// The ledger port the tick is wired with refuses a write if one is ever asked for.
		await expect(deps.ledger.emitNote("probe", {})).rejects.toThrow("read-only");
		expect(reads.rows).toHaveLength(1);
	});

	test("a dirty run names the first mismatching key in text and still writes nothing", async () => {
		const reads = new FakeReads([forgetRow("evt_forget", 30, ["mem_a", "mem_b"])]);
		const index = consistentIndex();
		// `mem_b` is still in force: the forget named it, and the index never marked it.
		index.rows.set("mem_b", null);
		const cache = new FakeCache(FRESH_MARK);

		const result = await runTick(scheduledDeps({ reads, index, cache }, () => NOW), OPTIONS, false);

		expect(result.code).toBe(3);
		expect(result.stdout).toContain("mismatches: 1");
		expect(result.stdout).toContain("first: index mem_b (in-force)");
		expect(index.marks).toEqual([]);
		expect(cache.ttls).toEqual([]);
	});

	test("a layer that cannot be read fails the tick, judges nothing, and writes nothing", async () => {
		const reads = new FakeReads([forgetRow("evt_forget", 30, ["mem_a"])], "ledger connection refused");
		const index = consistentIndex();
		const cache = new FakeCache(FRESH_MARK);

		const result = await runTick(scheduledDeps({ reads, index, cache }, () => NOW), OPTIONS, false);

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("ledger-unavailable");
		expect(index.marks).toEqual([]);
		expect(cache.ttls).toEqual([]);
	});

	test("an incomplete read with no mismatch is not a clean run: it exits 1, names why, and still writes nothing", async () => {
		// A note whose payload does not decode is a forget the reconcile cannot judge, so the read is incomplete.
		const garbled: Row = { id: "evt_garbled", ts: NOW - 40 * 60_000, kind: "note", payload: "{not json" };
		const reads = new FakeReads([forgetRow("evt_forget", 30, ["mem_a"]), garbled]);
		const index = consistentIndex();
		const cache = new FakeCache(FRESH_MARK);

		const result = await runTick(scheduledDeps({ reads, index, cache }, () => NOW), OPTIONS, false);

		expect(result.code).toBe(1);
		expect(result.stdout).toContain("mismatches: 0");
		expect(result.stdout).toContain("coverage: incomplete, 1 malformed notes");
		expect(result.stderr).toContain("read incomplete (1 malformed notes)");
		expect(index.marks).toEqual([]);
		expect(cache.ttls).toEqual([]);
	});

	test("a mismatch outranks an incomplete read: the run exits 3 and still names the first key", async () => {
		const garbled: Row = { id: "evt_garbled", ts: NOW - 40 * 60_000, kind: "note", payload: "{not json" };
		const reads = new FakeReads([forgetRow("evt_forget", 30, ["mem_a", "mem_b"]), garbled]);
		const index = consistentIndex();
		index.rows.set("mem_b", null);
		const cache = new FakeCache(FRESH_MARK);

		const result = await runTick(scheduledDeps({ reads, index, cache }, () => NOW), OPTIONS, false);

		expect(result.code).toBe(3);
		expect(result.stdout).toContain("first: index mem_b (in-force)");
		expect(result.stdout).toContain("coverage: incomplete, 1 malformed notes");
		expect(index.marks).toEqual([]);
		expect(cache.ttls).toEqual([]);
	});
});
