/**
 * The REST face of live steering (phase 67): the pure parts of `/steering/*`, so they test without a server.
 *
 * Each route mirrors a steering MCP tool and runs the same functions: `POST /steering/queue` is `queueSteering`,
 * `POST /steering/acknowledge` is `acknowledgeSteeringWithState`, `GET /steering/directives` is `steering_list`. This module
 * adds only what a route needs that a tool does not: query and body parsing with refusals that never echo a value, the
 * projection to the REST shapes (snake_case, ISO times), who may see which session, and the HTTP status of a typed result.
 *
 * Authorship does not change: the routes take no author field (an unknown field is a 400, like the tools' strict schemas), the
 * author is the bearer's surface, and a write needs an operator. Nothing here lets an agent queue a directive.
 */
import { scopeRepoId } from "../event.ts";
import { redact } from "../redact.ts";
import { SESSION_ID_RE } from "./presence.ts";
import type { SteeringSessionRegistry } from "./session-state.ts";
import { compareDirectives, type SteeringInbox, type SteeringRecord } from "./steering.ts";
import { sessionStateForAcknowledgement, type SteeringAcknowledgeReply } from "./steering-delivery.ts";
import { redactedSteeringSession } from "./steering-sessions-store.ts";
import { STEERING_ACKNOWLEDGE_INPUT, STEERING_QUEUE_INPUT, type SteeringAcknowledgeInput, type SteeringCaller, type SteeringQueueInput, type SteeringWiring, type SteeringWriteResult } from "./steering-tools.ts";

/** `GET /steering/sessions` lists at most this many sessions per call. */
export const STEERING_SESSIONS_LIMIT_MAX = 100;
export const STEERING_SESSIONS_LIMIT_DEFAULT = 50;

const DIRECTIVE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A session id the inbox accepts, used for a directive id that names no directive so the inbox answers `not-found`, not a shape error. */
const UNKNOWN_DIRECTIVE_SESSION = "unknown";

export type RestParse<T> = { ok: true; value: T } | { ok: false; error: string };

/** A whole number inside `[min, max]`, from a query value. Anything else (a sign, a fraction, an exponent, empty) is refused. */
function wholeNumber(raw: string, min: number, max: number): number | null {
	if (!/^\d{1,9}$/.test(raw)) return null;
	const value = Number(raw);
	return value >= min && value <= max ? value : null;
}

function requiredSession(params: URLSearchParams): RestParse<string> {
	const sessionId = params.get("session_id") ?? "";
	return SESSION_ID_RE.test(sessionId) ? { ok: true, value: sessionId } : { ok: false, error: "session_id is required and must be a session id" };
}

// ── GET /steering/sessions ─────────────────────────────────────────────────────

export interface RestSteeringSession {
	session_id: string;
	surface: string;
	repo_id: string;
	state: string;
	updated_at: string;
	planning_hash: string | null;
	steering: string | null;
	pending_directives: number;
}

export interface SessionsQuery {
	repoId: string | null;
	limit: number;
}

export function parseSessionsQuery(params: URLSearchParams): RestParse<SessionsQuery> {
	const repo = params.get("repo_id");
	const repoId = repo === null ? null : scopeRepoId(repo);
	if (repoId === "") return { ok: false, error: "repo_id must be owner/name" };
	const rawLimit = params.get("limit");
	const limit = rawLimit === null ? STEERING_SESSIONS_LIMIT_DEFAULT : wholeNumber(rawLimit, 1, STEERING_SESSIONS_LIMIT_MAX);
	if (limit === null) return { ok: false, error: `limit must be a whole number from 1 to ${STEERING_SESSIONS_LIMIT_MAX}` };
	return { ok: true, value: { repoId, limit } };
}

/**
 * The live steering sessions the caller may see, newest first: an operator's token sees every surface's sessions, any other
 * surface only its own. A read: it changes nothing. `truncated` says more matched than `limit`.
 */
export function listSteeringSessions(
	registry: Pick<SteeringSessionRegistry, "entries">,
	inbox: SteeringInbox | null,
	caller: SteeringCaller,
	query: SessionsQuery,
): { sessions: RestSteeringSession[]; truncated: boolean } {
	const visible = registry
		.entries()
		.filter((entry) => caller.isOperator || (caller.surface !== null && entry.surface === caller.surface))
		.filter((entry) => query.repoId === null || entry.session.repo_id === query.repoId)
		.sort(
			(a, b) =>
				(a.session.updated_at < b.session.updated_at ? 1 : a.session.updated_at > b.session.updated_at ? -1 : 0) ||
				(a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : 0) ||
				(a.session.session_id < b.session.session_id ? -1 : a.session.session_id > b.session.session_id ? 1 : 0),
		);
	const sessions = visible.slice(0, query.limit).map((entry): RestSteeringSession => {
		// The directions are caller-supplied text: they pass the redactor on the way out as they do on the way into the table.
		const session = redactedSteeringSession(entry.session);
		return {
			session_id: session.session_id,
			surface: entry.surface,
			repo_id: session.repo_id,
			state: session.state,
			updated_at: session.updated_at,
			planning_hash: session.planning_hash ?? null,
			steering: session.steering ?? null,
			pending_directives: inbox === null ? 0 : inbox.pendingFor(session.session_id).length,
		};
	});
	return { sessions, truncated: visible.length > query.limit };
}

// ── directives ────────────────────────────────────────────────────────────────

export interface RestDirective {
	id: string;
	session_id: string;
	action: string;
	body: string;
	priority: string;
	status: "queued" | "acknowledged";
	author: string;
	created_at: string;
	acknowledged_at: string | null;
	outcome: string | null;
	/** Present for an acknowledged directive whose outcome moves the session: the session may take a steering checkpoint. */
	checkpoint_hint: { trigger: string; directive_id: string } | null;
}

const isoOf = (ms: number): string => new Date(ms).toISOString();

/**
 * One inbox record as the REST shape. `checkpoint_hint` follows the acknowledgement's own mapping (`sessionStateForAcknowledgement`):
 * an applied pause or redirect moved the session, so a hint is named. The inbox does not remember whether the session's state
 * actually changed at acknowledgement time, so a directive applied to a session already in that state still names one; taking
 * the checkpoint is harmless.
 */
export function restDirective(record: SteeringRecord): RestDirective {
	const { directive } = record;
	const base = {
		id: directive.id,
		session_id: directive.targetSessionId,
		action: directive.action,
		body: redact(directive.body),
		priority: directive.priority,
		author: directive.author.principalId,
		created_at: isoOf(directive.createdAtMs),
	};
	if (record.state === "queued") return { ...base, status: "queued", acknowledged_at: null, outcome: null, checkpoint_hint: null };
	const moved = sessionStateForAcknowledgement({ action: directive.action, outcome: record.outcome, reason: record.reason ?? null }) !== null;
	return {
		...base,
		status: "acknowledged",
		acknowledged_at: isoOf(record.acknowledgedAtMs),
		outcome: record.outcome,
		checkpoint_hint: moved ? { trigger: "steering", directive_id: directive.id } : null,
	};
}

export const DIRECTIVE_STATUSES = ["queued", "acknowledged", "all"] as const;
export type DirectiveStatusFilter = (typeof DIRECTIVE_STATUSES)[number];

export interface DirectivesQuery {
	sessionId: string;
	status: DirectiveStatusFilter;
}

export function parseDirectivesQuery(params: URLSearchParams): RestParse<DirectivesQuery> {
	const session = requiredSession(params);
	if (!session.ok) return session;
	const status = params.get("status") ?? "all";
	if (!(DIRECTIVE_STATUSES as readonly string[]).includes(status)) return { ok: false, error: "status must be queued, acknowledged or all" };
	return { ok: true, value: { sessionId: session.value, status: status as DirectiveStatusFilter } };
}

/** The most acknowledged directives one `GET /steering/directives` reads back from the durable history for a session. */
export const STEERING_ACKNOWLEDGED_HISTORY_LIMIT = 100;

/** What the durable history added to a directives answer: its records, whether it could be read at all, and whether it was cut. */
export interface DurableAcknowledged {
	records: readonly SteeringRecord[];
	/** `memory-only`: no audit table, only the inbox can answer. `durable`: the history was read. `unavailable`: it was configured and the read failed. */
	history: "memory-only" | "durable" | "unavailable";
	truncated: boolean;
}

/** The directives for one session, highest priority first (the order `steering_list` uses). A read: it changes nothing. */
export function listRestDirectives(inbox: SteeringInbox, query: DirectivesQuery, durable: readonly SteeringRecord[] = []): RestDirective[] {
	const held = inbox.recordsFor(query.sessionId);
	// The inbox holds the live state of a directive it knows; the history adds only directives a restart left out of memory.
	const known = new Set(held.map((record) => record.directive.id));
	const merged = [...held, ...durable.filter((record) => record.directive.targetSessionId === query.sessionId && !known.has(record.directive.id))];
	return merged
		.sort((a, b) => compareDirectives(a.directive, b.directive))
		.filter((record) => query.status === "all" || record.state === query.status)
		.map(restDirective);
}

/** Why the steering inbox cannot answer, as the tools answer it: invalid settings are `misconfigured` (naming the keys, never the values), no audit sink is `not-configured`. */
export interface SteeringUnavailable {
	status: "misconfigured" | "not-configured";
	error: string;
	keys?: string[];
}

/** Null when the inbox can answer. The settings check comes first, like every steering tool. */
export function steeringUnavailable(wiring: SteeringWiring): SteeringUnavailable | null {
	if (wiring.settingsErrors.length > 0) {
		return { status: "misconfigured", error: "the steering settings are invalid", keys: wiring.settingsErrors.map((error) => error.key) };
	}
	if (wiring.inbox === null) return { status: "not-configured", error: "no steering audit sink is configured" };
	return null;
}

// ── POST bodies ───────────────────────────────────────────────────────────────

const QUEUE_FIELDS: readonly string[] = ["session_id", "action", "body", "priority"];
const ACKNOWLEDGE_FIELDS: readonly string[] = ["directive_id", "outcome", "confirm"];

function plainObject(body: unknown): Record<string, unknown> | null {
	return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** Names the first field a body carries that the route does not take. An author field, for one, is refused here, by name only. */
function unknownField(body: Record<string, unknown>, allowed: readonly string[]): string | null {
	const extra = Object.keys(body).find((key) => !allowed.includes(key));
	return extra === undefined ? null : extra.slice(0, 40);
}

/** Field paths of a failed parse, never the values: a body may carry text that is secret-shaped. */
function issuePaths(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): string {
	return [...new Set(issues.map((issue) => issue.path.map(String).join(".") || "body"))].join(", ");
}

/** `{ session_id, action, body, priority? }` as the `steering_queue` input. The route has no author or plan fields, and a directive it queues does not claim to conflict with the active plan. */
export function parseQueueBody(body: unknown): RestParse<SteeringQueueInput> {
	const fields = plainObject(body);
	if (fields === null) return { ok: false, error: "request body must be a JSON object" };
	const extra = unknownField(fields, QUEUE_FIELDS);
	if (extra !== null) return { ok: false, error: `unknown field: ${extra}` };
	const parsed = STEERING_QUEUE_INPUT.safeParse({
		target_session_id: fields.session_id,
		action: fields.action,
		priority: fields.priority ?? "normal",
		body: fields.body,
		conflicts_with_active_plan: false,
	});
	return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: `invalid ${issuePaths(parsed.error.issues).replace("target_session_id", "session_id")}` };
}

/** `{ directive_id, outcome, confirm? }`. The session is the directive's own target, read from the inbox, so the caller names no session. */
export function parseAcknowledgeBody(body: unknown, inbox: SteeringInbox | null): RestParse<SteeringAcknowledgeInput> {
	const fields = plainObject(body);
	if (fields === null) return { ok: false, error: "request body must be a JSON object" };
	const extra = unknownField(fields, ACKNOWLEDGE_FIELDS);
	if (extra !== null) return { ok: false, error: `unknown field: ${extra}` };
	const directiveId = typeof fields.directive_id === "string" && DIRECTIVE_ID_RE.test(fields.directive_id) ? fields.directive_id : null;
	if (directiveId === null) return { ok: false, error: "invalid directive_id" };
	const target = inbox?.get(directiveId)?.directive.targetSessionId ?? UNKNOWN_DIRECTIVE_SESSION;
	const parsed = STEERING_ACKNOWLEDGE_INPUT.safeParse({
		directive_id: directiveId,
		session_id: target,
		outcome: fields.outcome,
		...(fields.confirm === undefined ? {} : { confirm: fields.confirm }),
	});
	return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: `invalid ${issuePaths(parsed.error.issues).replace("session_id", "directive_id")}` };
}

// ── GET /steering/wait ────────────────────────────────────────────────────────

export interface WaitQuery {
	sessionId: string;
	after: string | null;
	/** The wait this request gets: what the client asked for, held to the server's ceiling. The answer says it as `wait_ms`. */
	timeoutMs: number;
}

/** A requested wait is a whole number of at most fifteen digits, so a huge one is clamped to the ceiling and a non-number is still refused. */
const WAIT_REQUEST_RE = /^\d{1,15}$/;

/**
 * A requested wait above the ceiling is clamped to `maxMs`, never refused: a client that asks for a longer poll than this
 * server allows still gets one, and the answer names the wait it got. A request that is not a whole number of at least one is refused.
 */
export function parseWaitQuery(params: URLSearchParams, maxMs: number): RestParse<WaitQuery> {
	const session = requiredSession(params);
	if (!session.ok) return session;
	const after = params.get("after");
	if (after !== null && !DIRECTIVE_ID_RE.test(after)) return { ok: false, error: "after must be a directive id" };
	const rawTimeout = params.get("timeout_ms");
	if (rawTimeout === null) return { ok: true, value: { sessionId: session.value, after, timeoutMs: maxMs } };
	const requested = WAIT_REQUEST_RE.test(rawTimeout) ? Number(rawTimeout) : 0;
	if (requested < 1) return { ok: false, error: "timeout_ms must be a whole number of at least 1" };
	return { ok: true, value: { sessionId: session.value, after, timeoutMs: Math.min(requested, maxMs) } };
}

// ── statuses ──────────────────────────────────────────────────────────────────

/** The HTTP status of a steering write's typed result: 200 for an effect, otherwise the refusal's own class. */
export function steeringHttpStatus(result: SteeringWriteResult | SteeringAcknowledgeReply): number {
	switch (result.status) {
		case "queued":
		case "acknowledged":
			return 200;
		case "forbidden":
			return 403;
		case "misconfigured":
		case "not-configured":
			return 503;
		case "refused":
			switch (result.error.code) {
				case "principal-not-allowed":
				case "agent-author-refused":
					return 403;
				case "not-found":
					return 404;
				case "duplicate-directive":
				case "wrong-session":
				case "already-acknowledged":
				case "confirmation-required":
					return 409;
				case "rate-limited":
					return 429;
				case "audit-unavailable":
					return 503;
				case "invalid-directive":
				case "invalid-acknowledgement":
					return 400;
			}
	}
}

/** `Retry-After` in whole seconds for a rate-limited refusal, else null. */
export function steeringRetryAfterS(result: SteeringWriteResult | SteeringAcknowledgeReply): number | null {
	return result.status === "refused" && result.error.code === "rate-limited" ? Math.max(1, Math.ceil(result.error.retryAfterMs / 1000)) : null;
}
