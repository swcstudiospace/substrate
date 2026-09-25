/**
 * The substrate's behaviour, independent of transport.
 *
 * Both the MCP tools and the plain REST routes call into this, so the two
 * surfaces cannot drift. Hooks need REST (they cannot call MCP tools); agents
 * get MCP. Same code underneath.
 */
import { composeBrief, type BriefRequest } from "./brief.ts";
import type { SubstrateConfig } from "./config.ts";
import { normalizeEvent, verifyChain } from "./event.ts";
import { GreptimeClient, quote } from "./greptime.ts";
import { IndexStore } from "./index-store.ts";
import { createMirror, type Mirror, type MirrorFailure } from "./mirror.ts";
import type {
	Actor,
	EventInput,
	EventKind,
	GraphNode,
	MemoryEntry,
	MemoryEntryInput,
	NodeState,
	Surface,
	SubstrateEvent,
} from "./types.ts";

/** Why a caller may not move a node, or null when it holds the claim. */
function ownershipRefusal(node: GraphNode, surface: Surface, sessionId: string, verb: string): string | null {
	if (node.claimed_by === surface && node.claim_session === sessionId) return null;
	return node.claimed_by
		? `node is claimed by ${node.claimed_by} session ${node.claim_session}; only that session can ${verb} it`
		: "node is not claimed";
}

/** Greptime gives back loosely typed rows; rebuild the exact shape that was hashed. */
function rowToEvent(row: Record<string, unknown>): SubstrateEvent {
	const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
	let payload: Record<string, unknown> = {};
	try {
		payload = row.payload ? (JSON.parse(String(row.payload)) as Record<string, unknown>) : {};
	} catch {
		payload = {};
	}
	return {
		id: String(row.id),
		// The chain hashed an ISO string; Greptime returns epoch millis.
		ts: new Date(Number(row.ts)).toISOString(),
		surface: String(row.surface) as Surface,
		session_id: text(row.session_id),
		graph_id: text(row.graph_id),
		node_id: text(row.node_id),
		linear_identifier: text(row.linear_identifier),
		step: row.step === null || row.step === undefined ? null : Number(row.step),
		repo: text(row.repo),
		branch: text(row.branch),
		actor: String(row.actor) as Actor,
		kind: String(row.kind) as EventKind,
		summary: String(row.summary),
		payload,
		hash: String(row.hash),
		prev: text(row.prev),
	};
}

export class Substrate {
	readonly index: IndexStore | null;
	readonly greptime: GreptimeClient | null;
	readonly mirror: Mirror;

	/** `stores` is a test seam; production always builds them from config. */
	constructor(
		readonly config: SubstrateConfig,
		stores?: { index?: IndexStore | null; greptime?: GreptimeClient | null; mirror?: Mirror },
	) {
		this.index =
			stores?.index !== undefined ? stores.index : config.postgresUrl ? new IndexStore(config.postgresUrl) : null;
		this.greptime =
			stores?.greptime !== undefined ? stores.greptime : config.greptime ? new GreptimeClient(config.greptime) : null;
		this.mirror = stores?.mirror ?? createMirror(config);
	}

	/** Idempotent. Missing stores are reported, not fatal — the server still serves what it can. */
	async migrate(): Promise<{ index: boolean; greptime: boolean; errors: string[] }> {
		const errors: string[] = [];
		let indexOk = false;
		let greptimeOk = false;
		if (this.index) {
			try {
				await this.index.migrate();
				indexOk = true;
			} catch (cause) {
				errors.push(`index: ${String(cause)}`);
			}
		} else {
			errors.push("index: SUBSTRATE_PG_URL not set");
		}
		if (this.greptime) {
			try {
				await this.greptime.migrate();
				greptimeOk = true;
			} catch (cause) {
				errors.push(`greptime: ${String(cause)}`);
			}
		} else {
			errors.push("greptime: GREPTIME_URL not set");
		}
		return { index: indexOk, greptime: greptimeOk, errors };
	}

	async brief(request: BriefRequest): Promise<string> {
		return composeBrief(request, { index: this.index, greptime: this.greptime });
	}

	/**
	 * Append an event. Chains onto the session's previous event when Greptime
	 * knows of one; a session's first event has `prev: null`.
	 */
	async emit(input: EventInput): Promise<SubstrateEvent> {
		let prev: string | null = null;
		if (this.greptime && input.session_id) {
			prev = await this.greptime.lastHash(input.session_id).catch(() => null);
		}
		const event = normalizeEvent(input, prev);
		if (this.greptime) await this.greptime.insertEvent(event);
		return event;
	}

	async writeMemory(entry: MemoryEntryInput): Promise<MemoryEntry> {
		if (!this.index) throw new Error("memory requires SUBSTRATE_PG_URL");
		return this.index.writeMemory(entry);
	}

	async searchMemory(query: string, scope?: string, limit?: number): Promise<MemoryEntry[]> {
		if (!this.index) return [];
		return this.index.searchMemory(query, scope, limit);
	}

	async getGraph(graphId: string) {
		if (!this.index) return null;
		return this.index.getGraph(graphId);
	}

	/**
	 * Resolve a Linear issue to the one registered node that owns it. The
	 * dispatcher sees issues, not nodes; an ambiguous or unknown issue is
	 * reported, never guessed.
	 */
	async findNode(ref: { linear_issue_id?: string; linear_identifier?: string }): Promise<
		| {
				found: true;
				graph_id: string;
				node_id: string;
				repo: string | null;
				branch: string | null;
				graph_status: string | null;
				node: GraphNode;
		  }
		| { found: false; reason: string }
	> {
		if (!ref.linear_issue_id && !ref.linear_identifier) {
			return { found: false, reason: "provide linear_issue_id or linear_identifier" };
		}
		if (!this.index) return { found: false, reason: "index not configured" };
		const matches = await this.index.findNodesByLinear({
			linearIssueId: ref.linear_issue_id,
			linearIdentifier: ref.linear_identifier,
		});
		const wanted = ref.linear_issue_id ?? ref.linear_identifier;
		if (matches.length > 1) {
			return {
				found: false,
				reason: `ambiguous: ${wanted} is on more than one node (${matches.map((m) => `${m.graph_id}/${m.node_id}`).join(", ")})`,
			};
		}
		const match = matches[0];
		if (!match) return { found: false, reason: `no registered node for ${wanted}` };
		const { repo, branch, graph_status, ...node } = match;
		return { found: true, graph_id: node.graph_id, node_id: node.node_id, repo, branch, graph_status, node };
	}

	async registerGraph(plan: Parameters<IndexStore["registerGraph"]>[0]) {
		if (!this.index) throw new Error("graph_register requires SUBSTRATE_PG_URL");
		return this.index.registerGraph(plan);
	}

	/**
	 * Claim a node for a surface. The index claim lands first and is the truth;
	 * only the winner then emits the claim event and mirrors the claim to Linear
	 * (In Progress, `agent:<surface>`, `dispatch:*` removed, a session comment).
	 * A mirror failure never rolls the claim back — it becomes one warning event
	 * per failed target, and a same-surface re-claim re-runs the mirror. A losing
	 * claimer gets the holder's node back and causes no writes at all.
	 */
	async claimNode(graphId: string, nodeId: string, surface: Surface, sessionId: string) {
		if (!this.index) throw new Error("graph_claim requires SUBSTRATE_PG_URL");
		const result = await this.index.claimNode(graphId, nodeId, surface, sessionId);
		if (result.claimed) {
			// The index caches the Linear state the mirror is about to ask for. A
			// failure here never un-claims.
			await this.index.setNodeState(graphId, nodeId, "started").catch(() => undefined);
			// The repo comes from the graph, not the caller: a claim event without one
			// is invisible to every repo-scoped brief, which is exactly where a claim
			// most needs to be seen.
			const graph = await this.index.getGraph(graphId).catch(() => null);
			const repo = graph?.repo ?? null;
			const branch = graph?.branch ?? null;
			const linearIdentifier = result.node.linear_identifier ?? undefined;
			await this.emit({
				surface,
				kind: "claim",
				// The brief already renders the node id alongside every action, so
				// naming it here too reads as "claimed n4 (SPE-123) (n4)".
				summary: result.node.linear_identifier ? `claimed ${result.node.linear_identifier}` : "claimed node",
				graph_id: graphId,
				node_id: nodeId,
				linear_identifier: linearIdentifier,
				session_id: sessionId,
				repo: repo ?? undefined,
				branch: branch ?? undefined,
			}).catch(() => undefined);

			const failures = await this.mirror.claim({
				graphId,
				nodeId,
				surface,
				sessionId,
				node: result.node,
				repo,
				branch,
			});
			await this.warn(failures, "claim", {
				surface,
				graph_id: graphId,
				node_id: nodeId,
				linear_identifier: linearIdentifier,
				session_id: sessionId,
				repo: repo ?? undefined,
				branch: branch ?? undefined,
			});
		}
		return result;
	}

	/**
	 * Give a claimed node back. Only the claiming surface and session may: any
	 * other caller — or a call on an unclaimed node — gets `released: false`
	 * with the reason and causes no index, tracker or event write, so one agent
	 * cannot drop another's work by accident or through an injected
	 * instruction. The holder's release clears the claim, sets the node
	 * `unstarted`, logs a `release` event and mirrors it (Linear back to Todo,
	 * `agent:<surface>` removed); a mirror failure is a warning, never a block.
	 */
	async releaseNode(
		graphId: string,
		nodeId: string,
		surface: Surface,
		sessionId: string,
	): Promise<{ released: boolean; reason?: string; node: GraphNode }> {
		const { index, graph, node } = await this.holder(graphId, nodeId);
		const reason = ownershipRefusal(node, surface, sessionId, "release");
		if (reason) return { released: false, reason, node };

		await index.releaseNode(graphId, nodeId);
		await index.setNodeState(graphId, nodeId, "unstarted").catch(() => undefined);
		const meta = {
			surface,
			graph_id: graphId,
			node_id: nodeId,
			linear_identifier: node.linear_identifier ?? undefined,
			session_id: sessionId,
			repo: graph.repo ?? undefined,
			branch: graph.branch ?? undefined,
		};
		await this.emit({
			...meta,
			kind: "release",
			summary: `released ${node.linear_identifier ?? nodeId}`,
		}).catch(() => undefined);
		const failures = await this.mirror.release({
			graphId,
			nodeId,
			surface,
			sessionId,
			node,
			repo: graph.repo,
			branch: graph.branch,
		});
		await this.warn(failures, "release", meta);
		return { released: true, node: await this.refreshed(graphId, nodeId, node) };
	}

	async completeNode(graphId: string, nodeId: string, state: NodeState = "completed") {
		if (!this.index) throw new Error("graph_complete requires SUBSTRATE_PG_URL");
		await this.index.setNodeState(graphId, nodeId, state);
		await this.index.releaseNode(graphId, nodeId);
	}

	/** The graph and node a release or completion acts on; the index is required. */
	private async holder(graphId: string, nodeId: string) {
		const index = this.index;
		if (!index) throw new Error("graph_release and graph_complete require SUBSTRATE_PG_URL");
		const graph = await index.getGraph(graphId);
		const node = graph?.nodes.find((n) => n.node_id === nodeId);
		if (!graph || !node) throw new Error(`unknown node ${graphId}/${nodeId}`);
		return { index, graph, node };
	}

	/** The node as the index now has it, or the pre-change copy if the re-read fails. */
	private async refreshed(graphId: string, nodeId: string, fallback: GraphNode): Promise<GraphNode> {
		const graph = await this.index?.getGraph(graphId).catch(() => null);
		return graph?.nodes.find((n) => n.node_id === nodeId) ?? fallback;
	}

	/** One warning event per failed mirror target (D-02); never throws. */
	private async warn(
		failures: MirrorFailure[],
		action: string,
		meta: Omit<EventInput, "kind" | "summary" | "payload">,
	): Promise<void> {
		for (const failure of failures) {
			await this.emit({
				...meta,
				kind: "warning",
				summary: `${action} mirror to ${failure.target} failed for ${meta.linear_identifier ?? meta.node_id}: ${failure.reason}`,
				payload: { target: failure.target, action, reason: failure.reason },
			}).catch(() => undefined);
		}
	}

	/**
	 * Recompute the hash chain for one graph.
	 *
	 * Events are grouped by session before verification: `prev` chains within a
	 * session, so interleaving two sessions' events into one sequence would
	 * report a break that is not there.
	 */
	async verifyGraph(
		graphId: string,
	): Promise<{ ok: boolean; events: number; brokenAt?: string; reason?: string }> {
		if (!this.greptime) return { ok: false, events: 0, reason: "greptime not configured" };
		const rows = await this.greptime.sql(
			`SELECT "ts", "id", "surface", "session_id", "graph_id", "node_id", "linear_identifier", "step",
			        "repo", "branch", "actor", "kind", "summary", "payload", "hash", "prev"
			 FROM "agent_events" WHERE "graph_id" = ${quote(graphId)} ORDER BY "ts"`,
		);

		const bySession = new Map<string, SubstrateEvent[]>();
		for (const row of rows) {
			const event = rowToEvent(row);
			const key = event.session_id ?? "";
			const bucket = bySession.get(key);
			if (bucket) bucket.push(event);
			else bySession.set(key, [event]);
		}

		for (const events of bySession.values()) {
			const result = verifyChain(events);
			if (!result.ok) return { ok: false, events: rows.length, brokenAt: result.brokenAt, reason: result.reason };
		}
		return { ok: true, events: rows.length };
	}

	async health(): Promise<{ index: boolean; greptime: boolean }> {
		return {
			index: this.index ? await this.index.ping() : false,
			greptime: this.greptime ? await this.greptime.ping() : false,
		};
	}
}
