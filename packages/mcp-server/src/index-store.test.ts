/**
 * Row-to-entry mapping, and the parts of the client that need no database.
 *
 * The SQL in `IndexStore` needs a live Postgres, so it is proved by the live
 * Phase 0.5 run rather than here. What *is* testable without one is the mapping —
 * and it is worth testing, because it is where a Phase 0 row written before the
 * governance gate meets a type that now expects governance columns — plus the
 * pool settings the constructor composes, and a bounded `ping` against a socket
 * that never answers.
 */
import { describe, expect, test } from "bun:test";
import type { PlaneSample } from "@substrate/observability";
import {
	DEFAULT_INDEX_POOL_SETTINGS,
	INDEX_APPLICATION_NAME,
	INDEX_MAX_LIFETIME_S,
	IndexStore,
	indexPoolSettingsFromEnv,
	indexSqlOptions,
	toLinearNodeMatch,
	toMemoryEntry,
	type LinearNodeMatch,
} from "./index-store.ts";

const CREATED = new Date("2026-09-30T00:00:00.000Z");

/** The shape Postgres hands back for a fully governed entry. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "mem_1",
		scope: "repo:swcstudiospace/agent-substrate",
		kind: "decision",
		body: "the runtime is herdr",
		subject: "runtime",
		writer: "hermes",
		actor: "agent",
		trust: "agent-claimed",
		ttl: "permanent",
		created: CREATED,
		version: 2,
		supersedes: "mem_0",
		superseded_by: null,
		entry_hash: "abc",
		reverify_after: new Date("2026-10-14T00:00:00.000Z"),
		idempotency_key: "k1",
		source_event: "evt_1",
		session_id: "sess-1",
		graph_id: "ut-1",
		repo: "swcstudiospace/agent-substrate",
		...over,
	};
}

describe("toMemoryEntry", () => {
	test("carries provenance and version through", () => {
		expect(toMemoryEntry(row(), CREATED.getTime())).toMatchObject({
			id: "mem_1",
			actor: "agent",
			version: 2,
			supersedes: "mem_0",
			entry_hash: "abc",
			session_id: "sess-1",
			graph_id: "ut-1",
			reverify_after: "2026-10-14T00:00:00.000Z",
		});
	});

	test("derives needs_reverification on read, so an entry decays where it sits", () => {
		// No sweeper job exists, and one that ran hourly would still leave an hour in
		// which a stale entry read as settled.
		expect(toMemoryEntry(row(), CREATED.getTime()).needs_reverification).toBe(false);
		expect(toMemoryEntry(row(), Date.parse("2026-10-20T00:00:00.000Z")).needs_reverification).toBe(true);
	});

	test("a row written before the gate reads as an honest version 1", () => {
		// Phase 0 wrote memory_entries with none of these columns. The migration
		// backfills the defaults; this asserts the mapping does not then invent
		// anything — no hash, no deadline, and so nothing reported as decayed.
		const legacy = toMemoryEntry(
			{
				id: "mem_old",
				scope: "global",
				kind: "warning",
				body: "disk is at 90%",
				writer: "claude-code",
				trust: "agent-claimed",
				ttl: "permanent",
				created: CREATED,
				actor: "agent",
				version: 1,
				subject: null,
				supersedes: null,
				superseded_by: null,
				entry_hash: null,
				reverify_after: null,
				idempotency_key: null,
				source_event: null,
				session_id: null,
				graph_id: null,
				repo: null,
			},
			Date.parse("2027-01-01T00:00:00.000Z"),
		);

		expect(legacy.version).toBe(1);
		expect(legacy.entry_hash).toBe("");
		expect(legacy.reverify_after).toBeUndefined();
		expect(legacy.needs_reverification).toBe(false);
		expect(legacy.subject).toBeUndefined();
	});

	test("an unrecognised actor reads as an agent", () => {
		// The column is text, and `actor: human` is the claim that needs a reviewer's
		// token — so anything that is not exactly that is an agent.
		expect(toMemoryEntry(row({ actor: "operator" })).actor).toBe("agent");
		expect(toMemoryEntry(row({ actor: "human" })).actor).toBe("human");
	});

	test("a timestamptz that arrived as a string is still an ISO string out", () => {
		const entry = toMemoryEntry(row({ created: "2026-09-30 00:00:00+00" }));
		expect(entry.created).toBe("2026-09-30 00:00:00+00");
	});
});

describe("toLinearNodeMatch", () => {
	test("a Postgres BIGINT epoch arrives numeric with the joined graph columns intact", () => {
		// The driver hands lease_epoch back as a string, which would otherwise
		// serialise beside the numeric lease.epoch as a second value for one thing.
		const match = toLinearNodeMatch({
			graph_id: "ut-1",
			node_id: "n2",
			linear_issue_id: "uuid-SWC-467",
			linear_identifier: "SWC-467",
			notion_page: null,
			state: "started",
			claimed_by: "hermes",
			claimed_at: "2026-10-09T00:00:00.000Z",
			claim_session: "sess-a",
			lease_id: "lse_live",
			lease_expires_at: "2026-10-09T01:00:00.000Z",
			lease_heartbeat_at: "2026-10-09T00:00:00.000Z",
			lease_epoch: "3" as unknown as number,
			repo: "swcstudiospace/x",
			branch: "main",
			graph_status: "open",
		} as unknown as LinearNodeMatch);

		expect(match.lease_epoch).toBe(3);
		expect(typeof match.lease_epoch).toBe("number");
		expect(match.repo).toBe("swcstudiospace/x");
		expect(match.branch).toBe("main");
		expect(match.graph_status).toBe("open");
	});
});

describe("indexPoolSettingsFromEnv", () => {
	test("an empty environment is the documented defaults", () => {
		expect(indexPoolSettingsFromEnv({})).toEqual({
			max: 8,
			connectTimeoutMs: 2000,
			statementTimeoutMs: 5000,
			idleTimeoutS: 300,
			applicationName: "substrate-mcp",
		});
		expect(indexPoolSettingsFromEnv({})).toEqual(DEFAULT_INDEX_POOL_SETTINGS);
	});

	test("values are read and clamped into their bounds", () => {
		expect(
			indexPoolSettingsFromEnv({
				SUBSTRATE_PG_POOL_MAX: "4",
				SUBSTRATE_PG_CONNECT_TIMEOUT_MS: "900",
				SUBSTRATE_PG_STATEMENT_TIMEOUT_MS: "0",
				SUBSTRATE_PG_IDLE_TIMEOUT_S: "0",
			}),
		).toEqual({ max: 4, connectTimeoutMs: 900, statementTimeoutMs: 0, idleTimeoutS: 0, applicationName: "substrate-mcp" });
		const clamped = indexPoolSettingsFromEnv({
			SUBSTRATE_PG_POOL_MAX: "500",
			SUBSTRATE_PG_CONNECT_TIMEOUT_MS: "1",
			SUBSTRATE_PG_STATEMENT_TIMEOUT_MS: "99999999",
			SUBSTRATE_PG_IDLE_TIMEOUT_S: "999999",
		});
		expect(clamped.max).toBe(50);
		expect(clamped.connectTimeoutMs).toBe(200);
		expect(clamped.statementTimeoutMs).toBe(600_000);
		expect(clamped.idleTimeoutS).toBe(86_400);
		expect(indexPoolSettingsFromEnv({ SUBSTRATE_PG_POOL_MAX: "0" }).max).toBe(1);
	});

	test("unparseable values fall back to the defaults rather than throwing", () => {
		const settings = indexPoolSettingsFromEnv({
			SUBSTRATE_PG_POOL_MAX: "eight",
			SUBSTRATE_PG_CONNECT_TIMEOUT_MS: "-5",
			SUBSTRATE_PG_STATEMENT_TIMEOUT_MS: "5.5",
			SUBSTRATE_PG_IDLE_TIMEOUT_S: " ",
		});
		expect(settings).toEqual(DEFAULT_INDEX_POOL_SETTINGS);
	});
});

describe("indexSqlOptions", () => {
	test("composes Bun's pool options in seconds and the per-connection parameters at startup", () => {
		expect(indexSqlOptions()).toEqual({
			max: 8,
			connectionTimeout: 2,
			idleTimeout: 300,
			maxLifetime: INDEX_MAX_LIFETIME_S,
			connection: {
				application_name: INDEX_APPLICATION_NAME,
				statement_timeout: "5000",
				idle_in_transaction_session_timeout: "5000",
			},
		});
	});

	test("a zero statement timeout leaves the server defaults and keeps only the name", () => {
		const options = indexSqlOptions({ statementTimeoutMs: 0, max: 2, connectTimeoutMs: 500, idleTimeoutS: 0 });
		expect(options.connection).toEqual({ application_name: "substrate-mcp" });
		expect(options.max).toBe(2);
		expect(options.connectionTimeout).toBe(0.5);
		expect(options.idleTimeout).toBe(0);
	});

	test("the application name cannot be overridden", () => {
		expect(indexSqlOptions({ applicationName: "something-else" }).connection.application_name).toBe("substrate-mcp");
	});
});

describe("IndexStore.ping", () => {
	/** A socket that accepts and never speaks Postgres, so a query hangs until something bounds it. */
	function silentServer(): { url: string; stop: () => void } {
		const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
		return {
			url: `postgres://probe:probe@127.0.0.1:${server.port}/probe`,
			stop: () => server.stop(true),
		};
	}

	test("is false within the timeout when the index never answers, and the gate sees a timeout", async () => {
		const server = silentServer();
		const samples: PlaneSample[] = [];
		const store = new IndexStore(server.url, {
			pool: { connectTimeoutMs: 60_000, statementTimeoutMs: 0 },
			gate: { plane: "index", breaker: null, observe: (sample) => samples.push(sample) },
		});
		try {
			const started = performance.now();
			expect(await store.ping(50)).toBe(false);
			expect(performance.now() - started).toBeLessThan(2_000);
			expect(samples.map((sample) => [sample.plane, sample.op, sample.outcome])).toEqual([["index", "ping", "timeout"]]);
		} finally {
			server.stop();
			await store.close({ timeout: 0 }).catch(() => undefined);
		}
	});

	test("is false, not a throw, when the connection is refused", async () => {
		const server = silentServer();
		server.stop();
		const store = new IndexStore(server.url, { pool: { connectTimeoutMs: 1000 } });
		try {
			expect(await store.ping(1500)).toBe(false);
		} finally {
			await store.close({ timeout: 0 }).catch(() => undefined);
		}
	});

	test("the pool settings the store runs with are env defaults under the caller's overrides", () => {
		const store = new IndexStore("postgres://probe:probe@127.0.0.1:1/probe", { pool: { max: 3 } });
		expect(store.poolSettings.max).toBe(3);
		expect(store.poolSettings.applicationName).toBe("substrate-mcp");
	});
});
