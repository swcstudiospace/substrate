/**
 * `POST /corpus/plan`, `POST /corpus/ingest` and `GET /corpus/status` over a real socket, with a fake manifest and a fake
 * LightRAG bulk plane behind the service. What matters here is the wiring the unit tests cannot see: the gates answer before
 * anything is read or sent, the body cap and the audit are the docs routes', and the happy path reaches the plane.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORPUS_PROTOCOL } from "@substrate/corpus";
import { loadConfig } from "../config.ts";
import { createObservability, type Observability } from "../observe.ts";
import { createHttpServer } from "../server.ts";
import { Substrate } from "../service.ts";
import { defined } from "../test-support.ts";
import { FakePlane, FakeStore, entryOf, makeDocument, makeRow, sha256Hex } from "./testkit.ts";

const REPO = "swcstudiospace/agent-substrate";
const AUTH = { authorization: "Bearer tok-omp", "content-type": "application/json" };
const ANON = { "content-type": "application/json" };
const ON = { SUBSTRATE_TOKEN_OMP: "tok-omp", SUBSTRATE_CORPUS: "on" };

interface Harness {
	base: string;
	observability: Observability;
	store: FakeStore;
	plane: FakePlane;
	close(): void;
}

const running: Harness[] = [];

async function start(env: Record<string, string | undefined>, options: { plane?: boolean } = {}): Promise<Harness> {
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const store = new FakeStore();
	const plane = new FakePlane();
	const substrate = new Substrate(config, { index: null, greptime: null, corpus: { store, ...(options.plane === false ? {} : { plane }) } }, observability.observer);
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
		const plan = await post(harness, "/corpus/plan", { protocol: CORPUS_PROTOCOL, entries: [], scope: { repos: [REPO], maxTier: 3, sources: ["fs"] } });
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
	const scope = { repos: [REPO], maxTier: 3, sources: ["fs"] };

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
		expect(body.counts).toEqual({ add: 1, change: 1, rename: 1, tombstone: 1, unchanged: 0 });
		expect(body.items.find((item) => item.action === "rename")?.renamedFrom).toBe("docs/old-name.md");
		expect(harness.store.rows.size).toBe(before);
		expect(harness.plane.batches).toEqual([]);
	});

	test("an empty scope, an unknown protocol and a plan too large are refused 400 with their reasons", async () => {
		const harness = await start(ON);
		expect(await reasonOf(await post(harness, "/corpus/plan", { protocol: CORPUS_PROTOCOL, entries: [], scope: { ...scope, repos: [] } }))).toBe("empty-scope");
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
