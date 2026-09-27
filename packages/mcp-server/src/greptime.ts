/**
 * GreptimeDB client over the HTTP SQL API.
 *
 * Greptime holds the append-only event log. It lives on a Railway account this
 * host reaches over the public internet, so every call is timed out and every
 * failure is the caller's to handle — an unreachable event store must never
 * block an agent.
 */
import type { GreptimeConfig } from "./config.ts";
import type { SubstrateEvent } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 5000;

export class GreptimeError extends Error {}

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

/** SQL string literal. Greptime's HTTP API takes no bind parameters, so quoting is ours to get right. */
export function quote(value: string | number | null): string {
	if (value === null) return "NULL";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
	return `'${value.replace(/'/g, "''")}'`;
}

/** Every agent_events column, in INSERT and SELECT order. `ingested_at` joined at the Phase 6 cutover. */
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
	"ingested_at",
] as const;

const EVENT_SELECT = EVENT_COLUMNS.map((name) => `"${name}"`).join(", ");

/** One column as information_schema.columns reports it. */
export interface ColumnInfo {
	name: string;
	/** TAG, FIELD or TIMESTAMP (the time index). */
	semantic: string;
	type: string;
}

/** The latest event of the global ingest chain. */
export interface ChainHead {
	hash: string;
	ingestedAtMs: number;
}

/** agent_events' storage key: the tags plus the time index. Two rows on one key collapse (last_row). */
export interface EventKey {
	surface: string;
	repo: string | null;
	graph_id: string | null;
	kind: string;
	tsMs: number;
}

/** `"col" = 'v'`, or `"col" IS NULL` — `= NULL` never matches. */
function nullSafeEquals(column: string, value: string | null): string {
	return value === null ? `"${column}" IS NULL` : `"${column}" = ${quote(value)}`;
}

function eventValues(event: SubstrateEvent): string {
	return [
		quote(event.ts),
		quote(event.id),
		quote(event.surface),
		quote(event.session_id),
		quote(event.graph_id),
		quote(event.node_id),
		quote(event.linear_identifier),
		quote(event.step),
		quote(event.repo),
		quote(event.branch),
		quote(event.actor),
		quote(event.kind),
		quote(event.summary),
		quote(JSON.stringify(event.payload)),
		quote(event.hash),
		quote(event.prev),
		quote(event.ingested_at ?? null),
	].join(", ");
}

export class GreptimeClient {
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

	/** Run SQL and return rows as objects keyed by column name. */
	async sql(statement: string): Promise<Array<Record<string, unknown>>> {
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
	 * Idempotent, guarded DDL. Safe to run on every boot.
	 *
	 * Greptime has no `ADD COLUMN IF NOT EXISTS`, and `CREATE TABLE IF NOT EXISTS` keeps an old
	 * schema, so both schema changes read information_schema first. The old root-keyed anchors
	 * table is dropped only while it is empty; with rows it refuses and the caller logs degraded.
	 */
	async migrate(): Promise<void> {
		// Every identifier is quoted: Greptime's parser reserves `id`, among others,
		// and rejects it as a bare column name.
		await this.sql(`
			CREATE TABLE IF NOT EXISTS "agent_events" (
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
				"ingested_at"       TIMESTAMP,
				PRIMARY KEY ("surface", "repo", "graph_id", "kind")
			)
		`);
		const eventColumns = await this.columns("agent_events");
		if (!eventColumns.some((column) => column.name === "ingested_at")) {
			await this.sql(`ALTER TABLE "agent_events" ADD COLUMN "ingested_at" TIMESTAMP`);
		}

		const anchorColumns = await this.columns("anchors");
		if (anchorColumns.some((column) => column.name === "root" && column.semantic === "TAG")) {
			const rows = await this.sql(`SELECT count(*) AS "n" FROM "anchors"`);
			const count = Number(rows[0]?.n ?? Number.NaN);
			if (count !== 0) {
				throw new GreptimeError(
					`anchors has the old root-keyed schema and ${Number.isNaN(count) ? "an unknown number of" : count} rows; refusing to drop anchors`,
				);
			}
			await this.sql(`DROP TABLE "anchors"`);
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
	}

	/** A table's columns from information_schema.columns, in table order; empty when the table is absent. */
	async columns(table: string): Promise<ColumnInfo[]> {
		const rows = await this.sql(
			`SELECT "column_name", "semantic_type", "data_type" FROM information_schema.columns WHERE "table_schema" = ${quote(this.config.db)} AND "table_name" = ${quote(table)} ORDER BY "ordinal_position"`,
		);
		return rows.map((row) => ({
			name: String(row.column_name),
			semantic: String(row.semantic_type),
			type: String(row.data_type),
		}));
	}

	/** Write a whole ingest batch in ONE multi-row INSERT (one round trip). */
	async insertEvents(events: readonly SubstrateEvent[]): Promise<void> {
		if (events.length === 0) return;
		const columns = EVENT_COLUMNS.map((name) => `"${name}"`).join(", ");
		const tuples = events.map((event) => `(${eventValues(event)})`).join(", ");
		await this.sql(`INSERT INTO "agent_events" (${columns}) VALUES ${tuples}`);
	}

	/** The latest post-cutover event (by ingested_at), or null before the genesis. */
	async chainHead(): Promise<ChainHead | null> {
		const rows = await this.sql(
			`SELECT "hash", "ingested_at" FROM "agent_events" WHERE "ingested_at" IS NOT NULL ORDER BY "ingested_at" DESC LIMIT 1`,
		);
		const row = rows[0];
		if (!row) return null;
		const ingestedAtMs = Number(row.ingested_at);
		if (typeof row.hash !== "string" || !Number.isFinite(ingestedAtMs)) {
			throw new GreptimeError("chain head row has no hash or ingested_at");
		}
		return { hash: row.hash, ingestedAtMs };
	}

	/** Every stored row on any of these exact storage keys, in one statement (NULL-safe tags). */
	async eventsAtKeys(keys: readonly EventKey[]): Promise<Array<Record<string, unknown>>> {
		if (keys.length === 0) return [];
		const where = keys
			.map(
				(key) =>
					`(${nullSafeEquals("surface", key.surface)} AND ${nullSafeEquals("repo", key.repo)} AND ${nullSafeEquals("graph_id", key.graph_id)} AND ${nullSafeEquals("kind", key.kind)} AND "ts" = ${quote(key.tsMs)})`,
			)
			.join(" OR ");
		return this.sql(`SELECT ${EVENT_SELECT} FROM "agent_events" WHERE ${where}`);
	}

	/** One ingest hour `[startMs, endMs)` of the global chain, in chain order. */
	async hourEvents(startMs: number, endMs: number): Promise<Array<Record<string, unknown>>> {
		return this.sql(
			`SELECT ${EVENT_SELECT} FROM "agent_events" WHERE "ingested_at" >= ${quote(startMs)} AND "ingested_at" < ${quote(endMs)} ORDER BY "ingested_at", "id"`,
		);
	}

	/** The newest post-cutover row ingested before `ms` — the chain boundary of the hour starting there. */
	async lastEventBefore(ms: number): Promise<Record<string, unknown> | null> {
		const rows = await this.sql(
			`SELECT ${EVENT_SELECT} FROM "agent_events" WHERE "ingested_at" IS NOT NULL AND "ingested_at" < ${quote(ms)} ORDER BY "ingested_at" DESC LIMIT 1`,
		);
		return rows[0] ?? null;
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
