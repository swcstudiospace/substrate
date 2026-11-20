/**
 * `POST /corpus/plan`, `POST /corpus/ingest`, `POST /corpus/neardup` and `GET /corpus/status` over a real socket, with a fake manifest, a fake
 * LightRAG bulk plane and a fake TEI behind the service. What matters here is the wiring the unit tests cannot see: the gates answer before
 * anything is read or sent, the body cap and the audit are the docs routes', and the happy path reaches the plane.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORPUS_PROTOCOL, corpusDocumentName } from "@substrate/corpus";
import { loadConfig } from "../config.ts";
import { createObservability, type Observability } from "../observe.ts";
import { createHttpServer } from "../server.ts";
import { Substrate } from "../service.ts";
import { defined } from "../test-support.ts";
import { FakePlane, FakeStore, entryOf, makeDocument, makeRow, sha256Hex } from "./testkit.ts";

const REPO = "swcstudiospace/agent-substrate";
const AUTH = { authorization: "Bearer tok-omp", "content-type": "application/json" };
const ANON = { "content-type": "application/json" };
const ON = { SUBSTRATE_TOKEN_OMP: "tok-omp", SUBSTRATE_OPERATOR_TOKENS: "tok-omp", SUBSTRATE_CORPUS: "on" };

interface Harness {
	base: string;
	observability: Observability;
	store: FakeStore;
	plane: FakePlane;
	close(): void;
}

const running: Harness[] = [];

type TeiFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function start(env: Record<string, string | undefined>, options: { plane?: boolean; teiFetch?: TeiFetch } = {}): Promise<Harness> {
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const store = new FakeStore();
	const plane = new FakePlane();
	const stores = { index: null, greptime: null, corpus: { store, ...(options.plane === false ? {} : { plane }) }, ...(options.teiFetch === undefined ? {} : { teiFetch: options.teiFetch }) };
	const substrate = new Substrate(config, stores, observability.observer);
	const server = createHttpServer(substrate, config, observability);
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const { port } = server.address() as AddressInfo;
	let closed = false;
	const harness: Harness = {
		base: `http://127.0.0.1:${port}`,
		observability,
		store,
		plane,
		close() {
			if (closed) return;
			closed = true;
			observability.stop();
			server.close();
		},
	};
	running.push(harness);
	return harness;
}

afterAll(() => {
	for (const harness of running) harness.close();
});

function post(harness: Harness, path: string, body: unknown, headers: Record<string, string> = AUTH): Promise<Response> {
	return fetch(`${harness.base}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

async function reasonOf(response: Response): Promise<unknown> {
	const body: unknown = await response.json();
	return body !== null && typeof body === "object" && "reason" in body ? body.reason : undefined;
}

const document = makeDocument(REPO, "docs/a.md", "# A\nthe first document");
const ingestBody = { protocol: CORPUS_PROTOCOL, documents: [document], tombstones: [] };

function unwritableAuditPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "substrate-corpus-"));
	writeFileSync(join(directory, "not-a-directory"), "");
	return join(directory, "not-a-directory", "mcp-audit.jsonl");
}

describe("the corpus routes while SUBSTRATE_CORPUS is off", () => {
	test("every route answers 503 corpus.disabled and nothing reaches the plane or the manifest", async () => {
		const harness = await start({ SUBSTRATE_TOKEN_OMP: "tok-omp" });
		const ingest = await post(harness, "/corpus/ingest", ingestBody);
		const plan = await post(harness, "/corpus/plan", { protocol: CORPUS_PROTOCOL, entries: [], scope: { coverage: [{ repo: REPO, source: "fs" }], maxTier: 3 } });
		const status = await fetch(`${harness.base}/corpus/status`, { headers: AUTH });
		expect([ingest.status, plan.status, status.status]).toEqual([503, 503, 503]);
		expect(await reasonOf(ingest)).toBe("corpus.disabled");
		expect(harness.plane.batches).toEqual([]);
		expect(harness.plane.deletes).toEqual([]);
		expect(harness.store.rows.size).toBe(0);
	});
});

describe("the corpus gates", () => {
	test("an anonymous caller is refused 401 before the body is read", async () => {
		const harness = await start(ON);
		expect((await post(harness, "/corpus/ingest", "{ not json", ANON)).status).toBe(401);
		expect((await post(harness, "/corpus/plan", ingestBody, ANON)).status).toBe(401);
		expect((await fetch(`${harness.base}/corpus/status`)).status).toBe(401);
		expect(harness.plane.batches).toEqual([]);
	});

	test("a VM guest is refused 403", async () => {
		const harness = await start({ ...ON, SUBSTRATE_VM_GUEST: "1" });
		const response = await post(harness, "/corpus/ingest", ingestBody);
		expect(response.status).toBe(403);
		expect(await reasonOf(response)).toBe("vm-guest");
		expect(harness.plane.batches).toEqual([]);
	});

	test("an authenticated surface that is not an operator is refused 403 operator-required before anything is sent", async () => {
		const harness = await start({ ...ON, SUBSTRATE_TOKEN_CLAUDE_CODE: "tok-claude" });
		const response = await post(harness, "/corpus/ingest", ingestBody, { authorization: "Bearer tok-claude", "content-type": "application/json" });
		expect(response.status).toBe(403);
		expect(await reasonOf(response)).toBe("operator-required");
		expect(harness.plane.batches).toEqual([]);
		expect(harness.store.rows.size).toBe(0);
	});

	test("with no LightRAG bulk plane the ingest answers 503 corpus.backend-unavailable and the manifest stays empty", async () => {
		const harness = await start(ON, { plane: false });
		const response = await post(harness, "/corpus/ingest", ingestBody);
		expect(response.status).toBe(503);
		expect(await reasonOf(response)).toBe("corpus.backend-unavailable");
		expect(harness.store.rows.size).toBe(0);
	});

	test("a body over the 6,000,000-byte cap is refused 413 and nothing is sent", async () => {
		const harness = await start(ON);
		const oversized = JSON.stringify({ protocol: CORPUS_PROTOCOL, documents: [], tombstones: [], padding: "x".repeat(6_100_000) });
		expect((await post(harness, "/corpus/ingest", oversized)).status).toBe(413);
		expect((await post(harness, "/corpus/plan", oversized)).status).toBe(413);
		expect(harness.plane.batches).toEqual([]);
	});

	test("a body that is not JSON is 400; a request the parser refuses is 400 with its closed reason", async () => {
		const harness = await start(ON);
		expect((await post(harness, "/corpus/ingest", "{ not json")).status).toBe(400);
		const badProtocol = await post(harness, "/corpus/ingest", { ...ingestBody, protocol: 99 });
		expect(badProtocol.status).toBe(400);
		expect(await reasonOf(badProtocol)).toBe("bad-protocol");
		const empty = await post(harness, "/corpus/ingest", { protocol: CORPUS_PROTOCOL, documents: [], tombstones: [] });
		expect(await reasonOf(empty)).toBe("empty-request");
		expect(harness.plane.batches).toEqual([]);
	});
});

describe("POST /corpus/ingest", () => {
	test("a document reaches the plane under its corpus name, is recorded, and a second identical request sends nothing", async () => {
		const harness = await start(ON);
		const first = await post(harness, "/corpus/ingest", ingestBody);
		expect(first.status).toBe(200);
		const body = (await first.json()) as { results: Array<{ status: string }>; counts: Record<string, number>; manifestVersion: number };
		expect(body.counts).toMatchObject({ ingested: 1, refused: 0, failed: 0 });
		expect(harness.plane.documents.size).toBe(1);
		expect(harness.store.row(REPO, "docs/a.md")?.sha256).toBe(document.sha256);
		expect(body.manifestVersion).toBeGreaterThan(0);
		const batches = harness.plane.batches.length;
		const second = (await (await post(harness, "/corpus/ingest", ingestBody)).json()) as { counts: Record<string, number> };
		expect(second.counts).toMatchObject({ ingested: 0, unchanged: 1 });
		expect(harness.plane.batches.length).toBe(batches);
	});

	test("the audit record is written under corpus_ingest with counts only, never a body", async () => {
		const harness = await start(ON);
		await post(harness, "/corpus/ingest", ingestBody);
		const record = defined(harness.observability.audit.recent().find((entry) => entry.tool === "corpus_ingest"), "the corpus_ingest audit record");
		expect(record.decision).toBe("allowed");
		expect(JSON.stringify(record)).not.toContain("the first document");
	});

	test("an audit chain that cannot take the record refuses the ingest and sends nothing (fail-closed)", async () => {
		const harness = await start({ ...ON, SUBSTRATE_AUDIT_PATH: unwritableAuditPath() });
		const response = await post(harness, "/corpus/ingest", ingestBody);
		expect(response.status).toBe(503);
		expect(harness.plane.batches).toEqual([]);
		expect(harness.store.rows.size).toBe(0);
	});

	test("a tombstone-only request (no documents) is accepted and removes the row", async () => {
		const harness = await start(ON);
		harness.store.seed(makeRow({ repo: REPO, path: "docs/old.md", documentId: "doc-old" }));
		const response = await post(harness, "/corpus/ingest", { protocol: CORPUS_PROTOCOL, documents: [], tombstones: [{ repo: REPO, path: "docs/old.md" }] });
		expect(response.status).toBe(200);
		expect(((await response.json()) as { counts: Record<string, number> }).counts).toMatchObject({ tombstoned: 1 });
		expect(harness.plane.deletes).toEqual([["doc-old"]]);
	});

	test("a refused document is reported 200 with its reason and a tombstone removes a manifest row", async () => {
		const harness = await start(ON);
		harness.store.seed(makeRow({ repo: REPO, path: "docs/old.md", documentId: "doc-old" }));
		const response = await post(harness, "/corpus/ingest", {
			protocol: CORPUS_PROTOCOL,
			documents: [{ ...document, sha256: sha256Hex("not the body") }],
			tombstones: [{ repo: REPO, path: "docs/old.md" }],
		});
		const body = (await response.json()) as { results: Array<{ status: string; reason?: string }> };
		expect(response.status).toBe(200);
		expect(body.results).toMatchObject([{ status: "refused", reason: "sha-mismatch" }, { status: "tombstoned" }]);
		expect(harness.store.row(REPO, "docs/old.md")?.state).toBe("tombstoned");
	});
});

describe("POST /corpus/plan and GET /corpus/status", () => {
	const scope = { coverage: [{ repo: REPO, source: "fs" }], maxTier: 3 };

	test("a plan counts add, change, rename and tombstone against the manifest and writes nothing", async () => {
		const harness = await start(ON);
		harness.store.seed(makeRow({ repo: REPO, path: "docs/edited.md", sha256: sha256Hex("before") }));
		harness.store.seed(makeRow({ repo: REPO, path: "docs/gone.md", sha256: sha256Hex("gone") }));
		harness.store.seed(makeRow({ repo: REPO, path: "docs/old-name.md", sha256: sha256Hex("moved") }));
		const entries = [makeDocument(REPO, "docs/new.md", "new"), makeDocument(REPO, "docs/edited.md", "after"), makeDocument(REPO, "docs/new-name.md", "moved")].map(entryOf);
		const before = harness.store.rows.size;
		const response = await post(harness, "/corpus/plan", { protocol: CORPUS_PROTOCOL, entries, scope });
		const body = (await response.json()) as { counts: Record<string, number>; items: Array<{ action: string; renamedFrom?: string }> };
		expect(response.status).toBe(200);
		expect(body.counts).toEqual({ add: 1, change: 1, update: 0, rename: 1, tombstone: 1, unchanged: 0 });
		expect(body.items.find((item) => item.action === "rename")?.renamedFrom).toBe("docs/old-name.md");
		expect(harness.store.rows.size).toBe(before);
		expect(harness.plane.batches).toEqual([]);
	});

	test("an empty coverage is a valid plan, an unknown protocol and a malformed coverage are refused 400 with their reasons", async () => {
		const harness = await start(ON);
		const empty = await post(harness, "/corpus/plan", { protocol: CORPUS_PROTOCOL, entries: [entryOf(document)], scope: { ...scope, coverage: [] } });
		expect(empty.status).toBe(200);
		expect(((await empty.json()) as { counts: Record<string, number> }).counts).toMatchObject({ add: 1, tombstone: 0 });
		expect(await reasonOf(await post(harness, "/corpus/plan", { protocol: CORPUS_PROTOCOL, entries: [], scope: { ...scope, coverage: [{ repo: REPO }] } }))).toBe("bad-source");
		expect(await reasonOf(await post(harness, "/corpus/plan", { protocol: 2, entries: [], scope }))).toBe("bad-protocol");
		const entry = entryOf(document);
		const response = await post(harness, "/corpus/plan", { protocol: CORPUS_PROTOCOL, entries: Array.from({ length: 20_001 }, () => entry), scope });
		expect(response.status === 400 || response.status === 413).toBe(true);
	});

	test("a plan and a status are fail-open: an audit chain that cannot take the record does not refuse them", async () => {
		const harness = await start({ ...ON, SUBSTRATE_AUDIT_PATH: unwritableAuditPath() });
		const plan = await post(harness, "/corpus/plan", { protocol: CORPUS_PROTOCOL, entries: [], scope });
		const status = await fetch(`${harness.base}/corpus/status`, { headers: AUTH });
		expect([plan.status, status.status]).toEqual([200, 200]);
	});

	test("status reports the manifest's counts and version", async () => {
		const harness = await start(ON);
		harness.store.seed(makeRow({ repo: REPO, path: "docs/a.md" }));
		harness.store.seed(makeRow({ repo: REPO, path: "docs/b.md", state: "tombstoned" }));
		const response = await fetch(`${harness.base}/corpus/status`, { headers: AUTH });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ protocol: CORPUS_PROTOCOL, total: 2, active: 1, tombstoned: 1, manifestVersion: 2 });
	});
});

describe("POST /corpus/reconcile", () => {
	const dry = { protocol: CORPUS_PROTOCOL, execute: false };
	const execute = { protocol: CORPUS_PROTOCOL, execute: true };

	interface ReconcileBody {
		drift: { missingInPlane: unknown[]; orphansInPlane: string[]; checked: number; truncated: boolean };
		repaired: { requeued: number; deleted: number };
	}

	/** The server's own reply; the assertions that follow pin its shape. */
	async function bodyOf(response: Response): Promise<ReconcileBody> {
		const body = (await response.json()) as ReconcileBody;
		return body;
	}

	/** A harness whose manifest and plane agreed about one document, which the plane then lost, and which gained a stray `corpus:` document. */
	async function drifted() {
		const harness = await start(ON);
		await post(harness, "/corpus/ingest", ingestBody);
		harness.plane.vanish(corpusDocumentName(document.repo, document.path, document.sha256, document));
		const orphan = corpusDocumentName(REPO, "docs/stray.md", sha256Hex("stray"));
		const orphanId = harness.plane.plant(orphan);
		return { harness, orphan, orphanId };
	}

	test("while SUBSTRATE_CORPUS is off it answers 503 corpus.disabled and lists nothing", async () => {
		const harness = await start({ SUBSTRATE_TOKEN_OMP: "tok-omp" });
		const response = await post(harness, "/corpus/reconcile", execute);
		expect(response.status).toBe(503);
		expect(await reasonOf(response)).toBe("corpus.disabled");
		expect(harness.plane.calls).toEqual([]);
	});

	test("an anonymous caller is refused 401 before the body is read; a VM guest 403; no LightRAG plane 503 corpus.backend-unavailable", async () => {
		const harness = await start(ON);
		expect((await post(harness, "/corpus/reconcile", "{ not json", ANON)).status).toBe(401);
		expect(harness.plane.calls).toEqual([]);
		const guest = await start({ ...ON, SUBSTRATE_VM_GUEST: "1" });
		expect((await post(guest, "/corpus/reconcile", execute)).status).toBe(403);
		const bare = await start(ON, { plane: false });
		const refused = await post(bare, "/corpus/reconcile", dry);
		expect(refused.status).toBe(503);
		expect(await reasonOf(refused)).toBe("corpus.backend-unavailable");
	});

	test("a dry run reports the drift, repairs nothing, and is audited as a read under corpus_status", async () => {
		const { harness, orphan } = await drifted();
		const response = await post(harness, "/corpus/reconcile", dry);
		expect(response.status).toBe(200);
		const body = await bodyOf(response);
		expect(body.drift).toEqual({ missingInPlane: [{ repo: REPO, path: "docs/a.md" }], orphansInPlane: [orphan], checked: 1, truncated: false });
		expect(body.repaired).toEqual({ requeued: 0, deleted: 0 });
		expect(harness.store.row(REPO, "docs/a.md")?.state).toBe("active");
		expect(harness.plane.deletes).toEqual([]);
		const record = defined(harness.observability.audit.recent().find((entry) => entry.tool === "corpus_status"), "the corpus_status audit record");
		expect(record.decision).toBe("allowed");
	});

	test("execute repairs the row and the orphan, is audited under corpus_ingest, and the repaired row is offered by the next plan as an add", async () => {
		const { harness, orphanId } = await drifted();
		const response = await post(harness, "/corpus/reconcile", execute);
		expect(response.status).toBe(200);
		expect((await bodyOf(response)).repaired).toEqual({ requeued: 1, deleted: 1 });
		expect(harness.store.row(REPO, "docs/a.md")?.state).toBe("tombstoned");
		expect(harness.plane.deletes).toEqual([[orphanId]]);
		expect(harness.observability.audit.recent().some((entry) => entry.tool === "corpus_ingest")).toBe(true);
		const plan = await post(harness, "/corpus/plan", { protocol: CORPUS_PROTOCOL, entries: [entryOf(document)], scope: { coverage: [{ repo: REPO, source: "fs" }], maxTier: 3 } });
		const planned = (await plan.json()) as { counts: Record<string, number> };
		expect(planned.counts).toMatchObject({ add: 1 });
	});

	test("a plane that cannot list is 503 corpus.plane-unreachable and nothing is changed", async () => {
		const { harness } = await drifted();
		harness.plane.listFailure = "timeout";
		const response = await post(harness, "/corpus/reconcile", execute);
		expect(response.status).toBe(503);
		expect(await reasonOf(response)).toBe("corpus.plane-unreachable");
		expect(harness.store.row(REPO, "docs/a.md")?.state).toBe("active");
		expect(harness.plane.deletes).toEqual([]);
	});

	test("an audit chain that cannot take the record refuses execute and changes nothing (fail-closed), while a dry run still answers (fail-open)", async () => {
		const harness = await start({ ...ON, SUBSTRATE_AUDIT_PATH: unwritableAuditPath() });
		await harness.store.recordIngested({ repo: REPO, path: "docs/a.md", kind: "doc", tier: 1, sha256: document.sha256, bytes: document.bytes, source: "fs", documentId: "doc-gone" });
		expect((await post(harness, "/corpus/reconcile", dry)).status).toBe(200);
		expect((await post(harness, "/corpus/reconcile", execute)).status).toBe(503);
		expect(harness.store.row(REPO, "docs/a.md")?.state).toBe("active");
	});

	test("a body that is not a reconcile request is refused 400 with its closed reason, and a body past its small cap is 413", async () => {
		const harness = await start(ON);
		expect(await reasonOf(await post(harness, "/corpus/reconcile", { protocol: 2, execute: false }))).toBe("bad-protocol");
		expect(await reasonOf(await post(harness, "/corpus/reconcile", { protocol: CORPUS_PROTOCOL, execute: "yes" }))).toBe("bad-request");
		expect((await post(harness, "/corpus/reconcile", JSON.stringify({ ...dry, padding: "x".repeat(5000) }))).status).toBe(413);
		expect(harness.plane.calls).toEqual([]);
	});
});

describe("GET /corpus/status lag", () => {
	test("lagSeconds is the age of the newest manifest write, null for an empty manifest", async () => {
		const harness = await start(ON);
		const empty = (await (await fetch(`${harness.base}/corpus/status`, { headers: AUTH })).json()) as { lagSeconds: number | null };
		expect(empty.lagSeconds).toBeNull();
		harness.store.newestChangeAt = new Date(Date.now() - 90_000).toISOString();
		const aged = (await (await fetch(`${harness.base}/corpus/status`, { headers: AUTH })).json()) as { lagSeconds: number | null };
		expect(aged.lagSeconds).toBeGreaterThanOrEqual(90);
		expect(aged.lagSeconds).toBeLessThan(120);
	});
});

interface NeardupReply {
	protocol: number;
	model: string | null;
	dimension: number | null;
	compared: number;
	pairs: Array<{ a: { repo: string; path: string }; b: { repo: string; path: string }; similarity: number }>;
	truncated: boolean;
	skipped: Array<{ repo: string; path: string; reason: string }>;
}

/** A TEI that answers `/info` and `/embed` from a table of vectors by text, and records every path it was asked for. */
function teiFake(vectors: Record<string, number[]>, model = "test-model"): { fetch: TeiFetch; paths: string[] } {
	const paths: string[] = [];
	const fetchImpl: TeiFetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		paths.push(path);
		if (path === "/info") return Response.json({ model_id: model, max_input_length: 512, max_client_batch_size: 32 });
		if (path === "/embed") {
			const body: unknown = JSON.parse(String(init?.body));
			const inputs = typeof body === "object" && body !== null && "inputs" in body && Array.isArray(body.inputs) ? body.inputs : [];
			return Response.json(inputs.map((text) => vectors[String(text)] ?? [0, 0, 1]));
		}
		return new Response("", { status: 404 });
	};
	return { fetch: fetchImpl, paths };
}

describe("POST /corpus/neardup", () => {
	const TEI_ON = { ...ON, TEI_URL: "http://127.0.0.1:8080" };
	const items = [
		{ repo: REPO, path: "docs/a.md", text: "alpha excerpt" },
		{ repo: REPO, path: "docs/b.md", text: "beta excerpt" },
		{ repo: REPO, path: "docs/c.md", text: "gamma excerpt" },
	];
	const vectors = { "alpha excerpt": [1, 0, 0], "beta excerpt": [1, 0, 0], "gamma excerpt": [0, 1, 0] };
	const request = { protocol: CORPUS_PROTOCOL, items };

	test("embeds the excerpts through the service and answers the similar pair, reading no manifest and sending nothing to the plane", async () => {
		const tei = teiFake(vectors);
		const harness = await start(TEI_ON, { teiFetch: tei.fetch });
		const response = await post(harness, "/corpus/neardup", request);
		expect(response.status).toBe(200);
		const text = await response.text();
		const body = JSON.parse(text) as NeardupReply;
		expect(body).toMatchObject({ protocol: CORPUS_PROTOCOL, model: "test-model", dimension: 3, compared: 3, truncated: false, skipped: [] });
		expect(body.pairs).toEqual([{ a: { repo: REPO, path: "docs/a.md" }, b: { repo: REPO, path: "docs/b.md" }, similarity: 1 }]);
		expect(text).not.toContain("excerpt");
		expect(tei.paths.filter((path) => path === "/embed")).toHaveLength(1);
		expect(harness.store.rows.size).toBe(0);
		expect(harness.plane.batches).toEqual([]);
	});

	test("an anonymous caller is refused 401 and with the corpus off the answer is 503 corpus.disabled, and TEI is never asked", async () => {
		const tei = teiFake(vectors);
		const on = await start(TEI_ON, { teiFetch: tei.fetch });
		expect((await post(on, "/corpus/neardup", request, ANON)).status).toBe(401);
		const off = await start({ SUBSTRATE_TOKEN_OMP: "tok-omp", TEI_URL: "http://127.0.0.1:8080" }, { teiFetch: tei.fetch });
		const response = await post(off, "/corpus/neardup", request);
		expect(response.status).toBe(503);
		expect(await reasonOf(response)).toBe("corpus.disabled");
		expect(tei.paths).toEqual([]);
	});

	test("with TEI_URL unset the answer is 503 corpus.embeddings-unavailable (not-configured) and nothing is sent anywhere", async () => {
		const tei = teiFake(vectors);
		const harness = await start(ON, { teiFetch: tei.fetch });
		const response = await post(harness, "/corpus/neardup", request);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ reason: "corpus.embeddings-unavailable", detail: "not-configured" });
		expect(tei.paths).toEqual([]);
	});

	test("a TEI that names another model than the pinned one is 503 model-mismatch, and the reply holds no text and no TEI address", async () => {
		const tei = teiFake(vectors, "another-model");
		const harness = await start({ ...TEI_ON, SUBSTRATE_TEI_MODEL: "pinned-model" }, { teiFetch: tei.fetch });
		const response = await post(harness, "/corpus/neardup", request);
		expect(response.status).toBe(503);
		const text = await response.text();
		expect(JSON.parse(text)).toMatchObject({ reason: "corpus.embeddings-unavailable", detail: "model-mismatch" });
		expect(text).not.toContain("excerpt");
		expect(text).not.toContain("127.0.0.1:8080");
	});

	test("a refused request is 400 with its closed reason, a body that is not JSON is 415 or 400, and a body over the cap is 413", async () => {
		const tei = teiFake(vectors);
		const harness = await start(TEI_ON, { teiFetch: tei.fetch });
		expect(await reasonOf(await post(harness, "/corpus/neardup", { ...request, threshold: 0.2 }))).toBe("bad-threshold");
		expect(await reasonOf(await post(harness, "/corpus/neardup", { protocol: 2, items }))).toBe("bad-protocol");
		expect((await post(harness, "/corpus/neardup", request, { ...AUTH, "content-type": "text/plain" })).status).toBe(415);
		expect((await post(harness, "/corpus/neardup", "{ not json")).status).toBe(400);
		const oversized = JSON.stringify({ ...request, padding: "x".repeat(19_000_000) });
		expect((await post(harness, "/corpus/neardup", oversized)).status).toBe(413);
		expect(tei.paths).toEqual([]);
	});

	test("the near-duplicate door is fail-open: an audit chain that cannot take the record does not refuse it", async () => {
		const tei = teiFake(vectors);
		const harness = await start({ ...TEI_ON, SUBSTRATE_AUDIT_PATH: unwritableAuditPath() }, { teiFetch: tei.fetch });
		expect((await post(harness, "/corpus/neardup", request)).status).toBe(200);
	});
});
