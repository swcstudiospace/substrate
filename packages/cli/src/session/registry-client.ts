/**
 * `substrate session operator|conflicts`' MCP client (phase 83, E1). Reuses the MCP `/mcp` tools/call shape
 * (`httpCapsuleMcp`, `capsule.ts:289`): no new HTTP routes. `take`/`release` call the existing `graph_claim` /
 * `graph_release` tools, so the single-operator holder check stays the server's `decideClaim`/`decideRelease`
 * (`lease.ts:218` / `lease.ts:388`) — this file adds no auth layer of its own.
 */

export type RegistryMcpErrorKind = "unreachable" | "refused" | "invalid";

export class RegistryMcpError extends Error {
	readonly kind: RegistryMcpErrorKind;
	constructor(kind: RegistryMcpErrorKind, message: string) {
		super(message);
		this.name = "RegistryMcpError";
		this.kind = kind;
	}
}

export interface RegistryEntry {
	session_id: string;
	surface: string | null;
	repo: string | null;
	worktree_path: string | null;
	graph_id: string | null;
	node_id: string | null;
	lease_state: "held" | null;
	epoch: number | null;
	expires_at: string | null;
	files: readonly string[];
	files_truncated: boolean;
}

export interface RegistryConflict {
	worktree_path: string;
	file: string;
	session_ids: readonly string[];
}

export interface RegistrySnapshot {
	entries: readonly RegistryEntry[];
	conflicts: readonly RegistryConflict[];
	as_of: string;
	degraded: boolean;
}

export interface OperatorOutcome {
	claimed?: boolean;
	released?: boolean;
	ok?: boolean;
	lease_id: string | null;
	action: string | null;
	reason: string | null;
	holder: string | null;
}

export interface SessionRegistryClient {
	take(input: { graph_id: string; node_id: string; session_id: string; surface: string }): Promise<OperatorOutcome>;
	release(input: { graph_id: string; node_id: string; lease_id: string }): Promise<OperatorOutcome>;
	snapshot(repo?: string): Promise<RegistrySnapshot>;
}

export interface RegistryConnection {
	url: string;
	token?: string | undefined;
	tokenFor?: ((surface: string) => string | undefined) | undefined;
	timeoutMs: number;
	fetchImpl?: typeof fetch | undefined;
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function diagnostic(value: string): string {
	return value.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[url]").slice(0, 400);
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function parseOutcome(value: unknown): OperatorOutcome {
	const rec = isRec(value) ? value : {};
	const lease = isRec(rec.lease) ? rec.lease : {};
	const decision = isRec(rec.decision) ? rec.decision : {};
	const holder = isRec(lease.holder) ? lease.holder : {};
	return {
		...(typeof rec.claimed === "boolean" ? { claimed: rec.claimed } : {}),
		...(typeof rec.released === "boolean" ? { released: rec.released } : {}),
		...(typeof rec.ok === "boolean" ? { ok: rec.ok } : {}),
		lease_id: typeof lease.lease_id === "string" && lease.lease_id.length > 0 ? lease.lease_id : null,
		action: typeof decision.action === "string" ? decision.action : typeof rec.action === "string" ? rec.action : null,
		reason: typeof decision.reason === "string" ? decision.reason : typeof rec.reason === "string" ? rec.reason : null,
		holder: typeof holder.session_id === "string" && holder.session_id.length > 0 ? holder.session_id : null,
	};
}

function parseSnapshot(value: unknown): RegistrySnapshot {
	if (!isRec(value)) throw new RegistryMcpError("invalid", "session_registry answered something that is not the registry snapshot");
	const entriesRaw = Array.isArray(value.entries) ? value.entries : [];
	const conflictsRaw = Array.isArray(value.conflicts) ? value.conflicts : [];
	return {
		entries: entriesRaw.map((entry): RegistryEntry => {
			const rec = isRec(entry) ? entry : {};
			return {
				session_id: textOf(rec.session_id),
				surface: typeof rec.surface === "string" ? rec.surface : null,
				repo: typeof rec.repo === "string" ? rec.repo : null,
				worktree_path: typeof rec.worktree_path === "string" ? rec.worktree_path : null,
				graph_id: typeof rec.graph_id === "string" ? rec.graph_id : null,
				node_id: typeof rec.node_id === "string" ? rec.node_id : null,
				lease_state: rec.lease_state === "held" ? "held" : null,
				epoch: typeof rec.epoch === "number" ? rec.epoch : null,
				expires_at: typeof rec.expires_at === "string" ? rec.expires_at : null,
				files: Array.isArray(rec.files) ? rec.files.filter((file): file is string => typeof file === "string") : [],
				files_truncated: rec.files_truncated === true,
			};
		}),
		conflicts: conflictsRaw.map((conflict): RegistryConflict => {
			const rec = isRec(conflict) ? conflict : {};
			return {
				worktree_path: textOf(rec.worktree_path),
				file: textOf(rec.file),
				session_ids: Array.isArray(rec.session_ids) ? rec.session_ids.filter((id): id is string => typeof id === "string") : [],
			};
		}),
		as_of: textOf(value.as_of),
		degraded: value.degraded === true,
	};
}

/** MCP `/mcp` client for the registry tools. The reply is JSON; neither the endpoint nor the bearer may reach output. */
export function createSessionRegistryClient(connection: RegistryConnection): SessionRegistryClient {
	const base = connection.url.replace(/\/+$/, "");
	const doFetch = connection.fetchImpl ?? fetch;
	const secrets = [connection.token, connection.tokenFor?.("claude-code"), base].filter(
		(secret): secret is string => typeof secret === "string" && secret.length > 0,
	);
	const safe = (value: string): string =>
		diagnostic(secrets.reduce((cleaned, secret) => cleaned.split(secret).join("[redacted]"), value));

	async function call(tool: string, args: Record<string, unknown>, token: string | undefined): Promise<unknown> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		};
		let status: number;
		let text: string;
		try {
			const response = await doFetch(`${base}/mcp`, {
				method: "POST",
				headers,
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
				signal: AbortSignal.timeout(connection.timeoutMs),
			});
			status = response.status;
			text = await response.text();
		} catch (cause) {
			throw new RegistryMcpError("unreachable", `the substrate did not answer ${tool}: ${safe(messageOf(cause))}`);
		}
		const data = text.split("\n").find((line) => line.startsWith("data: "))?.slice(6) ?? text;
		let envelope: unknown;
		try {
			envelope = JSON.parse(data);
		} catch {
			throw new RegistryMcpError("invalid", `${tool} answered HTTP ${status} with no JSON-RPC reply: ${safe(text)}`);
		}
		if (!isRec(envelope) || !isRec(envelope.result)) {
			const error = isRec(envelope) ? envelope.error : undefined;
			const reason = typeof error === "string" ? error : isRec(error) && typeof error.message === "string" ? error.message : JSON.stringify(envelope);
			throw new RegistryMcpError("refused", `${tool} answered HTTP ${status}: ${safe(reason)}`);
		}
		const result = envelope.result;
		const first: unknown = Array.isArray(result.content) ? result.content[0] : undefined;
		const content = isRec(first) && typeof first.text === "string" ? first.text : "";
		if (result.isError === true) throw new RegistryMcpError("refused", `${tool} was refused: ${safe(content)}`);
		try {
			return JSON.parse(content) as unknown;
		} catch {
			throw new RegistryMcpError("invalid", `${tool} answered with a result that is not JSON: ${safe(content)}`);
		}
	}

	return {
		async take(input): Promise<OperatorOutcome> {
			return parseOutcome(await call("graph_claim", { graph_id: input.graph_id, node_id: input.node_id, session_id: input.session_id, surface: input.surface }, connection.tokenFor?.(input.surface) ?? connection.token));
		},
		async release(input): Promise<OperatorOutcome> {
			return parseOutcome(await call("graph_release", { graph_id: input.graph_id, node_id: input.node_id, lease_id: input.lease_id }, connection.token));
		},
		async snapshot(repo?: string): Promise<RegistrySnapshot> {
			return parseSnapshot(await call("session_registry", repo === undefined ? {} : { repo }, connection.token));
		},
	};
}
