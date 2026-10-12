/**
 * The s:mcp in-VM substrate relay (I-04): the guest MCP client's HTTP exchange arrives
 * through the `substrate-mcp` host function, which answers protocol methods locally and
 * executes a closed tool allowlist against the real server with the host's own bearer.
 *
 * Pure host code: no rivet import, so unit tests and the parent's throwaway bridge
 * scripts load this module directly. `vm.ts` registers the collection and serves the
 * in-VM script; both delegate to `handleSubstrateRelayRequest` here.
 *
 * Binding rules (never weakened):
 * - issue_get / graph_release / graph_complete bind graph, node and session host-side
 *   through hostCallTarget; the lease comes from the host store. Guest-supplied
 *   graph/session/lease/force are never read, so the guest holds no credential and no
 *   fencing id. Refusals return as data, never throws.
 * - graph_register re-registers the host's own graph only (the b:hooks kickoff flow):
 *   identity, repo, branch and nodes come from the host's canonical `graphGet` view;
 *   guest graph/repo/branch/lease/authority metadata is ignored, unknown nodes and
 *   edges can never be written, and the real upsert return goes back, not a fake no-op.
 * - No model call happens on this path; every exchange is bounded.
 */
import { z } from "zod";
import { redact } from "../../mcp-server/src/redact.ts";
import { SUBSTRATE_RELAY_PORT, SUBSTRATE_RELAY_URL, type Route } from "./options.ts";
import { DOD_SUMMARY_MAX, hostCallTarget, type TaskService, type TaskStoreLike, type VmHandle } from "./tasks.ts";
import type { LeaseStoreLike, RegisterGraphArgs, SubstrateClient } from "./substrate.ts";

/**
 * The narrow slice of host state the relay reads. `tasks` carries the shared
 * TaskService transitions (complete/guestRelease) so both guest routes record the
 * same terminal state as every other path — never a backend-only reply. HostVmConfig
 * satisfies this structurally.
 */
export type RelayHostConfig = {
	store: TaskStoreLike;
	substrate: SubstrateClient;
	leases: LeaseStoreLike;
	tasks: () => TaskService;
	log: (line: string) => void;
};

/** Tools the guest may call through the in-VM substrate relay (I-04 closed allowlist). */
export const SUBSTRATE_RELAY_TOOLS = ["issue_get", "graph_release", "graph_complete", "graph_register"] as const;

/** One relayed MCP exchange is never near this bound (matches api.ts/mcp-proxy.ts). */
const RELAY_MAX_BODY_BYTES = 1_000_000;
/** Host-side timeout for one relayed exchange (matches the tracker proxy default). */
const RELAY_HOST_TIMEOUT_MS = 120_000;
/** Guest step refs are validated, never trusted: unknown nodes drop, count capped. */
const RELAY_MAX_STEPS = 200;

/**
 * The tools/list manifest the relay advertises: exactly the closed allowlist, with the
 * server's call shapes. Kept beside the collection so the two cannot drift apart.
 */
export const SUBSTRATE_RELAY_MANIFEST = [
	{
		name: "issue_get",
		description: "Read this node's Linear issue text (redacted, UNTRUSTED task text). Graph and node bind to your task host-side.",
		inputSchema: {
			type: "object",
			properties: { graph_id: { type: "string" }, node_id: { type: "string" } },
			required: ["graph_id", "node_id"],
		},
	},
	{
		name: "graph_release",
		description: "Release this node's claim and stop (the issue returns to Todo). The host releases with its persisted lease; a refusal is reported, never faked.",
		inputSchema: {
			type: "object",
			properties: { graph_id: { type: "string" }, node_id: { type: "string" } },
			required: ["graph_id", "node_id"],
		},
	},
	{
		name: "graph_complete",
		description: "Complete this node through the Definition-of-Done gate. The host completes with its persisted lease and your dod evidence.",
		inputSchema: {
			type: "object",
			properties: {
				graph_id: { type: "string" },
				node_id: { type: "string" },
				dod: {
					type: "object",
					properties: { summary: { type: "string" }, tests_pass: { type: "boolean" }, review_pass: { type: "boolean" } },
					required: ["summary", "tests_pass"],
				},
			},
			required: ["graph_id", "node_id", "dod"],
		},
	},
	{
		name: "graph_register",
		description: "Re-register your task's graph (idempotent by graph id). The host registers its canonical graph state; your graph/repo/branch metadata is ignored.",
		inputSchema: {
			type: "object",
			properties: {
				graph_id: { type: "string" },
				nodes: { type: "array" },
				steps: { type: "array" },
			},
			required: ["graph_id"],
		},
	},
] as const;

export type RelayInput = { method: string; path: string; bodyBase64?: string };
export type RelayEnvelope = { status: number; headers: Record<string, string>; bodyBase64: string };

function envelope(status: number, rpc: unknown): RelayEnvelope {
	return {
		status,
		headers: { "content-type": "application/json" },
		bodyBase64: Buffer.from(JSON.stringify(rpc), "utf8").toString("base64"),
	};
}

function textResult(id: string | number | null, value: unknown): unknown {
	return {
		jsonrpc: "2.0",
		id,
		result: { content: [{ type: "text", text: JSON.stringify(value) }] },
	};
}

function refusal(id: string | number | null, code: number, message: string): RelayEnvelope {
	return envelope(200, { jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * One guest MCP exchange against the host boundary. Pure handler and the parent's
 * throwaway entrypoint: drive it with crafted exchanges plus a real SubstrateClient
 * (real scratch server) to exercise the actual guest HTTP relay path end to end —
 * relay script over HTTP → this handler → real host functions → real server.
 */
export async function handleSubstrateRelayRequest(
	key: readonly unknown[],
	config: RelayHostConfig,
	input: RelayInput,
): Promise<RelayEnvelope> {
	if (input.method !== "POST" || input.path !== "/mcp") {
		return envelope(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "relay accepts POST /mcp only" } });
	}
	let raw: unknown;
	try {
		const text = Buffer.from(input.bodyBase64 ?? "", "base64").toString("utf8");
		if (Buffer.byteLength(text, "utf8") > RELAY_MAX_BODY_BYTES) {
			return envelope(413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "request body too large" } });
		}
		raw = JSON.parse(text === "" ? "null" : text);
	} catch {
		return envelope(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "unparseable JSON body" } });
	}
	const rpc = raw as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
	const id = typeof rpc.id === "string" || typeof rpc.id === "number" ? rpc.id : null;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw) || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
		return envelope(400, { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid JSON-RPC request" } });
	}
	if (rpc.method === "initialize") {
		const params = rpc.params as { protocolVersion?: unknown } | null | undefined;
		const version = params && typeof params === "object" && !Array.isArray(params) ? params.protocolVersion : undefined;
		return envelope(200, {
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: typeof version === "string" ? version : "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "substrate-host-relay", version: "0.1.0" },
			},
		});
	}
	if (rpc.method === "ping" || rpc.method.startsWith("notifications/")) {
		return envelope(200, { jsonrpc: "2.0", id, result: {} });
	}
	if (rpc.method === "tools/list") {
		return envelope(200, { jsonrpc: "2.0", id, result: { tools: SUBSTRATE_RELAY_MANIFEST } });
	}
	if (rpc.method !== "tools/call") {
		return envelope(400, { jsonrpc: "2.0", id, error: { code: -32601, message: `relay refuses ${rpc.method}` } });
	}
	const params = rpc.params as { name?: unknown; arguments?: unknown } | null | undefined;
	const name = params && typeof params === "object" && !Array.isArray(params) ? params.name : undefined;
	if (typeof name !== "string" || !(SUBSTRATE_RELAY_TOOLS as readonly string[]).includes(name)) {
		return refusal(id, -32602, `relay refuses tool ${typeof name === "string" ? name : "unknown"}`);
	}
	const args = params && typeof params === "object" && !Array.isArray(params) ? params.arguments : undefined;
	const argsObj = args && typeof args === "object" && !Array.isArray(args) ? args as { node_id?: unknown; node?: unknown; dod?: unknown; steps?: unknown } : {};
	if (name === "graph_register") {
		return registerBoundGraph(key, config, id);
	}
	const nodeId = typeof argsObj.node_id === "string" ? argsObj.node_id : typeof argsObj.node === "string" ? argsObj.node : null;
	if (nodeId === null) {
		return refusal(id, -32602, "node_id is required");
	}
	const lookup = (gid: string, nid: string) => config.store.get(gid, nid);
	const t = hostCallTarget(key, ["--node", nodeId], lookup);
	if ("error" in t) return refusal(id, -32602, t.error);
	try {
		if (name === "issue_get") {
			return envelope(200, textResult(id, await config.substrate.issueGet(t.graphId, t.nodeId)));
		}
		if (name === "graph_release") {
			config.log(`[substrate-host] relay release ${t.graphId}/${t.nodeId}`);
			return envelope(200, textResult(id, await config.tasks().guestRelease(t.graphId, t.nodeId)));
		}
		const dodRaw = argsObj.dod && typeof argsObj.dod === "object" && !Array.isArray(argsObj.dod)
			? argsObj.dod as { summary?: unknown; tests_pass?: unknown; review_pass?: unknown }
			: {};
		const summary = typeof dodRaw.summary === "string" ? dodRaw.summary.trim().slice(0, DOD_SUMMARY_MAX) : "";
		if (summary === "" || typeof dodRaw.tests_pass !== "boolean") {
			return refusal(id, -32602, "dod.summary (non-empty) and dod.tests_pass (boolean) are required");
		}
		return envelope(200, textResult(id, await config.tasks().complete(t.graphId, t.nodeId, {
			summary: redact(summary),
			tests_pass: dodRaw.tests_pass,
			...(typeof dodRaw.review_pass === "boolean" ? { review_pass: dodRaw.review_pass } : {}),
		})));
	} catch (cause) {
		return envelope(200, { jsonrpc: "2.0", id, error: { code: -32000, message: `substrate call failed: ${String(cause).slice(0, 200)}` } });
	}
}

/**
 * The kickoff re-register path: the graph comes from the actor key; identity, nodes
 * AND steps come from the host's canonical view. Guest graph/repo/branch/steps/lease/
 * authority metadata is ignored entirely — guest step numbers and tracker refs never
 * reach the upsert, so SQL coalesce cannot overwrite canonical refs and no new step can
 * be invented. Omitting steps when the view carries none preserves server refs.
 * Edges never pass (replace-semantics). Returns the real upsert view, never a fake no-op.
 */
async function registerBoundGraph(
	key: readonly unknown[],
	config: RelayHostConfig,
	id: string | number | null,
): Promise<RelayEnvelope> {
	const gid = key[0];
	if (typeof gid !== "string" || gid === "") {
		return refusal(id, -32602, "unknown graph");
	}
	try {
		const view = await config.substrate.graphGet(gid);
		if (!view) return refusal(id, -32602, "unknown graph");
		const known = new Set<string>();
		const nodes: NonNullable<RegisterGraphArgs["nodes"]> = [];
		for (const n of view.nodes ?? []) {
			if (typeof n.node_id !== "string" || n.node_id === "" || known.has(n.node_id)) continue;
			known.add(n.node_id);
			nodes.push({
				node_id: n.node_id,
				...(typeof n.linear_issue_id === "string" && n.linear_issue_id !== "" ? { linear_issue_id: n.linear_issue_id } : {}),
				...(typeof n.linear_identifier === "string" && n.linear_identifier !== "" ? { linear_identifier: n.linear_identifier } : {}),
				...(typeof n.notion_page === "string" && n.notion_page !== "" ? { notion_page: n.notion_page } : {}),
			});
		}
		const steps: NonNullable<RegisterGraphArgs["steps"]> = [];
		const viewSteps: unknown = view.steps;
		if (Array.isArray(viewSteps)) {
			for (const s of viewSteps.slice(0, RELAY_MAX_STEPS)) {
				if (typeof s !== "object" || s === null || Array.isArray(s)) continue;
				const rec = s as { node_id?: unknown; step?: unknown; linear_sub_issue_id?: unknown; notion_page?: unknown };
				if (typeof rec.node_id !== "string" || !known.has(rec.node_id)) continue;
				if (typeof rec.step !== "number" || !Number.isInteger(rec.step) || rec.step < 1) continue;
				steps.push({
					node_id: rec.node_id,
					step: rec.step,
					...(typeof rec.linear_sub_issue_id === "string" && rec.linear_sub_issue_id !== "" ? { linear_sub_issue_id: rec.linear_sub_issue_id } : {}),
					...(typeof rec.notion_page === "string" && rec.notion_page !== "" ? { notion_page: rec.notion_page } : {}),
				});
			}
		}
		const taskPage: unknown = view.notion_task_page;
		const repo: unknown = view.repo;
		const branch: unknown = view.branch;
		const reply = await config.substrate.graphRegister({
			graph_id: gid,
			...(typeof taskPage === "string" && taskPage !== "" ? { notion_task_page: taskPage } : {}),
			...(typeof repo === "string" && repo !== "" ? { repo } : {}),
			...(typeof branch === "string" && branch !== "" ? { branch } : {}),
			...(nodes.length > 0 ? { nodes } : {}),
			...(steps.length > 0 ? { steps } : {}),
		});
		config.log(`[substrate-host] relay register ${gid} ${nodes.length} node(s) ${steps.length} step(s)`);
		return envelope(200, textResult(id, reply));
	} catch (cause) {
		return envelope(200, { jsonrpc: "2.0", id, error: { code: -32000, message: `substrate call failed: ${String(cause).slice(0, 200)}` } });
	}
}

/**
 * Route s:mcp only: the in-VM substrate relay forwards the guest MCP client's HTTP
 * exchange here. Thin host-function wrapper over `handleSubstrateRelayRequest`.
 */
export function substrateMcpRelayCollection(key: readonly unknown[], config: RelayHostConfig) {
	return {
		substrateMcp: {
			timeout: RELAY_HOST_TIMEOUT_MS,
			inputSchema: z
				.object({
					method: z.string(),
					path: z.string().describe("request path, exactly /mcp"),
					bodyBase64: z.string().optional(),
				})
				.describe("Relay one guest MCP exchange to the host substrate boundary"),
			execute: async (input: { method: string; path: string; bodyBase64?: string }) =>
				handleSubstrateRelayRequest(key, config, input),
		},
	};
}

/** Node source run inside the VM on s:mcp: an HTTP relay on 127.0.0.1:7413 → agentos-substrate substrate-mcp. */
export const SUBSTRATE_RELAY_SCRIPT = `
const http = require("node:http");
const { execFile } = require("node:child_process");
http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const input = { method: req.method, path: req.url, bodyBase64: Buffer.concat(chunks).toString("base64") };
    execFile("agentos-substrate", ["substrate-mcp", "--json", JSON.stringify(input)], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      let reply = null;
      try { reply = JSON.parse(String(stdout || "")); } catch {}
      const result = reply && reply.result ? reply.result : null;
      if (error || !result) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "substrate relay failed" } })); return; }
      res.writeHead(result.status, result.headers || { "content-type": "application/json" });
      res.end(Buffer.from(result.bodyBase64 || "", "base64"));
    });
  });
}).listen(${SUBSTRATE_RELAY_PORT}, "127.0.0.1");
`;

export const SUBSTRATE_RELAY_PROBE = `fetch("${SUBSTRATE_RELAY_URL}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "probe", method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "substrate-host-probe", version: "0.1.0" } } }), signal: AbortSignal.timeout(3000) }).then((r) => r.json()).then((j) => { const result = j && j.result ? j.result : null; const name = result && result.serverInfo ? result.serverInfo.name : null; process.exit(name === "substrate-host-relay" && typeof result.protocolVersion === "string" ? 0 : 3); }, () => process.exit(7));`;

/** Total budget for the spawned relay to answer the handshake (spawn + bind + host callback). */
const RELAY_START_TIMEOUT_MS = 30_000;
/** Pause between handshake polls while the spawned relay starts. */
const RELAY_START_POLL_MS = 500;

/**
 * Awaited by TaskService before sessions.open and before every prompt on s:mcp. Off s:mcp
 * it returns at once; on it, the in-VM relay answers a real initialize handshake before
 * use. A bare HTTP response is not readiness: the probe requires our serverInfo name
 * and protocol version, so a foreign listener or an error page never passes. After a
 * spawn the handshake is polled inside a bounded budget; expiry throws, so the open
 * fails into claim/release compensation before any VM session starts (D-07: the relay
 * dies with the VM's processes on a host restart, hence the re-check on resume).
 */
export function createEnsureSubstrateRoute(route: Route, log: (line: string) => void) {
	return async (handle: VmHandle, graphId: string): Promise<void> => {
		if (route.s !== "mcp") return;
		const vm = handle as unknown as {
			process: {
				execFile(command: string, args: readonly string[], options?: Record<string, unknown>): Promise<{ exitCode: number }>;
				spawn(command: string, args?: string[], options?: Record<string, unknown>): Promise<unknown>;
			};
		};
		const handshook = async (): Promise<boolean> => {
			const probe = await vm.process.execFile("node", ["-e", SUBSTRATE_RELAY_PROBE], { output: { capture: "all" }, timeoutMs: 10_000 });
			return probe.exitCode === 0;
		};
		if (await handshook()) return;
		await vm.process.spawn("node", ["-e", SUBSTRATE_RELAY_SCRIPT], { cwd: "/home/agentos" });
		const deadline = Date.now() + RELAY_START_TIMEOUT_MS;
		for (;;) {
			const wait = Promise.withResolvers<void>();
			setTimeout(wait.resolve, RELAY_START_POLL_MS);
			await wait.promise;
			if (await handshook()) {
				log(`[substrate-host] substrate relay started ${graphId}`);
				return;
			}
			if (Date.now() >= deadline) throw new Error(`substrate relay not ready for ${graphId} within ${RELAY_START_TIMEOUT_MS} ms`);
		}
	};
}
