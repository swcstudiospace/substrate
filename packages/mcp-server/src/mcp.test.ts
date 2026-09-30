/**
 * The MCP tool surface, driven through a real client.
 *
 * `/mcp` is what a desk seat actually calls, so the tools are exercised over the
 * protocol rather than by calling the service directly: a tool that is missing,
 * mis-schemad or wired to the wrong argument fails here and nowhere else. The
 * ledger underneath is a stub — the point is the wiring, not Greptime.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.ts";
import type { EventQuery } from "./greptime.ts";
import { createMcpServer } from "./mcp.ts";
import { Substrate } from "./service.ts";
import type { SubstrateEvent, Surface } from "./types.ts";

/** A ledger stub recording what was appended and what was asked of it. */
function ledger(rows: Array<Record<string, unknown>> = []) {
	const written: SubstrateEvent[] = [];
	const queries: EventQuery[] = [];
	return {
		written,
		queries,
		greptime: {
			ensureAppendMode: async () => true,
			lastHash: async (): Promise<string | null> => null,
			insertEvent: async (event: SubstrateEvent) => {
				written.push(event);
			},
			queryEvents: async (query: EventQuery) => {
				queries.push(query);
				return rows;
			},
			readEvents: async () => rows,
		},
	};
}

/** A connected client and the substrate behind it. Closed by the test runner's teardown. */
async function connect(greptime: unknown, surface: Surface | null = "omp") {
	const substrate = new Substrate(loadConfig({}), { index: null, greptime: greptime as never });
	const server = createMcpServer(substrate, surface);
	const client = new Client({ name: "substrate-test", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, substrate };
}

/** A tool's JSON reply. Every substrate tool answers with one text block. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
	const result = await client.callTool({ name, arguments: args });
	const content = result.content as Array<{ type: string; text?: string }>;
	const text = content[0]?.text ?? "";
	return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

describe("the tool surface", () => {
	test("offers both halves of the events plane, and marks the reads read-only", async () => {
		const { client } = await connect(ledger().greptime);
		const tools = (await client.listTools()).tools;
		const byName = new Map(tools.map((tool) => [tool.name, tool]));

		// A seat that can only write is half-wired: the trail exists to be read back.
		expect(byName.has("events_emit")).toBe(true);
		expect(byName.has("events_query")).toBe(true);
		expect(byName.has("events_verify")).toBe(true);
		expect(byName.get("events_query")?.annotations?.readOnlyHint).toBe(true);
		expect(byName.get("events_verify")?.annotations?.readOnlyHint).toBe(true);
	});
});

describe("events_emit", () => {
	test("appends through the ledger and reports that it landed", async () => {
		const { written, greptime } = ledger();
		const { client } = await connect(greptime);

		const reply = await call(client, "events_emit", { kind: "shell", summary: "ran bun test" });

		expect(reply.isError).toBe(false);
		expect(reply.json().stored).toBe(true);
		expect(written).toHaveLength(1);
		expect(written[0]?.summary).toBe("ran bun test");
		// Attribution comes from the caller's token, not from the arguments.
		expect(written[0]?.surface).toBe("omp");
		expect(reply.json().hash).toBe(written[0]?.hash);
	});

	test("says so when the append did not land", async () => {
		const { greptime } = ledger();
		greptime.insertEvent = async () => {
			throw new Error("greptime unreachable: connect ETIMEDOUT");
		};
		const { client } = await connect(greptime);

		const reply = await call(client, "events_emit", { kind: "note", summary: "still working" });

		// Fail open, but never silently: the tool returns, and `stored` tells the truth.
		expect(reply.isError).toBe(false);
		expect(reply.json().stored).toBe(false);
		expect(String(reply.json().error)).toContain("unreachable");
	});
});

describe("events_query", () => {
	const row = {
		ts: 1790186361859,
		id: "evt_1",
		surface: "omp",
		session_id: "sess-1",
		graph_id: "ut-1",
		node_id: null,
		linear_identifier: "SPE-4789",
		step: null,
		repo: "swcstudiospace/agent-substrate",
		branch: "main",
		actor: "agent",
		kind: "shell",
		summary: "ran bun test",
		hash: "h1",
		prev: null,
	};

	test("reads the ledger back without the caller holding a credential", async () => {
		const { queries, greptime } = ledger([row]);
		const { client } = await connect(greptime);

		const reply = await call(client, "events_query", { repo: "swcstudiospace/agent-substrate", limit: 10 });
		const body = reply.json();

		expect(body.count).toBe(1);
		expect((body.events as Array<Record<string, unknown>>)[0]?.summary).toBe("ran bun test");
		expect(queries[0]?.match?.repo).toBe("swcstudiospace/agent-substrate");
		expect(queries[0]?.limit).toBe(10);
	});

	test("a round trip: what events_emit appended is what events_query returns", async () => {
		const stub = ledger();
		const { client } = await connect(stub.greptime);
		stub.greptime.queryEvents = async (query: EventQuery) => {
			stub.queries.push(query);
			return stub.written
				.filter((event) => event.session_id === query.match?.session_id)
				.map((event) => ({ ...event, ts: Date.parse(event.ts), payload: JSON.stringify(event.payload) }));
		};

		await call(client, "events_emit", { kind: "commit", summary: "wired the read path", session_id: "sess-7" });
		const reply = await call(client, "events_query", { session_id: "sess-7", include_payload: true });
		const events = reply.json().events as Array<Record<string, unknown>>;

		expect(events).toHaveLength(1);
		expect(events[0]?.hash).toBe(stub.written[0]?.hash);
		expect(events[0]?.ts).toBe(stub.written[0]?.ts);
		expect(events[0]?.payload).toEqual({});
	});

	test("rejects a filter the ledger has no column value for", async () => {
		const { client } = await connect(ledger().greptime);

		// The zod enum catches this at the protocol boundary, before the service does:
		// either way the caller hears about their typo instead of reading an empty window.
		const reply = await call(client, "events_query", { surface: "claude-cod" });
		expect(reply.isError).toBe(true);
	});

	test("an unconfigured ledger answers with an empty window and a reason", async () => {
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: null });
		const server = createMcpServer(substrate, "omp");
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		const reply = await call(client, "events_query", {});
		expect(reply.json().count).toBe(0);
		expect(reply.json().error).toBe("GREPTIME_URL is not set");
	});
});

describe("events_verify", () => {
	/** What Greptime hands back for an event it stored. */
	function storedRow(event: SubstrateEvent) {
		return { ...event, ts: Date.parse(event.ts), payload: JSON.stringify(event.payload) };
	}

	test("confirms a chain the emit path wrote", async () => {
		const stub = ledger();
		const { client, substrate } = await connect(stub.greptime);
		stub.greptime.lastHash = async () => stub.written.at(-1)?.hash ?? null;

		for (const summary of ["first", "second"]) {
			await substrate.emit({ surface: "omp", kind: "note", summary, session_id: "s", graph_id: "ut-1" });
		}
		stub.greptime.readEvents = async () => stub.written.map(storedRow);

		const reply = await call(client, "events_verify", { graph_id: "ut-1" });

		expect(reply.json().ok).toBe(true);
		expect(reply.json().events).toBe(2);
		expect(stub.written[1]?.prev).toBe(stub.written[0]?.hash ?? null);
	});

	test("names the event that does not verify", async () => {
		const stub = ledger();
		const { client, substrate } = await connect(stub.greptime);
		await substrate.emit({ surface: "omp", kind: "note", summary: "as written", session_id: "s", graph_id: "ut-1" });
		// A row edited after the fact — which an append-only table forbids, and which is
		// exactly what this tool exists to catch.
		stub.greptime.readEvents = async () =>
			stub.written.map((event) => storedRow({ ...event, summary: "tampered with" }));

		const reply = await call(client, "events_verify", { graph_id: "ut-1" });

		expect(reply.json().ok).toBe(false);
		expect(reply.json().brokenAt).toBe(stub.written[0]?.id);
		expect(reply.json().reason).toBe("hash does not match contents");
	});
});
