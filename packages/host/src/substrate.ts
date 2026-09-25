// substrate-mcp client: stateless JSON-RPC `tools/call` over POST /mcp plus the plain HTTP routes
// the host uses (/brief, /issue). Ports packages/dispatcher/src/substrate_dispatcher/mcp.py
// McpClient.call and _sse_messages: the reply is SSE-framed or plain JSON, both are parsed here.
// Pure Node (fetch only) so tests can inject fetchImpl; no rivet import.

export const DEFAULT_SUBSTRATE_BASE = "http://127.0.0.1:7410";
const ACCEPT = "application/json, text/event-stream";
export const HOST_SURFACE = "claude-code";
export const BRIEF_UNAVAILABLE = "substrate brief unavailable";

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

export type ClaimReply = { claimed: boolean; reason?: string; node?: GraphNodeView };
export type ReleaseReply = { released: boolean; reason?: string; node?: GraphNodeView };
export type CompleteReply = { completed: boolean; reason?: string; node?: GraphNodeView };
export type IssueReply =
	| { found: true; graph_id: string; node_id: string; identifier: string; title: string; description: string; untrusted: string }
	| { found: false; reason: string };

export type Dod = { summary: string; tests_pass: boolean; review_pass?: boolean };

export type SubstrateClientOptions = {
	baseUrl?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
};

/** JSON payloads of every SSE event; multi-line `data:` fields are joined per the SSE spec. */
export function sseMessages(text: string): unknown[] {
	const messages: unknown[] = [];
	let dataLines: string[] = [];
	const flush = () => {
		if (dataLines.length === 0) return;
		const payload = dataLines.join("\n");
		dataLines = [];
		try {
			messages.push(JSON.parse(payload));
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

	constructor(opts: SubstrateClientOptions = {}) {
		this.baseUrl = (opts.baseUrl ?? DEFAULT_SUBSTRATE_BASE).replace(/\/+$/, "");
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.timeoutMs = opts.timeoutMs ?? 15_000;
		this.nextId = 1;
	}

	/** One tool call; returns the parsed JSON of content[0].text, or the raw text when it is not JSON. */
	async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
		const rpcId = this.nextId++;
		const request = { jsonrpc: "2.0", id: rpcId, method: "tools/call", params: { name: tool, arguments: args } };
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}/mcp`, {
				method: "POST",
				headers: { "content-type": "application/json", accept: ACCEPT },
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
				messages = [JSON.parse(text)];
			} catch {
				throw new SubstrateError(`${tool}: unparseable JSON body: ${text.slice(0, 200)}`);
			}
		} else {
			messages = sseMessages(text);
		}
		const reply = messages.find(
			(m): m is Record<string, unknown> => typeof m === "object" && m !== null && (m as { id?: unknown }).id === rpcId,
		);
		if (!reply) throw new SubstrateError(`${tool}: no JSON-RPC reply with id ${rpcId} in response`);
		if ("error" in reply) {
			const err = (reply.error ?? {}) as { code?: unknown; message?: unknown };
			throw new SubstrateError(`${tool}: JSON-RPC error ${String(err.code)}: ${String(err.message)}`);
		}
		const result = (reply.result ?? {}) as { content?: Array<{ text?: unknown }>; isError?: boolean };
		const first = result.content?.[0];
		const firstText = first && typeof first === "object" && typeof first.text === "string" ? first.text : "";
		if (result.isError) throw new SubstrateError(`${tool}: tool error: ${firstText.slice(0, 200)}`);
		try {
			return JSON.parse(firstText);
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

	async graphRelease(graphId: string, nodeId: string, surface: string, sessionId: string): Promise<ReleaseReply> {
		return (await this.call("graph_release", {
			graph_id: graphId,
			node_id: nodeId,
			surface,
			session_id: sessionId,
		})) as ReleaseReply;
	}

	async graphComplete(graphId: string, nodeId: string, surface: string, sessionId: string, dod: Dod): Promise<CompleteReply> {
		return (await this.call("graph_complete", {
			graph_id: graphId,
			node_id: nodeId,
			surface,
			session_id: sessionId,
			dod,
		})) as CompleteReply;
	}

	/** POST /issue — the node's redacted, untrusted issue text (03-02). */
	async issueGet(graphId: string, nodeId: string): Promise<IssueReply> {
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}/issue`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ graph_id: graphId, node_id: nodeId }),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (cause) {
			throw new SubstrateError(`issue_get: request failed: ${String(cause)}`);
		}
		const text = await response.text();
		if (response.status >= 400) throw new SubstrateError(`issue_get: HTTP ${response.status}: ${text.slice(0, 200)}`);
		return JSON.parse(text) as IssueReply;
	}

	/** POST /brief as surface claude-code. Fails open: any error yields a one-line placeholder brief. */
	async brief(graphId: string, repo: string): Promise<string> {
		try {
			const response = await this.fetchImpl(`${this.baseUrl}/brief`, {
				method: "POST",
				headers: { "content-type": "application/json" },
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
