/**
 * The telemetry buffer (phase 76): events the substrate could not write to the ledger, waiting to be retried.
 *
 * A failed write is not a dropped event. The entry waits with a backoff schedule, and the drain retries it until the
 * ledger takes it or its attempt budget is spent; a spent entry goes to the dead-letter store with its hash and reason.
 * The buffer itself is bounded (`SUBSTRATE_EVENT_BUFFER_MAX`). When it is full the oldest entry that is not being
 * delivered is given up, never discarded silently.
 * A give-up is final only once its dead-letter record is on disk. While the store cannot write it, the entry stays in the file as
 * pending (`given_up`): it is never attempted and it holds its place in the bound. Pending entries are written to the store as soon
 * as it takes them, each once; a full buffer of them refuses the next event rather than give one up.
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
import { DEAD_LETTER_REASONS, type DeadLetterReason } from "./event-dead-letter.ts";

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
	/**
	 * Why the entry was given up while its dead-letter record is not yet on disk. Such an entry stays in the file, is never attempted,
	 * and is removed once the record is written. Null for a live entry; absent in files written before this field existed.
	 */
	given_up: z.enum(DEAD_LETTER_REASONS).nullish(),
});
export type EventBufferEntry = z.infer<typeof StoredEntry>;

/**
 * What one delivery attempt found. `landed`: the event is in the ledger. `skipped`: the attempt was never sent, because the ledger's
 * breaker refused it; it is not an attempt and spends nothing, so the pass ends and the entry waits for the next one. `transient`:
 * the write failed for a reason worth retrying.
 */
export type EventDelivery = "landed" | "skipped" | { transient: string };

export interface EventBufferStats {
	depth: number;
	max: number;
	/** ISO instant of the oldest entry; null when empty. */
	oldestAt: string | null;
	durable: boolean;
	/** Entries given up whose dead-letter record is not yet on disk. They stay in the file and are never attempted. */
	pending: number;
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
	/**
	 * Keeps the record of an entry given up, and why. Returns true when the record is on disk. False leaves the entry in the buffer
	 * file as pending: it is not removed until the store reports its record written (see `flushDeadLetters`).
	 */
	onDeadLetter: (entry: EventBufferEntry, reason: DeadLetterReason) => boolean;
	/** Writes the records the store still holds. Returns true when every record is on disk. Spends no attempt. Defaults to true. */
	flushDeadLetters?: () => boolean;
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

/**
 * `buffered` false means the event was not queued. `recorded` true: it was given up at once, and `entry` is its dead-letter record.
 * `recorded` false: it was refused, because the buffer is full of entries it cannot give up and no record could be written; nothing
 * was recorded, so the caller must keep its copy.
 */
export type EnqueueOutcome =
	| { buffered: true; entry: EventBufferEntry }
	| { buffered: false; entry: EventBufferEntry; reason: DeadLetterReason; recorded: boolean };

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
	private readonly onDeadLetter: (entry: EventBufferEntry, reason: DeadLetterReason) => boolean;
	private readonly flushDeadLetters: () => boolean;
	/** Ids of the pending entries whose record this process has already handed to the store, so none is recorded twice. */
	private readonly recordedIds = new Set<string>();
	/** Insertion order is age order, and within one session it is chain order. */
	private readonly entries = new Map<string, EventBufferEntry>();
	/** The id of the entry a delivery is working on. No eviction takes it. */
	private flying: string | null = null;
	private draining: Promise<void> | null = null;
	/** True from a failed save until the next one that succeeds; `durable` is false meanwhile. */
	private unsaved = false;
	private readonly reported = new Set<string>();
	/** Set when the file exists but could not be read at boot. It holds a backlog this process has not seen, so it is never rewritten. */
	private unreadable = false;

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
		this.flushDeadLetters = options.flushDeadLetters ?? (() => true);
		if (this.path !== null) this.hydrate(this.path);
	}

	/** True only while every entry is on disk. A configured path whose last save failed, or whose file could not be read, is not durable. */
	get durable(): boolean {
		return this.path !== null && !this.unsaved && !this.unreadable;
	}

	size(): number {
		return this.entries.size;
	}

	/** Whether any event of the session is waiting, so a new one must queue behind it. */
	hasSession(session: string | null): boolean {
		return this.tailOf(session) !== null;
	}

	/**
	 * The buffered entry a keyed replay names: the same idempotency key in the same cell as the replay, the cell being the columns a
	 * ledger lookup keys on (`surface`, `repo`, `graph_id`, `kind`). A different event that reuses the key is another event. `ts` is
	 * not compared: a keyed resend that carries no timestamp of its own must still find the event it resends.
	 */
	findKeyed(cell: Pick<SubstrateEvent, "surface" | "repo" | "graph_id" | "kind">, key: string): EventBufferEntry | null {
		for (const entry of this.entries.values()) {
			const event = entry.event;
			if (entry.key === key && event.surface === cell.surface && event.repo === cell.repo && event.graph_id === cell.graph_id && event.kind === cell.kind) {
				return entry;
			}
		}
		return null;
	}

	stats(): EventBufferStats {
		let oldest: number | null = null;
		let pending = 0;
		for (const entry of this.entries.values()) {
			if (entry.given_up != null) pending += 1;
			if (oldest === null || entry.enqueued_at < oldest) oldest = entry.enqueued_at;
		}
		return { depth: this.entries.size, max: this.max, oldestAt: oldest === null ? null : new Date(oldest).toISOString(), durable: this.durable, pending };
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
			evicted = true;
			// A victim whose record the store could not take stays in the buffer, so it frees no room: stop rather than give up more.
			if (!this.dropFrom(victim, "overflow")) break;
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
			// A give-up needs its record on disk first. While the store cannot take one, nothing is given up: the event is refused
			// and the caller keeps its copy.
			if (!this.flushDeadLetters()) {
				if (evicted) this.compact();
				return { buffered: false, entry, reason, recorded: false };
			}
			const onDisk = this.onDeadLetter(entry, reason);
			if (onDisk) {
				if (evicted) this.compact();
				return { buffered: false, entry, reason, recorded: true };
			}
			// The store holds the record in memory but could not write it. With room, the event is written ahead in the buffer file as
			// pending, so a restart still has it. Without room it is refused. The store may still write the held record later, so a
			// caller's retry can duplicate it: at-least-once, documented, never silent.
			if (this.entries.size < this.max) {
				entry.given_up = reason;
				this.entries.set(event.id, entry);
				this.recordedIds.add(event.id);
				if (evicted) this.compact();
				else this.append(entry);
				return { buffered: false, entry, reason, recorded: true };
			}
			if (evicted) this.compact();
			return { buffered: false, entry, reason, recorded: false };
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

	/**
	 * Give every remaining entry up as `abandoned`. A memory-only buffer calls this at shutdown, so none vanishes unrecorded. A pending
	 * entry already has its record with the store, so it is not recorded twice.
	 */
	abandonAll(): number {
		const dropped = [...this.entries.values()];
		this.entries.clear();
		this.recordedIds.clear();
		for (const entry of dropped) if (entry.given_up == null) this.onDeadLetter(entry, "abandoned");
		return dropped.length;
	}

	private async runDrain(deliver: (entry: EventBufferEntry) => Promise<EventDelivery>, all: boolean): Promise<void> {
		// Settled first, and whether or not the ledger is reachable: writing a record to the dead-letter store spends no attempt.
		let changed = this.settlePending();
		if (!this.allow()) {
			if (changed) this.compact();
			return;
		}
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
			// A breaker refusal is not an attempt: nothing was sent, so the entry keeps its budget and waits for the next pass.
			if (outcome === "skipped") break;
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
	 * Hands the dead-letter record of each pending entry to the store once, then removes the pending entries when the store reports every
	 * record on disk. A pending entry this process has not handed over yet (one left in the file by a restart) is handed over here.
	 * Returns true when the buffer changed.
	 */
	private settlePending(): boolean {
		const pending = [...this.entries.values()].filter((entry) => entry.given_up != null);
		if (pending.length === 0) return false;
		for (const entry of pending) {
			if (entry.given_up == null || this.recordedIds.has(entry.event.id)) continue;
			this.onDeadLetter(entry, entry.given_up);
			this.recordedIds.add(entry.event.id);
		}
		if (!this.flushDeadLetters()) return false;
		for (const entry of pending) {
			this.entries.delete(entry.event.id);
			this.recordedIds.delete(entry.event.id);
		}
		return true;
	}

	/**
	 * The first entry a pass may attempt: in age order, the first entry of each session (the rest chain onto it) that is due.
	 * A session whose first entry is not due waits as a whole. A pending entry is never attempted.
	 */
	private nextDue(all: boolean, at: number): EventBufferEntry | null {
		const seen = new Set<string>();
		for (const entry of this.entries.values()) {
			if (entry.given_up != null) continue;
			const session = entry.event.session_id;
			if (session !== null) {
				if (seen.has(session)) continue;
				seen.add(session);
			}
			if (all || entry.next_at <= at) return entry;
		}
		return null;
	}

	/** The oldest live entry no delivery is working on; null when there is none. A pending entry is never a victim. */
	private oldestEvictable(): EventBufferEntry | null {
		for (const entry of this.entries.values()) {
			if (entry.event.id !== this.flying && entry.given_up == null) return entry;
		}
		return null;
	}

	/**
	 * Give up `victim` and every later live entry of its session, which could never chain. The victim is the session's earliest
	 * buffered entry, and any delivery in flight is a session's earliest entry, so it is never among them. Each record goes to the
	 * store. When the store holds them all on disk they leave the buffer; otherwise they stay in it as pending. Returns true when
	 * they left.
	 */
	private dropFrom(victim: EventBufferEntry, reason: DeadLetterReason): boolean {
		const session = victim.event.session_id;
		const doomed: EventBufferEntry[] = [];
		let started = false;
		for (const entry of this.entries.values()) {
			if (entry === victim) started = true;
			if (started && entry.given_up == null && (entry === victim || (session !== null && entry.event.session_id === session))) doomed.push(entry);
		}
		const givenUp = doomed.map((entry, index) => ({ entry, why: index === 0 ? reason : ("predecessor-dead-lettered" as const) }));
		let onDisk = true;
		for (const { entry, why } of givenUp) {
			onDisk = this.onDeadLetter(entry, why);
			this.recordedIds.add(entry.event.id);
		}
		if (onDisk) {
			for (const entry of doomed) {
				this.entries.delete(entry.event.id);
				this.recordedIds.delete(entry.event.id);
			}
			return true;
		}
		for (const { entry, why } of givenUp) entry.given_up = why;
		return false;
	}

	/** The session's last buffered entry, which the next event must chain onto; null for none, or for a sessionless event. */
	private tailOf(session: string | null): EventBufferEntry | null {
		if (session === null) return null;
		let tail: EventBufferEntry | null = null;
		for (const entry of this.entries.values()) {
			if (entry.event.session_id === session && entry.given_up == null) tail = entry;
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
			this.unreadable = true;
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
			const oldest = this.oldestEvictable();
			if (oldest === null || !this.dropFrom(oldest, "overflow")) break;
		}
		this.compact();
	}

	private append(entry: EventBufferEntry): void {
		// A file that could not be read holds a backlog this process has not seen: writing over it would destroy that backlog.
		if (this.unreadable) {
			this.unsaved = true;
			return;
		}
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
		// Never rewrite a file that could not be read: see `append`.
		if (this.unreadable) {
			this.unsaved = true;
			return;
		}
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
