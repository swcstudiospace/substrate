import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import type { EventQuery } from "./greptime.ts";
import { createHttpServer, healthStatus } from "./server.ts";
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
	async function serve(greptime: unknown, env: Record<string, string | undefined> = {}) {
		const config = loadConfig(env);
		const substrate = new Substrate(config, { index: null, greptime: greptime as never });
		const server = createHttpServer(substrate, config);
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
			stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
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
