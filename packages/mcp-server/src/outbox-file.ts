/**
 * The durable JSONL file behind an outbox: the persistence convention the Hindsight retain outbox
 * (uplift-2 R3) established and the ledger event buffer (phase 76) reuses.
 *
 * One line per entry, 0600 inside a 0700 directory. The file is hydrated once when the outbox is built
 * (the last line per key wins, malformed lines are skipped and counted on stderr), appended to as entries
 * arrive, and rewritten compactly through a temp file and a rename whenever the owner's state changed in
 * a way an append cannot express. A failed save keeps the queue in memory and turns `durable` off until a
 * save succeeds again: the owner must then treat the queue as memory-only at shutdown.
 *
 * Owners hand in a snapshot callback rather than the entries themselves, so this module never holds
 * state of its own beyond the save status.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface OutboxFileOptions<T> {
	path: string;
	/** Names the outbox in stderr lines, for example `retain outbox` or `event buffer`. */
	label: string;
	isEntry: (value: unknown) => value is T;
	/** The key a line replaces: at hydrate the last line per key wins. */
	keyOf: (entry: T) => string;
	/** Fired once when a save fails after a good state, with the entry at hand. */
	onUnsaved?: (entry: T) => void;
}

export interface OutboxFileRead<T> {
	/** Entries in file order, one per key. */
	entries: T[];
	/** Lines that were not a valid entry; each was skipped. */
	malformed: number;
}

/**
 * Exponential backoff: `base` × 2^attempt, the base capped at `cap`, then ±20 % jitter so a fleet of parked
 * entries does not retry in lockstep. `attempt` is zero-based.
 */
export function outboxBackoffMs(attempt: number, schedule: { base: number; cap: number }, random: () => number = Math.random): number {
	const exponent = Math.max(0, Math.min(attempt, 30));
	const base = Math.min(schedule.base * 2 ** exponent, schedule.cap);
	return Math.round(base * (0.8 + 0.4 * random()));
}

export class OutboxFile<T> {
	private unsaved = false;
	private readonly reported = new Set<string>();

	constructor(private readonly options: OutboxFileOptions<T>) {}

	/** True only while every entry is on disk: a save that failed leaves this false until one succeeds. */
	get durable(): boolean {
		return !this.unsaved;
	}

	/**
	 * Read the file. `null` when there is nothing to read (missing) or it cannot be read; the owner must
	 * not compact over an unreadable file, so `null` is never the same as an empty queue.
	 */
	read(): OutboxFileRead<T> | null {
		let body: string;
		try {
			if (!existsSync(this.options.path)) return null;
			body = readFileSync(this.options.path, "utf8");
		} catch (cause) {
			this.report("read", cause);
			return null;
		}
		const byKey = new Map<string, T>();
		let malformed = 0;
		for (const line of body.split("\n")) {
			if (line.trim().length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				malformed += 1;
				continue;
			}
			if (!this.options.isEntry(parsed)) {
				malformed += 1;
				continue;
			}
			const key = this.options.keyOf(parsed);
			byKey.delete(key);
			byKey.set(key, parsed);
		}
		if (malformed > 0) process.stderr.write(`[substrate] ${this.options.label}: skipped ${malformed} malformed line(s) in ${this.options.path}\n`);
		return { entries: [...byKey.values()], malformed };
	}

	/** Append one entry. A queue whose last save failed is rewritten whole instead: a plain append would leave the file missing what that save never wrote. */
	append(entry: T, snapshot: () => Iterable<T>): void {
		if (this.unsaved) {
			this.rewrite(snapshot);
			return;
		}
		try {
			mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 });
			const fresh = !existsSync(this.options.path);
			appendFileSync(this.options.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
			if (fresh) chmodSync(this.options.path, 0o600);
			this.unsaved = false;
		} catch (cause) {
			this.failedSave("append", cause, entry);
		}
	}

	/** Replace the file with the snapshot, compactly: temp file, then rename. */
	rewrite(snapshot: () => Iterable<T>): void {
		try {
			mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 });
			const tmp = `${this.options.path}.${process.pid}.tmp`;
			const lines = [...snapshot()].map((entry) => JSON.stringify(entry));
			writeFileSync(tmp, lines.length === 0 ? "" : `${lines.join("\n")}\n`, { mode: 0o600 });
			chmodSync(tmp, 0o600);
			renameSync(tmp, this.options.path);
			this.unsaved = false;
		} catch (cause) {
			const first = snapshot()[Symbol.iterator]().next();
			this.failedSave("rewrite", cause, first.done ? null : first.value);
		}
	}

	/**
	 * One save failed. The queue stays in memory and keeps working, but it is no longer durable: the first
	 * failure after a good state reports once, and every later save rewrites the whole file.
	 */
	private failedSave(action: string, cause: unknown, entry: T | null): void {
		this.report(action, cause);
		if (this.unsaved) return;
		this.unsaved = true;
		if (entry !== null) this.options.onUnsaved?.(entry);
	}

	/** Fixed text plus the errno code: the path is config, never a secret, but an entry body never belongs in a log. */
	private report(action: string, cause: unknown): void {
		const code = (cause as NodeJS.ErrnoException | null)?.code ?? "EIO";
		if (this.reported.has(`${action}:${code}`)) return;
		this.reported.add(`${action}:${code}`);
		process.stderr.write(`[substrate] ${this.options.label} ${action} failed (${code}) at ${this.options.path}; the queue continues in memory\n`);
	}
}
