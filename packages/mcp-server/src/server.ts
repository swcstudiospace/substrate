/**
 * HTTP surface for substrate-mcp.
 *
 *   POST /mcp           MCP over streamable HTTP, for agents
 *   POST /brief         the same briefing as plain text, for hooks
 *   POST /events        append an event, for hooks
 *   POST /events/query  read a window of the ledger
 *   POST /memory        write a memory entry through the governance gate
 *   POST /skills/propose propose a skill as a reviewable PR on the skills library
 *   POST /verify        recompute a graph's hash chain
 *   POST /evidence      the per-graph evidence bundle, as JSON or HTML
 *   GET  /healthz       store reachability, and whether events can actually be written
 *   GET  /metrics       the OTLP metric snapshot this process holds
 *   GET  /slo           the SLO verdicts computed from it
 *
 * Hooks get REST because a hook process cannot call an MCP tool — it has no
 * client. Both paths run the same service code.
 *
 * Every request is one server span and one latency observation, and every tool call
 * passes the MCP audit gate *before* it is dispatched — see `observe.ts`. That holds
 * for both transports: every route that reaches the service goes through `auditedRest`
 * under the same tool name and the same audit mode its MCP equivalent has, and a
 * fail-closed route whose record the chain refuses is answered 503 rather than served.
 * Only `/healthz`, `/metrics` and `/slo` are exempt, and no agent action is behind them.
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { auditMode } from "@substrate/audit";
import { classifyEventRefusal, type EventRefusalReason } from "@substrate/observability";
import {
	anonymousBridge,
	isOperator,
	surfaceForToken,
	tokenedSurfaces,
	unmappedBearer,
	type SubstrateConfig,
} from "./config.ts";
import { formatDrift } from "./drift.ts";
import { InvalidEventError } from "./event.ts";
import { InvalidHandoffError } from "./handoff.ts";
import { attributedSurface, createMcpServer, type McpCaller } from "./mcp.ts";
import {
	auditRefusal,
	auditToolCalls,
	buildGraphEvidence,
	normalizeRoute,
	renderEvidenceHtml,
	startRequestSpan,
	toolCallsIn,
	type Observability,
} from "./observe.ts";
import type { Substrate } from "./service.ts";
import { proposalBodyProblem, proposalFailure, toProposalRequest } from "./skills/request.ts";
import { EVENT_KINDS, SURFACES, type Surface } from "./types.ts";

/** One hour. Anonymous callers are logged once per window, not once per request. */
const ANONYMOUS_LOG_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Routes an anonymous caller can hit. Anything else folds through `normalizeRoute`,
 * so a scanner cannot mint a series per path on this counter either.
 */
const ANONYMOUS_ROUTES = new Set([
	"/brief",
	"/events",
	"/events/query",
	"/memory",
	"/handoff",
	"/drift",
	"/verify",
	"/healthz",
	"/mcp",
	"/metrics",
	"/slo",
	"/evidence",
]);

function anonymousRoute(pathname: string): string {
	return ANONYMOUS_ROUTES.has(pathname) ? pathname : normalizeRoute(pathname);
}

/** A claimed surface, bounded: a known surface, `none`, or `unrecognised`. */
function boundClaim(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) return "none";
	return (SURFACES as readonly string[]).includes(value) ? value : "unrecognised";
}

/** The surface a body tried to name, including an MCP tool argument. Null when it named none. */
function findClaim(body: unknown): string | null {
	if (!body || typeof body !== "object") return null;
	const record = body as Record<string, unknown>;
	if ("surface" in record) return boundClaim(record.surface);
	const params = record.params;
	if (!params || typeof params !== "object") return null;
	const args = (params as { arguments?: unknown }).arguments;
	if (!args || typeof args !== "object" || !("surface" in args)) return null;
	return boundClaim((args as { surface: unknown }).surface);
}

/**
 * What a refused event looked like, bounded so the log line carries no payload: a known
 * surface or kind verbatim, an unknown one as `unrecognised:<name>` only when the name is a
 * short slug (so the sender can be found), and `invalid` otherwise.
 */
export function refusalShape(body: unknown): { surface: string; kind: string } {
	const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
	const bound = (value: unknown, known: readonly string[]): string => {
		if (typeof value !== "string" || value.length === 0) return "none";
		if (known.includes(value)) return value;
		return /^[a-z0-9][a-z0-9._-]{0,39}$/.test(value) ? `unrecognised:${value}` : "unrecognised:invalid";
	};
	return { surface: bound(record.surface, SURFACES), kind: bound(record.kind, EVENT_KINDS) };
}

function rememberClaim(claim: { surface: string }, body: unknown): void {
	const found = findClaim(body);
	if (found !== null) claim.surface = found;
}

/**
 * One stderr line per hour naming which routes and surfaces still arrive without a token.
 *
 * The counts themselves are in `/metrics` immediately. The line is the thing an
 * operator grepping the unit log sees without scraping, and it carries no payload.
 */
export class AnonymousCallerLog {
	private readonly counts = new Map<string, number>();
	private windowStart: number;
	private readonly intervalMs: number;
	private readonly now: () => number;
	private readonly write: (line: string) => void;
	private readonly label: string;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(intervalMs?: number, now?: () => number, write?: (line: string) => void, label = "anonymous callers") {
		this.label = label;
		this.intervalMs = intervalMs ?? ANONYMOUS_LOG_INTERVAL_MS;
		this.now = now ?? Date.now;
		this.write = write ?? ((line) => process.stderr.write(line));
		this.windowStart = this.now();
	}

	/** Flush on the hour even when no later request arrives to notice it. */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			if (this.counts.size > 0 && this.now() - this.windowStart >= this.intervalMs) this.flush();
		}, this.intervalMs);
		this.timer.unref?.();
	}

	/** Drop the timer and write whatever this window still holds. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.flush();
	}

	record(route: string, claimedSurface: string): void {
		this.recordKey(`${route} claimed=${claimedSurface}`);
	}

	/** Write the window if it is over. Called on every request so a quiet route still flushes. */
	tick(): void {
		if (this.counts.size > 0 && this.now() - this.windowStart >= this.intervalMs) this.flush();
	}

	/** Count one occurrence of an already-bounded key. */
	recordKey(key: string): void {
		// A flood of distinct keys must not grow the map without limit.
		if (!this.counts.has(key) && this.counts.size >= MAX_LOG_KEYS) key = "other";
		this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
		if (this.now() - this.windowStart >= this.intervalMs) this.flush();
	}

	flush(): void {
		if (this.counts.size > 0) {
			const parts = [...this.counts.entries()]
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, count]) => `${key} ${count}`)
				.join(", ");
			this.write(`[substrate] ${this.label}: ${parts}\n`);
		}
		this.counts.clear();
		this.windowStart = this.now();
	}
}

export interface HttpServerOptions {
	now?: () => number;
	anonymousLog?: (line: string) => void;
	anonymousIntervalMs?: number;
	/** Where the hourly refused-event line goes. Defaults to stderr. */
	refusalLog?: (line: string) => void;
}

/** Distinct keys one hourly line may hold before the rest are counted as `other`. */
const MAX_LOG_KEYS = 50;

const MAX_BODY_BYTES = 1_000_000;

/**
 * A body over `MAX_BODY_BYTES`. Final for that body, so `/skills/propose` and
 * `/docs/ingest` answer it 413. Every other route still answers it with the
 * generic 500 it always has.
 */
export class BodyTooLargeError extends Error {
	constructor() {
		super("request body too large");
		this.name = "BodyTooLargeError";
	}
}

/** Why an anonymous proposal is refused, even on a run that allows anonymous callers. */
const PROPOSAL_NEEDS_SURFACE = "skills_propose needs an authenticated surface; nothing was proposed";

/**
 * The status `/healthz` answers with.
 *
 * A deployment that configured a ledger and cannot write to it is **not** healthy,
 * even while the brief still composes from the index: appends are fail-closed, so
 * every event is being dropped on the floor and a monitor watching only the status
 * code has to see that. Reporting it in the body alone would leave the one state
 * this hardening exists to catch looking like 200.
 *
 * A run with no `GREPTIME_URL` is a different thing — local dev, or a deployment
 * that deliberately has no ledger — and is judged on its remaining stores, as
 * before.
 */
export function healthStatus(
	health: { index: boolean; greptime: boolean; eventsWritable: boolean },
	ledgerConfigured: boolean,
): number {
	if (ledgerConfigured && !health.eventsWritable) return 503;
	return health.index || health.greptime ? 200 : 503;
}

/**
 * Who a memory write is attributed to, and therefore whose grants it gets.
 *
 * Only a token names a writer. `bodyWriter` is taken as a parameter so that
 * discarding it is a thing a test can assert rather than a line somebody has to
 * notice is missing.
 *
 * It used to be honoured on a deployment that configured no tokens, on the reasoning
 * that a local run has no token to beat. But "no tokens configured" is exactly the
 * state in which the 401 above is not applied, so that condition read: any anonymous
 * caller may name itself `hermes` and collect hermes's graph, repo and `agent:hermes`
 * grants. Default-deny that a request parameter defeats is not default-deny, and the
 * convenience is not worth the hole — `unknown` holds no grants, matches no wildcard,
 * and the denial's remedy says how to fix it.
 *
 * A local run that genuinely wants ungoverned memory says so out loud, with a grant
 * naming `unknown` in `SUBSTRATE_MEMORY_GRANTS` or a surface token in
 * `SUBSTRATE_TOKEN_<SURFACE>`.
 * Both are one line, and both leave a record of the decision.
 */
export function memoryWriter(surface: Surface | null, bodyWriter: unknown): string {
	return surface ?? "unknown";
}

/**
 * The status code for a governed memory write.
 *
 * Only a write that was accepted *and* read back gets a 2xx a caller may rely on;
 * an accepted-but-unverified write is 202, the same "taken, not confirmed" this
 * server already uses for an event. The refusals are distinguishable without
 * parsing the body, because a hook that can only see the status code still has to
 * be able to tell "you may not" from "the index is down".
 */
export function memoryWriteStatus(result: { outcome: string; reason: string; verified_persisted: boolean }): number {
	switch (result.outcome) {
		case "accepted":
			return result.verified_persisted ? 200 : 202;
		case "conflict":
			return 409;
		case "quarantined":
			return 422;
		default:
			// A store that is missing or refusing is an outage, not a policy decision, and
			// a monitor must not read it as "this agent lacks permission".
			return result.reason.startsWith("store.") ? 503 : 403;
	}
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
	res.writeHead(status, { "content-type": contentType });
	res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
	send(res, status, JSON.stringify(value), "application/json");
}

/** A surface named in a request body. Only ever trusted on an unauthenticated run. */
function bodySurface(body: Record<string, unknown>): Surface | null {
	return typeof body.surface === "string" ? (body.surface as Surface) : null;
}

/**
 * Audit a REST route the same way the MCP gate audits a tool call, and report a denial.
 *
 * Both transports are covered on purpose. If MCP tool calls were audited and the
 * equivalent REST route were not, `/events` would be an unaudited door to the same
 * action — the exact shape of hole the store lock exists to close, and one a hook
 * would walk through by design, since a hook cannot call an MCP tool.
 *
 * **The denial is returned, not swallowed.** This used to discard it, which made every
 * REST route effectively fail-open whatever its tool's audit mode said: an unwritable
 * audit file refused MCP `memory_write` and let the same write through `POST /memory`,
 * so the fail-closed policy had a door beside it that was always unlocked. `auditedRest`
 * is the wrapper every route goes through, so honouring it is not a line a future route
 * has to remember.
 *
 * `/healthz`, `/metrics` and `/slo` are not audited: they are monitoring traffic, no
 * agent action is behind them, and a trail dominated by a Prometheus scrape is a
 * trail nobody reads.
 */
async function auditRest(
	observability: Observability,
	surface: Surface | null,
	tool: string,
	body: Record<string, unknown>,
): Promise<string | null> {
	const outcome = await auditToolCalls(observability, surface, [{ id: null, tool, args: body }], "rest").catch(
		(cause: unknown) => {
			// `auditToolCalls` turns an `AuditUnavailableError` into a denial itself, so
			// reaching here means something else threw — a body that overflows the argument
			// encoder, say, which a caller can produce with deep enough nesting inside the
			// body-size limit.
			//
			// **The tool's mode still decides.** Denying unconditionally made a fault in the
			// audit path able to refuse `/brief`, which is fail-open precisely so that the
			// substrate cannot fail an agent's turn — the audit becoming a new way to lose a
			// brief is the thing the mode exists to prevent. A fail-closed route is refused,
			// because there the unrecorded write is the worse outcome; a fail-open route is
			// served, with the fault on stderr where an operator sees it.
			process.stderr.write(`[substrate] audit of ${tool} failed unexpectedly: ${String(cause)}\n`);
			const refused = auditMode(tool) === "fail-closed";
			// The decision recorded is the decision taken. Counting a refused write as
			// `allowed` made the audit-failure metric disagree with what the caller was
			// answered, which is the one thing that metric exists to show.
			observability.instruments.recordAudit({ decision: refused ? "denied" : "allowed", written: false });
			return refused
				? { denials: new Map<string, string>([["null", `the MCP audit chain could not take the record for ${tool}`]]) }
				: { denials: new Map<string, string>() };
		},
	);
	return outcome.denials.get("null") ?? null;
}

/**
 * Audit a route, and answer the caller ourselves if the audit refuses.
 *
 * `true` means the handler may proceed. The 503 is deliberate: an audit sink that
 * cannot take the record is an outage of this substrate, not a permission decision
 * about the caller, and a hook reading only the status code must not learn "you may
 * not" from it. It matches the code `/events` already answers with when the ledger
 * will not take an append.
 */
async function auditedRest(
	res: ServerResponse,
	observability: Observability,
	surface: Surface | null,
	tool: string,
	body: Record<string, unknown>,
): Promise<boolean> {
	const denial = await auditRest(observability, surface, tool, body);
	if (denial === null) return true;
	sendJson(res, 503, { error: denial });
	return false;
}

export function createHttpServer(
	substrate: Substrate,
	config: SubstrateConfig,
	observability: Observability,
	options: HttpServerOptions = {},
) {
	const anonymousLog = new AnonymousCallerLog(options.anonymousIntervalMs, options.now, options.anonymousLog);
	anonymousLog.start();
	// Same hourly window. `/metrics` counts refusals by reason; this line says which
	// sender to fix (claimed surface, kind, tokened or not) without carrying a payload.
	const refusalLog = new AnonymousCallerLog(options.anonymousIntervalMs, options.now, options.refusalLog, "refused events");
	refusalLog.start();
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
		const authorization = req.headers.authorization ?? null;
		const surface: Surface | null = surfaceForToken(config, authorization);
		// What the transport establishes about the caller, before any request body is
		// read. A signed handoff's sender and a forced release's authority are decided
		// from this and never from an argument.
		const caller: McpCaller = {
			surface,
			isOperator: isOperator(config, authorization),
			// Only while the bridge is on. A bare local run keeps the MCP defaults.
			...(anonymousBridge(config) ? { tokenedSurfaces: tokenedSurfaces(config) } : {}),
		};
		const route = normalizeRoute(url.pathname);

		// Measured from `finish` rather than at each `send` call site: that way every
		// exit — a 401 below, a thrown handler, the MCP transport writing its own
		// response — lands in the histogram with the status the client actually saw.
		const started = performance.now();
		const span = startRequestSpan(observability, req, route, surface);
		// Set before the response is finished. `finish` reads both.
		let eventRefusal: EventRefusalReason | null = null;
		let eventShape: { surface: string; kind: string } = { surface: "none", kind: "none" };
		const claim = { surface: "none" };
		res.on("finish", () => {
			span.setAttribute("http.response.status_code", res.statusCode);
			if (res.statusCode >= 500) span.fail(`HTTP ${res.statusCode}`);
			span.end();
			observability.instruments.recordRequest({
				surface: surface ?? "unattributed",
				route,
				status: res.statusCode,
				durationMs: performance.now() - started,
			});
			refusalLog.tick();
			// POST only. A GET or a probe of the path is not a refused event post.
			if (req.method === "POST" && route === "/events" && eventRefusal) {
				observability.instruments.recordEventRefusal({ reason: eventRefusal });
				refusalLog.recordKey(
					`reason=${eventRefusal} status=${res.statusCode} caller=${surface ?? (authorization ? "unmapped-bearer" : "untokened")} surface=${eventShape.surface} kind=${eventShape.kind}`,
				);
			}
			// Accepted untokened callers only. A 401 was refused, not served anonymously.
			if (config.allowAnonymous && surface === null && res.statusCode !== 401) {
				const anonRoute = anonymousRoute(url.pathname);
				observability.instruments.recordAnonymous({ route: anonRoute, claimedSurface: claim.surface });
				anonymousLog.record(anonRoute, claim.surface);
			}
		});

		// A configured deployment requires a token that names a surface, unless
		// `SUBSTRATE_ALLOW_ANONYMOUS=1` is keeping untokened callers during migration.
		// Unset, a bare local run (no tokens) does not require one, otherwise the
		// operator is locked out of their own machine. `0` requires a bearer even then.
		//
		// Every authenticated caller therefore has a surface. That is deliberate and
		// load-bearing: a caller with none would reach the authoring routes with no
		// identity, and each of them falls back to the body — so an operator
		// credential could have signed a handoff as any agent it named. An operator
		// token is a *surface* token that is also listed in
		// SUBSTRATE_OPERATOR_TOKENS, so its extra authority never comes at the cost
		// of knowing who used it.
		// A bearer that names no surface is not an untokened caller. The bridge
		// accepts the absence of a token; this used to be 401 and still is.
		if (unmappedBearer(config, authorization) || (!config.allowAnonymous && surface === null)) {
			if (req.method === "POST" && url.pathname === "/events") eventRefusal = "auth";
			sendJson(res, 401, { error: "unknown or missing bearer token" });
			return;
		}

		try {
			if (req.method === "GET" && url.pathname === "/healthz") {
				const health = await substrate.health();
				sendJson(res, healthStatus(health, config.greptime !== null), {
					...health,
					// A deployment whose audit chain is in memory is one restart from having no
					// trail. That is a fact about the deployment, so it is reported — but it is
					// not a 503: the substrate is serving, and refusing would be worse.
					auditDurable: observability.audit.durable,
					auditRecords: observability.audit.seq,
					// Reported here as well as in every verification verdict, because a monitor is
					// what notices it: the audit file was deleted or truncated after records were
					// written to it, and nobody is going to ask `/evidence` about a graph until they
					// already have a reason to.
					...(observability.audit.missingHistory
						? { auditMissingHistory: observability.audit.missingHistory }
						: {}),
				});
				return;
			}

			if (req.method === "GET" && url.pathname === "/metrics") {
				// The snapshot this process holds, in the shape `otlp.ts` encodes. Served
				// whether or not a collector is configured, so an operator can read the same
				// numbers the SLOs are computed from without standing one up.
				sendJson(res, 200, { startedAt: new Date(observability.startedAt).toISOString(), metrics: observability.snapshot() });
				return;
			}

			if (req.method === "GET" && url.pathname === "/slo") {
				const results = observability.evaluate();
				// 200 either way. A breached objective is information, not a broken service,
				// and a monitor that read this as an outage would page on a slow hour.
				sendJson(res, 200, {
					results,
					breached: results.filter((result) => result.status === "breached").map((result) => result.id),
				});
				return;
			}

			if (req.method === "POST" && url.pathname === "/evidence") {
				const raw = await readBody(req);
				const body = raw ? (JSON.parse(raw) as { graph_id?: unknown; format?: unknown }) : {};
				rememberClaim(claim, body);
				if (typeof body.graph_id !== "string" || body.graph_id.length === 0) {
					sendJson(res, 400, { error: "graph_id is required" });
					return;
				}
				if (!(await auditedRest(res, observability, surface, "evidence", body))) return;
				const bundle = await buildGraphEvidence(observability, substrate, body.graph_id);
				if (body.format === "html") {
					send(res, 200, renderEvidenceHtml(bundle), "text/html; charset=utf-8");
					return;
				}
				sendJson(res, 200, bundle);
				return;
			}

			if (req.method === "POST" && url.pathname === "/brief") {
				const raw = await readBody(req);
				const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
				rememberClaim(claim, body);
				if (!(await auditedRest(res, observability, surface, "brief", body))) return;
				const brief = await substrate.brief({
					repo: typeof body.repo === "string" ? body.repo : undefined,
					branch: typeof body.branch === "string" ? body.branch : undefined,
					graph_id: typeof body.graph_id === "string" ? body.graph_id : undefined,
					surface: (typeof body.surface === "string" ? (body.surface as Surface) : null) ?? surface ?? "claude-code",
				});
				send(res, 200, brief, "text/markdown; charset=utf-8");
				return;
			}

			if (req.method === "POST" && url.pathname === "/events") {
				const raw = await readBody(req);
				const parsed: unknown = JSON.parse(raw);
				// `"graph_id" in 42` throws, and that throw used to become a 500.
				// A scalar or an array is the caller's mistake.
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
					eventRefusal = "validation";
					sendJson(res, 400, { error: "event must be an object" });
					return;
				}
				const body = parsed as Record<string, unknown>;
				eventShape = refusalShape(body);
				rememberClaim(claim, body);
				// A non-string graph id used to fall through to redaction and come back as a
				// 500 that echoed the throw. It is the caller's mistake, and it is its own
				// refusal reason so a bad id is not hidden inside validation.
				if ("graph_id" in body && body.graph_id != null && typeof body.graph_id !== "string") {
					eventRefusal = "graph_id";
					sendJson(res, 400, { error: "graph_id must be a string" });
					return;
				}
				if (!(await auditedRest(res, observability, surface, "events", body))) return;
				// A swarm token is its surface: naming another one is refused, not re-attributed.
				// Every other caller keeps the body-first attribution collectors rely on — see
				// `attributedSurface`. An untokened caller on the bridge may not use that to
				// name a surface that has a token, including the claude-code default when that
				// surface itself has one.
				const supplied = typeof body.surface === "string" ? body.surface : null;
				const attribution = attributedSurface(surface, supplied);
				if ("refused" in attribution) {
					eventRefusal = "attribution";
					sendJson(res, 403, { error: attribution.refused });
					return;
				}
				if (surface === null && anonymousBridge(config) && tokenedSurfaces(config).has(attribution.surface)) {
					eventRefusal = "attribution";
					sendJson(res, 403, { error: "an untokened caller cannot emit as a surface that has a token" });
					return;
				}
				const result = await substrate.emit({
					...(body as object),
					surface: attribution.surface,
				} as Parameters<Substrate["emit"]>[0]);
				// 503 when the ledger did not take it. The `substrate` CLI ignores the
				// status and exits 0 either way — failing open is the client's job, and
				// this surface owes its caller the truth about durability.
				sendJson(res, result.stored ? 202 : 503, {
					id: result.event.id,
					ts: result.event.ts,
					hash: result.event.hash,
					stored: result.stored,
					...(result.error ? { error: result.error } : {}),
					...(result.warning ? { warning: result.warning } : {}),
				});
				return;
			}

			// The read counterpart of `POST /events`, for callers that cannot speak MCP.
			// Same service call as the `events_query` tool, so the two cannot drift.
			if (req.method === "POST" && url.pathname === "/events/query") {
				const raw = await readBody(req);
				const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
				rememberClaim(claim, body);
				// A read, so fail-open — but recorded. `/events/query` was the one REST door
				// to a store that left no trace of who read it.
				if (!(await auditedRest(res, observability, surface, "events_query", body))) return;
				const result = await substrate.queryEvents(body as Parameters<Substrate["queryEvents"]>[0]);
				// An empty window is a real answer, so 200; 503 is the ledger not answering.
				sendJson(res, result.error ? 503 : 200, result);
				return;
			}

			if (req.method === "POST" && url.pathname === "/memory") {
				const raw = await readBody(req);
				const body = JSON.parse(raw) as Record<string, unknown>;
				rememberClaim(claim, body);
				// Audited as `memory_write`, the name the MCP tool is audited under, so one
				// action does not appear in the trail twice under two names. That tool is
				// fail-closed and this route is the same action: auditing the tool and not the
				// route meant an unwritable audit file refused `memory_write` over MCP and let
				// the identical write through here, so the policy had an unlocked door beside it.
				if (!(await auditedRest(res, observability, surface, "memory_write", body))) return;
				const result = await substrate.writeMemory({
					...(body as object),
					writer: memoryWriter(surface, body.writer),
				} as Parameters<Substrate["writeMemory"]>[0]);
				sendJson(res, memoryWriteStatus(result), result);
				return;
			}

			// Hooks get the coordination paths over REST for the same reason they get
			// the brief: a hook process has no MCP client. Same service code beneath.
			if (req.method === "POST" && url.pathname === "/handoff") {
				const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
				rememberClaim(claim, body);
				// `coord_handoff`, as MCP audits it, and fail-closed for the same reason: a
				// handoff transfers work and a lease to another agent, and one nobody recorded
				// is a transfer that cannot be reconstructed afterwards.
				if (!(await auditedRest(res, observability, surface, "coord_handoff", body))) return;
				const to = typeof body.to === "string" ? (body.to as Surface) : null;
				if (typeof body.goal !== "string" || !to) {
					sendJson(res, 400, { error: "handoff needs `goal` and `to`" });
					return;
				}
				// The sender is the token's surface, never the body's. A packet naming
				// another agent would verify under a false identity — a forgery with a
				// valid seal on it. The body is consulted only when *nothing* is
				// authenticated, and never merely because this particular token named
				// no surface.
				//
				// On the bridge that "nothing" is an untokened caller beside real tokens.
				// They may name a surface that has no token of its own. They may not name
				// one that does, and a missing name is not filled in with claude-code —
				// that default would be a privileged surface the moment claude-code has a
				// token, and it is the wrong sender even before then.
				const claimed = bodySurface(body);
				let sender: Surface | null = surface;
				if (sender === null && config.allowAnonymous) {
					if (anonymousBridge(config) && claimed !== null && tokenedSurfaces(config).has(claimed)) {
						sendJson(res, 403, {
							error: "an untokened caller cannot hand off as a surface that has a token",
						});
						return;
					}
					sender = claimed;
				}
				if (!sender) {
					sendJson(res, 403, {
						error: anonymousBridge(config)
							? "an untokened handoff must name its surface and cannot default to claude-code"
							: "this token names no surface, so it cannot be a handoff sender",
					});
					return;
				}
				const result = await substrate.handoff({
					from: { surface: sender, session_id: typeof body.session_id === "string" ? body.session_id : null },
					to: { surface: to, session_id: typeof body.to_session_id === "string" ? body.to_session_id : null },
					goal: body.goal,
					files: Array.isArray(body.files) ? (body.files as string[]) : undefined,
					dod: Array.isArray(body.dod) ? (body.dod as string[]) : undefined,
					blockers: Array.isArray(body.blockers) ? (body.blockers as string[]) : undefined,
					graph_id: typeof body.graph_id === "string" ? body.graph_id : null,
					node_id: typeof body.node_id === "string" ? body.node_id : null,
					linear_identifier: typeof body.linear_identifier === "string" ? body.linear_identifier : null,
					repo: typeof body.repo === "string" ? body.repo : null,
					branch: typeof body.branch === "string" ? body.branch : null,
					notes: typeof body.notes === "string" ? body.notes : null,
					handover_lease_id: typeof body.lease_id === "string" ? body.lease_id : null,
					release_lease: body.release_lease === true,
				});
				// 503 when the ledger did not take it, matching /events: the packet is
				// still returned, because an unstorable handoff is better handed to the
				// caller than lost, and the caller owes its user the truth either way.
				sendJson(res, result.stored ? 202 : 503, result);
				return;
			}

			if (req.method === "POST" && url.pathname === "/drift") {
				const raw = await readBody(req);
				const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
				rememberClaim(claim, body);
				if (typeof body.repo !== "string") {
					sendJson(res, 400, { error: "drift needs `repo`" });
					return;
				}
				if (!(await auditedRest(res, observability, surface, "drift", body))) return;
				const report = await substrate.driftScan({
					repo: body.repo,
					path: typeof body.path === "string" ? body.path : null,
					git_tip: typeof body.git_tip === "string" ? body.git_tip : null,
					branch: typeof body.branch === "string" ? body.branch : null,
					idle_seconds: typeof body.idle_seconds === "number" ? body.idle_seconds : undefined,
					limit: typeof body.limit === "number" ? body.limit : undefined,
				});
				if (body.format === "text") {
					send(res, 200, `${formatDrift(report)}\n`, "text/plain; charset=utf-8");
					return;
				}
				sendJson(res, 200, report);
				return;
			}

			if (req.method === "POST" && url.pathname === "/verify") {
				const raw = await readBody(req);
				const body = JSON.parse(raw) as { graph_id?: unknown };
				rememberClaim(claim, body);
				if (typeof body.graph_id !== "string") {
					sendJson(res, 400, { error: "graph_id is required" });
					return;
				}
				if (!(await auditedRest(res, observability, surface, "verify", body))) return;
				sendJson(res, 200, await substrate.verifyGraph(body.graph_id));
				return;
			}

			// A proposal spends the owner's GitHub credential, so an anonymous caller is refused
			// before the body is read, even on a run that otherwise allows untokened callers.
			if (req.method === "POST" && url.pathname === "/skills/propose") {
				if (surface === null) {
					sendJson(res, 401, { error: PROPOSAL_NEEDS_SURFACE });
					return;
				}
				const body = JSON.parse(await readBody(req)) as unknown;
				const fields = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
				// Audited under the tool's own name, fail-closed, before the field check and before any git work.
				// A parsed object that will be rejected (`mode: "merge"`) is still a proposal attempt.
				if (fields && !(await auditedRest(res, observability, surface, "skills_propose", fields))) return;
				const problem = proposalBodyProblem(body);
				if (problem) {
					sendJson(res, 400, { error: problem });
					return;
				}
				try {
					sendJson(res, 200, await substrate.proposeSkill(toProposalRequest(fields ?? {}), { surface, isOperator: caller.isOperator }));
				} catch (cause) {
					const failure = proposalFailure(cause);
					if (failure === null) throw cause;
					sendJson(res, failure.status, failure.body);
				}
				return;
			}

			// Docs search (D25-01..D25-06): always 200 — errors and refusals ride in
			// `reason`, never in the status (D25-03). Anonymous callers are answered
			// `unauthenticated` by the service with no RAGFlow call (D25-06).
			if (req.method === "POST" && url.pathname === "/docs/search") {
				const raw = await readBody(req);
				const parsed: unknown = raw ? JSON.parse(raw) : {};
				const body =
					parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
						? (parsed as Record<string, unknown>)
						: {};
				rememberClaim(claim, body);
				// Audited under the tool's own name, fail-open like the read it is.
				if (!(await auditedRest(res, observability, surface, "docs_search", body))) return;
				sendJson(
					res,
					200,
					await substrate.docsSearch(parsed, {
						surface,
						session_id: typeof body.session_id === "string" ? body.session_id : undefined,
					}),
				);
				return;
			}

			// Docs ingest (D25-07..D25-13): the writer rule closes the door before the
			// body is read — an anonymous caller is 401 even on a run that otherwise
			// allows untokened callers, as with /skills/propose.
			if (req.method === "POST" && url.pathname === "/docs/ingest") {
				if (surface === null) {
					sendJson(res, 401, { error: "docs_ingest needs an authenticated surface; nothing was ingested" });
					return;
				}
				const body = JSON.parse(await readBody(req)) as unknown;
				const fields =
					body !== null && typeof body === "object" && !Array.isArray(body)
						? (body as Record<string, unknown>)
						: null;
				// Audited under the tool's own name, fail-closed: an unrecorded write to
				// a dataset every agent reads is refused with 503, like the audit outage.
				if (fields && !(await auditedRest(res, observability, surface, "docs_ingest", fields))) return;
				const result = await substrate.docsIngest(body, {
					surface,
					isOperator: caller.isOperator,
					session_id: fields !== null && typeof fields.session_id === "string" ? fields.session_id : undefined,
				});
				sendJson(res, result.status, result.body);
				return;
			}

			if (url.pathname === "/mcp") {
				await handleMcp(req, res, substrate, caller, observability, claim);
				return;
			}

			sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
		} catch (cause) {
			if (
				cause instanceof BodyTooLargeError &&
				(url.pathname === "/skills/propose" || url.pathname === "/docs/ingest")
			) {
				sendJson(res, 413, { error: cause.message });
				return;
			}
			if (cause instanceof InvalidEventError || cause instanceof InvalidHandoffError) {
				if (req.method === "POST" && url.pathname === "/events" && cause instanceof InvalidEventError) {
					eventRefusal = classifyEventRefusal(400, cause.message) ?? "validation";
				}
				sendJson(res, 400, { error: cause.message });
				return;
			}
			if (cause instanceof SyntaxError) {
				if (req.method === "POST" && url.pathname === "/events") eventRefusal = "validation";
				sendJson(res, 400, { error: "request body is not valid JSON" });
				return;
			}
			const correlationId = randomUUID();
			process.stderr.write(
				`[substrate] ${req.method} ${url.pathname} correlation=${correlationId}: ${String(cause)}\n`,
			);
			if (!res.headersSent) sendJson(res, 500, { error: "internal error", correlation_id: correlationId });
		}
	});
	const close = server.close.bind(server);
	server.close = ((callback?: (err?: Error) => void) => {
		anonymousLog.stop();
		refusalLog.stop();
		// A request still in flight can finish after the timers stop. Flush once more when
		// the server has actually closed, so its count still reaches stderr.
		return close((err?: Error) => {
			anonymousLog.flush();
			refusalLog.flush();
			callback?.(err);
		});
	}) as typeof server.close;
	return server;
}

/**
 * Stateless MCP: a fresh server and transport per request. The substrate holds
 * no per-session state of its own — everything it knows lives in Postgres and
 * Greptime — so there is nothing for a long-lived session to protect.
 *
 * The audit gate runs here, between reading the body and connecting the transport.
 * Putting it in front of the dispatcher rather than inside each tool is what makes
 * "a fail-closed tool cannot run unaudited" structural instead of a rule every
 * future tool has to remember — the same reasoning as `assertAppendOnly` living in
 * the ledger client rather than at each call site.
 */
async function handleMcp(
	req: IncomingMessage,
	res: ServerResponse,
	substrate: Substrate,
	caller: McpCaller,
	observability: Observability,
	claim: { surface: string },
): Promise<void> {
	if (req.method !== "POST") {
		// Stateless mode has no server-initiated stream to attach to.
		res.writeHead(405, { allow: "POST" }).end();
		return;
	}
	const raw = await readBody(req);
	const body: unknown = raw ? JSON.parse(raw) : undefined;
	rememberClaim(claim, body);

	const { denials } = await auditToolCalls(observability, caller.surface, toolCallsIn(body));
	if (denials.size > 0) {
		// 200 with a JSON-RPC error, not an HTTP error: the request was well-formed and
		// the refusal is the answer to it, which is what an MCP client knows how to read.
		sendJson(res, 200, auditRefusal(body, denials));
		return;
	}

	const server = createMcpServer(substrate, caller);
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
	res.on("close", () => {
		void transport.close();
		void server.close();
	});
	await server.connect(transport);
	await transport.handleRequest(req, res, body);
}
