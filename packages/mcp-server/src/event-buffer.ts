/**
 * The ledger event buffer and dead-letter store (phase 76).
 *
 * A failed `agent_events` write used to return `stored: false` and nothing else. Now the event is parked
 * here, retried with exponential backoff (`outbox-file.ts`, the retain outbox's backoff and persistence),
 * and once its attempt budget is spent it is written to the dead-letter store together with its hash.
 * Nothing is dropped without a record: every event leaves this module either into the ledger or into the
 * dead-letter store, and each dead letter names its cause.
 *
 * Chain rule. An event's `prev` is the hash of its session's previous event, so a parked event can never
 * be overtaken by a later event of its session. While a session has a parked event, a new event of that
 * session is parked behind it with `prev` set to the parked tail's hash, and nothing for that session is
 * written directly. A parked event that exhausts its budget takes the session's later parked events with
 * it (`chain-blocked`): their `prev` names a row that will never exist. The session's next event then
 * chains from the ledger's own tip again. An overflow dead-letters only the event that did not fit: the
 * events parked before it are still valid, and the events after it chain onto them.
 *
 * Bounds. `SUBSTRATE_LEDGER_BUFFER_MAX` caps the parked events; a new event over the cap goes straight to
 * the dead-letter store with cause `overflow`. `SUBSTRATE_LEDGER_DEAD_LETTER_MAX` caps the dead letters;
 * over it the oldest record is evicted with a stderr line naming its id and hash, and the eviction count is
 * reported. Both paths are memory-only unless a file is configured, and `/healthz` says which.
 *
 * Events are parked whole, payload included: a parked event has to be written, and a dead letter has to be
 * recoverable by an operator. Both were normalised and redacted before they got here.
 */
import type { SubstrateEvent } from "./types.ts";
import { OutboxFile, outboxBackoffMs } from "./outbox-file.ts";

export const DEFAULT_EVENT_BUFFER_MAX = 1_000;
export const DEFAULT_EVENT_BUFFER_MAX_ATTEMPTS = 10;
export const DEFAULT_DEAD_LETTER_MAX = 10_000;
/** How often the drain looks for due entries. The backoff, not this, sets each event's pace. */
export const EVENT_DRAIN_TICK_MS = 1_000;
const EVENT_BACKOFF = { base: 2_000, cap: 300_000 };
/** The longest failure reason kept on a parked or dead-lettered event: enough to read, never a whole error dump. */
const REASON_MAX = 300;

/** One parked event. The event is whole: `prev` and `hash` are the values it was written with. */
export interface BufferedEvent {
	event: SubstrateEvent;
	/** Write attempts so far, the live one included; 0 for an event parked behind an earlier one that was never tried itself. */
	attempts: number;
	/** Epoch ms before which the drain leaves the entry alone. */
	next_at: number;
	last_reason: string;
	enqueued_at: number;
}

export type DeadLetterCause = "exhausted" | "overflow" | "chain-blocked" | "abandoned";

/** One event that never reached the ledger. `hash` is the event's own hash, so the record can be checked against the event it names. */
export interface DeadLetter {
	id: string;
	hash: string;
	session_id: string | null;
	cause: DeadLetterCause;
	attempts: number;
	last_reason: string;
	dead_at: number;
	event: SubstrateEvent;
}

/**
 * What one delivery attempt answered. `delivered`: the row and its ingest record are in the ledger.
 * `held`: the ledger's breaker is open, so the attempt was not made and spends nothing. `transient`: a
 * failure that spends one attempt, with the redacted reason.
 */
export type EventDelivery = "delivered" | "held" | { transient: string };

export type EnqueueOutcome = "buffered" | "dead-lettered";

export interface DeadLetterStoreOptions {
	path?: string | null;
	max?: number;
}

function isEventLike(value: unknown): value is SubstrateEvent {
	if (value === null || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return typeof row.id === "string" && typeof row.hash === "string" && (row.session_id === null || typeof row.session_id === "string");
}

const DEAD_LETTER_CAUSES: readonly string[] = ["exhausted", "overflow", "chain-blocked", "abandoned"];

function isBufferedEvent(value: unknown): value is BufferedEvent {
	if (value === null || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		isEventLike(row.event) &&
		typeof row.attempts === "number" &&
		typeof row.next_at === "number" &&
		typeof row.last_reason === "string" &&
		typeof row.enqueued_at === "number"
	);
}

function isDeadLetter(value: unknown): value is DeadLetter {
	if (value === null || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.id === "string" &&
		typeof row.hash === "string" &&
		(row.session_id === null || typeof row.session_id === "string") &&
		typeof row.cause === "string" &&
		DEAD_LETTER_CAUSES.includes(row.cause) &&
		typeof row.attempts === "number" &&
		typeof row.last_reason === "string" &&
		typeof row.dead_at === "number" &&
		isEventLike(row.event)
	);
}

function deadLetterOf(entry: BufferedEvent, cause: DeadLetterCause, at: number): DeadLetter {
	return {
		id: entry.event.id,
		hash: entry.event.hash,
		session_id: entry.event.session_id,
		cause,
		attempts: entry.attempts,
		last_reason: entry.last_reason,
		dead_at: at,
		event: entry.event,
	};
}

/**
 * The dead-letter store: records of events that never reached the ledger. Keyed by event id, which is
 * unique because an event is parked, and so dead-lettered, at most once. Not replayed by the substrate:
 * an operator reads it, and re-appending a record is a deliberate act.
 */
export class DeadLetterStore {
	private readonly file: OutboxFile<DeadLetter> | null;
	readonly max: number;
	/** Insertion order: the oldest record first. */
	private readonly records = new Map<string, DeadLetter>();
	private evictions = 0;

	constructor(options: DeadLetterStoreOptions = {}) {
		const path = options.path ?? null;
		this.max = Math.max(1, options.max ?? DEFAULT_DEAD_LETTER_MAX);
		this.file = path === null ? null : new OutboxFile<DeadLetter>({ path, label: "dead-letter store", isEntry: isDeadLetter, keyOf: (record) => record.id });
		const read = this.file?.read();
		if (read) for (const record of read.entries) this.records.set(record.id, record);
		while (this.records.size > this.max) this.evictOldest();
		if (read && this.evictions > 0) this.file?.rewrite(() => this.records.values());
	}

	/** Store one record. Over the bound the oldest is evicted, and the eviction is written to stderr with its id and hash. */
	add(record: DeadLetter): void {
		this.records.delete(record.id);
		this.records.set(record.id, record);
		let evicted = false;
		while (this.records.size > this.max) {
			this.evictOldest();
			evicted = true;
		}
		if (evicted) this.file?.rewrite(() => this.records.values());
		else this.file?.append(record, () => this.records.values());
	}

	depth(): number {
		return this.records.size;
	}

	/** Records dropped because the store was full. Each one was named on stderr when it went. */
	evicted(): number {
		return this.evictions;
	}

	/** True while every record is on disk; always false for the memory-only store. */
	get durable(): boolean {
		return this.file?.durable ?? false;
	}

	list(): DeadLetter[] {
		return [...this.records.values()];
	}

	private evictOldest(): void {
		const oldest = this.records.values().next().value;
		if (oldest === undefined) return;
		this.records.delete(oldest.id);
		this.evictions += 1;
		process.stderr.write(`[substrate] dead-letter store full (${this.max}): evicted ${oldest.id} (hash ${oldest.hash}, cause ${oldest.cause})\n`);
	}
}

export interface EventBufferOptions {
	/** JSONL file; null keeps the parked events in memory. */
	path?: string | null;
	max?: number;
	maxAttempts?: number;
	deadLetters: DeadLetterStore;
	now?: () => number;
	/** Uniform [0, 1); injected so the backoff schedule is testable. */
	random?: () => number;
}

export interface EventBufferStats {
	pending: number;
	max: number;
	/** ISO instant of the oldest parked event; null when empty. */
	oldestAt: string | null;
	durable: boolean;
}

export class EventBuffer {
	private readonly file: OutboxFile<BufferedEvent> | null;
	private readonly max: number;
	private readonly maxAttempts: number;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly deadLetters: DeadLetterStore;
	/** Insertion order is age order: the first key is the oldest parked event. Keyed by event id. */
	private readonly entries = new Map<string, BufferedEvent>();
	/**
	 * Per session: the hash of its newest parked event, and how many of its events are parked. Removal is
	 * always of a session's oldest event, or of all of them, so the tail is unchanged until the count
	 * reaches zero.
	 */
	private readonly tails = new Map<string, { hash: string; count: number }>();
	private draining: Promise<void> | null = null;

	constructor(options: EventBufferOptions) {
		const path = options.path ?? null;
		this.file = path === null ? null : new OutboxFile<BufferedEvent>({ path, label: "event buffer", isEntry: isBufferedEvent, keyOf: (entry) => entry.event.id });
		this.max = Math.max(1, options.max ?? DEFAULT_EVENT_BUFFER_MAX);
		this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_EVENT_BUFFER_MAX_ATTEMPTS);
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.deadLetters = options.deadLetters;
		// Hydrated without re-bounding: a lower bound applies to new events only, so no parked event is
		// dropped at boot and every chain stays whole.
		const read = this.file?.read();
		if (read) {
			for (const entry of read.entries) this.park(entry);
			this.file?.rewrite(() => this.entries.values());
		}
	}

	/** True only while every parked event is on disk; always false for the memory-only buffer. */
	get durable(): boolean {
		return this.file?.durable ?? false;
	}

	size(): number {
		return this.entries.size;
	}

	/** The hash a new event of this session must chain onto while the session has parked events; null when it has none. */
	tipOf(sessionId: string): string | null {
		return this.tails.get(sessionId)?.hash ?? null;
	}

	/** A parked event that `match` accepts, for a replay of a keyed event whose first attempt is still parked. */
	find(match: (event: SubstrateEvent) => boolean): SubstrateEvent | null {
		for (const entry of this.entries.values()) if (match(entry.event)) return entry.event;
		return null;
	}

	stats(): EventBufferStats {
		let oldest: number | null = null;
		for (const entry of this.entries.values()) if (oldest === null || entry.enqueued_at < oldest) oldest = entry.enqueued_at;
		return {
			pending: this.entries.size,
			max: this.max,
			oldestAt: oldest === null ? null : new Date(oldest).toISOString(),
			durable: this.durable,
		};
	}

	/**
	 * Park one event. `attempted` is true for the write that just failed, which spends the first attempt; a
	 * false event was parked behind an earlier one of its session and was never tried. Over the bound, or
	 * when the attempt ceiling is already reached, the event goes to the dead-letter store instead, with no
	 * effect on the events parked before it.
	 */
	enqueue(event: SubstrateEvent, reason: string, attempted: boolean): EnqueueOutcome {
		const at = this.now();
		const entry: BufferedEvent = {
			event,
			attempts: attempted ? 1 : 0,
			next_at: attempted ? at + outboxBackoffMs(0, EVENT_BACKOFF, this.random) : at,
			last_reason: reason.slice(0, REASON_MAX),
			enqueued_at: at,
		};
		if (this.entries.size >= this.max) {
			this.deadLetters.add(deadLetterOf(entry, "overflow", at));
			return "dead-lettered";
		}
		if (entry.attempts >= this.maxAttempts) {
			this.deadLetters.add(deadLetterOf(entry, "exhausted", at));
			return "dead-lettered";
		}
		this.park(entry);
		this.file?.append(entry, () => this.entries.values());
		return "buffered";
	}

	/**
	 * Retry due entries, one delivery at a time, in age order. Overlapping calls share one pass. `all`
	 * ignores the schedule (shutdown). A session with an entry that is not due, or that failed in this pass,
	 * is left alone for the rest of the pass, so a session's events are never delivered out of order.
	 */
	drain(deliver: (event: SubstrateEvent) => Promise<EventDelivery>, options: { all?: boolean } = {}): Promise<void> {
		if (this.draining) return this.draining;
		this.draining = this.runDrain(deliver, options.all === true, null).finally(() => {
			this.draining = null;
		});
		return this.draining;
	}

	/**
	 * The write path's settle (phase 76 chain rule): one delivery attempt for each parked event of one session, in chain order,
	 * before a write chains onto them. The schedule is not consulted: the write cannot chain past those events, so each gets its
	 * attempt now. The first event that does not land blocks the rest of the session, so one call spends at most one failing
	 * attempt per session. A pass already running is awaited first, so one event is never delivered by two passes at once.
	 */
	async drainSession(sessionId: string, deliver: (event: SubstrateEvent) => Promise<EventDelivery>): Promise<void> {
		while (this.draining) await this.draining;
		this.draining = this.runDrain(deliver, true, sessionId).finally(() => {
			this.draining = null;
		});
		return this.draining;
	}

	/** Shutdown of a memory-only buffer: every parked event goes to the dead-letter store as `abandoned`, so none vanishes with the process. */
	abandonAll(): number {
		const at = this.now();
		const dropped = [...this.entries.values()];
		this.entries.clear();
		this.tails.clear();
		for (const entry of dropped) this.deadLetters.add(deadLetterOf(entry, "abandoned", at));
		this.file?.rewrite(() => this.entries.values());
		return dropped.length;
	}

	private async runDrain(deliver: (event: SubstrateEvent) => Promise<EventDelivery>, all: boolean, only: string | null): Promise<void> {
		let changed = false;
		const blocked = new Set<string>();
		for (const entry of [...this.entries.values()]) {
			// Dead-lettered with its session, or abandoned, since the pass began: not ours anymore.
			if (this.entries.get(entry.event.id) !== entry) continue;
			const session = entry.event.session_id;
			if (only !== null && session !== only) continue;
			if (session !== null && blocked.has(session)) continue;
			if (!all && entry.next_at > this.now()) {
				if (session !== null) blocked.add(session);
				continue;
			}
			const outcome = await deliver(entry.event);
			if (this.entries.get(entry.event.id) !== entry) continue;
			if (outcome === "delivered") {
				this.remove(entry);
				changed = true;
				continue;
			}
			if (outcome === "held") {
				// The ledger's breaker is open: the rest would be refused the same way, and no attempt is spent.
				break;
			}
			changed = true;
			entry.attempts += 1;
			entry.last_reason = outcome.transient;
			if (session !== null) blocked.add(session);
			if (entry.attempts >= this.maxAttempts) {
				this.remove(entry);
				this.deadLetters.add(deadLetterOf(entry, "exhausted", this.now()));
				// Every parked event after this one in its session chains onto the row that will not exist.
				if (session !== null) this.deadLetterSession(session);
				continue;
			}
			entry.next_at = this.now() + outboxBackoffMs(entry.attempts - 1, EVENT_BACKOFF, this.random);
		}
		if (changed) this.file?.rewrite(() => this.entries.values());
	}

	/** Every event still parked for one session, all of them successors of the event that just exhausted. */
	private deadLetterSession(sessionId: string): void {
		const at = this.now();
		for (const entry of [...this.entries.values()]) {
			if (entry.event.session_id !== sessionId) continue;
			this.remove(entry);
			this.deadLetters.add(deadLetterOf(entry, "chain-blocked", at));
		}
	}

	private park(entry: BufferedEvent): void {
		this.entries.set(entry.event.id, entry);
		const sessionId = entry.event.session_id;
		if (sessionId === null) return;
		const tail = this.tails.get(sessionId);
		this.tails.set(sessionId, { hash: entry.event.hash, count: (tail?.count ?? 0) + 1 });
	}

	private remove(entry: BufferedEvent): void {
		this.entries.delete(entry.event.id);
		const sessionId = entry.event.session_id;
		if (sessionId === null) return;
		const tail = this.tails.get(sessionId);
		if (tail === undefined) return;
		if (tail.count <= 1) this.tails.delete(sessionId);
		else this.tails.set(sessionId, { hash: tail.hash, count: tail.count - 1 });
	}
}
