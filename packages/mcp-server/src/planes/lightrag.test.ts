/**
 * The LightRAG HTTP adapter against recorded-shape fixtures. Every fake is
 * an injected `fetchImpl` (the same seam `ragflow.test.ts` uses); no network.
 * Each route is answered from a per-test queue keyed by `METHOD /path`, and
 * every request is recorded so the wire contract (method, path, headers,
 * body, multipart fields) is asserted, not just the parsed outcome.
 */
import { describe, expect, test } from "bun:test";
import type { LightragConfig } from "../config.ts";
import {
	deleteDocuments,
	documentName,
	lightragOp,
	parseDocuments,
	pollParseStatus,
	queryWithGraph,
	retrieveChunks,
	scanDocuments,
	storePlanningPage,
	uploadDocument,
	type FetchLike,
	type LightragUploadRequest,
} from "./lightrag.ts";

const PLAIN: LightragConfig = { url: "http://lightrag.test" };
const KEYED: LightragConfig = { url: "http://lightrag.test", apiKey: "lr-test-key" };

interface Call {
	url: string;
	path: string;
	method: string;
	headers: Headers;
	body: unknown;
}

type Reply = Response | ((call: Call) => Response);

/**
 * A recording fake. `replies` maps `METHOD /path` to a FIFO of responses;
 * an unscripted request throws, which the adapter reports as an
 * "unreachable" reason and fails the assertion that expected otherwise.
 */
function fakeLightrag(replies: Record<string, Reply[]>) {
	const calls: Call[] = [];
	const fetchImpl: FetchLike = async (input, init) => {
		const url = String(input);
		const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
		const method = init?.method ?? "GET";
		const body = init?.body;
		const call: Call = {
			url,
			path,
			method,
			headers: new Headers(init?.headers),
			body: typeof body === "string" ? JSON.parse(body) : body,
		};
		calls.push(call);
		const next = replies[`${method} ${path}`]?.shift();
		if (next === undefined) throw new Error(`unscripted request: ${method} ${path}`);
		return typeof next === "function" ? next(call) : next;
	};
	return { fetch: fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function formOf(call: Call | undefined): FormData {
	const body = call?.body;
	if (!(body instanceof FormData)) throw new Error("expected a multipart body");
	return body;
}

const UPLOAD_META = {
	source_url: "file:///repo/docs/a/README.md",
	commit: "abc1234",
	heading_path: "Setup > Install",
};

const UPLOAD_REQUEST: LightragUploadRequest = {
	name: "docs__a__README.md",
	content: "# Setup\nInstall it.",
	metadata: UPLOAD_META,
};

describe("lightragOp", () => {
	test("labels each route from a fixed table, never the path", () => {
		expect(lightragOp("POST", "http://l/query")).toBe("query");
		expect(lightragOp("POST", "http://l/documents/upload")).toBe("upload");
		expect(lightragOp("POST", "http://l/documents/text")).toBe("upload");
		expect(lightragOp("POST", "http://l/documents/scan")).toBe("scan");
		expect(lightragOp("GET", "http://l/documents/pipeline_status")).toBe("pipeline-status");
		expect(lightragOp("DELETE", "http://l/documents")).toBe("document-delete");
		expect(lightragOp("DELETE", "http://l/documents/track-42")).toBe("document-delete");
		expect(lightragOp("GET", "http://l/anything-else")).toBe("other");
	});
});

describe("retrieval (POST /query)", () => {
	test("sends query, default hybrid mode, clamped top_k and only_need_context", async () => {
		const fake = fakeLightrag({ "POST /query": [json({ data: { chunks: [{ content: "x" }] } })] });
		await retrieveChunks(PLAIN, { question: "what reads Hindsight?", topK: 25 }, fake.fetch);
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]?.method).toBe("POST");
		expect(fake.calls[0]?.path).toBe("/query");
		expect(fake.calls[0]?.headers.get("content-type")).toBe("application/json");
		expect(fake.calls[0]?.body).toEqual({
			query: "what reads Hindsight?",
			mode: "hybrid",
			top_k: 10,
			only_need_context: true,
		});
	});

	test("a leading /mix prefix selects mix and is stripped from the query", async () => {
		const fake = fakeLightrag({ "POST /query": [json({ data: { chunks: [{ content: "x" }] } })] });
		await retrieveChunks(PLAIN, { question: "/mix how do the planes relate?", topK: 3 }, fake.fetch);
		expect(fake.calls[0]?.body).toEqual({
			query: "how do the planes relate?",
			mode: "mix",
			top_k: 3,
			only_need_context: true,
		});
	});

	test("parses the { data: { chunks } } envelope into the RAGFlow chunk shape", async () => {
		const fake = fakeLightrag({
			"POST /query": [
				json({
					status: "success",
					data: {
						chunks: [
							{
								content: "Hindsight is the fallback memory.",
								document_id: "doc-7",
								chunk_id: "chunk-7",
								heading_path: "Memory > Fallback",
								source_url: "https://example.com/memory",
								score: 0.91,
							},
						],
					},
				}),
			],
		});
		const outcome = await retrieveChunks(KEYED, { question: "memory?" }, fake.fetch);
		expect(outcome).toEqual({
			ok: true,
			detail: { mode: "hybrid", counts: { entities: 0, relations: 0 }, provenance: { entities: [], relations: 0 } },
			chunks: [
				{
					content: "Hindsight is the fallback memory.",
					document_name: "doc",
					document_id: "doc-7",
					chunk_id: "chunk-7",
					heading_path: "Memory > Fallback",
					source_url: "https://example.com/memory",
					score: 0.91,
				},
			],
		});
	});

	test("parses a bare array and maps title/url/text/similarity onto the chunk fields", async () => {
		const fake = fakeLightrag({
			"POST /query": [
				json([{ text: "Plane contract.", title: "README.md", url: "https://example.com/readme", score: 0.8, document_id: "d9" }]),
			],
		});
		const outcome = await retrieveChunks(PLAIN, { question: "plane?" }, fake.fetch);
		expect(outcome).toEqual({
			ok: true,
			detail: { mode: "hybrid", counts: { entities: 0, relations: 0 }, provenance: { entities: [], relations: 0 } },
			chunks: [
				{
					content: "Plane contract.",
					document_name: "README.md",
					document_id: "d9",
					source_url: "https://example.com/readme",
					score: 0.8,
				},
			],
		});
	});

	test("parses the { response: string } form as one chunk of that text", async () => {
		const fake = fakeLightrag({ "POST /query": [json({ response: "The answer is 42." })] });
		const outcome = await retrieveChunks(PLAIN, { question: "answer?" }, fake.fetch);
		expect(outcome).toEqual({ ok: true, chunks: [{ content: "The answer is 42.", document_name: "doc" }], detail: { mode: "hybrid", counts: { entities: 0, relations: 0 }, provenance: { entities: [], relations: 0 } } });
	});

	test("parses the { response: [...] } form as a list of context entries", async () => {
		const fake = fakeLightrag({
			"POST /query": [json({ response: [{ snippet: "first", file_path: "a.md" }, { content: "second" }] })],
		});
		const outcome = await retrieveChunks(PLAIN, { question: "list?" }, fake.fetch);
		expect(outcome).toEqual({
			ok: true,
			detail: { mode: "hybrid", counts: { entities: 0, relations: 0 }, provenance: { entities: [], relations: 0 } },
			chunks: [
				{ content: "first", document_name: "a.md", source_url: "a.md" },
				{ content: "second", document_name: "doc" },
			],
		});
	});

	test("keeps graph detail on queryWithGraph: entities, relations and counts from the envelope", async () => {
		const fake = fakeLightrag({
			"POST /query": [
				json({
					status: "success",
					data: {
						chunks: [{ content: "graph-backed chunk", document_id: "d1", chunk_id: "c1" }],
						entities: [{ name: "Hindsight" }, "RAGFlow"],
						relations: [{ source: "Hindsight", target: "RAGFlow", kind: "fallback" }],
					},
				}),
			],
		});
		const outcome = await queryWithGraph(KEYED, "/mix Hindsight and RAGFlow?", fake.fetch);
		if (!outcome.ok) throw new Error(`expected chunks: ${outcome.reason}`);
		expect(outcome.chunks).toEqual([
			{ content: "graph-backed chunk", document_name: "doc", document_id: "d1", chunk_id: "c1" },
		]);
		expect(outcome.detail).toEqual({
			mode: "mix",
			counts: { entities: 2, relations: 1 },
			provenance: { entities: ["Hindsight", "RAGFlow"], relations: 1 },
		});
	});

	test("reads graph detail nested under data.graph as well", async () => {
		const fake = fakeLightrag({
			"POST /query": [
				json({
					data: {
						chunks: [{ content: "c" }],
						graph: { entities: ["Only"], relationships: [] },
					},
				}),
			],
		});
		const outcome = await queryWithGraph(PLAIN, "q", fake.fetch);
		if (!outcome.ok) throw new Error(`expected chunks: ${outcome.reason}`);
		expect(outcome.detail).toEqual({
			mode: "hybrid",
			counts: { entities: 1, relations: 0 },
			provenance: { entities: ["Only"], relations: 0 },
		});
	});

	test("an envelope with no usable entries is a shape failure, not an empty answer", async () => {
		const fake = fakeLightrag({ "POST /query": [json({ data: { chunks: [] } })] });
		const outcome = await retrieveChunks(PLAIN, { question: "q" }, fake.fetch);
		expect(outcome).toEqual({ ok: false, reason: "lightrag: unexpected response shape" });
	});

	test("an empty or whitespace question is a reason and makes no request", async () => {
		const fake = fakeLightrag({});
		expect(await retrieveChunks(PLAIN, { question: "   " }, fake.fetch)).toEqual({
			ok: false,
			reason: "lightrag: empty query",
		});
		expect(await retrieveChunks(PLAIN, { question: "/mix   " }, fake.fetch)).toEqual({
			ok: false,
			reason: "lightrag: empty query",
		});
		expect(fake.calls).toHaveLength(0);
	});

	test("a 401 or 403 is named by status, never by the key", async () => {
		const denied = fakeLightrag({ "POST /query": [json({ detail: "bad key lr-test-key" }, 401)] });
		const outcome = await retrieveChunks(KEYED, { question: "q" }, denied.fetch);
		expect(outcome).toEqual({ ok: false, reason: "lightrag 401" });
		expect(JSON.stringify(outcome)).not.toContain("lr-test-key");

		const forbidden = fakeLightrag({ "POST /query": [json({}, 403)] });
		expect(await retrieveChunks(KEYED, { question: "q" }, forbidden.fetch)).toEqual({
			ok: false,
			reason: "lightrag 403",
		});
	});

	test("a transport failure is an unreachable reason, never a throw", async () => {
		const down = await retrieveChunks(PLAIN, { question: "q" }, async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:9621");
		});
		if (down.ok) throw new Error("expected a reason");
		expect(down.reason).toStartWith("lightrag unreachable: connect ECONNREFUSED");
	});

	test("a 200 carrying a failing business status is a failure whatever the HTTP status", async () => {
		const fake = fakeLightrag({ "POST /query": [json({ status: "error", message: "index missing" })] });
		expect(await retrieveChunks(PLAIN, { question: "q" }, fake.fetch)).toEqual({
			ok: false,
			reason: "lightrag error: index missing",
		});
	});
});

describe("upload (POST /documents/upload, text fallback)", () => {
	test("multipart upload carries file, file_source, source_url, commit and heading_path", async () => {
		const fake = fakeLightrag({
			"POST /documents/upload": [json({ status: "success", data: { track_id: "trk-1" } })],
		});
		const outcome = await uploadDocument(KEYED, UPLOAD_REQUEST, fake.fetch);
		expect(outcome).toEqual({ ok: true, document_id: "trk-1" });

		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]?.method).toBe("POST");
		expect(fake.calls[0]?.path).toBe("/documents/upload");
		// A multipart body sets its own boundary; the adapter must not
		// force a JSON content type onto it.
		expect(fake.calls[0]?.headers.get("content-type")).toBeNull();

		const form = formOf(fake.calls[0]);
		const file = form.get("file");
		if (!(file instanceof File)) throw new Error("file part missing");
		expect(file.name).toBe("docs__a__README.md");
		expect(file.type).toBe("text/markdown");
		expect(await file.text()).toBe("# Setup\nInstall it.");
		expect(form.get("file_source")).toBe("docs__a__README.md");
		expect(form.get("source_url")).toBe("file:///repo/docs/a/README.md");
		expect(form.get("commit")).toBe("abc1234");
		expect(form.get("heading_path")).toBe("Setup > Install");
		expect(form.get("graph_entities")).toBeNull();
	});

	test("multipart upload sends graph_entities as a JSON list, dropping empty names", async () => {
		const fake = fakeLightrag({
			"POST /documents/upload": [json({ status: "success", data: { track_id: "trk-2" } })],
		});
		await uploadDocument(
			KEYED,
			{ ...UPLOAD_REQUEST, metadata: { ...UPLOAD_META, graph_entities: ["Hindsight", "", "RAGFlow"] } },
			fake.fetch,
		);
		const form = formOf(fake.calls[0]);
		expect(form.get("graph_entities")).toBe(JSON.stringify(["Hindsight", "RAGFlow"]));
	});

	test("on a 404 from the multipart route, falls back to POST /documents/text with the same metadata", async () => {
		const fake = fakeLightrag({
			"POST /documents/upload": [json({ detail: "Not Found" }, 404)],
			"POST /documents/text": [json({ status: "success", data: { track_id: "trk-3" } })],
		});
		const outcome = await uploadDocument(
			KEYED,
			{ ...UPLOAD_REQUEST, metadata: { ...UPLOAD_META, graph_entities: ["Hindsight"] } },
			fake.fetch,
		);
		expect(outcome).toEqual({ ok: true, document_id: "trk-3" });
		expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			"POST /documents/upload",
			"POST /documents/text",
		]);
		expect(fake.calls[1]?.headers.get("content-type")).toBe("application/json");
		expect(fake.calls[1]?.body).toEqual({
			text: "# Setup\nInstall it.",
			file_source: "docs__a__README.md",
			source_url: "file:///repo/docs/a/README.md",
			commit: "abc1234",
			heading_path: "Setup > Install",
			graph_entities: ["Hindsight"],
		});
	});

	test("the text fallback omits graph_entities when there are none", async () => {
		const fake = fakeLightrag({
			"POST /documents/upload": [json({}, 404)],
			"POST /documents/text": [json({ data: { document_id: "doc-plain" } })],
		});
		expect(await uploadDocument(KEYED, UPLOAD_REQUEST, fake.fetch)).toEqual({ ok: true, document_id: "doc-plain" });
		expect(fake.calls[1]?.body).not.toHaveProperty("graph_entities");
	});

	test("a non-404 upload failure is reported and does not fall back to the text route", async () => {
		const fake = fakeLightrag({ "POST /documents/upload": [json({ detail: "boom" }, 500)] });
		expect(await uploadDocument(PLAIN, UPLOAD_REQUEST, fake.fetch)).toEqual({ ok: false, reason: "lightrag 500" });
		expect(fake.calls).toHaveLength(1);
	});

	test("a success body without a document id is a shape failure", async () => {
		const fake = fakeLightrag({ "POST /documents/upload": [json({ status: "success", data: {} })] });
		expect(await uploadDocument(PLAIN, UPLOAD_REQUEST, fake.fetch)).toEqual({
			ok: false,
			reason: "lightrag: unexpected upload shape",
		});
	});

	test("storePlanningPage flattens the path, defaults commit to unpinned and heading_path to empty", async () => {
		const fake = fakeLightrag({
			"POST /documents/upload": [json({ data: { track_id: "trk-p" } })],
		});
		const outcome = await storePlanningPage(
			PLAIN,
			{ path: ".planning/phases/03-x/PLAN.md", sourceUrl: "file:///repo/.planning/phases/03-x/PLAN.md", body: "plan" },
			fake.fetch,
		);
		expect(outcome).toEqual({ ok: true, document_id: "trk-p" });
		const form = formOf(fake.calls[0]);
		const file = form.get("file");
		if (!(file instanceof File)) throw new Error("file part missing");
		expect(file.name).toBe(".planning__phases__03-x__PLAN.md");
		expect(form.get("commit")).toBe("unpinned");
		expect(form.get("heading_path")).toBe("");
	});

	test("storePlanningPage sends its commit and heading on the text fallback too", async () => {
		const fake = fakeLightrag({
			"POST /documents/upload": [json({}, 404)],
			"POST /documents/text": [json({ data: { track_id: "trk-q" } })],
		});
		await storePlanningPage(
			PLAIN,
			{
				path: "docs/x.md",
				sourceUrl: "file:///repo/docs/x.md",
				body: "x",
				commit: "def5678",
				headingPath: "Intro",
			},
			fake.fetch,
		);
		expect(fake.calls[1]?.body).toMatchObject({ commit: "def5678", heading_path: "Intro", file_source: "docs__x.md" });
	});
});

describe("scan, parse and pipeline status", () => {
	test("scanDocuments POSTs an empty JSON body to /documents/scan", async () => {
		const fake = fakeLightrag({ "POST /documents/scan": [json({ status: "scanning_started" })] });
		expect(await scanDocuments(KEYED, fake.fetch)).toEqual({ ok: true });
		expect(fake.calls[0]?.method).toBe("POST");
		expect(fake.calls[0]?.path).toBe("/documents/scan");
		expect(fake.calls[0]?.body).toEqual({});
		expect(fake.calls[0]?.headers.get("content-type")).toBe("application/json");
	});

	test("parseDocuments is a scan: dataset and document ids are accepted and never sent", async () => {
		const fake = fakeLightrag({ "POST /documents/scan": [json({ status: "scanning_started" })] });
		expect(await parseDocuments(KEYED, "ds-berlin", ["trk-1", "trk-2"], fake.fetch)).toEqual({ ok: true });
		expect(fake.calls[0]?.path).toBe("/documents/scan");
		expect(fake.calls[0]?.body).toEqual({});
		expect(JSON.stringify(fake.calls[0]?.body)).not.toContain("ds-berlin");
	});

	test("a scan failure is a reason, not a throw", async () => {
		const fake = fakeLightrag({ "POST /documents/scan": [json({}, 503)] });
		expect(await scanDocuments(PLAIN, fake.fetch)).toEqual({ ok: false, reason: "lightrag 503" });
	});

	test("pollParseStatus polls pipeline_status until idle", async () => {
		const fake = fakeLightrag({
			"GET /documents/pipeline_status": [json({ status: "busy" }), json({ status: "idle" })],
		});
		const outcome = await pollParseStatus(KEYED, { dataset_id: "ds", document_id: "trk-1" }, fake.fetch, {
			maxPolls: 5,
			intervalMs: 0,
		});
		expect(outcome).toEqual({ ok: true });
		expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			"GET /documents/pipeline_status",
			"GET /documents/pipeline_status",
		]);
		expect(fake.calls[0]?.body).toBeUndefined();
	});

	test("a pipeline that never goes idle is parse-timeout after maxPolls", async () => {
		const fake = fakeLightrag({
			"GET /documents/pipeline_status": [json({ status: "busy" }), json({ status: "busy" }), json({ status: "busy" })],
		});
		const outcome = await pollParseStatus(PLAIN, { dataset_id: "ds", document_id: "trk-1" }, fake.fetch, {
			maxPolls: 3,
			intervalMs: 0,
		});
		expect(outcome).toEqual({ ok: false, reason: "parse-timeout" });
		expect(fake.calls).toHaveLength(3);
	});

	test("a failed pipeline stops polling and surfaces the failure, never a hang", async () => {
		const fake = fakeLightrag({
			"GET /documents/pipeline_status": [json({ status: "failed", message: "parser crashed on page 3" })],
		});
		const outcome = await pollParseStatus(PLAIN, { dataset_id: "ds", document_id: "trk-1" }, fake.fetch, {
			maxPolls: 5,
			intervalMs: 0,
		});
		if (outcome.ok) throw new Error("expected a failure reason");
		expect(outcome.reason).toStartWith("lightrag failed");
		expect(outcome.reason).toContain("parser crashed on page 3");
		expect(fake.calls).toHaveLength(1);
	});

	test("an unreachable pipeline_status is returned as the reason", async () => {
		const outcome = await pollParseStatus(PLAIN, { dataset_id: "ds", document_id: "trk-1" }, async () => {
			throw new Error("socket hang up");
		});
		if (outcome.ok) throw new Error("expected a reason");
		expect(outcome.reason).toStartWith("lightrag unreachable: socket hang up");
	});
});

describe("delete (DELETE /documents)", () => {
	test("sends doc_ids as a JSON body and never the dataset id", async () => {
		const fake = fakeLightrag({ "DELETE /documents": [json({ status: "deletion_started" })] });
		const outcome = await deleteDocuments(KEYED, "ds-berlin", ["trk-1", "trk-2"], fake.fetch);
		expect(outcome).toEqual({ ok: true });
		expect(fake.calls[0]?.method).toBe("DELETE");
		expect(fake.calls[0]?.path).toBe("/documents");
		expect(fake.calls[0]?.headers.get("content-type")).toBe("application/json");
		expect(fake.calls[0]?.body).toEqual({ doc_ids: ["trk-1", "trk-2"] });
		expect(JSON.stringify(fake.calls[0]?.body)).not.toContain("ds-berlin");
	});

	test("an empty id list makes no request", async () => {
		const fake = fakeLightrag({});
		expect(await deleteDocuments(PLAIN, "ds", [], fake.fetch)).toEqual({ ok: true });
		expect(fake.calls).toHaveLength(0);
	});

	test("a failed delete is reported as the status reason", async () => {
		const fake = fakeLightrag({ "DELETE /documents": [json({ detail: "locked" }, 500)] });
		expect(await deleteDocuments(PLAIN, "ds", ["trk-1"], fake.fetch)).toEqual({ ok: false, reason: "lightrag 500" });
	});
});

describe("request checks", () => {
	test("sends X-API-Key and Bearer on every route when a key is set", async () => {
		const fake = fakeLightrag({
			"POST /query": [json({ data: { chunks: [{ content: "c" }] } })],
			"POST /documents/scan": [json({})],
			"GET /documents/pipeline_status": [json({ status: "idle" })],
			"DELETE /documents": [json({})],
			"POST /documents/upload": [json({ data: { track_id: "t" } })],
		});
		await retrieveChunks(KEYED, { question: "q" }, fake.fetch);
		await scanDocuments(KEYED, fake.fetch);
		await pollParseStatus(KEYED, { dataset_id: "ds", document_id: "t" }, fake.fetch, { maxPolls: 1, intervalMs: 0 });
		await deleteDocuments(KEYED, "ds", ["t"], fake.fetch);
		await uploadDocument(KEYED, UPLOAD_REQUEST, fake.fetch);
		expect(fake.calls).toHaveLength(5);
		for (const call of fake.calls) {
			expect(call.headers.get("x-api-key")).toBe("lr-test-key");
			expect(call.headers.get("authorization")).toBe("Bearer lr-test-key");
		}
	});

	test("sends neither auth header when no key is set, never 'Bearer undefined'", async () => {
		const fake = fakeLightrag({
			"POST /query": [json({ data: { chunks: [{ content: "c" }] } })],
			"POST /documents/scan": [json({})],
		});
		await retrieveChunks(PLAIN, { question: "q" }, fake.fetch);
		await scanDocuments(PLAIN, fake.fetch);
		for (const call of fake.calls) {
			expect(call.headers.get("x-api-key")).toBeNull();
			expect(call.headers.get("authorization")).toBeNull();
		}
	});

	test("the key never appears in a transport reason", async () => {
		const outcome = await scanDocuments(KEYED, async () => {
			throw new Error("refused");
		});
		if (outcome.ok) throw new Error("expected a reason");
		expect(outcome.reason).not.toContain("lr-test-key");
	});

	test("the configured base url prefixes every route", async () => {
		const fake = fakeLightrag({ "POST /documents/scan": [json({})] });
		await scanDocuments({ url: "http://lightrag.internal:9621" }, fake.fetch);
		expect(fake.calls[0]?.url).toBe("http://lightrag.internal:9621/documents/scan");
	});

	test("documentName flattens repo paths and keeps the suffix", () => {
		expect(documentName("docs/a/README.md")).toBe("docs__a__README.md");
		expect(documentName("/README.md")).toBe("README.md");
	});
});
