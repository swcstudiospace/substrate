/**
 * The MCP audit sink: one JSON object per line, opened `O_APPEND`, single writer.
 *
 * A file rather than a table, and a local file rather than a remote one, because
 * the audit's job is to still be there when the stores are not. `substrate-mcp` is
 * the writer. A repair execute (`reconcile repair --execute`) is an approved second
 * writer: it runs only with the server stopped (`--server-stopped`, an operator
 * assertion the code does not check), and it appends one record after the flush
 * (`docs/mcp-audit.md`). `seq` and `prev` need no coordination only while that holds.
 *
 * With no path configured the chain lives in memory: verifiable, bounded, and gone
 * at restart. That is the local-dev shape, and `/healthz` reports `auditDurable:
 * false` so a deployment cannot end up in it by accident.
 *
 * Beside the file sits a **checkpoint**: the last `seq` and `hash` this process
 * committed, rewritten after every append. It is what makes "the file is empty" a
 * question with two answers rather than one — see `open`.
 *
 * The file can also be **rolled over by size** (`rolloverBytes`, off unless set):
 * the active file is renamed to `<path>.<firstSeq>-<lastSeq>.jsonl` beside it and
 * a fresh active file starts at the same path, its first record chaining `prev` to
 * the closed segment's tip. One chain, several files; `scan` walks the closed
 * segments in sequence order and then the active file, so a verdict always covers
 * every record ever appended — see `rollover`.
 */
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	type AuditRecord,
	type AuditRecordInput,
	type AuditStats,
	type ChainVerdict,
	ChainWalker,
	MAX_IDENTIFIER,
	MAX_RECORD_BYTES,
	NO_POSITION,
	StatsAccumulator,
	buildRecord,
	isAuditRecord,
	sanitizeField,
} from "./record.ts";

export { NO_POSITION };

/** Thrown when a fail-closed call could not be recorded, so it must not proceed. */
export class AuditUnavailableError extends Error {
	constructor(
		readonly tool: string,
		cause: string,
	) {
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

/**
 * What the chain knows that the file does not agree with.
 *
 * Set when the checkpoint contradicts the file, either way round. Carried into every
 * `verify` verdict for the life of the process, because it is a fact about the file
 * that no amount of subsequent appending repairs.
 *
 * `missing` is the file having fewer records than were committed — deleted or
 * truncated. `rewritten` is the file having the right *number* of records and the
 * wrong ones: a different, internally consistent chain put in its place. Comparing
 * sequence numbers alone caught only the first, so a wholesale substitution that
 * happened to end at the committed `seq` passed as intact and the next append then
 * overwrote the checkpoint with the impostor's hash. The checkpoint stores the
 * committed *hash*, so it can and now does anchor the contents too.
 */
export interface MissingHistory {
	kind: "missing" | "rewritten";
	/** The `seq` the checkpoint last committed. */
	checkpointSeq: number;
	/** The highest `seq` the file still holds, or 0 when it holds none. */
	foundSeq: number;
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
	/**
	 * Where the last committed position is kept. Defaults to `<path>.checkpoint`.
	 *
	 * `false` opts out, for a caller that deliberately wants the pre-checkpoint
	 * behaviour — a test asserting what the checkpoint is *for*, mostly.
	 */
	checkpointPath?: string | false;
	/** How far back recovery will scan for a complete record before giving up. */
	maxScanBytes?: number;
	/**
	 * Close the active file and start a new one once an append would take it past
	 * this many bytes. `null` never rolls. Undefined reads
	 * `SUBSTRATE_AUDIT_ROLLOVER_BYTES` from the environment (`rolloverBytesFromEnv`).
	 */
	rolloverBytes?: number | null;
}

/** A closed segment of the chain: `<path>.<firstSeq>-<lastSeq>.jsonl` beside the active file. */
export interface AuditSegment {
	path: string;
	firstSeq: number;
	lastSeq: number;
}

/** What `report` answers: the whole chain on disk, every segment included. */
export interface AuditReport {
	/** Closed segments beside the active file. */
	segments: number;
	records: number;
	firstSeq: number | null;
	lastSeq: number | null;
	ok: boolean;
	unparseable: number;
	brokenAt?: number;
	reason?: string;
}

/** The file a closed segment is renamed to: same directory, so the same `StateDirectory` and mode. */
export function segmentPath(path: string, firstSeq: number, lastSeq: number): string {
	return `${path}.${firstSeq}-${lastSeq}.jsonl`;
}

/**
 * The segment a file name beside `path` denotes, or null for any other file — the
 * active file itself, its checkpoint, a temporary, a stranger. Strict on purpose:
 * a verifier that guessed at names would be a verifier that could be fed a file.
 */
export function parseSegmentName(path: string, name: string): AuditSegment | null {
	const base = basename(path);
	if (!name.startsWith(`${base}.`) || !name.endsWith(".jsonl")) return null;
	const span = name.slice(base.length + 1, -".jsonl".length);
	const match = /^([1-9][0-9]{0,14})-([1-9][0-9]{0,14})$/.exec(span);
	if (!match) return null;
	const firstSeq = Number(match[1]);
	const lastSeq = Number(match[2]);
	if (firstSeq > lastSeq) return null;
	return { path: join(dirname(path), name), firstSeq, lastSeq };
}

/** Segments in chain order. Pure, so the ordering is testable without a directory. */
export function orderSegments(segments: readonly AuditSegment[]): AuditSegment[] {
	return [...segments].sort((a, b) => a.firstSeq - b.firstSeq || a.lastSeq - b.lastSeq);
}

/** Every closed segment beside `path`, in chain order. A directory that cannot be read holds none. */
export function listAuditSegments(path: string): AuditSegment[] {
	let names: string[];
	try {
		names = readdirSync(dirname(path));
	} catch {
		return [];
	}
	const segments: AuditSegment[] = [];
	for (const name of names) {
		const segment = parseSegmentName(path, name);
		if (segment) segments.push(segment);
	}
	return orderSegments(segments);
}

/**
 * `SUBSTRATE_AUDIT_ROLLOVER_BYTES`, or null. Unset, `0`, or anything that is not a
 * positive integer means the chain never rolls — which is what every deployment
 * before this setting did, so a typo cannot start rotating a file by surprise.
 */
export function rolloverBytesFromEnv(env: Record<string, string | undefined> = process.env): number | null {
	const raw = env.SUBSTRATE_AUDIT_ROLLOVER_BYTES?.trim();
	if (!raw || !/^[0-9]{1,15}$/.test(raw)) return null;
	const bytes = Number(raw);
	return bytes > 0 ? bytes : null;
}

/** The checkpoint file's contents. Small on purpose: it is rewritten every append. */
interface Checkpoint {
	seq: number;
	hash: string;
	ts: string;
}

export class AuditLog {
	private chainSeq = 0;
	private chainTip: string | null = null;
	private retained: AuditRecord[] = [];
	private opened = false;
	private writable = false;
	/** Set when an append threw, which may have left a half-written line behind. */
	private mayHaveFragment = false;
	/** Set when the checkpoint and the file disagree. See `MissingHistory`. */
	private lostHistory: MissingHistory | null = null;
	/** The checkpoint as it stood at boot, before this process wrote anything. */
	private anchor: Checkpoint | null = null;
	/** Why this chain will not append at all. Set when the position cannot be trusted. */
	private refuseWrites: string | null = null;
	private readonly redact: (text: string) => string;
	private readonly now: () => Date;
	private readonly tailBytes: number;
	private readonly maxRetained: number;
	private readonly checkpointPath: string | null;
	private readonly maxScanBytes: number;
	/** Size at which the active file is closed, or null to never roll. */
	private readonly rolloverBytes: number | null;
	/** Bytes in the active file, kept current so a roll decision costs no stat. */
	private activeBytes = 0;
	/** `seq` of the active file's first record; null while it holds none. Names the segment at roll. */
	private activeFirstSeq: number | null = null;

	constructor(private readonly options: AuditLogOptions) {
		this.redact = options.redact ?? ((text) => text);
		this.now = options.now ?? (() => new Date());
		// Never smaller than the largest record this can build. A window below that bound
		// would make "the last record did not fit" reachable by a caller choosing a long
		// argument name, which is the hole `maxScanBytes` below is the second half of.
		this.tailBytes = Math.max(options.tailBytes ?? 64 * 1024, MAX_RECORD_BYTES + 1024);
		this.maxRetained = options.maxRetained ?? 1000;
		this.checkpointPath =
			options.checkpointPath === false
				? null
				: (options.checkpointPath ?? (options.path === null ? null : `${options.path}.checkpoint`));
		this.maxScanBytes = Math.max(options.maxScanBytes ?? 64 * 1024 * 1024, this.tailBytes);
		// Read here rather than by the server, so every writer of this file — the service,
		// a test, a script — rolls by the same rule. Anything but a positive integer is off.
		const rollover = options.rolloverBytes === undefined ? rolloverBytesFromEnv() : options.rolloverBytes;
		this.rolloverBytes = rollover !== null && Number.isInteger(rollover) && rollover > 0 ? rollover : null;
	}

	get path(): string | null {
		return this.options.path;
	}

	/** The size the active file is rolled at, or null when it never is. */
	get rolloverLimit(): number | null {
		return this.rolloverBytes;
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

	/** Records the checkpoint says existed and the file no longer holds, or null. */
	get missingHistory(): MissingHistory | null {
		return this.lostHistory;
	}

	/**
	 * Recover the chain's position, or start a new one.
	 *
	 * Only the tail is read, and the chain is continued from the last *parseable* line:
	 * a process killed mid-write leaves a partial line, and treating that as the tip
	 * would chain every later record onto a hash no verifier can recompute. The
	 * partial line is left in place — this is an append-only file, and a verifier
	 * reporting one unparseable line is better than a writer having quietly deleted
	 * evidence.
	 *
	 * **A missing or empty file is two different states, and they have to be told
	 * apart.** A fresh installation has no file and legitimately starts at `seq: 1`. A
	 * deployment whose audit file was deleted or truncated also has no records — and
	 * used to start at `seq: 1` too, whereupon the new chain verified as intact and an
	 * evidence bundle attested to it without a word about the decisions that had
	 * disappeared. That is the one failure an audit cannot be allowed to have, because
	 * the reader of an evidence document has nothing else to go on.
	 *
	 * So the position is checkpointed beside the file after every append, and it is the
	 * checkpoint that answers the question: no checkpoint and no file is a fresh install;
	 * a checkpoint naming records the file cannot account for is **missing history**. In
	 * that state the chain resumes from the checkpoint rather than from 1, which keeps
	 * the appends honest (the file's first record is then not `seq: 1`, so the genesis
	 * check reports the gap on its own) and `verify` says so outright for as long as this
	 * process lives. Appending still works: refusing every fail-closed tool forever after
	 * a disk mishap would be an outage in the name of an audit.
	 */
	async open(): Promise<{
		records: number;
		tip: string | null;
		durable: boolean;
		error?: string;
		missingHistory?: MissingHistory;
	}> {
		this.opened = true;
		const path = this.options.path;
		if (path === null) {
			this.writable = false;
			return { records: 0, tip: null, durable: false };
		}
		try {
			mkdirSync(dirname(path), { recursive: true });
			const checkpoint = this.readCheckpoint();
			let recovered: { record: AuditRecord | null; size: number; exhausted: boolean } = existsSync(path)
				? this.readLastRecord(path)
				: { record: null, size: 0, exhausted: true };
			const segments = listAuditSegments(path);
			const newest = segments[segments.length - 1];
			if (!recovered.record && recovered.exhausted && newest) {
				// No active file, an empty one, or one holding nothing readable, beside a
				// closed segment: the process died between closing a segment and writing the
				// first record of the next one — before, or partway through, that write. The
				// chain's tip is the segment's, and the next record continues it. Nothing in
				// the active file is readable, so nothing in it can outrank the segment; a
				// partial first line is not a lost record, and reporting it as one made a
				// mid-write crash read as a deleted file (Greptile round 2). The size stays
				// the active file's: that is what the checks below are about, and a fragment
				// is terminated below exactly as it would be in any other file. `exhausted`
				// is the guard — a file too large to have been scanned to its head may still
				// hold records past the window, and those outrank any segment.
				recovered = { ...this.readLastRecord(newest.path), size: recovered.size };
			}
			if (recovered.record) {
				this.chainSeq = recovered.record.seq;
				this.chainTip = recovered.record.hash;
			}

			// The checkpoint read at boot is the anchor for the life of this process: it is
			// the last position committed *before* anything here wrote, so it is the one
			// value the file cannot have talked its way out of. `scan` checks the record at
			// its `seq` against it on every verification — see `anchor`.
			this.anchor = checkpoint;

			if (checkpoint && (!recovered.record || recovered.record.seq < checkpoint.seq)) {
				// The file cannot account for records this process already committed. Resume
				// from the checkpoint so nothing reuses a `seq` that has been used, and carry
				// the state into every verdict — see `verify`.
				this.lostHistory = { kind: "missing", checkpointSeq: checkpoint.seq, foundSeq: recovered.record?.seq ?? 0 };
				this.chainSeq = checkpoint.seq;
				this.chainTip = checkpoint.hash;
			} else if (checkpoint && recovered.record && recovered.record.seq === checkpoint.seq && recovered.record.hash !== checkpoint.hash) {
				// Same count, different contents: the file was replaced with another chain that
				// ends where this one did. Comparing `seq` alone accepted it, and the next
				// append would have rewritten the checkpoint to match the impostor — so the
				// substitution erased its own evidence. Resume from the checkpoint's hash
				// instead, which keeps the anchor and makes the next record's `prev` disagree
				// with the file, exactly as it should.
				this.lostHistory = { kind: "rewritten", checkpointSeq: checkpoint.seq, foundSeq: recovered.record.seq };
				this.chainSeq = checkpoint.seq;
				this.chainTip = checkpoint.hash;
			} else if (!recovered.record && recovered.size > 0) {
				// Bytes, but no record this can read, and no checkpoint to fall back on.
				// Appending here would write `seq: 1` on top of a file that already holds
				// something, producing a chain no verifier can reconstruct — so it appends
				// nothing at all and every fail-closed tool is refused with a reason an
				// operator can act on. This is the fail-closed answer, not a silent restart.
				this.refuseWrites = recovered.exhausted
					? `${path} holds ${recovered.size} byte(s) but no readable audit record, so the chain's position is unknown`
					: `${path} holds no readable audit record in its last ${this.maxScanBytes} byte(s), so the chain's position is unknown`;
				this.writable = false;
				return { records: 0, tip: null, durable: false, error: this.refuseWrites };
			}

			if (recovered.size > 0) {
				// Terminate a half-written trailing line before anything else is appended.
				//
				// A process killed mid-write leaves a fragment with no newline. Appending
				// the next record straight onto it would join the two into a single
				// unparseable line — swallowing the new record while `append` reported
				// `written: true`, so a fail-closed tool would run with no readable record
				// of it. This is not deleting evidence: the fragment stays exactly as it
				// is, still unparseable and still counted by `verify`; it only stops being
				// able to consume the record that follows it.
				this.terminateTrailingFragment(path);
			}
			// Prove the sink is writable now rather than discovering it on the first
			// fail-closed call, which would deny a claim for a reason an operator could
			// have been told about at boot. 0600 like a closed segment: the trail is read
			// during incidents and nothing else on the host has business reading it.
			appendFileSync(path, "", { mode: 0o600 });
			this.activeBytes = statSync(path).size;
			// The segment a roll would close is named by its first record. Read it from the
			// file; when the head is unreadable the newest closed segment says where this
			// one must start, and a file with no segment beside it started the chain.
			this.activeFirstSeq =
				this.activeBytes === 0 ? null : (this.readFirstRecord(path)?.seq ?? (newest ? newest.lastSeq + 1 : 1));
			this.writable = true;
			return {
				records: this.chainSeq,
				tip: this.chainTip,
				durable: true,
				...(this.lostHistory ? { missingHistory: this.lostHistory } : {}),
			};
		} catch (cause) {
			this.writable = false;
			return {
				records: this.chainSeq,
				tip: this.chainTip,
				durable: false,
				error: this.redact(String(cause)),
				...(this.lostHistory ? { missingHistory: this.lostHistory } : {}),
			};
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
		if (this.refuseWrites !== null) {
			// The position is not known, so there is no honest `seq` to write. Refusing is
			// the whole point — see `open`.
			if (input.mode === "fail-closed") throw new AuditUnavailableError(input.tool, this.refuseWrites);
			return { record, written: false, error: this.refuseWrites };
		}

		const line = `${JSON.stringify(record)}\n`;
		const bytes = Buffer.byteLength(line);
		try {
			// A previous append threw, so it may have written part of a line. Close that
			// fragment off before this record goes on, or the two would join into one
			// unparseable line and this record would vanish into it.
			if (this.mayHaveFragment) {
				this.terminateTrailingFragment(path);
				this.mayHaveFragment = false;
				this.activeBytes = statSync(path).size;
			}
			// Roll *before* the record, never through it: a record is written whole into
			// whichever file it lands in, so no segment ends in half a line.
			if (this.rolloverBytes !== null && this.activeFirstSeq !== null && this.activeBytes + bytes > this.rolloverBytes) {
				this.rollover(path);
			}
			appendFileSync(path, line, { mode: 0o600 });
			this.activeBytes += bytes;
			this.activeFirstSeq ??= record.seq;
			this.commit(record);
			this.writeCheckpoint(record);
			return { record, written: true };
		} catch (cause) {
			const error = this.redact(String(cause));
			this.writable = false;
			this.mayHaveFragment = true;
			if (input.mode === "fail-closed") throw new AuditUnavailableError(input.tool, error);
			return { record, written: false, error };
		}
	}

	/**
	 * Append a newline if the file does not already end with one.
	 *
	 * One byte is read, so this is cheap enough to run at open and after any failed
	 * append — `appendFileSync` can write part of a line and then throw (ENOSPC), which
	 * leaves exactly the fragment this guards against.
	 */
	private terminateTrailingFragment(path: string): void {
		const size = statSync(path).size;
		if (size === 0) return;
		const last = Buffer.alloc(1);
		const fd = openSync(path, "r");
		try {
			readSync(fd, last, 0, 1, size - 1);
		} finally {
			closeSync(fd);
		}
		// A byte comparison is safe here: 0x0A never appears inside a multi-byte UTF-8
		// sequence, so a trailing 0x0A is always a real line terminator.
		if (last[0] !== 0x0a) appendFileSync(path, "\n");
	}

	/**
	 * Close the active file and start the next one at the same path.
	 *
	 * The active file is renamed to `<path>.<firstSeq>-<lastSeq>.jsonl` — same
	 * directory, 0600 — and nothing else changes: `chainSeq` and `chainTip` stand, so
	 * the next record's `prev` is the closed segment's tip hash and the chain crosses
	 * the boundary unbroken; the checkpoint already names that tip and is carried
	 * forward untouched; and `scan` reads closed segments in order before the active
	 * file, so a verdict covers every record whichever file it is in. This is what the
	 * old manual rotation (move the file, restart, accept a `prev: null` head) could
	 * not give: one chain, several files.
	 *
	 * A rename that fails leaves the active file where it was, and the record is
	 * appended there — the record outranks the rotation. The roll is retried on the
	 * next append, under a new `lastSeq`. A name that already exists is never
	 * overwritten; it means the range was closed once already, and that too is
	 * retried rather than clobbered.
	 *
	 * **A file holding no committed record is never rolled.** After the closed-segment
	 * recovery in `open`, the active file can be a terminated fragment and nothing
	 * else: `activeFirstSeq` is then the `seq` the next record *will* have, one past
	 * `chainSeq`. Rolling that file would name it by a reversed range (`4-3`), which
	 * `parseSegmentName` rejects — so the verifier would never read the fragment and
	 * a damaged write would verify clean (Greptile round 3). The record goes into
	 * that file instead; the roll waits for the one that follows, and the fragment
	 * then closes inside a readable `first-last` segment as the unparseable line it
	 * already is. The file's size overshoots the limit by one record, once.
	 */
	private rollover(path: string): void {
		if (this.activeFirstSeq === null || this.activeFirstSeq > this.chainSeq) return;
		const closed = segmentPath(path, this.activeFirstSeq, this.chainSeq);
		if (existsSync(closed)) return;
		try {
			renameSync(path, closed);
		} catch {
			return;
		}
		try {
			chmodSync(closed, 0o600);
		} catch {
			// The segment keeps the mode the active file had. It is still the chain.
		}
		this.activeBytes = 0;
		this.activeFirstSeq = null;
	}

	/**
	 * The first complete JSON line of a file, as a record, or null.
	 *
	 * Reads one window from the head — never less than `MAX_RECORD_BYTES`, so a record
	 * this writer produced always fits — and asks for nothing past the first newline.
	 * Only `open` needs it, to know what a roll would name the file.
	 */
	private readFirstRecord(path: string): AuditRecord | null {
		const size = statSync(path).size;
		const window = Math.min(this.tailBytes, size);
		if (window === 0) return null;
		const buffer = Buffer.alloc(window);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buffer, 0, window, 0);
		} finally {
			closeSync(fd);
		}
		const text = buffer.toString("utf8");
		const newline = text.indexOf("\n");
		if (newline < 0 && window < size) return null;
		try {
			const parsed: unknown = JSON.parse(newline < 0 ? text : text.slice(0, newline));
			return isAuditRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	/**
	 * Record the committed position beside the file.
	 *
	 * Written through a temporary file and renamed, so a crash mid-write leaves either
	 * the old checkpoint or the new one and never half of each — a torn checkpoint would
	 * itself read as missing history and raise a false alarm about the thing it exists to
	 * detect.
	 *
	 * A failure here is not an append failure: the record is already durable, and the
	 * worst a stale checkpoint can do is name an *earlier* position, which the check in
	 * `open` treats as sound. So it is swallowed rather than surfaced as a denial.
	 */
	private writeCheckpoint(record: AuditRecord): void {
		const target = this.checkpointPath;
		if (target === null) return;
		const temporary = `${target}.tmp`;
		try {
			const checkpoint: Checkpoint = { seq: record.seq, hash: record.hash, ts: record.ts };
			writeFileSync(temporary, `${JSON.stringify(checkpoint)}\n`);
			renameSync(temporary, target);
		} catch {
			try {
				unlinkSync(temporary);
			} catch {
				// Nothing to clean up, or nothing that can be. Either way the record stands.
			}
		}
	}

	/** The last committed position, or null when there is none to read. */
	private readCheckpoint(): Checkpoint | null {
		return this.checkpointPath === null ? null : readCheckpointFile(this.checkpointPath);
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
	 * skipped and counted — `verify` is what reports them, and it fails on them.
	 *
	 * Holds the whole trail in memory, so it is for a caller that genuinely needs every
	 * record. `scan` is the bounded form and is what `/evidence` uses.
	 */
	async readAll(): Promise<{ records: AuditRecord[]; unparseable: number }> {
		const collected: AuditRecord[] = [];
		const { unparseable } = await this.scan({ collect: () => true, into: collected });
		return { records: collected, unparseable };
	}

	/**
	 * One streaming pass: verify the chain, and collect only the records asked for.
	 *
	 * This is the fix for `/evidence` costing two full reads and two full parses of a
	 * file that has no compaction — one to verify and one to select the graph's records,
	 * with a third append landing in between. Now the verdict and the selection come out
	 * of the same pass, the file is read a line at a time rather than as one string, and
	 * what is held is the *selected* records rather than all of them. A graph's evidence
	 * therefore costs memory proportional to that graph's own records, whatever the trail
	 * grew to around them.
	 *
	 * `collect` decides what is *matched*. Every match is counted; only a bounded window
	 * of them is kept, and it is the **most recent** window, not the first. Keeping the
	 * first meant a graph past the cap listed its oldest records and dropped everything
	 * after — so a claim withdrawal or a batch correction, which by construction comes
	 * *after* the record it corrects, was the first thing to fall out. Nothing is kept at
	 * all by default, which is what makes a bare verification cost no memory beyond the
	 * walker and the tally.
	 */
	async scan(options: {
		collect?: (record: AuditRecord) => boolean;
		into?: AuditRecord[];
		/** How many matched records to keep. The tally covers every match regardless. */
		maxCollected?: number;
	} = {}): Promise<{
		verdict: ChainVerdict & { unparseable: number };
		records: AuditRecord[];
		unparseable: number;
		/** Complete over every matched record, including those outside the window. */
		stats: AuditStats;
		/** How many records matched, which may exceed `records.length`. */
		matched: number;
		/** Closed segments read before the active file. 0 for a memory-only chain. */
		segments: number;
		/** The first and last readable record on disk, or null when there is none. */
		firstSeq: number | null;
		lastSeq: number | null;
	}> {
		const collected = options.into ?? [];
		const keep = options.collect;
		const maxCollected = options.maxCollected ?? Number.POSITIVE_INFINITY;
		const path = this.options.path;

		let unparseable = 0;
		let segments = 0;
		let firstSeq: number | null = null;
		let lastSeq: number | null = null;

		/**
		 * The window over the newest matches, as a real ring.
		 *
		 * Not a push-and-splice: dropping the first entry of a full window costs a shift of
		 * the whole window, so a graph past the cap paid that per matching record and the
		 * scan went quadratic — on the request this whole single-pass rework exists to make
		 * cheap. One write per match here, and one rotation at the end.
		 *
		 * An unbounded window (`readAll`) needs no ring and gets none.
		 */
		const bounded = Number.isFinite(maxCollected);
		let ring: AuditRecord[] = [];
		let written = 0;
		let walker = new ChainWalker({ genesis: this.requireGenesis() });
		let tally = new StatsAccumulator();
		let matched = 0;
		/** Whether the record at the boot checkpoint's `seq` still hashes to its hash. */
		let anchorSeen = false;
		let anchorHeld = true;

		const offer = (record: AuditRecord): void => {
			if (!keep?.(record)) return;
			matched++;
			// Counted first and unconditionally: the tally describes every decision for
			// this selection, and the window below describes only what a bundle can list.
			tally.push(record);
			if (maxCollected <= 0) return;
			if (!bounded) {
				collected.push(record);
				return;
			}
			ring[written % maxCollected] = record;
			written++;
		};

		const checkAnchor = (record: AuditRecord): void => {
			if (!this.anchor || record.seq !== this.anchor.seq) return;
			anchorSeen = true;
			if (record.hash !== this.anchor.hash) anchorHeld = false;
		};

		/**
		 * Fresh state for one pass. The walk may run more than once when the writer
		 * rolls the file over underneath it (see `walkAuditFiles`), and a verdict, a
		 * tally or a window carried from an abandoned pass would double-count.
		 */
		const begin = (): { walker: ChainWalker; onRecord: (record: AuditRecord) => void } => {
			walker = new ChainWalker({ genesis: this.requireGenesis() });
			tally = new StatsAccumulator();
			ring = bounded ? new Array<AuditRecord>(Math.max(maxCollected, 0)) : [];
			written = 0;
			matched = 0;
			anchorSeen = false;
			anchorHeld = true;
			collected.length = 0;
			return {
				walker,
				onRecord: (record) => {
					checkAnchor(record);
					offer(record);
				},
			};
		};

		if (path === null) {
			const pass = begin();
			for (const record of this.retained) {
				pass.walker.push(record);
				firstSeq ??= record.seq;
				lastSeq = record.seq;
				pass.onRecord(record);
			}
		} else {
			const walked = await walkAuditFiles(path, begin);
			unparseable = walked.unparseable;
			segments = walked.segments;
			firstSeq = walked.firstSeq;
			lastSeq = walked.lastSeq;
		}

		// Unroll the ring once, oldest first. `written` past the cap means it wrapped, so
		// the oldest kept entry is wherever the next write would have gone.
		if (bounded && written > 0) {
			const start = written % maxCollected;
			const wrapped = written > maxCollected;
			const order = wrapped ? [...ring.slice(start), ...ring.slice(0, start)] : ring.slice(0, written);
			for (const record of order) collected.push(record);
		}

		// The anchor is checked here rather than only at boot because the file can be
		// replaced while the process runs, and because a file *ahead* of the checkpoint
		// cannot be judged by its tip alone — the record at the committed `seq` is the one
		// that has to still be the committed record.
		if (this.anchor && anchorSeen && !anchorHeld && !this.lostHistory) {
			this.lostHistory = { kind: "rewritten", checkpointSeq: this.anchor.seq, foundSeq: this.chainSeq };
		}

		return {
			verdict: { ...walker.verdict(), unparseable },
			records: collected,
			unparseable,
			stats: tally.stats(),
			matched,
			segments,
			firstSeq,
			lastSeq,
		};
	}

	/**
	 * Whether this chain is required to open at `seq: 1`.
	 *
	 * The genesis check applies to a **file**, which holds every record ever appended.
	 * A memory-only chain answers from a bounded tail, so once it has dropped anything
	 * it opens past `seq: 1` legitimately — requiring genesis of it reported every
	 * local-dev process past its retention as a broken chain, which is a false alarm in
	 * the same bundle the real check exists to protect.
	 */
	private requireGenesis(): boolean {
		return this.options.path !== null || this.retained.length === this.chainSeq;
	}

	/**
	 * Recompute the chain on disk.
	 *
	 * **Missing history fails the verdict, whatever the surviving records say.** A file
	 * whose earlier records were deleted can be internally consistent from its new first
	 * line onward, and an evidence bundle reads `ok` alone — so the checkpoint's word
	 * that there were more comes first. `open` documents how the two states are told
	 * apart.
	 *
	 * **An unparseable line fails the verdict.** It used to be counted alongside an
	 * `ok: true`, which meant a file holding a corrupt or half-written record could be
	 * reported as intact — and it would have attested to a chain with a hole in it. A
	 * record that cannot be read cannot be verified, and "cannot be verified" is not
	 * "verified".
	 *
	 * The chain check runs before the unparseable count when it also fails, because a
	 * hash or `prev` mismatch names a specific tampered position and is the more useful
	 * answer; an unparseable line is reported when the readable records are otherwise
	 * sound.
	 */
	async verify(): Promise<ChainVerdict & { unparseable: number }> {
		const { verdict } = await this.scan();
		return this.judge(verdict);
	}

	/**
	 * The whole chain on disk, judged, with the segment count and the span.
	 *
	 * On a log that is not open this is `verifyAuditSegments` — the read-only
	 * verifier, which never touches the active file. On a log that *is* open the
	 * anchor is the one `open` read and the answer is `verify`'s with the extra fields.
	 */
	async report(): Promise<AuditReport> {
		const path = this.options.path;
		if (path !== null && !this.opened) return verifyAuditSegments(path, this.checkpointPath);
		const { verdict, segments, firstSeq, lastSeq } = await this.scan();
		return reportFrom(this.judge(verdict), segments, firstSeq, lastSeq);
	}

	/**
	 * The verdict, and one graph's records, from a single pass over the file.
	 *
	 * What `/evidence` calls. See `scan` for why there is only one pass.
	 *
	 * **The graph id is sanitised the same way the records were.** `buildRecord` redacts
	 * and caps `graph_id` like every other stored field, so a graph whose identifier
	 * contains a credential-shaped substring is stored under its redacted form — and
	 * selecting on the raw identifier then matched none of its own records, so its
	 * evidence bundle silently omitted every decision made about it. Normalising the
	 * query to match the stored form is what the ledger already does for the same reason
	 * (`verifyGraph` reads by `normalizeIdentifier(graphId)`), so the two paths agree.
	 *
	 * `selector` is returned so a caller can say when it differs from what was asked for:
	 * two identifiers that redact identically select each other's records, which is the
	 * residual cost of storing a redacted key and belongs in the bundle rather than in a
	 * comment.
	 */
	async verifiedView(
		graphId: string,
		limit?: number,
	): Promise<{
		verdict: ChainVerdict & { unparseable: number };
		records: AuditRecord[];
		/** Records in the file, for comparison with the graph's own count. */
		total: number;
		/** Complete over every record naming this graph, not just the listed window. */
		stats: AuditStats;
		/** How many records name this graph, which may exceed `records.length`. */
		matched: number;
		/** The form the selection actually used. Differs from `graphId` only if redacted. */
		selector: string;
	}> {
		const selector = sanitizeField(graphId, MAX_IDENTIFIER, this.redact) ?? graphId;
		const { verdict, records, stats, matched } = await this.scan({
			collect: (record) => record.graph_id === selector,
			...(limit === undefined ? {} : { maxCollected: limit }),
		});
		return { verdict: this.judge(verdict), records, total: verdict.records, stats, matched, selector };
	}

	/** The reported verdict: what the walker found, plus what the file cannot show. */
	private judge(verdict: ChainVerdict & { unparseable: number }): ChainVerdict & { unparseable: number } {
		return judgeVerdict(verdict, this.lostHistory);
	}

	/**
	 * The last complete JSON line of the file.
	 *
	 * Reads the tail rather than the whole file: this runs at boot, and an audit log
	 * has no compaction. A tail that happens to start mid-line is handled by dropping
	 * everything before the first newline — unless the whole file fits in the window,
	 * where the first line is genuinely the first record.
	 *
	 * **The window grows when it has to.** A fixed 64 KiB tail assumed the last record
	 * fit in it, and a caller could choose otherwise: a long enough argument name or tool
	 * name produced a record that filled the window with nothing but its own fragments,
	 * recovery found no complete record, and the writer restarted at `seq: 1` on top of a
	 * file that already held a chain — so every later fail-closed call appended to
	 * something no verifier could reconstruct. Records are size-bounded now
	 * (`MAX_RECORD_BYTES`, and the window is never smaller than it), and the scan also
	 * doubles its way back to `maxScanBytes` so a record written by some *other* version
	 * of this code is found rather than skipped past. If nothing is found even so, the
	 * caller refuses to append at all: see `open`.
	 */
	private readLastRecord(path: string): { record: AuditRecord | null; size: number; exhausted: boolean } {
		const size = statSync(path).size;
		if (size === 0) return { record: null, size: 0, exhausted: true };
		let window = Math.min(this.tailBytes, size);
		for (;;) {
			const record = this.scanTail(path, size, window);
			if (record) return { record, size, exhausted: window >= size };
			if (window >= size) return { record: null, size, exhausted: true };
			if (window >= this.maxScanBytes) return { record: null, size, exhausted: false };
			window = Math.min(size, Math.max(window * 2, this.tailBytes));
		}
	}

	/** The last parseable record in the final `window` bytes, or null. */
	private scanTail(path: string, size: number, window: number): AuditRecord | null {
		const buffer = Buffer.alloc(window);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buffer, 0, window, size - window);
		} finally {
			closeSync(fd);
		}
		let text = buffer.toString("utf8");
		if (window < size) {
			const firstNewline = text.indexOf("\n");
			text = firstNewline < 0 ? "" : text.slice(firstNewline + 1);
		}
		const lines = text.split("\n").filter((line) => line.trim().length > 0);
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const parsed: unknown = JSON.parse(lines[i] as string);
				// The shape check matters here as much as in `verify`: continuing the chain
				// from a line holding `null` would throw on `.seq` at boot.
				if (isAuditRecord(parsed)) return parsed;
			} catch {
				// A partial trailing line, or a truncated tail window. Keep walking back.
			}
		}
		return null;
	}
}

/** How many times a walk starts over when the writer rolls the file underneath it. */
export const MAX_WALK_ATTEMPTS = 3;

/**
 * Every closed segment in sequence order, then the active file, through one walker.
 *
 * A closed segment and the active file are read by the same rule because they are
 * the same chain: the walker carries `prev` and `seq` across the boundary, so a
 * segment that does not continue the one before it is reported exactly as a gap
 * inside a single file would be. A segment is never skipped: a verdict over the
 * active file alone would be a verdict over a chain that opens past `seq: 1`,
 * which is exactly what the head check refuses — and rightly, since the records
 * before it are in the segments.
 *
 * **The set of files is read stably, or read again.** The writer can roll over
 * between this listing the segments and this opening the active file: the
 * segment it just closed is then not in the list, and the active file starts past
 * the records that went into it — so an intact chain would read as a `seq` jump.
 * A pass therefore records which segments it read and where the active file began,
 * re-lists afterwards, and starts over (fresh walker and sink from `begin`, at most
 * `MAX_WALK_ATTEMPTS` times) when a segment appeared or the active file did not
 * begin at the last closed segment's `lastSeq + 1`. A chain that is genuinely
 * broken at that boundary fails the same check every time and is reported after the
 * last attempt, exactly as the walker found it.
 *
 * `begin` is called once per pass and hands back the walker and the record sink for
 * it. Shared by `AuditLog.scan` and `verifyAuditSegments`, so the writer and the
 * read-only verifier cannot disagree about which files hold the chain.
 */
export async function walkAuditFiles(
	path: string,
	begin: () => { walker: ChainWalker; onRecord: (record: AuditRecord) => void },
): Promise<{ unparseable: number; segments: number; firstSeq: number | null; lastSeq: number | null; attempts: number }> {
	for (let attempt = 1; ; attempt++) {
		const closed = listAuditSegments(path);
		const { walker, onRecord } = begin();
		let unparseable = 0;
		let firstSeq: number | null = null;
		let lastSeq: number | null = null;
		let activeFirstSeq: number | null = null;
		const scanFile = async (file: string, active: boolean): Promise<void> => {
			for await (const line of readLines(file)) {
				if (line.trim().length === 0) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					unparseable++;
					continue;
				}
				// A line that parses but is not a record is a *chain* fault, not an
				// unparseable line: the walker reports it as one rather than throwing while
				// reading fields off it — which used to reach `/evidence` as an HTTP 500.
				walker.push(parsed);
				if (isAuditRecord(parsed)) {
					firstSeq ??= parsed.seq;
					lastSeq = parsed.seq;
					if (active) activeFirstSeq ??= parsed.seq;
					onRecord(parsed);
				}
			}
		};
		for (const segment of closed) await scanFile(segment.path, false);
		if (existsSync(path)) await scanFile(path, true);

		const result = { unparseable, segments: closed.length, firstSeq, lastSeq, attempts: attempt };
		if (attempt >= MAX_WALK_ATTEMPTS) return result;
		const after = listAuditSegments(path);
		const sameSet = after.length === closed.length && after.every((segment, i) => segment.path === closed[i]?.path);
		const newest = closed[closed.length - 1];
		const continuous = newest === undefined || activeFirstSeq === null || activeFirstSeq === newest.lastSeq + 1;
		if (sameSet && continuous) return result;
	}
}

/** The checkpoint at `target`, or null when there is none this can trust. */
function readCheckpointFile(target: string): Checkpoint | null {
	if (!existsSync(target)) return null;
	try {
		const size = statSync(target).size;
		// A checkpoint is a few dozen bytes. Anything larger is not one, and reading it
		// whole would be trusting a file this is meant to be sceptical of.
		if (size === 0 || size > 4096) return null;
		const buffer = Buffer.alloc(size);
		const fd = openSync(target, "r");
		try {
			readSync(fd, buffer, 0, size, 0);
		} finally {
			closeSync(fd);
		}
		const parsed: unknown = JSON.parse(buffer.toString("utf8"));
		if (!parsed || typeof parsed !== "object") return null;
		const { seq, hash, ts } = parsed as Partial<Checkpoint>;
		if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
		if (typeof hash !== "string" || hash.length === 0) return null;
		return { seq, hash, ts: typeof ts === "string" ? ts : "" };
	} catch {
		// An unreadable checkpoint is not evidence of loss. Treated as absent, which
		// leaves the pre-checkpoint behaviour rather than inventing an alarm.
		return null;
	}
}

/** The reported verdict: what the walker found, plus what the file cannot show. See `AuditLog.verify`. */
function judgeVerdict(
	verdict: ChainVerdict & { unparseable: number },
	lostHistory: MissingHistory | null,
): ChainVerdict & { unparseable: number } {
	if (lostHistory) {
		const { kind, checkpointSeq, foundSeq } = lostHistory;
		return {
			ok: false,
			records: verdict.records,
			// `NO_POSITION`: the records that would name the position are the ones that
			// are gone or replaced. Callers rendering a verdict check for it rather than
			// printing "broken at -1" — see `chainRow` in @substrate/evidence.
			brokenAt: NO_POSITION,
			reason:
				kind === "missing"
					? `the audit file is missing history: this chain committed ${checkpointSeq} record(s) and the file now ` +
						`accounts for ${foundSeq}, so ${checkpointSeq - foundSeq} earlier decision(s) are not in it — ` +
						"the file was deleted or truncated after they were written"
					: `the audit file does not hold the records this chain committed: the record at seq ${checkpointSeq} is ` +
						"not the one whose hash was checkpointed, so the file has been replaced with a different chain — " +
						"the decisions it now shows are not the decisions that were made",
			unparseable: verdict.unparseable,
		};
	}
	if (!verdict.ok) return verdict;
	if (verdict.unparseable > 0) {
		return {
			ok: false,
			records: verdict.records,
			brokenAt: NO_POSITION,
			reason: `${verdict.unparseable} line(s) could not be parsed, so the records they hold cannot be verified`,
			unparseable: verdict.unparseable,
		};
	}
	return verdict;
}

function reportFrom(
	judged: ChainVerdict & { unparseable: number },
	segments: number,
	firstSeq: number | null,
	lastSeq: number | null,
): AuditReport {
	return {
		segments,
		records: judged.records,
		firstSeq,
		lastSeq,
		ok: judged.ok,
		unparseable: judged.unparseable,
		...(judged.ok ? {} : { brokenAt: judged.brokenAt, reason: judged.reason }),
	};
}

/**
 * Verify the chain at `path` — every closed segment, then the active file — without
 * an `AuditLog` and without writing.
 *
 * What `scripts/audit-verify.ts` prints. `AuditLog.open` proves the sink writable by
 * appending to the active file, and a verifier running beside the single writer must
 * not touch that file; nor does a verifier need a redactor, since it prints nothing a
 * record holds. So this reads the checkpoint itself (`<path>.checkpoint` unless named)
 * and anchors the walk to it the way boot would: a checkpoint past the last record on
 * disk is **missing history** — a file or segment truncated or removed after those
 * records were committed; a record at the checkpoint's `seq` with another hash is
 * **rewritten history**. Both fail the verdict whatever the surviving records say,
 * by the same rules as `AuditLog.verify`.
 */
export async function verifyAuditSegments(path: string, checkpointPath: string | null = `${path}.checkpoint`): Promise<AuditReport> {
	const anchor = checkpointPath === null ? null : readCheckpointFile(checkpointPath);
	let walker = new ChainWalker({ genesis: true });
	let rewritten = false;
	const { unparseable, segments, firstSeq, lastSeq } = await walkAuditFiles(path, () => {
		walker = new ChainWalker({ genesis: true });
		rewritten = false;
		return {
			walker,
			onRecord: (record) => {
				if (anchor && record.seq === anchor.seq && record.hash !== anchor.hash) rewritten = true;
			},
		};
	});
	let lostHistory: MissingHistory | null = null;
	if (anchor && (lastSeq ?? 0) < anchor.seq) {
		lostHistory = { kind: "missing", checkpointSeq: anchor.seq, foundSeq: lastSeq ?? 0 };
	} else if (anchor && rewritten) {
		lostHistory = { kind: "rewritten", checkpointSeq: anchor.seq, foundSeq: lastSeq ?? 0 };
	}
	return reportFrom(judgeVerdict({ ...walker.verdict(), unparseable }, lostHistory), segments, firstSeq, lastSeq);
}

/**
 * The file's lines, one at a time.
 *
 * A stream rather than `Bun.file(path).text()`, so verifying a trail does not first
 * hold the whole trail as one string. The remainder buffer is what makes a line split
 * across two chunks still arrive whole.
 */
async function* readLines(path: string): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let rest = "";
	for await (const chunk of Bun.file(path).stream()) {
		rest += decoder.decode(chunk as Uint8Array, { stream: true });
		// Cut the buffer once per chunk rather than once per line. Re-slicing after every
		// line copies the whole remainder each time, which on a file of short records is
		// quadratic in the chunk size — an accidental cost in the one place that exists to
		// remove one.
		let start = 0;
		let newline = rest.indexOf("\n", start);
		while (newline >= 0) {
			yield rest.slice(start, newline);
			start = newline + 1;
			newline = rest.indexOf("\n", start);
		}
		rest = start === 0 ? rest : rest.slice(start);
	}
	rest += decoder.decode();
	if (rest.length > 0) yield rest;
}
