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

	/** Idempotent DDL. Safe to run on every boot. */
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
				PRIMARY KEY ("surface", "repo", "graph_id", "kind")
			)
		`);
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
	}

	async insertEvent(event: SubstrateEvent): Promise<void> {
		const values = [
			quote(event.ts),
			quote(event.id),
			quote(event.surface),
			quote(event.session_id),
			quote(event.graph_id),
			quote(event.node_id),
			quote(event.linear_identifier),
			event.step === null ? "NULL" : quote(event.step),
			quote(event.repo),
			quote(event.branch),
			quote(event.actor),
			quote(event.kind),
			quote(event.summary),
			quote(JSON.stringify(event.payload)),
			quote(event.hash),
			quote(event.prev),
		].join(", ");
		await this.sql(
			`INSERT INTO "agent_events" ("ts", "id", "surface", "session_id", "graph_id", "node_id", "linear_identifier", "step", "repo", "branch", "actor", "kind", "summary", "payload", "hash", "prev") VALUES (${values})`,
		);
	}

	/** Latest event hash for a session — the `prev` of the next one. */
	async lastHash(sessionId: string): Promise<string | null> {
		const rows = await this.sql(
			`SELECT "hash" FROM "agent_events" WHERE "session_id" = ${quote(sessionId)} ORDER BY "ts" DESC LIMIT 1`,
		);
		const hash = rows[0]?.hash;
		return typeof hash === "string" ? hash : null;
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
