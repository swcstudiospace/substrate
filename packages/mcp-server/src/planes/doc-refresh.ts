/**
 * Phase 102 F3 — Greptime event-driven doc refresh.
 *
 * File/change events in Greptime `agent_events` trigger debounced, coalesced
 * re-ingest of the affected docs. The poll loop reads forward-only from a
 * durable file-backed cursor (survives restarts), bursts for one doc collapse
 * to a single re-ingest inside a per-doc window, and every permanently failed
 * doc lands in the phase-76 `DeadLetterStore` (reason `exhausted`) with
 * replay fields — nothing is silently dropped.
 *
 * Single-writer rule: the actual re-ingest goes through the F1 ingest writer
 * (`executeIngest` in `packages/cli/src/corpus/ingest.ts`) and nothing else.
 * This module never touches LightRAG directly: production wires F1's
 * `executeIngest` (adapted to one doc) in as the injected `IngestFn`, and
 * tests inject a recording fake. Reads are fail-open: a Greptime failure
 * resolves to `held`, the cursor does not advance, and no ingest is attempted.
 *
 * F5 handoff: every finished doc yields a {@link RefreshOutcome}
 * (`docKey`, `outcome`, `cursor`, `attempts`) for F5 steering to consume.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { canonicalJson } from "../event.ts";
import type { DeadLetterStore } from "../event-dead-letter.ts";
import { outboxBackoffMs } from "../outbox-file.ts";
import type { SubstrateEvent } from "../types.ts";

/** Greptime `agent_events` kinds that name a file/doc change. Everything else is ignored. */
export const FILE_CHANGE_KINDS = ["file.edit", "file-change"] as const;

/** Per-doc debounce window: bursts for one doc collapse to one re-ingest. */
export const DEFAULT_DEBOUNCE_WINDOW_MS = 60_000;
/** Bounded ingest attempts per doc before the DLQ record. */
export const DEFAULT_REFRESH_MAX_ATTEMPTS = 5;
/** Retry pacing, mirroring the phase-76 event buffer discipline (`event-buffer.ts`). */
export const REFRESH_BACKOFF = { base: 2_000, cap: 300_000 } as const;
/** The longest failure reason kept on a DLQ record: enough to read, never a dump. */
const REASON_MAX = 300;

/** One affected doc at one Greptime position. */
export interface DocRefreshEvent {
	docKey: string;
	cursor: number;
}

/** What F5 steering consumes per finished doc. */
export interface RefreshOutcome {
	docKey: string;
	outcome: "refreshed" | "dead-lettered";
	cursor: number;
	attempts: number;
}

/** Injectable Greptime read. `since` is the durable cursor; implementations return rows after it. */
export type GreptimeQuery = (sql: string, params: { since: number }) => Promise<Array<Record<string, unknown>>>;

export interface PollResult {
	/** Doc events mapped from file/change rows, in cursor order. Empty when held. */
	events: DocRefreshEvent[];
	/** Cursor to persist: the newest row seen, or `since` when held/empty. */
	cursor: number;
	/** True when the read failed and fail-open applied: cursor not advanced, no ingest. */
	held: boolean;
}

/** Narrow production shape for the one-doc plan handed to the F1 writer. */
export interface SingleDocRefreshPlan {
	docKey: string;
	cursor: number;
}

/**
 * The F1 writer interface. Production passes `executeIngest`
 * (`packages/cli/src/corpus/ingest.ts`) adapted to a single-doc plan; it is
 * the single writer — this module performs no other ingest-shaped write.
 */
export type IngestFn = (plan: SingleDocRefreshPlan) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringField(row: Record<string, unknown>, name: string): string | null {
	const value = row[name];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function numericField(row: Record<string, unknown>, name: string): number | null {
	const value = row[name];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function payloadOf(row: Record<string, unknown>): Record<string, unknown> | null {
	const payload = row["payload"];
	if (isRecord(payload)) return payload;
	if (typeof payload === "string") {
		try {
			const parsed: unknown = JSON.parse(payload);
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
	return null;
}

/** Map one Greptime row to a doc event, or null when it is not a usable file/change row. */
export function rowToDocEvent(row: Record<string, unknown>): DocRefreshEvent | null {
	const kind = stringField(row, "kind");
	if (kind === null || !(FILE_CHANGE_KINDS as readonly string[]).includes(kind)) return null;
	const cursor = numericField(row, "cursor") ?? numericField(row, "ingested_at");
	if (cursor === null) return null;
	const payload = payloadOf(row);
	const base =
		stringField(row, "doc") ??
		stringField(row, "path") ??
		(payload !== null ? (stringField(payload, "doc") ?? stringField(payload, "path")) : null);
	if (base === null) return null;
	const repo = stringField(row, "repo");
	const docKey = repo !== null && !base.startsWith(`${repo}:`) ? `${repo}:${base}` : base;
	return { docKey, cursor };
}

/** Kind filter + mapping for a batch of Greptime rows, in cursor order. */
export function filterFileChangeKinds(rows: Array<Record<string, unknown>>): DocRefreshEvent[] {
	const events: DocRefreshEvent[] = [];
	for (const row of rows) {
		const event = rowToDocEvent(row);
		if (event !== null) events.push(event);
	}
	events.sort((a, b) => a.cursor - b.cursor);
	return events;
}

/**
 * Poll `agent_events` for file/change rows after `since`.
 * Fail-open: a throwing query resolves to `{ events: [], cursor: since, held: true }`.
 */
export async function pollAgentEvents(query: GreptimeQuery, opts: { since: number }): Promise<PollResult> {
	const kinds = FILE_CHANGE_KINDS.map((kind) => `'${kind}'`).join(", ");
	const sql =
		`SELECT * FROM "agent_events" WHERE "kind" IN (${kinds}) AND "ingested_at" > ${opts.since} ` +
		`ORDER BY "ingested_at" ASC LIMIT 500`;
	let rows: Array<Record<string, unknown>>;
	try {
		rows = await query(sql, { since: opts.since });
	} catch (cause) {
		process.stderr.write(`[substrate] doc-refresh poll held: ${reasonOf(cause)}\n`);
		return { events: [], cursor: opts.since, held: true };
	}
	const events = filterFileChangeKinds(rows);
	let cursor = opts.since;
	for (const event of events) {
		if (event.cursor > cursor) cursor = event.cursor;
	}
	return { events, cursor, held: false };
}

/** Load the durable offset. Missing, unreadable, or malformed files fall back fail-open. */
export function loadCursor(path: string, fallback = 0): number {
	try {
		if (!existsSync(path)) return fallback;
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (isRecord(parsed)) {
			const cursor = parsed["cursor"];
			if (typeof cursor === "number" && Number.isFinite(cursor)) return cursor;
		}
		return fallback;
	} catch {
		return fallback;
	}
}

/** Persist the durable offset: atomic temp-file + rename, 0600 inside a 0700 directory. */
export function storeCursor(path: string, cursor: number): void {
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ cursor })}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
	} catch (cause) {
		process.stderr.write(`[substrate] doc-refresh cursor store failed: ${reasonOf(cause)}\n`);
	}
}

export interface CoalescerOptions {
	windowMs?: number;
	now?: () => number;
}

/**
 * Per-doc debounce/coalesce. The first event for a doc opens its window;
 * later events inside the window only refresh the latest cursor — the burst
 * collapses to one due item. The window never restarts, so a hot doc still
 * goes due (no starvation).
 */
export class DebounceCoalescer {
	private readonly windowMs: number;
	private readonly now: () => number;
	private readonly pending = new Map<string, { firstAt: number; latest: DocRefreshEvent }>();

	constructor(options: CoalescerOptions = {}) {
		this.windowMs = options.windowMs ?? DEFAULT_DEBOUNCE_WINDOW_MS;
		this.now = options.now ?? Date.now;
	}

	observe(event: DocRefreshEvent): void {
		const existing = this.pending.get(event.docKey);
		if (existing === undefined) {
			this.pending.set(event.docKey, { firstAt: this.now(), latest: event });
		} else {
			existing.latest = event;
		}
	}

	/** Items whose window expired (latest cursor per doc), removed from the pending set. */
	due(): DocRefreshEvent[] {
		const at = this.now();
		const out: DocRefreshEvent[] = [];
		for (const [docKey, entry] of this.pending) {
			if (at - entry.firstAt >= this.windowMs) {
				out.push(entry.latest);
				this.pending.delete(docKey);
			}
		}
		return out;
	}

	/** Every pending item regardless of window, cleared. For shutdown drains. */
	flush(): DocRefreshEvent[] {
		const out: DocRefreshEvent[] = [];
		for (const entry of this.pending.values()) out.push(entry.latest);
		this.pending.clear();
		return out;
	}

	size(): number {
		return this.pending.size;
	}
}

function reasonOf(cause: unknown): string {
	const text = cause instanceof Error ? cause.message : String(cause);
	return text.length > REASON_MAX ? text.slice(0, REASON_MAX) : text;
}

/** A valid ledger-shaped event naming a failed doc refresh, so the phase-76 DLQ can record it. */
function refreshFailedEvent(docKey: string, cursor: number, attempts: number, lastReason: string): SubstrateEvent {
	const unhashed: Omit<SubstrateEvent, "hash"> = {
		actor: "agent",
		branch: null,
		graph_id: null,
		id: `doc-refresh:${docKey}:${cursor}`,
		kind: "file.edit",
		linear_identifier: null,
		node_id: null,
		payload: { attempts, cursor, docKey, lastReason },
		prev: null,
		repo: null,
		session_id: null,
		step: null,
		summary: `doc refresh failed for ${docKey}`,
		surface: "substrate",
		ts: new Date().toISOString(),
	};
	return { ...unhashed, hash: createHash("sha256").update(canonicalJson(unhashed)).digest("hex") };
}

export interface RefresherOptions {
	ingest: IngestFn;
	deadLetter: DeadLetterStore;
	maxAttempts?: number;
	backoff?: { base: number; cap: number };
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	random?: () => number;
}

/**
 * Re-ingest due docs through the injected F1 writer with bounded retries.
 * Backoff follows the `event-buffer.ts` discipline (`outboxBackoffMs`); when
 * the budget is spent the doc is recorded to the reused `DeadLetterStore`
 * with reason `exhausted`, carrying doc key, cursor, attempts, and the last
 * reason for replay. Never throws for ingest failures: every doc ends
 * `refreshed` or `dead-lettered`.
 */
export class DocRefresher {
	private readonly ingest: IngestFn;
	private readonly deadLetter: DeadLetterStore;
	private readonly maxAttempts: number;
	private readonly backoff: { base: number; cap: number };
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly now: () => number;
	private readonly random: () => number;

	constructor(options: RefresherOptions) {
		this.ingest = options.ingest;
		this.deadLetter = options.deadLetter;
		this.maxAttempts = options.maxAttempts ?? DEFAULT_REFRESH_MAX_ATTEMPTS;
		this.backoff = options.backoff ?? { base: REFRESH_BACKOFF.base, cap: REFRESH_BACKOFF.cap };
		this.sleep = options.sleep ?? (async (ms: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, ms);
			await promise;
		});
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
	}

	async refreshDoc(docKey: string, cursor: number): Promise<RefreshOutcome> {
		const enqueuedAt = this.now();
		let attempts = 0;
		let lastReason = "";
		for (;;) {
			attempts += 1;
			try {
				await this.ingest({ docKey, cursor });
				return { docKey, outcome: "refreshed", cursor, attempts };
			} catch (cause) {
				lastReason = reasonOf(cause);
				if (attempts >= this.maxAttempts) {
					this.deadLetter.record(
						{
							event: refreshFailedEvent(docKey, cursor, attempts, lastReason),
							attempts,
							enqueued_at: enqueuedAt,
							last_reason: lastReason,
						},
						"exhausted",
					);
					return { docKey, outcome: "dead-lettered", cursor, attempts };
				}
				await this.sleep(outboxBackoffMs(attempts - 1, this.backoff, this.random));
			}
		}
	}

	/** Refresh every due item in order; each item is independent (see `refreshDoc`). */
	async refreshDue(items: DocRefreshEvent[]): Promise<RefreshOutcome[]> {
		const outcomes: RefreshOutcome[] = [];
		for (const item of items) {
			outcomes.push(await this.refreshDoc(item.docKey, item.cursor));
		}
		return outcomes;
	}
}
