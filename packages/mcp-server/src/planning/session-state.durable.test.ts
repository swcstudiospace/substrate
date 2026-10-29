/**
 * The durable copy of the steering session registry (phase 67): write-through, the boot load with its TTL and cap, and a store
 * that fails. The store is an in-memory fake with the real port's shape, the clock is injected, and `idle()` is the only wait.
 */
import { describe, expect, test } from "bun:test";
import type { SteeringSession, SteeringSessionState } from "../event.ts";
import type { EventInput, Surface } from "../types.ts";
import {
	SteeringSessionRegistry,
	STEERING_PERSIST_FAILED_ACTION,
	STEERING_PERSIST_PENDING_MAX,
	STEERING_PERSIST_WARN_INTERVAL_MS,
} from "./session-state.ts";
import { storedSessionOf, type SteeringSessionsLoadQuery, type SteeringSessionsStore, type StoredSteeringSession } from "./steering-sessions-store.ts";

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

/** A made-up credential shaped like a GitHub token, so the redactor has something to find. */
const TOKEN = "ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";

const session = (id: string, updatedMs: number, state: SteeringSessionState = "ACTIVE", extra: Partial<SteeringSession> = {}): SteeringSession => ({
	session_id: id,
	repo_id: "owner/name",
	state,
	updated_at: new Date(updatedMs).toISOString(),
	...extra,
});

/** The table in memory, keyed like the real one, with the port's own ordering and filtering. */
class FakeStore implements SteeringSessionsStore {
	readonly rows = new Map<string, StoredSteeringSession>();
	saves: Array<{ surface: Surface; id: string; state: string }> = [];
	failSaves: Error | null = null;
	failLoads: Error | null = null;
	prunedBefore: number | null = null;
	gate: Promise<void> | null = null;

	async save(surface: Surface, value: SteeringSession): Promise<void> {
		if (this.gate !== null) await this.gate;
		if (this.failSaves !== null) throw this.failSaves;
		this.saves.push({ surface, id: value.session_id, state: value.state });
		this.rows.set(`${surface}:${value.session_id}`, { surface, session: value });
	}

	async loadNewest(query: SteeringSessionsLoadQuery): Promise<StoredSteeringSession[]> {
		if (this.failLoads !== null) throw this.failLoads;
		return [...this.rows.values()]
			.filter((row) => Date.parse(row.session.updated_at) >= query.sinceMs)
			.sort((a, b) => Date.parse(b.session.updated_at) - Date.parse(a.session.updated_at))
			.slice(0, query.limit);
	}

	async prune(beforeMs: number): Promise<number> {
		this.prunedBefore = beforeMs;
		let removed = 0;
		for (const [key, row] of this.rows) {
			if (Date.parse(row.session.updated_at) < beforeMs) {
				this.rows.delete(key);
				removed += 1;
			}
		}
		return removed;
	}

	seed(surface: Surface, value: SteeringSession): void {
		this.rows.set(`${surface}:${value.session_id}`, { surface, session: value });
	}
}

function build(options: { store?: SteeringSessionsStore | null; cap?: number; ttlMs?: number; clock?: { now: number } } = {}) {
	const events: EventInput[] = [];
	const lines: string[] = [];
	const clock = options.clock ?? { now: T0 };
	const reg = new SteeringSessionRegistry({
		emit: async (event) => {
			events.push(event);
			return { stored: true };
		},
		nowMs: () => clock.now,
		report: (line) => lines.push(line),
		...(options.store === undefined ? {} : { store: options.store }),
		...(options.cap === undefined ? {} : { cap: options.cap }),
		...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
	});
	return { reg, events, lines, clock };
}

describe("write-through", () => {
	test("each put is upserted to the store, in the order it was made", async () => {
		const store = new FakeStore();
		const { reg } = build({ store });
		reg.put("omp", "s-1", session("s-1", T0, "ACTIVE"));
		reg.put("omp", "s-1", session("s-1", T0 + 1, "PAUSED"));
		reg.put("cursor", "s-2", session("s-2", T0 + 2, "ACTIVE"));
		await reg.idle();
		expect(store.saves).toEqual([
			{ surface: "omp", id: "s-1", state: "ACTIVE" },
			{ surface: "omp", id: "s-1", state: "PAUSED" },
			{ surface: "cursor", id: "s-2", state: "ACTIVE" },
		]);
		expect(store.rows.get("omp:s-1")?.session.state).toBe("PAUSED");
	});

	test("a credential in a session's directions is redacted before it reaches the table, while memory keeps the caller's text", async () => {
		const store = new FakeStore();
		const { reg } = build({ store });
		reg.put("omp", "s-1", session("s-1", T0, "ACTIVE", { steering: `Push with ${TOKEN} then stop`, planning_hash: `h-${TOKEN}` }));
		await reg.idle();
		const row = store.rows.get("omp:s-1")?.session;
		expect(JSON.stringify(row)).not.toContain(TOKEN);
		expect(row?.steering).toContain("[REDACTED]");
		expect(row?.planning_hash).toContain("[REDACTED]");
		expect(row?.session_id).toBe("s-1");
		expect(reg.get("omp", "s-1")?.steering).toContain(TOKEN);
	});

	test("a row an earlier build stored with a credential is redacted when it is read back", () => {
		const stored = storedSessionOf({ surface: "omp", session_id: "s-1", repo_id: "owner/name", state: "ACTIVE", steering: `use ${TOKEN}`, planning_hash: null, updated_at: new Date(T0).toISOString() });
		expect(JSON.stringify(stored)).not.toContain(TOKEN);
		expect(stored?.session.steering).toContain("[REDACTED]");
	});

	test("a transition an acknowledgement drives is written through too", async () => {
		const store = new FakeStore();
		const { reg } = build({ store });
		reg.put("omp", "s-1", session("s-1", T0, "ACTIVE"));
		expect(await reg.applyTransition("s-1", "PAUSED", { directiveId: "dir-1" })).toEqual({ ok: true, changed: true });
		await reg.idle();
		expect(store.rows.get("omp:s-1")?.session.state).toBe("PAUSED");
	});

	test("with no store nothing is written and nothing is reported", async () => {
		const { reg, events, lines } = build({ store: null });
		reg.put("omp", "s-1", session("s-1", T0));
		await reg.idle();
		expect(reg.get("omp", "s-1")?.state).toBe("ACTIVE");
		expect(events).toEqual([]);
		expect(lines).toEqual([]);
		expect(await reg.loadDurable()).toEqual({ loaded: 0, pruned: 0, failed: null });
	});
});

describe("a store that fails", () => {
	test("the call that wrote still succeeds, the memory holds the session, and one warning note is recorded", async () => {
		const store = new FakeStore();
		store.failSaves = new Error("connection refused");
		const { reg, events } = build({ store });
		reg.put("omp", "s-1", session("s-1", T0, "ACTIVE"));
		reg.put("omp", "s-2", session("s-2", T0, "ACTIVE"));
		await reg.idle();
		expect(reg.get("omp", "s-1")?.state).toBe("ACTIVE");
		expect(reg.get("omp", "s-2")?.state).toBe("ACTIVE");
		// Two failed writes inside the warning interval: one note, with the action registered in the event vocabulary.
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ surface: "omp", kind: "warning", payload: { action: STEERING_PERSIST_FAILED_ACTION } });
	});

	test("a later write after the interval warns again, and a store that recovers resumes writing", async () => {
		const store = new FakeStore();
		store.failSaves = new Error("down");
		const { reg, events, clock } = build({ store });
		reg.put("omp", "s-1", session("s-1", T0));
		await reg.idle();
		clock.now += STEERING_PERSIST_WARN_INTERVAL_MS;
		reg.put("omp", "s-1", session("s-1", T0 + 1));
		await reg.idle();
		expect(events).toHaveLength(2);
		store.failSaves = null;
		reg.put("omp", "s-1", session("s-1", T0 + 2, "PAUSED"));
		await reg.idle();
		expect(store.rows.get("omp:s-1")?.session.state).toBe("PAUSED");
	});

	test("the warning carries a redacted, cut reason and never the session's steering text", async () => {
		const store = new FakeStore();
		store.failSaves = new Error(`password authentication failed for ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2 ${"x".repeat(500)}`);
		const { reg, events } = build({ store });
		reg.put("omp", "s-1", session("s-1", T0, "ACTIVE", { steering: "private direction" }));
		await reg.idle();
		const text = JSON.stringify(events);
		expect(text).not.toContain("ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2");
		expect(text).not.toContain("private direction");
		expect(String(events[0]?.payload?.reason).length).toBeLessThanOrEqual(200);
	});

	test("writes queued behind a slow store stop at the bound instead of growing without one", async () => {
		const store = new FakeStore();
		let release: () => void = () => undefined;
		store.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { reg, events } = build({ store });
		for (let n = 0; n < STEERING_PERSIST_PENDING_MAX + 5; n++) reg.put("omp", `s-${n}`, session(`s-${n}`, T0));
		// The registry still holds every session; the overflow is a warning, not a failure of the call.
		expect(reg.size).toBe(STEERING_PERSIST_PENDING_MAX + 5);
		expect(events).toHaveLength(1);
		release();
		await reg.idle();
		expect(store.saves).toHaveLength(STEERING_PERSIST_PENDING_MAX);
	});

	test("a failing emit does not break the registry either", async () => {
		const store = new FakeStore();
		store.failSaves = new Error("down");
		const reg = new SteeringSessionRegistry({
			emit: () => {
				throw new Error("ledger down");
			},
			store,
			report: () => undefined,
		});
		reg.put("omp", "s-1", session("s-1", T0));
		await reg.idle();
		reg.put("omp", "s-2", session("s-2", T0));
		expect(reg.size).toBe(2);
	});
});

describe("loadDurable", () => {
	test("loads what is inside the TTL, drops what is older, and prunes the table", async () => {
		const store = new FakeStore();
		store.seed("omp", session("fresh", T0 - 1 * DAY));
		store.seed("omp", session("edge", T0 - 7 * DAY));
		store.seed("cursor", session("stale", T0 - 7 * DAY - 1));
		const { reg } = build({ store, ttlMs: 7 * DAY });
		expect(await reg.loadDurable()).toEqual({ loaded: 2, pruned: 1, failed: null });
		expect(reg.get("omp", "fresh")?.state).toBe("ACTIVE");
		expect(reg.get("omp", "edge")?.state).toBe("ACTIVE");
		expect(reg.get("cursor", "stale")).toBeUndefined();
		expect(store.prunedBefore).toBe(T0 - 7 * DAY);
		expect([...store.rows.keys()].sort()).toEqual(["omp:edge", "omp:fresh"]);
	});

	test("keeps the newest `cap` rows, and the newest end up the newest held", async () => {
		const store = new FakeStore();
		for (let n = 0; n < 10; n++) store.seed("omp", session(`s-${n}`, T0 - (10 - n) * 1000));
		const { reg } = build({ store, cap: 4 });
		expect((await reg.loadDurable()).loaded).toBe(4);
		expect(reg.size).toBe(4);
		expect(reg.entries().map((entry) => entry.session.session_id)).toEqual(["s-9", "s-8", "s-7", "s-6"]);
		// A new session past the cap evicts the oldest loaded one, as it does without a store.
		reg.put("omp", "new", session("new", T0));
		expect(reg.get("omp", "s-6")).toBeUndefined();
		expect(reg.get("omp", "s-9")).toBeDefined();
	});

	test("loading writes nothing back, and a session already held is not replaced by an older stored one", async () => {
		const store = new FakeStore();
		store.seed("omp", session("s-1", T0 - 1000, "PAUSED"));
		const { reg } = build({ store });
		reg.put("omp", "s-1", session("s-1", T0, "ACTIVE"));
		await reg.idle();
		store.saves = [];
		await reg.loadDurable();
		await reg.idle();
		expect(reg.get("omp", "s-1")?.state).toBe("ACTIVE");
		expect(store.saves).toEqual([]);
	});

	test("a store that cannot be read is reported and the registry starts with what it holds", async () => {
		const store = new FakeStore();
		store.failLoads = new Error("relation steering_sessions does not exist");
		const { reg, lines } = build({ store });
		reg.put("omp", "early", session("early", T0));
		const report = await reg.loadDurable();
		expect(report).toMatchObject({ loaded: 0, pruned: 0 });
		expect(report.failed).toContain("steering_sessions");
		expect(lines).toHaveLength(1);
		expect(reg.get("omp", "early")?.state).toBe("ACTIVE");
	});

	test("a restart is the same registry: what one process wrote the next one loads", async () => {
		const store = new FakeStore();
		const first = build({ store });
		first.reg.put("omp", "s-1", session("s-1", T0, "PAUSED", { steering: "hold", planning_hash: "h1" }));
		await first.reg.idle();
		const second = build({ store });
		await second.reg.loadDurable();
		expect(second.reg.get("omp", "s-1")).toMatchObject({ state: "PAUSED", steering: "hold", planning_hash: "h1" });
		expect(second.reg.lookup("s-1")).toMatchObject({ status: "one", surface: "omp" });
	});
});
