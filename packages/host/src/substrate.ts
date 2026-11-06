// substrate-mcp client: bearer-authenticated JSON-RPC `tools/call` over POST /mcp plus the
// plain HTTP routes the host uses (/brief, /issue). Rewritten for main's v1.2 lease model
// (D31-01): September's anonymous client with no `lease_id` is dead on main — every request
// carries the host-job bearer, claims persist their `lease_id`, and heartbeats renew inside
// the 900 s TTL. Ports packages/dispatcher/src/substrate_dispatcher/mcp.py McpClient.call
// and _sse_messages: the reply is SSE-framed or plain JSON, both are parsed here.
// Pure Node (fetch only) so tests can inject fetchImpl; no rivet import.
//
// Credential discipline (D31-09): the bearer value is read from the per-unit host env file
// (never a default), is sent only as an `Authorization` header, and is never logged —
// every log path below prints names only. The manifest row flips to `live` only after
// the gated restart, never in this phase.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LEASE_TTL_SECONDS } from "../../mcp-server/src/lease.ts";

const DEFAULT_SUBSTRATE_BASE = "http://127.0.0.1:7410";
const ACCEPT = "application/json, text/event-stream";
export const HOST_SURFACE = "claude-code";
const BRIEF_UNAVAILABLE = "substrate brief unavailable";

/** The tokens-dir file holding the surface-`substrate` bearer (Phase 20 order). */
const DEFAULT_TOKENS_DIR = "/etc/substrate/tokens";
const SUBSTRATE_SURFACE = "substrate";

export class SubstrateError extends Error {}

export type GraphNodeView = {
	graph_id: string;
	node_id: string;
	linear_issue_id: string | null;
	linear_identifier: string | null;
	notion_page: string | null;
	state: string | null;
	claimed_by: string | null;
	claimed_at: string | null;
	claim_session: string | null;
};

export type GraphView = {
	graph_id: string;
	repo?: string | null;
	branch?: string | null;
	nodes: GraphNodeView[];
	[key: string]: unknown;
};

export type ClaimReply = { claimed: boolean; reason?: string; node?: GraphNodeView; lease_id?: string | null };
type ReleaseReply = { released: boolean; reason?: string; node?: GraphNodeView };
export type CompleteReply = { completed: boolean; reason?: string; node?: GraphNodeView };
type IssueReply =
	| { found: true; graph_id: string; node_id: string; identifier: string; title: string; description: string; untrusted: string }
	| { found: false; reason: string };

/** Whether `value` has the `/issue` reply shape: `found: true` with the six text fields, or `found: false` with a reason. */
export function isIssueReply(value: unknown): value is IssueReply {
	if (typeof value !== "object" || value === null || !("found" in value)) return false;
	if (value.found === false) return "reason" in value && typeof value.reason === "string";
	if (value.found !== true) return false;
	return (
		"graph_id" in value && typeof value.graph_id === "string" &&
		"node_id" in value && typeof value.node_id === "string" &&
		"identifier" in value && typeof value.identifier === "string" &&
		"title" in value && typeof value.title === "string" &&
		"description" in value && typeof value.description === "string" &&
		"untrusted" in value && typeof value.untrusted === "string"
	);
}

export type HeartbeatReply = { ok: boolean; reason?: string };

export type Dod = { summary: string; tests_pass: boolean; review_pass?: boolean };

type SubstrateClientOptions = {
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	/** Explicit bearer. When omitted the per-unit host env file order resolves it. */
	bearer?: string;
	/** Env mapping the bearer order reads (defaults to process.env). Values never logged. */
	env?: NodeJS.ProcessEnv;
	/** File reader for the tokens-dir order (defaults to first-line read). */
	readTokenFile?: (path: string) => string | null;
};

export type LeaseRecord = {
	lease_id: string;
	acquiredAtMs: number;
	ttlSeconds: number;
};

function firstLine(path: string): string | null {
	try {
		const line = readFileSync(path, "utf8").split("\n")[0]?.trim() ?? "";
		return line === "" ? null : line;
	} catch {
		// A missing or unreadable file has no first line.
		return null;
	}
}

/**
 * The host-job bearer for surface `substrate`, by name only here.
 *
 * Order: `SUBSTRATE_TOKEN_SUBSTRATE` (the per-unit host env file names it,
 * manifest `substrate-host` row, D20 pattern) — else the Phase 20 order
 * (cf. `packages/cli/src/token.ts`): `SUBSTRATE_TOKEN`, then
 * `SUBSTRATE_TOKEN_FILE`, then the per-surface file in `SUBSTRATE_TOKENS_DIR`
 * (default `/etc/substrate/tokens/substrate`). Absent or unreadable means
 * null (fail-open): the server refuses anonymous calls, and the refusal
 * surfaces as a `SubstrateError`. The value is never logged.
 */
export function resolveHostBearer(
	env: NodeJS.ProcessEnv = process.env,
	readTokenFile: (path: string) => string | null = firstLine,
): string | null {
	const unitVar = (env["SUBSTRATE_TOKEN_SUBSTRATE"] ?? "").trim();
	if (unitVar !== "") return unitVar;
	const direct = (env["SUBSTRATE_TOKEN"] ?? "").trim();
	if (direct !== "") return direct;
	const tokenFile = (env["SUBSTRATE_TOKEN_FILE"] ?? "").trim();
	if (tokenFile !== "") {
		const viaFile = readTokenFile(tokenFile);
		if (viaFile) return viaFile;
	}
	const tokensDir = (env["SUBSTRATE_TOKENS_DIR"] ?? "").trim() || DEFAULT_TOKENS_DIR;
	return readTokenFile(join(tokensDir, SUBSTRATE_SURFACE));
}

/** A heartbeat is due once half the TTL has elapsed (renew well inside expiry). */
export function heartbeatDue(record: LeaseRecord, nowMs: number = Date.now()): boolean {
	return nowMs - record.acquiredAtMs >= (record.ttlSeconds * 1000) / 2;
}

/** Heartbeat tick cadence: half the lease TTL, so renewal lands well inside expiry (D32-02). */
export const HEARTBEAT_INTERVAL_MS = (DEFAULT_LEASE_TTL_SECONDS * 1000) / 2;

/** The lease persistence seam: `LeaseStore` on disk in production, `MemoryLeaseStore` in tests. */
export type LeaseStoreLike = {
	persist(graphId: string, nodeId: string, record: LeaseRecord): void;
	load(graphId: string, nodeId: string): LeaseRecord | null;
};

/**
 * `lease_id` persistence beside the task records (0600 file discipline,
 * Phase 24 given_up.json precedent). One file per graph/node; the lease id
 * is a fencing token, so it never appears in logs — only presence is reported.
 */
export class LeaseStore implements LeaseStoreLike {
	dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	private pathFor(graphId: string, nodeId: string): string {
		const safe = (part: string) => part.replace(/[^A-Za-z0-9_-]/g, "_");
		return join(this.dir, `${safe(graphId)}__${safe(nodeId)}.lease.json`);
	}

	persist(graphId: string, nodeId: string, record: LeaseRecord): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		chmodSync(this.dir, 0o700);
		const path = this.pathFor(graphId, nodeId);
		writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
		chmodSync(path, 0o600);
	}

	load(graphId: string, nodeId: string): LeaseRecord | null {
		try {
			const parsed = JSON.parse(readFileSync(this.pathFor(graphId, nodeId), "utf8")) as unknown;
			if (typeof parsed !== "object" || parsed === null) return null;
			const record = parsed as Partial<LeaseRecord>;
			if (typeof record.lease_id !== "string" || record.lease_id === "") return null;
			return {
				lease_id: record.lease_id,
				acquiredAtMs: typeof record.acquiredAtMs === "number" ? record.acquiredAtMs : 0,
				ttlSeconds: typeof record.ttlSeconds === "number" ? record.ttlSeconds : DEFAULT_LEASE_TTL_SECONDS,
			};
		} catch {
			return null;
		}
	}

}

/** In-memory leases for tests (never the production unit). */
export class MemoryLeaseStore implements LeaseStoreLike {
	records: Map<string, LeaseRecord>;

	constructor() {
		this.records = new Map();
	}

	persist(graphId: string, nodeId: string, record: LeaseRecord): void {
		this.records.set(`${graphId}--${nodeId}`, record);
	}

	load(graphId: string, nodeId: string): LeaseRecord | null {
		return this.records.get(`${graphId}--${nodeId}`) ?? null;
	}
}
/** JSON payloads of every SSE event; multi-line `data:` fields are joined per the SSE spec. */
function sseMessages(text: string): unknown[] {
	const messages: unknown[] = [];
	let dataLines: string[] = [];
	const flush = () => {
		if (dataLines.length === 0) return;
		const payload = dataLines.join("\n");
		dataLines = [];
		try {
			const parsed: unknown = JSON.parse(payload);
			messages.push(parsed);
		} catch {
			throw new SubstrateError(`unparseable SSE data: ${payload.slice(0, 200)}`);
		}
	};
	for (const line of text.split(/\r?\n/)) {
		if (line === "") flush();
		else if (line.startsWith("data:")) {
			const value = line.slice(5);
			dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
		}
	}
	flush();
	return messages;
}

export class SubstrateClient {
	baseUrl: string;
	fetchImpl: typeof fetch;
	timeoutMs: number;
	nextId: number;
	bearer: string | null;

	constructor(opts: SubstrateClientOptions = {}) {
		this.baseUrl = (opts.baseUrl ?? DEFAULT_SUBSTRATE_BASE).replace(/\/+$/, "");
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.timeoutMs = opts.timeoutMs ?? 15_000;
		this.nextId = 1;
		const explicit = (opts.bearer ?? "").trim();
		this.bearer = explicit !== "" ? explicit : resolveHostBearer(opts.env, opts.readTokenFile);
	}

	/** Whether requests carry a bearer (name-only report; the value never leaves the header). */
	get authenticated(): boolean {
		return this.bearer !== null;
	}

	private headers(extra: Record<string, string> = {}): Record<string, string> {
		if (this.bearer === null) return { ...extra };
		return { ...extra, authorization: `Bearer ${this.bearer}` };
	}

	/** One tool call; returns the parsed JSON of content[0].text, or the raw text when it is not JSON. */
	async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
		const rpcId = this.nextId++;
		const request = { jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name: tool, arguments: args } };
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}/mcp`, {
				method: "POST",
				headers: this.headers({ "content-type": "application/json", accept: ACCEPT }),
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (cause) {
			throw new SubstrateError(`${tool}: request failed: ${String(cause)}`);
		}
		const text = await response.text();
		if (response.status >= 400) throw new SubstrateError(`${tool}: HTTP ${response.status}: ${text.slice(0, 200)}`);

		let messages: unknown[];
		if (text.trimStart().startsWith("{")) {
			try {
				const body: unknown = JSON.parse(text);
				messages = [body];
			} catch {
				throw new SubstrateError(`${tool}: unparseable JSON body: ${text.slice(0, 200)}`);
			}
		} else {
			messages = sseMessages(text);
		}
		const reply = messages.find(
			(m): m is Record<string, unknown> =>
				typeof m === "object" && m !== null && "id" in m && m.id === rpcId,
		);
		if (!reply) throw new SubstrateError(`${tool}: no JSON-RPC reply with id ${rpcId} in response`);
		if ("error" in reply) {
			const err = reply.error;
			const code = err && typeof err === "object" && "code" in err ? String(err.code) : "?";
			const message = err && typeof err === "object" && "message" in err ? String(err.message) : "";
			throw new SubstrateError(`${tool}: JSON-RPC error ${code}: ${message}`);
		}
		const result = "result" in reply ? reply.result : undefined;
		const content = result && typeof result === "object" && "content" in result ? result.content : undefined;
		const first = Array.isArray(content) ? content[0] : undefined;
		const firstText =
			first && typeof first === "object" && "text" in first && typeof first.text === "string" ? first.text : "";
		const isError = result && typeof result === "object" && "isError" in result ? result.isError === true : false;
		if (isError) throw new SubstrateError(`${tool}: tool error: ${firstText.slice(0, 200)}`);
		try {
			const parsed: unknown = JSON.parse(firstText);
			return parsed;
		} catch {
			return firstText;
		}
	}

	/** The graph view, or null when substrate-mcp has no such graph. */
	async graphGet(graphId: string): Promise<GraphView | null> {
		const result = await this.call("graph_get", { graph_id: graphId });
		if (typeof result === "object" && result !== null) return result as GraphView;
		if (typeof result === "string" && result.startsWith("No graph")) return null;
		throw new SubstrateError(`graph_get: unexpected reply: ${String(result).slice(0, 200)}`);
	}

	async graphClaim(graphId: string, nodeId: string, surface: string, sessionId: string): Promise<ClaimReply> {
		return (await this.call("graph_claim", {
			graph_id: graphId,
			node_id: nodeId,
			surface,
			session_id: sessionId,
		})) as ClaimReply;
	}

	async claimAndPersist(
		store: LeaseStore,
		graphId: string,
		nodeId: string,
		surface: string,
		sessionId: string,
		nowMs: number = Date.now(),
	): Promise<ClaimReply> {
		const reply = await this.graphClaim(graphId, nodeId, surface, sessionId);
		if (reply.claimed && typeof reply.lease_id === "string" && reply.lease_id !== "") {
			store.persist(graphId, nodeId, {
				lease_id: reply.lease_id,
				acquiredAtMs: nowMs,
				ttlSeconds: DEFAULT_LEASE_TTL_SECONDS,
			});
		}
		return reply;
	}

	/**
	 * Extend a held lease inside its TTL (`graph_heartbeat`, fenced on `lease_id`).
	 * A refused heartbeat means the lease lapsed or was taken over: the caller
	 * re-claims rather than extending (lease contract: an expired lease is gone).
	 */
	async heartbeat(
		graphId: string,
		nodeId: string,
		leaseId: string,
		ttlSeconds: number = DEFAULT_LEASE_TTL_SECONDS,
	): Promise<HeartbeatReply> {
		const result = await this.call("graph_heartbeat", {
			graph_id: graphId,
			node_id: nodeId,
			lease_id: leaseId,
			ttl_seconds: ttlSeconds,
		});
		const ok = result && typeof result === "object" && "ok" in result ? result.ok === true : false;
		if (ok) return { ok: true };
		const reason =
			result && typeof result === "object" && "reason" in result && typeof result.reason === "string"
				? result.reason
				: "refused";
		return { ok: false, reason };
	}

	async graphRelease(graphId: string, nodeId: string, surface: string, sessionId: string): Promise<ReleaseReply> {
		return (await this.call("graph_release", {
			graph_id: graphId,
			node_id: nodeId,
			surface,
			session_id: sessionId,
		})) as ReleaseReply;
	}

	/**
	 * Mark the node complete through the DoD gate, fenced on the persisted `lease_id`
	 * (D32-03): the server ignores any other proof of holding, so the caller loads the
	 * id from its `LeaseStore` and passes it here — never a surface or session name.
	 */
	async graphComplete(graphId: string, nodeId: string, leaseId: string | null, dod: Dod): Promise<CompleteReply> {
		return (await this.call("graph_complete", {
			graph_id: graphId,
			node_id: nodeId,
			lease_id: leaseId,
			dod,
		})) as CompleteReply;
	}

	/** POST /issue — the node's redacted, untrusted issue text (03-02). */
	async issueGet(graphId: string, nodeId: string): Promise<IssueReply> {
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}/issue`, {
				method: "POST",
				headers: this.headers({ "content-type": "application/json" }),
				body: JSON.stringify({ graph_id: graphId, node_id: nodeId }),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (cause) {
			throw new SubstrateError(`issue_get: request failed: ${String(cause)}`);
		}
		const text = await response.text();
		if (response.status >= 400) throw new SubstrateError(`issue_get: HTTP ${response.status}: ${text.slice(0, 200)}`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new SubstrateError(`issue_get: unparseable JSON body: ${text.slice(0, 200)}`);
		}
		if (!isIssueReply(parsed)) throw new SubstrateError(`issue_get: unexpected reply shape: ${text.slice(0, 200)}`);
		return parsed;
	}

	/** POST /brief as surface claude-code. Fails open: any error yields a one-line placeholder brief. */
	async brief(graphId: string, repo: string): Promise<string> {
		try {
			const response = await this.fetchImpl(`${this.baseUrl}/brief`, {
				method: "POST",
				headers: this.headers({ "content-type": "application/json" }),
				body: JSON.stringify({ repo, graph_id: graphId, surface: HOST_SURFACE }),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			if (response.status >= 400) return BRIEF_UNAVAILABLE;
			const text = await response.text();
			return text.trim() === "" ? BRIEF_UNAVAILABLE : text;
		} catch {
			return BRIEF_UNAVAILABLE;
		}
	}
}
