/**
 * Dispatcher substrate client (DISP-05).
 *
 * A stateless `POST /mcp` `tools/call` client that authenticates as surface
 * `substrate` with `SUBSTRATE_TOKEN_SUBSTRATE`. It can read (`graph_find`,
 * `graph_get`) and emit closed-vocabulary events (`events_emit`) only.
 *
 * There is deliberately no claim path on this client: the Hermes child
 * process holds `SUBSTRATE_TOKEN_HERMES` and is the only claimant. The
 * request envelope mirrors the `callTool` helper in
 * `packages/mcp-server/src/http.test.ts`: a JSON body, falling back to the
 * first SSE `data:` line, then the text content of the first result part.
 */

export type AllowedToolName = "graph_find" | "graph_get" | "events_emit";

const ALLOWED_TOOLS: Record<string, true> = { graph_find: true, graph_get: true, events_emit: true };

export class SubstrateError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.status = status;
	}
}

export interface SubstrateClientOptions {
	/** Base URL of substrate-mcp, e.g. `http://127.0.0.1:7410`. */
	baseUrl: string;
	/** The dispatcher surface token (`SUBSTRATE_TOKEN_SUBSTRATE`). */
	token: string;
	/** Overridable for tests; defaults to the global fetch. */
	fetchFn?: typeof fetch;
}

/** Public lease fields of one node, as every non-holder read sees them. */
export interface PublicNode {
	graph_id: string;
	node_id: string;
	claimed_by: string | null;
	claim_session: string | null;
	/** Always null on public reads; only the holder ever sees an id. */
	lease_id: string | null;
	lease_expires_at: string | null;
}

export interface GraphSnapshot {
	graph_id: string;
	nodes: Array<PublicNode & { node_id: string }>;
}

export type FindNodeResult =
	| {
			found: true;
			graph_id: string;
			node_id: string;
			repo: string | null;
			branch: string | null;
			node: PublicNode;
	  }
	| { found: false; reason: string };

export interface DispatchEventInput {
	kind: "note" | "warning";
	summary: string;
	session_id: string;
	graph_id: string;
	node_id?: string;
	payload: Record<string, unknown>;
}

interface JsonRpcEnvelope {
	result?: { content?: Array<{ text?: string }> };
	error?: { message?: string };
}

export class SubstrateClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly fetchFn: typeof fetch;

	constructor(options: SubstrateClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.token = options.token;
		this.fetchFn = options.fetchFn ?? fetch;
	}

	/**
	 * One stateless tool call. Rejects any tool outside the allowlist at
	 * runtime as well as at the type level, so a JS caller cannot smuggle a
	 * holder-only operation through this surface.
	 */
	async callTool<T>(name: AllowedToolName, args: Record<string, unknown>): Promise<T> {
		if (ALLOWED_TOOLS[name] !== true) {
			throw new SubstrateError(`tool not allowed for surface substrate: ${name}`);
		}
		const response = await this.fetchFn(`${this.baseUrl}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${this.token}`,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});
		const raw = await response.text();
		if (!response.ok) {
			throw new SubstrateError(`substrate-mcp ${name} failed with HTTP ${response.status}`, response.status);
		}
		const data = raw
			.split("\n")
			.find((line) => line.startsWith("data: "))
			?.slice("data: ".length) ?? raw;
		let envelope: JsonRpcEnvelope;
		try {
			envelope = JSON.parse(data) as JsonRpcEnvelope;
		} catch {
			throw new SubstrateError(`substrate-mcp ${name} returned unparseable body`);
		}
		if (envelope.error) {
			throw new SubstrateError(`substrate-mcp ${name} error: ${envelope.error.message ?? "unknown"}`);
		}
		const text = envelope.result?.content?.[0]?.text ?? "null";
		return JSON.parse(text) as T;
	}

	/** Resolve a Linear issue to its registered node. Read-only and silent. */
	async findNode(ref: { linear_issue_id: string; linear_identifier: string }): Promise<FindNodeResult> {
		return this.callTool<FindNodeResult>("graph_find", {
			linear_issue_id: ref.linear_issue_id,
			linear_identifier: ref.linear_identifier,
		});
	}

	/** Read a graph with every node's lease id nulled, as public reads do. */
	async getGraph(graph_id: string): Promise<GraphSnapshot | null> {
		const graph = await this.callTool<GraphSnapshot | null | string>("graph_get", { graph_id });
		if (graph === null || typeof graph === "string") return null;
		return graph;
	}

	/**
	 * Emit a closed-vocabulary dispatcher event. The surface is always
	 * `substrate`: this token cannot act as another surface, and the
	 * dispatcher never names one.
	 */
	async emitEvent(event: DispatchEventInput): Promise<void> {
		await this.callTool<unknown>("events_emit", { surface: "substrate", ...event });
	}
}
