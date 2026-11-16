/**
 * The MCP tool surface, driven through a real client.
 *
 * `/mcp` is what a desk seat actually calls, so the tools are exercised over the
 * protocol rather than by calling the service directly: a tool that is missing,
 * mis-schemad or wired to the wrong argument fails here and nowhere else. The
 * ledger underneath is a stub — the point is the wiring, not Greptime.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReadThroughCache, type CacheRedis } from "./cache.ts";
import { loadConfig } from "./config.ts";
import type { EventQuery } from "./greptime.ts";
import { createMcpServer, ingestRefusalIsGate, resetRagMachine } from "./mcp.ts";
import { Substrate } from "./service.ts";
import { auditToolCalls, createObservability } from "./observe.ts";
import { createTestLiveSessionAuthority } from "./planning/live-session.test-support.ts";
import { reposSeam } from "./planning/tree.fixtures.ts";
import type { PlanningFs } from "./planning/index.ts";
import { withoutHindsightEnv } from "./test-support.ts";
import { HindsightFake } from "./hindsight-fake.ts";
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
			graphChainLeafHours: async () => [],
			// No ingest table concept here: with no coverage start every event
			// is pre-coverage legacy, so the hour report stays empty.
			graphIngest: async () => [],
			firstIngestMs: async () => null,
		},
	};
}

/** A connected client and the substrate behind it. Closed by the test runner's teardown. */
async function connect(
	greptime: unknown,
	surface: Surface | null = "omp",
	env: Record<string, string> = {},
	deps: { cache?: ReadThroughCache; lightragFetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; planning?: { fs: PlanningFs; presence: null } } = {},
) {
	const config = loadConfig(env);
	const authority = createTestLiveSessionAuthority();
	const observability = createObservability(config, {});
	const substrate = new Substrate(config, { index: null, greptime: greptime as never, steering: { history: null, liveSessions: authority }, ...deps }, observability.observer, {
		auditCalls: (caller, calls, transport) => auditToolCalls(observability, caller.surface, calls, transport),
	});
	const server = createMcpServer(substrate, surface);
	const client = new Client({ name: "substrate-test", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, substrate, authority, observability };
}

/** Another caller on a substrate that already exists: the steering sessions live on the substrate, so two callers meet there. */
async function attach(substrate: Substrate, surface: Surface | null) {
	const server = createMcpServer(substrate, surface);
	const client = new Client({ name: "substrate-test", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
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
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never, steering: { history: null, liveSessions: null } });
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
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: ledger().greptime as never, steering: { history: null, liveSessions: null } });
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
		/** The per-call read options each search arrived with (uplift-3 N4). */
		const reads: unknown[] = [];
		const entry = { id: "mem_1", scope: "repo:acme/widgets", kind: "fact", text: "x", created: "2026-10-01T00:00:00.000Z" };
		return {
			plain,
			paged,
			reads,
			index: {
				searchMemory: async (...args: unknown[]) => {
					plain.push(args.slice(0, 4));
					reads.push(args[4]);
					return [entry];
				},
				searchMemoryPage: async (search: Record<string, unknown>, read: unknown) => {
					paged.push(search);
					reads.push(read);
					return { entries: [entry], next: { before: "2026-10-01T00:00:00.123456Z", before_id: "mem_1" } };
				},
			},
		};
	}

	async function connectIndex(index: unknown, caller: Surface | { surface: Surface; isOperator: boolean } = "omp", greptime: unknown = null) {
		const substrate = new Substrate(loadConfig({}), { index: index as never, greptime: greptime as never, steering: { history: null, liveSessions: null } });
		const server = createMcpServer(substrate, caller);
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		return client;
	}

	test("with neither new parameter, the reply carries index entries plus derived plane hits", async () => {
		const stub = searchIndex();
		const client = await connectIndex(stub.index);
		const reply = await call(client, "memory_search", { query: "lease", scope: "repo:acme/widgets", limit: 5 });

		expect(reply.isError).toBe(false);
		expect(reply.json()).toMatchObject({ entries: [{ id: "mem_1" }], derived: [], degraded: false });
		expect(stub.plain).toEqual([["lease", "repo:acme/widgets", 5, undefined]]);
		// The read is attributed to the caller and asks for nothing past its lifetime.
		expect(stub.reads).toEqual([{ surface: "omp" }]);
		expect(stub.paged).toEqual([]);
	});

	test("include_expired is an operator action: refused for a surface token before any read, honoured for an operator on both shapes", async () => {
		const agent = searchIndex();
		const client = await connectIndex(agent.index);
		for (const args of [
			{ query: "lease", include_expired: true },
			{ subject_prefix: "lesson:", include_expired: true },
		]) {
			const reply = await call(client, "memory_search", args);
			expect(reply.isError).toBe(true);
			expect(reply.json().error).toContain("operator");
			expect(reply.json().error).toContain("SUBSTRATE_OPERATOR_TOKENS");
		}
		expect(agent.reads).toEqual([]);
		// `false` is not a request: the plain read runs as it always did.
		const plainReply = await call(client, "memory_search", { query: "lease", include_expired: false });
		expect(plainReply.isError).toBe(false);
		expect(agent.reads).toEqual([{ surface: "omp" }]);

		const operator = searchIndex();
		const privileged = await connectIndex(operator.index, { surface: "omp", isOperator: true });
		const listed = await call(privileged, "memory_search", { query: "lease", include_expired: true });
		expect(listed.isError).toBe(false);
		const page = await call(privileged, "memory_search", { subject_prefix: "lesson:", include_expired: true });
		expect(page.isError).toBe(false);
		expect(operator.reads).toEqual([
			{ surface: "omp", includeExpired: true },
			{ surface: "omp", includeExpired: true },
		]);
		// The index's own search arguments never carry the flag: it travels as a read option, so the paged shape is untouched.
		expect(operator.paged[0]).not.toHaveProperty("includeExpired");
		expect(operator.paged[0]).not.toHaveProperty("include_expired");
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

	/** A ledger row as `readEvents` returns it; `second` orders the rows and forms the id's place in them. */
	function ledgerRow(id: string, second: number, over: Record<string, unknown>): Record<string, unknown> {
		return {
			id,
			ts: `2026-10-01T00:00:${String(second).padStart(2, "0")}.000Z`,
			kind: "note",
			surface: "omp",
			node_id: "n1",
			summary: `summary ${id}`,
			...over,
		};
	}

	/** Nine events of one session in one graph, `ev-1` the oldest. */
	const sessionRows = Array.from({ length: 9 }, (_, i) => ledgerRow(`ev-${i + 1}`, i + 1, { session_id: "s-1", graph_id: "ut-1" }));
	const NEWEST_FIVE = [{ id: "ev-9" }, { id: "ev-8" }, { id: "ev-7" }, { id: "ev-6" }, { id: "ev-5" }];

	/** A ledger stub: `readRecentEvents` filters by the column asked, answers newest first cut to the limit, and logs each read and limit; `hang` and `fail` model a stalled or broken plane. */
	function readLedger(rows: Array<Record<string, unknown>>, mode: "answer" | "hang" | "fail" = "answer") {
		const reads: string[] = [];
		const limits: number[] = [];
		return {
			reads,
			limits,
			greptime: {
				readRecentEvents: async (column: string, value: string, limit: number) => {
					reads.push(`${column}=${value}`);
					limits.push(limit);
					if (mode === "hang") return new Promise<never>(() => {});
					if (mode === "fail") throw new Error("greptime unreachable: connect ETIMEDOUT");
					const key = (row: Record<string, unknown>) => `${String(row.ts)}|${String(row.id)}`;
					const newest = rows.filter((row) => row[column] === value).sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
					return newest.slice(0, limit);
				},
			},
		};
	}

	/** An index that answers every search, plain or paged, with the given entries. */
	function entriesIndex(entries: Array<Record<string, unknown>>) {
		return {
			searchMemory: async () => entries,
			searchMemoryPage: async () => ({ entries, next: null }),
		};
	}

	function memoryAt(id: string, over: Record<string, unknown>): Record<string, unknown> {
		return { id, scope: "repo:acme/widgets", kind: "fact", text: "x", created: "2026-10-01T00:00:00.000Z", ...over };
	}

	test("with neither option the reply has no ledger keys, and the ledger is not read", async () => {
		const { reads, greptime } = readLedger(sessionRows);
		const entries = [memoryAt("mem_a", { graph_id: "ut-1", session_id: "s-1", source_event: "ev-8" })];
		const client = await connectIndex(entriesIndex(entries), "omp", greptime);

		const plain = await call(client, "memory_search", { query: "lease" });
		const explicit = await call(client, "memory_search", { query: "lease", graph_linked: false, causal: false });

		expect(plain.isError).toBe(false);
		for (const key of ["graph_links", "graph_links_notice", "causal_notice"]) {
			expect(plain.json()).not.toHaveProperty(key);
		}
		expect(plain.text).not.toContain("causal_chain");
		expect(explicit.text).toBe(plain.text);
		expect(reads).toEqual([]);
	});

	test("graph_linked gives each returned graph its newest ledger events, reads each graph once, and an empty list for a graph with none", async () => {
		const { reads, greptime } = readLedger(sessionRows);
		const entries = [memoryAt("mem_a", { graph_id: "ut-1" }), memoryAt("mem_b", { graph_id: "ut-2" }), memoryAt("mem_c", { graph_id: "ut-1" })];
		const client = await connectIndex(entriesIndex(entries), "omp", greptime);

		const reply = await call(client, "memory_search", { query: "lease", graph_linked: true });

		expect(reply.isError).toBe(false);
		expect(reply.json()).toMatchObject({
			entries: [{ id: "mem_a" }, { id: "mem_b" }, { id: "mem_c" }],
			graph_links: [
				{ graph_id: "ut-1", events: NEWEST_FIVE },
				{ graph_id: "ut-2", events: [] },
			],
		});
		expect(reply.json().graph_links_notice).toEqual(expect.stringContaining("untrusted"));
		expect(reply.text).not.toContain("causal_chain");
		expect(reads).toEqual(["graph_id=ut-1", "graph_id=ut-2"]);
	});

	test("causal gives an entry with a source event the events that preceded it in its session, nearest first, and an empty chain otherwise", async () => {
		const { reads, greptime } = readLedger(sessionRows);
		const entries = [
			memoryAt("mem_causal", { session_id: "s-1", source_event: "ev-8" }),
			memoryAt("mem_none", { session_id: "s-1" }),
			memoryAt("mem_missing", { session_id: "s-1", source_event: "ev-99" }),
		];
		const client = await connectIndex(entriesIndex(entries), "omp", greptime);

		const reply = await call(client, "memory_search", { query: "lease", causal: true });

		expect(reply.isError).toBe(false);
		expect(reply.json()).toMatchObject({
			entries: [
				{ id: "mem_causal", causal_chain: [{ id: "ev-7" }, { id: "ev-6" }, { id: "ev-5" }, { id: "ev-4" }, { id: "ev-3" }] },
				{ id: "mem_none", causal_chain: [] },
				{ id: "mem_missing", causal_chain: [] },
			],
		});
		expect(reply.json().causal_notice).toEqual(expect.stringContaining("not proof of cause"));
		expect(reads).toEqual(["session_id=s-1"]);
	});

	test("the paged listing takes the same options", async () => {
		const { reads, greptime } = readLedger(sessionRows);
		const client = await connectIndex(entriesIndex([memoryAt("mem_a", { graph_id: "ut-1" })]), "omp", greptime);

		const reply = await call(client, "memory_search", { subject_prefix: "lesson:", graph_linked: true });

		expect(reply.isError).toBe(false);
		expect(reply.json()).toMatchObject({ entries: [{ id: "mem_a" }], next: null, graph_links: [{ graph_id: "ut-1", events: NEWEST_FIVE }] });
		expect(reads).toEqual(["graph_id=ut-1"]);
	});

	test("a hanging ledger read is released at its budget with a reason, and the search still answers", async () => {
		const { greptime } = readLedger(sessionRows, "hang");
		const client = await connectIndex(entriesIndex([memoryAt("mem_a", { graph_id: "ut-1" })]), "omp", greptime);

		const started = Date.now();
		const reply = await call(client, "memory_search", { query: "lease", graph_linked: true });
		const elapsed = Date.now() - started;

		expect(elapsed).toBeLessThan(2500);
		expect(reply.json()).toMatchObject({
			entries: [{ id: "mem_a" }],
			degraded: true,
			reason: expect.stringContaining("ledger: graph reads timed out"),
			graph_links: [],
		});
	});

	test("a failed ledger read drops only its part of the reply and names the failure", async () => {
		const { greptime } = readLedger(sessionRows, "fail");
		const client = await connectIndex(entriesIndex([memoryAt("mem_a", { session_id: "s-1", source_event: "ev-8" })]), "omp", greptime);

		const reply = await call(client, "memory_search", { query: "lease", causal: true });

		expect(reply.json()).toMatchObject({ entries: [{ id: "mem_a" }], degraded: true });
		expect(String(reply.json().reason)).toContain("ledger: session reads failed");
		expect(reply.text).not.toContain("causal_chain");
	});

	test("graph reads are capped at eight distinct graphs, each asking for five events, and the reply names the cap", async () => {
		const { reads, limits, greptime } = readLedger(sessionRows);
		const entries = Array.from({ length: 10 }, (_, i) => memoryAt(`mem_${i}`, { graph_id: `ut-${i + 1}` }));
		const client = await connectIndex(entriesIndex(entries), "omp", greptime);

		const reply = await call(client, "memory_search", { query: "lease", graph_linked: true });

		expect(reads).toEqual(Array.from({ length: 8 }, (_, i) => `graph_id=ut-${i + 1}`));
		expect(limits).toEqual(Array.from({ length: 8 }, () => 5));
		expect(reply.json()).toMatchObject({ degraded: true, reason: expect.stringContaining("ledger: graph reads capped at 8 of 10") });
		expect(reply.json().graph_links).toHaveLength(8);
	});

	test("session reads are capped at eight distinct sessions, and the reply names the cap", async () => {
		const { reads, greptime } = readLedger(sessionRows);
		const entries = Array.from({ length: 10 }, (_, i) => memoryAt(`mem_${i}`, { session_id: `s-${i + 1}`, source_event: "ev-8" }));
		const client = await connectIndex(entriesIndex(entries), "omp", greptime);

		const reply = await call(client, "memory_search", { query: "lease", causal: true });

		expect(reads).toHaveLength(8);
		expect(reply.json()).toMatchObject({ degraded: true, reason: expect.stringContaining("ledger: session reads capped at 8 of 10") });
	});

	test("causal reads the newest 200 session events, so an older source gets an empty chain and the notice says so", async () => {
		const longSession = Array.from({ length: 205 }, (_, i) => ({
			...ledgerRow(`ev-${i + 1}`, 1, { session_id: "s-long", graph_id: "ut-1" }),
			ts: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(),
		}));
		const { limits, greptime } = readLedger(longSession);
		const entries = [
			memoryAt("mem_old", { session_id: "s-long", source_event: "ev-3" }),
			memoryAt("mem_new", { session_id: "s-long", source_event: "ev-205" }),
		];
		const client = await connectIndex(entriesIndex(entries), "omp", greptime);

		const reply = await call(client, "memory_search", { query: "lease", causal: true });

		expect(limits).toEqual([200]);
		expect(reply.json()).toMatchObject({
			entries: [
				{ id: "mem_old", causal_chain: [] },
				{ id: "mem_new", causal_chain: [{ id: "ev-204" }, { id: "ev-203" }, { id: "ev-202" }, { id: "ev-201" }, { id: "ev-200" }] },
			],
		});
		expect(reply.json().causal_notice).toEqual(expect.stringContaining("newest 200 events"));
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
		if (!tool) throw new Error("skills_propose is not registered");
		expect(tool.annotations).toMatchObject({ destructiveHint: false, openWorldHint: true });
		const properties = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
		expect(properties.sort()).toEqual(
			["allow_doc_examples", "dry_run", "expected_version", "files", "graph_id", "mode", "name", "rationale", "remove", "reopen", "session_id", "surface"].sort(),
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
		expect(reply.json()).toEqual({ error: refusal.message, findings: [{ file: "SKILL.md", line: 4, rule: "github" }], refused: true });
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
		const { pr_url: _opened, ...withoutUrl } = opened;
		const dry: ProposeResult = { ...withoutUrl, status: "dry_run", diff_added: 1, diff_changed: 0, diff_deleted: 0 };
		const { client, calls, written } = await proposing(dry);
		const reply = await call(client, "skills_propose", { ...args, dry_run: true });

		expect(reply.json()).toMatchObject({ status: "dry_run", diff_added: 1 });
		expect(calls[0]?.opts.dryRun).toBe(true);
		expect(written).toEqual([]);
	});

	test("a body over the 1 MB cap is a refused tool error before the service, and one at the cap goes through", async () => {
		const { client, calls } = await proposing(opened);
		const bare = Buffer.byteLength(JSON.stringify({ ...args, rationale: "" }), "utf8");

		const over = await call(client, "skills_propose", { ...args, rationale: "x".repeat(1_000_001 - bare) });
		expect(over.isError).toBe(true);
		expect(over.json()).toEqual({ refused: true, error: "the proposal is 1000001 bytes as JSON, over the limit of 1000000 bytes" });
		expect(calls).toEqual([]);

		const atCap = await call(client, "skills_propose", { ...args, rationale: "x".repeat(1_000_000 - bare) });
		expect(atCap.isError).toBe(false);
		expect(calls).toHaveLength(1);
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
			steering: { history: null, liveSessions: null },
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

describe("docs_steering_session issued authority", () => {
	test("state-only transitions preserve private fields without publishing them in transition events", async () => {
		const stub = ledger();
		const { client, authority } = await connect(stub.greptime);
		const active = await call(client, "docs_steering_session", {
			repo_id: "owner/name", state: "ACTIVE", steering: "PRIVATE-CARRY-DIRECTION", planning_hash: "PRIVATE-CARRY-PLAN",
		});
		expect(active.isError).toBe(false);
		const issued = active.json();
		expect(issued.status).toBe("issued");
		expect(issued.session_id).toMatch(/^ls_[a-f0-9]{64}$/);
		expect(issued.session_binding).toMatch(/^[a-f0-9]{64}$/);
		const base = { session_id: issued.session_id, session_binding: issued.session_binding, repo_id: "owner/name" };
		const refreshed = await call(client, "docs_steering_session", { ...base, state: "CONTEXT_REFRESH" });
		expect(refreshed).toMatchObject({ isError: false });
		expect(refreshed.json()).toMatchObject({ status: "updated", state: "CONTEXT_REFRESH" });
		const access = { caller: { surface: "omp", isOperator: false } as const, sessionId: String(issued.session_id), sessionBinding: String(issued.session_binding) };
		const carried = await authority.read(access, "private-read");
		expect(carried.ok && carried.snapshot.session).toMatchObject({ steering: "PRIVATE-CARRY-DIRECTION", planning_hash: "PRIVATE-CARRY-PLAN" });
		const replaced = await call(client, "docs_steering_session", { ...base, state: "PAUSED", steering: "PRIVATE-REPLACED-DIRECTION" });
		expect(replaced.json()).toMatchObject({ status: "updated", state: "PAUSED" });
		expect(replaced.text).not.toContain("PRIVATE-");
		expect(replaced.json()).not.toHaveProperty("session_binding");
		const read = await authority.read({ caller: { surface: "omp", isOperator: false }, sessionId: String(issued.session_id), sessionBinding: String(issued.session_binding) }, "private-read");
		expect(read.ok && read.snapshot.session).toMatchObject({ state: "PAUSED", steering: "PRIVATE-REPLACED-DIRECTION", planning_hash: "PRIVATE-CARRY-PLAN" });
		for (const event of stub.written.filter((event) => event.payload.action === "docs.steering")) {
			expect(Object.keys(event.payload).sort()).toEqual(["action", "non_blocking", ...(event.payload.previous_state === undefined ? [] : ["previous_state"]), "repo_id", "session_id", "state", "updated_at"]);
			expect(JSON.stringify(event)).not.toContain("PRIVATE-");
			expect(JSON.stringify(event)).not.toContain(String(issued.session_binding));
		}
	});

	test("anonymous, sibling missing/wrong proof, foreign and unissued updates share not-found", async () => {
		const owner = await connect(ledger().greptime, "claude-code");
		const active = (await call(owner.client, "docs_steering_session", { repo_id: "owner/name", state: "ACTIVE", steering: "PRIVATE-OWNER-DIRECTION" })).json();
		const base = { session_id: active.session_id, repo_id: "owner/name", state: "PAUSED" };
		const sibling = await attach(owner.substrate, "claude-code");
		const foreign = await attach(owner.substrate, "hermes");
		const anonymous = await attach(owner.substrate, null);
		for (const [client, args] of [
			[anonymous, base],
			[sibling, base],
			[sibling, { ...base, session_binding: "f".repeat(64) }],
			[foreign, { ...base, session_binding: active.session_binding }],
			[owner.client, { ...base, session_id: `ls_${"e".repeat(64)}`, session_binding: active.session_binding }],
		] as const) {
			const denied = await call(client, "docs_steering_session", args);
			expect(denied.isError).toBe(true);
			expect(denied.json()).toEqual({ status: "refused", error: { code: "not-found" } });
			expect(denied.text).not.toContain("PRIVATE-OWNER-DIRECTION");
		}
		const after = await call(owner.client, "docs_steering_session", { ...base, state: "CONTEXT_REFRESH", previous_state: "ACTIVE", session_binding: active.session_binding });
		expect(after.isError).toBe(false);
		expect(after.json()).toMatchObject({ state: "CONTEXT_REFRESH" });
		const held = await owner.authority.read({ caller: { surface: "claude-code", isOperator: false }, sessionId: String(active.session_id), sessionBinding: String(active.session_binding) }, "private-read");
		expect(held.ok && held.snapshot.session).toMatchObject({ steering: "PRIVATE-OWNER-DIRECTION" });
	});

	test("an independent authority cannot adopt a public handle issued elsewhere", async () => {
		const first = await connect(ledger().greptime);
		const second = await connect(ledger().greptime);
		const active = (await call(first.client, "docs_steering_session", { repo_id: "owner/name", state: "ACTIVE" })).json();
		const claim = await call(second.client, "docs_steering_session", { session_id: active.session_id, session_binding: active.session_binding, repo_id: "owner/name", state: "PAUSED", previous_state: "ACTIVE" });
		expect(claim.isError).toBe(true);
		expect(claim.json()).toEqual({ status: "refused", error: { code: "not-found" } });
		expect((await first.authority.read({ caller: { surface: "omp", isOperator: false }, sessionId: String(active.session_id), sessionBinding: String(active.session_binding) }, "private-read")).ok).toBe(true);
	});
});

/** A LightRAG reply the query surface parses into one chunk. */
function lightragAnswer(): Response {
	return Response.json({ data: [{ content: "A LightRAG chunk.", document_name: "docs/planning.md", source_url: "https://example.com/planning" }] });
}

/** Replaces the global fetch, which the LightRAG client uses by default, with `answer`. The caller restores it. */
function stubFetch(answer: () => Promise<Response>): { count: () => number } {
	let calls = 0;
	globalThis.fetch = (async () => {
		calls += 1;
		return answer();
	}) as unknown as typeof fetch;
	return { count: () => calls };
}

const PAGE_FOR_INGEST = {
	path: "docs/data-planes.md",
	source_url: "https://example.com/agent-substrate/data-planes",
	body: "The substrate is the only door to the data planes.",
};
const LIGHTRAG_QUERY_ENV = { LIGHTRAG_URL: "http://lightrag.test", SUBSTRATE_RAG_MAX_RETRIES: "0", SUBSTRATE_RAG_HALF_OPEN_MS: "0" };
const LIGHTRAG_INGEST_ENV = { LIGHTRAG_URL: "http://lightrag.test", SUBSTRATE_RAG_HALF_OPEN_MS: "60000" };
const LIGHTRAG_BREAKER_ENV = { LIGHTRAG_URL: "http://lightrag.test", SUBSTRATE_RAG_MAX_RETRIES: "0", SUBSTRATE_RAG_HALF_OPEN_MS: "60000" };

describe("docs_ingest refusals do not count against the RAG breaker", () => {
	const realFetch = globalThis.fetch;
	beforeEach(() => resetRagMachine());
	afterEach(() => {
		globalThis.fetch = realFetch;
		resetRagMachine();
	});

	test("several version.stale and outside-roots refusals leave the machine out of ERROR, and the next query is served", async () => {
		const plane = stubFetch(async () => lightragAnswer());
		const seam = reposSeam(["agent-substrate"]);
		const { client } = await connect(ledger().greptime, "omp", { ...LIGHTRAG_INGEST_ENV, ...seam.env }, seam.stores);
		const stale = { path: "docs/data-planes.md", source_url: "https://example.com/agent-substrate/data-planes", body: "A page.", expected_version: 1 };
		const outside = { path: "secrets/keys.md", source_url: "https://example.com/agent-substrate/keys", body: "Keys." };

		for (const [page, reason] of [
			[stale, "version.stale"],
			[stale, "version.stale"],
			[outside, "outside-roots"],
		] as const) {
			const refused = await call(client, "docs_ingest", { dataset: "agent-substrate", pages: [page] });
			expect(refused.isError).toBe(true);
			expect(refused.text).toContain(reason);
		}

		const before = (await call(client, "docs_rag_state")).json();
		expect(before.state).not.toBe("ERROR");
		expect(before.consecutiveFailures).toBe(0);

		const served = await call(client, "docs_lightrag_query", { question: "asked after the refusals" });
		expect(served.json()).toMatchObject({ backend: "lightrag", chunks: [expect.objectContaining({ content: "A LightRAG chunk." })] });
		expect(served.json().fallback).toBeUndefined();
		expect(plane.count()).toBe(1);
	});

	test("a plane error still counts: three failed uploads open the breaker", async () => {
		stubFetch(async () => new Response("upstream down", { status: 500 }));
		const seam = reposSeam(["agent-substrate"]);
		const { client } = await connect(ledger().greptime, "omp", { ...LIGHTRAG_INGEST_ENV, ...seam.env }, seam.stores);

		for (const n of [1, 2, 3]) {
			const failed = await call(client, "docs_ingest", {
				dataset: "agent-substrate",
				pages: [{ ...PAGE_FOR_INGEST, source_url: `https://example.com/agent-substrate/down-${n}` }],
			});
			expect(failed.isError).toBe(true);
		}
		expect((await call(client, "docs_rag_state")).json().state).toBe("ERROR");
	});

	test("a refusal for a dataset with no lightrag configured never reaches a plane, so the machine stays out of ERROR", async () => {
		const { client } = await connect(ledger().greptime, "omp", {});

		for (const n of [1, 2, 3, 4]) {
			const refused = await call(client, "docs_ingest", {
				dataset: "agent-substrate",
				pages: [{ ...PAGE_FOR_INGEST, source_url: `https://example.com/agent-substrate/unconfigured-${n}` }],
			});
			expect(refused.isError).toBe(true);
			expect(refused.json()).toMatchObject({ ok: false, reason: "lightrag-not-configured" });
		}

		const state = (await call(client, "docs_rag_state")).json();
		expect(state.state).not.toBe("ERROR");
		expect(state.consecutiveFailures).toBe(0);
	});

	test("a docs_ingest call, refused or served, does not move an open breaker: the next query inside the cooldown is refused without a backend call", async () => {
		let queries = 0;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname === "/query") {
				queries += 1;
				return new Response("upstream down", { status: 500 });
			}
			if (init?.method === "POST" && url.pathname === "/documents/upload") return Response.json({ status: "success", data: { track_id: "trk-1" } });
			if (init?.method === "POST" && url.pathname === "/documents/scan") return Response.json({ status: "success" });
			if (url.pathname === "/documents/pipeline_status") return Response.json({ status: "idle" });
			if (url.pathname.startsWith("/documents/track_status/")) return Response.json({ documents: [{ id: `doc-${url.pathname.split("/").pop()}`, status: "processed" }], total_count: 1 });
			return Response.json({ detail: "no route" }, { status: 404 });
		}) as unknown as typeof fetch;
		const seam = reposSeam(["agent-substrate"]);
		const { client } = await connect(ledger().greptime, "omp", { ...LIGHTRAG_BREAKER_ENV, ...seam.env }, seam.stores);
		for (const question of ["trip one", "trip two", "trip three"]) {
			expect((await call(client, "docs_lightrag_query", { question })).json().fallback).toBe("hindsight");
		}
		expect((await call(client, "docs_rag_state")).json().state).toBe("ERROR");
		const queriesWhenOpen = queries;

		const refused = await call(client, "docs_ingest", {
			dataset: "agent-substrate",
			pages: [{ path: "secrets/keys.md", source_url: "https://example.com/agent-substrate/keys", body: "Keys." }],
		});
		expect(refused.isError).toBe(true);
		expect((await call(client, "docs_rag_state")).json().state).toBe("ERROR");

		const served = await call(client, "docs_ingest", { dataset: "agent-substrate", pages: [PAGE_FOR_INGEST] });
		expect(served.isError).toBe(false);
		expect((await call(client, "docs_rag_state")).json().state).toBe("ERROR");

		const inside = await call(client, "docs_lightrag_query", { question: "asked inside the cooldown" });
		expect(inside.json().fallback).toBe("hindsight");
		expect(queries).toBe(queriesWhenOpen);
	});

	test("the refusals that never reach a plane are gate refusals, and a plane error is not", () => {
		for (const reason of ["dataset-lock-timeout", "lightrag-not-configured", "lightrag-not-configured", "version.stale"]) {
			expect(ingestRefusalIsGate(reason)).toBe(true);
		}
		expect(ingestRefusalIsGate("lightrag 500")).toBe(false);
		expect(ingestRefusalIsGate("parse-timeout")).toBe(false);
	});
});

describe("the RAG breaker admits one half-open probe", () => {
	const realFetch = globalThis.fetch;
	let restoreHindsightEnv: () => void = () => {};
	beforeEach(() => {
		restoreHindsightEnv = withoutHindsightEnv();
	});
	beforeEach(() => resetRagMachine());
	afterEach(() => {
		globalThis.fetch = realFetch;
		resetRagMachine();
		restoreHindsightEnv();
	});

	test("after the cooldown, two concurrent queries produce one backend attempt", async () => {
		let attempts = 0;
		const probeReply = Promise.withResolvers<Response>();
		const probeReached = Promise.withResolvers<void>();
		globalThis.fetch = (async () => {
			attempts += 1;
			if (attempts <= 3) return new Response("upstream down", { status: 500 });
			if (attempts === 4) {
				probeReached.resolve();
				return probeReply.promise;
			}
			return new Response("upstream down", { status: 500 });
		}) as unknown as typeof fetch;

		// A zero cooldown has already elapsed, so the query after ERROR is the probe; no timer is needed.
		const { client } = await connect(ledger().greptime, "omp", LIGHTRAG_QUERY_ENV);
		for (const question of ["drive one", "drive two", "drive three"]) {
			expect((await call(client, "docs_lightrag_query", { question })).json().fallback).toBe("hindsight");
		}
		expect((await call(client, "docs_rag_state")).json().state).toBe("ERROR");

		const probe = call(client, "docs_lightrag_query", { question: "the probe" });
		await probeReached.promise;
		const burst = await call(client, "docs_lightrag_query", { question: "the burst" });
		expect(burst.json().fallback).toBe("hindsight");
		expect(attempts).toBe(4);

		probeReply.resolve(lightragAnswer());
		const probed = (await probe).json();
		expect(probed).toMatchObject({ backend: "lightrag" });
		expect(probed.fallback).toBeUndefined();
		expect(attempts).toBe(4);
		expect((await call(client, "docs_rag_state")).json().state).toBe("IDLE");
	});
});

describe("a docs_search is the RAG breaker's half-open probe", () => {
	const realFetch = globalThis.fetch;
	let restoreHindsightEnv: () => void = () => {};
	beforeEach(() => {
		restoreHindsightEnv = withoutHindsightEnv();
	});
	beforeEach(() => resetRagMachine());
	afterEach(() => {
		globalThis.fetch = realFetch;
		resetRagMachine();
		restoreHindsightEnv();
	});

	test("after the cooldown, one successful docs_search moves the machine out of ERROR", async () => {
		let planeHealthy = false;
		globalThis.fetch = (async () => (planeHealthy ? lightragAnswer() : new Response("upstream down", { status: 500 }))) as unknown as typeof fetch;

		// A zero cooldown has already elapsed, so the search after ERROR is the probe; no timer is needed.
		const { client } = await connect(ledger().greptime, "omp", LIGHTRAG_QUERY_ENV);
		for (const question of ["search one", "search two", "search three"]) {
			expect((await call(client, "docs_search", { question })).json().degraded).toBe(true);
		}
		expect((await call(client, "docs_rag_state")).json().state).toBe("ERROR");

		planeHealthy = true;
		const probed = (await call(client, "docs_search", { question: "the probe" })).json();
		expect(probed.degraded).toBeUndefined();
		expect((await call(client, "docs_rag_state")).json().state).toBe("IDLE");
	});

	/** An in-memory redis for the answer cache: without one the cache is off and every search loads. */
	class MemoryRedis implements CacheRedis {
		readonly values = new Map<string, string>();
		async get(key: string): Promise<string | null> {
			return this.values.get(key) ?? null;
		}
		async set(key: string, value: string): Promise<void> {
			this.values.set(key, value);
		}
		async incr(key: string): Promise<number> {
			const next = Number(this.values.get(key) ?? "0") + 1;
			this.values.set(key, String(next));
			return next;
		}
	}

	test("a cached answer cannot clear ERROR: the probe reaches the plane even for a repeated question", async () => {
		let planeHealthy = true;
		let planeCalls = 0;
		globalThis.fetch = (async () => {
			planeCalls += 1;
			return planeHealthy ? lightragAnswer() : new Response("upstream down", { status: 500 });
		}) as unknown as typeof fetch;

		// A zero cooldown has already elapsed, so the search after ERROR is the probe; no timer is needed.
		const { client } = await connect(ledger().greptime, "omp", LIGHTRAG_QUERY_ENV, { cache: new ReadThroughCache({ redis: new MemoryRedis(), enabled: true, log: () => {} }) });
		// Populates the cache with a healthy, non-degraded reply for the question the probe repeats.
		expect((await call(client, "docs_search", { question: "the cached question" })).json().degraded).toBeUndefined();

		planeHealthy = false;
		for (const question of ["search one", "search two", "search three"]) {
			expect((await call(client, "docs_search", { question })).json().degraded).toBe(true);
		}
		expect((await call(client, "docs_rag_state")).json().state).toBe("ERROR");

		planeHealthy = true;
		const before = planeCalls;
		const probed = (await call(client, "docs_search", { question: "the cached question" })).json();
		expect(probed.degraded).toBeUndefined();
		expect(planeCalls).toBeGreaterThan(before);
		expect((await call(client, "docs_rag_state")).json().state).toBe("IDLE");
	});

	test("a docs_search inside the cooldown does not ask LightRAG: it answers degraded and the plane sees no request", async () => {
		let planeCalls = 0;
		globalThis.fetch = (async () => {
			planeCalls += 1;
			return new Response("upstream down", { status: 500 });
		}) as unknown as typeof fetch;
		// A 60 s cooldown: it cannot elapse during the test, so ERROR holds until the assertions say otherwise.
		const { client } = await connect(ledger().greptime, "omp", LIGHTRAG_BREAKER_ENV);
		for (const question of ["trip one", "trip two", "trip three"]) {
			expect((await call(client, "docs_lightrag_query", { question })).json().fallback).toBe("hindsight");
		}
		expect((await call(client, "docs_rag_state")).json().state).toBe("ERROR");
		const tripped = planeCalls;

		const inside = (await call(client, "docs_search", { question: "asked inside the cooldown" })).json();
		expect(inside).toMatchObject({ degraded: true, reason: "rag breaker open" });
		expect(planeCalls).toBe(tripped);
		expect((await call(client, "docs_rag_state")).json().state).toBe("ERROR");
	});

	test("a docs_search inside the cooldown is answered from the cache for its question, and the plane is not asked", async () => {
		let planeHealthy = true;
		let planeCalls = 0;
		globalThis.fetch = (async () => {
			planeCalls += 1;
			return planeHealthy ? lightragAnswer() : new Response("upstream down", { status: 500 });
		}) as unknown as typeof fetch;
		const { client } = await connect(ledger().greptime, "omp", LIGHTRAG_BREAKER_ENV, { cache: new ReadThroughCache({ redis: new MemoryRedis(), enabled: true, log: () => {} }) });
		// Populates the cache with a healthy, non-degraded reply for the question the refused search repeats.
		expect((await call(client, "docs_search", { question: "the cached question" })).json().degraded).toBeUndefined();

		planeHealthy = false;
		for (const question of ["search one", "search two", "search three"]) {
			expect((await call(client, "docs_search", { question })).json().degraded).toBe(true);
		}
		expect((await call(client, "docs_rag_state")).json().state).toBe("ERROR");

		const before = planeCalls;
		const answered = (await call(client, "docs_search", { question: "the cached question" })).json();
		expect(answered.degraded).toBeUndefined();
		expect(answered.chunks).toHaveLength(1);
		expect(planeCalls).toBe(before);
	});

});

describe("a half-open probe is settled only by its own report", () => {
	const realFetch = globalThis.fetch;
	beforeEach(() => resetRagMachine());
	afterEach(() => {
		globalThis.fetch = realFetch;
		resetRagMachine();
	});

	test("a successful ingest during the probe keeps the failure count, and a probe that then fails re-trips the breaker", async () => {
		const probeReply = Promise.withResolvers<Response>();
		const probeReached = Promise.withResolvers<void>();
		let queries = 0;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname === "/query") {
				queries += 1;
				if (queries === 4) {
					probeReached.resolve();
					return probeReply.promise;
				}
				return new Response("upstream down", { status: 500 });
			}
			if (init?.method === "POST" && url.pathname === "/documents/upload") return Response.json({ status: "success", data: { track_id: "trk-1" } });
			if (init?.method === "POST" && url.pathname === "/documents/scan") return Response.json({ status: "success" });
			if (url.pathname === "/documents/pipeline_status") return Response.json({ status: "idle" });
			if (url.pathname.startsWith("/documents/track_status/")) return Response.json({ documents: [{ id: `doc-${url.pathname.split("/").pop()}`, status: "processed" }], total_count: 1 });
			return Response.json({ detail: "no route" }, { status: 404 });
		}) as unknown as typeof fetch;
		// A zero cooldown has already elapsed, so the query after ERROR is the probe; no timer is needed.
		const seam = reposSeam(["agent-substrate"]);
		const { client } = await connect(ledger().greptime, "omp", { ...LIGHTRAG_QUERY_ENV, ...seam.env }, seam.stores);
		for (const question of ["trip one", "trip two", "trip three"]) {
			expect((await call(client, "docs_lightrag_query", { question })).json().fallback).toBe("hindsight");
		}
		expect((await call(client, "docs_rag_state")).json().state).toBe("ERROR");

		const probe = call(client, "docs_lightrag_query", { question: "the probe" });
		await probeReached.promise;

		const ingested = await call(client, "docs_ingest", { dataset: "agent-substrate", pages: [PAGE_FOR_INGEST] });
		expect(ingested.isError).toBe(false);
		expect((await call(client, "docs_rag_state")).json()).toMatchObject({ state: "CONTEXT_REFRESH", consecutiveFailures: 3 });

		probeReply.resolve(new Response("upstream down", { status: 500 }));
		expect((await probe).json().fallback).toBe("hindsight");
		expect((await call(client, "docs_rag_state")).json()).toMatchObject({ state: "ERROR", consecutiveFailures: 4 });
	});
});

describe("docs_lightrag_query serves a Hindsight answer as degraded", () => {
	const realFetch = globalThis.fetch;
	beforeEach(() => resetRagMachine());
	afterEach(() => {
		globalThis.fetch = realFetch;
		resetRagMachine();
	});

	test("a chunked Hindsight answer to a failed LightRAG query is degraded and names the LightRAG failure", async () => {
		globalThis.fetch = (async () => new Response("upstream down", { status: 500 })) as unknown as typeof fetch;
		const hindsight = new HindsightFake();
		hindsight.seed("sub-omp", [{ id: "m1", text: "the plan lives in PLAN.md", document_id: "mwd_1", tags: ["omp"], metadata: {}, score: 0.9 }]);
		const substrate = new Substrate(
			loadConfig({ LIGHTRAG_URL: "http://lightrag.test", SUBSTRATE_RAG_MAX_RETRIES: "0", SUBSTRATE_RAG_HALF_OPEN_MS: "0" }),
			{ index: null, greptime: ledger().greptime as never, hindsightFetch: hindsight.fetch },
		);
		const server = createMcpServer(substrate, "omp");
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		const names = ["HINDSIGHT_URL", "HINDSIGHT_API_KEY", "HINDSIGHT_BANKS"] as const;
		const saved = names.map((name) => [name, process.env[name]] as const);
		process.env.HINDSIGHT_URL = "http://fake";
		process.env.HINDSIGHT_API_KEY = "test-bearer";
		process.env.HINDSIGHT_BANKS = "sub-omp";
		try {
			const reply = await call(client, "docs_lightrag_query", { question: "where is the plan?" });
			expect(reply.json()).toMatchObject({ degraded: true, fallback: "hindsight", reason: "lightrag 500" });
		} finally {
			for (const [name, value] of saved) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});

describe("docs_lightrag_query runs through the LightRAG plane client and its breaker", () => {
	beforeEach(() => resetRagMachine());
	afterEach(() => resetRagMachine());

	const BREAKER_TEST_ENV = {
		LIGHTRAG_URL: "http://lightrag.test",
		SUBSTRATE_RAG_MAX_RETRIES: "0",
		// The RAG machine would hold queries off after three failures; a higher threshold lets the plane breaker (five) trip first.
		SUBSTRATE_RAG_BREAKER_THRESHOLD: "50",
		SUBSTRATE_RAG_HALF_OPEN_MS: "0",
	};

	test("a failing server opens the lightrag breaker through the tool path, and an open breaker is neither called nor retried", async () => {
		const seen: Array<{ path: string; body: unknown; headers: Headers }> = [];
		const lightragFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			seen.push({ path: new URL(String(input)).pathname, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, headers: new Headers(init?.headers) });
			return new Response("upstream down", { status: 500 });
		};
		const { client, substrate } = await connect(ledger().greptime, "omp", { ...BREAKER_TEST_ENV, LIGHTRAG_API_KEY: "lr-tool-key" }, { lightragFetch });
		expect(substrate.planes.gate("lightrag").breaker?.state()).toBe("closed");
		for (const n of [1, 2, 3, 4, 5]) {
			const reply = await call(client, "docs_lightrag_query", { question: `failing question ${n}` });
			expect(reply.json()).toMatchObject({ fallback: "hindsight", reason: expect.stringContaining("lightrag 500") });
		}
		expect(seen).toHaveLength(5);
		expect(substrate.planes.gate("lightrag").breaker?.state()).toBe("open");

		const refused = await call(client, "docs_lightrag_query", { question: "asked while the breaker is open" });
		expect(refused.json()).toMatchObject({ fallback: "hindsight", reason: expect.stringContaining("lightrag circuit open") });
		// The open breaker refused the call before the server saw it.
		expect(seen).toHaveLength(5);

		// The tool goes through the plane client: its request body, mode default and auth header.
		expect(seen[0]?.path).toBe("/query");
		expect(seen[0]?.body).toEqual({ query: "failing question 1", mode: "hybrid", top_k: 10, only_need_context: true });
		expect(seen[0]?.headers.get("x-api-key")).toBe("lr-tool-key");
		expect(seen[0]?.headers.get("authorization")).toBeNull();
	});

	test("a leading /mix prefix and an explicit mode reach the server as the plane client resolves them", async () => {
		const bodies: unknown[] = [];
		const lightragFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
			return Response.json({ response: "context", llm_generated: false });
		};
		const { client } = await connect(ledger().greptime, "omp", BREAKER_TEST_ENV, { lightragFetch });
		const prefixed = await call(client, "docs_lightrag_query", { question: "/mix how do the planes relate?" });
		expect(prefixed.json()).toMatchObject({ backend: "lightrag" });
		await call(client, "docs_lightrag_query", { question: "an explicit mode question", mode: "local", top_k: 3 });
		expect(bodies).toEqual([
			{ query: "how do the planes relate?", mode: "mix", top_k: 10, only_need_context: true },
			{ query: "an explicit mode question", mode: "local", top_k: 3, only_need_context: true },
		]);
	});
});
