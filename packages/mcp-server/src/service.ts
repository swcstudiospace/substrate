/**
 * The substrate's behaviour, independent of transport.
 *
 * Both the MCP tools and the plain REST routes call into this, so the two
 * surfaces cannot drift. Hooks need REST (they cannot call MCP tools); agents
 * get MCP. Same code underneath.
 */
import { composeBrief, type BriefRequest } from "./brief.ts";
import { isReviewToken, type SubstrateConfig } from "./config.ts";
import {
	DEFAULT_IDLE_SECONDS,
	analyzeDrift,
	extractCommitSha,
	type DriftEvent,
	type DriftGitTip,
	type DriftReport,
} from "./drift.ts";
import { InvalidEventError, inChainOrder, normalizeEvent, normalizeIdentifier, verifyChain } from "./event.ts";
import { checkoutKnowsCommit, readGitTip } from "./git.ts";
import { GreptimeClient, queryLimit, type EventQuery, type QueryableColumn } from "./greptime.ts";
import { IndexStore, leaseSnapshot } from "./index-store.ts";
import {
	buildHandoff,
	handoffGaps,
	handoffSummary,
	signHandoff,
	verifyHandoff,
	type HandoffInput,
	type HandoffPacket,
	type HandoffVerdict,
} from "./handoff.ts";
import { leaseView, normalizeTtlSeconds, type LeaseView } from "./lease.ts";
import { governMemoryWrite } from "./memory-write.ts";
import { redact } from "./redact.ts";
import {
	ACTORS,
	EVENT_KINDS,
	SURFACES,
	type Actor,
	type EventInput,
	type EventKind,
	type GovernanceQueue,
	type GovernanceQueueRow,
	type GraphEdge,
	type GraphNode,
	type MemoryEntry,
	type MemoryEntryInput,
	type MemoryWriteRequest,
	type MemoryWriteResult,
	type NodeState,
	type Surface,
	type SubstrateEvent,
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

/** A queried row, with `payload` dropped unless it was selected. */
function rowToLedgerEvent(row: Record<string, unknown>, includePayload: boolean): LedgerEvent {
	const { payload, ...rest } = rowToEvent(row);
	return includePayload ? { ...rest, payload } : rest;
}

/**
 * Filters arrive from two places, and only one of them is typed.
 *
 * The MCP tool's arguments are checked by zod before they reach here; a JSON body
 * posted to `/events/query` is not, and the route does not re-state the schema — it
 * would be a second copy to drift. So every filter is checked here, at the one door
 * both surfaces come through. Anything that is not the declared type is refused,
 * which is the difference between a 400 that names the field and a 500 from
 * redaction being handed a number.
 */
function wrongType(what: string, expected: string): InvalidEventError {
	return new InvalidEventError(`${what} must be ${expected}`);
}

/**
 * A supplied identifier filter, normalised, or a refusal.
 *
 * Absent means the caller did not set the filter. Present-but-empty is not the same
 * thing: `normalizeIdentifier("")` is null, and dropping the clause would *widen* the
 * read to everything the other filters allow — the opposite of what a caller
 * narrowing by session asked for. So an empty string is refused rather than ignored.
 */
function filterText(what: string, value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw wrongType(what, "a string");
	const normalized = normalizeIdentifier(value);
	if (normalized === null) throw new InvalidEventError(`${what} is empty: omit it to leave the filter off`);
	return normalized;
}

/**
 * One of a closed set, or a refusal naming what was asked for.
 *
 * A filter on an unknown surface or kind would quietly match nothing, and a caller
 * reading an empty ledger window cannot tell that from a typo in their own query.
 */
function oneOf<T extends string>(what: string, allowed: readonly T[], value: unknown): T | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw wrongType(what, "a string");
	if (!(allowed as readonly string[]).includes(value)) {
		throw new InvalidEventError(`unknown ${what}: ${value}`);
	}
	return value as T;
}

/**
 * An ISO bound on `ts`, or a refusal. Quoted into SQL, so it is parsed before it is
 * trusted — and a number is refused rather than read as epoch millis, because
 * `new Date(123)` is a silently valid 1970 window that returns nothing.
 */
function bound(what: string, value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw wrongType(what, "an ISO date string");
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new InvalidEventError(`invalid ${what}: ${value}`);
	return date.toISOString();
}

/** A row count, clamped, or a refusal — `"10"` is a caller's bug, not a silent default. */
function rows(value: unknown): number {
	if (value === undefined || value === null) return queryLimit(undefined);
	if (typeof value !== "number" || !Number.isFinite(value)) throw wrongType("limit", "a number");
	return queryLimit(value);
}

function flag(what: string, value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value !== "boolean") throw wrongType(what, "a boolean");
	return value;
}

/**
 * A queried event.
 *
 * Every stored column except `payload`, which is present only when the caller asked
 * for it — see `GreptimeClient.queryEvents`.
 */
export type LedgerEvent = Omit<SubstrateEvent, "payload"> & { payload?: Record<string, unknown> };

/** A ledger read as a caller submits it: flat, snake_case, every field optional. */
export interface EventQueryInput {
	session_id?: string;
	graph_id?: string;
	node_id?: string;
	linear_identifier?: string;
	repo?: string;
	branch?: string;
	surface?: string;
	kind?: string;
	actor?: string;
	/** Inclusive bounds on `ts`, in any form `new Date()` accepts. */
	since?: string;
	until?: string;
	limit?: number;
	order?: "asc" | "desc";
	include_payload?: boolean;
}

export interface EventQueryResult {
	events: LedgerEvent[];
	count: number;
	/**
	 * The reply hit `limit`, so there may be more. Narrow the filters or raise `limit`.
	 *
	 * Not a page marker: `until` is a bound, not a cursor. Two events can share a
	 * millisecond, so re-querying from a boundary timestamp either repeats the rows at
	 * it or skips the ones that did not fit. Exhaustive paging needs a `(ts, id)`
	 * cursor, which this window deliberately does not have — it is a browse, and a
	 * complete read of a session or graph is `readEvents`, which takes no limit.
	 */
	truncated: boolean;
	/** Set when the ledger could not be read. Redacted, as on the write path. */
	error?: string;
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

	/**
	 * Read a window of the ledger.
	 *
	 * The read half of the store lock: Greptime is the only source, and it is reached
	 * only from here, so a desk seat gets the trail without a credential and without a
	 * second door onto the table.
	 *
	 * Identifier filters are normalised the way the write path stores them — the same
	 * rule `emit` follows when it looks up a session's chain tip. Querying the raw
	 * value would silently match nothing for any identifier that redaction or the
	 * length cap touched, and an empty answer is indistinguishable from an empty
	 * ledger.
	 *
	 * Invalid input throws, as on the write path: a filter on a surface that does not
	 * exist is a caller's bug and must not read as "nothing happened". A ledger that
	 * is merely unavailable comes back as an empty window with `error` set, because a
	 * missing store may not fail an agent's turn.
	 */
	async queryEvents(input: EventQueryInput = {}): Promise<EventQueryResult> {
		const match: Partial<Record<QueryableColumn, string | null | undefined>> = {
			session_id: filterText("session_id", input.session_id),
			graph_id: filterText("graph_id", input.graph_id),
			node_id: filterText("node_id", input.node_id),
			linear_identifier: filterText("linear_identifier", input.linear_identifier),
			repo: filterText("repo", input.repo),
			branch: filterText("branch", input.branch),
			surface: oneOf<Surface>("surface", SURFACES, input.surface),
			kind: oneOf<EventKind>("kind", EVENT_KINDS, input.kind),
			actor: oneOf<Actor>("actor", ACTORS, input.actor),
		};
		const order = oneOf<"asc" | "desc">("order", ["asc", "desc"], input.order);
		const query: EventQuery = {
			match,
			since: bound("since", input.since),
			until: bound("until", input.until),
			limit: rows(input.limit),
			order,
			includePayload: flag("include_payload", input.include_payload),
		};

		if (!this.greptime) return { events: [], count: 0, truncated: false, error: "GREPTIME_URL is not set" };
		try {
			const rows = await this.greptime.queryEvents(query);
			const events = rows.map((row) => rowToLedgerEvent(row, query.includePayload === true));
			return { events, count: events.length, truncated: events.length >= (query.limit ?? 0) };
		} catch (cause) {
			return { events: [], count: 0, truncated: false, error: redact(String(cause)) };
		}
	}

	/**
	 * Write a memory entry through the governance gate.
	 *
	 * **This is the fail-closed path.** `emit` hands a caller its event back even
	 * when the ledger is unreachable, because a lost event costs the trail and
	 * nothing else. Memory is different: it is what the next four sessions act on, so
	 * a write the gate cannot authorise, decide and verify comes back as `denied` and
	 * never as something another agent will read. A store that is missing or refusing
	 * is a refusal, not a silent success — there is no `accepted` without a row.
	 *
	 * It does not throw. A caller gets an outcome and a remedy for every path,
	 * including an outage, because "memory.write raised" is not something an agent
	 * mid-turn can act on and `denied: store.unavailable` is.
	 */
	async writeMemory(request: MemoryWriteRequest): Promise<MemoryWriteResult> {
		// Reported on every reply, including the ones the gate never sees, so a caller
		// always learns which surface its write was attributed to.
		const writer = typeof request.writer === "string" ? request.writer.trim() : "";
		if (!this.index) {
			return {
				outcome: "denied",
				reason: "store.unavailable",
				remedy:
					"memory.write needs the index: SUBSTRATE_PG_URL is not set, so there is nowhere to record this " +
					"and nothing would read it back. Nothing was stored.",
				verified_persisted: false,
				idempotency_key: "",
				writer,
			};
		}

		let result: MemoryWriteResult;
		try {
			result = await governMemoryWrite(request, {
				store: this.index,
				isReviewToken: (token) => isReviewToken(this.config, token),
				grants: this.config.memoryGrants,
				// The one place memory consults the ledger, and it is a read of one column:
				// `verified-by-test` rests on a source event, so the gate establishes that the
				// event exists before honouring the trust. No ledger, unreachable ledger or
				// unknown id all come back false, and the trust is downgraded rather than
				// taken on the caller's word.
				verifySourceEvent: async (eventId) =>
					this.greptime ? await this.greptime.hasEvent(eventId).catch(() => false) : false,
			});
		} catch (cause) {
			// Redacted for the reason `emit` redacts: a connection error quotes its URL,
			// password and all.
			const error = redact(String(cause));
			result = {
				outcome: "denied",
				reason: "store.write-failed",
				remedy: `The index refused the write (${error}). Nothing was stored; retry once it is reachable.`,
				verified_persisted: false,
				idempotency_key: "",
				writer,
			};
		}

		await this.auditMemoryWrite(request, result);
		return result;
	}

	/**
	 * Put a refused or unverified memory write in the event log.
	 *
	 * Governance that leaves no trace is indistinguishable from no governance: a
	 * denied write is otherwise visible only to the agent that was denied, which is
	 * the one party with an interest in not mentioning it.
	 *
	 * The event carries the decision, never the body. The body may be exactly the
	 * secret or the PII that got the write quarantined, and copying it into an
	 * append-only ledger to record that it was quarantined would be absurd.
	 */
	private async auditMemoryWrite(request: MemoryWriteRequest, result: MemoryWriteResult): Promise<void> {
		if (result.outcome === "accepted" && result.verified_persisted) return;
		// Redacted, and redacted *here* rather than relying on the event path: `scope`,
		// `kind` and `writer` are all caller-controlled, a refused write is exactly where
		// a malformed one arrives, and a credential in the journal is a credential
		// leaked whether or not the event that would have carried it was ever emitted.
		const line = redact(`memory.write ${result.outcome}: ${result.reason} (${request.kind} at ${request.scope})`);
		const writer = String(request.writer);
		process.stderr.write(`[substrate] ${line} by ${redact(writer)}\n`);

		// `emit` rejects an unknown surface, and an unattributed caller is precisely the
		// one that default-deny refuses most often. The stderr line above is its trail.
		if (!(SURFACES as readonly string[]).includes(writer)) return;
		await this.emit({
			surface: writer as Surface,
			kind: result.outcome === "conflict" ? "note" : "warning",
			summary: line,
			graph_id: request.graph_id,
			session_id: request.session_id,
			repo: request.repo,
			payload: {
				outcome: result.outcome,
				reason: result.reason,
				scope: request.scope,
				kind: request.kind,
				...(result.strategy ? { strategy: result.strategy } : {}),
				...(result.review_id ? { review_id: result.review_id } : {}),
				...(result.quarantine_id ? { quarantine_id: result.quarantine_id } : {}),
			},
		}).catch(() => undefined);
	}

	async searchMemory(query: string, scope?: string, limit?: number, includeSuperseded?: boolean): Promise<MemoryEntry[]> {
		if (!this.index) return [];
		return this.index.searchMemory(query, scope, limit, includeSuperseded);
	}

	/**
	 * What a reviewer has to look at: proposals awaiting review, and quarantined writes.
	 *
	 * Bodies and subjects need a reviewer's token. Redaction strips credentials, not the
	 * email address or phone number that caused a PII quarantine — so a queue that
	 * showed every body to every agent holding any surface token would publish exactly
	 * what quarantining it was meant to contain, and would do it to *more* readers than
	 * accepting the write would have.
	 *
	 * Without a token a caller still learns that something is parked, where, by whom and
	 * why. That is the part worth knowing and none of it is the payload.
	 */
	async governanceQueue(options: { limit?: number; review_token?: string } = {}): Promise<GovernanceQueue> {
		const authorized = isReviewToken(this.config, options.review_token);
		if (!this.index) return { authorized, reviews: [], quarantined: [] };
		const queue = await this.index.governanceQueue(options.limit);
		const visible = (row: GovernanceQueueRow): GovernanceQueueRow =>
			authorized ? row : { ...row, text: undefined, subject: undefined };
		return {
			authorized,
			reviews: queue.reviews.map(visible),
			quarantined: queue.quarantined.map(visible),
		};
	}

	async getGraph(graphId: string) {
		if (!this.index) return null;
		return this.index.getGraph(graphId);
	}

	async registerGraph(plan: Parameters<IndexStore["registerGraph"]>[0]) {
		if (!this.index) throw new Error("graph_register requires SUBSTRATE_PG_URL");
		return this.index.registerGraph(plan);
	}

	/** Where a node's events belong: the graph's repo, not whatever the caller said. */
	private async placeOf(graphId: string): Promise<{ repo?: string; branch?: string }> {
		// A claim event without a repo is invisible to every repo-scoped brief, which
		// is exactly where a claim most needs to be seen.
		const graph = await this.index?.getGraph(graphId).catch(() => null);
		return { ...(graph?.repo ? { repo: graph.repo } : {}), ...(graph?.branch ? { branch: graph.branch } : {}) };
	}

	/**
	 * Take or extend the lease on a node.
	 *
	 * The index decides — one statement, compare-and-swapped on the lease epoch,
	 * with expiry judged by Postgres' clock — so two agents asking at once cannot
	 * both be granted. What happens here is the *telling*: the lease and its
	 * holder go back to the caller, and the ledger gets an event for every change
	 * of hold, because a node quietly changing hands is how two agents come to
	 * disagree about who is doing what.
	 *
	 * A refused claim is not an error. The caller is told who holds the node and
	 * until when, which is what it needs in order to pick up something else.
	 */
	async claimNode(
		graphId: string,
		nodeId: string,
		surface: Surface,
		sessionId: string,
		ttlSeconds?: number,
	): Promise<{ claimed: boolean; node: GraphNode; lease: LeaseView; action: string; evicted: string | null }> {
		if (!this.index) throw new Error("graph_claim requires SUBSTRATE_PG_URL");
		const ttl = normalizeTtlSeconds(ttlSeconds, this.config.leaseTtlSeconds);
		const result = await this.index.claimNode(graphId, nodeId, surface, sessionId, ttl);
		const { decision } = result;
		const identifier = result.node.linear_identifier;

		if (result.claimed && decision.action !== "renewed") {
			// A renewal is deliberately silent. A heartbeating agent renews for as
			// long as it holds the node, and an event per renewal would bury the
			// trail under the one thing in it that carries no information.
			const evicted = decision.evicted;
			const what =
				decision.action === "stolen"
					? `took over ${identifier ?? "node"} — ${evicted?.surface ?? "the previous holder"}'s lease had expired`
					: decision.action === "reclaimed"
						? `re-claimed ${identifier ?? "node"} after its own lease expired`
						: `claimed ${identifier ?? "node"}`;
			await this.emit({
				surface,
				// A steal is the one claim another agent has to notice, so it is a
				// warning: the brief lists warnings, and the agent that was evicted
				// may still believe it holds the node.
				kind: decision.action === "stolen" ? "warning" : "claim",
				summary: what,
				graph_id: graphId,
				node_id: nodeId,
				linear_identifier: identifier ?? undefined,
				session_id: sessionId,
				payload: {
					action: decision.action,
					lease_id: result.lease.lease_id,
					lease_epoch: result.lease.epoch,
					ttl_seconds: ttl,
					expires_at: result.lease.expires_at,
					...(evicted ? { evicted } : {}),
				},
				...(await this.placeOf(graphId)),
			}).catch(() => undefined);
		}

		return {
			claimed: result.claimed,
			node: result.node,
			lease: result.lease,
			action: decision.action,
			evicted: decision.evicted ? `${decision.evicted.surface}/${decision.evicted.session_id}` : null,
		};
	}

	/**
	 * Extend a lease. No event: a heartbeat is the absence of news.
	 *
	 * A refusal is worth acting on, though — it means the holder has lost the node
	 * — so it comes back with the reason and the current holder rather than as a
	 * bare false.
	 */
	async heartbeatNode(graphId: string, nodeId: string, leaseId: string, ttlSeconds?: number) {
		if (!this.index) throw new Error("graph_heartbeat requires SUBSTRATE_PG_URL");
		const ttl = normalizeTtlSeconds(ttlSeconds, this.config.leaseTtlSeconds);
		const result = await this.index.heartbeatNode(graphId, nodeId, leaseId, ttl);
		return {
			ok: result.ok,
			lease: result.lease,
			...(result.decision.ok ? {} : { reason: result.decision.reason }),
			ttl_seconds: ttl,
		};
	}

	/**
	 * Drop a lease.
	 *
	 * Fenced on the lease id, so a holder whose lease lapsed cannot release the
	 * node someone else has since claimed. A refusal names the real holder.
	 */
	async releaseNode(graphId: string, nodeId: string, request: { lease_id?: string | null; force?: boolean } = {}) {
		if (!this.index) throw new Error("graph_release requires SUBSTRATE_PG_URL");
		const result = await this.index.releaseNode(graphId, nodeId, request);
		const { decision } = result;
		if (result.released && decision.ok && decision.action !== "noop") {
			const holder = decision.evicted ?? leaseView(leaseSnapshot(result.node)).holder;
			await this.emit({
				surface: holder?.surface ?? "claude-code",
				kind: decision.action === "forced" ? "warning" : "note",
				summary:
					decision.action === "forced"
						? `forced the lease off ${result.node.linear_identifier ?? "node"}, held by ${decision.evicted?.surface ?? "unknown"}`
						: `released ${result.node.linear_identifier ?? "node"}`,
				graph_id: graphId,
				node_id: nodeId,
				linear_identifier: result.node.linear_identifier ?? undefined,
				...(holder?.session_id ? { session_id: holder.session_id } : {}),
				payload: { action: decision.action, lease_id: decision.lease_id, ...(decision.evicted ? { evicted: decision.evicted } : {}) },
				...(await this.placeOf(graphId)),
			}).catch(() => undefined);
		}
		return {
			released: result.released,
			action: decision.ok ? decision.action : null,
			...(decision.ok ? {} : { reason: decision.reason, holder: decision.holder }),
			lease: leaseView(leaseSnapshot(result.node)),
		};
	}

	/**
	 * Mark a node complete and drop its lease.
	 *
	 * Fenced for the same reason a release is, and more sharply: an agent that
	 * stalled past its TTL and woke up must not be able to close a node a second
	 * agent has since claimed and is still working on. So the state is only
	 * written once the release has been accepted.
	 */
	async completeNode(
		graphId: string,
		nodeId: string,
		request: { lease_id?: string | null; force?: boolean; state?: NodeState } = {},
	) {
		if (!this.index) throw new Error("graph_complete requires SUBSTRATE_PG_URL");
		const released = await this.releaseNode(graphId, nodeId, request);
		if (!released.released) return { completed: false, ...released };
		await this.index.setNodeState(graphId, nodeId, request.state ?? "completed");
		return { completed: true, ...released };
	}

	/**
	 * Clear every lapsed lease, and say so in the ledger.
	 *
	 * Expiry is honoured lazily everywhere else — a lapsed lease already reads as
	 * free — so this exists to make the auto-release *visible*: the row stops
	 * naming a holder that is gone, and each release becomes a warning another
	 * agent will see in its brief.
	 */
	async reapExpiredLeases(repo?: string | null) {
		if (!this.index) return [];
		const reaped = await this.index.reapExpiredLeases(repo ?? null);
		for (const lease of reaped) {
			await this.emit({
				surface: lease.holder?.surface ?? "claude-code",
				kind: "warning",
				summary: `lease on ${lease.linear_identifier ?? lease.node_id} expired and was released${lease.holder ? ` (held by ${lease.holder.surface})` : ""}`,
				graph_id: lease.graph_id,
				node_id: lease.node_id,
				linear_identifier: lease.linear_identifier ?? undefined,
				...(lease.holder?.session_id ? { session_id: lease.holder.session_id } : {}),
				payload: { action: "expired", lease_id: lease.lease_id, expired_at: lease.expired_at, ...(lease.holder ? { evicted: lease.holder } : {}) },
				...(await this.placeOf(lease.graph_id)),
			}).catch(() => undefined);
		}
		return reaped;
	}

	// ── handoffs ───────────────────────────────────────────────────────────────

	/**
	 * Record a signed handoff packet.
	 *
	 * Three things happen in an order that matters. `prev_event_hash` is filled
	 * from the sender's own chain tip unless it supplied one, which anchors the
	 * packet to the trail that led to it. The packet is then built — redacted,
	 * capped, fitted — and only then signed, so the bytes signed are the bytes
	 * stored. Finally it is appended as a `handoff` event carrying the whole
	 * packet, which is what makes the handoff replayable from the ledger alone.
	 *
	 * The reply says what is true rather than what was hoped for: `signed` is
	 * false when no key is configured, `stored` is false when the ledger would not
	 * take the event, and `gaps` names what a receiver will find missing.
	 */
	async handoff(
		input: HandoffInput & { release_lease?: boolean },
	): Promise<{
		packet: HandoffPacket;
		signed: boolean;
		stored: boolean;
		event: { id: string; ts: string; hash: string; prev: string | null };
		gaps: string[];
		error?: string;
		warning?: string;
		lease_released?: boolean;
	}> {
		const place = input.graph_id ? await this.placeOf(input.graph_id) : {};
		const sessionId = normalizeIdentifier(input.from?.session_id);
		// The sender's chain tip. Not supplied by the caller in the normal case: it
		// is a fact about the ledger, and the ledger is here.
		const prev =
			input.prev_event_hash ?? (this.greptime && sessionId ? await this.greptime.lastHash(sessionId).catch(() => null) : null);

		let releasedLeaseId: string | null = null;
		let leaseReleased: boolean | undefined;
		if (input.release_lease && input.released_lease_id && input.graph_id && input.node_id) {
			// Released before the packet is built, so the packet can state honestly
			// whether the node is free — a receiver reading "released" and finding the
			// node still held would be worse than not being told.
			const result = await this.releaseNode(input.graph_id, input.node_id, { lease_id: input.released_lease_id }).catch(
				() => null,
			);
			leaseReleased = result?.released === true;
			if (leaseReleased) releasedLeaseId = input.released_lease_id;
		} else if (input.released_lease_id) {
			releasedLeaseId = input.released_lease_id;
		}

		const built = buildHandoff({
			...input,
			repo: input.repo ?? place.repo ?? null,
			branch: input.branch ?? place.branch ?? null,
			prev_event_hash: prev,
			released_lease_id: releasedLeaseId,
		});
		const signer = this.config.handoffKeyId
			? { key_id: this.config.handoffKeyId, key: this.config.handoffKeys.get(this.config.handoffKeyId) ?? "" }
			: null;
		const packet = signHandoff(built, signer);

		const result = await this.emit({
			surface: packet.from.surface,
			kind: "handoff",
			summary: handoffSummary(packet),
			graph_id: packet.graph_id ?? undefined,
			node_id: packet.node_id ?? undefined,
			linear_identifier: packet.linear_identifier ?? undefined,
			session_id: packet.from.session_id ?? undefined,
			repo: packet.repo ?? undefined,
			branch: packet.branch ?? undefined,
			payload: { handoff: packet },
		});

		return {
			packet,
			signed: packet.signature !== null,
			stored: result.stored,
			event: { id: result.event.id, ts: result.event.ts, hash: result.event.hash, prev: result.event.prev },
			gaps: handoffGaps(packet),
			...(result.error ? { error: result.error } : {}),
			...(result.warning ? { warning: result.warning } : {}),
			...(leaseReleased === undefined ? {} : { lease_released: leaseReleased }),
		};
	}

	verifyHandoffPacket(packet: unknown): HandoffVerdict {
		return verifyHandoff(packet, this.config.handoffKeys);
	}

	/**
	 * Every handoff recorded for a graph, verified, oldest first.
	 *
	 * This is the replay path: the packets come back out of the append-only ledger
	 * exactly as they were signed, each with its own verdict, so a receiving agent
	 * can pick up a handoff it never saw being written. A packet that does not
	 * verify is still returned — hiding it would leave a gap in the history with
	 * no explanation for it — with the reason attached.
	 */
	async handoffsForGraph(graphId: string): Promise<
		Array<{ event_id: string; ts: string; packet: HandoffPacket | null; verdict: HandoffVerdict }>
	> {
		if (!this.greptime) return [];
		const rows = await this.greptime
			.readEvents("graph_id", normalizeIdentifier(graphId) ?? graphId)
			.catch(() => [] as Array<Record<string, unknown>>);
		const out: Array<{ event_id: string; ts: string; packet: HandoffPacket | null; verdict: HandoffVerdict }> = [];
		for (const row of rows) {
			if (String(row.kind) !== "handoff") continue;
			const event = rowToEvent(row);
			const packet = (event.payload.handoff ?? null) as HandoffPacket | null;
			out.push({
				event_id: event.id,
				ts: event.ts,
				packet,
				verdict: packet ? this.verifyHandoffPacket(packet) : { ok: false, reason: "malformed" },
			});
		}
		return out;
	}

	// ── drift ──────────────────────────────────────────────────────────────────

	/**
	 * Compare the tree, the trail and the claims for one repo.
	 *
	 * Gathering only: every source is optional and every failure degrades to "not
	 * compared" rather than throwing, because a scan that cannot read one record
	 * can still report the disagreements among the other two — and a scan that
	 * threw would tell an agent nothing at all. `analyzeDrift` does the comparing.
	 */
	async driftScan(request: {
		repo: string;
		path?: string | null;
		git_tip?: string | null;
		branch?: string | null;
		idle_seconds?: number;
		limit?: number;
	}): Promise<DriftReport> {
		const repo = request.repo;
		const stored = normalizeIdentifier(repo) ?? repo;

		// The tree. A caller that already knows the tip — a hook, which has just run
		// in the checkout — passes it and no path is read at all.
		let git: DriftGitTip = { sha: null, short_sha: null, subject: null, committed_at: null, branch: request.branch ?? null };
		if (request.git_tip) {
			git = { ...git, sha: request.git_tip, short_sha: request.git_tip.slice(0, 7) };
		} else if (request.path) {
			const tip = readGitTip(request.path);
			git = { ...tip, branch: tip.branch ?? request.branch ?? null };
		} else {
			git = { ...git, unavailable: "no path or git_tip given, so the working tree was not read" };
		}

		// The trail.
		let events: DriftEvent[] = [];
		let ledgerOk = false;
		if (this.greptime) {
			const rows = await this.greptime.recentForRepo(stored, request.limit ?? 200).catch(() => null);
			if (rows) {
				ledgerOk = true;
				events = rows.map((row) => {
					const event = rowToEvent(row);
					return {
						id: event.id,
						ts: event.ts,
						surface: event.surface,
						session_id: event.session_id,
						kind: event.kind,
						summary: event.summary,
						graph_id: event.graph_id,
						node_id: event.node_id,
						sha: event.kind === "commit" ? extractCommitSha(event.summary, event.payload) : null,
					};
				});
			}
		}

		// Whether the checkout holds the commit the trail names newest. Asked only
		// when both are available, and only of the one sha that matters.
		const newestCommit = events.find((event) => event.kind === "commit" && event.sha);
		if (request.path && newestCommit?.sha) {
			git = { ...git, knows_ledger_commit: checkoutKnowsCommit(request.path, newestCommit.sha) };
		}

		// The claims.
		let claims: Awaited<ReturnType<IndexStore["claimedNodesForRepo"]>> = [];
		let nodes: GraphNode[] = [];
		let edges: GraphEdge[] = [];
		let indexOk = false;
		if (this.index) {
			const gathered = await Promise.all([
				this.index.claimedNodesForRepo(repo).catch(() => null),
				this.index.nodesForRepo(repo).catch(() => null),
				this.index.edgesForRepo(repo).catch(() => null),
			]);
			if (gathered[0] && gathered[1] && gathered[2]) {
				indexOk = true;
				[claims, nodes, edges] = [gathered[0], gathered[1], gathered[2]];
			}
		}

		return analyzeDrift({
			repo,
			git,
			events,
			claims: claims.map((node) => ({
				graph_id: node.graph_id,
				node_id: node.node_id,
				linear_identifier: node.linear_identifier,
				state: node.state,
				lease: leaseSnapshot(node),
			})),
			nodes: nodes.map((node) => ({
				graph_id: node.graph_id,
				node_id: node.node_id,
				linear_identifier: node.linear_identifier,
				state: node.state,
			})),
			edges,
			idle_seconds: request.idle_seconds ?? DEFAULT_IDLE_SECONDS,
			sources: { git: git.sha !== null, ledger: ledgerOk, index: indexOk },
		});
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
	 * `greptime` is reachability; `eventsWritable` is whether **every** event would
	 * be accepted. They differ on a reachable ledger that is refusing, which is
	 * exactly the state a monitor needs to see because `ping` still succeeds.
	 *
	 * Two things make a reachable ledger unwritable, and both belong here:
	 * a table that is not append-only refuses everything, and an unknown quoting
	 * dialect refuses any event carrying a backslash. The second is partial, but a
	 * trail with holes in it is not a writable ledger, and calling it one would hide
	 * the very failure this reports.
	 *
	 * Probing here is deliberate: a monitor's own request retries both checks, so a
	 * ledger that recovers — or a table recreated out of band — is picked up without
	 * waiting for a restart.
	 */
	async health(): Promise<{
		index: boolean;
		greptime: boolean;
		appendOnly: boolean | null;
		quotingDialectKnown: boolean;
		eventsWritable: boolean;
	}> {
		const greptime = this.greptime ? await this.greptime.ping() : false;
		const appendOnly = greptime ? (await this.greptime?.ensureAppendMode().catch(() => null)) ?? null : null;
		const quotingDialectKnown = greptime
			? await this.greptime?.probeDialect().then(() => this.greptime?.quotingDialectKnown === true).catch(() => false) ?? false
			: false;
		return {
			index: this.index ? await this.index.ping() : false,
			greptime,
			appendOnly,
			quotingDialectKnown,
			eventsWritable:
				greptime && quotingDialectKnown && (appendOnly === true || this.config.allowDeduplicatingLedger),
		};
	}
}
