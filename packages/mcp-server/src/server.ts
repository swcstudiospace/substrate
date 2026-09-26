/**
 * HTTP surface for substrate-mcp.
 *
 *   POST /mcp      MCP over streamable HTTP, for agents
 *   POST /brief    the same briefing as plain text, for hooks
 *   POST /events   append an event, for hooks
 *   POST /verify   check a graph's event hash chain
 *   POST /issue    a node's Linear issue text, redacted and untrusted, for hooks and host functions
 *   POST /skills/propose  propose a skill to the shared library (branch + PR), for host clients
 *   GET  /healthz  store reachability
 *
 * Hooks get REST because a hook process cannot call an MCP tool — it has no
 * client. Both paths run the same service code.
 *
 * POST /skills/propose and the MCP tool skills_propose spend the owner's GitHub credential, so
 * they need more than the anonymous local access the other routes allow: an authenticated
 * bearer surface, or the header x-substrate-propose-key equal to the root-only key file
 * (skills/propose-auth.ts). Anything else is 401 before the body is read — a rivet VM guest
 * reaches this port anonymously and cannot read the key.
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { surfaceForToken, type SubstrateConfig } from "./config.ts";
import { InvalidEventError } from "./event.ts";
import { createMcpServer } from "./mcp.ts";
import { redact } from "./redact.ts";
import type { Substrate } from "./service.ts";
import { PROPOSE_KEY_HEADER, proposeAllowed, readProposeKey } from "./skills/propose-auth.ts";
import { ProposeFailed, type ProposeInput, ProposeRefused } from "./skills/propose.ts";
import { SURFACES, type Surface } from "./types.ts";

const MAX_BODY_BYTES = 1_000_000;
const PROPOSE_UNAUTHORIZED = "skills propose needs an authenticated surface or the host propose key";

/** A body over MAX_BODY_BYTES: 413, and final for that body. */
export class BodyTooLargeError extends Error {
	constructor() {
		super("request body too large");
		this.name = "BodyTooLargeError";
	}
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
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

/** The propose body's shape (the service validates content); a message for 400, or null. */
function proposeBodyProblem(body: unknown): string | null {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
	const b = body as Record<string, unknown>;
	if (typeof b.name !== "string") return "name must be a string";
	if (b.files === null || typeof b.files !== "object" || Array.isArray(b.files)) return "files must be an object of relative path to text";
	if (Object.values(b.files).some((value) => typeof value !== "string")) return "every file must be a string of UTF-8 text";
	if (typeof b.rationale !== "string") return "rationale must be a string";
	if (b.remove !== undefined && (!Array.isArray(b.remove) || b.remove.some((path) => typeof path !== "string"))) {
		return "remove must be an array of relative paths";
	}
	if (b.surface !== undefined && (typeof b.surface !== "string" || !(SURFACES as readonly string[]).includes(b.surface))) {
		return `unknown surface ${JSON.stringify(String(b.surface)).slice(0, 80)}`;
	}
	for (const key of ["session_id", "graph_id"] as const) {
		if (b[key] !== undefined && typeof b[key] !== "string") return `${key} must be a string`;
	}
	return null;
}

/** `deps` is the test seam for the propose key; production reads the key file on every request. */
export function createHttpServer(
	substrate: Substrate,
	config: SubstrateConfig,
	deps: { readProposeKey?: () => string | null } = {},
) {
	const readKey = deps.readProposeKey ?? (() => readProposeKey());
	return createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
		const authorization = req.headers.authorization ?? null;
		const surface: Surface | null = surfaceForToken(config, authorization);
		const mayPropose = () => proposeAllowed({ callerSurface: surface, header: req.headers[PROPOSE_KEY_HEADER], key: readKey() });

		// A configured deployment requires a token; a bare local run does not,
		// otherwise the operator is locked out of their own machine.
		if (!config.allowAnonymous && surface === null) {
			sendJson(res, 401, { error: "unknown or missing bearer token" });
			return;
		}

		try {
			if (req.method === "GET" && url.pathname === "/healthz") {
				const health = await substrate.health();
				sendJson(res, health.index || health.greptime ? 200 : 503, health);
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
				const event = await substrate.emit({
					...(body as object),
					surface: (typeof body.surface === "string" ? (body.surface as Surface) : null) ?? surface ?? "claude-code",
				} as Parameters<Substrate["emit"]>[0]);
				sendJson(res, 202, { id: event.id, ts: event.ts, hash: event.hash });
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

			if (req.method === "POST" && url.pathname === "/issue") {
				const raw = await readBody(req);
				const body = JSON.parse(raw) as { graph_id?: unknown; node_id?: unknown };
				if (typeof body.graph_id !== "string" || typeof body.node_id !== "string") {
					sendJson(res, 400, { error: "graph_id and node_id are required" });
					return;
				}
				sendJson(res, 200, await substrate.getIssue(body.graph_id, body.node_id));
				return;
			}

			if (req.method === "POST" && url.pathname === "/skills/propose") {
				if (!mayPropose()) {
					sendJson(res, 401, { error: PROPOSE_UNAUTHORIZED });
					return;
				}
				const body = JSON.parse(await readBody(req)) as unknown;
				const problem = proposeBodyProblem(body);
				if (problem) {
					sendJson(res, 400, { error: problem });
					return;
				}
				const b = body as Record<string, unknown>;
				const named = b.surface as Surface | undefined;
				if (surface !== null && named !== undefined && named !== surface) {
					sendJson(res, 400, { error: `surface ${named} does not match the authenticated caller ${surface}` });
					return;
				}
				const input: ProposeInput = {
					name: b.name as string,
					files: b.files as Record<string, string>,
					rationale: b.rationale as string,
					surface: named ?? surface ?? "claude-code",
					...(b.remove !== undefined ? { remove: b.remove as string[] } : {}),
					...(typeof b.session_id === "string" ? { session_id: b.session_id } : {}),
					...(typeof b.graph_id === "string" ? { graph_id: b.graph_id } : {}),
				};
				sendJson(res, 200, await substrate.proposeSkill(input));
				return;
			}

			if (url.pathname === "/mcp") {
				await handleMcp(req, res, substrate, surface, mayPropose());
				return;
			}

			sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
		} catch (cause) {
			if (cause instanceof BodyTooLargeError) {
				sendJson(res, 413, { error: cause.message });
				return;
			}
			if (cause instanceof ProposeRefused) {
				sendJson(res, 400, { error: cause.message, ...(cause.findings ? { findings: cause.findings } : {}) });
				return;
			}
			if (cause instanceof ProposeFailed) {
				sendJson(res, 502, { error: redact(cause.message).slice(0, 400) });
				return;
			}
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
	proposeAllowedForSession: boolean,
): Promise<void> {
	if (req.method !== "POST") {
		// Stateless mode has no server-initiated stream to attach to.
		res.writeHead(405, { allow: "POST" }).end();
		return;
	}
	const raw = await readBody(req);
	const body: unknown = raw ? JSON.parse(raw) : undefined;

	const server = createMcpServer(substrate, surface, { proposeAllowed: proposeAllowedForSession });
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
	res.on("close", () => {
		void transport.close();
		void server.close();
	});
	await server.connect(transport);
	await transport.handleRequest(req, res, body);
}
