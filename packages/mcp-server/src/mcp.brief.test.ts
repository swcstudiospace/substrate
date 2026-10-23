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
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { METRIC, findCounter, sumCounter } from "@substrate/observability";
import { MEMORY_GENERATION_KEY, ReadThroughCache, type CacheRedis } from "./cache.ts";
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
async function rig(index: Record<string, unknown>, options: { cache?: ReadThroughCache; env?: Record<string, string> } = {}): Promise<Rig> {
	const config = loadConfig(options.env ?? {});
	const observability = createObservability(config, {});
	await observability.start();
	const substrate = new Substrate(config, { index: index as never, greptime: null, ...(options.cache ? { cache: options.cache } : {}) }, observability.observer);
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
	profile?: string;
	age_s?: number;
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
			profile: "full",
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
		expect(propertyNames(tool?.outputSchema)).toEqual(["age_s", "etag", "failed_sources", "not_modified", "profile", "snapshot_at", "state", "surface"]);
		expect(propertyNames(tool?.inputSchema)).toContain("if_none_match");
		expect(propertyNames(tool?.inputSchema)).toContain("profile");
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

	test("a brief served stale carries age_s, equal to the REST x-substrate-brief-age header, and state stays complete", async () => {
		const values = new Map<string, string>();
		const redis: CacheRedis = {
			get: async (key) => values.get(key) ?? null,
			set: async (key, value) => {
				values.set(key, value);
			},
			incr: async (key) => {
				const next = Number(values.get(key) ?? "0") + 1;
				values.set(key, String(next));
				return next;
			},
		};
		// The cache's clock runs 7 s ahead of the snapshot's own timestamp, so the age is 7 whatever the machine speed.
		const cache = new ReadThroughCache({ redis, enabled: true, log: () => {}, now: () => Date.now() + 7_000, swr: { mode: "enforce", windowS: 30 } });
		let down = false;
		const index = {
			getGraph: async () => {
				if (down) throw new Error("postgres is down");
				return graphView("ut-1");
			},
			openGraphs: async () => [],
			memoryForBrief: async () => [],
		};
		const { client, base } = await rig(index, { cache });
		const fresh = await brief(client, ARGS);
		expect(fresh.structured.age_s).toBeUndefined();

		// A write moves the generation; the sources then fail, so only the last-good can answer, and no refresh can store.
		await cache.bump(MEMORY_GENERATION_KEY);
		down = true;
		const stale = await brief(client, ARGS);
		expect(stale.structured.state).toBe("complete");
		expect(stale.structured.age_s).toBe(7);
		expect(stale.text).toBe(fresh.text);

		const rest = await restBrief(base);
		expect(rest.headers.get("x-substrate-brief")).toBe("complete");
		expect(rest.headers.get("x-substrate-brief-age")).toBe(String(stale.structured.age_s));

		// A matching validator on the stale path is a 304 that still says it was stale.
		const unchanged = await restBrief(base, stale.structured.etag);
		expect(unchanged.status).toBe(304);
		expect(unchanged.headers.get("x-substrate-brief-age")).toBe("7");
		const conditional = await brief(client, { ...ARGS, if_none_match: stale.structured.etag });
		expect(conditional.structured).toMatchObject({ not_modified: true, state: "complete", age_s: 7 });
	});
});

describe("memory_brief if_none_match", () => {
	test("a matching validator answers not_modified with the etag and state and no brief text", async () => {
		const { client } = await rig(COMPLETE_INDEX);
		const first = await brief(client, ARGS);
		const unchanged = await brief(client, { ...ARGS, if_none_match: first.structured.etag });
		expect(unchanged.isError).toBe(false);
		expect(unchanged.structured).toEqual({ not_modified: true, etag: first.structured.etag, state: "complete", surface: "grok-bot", profile: "full" });
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

const ENFORCE = { env: { SUBSTRATE_BRIEF_PROFILE: "enforce" } };

function restBriefBody(base: string, body: Record<string, unknown>, ifNoneMatch?: string) {
	return fetch(`${base}/brief`, {
		method: "POST",
		body: JSON.stringify({ ...ARGS, surface: "grok-bot", ...body }),
		headers: { "content-type": "application/json", ...(ifNoneMatch === undefined ? {} : { "if-none-match": ifNoneMatch }) },
	});
}

describe("memory_brief profiles (uplift-4 S1)", () => {
	test("default shadow serves grok-bot the full text, as before, and says so", async () => {
		const { client, base } = await rig(COMPLETE_INDEX);
		const tool = await brief(client, ARGS);
		expect(tool.structured.profile).toBe("full");
		expect(tool.text.startsWith("## Substrate brief: acme/app — ut-1")).toBe(true);
		// Shadow serves full even when compact is asked for: only enforce changes what is served.
		const asked = await brief(client, { ...ARGS, profile: "compact" });
		expect(asked.structured.profile).toBe("full");
		expect(asked.text).toBe(tool.text);
		const rest = await restBriefBody(base, { profile: "compact" });
		expect(rest.headers.get("x-substrate-brief-profile")).toBe("full");
		expect(await rest.text()).toBe(tool.text);
	});

	test("enforce serves compact to grok-bot, state line first; an explicit full wins; the tags differ per profile", async () => {
		const { client } = await rig(COMPLETE_INDEX, ENFORCE);
		const compact = await brief(client, ARGS);
		expect(compact.structured.profile).toBe("compact");
		expect(compact.text.split("\n")[0]).toBe("[brief: complete]");
		expect(compact.text.split("\n")[1]).toBe("## Substrate brief: acme/app — ut-1");
		const full = await brief(client, { ...ARGS, profile: "full" });
		expect(full.structured.profile).toBe("full");
		expect(full.text.startsWith("## Substrate brief")).toBe(true);
		expect(full.text).not.toContain("[brief:");
		expect(full.structured.etag).not.toBe(compact.structured.etag);

		// A validator names one rendering: the compact tag matches the compact text only.
		const same = await brief(client, { ...ARGS, if_none_match: compact.structured.etag });
		expect(same.structured).toEqual({ not_modified: true, etag: compact.structured.etag, state: "complete", surface: "grok-bot", profile: "compact" });
		const other = await brief(client, { ...ARGS, profile: "full", if_none_match: compact.structured.etag });
		expect(other.structured.not_modified).toBeUndefined();
		expect(other.text).toBe(full.text);
	});

	test("a degraded compact brief states it on the first line, with the header-dropping gateway in mind", async () => {
		const { client, base } = await rig(DEGRADED_INDEX, ENFORCE);
		const tool = await brief(client, ARGS);
		expect(tool.structured.state).toBe("degraded");
		expect(tool.text.split("\n")[0]).toBe("[brief: degraded; failed: graph, memory]");
		const rest = await restBriefBody(base, {});
		expect(rest.headers.get("x-substrate-brief-profile")).toBe("compact");
		expect(rest.headers.get("x-substrate-brief")).toBe("degraded");
		expect((await rest.text()).split("\n")[0]).toBe("[brief: degraded; failed: graph, memory]");
	});

	test("REST: the profile header rides a 304 too, and an unknown profile is a 400 that serves nothing", async () => {
		const { base } = await rig(COMPLETE_INDEX, ENFORCE);
		const first = await restBriefBody(base, {});
		expect(first.headers.get("x-substrate-brief-profile")).toBe("compact");
		const etag = first.headers.get("etag")!;
		const unchanged = await restBriefBody(base, {}, etag);
		expect(unchanged.status).toBe(304);
		expect(unchanged.headers.get("x-substrate-brief-profile")).toBe("compact");
		const full = await restBriefBody(base, { profile: "full" }, etag);
		expect(full.status).toBe(200);
		expect(full.headers.get("x-substrate-brief-profile")).toBe("full");

		for (const bad of ["compat", "", "FULL", 3, ["compact"]]) {
			const refused = await restBriefBody(base, { profile: bad });
			expect(refused.status).toBe(400);
			const payload: unknown = await refused.json();
			expect(payload).toEqual({ error: expect.stringContaining("profile") });
		}
	});

	test("MCP: an unknown profile is a tool error, never coerced", async () => {
		const { client } = await rig(COMPLETE_INDEX, ENFORCE);
		const refused = await brief(client, { ...ARGS, profile: "compat" });
		expect(refused.isError).toBe(true);
		expect(refused.text).toContain("profile");
		expect(refused.structured).toBeUndefined();
	});

	test("served.tokens_est counts fresh answers by bytes/4 and never a 304; substrate.tokens is untouched", async () => {
		const { client, observability } = await rig(COMPLETE_INDEX, ENFORCE);
		const first = await brief(client, ARGS);
		await brief(client, { ...ARGS, if_none_match: first.structured.etag });
		const estimated = findCounter(observability.snapshot(), METRIC.servedTokensEst)!;
		expect(sumCounter(estimated, { surface: "grok-bot", tool: "brief" })).toBe(Math.ceil(Buffer.byteLength(first.text, "utf8") / 4));
		expect(sumCounter(estimated)).toBe(sumCounter(estimated, { tool: "brief" }));
		expect(sumCounter(findCounter(observability.snapshot(), METRIC.tokens)!)).toBe(0);

		// The profile counter counts every answer, the 304 included.
		const profiled = findCounter(observability.snapshot(), METRIC.briefProfile)!;
		expect(sumCounter(profiled, { surface: "grok-bot", profile: "compact", mode: "enforce" })).toBe(2);
	});
});

describe("the profile follows the bearer's surface, not the surface claimed in the request (uplift-4 S1)", () => {
	test("REST: a grok-bot bearer claiming another surface in the body is refused, and its own request is served compact", async () => {
		const token = randomUUID();
		const { base } = await rig(COMPLETE_INDEX, { env: { SUBSTRATE_BRIEF_PROFILE: "enforce", SUBSTRATE_TOKEN_GROK_BOT: token } });
		// A tokened caller's brief is its own surface's: a body naming another is 403, never served under that name.
		const claimed = await fetch(`${base}/brief`, {
			method: "POST",
			body: JSON.stringify({ ...ARGS, surface: "cursor" }),
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		});
		expect(claimed.status).toBe(403);
		const refusal = (await claimed.json()) as { error: string };
		expect(refusal.error).toBe("this token is grok-bot and cannot act as cursor");
		// With no claim in the body, the bearer's surface is the one served, compact under enforce.
		const own = await fetch(`${base}/brief`, {
			method: "POST",
			body: JSON.stringify(ARGS),
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		});
		expect(own.status).toBe(200);
		expect(own.headers.get("x-substrate-brief-profile")).toBe("compact");
		expect((await own.text()).split("\n")[0]).toBe("[brief: complete]");
		// An explicit full still wins for that bearer.
		const full = await fetch(`${base}/brief`, {
			method: "POST",
			body: JSON.stringify({ ...ARGS, profile: "full" }),
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		});
		expect(full.headers.get("x-substrate-brief-profile")).toBe("full");
	});

	test("MCP: a grok-bot caller passing another surface argument is refused, and its own request is served compact", async () => {
		const { client } = await rig(COMPLETE_INDEX, ENFORCE);
		// A tokened caller's brief is its own surface's: a `surface` argument naming another is a tool error, not a brief.
		const claimed = await brief(client, { ...ARGS, surface: "cursor" });
		expect(claimed.isError).toBe(true);
		const refusal = JSON.parse(claimed.text) as { error: string };
		expect(refusal.error).toBe("this token is grok-bot and cannot act as cursor");
		expect(claimed.structured).toBeUndefined();
		const own = await brief(client, ARGS);
		expect(own.structured.surface).toBe("grok-bot");
		expect(own.structured.profile).toBe("compact");
		expect(own.text.split("\n")[0]).toBe("[brief: complete]");
	});
});
