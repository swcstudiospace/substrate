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
	isClearAllRequest,
	isLightragQueryMode,
	lightragCall,
	lightragOp,
	parseDocuments,
	pollParseStatus,
	probeLightrag,
	queryForTool,
	queryWithGraph,
	resolveDocumentIds,
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
		expect(lightragOp("DELETE", "http://l/documents/delete_document")).toBe("document-delete");
		expect(lightragOp("GET", "http://l/documents/track_status/upload_1")).toBe("track-status");
		expect(lightragOp("GET", "http://l/health")).toBe("health");
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
		expect(outcome).toEqual({ ok: true, track_id: "trk-1" });

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
		expect(outcome).toEqual({ ok: true, track_id: "trk-3" });
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
			"POST /documents/text": [json({ status: "success", message: "queued", track_id: "insert_plain" })],
		});
		expect(await uploadDocument(KEYED, UPLOAD_REQUEST, fake.fetch)).toEqual({ ok: true, track_id: "insert_plain" });
		expect(fake.calls[1]?.body).not.toHaveProperty("graph_entities");
	});

	test("a non-404 upload failure is reported and does not fall back to the text route", async () => {
		const fake = fakeLightrag({ "POST /documents/upload": [json({ detail: "boom" }, 500)] });
		expect(await uploadDocument(PLAIN, UPLOAD_REQUEST, fake.fetch)).toEqual({ ok: false, reason: "lightrag 500" });
		expect(fake.calls).toHaveLength(1);
	});

	test("a success body without a track id is a shape failure, and a document id alias is never taken for one", async () => {
		const fake = fakeLightrag({
			"POST /documents/upload": [json({ status: "success", data: {} }), json({ status: "success", document_id: "doc-1", id: "doc-1" })],
		});
		const shape = { ok: false, reason: "lightrag: unexpected upload shape" } as const;
		expect(await uploadDocument(PLAIN, UPLOAD_REQUEST, fake.fetch)).toEqual(shape);
		expect(await uploadDocument(PLAIN, UPLOAD_REQUEST, fake.fetch)).toEqual(shape);
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
		expect(outcome).toEqual({ ok: true, track_id: "trk-p" });
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

describe("delete (DELETE /documents/delete_document)", () => {
	test("sends doc_ids to the per-document route, never the clear-all one, and never the dataset id", async () => {
		const fake = fakeLightrag({
			"DELETE /documents/delete_document": [json({ status: "deletion_started", message: "started", doc_id: "doc-1, doc-2" })],
		});
		const outcome = await deleteDocuments(KEYED, "ds-berlin", ["doc-1", "doc-2"], fake.fetch);
		expect(outcome).toEqual({ ok: true });
		expect(fake.calls).toHaveLength(1);
		expect(fake.calls[0]?.method).toBe("DELETE");
		expect(fake.calls[0]?.path).toBe("/documents/delete_document");
		expect(fake.calls[0]?.headers.get("content-type")).toBe("application/json");
		expect(fake.calls[0]?.body).toEqual({ doc_ids: ["doc-1", "doc-2"], delete_file: false, delete_llm_cache: false });
		expect(JSON.stringify(fake.calls[0]?.body)).not.toContain("ds-berlin");
	});

	test("ids are stripped and de-duplicated, as upstream requires, before they go out", async () => {
		const fake = fakeLightrag({ "DELETE /documents/delete_document": [json({ status: "deletion_started", message: "m", doc_id: "d" })] });
		await deleteDocuments(PLAIN, "ds", [" doc-1 ", "doc-1", "doc-2"], fake.fetch);
		expect(fake.calls[0]?.body).toMatchObject({ doc_ids: ["doc-1", "doc-2"] });
	});

	test("an empty id list makes no request, and a blank id is refused before any request", async () => {
		const fake = fakeLightrag({});
		expect(await deleteDocuments(PLAIN, "ds", [], fake.fetch)).toEqual({ ok: true });
		expect(await deleteDocuments(PLAIN, "ds", ["doc-1", "  "], fake.fetch)).toEqual({ ok: false, reason: "lightrag: empty document id" });
		expect(fake.calls).toHaveLength(0);
	});

	test("busy is a retryable reason, not_allowed and unknown statuses name the status, a missing status is a shape failure", async () => {
		const fake = fakeLightrag({
			"DELETE /documents/delete_document": [
				json({ status: "busy", message: "pipeline busy", doc_id: "d" }),
				json({ status: "not_allowed", message: "no", doc_id: "d" }),
				json({ status: "weird", message: "?", doc_id: "d" }),
				json({ message: "no status" }),
			],
		});
		expect(await deleteDocuments(PLAIN, "ds", ["d"], fake.fetch)).toEqual({ ok: false, reason: "lightrag delete busy: pipeline busy", retryable: true });
		expect(await deleteDocuments(PLAIN, "ds", ["d"], fake.fetch)).toEqual({ ok: false, reason: "lightrag delete not_allowed: no" });
		expect(await deleteDocuments(PLAIN, "ds", ["d"], fake.fetch)).toEqual({ ok: false, reason: "lightrag delete: unexpected status weird" });
		expect(await deleteDocuments(PLAIN, "ds", ["d"], fake.fetch)).toEqual({ ok: false, reason: "lightrag: unexpected delete shape" });
	});

	test("a failed delete is reported as the status reason", async () => {
		const fake = fakeLightrag({ "DELETE /documents/delete_document": [json({ detail: "locked" }, 500)] });
		expect(await deleteDocuments(PLAIN, "ds", ["doc-1"], fake.fetch)).toEqual({ ok: false, reason: "lightrag 500" });
	});
});

describe("the clear-all denylist (DELETE /documents is never sent)", () => {
	test("every spelling of DELETE /documents is recognised, the per-document route is not", () => {
		for (const path of ["/documents", "/documents/", "/documents?force=1", "/documents/?force=1", "/documents#x", "/Documents", "//documents", "/documents/.", "/documents/x/..", "/%64ocuments", "http://l/documents", "\\documents"]) {
			expect(isClearAllRequest("DELETE", path)).toBe(true);
		}
		expect(isClearAllRequest("delete", "/documents")).toBe(true);
		expect(isClearAllRequest("DELETE", "/documents/delete_document")).toBe(false);
		expect(isClearAllRequest("DELETE", "/documents/delete_document?x=1")).toBe(false);
		expect(isClearAllRequest("GET", "/documents")).toBe(false);
		expect(isClearAllRequest("POST", "/documents/scan")).toBe(false);
	});

	test("the single choke point refuses with a fixed reason before any network I/O", async () => {
		let reached = 0;
		const fetchImpl: FetchLike = async () => {
			reached += 1;
			return json({});
		};
		for (const path of ["/documents", "/documents/", "/documents?force=1"]) {
			const outcome = await lightragCall(KEYED, fetchImpl, path, { method: "DELETE", json: true, body: JSON.stringify({ doc_ids: ["d"] }), timeoutMs: 100 });
			expect(outcome).toEqual({ ok: false, reason: "lightrag clear-all refused" });
		}
		expect(reached).toBe(0);
		// The same choke point still carries the per-document route.
		await lightragCall(KEYED, fetchImpl, "/documents/delete_document", { method: "DELETE", json: true, body: "{}", timeoutMs: 100 });
		expect(reached).toBe(1);
	});

	test("no client function, whatever its arguments, emits DELETE /documents", async () => {
		const seen: string[] = [];
		const fetchImpl: FetchLike = async (input, init) => {
			seen.push(`${init?.method ?? "GET"} ${String(input).replace(/^https?:\/\/[^/]+/, "")}`);
			return json({ status: "deletion_started", message: "m", doc_id: "d", busy: false, documents: [{ id: "d" }], track_id: "t" });
		};
		await deleteDocuments(KEYED, "ds", ["/", "documents", "doc-1"], fetchImpl);
		await deleteDocuments(KEYED, "", ["d"], fetchImpl);
		expect(seen.length).toBe(2);
		for (const line of seen) expect(line).toBe("DELETE /documents/delete_document");
	});
});

describe("pipeline status (GET /documents/pipeline_status, v1.5.7 shape)", () => {
	const doc = { dataset_id: "ds", document_id: "t" };
	const noWait = { maxPolls: 4, intervalMs: 50, sleep: async () => undefined };

	test("idle is busy === false, with the full upstream body", async () => {
		const fake = fakeLightrag({
			"GET /documents/pipeline_status": [
				json({ busy: false, job_name: "Default Job", job_start: null, docs: 0, batchs: 0, cur_batch: 0, latest_message: "", history_messages: [], update_status: {}, recovery_required: false, recovery_kind: null, recovery_message: null }),
			],
		});
		expect(await pollParseStatus(KEYED, doc, fake.fetch, noWait)).toEqual({ ok: true });
		expect(fake.calls).toHaveLength(1);
	});

	test("busy: true polls again, waiting through the injected sleep, until busy is false", async () => {
		const waits: number[] = [];
		const fake = fakeLightrag({
			"GET /documents/pipeline_status": [json({ busy: true, job_name: "indexing files" }), json({ busy: true }), json({ busy: false })],
		});
		const outcome = await pollParseStatus(KEYED, doc, fake.fetch, { maxPolls: 5, intervalMs: 50, sleep: async (ms) => void waits.push(ms) });
		expect(outcome).toEqual({ ok: true });
		expect(fake.calls).toHaveLength(3);
		expect(waits).toEqual([50, 50]);
	});

	test("a pipeline that stays busy is parse-timeout, never a silent loop", async () => {
		const fake = fakeLightrag({ "GET /documents/pipeline_status": [json({ busy: true }), json({ busy: true }), json({ busy: true })] });
		expect(await pollParseStatus(PLAIN, doc, fake.fetch, { maxPolls: 3, intervalMs: 0 })).toEqual({ ok: false, reason: "parse-timeout" });
	});

	test("a scan, a destructive job or a pending enqueue keeps an otherwise not-busy pipeline busy", async () => {
		for (const extra of [{ scanning: true }, { destructive_busy: true }, { pending_enqueues: 2 }]) {
			const fake = fakeLightrag({ "GET /documents/pipeline_status": [json({ busy: false, ...extra }), json({ busy: false })] });
			expect(await pollParseStatus(PLAIN, doc, fake.fetch, { maxPolls: 1, intervalMs: 0 })).toEqual({ ok: false, reason: "parse-timeout" });
		}
	});

	test("recovery_required stops at once with the redacted, capped recovery message", async () => {
		const fake = fakeLightrag({
			"GET /documents/pipeline_status": [
				json({ busy: false, recovery_required: true, recovery_kind: "dead_owner", recovery_message: `workspace fenced ${"blocker ".repeat(80)}` }),
			],
		});
		const outcome = await pollParseStatus(KEYED, doc, fake.fetch, noWait);
		if (outcome.ok) throw new Error("expected a failure");
		expect(outcome.reason).toStartWith("lightrag recovery required: workspace fenced ");
		expect(outcome.reason.length).toBe("lightrag recovery required: ".length + 200);
		expect(fake.calls).toHaveLength(1);
	});

	test("recovery_required without a message names its kind, and wins over busy", async () => {
		const fake = fakeLightrag({ "GET /documents/pipeline_status": [json({ busy: true, recovery_required: true, recovery_kind: "dead_owner" })] });
		expect(await pollParseStatus(PLAIN, doc, fake.fetch, noWait)).toEqual({ ok: false, reason: "lightrag recovery required: dead_owner" });
	});

	test("a body with neither shape is an explicit unexpected-shape reason after one poll", async () => {
		const fake = fakeLightrag({ "GET /documents/pipeline_status": [json({ something: "else" })] });
		expect(await pollParseStatus(PLAIN, doc, fake.fetch, noWait)).toEqual({ ok: false, reason: "lightrag: unexpected pipeline shape" });
		expect(fake.calls).toHaveLength(1);
		const list = fakeLightrag({ "GET /documents/pipeline_status": [json([1, 2])] });
		expect(await pollParseStatus(PLAIN, doc, list.fetch, noWait)).toEqual({ ok: false, reason: "lightrag: unexpected pipeline shape" });
	});

	test("the legacy status string is only a fallback when busy is absent", async () => {
		const legacy = fakeLightrag({ "GET /documents/pipeline_status": [json({ status: "busy" }), json({ status: "idle" })] });
		expect(await pollParseStatus(PLAIN, doc, legacy.fetch, noWait)).toEqual({ ok: true });
		const both = fakeLightrag({ "GET /documents/pipeline_status": [json({ busy: true, status: "idle" }), json({ busy: false, status: "busy" })] });
		expect(await pollParseStatus(PLAIN, doc, both.fetch, noWait)).toEqual({ ok: true });
		expect(both.calls).toHaveLength(2);
	});
});

describe("document ids (GET /documents/track_status/{track_id})", () => {
	const TRACKED = { track_id: "upload_1", documents: [{ id: "doc-abc", status: "processed", file_path: "a.md", content_summary: "s", content_length: 3 }], total_count: 1, status_summary: { processed: 1 } };

	test("returns the real document ids, from the url-encoded track id route", async () => {
		const fake = fakeLightrag({ "GET /documents/track_status/upload_1": [json(TRACKED)] });
		const outcome = await resolveDocumentIds(KEYED, "upload_1", fake.fetch);
		expect(outcome).toEqual({ ok: true, ids: ["doc-abc"], documents: [{ id: "doc-abc", status: "processed", file_path: "a.md" }] });
		expect(fake.calls[0]?.method).toBe("GET");
		expect(fake.calls[0]?.path).toBe("/documents/track_status/upload_1");
		const odd = fakeLightrag({ "GET /documents/track_status/a%2Fb%20c": [json({ ...TRACKED, track_id: "a/b c" })] });
		expect((await resolveDocumentIds(KEYED, "a/b c", odd.fetch)).ok).toBe(true);
	});

	test("an empty list is read again after the injected wait until the enqueue lands", async () => {
		const waits: number[] = [];
		const empty = { track_id: "upload_1", documents: [], total_count: 0, status_summary: {} };
		const fake = fakeLightrag({ "GET /documents/track_status/upload_1": [json(empty), json(empty), json(TRACKED)] });
		const outcome = await resolveDocumentIds(KEYED, "upload_1", fake.fetch, { intervalMs: 250, sleep: async (ms) => void waits.push(ms) });
		expect(outcome).toMatchObject({ ok: true, ids: ["doc-abc"] });
		expect(fake.calls).toHaveLength(3);
		expect(waits).toEqual([250, 250]);
	});

	test("it never hangs: maxPolls ends the reads, and the injected clock ends them at the deadline", async () => {
		const empty = { track_id: "t", documents: [], total_count: 0, status_summary: {} };
		const sleep = async () => undefined;
		const capped = fakeLightrag({ "GET /documents/track_status/t": [json(empty), json(empty)] });
		expect(await resolveDocumentIds(KEYED, "t", capped.fetch, { maxPolls: 2, sleep })).toEqual({ ok: false, reason: "lightrag: track_status listed no documents" });
		expect(capped.calls).toHaveLength(2);

		let clock = 0;
		const slow = fakeLightrag({ "GET /documents/track_status/t": [json(empty), json(empty), json(empty)] });
		const outcome = await resolveDocumentIds(KEYED, "t", slow.fetch, { maxPolls: 10, deadlineMs: 1000, sleep, now: () => (clock += 600) });
		expect(outcome).toEqual({ ok: false, reason: "lightrag: track_status deadline exceeded with no documents" });
		expect(slow.calls.length).toBeLessThan(10);
	});

	test("a failed read, a wrong shape and a blank track id are reasons", async () => {
		const down = fakeLightrag({ "GET /documents/track_status/t": [json({ detail: "x" }, 503)] });
		expect(await resolveDocumentIds(KEYED, "t", down.fetch)).toEqual({ ok: false, reason: "lightrag 503" });
		const shape = fakeLightrag({ "GET /documents/track_status/t": [json({ documents: "nope" })] });
		expect(await resolveDocumentIds(KEYED, "t", shape.fetch)).toEqual({ ok: false, reason: "lightrag: unexpected track_status shape" });
		const none = fakeLightrag({});
		expect(await resolveDocumentIds(KEYED, "  ", none.fetch)).toEqual({ ok: false, reason: "lightrag: empty track id" });
		expect(none.calls).toHaveLength(0);
	});

	test("a failed document keeps its (capped) error message, and entries without an id are skipped", async () => {
		const body = { track_id: "t", documents: [{ status: "failed" }, { id: "doc-f", status: "failed", error_msg: "parse failed ".repeat(40) }], total_count: 2, status_summary: {} };
		const fake = fakeLightrag({ "GET /documents/track_status/t": [json(body)] });
		const outcome = await resolveDocumentIds(KEYED, "t", fake.fetch);
		if (!outcome.ok) throw new Error("expected ids");
		expect(outcome.ids).toEqual(["doc-f"]);
		expect(outcome.documents[0]?.status).toBe("failed");
		expect(outcome.documents[0]?.error_msg?.length).toBe(200);
	});

	test("the upload keeps the track id explicit: it is not a document id, and a 409 is a typed conflict", async () => {
		const fake = fakeLightrag({
			"POST /documents/upload": [
				json({ status: "success", message: "queued", track_id: "upload_20260902_abc" }),
				json({ detail: "Document storage already contains the file" }, 409),
				json({ detail: "Not Found" }, 404),
			],
			"POST /documents/text": [json({ detail: "Document storage already contains the file" }, 409)],
		});
		expect(await uploadDocument(KEYED, UPLOAD_REQUEST, fake.fetch)).toEqual({ ok: true, track_id: "upload_20260902_abc" });
		expect(await uploadDocument(KEYED, UPLOAD_REQUEST, fake.fetch)).toEqual({ ok: false, reason: "lightrag 409 same-name conflict", conflict: true });
		// The text fallback's 409 is the same conflict.
		expect(await uploadDocument(KEYED, UPLOAD_REQUEST, fake.fetch)).toEqual({ ok: false, reason: "lightrag 409 same-name conflict", conflict: true });
	});

	test("InsertResponse status failure is a failure, partial_success still carries its track id", async () => {
		const fake = fakeLightrag({
			"POST /documents/upload": [
				json({ status: "failure", message: "could not enqueue", track_id: "upload_x" }),
				json({ status: "partial_success", message: "one skipped", track_id: "upload_y" }),
			],
		});
		expect(await uploadDocument(KEYED, UPLOAD_REQUEST, fake.fetch)).toEqual({ ok: false, reason: "lightrag failure: could not enqueue" });
		expect(await uploadDocument(KEYED, UPLOAD_REQUEST, fake.fetch)).toEqual({ ok: true, track_id: "upload_y" });
	});
});

describe("health probe (GET /health)", () => {
	const HEALTHY = { status: "healthy", auth_mode: "enabled", core_version: "1.5.7", api_version: "0273", pipeline_busy: false, pipeline_active: false, webui_available: true };

	test("an authenticated healthy answer is ok with busy and version", async () => {
		const fake = fakeLightrag({ "GET /health": [json({ ...HEALTHY, pipeline_busy: true })] });
		expect(await probeLightrag(KEYED, fake.fetch)).toEqual({ ok: true, busy: true, version: "1.5.7" });
		expect(fake.calls[0]?.method).toBe("GET");
		expect(fake.calls[0]?.path).toBe("/health");
		expect(fake.calls[0]?.headers.get("x-api-key")).toBe("lr-test-key");
	});

	test("a refused key is ok:false with the status reason, and the key is not in it", async () => {
		const fake = fakeLightrag({ "GET /health": [json({ detail: "Invalid API Key" }, 403), json({ detail: "Invalid token. Please login again." }, 401)] });
		const forbidden = await probeLightrag(KEYED, fake.fetch);
		expect(forbidden).toEqual({ ok: false, reason: "lightrag 403" });
		expect(await probeLightrag(KEYED, fake.fetch)).toEqual({ ok: false, reason: "lightrag 401" });
		expect(JSON.stringify(forbidden)).not.toContain("lr-test-key");
	});

	test("an unhealthy status, a wrong shape, a non-JSON body and a transport failure are reasons, never a throw", async () => {
		const fake = fakeLightrag({
			"GET /health": [json({ status: "degraded" }), json({ nothing: true }), json([1]), new Response("<html>", { status: 200 })],
		});
		expect(await probeLightrag(PLAIN, fake.fetch)).toEqual({ ok: false, reason: "lightrag health: degraded" });
		expect(await probeLightrag(PLAIN, fake.fetch)).toEqual({ ok: false, reason: "lightrag: unexpected health shape" });
		expect(await probeLightrag(PLAIN, fake.fetch)).toEqual({ ok: false, reason: "lightrag: unexpected health shape" });
		expect(await probeLightrag(PLAIN, fake.fetch)).toEqual({ ok: false, reason: "lightrag: response was not JSON" });
		const down = await probeLightrag(KEYED, async () => {
			throw new Error("connect ECONNREFUSED");
		});
		expect(down).toEqual({ ok: false, reason: "lightrag unreachable: connect ECONNREFUSED" });
		const odd = await probeLightrag(KEYED, (async () => 42) as unknown as FetchLike);
		expect(odd.ok).toBe(false);
	});

	test("a liveness-only answer (unauthenticated tier) is still healthy", async () => {
		const fake = fakeLightrag({ "GET /health": [json({ status: "healthy", core_version: "1.5.7", pipeline_busy: false })] });
		expect(await probeLightrag(PLAIN, fake.fetch)).toEqual({ ok: true, busy: false, version: "1.5.7" });
	});
});

describe("queryForTool (the docs_lightrag_query door)", () => {
	test("serves RagLightragChunk hits through this client: hybrid default, /mix prefix, clamp, redaction and cap", async () => {
		const fake = fakeLightrag({
			"POST /query": [
				json({ response: "context ".repeat(300), llm_generated: false }),
				json({ data: { chunks: [{ content: "kept", file_path: "docs__a.md", score: 0.5 }, { content: "" }] } }),
			],
		});
		const first = await queryForTool(KEYED, { question: "/mix how do planes relate?", topK: 99 }, fake.fetch);
		if (!first.ok) throw new Error(first.reason);
		expect(first.mode).toBe("mix");
		expect(first.chunks).toHaveLength(1);
		expect(first.chunks[0]).toEqual({ content: ("context ".repeat(300)).slice(0, 1200), title: "doc", sourceUrl: "lightrag:unrecorded", score: 0 });
		expect(fake.calls[0]?.body).toEqual({ query: "how do planes relate?", mode: "mix", top_k: 10, only_need_context: true });
		const second = await queryForTool(KEYED, { question: "where is it?" }, fake.fetch);
		if (!second.ok) throw new Error(second.reason);
		expect(second.mode).toBe("hybrid");
		expect(second.chunks).toEqual([{ content: "kept", title: "docs__a.md", sourceUrl: "docs__a.md", score: 0.5 }]);
	});

	test("a failure, an empty question and an answer with no usable text are reasons", async () => {
		const fake = fakeLightrag({ "POST /query": [json({ detail: "x" }, 500), json({ data: { chunks: [{ content: "" }] } })] });
		expect(await queryForTool(PLAIN, { question: "q" }, fake.fetch)).toEqual({ ok: false, reason: "lightrag 500" });
		expect(await queryForTool(PLAIN, { question: "q" }, fake.fetch)).toEqual({ ok: false, reason: "lightrag: unexpected response shape" });
		expect(await queryForTool(PLAIN, { question: "  " }, fake.fetch)).toEqual({ ok: false, reason: "lightrag: empty query" });
	});

	test("isLightragQueryMode accepts exactly the five modes the client sends", () => {
		for (const mode of ["naive", "local", "global", "hybrid", "mix"]) expect(isLightragQueryMode(mode)).toBe(true);
		for (const mode of ["bypass", "", 3, null, undefined]) expect(isLightragQueryMode(mode)).toBe(false);
	});
});

describe("request checks", () => {
	test("sends only X-API-Key (never an Authorization bearer) on every route when a key is set", async () => {
		const fake = fakeLightrag({
			"POST /query": [json({ data: { chunks: [{ content: "c" }] } })],
			"POST /documents/scan": [json({})],
			"GET /documents/pipeline_status": [json({ busy: false })],
			"DELETE /documents/delete_document": [json({ status: "deletion_started", message: "m", doc_id: "t" })],
			"POST /documents/upload": [json({ status: "success", message: "m", track_id: "t" })],
			"GET /documents/track_status/t": [json({ track_id: "t", documents: [{ id: "d" }], total_count: 1, status_summary: {} })],
			"GET /health": [json({ status: "healthy" })],
		});
		await retrieveChunks(KEYED, { question: "q" }, fake.fetch);
		await scanDocuments(KEYED, fake.fetch);
		await pollParseStatus(KEYED, { dataset_id: "ds", document_id: "t" }, fake.fetch, { maxPolls: 1, intervalMs: 0 });
		await deleteDocuments(KEYED, "ds", ["t"], fake.fetch);
		await uploadDocument(KEYED, UPLOAD_REQUEST, fake.fetch);
		await resolveDocumentIds(KEYED, "t", fake.fetch);
		await probeLightrag(KEYED, fake.fetch);
		expect(fake.calls).toHaveLength(7);
		for (const call of fake.calls) {
			expect(call.headers.get("x-api-key")).toBe("lr-test-key");
			expect(call.headers.get("authorization")).toBeNull();
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
