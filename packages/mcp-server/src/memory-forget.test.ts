/**
 * The forget primitive (v1.6, phase 57, unit b): pure tests with fakes. No database, no plane, no network, no clock.
 *
 * `world()` is a small in-memory index plus a recording plane: it implements `markForgotten` with the same rule the
 * SQL has (set only where `superseded_by` is still null), so the tests prove the call's behaviour against that rule.
 * The statements themselves are proven in `index-store.memory-forget.test.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { EVENT_SOURCES } from "./event-sources.ts";
import { IDEMPOTENCY_KEY_PATTERN } from "./event.ts";
import { DEFAULT_SWEEP_POLICY, memoryLifecycleQuery, planSweep } from "./index-sweep.ts";
import {
	buildForgetEvent,
	DEFAULT_ROLLBACK_SELECT_LIMIT,
	FORGET_ACTION,
	FORGET_MARKER_PREFIX,
	FORGET_PAYLOAD_ENTRY_IDS,
	FORGET_PAYLOAD_MAX_BYTES,
	FORGET_PLANE_CONCURRENCY,
	FORGET_REASONS,
	ForgetError,
	assertForgetPayloadWithinCap,
	forgetEntries,
	forgetIdFor,
	forgetIdOfMarker,
	forgetIdempotencyKey,
	forgetMarker,
	isForgetId,
	isForgetMarker,
	MAX_FORGET_ENTRIES,
	MAX_ROLLBACK_SELECT_LIMIT,
	parseForgetPayload,
	parseForgetRequest,
	selectForRollback,
	type ForgetDeps,
	type ForgetPayload,
	type ForgetRequest,
	type ForgetRule,
	type PlaneDeleteResult,
} from "./memory-forget.ts";
import type { MemoryEntry } from "./types.ts";

const RB = "rb_0123456789abcdefghjkmnpqrs";
const CKPT = "ckpt_0123456789abcdefghjkmnpqrs";
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

function entry(id: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
	return {
		id,
		scope: "repo:acme/app",
		kind: "fact",
		text: `body of ${id}`,
		writer: "claude-code",
		actor: "agent",
		trust: "agent-claimed",
		ttl: "permanent",
		created: "2026-10-26T12:00:00.000Z",
		version: 1,
		entry_hash: `h-${id}`,
		needs_reverification: false,
		idempotency_key: `key-${id}`,
		session_id: "sess-1",
		...over,
	};
}

const request = (ids: string[], over: Record<string, unknown> = {}): ForgetRequest =>
	({ reason: "operator", entry_ids: ids, actor: "human", ...over }) as ForgetRequest;

interface WorldOptions {
	/** Runs after the reads and before the mark statement: a concurrent writer. */
	beforeMark?: (rows: Map<string, MemoryEntry>) => void;
	emitFails?: boolean;
	shared?: (entry: MemoryEntry) => boolean | "throw";
}

function world(entries: MemoryEntry[], options: WorldOptions = {}) {
	const rows = new Map(entries.map((e) => [e.id, { ...e }]));
	const log: string[] = [];
	const plane = new Map<string, PlaneDeleteResult | "throw">();
	const emitted: Array<{ payload: ForgetPayload; summary: string; key: string }> = [];
	let inflight = 0;
	let maxInflight = 0;
	let markCalls = 0;
	const deps: ForgetDeps = {
		async readEntry(id) {
			log.push(`read ${id}`);
			const row = rows.get(id);
			return row ? { ...row } : null;
		},
		async markForgotten(ids, marker) {
			markCalls += 1;
			log.push(`mark ${ids.join(",")}`);
			options.beforeMark?.(rows);
			const changed: string[] = [];
			for (const id of ids) {
				const row = rows.get(id);
				if (row && row.superseded_by === undefined) {
					row.superseded_by = marker;
					changed.push(id);
				}
			}
			return changed;
		},
		async deletePlaneDocument(e) {
			log.push(`delete ${e.id}`);
			inflight += 1;
			maxInflight = Math.max(maxInflight, inflight);
			try {
				// Two microtask turns: enough for every started delete to be in flight before the first one settles.
				await Promise.resolve();
				await Promise.resolve();
				const outcome = plane.get(e.id) ?? { ok: true as const };
				if (outcome === "throw") throw new Error("socket hang up");
				return outcome;
			} finally {
				inflight -= 1;
			}
		},
		...(options.shared
			? {
					async documentShared(e: MemoryEntry) {
						const verdict = options.shared?.(e);
						if (verdict === "throw") throw new Error("index down");
						return verdict === true;
					},
				}
			: {}),
		async emit(payload, summary, meta) {
			log.push("emit");
			if (options.emitFails) throw new Error("ledger down");
			emitted.push({ payload, summary, key: meta.idempotency_key });
		},
		now: () => NOW,
	};
	return { deps, rows, log, plane, emitted, stats: () => ({ maxInflight, markCalls }) };
}

describe("marker, forget id", () => {
	test("the marker is the prefix plus the id, and only a well-formed one is a marker", () => {
		const id = forgetIdFor({ reason: "operator", entry_ids: ["mem_a"] });
		expect(id).toMatch(/^fg_[0-9a-f]{26}$/);
		expect(isForgetId(id)).toBe(true);
		const marker = forgetMarker(id);
		expect(marker).toBe(`${FORGET_MARKER_PREFIX}${id}`);
		expect(isForgetMarker(marker)).toBe(true);
		expect(forgetIdOfMarker(marker)).toBe(id);
		for (const bad of [undefined, null, 7, "", "forgotten:", "forgotten:fg_", "forgotten:fg_ABCDEF0123456789ABCDEF0123", `x${marker}`, "mem_0123456789abcdef0123456789abcdef", id, `${marker}0`]) {
			expect({ bad, marker: isForgetMarker(bad) }).toEqual({ bad, marker: false });
		}
		expect(forgetIdOfMarker("mem_1")).toBeNull();
		expect(() => forgetMarker("fg_short")).toThrow(ForgetError);
	});

	test("the forget id is deterministic, order and duplicate insensitive, and sensitive to everything it is about", () => {
		const base = { reason: "rollback" as const, entry_ids: ["b", "a", "c"], rollback_id: RB };
		const id = forgetIdFor(base);
		expect(forgetIdFor({ ...base, entry_ids: ["c", "a", "b", "a"] })).toBe(id);
		expect(forgetIdFor({ ...base })).toBe(id);
		const others = [
			forgetIdFor({ ...base, reason: "operator" }),
			forgetIdFor({ ...base, entry_ids: ["a", "b"] }),
			forgetIdFor({ ...base, entry_ids: ["a", "b", "c", "d"] }),
			forgetIdFor({ ...base, rollback_id: "rb_0123456789abcdefghjkmnpqrt" }),
			forgetIdFor({ reason: "rollback", entry_ids: base.entry_ids.slice(), checkpoint_id: CKPT }),
		];
		expect(new Set([id, ...others]).size).toBe(others.length + 1);
	});
});

describe("parseForgetRequest", () => {
	test("a valid request is normalised: duplicates collapse and ids are sorted", () => {
		const parsed = parseForgetRequest({ reason: "rollback", entry_ids: ["mem_b", "mem_a", "mem_b"], actor: "agent", session_id: "sess-1", rollback_id: RB });
		expect(parsed).toEqual({
			ok: true,
			request: { reason: "rollback", entry_ids: ["mem_a", "mem_b"], actor: "agent", session_id: "sess-1", rollback_id: RB },
		});
	});

	const bad: Array<[string, unknown, string, ForgetRule]> = [
		["not an object", "nope", "request", "not_object"],
		["an array", [], "request", "not_object"],
		["an unknown key", { ...request(["a"]), body: "x" }, "body", "unknown_key"],
		["a missing actor", { reason: "operator", entry_ids: ["a"] }, "actor", "missing"],
		["a missing reason", { entry_ids: ["a"], actor: "human" }, "reason", "missing"],
		["a missing entry_ids", { reason: "operator", actor: "human" }, "entry_ids", "missing"],
		["an unknown reason", request(["a"], { reason: "whim" }), "reason", "enum"],
		["a non-string reason", request(["a"], { reason: 3 }), "reason", "type"],
		["an unknown actor", request(["a"], { actor: "bot" }), "actor", "enum"],
		["entry_ids not an array", request(["a"], { entry_ids: "a" }), "entry_ids", "type"],
		["an empty entry_ids", request([]), "entry_ids", "range"],
		["a non-string id", request(["a", 5 as unknown as string]), "entry_ids[1]", "type"],
		["an empty id", request(["a", ""]), "entry_ids[1]", "range"],
		["a path-like id", request(["a", "../etc/passwd"]), "entry_ids[1]", "format"],
		["an id with a space", request(["a b"]), "entry_ids[0]", "format"],
		["an id with a control character", request(["a\u0000b"]), "entry_ids[0]", "format"],
		["an over-long id", request(["x".repeat(129)]), "entry_ids[0]", "too_long"],
		["an id that is a forget marker", request(["forgotten:fg_0123456789abcdef0123456789"]), "entry_ids[0]", "format"],
		["more than 200 distinct ids", request(Array.from({ length: 201 }, (_, i) => `mem_${i}`)), "entry_ids", "too_long"],
		["more than 1000 raw ids", request(Array.from({ length: 1001 }, () => "mem_a")), "entry_ids", "too_long"],
		["a bad checkpoint id", request(["a"], { checkpoint_id: "ckpt_short" }), "checkpoint_id", "format"],
		["a bad rollback id", request(["a"], { rollback_id: "rb_UPPERCASE0123456789abcdef" }), "rollback_id", "format"],
		["an empty session id", request(["a"], { session_id: "" }), "session_id", "range"],
		["a session id with a control character", request(["a"], { session_id: "s\n1" }), "session_id", "format"],
		["an over-long session id", request(["a"], { session_id: "s".repeat(513) }), "session_id", "too_long"],
		["a rollback with no rollback_id or checkpoint_id", request(["a"], { reason: "rollback" }), "rollback_id", "at_least_one_of"],
	];
	for (const [name, input, path, rule] of bad) {
		test(`rejects ${name}, naming the field`, () => {
			const parsed = parseForgetRequest(input);
			expect(parsed.ok).toBe(false);
			if (parsed.ok) return;
			expect({ path: parsed.error.path, rule: parsed.error.rule }).toEqual({ path, rule });
			expect(parsed.error).toBeInstanceOf(ForgetError);
			expect(parsed.error.message.startsWith(`${path}:`)).toBe(true);
		});
	}

	test("exactly 200 distinct ids, and 1000 raw ids that collapse to few, are accepted; a rollback with a checkpoint id alone is", () => {
		expect(parseForgetRequest(request(Array.from({ length: 200 }, (_, i) => `mem_${i}`))).ok).toBe(true);
		expect(parseForgetRequest(request(Array.from({ length: 1000 }, (_, i) => `mem_${i % 3}`))).ok).toBe(true);
		expect(parseForgetRequest(request(["a"], { reason: "rollback", checkpoint_id: CKPT })).ok).toBe(true);
		expect(FORGET_REASONS).toEqual(["rollback", "expiry", "operator"]);
	});
});

describe("forgetEntries: one outcome per entry", () => {
	function seeded() {
		const own = forgetMarker(forgetIdFor({ reason: "operator", entry_ids: ["mem_a", "mem_b", "mem_c", "mem_d", "mem_e", "mem_f"] }));
		const other = forgetMarker(`fg_${"1".repeat(26)}`);
		return world(
			[
				entry("mem_a"),
				entry("mem_b"),
				entry("mem_c", { superseded_by: "mem_newer" }),
				// mem_d does not exist
				entry("mem_e", { superseded_by: other }),
				entry("mem_f", { superseded_by: own }),
			],
		);
	}
	const ids = ["mem_a", "mem_b", "mem_c", "mem_d", "mem_e", "mem_f"];

	test("marked, already superseded (left alone), missing, forgotten by another call, forgotten by this call", async () => {
		const w = seeded();
		w.plane.set("mem_b", { ok: true, absent: true });
		const report = await forgetEntries(w.deps, request(ids));
		const byId = Object.fromEntries(report.entries.map((e) => [e.id, e]));
		const forgetId = forgetIdFor({ reason: "operator", entry_ids: ids });
		expect(report.forget_id).toBe(forgetId);
		expect(report.marker).toBe(forgetMarker(forgetId));
		expect(report.at).toBe("2026-10-26T12:00:00.000Z");
		expect(byId["mem_a"]).toEqual({ id: "mem_a", outcome: "marked", plane: { status: "deleted" } });
		expect(byId["mem_b"]).toEqual({ id: "mem_b", outcome: "marked", plane: { status: "absent" } });
		expect(byId["mem_c"]).toEqual({ id: "mem_c", outcome: "already_superseded", superseded_by: "mem_newer", plane: { status: "skipped", reason: "superseded" } });
		expect(byId["mem_d"]).toEqual({ id: "mem_d", outcome: "missing", plane: { status: "skipped", reason: "missing" } });
		expect(byId["mem_e"]).toEqual({ id: "mem_e", outcome: "already_forgotten", forgotten_by: `fg_${"1".repeat(26)}`, plane: { status: "skipped", reason: "forgotten-by-another-call" } });
		expect(byId["mem_f"]).toEqual({ id: "mem_f", outcome: "already_forgotten", forgotten_by: forgetId, plane: { status: "deleted" } });
		expect(report.counts).toEqual({ marked: 2, already_forgotten: 2, already_superseded: 1, missing: 1 });
		expect(report.plane).toEqual({ deleted: 2, absent: 1, pending: 0, skipped: 3 });
		expect(report.plane_pending).toBe(0);
		expect(report.entry_count).toBe(6);
		// Left alone: a real superseder and another call's marker are untouched; the missing entry was not invented.
		expect(w.rows.get("mem_c")?.superseded_by).toBe("mem_newer");
		expect(w.rows.get("mem_e")?.superseded_by).toBe(`${FORGET_MARKER_PREFIX}fg_${"1".repeat(26)}`);
		expect(w.rows.has("mem_d")).toBe(false);
		// The marked rows are KEPT, carrying the marker.
		expect(w.rows.get("mem_a")?.superseded_by).toBe(report.marker);
		expect(w.rows.get("mem_b")?.superseded_by).toBe(report.marker);
	});

	test("only the open entries reach the mark statement, and only entries this call forgot reach the plane", async () => {
		const w = seeded();
		await forgetEntries(w.deps, request(ids));
		expect(w.log.filter((line) => line.startsWith("mark "))).toEqual(["mark mem_a,mem_b"]);
		expect(w.log.filter((line) => line.startsWith("delete ")).sort()).toEqual(["delete mem_a", "delete mem_b", "delete mem_f"]);
	});

	test("order: every read, then the mark, then the plane deletes, then exactly one ledger note", async () => {
		const w = seeded();
		await forgetEntries(w.deps, request(ids));
		const lastRead = w.log.map((l) => l.startsWith("read ")).lastIndexOf(true);
		const mark = w.log.findIndex((l) => l.startsWith("mark "));
		const firstDelete = w.log.findIndex((l) => l.startsWith("delete "));
		const lastDelete = w.log.map((l) => l.startsWith("delete ")).lastIndexOf(true);
		expect(lastRead).toBeLessThan(mark);
		expect(mark).toBeLessThan(firstDelete);
		expect(w.log.filter((l) => l === "emit")).toHaveLength(1);
		expect(w.log.indexOf("emit")).toBeGreaterThan(lastDelete);
		expect(w.log.at(-1)).toBe("emit");
	});

	test("the one note carries the validated payload, a fixed-shape summary and a key", async () => {
		const w = seeded();
		const report = await forgetEntries(w.deps, request(ids, { session_id: "sess-1", checkpoint_id: CKPT }));
		expect(w.emitted).toHaveLength(1);
		const note = w.emitted[0]!;
		expect(parseForgetPayload(note.payload)).toEqual(note.payload);
		expect(note.payload).toEqual({
			action: FORGET_ACTION,
			forget_id: report.forget_id,
			reason: "operator",
			actor: "human",
			entry_count: 6,
			entry_ids: [...ids].sort(),
			counts: report.counts,
			plane: report.plane,
			session_id: "sess-1",
			checkpoint_id: CKPT,
		});
		// Two deletes, not three: the checkpoint id is part of the forget id, so mem_f (seeded as forgotten by the request WITHOUT one)
		// is another call's entry here and its plane document is left to that call.
		expect(note.summary).toBe(
			`memory forget ${report.forget_id} (operator): 2 marked, 2 already forgotten, 1 superseded, 1 missing; plane 2 deleted, 0 absent, 0 pending`,
		);
		expect(note.key).toBe(forgetIdempotencyKey(note.payload));
		expect(note.key).toMatch(IDEMPOTENCY_KEY_PATTERN);
		expect(report.ledger).toEqual({ emitted: true, idempotency_key: note.key });
		// No entry content leaves in the note.
		expect(JSON.stringify(note)).not.toContain("body of");
	});

	test("an invalid request is refused before anything is read, naming the field", async () => {
		const w = seeded();
		await expect(forgetEntries(w.deps, request([], {}))).rejects.toMatchObject({ name: "ForgetError", path: "entry_ids" });
		expect(w.log).toEqual([]);
	});
});

describe("forgetEntries: idempotency", () => {
	test("forgetting twice changes nothing in the index; the second call only retries the plane", async () => {
		const w = world([entry("mem_a"), entry("mem_b")]);
		const first = await forgetEntries(w.deps, request(["mem_a", "mem_b"]));
		const afterFirst = JSON.stringify([...w.rows.values()]);
		expect(first.counts).toEqual({ marked: 2, already_forgotten: 0, already_superseded: 0, missing: 0 });
		w.plane.set("mem_a", { ok: true, absent: true });
		w.plane.set("mem_b", { ok: true, absent: true });
		const second = await forgetEntries(w.deps, request(["mem_b", "mem_a", "mem_a"]));
		expect(JSON.stringify([...w.rows.values()])).toBe(afterFirst);
		expect(second.forget_id).toBe(first.forget_id);
		expect(second.counts).toEqual({ marked: 0, already_forgotten: 2, already_superseded: 0, missing: 0 });
		expect(second.plane).toEqual({ deleted: 0, absent: 2, pending: 0, skipped: 0 });
		// The mark statement ran once: the second call found nothing open.
		expect(w.stats().markCalls).toBe(1);
		// Two calls, two notes; the second one differs, so a ledger honouring the key keeps both.
		expect(w.emitted).toHaveLength(2);
		expect(w.emitted[1]?.key).not.toBe(w.emitted[0]?.key);
	});

	test("a repeat that changes nothing builds the very same ledger key", async () => {
		const w = world([entry("mem_a")]);
		await forgetEntries(w.deps, request(["mem_a"]));
		await forgetEntries(w.deps, request(["mem_a"]));
		await forgetEntries(w.deps, request(["mem_a"]));
		expect(w.emitted[1]?.key).toBe(w.emitted[2]?.key);
	});

	test("a different reason is a different forget: entries already forgotten stay with their first marker", async () => {
		const w = world([entry("mem_a")]);
		const first = await forgetEntries(w.deps, request(["mem_a"], { reason: "expiry" }));
		const second = await forgetEntries(w.deps, request(["mem_a"], { reason: "operator" }));
		expect(second.forget_id).not.toBe(first.forget_id);
		expect(second.entries[0]).toMatchObject({ outcome: "already_forgotten", forgotten_by: first.forget_id, plane: { status: "skipped" } });
		expect(w.rows.get("mem_a")?.superseded_by).toBe(first.marker);
		expect(w.log.filter((l) => l === "delete mem_a")).toHaveLength(1);
	});
});

describe("forgetEntries: plane failures", () => {
	test("a failed or thrown delete is pending, never undoes the mark, and a re-run retries it", async () => {
		const w = world([entry("mem_a"), entry("mem_b"), entry("mem_c"), entry("mem_d")]);
		w.plane.set("mem_b", { ok: false, reason: "hindsight DELETE: http 503", retryable: true });
		w.plane.set("mem_c", "throw");
		w.plane.set("mem_d", { ok: false, reason: "hindsight DELETE: http 403", retryable: false });
		const ids = ["mem_a", "mem_b", "mem_c", "mem_d"];
		const first = await forgetEntries(w.deps, request(ids));
		const byId = Object.fromEntries(first.entries.map((e) => [e.id, e.plane]));
		expect(byId["mem_a"]).toEqual({ status: "deleted" });
		expect(byId["mem_b"]).toEqual({ status: "pending", reason: "hindsight DELETE: http 503", retryable: true });
		expect(byId["mem_c"]).toEqual({ status: "pending", reason: "plane delete threw: socket hang up", retryable: true });
		expect(byId["mem_d"]).toEqual({ status: "pending", reason: "hindsight DELETE: http 403", retryable: false });
		expect(first.plane_pending).toBe(3);
		expect(first.counts.marked).toBe(4);
		for (const id of ids) expect(w.rows.get(id)?.superseded_by).toBe(first.marker);
		expect(w.emitted).toHaveLength(1);
		expect(w.emitted[0]?.payload.plane).toEqual({ deleted: 1, absent: 0, pending: 3, skipped: 0 });

		// The plane recovers; the same request retries the deletion of the entries this id marked.
		w.plane.clear();
		const second = await forgetEntries(w.deps, request(ids));
		expect(second.forget_id).toBe(first.forget_id);
		expect(second.counts).toEqual({ marked: 0, already_forgotten: 4, already_superseded: 0, missing: 0 });
		expect(second.plane_pending).toBe(0);
		expect(second.plane.deleted).toBe(4);
		expect(w.stats().markCalls).toBe(1);
	});

	test("a failure reason is redacted and capped in the report", async () => {
		const w = world([entry("mem_a")]);
		w.plane.set("mem_a", { ok: false, reason: `bearer sk-ant-api03-${"A".repeat(60)} ${"x".repeat(500)}`, retryable: false });
		const report = await forgetEntries(w.deps, request(["mem_a"]));
		const plane = report.entries[0]!.plane;
		expect(plane.status).toBe("pending");
		if (plane.status !== "pending") return;
		expect(plane.reason.length).toBeLessThanOrEqual(200);
		expect(plane.reason).not.toContain("sk-ant-api03-AAAA");
	});

	test("the plane reporting nothing to delete against (not configured) is skipped, not pending", async () => {
		const w = world([entry("mem_a")]);
		w.plane.set("mem_a", { ok: true, skipped: "hindsight-not-configured" });
		const report = await forgetEntries(w.deps, request(["mem_a"]));
		expect(report.entries[0]?.plane).toEqual({ status: "skipped", reason: "hindsight-not-configured" });
		expect(report.plane).toEqual({ deleted: 0, absent: 0, pending: 0, skipped: 1 });
	});

	test("a document another live entry still uses is skipped, and a failing check is a retryable pending", async () => {
		const w = world([entry("mem_a"), entry("mem_b"), entry("mem_c")], {
			shared: (e) => (e.id === "mem_a" ? true : e.id === "mem_b" ? "throw" : false),
		});
		const report = await forgetEntries(w.deps, request(["mem_a", "mem_b", "mem_c"]));
		const byId = Object.fromEntries(report.entries.map((e) => [e.id, e.plane]));
		expect(byId["mem_a"]).toEqual({ status: "skipped", reason: "document-shared" });
		expect(byId["mem_b"]).toEqual({ status: "pending", reason: "plane delete threw: index down", retryable: true });
		expect(byId["mem_c"]).toEqual({ status: "deleted" });
		expect(w.log).not.toContain("delete mem_a");
		expect(w.log).not.toContain("delete mem_b");
	});

	test("a ledger that refuses the note is reported, not thrown, and the marks stand", async () => {
		const w = world([entry("mem_a")], { emitFails: true });
		const report = await forgetEntries(w.deps, request(["mem_a"]));
		expect(report.ledger).toEqual({ emitted: false, reason: "emit failed: ledger down" });
		expect(report.counts.marked).toBe(1);
		expect(w.rows.get("mem_a")?.superseded_by).toBe(report.marker);
	});

	test("a throwing read propagates before anything is marked; a throwing mark propagates and no plane call is made", async () => {
		const w = world([entry("mem_a")]);
		const failingRead: ForgetDeps = { ...w.deps, readEntry: async () => Promise.reject(new Error("index down")) };
		await expect(forgetEntries(failingRead, request(["mem_a"]))).rejects.toThrow("index down");
		expect(w.stats().markCalls).toBe(0);
		const failingMark: ForgetDeps = { ...w.deps, markForgotten: async () => Promise.reject(new Error("deadlock")) };
		await expect(forgetEntries(failingMark, request(["mem_a"]))).rejects.toThrow("deadlock");
		expect(w.log.some((l) => l.startsWith("delete "))).toBe(false);
		expect(w.emitted).toHaveLength(0);
		expect(w.rows.get("mem_a")?.superseded_by).toBeUndefined();
	});
});

describe("forgetEntries: races at the mark", () => {
	test("an entry superseded between the read and the mark keeps its real superseder and is not touched on the plane", async () => {
		const w = world([entry("mem_a"), entry("mem_b")], {
			beforeMark: (rows) => {
				rows.get("mem_b")!.superseded_by = "mem_newer";
			},
		});
		const report = await forgetEntries(w.deps, request(["mem_a", "mem_b"]));
		expect(report.counts).toEqual({ marked: 1, already_forgotten: 0, already_superseded: 1, missing: 0 });
		expect(report.entries[1]).toMatchObject({ id: "mem_b", outcome: "already_superseded", superseded_by: "mem_newer" });
		expect(w.rows.get("mem_b")?.superseded_by).toBe("mem_newer");
		expect(w.log).not.toContain("delete mem_b");
	});

	test("an entry a duplicate call marked first reads back as already forgotten and gets its plane retry", async () => {
		let marker = "";
		const w = world([entry("mem_a")], {
			beforeMark: (rows) => {
				rows.get("mem_a")!.superseded_by = marker;
			},
		});
		marker = forgetMarker(forgetIdFor({ reason: "operator", entry_ids: ["mem_a"] }));
		const report = await forgetEntries(w.deps, request(["mem_a"]));
		expect(report.counts).toEqual({ marked: 0, already_forgotten: 1, already_superseded: 0, missing: 0 });
		expect(w.log).toContain("delete mem_a");
	});

	test("a mark that changed nothing on an entry that is still open is a typed store error, not a lie in the report", async () => {
		const w = world([entry("mem_a")]);
		const deps: ForgetDeps = { ...w.deps, markForgotten: async () => [] };
		await expect(forgetEntries(deps, request(["mem_a"]))).rejects.toMatchObject({ name: "ForgetError", rule: "store_inconsistent" });
	});
});

describe("forgetEntries: bounds", () => {
	test("plane deletes run at most four at a time, and four do overlap", async () => {
		const ids = Array.from({ length: 12 }, (_, i) => `mem_${String(i).padStart(2, "0")}`);
		const w = world(ids.map((id) => entry(id)));
		const report = await forgetEntries(w.deps, request(ids));
		expect(FORGET_PLANE_CONCURRENCY).toBe(4);
		expect(w.stats().maxInflight).toBe(4);
		expect(report.plane.deleted).toBe(12);
		expect(report.entries.map((e) => e.id)).toEqual([...ids]);
	});

	test("the payload of the largest call stays far below the 16000-byte ledger cap", async () => {
		const ids = Array.from({ length: MAX_FORGET_ENTRIES }, (_, i) => `${"a".repeat(120)}${String(i).padStart(8, "0")}`);
		expect(ids[0]).toHaveLength(128);
		const w = world([]);
		const report = await forgetEntries(w.deps, request(ids, { session_id: "s".repeat(512), reason: "rollback", rollback_id: RB, checkpoint_id: CKPT }));
		const payload = w.emitted[0]!.payload;
		expect(report.entry_count).toBe(200);
		expect(payload.entry_count).toBe(200);
		expect(payload.entry_ids).toHaveLength(FORGET_PAYLOAD_ENTRY_IDS);
		expect(payload.entry_ids).toEqual([...ids].sort().slice(0, FORGET_PAYLOAD_ENTRY_IDS));
		const bytes = Buffer.byteLength(JSON.stringify(payload));
		expect(bytes).toBeLessThan(FORGET_PAYLOAD_MAX_BYTES / 2);
		expect(report.counts.missing).toBe(200);
	});
});

describe("memory.forget payload validator and builder", () => {
	const good = (over: Record<string, unknown> = {}) =>
		({
			action: FORGET_ACTION,
			forget_id: "fg_0123456789abcdef0123456789",
			reason: "rollback",
			actor: "agent",
			entry_count: 2,
			entry_ids: ["mem_a", "mem_b"],
			counts: { marked: 1, already_forgotten: 0, already_superseded: 1, missing: 0 },
			plane: { deleted: 1, absent: 0, pending: 0, skipped: 1 },
			rollback_id: RB,
			...over,
		}) as Record<string, unknown>;

	test("a good payload round-trips", () => {
		expect(parseForgetPayload(good())).toEqual(good() as unknown as ForgetPayload);
	});

	test("the event_sources sample is a valid payload", () => {
		const row = EVENT_SOURCES.find((source) => source.id === "memory.forget");
		expect(row).toMatchObject({ phase: 57, kind: "note", surface: "caller", actions: ["memory.forget"], carriesRepo: false, periodic: false });
		const sample = row!.sample();
		expect(sample.kind).toBe("note");
		expect(sample.repo).toBeUndefined();
		const payload = parseForgetPayload(sample.payload);
		expect(buildForgetEvent({ ...payload }).summary).toBe(sample.summary);
	});

	const bad: Array<[string, Record<string, unknown>, string, ForgetRule]> = [
		["a wrong action", good({ action: "memory.retain" }), "action", "enum"],
		["an unknown key", good({ text: "secret" }), "text", "unknown_key"],
		["a missing counts", (({ counts: _counts, ...rest }) => rest)(good()), "counts", "missing"],
		["a bad forget id", good({ forget_id: "fg_NOPE" }), "forget_id", "format"],
		["a forget id without the prefix", good({ forget_id: "0123456789abcdef0123456789" }), "forget_id", "format"],
		["an unknown reason", good({ reason: "whim" }), "reason", "enum"],
		["an unknown actor", good({ actor: "robot" }), "actor", "enum"],
		["a zero entry_count", good({ entry_count: 0, entry_ids: [], counts: { marked: 0, already_forgotten: 0, already_superseded: 0, missing: 0 }, plane: { deleted: 0, absent: 0, pending: 0, skipped: 0 } }), "entry_count", "range"],
		["an entry_count past 200", good({ entry_count: 201 }), "entry_count", "range"],
		["a fractional count", good({ counts: { marked: 1.5, already_forgotten: 0, already_superseded: 1, missing: 0 } }), "counts.marked", "type"],
		["a negative count", good({ counts: { marked: 3, already_forgotten: 0, already_superseded: -1, missing: 0 } }), "counts.already_superseded", "range"],
		["counts that do not sum", good({ counts: { marked: 1, already_forgotten: 0, already_superseded: 0, missing: 0 } }), "counts", "inconsistent"],
		["plane that does not sum", good({ plane: { deleted: 5, absent: 0, pending: 0, skipped: 0 } }), "plane", "inconsistent"],
		["an unknown plane key", good({ plane: { deleted: 1, absent: 0, pending: 0, skipped: 1, other: 0 } }), "plane.other", "unknown_key"],
		["entry_ids that do not match the count", good({ entry_ids: ["mem_a"] }), "entry_ids", "inconsistent"],
		["a repeated id", good({ entry_ids: ["mem_a", "mem_a"] }), "entry_ids", "inconsistent"],
		["a path as an id", good({ entry_ids: ["mem_a", "a/b"] }), "entry_ids[1]", "format"],
		["more than 50 ids", good({ entry_count: 60, entry_ids: Array.from({ length: 51 }, (_, i) => `mem_${i}`), counts: { marked: 60, already_forgotten: 0, already_superseded: 0, missing: 0 }, plane: { deleted: 60, absent: 0, pending: 0, skipped: 0 } }), "entry_ids", "too_long"],
		["a bad rollback id", good({ rollback_id: "rb_x" }), "rollback_id", "format"],
		["a bad checkpoint id", good({ checkpoint_id: "ckpt_x" }), "checkpoint_id", "format"],
	];
	for (const [name, payload, path, rule] of bad) {
		test(`rejects ${name}`, () => {
			expect(() => parseForgetPayload(payload)).toThrow(ForgetError);
			try {
				parseForgetPayload(payload);
			} catch (cause) {
				expect({ path: (cause as ForgetError).path, rule: (cause as ForgetError).rule }).toEqual({ path, rule });
			}
		});
	}

	test("a non-object and a payload over the ledger cap are rejected", () => {
		for (const value of [null, "x", 3, []]) expect(() => parseForgetPayload(value)).toThrow(/must be a JSON object/);
		expect(() => assertForgetPayloadWithinCap({ pad: "x".repeat(FORGET_PAYLOAD_MAX_BYTES + 1) })).toThrow(/exceeds the 16000-byte ledger cap/);
		expect(() => assertForgetPayloadWithinCap({ pad: "x".repeat(100) })).not.toThrow();
		const circular: Record<string, unknown> = {};
		circular["self"] = circular;
		expect(() => assertForgetPayloadWithinCap(circular)).toThrow(/JSON-serialisable/);
		expect(() => parseForgetPayload(good({ session_id: "x".repeat(20_000) }))).toThrow(/ledger cap/);
	});

	test("the builder fixes kind and summary, and the key separates a plane change from a repeat", () => {
		const draft = buildForgetEvent({ ...(good() as unknown as ForgetPayload) });
		expect(draft.kind).toBe("note");
		expect(draft.summary).toBe(
			"memory forget fg_0123456789abcdef0123456789 (rollback): 1 marked, 0 already forgotten, 1 superseded, 0 missing; plane 1 deleted, 0 absent, 0 pending",
		);
		expect(draft.idempotency_key).toMatch(IDEMPOTENCY_KEY_PATTERN);
		expect(buildForgetEvent({ ...(good() as unknown as ForgetPayload) }).idempotency_key).toBe(draft.idempotency_key);
		const pending = buildForgetEvent({ ...(good({ plane: { deleted: 0, absent: 0, pending: 1, skipped: 1 } }) as unknown as ForgetPayload) });
		expect(pending.idempotency_key).not.toBe(draft.idempotency_key);
		expect(() => buildForgetEvent({ ...(good({ reason: "whim" }) as unknown as ForgetPayload) })).toThrow(ForgetError);
	});
});

describe("selectForRollback", () => {
	function store(entries: string[], truncated = false) {
		const calls: Array<[string, string, string | null, number]> = [];
		const untils: Array<string | null> = [];
		return {
			calls,
			untils,
			deps: {
				async entriesCreatedAfter(session: string, after: string, graph: string | null, limit: number, until: string | null) {
					calls.push([session, after, graph, limit]);
					untils.push(until);
					return { entries: entries.map((id) => ({ id })), truncated };
				},
			},
		};
	}

	test("no until means no upper bound is sent", async () => {
		const s = store(["mem_a"]);
		await selectForRollback(s.deps, { session_id: "sess-1", after: "2026-10-26T12:00:00Z" });
		expect(s.untils).toEqual([null]);
	});

	test("an until instant is normalised to whole milliseconds UTC and sent to the store; equal to after is allowed", async () => {
		const s = store(["mem_a"]);
		await selectForRollback(s.deps, { session_id: "sess-1", after: "2026-10-26T12:00:00Z", until: "2026-10-26T16:00:00.456789+02:00" });
		await selectForRollback(s.deps, { session_id: "sess-1", after: "2026-10-26T12:00:00Z", until: "2026-10-26T12:00:00.000Z" });
		expect(s.untils).toEqual(["2026-10-26T14:00:00.456Z", "2026-10-26T12:00:00.000Z"]);
	});

	test("a writer is sent to the store, which applies it before its limit; none means every writer's; a bad one is refused", async () => {
		const writers: Array<string | null | undefined> = [];
		const deps = {
			async entriesCreatedAfter(_session: string, _after: string, _graph: string | null, _limit: number, _until: string | null, writer?: string | null) {
				writers.push(writer);
				return { entries: [{ id: "mem_a" }], truncated: false };
			},
		};
		await selectForRollback(deps, { session_id: "sess-1", after: "2026-10-26T12:00:00Z", writer: "claude-code" });
		await selectForRollback(deps, { session_id: "sess-1", after: "2026-10-26T12:00:00Z" });
		expect(writers).toEqual(["claude-code", null]);
		await expect(selectForRollback(deps, { session_id: "sess-1", after: "2026-10-26T12:00:00Z", writer: "" })).rejects.toMatchObject({ name: "ForgetError", path: "writer" });
		expect(writers).toHaveLength(2);
	});

	test("an until before after, or not an instant, is refused before the store is asked", async () => {
		const s = store(["mem_a"]);
		await expect(selectForRollback(s.deps, { session_id: "sess-1", after: "2026-10-26T12:00:00Z", until: "2026-10-26T11:59:59.999Z" })).rejects.toMatchObject({ name: "ForgetError", path: "until", rule: "range" });
		await expect(selectForRollback(s.deps, { session_id: "sess-1", after: "2026-10-26T12:00:00Z", until: "soon" })).rejects.toMatchObject({ name: "ForgetError", path: "until", rule: "format" });
		await expect(selectForRollback(s.deps, { session_id: "sess-1", after: "2026-10-26T12:00:00Z", until: 5 as never })).rejects.toMatchObject({ name: "ForgetError", path: "until", rule: "type" });
		expect(s.calls).toEqual([]);
	});

	test("asks the store for entries strictly after the instant, in whole milliseconds, with the default cap", async () => {
		const s = store(["mem_a", "mem_b"]);
		const selection = await selectForRollback(s.deps, { session_id: "sess-1", after: "2026-10-26T12:00:00.123456Z" });
		expect(s.calls).toEqual([["sess-1", "2026-10-26T12:00:00.123Z", null, DEFAULT_ROLLBACK_SELECT_LIMIT]]);
		expect(selection).toEqual({ entry_ids: ["mem_a", "mem_b"], truncated: false, after: "2026-10-26T12:00:00.123Z" });
	});

	test("carries the graph and the limit, keeps the store's order, drops duplicates and flags truncation", async () => {
		const s = store(["mem_b", "mem_a", "mem_b"], true);
		const selection = await selectForRollback(s.deps, { session_id: "sess-1", after: "2026-10-26T14:00:00+02:00", graph_id: "g-1", limit: 5 });
		expect(s.calls[0]).toEqual(["sess-1", "2026-10-26T12:00:00.000Z", "g-1", 5]);
		expect(selection.entry_ids).toEqual(["mem_b", "mem_a"]);
		expect(selection.truncated).toBe(true);
	});

	test("a store that returns more than asked is trimmed and reported truncated", async () => {
		const s = store(["a", "b", "c"]);
		const selection = await selectForRollback(s.deps, { session_id: "sess-1", after: "2026-10-26T12:00:00Z", limit: 2 });
		expect(selection).toMatchObject({ entry_ids: ["a", "b"], truncated: true });
	});

	const bad: Array<[string, Record<string, unknown>, string, string]> = [
		["a missing session", { after: "2026-10-26T12:00:00Z" }, "session_id", "missing"],
		["a missing instant", { session_id: "s" }, "after", "missing"],
		["an empty session", { session_id: "", after: "2026-10-26T12:00:00Z" }, "session_id", "range"],
		["a date-only instant", { session_id: "s", after: "2026-10-26" }, "after", "format"],
		["a non-date instant", { session_id: "s", after: "yesterday" }, "after", "format"],
		["an impossible instant", { session_id: "s", after: "2026-13-45T99:00:00Z" }, "after", "format"],
		["a numeric instant", { session_id: "s", after: 1_700_000_000_000 }, "after", "type"],
		["a zero limit", { session_id: "s", after: "2026-10-26T12:00:00Z", limit: 0 }, "limit", "range"],
		["a limit past the maximum", { session_id: "s", after: "2026-10-26T12:00:00Z", limit: MAX_ROLLBACK_SELECT_LIMIT + 1 }, "limit", "range"],
		["a fractional limit", { session_id: "s", after: "2026-10-26T12:00:00Z", limit: 1.5 }, "limit", "type"],
		["an unknown key", { session_id: "s", after: "2026-10-26T12:00:00Z", scope: "x" }, "scope", "unknown_key"],
	];
	for (const [name, input, path, rule] of bad) {
		test(`rejects ${name}`, async () => {
			const s = store([]);
			await expect(selectForRollback(s.deps, input as never)).rejects.toMatchObject({ name: "ForgetError", path, rule });
			expect(s.calls).toEqual([]);
		});
	}
});

describe("how the other readers treat a forget marker", () => {
	// A marker is a non-null `superseded_by` that no reader follows. These guard the readers outside this unit's
	// files, so a later change to one of them cannot quietly bring a forgotten entry back or break on the value.
	const SRC = import.meta.dir;
	const read = (name: string): string => readFileSync(join(SRC, name), "utf8");

	test("the retain replay answers gone for any superseded_by, a marker included", () => {
		// `deliverParkedRetain` is private to the service, so the decision is guarded at its source line: an entry
		// whose `superseded_by` is defined (an entry id or a forget marker) is dropped, not re-forwarded.
		const service = read("service.ts");
		const start = service.indexOf("private deliverParkedRetain(");
		expect(start).toBeGreaterThan(-1);
		const body = service.slice(start, start + 1600);
		expect(body).toContain("if (!current || current.superseded_by !== undefined) return \"gone\";");
	});

	test("the brief, the standing-entry lookup and the lifecycle sweep read only rows with no superseded_by", () => {
		expect(memoryLifecycleQuery(DEFAULT_SWEEP_POLICY, NOW).text).toContain("e.superseded_by is null");
		const ttl = planSweep(DEFAULT_SWEEP_POLICY, NOW).filter((step) => step.cls.id.startsWith("entries-ttl"));
		expect(ttl.map((step) => step.cls.id)).toEqual(["entries-ttl-30d", "entries-ttl-graph"]);
		for (const step of ttl) expect({ id: step.cls.id, text: step.cls.count(step.cutoff).text }).toMatchObject({ text: expect.stringContaining("superseded_by is null") });
		expect(read("service.ts")).toContain("!entry.superseded_by");
	});

	test("no source file follows superseded_by as a pointer, so a marker is never dereferenced", () => {
		// The only writer of an entry id into the column is the write gate's supersession update inside index-store.ts;
		// every reader compares it with null or undefined. Any file that names the column and looked an entry up by it
		// (`readEntry(<x>.superseded_by)`) would turn a marker into a lookup of a row that does not exist.
		const named = readdirSync(SRC)
			.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".fixtures.ts"))
			.filter((name) => /superseded_by/.test(read(name)));
		expect(named).toContain("index-store.ts");
		expect(named).toContain("service.ts");
		for (const name of named) expect({ name, derefs: /readEntry\(\s*[\w.?]*superseded_by/.test(read(name)) }).toEqual({ name, derefs: false });
	});
});
