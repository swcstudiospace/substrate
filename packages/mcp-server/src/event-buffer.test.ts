import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
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

/** A buffer whose clock the test moves by hand, with every give-up recorded by summary and reason. */
function harness(options: { path?: string; max?: number; maxAttempts?: number; backoffMs?: number; backoffCapMs?: number } = {}) {
	const clock = { now: 1_000_000 };
	const dead: Array<{ summary: string; reason: DeadLetterReason }> = [];
	const buffer = new EventBuffer({
		...options,
		now: () => clock.now,
		random: () => 0.5,
		onDeadLetter: (entry: EventBufferEntry, reason: DeadLetterReason) => dead.push({ summary: entry.event.summary, reason }),
	});
	return { buffer, clock, dead };
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
