/**
 * The dead-letter store (phase 76): one record for every event the substrate could neither write to the ledger nor keep
 * in its buffer. A record carries the event whole, its hash, why it was given up and the last write error, so an operator
 * can replay it by hand. Nothing is dropped without one.
 *
 * It is a local file, not a Greptime table, because it is written exactly when Greptime is failing: a record that needed
 * the ledger would be lost in the outage it documents. With `SUBSTRATE_EVENT_DEAD_LETTER_PATH` set the store is an
 * append-only 0600 JSONL file; unset, records are held in memory and `durable` reads false, as the retain outbox's
 * memory mode does. A failed append keeps the records in memory and tries the file again on the next record.
 *
 * It is deliberately not bounded. A bound would have to discard records, which is the silent loss this store exists to
 * end. Its depth is reported on `/healthz` instead.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { parseStoredLine, StoredEvent } from "./event.ts";
import type { SubstrateEvent } from "./types.ts";

/**
 * Why an event was given up. A closed set, so records can be grouped and tested by it:
 * - `exhausted`: the write budget was spent;
 * - `overflow`: the buffer was full and this event was its oldest;
 * - `buffer-full`: the buffer was full and nothing in it could be given up, so this newest event was refused;
 * - `predecessor-dead-lettered`: an earlier event of its session was given up, so it can never chain;
 * - `abandoned`: the process stopped with a memory-only buffer.
 */
export const DEAD_LETTER_REASONS = ["exhausted", "overflow", "buffer-full", "predecessor-dead-lettered", "abandoned"] as const;
export type DeadLetterReason = (typeof DEAD_LETTER_REASONS)[number];

/** How much of the file the boot count reads at a time. */
const COUNT_CHUNK_BYTES = 64 * 1024;

/** What a record is made from: the event and what happened to it. */
export interface DeadLetterCandidate {
	event: SubstrateEvent;
	/** Write attempts made, the live one included. */
	attempts: number;
	/** Epoch ms the event entered the write path. */
	enqueued_at: number;
	/** The last write error, redacted by the caller, or the buffer's note. */
	last_reason: string;
}

/** One line of the file. */
export const StoredDeadLetter = z.object({
	id: z.string(),
	reason: z.enum(DEAD_LETTER_REASONS),
	event_id: z.string(),
	event_hash: z.string(),
	session_id: z.string().nullable(),
	surface: z.string(),
	kind: z.string(),
	attempts: z.number(),
	last_reason: z.string(),
	enqueued_at: z.string(),
	dead_lettered_at: z.string(),
	event: StoredEvent,
});
export type DeadLetterRecord = z.infer<typeof StoredDeadLetter>;

export interface DeadLetterOptions {
	/** JSONL file; null keeps the records in memory. */
	path?: string | null;
	now?: () => number;
}

export class DeadLetterStore {
	private readonly path: string | null;
	private readonly now: () => number;
	/** Records already on the file. */
	private onDisk = 0;
	/** Records not yet on the file: all of them in memory mode, the unsaved tail otherwise. */
	private held: DeadLetterRecord[] = [];
	/** File-system error codes already reported, so a broken disk logs once per code. */
	private readonly reported = new Set<string>();
	/** Set when the file exists but could not be read at boot, so the records already on it are unknown. */
	private unverified = false;

	constructor(options: DeadLetterOptions = {}) {
		this.path = options.path ?? null;
		this.now = options.now ?? Date.now;
		if (this.path !== null) this.onDisk = this.countOnFile(this.path);
	}

	/** True only while every record is on the file. Memory mode is never durable, and nor is a file whose records could not be counted. */
	get durable(): boolean {
		return this.path !== null && this.held.length === 0 && !this.unverified;
	}

	depth(): number {
		return this.onDisk + this.held.length;
	}

	/** The records held in memory, not yet on the file, oldest first. A copy, read on demand: a shutdown that cannot keep them reports them. */
	heldRecords(): DeadLetterRecord[] {
		return [...this.held];
	}

	/**
	 * Keep one record for an event given up under `reason`. Never throws: a failed write is reported and the record is held.
	 *
	 * At-least-once. If the process stops after this record reaches the file but before the buffer drops the entry, the entry is given
	 * up again on the next boot and a second record is written. Both copies carry the same event id and hash.
	 */
	record(candidate: DeadLetterCandidate, reason: DeadLetterReason): DeadLetterRecord {
		const event = candidate.event;
		const record: DeadLetterRecord = {
			id: `dlq_${randomBytes(6).toString("hex")}`,
			reason,
			event_id: event.id,
			event_hash: event.hash,
			session_id: event.session_id,
			surface: event.surface,
			kind: event.kind,
			attempts: candidate.attempts,
			last_reason: candidate.last_reason,
			enqueued_at: new Date(candidate.enqueued_at).toISOString(),
			dead_lettered_at: new Date(this.now()).toISOString(),
			event: { ...event },
		};
		this.held.push(record);
		process.stderr.write(`[substrate] event ${event.id} dead-lettered (${reason}) after ${candidate.attempts} attempt(s), hash ${event.hash}\n`);
		this.flush();
		return record;
	}

	/** Every record, oldest first: what is on the file, then what is held. Read on demand, never on a hot path. */
	records(): DeadLetterRecord[] {
		const onFile = this.path === null ? [] : this.read(this.path);
		return [...onFile, ...this.held];
	}

	/**
	 * Writes the records still held in memory. Returns true when every record is on the file. Spends no attempt.
	 *
	 * At-least-once. A write that fails partway can leave some of the held records on the file; they stay held and are written again by
	 * the next flush, so the same record can appear twice. Each copy carries the same event id and hash, so the duplicate is detectable.
	 */
	writeHeld(): boolean {
		this.flush();
		return this.durable;
	}

	private flush(): void {
		if (this.path === null || this.held.length === 0) return;
		try {
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			const fresh = !existsSync(this.path);
			// A torn last line (a write cut short) has no newline. The records go on a line of their own, so the torn line stays alone
			// and is skipped on read, instead of gluing its tail onto the first record and losing that record too.
			const lead = !fresh && this.endsMidLine(this.path) ? "\n" : "";
			appendFileSync(this.path, lead + this.held.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
			if (fresh) chmodSync(this.path, 0o600);
			this.onDisk += this.held.length;
			this.held = [];
		} catch (cause) {
			this.report("append", cause);
		}
	}

	/** Whether the file's last byte is not a newline. */
	private endsMidLine(path: string): boolean {
		const size = statSync(path).size;
		if (size === 0) return false;
		const fd = openSync(path, "r");
		try {
			const last = Buffer.alloc(1);
			readSync(fd, last, 0, 1, size - 1);
			return last[0] !== 0x0a;
		} finally {
			closeSync(fd);
		}
	}

	/**
	 * The records already on the file, counted without holding them: the file is read in fixed chunks, each complete line is checked
	 * and dropped, so the memory a restart needs does not grow with the history. A file that cannot be read counts as none, and is
	 * marked `unverified` so the store is not durable until the count is known.
	 */
	private countOnFile(path: string): number {
		let fd: number;
		try {
			if (!existsSync(path)) return 0;
			fd = openSync(path, "r");
		} catch (cause) {
			this.unverified = true;
			this.report("read", cause);
			return 0;
		}
		let count = 0;
		let malformed = 0;
		const tally = (line: Buffer): void => {
			const text = line.toString("utf8");
			if (text.trim().length === 0) return;
			if (parseStoredLine(text, StoredDeadLetter) === null) malformed += 1;
			else count += 1;
		};
		const chunk = Buffer.alloc(COUNT_CHUNK_BYTES);
		let pending = Buffer.alloc(0);
		try {
			for (;;) {
				const read = readSync(fd, chunk, 0, chunk.length, null);
				if (read === 0) break;
				pending = Buffer.concat([pending, chunk.subarray(0, read)]);
				let from = 0;
				for (let nl = pending.indexOf(0x0a, from); nl !== -1; nl = pending.indexOf(0x0a, from)) {
					tally(pending.subarray(from, nl));
					from = nl + 1;
				}
				pending = pending.subarray(from);
			}
			if (pending.length > 0) tally(pending);
		} catch (cause) {
			this.unverified = true;
			this.report("read", cause);
			return 0;
		} finally {
			closeSync(fd);
		}
		if (malformed > 0) process.stderr.write(`[substrate] dead-letter store: skipped ${malformed} malformed line(s) in ${path}\n`);
		return count;
	}

	private read(path: string): DeadLetterRecord[] {
		let body: string;
		try {
			if (!existsSync(path)) return [];
			body = readFileSync(path, "utf8");
		} catch (cause) {
			this.report("read", cause);
			return [];
		}
		const records: DeadLetterRecord[] = [];
		let malformed = 0;
		for (const line of body.split("\n")) {
			if (line.trim().length === 0) continue;
			const record = parseStoredLine(line, StoredDeadLetter);
			if (record === null) malformed += 1;
			else records.push(record);
		}
		if (malformed > 0) process.stderr.write(`[substrate] dead-letter store: skipped ${malformed} malformed line(s) in ${path}\n`);
		return records;
	}

	/** Fixed text plus the errno code: the path is config, never a secret, but an event body never belongs in a log. */
	private report(action: string, cause: unknown): void {
		const code = (cause as NodeJS.ErrnoException | null)?.code ?? "EIO";
		if (this.reported.has(`${action}:${code}`)) return;
		this.reported.add(`${action}:${code}`);
		process.stderr.write(`[substrate] dead-letter store ${action} failed (${code}) at ${this.path}; records are held in memory\n`);
	}
}
