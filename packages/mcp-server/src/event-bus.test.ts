/**
 * The event bus with a fake pub/sub client, an injected clock and an injected
 * timer. No socket is opened and no real timer runs: `advance` fires the timers
 * that fall due, in order.
 */
import { describe, expect, test } from "bun:test";
import { EVENT_BUS_CHANNEL, MAX_HINT_BYTES, PUBLISH_DEADLINE_MS, RECONNECT_MAX_MS, createEventBus, type EventBusClient, type EventHint } from "./event-bus.ts";

const ENDPOINT = "fake-endpoint";
const HINT: EventHint = { v: 1, id: "evt-1", kind: "test.kind", surface: "test-surface", graph_id: null, ts: "2026-10-21T00:00:00.000Z" };
const SIX_KEYS = ["graph_id", "id", "kind", "surface", "ts", "v"];

interface PendingSubscription {
	onMessage: (message: string) => void;
	resolve: () => void;
	reject: (error: Error) => void;
}

class FakeClient implements EventBusClient {
	closed = false;
	publishError: Error | null = null;
	/** When set, publishes are held open until the test rejects them, or never. */
	holdPublishes = false;
	readonly heldPublishes: Array<{ reject: (error: Error) => void }> = [];
	readonly published: Array<{ channel: string; message: string }> = [];
	readonly subscriptions: PendingSubscription[] = [];

	publish(channel: string, message: string): Promise<unknown> {
		if (this.publishError !== null) return Promise.reject(this.publishError);
		this.published.push({ channel, message });
		if (this.holdPublishes) {
			return new Promise<unknown>((_resolve, reject) => {
				this.heldPublishes.push({ reject });
			});
		}
		return Promise.resolve(1);
	}

	subscribe(_channel: string, onMessage: (message: string) => void): Promise<unknown> {
		return new Promise<unknown>((resolve, reject) => {
			this.subscriptions.push({ onMessage, resolve: () => resolve("OK"), reject });
		});
	}

	close(): void {
		this.closed = true;
	}
}

interface FakeTimer {
	due: number;
	handler: () => void;
	done: boolean;
}

class FakeClock {
	ms = 1_000_000;
	readonly timers: FakeTimer[] = [];

	now = (): number => this.ms;

	setTimer = (handler: () => void, ms: number): (() => void) => {
		const timer: FakeTimer = { due: this.ms + ms, handler, done: false };
		this.timers.push(timer);
		return () => {
			timer.done = true;
		};
	};

	live(): number {
		return this.timers.filter((timer) => !timer.done).length;
	}

	advance(ms: number): void {
		const target = this.ms + ms;
		for (;;) {
			const next = this.timers.filter((timer) => !timer.done && timer.due <= target).sort((a, b) => a.due - b.due)[0];
			if (next === undefined) break;
			this.ms = next.due;
			next.done = true;
			next.handler();
		}
		this.ms = target;
	}
}

function harness() {
	const clock = new FakeClock();
	const clients: FakeClient[] = [];
	const urls: string[] = [];
	const logs: string[] = [];
	const bus = createEventBus({
		enabled: true,
		url: ENDPOINT,
		makeClient: (url) => {
			urls.push(url);
			const client = new FakeClient();
			clients.push(client);
			return client;
		},
		log: (line) => logs.push(line),
		now: clock.now,
		setTimer: clock.setTimer,
	});
	if (bus === null) throw new Error("expected a bus");
	return { bus, clock, clients, urls, logs };
}

function last<T>(items: T[]): T {
	const item = items[items.length - 1];
	if (item === undefined) throw new Error("expected an item");
	return item;
}

/** Lets promise reactions run. Microtasks only; no timers. */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("createEventBus returns null", () => {
	test("when the bus is off, whatever the URL, and creates no client", () => {
		const made: string[] = [];
		const bus = createEventBus({
			enabled: false,
			url: ENDPOINT,
			makeClient: (url) => {
				made.push(url);
				return new FakeClient();
			},
			log: () => {},
			now: () => 0,
			setTimer: () => () => {},
		});
		expect(bus).toBeNull();
		expect(made).toEqual([]);
	});

	test("when the URL is unset or blank", () => {
		for (const url of ["", "   "]) {
			const bus = createEventBus({ enabled: true, url, makeClient: () => new FakeClient(), log: () => {}, now: () => 0, setTimer: () => () => {} });
			expect(bus).toBeNull();
		}
	});
});

describe("publish", () => {
	test("returns true, sends the channel and a JSON hint with only the six fields", async () => {
		const { bus, clients, urls } = harness();
		const withText = { ...HINT, summary: "should not travel", payload: { secret: "x" } };

		expect(await bus.publish(withText)).toBe(true);

		expect(urls).toEqual([ENDPOINT]);
		expect(clients[0]?.published).toHaveLength(1);
		const sent = last(clients[0]?.published ?? []);
		expect(sent.channel).toBe(EVENT_BUS_CHANNEL);
		expect(sent.channel).toBe("substrate:v1:events");
		const parsed: Record<string, unknown> = JSON.parse(sent.message);
		expect(Object.keys(parsed).sort()).toEqual(SIX_KEYS);
		expect(parsed).toEqual({ ...HINT });
	});

	test("a publish error returns false, is counted, drops the publisher, and is logged once per failure run", async () => {
		const clients: FakeClient[] = [];
		const logs: string[] = [];
		let failing = false;
		const bus = createEventBus({
			enabled: true,
			url: ENDPOINT,
			makeClient: () => {
				const client = new FakeClient();
				client.publishError = failing ? new Error("connection refused") : null;
				clients.push(client);
				return client;
			},
			log: (line) => logs.push(line),
			now: () => 0,
			setTimer: () => () => {},
		});
		if (bus === null) throw new Error("expected a bus");

		expect(await bus.publish(HINT)).toBe(true);
		failing = true;
		last(clients).publishError = new Error("connection refused");
		expect(await bus.publish(HINT)).toBe(false);
		expect(clients[0]?.closed).toBe(true);
		expect(await bus.publish(HINT)).toBe(false);
		expect(clients).toHaveLength(2);
		expect(clients[1]?.closed).toBe(true);
		expect(bus.stats().publishFailures).toBe(2);
		expect(logs.filter((line) => line.includes("publish failed"))).toHaveLength(1);

		failing = false;
		expect(await bus.publish(HINT)).toBe(true);
		expect(clients).toHaveLength(3);
		expect(logs.filter((line) => line.includes("publish recovered"))).toHaveLength(1);
		expect(bus.stats().publishFailures).toBe(2);

		failing = true;
		last(clients).publishError = new Error("connection refused again");
		expect(await bus.publish(HINT)).toBe(false);
		expect(logs.filter((line) => line.includes("publish failed"))).toHaveLength(2);
		expect(bus.stats().publishFailures).toBe(3);
	});

	test("a client that cannot be made returns false and is counted, without throwing", async () => {
		const bus = createEventBus({
			enabled: true,
			url: ENDPOINT,
			makeClient: () => {
				throw new Error("no socket");
			},
			log: () => {},
			now: () => 0,
			setTimer: () => () => {},
		});
		if (bus === null) throw new Error("expected a bus");
		expect(await bus.publish(HINT)).toBe(false);
		expect(bus.stats().publishFailures).toBe(1);
	});

	test("an oversize hint is dropped and counted, and nothing is sent", async () => {
		const { bus, clients, logs } = harness();
		const base = JSON.stringify({ ...HINT, id: "" });
		const exact = { ...HINT, id: "x".repeat(MAX_HINT_BYTES - base.length) };
		const over = { ...HINT, id: "x".repeat(MAX_HINT_BYTES - base.length + 1) };

		expect(await bus.publish(exact)).toBe(true);
		expect(await bus.publish(over)).toBe(false);

		expect(clients[0]?.published).toHaveLength(1);
		expect(bus.stats().oversizeDropped).toBe(1);
		expect(bus.stats().publishFailures).toBe(0);
		expect(await bus.publish(over)).toBe(false);
		expect(logs.filter((line) => line.includes("hint dropped"))).toHaveLength(1);
		expect(await bus.publish(exact)).toBe(true);
		expect(await bus.publish(over)).toBe(false);
		expect(logs.filter((line) => line.includes("hint dropped"))).toHaveLength(2);
		expect(bus.stats()).toMatchObject({ published: 2, oversizeDropped: 3 });
	});

	test("a publish that never settles fails at its deadline, drops that client, and the next publish uses a new one", async () => {
		const clock = new FakeClock();
		const clients: FakeClient[] = [];
		const bus = createEventBus({
			enabled: true,
			url: ENDPOINT,
			makeClient: () => {
				const client = new FakeClient();
				client.holdPublishes = clients.length === 0;
				clients.push(client);
				return client;
			},
			log: () => {},
			now: clock.now,
			setTimer: clock.setTimer,
		});
		if (bus === null) throw new Error("expected a bus");

		const stuck = bus.publish(HINT);
		clock.advance(PUBLISH_DEADLINE_MS - 1);
		expect(clients[0]?.closed).toBe(false);
		clock.advance(1);
		expect(await stuck).toBe(false);
		expect(clients[0]?.closed).toBe(true);
		expect(bus.stats().publishFailures).toBe(1);

		expect(await bus.publish(HINT)).toBe(true);
		expect(clients).toHaveLength(2);
		expect(last(clients).published).toHaveLength(1);
	});

	test("a failure from a publisher that was already replaced leaves the replacement open", async () => {
		const clients: FakeClient[] = [];
		const bus = createEventBus({
			enabled: true,
			url: ENDPOINT,
			makeClient: () => {
				const client = new FakeClient();
				client.holdPublishes = clients.length === 0;
				clients.push(client);
				return client;
			},
			log: () => {},
			now: () => 0,
			setTimer: () => () => {},
		});
		if (bus === null) throw new Error("expected a bus");

		const first = bus.publish(HINT);
		const second = bus.publish(HINT);
		const old = last(clients);
		old.heldPublishes[0]?.reject(new Error("connection reset"));
		expect(await first).toBe(false);
		expect(old.closed).toBe(true);

		expect(await bus.publish(HINT)).toBe(true);
		expect(clients).toHaveLength(2);
		const replacement = last(clients);

		old.heldPublishes[1]?.reject(new Error("connection reset"));
		expect(await second).toBe(false);
		expect(replacement.closed).toBe(false);
		expect(await bus.publish(HINT)).toBe(true);
		expect(clients).toHaveLength(2);
	});
});

describe("subscribe", () => {
	test("the first listener opens one subscription on the channel, and a second listener reuses it", () => {
		const { bus, clients } = harness();
		bus.subscribe(() => {});
		bus.subscribe(() => {});

		expect(clients).toHaveLength(1);
		expect(clients[0]?.subscriptions).toHaveLength(1);
	});

	test("a listener receives a parsed hint with only the six fields", () => {
		const { bus, clients } = harness();
		const first: EventHint[] = [];
		const second: EventHint[] = [];
		bus.subscribe((hint) => first.push(hint));
		bus.subscribe((hint) => second.push(hint));

		const sub = last(last(clients).subscriptions);
		sub.onMessage(JSON.stringify({ ...HINT, summary: "dropped on receive" }));

		expect(first).toEqual([HINT]);
		expect(second).toEqual([HINT]);
		expect(Object.keys(first[0] ?? {}).sort()).toEqual(SIX_KEYS);
	});

	test("a throwing listener does not stop the others, and is logged", () => {
		const { bus, clients, logs } = harness();
		const received: EventHint[] = [];
		bus.subscribe(() => {
			throw new Error("listener bug");
		});
		bus.subscribe((hint) => received.push(hint));

		last(last(clients).subscriptions).onMessage(JSON.stringify(HINT));

		expect(received).toEqual([HINT]);
		expect(logs.some((line) => line.includes("listener failed"))).toBe(true);
	});

	test("malformed messages are ignored and counted, and a valid one after them still arrives", () => {
		const { bus, clients, logs } = harness();
		const received: EventHint[] = [];
		bus.subscribe((hint) => received.push(hint));
		const onMessage = last(last(clients).subscriptions).onMessage;

		const oversize = JSON.stringify({ ...HINT, id: "x".repeat(MAX_HINT_BYTES) });
		const malformed = [
			"{not json",
			"[]",
			JSON.stringify({ ...HINT, v: 2 }),
			JSON.stringify({ v: 1, id: "a", kind: "k", surface: "s", graph_id: null }),
			JSON.stringify({ ...HINT, graph_id: 7 }),
			oversize,
		];
		for (const message of malformed) onMessage(message);

		expect(received).toEqual([]);
		expect(bus.stats().malformedIgnored).toBe(malformed.length);
		expect(logs.filter((line) => line.includes("not a wake-up hint"))).toHaveLength(1);

		onMessage(JSON.stringify(HINT));
		expect(received).toEqual([HINT]);
		onMessage("{not json");
		expect(logs.filter((line) => line.includes("not a wake-up hint"))).toHaveLength(2);
	});

	test("unsubscribing stops delivery, and the last unsubscribe does not close the client", () => {
		const { bus, clients } = harness();
		const received: EventHint[] = [];
		const unsubscribe = bus.subscribe((hint) => received.push(hint));
		const client = last(clients);
		const onMessage = last(client.subscriptions).onMessage;

		unsubscribe();
		onMessage(JSON.stringify(HINT));

		expect(received).toEqual([]);
		expect(client.closed).toBe(false);
		expect(clients).toHaveLength(1);
	});

	test("a dropped subscription reconnects after the backoff and not before", async () => {
		const { bus, clients, clock, logs } = harness();
		bus.subscribe(() => {});
		last(last(clients).subscriptions).reject(new Error("connection closed"));
		await settle();

		expect(clients[0]?.closed).toBe(true);
		expect(bus.stats().subscriptionDrops).toBe(1);
		expect(clients).toHaveLength(1);

		clock.advance(999);
		expect(clients).toHaveLength(1);
		clock.advance(1);
		expect(clients).toHaveLength(2);
		expect(last(clients).subscriptions).toHaveLength(1);
		expect(logs.filter((line) => line.includes("subscription dropped"))).toHaveLength(1);
	});

	test("the backoff doubles from 1 s and caps at 30 s", async () => {
		const { bus, clients, clock } = harness();
		bus.subscribe(() => {});

		for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, RECONNECT_MAX_MS, RECONNECT_MAX_MS]) {
			const before = clients.length;
			last(last(clients).subscriptions).reject(new Error("dropped"));
			await settle();
			clock.advance(delay - 1);
			expect(clients).toHaveLength(before);
			clock.advance(1);
			expect(clients).toHaveLength(before + 1);
		}
	});

	test("a successful reconnect holds its subscription and opens no further clients", async () => {
		const { bus, clients, clock } = harness();
		bus.subscribe(() => {});
		last(last(clients).subscriptions).reject(new Error("dropped"));
		await settle();
		clock.advance(1_000);
		last(last(clients).subscriptions).reject(new Error("dropped again"));
		await settle();
		clock.advance(2_000);
		last(last(clients).subscriptions).resolve();
		await settle();

		const before = clients.length;
		clock.advance(10_000);
		expect(clients).toHaveLength(before);
	});

	test("a client that cannot be made counts as a drop and is retried after the backoff", async () => {
		let attempts = 0;
		const subscriptions: FakeClient[] = [];
		const clock = new FakeClock();
		const bus = createEventBus({
			enabled: true,
			url: ENDPOINT,
			makeClient: () => {
				attempts += 1;
				if (attempts === 1) throw new Error("no socket");
				const client = new FakeClient();
				subscriptions.push(client);
				return client;
			},
			log: () => {},
			now: clock.now,
			setTimer: clock.setTimer,
		});
		if (bus === null) throw new Error("expected a bus");

		expect(() => bus.subscribe(() => {})).not.toThrow();
		await settle();
		expect(bus.stats().subscriptionDrops).toBe(1);
		expect(attempts).toBe(1);
		clock.advance(999);
		expect(attempts).toBe(1);
		clock.advance(1);
		expect(attempts).toBe(2);
		expect(last(subscriptions).subscriptions).toHaveLength(1);
	});
});

describe("stop", () => {
	test("closes the publisher and the subscriber, and cancels a pending reconnect", async () => {
		const { bus, clients, clock } = harness();
		await bus.publish(HINT);
		bus.subscribe(() => {});
		expect(clients).toHaveLength(2);
		last(clients[1]?.subscriptions ?? []).reject(new Error("dropped"));
		await settle();
		expect(clock.live()).toBe(1);

		bus.stop();

		expect(clients[0]?.closed).toBe(true);
		expect(clients[1]?.closed).toBe(true);
		expect(clock.live()).toBe(0);
		clock.advance(RECONNECT_MAX_MS);
		expect(clients).toHaveLength(2);
	});

	test("after stop, publish returns false, subscribe connects nothing, and stop is idempotent", async () => {
		const { bus, clients } = harness();
		bus.stop();
		bus.stop();

		expect(await bus.publish(HINT)).toBe(false);
		const unsubscribe = bus.subscribe(() => {});
		expect(() => unsubscribe()).not.toThrow();
		expect(clients).toHaveLength(0);
		expect(bus.stats().publishFailures).toBe(0);
	});

	test("a subscription that rejects after stop does not reconnect", async () => {
		const { bus, clients, clock } = harness();
		bus.subscribe(() => {});
		bus.stop();
		last(last(clients).subscriptions).reject(new Error("late"));
		await settle();
		clock.advance(RECONNECT_MAX_MS);
		expect(clients).toHaveLength(1);
	});
});
