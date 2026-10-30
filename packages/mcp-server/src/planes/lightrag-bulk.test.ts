/**
 * The LightRAG bulk plane against a scripted fake plane: every request is
 * recorded and every route answers from a per-test queue (the last reply
 * repeats), so the wire behaviour, not just the outcome, is asserted. The
 * clock and the sleep are injected: no test waits.
 */
import { describe, expect, test } from "bun:test";
import { CircuitBreaker, gatedFetch } from "@substrate/observability";
import type { LightragConfig } from "../config.ts";
import { defined } from "../test-support.ts";
import {
	BULK_LIST_MAX_ELAPSED_MS,
	BULK_LIST_MAX_PAGES,
	BULK_LIST_PAGE_SIZE,
	BULK_MAX_BYTES_PER_REQUEST,
	BULK_MAX_DELETE_IDS,
	BULK_MAX_DOCUMENTS_PER_REQUEST,
	bulkTimeoutMs,
	createLightragBulkPlane,
	type BulkDocumentOutcome,
	type BulkTextDocument,
} from "./lightrag-bulk.ts";
import { lightragOp, type FetchLike } from "./lightrag.ts";

const CONFIG: LightragConfig = { url: "http://lightrag.test" };

interface Call {
	method: string;
	path: string;
	body: unknown;
}

type Reply = Response | ((call: Call) => Response);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function accepted(trackId: string): Response {
	return json({ status: "success", message: "Texts successfully received.", track_id: trackId });
}

const IDLE = (): Response => json({ busy: false });
const BUSY = (): Response => json({ busy: true });
const STARTED = (): Response => json({ status: "deletion_started", message: "started", doc_id: "x" });

function tracked(id: string, name: string, status = "processed", extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { id, status, file_path: name, content_summary: "", error_msg: null, metadata: null, ...extra };
}

function listing(trackId: string, documents: Array<Record<string, unknown>>): Response {
	return json({ track_id: trackId, documents, total_count: documents.length, status_summary: {} });
}

function namesOf(body: unknown): string[] {
	return isRecord(body) && Array.isArray(body.file_sources) ? body.file_sources.map(String) : [];
}

function clock() {
	let time = 0;
	const sleeps: number[] = [];
	return {
		now: () => time,
		sleep: async (ms: number): Promise<void> => {
			sleeps.push(ms);
			time += ms;
		},
		sleeps,
	};
}

/**
 * A recording fake. `routes` maps `METHOD /path` to a FIFO of replies; the last
 * one repeats. An unscripted request throws, which the plane reports as
 * unreachable and the assertion that expected otherwise catches.
 */
function fakePlane(routes: Record<string, Reply[]>) {
	const calls: Call[] = [];
	const fetchImpl: FetchLike = async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const call: Call = { method, path: url.pathname, body };
		calls.push(call);
		const queue = routes[`${method} ${url.pathname}`];
		const next = queue !== undefined && queue.length > 1 ? queue.shift() : queue?.[0];
		if (next === undefined) throw new Error(`unscripted request: ${method} ${url.pathname}`);
		// `clone()` resolves to the undici declaration of Response next to Bun's; the value is a Bun Response at runtime.
		return (typeof next === "function" ? next(call) : next.clone()) as Response;
	};
	const time = clock();
	const plane = createLightragBulkPlane(CONFIG, { fetch: fetchImpl, sleep: time.sleep, now: time.now });
	return { plane, calls, time };
}

function count(calls: readonly Call[], method: string, path: string): number {
	return calls.filter((call) => call.method === method && call.path === path).length;
}

function docs(...names: string[]): BulkTextDocument[] {
	return names.map((name) => ({ name, text: `body of ${name}` }));
}

describe("insertBatch", () => {
	test("three documents go in one request, wait on one poll loop, and map to their plane ids in input order", async () => {
		const { plane, calls, time } = fakePlane({
			"POST /documents/texts": [accepted("insert-1")],
			"GET /documents/pipeline_status": [BUSY(), IDLE()],
			// The plane lists them in another order than they were sent.
			"GET /documents/track_status/insert-1": [listing("insert-1", [tracked("doc-c", "c.md"), tracked("doc-a", "a.md"), tracked("doc-b", "b.md")])],
		});
		const outcomes = await plane.insertBatch([
			{ name: "a.md", text: "  alpha\n" },
			{ name: "b.md", text: "beta" },
			{ name: "c.md", text: "gamma" },
		]);
		expect(outcomes).toEqual([
			{ name: "a.md", status: "ingested", documentId: "doc-a" },
			{ name: "b.md", status: "ingested", documentId: "doc-b" },
			{ name: "c.md", status: "ingested", documentId: "doc-c" },
		]);
		expect(calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([{ texts: ["alpha", "beta", "gamma"], file_sources: ["a.md", "b.md", "c.md"] }]);
		expect(count(calls, "GET", "/documents/pipeline_status")).toBe(2);
		expect(count(calls, "GET", "/documents/track_status/insert-1")).toBe(1);
		expect(time.sleeps).toEqual([1000]);
		expect(calls.some((call) => call.method === "DELETE")).toBe(false);
	});

	test("a document the pipeline failed keeps a short reason, and one the plane never lists is unknown-document", async () => {
		const { plane, calls, time } = fakePlane({
			"POST /documents/texts": [accepted("insert-1")],
			"GET /documents/pipeline_status": [IDLE()],
			"GET /documents/track_status/insert-1": [
				listing("insert-1", [tracked("doc-a", "a.md"), tracked("doc-b", "b.md", "failed", { error_msg: `LLM failed\n${"x".repeat(500)}` })]),
			],
		});
		const outcomes = await plane.insertBatch(docs("a.md", "b.md", "c.md"));
		expect(outcomes[0]).toEqual({ name: "a.md", status: "ingested", documentId: "doc-a" });
		const failure = defined(outcomes[1], "failed outcome");
		expect(failure.status).toBe("failed");
		expect(failure.reason?.startsWith("pipeline-failed: LLM failed x")).toBe(true);
		expect(failure.reason?.length).toBeLessThanOrEqual("pipeline-failed: ".length + 200);
		expect(outcomes[2]).toEqual({ name: "c.md", status: "failed", reason: "unknown-document" });
		// The enqueue behind the answer is asynchronous, so an absent document is read a bounded number of times, not forever.
		expect(count(calls, "GET", "/documents/track_status/insert-1")).toBe(3);
		expect(time.sleeps).toHaveLength(2);
	});

	test("identical text under another name settles as ingested with the original's id, unless the original failed", async () => {
		const duplicate = (original: string | undefined, extra: Record<string, unknown> = {}) => ({
			status: "failed",
			metadata: { is_duplicate: true, duplicate_kind: "content_hash", ...(original === undefined ? {} : { original_doc_id: original }) },
			...extra,
		});
		const { plane } = fakePlane({
			"POST /documents/texts": [accepted("insert-1")],
			"GET /documents/pipeline_status": [IDLE()],
			"GET /documents/track_status/insert-1": [
				listing("insert-1", [
					tracked("doc-a", "a.md"),
					tracked("dup-1", "b.md", "failed", duplicate("doc-a")),
					tracked("dup-2", "c.md", "failed", duplicate(undefined)),
					tracked("doc-d", "d.md", "failed", { error_msg: "boom" }),
					tracked("dup-3", "e.md", "failed", duplicate("doc-d")),
					tracked("dup-4", "f.md", "failed", { content_summary: "[DUPLICATE:content_hash] Original document: doc-a" }),
					tracked("dup-5", "g.md", "failed", { metadata: { is_duplicate: true, duplicate_kind: "filename", original_doc_id: "doc-a" } }),
					tracked("dup-6", "h.md", "failed", { ...duplicate(undefined), error_msg: "Identical content already exists under another filename. Original doc_id: doc-z, Status: failed" }),
				]),
			],
		});
		const outcomes = await plane.insertBatch(docs("a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md"));
		expect(outcomes).toEqual([
			{ name: "a.md", status: "ingested", documentId: "doc-a" },
			{ name: "b.md", status: "ingested", documentId: "doc-a", reason: "duplicate-content" },
			{ name: "c.md", status: "failed", reason: "duplicate-content" },
			{ name: "d.md", status: "failed", reason: "pipeline-failed: boom" },
			{ name: "e.md", status: "failed", reason: "pipeline-failed" },
			{ name: "f.md", status: "ingested", documentId: "doc-a", reason: "duplicate-content" },
			{ name: "g.md", status: "failed", reason: "conflict" },
			{ name: "h.md", status: "failed", reason: "duplicate-content" },
		]);
	});

	test("a 409 on a batch retries the documents one by one so one clash does not fail the rest", async () => {
		const { plane, calls } = fakePlane({
			"POST /documents/texts": [json({ detail: "exists" }, 409), accepted("t-a"), json({ detail: "exists" }, 409), accepted("t-c")],
			"GET /documents/pipeline_status": [IDLE()],
			"GET /documents/track_status/t-a": [listing("t-a", [tracked("doc-a", "a.md")])],
			"GET /documents/track_status/t-c": [listing("t-c", [tracked("doc-c", "c.md")])],
		});
		const outcomes = await plane.insertBatch(docs("a.md", "b.md", "c.md"));
		expect(outcomes).toEqual([
			{ name: "a.md", status: "ingested", documentId: "doc-a" },
			{ name: "b.md", status: "failed", reason: "conflict" },
			{ name: "c.md", status: "ingested", documentId: "doc-c" },
		]);
		expect(calls.filter((call) => call.method === "POST").map((call) => namesOf(call.body))).toEqual([["a.md", "b.md", "c.md"], ["a.md"], ["b.md"], ["c.md"]]);
		expect(count(calls, "GET", "/documents/pipeline_status")).toBe(1);
	});

	test("a 409 on a single document is a conflict with no retry and no pipeline wait", async () => {
		const { plane, calls } = fakePlane({ "POST /documents/texts": [json({ detail: "exists" }, 409)] });
		expect(await plane.insertBatch(docs("a.md"))).toEqual([{ name: "a.md", status: "failed", reason: "conflict" }]);
		expect(calls).toHaveLength(1);
	});

	test("a pipeline that stays busy ends at the batch bound with timeout, still reading the status once at the end", async () => {
		const { plane, calls, time } = fakePlane({
			"POST /documents/texts": [accepted("insert-1")],
			"GET /documents/pipeline_status": [BUSY()],
			"GET /documents/track_status/insert-1": [listing("insert-1", [])],
		});
		expect(await plane.insertBatch(docs("a.md"))).toEqual([{ name: "a.md", status: "failed", reason: "timeout" }]);
		const spent = time.sleeps.reduce((sum, ms) => sum + ms, 0);
		expect(spent).toBeLessThanOrEqual(bulkTimeoutMs(1));
		expect(spent).toBeGreaterThanOrEqual(bulkTimeoutMs(1) - 1000);
		expect(count(calls, "GET", "/documents/pipeline_status")).toBe(time.sleeps.length + 1);
		expect(count(calls, "GET", "/documents/track_status/insert-1")).toBe(1);
	});

	test("a document already processed when the bound hits keeps its id; only the open ones time out", async () => {
		const { plane } = fakePlane({
			"POST /documents/texts": [accepted("insert-1")],
			"GET /documents/pipeline_status": [BUSY()],
			"GET /documents/track_status/insert-1": [listing("insert-1", [tracked("doc-a", "a.md"), tracked("doc-b", "b.md", "processing")])],
		});
		expect(await plane.insertBatch(docs("a.md", "b.md"))).toEqual([
			{ name: "a.md", status: "ingested", documentId: "doc-a" },
			{ name: "b.md", status: "failed", reason: "timeout" },
		]);
	});

	test("the batch timeout grows with the batch and is capped", () => {
		expect(bulkTimeoutMs(10)).toBeGreaterThan(bulkTimeoutMs(1));
		expect(bulkTimeoutMs(1)).toBeGreaterThan(0);
		expect(bulkTimeoutMs(100_000)).toBe(300_000);
		expect(bulkTimeoutMs(100_000)).toBe(bulkTimeoutMs(1_000));
	});

	test("a transport failure marks every document plane-unavailable after one attempt; a fetch timeout is timeout", async () => {
		let attempts = 0;
		const down: FetchLike = async () => {
			attempts += 1;
			throw new Error("connect ECONNREFUSED");
		};
		const plane = createLightragBulkPlane(CONFIG, { fetch: down, sleep: async () => {} });
		expect(await plane.insertBatch(docs("a.md", "b.md"))).toEqual([
			{ name: "a.md", status: "failed", reason: "plane-unavailable" },
			{ name: "b.md", status: "failed", reason: "plane-unavailable" },
		]);
		expect(attempts).toBe(1);

		const slow: FetchLike = async () => {
			throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
		};
		const slowPlane = createLightragBulkPlane(CONFIG, { fetch: slow, sleep: async () => {} });
		expect(await slowPlane.insertBatch(docs("a.md"))).toEqual([{ name: "a.md", status: "failed", reason: "timeout" }]);
	});

	test("an open breaker answers plane-unavailable for every document without reaching the plane", async () => {
		const breaker = new CircuitBreaker("lightrag", { failureThreshold: 1, openMs: 30_000 }, () => 0);
		let reached = 0;
		const gated = gatedFetch(
			{ plane: "lightrag", breaker, observe: null },
			async () => {
				reached += 1;
				return json({ detail: "down" }, 503);
			},
			lightragOp,
		);
		const plane = createLightragBulkPlane(CONFIG, { fetch: gated, sleep: async () => {} });
		const unavailable: BulkDocumentOutcome[] = [
			{ name: "a.md", status: "failed", reason: "plane-unavailable" },
			{ name: "b.md", status: "failed", reason: "plane-unavailable" },
		];
		expect(await plane.insertBatch(docs("a.md", "b.md"))).toEqual(unavailable);
		expect(breaker.state()).toBe("open");
		expect(reached).toBe(1);
		expect(await plane.insertBatch(docs("a.md", "b.md"))).toEqual(unavailable);
		expect(reached).toBe(1);
	});

	test("a fenced workspace or an unusable insert answer fails the documents without waiting", async () => {
		const fenced = fakePlane({
			"POST /documents/texts": [accepted("insert-1")],
			"GET /documents/pipeline_status": [json({ busy: false, recovery_required: true, recovery_message: "fenced" })],
		});
		expect(await fenced.plane.insertBatch(docs("a.md"))).toEqual([{ name: "a.md", status: "failed", reason: "plane-unavailable" }]);
		expect(count(fenced.calls, "GET", "/documents/track_status/insert-1")).toBe(0);

		const noTrack = fakePlane({ "POST /documents/texts": [json({ status: "success", message: "m" })] });
		expect(await noTrack.plane.insertBatch(docs("a.md"))).toEqual([{ name: "a.md", status: "failed", reason: "plane-unavailable" }]);

		const refused = fakePlane({ "POST /documents/texts": [json({ detail: "A valid file_source is required" }, 400)] });
		expect(await refused.plane.insertBatch(docs("a.md", "b.md"))).toEqual([
			{ name: "a.md", status: "failed", reason: "rejected" },
			{ name: "b.md", status: "failed", reason: "rejected" },
		]);
	});

	test("documents the plane would refuse are rejected locally and never sent; the rest go through", async () => {
		const { plane, calls } = fakePlane({
			"POST /documents/texts": [accepted("insert-1")],
			"GET /documents/pipeline_status": [IDLE()],
			"GET /documents/track_status/insert-1": [listing("insert-1", [tracked("doc-1", "dup.md")])],
		});
		const outcomes = await plane.insertBatch([
			{ name: "dup.md", text: "first" },
			{ name: "dup.md", text: "second" },
			{ name: "empty.md", text: " \n " },
			{ name: "a/b.md", text: "directory" },
			{ name: "huge.md", text: "x".repeat(BULK_MAX_BYTES_PER_REQUEST + 1) },
		]);
		expect(outcomes).toEqual([
			{ name: "dup.md", status: "ingested", documentId: "doc-1" },
			{ name: "dup.md", status: "failed", reason: "conflict" },
			{ name: "empty.md", status: "failed", reason: "rejected" },
			{ name: "a/b.md", status: "failed", reason: "rejected" },
			{ name: "huge.md", status: "failed", reason: "rejected" },
		]);
		expect(calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([{ texts: ["first"], file_sources: ["dup.md"] }]);
	});

	test("an aborted signal fails the documents as timeout before any request", async () => {
		const { plane, calls } = fakePlane({});
		const controller = new AbortController();
		controller.abort();
		expect(await plane.insertBatch(docs("a.md"), { signal: controller.signal })).toEqual([{ name: "a.md", status: "failed", reason: "timeout" }]);
		expect(calls).toHaveLength(0);
	});

	test("an empty input sends nothing", async () => {
		const { plane, calls } = fakePlane({});
		expect(await plane.insertBatch([])).toEqual([]);
		expect(calls).toHaveLength(0);
	});
});

describe("request splitting", () => {
	function splittingPlane() {
		const sent = new Map<string, string[]>();
		const calls: Call[] = [];
		const fetchImpl: FetchLike = async (input, init) => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			calls.push({ method, path: url.pathname, body });
			if (method === "POST" && url.pathname === "/documents/texts") {
				const trackId = `t${sent.size + 1}`;
				sent.set(trackId, namesOf(body));
				return accepted(trackId);
			}
			if (url.pathname === "/documents/pipeline_status") return IDLE();
			const trackId = url.pathname.replace("/documents/track_status/", "");
			return listing(trackId, (sent.get(trackId) ?? []).map((name) => tracked(`doc-${name}`, name)));
		};
		return { plane: createLightragBulkPlane(CONFIG, { fetch: fetchImpl, sleep: async () => {} }), calls, sent };
	}

	test("more documents than one request may carry are split in order, with one pipeline wait", async () => {
		const { plane, calls, sent } = splittingPlane();
		const names = Array.from({ length: 2 * BULK_MAX_DOCUMENTS_PER_REQUEST + 50 }, (_, index) => `d${index}.md`);
		const outcomes = await plane.insertBatch(docs(...names));
		expect([...sent.values()].map((group) => group.length)).toEqual([BULK_MAX_DOCUMENTS_PER_REQUEST, BULK_MAX_DOCUMENTS_PER_REQUEST, 50]);
		expect([...sent.values()].flat()).toEqual(names);
		expect(outcomes.map((outcome) => [outcome.name, outcome.status, outcome.documentId])).toEqual(names.map((name) => [name, "ingested", `doc-${name}`]));
		expect(count(calls, "GET", "/documents/pipeline_status")).toBe(1);
	});

	test("documents are split by bytes too, and one larger than a request is rejected on its own", async () => {
		const { plane, sent } = splittingPlane();
		const big = Math.floor(BULK_MAX_BYTES_PER_REQUEST * 0.45);
		const outcomes = await plane.insertBatch([
			{ name: "d0.md", text: "x".repeat(big) },
			{ name: "d1.md", text: "x".repeat(big) },
			{ name: "d2.md", text: "x".repeat(big) },
		]);
		expect([...sent.values()]).toEqual([["d0.md", "d1.md"], ["d2.md"]]);
		expect(outcomes.every((outcome) => outcome.status === "ingested")).toBe(true);
	});

	test("a 413 (the server's per-request ceiling) retries the batch in halves", async () => {
		const { plane, calls } = fakePlane({
			"POST /documents/texts": [json({ detail: "Too many texts" }, 413), accepted("t1"), accepted("t2")],
			"GET /documents/pipeline_status": [IDLE()],
			"GET /documents/track_status/t1": [listing("t1", [tracked("doc-a", "a.md"), tracked("doc-b", "b.md")])],
			"GET /documents/track_status/t2": [listing("t2", [tracked("doc-c", "c.md"), tracked("doc-d", "d.md")])],
		});
		const outcomes = await plane.insertBatch(docs("a.md", "b.md", "c.md", "d.md"));
		expect(outcomes.map((outcome) => outcome.documentId)).toEqual(["doc-a", "doc-b", "doc-c", "doc-d"]);
		expect(calls.filter((call) => call.method === "POST").map((call) => namesOf(call.body).length)).toEqual([4, 2, 2]);
	});
});

describe("deleteDocuments", () => {
	test("known and unknown ids both count as deleted, an empty id is rejected, and the ids go once", async () => {
		const { plane, calls } = fakePlane({
			"DELETE /documents/delete_document": [STARTED()],
			"GET /documents/pipeline_status": [IDLE()],
		});
		const result = await plane.deleteDocuments(["doc-known", "doc-unknown", "doc-known", "  ", " doc-x "]);
		expect(result).toEqual({ deleted: ["doc-known", "doc-unknown", "doc-x"], failed: [{ id: "  ", reason: "rejected" }] });
		const deletes = calls.filter((call) => call.method === "DELETE");
		expect(deletes).toHaveLength(1);
		expect(deletes.map((call) => (isRecord(call.body) ? call.body.doc_ids : undefined))).toEqual([["doc-known", "doc-unknown", "doc-x"]]);
	});

	test("ids go in requests of at most the delete limit, each followed by a wait for the pipeline", async () => {
		const { plane, calls } = fakePlane({
			"DELETE /documents/delete_document": [STARTED()],
			"GET /documents/pipeline_status": [IDLE()],
		});
		const ids = Array.from({ length: 2 * BULK_MAX_DELETE_IDS + 20 }, (_, index) => `doc-${index}`);
		const result = await plane.deleteDocuments(ids);
		expect(result).toEqual({ deleted: ids, failed: [] });
		const sizes = calls.filter((call) => call.method === "DELETE").map((call) => (isRecord(call.body) && Array.isArray(call.body.doc_ids) ? call.body.doc_ids.length : -1));
		expect(sizes).toEqual([BULK_MAX_DELETE_IDS, BULK_MAX_DELETE_IDS, 20]);
		expect(count(calls, "GET", "/documents/pipeline_status")).toBe(3);
	});

	test("a busy plane is waited on and retried; one that stays busy fails the ids as plane-unavailable", async () => {
		const retried = fakePlane({
			"DELETE /documents/delete_document": [json({ status: "busy", message: "pipeline busy", doc_id: "x" }), STARTED()],
			"GET /documents/pipeline_status": [BUSY(), IDLE()],
		});
		expect(await retried.plane.deleteDocuments(["doc-a"])).toEqual({ deleted: ["doc-a"], failed: [] });
		expect(count(retried.calls, "DELETE", "/documents/delete_document")).toBe(2);

		const stuck = fakePlane({
			"DELETE /documents/delete_document": [json({ status: "busy", message: "pipeline busy", doc_id: "x" })],
			"GET /documents/pipeline_status": [IDLE()],
		});
		expect(await stuck.plane.deleteDocuments(["doc-a", "doc-b"])).toEqual({
			deleted: [],
			failed: [
				{ id: "doc-a", reason: "plane-unavailable" },
				{ id: "doc-b", reason: "plane-unavailable" },
			],
		});
		expect(count(stuck.calls, "DELETE", "/documents/delete_document")).toBe(6);
	});

	test("an accepted deletion whose pipeline never confirms idle, or whose poll fails, is reported failed, never deleted", async () => {
		const stuck = fakePlane({
			"DELETE /documents/delete_document": [STARTED()],
			"GET /documents/pipeline_status": [BUSY()],
		});
		expect(await stuck.plane.deleteDocuments(["doc-a"])).toEqual({ deleted: [], failed: [{ id: "doc-a", reason: "timeout" }] });

		const fenced = fakePlane({
			"DELETE /documents/delete_document": [STARTED()],
			"GET /documents/pipeline_status": [json({ busy: false, recovery_required: true, recovery_message: "fenced" })],
		});
		expect(await fenced.plane.deleteDocuments(["doc-a", "doc-b"])).toEqual({
			deleted: [],
			failed: [
				{ id: "doc-a", reason: "plane-unavailable" },
				{ id: "doc-b", reason: "plane-unavailable" },
			],
		});
	});

	test("a refusal and a transport failure are per-id failures with closed reasons", async () => {
		const refused = fakePlane({ "DELETE /documents/delete_document": [json({ status: "not_allowed", message: "no", doc_id: "x" })] });
		expect(await refused.plane.deleteDocuments(["doc-a"])).toEqual({ deleted: [], failed: [{ id: "doc-a", reason: "rejected" }] });

		const down = createLightragBulkPlane(CONFIG, {
			fetch: async () => {
				throw new Error("connect ECONNREFUSED");
			},
			sleep: async () => {},
		});
		expect(await down.deleteDocuments(["doc-a"])).toEqual({ deleted: [], failed: [{ id: "doc-a", reason: "plane-unavailable" }] });
	});

	test("the clear-all route is never called, whatever the ids look like", async () => {
		const { plane, calls } = fakePlane({
			"DELETE /documents/delete_document": [STARTED()],
			"GET /documents/pipeline_status": [IDLE()],
		});
		const result = await plane.deleteDocuments(["documents", "/", "..", "/documents"]);
		expect(result.failed).toEqual([]);
		expect(calls.some((call) => call.method === "DELETE" && call.path === "/documents")).toBe(false);
		expect(calls.filter((call) => call.method === "DELETE").every((call) => call.path === "/documents/delete_document")).toBe(true);
	});

	test("no ids sends nothing", async () => {
		const { plane, calls } = fakePlane({});
		expect(await plane.deleteDocuments([])).toEqual({ deleted: [], failed: [] });
		expect(calls).toHaveLength(0);
	});
});

describe("listDocuments", () => {
	const CORPUS_A = "corpus:acme%2Fdocs:README.md@0123456789ab";
	const CORPUS_B = "corpus:acme%2Fdocs:guide.md@ba9876543210";

	function pageOf(entries: readonly unknown[], hasNext: boolean, page = 1): Response {
		return json({
			documents: entries,
			pagination: { page, page_size: BULK_LIST_PAGE_SIZE, total_count: entries.length, total_pages: hasNext ? page + 1 : page, has_next: hasNext, has_prev: page > 1 },
			status_counts: {},
		});
	}

	function entry(id: string, name: string): Record<string, unknown> {
		return { id, file_path: name, status: "processed", content_summary: "", error_msg: null, metadata: null };
	}

	test("every page is read in order at the largest page size, sorted by id; only corpus names are returned and other documents give their id alone", async () => {
		const { plane, calls } = fakePlane({
			"POST /documents/paginated": [
				(call) => {
					const page = isRecord(call.body) ? call.body.page : undefined;
					if (page === 1) return pageOf([entry("doc-a", CORPUS_A), entry("doc-x", "docs__a__README.md")], true, 1);
					return pageOf([entry("doc-b", CORPUS_B)], false, 2);
				},
			],
		});
		const listing = await plane.listDocuments();
		expect(listing).toEqual({
			ok: true,
			documents: [
				{ id: "doc-a", name: CORPUS_A },
				{ id: "doc-b", name: CORPUS_B },
			],
			otherDocumentIds: ["doc-x"],
			truncated: false,
		});
		const bodies = calls.filter((call) => call.path === "/documents/paginated").map((call) => call.body);
		expect(bodies).toEqual([
			{ page: 1, page_size: BULK_LIST_PAGE_SIZE, sort_field: "id", sort_direction: "asc" },
			{ page: 2, page_size: BULK_LIST_PAGE_SIZE, sort_field: "id", sort_direction: "asc" },
		]);
		expect(calls.every((call) => call.method === "POST")).toBe(true);
	});

	test("a page that fails fails the whole listing: what a partial read lacks proves nothing", async () => {
		const { plane } = fakePlane({
			"POST /documents/paginated": [(call) => (isRecord(call.body) && call.body.page === 1 ? pageOf([entry("doc-a", CORPUS_A)], true) : json({ detail: "boom" }, 500))],
		});
		expect(await plane.listDocuments()).toEqual({ ok: false, reason: "plane-unavailable" });
	});

	test("an answer without documents or pagination is a plane failure, not an empty listing", async () => {
		const { plane } = fakePlane({ "POST /documents/paginated": [json({ unrelated: true })] });
		expect(await plane.listDocuments()).toEqual({ ok: false, reason: "plane-unavailable" });
	});

	test("a listing that never ends stops at the page bound and says it is truncated", async () => {
		const { plane, calls } = fakePlane({ "POST /documents/paginated": [(call) => pageOf([entry(`doc-${String(isRecord(call.body) ? call.body.page : 0)}`, CORPUS_A)], true)] });
		const listing = await plane.listDocuments();
		expect(listing.ok && listing.truncated).toBe(true);
		expect(count(calls, "POST", "/documents/paginated")).toBe(BULK_LIST_MAX_PAGES);
	});

	test("a listing that runs past its time bound stops and says it is truncated", async () => {
		let now = 0;
		let requests = 0;
		const plane = createLightragBulkPlane(CONFIG, {
			fetch: async () => {
				requests += 1;
				now += BULK_LIST_MAX_ELAPSED_MS / 2;
				return pageOf([entry(`doc-${requests}`, CORPUS_A)], true, requests);
			},
			sleep: async () => {},
			now: () => now,
		});
		const listing = await plane.listDocuments();
		expect(listing.ok && listing.truncated).toBe(true);
		expect(requests).toBe(2);
	});

	test("an entry that cannot be read makes the listing truncated, and the readable ones are still returned", async () => {
		const { plane } = fakePlane({ "POST /documents/paginated": [pageOf([entry("doc-a", CORPUS_A), { file_path: CORPUS_B }, "garbage"], false)] });
		expect(await plane.listDocuments()).toEqual({ ok: true, documents: [{ id: "doc-a", name: CORPUS_A }], otherDocumentIds: [], truncated: true });
	});

	test("a caller whose signal already fired gets a timeout and the plane is not asked", async () => {
		const { plane, calls } = fakePlane({ "POST /documents/paginated": [pageOf([], false)] });
		const controller = new AbortController();
		controller.abort();
		expect(await plane.listDocuments({ signal: controller.signal })).toEqual({ ok: false, reason: "timeout" });
		expect(calls).toHaveLength(0);
	});
});

describe("lookupDocument", () => {
	function page(ids: string[], totalCount: number, totalPages: number, page = 1): Response {
		return json({
			documents: ids.map((id) => ({ id, file_path: `corpus:${id}`, status: "processed" })),
			pagination: { page, page_size: BULK_LIST_PAGE_SIZE, total_count: totalCount, total_pages: totalPages, has_next: page < totalPages, has_prev: page > 1 },
		});
	}

	test("an id inside a page but missing from it is absent only when a second read still brackets it", async () => {
		const { plane } = fakePlane({ "POST /documents/paginated": [page(["doc-a", "doc-c"], 2, 1)] });
		expect(await plane.lookupDocument("doc-b")).toBe("absent");
		expect(await plane.lookupDocument("doc-a")).toBe("present");
	});

	test("a failed page is unknown, so a caller cannot treat the id as gone", async () => {
		const { plane } = fakePlane({ "POST /documents/paginated": [json({ detail: "down" }, 503)] });
		expect(await plane.lookupDocument("doc-a")).toBe("unknown");
	});
});
