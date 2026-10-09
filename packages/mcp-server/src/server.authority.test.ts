/**
 * The authorisation boundary, driven through the real HTTP and MCP surfaces.
 *
 * `authority.test.ts` proves the rules; this proves they are actually wired to
 * the bearer token on both doors an agent can reach — which is the half that a
 * refactor of the transport could quietly undo without any unit test noticing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { loadConfig } from "./config.ts";
import { leaseSnapshot } from "./index-store.ts";
import { decideHeartbeat, decideRelease, leaseView } from "./lease.ts";
import { createObservability, type Observability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import type { Surface, SubstrateEvent } from "./types.ts";

const ENV = {
	// One surface variable holds a two-value list: the gateway and the connector
	// each hold their own value for the same surface.
	SUBSTRATE_TOKEN_HERMES: "tok-hermes, tok-hermes-b",
	// The operator credential is a surface token that is also listed as an
	// operator's, so its extra authority never costs us knowing who used it.
	SUBSTRATE_TOKEN_CURSOR: "tok-operator",
	SUBSTRATE_TOKEN_SWARM_A05_BE: "tok-a05",
	SUBSTRATE_TOKEN_SWARM_A09_REV: "tok-a09",
	// tok-a09 is listed by mistake, the misconfiguration LEASE-04 fails closed on:
	// a swarm token is never an operator.
	SUBSTRATE_OPERATOR_TOKENS: "tok-operator,tok-a09",
	SUBSTRATE_HANDOFF_KEY: "a-test-signing-key",
};

const released: Array<{ lease_id?: string | null; force?: boolean }> = [];
const written: SubstrateEvent[] = [];

/** A node held by hermes, judged by the real lease rules, so a forced release has something to take. */
const heldNode = {
	graph_id: "ut-1",
	node_id: "n2",
	linear_identifier: "SPE-4792",
	claimed_by: "hermes",
	claim_session: "sess-hermes",
	claimed_at: new Date().toISOString(),
	lease_id: "lse_live",
	lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
	lease_heartbeat_at: new Date().toISOString(),
	lease_epoch: 1,
};

/** Every surface the index was asked to claim as, so a refused claim is shown to have asked nobody. */
const claimedAs: string[] = [];
/** The authenticated caller each claim reached the index with. */
const claimCallers: Array<Surface | null> = [];

const index = {
	getGraph: async () => ({ repo: "swcstudiospace/agent-substrate", branch: "main" }),
	claimNode: async (graph_id: string, node_id: string, surface: string, _session: string, caller: Surface | null) => {
		claimedAs.push(surface);
		claimCallers.push(caller);
		return {
			claimed: true,
			node: { graph_id, node_id, linear_identifier: null },
			lease: { lease_id: "lse_swarm", holder: { surface, session_id: "s" }, epoch: 1, state: "held", expires_at: null },
			decision: { action: "granted", evicted: null },
		};
	},
	heartbeatNode: async (_g: string, _n: string, leaseId: string, caller: Surface | null, ttl: number) => {
		const decision = decideHeartbeat(leaseSnapshot(heldNode as never), { lease_id: leaseId, ttl_seconds: ttl, caller }, Date.now());
		return { ok: decision.ok, node: heldNode, lease: leaseView(leaseSnapshot(heldNode as never)), decision };
	},
	releaseNode: async (_g: string, _n: string, request: { lease_id?: string | null; force?: boolean }, caller: Surface | null) => {
		const decision = decideRelease(leaseSnapshot(heldNode as never), { ...request, caller }, Date.now());
		// Only what the rules let through counts as released; the row itself is left
		// alone so every test sees the same holder.
		if (decision.ok) released.push(request);
		return { released: decision.ok, node: heldNode, decision };
	},
};

const greptime = {
	ensureAppendMode: async () => true,
	lastHash: async () => "tip-hash",
	insertEvent: async (event: SubstrateEvent) => {
		written.push(event);
	},
};

let base: string;
let server: ReturnType<typeof createHttpServer>;
let observability: Observability;

beforeAll(async () => {
	const config = loadConfig(ENV);
	// The audit chain stays in memory: ENV names no SUBSTRATE_AUDIT_PATH, and the gate
	// in front of the dispatcher is part of the boundary this file drives.
	observability = createObservability(config, ENV);
	await observability.start();
	const substrate = new Substrate(config, { index: index as never, greptime: greptime as never }, observability.observer);
	server = createHttpServer(substrate, config, observability);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
	observability.stop();
	server.close();
});

/** Call an MCP tool over streamable HTTP and return the tool's JSON result. */
async function callTool(token: string | null, name: string, args: Record<string, unknown>): Promise<unknown> {
	const response = await fetch(`${base}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
	});
	const raw = await response.text();
	const data = raw
		.split("\n")
		.find((line) => line.startsWith("data: "))
		?.slice(6);
	const envelope = JSON.parse(data ?? raw) as { result?: { content?: Array<{ text?: string }> } };
	return JSON.parse(envelope.result?.content?.[0]?.text ?? "null");
}

describe("force is an operator action", () => {
	test("a surface token is refused, and nothing is released", async () => {
		released.length = 0;

		const result = (await callTool("tok-hermes", "graph_release", {
			graph_id: "ut-1",
			node_id: "n2",
			force: true,
		})) as { released: boolean; reason: string };

		expect(result.released).toBe(false);
		expect(result.reason).toBe("force-requires-operator");
		// Refused, not quietly downgraded to an ordinary release: a downgrade would
		// read as success and leave the holder in place.
		expect(released).toEqual([]);
	});

	test("graph_complete refuses it too", async () => {
		released.length = 0;

		const result = (await callTool("tok-hermes", "graph_complete", {
			graph_id: "ut-1",
			node_id: "n2",
			force: true,
		})) as { completed: boolean; reason: string };

		expect(result.completed).toBe(false);
		expect(result.reason).toBe("force-requires-operator");
		expect(released).toEqual([]);
	});

	test("an operator token goes through", async () => {
		released.length = 0;

		const result = (await callTool("tok-operator", "graph_release", {
			graph_id: "ut-1",
			node_id: "n2",
			force: true,
		})) as { released: boolean; action: string };

		expect(result.released).toBe(true);
		expect(result.action).toBe("forced");
		expect(released).toEqual([{ lease_id: undefined, force: true }]);
	});

	test("a surface token can still release its own lease", async () => {
		// The gate is on taking a node from someone else, not on ordinary use.
		released.length = 0;

		const result = (await callTool("tok-hermes", "graph_release", {
			graph_id: "ut-1",
			node_id: "n2",
			lease_id: "lse_live",
		})) as { released: boolean; action: string };

		expect(result.released).toBe(true);
		expect(result.action).toBe("released");
		expect(released[0]?.lease_id).toBe("lse_live");
	});
});

describe("only the holder's surface may use a lease", () => {
	test("another surface's token is refused not-holder, even with the holder's lease id, and sees no id", async () => {
		released.length = 0;
		const args = { graph_id: "ut-1", node_id: "n2", lease_id: "lse_live" };

		const beat = (await callTool("tok-a09", "graph_heartbeat", args)) as { ok: boolean; reason: string };
		const release = (await callTool("tok-a09", "graph_release", args)) as {
			released: boolean;
			reason: string;
			holder: unknown;
			lease: { lease_id: string | null; epoch: number };
		};
		const complete = (await callTool("tok-a09", "graph_complete", args)) as { completed: boolean; reason: string };

		expect(beat).toMatchObject({ ok: false, reason: "not-holder" });
		expect(release).toMatchObject({ released: false, reason: "not-holder", holder: { surface: "hermes", session_id: "sess-hermes" } });
		expect(release.lease.lease_id).toBeNull();
		expect(release.lease.epoch).toBe(1);
		expect(complete).toMatchObject({ completed: false, reason: "not-holder" });
		expect(released).toEqual([]);
	});

	test("the holder's own token beats its lease", async () => {
		const beat = (await callTool("tok-hermes", "graph_heartbeat", { graph_id: "ut-1", node_id: "n2", lease_id: "lse_live" })) as {
			ok: boolean;
		};
		expect(beat.ok).toBe(true);
	});

	test("a swarm token listed in SUBSTRATE_OPERATOR_TOKENS is still refused force", async () => {
		released.length = 0;

		const release = (await callTool("tok-a09", "graph_release", { graph_id: "ut-1", node_id: "n2", force: true })) as {
			released: boolean;
			reason: string;
		};
		const complete = (await callTool("tok-a09", "graph_complete", { graph_id: "ut-1", node_id: "n2", force: true })) as {
			completed: boolean;
			reason: string;
		};

		expect(release).toMatchObject({ released: false, reason: "force-requires-operator" });
		expect(complete).toMatchObject({ completed: false, reason: "force-requires-operator" });
		expect(released).toEqual([]);
	});
});

describe("the handoff sender is the token's surface", () => {
	test("the old escape hatches are ignored, not honoured", async () => {
		// `surface` and `prev_event_hash` are gone from the tool's schema, and the SDK
		// drops arguments a schema does not declare — so a caller still sending them
		// gets a correct packet rather than an error *or* a forgery. Asserted because
		// "unknown arguments are dropped" is the SDK's behaviour, not ours: if that
		// ever changed to pass-through, this is what would catch it.
		const result = (await callTool("tok-hermes", "coord_handoff", {
			to: "omp",
			goal: "take over n2",
			graph_id: "ut-1",
			node_id: "n2",
			session_id: "sess-hermes",
			surface: "grok-bot",
			prev_event_hash: "f".repeat(64),
		})) as { packet: { from: { surface: string }; prev_event_hash: string } };

		expect(result.packet.from.surface).toBe("hermes");
		expect(result.packet.prev_event_hash).toBe("tip-hash");
	});

	test("a valid handoff is signed as the token's surface", async () => {
		const result = (await callTool("tok-hermes", "coord_handoff", {
			to: "omp",
			goal: "take over n2",
			graph_id: "ut-1",
			node_id: "n2",
			session_id: "sess-hermes",
		})) as { packet: { from: { surface: string }; prev_event_hash: string }; signed: boolean };

		expect(result.packet.from.surface).toBe("hermes");
		expect(result.signed).toBe(true);
		// And the anchor came from the ledger.
		expect(result.packet.prev_event_hash).toBe("tip-hash");
	});

	test("over REST, a body naming another agent does not become the sender", async () => {
		// The forgery this closes: an agent with its own token names a peer as the
		// sender and walks away with a packet that verifies under that identity.
		const response = await fetch(`${base}/handoff`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer tok-hermes" },
			body: JSON.stringify({
				to: "omp",
				goal: "take over n2",
				graph_id: "ut-1",
				surface: "grok-bot",
				session_id: "sess-hermes",
			}),
		});
		const result = (await response.json()) as { packet: { from: { surface: string } }; signed: boolean };

		expect(result.packet.from.surface).toBe("hermes");
		expect(result.signed).toBe(true);
	});

	test("an unknown token reaches neither door", async () => {
		const response = await fetch(`${base}/handoff`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer nonsense" },
			body: JSON.stringify({ to: "omp", goal: "x" }),
		});
		expect(response.status).toBe(401);
	});

	test("an operator credential signs as its own surface, not as the body's", async () => {
		// The regression an earlier fix introduced: letting an operator token past the
		// auth gate with no surface meant `/handoff` fell through to the body, so an
		// operator credential could sign a packet as any agent it named. Operator
		// authority is now an attribute of a surface token, so there is no such caller.
		const response = await fetch(`${base}/handoff`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer tok-operator" },
			body: JSON.stringify({ to: "omp", goal: "take over n2", graph_id: "ut-1", surface: "grok-bot" }),
		});
		const result = (await response.json()) as { packet: { from: { surface: string } } };

		expect(result.packet.from.surface).toBe("cursor");
	});

	test("a token that names no surface cannot be a sender at all", async () => {
		// Belt and braces on the same class: even if such a caller existed, the body
		// is consulted only when *nothing* is authenticated, never merely because
		// this particular token named no surface.
		const config = loadConfig({ SUBSTRATE_TOKEN_HERMES: "tok-hermes", SUBSTRATE_HANDOFF_KEY: "k" });
		const substrate = new Substrate(config, { index: index as never, greptime: greptime as never });
		const surfaceless = createHttpServer(
			substrate,
			{
				...config,
				// A deployment with tokens, and a caller holding one that resolves to no
				// surface — the shape the auth gate now refuses outright.
				tokens: new Map([["tok-hermes", "hermes"]]),
				operatorTokens: new Set(["tok-ghost"]),
			},
			observability,
		);
		await new Promise<void>((resolve) => surfaceless.listen(0, "127.0.0.1", resolve));
		const port = (surfaceless.address() as AddressInfo).port;

		const response = await fetch(`http://127.0.0.1:${port}/handoff`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer tok-ghost" },
			body: JSON.stringify({ to: "omp", goal: "x", surface: "grok-bot" }),
		});

		expect(response.status).toBe(401);
		surfaceless.close();
	});
});

describe("a swarm token names the caller over the wire", () => {
	async function postEvent(token: string | null, body: Record<string, unknown>): Promise<Response> {
		return fetch(`${base}/events`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
			body: JSON.stringify({ kind: "note", summary: "x", ...body }),
		});
	}

	test("REST /events: A05's token cannot emit as A09 — 403, and nothing is written", async () => {
		written.length = 0;

		const response = await postEvent("tok-a05", { surface: "swarm-a09-rev" });
		const body = (await response.json()) as { error: string };

		expect(response.status).toBe(403);
		expect(body.error).toContain("cannot act as swarm-a09-rev");
		expect(written).toEqual([]);
	});

	test("REST /events: the same token emitting as itself, or by default, is accepted as itself", async () => {
		written.length = 0;

		const explicit = await postEvent("tok-a05", { surface: "swarm-a05-be" });
		const implicit = await postEvent("tok-a05", {});

		expect(explicit.status).toBe(202);
		expect(implicit.status).toBe(202);
		expect(written.map((event) => event.surface)).toEqual(["swarm-a05-be", "swarm-a05-be"]);
	});

	test("REST /events: a non-swarm token naming another surface is attributed as it always was", async () => {
		written.length = 0;

		const response = await postEvent("tok-hermes", { surface: "grok-bot" });

		expect(response.status).toBe(202);
		expect(written[0]?.surface).toBe("grok-bot");
	});

	test("MCP events_emit: refused for a swarm token naming another surface, honoured as itself", async () => {
		written.length = 0;

		const refused = (await callTool("tok-a05", "events_emit", { kind: "note", summary: "x", surface: "swarm-a09-rev" })) as {
			error: string;
		};
		const own = (await callTool("tok-a05", "events_emit", { kind: "note", summary: "x", surface: "swarm-a05-be" })) as {
			stored: boolean;
		};

		expect(refused.error).toContain("cannot act as swarm-a09-rev");
		expect(own.stored).toBe(true);
		expect(written.map((event) => event.surface)).toEqual(["swarm-a05-be"]);
	});

	test("MCP graph_claim: A05's token cannot claim as A09, and can claim as itself", async () => {
		claimedAs.length = 0;

		const refused = (await callTool("tok-a05", "graph_claim", {
			graph_id: "ut-1",
			node_id: "n2",
			session_id: "A09@r0:ut-1",
			surface: "swarm-a09-rev",
		})) as { error: string };
		const own = (await callTool("tok-a05", "graph_claim", {
			graph_id: "ut-1",
			node_id: "n2",
			session_id: "A05@r0:ut-1",
		})) as { claimed: boolean };

		expect(refused.error).toContain("cannot act as swarm-a09-rev");
		expect(own.claimed).toBe(true);
		// The refused claim never reached the index; the accepted one is A05's.
		expect(claimedAs).toEqual(["swarm-a05-be"]);
	});

	test("MCP graph_claim: a non-swarm token naming another non-swarm surface is unchanged, and the index sees the token", async () => {
		claimedAs.length = 0;
		claimCallers.length = 0;

		await callTool("tok-hermes", "graph_claim", { graph_id: "ut-1", node_id: "n3", session_id: "s", surface: "grok-bot" });

		expect(claimedAs).toEqual(["grok-bot"]);
		// The token's surface travels with the claim, so the index can refuse a renewal.
		expect(claimCallers).toEqual(["hermes"]);
	});

	test("MCP graph_claim: a non-swarm token naming a swarm surface is refused before the index", async () => {
		// A05's session id is public, so a hermes token naming swarm-a05-be and that
		// session would otherwise renew A05's lease and be handed its id.
		claimedAs.length = 0;

		const refused = (await callTool("tok-hermes", "graph_claim", {
			graph_id: "ut-1",
			node_id: "n2",
			session_id: "A05@r0:ut-1",
			surface: "swarm-a05-be",
		})) as { error: string };

		expect(refused.error).toBe("this token is hermes and cannot claim as swarm-a05-be");
		expect(claimedAs).toEqual([]);
	});

	test("MCP graph_claim: A05's token with a session naming another agent or graph is refused before the index", async () => {
		claimedAs.length = 0;

		const otherAgent = (await callTool("tok-a05", "graph_claim", { graph_id: "ut-1", node_id: "n2", session_id: "A09@r0:ut-1" })) as {
			error: string;
		};
		const otherGraph = (await callTool("tok-a05", "graph_claim", { graph_id: "ut-1", node_id: "n2", session_id: "A05@r1:ut-2" })) as {
			error: string;
		};

		expect(otherAgent.error).toContain("must name agent A05");
		expect(otherGraph.error).toContain("must end in this claim's graph_id ut-1");
		expect(claimedAs).toEqual([]);
	});
});

describe("a list entry authenticates over the wire", () => {
	async function postEvent(token: string, body: Record<string, unknown>): Promise<Response> {
		return fetch(`${base}/events`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ kind: "note", summary: "x", ...body }),
		});
	}

	test("REST /events: the second value of the list is accepted as the variable's surface", async () => {
		written.length = 0;

		const response = await postEvent("tok-hermes-b", {});

		expect(response.status).toBe(202);
		expect(written.map((event) => event.surface)).toEqual(["hermes"]);
	});

	test("REST /events: the whole comma-joined string as one bearer is unknown, so 401", async () => {
		written.length = 0;

		const response = await postEvent("tok-hermes, tok-hermes-b", {});

		expect(response.status).toBe(401);
		expect(written).toEqual([]);
	});
});
