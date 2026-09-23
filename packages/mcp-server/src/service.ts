/**
 * The substrate's behaviour, independent of transport.
 *
 * Both the MCP tools and the plain REST routes call into this, so the two
 * surfaces cannot drift. Hooks need REST (they cannot call MCP tools); agents
 * get MCP. Same code underneath.
 */
import { composeBrief, type BriefRequest } from "./brief.ts";
import type { SubstrateConfig } from "./config.ts";
import { normalizeEvent } from "./event.ts";
import { GreptimeClient } from "./greptime.ts";
import { IndexStore } from "./index-store.ts";
import type { EventInput, MemoryEntry, MemoryEntryInput, NodeState, Surface, SubstrateEvent } from "./types.ts";

export class Substrate {
	readonly index: IndexStore | null;
	readonly greptime: GreptimeClient | null;

	constructor(readonly config: SubstrateConfig) {
		this.index = config.postgresUrl ? new IndexStore(config.postgresUrl) : null;
		this.greptime = config.greptime ? new GreptimeClient(config.greptime) : null;
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

	async registerGraph(plan: Parameters<IndexStore["registerGraph"]>[0]) {
		if (!this.index) throw new Error("graph_register requires SUBSTRATE_PG_URL");
		return this.index.registerGraph(plan);
	}

	/**
	 * Claim a node for a surface. Phase 0 records the claim in the index and the
	 * event log; Phase 2 adds the Linear and Notion mirroring.
	 */
	async claimNode(graphId: string, nodeId: string, surface: Surface, sessionId: string) {
		if (!this.index) throw new Error("graph_claim requires SUBSTRATE_PG_URL");
		const result = await this.index.claimNode(graphId, nodeId, surface, sessionId);
		if (result.claimed) {
			await this.emit({
				surface,
				kind: "claim",
				summary: `claimed ${nodeId}${result.node.linear_identifier ? ` (${result.node.linear_identifier})` : ""}`,
				graph_id: graphId,
				node_id: nodeId,
				linear_identifier: result.node.linear_identifier ?? undefined,
				session_id: sessionId,
			}).catch(() => undefined);
		}
		return result;
	}

	async releaseNode(graphId: string, nodeId: string) {
		if (!this.index) throw new Error("graph_release requires SUBSTRATE_PG_URL");
		await this.index.releaseNode(graphId, nodeId);
	}

	async completeNode(graphId: string, nodeId: string, state: NodeState = "completed") {
		if (!this.index) throw new Error("graph_complete requires SUBSTRATE_PG_URL");
		await this.index.setNodeState(graphId, nodeId, state);
		await this.index.releaseNode(graphId, nodeId);
	}

	async health(): Promise<{ index: boolean; greptime: boolean }> {
		return {
			index: this.index ? await this.index.ping() : false,
			greptime: this.greptime ? await this.greptime.ping() : false,
		};
	}
}
