/**
 * The ledger client, against a mocked Greptime.
 *
 * Nothing here touches the network: `fetch` is replaced and every assertion is
 * about the SQL that would have gone over it. That is the part worth pinning —
 * Greptime's HTTP API has no bind parameters, so the statement this file builds
 * is the entire contract with an append-only store.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { normalizeEvent } from "./event.ts";
import {
	AppendOnlyViolation,
	assertAppendOnly,
	chainTip,
	DEFAULT_QUERY_LIMIT,
	EVENT_COLUMNS,
	GreptimeClient,
	GreptimeError,
	INGEST_LAG_MS,
	INGEST_BUDGET_MS,
	IngestNotRecorded,
	MAX_QUERY_LIMIT,
	queryLimit,
	quote,
} from "./greptime.ts";
import type { GreptimeConfig } from "./config.ts";
import type { EventInput } from "./types.ts";

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

		stubFetch(() => new Response("nope", { status: 500 }));
		await expect(client.sql("SELECT 1")).rejects.toThrow(/greptime 500/);

		stubFetch(() => ({ error: "table not found" }));
		await expect(client.sql("SELECT 1")).rejects.toThrow(/table not found/);

		stubFetch(() => new Response("<html>", { status: 200 }));
		await expect(client.sql("SELECT 1")).rejects.toThrow(/non-JSON/);
	});

	test("turns an unreachable host into a GreptimeError the caller can handle", async () => {
		globalThis.fetch = (() => Promise.reject(new Error("connect ETIMEDOUT"))) as unknown as typeof fetch;
		await expect(new GreptimeClient(config).sql("SELECT 1")).rejects.toThrow(GreptimeError);
	});

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
		expect(warnings.some((warning) => warning.includes("created without append_mode"))).toBe(true);
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

	test("lastHash reads the whole session, not a window of its newest rows", async () => {
		// The regression: `ts` is collector-supplied, and the Grok collector's backfill
		// pass appends events *older* than everything stored. A small window ordered by
		// `ts` would not hold the real chain tip, and the next append would chain onto a
		// hash that already had a successor — forking the session.
		const { sql } = stubFetch(() => records(["hash", "prev"], []));
		await new GreptimeClient(config).lastHash("sess-1");

		const limit = Number(sql[0]?.match(/LIMIT (\d+)/)?.[1]);
		expect(limit).toBeGreaterThanOrEqual(10_000);
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
			await new GreptimeClient(config, undefined, clock).insertEvent(event);
		} finally {
			process.stderr.write = original;
		}
		expect(written.join("")).toContain(event.id);
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
