/**
 * HTTP surface of substrate-host on 127.0.0.1:7411 (D-06), consumed by the dispatcher's HostClient.
 *
 *   POST /tasks                          open (202 new | 200 existing | 400 | 409 | 502)
 *   GET  /tasks                          every task's status
 *   GET  /tasks/<gid>/<nid>              status (404 unknown)
 *   POST /tasks/<gid>/<nid>/terminate    cancel the running turn (202)
 *   POST /tasks/<gid>/<nid>/kill         cancel, unload the session, release the claim (202)
 *   GET  /healthz                        { engine, api }
 *
 * Transport copied from packages/mcp-server/src/server.ts: one createServer handler, bounded body,
 * SyntaxError → 400, anything else → stderr + 500. Path segments are validated before use.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isValidGraphId } from "./sandbox-options.ts";
import { isValidNodeId } from "./seed.ts";
import type { OpenResult, TaskStatus } from "./tasks.ts";

const MAX_BODY_BYTES = 1_000_000;

/** What the API needs from TaskService; api.test.ts passes a fake. */
export type ApiService = {
	openTask(body: unknown): Promise<OpenResult>;
	status(graphId: string, nodeId: string): Promise<TaskStatus | null>;
	list(): Promise<TaskStatus[]>;
	terminate(graphId: string, nodeId: string): Promise<boolean>;
	kill(graphId: string, nodeId: string): Promise<boolean>;
};

export type ApiOptions = {
	/** Reports whether the rivet engine finished starting; defaults to true. */
	engineReady?: () => boolean;
};

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

function sendJson(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(value));
}

const TASK_PATH_RE = /^\/tasks\/([^/]+)\/([^/]+)(?:\/(terminate|kill))?$/;

export function createApiServer(service: ApiService, options: ApiOptions = {}): Server {
	const engineReady = options.engineReady ?? (() => true);
	return createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
		try {
			if (req.method === "GET" && url.pathname === "/healthz") {
				sendJson(res, 200, { engine: engineReady(), api: true });
				return;
			}

			if (url.pathname === "/tasks") {
				if (req.method === "POST") {
					const raw = await readBody(req);
					const body: unknown = raw === "" ? {} : JSON.parse(raw);
					const result = await service.openTask(body);
					sendJson(res, result.status, result.body);
					return;
				}
				if (req.method === "GET") {
					sendJson(res, 200, await service.list());
					return;
				}
			}

			const match = TASK_PATH_RE.exec(url.pathname);
			if (match) {
				const gid = decodeURIComponent(match[1] ?? "");
				const nid = decodeURIComponent(match[2] ?? "");
				const verb = match[3];
				if (!isValidGraphId(gid) || !isValidNodeId(nid)) {
					sendJson(res, 400, { error: "invalid graph_id or node_id in path" });
					return;
				}
				if (!verb && req.method === "GET") {
					const status = await service.status(gid, nid);
					if (!status) sendJson(res, 404, { error: `no task ${gid}/${nid}` });
					else sendJson(res, 200, status);
					return;
				}
				if (verb && req.method === "POST") {
					const done = verb === "terminate" ? await service.terminate(gid, nid) : await service.kill(gid, nid);
					if (!done) sendJson(res, 404, { error: `no task ${gid}/${nid}` });
					else sendJson(res, 202, { graph_id: gid, node_id: nid, [verb]: "accepted" });
					return;
				}
			}

			sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
		} catch (cause) {
			if (cause instanceof SyntaxError) {
				sendJson(res, 400, { error: "request body is not valid JSON" });
				return;
			}
			process.stderr.write(`[substrate-host] ${req.method} ${url.pathname}: ${String(cause)}\n`);
			if (!res.headersSent) sendJson(res, 500, { error: String(cause) });
		}
	});
}
