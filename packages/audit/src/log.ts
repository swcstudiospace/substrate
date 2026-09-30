/**
 * The MCP audit sink: one JSON object per line, opened `O_APPEND`, single writer.
 *
 * A file rather than a table, and a local file rather than a remote one, because
 * the audit's job is to still be there when the stores are not. `substrate-mcp` is
 * the only process that writes it — the same property that makes `agent_events`
 * redacted and chained makes this chain single-writer, so `seq` and `prev` need no
 * coordination.
 *
 * With no path configured the chain lives in memory: verifiable, bounded, and gone
 * at restart. That is the local-dev shape, and `/healthz` reports `auditDurable:
 * false` so a deployment cannot end up in it by accident.
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
	type AuditRecord,
	type AuditRecordInput,
	type ChainVerdict,
	buildRecord,
	verifyAuditChain,
} from "./record.ts";

/** Thrown when a fail-closed call could not be recorded, so it must not proceed. */
export class AuditUnavailableError extends Error {
	constructor(readonly tool: string, cause: string) {
		super(`refusing ${tool}: the MCP audit chain could not take the record — ${cause}`);
		this.name = "AuditUnavailableError";
	}
}

export interface AuditAppend {
	record: AuditRecord;
	/** False when the sink refused. For a fail-open call, the call still proceeds. */
	written: boolean;
	error?: string;
}

export interface AuditLogOptions {
	/** `null` keeps the chain in memory only. */
	path: string | null;
	redact?: (text: string) => string;
	now?: () => Date;
	/** Bytes of the tail read at open to recover `seq` and the chain tip. */
	tailBytes?: number;
	/** Records kept in memory for `/evidence` and for a memory-only chain. */
	maxRetained?: number;
}

export class AuditLog {
	private chainSeq = 0;
	private chainTip: string | null = null;
	private retained: AuditRecord[] = [];
	private opened = false;
	private writable = false;
	private readonly redact: (text: string) => string;
	private readonly now: () => Date;
	private readonly tailBytes: number;
	private readonly maxRetained: number;

	constructor(private readonly options: AuditLogOptions) {
		this.redact = options.redact ?? ((text) => text);
		this.now = options.now ?? (() => new Date());
		this.tailBytes = options.tailBytes ?? 64 * 1024;
		this.maxRetained = options.maxRetained ?? 1000;
	}

	get path(): string | null {
		return this.options.path;
	}

	get durable(): boolean {
		return this.options.path !== null && this.writable;
	}

	get seq(): number {
		return this.chainSeq;
	}

	get tip(): string | null {
		return this.chainTip;
	}

	/**
	 * Recover the chain's position, or start a new one.
	 *
	 * Only the tail is read. The chain is continued from the last *parseable* line:
	 * a process killed mid-write leaves a partial line, and treating that as the tip
	 * would chain every later record onto a hash no verifier can recompute. The
	 * partial line is left in place — this is an append-only file, and a verifier
	 * reporting one unparseable line is better than a writer having quietly deleted
	 * evidence.
	 */
	async open(): Promise<{ records: number; tip: string | null; durable: boolean; error?: string }> {
		this.opened = true;
		const path = this.options.path;
		if (path === null) {
			this.writable = false;
			return { records: 0, tip: null, durable: false };
		}
		try {
			mkdirSync(dirname(path), { recursive: true });
			if (existsSync(path)) {
				const last = this.readLastRecord(path);
				if (last) {
					this.chainSeq = last.seq;
					this.chainTip = last.hash;
				}
			}
			// Prove the sink is writable now rather than discovering it on the first
			// fail-closed call, which would deny a claim for a reason an operator could
			// have been told about at boot.
			appendFileSync(path, "");
			this.writable = true;
			return { records: this.chainSeq, tip: this.chainTip, durable: true };
		} catch (cause) {
			this.writable = false;
			return { records: this.chainSeq, tip: this.chainTip, durable: false, error: this.redact(String(cause)) };
		}
	}

	/**
	 * Append one record.
	 *
	 * The chain tip advances **only** on a successful write. Advancing it on a failed
	 * one would leave every later record pointing at a hash that is not in the file,
	 * so one unwritable record would break verification for everything after it.
	 *
	 * Throws `AuditUnavailableError` when the record is `fail-closed` and the write
	 * failed. Nothing else in this class throws: a fail-open call gets
	 * `written: false` and carries on.
	 */
	async append(input: AuditRecordInput): Promise<AuditAppend> {
		if (!this.opened) await this.open();
		const record = buildRecord(input, { seq: this.chainSeq + 1, prev: this.chainTip }, this.now(), this.redact);

		const path = this.options.path;
		if (path === null) {
			// Memory-only: the append cannot fail, so even a fail-closed call proceeds.
			// Boot printed the warning; see `durable`.
			this.commit(record);
			return { record, written: true };
		}

		try {
			appendFileSync(path, `${JSON.stringify(record)}\n`);
			this.commit(record);
			return { record, written: true };
		} catch (cause) {
			const error = this.redact(String(cause));
			this.writable = false;
			if (input.mode === "fail-closed") throw new AuditUnavailableError(input.tool, error);
			return { record, written: false, error };
		}
	}

	private commit(record: AuditRecord): void {
		this.chainSeq = record.seq;
		this.chainTip = record.hash;
		this.retained.push(record);
		if (this.retained.length > this.maxRetained) this.retained.splice(0, this.retained.length - this.maxRetained);
	}

	/** The most recent records this process holds. Used by `/evidence`. */
	recent(limit = 100): AuditRecord[] {
		return this.retained.slice(-limit);
	}

	/**
	 * Every record on disk, oldest first.
	 *
	 * Memory-only chains answer from the retained buffer. Unparseable lines are
	 * skipped and counted — `verify` is what reports them.
	 */
	async readAll(): Promise<{ records: AuditRecord[]; unparseable: number }> {
		const path = this.options.path;
		if (path === null) return { records: [...this.retained], unparseable: 0 };
		if (!existsSync(path)) return { records: [], unparseable: 0 };
		const text = await Bun.file(path).text();
		const records: AuditRecord[] = [];
		let unparseable = 0;
		for (const line of text.split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				records.push(JSON.parse(line) as AuditRecord);
			} catch {
				unparseable++;
			}
		}
		return { records, unparseable };
	}

	async verify(): Promise<ChainVerdict & { unparseable: number }> {
		const { records, unparseable } = await this.readAll();
		return { ...verifyAuditChain(records), unparseable };
	}

	/**
	 * The last complete JSON line of the file.
	 *
	 * Reads the tail rather than the whole file: this runs at boot, and an audit log
	 * has no compaction. A tail that happens to start mid-line is handled by dropping
	 * everything before the first newline — unless the whole file fits in the window,
	 * where the first line is genuinely the first record.
	 */
	private readLastRecord(path: string): AuditRecord | null {
		const size = statSync(path).size;
		if (size === 0) return null;
		const length = Math.min(this.tailBytes, size);
		const buffer = Buffer.alloc(length);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buffer, 0, length, size - length);
		} finally {
			closeSync(fd);
		}
		let text = buffer.toString("utf8");
		if (length < size) {
			const firstNewline = text.indexOf("\n");
			text = firstNewline < 0 ? "" : text.slice(firstNewline + 1);
		}
		const lines = text.split("\n").filter((line) => line.trim().length > 0);
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				return JSON.parse(lines[i] as string) as AuditRecord;
			} catch {
				// A partial trailing line, or a truncated tail window. Keep walking back.
			}
		}
		return null;
	}
}
