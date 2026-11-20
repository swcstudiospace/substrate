/**
 * `POST /docs/feedback`, `POST /corpus/reflect` and `GET /corpus/gaps` over a real socket, and the `docs_feedback` MCP tool,
 * with a fake manifest, a fake LightRAG bulk plane and a fake feedback and telemetry store behind the service. What matters
 * here is the wiring the unit tests cannot see: the gates answer before anything is read or stored, each door audits the way
 * its twin does, one bad digest never fails the request, and the tool and the route have the same effect.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FAIL_CLOSED_TOOLS, FAIL_OPEN_TOOLS, auditMode } from "@substrate/audit";
import { CORPUS_PROTOCOL, DEFAULT_GAPS_LIMIT, DIGEST_PATH, MAX_DIGEST_CHARS, MAX_GAPS_LIMIT, MAX_REFLECT_DIGESTS, corpusDocumentName, documentKey } from "@substrate/corpus";
import { TOOL_CLASSES } from "../admission.ts";
import { loadConfig } from "../config.ts";
import { createMcpServer } from "../mcp.ts";
import { createObservability, type Observability } from "../observe.ts";
import { createHttpServer } from "../server.ts";
import { Substrate } from "../service.ts";
import { defined } from "../test-support.ts";
import type { Surface } from "../types.ts";
import type { RetrievalRow } from "./reflect-store.ts";
import { FakeReflectStore } from "./reflect-testkit.ts";
import type { ManifestRow } from "./store.ts";
import { FakePlane, FakeStore, makeRow, sha256Hex } from "./testkit.ts";

const REPO = "swcstudiospace/agent-substrate";
const DOC = documentKey(REPO, "docs/a.md");
const AUTH = { authorization: "Bearer tok-omp", "content-type": "application/json" };
const ANON = { "content-type": "application/json" };
const ON = { SUBSTRATE_TOKEN_OMP: "tok-omp", SUBSTRATE_CORPUS: "on" };
const DAY_MS = 86_400_000;
const BASE = Date.parse("2026-06-01T00:00:00.000Z");

interface Harness {
	base: string;
	observability: Observability;
	substrate: Substrate;
	store: FakeStore;
	plane: FakePlane;
	reflect: FakeReflectStore;
	clock: { now: number };
	close(): void;
}

const running: Harness[] = [];

async function start(env: Record<string, string | undefined>, options: { plane?: boolean } = {}): Promise<Harness> {
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const store = new FakeStore();
	const plane = new FakePlane();
	const clock = { now: BASE };
	const reflect = new FakeReflectStore(() => clock.now);
	const substrate = new Substrate(config, { index: null, greptime: null, corpus: { store, ...(options.plane === false ? {} : { plane }) }, reflect }, observability.observer);
	const server = createHttpServer(substrate, config, observability);
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const { port } = server.address() as AddressInfo;
	let closed = false;
	const harness: Harness = {
		base: `http://127.0.0.1:${port}`,
		observability,
		substrate,
		store,
		plane,
		reflect,
		clock,
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

function get(harness: Harness, path: string, headers: Record<string, string> = AUTH): Promise<Response> {
	return fetch(`${harness.base}${path}`, { headers });
}

async function reasonOf(response: Response): Promise<unknown> {
	const body: unknown = await response.json();
	return body !== null && typeof body === "object" && "reason" in body ? body.reason : undefined;
}

function unwritableAuditPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "substrate-reflect-"));
	writeFileSync(join(directory, "not-a-directory"), "");
	return join(directory, "not-a-directory", "mcp-audit.jsonl");
}

function seedDocument(harness: Harness, path = "docs/a.md", over: Partial<ManifestRow> = {}): void {
	harness.store.seed(makeRow({ repo: REPO, path, ...over }));
}

/** The verdicts a harness holds, without their times: one entry per (document, session). */
function verdictsOf(harness: Harness): Array<{ documentKey: string; sessionId: string; verdict: string; surface: string }> {
	return [...harness.reflect.feedback.values()].map(({ documentKey: held, sessionId, verdict, surface }) => ({ documentKey: held, sessionId, verdict, surface }));
}

describe("POST /docs/feedback", () => {
	test("an anonymous caller is refused 401 before the body is read, and nothing is stored", async () => {
		const harness = await start(ON);
		seedDocument(harness);
		const response = await post(harness, "/docs/feedback", "{ not json", ANON);
		expect(response.status).toBe(401);
		expect((await post(harness, "/docs/feedback", { document: DOC, verdict: "helpful" }, ANON)).status).toBe(401);
		expect(harness.reflect.feedback.size).toBe(0);
	});

	test("with the corpus off it answers 503 corpus.disabled and stores nothing", async () => {
		const harness = await start({ SUBSTRATE_TOKEN_OMP: "tok-omp" });
		seedDocument(harness);
		const response = await post(harness, "/docs/feedback", { document: DOC, verdict: "helpful" });
		expect(response.status).toBe(503);
		expect(await reasonOf(response)).toBe("corpus.disabled");
		expect(harness.reflect.feedback.size).toBe(0);
	});

	test("a document the manifest does not hold as active answers unknown-document and stores nothing", async () => {
		const harness = await start(ON);
		seedDocument(harness, "docs/gone.md", { state: "tombstoned" });
		const never = await post(harness, "/docs/feedback", { document: DOC, verdict: "helpful" });
		expect(never.status).toBe(404);
		expect(await reasonOf(never)).toBe("unknown-document");
		const gone = await post(harness, "/docs/feedback", { document: documentKey(REPO, "docs/gone.md"), verdict: "helpful" });
		expect(await reasonOf(gone)).toBe("unknown-document");
		expect(harness.reflect.feedback.size).toBe(0);
	});

	test("a verdict is stored once per session and document, the latest wins, and another session adds its own", async () => {
		const harness = await start(ON);
		seedDocument(harness);
		const first = await post(harness, "/docs/feedback", { document: DOC, verdict: "stale", session_id: "s1" });
		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ protocol: CORPUS_PROTOCOL, document: DOC, verdict: "stale", stored: true });
		expect(verdictsOf(harness)).toEqual([{ documentKey: DOC, sessionId: "omp/s1", verdict: "stale", surface: "omp" }]);

		await post(harness, "/docs/feedback", { document: DOC, verdict: "helpful", session_id: "s1" });
		expect(verdictsOf(harness)).toEqual([{ documentKey: DOC, sessionId: "omp/s1", verdict: "helpful", surface: "omp" }]);

		await post(harness, "/docs/feedback", { document: DOC, verdict: "wrong", session_id: "s2" });
		expect(verdictsOf(harness).map((entry) => [entry.sessionId, entry.verdict])).toEqual([
			["omp/s1", "helpful"],
			["omp/s2", "wrong"],
		]);
	});

	test("an invalid verdict, a bad document key and a body that is not JSON are refused 400 and nothing is stored", async () => {
		const harness = await start(ON);
		seedDocument(harness);
		const verdict = await post(harness, "/docs/feedback", { document: DOC, verdict: "great" });
		expect(verdict.status).toBe(400);
		expect(await reasonOf(verdict)).toBe("bad-verdict");
		const document = await post(harness, "/docs/feedback", { document: "no-colon", verdict: "helpful" });
		expect(document.status).toBe(400);
		expect(await reasonOf(document)).toBe("bad-document");
		expect((await post(harness, "/docs/feedback", "{ not json")).status).toBe(400);
		expect(harness.reflect.feedback.size).toBe(0);
	});

	test("the audit record is written under docs_feedback with the document and the verdict, never the note", async () => {
		const harness = await start(ON);
		seedDocument(harness);
		await post(harness, "/docs/feedback", { document: DOC, verdict: "helpful", note: "a private remark" });
		const record = defined(harness.observability.audit.recent().find((entry) => entry.tool === "docs_feedback"), "the docs_feedback audit record");
		expect(record.decision).toBe("allowed");
		expect(JSON.stringify(record)).not.toContain("a private remark");
	});

	test("a verdict is fail-open: an audit chain that cannot take the record does not refuse it", async () => {
		const harness = await start({ ...ON, SUBSTRATE_AUDIT_PATH: unwritableAuditPath() });
		seedDocument(harness);
		const response = await post(harness, "/docs/feedback", { document: DOC, verdict: "helpful" });
		expect(response.status).toBe(200);
		expect(harness.reflect.feedback.size).toBe(1);
	});
});

describe("POST /corpus/reflect", () => {
	const text = "# agent-substrate\nMilestone v1.7, phase 66.\n- open: ship the docs reflect";
	const digest = { repo: REPO, text, sha256: sha256Hex(text) };
	const request = (...digests: unknown[]) => ({ protocol: CORPUS_PROTOCOL, digests });
	interface Reflected {
		results: Array<{ repo: string; status: string; reason?: string }>;
		manifestVersion: number;
	}

	test("an anonymous caller is refused 401 before the body is read", async () => {
		const harness = await start(ON);
		expect((await post(harness, "/corpus/reflect", "{ not json", ANON)).status).toBe(401);
		expect(harness.plane.batches).toEqual([]);
	});

	test("with the corpus off it answers 503 corpus.disabled, and with no LightRAG bulk plane 503 corpus.backend-unavailable", async () => {
		const off = await start({ SUBSTRATE_TOKEN_OMP: "tok-omp" });
		const disabled = await post(off, "/corpus/reflect", request(digest));
		expect(disabled.status).toBe(503);
		expect(await reasonOf(disabled)).toBe("corpus.disabled");
		expect(off.plane.batches).toEqual([]);
		const bare = await start(ON, { plane: false });
		const noPlane = await post(bare, "/corpus/reflect", request(digest));
		expect(noPlane.status).toBe(503);
		expect(await reasonOf(noPlane)).toBe("corpus.backend-unavailable");
		expect(bare.store.rows.size).toBe(0);
	});

	test("a valid digest is stored as the corpus document and reported stored; the same digest again is unchanged and sends nothing, and its retain is owed again", async () => {
		const harness = await start(ON);
		const first = await post(harness, "/corpus/reflect", request(digest));
		expect(first.status).toBe(200);
		const body = (await first.json()) as Reflected;
		expect(body.results).toHaveLength(1);
		expect(body.results[0]).toMatchObject({ repo: REPO, status: "stored" });
		expect(body.manifestVersion).toBeGreaterThan(0);
		expect(harness.store.row(REPO, DIGEST_PATH)).toMatchObject({ kind: "digest", state: "active", sha256: digest.sha256 });
		expect(harness.plane.batches).toEqual([[corpusDocumentName(REPO, DIGEST_PATH, digest.sha256, { kind: "digest", tier: 1 })]]);

		// This server has no memory index, so the retain is still owed: the repeat reports it again instead of a bare unchanged.
		const again = (await (await post(harness, "/corpus/reflect", request(digest))).json()) as Reflected;
		expect(again.results).toEqual([{ repo: REPO, status: "unchanged", reason: "hindsight:store.unavailable" }]);
		expect(harness.plane.batches).toHaveLength(1);
	});

	test("a Hindsight leg that cannot retain is the digest's reason, while its plane document stays stored", async () => {
		// This server has no memory index, so the governed retain is refused: the same per-digest report an outage gives.
		const harness = await start(ON);
		const body = (await (await post(harness, "/corpus/reflect", request(digest))).json()) as Reflected;
		expect(body.results).toEqual([{ repo: REPO, status: "stored", reason: "hindsight:store.unavailable" }]);
		expect(harness.plane.documents.size).toBe(1);
		expect(harness.store.row(REPO, DIGEST_PATH)?.state).toBe("active");
	});

	test("one bad digest never fails the others: too long, a wrong sha256 and a malformed one are each refused with a closed reason", async () => {
		const harness = await start(ON);
		const response = await post(
			harness,
			"/corpus/reflect",
			request(
				{ repo: "acme/too-long", text: "x".repeat(MAX_DIGEST_CHARS + 1), sha256: sha256Hex("x") },
				{ repo: "acme/wrong-hash", text, sha256: sha256Hex("not the text") },
				{ repo: "acme/malformed", text, sha256: "not-a-hash" },
				digest,
			),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as Reflected;
		expect(body.results.map((result) => [result.repo, result.status, result.reason])).toEqual([
			["acme/too-long", "refused", "too-large"],
			["acme/wrong-hash", "refused", "sha-mismatch"],
			["acme/malformed", "refused", "bad-sha256"],
			[REPO, "stored", "hindsight:store.unavailable"],
		]);
		expect(harness.plane.documents.size).toBe(1);
		expect(harness.store.rows.size).toBe(1);
	});

	test("a request the parser refuses is 400 with its closed reason and nothing is sent", async () => {
		const harness = await start(ON);
		const empty = await post(harness, "/corpus/reflect", request());
		expect(empty.status).toBe(400);
		expect(await reasonOf(empty)).toBe("empty-request");
		const tooMany = await post(harness, "/corpus/reflect", request(...Array.from({ length: MAX_REFLECT_DIGESTS + 1 }, (_, index) => ({ repo: `acme/r${index}`, text: "x", sha256: sha256Hex("x") }))));
		expect(tooMany.status).toBe(400);
		expect(await reasonOf(tooMany)).toBe("too-many-digests");
		expect(await reasonOf(await post(harness, "/corpus/reflect", { protocol: 99, digests: [digest] }))).toBe("bad-protocol");
		expect((await post(harness, "/corpus/reflect", "{ not json")).status).toBe(400);
		expect(harness.plane.batches).toEqual([]);
	});

	test("the audit record is written under corpus_ingest with the digest count only; an audit chain that cannot take it refuses the request (fail-closed)", async () => {
		const harness = await start(ON);
		await post(harness, "/corpus/reflect", request(digest));
		const record = defined(harness.observability.audit.recent().find((entry) => entry.tool === "corpus_ingest"), "the corpus_ingest audit record");
		expect(record.decision).toBe("allowed");
		expect(JSON.stringify(record)).not.toContain("Milestone v1.7");

		const closed = await start({ ...ON, SUBSTRATE_AUDIT_PATH: unwritableAuditPath() });
		const response = await post(closed, "/corpus/reflect", request(digest));
		expect(response.status).toBe(503);
		expect(closed.plane.batches).toEqual([]);
		expect(closed.store.rows.size).toBe(0);
	});
});

describe("GET /corpus/gaps", () => {
	const retrieval = (queryHash: string, topScore: number | null, over: Partial<RetrievalRow> = {}): RetrievalRow => ({
		surface: "omp",
		queryHash,
		queryText: `text of ${queryHash}`,
		backend: "lightrag",
		returned: [],
		topScore,
		returnedCount: topScore === null ? 0 : 1,
		degraded: false,
		rerank: null,
		...over,
	});
	interface Gaps {
		gaps: Array<{ queryHash: string; text: string | null; searches: number; best: number | null }>;
		truncated: boolean;
	}

	test("an anonymous caller is refused 401, and with the corpus off it answers 503 corpus.disabled", async () => {
		const harness = await start(ON);
		expect((await get(harness, "/corpus/gaps", ANON)).status).toBe(401);
		const off = await start({ SUBSTRATE_TOKEN_OMP: "tok-omp" });
		const disabled = await get(off, "/corpus/gaps");
		expect(disabled.status).toBe(503);
		expect(await reasonOf(disabled)).toBe("corpus.disabled");
	});

	test("a query is a gap when its best score over the 30 days is below the gap score; degraded searches and older searches do not count", async () => {
		const harness = await start({ ...ON, SUBSTRATE_DOCS_GAP_SCORE: "0.3" });
		// Outside the window by the time of the request: it never counts, not even for a query that is searched again.
		await harness.reflect.appendRetrieval(retrieval("ancient", null));
		await harness.reflect.appendRetrieval(retrieval("recurring", 0.9));
		harness.clock.now = BASE + 31 * DAY_MS;
		for (const row of [
			retrieval("none", null),
			retrieval("none", null),
			retrieval("none", null),
			retrieval("low", 0.1),
			retrieval("low", 0.15),
			retrieval("edge", 0.3),
			retrieval("mixed", 0.1),
			retrieval("mixed", 0.5),
			retrieval("good", 0.9),
			retrieval("down", null, { degraded: true, returnedCount: 0 }),
			retrieval("recurring", 0.1),
		]) {
			await harness.reflect.appendRetrieval(row);
		}
		const response = await get(harness, "/corpus/gaps");
		expect(response.status).toBe(200);
		const body = (await response.json()) as Gaps;
		expect(body.gaps.map((gap) => ({ hash: gap.queryHash, searches: gap.searches, best: gap.best }))).toEqual([
			{ hash: "none", searches: 3, best: null },
			{ hash: "low", searches: 2, best: 0.15 },
			{ hash: "recurring", searches: 1, best: 0.1 },
		]);
		expect(defined(body.gaps[0], "the first gap").text).toBe("text of none");
		expect(body.truncated).toBe(false);
	});

	test("limit is clamped to the documented range: more than the maximum answers the maximum, none or junk answers the default", async () => {
		const harness = await start(ON);
		for (let index = 0; index < MAX_GAPS_LIMIT + 5; index += 1) await harness.reflect.appendRetrieval(retrieval(`gap-${index}`, null));
		const lengthOf = async (query: string): Promise<{ length: number; truncated: boolean }> => {
			const body = (await (await get(harness, `/corpus/gaps${query}`)).json()) as Gaps;
			return { length: body.gaps.length, truncated: body.truncated };
		};
		expect(await lengthOf("?limit=100000")).toEqual({ length: MAX_GAPS_LIMIT, truncated: true });
		expect(await lengthOf("?limit=0")).toEqual({ length: 1, truncated: true });
		expect(await lengthOf("")).toEqual({ length: DEFAULT_GAPS_LIMIT, truncated: true });
		expect(await lengthOf("?limit=lots")).toEqual({ length: DEFAULT_GAPS_LIMIT, truncated: true });
		expect(await lengthOf("?limit=3")).toEqual({ length: 3, truncated: true });
	});

	test("a store that fails is 503 corpus.index-unavailable, and the report is fail-open on the audit chain", async () => {
		const failing = await start(ON);
		failing.reflect.gaps = async () => {
			throw new Error("connection lost");
		};
		const refused = await get(failing, "/corpus/gaps");
		expect(refused.status).toBe(503);
		expect(await reasonOf(refused)).toBe("corpus.index-unavailable");
		const unaudited = await start({ ...ON, SUBSTRATE_AUDIT_PATH: unwritableAuditPath() });
		expect((await get(unaudited, "/corpus/gaps")).status).toBe(200);
	});
});

describe("the docs_feedback MCP tool", () => {
	async function connect(substrate: Substrate, caller: Surface | null): Promise<{ client: Client; close: () => Promise<void> }> {
		const server = createMcpServer(substrate, caller);
		const client = new Client({ name: "substrate-test", version: "0.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		return {
			client,
			close: async () => {
				await client.close();
				await server.close();
			},
		};
	}

	async function call(client: Client, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> {
		const result = await client.callTool({ name: "docs_feedback", arguments: args });
		const content = result.content as Array<{ type: string; text?: string }>;
		return { isError: result.isError === true, body: JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown> };
	}

	test("it is registered, a write in admission, and fail-open in the audit policy", async () => {
		expect(TOOL_CLASSES.docs_feedback).toBe("write");
		expect(FAIL_OPEN_TOOLS.has("docs_feedback")).toBe(true);
		expect(FAIL_CLOSED_TOOLS.has("docs_feedback")).toBe(false);
		expect(auditMode("docs_feedback")).toBe("fail-open");
		const harness = await start(ON);
		const { client, close } = await connect(harness.substrate, "omp");
		try {
			expect((await client.listTools()).tools.some((tool) => tool.name === "docs_feedback")).toBe(true);
		} finally {
			await close();
		}
	});

	test("an anonymous caller is refused and nothing is stored", async () => {
		const harness = await start(ON);
		seedDocument(harness);
		const { client, close } = await connect(harness.substrate, null);
		try {
			const refused = await call(client, { document: DOC, verdict: "helpful" });
			expect(refused.isError).toBe(true);
			expect(refused.body.reason).toBe("unauthenticated");
		} finally {
			await close();
		}
		expect(harness.reflect.feedback.size).toBe(0);
	});

	test("it has the effect the route has: the same answer, the same stored verdict, the latest verdict wins", async () => {
		const viaRoute = await start(ON);
		const viaTool = await start(ON);
		seedDocument(viaRoute);
		seedDocument(viaTool);
		const args = { document: DOC, verdict: "stale", session_id: "s1" };
		const routeBody: unknown = await (await post(viaRoute, "/docs/feedback", args)).json();
		const { client, close } = await connect(viaTool.substrate, "omp");
		try {
			const first = await call(client, args);
			expect(first.isError).toBe(false);
			expect(first.body).toEqual(routeBody as Record<string, unknown>);
			expect(verdictsOf(viaTool)).toEqual(verdictsOf(viaRoute));
			await call(client, { ...args, verdict: "helpful" });
			expect(verdictsOf(viaTool)).toEqual([{ documentKey: DOC, sessionId: "omp/s1", verdict: "helpful", surface: "omp" }]);
		} finally {
			await close();
		}
	});

	test("a document the manifest does not hold is an error result with unknown-document, and nothing is stored", async () => {
		const harness = await start(ON);
		const { client, close } = await connect(harness.substrate, "omp");
		try {
			const refused = await call(client, { document: DOC, verdict: "helpful" });
			expect(refused.isError).toBe(true);
			expect(refused.body.reason).toBe("unknown-document");
		} finally {
			await close();
		}
		expect(harness.reflect.feedback.size).toBe(0);
	});
});
