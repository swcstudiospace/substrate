/**
 * The telemetry buffer (phase 76): events the substrate could not write to the ledger, waiting to be retried.
 *
 * A failed write is not a dropped event. The entry waits with a backoff schedule, and the drain retries it until the
 * ledger takes it or its attempt budget is spent; a spent entry goes to the dead-letter store with its hash and reason.
 * The buffer itself is bounded (`SUBSTRATE_EVENT_BUFFER_MAX`). When it is full the oldest entry that is not being
 * delivered is given up, never discarded silently.
 *
 * Ordering. A session's events form a hash chain, so they are kept as one FIFO per session: an event waits behind the
 * buffered events of its session, and the drain only ever attempts the first of them. Each buffered event's `prev` is
 * fixed when it is queued, to the hash of the event ahead of it, and is never rewritten. Dropping an entry therefore
 * takes the entries after it in the same session with it (`predecessor-dead-lettered`): they could never chain. Sessionless
 * events have no chain and are each an independent entry.
 *
 * Persistence mirrors the retain outbox. With a path the buffer is an append-only 0600 JSONL file, rewritten compactly
 * after any change except a plain enqueue, and read back at boot. Without one it is process memory and `durable` reads
 * false, so the owner knows a shutdown must give its entries up with records instead of letting them vanish.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { parseStoredLine, StoredEvent } from "./event.ts";
import type { SubstrateEvent } from "./types.ts";
import type { DeadLetterReason } from "./event-dead-letter.ts";

export const DEFAULT_EVENT_BUFFER_MAX = 256;
export const DEFAULT_EVENT_BUFFER_MAX_ATTEMPTS = 10;
export const DEFAULT_EVENT_BUFFER_BACKOFF_MS = 1_000;
export const DEFAULT_EVENT_BUFFER_BACKOFF_CAP_MS = 60_000;
/** How often the drain looks for due entries while the buffer is not empty. */
export const EVENT_BUFFER_TICK_MS = 1_000;

/**
 * `base × 2^attempt`, capped at `capMs`, then ±20 % jitter so entries that failed together do not retry in lockstep.
 * `attempt` is zero-based: the first retry, after the live write, waits about `base`.
 */
export function eventBufferBackoffMs(attempt: number, baseMs: number, capMs: number, random: () => number = Math.random): number {
	const exponent = Math.max(0, Math.min(attempt, 30));
	const base = Math.min(baseMs * 2 ** exponent, capMs);
	return Math.round(base * (0.8 + 0.4 * random()));
}

/** One buffered event. `event` is final: its hash covers the `prev` it was queued onto. */
export const StoredEntry = z.object({
	event: StoredEvent,
	/** The `SUBSTRATE_EVENT_IDEMPOTENCY` key the caller sent, or null. */
	key: z.string().nullable(),
	/** Write attempts so far, the live one included; 0 for an event that waited behind another and never tried. */
	attempts: z.number(),
	/** Epoch ms before which the drain leaves the entry alone. */
	next_at: z.number(),
	last_reason: z.string(),
	enqueued_at: z.number(),
});
export type EventBufferEntry = z.infer<typeof StoredEntry>;

/** What one delivery attempt found: the event landed, or the attempt failed for a reason worth retrying. */
export type EventDelivery = "landed" | { transient: string };

export interface EventBufferStats {
	depth: number;
	max: number;
	/** ISO instant of the oldest entry; null when empty. */
	oldestAt: string | null;
	durable: boolean;
}

export interface EventBufferOptions {
	/** JSONL file; null keeps the buffer in memory. */
	path?: string | null;
	max?: number;
	maxAttempts?: number;
	backoffMs?: number;
	backoffCapMs?: number;
	now?: () => number;
	/** Uniform [0, 1); injected so the backoff schedule is testable. */
	random?: () => number;
	/** False while the ledger's breaker is open: a pass is skipped and no attempt is used. */
	allow?: () => boolean;
	/** Every entry given up, and why. The owner keeps the record. */
	onDeadLetter: (entry: EventBufferEntry, reason: DeadLetterReason) => void;
}

/** What `enqueue` needs. `build` runs after any eviction, so the link it writes names the entry that is really ahead of it. */
export interface EventEnqueue {
	/** The session the event chains into; null for a sessionless event. */
	session: string | null;
	key: string | null;
	/** The ledger's latest hash for the session: the `prev` used when nothing for the session is buffered. */
	ledgerPrev: string | null;
	build: (prev: string | null) => SubstrateEvent;
	last_reason: string;
	/** 1 for an event whose live write just failed; 0 for one that waits behind another and has not tried. */
	attempts: number;
}

/** `buffered` false means the event was given up at once, and `entry` is what would have been buffered. */
export type EnqueueOutcome = { buffered: true; entry: EventBufferEntry } | { buffered: false; entry: EventBufferEntry; reason: DeadLetterReason };

function reportTo(action: string, path: string, cause: unknown, reported: Set<string>): void {
	const code = (cause as NodeJS.ErrnoException | null)?.code ?? "EIO";
	if (reported.has(`${action}:${code}`)) return;
	reported.add(`${action}:${code}`);
	process.stderr.write(`[substrate] event buffer ${action} failed (${code}) at ${path}; the buffer continues in memory\n`);
}

export class EventBuffer {
	private readonly path: string | null;
	private readonly max: number;
	private readonly maxAttempts: number;
	private readonly backoffMs: number;
	private readonly backoffCapMs: number;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly allow: () => boolean;
	private readonly onDeadLetter: (entry: EventBufferEntry, reason: DeadLetterReason) => void;
	/** Insertion order is age order, and within one session it is chain order. */
	private readonly entries = new Map<string, EventBufferEntry>();
	/** The id of the entry a delivery is working on. No eviction takes it. */
	private flying: string | null = null;
	private draining: Promise<void> | null = null;
	/** True from a failed save until the next one that succeeds; `durable` is false meanwhile. */
	private unsaved = false;
	private readonly reported = new Set<string>();

	constructor(options: EventBufferOptions) {
		this.path = options.path ?? null;
		this.max = Math.max(1, options.max ?? DEFAULT_EVENT_BUFFER_MAX);
		this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_EVENT_BUFFER_MAX_ATTEMPTS);
		this.backoffMs = Math.max(1, options.backoffMs ?? DEFAULT_EVENT_BUFFER_BACKOFF_MS);
		this.backoffCapMs = Math.max(1, options.backoffCapMs ?? DEFAULT_EVENT_BUFFER_BACKOFF_CAP_MS);
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.allow = options.allow ?? (() => true);
		this.onDeadLetter = options.onDeadLetter;
		if (this.path !== null) this.hydrate(this.path);
	}

	/** True only while every entry is on disk. A configured path whose last save failed is not durable. */
	get durable(): boolean {
		return this.path !== null && !this.unsaved;
	}

	size(): number {
		return this.entries.size;
	}

	/** Whether any event of the session is waiting, so a new one must queue behind it. */
	hasSession(session: string | null): boolean {
		return this.tailOf(session) !== null;
	}

	/** The buffered entry a keyed replay names: same surface, same idempotency key. */
	findKeyed(surface: string, key: string): EventBufferEntry | null {
		for (const entry of this.entries.values()) {
			if (entry.key === key && entry.event.surface === surface) return entry;
		}
		return null;
	}

	stats(): EventBufferStats {
		let oldest: number | null = null;
		for (const entry of this.entries.values()) {
			if (oldest === null || entry.enqueued_at < oldest) oldest = entry.enqueued_at;
		}
		return { depth: this.entries.size, max: this.max, oldestAt: oldest === null ? null : new Date(oldest).toISOString(), durable: this.durable };
	}

	/** A snapshot in age order, for tests. */
	list(): EventBufferEntry[] {
		return [...this.entries.values()].map((entry) => ({ ...entry }));
	}

	/**
	 * Take one event that could not be written. Over the bound, the oldest entry that is not being delivered is given up
	 * first (with the entries after it in its session). When nothing can be given up, the new event is refused instead.
	 * An event whose live write was its last allowed attempt is given up at once, so the budget is honoured at every size.
	 */
	enqueue(request: EventEnqueue): EnqueueOutcome {
		const at = this.now();
		const exhaustedAtOnce = request.attempts > 0 && request.attempts >= this.maxAttempts;
		let evicted = false;
		while (!exhaustedAtOnce && this.entries.size >= this.max) {
			const victim = this.oldestEvictable();
			if (victim === null) break;
			this.dropFrom(victim, "overflow");
			evicted = true;
		}
		// Built only now: an eviction above may have removed this session's tail, and the link must name what is really ahead.
		const event = request.build(this.tailOf(request.session)?.event.hash ?? request.ledgerPrev);
		const entry: EventBufferEntry = {
			event,
			key: request.key,
			attempts: request.attempts,
			next_at: request.attempts === 0 ? at : at + eventBufferBackoffMs(request.attempts - 1, this.backoffMs, this.backoffCapMs, this.random),
			last_reason: request.last_reason,
			enqueued_at: at,
		};
		if (exhaustedAtOnce || this.entries.size >= this.max) {
			const reason: DeadLetterReason = exhaustedAtOnce ? "exhausted" : "buffer-full";
			this.onDeadLetter(entry, reason);
			if (evicted) this.compact();
			return { buffered: false, entry, reason };
		}
		this.entries.set(event.id, entry);
		if (evicted) this.compact();
		else this.append(entry);
		return { buffered: true, entry };
	}

	/**
	 * Replay the due entries, one delivery at a time, in age order. Overlapping calls share one pass. `all` ignores the
	 * schedule (shutdown and tests use it). A pass stops at its first transient failure: the ledger is probably down.
	 */
	drain(deliver: (entry: EventBufferEntry) => Promise<EventDelivery>, options: { all?: boolean } = {}): Promise<void> {
		if (this.draining) return this.draining;
		this.draining = this.runDrain(deliver, options.all === true).finally(() => {
			this.draining = null;
		});
		return this.draining;
	}

	/** Give every remaining entry up as `abandoned`. A memory-only buffer calls this at shutdown, so none vanishes unrecorded. */
	abandonAll(): number {
		const dropped = [...this.entries.values()];
		this.entries.clear();
		for (const entry of dropped) this.onDeadLetter(entry, "abandoned");
		return dropped.length;
	}

	private async runDrain(deliver: (entry: EventBufferEntry) => Promise<EventDelivery>, all: boolean): Promise<void> {
		if (!this.allow()) return;
		let changed = false;
		for (;;) {
			const entry = this.nextDue(all, this.now());
			if (entry === null || !this.allow()) break;
			this.flying = entry.event.id;
			let outcome: EventDelivery;
			try {
				outcome = await deliver(entry);
			} catch (cause) {
				outcome = { transient: `deliver-threw: ${(cause instanceof Error ? cause.message : String(cause)).slice(0, 120)}` };
			} finally {
				this.flying = null;
			}
			changed = true;
			if (outcome === "landed") {
				this.entries.delete(entry.event.id);
				continue;
			}
			entry.attempts += 1;
			entry.last_reason = outcome.transient;
			if (entry.attempts >= this.maxAttempts) {
				this.dropFrom(entry, "exhausted");
				continue;
			}
			entry.next_at = this.now() + eventBufferBackoffMs(entry.attempts - 1, this.backoffMs, this.backoffCapMs, this.random);
			break;
		}
		if (changed) this.compact();
	}

	/**
	 * The first entry a pass may attempt: in age order, the first entry of each session (the rest chain onto it) that is due.
	 * A session whose first entry is not due waits as a whole.
	 */
	private nextDue(all: boolean, at: number): EventBufferEntry | null {
		const seen = new Set<string>();
		for (const entry of this.entries.values()) {
			const session = entry.event.session_id;
			if (session !== null) {
				if (seen.has(session)) continue;
				seen.add(session);
			}
			if (all || entry.next_at <= at) return entry;
		}
		return null;
	}

	/** The oldest entry no delivery is working on; null when every entry is in flight. */
	private oldestEvictable(): EventBufferEntry | null {
		for (const entry of this.entries.values()) {
			if (entry.event.id !== this.flying) return entry;
		}
		return null;
	}

	/**
	 * Give up `victim` and every later entry of its session, which could never chain. The victim is the session's
	 * earliest buffered entry, and any delivery in flight is a session's earliest entry, so it is never among them.
	 */
	private dropFrom(victim: EventBufferEntry, reason: DeadLetterReason): void {
		const session = victim.event.session_id;
		const doomed: EventBufferEntry[] = [];
		let started = false;
		for (const entry of this.entries.values()) {
			if (entry === victim) started = true;
			if (started && (entry === victim || (session !== null && entry.event.session_id === session))) doomed.push(entry);
		}
		for (const entry of doomed) this.entries.delete(entry.event.id);
		for (const [index, entry] of doomed.entries()) {
			this.onDeadLetter(entry, index === 0 ? reason : "predecessor-dead-lettered");
		}
	}

	/** The session's last buffered entry, which the next event must chain onto; null for none, or for a sessionless event. */
	private tailOf(session: string | null): EventBufferEntry | null {
		if (session === null) return null;
		let tail: EventBufferEntry | null = null;
		for (const entry of this.entries.values()) {
			if (entry.event.session_id === session) tail = entry;
		}
		return tail;
	}

	/** Rebuild from the file: one line per event, last write wins, oldest first. A bound that shrank since the last boot gives up the oldest. */
	private hydrate(path: string): void {
		let body: string;
		try {
			if (!existsSync(path)) return;
			body = readFileSync(path, "utf8");
		} catch (cause) {
			reportTo("read", path, cause, this.reported);
			return;
		}
		let malformed = 0;
		for (const line of body.split("\n")) {
			if (line.trim().length === 0) continue;
			const entry = parseStoredLine(line, StoredEntry);
			if (entry === null) {
				malformed += 1;
				continue;
			}
			this.entries.delete(entry.event.id);
			this.entries.set(entry.event.id, entry);
		}
		if (malformed > 0) process.stderr.write(`[substrate] event buffer: skipped ${malformed} malformed line(s) in ${path}\n`);
		while (this.entries.size > this.max) {
			const oldest = this.entries.values().next().value;
			if (oldest === undefined) break;
			this.dropFrom(oldest, "overflow");
		}
		this.compact();
	}

	private append(entry: EventBufferEntry): void {
		if (this.path === null) return;
		// After a failed save a plain append would leave out what that save never wrote: rewrite the whole buffer instead.
		if (this.unsaved) {
			this.compact();
			return;
		}
		try {
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			const fresh = !existsSync(this.path);
			appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
			if (fresh) chmodSync(this.path, 0o600);
			this.unsaved = false;
		} catch (cause) {
			this.failedSave("append", cause);
		}
	}

	private compact(): void {
		if (this.path === null) return;
		try {
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			const tmp = `${this.path}.${process.pid}.tmp`;
			const lines = [...this.entries.values()].map((entry) => JSON.stringify(entry));
			writeFileSync(tmp, lines.length === 0 ? "" : `${lines.join("\n")}\n`, { mode: 0o600 });
			chmodSync(tmp, 0o600);
			renameSync(tmp, this.path);
			this.unsaved = false;
		} catch (cause) {
			this.failedSave("rewrite", cause);
		}
	}

	private failedSave(action: string, cause: unknown): void {
		this.unsaved = true;
		reportTo(action, this.path ?? "", cause, this.reported);
	}
}
