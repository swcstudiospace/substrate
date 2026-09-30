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
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import type { SubstrateEvent } from "./types.ts";

const ENV = {
	SUBSTRATE_TOKEN_HERMES: "tok-hermes",
	// The operator credential is a surface token that is also listed as an
	// operator's, so its extra authority never costs us knowing who used it.
	SUBSTRATE_TOKEN_CURSOR: "tok-operator",
	SUBSTRATE_OPERATOR_TOKENS: "tok-operator",
	SUBSTRATE_HANDOFF_KEY: "a-test-signing-key",
};

const released: Array<{ lease_id?: string | null; force?: boolean }> = [];
const written: SubstrateEvent[] = [];

/** A node held by grok-bot, so a forced release has something to take. */
const heldNode = {
	graph_id: "ut-1",
	node_id: "n2",
	linear_identifier: "SPE-4792",
	claimed_by: "grok-bot",
	claim_session: "sess-grok",
	claimed_at: new Date().toISOString(),
	lease_id: "lse_live",
	lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
	lease_heartbeat_at: new Date().toISOString(),
	lease_epoch: 1,
};

const index = {
	getGraph: async () => ({ repo: "swcstudiospace/agent-substrate", branch: "main" }),
	releaseNode: async (_g: string, _n: string, request: { lease_id?: string | null; force?: boolean }) => {
		released.push(request);
		return {
			released: true,
			node: heldNode,
			decision: {
				ok: true as const,
				action: request.force ? ("forced" as const) : ("released" as const),
				lease_id: "lse_live",
				evicted: { surface: "grok-bot" as const, session_id: "sess-grok" },
				holder: { surface: "grok-bot" as const, session_id: "sess-grok" },
				observed_epoch: 1,
			},
		};
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

beforeAll(async () => {
	const config = loadConfig(ENV);
	const substrate = new Substrate(config, { index: index as never, greptime: greptime as never });
	server = createHttpServer(substrate, config);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
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
		const surfaceless = createHttpServer(substrate, {
			...config,
			// A deployment with tokens, and a caller holding one that resolves to no
			// surface — the shape the auth gate now refuses outright.
			tokens: new Map([["tok-hermes", "hermes"]]),
			operatorTokens: new Set(["tok-ghost"]),
		});
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
