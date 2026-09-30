/**
 * The substrate's behaviour, independent of transport.
 *
 * Both the MCP tools and the plain REST routes call into this, so the two
 * surfaces cannot drift. Hooks need REST (they cannot call MCP tools); agents
 * get MCP. Same code underneath.
 */
import { composeBrief, type BriefRequest } from "./brief.ts";
import type { SubstrateConfig } from "./config.ts";
import { inChainOrder, normalizeEvent, normalizeIdentifier, verifyChain } from "./event.ts";
import { GreptimeClient } from "./greptime.ts";
import { IndexStore } from "./index-store.ts";
import { redact } from "./redact.ts";
import type {
	Actor,
	EventInput,
	EventKind,
	MemoryEntry,
	MemoryEntryInput,
	NodeState,
	Surface,
	SubstrateEvent,
} from "./types.ts";

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

/**
 * The outcome of an append.
 *
 * `stored` is reported rather than assumed: the substrate fails open, so a
 * caller gets its normalised event back even when the ledger is unreachable —
 * and it would be dishonest to let that look like a durable write.
 */
export interface EmitResult {
	event: SubstrateEvent;
	/** False when the ledger is unconfigured, unreachable or refused the write. */
	stored: boolean;
	/** Why it was not stored. Redacted, because a connection error can quote a URL. */
	error?: string;
	/** Set when the append landed in a ledger that is not configured append-only. */
	warning?: string;
}

/**
 * Why a ledger that is not provably append-only refuses the write.
 *
 * Fail closed. Without `append_mode` Greptime drops one of two rows sharing a
 * primary key and a millisecond, and answering `stored: true` to a write that may
 * vanish is the one failure an events ledger must not have — a lost row also
 * breaks the chain for every event after it. A boot warning is not enough: it
 * scrolls away and the events keep coming.
 *
 * Refusing is safe to do here precisely because the substrate fails open at the
 * client: the CLI and every hook exit 0 regardless, so a refused append costs the
 * trail, never the agent's turn.
 */
const NOT_APPEND_ONLY =
	"refusing to append: agent_events is not in append_mode, so an event sharing a surface, repo, graph, " +
	"kind and millisecond with another may be silently dropped. Recreate the table (see " +
	"docs/greptime-ledger.md), or set SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER=true to accept that loss.";

const APPEND_MODE_UNKNOWN =
	"refusing to append: could not confirm agent_events is in append_mode. Fix the ledger's reachability, " +
	"or set SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER=true to append anyway.";

/** Told to a caller whose append landed in a ledger it knows may drop it. */
const DEDUP_WARNING =
	"agent_events is not in append_mode and SUBSTRATE_ALLOW_DEDUPLICATING_LEDGER is set: this event may be " +
	"silently dropped if another shares its surface, repo, graph, kind and millisecond.";

export class Substrate {
	readonly index: IndexStore | null;
	readonly greptime: GreptimeClient | null;

	/** `stores` is a test seam; production always builds them from config. */
	constructor(
		readonly config: SubstrateConfig,
		stores?: { index?: IndexStore | null; greptime?: GreptimeClient | null },
	) {
		this.index =
			stores?.index !== undefined ? stores.index : config.postgresUrl ? new IndexStore(config.postgresUrl) : null;
		this.greptime =
			stores?.greptime !== undefined ? stores.greptime : config.greptime ? new GreptimeClient(config.greptime) : null;
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
				const { warnings } = await this.greptime.migrate();
				greptimeOk = true;
				// A reachable but misconfigured ledger is a degraded state, not a healthy
				// one: it belongs in the same list the entry point prints at boot.
				for (const warning of warnings) errors.push(`greptime: ${warning}`);
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
	 *
	 * Invalid input throws — a caller that sent an unknown kind wants to hear
	 * about it. A ledger that is simply unavailable does not throw, because the
	 * substrate is never allowed to fail an agent's turn; the failure comes back
	 * as `stored: false` and is left to the caller to act on or ignore.
	 */
	async emit(input: EventInput): Promise<EmitResult> {
		let prev: string | null = null;
		// The session id is looked up in its stored form, not as it arrived: the
		// write path normalises it, and querying the raw value would match nothing
		// and restart the chain on every append.
		const sessionId = normalizeIdentifier(input.session_id);
		if (this.greptime && sessionId) {
			prev = await this.greptime.lastHash(sessionId).catch(() => null);
		}
		const event = normalizeEvent(input, prev);
		if (!this.greptime) return { event, stored: false, error: "GREPTIME_URL is not set" };

		// Fail closed: a ledger that may deduplicate does not get the write unless an
		// operator has explicitly accepted that loss.
		const appendOnly = await this.greptime.ensureAppendMode().catch(() => null);
		if (appendOnly !== true && !this.config.allowDeduplicatingLedger) {
			const error = appendOnly === false ? NOT_APPEND_ONLY : APPEND_MODE_UNKNOWN;
			process.stderr.write(`[substrate] event ${event.id} not stored — ${error}\n`);
			return { event, stored: false, error };
		}

		try {
			await this.greptime.insertEvent(event);
			return { event, stored: true, ...(appendOnly !== true ? { warning: DEDUP_WARNING } : {}) };
		} catch (cause) {
			const error = redact(String(cause));
			process.stderr.write(`[substrate] event ${event.id} not stored — ${error}\n`);
			return { event, stored: false, error };
		}
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
			// The repo comes from the graph, not the caller: a claim event without one
			// is invisible to every repo-scoped brief, which is exactly where a claim
			// most needs to be seen.
			const graph = await this.index.getGraph(graphId).catch(() => null);
			await this.emit({
				surface,
				kind: "claim",
				// The brief already renders the node id alongside every action, so
				// naming it here too reads as "claimed n4 (SPE-123) (n4)".
				summary: result.node.linear_identifier ? `claimed ${result.node.linear_identifier}` : "claimed node",
				graph_id: graphId,
				node_id: nodeId,
				linear_identifier: result.node.linear_identifier ?? undefined,
				session_id: sessionId,
				repo: graph?.repo ?? undefined,
				branch: graph?.branch ?? undefined,
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
		// Read by the graph id in its stored form, for the same reason `emit` looks
		// the session up by its normalised one.
		const rows = await this.greptime.readEvents("graph_id", normalizeIdentifier(graphId) ?? graphId);

		const bySession = new Map<string, SubstrateEvent[]>();
		for (const row of rows) {
			const event = rowToEvent(row);
			const key = event.session_id ?? "";
			const bucket = bySession.get(key);
			if (bucket) bucket.push(event);
			else bySession.set(key, [event]);
		}

		for (const events of bySession.values()) {
			const result = verifyChain(inChainOrder(events));
			if (!result.ok) return { ok: false, events: rows.length, brokenAt: result.brokenAt, reason: result.reason };
		}
		return { ok: true, events: rows.length };
	}

	/**
	 * `greptime` is reachability; `eventsWritable` is whether an append would
	 * actually be accepted. They differ on a reachable ledger that is not append-only
	 * — which is exactly the state a monitor needs to see, because every `emit` is
	 * being refused while `ping` succeeds.
	 */
	async health(): Promise<{
		index: boolean;
		greptime: boolean;
		appendOnly: boolean | null;
		eventsWritable: boolean;
	}> {
		const greptime = this.greptime ? await this.greptime.ping() : false;
		const appendOnly = greptime ? await this.greptime?.ensureAppendMode().catch(() => null) ?? null : null;
		return {
			index: this.index ? await this.index.ping() : false,
			greptime,
			appendOnly,
			eventsWritable: greptime && (appendOnly === true || this.config.allowDeduplicatingLedger),
		};
	}
}
