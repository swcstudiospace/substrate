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
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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

	constructor(options: DeadLetterOptions = {}) {
		this.path = options.path ?? null;
		this.now = options.now ?? Date.now;
		if (this.path !== null) this.onDisk = this.read(this.path).length;
	}

	/** True only while every record is on the file. Memory mode is never durable. */
	get durable(): boolean {
		return this.path !== null && this.held.length === 0;
	}

	depth(): number {
		return this.onDisk + this.held.length;
	}

	/** Keep one record for an event given up under `reason`. Never throws: a failed write is reported and the record is held. */
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

	private flush(): void {
		if (this.path === null || this.held.length === 0) return;
		try {
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			const fresh = !existsSync(this.path);
			appendFileSync(this.path, this.held.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
			if (fresh) chmodSync(this.path, 0o600);
			this.onDisk += this.held.length;
			this.held = [];
		} catch (cause) {
			this.report("append", cause);
		}
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
