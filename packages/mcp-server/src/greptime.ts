/**
 * GreptimeDB client over the HTTP SQL API.
 *
 * Greptime holds the append-only event ledger and nothing else. It is not the
 * source of record for memory — that is the Postgres/Timescale index — and no
 * agent reaches it directly: every write and every read goes through
 * substrate-mcp, which is what makes redaction and the hash chain unskippable.
 * See `docs/greptime-ledger.md`.
 *
 * It lives on a Railway account this host reaches over the public internet, so
 * every call is timed out and every failure is the caller's to handle — an
 * unreachable event store must never block an agent. Every HTTP call goes through
 * the ledger's plane gate (uplift-2 R2): after `SUBSTRATE_BREAKER_FAILURES`
 * consecutive transport failures or 5xx answers the breaker opens and `sql`
 * fails in microseconds with the same `GreptimeUnavailable` an unreachable
 * store raises, until `SUBSTRATE_BREAKER_OPEN_MS` has passed.
 *
 * uplift-2 R5 made the steady-state emit two calls instead of three or four:
 * the session's chain tip is remembered in a bounded LRU after one read, the
 * read itself is time-bounded, the stream reads carry time bounds, `/healthz`
 * proves writability with a one-row probe into `substrate_health`, the ledger's
 * size is reported, and the documented 180-day retention can be switched on
 * with `SUBSTRATE_LEDGER_TTL` — the one `ALTER` this client will ever send.
 */
import { BreakerOpenError, callPlane, type PlaneGate } from "@substrate/observability";
import { DEFAULT_LEDGER_SETTINGS, isGreptimeDuration, type GreptimeConfig, type LedgerSettings } from "./config.ts";
import { redact, redactKnown } from "./redact.ts";
import { IDEMPOTENCY_KEY_PATTERN, IDEMPOTENCY_PAYLOAD_KEY, type StoredLeaf } from "./event.ts";
import type { SubstrateEvent } from "./types.ts";
import { HOUR_MS, hourEnd, hourIso, hourStart, isClosed } from "@substrate/ledger";
import { DEFAULT_METRICS_HISTORY_TTL, parseMetricsHistoryTtl } from "./config.ts";
import {
	MAX_METRIC_BATCH,
	MAX_METRIC_POINTS,
	effectiveHistoryStep,
	ALL_METRIC_SERIES,
	canonicalLabels,
	readLabels,
	type MetricDropReason,
	type MetricSampleRow,
} from "./metrics-history.ts";

const DEFAULT_TIMEOUT_MS = 5000;

export class GreptimeError extends Error {
	/**
	 * The store said the table does not exist. Decided from the text the store sent, before
	 * any credential scrub, because scrubbing a configured user such as `found` replaces that
	 * word inside `Table not found` with the redaction marker and the wording is gone from `message`.
	 */
	readonly missingTable: boolean;

	constructor(message: string, options: { missingTable?: boolean } = {}) {
		super(message);
		this.missingTable = options.missingTable === true;
	}
}

/**
 * The ledger did not answer, or answered broken: unreachable, timed out, a 5xx,
 * or refused by an open breaker. Only these charge the breaker — a SQL error is
 * the statement's fault and the store is fine.
 */
export class GreptimeUnavailable extends GreptimeError {}

/** An open breaker refused the call: the plane was not asked. Still `GreptimeUnavailable` to every existing caller. */
export class GreptimeBreakerOpen extends GreptimeUnavailable {}

/**
 * The bounded operation label for a statement: its leading verb. Never the
 * statement itself, which would put every distinct query into a metric series.
 */
export function sqlOp(statement: string): "select" | "insert" | "show" | "create" | "alter" | "other" {
	const verb = /^\s*(select|insert|show|create|alter)\b/i.exec(statement)?.[1]?.toLowerCase();
	return verb === "select" || verb === "insert" || verb === "show" || verb === "create" || verb === "alter" ? verb : "other";
}

export interface GreptimeClientOptions {
	timeoutMs?: number;
	clock?: () => number;
	/** The ledger's plane gate; null runs every call unwrapped, as before breakers existed. */
	gate?: PlaneGate | null;
	/** Chain cache, lookback, write probe and TTL knobs (uplift-2 R5); the defaults when omitted. */
	ledger?: LedgerSettings;
}

/** A statement the ledger client refuses to send. See `assertAppendOnly`. */
export class AppendOnlyViolation extends GreptimeError {}
/**
 * The event row is stored but its ingest record is not, so the event will not
 * be anchored. `Substrate.append` maps this to `stored: true` with a warning
 * rather than un-storing the event — retrying the emit would mint a second
 * event with a new id. See D27-09.
 */
export class IngestNotRecorded extends GreptimeError {
	constructor(readonly eventId: string, cause: unknown) {
		super(`event ${eventId} stored, but its ingest write could not be confirmed: ${String(cause)}`);
	}
}

/**
 * How long after an hour ends before it counts as closed. Far above the 5 s
 * write timeout, so a record stamped inside an hour is visible before the hour
 * counts as closed. Phase 28 schedules its anchor timer around this constant.
 */
export const INGEST_LAG_MS = 300_000;

/**
 * How long both ingest attempts may take together, after the event row is stored.
 *
 * `substrate emit` aborts at 1.5 s and the Grok collector and git hook at 3 s.
 * Each statement otherwise waits up to {@link DEFAULT_TIMEOUT_MS}, so two ingest
 * attempts could add 10 s after a row that already landed — the caller gives up
 * and reports the server unreachable even though the event is stored. One second
 * fits inside the shorter deadline when that write was quick. A second attempt
 * runs only with whatever of the second is left.
 */
export const INGEST_BUDGET_MS = 1_000;

/**
 * Rows one page of the idempotency lookup reads: the cell's rows at one exact `ts`, in `id` order,
 * matched against the key in code. The lookup pages through the cell, so this is a page size and
 * not a cap on the rows a cell may hold; see {@link IDEMPOTENCY_LOOKUP_MAX_PAGES}.
 */
export const IDEMPOTENCY_LOOKUP_LIMIT = 5;
/** Full pages one lookup reads before it gives up as inconclusive. */
export const IDEMPOTENCY_LOOKUP_MAX_PAGES = 20;
/** The ids keyset paging can carry safely: the substrate's `evt_<hex>` and anything shaped like it. */
const IDEMPOTENCY_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Columns of `agent_events`, in the order every statement uses them. */
export const EVENT_COLUMNS = [
	"ts",
	"id",
	"surface",
	"session_id",
	"graph_id",
	"node_id",
	"linear_identifier",
	"step",
	"repo",
	"branch",
	"actor",
	"kind",
	"summary",
	"payload",
	"hash",
	"prev",
] as const satisfies ReadonlyArray<keyof SubstrateEvent>;

/** `"ts", "id", …` — the column list as SQL, quoted because Greptime reserves `id`. */
export const EVENT_COLUMN_LIST = EVENT_COLUMNS.map((column) => `"${column}"`).join(", ");

/**
 * Columns a caller may narrow a ledger read by.
 *
 * A fixed set, and the only place a column name reaches a `WHERE` clause: a
 * queried column is never a caller's string, so no filter can name `payload`,
 * reach another table or add a clause of its own. What a caller supplies is only
 * ever a *value*, and every value goes through {@link quote}.
 */
export const QUERYABLE_COLUMNS = [
	"session_id",
	"graph_id",
	"node_id",
	"linear_identifier",
	"repo",
	"branch",
	"surface",
	"kind",
	"actor",
] as const satisfies ReadonlyArray<keyof SubstrateEvent>;
export type QueryableColumn = (typeof QUERYABLE_COLUMNS)[number];

/**
 * Rows one read may return.
 *
 * The cap is the reply's, not the ledger's: a query answers an agent over MCP, and
 * 500 events already exceeds what is useful to read in a turn. `payload` is up to
 * 16 KB an event, which is why it is only selected when asked for.
 */
export const MAX_QUERY_LIMIT = 500;
export const DEFAULT_QUERY_LIMIT = 50;
/** Rows one `readRecentEvents` read may return at most. */
export const MAX_RECENT_EVENTS = 200;

/** A ledger read. Values are expected already normalised — see `Substrate.queryEvents`. */
export interface EventQuery {
	/** Equality filters, keyed by column. `undefined` and `null` values are dropped. */
	match?: Partial<Record<QueryableColumn, string | null | undefined>>;
	/** Inclusive ISO bounds on `ts`. */
	since?: string;
	until?: string;
	limit?: number;
	/** `desc` (the default) reads the newest events first. */
	order?: "asc" | "desc";
	includePayload?: boolean;
}

/** One member of a closed ingest hour, in position order. */
export interface HourLeaf {
	/** The event id, as stored in `event_ingest` and `agent_events`. */
	event_id: string;
	/** Epoch milliseconds of the member's first ingest record. */
	ingested_at: number;
	/** The 64 lowercase hex hash from the member's event row. */
	hash: string;
}

/**
 * One event's place in the ledger's ingest order: its id and the time of its
 * first ingest record (D27-10). This is the order a replay follows — not `ts`,
 * which a collector supplies and a backdated event can set in the past.
 */
export interface CursorPosition {
	id: string;
	ingestedAt: number;
	/**
	 * The event's own `ts`, from its ingest record, when the position came from
	 * {@link GreptimeClient.eventIdsAfter}. It is what lets `eventsByIds` bound
	 * its read on the time index instead of scanning every row for an id.
	 */
	eventTs?: number;
}

/**
 * How far before a stream cursor the anti-join in `eventIdsAfter` looks for an
 * earlier record of the same event. Two records for one event are a first
 * attempt and a retry inside {@link INGEST_BUDGET_MS} (1 s), so one hour is
 * three thousand times the gap that can exist; without the bound every poll
 * probed the whole ingest history before the cursor.
 */
export const INGEST_RETRY_LOOKBACK_MS = 3_600_000;

/** Where `/healthz` writes its probe rows; append-only with a one-day TTL so it never grows. */
export const HEALTH_TABLE = "substrate_health";

/** What the last write probe found; every field `null` until one has run (or while probing is off). */
export interface LedgerProbe {
	lastProbeAt: number | null;
	lastProbeOk: boolean | null;
	/** Redacted, host-free reason for the last failure; `null` after a success. */
	lastProbeError: string | null;
}

/** One table's share of the ledger, from `information_schema.region_statistics`. */
export interface LedgerTableCapacity {
	name: string;
	rows: number;
	diskBytes: number;
	sstBytes: number;
	indexBytes: number;
}

/** The ledger's size: totals over every table in the database, and the ten largest by disk. */
export interface LedgerCapacity {
	bytes: number;
	rows: number;
	tables: LedgerTableCapacity[];
}

/** Tables whose TTL `SUBSTRATE_LEDGER_TTL` governs — the two the retention policy names, and only these. */
export const TTL_TABLES = ["agent_events", "event_ingest"] as const;
export type TtlTable = (typeof TTL_TABLES)[number];

/**
 * Upper bound on the ids one batched hour-read statement carries.
 *
 * The hour read walks its members in batches so the id list stays small
 * enough for the HTTP SQL API: 500 ids are about 20 KB of statement text,
 * which the scratch server answered in tens of milliseconds.
 */
const IN_BATCH = 500;

/** A TIMESTAMP cell as epoch milliseconds; NaN for null, empty or non-numeric, which `Number()` would turn into 0. */
function epochMs(value: unknown): number {
	return value === null || value === undefined || value === "" ? Number.NaN : Number(value);
}

/** Clamp to a whole number of rows inside the cap; anything unusable falls back to the default. */
export function queryLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_QUERY_LIMIT;
	return Math.min(Math.max(Math.trunc(limit), 1), MAX_QUERY_LIMIT);
}

/**
 * Upper bound on the rows `lastHash` will pull for one session.
 *
 * This is a memory guard, not an ordering assumption. It deliberately cannot be
 * reached by ordinary use — a window small enough to be crossed would reintroduce
 * the bug it replaced, where a backfill appending older source timestamps pushed
 * the real chain tip out of view and the next append forked the chain.
 */
const MAX_SESSION_ROWS = 10_000;

/** How long a definite `append_mode` answer is trusted before it is asked again. */
const APPEND_MODE_TTL_MS = 30_000;

const DAY_MS = 86_400_000;

/**
 * The tip of a hash chain: the event nothing else points back to.
 *
 * Within a window of a session's newest rows, the newest is the one whose `hash`
 * no other row claims as its `prev`. The chain carries the order that a
 * millisecond timestamp loses. Falls back to the first row — newest by `ts` —
 * when the window holds no identifiable tip.
 */
export function chainTip(rows: Array<Record<string, unknown>>): string | null {
	const hashes = rows.filter((row) => typeof row.hash === "string").map((row) => String(row.hash));
	if (hashes.length === 0) return null;
	const claimed = new Set(rows.filter((row) => typeof row.prev === "string").map((row) => String(row.prev)));
	return hashes.find((hash) => !claimed.has(hash)) ?? hashes[0] ?? null;
}

/**
 * The `ttl` a `SHOW CREATE TABLE` answer carries, or `null` when the table has
 * none. Greptime prints options unquoted inside `WITH(...)` — `ttl = '180d'` —
 * and the DDL this client sends quotes the key; both spellings are read.
 */
export function ttlOf(ddl: string): string | null {
	const match = /\bttl'?\s*=\s*'([^']*)'/i.exec(ddl);
	const ttl = match?.[1];
	return ttl === undefined ? null : ttl.trim();
}

/** Two TTL spellings that mean the same retention: suffixes are case-insensitive and spaces optional. */
function sameTtl(a: string | null, b: string | null): boolean {
	const norm = (value: string | null): string | null => (value === null ? null : value.replace(/\s+/g, "").toLowerCase());
	return norm(a) === norm(b);
}

/**
 * Whether any value this event will store carries a backslash.
 *
 * The payload is stored as JSON, so its own escaping counts: a newline inside it
 * reaches the column as a `\n` two-character sequence, and how the server reads
 * that back depends on the same dialect a literal backslash does.
 */
function carriesBackslash(event: SubstrateEvent): boolean {
	if (JSON.stringify(event.payload).includes("\\")) return true;
	return EVENT_COLUMNS.some((column) => {
		const value = event[column];
		return typeof value === "string" && value.includes("\\");
	});
}

/**
 * Per-session chain tips, newest use last. A `Map` iterates in insertion order,
 * so re-inserting on every hit makes the first key the least recently used.
 */
class ChainTipCache {
	/** `null` is a known-empty session: its first event has no `prev`, and no read is owed. */
	private readonly tips = new Map<string, string | null>();

	constructor(readonly max: number) {}

	/** The tip, `null` for a session known to be empty, `undefined` for one never read. */
	get(sessionId: string): string | null | undefined {
		if (!this.tips.has(sessionId)) return undefined;
		const hash = this.tips.get(sessionId) ?? null;
		this.tips.delete(sessionId);
		this.tips.set(sessionId, hash);
		return hash;
	}

	set(sessionId: string, hash: string | null): void {
		this.tips.delete(sessionId);
		this.tips.set(sessionId, hash);
		while (this.tips.size > this.max) {
			const oldest = this.tips.keys().next().value;
			if (oldest === undefined) break;
			this.tips.delete(oldest);
		}
	}

	delete(sessionId: string): void {
		this.tips.delete(sessionId);
	}

	get size(): number {
		return this.tips.size;
	}
}

interface GreptimeResponse {
	output?: Array<{
		records?: {
			schema?: { column_schemas?: Array<{ name: string }> };
			rows?: unknown[][];
		};
		affectedrows?: number;
	}>;
	error?: string;
}

/**
 * The statement with every string literal blanked out.
 *
 * `assertAppendOnly` has to reason about SQL structure, and an event summary is
 * arbitrary agent text: it may well contain a `;` or a `--`. Blanking the
 * literals first means the guard can neither be fooled by that text nor trip
 * over it and drop a legitimate event.
 */
function withoutLiterals(statement: string): string {
	let out = "";
	let i = 0;
	while (i < statement.length) {
		if (statement[i] !== "'") {
			out += statement[i];
			i++;
			continue;
		}
		out += "''"; // placeholder: an empty literal, structurally where the real one was
		i++;
		while (i < statement.length) {
			if (statement[i] === "\\") {
				i += 2;
				continue;
			}
			if (statement[i] === "'") {
				if (statement[i + 1] === "'") {
					i += 2;
					continue;
				}
				i++;
				break;
			}
			i++;
		}
	}
	return out;
}

/**
 * The only verbs this client will send.
 *
 * Deny-by-default rather than a list of dangerous words: the point is that no
 * future code path — nor any SQL that reaches here from a tool argument — can
 * rewrite or remove a row that is already in the ledger. `create` is needed by
 * `migrate`, and is safe because every DDL here is `IF NOT EXISTS`.
 */
const APPEND_ONLY_VERBS = new Set(["select", "insert", "create", "show", "describe", "explain", "with"]);

/** Reject anything that could mutate the ledger, or smuggle a second statement past the verb check. */
export function assertAppendOnly(statement: string): void {
	const structure = withoutLiterals(statement)
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/--[^\n]*/g, " ")
		.trim();
	// Greptime's HTTP API accepts `;`-separated batches, so a single trailing
	// semicolon is all that may follow the one statement we are sending.
	if (structure.replace(/;\s*$/, "").includes(";")) {
		throw new AppendOnlyViolation("refusing a batched statement: the ledger takes one statement per call");
	}
	const verb = structure.match(/^[a-zA-Z]+/)?.[0].toLowerCase() ?? "";
	if (!APPEND_ONLY_VERBS.has(verb)) {
		throw new AppendOnlyViolation(`refusing ${verb || "an empty statement"}: the event ledger is append-only`);
	}
}

/**
 * SQL string literal. Greptime's HTTP API takes no bind parameters, so quoting
 * is ours to get right.
 *
 * `backslashEscapes` says whether the server reads `\` inside a literal as an
 * escape character; `GreptimeClient.probeDialect` asks it rather than guessing.
 * The default is the safe one: doubling a backslash against a server that does
 * not escape stores a wrong value, while failing to double it against one that
 * does leaves a way out of the literal.
 */
export function quote(value: string | number | null, backslashEscapes = true): string {
	if (value === null) return "NULL";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
	const escaped = backslashEscapes ? value.replace(/\\/g, "\\\\") : value;
	return `'${escaped.replace(/'/g, "''")}'`;
}

/**
 * One row of the production `anchors` table (D27-17), as the job reads it.
 *
 * Times are ISO strings; the table holds TIMESTAMPs and the HTTP API answers
 * them as epoch milliseconds, so the parse accepts either. `stale_hashes` is
 * NULL on every row the job writes — the column exists in production's shape
 * but has no meaning yet (deferred: giving it one).
 */
export interface AnchorRow {
	period_start: string;
	period_end: string;
	root: string;
	event_count: number;
	memo: string;
	tx_sig: string;
	signer: string;
	cluster: string;
	slot: number;
	anchored_at: string;
	stale_hashes: number | null;
}

/** What the anchor job writes: every column but `stale_hashes`, which stays NULL. */
export interface NewAnchor {
	period_start: string;
	period_end: string;
	root: string;
	event_count: number;
	memo: string;
	tx_sig: string;
	signer: string;
	/** Always `"devnet"`: mainnet is forbidden, and the type says so. */
	cluster: "devnet";
	slot: number;
	anchored_at: string;
}

/** One row of `graph_chain_leaves`: an event's place in its (graph, session) chain for one hour (D73-02). */
export interface GraphChainLeafRow {
	period_start: string;
	graph_id: string;
	session_id: string;
	/** Position in chain order, from 0. */
	seq: number;
	event_id: string;
	hash: string;
}

/** Leaf rows one `graph_chain_leaves` INSERT carries. */
const LEAF_INSERT_BATCH = 500;

/** The SELECT list every anchors read uses, in DDL column order. */
const ANCHOR_COLUMNS =
	`"period_start", "period_end", "root", "event_count", "memo", "tx_sig", ` +
	`"signer", "cluster", "slot", "anchored_at", "stale_hashes"`;

/** A TIMESTAMP cell as an ISO string, whether the server answered millis or text. */
function isoTime(value: unknown): string {
	const ms = typeof value === "number" ? value : Number(value);
	if (Number.isFinite(ms)) return new Date(ms).toISOString();
	const parsed = Date.parse(String(value));
	if (!Number.isFinite(parsed)) throw new GreptimeError("anchors row holds a time that is not a number");
	return new Date(parsed).toISOString();
}

function parseAnchorRow(row: Record<string, unknown>): AnchorRow {
	return {
		period_start: isoTime(row.period_start),
		period_end: isoTime(row.period_end),
		root: String(row.root),
		event_count: Number(row.event_count),
		memo: String(row.memo),
		tx_sig: String(row.tx_sig),
		signer: String(row.signer),
		cluster: String(row.cluster),
		slot: Number(row.slot),
		anchored_at: isoTime(row.anchored_at),
		stale_hashes: row.stale_hashes === null || row.stale_hashes === undefined ? null : Number(row.stale_hashes),
	};
}

/**
 * One event's first ingest record, for verify's hour report.
 *
 * Epoch milliseconds, parsed the same way as every other TIMESTAMP cell.
 */
export interface GraphIngestRecord {
	event_id: string;
	event_ts: number;
	ingested_at: number;
}

/**
 * How far back `anchorCoverage` looks for hours with ingest records and no
 * anchor row: the anchor job's own 7-day lookback (`ANCHOR_LOOKBACK_MS`), so
 * the probe reports exactly the hours the job would still pick up. Older
 * gaps are `substrate verify`'s `unanchored`, and a coverage read must stay
 * one bounded statement rather than a scan of the whole ingest history.
 */
export const COVERAGE_LOOKBACK_MS = 7 * 24 * HOUR_MS;

/** Uncovered hours one coverage report lists; beyond this `more` is set and the oldest are dropped. */
export const COVERAGE_MAX_UNCOVERED = 48;

/**
 * How long after an hour *starts* before it counts as eligible for coverage:
 * one hour, so the hour is closed (`INGEST_LAG_MS` after its end) and the
 * hourly anchor timer has had its tick. The steady-state lag is therefore 1,
 * never 0 — the current hour cannot be anchored yet.
 */
export const COVERAGE_ELIGIBLE_AGE_MS = HOUR_MS;

/**
 * How far back `anchorCoverage` looks for the newest `ledger archive` note.
 * Longer than any retention the policy names (180 d) with margin, so an
 * archive written before a TTL was switched on is still found; bounded, so the
 * read never scans the whole `substrate`/`note` series.
 */
export const ARCHIVE_NOTE_LOOKBACK_MS = 400 * 24 * HOUR_MS;

/** The `summary` prefix every archive note carries; `anchorCoverage` reads the newest by it. */
export const ARCHIVE_NOTE_PREFIX = "ledger archive ";

/**
 * The most events one export window's ingest map may hold (a day above it
 * refuses to archive, see `GreptimeClient.readExportIngest`): ~100 MB of
 * entries, inside the archive unit's 512M ceiling.
 */
export const EXPORT_INGEST_CAP = 500_000;

/**
 * How far before the first ingest read of an export window the fallback lookup
 * reaches: `ingested_at` is stamped by the collector process's clock just
 * before its INSERT (within `INGEST_BUDGET_MS`), so a row stamped slightly
 * earlier than the read can still commit after it. The ingest lag is the
 * system's own bound on clock skew and commit delay.
 */
export const EXPORT_INGEST_SKEW_MS = INGEST_LAG_MS;

/** What `anchorCoverage` found; see the method for each field's rule. */
export interface AnchorCoverage {
	/** ISO start of the newest anchored hour, or `null` when no hour was ever anchored. */
	newestAnchoredHour: string | null;
	/** Whole hours from the newest anchored hour to the current one; `1` is the steady state; `null` without an anchor. */
	lagHours: number | null;
	/** Eligible hours with ingest records and no anchor row, ISO, ascending; at most {@link COVERAGE_MAX_UNCOVERED}, the newest kept. */
	uncoveredHours: string[];
	/** Whether uncovered hours were dropped from the list to keep it bounded. */
	more: boolean;
	/** The newest `ledger archive` note the ledger holds, or `null` when no archive was ever recorded. */
	lastArchiveWindow: { day: string; writtenAt: string; eventId: string } | null;
}

/** A keyset position in `(ts, id)` order: the last row a page returned, and where the next starts after. */
export interface ExportCursor {
	/** ISO `ts` of the row. */
	ts: string;
	id: string;
}

/** One closed window of the ledger, `[from, to)` on `ts`, read in bounded pages. */
export interface ExportWindowQuery {
	/** Inclusive ISO lower bound on `ts`. */
	from: string;
	/** Exclusive ISO upper bound on `ts`. */
	to: string;
	/** Resume strictly after this `(ts, id)`; omit for the first page. */
	after?: ExportCursor | undefined;
	/** Rows per page, clamped like every other read (`queryLimit`). */
	limit?: number;
}

/** One event's first ingest record, ISO-stamped for the archive file. */
export interface ExportIngestRow {
	event_id: string;
	ingested_at: string;
	event_ts: string;
}

/** One page of an export window. */
export interface ExportPage {
	/** Event rows, every stored column, in `(ts, id)` ascending order. */
	events: Array<Record<string, unknown>>;
	/** The first ingest record of each event on this page that has one, in the events' order. */
	ingest: ExportIngestRow[];
	/** Anchor receipts whose period starts inside the window; the same rows on every page. */
	anchors: AnchorRow[];
	/** Where the next page starts, or `null` when this page was short — the window is exhausted. */
	next: ExportCursor | null;
}

/**
 * A TIMESTAMP-ish cell as epoch milliseconds, whatever unit the server chose.
 *
 * `date_bin` answers in the input column's unit over the HTTP API, and a
 * `to_unixtime` wrapper answers seconds; a text cell parses as ISO. The
 * magnitude decides: anything below 10^11 is seconds (that is the year 5138
 * in seconds, 1973 in milliseconds), 10^14 microseconds, 10^17 nanoseconds.
 * NaN when nothing fits, so a caller names the row instead of misfiling it.
 */
export function epochMsAnyUnit(value: unknown): number {
	if (value === null || value === undefined || value === "") return Number.NaN;
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) {
		const parsed = Date.parse(String(value));
		return Number.isFinite(parsed) ? parsed : Number.NaN;
	}
	if (Math.abs(n) < 1e11) return n * 1000;
	if (Math.abs(n) < 1e14) return n;
	if (Math.abs(n) < 1e17) return Math.floor(n / 1000);
	return Math.floor(n / 1_000_000);
}

/** An ISO instant, strictly: parseable, and `from < to` when both are given. */
function assertIsoWindow(from: string, to: string): { fromMs: number; toMs: number } {
	const fromMs = Date.parse(from);
	const toMs = Date.parse(to);
	if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new GreptimeError("export window bounds must be ISO instants");
	if (fromMs >= toMs) throw new GreptimeError("export window must be non-empty: from < to");
	return { fromMs, toMs };
}

/**
 * The shortest raw user or password worth scrubbing as a bare substring. Replacing a one-
 * or two-character value would splice a marker into every word of a diagnostic and still
 * leave the credential recoverable by elimination; such a value is covered through the
 * longer forms below (`user:password`, the `Basic` token) and by the redactor's own
 * patterns instead.
 */
const MIN_BARE_SECRET_LENGTH = 4;

/**
 * Every spelling of the endpoint's credentials a diagnostic could quote: the whole URL (it may
 * carry `user:password@`), the URL's userinfo parts raw and percent-decoded, the configured
 * user and password, the `user:password` pair, and the base64 `Basic` token the client sends.
 */
function credentialNeedles(config: GreptimeConfig): string[] {
	const needles: string[] = [config.url];
	if (config.user !== undefined) {
		const pair = `${config.user}:${config.password ?? ""}`;
		needles.push(config.user, pair, Buffer.from(pair).toString("base64"));
	}
	if (config.password !== undefined) needles.push(config.password);
	try {
		const { username, password } = new URL(config.url);
		for (const part of [username, password]) {
			needles.push(part);
			try {
				needles.push(decodeURIComponent(part));
			} catch {
				// A malformed escape has no decoded spelling to scrub.
			}
		}
	} catch {
		// A URL that does not parse has no userinfo to extract; the whole string is already listed.
	}
	const bare = needles.filter((needle) => needle === config.url || needle.length >= MIN_BARE_SECRET_LENGTH);
	// A JSON error body echoes a value in its escaped spelling (`pa"ss` arrives as `pa\"ss`),
	// which no longer contains the raw value. Longest first so the longer spelling is listed
	// ahead of any shorter one it overlaps.
	const spellings = new Set(bare);
	for (const needle of bare) spellings.add(JSON.stringify(needle).slice(1, -1));
	return [...spellings].sort((a, b) => b.length - a.length);
}

export class GreptimeClient {
	/** Whether the server reads `\` in a literal as an escape. Assumed until probed. */
	private backslashEscapes = true;
	private dialectProbed = false;

	/**
	 * Whether `agent_events` is in append_mode, as last observed. `null` until
	 * asked. Cached so callers can report a deduplicating ledger on every append,
	 * rather than it being one line in a boot log that has scrolled away.
	 */
	appendMode: boolean | null = null;
	private appendModeCheckedAt = 0;

	/**
	 * Whether `event_ingest` is in append_mode, as last observed. Separate from
	 * {@link appendMode}: `CREATE TABLE IF NOT EXISTS` leaves an existing table
	 * alone, and a deduplicating ingest table can drop a same-millisecond record
	 * the hourly root would then omit without a warning.
	 */
	ingestAppendMode: boolean | null = null;
	private ingestAppendModeCheckedAt = 0;

	private readonly timeoutMs: number;
	private readonly clock: () => number;
	private readonly gate: PlaneGate | null;
	private readonly ledger: LedgerSettings;

	/**
	 * Each session's chain tip as this process last saw it (uplift-2 R5): seeded
	 * by one `lastHash` read, moved forward by every stored event, forgotten on
	 * an event-row error for that session — a timed-out INSERT may have landed,
	 * and the next append must ask the ledger rather than chain onto a guess.
	 * `null` when `SUBSTRATE_LEDGER_CHAIN_CACHE=0`, which restores one read per emit.
	 */
	private readonly chainTips: ChainTipCache | null;

	/** The current export window's first ingest records; see {@link exportWindow}. Dropped when the last page is served. */
	private exportIngest: { window: string; since: number; first: Map<string, { ingested_at: number; event_ts: number }> } | null = null;

	/** Credential text scrubbed from every diagnostic; see {@link credentialNeedles}. */
	private readonly knownSecrets: string[];

	/** The last write probe's verdict; see {@link probeWritable}. */
	private probe: LedgerProbe = { lastProbeAt: null, lastProbeOk: null, lastProbeError: null };
	private probeInFlight: Promise<LedgerProbe> | null = null;

	constructor(
		private readonly config: GreptimeConfig,
		options: GreptimeClientOptions = {},
	) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.clock = options.clock ?? Date.now;
		this.gate = options.gate ?? null;
		this.ledger = options.ledger ?? DEFAULT_LEDGER_SETTINGS;
		this.chainTips = this.ledger.chainCache ? new ChainTipCache(this.ledger.chainCacheMax) : null;
		this.knownSecrets = credentialNeedles(this.config);
	}

	/** How many sessions' tips are remembered right now; a test seam, and cheap to report. */
	get chainTipsCached(): number {
		return this.chainTips?.size ?? 0;
	}

	/**
	 * Scrub the configured credentials, then credential-shaped text, out of a diagnostic.
	 *
	 * Every message `send` builds from a URL, a response body or a transport error passes
	 * through here: a proxy that echoes the request, or a fetch error that quotes the URL it
	 * tried, must not carry the endpoint's credentials into an error, a warning, the breaker's
	 * `lastError` or a health body.
	 */
	private scrub(text: string): string {
		return redact(redactKnown(text, this.knownSecrets));
	}

	/**
	 * A response body as it may appear in a diagnostic: scrubbed whole, then cut to `limit`.
	 * Clipping first would cut a secret that straddles the limit, leave `redactKnown` unable
	 * to match its complete value and let the surviving prefix through; clipping the scrubbed
	 * text can only cut redaction markers or harmless text.
	 */
	private clippedBody(text: string, limit: number): string {
		return this.scrub(text).slice(0, limit);
	}

	/** A transport failure with its message scrubbed and its `name` kept (`TimeoutError`, `AbortError`). */
	private scrubTransportError(cause: unknown): unknown {
		if (!(cause instanceof Error)) return this.scrub(String(cause));
		const error = new Error(this.scrub(cause.message));
		error.name = cause.name;
		return error;
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
		if (this.config.user !== undefined) {
			const basic = Buffer.from(`${this.config.user}:${this.config.password ?? ""}`).toString("base64");
			headers.authorization = `Basic ${basic}`;
		}
		return headers;
	}

	/**
	 * Whether the server's quoting dialect is known.
	 *
	 * While it is not, every event carrying a backslash is refused — including one
	 * whose payload JSON introduces it — so the ledger is only partly writable, and
	 * a health check that ignored this would report a writable ledger while events
	 * were being turned away.
	 */
	get quotingDialectKnown(): boolean {
		return this.dialectProbed;
	}

	/** Quote using whatever dialect the server reported. */
	private q(value: string | number | null): string {
		return quote(value, this.backslashEscapes);
	}

	/**
	 * Run SQL and return rows as objects keyed by column name.
	 *
	 * Every statement passes `assertAppendOnly` first: this is the only door to
	 * the ledger, so it is the right place to make append-only structural rather
	 * than a convention each caller has to remember. The one exception is
	 * {@link alterTtl}, which builds exactly one statement shape from validated
	 * parts and goes to {@link send} directly.
	 */
	async sql(statement: string, timeoutMs = this.timeoutMs, op: string = sqlOp(statement)): Promise<Array<Record<string, unknown>>> {
		assertAppendOnly(statement);
		return this.send(statement, timeoutMs, op);
	}

	/** The transport: one statement over the gate, rows back. Reached only through `sql` and `alterTtl`. */
	private async send(statement: string, timeoutMs: number, op: string): Promise<Array<Record<string, unknown>>> {
		const url = `${this.config.url}/v1/sql?db=${encodeURIComponent(this.config.db)}`;
		let answer: { status: number; text: string };
		try {
			// Everything thrown inside is the plane's fault — a transport error, a
			// timeout, a 5xx — so the gate counts all of it. The raw fetch error is
			// thrown as-is so a timeout is observed as one, and wrapped below.
			answer = await callPlane(this.gate, op, async () => {
				let response: Response;
				let text: string;
				try {
					response = await fetch(url, {
						method: "POST",
						headers: this.headers(),
						body: new URLSearchParams({ sql: statement }),
						signal: AbortSignal.timeout(timeoutMs),
					});
					text = await response.text();
				} catch (cause) {
					// The gate records this error's message as the breaker's `lastError` and in the
					// observer's `reason` before the catch below ever runs, so the scrub has to happen
					// here, on the way in. The name survives: `callPlane` reads it to tell a timeout.
					throw this.scrubTransportError(cause);
				}
				if (response.status >= 500) throw new GreptimeUnavailable(`greptime ${response.status}: ${this.clippedBody(text, 500)}`);
				return { status: response.status, text };
			});
		} catch (cause) {
			if (cause instanceof GreptimeUnavailable) throw cause;
			if (cause instanceof BreakerOpenError) throw new GreptimeBreakerOpen(cause.message);
			throw new GreptimeUnavailable(`greptime unreachable: ${String(cause)}`);
		}

		const { status, text } = answer;
		if (status < 200 || status >= 300) {
			throw new GreptimeError(`greptime ${status}: ${this.clippedBody(text, 500)}`, { missingTable: MISSING_TABLE.test(text.slice(0, 500)) });
		}

		let body: GreptimeResponse;
		try {
			body = JSON.parse(text) as GreptimeResponse;
		} catch {
			throw new GreptimeError(`greptime returned non-JSON: ${this.clippedBody(text, 200)}`, { missingTable: MISSING_TABLE.test(text.slice(0, 200)) });
		}
		if (body.error) {
			const reported = `greptime: ${body.error}`;
			throw new GreptimeError(this.scrub(reported), { missingTable: MISSING_TABLE.test(reported) });
		}

		const records = body.output?.[0]?.records;
		if (!records?.rows) return [];
		const columns = records.schema?.column_schemas?.map((c) => c.name) ?? [];
		return records.rows.map((row) => {
			const out: Record<string, unknown> = {};
			columns.forEach((name, i) => {
				out[name] = row[i];
			});
			return out;
		});
	}

	/**
	 * Ask the server how it reads a backslash inside a string literal, once.
	 *
	 * `'a\\b'` is three characters where backslash escapes and four where it is
	 * literal, and GreptimeDB's answer has moved across releases. Guessing wrong
	 * either doubles every backslash in a stored summary — which breaks the hash
	 * chain the moment the row is read back, because the chain was computed over
	 * the text as submitted — or leaves a summary able to close its own literal.
	 * A server that will not answer leaves the safe assumption in place.
	 */
	async probeDialect(): Promise<boolean> {
		if (this.dialectProbed) return this.backslashEscapes;
		const rows = await this.sql("SELECT LENGTH('a\\\\b') AS n").catch(() => []);
		const length = Number(rows[0]?.n);
		if (length === 3 || length === 4) {
			this.backslashEscapes = length === 3;
			this.dialectProbed = true;
		}
		return this.backslashEscapes;
	}

	/**
	 * Idempotent DDL. Safe to run on every boot.
	 *
	 * Warnings are returned rather than thrown: a ledger that is reachable but
	 * misconfigured should be reported loudly at boot and still serve, because
	 * refusing to start would block every agent on the host.
	 */
	async migrate(): Promise<{ warnings: string[] }> {
		const warnings: string[] = [];

		// Every identifier is quoted: Greptime's parser reserves `id`, among others,
		// and rejects it as a bare column name.
		//
		// `append_mode` is what makes the table append-only in Greptime's own terms.
		// Without it, rows sharing a primary key and a timestamp are deduplicated —
		// last write wins — so two events in the same millisecond from one surface,
		// repo, graph and kind would silently overwrite one another. A ledger cannot
		// lose a row quietly.
		const columns = `
				"ts"                TIMESTAMP TIME INDEX,
				"id"                STRING,
				"surface"           STRING,
				"session_id"        STRING,
				"graph_id"          STRING,
				"node_id"           STRING,
				"linear_identifier" STRING,
				"step"              BIGINT,
				"repo"              STRING,
				"branch"            STRING,
				"actor"             STRING,
				"kind"              STRING,
				"summary"           STRING,
				"payload"           STRING,
				"hash"              STRING,
				"prev"              STRING,
				PRIMARY KEY ("surface", "repo", "graph_id", "kind")`;
		try {
			await this.sql(
				`CREATE TABLE IF NOT EXISTS "agent_events" (${columns}) WITH ('append_mode' = 'true')`,
			);
		} catch (cause) {
			// An older Greptime may not know the option. Losing dedup protection is
			// worse than a warning but far better than having no ledger at all.
			await this.sql(`CREATE TABLE IF NOT EXISTS "agent_events" (${columns})`);
			warnings.push(`agent_events created without append_mode: ${String(cause)}`);
		}

		try {
			await this.sql(
				`CREATE TABLE IF NOT EXISTS "event_ingest" ("ingested_at" TIMESTAMP TIME INDEX, "event_id" STRING, "event_ts" TIMESTAMP, "graph_id" STRING) WITH ('append_mode' = 'true')`,
			);
		} catch (cause) {
			// Unlike agent_events above, there is no plain-CREATE fallback here: a
			// table without append_mode and without a primary key deduplicates on
			// the time index alone, so two events ingested in the same millisecond
			// would silently lose a record. A warning is cheaper than that loss.
			warnings.push(`event_ingest not created in append_mode: ${String(cause)}`);
		}

		// Chain leaves of each closed hour (D73-02), read back by the heads check. Append-only, as the
		// ledger requires: without append_mode two leaves that share a period and a timestamp would be
		// merged. No plain-CREATE fallback, for the same reason as event_ingest above.
		try {
			await this.sql(
				`CREATE TABLE IF NOT EXISTS "graph_chain_leaves" ("period_start" TIMESTAMP TIME INDEX, "graph_id" STRING, "session_id" STRING, "seq" BIGINT, "event_id" STRING, "hash" STRING) WITH ('append_mode' = 'true')`,
			);
		} catch (cause) {
			warnings.push(`graph_chain_leaves not created in append_mode: ${String(cause)}`);
		}

		await this.sql(`
			CREATE TABLE IF NOT EXISTS "anchors" (
				"period_start" TIMESTAMP TIME INDEX,
				"period_end"   TIMESTAMP,
				"root"         STRING,
				"event_count"  BIGINT,
				"memo"         STRING,
				"tx_sig"       STRING,
				"signer"       STRING,
				"cluster"      STRING,
				"slot"         BIGINT,
				"anchored_at"  TIMESTAMP,
				"stale_hashes" BIGINT
			)
		`);

		// Where `/healthz` proves the ledger takes writes (uplift-2 R5). Append-only
		// so same-millisecond probes cannot replace one another, with a one-day TTL
		// so the table holds at most a day of one-row-a-minute. A server that does
		// not take the option gets the table without it: a growing probe table is
		// a warning, a health check that cannot write is the thing being measured.
		try {
			await this.sql(
				`CREATE TABLE IF NOT EXISTS "${HEALTH_TABLE}" ("ts" TIMESTAMP TIME INDEX, "probe" STRING) WITH ('append_mode' = 'true', 'ttl' = '1d')`,
			);
		} catch (cause) {
			await this.sql(`CREATE TABLE IF NOT EXISTS "${HEALTH_TABLE}" ("ts" TIMESTAMP TIME INDEX, "probe" STRING) WITH ('append_mode' = 'true')`).catch(
				(plain: unknown) => warnings.push(`${HEALTH_TABLE} not created; the write probe will fail: ${String(plain)}`),
			);
			warnings.push(`${HEALTH_TABLE} created without a ttl, so probe rows are never expired: ${String(cause)}`);
		}

		// Production's period-keyed anchors, as information_schema spells the types
		// (verified against live on 2026-10-08, D27-17). `CREATE TABLE IF NOT
		// EXISTS` is a no-op against a table the old 5-column DDL built, so the
		// live shape is asked directly — and only a definite mismatch warns. An
		// empty or failed read stays silent: a fresh store has no anchors yet,
		// and boot must not cry wolf. This never ALTERs, DROPs or recreates.
		const liveAnchors = await this.sql(
			`SELECT "column_name", "data_type", "semantic_type" FROM "information_schema"."columns" ` +
				`WHERE "table_schema" = ${this.q(this.config.db)} AND "table_name" = ${this.q("anchors")} ORDER BY "ordinal_position"`,
		).catch(() => []);
		const liveShape = liveAnchors
			.map((row) => `${String(row.column_name)} ${String(row.data_type).toLowerCase()} ${String(row.semantic_type).toLowerCase()}`)
			.join(", ");
		const canonicalShape =
			"period_start timestamp(3) timestamp, period_end timestamp(3) field, root string field, " +
			"event_count bigint field, memo string field, tx_sig string field, signer string field, " +
			"cluster string field, slot bigint field, anchored_at timestamp(3) field, stale_hashes bigint field";
		if (liveAnchors.length > 0 && liveShape !== canonicalShape) {
			warnings.push(`anchors does not match production's period-keyed shape (live: ${liveShape}); see docs/greptime-ledger.md.`);
		}

		await this.probeDialect();
		if (!this.dialectProbed) {
			// Not fatal, but the ledger will refuse any event carrying a backslash
			// until this succeeds, so it belongs in the boot report.
			warnings.push("could not determine the server's quoting dialect; events containing a backslash are refused");
		}

		const appendOnly = await this.appendModeEnabled();
		if (appendOnly === false) {
			warnings.push(
				"agent_events is not in append_mode — Greptime will deduplicate events sharing a primary key and " +
					"timestamp. Recreate the table with WITH ('append_mode' = 'true'); see docs/greptime-ledger.md.",
			);
		} else if (appendOnly === null) {
			warnings.push("could not confirm agent_events is in append_mode");
		}

		const ingestOnly = await this.ensureIngestAppendMode();
		if (ingestOnly === false) {
			warnings.push(
				"event_ingest is not in append_mode — same-millisecond ingest records can replace each other, so an " +
					"hourly root would omit durable events. Recreate the table with WITH ('append_mode' = 'true'); see docs/greptime-ledger.md.",
			);
		} else if (ingestOnly === null) {
			warnings.push("could not confirm event_ingest is in append_mode");
		}

		await this.applyTtl(warnings);

		return { warnings };
	}

	/**
	 * Apply `SUBSTRATE_LEDGER_TTL` to the two retention tables, when it is set and
	 * differs from what the live table carries (uplift-2 R5, DP-ret "180 days hot").
	 *
	 * Unset means "no change": the client neither sets nor unsets a TTL on its
	 * own, so a retention an operator applied by hand is left alone, and so is a
	 * table that has none. A matching live value sends nothing, which keeps boot
	 * idempotent. Every failure is a warning: a retention that could not be
	 * applied must not stop the ledger from serving.
	 */
	private async applyTtl(warnings: string[]): Promise<void> {
		const wanted = this.ledger.ttl;
		if (wanted === null) return;
		for (const table of TTL_TABLES) {
			const rows = await this.sql(`SHOW CREATE TABLE "${table}"`).catch(() => null);
			if (!rows || rows.length === 0) {
				warnings.push(`${table}: could not read its ttl, so SUBSTRATE_LEDGER_TTL=${wanted} was not applied`);
				continue;
			}
			const live = ttlOf(
				Object.values(rows[0] ?? {})
					.map((value) => String(value))
					.join(" "),
			);
			if (sameTtl(live, wanted)) continue;
			try {
				await this.alterTtl(table, wanted);
			} catch (cause) {
				warnings.push(`${table}: SUBSTRATE_LEDGER_TTL=${wanted} was not applied (live ttl ${live ?? "unset"}): ${String(cause)}`);
			}
		}
	}

	/**
	 * The one `ALTER` this client sends: `ALTER TABLE "<t>" SET 'ttl'='<d>'`.
	 *
	 * It bypasses `assertAppendOnly` for exactly this shape and nothing else —
	 * the table is one of {@link TTL_TABLES} by type, the value has passed
	 * {@link isGreptimeDuration}, and neither is interpolated from a caller's
	 * string. Setting a TTL deletes nothing this process can see: expiry is the
	 * server's own asynchronous job, which is why it lives behind an operator
	 * knob and not a code path. Rolling it back is `ALTER TABLE … UNSET 'ttl'`
	 * run by the operator (Greptime reference, "ALTER"); the client has no path
	 * for that either.
	 */
	async alterTtl(table: TtlTable, ttl: string): Promise<void> {
		if (!(TTL_TABLES as readonly string[]).includes(table)) throw new AppendOnlyViolation(`refusing to alter ${table}: not a retention table`);
		if (!isGreptimeDuration(ttl)) throw new AppendOnlyViolation(`refusing ttl ${JSON.stringify(ttl)}: not a Greptime duration`);
		await this.send(`ALTER TABLE "${table}" SET 'ttl'='${ttl}'`, this.timeoutMs, "alter");
	}

	/**
	 * Whether the ledger is proven append-only, re-asking when the answer is stale.
	 *
	 * The answer cannot be cached for the life of the process. Fixing a
	 * deduplicating table means recreating it *outside* this process — the client
	 * refuses every `ALTER` but the guarded TTL one, and `RENAME`, by design — so
	 * a permanently cached `false` would leave the write path refusing every
	 * event, and `/healthz` red, until someone thought to restart the service. The
	 * operator would have done the documented fix and seen nothing change. The
	 * converse matters too: a table swapped back to a deduplicating one must stop
	 * being treated as safe.
	 *
	 * So a definite answer is trusted for {@link APPEND_MODE_TTL_MS} and an unknown
	 * one is retried immediately, which also keeps a transient `SHOW CREATE TABLE`
	 * failure from becoming a lasting outage. The steady-state cost is one cheap
	 * query per TTL, not one per append.
	 */
	async ensureAppendMode(now = Date.now()): Promise<boolean | null> {
		if (this.appendMode !== null && now - this.appendModeCheckedAt < APPEND_MODE_TTL_MS) {
			return this.appendMode;
		}
		const answer = await this.appendModeEnabled();
		// A failed check leaves the previous answer in place rather than widening the
		// refusal; the next call retries, because `appendModeCheckedAt` did not move.
		if (answer !== null) this.appendModeCheckedAt = now;
		return answer ?? this.appendMode;
	}

	/**
	 * Whether the live `agent_events` carries `append_mode`.
	 *
	 * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that predates the
	 * option, so the table deployed before this check exists has to be asked
	 * directly. `null` means the question could not be answered.
	 */
	async appendModeEnabled(): Promise<boolean | null> {
		const answer = await this.liveAppendMode("agent_events");
		if (answer !== null) this.appendMode = answer;
		return answer;
	}

	/**
	 * Whether live `event_ingest` is in append_mode, re-asked when the answer is stale.
	 *
	 * Same cache rule as {@link ensureAppendMode}. A failed check leaves the previous
	 * answer in place. `timeoutMs` bounds the probe when it runs on the ingest path,
	 * which has already stored the event and cannot spend another full write timeout.
	 */
	async ensureIngestAppendMode(now = Date.now(), timeoutMs = this.timeoutMs): Promise<boolean | null> {
		if (this.ingestAppendMode !== null && now - this.ingestAppendModeCheckedAt < APPEND_MODE_TTL_MS) {
			return this.ingestAppendMode;
		}
		const answer = await this.liveAppendMode("event_ingest", timeoutMs);
		if (answer !== null) {
			this.ingestAppendMode = answer;
			this.ingestAppendModeCheckedAt = now;
		}
		return answer ?? this.ingestAppendMode;
	}

	/**
	 * Whether a live table's DDL carries `append_mode`.
	 *
	 * `null` means the question could not be answered. Greptime prints the option
	 * unquoted (`append_mode = 'true'`); the DDL we send quotes the key. Tolerate
	 * both rather than reporting a false mismatch.
	 */
	private async liveAppendMode(table: "agent_events" | "event_ingest", timeoutMs = this.timeoutMs): Promise<boolean | null> {
		const rows = await this.sql(`SHOW CREATE TABLE "${table}"`, timeoutMs).catch(() => null);
		if (!rows || rows.length === 0) return null;
		const ddl = Object.values(rows[0] ?? {})
			.map((value) => String(value))
			.join(" ");
		return /append_mode'?\s*=\s*'?true/i.test(ddl);
	}

	async insertEvent(event: SubstrateEvent): Promise<void> {
		// Retried until it succeeds, because until the dialect is known a backslash
		// cannot be quoted safely. The probe is one small SELECT and its answer is
		// cached for the process.
		await this.probeDialect();
		if (!this.dialectProbed && carriesBackslash(event)) {
			// Refusing costs one event. Writing would store text that differs from the
			// text the hash was computed over, and an append-only table cannot be
			// corrected — that row would fail verification for as long as it exists,
			// and take its session's chain with it.
			throw new GreptimeError(
				"refusing to append an event containing a backslash before the server's quoting dialect is known",
			);
		}
		const cell = (column: (typeof EVENT_COLUMNS)[number]): string => {
			if (column === "payload") return this.q(JSON.stringify(event.payload));
			const value = event[column];
			return value === null ? "NULL" : this.q(value as string | number);
		};
		const values = EVENT_COLUMNS.map(cell).join(", ");
		try {
			await this.sql(`INSERT INTO "agent_events" (${EVENT_COLUMN_LIST}) VALUES (${values})`);
		} catch (cause) {
			// The row may or may not have landed — a timeout is not a refusal — so
			// the remembered tip is wrong either way it is guessed. Forget it and the
			// next append reads the ledger.
			if (event.session_id !== null) this.chainTips?.delete(event.session_id);
			throw cause;
		}
		// The row is in the ledger: whatever happens to its ingest record below,
		// the session's next event must chain onto this hash.
		if (event.session_id !== null) this.chainTips?.set(event.session_id, event.hash);

		// The ingest record goes second: it must never name an event that does not exist.
		await this.recordIngest(event);
	}

	/**
	 * Whether a row with this event id is in the ledger: the retry check for a buffered event (phase 76). A write
	 * that timed out may have landed, and writing the event again would leave two rows for one event. Throws on
	 * any ledger error, an open breaker included: a failed lookup must never be read as "not stored".
	 */
	async eventStored(id: string): Promise<boolean> {
		if (!IDEMPOTENCY_ID.test(id)) throw new GreptimeError("refusing an event lookup for a malformed id");
		const rows = await this.sql(`SELECT "id" FROM "agent_events" WHERE "id" = ${this.q(id)} LIMIT 1`);
		return rows.length > 0;
	}

	/**
	 * The event's `event_ingest` record: the membership an hourly anchor reads (D27-10). Shared by
	 * `insertEvent`, after its row landed, and by an idempotent replay that matched an existing
	 * row (U5-4a), whose original attempt may have ended before this write.
	 *
	 * Each attempt takes a fresh stamp immediately before its INSERT; a duplicate can only appear
	 * when a retry follows an ambiguous timeout that had in fact landed (or, for a replay, when the
	 * original's record exists already), and `hourLeaves` collapses it: it keeps each event's
	 * EARLIEST record and drops an event that has an earlier record than the hour (`first` map and
	 * the `ingested_at < start` read there), as `graphIngest` does. A second record therefore
	 * never moves an event's hour or position — and the hour a repaired membership lands in is
	 * this write's server time, never the event's `ts`.
	 * `quote(null)` renders a null graph_id as NULL with no branch (D27-07).
	 * Both attempts, and the live append_mode probe, share INGEST_BUDGET_MS so a caller that
	 * already has the event row is not held for two full timeouts.
	 *
	 * Throws {@link IngestNotRecorded} when it cannot be confirmed; the event row is untouched.
	 */
	async recordIngest(event: Pick<SubstrateEvent, "id" | "ts" | "graph_id">): Promise<void> {
		const budgetStarted = Date.now();
		const remaining = (): number => INGEST_BUDGET_MS - (Date.now() - budgetStarted);
		const probeBudget = remaining();
		if (probeBudget < 50) {
			throw new IngestNotRecorded(event.id, new GreptimeError(`ingest budget of ${INGEST_BUDGET_MS}ms exhausted`));
		}
		const ingestAppend = await this.ensureIngestAppendMode(Date.now(), probeBudget);
		if (ingestAppend === false) {
			// Do not insert. A deduplicating time index can replace another event's
			// record that shares the millisecond, which is a worse loss than skipping ours.
			throw new IngestNotRecorded(
				event.id,
				new GreptimeError("event_ingest is not in append_mode, so a same-millisecond ingest record may replace another"),
			);
		}
		let failure: unknown;
		for (let attempt = 0; attempt < 2; attempt++) {
			const budget = remaining();
			if (budget < 50) {
				failure ??= new GreptimeError(`ingest budget of ${INGEST_BUDGET_MS}ms exhausted`);
				break;
			}
			const ingestedAt = this.clock();
			try {
				await this.sql(
					`INSERT INTO "event_ingest" ("ingested_at", "event_id", "event_ts", "graph_id") VALUES (` +
						`${this.q(new Date(ingestedAt).toISOString())}, ${this.q(event.id)}, ${this.q(event.ts)}, ${this.q(event.graph_id)})`,
					budget,
				);
			} catch (cause) {
				failure = cause;
				continue;
			}
			const hour = hourStart(ingestedAt);
			if (isClosed(hour, this.clock(), INGEST_LAG_MS)) {
				// The record landed after its hour already closed: a root computed
				// before now would differ when recomputed, and this line is how
				// that is diagnosed. It names the event and the hour only (D27-16).
				process.stderr.write(
					`[substrate] event ${event.id} ingest record landed after hour ${new Date(hour).toISOString()} closed; ` +
						"a root computed before it landed would differ\n",
				);
			}
			return;
		}
		throw new IngestNotRecorded(event.id, failure);
	}

	/**
	 * The stored event a replay duplicates, if any (U5-4a). Run only for a replay-marked request
	 * (`accept`) or a keyed one (`enforce`), and by `Substrate.append` INSIDE the per-session emit
	 * gate so two concurrent same-key requests cannot both miss.
	 *
	 * The cell is the table's primary-key prefix (`surface`, `repo`, `graph_id`, `kind`) plus the
	 * exact normalised `ts` the client fixed at its first attempt. A NULL `repo` or `graph_id` is
	 * `IS NULL`: `= NULL` matches nothing.
	 *
	 * The cell is read a page at a time, {@link IDEMPOTENCY_LOOKUP_LIMIT} rows per statement, in
	 * `"id"` order. Every page after the first is keyset-paged: it asks only for ids after the last
	 * one the previous page returned, never OFFSET.
	 *
	 * The key is matched in code, never in SQL. `normalizeEvent` appends `_ik` as the payload's last
	 * key, so the stored text ends `"_ik":"<key>"}`; each returned payload is checked for that exact
	 * suffix, and anchoring there means a caller who buried a nested `_ik` in their own payload cannot
	 * masquerade as the original. A `LIKE` pattern is not used: `_` in a key is a wildcard in that
	 * dialect, so a lookalike key would match, and an `ESCAPE` clause is unverified here. A row without
	 * the exact suffix is skipped, never taken as a hit that would swallow a new event.
	 *
	 * A short page without an exact match is a genuine miss. A full page without one means the cell may
	 * hold more rows, so the next page is read. If {@link IDEMPOTENCY_LOOKUP_MAX_PAGES} full pages pass
	 * without an exact match, the real row may still be past the bound, so the answer is inconclusive and
	 * this throws like any lookup error rather than reporting a miss that would append a duplicate. A page
	 * whose last id is not a plain identifier cannot be keyset-paged safely, so it throws the same way.
	 *
	 * It does not catch what it did not look for: only the same cell and `ts`. That is the contract,
	 * not an accident. Whether the exact-`ts` cell read is cheap on the production image has not been
	 * measured; the operator step is an `EXPLAIN` of this statement.
	 *
	 * Throws on any ledger error, an open breaker included, and on a hit that is not a well-formed
	 * row: the caller answers 503 and writes nothing, because a lookup that errors must never be
	 * read as a miss.
	 */
	async findByIdempotencyKey(
		cell: Pick<SubstrateEvent, "surface" | "repo" | "graph_id" | "kind" | "ts">,
		key: string,
	): Promise<{ id: string; hash: string } | null> {
		if (!IDEMPOTENCY_KEY_PATTERN.test(key)) throw new GreptimeError("refusing an idempotency lookup for a malformed key");
		await this.probeDialect();
		if (!this.dialectProbed && [cell.repo, cell.graph_id].some((value) => value?.includes("\\") === true)) {
			// The same refusal `insertEvent` makes: until the dialect is known a backslash cannot be quoted
			// safely, so a lookup could silently miss the row the original attempt stored.
			throw new GreptimeError("refusing an idempotency lookup on a value containing a backslash before the server's quoting dialect is known");
		}
		const equals = (column: "surface" | "repo" | "graph_id" | "kind", value: string | null): string =>
			value === null ? `"${column}" IS NULL` : `"${column}" = ${this.q(value)}`;
		const suffix = `"${IDEMPOTENCY_PAYLOAD_KEY}":"${key}"}`;
		const cellWhere =
			`${equals("surface", cell.surface)} AND ${equals("repo", cell.repo)} AND ${equals("graph_id", cell.graph_id)} ` +
			`AND ${equals("kind", cell.kind)} AND "ts" = ${this.q(cell.ts)}`;
		let after: string | null = null;
		for (let page = 0; page < IDEMPOTENCY_LOOKUP_MAX_PAGES; page++) {
			const rows = await this.sql(
				`SELECT "id", "hash", "payload" FROM "agent_events" WHERE ${cellWhere}` +
					(after === null ? "" : ` AND "id" > ${this.q(after)}`) +
					` ORDER BY "id" ASC LIMIT ${IDEMPOTENCY_LOOKUP_LIMIT}`,
			);
			let found: { id: string; hash: string } | null = null;
			for (const row of rows) {
				if (typeof row.id !== "string" || typeof row.hash !== "string") {
					throw new GreptimeError("idempotency lookup returned a row without a string id and hash");
				}
				if (found === null && typeof row.payload === "string" && row.payload.endsWith(suffix)) found = { id: row.id, hash: row.hash };
			}
			if (found !== null) return found;
			// A short page is the whole rest of the cell: no exact match there is a genuine miss.
			if (rows.length < IDEMPOTENCY_LOOKUP_LIMIT) return null;
			const last = rows[rows.length - 1]?.id;
			if (typeof last !== "string" || !IDEMPOTENCY_ID.test(last)) {
				throw new GreptimeError("idempotency lookup refused a row id it cannot page past safely");
			}
			after = last;
		}
		throw new GreptimeError(
			`idempotency lookup inconclusive: ${IDEMPOTENCY_LOOKUP_MAX_PAGES * IDEMPOTENCY_LOOKUP_LIMIT} rows of the cell matched none with the exact key`,
		);
	}

	/**
	 * Latest event hash for a session — the `prev` of the next one.
	 *
	 * Answered from {@link chainTips} when this process has seen the session:
	 * one read seeds it, and every stored event moves it, so a session's second
	 * and later emits cost no read at all (uplift-2 R5). Only a cache miss asks
	 * the ledger, and that read is bounded to the last
	 * `SUBSTRATE_LEDGER_CHAIN_LOOKBACK_DAYS` of `ts` — `session_id` is not a key,
	 * so an unbounded read was a scan of every row ever stored.
	 *
	 * The bound is a window, and a window is exactly what forked chains before:
	 * `ts` is collector-supplied, the Grok collector's backfill pass appends
	 * events older than everything already stored, and a window ordered by `ts`
	 * can miss the real tip. Two things hold that off. When the bounded read sees
	 * nothing, the whole session is read instead, so a session that fell silent
	 * for longer than the window continues its chain. And a tip is read once per
	 * process per session, not once per emit: after that the cache carries it,
	 * and a backfilled tip appended by this process is remembered exactly. What
	 * remains is a session with a backfilled tip older than the window *and* no
	 * event in this process yet — `verify` detects that fork, and the window is a
	 * knob the operator can widen.
	 *
	 * Only `hash` and `prev` are selected, so the read stays small. `"id"` breaks
	 * a same-millisecond tie so the order is at least stable across calls; it is
	 * a random UUID, so deterministic but arbitrary, which is why `chainTip`
	 * decides the tip from `prev` rather than from position.
	 */
	async lastHash(sessionId: string): Promise<string | null> {
		const cached = this.chainTips?.get(sessionId);
		if (cached !== undefined) return cached;
		const since = this.q(new Date(this.clock() - this.ledger.chainLookbackDays * DAY_MS).toISOString());
		const recent = await this.sql(
			`SELECT "hash", "prev" FROM "agent_events" WHERE "session_id" = ${this.q(sessionId)} AND "ts" >= ${since}
			 ORDER BY "ts" DESC, "id" DESC LIMIT ${MAX_SESSION_ROWS}`,
		);
		const rows =
			recent.length > 0
				? recent
				: await this.sql(
						`SELECT "hash", "prev" FROM "agent_events" WHERE "session_id" = ${this.q(sessionId)}
			 ORDER BY "ts" DESC, "id" DESC LIMIT ${MAX_SESSION_ROWS}`,
					);
		const tip = chainTip(rows);
		this.chainTips?.set(sessionId, tip);
		return tip;
	}

	/**
	 * A window of the ledger, narrowed by whole-column equality and a time bound.
	 *
	 * The read counterpart of `insertEvent`, and the reason a desk seat needs no
	 * Greptime credential to look at the trail: the statement is built here from
	 * {@link QUERYABLE_COLUMNS}, so a caller contributes values and never SQL.
	 *
	 * `payload` is excluded unless asked for. It is the one unbounded column — up to
	 * 16 KB an event — and a 500-row reply carrying it would be megabytes of MCP
	 * response for a question usually answered by the summaries.
	 *
	 * `ORDER BY "ts"` is presentation order, not append order: `ts` is
	 * collector-supplied and two events can share a millisecond. `hash` and `prev`
	 * come back on every row so a caller can follow the chain itself, and
	 * `verifyGraph` is what actually checks it.
	 */
	async queryEvents(query: EventQuery = {}): Promise<Array<Record<string, unknown>>> {
		// A read cannot corrupt anything, so an unknown dialect is not fatal here as it
		// is on the write path: quoting defaults to escaping, which is the injection-safe
		// assumption either way. Probing only sharpens matching on a value that carries a
		// backslash, which against the other dialect would simply match no rows.
		await this.probeDialect().catch(() => undefined);

		const columns = query.includePayload ? EVENT_COLUMNS : EVENT_COLUMNS.filter((column) => column !== "payload");
		const where: string[] = [];
		for (const column of QUERYABLE_COLUMNS) {
			const value = query.match?.[column];
			if (value === undefined || value === null) continue;
			where.push(`"${column}" = ${this.q(value)}`);
		}
		if (query.since !== undefined) where.push(`"ts" >= ${this.q(query.since)}`);
		if (query.until !== undefined) where.push(`"ts" <= ${this.q(query.until)}`);

		const direction = query.order === "asc" ? "ASC" : "DESC";
		return this.sql(
			`SELECT ${columns.map((column) => `"${column}"`).join(", ")} FROM "agent_events"` +
				`${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}` +
				` ORDER BY "ts" ${direction}, "id" ${direction} LIMIT ${queryLimit(query.limit)}`,
		);
	}

	/**
	 * The ingest-order position of one event, from a stream cursor's event id: its
	 * first ingest record (D27-10). Null when the id names no event — a cursor
	 * from before a ledger rebuild looks unknown too, and a caller that gets null
	 * starts live instead of replaying.
	 */
	async cursorPosition(eventId: string): Promise<CursorPosition | null> {
		const rows = await this.sql(
			`SELECT "event_id", "ingested_at" FROM "event_ingest" WHERE "event_id" = ${this.q(eventId)}
			 ORDER BY "ingested_at" ASC LIMIT 1`,
		);
		const row = rows[0];
		if (!row) return null;
		const id = String(row.event_id);
		const ingestedAt = epochMs(row.ingested_at);
		if (!Number.isFinite(ingestedAt)) throw new GreptimeError(`ingest record for ${id} has a time that is not a number`);
		return { id, ingestedAt };
	}

	/** The newest position — where a stream that sent no cursor starts: live, nothing replayed. */
	async latestPosition(): Promise<CursorPosition | null> {
		const rows = await this.sql(
			`SELECT "event_id", "ingested_at" FROM "event_ingest" ORDER BY "ingested_at" DESC, "event_id" DESC LIMIT 1`,
		);
		const row = rows[0];
		if (!row) return null;
		const id = String(row.event_id);
		const ingestedAt = epochMs(row.ingested_at);
		if (!Number.isFinite(ingestedAt)) throw new GreptimeError(`ingest record for ${id} has a time that is not a number`);
		return { id, ingestedAt };
	}

	/**
	 * Positions strictly after `cursor`, in (ingested_at, event_id) order, capped.
	 *
	 * One statement does the whole ordering job, and every part of it stays
	 * inside the window the cursor names: the rows considered are the ingest
	 * records at or after the cursor's millisecond, and a row's event survives
	 * only when NO record of that event sits at or before the full
	 * (ingested_at, event_id) cursor — so a retry record for an older event is
	 * still excluded, because its original exists at or before the cursor, and
	 * the boundary check rides along in the same probe. That keeps round 1's
	 * earliest-record semantics (D27-10): a surviving row's event has all its
	 * records strictly after the cursor, so its earliest row is its first
	 * record, and TypeScript keeps one position per event when a first record
	 * and its retry both survive in one window. The window bound is what keeps
	 * a poll bounded — round 1 ran a GROUP BY over all of `event_ingest`
	 * before the cursor filter, rescanning the entire ledger history every
	 * poll, while the anti-join here is a per-window-row index probe. Order
	 * still precedes the limit, so paging before cutting cannot freeze or
	 * replay a stream. Bounded by `limit` positions.
	 *
	 * The anti-join's inner side is bounded too (uplift-2 R5): it looks back
	 * {@link INGEST_RETRY_LOOKBACK_MS} before the cursor, not over all history,
	 * because the only way one event has two records is a retry inside
	 * `INGEST_BUDGET_MS` of its first attempt. `event_ts` rides along so the
	 * row read that follows can bound itself on the time index.
	 */
	async eventIdsAfter(cursor: CursorPosition, limit: number): Promise<CursorPosition[]> {
		const at = this.q(new Date(cursor.ingestedAt).toISOString());
		const lookback = this.q(new Date(Math.max(0, cursor.ingestedAt - INGEST_RETRY_LOOKBACK_MS)).toISOString());
		const rows = await this.sql(
			`SELECT i."event_id", i."ingested_at", i."event_ts" FROM "event_ingest" i
			 WHERE i."ingested_at" >= ${at}
			   AND NOT EXISTS (
			     SELECT 1 FROM "event_ingest" p
			      WHERE p."event_id" = i."event_id"
			        AND p."ingested_at" >= ${lookback}
			        AND (p."ingested_at" < ${at} OR (p."ingested_at" = ${at} AND p."event_id" <= ${this.q(cursor.id)}))
			   )
			 ORDER BY i."ingested_at" ASC, i."event_id" ASC
			 LIMIT ${queryLimit(limit)}`,
		);
		const positions: CursorPosition[] = [];
		// A first record and a retry can both survive one window; keep one
		// position per event, and the earliest — the statement's order puts the
		// first record before any later retry of the same event.
		const seen = new Set<string>();
		for (const row of rows) {
			const id = String(row.event_id);
			const ingestedAt = epochMs(row.ingested_at);
			if (!Number.isFinite(ingestedAt)) throw new GreptimeError(`ingest record for ${id} has a time that is not a number`);
			if (seen.has(id)) continue;
			seen.add(id);
			const eventTs = epochMs(row.event_ts);
			positions.push(Number.isFinite(eventTs) ? { id, ingestedAt, eventTs } : { id, ingestedAt });
			if (positions.length >= limit) break;
		}
		return positions;
	}

	/**
	 * The event rows for positions taken from {@link eventIdsAfter}: every column
	 * but `payload` unless asked — the same selection `queryEvents` makes — so a
	 * stream frame and a query row cannot disagree about what an event is.
	 *
	 * When every position carries its `event_ts`, the read is bounded to
	 * `"ts" BETWEEN` the earliest and the latest of them (uplift-2 R5): `id` is
	 * not a key, so `WHERE "id" IN (...)` alone scanned every row ever stored,
	 * once per poll per stream. Bare ids — a caller that has only the id — read
	 * unbounded, as before. `readEvents` and `graphIngest`, which `verify` uses,
	 * stay unbounded on purpose: verification must see everything.
	 */
	async eventsByIds(positions: ReadonlyArray<string | CursorPosition>, includePayload = false): Promise<Array<Record<string, unknown>>> {
		if (positions.length === 0) return [];
		const columns = (includePayload ? EVENT_COLUMNS : EVENT_COLUMNS.filter((column) => column !== "payload"))
			.map((column) => `"${column}"`)
			.join(", ");
		const list = positions.map((position) => this.q(typeof position === "string" ? position : position.id)).join(", ");
		const stamps = positions.map((position) => (typeof position === "string" ? Number.NaN : (position.eventTs ?? Number.NaN)));
		const bounded = stamps.every((stamp) => Number.isFinite(stamp));
		const window = bounded
			? ` AND "ts" BETWEEN ${this.q(new Date(Math.min(...stamps)).toISOString())} AND ${this.q(new Date(Math.max(...stamps)).toISOString())}`
			: "";
		return this.sql(`SELECT ${columns} FROM "agent_events" WHERE "id" IN (${list})${window}`);
	}

	/**
	 * Every stored column for one session or graph, oldest first, for chain
	 * verification. `"id"` is a tie-breaker so two events in the same millisecond
	 * come back in a stable order rather than an arbitrary one; `inChainOrder` then
	 * puts them in the order `prev` actually records.
	 *
	 * Deliberately unbounded in time, like {@link graphIngest}: `verify` has to see
	 * every event a graph or session ever stored, and a window here would turn a
	 * missing old event into a clean report. The bounded reads are the hot-path
	 * ones — `lastHash`, `eventIdsAfter`, `eventsByIds`.
	 */
	async readEvents(column: "session_id" | "graph_id", value: string): Promise<Array<Record<string, unknown>>> {
		return this.sql(
			`SELECT ${EVENT_COLUMN_LIST} FROM "agent_events" WHERE "${column}" = ${this.q(value)}
			 ORDER BY "ts", "id"`,
		);
	}

	/**
	 * The newest rows of one session or graph, summary columns only, newest first: the bounded read behind
	 * `memory_search`'s graph links and causal chains. `limit` is clamped to 1..{@link MAX_RECENT_EVENTS} here, so no
	 * caller can read a whole history through it. `payload` and the hash columns are left out on purpose.
	 */
	async readRecentEvents(column: "session_id" | "graph_id", value: string, limit: number): Promise<Array<Record<string, unknown>>> {
		const whole = Number.isNaN(limit) ? 1 : Math.trunc(limit);
		const rows = Math.min(MAX_RECENT_EVENTS, Math.max(1, whole));
		return this.sql(
			`SELECT "id", "ts", "kind", "surface", "node_id", "summary" FROM "agent_events" WHERE "${column}" = ${this.q(value)}
			 ORDER BY "ts" DESC, "id" DESC LIMIT ${rows}`,
		);
	}

	/**
	 * Whether an event id names a real event.
	 *
	 * Exists so the memory governance gate can check a `source_event` before honouring
	 * the `verified-by-test` trust that rests on it. Reads one column and returns a
	 * boolean rather than the row: the caller is establishing that provenance exists,
	 * not reading it, and a lookup that handed back the event would invite callers to
	 * start using this as a general event fetch.
	 */
	async hasEvent(eventId: string): Promise<boolean> {
		const rows = await this.sql(`SELECT "id" FROM "agent_events" WHERE "id" = ${this.q(eventId)} LIMIT 1`);
		return rows.length > 0;
	}

	/**
	 * One closed hour's members in position order, with their hashes.
	 *
	 * An event belongs to the hour holding its first ingest record, and its
	 * position is its rank by (`ingested_at`, `event_id`) ascending: the
	 * server only filters, and TypeScript decides membership and order, so an
	 * arbitrary server row order or a write interleaving cannot move the root.
	 * Collector `ts` plays no part — a backdated event lands in the hour it
	 * was ingested. Leaves always come from the event rows, so altering a
	 * stored event changes the recomputed root. A member with no event row,
	 * a hash that is not 64 lowercase hex, or two stored hashes for one id
	 * throws naming the event: the digest never returns a partial root.
	 */
	async hourLeaves(startMs: number): Promise<HourLeaf[]> {
		const ingestAppend = await this.ensureIngestAppendMode();
		if (ingestAppend !== true) {
			throw new GreptimeError(
				ingestAppend === false
					? "event_ingest is not in append_mode, so an hourly root would omit events that shared a millisecond"
					: "could not confirm event_ingest is in append_mode, so hourly membership was not read",
			);
		}
		const at = (ms: number): string => this.q(new Date(ms).toISOString());
		const rows = await this.sql(
			`SELECT "event_id", "ingested_at", "event_ts" FROM "event_ingest" ` +
				`WHERE "ingested_at" >= ${at(startMs)} AND "ingested_at" < ${at(hourEnd(startMs))}`,
		);
		const first = new Map<string, { at: number; ts: number }>();
		for (const row of rows) {
			const id = String(row.event_id);
			const ingested = epochMs(row.ingested_at);
			const ts = epochMs(row.event_ts);
			// A time that is not a number would sort unpredictably or make the hash
			// read's bounds throw a bare RangeError; name the event instead.
			if (!Number.isFinite(ingested) || !Number.isFinite(ts)) {
				throw new GreptimeError(`hour member ${id} has an ingest record with a time that is not a number`);
			}
			const seen = first.get(id);
			if (!seen || ingested < seen.at) first.set(id, { at: ingested, ts });
		}
		const ids = [...first.keys()];
		for (let i = 0; i < ids.length; i += IN_BATCH) {
			const batch = ids.slice(i, i + IN_BATCH).map((id) => this.q(id)).join(", ");
			const earlier = await this.sql(
				`SELECT DISTINCT "event_id" FROM "event_ingest" WHERE "ingested_at" < ${at(startMs)} AND "event_id" IN (${batch})`,
			);
			for (const row of earlier) first.delete(String(row.event_id));
		}
		const members = [...first]
			.map(([event_id, v]) => ({ event_id, ...v }))
			.sort((a, b) => a.at - b.at || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));
		const hashes = new Map<string, string>();
		for (let i = 0; i < members.length; i += IN_BATCH) {
			const batch = members.slice(i, i + IN_BATCH);
			const found = await this.sql(
				`SELECT "id", "hash" FROM "agent_events" WHERE "ts" >= ${at(Math.min(...batch.map((m) => m.ts)))} ` +
					`AND "ts" <= ${at(Math.max(...batch.map((m) => m.ts)))} AND "id" IN (${batch.map((m) => this.q(m.event_id)).join(", ")})`,
			);
			for (const row of found) {
				const id = String(row.id);
				const hash = String(row.hash);
				const prior = hashes.get(id);
				if (prior !== undefined && prior !== hash) throw new GreptimeError(`hour member ${id} has two stored hashes`);
				hashes.set(id, hash);
			}
		}
		return members.map(({ event_id, at: ingested_at }) => {
			const hash = hashes.get(event_id);
			if (hash === undefined) throw new GreptimeError(`hour member ${event_id} has no event row`);
			if (!/^[0-9a-f]{64}$/.test(hash)) throw new GreptimeError(`hour member ${event_id} has a hash that is not 64 lowercase hex`);
			return { event_id, ingested_at, hash };
		});
	}

	/**
	 * Anchors rows whose period starts inside `[windowStartMs, windowEndMs)`.
	 *
	 * The job's one window read per run: ascending by period, so candidates
	 * come out in anchor order. Values are quoted, never syntax.
	 */
	async anchorsBetween(windowStartMs: number, windowEndMs: number): Promise<AnchorRow[]> {
		const at = (ms: number): string => this.q(new Date(ms).toISOString());
		const rows = await this.sql(
			`SELECT ${ANCHOR_COLUMNS} FROM "anchors" ` +
				`WHERE "period_start" >= ${at(windowStartMs)} AND "period_start" < ${at(windowEndMs)} ` +
				`ORDER BY "period_start" ASC`,
		);
		return rows.map(parseAnchorRow);
	}

	/**
	 * The anchors row for one hour, or null when the hour is not anchored.
	 *
	 * A single-period read for verify's per-hour check and the job's dedup:
	 * an hour that already has a row is never written again.
	 */
	async anchorForPeriod(periodStartMs: number): Promise<AnchorRow | null> {
		const rows = await this.sql(
			`SELECT ${ANCHOR_COLUMNS} FROM "anchors" WHERE "period_start" = ${this.q(new Date(periodStartMs).toISOString())}`,
		);
		const first = rows[0];
		return first === undefined ? null : parseAnchorRow(first);
	}

	/**
	 * Write one anchors row in the production 11-column shape (D27-17).
	 *
	 * `stale_hashes` is always NULL — the column exists but has no meaning
	 * yet. The table deduplicates by `period_start`; callers check
	 * {@link anchorForPeriod} first and never write an hour twice.
	 */
	async insertAnchor(row: NewAnchor): Promise<void> {
		const v = (value: string | number): string => this.q(value);
		await this.sql(
			`INSERT INTO "anchors" ("period_start", "period_end", "root", "event_count", "memo", ` +
				`"tx_sig", "signer", "cluster", "slot", "anchored_at", "stale_hashes") VALUES (` +
				`${v(row.period_start)}, ${v(row.period_end)}, ${v(row.root)}, ${v(row.event_count)}, ` +
				`${v(row.memo)}, ${v(row.tx_sig)}, ${v(row.signer)}, ${v(row.cluster)}, ` +
				`${v(row.slot)}, ${v(row.anchored_at)}, NULL)`,
		);
	}

	/**
	 * Write one hour's chain leaves (D73-02): one row per event, at its place in its (graph, session)
	 * chain. Append-only, like every ledger write. The anchor job calls this before the anchors row, so no
	 * anchors row exists for an hour whose leaves were not stored.
	 */
	async insertGraphChainLeaves(rows: readonly GraphChainLeafRow[]): Promise<void> {
		const v = (value: string | number): string => this.q(value);
		for (let i = 0; i < rows.length; i += LEAF_INSERT_BATCH) {
			const values = rows
				.slice(i, i + LEAF_INSERT_BATCH)
				.map((row) => `(${v(row.period_start)}, ${v(row.graph_id)}, ${v(row.session_id)}, ${v(row.seq)}, ${v(row.event_id)}, ${v(row.hash)})`)
				.join(", ");
			await this.sql(
				`INSERT INTO "graph_chain_leaves" ("period_start", "graph_id", "session_id", "seq", "event_id", "hash") VALUES ${values}`,
			);
		}
	}

	/**
	 * Every stored chain leaf of one hour, across graphs, in the order the table returns them. The verifier orders and dedupes
	 * them; nothing here decides which rows count (D73-03, D73-04).
	 */
	async hourChainLeaves(periodStartMs: number): Promise<StoredLeaf[]> {
		const rows = await this.sql(
			`SELECT "graph_id", "session_id", "seq", "event_id", "hash" FROM "graph_chain_leaves" ` +
				`WHERE "period_start" = ${this.q(new Date(periodStartMs).toISOString())}`,
		);
		return rows.map((row) => ({
			graph_id: row.graph_id === null || row.graph_id === undefined ? "" : String(row.graph_id),
			session_id: row.session_id === null || row.session_id === undefined ? "" : String(row.session_id),
			seq: Number(row.seq),
			event_id: String(row.event_id),
			hash: String(row.hash),
		}));
	}

	/**
	 * The distinct hours that hold one graph's chain leaves, ascending. Verify reads these as well as the event and ingest rows, so an
	 * hour whose rows were deleted but whose leaves remain is still checked. Quoted by the stored graph id, as every graph read is.
	 */
	async graphChainLeafHours(storedGraphId: string): Promise<number[]> {
		const rows = await this.sql(`SELECT DISTINCT "period_start" FROM "graph_chain_leaves" WHERE "graph_id" = ${this.q(storedGraphId)}`);
		return rows
			.map((row) => {
				const at = epochMs(row.period_start);
				if (!Number.isFinite(at)) throw new GreptimeError(`a chain leaf of ${storedGraphId} has a period that is not a number`);
				return at;
			})
			.sort((a, b) => a - b);
	}

	/**
	 * The hour of the earliest `event_ingest` record — the coverage start.
	 *
	 * No hour before this is ever anchored (D28-05): the deploy hour is
	 * partial but well defined. Null when the store holds no ingest record.
	 * One row ordered ascending, not an aggregate, so the statement stays in
	 * the shapes the scratch server has answered.
	 */
	async firstIngestMs(): Promise<number | null> {
		const rows = await this.sql(`SELECT "ingested_at" FROM "event_ingest" ORDER BY "ingested_at" ASC LIMIT 1`);
		if (rows.length === 0) return null;
		const at = epochMs(rows[0]?.ingested_at);
		return Number.isFinite(at) ? at : null;
	}

	/**
	 * One event's first ingest record, for verify's hour report.
	 *
	 * Read by the stored (normalised) graph id; an event's hour is its first
	 * record's. Duplicate records for one event collapse to the earliest
	 * `ingested_at` here (D27-10 first-record rule), so a retried record can
	 * never move an event into a later hour.
	 */

	async graphIngest(storedGraphId: string): Promise<GraphIngestRecord[]> {
		const rows = await this.sql(
			`SELECT "event_id", "event_ts", "ingested_at" FROM "event_ingest" WHERE "graph_id" = ${this.q(storedGraphId)}`,
		);
		const first = new Map<string, GraphIngestRecord>();
		for (const row of rows) {
			const event_id = String(row.event_id);
			const event_ts = epochMs(row.event_ts);
			const ingested_at = epochMs(row.ingested_at);
			if (!Number.isFinite(event_ts) || !Number.isFinite(ingested_at)) {
				throw new GreptimeError(`ingest record for ${event_id} has a time that is not a number`);
			}
			const seen = first.get(event_id);
			if (!seen || ingested_at < seen.ingested_at) first.set(event_id, { event_id, event_ts, ingested_at });
		}
		return [...first.values()];
	}

	/**
	 * A repo's newest events, newest first, for `coord.drift_scan`.
	 *
	 * Every stored column, because a drift scan compares the trail against two
	 * other records and needs the session, the node and the payload to do it —
	 * the payload in particular, since that is where the git collector puts the
	 * commit sha. `"id"` breaks a same-millisecond tie so the window is stable
	 * across calls.
	 */
	async recentForRepo(repo: string, limit = 200): Promise<Array<Record<string, unknown>>> {
		const capped = Number.isFinite(limit) ? Math.min(2000, Math.max(1, Math.trunc(limit))) : 200;
		return this.sql(
			`SELECT ${EVENT_COLUMN_LIST} FROM "agent_events" WHERE "repo" = ${this.q(repo)}
			 ORDER BY "ts" DESC, "id" DESC LIMIT ${capped}`,
		);
	}

	/**
	 * Commit events in this repo that might name `sha`, newest first.
	 *
	 * A drift scan cannot answer "was this commit logged?" from its window of
	 * recent activity: a busy repo pushes a perfectly well-logged commit out of
	 * the newest N events, and the scan then invents `git.tip_unlogged`. So the
	 * question is asked directly instead of inferred from the window.
	 *
	 * Matched on the first seven characters, because the collector stores `git
	 * rev-parse --short` and the caller has the full hash: any abbreviation git
	 * produces is at least seven characters and begins with those. The prefix is
	 * validated hex, so it cannot carry a LIKE wildcard, and the candidates are
	 * returned rather than a boolean — seven hex characters can appear by
	 * coincidence, so the caller confirms each against the sha it asked about.
	 *
	 * Both patterns are anchored to the shape the sha is actually *stored* in —
	 * `commit <sha> <subject>` in the summary, `"sha":"<sha>"` in the payload —
	 * which are the two places {@link extractCommitSha} reads it from. A bare
	 * `%<prefix>%` would also match any event that merely mentioned those seven
	 * characters somewhere in its text, and enough of those could fill the row
	 * limit and push the real commit event out of the answer — reporting the tip
	 * as unlogged because too many things talked about it.
	 */
	async commitEventsNaming(repo: string, sha: string, limit = 20): Promise<Array<Record<string, unknown>>> {
		if (!/^[0-9a-f]{7,40}$/i.test(sha)) return [];
		const prefix = sha.slice(0, 7).toLowerCase();
		const capped = Math.min(100, Math.max(1, Math.trunc(limit)));
		return this.sql(
			`SELECT "ts", "id", "surface", "summary", "payload" FROM "agent_events"
			 WHERE "repo" = ${this.q(repo)} AND "kind" = 'commit'
			   AND ("summary" LIKE ${this.q(`%commit ${prefix}%`)} OR "payload" LIKE ${this.q(`%"sha":"${prefix}%`)})
			 ORDER BY "ts" DESC LIMIT ${capped}`,
		);
	}

	/** Reachability. Bounded by `timeoutMs` so `/healthz` stays cheap; labelled `ping` in the plane series. */
	async ping(timeoutMs = this.timeoutMs): Promise<boolean> {
		try {
			await this.sql("SELECT 1", timeoutMs, "ping");
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * One row into `substrate_health`: the only way to know the ledger takes
	 * writes. `ping` is a `SELECT 1`, which a store with a full disk still
	 * answers; metadata says the table *would* accept a row, not that it did.
	 * Throws on failure — `probeWritable` turns that into a verdict.
	 */
	async writeProbe(timeoutMs = this.timeoutMs): Promise<void> {
		await this.sql(
			`INSERT INTO "${HEALTH_TABLE}" ("ts", "probe") VALUES (${this.q(new Date(this.clock()).toISOString())}, 'healthz')`,
			timeoutMs,
			"probe",
		);
	}

	/**
	 * The ledger's writability, re-probed at most once per `intervalMs` (uplift-2 R5).
	 *
	 * `/healthz` is called by every monitor and by the deploy gate, so the probe
	 * writes on a cadence rather than per call: a store that stopped taking
	 * writes is seen within one interval, and the health table gains at most one
	 * row an interval. `intervalMs` 0 never probes and reports `null`, which the
	 * caller treats as "not known" rather than "not writable". Overlapping calls
	 * share one in-flight probe. Never throws; a failure is the verdict, with a
	 * reason that has been through the redactor and had the store's URL scrubbed
	 * out, so the health body can carry it.
	 */
	async probeWritable(intervalMs: number, timeoutMs = this.timeoutMs): Promise<LedgerProbe> {
		if (intervalMs <= 0) return { ...this.probe };
		const now = this.clock();
		if (this.probe.lastProbeAt !== null && now - this.probe.lastProbeAt < intervalMs) return { ...this.probe };
		if (this.probeInFlight) return this.probeInFlight;
		this.probeInFlight = (async () => {
			try {
				await this.writeProbe(timeoutMs);
				this.probe = { lastProbeAt: now, lastProbeOk: true, lastProbeError: null };
			} catch (cause) {
				const reason = redactKnown(redact(String(cause)), this.hostTokens()).slice(0, 300);
				this.probe = { lastProbeAt: now, lastProbeOk: false, lastProbeError: reason };
			} finally {
				this.probeInFlight = null;
			}
			return { ...this.probe };
		})();
		return this.probeInFlight;
	}

	/** The store's URL and its host, for scrubbing a transport error that quotes where it tried to connect. */
	private hostTokens(): string[] {
		const tokens = [this.config.url];
		try {
			tokens.push(new URL(this.config.url).host);
		} catch {
			// A URL that does not parse cannot be in an error message as a host.
		}
		return tokens;
	}

	/**
	 * How much of the ledger's volume each table takes (uplift-2 R5), from
	 * `information_schema.region_statistics` — approximate, as the server says —
	 * joined to `information_schema.tables` so the rows carry names. Totals cover
	 * every table in the configured database; `tables` is the ten largest by
	 * disk, which is where the stale `agent_events_pre_append_*` table shows up
	 * for the operator to drop (never this client: see `assertAppendOnly`).
	 * Throws on failure — `/healthz` races it against a bound and reports `null`.
	 */
	async capacity(timeoutMs = this.timeoutMs): Promise<LedgerCapacity> {
		const rows = await this.sql(
			`SELECT t."table_name", r."region_rows", r."disk_size", r."sst_size", r."index_size" ` +
				`FROM "information_schema"."region_statistics" r ` +
				`JOIN "information_schema"."tables" t ON r."table_id" = t."table_id" ` +
				`WHERE t."table_schema" = ${this.q(this.config.db)}`,
			timeoutMs,
			"capacity",
		);
		const byName = new Map<string, LedgerTableCapacity>();
		const cell = (value: unknown): number => {
			const n = Number(value);
			return Number.isFinite(n) ? n : 0;
		};
		// A table may span several regions; its figures are the sum.
		for (const row of rows) {
			const name = String(row.table_name ?? "");
			if (name === "") continue;
			const table = byName.get(name) ?? { name, rows: 0, diskBytes: 0, sstBytes: 0, indexBytes: 0 };
			table.rows += cell(row.region_rows);
			table.diskBytes += cell(row.disk_size);
			table.sstBytes += cell(row.sst_size);
			table.indexBytes += cell(row.index_size);
			byName.set(name, table);
		}
		const tables = [...byName.values()].sort((a, b) => b.diskBytes - a.diskBytes || a.name.localeCompare(b.name));
		return {
			bytes: tables.reduce((sum, table) => sum + table.diskBytes, 0),
			rows: tables.reduce((sum, table) => sum + table.rows, 0),
			tables: tables.slice(0, 10),
		};
	}

	/**
	 * Whether the hourly anchor is keeping up, and what the last archive covered
	 * (uplift-3 N6). Four bounded reads, nothing written:
	 *
	 * - the newest `anchors.period_start` (one row, descending);
	 * - the anchor rows of the last {@link COVERAGE_LOOKBACK_MS};
	 * - the ingest hours of the same window as one `date_bin` histogram over
	 *   `event_ingest` — a count per hour, not the rows — so the probe costs the
	 *   same whether the hour held one record or a hundred thousand;
	 * - the newest `ledger archive` note (`surface`/`kind` are the primary key's
	 *   first and last columns, so the series is small and the `ts` bound keeps
	 *   it a window).
	 *
	 * An hour is *eligible* once it started {@link COVERAGE_ELIGIBLE_AGE_MS} ago
	 * and is closed; *uncovered* when eligible, holding at least one ingest record
	 * and having no anchor row. Membership here is "has a record in the hour",
	 * which is one step looser than `hourLeaves`'s first-record rule: an hour
	 * whose only record is a retry of an event first ingested the hour before is
	 * listed although the job rightly skips it as empty. That is a one-second
	 * window at an hour boundary and it reads as a lasting single uncovered hour —
	 * `substrate verify` on the event settles it; the probe never reads leaves.
	 *
	 * `lagHours` is counted in whole hours from the newest anchored hour to the
	 * hour `now` falls in, so `1` means every eligible hour is anchored. Throws on
	 * a failed read; `/healthz` turns that into `null` with the reason.
	 */
	async anchorCoverage(options: { now?: number } = {}): Promise<AnchorCoverage> {
		const now = options.now ?? this.clock();
		const currentHour = hourStart(now);
		const at = (ms: number): string => this.q(new Date(ms).toISOString());
		const windowStart = hourStart(now - COVERAGE_LOOKBACK_MS);

		const newest = await this.sql(`SELECT "period_start" FROM "anchors" ORDER BY "period_start" DESC LIMIT 1`, this.timeoutMs, "coverage");
		const newestMs = newest.length > 0 ? epochMsAnyUnit(newest[0]?.period_start) : Number.NaN;
		const newestAnchoredHour = Number.isFinite(newestMs) ? hourIso(newestMs) : null;
		const lagHours = Number.isFinite(newestMs) ? Math.round((currentHour - hourStart(newestMs)) / HOUR_MS) : null;

		const anchored = new Set((await this.anchorsBetween(windowStart, currentHour)).map((row) => hourStart(Date.parse(row.period_start))));

		const histogram = await this.sql(
			`SELECT to_unixtime(date_bin(INTERVAL '1 hour', "ingested_at")) AS "hour", count("event_id") AS "n" FROM "event_ingest" ` +
				`WHERE "ingested_at" >= ${at(windowStart)} AND "ingested_at" < ${at(currentHour)} ` +
				`GROUP BY to_unixtime(date_bin(INTERVAL '1 hour', "ingested_at"))`,
			this.timeoutMs,
			"coverage",
		);
		const withEvents = new Set<number>();
		for (const row of histogram) {
			const hour = epochMsAnyUnit(row.hour);
			if (!Number.isFinite(hour)) throw new GreptimeError("coverage histogram holds an hour that is not a time");
			if (Number(row.n) > 0) withEvents.add(hourStart(hour));
		}
		const uncovered: number[] = [];
		for (const hour of [...withEvents].sort((a, b) => a - b)) {
			if (now - hour < COVERAGE_ELIGIBLE_AGE_MS || !isClosed(hour, now, INGEST_LAG_MS)) continue;
			if (!anchored.has(hour)) uncovered.push(hour);
		}
		const more = uncovered.length > COVERAGE_MAX_UNCOVERED;
		const uncoveredHours = (more ? uncovered.slice(uncovered.length - COVERAGE_MAX_UNCOVERED) : uncovered).map(hourIso);

		const notes = await this.sql(
			`SELECT "ts", "id", "payload" FROM "agent_events" WHERE "surface" = 'substrate' AND "kind" = 'note' ` +
				`AND "ts" >= ${at(now - ARCHIVE_NOTE_LOOKBACK_MS)} AND "summary" LIKE ${this.q(`${ARCHIVE_NOTE_PREFIX}%`)} ` +
				// By the day in the summary (`ledger archive <YYYY-MM-DD>: …` sorts by day), not by `ts`: a note
				// retried late for an older day carries a newer `ts` and must not move the last archive day backwards.
				`ORDER BY "summary" DESC, "ts" DESC, "id" DESC LIMIT 1`,
			this.timeoutMs,
			"coverage",
		);
		let lastArchiveWindow: AnchorCoverage["lastArchiveWindow"] = null;
		const note = notes[0];
		if (note) {
			let day = "";
			try {
				const payload: unknown = JSON.parse(String(note.payload ?? "{}"));
				if (payload && typeof payload === "object" && "day" in payload && typeof payload.day === "string") day = payload.day;
			} catch {
				// A note whose payload does not parse names no day; it is not an archive record.
			}
			const writtenMs = epochMsAnyUnit(note.ts);
			if (day !== "" && Number.isFinite(writtenMs)) {
				lastArchiveWindow = { day, writtenAt: new Date(writtenMs).toISOString(), eventId: String(note.id) };
			}
		}

		return { newestAnchoredHour, lagHours, uncoveredHours, more, lastArchiveWindow };
	}

	/**
	 * The `ts` of the oldest event row, or `null` on an empty ledger — the first
	 * day an archive can cover. By `ts`, not ingest: the archive windows the
	 * time index, which is what the retention TTL expires on, and a backfilled
	 * event sits earlier in `ts` than in ingest order.
	 */
	async firstEventMs(): Promise<number | null> {
		const rows = await this.sql(`SELECT "ts" FROM "agent_events" ORDER BY "ts" ASC, "id" ASC LIMIT 1`);
		if (rows.length === 0) return null;
		const ms = epochMsAnyUnit(rows[0]?.ts);
		return Number.isFinite(ms) ? ms : null;
	}

	/**
	 * One page of a closed `ts` window, for the archive (uplift-3 N6): every
	 * stored column of the events in `[from, to)` strictly after `after` in
	 * `(ts, id)` order, the first ingest record of each, and the window's anchor
	 * receipts.
	 *
	 * Keyset, never OFFSET: `("ts" > a OR ("ts" = a AND "id" > b))` makes every
	 * page a bounded time-index read that costs the same on page 200 as on page
	 * one, and a row appended between two pages can never shift the rest. Two
	 * events sharing a millisecond are ordered by `id` on both the server and
	 * the cursor, so a tie is split the same way on every page. `next` is the
	 * last row of a full page and `null` once a page is short — the one extra
	 * empty page when the window ends exactly on a boundary is the cost of not
	 * reading one row ahead.
	 *
	 * The ingest records are read once per window, not per page: a first page
	 * (no `after`) reads every record whose `event_ts` is in the window through
	 * a bounded cursor ({@link GreptimeClient.readExportIngest}) into an id map
	 * that later pages reuse and the last page drops. `event_ts` is the event's
	 * own `ts`, so a record is found whatever its `ingested_at` — a backdated
	 * event's is later than its `ts`, a future-stamped one's far earlier — and
	 * no clock-skew bound is assumed. `event_id` is not a key, so the read is a
	 * scan of `event_ingest` once per day (what `graphIngest` and `hourLeaves`'s
	 * lookback pay too). Events on a page whose id is not in that map — a
	 * record stored after the map was built, e.g. a backfill during the export —
	 * get a bounded `event_id IN (…)` lookup under the same `event_ts` window and
	 * are merged in, so only an id still absent is counted by the archive as
	 * without a record. An event with no record is simply absent from `ingest`;
	 * the archive counts those. Anchors are read on every page because they are
	 * a handful of rows and a page is then self-contained.
	 */
	async exportWindow(query: ExportWindowQuery): Promise<ExportPage> {
		const { fromMs, toMs } = assertIsoWindow(query.from, query.to);
		await this.probeDialect().catch(() => undefined);
		const at = (ms: number): string => this.q(new Date(ms).toISOString());
		const limit = queryLimit(query.limit);
		const where = [`"ts" >= ${at(fromMs)}`, `"ts" < ${at(toMs)}`];
		if (query.after !== undefined) {
			const afterMs = Date.parse(query.after.ts);
			if (!Number.isFinite(afterMs)) throw new GreptimeError("export cursor ts must be an ISO instant");
			where.push(`("ts" > ${at(afterMs)} OR ("ts" = ${at(afterMs)} AND "id" > ${this.q(query.after.id)}))`);
		}
		const events = await this.sql(
			`SELECT ${EVENT_COLUMN_LIST} FROM "agent_events" WHERE ${where.join(" AND ")} ORDER BY "ts" ASC, "id" ASC LIMIT ${limit}`,
			this.timeoutMs,
			"export",
		);

		// The day's first ingest records, read once on the first page and reused until the window ends.
		const windowKey = `${fromMs}:${toMs}`;
		let cache = this.exportIngest;
		if (query.after === undefined || cache === null || cache.window !== windowKey) {
			this.exportIngest = null;
			// The instant before the bulk read starts: later ingest rows are the only ones the map can lack.
			const since = this.clock() - EXPORT_INGEST_SKEW_MS;
			cache = { window: windowKey, since, first: await this.readExportIngest(fromMs, toMs) };
			this.exportIngest = cache;
		}
		await this.fillExportIngest(cache.first, events.map((row) => String(row.id)), fromMs, toMs, cache.since);
		const ingest: ExportIngestRow[] = [];
		for (const row of events) {
			const id = String(row.id);
			const record = cache.first.get(id);
			if (record) {
				ingest.push({
					event_id: id,
					ingested_at: new Date(record.ingested_at).toISOString(),
					event_ts: new Date(record.event_ts).toISOString(),
				});
			}
		}

		const anchors = await this.anchorsBetween(fromMs, toMs);
		const last = events[events.length - 1];
		const next =
			events.length === limit && last !== undefined
				? { ts: new Date(epochMsAnyUnit(last.ts)).toISOString(), id: String(last.id) }
				: null;
		if (next === null) this.exportIngest = null;
		return { events, ingest, anchors, next };
	}

	/**
	 * Merge ingest rows into the day's map, the first record by `ingested_at`
	 * winning. The map is capped at {@link EXPORT_INGEST_CAP} events and a day
	 * above it throws rather than archiving with records silently missing,
	 * which would count real events as `ingestMissing` and change the hourly
	 * roots; the cap applies to the merged map ({@link fillExportIngest} adds
	 * to it) too.
	 */
	private mergeExportIngest(first: Map<string, { ingested_at: number; event_ts: number }>, rows: Array<Record<string, unknown>>): void {
		for (const row of rows) {
			const id = String(row.event_id);
			const ingested_at = epochMsAnyUnit(row.ingested_at);
			const event_ts = epochMsAnyUnit(row.event_ts);
			if (!Number.isFinite(ingested_at) || !Number.isFinite(event_ts)) {
				throw new GreptimeError(`ingest record for ${id} has a time that is not a number`);
			}
			const seen = first.get(id);
			if (seen === undefined && first.size >= EXPORT_INGEST_CAP) {
				throw new GreptimeError(`the export window holds more than ${EXPORT_INGEST_CAP} ingest records; refusing to archive it with records missing`);
			}
			if (!seen || ingested_at < seen.ingested_at) first.set(id, { ingested_at, event_ts });
		}
	}

	/**
	 * Records for page events the day's map does not hold: an ingest row stored
	 * after the first page's read began (a collector backfilling the closed day
	 * during the export). Bounded on the time index, `ingested_at >= sinceMs`,
	 * where `sinceMs` is the start of the first read less
	 * {@link EXPORT_INGEST_SKEW_MS}: a record that predates the read is already
	 * in the map, so an id absent from it and older than that instant has no
	 * record and is never searched for — a legacy event from before
	 * `event_ingest` existed costs a lookup over the recent tail only, not the
	 * table's history. Also looked up by id in batches of {@link IN_BATCH} under
	 * the same `event_ts` window, and merged into the map; an id still absent
	 * is genuinely without a record. Costs nothing when every id is in the map.
	 */
	private async fillExportIngest(
		first: Map<string, { ingested_at: number; event_ts: number }>,
		ids: string[],
		fromMs: number,
		toMs: number,
		sinceMs: number,
	): Promise<void> {
		const at = (ms: number): string => this.q(new Date(ms).toISOString());
		const missing = ids.filter((id) => !first.has(id));
		for (let i = 0; i < missing.length; i += IN_BATCH) {
			const batch = missing.slice(i, i + IN_BATCH).map((id) => this.q(id)).join(", ");
			const rows = await this.sql(
				`SELECT "event_id", "ingested_at", "event_ts" FROM "event_ingest" WHERE "ingested_at" >= ${at(sinceMs)} AND "event_ts" >= ${at(fromMs)} AND "event_ts" < ${at(toMs)} AND "event_id" IN (${batch})`,
				this.timeoutMs,
				"export",
			);
			this.mergeExportIngest(first, rows);
		}
	}

	/**
	 * Every first ingest record whose `event_ts` falls in `[fromMs, toMs)`,
	 * keyed by event id, for {@link exportWindow}. `event_ts` is stored verbatim
	 * from the event's own `ts` (`emit`'s INSERT), so this is exactly the set
	 * of records of the window's events — a future-stamped or backdated event
	 * resolves like any other, whatever its `ingested_at`. Read through a
	 * keyset cursor on the time index, `(ingested_at, event_id)`, in pages of
	 * {@link MAX_QUERY_LIMIT}; the first record by `ingested_at` wins.
	 */
	private async readExportIngest(fromMs: number, toMs: number): Promise<Map<string, { ingested_at: number; event_ts: number }>> {
		const at = (ms: number): string => this.q(new Date(ms).toISOString());
		const first = new Map<string, { ingested_at: number; event_ts: number }>();
		let cursor: { ms: number; id: string } | undefined;
		for (;;) {
			const where = [`"event_ts" >= ${at(fromMs)}`, `"event_ts" < ${at(toMs)}`];
			if (cursor !== undefined) {
				where.push(`("ingested_at" > ${at(cursor.ms)} OR ("ingested_at" = ${at(cursor.ms)} AND "event_id" > ${this.q(cursor.id)}))`);
			}
			const rows = await this.sql(
				`SELECT "event_id", "ingested_at", "event_ts" FROM "event_ingest" WHERE ${where.join(" AND ")} ORDER BY "ingested_at" ASC, "event_id" ASC LIMIT ${MAX_QUERY_LIMIT}`,
				this.timeoutMs,
				"export",
			);
			this.mergeExportIngest(first, rows);
			const last = rows[rows.length - 1];
			if (rows.length < MAX_QUERY_LIMIT || last === undefined) return first;
			cursor = { ms: epochMsAnyUnit(last.ingested_at), id: String(last.event_id) };
		}
	}

	// ── metrics history (uplift-4 S6) ────────────────────────────────────────

	/** Whether `metric_samples` is known to exist. Set by the first successful CREATE, so a deployment with the history off never creates it. */
	private metricSamplesReady = false;
	private metricSamplesCreating: Promise<void> | null = null;
	private metricSamplesSchemaLogged = false;

	/**
	 * `CREATE TABLE IF NOT EXISTS metric_samples`, once per process, on first use.
	 *
	 * The TTL is part of the CREATE, so no new `ALTER` shape is needed and
	 * `assertAppendOnly` is untouched (`create` is already an allowed verb). It is
	 * re-rendered from the parsed day count, never taken from the caller's string,
	 * and a table that already exists keeps the retention it has: changing it is
	 * the operator's `ALTER`. A failure is not remembered, so the next call retries.
	 */
	private async ensureMetricSamples(ttl: string): Promise<void> {
		if (this.metricSamplesReady) return;
		const retention = parseMetricsHistoryTtl(ttl);
		if (retention === null) throw new GreptimeError("the metrics history ttl is not a whole number of days from 1d to 90d");
		this.metricSamplesCreating ??= this.createMetricSamples(retention.ttl).finally(() => {
			this.metricSamplesCreating = null;
		});
		await this.metricSamplesCreating;
	}

	/**
	 * CREATE, then ask the LIVE table whether it is in append_mode, as the ledger
	 * tables are asked: `CREATE TABLE IF NOT EXISTS` leaves an older table's
	 * options alone, and without `append_mode` rows of different labels that share a
	 * series and a millisecond replace one another. Only a table that answers
	 * `append_mode = 'true'` is ready; one that does not is refused as
	 * {@link MetricSamplesSchemaError} on every sample (re-asked each time, so an
	 * operator's drop-and-recreate is picked up) and named once on stderr. The
	 * client never drops or alters it.
	 */
	private async createMetricSamples(ttl: string): Promise<void> {
		await this.sql(
			`CREATE TABLE IF NOT EXISTS "${METRIC_SAMPLES_TABLE}" (` +
				`"ts" TIMESTAMP TIME INDEX, "series" STRING, "labels" STRING, "kind" STRING, "value" DOUBLE, "count" BIGINT, PRIMARY KEY ("series")` +
				`) WITH ('append_mode' = 'true', 'ttl' = '${ttl}')`,
			METRIC_WRITE_TIMEOUT_MS,
		);
		const rows = await this.sql(`SHOW CREATE TABLE "${METRIC_SAMPLES_TABLE}"`, METRIC_WRITE_TIMEOUT_MS);
		if (rows.length === 0) throw new GreptimeError(`could not read the options of ${METRIC_SAMPLES_TABLE}`);
		const ddl = Object.values(rows[0] ?? {})
			.map((value) => String(value))
			.join(" ");
		if (!/append_mode'?\s*=\s*'?true/i.test(ddl)) {
			if (!this.metricSamplesSchemaLogged) {
				this.metricSamplesSchemaLogged = true;
				process.stderr.write(
					`[substrate] metrics history: ${METRIC_SAMPLES_TABLE} exists without append_mode, so samples of different labels could replace one another and none are written; ` +
						"an operator must drop and recreate the table (the client never does)\n",
				);
			}
			throw new MetricSamplesSchemaError(`${METRIC_SAMPLES_TABLE} is not in append_mode`);
		}
		this.metricSamplesReady = true;
	}

	/**
	 * One multi-row INSERT of the sampler's rows. Never throws and never waits on
	 * a request path: on any failure the whole batch is dropped and the result
	 * says how many rows and why (a closed reason), for the caller to count.
	 *
	 * Rows are validated against the series allow-list before anything is sent —
	 * a series outside it, labels outside its closed set, or a non-finite number
	 * is dropped as `invalid` — and the rest are quoted through the dialect-aware
	 * literal helper. The deadline sits inside the gated call (`send`), so a
	 * timeout is a breaker failure and an open breaker costs no network.
	 */
	async recordMetricSamples(rows: readonly MetricSampleRow[], ttl: string = DEFAULT_METRICS_HISTORY_TTL): Promise<MetricWriteResult> {
		const drops: Partial<Record<MetricDropReason, number>> = {};
		const drop = (reason: MetricDropReason, count: number): void => {
			if (count > 0) drops[reason] = (drops[reason] ?? 0) + count;
		};
		const accepted: Array<{ row: MetricSampleRow; labels: string; kind: string }> = [];
		let invalid = 0;
		let capped = 0;
		for (const row of rows) {
			const labels = validMetricRow(row);
			// Look the spec up only for a row validMetricRow accepted: a null or undefined entry must be counted as invalid, not throw on `row.series`.
			const kind = labels === null ? undefined : ALL_METRIC_SERIES[row.series]?.kind;
			if (labels === null || kind === undefined) {
				invalid += 1;
			} else if (accepted.length >= MAX_METRIC_BATCH) {
				capped += 1;
			} else {
				accepted.push({ row, labels, kind });
			}
		}
		drop("invalid", invalid);
		drop("capped", capped);
		if (accepted.length === 0) return { stored: 0, drops };

		let stage: "ddl" | "insert" = "ddl";
		try {
			await this.ensureMetricSamples(ttl);
			// Best effort: the labels carry no backslash by construction, so the dialect only sharpens reads.
			await this.probeDialect().catch(() => undefined);
			stage = "insert";
			const values = accepted
				.map(
					({ row, labels, kind }) =>
						`(${this.q(new Date(row.tsMs).toISOString())}, ${this.q(row.series)}, ${this.q(labels)}, ` +
						`${this.q(kind)}, ${this.q(row.value)}, ${this.q(row.count)})`,
				)
				.join(", ");
			await this.sql(
				`INSERT INTO "${METRIC_SAMPLES_TABLE}" ("ts", "series", "labels", "kind", "value", "count") VALUES ${values}`,
				METRIC_WRITE_TIMEOUT_MS,
			);
			return { stored: accepted.length, drops };
		} catch (cause) {
			drop(metricDropReason(cause, stage), accepted.length);
			return { stored: 0, drops };
		}
	}

	/**
	 * Aggregated history for one allow-listed series: `date_bin` buckets of
	 * `stepS` seconds, folded per the series' own rule, newest {@link MAX_METRIC_POINTS}
	 * points returned oldest first. The window is capped at the configured TTL and
	 * the step is raised by {@link effectiveHistoryStep} until buckets x label values
	 * fit the point cap, so the oldest bucket of the window is present; the step it
	 * ran at is returned. Series, window and step are validated here as well as by
	 * the route; nothing from the caller reaches the statement but a quoted
	 * allow-listed name and whole numbers.
	 *
	 * A read never creates the table — `recordMetricSamples` owns that — so a
	 * table that does not exist yet is an empty history, not an error. The deadline
	 * is tighter than the ledger's default because this runs behind a public GET
	 * through the ledger's breaker.
	 */
	async readMetricHistory(query: MetricHistoryQuery): Promise<MetricHistoryResult> {
		const spec = Object.hasOwn(ALL_METRIC_SERIES, query.series) ? ALL_METRIC_SERIES[query.series] : undefined;
		if (spec === undefined) throw new MetricHistoryInputError("the series is not one this substrate records");
		const retention = parseMetricsHistoryTtl(query.ttl ?? DEFAULT_METRICS_HISTORY_TTL);
		if (retention === null) throw new MetricHistoryInputError("the metrics history ttl is not a whole number of days from 1d to 90d");
		const limit = 8.64e15;
		if (![query.fromMs, query.toMs, query.stepS].every((value) => Number.isFinite(value)) || Math.abs(query.toMs) > limit || Math.abs(query.fromMs) > limit) {
			throw new MetricHistoryInputError("the window and step must be finite numbers");
		}
		const toMs = Math.trunc(query.toMs);
		const fromMs = Math.max(Math.trunc(query.fromMs), toMs - retention.days * DAY_MS);
		if (toMs <= fromMs) throw new MetricHistoryInputError("the window is empty");
		const stepS = effectiveHistoryStep(query.series, toMs - fromMs, query.stepS);

		// No dialect probe: the series is an allow-listed slug and the bounds are ISO instants, so no literal carries a backslash.
		const at = (ms: number): string => this.q(new Date(ms).toISOString());
		const value =
			spec.agg === "sum"
				? 'SUM("value")'
				: spec.agg === "max"
					? 'MAX("value")'
					: spec.agg === "wavg"
						? 'SUM("value" * "count") / SUM("count")'
						: 'AVG("value")';
		let rows: Array<Record<string, unknown>>;
		try {
			rows = await this.sql(
				`SELECT date_bin(INTERVAL '${stepS} seconds', "ts") AS "bucket", "labels", ${value} AS "value", SUM("count") AS "count" ` +
					`FROM "${METRIC_SAMPLES_TABLE}" WHERE "series" = ${this.q(query.series)} AND "ts" >= ${at(fromMs)} AND "ts" < ${at(toMs)} ` +
					`GROUP BY "bucket", "labels" ORDER BY "bucket" DESC LIMIT ${MAX_METRIC_POINTS}`,
				METRIC_READ_TIMEOUT_MS,
				"history",
			);
		} catch (cause) {
			// Only the store's own "no such table" answer: it was never created (the history was never on), which is an empty history.
			if (cause instanceof GreptimeError && !(cause instanceof GreptimeUnavailable) && cause.missingTable) return { points: [], stepS };
			throw cause;
		}
		const points: MetricHistoryPoint[] = [];
		for (const row of rows) {
			const tsMs = epochMsAnyUnit(row.bucket);
			if (!Number.isFinite(tsMs)) continue;
			const number = row.value === null || row.value === undefined ? Number.NaN : Number(row.value);
			points.push({
				tsMs,
				labels: readLabels(query.series, row.labels),
				value: Number.isFinite(number) ? number : null,
				count: Number.isFinite(Number(row.count)) ? Number(row.count) : 0,
			});
		}
		return { points: points.reverse(), stepS };
	}
}

// uplift-4 S6
/** Where the metrics history lives. Append-only with a TTL, created on first use and only when `SUBSTRATE_METRICS_HISTORY=on`. */
export const METRIC_SAMPLES_TABLE = "metric_samples";

/** One INSERT or CREATE's deadline, inside the gated call. Below the smallest sampling interval, so a batch can never overlap the next tick on its own. */
const METRIC_WRITE_TIMEOUT_MS = 3000;

/** The readback's deadline: below the ledger default, because it runs behind a public GET and a timeout charges the shared breaker. */
const METRIC_READ_TIMEOUT_MS = 2500;

/** What Greptime says when a table does not exist (`Table not found: …`, code 4001, or a "does not exist" wording). */
const MISSING_TABLE = /table[^\n]{0,200}(?:not found|not exist|doesn't exist)|TableNotFound|\b4001\b/i;

/** What `recordMetricSamples` did. `drops` is by closed reason, row counts; empty when everything was stored. */
export interface MetricWriteResult {
	stored: number;
	drops: Partial<Record<MetricDropReason, number>>;
}

export interface MetricHistoryQuery {
	series: string;
	fromMs: number;
	toMs: number;
	stepS: number;
	/** The table's retention, which caps the window; the default when omitted. */
	ttl?: string;
}

export interface MetricHistoryPoint {
	tsMs: number;
	/** Only the series' closed label, see `readLabels`. */
	labels: Record<string, string>;
	value: number | null;
	count: number;
}

/** What a readback returns: the points, oldest first, and the step the read actually ran at. */
export interface MetricHistoryResult {
	points: MetricHistoryPoint[];
	stepS: number;
}

/** A readback request outside what the history serves: not a store failure. */
export class MetricHistoryInputError extends GreptimeError {}

/** The live `metric_samples` table is not in append_mode; only an operator can fix it (drop and recreate). */
export class MetricSamplesSchemaError extends GreptimeError {}

/** The labels JSON of a row that may be stored, or `null`: outside the allow-list, or a number the column cannot hold. */
function validMetricRow(row: MetricSampleRow): string | null {
	if (row === null || typeof row !== "object") return null;
	if (!Number.isFinite(row.tsMs) || row.tsMs <= 0 || row.tsMs > 8.64e15) return null;
	if (!Number.isFinite(row.value)) return null;
	if (!Number.isSafeInteger(row.count) || row.count < 0) return null;
	if (row.labels === null || typeof row.labels !== "object") return null;
	return canonicalLabels(row.series, row.labels);
}

/** The closed reason a failed metrics write is counted under. */
function metricDropReason(cause: unknown, stage: "ddl" | "insert"): MetricDropReason {
	if (cause instanceof GreptimeBreakerOpen) return "breaker_open";
	if (cause instanceof MetricSamplesSchemaError) return "schema";
	if (cause instanceof GreptimeUnavailable) return "unavailable";
	if (cause instanceof GreptimeError) return stage === "ddl" ? "ddl" : "rejected";
	return "internal";
}
