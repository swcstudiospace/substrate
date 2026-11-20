// Host-side substrate MCP proxy (phase 32). The VM's substrate MCP entry points at this loopback
// listener; it forwards each request to the host's substrate-mcp and adds the host's job bearer.
// The VM never holds the bearer: whatever Authorization header the VM sends is dropped.
// The bearer is resolved on the host (SubstrateClient: SUBSTRATE_TOKEN_SUBSTRATE, then
// SUBSTRATE_TOKEN, SUBSTRATE_TOKEN_FILE, SUBSTRATE_TOKENS_DIR) and is never logged.
import { type IncomingMessage, type Server, type ServerResponse, createServer, request as httpRequest } from "node:http";

export const SUBSTRATE_PROXY_PORT = 7413;
export const SUBSTRATE_PROXY_URL = `http://127.0.0.1:${SUBSTRATE_PROXY_PORT}/mcp`;
export const SUBSTRATE_PROXY_PATH = "/mcp";
/** Same bound as mcp-proxy.ts: one MCP message is never near it. */
export const MAX_BODY_BYTES = 1_000_000;

/** Headers never forwarded in either direction; the proxy sets content-length and authorization itself. */
const HOP_BY_HOP = new Set([
	"authorization",
	"connection",
	"content-length",
	"cookie",
	"host",
	"keep-alive",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

export type SubstrateProxyOptions = {
	/** Full URL of the host's substrate MCP endpoint, e.g. http://127.0.0.1:7410/mcp. */
	upstream: string;
	/** The host's job bearer; attached to every forwarded request. */
	bearer: string;
	log: (line: string) => void;
};

class BodyTooLargeError extends Error {
	constructor() {
		super("request body too large");
	}
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
	const chunks: Buffer[] = [];
	let size = 0;
	req.on("data", (chunk: Buffer) => {
		size += chunk.byteLength;
		if (size > MAX_BODY_BYTES) {
			reject(new BodyTooLargeError());
			req.resume();
			return;
		}
		chunks.push(chunk);
	});
	req.on("end", () => resolve(Buffer.concat(chunks)));
	req.on("error", reject);
	return promise;
}

/** The node:http server; the caller binds it (startSubstrateProxy binds 127.0.0.1 only). */
export function createSubstrateProxy(options: SubstrateProxyOptions): Server {
	const upstream = new URL(options.upstream);

	function forward(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(req.headers)) {
			if (value === undefined || HOP_BY_HOP.has(name)) continue;
			headers[name] = Array.isArray(value) ? value.join(", ") : value;
		}
		headers.authorization = `Bearer ${options.bearer}`;
		headers["content-length"] = String(body.byteLength);

		const up = httpRequest(upstream, { method: req.method, headers }, (upRes) => {
			const out: Record<string, string | string[]> = {};
			for (const [name, value] of Object.entries(upRes.headers)) {
				if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value;
			}
			res.writeHead(upRes.statusCode ?? 502, out);
			upRes.pipe(res);
		});
		up.on("error", (cause) => {
			options.log(`[substrate-host] substrate proxy upstream failed: ${cause.message}`);
			if (res.headersSent) res.destroy();
			else sendJson(res, 502, { error: "substrate upstream unreachable" });
		});
		up.end(body);
	}

	return createServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
		if (path !== SUBSTRATE_PROXY_PATH) {
			sendJson(res, 404, { error: `no route for ${req.method} ${path}` });
			return;
		}
		readBody(req).then(
			(body) => forward(req, res, body),
			(cause: unknown) => {
				if (cause instanceof BodyTooLargeError) sendJson(res, 413, { error: cause.message });
				else sendJson(res, 400, { error: cause instanceof Error ? cause.message : String(cause) });
			},
		);
	});
}

/** Binds 127.0.0.1:7413 only: the VM reaches it through the loopback exemption, nothing else does. */
export function startSubstrateProxy(options: SubstrateProxyOptions): Server {
	const server = createSubstrateProxy(options);
	server.listen(SUBSTRATE_PROXY_PORT, "127.0.0.1", () => {
		options.log(`[substrate-host] substrate mcp proxy 127.0.0.1:${SUBSTRATE_PROXY_PORT}`);
	});
	return server;
}
