/**
 * The `memory_brief` metadata contract (uplift-3 N7).
 *
 * The tool's text is what it always was; `structuredContent` carries the same
 * ETag and state `POST /brief` puts in its headers, and `if_none_match` answers
 * `not_modified` by the same matcher. Both doors are driven here — the MCP tool
 * over an in-memory transport, the REST route over a real socket — against one
 * substrate, so the two can be compared on the same request. Every store is a
 * fake; nothing here opens a socket to anything but its own server.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { METRIC, findCounter, sumCounter } from "@substrate/observability";
import type { AddressInfo } from "node:net";
import { loadConfig } from "./config.ts";
import { createMcpServer } from "./mcp.ts";
import { createObservability, type Observability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";

function graphView(graphId: string) {
	return {
		graph_id: graphId,
		notion_task_page: null,
		repo: "acme/app",
		branch: null,
		surface: "grok-bot",
		status: "active",
		pr_url: null,
		created: null,
		updated: null,
		nodes: [],
		steps: [],
		edges: [],
	};
}

const COMPLETE_INDEX = { getGraph: async () => graphView("ut-1"), openGraphs: async () => [], memoryForBrief: async () => [] };
const DEGRADED_INDEX = {
	getGraph: () => Promise.reject(new Error("postgres is down")),
	openGraphs: async () => [],
	memoryForBrief: () => Promise.reject(new Error("postgres is down")),
};

interface Rig {
	client: Client;
	base: string;
	observability: Observability;
	close(): void;
}
const rigs: Rig[] = [];
afterAll(() => {
	for (const rig of rigs) rig.close();
});

/** One substrate behind both doors: an MCP client as `grok-bot` and the REST route on a loopback port. */
async function rig(index: Record<string, unknown>): Promise<Rig> {
	const config = loadConfig({});
	const observability = createObservability(config, {});
	await observability.start();
	const substrate = new Substrate(config, { index: index as never, greptime: null }, observability.observer);
	const mcp = createMcpServer(substrate, "grok-bot");
	const client = new Client({ name: "brief-contract", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
	const http = createHttpServer(substrate, config, observability);
	const listening = Promise.withResolvers<void>();
	http.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const { port } = http.address() as AddressInfo;
	const built: Rig = {
		client,
		base: `http://127.0.0.1:${port}`,
		observability,
		close() {
			observability.stop();
			http.close();
		},
	};
	rigs.push(built);
	return built;
}

const ARGS = { repo: "acme/app", graph_id: "ut-1" };

interface Structured {
	etag: string;
	state: string;
	surface: string;
	not_modified?: boolean;
	failed_sources?: string[];
	snapshot_at?: string | null;
}

async function brief(client: Client, args: Record<string, unknown>) {
	const result = await client.callTool({ name: "memory_brief", arguments: args });
	const content = result.content as Array<{ type: string; text?: string }>;
	return {
		isError: result.isError === true,
		text: content[0]?.text ?? "",
		structured: result.structuredContent as Structured,
	};
}

function restBrief(base: string, ifNoneMatch?: string) {
	return fetch(`${base}/brief`, {
		method: "POST",
		body: JSON.stringify({ ...ARGS, surface: "grok-bot" }),
		headers: { "content-type": "application/json", ...(ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch }) },
	});
}

/** The property names a JSON schema object declares, narrowed at runtime rather than asserted. */
function propertyNames(schema: unknown): string[] {
	if (schema && typeof schema === "object" && "properties" in schema && schema.properties && typeof schema.properties === "object") {
		return Object.keys(schema.properties).sort();
	}
	return [];
}

describe("memory_brief structured metadata", () => {
	test("carries etag, state, failed_sources and snapshot_at, equal to the REST headers for the same request", async () => {
		const { client, base } = await rig(COMPLETE_INDEX);
		const tool = await brief(client, ARGS);
		expect(tool.isError).toBe(false);
		expect(tool.text).toContain("active");
		expect(tool.structured).toEqual({
			etag: expect.stringMatching(/^W\/"[0-9a-f]{32}"$/),
			state: "complete",
			surface: "grok-bot",
			failed_sources: [],
			snapshot_at: null,
		});

		const rest = await restBrief(base);
		expect(rest.status).toBe(200);
		expect(rest.headers.get("etag")).toBe(tool.structured.etag);
		expect(rest.headers.get("x-substrate-brief")).toBe(tool.structured.state);
		// The same text, so the same tag: one stored ETag works at both doors.
		expect(await rest.text()).toBe(tool.text);
	});

	test("advertises the output schema so a client can rely on the fields", async () => {
		const { client } = await rig(COMPLETE_INDEX);
		const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "memory_brief");
		expect(propertyNames(tool?.outputSchema)).toEqual(["etag", "failed_sources", "not_modified", "snapshot_at", "state", "surface"]);
		expect(propertyNames(tool?.inputSchema)).toContain("if_none_match");
	});

	test("a degraded brief reports state degraded with the failed sources, and is not an error", async () => {
		const { client, base } = await rig(DEGRADED_INDEX);
		const tool = await brief(client, ARGS);
		expect(tool.isError).toBe(false);
		expect(tool.text).toContain("not in the index yet");
		expect(tool.structured.state).toBe("degraded");
		expect(tool.structured.failed_sources).toEqual(["graph", "memory"]);
		expect(tool.structured.snapshot_at).toBeNull();

		const rest = await restBrief(base);
		expect(rest.headers.get("x-substrate-brief")).toBe("degraded");
		expect(rest.headers.get("x-substrate-brief-failed")).toBe("graph,memory");
		expect(rest.headers.get("etag")).toBe(tool.structured.etag);
	});
});

describe("memory_brief if_none_match", () => {
	test("a matching validator answers not_modified with the etag and state and no brief text", async () => {
		const { client } = await rig(COMPLETE_INDEX);
		const first = await brief(client, ARGS);
		const unchanged = await brief(client, { ...ARGS, if_none_match: first.structured.etag });
		expect(unchanged.isError).toBe(false);
		expect(unchanged.structured).toEqual({ not_modified: true, etag: first.structured.etag, state: "complete", surface: "grok-bot" });
		expect(unchanged.text).toBe(`brief unchanged (etag ${first.structured.etag})`);
		expect(unchanged.text.length).toBeLessThanOrEqual(60);
		expect(unchanged.text).not.toContain("active");
	});

	test("weak, strong, list and * forms match — the REST matcher, not a second one", async () => {
		const { client, base } = await rig(COMPLETE_INDEX);
		const { structured } = await brief(client, ARGS);
		const opaque = structured.etag.replace(/^W\//, "");
		for (const form of [structured.etag, opaque, `"zzz", ${structured.etag}`, `"zzz",${opaque}`, "*"]) {
			const reply = await brief(client, { ...ARGS, if_none_match: form });
			expect(reply.structured.not_modified).toBe(true);
			const rest = await restBrief(base, form);
			expect(rest.status).toBe(304);
			expect(await rest.text()).toBe("");
		}
	});

	test("a mismatch answers the full brief with its metadata", async () => {
		const { client } = await rig(COMPLETE_INDEX);
		const first = await brief(client, ARGS);
		const stale = await brief(client, { ...ARGS, if_none_match: 'W/"00000000000000000000000000000000"' });
		expect(stale.structured.not_modified).toBeUndefined();
		expect(stale.structured.etag).toBe(first.structured.etag);
		expect(stale.text).toBe(first.text);
		const empty = await brief(client, { ...ARGS, if_none_match: "" });
		expect(empty.structured.not_modified).toBeUndefined();
		expect(empty.text).toBe(first.text);
	});

	test("counts every answer in substrate.brief.result by surface, state and result, at both doors", async () => {
		const { client, base, observability } = await rig(COMPLETE_INDEX);
		const first = await brief(client, ARGS);
		await brief(client, { ...ARGS, if_none_match: first.structured.etag });
		await restBrief(base);
		await restBrief(base, first.structured.etag);

		const counter = findCounter(observability.snapshot(), METRIC.briefResult);
		expect(counter).not.toBeNull();
		expect(sumCounter(counter!, { surface: "grok-bot", state: "complete", result: "fresh" })).toBe(2);
		expect(sumCounter(counter!, { surface: "grok-bot", state: "complete", result: "not_modified" })).toBe(2);
		expect(sumCounter(counter!)).toBe(4);
	});

	test("a surface the body invents is counted as unknown, so the label stays bounded", async () => {
		const { base, observability } = await rig(COMPLETE_INDEX);
		const response = await fetch(`${base}/brief`, {
			method: "POST",
			body: JSON.stringify({ ...ARGS, surface: "not-a-surface" }),
			headers: { "content-type": "application/json" },
		});
		expect(response.status).toBe(200);
		const counter = findCounter(observability.snapshot(), METRIC.briefResult)!;
		expect(sumCounter(counter, { surface: "unknown", result: "fresh" })).toBe(1);
		expect(sumCounter(counter, { surface: "not-a-surface" })).toBe(0);
	});
});
