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
import { GreptimeClient, type LedgerCapacity } from "./greptime.ts";
import { createMcpServer, type McpCaller } from "./mcp.ts";
import { railwayFromEnv, RailwayClient, type RailwayFetch } from "./railway.ts";
import { HEALTH_PROBE_MS, Substrate } from "./service.ts";
import { defined } from "./test-support.ts";

const TOKEN = "fabric-token-abc123";
const CALLER: McpCaller = { surface: "omp", isOperator: false };
const FABRIC_TOOLS = ["fabric_status", "fabric_optimize", "fabric_compliance"] as const;
const GREPTIME_URL_KEY = ["GREPTIME", "URL"].join("_");
/** The size read the fake ledgers answer with. Each assertion compares against this object, so it proves the read came from the probe. */
const LEDGER_SIZE: LedgerCapacity = { bytes: 1024, rows: 7, tables: [] };

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

	test("fabric_status reports the seven resources, and a resource nothing configures is never ok", async () => {
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
			"lightrag",
			"hindsight",
			"tailscale-proxy",
		]);
		for (const name of ["dragonfly", "timescaledb-index", "greptime", "ragflow", "lightrag", "tailscale-proxy"]) {
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
		for (const id of ["resource-state.greptime", "resource-state.timescaledb-index", "resource-state.dragonfly", "resource-state.ragflow", "resource-state.lightrag"]) {
			expect(statusOf(id)).toBe("NOT_APPLICABLE");
		}
		expect(statusOf("resource-state.tailscale-proxy")).toBe("NOT_APPLICABLE");
		expect(statusOf("audit-policy-fabric-tools")).toBe("PASS");
		expect(statusOf("report-redaction")).toBe("PASS");
	});
});

/** A substrate with LightRAG configured (and RAGFlow not), reached only through `lightragFetch`. */
function substrateWithLightrag(lightragFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
	const { fetch } = recordingFetch(() => ({}));
	return new Substrate(loadConfig({ LIGHTRAG_URL: "http://lightrag.test", LIGHTRAG_API_KEY: "k" }), {
		index: null,
		greptime: null,
		railway: new RailwayClient(railwayFromEnv({}), { fetch }),
		lightragFetch,
	});
}

describe("the LightRAG fabric row", () => {
	test("LightRAG configured and answering healthy is ok, and an unset RAGFlow stays unconfigured", async () => {
		const paths: string[] = [];
		const client = await connect(
			substrateWithLightrag(async (input, init) => {
				paths.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
				return Response.json({ status: "healthy", core_version: "1.5.7", pipeline_busy: false });
			}),
		);
		const body = (await call(client, "fabric_status")).json() as { resources: Array<{ resource: string; state: string; endpointClass: string; source: string }> };
		const row = (name: string) => body.resources.find((candidate) => candidate.resource === name);
		expect(row("lightrag")).toMatchObject({ state: "ok", endpointClass: "not-applicable", source: "health().planes.lightrag" });
		expect(row("ragflow")?.state).toBe("unconfigured");
		expect(paths).toEqual(["GET /health"]);
	});

	test("a LightRAG that refuses its probe is unavailable, never ok, and fabric_compliance fails its check", async () => {
		const client = await connect(substrateWithLightrag(async () => Response.json({ detail: "Invalid API Key" }, { status: 403 })));
		const status = (await call(client, "fabric_status")).json() as { resources: Array<{ resource: string; state: string }> };
		expect(status.resources.find((candidate) => candidate.resource === "lightrag")?.state).toBe("unavailable");
		const compliance = (await call(client, "fabric_compliance")).json() as { checks: Array<{ id: string; status: string }> };
		expect(compliance.checks.find((check) => check.id === "resource-state.lightrag")?.status).toBe("FAIL");
	});

	test("a LightRAG whose fetch throws is unavailable", async () => {
		const client = await connect(
			substrateWithLightrag(async () => {
				throw new Error("connect refused");
			}),
		);
		const status = (await call(client, "fabric_status")).json() as { resources: Array<{ resource: string; state: string }> };
		expect(status.resources.find((candidate) => candidate.resource === "lightrag")?.state).toBe("unavailable");
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
		capacity: () => after800ms(LEDGER_SIZE),
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
		expect(health.capacity.ledger).toEqual(LEDGER_SIZE);
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
		capacity: async () => LEDGER_SIZE,
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
		expect(health.capacity.ledger).toEqual(LEDGER_SIZE);
	});
});

/**
 * Greptime fakes for the two stalls. Real time on purpose: the fabric's bound on the write probe is a platform timer, so a
 * stand-in would not exercise it. The size read never answers in one fake, and the write probe never answers in the other.
 */
function greptimeWithStalledWrite() {
	return {
		ping: async () => true,
		ensureAppendMode: async () => true,
		probeDialect: async () => true,
		quotingDialectKnown: true,
		probeWritable: () => new Promise<never>(() => undefined),
		capacity: async () => LEDGER_SIZE,
		anchorCoverage: async () => {
			throw new Error("no coverage read in this test");
		},
	};
}

function greptimeWithStalledSize() {
	return {
		ping: async () => true,
		ensureAppendMode: async () => true,
		probeDialect: async () => true,
		quotingDialectKnown: true,
		probeWritable: async () => ({ lastProbeAt: 1, lastProbeOk: true, lastProbeError: null }),
		capacity: () => new Promise<never>(() => undefined),
		anchorCoverage: async () => {
			throw new Error("no coverage read in this test");
		},
	};
}

describe("the Greptime row on the fabric path", () => {
	test("a write probe that never answers makes the events write not ok, and the compliance report does not PASS it", async () => {
		const { index } = indexProbe();
		const substrate = substrateWithProbes(index, greptimeWithStalledWrite());
		const client = await connect(substrate);
		const status = (await call(client, "fabric_status")).json() as { resources: Array<{ resource: string; state: string; source: string }> };
		const greptime = status.resources.find((row) => row.resource === "greptime");
		expect(greptime?.state).toBe("unavailable");
		expect(greptime?.source).toBe("health().greptime: timeout");
		const compliance = (await call(client, "fabric_compliance")).json() as { checks: Array<{ id: string; status: string }> };
		expect(compliance.checks.find((check) => check.id === "resource-state.greptime")?.status).toBe("FAIL");
	});

	test("a size read that never answers does not hold the fabric's Greptime row", async () => {
		const { index } = indexProbe();
		const substrate = substrateWithProbes(index, greptimeWithStalledSize());
		const client = await connect(substrate);
		const status = (await call(client, "fabric_status")).json() as { resources: Array<{ resource: string; state: string }> };
		expect(status.resources.find((row) => row.resource === "greptime")?.state).toBe("ok");
	});
});

/** Statements that change the store. The fabric must issue none of them. */
const WRITE_STATEMENT = /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i;

/**
 * Replaces `fetch` for the Greptime wire: every SQL statement is recorded, and the probe reads answer the way an append-only
 * store does, so the client reaches its write probe. `restore` puts the real `fetch` back.
 */
function recordGreptimeWire() {
	const statements: string[] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		const statement = new URLSearchParams(String(init.body)).get("sql") ?? "";
		statements.push(statement);
		return new Response(JSON.stringify(greptimeAnswer(statement)), { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return {
		statements,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

function greptimeAnswer(statement: string): unknown {
	if (statement.includes("LENGTH")) return { output: [{ records: { schema: { column_schemas: [{ name: "n" }] }, rows: [[3]] } }] };
	if (statement.includes("SHOW CREATE TABLE")) {
		const schema = { column_schemas: [{ name: "Table" }, { name: "Create Table" }] };
		return { output: [{ records: { schema, rows: [["t", "... WITH( append_mode = 'true' )"]] } }] };
	}
	return { output: [{ affectedrows: 1 }] };
}

describe("fabric reads never write to Greptime", () => {
	test("fabric_status, fabric_optimize and fabric_compliance issue no write, on the first call or after", async () => {
		const wire = recordGreptimeWire();
		try {
			const substrate = new Substrate(loadConfig({ [GREPTIME_URL_KEY]: "http://greptime.test" }), {
				index: null,
				greptime: new GreptimeClient({ url: "http://greptime.test", user: "u", password: "p", db: "substrate" }),
			});
			const client = await connect(substrate);
			const first = (await call(client, "fabric_status")).json() as { resources: Array<{ resource: string; state: string }> };
			// Nothing has probed the ledger since boot, so its write is unknown: unavailable, never ok.
			expect(first.resources.find((row) => row.resource === "greptime")?.state).toBe("unavailable");
			await call(client, "fabric_optimize");
			await call(client, "fabric_compliance");
			expect(wire.statements.length).toBeGreaterThan(0);
			expect(wire.statements.filter((statement) => WRITE_STATEMENT.test(statement))).toEqual([]);
			// `/healthz` still writes its probe row on its own cadence.
			await substrate.health();
			expect(wire.statements.filter((statement) => WRITE_STATEMENT.test(statement)).length).toBeGreaterThan(0);
		} finally {
			wire.restore();
		}
	});
});

describe("the Greptime row with the write probe off", () => {
	test("a healthy Greptime reads ok at SUBSTRATE_LEDGER_WRITE_PROBE_S=0, and the fabric still issues no write", async () => {
		const wire = recordGreptimeWire();
		try {
			const env = { [GREPTIME_URL_KEY]: "http://greptime.test", SUBSTRATE_LEDGER_WRITE_PROBE_S: "0" };
			const substrate = new Substrate(loadConfig(env), {
				index: null,
				greptime: new GreptimeClient({ url: "http://greptime.test", user: "u", password: "p", db: "substrate" }),
			});
			const client = await connect(substrate);
			const status = (await call(client, "fabric_status")).json() as { resources: Array<{ resource: string; state: string }> };
			expect(status.resources.find((row) => row.resource === "greptime")?.state).toBe("ok");
			await call(client, "fabric_optimize");
			await call(client, "fabric_compliance");
			expect(wire.statements.length).toBeGreaterThan(0);
			expect(wire.statements.filter((statement) => WRITE_STATEMENT.test(statement))).toEqual([]);
		} finally {
			wire.restore();
		}
	});
});

describe("the size read on the health path", () => {
	test("the size read starts when the ping answers: a write probe that stalls does not hold it", async () => {
		const { index } = indexProbe();
		const started: number[] = [];
		const greptime = {
			...greptimeWithStalledWrite(),
			capacity: async () => {
				started.push(Date.now());
				return LEDGER_SIZE;
			},
		};
		const begun = Date.now();
		const health = await substrateWithProbes(index, greptime).health({ greptimeTimeoutMs: HEALTH_PROBE_MS });
		expect(health.capacity.ledger).toEqual(LEDGER_SIZE);
		expect(started).toHaveLength(1);
		expect(defined(started[0], "start time") - begun).toBeLessThan(HEALTH_PROBE_MS / 2);
	});
});
