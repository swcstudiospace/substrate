/**
 * RagflowClient against an in-process fake transport (D25-23, D25-03).
 * No test performs a real network call: every transport below is a function
 * returning canned responses. Secrets are runtime-assembled fixtures, and no
 * test or error path echoes a key, a URL, or a raw body.
 */
import { describe, expect, test } from "bun:test";
import type { RagflowConfig } from "../config.ts";
import { RagflowClient, RagflowError } from "./ragflow.ts";
import type { RagflowFetch } from "./ragflow.ts";

const ORIGIN = "http://localhost:9380";
// Inert test values assembled at runtime, never credentials.
const KEY = "test-" + "key-9f8e7d6c5b4a8301";
const SECRET_TAIL = "c".repeat(36);
const PLANTED = "ghp_" + SECRET_TAIL;

function config(over: Partial<RagflowConfig> = {}): RagflowConfig {
	return { url: ORIGIN, apiKey: KEY, timeoutMs: 1000, problem: null, ...over };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function fails(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(RagflowError);
		return (error as Error).message;
	}
	throw new Error("expected a RagflowError");
}
describe("request shape", () => {
	test("retrieval sends Bearer auth with explicit dataset_ids and page_size", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const chunks = [
			{
				id: "chunk-1",
				content: "hello docs",
				document_id: "doc-1",
				dataset_id: "ds-1",
				similarity: 0.9,
				document_keyword: "guide.md",
			},
		];
		const client = new RagflowClient(config(), async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return json({ code: 0, data: { chunks, total: 1 } });
		});

		const hits = await client.retrieval({ question: "how?", datasetIds: ["ds-1"], pageSize: 5 });

		expect(hits).toEqual([
			{
				chunkId: "chunk-1",
				documentId: "doc-1",
				datasetId: "ds-1",
				content: "hello docs",
				score: 0.9,
				documentName: "guide.md",
				raw: chunks[0],
			},
		]);
		expect(calls.length).toBe(1);
		const first = calls[0]!;
		expect(first.url).toBe(`${ORIGIN}/api/v1/retrieval`);
		const headers = first.init.headers as Record<string, string>;
		expect(headers.authorization).toBe(`Bearer ${KEY}`);
		const body = JSON.parse(first.init.body as string) as Record<string, unknown>;
		expect(body.dataset_ids).toEqual(["ds-1"]);
		expect(body.page_size).toBe(5);
		expect(body.question).toBe("how?");
		expect(first.url).not.toContain(KEY);
	});

	test("retrieval refuses an empty dataset_ids without calling the transport", async () => {
		let called = 0;
		const client = new RagflowClient(config(), async () => {
			called += 1;
			return json({ code: 0, data: { chunks: [] } });
		});
		const message = await fails(client.retrieval({ question: "how?", datasetIds: [], pageSize: 5 }));
		expect(message).toContain("dataset_ids");
		expect(called).toBe(0);
	});

	test("an unconfigured client reports itself", () => {
		expect(new RagflowClient(config()).configured).toBe(true);
		expect(new RagflowClient(config({ apiKey: undefined, problem: "x" })).configured).toBe(false);
	});
});

describe("failure mapping without network", () => {
	test("a hanging transport times out on the configured budget", async () => {
		const hanging: RagflowFetch = (_url, init) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			const abort = () => reject(new DOMException("timed out", "TimeoutError"));
			if (init.signal?.aborted) abort();
			else init.signal?.addEventListener("abort", abort);
			return promise;
		};
		const client = new RagflowClient(config({ timeoutMs: 20 }), hanging);
		const message = await fails(client.listDatasets());
		expect(message).toContain("timeout after 20ms");
	});
	test("a stalled body maps to a timeout, not a generic error", async () => {
		const client = new RagflowClient(config({ timeoutMs: 50 }), async () => {
			const response = json({ code: 0, data: [] });
			Object.defineProperty(response, "text", {
				value: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
			});
			return response;
		});
		const message = await fails(client.listDatasets());
		expect(message).toContain("timeout after 50ms");
	});


	test("a non-zero code redacts and cuts the message", async () => {
		const long = `${PLANTED} ${"padding ".repeat(60)}`;
		const client = new RagflowClient(
			config(),
			async () => json({ code: 109, message: long }),
		);
		const message = await fails(client.listDatasets());
		expect(message).toContain("ragflow error 109");
		expect(message).not.toContain(SECRET_TAIL);
		expect(message).not.toContain(PLANTED);
		expect(message.length).toBeLessThan(260);
	});

	test("malformed JSON answers without echoing the body", async () => {
		const client = new RagflowClient(
			config(),
			async () => new Response(`{broken ${KEY}`, { status: 200 }),
		);
		const message = await fails(client.listDatasets());
		expect(message).toBe("ragflow returned non-JSON");
		expect(message).not.toContain(KEY);
	});

	test("a non-2xx status redacts the text and cuts it", async () => {
		const client = new RagflowClient(
			config(),
			async () => new Response(`denied for ${KEY} ${"x".repeat(500)}`, { status: 500 }),
		);
		const message = await fails(client.listDatasets());
		expect(message).toContain("ragflow 500");
		expect(message).not.toContain(KEY);
		expect(message.length).toBeLessThan(260);
	});

	test("a cross-origin redirect is refused without following or naming the URL", async () => {
		let calls = 0;
		const client = new RagflowClient(config(), async (url) => {
			calls += 1;
			expect(url.startsWith(ORIGIN)).toBe(true);
			return new Response(null, { status: 302, headers: { location: "https://example.test/stolen" } });
		});
		const message = await fails(client.listDatasets());
		expect(message).toContain("cross-origin redirect");
		expect(message).not.toContain("example.test");
		expect(calls).toBe(1);
	});

	test("a same-origin redirect is followed", async () => {
		const calls: string[] = [];
		const client = new RagflowClient(config(), async (url) => {
			calls.push(url);
			if (calls.length === 1) {
				return new Response(null, { status: 302, headers: { location: "/api/v1/datasets?page=1&page_size=100" } });
			}
			return json({ code: 0, data: [{ id: "ds-1", name: "agent-substrate" }] });
		});
		const datasets = await client.listDatasets();
		expect(datasets).toEqual([{ id: "ds-1", name: "agent-substrate", embeddingModel: undefined }]);
		expect(calls).toEqual([`${ORIGIN}/api/v1/datasets?page=1&page_size=100`, `${ORIGIN}/api/v1/datasets?page=1&page_size=100`]);
	});
});

describe("documents, parse and versions", () => {
	test("upload posts multipart file fields and returns created ids", async () => {
		let method: unknown;
		let body: unknown;
		const client = new RagflowClient(config(), async (_url, init) => {
			method = init.method;
			body = init.body;
			return json({ code: 0, data: [{ id: "doc-1", name: "guide.md" }] });
		});
		const out = await client.uploadDocuments("ds-1", [{ filename: "guide.md", content: "# hi" }]);
		expect(out).toEqual([{ documentId: "doc-1", name: "guide.md" }]);
		expect(method).toBe("POST");
		expect(body).toBeInstanceOf(FormData);
		expect((body as FormData).getAll("file").length).toBe(1);
	});

	test("parse sends document_ids", async () => {
		let body: unknown = null;
		const client = new RagflowClient(config(), async (_url, init) => {
			body = JSON.parse(init.body as string) as unknown;
			return json({ code: 0, data: true });
		});
		await client.parseDocuments("ds-1", ["doc-1", "doc-2"]);
		expect(body).toEqual({ document_ids: ["doc-1", "doc-2"] });
	});

	test("listDocuments maps run state and meta_fields", async () => {
		const client = new RagflowClient(config(), async () =>
			json({ code: 0, data: { docs: [{ id: "doc-1", name: "a.md", run: "DONE", meta_fields: { path: "a.md" } }] } }),
		);
		const docs = await client.listDocuments("ds-1");
		expect(docs).toEqual([
			{
				id: "doc-1",
				name: "a.md",
				run: "DONE",
				metaFields: { path: "a.md" },
				raw: { id: "doc-1", name: "a.md", run: "DONE", meta_fields: { path: "a.md" } },
			},
		]);
	});

	test("updateDocument puts meta_fields; deleteDocuments deletes ids", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const client = new RagflowClient(config(), async (url, init) => {
			calls.push({ url, init });
			return json({ code: 0, data: true });
		});
		await client.updateDocument("ds-1", "doc-1", { metaFields: { path: "a.md" } });
		await client.deleteDocuments("ds-1", ["doc-9"]);
		expect(calls[0]?.init.method).toBe("PUT");
		expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ meta_fields: { path: "a.md" } });
		expect(calls[1]?.init.method).toBe("DELETE");
		expect(JSON.parse(calls[1]?.init.body as string)).toEqual({ ids: ["doc-9"] });
	});

	test("ensureDataset returns the existing id without creating", async () => {
		const methods: string[] = [];
		const client = new RagflowClient(config(), async (_url, init) => {
			methods.push(init.method ?? "GET");
			return json({ code: 0, data: [{ id: "ds-1", name: "agent-substrate" }] });
		});
		expect(await client.ensureDataset("agent-substrate")).toBe("ds-1");
		expect(methods).toEqual(["GET"]);
	});

	test("ensureDataset creates with the embedding model, retrying minimal", async () => {
		const calls: Array<{ method: string; body: unknown }> = [];
		let created = false;
		const client = new RagflowClient(config(), async (_url, init) => {
			const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
			calls.push({ method: init.method ?? "GET", body });
			if (init.method === "GET") return json({ code: 0, data: [] });
			if (init.method === "POST" && !created) {
				created = true;
				return json({ code: 102, message: "bad parser_config" });
			}
			if (init.method === "POST") return json({ code: 0, data: { id: "ds-9" } });
			return json({ code: 0, data: true });
		});
		const id = await client.ensureDataset("kanbanos", { description: "docs", embeddingModel: "bge-small" });
		expect(id).toBe("ds-9");
		const posts = calls.filter((call) => call.method === "POST");
		expect(posts.length).toBe(2);
		expect((posts[0]?.body as Record<string, unknown>).parser_config).toBeDefined();
		expect((posts[1]?.body as Record<string, unknown>).parser_config).toBeUndefined();
		const puts = calls.filter((call) => call.method === "PUT");
		expect(puts.length).toBe(1);
		expect(puts[0]?.body).toEqual({ embedding_model: "bge-small" });
	});
});
