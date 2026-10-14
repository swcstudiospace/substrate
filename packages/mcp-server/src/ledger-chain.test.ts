/**
 * The session chain on the emit path, after uplift-2 R5: one chain-tip read per
 * session instead of one per emit, a time-bounded read with an unbounded
 * fallback, and same-session emits that cannot fork — plus the write probe and
 * ledger capacity that `/healthz` folds in.
 *
 * Nothing touches the network. The ledger here is a tiny in-memory store behind
 * a replaced `fetch`: it keeps every `agent_events` row's `hash` and `prev` and
 * answers the chain-tip read from them, so the assertions are about the real
 * client's statements and the real `Substrate.emit`, not about a fake's idea of
 * either.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { InvalidEventError, verifyChain } from "./event.ts";
import { GreptimeClient } from "./greptime.ts";
import { HEALTH_PROBE_MS, Substrate } from "./service.ts";
import { healthStatus } from "./server.ts";
import type { GreptimeConfig } from "./config.ts";
import type { EventInput } from "./types.ts";

const config: GreptimeConfig = { url: "http://greptime.test", user: "u", password: "p", db: "substrate" };
const T0 = Date.UTC(2026, 9, 13, 12);
const DAY_MS = 86_400_000;

function records(columns: string[], rows: unknown[][]) {
	return { output: [{ records: { schema: { column_schemas: columns.map((name) => ({ name })) }, rows } }] };
}
const affected = { output: [{ affectedrows: 1 }] };

/** One stored event row, as the chain-tip read sees it. */
interface Row {
	hash: string;
	prev: string | null;
	session: string;
}

/**
 * An in-memory ledger behind `fetch`. `rows` is what the store holds; `sql` is
 * every statement sent; `sessionReads` counts chain-tip reads; `before` runs
 * ahead of every statement and may stall or fail it.
 */
interface FakeLedger {
	rows: Row[];
	sql: string[];
	sessionReads(): number;
	before: (statement: string) => Promise<unknown | undefined>;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function fakeLedger(seed: Row[] = []): FakeLedger {
	const ledger: FakeLedger = {
		rows: [...seed],
		sql: [],
		sessionReads: () => ledger.sql.filter((s) => s.includes('FROM "agent_events" WHERE "session_id"')).length,
		before: async () => undefined,
	};
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		const statement = new URLSearchParams(String(init.body)).get("sql") ?? "";
		ledger.sql.push(statement);
		const override = await ledger.before(statement);
		if (override instanceof Response) return override;
		const reply = override ?? answer(ledger, statement);
		return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return ledger;
}

function answer(ledger: FakeLedger, statement: string): unknown {
	if (statement.includes("LENGTH")) return records(["n"], [[3]]);
	if (statement.includes("SHOW CREATE TABLE")) return records(["Create Table"], [["... WITH( append_mode = 'true' )"]]);
	const insert = /^INSERT INTO "agent_events" .* VALUES \(.*, '([0-9a-f]{64})', (?:'([0-9a-f]{64})'|NULL)\)$/s.exec(statement);
	if (insert) {
		const session = /VALUES \('[^']*', '[^']*', '[^']*', '([^']*)'/.exec(statement)?.[1] ?? "";
		ledger.rows.push({ hash: insert[1]!, prev: insert[2] ?? null, session });
		return affected;
	}
	const read = /WHERE "session_id" = '([^']+)'/.exec(statement);
	if (read) {
		// Newest first is what the real statement orders by; the fake has no ts,
		// so it hands the rows back in reverse append order, which is the same thing.
		const rows = ledger.rows.filter((row) => row.session === read[1]).reverse();
		return records(["hash", "prev"], rows.map((row) => [row.hash, row.prev]));
	}
	return affected;
}

function substrateWith(greptime: unknown, env: Record<string, string> = {}): Substrate {
	return new Substrate(loadConfig(env), { index: null, greptime: greptime as never });
}

function client(env: Record<string, string> = {}, now: () => number = () => T0): GreptimeClient {
	return new GreptimeClient(config, { ledger: loadConfig(env).ledger, clock: now });
}

const input = (session_id: string, summary = "ran cargo test"): EventInput => ({ surface: "omp", kind: "shell", summary, session_id });

describe("chain-tip cache", () => {
	test("one session costs one chain-tip lookup, however many events it emits", async () => {
		const ledger = fakeLedger();
		const greptime = client();
		const substrate = substrateWith(greptime);

		const results = [];
		for (let i = 0; i < 3; i++) results.push(await substrate.emit(input("sess-1", `step ${i}`)));
		expect(results.every((result) => result.stored)).toBe(true);
		// Two statements for the one lookup — the session was empty, so the bounded
		// read fell back to the whole session — and none for the emits after it.
		expect(ledger.sessionReads()).toBe(2);
		expect(greptime.chainTipsCached).toBe(1);

		// Each event chains onto the one before: prev is the previous hash, and
		// the chain verifies as a whole.
		const events = results.map((result) => result.event);
		expect(events[0]?.prev).toBeNull();
		expect(events[1]?.prev).toBe(events[0]!.hash);
		expect(events[2]?.prev).toBe(events[1]!.hash);
		expect(verifyChain(events)).toEqual({ ok: true });
		expect(ledger.rows.map((row) => row.prev)).toEqual([null, events[0]!.hash, events[1]!.hash]);
	});

	test("steady-state emit is two ledger calls: the event row and its ingest record", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(client());
		await substrate.emit(input("sess-1", "warm"));
		const before = ledger.sql.length;
		await substrate.emit(input("sess-1", "steady"));
		const calls = ledger.sql.slice(before);
		expect(calls.map((s) => s.split(" ").slice(0, 3).join(" "))).toEqual(['INSERT INTO "agent_events"', 'INSERT INTO "event_ingest"']);
	});

	test("a miss seeds the tip from the ledger with a read bounded to the lookback window", async () => {
		const stored = "a".repeat(64);
		const ledger = fakeLedger([{ hash: stored, prev: null, session: "sess-old" }]);
		const greptime = client({ SUBSTRATE_LEDGER_CHAIN_LOOKBACK_DAYS: "7" });
		const result = await substrateWith(greptime).emit(input("sess-old"));

		expect(result.event.prev).toBe(stored);
		const read = ledger.sql.find((s) => s.includes('WHERE "session_id"')) ?? "";
		expect(read).toContain(`"ts" >= '${new Date(T0 - 7 * DAY_MS).toISOString()}'`);
		expect(read).toContain("LIMIT 10000");
		expect(ledger.sessionReads()).toBe(1);
	});

	test("falls back to the whole session when the bounded read sees nothing, so an old session continues its chain", async () => {
		const stored = "b".repeat(64);
		const ledger = fakeLedger([{ hash: stored, prev: null, session: "sess-quiet" }]);
		// The bounded read answers empty; only the unbounded one sees the row.
		ledger.before = async (statement) =>
			statement.includes('WHERE "session_id"') && statement.includes('"ts" >=') ? records(["hash", "prev"], []) : undefined;
		const greptime = client();
		const result = await substrateWith(greptime).emit(input("sess-quiet"));

		expect(result.event.prev).toBe(stored);
		const reads = ledger.sql.filter((s) => s.includes('WHERE "session_id"'));
		expect(reads).toHaveLength(2);
		expect(reads[0]).toContain('"ts" >=');
		expect(reads[1]).not.toContain('"ts" >=');
		// Seeded now: the next emit reads nothing.
		await substrateWith(greptime).emit(input("sess-quiet", "again"));
		expect(ledger.sessionReads()).toBe(2);
	});

	test("an event-row error forgets the tip, and the next emit reads the ledger again", async () => {
		const ledger = fakeLedger();
		const greptime = client();
		const substrate = substrateWith(greptime);
		await substrate.emit(input("sess-1", "first"));
		expect(greptime.chainTipsCached).toBe(1);

		let fail = true;
		ledger.before = async (statement) =>
			fail && statement.startsWith('INSERT INTO "agent_events"') ? new Response("nope", { status: 503 }) : undefined;
		const refused = await substrate.emit(input("sess-1", "lost"));
		expect(refused.stored).toBe(false);
		expect(greptime.chainTipsCached).toBe(0);

		fail = false;
		const next = await substrate.emit(input("sess-1", "after"));
		expect(next.stored).toBe(true);
		expect(ledger.sessionReads()).toBe(3);
		// It chained onto the row that is actually in the ledger, not the lost one.
		expect(next.event.prev).toBe(ledger.rows[0]!.hash);
	});

	test("an unconfirmed ingest record keeps the tip: the event row is stored, so the chain moves on", async () => {
		const ledger = fakeLedger();
		const greptime = client();
		const substrate = substrateWith(greptime);
		ledger.before = async (statement) =>
			statement.startsWith('INSERT INTO "event_ingest"') ? new Response("nope", { status: 503 }) : undefined;
		const first = await substrate.emit(input("sess-1", "first"));
		expect(first.stored).toBe(true);
		expect(first.warning).toBeDefined();

		ledger.before = async () => undefined;
		const second = await substrate.emit(input("sess-1", "second"));
		expect(second.event.prev).toBe(first.event.hash);
		expect(ledger.sessionReads()).toBe(2);
	});

	test("SUBSTRATE_LEDGER_CHAIN_CACHE=0 restores one read per emit", async () => {
		const ledger = fakeLedger();
		const greptime = client({ SUBSTRATE_LEDGER_CHAIN_CACHE: "0" });
		const substrate = substrateWith(greptime);
		for (let i = 0; i < 3; i++) await substrate.emit(input("sess-1", `step ${i}`));
		// One lookup per emit: two statements for the first (empty session, so the
		// bounded read fell back), one for each after it.
		expect(ledger.sessionReads()).toBe(4);
		expect(greptime.chainTipsCached).toBe(0);
	});

	test("the cache is an LRU bounded by SUBSTRATE_LEDGER_CHAIN_CACHE_MAX", async () => {
		const ledger = fakeLedger([
			{ hash: "1".repeat(64), prev: null, session: "s1" },
			{ hash: "2".repeat(64), prev: null, session: "s2" },
			{ hash: "3".repeat(64), prev: null, session: "s3" },
		]);
		const greptime = client({ SUBSTRATE_LEDGER_CHAIN_CACHE_MAX: "2" });
		await greptime.lastHash("s1");
		await greptime.lastHash("s2");
		await greptime.lastHash("s1"); // a hit makes s1 the most recently used
		await greptime.lastHash("s3"); // evicts s2, not s1
		expect(greptime.chainTipsCached).toBe(2);
		expect(ledger.sessionReads()).toBe(3);
		await greptime.lastHash("s1");
		expect(ledger.sessionReads()).toBe(3);
		await greptime.lastHash("s2");
		expect(ledger.sessionReads()).toBe(4);
	});

	test("a session known to be empty is cached as such: a handoff's read and its emit share one lookup", async () => {
		const ledger = fakeLedger();
		const greptime = client();
		expect(await greptime.lastHash("sess-new")).toBeNull();
		// The bounded read saw nothing, so the whole session was read once more.
		expect(ledger.sessionReads()).toBe(2);
		expect(greptime.chainTipsCached).toBe(1);
		const result = await substrateWith(greptime).emit(input("sess-new"));
		expect(result.event.prev).toBeNull();
		expect(ledger.sessionReads()).toBe(2);
		expect(await greptime.lastHash("sess-new")).toBe(result.event.hash);
	});
});

describe("same-session emits cannot fork", () => {
	/**
	 * Stall every chain-tip read until `release` is called, so unserialised emits
	 * would read the same tip; `firstRead` settles once the first one arrives.
	 */
	function stallReads(ledger: FakeLedger): { release: () => void; stalled: () => number; firstRead: Promise<void> } {
		let stalled = 0;
		const { promise, resolve } = Promise.withResolvers<void>();
		const first = Promise.withResolvers<void>();
		ledger.before = async (statement) => {
			if (statement.includes('WHERE "session_id"')) {
				stalled += 1;
				first.resolve();
				await promise;
			}
			return undefined;
		};
		return { release: resolve, stalled: () => stalled, firstRead: first.promise };
	}

	test("two concurrent emits of one session produce one chain: the second's prev is the first's hash", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(client());
		const { release, firstRead } = stallReads(ledger);
		const pending = Promise.all([substrate.emit(input("sess-1", "a")), substrate.emit(input("sess-1", "b"))]);
		await firstRead;
		release();
		const [a, b] = await pending;

		expect(a.stored && b.stored).toBe(true);
		expect(a.event.prev).toBeNull();
		expect(b.event.prev).toBe(a.event.hash);
		expect(verifyChain([a.event, b.event])).toEqual({ ok: true });
		expect(ledger.rows.map((row) => row.prev)).toEqual([null, a.event.hash]);
	});

	test("serialisation alone prevents the fork, even with the cache off", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(client({ SUBSTRATE_LEDGER_CHAIN_CACHE: "0" }));
		const { release, stalled, firstRead } = stallReads(ledger);
		const pending = Promise.all([substrate.emit(input("sess-1", "a")), substrate.emit(input("sess-1", "b")), substrate.emit(input("sess-1", "c"))]);
		await firstRead;
		// Only the first emit has reached the ledger; the others wait their turn.
		expect(stalled()).toBe(1);
		release();
		const [a, b, c] = await pending;
		expect(b.event.prev).toBe(a.event.hash);
		expect(c.event.prev).toBe(b.event.hash);
		expect(ledger.sessionReads()).toBe(4);
	});

	test("different sessions stay concurrent", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(client());
		const { promise: hold, resolve: release } = Promise.withResolvers<void>();
		ledger.before = async (statement) => {
			if (statement.includes(`"session_id" = 'sess-slow'`)) await hold;
			return undefined;
		};
		const slow = substrate.emit(input("sess-slow"));
		// Resolves only because sessions do not wait on each other: were they
		// serialised together, this would hang behind the held read.
		const quick = await substrate.emit(input("sess-quick"));
		expect(quick.stored).toBe(true);
		expect(ledger.rows.map((row) => row.session)).toEqual(["sess-quick"]);
		release();
		expect((await slow).stored).toBe(true);
	});

	test("an invalid event releases its session's turn", async () => {
		fakeLedger();
		const substrate = substrateWith(client());
		await expect(substrate.emit({ ...input("sess-1"), kind: "not-a-kind" as never })).rejects.toThrow(InvalidEventError);
		// Would hang behind the failed emit's turn if the chain were not released.
		expect((await substrate.emit(input("sess-1", "after"))).stored).toBe(true);
	});

	test("sessionless events never wait", async () => {
		const ledger = fakeLedger();
		const substrate = substrateWith(client());
		const result = await substrate.emit({ surface: "omp", kind: "shell", summary: "no session" });
		expect(result.stored).toBe(true);
		expect(result.event.prev).toBeNull();
		expect(ledger.sessionReads()).toBe(0);
	});
});

describe("healthz write probe and ledger capacity", () => {
	/** A metadata-writable ledger whose probe and capacity the test scripts. */
	function ledger(probe: { lastProbeAt: number | null; lastProbeOk: boolean | null; lastProbeError: string | null } | "missing" | "throws", capacity?: unknown) {
		const intervals: number[] = [];
		const greptime: Record<string, unknown> = {
			ensureAppendMode: async () => true,
			probeDialect: async () => true,
			quotingDialectKnown: true,
			lastHash: async () => null,
			insertEvent: async () => undefined,
			ping: async () => true,
		};
		if (probe !== "missing") {
			greptime.probeWritable = async (intervalMs: number) => {
				intervals.push(intervalMs);
				if (probe === "throws") throw new Error("probe exploded");
				return probe;
			};
		}
		if (capacity !== undefined) greptime.capacity = async () => capacity;
		return { greptime, intervals };
	}
	const closedPlanes = expect.objectContaining({ greptime: expect.objectContaining({ ok: true }) });

	test("a probe that succeeded keeps the ledger writable and is reported under ledger", async () => {
		const { greptime, intervals } = ledger({ lastProbeAt: T0, lastProbeOk: true, lastProbeError: null });
		const health = await substrateWith(greptime).health();
		expect(health.eventsWritable).toBe(true);
		expect(health.ledger).toEqual({ writable: true, lastProbeAt: T0, lastProbeOk: true, lastProbeError: null });
		expect(health.planes).toEqual(closedPlanes);
		expect(intervals).toEqual([60_000]);
		expect(healthStatus(health, true)).toBe(200);
	});

	test("a failed probe flips eventsWritable and /healthz to 503 while metadata still says writable", async () => {
		const { greptime } = ledger({ lastProbeAt: T0, lastProbeOk: false, lastProbeError: "greptime 500: no space left on device" });
		const health = await substrateWith(greptime).health();
		expect(health.greptime).toBe(true);
		expect(health.appendOnly).toBe(true);
		expect(health.quotingDialectKnown).toBe(true);
		expect(health.eventsWritable).toBe(false);
		expect(health.ledger).toEqual({ writable: false, lastProbeAt: T0, lastProbeOk: false, lastProbeError: "greptime 500: no space left on device" });
		expect(healthStatus(health, true)).toBe(503);
	});

	test("no probe yet neither proves nor disproves: writability is the metadata's", async () => {
		const { greptime } = ledger({ lastProbeAt: null, lastProbeOk: null, lastProbeError: null });
		const health = await substrateWith(greptime).health();
		expect(health.eventsWritable).toBe(true);
		expect(health.ledger).toEqual({ writable: true, lastProbeAt: null, lastProbeOk: null, lastProbeError: null });
	});

	test("the probe cadence comes from SUBSTRATE_LEDGER_WRITE_PROBE_S, and 0 turns it off", async () => {
		const { greptime, intervals } = ledger({ lastProbeAt: null, lastProbeOk: null, lastProbeError: null });
		await substrateWith(greptime, { SUBSTRATE_LEDGER_WRITE_PROBE_S: "15" }).health();
		await substrateWith(greptime, { SUBSTRATE_LEDGER_WRITE_PROBE_S: "0" }).health();
		expect(intervals).toEqual([15_000, 0]);
	});

	test("a ledger without the probe (an older fake) or one whose probe throws is never a throw out of health()", async () => {
		const missing = await substrateWith(ledger("missing").greptime).health();
		expect(missing.eventsWritable).toBe(true);
		expect(missing.ledger).toEqual({ writable: true, lastProbeAt: null, lastProbeOk: null, lastProbeError: null });
		const throws = await substrateWith(ledger("throws").greptime).health();
		expect(throws.eventsWritable).toBe(true);
		expect(throws.ledger.lastProbeOk).toBeNull();
	});

	test("an unreachable ledger is not probed", async () => {
		const { greptime, intervals } = ledger({ lastProbeAt: null, lastProbeOk: null, lastProbeError: null });
		greptime.ping = async () => false;
		const health = await substrateWith(greptime).health();
		expect(health.eventsWritable).toBe(false);
		expect(intervals).toEqual([]);
	});

	test("metadata that refuses still refuses, whatever the probe said", async () => {
		const { greptime } = ledger({ lastProbeAt: T0, lastProbeOk: true, lastProbeError: null });
		greptime.ensureAppendMode = async () => false;
		const health = await substrateWith(greptime).health();
		expect(health.eventsWritable).toBe(false);
		expect(health.ledger.writable).toBe(false);
		expect(health.ledger.lastProbeOk).toBe(true);
	});

	test("capacity.ledger carries the ledger's size, beside capacity.index, and null when it is slow, throws or is missing", async () => {
		const size = { bytes: 2_570_000, rows: 24_153, tables: [{ name: "agent_events", rows: 14_302, diskBytes: 1_280_000, sstBytes: 1_250_000, indexBytes: 0 }] };
		const answered = await substrateWith(ledger({ lastProbeAt: T0, lastProbeOk: true, lastProbeError: null }, size).greptime).health();
		expect(answered.capacity).toEqual({ index: null, ledger: size });

		const slow = ledger({ lastProbeAt: T0, lastProbeOk: true, lastProbeError: null });
		slow.greptime.capacity = () => Promise.withResolvers<never>().promise;
		const started = Date.now();
		const timedOut = await substrateWith(slow.greptime).health();
		expect(Date.now() - started).toBeLessThan(HEALTH_PROBE_MS + 500);
		expect(timedOut.capacity).toEqual({ index: null, ledger: null });

		const broken = ledger({ lastProbeAt: T0, lastProbeOk: true, lastProbeError: null });
		broken.greptime.capacity = async () => {
			throw new Error("region_statistics missing");
		};
		expect((await substrateWith(broken.greptime).health()).capacity).toEqual({ index: null, ledger: null });
		expect((await substrateWith(ledger("missing").greptime).health()).capacity).toEqual({ index: null, ledger: null });
	});

	test("the real client's probe and capacity go through the stubbed transport end to end", async () => {
		const store = fakeLedger();
		store.before = async (statement) =>
			statement.includes("region_statistics")
				? records(["table_name", "region_rows", "disk_size", "sst_size", "index_size"], [["agent_events", 3, 300, 250, 0]])
				: undefined;
		const health = await substrateWith(client()).health();
		expect(health.eventsWritable).toBe(true);
		expect(health.ledger).toEqual({ writable: true, lastProbeAt: T0, lastProbeOk: true, lastProbeError: null });
		expect(store.sql.some((s) => s.startsWith('INSERT INTO "substrate_health"'))).toBe(true);
		expect(health.capacity.ledger).toEqual({ bytes: 300, rows: 3, tables: [{ name: "agent_events", rows: 3, diskBytes: 300, sstBytes: 250, indexBytes: 0 }] });
	});
});
