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
	EVENT_COLUMNS,
	GreptimeClient,
	GreptimeError,
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
	return statement.includes("LENGTH") ? records(["n"], [[3]]) : affected;
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
		expect(sql.at(-1)).toContain("'C:\\new'");
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
			return affected;
		});

		const { warnings } = await new GreptimeClient(config).migrate();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("append_mode");
	});

	test("warns rather than throwing when append_mode cannot be confirmed", async () => {
		stubFetch((statement) =>
			statement.includes("SHOW CREATE TABLE") ? new Response("nope", { status: 500 }) : affected,
		);
		const { warnings } = await new GreptimeClient(config).migrate();
		expect(warnings).toEqual(["could not confirm agent_events is in append_mode"]);
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

describe("reads", () => {
	test("lastHash takes the newest event in the session", async () => {
		const { sql } = stubFetch(() => records(["hash", "prev"], [["abc", "xyz"]]));
		expect(await new GreptimeClient(config).lastHash("sess-1")).toBe("abc");
		expect(sql[0]).toContain(`"session_id" = 'sess-1'`);
		expect(sql[0]).toContain('ORDER BY "ts" DESC');
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
