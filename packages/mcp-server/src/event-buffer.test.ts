import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeadLetterStore, EventBuffer, type DeadLetter, type EventDelivery } from "./event-buffer.ts";
import { normalizeEvent } from "./event.ts";
import type { SubstrateEvent } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "event-buffer-"));
	dirs.push(dir);
	return dir;
}

/** A normalised event in `session`, chained onto `prev`. The hash is the real one, so records can be checked against it. */
function eventIn(session: string | null, summary: string, prev: string | null = null): SubstrateEvent {
	return normalizeEvent({ surface: "omp", kind: "shell", summary, session_id: session ?? undefined }, prev);
}

/** A clock the test moves by hand, and a backoff jitter fixed at 1.0 so every delay is exactly its base. */
function clock() {
	let at = 0;
	return { now: () => at, set: (ms: number) => (at = ms), random: () => 0.5 };
}

const failing = (reason = "ETIMEDOUT") => async (): Promise<EventDelivery> => ({ transient: reason });

describe("EventBuffer: success and retry", () => {
	test("a parked event is delivered on a later pass and leaves the buffer", async () => {
		const c = clock();
		const deadLetters = new DeadLetterStore();
		const buffer = new EventBuffer({ deadLetters, now: c.now, random: c.random });
		const a = eventIn("s1", "a");

		expect(buffer.enqueue(a, "ETIMEDOUT", true)).toBe("buffered");
		expect(buffer.size()).toBe(1);
		c.set(2_000);
		const seen: string[] = [];
		await buffer.drain(async (event) => {
			seen.push(event.id);
			return "delivered";
		});

		expect(seen).toEqual([a.id]);
		expect(buffer.size()).toBe(0);
		expect(deadLetters.depth()).toBe(0);
		expect(buffer.tipOf("s1")).toBeNull();
	});

	test("a transient answer spends one attempt and waits out the next, longer backoff", async () => {
		const c = clock();
		const buffer = new EventBuffer({ deadLetters: new DeadLetterStore(), now: c.now, random: c.random, maxAttempts: 10 });
		const a = eventIn("s1", "a");
		buffer.enqueue(a, "ETIMEDOUT", true);

		c.set(2_000);
		await buffer.drain(failing());
		expect(buffer.size()).toBe(1);

		// The second wait is 4 s (2 s doubled), so a pass at 5.999 s must not touch the event.
		let calls = 0;
		c.set(5_999);
		await buffer.drain(async () => {
			calls += 1;
			return "delivered";
		});
		expect(calls).toBe(0);

		c.set(6_000);
		await buffer.drain(async () => {
			calls += 1;
			return "delivered";
		});
		expect(calls).toBe(1);
		expect(buffer.size()).toBe(0);
	});

	test("an event parked without an attempt is due at once, yet still waits behind its session's earlier event", async () => {
		const c = clock();
		const buffer = new EventBuffer({ deadLetters: new DeadLetterStore(), now: c.now, random: c.random });
		const a = eventIn("s1", "a");
		const b = eventIn("s1", "b", a.hash);
		buffer.enqueue(a, "ETIMEDOUT", true);
		expect(buffer.enqueue(b, "queued behind an earlier event", false)).toBe("buffered");

		const calls: string[] = [];
		c.set(2_000);
		await buffer.drain(async (event) => {
			calls.push(event.id);
			return { transient: "ETIMEDOUT" };
		});
		// `a` failed, so `b` was not even tried: it would chain onto a row that is not written yet.
		expect(calls).toEqual([a.id]);
		expect(buffer.size()).toBe(2);
	});

	test("a session's events are delivered in chain order", async () => {
		const c = clock();
		const buffer = new EventBuffer({ deadLetters: new DeadLetterStore(), now: c.now, random: c.random });
		const a = eventIn("s1", "a");
		const b = eventIn("s1", "b", a.hash);
		buffer.enqueue(a, "ETIMEDOUT", true);
		buffer.enqueue(b, "queued", false);

		const calls: string[] = [];
		c.set(2_000);
		await buffer.drain(async (event) => {
			calls.push(event.id);
			return { transient: "ETIMEDOUT" };
		});
		c.set(6_000);
		await buffer.drain(async (event) => {
			calls.push(event.id);
			return "delivered";
		});
		expect(calls).toEqual([a.id, a.id, b.id]);
	});

	test("the tip a new event chains onto is the newest parked hash, and it clears once the session has landed", async () => {
		const c = clock();
		const buffer = new EventBuffer({ deadLetters: new DeadLetterStore(), now: c.now, random: c.random });
		const a = eventIn("s1", "a");
		const b = eventIn("s1", "b", a.hash);
		buffer.enqueue(a, "ETIMEDOUT", true);
		buffer.enqueue(b, "queued", false);
		expect(buffer.tipOf("s1")).toBe(b.hash);
		expect(buffer.tipOf("other")).toBeNull();

		c.set(2_000);
		await buffer.drain(async () => "delivered");
		expect(buffer.tipOf("s1")).toBeNull();
	});

	test("a held delivery (the ledger's breaker is open) stops the pass and spends no attempt", async () => {
		const c = clock();
		const deadLetters = new DeadLetterStore();
		const buffer = new EventBuffer({ deadLetters, now: c.now, random: c.random, maxAttempts: 2 });
		const a = eventIn("s1", "a");
		buffer.enqueue(a, "ETIMEDOUT", true);

		c.set(2_000);
		await buffer.drain(async () => "held");
		expect(buffer.size()).toBe(1);
		expect(deadLetters.depth()).toBe(0);

		// The held pass spent nothing, so this transient failure is the second attempt: with a budget of two it exhausts the event.
		c.set(2_000);
		await buffer.drain(failing());
		expect(buffer.size()).toBe(0);
		expect(deadLetters.list()).toEqual([expect.objectContaining({ id: a.id, cause: "exhausted", attempts: 2 })]);
	});
});

describe("EventBuffer: retry exhausted and bounds", () => {
	test("an event that spends its budget is dead-lettered with its hash, and its session's later events with it", async () => {
		const c = clock();
		const deadLetters = new DeadLetterStore();
		const buffer = new EventBuffer({ deadLetters, now: c.now, random: c.random, maxAttempts: 2 });
		const a = eventIn("s1", "a");
		const b = eventIn("s1", "b", a.hash);
		buffer.enqueue(a, "ETIMEDOUT", true);
		buffer.enqueue(b, "queued", false);

		const calls: string[] = [];
		c.set(2_000);
		await buffer.drain(async (event) => {
			calls.push(event.id);
			return { transient: "ECONNRESET" };
		});

		expect(calls).toEqual([a.id]);
		expect(buffer.size()).toBe(0);
		const records = deadLetters.list();
		expect(records.map((record) => record.cause)).toEqual(["exhausted", "chain-blocked"]);
		const exhausted = records[0] as DeadLetter;
		expect(exhausted.id).toBe(a.id);
		expect(exhausted.hash).toBe(a.hash);
		expect(exhausted.attempts).toBe(2);
		expect(exhausted.last_reason).toBe("ECONNRESET");
		expect(records[1]?.hash).toBe(b.hash);
		expect(buffer.tipOf("s1")).toBeNull();
	});

	test("a ceiling of one attempt dead-letters the live failure at once", () => {
		const deadLetters = new DeadLetterStore();
		const buffer = new EventBuffer({ deadLetters, maxAttempts: 1 });
		const a = eventIn("s1", "a");
		expect(buffer.enqueue(a, "ETIMEDOUT", true)).toBe("dead-lettered");
		expect(buffer.size()).toBe(0);
		expect(deadLetters.list()[0]).toMatchObject({ id: a.id, hash: a.hash, cause: "exhausted", attempts: 1 });
	});

	test("over the buffer bound a new event goes straight to the dead letters, and the parked events keep their place", () => {
		const deadLetters = new DeadLetterStore();
		const buffer = new EventBuffer({ deadLetters, max: 1 });
		const a = eventIn("s1", "a");
		const b = eventIn("s1", "b", a.hash);
		expect(buffer.enqueue(a, "ETIMEDOUT", true)).toBe("buffered");
		expect(buffer.enqueue(b, "queued", false)).toBe("dead-lettered");

		expect(buffer.size()).toBe(1);
		expect(buffer.tipOf("s1")).toBe(a.hash);
		expect(deadLetters.list()).toEqual([expect.objectContaining({ id: b.id, hash: b.hash, cause: "overflow", attempts: 0 })]);
	});

	test("the dead-letter store is bounded: the oldest record is evicted and the eviction is counted", () => {
		const deadLetters = new DeadLetterStore({ max: 2 });
		const events = [eventIn("s1", "1"), eventIn("s1", "2"), eventIn("s1", "3")];
		for (const event of events) {
			deadLetters.add({ id: event.id, hash: event.hash, session_id: event.session_id, cause: "exhausted", attempts: 1, last_reason: "x", dead_at: 0, event });
		}
		expect(deadLetters.depth()).toBe(2);
		expect(deadLetters.evicted()).toBe(1);
		expect(deadLetters.list().map((record) => record.id)).toEqual(events.slice(1).map((event) => event.id));
	});

	test("abandonAll moves every parked event to the dead letters as abandoned", () => {
		const deadLetters = new DeadLetterStore();
		const buffer = new EventBuffer({ deadLetters });
		const a = eventIn("s1", "a");
		const b = eventIn(null, "b");
		buffer.enqueue(a, "ETIMEDOUT", true);
		buffer.enqueue(b, "ETIMEDOUT", true);

		expect(buffer.abandonAll()).toBe(2);
		expect(buffer.size()).toBe(0);
		expect(deadLetters.list().map((record) => record.cause)).toEqual(["abandoned", "abandoned"]);
	});
});

describe("EventBuffer and DeadLetterStore on disk", () => {
	test("a file-backed buffer survives a restart with its order and chain tips, and the file is 0600", () => {
		const dir = scratch();
		const path = join(dir, "buffer.jsonl");
		const a = eventIn("s1", "a");
		const b = eventIn("s1", "b", a.hash);
		const first = new EventBuffer({ path, deadLetters: new DeadLetterStore() });
		first.enqueue(a, "ETIMEDOUT", true);
		first.enqueue(b, "queued", false);

		const second = new EventBuffer({ path, deadLetters: new DeadLetterStore() });
		expect(second.size()).toBe(2);
		expect(second.tipOf("s1")).toBe(b.hash);
		expect(second.durable).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("a malformed line is skipped and the entries around it survive a restart", () => {
		const dir = scratch();
		const path = join(dir, "buffer.jsonl");
		const a = eventIn("s1", "a");
		new EventBuffer({ path, deadLetters: new DeadLetterStore() }).enqueue(a, "ETIMEDOUT", true);
		const line = readFileSync(path, "utf8").trim();
		writeFileSync(path, `not json\n${line}\n`);

		expect(new EventBuffer({ path, deadLetters: new DeadLetterStore() }).size()).toBe(1);
	});

	test("a file-backed dead-letter store keeps its records, hash included, across a restart", () => {
		const dir = scratch();
		const path = join(dir, "dead.jsonl");
		const event = eventIn("s1", "a");
		new DeadLetterStore({ path }).add({ id: event.id, hash: event.hash, session_id: "s1", cause: "overflow", attempts: 0, last_reason: "x", dead_at: 1, event });

		const reopened = new DeadLetterStore({ path });
		expect(reopened.durable).toBe(true);
		expect(reopened.list()).toEqual([expect.objectContaining({ id: event.id, hash: event.hash, cause: "overflow" })]);
	});
});
