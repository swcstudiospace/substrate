/**
 * `graph_bind`: one swarm `correlation_id` to exactly one Graph ID.
 *
 * Three layers, each proved where it can be:
 *
 *   - validation and the status/conflict mapping, with no database — a fake index
 *     whose `bindCorrelation` stands in for the unique key, because what the service
 *     owes is mapping the store's answer faithfully and telling the ledger once;
 *   - the tool over the MCP protocol, so a mis-schemad or mis-wired argument fails here;
 *   - the SQL itself against a real Postgres. These skip unless one is given:
 *
 *         SUBSTRATE_TEST_PG_URL=postgres://… bun test graph-bind
 *
 *     Skipped rather than mocked, like `index-store.lease.test.ts`: a mock of Postgres'
 *     unique-key arbitration would be a mock of the one thing under test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SQL } from "bun";
import { loadConfig } from "./config.ts";
import { IndexStore, type GraphBindResult } from "./index-store.ts";
import { createMcpServer } from "./mcp.ts";
import { InvalidBindError, Substrate, parseBindRequest } from "./service.ts";
import { defined } from "./test-support.ts";
import type { SubstrateEvent, Surface } from "./types.ts";

const GRAPH_A = "ut-mabc123-0123abcd";
const GRAPH_B = "ut-mxyz789-89abcdef";

describe("parseBindRequest", () => {
	test("at least one id is required", () => {
		expect(() => parseBindRequest({})).toThrow(InvalidBindError);
		expect(() => parseBindRequest({ correlation_id: undefined, graph_id: undefined })).toThrow("needs");
		expect(() => parseBindRequest({ correlation_id: null, graph_id: null })).toThrow(InvalidBindError);
	});

	test("accepts either id alone, or both", () => {
		expect(parseBindRequest({ correlation_id: "run-1" })).toEqual({ correlation_id: "run-1" });
		expect(parseBindRequest({ graph_id: GRAPH_A })).toEqual({ graph_id: GRAPH_A });
		expect(parseBindRequest({ correlation_id: "run-1", graph_id: GRAPH_A })).toEqual({
			correlation_id: "run-1",
			graph_id: GRAPH_A,
		});
	});

	test("a correlation id is 1..200 characters of [A-Za-z0-9._:-]", () => {
		const uuid = "3f2b8c1e-5d4a-4b7e-9a10-0c2d3e4f5a6b";
		expect(parseBindRequest({ correlation_id: uuid }).correlation_id).toBe(uuid);
		expect(parseBindRequest({ correlation_id: "a.b_c:d-e" }).correlation_id).toBe("a.b_c:d-e");
		expect(parseBindRequest({ correlation_id: "x".repeat(200) }).correlation_id).toHaveLength(200);

		for (const bad of ["", "x".repeat(201), "has space", "slash/inside", "ünï", "new\nline", 7]) {
			expect(() => parseBindRequest({ correlation_id: bad })).toThrow(InvalidBindError);
		}
	});

	test("a graph id must be ut-<ts36>-<8hex>", () => {
		for (const good of [GRAPH_A, "ut-0-00000000", "ut-zzzzzzzz-ffffffff"]) {
			expect(parseBindRequest({ graph_id: good }).graph_id).toBe(good);
		}
		for (const bad of [
			"",
			"ut-1",
			"ut-mabc123-0123abc",
			"ut-mabc123-0123abcde",
			"ut-mabc123-0123ABCD",
			"ut-MABC123-0123abcd",
			"xx-mabc123-0123abcd",
			"ut--0123abcd",
			" ut-mabc123-0123abcd",
		]) {
			expect(() => parseBindRequest({ graph_id: bad })).toThrow(InvalidBindError);
		}
	});

	test("a valid id does not excuse an invalid one beside it", () => {
		expect(() => parseBindRequest({ correlation_id: "ok", graph_id: "nope" })).toThrow("graph_id");
		expect(() => parseBindRequest({ correlation_id: "no way", graph_id: GRAPH_A })).toThrow("correlation_id");
	});
});

/**
 * A fake index that arbitrates like the unique key does: the first bind of a
 * correlation id wins and every later one reads the stored row.
 */
function fakeIndex() {
	const bindings = new Map<string, { graph_id: string; bound_by: string | null }>();
	const calls: string[] = [];
	return {
		bindings,
		calls,
		index: {
			bindCorrelation: async (correlationId: string, graphId: string, boundBy: string | null): Promise<GraphBindResult> => {
				calls.push("bind");
				const stored = bindings.get(correlationId);
				if (!stored) {
					bindings.set(correlationId, { graph_id: graphId, bound_by: boundBy });
					return { status: "created", correlation_id: correlationId, graph_id: graphId, conflict: false };
				}
				return {
					status: "existing",
					correlation_id: correlationId,
					graph_id: stored.graph_id,
					conflict: stored.graph_id !== graphId,
				};
			},
			graphForCorrelation: async (correlationId: string) => {
				calls.push("forward");
				return bindings.get(correlationId)?.graph_id ?? null;
			},
			correlationsForGraph: async (graphId: string) => {
				calls.push("reverse");
				return [...bindings].filter(([, row]) => row.graph_id === graphId).map(([id]) => id);
			},
		},
	};
}

function ledger(options: { fail?: boolean } = {}) {
	const written: SubstrateEvent[] = [];
	return {
		written,
		greptime: {
			ensureAppendMode: async () => true,
			lastHash: async (): Promise<string | null> => null,
			insertEvent: async (event: SubstrateEvent) => {
				if (options.fail) throw new Error("ledger unreachable");
				written.push(event);
			},
		},
	};
}

describe("Substrate.bindGraph", () => {
	test("both ids, first time: created, and the binding is recorded as a note", async () => {
		const { index } = fakeIndex();
		const { written, greptime } = ledger();
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		const result = await substrate.bindGraph({ correlation_id: "run-1", graph_id: GRAPH_A }, "swarm-a01-orch");

		expect(result).toEqual({ status: "created", correlation_id: "run-1", graph_id: GRAPH_A, conflict: false });
		expect(written).toHaveLength(1);
		expect(written[0]).toMatchObject({
			kind: "note",
			surface: "swarm-a01-orch",
			graph_id: GRAPH_A,
			actor: "agent",
			payload: { correlation_id: "run-1", bound_by: "swarm-a01-orch" },
		});
	});

	test("two bindings on one graph leave a ledger that verifies", async () => {
		const { index } = fakeIndex();
		const { written, greptime } = ledger();
		const stored = {
			...greptime,
			lastHash: async (sessionId: string) => written.filter((e) => e.session_id === sessionId).at(-1)?.hash ?? null,
			readEvents: async () =>
				written.map((event) => ({ ...event, ts: Date.parse(event.ts), payload: JSON.stringify(event.payload) })),
			// No ingest table concept here: with no coverage start every event
			// is pre-coverage legacy, so the hour report stays empty.
			graphIngest: async () => [],
			firstIngestMs: async () => null,
			graphChainLeafHours: async () => [],
		};
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: stored as never });

		await substrate.bindGraph({ correlation_id: "run-1", graph_id: GRAPH_A }, "swarm-a01-orch");
		await substrate.bindGraph({ correlation_id: "run-2", graph_id: GRAPH_A }, "swarm-a01-orch");

		expect(written.map((event) => event.session_id)).toEqual([`bind:${GRAPH_A}:run-1`, `bind:${GRAPH_A}:run-2`]);
		const verdict = await substrate.verifyGraph(GRAPH_A);
		expect(verdict.ok).toBe(true);
		expect(verdict.events).toBe(2);
		expect(verdict.chain).toEqual({ ok: true });
		expect(verdict.hours).toEqual([]);
		expect(verdict.uncovered).toEqual({ count: 0, ids: [] });
		expect(verdict.legacy.count).toBe(2);
	});

	test("both ids, same pair again: existing, no conflict, and not announced twice", async () => {
		const { index } = fakeIndex();
		const { written, greptime } = ledger();
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		await substrate.bindGraph({ correlation_id: "run-1", graph_id: GRAPH_A }, "swarm-a01-orch");
		const again = await substrate.bindGraph({ correlation_id: "run-1", graph_id: GRAPH_A }, "swarm-a01-orch");

		expect(again).toEqual({ status: "existing", correlation_id: "run-1", graph_id: GRAPH_A, conflict: false });
		expect(written).toHaveLength(1);
	});

	test("both ids, a different graph offered: the stored winner comes back with conflict", async () => {
		const { index } = fakeIndex();
		const { written, greptime } = ledger();
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		await substrate.bindGraph({ correlation_id: "run-1", graph_id: GRAPH_A }, "swarm-a01-orch");
		const loser = await substrate.bindGraph({ correlation_id: "run-1", graph_id: GRAPH_B }, "swarm-a05-be");

		// The caller must adopt the returned graph_id, never the one it offered.
		expect(loser).toEqual({ status: "existing", correlation_id: "run-1", graph_id: GRAPH_A, conflict: true });
		expect(written).toHaveLength(1);
	});

	test("two concurrent binds of one correlation id: exactly one created and one existing", async () => {
		const { index } = fakeIndex();
		const { greptime } = ledger();
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		const results = (await Promise.all([
			substrate.bindGraph({ correlation_id: "run-1", graph_id: GRAPH_A }, "swarm-a01-orch"),
			substrate.bindGraph({ correlation_id: "run-1", graph_id: GRAPH_B }, "swarm-a05-be"),
		])) as GraphBindResult[];

		expect(results.map((result) => result.status).sort()).toEqual(["created", "existing"]);
		expect(new Set(results.map((result) => result.graph_id)).size).toBe(1);
	});

	test("forward lookup: existing with the graph, or unbound with null", async () => {
		const { index } = fakeIndex();
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null });

		expect(await substrate.bindGraph({ correlation_id: "run-1" }, null)).toEqual({
			status: "unbound",
			correlation_id: "run-1",
			graph_id: null,
		});
		await substrate.bindGraph({ correlation_id: "run-1", graph_id: GRAPH_A }, null);
		expect(await substrate.bindGraph({ correlation_id: "run-1" }, null)).toEqual({
			status: "existing",
			correlation_id: "run-1",
			graph_id: GRAPH_A,
		});
	});

	test("reverse lookup: every correlation id bound to the graph, none for a stranger", async () => {
		const { index } = fakeIndex();
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null });
		await substrate.bindGraph({ correlation_id: "run-1", graph_id: GRAPH_A }, null);
		await substrate.bindGraph({ correlation_id: "run-2", graph_id: GRAPH_A }, null);
		await substrate.bindGraph({ correlation_id: "run-3", graph_id: GRAPH_B }, null);

		expect(await substrate.bindGraph({ graph_id: GRAPH_A }, null)).toEqual({
			graph_id: GRAPH_A,
			correlation_ids: ["run-1", "run-2"],
		});
		expect(await substrate.bindGraph({ graph_id: "ut-mnone00-00000000" }, null)).toEqual({
			graph_id: "ut-mnone00-00000000",
			correlation_ids: [],
		});
	});

	test("fail-open on the record: a ledger that is down costs the note, never the bind", async () => {
		const { index } = fakeIndex();
		const { greptime } = ledger({ fail: true });
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });

		const result = await substrate.bindGraph({ correlation_id: "run-1", graph_id: GRAPH_A }, "swarm-a01-orch");

		expect(result).toMatchObject({ status: "created", graph_id: GRAPH_A });
	});

	test("invalid input is refused before the index is touched", async () => {
		const { index, calls } = fakeIndex();
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null });

		await expect(substrate.bindGraph({}, null)).rejects.toThrow(InvalidBindError);
		await expect(substrate.bindGraph({ graph_id: "nope" }, null)).rejects.toThrow(InvalidBindError);
		expect(calls).toEqual([]);
	});

	test("no Postgres is a clear error, not a crash", async () => {
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: null });

		await expect(substrate.bindGraph({ correlation_id: "run-1", graph_id: GRAPH_A }, null)).rejects.toThrow(
			"graph_bind requires SUBSTRATE_PG_URL",
		);
	});
});

describe("the graph_bind tool", () => {
	async function connect(index: unknown, greptime: unknown, surface: Surface | null = "swarm-a01-orch") {
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });
		const server = createMcpServer(substrate, surface);
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		return client;
	}

	async function call(client: Client, args: Record<string, unknown>) {
		const result = await client.callTool({ name: "graph_bind", arguments: args });
		const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
		return { isError: result.isError === true, text };
	}

	test("is offered, and is not read-only", async () => {
		const client = await connect(fakeIndex().index, ledger().greptime);
		const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "graph_bind");

		expect(tool).toBeDefined();
		expect(tool?.annotations?.readOnlyHint).not.toBe(true);
	});

	test("answers with the standard JSON text result", async () => {
		const { written, greptime } = ledger();
		const client = await connect(fakeIndex().index, greptime);

		const created = await call(client, { correlation_id: "run-1", graph_id: GRAPH_A });
		const conflict = await call(client, { correlation_id: "run-1", graph_id: GRAPH_B });
		const forward = await call(client, { correlation_id: "run-1" });
		const reverse = await call(client, { graph_id: GRAPH_A });

		expect(created.isError).toBe(false);
		expect(JSON.parse(created.text)).toEqual({ status: "created", correlation_id: "run-1", graph_id: GRAPH_A, conflict: false });
		expect(JSON.parse(conflict.text)).toEqual({ status: "existing", correlation_id: "run-1", graph_id: GRAPH_A, conflict: true });
		expect(JSON.parse(forward.text)).toEqual({ status: "existing", correlation_id: "run-1", graph_id: GRAPH_A });
		expect(JSON.parse(reverse.text)).toEqual({ graph_id: GRAPH_A, correlation_ids: ["run-1"] });
		// One note, on the created bind only, attributed to the token's surface.
		expect(written).toHaveLength(1);
		expect(written[0]?.surface).toBe("swarm-a01-orch");
	});

	test("neither id is a tool error", async () => {
		const client = await connect(fakeIndex().index, ledger().greptime);

		const reply = await call(client, {});

		expect(reply.isError).toBe(true);
		expect(JSON.parse(reply.text).error).toContain("needs");
	});

	test("a malformed id is a tool error and binds nothing", async () => {
		const { bindings, index } = fakeIndex();
		const client = await connect(index, ledger().greptime);

		expect((await call(client, { correlation_id: "has space", graph_id: GRAPH_A })).isError).toBe(true);
		expect((await call(client, { correlation_id: "run-1", graph_id: "ut-1" })).isError).toBe(true);
		expect((await call(client, { correlation_id: "x".repeat(201) })).isError).toBe(true);
		expect(bindings.size).toBe(0);
	});

	test("with no Postgres it is a tool error, not a crash", async () => {
		const client = await connect(null, ledger().greptime);

		const reply = await call(client, { correlation_id: "run-1", graph_id: GRAPH_A });

		expect(reply.isError).toBe(true);
		expect(reply.text).toContain("SUBSTRATE_PG_URL");
	});
});

const PG_URL = process.env.SUBSTRATE_TEST_PG_URL?.trim();
const describeLive = PG_URL ? describe : describe.skip;
/** Namespaced so a shared database is left as found: every row here carries it. */
const RUN = `gbtest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

describeLive("correlation bindings against a live index", () => {
	// Two stores, so a race goes through two connections rather than one serialised one.
	let a: IndexStore;
	let b: IndexStore;
	let cleanup: SQL;

	beforeAll(async () => {
		const url = defined(PG_URL, "SUBSTRATE_TEST_PG_URL");
		a = new IndexStore(url);
		b = new IndexStore(url);
		cleanup = new SQL(url);
		await a.migrate();
	});

	afterAll(async () => {
		if (!PG_URL) return;
		await cleanup`delete from graph_bindings where correlation_id like ${`${RUN}%`}`.catch(() => undefined);
		await cleanup.end().catch(() => undefined);
		await a.close().catch(() => undefined);
		await b.close().catch(() => undefined);
	});

	test("migrate is idempotent and creates the table, key and graph index", async () => {
		await a.migrate();
		const columns = (await cleanup`
			select column_name from information_schema.columns where table_name = 'graph_bindings'
			order by column_name`) as Array<{ column_name: string }>;
		expect(columns.map((column) => column.column_name)).toEqual(["bound_by", "correlation_id", "created", "graph_id"]);

		const indexes = (await cleanup`
			select indexname from pg_indexes where tablename = 'graph_bindings'`) as Array<{ indexname: string }>;
		expect(indexes.map((index) => index.indexname)).toContain("graph_bindings_graph_idx");
		expect(indexes.map((index) => index.indexname)).toContain("graph_bindings_pkey");
	});

	test("first bind creates, a retry reads, a different graph conflicts", async () => {
		const id = `${RUN}-seq`;

		const first = await a.bindCorrelation(id, GRAPH_A, "swarm-a01-orch");
		const retry = await b.bindCorrelation(id, GRAPH_A, "swarm-a01-orch");
		const other = await b.bindCorrelation(id, GRAPH_B, "swarm-a05-be");

		expect(first).toEqual({ status: "created", correlation_id: id, graph_id: GRAPH_A, conflict: false });
		expect(retry).toEqual({ status: "existing", correlation_id: id, graph_id: GRAPH_A, conflict: false });
		expect(other).toEqual({ status: "existing", correlation_id: id, graph_id: GRAPH_A, conflict: true });
	});

	test("many concurrent binds of one correlation id: exactly one created, the rest read the winner", async () => {
		const id = `${RUN}-race`;
		const offers = Array.from({ length: 12 }, (_, i) => `ut-race${i}-${i.toString(16).padStart(8, "0")}`);

		const results = await Promise.all(offers.map((graph, i) => (i % 2 === 0 ? a : b).bindCorrelation(id, graph, `r${i}`)));

		expect(results.filter((result) => result.status === "created")).toHaveLength(1);
		expect(results.filter((result) => result.status === "existing")).toHaveLength(11);
		const winner = defined(results.find((result) => result.status === "created")).graph_id;
		for (const result of results) expect(result.graph_id).toBe(winner);
		// The conflict flag is exactly "the stored graph is not the one I offered".
		results.forEach((result, i) => {
			expect(result.conflict).toBe(offers[i] !== winner);
		});
		expect(await a.graphForCorrelation(id)).toBe(winner);
	});

	test("forward lookup returns the graph, or null when unbound", async () => {
		const id = `${RUN}-forward`;
		expect(await a.graphForCorrelation(id)).toBeNull();
		await a.bindCorrelation(id, GRAPH_A, null);
		expect(await b.graphForCorrelation(id)).toBe(GRAPH_A);
	});

	test("reverse lookup returns every correlation id bound to the graph", async () => {
		const graph = `ut-rev${Date.now().toString(36)}-00c0ffee`;
		await a.bindCorrelation(`${RUN}-rev1`, graph, null);
		await a.bindCorrelation(`${RUN}-rev2`, graph, null);
		await a.bindCorrelation(`${RUN}-rev3`, GRAPH_B, null);

		expect(await b.correlationsForGraph(graph)).toEqual([`${RUN}-rev1`, `${RUN}-rev2`]);
		expect(await b.correlationsForGraph("ut-nothing0-00000000")).toEqual([]);
	});

	test("the binding needs no registered graph: no foreign key to graph_index", async () => {
		const result = await a.bindCorrelation(`${RUN}-nofk`, "ut-neverreg-12345678", null);
		expect(result.status).toBe("created");
	});
});
