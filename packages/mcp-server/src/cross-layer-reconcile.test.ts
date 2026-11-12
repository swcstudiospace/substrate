/**
 * The cross-layer reconcile (phase 78) is judged on its own contract: a clean run writes nothing, a planted mismatch is reported
 * with its first key and the per-layer counts, and a repair is refused without a confirmed plan and then touches only the
 * planned keys. Every store is a fake that records its writes, so a test can assert what was not written as well as what was.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { FORGET_MARK_KEY, type ForgetMarkRead, MEMORY_GENERATION_KEY, RECALL_GENERATION_KEY } from "./cache.ts";
import { isRecord } from "./corpus/validate.ts";
import type { EventQuery } from "./greptime.ts";
import { FORGET_ACTION } from "./memory-forget.ts";
import {
	applyRepair,
	type ApplyRun,
	type CrossLayerReport,
	ledgerFromSubstrate,
	type LedgerNote,
	type LedgerReads,
	type NoteWindow,
	type NoteWriter,
	planRepair,
	type PlanRun,
	RECONCILE_APPLIED_ACTION,
	RECONCILE_LEDGER_LIMIT,
	RECONCILE_MAX_KEYS,
	RECONCILE_PLAN_ACTION,
	type ReconcileCache,
	type ReconcileDeps,
	type ReconcileIndex,
	type ReconcileLedger,
	type ReconcileOptions,
	type ReconcileRun,
	runScheduledReconcile,
} from "./cross-layer-reconcile.ts";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
/** Window: 10:55 to 11:55, judged `settleMs` (5 minutes) behind now. */
const OPTIONS: ReconcileOptions = { windowMs: 3_600_000, settleMs: 300_000, markTtlS: 900 };
const FORGET = "fg_0123456789abcdef0123456789";
const OTHER = "fg_fedcba98765432100000000000";
const MARKER = `forgotten:${FORGET}`;
const OTHER_MARKER = `forgotten:${OTHER}`;
const TTL_S = OPTIONS.markTtlS;

function minutesAgo(minutes: number): string {
	return new Date(NOW - minutes * 60_000).toISOString();
}

/** A `memory.forget` note as `memoryForget` emits it: `entry_ids` names what the payload keeps, `entry_count` what the call touched. */
function forgetNote(id: string, agoMinutes: number, entryIds: string[], extra: { forgetId?: string; marked?: number; entryCount?: number } = {}): LedgerNote {
	return {
		id,
		ts: minutesAgo(agoMinutes),
		kind: "note",
		payload: {
			action: FORGET_ACTION,
			forget_id: extra.forgetId ?? FORGET,
			reason: "operator",
			actor: "agent",
			entry_count: extra.entryCount ?? entryIds.length,
			entry_ids: entryIds,
			counts: { marked: extra.marked ?? entryIds.length, already_forgotten: 0, already_superseded: 0, missing: 0 },
			plane: { deleted: 0, absent: 0, pending: 0, skipped: 0 },
		},
	};
}

class FakeLedger implements ReconcileLedger {
	readonly notes: LedgerNote[] = [];
	readonly writes: Array<{ summary: string; payload: Record<string, unknown> }> = [];
	truncated = false;
	storeWrites = true;
	failWindow: string | null = null;

	async notesBetween(since: string, until: string): Promise<NoteWindow> {
		if (this.failWindow !== null) throw new Error(this.failWindow);
		const notes = this.notes.filter((note) => note.kind === "note" && note.ts >= since && note.ts <= until);
		return { notes, truncated: this.truncated };
	}

	async readEvent(id: string): Promise<LedgerNote | null> {
		return this.notes.find((note) => note.id === id) ?? null;
	}

	async emitNote(summary: string, payload: Record<string, unknown>): Promise<{ id: string; stored: boolean }> {
		this.writes.push({ summary, payload });
		const id = `evt_${this.writes.length}`;
		if (this.storeWrites) {
			// Stored as a ledger row is: its payload round-trips through JSON.
			const copy: unknown = JSON.parse(JSON.stringify(payload));
			if (!isRecord(copy)) throw new Error("a payload round-trips as an object");
			this.notes.push({ id, ts: new Date(NOW).toISOString(), kind: "note", payload: copy });
		}
		return { id, stored: this.storeWrites };
	}
}

class FakeIndex implements ReconcileIndex {
	readonly rows = new Map<string, string | null>();
	readonly marks: Array<{ ids: string[]; marker: string }> = [];
	/** Runs after the reconcile has read the rows and before it marks them: how a concurrent writer races a repair. */
	beforeMark: (() => void) | null = null;
	failMark = false;

	async memoryMarkers(ids: readonly string[]): Promise<Map<string, string | null>> {
		const out = new Map<string, string | null>();
		for (const id of ids) {
			if (this.rows.has(id)) out.set(id, this.rows.get(id) ?? null);
		}
		return out;
	}

	async markMemoryForgotten(ids: readonly string[], marker: string): Promise<string[]> {
		this.marks.push({ ids: [...ids], marker });
		if (this.failMark) throw new Error("index write refused");
		this.beforeMark?.();
		const changed: string[] = [];
		for (const id of ids) {
			if (this.rows.get(id) === null) {
				this.rows.set(id, marker);
				changed.push(id);
			}
		}
		return changed;
	}

	/** Every forget-marked row, oldest id first: the fake keeps no forget times, so the window is not applied. */
	async forgetMarksBetween(_sinceIso: string, _untilIso: string, limit: number): Promise<{ marks: Array<{ entryId: string; marker: string }>; truncated: boolean }> {
		const marks = [...this.rows.entries()]
			.filter(([, marker]) => marker?.startsWith("forgotten:") === true)
			.map(([entryId, marker]) => ({ entryId, marker: marker ?? "" }))
			.sort((left, right) => (left.entryId < right.entryId ? -1 : left.entryId > right.entryId ? 1 : 0));
		return { marks: marks.slice(0, limit), truncated: marks.length > limit };
	}
}

class FakeCache implements ReconcileCache {
	mark: ForgetMarkRead = { state: "absent" };
	readonly ttls: number[] = [];
	readonly bumps: string[] = [];
	failRead = false;

	async readForgetMark(): Promise<ForgetMarkRead> {
		if (this.failRead) throw new Error("cache read refused");
		return this.mark;
	}

	async markForget(ttlSeconds: number): Promise<void> {
		this.ttls.push(ttlSeconds);
		this.mark = { state: "present", atMs: NOW };
	}

	async bump(key: string): Promise<void> {
		this.bumps.push(key);
	}
}

interface World {
	ledger: FakeLedger;
	index: FakeIndex;
	cache: FakeCache;
	deps: ReconcileDeps;
}

function world(): World {
	const ledger = new FakeLedger();
	const index = new FakeIndex();
	const cache = new FakeCache();
	return { ledger, index, cache, deps: { ledger, index, cache, now: () => NOW } };
}

function reportOf(run: ReconcileRun): CrossLayerReport {
	if (!run.ok) throw new Error(`${run.reason}: ${run.detail}`);
	return run.report;
}

function planOf(run: PlanRun): Extract<PlanRun, { ok: true }> {
	if (!run.ok) throw new Error(`${run.reason}: ${run.detail}`);
	return run;
}

function appliedOf(run: ApplyRun): Extract<ApplyRun, { ok: true }> {
	if (!run.ok) throw new Error(`${run.reason}: ${run.detail}`);
	return run;
}

/** A world where one forget (10 minutes ago) named three entries, and the index and cache disagree on two of them. */
function plantedDrift(): World {
	const w = world();
	w.ledger.notes.push(forgetNote("evt_forget_1", 10, ["mem_a", "mem_b", "mem_c"]));
	w.index.rows.set("mem_a", MARKER);
	w.index.rows.set("mem_b", null);
	w.index.rows.set("mem_c", null);
	// The cache mark is absent, so the forget's mark is stale too.
	return w;
}

describe("the scheduled reconcile: what it reports", () => {
	test("a clean run reports every layer and writes nothing", async () => {
		const w = world();
		w.ledger.notes.push(forgetNote("evt_forget_1", 10, ["mem_a", "mem_b"]));
		w.index.rows.set("mem_a", MARKER);
		w.index.rows.set("mem_b", MARKER);
		w.cache.mark = { state: "present", atMs: NOW - 5 * 60_000 };

		const report = reportOf(await runScheduledReconcile(w.deps, OPTIONS));

		expect(report.mismatches).toEqual({ count: 0, first: null, items: [] });
		expect(report.repairable).toBe(0);
		expect(report.coverage.complete).toBe(true);
		expect(report.layers).toEqual({
			ledger: { forgetNotes: 1, notesWithMarks: 1, namedEntries: 2 },
			index: { forgotten: 2, superseded: 0, absent: 0, inForce: 0 },
			cache: { state: "present", atMs: NOW - 5 * 60_000, checked: true },
		});
		expect(w.ledger.writes).toEqual([]);
		expect(w.index.marks).toEqual([]);
		expect(w.cache.ttls).toEqual([]);
	});

	test("a clean run plans nothing and writes no plan record", async () => {
		const w = world();
		w.ledger.notes.push(forgetNote("evt_forget_1", 10, ["mem_a"]));
		w.index.rows.set("mem_a", MARKER);
		w.cache.mark = { state: "present", atMs: NOW - 5 * 60_000 };

		const plan = planOf(await planRepair(w.deps, OPTIONS));

		expect(plan.planId).toBeNull();
		expect(plan.items).toEqual([]);
		expect(w.ledger.writes).toEqual([]);
	});

	test("a planted in-force entry is reported with its first key and the per-layer counts", async () => {
		const w = plantedDrift();
		w.index.rows.set("mem_a", MARKER);
		w.cache.mark = { state: "present", atMs: NOW - 5 * 60_000 };

		const report = reportOf(await runScheduledReconcile(w.deps, OPTIONS));

		expect(report.mismatches.count).toBe(2);
		expect(report.mismatches.first).toEqual({ layer: "index", key: "mem_b", reason: "in-force", forgetId: FORGET, noteId: "evt_forget_1" });
		expect(report.mismatches.items.map((item) => item.key)).toEqual(["mem_b", "mem_c"]);
		expect(report.layers.ledger).toEqual({ forgetNotes: 1, notesWithMarks: 1, namedEntries: 3 });
		expect(report.layers.index).toEqual({ forgotten: 1, superseded: 0, absent: 0, inForce: 2 });
		expect(report.repairable).toBe(2);
		expect(w.ledger.writes).toEqual([]);
		expect(w.index.marks).toEqual([]);
	});

	test("a missing cache mark is reported under the mark key when only the cache disagrees", async () => {
		const w = world();
		w.ledger.notes.push(forgetNote("evt_forget_1", 10, ["mem_a"]));
		w.index.rows.set("mem_a", MARKER);
		w.cache.mark = { state: "absent" };

		const report = reportOf(await runScheduledReconcile(w.deps, OPTIONS));

		expect(report.mismatches.first).toEqual({ layer: "cache", key: FORGET_MARK_KEY, reason: "stale-forget-mark" });
		expect(report.layers.cache).toEqual({ state: "absent", atMs: null, checked: true });
	});

	test("a cache mark older than the forget is stale", async () => {
		const w = world();
		w.ledger.notes.push(forgetNote("evt_forget_1", 10, ["mem_a"]));
		w.index.rows.set("mem_a", MARKER);
		w.cache.mark = { state: "present", atMs: NOW - 15 * 60_000 };

		const report = reportOf(await runScheduledReconcile(w.deps, OPTIONS));

		expect(report.mismatches.first?.layer).toBe("cache");
	});

	test("a forget older than the mark's lifetime is not checked against the cache", async () => {
		const w = world();
		w.ledger.notes.push(forgetNote("evt_forget_1", 10, ["mem_a"]));
		w.index.rows.set("mem_a", MARKER);
		w.cache.mark = { state: "absent" };

		const report = reportOf(await runScheduledReconcile(w.deps, { ...OPTIONS, markTtlS: 60 }));

		expect(report.mismatches.count).toBe(0);
		expect(report.layers.cache.checked).toBe(false);
	});

	test("a disabled cache is not checked", async () => {
		const w = world();
		w.ledger.notes.push(forgetNote("evt_forget_1", 10, ["mem_a"]));
		w.index.rows.set("mem_a", MARKER);
		w.cache.mark = { state: "disabled" };

		const report = reportOf(await runScheduledReconcile(w.deps, OPTIONS));

		expect(report.mismatches.count).toBe(0);
		expect(report.layers.cache).toEqual({ state: "disabled", atMs: null, checked: false });
	});

	test("a note newer than the settle margin is not judged yet", async () => {
		const w = world();
		w.ledger.notes.push(forgetNote("evt_forget_fresh", 1, ["mem_a"]));
		w.index.rows.set("mem_a", null);
		w.cache.mark = { state: "present", atMs: NOW };

		const report = reportOf(await runScheduledReconcile(w.deps, OPTIONS));

		expect(report.window.until).toBe(minutesAgo(5));
		expect(report.layers.ledger.namedEntries).toBe(0);
		expect(report.mismatches.count).toBe(0);
	});

	test("an entry a later superseder or another forget holds is consistent with the forget", async () => {
		const w = world();
		w.ledger.notes.push(forgetNote("evt_forget_1", 10, ["mem_a", "mem_b", "mem_c"], { marked: 0 }));
		w.index.rows.set("mem_a", OTHER_MARKER);
		w.index.rows.set("mem_b", "mem_newer");
		w.cache.mark = { state: "absent" };

		const report = reportOf(await runScheduledReconcile(w.deps, OPTIONS));

		expect(report.layers.index).toEqual({ forgotten: 1, superseded: 1, absent: 1, inForce: 0 });
		expect(report.layers.cache.checked).toBe(false);
		expect(report.mismatches.count).toBe(0);
	});

	test("an entry the index no longer has is absent, not a mismatch", async () => {
		const w = world();
		w.ledger.notes.push(forgetNote("evt_forget_1", 10, ["mem_gone"]));
		w.cache.mark = { state: "present", atMs: NOW - 5 * 60_000 };

		const report = reportOf(await runScheduledReconcile(w.deps, OPTIONS));

		expect(report.layers.index.absent).toBe(1);
		expect(report.mismatches.count).toBe(0);
	});
});

describe("the scheduled reconcile: a read that cannot be trusted", () => {
	test("a full window page is reported as truncated and plans nothing", async () => {
		const w = plantedDrift();
		w.ledger.truncated = true;

		const report = reportOf(await runScheduledReconcile(w.deps, OPTIONS));
		expect(report.coverage.ledgerTruncated).toBe(true);
		expect(report.coverage.complete).toBe(false);
		// Two in-force entries and a stale cache mark: plantedDrift leaves the mark absent.
		expect(report.mismatches.count).toBe(3);
		expect(report.repairable).toBe(0);

		const plan = planOf(await planRepair(w.deps, OPTIONS));
		expect(plan).toMatchObject({ planId: null, items: [], refused: "incomplete-coverage" });
		expect(w.ledger.writes).toEqual([]);
	});

	test("a forget note that names fewer entries than it touched is partial", async () => {
		const w = world();
		w.ledger.notes.push(forgetNote("evt_forget_1", 10, ["mem_a", "mem_b"], { entryCount: 3, marked: 3 }));
		w.index.rows.set("mem_a", null);
		w.index.rows.set("mem_b", MARKER);
		w.cache.mark = { state: "present", atMs: NOW - 5 * 60_000 };

		const report = reportOf(await runScheduledReconcile(w.deps, OPTIONS));

		expect(report.coverage).toMatchObject({ complete: false, partialNotes: 1, malformedNotes: 0 });
		expect(report.mismatches.first?.key).toBe("mem_a");
	});

	test("a forget note with a malformed payload or no decodable payload is malformed, not skipped", async () => {
		const w = world();
		const broken = forgetNote("evt_forget_bad", 10, ["mem_a"]);
		broken.payload = { ...broken.payload, counts: { already_forgotten: 0 } };
		w.ledger.notes.push(broken, { id: "evt_undecoded", ts: minutesAgo(9), kind: "note", payload: null });
		w.cache.mark = { state: "disabled" };

		const report = reportOf(await runScheduledReconcile(w.deps, OPTIONS));

		expect(report.coverage).toMatchObject({ complete: false, malformedNotes: 2 });
		expect(report.layers.ledger.forgetNotes).toBe(0);
	});

	test("more distinct entries than the key cap leaves the run incomplete", async () => {
		const w = world();
		const perNote = 50;
		const notes = Math.ceil((RECONCILE_MAX_KEYS + 1) / perNote);
		for (let note = 0; note < notes; note += 1) {
			const ids = Array.from({ length: perNote }, (_, i) => `mem_${note}_${i}`);
			w.ledger.notes.push(forgetNote(`evt_forget_${note}`, 10 - note * 0.01, ids));
			for (const id of ids) w.index.rows.set(id, MARKER);
		}
		w.cache.mark = { state: "present", atMs: NOW - 5 * 60_000 };

		const report = reportOf(await runScheduledReconcile(w.deps, OPTIONS));

		expect(report.coverage.keysTruncated).toBe(true);
		expect(report.coverage.complete).toBe(false);
		expect(report.layers.ledger.namedEntries).toBe(RECONCILE_MAX_KEYS);
	});

	test("a layer that cannot be read is a failure with its reason, not a thrown error", async () => {
		const ledgerDown = plantedDrift();
		ledgerDown.ledger.failWindow = "connection refused";
		const failedLedger = await runScheduledReconcile(ledgerDown.deps, OPTIONS);
		expect(failedLedger).toMatchObject({ ok: false, reason: "ledger-unavailable" });

		const cacheDown = plantedDrift();
		cacheDown.cache.failRead = true;
		const failedCache = await runScheduledReconcile(cacheDown.deps, OPTIONS);
		expect(failedCache).toMatchObject({ ok: false, reason: "cache-unavailable", detail: "cache read refused" });
		expect(cacheDown.ledger.writes).toEqual([]);
		expect(cacheDown.index.marks).toEqual([]);
	});

	test("a rejected option is a programmer error", async () => {
		const w = world();
		await expect(runScheduledReconcile(w.deps, { ...OPTIONS, markTtlS: 0 })).rejects.toThrow(RangeError);
	});
});

describe("repair: refused without a confirmed plan", () => {
	test("a planned repair records one plan and changes nothing", async () => {
		const w = plantedDrift();
		w.cache.mark = { state: "absent" };

		const plan = planOf(await planRepair(w.deps, OPTIONS));

		expect(plan.planId).toBe("evt_1");
		expect(plan.items).toEqual([
			{ action: "index-mark", entryId: "mem_b", forgetId: FORGET, marker: MARKER },
			{ action: "index-mark", entryId: "mem_c", forgetId: FORGET, marker: MARKER },
			{ action: "cache-mark", key: FORGET_MARK_KEY, ttlS: TTL_S },
		]);
		expect(w.ledger.writes).toHaveLength(1);
		expect(w.ledger.writes[0]?.payload.action).toBe(RECONCILE_PLAN_ACTION);
		expect(w.index.marks).toEqual([]);
		expect(w.cache.ttls).toEqual([]);
	});

	test("apply without a confirmed plan id is refused and writes nothing", async () => {
		const w = plantedDrift();
		const plan = planOf(await planRepair(w.deps, OPTIONS));
		const writesBefore = w.ledger.writes.length;

		for (const request of [{ planId: plan.planId }, { planId: plan.planId, confirm: "evt_9" }, { confirm: plan.planId }, {}]) {
			expect(await applyRepair(w.deps, request)).toMatchObject({ ok: false, reason: "not-confirmed" });
		}
		expect(w.index.marks).toEqual([]);
		expect(w.cache.ttls).toEqual([]);
		expect(w.ledger.writes).toHaveLength(writesBefore);
	});

	test("apply with a plan id that is not a stored plan is refused", async () => {
		const w = plantedDrift();
		expect(await applyRepair(w.deps, { planId: "evt_404", confirm: "evt_404" })).toMatchObject({ ok: false, reason: "plan-not-found" });
		expect(await applyRepair(w.deps, { planId: "not a plan!", confirm: "not a plan!" })).toMatchObject({ ok: false, reason: "plan-invalid" });
		expect(w.index.marks).toEqual([]);
	});

	test("apply refuses a note that is not a plan, and a plan whose items were altered after it was written", async () => {
		const w = plantedDrift();
		const plan = planOf(await planRepair(w.deps, OPTIONS));

		expect(await applyRepair(w.deps, { planId: "evt_forget_1", confirm: "evt_forget_1" })).toMatchObject({ ok: false, reason: "plan-invalid" });

		const stored = w.ledger.notes.find((note) => note.id === plan.planId);
		const planRecord = stored?.payload?.plan;
		if (!isRecord(planRecord) || !Array.isArray(planRecord.items)) throw new Error("the stored plan has no items");
		planRecord.items[0] = { ...planRecord.items[0], entryId: "mem_a" };
		expect(await applyRepair(w.deps, { planId: plan.planId, confirm: plan.planId })).toMatchObject({ ok: false, reason: "plan-invalid" });
		expect(w.index.marks).toEqual([]);
		expect(w.cache.ttls).toEqual([]);
	});

	test("a plan that is not stored is reported, and nothing is repaired", async () => {
		const w = plantedDrift();
		w.ledger.storeWrites = false;

		expect(await planRepair(w.deps, OPTIONS)).toMatchObject({ ok: false, reason: "plan-not-recorded" });
		expect(w.index.marks).toEqual([]);
		expect(w.cache.ttls).toEqual([]);
	});
});

describe("repair: a confirmed plan touches only the planned keys", () => {
	test("apply marks the planned entries, leaves unplanned and superseded rows alone, and records what it did", async () => {
		const w = plantedDrift();
		const plan = planOf(await planRepair(w.deps, OPTIONS));
		// Drift after the plan: mem_c is now held by another forget, and an unplanned row is in force.
		w.index.rows.set("mem_c", OTHER_MARKER);
		w.index.rows.set("mem_z", null);

		const applied = appliedOf(await applyRepair(w.deps, { planId: plan.planId, confirm: plan.planId }));

		expect(applied.marked).toEqual(["mem_b"]);
		expect(applied.skipped).toEqual([{ entryId: "mem_c", reason: "forgotten-by-other" }]);
		expect(applied.cache).toBe("marked");
		expect(applied.recorded).toBe(true);
		expect(w.index.marks).toEqual([{ ids: ["mem_b"], marker: MARKER }]);
		expect(w.index.rows.get("mem_b")).toBe(MARKER);
		expect(w.index.rows.get("mem_z")).toBeNull();
		expect(w.index.rows.get("mem_c")).toBe(OTHER_MARKER);
		expect(w.cache.ttls).toEqual([TTL_S]);
		const record = w.ledger.writes.at(-1);
		expect(record?.payload).toMatchObject({ action: RECONCILE_APPLIED_ACTION, planId: plan.planId, marked: ["mem_b"], cache: "marked" });
	});

	test("a planned entry another writer marks before the apply is skipped as raced", async () => {
		const w = plantedDrift();
		const plan = planOf(await planRepair(w.deps, OPTIONS));
		w.index.beforeMark = () => w.index.rows.set("mem_b", OTHER_MARKER);

		const applied = appliedOf(await applyRepair(w.deps, { planId: plan.planId, confirm: plan.planId }));

		// mem_c is planned too and still in force, so it is marked in the same call; only mem_b raced.
		expect(applied.marked).toEqual(["mem_c"]);
		expect(applied.skipped).toContainEqual({ entryId: "mem_b", reason: "raced" });
		expect(w.index.rows.get("mem_b")).toBe(OTHER_MARKER);
	});

	test("a repeat apply marks nothing new", async () => {
		const w = plantedDrift();
		const plan = planOf(await planRepair(w.deps, OPTIONS));
		appliedOf(await applyRepair(w.deps, { planId: plan.planId, confirm: plan.planId }));
		const marksAfterFirst = w.index.marks.length;

		const again = appliedOf(await applyRepair(w.deps, { planId: plan.planId, confirm: plan.planId }));

		expect(again.marked).toEqual([]);
		expect(again.skipped).toEqual([
			{ entryId: "mem_b", reason: "already-marked" },
			{ entryId: "mem_c", reason: "already-marked" },
		]);
		expect(w.index.marks).toHaveLength(marksAfterFirst);
	});

	test("an index write that fails stops the apply with its reason and no record", async () => {
		const w = plantedDrift();
		const plan = planOf(await planRepair(w.deps, OPTIONS));
		w.index.failMark = true;
		const writesBefore = w.ledger.writes.length;

		expect(await applyRepair(w.deps, { planId: plan.planId, confirm: plan.planId })).toMatchObject({
			ok: false,
			reason: "index-unavailable",
		});
		// The write may have committed before it failed, so the invalidation runs as it does after a successful mark (memoryForget counts a throw as touched).
		expect(w.cache.bumps).toEqual([MEMORY_GENERATION_KEY, RECALL_GENERATION_KEY]);
		expect(w.cache.ttls).toEqual([TTL_S]);
		expect(w.ledger.writes).toHaveLength(writesBefore);
	});

	test("an applied note the ledger refuses is reported, and the repairs stay made", async () => {
		const w = plantedDrift();
		const plan = planOf(await planRepair(w.deps, OPTIONS));
		w.ledger.storeWrites = false;

		const applied = appliedOf(await applyRepair(w.deps, { planId: plan.planId, confirm: plan.planId }));

		expect(applied.marked).toEqual(["mem_b", "mem_c"]);
		expect(applied.recorded).toBe(false);
		expect(w.index.rows.get("mem_c")).toBe(MARKER);
	});
});

describe("the ledger adapter", () => {
	function rowsOf(count: number): Array<Record<string, unknown>> {
		return Array.from({ length: count }, (_, i) => ({ id: `evt_${i}`, ts: NOW - i, kind: "note", payload: '{"action":"x"}' }));
	}

	test("reads the window with its payload, oldest first, and reports a full page as truncated", async () => {
		const queries: EventQuery[] = [];
		const reads: LedgerReads = {
			queryEvents: async (query) => {
				queries.push(query);
				return rowsOf(RECONCILE_LEDGER_LIMIT);
			},
			readEvent: async () => null,
		};
		const writer: NoteWriter = { emit: async () => ({ stored: true, event: { id: "evt_x" } }) };

		const window = await ledgerFromSubstrate("substrate", reads, writer).notesBetween("2026-11-11T10:55:00.000Z", "2026-11-11T11:55:00.000Z");

		expect(queries).toEqual([
			{
				match: { kind: "note" },
				since: "2026-11-11T10:55:00.000Z",
				until: "2026-11-11T11:55:00.000Z",
				includePayload: true,
				order: "asc",
				limit: RECONCILE_LEDGER_LIMIT,
			},
		]);
		expect(window.truncated).toBe(true);
		expect(window.notes[0]).toEqual({ id: "evt_0", ts: new Date(NOW).toISOString(), kind: "note", payload: { action: "x" } });
	});

	test("a payload that is not JSON decodes to null, and a ts that is not a time fails the read", async () => {
		const reads: LedgerReads = {
			queryEvents: async () => [{ id: "evt_bad", ts: NOW, kind: "note", payload: "{not json" }],
			readEvent: async () => ({ id: "evt_bad", ts: "not a time", kind: "note", payload: "{}" }),
		};
		const writer: NoteWriter = { emit: async () => ({ stored: true, event: { id: "evt_x" } }) };
		const ledger = ledgerFromSubstrate("substrate", reads, writer);

		expect((await ledger.notesBetween("a", "b")).notes[0]?.payload).toBeNull();
		await expect(ledger.readEvent("evt_bad")).rejects.toThrow("ts that is not a time");
	});

	test("a note is written through the substrate's write path on the reconcile's surface", async () => {
		const emitted: Array<Parameters<NoteWriter["emit"]>[0]> = [];
		const writer: NoteWriter = {
			emit: async (input) => {
				emitted.push(input);
				return { stored: true, event: { id: "evt_plan" } };
			},
		};
		const reads: LedgerReads = { queryEvents: async () => [], readEvent: async () => null };

		const written = await ledgerFromSubstrate("substrate", reads, writer).emitNote("reconcile plan", { action: RECONCILE_PLAN_ACTION });

		expect(written).toEqual({ id: "evt_plan", stored: true });
		expect(emitted).toEqual([{ surface: "substrate", kind: "note", summary: "reconcile plan", payload: { action: RECONCILE_PLAN_ACTION } }]);
	});
});

describe("repair: a mark invalidates what memoryForget invalidates", () => {
	test("an applied repair that marks rows moves both generations and sets the forget mark", async () => {
		const w = plantedDrift();
		const plan = planOf(await planRepair(w.deps, OPTIONS));

		const applied = appliedOf(await applyRepair(w.deps, { planId: plan.planId, confirm: plan.planId }));

		expect(applied.marked).toEqual(["mem_b", "mem_c"]);
		expect(applied.cache).toBe("marked");
		expect(w.cache.bumps).toEqual([MEMORY_GENERATION_KEY, RECALL_GENERATION_KEY]);
		expect(w.cache.ttls).toEqual([TTL_S]);
	});

	test("a cache that already agreed still takes the invalidation when the repair marks rows", async () => {
		const w = plantedDrift();
		w.cache.mark = { state: "present", atMs: NOW };
		const plan = planOf(await planRepair(w.deps, OPTIONS));
		expect(plan.items.at(-1)).toEqual({ action: "cache-mark", key: FORGET_MARK_KEY, ttlS: TTL_S });

		appliedOf(await applyRepair(w.deps, { planId: plan.planId, confirm: plan.planId }));

		expect(w.cache.bumps).toEqual([MEMORY_GENERATION_KEY, RECALL_GENERATION_KEY]);
		expect(w.cache.ttls).toEqual([TTL_S]);
	});

	test("a repair that marks no row sets only the forget mark, moving no generation", async () => {
		const w = world();
		w.ledger.notes.push(forgetNote("evt_forget_1", 10, ["mem_a"]));
		w.index.rows.set("mem_a", MARKER);
		const plan = planOf(await planRepair(w.deps, OPTIONS));
		expect(plan.items).toEqual([{ action: "cache-mark", key: FORGET_MARK_KEY, ttlS: TTL_S }]);

		const applied = appliedOf(await applyRepair(w.deps, { planId: plan.planId, confirm: plan.planId }));

		expect(applied.marked).toEqual([]);
		expect(w.cache.bumps).toEqual([]);
		expect(w.cache.ttls).toEqual([TTL_S]);
	});

	test("a plan stored before the cache mark was planned with its index marks is refused, and nothing is marked", async () => {
		const w = plantedDrift();
		const items = [{ action: "index-mark", entryId: "mem_b", forgetId: FORGET, marker: MARKER }];
		const itemsSha256 = createHash("sha256").update(JSON.stringify(items)).digest("hex");
		w.ledger.notes.push({ id: "evt_old_plan", ts: new Date(NOW).toISOString(), kind: "note", payload: { action: RECONCILE_PLAN_ACTION, plan: { items, itemsSha256 } } });

		expect(await applyRepair(w.deps, { planId: "evt_old_plan", confirm: "evt_old_plan" })).toMatchObject({ ok: false, reason: "plan-invalid" });
		expect(w.index.marks).toEqual([]);
		expect(w.cache.bumps).toEqual([]);
		expect(w.cache.ttls).toEqual([]);
	});
});
