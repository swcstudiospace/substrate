import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import type { DeadLetter } from "./event-buffer.ts";
import { Substrate, type EmitResult } from "./service.ts";
import type { EventInput, SubstrateEvent } from "./types.ts";

const dirs: string[] = [];
const opened: Substrate[] = [];
afterEach(async () => {
	// Each instance is closed the way shutdown closes it, before its scratch dir goes: a tick left running would write later.
	for (const substrate of opened.splice(0)) await substrate.drainPendingEvents(0, { abandon: true });
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "service-event-buffer-"));
	dirs.push(dir);
	return dir;
}

const TIP = "tip-0";
const input: EventInput = { surface: "omp", kind: "shell", summary: "ran cargo test", session_id: "sess-1" };

/**
 * A ledger that records what it stores. `failures` names the insert calls (1-based, across the whole test) that
 * throw, with their message; every other insert lands. `lastHash` is the tip of what was written, or TIP before anything was.
 */
function ledger(failures: (call: number) => string | null) {
	const written: SubstrateEvent[] = [];
	let calls = 0;
	const greptime = {
		ensureAppendMode: async () => true,
		lastHash: async () => written.at(-1)?.hash ?? TIP,
		eventStored: async () => false,
		// No ledger row carries the key: a replay finds nothing and the parked event answers it.
		findByIdempotencyKey: async () => null,
		recordIngest: async () => undefined,
		insertEvent: async (event: SubstrateEvent) => {
			calls += 1;
			const failure = failures(calls);
			if (failure !== null) throw new Error(failure);
			written.push(event);
		},
	};
	return { written, greptime, inserts: () => calls };
}

function substrateWith(env: Record<string, string>, greptime: unknown): Substrate {
	const substrate = new Substrate(loadConfig(env), { index: null, greptime: greptime as never });
	opened.push(substrate);
	return substrate;
}

/** Stop the drain tick and hand a memory-only buffer's leftovers to the dead letters, so no timer outlives the test. */
async function close(substrate: Substrate): Promise<void> {
	await substrate.drainPendingEvents(0, { abandon: true });
}

function deadLetterRecords(path: string): DeadLetter[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as DeadLetter);
}

describe("a failed ledger write is parked, not dropped", () => {
	test("a write that succeeds at once is stored, not parked", async () => {
		const { written, greptime } = ledger(() => null);
		const substrate = substrateWith({}, greptime);
		const result = await substrate.emit(input);

		expect(result.stored).toBe(true);
		expect(result.buffered).toBeUndefined();
		expect(written).toHaveLength(1);
		expect((await substrate.health()).eventBuffer.pending).toBe(0);
		await close(substrate);
	});

	test("retry then success: the first write fails, the retry stores the same event", async () => {
		const { written, greptime } = ledger((call) => (call === 1 ? "greptime unreachable: ETIMEDOUT" : null));
		const substrate = substrateWith({}, greptime);
		const result = await substrate.emit(input);

		expect(result.stored).toBe(false);
		expect(result.buffered).toBe(true);
		expect(result.error).toContain("ETIMEDOUT");
		expect(written).toHaveLength(0);
		expect((await substrate.health()).eventBuffer.pending).toBe(1);

		await substrate.drainEventBuffer({ all: true });
		expect(written).toHaveLength(1);
		expect(written[0]?.id).toBe(result.event.id);
		expect(written[0]?.hash).toBe(result.event.hash);
		expect(written[0]?.prev).toBe(TIP);
		const health = await substrate.health();
		expect(health.eventBuffer.pending).toBe(0);
		expect(health.eventBuffer.deadLetters.depth).toBe(0);
		await close(substrate);
	});

	test("retry exhausted: the event is written to the dead-letter file with its hash, and healthz counts it", async () => {
		const dir = scratch();
		const deadPath = join(dir, "dead-letter.jsonl");
		const { written, greptime } = ledger(() => "greptime unreachable: ECONNRESET");
		const substrate = substrateWith({ SUBSTRATE_LEDGER_BUFFER_MAX_ATTEMPTS: "2", SUBSTRATE_LEDGER_DEAD_LETTER_PATH: deadPath }, greptime);
		const result = await substrate.emit(input);
		expect(result.buffered).toBe(true);

		await substrate.drainEventBuffer({ all: true });
		expect(written).toHaveLength(0);
		const records = deadLetterRecords(deadPath);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ id: result.event.id, hash: result.event.hash, cause: "exhausted", attempts: 2 });
		expect(records[0]?.event.hash).toBe(result.event.hash);

		const health = await substrate.health();
		expect(health.eventBuffer).toEqual({
			pending: 0,
			max: 1000,
			oldestAt: null,
			durable: false,
			deadLetters: { depth: 1, max: 10000, durable: true, evicted: 0 },
		});
		await close(substrate);
	});

	test("a full buffer dead-letters the new event at once, and healthz reports the depth", async () => {
		const dir = scratch();
		const deadPath = join(dir, "dead-letter.jsonl");
		const { greptime } = ledger(() => "greptime unreachable: ETIMEDOUT");
		const substrate = substrateWith({ SUBSTRATE_LEDGER_BUFFER_MAX: "1", SUBSTRATE_LEDGER_DEAD_LETTER_PATH: deadPath }, greptime);

		const first = await substrate.emit(input);
		expect(first.buffered).toBe(true);
		const second = await substrate.emit({ ...input, session_id: "sess-2" });
		expect(second.stored).toBe(false);
		expect(second.deadLettered).toBe(true);
		expect(second.buffered).toBeUndefined();

		const health = await substrate.health();
		expect(health.eventBuffer.pending).toBe(1);
		expect(health.eventBuffer.max).toBe(1);
		expect(health.eventBuffer.deadLetters.depth).toBe(1);
		const records = deadLetterRecords(deadPath);
		expect(records).toEqual([expect.objectContaining({ id: second.event.id, hash: second.event.hash, cause: "overflow" })]);
		await close(substrate);
	});

	test("a session's later event waits behind the parked one: it chains onto it, and both land in order", async () => {
		// The ledger is still down for the second write, so the second event parks behind the first one's attempt.
		const { written, greptime } = ledger((call) => (call <= 2 ? "greptime unreachable: ETIMEDOUT" : null));
		const substrate = substrateWith({}, greptime);
		const first: EmitResult = await substrate.emit(input);
		const second: EmitResult = await substrate.emit({ ...input, summary: "ran cargo build" });

		// The second event was not written directly: a direct write would fork the chain the first one extends.
		expect(second.buffered).toBe(true);
		expect(second.event.prev).toBe(first.event.hash);
		expect(first.event.prev).toBe(TIP);
		expect(written).toHaveLength(0);

		await substrate.drainEventBuffer({ all: true });
		expect(written.map((event) => event.id)).toEqual([first.event.id, second.event.id]);
		expect(written[1]?.prev).toBe(written[0]?.hash);
		await close(substrate);
	});

	test("a session's later write settles the parked event first once the ledger is back: the parked one lands, then the new one chains onto it", async () => {
		const { written, greptime } = ledger((call) => (call === 1 ? "greptime unreachable: ETIMEDOUT" : null));
		const substrate = substrateWith({}, greptime);
		const first: EmitResult = await substrate.emit(input);
		const second: EmitResult = await substrate.emit({ ...input, summary: "ran cargo build" });

		// The first event's attempt answered on the second write, so the second is stored directly, after it.
		expect(first.buffered).toBe(true);
		expect(second.stored).toBe(true);
		expect(second.buffered).toBeUndefined();
		expect(written.map((event) => event.id)).toEqual([first.event.id, second.event.id]);
		expect(second.event.prev).toBe(first.event.hash);
		expect(written[1]?.prev).toBe(written[0]?.hash);
		await close(substrate);
	});

	test("a keyed replay of a parked event answers with it and writes nothing", async () => {
		const { written, greptime, inserts } = ledger((call) => (call === 1 ? "greptime unreachable: ETIMEDOUT" : null));
		const substrate = substrateWith({ SUBSTRATE_EVENT_IDEMPOTENCY: "accept" }, greptime);
		const keyed: EventInput = { ...input, idempotency_key: "replay-key-1", ts: new Date().toISOString() };
		const original = await substrate.emit(keyed);
		expect(original.buffered).toBe(true);

		const replay = await substrate.emit(keyed, { replay: true });
		expect(replay.stored).toBe(false);
		expect(replay.buffered).toBe(true);
		expect(replay.event.id).toBe(original.event.id);
		expect(inserts()).toBe(1);

		await substrate.drainEventBuffer({ all: true });
		expect(written).toHaveLength(1);
		await close(substrate);
	});

	test("parked events survive a restart when a buffer path is set, and healthz reports them after boot", async () => {
		const dir = scratch();
		const bufferPath = join(dir, "buffer.jsonl");
		const env = { SUBSTRATE_LEDGER_BUFFER_PATH: bufferPath };
		const before = substrateWith(env, ledger(() => "greptime unreachable: ETIMEDOUT").greptime);
		const parked = await before.emit(input);
		expect(parked.buffered).toBe(true);
		await close(before);
		// `close` is a shutdown with a memory-only buffer only; the durable file must still hold the event.
		expect(readFileSync(bufferPath, "utf8")).toContain(parked.event.id);

		const after = substrateWith(env, null);
		const health = await after.health();
		expect(health.eventBuffer).toMatchObject({ pending: 1, durable: true });
		expect(health.eventBuffer.oldestAt).not.toBeNull();
		await close(after);
	});
});

describe("shutdown closes the tick, and a ledger that never answers holds a write for one call at most", () => {
	/**
	 * A ledger that answers normally until `arm()`, then settles no call: a link that accepts the connection and goes silent.
	 * `timeoutMs` is the budget the write path bounds itself by, as the real client's is.
	 */
	function silentLedger(timeoutMs: number) {
		let armed = false;
		const calls: string[] = [];
		const reached = Promise.withResolvers<void>();
		const never = () => new Promise<never>(() => undefined);
		const greptime = {
			timeoutMs,
			ensureAppendMode: async () => true,
			lastHash: async () => {
				calls.push("lastHash");
				return armed ? never() : TIP;
			},
			eventStored: async () => {
				calls.push("eventStored");
				if (armed) reached.resolve();
				return armed ? never() : false;
			},
			findByIdempotencyKey: async () => null,
			recordIngest: async () => undefined,
			insertEvent: async () => {
				calls.push("insertEvent");
				if (armed) return never();
				throw new Error("greptime unreachable: ETIMEDOUT");
			},
		};
		const arm = () => {
			armed = true;
		};
		return { greptime, arm, reached: reached.promise, calls };
	}

	test("a closed instance writes nothing after the tick interval; an open one holding the same parked event delivers it", async () => {
		const up = { value: false };
		const down = () => (up.value ? null : "greptime unreachable: ETIMEDOUT");
		const closedLedger = ledger(down);
		const openLedger = ledger(down);
		const closed = substrateWith({ SUBSTRATE_LEDGER_BUFFER_PATH: join(scratch(), "buffer.jsonl") }, closedLedger.greptime);
		const open = substrateWith({ SUBSTRATE_LEDGER_BUFFER_PATH: join(scratch(), "buffer.jsonl") }, openLedger.greptime);
		expect((await closed.emit(input)).buffered).toBe(true);
		expect((await open.emit(input)).buffered).toBe(true);
		await close(closed);
		// A write after the close still parks, but must not re-arm the tick the close stopped.
		expect((await closed.emit({ ...input, summary: "ran after close" })).buffered).toBe(true);
		const closedWrites = closedLedger.inserts();

		up.value = true;
		// The tick is a real `setInterval` inside Substrate with no clock to inject, so this test waits in real time. The first
		// retry is due 1.6–2.4 s after the park (a 2 s base, ±20%): four seconds clears it and several 1 s ticks.
		await Bun.sleep(4_000);
		expect(closedLedger.inserts()).toBe(closedWrites);
		expect(closedLedger.written).toHaveLength(0);
		expect(openLedger.written).toHaveLength(1);
	});

	test("a ledger that never answers holds a write for one call's budget at most, and the write parks behind its session's tip", async () => {
		const TIMEOUT = 150;
		const silent = silentLedger(TIMEOUT);
		const substrate = substrateWith({}, silent.greptime);
		const parked = await substrate.emit(input);
		expect(parked.buffered).toBe(true);

		silent.arm();
		const before = silent.calls.length;
		const started = performance.now();
		const next = await substrate.emit({ ...input, summary: "ran cargo build" });
		const elapsed = performance.now() - started;

		expect(next.stored).toBe(false);
		expect(next.buffered).toBe(true);
		expect(next.event.prev).toBe(parked.event.hash);
		expect(elapsed).toBeLessThan(TIMEOUT + 250);
		// One blocked call, the settle's own. The write then parked: it asked the ledger for neither the tip nor an insert.
		expect(silent.calls.slice(before)).toEqual(["eventStored"]);
	});

	test("a drain pass already blocked on the ledger does not hold a write past one call's budget", async () => {
		const TIMEOUT = 150;
		const silent = silentLedger(TIMEOUT);
		const substrate = substrateWith({}, silent.greptime);
		const parked = await substrate.emit(input);
		silent.arm();
		// A pass starts, as the tick's does, and blocks on the ledger. Nothing awaits it.
		void substrate.drainEventBuffer({ all: true });
		await silent.reached;
		const before = silent.calls.length;
		const started = performance.now();
		const next = await substrate.emit({ ...input, summary: "ran cargo build" });
		expect(performance.now() - started).toBeLessThan(TIMEOUT + 250);
		expect(next.buffered).toBe(true);
		expect(next.event.prev).toBe(parked.event.hash);
		// The write queued behind the pass without a call of its own: the pass is the one blocked call.
		expect(silent.calls.slice(before)).toEqual([]);
	});
});
