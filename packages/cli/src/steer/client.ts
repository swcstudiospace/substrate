/**
 * The client side of the Live Steering REST routes (v1.7, phase 67): `/steering/sessions`, `/steering/directives`,
 * `/steering/queue`, `/steering/acknowledge`, `/steering/wait` and `/session/context`.
 *
 * Every answer is untrusted JSON: it is parsed into `unknown` and narrowed by a guard, and an answer that is not JSON or
 * has the wrong shape is a `bad-response` failure that names what was missing, never a crash and never a cast.
 * Nothing here throws; a transport problem is a typed failure the caller maps to an exit code or to "try again".
 *
 * A 404 on a steering or context route means the server predates the feature or its flag is off, unless its body is the
 * typed `not-found` refusal for a session or directive: then the route exists but access to the resource is refused.
 * The message says which, because "not found" alone sends an operator looking for a typo. A 503 whose body is the typed
 * `misconfigured` or `not-configured` answer is the server saying steering is not set up, not a fault to retry: a write
 * reads it as a reply, a read reports it as a refusal. Typed bodies are recognised before the HTTP class is.
 */

import { plain } from "./plain.ts";
import { LIVE_SESSION_ID_PATTERN, SESSION_BINDING_PATTERN } from "./binding-record.ts";

/** The subset of `fetch` this client uses. Real `fetch` satisfies it. */
export type SteerFetch = (input: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<Response>;

export const STEER_ACTIONS = ["pause", "redirect", "annotate"] as const;
export type SteerAction = (typeof STEER_ACTIONS)[number];
export const STEER_PRIORITIES = ["low", "normal", "high"] as const;
export type SteerPriority = (typeof STEER_PRIORITIES)[number];
export const STEER_OUTCOMES = ["applied", "declined"] as const;
export type SteerOutcome = (typeof STEER_OUTCOMES)[number];
export const DIRECTIVE_STATUS_FILTERS = ["queued", "acknowledged", "all"] as const;
export type DirectiveStatusFilter = (typeof DIRECTIVE_STATUS_FILTERS)[number];

/** The session id grammar the server's registry accepts (a hook skips the steering routes for an id outside it). */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/**
 * The directive id (and `after` cursor) grammar of the server's routes. Copied from `DIRECTIVE_ID_RE` in
 * `packages/mcp-server/src/planning/steering-rest.ts`: the CLI never imports the server package.
 */
export const DIRECTIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The most sessions (or digest items per list) one request may ask for: `STEERING_SESSIONS_LIMIT_MAX` and the session context's own bound, both in `packages/mcp-server`. */
export const STEER_LIMIT_MAX = 100;

/** The most characters of a response body that is read; a bigger answer is not one of these routes' replies. */
export const MAX_RESPONSE_CHARS = 2_000_000;
/** Added to a long poll's wait so the client's own timeout never fires before the server's. */
export const WAIT_MARGIN_MS = 5_000;
export const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_DIAGNOSTIC_CHARS = 300;

export type SteerFailureCode = "unreachable" | "timeout" | "unauthorized" | "not-found" | "session-not-found" | "session-unavailable" | "refused" | "server-error" | "bad-response";

export interface SteerFailure {
	ok: false;
	code: SteerFailureCode;
	message: string;
	/** The HTTP status, when the server answered at all. */
	status?: number;
}

export type SteerResult<T> = { ok: true; value: T } | SteerFailure;

/** A time as the server writes it: an ISO string or epoch milliseconds. */
export type Timestamp = string | number;

export interface SteerSession {
	session_id: string;
	surface: string;
	repo_id: string;
	state: string;
	updated_at: Timestamp;
	expires_at?: Timestamp;
	planning_hash?: string | null;
	steering?: unknown;
	pending_directives?: number;
}

export interface SteerSessions {
	sessions: SteerSession[];
	truncated: boolean;
}

export interface SteerCheckpointHint {
	trigger: string;
	directive_id: string;
}

export interface SteerDirective {
	id: string;
	session_id: string;
	action: SteerAction;
	body: string;
	priority: SteerPriority;
	status: "queued" | "acknowledged";
	author: string;
	created_at: Timestamp;
	acknowledged_at: Timestamp | null;
	outcome: string | null;
	checkpoint_hint: SteerCheckpointHint | null;
}

/** One list of the digest: every item names where it came from and how old it is. */
export interface DigestItem {
	source: string;
	age_s: number;
	/** The rest of the item as the server wrote it. */
	fields: Record<string, unknown>;
}

export const DIGEST_LISTS = ["sessions", "claims", "events", "handoffs", "planning"] as const;
export type DigestList = (typeof DIGEST_LISTS)[number];

export interface ContextDigest {
	generated_at: Timestamp;
	repo_id: string;
	for_session: string | null;
	lists: Record<DigestList, DigestItem[]>;
	/** The names of the lists the server cut short. */
	truncated: string[];
	notes: string[];
}

/** The reply of a write: the tool's own `{ status, ... }`, kept whole, with the parts the CLI reads pulled out. */
export interface WriteReply {
	status: string;
	/** Public protocol projection for `--json`; never raw diagnostic fields. */
	raw: Record<string, unknown>;
	directive_id?: string;
	outcome?: SteerOutcome;
	reason?: string;
	/** `refused.error.code` when the server refused. */
	error_code?: string;
	checkpoint_hint?: SteerCheckpointHint;
	session_state?: unknown;
}

export interface SteerClientOptions {
	/** The server's base URL, without a trailing slash. */
	url: string;
	token?: string | undefined;
	timeoutMs?: number | undefined;
	fetch?: SteerFetch | undefined;
	/** Test seam: the abort signal of one request. Default `AbortSignal.timeout`. */
	signalFor?: ((timeoutMs: number) => AbortSignal) | undefined;
}

/** One long poll's answer: the directive, or `null` when the wait ended with none, and the wait the server actually applied when it said so. */
export interface SteerWait {
	directive: SteerDirective | null;
	/** The server's effective long-poll length (it clamps an oversized request): `wait_ms` of a 200, the `X-Steering-Wait-Ms` header of either answer. */
	waitMs?: number;
}

export interface IssuedSession {
	status: "issued";
	session_id: string;
	repo_id: string;
	state: string;
	updated_at: string;
	expires_at: string;
	session_binding: string;
}
export interface RenewedSession { status: "renewed"; session_id: string; expires_at: string }
export interface ClosedSession { status: "closed"; session_id: string; closed_at: string }

export interface SteerClient {
	open(request: { repoId: string; state?: "ACTIVE" }): Promise<SteerResult<IssuedSession>>;
	heartbeat(request: { sessionId: string; sessionBinding?: string | undefined }): Promise<SteerResult<RenewedSession>>;
	close(request: { sessionId: string; sessionBinding?: string | undefined }): Promise<SteerResult<ClosedSession>>;
	sessions(query: { repoId?: string | undefined; limit?: number | undefined }): Promise<SteerResult<SteerSessions>>;
	directives(query: { sessionId: string; status?: DirectiveStatusFilter | undefined; sessionBinding?: string | undefined }): Promise<SteerResult<SteerDirective[]>>;
	queue(request: { sessionId: string; action: SteerAction; body: string; priority?: SteerPriority | undefined; conflictsWithActivePlan?: boolean | undefined }): Promise<SteerResult<WriteReply>>;
	acknowledge(request: { directiveId: string; outcome: SteerOutcome; confirm?: boolean | undefined }): Promise<SteerResult<WriteReply>>;
	/** One long poll: the next directive after `after`, or `directive: null` when the server's wait ended with none (HTTP 204). */
	wait(query: { sessionId: string; after?: string | undefined; timeoutMs: number; requestBudgetMs?: number | undefined; sessionBinding?: string | undefined }): Promise<SteerResult<SteerWait>>;
	context(query: { repoId?: string | undefined; sessionId?: string | undefined; limit?: number | undefined }): Promise<SteerResult<ContextDigest>>;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
const isTimestamp = (value: unknown): value is Timestamp => (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value));
const isLifecycleTime = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	return typeof value === "string" ? allowed.find((candidate) => candidate === value) : undefined;
}

/** A reason, or `null` when the value is a directive hint. */
function parseHint(value: unknown): SteerCheckpointHint | null | undefined {
	if (value === null || value === undefined) return null;
	if (!isRec(value) || typeof value.trigger !== "string" || typeof value.directive_id !== "string" || value.directive_id.length === 0) return undefined;
	return { trigger: value.trigger, directive_id: value.directive_id };
}

/** A directive of the wire, or the name of the first field that is wrong. */
export function parseDirective(value: unknown): SteerDirective | string {
	if (!isRec(value)) return "directive is not an object";
	if (typeof value.id !== "string" || value.id.length === 0) return "directive.id";
	if (typeof value.session_id !== "string") return "directive.session_id";
	const action = oneOf(value.action, STEER_ACTIONS);
	if (action === undefined) return "directive.action";
	if (typeof value.body !== "string") return "directive.body";
	const priority = oneOf(value.priority, STEER_PRIORITIES);
	if (priority === undefined) return "directive.priority";
	const status = oneOf(value.status, ["queued", "acknowledged"] as const);
	if (status === undefined) return "directive.status";
	if (typeof value.author !== "string") return "directive.author";
	if (!isTimestamp(value.created_at)) return "directive.created_at";
	const acknowledgedAt = value.acknowledged_at ?? null;
	if (acknowledgedAt !== null && !isTimestamp(acknowledgedAt)) return "directive.acknowledged_at";
	const outcome = value.outcome ?? null;
	if (outcome !== null && typeof outcome !== "string") return "directive.outcome";
	const hint = parseHint(value.checkpoint_hint);
	if (hint === undefined) return "directive.checkpoint_hint";
	return {
		id: value.id,
		session_id: value.session_id,
		action,
		body: value.body,
		priority,
		status,
		author: value.author,
		created_at: value.created_at,
		acknowledged_at: acknowledgedAt,
		outcome,
		checkpoint_hint: hint,
	};
}

function parseDirectives(value: unknown): SteerDirective[] | string {
	if (!isRec(value) || !Array.isArray(value.directives)) return "directives";
	const out: SteerDirective[] = [];
	for (const entry of value.directives) {
		const directive = parseDirective(entry);
		if (typeof directive === "string") return directive;
		out.push(directive);
	}
	return out;
}

function parseSessions(value: unknown): SteerSessions | string {
	if (!isRec(value) || !Array.isArray(value.sessions)) return "sessions";
	if (typeof value.truncated !== "boolean") return "truncated";
	const sessions: SteerSession[] = [];
	for (const entry of value.sessions) {
		if (!isRec(entry)) return "session is not an object";
		if (typeof entry.session_id !== "string" || entry.session_id.length === 0) return "session.session_id";
		if (typeof entry.surface !== "string") return "session.surface";
		if (typeof entry.repo_id !== "string") return "session.repo_id";
		if (typeof entry.state !== "string") return "session.state";
		if (!isTimestamp(entry.updated_at)) return "session.updated_at";
		if (entry.planning_hash !== undefined && entry.planning_hash !== null && typeof entry.planning_hash !== "string") return "session.planning_hash";
		if (entry.pending_directives !== undefined && (typeof entry.pending_directives !== "number" || !Number.isInteger(entry.pending_directives) || entry.pending_directives < 0)) return "session.pending_directives";
		if (entry.expires_at !== undefined && !isTimestamp(entry.expires_at)) return "session.expires_at";
		sessions.push({
			session_id: entry.session_id, surface: entry.surface, repo_id: entry.repo_id, state: entry.state, updated_at: entry.updated_at,
			...(entry.expires_at === undefined ? {} : { expires_at: entry.expires_at }),
			...(entry.planning_hash === undefined ? {} : { planning_hash: entry.planning_hash as string | null }),
			...(entry.steering === undefined ? {} : { steering: entry.steering }),
			...(entry.pending_directives === undefined ? {} : { pending_directives: entry.pending_directives as number }),
		});
	}
	return { sessions, truncated: value.truncated };
}

function parseDigestList(value: unknown, name: string): DigestItem[] | string {
	if (!Array.isArray(value)) return name;
	const items: DigestItem[] = [];
	for (const entry of value) {
		if (!isRec(entry)) return `${name}[] is not an object`;
		if (typeof entry.source !== "string") return `${name}[].source`;
		if (typeof entry.age_s !== "number" || !Number.isFinite(entry.age_s) || entry.age_s < 0) return `${name}[].age_s`;
		// Everything but the two guaranteed keys is kept as the server wrote it.
		const fields: Record<string, unknown> = {};
		for (const [key, field] of Object.entries(entry)) if (key !== "source" && key !== "age_s") fields[key] = field;
		items.push({ source: entry.source, age_s: entry.age_s, fields });
	}
	return items;
}

export function parseContextDigest(value: unknown): ContextDigest | string {
	if (!isRec(value)) return "context is not an object";
	if (!isTimestamp(value.generated_at)) return "generated_at";
	if (typeof value.repo_id !== "string") return "repo_id";
	const forSession = value.for_session ?? null;
	if (forSession !== null && typeof forSession !== "string") return "for_session";
	const lists: Record<DigestList, DigestItem[]> = { sessions: [], claims: [], events: [], handoffs: [], planning: [] };
	for (const name of DIGEST_LISTS) {
		const items = parseDigestList(value[name], name);
		if (typeof items === "string") return items;
		lists[name] = items;
	}
	if (!isRec(value.truncated)) return "truncated";
	const truncated = Object.entries(value.truncated)
		.filter(([, cut]) => cut === true)
		.map(([name]) => name);
	if (!Array.isArray(value.notes) || value.notes.some((note) => typeof note !== "string")) return "notes";
	return { generated_at: value.generated_at, repo_id: value.repo_id, for_session: forSession, lists, truncated, notes: value.notes as string[] };
}

/** The statuses of a write's tool reply, and the fields each success status must carry. */
const WRITE_STATUSES = ["queued", "acknowledged", "forbidden", "refused", "misconfigured", "not-configured"] as const;

/**
 * The reply of `steering_queue` or `steering_acknowledge` over REST: an object whose `status` is one of the tool's own and
 * that carries the fields its status promises. `queued` without a directive id, or any unknown status, is a bad response:
 * a success the CLI cannot name must never print as one.
 */
export function parseWriteReply(value: unknown): WriteReply | string {
	if (!isRec(value)) return "reply is not an object";
	const status = oneOf(value.status, WRITE_STATUSES);
	if (status === undefined) return "status";
	const reply: WriteReply = { status, raw: { status } };
	if (value.directive_id !== undefined) {
		if (typeof value.directive_id !== "string" || !DIRECTIVE_ID_PATTERN.test(value.directive_id)) return "directive_id";
		reply.directive_id = value.directive_id;
	}
	if (status === "queued" && reply.directive_id === undefined) return "directive_id";
	if (status === "acknowledged") {
		if (reply.directive_id === undefined) return "directive_id";
		const outcome = oneOf(value.outcome, STEER_OUTCOMES);
		if (outcome === undefined) return "outcome";
		reply.outcome = outcome;
	}
	if (typeof value.reason === "string") reply.reason = value.reason === "operator-required" ? value.reason : "request-refused";
	if (status === "forbidden" && reply.reason === undefined) return "reason";
	if (isRec(value.error) && typeof value.error.code === "string") reply.error_code = [
		"not-found", "session-unavailable", "audit-unavailable", "rate-limited", "principal-not-allowed", "invalid-input", "confirmation-required", "conflict", "not-configured",
	].includes(value.error.code) ? value.error.code : "request-refused";
	if (status === "refused" && reply.error_code === undefined) return "error.code";
	if (status === "misconfigured" && !Array.isArray(value.errors)) return "errors";
	const hint = parseHint(value.checkpoint_hint);
	if (hint === undefined) return "checkpoint_hint";
	if (hint !== null) {
		if (hint.trigger !== "steering" || hint.directive_id !== reply.directive_id) return "checkpoint_hint";
		reply.checkpoint_hint = hint;
	}
	if (value.session_state !== undefined) {
		const state = value.session_state;
		if (!isRec(state) || !["unchanged", "applied", "refused"].includes(String(state.status))) return "session_state";
		if (state.status !== "unchanged" && !["ACTIVE", "CONTEXT_REFRESH", "PAUSED", "RESUMED"].includes(String(state.state))) return "session_state.state";
		reply.session_state = { status: state.status, ...(state.status === "unchanged" ? {} : { state: state.state }), ...(state.status === "refused" ? { reason: "transition-refused" } : {}) };
	}
	if (status === "queued" || status === "acknowledged") {
		reply.raw = { status, directive_id: reply.directive_id, ...(reply.outcome === undefined ? {} : { outcome: reply.outcome }),
			...(reply.checkpoint_hint === undefined ? {} : { checkpoint_hint: reply.checkpoint_hint }), ...(reply.session_state === undefined ? {} : { session_state: reply.session_state }) };
	} else {
		// Refusal bodies are untrusted diagnostics, not a place to echo headers, proofs or arbitrary server exceptions.
		reply.raw = { status, ...(reply.reason === undefined ? {} : { reason: reply.reason }), ...(reply.error_code === undefined ? {} : { error: { code: reply.error_code } }), ...(status === "misconfigured" ? { errors: [] } : {}) };
		delete reply.session_state;
		delete reply.checkpoint_hint;
		delete reply.directive_id;
	}
	return reply;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const TYPED_REFUSAL_STATUSES = ["forbidden", "refused", "misconfigured", "not-configured"] as const;

const NOT_FOUND_MESSAGE = "the server has no such route: it predates Live Steering, or the flag that enables it is off (docs/live-steering.md)";

const failure = (code: SteerFailureCode, message: string, status?: number): SteerFailure => ({ ok: false, code, message: plain(message, MAX_DIAGNOSTIC_CHARS), ...(status === undefined ? {} : { status }) });

/** The header a 204 carries to tell the effective long-poll length (a 200 carries `wait_ms` in its body). */
const WAIT_HEADER = "x-steering-wait-ms";

/** A whole, positive millisecond count from a header string or a JSON number; anything else is "the server did not say". */
function wholeMs(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" && /^[0-9]{1,9}$/.test(value) ? Number(value) : Number.NaN;
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** The uniform typed resource refusal, independent of request method. */
function isTypedNotFound(body: unknown): boolean {
	return isRec(body) && body.status === "refused" && isRec(body.error) && body.error.code === "not-found";
}

/** The tools' own answers that the server said no or is not set up for steering: `{ status: "misconfigured" | "not-configured" | "forbidden" | "refused", ... }`. */
function isTypedRefusal(body: unknown): boolean {
	return isRec(body) && oneOf(body.status, TYPED_REFUSAL_STATUSES) !== undefined;
}


interface Exchange {
	status: number;
	/** Absent on 204 and on an empty body. */
	body: unknown;
	/** The server's effective long-poll length from the `X-Steering-Wait-Ms` header, when it sent a usable one. */
	waitMs?: number;
}

export function createSteerClient(options: SteerClientOptions): SteerClient {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const doFetch: SteerFetch = options.fetch ?? ((input, init) => fetch(input, init));
	const signalFor = options.signalFor ?? ((ms: number) => AbortSignal.timeout(ms));
	const base = options.url.replace(/\/+$/, "");

	async function exchange(method: "GET" | "POST", path: string, params: Record<string, string | undefined>, body: unknown, requestTimeoutMs: number, passTypedRefusal = false, sessionBinding?: string): Promise<SteerResult<Exchange>> {
		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, value);
		const search = query.toString();
		const url = `${base}${path}${search.length > 0 ? `?${search}` : ""}`;
		let response: Response;
		try {
			response = await doFetch(url, {
				method,
				headers: {
					accept: "application/json",
					...(body === undefined ? {} : { "content-type": "application/json" }),
					...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
					...(sessionBinding === undefined ? {} : { "X-Substrate-Session-Binding": sessionBinding }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: signalFor(requestTimeoutMs),
			});
		} catch (cause) {
			const name = cause instanceof Error ? cause.name : "";
			if (name === "TimeoutError" || name === "AbortError") return failure("timeout", `the server did not answer within ${requestTimeoutMs} ms`);
			return failure("unreachable", "the configured server did not answer");
		}
		const status = response.status;
		if (status === 401) return failure("unauthorized", "the server refused the bearer token (HTTP 401); set SUBSTRATE_TOKEN", status);
		let text: string;
		try {
			text = await response.text();
		} catch (cause) {
			// The request's own limit cuts a body that is still arriving just as it cuts a connection that never answered.
			const name = cause instanceof Error ? cause.name : "";
			if (name === "TimeoutError" || name === "AbortError") return failure("timeout", `the server did not finish its answer within ${requestTimeoutMs} ms`, status);
			return failure("bad-response", "the response body could not be read", status);
		}
		if (text.length > MAX_RESPONSE_CHARS) return failure("bad-response", `the response is larger than ${MAX_RESPONSE_CHARS} characters`, status);
		let parsed: unknown;
		if (text.trim().length > 0) {
			try {
				parsed = JSON.parse(text);
			} catch {
				if (status === 404) return failure("not-found", NOT_FOUND_MESSAGE, status);
				if (status >= 500) return failure("server-error", `HTTP ${status}: the server could not complete the request`, status);
				return failure("bad-response", `HTTP ${status}: the server answered with a body that is not JSON`, status);
			}
		}
		if (status === 404 && isTypedNotFound(parsed)) return failure("session-not-found", "the requested session or directive was not found", status);
		if (status === 503 && isRec(parsed) && parsed.status === "refused" && isRec(parsed.error) && parsed.error.code === "session-unavailable") return failure("session-unavailable", "the session authority is unavailable", status);
		if (status === 404) return failure("not-found", NOT_FOUND_MESSAGE, status);
		if (status >= 500) {
			if (!isTypedRefusal(parsed)) return failure("server-error", `HTTP ${status}: the server could not complete the request`, status);
			if (!passTypedRefusal) return failure("refused", `HTTP ${status}: the server refused the request`, status);
		}
		const waitMs = wholeMs(response.headers.get(WAIT_HEADER));
		return { ok: true, value: { status, body: parsed, ...(waitMs === undefined ? {} : { waitMs }) } };
	}

	/** A read: HTTP 200 and a body the guard accepts. */
	async function read<T>(path: string, params: Record<string, string | undefined>, guard: (body: unknown) => T | string, requestTimeoutMs = timeoutMs, sessionBinding?: string): Promise<SteerResult<T>> {
		const result = await exchange("GET", path, params, undefined, requestTimeoutMs, false, sessionBinding);
		if (!result.ok) return result;
		const { status, body } = result.value;
		if (status !== 200) return failure("refused", `HTTP ${status}: the server refused the request`, status);
		const checked = guard(body);
		if (typeof checked === "string") return failure("bad-response", `the server answered 200 with a body that has no valid ${checked}`, status);
		return { ok: true, value: checked };
	}

	/** A write: any answer whose body is a tool reply, a typed refusal on a 503 included. The reply's `status` says whether it landed. */
	async function write(path: string, body: Record<string, unknown>): Promise<SteerResult<WriteReply>> {
		const result = await exchange("POST", path, {}, body, timeoutMs, true);
		if (!result.ok) return result;
		const checked = parseWriteReply(result.value.body);
		if (typeof checked === "string") {
			if (result.value.status !== 200) return failure("refused", `HTTP ${result.value.status}: the server refused the request`, result.value.status);
			return failure("bad-response", `the server answered with a reply that has no valid ${checked}`, result.value.status);
		}
		return { ok: true, value: checked };
	}

	async function lifecycle<T>(path: string, request: Record<string, unknown>, guard: (body: unknown) => T | undefined, sessionBinding?: string): Promise<SteerResult<T>> {
		const result = await exchange("POST", path, {}, request, timeoutMs, false, sessionBinding);
		if (!result.ok) return result;
		if (result.value.status !== 200) return failure("refused", `HTTP ${result.value.status}: the server refused the request`, result.value.status);
		const value = guard(result.value.body);
		return value === undefined ? failure("bad-response", "the server returned an invalid lifecycle reply", result.value.status) : { ok: true, value };
	}
	return {
		open: (request) => lifecycle("/steering/sessions", { repo_id: request.repoId, state: request.state ?? "ACTIVE" }, (body): IssuedSession | undefined => {
			if (!isRec(body) || body.status !== "issued" || typeof body.session_id !== "string" || !LIVE_SESSION_ID_PATTERN.test(body.session_id) || typeof body.session_binding !== "string" || !SESSION_BINDING_PATTERN.test(body.session_binding) ||
				typeof body.repo_id !== "string" || !/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(body.repo_id) || body.repo_id !== request.repoId.trim().toLowerCase() ||
				body.state !== (request.state ?? "ACTIVE") || !isLifecycleTime(body.updated_at) || !isLifecycleTime(body.expires_at)) return undefined;
			return { status: "issued", session_id: body.session_id, session_binding: body.session_binding, repo_id: body.repo_id, state: body.state, updated_at: body.updated_at, expires_at: body.expires_at };
		}),
		heartbeat: (request) => lifecycle("/steering/sessions/heartbeat", { session_id: request.sessionId }, (body): RenewedSession | undefined => {
			if (!isRec(body) || body.status !== "renewed" || body.session_id !== request.sessionId || !isLifecycleTime(body.expires_at)) return undefined;
			return { status: "renewed", session_id: request.sessionId, expires_at: body.expires_at };
		}, request.sessionBinding),
		close: (request) => lifecycle("/steering/sessions/close", { session_id: request.sessionId }, (body): ClosedSession | undefined => {
			if (!isRec(body) || body.status !== "closed" || body.session_id !== request.sessionId || !isLifecycleTime(body.closed_at)) return undefined;
			return { status: "closed", session_id: request.sessionId, closed_at: body.closed_at };
		}, request.sessionBinding),
		sessions: (query) =>
			read("/steering/sessions", { repo_id: query.repoId, limit: query.limit === undefined ? undefined : String(query.limit) }, parseSessions),
		directives: (query) => read("/steering/directives", { session_id: query.sessionId, status: query.status }, parseDirectives, timeoutMs, query.sessionBinding),
		queue: (request) =>
			write("/steering/queue", {
				session_id: request.sessionId,
				action: request.action,
				body: request.body,
				...(request.priority === undefined ? {} : { priority: request.priority }),
				...(request.conflictsWithActivePlan === undefined ? {} : { conflicts_with_active_plan: request.conflictsWithActivePlan }),
			}),
		acknowledge: (request) =>
			write("/steering/acknowledge", {
				directive_id: request.directiveId,
				outcome: request.outcome,
				...(request.confirm === undefined ? {} : { confirm: request.confirm }),
			}),
		wait: async (query) => {
			const longPollTimeoutMs = query.timeoutMs + WAIT_MARGIN_MS;
			const result = await exchange(
				"GET",
				"/steering/wait",
				{ session_id: query.sessionId, after: query.after, timeout_ms: String(query.timeoutMs) },
				undefined,
				// The caller's own budget caps the request, so a stalled connection cannot outlive the time the caller has left.
				query.requestBudgetMs === undefined ? longPollTimeoutMs : Math.max(1, Math.min(longPollTimeoutMs, query.requestBudgetMs)),
				false, query.sessionBinding,
			);
			if (!result.ok) return result;
			const { status, body, waitMs: headerMs } = result.value;
			if (status === 204) return { ok: true, value: { directive: null, ...(headerMs === undefined ? {} : { waitMs: headerMs }) } };
			if (status !== 200) return failure("refused", `HTTP ${status}: the server refused the request`, status);
			if (!isRec(body)) return failure("bad-response", "the wait answered 200 with a body that is not an object", status);
			const directive = parseDirective(body.directive);
			if (typeof directive === "string") return failure("bad-response", `the wait answered 200 with a body that has no valid ${directive}`, status);
			const waitMs = wholeMs(body.wait_ms) ?? headerMs;
			return { ok: true, value: { directive, ...(waitMs === undefined ? {} : { waitMs }) } };
		},
		context: (query) =>
			read("/session/context", { repo_id: query.repoId, session_id: query.sessionId, limit: query.limit === undefined ? undefined : String(query.limit) }, parseContextDigest),
	};
}
