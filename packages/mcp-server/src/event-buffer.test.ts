import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeEvent } from "./event.ts";
import { type EnqueueOutcome, type EventDelivery, type EventEnqueue, EventBuffer, type EventBufferEntry, eventBufferBackoffMs } from "./event-buffer.ts";
import type { DeadLetterReason } from "./event-dead-letter.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "event-buffer-"));
	dirs.push(dir);
	return join(dir, "buffer.jsonl");
}

/**
 * A buffer whose clock the test moves by hand, with every give-up recorded by summary and reason. Its dead-letter store can be taken
 * down (`store.down`): a record then stays held, and the entry it belongs to stays pending in the buffer, until the store is back.
 */
function harness(options: { path?: string; max?: number; maxAttempts?: number; backoffMs?: number; backoffCapMs?: number; deadLetterDown?: boolean } = {}) {
	const clock = { now: 1_000_000 };
	const dead: Array<{ summary: string; reason: DeadLetterReason }> = [];
	const store = { down: options.deadLetterDown === true, failRecords: 0, held: [] as string[], written: [] as string[] };
	const flush = (): boolean => {
		if (store.down) return false;
		store.written.push(...store.held.splice(0));
		return true;
	};
	const buffer = new EventBuffer({
		...options,
		now: () => clock.now,
		random: () => 0.5,
		onDeadLetter: (entry: EventBufferEntry, reason: DeadLetterReason) => {
			dead.push({ summary: entry.event.summary, reason });
			store.held.push(entry.event.summary);
			// `failRecords` makes the next record stay in memory: the store took it but could not write it.
			if (store.failRecords > 0) {
				store.failRecords -= 1;
				return false;
			}
			return flush();
		},
		flushDeadLetters: flush,
	});
	return { buffer, clock, dead, store };
}

/** A request for one event of `session`. A session's first event is a live write that failed; later ones have not tried yet. */
function request(session: string | null, summary: string, over: Partial<EventEnqueue> = {}): EventEnqueue {
	return {
		session,
		key: null,
		ledgerPrev: null,
		build: (prev) => normalizeEvent({ surface: "omp", kind: "note", summary, session_id: session ?? undefined }, prev),
		last_reason: "unreachable",
		attempts: 1,
		...over,
	};
}

function buffered(outcome: EnqueueOutcome): EventBufferEntry {
	if (!outcome.buffered) throw new Error("expected the event to be buffered");
	return outcome.entry;
}

const summaries = (buffer: EventBuffer): string[] => buffer.list().map((entry) => entry.event.summary);

describe("eventBufferBackoffMs", () => {
	test("the first retry waits about the base, and each attempt doubles it", () => {
		expect(eventBufferBackoffMs(0, 1000, 60_000, () => 0.5)).toBe(1000);
		expect(eventBufferBackoffMs(3, 1000, 60_000, () => 0.5)).toBe(8000);
	});

	test("the jitter stays within ±20 % at both ends of the random draw", () => {
		expect(eventBufferBackoffMs(0, 1000, 60_000, () => 0)).toBe(800);
		expect(eventBufferBackoffMs(0, 1000, 60_000, () => 1)).toBe(1200);
	});

	test("the cap holds however many attempts have passed, and a negative attempt is the first", () => {
		expect(eventBufferBackoffMs(30, 1000, 60_000, () => 0.5)).toBe(60_000);
		expect(eventBufferBackoffMs(-4, 1000, 60_000, () => 0.5)).toBe(1000);
	});
});

describe("EventBuffer bound", () => {
	test("over the bound the oldest entry is given up with a record, never dropped silently", () => {
		const { buffer, dead } = harness({ max: 2 });
		buffer.enqueue(request("s-1", "a"));
		buffer.enqueue(request("s-2", "b"));
		const third = buffer.enqueue(request("s-3", "c"));

		expect(third.buffered).toBe(true);
		expect(buffer.size()).toBe(2);
		expect(dead).toEqual([{ summary: "a", reason: "overflow" }]);
		expect(summaries(buffer)).toEqual(["b", "c"]);
	});

	test("giving up an entry gives up the later entries of its session, which could never chain", () => {
		const { buffer, dead } = harness({ max: 3 });
		const a = buffered(buffer.enqueue(request("s-1", "a")));
		const b = buffered(buffer.enqueue(request("s-1", "b", { attempts: 0 })));
		buffer.enqueue(request("s-2", "c"));
		buffer.enqueue(request("s-3", "d"));

		expect(b.event.prev).toBe(a.event.hash);
		expect(dead).toEqual([
			{ summary: "a", reason: "overflow" },
			{ summary: "b", reason: "predecessor-dead-lettered" },
		]);
		expect(summaries(buffer)).toEqual(["c", "d"]);
	});

	test("an event that waits behind its session chains onto the buffered tail, not the ledger tip", () => {
		const { buffer } = harness();
		const a = buffered(buffer.enqueue(request("s-1", "a", { ledgerPrev: "ledger-tip" })));
		const b = buffered(buffer.enqueue(request("s-1", "b", { attempts: 0, ledgerPrev: "ledger-tip" })));

		expect(a.event.prev).toBe("ledger-tip");
		expect(b.event.prev).toBe(a.event.hash);
	});

	test("an entry being delivered is never given up for room, and the new event is refused instead", async () => {
		const { buffer, dead } = harness({ max: 1 });
		buffer.enqueue(request("s-1", "a"));
		const gate = Promise.withResolvers<EventDelivery>();
		const running = buffer.drain(() => gate.promise, { all: true });

		const refused = buffer.enqueue(request("s-2", "b"));
		expect(refused.buffered).toBe(false);
		expect(dead).toEqual([{ summary: "b", reason: "buffer-full" }]);

		gate.resolve("landed");
		await running;
		expect(buffer.size()).toBe(0);
	});

	test("an event whose live write was its last allowed attempt is given up at once", () => {
		const { buffer, dead } = harness({ maxAttempts: 1 });
		const outcome = buffer.enqueue(request("s-1", "a"));

		expect(outcome).toMatchObject({ buffered: false, reason: "exhausted" });
		expect(buffer.size()).toBe(0);
		expect(dead).toEqual([{ summary: "a", reason: "exhausted" }]);
	});
});

describe("EventBuffer delivery", () => {
	test("a session's entries are delivered in chain order, each once", async () => {
		const { buffer, dead } = harness();
		buffer.enqueue(request("s-1", "a"));
		buffer.enqueue(request("s-1", "b", { attempts: 0 }));
		const landed: string[] = [];

		await buffer.drain(async (entry) => {
			landed.push(entry.event.summary);
			return "landed";
		}, { all: true });

		expect(landed).toEqual(["a", "b"]);
		expect(buffer.size()).toBe(0);
		expect(dead).toEqual([]);
	});

	test("a pass stops at its first transient failure, so the rest wait for the ledger", async () => {
		const { buffer } = harness();
		buffer.enqueue(request("s-1", "a"));
		buffer.enqueue(request("s-2", "c"));
		const attempted: string[] = [];

		await buffer.drain(async (entry) => {
			attempted.push(entry.event.summary);
			return { transient: "down" };
		}, { all: true });

		expect(attempted).toEqual(["a"]);
	});

	test("an entry is not attempted before its backoff ends, and each failure lengthens the wait", async () => {
		const { buffer, clock } = harness({ maxAttempts: 5, backoffMs: 1000, backoffCapMs: 60_000 });
		buffer.enqueue(request("s-1", "a"));
		const attempted: string[] = [];
		const deliver = async (entry: EventBufferEntry): Promise<EventDelivery> => {
			attempted.push(entry.event.summary);
			return { transient: "unreachable" };
		};

		await buffer.drain(deliver);
		expect(attempted).toEqual([]);

		clock.now += 1000;
		await buffer.drain(deliver);
		expect(attempted).toEqual(["a"]);
		expect(buffer.list()[0]).toMatchObject({ attempts: 2, next_at: clock.now + 2000 });
	});

	test("the attempt that reaches the ceiling gives the entry up, and its session's later entries with it", async () => {
		const { buffer, dead } = harness({ maxAttempts: 2 });
		buffer.enqueue(request("s-1", "a"));
		buffer.enqueue(request("s-1", "b", { attempts: 0 }));

		await buffer.drain(async () => ({ transient: "down" }), { all: true });

		expect(buffer.size()).toBe(0);
		expect(dead).toEqual([
			{ summary: "a", reason: "exhausted" },
			{ summary: "b", reason: "predecessor-dead-lettered" },
		]);
	});

	test("abandoning the buffer gives every entry up with the abandoned reason", () => {
		const { buffer, dead } = harness();
		buffer.enqueue(request("s-1", "a"));
		buffer.enqueue(request("s-2", "b"));

		expect(buffer.abandonAll()).toBe(2);
		expect(dead).toEqual([
			{ summary: "a", reason: "abandoned" },
			{ summary: "b", reason: "abandoned" },
		]);
	});

	test("a drain with all during a running pass still delivers the entries that pass skipped as not yet due", async () => {
		const { buffer } = harness();
		buffer.enqueue(request("s-1", "a", { attempts: 0 }));
		buffer.enqueue(request("s-2", "b"));
		const gate = Promise.withResolvers<EventDelivery>();
		const running = buffer.drain(() => gate.promise);
		const delivered: string[] = [];

		const followUp = buffer.drain(async (entry) => {
			delivered.push(entry.event.summary);
			return "landed";
		}, { all: true });
		gate.resolve("landed");
		await Promise.all([running, followUp]);

		expect(delivered).toEqual(["b"]);
		expect(buffer.size()).toBe(0);
	});

	test("abandoning the buffer during a delivery records the in-flight entry at once, so an exit before that delivery settles keeps it", async () => {
		const { buffer, dead } = harness();
		buffer.enqueue(request("s-1", "a"));
		buffer.enqueue(request("s-2", "b"));
		const gate = Promise.withResolvers<EventDelivery>();
		const running = buffer.drain(() => gate.promise, { all: true });

		expect(buffer.abandonAll()).toBe(2);
		expect(dead).toEqual([
			{ summary: "a", reason: "abandoned" },
			{ summary: "b", reason: "abandoned" },
		]);
		expect(buffer.size()).toBe(0);

		gate.resolve({ transient: "down" });
		await running;
		expect(buffer.size()).toBe(0);
		expect(dead).toHaveLength(2);
	});

	test("an in-flight entry that lands after the buffer was abandoned was recorded at the abandon, once", async () => {
		const { buffer, dead } = harness();
		buffer.enqueue(request("s-1", "a"));
		buffer.enqueue(request("s-2", "b"));
		const gate = Promise.withResolvers<EventDelivery>();
		const running = buffer.drain(() => gate.promise, { all: true });

		expect(buffer.abandonAll()).toBe(2);
		gate.resolve("landed");
		await running;

		expect(buffer.size()).toBe(0);
		expect(dead).toEqual([
			{ summary: "a", reason: "abandoned" },
			{ summary: "b", reason: "abandoned" },
		]);
	});
});

describe("EventBuffer persistence", () => {
	test("a file-backed buffer reads its entries back after a restart, skipping a torn line", () => {
		const path = tempPath();
		const first = harness({ path });
		first.buffer.enqueue(request("s-1", "a"));
		appendFileSync(path, "{torn\n");

		const second = harness({ path });
		expect(second.buffer.durable).toBe(true);
		expect(summaries(second.buffer)).toEqual(["a"]);
	});

	test("a bound that shrank since the last boot gives up the oldest entries, each with its record", () => {
		const path = tempPath();
		const first = harness({ path, max: 3 });
		for (const session of ["s-1", "s-2", "s-3"]) first.buffer.enqueue(request(session, session));

		const second = harness({ path, max: 1 });
		expect(summaries(second.buffer)).toEqual(["s-3"]);
		expect(second.dead).toEqual([
			{ summary: "s-1", reason: "overflow" },
			{ summary: "s-2", reason: "overflow" },
		]);
	});

	test("a memory-only buffer reports that it is not durable", () => {
		expect(harness().buffer.durable).toBe(false);
	});
});

describe("EventBuffer refusals, keyed cells and unreadable files", () => {
	test("a delivery the breaker refused is not an attempt, so the entry keeps its budget", async () => {
		const { buffer, dead } = harness({ maxAttempts: 2 });
		buffer.enqueue(request("s-1", "a"));
		let calls = 0;

		await buffer.drain(async () => {
			calls += 1;
			return "skipped";
		}, { all: true });

		expect(calls).toBe(1);
		expect(dead).toEqual([]);
		expect(buffer.list()[0]).toMatchObject({ attempts: 1 });
	});

	test("a queued keyed event answers only a replay of its own cell, not any event that reuses its key", () => {
		const { buffer } = harness();
		const queued = normalizeEvent({ surface: "omp", kind: "note", summary: "first", session_id: "s-1", graph_id: "g-1" }, null, { key: "replay-key-0001" });
		buffer.enqueue({ ...request("s-1", "first"), key: "replay-key-0001", build: () => queued });

		expect(buffer.findKeyed(queued, "replay-key-0001")?.event.id).toBe(queued.id);
		expect(buffer.findKeyed({ ...queued, kind: "warning" }, "replay-key-0001")).toBeNull();
		expect(buffer.findKeyed({ ...queued, graph_id: "g-2" }, "replay-key-0001")).toBeNull();
	});

	test("a file that cannot be read at boot is never rewritten, and the buffer says it is not durable", () => {
		const path = tempPath();
		// A directory: the read fails with EISDIR, which is not an empty buffer.
		mkdirSync(path);
		const { buffer } = harness({ path });
		expect(buffer.durable).toBe(false);
	});

	test("an event with an array payload survives a restart, so the buffer's own read-back keeps it", () => {
		const path = tempPath();
		const first = harness({ path });
		const event = normalizeEvent({ surface: "omp", kind: "note", summary: "arr", payload: ["note"] as unknown as Record<string, unknown> }, null);
		first.buffer.enqueue({ ...request(null, "arr"), build: () => event });

		const second = harness({ path });
		expect(summaries(second.buffer)).toEqual(["arr"]);
	});
});

describe("EventBuffer pending dead letters", () => {
	test("a failed dead-letter write keeps the given-up entry in the buffer, and it is never attempted again", async () => {
		const { buffer, store } = harness({ maxAttempts: 2, deadLetterDown: true });
		buffer.enqueue(request("s-1", "a"));
		let attempts = 0;
		const deliver = async (): Promise<EventDelivery> => {
			attempts += 1;
			return { transient: "down" };
		};

		await buffer.drain(deliver, { all: true });
		await buffer.drain(deliver, { all: true });

		expect(attempts).toBe(1);
		expect(buffer.list()).toMatchObject([{ given_up: "exhausted" }]);
		expect(store.held).toEqual(["a"]);
		expect(store.written).toEqual([]);
	});

	test("when the dead-letter store recovers, the record is written once and the entry leaves the buffer", async () => {
		const { buffer, store } = harness({ maxAttempts: 2, deadLetterDown: true });
		buffer.enqueue(request("s-1", "a"));
		await buffer.drain(async () => ({ transient: "down" }), { all: true });

		store.down = false;
		const attempted: string[] = [];
		const deliver = async (entry: EventBufferEntry): Promise<EventDelivery> => {
			attempted.push(entry.event.summary);
			return "landed";
		};
		await buffer.drain(deliver, { all: true });
		await buffer.drain(deliver, { all: true });

		expect(attempted).toEqual([]);
		expect(store.written).toEqual(["a"]);
		expect(buffer.size()).toBe(0);
	});

	test("a restart while the entry is pending records it once, when the dead-letter store works", async () => {
		const path = tempPath();
		const first = harness({ path, maxAttempts: 2, deadLetterDown: true });
		first.buffer.enqueue(request("s-1", "a"));
		await first.buffer.drain(async () => ({ transient: "down" }), { all: true });

		const second = harness({ path, maxAttempts: 2 });
		expect(second.buffer.list()).toMatchObject([{ given_up: "exhausted" }]);
		const attempted: string[] = [];
		await second.buffer.drain(
			async (entry) => {
				attempted.push(entry.event.summary);
				return "landed";
			},
			{ all: true },
		);

		expect(attempted).toEqual([]);
		expect(second.store.written).toEqual(["a"]);
		expect(second.dead).toEqual([{ summary: "a", reason: "exhausted" }]);
		expect(second.buffer.size()).toBe(0);
	});

	test("a full buffer of pending entries refuses the next event, and gives up nothing", async () => {
		const { buffer, store } = harness({ max: 1, maxAttempts: 2, deadLetterDown: true });
		buffer.enqueue(request("s-1", "a"));
		await buffer.drain(async () => ({ transient: "down" }), { all: true });

		const refused = buffer.enqueue(request("s-2", "b"));

		expect(refused).toMatchObject({ buffered: false, reason: "buffer-full", recorded: false });
		expect(summaries(buffer)).toEqual(["a"]);
		expect(store.held).toEqual(["a"]);
	});

	test("a give-up whose record write fails stays in the file as pending while there is room, and is written once when the store recovers", async () => {
		const path = tempPath();
		const { buffer, store, dead } = harness({ path, maxAttempts: 1 });
		store.failRecords = 1;

		const outcome = buffer.enqueue(request("s-1", "a", { attempts: 1 }));

		expect(outcome).toMatchObject({ buffered: false, reason: "exhausted", recorded: true });
		expect(buffer.list()).toMatchObject([{ given_up: "exhausted" }]);
		expect(readFileSync(path, "utf8")).toContain('"given_up":"exhausted"');

		const attempted: string[] = [];
		const deliver = async (entry: EventBufferEntry): Promise<EventDelivery> => {
			attempted.push(entry.event.summary);
			return "landed";
		};
		await buffer.drain(deliver, { all: true });
		await buffer.drain(deliver, { all: true });

		expect(attempted).toEqual([]);
		expect(store.written).toEqual(["a"]);
		expect(dead).toEqual([{ summary: "a", reason: "exhausted" }]);
		expect(buffer.size()).toBe(0);
	});

	test("a give-up whose record write fails with a full buffer is refused, and the caller keeps its copy", () => {
		const { buffer, store } = harness({ max: 1, maxAttempts: 2 });
		buffer.enqueue(request("s-1", "a"));
		store.failRecords = 1;

		const outcome = buffer.enqueue(request("s-2", "b", { attempts: 2 }));

		expect(outcome).toMatchObject({ buffered: false, recorded: false });
		expect(summaries(buffer)).toEqual(["a"]);
	});

	test("a restart while the pending give-up is in the file records it once, when the store works", async () => {
		const path = tempPath();
		const first = harness({ path, maxAttempts: 1 });
		first.store.failRecords = 1;
		first.buffer.enqueue(request("s-1", "a", { attempts: 1 }));

		const second = harness({ path, maxAttempts: 1 });
		expect(second.buffer.list()).toMatchObject([{ given_up: "exhausted" }]);
		const attempted: string[] = [];
		await second.buffer.drain(
			async (entry) => {
				attempted.push(entry.event.summary);
				return "landed";
			},
			{ all: true },
		);

		expect(attempted).toEqual([]);
		expect(second.store.written).toEqual(["a"]);
		expect(second.dead).toEqual([{ summary: "a", reason: "exhausted" }]);
		expect(second.buffer.size()).toBe(0);
	});
});
