/**
 * The Hindsight retain outbox (uplift-2 R3; Build Plan A-5 "write outbox").
 *
 * Before this, a retain forward that hit a timeout, a 5xx, a 429 or an open
 * breaker emitted one `memory.retain.failed` warning and the memory never
 * reached Hindsight: the governed write was safe in Postgres, the derived
 * copy was simply lost. Now a transient failure parks a locator — never the
 * body — here and the drain replays it with exponential backoff. The replay
 * re-reads the entry by id from the index, so a stale body is never sent and
 * an entry that was superseded or removed in the meantime is dropped quietly.
 *
 * Two modes. With `SUBSTRATE_RETAIN_OUTBOX_PATH` set the queue is a 0600
 * append-only JSONL file under the unit's `StateDirectory`, hydrated once at
 * boot and rewritten compactly (temp file + rename, the docs state-file
 * precedent) after a drain changes it — so a restart mid-backoff loses
 * nothing. Unset, the queue is process memory: today's behaviour plus retry
 * until the process ends. Dragonfly is never the queue (cache-only, by
 * policy): anything that must survive a restart lives on local disk.
 *
 * The bound (`SUBSTRATE_RETAIN_OUTBOX_MAX`) drops the oldest entry with a
 * warning; the attempt ceiling (`SUBSTRATE_RETAIN_MAX_ATTEMPTS`) drops an
 * entry with the same warning the forward used to emit at once — the trail
 * still ends with exactly one warning, just later. Every drop reaches the
 * caller through `onDrop`, so the warning shape stays the forward's own.
 */
import { randomBytes } from "node:crypto";
import { OutboxFile, outboxBackoffMs } from "./outbox-file.ts";

/** A failure the plane may recover from; everything else is a refusal. */
export const TRANSIENT_RETAIN_REASONS: readonly string[] = [
	"retain-timeout",
	"retain-network",
	"retain-server",
	"retain-rate-limit",
	"ensure-bank-timeout",
	"ensure-bank-network",
	"ensure-bank-server",
	"ensure-bank-rate-limit",
];

export function isTransientRetainReason(reason: string): boolean {
	return TRANSIENT_RETAIN_REASONS.includes(reason);
}

/** One parked retain: locators and hashes only, never the memory text. */
export interface RetainOutboxEntry {
	id: string;
	bank: string;
	document_id: string;
	entry_id: string;
	surface: string;
	entry_hash: string;
	session_id?: string;
	/** Delivery attempts so far, the live one included. */
	attempts: number;
	/** Epoch ms before which the drain leaves the entry alone. */
	next_at: number;
	last_reason: string;
	enqueued_at: number;
}

/** What `enqueue` needs; the outbox adds the id, the clock and the schedule. */
export type RetainOutboxCandidate = Pick<RetainOutboxEntry, "bank" | "document_id" | "entry_id" | "surface" | "entry_hash" | "session_id"> & {
	reason: string;
};

export type RetainDropCause = "outbox-full" | "exhausted" | "abandoned";

export type RetainDeliveryOutcome = "delivered" | "gone" | "permanent" | { transient: string };

export interface RetainOutboxOptions {
	/** JSONL file; null keeps the queue in memory. */
	path?: string | null;
	max?: number;
	maxAttempts?: number;
	now?: () => number;
	/** Uniform [0, 1); injected so the backoff schedule is testable. */
	random?: () => number;
	/** False while the plane's breaker is open: the drain skips without consuming attempts. */
	allow?: () => boolean;
	/** Every entry the outbox gives up on, with why. The caller emits the warning. */
	onDrop?: (entry: RetainOutboxEntry, cause: RetainDropCause) => void;
	/**
	 * The first save that fails after a good state, with the entry at hand.
	 * The caller emits one warning (reason `outbox-unsaved`); `durable` reads
	 * false until a save succeeds again.
	 */
	onUnsaved?: (entry: RetainOutboxEntry) => void;
}

export interface RetainOutboxStats {
	size: number;
	/** ISO instant of the oldest parked entry; null when empty. */
	oldestAt: string | null;
	attemptsTotal: number;
	durable: boolean;
}

export const DEFAULT_RETAIN_OUTBOX_MAX = 10_000;
export const DEFAULT_RETAIN_MAX_ATTEMPTS = 10;
export const DEFAULT_RETAIN_DRAIN_MS = 30_000;
const RETAIN_BACKOFF = { base: 30_000, cap: 3_600_000 };

/**
 * 30 s × 2^attempt, base capped at one hour, then ±20 % jitter so a fleet
 * of parked entries does not retry in lockstep. `attempt` is zero-based: the
 * first replay after the live failure waits ~30 s.
 */
export function retainBackoffMs(attempt: number, random: () => number = Math.random): number {
	return outboxBackoffMs(attempt, RETAIN_BACKOFF, random);
}

function keyOf(entry: { bank: string; document_id: string }): string {
	return `${entry.bank} ${entry.document_id}`;
}

function isEntry(value: unknown): value is RetainOutboxEntry {
	if (value === null || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.id === "string" &&
		typeof row.bank === "string" &&
		typeof row.document_id === "string" &&
		typeof row.entry_id === "string" &&
		typeof row.surface === "string" &&
		typeof row.entry_hash === "string" &&
		(row.session_id === undefined || typeof row.session_id === "string") &&
		typeof row.attempts === "number" &&
		typeof row.next_at === "number" &&
		typeof row.last_reason === "string" &&
		typeof row.enqueued_at === "number"
	);
}

export class RetainOutbox {
	private readonly file: OutboxFile<RetainOutboxEntry> | null;
	private readonly max: number;
	private readonly maxAttempts: number;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly allow: () => boolean;
	private readonly onDrop: (entry: RetainOutboxEntry, cause: RetainDropCause) => void;
	private readonly onUnsaved: (entry: RetainOutboxEntry) => void;
	/** Insertion order is age order: the first key is the oldest entry. */
	private readonly entries = new Map<string, RetainOutboxEntry>();
	private draining: Promise<void> | null = null;
	/** Set when a drain was refused by the gate; cleared by the next drain that ran. */
	private heldByGate = false;

	constructor(options: RetainOutboxOptions = {}) {
		const path = options.path ?? null;
		this.file = path === null ? null : new OutboxFile<RetainOutboxEntry>({ path, label: "retain outbox", isEntry, keyOf, onUnsaved: (entry) => this.onUnsaved(entry) });
		this.max = Math.max(1, options.max ?? DEFAULT_RETAIN_OUTBOX_MAX);
		this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_RETAIN_MAX_ATTEMPTS);
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.allow = options.allow ?? (() => true);
		this.onDrop = options.onDrop ?? (() => undefined);
		this.onUnsaved = options.onUnsaved ?? (() => undefined);
		this.hydrate();
	}

	/**
	 * True only while every parked entry is on disk. A configured path whose
	 * last save failed is *not* durable: shutdown must treat the queue as
	 * memory-only (abandon with warnings) until a save succeeds again, or a
	 * restart would silently lose what the failed save never wrote.
	 */
	get durable(): boolean {
		return this.file !== null && this.file.durable;
	}

	/** Whether this exact entry is still parked: a replay that waited its turn re-checks before sending. */
	holds(entry: RetainOutboxEntry): boolean {
		return this.entries.get(keyOf(entry)) === entry;
	}

	size(): number {
		return this.entries.size;
	}

	/** True once a drain was skipped because the gate refused; the caller retries early after the plane recovers. */
	held(): boolean {
		return this.heldByGate;
	}

	stats(): RetainOutboxStats {
		let oldest: number | null = null;
		let attempts = 0;
		for (const entry of this.entries.values()) {
			if (oldest === null || entry.enqueued_at < oldest) oldest = entry.enqueued_at;
			attempts += entry.attempts;
		}
		return {
			size: this.entries.size,
			oldestAt: oldest === null ? null : new Date(oldest).toISOString(),
			attemptsTotal: attempts,
			durable: this.durable,
		};
	}

	/** A snapshot in age order, for tests and the shutdown abandon pass. */
	list(): RetainOutboxEntry[] {
		return [...this.entries.values()].map((entry) => ({ ...entry }));
	}

	/**
	 * Park one failed forward. A document already parked is replaced — the
	 * replay re-reads the entry by id, so the newest locator is the one that
	 * matters — and the schedule starts over. Over the bound, the oldest entry
	 * is dropped with an `outbox-full` warning before the new one is kept. A
	 * ceiling of one attempt means the live try was the only one: the entry is
	 * dropped at once with the final warning and never replayed.
	 */
	enqueue(candidate: RetainOutboxCandidate): RetainOutboxEntry {
		const at = this.now();
		const entry: RetainOutboxEntry = {
			id: `rob_${randomBytes(6).toString("hex")}`,
			bank: candidate.bank,
			document_id: candidate.document_id,
			entry_id: candidate.entry_id,
			surface: candidate.surface,
			entry_hash: candidate.entry_hash,
			...(candidate.session_id !== undefined ? { session_id: candidate.session_id } : {}),
			attempts: 1,
			next_at: at + retainBackoffMs(0, this.random),
			last_reason: candidate.reason,
			enqueued_at: at,
		};
		if (entry.attempts >= this.maxAttempts) {
			this.onDrop(entry, "exhausted");
			return entry;
		}
		const key = keyOf(entry);
		this.entries.delete(key);
		this.entries.set(key, entry);
		// A drop rewrites the file so the dropped line does not linger; otherwise
		// the new entry is one appended line.
		if (this.enforceBound()) this.compact();
		else this.append(entry);
		return entry;
	}

	/** A live forward landed: any parked copy of that document is stale. */
	forget(bank: string, documentId: string): boolean {
		const removed = this.entries.delete(keyOf({ bank, document_id: documentId }));
		if (removed) this.compact();
		return removed;
	}

	/**
	 * Replay due entries, one plane call at a time. Overlapping calls share one
	 * pass. `all` ignores the schedule — used once the plane is known to be
	 * back, so entries deep in their backoff do not wait an hour for a plane
	 * that is already answering. Refused by the gate: nothing is attempted and
	 * no attempt is consumed.
	 */
	drain(deliver: (entry: RetainOutboxEntry) => Promise<RetainDeliveryOutcome>, options: { all?: boolean } = {}): Promise<void> {
		if (this.draining) return this.draining;
		this.draining = this.runDrain(deliver, options.all === true).finally(() => {
			this.draining = null;
		});
		return this.draining;
	}

	/**
	 * Give every remaining entry up with an `abandoned` drop. The memory-only
	 * mode calls this at shutdown so an entry that would vanish with the
	 * process still ends its trail with the warning it would have had.
	 */
	abandonAll(): number {
		const dropped = [...this.entries.values()];
		this.entries.clear();
		for (const entry of dropped) this.onDrop(entry, "abandoned");
		return dropped.length;
	}

	private async runDrain(deliver: (entry: RetainOutboxEntry) => Promise<RetainDeliveryOutcome>, all: boolean): Promise<void> {
		if (!this.allow()) {
			this.heldByGate = true;
			return;
		}
		this.heldByGate = false;
		const at = this.now();
		const due = [...this.entries.values()].filter((entry) => all || entry.next_at <= at);
		let changed = false;
		for (const entry of due) {
			const key = keyOf(entry);
			// Replaced or forgotten while an earlier delivery ran: not ours anymore.
			if (this.entries.get(key) !== entry) continue;
			if (!this.allow()) {
				// The breaker opened mid-pass: stop here, keep the rest for later.
				this.heldByGate = true;
				break;
			}
			// Hydrated under a higher ceiling than today's: the last attempt was
			// already spent, so the entry gets its warning and no further request.
			if (entry.attempts >= this.maxAttempts) {
				this.entries.delete(key);
				this.onDrop(entry, "exhausted");
				changed = true;
				continue;
			}
			let outcome: RetainDeliveryOutcome;
			try {
				outcome = await deliver(entry);
			} catch (cause) {
				outcome = { transient: `replay-threw: ${cause instanceof Error ? cause.message.slice(0, 120) : String(cause).slice(0, 120)}` };
			}
			if (this.entries.get(key) !== entry) continue;
			changed = true;
			if (outcome === "delivered" || outcome === "gone" || outcome === "permanent") {
				this.entries.delete(key);
				continue;
			}
			entry.attempts += 1;
			entry.last_reason = outcome.transient;
			if (entry.attempts >= this.maxAttempts) {
				this.entries.delete(key);
				this.onDrop(entry, "exhausted");
				continue;
			}
			entry.next_at = this.now() + retainBackoffMs(entry.attempts - 1, this.random);
		}
		if (changed) this.compact();
	}

	/** Drop the oldest entries past the bound; true when anything was dropped. */
	private enforceBound(): boolean {
		let dropped = false;
		while (this.entries.size > this.max) {
			const oldest = this.entries.entries().next().value;
			if (!oldest) break;
			this.entries.delete(oldest[0]);
			dropped = true;
			this.onDrop(oldest[1], "outbox-full");
		}
		return dropped;
	}

	/** Rebuild the queue from the file: last line per document wins, oldest first. */
	private hydrate(): void {
		const read = this.file?.read();
		if (!read) return;
		for (const entry of read.entries) this.entries.set(keyOf(entry), { ...entry });
		this.enforceBound();
		// One compact rewrite at boot: the file is back to one line per entry.
		this.compact();
	}

	private append(entry: RetainOutboxEntry): void {
		this.file?.append(entry, () => this.entries.values());
	}

	private compact(): void {
		this.file?.rewrite(() => this.entries.values());
	}
}
