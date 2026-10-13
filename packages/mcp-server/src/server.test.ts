import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import type { EventQuery } from "./greptime.ts";
import { memoryToolWriter } from "./mcp.ts";
import { createObservability } from "./observe.ts";
import type { FetchLike } from "./planes/ragflow.ts";
import { RagflowFake } from "./ragflow-fake.ts";
import { createHttpServer, healthStatus, isLoopbackRemote, memoryWriteStatus, memoryWriter } from "./server.ts";
import { Substrate } from "./service.ts";
import type { SubstrateEvent } from "./types.ts";

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
		stores: { ragflowFetch?: FetchLike } = {},
	) {
		const config = loadConfig(env);
		// No SUBSTRATE_AUDIT_PATH in the env, so the audit chain stays in memory and the
		// exporter is off: these routes are audited, and a test that skipped the plane
		// entirely would not be running the code the server actually runs.
		const observability = createObservability(config, env);
		await observability.start();
		const substrate = new Substrate(config, { index: null, greptime: greptime as never, ...stores }, observability.observer);
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
			stop: () =>
				new Promise<void>((resolve) => {
					observability.stop();
					server.close(() => resolve());
				}),
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

	test("isLoopbackRemote takes the whole 127/8 and ::1, refuses everything else", () => {
		for (const good of ["127.0.0.1", "127.9.240.1", "::1", "::ffff:127.0.0.1"]) {
			expect(isLoopbackRemote(good)).toBe(true);
		}
		for (const bad of ["10.1.2.3", "::ffff:10.1.2.3", "::c0a8:1", "192.168.0.4", "", undefined, "127.cache.example.com"]) {
			expect(isLoopbackRemote(bad)).toBe(false);
		}
	});

	test("POST /docs/merge-trigger refreshes agent-substrate by default and records the version", async () => {
		const { greptime, written } = ledger();
		const fake = new RagflowFake();
		const restore = patchFetch(fake.fetch);
		const { post, stop } = await serve(
			greptime,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" },
		);
		try {
			const response = await post("/docs/merge-trigger", { commit: "c-merge", content_sha256: "sha-merge" }, { authorization: "Bearer tok-omp" });
			const body = (await response.json()) as { ok: boolean; version?: { dataset: string; dataset_id: string; version: string; commit: string }; created?: boolean };
			expect(response.status).toBe(200);
			expect(body.ok).toBe(true);
			expect(body.version?.dataset).toBe("agent-substrate");
			expect(body.version?.dataset_id).toBe("ds-berlin-agent-substrate");
			expect(body.version?.version).toBe("v1");
			expect(body.version?.commit).toBe("c-merge");
			// The refresh emitted its ledger event for the right dataset id.
			const events = ingestEvents(written);
			expect(events).toHaveLength(1);
			expect(events[0]?.dataset_id).toBe("ds-berlin-agent-substrate");
		} finally {
			restore();
			await stop();
		}
	});

	test("POST /docs/merge-trigger names a requested dataset and dedupes by content hash", async () => {
		const { greptime, written } = ledger();
		const fake = new RagflowFake();
		const restore = patchFetch(fake.fetch);
		const { post, stop } = await serve(
			greptime,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" },
		);
		try {
			const first = await post("/docs/merge-trigger", { dataset: "agent-skills", commit: "c-ff", content_sha256: "sha-ff" }, { authorization: "Bearer tok-omp" });
			const firstBody = (await first.json()) as { ok: boolean; version?: { dataset: string; dataset_id: string; version: string }; idempotent?: boolean };
			expect(first.status).toBe(200);
			expect(firstBody.version?.dataset).toBe("agent-skills");
			expect(firstBody.version?.dataset_id).toBe("ds-leipzig-agent-skills");
			expect(firstBody.version?.version).toBe("v1");
			expect(firstBody.idempotent).toBeUndefined();

			// The same commit and hash again: the newest version's own identity, so no
			// second version is recorded and the reply says it answered from the record.
			const repeat = await post("/docs/merge-trigger", { dataset: "agent-skills", commit: "c-ff", content_sha256: "sha-ff" }, { authorization: "Bearer tok-omp" });
			const repeatBody = (await repeat.json()) as { ok: boolean; version?: { version: string }; idempotent?: boolean };
			expect(repeat.status).toBe(200);
			expect(repeatBody.idempotent).toBe(true);
			expect(repeatBody.version?.version).toBe("v1");
			expect(ingestEvents(written)).toHaveLength(1);

			// New content: a real second version.
			const next = await post("/docs/merge-trigger", { dataset: "agent-skills", commit: "c-ff2", content_sha256: "sha-ff2" }, { authorization: "Bearer tok-omp" });
			const nextBody = (await next.json()) as { ok: boolean; version?: { version: string } };
			expect(next.status).toBe(200);
			expect(nextBody.version?.version).toBe("v2");
			expect(ingestEvents(written)).toHaveLength(2);
		} finally {
			restore();
			await stop();
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
		const { greptime } = ledger();
		const restore = patchFetch(async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:9");
		});
		const { post, stop } = await serve(
			greptime,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" },
		);
		try {
			const response = await post("/docs/merge-trigger", { commit: "c-merge", content_sha256: "sha-merge" }, { authorization: "Bearer tok-omp" });
			const body = (await response.json()) as { ok: boolean; reason?: string };
			expect(response.status).toBe(503);
			expect(body.ok).toBe(false);
			expect(body.reason).toContain("ragflow unreachable");
		} finally {
			restore();
			await stop();
		}
	});

	test("POST /docs/merge-trigger refuses an unknown dataset and a body without the hash", async () => {
		const { greptime } = ledger();
		const { post, stop } = await serve(
			greptime,
			{ SUBSTRATE_TOKEN_OMP: "tok-omp", RAGFLOW_URL: "http://ragflow.test", RAGFLOW_API_KEY: "k" },
		);
		try {
			const unknown = await post("/docs/merge-trigger", { dataset: "not-a-dataset", commit: "c", content_sha256: "s" }, { authorization: "Bearer tok-omp" });
			expect(unknown.status).toBe(400);
			const hashless = await post("/docs/merge-trigger", { commit: "c" }, { authorization: "Bearer tok-omp" });
			expect(hashless.status).toBe(400);
			const scalar = await post("/docs/merge-trigger", 42, { authorization: "Bearer tok-omp" });
			expect(scalar.status).toBe(400);
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
