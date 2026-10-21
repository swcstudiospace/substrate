import { describe, expect, test } from "bun:test";
import {
	RAILWAY_API_URL,
	RAILWAY_COST_CACHE_MS,
	RAILWAY_REQUEST_TIMEOUT_MS,
	RailwayClient,
	RailwayRequestError,
	type RailwayFetch,
	type ServiceRef,
	type WriteGate,
	type WriteRefusal,
	approvalRefValid,
	boundsRefusal,
	buildCostReport,
	p95,
	railwayFromEnv,
	roundUpToQuantum,
	suggestScale,
	writeRefusal,
} from "./railway.ts";

/**
 * Consumer-visible behaviour of the Railway client and its pure decisions.
 * Every request goes to a recording fake fetch; no test reaches Railway.
 */

const TOKEN = "test-token-abc123";
const REF: ServiceRef = { environmentId: "env-1", serviceId: "svc-1" };
const OPERATOR: WriteGate = { isOperator: true, approvalRef: "UAT-2026.10/ref_1#a" };
const GENERATED_AT = "2026-10-21T00:00:00.000Z";
const WRITABLE_ENV = { RAILWAY_API_TOKEN: TOKEN, SUBSTRATE_RAILWAY_WRITES: "on" };
const READABLE_ENV = { RAILWAY_API_TOKEN: TOKEN, SUBSTRATE_RAILWAY_PROJECT_IDS: "proj-1" };

interface SentRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly query: string;
	readonly variables: Record<string, unknown>;
}

type Reply = { readonly status: number; readonly body: unknown } | "throw";

/** A fake fetch that records every request and answers from `reply`. */
function recordingFetch(reply: (request: SentRequest) => Reply): { readonly fetch: RailwayFetch; readonly sent: SentRequest[] } {
	const sent: SentRequest[] = [];
	const fetch: RailwayFetch = async (url, init) => {
		const body: { query: string; variables: Record<string, unknown> } = JSON.parse(init.body);
		const request: SentRequest = { url, method: init.method, headers: init.headers, query: body.query, variables: body.variables };
		sent.push(request);
		const outcome = reply(request);
		if (outcome === "throw") throw new Error("socket reset");
		const text = typeof outcome.body === "string" ? outcome.body : JSON.stringify(outcome.body);
		return { ok: outcome.status >= 200 && outcome.status < 300, status: outcome.status, text: async () => text };
	};
	return { fetch, sent };
}

async function rejectionOf(promise: Promise<unknown>): Promise<RailwayRequestError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof RailwayRequestError) return error;
		throw error;
	}
	throw new Error("expected the call to reject");
}

function repeat(value: number, count: number): number[] {
	return Array.from({ length: count }, () => value);
}

describe("railwayFromEnv", () => {
	test("defaults: budget 50, writes off, no token", () => {
		const config = railwayFromEnv({});
		expect(config.budgetUsd).toBe(50);
		expect(config.writesEnabled).toBe(false);
		expect(config.apiToken).toBeNull();
		expect(config.prices).toEqual({});
		expect(config.projectIds).toEqual([]);
		expect(config.scale).toEqual({
			minVcpus: 0.25,
			maxVcpus: 4,
			minMemoryGb: 0.25,
			maxMemoryGb: 8,
			headroom: 0.3,
			windowSeconds: 86400,
		});
	});

	test("writes enabled only by exactly on", () => {
		expect(railwayFromEnv({ SUBSTRATE_RAILWAY_WRITES: "true" }).writesEnabled).toBe(false);
		expect(railwayFromEnv({ SUBSTRATE_RAILWAY_WRITES: "ON" }).writesEnabled).toBe(false);
		expect(railwayFromEnv({ SUBSTRATE_RAILWAY_WRITES: "on" }).writesEnabled).toBe(true);
	});

	test("invalid budget falls back to fifty", () => {
		expect(railwayFromEnv({ SUBSTRATE_RAILWAY_BUDGET_USD: "0" }).budgetUsd).toBe(50);
		expect(railwayFromEnv({ SUBSTRATE_RAILWAY_BUDGET_USD: "abc" }).budgetUsd).toBe(50);
		expect(railwayFromEnv({ SUBSTRATE_RAILWAY_BUDGET_USD: "-3" }).budgetUsd).toBe(50);
		expect(railwayFromEnv({ SUBSTRATE_RAILWAY_BUDGET_USD: "72.5" }).budgetUsd).toBe(72.5);
	});

	test("prices keep cents", () => {
		expect(railwayFromEnv({ SUBSTRATE_RAILWAY_PRICE_CPU_USD: "0.05" }).prices.CPU_USAGE).toBe(0.05);
	});

	test("a zero or invalid price is unpriced, not free", () => {
		expect(railwayFromEnv({ SUBSTRATE_RAILWAY_PRICE_CPU_USD: "0" }).prices).toEqual({});
		expect(railwayFromEnv({ SUBSTRATE_RAILWAY_PRICE_DISK_GB_USD: "cheap" }).prices).toEqual({});
	});

	test("token is trimmed and blank is no token; project ids are a trimmed comma list", () => {
		expect(railwayFromEnv({ RAILWAY_API_TOKEN: "   " }).apiToken).toBeNull();
		expect(railwayFromEnv({ RAILWAY_API_TOKEN: `  ${TOKEN}  ` }).apiToken).toBe(TOKEN);
		expect(railwayFromEnv({ SUBSTRATE_RAILWAY_PROJECT_IDS: " a, ,b " }).projectIds).toEqual(["a", "b"]);
		expect(railwayFromEnv({ SUBSTRATE_RAILWAY_PROJECT_IDS: "b, a,b" }).projectIds).toEqual(["b", "a"]);
	});
});

describe("write gate", () => {
	test("writes off makes no request", async () => {
		const { fetch, sent } = recordingFetch(() => ({ status: 200, body: { data: { serviceInstanceLimitsUpdate: true, serviceInstanceRedeploy: true } } }));
		const client = new RailwayClient(railwayFromEnv({ RAILWAY_API_TOKEN: TOKEN }), { fetch });
		expect(await client.setServiceLimits(REF, { vCPUs: 0.5, memoryGB: 0.5 }, OPERATOR)).toEqual({ applied: false, refusal: "writes-disabled" });
		expect(await client.redeployService(REF, OPERATOR)).toEqual({ applied: false, refusal: "writes-disabled" });
		expect(sent).toHaveLength(0);
	});

	test("refusals name the failed gate and make no request", async () => {
		const cases: { readonly env: Record<string, string | undefined>; readonly gate: WriteGate; readonly refusal: WriteRefusal }[] = [
			{ env: WRITABLE_ENV, gate: { isOperator: false, approvalRef: "ref-1" }, refusal: "operator-required" },
			{ env: WRITABLE_ENV, gate: { isOperator: true, approvalRef: null }, refusal: "approval-ref-missing" },
			{ env: WRITABLE_ENV, gate: { isOperator: true, approvalRef: "has a space" }, refusal: "approval-ref-missing" },
			{ env: { SUBSTRATE_RAILWAY_WRITES: "on" }, gate: OPERATOR, refusal: "unconfigured" },
			{ env: {}, gate: OPERATOR, refusal: "unconfigured" },
			{ env: { RAILWAY_API_TOKEN: TOKEN }, gate: OPERATOR, refusal: "writes-disabled" },
		];
		for (const { env, gate, refusal } of cases) {
			const { fetch, sent } = recordingFetch(() => ({ status: 200, body: { data: { serviceInstanceLimitsUpdate: true } } }));
			const client = new RailwayClient(railwayFromEnv(env), { fetch });
			expect(await client.setServiceLimits(REF, { vCPUs: 0.5, memoryGB: 0.5 }, gate)).toEqual({ applied: false, refusal });
			expect(await client.redeployService(REF, gate)).toEqual({ applied: false, refusal });
			expect(sent).toHaveLength(0);
		}
	});

	test("bounds refuse with zero requests even when writes are on and the gate passes", async () => {
		const { fetch, sent } = recordingFetch(() => ({ status: 200, body: { data: { serviceInstanceLimitsUpdate: true } } }));
		const client = new RailwayClient(railwayFromEnv({ ...WRITABLE_ENV, RAILWAY_API_TOKEN: TOKEN }), { fetch });
		expect(await client.setServiceLimits(REF, { vCPUs: 5, memoryGB: 0.5 }, OPERATOR)).toEqual({ applied: false, refusal: "out-of-bounds" });
		expect(await client.setServiceLimits(REF, { vCPUs: 0.5, memoryGB: 9 }, OPERATOR)).toEqual({ applied: false, refusal: "out-of-bounds" });
		expect(sent).toHaveLength(0);
	});

	test("values equal to a bound pass", async () => {
		const bounds = railwayFromEnv({}).scale;
		expect(boundsRefusal(bounds, { vCPUs: bounds.maxVcpus, memoryGB: bounds.minMemoryGb })).toBeNull();
		expect(boundsRefusal(bounds, { vCPUs: bounds.minVcpus, memoryGB: bounds.maxMemoryGb })).toBeNull();
		expect(boundsRefusal(bounds, { vCPUs: bounds.maxVcpus + 0.01, memoryGB: 1 })).toBe("out-of-bounds");

		const { fetch, sent } = recordingFetch(() => ({ status: 200, body: { data: { serviceInstanceLimitsUpdate: true } } }));
		const client = new RailwayClient(railwayFromEnv({ ...WRITABLE_ENV, RAILWAY_API_TOKEN: TOKEN }), { fetch });
		expect(await client.setServiceLimits(REF, { vCPUs: bounds.maxVcpus, memoryGB: bounds.maxMemoryGb }, OPERATOR)).toEqual({ applied: true });
		expect(sent).toHaveLength(1);
	});

	test("approval reference shape is enforced", () => {
		expect(approvalRefValid("UAT-2026.10/ref_1#a")).toBe(true);
		expect(approvalRefValid("a".repeat(128))).toBe(true);
		expect(approvalRefValid("")).toBe(false);
		expect(approvalRefValid("a".repeat(129))).toBe(false);
		expect(approvalRefValid("has space")).toBe(false);
	});

	test("gated write sends one limits mutation", async () => {
		const { fetch, sent } = recordingFetch(() => ({ status: 200, body: { data: { serviceInstanceLimitsUpdate: true } } }));
		const config = railwayFromEnv({ ...WRITABLE_ENV, RAILWAY_API_TOKEN: TOKEN });
		expect(writeRefusal(config, OPERATOR)).toBeNull();
		const client = new RailwayClient(config, { fetch });
		expect(await client.setServiceLimits(REF, { vCPUs: 0.5, memoryGB: 0.5 }, OPERATOR)).toEqual({ applied: true });
		expect(sent).toHaveLength(1);
		const request = sent[0];
		expect(request?.url).toBe(RAILWAY_API_URL);
		expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(request?.variables).toEqual({ input: { environmentId: "env-1", serviceId: "svc-1", vCPUs: 0.5, memoryGB: 0.5 } });
	});

	test("gated redeploy sends one redeploy mutation", async () => {
		const { fetch, sent } = recordingFetch(() => ({ status: 200, body: { data: { serviceInstanceRedeploy: true } } }));
		const client = new RailwayClient(railwayFromEnv({ ...WRITABLE_ENV, RAILWAY_API_TOKEN: TOKEN }), { fetch });
		expect(await client.redeployService(REF, OPERATOR)).toEqual({ applied: true });
		expect(sent).toHaveLength(1);
		expect(sent[0]?.variables).toEqual({ environmentId: "env-1", serviceId: "svc-1" });
	});

	test("boolean false is not applied", async () => {
		const limitsClient = new RailwayClient(railwayFromEnv({ ...WRITABLE_ENV, RAILWAY_API_TOKEN: TOKEN }), {
			fetch: recordingFetch(() => ({ status: 200, body: { data: { serviceInstanceLimitsUpdate: false } } })).fetch,
		});
		const falseError = await rejectionOf(limitsClient.setServiceLimits(REF, { vCPUs: 0.5, memoryGB: 0.5 }, OPERATOR));
		expect(falseError.kind).toBe("shape");

		const redeployClient = new RailwayClient(railwayFromEnv({ ...WRITABLE_ENV, RAILWAY_API_TOKEN: TOKEN }), {
			fetch: recordingFetch(() => ({ status: 200, body: { data: { serviceInstanceRedeploy: null } } })).fetch,
		});
		const nullError = await rejectionOf(redeployClient.redeployService(REF, OPERATOR));
		expect(nullError.kind).toBe("shape");
	});
});

describe("reads and errors", () => {
	test("errors never echo the token", async () => {
		const httpClient = new RailwayClient(railwayFromEnv({ RAILWAY_API_TOKEN: TOKEN }), {
			fetch: recordingFetch(() => ({ status: 500, body: `upstream rejected ${TOKEN}` })).fetch,
		});
		const httpError = await rejectionOf(httpClient.monitor(REF));
		expect(httpError.kind).toBe("transport");
		expect(httpError.message).not.toContain(TOKEN);

		const graphqlClient = new RailwayClient(railwayFromEnv({ RAILWAY_API_TOKEN: TOKEN }), {
			fetch: recordingFetch(() => ({ status: 200, body: { data: null, errors: [{ message: `bad credential ${TOKEN}`, extensions: { traceId: "trace-7" } }] } })).fetch,
		});
		const graphqlError = await rejectionOf(graphqlClient.monitor(REF));
		expect(graphqlError.kind).toBe("graphql");
		expect(graphqlError.message).not.toContain(TOKEN);
		expect(graphqlError.message).toContain("trace-7");
	});

	test("graphql errors carry the message and trace id", async () => {
		const client = new RailwayClient(railwayFromEnv({ RAILWAY_API_TOKEN: TOKEN }), {
			fetch: recordingFetch(() => ({ status: 200, body: { data: null, errors: [{ message: "Project not found", extensions: { traceId: "trace-42" } }] } })).fetch,
		});
		const error = await rejectionOf(client.monitor(REF));
		expect(error.kind).toBe("graphql");
		expect(error.message).toContain("Project not found");
		expect(error.message).toContain("trace-42");
	});

	test("reads without a token make no request", async () => {
		const { fetch, sent } = recordingFetch(() => ({ status: 200, body: { data: {} } }));
		const client = new RailwayClient(railwayFromEnv({ SUBSTRATE_RAILWAY_PROJECT_IDS: "proj-1" }), { fetch });
		expect((await rejectionOf(client.listResources())).kind).toBe("not-configured");
		expect((await rejectionOf(client.monitor(REF))).kind).toBe("not-configured");
		expect((await rejectionOf(client.suggestScale(REF))).kind).toBe("not-configured");
		expect((await client.costReport()).status).toBe("unconfigured");
		expect(sent).toHaveLength(0);
	});

	test("monitor maps the latest deployment", async () => {
		const instance = {
			serviceId: "svc-1",
			serviceName: "forwarder",
			environmentId: "env-1",
			numReplicas: 2,
			region: "us-west2",
			latestDeployment: { id: "dep-9", status: "SUCCESS", createdAt: "2026-10-20T10:00:00Z" },
		};
		const client = new RailwayClient(railwayFromEnv({ RAILWAY_API_TOKEN: TOKEN }), {
			fetch: recordingFetch(() => ({ status: 200, body: { data: { serviceInstance: instance } } })).fetch,
		});
		expect(await client.monitor(REF)).toEqual({
			environmentId: "env-1",
			serviceId: "svc-1",
			serviceName: "forwarder",
			numReplicas: 2,
			region: "us-west2",
			latestDeployment: { id: "dep-9", status: "SUCCESS", createdAt: "2026-10-20T10:00:00Z" },
		});

		const noDeployment = new RailwayClient(railwayFromEnv({ RAILWAY_API_TOKEN: TOKEN }), {
			fetch: recordingFetch(() => ({ status: 200, body: { data: { serviceInstance: { ...instance, latestDeployment: null } } } })).fetch,
		});
		expect((await noDeployment.monitor(REF)).latestDeployment).toBeNull();
	});

	test("list maps projects environments and services", async () => {
		const { fetch, sent } = recordingFetch(() => ({
			status: 200,
			body: {
				data: {
					project: {
						id: "proj-1",
						name: "substrate",
						environments: { edges: [{ node: { id: "env-1", name: "production", isEphemeral: false } }] },
						services: { edges: [{ node: { id: "svc-1", name: "forwarder" } }] },
					},
				},
			},
		}));
		const client = new RailwayClient(railwayFromEnv(READABLE_ENV), { fetch });
		expect(await client.listResources()).toEqual({
			projects: [
				{
					id: "proj-1",
					name: "substrate",
					environments: [{ id: "env-1", name: "production", isEphemeral: false }],
					services: [{ id: "svc-1", name: "forwarder" }],
				},
			],
			truncated: false,
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]?.url).toBe(RAILWAY_API_URL);
		expect(sent[0]?.variables).toEqual({ id: "proj-1" });
	});

	test("list without configured projects reads every project", async () => {
		const project = (id: string) => ({ node: { id, name: id, environments: { edges: [] }, services: { edges: [] } } });
		const { fetch, sent } = recordingFetch(() => ({ status: 200, body: { data: { projects: { edges: [project("p1"), project("p2")] } } } }));
		const client = new RailwayClient(railwayFromEnv({ RAILWAY_API_TOKEN: TOKEN }), { fetch });
		const resources = await client.listResources();
		expect(resources.projects.map((item) => item.id)).toEqual(["p1", "p2"]);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.variables).toEqual({});
	});
});

describe("p95 and rounding", () => {
	test("p95 is nearest rank", () => {
		expect(p95(Array.from({ length: 20 }, (_, index) => index + 1))).toBe(19);
		expect(p95([])).toBeNull();
	});

	test("rounds up without float drift", () => {
		expect(roundUpToQuantum(1.0000000001, 0.25)).toBe(1);
		expect(roundUpToQuantum(1.01, 0.25)).toBe(1.25);
		expect(roundUpToQuantum(0)).toBe(0);
	});
});

describe("suggestScale", () => {
	const scale = railwayFromEnv({}).scale;

	test("suggests p95 plus headroom", () => {
		const suggestion = suggestScale({ cpu: repeat(0.5, 30), memoryGb: repeat(0.2, 30), currentVcpus: 2, currentMemoryGb: 1, scale });
		expect(suggestion.status).toBe("ok");
		expect(suggestion.suggested).toEqual({ vCPUs: 0.75, memoryGB: 0.5 });
		expect(suggestion.p95).toEqual({ vCPUs: 0.5, memoryGB: 0.2 });
		expect(suggestion.samples).toBe(30);
	});

	test("suggestion clamps to bounds", () => {
		const high = suggestScale({ cpu: repeat(10, 30), memoryGb: repeat(0.2, 30), currentVcpus: 2, currentMemoryGb: 1, scale });
		expect(high.suggested?.vCPUs).toBe(4);
		const low = suggestScale({ cpu: repeat(0.01, 30), memoryGb: repeat(0.01, 30), currentVcpus: 2, currentMemoryGb: 1, scale });
		expect(low.suggested?.vCPUs).toBe(0.25);
		expect(low.suggested?.memoryGB).toBe(0.25);
	});

	test("too few samples gives no suggestion", () => {
		const suggestion = suggestScale({ cpu: repeat(0.5, 23), memoryGb: repeat(0.2, 30), currentVcpus: 2, currentMemoryGb: 1, scale });
		expect(suggestion.status).toBe("insufficient-data");
		expect(suggestion.suggested).toBeNull();
		expect(suggestion.samples).toBe(23);
	});

	test("missing limit gives no suggestion", () => {
		const suggestion = suggestScale({ cpu: repeat(0.5, 30), memoryGb: repeat(0.2, 30), currentVcpus: null, currentMemoryGb: 1, scale });
		expect(suggestion.status).toBe("insufficient-data");
		expect(suggestion.suggested).toBeNull();
	});
});

describe("cost report", () => {
	const prices = { CPU_USAGE: 0.02, MEMORY_USAGE_GB: 0.1 };

	test("priced total against budget", () => {
		const within = buildCostReport({
			usage: [
				{ measurement: "CPU_USAGE", estimatedValue: 1000 },
				{ measurement: "MEMORY_USAGE_GB", estimatedValue: 100 },
			],
			prices,
			budgetUsd: 50,
			configured: true,
			generatedAt: GENERATED_AT,
		});
		expect(within.status).toBe("ok");
		expect(within.projectedMonthlyUsd).toBeCloseTo(30);

		const over = buildCostReport({
			usage: [{ measurement: "CPU_USAGE", estimatedValue: 3000 }],
			prices,
			budgetUsd: 50,
			configured: true,
			generatedAt: GENERATED_AT,
		});
		expect(over.status).toBe("over-budget");
		expect(over.projectedMonthlyUsd).toBeCloseTo(60);
	});

	test("missing price never invents a total", () => {
		const report = buildCostReport({
			usage: [
				{ measurement: "CPU_USAGE", estimatedValue: 10 },
				{ measurement: "MEMORY_USAGE_GB", estimatedValue: 5 },
			],
			prices: { MEMORY_USAGE_GB: 0.1 },
			budgetUsd: 50,
			configured: true,
			generatedAt: GENERATED_AT,
		});
		expect(report.status).toBe("unpriced");
		expect(report.projectedMonthlyUsd).toBeNull();
		expect(report.lines.find((line) => line.measurement === "CPU_USAGE")).toEqual({
			measurement: "CPU_USAGE",
			estimatedValue: 10,
			unitPriceUsd: null,
			costUsd: null,
		});
		expect(report.lines.find((line) => line.measurement === "MEMORY_USAGE_GB")?.costUsd).toBeCloseTo(0.5);
	});

	test("zero-value unpriced line does not make the report unpriced", () => {
		const report = buildCostReport({
			usage: [{ measurement: "CPU_USAGE", estimatedValue: 1000 }],
			prices: { CPU_USAGE: 0.02 },
			budgetUsd: 50,
			configured: true,
			generatedAt: GENERATED_AT,
		});
		expect(report.status).toBe("ok");
		expect(report.projectedMonthlyUsd).toBeCloseTo(20);
	});

	test("unknown measurement skipped", () => {
		const report = buildCostReport({
			usage: [
				{ measurement: "AGENT_SPEND_USD", estimatedValue: 999 },
				{ measurement: "CPU_USAGE", estimatedValue: 100 },
			],
			prices: { CPU_USAGE: 0.01 },
			budgetUsd: 50,
			configured: true,
			generatedAt: GENERATED_AT,
		});
		const names: string[] = report.lines.map((line) => line.measurement);
		expect(names).not.toContain("AGENT_SPEND_USD");
		expect(report.projectedMonthlyUsd).toBeCloseTo(1);
	});

	test("unconfigured report makes no claim", () => {
		const report = buildCostReport({ usage: [], prices, budgetUsd: 50, configured: false, generatedAt: GENERATED_AT });
		expect(report.status).toBe("unconfigured");
		expect(report.projectedMonthlyUsd).toBeNull();
	});

	test("cost report sums estimates across configured projects", async () => {
		const { fetch, sent } = recordingFetch((request) => ({
			status: 200,
			body: {
				data: {
					estimatedUsage: [
						{ measurement: "CPU_USAGE", estimatedValue: request.variables.projectId === "proj-1" ? 1000 : 500, projectId: request.variables.projectId },
					],
				},
			},
		}));
		const client = new RailwayClient(railwayFromEnv({ ...READABLE_ENV, SUBSTRATE_RAILWAY_PROJECT_IDS: "proj-1,proj-2", SUBSTRATE_RAILWAY_PRICE_CPU_USD: "0.02" }), { fetch });
		const report = await client.costReport();
		expect(sent).toHaveLength(2);
		expect(report.status).toBe("ok");
		expect(report.projectedMonthlyUsd).toBeCloseTo(30);
	});

	test("cost report fails open", async () => {
		const client = new RailwayClient(railwayFromEnv(READABLE_ENV), { fetch: recordingFetch(() => "throw").fetch });
		const report = await client.costReport();
		expect(report.status).toBe("unavailable");
		expect(report.projectedMonthlyUsd).toBeNull();
		expect(report.detail).not.toContain(TOKEN);
	});

	test("cost report cached for fifteen minutes", async () => {
		let clock = Date.parse(GENERATED_AT);
		const { fetch, sent } = recordingFetch(() => ({ status: 200, body: { data: { estimatedUsage: [{ measurement: "CPU_USAGE", estimatedValue: 100, projectId: "proj-1" }] } } }));
		const client = new RailwayClient(railwayFromEnv(READABLE_ENV), { fetch, now: () => new Date(clock) });
		await client.costReport();
		await client.costReport();
		expect(sent).toHaveLength(1);
		clock += RAILWAY_COST_CACHE_MS + 1;
		await client.costReport();
		expect(sent).toHaveLength(2);
	});
});

describe("client deadline, single flight, scale bounds and pages", () => {
	test("every request carries an AbortSignal and a stalled request fails as transport", async () => {
		expect(RAILWAY_REQUEST_TIMEOUT_MS).toBe(5_000);
		const signals: AbortSignal[] = [];
		const fetch: RailwayFetch = (_input, init) => {
			signals.push(init.signal);
			return new Promise<never>(() => undefined);
		};
		const client = new RailwayClient(railwayFromEnv(READABLE_ENV), { fetch, timeoutMs: 10 });
		expect((await rejectionOf(client.monitor(REF))).kind).toBe("transport");
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(true);
	});

	test("a body that never finishes is bounded by the same deadline and reads as unavailable", async () => {
		const fetch: RailwayFetch = async () => ({ ok: true, status: 200, text: () => new Promise<string>(() => undefined) });
		const client = new RailwayClient(railwayFromEnv(READABLE_ENV), { fetch, timeoutMs: 10 });
		const report = await client.costReport();
		expect(report.status).toBe("unavailable");
		expect(report.projectedMonthlyUsd).toBeNull();
	});

	test("a failed cost read clears the slot and is not cached", async () => {
		let calls = 0;
		const fetch: RailwayFetch = async () => {
			calls += 1;
			if (calls === 1) throw new Error("socket reset");
			return { ok: true, status: 200, text: async () => JSON.stringify({ data: { estimatedUsage: [{ measurement: "CPU_USAGE", estimatedValue: 100, projectId: "proj-1" }] } }) };
		};
		const client = new RailwayClient(railwayFromEnv({ ...READABLE_ENV, SUBSTRATE_RAILWAY_PRICE_CPU_USD: "0.02" }), { fetch });
		expect((await client.costReport()).status).toBe("unavailable");
		expect((await client.costReport()).status).toBe("ok");
		expect(calls).toBe(2);
	});

	test("concurrent cost reads share one request", async () => {
		let calls = 0;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = () => resolve();
		});
		const fetch: RailwayFetch = async () => {
			calls += 1;
			await gate;
			return { ok: true, status: 200, text: async () => JSON.stringify({ data: { estimatedUsage: [{ measurement: "CPU_USAGE", estimatedValue: 100, projectId: "proj-1" }] } }) };
		};
		const client = new RailwayClient(railwayFromEnv({ ...READABLE_ENV, SUBSTRATE_RAILWAY_PRICE_CPU_USD: "0.02" }), { fetch });
		const first = client.costReport();
		const second = client.costReport();
		release();
		const [a, b] = await Promise.all([first, second]);
		expect(calls).toBe(1);
		expect(b).toBe(a);
		expect(a.status).toBe("ok");
	});

	test("a repeated project id is summed once", async () => {
		const { fetch, sent } = recordingFetch(() => ({ status: 200, body: { data: { estimatedUsage: [{ measurement: "CPU_USAGE", estimatedValue: 100, projectId: "proj-1" }] } } }));
		const client = new RailwayClient(railwayFromEnv({ ...READABLE_ENV, SUBSTRATE_RAILWAY_PROJECT_IDS: "proj-1,proj-1", SUBSTRATE_RAILWAY_PRICE_CPU_USD: "0.02" }), { fetch });
		const report = await client.costReport();
		expect(sent).toHaveLength(1);
		expect(report.projectedMonthlyUsd).toBeCloseTo(2);
	});

	test("suggestScale reads the window, parses the series and takes the newest limit", async () => {
		const now = Date.parse(GENERATED_AT);
		const points = (count: number, value: number) => Array.from({ length: count }, (_, index) => ({ ts: now - index * 300_000, value }));
		const metrics = [
			{ measurement: "CPU_USAGE", values: points(30, 0.5) },
			{ measurement: "MEMORY_USAGE_GB", values: points(30, 0.2) },
			{
				measurement: "CPU_LIMIT",
				values: [
					{ ts: now - 600_000, value: 2 },
					{ ts: now, value: 1 },
					{ ts: now - 300_000, value: 4 },
				],
			},
			{
				measurement: "MEMORY_LIMIT_GB",
				values: [
					{ ts: now - 300_000, value: 0.5 },
					{ ts: now, value: 2 },
				],
			},
		];
		const { fetch, sent } = recordingFetch(() => ({ status: 200, body: { data: { metrics } } }));
		const client = new RailwayClient(railwayFromEnv(READABLE_ENV), { fetch, now: () => new Date(now) });
		const suggestion = await client.suggestScale(REF);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.variables).toEqual({
			environmentId: "env-1",
			serviceId: "svc-1",
			startDate: "2026-10-20T00:00:00.000Z",
			endDate: "2026-10-21T00:00:00.000Z",
		});
		expect(sent[0]?.query).toContain("CPU_LIMIT");
		expect(suggestion).toMatchObject({
			status: "ok",
			current: { vCPUs: 1, memoryGB: 2 },
			p95: { vCPUs: 0.5, memoryGB: 0.2 },
			suggested: { vCPUs: 0.75, memoryGB: 0.5 },
			samples: 30,
			windowSeconds: 86_400,
		});
	});

	test("inverted scale bounds refuse the suggestion before any request", async () => {
		const { fetch, sent } = recordingFetch(() => ({ status: 200, body: { data: { metrics: [] } } }));
		const vcpus = new RailwayClient(railwayFromEnv({ ...READABLE_ENV, SUBSTRATE_RAILWAY_SCALE_MIN_VCPUS: "8" }), { fetch });
		const memory = new RailwayClient(railwayFromEnv({ ...READABLE_ENV, SUBSTRATE_RAILWAY_SCALE_MIN_MEMORY_GB: "16" }), { fetch });
		const vcpusError = await rejectionOf(vcpus.suggestScale(REF));
		expect(vcpusError.kind).toBe("configuration");
		expect(vcpusError.message).toContain("SUBSTRATE_RAILWAY_SCALE_MIN_VCPUS (8)");
		expect((await rejectionOf(memory.suggestScale(REF))).message).toContain("SUBSTRATE_RAILWAY_SCALE_MIN_MEMORY_GB (16)");
		expect(sent).toHaveLength(0);
	});

	test("a full page of items marks the resources truncated, a short page does not", async () => {
		const services = (count: number) => Array.from({ length: count }, (_, index) => ({ node: { id: `svc-${index}`, name: "svc" } }));
		const projectWith = (count: number) => ({ id: "proj-1", name: "substrate", environments: { edges: [] }, services: { edges: services(count) } });
		const short = new RailwayClient(railwayFromEnv(READABLE_ENV), { fetch: recordingFetch(() => ({ status: 200, body: { data: { project: projectWith(99) } } })).fetch });
		expect((await short.listResources()).truncated).toBe(false);
		const full = new RailwayClient(railwayFromEnv(READABLE_ENV), { fetch: recordingFetch(() => ({ status: 200, body: { data: { project: projectWith(100) } } })).fetch });
		expect((await full.listResources()).truncated).toBe(true);
		const listed = Array.from({ length: 100 }, (_, index) => ({ node: { id: `p-${index}`, name: "p", environments: { edges: [] }, services: { edges: [] } } }));
		const all = new RailwayClient(railwayFromEnv({ RAILWAY_API_TOKEN: TOKEN }), { fetch: recordingFetch(() => ({ status: 200, body: { data: { projects: { edges: listed } } } })).fetch });
		const resources = await all.listResources();
		expect(resources.projects).toHaveLength(100);
		expect(resources.truncated).toBe(true);
	});
});
