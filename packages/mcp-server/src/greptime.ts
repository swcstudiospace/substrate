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
 */
import { BreakerOpenError, callPlane, type PlaneGate } from "@substrate/observability";
import type { GreptimeConfig } from "./config.ts";
import type { SubstrateEvent } from "./types.ts";
import { hourEnd, hourStart, isClosed } from "@substrate/ledger";

const DEFAULT_TIMEOUT_MS = 5000;

export class GreptimeError extends Error {}

/**
 * The ledger did not answer, or answered broken: unreachable, timed out, a 5xx,
 * or refused by an open breaker. Only these charge the breaker — a SQL error is
 * the statement's fault and the store is fine.
 */
export class GreptimeUnavailable extends GreptimeError {}

/**
 * The bounded operation label for a statement: its leading verb. Never the
 * statement itself, which would put every distinct query into a metric series.
 */
export function sqlOp(statement: string): "select" | "insert" | "show" | "create" | "other" {
	const verb = /^\s*(select|insert|show|create)\b/i.exec(statement)?.[1]?.toLowerCase();
	return verb === "select" || verb === "insert" || verb === "show" || verb === "create" ? verb : "other";
}

export interface GreptimeClientOptions {
	timeoutMs?: number;
	clock?: () => number;
	/** The ledger's plane gate; null runs every call unwrapped, as before breakers existed. */
	gate?: PlaneGate | null;
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
}

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

/**
 * The tip of a hash chain: the event nothing else points back to.
 *
 * Within a window of a session's newest rows, the newest is the one whose `hash`
 * no other row claims as its `prev`. The chain carries the order that a
 * millisecond timestamp loses. Falls back to the first row — newest by `ts` —
 * when the window holds no identifiable tip.
 */
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

export function chainTip(rows: Array<Record<string, unknown>>): string | null {
	const hashes = rows.filter((row) => typeof row.hash === "string").map((row) => String(row.hash));
	if (hashes.length === 0) return null;
	const claimed = new Set(rows.filter((row) => typeof row.prev === "string").map((row) => String(row.prev)));
	return hashes.find((hash) => !claimed.has(hash)) ?? hashes[0] ?? null;
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

	constructor(
		private readonly config: GreptimeConfig,
		options: GreptimeClientOptions = {},
	) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.clock = options.clock ?? Date.now;
		this.gate = options.gate ?? null;
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
	 * than a convention each caller has to remember.
	 */
	async sql(statement: string, timeoutMs = this.timeoutMs, op: string = sqlOp(statement)): Promise<Array<Record<string, unknown>>> {
		assertAppendOnly(statement);
		const url = `${this.config.url}/v1/sql?db=${encodeURIComponent(this.config.db)}`;
		let answer: { status: number; text: string };
		try {
			// Everything thrown inside is the plane's fault — a transport error, a
			// timeout, a 5xx — so the gate counts all of it. The raw fetch error is
			// thrown as-is so a timeout is observed as one, and wrapped below.
			answer = await callPlane(this.gate, op, async () => {
				const response = await fetch(url, {
					method: "POST",
					headers: this.headers(),
					body: new URLSearchParams({ sql: statement }),
					signal: AbortSignal.timeout(timeoutMs),
				});
				const text = await response.text();
				if (response.status >= 500) throw new GreptimeUnavailable(`greptime ${response.status}: ${text.slice(0, 500)}`);
				return { status: response.status, text };
			});
		} catch (cause) {
			if (cause instanceof GreptimeUnavailable) throw cause;
			if (cause instanceof BreakerOpenError) throw new GreptimeUnavailable(cause.message);
			throw new GreptimeUnavailable(`greptime unreachable: ${String(cause)}`);
		}

		const { status, text } = answer;
		if (status < 200 || status >= 300) throw new GreptimeError(`greptime ${status}: ${text.slice(0, 500)}`);

		let body: GreptimeResponse;
		try {
			body = JSON.parse(text) as GreptimeResponse;
		} catch {
			throw new GreptimeError(`greptime returned non-JSON: ${text.slice(0, 200)}`);
		}
		if (body.error) throw new GreptimeError(`greptime: ${body.error}`);

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

		return { warnings };
	}

	/**
	 * Whether the ledger is proven append-only, re-asking when the answer is stale.
	 *
	 * The answer cannot be cached for the life of the process. Fixing a
	 * deduplicating table means recreating it *outside* this process — the client
	 * refuses `ALTER` and `RENAME` by design — so a permanently cached `false` would
	 * leave the write path refusing every event, and `/healthz` red, until someone
	 * thought to restart the service. The operator would have done the documented
	 * fix and seen nothing change. The converse matters too: a table swapped back to
	 * a deduplicating one must stop being treated as safe.
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
		await this.sql(`INSERT INTO "agent_events" (${EVENT_COLUMN_LIST}) VALUES (${values})`);

		// The ingest record goes second: it must never name an event that does not
		// exist. Each attempt takes a fresh stamp immediately before its INSERT; a
		// duplicate can only appear when the retry follows an ambiguous timeout
		// that had in fact landed, and the hour read collapses it (D27-10).
		// `quote(null)` renders a null graph_id as NULL with no branch (D27-07).
		// Both attempts, and the live append_mode probe, share INGEST_BUDGET_MS so
		// a caller that already has the event row is not held for two full timeouts.
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
	 * Latest event hash for a session — the `prev` of the next one.
	 *
	 * Reads the whole session rather than a window of its newest rows, because `ts`
	 * is collector-supplied and so is not append order: the Grok collector passes
	 * the source timestamp through, and its backfill pass appends events older than
	 * everything already stored. A window ordered by `ts` would not contain the real
	 * chain tip, and the next append would chain onto a hash that already had a
	 * successor — forking the session. Only `hash` and `prev` are selected, so the
	 * read stays small even for a long session.
	 *
	 * `"id"` breaks a same-millisecond tie so the order is at least stable across
	 * calls; it is a random UUID, so deterministic but arbitrary, which is why
	 * `chainTip` decides the tip from `prev` rather than from position.
	 */
	async lastHash(sessionId: string): Promise<string | null> {
		const rows = await this.sql(
			`SELECT "hash", "prev" FROM "agent_events" WHERE "session_id" = ${this.q(sessionId)}
			 ORDER BY "ts" DESC, "id" DESC LIMIT ${MAX_SESSION_ROWS}`,
		);
		return chainTip(rows);
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
	 */
	async eventIdsAfter(cursor: CursorPosition, limit: number): Promise<CursorPosition[]> {
		const at = this.q(new Date(cursor.ingestedAt).toISOString());
		const rows = await this.sql(
			`SELECT i."event_id", i."ingested_at" FROM "event_ingest" i
			 WHERE i."ingested_at" >= ${at}
			   AND NOT EXISTS (
			     SELECT 1 FROM "event_ingest" p
			      WHERE p."event_id" = i."event_id"
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
			positions.push({ id, ingestedAt });
			if (positions.length >= limit) break;
		}
		return positions;
	}

	/**
	 * The event rows for ids taken from {@link eventIdsAfter}: every column but
	 * `payload` unless asked — the same selection `queryEvents` makes — so a
	 * stream frame and a query row cannot disagree about what an event is.
	 */
	async eventsByIds(ids: string[], includePayload = false): Promise<Array<Record<string, unknown>>> {
		if (ids.length === 0) return [];
		const columns = (includePayload ? EVENT_COLUMNS : EVENT_COLUMNS.filter((column) => column !== "payload"))
			.map((column) => `"${column}"`)
			.join(", ");
		const list = ids.map((id) => this.q(id)).join(", ");
		return this.sql(`SELECT ${columns} FROM "agent_events" WHERE "id" IN (${list})`);
	}

	/**
	 * Every stored column for one session or graph, oldest first, for chain
	 * verification. `"id"` is a tie-breaker so two events in the same millisecond
	 * come back in a stable order rather than an arbitrary one; `inChainOrder` then
	 * puts them in the order `prev` actually records.
	 */
	async readEvents(column: "session_id" | "graph_id", value: string): Promise<Array<Record<string, unknown>>> {
		return this.sql(
			`SELECT ${EVENT_COLUMN_LIST} FROM "agent_events" WHERE "${column}" = ${this.q(value)}
			 ORDER BY "ts", "id"`,
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
}
