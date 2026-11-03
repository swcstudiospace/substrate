/**
 * The session context digest (phase 67, live steering GA): what the other live sessions of one repository are doing.
 *
 * `session_context` (MCP tool) and `GET /session/context` answer a session that asks "who else is working here?" with one
 * bounded, redacted object built from five sources the server already holds: presence records, steering session states, graph
 * claims, recent ledger events (planning changes are among them) and handoff packets. Every item carries its `source` and its
 * `age_s`, so a reader can judge how much to trust a line; nothing in the digest is an instruction, and none of it grants
 * authority (directive authorship stays human, see `planning/steering-tools.ts`).
 *
 * This module is the pure assembly. The sources are injected as functions, so it reads no store, clock or environment of its
 * own, and the service builds them (`Substrate.sessionContext`). Rules, each pinned by a test:
 * - **Bounded.** At most {@link SESSION_CONTEXT_LIMITS} items per list and {@link SESSION_CONTEXT_MAX_BYTES} serialised. Past the
 *   byte cap the oldest events go first, then the oldest planning rows, handoffs, claims and sessions, so the cap always holds.
 *   `truncated` names every list that lost items, whether to its count bound, to the byte cap or to a cut before this module saw
 *   the list: a full ledger window (events and planning), a source that cut its own list, or the bound on the graphs asked about handoffs.
 * - **Redacted.** Every string passes `redact`, and a summary or goal is cut to {@link SESSION_CONTEXT_TEXT_MAX} characters.
 * - **Deterministic.** Newest first, ties broken by id then source, so equal inputs give equal bytes.
 * - **Degrading.** Each source fails alone: a source that is not configured, throws or misses the deadline gives an empty list
 *   and one line in `notes`, never an exception. The digest is still an answer.
 * - **Never the caller's own.** With `session_id`, that session's own presence, steering and ledger rows are left out.
 */
import { sharedDeadline } from "./deadline.ts";
import { normalizeKey, scopeRepoId } from "./event.ts";
import { SESSION_ID_RE } from "./planning/presence.ts";
import { redact } from "./redact.ts";

/** The most items each list carries. */
export const SESSION_CONTEXT_LIMITS = { sessions: 20, claims: 20, events: 30, handoffs: 10, planning: 10 } as const;
/** The serialised digest never exceeds this many bytes (UTF-8 JSON). */
export const SESSION_CONTEXT_MAX_BYTES = 24_000;
/** The longest event summary or handoff goal, in characters, after redaction. */
export const SESSION_CONTEXT_TEXT_MAX = 200;
/** The longest id, branch or path a field carries, in characters, after redaction. */
const FIELD_MAX = 200;
/** One deadline for every source read, so a stalled store costs this and not the sum of its reads. */
export const SESSION_CONTEXT_BUDGET_MS = 2_000;
/** The newest handoff packets read for one graph: a bounded, handoff-only window, never the graph's whole history. A full window may have left older packets behind. */
export const HANDOFF_READ_LIMIT = 10;
/** The most open graphs `IndexStore.openGraphs` returns. A full answer may have left more behind. */
export const OPEN_GRAPHS_READ_LIMIT = 10;
/** The typed reason a context request is refused while `SUBSTRATE_BRIEF_SESSIONS` is off: the sessions feature set is opt-in as a whole. */
export const SESSION_CONTEXT_DISABLED = "session-context.disabled";
export const SESSION_CONTEXT_DISABLED_MESSAGE = "session context is off (SUBSTRATE_BRIEF_SESSIONS)";

export type SessionContextList = keyof typeof SESSION_CONTEXT_LIMITS;

// ── what a source hands over ──────────────────────────────────────────────────

/** A list a source returned, and whether the source itself cut it before this module saw it. */
export interface SourceResult<T> {
	items: readonly T[];
	truncated?: boolean;
	/** A line for `notes` when the source answered only in part (some of its reads failed). Such a list is also `truncated`. */
	note?: string;
}

export interface PresenceRow {
	sessionId: string;
	worktree: string;
	branch: string;
	lastHeartbeatMs: number;
	/** `active` or `stale`, as the presence classifier judged it. */
	state: string;
}

export interface SteeringStateRow {
	surface: string;
	sessionId: string;
	state: string;
	updatedAtMs: number;
}

export interface ClaimRow {
	graphId: string;
	nodeId: string;
	holder: string;
	sessionId: string | null;
	/** ISO time the lease lapses, or null for a row claimed before leases existed. */
	leaseExpiresAt: string | null;
	/** When the node was claimed, in epoch ms, or null when unknown. */
	claimedAtMs: number | null;
}

/** One ledger row for the repository. `planningChanged` is the changed-path count of a `planning.changed` note, null for every other event. */
export interface LedgerRow {
	tsMs: number;
	surface: string;
	sessionId: string | null;
	kind: string;
	summary: string;
	planningChanged: number | null;
}

export interface HandoffRow {
	graphId: string;
	goal: string;
	createdAtMs: number;
	verified: boolean;
}

/**
 * The sources. `null` means "not configured here" (a note, not an error). Each read may reject; that is a note too.
 * `handoffs` is told which graphs to look at: the graphs the claims name plus the repository's open graphs.
 */
export interface SessionContextSources {
	presence: (() => Promise<SourceResult<PresenceRow>>) | null;
	steering: (() => Promise<SourceResult<SteeringStateRow>>) | null;
	claims: (() => Promise<SourceResult<ClaimRow>>) | null;
	ledger: (() => Promise<SourceResult<LedgerRow>>) | null;
	/** The ids of the repository's open graphs, so handoffs of graphs nobody holds still surface. */
	graphs: (() => Promise<SourceResult<string>>) | null;
	handoffs: ((graphIds: readonly string[]) => Promise<SourceResult<HandoffRow>>) | null;
}

// ── what the digest carries ───────────────────────────────────────────────────

export interface ContextSession {
	session_id: string;
	surface: string | null;
	worktree: string | null;
	branch: string | null;
	last_heartbeat: string | null;
	state: string | null;
	source: "presence" | "steering";
	age_s: number;
}

export interface ContextClaim {
	graph_id: string;
	node_id: string;
	holder: string;
	session_id: string | null;
	lease_expires_at: string | null;
	source: "graph";
	age_s: number;
}

export interface ContextEvent {
	ts: string;
	surface: string;
	session_id: string | null;
	kind: string;
	summary: string;
	source: "ledger";
	age_s: number;
}

export interface ContextHandoff {
	graph_id: string;
	goal: string;
	created_at: string;
	verified: boolean;
	source: "handoff";
	age_s: number;
}

export interface ContextPlanning {
	ts: string;
	repo: string;
	changed: number;
	source: "planning.changed";
	age_s: number;
}

export interface SessionContext {
	generated_at: string;
	repo_id: string;
	for_session: string | null;
	sessions: ContextSession[];
	claims: ContextClaim[];
	events: ContextEvent[];
	handoffs: ContextHandoff[];
	planning: ContextPlanning[];
	truncated: Record<SessionContextList, boolean>;
	/** One line per source that was not configured or did not answer. Empty when every source answered. */
	notes: string[];
}

export interface SessionContextRequest {
	/** The repository as the caller spelled it, which is how the ledger and the index store it. The session scope key is `scopeRepoId` of it. */
	repoId: string;
	/** The asking session. Its own rows are left out. */
	sessionId: string | null;
	/** A cap on every list, never above that list's own bound. */
	limit?: number | undefined;
}

export interface SessionContextOptions {
	nowMs: number;
	/** Test seam; defaults to {@link SESSION_CONTEXT_BUDGET_MS}. */
	budgetMs?: number;
}

// ── helpers ───────────────────────────────────────────────────────────────────

const clean = (text: string, max: number = FIELD_MAX): string => redact(text).slice(0, max);
const cleanOrNull = (text: string | null): string | null => (text === null ? null : clean(text));
const ageS = (nowMs: number, thenMs: number | null): number => (thenMs === null ? 0 : Math.max(0, Math.floor((nowMs - thenMs) / 1000)));
const isoOf = (ms: number): string => new Date(ms).toISOString();

function compare(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Newest first by `time`, then by the keys in order, so equal inputs sort alike whatever order the sources answered in. */
function newestFirst<T>(rows: readonly T[], time: (row: T) => number, ...keys: Array<(row: T) => string>): T[] {
	return [...rows].sort((a, b) => {
		const byTime = time(b) - time(a);
		if (byTime !== 0) return byTime;
		for (const key of keys) {
			const byKey = compare(key(a), key(b));
			if (byKey !== 0) return byKey;
		}
		return 0;
	});
}

type Read<T> = { ok: true; items: readonly T[]; truncated: boolean; note: string | null } | { ok: false; note: string };

/** One source read, alone: not configured, a rejection or a missed deadline is a note, never an exception. */
async function read<T>(name: string, source: (() => Promise<SourceResult<T>>) | null, race: <V>(promise: Promise<V>) => Promise<V>): Promise<Read<T>> {
	if (source === null) return { ok: false, note: `${name}: not configured` };
	try {
		const result = await race(source());
		return { ok: true, items: result.items, truncated: result.truncated === true, note: result.note ?? null };
	} catch {
		return { ok: false, note: `${name}: unavailable` };
	}
}

const bytesOf = (digest: SessionContext): number => new TextEncoder().encode(JSON.stringify(digest)).byteLength;

/** The drop order past the byte cap: the least current information goes first. */
const DROP_ORDER: readonly SessionContextList[] = ["events", "planning", "handoffs", "claims", "sessions"];

// ── assembly ──────────────────────────────────────────────────────────────────

/** Builds the digest from the sources. Never throws for a source's failure; the arguments are the caller's to validate. */
export async function assembleSessionContext(request: SessionContextRequest, sources: SessionContextSources, options: SessionContextOptions): Promise<SessionContext> {
	const { nowMs } = options;
	const repoScope = scopeRepoId(request.repoId);
	const own = request.sessionId;
	const cap = (list: SessionContextList): number => Math.min(SESSION_CONTEXT_LIMITS[list], request.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.trunc(request.limit)));
	const deadline = sharedDeadline(options.budgetMs ?? SESSION_CONTEXT_BUDGET_MS, "session context");
	const notes: string[] = [];
	const truncated: Record<SessionContextList, boolean> = { sessions: false, claims: false, events: false, handoffs: false, planning: false };
	try {
		const [presence, steering, claims, ledger, graphs] = await Promise.all([
			read("presence", sources.presence, deadline.race),
			read("steering", sources.steering, deadline.race),
			read("claims", sources.claims, deadline.race),
			read("ledger", sources.ledger, deadline.race),
			read("graphs", sources.graphs, deadline.race),
		]);
		for (const result of [presence, steering, claims, ledger, graphs]) {
			if (!result.ok) notes.push(result.note);
			else if (result.note !== null) notes.push(result.note);
		}

		// Handoffs are asked about the graphs the claims name and the repository's open graphs, bounded, in a fixed order. A graph
		// left out by that bound, or by a source that cut its own list, means the handoffs listed may not be all of them.
		const graphCandidates = [
			...new Set([
				...(claims.ok ? newestFirst(claims.items, (row) => row.claimedAtMs ?? 0, (row) => row.graphId, (row) => row.nodeId).map((row) => row.graphId) : []),
				...(graphs.ok ? [...graphs.items].sort(compare) : []),
			]),
		];
		const graphIds = graphCandidates.slice(0, SESSION_CONTEXT_LIMITS.handoffs);
		const graphsCut = graphCandidates.length > graphIds.length || (claims.ok && claims.truncated) || (graphs.ok && graphs.truncated);
		const handoffSource = sources.handoffs;
		const handoffs = await read("handoffs", handoffSource === null ? null : () => handoffSource(graphIds), deadline.race);
		if (!handoffs.ok) notes.push(handoffs.note);
		else if (handoffs.note !== null) notes.push(handoffs.note);

		// sessions: presence and steering, the caller's own left out.
		const sessionRows: ContextSession[] = [
			...(presence.ok ? presence.items.filter((row) => row.sessionId !== own).map(
				(row): ContextSession => ({
					session_id: clean(row.sessionId),
					surface: null,
					worktree: clean(row.worktree),
					branch: clean(row.branch),
					last_heartbeat: isoOf(row.lastHeartbeatMs),
					state: clean(row.state),
					source: "presence",
					age_s: ageS(nowMs, row.lastHeartbeatMs),
				}),
			) : []),
			...(steering.ok ? steering.items.filter((row) => row.sessionId !== own).map(
				(row): ContextSession => ({
					session_id: clean(row.sessionId),
					surface: clean(row.surface),
					worktree: null,
					branch: null,
					last_heartbeat: isoOf(row.updatedAtMs),
					state: clean(row.state),
					source: "steering",
					age_s: ageS(nowMs, row.updatedAtMs),
				}),
			) : []),
		];
		const sessionTime = (row: ContextSession): number => (row.last_heartbeat === null ? 0 : Date.parse(row.last_heartbeat));
		const sessionsSorted = newestFirst(sessionRows, sessionTime, (row) => row.session_id, (row) => row.source);
		const sessions = sessionsSorted.slice(0, cap("sessions"));
		truncated.sessions = sessionsSorted.length > sessions.length || (presence.ok && presence.truncated) || (steering.ok && steering.truncated);

		// claims: a lapsed lease is a free node, not a claim.
		const liveClaims = claims.ok ? claims.items.filter((row) => row.leaseExpiresAt === null || Date.parse(row.leaseExpiresAt) > nowMs) : [];
		const claimsSorted = newestFirst(liveClaims, (row) => row.claimedAtMs ?? 0, (row) => row.graphId, (row) => row.nodeId);
		const claimList = claimsSorted.slice(0, cap("claims")).map(
			(row): ContextClaim => ({
				graph_id: clean(row.graphId),
				node_id: clean(row.nodeId),
				holder: clean(row.holder),
				session_id: cleanOrNull(row.sessionId),
				lease_expires_at: row.leaseExpiresAt,
				source: "graph",
				age_s: ageS(nowMs, row.claimedAtMs),
			}),
		);
		truncated.claims = claimsSorted.length > claimList.length || (claims.ok && claims.truncated);

		// events and planning rows come from one ledger read.
		const ledgerRows = ledger.ok ? ledger.items.filter((row) => row.sessionId === null || row.sessionId !== own || row.planningChanged !== null) : [];
		const eventRows = newestFirst(ledgerRows.filter((row) => row.planningChanged === null), (row) => row.tsMs, (row) => row.surface, (row) => row.kind, (row) => row.summary);
		const events = eventRows.slice(0, cap("events")).map(
			(row): ContextEvent => ({
				ts: isoOf(row.tsMs),
				surface: clean(row.surface),
				session_id: cleanOrNull(row.sessionId),
				kind: clean(row.kind),
				summary: clean(row.summary, SESSION_CONTEXT_TEXT_MAX),
				source: "ledger",
				age_s: ageS(nowMs, row.tsMs),
			}),
		);
		truncated.events = eventRows.length > events.length || (ledger.ok && ledger.truncated);
		const planningRows = newestFirst(ledgerRows.filter((row) => row.planningChanged !== null), (row) => row.tsMs, (row) => row.surface, (row) => row.summary);
		const planning = planningRows.slice(0, cap("planning")).map(
			(row): ContextPlanning => ({
				ts: isoOf(row.tsMs),
				repo: clean(repoScope === "" ? request.repoId : repoScope),
				changed: row.planningChanged ?? 0,
				source: "planning.changed",
				age_s: ageS(nowMs, row.tsMs),
			}),
		);
		truncated.planning = planningRows.length > planning.length || (ledger.ok && ledger.truncated);

		const handoffRows = handoffs.ok ? newestFirst(handoffs.items, (row) => row.createdAtMs, (row) => row.graphId, (row) => row.goal) : [];
		const handoffList = handoffRows.slice(0, cap("handoffs")).map(
			(row): ContextHandoff => ({
				graph_id: clean(row.graphId),
				goal: clean(row.goal, SESSION_CONTEXT_TEXT_MAX),
				created_at: isoOf(row.createdAtMs),
				verified: row.verified,
				source: "handoff",
				age_s: ageS(nowMs, row.createdAtMs),
			}),
		);
		truncated.handoffs = handoffRows.length > handoffList.length || graphsCut || (handoffs.ok && handoffs.truncated);

		const digest: SessionContext = {
			generated_at: isoOf(nowMs),
			repo_id: clean(repoScope === "" ? request.repoId : repoScope),
			for_session: cleanOrNull(own),
			sessions,
			claims: claimList,
			events,
			handoffs: handoffList,
			planning,
			truncated,
			notes: notes.sort(compare),
		};
		return fitBytes(digest);
	} finally {
		deadline.clear();
	}
}

/** Drops the oldest items, list by list in {@link DROP_ORDER}, until the digest fits {@link SESSION_CONTEXT_MAX_BYTES}. */
function fitBytes(digest: SessionContext): SessionContext {
	for (const list of DROP_ORDER) {
		while (bytesOf(digest) > SESSION_CONTEXT_MAX_BYTES && digest[list].length > 0) {
			digest[list].pop();
			digest.truncated[list] = true;
		}
	}
	return digest;
}

// ── request parsing ───────────────────────────────────────────────────────────

export type ContextRequestParse = { ok: true; value: SessionContextRequest } | { ok: false; error: string };

/** The one place `repo_id`, `session_id` and `limit` are validated, so the tool and the route refuse the same inputs. */
export function parseSessionContextArgs(args: { repo_id?: unknown; session_id?: unknown; limit?: unknown }): ContextRequestParse {
	// The repository keeps the spelling the caller sent: the ledger and the index store a repository as it was written, so a
	// lower-cased copy would miss `Acme/Widgets`. Only the session scope key (`scopeRepoId`) is lower-case.
	const spelled = typeof args.repo_id === "string" ? args.repo_id.trim() : "";
	if (scopeRepoId(spelled) === "") return { ok: false, error: "repo_id is required and must be owner/name" };
	let sessionId: string | null = null;
	if (args.session_id !== undefined && args.session_id !== null && args.session_id !== "") {
		if (typeof args.session_id !== "string" || !SESSION_ID_RE.test(args.session_id)) return { ok: false, error: "session_id must be a session id" };
		sessionId = args.session_id;
	}
	let limit: number | undefined;
	if (args.limit !== undefined && args.limit !== null && args.limit !== "") {
		const parsed = typeof args.limit === "number" ? args.limit : typeof args.limit === "string" && /^\d{1,6}$/.test(args.limit) ? Number(args.limit) : Number.NaN;
		if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) return { ok: false, error: "limit must be a whole number from 1 to 100" };
		limit = parsed;
	}
	return { ok: true, value: { repoId: normalizeKey(spelled) ?? spelled, sessionId, limit } };
}

// ── ledger rows ───────────────────────────────────────────────────────────────

const PLANNING_LISTS = ["added", "removed", "changed"] as const;

/**
 * The number of paths a `planning.changed` note's payload reports (added, removed and changed, plus the paths its own
 * `truncated` counts left out), or null when the payload is not such a note. Reads the counts only, never a path or a hash.
 */
export function planningChangedCount(payload: unknown): number | null {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
	const fields = payload as Record<string, unknown>;
	if (fields.kind !== "planning.changed") return null;
	const omitted = fields.truncated !== null && typeof fields.truncated === "object" ? (fields.truncated as Record<string, unknown>) : {};
	let count = 0;
	for (const list of PLANNING_LISTS) {
		const paths = fields[list];
		if (Array.isArray(paths)) count += paths.length;
		const left = omitted[list];
		if (typeof left === "number" && Number.isSafeInteger(left) && left > 0) count += left;
	}
	return count;
}
