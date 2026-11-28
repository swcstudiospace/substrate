/**
 * Phase 102 F3 proven against fakes: kind filtering, durable cursor
 * round-trip and restart resume, per-doc debounce/coalesce, F1-writer-only
 * re-ingest, bounded retries with backoff into the reused dead-letter store,
 * and fail-open polls. Fake-only — no live Greptime or LightRAG in tests.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeadLetterStore } from "../event-dead-letter.ts";
import { outboxBackoffMs } from "../outbox-file.ts";
import {
	DebounceCoalescer,
	DEFAULT_DEBOUNCE_WINDOW_MS,
	DocRefresher,
	filterFileChangeKinds,
	loadCursor,
	pollAgentEvents,
	storeCursor,
	type DocRefreshEvent,
	type GreptimeQuery,
	type SingleDocRefreshPlan,
} from "./doc-refresh.ts";

const TRACER_ROW = { kind: "file-change", doc: "a.md", cursor: 42 };

function tempCursorPath(): string {
	return join(mkdtempSync(join(tmpdir(), "doc-refresh-")), "cursor.json");
}

function recordingQuery(rows: Array<Record<string, unknown>>, seen: { sql: string[]; since: number[] }): GreptimeQuery {
	return async (sql: string, params: { since: number }) => {
		seen.sql.push(sql);
		seen.since.push(params.since);
		return rows.filter((row) => typeof row["cursor"] === "number" && (row["cursor"] as number) > params.since);
	};
}

function setupClock(start = 0): { now: () => number; advance: (ms: number) => void } {
	let at = start;
	return { now: () => at, advance(ms: number): void { at += ms; } };
}

function setupIngest(failuresBeforeSuccess: number, calls: SingleDocRefreshPlan[]): {
	ingest: (plan: SingleDocRefreshPlan) => Promise<void>;
} {
	let failuresLeft = failuresBeforeSuccess;
	return {
		ingest: async (plan: SingleDocRefreshPlan) => {
			calls.push(plan);
			if (failuresLeft > 0) {
				failuresLeft -= 1;
				throw new Error("lightrag ingest unavailable");
			}
		},
	};
}

describe("filterFileChangeKinds", () => {
	test("keeps file/change kinds, drops everything else, sorts by cursor", () => {
		const events = filterFileChangeKinds([
			{ kind: "prompt", doc: "skip.md", cursor: 3 },
			{ kind: "file.edit", doc: "b.md", cursor: 9 },
			TRACER_ROW,
			{ kind: "session.start", doc: "skip2.md", cursor: 1 },
			{ kind: "file.edit", path: "c.md", repo: "r1", cursor: 7 },
		]);
		expect(events).toEqual([
			{ docKey: "r1:c.md", cursor: 7 },
			{ docKey: "b.md", cursor: 9 },
			{ docKey: "a.md", cursor: 42 },
		]);
	});

	test("reads the doc key from payload objects and JSON payload strings", () => {
		const events = filterFileChangeKinds([
			{ kind: "file.edit", cursor: 1, payload: { path: "p.md" } },
			{ kind: "file-change", cursor: 2, payload: JSON.stringify({ doc: "q.md" }) },
			{ kind: "file.edit", cursor: 3, payload: "not-json" },
			{ kind: "file.edit", cursor: 4 },
		]);
		expect(events).toEqual([
			{ docKey: "p.md", cursor: 1 },
			{ docKey: "q.md", cursor: 2 },
		]);
	});
});

describe("pollAgentEvents + durable cursor", () => {
	test("tracer: one hardcoded fake row flows poll -> filter -> storeCursor", async () => {
		const seen = { sql: [] as string[], since: [] as number[] };
		const result = await pollAgentEvents(recordingQuery([TRACER_ROW], seen), { since: 0 });
		expect(result.held).toBe(false);
		expect(result.events).toEqual([{ docKey: "a.md", cursor: 42 }]);
		expect(result.cursor).toBe(42);
		expect(seen.sql).toHaveLength(1);
		expect(seen.sql[0]).toContain("agent_events");
		expect(seen.since).toEqual([0]);

		const path = tempCursorPath();
		storeCursor(path, result.cursor);
		expect(loadCursor(path)).toBe(42);
	});

	test("restart resumes from the stored cursor with no re-delivery", async () => {
		const path = tempCursorPath();
		storeCursor(path, 42);
		const resumed = loadCursor(path);
		const seen = { sql: [] as string[], since: [] as number[] };
		const result = await pollAgentEvents(
			recordingQuery([TRACER_ROW, { kind: "file.edit", doc: "b.md", cursor: 43 }], seen),
			{ since: resumed },
		);
		expect(result.events).toEqual([{ docKey: "b.md", cursor: 43 }]);
		expect(result.cursor).toBe(43);
		expect(seen.since).toEqual([42]);
	});

	test("missing or malformed cursor files fall back fail-open", () => {
		expect(loadCursor(join(tmpdir(), "doc-refresh-no-such-dir", "cursor.json"))).toBe(0);
		expect(loadCursor(tempCursorPath(), 7)).toBe(7);
	});

	test("query failure resolves held: cursor not advanced, no ingest call", async () => {
		const query: GreptimeQuery = async () => {
			throw new Error("greptime unreachable");
		};
		const result = await pollAgentEvents(query, { since: 42 });
		expect(result).toEqual({ events: [], cursor: 42, held: true });
	});
});

describe("DebounceCoalescer", () => {
	test("5 rapid events for one doc collapse to a single due item with the latest cursor", () => {
		const clock = setupClock();
		const coalescer = new DebounceCoalescer({ windowMs: DEFAULT_DEBOUNCE_WINDOW_MS, now: clock.now });
		for (let cursor = 1; cursor <= 5; cursor += 1) {
			clock.advance(1_000);
			coalescer.observe({ docKey: "a.md", cursor });
		}
		expect(coalescer.due()).toEqual([]);
		clock.advance(DEFAULT_DEBOUNCE_WINDOW_MS);
		expect(coalescer.due()).toEqual([{ docKey: "a.md", cursor: 5 }]);
		expect(coalescer.size()).toBe(0);
	});

	test("distinct docs go due independently; window expiry allows a second call", () => {
		const clock = setupClock();
		const coalescer = new DebounceCoalescer({ windowMs: 60_000, now: clock.now });
		coalescer.observe({ docKey: "a.md", cursor: 1 });
		coalescer.observe({ docKey: "b.md", cursor: 2 });
		clock.advance(60_000);
		const due = coalescer.due().sort((a, b) => (a.docKey < b.docKey ? -1 : 1));
		expect(due).toEqual([
			{ docKey: "a.md", cursor: 1 },
			{ docKey: "b.md", cursor: 2 },
		]);
		coalescer.observe({ docKey: "a.md", cursor: 3 });
		clock.advance(60_000);
		expect(coalescer.due()).toEqual([{ docKey: "a.md", cursor: 3 }]);
	});
});

describe("DocRefresher", () => {
	test("coalesced burst reaches the F1 writer once as a single-doc plan", async () => {
		const clock = setupClock();
		const coalescer = new DebounceCoalescer({ windowMs: 60_000, now: clock.now });
		for (let cursor = 1; cursor <= 5; cursor += 1) coalescer.observe({ docKey: "a.md", cursor });
		clock.advance(60_000);

		const calls: SingleDocRefreshPlan[] = [];
		const refresher = new DocRefresher({ ingest: setupIngest(0, calls).ingest, deadLetter: new DeadLetterStore() });
		const outcomes = await refresher.refreshDue(coalescer.due());
		expect(calls).toEqual([{ docKey: "a.md", cursor: 5 }]);
		expect(outcomes).toEqual([{ docKey: "a.md", outcome: "refreshed", cursor: 5, attempts: 1 }]);
	});

	test("transient failures retry with the event-buffer backoff, then succeed", async () => {
		const delays: number[] = [];
		const calls: SingleDocRefreshPlan[] = [];
		const refresher = new DocRefresher({
			ingest: setupIngest(2, calls).ingest,
			deadLetter: new DeadLetterStore(),
			sleep: async (ms: number) => void delays.push(ms),
			random: () => 0.5,
		});
		const outcome = await refresher.refreshDoc("a.md", 42);
		expect(outcome).toEqual({ docKey: "a.md", outcome: "refreshed", cursor: 42, attempts: 3 });
		expect(calls).toHaveLength(3);
		expect(delays).toEqual([
			outboxBackoffMs(0, { base: 2_000, cap: 300_000 }, () => 0.5),
			outboxBackoffMs(1, { base: 2_000, cap: 300_000 }, () => 0.5),
		]);
	});

	test("exhausted retries record one replayable DLQ record and nothing is silently dropped", async () => {
		const deadLetter = new DeadLetterStore();
		const calls: SingleDocRefreshPlan[] = [];
		const refresher = new DocRefresher({
			ingest: setupIngest(Number.MAX_SAFE_INTEGER, calls).ingest,
			deadLetter,
			maxAttempts: 3,
			sleep: async () => undefined,
		});
		const outcome = await refresher.refreshDoc("a.md", 42);
		expect(outcome).toEqual({ docKey: "a.md", outcome: "dead-lettered", cursor: 42, attempts: 3 });
		expect(calls).toHaveLength(3);

		const records = deadLetter.records();
		expect(records).toHaveLength(1);
		const record = records[0];
		if (record === undefined) throw new Error("expected one DLQ record");
		expect(record.reason).toBe("exhausted");
		expect(record.attempts).toBe(3);
		expect(record.last_reason).toBe("lightrag ingest unavailable");
		const payload = record.event.payload as Record<string, unknown>;
		expect(payload["docKey"]).toBe("a.md");
		expect(payload["cursor"]).toBe(42);
		expect(record.event_hash).toBe(record.event.hash);
	});

	test("refresh outcomes carry the F5 handoff fields", async () => {
		const calls: SingleDocRefreshPlan[] = [];
		const refresher = new DocRefresher({ ingest: setupIngest(0, calls).ingest, deadLetter: new DeadLetterStore() });
		const [outcome] = await refresher.refreshDue([{ docKey: "a.md", cursor: 42 } as DocRefreshEvent]);
		if (outcome === undefined) throw new Error("expected one outcome");
		expect(Object.keys(outcome).sort()).toEqual(["attempts", "cursor", "docKey", "outcome"]);
	});
});
