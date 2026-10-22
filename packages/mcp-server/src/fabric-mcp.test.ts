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
const GREPTIME_URL_KEY = ["GREPTIME", "URL"].join("_");

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
	const pingTimeouts: Array<number | undefined> = [];
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
	return new Substrate(loadConfig({ [GREPTIME_URL_KEY]: "http://127.0.0.1:4000" }), { index: index as never, greptime: greptime as never });
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

/** A Greptime fake whose ping and jobs reads are counted. The jobs read answers an empty coverage. */
function greptimeWithJobs() {
	const pingCalls: number[] = [];
	const anchorCalls: number[] = [];
	const greptime = {
		ping: async () => {
			pingCalls.push(1);
			return true;
		},
		ensureAppendMode: async () => true,
		probeDialect: async () => true,
		quotingDialectKnown: true,
		probeWritable: async () => ({ lastProbeAt: null, lastProbeOk: null, lastProbeError: null }),
		capacity: async () => {
			throw new Error("no size read in this test");
		},
		anchorCoverage: async () => {
			anchorCalls.push(1);
			return { lagHours: 2, uncoveredHours: [], more: false, newestAnchoredHour: null, lastArchiveWindow: null };
		},
	};
	return { greptime, pingCalls, anchorCalls };
}

/** A substrate whose breakers open on the first failure and go half-open after one second: the smallest the config allows. */
function substrateWithFastBreakers(index: unknown, greptime: unknown) {
	const config = loadConfig({ [GREPTIME_URL_KEY]: "http://127.0.0.1:4000", SUBSTRATE_BREAKER_FAILURES: "1", SUBSTRATE_BREAKER_OPEN_MS: "1000" });
	return new Substrate(config, { index: index as never, greptime: greptime as never });
}

/** Opens the Greptime breaker and waits until it is half-open. */
async function halfOpenGreptime(substrate: Substrate): Promise<void> {
	const breaker = substrate.planes.gate("greptime").breaker;
	if (breaker === null) throw new Error("the Greptime breaker is off in this test");
	breaker.onFailure("test: Greptime unreachable");
	// Real time on purpose: the breaker reads the platform clock and `Substrate` takes no clock seam, so the open window can only
	// elapse for real. The window is the config minimum of one second.
	await Bun.sleep(1100);
	if (breaker.state() !== "half-open") throw new Error("the Greptime breaker did not reach half-open");
}

describe("/healthz jobs row under a half-open Greptime breaker", () => {
	test("the jobs row is unchanged: the ping's verdict comes first, then the jobs read runs, as on main", async () => {
		const { index } = indexProbe();
		const { greptime, pingCalls, anchorCalls } = greptimeWithJobs();
		const substrate = substrateWithFastBreakers(index, greptime);
		await halfOpenGreptime(substrate);
		const health = await substrate.health();
		expect(pingCalls).toHaveLength(1);
		expect(anchorCalls).toHaveLength(1);
		expect(health.jobs.ledgerReason).toBeNull();
		expect(health.jobs.ledger?.anchorLagHours).toBe(2);
	});
});

/**
 * A Greptime fake whose write probe and size read each take 800 ms and answer their own results. Real time on purpose: the
 * health bounds these probes race read the platform clock, so a stand-in timer would not exercise them.
 */
function slowLedgerProbes() {
	const after800ms = <T>(value: T): Promise<T> =>
		new Promise((resolve) => {
			setTimeout(() => resolve(value), 800);
		});
	return {
		ping: async () => true,
		ensureAppendMode: async () => true,
		probeDialect: async () => true,
		quotingDialectKnown: true,
		probeWritable: () => after800ms({ lastProbeAt: 1, lastProbeOk: true, lastProbeError: null }),
		capacity: () => after800ms({ marker: "size" }),
		anchorCoverage: async () => {
			throw new Error("no coverage read in this test");
		},
	};
}

describe("the Greptime write probe and size read on the fabric path", () => {
	test("two 800 ms probes resolve inside the fabric deadline, and each reports its own result", async () => {
		const { index } = indexProbe();
		const substrate = substrateWithProbes(index, slowLedgerProbes());
		const client = await connect(substrate);
		const body = (await call(client, "fabric_status")).json() as { resources: Array<{ resource: string; state: string }> };
		expect(body.resources.find((row) => row.resource === "greptime")?.state).toBe("ok");
		const health = await substrate.health({ greptimeTimeoutMs: HEALTH_PROBE_MS });
		expect(health.ledger.lastProbeOk).toBe(true);
		expect(health.capacity.ledger).toEqual({ marker: "size" });
	});
});

/**
 * A Greptime fake whose append-mode, dialect and write-probe reads each take 800 ms, and whose size read answers at once.
 * Each read answers its own value, so a test can see which read reported what. Real time on purpose: the health bounds these
 * reads race read the platform clock, so a stand-in timer would not exercise them.
 */
function threeSlowGreptimeReads() {
	const after800ms = <T>(value: T): Promise<T> =>
		new Promise((resolve) => {
			setTimeout(() => resolve(value), 800);
		});
	let dialectKnown = false;
	return {
		ping: async () => true,
		ensureAppendMode: () => after800ms(true),
		probeDialect: async () => {
			await after800ms(undefined);
			dialectKnown = true;
		},
		get quotingDialectKnown() {
			return dialectKnown;
		},
		probeWritable: () => after800ms({ lastProbeAt: 1, lastProbeOk: true, lastProbeError: null }),
		capacity: async () => ({ marker: "size" }),
		anchorCoverage: async () => {
			throw new Error("no coverage read in this test");
		},
	};
}

describe("the Greptime reads after the ping on the fabric path", () => {
	test("three 800 ms reads resolve inside the fabric deadline, and each reports its own result", async () => {
		const { index } = indexProbe();
		const substrate = substrateWithProbes(index, threeSlowGreptimeReads());
		const client = await connect(substrate);
		const body = (await call(client, "fabric_status")).json() as { resources: Array<{ resource: string; state: string }> };
		expect(body.resources.find((row) => row.resource === "greptime")?.state).toBe("ok");
		const health = await substrate.health({ greptimeTimeoutMs: HEALTH_PROBE_MS });
		expect(health.appendOnly).toBe(true);
		expect(health.quotingDialectKnown).toBe(true);
		expect(health.ledger.lastProbeOk).toBe(true);
		expect(health.capacity.ledger).toEqual({ marker: "size" });
	});
});
