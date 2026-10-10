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
import { ProposeFailed, ProposeRefused, type ProposeOptions, type ProposeResult, type SkillProposer } from "./skills/propose.ts";
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
			// No ingest table concept here: with no coverage start every event
			// is pre-coverage legacy, so the hour report stays empty.
			graphIngest: async () => [],
			firstIngestMs: async () => null,
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

/**
 * A swarm token is its surface on the two paths the swarm leans on — `events_emit` and
 * `graph_claim` — and naming another surface is refused, not re-attributed. Every other
 * caller is unchanged: collectors and hooks name the surface they observed.
 */
describe("a swarm token names the caller", () => {
	/** An index whose claim records the surface it was asked to claim as. */
	function claimIndex() {
		const claimedAs: Array<{ surface: string; session_id: string }> = [];
		const holder = { surface: "swarm-a05-be" as Surface, session_id: "A05@r0:ut-1" };
		return {
			claimedAs,
			index: {
				claimNode: async (graph_id: string, node_id: string, surface: string, session_id: string) => {
					claimedAs.push({ surface, session_id });
					return {
						claimed: true,
						node: { graph_id, node_id, linear_identifier: null },
						lease: { lease_id: "lse_1", holder, epoch: 1, state: "held", expires_at: null },
						decision: { action: "granted", evicted: null },
					};
				},
				getGraph: async () => null,
				releaseNode: async () => ({ released: true }),
			},
		};
	}

	async function connectWith(surface: Surface | null, index: unknown, greptime: unknown) {
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never });
		const server = createMcpServer(substrate, surface);
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		return client;
	}

	test("events_emit: A05's token cannot emit as A09, and nothing is written", async () => {
		const { written, greptime } = ledger();
		const { client } = await connect(greptime, "swarm-a05-be");

		const reply = await call(client, "events_emit", { kind: "note", summary: "forged", surface: "swarm-a09-rev" });

		expect(reply.isError).toBe(true);
		expect(String(reply.json().error)).toContain("cannot act as swarm-a09-rev");
		expect(written).toEqual([]);
	});

	test("events_emit: the same token emitting as itself, or by default, works", async () => {
		const { written, greptime } = ledger();
		const { client } = await connect(greptime, "swarm-a05-be");

		const explicit = await call(client, "events_emit", { kind: "note", summary: "mine", surface: "swarm-a05-be" });
		const implicit = await call(client, "events_emit", { kind: "note", summary: "also mine" });

		expect(explicit.isError).toBe(false);
		expect(implicit.isError).toBe(false);
		expect(written.map((event) => event.surface)).toEqual(["swarm-a05-be", "swarm-a05-be"]);
	});

	test("events_emit: a non-swarm token naming another surface behaves as it always did", async () => {
		const { written, greptime } = ledger();
		const { client } = await connect(greptime, "omp");

		const reply = await call(client, "events_emit", { kind: "note", summary: "observed", surface: "hermes" });

		expect(reply.isError).toBe(false);
		expect(written[0]?.surface).toBe("hermes");
	});

	test("events_emit: an anonymous caller naming a swarm surface is unchanged", async () => {
		const { written, greptime } = ledger();
		const { client } = await connect(greptime, null);

		const reply = await call(client, "events_emit", { kind: "note", summary: "local", surface: "swarm-a09-rev" });

		expect(reply.isError).toBe(false);
		expect(written[0]?.surface).toBe("swarm-a09-rev");
	});

	test("graph_claim: A05's token cannot claim as A09, and the index is never asked", async () => {
		const { claimedAs, index } = claimIndex();
		const client = await connectWith("swarm-a05-be", index, ledger().greptime);

		const reply = await call(client, "graph_claim", {
			graph_id: "ut-1",
			node_id: "n1",
			session_id: "A09@r0:ut-1",
			surface: "swarm-a09-rev",
		});

		expect(reply.isError).toBe(true);
		expect(String(reply.json().error)).toContain("cannot act as swarm-a09-rev");
		expect(claimedAs).toEqual([]);
	});

	test("graph_claim: the same token claims as itself, with or without naming itself", async () => {
		const { claimedAs, index } = claimIndex();
		const client = await connectWith("swarm-a05-be", index, ledger().greptime);

		await call(client, "graph_claim", { graph_id: "ut-1", node_id: "n1", session_id: "A05@r0:ut-1", surface: "swarm-a05-be" });
		await call(client, "graph_claim", { graph_id: "ut-1", node_id: "n2", session_id: "A05@r0:ut-1" });

		expect(claimedAs.map((claim) => claim.surface)).toEqual(["swarm-a05-be", "swarm-a05-be"]);
	});

	test("graph_claim: a non-swarm token naming another surface behaves as it always did", async () => {
		const { claimedAs, index } = claimIndex();
		const client = await connectWith("omp", index, ledger().greptime);

		await call(client, "graph_claim", { graph_id: "ut-1", node_id: "n1", session_id: "s", surface: "hermes" });

		expect(claimedAs.map((claim) => claim.surface)).toEqual(["hermes"]);
	});

	test("graph_claim: a non-swarm token naming a swarm surface is refused, and the index is never asked", async () => {
		// A swarm holder's session is public; claiming as it would renew its lease.
		const { claimedAs, index } = claimIndex();
		const client = await connectWith("hermes", index, ledger().greptime);

		const reply = await call(client, "graph_claim", {
			graph_id: "ut-1",
			node_id: "n1",
			session_id: "A05@r0:ut-1",
			surface: "swarm-a05-be",
		});

		expect(reply.isError).toBe(true);
		expect(String(reply.json().error)).toBe("this token is hermes and cannot claim as swarm-a05-be");
		expect(claimedAs).toEqual([]);
	});

	test("graph_claim: a swarm session naming another agent, a bad replica or another graph is refused, never rewritten", async () => {
		const { claimedAs, index } = claimIndex();
		const client = await connectWith("swarm-a05-be", index, ledger().greptime);

		const sessions = ["A09@r0:ut-1", "A05@r 0:ut-1", "A05@r0:ut-2", "sess-1"];
		const replies = await Promise.all(
			sessions.map((session_id) => call(client, "graph_claim", { graph_id: "ut-1", node_id: "n1", session_id })),
		);

		for (const [i, reply] of replies.entries()) {
			expect(reply.isError, sessions[i]).toBe(true);
			expect(String(reply.json().error), sessions[i]).toContain("swarm-a05-be session_id");
		}
		expect(claimedAs).toEqual([]);
	});

	test("graph_claim: a lease held as a swarm surface has the swarm session shape, whoever asks for it", async () => {
		// An anonymous caller may still name a swarm surface, but the hold it takes
		// then reads like any other swarm hold, so the rule follows the holder.
		const { claimedAs, index } = claimIndex();
		const client = await connectWith(null, index, ledger().greptime);

		const bad = await call(client, "graph_claim", { graph_id: "ut-1", node_id: "n1", session_id: "s", surface: "swarm-a09-rev" });
		await call(client, "graph_claim", { graph_id: "ut-1", node_id: "n1", session_id: "A09@r0:ut-1", surface: "swarm-a09-rev" });

		expect(bad.isError).toBe(true);
		expect(claimedAs).toEqual([{ surface: "swarm-a09-rev", session_id: "A09@r0:ut-1" }]);
	});
});

describe("a lease id reaches only its holder", () => {
	const heldNode = {
		graph_id: "ut-1",
		node_id: "n1",
		linear_identifier: "SPE-1",
		claimed_by: "swarm-a05-be",
		claim_session: "A05@r0:ut-1",
		lease_id: "lse_secret",
		lease_expires_at: "2026-10-07T12:15:00.000Z",
		lease_epoch: 2,
	};
	const graph = { graph_id: "ut-1", repo: "swcstudiospace/x", nodes: [heldNode], steps: [], edges: [] };

	async function connectAs(surface: Surface | null) {
		const index = { getGraph: async () => graph, registerGraph: async () => graph };
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: ledger().greptime as never });
		const server = createMcpServer(substrate, surface);
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		return client;
	}

	test("graph_get and graph_register show the holder, session, epoch and expiry, and no lease id", async () => {
		// A reader with the id could heartbeat, release or complete a node it never held.
		const client = await connectAs("swarm-a09-rev");

		for (const reply of [await call(client, "graph_get", { graph_id: "ut-1" }), await call(client, "graph_register", { graph_id: "ut-1" })]) {
			expect(reply.text).not.toContain("lse_secret");
			expect((reply.json().nodes as Array<Record<string, unknown>>)[0]).toMatchObject({
				claimed_by: "swarm-a05-be",
				claim_session: "A05@r0:ut-1",
				lease_epoch: 2,
				lease_expires_at: "2026-10-07T12:15:00.000Z",
				lease_id: null,
			});
		}
	});
});

describe("memory_search", () => {
	/** An index stub that records which search ran and with what. */
	function searchIndex() {
		const plain: unknown[][] = [];
		const paged: Array<Record<string, unknown>> = [];
		const entry = { id: "mem_1", scope: "repo:acme/widgets", kind: "fact", text: "x", created: "2026-10-01T00:00:00.000Z" };
		return {
			plain,
			paged,
			index: {
				searchMemory: async (...args: unknown[]) => {
					plain.push(args);
					return [entry];
				},
				searchMemoryPage: async (search: Record<string, unknown>) => {
					paged.push(search);
					return { entries: [entry], next: { before: "2026-10-01T00:00:00.123456Z", before_id: "mem_1" } };
				},
			},
		};
	}

	async function connectIndex(index: unknown) {
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: null });
		const server = createMcpServer(substrate, "omp");
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		return client;
	}

	test("with neither new parameter, the reply is the bare list it always was", async () => {
		const stub = searchIndex();
		const client = await connectIndex(stub.index);
		const reply = await call(client, "memory_search", { query: "lease", scope: "repo:acme/widgets", limit: 5 });

		expect(reply.isError).toBe(false);
		expect(Array.isArray(JSON.parse(reply.text))).toBe(true);
		expect(stub.plain).toEqual([["lease", "repo:acme/widgets", 5, undefined]]);
		expect(stub.paged).toEqual([]);
	});

	test("subject_prefix lists without a query, normalised like a subject, and answers a page with its next pair", async () => {
		const stub = searchIndex();
		const client = await connectIndex(stub.index);
		const reply = await call(client, "memory_search", { scope: "repo:acme/widgets", subject_prefix: "  Lesson:V1.2/", limit: 100 });

		expect(reply.isError).toBe(false);
		expect(reply.json()).toMatchObject({ entries: [{ id: "mem_1" }], next: { before: "2026-10-01T00:00:00.123456Z", before_id: "mem_1" } });
		expect(stub.paged).toEqual([
			{ query: undefined, scope: "repo:acme/widgets", limit: 100, includeSuperseded: undefined, subjectPrefix: "lesson:v1.2/" },
		]);
	});

	test("the keyset pair is passed through as the cursor", async () => {
		const stub = searchIndex();
		const client = await connectIndex(stub.index);
		await call(client, "memory_search", {
			subject_prefix: "lesson:",
			before: "2026-10-01T00:00:00.123456Z",
			before_id: "mem_1",
		});

		expect(stub.paged[0]).toMatchObject({ before: "2026-10-01T00:00:00.123456Z", beforeId: "mem_1" });
	});

	test("a search with neither a query nor a prefix is refused, and nothing is read", async () => {
		const stub = searchIndex();
		const client = await connectIndex(stub.index);

		for (const args of [{}, { before: "2026-10-01T00:00:00Z" }]) {
			const reply = await call(client, "memory_search", args);
			expect(reply.isError).toBe(true);
			expect(reply.text).toContain("subject_prefix");
		}
		expect(stub.plain).toEqual([]);
		expect(stub.paged).toEqual([]);
	});

	test.each([
		"2026-02-30T00:00:00Z",
		"2026-02-29T00:00:00Z",
		"1900-02-29T00:00:00Z",
		"2100-02-29T00:00:00Z",
		"2026-04-31T00:00:00Z",
		"2026-01-00T00:00:00Z",
		"2026-00-01T00:00:00Z",
		"2026-13-01T00:00:00Z",
		"0000-01-01T00:00:00Z",
		"2026-02-30T23:30:00.123456-01:00",
		"2026-01-01T25:00:00Z",
		"2026-01-01T24:01:00Z",
		"2026-01-01T24:00:01Z",
		"2026-01-01T24:00:00.000001Z",
		"2026-01-01T00:60:00Z",
		"2026-01-01T00:00:60Z",
		"2026-01-01T00:00:00+16:00",
		"2026-01-01T00:00:00-16:00",
		"2026-01-01T00:00:00+01:60",
		"2026-01-01T00:00:00-01:60",
	])("an impossible cursor %s is refused before either index search", async (before) => {
		const stub = searchIndex();
		const client = await connectIndex(stub.index);
		const reply = await call(client, "memory_search", { subject_prefix: "lesson:", before });

		expect(reply.isError).toBe(true);
		// A structured refusal is the InvalidSearchError path, not a database or SDK error.
		expect(reply.json().error).toContain("`before`");
		expect(stub.paged).toEqual([]);
		expect(stub.plain).toEqual([]);
	});

	test.each([
		"2024-02-29T23:59:59.123456Z",
		"2000-02-29T00:00:00Z",
		"2024-03-01T00:15:00.000001+01:00",
		"2024-02-29T23:45:00.999999-01:00",
		"2026-01-01T00:00:00+15:59",
		"2026-01-01T00:00:00-15:59",
		"2026-01-01T24:00:00.000000Z",
		"0001-01-01T00:00:00Z",
	])("a valid cursor %s keeps its precision and zone in query and prefix pages", async (before) => {
		const stub = searchIndex();
		const client = await connectIndex(stub.index);

		for (const selector of [{ query: "lease" }, { subject_prefix: "  Lesson:" }]) {
			const reply = await call(client, "memory_search", { ...selector, before, before_id: "mem_1" });
			expect(reply.isError).toBe(false);
			expect(reply.json()).toMatchObject({ entries: [{ id: "mem_1" }] });
		}
		expect(stub.paged).toMatchObject([
			{ query: "lease", before, beforeId: "mem_1" },
			{ subjectPrefix: "lesson:", before, beforeId: "mem_1" },
		]);
		expect(stub.plain).toEqual([]);
	});

	test("a malformed cursor is refused rather than read some other way", async () => {
		const stub = searchIndex();
		const client = await connectIndex(stub.index);

		const tieOnly = await call(client, "memory_search", { subject_prefix: "lesson:", before_id: "mem_1" });
		expect(tieOnly.isError).toBe(true);
		expect(tieOnly.text).toContain("before_id");

		const notATime = await call(client, "memory_search", { subject_prefix: "lesson:", before: "yesterday" });
		expect(notATime.isError).toBe(true);

		const notADate = await call(client, "memory_search", { subject_prefix: "lesson:", before: "2026-13-40T00:00:00Z" });
		expect(notADate.isError).toBe(true);

		const emptyPrefix = await call(client, "memory_search", { subject_prefix: "   " });
		expect(emptyPrefix.isError).toBe(true);

		expect(stub.paged).toEqual([]);
	});
});

describe("skills_propose", () => {
	const files = { "SKILL.md": "---\nname: demo-skill\ndescription: a demo\n---\nbody\n" };
	const args = { name: "demo-skill", files, rationale: "worth keeping" };
	const opened: ProposeResult = {
		status: "opened",
		pr_url: "https://github.com/swcstudiospace/agent-skills/pull/12",
		pr_number: 12,
		branch: "skill/omp/demo-skill-1-abcd",
		content_sha256: "ab".repeat(32),
		redactions: [],
	};

	/** A client of a server for this caller, with a proposer stub in place of git and gh. */
	async function proposing(
		answer: ProposeResult | Error,
		caller: { surface: Surface | null; isOperator: boolean } = { surface: "omp", isOperator: false },
	) {
		const calls: Array<{ input: Parameters<SkillProposer["propose"]>[0]; opts: Omit<ProposeOptions, "run"> }> = [];
		const skills: SkillProposer = {
			propose: async (input, opts) => {
				calls.push({ input, opts });
				if (answer instanceof Error) throw answer;
				return answer;
			},
		};
		const { written, greptime } = ledger();
		const substrate = new Substrate(loadConfig({}), { index: null, greptime: greptime as never, skills });
		const server = createMcpServer(substrate, caller);
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		return { client, calls, written };
	}

	test("is registered, writes nothing destructive, and reaches out to GitHub", async () => {
		const { client } = await proposing(opened);
		const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "skills_propose");

		expect(tool).toBeDefined();
		expect(tool?.annotations).toMatchObject({ destructiveHint: false, openWorldHint: true });
		const properties = Object.keys((tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
		expect(properties.sort()).toEqual(
			["allow_doc_examples", "dry_run", "files", "graph_id", "mode", "name", "rationale", "remove", "reopen", "session_id", "surface"].sort(),
		);
	});

	test("returns the proposal's result as JSON, attributed to the calling surface", async () => {
		const { client, calls, written } = await proposing(opened);
		const reply = await call(client, "skills_propose", args);

		expect(reply.isError).toBe(false);
		expect(reply.json()).toEqual(opened as never);
		expect(calls[0]?.input.surface).toBe("omp");
		// The outcome is on the trail, from the caller, without the skill's content.
		expect(written[0]).toMatchObject({ surface: "omp", kind: "note" });
		expect(JSON.stringify(written[0])).not.toContain("worth keeping");
	});

	test("an anonymous caller is refused as an error and nothing is proposed", async () => {
		const { client, calls, written } = await proposing(opened, { surface: null, isOperator: false });
		const reply = await call(client, "skills_propose", args);

		expect(reply.isError).toBe(true);
		expect(reply.json().error).toContain("authenticated surface");
		expect(calls).toEqual([]);
		expect(written).toEqual([]);
	});

	test("a different surface than the caller's is refused, never re-attributed", async () => {
		const { client, calls } = await proposing(opened);
		const reply = await call(client, "skills_propose", { ...args, surface: "cursor" });

		expect(reply.isError).toBe(true);
		expect(String(reply.json().error)).toContain("omp");
		expect(calls).toEqual([]);

		const same = await call(client, "skills_propose", { ...args, surface: "omp" });
		expect(same.isError).toBe(false);
	});

	test("replace, reopen and doc examples are refused for a surface and allowed for an operator", async () => {
		const agent = await proposing(opened);
		for (const privileged of [{ mode: "replace" }, { reopen: true }, { allow_doc_examples: ["jwt"] }]) {
			const reply = await call(agent.client, "skills_propose", { ...args, ...privileged });
			expect(reply.isError).toBe(true);
			expect(String(reply.json().error)).toContain("operator token");
		}
		expect(agent.calls).toEqual([]);

		const operator = await proposing(opened, { surface: "omp", isOperator: true });
		const reply = await call(operator.client, "skills_propose", { ...args, mode: "replace", reopen: true, allow_doc_examples: ["pem"] });
		expect(reply.isError).toBe(false);
		expect(operator.calls[0]?.opts).toMatchObject({ mode: "replace", reopen: true });
	});

	test("a refusal is an error carrying findings as file, line and rule", async () => {
		const refusal = new ProposeRefused("secret-like content in 1 place(s)", [{ file: "SKILL.md", line: 4, rule: "github" }]);
		const { client } = await proposing(refusal);
		const reply = await call(client, "skills_propose", args);

		expect(reply.isError).toBe(true);
		expect(reply.json()).toEqual({ error: refusal.message, findings: [{ file: "SKILL.md", line: 4, rule: "github" }] });
	});

	test("a failed git or gh step is an error with the redacted, capped reason", async () => {
		// Assembled at run time so no token-shaped literal sits in the repository.
		const token = `ghp_${"E".repeat(36)}`;
		const { client } = await proposing(new ProposeFailed(`git push exited 1: GITHUB_TOKEN=${token} ${"y".repeat(900)}`));
		const reply = await call(client, "skills_propose", args);

		expect(reply.isError).toBe(true);
		expect(reply.text).not.toContain(token);
		expect(String(reply.json().error).length).toBeLessThanOrEqual(400);
	});

	test("a dry run returns the diff counts and emits nothing", async () => {
		const dry: ProposeResult = { ...opened, status: "dry_run", pr_url: undefined, diff_added: 1, diff_changed: 0, diff_deleted: 0 };
		const { client, calls, written } = await proposing(dry);
		const reply = await call(client, "skills_propose", { ...args, dry_run: true });

		expect(reply.json()).toMatchObject({ status: "dry_run", diff_added: 1 });
		expect(calls[0]?.opts.dryRun).toBe(true);
		expect(written).toEqual([]);
	});

	test("a body that does not match the schema is refused by the protocol, before the service", async () => {
		const { client, calls } = await proposing(opened);
		const reply = await call(client, "skills_propose", { ...args, files: ["SKILL.md"] });
		expect(reply.isError).toBe(true);
		expect(calls).toEqual([]);
	});
});

describe("graph_find and issue_get wiring", () => {
	/** A connected client over a substrate with stub index and mirror, recording ledger writes. */
	async function readClient() {
		const written: SubstrateEvent[] = [];
		const node = {
			graph_id: "ut-1",
			node_id: "n2",
			linear_issue_id: "uuid-SWC-467",
			linear_identifier: "SWC-467",
			notion_page: null,
			claimed_by: "hermes",
			claim_session: "sess-a",
			claimed_at: new Date().toISOString(),
			lease_id: "lse_9",
			lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
			lease_heartbeat_at: new Date().toISOString(),
			lease_epoch: 3,
			state: "started",
		};
		const index = {
			getGraph: async () => ({ repo: "swcstudiospace/x", branch: "main" }),
			getNode: async () => node,
			findNodesByLinear: async () => [{ ...node, repo: "swcstudiospace/x", branch: "main", graph_status: "open" }],
		};
		const mirror = {
			issueText: async () => ({ ok: true, identifier: "SWC-467", title: "Do the thing", description: null }),
		};
		const greptime = {
			ensureAppendMode: async () => true,
			lastHash: async (): Promise<string | null> => null,
			insertEvent: async (event: SubstrateEvent) => {
				written.push(event);
			},
		};
		const substrate = new Substrate(loadConfig({}), {
			index: index as never,
			greptime: greptime as never,
			mirror: mirror as never,
		});
		const server = createMcpServer(substrate, "omp");
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		return { client, written };
	}

	test("both read tools are listed", async () => {
		const { client } = await readClient();
		const tools = (await client.listTools()).tools;
		const byName = new Map(tools.map((tool) => [tool.name, tool]));

		expect(byName.has("graph_find")).toBe(true);
		expect(byName.has("issue_get")).toBe(true);
	});

	test("graph_find without either ref is refused, and issue_get resolves through the service", async () => {
		const { client, written } = await readClient();

		const refused = await call(client, "graph_find", {});
		expect(refused.json()).toEqual({ found: false, reason: "provide linear_issue_id or linear_identifier" });

		const found = await call(client, "graph_find", { linear_issue_id: "uuid-SWC-467" });
		expect(found.json()).toMatchObject({ found: true, graph_id: "ut-1", node_id: "n2" });
		expect(JSON.stringify(found.json())).not.toContain("lse_9");

		const issue = await call(client, "issue_get", { graph_id: "ut-1", node_id: "n2" });
		expect(issue.json()).toMatchObject({ found: true, identifier: "SWC-467", title: "Do the thing" });

		// Neither read tool emits.
		expect(written).toEqual([]);
	});
});

