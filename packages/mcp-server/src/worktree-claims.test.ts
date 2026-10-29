/**
 * The prune guard's question, `GET /worktrees/claims?graph_id=`: which nodes of one graph hold an unexpired lease.
 * The decision (`liveClaims`) tests without a server; the route tests run on a real socket over an index stub and
 * check what a deleting caller depends on: a lapsed lease is not a claim, an unknown graph is an empty list, and an
 * index that is missing or fails is 503 and never an empty list.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { loadConfig } from "./config.ts";
import { createObservability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import type { GraphNode, SubstrateEvent } from "./types.ts";
import { liveClaims, parseClaimsQuery } from "./worktree-claims.ts";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const GRAPH = "ut-mu1-abcd1234";

function node(overrides: Partial<GraphNode> = {}): GraphNode {
	return {
		graph_id: GRAPH,
		node_id: "n1",
		linear_issue_id: null,
		linear_identifier: null,
		notion_page: null,
		state: "started",
		claimed_by: "hermes",
		claimed_at: "2026-10-29T11:50:00.000Z",
		claim_session: "s-1",
		lease_id: "lse_secret",
		lease_expires_at: "2026-10-29T12:05:00.000Z",
		lease_heartbeat_at: "2026-10-29T11:55:00.000Z",
		lease_epoch: 1,
		...overrides,
	};
}

describe("liveClaims", () => {
	test("a held lease is a claim with its holder and expiry; a lapsed, released or never-held node is not", () => {
		const claims = liveClaims(
			[
				node({ node_id: "held" }),
				node({ node_id: "lapsed", lease_expires_at: "2026-10-29T11:59:59.000Z" }),
				node({ node_id: "released", claimed_by: null, claim_session: null, lease_id: null, lease_expires_at: null }),
				node({ node_id: "never", claimed_by: null, claim_session: null, claimed_at: null, lease_id: null, lease_expires_at: null, lease_epoch: 0 }),
			],
			NOW,
		);
		expect(claims).toEqual([{ node_id: "held", holder: { surface: "hermes", session_id: "s-1" }, expires_at: "2026-10-29T12:05:00.000Z" }]);
	});

	test("a legacy claim with no expiry lapses one default TTL after it was made, and the fencing token never leaves", () => {
		const fresh = node({ node_id: "fresh", lease_expires_at: null, claimed_at: "2026-10-29T11:59:00.000Z" });
		const stale = node({ node_id: "stale", lease_expires_at: null, claimed_at: "2026-10-28T11:59:00.000Z" });
		const claims = liveClaims([fresh, stale], NOW);
		expect(claims.map((claim) => claim.node_id)).toEqual(["fresh"]);
		expect(JSON.stringify(claims)).not.toContain("lse_secret");
	});

	test("claims come back in node order", () => {
		expect(liveClaims([node({ node_id: "b" }), node({ node_id: "a" })], NOW).map((claim) => claim.node_id)).toEqual(["a", "b"]);
	});
});

describe("parseClaimsQuery", () => {
	test("a graph id is required and must be a plain directory-name-shaped id", () => {
		expect(parseClaimsQuery(GRAPH)).toEqual({ ok: true, value: GRAPH });
		for (const bad of [undefined, "", "../etc", "-leading", "a/b", "x".repeat(129)]) expect(parseClaimsQuery(bad).ok).toBe(false);
	});
});

const running: Array<{ close(): void }> = [];

afterAll(() => {
	for (const entry of running) entry.close();
});

const TOKENS = { SUBSTRATE_TOKEN_CLAUDE_CODE: "tok-agent" };

async function start(env: Record<string, string | undefined>, index: unknown) {
	const config = loadConfig(env);
	const observability = createObservability(config, env);
	await observability.start();
	const written: SubstrateEvent[] = [];
	const greptime = {
		ensureAppendMode: async () => true,
		lastHash: async (): Promise<string | null> => null,
		insertEvent: async (event: SubstrateEvent) => {
			written.push(event);
		},
		queryEvents: async () => [],
		readEvents: async () => [],
		graphIngest: async () => [],
		firstIngestMs: async () => null,
	};
	const substrate = new Substrate(config, { index: index as never, greptime: greptime as never }, observability.observer);
	const server = createHttpServer(substrate, config, observability);
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const { port } = server.address() as AddressInfo;
	running.push({
		close() {
			observability.stop();
			server.close();
		},
	});
	return `http://127.0.0.1:${port}`;
}

async function claims(base: string, query: string, token: string | null = "tok-agent") {
	const response = await fetch(`${base}/worktrees/claims${query}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } });
	return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** What the index's `getGraph` returns, as far as the route reads it. */
function graphWith(nodes: GraphNode[]) {
	return { graph_id: GRAPH, nodes, steps: [], edges: [] };
}

describe("GET /worktrees/claims", () => {
	test("answers with the unexpired leases of the graph, without SUBSTRATE_WORKTREE_REGISTRY, and never shows a lease id", async () => {
		const soon = new Date(Date.now() + 5 * 60_000).toISOString();
		const base = await start(TOKENS, {
			getGraph: async (id: string) => (id === GRAPH ? graphWith([node({ node_id: "held", lease_expires_at: soon }), node({ node_id: "lapsed", lease_expires_at: "2020-01-01T00:00:00.000Z" })]) : null),
		});
		const reply = await claims(base, `?graph_id=${GRAPH}`);
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({ graph_id: GRAPH, claims: [{ node_id: "held", holder: { surface: "hermes", session_id: "s-1" }, expires_at: soon }] });
		expect(JSON.stringify(reply.json)).not.toContain("lse_secret");
		// An unknown graph has no claims: the index answered, and said nothing is held.
		expect((await claims(base, "?graph_id=ut-unknown-00000000")).json).toEqual({ graph_id: "ut-unknown-00000000", claims: [] });
	});

	test("an index that is missing or fails is 503, never an empty list", async () => {
		const noIndex = await start(TOKENS, null);
		const missing = await claims(noIndex, `?graph_id=${GRAPH}`);
		expect(missing.status).toBe(503);
		expect(missing.json).toMatchObject({ error: "claims.unavailable" });
		expect(missing.json).not.toHaveProperty("claims");

		const failing = await start(TOKENS, {
			getGraph: async () => {
				throw new Error("connection refused");
			},
		});
		const failed = await claims(failing, `?graph_id=${GRAPH}`);
		expect(failed.status).toBe(503);
		expect(failed.json).not.toHaveProperty("claims");
	});

	test("a missing or malformed graph id is 400, and an anonymous caller is 401 even on a run that allows them", async () => {
		const base = await start({ ...TOKENS, SUBSTRATE_ALLOW_ANONYMOUS: "1" }, { getGraph: async () => null });
		expect((await claims(base, "")).status).toBe(400);
		expect((await claims(base, "?graph_id=../etc")).status).toBe(400);
		const anonymous = await claims(base, `?graph_id=${GRAPH}`, null);
		expect(anonymous.status).toBe(401);
		expect(String(anonymous.json.error)).toContain("authenticated surface");
	});
});
