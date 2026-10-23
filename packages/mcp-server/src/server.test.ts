import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { validateAgentCard } from "./agent-card.ts";
import { loadConfig } from "./config.ts";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { scanIngestPages } from "./docs-ingest.ts";
import type { EventQuery } from "./greptime.ts";
import { memoryToolWriter, resetRagMachine, surfaceClaimRefusal } from "./mcp.ts";
import { createObservability } from "./observe.ts";
import type { FetchLike } from "./planes/ragflow.ts";
import { RagflowFake } from "./ragflow-fake.ts";
import { HindsightFake } from "./hindsight-fake.ts";
import {
	STREAM_BATCH,
	createHttpServer,
	healthStatus,
	isLoopbackRemote,
	publicEdgeNeedsBearer,
	memoryWriteStatus,
	memoryWriter,
	streamRefusal,
	type HttpServerOptions,
} from "./server.ts";
import { Substrate } from "./service.ts";
import type { MemoryEntry, SubstrateEvent, Surface } from "./types.ts";
import type { EventBus, EventHint } from "./event-bus.ts";

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
 * Boot the real server on an ephemeral port; `stop` closes it.
 *
 * The ledger is injected rather than built from the environment, so nothing here
 * needs a Greptime endpoint in its config — `/events` and `/events/query` reach the
 * store through the substrate, and only `/healthz` asks the config whether a ledger
 * was configured at all.
 */
async function serve(
	greptime: unknown,
	env: Record<string, string | undefined> = {},
	stores: { ragflowFetch?: FetchLike; hindsightFetch?: FetchLike; eventBus?: () => EventBus | null } = {},
	options: HttpServerOptions = {},
) {
	const config = loadConfig(env);
	// No SUBSTRATE_AUDIT_PATH in the env, so the audit chain stays in memory and the
	// exporter is off: these routes are audited, and a test that skipped the plane
	// entirely would not be running the code the server actually runs.
	const observability = createObservability(config, env);
	await observability.start();
	const substrate = new Substrate(config, { index: null, greptime: greptime as never, ...stores }, observability.observer);
	const server = createHttpServer(substrate, config, observability, options);
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		port,
		post: (path: string, body: unknown, headers: Record<string, string> = {}) =>
			fetch(`http://127.0.0.1:${port}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify(body),
			}),
		get: (path: string, headers: Record<string, string> = {}, signal?: AbortSignal) =>
			fetch(`http://127.0.0.1:${port}${path}`, { headers, signal }),
		stop: () => {
			const closed = Promise.withResolvers<void>();
			observability.stop();
			server.close(() => closed.resolve());
			return closed.promise;
		},
	};
}

/**
 * One request sent with exactly the headers given. `fetch` sets or drops `host` and `origin` itself, and these tests are
 * about what the caller sent. Resolves with the status alone. `agent: false` keeps the socket out of the pool, so
 * `server.close` is not left waiting on it.
 */
function rawRequest(port: number, options: { path: string; method?: string; headers?: Record<string, string> }): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const request = httpRequest(
		{ host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers: options.headers, agent: false },
		(response) => {
			response.resume();
			resolve(response.statusCode ?? 0);
		},
	);
	request.on("error", reject);
	request.end();
	return promise;
}

/**
 * The HTTP surface, against a real listener.
 *
 * Hooks and the CLI reach the substrate this way, so the routes are driven over a
 * socket rather than by calling the service: a route that is unregistered, reading
 * the wrong body field or answering the wrong status fails here. The ledger is a
 * stub — this is about the wiring.
 */
describe("routes", () => {
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

	test("POST /docs/search answers cited results against the fake", async () => {
		const { greptime } = ledger();
		const fake = new RagflowFake();
		const { post, stop } = await serve(
			greptime,
			{ RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" },
			{ ragflowFetch: fake.fetch },
		);
		try {
			const response = await post("/docs/search", { question: "who reads RAGFlow?" });
			const body: unknown = await response.json();
			const chunks = body !== null && typeof body === "object" && "chunks" in body ? body.chunks : null;
			const untrusted = body !== null && typeof body === "object" && "untrusted" in body ? body.untrusted : null;
			expect(response.status).toBe(200);
			expect(Array.isArray(chunks) && chunks.length > 0).toBe(true);
			expect(typeof untrusted).toBe("string");
		} finally {
			await stop();
		}
	});

	test("POST /docs/search refuses a body without a question", async () => {
		const { greptime } = ledger();
		const { post, stop } = await serve(greptime);
		try {
			const response = await post("/docs/search", { datasets: ["agent-substrate"] });
			expect(response.status).toBe(400);
		} finally {
			await stop();
		}
	});

	/** The ledger stub plus the session read the docs context makes: each read is recorded and answers with no rows. */
	function sessionLedger() {
		const base = ledger();
		const reads: Array<[string, string]> = [];
		return {
			reads,
			greptime: {
				...base.greptime,
				readEvents: async (column: string, value: string) => {
					reads.push([column, value]);
					return [];
				},
			},
		};
	}

	/** A Hindsight fake with one memory in the omp bank, so a recall that reaches it is answered. */
	function ompBank(): HindsightFake {
		const hindsight = new HindsightFake();
		hindsight.seed("sub-omp", [{ id: "m1", text: "quote every version", document_id: "mwd_1", tags: ["omp"], metadata: {}, score: 0.9 }]);
		return hindsight;
	}

	/** Recall reads the process environment at call time, so the Hindsight variables are set around the requests made inside `run`. */
	async function withHindsightEnv<T>(banks: string, run: () => Promise<T>): Promise<T> {
		const names = ["HINDSIGHT_URL", "HINDSIGHT_API_KEY", "HINDSIGHT_BANKS"] as const;
		const saved = names.map((name) => [name, process.env[name]] as const);
		process.env.HINDSIGHT_URL = "http://fake";
		process.env.HINDSIGHT_API_KEY = "test-bearer";
		process.env.HINDSIGHT_BANKS = banks;
		try {
			return await run();
		} finally {
			for (const [name, value] of saved) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	}

	const OMP_ENV = { SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" };
	const OMP_AUTH = { authorization: "Bearer tok-omp" };

	test("POST /docs/search with context true reaches the service and answers a context block", async () => {
		const fake = new RagflowFake();
		const hindsight = ompBank();
		const { reads, greptime } = sessionLedger();
		const { post, stop } = await serve(greptime, OMP_ENV, { ragflowFetch: fake.fetch, hindsightFetch: hindsight.fetch });
		try {
			const response = await withHindsightEnv("sub-omp", () =>
				post("/docs/search", { question: "who reads RAGFlow?", session_id: "s-1", context: true }, OMP_AUTH),
			);
			const body = (await response.json()) as Record<string, unknown>;
			expect(response.status).toBe(200);
			expect(Object.hasOwn(body, "context")).toBe(true);
			expect(hindsight.recalls()).toHaveLength(1);
			expect(reads).toEqual([["session_id", "s-1"]]);
		} finally {
			await stop();
		}
	});

	test("POST /docs/search with context false or absent answers without a context key and reads neither source", async () => {
		const fake = new RagflowFake();
		const hindsight = ompBank();
		const { reads, greptime } = sessionLedger();
		const { post, stop } = await serve(greptime, OMP_ENV, { ragflowFetch: fake.fetch, hindsightFetch: hindsight.fetch });
		try {
			await withHindsightEnv("sub-omp", async () => {
				for (const extra of [{ context: false }, {}]) {
					const response = await post("/docs/search", { question: "who reads RAGFlow?", session_id: "s-1", ...extra }, OMP_AUTH);
					const body = (await response.json()) as Record<string, unknown>;
					expect(response.status).toBe(200);
					expect(Object.hasOwn(body, "context")).toBe(false);
				}
			});
			expect(hindsight.recalls()).toEqual([]);
			expect(reads).toEqual([]);
		} finally {
			await stop();
		}
	});

	test("POST /docs/search refuses a string or null context with a 400, before recall or the ledger", async () => {
		const fake = new RagflowFake();
		const hindsight = ompBank();
		const { reads, greptime } = sessionLedger();
		const { post, stop } = await serve(greptime, OMP_ENV, { ragflowFetch: fake.fetch, hindsightFetch: hindsight.fetch });
		try {
			await withHindsightEnv("sub-omp", async () => {
				for (const context of ["true", null]) {
					const response = await post("/docs/search", { question: "who reads RAGFlow?", session_id: "s-1", context }, OMP_AUTH);
					expect(response.status).toBe(400);
					expect(String(((await response.json()) as Record<string, unknown>).error)).toContain("context a boolean");
				}
			});
			expect(hindsight.recalls()).toEqual([]);
			expect(reads).toEqual([]);
		} finally {
			await stop();
		}
	});

	test("POST /docs/ingest stores a page against the fake", async () => {
		const { greptime } = ledger();
		const fake = new RagflowFake();
		const { post, stop } = await serve(
			greptime,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" },
			{ ragflowFetch: fake.fetch },
		);
		try {
			const response = await post(
				"/docs/ingest",
				{
					dataset: "agent-substrate",
					pages: [{ path: "docs/data-planes.md", source_url: "https://example.com/planes", body: "The substrate is the only door." }],
				},
				{ authorization: "Bearer tok-omp" },
			);
			const body: unknown = await response.json();
			const results = body !== null && typeof body === "object" && "results" in body ? body.results : null;
			expect(response.status).toBe(200);
			expect(Array.isArray(results) && results.length === 1).toBe(true);
		} finally {
			await stop();
		}
	});

	test("POST /docs/ingest refuses an anonymous caller before reading the body", async () => {
		const { greptime } = ledger();
		const { post, stop } = await serve(greptime, { SUBSTRATE_TOKEN_OMP: "tok-omp" });
		try {
			const response = await post("/docs/ingest", { dataset: "agent-substrate", pages: [] });
			expect(response.status).toBe(401);
		} finally {
			await stop();
		}
	});

	test("POST /docs/ingest refuses a body without pages", async () => {
		const { greptime } = ledger();
		const { post, stop } = await serve(greptime, { SUBSTRATE_TOKEN_OMP: "tok-omp" });
		try {
			const response = await post("/docs/ingest", { dataset: "agent-substrate" }, { authorization: "Bearer tok-omp" });
			expect(response.status).toBe(400);
		} finally {
			await stop();
		}
	});

	test("POST /docs/ingest refuses an out-of-roots real path", async () => {
		const { greptime } = ledger();
		const fake = new RagflowFake();
		const { post, stop } = await serve(
			greptime,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" },
			{ ragflowFetch: fake.fetch },
		);
		try {
			const response = await post(
				"/docs/ingest",
				{
					dataset: "agent-substrate",
					pages: [{ path: "docs/planes.md", real_path: "../vault.md", source_url: "https://example.com/x", body: "Hi." }],
				},
				{ authorization: "Bearer tok-omp" },
			);
			expect(response.status).toBe(400);
			expect(fake.uploads).toHaveLength(0);
		} finally {
			await stop();
		}
	});

	test("POST /docs/ingest answers 413 past the route body cap", async () => {
		const { greptime } = ledger();
		const { post, stop } = await serve(greptime, { SUBSTRATE_TOKEN_OMP: "tok-omp" });
		try {
			const response = await post(
				"/docs/ingest",
				{ dataset: "agent-substrate", pages: [{ path: "docs/big.md", body: `x${"y".repeat(6_500_000)}` }] },
				{ authorization: "Bearer tok-omp" },
			);
			expect(response.status).toBe(413);
		} finally {
			await stop();
		}
	});

	/** Route only the fake plane host through `impl`; the loopback listener keeps the real fetch. */
	function patchFetch(impl: FetchLike): () => void {
		const original = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("ragflow.test")) return impl(input, init);
			return original(input, init);
		}) as typeof fetch;
		return () => {
			globalThis.fetch = original;
		};
	}

	/**
	 * A tiny local checkout the merge-trigger can ingest from: the named files
	 * and nothing else. The caller removes it in a finally.
	 */
	function docsFixture(files: Record<string, string>): string {
		const root = mkdtempSync(join(tmpdir(), "substrate-docs-"));
		for (const [path, body] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), body);
		}
		return root;
	}

	/** Run git in a checkout with a fixed identity and no signing; returns trimmed stdout. */
	function git(root: string, ...args: string[]): string {
		return execFileSync("git", ["-C", root, "-c", "user.name=substrate", "-c", "user.email=substrate@example.test", "-c", "commit.gpgsign=false", ...args], {
			encoding: "utf8",
		}).trim();
	}

	/** A checkout that is a git repository holding `files` in one commit: the HEAD an agent-skills trigger names. */
	function gitCheckout(files: Record<string, string>): string {
		const root = docsFixture(files);
		git(root, "init", "-q");
		git(root, "add", "-A");
		git(root, "commit", "-q", "-m", "skills");
		return root;
	}

	/** The refresh versions the ledger recorded, so a test sees versions without pins. */
	function refreshEvents(written: SubstrateEvent[]): Array<Record<string, unknown>> {
		return ingestEvents(written).filter((payload) => "version" in payload);
	}

	/** The uploads the fake plane took for a dataset id, in order. */
	function uploadsFor(fake: RagflowFake, datasetId: string): Array<{ content: string; metadata: Record<string, string> }> {
		return fake.uploads.filter((upload) => upload.dataset_id === datasetId);
	}

	/** The `docs.ingest` ledger rows the refresh emits, so a test sees the refresh actually ran. */
	function ingestEvents(written: SubstrateEvent[]): Array<Record<string, unknown>> {
		return written
			.map((event) => event.payload as Record<string, unknown> | null)
			.filter((payload): payload is Record<string, unknown> => payload !== null && payload.action === "docs.ingest");
	}

	test("POST /docs/merge-trigger answers 401 without a token", async () => {
		const { greptime } = ledger();
		const { post, stop } = await serve(
			greptime,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" },
		);
		try {
			const response = await post("/docs/merge-trigger", { commit: "c-merge", content_sha256: "sha-merge" });
			expect(response.status).toBe(401);
		} finally {
			await stop();
		}
	});

	test("POST /docs/merge-trigger answers 401 untokened even on a run that allows anonymous callers", async () => {
		const { greptime } = ledger();
		const { post, stop } = await serve(greptime, { SUBSTRATE_ALLOW_ANONYMOUS: "1", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" });
		try {
			// The global gate passes an untokened caller here; the route's own refusal is the 401.
			const response = await post("/docs/merge-trigger", { commit: "c-merge", content_sha256: "sha-merge" });
			expect(response.status).toBe(401);
		} finally {
			await stop();
		}
	});

	test("POST /docs/merge-trigger refuses a VM guest before any ingest or dataset creation", async () => {
		// DOCS-02: ingestion accepts only authenticated callers that are not VM
		// guests. A guest that could drive ingest could also create a missing
		// shared dataset through the ensure step, so the door closes before the
		// body is even read.
		const { greptime } = ledger();
		const { post, stop } = await serve(
			greptime,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp", SUBSTRATE_VM_GUEST: "1", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" },
		);
		try {
			const response = await post("/docs/merge-trigger", { commit: "c-merge", content_sha256: "sha-merge" }, { authorization: "Bearer tok-omp" });
			expect(response.status).toBe(403);
			expect((await response.json() as { error: string }).error).toContain("VM guests");
		} finally {
			await stop();
		}
	});

	test("isLoopbackRemote takes the whole 127/8 and ::1, refuses everything else", () => {
		for (const good of ["127.0.0.1", "127.9.240.1", "::1", "::ffff:127.0.0.1"]) {
			expect(isLoopbackRemote(good)).toBe(true);
		}
		for (const bad of ["10.1.2.3", "::ffff:10.1.2.3", "::c0a8:1", "192.168.0.4", "", undefined, "127.cache.example.com"]) {
			expect(isLoopbackRemote(bad)).toBe(false);
		}
	});

	test("POST /docs/merge-trigger ingests the local roots, then records the version", async () => {
		const { greptime, written } = ledger();
		const fake = new RagflowFake();
		const restore = patchFetch(fake.fetch);
		const docs = docsFixture({ "README.md": "The substrate is the only door.", "docs/data-planes.md": "Planes and their readers." });
		const { post, stop } = await serve(
			greptime,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" },
			{},
			{ docsIngestBaseDir: docs },
		);
		try {
			// `?wait=1` keeps the synchronous answer (uplift-2 R6); the default 202 is proven in docs-plane-hardening.test.ts.
			const response = await post("/docs/merge-trigger?wait=1", { commit: "c-merge", content_sha256: "sha-merge" }, { authorization: "Bearer tok-omp" });
			const body = (await response.json()) as { ok: boolean; version?: { dataset: string; dataset_id: string; version: string; commit: string }; created?: boolean };
			expect(response.status).toBe(200);
			expect(body.ok).toBe(true);
			expect(body.version?.dataset).toBe("agent-substrate");
			expect(body.version?.dataset_id).toBe("ds-berlin-agent-substrate");
			expect(body.version?.version).toBe("v1");
			expect(body.version?.commit).toBe("c-merge");
			// The refresh moved documents, not just a version row: both configured
			// roots were scanned and uploaded under the dataset's id.
			expect(uploadsFor(fake, "ds-berlin-agent-substrate")).toHaveLength(2);
			expect(ingestEvents(written).filter((payload) => "source_urls" in payload)).toHaveLength(1);
			// And the refresh emitted its ledger event for the right dataset id.
			const events = refreshEvents(written);
			expect(events).toHaveLength(1);
			expect(events[0]?.dataset_id).toBe("ds-berlin-agent-substrate");
		} finally {
			restore();
			await stop();
			rmSync(docs, { recursive: true, force: true });
		}
	});

	test("POST /docs/merge-trigger creates the missing dataset before the first ingest", async () => {
		const { greptime, written } = ledger();
		const fake = new RagflowFake();
		// A configured plane that does not yet hold the dataset this checkout
		// ingests into: the ingest reads by name and refuses unknown-dataset, so
		// the trigger must create it before the first ingest can ever succeed.
		const kept = fake.datasets.filter((dataset) => dataset.name !== "agent-substrate");
		fake.datasets.splice(0, fake.datasets.length, ...kept);
		const restore = patchFetch(fake.fetch);
		const docs = docsFixture({ "README.md": "The substrate is the only door.", "docs/data-planes.md": "Planes and their readers." });
		const { post, stop } = await serve(
			greptime,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" },
			{},
			{ docsIngestBaseDir: docs },
		);
		try {
			const response = await post("/docs/merge-trigger?wait=1", { commit: "c-merge", content_sha256: "sha-merge" }, { authorization: "Bearer tok-omp" });
			const body = (await response.json()) as { ok: boolean; version?: { version: string; dataset_id: string }; created?: boolean };
			expect(response.status).toBe(200);
			expect(body.ok).toBe(true);
			expect(body.version?.version).toBe("v1");
			// The resolve step created the dataset, so the reply says created even
			// though the refresh's own resolve found it already sitting there.
			expect(body.created).toBe(true);
			const created = fake.datasets.find((dataset) => dataset.name === "agent-substrate");
			expect(created).toBeDefined();
			expect(body.version?.dataset_id).toBe(created?.id);
			// The pages moved into the freshly created dataset, and both the
			// ingest and the refresh recorded their ledger events under its id.
			expect(uploadsFor(fake, created?.id ?? "")).toHaveLength(2);
			expect(ingestEvents(written).filter((payload) => "source_urls" in payload)).toHaveLength(1);
			expect(refreshEvents(written)).toHaveLength(1);
		} finally {
			restore();
			await stop();
			rmSync(docs, { recursive: true, force: true });
		}
	});

	test("POST /docs/merge-trigger ingests the agent-skills checkout when SUBSTRATE_AGENT_SKILLS_ROOT names one, then records the version", async () => {
		const { greptime, written } = ledger();
		const fake = new RagflowFake();
		fake.parseDonePolls = 1;
		const restore = patchFetch(fake.fetch);
		// The library layout: each skill is a `<name>/` directory holding SKILL.md and a references/ tree. A
		// directory with no SKILL.md is not a skill, so its file never reaches the plane.
		const checkout = gitCheckout({
			"demo-skill/SKILL.md": "---\nname: demo-skill\n---\nDemo skill body.\n",
			"demo-skill/references/api.md": "The demo API reference.\n",
			"notes/scratch.md": "Not a skill.\n",
		});
		const { post, stop } = await serve(greptime, { SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k", SUBSTRATE_AGENT_SKILLS_ROOT: checkout });
		try {
			const head = git(checkout, "rev-parse", "HEAD");
			const response = await post("/docs/merge-trigger?wait=1", { dataset: "agent-skills", commit: head, content_sha256: "sha-skills" }, { authorization: "Bearer tok-omp" });
			const body = (await response.json()) as { ok: boolean; version?: { version: string; commit: string; dataset_id: string } };
			expect(response.status).toBe(200);
			expect(body.ok).toBe(true);
			expect(body.version).toMatchObject({ version: "v1", commit: head, dataset_id: "ds-leipzig-agent-skills" });
			// Exactly the skill's SKILL.md and its reference reach the plane, each cited by its own file.
			const sources = uploadsFor(fake, "ds-leipzig-agent-skills").map((upload) => upload.metadata.source_url ?? "");
			expect(sources).toHaveLength(2);
			expect(sources.some((url) => url.endsWith("/demo-skill/SKILL.md"))).toBe(true);
			expect(sources.some((url) => url.endsWith("/demo-skill/references/api.md"))).toBe(true);
			expect(refreshEvents(written)).toHaveLength(1);
		} finally {
			restore();
			await stop();
			rmSync(checkout, { recursive: true, force: true });
		}
	});

	test("POST /docs/merge-trigger for agent-skills refuses a checkout that moved past the requested commit: commit-mismatch, nothing recorded", async () => {
		const { greptime, written } = ledger();
		const fake = new RagflowFake();
		fake.parseDonePolls = 1;
		const restore = patchFetch(fake.fetch);
		const checkout = gitCheckout({ "demo-skill/SKILL.md": "---\nname: demo-skill\n---\nDemo skill body.\n" });
		const requested = git(checkout, "rev-parse", "HEAD");
		// The trigger names `requested`, then the checkout advances: the job must not ingest the newer content under that name.
		writeFileSync(join(checkout, "demo-skill", "SKILL.md"), "---\nname: demo-skill\n---\nRevised skill body.\n");
		git(checkout, "commit", "-q", "-am", "revise skill");
		const { post, stop } = await serve(greptime, { SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k", SUBSTRATE_AGENT_SKILLS_ROOT: checkout });
		try {
			const response = await post("/docs/merge-trigger?wait=1", { dataset: "agent-skills", commit: requested, content_sha256: "sha-moved" }, { authorization: "Bearer tok-omp" });
			const body = (await response.json()) as { ok: boolean; reason?: string };
			expect(response.status).toBe(503);
			expect(body).toMatchObject({ ok: false, reason: "commit-mismatch" });
			expect(fake.uploads).toHaveLength(0);
			expect(refreshEvents(written)).toHaveLength(0);
		} finally {
			restore();
			await stop();
			rmSync(checkout, { recursive: true, force: true });
		}
	});

	test("POST /docs/merge-trigger for agent-skills is a truthful noop when SUBSTRATE_AGENT_SKILLS_ROOT is unset", async () => {
		const { greptime, written } = ledger();
		const fake = new RagflowFake();
		const restore = patchFetch(fake.fetch);
		const docs = docsFixture({ "README.md": "The substrate is the only door." });
		const { post, stop } = await serve(
			greptime,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" },
			{},
			{ docsIngestBaseDir: docs },
		);
		try {
			// agent-skills is a known trigger row, but with no checkout named this server holds none of it: a
			// recorded version over documents that were never ingested would only lie to search, so the noop
			// says what happened instead.
			const response = await post("/docs/merge-trigger", { dataset: "agent-skills", commit: "c-ff", content_sha256: "sha-ff" }, { authorization: "Bearer tok-omp" });
			const body = (await response.json()) as { ok: boolean; dataset: string; noop?: boolean; reason?: string };
			expect(response.status).toBe(200);
			expect(body.ok).toBe(true);
			expect(body.dataset).toBe("agent-skills");
			expect(body.noop).toBe(true);
			expect(body.reason).toBe("no-configured-ingest-root");
			expect(fake.uploads).toHaveLength(0);
			expect(ingestEvents(written)).toHaveLength(0);
		} finally {
			restore();
			await stop();
			rmSync(docs, { recursive: true, force: true });
		}
	});

	test("POST /docs/merge-trigger for agent-skills fails with checkout-unreadable when the named checkout is gone", async () => {
		const { greptime, written } = ledger();
		const fake = new RagflowFake();
		const restore = patchFetch(fake.fetch);
		// The named checkout does not exist, so its roots cannot be listed: the job fails before any plane call.
		const gone = docsFixture({ "demo-skill/SKILL.md": "Demo skill body.\n" });
		rmSync(gone, { recursive: true, force: true });
		const { post, stop } = await serve(greptime, { SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k", SUBSTRATE_AGENT_SKILLS_ROOT: gone });
		try {
			const response = await post("/docs/merge-trigger?wait=1", { dataset: "agent-skills", commit: "c-gone", content_sha256: "sha-gone" }, { authorization: "Bearer tok-omp" });
			const body = (await response.json()) as { ok: boolean; reason?: string };
			expect(response.status).toBe(503);
			expect(body).toMatchObject({ ok: false, reason: "checkout-unreadable" });
			expect(fake.uploads).toHaveLength(0);
			expect(refreshEvents(written)).toHaveLength(0);
		} finally {
			restore();
			await stop();
		}
	});

	test("POST /docs/merge-trigger dedupes the default dataset by content hash", async () => {
		const { greptime, written } = ledger();
		const fake = new RagflowFake();
		fake.parseDonePolls = 1;
		const restore = patchFetch(fake.fetch);
		const docs = docsFixture({ "README.md": "The substrate is the only door.", "docs/data-planes.md": "Planes and their readers." });
		const { post, stop } = await serve(
			greptime,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" },
			{},
			{ docsIngestBaseDir: docs },
		);
		try {
			const first = await post("/docs/merge-trigger?wait=1", { commit: "c-merge", content_sha256: "sha-merge" }, { authorization: "Bearer tok-omp" });
			const firstBody = (await first.json()) as { ok: boolean; version?: { version: string }; idempotent?: boolean };
			expect(first.status).toBe(200);
			expect(firstBody.version?.version).toBe("v1");
			expect(firstBody.idempotent).toBeUndefined();
			expect(uploadsFor(fake, "ds-berlin-agent-substrate")).toHaveLength(2);

			// The same commit and hash again: the newest version's own identity, so
			// nothing is ingested or recorded and the reply says it answered from
			// the record.
			const repeat = await post("/docs/merge-trigger?wait=1", { commit: "c-merge", content_sha256: "sha-merge" }, { authorization: "Bearer tok-omp" });
			const repeatBody = (await repeat.json()) as { ok: boolean; version?: { version: string }; idempotent?: boolean };
			expect(repeat.status).toBe(200);
			expect(repeatBody.idempotent).toBe(true);
			expect(repeatBody.version?.version).toBe("v1");
			expect(refreshEvents(written)).toHaveLength(1);
			expect(fake.uploads).toHaveLength(2);

			// New content: a real second version. The pages' bytes are unchanged, so
			// the ingest itself is unchanged by hash — only the version row moves.
			const next = await post("/docs/merge-trigger?wait=1", { commit: "c-merge-2", content_sha256: "sha-merge-2" }, { authorization: "Bearer tok-omp" });
			const nextBody = (await next.json()) as { ok: boolean; version?: { version: string } };
			expect(next.status).toBe(200);
			expect(nextBody.version?.version).toBe("v2");
			expect(refreshEvents(written)).toHaveLength(2);
			expect(fake.uploads).toHaveLength(2);
		} finally {
			restore();
			await stop();
			rmSync(docs, { recursive: true, force: true });
		}
	});

	test("POST /docs/merge-trigger no-ops on an unconfigured docs plane", async () => {
		const { greptime, written } = ledger();
		const { post, stop } = await serve(greptime, { SUBSTRATE_TOKEN_OMP: "tok-omp" });
		try {
			const response = await post("/docs/merge-trigger", { commit: "c-merge", content_sha256: "sha-merge" }, { authorization: "Bearer tok-omp" });
			const body = (await response.json()) as { ok: boolean; dataset: string; noop?: boolean; reason?: string };
			expect(response.status).toBe(200);
			expect(body.ok).toBe(true);
			expect(body.dataset).toBe("agent-substrate");
			expect(body.noop).toBe(true);
			expect(body.reason).toBe("docs-plane-unconfigured");
			// No plane call, no refresh event: the trigger asked for nothing that exists.
			expect(ingestEvents(written)).toHaveLength(0);
		} finally {
			await stop();
		}
	});

	test("POST /docs/merge-trigger answers 503 with the reason when the docs plane refuses", async () => {
		const { greptime, written } = ledger();
		const restore = patchFetch(async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:9");
		});
		const docs = docsFixture({ "README.md": "The substrate is the only door." });
		const { post, stop } = await serve(
			greptime,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" },
			{},
			{ docsIngestBaseDir: docs },
		);
		try {
			const response = await post("/docs/merge-trigger?wait=1", { commit: "c-merge", content_sha256: "sha-merge" }, { authorization: "Bearer tok-omp" });
			const body = (await response.json()) as { ok: boolean; reason?: string };
			expect(response.status).toBe(503);
			expect(body.ok).toBe(false);
			expect(body.reason).toContain("ragflow unreachable");
			// The ingest the refresh starts with is what refused, so nothing moved:
			// no refresh event, no version recorded over a refused ingest.
			expect(refreshEvents(written)).toHaveLength(0);
		} finally {
			restore();
			await stop();
			rmSync(docs, { recursive: true, force: true });
		}
	});

	test("POST /docs/merge-trigger refuses an unknown dataset and a body without the hash", async () => {
		const { greptime } = ledger();
		const docs = docsFixture({ "README.md": "The substrate is the only door." });
		const { post, stop } = await serve(
			greptime,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" },
			{},
			{ docsIngestBaseDir: docs },
		);
		try {
			const unknown = await post("/docs/merge-trigger", { dataset: "not-a-dataset", commit: "c", content_sha256: "s" }, { authorization: "Bearer tok-omp" });
			expect(unknown.status).toBe(400);
			// The names every object inherits are not dataset rows: `in` would pass
			// "constructor" to the refresh; hasOwn refuses it like any other name.
			const inherited = await post("/docs/merge-trigger", { dataset: "constructor", commit: "c", content_sha256: "s" }, { authorization: "Bearer tok-omp" });
			expect(inherited.status).toBe(400);
			const hashless = await post("/docs/merge-trigger", { commit: "c" }, { authorization: "Bearer tok-omp" });
			expect(hashless.status).toBe(400);
			const scalar = await post("/docs/merge-trigger", 42, { authorization: "Bearer tok-omp" });
			expect(scalar.status).toBe(400);
		} finally {
			await stop();
			rmSync(docs, { recursive: true, force: true });
		}
	});

	test("POST /docs/merge-trigger records no version when the ingest is refused", async () => {
		const { greptime, written } = ledger();
		const fake = new RagflowFake();
		const restore = patchFetch(fake.fetch);
		const docs = docsFixture({ "README.md": "The substrate is the only door.", "docs/leak.md": "password: hunter2 in the shipped config" });
		const { post, stop } = await serve(
			greptime,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" },
			{},
			{ docsIngestBaseDir: docs },
		);
		try {
			// The redactor refuses the whole call — never clean-and-publish — so the
			// trigger answers 503 with the refusal reason and records nothing.
			const refused = await post("/docs/merge-trigger?wait=1", { commit: "c-leak", content_sha256: "sha-leak" }, { authorization: "Bearer tok-omp" });
			const body = (await refused.json()) as { ok: boolean; reason?: string };
			expect(refused.status).toBe(503);
			expect(body.ok).toBe(false);
			expect(body.reason).toBe("secret-findings");
			expect(fake.uploads).toHaveLength(0);
			expect(refreshEvents(written)).toHaveLength(0);

			// The leak fixed: the next trigger is the first version — the refused
			// one never became v1.
			writeFileSync(join(docs, "docs/leak.md"), "passwords are long and random");
			const again = await post("/docs/merge-trigger?wait=1", { commit: "c-clean", content_sha256: "sha-clean" }, { authorization: "Bearer tok-omp" });
			const againBody = (await again.json()) as { ok: boolean; version?: { version: string } };
			expect(again.status).toBe(200);
			expect(againBody.version?.version).toBe("v1");
		} finally {
			restore();
			await stop();
			rmSync(docs, { recursive: true, force: true });
		}
	});

	describe("the REST RAG breaker counts only plane failures", () => {
		const realFetch = globalThis.fetch;
		const auth = { authorization: "Bearer tok-omp" };
		const LIGHTRAG_ENV = {
			SUBSTRATE_TOKEN_OMP: "tok-omp",
			LIGHTRAG_URL: "http://lightrag.test",
			SUBSTRATE_RAG_MAX_RETRIES: "0",
			SUBSTRATE_RAG_HALF_OPEN_MS: "0",
		};
		const LIGHTRAG_ANSWER = { data: [{ content: "A LightRAG chunk.", document_name: "docs/planning.md", source_url: "https://example.com/planning" }] };
		/** Answers LightRAG calls only; the test's own REST requests go to the real fetch. */
		const stubLightrag = (answer: () => Promise<Response>) =>
			(async (input: string | URL | Request, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				return url.startsWith("http://lightrag.test") ? answer() : realFetch(input, init);
			}) as unknown as typeof fetch;
		beforeEach(() => resetRagMachine());
		afterEach(() => {
			globalThis.fetch = realFetch;
			resetRagMachine();
		});

		test("several version.stale refusals over REST leave the RAG machine out of ERROR, and the next query is served", async () => {
			let planeCalls = 0;
			globalThis.fetch = stubLightrag(async () => {
				planeCalls += 1;
				return Response.json(LIGHTRAG_ANSWER);
			});
			const { greptime } = ledger();
			const { post, get, stop } = await serve(greptime, { ...LIGHTRAG_ENV, SUBSTRATE_RAG_HALF_OPEN_MS: "60000" });
			try {
				const stale = { path: "docs/data-planes.md", source_url: "https://example.com/agent-substrate/data-planes", body: "A page.", expected_version: 1 };
				for (let n = 0; n < 2; n += 1) {
					const refused = await post("/docs/ingest", { dataset: "agent-substrate", pages: [stale] }, auth);
					expect(refused.status).toBe(409);
					expect(await refused.text()).toContain("version.stale");
				}
				const outside = { path: "secrets/keys.md", source_url: "https://example.com/agent-substrate/keys", body: "Keys." };
				const refusedOutside = await post("/docs/ingest", { dataset: "agent-substrate", pages: [outside] }, auth);
				expect(refusedOutside.status).toBe(400);
				expect(await refusedOutside.text()).toContain("outside-roots");

				const before = (await (await get("/rag/state", auth)).json()) as Record<string, unknown>;
				expect(before).toMatchObject({ consecutiveFailures: 0 });
				expect(before.state).not.toBe("ERROR");

				const served = (await (await post("/docs/lightrag/query", { question: "asked after the refusals" }, auth)).json()) as Record<string, unknown>;
				expect(served).toMatchObject({ backend: "lightrag", chunks: [expect.objectContaining({ content: "A LightRAG chunk." })] });
				expect(served.fallback).toBeUndefined();
				expect(planeCalls).toBe(1);
			} finally {
				await stop();
			}
		});

		test("two concurrent REST LightRAG queries after the cooldown produce one backend attempt", async () => {
			let attempts = 0;
			const probeReply = Promise.withResolvers<Response>();
			const probeReached = Promise.withResolvers<void>();
			globalThis.fetch = stubLightrag(async () => {
				attempts += 1;
				if (attempts <= 3) return new Response("upstream down", { status: 500 });
				if (attempts === 4) {
					probeReached.resolve();
					return probeReply.promise;
				}
				return new Response("upstream down", { status: 500 });
			});
			const { greptime } = ledger();
			// A zero cooldown has already elapsed, so the query after ERROR is the probe; no timer is needed.
			const { post, get, stop } = await serve(greptime, LIGHTRAG_ENV);
			try {
				for (const question of ["drive one", "drive two", "drive three"]) {
					const degraded = (await (await post("/docs/lightrag/query", { question }, auth)).json()) as Record<string, unknown>;
					expect(degraded.fallback).toBe("hindsight");
				}
				expect(await (await get("/rag/state", auth)).json()).toMatchObject({ state: "ERROR" });

				const probe = post("/docs/lightrag/query", { question: "the probe" }, auth);
				await probeReached.promise;
				const burst = (await (await post("/docs/lightrag/query", { question: "the burst" }, auth)).json()) as Record<string, unknown>;
				expect(burst.fallback).toBe("hindsight");
				expect(attempts).toBe(4);

				probeReply.resolve(Response.json(LIGHTRAG_ANSWER));
				const probed = (await (await probe).json()) as Record<string, unknown>;
				expect(probed).toMatchObject({ backend: "lightrag" });
				expect(probed.fallback).toBeUndefined();
				expect(attempts).toBe(4);
			} finally {
				await stop();
			}
		});

		test("a REST docs ingest, refused or served, does not move an open breaker: the next query inside the cooldown is refused without a backend call", async () => {
			let queries = 0;
			globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(input instanceof Request ? input.url : String(input));
				if (url.origin !== "http://lightrag.test") return realFetch(input, init);
				if (url.pathname === "/query") {
					queries += 1;
					return new Response("upstream down", { status: 500 });
				}
				if (init?.method === "POST" && url.pathname === "/documents/upload") return Response.json({ status: "success", data: { track_id: "trk-1" } });
				if (init?.method === "POST" && url.pathname === "/documents/scan") return Response.json({ status: "success" });
				if (url.pathname === "/documents/pipeline_status") return Response.json({ status: "idle" });
				return Response.json({ detail: "no route" }, { status: 404 });
			}) as unknown as typeof fetch;
			const { greptime } = ledger();
			// A 60 s cooldown: it cannot elapse during the test, so ERROR holds until the assertions say otherwise.
			const { post, get, stop } = await serve(greptime, { ...LIGHTRAG_ENV, SUBSTRATE_RAG_HALF_OPEN_MS: "60000" });
			try {
				for (const question of ["trip one", "trip two", "trip three"]) {
					const degraded = (await (await post("/docs/lightrag/query", { question }, auth)).json()) as Record<string, unknown>;
					expect(degraded.fallback).toBe("hindsight");
				}
				expect(await (await get("/rag/state", auth)).json()).toMatchObject({ state: "ERROR" });
				const queriesWhenOpen = queries;

				const refused = await post("/docs/ingest", { dataset: "agent-substrate", pages: [{ path: "docs/data-planes.md", source_url: "https://example.com/agent-substrate/data-planes", body: "A page.", expected_version: 1 }] }, auth);
				expect(refused.status).toBe(409);
				expect(await (await get("/rag/state", auth)).json()).toMatchObject({ state: "ERROR" });

				const served = await post("/docs/ingest", { dataset: "agent-substrate", pages: [{ path: "docs/data-planes.md", source_url: "https://example.com/agent-substrate/data-planes", body: "The substrate is the only door to the data planes." }] }, auth);
				expect(served.status).toBe(200);
				expect(await (await get("/rag/state", auth)).json()).toMatchObject({ state: "ERROR" });

				const inside = (await (await post("/docs/lightrag/query", { question: "asked inside the cooldown" }, auth)).json()) as Record<string, unknown>;
				expect(inside.fallback).toBe("hindsight");
				expect(queries).toBe(queriesWhenOpen);
			} finally {
				await stop();
			}
		});

		test("after the cooldown, one successful REST docs search moves the RAG machine out of ERROR", async () => {
			let planeHealthy = false;
			globalThis.fetch = stubLightrag(async () => (planeHealthy ? Response.json(LIGHTRAG_ANSWER) : new Response("upstream down", { status: 500 })));
			const { greptime } = ledger();
			// A zero cooldown has already elapsed, so the search after ERROR is the probe; no timer is needed.
			const { post, get, stop } = await serve(greptime, LIGHTRAG_ENV);
			try {
				for (const question of ["search one", "search two", "search three"]) {
					const degraded = (await (await post("/docs/search", { question }, auth)).json()) as Record<string, unknown>;
					expect(degraded.degraded).toBe(true);
				}
				expect(await (await get("/rag/state", auth)).json()).toMatchObject({ state: "ERROR" });

				planeHealthy = true;
				const probed = (await (await post("/docs/search", { question: "the probe" }, auth)).json()) as Record<string, unknown>;
				expect(probed.degraded).toBeUndefined();
				expect(await (await get("/rag/state", auth)).json()).toMatchObject({ state: "IDLE" });
			} finally {
				await stop();
			}
		});
	});
});

/**
 * The push seam: `GET /events/stream` over a socket, against a ledger stub that
 * answers exactly the cursor reads the route makes, with `append` so a test can
 * land rows after the connection is open. The bounds are injected small — the
 * production constants are deliberately not configurable.
 */
describe("GET /events/stream", () => {
	/** Any fixed epoch; stub positions sit 10 ms apart from here. */
	const BASE = Date.UTC(2026, 9, 1);

	interface StubEvent {
		id: string;
		ts: number;
		summary: string;
	}

	/** One stub row, in the shape Greptime's loosely typed rows actually arrive in. */
	function row(event: StubEvent): Record<string, unknown> {
		return {
			ts: event.ts,
			id: event.id,
			surface: "omp",
			session_id: null,
			graph_id: null,
			node_id: null,
			linear_identifier: null,
			step: null,
			repo: null,
			branch: null,
			actor: "agent",
			kind: "note",
			summary: event.summary,
			hash: `h-${event.id}`,
			prev: null,
		};
	}

	/** A ledger stub answering the stream route's reads, counting every poll. */
	function streamLedger(events: StubEvent[]) {
		const positions = events.map((event, i) => ({ id: event.id, ingestedAt: BASE + i * 10 }));
		let nextIngestedAt = BASE + events.length * 10;
		const reads: Array<{ cursor: { id: string; ingestedAt: number }; limit: number }> = [];
		return {
			ping: async () => true,
			ensureAppendMode: async () => true,
			probeDialect: async () => true,
			quotingDialectKnown: true,
			lastHash: async () => null,
			insertEvent: async () => {},
			queryEvents: async () => [] as Array<Record<string, unknown>>,
			cursorPosition: async (eventId: string) => positions.find((position) => position.id === eventId) ?? null,
			latestPosition: async () => (positions.length > 0 ? positions[positions.length - 1]! : null),
			eventIdsAfter: async (cursor: { id: string; ingestedAt: number }, limit: number) => {
				reads.push({ cursor, limit });
				const seen = new Set<string>();
				const out: Array<{ id: string; ingestedAt: number }> = [];
				for (const position of positions) {
					if (seen.has(position.id)) continue;
					seen.add(position.id);
					const after =
						position.ingestedAt > cursor.ingestedAt ||
						(position.ingestedAt === cursor.ingestedAt && position.id > cursor.id);
					if (!after) continue;
					out.push(position);
					if (out.length >= limit) break;
				}
				return out;
			},
			// The route passes positions (uplift-2 R5) so the real client can bound the read in time; bare ids stay accepted.
			eventsByIds: async (positions: ReadonlyArray<string | { id: string }>) => {
				const wanted = new Set(positions.map((position) => (typeof position === "string" ? position : position.id)));
				return events.filter((event) => wanted.has(event.id)).map(row);
			},
			append: (event: StubEvent) => {
				positions.push({ id: event.id, ingestedAt: nextIngestedAt });
				nextIngestedAt += 10;
				events.push(event);
			},
			reads,
		};
	}

	/** Complete `id:`/`data:` frames in SSE text collected so far. */
	function frames(text: string): Array<{ id: string; data: string }> {
		return [...text.matchAll(/id: (.+)\ndata: (.+)\n\n/g)].map((match) => ({ id: match[1]!, data: match[2]! }));
	}

	/**
	 * Read a stream's text until `want` frames arrived, the server closed it, or the
	 * deadline passed; aborts the request either way, so `stop()` never waits on a
	 * socket the test abandoned.
	 */
	async function streamText(response: Response, controller: AbortController, want = Number.POSITIVE_INFINITY, deadlineMs = 5_000): Promise<string> {
		const reader = response.body?.getReader();
		const decoder = new TextDecoder();
		let text = "";
		const deadline = Date.now() + deadlineMs;
		while (reader && Date.now() < deadline && frames(text).length < want) {
			// A server-side cutoff destroys the socket mid-read: the read throws
			// (ECONNRESET) rather than returning done. That is the expected end for
			// this helper — return the frames received before the cut.
			try {
				const { done, value } = await reader.read();
				if (done) break;
				text += decoder.decode(value, { stream: true });
			} catch {
				break;
			}
		}
		controller.abort();
		return text;
	}

	/** The one real-clock sleep the suite needs: absence of events is only observable by letting time pass. */
	function delay(ms: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, ms);
		return promise;
	}

	/** Await a real condition instead of guessing its duration; the stream runs on a real interval and a live socket. */
	async function until(condition: () => boolean, deadlineMs = 2_000): Promise<void> {
		const deadline = Date.now() + deadlineMs;
		while (!condition()) {
			if (Date.now() > deadline) throw new Error("the awaited condition never held");
			await delay(5);
		}
	}

	test("streamRefusal checks the surface before the interface", () => {
		// The 401 is the merge-trigger door decision: an unauthenticated caller is
		// refused before the loopback check is even reached, anonymous-allowed or not.
		expect(streamRefusal(null, "10.1.2.3")?.status).toBe(401);
		expect(streamRefusal(null, "127.0.0.1")?.status).toBe(401);
		expect(streamRefusal("omp" as Surface, "10.1.2.3")?.status).toBe(403);
		expect(String(streamRefusal("omp" as Surface, "10.1.2.3")?.error)).toContain("loopback");
		expect(streamRefusal("omp" as Surface, "127.9.240.1")).toBeNull();
		expect(streamRefusal("omp" as Surface, "::1")).toBeNull();
	});

	test("the public edge requires a bearer except for GET /healthz", () => {
		expect(publicEdgeNeedsBearer("public", "POST", "/memory", null)).toBe(true);
		expect(publicEdgeNeedsBearer("public", "GET", "/brief", null)).toBe(true);
		expect(publicEdgeNeedsBearer("public", "GET", "/healthz", null)).toBe(false);
		expect(publicEdgeNeedsBearer("public", "GET", "/memory", "omp" as Surface)).toBe(false);
		expect(publicEdgeNeedsBearer(undefined, "POST", "/memory", null)).toBe(false);
		expect(publicEdgeNeedsBearer(["public"], "POST", "/events", null)).toBe(true);
	});

	test("GET /healthz stays open when anonymous callers are refused", async () => {
		const stub = streamLedger([]);
		const { get, stop } = await serve(stub, {
			SUBSTRATE_TOKEN_OMP: "tok-omp",
			SUBSTRATE_ALLOW_ANONYMOUS: "0",
		});
		try {
			const health = await get("/healthz");
			expect(health.status).not.toBe(401);
			const body = (await health.json()) as { publicOrigin?: string };
			expect(body.publicOrigin).toBe("https://substrate.swcstudio.space");
			expect((await get("/brief")).status).toBe(401);
		} finally {
			await stop();
		}
	});

	test("an untokened caller is refused, even on a run that allows anonymous callers", async () => {
		const stub = streamLedger([]);
		const { get, stop } = await serve(stub, { SUBSTRATE_TOKEN_OMP: "tok-omp" });
		try {
			// The global gate answers this one before the route is reached.
			expect((await get("/events/stream")).status).toBe(401);
		} finally {
			await stop();
		}

		// The bridge gate passes an untokened caller here; the route's own refusal
		// is the 401, and it names the decision.
		const bridge = streamLedger([]);
		const { get: getAnon, stop: stopAnon } = await serve(bridge, { SUBSTRATE_ALLOW_ANONYMOUS: "1" });
		try {
			const refused = await getAnon("/events/stream");
			expect(refused.status).toBe(401);
			expect(String(((await refused.json()) as Record<string, unknown>).error)).toContain("authenticated surface");
		} finally {
			await stopAnon();
		}
	});

	test("replays after Last-Event-ID in ingest order and keeps streaming new rows", async () => {
		const stub = streamLedger([
			{ id: "e1", ts: BASE, summary: "first" },
			{ id: "e2", ts: BASE + 1, summary: "second" },
			{ id: "e3", ts: BASE + 2, summary: "third" },
		]);
		const { get, stop } = await serve(
			stub,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp" },
			{},
			{ streamPollMs: 10, streamIdleMs: 60_000 },
		);
		try {
			const controller = new AbortController();
			const response = await get("/events/stream", { authorization: "Bearer tok-omp", "last-event-id": "e1" }, controller.signal);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
			// Land a row while the connection is open: replay and live are one path.
			stub.append({ id: "e4", ts: BASE + 3, summary: "landed after connect" });
			const got = frames(await streamText(response, controller, 3));
			expect(got.map((frame) => frame.id)).toEqual(["e2", "e3", "e4"]);
			// The frame body is the ledger event shape the query read returns.
			const event = JSON.parse(got[0]!.data) as Record<string, unknown>;
			expect(event).toMatchObject({ id: "e2", surface: "omp", kind: "note", summary: "second", hash: "h-e2" });
			// Greptime's epoch millis rebuilt as the ISO string the chain hashed.
			expect(event.ts).toBe(new Date(BASE + 1).toISOString());
		} finally {
			await stop();
		}
	});

	test("a stream with no cursor starts live from connect, not from the first tick", async () => {
		const stub = streamLedger([]);
		const { get, stop } = await serve(stub, { SUBSTRATE_TOKEN_OMP: "tok-omp" }, {}, { streamPollMs: 10, streamIdleMs: 60_000 });
		try {
			const controller = new AbortController();
			const response = await get("/events/stream", { authorization: "Bearer tok-omp" }, controller.signal);
			expect(response.status).toBe(200);
			// Landed after the response opened but before any poll tick: the start
			// boundary was captured while the ledger was empty, so this first event
			// is strictly after it and is delivered. A tip read at the first tick
			// instead would have adopted this event as the starting cursor and
			// sent it to no one.
			stub.append({ id: "e1", ts: BASE, summary: "arrived before the first tick" });
			const got = frames(await streamText(response, controller, 1, 2_000));
			expect(got.map((frame) => frame.id)).toEqual(["e1"]);
		} finally {
			await stop();
		}
	});

	test("a cursorless stream on a non-empty ledger replays nothing but sends what comes later", async () => {
		const stub = streamLedger([{ id: "e0", ts: BASE, summary: "already there" }]);
		const { get, stop } = await serve(stub, { SUBSTRATE_TOKEN_OMP: "tok-omp" }, {}, { streamPollMs: 10, streamIdleMs: 60_000 });
		try {
			const controller = new AbortController();
			const response = await get("/events/stream", { authorization: "Bearer tok-omp" }, controller.signal);
			expect(response.status).toBe(200);
			// Live start: the position the ledger already had at connect (e0), so
			// nothing replays — and an event after connect is the first frame, not
			// the cursor the first tick would have read.
			stub.append({ id: "e1", ts: BASE + 1, summary: "later" });
			const got = frames(await streamText(response, controller, 1, 2_000));
			expect(got.map((frame) => frame.id)).toEqual(["e1"]);
		} finally {
			await stop();
		}
	});

	test("a ledger that cannot resolve the live start answers an ordinary error", async () => {
		const stub = streamLedger([]);
		stub.latestPosition = async () => {
			throw new Error("greptime unreachable: connect ETIMEDOUT");
		};
		const { get, stop } = await serve(stub, { SUBSTRATE_TOKEN_OMP: "tok-omp" });
		try {
			const response = await get("/events/stream", { authorization: "Bearer tok-omp" });
			expect(response.status).toBe(503);
			expect(response.headers.get("content-type") ?? "").toContain("application/json");
			expect(String(((await response.json()) as Record<string, unknown>).error)).toContain("stream start");
		} finally {
			await stop();
		}
	});

	test("?cursor= replays the same window, and the idle timeout closes the stream", async () => {
		const stub = streamLedger([
			{ id: "e1", ts: BASE, summary: "first" },
			{ id: "e2", ts: BASE + 1, summary: "second" },
			{ id: "e3", ts: BASE + 2, summary: "third" },
		]);
		const { get, stop } = await serve(stub, { SUBSTRATE_TOKEN_OMP: "tok-omp" }, {}, { streamPollMs: 10, streamIdleMs: 100 });
		try {
			const controller = new AbortController();
			const response = await get("/events/stream?cursor=e1", { authorization: "Bearer tok-omp" }, controller.signal);
			expect(response.status).toBe(200);
			// The replay drains (e2, e3), then 100 ms of silence closes the stream
			// from the server side — the client reconnects with Last-Event-ID and
			// resumes, the ledger having held the gap.
			const got = frames(await streamText(response, controller));
			expect(got.map((frame) => frame.id)).toEqual(["e2", "e3"]);
		} finally {
			await stop();
		}
	});

	test("a disconnected client stops the poll timer", async () => {
		const stub = streamLedger([{ id: "e1", ts: BASE, summary: "first" }]);
		const { get, stop } = await serve(
			stub,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp" },
			{},
			{ streamPollMs: 20, streamIdleMs: 60_000 },
		);
		try {
			const controller = new AbortController();
			const response = await get("/events/stream", { authorization: "Bearer tok-omp", "last-event-id": "e1" }, controller.signal);
			expect(response.status).toBe(200);
			// Polls run until the read count proves the interval is live. The tick
			// reads the ledger *before* checking the socket, so a timer nobody
			// cleared would keep counting reads here.
			await until(() => stub.reads.length >= 3);
			controller.abort();
			// Let any poll already in flight land, then hold the line: a quiet
			// period is the only way to observe that nothing more arrives.
			await delay(60);
			const after = stub.reads.length;
			await delay(120);
			expect(stub.reads.length).toBe(after);
		} finally {
			await stop();
		}
	});

	test("a client that leaves during the start read leaves no timer behind", async () => {
		const stub = streamLedger([{ id: "e1", ts: BASE, summary: "first" }]);
		const { get, stop } = await serve(stub, { SUBSTRATE_TOKEN_OMP: "tok-omp" }, {}, { streamPollMs: 10, streamIdleMs: 60_000 });
		try {
			// The start read hangs until the test releases it, so the socket can
			// be torn down while the route is still awaiting the ledger — before
			// the response ever opens.
			const { promise: gated, resolve: release } = Promise.withResolvers<void>();
			let startReads = 0;
			const ungated = stub.latestPosition;
			stub.latestPosition = async () => {
				startReads += 1;
				await gated;
				return ungated();
			};
			const controller = new AbortController();
			// No response can open while the start read hangs, so the request can
			// only end in the abort below; the rejection is expected.
			const pending = get("/events/stream", { authorization: "Bearer tok-omp" }, controller.signal).catch(() => null);
			await until(() => startReads >= 1);
			controller.abort();
			// Let the disconnect land server-side before setup can resume.
			await delay(20);
			release();
			await pending;
			// The cleanup listeners sit before the setup reads, so the vanished
			// socket reaches them and setup returns without starting the poll
			// interval — no read ever happens, on this tick or any other.
			await delay(60);
			expect(stub.reads.length).toBe(0);
		} finally {
			await stop();
		}
	});

	test("a slow consumer is cut off once its backlog passes the cap", async () => {
		const big = "x".repeat(64 * 1024);
		const stub = streamLedger([
			{ id: "e1", ts: BASE, summary: "first" },
			{ id: "e2", ts: BASE + 1, summary: big },
			{ id: "e3", ts: BASE + 2, summary: big },
		]);
		const { get, stop } = await serve(
			stub,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp" },
			{},
			{ streamPollMs: 10, streamIdleMs: 60_000, streamMaxBacklogBytes: 1024 },
		);
		try {
			const controller = new AbortController();
			const response = await get("/events/stream", { authorization: "Bearer tok-omp", "last-event-id": "e1" }, controller.signal);
			expect(response.status).toBe(200);
			// The first frame already exceeds the cap, so the connection is cut
			// rather than buffered: the stream ends long before the idle timeout,
			// and a reconnect would replay from Last-Event-ID. A stream that kept
			// polling would run hundreds of reads inside the deadline instead.
			const got = frames(await streamText(response, controller, Number.POSITIVE_INFINITY, 2_000));
			expect(got.length).toBeGreaterThanOrEqual(1);
			expect(stub.reads.length).toBeLessThanOrEqual(3);
		} finally {
			await stop();
		}
	});

	test("a replay wider than one batch continues across polls in order", async () => {
		const events = Array.from({ length: 250 }, (_, i) => ({ id: `e${i}`, ts: BASE + i, summary: `row ${i}` }));
		const stub = streamLedger(events);
		const { get, stop } = await serve(stub, { SUBSTRATE_TOKEN_OMP: "tok-omp" }, {}, { streamPollMs: 10, streamIdleMs: 150 });
		try {
			const controller = new AbortController();
			const response = await get("/events/stream?cursor=e0", { authorization: "Bearer tok-omp" }, controller.signal);
			expect(response.status).toBe(200);
			const got = frames(await streamText(response, controller, Number.POSITIVE_INFINITY, 3_000)).map((frame) => frame.id);
			expect(got.length).toBe(249);
			expect(got[0]).toBe("e1");
			expect(got[248]).toBe("e249");
			// No poll ever asked past the batch bound — the ledger is the buffer,
			// and a connection reads at most a batch per tick from its own cursor.
			expect(Math.max(...stub.reads.map((read) => read.limit))).toBe(STREAM_BATCH);
		} finally {
			await stop();
		}
	});

	test("a ledger that cannot resolve the cursor answers an ordinary error", async () => {
		const stub = streamLedger([]);
		stub.cursorPosition = async () => {
			throw new Error("greptime unreachable: connect ETIMEDOUT");
		};
		const { get, stop } = await serve(stub, { SUBSTRATE_TOKEN_OMP: "tok-omp" });
		try {
			const response = await get("/events/stream", { authorization: "Bearer tok-omp", "last-event-id": "e1" });
			expect(response.status).toBe(503);
			expect(response.headers.get("content-type") ?? "").toContain("application/json");
			expect(String(((await response.json()) as Record<string, unknown>).error)).toContain("cursor");
		} finally {
			await stop();
		}
	});

	test("a run with no ledger refuses the stream", async () => {
		const { get, stop } = await serve(null, { SUBSTRATE_TOKEN_OMP: "tok-omp" });
		try {
			const response = await get("/events/stream", { authorization: "Bearer tok-omp" });
			expect(response.status).toBe(503);
			expect(String(((await response.json()) as Record<string, unknown>).error)).toContain("GREPTIME_URL");
		} finally {
			await stop();
		}
	});

	test("an open stream leaves every other route working", async () => {
		const stub = streamLedger([{ id: "e1", ts: BASE, summary: "first" }]);
		const { get, post, stop } = await serve(
			stub,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp" },
			{},
			{ streamPollMs: 20, streamIdleMs: 60_000 },
		);
		try {
			const controller = new AbortController();
			const open = await get("/events/stream", { authorization: "Bearer tok-omp", "last-event-id": "e1" }, controller.signal);
			expect(open.status).toBe(200);
			// Reads and writes on the same server while the stream is open — the
			// emit path never touches subscriber state.
			const query = await post("/events/query", { repo: "r" }, { authorization: "Bearer tok-omp" });
			expect(query.status).toBe(200);
			const emit = await post("/events", { kind: "note", summary: "still working", session_id: "s" }, { authorization: "Bearer tok-omp" });
			expect(emit.status).toBe(202);
			controller.abort();
		} finally {
			await stop();
		}
	});

	/** A bus stand-in: each open stream's subscription is one listener here, and a test wakes them with a hint. */
	function fakeHub() {
		const listeners = new Set<(hint: EventHint) => void>();
		const bus: EventBus = {
			publish: async () => true,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			stop: () => {},
		};
		return {
			bus,
			listeners,
			wake: (id: string) => {
				const hint: EventHint = { v: 1, id, kind: "note", surface: "omp", graph_id: null, ts: new Date(BASE).toISOString() };
				for (const listener of [...listeners]) listener(hint);
			},
		};
	}

	test("a hint wakes an idle stream, which reads the ledger and delivers the new event before its idle timeout", async () => {
		const stub = streamLedger([]);
		const hub = fakeHub();
		const { get, stop } = await serve(stub, { SUBSTRATE_TOKEN_OMP: "tok-omp" }, { eventBus: () => hub.bus }, { streamPollMs: 60_000, streamIdleMs: 60_000 });
		try {
			const controller = new AbortController();
			const response = await get("/events/stream", { authorization: "Bearer tok-omp" }, controller.signal);
			expect(response.status).toBe(200);
			expect(hub.listeners.size).toBe(1);
			// The poll and the idle close are both 60 s away, so only the hint can deliver this inside the 5 s read.
			stub.append({ id: "e1", ts: BASE, summary: "landed during a long idle wait" });
			hub.wake("e1");
			const got = frames(await streamText(response, controller, 1, 5_000));
			expect(got.map((frame) => frame.id)).toEqual(["e1"]);
		} finally {
			await stop();
		}
	});

	test("a hint that arrives during a ledger read makes the stream read again at once, not at the long poll", async () => {
		const stub = streamLedger([]);
		const hub = fakeHub();
		const answer = stub.eventIdsAfter;
		const gate = Promise.withResolvers<void>();
		let started = 0;
		stub.eventIdsAfter = async (cursor, limit) => {
			started += 1;
			if (started === 1) await gate.promise;
			return answer(cursor, limit);
		};
		const { get, stop } = await serve(stub, { SUBSTRATE_TOKEN_OMP: "tok-omp" }, { eventBus: () => hub.bus }, { streamPollMs: 60_000, streamIdleMs: 60_000 });
		try {
			const controller = new AbortController();
			const response = await get("/events/stream", { authorization: "Bearer tok-omp" }, controller.signal);
			expect(response.status).toBe(200);
			// The first hint starts a ledger read and holds it open; the second arrives while that read is in flight.
			hub.wake("e1");
			hub.wake("e2");
			expect(started).toBe(1);
			gate.resolve();
			// The read finished empty, so only the remembered hint can start this second read: the poll is 60 s away.
			await until(() => started === 2);
			controller.abort();
		} finally {
			await stop();
		}
	});

	test("the stream holds its subscription for the life of the response and releases it when the response closes", async () => {
		const hub = fakeHub();
		const { get, stop } = await serve(streamLedger([]), { SUBSTRATE_TOKEN_OMP: "tok-omp" }, { eventBus: () => hub.bus }, { streamPollMs: 60_000, streamIdleMs: 60_000 });
		try {
			const controller = new AbortController();
			await get("/events/stream", { authorization: "Bearer tok-omp" }, controller.signal);
			expect(hub.listeners.size).toBe(1);
			controller.abort();
			await until(() => hub.listeners.size === 0);
		} finally {
			await stop();
		}
	});

	test("with the bus off the stream delivers on its poll alone", async () => {
		const stub = streamLedger([]);
		const { get, stop } = await serve(stub, { SUBSTRATE_TOKEN_OMP: "tok-omp" }, { eventBus: () => null }, { streamPollMs: 10, streamIdleMs: 60_000 });
		try {
			const controller = new AbortController();
			const response = await get("/events/stream", { authorization: "Bearer tok-omp" }, controller.signal);
			expect(response.status).toBe(200);
			stub.append({ id: "e1", ts: BASE, summary: "arrived with the bus off" });
			const got = frames(await streamText(response, controller, 1, 2_000));
			expect(got.map((frame) => frame.id)).toEqual(["e1"]);
		} finally {
			await stop();
		}
	});
});

describe("agent card route", () => {
	/** One live teachable fact, as the index would hand it to the reader. */
	function teachable(id: string, writer: string, subject = "teachable:retry-budget"): MemoryEntry {
		return {
			id,
			scope: "graph:ut-1",
			kind: "fact",
			text: "retry with a capped budget and backoff",
			writer,
			subject,
			actor: "agent",
			trust: "agent-claimed",
			ttl: "graph",
			created: "2026-10-10T00:00:00.000Z",
			version: 1,
			entry_hash: "ef".repeat(32),
			needs_reverification: false,
		};
	}

	/**
	 * The real server with a stub index behind the card reader — the filtering
	 * is pinned in agent-card.test.ts, so this is about the wiring: status,
	 * shape and who may ask.
	 */
	async function serveCard(rows: MemoryEntry[], env: Record<string, string | undefined> = {}) {
		const config = loadConfig(env);
		const observability = createObservability(config, env);
		await observability.start();
		const index = {
			searchMemoryPage: async () => ({ entries: rows, next: null }),
		};
		const substrate = new Substrate(config, { index: index as never, greptime: null }, observability.observer);
		const server = createHttpServer(substrate, config, observability);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		return {
			port,
			get: (path: string, headers: Record<string, string> = {}) =>
				fetch(`http://127.0.0.1:${port}${path}`, { headers }),
			post: (path: string, headers: Record<string, string> = {}) =>
				fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers, body: "{}" }),
			stop: () =>
				new Promise<void>((resolve) => {
					observability.stop();
					server.close(() => resolve());
				}),
		};
	}

	test("a known surface gets a 200 validator-clean card listing its teachable", async () => {
		const { get, stop } = await serveCard([teachable("mem_7", "hermes")]);
		try {
			const response = await get("/.well-known/agent-card.json?surface=hermes");
			const card = (await response.json()) as Record<string, unknown>;

			expect(response.status).toBe(200);
			expect(validateAgentCard(card)).toEqual([]);
			const skills = card.skills as Array<Record<string, unknown>>;
			expect(skills).toHaveLength(1);
			expect(skills[0]?.id).toBe("mem_7");
			expect(skills[0]?.name).toBe("retry-budget");
			expect(String(card.url)).toContain("/.well-known/agent-card.json?surface=hermes");
		} finally {
			await stop();
		}
	});

	test("a missing surface is a 400 naming the parameter", async () => {
		const { get, stop } = await serveCard([]);
		try {
			const response = await get("/.well-known/agent-card.json");
			const body = (await response.json()) as Record<string, unknown>;

			expect(response.status).toBe(400);
			expect(String(body.error)).toContain("surface");
		} finally {
			await stop();
		}
	});

	test("an unknown surface is a 400, never a default card", async () => {
		const { get, stop } = await serveCard([teachable("mem_7", "hermes")]);
		try {
			const response = await get("/.well-known/agent-card.json?surface=nope");

			expect(response.status).toBe(400);
		} finally {
			await stop();
		}
	});

	test("a configured token closes the card and authoring until a bearer is sent", async () => {
		const { get, post, stop } = await serveCard([teachable("mem_7", "hermes")], {
			SUBSTRATE_TOKEN_HERMES: "tok-hermes",
		});
		try {
			// Same gate as every other route: only /healthz stays open once a token exists.
			expect((await get("/.well-known/agent-card.json?surface=hermes")).status).toBe(401);
			expect((await post("/events/query")).status).toBe(401);
			const card = await get("/.well-known/agent-card.json?surface=hermes", {
				authorization: "Bearer tok-hermes",
			});
			expect(card.status).toBe(200);
			expect(validateAgentCard((await card.json()) as Record<string, unknown>)).toEqual([]);
		} finally {
			await stop();
		}
	});

	test("an anonymous caller still gets a 200 where anonymous callers are accepted", async () => {
		const { get, stop } = await serveCard([teachable("mem_7", "hermes")], {
			SUBSTRATE_ALLOW_ANONYMOUS: "1",
			SUBSTRATE_TOKEN_HERMES: "tok-hermes",
		});
		try {
			// No bearer: A2A discovery is read-only, the /healthz exemption class.
			const response = await get("/.well-known/agent-card.json?surface=hermes");

			expect(response.status).toBe(200);
			expect(validateAgentCard((await response.json()) as Record<string, unknown>)).toEqual([]);
		} finally {
			await stop();
		}
	});

	test("a tokened caller asks only for its own surface's card: another is 403, its own is 200", async () => {
		const { get, stop } = await serveCard([teachable("mem_7", "cursor")], { SUBSTRATE_TOKEN_CURSOR: "tok-cursor" });
		try {
			const bearer = { authorization: "Bearer tok-cursor" };
			expect((await get("/.well-known/agent-card.json?surface=swarm-a05-be", bearer)).status).toBe(403);
			expect((await get("/.well-known/agent-card.json?surface=cursor", bearer)).status).toBe(200);
		} finally {
			await stop();
		}
	});

	test("a hostile Origin is refused even with a valid bearer, and a loopback Origin is not", async () => {
		const { port, stop } = await serveCard([teachable("mem_7", "cursor")], { SUBSTRATE_TOKEN_CURSOR: "tok-cursor" });
		try {
			const path = "/.well-known/agent-card.json?surface=cursor";
			const authorization = "Bearer tok-cursor";
			expect(await rawRequest(port, { path, headers: { authorization, origin: "https://evil.example" } })).toBe(403);
			expect(await rawRequest(port, { path, headers: { authorization, origin: "http://localhost:5173" } })).toBe(200);
		} finally {
			await stop();
		}
	});
});

describe("HTTP edge", () => {
	const bearer = { authorization: "Bearer tok-omp" };

	test("a POST from a hostile Origin is 403 even with a valid bearer", async () => {
		const { port, stop } = await serve(null, { SUBSTRATE_TOKEN_OMP: "tok-omp" });
		try {
			const status = await rawRequest(port, {
				method: "POST",
				path: "/events/query",
				headers: { ...bearer, "content-type": "application/json", origin: "https://evil.example" },
			});
			expect(status).toBe(403);
		} finally {
			await stop();
		}
	});

	test("a Host that is neither loopback on the bound port nor the public origin is 421", async () => {
		const { port, stop } = await serve(null, { SUBSTRATE_PUBLIC_ORIGIN: "https://substrate.example.test" });
		try {
			expect(await rawRequest(port, { path: "/livez", headers: { host: "evil.example" } })).toBe(421);
			expect(await rawRequest(port, { path: "/livez", headers: { host: "127.0.0.1:1" } })).toBe(421);
			expect(await rawRequest(port, { path: "/livez", headers: { host: `localhost:${port}` } })).toBe(200);
			expect(await rawRequest(port, { path: "/livez", headers: { host: "substrate.example.test" } })).toBe(200);
		} finally {
			await stop();
		}
	});

	test("a malformed Host is a 400, and the next request is still answered", async () => {
		const { port, stop } = await serve(null);
		try {
			expect(await rawRequest(port, { path: "/livez", headers: { host: "bad host" } })).toBe(400);
			expect(await rawRequest(port, { path: "/livez", headers: { host: `127.0.0.1:${port}` } })).toBe(200);
		} finally {
			await stop();
		}
	});

	test("a POST whose body is not application/json is 415, and an unauthenticated one is still 401", async () => {
		const { post, stop } = await serve(null, { SUBSTRATE_TOKEN_OMP: "tok-omp" });
		try {
			expect((await post("/events/query", {}, { ...bearer, "content-type": "text/plain" })).status).toBe(415);
			expect((await post("/memory/recall", {}, { ...bearer, "content-type": "text/plain" })).status).toBe(415);
			expect((await post("/events/query", {}, { "content-type": "text/plain" })).status).toBe(401);
			expect((await post("/events/query", {}, { ...bearer, "content-type": "application/json; charset=utf-8" })).status).not.toBe(415);
		} finally {
			await stop();
		}
	});

	test("/mcp refuses a declared body over the cap before reading it", async () => {
		const { port, stop } = await serve(null, { SUBSTRATE_TOKEN_OMP: "tok-omp" });
		try {
			// No body is sent. A server that read first would wait for one; this one answers at once. The cap is 6 000 000 bytes.
			const status = await rawRequest(port, {
				method: "POST",
				path: "/mcp",
				headers: { ...bearer, "content-type": "application/json", "content-length": "6000001" },
			});
			expect(status).toBe(413);
		} finally {
			await stop();
		}
	});

	test("a tokened caller's /brief body cannot name another surface", async () => {
		const { post, stop } = await serve(null, { SUBSTRATE_TOKEN_CURSOR: "tok-cursor" });
		try {
			const response = await post("/brief", { repo: "owner/name", surface: "swarm-a05-be" }, { authorization: "Bearer tok-cursor" });
			expect(response.status).toBe(403);
			expect(String(((await response.json()) as Record<string, unknown>).error)).toContain("swarm-a05-be");
		} finally {
			await stop();
		}
	});
});

describe("surfaceClaimRefusal", () => {
	test("a tokened caller's own surface, or no claim at all, stands", () => {
		expect(surfaceClaimRefusal("cursor", "cursor")).toBeNull();
		expect(surfaceClaimRefusal("cursor", undefined)).toBeNull();
		expect(surfaceClaimRefusal("cursor", null)).toBeNull();
	});

	test("another surface is refused, and a value that is not a surface is named as unrecognised", () => {
		expect(surfaceClaimRefusal("cursor", "swarm-a05-be")).toBe("this token is cursor and cannot act as swarm-a05-be");
		expect(surfaceClaimRefusal("cursor", { surface: "hermes" })).toBe("this token is cursor and cannot act as an unrecognised surface");
	});

	test("an untokened caller's claim is not refused here", () => {
		expect(surfaceClaimRefusal(null, "swarm-a05-be")).toBeNull();
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

describe("scanIngestPages", () => {
	test("sweeps directory roots, reads file roots, skips links and absences, and sorts by path", async () => {
		const root = mkdtempSync(join(tmpdir(), "substrate-scan-"));
		try {
			mkdirSync(join(root, "docs", "sub"), { recursive: true });
			writeFileSync(join(root, "README.md"), "The substrate is the only door.");
			writeFileSync(join(root, "docs", "a.md"), "alpha");
			writeFileSync(join(root, "docs", "sub", "b.md"), "beta");
			// A link can leave the checkout and the roots guards have no real path
			// to check against, so a sweep skips it instead of following it.
			symlinkSync(join(root, "README.md"), join(root, "docs", "link.md"));

			const pages = await scanIngestPages(root, ["docs/", "README.md", ".planning/PROJECT.md", "missing.md"]);
			expect(pages.map((page) => page.path)).toEqual(["README.md", "docs/a.md", "docs/sub/b.md"]);
			expect(pages[0]?.body).toBe("The substrate is the only door.");
			expect(pages[0]?.source_url).toBe(`file://${join(root, "README.md")}`);
			expect(pages.every((page) => page.source_url?.startsWith("file://") === true)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an absent base directory sweeps to nothing, which the ingest refuses as no-pages", async () => {
		const pages = await scanIngestPages(join(tmpdir(), "substrate-nowhere-9182"), ["docs/", "README.md"]);
		expect(pages).toEqual([]);
	});
});
