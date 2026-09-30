/**
 * HTTP surface for substrate-mcp.
 *
 *   POST /mcp           MCP over streamable HTTP, for agents
 *   POST /brief         the same briefing as plain text, for hooks
 *   POST /events        append an event, for hooks
 *   POST /events/query  read a window of the ledger
 *   POST /verify        recompute a graph's hash chain
 *   GET  /healthz       store reachability, and whether events can actually be written
 *
 * Hooks get REST because a hook process cannot call an MCP tool — it has no
 * client. Both paths run the same service code.
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { surfaceForToken, type SubstrateConfig } from "./config.ts";
import { InvalidEventError } from "./event.ts";
import { createMcpServer } from "./mcp.ts";
import type { Substrate } from "./service.ts";
import type { Surface } from "./types.ts";

const MAX_BODY_BYTES = 1_000_000;

/**
 * The status `/healthz` answers with.
 *
 * A deployment that configured a ledger and cannot write to it is **not** healthy,
 * even while the brief still composes from the index: appends are fail-closed, so
 * every event is being dropped on the floor and a monitor watching only the status
 * code has to see that. Reporting it in the body alone would leave the one state
 * this hardening exists to catch looking like 200.
 *
 * A run with no `GREPTIME_URL` is a different thing — local dev, or a deployment
 * that deliberately has no ledger — and is judged on its remaining stores, as
 * before.
 */
export function healthStatus(
	health: { index: boolean; greptime: boolean; eventsWritable: boolean },
	ledgerConfigured: boolean,
): number {
	if (ledgerConfigured && !health.eventsWritable) return 503;
	return health.index || health.greptime ? 200 : 503;
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new Error("request body too large");
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
	res.writeHead(status, { "content-type": contentType });
	res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
	send(res, status, JSON.stringify(value), "application/json");
}

export function createHttpServer(substrate: Substrate, config: SubstrateConfig) {
	return createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
		const authorization = req.headers.authorization ?? null;
		const surface: Surface | null = surfaceForToken(config, authorization);

		// A configured deployment requires a token; a bare local run does not,
		// otherwise the operator is locked out of their own machine.
		if (!config.allowAnonymous && surface === null) {
			sendJson(res, 401, { error: "unknown or missing bearer token" });
			return;
		}

		try {
			if (req.method === "GET" && url.pathname === "/healthz") {
				const health = await substrate.health();
				sendJson(res, healthStatus(health, config.greptime !== null), health);
				return;
			}

			if (req.method === "POST" && url.pathname === "/brief") {
				const raw = await readBody(req);
				const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
				const brief = await substrate.brief({
					repo: typeof body.repo === "string" ? body.repo : undefined,
					branch: typeof body.branch === "string" ? body.branch : undefined,
					graph_id: typeof body.graph_id === "string" ? body.graph_id : undefined,
					surface: (typeof body.surface === "string" ? (body.surface as Surface) : null) ?? surface ?? "claude-code",
				});
				send(res, 200, brief, "text/markdown; charset=utf-8");
				return;
			}

			if (req.method === "POST" && url.pathname === "/events") {
				const raw = await readBody(req);
				const body = JSON.parse(raw) as Record<string, unknown>;
				const result = await substrate.emit({
					...(body as object),
					surface: (typeof body.surface === "string" ? (body.surface as Surface) : null) ?? surface ?? "claude-code",
				} as Parameters<Substrate["emit"]>[0]);
				// 503 when the ledger did not take it. The `substrate` CLI ignores the
				// status and exits 0 either way — failing open is the client's job, and
				// this surface owes its caller the truth about durability.
				sendJson(res, result.stored ? 202 : 503, {
					id: result.event.id,
					ts: result.event.ts,
					hash: result.event.hash,
					stored: result.stored,
					...(result.error ? { error: result.error } : {}),
					...(result.warning ? { warning: result.warning } : {}),
				});
				return;
			}

			// The read counterpart of `POST /events`, for callers that cannot speak MCP.
			// Same service call as the `events_query` tool, so the two cannot drift.
			if (req.method === "POST" && url.pathname === "/events/query") {
				const raw = await readBody(req);
				const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
				const result = await substrate.queryEvents(body as Parameters<Substrate["queryEvents"]>[0]);
				// An empty window is a real answer, so 200; 503 is the ledger not answering.
				sendJson(res, result.error ? 503 : 200, result);
				return;
			}

			if (req.method === "POST" && url.pathname === "/verify") {
				const raw = await readBody(req);
				const body = JSON.parse(raw) as { graph_id?: unknown };
				if (typeof body.graph_id !== "string") {
					sendJson(res, 400, { error: "graph_id is required" });
					return;
				}
				sendJson(res, 200, await substrate.verifyGraph(body.graph_id));
				return;
			}

			if (url.pathname === "/mcp") {
				await handleMcp(req, res, substrate, surface);
				return;
			}

			sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
		} catch (cause) {
			if (cause instanceof InvalidEventError) {
				sendJson(res, 400, { error: cause.message });
				return;
			}
			if (cause instanceof SyntaxError) {
				sendJson(res, 400, { error: "request body is not valid JSON" });
				return;
			}
			process.stderr.write(`[substrate] ${req.method} ${url.pathname}: ${String(cause)}\n`);
			if (!res.headersSent) sendJson(res, 500, { error: String(cause) });
		}
	});
}

/**
 * Stateless MCP: a fresh server and transport per request. The substrate holds
 * no per-session state of its own — everything it knows lives in Postgres and
 * Greptime — so there is nothing for a long-lived session to protect.
 */
async function handleMcp(
	req: IncomingMessage,
	res: ServerResponse,
	substrate: Substrate,
	surface: Surface | null,
): Promise<void> {
	if (req.method !== "POST") {
		// Stateless mode has no server-initiated stream to attach to.
		res.writeHead(405, { allow: "POST" }).end();
		return;
	}
	const raw = await readBody(req);
	const body: unknown = raw ? JSON.parse(raw) : undefined;

	const server = createMcpServer(substrate, surface);
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
	res.on("close", () => {
		void transport.close();
		void server.close();
	});
	await server.connect(transport);
	await transport.handleRequest(req, res, body);
}
