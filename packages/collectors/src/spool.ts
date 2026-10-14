/**
 * The bounded event spool for collectors and the CLI (uplift-5 U5-4b).
 *
 * Until now a collector that could not reach the ledger dropped the event
 * (`emit.ts`: 5xx, timeout and network error were counted `failed` and gone).
 * With `SUBSTRATE_EVENT_SPOOL=on` a retryable failure parks the event here and
 * a later replay sends it again with the same idempotency key and `ts`, so the
 * server (`SUBSTRATE_EVENT_IDEMPOTENCY=accept|enforce`) can answer a replay of
 * an event it already stored with `deduplicated` instead of writing a second
 * row. This module is the disk half only: it never touches the network, so a
 * hook that appends cannot be slowed by an outage, and the replay transport
 * lives in `emit.ts` where the bearer and URL conventions already are.
 *
 * One file, `${SUBSTRATE_STATE_DIR}/event-spool.jsonl`, mode 0600 in a 0700
 * directory, one JSON object per line, oldest first. The precedent is the
 * Hindsight retain outbox (`mcp-server/src/retain-outbox.ts`): bounded, drop
 * oldest, attempt ceiling, exponential backoff with ±20 % jitter, temp file +
 * rename compaction. The differences are deliberate:
 *
 * - Several processes share the file (herdr, grok, git and Cursor hooks, the
 *   CLI), so nothing is held in memory between calls. Every append and every
 *   compaction takes a short `O_EXCL` lock file; a compaction that renamed a
 *   new file over the old one while a hook appended to the old inode would
 *   otherwise lose that hook's event. The lock is never held across a network
 *   call, and a lock older than `lockStaleMs` belongs to a dead process and is
 *   stolen.
 * - An entry holds the already-redacted event body, because an event has no
 *   source of truth to re-read; the redactor runs before the line is written
 *   (`emit.ts`), so a planted secret never reaches this file. No bearer, URL
 *   or header is ever stored: replay re-resolves them.
 * - A torn last line (a writer killed mid-append) is ignored on read and
 *   dropped at the next compaction; the next append starts on a fresh line so
 *   it cannot be glued to the garbage.
 * - Nothing is dropped silently. Overflow (`SUBSTRATE_EVENT_SPOOL_MAX` lines or
 *   `SUBSTRATE_EVENT_SPOOL_MAX_BYTES`), age (`SUBSTRATE_EVENT_SPOOL_TTL_H`),
 *   attempt exhaustion (`SUBSTRATE_EVENT_SPOOL_MAX_ATTEMPTS`), an oversize body
 *   and an unwritable spool each reach `onDrop` with a cause; `emit.ts` turns
 *   that into a `dropped` line in `refused-emits.jsonl` and one stderr line.
 *
 * What the spool refuses to hold is decided by the caller, not here: only
 * retryable outcomes of `POST /events` are appended (network error, timeout,
 * 5xx, 503 `stored:false`); a 4xx is permanent and is logged, never spooled.
 */
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	fstatSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { EventInput } from "../../mcp-server/src/types.ts";

export const DEFAULT_SPOOL_MAX = 5000;
export const DEFAULT_SPOOL_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_SPOOL_TTL_H = 48;
export const DEFAULT_SPOOL_MAX_ATTEMPTS = 12;
/** The smallest byte cap: below it one ordinary entry would not fit. The parser enforces it, with a warning. */
export const MIN_SPOOL_MAX_BYTES = 1024;

/** Hard ceilings: a typo cannot turn a bounded spool into an unbounded one (Greptile checklist 11). */
const CEILING_MAX = 100_000;
const CEILING_MAX_BYTES = 64 * 1024 * 1024;
const CEILING_TTL_H = 720;
const CEILING_MAX_ATTEMPTS = 100;

/** The server's `POST /events` body cap (`server.ts` `MAX_BODY_BYTES`). A larger body is a 413 there and is never spooled here. */
export const SPOOL_BODY_CAP_BYTES = 1_000_000;

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 3_600_000;
/** The shortest line a valid entry can serialize to; used to decide when a line-count check is worth a read. */
const MIN_LINE_BYTES = 160;
/** One refusal-style visibility line per sampled entry; the rest of a bulk drop is one summary line. */
const DROP_SAMPLE = 20;
/** Settled replays are written back at this cadence, so the crash window between a 202 and the compaction stays small. */
const FLUSH_EVERY = 25;
/** A replay pass stops after this many retryable failures in a row: the ledger is not taking events right now. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Orphaned temp files removed per compaction. */
const TMP_SWEEP_LIMIT = 5;

/** 8–128 chars from `[A-Za-z0-9._:-]`: the wire contract's key alphabet. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export type SpoolMode = "off" | "on";

export interface SpoolConfig {
	mode: SpoolMode;
	max: number;
	maxBytes: number;
	ttlMs: number;
	maxAttempts: number;
	/** One line per invalid value; the caller prints it once. */
	warnings: string[];
}

function boundedInt(env: NodeJS.ProcessEnv, name: string, fallback: number, ceiling: number, warnings: string[], min = 1): number {
	const raw = env[name]?.trim();
	if (raw === undefined || raw === "") return fallback;
	if (!/^\d{1,12}$/.test(raw) || Number(raw) < 1) {
		warnings.push(`${name} must be a positive integer; using ${fallback}`);
		return fallback;
	}
	const value = Number(raw);
	if (value < min) {
		warnings.push(`${name} is below the minimum ${min}; using ${min}`);
		return min;
	}
	if (value > ceiling) {
		warnings.push(`${name} is above the ceiling ${ceiling}; using ${ceiling}`);
		return ceiling;
	}
	return value;
}

/**
 * The spool's flag and caps from the environment, read at call time like every
 * other collector setting. An invalid value falls back to its default with a
 * warning and never throws; an unknown mode is `off`, the safe direction.
 */
export function spoolConfig(env: NodeJS.ProcessEnv = process.env): SpoolConfig {
	const warnings: string[] = [];
	const rawMode = env.SUBSTRATE_EVENT_SPOOL?.trim().toLowerCase();
	let mode: SpoolMode = "off";
	if (rawMode === "on") mode = "on";
	else if (rawMode !== undefined && rawMode !== "" && rawMode !== "off") {
		warnings.push("SUBSTRATE_EVENT_SPOOL must be off or on; using off");
	}
	return {
		mode,
		max: boundedInt(env, "SUBSTRATE_EVENT_SPOOL_MAX", DEFAULT_SPOOL_MAX, CEILING_MAX, warnings),
		maxBytes: boundedInt(env, "SUBSTRATE_EVENT_SPOOL_MAX_BYTES", DEFAULT_SPOOL_MAX_BYTES, CEILING_MAX_BYTES, warnings, MIN_SPOOL_MAX_BYTES),
		ttlMs: boundedInt(env, "SUBSTRATE_EVENT_SPOOL_TTL_H", DEFAULT_SPOOL_TTL_H, CEILING_TTL_H, warnings) * 3_600_000,
		maxAttempts: boundedInt(env, "SUBSTRATE_EVENT_SPOOL_MAX_ATTEMPTS", DEFAULT_SPOOL_MAX_ATTEMPTS, CEILING_MAX_ATTEMPTS, warnings),
		warnings,
	};
}

/**
 * 30 s × 2^attempt, base capped at one hour, then ±20 % jitter so several
 * collectors that parked events during one outage do not replay in lockstep.
 * `attempt` is zero-based: the first replay after the live failure waits ~30 s.
 */
export function spoolBackoffMs(attempt: number, random: () => number = Math.random): number {
	const exponent = Math.max(0, Math.min(attempt, 30));
	const base = Math.min(BACKOFF_BASE_MS * 2 ** exponent, BACKOFF_CAP_MS);
	return Math.round(base * (0.8 + 0.4 * random()));
}

/** JSON with object keys sorted at every depth: the same payload always serializes to the same bytes. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((inner) => canonicalJson(inner)).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const parts: string[] = [];
		for (const key of Object.keys(record).sort()) {
			if (record[key] === undefined) continue;
			parts.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`);
		}
		return `{${parts.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** `ik1:` + sha256 of the JSON array of parts: 68 characters, inside the contract's alphabet and length. */
export function contentKey(parts: readonly string[]): string {
	// JSON, not a delimiter join: a `|` inside the summary or repo cannot alias neighbouring fields.
	return `ik1:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

/** One parked event. The body is already redacted; nothing credential-shaped is ever a field. */
export interface SpoolEntry {
	v: 1;
	id: string;
	/** The idempotency key fixed at the first attempt. */
	key: string;
	collector: string;
	source: string;
	/** The event as first sent, `ts` included, redacted. `idempotency_key` is re-added at replay. */
	event: EventInput;
	/** Delivery attempts so far, the live one included. */
	attempts: number;
	/** Epoch ms before which a replay leaves the entry alone. */
	next_at: number;
	enqueued_at: number;
	last_reason: string;
}

export interface SpoolCandidate {
	key: string;
	collector: string;
	source: string;
	event: EventInput;
	reason: string;
}

export type SpoolDropCause = "overflow" | "bytes" | "ttl" | "attempts" | "oversize" | "write_failed";

export interface SpoolDropReport {
	cause: SpoolDropCause;
	/** Every entry the pass dropped for this cause. */
	count: number;
	/** At most `DROP_SAMPLE` of them, oldest first, for the visibility lines. */
	sample: readonly SpoolEntry[];
}

export type SpoolDelivery =
	/** 202, deduplicated or not: remove the entry. */
	| { kind: "delivered" }
	/** A permanent 4xx: remove the entry; the caller already logged the refusal. */
	| { kind: "refused"; status: number }
	/** A retryable failure that counts: attempts + 1 and back off. */
	| { kind: "retry"; reason: string }
	/** The substrate is not there to ask (connection refused, credentials missing): stop the pass, consume nothing. */
	| { kind: "hold"; reason: string }
	/** This credential is not allowed to send this entry (403): leave it untouched, consume nothing, go on to the next. */
	| { kind: "skip"; reason: string };

export interface SpoolDrainReport {
	delivered: number;
	refused: number;
	retried: number;
	/** Entries left untouched because this process's credential is not the one that can deliver them (403). */
	skipped: number;
	dropped: number;
	/** Why the pass stopped early without consuming attempts, or null. */
	held: string | null;
	budgetExhausted: boolean;
	/** Lines left in the file after the last write-back. */
	remaining: number;
}

export interface SpoolStats {
	depth: number;
	bytes: number;
	/** Epoch ms of the oldest entry; null when empty. */
	oldestAt: number | null;
	/** Epoch ms the soonest entry becomes due; null when empty. */
	nextDueAt: number | null;
	/** Entries already due. */
	due: number;
	/** Lines the reader could not use (a torn tail included). */
	malformed: number;
}

/** The disk writes a failing disk can interrupt; injectable so tests can fail them deterministically. */
export interface SpoolIo {
	writeFile: (path: string, body: string, options: { mode: number }) => void;
	rename: (from: string, to: string) => void;
	/** Returns the bytes written, which may be fewer than `length`. */
	write: (fd: number, data: Buffer, offset: number, length: number) => number;
}

export interface EventSpoolOptions {
	path: string;
	max?: number;
	maxBytes?: number;
	ttlMs?: number;
	maxAttempts?: number;
	now?: () => number;
	/** Uniform [0, 1); injected so the backoff schedule is testable. */
	random?: () => number;
	/** Every drop, with its cause. Must not throw; a throw is swallowed. */
	onDrop?: (report: SpoolDropReport) => void;
	/** How long an append or compaction waits for the lock before giving up. */
	lockWaitMs?: number;
	/** A lock file older than this belongs to a dead process. */
	lockStaleMs?: number;
	/** Test seam for the disk writes that can fail half way; production uses `node:fs`. */
	io?: Partial<SpoolIo>;
}

export type AppendResult = { ok: true; id: string } | { ok: false; error: string };

type Update =
	| { kind: "remove" }
	| { kind: "drop"; cause: SpoolDropCause }
	| { kind: "retry"; attempts: number; next_at: number; last_reason: string };

function isEntry(value: unknown): value is SpoolEntry {
	if (value === null || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	const event = row.event as Record<string, unknown> | null | undefined;
	return (
		row.v === 1 &&
		typeof row.id === "string" &&
		typeof row.key === "string" &&
		IDEMPOTENCY_KEY_PATTERN.test(row.key) &&
		typeof row.collector === "string" &&
		typeof row.source === "string" &&
		event !== null &&
		typeof event === "object" &&
		typeof event.surface === "string" &&
		typeof event.kind === "string" &&
		typeof event.summary === "string" &&
		typeof row.attempts === "number" &&
		Number.isFinite(row.attempts) &&
		typeof row.next_at === "number" &&
		Number.isFinite(row.next_at) &&
		typeof row.enqueued_at === "number" &&
		Number.isFinite(row.enqueued_at) &&
		typeof row.last_reason === "string"
	);
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lineBytes(entry: SpoolEntry): number {
	return Buffer.byteLength(JSON.stringify(entry)) + 1;
}

interface Parsed {
	entries: SpoolEntry[];
	malformed: number;
}

export class EventSpool {
	readonly path: string;
	private readonly lockPath: string;
	private readonly max: number;
	private readonly maxBytes: number;
	private readonly ttlMs: number;
	private readonly maxAttempts: number;
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly onDrop: (report: SpoolDropReport) => void;
	private readonly lockWaitMs: number;
	private readonly lockStaleMs: number;
	private readonly io: SpoolIo;
	private draining: Promise<SpoolDrainReport> | null = null;
	private readonly reported = new Set<string>();
	/** Appends that could not reach the disk since this object was made (`spool_write_failed`). */
	writeFailures = 0;

	constructor(options: EventSpoolOptions) {
		this.path = options.path;
		this.lockPath = `${options.path}.lock`;
		this.max = Math.max(1, options.max ?? DEFAULT_SPOOL_MAX);
		this.maxBytes = Math.max(MIN_SPOOL_MAX_BYTES, options.maxBytes ?? DEFAULT_SPOOL_MAX_BYTES);
		this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_SPOOL_TTL_H * 3_600_000);
		this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_SPOOL_MAX_ATTEMPTS);
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.onDrop = options.onDrop ?? (() => undefined);
		this.lockWaitMs = options.lockWaitMs ?? 500;
		this.lockStaleMs = options.lockStaleMs ?? 10_000;
		this.io = {
			writeFile: options.io?.writeFile ?? ((path, body, opts) => writeFileSync(path, body, opts)),
			rename: options.io?.rename ?? renameSync,
			write: options.io?.write ?? ((fd, data, offset, length) => writeSync(fd, data, offset, length)),
		};
	}

	/**
	 * Park one failed event. Hook-safe: one lock, one `O_APPEND` write, no
	 * network and no drain. The file is only read when it has grown past a cap
	 * (a byte-size check, then a line count once the size could hold more than
	 * `max` lines), and then it is compacted with a visible drop of the oldest.
	 * Never throws: an unwritable spool is `{ ok: false }` plus one stderr line.
	 */
	append(candidate: SpoolCandidate): AppendResult {
		const at = this.now();
		const entry: SpoolEntry = {
			v: 1,
			id: randomBytes(6).toString("hex"),
			key: candidate.key,
			collector: candidate.collector,
			source: candidate.source,
			event: candidate.event,
			attempts: 1,
			next_at: at + spoolBackoffMs(0, this.random),
			enqueued_at: at,
			last_reason: candidate.reason.slice(0, 120),
		};
		const bodyBytes = Buffer.byteLength(JSON.stringify({ ...entry.event, idempotency_key: entry.key }));
		if (bodyBytes > SPOOL_BODY_CAP_BYTES) {
			this.drop({ cause: "oversize", count: 1, sample: [entry] });
			return { ok: false, error: "oversize" };
		}
		if (entry.attempts >= this.maxAttempts) {
			this.drop({ cause: "attempts", count: 1, sample: [entry] });
			return { ok: false, error: "max-attempts" };
		}
		const line = `${JSON.stringify(entry)}\n`;
		let size: { before: number; after: number };
		try {
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			const locked = this.withLock(() => this.appendLocked(line));
			if (!locked.ok) return this.writeFailed(entry, locked.error);
			size = locked.value;
		} catch (cause) {
			return this.writeFailed(entry, (cause as NodeJS.ErrnoException | null)?.code ?? "EIO");
		}
		if (this.overCap(size.before, size.after)) {
			// Only now is a full read worth its cost: enforce the caps, dropping the oldest visibly.
			this.compact(new Map());
		}
		return { ok: true, id: entry.id };
	}

	/**
	 * Whether this append may have crossed a cap. The byte cap is exact (one `fstat`). The
	 * line cap needs a read, so it is checked only when the file has just crossed a stride
	 * boundary past the size at which `max` minimum-size lines would fit: a stride holds
	 * at most `max / 10` lines (every line is at least `MIN_LINE_BYTES`), so the file can
	 * exceed `max` lines by at most that before the next check, and an append stays one
	 * lock and one write almost every time.
	 */
	private overCap(before: number, after: number): boolean {
		if (after > this.maxBytes) return true;
		if (after <= this.max * MIN_LINE_BYTES) return false;
		const stride = Math.max(MIN_LINE_BYTES, Math.min(262_144, Math.floor(this.max / 10) * MIN_LINE_BYTES));
		return Math.floor(before / stride) !== Math.floor(after / stride) && this.countLines() > this.max;
	}

	/**
	 * Replay due entries one at a time, oldest first, until `budgetMs` is spent.
	 * Overlapping calls in one process share one pass; another process doing the
	 * same is harmless, because a replay of a stored key is answered
	 * `deduplicated` by the server. A settled entry (delivered, permanently
	 * refused, exhausted) leaves the file at the next write-back, at most
	 * `FLUSH_EVERY` entries later; a crash in between replays those entries,
	 * which dedupe. `all` ignores the schedule (`substrate spool flush`).
	 * Never throws.
	 */
	drain(deliver: (entry: SpoolEntry) => Promise<SpoolDelivery>, options: { budgetMs: number; all?: boolean }): Promise<SpoolDrainReport> {
		if (this.draining) return this.draining;
		this.draining = this.runDrain(deliver, options.budgetMs, options.all === true)
			.catch((): SpoolDrainReport => ({ delivered: 0, refused: 0, retried: 0, skipped: 0, dropped: 0, held: "error", budgetExhausted: false, remaining: 0 }))
			.finally(() => {
				this.draining = null;
			});
		return this.draining;
	}

	/** Depth, size and age, read-only and without any event body. Never throws. */
	stats(): SpoolStats {
		const parsed = this.read();
		const at = this.now();
		let bytes = 0;
		try {
			bytes = statSync(this.path).size;
		} catch {
			bytes = 0;
		}
		let oldest: number | null = null;
		let next: number | null = null;
		let due = 0;
		for (const entry of parsed.entries) {
			if (oldest === null || entry.enqueued_at < oldest) oldest = entry.enqueued_at;
			if (next === null || entry.next_at < next) next = entry.next_at;
			if (entry.next_at <= at) due += 1;
		}
		return { depth: parsed.entries.length, bytes, oldestAt: oldest, nextDueAt: next, due, malformed: parsed.malformed };
	}

	/**
	 * Entries a replay may send right now: unexpired, under the attempt ceiling, and due (or all of those with
	 * `all`). A pure local read; no lock, no network.
	 */
	eligible(all: boolean): SpoolEntry[] {
		const at = this.now();
		return this.read().entries.filter(
			(entry) => at - entry.enqueued_at <= this.ttlMs && entry.attempts < this.maxAttempts && (all || entry.next_at <= at),
		);
	}

	/**
	 * Drop expired and attempt-exhausted entries now, visibly, without any delivery. Local only: a replay pass
	 * calls it before it asks the server anything, so a failed capability probe can never keep a dead entry alive.
	 * Returns how many entries were dropped (0 when none, or when the rewrite failed). A healthy file is not rewritten.
	 */
	sweepSettled(): number {
		const at = this.now();
		const settled = this.read().entries.filter((entry) => at - entry.enqueued_at > this.ttlMs || entry.attempts >= this.maxAttempts).length;
		// Counted only when the rewrite reached the disk: a failed one dropped (and announced) nothing.
		return settled > 0 && this.compact(new Map()) !== null ? settled : 0;
	}

	/** The parked entries, oldest first. Tests and the flush path read them; status never does. */
	list(): SpoolEntry[] {
		return this.read().entries;
	}

	private async runDrain(deliver: (entry: SpoolEntry) => Promise<SpoolDelivery>, budgetMs: number, all: boolean): Promise<SpoolDrainReport> {
		const report: SpoolDrainReport = { delivered: 0, refused: 0, retried: 0, skipped: 0, dropped: 0, held: null, budgetExhausted: false, remaining: 0 };
		const parsed = this.read();
		report.remaining = parsed.entries.length;
		const started = this.now();
		const updates = new Map<string, Update>();
		let unwritten = 0;
		let failuresInARow = 0;
		const flush = (): void => {
			if (updates.size === 0) return;
			const written = this.compact(updates);
			// A failed write-back keeps the updates: the next flush retries them, and a replay
			// that already succeeded only costs one more deduplicated request.
			if (written === null) return;
			report.remaining = written;
			updates.clear();
			unwritten = 0;
		};
		for (const entry of parsed.entries) {
			if (!all && entry.next_at > this.now()) continue;
			if (this.now() - started >= budgetMs) {
				report.budgetExhausted = true;
				break;
			}
			if (this.now() - entry.enqueued_at > this.ttlMs) {
				updates.set(entry.id, { kind: "drop", cause: "ttl" });
				report.dropped += 1;
				unwritten += 1;
				continue;
			}
			if (entry.attempts >= this.maxAttempts) {
				updates.set(entry.id, { kind: "drop", cause: "attempts" });
				report.dropped += 1;
				unwritten += 1;
				continue;
			}
			let outcome: SpoolDelivery;
			try {
				outcome = await deliver(entry);
			} catch {
				outcome = { kind: "retry", reason: "replay-threw" };
			}
			if (outcome.kind === "hold") {
				report.held = outcome.reason;
				break;
			}
			// Not this process's to judge (another credential may deliver it): untouched, no attempt, next entry.
			if (outcome.kind === "skip") {
				report.skipped += 1;
				continue;
			}
			unwritten += 1;
			if (outcome.kind === "delivered") {
				updates.set(entry.id, { kind: "remove" });
				report.delivered += 1;
				failuresInARow = 0;
			} else if (outcome.kind === "refused") {
				updates.set(entry.id, { kind: "remove" });
				report.refused += 1;
				failuresInARow = 0;
			} else {
				const attempts = entry.attempts + 1;
				report.retried += 1;
				failuresInARow += 1;
				if (attempts >= this.maxAttempts) {
					updates.set(entry.id, { kind: "drop", cause: "attempts" });
					report.dropped += 1;
				} else {
					updates.set(entry.id, {
						kind: "retry",
						attempts,
						next_at: this.now() + spoolBackoffMs(attempts - 1, this.random),
						last_reason: outcome.reason.slice(0, 120),
					});
				}
				if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
					report.held = "consecutive-failures";
					break;
				}
			}
			if (unwritten >= FLUSH_EVERY) flush();
		}
		flush();
		return report;
	}

	/**
	 * Rewrite the file under the lock: re-read it (so an event a hook appended
	 * during a replay survives), apply the settled updates by id, enforce TTL,
	 * attempts and the two caps, then write a temp file and rename it into
	 * place. Returns the lines left, or null when the lock or the disk refused.
	 */
	private compact(updates: Map<string, Update>): number | null {
		const drops = new Map<SpoolDropCause, SpoolEntry[]>();
		const note = (cause: SpoolDropCause, entry: SpoolEntry): void => {
			const list = drops.get(cause) ?? [];
			list.push(entry);
			drops.set(cause, list);
		};
		let left: number | null = null;
		let committed = false;
		try {
			const result = this.withLock(() => {
				const parsed = this.read();
				const at = this.now();
				let kept: SpoolEntry[] = [];
				for (const entry of parsed.entries) {
					const update = updates.get(entry.id);
					if (update?.kind === "remove") continue;
					if (update?.kind === "drop") {
						note(update.cause, entry);
						continue;
					}
					if (update?.kind === "retry") {
						kept.push({ ...entry, attempts: update.attempts, next_at: update.next_at, last_reason: update.last_reason });
						continue;
					}
					kept.push(entry);
				}
				const survivors: SpoolEntry[] = [];
				for (const entry of kept) {
					if (at - entry.enqueued_at > this.ttlMs) note("ttl", entry);
					else if (entry.attempts >= this.maxAttempts) note("attempts", entry);
					else survivors.push(entry);
				}
				kept = survivors;
				let start = 0;
				while (kept.length - start > this.max) {
					note("overflow", kept[start] as SpoolEntry);
					start += 1;
				}
				let bytes = 0;
				const sizes = kept.map((entry) => lineBytes(entry));
				for (let i = start; i < kept.length; i += 1) bytes += sizes[i] as number;
				while (start < kept.length && bytes > this.maxBytes) {
					bytes -= sizes[start] as number;
					note("bytes", kept[start] as SpoolEntry);
					start += 1;
				}
				kept = kept.slice(start);
				this.sweepTmp();
				this.writeFile(kept);
				committed = true;
				return kept.length;
			});
			if (result.ok) left = result.value;
			else this.once("compact", result.error);
		} catch (cause) {
			this.once("compact", (cause as NodeJS.ErrnoException | null)?.code ?? "EIO");
		}
		// Drops are reported only for a compaction that reached the disk: when the write failed the entries
		// are still in the file, and the next attempt will decide (and report) again, once.
		if (!committed) drops.clear();
		// Drop visibility is written after the lock is released: it touches another file.
		for (const [cause, entries] of drops) {
			this.drop({ cause, count: entries.length, sample: entries.slice(0, DROP_SAMPLE) });
		}
		return left;
	}

	private writeFile(entries: readonly SpoolEntry[]): void {
		const tmp = `${this.path}.${process.pid}.tmp`;
		const body = entries.length === 0 ? "" : `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		// The write is inside the try: a write that fails half way (ENOSPC, EIO) leaves a partial temp
		// file, and no later process (a hook has a new pid every time) would ever remove that name.
		try {
			this.io.writeFile(tmp, body, { mode: 0o600 });
			const fd = openSync(tmp, "r+");
			try {
				fchmodSync(fd, 0o600);
			} finally {
				closeSync(fd);
			}
			this.io.rename(tmp, this.path);
		} catch (cause) {
			try {
				unlinkSync(tmp);
			} catch {
				// Nothing left to clean.
			}
			throw cause;
		}
	}

	/**
	 * Remove temp files an earlier compaction left behind (a process killed between the write and the
	 * rename, or a failed unlink). Called with the lock held, so no live compaction of this spool owns a
	 * young one; only names older than the stale-lock age are touched, and at most `TMP_SWEEP_LIMIT` per
	 * compaction so the sweep stays bounded.
	 */
	private sweepTmp(): void {
		try {
			const prefix = `${basename(this.path)}.`;
			const dir = dirname(this.path);
			let removed = 0;
			for (const name of readdirSync(dir)) {
				if (removed >= TMP_SWEEP_LIMIT) break;
				if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
				try {
					if (Date.now() - statSync(join(dir, name)).mtimeMs <= this.lockStaleMs) continue;
					unlinkSync(join(dir, name));
					removed += 1;
				} catch {
					// Gone already, or not ours to remove.
				}
			}
		} catch {
			// An unreadable directory is the write path's problem, not the sweep's.
		}
	}

	/**
	 * One `O_APPEND` write. A file whose last byte is not a newline (a torn write) gets one first. Every byte
	 * is written or the append fails: a short write that returned success would tear the line while the caller
	 * advanced past the event. On a failed write the partial tail is truncated away (the lock is held, so
	 * nothing else appended after it). Returns the size before and after.
	 */
	private appendLocked(line: string): { before: number; after: number } {
		const fd = openSync(this.path, "a+", 0o600);
		try {
			fchmodSync(fd, 0o600);
			const before = fstatSync(fd).size;
			let prefix = "";
			if (before > 0) {
				const last = Buffer.alloc(1);
				readSync(fd, last, 0, 1, before - 1);
				if (last[0] !== 0x0a) prefix = "\n";
			}
			const data = Buffer.from(`${prefix}${line}`);
			let written = 0;
			try {
				while (written < data.length) {
					const n = this.io.write(fd, data, written, data.length - written);
					if (!(n > 0)) throw Object.assign(new Error("short write"), { code: "EIO" });
					written += n;
				}
			} catch (cause) {
				try {
					ftruncateSync(fd, before);
				} catch {
					// The torn tail stays; the reader ignores it and the next append starts on a fresh line.
				}
				throw cause;
			}
			return { before, after: before + data.length };
		} finally {
			closeSync(fd);
		}
	}

	/**
	 * Read and parse without a lock. Bounded while reading: a file somehow larger
	 * than four times the byte cap is read from its tail only. The last segment
	 * of a file that does not end in a newline is a torn write and is ignored.
	 */
	private read(): Parsed {
		let text: string;
		try {
			const size = statSync(this.path).size;
			const limit = this.maxBytes * 4 + SPOOL_BODY_CAP_BYTES;
			if (size > limit) {
				const fd = openSync(this.path, "r");
				try {
					const buffer = Buffer.alloc(limit);
					readSync(fd, buffer, 0, limit, size - limit);
					text = buffer.toString("utf8");
					const firstBreak = text.indexOf("\n");
					text = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
				} finally {
					closeSync(fd);
				}
				this.once("read", "EFBIG");
			} else {
				text = readFileSync(this.path, "utf8");
			}
		} catch (cause) {
			const code = (cause as NodeJS.ErrnoException | null)?.code;
			if (code !== "ENOENT") this.once("read", code ?? "EIO");
			return { entries: [], malformed: 0 };
		}
		const entries: SpoolEntry[] = [];
		let malformed = 0;
		const lines = text.split("\n");
		const tail = lines.pop() ?? "";
		if (tail.length > 0) malformed += 1;
		for (const line of lines) {
			if (line.trim().length === 0) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isEntry(parsed)) entries.push(parsed);
				else malformed += 1;
			} catch {
				malformed += 1;
			}
		}
		return { entries, malformed };
	}

	/** Newline count of the file without parsing it: the cheap way to ask whether the line cap was crossed. */
	private countLines(): number {
		try {
			const buffer = readFileSync(this.path);
			let lines = 0;
			for (let at = buffer.indexOf(0x0a); at !== -1; at = buffer.indexOf(0x0a, at + 1)) lines += 1;
			return lines;
		} catch {
			return 0;
		}
	}

	/** Run `fn` holding the lock file. A lock held by a live process is waited for up to `lockWaitMs`; a stale one is stolen. */
	private withLock<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } {
		const deadline = Date.now() + this.lockWaitMs;
		for (;;) {
			try {
				closeSync(openSync(this.lockPath, "wx", 0o600));
				break;
			} catch (cause) {
				const code = (cause as NodeJS.ErrnoException | null)?.code ?? "EIO";
				if (code !== "EEXIST") return { ok: false, error: code };
				let retryNow = false;
				try {
					if (Date.now() - statSync(this.lockPath).mtimeMs > this.lockStaleMs) {
						unlinkSync(this.lockPath);
						retryNow = true;
					}
				} catch {
					// The holder released it between the open and the stat: try again at once.
					retryNow = true;
				}
				if (retryNow) continue;
				if (Date.now() >= deadline) return { ok: false, error: "locked" };
				sleepSync(5);
			}
		}
		try {
			return { ok: true, value: fn() };
		} finally {
			try {
				unlinkSync(this.lockPath);
			} catch {
				// A stolen lock is already gone.
			}
		}
	}

	private writeFailed(entry: SpoolEntry, code: string): AppendResult {
		this.writeFailures += 1;
		this.once("append", code);
		this.drop({ cause: "write_failed", count: 1, sample: [entry] });
		return { ok: false, error: code };
	}

	private drop(report: SpoolDropReport): void {
		try {
			this.onDrop(report);
		} catch {
			// Visibility must never break the write path.
		}
	}

	/** Fixed text plus the errno code, once per action and code: a broken disk logs once, not once per event. */
	private once(action: string, code: string): void {
		const key = `${action}:${code}`;
		if (this.reported.has(key)) return;
		this.reported.add(key);
		try {
			process.stderr.write(`[collectors] event spool ${action} failed (${code}) at ${this.path}; the event is not spooled\n`);
		} catch {
			// Never throw from a reporting path.
		}
	}
}
