import { describe, expect, test } from "bun:test";
import { normalizeEvent } from "./event.ts";
import { EVENT_COLUMNS, GreptimeClient, GreptimeError } from "./greptime.ts";
import type { EventInput } from "./types.ts";

type Row = Record<string, unknown>;

/** A GreptimeClient whose sql() records every statement and answers from canned rows. */
class RecordingGreptime extends GreptimeClient {
	readonly statements: string[] = [];

	constructor(private readonly answer: (statement: string) => Row[] = () => []) {
		super({ url: "http://greptime.test.invalid", user: undefined, password: undefined, db: "public" });
	}

	override async sql(statement: string): Promise<Row[]> {
		this.statements.push(statement.replace(/\s+/g, " ").trim());
		return this.answer(statement);
	}
}

const EVENT_COLUMN_ROWS: Row[] = EVENT_COLUMNS.filter((name) => name !== "ingested_at").map((name) => ({
	column_name: name,
	semantic_type: ["surface", "repo", "graph_id", "kind"].includes(name) ? "TAG" : name === "ts" ? "TIMESTAMP" : "FIELD",
	data_type: name === "ts" ? "timestamp(3)" : name === "step" ? "bigint" : "string",
}));
const INGESTED_AT_ROW: Row = { column_name: "ingested_at", semantic_type: "FIELD", data_type: "timestamp(3)" };
const OLD_ANCHOR_ROWS: Row[] = [
	{ column_name: "period_start", semantic_type: "TIMESTAMP", data_type: "timestamp(3)" },
	{ column_name: "period_end", semantic_type: "FIELD", data_type: "timestamp(3)" },
	{ column_name: "root", semantic_type: "TAG", data_type: "string" },
	{ column_name: "tx_sig", semantic_type: "FIELD", data_type: "string" },
	{ column_name: "event_count", semantic_type: "FIELD", data_type: "bigint" },
];
const NEW_ANCHOR_ROWS: Row[] = [
	{ column_name: "period_start", semantic_type: "TIMESTAMP", data_type: "timestamp(3)" },
	{ column_name: "root", semantic_type: "FIELD", data_type: "string" },
];

/** Canned information_schema and count(*) answers for migrate(). */
function schema(opts: { eventColumns: Row[]; anchorColumns: Row[]; anchorRows?: number }): (statement: string) => Row[] {
	return (statement) => {
		if (statement.includes("information_schema.columns")) {
			if (statement.includes("'agent_events'")) return opts.eventColumns;
			if (statement.includes("'anchors'")) return opts.anchorColumns;
		}
		if (statement.includes('count(*) AS "n" FROM "anchors"')) return [{ n: opts.anchorRows ?? 0 }];
		return [];
	};
}

const ALTER = 'ALTER TABLE "agent_events" ADD COLUMN "ingested_at" TIMESTAMP';
const isAnchorsCreate = (s: string) => s.startsWith('CREATE TABLE IF NOT EXISTS "anchors"');

describe("GreptimeClient.migrate", () => {
	test("adds ingested_at exactly once when information_schema shows it absent", async () => {
		const g = new RecordingGreptime(schema({ eventColumns: EVENT_COLUMN_ROWS, anchorColumns: NEW_ANCHOR_ROWS }));
		await g.migrate();
		expect(g.statements.filter((s) => s.startsWith("ALTER"))).toEqual([ALTER]);
		const lookup = g.statements.find((s) => s.includes("'agent_events'"));
		expect(lookup).toContain("information_schema.columns");
		expect(lookup).toContain(`"table_schema" = 'public'`);
		expect(g.statements.indexOf(ALTER)).toBeGreaterThan(g.statements.indexOf(lookup!));
	});

	test("sends no ALTER when the column is already there", async () => {
		const g = new RecordingGreptime(
			schema({ eventColumns: [...EVENT_COLUMN_ROWS, INGESTED_AT_ROW], anchorColumns: NEW_ANCHOR_ROWS }),
		);
		await g.migrate();
		expect(g.statements.some((s) => s.startsWith("ALTER"))).toBe(false);
	});

	test("a fresh database gets ingested_at from the agent_events CREATE itself", async () => {
		const g = new RecordingGreptime();
		await g.migrate();
		const create = g.statements.find((s) => s.startsWith('CREATE TABLE IF NOT EXISTS "agent_events"'));
		expect(create).toContain('"prev" STRING, "ingested_at" TIMESTAMP, PRIMARY KEY ("surface", "repo", "graph_id", "kind")');
	});

	test("an empty root-keyed anchors table is dropped before the period-keyed CREATE", async () => {
		const g = new RecordingGreptime(
			schema({ eventColumns: [...EVENT_COLUMN_ROWS, INGESTED_AT_ROW], anchorColumns: OLD_ANCHOR_ROWS, anchorRows: 0 }),
		);
		await g.migrate();
		const drop = g.statements.indexOf('DROP TABLE "anchors"');
		const create = g.statements.findIndex(isAnchorsCreate);
		expect(drop).toBeGreaterThan(-1);
		expect(create).toBeGreaterThan(drop);

		const ddl = g.statements[create]!;
		const columns = [...ddl.matchAll(/"(\w+)" (TIMESTAMP|STRING|BIGINT)/g)].map((m) => m[1]);
		expect(columns).toEqual([
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
		]);
		expect(ddl).toContain('"period_start" TIMESTAMP TIME INDEX');
		expect(ddl).not.toContain("PRIMARY KEY");
	});

	test("a root-keyed anchors table with rows is never dropped: migrate refuses", async () => {
		const g = new RecordingGreptime(
			schema({ eventColumns: [...EVENT_COLUMN_ROWS, INGESTED_AT_ROW], anchorColumns: OLD_ANCHOR_ROWS, anchorRows: 3 }),
		);
		const failure = await g.migrate().then(
			() => null,
			(cause: unknown) => cause,
		);
		expect(failure).toBeInstanceOf(GreptimeError);
		expect(String((failure as Error).message)).toContain("refusing to drop anchors");
		expect(String((failure as Error).message)).toContain("3 rows");
		expect(g.statements.some((s) => s.startsWith("DROP"))).toBe(false);
		expect(g.statements.some(isAnchorsCreate)).toBe(false);
	});

	test("anchors without a root TAG (new schema, or no table) is never dropped", async () => {
		for (const anchorColumns of [NEW_ANCHOR_ROWS, []]) {
			const g = new RecordingGreptime(schema({ eventColumns: [...EVENT_COLUMN_ROWS, INGESTED_AT_ROW], anchorColumns }));
			await g.migrate();
			expect(g.statements.some((s) => s.startsWith("DROP"))).toBe(false);
			expect(g.statements.some((s) => s.includes("count(*)"))).toBe(false);
			expect(g.statements.some(isAnchorsCreate)).toBe(true);
		}
	});
});

describe("GreptimeClient.columns", () => {
	test("maps information_schema rows to name, semantic and type", async () => {
		const g = new RecordingGreptime(() => [INGESTED_AT_ROW]);
		expect(await g.columns("agent_events")).toEqual([{ name: "ingested_at", semantic: "FIELD", type: "timestamp(3)" }]);
		expect(g.statements[0]).toBe(
			`SELECT "column_name", "semantic_type", "data_type" FROM information_schema.columns WHERE "table_schema" = 'public' AND "table_name" = 'agent_events' ORDER BY "ordinal_position"`,
		);
	});
});

const input: EventInput = { surface: "herdr", kind: "tool.call", summary: "it's a test", session_id: "s1", repo: "r" };

describe("GreptimeClient.insertEvents", () => {
	test("an empty batch sends nothing", async () => {
		const g = new RecordingGreptime();
		await g.insertEvents([]);
		expect(g.statements).toEqual([]);
	});

	test("three events go out as ONE INSERT naming the 17 columns with three tuples", async () => {
		const g = new RecordingGreptime();
		const a = normalizeEvent(input, null, "2026-09-27T12:00:00.001Z");
		const b = normalizeEvent({ ...input, graph_id: "ut-x", step: 4 }, a.hash, "2026-09-27T12:00:00.002Z");
		const legacy = normalizeEvent(input, null);
		await g.insertEvents([a, b, legacy]);

		expect(g.statements).toHaveLength(1);
		const statement = g.statements[0]!;
		const columnList = EVENT_COLUMNS.map((name) => `"${name}"`).join(", ");
		expect(EVENT_COLUMNS).toHaveLength(17);
		expect(statement.startsWith(`INSERT INTO "agent_events" (${columnList}) VALUES (`)).toBe(true);
		expect(statement.match(/\), \('/g)).toHaveLength(2);
		expect(statement).toContain(`'${a.hash}', NULL, '2026-09-27T12:00:00.001Z')`);
		expect(statement).toContain(`'${b.hash}', '${a.hash}', '2026-09-27T12:00:00.002Z')`);
		expect(statement).toContain(`'${legacy.hash}', NULL, NULL)`);
		expect(statement).toContain("'it''s a test'");
		expect(statement).toContain(", 4, 'r', ");
	});
});

describe("GreptimeClient.chainHead", () => {
	test("selects the newest post-cutover row and returns its hash and ingest time", async () => {
		const g = new RecordingGreptime(() => [{ hash: "h1", ingested_at: 1790510400123 }]);
		expect(await g.chainHead()).toEqual({ hash: "h1", ingestedAtMs: 1790510400123 });
		expect(g.statements).toEqual([
			`SELECT "hash", "ingested_at" FROM "agent_events" WHERE "ingested_at" IS NOT NULL ORDER BY "ingested_at" DESC LIMIT 1`,
		]);
	});

	test("no post-cutover row means genesis (null)", async () => {
		expect(await new RecordingGreptime().chainHead()).toBeNull();
	});
});

describe("GreptimeClient.eventsAtKeys", () => {
	test("an empty key list sends nothing", async () => {
		const g = new RecordingGreptime();
		expect(await g.eventsAtKeys([])).toEqual([]);
		expect(g.statements).toEqual([]);
	});

	test("many keys go out as one NULL-safe statement", async () => {
		const g = new RecordingGreptime();
		await g.eventsAtKeys([
			{ surface: "grok-build", repo: null, graph_id: null, kind: "tool.call", tsMs: 1790510400000 },
			{ surface: "grok-build", repo: "o'r", graph_id: "ut-1", kind: "file.edit", tsMs: 1790510400001 },
		]);
		expect(g.statements).toHaveLength(1);
		const statement = g.statements[0]!;
		expect(statement).not.toContain("= NULL");
		expect(statement).toContain(`FROM "agent_events" WHERE (`);
		expect(statement).toContain(
			`("surface" = 'grok-build' AND "repo" IS NULL AND "graph_id" IS NULL AND "kind" = 'tool.call' AND "ts" = 1790510400000) OR (`,
		);
		expect(statement).toContain(
			`("surface" = 'grok-build' AND "repo" = 'o''r' AND "graph_id" = 'ut-1' AND "kind" = 'file.edit' AND "ts" = 1790510400001)`,
		);
		expect(statement).toContain('"ingested_at" FROM');
	});
});

describe("GreptimeClient hour reads", () => {
	const selectList = EVENT_COLUMNS.map((name) => `"${name}"`).join(", ");

	test("hourEvents selects the 17 columns of a half-open ingest hour in chain order", async () => {
		const g = new RecordingGreptime(() => [{ id: "e1" }]);
		expect(await g.hourEvents(1790510400000, 1790514000000)).toEqual([{ id: "e1" }]);
		expect(g.statements).toEqual([
			`SELECT ${selectList} FROM "agent_events" WHERE "ingested_at" >= 1790510400000 AND "ingested_at" < 1790514000000 ORDER BY "ingested_at", "id"`,
		]);
	});

	test("lastEventBefore selects the newest post-cutover row before the hour, or null", async () => {
		const g = new RecordingGreptime(() => [{ id: "e0", hash: "h0" }]);
		expect(await g.lastEventBefore(1790510400000)).toEqual({ id: "e0", hash: "h0" });
		expect(g.statements).toEqual([
			`SELECT ${selectList} FROM "agent_events" WHERE "ingested_at" IS NOT NULL AND "ingested_at" < 1790510400000 ORDER BY "ingested_at" DESC LIMIT 1`,
		]);
		expect(await new RecordingGreptime().lastEventBefore(1)).toBeNull();
	});
});
