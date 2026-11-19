import { afterAll, describe, expect, test } from "bun:test";
import {
	CORPUS_PROTOCOL,
	type CorpusIngestRequest,
	type CorpusNeardupRequest,
	type CorpusPlanRequest,
	type CorpusReflectRequest,
	DEFAULT_GAPS_LIMIT,
	EMBEDDING_REASONS,
	MAX_GAPS_LIMIT,
} from "@substrate/corpus";
import { defined } from "../../../corpus/src/test-support.ts";
import { createCorpusClient, isGapsResponse, isIngestResponse, isNeardupResponse, isPlanResponse, isReconcileResponse, isReflectResponse, isStatusResponse } from "./client.ts";
import { CorpusStub, gapsOf, ingestOf, neardupOf, planOf, reconcileOf, reflectOf, statusOf } from "./testkit.ts";

const stub = new CorpusStub();
afterAll(() => stub.stop());

const client = (token: string | null = "tok-1", timeoutMs = 2000) => createCorpusClient({ url: stub.url, token: token ?? undefined, timeoutMs });
const request: CorpusPlanRequest = { protocol: CORPUS_PROTOCOL, entries: [], scope: { coverage: [], maxTier: 2 } };

describe("the corpus client", () => {
	test("posts the plan with the bearer and returns the guarded answer", async () => {
		const reply = planOf([{ action: "add", repo: "Acme/A", path: "README.md", sha256: "a".repeat(64) }], 3);
		stub.on("POST /corpus/plan", () => ({ status: 200, body: reply }));
		const result = await client().plan(request);
		expect(result).toEqual({ ok: true, value: reply });
		const seen = stub.requests("/corpus/plan").at(-1);
		expect(seen?.authorization).toBe("Bearer tok-1");
		expect(seen?.body).toEqual(request);
	});

	test("sends no authorization header without a token, and reads status with GET", async () => {
		stub.on("GET /corpus/status", () => ({ status: 200, body: statusOf() }));
		const result = await client(null).status();
		expect(result.ok).toBe(true);
		const seen = stub.requests("/corpus/status").at(-1);
		expect(seen?.method).toBe("GET");
		expect(seen?.authorization).toBeNull();
	});

	test("posts an ingest with its tombstones and returns the per-document results", async () => {
		stub.on("POST /corpus/ingest", () => ({ status: 200, body: ingestOf([{ repo: "Acme/A", path: "gone.md", status: "tombstoned", documentId: "d1" }]) }));
		const sent: CorpusIngestRequest = { protocol: CORPUS_PROTOCOL, documents: [], tombstones: [{ repo: "Acme/A", path: "gone.md" }] };
		const result = await client().ingest(sent);
		expect(result.ok && result.value.results[0]).toEqual({ repo: "Acme/A", path: "gone.md", status: "tombstoned", documentId: "d1" });
		expect(stub.requests("/corpus/ingest").at(-1)?.body).toEqual(sent);
	});

	test.each([
		[401, "unauthorized", "401"],
		[403, "forbidden", "403"],
	] as const)("a %d answer is %s with a message that names the status", async (status, kind, text) => {
		stub.on("GET /corpus/status", () => ({ status, body: { error: "nope" } }));
		const result = await client().status();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe(kind);
			expect(result.error.message).toContain(text);
			expect(result.error.status).toBe(status);
		}
	});

	test("a 503 with corpus.disabled says the server runs with the corpus off; any other 503 is unavailable", async () => {
		stub.on("GET /corpus/status", () => ({ status: 503, body: { error: "corpus.disabled" } }));
		const off = await client().status();
		expect(off.ok === false && off.error.kind).toBe("disabled");
		expect(off.ok === false && off.error.message).toContain("corpus off");
		stub.on("GET /corpus/status", () => ({ status: 503, body: { error: "plane down" } }));
		const down = await client().status();
		expect(down.ok === false && down.error.kind).toBe("unavailable");
		expect(down.ok === false && down.error.message).toContain("plane down");
	});

	test("another error status keeps the server's own explanation, truncated", async () => {
		stub.on("GET /corpus/status", () => ({ status: 500, body: { error: "x".repeat(1000) } }));
		const result = await client().status();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("http");
			expect(result.error.message.length).toBeLessThan(300);
		}
	});

	test("a response with another protocol version is refused before its shape is looked at", async () => {
		stub.on("GET /corpus/status", () => ({ status: 200, body: { protocol: CORPUS_PROTOCOL + 1, anything: true } }));
		const result = await client().status();
		expect(result.ok === false && result.error.kind).toBe("protocol");
	});

	test("an answer of the wrong shape, or not JSON, is invalid and never cast", async () => {
		stub.on("POST /corpus/plan", () => ({ status: 200, body: { protocol: CORPUS_PROTOCOL, items: [{ action: "unchanged", repo: "r", path: "p" }], counts: {}, manifestVersion: 1 } }));
		const wrong = await client().plan(request);
		expect(wrong.ok === false && wrong.error.kind).toBe("invalid");
		stub.on("POST /corpus/plan", () => ({ status: 200, body: "not an object" }));
		const text = await client().plan(request);
		expect(text.ok === false && text.error.kind).toBe("invalid");
	});

	test("a server that does not answer in time is a timeout, and a closed port is a network error", async () => {
		stub.on("GET /corpus/status", () => "hang");
		const slow = await client("tok-1", 50).status();
		expect(slow.ok === false && slow.error.kind).toBe("timeout");
		const closed = await createCorpusClient({ url: "http://127.0.0.1:1", token: undefined, timeoutMs: 2000 }).status();
		expect(closed.ok === false && closed.error.kind).toBe("network");
	});

	test("posts a reflect request with the bearer and returns the guarded answer", async () => {
		const reply = reflectOf([{ repo: "Acme/A", status: "stored" }]);
		stub.on("POST /corpus/reflect", () => ({ status: 200, body: reply }));
		const sent: CorpusReflectRequest = { protocol: CORPUS_PROTOCOL, digests: [{ repo: "Acme/A", text: "# d\n", sha256: "a".repeat(64) }] };
		expect(await client().reflect(sent)).toEqual({ ok: true, value: reply });
		const seen = defined(stub.requests("/corpus/reflect").at(-1), "reflect request");
		expect(seen.authorization).toBe("Bearer tok-1");
		expect(seen.body).toEqual(sent);
	});

	test("reads the gaps with GET and keeps the limit inside the server's maximum; an invalid limit is the default", async () => {
		stub.on("GET /corpus/gaps", () => ({ status: 200, body: gapsOf([]) }));
		for (const limit of [undefined, 7, 1_000_000, 0, -3, 2.5, Number.NaN]) {
			expect((await client().gaps(limit)).ok).toBe(true);
		}
		const searches = stub.requests("/corpus/gaps").map((seen) => seen.search);
		expect(searches).toEqual([
			`?limit=${DEFAULT_GAPS_LIMIT}`,
			"?limit=7",
			`?limit=${MAX_GAPS_LIMIT}`,
			`?limit=${DEFAULT_GAPS_LIMIT}`,
			`?limit=${DEFAULT_GAPS_LIMIT}`,
			`?limit=${DEFAULT_GAPS_LIMIT}`,
			`?limit=${DEFAULT_GAPS_LIMIT}`,
		]);
		expect(stub.requests("/corpus/gaps")[0]?.method).toBe("GET");
	});

	test("a reflect answer of the wrong shape is invalid and a disabled corpus is reported as such", async () => {
		stub.on("POST /corpus/reflect", () => ({ status: 200, body: { protocol: CORPUS_PROTOCOL, results: "none", manifestVersion: 1 } }));
		const invalid = await client().reflect({ protocol: CORPUS_PROTOCOL, digests: [] });
		expect(invalid.ok === false && invalid.error.kind).toBe("invalid");
		stub.on("POST /corpus/reflect", () => ({ status: 503, body: { error: "corpus.disabled" } }));
		const disabled = await client().reflect({ protocol: CORPUS_PROTOCOL, digests: [] });
		expect(disabled.ok === false && disabled.error.kind).toBe("disabled");
	});
});

describe("response guards", () => {
	const plan = planOf([{ action: "rename", repo: "r", path: "new.md", sha256: "a".repeat(64), renamedFrom: "old.md" }]);

	test("accept the shapes the server sends", () => {
		expect(isPlanResponse(plan)).toBe(true);
		expect(isPlanResponse(planOf([{ action: "rename", repo: "local/c2", path: "new.md", sha256: "a".repeat(64), renamedFrom: "new.md", renamedFromRepo: "local/c1" }]))).toBe(true);
		expect(isIngestResponse(ingestOf([{ repo: "r", path: "p", status: "refused", reason: "secret-findings" }]))).toBe(true);
		expect(isStatusResponse(statusOf())).toBe(true);
	});

	test("refuse a wrong protocol, a missing count, an unknown action or status, a bad kind or tier and a non-object", () => {
		expect(isPlanResponse({ ...plan, protocol: 2 })).toBe(false);
		expect(isPlanResponse({ ...plan, counts: { add: 1 } })).toBe(false);
		expect(isPlanResponse({ ...plan, items: [{ action: "delete", repo: "r", path: "p" }] })).toBe(false);
		expect(isPlanResponse({ ...plan, items: [{ action: "add", repo: "r" }] })).toBe(false);
		expect(isPlanResponse({ ...plan, manifestVersion: -1 })).toBe(false);
		expect(isPlanResponse(planOf([{ action: "rename", repo: "local/c2", path: "new.md", sha256: "a".repeat(64), renamedFrom: "new.md", renamedFromRepo: 7 as unknown as string }]))).toBe(false);
		expect(isIngestResponse({ ...ingestOf([]), results: [{ repo: "r", path: "p", status: "done" }] })).toBe(false);
		expect(isStatusResponse({ ...statusOf(), byKind: [{ kind: "memo", count: 1 }] })).toBe(false);
		expect(isStatusResponse({ ...statusOf(), byTier: [{ tier: 4, count: 1 }] })).toBe(false);
		expect(isStatusResponse({ ...statusOf(), lastIngestAt: 5 })).toBe(false);
		expect(isStatusResponse({ ...statusOf(), lagSeconds: -1 })).toBe(false);
		expect(isStatusResponse({ ...statusOf(), lagSeconds: "7" })).toBe(false);
		expect(isPlanResponse(null)).toBe(false);
		expect(isPlanResponse([plan])).toBe(false);
	});

	test("posts a reconcile request and returns the guarded drift", async () => {
		const reply = reconcileOf({ missingInPlane: [{ repo: "Acme/A", path: "README.md" }], orphansInPlane: ["corpus:x"] }, { requeued: 1, deleted: 1 });
		stub.on("POST /corpus/reconcile", () => ({ status: 200, body: reply }));
		const result = await client().reconcile({ protocol: CORPUS_PROTOCOL, execute: true });
		expect(result).toEqual({ ok: true, value: reply });
		expect(stub.requests("/corpus/reconcile").at(-1)?.body).toEqual({ protocol: CORPUS_PROTOCOL, execute: true });
	});

	test("refuse a reconcile answer with a wrong shape", () => {
		expect(isReconcileResponse(reconcileOf())).toBe(true);
		expect(isReconcileResponse({ ...reconcileOf(), protocol: 2 })).toBe(false);
		expect(isReconcileResponse({ ...reconcileOf(), drift: { ...reconcileOf().drift, truncated: "no" } })).toBe(false);
		expect(isReconcileResponse({ ...reconcileOf(), drift: { ...reconcileOf().drift, missingInPlane: [{ repo: "r" }] } })).toBe(false);
		expect(isReconcileResponse({ ...reconcileOf(), drift: { ...reconcileOf().drift, orphansInPlane: [7] } })).toBe(false);
		expect(isReconcileResponse({ ...reconcileOf(), repaired: { requeued: 1 } })).toBe(false);
		expect(isReconcileResponse(null)).toBe(false);
	});

	test("accept the reflect and gaps shapes, with a null best score and a null text", () => {
		expect(isReflectResponse(reflectOf([{ repo: "r", status: "stored" }, { repo: "s", status: "refused", reason: "secret-findings" }]))).toBe(true);
		expect(isGapsResponse(gapsOf([{ queryHash: "ab12", text: null, searches: 3, lastSeen: "2026-10-29T10:00:00.000Z", best: null }]))).toBe(true);
		expect(isGapsResponse(gapsOf([], true))).toBe(true);
	});

	test("refuse a reflect or gaps answer with a wrong protocol, status, count, score or flag", () => {
		expect(isReflectResponse({ ...reflectOf([]), protocol: 2 })).toBe(false);
		expect(isReflectResponse({ ...reflectOf([]), results: [{ repo: "r", status: "done" }] })).toBe(false);
		expect(isReflectResponse({ ...reflectOf([]), manifestVersion: "x" })).toBe(false);
		const gap = { queryHash: "ab12", text: null, searches: 3, lastSeen: "t", best: 0.2 };
		expect(isGapsResponse(gapsOf([{ ...gap, searches: -1 }]))).toBe(false);
		expect(isGapsResponse(gapsOf([{ ...gap, best: Number.NaN }]))).toBe(false);
		expect(isGapsResponse({ ...gapsOf([]), gaps: [{ ...gap, text: 5 }] })).toBe(false);
		expect(isGapsResponse({ ...gapsOf([gap]), truncated: "no" })).toBe(false);
		expect(isGapsResponse({ ...gapsOf([gap]), protocol: 2 })).toBe(false);
	});
});

describe("the near-duplicate call", () => {
	const sent: CorpusNeardupRequest = { protocol: CORPUS_PROTOCOL, items: [{ repo: "Acme/A", path: "a.md", text: "alpha" }], threshold: 0.9 };
	const pair = { a: { repo: "Acme/A", path: "a.md" }, b: { repo: "Acme/A", path: "b.md" }, similarity: 0.97 };

	test("posts the request with the bearer and returns the guarded answer", async () => {
		const reply = neardupOf([pair], { skipped: [{ repo: "Acme/A", path: "empty.md", reason: "empty" }] });
		stub.on("POST /corpus/neardup", () => ({ status: 200, body: reply }));
		const result = await client().neardup(sent);
		expect(result).toEqual({ ok: true, value: reply });
		const seen = stub.requests("/corpus/neardup").at(-1);
		expect(seen?.authorization).toBe("Bearer tok-1");
		expect(seen?.body).toEqual(sent);
	});

	test("a 503 corpus.embeddings-unavailable is the embeddings kind with the server's closed reason", async () => {
		for (const reason of EMBEDDING_REASONS) {
			stub.on("POST /corpus/neardup", () => ({ status: 503, body: { error: "the embedding service could not answer", reason: "corpus.embeddings-unavailable", detail: reason } }));
			const result = await client().neardup(sent);
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.error).toMatchObject({ kind: "embeddings", status: 503, reason });
			expect(result.error.message).toContain(reason);
		}
	});

	test("a reason this CLI does not know is still the embeddings kind, without a reason, and the server's text is not echoed", async () => {
		stub.on("POST /corpus/neardup", () => ({ status: 503, body: { error: "x", reason: "corpus.embeddings-unavailable", detail: "http://tei.internal:8080 is down" } }));
		const result = await client().neardup(sent);
		expect(result.ok === false && result.error.kind).toBe("embeddings");
		expect(result.ok === false && result.error.reason).toBeUndefined();
		expect(result.ok === false && result.error.message).not.toContain("tei.internal");
	});

	test("corpus.disabled stays the disabled kind and a plain 503 stays unavailable", async () => {
		stub.on("POST /corpus/neardup", () => ({ status: 503, body: { error: "x", reason: "corpus.disabled" } }));
		const off = await client().neardup(sent);
		expect(off.ok === false && off.error.kind).toBe("disabled");
		stub.on("POST /corpus/neardup", () => ({ status: 503, body: { error: "plane down" } }));
		const down = await client().neardup(sent);
		expect(down.ok === false && down.error.kind).toBe("unavailable");
	});

	test("a refusal of the request is the http kind with the server's reason text", async () => {
		stub.on("POST /corpus/neardup", () => ({ status: 400, body: { error: "the threshold is not a number from 0.5 to 1", reason: "bad-threshold" } }));
		const result = await client().neardup(sent);
		expect(result.ok === false && result.error).toMatchObject({ kind: "http", status: 400 });
	});

	test("the guard accepts a model-less answer and refuses a malformed one", () => {
		expect(isNeardupResponse(neardupOf([], { model: null, dimension: null, compared: 0 }))).toBe(true);
		expect(isNeardupResponse(neardupOf([pair]))).toBe(true);
		const good = neardupOf([pair]);
		for (const bad of [
			null,
			{ ...good, protocol: 2 },
			{ ...good, pairs: [{ ...pair, similarity: "0.9" }] },
			{ ...good, pairs: [{ a: pair.a, similarity: 0.9 }] },
			{ ...good, compared: -1 },
			{ ...good, truncated: "no" },
			{ ...good, skipped: [{ repo: "Acme/A", path: "x.md", reason: "other" }] },
			{ ...good, model: 3 },
			{ ...good, dimension: 1.5 },
		]) {
			expect(isNeardupResponse(bad)).toBe(false);
		}
	});

	test("an answer of the wrong shape is the invalid kind", async () => {
		stub.on("POST /corpus/neardup", () => ({ status: 200, body: { protocol: CORPUS_PROTOCOL, pairs: "none" } }));
		const result = await client().neardup(sent);
		expect(result.ok === false && result.error.kind).toBe("invalid");
	});
});
