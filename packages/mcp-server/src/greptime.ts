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
		return /append_mode'?\s*=\s*'?true/i.test(ddl);
	}

	async insertEvent(event: SubstrateEvent): Promise<void> {
		const cell = (column: (typeof EVENT_COLUMNS)[number]): string => {
			if (column === "payload") return this.q(JSON.stringify(event.payload));
			const value = event[column];
			return value === null ? "NULL" : this.q(value as string | number);
		};
		const values = EVENT_COLUMNS.map(cell).join(", ");
		await this.sql(`INSERT INTO "agent_events" (${EVENT_COLUMN_LIST}) VALUES (${values})`);
	}

	/** Latest event hash for a session — the `prev` of the next one. */
	async lastHash(sessionId: string): Promise<string | null> {
		const rows = await this.sql(
			`SELECT "hash" FROM "agent_events" WHERE "session_id" = ${this.q(sessionId)} ORDER BY "ts" DESC LIMIT 1`,
		);
		const hash = rows[0]?.hash;
		return typeof hash === "string" ? hash : null;
	}

	/** Every stored column for one session or graph, oldest first, for chain verification. */
	async readEvents(column: "session_id" | "graph_id", value: string): Promise<Array<Record<string, unknown>>> {
		return this.sql(
			`SELECT ${EVENT_COLUMN_LIST} FROM "agent_events" WHERE "${column}" = ${this.q(value)} ORDER BY "ts"`,
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
