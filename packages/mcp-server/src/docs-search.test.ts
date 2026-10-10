/**
 * Plan 25-01 Task 2: docs_search returns at most 10 cited redacted results
 * with untrusted framing and a URL-listing note event; errors yield empty
 * plus reason. Proved against the recording fake.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { searchDocs, SNIPPET_CAP, UNTRUSTED_DOCS_NOTICE, type SearchReply } from "./docs-search.ts";
import { RagflowFake } from "./ragflow-fake.ts";
import type { EventInput } from "./types.ts";
import { loadConfig } from "./config.ts";
import { createMcpServer } from "./mcp.ts";
import { Substrate } from "./service.ts";

const CONFIG = { url: "http://ragflow.test", apiKey: "test-key" };

function harness(fake: RagflowFake, pins?: Record<string, { dataset: string; dataset_id: string; version: string; commit: string }>) {
	const events: EventInput[] = [];
	const emit = async (event: EventInput): Promise<unknown> => {
		events.push(event);
		return { stored: false };
	};
	const search = (question: string): Promise<SearchReply> =>
		searchDocs({ config: CONFIG, emit, fetchImpl: fake.fetch, ...(pins ? { pins } : {}) }, question);
	return { events, search };
}

describe("docs_search", () => {
	test("returns cited redacted results with untrusted framing and a URL-listing event", async () => {
		const fake = new RagflowFake();
		const { events, search } = harness(fake);
		const reply = await search("who reads RAGFlow?");
		expect(reply.degraded).toBeUndefined();
		expect(reply.untrusted).toBe(UNTRUSTED_DOCS_NOTICE);
		expect(reply.chunks.length).toBeGreaterThan(0);
		expect(reply.chunks.length).toBeLessThanOrEqual(10);
		for (const citation of reply.chunks) {
			expect(citation.title).toBeString();
			expect(citation.source_url).toBeString();
			expect(citation.snippet.length).toBeLessThanOrEqual(SNIPPET_CAP);
		}
		const notes = events.filter((event) => event.kind === "note");
		expect(notes).toHaveLength(1);
		const payload = notes[0]?.payload ?? {};
		expect(payload.action).toBe("docs.search");
		expect(payload.urls).toEqual(reply.chunks.map((citation) => citation.source_url));
		expect(notes[0]?.repo).toBeFalsy();
	});

	test("falls back to the dataset pin commit when RAGFlow returns none", async () => {
		const fake = new RagflowFake();
		fake.chunkShape = "minimal";
		const { search } = harness(fake, {
			"ds-berlin-agent-substrate": {
				dataset: "agent-substrate",
				dataset_id: "ds-berlin-agent-substrate",
				version: "v3",
				commit: "abc123",
			},
		});
		const reply = await search("pin fallback?");
		expect(reply.chunks.length).toBeGreaterThan(0);
		expect(reply.chunks[0]?.commit).toBe("abc123");
	});

	test("names the pin gap instead of inventing a commit", async () => {
		const fake = new RagflowFake();
		const { search } = harness(fake);
		const reply = await search("no pins yet?");
		expect(reply.chunks.length).toBeGreaterThan(0);
		expect(reply.chunks[0]?.commit).toContain("agent-substrate");
	});

	test("redacts snippets before reply", async () => {
		const fake = new RagflowFake();
		fake.chunks["ds-berlin-agent-substrate"] = [
			{
				content: "paste sk-proj-abcdefghij1234567890 into RAGFlow",
				document_name: "leak.md",
				document_id: "doc-leak",
				chunk_id: "chunk-leak",
				source_url: "https://example.com/leak",
				score: 0.99,
			},
		];
		const { search } = harness(fake);
		const reply = await search("where is the key?");
		const leaked = reply.chunks.find((citation) => citation.document_id === "doc-leak");
		expect(leaked?.snippet).toBeString();
		expect(leaked?.snippet).not.toContain("sk-proj-");
		expect(leaked?.snippet).toContain("[REDACTED]");
	});

	test("an error yields empty plus reason with a warning event", async () => {
		const fake = new RagflowFake();
		fake.failRetrievalWith = 503;
		const { events, search } = harness(fake);
		const reply = await search("who reads RAGFlow?");
		expect(reply).toMatchObject({ chunks: [], degraded: true });
		expect(typeof reply.reason).toBe("string");
		const warnings = events.filter((event) => event.kind === "warning");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.payload).toMatchObject({ action: "docs.search", reason: reply.reason });
	});

	test("an unconfigured plane yields empty plus reason", async () => {
		const events: EventInput[] = [];
		const reply = await searchDocs(
			{
				config: null,
				emit: async (event: EventInput): Promise<unknown> => {
					events.push(event);
					return { stored: false };
				},
			},
			"who reads RAGFlow?",
		);
		expect(reply).toMatchObject({ chunks: [], degraded: true, reason: "ragflow-not-configured" });
		expect(events).toHaveLength(1);
	});
});

describe("docs_search wiring", () => {
	test("Substrate.searchDocs serves citations and degrades when unconfigured", async () => {
		const fake = new RagflowFake();
		const live = new Substrate(loadConfig({ RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" }), {
			index: null,
			greptime: null,
			ragflowFetch: fake.fetch,
		});
		const reply = await live.searchDocs({ question: "who reads RAGFlow?" }, "omp");
		expect(reply.degraded).toBeUndefined();
		expect(reply.chunks.length).toBeGreaterThan(0);

		const bare = new Substrate(loadConfig({}), { index: null, greptime: null });
		const degraded = await bare.searchDocs({ question: "who reads RAGFlow?" }, "omp");
		expect(degraded).toMatchObject({ chunks: [], degraded: true, reason: "ragflow-not-configured" });
	});

	test("docs_search is callable over MCP", async () => {
		const fake = new RagflowFake();
		const substrate = new Substrate(loadConfig({ RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" }), {
			index: null,
			greptime: null,
			ragflowFetch: fake.fetch,
		});
		const server = createMcpServer(substrate, "omp");
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		try {
			const tools = (await client.listTools()).tools;
			expect(tools.some((tool) => tool.name === "docs_search")).toBe(true);
			const result = await client.callTool({ name: "docs_search", arguments: { question: "who reads RAGFlow?" } });
			const content = result.content as Array<{ type: string; text?: string }>;
			const reply = JSON.parse(content[0]?.text ?? "{}") as { chunks?: unknown[]; untrusted?: string };
			expect(Array.isArray(reply.chunks) && reply.chunks.length > 0).toBe(true);
			expect(typeof reply.untrusted).toBe("string");
		} finally {
			await client.close();
			await server.close();
		}
	});
});

describe("docs_search metadata redaction", () => {
	test("title, source URL and heading path are redacted like snippets", async () => {
		const fake = new RagflowFake();
		fake.chunks["ds-berlin-agent-substrate"] = [
			{
				content: "clean body",
				document_name: "sk-proj-abcdefghij1234567890",
				document_id: "doc-meta",
				chunk_id: "chunk-meta",
				heading_path: "sk-proj-abcdefghij1234567890",
				source_url: "https://example.com/sk-proj-abcdefghij1234567890",
				score: 0.99,
			},
		];
		const { search } = harness(fake);
		const reply = await search("where is the key?");
		const cited = reply.chunks.find((citation) => citation.document_id === "doc-meta");
		expect(cited?.title).not.toContain("sk-proj-");
		expect(cited?.source_url).not.toContain("sk-proj-");
		expect(cited?.heading_path).not.toContain("sk-proj-");
	});
});
