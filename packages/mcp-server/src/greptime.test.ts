/**
 * The ledger client, against a mocked Greptime.
 *
 * Nothing here touches the network: `fetch` is replaced and every assertion is
 * about the SQL that would have gone over it. That is the part worth pinning —
 * Greptime's HTTP API has no bind parameters, so the statement this file builds
 * is the entire contract with an append-only store.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { BreakerOpenError, CircuitBreaker, type PlaneGate, type PlaneSample } from "@substrate/observability";
import { normalizeEvent } from "./event.ts";
import {
	AppendOnlyViolation,
	assertAppendOnly,
	chainTip,
	COVERAGE_MAX_UNCOVERED,
	DEFAULT_QUERY_LIMIT,
	epochMsAnyUnit,
	EVENT_COLUMNS,
	EXPORT_INGEST_SKEW_MS,
	GreptimeClient,
	GreptimeBreakerOpen,
	METRIC_SAMPLES_TABLE,
	MetricHistoryInputError,
	GreptimeError,
	GreptimeUnavailable,
	HEALTH_TABLE,
	INGEST_LAG_MS,
	INGEST_BUDGET_MS,
	INGEST_RETRY_LOOKBACK_MS,
	IngestNotRecorded,
	MAX_QUERY_LIMIT,
	queryLimit,
	quote,
	sqlOp,
	ttlOf,
} from "./greptime.ts";
import { ConfigError, loadConfig, loadLedgerSettings, type GreptimeConfig } from "./config.ts";
import type { EventInput } from "./types.ts";
import { MAX_METRIC_BATCH, MAX_METRIC_POINTS, METRIC_SERIES, type MetricSampleRow } from "./metrics-history.ts";

const config: GreptimeConfig = { url: "http://greptime.test", user: "u", password: "p", db: "substrate" };

const input: EventInput = {
	surface: "claude-code",
	kind: "file.edit",
	summary: "edited gateway/ws.rs",
	session_id: "sess-1",
	graph_id: "ut-mz3k1q-8a1f2c3d",
	repo: "swcstudiospace/autonogrammer",
};

/** A Greptime `records` payload for the given columns and rows. */
function records(columns: string[], rows: unknown[][]) {
	return { output: [{ records: { schema: { column_schemas: columns.map((name) => ({ name })) }, rows } }] };
}

const affected = { output: [{ affectedrows: 1 }] };

/**
 * The default reply: an escaping dialect, plus `affectedrows` for everything
 * else. `insertEvent` probes the dialect before it writes, so a stub that cannot
 * answer the probe makes it refuse any event carrying a backslash.
 */
function defaultReply(statement: string): unknown {
	if (statement.includes("LENGTH")) return records(["n"], [[3]]);
	// insertEvent and hourLeaves ask the live table before they record or read.
	// A stub that cannot answer would look like "not confirmed" and refuse the hour.
	if (statement.includes('SHOW CREATE TABLE "event_ingest"')) {
		return records(["Table", "Create Table"], [["event_ingest", "... WITH( append_mode = 'true' )"]]);
	}
	// ensureMetricSamples asks the live table for append_mode before it is ready.
	if (statement.includes('SHOW CREATE TABLE "metric_samples"')) {
		return records(["Table", "Create Table"], [["metric_samples", "... WITH( append_mode = 'true', ttl = '14d' )"]]);
	}
	return affected;
}

/** The INSERT among the recorded statements — the probe may precede it. */
function insertStatement(sql: string[]): string {
	return sql.find((statement) => statement.startsWith("INSERT INTO")) ?? "";
}

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

/** Replace `fetch`, recording each statement and replying from `responder`. */
function stubFetch(responder: (sql: string) => unknown = defaultReply): { sql: string[] } {
	const sql: string[] = [];
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		const statement = new URLSearchParams(String(init.body)).get("sql") ?? "";
		sql.push(statement);
		const reply = responder(statement);
		if (reply instanceof Response) return reply;
		return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return { sql };
}

describe("quote", () => {
	test("renders null and non-finite numbers as NULL", () => {
		expect(quote(null)).toBe("NULL");
		expect(quote(Number.NaN)).toBe("NULL");
		expect(quote(Number.POSITIVE_INFINITY)).toBe("NULL");
		expect(quote(7)).toBe("7");
	});

	test("doubles a single quote", () => {
		expect(quote("it's")).toBe("'it''s'");
	});

	test("a trailing backslash cannot close the literal", () => {
		// Under MySQL-style rules `'x\'` escapes its own closing quote and the
		// literal runs on into whatever follows — which, for an event summary, is
		// agent-supplied text. Doubling the backslash is what stops that.
		expect(quote("x\\")).toBe("'x\\\\'");
	});

	test("leaves a backslash alone where the server does not treat it as an escape", () => {
		expect(quote("C:\\new", false)).toBe("'C:\\new'");
		expect(quote("C:\\new", true)).toBe("'C:\\\\new'");
	});
});

describe("assertAppendOnly", () => {
	test("allows the verbs the ledger needs", () => {
		for (const statement of [
			'SELECT "hash" FROM "agent_events"',
			'INSERT INTO "agent_events" ("id") VALUES (\'x\')',
			'CREATE TABLE IF NOT EXISTS "agent_events" ("ts" TIMESTAMP TIME INDEX)',
			'SHOW CREATE TABLE "agent_events"',
		]) {
			expect(() => assertAppendOnly(statement)).not.toThrow();
		}
	});

	test("refuses anything that could rewrite or remove a stored row", () => {
		for (const statement of [
			'UPDATE "agent_events" SET "summary" = \'x\'',
			'DELETE FROM "agent_events"',
			'DROP TABLE "agent_events"',
			'TRUNCATE TABLE "agent_events"',
			'ALTER TABLE "agent_events" DROP COLUMN "hash"',
			"",
		]) {
			expect(() => assertAppendOnly(statement)).toThrow(AppendOnlyViolation);
		}
	});

	test("is not fooled by case, leading whitespace or a leading comment", () => {
		expect(() => assertAppendOnly('  delete from "agent_events"')).toThrow(AppendOnlyViolation);
		expect(() => assertAppendOnly('/* migrate */ DELETE FROM "agent_events"')).toThrow(AppendOnlyViolation);
		expect(() => assertAppendOnly('-- note\nDELETE FROM "agent_events"')).toThrow(AppendOnlyViolation);
	});

	test("refuses a second statement smuggled past the verb check", () => {
		// Greptime's HTTP API accepts `;`-separated batches, so checking only the
		// first verb would leave the ledger writable.
		expect(() => assertAppendOnly('SELECT 1; DELETE FROM "agent_events"')).toThrow(AppendOnlyViolation);
		expect(() =>
			assertAppendOnly('INSERT INTO "agent_events" ("id") VALUES (\'x\'); DROP TABLE "agent_events"'),
		).toThrow(AppendOnlyViolation);
	});

	test("tolerates a trailing semicolon", () => {
		expect(() => assertAppendOnly('SELECT 1 FROM "agent_events";  ')).not.toThrow();
	});

	test("does not trip over a summary containing SQL punctuation", () => {
		// The regression this guards: an event whose text holds `;` or `--` is
		// ordinary, and rejecting it would drop a real event off the trail.
		const statement = `INSERT INTO "agent_events" ("summary") VALUES ('ran a; then b -- twice')`;
		expect(() => assertAppendOnly(statement)).not.toThrow();
		expect(() => assertAppendOnly(`SELECT 1 FROM "t" WHERE "x" = 'it''s; fine'`)).not.toThrow();
	});
});

describe("insertEvent", () => {
	test("sends one INSERT naming every stored column in order", async () => {
		const { sql } = stubFetch();
		const event = normalizeEvent(input, null);
		await new GreptimeClient(config).insertEvent(event);

		const statement = insertStatement(sql);
		expect(statement).toContain(EVENT_COLUMNS.map((column) => `"${column}"`).join(", "));
		expect(statement).toContain(`'${event.hash}'`);
		expect(statement).toContain("NULL"); // node_id and prev are absent here
	});

	test("escapes a summary that would otherwise break out of its literal", async () => {
		const { sql } = stubFetch();
		const event = normalizeEvent({ ...input, summary: "wrote C:\\new', 'x" }, null);
		await new GreptimeClient(config).insertEvent(event);

		// One literal, closed exactly once: the backslash is doubled and the quote
		// is doubled, so nothing in the summary is parsed as SQL.
		expect(insertStatement(sql)).toContain("'wrote C:\\\\new'', ''x'");
	});

	test("refuses a backslash before the quoting dialect is known", async () => {
		// The write would store text that differs from the text the hash covers, and
		// an append-only table cannot be corrected: that row would fail verification
		// for as long as it exists. One lost event is the cheaper failure.
		const { sql } = stubFetch((statement) =>
			statement.includes("LENGTH") ? new Response("nope", { status: 500 }) : affected,
		);
		const event = normalizeEvent({ ...input, summary: "wrote C:\\new" }, null);

		await expect(new GreptimeClient(config).insertEvent(event)).rejects.toThrow(/quoting dialect/);
		expect(insertStatement(sql)).toBe("");
	});

	test("still appends an event with no backslash when the probe fails", async () => {
		// Refusing is scoped to text the dialect actually affects; everything else is
		// quoted identically either way.
		const { sql } = stubFetch((statement) =>
			statement.includes("LENGTH") ? new Response("nope", { status: 500 }) : affected,
		);
		await new GreptimeClient(config).insertEvent(normalizeEvent(input, null));
		expect(insertStatement(sql)).toContain('INSERT INTO "agent_events"');
	});

	test("counts a backslash that only the payload's JSON encoding introduces", async () => {
		// A newline in the payload reaches the column as a two-character `\n`, whose
		// round-trip depends on the same dialect a literal backslash does.
		const { sql } = stubFetch((statement) =>
			statement.includes("LENGTH") ? new Response("nope", { status: 500 }) : affected,
		);
		const event = normalizeEvent({ ...input, payload: { out: "line one\nline two" } }, null);

		await expect(new GreptimeClient(config).insertEvent(event)).rejects.toThrow(/quoting dialect/);
		expect(insertStatement(sql)).toBe("");
	});
});

describe("sql", () => {
	test("maps rows onto their column names", async () => {
		stubFetch(() => records(["hash", "ts"], [["abc", 1790186361859]]));
		const rows = await new GreptimeClient(config).sql('SELECT "hash", "ts" FROM "agent_events"');
		expect(rows).toEqual([{ hash: "abc", ts: 1790186361859 }]);
	});

	test("returns no rows when the response carries none", async () => {
		stubFetch(() => affected);
		expect(await new GreptimeClient(config).sql("SELECT 1")).toEqual([]);
	});

	test("refuses a mutating statement before it reaches the network", async () => {
		const { sql } = stubFetch();
		await expect(new GreptimeClient(config).sql('DELETE FROM "agent_events"')).rejects.toThrow(AppendOnlyViolation);
		expect(sql).toHaveLength(0);
	});

	test("reports an HTTP failure, a JSON error body and unparseable output", async () => {
		const client = new GreptimeClient(config);

		// Each transport failure mode rejects as the typed error the caller
		// handles — never a bare SyntaxError, an empty row set, or silence.
		stubFetch(() => new Response("nope", { status: 500 }));
		await expect(client.sql("SELECT 1")).rejects.toThrow(GreptimeError);

		stubFetch(() => ({ error: "table not found" }));
		await expect(client.sql("SELECT 1")).rejects.toThrow(GreptimeError);

		stubFetch(() => new Response("<html>", { status: 200 }));
		await expect(client.sql("SELECT 1")).rejects.toThrow(GreptimeError);
	});

	test("turns an unreachable host into a GreptimeError the caller can handle", async () => {
		globalThis.fetch = (() => Promise.reject(new Error("connect ETIMEDOUT"))) as unknown as typeof fetch;
		await expect(new GreptimeClient(config).sql("SELECT 1")).rejects.toThrow(GreptimeError);
	});

	test("a 5xx or an unreachable host is GreptimeUnavailable; a SQL error is not", async () => {
		// The distinction the breaker rests on: only the first two are the store's fault.
		stubFetch(() => new Response("nope", { status: 503 }));
		await expect(new GreptimeClient(config).sql("SELECT 1")).rejects.toBeInstanceOf(GreptimeUnavailable);
		globalThis.fetch = (() => Promise.reject(new Error("connect ETIMEDOUT"))) as unknown as typeof fetch;
		await expect(new GreptimeClient(config).sql("SELECT 1")).rejects.toBeInstanceOf(GreptimeUnavailable);
		stubFetch(() => ({ error: "table not found" }));
		const sqlError = new GreptimeClient(config).sql("SELECT 1");
		await expect(sqlError).rejects.toBeInstanceOf(GreptimeError);
		await expect(sqlError).rejects.not.toBeInstanceOf(GreptimeUnavailable);
	});

	test("sqlOp is the statement's verb, never the statement", () => {
		expect(sqlOp('SELECT "hash" FROM "agent_events"')).toBe("select");
		expect(sqlOp("  insert into x values (1)")).toBe("insert");
		expect(sqlOp('SHOW CREATE TABLE "agent_events"')).toBe("show");
		expect(sqlOp("CREATE TABLE IF NOT EXISTS x")).toBe("create");
		expect(sqlOp("DESCRIBE x")).toBe("other");
	});
});

describe("the ledger's plane gate", () => {
	function gate(now: () => number, failureThreshold = 5): { gate: PlaneGate; samples: PlaneSample[] } {
		const samples: PlaneSample[] = [];
		return {
			gate: { plane: "greptime", breaker: new CircuitBreaker("greptime", { failureThreshold, openMs: 30_000 }, now), observe: (s) => samples.push(s) },
			samples,
		};
	}

	test("opens after five consecutive failures and then fails fast without touching the network", async () => {
		let now = 1_000_000;
		const { gate: g, samples } = gate(() => now);
		const client = new GreptimeClient(config, { gate: g });
		let fetches = 0;
		globalThis.fetch = (() => {
			fetches += 1;
			return Promise.reject(new Error("connect ETIMEDOUT"));
		}) as unknown as typeof fetch;

		for (let i = 0; i < 5; i++) await expect(client.sql("SELECT 1")).rejects.toThrow(/unreachable/);
		expect(fetches).toBe(5);
		expect(g.breaker?.state()).toBe("open");

		const started = performance.now();
		const refused = client.sql("SELECT 1");
		await expect(refused).rejects.toBeInstanceOf(GreptimeUnavailable);
		await expect(refused).rejects.toThrow(/circuit open/);
		expect(performance.now() - started).toBeLessThan(5);
		expect(fetches).toBe(5);
		expect(await client.ping()).toBe(false);
		expect(samples.map((s) => s.outcome)).toEqual(["error", "error", "error", "error", "error", "open", "open"]);
		expect(samples.at(-1)?.op).toBe("ping");

		// Thirty seconds later one probe goes out; it succeeds and the breaker closes.
		now += 30_000;
		stubFetch(() => records(["n"], [[1]]));
		expect(await client.ping()).toBe(true);
		expect(g.breaker?.state()).toBe("closed");
	});

	test("a 5xx charges the breaker; a SQL error does not", async () => {
		const { gate: g, samples } = gate(() => 0, 2);
		const client = new GreptimeClient(config, { gate: g });
		stubFetch(() => ({ error: "table not found" }));
		await expect(client.sql("SELECT 1")).rejects.toThrow(/table not found/);
		expect(g.breaker?.snapshot().failures).toBe(0);
		stubFetch(() => new Response("bad gateway", { status: 502 }));
		await expect(client.sql("SELECT 1")).rejects.toThrow(/greptime 502/);
		await expect(client.sql("SELECT 1")).rejects.toThrow(/greptime 502/);
		expect(g.breaker?.state()).toBe("open");
		await expect(client.sql("SELECT 1")).rejects.toBeInstanceOf(GreptimeUnavailable);
		expect(samples.map((s) => `${s.op}:${s.outcome}`)).toEqual(["select:ok", "select:error", "select:error", "select:open"]);
		expect(samples[1]?.reason).toContain("greptime 502");
	});

	test("without a gate, or with breakers disabled, every call still reaches the network", async () => {
		let fetches = 0;
		globalThis.fetch = (() => {
			fetches += 1;
			return Promise.reject(new Error("connect ETIMEDOUT"));
		}) as unknown as typeof fetch;
		const bare = new GreptimeClient(config);
		const off = new GreptimeClient(config, { gate: { plane: "greptime", breaker: null, observe: null } });
		for (let i = 0; i < 7; i++) {
			await expect(bare.sql("SELECT 1")).rejects.toThrow(/unreachable/);
			await expect(off.sql("SELECT 1")).rejects.toThrow(/unreachable/);
		}
		expect(fetches).toBe(14);
		expect(BreakerOpenError.name).toBe("BreakerOpenError");
	});
});

describe("the ledger client, continued", () => {
	test("sends the database as a query parameter and basic auth as a header", async () => {
		let seenUrl = "";
		let seenAuth: string | undefined;
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			seenUrl = String(url);
			seenAuth = (init.headers as Record<string, string>).authorization;
			return new Response(JSON.stringify(affected), { status: 200 });
		}) as unknown as typeof fetch;

		await new GreptimeClient(config).sql("SELECT 1");
		expect(seenUrl).toBe("http://greptime.test/v1/sql?db=substrate");
		// The credential travels in the header, never in the URL, so it stays out
		// of any log that records the request line.
		expect(seenAuth).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
	});
});

describe("probeDialect", () => {
	test("asks the server once and caches the answer", async () => {
		const { sql } = stubFetch(() => records(["n"], [[4]]));
		const client = new GreptimeClient(config);

		expect(await client.probeDialect()).toBe(false);
		expect(await client.probeDialect()).toBe(false);
		expect(sql).toHaveLength(1);
		expect(sql[0]).toContain("LENGTH('a\\\\b')");
	});

	test("a server that escapes backslashes is detected as such", async () => {
		stubFetch(() => records(["n"], [[3]]));
		expect(await new GreptimeClient(config).probeDialect()).toBe(true);
	});

	test("keeps the safe assumption when the server will not answer", async () => {
		// An unanswered probe must not silently switch to the dialect whose failure
		// mode is an injection.
		stubFetch(() => new Response("nope", { status: 500 }));
		expect(await new GreptimeClient(config).probeDialect()).toBe(true);
	});

	test("a non-escaping server stores a backslash verbatim", async () => {
		const { sql } = stubFetch((statement) => (statement.includes("LENGTH") ? records(["n"], [[4]]) : affected));
		const client = new GreptimeClient(config);
		await client.probeDialect();
		await client.insertEvent(normalizeEvent({ ...input, summary: "C:\\new" }, null));
		expect(insertStatement(sql)).toContain("'C:\\new'");
	});
});

describe("migrate", () => {
	test.each([
		["unquoted, as Greptime prints it", "... WITH( append_mode = 'true' )"],
		["quoted, as the DDL we send writes it", "... WITH ('append_mode' = 'true')"],
	])("recognises append_mode %s", async (_label, ddl) => {
		stubFetch((statement) => {
			if (statement.includes("SHOW CREATE TABLE")) return records(["Create Table"], [[ddl]]);
			return affected;
		});
		expect(await new GreptimeClient(config).appendModeEnabled()).toBe(true);
	});

	test("creates agent_events in append_mode and reports nothing when it holds", async () => {
		const { sql } = stubFetch((statement) => {
			if (statement.includes("SHOW CREATE TABLE")) {
				return records(["Table", "Create Table"], [["agent_events", "... WITH( append_mode = 'true' )"]]);
			}
			if (statement.includes("LENGTH")) return records(["n"], [[3]]);
			return affected;
		});

		const { warnings } = await new GreptimeClient(config).migrate();
		expect(warnings).toEqual([]);
		expect(sql[0]).toContain("append_mode");
		expect(sql[0]).toContain('CREATE TABLE IF NOT EXISTS "agent_events"');
		expect(sql.some((statement) => statement.includes('"anchors"'))).toBe(true);
	});

	test("warns when the live table predates append_mode", async () => {
		// `CREATE TABLE IF NOT EXISTS` is a no-op against the table already on
		// Railway, so the only way to learn this is to ask.
		stubFetch((statement) => {
			if (statement.includes("SHOW CREATE TABLE")) {
				return records(["Create Table"], [['CREATE TABLE "agent_events" (...) ENGINE=mito']]);
			}
			return defaultReply(statement);
		});

		const { warnings } = await new GreptimeClient(config).migrate();
		expect(warnings).toHaveLength(2);
		expect(warnings.some((warning) => warning.includes("agent_events"))).toBe(true);
		expect(warnings.some((warning) => warning.includes("event_ingest"))).toBe(true);
	});

	test("warns rather than throwing when append_mode cannot be confirmed", async () => {
		stubFetch((statement) =>
			statement.includes("SHOW CREATE TABLE") ? new Response("nope", { status: 500 }) : defaultReply(statement),
		);
		const { warnings } = await new GreptimeClient(config).migrate();
		expect(warnings).toEqual([
			"could not confirm agent_events is in append_mode",
			"could not confirm event_ingest is in append_mode",
		]);
	});

	test("warns at boot when the quoting dialect could not be determined", async () => {
		// Visible from the start, because the ledger will refuse any event carrying a
		// backslash until the probe succeeds.
		stubFetch((statement) => {
			if (statement.includes("LENGTH")) return new Response("nope", { status: 500 });
			if (statement.includes("SHOW CREATE TABLE")) return records(["Create Table"], [["... append_mode = 'true'"]]);
			return affected;
		});

		const { warnings } = await new GreptimeClient(config).migrate();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("quoting dialect");
	});

	test("falls back to a plain CREATE when the server rejects the option", async () => {
		const { sql } = stubFetch((statement) => {
			if (statement.includes("append_mode") && statement.includes("CREATE")) {
				return { error: "unrecognized table option" };
			}
			if (statement.includes("SHOW CREATE TABLE")) return records(["Create Table"], [["CREATE TABLE ..."]]);
			return affected;
		});

		const { warnings } = await new GreptimeClient(config).migrate();
		expect(sql[1]).toContain('CREATE TABLE IF NOT EXISTS "agent_events"');
		expect(sql[1]).not.toContain("append_mode");
		// The fallback is reported loudly at boot rather than silent.
		expect(warnings.length).toBeGreaterThan(0);
	});
});

describe("ensureAppendMode", () => {
	test("caches an answer rather than asking on every append", async () => {
		const { sql } = stubFetch(() => records(["Create Table"], [["... append_mode = 'true'"]]));
		const client = new GreptimeClient(config);

		expect(await client.ensureAppendMode()).toBe(true);
		expect(await client.ensureAppendMode()).toBe(true);
		expect(sql).toHaveLength(1);
	});

	test("re-asks once a definite answer goes stale, so an out-of-band recreate is seen", async () => {
		// The trap this closes: the documented fix recreates the table *outside* this
		// process, so a permanently cached `false` would leave every append refused and
		// /healthz red until someone restarted the service — the operator would do the
		// documented fix and see nothing change.
		let ddl = "CREATE TABLE ... ENGINE=mito";
		stubFetch(() => records(["Create Table"], [[ddl]]));
		const client = new GreptimeClient(config);

		expect(await client.ensureAppendMode(0)).toBe(false);
		ddl = "... WITH( append_mode = 'true' )";
		expect(await client.ensureAppendMode(1_000)).toBe(false); // still inside the TTL
		expect(await client.ensureAppendMode(60_000)).toBe(true); // past it
	});

	test("notices a table swapped back to a deduplicating one", async () => {
		let ddl = "... WITH( append_mode = 'true' )";
		stubFetch(() => records(["Create Table"], [[ddl]]));
		const client = new GreptimeClient(config);

		expect(await client.ensureAppendMode(0)).toBe(true);
		ddl = "CREATE TABLE ... ENGINE=mito";
		expect(await client.ensureAppendMode(60_000)).toBe(false);
	});

	test("keeps the last definite answer when a re-check fails", async () => {
		// A blip should not widen the refusal; the next call retries because the
		// checked-at stamp did not move.
		let fail = false;
		stubFetch(() =>
			fail ? new Response("nope", { status: 500 }) : records(["Create Table"], [["... append_mode = 'true'"]]),
		);
		const client = new GreptimeClient(config);

		expect(await client.ensureAppendMode(0)).toBe(true);
		fail = true;
		expect(await client.ensureAppendMode(60_000)).toBe(true);
		fail = false;
		expect(await client.ensureAppendMode(60_001)).toBe(true);
	});

	test("asks again while the answer is still unknown", async () => {
		// Without this retry, one transient SHOW CREATE TABLE failure would leave a
		// fail-closed write path refusing every event for the life of the process.
		let attempt = 0;
		stubFetch(() => {
			attempt++;
			return attempt === 1
				? new Response("nope", { status: 500 })
				: records(["Create Table"], [["... append_mode = 'true'"]]);
		});
		const client = new GreptimeClient(config);

		expect(await client.ensureAppendMode()).toBeNull();
		expect(await client.ensureAppendMode()).toBe(true);
	});

	test("does not re-ask once the answer is a definite no", async () => {
		const { sql } = stubFetch(() => records(["Create Table"], [["CREATE TABLE ... ENGINE=mito"]]));
		const client = new GreptimeClient(config);

		expect(await client.ensureAppendMode()).toBe(false);
		expect(await client.ensureAppendMode()).toBe(false);
		expect(sql).toHaveLength(1);
	});
});

describe("reads", () => {
	test("lastHash takes the newest event in the session", async () => {
		const { sql } = stubFetch(() => records(["hash", "prev"], [["abc", "xyz"]]));
		expect(await new GreptimeClient(config).lastHash("sess-1")).toBe("abc");
		expect(sql[0]).toContain(`"session_id" = 'sess-1'`);
		expect(sql[0]).toContain('ORDER BY "ts" DESC');
	});

	test("lastHash reads a row window far above any real session, bounded in time and then unbounded", async () => {
		// The regression: `ts` is collector-supplied, and the Grok collector's backfill
		// pass appends events *older* than everything stored. A small window ordered by
		// `ts` would not hold the real chain tip, and the next append would chain onto a
		// hash that already had a successor — forking the session. The row limit is a
		// memory guard only; the time bound (uplift-2 R5) falls back to the whole
		// session when it sees nothing. See ledger-chain.test.ts for the bound itself.
		const { sql } = stubFetch(() => records(["hash", "prev"], []));
		await new GreptimeClient(config).lastHash("sess-1");

		expect(sql).toHaveLength(2);
		for (const statement of sql) {
			const limit = Number(statement.match(/LIMIT (\d+)/)?.[1]);
			expect(limit).toBeGreaterThanOrEqual(10_000);
		}
		expect(sql[0]).toContain('"ts" >=');
		expect(sql[1]).not.toContain('"ts" >=');
	});

	test("lastHash finds a tip whose timestamp is older than the rest", async () => {
		// A backfilled event sorts last by `ts` but is the real tip: nothing claims it.
		stubFetch(() =>
			records(
				["hash", "prev"],
				[
					["recent-b", "recent-a"],
					["recent-a", null],
					["backfilled", "recent-b"],
				],
			),
		);
		expect(await new GreptimeClient(config).lastHash("sess-1")).toBe("backfilled");
	});

	test("lastHash is null for a session with no events", async () => {
		stubFetch(() => records(["hash", "prev"], []));
		expect(await new GreptimeClient(config).lastHash("sess-new")).toBeNull();
	});

	test("lastHash follows the chain when two events share a millisecond", async () => {
		// The regression: with append_mode both rows survive, and `ORDER BY "ts" DESC`
		// alone cannot say which came second — Greptime may return either first. Here
		// it returns the older one first, and taking row 0 would chain onto a hash
		// that already has a successor, forking the chain.
		stubFetch(() =>
			records(
				["hash", "prev"],
				[
					["first", "older"],
					["second", "first"],
				],
			),
		);
		expect(await new GreptimeClient(config).lastHash("sess-1")).toBe("second");
	});
});

describe("chainTip", () => {
	test("is the hash nothing else claims as its prev", () => {
		expect(
			chainTip([
				{ hash: "b", prev: "a" },
				{ hash: "c", prev: "b" },
				{ hash: "a", prev: null },
			]),
		).toBe("c");
	});

	test("is null when there are no rows", () => {
		expect(chainTip([])).toBeNull();
	});

	test("falls back to the newest row when every hash is claimed", () => {
		// A cycle, or a window that happens to hold only claimed hashes. Rows arrive
		// newest first, so row 0 is the best available answer.
		expect(
			chainTip([
				{ hash: "a", prev: "b" },
				{ hash: "b", prev: "a" },
			]),
		).toBe("a");
	});

	test("ignores a row with no usable hash", () => {
		expect(chainTip([{ hash: null, prev: null }, { hash: "a", prev: null }])).toBe("a");
	});

	test("a window of the newest rows by ts is what forked the chain", () => {
		// The concrete regression. Three events arrive live, then the Grok collector's
		// backfill pass appends one carrying an older source timestamp — so it is the
		// real chain tip but sorts last by `ts`.
		const session = [
			// newest by ts first, as the query returns them
			{ hash: "recent-c", prev: "recent-b" },
			{ hash: "recent-b", prev: "recent-a" },
			{ hash: "recent-a", prev: null },
			{ hash: "backfilled", prev: "recent-c" },
		];

		// Windowed to the newest three, the backfilled tip is invisible and `recent-c`
		// looks unclaimed — so the next append would chain onto it, forking the session,
		// because `backfilled` already claims it.
		expect(chainTip(session.slice(0, 3))).toBe("recent-c");

		// Reading the whole session finds the actual tip.
		expect(chainTip(session)).toBe("backfilled");
	});

	test("readEvents selects every column the chain was hashed over", async () => {
		const { sql } = stubFetch(() => records(["id"], []));
		await new GreptimeClient(config).readEvents("graph_id", "ut-1");
		for (const column of EVENT_COLUMNS) expect(sql[0]).toContain(`"${column}"`);
		expect(sql[0]).toContain('ORDER BY "ts"');
	});

	test("ping reports reachability without throwing", async () => {
		stubFetch(() => affected);
		expect(await new GreptimeClient(config).ping()).toBe(true);

		globalThis.fetch = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
		expect(await new GreptimeClient(config).ping()).toBe(false);
	});
});

describe("eventIdsAfter", () => {
	/** Any fixed epoch; every fixture record lands in or after this millisecond. */
	const T0 = Date.UTC(2026, 9, 1);

	/** One `event_ingest` record: the event id and the time a record for it landed. */
	interface FixtureRecord {
		id: string;
		at: number;
	}

	/**
	 * Answer `eventIdsAfter` from `table` by evaluating exactly the query the
	 * statement must carry: rows inside the cursor's window, an event only when
	 * no record of it sits at or before the full (ingested_at, event_id)
	 * cursor, ordered, then limited. A statement that rescans history before
	 * the cursor filter, pages before cutting, or drops the anti-join fails
	 * the test instead of quietly handing back wrong positions.
	 */
	function stubIngestStore(table: FixtureRecord[]): { sql: string[] } {
		return stubFetch((statement) => {
			const window = /i\."ingested_at" >= '([^']+)'/.exec(statement);
			const before = /p\."ingested_at" < '([^']+)'/.exec(statement);
			const boundary = /p\."ingested_at" = '([^']+)' AND p\."event_id" <= '([^']*)'/.exec(statement);
			const capped = /LIMIT (\d+)\s*$/.exec(statement);
			if (!window || !before || !boundary || !capped || window[1] !== before[1] || window[1] !== boundary[1]) {
				throw new Error(`statement is not the earliest-records-after-cursor query: ${statement}`);
			}
			if (!statement.includes("NOT EXISTS")) {
				throw new Error(`statement lacks the per-event pre-cursor anti-join: ${statement}`);
			}
			if (statement.indexOf("LIMIT") < statement.indexOf("WHERE")) {
				throw new Error(`statement applies its limit before the cursor boundary: ${statement}`);
			}
			const windowMs = Date.parse(window[1]!);
			if (!Number.isFinite(windowMs)) throw new Error(`cursor bound is not a timestamp: ${window[1]}`);
			// An event with any record at or before the full cursor is already
			// delivered — its window rows (including retries) are all excluded,
			// which is what keeps a retry from re-delivering its event.
			const excluded = new Set<string>();
			for (const record of table) {
				if (record.at < windowMs || (record.at === windowMs && record.id <= (boundary[2] ?? ""))) excluded.add(record.id);
			}
			const positions = table
				.filter((record) => record.at >= windowMs && !excluded.has(record.id))
				.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
				.slice(0, Number(capped[1]));
			return records(
				["event_id", "ingested_at"],
				positions.map((record) => [record.id, record.at]),
			);
		});
	}

	test("a retried ingest record never re-delivers its event across polls", async () => {
		const client = new GreptimeClient(config);
		stubIngestStore([
			{ id: "evt_1", at: T0 },
			{ id: "evt_1", at: T0 + 5000 }, // the retry, stamped later than the first record
			{ id: "evt_2", at: T0 + 10 },
		]);

		const first = await client.eventIdsAfter({ id: "", ingestedAt: 0 }, 50);
		expect(first).toEqual([
			{ id: "evt_1", ingestedAt: T0 },
			{ id: "evt_2", ingestedAt: T0 + 10 },
		]);

		// The second poll's cursor is past the first record, so a window that
		// merely sat at `>= cursor` would hold only the retry for evt_1 and hand
		// the stream the same event twice. Only the earliest record counts.
		const second = await client.eventIdsAfter({ id: "evt_1", ingestedAt: T0 }, 50);
		expect(second).toEqual([{ id: "evt_2", ingestedAt: T0 + 10 }]);
	});

	test("more same-millisecond records than a page still advance the stream", async () => {
		const client = new GreptimeClient(config);
		stubIngestStore(Array.from({ length: 501 }, (_, i) => ({ id: `evt_${String(i).padStart(3, "0")}`, at: T0 })));

		// A limit applied before this boundary would re-read the same first rows
		// on every poll and freeze at evt_350 forever; the statement cuts first,
		// so the next page is exactly the hundred records after the cursor.
		const page = await client.eventIdsAfter({ id: "evt_350", ingestedAt: T0 }, 100);
		expect(page.map((position) => position.id)).toEqual(Array.from({ length: 100 }, (_, i) => `evt_${String(351 + i).padStart(3, "0")}`));
	});

	test("the statement stays inside the cursor window, carries the full cursor in its anti-join, and limits last", async () => {
		const { sql } = stubIngestStore([]);
		await new GreptimeClient(config).eventIdsAfter({ id: "evt_9", ingestedAt: T0 }, 7);

		const statement = sql[0] ?? "";
		const at = new Date(T0).toISOString();
		// The window: only records at or after the cursor's millisecond are
		// considered — no poll rescans the whole history.
		expect(statement).toContain(`SELECT i."event_id", i."ingested_at", i."event_ts" FROM "event_ingest" i`);
		expect(statement).toContain(`i."ingested_at" >= '${at}'`);
		// The anti-join carries the full (ingested_at, event_id) cursor, so a
		// retry record for an event whose first record the cursor already passed
		// is excluded with its original.
		expect(statement).toContain("NOT EXISTS");
		expect(statement).toContain(`p."ingested_at" < '${at}' OR (p."ingested_at" = '${at}' AND p."event_id" <= 'evt_9')`);
		expect(statement).toContain('ORDER BY i."ingested_at" ASC, i."event_id" ASC');
		expect(statement.indexOf("LIMIT")).toBeGreaterThan(statement.indexOf("WHERE"));
		expect(statement.trim().endsWith("LIMIT 7")).toBe(true);
	});

	test("a record whose time is not a number is named, not skipped", async () => {
		globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			const statement = new URLSearchParams(String(init?.body)).get("sql") ?? "";
			const window = /i\."ingested_at" >= '([^']+)'/.exec(statement);
			const before = /p\."ingested_at" < '([^']+)'/.exec(statement);
			const boundary = /p\."ingested_at" = '([^']+)' AND p\."event_id" <= '([^']*)'/.exec(statement);
			const capped = /LIMIT (\d+)\s*$/.exec(statement);
			const rows = window && before && boundary && capped ? [["evt_bad", null]] : [];
			return new Response(JSON.stringify(records(["event_id", "ingested_at"], rows)), { status: 200 });
		}) as unknown as typeof fetch;
		await expect(new GreptimeClient(config).eventIdsAfter({ id: "", ingestedAt: 0 }, 5)).rejects.toThrow("evt_bad");
	});
});

describe("queryEvents", () => {
	/** The read among the recorded statements — the dialect probe precedes it. */
	function selectStatement(sql: string[]): string {
		return sql.find((statement) => statement.startsWith("SELECT") && statement.includes("agent_events")) ?? "";
	}

	test("selects every column but the payload, newest first, under the default limit", async () => {
		const { sql } = stubFetch();
		await new GreptimeClient(config).queryEvents();

		const statement = selectStatement(sql);
		for (const column of EVENT_COLUMNS) {
			if (column === "payload") continue;
			expect(statement).toContain(`"${column}"`);
		}
		// Omitted because it is the one unbounded column: 16 KB an event, times the limit.
		expect(statement).not.toContain('"payload"');
		expect(statement).toContain('ORDER BY "ts" DESC, "id" DESC');
		expect(statement).toContain(`LIMIT ${DEFAULT_QUERY_LIMIT}`);
		// No filters means no WHERE at all, rather than a `WHERE 1=1` the server has to parse.
		expect(statement).not.toContain("WHERE");
	});

	test("includes the payload only when asked", async () => {
		const { sql } = stubFetch();
		await new GreptimeClient(config).queryEvents({ includePayload: true });
		expect(selectStatement(sql)).toContain('"payload"');
	});

	test("ANDs one equality clause per filter, and nothing for an absent one", async () => {
		const { sql } = stubFetch();
		await new GreptimeClient(config).queryEvents({
			match: { repo: "swcstudiospace/autonogrammer", surface: "omp", kind: undefined, graph_id: null },
			order: "asc",
			limit: 7,
		});

		const statement = selectStatement(sql);
		expect(statement).toContain(`WHERE "repo" = 'swcstudiospace/autonogrammer' AND "surface" = 'omp'`);
		expect(statement).not.toContain('"kind"  =');
		expect(statement).not.toContain('"graph_id" =');
		expect(statement).toContain('ORDER BY "ts" ASC, "id" ASC');
		expect(statement).toContain("LIMIT 7");
	});

	test("bounds ts inclusively at both ends", async () => {
		const { sql } = stubFetch();
		await new GreptimeClient(config).queryEvents({
			since: "2026-09-30T00:00:00.000Z",
			until: "2026-09-30T12:00:00.000Z",
		});

		expect(selectStatement(sql)).toContain(
			`WHERE "ts" >= '2026-09-30T00:00:00.000Z' AND "ts" <= '2026-09-30T12:00:00.000Z'`,
		);
	});

	test("a filter value cannot close its literal or add a clause of its own", async () => {
		// The read path takes no SQL from a caller: column names come from
		// QUERYABLE_COLUMNS and values are quoted, so this is stored text to match,
		// not syntax. It matches nothing, which is the point.
		const { sql } = stubFetch();
		await new GreptimeClient(config).queryEvents({ match: { session_id: "x' OR 1=1; DROP TABLE agent_events --" } });

		const statement = selectStatement(sql);
		expect(statement).toContain(`"session_id" = 'x'' OR 1=1; DROP TABLE agent_events --'`);
		// And the guard on the way out still sees one SELECT, because it blanks literals first.
		expect(() => assertAppendOnly(statement)).not.toThrow();
	});

	test("no filter can name a column outside the queryable set", async () => {
		const { sql } = stubFetch();
		await new GreptimeClient(config).queryEvents({
			// A caller that got past the typed surface still cannot reach `payload`, `hash`
			// or a column of another table: the loop iterates the whitelist, not the input.
			match: { payload: "x", hash: "y", summary: "z" } as never,
		});

		expect(selectStatement(sql)).not.toContain("WHERE");
	});

	test("the limit is clamped to the cap and to a whole row", () => {
		expect(queryLimit(undefined)).toBe(DEFAULT_QUERY_LIMIT);
		expect(queryLimit(Number.NaN)).toBe(DEFAULT_QUERY_LIMIT);
		expect(queryLimit(MAX_QUERY_LIMIT + 1_000)).toBe(MAX_QUERY_LIMIT);
		expect(queryLimit(0)).toBe(1);
		expect(queryLimit(-5)).toBe(1);
		expect(queryLimit(12.9)).toBe(12);
	});

	test("maps rows onto the columns the server names", async () => {
		stubFetch((statement) =>
			statement.startsWith("SELECT LENGTH")
				? records(["n"], [[3]])
				: records(["ts", "id", "summary"], [[1790186361859, "evt_1", "edited ws.rs"]]),
		);

		const rows = await new GreptimeClient(config).queryEvents({ match: { repo: "r" } });
		expect(rows).toEqual([{ ts: 1790186361859, id: "evt_1", summary: "edited ws.rs" }]);
	});

	test("reads even while the quoting dialect is unknown", async () => {
		// Unlike an append, a read cannot corrupt anything: the worst a wrongly quoted
		// backslash does is match no rows. A ledger that cannot answer the probe must
		// still be readable.
		stubFetch((statement) =>
			statement.startsWith("SELECT LENGTH")
				? new Response("boom", { status: 500 })
				: records(["id"], [["evt_1"]]),
		);

		expect(await new GreptimeClient(config).queryEvents({ match: { branch: "feat\\x" } })).toEqual([
			{ id: "evt_1" },
		]);
	});
});

describe("migrate event_ingest and anchors", () => {
	test("creates event_ingest in append_mode with no primary key after agent_events", async () => {
		const { sql } = stubFetch((statement) => {
			if (statement.includes("SHOW CREATE TABLE")) {
				return records(["Table", "Create Table"], [["agent_events", "... WITH( append_mode = 'true' )"]]);
			}
			if (statement.includes("LENGTH")) return records(["n"], [[3]]);
			return affected;
		});
		const { warnings } = await new GreptimeClient(config).migrate();
		expect(warnings).toEqual([]);
		const agentIdx = sql.findIndex((s) => s.includes('CREATE TABLE IF NOT EXISTS "agent_events"'));
		const ingestIdx = sql.findIndex((s) => s.includes('CREATE TABLE IF NOT EXISTS "event_ingest"'));
		expect(agentIdx).toBeGreaterThanOrEqual(0);
		expect(ingestIdx).toBeGreaterThan(agentIdx);
		const ingest = sql[ingestIdx] ?? "";
		expect(ingest).toContain("append_mode");
		expect(ingest).not.toContain("PRIMARY KEY");
		expect(ingest).toContain('"ingested_at" TIMESTAMP TIME INDEX');
		expect(ingest).toContain('"event_id" STRING');
		expect(ingest).toContain('"event_ts" TIMESTAMP');
		expect(ingest).toContain('"graph_id" STRING');
	});

	test("warns without a plain-CREATE fallback when every append_mode CREATE fails", async () => {
		const { sql } = stubFetch((statement) => {
			if (statement.includes("append_mode") && statement.includes("CREATE")) {
				return { error: "unrecognized table option" };
			}
			if (statement.includes("SHOW CREATE TABLE")) return records(["Create Table"], [["CREATE TABLE ..."]]);
			return affected;
		});
		const { warnings } = await new GreptimeClient(config).migrate();
		expect(warnings.some((warning) => warning.includes("event_ingest"))).toBe(true);
		// Every event_ingest statement still asks for append_mode: nothing fell back
		// to the deduplicating form.
		expect(
			sql
				.filter((s) => s.includes('CREATE TABLE IF NOT EXISTS "event_ingest"'))
				.every((s) => s.includes("append_mode")),
		).toBe(true);
	});

	test("migration warnings never carry configured secrets", async () => {
		const secretConfig: GreptimeConfig = {
			url: "http://ledger-scratch.example:4000",
			user: "scratch-user-9f2",
			password: "scratch-pw-7h4k2m9q",
			db: "scratchdb",
		};
		const leak = `password=${secretConfig.password} user ${secretConfig.user} at ${secretConfig.url} db ${secretConfig.db}`;
		const { sql } = stubFetch((statement) => {
			if (statement.includes("append_mode") && statement.includes("CREATE")) {
				return new Response(leak, { status: 500 });
			}
			if (statement.includes("SHOW CREATE TABLE")) return records(["Create Table"], [["CREATE TABLE ..."]]);
			return affected;
		});
		const { warnings } = await new GreptimeClient(secretConfig).migrate();
		// The declared failure: every ingest CREATE still asks for append_mode
		// (no silent deduplicating fallback) and the failure is reported.
		const ingestCreates = sql.filter((s) => s.includes('CREATE TABLE IF NOT EXISTS "event_ingest"'));
		expect(ingestCreates.length).toBeGreaterThan(0);
		expect(ingestCreates.every((s) => s.includes("append_mode"))).toBe(true);
		expect(warnings.length).toBeGreaterThan(0);
		const text = warnings.join("\n");
		for (const secret of [secretConfig.url, secretConfig.user ?? "", secretConfig.password ?? "", secretConfig.db]) {
			expect(text).not.toContain(secret);
		}
		expect(text).toContain("[REDACTED]");
	});

	test("migration warnings never carry configured secrets, even single letters", async () => {
		const shortConfig: GreptimeConfig = { url: "http://x.test", user: "u", password: "p", db: "qy" };
		const leak = `password=${shortConfig.password} user ${shortConfig.user} at ${shortConfig.url} db ${shortConfig.db}`;
		const { sql } = stubFetch((statement) => {
			if (statement.includes("append_mode") && statement.includes("CREATE")) {
				return new Response(leak, { status: 500 });
			}
			if (statement.includes("SHOW CREATE TABLE")) return records(["Create Table"], [["CREATE TABLE ..."]]);
			return affected;
		});
		const { warnings } = await new GreptimeClient(shortConfig).migrate();
		// The declared failure: every ingest CREATE still asks for append_mode
		// (no silent deduplicating fallback) and the failure is reported.
		const ingestCreates = sql.filter((s) => s.includes('CREATE TABLE IF NOT EXISTS "event_ingest"'));
		expect(ingestCreates.length).toBeGreaterThan(0);
		expect(ingestCreates.every((s) => s.includes("append_mode"))).toBe(true);
		expect(warnings.length).toBeGreaterThan(0);
		const text = warnings.join("\n");
		// Single letters also occur in ordinary wording, so the boundary is
		// pinned on the secret-bearing spans the server echoed, not the
		// letters themselves: with the values filtered out, `leak` would
		// print verbatim.
		expect(text).not.toContain(leak);
		expect(text).not.toContain("http://x.test");
		expect(text).not.toContain("password=p");
		expect(text).toContain("[REDACTED]");
	});

	test("emits the canonical 11-column period-keyed anchors DDL", async () => {
		const { sql } = stubFetch((statement) => {
			if (statement.includes("SHOW CREATE TABLE")) {
				return records(["Table", "Create Table"], [["agent_events", "... WITH( append_mode = 'true' )"]]);
			}
			if (statement.includes("LENGTH")) return records(["n"], [[3]]);
			return affected;
		});
		await new GreptimeClient(config).migrate();
		const anchors = sql.find((s) => s.includes('CREATE TABLE IF NOT EXISTS "anchors"')) ?? "";
		for (const column of [
			"period_start",
			"period_end",
			"root",
			"event_count",
			"memo",
			"tx_sig",
			"signer",
			"cluster",
			"slot",
			"anchored_at",
			"stale_hashes",
		]) {
			expect(anchors).toContain(`"${column}"`);
		}
		expect(anchors).toContain("TIME INDEX");
		expect(anchors).not.toContain("PRIMARY KEY");
		expect(anchors).not.toContain("append_mode");
	});

	test("warns on the old 5-column root-keyed anchors shape", async () => {
		const { sql } = stubFetch((statement) => {
			if (statement.includes("information_schema")) {
				return records(
					["column_name", "data_type", "semantic_type"],
					[
						["period_start", "timestamp(3)", "TIMESTAMP"],
						["period_end", "timestamp(3)", "FIELD"],
						["root", "string", "TAG"],
						["tx_sig", "string", "FIELD"],
						["event_count", "bigint", "FIELD"],
					],
				);
			}
			if (statement.includes("SHOW CREATE TABLE")) {
				return records(["Table", "Create Table"], [["agent_events", "... WITH( append_mode = 'true' )"]]);
			}
			if (statement.includes("LENGTH")) return records(["n"], [[3]]);
			return affected;
		});
		const { warnings } = await new GreptimeClient(config).migrate();
		expect(sql.some((s) => s.includes("information_schema"))).toBe(true);
		expect(warnings.some((warning) => warning.includes("anchors"))).toBe(true);
	});

	test("warns on a type-only drift in one anchors column", async () => {
		stubFetch((statement) => {
			if (statement.includes("information_schema")) {
				return records(
					["column_name", "data_type", "semantic_type"],
					[
						["period_start", "timestamp(3)", "TIMESTAMP"],
						["period_end", "timestamp(3)", "FIELD"],
						["root", "string", "FIELD"],
						["event_count", "bigint", "FIELD"],
						["memo", "string", "FIELD"],
						["tx_sig", "string", "FIELD"],
						["signer", "string", "FIELD"],
						["cluster", "string", "FIELD"],
						["slot", "integer", "FIELD"],
						["anchored_at", "timestamp(3)", "FIELD"],
						["stale_hashes", "bigint", "FIELD"],
					],
				);
			}
			if (statement.includes("SHOW CREATE TABLE")) {
				return records(["Table", "Create Table"], [["agent_events", "... WITH( append_mode = 'true' )"]]);
			}
			if (statement.includes("LENGTH")) return records(["n"], [[3]]);
			return affected;
		});
		const { warnings } = await new GreptimeClient(config).migrate();
		expect(warnings.some((warning) => warning.includes("anchors"))).toBe(true);
	});

	test("warns on a semantic-type-only drift in one anchors column", async () => {
		stubFetch((statement) => {
			if (statement.includes("information_schema")) {
				return records(
					["column_name", "data_type", "semantic_type"],
					[
						["period_start", "timestamp(3)", "TIMESTAMP"],
						["period_end", "timestamp(3)", "FIELD"],
						["root", "string", "TAG"],
						["event_count", "bigint", "FIELD"],
						["memo", "string", "FIELD"],
						["tx_sig", "string", "FIELD"],
						["signer", "string", "FIELD"],
						["cluster", "string", "FIELD"],
						["slot", "bigint", "FIELD"],
						["anchored_at", "timestamp(3)", "FIELD"],
						["stale_hashes", "bigint", "FIELD"],
					],
				);
			}
			if (statement.includes("SHOW CREATE TABLE")) {
				return records(["Table", "Create Table"], [["agent_events", "... WITH( append_mode = 'true' )"]]);
			}
			if (statement.includes("LENGTH")) return records(["n"], [[3]]);
			return affected;
		});
		const { warnings } = await new GreptimeClient(config).migrate();
		expect(warnings.some((warning) => warning.includes("anchors"))).toBe(true);
	});

	test("stays silent when anchors already matches the canonical shape", async () => {
		stubFetch((statement) => {
			if (statement.includes("information_schema")) {
				return records(
					["column_name", "data_type", "semantic_type"],
					[
						["period_start", "timestamp(3)", "TIMESTAMP"],
						["period_end", "timestamp(3)", "FIELD"],
						["root", "string", "FIELD"],
						["event_count", "bigint", "FIELD"],
						["memo", "string", "FIELD"],
						["tx_sig", "string", "FIELD"],
						["signer", "string", "FIELD"],
						["cluster", "string", "FIELD"],
						["slot", "bigint", "FIELD"],
						["anchored_at", "timestamp(3)", "FIELD"],
						["stale_hashes", "bigint", "FIELD"],
					],
				);
			}
			if (statement.includes("SHOW CREATE TABLE")) {
				return records(["Table", "Create Table"], [["agent_events", "... WITH( append_mode = 'true' )"]]);
			}
			if (statement.includes("LENGTH")) return records(["n"], [[3]]);
			return affected;
		});
		const { warnings } = await new GreptimeClient(config).migrate();
		expect(warnings).toEqual([]);
	});

	test("stays silent when the anchors shape is unreadable", async () => {
		for (const shapeReply of [
			records(["column_name", "data_type", "semantic_type"], []),
			new Response("nope", { status: 500 }),
		]) {
			stubFetch((statement) => {
				if (statement.includes("information_schema")) return shapeReply;
				if (statement.includes("SHOW CREATE TABLE")) {
					return records(["Table", "Create Table"], [["agent_events", "... WITH( append_mode = 'true' )"]]);
				}
				if (statement.includes("LENGTH")) return records(["n"], [[3]]);
				return affected;
			});
			const { warnings } = await new GreptimeClient(config).migrate();
			expect(warnings).toEqual([]);
		}
	});
});

describe("insertEvent ingest record", () => {
	test("the lag is five minutes, far above the five-second write timeout", () => {
		expect(INGEST_LAG_MS).toBe(300_000);
	});

	test("sends the event row before the ingest record with quoted values and NULL graph_id", async () => {
		const { sql } = stubFetch();
		const event = normalizeEvent({ ...input, graph_id: undefined }, null);
		expect(event.graph_id).toBeNull();
		await new GreptimeClient(config).insertEvent(event);

		const inserts = sql.filter((s) => s.startsWith("INSERT INTO"));
		expect(inserts.map((s) => s.slice(0, 26))).toEqual(['INSERT INTO "agent_events"', 'INSERT INTO "event_ingest"']);
		const ingest = inserts[1] ?? "";
		expect(ingest).toContain(`'${event.id}'`);
		expect(ingest).toContain(`'${event.ts}'`);
		expect(ingest).toContain("NULL");
		expect(ingest).not.toContain("undefined");
	});

	test("retries the ingest record once and resolves when it lands", async () => {
		let ingestAttempts = 0;
		const { sql } = stubFetch((statement) => {
			if (statement.includes('INSERT INTO "event_ingest"')) {
				ingestAttempts += 1;
				if (ingestAttempts === 1) return new Response("nope", { status: 500 });
			}
			return defaultReply(statement);
		});
		await new GreptimeClient(config).insertEvent(normalizeEvent(input, null));

		expect(sql.filter((s) => s.startsWith('INSERT INTO "agent_events"'))).toHaveLength(1);
		expect(sql.filter((s) => s.startsWith('INSERT INTO "event_ingest"'))).toHaveLength(2);
	});

	test("a retried ingest record takes a fresh stamp in the new hour, not the failed one", async () => {
		const H10 = Date.UTC(2026, 8, 26, 10);
		const firstStamp = H10 + 5 * 60_000;
		const retryStamp = H10 + 3_600_000 + 5 * 60_000;
		expect(retryStamp - firstStamp).toBeGreaterThan(3_600_000 - 5 * 60_000);
		const stamps = [firstStamp, retryStamp, retryStamp];
		let clockCalls = 0;
		const clock = (): number => stamps[Math.min(clockCalls++, stamps.length - 1)] ?? retryStamp;
		let ingestAttempts = 0;
		const { sql } = stubFetch((statement) => {
			if (statement.includes('INSERT INTO "event_ingest"')) {
				ingestAttempts += 1;
				if (ingestAttempts === 1) return new Response("nope", { status: 500 });
			}
			return defaultReply(statement);
		});
		await new GreptimeClient(config, undefined, clock).insertEvent(normalizeEvent(input, null));
		const events = sql.filter((s) => s.startsWith('INSERT INTO "agent_events"'));
		const ingests = sql.filter((s) => s.startsWith('INSERT INTO "event_ingest"'));
		expect(events).toHaveLength(1);
		expect(ingests).toHaveLength(2);
		expect(ingests[0]).toContain(new Date(firstStamp).toISOString());
		expect(ingests[1]).toContain(new Date(retryStamp).toISOString());
		expect(ingests[1]).not.toContain(new Date(firstStamp).toISOString());
	});

	test("throws IngestNotRecorded after two failed attempts with the event sent exactly once", async () => {
		const { sql } = stubFetch((statement) =>
			statement.includes('INSERT INTO "event_ingest"')
				? new Response("nope", { status: 500 })
				: defaultReply(statement),
		);
		const event = normalizeEvent(input, null);
		const seen = await new GreptimeClient(config)
			.insertEvent(event)
			.then((): null => null, (cause: unknown) => cause);
		expect(seen).toBeInstanceOf(IngestNotRecorded);
		expect((seen as IngestNotRecorded).eventId).toBe(event.id);
		expect(sql.filter((s) => s.startsWith('INSERT INTO "agent_events"'))).toHaveLength(1);
		expect(sql.filter((s) => s.startsWith('INSERT INTO "event_ingest"'))).toHaveLength(2);
	});

	test("does not insert an ingest record when the live table is not append-only", async () => {
		const { sql } = stubFetch((statement) => {
			if (statement.includes('SHOW CREATE TABLE "event_ingest"')) {
				return records(["Create Table"], [['CREATE TABLE "event_ingest" (...) ENGINE=mito']]);
			}
			return defaultReply(statement);
		});
		const event = normalizeEvent(input, null);
		const seen = await new GreptimeClient(config)
			.insertEvent(event)
			.then((): null => null, (cause: unknown) => cause);
		expect(seen).toBeInstanceOf(IngestNotRecorded);
		expect(String(seen)).toContain("not in append_mode");
		expect(sql.filter((s) => s.startsWith('INSERT INTO "agent_events"'))).toHaveLength(1);
		expect(sql.filter((s) => s.startsWith('INSERT INTO "event_ingest"'))).toHaveLength(0);
	});

	test("a stalled first ingest attempt spends the budget, so there is no second full wait", async () => {
		expect(INGEST_BUDGET_MS).toBeLessThanOrEqual(1_000);
		let now = 10_000;
		const realNow = Date.now;
		Date.now = () => now;
		let ingestInserts = 0;
		try {
			stubFetch((statement) => {
				if (statement.includes('INSERT INTO "event_ingest"')) {
					ingestInserts += 1;
					now += INGEST_BUDGET_MS;
					return new Response("nope", { status: 500 });
				}
				return defaultReply(statement);
			});
			const event = normalizeEvent(input, null);
			const seen = await new GreptimeClient(config)
				.insertEvent(event)
				.then((): null => null, (cause: unknown) => cause);
			expect(seen).toBeInstanceOf(IngestNotRecorded);
			expect(ingestInserts).toBe(1);
		} finally {
			Date.now = realNow;
		}
	});

	test("the late-record stderr line names the event id", async () => {
		stubFetch();
		const event = normalizeEvent(input, null);
		const stamp = Date.UTC(2026, 9, 8, 10, 5);
		let calls = 0;
		const clock = (): number => {
			calls += 1;
			return calls <= 1 ? stamp : stamp + 2 * 60 * 60 * 1000;
		};
		const written: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			await new GreptimeClient(config, { clock }).insertEvent(event);
		} finally {
			process.stderr.write = original;
		}
		expect(written.join("")).toContain(event.id);
	});

	test("the late-record diagnostic is silent just before closure and single at closure", async () => {
		const hour = Date.UTC(2026, 8, 26, 10);
		const hourIso = new Date(hour).toISOString();
		const stamp = hour + 5 * 60_000;
		const written: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			stubFetch();
			const open = normalizeEvent(input, null);
			const openNow = hour + 3_600_000 + INGEST_LAG_MS - 1;
			const openTicks = [stamp, openNow];
			await new GreptimeClient(config, undefined, () => openTicks.shift() ?? openNow).insertEvent(open);
			expect(written.join("")).not.toContain(open.id);

			stubFetch();
			const closed = normalizeEvent(input, null);
			const closedNow = hour + 3_600_000 + INGEST_LAG_MS;
			const closedTicks = [stamp, closedNow];
			await new GreptimeClient(config, undefined, () => closedTicks.shift() ?? closedNow).insertEvent(closed);
			const lines = written.join("");
			expect(lines).toContain(closed.id);
			expect(lines).toContain(hourIso);
			expect(written).toHaveLength(1);
		} finally {
			process.stderr.write = original;
		}
	});
});

describe("hourLeaves", () => {
	const H10 = Date.UTC(2026, 8, 26, 10);
	const H11 = H10 + 3_600_000;
	const E1 = "evt_e1";
	const E2 = "evt_e2";
	const E3 = "evt_e3";
	const E4 = "evt_e4";
	const E5 = "evt_e5";
	const TIE = H10 + 5 * 60_000 + 10;
	const E1TS = H10 + 5 * 60_000;
	const E2TS = H10 + 5 * 60_000 + 5;
	const E3TS = Date.UTC(2026, 8, 1, 3);
	const E3ING = H10 + 10 * 60_000;
	const E4TS = H10 - 500;
	const E4LATE = H10 + 200;
	const E5TS = H10 + 29 * 60_000;
	const E5A = H10 + 30 * 60_000;
	const E5B = E5A + 5_000;
	const HA = "a".repeat(64);
	const HB = "b".repeat(64);
	const HC = "c".repeat(64);
	const HE = "e".repeat(64);

	function stubHour(overrides: { hashRows?: unknown[][]; earlierRows?: unknown[][] } = {}): { sql: string[] } {
		return stubFetch((statement) => {
			if (statement.includes("SELECT DISTINCT")) {
				return records(["event_id"], overrides.earlierRows ?? [[E4]]);
			}
			if (statement.includes('FROM "agent_events"')) {
				return records(
					["id", "hash"],
					overrides.hashRows ?? [
						[E1, HA],
						[E3, HC],
						[E5, HE],
						[E2, HB],
					],
				);
			}
			if (statement.includes('FROM "event_ingest"')) {
				// Deliberately shuffled, with duplicates of E1 and E5, a
				// backdated E3, and an E4 whose earlier record the lookback
				// must catch. The order comes from TypeScript, never from here.
				return records(
					["event_id", "ingested_at", "event_ts"],
					[
						[E5, E5B, E5TS],
						[E3, E3ING, E3TS],
						[E1, TIE, E1TS],
						[E2, TIE, E2TS],
						[E5, E5A, E5TS],
						[E1, TIE, E1TS],
						[E4, E4LATE, E4TS],
					],
				);
			}
			return defaultReply(statement);
		});
	}

	test("returns members in position order with duplicates collapsed and earlier-hour ids excluded", async () => {
		stubHour();
		const leaves = await new GreptimeClient(config).hourLeaves(H10);
		expect(leaves.map((leaf) => leaf.event_id)).toEqual([E1, E2, E3, E5]);
		expect(leaves[0]).toEqual({ event_id: E1, ingested_at: TIE, hash: HA });
		expect(leaves[1]).toEqual({ event_id: E2, ingested_at: TIE, hash: HB });
		expect(leaves[2]).toEqual({ event_id: E3, ingested_at: E3ING, hash: HC });
		expect(leaves[3]).toEqual({ event_id: E5, ingested_at: E5A, hash: HE });
	});

	test("reads through three flat shapes that all pass assertAppendOnly", async () => {
		const { sql } = stubHour();
		await new GreptimeClient(config).hourLeaves(H10);
		const member =
			sql.find((s) => s.includes('FROM "event_ingest"') && !s.includes("DISTINCT")) ?? "";
		expect(member).toContain(`"ingested_at" >= '${new Date(H10).toISOString()}'`);
		expect(member).toContain(`"ingested_at" < '${new Date(H11).toISOString()}'`);
		const lookback = sql.find((s) => s.includes("SELECT DISTINCT")) ?? "";
		expect(lookback).toContain(`"ingested_at" < '${new Date(H10).toISOString()}'`);
		expect(lookback).toContain("IN (");
		const hashes = sql.find((s) => s.includes('FROM "agent_events"')) ?? "";
		expect(hashes).toContain('"ts" >=');
		expect(hashes).toContain('"ts" <=');
		expect(hashes).toContain('"id" IN (');
		for (const statement of sql) assertAppendOnly(statement);
	});

	test("throws naming the event when a member has no event row", async () => {
		stubHour({ hashRows: [[E1, HA], [E2, HB], [E5, HE]] });
		await expect(new GreptimeClient(config).hourLeaves(H10)).rejects.toThrow(E3);
	});

	test("throws naming the event on a hash that is not 64 lowercase hex", async () => {
		stubHour({ hashRows: [[E1, HA], [E2, "zz"], [E3, HC], [E5, HE]] });
		await expect(new GreptimeClient(config).hourLeaves(H10)).rejects.toThrow(E2);
	});

	test("throws naming the event on two stored hashes for one id", async () => {
		stubHour({ hashRows: [[E1, HA], [E1, HB], [E2, HB], [E3, HC], [E5, HE]] });
		await expect(new GreptimeClient(config).hourLeaves(H10)).rejects.toThrow(E1);
	});

	test.each([
		["ingested_at is text", "not-a-time", E1TS],
		["event_ts is text", TIE, "not-a-time"],
		["ingested_at is null", null, E1TS],
		["event_ts is empty", TIE, ""],
	] as const)("throws naming the event when an ingest record's time is not a number (%s)", async (_case, ingested, ts) => {
		stubFetch((statement) =>
			statement.includes('FROM "event_ingest"')
				? records(["event_id", "ingested_at", "event_ts"], [[E1, ingested, ts]])
				: defaultReply(statement),
		);
		await expect(new GreptimeClient(config).hourLeaves(H10)).rejects.toThrow(E1);
	});

	test("an empty hour reads nothing further and returns no leaves", async () => {
		const { sql } = stubFetch((statement) =>
			statement.includes('FROM "event_ingest"')
				? records(["event_id", "ingested_at", "event_ts"], [])
				: defaultReply(statement),
		);
		const leaves = await new GreptimeClient(config).hourLeaves(H10);
		expect(leaves).toEqual([]);
		expect(sql.filter((s) => s.includes("SHOW CREATE TABLE"))).toHaveLength(1);
		expect(sql.filter((s) => s.includes('FROM "event_ingest"'))).toHaveLength(1);
		expect(sql.filter((s) => s.includes("SELECT DISTINCT"))).toHaveLength(0);
	});

	test("refuses to read membership when event_ingest is not append-only", async () => {
		const { sql } = stubFetch((statement) => {
			if (statement.includes('SHOW CREATE TABLE "event_ingest"')) {
				return records(["Create Table"], [["CREATE TABLE event_ingest ENGINE=mito"]]);
			}
			return defaultReply(statement);
		});
		await expect(new GreptimeClient(config).hourLeaves(H10)).rejects.toThrow(/not in append_mode/);
		expect(sql.some((s) => s.includes('FROM "event_ingest"'))).toBe(false);
	});

	test("refuses to read membership when append_mode cannot be confirmed", async () => {
		stubFetch((statement) =>
			statement.includes('SHOW CREATE TABLE "event_ingest"')
				? new Response("nope", { status: 500 })
				: defaultReply(statement),
		);
		await expect(new GreptimeClient(config).hourLeaves(H10)).rejects.toThrow(/could not confirm event_ingest/);
	});

	test("batches the lookback and the hash lookup at 500 ids", async () => {
		const ids = Array.from({ length: 501 }, (_, i) => `evt_batch_${String(i).padStart(4, "0")}`);
		const { sql } = stubFetch((statement) => {
			if (statement.includes("SELECT DISTINCT")) return records(["event_id"], []);
			if (statement.includes('FROM "agent_events"')) {
				const wanted = ids.filter((id) => statement.includes(`'${id}'`));
				return records(
					["id", "hash"],
					wanted.map((id) => [id, ids.indexOf(id).toString(16).padStart(64, "0")]),
				);
			}
			if (statement.includes('FROM "event_ingest"')) {
				return records(
					["event_id", "ingested_at", "event_ts"],
					ids.map((id, i) => [id, H10 + i, H10 + i]),
				);
			}
			return defaultReply(statement);
		});
		const leaves = await new GreptimeClient(config).hourLeaves(H10);
		expect(leaves).toHaveLength(501);
		expect(leaves[0]?.event_id).toBe(ids[0]);
		expect(leaves[500]?.event_id).toBe(ids[500]);
		expect(sql.filter((s) => s.includes("SELECT DISTINCT"))).toHaveLength(2);
		expect(sql.filter((s) => s.includes('FROM "agent_events"'))).toHaveLength(2);
	});
});

describe("anchors", () => {
	const H10 = Date.UTC(2026, 8, 26, 10);
	const H11 = H10 + 3_600_000;
	const H12 = H11 + 3_600_000;
	const ROOT = "a".repeat(64);
	const MEMO = `substrate:v1:2026-09-26T10:00:00.000Z:${ROOT}:3`;
	const SIG = "5".repeat(87);

	function anchorRow(periodMs: number): unknown[] {
		return [
			periodMs,
			periodMs + 3_600_000,
			ROOT,
			3,
			MEMO,
			SIG,
			"4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
			"devnet",
			42,
			periodMs + 3_600_000 + 300_000,
			null,
		];
	}

	const COLUMNS = [
		"period_start",
		"period_end",
		"root",
		"event_count",
		"memo",
		"tx_sig",
		"signer",
		"cluster",
		"slot",
		"anchored_at",
		"stale_hashes",
	];

	test("anchorsBetween reads the window ascending with quoted ISO bounds", async () => {
		const { sql } = stubFetch((statement) =>
			statement.includes('FROM "anchors"')
				? records(COLUMNS, [anchorRow(H10), anchorRow(H11)])
				: defaultReply(statement),
		);
		const rows = await new GreptimeClient(config).anchorsBetween(H10, H12);
		expect(rows.map((row) => row.period_start)).toEqual(["2026-09-26T10:00:00.000Z", "2026-09-26T11:00:00.000Z"]);
		expect(rows[0]).toMatchObject({ root: ROOT, event_count: 3, cluster: "devnet", slot: 42, stale_hashes: null });
		const read = sql.find((s) => s.includes('FROM "anchors"')) ?? "";
		expect(read).toContain("'2026-09-26T10:00:00.000Z'");
		expect(read).toContain("'2026-09-26T12:00:00.000Z'");
		expect(read).toContain("ORDER BY");
		expect(() => assertAppendOnly(read)).not.toThrow();
	});

	test("anchorForPeriod returns the row, or null when the hour is unanchored", async () => {
		const found = stubFetch((statement) =>
			statement.includes('FROM "anchors"') ? records(COLUMNS, [anchorRow(H10)]) : defaultReply(statement),
		);
		const row = await new GreptimeClient(config).anchorForPeriod(H10);
		expect(row?.tx_sig).toBe(SIG);
		expect(found.sql.find((s) => s.includes('FROM "anchors"'))).toContain("'2026-09-26T10:00:00.000Z'");

		stubFetch((statement) => (statement.includes('FROM "anchors"') ? records(COLUMNS, []) : defaultReply(statement)));
		expect(await new GreptimeClient(config).anchorForPeriod(H11)).toBeNull();
	});

	test("insertAnchor writes all 11 production columns with stale_hashes NULL and cluster devnet", async () => {
		const { sql } = stubFetch();
		await new GreptimeClient(config).insertAnchor({
			period_start: "2026-09-26T10:00:00.000Z",
			period_end: "2026-09-26T11:00:00.000Z",
			root: ROOT,
			event_count: 3,
			memo: MEMO,
			tx_sig: SIG,
			signer: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
			cluster: "devnet",
			slot: 42,
			anchored_at: "2026-09-26T11:05:00.000Z",
		});
		const insert = insertStatement(sql);
		for (const column of COLUMNS) expect(insert).toContain(`"${column}"`);
		expect(insert).toContain("'devnet'");
		expect(insert).toContain(`'${MEMO}'`);
		expect(insert).toContain(`'${SIG}'`);
		expect(insert).toMatch(/NULL\)$/);
		expect(() => assertAppendOnly(insert)).not.toThrow();
	});

	test("firstIngestMs returns the earliest record, or null on an empty store", async () => {
		stubFetch((statement) =>
			statement.includes('FROM "event_ingest"') ? records(["ingested_at"], [[H10 + 7_000]]) : defaultReply(statement),
		);
		expect(await new GreptimeClient(config).firstIngestMs()).toBe(H10 + 7_000);

		stubFetch((statement) =>
			statement.includes('FROM "event_ingest"') ? records(["ingested_at"], []) : defaultReply(statement),
		);
		expect(await new GreptimeClient(config).firstIngestMs()).toBeNull();
	});
});

describe("graphIngest", () => {
	const G = "ut-mz3k1q-8a1f2c3d";
	const H10 = Date.UTC(2026, 8, 26, 10);

	test("reads by the stored graph id and collapses duplicates to the earliest record", async () => {
		const { sql } = stubFetch((statement) =>
			statement.includes('FROM "event_ingest"')
				? records(
						["event_id", "event_ts", "ingested_at"],
						[
							["evt_1", H10 + 1_000, H10 + 5_000],
							["evt_1", H10 + 1_000, H10 + 2_000],
							["evt_2", H10 + 3_000, H10 + 4_000],
						],
					)
				: defaultReply(statement),
		);
		const rows = await new GreptimeClient(config).graphIngest(G);
		expect(rows).toEqual([
			{ event_id: "evt_1", event_ts: H10 + 1_000, ingested_at: H10 + 2_000 },
			{ event_id: "evt_2", event_ts: H10 + 3_000, ingested_at: H10 + 4_000 },
		]);
		const read = sql.find((s) => s.includes('FROM "event_ingest"')) ?? "";
		expect(read).toContain(`'${G}'`);
		expect(() => assertAppendOnly(read)).not.toThrow();
	});

	test("a record with a time that is not a number names the event", async () => {
		stubFetch((statement) =>
			statement.includes('FROM "event_ingest"')
				? records(["event_id", "event_ts", "ingested_at"], [["evt_9", H10, "soon"]])
				: defaultReply(statement),
		);
		await expect(new GreptimeClient(config).graphIngest(G)).rejects.toThrow("evt_9");
	});
});

describe("stream reads are bounded in time (uplift-2 R5)", () => {
	const T0 = Date.UTC(2026, 9, 13, 12);

	test("eventIdsAfter bounds the anti-join's inner side to the retry lookback before the cursor", async () => {
		const { sql } = stubFetch(() => records(["event_id", "ingested_at", "event_ts"], []));
		await new GreptimeClient(config).eventIdsAfter({ id: "evt_9", ingestedAt: T0 }, 7);
		const statement = sql[0] ?? "";
		expect(INGEST_RETRY_LOOKBACK_MS).toBe(3_600_000);
		expect(statement).toContain(`p."ingested_at" >= '${new Date(T0 - INGEST_RETRY_LOOKBACK_MS).toISOString()}'`);
		// The lookback sits inside the anti-join, not on the outer window.
		expect(statement.indexOf('p."ingested_at" >=')).toBeGreaterThan(statement.indexOf("NOT EXISTS"));
		expect(() => assertAppendOnly(statement)).not.toThrow();
	});

	test("the lookback never reaches before the epoch for the ledger-start cursor", async () => {
		const { sql } = stubFetch(() => records(["event_id", "ingested_at", "event_ts"], []));
		await new GreptimeClient(config).eventIdsAfter({ id: "", ingestedAt: 0 }, 7);
		expect(sql[0]).toContain(`p."ingested_at" >= '1970-01-01T00:00:00.000Z'`);
	});

	test("positions carry the event's own ts, and omit it when the record has none", async () => {
		stubFetch(() =>
			records(
				["event_id", "ingested_at", "event_ts"],
				[
					["evt_1", T0 + 1, T0 - 500],
					["evt_2", T0 + 2, null],
				],
			),
		);
		const positions = await new GreptimeClient(config).eventIdsAfter({ id: "", ingestedAt: T0 }, 10);
		expect(positions).toEqual([
			{ id: "evt_1", ingestedAt: T0 + 1, eventTs: T0 - 500 },
			{ id: "evt_2", ingestedAt: T0 + 2 },
		]);
	});

	test("eventsByIds brackets ts between the earliest and latest event_ts it is given", async () => {
		const { sql } = stubFetch(() => records(["id"], []));
		await new GreptimeClient(config).eventsByIds([
			{ id: "evt_b", ingestedAt: T0 + 2, eventTs: T0 + 900 },
			{ id: "evt_a", ingestedAt: T0 + 1, eventTs: T0 - 500 },
		]);
		const statement = sql[0] ?? "";
		expect(statement).toContain(`"id" IN ('evt_b', 'evt_a')`);
		expect(statement).toContain(`"ts" BETWEEN '${new Date(T0 - 500).toISOString()}' AND '${new Date(T0 + 900).toISOString()}'`);
		expect(statement).not.toContain('"payload"');
		expect(() => assertAppendOnly(statement)).not.toThrow();
	});

	test("eventsByIds stays unbounded for bare ids or a position without event_ts", async () => {
		const { sql } = stubFetch(() => records(["id"], []));
		const client = new GreptimeClient(config);
		await client.eventsByIds(["evt_a", "evt_b"]);
		await client.eventsByIds([{ id: "evt_a", ingestedAt: T0, eventTs: T0 }, { id: "evt_b", ingestedAt: T0 }]);
		expect(sql).toHaveLength(2);
		for (const statement of sql) expect(statement).not.toContain("BETWEEN");
		expect(await client.eventsByIds([])).toEqual([]);
	});

	test("readEvents and graphIngest stay unbounded, because verify must see everything", async () => {
		const { sql } = stubFetch(() => records(["id"], []));
		const client = new GreptimeClient(config);
		await client.readEvents("graph_id", "ut-1");
		await client.graphIngest("ut-1");
		for (const statement of sql.filter((s) => s.startsWith("SELECT"))) {
			expect(statement).not.toContain('"ts" >=');
			expect(statement).not.toContain("BETWEEN");
			expect(statement).not.toContain('"ingested_at" >=');
		}
	});
});

describe("substrate_health and the write probe (uplift-2 R5)", () => {
	/** The migrate stub: append_mode holds everywhere, so only the health table is of interest. */
	function migrateReply(statement: string): unknown {
		if (statement.includes("SHOW CREATE TABLE")) return records(["Table", "Create Table"], [["t", "... WITH( append_mode = 'true' )"]]);
		if (statement.includes("information_schema")) return records(["column_name", "data_type", "semantic_type"], []);
		return defaultReply(statement);
	}

	test("migrate creates substrate_health append-only with a one-day ttl, after the ledger tables", async () => {
		const { sql } = stubFetch(migrateReply);
		const { warnings } = await new GreptimeClient(config).migrate();
		expect(warnings).toEqual([]);
		const health = sql.find((s) => s.includes(`CREATE TABLE IF NOT EXISTS "${HEALTH_TABLE}"`)) ?? "";
		expect(health).toContain('"ts" TIMESTAMP TIME INDEX');
		expect(health).toContain('"probe" STRING');
		expect(health).toContain("'append_mode' = 'true'");
		expect(health).toContain("'ttl' = '1d'");
		expect(sql.indexOf(health)).toBeGreaterThan(sql.findIndex((s) => s.includes('CREATE TABLE IF NOT EXISTS "anchors"')));
		expect(() => assertAppendOnly(health)).not.toThrow();
	});

	test("a server that refuses the ttl option still gets the table, with a warning", async () => {
		const { sql } = stubFetch((statement) =>
			statement.includes(HEALTH_TABLE) && statement.includes("ttl") ? { error: "unrecognized table option" } : migrateReply(statement),
		);
		const { warnings } = await new GreptimeClient(config).migrate();
		const creates = sql.filter((s) => s.includes(`CREATE TABLE IF NOT EXISTS "${HEALTH_TABLE}"`));
		expect(creates).toHaveLength(2);
		expect(creates[1]).not.toContain("ttl");
		expect(creates[1]).toContain("append_mode");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("without a ttl");
	});

	test("writeProbe inserts one stamped row and is labelled probe in the plane series", async () => {
		const { sql } = stubFetch();
		const samples: PlaneSample[] = [];
		const breaker = new CircuitBreaker("greptime", { failureThreshold: 5, openMs: 1000 }, () => 0);
		const client = new GreptimeClient(config, {
			clock: () => Date.UTC(2026, 9, 13, 12),
			gate: { plane: "greptime", breaker, observe: (sample) => samples.push(sample) },
		});
		await client.writeProbe();
		expect(sql[0]).toBe(`INSERT INTO "${HEALTH_TABLE}" ("ts", "probe") VALUES ('2026-10-13T12:00:00.000Z', 'healthz')`);
		expect(samples.map((sample) => sample.op)).toEqual(["probe"]);
		expect(() => assertAppendOnly(sql[0] ?? "")).not.toThrow();
	});

	test("probeWritable writes at most once per interval and reports the last verdict in between", async () => {
		const { sql } = stubFetch();
		let now = 1_000_000;
		const client = new GreptimeClient(config, { clock: () => now });
		const writes = () => sql.filter((s) => s.includes(HEALTH_TABLE)).length;

		expect(await client.probeWritable(60_000)).toEqual({ lastProbeAt: 1_000_000, lastProbeOk: true, lastProbeError: null });
		expect(writes()).toBe(1);
		now += 59_999;
		expect(await client.probeWritable(60_000)).toEqual({ lastProbeAt: 1_000_000, lastProbeOk: true, lastProbeError: null });
		expect(writes()).toBe(1);
		now += 1;
		expect((await client.probeWritable(60_000)).lastProbeAt).toBe(1_060_000);
		expect(writes()).toBe(2);
	});

	test("an interval of zero never probes and reports nothing known", async () => {
		const { sql } = stubFetch();
		const client = new GreptimeClient(config, { clock: () => 5 });
		expect(await client.probeWritable(0)).toEqual({ lastProbeAt: null, lastProbeOk: null, lastProbeError: null });
		expect(sql).toHaveLength(0);
	});

	test("a failed probe is the verdict, never a throw, with the reason redacted and the host scrubbed", async () => {
		stubFetch(() => new Response("no space left on device while writing to http://greptime.test/data", { status: 500 }));
		const client = new GreptimeClient(config, { clock: () => 7 });
		const probe = await client.probeWritable(60_000);
		expect(probe.lastProbeOk).toBe(false);
		expect(probe.lastProbeAt).toBe(7);
		expect(probe.lastProbeError).toContain("no space left");
		expect(probe.lastProbeError).not.toContain("greptime.test");

		// The next interval sees a recovered store.
		stubFetch();
		const recovered = new GreptimeClient(config, { clock: () => 8 });
		expect((await recovered.probeWritable(60_000)).lastProbeOk).toBe(true);
	});

	test("a SQL error (the table is missing) fails the probe without charging the breaker", async () => {
		stubFetch(() => ({ error: "table not found: substrate_health" }));
		const breaker = new CircuitBreaker("greptime", { failureThreshold: 1, openMs: 1000 }, () => 0);
		const client = new GreptimeClient(config, { clock: () => 9, gate: { plane: "greptime", breaker, observe: () => undefined } });
		expect((await client.probeWritable(60_000)).lastProbeOk).toBe(false);
		expect(breaker.state()).toBe("closed");
	});

	test("overlapping calls share one in-flight probe", async () => {
		const { sql } = stubFetch();
		const client = new GreptimeClient(config, { clock: () => 11 });
		const [a, b] = await Promise.all([client.probeWritable(60_000), client.probeWritable(60_000)]);
		expect(a).toEqual(b);
		expect(sql.filter((s) => s.includes(HEALTH_TABLE))).toHaveLength(1);
	});
});

describe("capacity (uplift-2 R5)", () => {
	const COLUMNS = ["table_name", "region_rows", "disk_size", "sst_size", "index_size"];

	test("joins region_statistics to tables in the configured schema and sums a table's regions", async () => {
		const { sql } = stubFetch(() =>
			records(COLUMNS, [
				["agent_events", 14_302, 1_280_000, 1_250_000, 3_000],
				["agent_events_pre_append_20260930", 9_851, 1_290_000, 1_200_000, 0],
				["agent_events", 10, 100, 100, 0],
				["event_ingest", 1_074, 50_000, 48_000, 0],
			]),
		);
		const capacity = await new GreptimeClient(config).capacity();
		expect(sql[0]).toContain('"information_schema"."region_statistics"');
		expect(sql[0]).toContain('"information_schema"."tables"');
		expect(sql[0]).toContain(`"table_schema" = 'substrate'`);
		expect(() => assertAppendOnly(sql[0] ?? "")).not.toThrow();
		expect(capacity).toEqual({
			bytes: 1_280_100 + 1_290_000 + 50_000,
			rows: 14_312 + 9_851 + 1_074,
			tables: [
				{ name: "agent_events_pre_append_20260930", rows: 9_851, diskBytes: 1_290_000, sstBytes: 1_200_000, indexBytes: 0 },
				{ name: "agent_events", rows: 14_312, diskBytes: 1_280_100, sstBytes: 1_250_100, indexBytes: 3_000 },
				{ name: "event_ingest", rows: 1_074, diskBytes: 50_000, sstBytes: 48_000, indexBytes: 0 },
			],
		});
	});

	test("keeps the ten largest tables by disk, totals over all of them, and reads a null cell as zero", async () => {
		stubFetch(() => records(COLUMNS, Array.from({ length: 12 }, (_, i) => [`t${i}`, i, i * 10, null, null])));
		const capacity = await new GreptimeClient(config).capacity();
		expect(capacity.tables).toHaveLength(10);
		expect(capacity.tables[0]?.name).toBe("t11");
		expect(capacity.tables.map((table) => table.sstBytes)).toEqual(Array(10).fill(0));
		expect(capacity.bytes).toBe(Array.from({ length: 12 }, (_, i) => i * 10).reduce((a, b) => a + b, 0));
		expect(capacity.rows).toBe(66);
	});

	test("throws rather than inventing numbers when the store does not answer", async () => {
		stubFetch(() => new Response("nope", { status: 503 }));
		await expect(new GreptimeClient(config).capacity()).rejects.toBeInstanceOf(GreptimeUnavailable);
	});
});

describe("opt-in ttl (uplift-2 R5)", () => {
	/** Migrate stub where each retention table reports its own live ttl. */
	function liveTtl(ttls: Partial<Record<"agent_events" | "event_ingest", string>>): { sql: string[] } {
		return stubFetch((statement) => {
			const table = /SHOW CREATE TABLE "([^"]+)"/.exec(statement)?.[1];
			if (table) {
				const ttl = ttls[table as "agent_events" | "event_ingest"];
				return records(["Table", "Create Table"], [[table, `... WITH( append_mode = 'true'${ttl ? `, ttl = '${ttl}'` : ""} )`]]);
			}
			if (statement.includes("information_schema")) return records(["column_name", "data_type", "semantic_type"], []);
			return defaultReply(statement);
		});
	}

	test("ttlOf reads the option as Greptime prints it and as the DDL quotes it", () => {
		expect(ttlOf("CREATE TABLE ... WITH( append_mode = 'true', ttl = '180d' )")).toBe("180d");
		expect(ttlOf("WITH ('append_mode' = 'true', 'ttl' = '4320h')")).toBe("4320h");
		expect(ttlOf("WITH( append_mode = 'true' )")).toBeNull();
	});

	test("sends no ALTER when SUBSTRATE_LEDGER_TTL is unset, whatever the tables carry", async () => {
		const { sql } = liveTtl({ agent_events: "7d" });
		const { warnings } = await new GreptimeClient(config).migrate();
		expect(warnings).toEqual([]);
		expect(sql.some((s) => /^ALTER/i.test(s))).toBe(false);
	});

	test("ALTERs exactly the tables whose live ttl differs, and only those", async () => {
		const { sql } = liveTtl({ event_ingest: "180D" });
		const client = new GreptimeClient(config, { ledger: loadLedgerSettings({ SUBSTRATE_LEDGER_TTL: "180d" }) });
		const { warnings } = await client.migrate();
		expect(warnings).toEqual([]);
		expect(sql.filter((s) => s.startsWith("ALTER"))).toEqual([`ALTER TABLE "agent_events" SET 'ttl'='180d'`]);
	});

	test("a failed ALTER is a boot warning naming the live value, not a refusal to serve", async () => {
		const { sql } = liveTtl({});
		const base = globalThis.fetch;
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			const statement = new URLSearchParams(String(init.body)).get("sql") ?? "";
			if (statement.startsWith("ALTER")) {
				sql.push(statement);
				return new Response(JSON.stringify({ error: "permission denied" }), { status: 200 });
			}
			return base(url, init);
		}) as unknown as typeof fetch;
		const client = new GreptimeClient(config, { ledger: loadLedgerSettings({ SUBSTRATE_LEDGER_TTL: "180d" }) });
		const { warnings } = await client.migrate();
		expect(warnings).toHaveLength(2);
		for (const warning of warnings) {
			expect(warning).toContain("SUBSTRATE_LEDGER_TTL=180d was not applied");
			expect(warning).toContain("live ttl unset");
		}
	});

	test("an unreadable table is a warning and is not altered blind", async () => {
		const { sql } = stubFetch((statement) =>
			statement.includes("SHOW CREATE TABLE") ? new Response("nope", { status: 500 }) : defaultReply(statement),
		);
		const client = new GreptimeClient(config, { ledger: loadLedgerSettings({ SUBSTRATE_LEDGER_TTL: "180d" }) });
		const { warnings } = await client.migrate();
		expect(sql.some((s) => s.startsWith("ALTER"))).toBe(false);
		expect(warnings.filter((warning) => warning.includes("could not read its ttl"))).toHaveLength(2);
	});

	test("the guarded path is the only ALTER: sql() still refuses one, and alterTtl refuses other tables and values", async () => {
		const { sql } = stubFetch();
		const client = new GreptimeClient(config);
		await expect(client.sql(`ALTER TABLE "agent_events" SET 'ttl'='1d'`)).rejects.toThrow(AppendOnlyViolation);
		await expect(client.sql(`ALTER TABLE "agent_events" DROP COLUMN "hash"`)).rejects.toThrow(AppendOnlyViolation);
		await expect(client.alterTtl("anchors" as never, "1d")).rejects.toThrow(AppendOnlyViolation);
		await expect(client.alterTtl("agent_events", "1.5d")).rejects.toThrow(AppendOnlyViolation);
		await expect(client.alterTtl("agent_events", "1d; DROP TABLE x")).rejects.toThrow(AppendOnlyViolation);
		expect(sql).toHaveLength(0);
		await client.alterTtl("event_ingest", "4320h");
		expect(sql).toEqual([`ALTER TABLE "event_ingest" SET 'ttl'='4320h'`]);
		expect(sqlOp(sql[0] ?? "")).toBe("alter");
	});

	test("an invalid SUBSTRATE_LEDGER_TTL is refused at config load with a clear message; unset means no ttl", () => {
		expect(loadConfig({}).ledger).toEqual({
			chainCache: true,
			chainCacheMax: 10_000,
			chainLookbackDays: 30,
			writeProbeS: 60,
			ttl: null,
			maxUncoveredHours: 2,
			archiveDir: null,
		});
		expect(loadConfig({ SUBSTRATE_LEDGER_TTL: "180d" }).ledger.ttl).toBe("180d");
		expect(loadConfig({ SUBSTRATE_LEDGER_TTL: "1h 30m" }).ledger.ttl).toBe("1h 30m");
		for (const bad of ["1.5h", "forever", "0xABm", "180", "+1d", "1d; DROP TABLE x"]) {
			expect(() => loadConfig({ SUBSTRATE_LEDGER_TTL: bad })).toThrow(ConfigError);
			expect(() => loadConfig({ SUBSTRATE_LEDGER_TTL: bad })).toThrow("SUBSTRATE_LEDGER_TTL");
		}
		const knobs = loadLedgerSettings({
			SUBSTRATE_LEDGER_CHAIN_CACHE: "0",
			SUBSTRATE_LEDGER_CHAIN_CACHE_MAX: "0",
			SUBSTRATE_LEDGER_CHAIN_LOOKBACK_DAYS: "9999",
			SUBSTRATE_LEDGER_WRITE_PROBE_S: "nope",
		});
		expect(knobs).toEqual({
			chainCache: false,
			chainCacheMax: 1,
			chainLookbackDays: 3650,
			writeProbeS: 60,
			ttl: null,
			maxUncoveredHours: 2,
			archiveDir: null,
		});
		// uplift-3 N6: the archive knobs read like the others — clamped, trimmed, unset means "not here".
		expect(loadLedgerSettings({ SUBSTRATE_LEDGER_MAX_UNCOVERED_HOURS: "-3", SUBSTRATE_LEDGER_ARCHIVE_DIR: "  /mnt/ledger-archive " })).toMatchObject({
			maxUncoveredHours: 0,
			archiveDir: "/mnt/ledger-archive",
		});
		expect(loadLedgerSettings({ SUBSTRATE_LEDGER_ARCHIVE_DIR: "   " }).archiveDir).toBeNull();
	});
});

describe("anchorCoverage (uplift-3 N6)", () => {
	const HOUR = 3_600_000;
	/** 12:00Z; `now` sits half an hour into it, so H-1 is closed and eligible and H is neither. */
	const H = Date.UTC(2026, 9, 13, 12);
	const NOW = H + 30 * 60_000;
	const ANCHOR_COLUMNS = ["period_start", "period_end", "root", "event_count", "memo", "tx_sig", "signer", "cluster", "slot", "anchored_at", "stale_hashes"];
	const anchorRow = (hour: number): unknown[] => [hour, hour + HOUR, "a".repeat(64), 3, "memo", "sig", "signer", "devnet", 1, hour + HOUR + 300_000, null];

	/** The four reads, told apart by shape: newest anchor, the anchor window, the ingest histogram, the archive note. */
	function stubCoverage(options: {
		anchoredHours: number[];
		eventHours: number[];
		note?: { ts: number; id: string; payload: string };
		notes?: Array<{ ts: number; id: string; summary: string; payload: string }>;
	}): { sql: string[] } {
		const notes = options.notes ?? (options.note ? [{ ...options.note, summary: "ledger archive 2026-10-12: x" }] : []);
		return stubFetch((statement) => {
			if (statement.includes('FROM "anchors"') && statement.includes('ORDER BY "period_start" DESC')) {
				const newest = Math.max(...options.anchoredHours);
				return records(["period_start"], options.anchoredHours.length > 0 ? [[newest]] : []);
			}
			if (statement.includes('FROM "anchors"')) return records(ANCHOR_COLUMNS, options.anchoredHours.map(anchorRow));
			// Seconds, as `to_unixtime` answers, and a count per hour.
			if (statement.includes("date_bin")) return records(["hour", "n"], options.eventHours.map((hour) => [hour / 1000, 7]));
			if (statement.includes("ledger archive")) {
				// Ordered as the statement says: by summary (the day) when it asks, else by write time.
				const bySummary = statement.includes('ORDER BY "summary" DESC');
				const ordered = [...notes].sort((a, b) =>
					bySummary ? (a.summary < b.summary ? 1 : a.summary > b.summary ? -1 : b.ts - a.ts) : b.ts - a.ts,
				);
				return records(["ts", "id", "payload"], ordered.slice(0, 1).map((n) => [n.ts, n.id, n.payload]));
			}
			return defaultReply(statement);
		});
	}

	test("names the newest anchored hour, the lag in whole hours and the eligible hours with events but no anchor", async () => {
		const { sql } = stubCoverage({
			anchoredHours: [H - 3 * HOUR, H - 2 * HOUR],
			// H-3..H-1 hold events; so does the current hour, which is not eligible.
			eventHours: [H - 3 * HOUR, H - 2 * HOUR, H - HOUR, H],
			note: { ts: H - 9 * HOUR, id: "evt_note", payload: JSON.stringify({ action: "ledger.archive", day: "2026-10-12" }) },
		});
		const coverage = await new GreptimeClient(config).anchorCoverage({ now: NOW });
		expect(coverage).toEqual({
			newestAnchoredHour: new Date(H - 2 * HOUR).toISOString(),
			lagHours: 2,
			uncoveredHours: [new Date(H - HOUR).toISOString()],
			more: false,
			lastArchiveWindow: { day: "2026-10-12", writtenAt: new Date(H - 9 * HOUR).toISOString(), eventId: "evt_note" },
		});
		// Every read is bounded and append-only: the histogram and the anchor window
		// cover the 7-day lookback, the note read is a `ts` window on the
		// `substrate`/`note` series, and nothing is written.
		for (const statement of sql) assertAppendOnly(statement);
		const histogram = sql.find((s) => s.includes("date_bin")) ?? "";
		expect(histogram).toContain(`"ingested_at" >= '${new Date(H - 7 * 24 * HOUR).toISOString()}'`);
		expect(histogram).toContain(`"ingested_at" < '${new Date(H).toISOString()}'`);
		expect(histogram).toContain("GROUP BY");
		const note = sql.find((s) => s.includes("ledger archive")) ?? "";
		expect(note).toContain(`"surface" = 'substrate' AND "kind" = 'note'`);
		expect(note).toContain('"ts" >=');
		expect(note).toContain("LIMIT 1");
		expect(sql.some((s) => s.startsWith("INSERT"))).toBe(false);
	});

	test("the last archive day is the newest day in a note's summary, not the newest write: a late retry of an older day does not move it backwards", async () => {
		const note = (day: string, ts: number, id: string): { ts: number; id: string; summary: string; payload: string } => ({
			ts,
			id,
			summary: `ledger archive ${day}: 5 events, 5 ingest rows, 2 receipts`,
			payload: JSON.stringify({ action: "ledger.archive", day }),
		});
		// 2026-10-11's note failed and was retried an hour ago; 2026-10-12's was stored first, at 03:30.
		const { sql } = stubCoverage({
			anchoredHours: [H - HOUR],
			eventHours: [],
			notes: [note("2026-10-12", H - 9 * HOUR, "evt_d2"), note("2026-10-11", H - HOUR, "evt_d1_retry")],
		});
		const coverage = await new GreptimeClient(config).anchorCoverage({ now: NOW });
		expect(coverage.lastArchiveWindow).toEqual({ day: "2026-10-12", writtenAt: new Date(H - 9 * HOUR).toISOString(), eventId: "evt_d2" });
		const read = sql.find((s) => s.includes("ledger archive")) ?? "";
		expect(read).toContain('ORDER BY "summary" DESC, "ts" DESC');
	});

	test("with no anchor at all, lists the newest 48 uncovered hours and says there are more; the lag is unknown", async () => {
		const eventHours = Array.from({ length: 60 }, (_, i) => H - (i + 1) * HOUR);
		stubCoverage({ anchoredHours: [], eventHours });
		const coverage = await new GreptimeClient(config).anchorCoverage({ now: NOW });
		expect(coverage.newestAnchoredHour).toBeNull();
		expect(coverage.lagHours).toBeNull();
		expect(coverage.more).toBe(true);
		expect(coverage.uncoveredHours).toHaveLength(COVERAGE_MAX_UNCOVERED);
		expect(coverage.uncoveredHours[0]).toBe(new Date(H - 48 * HOUR).toISOString());
		expect(coverage.uncoveredHours.at(-1)).toBe(new Date(H - HOUR).toISOString());
		expect(coverage.lastArchiveWindow).toBeNull();
	});

	test("an hour that ended less than the lag ago is not eligible yet, so a fresh boundary never reads as a gap", async () => {
		stubCoverage({ anchoredHours: [H - 2 * HOUR], eventHours: [H - 2 * HOUR, H - HOUR] });
		// Two minutes into H: H-1 ended 2 min ago, inside INGEST_LAG_MS.
		const coverage = await new GreptimeClient(config).anchorCoverage({ now: H + 2 * 60_000 });
		expect(coverage.uncoveredHours).toEqual([]);
		expect(coverage.lagHours).toBe(2);
	});

	test("epochMsAnyUnit reads seconds, millis, micros, nanos and ISO text as the same instant", () => {
		const ms = Date.UTC(2026, 9, 13, 12);
		expect(epochMsAnyUnit(ms / 1000)).toBe(ms);
		expect(epochMsAnyUnit(ms)).toBe(ms);
		expect(epochMsAnyUnit(ms * 1000)).toBe(ms);
		expect(epochMsAnyUnit(ms * 1_000_000)).toBe(ms);
		expect(epochMsAnyUnit(new Date(ms).toISOString())).toBe(ms);
		expect(epochMsAnyUnit(null)).toBeNaN();
		expect(epochMsAnyUnit("soon")).toBeNaN();
	});
});

describe("exportWindow (uplift-3 N6)", () => {
	const T1 = Date.UTC(2026, 9, 12, 10, 0, 0, 500);
	const T2 = T1 + 1;
	const T3 = T1 + 60_000;
	const FROM = "2026-10-12T00:00:00.000Z";
	const TO = "2026-10-13T00:00:00.000Z";
	/** The injected clock: the first ingest read starts here, so a record stamped after it arrived during the export. */
	const CLOCK = Date.UTC(2026, 9, 13, 3, 30);
	/** Five events in `(ts, id)` order with a three-way tie on `ts`, as the server would store them. */
	const EVENTS: Array<{ ts: number; id: string }> = [
		{ ts: T1, id: "evt_a" },
		{ ts: T1, id: "evt_b" },
		{ ts: T1, id: "evt_c" },
		{ ts: T2, id: "evt_d" },
		{ ts: T3, id: "evt_e" },
	];
	const eventRow = (event: { ts: number; id: string }): unknown[] =>
		EVENT_COLUMNS.map((column) => (column === "ts" ? event.ts : column === "id" ? event.id : column === "hash" ? "f".repeat(64) : null));

	/**
	 * A server that honours the keyset predicates and the LIMITs, so paging is exercised rather than
	 * scripted. `filler` adds that many other events' ingest records, all inside the window and all
	 * ingested before the page's events, so the day's ingest read needs several pages. `noRecord` are
	 * events with no ingest record at all (evt_c, a legacy row, by default); `late` are events whose
	 * record the bulk scan does not return but a lookup by id does — stored after the scan ran.
	 */
	function stubWindow(options: { filler?: number; noRecord?: string[]; late?: string[] } = {}): { sql: string[]; served: string[] } {
		const { filler = 0, noRecord = ["evt_c"], late = [] } = options;
		/** Every ingest row the fake returned, as `id@ingested_at`, across all statements. */
		const served: string[] = [];
		const { sql } = stubFetch((statement) => {
			if (statement.includes('FROM "agent_events"')) {
				const after = /\("ts" > '([^']+)' OR \("ts" = '([^']+)' AND "id" > '([^']+)'\)\)/.exec(statement);
				const limit = Number(/LIMIT (\d+)/.exec(statement)?.[1]);
				const rows = EVENTS.filter((event) => {
					if (!after) return true;
					const ts = Date.parse(after[1] ?? "");
					return event.ts > ts || (event.ts === ts && event.id > (after[3] ?? ""));
				}).slice(0, limit);
				return records([...EVENT_COLUMNS], rows.map(eventRow));
			}
			if (statement.includes('FROM "event_ingest"')) {
				// evt_c has no ingest record (a legacy row); evt_a has a retry one second
				// later; evt_e carries a collector-supplied `ts` a day after it was ingested.
				const rows: Array<[string, number, number]> = EVENTS.filter((event) => !noRecord.includes(event.id)).map((event) => [
					event.id,
					event.id === "evt_e" ? event.ts - 86_400_000 : late.includes(event.id) ? CLOCK + 1_000 : event.ts + 100,
					event.ts,
				]);
				rows.push(["evt_a", T1 + 1_100, T1]);
				// Pairs of fillers share an ingest millisecond, so a page boundary can fall inside a tie.
				for (let i = 0; i < filler; i++) rows.push([`fill_${String(i).padStart(4, "0")}`, T1 - 10_000_000 + Math.floor(i / 2), T1]);
				const tsBound = /"event_ts" >= '([^']+)' AND "event_ts" < '([^']+)'/.exec(statement);
				const cursor = /\("ingested_at" > '([^']+)' OR \("ingested_at" = '([^']+)' AND "event_id" > '([^']+)'\)\)/.exec(statement);
				const inList = /"event_id" IN \(([^)]*)\)/.exec(statement);
				const sinceMatch = /"ingested_at" >= '([^']+)'/.exec(statement);
				const since = sinceMatch ? Date.parse(sinceMatch[1] ?? "") : null;
				const wanted = inList ? [...(inList[1] ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1]) : null;
				const limit = Number(/LIMIT (\d+)/.exec(statement)?.[1] ?? "100000");
				const selected = rows
					// A late record is not there yet for the bulk scan, only for a lookup by id.
					.filter(([id]) => wanted !== null || !late.includes(id))
					.filter(([id]) => wanted === null || wanted.includes(id))
					.filter(([, ingestedAt]) => since === null || ingestedAt >= since)
					.filter(([, , eventTs]) => !tsBound || (eventTs >= Date.parse(tsBound[1] ?? "") && eventTs < Date.parse(tsBound[2] ?? "")))
					.filter(([id, ingestedAt]) => {
						if (!cursor) return true;
						const at = Date.parse(cursor[1] ?? "");
						return ingestedAt > at || (ingestedAt === at && id > (cursor[3] ?? ""));
					})
					.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
					.slice(0, limit);
				for (const [id, ingestedAt] of selected) served.push(`${id}@${ingestedAt}`);
				return records(["event_id", "ingested_at", "event_ts"], selected);
			}
			if (statement.includes('FROM "anchors"')) {
				const hour = Date.UTC(2026, 9, 12, 10);
				return records(
					["period_start", "period_end", "root", "event_count", "memo", "tx_sig", "signer", "cluster", "slot", "anchored_at", "stale_hashes"],
					[[hour, hour + 3_600_000, "a".repeat(64), 5, "memo", "sig", "signer", "devnet", 1, hour + 3_900_000, null]],
				);
			}
			return defaultReply(statement);
		});
		return { sql, served };
	}

	test("keyset pages return every row exactly once across a tie on ts, and the continuation round-trips", async () => {
		const { sql } = stubWindow();
		const client = new GreptimeClient(config);
		const seen: string[] = [];
		let after: { ts: string; id: string } | undefined;
		let pages = 0;
		for (;;) {
			const page = await client.exportWindow({ from: FROM, to: TO, after, limit: 2 });
			pages++;
			seen.push(...page.events.map((row) => String(row.id)));
			expect(page.anchors).toHaveLength(1);
			if (page.next === null) break;
			// The token is the page's last row, as JSON would carry it.
			after = JSON.parse(JSON.stringify(page.next)) as { ts: string; id: string };
		}
		expect(seen).toEqual(["evt_a", "evt_b", "evt_c", "evt_d", "evt_e"]);
		expect(pages).toBe(3);
		const reads = sql.filter((s) => s.includes('FROM "agent_events"'));
		expect(reads[0]).not.toContain("OR (");
		expect(reads[1]).toContain(`("ts" > '${new Date(T1).toISOString()}' OR ("ts" = '${new Date(T1).toISOString()}' AND "id" > 'evt_b'))`);
		for (const statement of reads) {
			expect(statement).toContain(`"ts" >= '${FROM}'`);
			expect(statement).toContain(`"ts" < '${TO}'`);
			expect(statement).toContain('ORDER BY "ts" ASC, "id" ASC LIMIT 2');
			expect(statement).not.toContain("OFFSET");
		}
		for (const statement of sql) assertAppendOnly(statement);
	});

	test("carries each event's first ingest record by id with no ingested_at bound, so a future-stamped event keeps its record, and omits events without one", async () => {
		const { sql } = stubWindow();
		const page = await new GreptimeClient(config).exportWindow({ from: FROM, to: TO, limit: 10 });
		expect(page.next).toBeNull();
		expect(page.ingest.map((row) => row.event_id)).toEqual(["evt_a", "evt_b", "evt_d", "evt_e"]);
		// The retry record did not move evt_a: the first one counts.
		expect(page.ingest[0]?.ingested_at).toBe(new Date(T1 + 100).toISOString());
		// evt_e was ingested a day before its `ts`: its record is on the page, with that stamp.
		expect(page.ingest[3]).toEqual({ event_id: "evt_e", ingested_at: new Date(T3 - 86_400_000).toISOString(), event_ts: new Date(T3).toISOString() });
		const ingest = sql.filter((s) => s.includes('FROM "event_ingest"'));
		// The bulk read, then one bounded lookup for evt_c, which it did not return.
		expect(ingest).toHaveLength(2);
		// The window is bounded on `event_ts` (the event's own `ts`); nothing bounds `ingested_at`, and there is no per-id IN scan.
		expect(ingest[0]).toContain(`"event_ts" >= '${FROM}' AND "event_ts" < '${TO}'`);
		expect(ingest[0]?.split("WHERE")[1]).not.toContain('"ingested_at" >=');
		expect(ingest[0]).not.toContain('"event_id" IN (');
		expect(ingest[1]).toContain('"event_id" IN (');
		expect(ingest[1]).toContain("'evt_c'");
		expect(ingest[0]).toContain('ORDER BY "ingested_at" ASC, "event_id" ASC LIMIT 500');
		expect(() => assertAppendOnly(ingest[0] ?? "")).not.toThrow();
	});

	test("reads the day's ingest records once for all event pages, not once per page, and pages them through a keyset cursor on the time index", async () => {
		// 1100 earlier records of other events in the window: three ingest pages of 500, 500 and 100.
		const { sql, served } = stubWindow({ filler: 1100 });
		const client = new GreptimeClient(config);
		const perPage: string[][] = [];
		let after: { ts: string; id: string } | undefined;
		for (;;) {
			const page = await client.exportWindow({ from: FROM, to: TO, after, limit: 2 });
			perPage.push(page.ingest.map((row) => row.event_id));
			if (page.next === null) break;
			after = page.next;
		}
		expect(perPage).toEqual([["evt_a", "evt_b"], ["evt_d"], ["evt_e"]]);
		const ingest = sql.filter((s) => s.includes('FROM "event_ingest"'));
		// Three bulk pages of 500, 500 and 100; page two of events adds one lookup for evt_c, which has no record.
		expect(ingest).toHaveLength(4);
		expect(ingest[0]).not.toContain("OR (");
		// evt_e was ingested a day before its `ts`, so it opens page one and the 500th row is fill_0498.
		// fill_0498 and fill_0499 share an ingest millisecond: the page boundary splits the tie, and the
		// cursor's `= AND event_id >` half must pick fill_0499 up on page two.
		expect(ingest[1]).toMatch(/\("ingested_at" > '[^']+' OR \("ingested_at" = '[^']+' AND "event_id" > 'fill_0498'\)\)/);
		// Every row in the window was served exactly once across the three pages: none skipped, none repeated.
		expect(served).toHaveLength(1105);
		expect(new Set(served).size).toBe(1105);
		for (const statement of ingest) assertAppendOnly(statement);

		// A fresh export of the same window starts again from its first page: the map is re-read, never trusted across runs.
		await client.exportWindow({ from: FROM, to: TO, limit: 10 });
		// The three bulk pages, plus one lookup for evt_c — a legacy row with no record anywhere.
		expect(sql.filter((s) => s.includes('"event_id" IN ('))).toHaveLength(2);
		expect(sql.filter((s) => s.includes('FROM "event_ingest"'))).toHaveLength(8);
	});

	test("an event whose ingest record was stored after the day's map was built is found by the bounded fallback lookup, not counted as missing", async () => {
		// evt_d's record lands after page one built the map: the bulk scan never returns it, an id lookup does.
		const { sql } = stubWindow({ noRecord: [], late: ["evt_d"] });
		const client = new GreptimeClient(config, { clock: () => CLOCK });
		const first = await client.exportWindow({ from: FROM, to: TO, limit: 2 });
		expect(first.ingest.map((row) => row.event_id)).toEqual(["evt_a", "evt_b"]);
		expect(sql.filter((s) => s.includes('FROM "event_ingest"'))).toHaveLength(1);
		const second = await client.exportWindow({ from: FROM, to: TO, after: first.next ?? undefined, limit: 2 });
		// Both events on page two have a record; without the fallback evt_d would be absent and count as `ingestMissing`.
		expect(second.ingest.map((row) => row.event_id)).toEqual(["evt_c", "evt_d"]);
		const lookups = sql.filter((s) => s.includes('FROM "event_ingest"') && s.includes('"event_id" IN ('));
		expect(lookups).toHaveLength(1);
		// Only the id the map lacked, under the same `event_ts` window, and append-only.
		expect(lookups[0]).toContain("'evt_d'");
		expect(lookups[0]).not.toContain("'evt_c'");
		expect(lookups[0]).toContain(`"event_ts" >= '${FROM}' AND "event_ts" < '${TO}'`);
		assertAppendOnly(lookups[0] ?? "");
		// The merged record is cached: a later page naming evt_d again would not look it up twice.
		const third = await client.exportWindow({ from: FROM, to: TO, after: second.next ?? undefined, limit: 2 });
		expect(third.ingest.map((row) => row.event_id)).toEqual(["evt_e"]);
		expect(sql.filter((s) => s.includes('"event_id" IN ('))).toHaveLength(1);
	});

	test("an id still absent after the fallback lookup stays missing", async () => {
		const { sql } = stubWindow({ noRecord: ["evt_c"] });
		const client = new GreptimeClient(config);
		const first = await client.exportWindow({ from: FROM, to: TO, limit: 2 });
		const second = await client.exportWindow({ from: FROM, to: TO, after: first.next ?? undefined, limit: 2 });
		expect(second.ingest.map((row) => row.event_id)).toEqual(["evt_d"]);
		const lookups = sql.filter((s) => s.includes('"event_id" IN ('));
		expect(lookups).toHaveLength(1);
		expect(lookups[0]).toContain("'evt_c'");
		expect(lookups[0]).not.toContain("'evt_d'");
	});

	test("no fallback lookup is issued when every id on the page is already in the map", async () => {
		const { sql } = stubWindow({ noRecord: [] });
		const client = new GreptimeClient(config);
		let after: { ts: string; id: string } | undefined;
		for (;;) {
			const page = await client.exportWindow({ from: FROM, to: TO, after, limit: 2 });
			if (page.next === null) break;
			after = page.next;
		}
		const ingest = sql.filter((s) => s.includes('FROM "event_ingest"'));
		expect(ingest).toHaveLength(1);
		expect(ingest[0]).not.toContain('"event_id" IN (');
	});

	test("the fallback lookup is bounded on the time index: ingested_at from the first read less the skew margin, so old history is never searched", async () => {
		const { sql } = stubWindow({ noRecord: ["evt_c"] });
		const client = new GreptimeClient(config, { clock: () => CLOCK });
		await client.exportWindow({ from: FROM, to: TO, limit: 10 });
		const lookups = sql.filter((s) => s.includes('"event_id" IN ('));
		expect(lookups).toHaveLength(1);
		expect(lookups[0]).toContain(`"ingested_at" >= '${new Date(CLOCK - EXPORT_INGEST_SKEW_MS).toISOString()}'`);
		expect(lookups[0]).toContain(`"event_ts" >= '${FROM}' AND "event_ts" < '${TO}'`);
		assertAppendOnly(lookups[0] ?? "");
	});

	test("a record that lands after the first read is still found; a legacy event with no row costs one bounded lookup per page and never an unbounded one", async () => {
		// evt_d's record is stamped after the first read; evt_c is a legacy event with no ingest row at all.
		const { sql } = stubWindow({ noRecord: ["evt_c"], late: ["evt_d"] });
		const client = new GreptimeClient(config, { clock: () => CLOCK });
		const first = await client.exportWindow({ from: FROM, to: TO, limit: 2 });
		const second = await client.exportWindow({ from: FROM, to: TO, after: first.next ?? undefined, limit: 2 });
		expect(second.ingest.map((row) => row.event_id)).toEqual(["evt_d"]);
		const lookups = sql.filter((s) => s.includes('"event_id" IN ('));
		// One lookup for the page that held evt_c and evt_d, naming both ids; every lookup carries the lower bound.
		expect(lookups).toHaveLength(1);
		expect(lookups[0]).toContain("'evt_c'");
		expect(lookups[0]).toContain("'evt_d'");
		for (const statement of lookups) expect(statement).toContain('"ingested_at" >= ');
		// The page after it holds only evt_e, in the map: nothing more is searched, and evt_c is not looked up again.
		const third = await client.exportWindow({ from: FROM, to: TO, after: second.next ?? undefined, limit: 2 });
		expect(third.ingest.map((row) => row.event_id)).toEqual(["evt_e"]);
		expect(sql.filter((s) => s.includes('"event_id" IN ('))).toHaveLength(1);
	});

	test("refuses a window that is not two ISO instants in order", async () => {
		stubWindow();
		const client = new GreptimeClient(config);
		await expect(client.exportWindow({ from: TO, to: FROM })).rejects.toThrow("from < to");
		await expect(client.exportWindow({ from: "yesterday", to: TO })).rejects.toThrow("ISO");
	});
});

describe("metric_samples (uplift-4 S6)", () => {
	const NOW = 1_790_000_000_000;
	const row = (over: Partial<MetricSampleRow> = {}): MetricSampleRow => ({
		tsMs: NOW,
		series: "brief.p95",
		labels: { surface: "grok-bot" },
		value: 41.5,
		count: 12,
		...over,
	});
	const creates = (sql: string[]): string[] => sql.filter((statement) => statement.startsWith(`CREATE TABLE IF NOT EXISTS "${METRIC_SAMPLES_TABLE}"`));
	const inserts = (sql: string[]): string[] => sql.filter((statement) => statement.startsWith(`INSERT INTO "${METRIC_SAMPLES_TABLE}"`));

	test("the table is created on first use only, with append_mode and the TTL in the CREATE", async () => {
		const { sql } = stubFetch();
		const client = new GreptimeClient(config);
		expect(await client.recordMetricSamples([row()])).toEqual({ stored: 1, drops: {} });
		expect(await client.recordMetricSamples([row({ tsMs: NOW + 60_000 })])).toEqual({ stored: 1, drops: {} });

		expect(creates(sql)).toHaveLength(1);
		const create = creates(sql)[0]!;
		expect(create).toContain("WITH ('append_mode' = 'true', 'ttl' = '14d')");
		for (const column of ['"ts" TIMESTAMP TIME INDEX', '"series" STRING', '"labels" STRING', '"kind" STRING', '"value" DOUBLE', '"count" BIGINT']) {
			expect(create).toContain(column);
		}
		// `create` is already an allowed verb and the TTL needs no ALTER, so the append-only guard is untouched.
		expect(() => assertAppendOnly(create)).not.toThrow();
		expect(sql.some((statement) => /^ALTER/i.test(statement))).toBe(false);
		expect(inserts(sql)).toHaveLength(2);
		for (const statement of inserts(sql)) expect(() => assertAppendOnly(statement)).not.toThrow();
	});

	test("a configured TTL goes into the CREATE; a hostile one is refused before anything is sent", async () => {
		const accepted = stubFetch();
		await new GreptimeClient(config).recordMetricSamples([row()], "30d");
		expect(creates(accepted.sql)[0]).toContain("'ttl' = '30d'");

		for (const ttl of ["14d'); DROP TABLE metric_samples; --", "14d', 'append_mode' = 'false", "999d", "0d", "14 d", "1h", "", "forever", "14d; SELECT 1"]) {
			const refused = stubFetch();
			const result = await new GreptimeClient(config).recordMetricSamples([row(), row()], ttl);
			expect(result).toEqual({ stored: 0, drops: { ddl: 2 } });
			expect(refused.sql).toEqual([]);
		}
	});

	test("one multi-row INSERT per batch, every value a literal, the kind taken from the series", async () => {
		const { sql } = stubFetch();
		await new GreptimeClient(config).recordMetricSamples([
			row(),
			row({ series: "emit.success", labels: {}, value: 0.9, count: 10 }),
			row({ series: "admission.decisions", labels: { decision: "allowed" }, value: 3, count: 3 }),
		]);
		const statement = inserts(sql)[0]!;
		expect(inserts(sql)).toHaveLength(1);
		expect(statement).toContain('("ts", "series", "labels", "kind", "value", "count") VALUES ');
		expect(statement.match(/\), \(/g)).toHaveLength(2);
		expect(statement).toContain(`('${new Date(NOW).toISOString()}', 'brief.p95', '{"surface":"grok-bot"}', 'histogram', 41.5, 12)`);
		expect(statement).toContain("'emit.success', '{}', 'ratio', 0.9, 10)");
		expect(statement).toContain("'admission.decisions', '{\"decision\":\"allowed\"}', 'counter', 3, 3)");
	});

	test("an extended series (uplift-5 S6) is stored with its own kind and labels, and a label outside its closed set is still invalid", async () => {
		const { sql } = stubFetch();
		const result = await new GreptimeClient(config).recordMetricSamples([
			row({ series: "cache.operations", labels: { result: "would_serve_stale" }, value: 4, count: 4 }),
			row({ series: "hindsight.outbox_size", labels: {}, value: 7, count: 1 }),
			row({ series: "memory.expired", labels: { mode: "served" }, value: 2, count: 2 }),
			row({ series: "cache.operations", labels: { result: "x'); DROP TABLE metric_samples; --" } }),
			row({ series: "cache.operations", labels: { mode: "served" } }),
		]);
		expect(result).toEqual({ stored: 3, drops: { invalid: 2 } });
		const statement = inserts(sql)[0]!;
		expect(statement).toContain("'cache.operations', '{\"result\":\"would_serve_stale\"}', 'counter', 4, 4)");
		expect(statement).toContain("'hindsight.outbox_size', '{}', 'gauge', 7, 1)");
		expect(statement).toContain("'memory.expired', '{\"mode\":\"served\"}', 'counter', 2, 2)");
		expect(statement).not.toContain("DROP");
	});

	test("hostile series and label text cannot reach the statement: those rows are dropped as invalid", async () => {
		const hostile = [
			row({ series: "brief.p95', 1, 1); DROP TABLE metric_samples; --" }),
			row({ series: "nope" }),
			row({ series: "__proto__" }),
			row({ labels: { surface: "x'); DROP TABLE metric_samples; --" } }),
			row({ labels: { surface: "back\\slash'" } }),
			row({ labels: { surface: "grok-bot", extra: "x" } }),
			row({ labels: {} }),
		];
		const onlyHostile = stubFetch();
		const client = new GreptimeClient(config);
		expect(await client.recordMetricSamples(hostile)).toEqual({ stored: 0, drops: { invalid: hostile.length } });
		expect(onlyHostile.sql).toEqual([]);

		const mixed = stubFetch();
		const result = await new GreptimeClient(config).recordMetricSamples([...hostile, row()]);
		expect(result).toEqual({ stored: 1, drops: { invalid: hostile.length } });
		const statement = inserts(mixed.sql)[0]!;
		expect(statement).not.toContain("DROP");
		expect(statement).not.toContain("nope");
		expect(statement).not.toContain("slash");
	});

	test("numbers the columns cannot hold are dropped as invalid", async () => {
		const { sql } = stubFetch();
		const result = await new GreptimeClient(config).recordMetricSamples([
			row({ value: Number.NaN }),
			row({ value: Number.POSITIVE_INFINITY }),
			row({ count: -1 }),
			row({ count: 1.5 }),
			row({ tsMs: Number.NaN }),
			row({ tsMs: 0 }),
			row({ tsMs: 9e15 }),
		]);
		expect(result).toEqual({ stored: 0, drops: { invalid: 7 } });
		expect(sql).toEqual([]);
	});

	test("a batch is capped at 200 rows; the rest are counted, not sent", async () => {
		const { sql } = stubFetch();
		const rows = Array.from({ length: MAX_METRIC_BATCH + 50 }, (_, i) => row({ tsMs: NOW + i }));
		const result = await new GreptimeClient(config).recordMetricSamples(rows);
		expect(result).toEqual({ stored: MAX_METRIC_BATCH, drops: { capped: 50 } });
		expect(inserts(sql)[0]!.match(/\), \(/g)).toHaveLength(MAX_METRIC_BATCH - 1);
	});

	test("Greptime down: the batch is dropped with a counted reason and nothing throws", async () => {
		globalThis.fetch = (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch;
		const result = await new GreptimeClient(config).recordMetricSamples([row(), row()]);
		expect(result).toEqual({ stored: 0, drops: { unavailable: 2 } });

		stubFetch(() => new Response("bad gateway", { status: 502 }));
		expect(await new GreptimeClient(config).recordMetricSamples([row()])).toEqual({ stored: 0, drops: { unavailable: 1 } });
	});

	test("a refused statement is a counted reason by stage, and a failed CREATE is retried on the next call", async () => {
		let creating = true;
		const { sql } = stubFetch((statement) => {
			if (statement.startsWith('CREATE TABLE IF NOT EXISTS "metric_samples"') && creating) return { error: "unsupported option" };
			if (statement.startsWith('INSERT INTO "metric_samples"')) return { error: "column count mismatch" };
			return defaultReply(statement);
		});
		const client = new GreptimeClient(config);
		expect(await client.recordMetricSamples([row()])).toEqual({ stored: 0, drops: { ddl: 1 } });
		creating = false;
		expect(await client.recordMetricSamples([row(), row()])).toEqual({ stored: 0, drops: { rejected: 2 } });
		expect(creates(sql)).toHaveLength(2);
		// Created now: the next batch goes straight to the INSERT.
		await client.recordMetricSamples([row()]);
		expect(creates(sql)).toHaveLength(2);
	});

	test("an existing table without append_mode is not ready: nothing is inserted, the drop is `schema`, one line names the operator action, and a recreated table is picked up", async () => {
		let appendMode = false;
		const { sql } = stubFetch((statement) => {
			if (statement.includes('SHOW CREATE TABLE "metric_samples"')) {
				return records(["Table", "Create Table"], [["metric_samples", appendMode ? "... WITH( append_mode = 'true' )" : "... WITH( ttl = '14d' )"]]);
			}
			return defaultReply(statement);
		});
		const written: string[] = [];
		const realWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const client = new GreptimeClient(config);
			expect(await client.recordMetricSamples([row(), row()])).toEqual({ stored: 0, drops: { schema: 2 } });
			expect(await client.recordMetricSamples([row()])).toEqual({ stored: 0, drops: { schema: 1 } });
			expect(inserts(sql)).toHaveLength(0);
			// One named line, however many ticks, and it says what the operator must do (the client never drops).
			const lines = written.filter((line) => line.includes("metric_samples"));
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("append_mode");
			expect(lines[0]).toContain("drop and recreate");
			expect(sql.some((statement) => /^(DROP|ALTER)/i.test(statement))).toBe(false);

			// The operator recreates it: the next sample re-asks and writes.
			appendMode = true;
			expect(await client.recordMetricSamples([row()])).toEqual({ stored: 1, drops: {} });
			expect(inserts(sql)).toHaveLength(1);
		} finally {
			process.stderr.write = realWrite;
		}
	});

	test("a table whose options cannot be read is not ready either: a counted ddl drop, retried next tick", async () => {
		const { sql } = stubFetch((statement) => (statement.includes('SHOW CREATE TABLE "metric_samples"') ? affected : defaultReply(statement)));
		expect(await new GreptimeClient(config).recordMetricSamples([row()])).toEqual({ stored: 0, drops: { ddl: 1 } });
		expect(inserts(sql)).toHaveLength(0);
	});

	test("an open breaker drops the batch as breaker_open without touching the network; a timeout is a breaker failure", async () => {
		const samples: PlaneSample[] = [];
		const breaker = new CircuitBreaker("greptime", { failureThreshold: 2, openMs: 30_000 }, () => 0);
		const gate: PlaneGate = { plane: "greptime", breaker, observe: (sample) => samples.push(sample) };
		let fetches = 0;
		globalThis.fetch = (() => {
			fetches += 1;
			return Promise.reject(new DOMException("timed out", "TimeoutError"));
		}) as unknown as typeof fetch;
		const client = new GreptimeClient(config, { gate });

		expect(await client.recordMetricSamples([row()])).toEqual({ stored: 0, drops: { unavailable: 1 } });
		expect(await client.recordMetricSamples([row()])).toEqual({ stored: 0, drops: { unavailable: 1 } });
		expect(samples.map((sample) => sample.outcome)).toEqual(["timeout", "timeout"]);
		expect(breaker.state()).toBe("open");

		const before = fetches;
		const started = performance.now();
		expect(await client.recordMetricSamples([row(), row(), row()])).toEqual({ stored: 0, drops: { breaker_open: 3 } });
		expect(fetches).toBe(before);
		expect(performance.now() - started).toBeLessThan(50);
		expect(new GreptimeBreakerOpen("x")).toBeInstanceOf(GreptimeUnavailable);
	});

	test("the write carries a deadline inside the gated call", async () => {
		let signal: AbortSignal | null | undefined;
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			signal ??= init.signal;
			return new Response(JSON.stringify(affected), { status: 200 });
		}) as unknown as typeof fetch;
		await new GreptimeClient(config).recordMetricSamples([row()]);
		expect(signal).toBeInstanceOf(AbortSignal);
	});

	test("flag-off parity: nothing in boot or the ledger's own paths creates or touches metric_samples", async () => {
		const { sql } = stubFetch((statement) => {
			if (statement.includes("SHOW CREATE TABLE")) return records(["Table", "Create Table"], [["agent_events", "... WITH( append_mode = 'true' )"]]);
			return defaultReply(statement);
		});
		const client = new GreptimeClient(config);
		await client.migrate();
		await client.insertEvent(normalizeEvent(input, null));
		await client.probeWritable(1000);
		expect(sql.length).toBeGreaterThan(5);
		expect(sql.some((statement) => statement.includes(METRIC_SAMPLES_TABLE))).toBe(false);
	});

	describe("readMetricHistory", () => {
		const TO = NOW;
		const reply = (statement: string): unknown => {
			if (!statement.includes("date_bin")) return defaultReply(statement);
			return records(
				["bucket", "labels", "value", "count"],
				[
					[TO - 60_000, '{"surface":"grok-bot"}', 55, 3],
					[TO - 120_000, '{"surface":"https://internal.example","extra":1}', "7", 2],
					[TO - 180_000, null, null, 1],
				],
			);
		};
		const select = (sql: string[]): string => sql.find((statement) => statement.includes("date_bin")) ?? "";

		test("a bounded, ordered, allow-listed query; points come back oldest first with only closed labels", async () => {
			const { sql } = stubFetch(reply);
			const { points } = await new GreptimeClient(config).readMetricHistory({ series: "brief.p95", fromMs: TO - 3_600_000, toMs: TO, stepS: 60 });
			const statement = select(sql);
			expect(() => assertAppendOnly(statement)).not.toThrow();
			expect(statement).toContain(`date_bin(INTERVAL '60 seconds', "ts") AS "bucket"`);
			expect(statement).toContain(`FROM "metric_samples" WHERE "series" = 'brief.p95'`);
			expect(statement).toContain(`"ts" >= '${new Date(TO - 3_600_000).toISOString()}' AND "ts" < '${new Date(TO).toISOString()}'`);
			expect(statement).toContain('MAX("value")');
			expect(statement).toContain(`GROUP BY "bucket", "labels" ORDER BY "bucket" DESC LIMIT ${MAX_METRIC_POINTS}`);
			expect(points).toEqual([
				{ tsMs: TO - 180_000, labels: {}, value: null, count: 1 },
				{ tsMs: TO - 120_000, labels: {}, value: 7, count: 2 },
				{ tsMs: TO - 60_000, labels: { surface: "grok-bot" }, value: 55, count: 3 },
			]);
		});

		test("the window is capped at the TTL and the step raised until the window fits the point cap", async () => {
			const { sql } = stubFetch(reply);
			const client = new GreptimeClient(config);
			const result = await client.readMetricHistory({ series: "emit.p95", fromMs: TO - 90 * 86_400_000, toMs: TO, stepS: 60 });
			const statement = select(sql);
			expect(statement).toContain(`"ts" >= '${new Date(TO - 14 * 86_400_000).toISOString()}'`);
			// An unlabelled series: (buckets + 1) <= 2000, so 14 days / 1999 buckets = 605.8 s, rounded up.
			expect(statement).toContain("INTERVAL '606 seconds'");
			expect(result.stepS).toBe(606);

			const seven = stubFetch(reply);
			await client.readMetricHistory({ series: "emit.p95", fromMs: TO - 90 * 86_400_000, toMs: TO, stepS: 60, ttl: "7d" });
			expect(select(seven.sql)).toContain(`"ts" >= '${new Date(TO - 7 * 86_400_000).toISOString()}'`);
		});

		test("each series is folded by its own rule", async () => {
			const folds: Array<[string, string]> = [
				["admission.decisions", 'SUM("value") AS "value"'],
				["emit.success", 'SUM("value" * "count") / SUM("count") AS "value"'],
				["brief.p50", 'AVG("value") AS "value"'],
				["docs.p95", 'MAX("value") AS "value"'],
			];
			for (const [series, expression] of folds) {
				const { sql } = stubFetch(reply);
				await new GreptimeClient(config).readMetricHistory({ series, fromMs: TO - 3_600_000, toMs: TO, stepS: 60 });
				expect(select(sql)).toContain(expression);
			}
		});

		test("no SQL from input: a series outside the allow-list, a hostile TTL or a bad window never reaches the network", async () => {
			const { sql } = stubFetch(reply);
			const client = new GreptimeClient(config);
			for (const series of ["", "nope", "__proto__", "constructor", "brief.p95' OR '1'='1", 'agent_events"; DROP TABLE x; --']) {
				await expect(client.readMetricHistory({ series, fromMs: TO - 1000, toMs: TO, stepS: 60 })).rejects.toBeInstanceOf(MetricHistoryInputError);
			}
			await expect(client.readMetricHistory({ series: "brief.p95", fromMs: TO - 1000, toMs: TO, stepS: 60, ttl: "14d'); DROP TABLE x; --" })).rejects.toBeInstanceOf(
				MetricHistoryInputError,
			);
			await expect(client.readMetricHistory({ series: "brief.p95", fromMs: TO, toMs: TO, stepS: 60 })).rejects.toBeInstanceOf(MetricHistoryInputError);
			await expect(client.readMetricHistory({ series: "brief.p95", fromMs: Number.NaN, toMs: TO, stepS: 60 })).rejects.toBeInstanceOf(MetricHistoryInputError);
			await expect(client.readMetricHistory({ series: "brief.p95", fromMs: TO - 1000, toMs: TO, stepS: Number.NaN })).rejects.toBeInstanceOf(MetricHistoryInputError);
			expect(sql).toEqual([]);
		});

		test("an unreachable store is a GreptimeUnavailable the route turns into a 503", async () => {
			globalThis.fetch = (() => Promise.reject(new Error("connect ECONNREFUSED"))) as unknown as typeof fetch;
			await expect(new GreptimeClient(config).readMetricHistory({ series: "brief.p95", fromMs: TO - 1000, toMs: TO, stepS: 60 })).rejects.toBeInstanceOf(
				GreptimeUnavailable,
			);
		});

		test("a read never runs DDL, creates nothing and sends no probe: it is one SELECT", async () => {
			const { sql } = stubFetch(reply);
			await new GreptimeClient(config).readMetricHistory({ series: "emit.success", fromMs: TO - 3_600_000, toMs: TO, stepS: 60 });
			expect(sql).toHaveLength(1);
			expect(sql[0]).toMatch(/^SELECT /);
			expect(sql.some((statement) => /^(CREATE|ALTER|DROP|INSERT)/i.test(statement) || statement.includes("LENGTH"))).toBe(false);
		});

		test("a table that does not exist yet is an empty history, with the step reported; any other error is still an error", async () => {
			for (const message of ["Table not found: greptime.public.metric_samples", "Failed to plan SQL: Table not found: metric_samples (code 4001)"]) {
				stubFetch(() => ({ error: message }));
				expect(await new GreptimeClient(config).readMetricHistory({ series: "emit.success", fromMs: TO - 3_600_000, toMs: TO, stepS: 60 })).toEqual({
					points: [],
					stepS: 60,
				});
			}
			stubFetch(() => ({ error: "Invalid argument: unknown function date_bin" }));
			await expect(new GreptimeClient(config).readMetricHistory({ series: "emit.success", fromMs: TO - 3_600_000, toMs: TO, stepS: 60 })).rejects.toBeInstanceOf(
				GreptimeError,
			);
			// A store that is down is not an empty history either, even when its text mentions a table.
			stubFetch(() => new Response("table not found upstream", { status: 503 }));
			await expect(new GreptimeClient(config).readMetricHistory({ series: "emit.success", fromMs: TO - 3_600_000, toMs: TO, stepS: 60 })).rejects.toBeInstanceOf(
				GreptimeUnavailable,
			);
		});

		test("the read carries a deadline inside the gated call", async () => {
			let signal: AbortSignal | null | undefined;
			globalThis.fetch = (async (_url: string, init: RequestInit) => {
				signal ??= init.signal;
				return new Response(JSON.stringify(reply("date_bin")), { status: 200 });
			}) as unknown as typeof fetch;
			const samples: PlaneSample[] = [];
			const gate: PlaneGate = { plane: "greptime", breaker: new CircuitBreaker("greptime", { failureThreshold: 5, openMs: 1000 }, () => 0), observe: (sample) => samples.push(sample) };
			await new GreptimeClient(config, { gate }).readMetricHistory({ series: "emit.success", fromMs: TO - 3_600_000, toMs: TO, stepS: 60 });
			expect(signal).toBeInstanceOf(AbortSignal);
			expect(samples.map((sample) => sample.op)).toEqual(["history"]);
		});

		test("the effective step is returned, and a labelled series over a long window keeps its OLDEST bucket inside the point cap", async () => {
			const surfaces = [...METRIC_SERIES["brief.p95"]!.values!];
			expect(surfaces).toHaveLength(28);
			// A store holding a row for every surface in every bucket, answering the way the statement asks: newest first, cut at LIMIT.
			const store = (statement: string): unknown => {
				if (!statement.includes("date_bin")) return defaultReply(statement);
				const step = Number(/INTERVAL '(\d+) seconds'/.exec(statement)![1]);
				const [, from, to] = /"ts" >= '([^']+)' AND "ts" < '([^']+)'/.exec(statement)!;
				const limit = Number(/LIMIT (\d+)$/.exec(statement)![1]);
				const first = Math.floor(Date.parse(from!) / 1000 / step) * step * 1000;
				const buckets: number[] = [];
				for (let at = first; at < Date.parse(to!); at += step * 1000) buckets.push(at);
				const rows = buckets.reverse().flatMap((at) => surfaces.map((surface) => [at, JSON.stringify({ surface }), 10, 1]));
				return records(["bucket", "labels", "value", "count"], rows.slice(0, limit));
			};
			for (const days of [1, 14]) {
				const { sql } = stubFetch(store);
				const result = await new GreptimeClient(config).readMetricHistory({ series: "brief.p95", fromMs: TO - days * 86_400_000, toMs: TO, stepS: 60 });
				const step = Number(/INTERVAL '(\d+) seconds'/.exec(select(sql))![1]);
				expect(result.stepS).toBe(step);
				// Raised far above the 60 s asked for: one day is ~20 minutes, 14 days ~5 hours.
				expect(step).toBeGreaterThan(60);
				const oldestBucket = Math.floor((TO - days * 86_400_000) / 1000 / step) * step * 1000;
				expect(result.points[0]?.tsMs).toBe(oldestBucket);
				expect(result.points.length).toBeLessThanOrEqual(MAX_METRIC_POINTS);
				// Nothing was cut: every bucket of the window has all 28 surfaces.
				expect(result.points.length % 28).toBe(0);
				expect(new Set(result.points.map((point) => point.labels.surface)).size).toBe(28);
			}
			// The old rule (step raised only to window / 2000, ignoring labels) would have cut the oldest days: pin that the cap bites without the label term.
			const old = Math.ceil((14 * 86_400) / MAX_METRIC_POINTS);
			expect(Math.ceil((14 * 86_400) / old + 1) * 28).toBeGreaterThan(MAX_METRIC_POINTS);
		});
	});
});
