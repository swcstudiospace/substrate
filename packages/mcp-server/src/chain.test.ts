import { describe, expect, test } from "bun:test";
import { type ChainStore, IngestChain } from "./chain.ts";
import { eventHash, InvalidEventError, normalizeEvent } from "./event.ts";
import type { ChainHead, EventKey } from "./greptime.ts";
import type { EventInput, SubstrateEvent } from "./types.ts";

const T0 = Date.parse("2026-09-27T12:00:00.000Z");

/** A stored event as Greptime answers it: epoch-ms timestamps, payload as JSON text, NULL ingested_at. */
function toRow(event: SubstrateEvent): Record<string, unknown> {
	return {
		...event,
		ts: Date.parse(event.ts),
		payload: JSON.stringify(event.payload),
		ingested_at: event.ingested_at === undefined ? null : Date.parse(event.ingested_at),
	};
}

/**
 * Virtual time for the latency test: timers fire in order when the test runs the clock, so the
 * bound is exact under any machine load and nothing waits in real time.
 */
class VirtualClock {
	now = 0;
	private readonly timers: Array<{ at: number; fire: () => void }> = [];

	sleep(ms: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.timers.push({ at: this.now + ms, fire: resolve });
		return promise;
	}

	/** Fire every timer due by `until` in time order, letting the code under test react between them. */
	async run(until = Number.POSITIVE_INFINITY): Promise<void> {
		for (;;) {
			// Drain every pending continuation (microtasks run before the next macrotask) before looking for a timer.
			const flushed = Promise.withResolvers<void>();
			setImmediate(flushed.resolve);
			await flushed.promise;
			this.timers.sort((a, b) => a.at - b.at);
			const next = this.timers[0];
			if (!next || next.at > until) break;
			this.timers.shift();
			this.now = next.at;
			next.fire();
		}
		if (Number.isFinite(until)) this.now = Math.max(this.now, until);
	}
}

/** In-memory ChainStore: rows persist across calls; failures are armed one call at a time. */
class MemoryStore implements ChainStore {
	rows: SubstrateEvent[] = [];
	inserts: SubstrateEvent[][] = [];
	keyQueries: EventKey[][] = [];
	headCalls = 0;
	/** Latency of one insert (a Greptime round trip); none by default. */
	insertLatency: (() => Promise<void>) | null = null;
	headError: Error | null = null;
	insertError: { error: Error; landed: boolean } | null = null;

	constructor(head?: SubstrateEvent) {
		if (head) this.rows.push(head);
	}

	async chainHead(): Promise<ChainHead | null> {
		this.headCalls++;
		if (this.headError) {
			const error = this.headError;
			this.headError = null;
			throw error;
		}
		const chained = this.rows.filter((row) => row.ingested_at !== undefined);
		const latest = chained.sort((a, b) => Date.parse(b.ingested_at!) - Date.parse(a.ingested_at!))[0];
		return latest ? { hash: latest.hash, ingestedAtMs: Date.parse(latest.ingested_at!) } : null;
	}

	async insertEvents(events: readonly SubstrateEvent[]): Promise<void> {
		this.inserts.push([...events]);
		if (this.insertLatency) await this.insertLatency();
		const failure = this.insertError;
		this.insertError = null;
		if (!failure || failure.landed) this.rows.push(...events);
		if (failure) throw failure.error;
	}

	async eventsAtKeys(keys: readonly EventKey[]): Promise<Array<Record<string, unknown>>> {
		this.keyQueries.push([...keys]);
		return this.rows
			.filter((row) =>
				keys.some(
					(key) =>
						row.surface === key.surface &&
						row.repo === key.repo &&
						row.graph_id === key.graph_id &&
						row.kind === key.kind &&
						Date.parse(row.ts) === key.tsMs,
				),
			)
			.map(toRow);
	}
}

const input: EventInput = { surface: "herdr", kind: "tool.call", summary: "ran cargo test", session_id: "s1", repo: "r" };

/** A post-cutover event already in the store, ingested at `ms`. */
function storedHead(ms: number): SubstrateEvent {
	return normalizeEvent({ ...input, summary: "earlier" }, null, new Date(ms).toISOString());
}

function expectChained(events: SubstrateEvent[], firstPrev: string | null): void {
	expect(events[0]!.prev).toBe(firstPrev);
	for (let i = 1; i < events.length; i++) {
		expect(events[i]!.prev).toBe(events[i - 1]!.hash);
		expect(Date.parse(events[i]!.ingested_at!)).toBeGreaterThan(Date.parse(events[i - 1]!.ingested_at!));
	}
	for (const event of events) {
		const { hash, ...rest } = event;
		expect(eventHash(rest)).toBe(hash);
	}
}

describe("IngestChain batching and latency", () => {
	test("batches queued emits into one insert", async () => {
		const head = storedHead(T0);
		const store = new MemoryStore(head);
		const chain = new IngestChain(store, { now: () => T0 + 1_000 });
		const events = await Promise.all(
			Array.from({ length: 50 }, (_, i) => chain.append({ ...input, session_id: `s${i % 4}`, summary: `event ${i}` })),
		);
		expect(events).toHaveLength(50);
		expect(store.inserts.length).toBeLessThanOrEqual(2);
		expect(store.inserts.flat().map((e) => e.id)).toEqual(events.map((e) => e.id));
		expect(events.map((e) => e.summary)).toEqual(Array.from({ length: 50 }, (_, i) => `event ${i}`));
		expectChained(events, head.hash);
		expect(chain.state()).toBe("seeded");
	});

	test("stays under the hook budget", async () => {
		const clock = new VirtualClock();
		const store = new MemoryStore(storedHead(T0));
		store.insertLatency = () => clock.sleep(100);
		const chain = new IngestChain(store, { now: () => T0 + 1 + clock.now });
		await chain.seed();
		const resolvedAt: number[] = [];
		const emit = (i: number) =>
			chain.append({ ...input, summary: `burst ${i}` }).then((event) => {
				resolvedAt.push(clock.now);
				return event;
			});
		const first = emit(0);
		// The rest of the burst arrives while the first insert is in flight: the worst case, two turns.
		await clock.run(20);
		expect(store.inserts).toHaveLength(1);
		const rest = [1, 2, 3, 4, 5, 6].map(emit);
		await clock.run();
		const events = await Promise.all([first, ...rest]);
		expect(events).toHaveLength(7);
		// 7 concurrent emits resolve within two inserts' time plus 150 ms of the first call (1.5 s hook timeout).
		expect(Math.max(...resolvedAt)).toBeLessThan(350);
		expect(Math.max(...resolvedAt)).toBe(200);
		expect(store.inserts.map((batch) => batch.length)).toEqual([1, 6]);
		expectChained(events, store.rows[0]!.hash);
	});
});

describe("IngestChain ingest time and ts", () => {
	test("ts equals ingested_at without a client ts; a client ts is kept", async () => {
		const store = new MemoryStore();
		let clock = T0;
		const chain = new IngestChain(store, { now: () => clock });
		const server = await chain.append(input);
		expect(server.ingested_at).toBe(new Date(T0).toISOString());
		expect(server.ts).toBe(server.ingested_at!);
		clock = T0 + 50;
		const client = await chain.append({ ...input, ts: "2026-09-01T08:00:00.000Z" });
		expect(client.ts).toBe("2026-09-01T08:00:00.000Z");
		expect(client.ingested_at).toBe(new Date(T0 + 50).toISOString());
	});

	test("a clock that goes backwards still yields head + 1 ms", async () => {
		const store = new MemoryStore(storedHead(T0 + 10_000));
		let clock = T0 + 5_000;
		const chain = new IngestChain(store, { now: () => clock-- });
		const [a, b] = await Promise.all([chain.append(input), chain.append(input)]);
		expect(a!.ingested_at).toBe(new Date(T0 + 10_001).toISOString());
		expect(b!.ingested_at).toBe(new Date(T0 + 10_002).toISOString());
		const c = await chain.append(input);
		expect(c.ingested_at).toBe(new Date(T0 + 10_003).toISOString());
	});
});

describe("IngestChain head", () => {
	test("genesis: no post-cutover row means the first event's prev is null", async () => {
		const legacy = normalizeEvent(input, null); // a pre-cutover row: no ingested_at
		const store = new MemoryStore(legacy);
		const chain = new IngestChain(store, { now: () => T0 });
		expect(await chain.seed()).toBe("genesis");
		expect(chain.state()).toBe("genesis");
		const [first, second] = await Promise.all([chain.append(input), chain.append(input)]);
		expect(first!.prev).toBeNull();
		expect(second!.prev).toBe(first!.hash);
		expect(chain.state()).toBe("seeded");
		expect(await new IngestChain(store).seed()).toBe("seeded");
	});

	test("a chainHead that throws rejects the whole batch; the next append re-seeds", async () => {
		const head = storedHead(T0);
		const store = new MemoryStore(head);
		store.headError = new Error("greptime unreachable");
		const chain = new IngestChain(store, { now: () => T0 + 1 });
		const results = await Promise.allSettled([chain.append(input), chain.append(input)]);
		expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
		expect(chain.state()).toBe("unknown");
		expect(store.inserts).toHaveLength(0);

		const next = await chain.append(input);
		expect(next.prev).toBe(head.hash);
		expect(store.headCalls).toBe(2);
		expect(chain.state()).toBe("seeded");
	});

	test("an insert that throws rejects every waiter and re-seeds from what persisted", async () => {
		for (const landed of [true, false]) {
			const head = storedHead(T0);
			const store = new MemoryStore(head);
			const chain = new IngestChain(store, { now: () => T0 + 100 });
			await chain.seed();
			store.insertError = { error: new Error("greptime timed out"), landed };
			const results = await Promise.allSettled([chain.append(input), chain.append(input)]);
			expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
			expect(chain.state()).toBe("unknown");

			const next = await chain.append(input);
			const persistedHead = landed ? store.inserts[0]![1]! : head;
			expect(next.prev).toBe(persistedHead.hash);
			expect(Date.parse(next.ingested_at!)).toBeGreaterThan(Date.parse(persistedHead.ingested_at!));
			expect(chain.state()).toBe("seeded");
		}
	});

	test("an invalid input rejects alone; the rest is written and the head skips it", async () => {
		const head = storedHead(T0);
		const store = new MemoryStore(head);
		const chain = new IngestChain(store, { now: () => T0 + 1 });
		const results = await Promise.allSettled([
			chain.append({ ...input, summary: "first" }),
			chain.append({ ...input, kind: "nope" as never }),
			chain.append({ ...input, summary: "third" }),
		]);
		expect(results[1]!.status).toBe("rejected");
		expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(InvalidEventError);
		const written = store.inserts.flat();
		expect(store.inserts).toHaveLength(1);
		expect(written.map((e) => e.summary)).toEqual(["first", "third"]);
		expectChained(written, head.hash);
	});
});

describe("IngestChain client-ts guard", () => {
	const TS = "2026-09-20T10:00:00.000Z";
	const grok: EventInput = { surface: "grok-build", kind: "tool.call", summary: "ran ls", session_id: "g1", ts: TS };

	test("a replay of a stored row returns the stored event without an insert", async () => {
		// repo and graph_id are null: the key match must be NULL-safe.
		const original = normalizeEvent(grok, null);
		const store = new MemoryStore(original);
		const chain = new IngestChain(store, { now: () => T0 });
		expect(await chain.seed()).toBe("genesis");
		const replayed = await chain.append(grok);
		expect(replayed.id).toBe(original.id);
		expect(replayed.hash).toBe(original.hash);
		expect(store.inserts).toHaveLength(0);
		expect(chain.state()).toBe("genesis");
		expect(store.keyQueries).toEqual([[{ surface: "grok-build", repo: null, graph_id: null, kind: "tool.call", tsMs: Date.parse(TS) }]]);
	});

	test("different content on the stored key moves ts by 1 ms and checks again", async () => {
		const store = new MemoryStore(normalizeEvent({ ...grok, summary: "ran pwd" }, null));
		const chain = new IngestChain(store, { now: () => T0 });
		const moved = await chain.append(grok);
		expect(moved.ts).toBe(new Date(Date.parse(TS) + 1).toISOString());
		expect(store.keyQueries.map((keys) => keys.map((k) => k.tsMs))).toEqual([[Date.parse(TS)], [Date.parse(TS) + 1]]);
		expect(store.inserts.flat().map((e) => e.id)).toEqual([moved.id]);
	});

	test("two inputs of one batch on one key: the second is moved", async () => {
		const store = new MemoryStore();
		const chain = new IngestChain(store, { now: () => T0 });
		const [a, b] = await Promise.all([chain.append(grok), chain.append({ ...grok, summary: "ran cat" })]);
		expect(a!.ts).toBe(TS);
		expect(b!.ts).toBe(new Date(Date.parse(TS) + 1).toISOString());
		expect(store.inserts).toHaveLength(1);
	});

	test("a server-timed event steps past a key a client ts took in the same batch", async () => {
		const store = new MemoryStore();
		const chain = new IngestChain(store, { now: () => Date.parse(TS) });
		const [client, server] = await Promise.all([chain.append(grok), chain.append({ ...grok, ts: undefined })]);
		expect(client!.ts).toBe(TS);
		expect(server!.ts).toBe(new Date(Date.parse(TS) + 1).toISOString());
		expect(server!.ingested_at).toBe(server!.ts);
	});

	test("after 5 moves the input is rejected alone", async () => {
		const store = new MemoryStore();
		for (let i = 0; i <= 5; i++) {
			store.rows.push(
				normalizeEvent({ ...grok, summary: `other ${i}`, ts: new Date(Date.parse(TS) + i).toISOString() }, null),
			);
		}
		const chain = new IngestChain(store, { now: () => T0 });
		const [collided, other] = await Promise.allSettled([chain.append(grok), chain.append({ ...input, summary: "fine" })]);
		expect(collided.status).toBe("rejected");
		expect(String((collided as PromiseRejectedResult).reason)).toContain("5 times");
		expect(other.status).toBe("fulfilled");
		expect(store.keyQueries).toHaveLength(6);
		expect(store.inserts.flat().map((e) => e.summary)).toEqual(["fine"]);
	});

	test("a batch of only server-timed inputs never calls eventsAtKeys", async () => {
		const store = new MemoryStore();
		const chain = new IngestChain(store, { now: () => T0 });
		await Promise.all([chain.append(input), chain.append({ ...input, surface: "muse" }), chain.append(input)]);
		expect(store.keyQueries).toHaveLength(0);
		expect(store.inserts.flat()).toHaveLength(3);
	});
});
