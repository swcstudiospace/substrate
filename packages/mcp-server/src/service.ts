/**
 * The substrate's behaviour, independent of transport.
 *
 * Both the MCP tools and the plain REST routes call into this, so the two
 * surfaces cannot drift. Hooks need REST (they cannot call MCP tools); agents
 * get MCP. Same code underneath.
 */
import { randomUUID } from "node:crypto";
import { decideClaim, type ClaimDecision } from "@substrate/audit";
import { formatMemo, hourEnd, hourIso, hourStart, isClosed, merkleRootHex } from "@substrate/ledger";
import { composeBrief, type BriefRequest } from "./brief.ts";
import {
	GRAPHS_GENERATION_KEY,
	MEMORY_GENERATION_KEY,
	createReadThroughCache,
	earliestRefreshAt,
	graphGenerationKey,
	type CacheHealth,
	type CacheSample,
	type ReadThroughCache,
} from "./cache.ts";
import { isReviewToken, type SubstrateConfig } from "./config.ts";
import {
	DEFAULT_IDLE_SECONDS,
	analyzeDrift,
	extractCommitSha,
	shaMatches,
	type DriftEvent,
	type DriftGitTip,
	type DriftReport,
} from "./drift.ts";
import { InvalidEventError, inChainOrder, normalizeEvent, normalizeIdentifier, verifyChain } from "./event.ts";
import { checkoutKnowsCommit, readGitTip } from "./git.ts";
import {
	GreptimeClient,
	INGEST_LAG_MS,
	IngestNotRecorded,
	queryLimit,
	type EventQuery,
	type QueryableColumn,
} from "./greptime.ts";
import { IndexStore, leaseSnapshot, type GraphBindResult } from "./index-store.ts";
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
import { normalizeSubject } from "./memory-policy.ts";
import { governMemoryWrite } from "./memory-write.ts";
import { redact, type SkillDocExampleRule } from "./redact.ts";
import {
	createExecFileRunner,
	createSkillProposer,
	ProposeFailed,
	ProposeRefused,
	ROUTE_MAX_BYTES,
	SKILL_NAME_RE,
	type ProposeInput,
	type ProposeResult,
	type SkillProposer,
	type TreeMode,
} from "./skills/propose.ts";
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
	type GraphView,
	type MemoryEntry,
	type MemoryEntryInput,
	type MemorySearch,
	type MemorySearchPage,
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

/**
 * A graph as any reader sees it: every node's `lease_id` nulled.
 *
 * The id is the token heartbeat, release and complete take as proof of holding,
 * and its holder already has it from its own grant. Holder, session, epoch and
 * expiry stay, because they are what another agent needs to pick other work.
 */
function withoutLeaseIds(graph: GraphView): GraphView {
	return { ...graph, nodes: graph.nodes.map((node) => ({ ...node, lease_id: null })) };
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
	/**
	 * Set when the event is stored but something about it is not as promised: the ledger is
	 * not configured append-only, or the event's ingest record could not be written so it
	 * will not be anchored. The event is not re-emitted in either case.
	 */
	warning?: string;
}

/**
 * One closed UTC hour of the ledger, digested in ingest order for the hourly anchor.
 *
 * `root` and `memo` are null for an hour that no event was ingested in: an anchor with
 * nothing to commit to is a skip, not a transaction (D27-15).
 */
export interface HourDigest {
	/** ISO start of the hour, inclusive. */
	period_start: string;
	/** ISO end of the hour, exclusive. */
	period_end: string;
	event_count: number;
	/** The RFC 6962 root over the members' event hashes, 64 lowercase hex; null when the hour is empty. */
	root: string | null;
	/** The `substrate:v1` memo for the hour; carries the period, the root and the count, never event content. */
	memo: string | null;
	/** The members' event ids in position order, the order the root is computed over. */
	event_ids: string[];
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

/**
 * Told to a caller whose event is stored but whose ingest write could not be confirmed (D27-09).
 *
 * The event is durable, so the caller must not re-emit it: a retry would store a
 * second event with a new id. A failed attempt is not proof the record is absent,
 * so the warning says coverage may be missing.
 */
const INGEST_NOT_RECORDED =
	"the event is stored, but its ingest write could not be confirmed, so hourly coverage may be missing. " +
	"Do not re-emit it: a retry would store a second event.";

/**
 * Where the service reports what it measured.
 *
 * A narrow port of plain samples rather than the instrument objects themselves, so
 * the service stays testable without building a metric registry, and so nothing
 * here can fail a turn: every method is synchronous, returns nothing and is called
 * from a position where throwing would be a bug in the observer, not in the
 * substrate. `observe.ts` implements it over `@substrate/observability`.
 */
export interface SubstrateObserver {
	briefed?(sample: { surface: Surface; graph_id: string | null; ok: boolean; durationMs: number }): void;
	emitted?(sample: {
		surface: Surface;
		graph_id: string | null;
		kind: EventKind;
		stored: boolean;
		durationMs: number;
		payload: Record<string, unknown>;
	}): void;
	cached?(sample: CacheSample): void;
	claimed?(sample: {
		surface: Surface;
		graph_id: string;
		node_id: string;
		decision: ClaimDecision;
		/**
		 * What the *index* did: `granted`, `renewed`, `reclaimed`, `stolen` or `refused`.
		 *
		 * Carried alongside `decision` rather than folded into it because the two answer
		 * different questions and only the pair is enough for the lease-steal SLO. A
		 * takeover of another surface's expired lease is `decision: "granted"` with
		 * `action: "stolen"`; without the action the observer saw only the grant, mapped it
		 * to the `granted` metric outcome, and the lease-steal rate read zero for every
		 * takeover that actually happened — an objective that cannot move is not one.
		 */
		action: string;
		reason: string | null;
		quarantineReason: string | null;
	}): void;
}

/** What `claimNode` answers. `claimed` stays the field every existing caller reads. */
export interface ClaimResult {
	claimed: boolean;
	/** The node row, with `lease_id` nulled: the id travels in `lease`, to its holder only. */
	node: GraphNode;
	/** The lease. `lease_id` is set only when `claimed` is true; a refusal shows holder and expiry. */
	lease: LeaseView;
	/** What the index did: granted, renewed, reclaimed, stolen, or refused. */
	action: string;
	/** The holder this claim displaced, as `surface/session`. */
	evicted: string | null;
	/** Whether the hold stands once the ledger has been accounted for. */
	decision: ClaimDecision;
	/** Why, when the claim was refused or withdrawn. */
	reason: string | null;
	/** The TTL the hold was granted for, after clamping, so a holder can pace its heartbeats; null when no hold stands. */
	ttl_seconds: number | null;
}

/** A swarm run's correlation id: 1..200 characters of `[A-Za-z0-9._:-]`. */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
/** A Graph ID as minted by the ultrathink uplift: `ut-<ts36>-<8hex>`. */
export const GRAPH_ID_PATTERN = /^ut-[a-z0-9]+-[0-9a-f]{8}$/;

export class InvalidBindError extends Error {}

/**
 * Why `proposeSkill` would not act for this caller. `status` is the HTTP class the route
 * answers with: 401 for no authenticated surface, 403 for a surface mismatch or an
 * operator-only option from a non-operator. Nothing reached git or `gh`.
 */
export class SkillProposalDenied extends Error {
	constructor(
		readonly status: 401 | 403,
		message: string,
	) {
		super(message);
		this.name = "SkillProposalDenied";
	}
}

/** What a proposal names, as the route, the tool and the CLI hand it over. */
export interface SkillProposalRequest {
	name: string;
	files: Record<string, string>;
	rationale: string;
	remove?: string[];
	/** The caller's own surface, or absent. A different one is refused, never re-attributed. */
	surface?: string;
	session_id?: string;
	graph_id?: string;
	/** Validate, redact, clone and count the diff; push nothing, call no `gh`, emit nothing. */
	dry_run?: boolean;
	/** Operator-only. */
	mode?: TreeMode;
	/** Operator-only. */
	reopen?: boolean;
	/** Operator-only. */
	allow_doc_examples?: SkillDocExampleRule[];
}

/** The three shapes of `graph_bind`, decided by which of the two ids were given. */
export type BindOutcome =
	| GraphBindResult
	| { status: "existing" | "unbound"; correlation_id: string; graph_id: string | null }
	| { graph_id: string; correlation_ids: string[] };

/**
 * Validate a `graph_bind` request. At least one id is required, and each one given
 * must have the documented shape — a malformed Graph ID stored as a binding is a
 * lookup that can never match anything the swarm minted.
 */
export function parseBindRequest(input: { correlation_id?: unknown; graph_id?: unknown }): {
	correlation_id?: string;
	graph_id?: string;
} {
	const present = (value: unknown): boolean => value !== undefined && value !== null;
	if (!present(input.correlation_id) && !present(input.graph_id)) {
		throw new InvalidBindError("graph_bind needs `correlation_id`, `graph_id`, or both");
	}
	const out: { correlation_id?: string; graph_id?: string } = {};
	if (present(input.correlation_id)) {
		if (typeof input.correlation_id !== "string" || !CORRELATION_ID_PATTERN.test(input.correlation_id)) {
			throw new InvalidBindError("`correlation_id` must be 1..200 characters of [A-Za-z0-9._:-]");
		}
		out.correlation_id = input.correlation_id;
	}
	if (present(input.graph_id)) {
		if (typeof input.graph_id !== "string" || !GRAPH_ID_PATTERN.test(input.graph_id)) {
			throw new InvalidBindError("`graph_id` must match ut-<ts36>-<8hex>");
		}
		out.graph_id = input.graph_id;
	}
	return out;
}

export class InvalidSearchError extends Error {}

/**
 * An ISO-8601 instant with an explicit zone, to the microsecond at most — what a
 * `memory_search` cursor is, and nothing Postgres would read some other way.
 */
export const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Check calendar fields without Date.parse's day rollover or loss of microseconds. */
function isValidMemoryCursor(value: string): boolean {
	if (!ISO_TIMESTAMP_PATTERN.test(value)) return false;
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(5, 7));
	const day = Number(value.slice(8, 10));
	if (year === 0 || month < 1 || month > 12) return false;
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = month === 2 ? (leapYear ? 29 : 28) : (month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31);
	if (day < 1 || day > daysInMonth) return false;

	const hour = Number(value.slice(11, 13));
	const minute = Number(value.slice(14, 16));
	const second = Number(value.slice(17, 19));
	if (hour > 24 || minute > 59 || second > 59) return false;
	const utc = value.endsWith("Z");
	const zoneStart = utc ? value.length - 1 : value.length - 6;
	// ISO end-of-day midnight remains valid, but even one microsecond past it is not.
	if (hour === 24 && (minute !== 0 || second !== 0 || (zoneStart > 19 && !/^\.0+$/.test(value.slice(19, zoneStart))))) {
		return false;
	}
	if (!utc) {
		// PostgreSQL accepts numeric zone displacement only below sixteen hours.
		if (Number(value.slice(zoneStart + 1, zoneStart + 3)) > 15 || Number(value.slice(zoneStart + 4)) > 59) return false;
	}
	return true;
}

/** `memory_search`'s arguments, as the tool takes them. */
export interface MemorySearchRequest {
	query?: string;
	scope?: string;
	limit?: number;
	include_superseded?: boolean;
	subject_prefix?: string;
	before?: string;
	before_id?: string;
}

/** Whether a search asks for a page — a cursor back, rather than the bare newest-N list. */
export function isPagedSearch(request: MemorySearchRequest): boolean {
	return request.subject_prefix !== undefined || request.before !== undefined || request.before_id !== undefined;
}

/**
 * Validate a paged `memory_search`.
 *
 * `query` may be left out once `subject_prefix` names what to list: that is how a
 * caller reads every entry under a subject family rather than the newest 100
 * mentioning a word. The prefix goes through `normalizeSubject`, because a stored
 * subject went through it — a prefix that kept its capitals would match nothing.
 *
 * `before_id` only breaks a tie at `before`, so it means nothing without it.
 */
export function parseMemorySearch(request: MemorySearchRequest): MemorySearch {
	const search: MemorySearch = {
		query: request.query,
		scope: request.scope,
		limit: request.limit,
		includeSuperseded: request.include_superseded,
	};
	if (request.subject_prefix !== undefined) {
		const prefix = normalizeSubject(request.subject_prefix);
		if (!prefix) throw new InvalidSearchError("`subject_prefix` is empty once normalised");
		search.subjectPrefix = prefix;
	}
	if (search.query === undefined && search.subjectPrefix === undefined) {
		throw new InvalidSearchError("memory_search needs `query`, or `subject_prefix` to list a subject family");
	}
	if (request.before !== undefined) {
		if (!isValidMemoryCursor(request.before)) {
			throw new InvalidSearchError("`before` must be an ISO-8601 timestamp with a zone, as a page's `next.before` gives it");
		}
		search.before = request.before;
	}
	if (request.before_id !== undefined) {
		if (search.before === undefined) throw new InvalidSearchError("`before_id` breaks a tie at `before`, and needs it");
		if (request.before_id.length === 0) throw new InvalidSearchError("`before_id` is empty");
		search.beforeId = request.before_id;
	}
	return search;
}

export class Substrate {
	readonly index: IndexStore | null;
	readonly greptime: GreptimeClient | null;
	/** The one git path proposals take; inert until plan 02's `proposeSkill` calls it. */
	readonly skills: SkillProposer;
	private readonly observer: SubstrateObserver;
	private readonly cache: ReadThroughCache;

	/** `stores` is a test seam; production always builds them from config. */
	constructor(
		readonly config: SubstrateConfig,
		stores?: {
			index?: IndexStore | null;
			greptime?: GreptimeClient | null;
			skills?: SkillProposer;
			cache?: ReadThroughCache;
		},
		observer: SubstrateObserver = {},
	) {
		this.index =
			stores?.index !== undefined ? stores.index : config.postgresUrl ? new IndexStore(config.postgresUrl) : null;
		this.greptime =
			stores?.greptime !== undefined ? stores.greptime : config.greptime ? new GreptimeClient(config.greptime) : null;
		this.skills =
			stores?.skills ??
			createSkillProposer({
				run: createExecFileRunner({ gh: config.skills.gh }),
				library: { repo: config.skills.repo, remoteUrl: config.skills.remoteUrl },
				stateDir: config.skills.stateDir,
			});
		this.observer = observer;
		this.cache =
			stores?.cache ??
			createReadThroughCache(config, (sample) => {
				this.observer.cached?.(sample);
			});
	}

	/**
	 * Whether a claim needs its event in the ledger to stand.
	 *
	 * Derived from whether a ledger exists at all, not from whether it is up: a
	 * ledger that is down is exactly the case fail-closed is for. An explicit
	 * `SUBSTRATE_CLAIM_REQUIRE_LEDGER` overrides both ways.
	 */
	get requireRecordedClaims(): boolean {
		return this.config.requireRecordedClaims ?? this.greptime !== null;
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
		const started = performance.now();
		let ok = false;
		try {
			const noted: Array<number | null> = [];
			const brief = await this.cache.getOrLoad({
				klass: "brief",
				surface: request.surface,
				args: {
					repo: request.repo ?? null,
					branch: request.branch ?? null,
					graph_id: request.graph_id ?? null,
				},
				// The shared graphs generation covers repo briefs and the other
				// graphs a single-graph brief lists. The graph's own key still
				// moves when that graph is written.
				generations: request.graph_id
					? [MEMORY_GENERATION_KEY, GRAPHS_GENERATION_KEY, graphGenerationKey(request.graph_id)]
					: [MEMORY_GENERATION_KEY, GRAPHS_GENERATION_KEY],
				refreshAt: () => noted.at(-1) ?? null,
				load: () =>
					composeBrief(request, { index: this.index, greptime: this.greptime }, (at) => {
						noted.push(at);
					}),
			});
			ok = true;
			return brief;
		} finally {
			// Timed in `finally` so a brief that threw is still in the histogram. The SLO
			// is about what the caller waited for, and a failure is a wait too.
			this.observer.briefed?.({
				surface: request.surface,
				graph_id: normalizeIdentifier(request.graph_id),
				ok,
				durationMs: performance.now() - started,
			});
		}
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
		const started = performance.now();
		const result = await this.append(input);
		// Reported after the append rather than around it, because the sample carries
		// `stored` — and because the payload is where a collector puts the tokens and
		// cost this event is accountable for.
		this.observer.emitted?.({
			surface: result.event.surface,
			graph_id: result.event.graph_id,
			kind: result.event.kind,
			stored: result.stored,
			durationMs: performance.now() - started,
			payload: result.event.payload,
		});
		return result;
	}

	private async append(input: EventInput): Promise<EmitResult> {
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
			if (cause instanceof IngestNotRecorded) {
				// Branch first: this error means the event row is already stored. Reporting
				// it as `stored: false` would invite a retry that mints a second event.
				process.stderr.write(`[substrate] event ${event.id} stored but ingest unconfirmed — ${error}\n`);
				return {
					event,
					stored: true,
					warning: appendOnly !== true ? `${INGEST_NOT_RECORDED} ${DEDUP_WARNING}` : INGEST_NOT_RECORDED,
				};
			}
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
		let commitUncertain = false;
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
			// The gate throws once an insert may already have committed, including
			// a read-back that fails after the row landed. Treat that like a write.
			commitUncertain = true;
		}

		await this.auditMemoryWrite(request, result);
		if (result.outcome === "accepted" || commitUncertain) await this.cache.bump(MEMORY_GENERATION_KEY);
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

	async searchMemory(
		query: string,
		scope?: string,
		limit?: number,
		includeSuperseded?: boolean,
		surface = "unattributed",
	): Promise<MemoryEntry[]> {
		return this.cache.getOrLoad({
			klass: "memory-search",
			surface,
			args: { query, scope: scope ?? null, limit: limit ?? null, includeSuperseded: includeSuperseded ?? false },
			generations: [MEMORY_GENERATION_KEY],
			refreshAt: (entries) => earliestRefreshAt(entries.map((entry) => entry.reverify_after)),
			load: async () => {
				if (!this.index) return [];
				return this.index.searchMemory(query, scope, limit, includeSuperseded);
			},
		});
	}

	/**
	 * A paged search: `subject_prefix` and the `(before, before_id)` cursor. The
	 * visibility rules are `searchMemory`'s — this reads the same entries, only
	 * further back — so nothing quarantined, parked or retired is reachable here
	 * that was not before.
	 */
	async searchMemoryPage(request: MemorySearchRequest, surface = "unattributed"): Promise<MemorySearchPage> {
		const search = parseMemorySearch(request);
		return this.cache.getOrLoad({
			klass: "memory-search",
			surface,
			args: search,
			generations: [MEMORY_GENERATION_KEY],
			refreshAt: (page) => earliestRefreshAt(page.entries.map((entry) => entry.reverify_after)),
			load: async () => {
				if (!this.index) return { entries: [], next: null };
				return this.index.searchMemoryPage(search);
			},
		});
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

	async getGraph(graphId: string, surface = "unattributed") {
		return this.cache.getOrLoad({
			klass: "graph-view",
			surface,
			args: { graph_id: graphId },
			generations: [graphGenerationKey(graphId)],
			refreshAt: (graph) => earliestRefreshAt((graph?.nodes ?? []).map((node) => node.lease_expires_at)),
			load: async () => {
				if (!this.index) return null;
				const graph = await this.index.getGraph(graphId);
				return graph && withoutLeaseIds(graph);
			},
		});
	}

	/** One graph's generation, and the shared one every brief embeds. */
	private async bumpGraph(graphId: string): Promise<void> {
		await this.cache.bump(graphGenerationKey(graphId));
		await this.cache.bump(GRAPHS_GENERATION_KEY);
	}

	async registerGraph(plan: Parameters<IndexStore["registerGraph"]>[0]) {
		if (!this.index) throw new Error("graph_register requires SUBSTRATE_PG_URL");
		// Re-registering a graph whose nodes are held echoes them back, so this reply
		// is a reader's view as much as `graph_get` is.
		const graph = withoutLeaseIds(await this.index.registerGraph(plan));
		await this.bumpGraph(plan.graph_id);
		return graph;
	}

	/**
	 * Bind a swarm `correlation_id` to a Graph ID, or look a binding up either way.
	 *
	 * Both ids: an atomic insert-or-get on the unique `correlation_id`, answering with the
	 * stored winner. Only `correlation_id`: forward lookup. Only `graph_id`: reverse lookup.
	 *
	 * The index row is the lookup; the `note` event emitted on `created` is the record of
	 * the binding that the ledger will not let anyone rewrite. It is fail-open like every
	 * event — a ledger that is down costs the record, never the bind, and a bind that is
	 * already stored is not announced a second time.
	 */
	async bindGraph(request: { correlation_id?: unknown; graph_id?: unknown }, boundBy: Surface | null): Promise<BindOutcome> {
		const { correlation_id: correlationId, graph_id: graphId } = parseBindRequest(request);
		if (!this.index) throw new Error("graph_bind requires SUBSTRATE_PG_URL");

		if (correlationId !== undefined && graphId !== undefined) {
			const result = await this.index.bindCorrelation(correlationId, graphId, boundBy);
			if (result.status === "created") {
				await this.bumpGraph(result.graph_id);
				await this.emit({
					surface: boundBy ?? "claude-code",
					kind: "note",
					summary: `bound correlation ${correlationId} to ${result.graph_id}`,
					graph_id: result.graph_id,
					// Its own one-event session: a sessionless event has no chain to join, and
					// two bindings on one graph would otherwise share the "" bucket in `verifyGraph`.
					session_id: `bind:${result.graph_id}:${correlationId}`,
					actor: "agent",
					payload: { correlation_id: correlationId, bound_by: boundBy },
				}).catch(() => undefined);
			}
			return result;
		}
		if (correlationId !== undefined) {
			const stored = await this.index.graphForCorrelation(correlationId);
			return {
				status: stored === null ? "unbound" : "existing",
				correlation_id: correlationId,
				graph_id: stored,
			};
		}
		// parseBindRequest guarantees one of the two is present.
		const reverse = graphId as string;
		return { graph_id: reverse, correlation_ids: await this.index.correlationsForGraph(reverse) };
	}

	/**
	 * Propose a skill as a reviewable PR on the configured skills library. The one method
	 * the route, the MCP tool and the CLI all end in, and the only code that reaches git or
	 * `gh`.
	 *
	 * Authority comes before anything else. An anonymous caller is refused even on a run
	 * with no tokens, because a proposal spends the owner's GitHub credential. The proposal
	 * is attributed to the caller's token surface: a body that names a different surface is
	 * refused rather than re-attributed, since the branch, the PR title and the event all
	 * carry it. Replacing a skill's tree, reopening a declined proposal and allowing
	 * documentation examples are operator-only. Every refusal here happens before the
	 * proposer runs and emits nothing; the audit chain is the record of those.
	 *
	 * After that the outcome is recorded as one fail-open event: a `note` for an outcome,
	 * a `warning` carrying rule names only for a refusal, a `warning` carrying the redacted
	 * reason for a failed git or `gh` step. A `dry_run` emits nothing at all. An event that
	 * cannot be stored never changes the answer.
	 */
	async proposeSkill(
		request: SkillProposalRequest,
		caller: { surface: Surface | null; isOperator: boolean },
	): Promise<ProposeResult> {
		const surface = caller.surface;
		if (surface === null) {
			throw new SkillProposalDenied(401, "skills_propose needs an authenticated surface; nothing was proposed");
		}
		if (request.surface !== undefined && request.surface !== surface) {
			throw new SkillProposalDenied(
				403,
				`skills_propose proposes as the calling surface (${surface}), not ${JSON.stringify(String(request.surface).slice(0, 80))}; nothing was proposed`,
			);
		}
		const privileged = [
			...(request.mode === "replace" ? ["mode replace"] : []),
			...(request.reopen === true ? ["reopen"] : []),
			...((request.allow_doc_examples?.length ?? 0) > 0 ? ["allow_doc_examples"] : []),
		];
		if (privileged.length > 0 && !caller.isOperator) {
			throw new SkillProposalDenied(403, `${privileged.join(", ")} need an operator token; nothing was proposed`);
		}
		// Boot only warns. A non-default library that is not a local file remote, or one that
		// still points at the real `gh`, must not reach the proposer.
		if (this.config.skills.problem) {
			throw new ProposeFailed(`skill proposals are refused until the skills library is fixed: ${this.config.skills.problem}`);
		}

		const sessionId = normalizeIdentifier(request.session_id);
		const graphId = normalizeIdentifier(request.graph_id);
		const input: ProposeInput = {
			name: request.name,
			files: request.files,
			rationale: request.rationale,
			surface,
			...(request.remove !== undefined ? { remove: request.remove } : {}),
			...(sessionId !== null ? { session_id: sessionId } : {}),
			...(graphId !== null ? { graph_id: graphId } : {}),
		};
		const dryRun = request.dry_run === true;
		const where = {
			session_id: sessionId ?? `skills-propose:${randomUUID()}`,
			...(graphId !== null ? { graph_id: graphId } : {}),
		};
		const name = typeof request.name === "string" && SKILL_NAME_RE.test(request.name) ? request.name : undefined;
		try {
			const result = await this.skills.propose(input, {
				maxBytes: ROUTE_MAX_BYTES,
				mode: request.mode ?? "overlay",
				dryRun,
				reopen: request.reopen === true,
				allowDocExamples: new Set(request.allow_doc_examples ?? []),
			});
			if (!dryRun) {
				await this.emit({
					surface,
					kind: "note",
					summary: `proposed skill ${request.name}: ${result.status}`,
					repo: this.config.skills.repo,
					...where,
					payload: {
						action: "skill.propose",
						name: request.name,
						status: result.status,
						...(result.pr_url !== undefined ? { pr_url: result.pr_url } : {}),
						content_sha256: result.content_sha256,
						redactions: result.redactions.length,
					},
				}).catch(() => undefined);
			}
			return result;
		} catch (cause) {
			if (!dryRun && cause instanceof ProposeRefused) {
				// Rule names only: a finding's file and line are in the refusal the caller gets,
				// and a value or a span must never reach an append-only ledger.
				const rules = [...new Set((cause.findings ?? []).map((finding) => finding.rule))];
				const reason = redact(cause.message).slice(0, 300);
				await this.emit({
					surface,
					kind: "warning",
					summary: `refused skill proposal ${name ?? "(invalid name)"}: ${reason}`,
					...where,
					payload: { action: "skill.propose", status: "refused", ...(name ? { name } : {}), reason, rules },
				}).catch(() => undefined);
			} else if (!dryRun && cause instanceof ProposeFailed) {
				const reason = redact(cause.message).slice(0, 400);
				await this.emit({
					surface,
					kind: "warning",
					summary: `skill proposal ${name ?? "(invalid name)"} failed: ${reason}`,
					...where,
					payload: { action: "skill.propose", status: "failed", ...(name ? { name } : {}), reason },
				}).catch(() => undefined);
			}
			throw cause;
		}
	}

	/** Where a node's events belong: the graph's repo, not whatever the caller said. */
	private async placeOf(graphId: string): Promise<{ repo?: string; branch?: string }> {
		// A claim event without a repo is invisible to every repo-scoped brief, which
		// is exactly where a claim most needs to be seen.
		const graph = await this.index?.getGraph(graphId).catch(() => null);
		return { ...(graph?.repo ? { repo: graph.repo } : {}), ...(graph?.branch ? { branch: graph.branch } : {}) };
	}

	/**
	 * Take or extend the lease on a node, and stand by the hold only if it was recorded.
	 *
	 * The index decides — one statement, compare-and-swapped on the lease epoch,
	 * with expiry judged by Postgres' clock — so two agents asking at once cannot
	 * both be granted. What happens here is the *telling*: the lease and its
	 * holder go back to the caller, and the ledger gets an event for every change
	 * of hold, because a node quietly changing hands is how two agents come to
	 * disagree about who is doing what.
	 *
	 * A refused claim is not an error. The caller is told who holds the node and
	 * until when, which is what it needs in order to pick up something else — and
	 * not the holder's lease id, which would let it release the node instead.
	 *
	 * **Fail closed on the telling.** A change of hold whose event did not reach the
	 * ledger is withdrawn. `emit` deliberately fails open — a dropped event costs a
	 * line in the trail, and refusing the turn over it would mean a substrate outage
	 * blocking every prompt on the host — but a claim is not an event, it is a lock.
	 * The index is what keeps two agents from holding the same node; the ledger is how
	 * every *other* agent learns the node is taken, because the only place they read it
	 * is the brief, whose recent actions come from the ledger. A hold the ledger never
	 * took is one the substrate cannot tell anyone about, so handing it out would be
	 * worse than refusing it: the next agent would see an idle node and start the same
	 * work. A renewal is exempt — it emits nothing by design, so there is no news to
	 * lose.
	 *
	 * **Renewal is the holder's.** `caller` is the token's surface, null on an
	 * anonymous run. A claim that names the current holder renews its lease and
	 * returns its id, so it must come from the holder's own surface: any other
	 * token is refused `not-holder`, with nothing changed, no id and no event.
	 *
	 * See `decideClaim` in `@substrate/audit` and `docs/observability.md`.
	 */
	async claimNode(
		graphId: string,
		nodeId: string,
		surface: Surface,
		sessionId: string,
		caller: Surface | null,
		ttlSeconds?: number,
	): Promise<ClaimResult> {
		if (!this.index) throw new Error("graph_claim requires SUBSTRATE_PG_URL");
		const ttl = normalizeTtlSeconds(ttlSeconds, this.config.leaseTtlSeconds);
		const result = await this.index.claimNode(graphId, nodeId, surface, sessionId, caller, ttl);
		const { decision } = result;
		const identifier = result.node.linear_identifier;

		// Nothing emitted means nothing that could have been lost: a refused claim and a
		// silent renewal are both already consistent with what the ledger says.
		let recorded = true;
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
			const emitted = await this.emit({
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
				// The epoch, not the lease id: the ledger is readable by every agent, and
				// the id is the one thing in a lease that must reach only its holder.
				payload: {
					action: decision.action,
					lease_epoch: result.lease.epoch,
					ttl_seconds: ttl,
					expires_at: result.lease.expires_at,
					...(evicted ? { evicted } : {}),
				},
				...(await this.placeOf(graphId)),
			}).catch(() => null);
			recorded = emitted?.stored === true;
		}

		const verdict = decideClaim({
			claimed: result.claimed,
			recorded,
			requireRecorded: this.requireRecordedClaims,
		});

		// A `not-holder` refusal says so in the same word the fenced calls use.
		let reason = !result.claimed && decision.reason === "not-holder" ? "not-holder" : verdict.reason;
		if (verdict.decision === "revoked") {
			// Put the node back, so it is picked up rather than held by a surface that has
			// been told it does not have it.
			//
			// Fenced on the lease this claim was granted, which is what scopes the
			// withdrawal to *this* claim. The node can be released and re-claimed by
			// someone else between the grant and the failed append, and an unconditional
			// release would then clear that surface's live claim — breaking the mutual
			// exclusion this withdrawal exists to protect. The fence refusing it is not a
			// failure: the node is held by an agent that is working on it, and leaving it
			// alone is right.
			const outcome = await this.index
				.releaseNode(graphId, nodeId, { lease_id: result.lease.lease_id }, surface)
				.then((release) => (release.released ? "withdrawn" : "superseded"))
				.catch((cause: unknown) => {
					process.stderr.write(`[substrate] could not withdraw ${graphId}/${nodeId}: ${redact(String(cause))}\n`);
					return "failed";
				});
			// A release that itself fails is reported in the reason: the node then needs a
			// manual release, and saying so beats leaving the caller to find out by being
			// refused forever.
			if (outcome === "failed") reason = `${reason}; the index still holds the claim and needs a manual release`;
			if (outcome === "superseded") reason = `${reason}; another surface already holds it, so it was left alone`;
			process.stderr.write(`[substrate] claim ${graphId}/${nodeId} ${outcome} for ${surface} — ${reason}\n`);
		}

		this.observer.claimed?.({
			surface,
			graph_id: graphId,
			node_id: nodeId,
			decision: verdict.decision,
			action: decision.action,
			reason,
			quarantineReason: verdict.quarantineReason,
		});

		const granted = verdict.decision === "granted";
		if (result.claimed) await this.bumpGraph(graphId);
		return {
			claimed: granted,
			node: { ...result.node, lease_id: null },
			// The lease id goes back only with a hold that stands. On a withdrawal it
			// would name a hold that has just been dropped, and on a denial the index
			// has already left it out.
			lease: granted ? result.lease : { ...result.lease, lease_id: null },
			action: decision.action,
			evicted: decision.evicted ? `${decision.evicted.surface}/${decision.evicted.session_id}` : null,
			decision: verdict.decision,
			reason,
			ttl_seconds: granted ? ttl : null,
		};
	}

	/**
	 * Extend a lease. No event: a heartbeat is the absence of news.
	 *
	 * A refusal is worth acting on, though — it means the holder has lost the node
	 * — so it comes back with the reason and the current holder rather than as a
	 * bare false. `caller` is the token's surface, null on an anonymous run; a
	 * caller that is not the holder's surface is refused `not-holder`.
	 */
	async heartbeatNode(graphId: string, nodeId: string, leaseId: string, caller: Surface | null, ttlSeconds?: number) {
		if (!this.index) throw new Error("graph_heartbeat requires SUBSTRATE_PG_URL");
		const ttl = normalizeTtlSeconds(ttlSeconds, this.config.leaseTtlSeconds);
		const result = await this.index.heartbeatNode(graphId, nodeId, leaseId, caller, ttl);
		if (result.ok) await this.bumpGraph(graphId);
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
	 * node someone else has since claimed, and on `caller`, so a surface that is
	 * not the holder cannot release it even with the right id. A refusal names
	 * the real holder, never its id.
	 */
	async releaseNode(
		graphId: string,
		nodeId: string,
		request: { lease_id?: string | null; force?: boolean },
		caller: Surface | null,
		alsoSetState?: NodeState,
	) {
		if (!this.index) throw new Error("graph_release requires SUBSTRATE_PG_URL");
		const result = await this.index.releaseNode(graphId, nodeId, request, caller, alsoSetState);
		const { decision } = result;
		if (result.released && decision.ok && decision.action !== "noop") {
			// The holder comes from the decision, which was taken against the row
			// *before* it was cleared. Reading it off `result.node` would find null —
			// the release nulls those very columns — and attribute the note to nobody.
			const holder = decision.holder ?? decision.evicted;
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
				payload: {
					action: decision.action,
					lease_epoch: decision.observed_epoch,
					...(decision.evicted ? { evicted: decision.evicted } : {}),
				},
				...(await this.placeOf(graphId)),
			}).catch(() => undefined);
		}
		if (result.released && decision.ok && decision.action !== "noop") {
			await this.bumpGraph(graphId);
		}
		return {
			released: result.released,
			action: decision.ok ? decision.action : null,
			...(decision.ok ? {} : { reason: decision.reason, holder: decision.holder }),
			lease: leaseView(leaseSnapshot(result.node)),
		};
	}

	/**
	 * Mark a node complete and drop its lease, in one fenced operation.
	 *
	 * Two things have to hold at once, and getting either wrong closes a node
	 * somebody else is working on:
	 *
	 * - **One statement.** Releasing and then writing the state was two, and
	 *   between them another agent can claim the node that has just been freed —
	 *   whereupon the state write marks *their* live node completed. The index now
	 *   writes the state inside the same guarded UPDATE as the release.
	 * - **Ownership, not absence.** Releasing a node nobody holds succeeds as a
	 *   no-op, which is right for a release and wrong as a licence to complete:
	 *   it let any caller close any unheld node without ever holding it. A
	 *   completion needs a lease it actually held, or an explicit force.
	 */
	async completeNode(
		graphId: string,
		nodeId: string,
		request: { lease_id?: string | null; force?: boolean; state?: NodeState },
		caller: Surface | null,
	) {
		if (!this.index) throw new Error("graph_complete requires SUBSTRATE_PG_URL");
		const released = await this.releaseNode(graphId, nodeId, request, caller, request.state ?? "completed");
		if (!released.released) return { completed: false, ...released };
		if (released.action === "noop") {
			return {
				completed: false,
				...released,
				reason: "unheld" as const,
				detail: "nothing holds this node, so there is no lease to complete it under; claim it first",
			};
		}
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
		const graphIds = [...new Set(reaped.map((lease) => lease.graph_id))];
		for (const graphId of graphIds) await this.cache.bump(graphGenerationKey(graphId));
		if (graphIds.length > 0) await this.cache.bump(GRAPHS_GENERATION_KEY);
		for (const lease of reaped) {
			await this.emit({
				surface: lease.holder?.surface ?? "claude-code",
				kind: "warning",
				summary: `lease on ${lease.linear_identifier ?? lease.node_id} expired and was released${lease.holder ? ` (held by ${lease.holder.surface})` : ""}`,
				graph_id: lease.graph_id,
				node_id: lease.node_id,
				linear_identifier: lease.linear_identifier ?? undefined,
				...(lease.holder?.session_id ? { session_id: lease.holder.session_id } : {}),
				payload: { action: "expired", lease_epoch: lease.lease_epoch, expired_at: lease.expired_at, ...(lease.holder ? { evicted: lease.holder } : {}) },
				...(await this.placeOf(lease.graph_id)),
			}).catch(() => undefined);
		}
		return reaped;
	}

	// ── handoffs ───────────────────────────────────────────────────────────────

	/**
	 * Record a signed handoff packet.
	 *
	 * A signature turns attribution into a claim, so everything it covers that the
	 * substrate can know for itself, the substrate decides for itself:
	 *
	 * - **the sender.** `from.surface` is whatever the transport authenticated; the
	 *   caller cannot name another agent. Signing a body-supplied sender would let
	 *   any agent with a token mint a packet that verifies as if it came from
	 *   someone else, which is worse than no signature at all — a forgery with a
	 *   valid seal on it.
	 * - **the anchor.** `prev_event_hash` is read from the ledger, never taken from
	 *   the caller. A caller-supplied hash would be signed without anything
	 *   checking that it exists, and a receiver would get `ok: true` on a packet
	 *   pointing at a trail that never happened.
	 *
	 * Then order: the packet is built — redacted, capped, fitted — and only then
	 * signed, so the bytes signed are the bytes stored; and it is appended as a
	 * `handoff` event carrying the whole packet, which is what makes the handoff
	 * replayable from the ledger alone.
	 *
	 * The lease is released **after** the append, not before. Freeing the node
	 * first meant a refused append left the node claimable with no packet to
	 * replay: the next agent would find the work abandoned and no account of it.
	 *
	 * The reply says what is true rather than what was hoped for: `signed` is
	 * false when no key is configured, `stored` is false when the ledger would not
	 * take the event, `lease_released` reports the release that actually happened,
	 * and `gaps` names what a receiver will find missing.
	 */
	async handoff(
		input: Omit<HandoffInput, "prev_event_hash" | "from"> & {
			/** The authenticated sender. The transport supplies this, not the request body. */
			from: HandoffInput["from"];
			release_lease?: boolean;
		},
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
		// The sender's chain tip, read from the ledger. There is deliberately no way
		// for a caller to supply this.
		const prev = this.greptime && sessionId ? await this.greptime.lastHash(sessionId).catch(() => null) : null;

		const built = buildHandoff({
			...input,
			repo: input.repo ?? place.repo ?? null,
			branch: input.branch ?? place.branch ?? null,
			prev_event_hash: prev,
			handover_lease_id: input.handover_lease_id ?? null,
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

		// Only now, and only if the packet is durable. A release that ran first would
		// leave the node claimable with nothing in the ledger accounting for it, so
		// the next agent finds the work abandoned and no handoff to replay. Keeping
		// the hold on a failed append is the recoverable half of that trade: the
		// sender still holds its node and can retry.
		let leaseReleased: boolean | undefined;
		if (input.release_lease && input.handover_lease_id && input.graph_id && input.node_id) {
			if (!result.stored) {
				leaseReleased = false;
			} else {
				// Held to the sender, like any release. `from.surface` is the token's on an
				// authenticated deployment; on an anonymous one there is no identity to
				// hold anybody to, so nothing is checked, as for every other fenced call.
				const caller = this.config.allowAnonymous ? null : input.from.surface;
				const released = await this.releaseNode(
					input.graph_id,
					input.node_id,
					{ lease_id: input.handover_lease_id },
					caller,
				).catch(() => null);
				leaseReleased = released?.released === true;
			}
		}

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
		const limit = request.limit ?? 200;
		let events: DriftEvent[] = [];
		let ledgerOk = false;
		let eventsTruncated = false;
		if (this.greptime) {
			const rows = await this.greptime.recentForRepo(stored, limit).catch(() => null);
			if (rows) {
				ledgerOk = true;
				// A full window means its silence about anything proves nothing.
				eventsTruncated = rows.length >= limit;
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

		// And the other direction, asked of the whole ledger rather than of the
		// window: a busy repo pushes a well-logged commit out of the newest N events,
		// and inferring "unlogged" from that window's silence invents drift on exactly
		// the repos that have the most of it.
		let tipLogged: boolean | null = null;
		if (this.greptime && ledgerOk && git.sha) {
			const candidates = await this.greptime.commitEventsNaming(stored, git.sha).catch(() => null);
			// Seven hex characters can collide, so each candidate is confirmed against
			// the sha actually asked about rather than trusted from the LIKE.
			tipLogged =
				candidates === null
					? null
					: candidates.some((row) => {
							let payload: Record<string, unknown> = {};
							try {
								payload = row.payload ? (JSON.parse(String(row.payload)) as Record<string, unknown>) : {};
							} catch {
								payload = {};
							}
							const sha = extractCommitSha(String(row.summary ?? ""), payload);
							return shaMatches(sha, git.sha) || shaMatches(sha, git.short_sha);
						});
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
			tip_logged: tipLogged,
			events_truncated: eventsTruncated,
			sources: { git: git.sha !== null, ledger: ledgerOk, index: indexOk },
		});
	}

	/**
	 * Digest one closed UTC hour of the ledger in ingest order, for the hourly anchor.
	 *
	 * The hour is named by its start in epoch milliseconds, which must be a whole UTC
	 * hour, and it must have been closed for the ingest lag: asking earlier would hash a
	 * set of events that can still grow, and the root would differ when recomputed. Both
	 * refusals throw, as on the write path, because they are a caller's bug and must not
	 * read as an empty hour. `now` is injectable so a test can pick the clock.
	 *
	 * Membership and order come from the ingest records (see `GreptimeClient.hourLeaves`);
	 * the root and the memo come from the pure functions in `@substrate/ledger`, so the
	 * same stored events always give the same digest, whatever order the server returned
	 * rows in. A member that cannot be hashed throws naming the event rather than
	 * returning a partial root. An hour with no members digests to a null root and memo.
	 */
	async hourDigest(periodStartMs: number, now: number = Date.now()): Promise<HourDigest> {
		if (
			!Number.isSafeInteger(periodStartMs) ||
			Number.isNaN(new Date(periodStartMs).getTime()) ||
			periodStartMs !== hourStart(periodStartMs)
		) {
			throw new InvalidEventError("period_start must be a whole UTC hour in epoch milliseconds");
		}
		if (!isClosed(periodStartMs, now, INGEST_LAG_MS)) {
			throw new InvalidEventError(`hour ${hourIso(periodStartMs)} is not closed yet`);
		}
		if (!this.greptime) throw new Error("GREPTIME_URL is not set");

		const leaves = await this.greptime.hourLeaves(periodStartMs);
		const digest = {
			period_start: hourIso(periodStartMs),
			period_end: hourIso(hourEnd(periodStartMs)),
			event_count: leaves.length,
			event_ids: leaves.map((leaf) => leaf.event_id),
		};
		if (leaves.length === 0) return { ...digest, root: null, memo: null };
		const root = merkleRootHex(leaves.map((leaf) => leaf.hash));
		return { ...digest, root, memo: formatMemo({ periodStartMs, rootHex: root, count: leaves.length }) };
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
		cache: CacheHealth;
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
			// In-memory counters only. Health does not ping Dragonfly and does not
			// change its status code when the cache is down.
			cache: this.cache.health(),
		};
	}
}
