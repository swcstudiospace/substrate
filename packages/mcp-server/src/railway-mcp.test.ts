/**
 * The Railway control tools, driven through a real MCP client, and the `/slo` row.
 *
 * Every Railway call goes to a recording fake `fetch`; nothing here reaches the Railway API. A refused
 * write must leave the fake with zero calls, which is how the write gate is proven: the refusal comes
 * before any request, not after one.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toolClass } from "./admission.ts";
import { loadConfig } from "./config.ts";
import { createMcpServer, type McpCaller } from "./mcp.ts";
import { createObservability, toolLabel } from "./observe.ts";
import { railwayFromEnv, RailwayClient, type RailwayFetch } from "./railway.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";

const TOKEN = "test-token-abc123";
const REF = "UAT-2026.10/ref_1";
const WRITES_ON = { RAILWAY_API_TOKEN: TOKEN, SUBSTRATE_RAILWAY_WRITES: "on" };
const OPERATOR: McpCaller = { surface: "omp", isOperator: true };
const NON_OPERATOR: McpCaller = { surface: "omp", isOperator: false };
const SCALE_ARGS = { environment_id: "env-1", service_id: "svc-1", vcpus: 1, memory_gb: 1, approval_ref: REF };

/** A recording fake: every request is kept, and `answer` gives the `data` for each query. */
function recordingFetch(answer: (query: string) => unknown) {
	const calls: Array<{ body: string }> = [];
	const fetch: RailwayFetch = async (_input, init) => {
		calls.push({ body: init.body });
		const parsed: { query: string } = JSON.parse(init.body);
		const data = answer(parsed.query);
		return { ok: true, status: 200, text: async () => JSON.stringify({ data }) };
	};
	return { fetch, calls };
}

/** A substrate whose Railway client is built from `env` and talks only to `fetch`. */
function substrateWith(env: Record<string, string | undefined>, fetch: RailwayFetch) {
	return new Substrate(loadConfig({}), { index: null, greptime: null, railway: new RailwayClient(railwayFromEnv(env), { fetch }) });
}

async function connectAs(substrate: Substrate, caller: McpCaller) {
	const server = createMcpServer(substrate, caller);
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

describe("railway write tools", () => {
	test("write tools refuse without the operator gate and make no request", async () => {
		const { fetch, calls } = recordingFetch(() => ({ serviceInstanceLimitsUpdate: true, serviceInstanceRedeploy: true }));
		const client = await connectAs(substrateWith(WRITES_ON, fetch), NON_OPERATOR);
		const scale = await call(client, "railway_scale", SCALE_ARGS);
		const deploy = await call(client, "railway_deploy", { environment_id: "env-1", service_id: "svc-1", approval_ref: REF });
		expect(scale.isError).toBe(true);
		expect(scale.json()).toMatchObject({ applied: false, refusal: "operator-required" });
		expect(deploy.isError).toBe(true);
		expect(deploy.json()).toMatchObject({ applied: false, refusal: "operator-required" });
		expect(calls).toHaveLength(0);
	});

	test("write tools refuse with writes off", async () => {
		const { fetch, calls } = recordingFetch(() => ({ serviceInstanceLimitsUpdate: true, serviceInstanceRedeploy: true }));
		const client = await connectAs(substrateWith({ RAILWAY_API_TOKEN: TOKEN }, fetch), OPERATOR);
		const scale = await call(client, "railway_scale", SCALE_ARGS);
		expect(scale.isError).toBe(true);
		expect(scale.json()).toMatchObject({ applied: false, refusal: "writes-disabled" });
		expect(scale.text).not.toContain(TOKEN);
		expect(calls).toHaveLength(0);
	});

	test("gated write reaches the client once", async () => {
		const { fetch, calls } = recordingFetch(() => ({ serviceInstanceLimitsUpdate: true }));
		const client = await connectAs(substrateWith(WRITES_ON, fetch), OPERATOR);
		const scale = await call(client, "railway_scale", SCALE_ARGS);
		expect(scale.isError).toBe(false);
		expect(scale.json()).toMatchObject({ applied: true });
		expect(calls).toHaveLength(1);
		const sent: { variables: { input: Record<string, unknown> } } = JSON.parse(calls[0]?.body ?? "{}");
		expect(sent.variables.input).toEqual({ environmentId: "env-1", serviceId: "svc-1", vCPUs: 1, memoryGB: 1 });
	});
});

describe("railway read tools", () => {
	test("read tools need no gate", async () => {
		const env = { RAILWAY_API_TOKEN: TOKEN, SUBSTRATE_RAILWAY_PROJECT_IDS: "proj-1" };
		const { fetch, calls } = recordingFetch((query) => {
			if (query.includes("estimatedUsage")) return { estimatedUsage: [{ measurement: "CPU_USAGE", estimatedValue: 1.5, projectId: "proj-1" }] };
			return {
				project: {
					id: "proj-1",
					name: "Agent Substrate",
					environments: { edges: [{ node: { id: "env-1", name: "production", isEphemeral: false } }] },
					services: { edges: [{ node: { id: "svc-1", name: "substrate-mcp" } }] },
				},
			};
		});
		const client = await connectAs(substrateWith(env, fetch), NON_OPERATOR);
		const list = await call(client, "railway_list");
		expect(list.isError).toBe(false);
		expect(list.json()).toMatchObject({ projects: [{ id: "proj-1" }] });
		const cost = await call(client, "railway_cost");
		expect(cost.isError).toBe(false);
		// No price is set, so the line with usage is unpriced; no price is ever assumed.
		expect(cost.json()).toMatchObject({ status: "unpriced" });
		expect(calls.length).toBeGreaterThan(0);
	});
});

describe("/slo railwayCost row", () => {
	test("/slo carries railwayCost and never breaches on it", async () => {
		const failing: RailwayFetch = async () => {
			throw new Error("connect refused");
		};
		const env = { RAILWAY_API_TOKEN: TOKEN, SUBSTRATE_RAILWAY_PROJECT_IDS: "proj-1" };
		const config = loadConfig({});
		const observability = createObservability(config, {});
		await observability.start();
		const substrate = new Substrate(
			config,
			{ index: null, greptime: null, railway: new RailwayClient(railwayFromEnv(env), { fetch: failing }) },
			observability.observer,
		);
		const server = createHttpServer(substrate, config, observability, {});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		try {
			const response = await fetch(`http://127.0.0.1:${port}/slo`);
			expect(response.status).toBe(200);
			const reply: unknown = await response.json();
			// The /slo reply is JSON read from the wire; the two fields asserted below are the whole contract.
			const body = reply as { railwayCost: { status: string } | null; breached: string[] };
			expect(body.railwayCost?.status).toBe("unavailable");
			expect(body.breached.filter((id) => id.includes("railway"))).toEqual([]);
		} finally {
			const closed = Promise.withResolvers<void>();
			observability.stop();
			server.close(() => closed.resolve());
			await closed.promise;
		}
	});
});

describe("railway tool registration", () => {
	test("tool classes cover every registered railway tool", async () => {
		const expected: Record<string, string> = {
			railway_list: "read",
			railway_monitor: "read",
			railway_scale_suggest: "read",
			railway_cost: "read",
			railway_scale: "write",
			railway_deploy: "write",
		};
		const { fetch } = recordingFetch(() => ({}));
		const client = await connectAs(substrateWith({}, fetch), NON_OPERATOR);
		const served = (await client.listTools()).tools.map((tool) => tool.name);
		expect(Object.keys(expected).filter((name) => !served.includes(name))).toEqual([]);
		expect(Object.entries(expected).map(([name]) => [name, toolClass(name), toolLabel(name)])).toEqual(
			Object.entries(expected).map(([name, klass]) => [name, klass, name]),
		);
	});
});
