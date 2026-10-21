/**
 * The event bus (phase 50, D50-a to D50-i): Dragonfly pub/sub wake-up hints.
 *
 * A hint wakes a reader; it is never the event. It carries six fields and no
 * text. The ledger stays authoritative: `/events/stream` reads the ledger when a
 * hint arrives and still polls when none does, so a missed hint costs latency,
 * not data. `publish` is fail-open: it resolves to a boolean and never throws.
 * The pub/sub connections live here, not in `cache.ts`, so the cache's command
 * set stays closed by its conformance lock.
 */
import { z } from "zod";
import { REDACTED, redact } from "./redact.ts";

export const EVENT_BUS_CHANNEL = "substrate:v1:events";
/** A hint larger than this is dropped, never truncated (D50-h). Measured as UTF-8 bytes of the JSON message. */
export const MAX_HINT_BYTES = 1024;
/** Reconnect backoff: 1 s, doubling, capped at 30 s. A successful subscribe resets it (D50-h). */
export const RECONNECT_MIN_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
/** A publish that has not settled by then is a failure, and its publisher is dropped. */
export const PUBLISH_DEADLINE_MS = 2_000;

export interface EventHint {
	v: 1;
	id: string;
	kind: string;
	surface: string;
	graph_id: string | null;
	ts: string;
}

/** The Bun `RedisClient` in production; a fake in tests. */
export interface EventBusClient {
	publish(channel: string, message: string): Promise<unknown>;
	subscribe(channel: string, onMessage: (message: string) => void): Promise<unknown>;
	close(): void;
}

export interface EventBus {
	publish(hint: EventHint): Promise<boolean>;
	subscribe(listener: (hint: EventHint) => void): () => void;
	stop(): void;
	/** The bus's counters. Production's bus always keeps them; a fake that keeps none leaves this out. */
	stats?(): EventBusStats;
}

export interface EventBusStats {
	published: number;
	publishFailures: number;
	oversizeDropped: number;
	malformedIgnored: number;
	subscriptionDrops: number;
}

/** What `createEventBus` returns: the bus plus its counters. */
export interface MeasuredEventBus extends EventBus {
	stats(): EventBusStats;
}

export interface EventBusDeps {
	/** `SUBSTRATE_EVENT_BUS` is on. When it is off the bus is null, whatever the URL. */
	enabled: boolean;
	/** The cache endpoint (`DRAGONFLY_URL`), already accepted by the endpoint policy. Blank means unset. */
	url: string;
	makeClient: (url: string) => EventBusClient;
	log: (line: string) => void;
	now: () => number;
	/** Runs `handler` once after `ms`; returns a function that cancels it. */
	setTimer: (handler: () => void, ms: number) => () => void;
}

/** The hint as it crosses the wire. Unknown keys are stripped, so a received message cannot carry a summary or payload into a listener. */
const WireHint = z.object({
	v: z.literal(1),
	id: z.string(),
	kind: z.string(),
	surface: z.string(),
	graph_id: z.string().nullable(),
	ts: z.string(),
});

const encoder = new TextEncoder();

function describe(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return redact(text.replace(/\b(?:redis|rediss):\/\/\S+/gi, `redis://${REDACTED}`));
}

/** A received message as an `EventHint`, or null when it is not one. */
function parseHint(message: string): EventHint | null {
	if (encoder.encode(message).byteLength > MAX_HINT_BYTES) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(message);
	} catch {
		return null;
	}
	const hint = WireHint.safeParse(parsed);
	return hint.success ? hint.data : null;
}

interface ListenerEntry {
	listener: (hint: EventHint) => void;
}

class Bus implements MeasuredEventBus {
	private readonly listeners = new Set<ListenerEntry>();
	private readonly counts: EventBusStats = { published: 0, publishFailures: 0, oversizeDropped: 0, malformedIgnored: 0, subscriptionDrops: 0 };
	private publisher: EventBusClient | null = null;
	private subscriber: EventBusClient | null = null;
	/** Bumped on every connect; a callback from an older connection is ignored. */
	private generation = 0;
	private cancelReconnect: (() => void) | null = null;
	private retryMs = RECONNECT_MIN_MS;
	private publishDownSince: number | null = null;
	private subscribeDownSince: number | null = null;
	private stopped = false;
	/** True through a run of oversize publishes, so the run logs once. */
	private oversizeRunning = false;
	/** True through a run of malformed received messages, so the run logs once. */
	private malformedRunning = false;

	constructor(
		private readonly url: string,
		private readonly deps: EventBusDeps,
	) {}

	async publish(hint: EventHint): Promise<boolean> {
		if (this.stopped) return false;
		// Built from the six named fields, so a caller's extra keys never reach the wire.
		const message = JSON.stringify({ v: 1, id: hint.id, kind: hint.kind, surface: hint.surface, graph_id: hint.graph_id, ts: hint.ts });
		const bytes = encoder.encode(message).byteLength;
		if (bytes > MAX_HINT_BYTES) {
			this.counts.oversizeDropped += 1;
			if (!this.oversizeRunning) {
				this.oversizeRunning = true;
				this.deps.log(`[substrate] event bus hint dropped: ${bytes} bytes exceeds the ${MAX_HINT_BYTES}-byte limit\n`);
			}
			return false;
		}
		let client: EventBusClient | null = null;
		try {
			client = this.publisher ?? this.deps.makeClient(this.url);
			this.publisher = client;
			await this.publishWithDeadline(client, message);
		} catch (error) {
			if (this.stopped) return false;
			this.dropPublisher(client);
			this.publishFailed(error);
			return false;
		}
		this.counts.published += 1;
		this.oversizeRunning = false;
		this.publishRecovered();
		return true;
	}

	subscribe(listener: (hint: EventHint) => void): () => void {
		if (this.stopped) return () => {};
		const entry: ListenerEntry = { listener };
		this.listeners.add(entry);
		if (this.subscriber === null && this.cancelReconnect === null) this.connect();
		return () => {
			this.listeners.delete(entry);
		};
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.listeners.clear();
		this.cancelReconnect?.();
		this.cancelReconnect = null;
		this.closeSubscriber();
		this.closePublisher();
	}

	stats(): EventBusStats {
		return { ...this.counts };
	}

	private connect(): void {
		const generation = ++this.generation;
		let pending: Promise<unknown>;
		try {
			const client = this.deps.makeClient(this.url);
			this.subscriber = client;
			pending = client.subscribe(EVENT_BUS_CHANNEL, (message) => this.deliver(generation, message));
		} catch (error) {
			pending = Promise.reject(error);
		}
		pending.then(
			() => this.subscribed(generation),
			(error: unknown) => this.dropped(generation, error),
		);
	}

	private subscribed(generation: number): void {
		if (this.stopped || generation !== this.generation) return;
		this.retryMs = RECONNECT_MIN_MS;
		if (this.subscribeDownSince === null) return;
		const downMs = this.deps.now() - this.subscribeDownSince;
		this.subscribeDownSince = null;
		this.deps.log(`[substrate] event bus subscription restored after ${downMs} ms\n`);
	}

	private dropped(generation: number, error: unknown): void {
		if (this.stopped || generation !== this.generation) return;
		this.counts.subscriptionDrops += 1;
		this.closeSubscriber();
		if (this.subscribeDownSince === null) {
			this.subscribeDownSince = this.deps.now();
			this.deps.log(`[substrate] event bus subscription dropped: ${describe(error)}; reconnecting\n`);
		}
		const delayMs = this.retryMs;
		this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
		this.cancelReconnect = this.deps.setTimer(() => {
			this.cancelReconnect = null;
			this.connect();
		}, delayMs);
	}

	private deliver(generation: number, message: string): void {
		if (this.stopped || generation !== this.generation) return;
		const hint = parseHint(message);
		if (hint === null) {
			this.counts.malformedIgnored += 1;
			if (!this.malformedRunning) {
				this.malformedRunning = true;
				this.deps.log("[substrate] event bus message ignored: not a wake-up hint\n");
			}
			return;
		}
		this.malformedRunning = false;
		for (const entry of [...this.listeners]) {
			try {
				entry.listener(hint);
			} catch (error) {
				this.deps.log(`[substrate] event bus listener failed: ${describe(error)}\n`);
			}
		}
	}

	private publishFailed(error: unknown): void {
		this.counts.publishFailures += 1;
		if (this.publishDownSince !== null) return;
		this.publishDownSince = this.deps.now();
		this.deps.log(`[substrate] event bus publish failed: ${describe(error)}\n`);
	}

	private publishRecovered(): void {
		if (this.publishDownSince === null) return;
		const downMs = this.deps.now() - this.publishDownSince;
		this.publishDownSince = null;
		this.deps.log(`[substrate] event bus publish recovered after ${downMs} ms\n`);
	}

	/** One publish, rejected at `PUBLISH_DEADLINE_MS` if the client has not settled it, so commands cannot queue behind a silent connection. */
	private async publishWithDeadline(client: EventBusClient, message: string): Promise<void> {
		let cancel = (): void => {};
		const deadline = new Promise<never>((_, reject) => {
			cancel = this.deps.setTimer(() => reject(new Error(`publish did not settle within ${PUBLISH_DEADLINE_MS} ms`)), PUBLISH_DEADLINE_MS);
		});
		try {
			await Promise.race([client.publish(EVENT_BUS_CHANNEL, message), deadline]);
		} finally {
			cancel();
		}
	}

	/** Drops `failed` only while it is still the publisher. A client replaced since was closed at replacement, so the replacement stays open. */
	private dropPublisher(failed: EventBusClient | null): void {
		if (failed !== null && this.publisher === failed) this.closePublisher();
	}

	private closeSubscriber(): void {
		const client = this.subscriber;
		this.subscriber = null;
		this.closeClient(client, "subscriber");
	}

	private closePublisher(): void {
		const client = this.publisher;
		this.publisher = null;
		this.closeClient(client, "publisher");
	}

	private closeClient(client: EventBusClient | null, role: string): void {
		try {
			client?.close();
		} catch (error) {
			this.deps.log(`[substrate] event bus ${role} close failed: ${describe(error)}\n`);
		}
	}
}

/**
 * The bus, or null when `SUBSTRATE_EVENT_BUS` is off or the URL is blank. Nothing
 * connects until the first `publish` or `subscribe`. Every failure is counted and
 * logged, never thrown: the caller's emit or stream does not depend on the bus.
 */
export function createEventBus(deps: EventBusDeps): MeasuredEventBus | null {
	const url = deps.url.trim();
	if (!deps.enabled || url === "") return null;
	return new Bus(url, deps);
}
