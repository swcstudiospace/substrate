/**
 * Tracker MCP proxy on 127.0.0.1:7412 (D-10, D-08; served only on tracker_route vm_mcp).
 *
 *   POST /mcp/notion   → host child `ultrathink-mcp serve notion`
 *   POST /mcp/linear   → host child `ultrathink-mcp serve linear`
 *
 * Stateless streamable-HTTP: one JSON-RPC message per POST, forwarded as one line to the child's
 * stdin; the child's reply with the same id comes back as the HTTP body (200), notifications answer
 * 202. No Mcp-Session-Id is issued — the relay child keeps the remote session. The children run
 * with HOME=/root and read/refresh the host's own OAuth store (research Pitfall 8), so no Notion or
 * Linear credential ever passes through this process, the VM or rivet's storage.
 *
 * Two guards keep the DoD gate whole (Phase 2 D-06/D-07, 03-07): a Linear tools/call carrying a
 * state/stateId/statusId key and a Notion tools/call setting Completed or a terminal Status are
 * answered with JSON-RPC error -32001 and never reach the child. Log lines carry the tracker, the
 * method and the tool name only — never params, replies or the child's stderr.
 *
 * Pure node built-ins; no rivet import (mcp-proxy.test.ts loads this file under bun:test).
 */
import { spawn as spawnProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { errorLabel } from "./error-label.ts";
import { TRACKER_PROXY_PORT } from "./options.ts";

export const TRACKERS = ["notion", "linear"] as const;
export type Tracker = (typeof TRACKERS)[number];

/** Same bound as api.ts: one MCP message is never near it. */
export const MAX_BODY_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_ULTRATHINK_MCP = "/root/.claude/plugins/cache/ultrathink/ultrathink/0.3.0/bin/ultrathink-mcp";

/** JSON-RPC error the guards answer with; the message names the only path to Done. */
const REFUSED_CODE = -32001;

const LINEAR_STATE_KEYS = ["state", "stateId", "statusId"];
const NOTION_TERMINAL_STATUS = ["merged", "done", "failed", "blocked"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Depth-first walk over objects and arrays; `visit` returns true to stop. */
function walk(value: unknown, visit: (key: string, value: unknown) => boolean, parseStrings: boolean): boolean {
	if (Array.isArray(value)) return value.some((item) => walk(item, visit, parseStrings));
	if (isRecord(value)) {
		for (const [key, child] of Object.entries(value)) {
			if (visit(key, child)) return true;
			if (walk(child, visit, parseStrings)) return true;
		}
		return false;
	}
	if (parseStrings && typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			return false;
		}
		return walk(parsed, visit, parseStrings);
	}
	return false;
}

/** Phase 2 D-06/D-07: Linear Done comes only from graph_complete — no state write from the VM. */
export function linearStateChange(args: unknown): boolean {
	return walk(args, (key) => LINEAR_STATE_KEYS.includes(key), false);
}

function statusName(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (isRecord(value)) {
		if (typeof value.name === "string") return value.name;
		if (isRecord(value.status) && typeof value.status.name === "string") return value.status.name;
	}
	return null;
}

/**
 * 03-07's truth: sync moves no Notion Status; terminal Status values and Completed come only from
 * graph_complete's mirror. Status Implementing (kickoff) and the PR fields pass.
 */
export function notionTerminalWrite(args: unknown): boolean {
	return walk(
		args,
		(key, value) => {
			if (key === "Completed" || key === "date:Completed:start" || key === "date:Completed:end") return true;
			if (key !== "Status") return false;
			const name = statusName(value);
			return name !== null && NOTION_TERMINAL_STATUS.includes(name.toLowerCase());
		},
		true,
	);
}

/** One `ultrathink-mcp serve <tracker>` process, as the bridge sees it (mcp-proxy.test.ts fakes it). */
export type TrackerChild = {
	write(line: string): void;
	onLine(cb: (line: string) => void): void;
	onExit(cb: () => void): void;
	kill(): void;
};

type SpawnTrackerChild = (tracker: Tracker) => TrackerChild;

type JsonRpcId = string | number;
type JsonRpcMessage = { jsonrpc?: unknown; id?: JsonRpcId | null; method?: unknown; params?: unknown; [key: string]: unknown };

class BridgeError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

type Pending = { originalId: JsonRpcId; resolve: (reply: JsonRpcMessage) => void; reject: (cause: BridgeError) => void; timer: ReturnType<typeof setTimeout> };
type Live = { child: TrackerChild; pending: Map<string, Pending> };

function idKey(id: JsonRpcId): string {
	return typeof id === "number" ? `n:${id}` : `s:${id}`;
}

type StdioBridgeOptions = { spawn: SpawnTrackerChild; log: (line: string) => void; timeoutMs?: number | undefined };

/**
 * Lazy single child per tracker, pending replies matched by JSON-RPC id, respawn after exit. A
 * request whose id is already in flight (two VM clients counting from the same number) is sent
 * under an alias and its reply carries the original id back.
 */
export class StdioBridge {
	private readonly spawn: SpawnTrackerChild;
	private readonly log: (line: string) => void;
	private readonly timeoutMs: number;
	private readonly live: Map<Tracker, Live>;
	private aliasCounter: number;

	constructor(options: StdioBridgeOptions) {
		this.spawn = options.spawn;
		this.log = options.log;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.live = new Map();
		this.aliasCounter = 0;
	}

	private ensure(tracker: Tracker): Live {
		const existing = this.live.get(tracker);
		if (existing) return existing;
		const child = this.spawn(tracker);
		const live: Live = { child, pending: new Map() };
		this.live.set(tracker, live);
		child.onLine((line) => this.onLine(live, line));
		child.onExit(() => {
			if (this.live.get(tracker) === live) this.live.delete(tracker);
			for (const [key, entry] of live.pending) {
				live.pending.delete(key);
				clearTimeout(entry.timer);
				entry.reject(new BridgeError(502, `tracker ${tracker} child exited`));
			}
			this.log(`[substrate-host] tracker mcp ${tracker} child exited`);
		});
		return live;
	}

	private onLine(live: Live, line: string): void {
		let reply: unknown;
		try {
			reply = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(reply) || typeof reply.method === "string") return; // notifications and server requests: not ours to answer
		const id = reply.id;
		if (typeof id !== "string" && typeof id !== "number") return;
		const entry = live.pending.get(idKey(id));
		if (!entry) return;
		live.pending.delete(idKey(id));
		clearTimeout(entry.timer);
		entry.resolve({ ...reply, id: entry.originalId });
	}

	/** Forward a request (with id) and resolve with the child's reply for it; 502 on exit, 504 on timeout. */
	request(tracker: Tracker, message: JsonRpcMessage & { id: JsonRpcId }): Promise<JsonRpcMessage> {
		const live = this.ensure(tracker);
		const { promise, resolve, reject } = Promise.withResolvers<JsonRpcMessage>();
		let wireId: JsonRpcId = message.id;
		if (live.pending.has(idKey(wireId))) {
			this.aliasCounter += 1;
			wireId = `substrate-host:${this.aliasCounter}`;
		}
		const key = idKey(wireId);
		const timer = setTimeout(() => {
			if (live.pending.delete(key)) reject(new BridgeError(504, `tracker ${tracker} did not reply within ${this.timeoutMs} ms`));
		}, this.timeoutMs);
		live.pending.set(key, { originalId: message.id, resolve, reject, timer });
		live.child.write(JSON.stringify(wireId === message.id ? message : { ...message, id: wireId }));
		return promise;
	}

	/** Forward a notification (no id); nothing is awaited. */
	notify(tracker: Tracker, message: JsonRpcMessage): void {
		this.ensure(tracker).child.write(JSON.stringify(message));
	}

	close(): void {
		for (const [tracker, live] of this.live) {
			this.live.delete(tracker);
			for (const entry of live.pending.values()) {
				clearTimeout(entry.timer);
				entry.reject(new BridgeError(502, `tracker ${tracker} proxy closing`));
			}
			live.child.kill();
		}
	}
}

/**
 * The real child: `ultrathink-mcp serve <tracker>` (SUBSTRATE_ULTRATHINK_MCP overrides the plugin
 * path), HOME=/root so bin/run-bun finds bun and the relay finds the host's login store; stdin and
 * stdout piped, stderr ignored (it may name the account). No shell.
 */
function spawnUltrathinkMcp(tracker: Tracker): TrackerChild {
	const bin = process.env.SUBSTRATE_ULTRATHINK_MCP?.trim() || DEFAULT_ULTRATHINK_MCP;
	const child = spawnProcess(bin, ["serve", tracker], {
		env: { HOME: "/root", PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
		stdio: ["pipe", "pipe", "ignore"],
	});
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	return {
		write: (line) => {
			child.stdin.write(`${line}\n`);
		},
		onLine: (cb) => {
			lines.on("line", cb);
		},
		onExit: (cb) => {
			child.once("exit", cb);
			child.once("error", cb);
		},
		kill: () => {
			child.kill("SIGTERM");
		},
	};
}

type TrackerProxyOptions = { spawn?: SpawnTrackerChild; log: (line: string) => void; timeoutMs?: number | undefined };

type Body = { ok: true; text: string } | { ok: false; status: 413 };

async function readBody(req: IncomingMessage): Promise<Body> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) {
			req.resume(); // drain what is left, then answer; the response closes the connection
			return { ok: false, status: 413 };
		}
		chunks.push(chunk as Buffer);
	}
	return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(value));
}

function rpcError(id: JsonRpcId | null, code: number, message: string): JsonRpcMessage {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

const PATH_RE = /^\/mcp\/([a-z]+)$/;

function refusal(tracker: Tracker): string {
	const what = tracker === "linear" ? "Linear state changes" : "Notion Completed and terminal Status writes";
	return `${what} are refused by substrate-host: Done comes only from graph_complete through the DoD gate`;
}

/** The node:http server; `close()` also kills the children. */
export function createTrackerProxy(options: TrackerProxyOptions): Server {
	const log = options.log;
	const bridge = new StdioBridge({ spawn: options.spawn ?? spawnUltrathinkMcp, log, timeoutMs: options.timeoutMs });
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const match = PATH_RE.exec(url.pathname);
		const tracker = TRACKERS.find((t) => t === match?.[1]);
		if (!tracker) {
			sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405, { allow: "POST", "content-type": "application/json" });
			res.end(JSON.stringify({ error: "POST only" }));
			return;
		}
		let body: Body;
		try {
			body = await readBody(req);
		} catch (cause) {
			process.stderr.write(`[substrate-host] host.mcp-proxy.body ${errorLabel(cause)}\n`);
			sendJson(res, 400, rpcError(null, -32600, "Invalid Request"));
			return;
		}
		if (!body.ok) {
			res.writeHead(413, { "content-type": "application/json", connection: "close" });
			res.end(JSON.stringify({ error: "request body too large" }));
			return;
		}
		let message: unknown;
		try {
			message = JSON.parse(body.text);
		} catch {
			sendJson(res, 400, rpcError(null, -32700, "Parse error"));
			return;
		}
		if (!isRecord(message) || typeof message.method !== "string") {
			sendJson(res, 400, rpcError(null, -32600, Array.isArray(message) ? "batch requests are not supported" : "Invalid Request"));
			return;
		}
		const rpc = message as JsonRpcMessage & { method: string };
		const id = rpc.id;
		const hasId = typeof id === "string" || typeof id === "number";
		const params = isRecord(rpc.params) ? rpc.params : {};
		const tool = rpc.method === "tools/call" && typeof params.name === "string" ? params.name : null;
		if (tool !== null) {
			const args = params.arguments;
			if (tracker === "linear" && linearStateChange(args)) {
				log(`[substrate-host] tracker mcp refused linear state change ${tool}`);
				sendJson(res, 200, rpcError(hasId ? id : null, REFUSED_CODE, refusal("linear")));
				return;
			}
			if (tracker === "notion" && notionTerminalWrite(args)) {
				log(`[substrate-host] tracker mcp refused notion status change ${tool}`);
				sendJson(res, 200, rpcError(hasId ? id : null, REFUSED_CODE, refusal("notion")));
				return;
			}
		}
		log(`[substrate-host] tracker mcp ${tracker} ${rpc.method}${tool !== null ? ` ${tool}` : ""}`);
		if (!hasId) {
			bridge.notify(tracker, rpc);
			res.writeHead(202);
			res.end();
			return;
		}
		try {
			const reply = await bridge.request(tracker, { ...rpc, id });
			sendJson(res, 200, reply);
		} catch (cause) {
			const status = cause instanceof BridgeError ? cause.status : 502;
			sendJson(res, status, { error: cause instanceof Error ? cause.message : String(cause) });
		}
	});
	server.once("close", () => bridge.close());
	return server;
}

type StartTrackerProxyOptions = TrackerProxyOptions & {
	/** Injected by the test to assert the bind address; defaults to server.listen. */
	listen?: (server: Server, port: number, host: string, cb: () => void) => void;
};

/** Binds 127.0.0.1:7412 only (T-03-04-03): the VM reaches it through the loopback exemption, nothing else does. */
export function startTrackerProxy(options: StartTrackerProxyOptions): Server {
	const server = createTrackerProxy(options);
	const listen = options.listen ?? ((srv, port, host, cb) => srv.listen(port, host, cb));
	listen(server, TRACKER_PROXY_PORT, "127.0.0.1", () => {
		options.log(`[substrate-host] tracker mcp proxy 127.0.0.1:${TRACKER_PROXY_PORT} (${TRACKERS.join(", ")})`);
	});
	return server;
}
