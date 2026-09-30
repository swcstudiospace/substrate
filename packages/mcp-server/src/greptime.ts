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
 * unreachable event store must never block an agent.
 */
import type { GreptimeConfig } from "./config.ts";
import type { SubstrateEvent } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 5000;

export class GreptimeError extends Error {}

/** A statement the ledger client refuses to send. See `assertAppendOnly`. */
export class AppendOnlyViolation extends GreptimeError {}

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

	constructor(
		private readonly config: GreptimeConfig,
		private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
	) {}

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
	async sql(statement: string): Promise<Array<Record<string, unknown>>> {
		assertAppendOnly(statement);
		const url = `${this.config.url}/v1/sql?db=${encodeURIComponent(this.config.db)}`;
		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers: this.headers(),
				body: new URLSearchParams({ sql: statement }),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (cause) {
			throw new GreptimeError(`greptime unreachable: ${String(cause)}`);
		}

		const text = await response.text();
		if (!response.ok) throw new GreptimeError(`greptime ${response.status}: ${text.slice(0, 500)}`);

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

		await this.sql(`
			CREATE TABLE IF NOT EXISTS "anchors" (
				"period_start" TIMESTAMP TIME INDEX,
				"period_end"   TIMESTAMP,
				"root"         STRING,
				"tx_sig"       STRING,
				"event_count"  BIGINT,
				PRIMARY KEY ("root")
			)
		`);

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
		const rows = await this.sql(`SHOW CREATE TABLE "agent_events"`).catch(() => null);
		if (!rows || rows.length === 0) return null;
		const ddl = Object.values(rows[0] ?? {})
			.map((value) => String(value))
			.join(" ");
		// Greptime prints the option unquoted (`append_mode = 'true'`); the DDL we
		// send quotes the key. Tolerate both rather than reporting a false mismatch.
		this.appendMode = /append_mode'?\s*=\s*'?true/i.test(ddl);
		return this.appendMode;
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
	 */
	async commitEventsNaming(repo: string, sha: string, limit = 20): Promise<Array<Record<string, unknown>>> {
		if (!/^[0-9a-f]{7,40}$/i.test(sha)) return [];
		const prefix = sha.slice(0, 7).toLowerCase();
		const capped = Math.min(100, Math.max(1, Math.trunc(limit)));
		return this.sql(
			`SELECT "ts", "id", "surface", "summary", "payload" FROM "agent_events"
			 WHERE "repo" = ${this.q(repo)} AND "kind" = 'commit'
			   AND ("summary" LIKE ${this.q(`%${prefix}%`)} OR "payload" LIKE ${this.q(`%${prefix}%`)})
			 ORDER BY "ts" DESC LIMIT ${capped}`,
		);
	}

	async ping(): Promise<boolean> {
		try {
			await this.sql("SELECT 1");
			return true;
		} catch {
			return false;
		}
	}
}
