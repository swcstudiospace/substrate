/**
 * Tests for the s:mcp in-VM substrate relay (I-04 + SEC01/SEC02): closed tool allowlist,
 * host-side binding, kickoff re-register safety, and shared TaskService terminal
 * transitions with truthful refusal passthrough.
 *
 * The relay executes through the REAL SubstrateClient HTTP layer and the REAL
 * TaskService (actual complete/guestRelease transitions, real MemoryTaskStore/
 * MemoryLeaseStore) over an injected transport whose stub server enforces the REAL
 * authority rules (holder-only lease use, known-graph registration). Assertions cover
 * consumer-visible behaviors — allowlist refusals, binding outcomes, validation
 * errors, store status after callbacks, refusal passthrough — never wire copies such
 * as header values or request-body shapes. No secret or fencing value appears in any
 * assertion; presence only.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { SUBSTRATE_RELAY_TOOLS, substrateMcpRelayCollection } from "./substrate-relay.ts";
import type { RelayHostConfig } from "./substrate-relay.ts";
import { MemoryLeaseStore, SubstrateClient } from "./substrate.ts";
import { MemoryTaskStore, TaskService, type TaskRecord, type VmHandle } from "./tasks.ts";
import { parseRoute } from "./options.ts";

const GID = "ut-relay-12345678";
const NID = "n1";
const LEASE = "lse_relay_0123456789abcdef0123456789abcdef";

function record(): TaskRecord {
	return {
		graph_id: GID,
		node_id: NID,
		identifier: "TRC-9",
		repo: "swcstudiospace/agent-substrate",
		session_id: NID,
		prompt_count: 1,
		turn_in_flight: true,
		last_stop_reason: null,
		exit_code: null,
		released: false,
		pending_approvals: [],
		opened_at: "2026-09-25T12:00:00.000Z",
		last_error: null,
		seeded: [],
		resumes: 0,
		stale_approvals: 0,
		pr_url: null,
		pr_number: null,
		synced_at: null,
		sync_by: null,
		approvals_allowed: 0,
		approvals_denied: 0,
	};
}

function jsonRpc(id: number | string, payload: unknown): Response {
	return new Response(
		JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ text: JSON.stringify(payload) }] } }),
		{ status: 200 },
	);
}

type Seen = { url: string; init: RequestInit };

const CANONICAL_STEPS = [
	{ graph_id: GID, node_id: NID, step: 1, linear_sub_issue_id: "SUB-1", notion_page: "https://www.notion.so/step-0123456789abcdef0123456789abcdef" },
];

const CANONICAL_NODES = [
	{
		graph_id: GID,
		node_id: NID,
		linear_issue_id: "11111111-2222-3333-4444-555555555555",
		linear_identifier: "TRC-9",
		notion_page: "https://www.notion.so/node-0123456789abcdef0123456789abcdef",
		state: null,
		claimed_by: "claude-code",
		claimed_at: "2026-09-25T00:00:00Z",
		claim_session: NID,
	},
];

/** The reply id the real client accepts: the request's own id, never a hardcoded one. */
function replyId(body: unknown): number | string {
	if (typeof body === "object" && body !== null && "id" in body) {
		const id: unknown = body.id;
		if (typeof id === "number" || typeof id === "string") return id;
	}
	return 1;
}

/**
 * Stub server enforcing the real authority rules: a lease call succeeds only with
 * the held id, registration accepts only the known graph with known nodes/steps.
 */
function authorityReply(url: string, body: unknown): Response {
	const rid = replyId(body);
	if (url.endsWith("/issue")) {
		return jsonRpc(rid, { found: true, graph_id: GID, node_id: NID, identifier: "TRC-9", title: "t", description: "d", untrusted: "d" });
	}
	const parsed = z.object({ params: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }) }).passthrough().safeParse(body);
	if (!parsed.success) return jsonRpc(rid, { error: "bad-shape" });
	const { name, arguments: args } = parsed.data.params;
	if (name === "graph_get") {
		return jsonRpc(rid, { graph_id: GID, repo: "swcstudiospace/agent-substrate", branch: "main", nodes: CANONICAL_NODES, steps: CANONICAL_STEPS });
	}
	if (name === "graph_register") {
		const reg = z.object({
			graph_id: z.string(),
			nodes: z.array(z.object({ node_id: z.string() }).passthrough()).optional(),
			steps: z.array(z.object({ node_id: z.string(), step: z.number() }).passthrough()).optional(),
		}).passthrough().safeParse(args);
		if (!reg.success || reg.data.graph_id !== GID) return jsonRpc(rid, { registered: false, reason: "unknown-graph" });
		if ((reg.data.nodes ?? []).some((n) => n.node_id !== NID)) return jsonRpc(rid, { registered: false, reason: "unknown-node" });
		if ((reg.data.steps ?? []).some((s) => s.node_id !== NID)) return jsonRpc(rid, { registered: false, reason: "unknown-node" });
		return jsonRpc(rid, { registered: true, graph_id: GID, nodes: reg.data.nodes ?? [], steps: reg.data.steps ?? [] });
	}
	const lease = args["lease_id"];
	if (name === "graph_release") {
		if (lease === LEASE) return jsonRpc(rid, { released: true });
		return jsonRpc(rid, { released: false, reason: lease === null ? "lease-id-required" : "stale-lease" });
	}
	if (name === "graph_complete") {
		if (lease === LEASE) return jsonRpc(rid, { completed: true });
		return jsonRpc(rid, { completed: false, reason: "not-holder" });
	}
	return jsonRpc(rid, { error: "unknown-tool" });
}

function harness(opts: { leaseId?: string | null; reply?: (url: string, body: unknown) => Response } = {}) {
	const seen: Seen[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		seen.push({ url, init });
		const body = init.body ? JSON.parse(String(init.body)) : null;
		return (opts.reply ?? authorityReply)(url, body);
	}) as unknown as typeof fetch;
	const substrate = new SubstrateClient({ baseUrl: "http://127.0.0.1:9", fetchImpl, bearer: "lease-bearer", jobBearer: "job-bearer" });
	const store = new MemoryTaskStore();
	store.save(record());
	const leases = new MemoryLeaseStore();
	if (opts.leaseId !== null) leases.persist(GID, NID, { lease_id: opts.leaseId ?? LEASE, acquiredAtMs: 0, ttlSeconds: 900 });
	const logs: string[] = [];
	const service = new TaskService({
		substrate,
		vmFor: () => ({
			sessions: {
				get: async () => ({ state: { status: "idle" }, latestSequence: 0 }),
				readHistory: async () => ({ events: [] }),
				cancelPrompt: async () => ({ status: "cancelled" }),
				unload: async () => undefined,
			},
		}) as unknown as VmHandle,
		store,
		leases,
		ensureModelRoute: async () => undefined,
		ensureSubstrateRoute: async () => undefined,
		route: parseRoute("a:loopback,b:prompt_hostfn,c:hostfn_commit,s:mcp"),
		testsRoute: "sandbox",
		model: "relay-test",
		skills: [],
		trackers: { notionDataSourceUrl: "collection://relay", linearTeam: "TST" },
		log: (line) => logs.push(line),
	});
	const config: RelayHostConfig = { store, substrate, leases, tasks: () => service, log: (line) => logs.push(line) };
	const relay = substrateMcpRelayCollection([GID], config);
	return { seen, substrate, store, leases, logs, relay, service };
}

function rpc(method: string, params: unknown, id: number | string = 1): { method: string; path: string; bodyBase64?: string } {
	return { method: "POST", path: "/mcp", bodyBase64: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8").toString("base64") };
}

const RpcReply = z
	.object({ result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).optional() })
	.passthrough();

function decodeCall(envelope: { status: number; headers: Record<string, string>; bodyBase64: string }): {
	status: number;
	rpc: { result?: unknown; error?: { code: number; message: string } };
} {
	return { status: envelope.status, rpc: RpcReply.parse(JSON.parse(Buffer.from(envelope.bodyBase64, "base64").toString("utf8"))) };
}

describe("substrate relay protocol surface", () => {
	test("advertises exactly the closed allowlist", async () => {
		const h = harness();
		const out = decodeCall(await h.relay.substrateMcp.execute(rpc("tools/list", {})));
		const result: unknown = out.rpc.result;
		if (typeof result !== "object" || result === null || !("tools" in result)) throw new Error("unexpected tools/list result");
		const tools: unknown = result.tools;
		if (!Array.isArray(tools)) throw new Error("unexpected tools shape");
		expect([...SUBSTRATE_RELAY_TOOLS].sort()).toEqual(["graph_complete", "graph_register", "graph_release", "issue_get"]);
		expect(tools.map((t) => (typeof t === "object" && t !== null && "name" in t ? String(t.name) : "")).sort()).toEqual(
			[...SUBSTRATE_RELAY_TOOLS].sort(),
		);
	});

	test("initialize echoes the client protocol version; ping answers; unknown methods refused", async () => {
		const h = harness();
		const init = decodeCall(await h.relay.substrateMcp.execute(rpc("initialize", { protocolVersion: "2025-01-01" })));
		const initResult: unknown = init.rpc.result;
		if (typeof initResult !== "object" || initResult === null || !("protocolVersion" in initResult)) {
			throw new Error("unexpected initialize result");
		}
		expect(initResult.protocolVersion).toBe("2025-01-01");
		const ping = decodeCall(await h.relay.substrateMcp.execute(rpc("ping", {})));
		expect(ping.rpc.error).toBeUndefined();
		const unknown = decodeCall(await h.relay.substrateMcp.execute(rpc("tools/get", {})));
		expect(unknown.rpc.error?.code).toBe(-32601);
	});

	test("non-POST and off-path exchanges are refused before any parse", async () => {
		const h = harness();
		const get = decodeCall(await h.relay.substrateMcp.execute({ method: "GET", path: "/mcp" }));
		expect(get.status).toBe(400);
		const offPath = decodeCall(await h.relay.substrateMcp.execute({ method: "POST", path: "/other" }));
		expect(offPath.status).toBe(400);
		expect(h.seen).toHaveLength(0);
	});
});

describe("substrate relay tool boundary", () => {
	test("issue_get returns the bound node's issue text", async () => {
		const h = harness();
		const out = decodeCall(
			await h.relay.substrateMcp.execute(rpc("tools/call", { name: "issue_get", arguments: { graph_id: "forged", node_id: NID } })),
		);
		expect(out.rpc.error).toBeUndefined();
		expect(JSON.stringify(out.rpc.result)).toContain("TRC-9");
	});

	test("claim, heartbeat and every out-of-scope tool are refused without a server call", async () => {
		const h = harness();
		for (const name of ["graph_claim", "graph_heartbeat", "graph_get", "graph_find", "graph_bind", "docs_search", "skills_propose", "desktop_run"]) {
			const out = decodeCall(
				await h.relay.substrateMcp.execute(rpc("tools/call", { name, arguments: { graph_id: GID, node_id: NID } })),
			);
			expect(out.rpc.error?.code).toBe(-32602);
		}
		expect(h.seen).toHaveLength(0);
	});

	test("a forged graph id is ignored: the call binds the actor graph, never foreign", async () => {
		const h = harness();
		const other = decodeCall(
			await h.relay.substrateMcp.execute(rpc("tools/call", { name: "issue_get", arguments: { graph_id: "ut-other-99999999", node_id: NID } })),
		);
		expect(other.rpc.error).toBeUndefined();
		expect(JSON.stringify(other.rpc.result)).toContain("TRC-9");
		expect(JSON.stringify(other.rpc.result)).not.toContain("other");
		const missing = decodeCall(
			await h.relay.substrateMcp.execute(rpc("tools/call", { name: "graph_release", arguments: { graph_id: GID, node_id: "nope" } })),
		);
		expect(missing.rpc.error?.code).toBe(-32602);
	});
});

describe("substrate relay shared terminal transitions (SEC01)", () => {
	test("guest release records terminal release: tick idles and resume sends nothing", async () => {
		const h = harness();
		const out = decodeCall(
			await h.relay.substrateMcp.execute(
				rpc("tools/call", { name: "graph_release", arguments: { graph_id: GID, node_id: NID, lease_id: "lse_forged", force: true, surface: "hermes", session_id: "s-9" } }),
			),
		);
		expect(out.rpc.error).toBeUndefined();
		const status = await h.service.status(GID, NID);
		expect(status?.released).toBe(true);
		expect(await h.service.heartbeatTick(GID, NID)).toBe("idle");
		expect(await h.service.resumeInterrupted()).toBe(0);
	});

	test("guest release refusal leaves the record live and working", async () => {
		const h = harness({ leaseId: "lse_stale_00000000000000000000000000000000" });
		const out = decodeCall(
			await h.relay.substrateMcp.execute(rpc("tools/call", { name: "graph_release", arguments: { graph_id: GID, node_id: NID } })),
		);
		expect(JSON.stringify(out.rpc.result)).toContain("stale-lease");
		expect(JSON.stringify(out.rpc.result)).not.toContain(LEASE);
		const status = await h.service.status(GID, NID);
		expect(status?.released).toBe(false);
		expect(status?.turn_in_flight).toBe(true);
	});

	test("guest complete records terminal completion: tick idles and resume sends nothing", async () => {
		const h = harness();
		const out = decodeCall(
			await h.relay.substrateMcp.execute(
				rpc("tools/call", { name: "graph_complete", arguments: { graph_id: GID, node_id: NID, dod: { summary: "did the work", tests_pass: true }, lease_id: "lse_forged" } }),
			),
		);
		expect(out.rpc.error).toBeUndefined();
		const status = await h.service.status(GID, NID);
		expect(status?.released).toBe(true);
		expect(status?.exit_code).toBe(0);
		expect(await h.service.heartbeatTick(GID, NID)).toBe("idle");
		expect(await h.service.resumeInterrupted()).toBe(0);
	});

	test("complete validates dod before any server call", async () => {
		const h = harness();
		const bad = decodeCall(
			await h.relay.substrateMcp.execute(rpc("tools/call", { name: "graph_complete", arguments: { graph_id: GID, node_id: NID, dod: { summary: "", tests_pass: true } } })),
		);
		expect(bad.rpc.error?.code).toBe(-32602);
		const badType = decodeCall(
			await h.relay.substrateMcp.execute(rpc("tools/call", { name: "graph_complete", arguments: { graph_id: GID, node_id: NID, dod: { summary: "work", tests_pass: "yes" } } })),
		);
		expect(badType.rpc.error?.code).toBe(-32602);
		expect(h.seen).toHaveLength(0);
		const status = await h.service.status(GID, NID);
		expect(status?.released).toBe(false);
	});
});

describe("substrate relay kickoff re-register (SEC02)", () => {
	test("re-registers the bound graph while forged repo, nodes and step refs are ignored", async () => {
		const h = harness();
		const out = decodeCall(
			await h.relay.substrateMcp.execute(
				rpc("tools/call", {
					name: "graph_register",
					arguments: {
						graph_id: "ut-forged-00000000",
						repo: "evil/repo",
						branch: "evil",
						surface: "hermes",
						status: "Done",
						nodes: [{ node_id: "evil", linear_identifier: "EVL-9" }],
						steps: [{ node_id: "evil", step: 1, linear_sub_issue_id: "foreign-sub", notion_page: "https://foreign.example/x" }],
					},
				}),
			),
		);
		expect(out.rpc.error).toBeUndefined();
		expect(JSON.stringify(out.rpc.result)).toContain(GID);
		expect(JSON.stringify(out.rpc.result)).toContain("SUB-1");
		expect(JSON.stringify(out.rpc.result)).not.toContain("evil");
		expect(JSON.stringify(out.rpc.result)).not.toContain("foreign");
	});

	test("guest step refs never overwrite canonical refs", async () => {
		const h = harness();
		const out = decodeCall(
			await h.relay.substrateMcp.execute(
				rpc("tools/call", {
					name: "graph_register",
					arguments: {
						graph_id: GID,
						steps: [{ node_id: NID, step: 1, linear_sub_issue_id: "foreign-sub", notion_page: "https://foreign.example/x" }],
					},
				}),
			),
		);
		expect(out.rpc.error).toBeUndefined();
		expect(JSON.stringify(out.rpc.result)).toContain("SUB-1");
		expect(JSON.stringify(out.rpc.result)).not.toContain("foreign");
	});

	test("an unregistered graph is refused without a register call", async () => {
		const h = harness({
			reply: (url, body) => {
				if (url.endsWith("/issue")) return authorityReply(url, body);
				const parsed = z.object({ params: z.object({ name: z.string() }).passthrough() }).passthrough().safeParse(body);
				if (parsed.success && parsed.data.params.name === "graph_get") return jsonRpc(replyId(body), "No graph ut-relay-12345678");
				return authorityReply(url, body);
			},
		});
		const out = decodeCall(
			await h.relay.substrateMcp.execute(rpc("tools/call", { name: "graph_register", arguments: { graph_id: GID } })),
		);
		expect(out.rpc.error?.code).toBe(-32602);
	});
});

