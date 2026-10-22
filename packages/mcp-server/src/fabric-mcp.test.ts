/**
 * The fabric tools (phase 51, SOTA-07), driven through a real MCP client. Railway is reached only through a
 * recording fake fetch, so nothing here makes a network call.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { auditMode } from "@substrate/audit";
import { toolClass } from "./admission.ts";
import { loadConfig } from "./config.ts";
import type { FabricSuggestion } from "./fabric/types.ts";
import { createMcpServer, type McpCaller } from "./mcp.ts";
import { railwayFromEnv, RailwayClient, type RailwayFetch } from "./railway.ts";
import { HEALTH_PROBE_MS, Substrate } from "./service.ts";

const TOKEN = "fabric-token-abc123";
const CALLER: McpCaller = { surface: "omp", isOperator: false };
const FABRIC_TOOLS = ["fabric_status", "fabric_optimize", "fabric_compliance"] as const;

/** A recording fake: every request is kept, and `answer` gives the `data` for each query. */
function recordingFetch(answer: (query: string) => unknown) {
	const calls: Array<{ body: string }> = [];
	const fetch: RailwayFetch = async (_input, init) => {
		calls.push({ body: init.body });
		const parsed: { query: string } = JSON.parse(init.body);
		return { ok: true, status: 200, text: async () => JSON.stringify({ data: answer(parsed.query) }) };
	};
	return { fetch, calls };
}

function substrateWith(env: Record<string, string | undefined>, fetch: RailwayFetch) {
	return new Substrate(loadConfig({}), { index: null, greptime: null, railway: new RailwayClient(railwayFromEnv(env), { fetch }) });
}

async function connect(substrate: Substrate) {
	const server = createMcpServer(substrate, CALLER);
	const client = new Client({ name: "substrate-test", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

/** A tool's JSON reply, as its text and a parser. Every fabric tool answers with one text block. */
async function call(client: Client, name: string) {
	const result = await client.callTool({ name, arguments: {} });
	const content = result.content as Array<{ type: string; text?: string }>;
	const text = content[0]?.text ?? "";
	return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

describe("fabric tools", () => {
	test("the three tools are listed as read-only, admitted as reads, and fail-open in the audit", async () => {
		const { fetch } = recordingFetch(() => ({}));
		const client = await connect(substrateWith({}, fetch));
		const { tools } = await client.listTools();
		for (const name of FABRIC_TOOLS) {
			const tool = tools.find((candidate) => candidate.name === name);
			expect(tool?.annotations?.readOnlyHint).toBe(true);
			expect(toolClass(name)).toBe("read");
			expect(auditMode(name)).toBe("fail-open");
		}
	});

	test("fabric_status reports the six resources, and a resource nothing configures is never ok", async () => {
		const { fetch } = recordingFetch(() => ({}));
		const client = await connect(substrateWith({}, fetch));
		const reply = await call(client, "fabric_status");
		expect(reply.isError).toBe(false);
		const body = reply.json() as { resources: Array<{ resource: string; state: string }> };
		expect(body.resources.map((row) => row.resource)).toEqual([
			"dragonfly",
			"timescaledb-index",
			"greptime",
			"ragflow",
			"hindsight",
			"tailscale-proxy",
		]);
		for (const name of ["dragonfly", "timescaledb-index", "greptime", "ragflow", "tailscale-proxy"]) {
			expect(body.resources.find((row) => row.resource === name)?.state).toBe("unconfigured");
		}
	});

	test("fabric_optimize names an over-budget Railway cost with its figures, and nothing else", async () => {
		const env = { RAILWAY_API_TOKEN: TOKEN, SUBSTRATE_RAILWAY_PROJECT_IDS: "proj-1", SUBSTRATE_RAILWAY_BUDGET_USD: "1", SUBSTRATE_RAILWAY_PRICE_CPU_USD: "5" };
		const { fetch, calls } = recordingFetch((query) =>
			query.includes("estimatedUsage") ? { estimatedUsage: [{ measurement: "CPU_USAGE", estimatedValue: 10, projectId: "proj-1" }] } : {},
		);
		const client = await connect(substrateWith(env, fetch));
		const reply = await call(client, "fabric_optimize");
		expect(reply.isError).toBe(false);
		expect(reply.text).not.toContain(TOKEN);
		const body = reply.json() as { suggestions: FabricSuggestion[] };
		expect(body.suggestions).toEqual([
			{
				id: "railway-over-budget",
				resource: "railway",
				action: expect.any(String),
				evidence: "projected 50.00 USD a month against a budget of 1.00 USD",
				severity: "attention",
			},
		]);
		expect(calls.length).toBeGreaterThan(0);
	});

	test("fabric_optimize with nothing configured emits no suggestion", async () => {
		const { fetch } = recordingFetch(() => ({}));
		const client = await connect(substrateWith({}, fetch));
		const body = (await call(client, "fabric_optimize")).json() as { suggestions: unknown[] };
		expect(body.suggestions).toEqual([]);
	});

	test("fabric_compliance marks unconfigured resources not applicable, never pass, and carries no token", async () => {
		const env = { RAILWAY_API_TOKEN: TOKEN, SUBSTRATE_RAILWAY_PROJECT_IDS: "proj-1" };
		const { fetch } = recordingFetch(() => ({ estimatedUsage: [] }));
		const client = await connect(substrateWith(env, fetch));
		const reply = await call(client, "fabric_compliance");
		expect(reply.isError).toBe(false);
		expect(reply.text).not.toContain(TOKEN);
		const body = reply.json() as { checks: Array<{ id: string; status: string; evidence: string }> };
		const statusOf = (id: string) => body.checks.find((check) => check.id === id)?.status;
		for (const id of ["resource-state.greptime", "resource-state.timescaledb-index", "resource-state.dragonfly", "resource-state.ragflow"]) {
			expect(statusOf(id)).toBe("NOT_APPLICABLE");
		}
		expect(statusOf("resource-state.tailscale-proxy")).toBe("NOT_APPLICABLE");
		expect(statusOf("audit-policy-fabric-tools")).toBe("PASS");
		expect(statusOf("report-redaction")).toBe("PASS");
	});
});

/** A Greptime fake for the health probes: `answer` decides each ping, every ping's timeout is recorded. */
function greptimeProbe(answer: (timeoutMs: number) => Promise<boolean>) {
	const pingTimeouts: number[] = [];
	const greptime = {
		ping: (timeoutMs: number) => {
			pingTimeouts.push(timeoutMs);
			return answer(timeoutMs);
		},
		ensureAppendMode: async () => true,
		probeDialect: async () => true,
		quotingDialectKnown: true,
		probeWritable: async () => ({ lastProbeAt: null, lastProbeOk: null, lastProbeError: null }),
		capacity: async () => {
			throw new Error("no size read in this test");
		},
		anchorCoverage: async () => {
			throw new Error("no coverage read in this test");
		},
	};
	return { greptime, pingTimeouts };
}

/** An index fake that answers its ping and counts the pings. */
function indexProbe() {
	const calls = { ping: 0 };
	const index = {
		ping: async () => {
			calls.ping += 1;
			return true;
		},
		capacity: async () => {
			throw new Error("no size read in this test");
		},
	};
	return { index, calls };
}

/** A substrate with the given index and Greptime probes. Greptime is configured through GREPTIME_URL, so the fabric reads it as configured. */
function substrateWithProbes(index: unknown, greptime: unknown) {
	return new Substrate(loadConfig({ GREPTIME_URL: "http://127.0.0.1:4000" }), { index: index as never, greptime: greptime as never });
}

describe("fabric health probes", () => {
	test("a slow Greptime ping answers for Greptime alone: the index still reads ok", async () => {
		const { index } = indexProbe();
		const { greptime } = greptimeProbe(() => new Promise<boolean>(() => undefined));
		const client = await connect(substrateWithProbes(index, greptime));
		const body = (await call(client, "fabric_status")).json() as { resources: Array<{ resource: string; state: string }> };
		const stateOf = (name: string) => body.resources.find((row) => row.resource === name)?.state;
		expect(stateOf("greptime")).toBe("unavailable");
		expect(stateOf("timescaledb-index")).toBe("ok");
	});

	test("the fabric's Greptime ping is asked to stop at the health deadline, so no probe outlives its wait", async () => {
		const { index } = indexProbe();
		const { greptime, pingTimeouts } = greptimeProbe(() => new Promise<boolean>(() => undefined));
		const client = await connect(substrateWithProbes(index, greptime));
		await call(client, "fabric_status");
		expect(pingTimeouts).toEqual([HEALTH_PROBE_MS]);
	});

	test("/healthz's Greptime ping is not given the fabric bound: it keeps the client default, as on main", async () => {
		const { index } = indexProbe();
		const { greptime, pingTimeouts } = greptimeProbe(async () => true);
		const substrate = substrateWithProbes(index, greptime);
		await substrate.health();
		expect(pingTimeouts).toEqual([undefined]);
		expect(pingTimeouts).not.toContain(HEALTH_PROBE_MS);
	});

	test("two fabric tool calls in one window issue one probe per source", async () => {
		const { index, calls } = indexProbe();
		const { greptime, pingTimeouts } = greptimeProbe(async () => true);
		const client = await connect(substrateWithProbes(index, greptime));
		await call(client, "fabric_status");
		await call(client, "fabric_optimize");
		expect(calls.ping).toBe(1);
		expect(pingTimeouts).toHaveLength(1);
	});
});
