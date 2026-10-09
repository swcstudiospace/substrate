import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import type { EventQuery } from "./greptime.ts";
import { memoryToolWriter } from "./mcp.ts";
import { createObservability } from "./observe.ts";
import { createHttpServer, healthStatus, memoryWriteStatus, memoryWriter } from "./server.ts";
import { Substrate } from "./service.ts";
import type { SubstrateEvent } from "./types.ts";
import { mkdtemp, writeFile } from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearDatasetCache } from "./docs/registry.ts";
import {
	RagflowError,
	type RagflowDatasetSummary,
	type RagflowDocument,
	type RetrievalHit,
	type UploadFile,
	type UploadedDocument,
} from "./docs/ragflow.ts";

/** Shorthand for a health report; every field defaults to the unhealthy value. */
function health(over: Partial<Parameters<typeof healthStatus>[0]> = {}) {
	return { index: false, greptime: false, eventsWritable: false, ...over };
}

describe("healthStatus", () => {
	test("503 when a configured ledger cannot take writes, even with a healthy index", () => {
		// The regression: `eventsWritable || index` answered 200 here, so the one state
		// this hardening exists to catch — every append refused — looked healthy to a
		// monitor watching the status code.
		expect(healthStatus(health({ index: true, greptime: true, eventsWritable: false }), true)).toBe(503);
	});

	test("503 when the configured ledger is unreachable", () => {
		expect(healthStatus(health({ index: true }), true)).toBe(503);
	});

	test("200 once the ledger accepts writes", () => {
		expect(healthStatus(health({ greptime: true, eventsWritable: true }), true)).toBe(200);
		expect(healthStatus(health({ index: true, greptime: true, eventsWritable: true }), true)).toBe(200);
	});

	test("a run with no ledger configured is judged on its remaining stores", () => {
		// Local dev, or a deployment that deliberately has no ledger: an unwritable
		// ledger it never had must not fail it.
		expect(healthStatus(health({ index: true }), false)).toBe(200);
		expect(healthStatus(health(), false)).toBe(503);
	});
});

/**
 * The HTTP surface, against a real listener.
 *
 * Hooks and the CLI reach the substrate this way, so the routes are driven over a
 * socket rather than by calling the service: a route that is unregistered, reading
 * the wrong body field or answering the wrong status fails here. The ledger is a
 * stub — this is about the wiring.
 */
	/** A ledger stub that records appends and replies to reads with fixed rows. */
	function ledger(rows: Array<Record<string, unknown>> = []) {
		const written: SubstrateEvent[] = [];
		const queries: EventQuery[] = [];
		return {
			written,
			queries,
			greptime: {
				ping: async () => true,
				ensureAppendMode: async () => true,
				probeDialect: async () => true,
				quotingDialectKnown: true,
				lastHash: async () => null,
				insertEvent: async (event: SubstrateEvent) => {
					written.push(event);
				},
				queryEvents: async (query: EventQuery) => {
					queries.push(query);
					return rows;
				},
			},
		};
	}

	/**
	 * Boot the real server on an ephemeral port; `stop` closes it.
	 *
	 * The ledger is injected rather than built from the environment, so nothing here
	 * needs a Greptime endpoint in its config — `/events` and `/events/query` reach the
	 * store through the substrate, and only `/healthz` asks the config whether a ledger
	 * was configured at all.
	 */
	async function serve(greptime: unknown, env: Record<string, string | undefined> = {}, ragflow: unknown = null) {
		const config = loadConfig(env);
		// No SUBSTRATE_AUDIT_PATH in the env, so the audit chain stays in memory and the
		// exporter is off: these routes are audited, and a test that skipped the plane
		// entirely would not be running the code the server actually runs.
		const observability = createObservability(config, env);
		await observability.start();
		const substrate = new Substrate(
			config,
			{ index: null, greptime: greptime as never, ragflow: ragflow as never },
			observability.observer,
		);
		const server = createHttpServer(substrate, config, observability);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		return {
			post: (path: string, body: unknown, headers: Record<string, string> = {}) =>
				fetch(`http://127.0.0.1:${port}${path}`, {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body: JSON.stringify(body),
				}),
			postRaw: (path: string, rawBody: string, headers: Record<string, string> = {}) =>
				fetch(`http://127.0.0.1:${port}${path}`, {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body: rawBody,
				}),
			postBytes: (path: string, rawBody: Buffer, headers: Record<string, string> = {}) =>
				fetch(`http://127.0.0.1:${port}${path}`, {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body: rawBody,
				}),
			stop: () =>
				new Promise<void>((resolve) => {
					observability.stop();
					server.close(() => resolve());
				}),
		};
	}

describe("routes", () => {
	test("POST /events appends and answers 202", async () => {
		const { written, greptime } = ledger();
		const { post, stop } = await serve(greptime);
		try {
			const response = await post("/events", { kind: "commit", summary: "wired the read path", session_id: "s" });
			const body = (await response.json()) as Record<string, unknown>;

			expect(response.status).toBe(202);
			expect(body.stored).toBe(true);
			expect(written[0]?.summary).toBe("wired the read path");
		} finally {
			await stop();
		}
	});

	test("POST /events answers 503 when the ledger refused the row", async () => {
		const { greptime } = ledger();
		greptime.insertEvent = async () => {
			throw new Error("greptime unreachable: connect ETIMEDOUT");
		};
		const { post, stop } = await serve(greptime);
		try {
			const response = await post("/events", { kind: "note", summary: "still working" });

			// The surface owes its caller the truth about durability; the CLI exits 0 anyway.
			expect(response.status).toBe(503);
			expect(((await response.json()) as Record<string, unknown>).stored).toBe(false);
		} finally {
			await stop();
		}
	});

	test("POST /events/query reads the ledger back", async () => {
		const { queries, greptime } = ledger([
			{ ts: 1790186361859, id: "evt_1", surface: "omp", kind: "shell", summary: "ran bun test", hash: "h1" },
		]);
		const { post, stop } = await serve(greptime);
		try {
			const response = await post("/events/query", { repo: "swcstudiospace/agent-substrate", limit: 5 });
			const body = (await response.json()) as { count: number; events: Array<Record<string, unknown>> };

			expect(response.status).toBe(200);
			expect(body.count).toBe(1);
			expect(body.events[0]?.summary).toBe("ran bun test");
			expect(queries[0]?.limit).toBe(5);
		} finally {
			await stop();
		}
	});

	test("POST /events/query with no filters is a valid read, not a bad request", async () => {
		const { greptime } = ledger();
		const { post, stop } = await serve(greptime);
		try {
			const response = await post("/events/query", {});
			expect(response.status).toBe(200);
			expect(((await response.json()) as Record<string, unknown>).count).toBe(0);
		} finally {
			await stop();
		}
	});

	test("POST /events/query answers 400 for a filter that cannot match and 503 for a ledger that will not answer", async () => {
		const { greptime } = ledger();
		const { post, stop } = await serve(greptime);
		try {
			const bad = await post("/events/query", { kind: "file.edited" });
			expect(bad.status).toBe(400);
			expect(String(((await bad.json()) as Record<string, unknown>).error)).toContain("unknown kind");

			greptime.queryEvents = async () => {
				throw new Error("greptime unreachable: connect ETIMEDOUT");
			};
			const down = await post("/events/query", { repo: "r" });
			expect(down.status).toBe(503);
		} finally {
			await stop();
		}
	});

	test("a filter of the wrong JSON type is a 400 naming the field, not a 500", async () => {
		// The route casts the body; the service is what checks it. A number reaching
		// redaction used to throw inside `.replace` and surface as an internal error.
		const { queries, greptime } = ledger();
		const { post, stop } = await serve(greptime);
		try {
			for (const [body, field] of [
				[{ session_id: 123 }, "session_id must be a string"],
				[{ until: 123 }, "until must be an ISO date string"],
				[{ limit: "10" }, "limit must be a number"],
				[{ repo: "" }, "repo is empty"],
			] as const) {
				const response = await post("/events/query", body);
				expect(response.status).toBe(400);
				expect(String(((await response.json()) as Record<string, unknown>).error)).toContain(field);
			}
			// None of them reached the ledger.
			expect(queries).toEqual([]);
		} finally {
			await stop();
		}
	});

	test("a deployment with tokens refuses an unauthenticated read", async () => {
		const { greptime } = ledger();
		const { post, stop } = await serve(greptime, { SUBSTRATE_TOKEN_OMP: "tok-omp" });
		try {
			expect((await post("/events/query", {})).status).toBe(401);
			expect((await post("/events/query", {}, { authorization: "Bearer tok-omp" })).status).toBe(200);
		} finally {
			await stop();
		}
	});
});

describe("memoryWriteStatus", () => {
	/** Shorthand for a governance result; only the fields the mapping reads. */
	function result(outcome: string, over: { reason?: string; verified_persisted?: boolean } = {}) {
		return { outcome, reason: over.reason ?? outcome, verified_persisted: over.verified_persisted ?? true };
	}

	test("only a write that was read back gets a 200", () => {
		// A hook that can see nothing but the status code still has to be able to tell
		// "stored and confirmed" from "taken, not confirmed" — the same distinction
		// /events already draws between 202 and 200.
		expect(memoryWriteStatus(result("accepted"))).toBe(200);
		expect(memoryWriteStatus(result("accepted", { verified_persisted: false }))).toBe(202);
	});

	test("the three refusals are distinguishable without parsing the body", () => {
		expect(memoryWriteStatus(result("conflict", { reason: "review.required", verified_persisted: false }))).toBe(409);
		expect(memoryWriteStatus(result("quarantined", { reason: "quarantine.secret", verified_persisted: false }))).toBe(422);
		expect(memoryWriteStatus(result("denied", { reason: "rbac.no-grant", verified_persisted: false }))).toBe(403);
	});

	test("an outage is a 503, not a 403", () => {
		// A monitor must not read "the index is down" as "this agent lacks permission".
		expect(memoryWriteStatus(result("denied", { reason: "store.unavailable", verified_persisted: false }))).toBe(503);
		expect(memoryWriteStatus(result("denied", { reason: "store.write-failed", verified_persisted: false }))).toBe(503);
	});
});

describe("memoryWriter", () => {
	test("the token wins, and a body-supplied writer cannot outrank it", () => {
		// Attribution is what RBAC is decided on, so a caller naming its own surface
		// would make default-deny a formality.
		expect(memoryWriter("muse", "hermes")).toBe("muse");
	});

	test("an anonymous caller cannot name itself a surface", () => {
		// The regression. A deployment with no tokens configured is the one that skips
		// the 401, so honouring `body.writer` there — the only place it was ever
		// honoured — handed hermes's graph, repo and `agent:hermes` grants to anybody
		// who could reach the port and type the name.
		expect(memoryWriter(null, "hermes")).toBe("unknown");
		expect(memoryWriter(null, "claude-code")).toBe("unknown");
	});

	test("anything missing or empty is the writer that holds no grants", () => {
		expect(memoryWriter(null, undefined)).toBe("unknown");
		expect(memoryWriter(null, "   ")).toBe("unknown");
		expect(memoryWriter(null, 42)).toBe("unknown");
	});
});

describe("memoryToolWriter", () => {
	test("the token wins over the tool's own surface argument", () => {
		// `surface` is attribution on every other MCP tool. On `memory_write` it would
		// be authorisation, so the muse token cannot spend it to become hermes.
		expect(memoryToolWriter("muse", "hermes")).toBe("muse");
	});

	test("an unauthenticated MCP caller cannot name itself a surface", () => {
		// The same hole as the REST route's, through the other door: no token means
		// `unknown`, never the surface the caller asked to be.
		expect(memoryToolWriter(null, "hermes")).toBe("unknown");
		expect(memoryToolWriter(null, undefined)).toBe("unknown");
	});
});

// ── docs routes (Phase 25) ───────────────────────────────────────────────────
// POST /docs/search + POST /docs/ingest behind auditedRest under their own
// names, against a fake RAGFlow. Fixtures are runtime-assembled; nothing here
// touches a live RAGFlow.

const DOCS_COMMIT = "a".repeat(40);
// Runtime-assembled fixture host, never a live URL.
const DOCS_BASE = "https://" + "github.com/example/guide/blob/" + DOCS_COMMIT + "/docs/";

class FakeDocs {
	calls = {
		retrieval: 0,
		listDatasets: 0,
		listDocuments: 0,
		uploadDocuments: 0,
		parseDocuments: 0,
		updateDocument: 0,
		deleteDocuments: 0,
		ensureDataset: 0,
	};
	configured = true;
	hits: RetrievalHit[] = [];
	retrievalFailure: unknown;
	docs: RagflowDocument[] = [];
	uploadFailure: unknown;
	seq = 0;

	totalCalls(): number {
		return Object.values(this.calls).reduce((a, b) => a + b, 0);
	}

	async retrieval(options: { question: string; datasetIds: string[]; pageSize: number }): Promise<RetrievalHit[]> {
		this.calls.retrieval += 1;
		if (this.retrievalFailure !== undefined) throw this.retrievalFailure;
		return this.hits;
	}

	async listDatasets(): Promise<RagflowDatasetSummary[]> {
		this.calls.listDatasets += 1;
		return [];
	}

	async listDocuments(): Promise<RagflowDocument[]> {
		this.calls.listDocuments += 1;
		return this.docs;
	}

	async uploadDocuments(_datasetId: string, files: UploadFile[]): Promise<UploadedDocument[]> {
		this.calls.uploadDocuments += 1;
		if (this.uploadFailure !== undefined) throw this.uploadFailure;
		return files.map((file) => ({ documentId: `doc-${(this.seq += 1)}`, name: file.filename }));
	}

	async parseDocuments(): Promise<void> {
		this.calls.parseDocuments += 1;
	}

	async updateDocument(): Promise<void> {
		this.calls.updateDocument += 1;
	}

	async deleteDocuments(): Promise<void> {
		this.calls.deleteDocuments += 1;
	}

	async ensureDataset(name: string): Promise<string> {
		this.calls.ensureDataset += 1;
		return `ds-${name}`;
	}
}

function docsPage(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		dataset: "guide",
		source_url: DOCS_BASE + "intro.md",
		commit: DOCS_COMMIT,
		content: "# Intro\n\nHello.\n",
		...over,
	};
}

/** A path whose parent is a regular file: impossible to create, whoever is running. */
function unwritableAuditPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "substrate-docs-server-"));
	writeFileSync(join(directory, "not-a-directory"), "");
	return join(directory, "not-a-directory", "rest-audit.jsonl");
}

describe("docs routes", () => {
	/** Boot the real server with a fake RAGFlow and a fixture registry. */
	async function docsServe(
		fake: FakeDocs,
		env: Record<string, string | undefined> = {},
		greptime?: unknown,
	) {
		clearDatasetCache();
		const dir = await mkdtemp(join(tmpdir(), "substrate-docs-server-"));
		const registryFile = join(dir, "datasets.json");
		await writeFile(
			registryFile,
			JSON.stringify([
				{
					name: "guide",
					slug: "example/guide",
					include: ["docs/**"],
					exclude: [],
					trigger: "merge-to-main",
					datasetId: "ds-guide",
				},
			]),
		);
		const store = greptime ?? ledger().greptime;
		const served = await serve(
			store,
			{
				SUBSTRATE_DOCS_STATE: join(dir, "state"),
				SUBSTRATE_DOCS_DATASETS: registryFile,
				...env,
			},
			fake,
		);
		return { ...served, fake };
	}

	const SUBSTRATE_TOKEN = { SUBSTRATE_TOKEN_SUBSTRATE: "tok-substrate" };
	const agentEnv = { SUBSTRATE_TOKEN_OMP: "tok-omp" };
	const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

	test("POST /docs/search answers 200 with results for a tokened caller", async () => {
		const fake = new FakeDocs();
		fake.hits = [
			{
				chunkId: "chunk-1",
				documentId: "doc-1",
				datasetId: "ds-guide",
				content: "how to run the sync",
				score: 0.9,
				documentName: "intro.md",
				raw: {},
			},
		];
		fake.docs = [
			{
				id: "doc-1",
				name: "intro.md",
				run: "DONE",
				metaFields: {
					source_url: DOCS_BASE + "intro.md",
					title: "Intro",
					heading_path: ["Intro"],
					commit: DOCS_COMMIT,
				},
				raw: {},
			},
		];
		const { post, stop } = await docsServe(fake, agentEnv);
		try {
			const response = await post("/docs/search", { query: "how?" }, bearer("tok-omp"));
			const body = (await response.json()) as Record<string, unknown>;
			expect(response.status).toBe(200);
			expect(body.untrusted).toBe(true);
			expect((body.results as unknown[])).toHaveLength(1);
			expect(fake.calls.retrieval).toBe(1);
		} finally {
			await stop();
		}
	});

	test("POST /docs/search answers unauthenticated for anonymous with no RAGFlow call", async () => {
		const fake = new FakeDocs();
		fake.hits = [
			{
				chunkId: "chunk-1",
				documentId: "doc-1",
				datasetId: "ds-guide",
				content: "how to run the sync",
				score: 0.9,
				documentName: "intro.md",
				raw: {},
			},
		];
		const { post, stop } = await docsServe(fake, { SUBSTRATE_ALLOW_ANONYMOUS: "1" });
		try {
			const response = await post("/docs/search", { query: "how?" });
			const body = (await response.json()) as Record<string, unknown>;
			expect(response.status).toBe(200);
			expect(body.results).toEqual([]);
			expect(body.reason).toBe("unauthenticated");
			expect(fake.totalCalls()).toBe(0);
		} finally {
			await stop();
		}
	});
	test("POST /docs/search routes malformed JSON through the 200 invalid-request reply", async () => {
		const fake = new FakeDocs();
		const store = ledger();
		const { postRaw, stop } = await docsServe(fake, agentEnv, store.greptime);
		try {
			const response = await postRaw("/docs/search", "{broken json", bearer("tok-omp"));
			const body = (await response.json()) as Record<string, unknown>;
			expect(response.status).toBe(200);
			expect(body.results).toEqual([]);
			expect(body.reason).toBe("invalid-request");
			expect(body.untrusted).toBe(true);
			expect(fake.totalCalls()).toBe(0);
			const searches = store.written.filter(
				(event) => (event.payload as Record<string, unknown>).action === "docs.search",
			);
			expect(searches).toHaveLength(1);
			expect((searches[0]!.payload as Record<string, unknown>).reason).toBe("invalid-request");
		} finally {
			await stop();
		}
	});


	test("POST /docs/ingest refuses anonymous 401 before the body is read", async () => {
		const fake = new FakeDocs();
		const { post, stop } = await docsServe(fake, SUBSTRATE_TOKEN);
		try {
			const response = await post("/docs/ingest", docsPage());
			expect(response.status).toBe(401);
			expect(fake.totalCalls()).toBe(0);
			// Even an oversize body is 401 first: the door closes before the read.
			const big = await post("/docs/ingest", docsPage({ content: "x".repeat(1_100_000) }));
			expect(big.status).toBe(401);
			expect(fake.totalCalls()).toBe(0);
		} finally {
			await stop();
		}
	});

	test("POST /docs/ingest 403s an agent surface with no RAGFlow call", async () => {
		const fake = new FakeDocs();
		const { post, stop } = await docsServe(fake, { ...SUBSTRATE_TOKEN, ...agentEnv });
		try {
			const response = await post("/docs/ingest", docsPage(), bearer("tok-omp"));
			const body = (await response.json()) as Record<string, unknown>;
			expect(response.status).toBe(403);
			expect(String(body.error)).toContain("limited to the substrate host job and the operator");
			expect(fake.totalCalls()).toBe(0);
		} finally {
			await stop();
		}
	});

	test("POST /docs/ingest uploads 200 for the substrate writer", async () => {
		const fake = new FakeDocs();
		const { post, stop } = await docsServe(fake, { ...SUBSTRATE_TOKEN, ...agentEnv });
		try {
			const response = await post("/docs/ingest", docsPage(), bearer("tok-substrate"));
			const body = (await response.json()) as Record<string, unknown>;
			expect(response.status).toBe(200);
			expect(body.status).toBe("uploaded");
			expect(fake.calls.uploadDocuments).toBe(1);
		} finally {
			await stop();
		}
	});

	test("POST /docs/ingest 413s an oversize body with the typed shape", async () => {
		const fake = new FakeDocs();
		const { post, stop } = await docsServe(fake, SUBSTRATE_TOKEN);
		try {
			const response = await post("/docs/ingest", docsPage({ content: "x".repeat(1_100_000) }), bearer("tok-substrate"));
			const body = (await response.json()) as Record<string, unknown>;
			expect(response.status).toBe(413);
			expect(typeof body.error).toBe("string");
			expect(fake.totalCalls()).toBe(0);
		} finally {
			await stop();
		}
	});

	test("POST /docs/ingest 400s refusals and malformed bodies", async () => {
		const fake = new FakeDocs();
		const { post, stop } = await docsServe(fake, SUBSTRATE_TOKEN);
		try {
			const auth = bearer("tok-substrate");
			const unknown = await post("/docs/ingest", docsPage({ dataset: "nope" }), auth);
			expect(unknown.status).toBe(400);
			expect(((await unknown.json()) as Record<string, unknown>).reason).toBe("unknown-dataset");

			const outside = await post(
				"/docs/ingest",
				docsPage({ source_url: "https://" + "github.com/example/other/blob/" + DOCS_COMMIT + "/docs/x.md" }),
				auth,
			);
			expect(outside.status).toBe(400);
			expect(((await outside.json()) as Record<string, unknown>).reason).toBe("outside-roots");
			expect(fake.totalCalls()).toBe(0);
		} finally {
			await stop();
		}
	});

	test("POST /docs/ingest refuses invalid UTF-8 bytes as not-text", async () => {
		const fake = new FakeDocs();
		const store = ledger();
		const { post, postBytes, stop } = await docsServe(fake, SUBSTRATE_TOKEN, store.greptime);
		try {
			const auth = bearer("tok-substrate");
			const raw = Buffer.from(JSON.stringify(docsPage()), "utf8");
			const at = raw.indexOf(Buffer.from("Hello", "utf8"));
			expect(at).toBeGreaterThan(-1);
			raw[at] = 0xff;
			const refused = await postBytes("/docs/ingest", raw, auth);
			const refusedBody = (await refused.json()) as Record<string, unknown>;
			expect(refused.status).toBe(400);
			expect(refusedBody.status).toBe("refused");
			expect(refusedBody.reason).toBe("not-text");
			expect(fake.totalCalls()).toBe(0);
			expect(store.written).toEqual([]);

			const valid = await post("/docs/ingest", docsPage(), auth);
			expect(valid.status).toBe(200);
			expect(((await valid.json()) as Record<string, unknown>).status).toBe("uploaded");
		} finally {
			await stop();
		}
	});

	test("POST /docs/ingest 502s a RAGFlow failure with a capped message", async () => {
		const fake = new FakeDocs();
		fake.uploadFailure = new RagflowError("ragflow error 101: " + "x".repeat(500));
		const { post, stop } = await docsServe(fake, SUBSTRATE_TOKEN);
		try {
			const response = await post("/docs/ingest", docsPage(), bearer("tok-substrate"));
			const body = (await response.json()) as Record<string, unknown>;
			expect(response.status).toBe(502);
			expect(String(body.message).length).toBeLessThanOrEqual(200);
		} finally {
			await stop();
		}
	});

	test("POST /docs/ingest 503s when RAGFlow is not configured", async () => {
		clearDatasetCache();
		const dir = await mkdtemp(join(tmpdir(), "substrate-docs-server-"));
		const registryFile = join(dir, "datasets.json");
		await writeFile(registryFile, JSON.stringify([]));
		const { greptime } = ledger();
		// No fake and no RAGFLOW_URL: the client is null.
		const { post, stop } = await serve(
			greptime,
			{
				SUBSTRATE_DOCS_STATE: join(dir, "state"),
				SUBSTRATE_DOCS_DATASETS: registryFile,
				...SUBSTRATE_TOKEN,
			},
			null,
		);
		try {
			const response = await post("/docs/ingest", docsPage(), bearer("tok-substrate"));
			const body = (await response.json()) as Record<string, unknown>;
			expect(response.status).toBe(503);
			expect(body.reason).toBe("not-configured");
		} finally {
			await stop();
		}
	});

	test("an unwritable audit chain 503s the ingest while the search stays fail-open", async () => {
		const fake = new FakeDocs();
		const { post, stop } = await docsServe(fake, {
			...SUBSTRATE_TOKEN,
			SUBSTRATE_AUDIT_PATH: unwritableAuditPath(),
		});
		try {
			const auth = bearer("tok-substrate");
			const refused = await post("/docs/ingest", docsPage(), auth);
			expect(refused.status).toBe(503);
			expect(fake.totalCalls()).toBe(0);

			const search = await post("/docs/search", { query: "how?" }, auth);
			expect(search.status).toBe(200);
		} finally {
			await stop();
		}
	});
});
