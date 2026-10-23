/**
 * HTTP surface for substrate-mcp.
 *
 *   POST /mcp           MCP over streamable HTTP, for agents
 *   POST /brief         the same briefing as plain text, for hooks
 *   POST /events        append an event, for hooks
 *   POST /events/query  read a window of the ledger
 *   GET  /events/stream replay the ledger as Server-Sent Events, loopback only
 *   POST /memory        write a memory entry through the governance gate
 *   POST /skills/propose propose a skill as a reviewable PR on the skills library
 *   POST /skills/approve approve, decline or retire a skill pull request in the skills registry, operators only
 *   GET  /skills        the skills registry: approved skills by default, `?state=` for the rest (operators only)
 *   POST /verify        recompute a graph's hash chain
 *   POST /evidence      the per-graph evidence bundle, as JSON or HTML
 *   GET  /healthz       store reachability, whether events can actually be written, each plane's breaker, and the ledger jobs' coverage
 *   GET  /metrics       the OTLP metric snapshot this process holds (counters, histograms, registry gauges), plus the labelled docs gauges
 *   GET  /slo           the SLO verdicts computed from it, plus burn and per-plane availability
 *   GET  /slo/history   the durable metrics history behind /slo (uplift-4 S6), metered as a `read`, off unless the history is on
 *   GET  /livez         process liveness for the systemd watchdog: uptime and event-loop lag, no store I/O, local peers only
 *
 * Hooks get REST because a hook process cannot call an MCP tool — it has no
 * client. Both paths run the same service code.
 *
 * Every request is one server span and one latency observation, and every tool call
 * passes the MCP audit gate *before* it is dispatched — see `observe.ts`. That holds
 * for both transports: every route that reaches the service goes through `auditedRest`
 * under the same tool name and the same audit mode its MCP equivalent has, and a
 * fail-closed route whose record the chain refuses is answered 503 rather than served.
 * Only `/healthz`, `/metrics`, `/slo`, `/slo/history` and `/livez` are exempt, and no agent action is behind them.
 * `/slo/history` is served beside `/slo` under the same bearer rule (a token, unless `SUBSTRATE_ALLOW_ANONYMOUS=1`)
 * and is admission-metered as a `read` (`ROUTE_CLASSES`). `/livez` is also answered before the bearer check, to a peer that is this host only.
 *
 * Since uplift-3 N3 every other request also passes the admission budget of its
 * bearer's surface — after the 401, before the handler and before the audit —
 * so one surface's storm cannot spend another's brief budget. See `admission.ts`.
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { auditMode } from "@substrate/audit";
import {
	classifyEventRefusal,
	evaluateAdmissionSlo,
	evaluateDocsFreshnessSlo,
	type EventRefusalReason,
	FORECAST_HORIZON_MS,
	FORECAST_STEP_S,
	FORECAST_WINDOW,
	type ForecastDirection,
	forecastHistoryOff,
	type ForecastRow,
	forecastRow,
	loadBurnThresholds,
} from "@substrate/observability";
import {
	anonymousBridge,
	isOperator,
	surfaceForToken,
	tokenedSurfaces,
	unmappedBearer,
	type SubstrateConfig,
} from "./config.ts";
import { Admission, admitBatch, budgetBody, budgetRefusal, routeClass, type AdmissionVerdict } from "./admission.ts";
import type { EventBus } from "./event-bus.ts";
import { buildAgentCard, isKnownCardSurface } from "./agent-card.ts";
import { parseBriefProfile } from "./brief-profile.ts";
import { DATASET_TRIGGERS } from "./docs-datasets.ts";
import { freshnessGauges } from "./docs-freshness.ts";
import { scanIngestPages, readSkillsCheckoutPages, skillsCheckoutRoots, type IngestPage } from "./docs-ingest.ts";
import { formatDrift } from "./drift.ts";
import { IdempotencyRefusal, InvalidEventError } from "./event.ts";
import { checkoutHead } from "./git.ts";
import { type CursorPosition, type GreptimeClient } from "./greptime.ts";
import { InvalidHandoffError } from "./handoff.ts";
import {
	attributedSurface,
	augmentRagQuery,
	createMcpServer,
	getCachedRagResult,
	hindsightRagFallback,
	ingestRefusalIsGate,
	lightragReplayKey,
	queryLightragRest,
	ragGraphCounts,
	ragMachine,
	setCachedRagResult,
	surfaceClaimRefusal,
	type McpCaller,
	withLightragNotice,
} from "./mcp.ts";
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
import { MetricHistoryMemo, bucketedValues, metricHistoryAnswer } from "./metrics-history.ts";
import { redact } from "./redact.ts";
import type { Substrate } from "./service.ts";
import { proposalBodyProblem, proposalFailure, toProposalRequest } from "./skills/request.ts";
import { approvalBodyProblem, approvalFailure, toApprovalRequest } from "./skills/registry.ts";
import { EVENT_KINDS, SURFACES, type Surface } from "./types.ts";
import { isLocalPeer, livezBody, LoopLagMonitor } from "./watchdog.ts";
import { ragRetryDelay } from "./rag-retry.ts";

/** One hour. Anonymous callers are logged once per window, not once per request. */
const ANONYMOUS_LOG_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Routes an anonymous caller can hit. Anything else folds through `normalizeRoute`,
 * so a scanner cannot mint a series per path on this counter either.
 */
const ANONYMOUS_ROUTES = new Set([
	"/.well-known/agent-card.json",
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
	"/slo/history",
	"/livez",
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
	/** `/events/stream` poll interval; production uses `STREAM_POLL_MS`. */
	streamPollMs?: number;
	/** `/events/stream` idle close; production uses `STREAM_IDLE_MS`. */
	streamIdleMs?: number;
	/** `/events/stream` slow-consumer cap; production uses `STREAM_MAX_BACKLOG_BYTES`. */
	streamMaxBacklogBytes?: number;
	/** Directory the merge-trigger's local docs ingest scans; production runs from the repo root. */
	docsIngestBaseDir?: string;
}

/** Distinct keys one hourly line may hold before the rest are counted as `other`. */
const MAX_LOG_KEYS = 50;

const MAX_BODY_BYTES = 1_000_000;

/**
 * Room for the documented ingest call cap (5 MB of pages plus JSON
 * overhead). `/docs/ingest` and `/mcp` read with this; every other route
 * keeps the 1 MB cap. The MCP door serves loopback callers and the buffer
 * is transient, so the wider cap buys ingest without opening a new
 * amplification path.
 */
const DOCS_MAX_BODY_BYTES = 6_000_000;

/** How long a request may take to arrive: its headers, then the whole request. Bounds a slow client, not a response. */
const HEADERS_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;

/** Hostnames a loopback caller uses. The bound port is checked beside them. */
const LOOPBACK_HOSTNAMES: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true };

/** POST routes whose body is parsed as JSON. Any other media type is refused with 415. */
const JSON_BODY_ROUTES: Record<string, true> = {
	"/evidence": true,
	"/brief": true,
	"/events": true,
	"/events/query": true,
	"/memory": true,
	"/memory/recall": true,
	"/handoff": true,
	"/drift": true,
	"/verify": true,
	"/docs/search": true,
	"/docs/ingest": true,
	"/docs/merge-trigger": true,
	"/skills/propose": true,
	"/skills/approve": true,
	"/mcp": true,
};

/**
 * A body over the route's cap. Final for that body: the routes named in the
 * request handler's catch answer it 413. Every other route still answers it
 * with the generic 500 it always has.
 */
export class BodyTooLargeError extends Error {
	constructor() {
		super("request body too large");
		this.name = "BodyTooLargeError";
	}
}

/** Why an anonymous proposal is refused, even on a run that allows anonymous callers. */
const PROPOSAL_NEEDS_SURFACE = "skills_propose needs an authenticated surface; nothing was proposed";
/** Why an anonymous approval is refused, even on a run that allows anonymous callers. */
const APPROVAL_NEEDS_SURFACE = "skills_approve needs an authenticated surface; nothing was changed";
/** Why a non-operator approval is refused: the same words the service uses. */
const APPROVAL_NEEDS_OPERATOR = "skills_approve needs an operator token; nothing was changed";
/** Why an anonymous registry read is refused, even on a run that allows anonymous callers. */
const LIST_NEEDS_SURFACE = "skills_list needs an authenticated surface";
/** Why an anonymous ingest is refused, even on a run that allows anonymous callers. */
const INGEST_NEEDS_SURFACE = "docs_ingest needs an authenticated surface; nothing was ingested";
/** Why an anonymous merge-trigger is refused, even on a run that allows anonymous callers. */
const MERGE_TRIGGER_NEEDS_SURFACE = "docs merge-trigger needs an authenticated surface; nothing was refreshed";
/** The dataset a post-merge hook triggers when the body names none (DOCS-03's own repo row). */
const MERGE_TRIGGER_DATASET = "agent-substrate";

/**
 * A dataset's local checkout (phase 42): where its refresh reads pages, and how. `roots` is read when the
 * job runs, so a checkout that cannot be read fails that job alone. `pages` reads the files under those
 * roots; `head`, when present, reads the checkout's HEAD commit, which the job must match before it ingests.
 */
interface LocalIngestSource {
	roots: () => Promise<readonly string[]>;
	pages: (roots: readonly string[]) => Promise<IngestPage[]>;
	head?: () => Promise<string | null>;
}

/**
 * The local checkout a dataset's refresh reads (D42-3), or undefined when this server holds none.
 * `agent-substrate` reads the directory the server runs from with `config.docsIngestRoots`, as it always
 * has. `agent-skills` reads the checkout named by `SUBSTRATE_AGENT_SKILLS_ROOT`, fail-closed on an
 * unreadable skill and checked against the checkout's HEAD. Any other dataset gets a truthful noop: the
 * other rows name checkouts this server does not hold, and a recorded version over documents that were
 * never ingested would only lie to search.
 */
function localIngestSource(dataset: string, config: SubstrateConfig, agentSubstrateBaseDir: string): LocalIngestSource | undefined {
	if (dataset === MERGE_TRIGGER_DATASET) {
		const substrateRoots = config.docsIngestRoots;
		return { roots: async () => substrateRoots, pages: (roots) => scanIngestPages(agentSubstrateBaseDir, roots) };
	}
	const skillsCheckout = config.agentSkillsRoot;
	if (dataset === "agent-skills" && skillsCheckout !== null) {
		return {
			roots: () => skillsCheckoutRoots(skillsCheckout),
			pages: (roots) => readSkillsCheckoutPages(skillsCheckout, roots),
			head: async () => checkoutHead(skillsCheckout),
		};
	}
	return undefined;
}

/** Why an anonymous stream is refused, even on a run that allows anonymous callers. */
const STREAM_NEEDS_SURFACE = "events stream needs an authenticated surface; nothing was streamed";

/*
 * The bounds of one `/events/stream` connection. Deliberately constants, not
 * configuration: a poll interval a config file can crank down is a ledger load it
 * can silently multiply, and the bounds exist so a stream never costs more than
 * the polling it replaces. Tests inject smaller values through `HttpServerOptions`.
 */

/** How often one connection polls the ledger for rows after its cursor. */
export const STREAM_POLL_MS = 500;
/** Close a connection that has delivered nothing for this long; the client reconnects with Last-Event-ID and resumes. */
export const STREAM_IDLE_MS = 5 * 60_000;
/** Rows one poll may deliver: the ledger is the buffer, so no connection reads past this per tick. */
export const STREAM_BATCH = 200;
/** Unflushed bytes past which a slow consumer is cut off instead of buffered without limit. */
export const STREAM_MAX_BACKLOG_BYTES = 1_000_000;

/**
 * The refusals a `/events/stream` connection is answered with before anything
 * opens, in the order they are checked. The 401 is the same door decision
 * `/docs/merge-trigger` makes: an unauthenticated caller is refused even on a run
 * that allows anonymous callers, because a stream is a standing read of the whole
 * trail and no bridge run should hand that to whoever can reach the port. Only
 * then the loopback check, for the same reason the merge-trigger is loopback-only.
 * Null when the connection may proceed.
 */
export function streamRefusal(
	surface: Surface | null,
	remoteAddress: string | undefined,
): { status: number; error: string } | null {
	if (surface === null) return { status: 401, error: STREAM_NEEDS_SURFACE };
	if (!isLoopbackRemote(remoteAddress)) {
		return { status: 403, error: "events stream is a loopback route; the caller is not loopback" };
	}
	return null;
}

/**
 * Whether the request arrived over the loopback interface.
 *
 * The whole 127/8 in every notation (`::ffff:`-mapped IPv6 included) plus
 * `::1` — the same loopback set `parseRedisUrl` refuses plaintext redis
 * outside of. Node writes IPv4 remotes as a dotted quad and IPv6 remotes
 * either bare or v4-mapped; a DNS name never appears in `remoteAddress`.
 */
/** Set by the public nginx vhost only. Local clients never send it, so the anonymous bridge stays on loopback. */
export const PUBLIC_EDGE_HEADER = "x-substrate-edge";

/**
 * A request that arrived through the public edge without a surface token.
 * `GET /healthz` stays open: it carries no lesson or session content.
 * Every other route needs a bearer even while `SUBSTRATE_ALLOW_ANONYMOUS=1`.
 */
export function publicEdgeNeedsBearer(
	edgeHeader: string | string[] | undefined,
	method: string | undefined,
	pathname: string,
	surface: Surface | null,
): boolean {
	const edge = Array.isArray(edgeHeader) ? edgeHeader[0] : edgeHeader;
	if (edge !== "public" || surface !== null) return false;
	return !((method ?? "GET") === "GET" && pathname === "/healthz");
}

export function isLoopbackRemote(remoteAddress: string | undefined): boolean {
	const address = (remoteAddress ?? "").toLowerCase().replace(/^::ffff:/, "");
	if (address === "::1") return true;
	const octets = address.split(".");
	return octets.length === 4 && octets[0] === "127" && octets.slice(1).every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

/** The configured public origin as a URL, or null when it does not parse. */
function parsePublicOrigin(value: string): URL | null {
	try {
		return new URL(value);
	} catch {
		return null;
	}
}

/**
 * Whether a Host header names this listener: loopback on the bound port, or the public origin's host.
 * Throws on a malformed authority, which the caller answers 400.
 */
function hostAllowed(hostHeader: string, boundPort: number, publicOrigin: URL | null): boolean {
	const authority = new URL(`http://${hostHeader}`);
	if (publicOrigin !== null && authority.host === publicOrigin.host) return true;
	return LOOPBACK_HOSTNAMES[authority.hostname] === true && Number(authority.port || "80") === boundPort;
}

/** Whether an Origin names the public origin or a loopback origin. `null`, junk and other hosts are refused. */
function originAllowed(origin: string, publicOrigin: URL | null): boolean {
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}
	if (publicOrigin !== null && parsed.origin === publicOrigin.origin) return true;
	return (parsed.protocol === "http:" || parsed.protocol === "https:") && LOOPBACK_HOSTNAMES[parsed.hostname] === true;
}

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

async function readBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > maxBytes) throw new BodyTooLargeError();
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function send(
	res: ServerResponse,
	status: number,
	body: string,
	contentType = "text/plain; charset=utf-8",
	headers: Record<string, string> = {},
): void {
	res.writeHead(status, { "content-type": contentType, ...headers });
	res.end(body);
}

/** `GET /healthz` as last computed, for pollers (uplift-2 R1). */
interface HealthMemo {
	status: number;
	body: Record<string, unknown>;
	/** Epoch ms when the body was computed. */
	at: number;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
	send(res, status, JSON.stringify(value), "application/json");
}

/**
 * The 429 of an enforced budget: an integer `Retry-After` and the bounded body
 * from `admission.ts`. Sent before the handler and before the audit — a refused
 * request did nothing, so there is no action to record, only a decision to count.
 */
function sendBudgetRefusal(res: ServerResponse, verdict: AdmissionVerdict, body: unknown = budgetBody(verdict)): void {
	send(res, 429, JSON.stringify(body), "application/json", { "retry-after": String(verdict.retryAfterS) });
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
 * `/healthz`, `/metrics`, `/slo`, `/slo/history` and `/livez` are not audited: they are monitoring traffic, no
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
	// `/livez` (uplift-4 S3) answers from this monitor alone: no store, no plane.
	const loopLag = new LoopLagMonitor();
	loopLag.start();
	// Read once here so a malformed `SUBSTRATE_BURN_*` ceiling warns at boot, not on
	// the first scrape; the route re-reads the environment per request and the
	// reader warns once per variable, so this line never repeats itself.
	loadBurnThresholds();
	// Same hourly window. `/metrics` counts refusals by reason; this line says which
	// sender to fix (claimed surface, kind, tokened or not) without carrying a payload.
	const refusalLog = new AnonymousCallerLog(options.anonymousIntervalMs, options.now, options.refusalLog, "refused events");
	refusalLog.start();
	// Dataset versions live in the service since uplift-2 R6, hydrated from and
	// saved to the docs state file with the ingest records; the merge-trigger
	// asks the service for the newest one and dedupes by content hash.
	// The last `/healthz` body, served again for `config.healthzCacheMs` (uplift-2 R1).
	const now = options.now ?? Date.now;
	let healthMemo: HealthMemo | null = null;
	// uplift-5 U5-3: the computation in flight. Pollers that arrive while it runs inside the memo window
	// join it instead of starting their own (each compute is a round trip per configured plane on the
	// same small pool); cleared in `finally`, so a compute that throws is not joined by the next poll.
	let healthFlight: Promise<HealthMemo> | null = null;
	// uplift-4 S6: `/slo/history` answers, 15 s per validated request, one read per key in flight.
	const historyMemo = new MetricHistoryMemo(now);
	// uplift-3 N3: the bucket per surface × class, on the cache plane. The
	// decision is recorded through the same observer the service reports to.
	const admission = new Admission(config.admission, {
		script: (script, keys, args) => substrate.cacheScript(script, keys, args),
		now,
		record: (verdict) => observability.observer.admission?.(verdict),
	});
	// The configured public origin, parsed once. When it does not parse, only loopback is answered.
	const publicOrigin = parsePublicOrigin(config.publicOrigin);
	const server = createServer(async (req, res) => {
		// A malformed Host or request target is the caller's error: a 400, not a throw out of this async listener,
		// which used to take the process down. A Host that is neither loopback on the bound port nor the public
		// origin's host is a 421 (DNS rebinding); an Origin that is neither is a 403.
		let url: URL;
		let hostOk: boolean;
		try {
			const host = req.headers.host;
			if (host === undefined) throw new TypeError("the Host header is required");
			const address = server.address();
			hostOk = hostAllowed(host, typeof address === "object" && address !== null ? address.port : 0, publicOrigin);
			url = new URL(req.url ?? "/", `http://${host}`);
		} catch {
			sendJson(res, 400, { error: "malformed Host header or request target" });
			return;
		}
		if (!hostOk) {
			sendJson(res, 421, { error: "Host does not name this substrate" });
			return;
		}
		const origin = req.headers.origin;
		if (origin !== undefined && !originAllowed(origin, publicOrigin)) {
			sendJson(res, 403, { error: "Origin is not allowed" });
			return;
		}
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

		// Measured from `close` rather than at each `send` call site: that way every
		// exit — a 401 below, a thrown handler, the MCP transport writing its own
		// response, a stream cut off mid-flight for backpressure — lands in the
		// histogram with the status the client actually saw. `finish` would miss the
		// last one: a response destroyed before it drained never finishes, and the
		// exit still happened. `close` always fires, after `end` and after a destroy.
		const started = performance.now();
		const span = startRequestSpan(observability, req, route, surface);
		// Set before the response is finished. `close` reads both.
		let eventRefusal: EventRefusalReason | null = null;
		let eventShape: { surface: string; kind: string } = { surface: "none", kind: "none" };
		const claim = { surface: "none" };
		// Set when the request is answered as the host's own liveness probe.
		let selfProbe = false;
		res.on("close", () => {
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
			// The watchdog's own `/livez` probe is not a caller: counting it would keep
			// "any anonymous callers left?" above zero for as long as the host runs.
			if (config.allowAnonymous && surface === null && res.statusCode !== 401 && !selfProbe) {
				const anonRoute = anonymousRoute(url.pathname);
				observability.instruments.recordAnonymous({ route: anonRoute, claimedSurface: claim.surface });
				anonymousLog.record(anonRoute, claim.surface);
			}
		});

		// `GET /livez` (uplift-4 S3): the systemd watchdog's probe. Answered before
		// the bearer check because the watchdog sends none, and only to a peer that
		// is this host (a loopback client, or a client at the address it connected
		// to); anyone else falls through to the checks below. It reads the lag
		// monitor and the process clock and touches no store, plane, cache or audit
		// chain, so a store outage can never fail it. No agent action is behind it.
		if (req.method === "GET" && url.pathname === "/livez" && isLocalPeer(req.socket.remoteAddress, req.socket.localAddress)) {
			selfProbe = true;
			sendJson(res, 200, livezBody(loopLag));
			return;
		}

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
		// GET /healthz stays open with no bearer: it names the origin and the
		// store state, and it carries no lesson or session content. A present
		// bearer that names no surface is still refused above.
		const openHealth = (req.method ?? "GET") === "GET" && url.pathname === "/healthz";
		if (
			unmappedBearer(config, authorization) ||
			publicEdgeNeedsBearer(req.headers[PUBLIC_EDGE_HEADER], req.method, url.pathname, surface) ||
			(!openHealth && !config.allowAnonymous && surface === null)
		) {
			if (req.method === "POST" && url.pathname === "/events") eventRefusal = "auth";
			sendJson(res, 401, { error: "unknown or missing bearer token" });
			return;
		}
		// Every POST that parses a JSON body answers 415 to any other media type. This runs after the bearer, so a
		// caller with none still gets its 401, and before admission, so a refused request spends no budget.
		const jsonBody = /^application\/json\s*(;|$)/i.test((req.headers["content-type"] ?? "").trim());
		if (req.method === "POST" && JSON_BODY_ROUTES[url.pathname] === true && !jsonBody) {
			sendJson(res, 415, { error: "request body must be application/json" });
			return;
		}

		// uplift-3 N3: admission, after the bearer is known and before any handler.
		// Monitor GETs are not metered; `/mcp` is metered per tool call in
		// `handleMcp`, where the batch is parsed. A `limited` verdict only exists in
		// `enforce`; `shadow` and every bypass fall through to the handler.
		const klass = routeClass(req.method ?? "GET", url.pathname);
		if (klass !== null) {
			const verdict = await admission.admit({ surface, klass, cost: 1 });
			if (verdict.decision === "limited") {
				sendBudgetRefusal(res, verdict);
				return;
			}
		}
		try {
			if (req.method === "GET" && url.pathname === "/healthz") {
				// Memoised for `healthzCacheMs` (uplift-2 R1): every collector polls this
				// route, and each computation costs one round trip per configured plane.
				// The status code is derived from the cached body by the same rule, so a
				// poller sees the same verdict a fresh computation gave at `cachedAt`.
				// `/metrics` and `/slo` are not memoised.
				const ttl = config.healthzCacheMs;
				const nowMs = now();
				const stale = ttl > 0 && healthMemo !== null && nowMs - healthMemo.at < ttl;
				const compute = async (): Promise<HealthMemo> => {
					const health = await substrate.health();
					const hindsight = substrate.hindsightInventoryHealth();
					const recall = substrate.recallHealth();
					return {
						status: healthStatus(health, config.greptime !== null),
						at: nowMs,
						body: {
							...health,
							publicOrigin: config.publicOrigin,
							// U5-4a: what a replaying client may rely on. It MUST NOT replay against `off` (or a body
							// without this field); the mode is static config, so the memo cannot make it stale.
							idempotency: config.eventIdempotency,
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
							// The read-only Hindsight inventory (uplift-4 S5): the newest probe, from memory. Absent when
							// SUBSTRATE_HINDSIGHT_INVENTORY is off; no existing field changes.
							...(hindsight !== null ? { hindsight } : {}),
							// Recall in the brief (uplift-4 S5): how many pairs the prefetcher can keep fresh; absent while it is off.
							...(recall !== null ? { recall } : {}),
						},
					};
				};
				let memo: HealthMemo;
				if (stale && healthMemo !== null) {
					memo = healthMemo;
				} else if (ttl > 0 && healthFlight !== null) {
					// A caller that joins a compute waited for it: its body is fresh, not memoised (`stale: false`).
					memo = await healthFlight;
				} else if (ttl > 0) {
					const flight = compute().then((computed) => {
						healthMemo = computed;
						return computed;
					});
					healthFlight = flight;
					try {
						memo = await flight;
					} finally {
						if (healthFlight === flight) healthFlight = null;
					}
				} else {
					memo = await compute();
					healthMemo = memo;
				}
				sendJson(res, memo.status, { ...memo.body, cachedAt: new Date(memo.at).toISOString(), stale });
				return;
			}

			if (req.method === "GET" && url.pathname === "/metrics") {
				// The snapshot this process holds, in the shape `otlp.ts` encodes. Served
				// whether or not a collector is configured, so an operator can read the same
				// numbers the SLOs are computed from without standing one up.
				// The docs gauges ride beside the snapshot (uplift-4 S7). `metrics` holds
				// counters, histograms and the registry's unlabelled gauges; the labelled docs
				// gauges (`substrate.docs.freshness_seconds`, `substrate.docs.trigger_lag_seconds`)
				// are served ONLY here, under `gauges`, and are not in OTLP. The key is absent
				// until a dataset has data. A read: nothing is settled or written here.
				// The Hindsight per-bank gauges (uplift-4 S5) ride in the same key. The outbox gauges are in
				// the snapshot below: the call refreshes them first, from in-process state, with no plane call.
				const bankGauges = substrate.hindsightGauges();
				const gauges = [...freshnessGauges(await substrate.evaluateDocsFreshness().catch(() => [])), ...bankGauges];
				sendJson(res, 200, {
					startedAt: new Date(observability.startedAt).toISOString(),
					metrics: observability.snapshot(),
					...(gauges.length > 0 ? { gauges } : {}),
				});
				return;
			}

			if (req.method === "GET" && url.pathname === "/slo") {
				const results = observability.evaluate();
				// The quota-burn objectives ride beside the catalogue, never inside it: the
				// catalogue is exactly SPE-4793's four. Every read both feeds and reads the
				// rolling-hour ledger, so scrape frequency is the sample rate — the
				// dispatcher's storm-breaker polls this same array. The ledger is the
				// observability's own since uplift-3 N2, so a restart restores it.
				const burn = observability.evaluateBurn();
				// The per-plane availability objectives ride beside it the same way
				// (uplift-2 R2): judged over the rolling hour, `unconfigured` for a plane
				// the deployment does not have.
				const planes = observability.evaluatePlanes(substrate.planesConfigured());
				// The admission refusal rate (uplift-3 N3) rides beside the catalogue
				// the same way: one objective, `insufficient-data` under 100 decisions.
				const admissionSlo = evaluateAdmissionSlo(observability.snapshot());
				// The docs-search latency objective (uplift-3 N5) rides beside it too:
				// one row, `docs.search.p95`, in the catalogue's entry shape, never
				// folded into `breached`.
				// `docs.freshness` (uplift-4 S7) joins it when a dataset has data: report-only too.
				const freshness = await substrate.evaluateDocsFreshness().catch(() => []);
				const docs = [
					...observability.evaluateDocs(),
					...evaluateDocsFreshnessSlo(
						freshness.map((row) => ({
							dataset: row.dataset,
							freshnessSeconds: row.freshness_seconds,
							triggerLagSeconds: row.trigger_lag_seconds,
							stale: row.stale,
							lagging: row.lagging,
						})),
						config.docsFreshness,
					),
				];
				// `brief.p95` per surface (uplift-3 N7): one row per surface with enough
				// samples, same shape plus `surface`; empty until a surface qualifies and
				// never folded into `breached` — the global row is still the catalogue's.
				const surfaces = observability.evaluateBriefSurfaces();
				// The capacity runway (uplift-3 N2): one row over the `/healthz` size ring.
				const capacity = observability.evaluateCapacity();
				// The estimated-spend row per surface (uplift-4 S1): what was served, by
				// bytes/4, against SUBSTRATE_SERVED_TOKENS_PER_HOUR. Beside the catalogue,
				// never folded into `breached`, and never part of `burn` — those are
				// model-reported tokens.
				const served = observability.evaluateServedTokens();
				// The index archive age (uplift-4 S2): one row, present only when an archive directory is configured; report-only until its ceiling is set.
				const indexArchive = await substrate.indexArchiveSlo();
				// The Railway cost report (Phase 45, D45-d and D45-g): report-only, so it is never folded into `breached`. The
				// client caches it for 15 minutes and reports a Railway failure as `unavailable`; the catch keeps a regression from
				// taking `/slo` down.
				const railwayCost = await substrate.railway.costReport().catch(() => null);
				// Predictive rows (phase 47, D47-a to D47-c): one per catalogue objective, Holt smoothing over the history
				// `/slo/history` reads, through the same answer and memo. Report-only: `breached` below never reads them.
				// An objective no recorded series covers is insufficient-data, never a guessed value.
				// brief.p95 is the largest surface value per bucket (basis worst-surface); the other objectives are service-wide (basis service).
				type ForecastSource = { series: string | null; direction: ForecastDirection; basis: ForecastRow["basis"] };
				const forecastSources: Readonly<Record<string, ForecastSource>> = {
					"brief.p95": { series: "brief.p95", direction: "maximum", basis: "worst-surface" },
					"emit.success": { series: "emit.success", direction: "minimum", basis: "service" },
					"lease.steal_rate": { series: null, direction: "maximum", basis: "service" },
					"quarantine.rate": { series: null, direction: "maximum", basis: "service" },
				};
				const historyOn = config.metricsHistory.enabled && substrate.greptime !== null;
				const forecast: ForecastRow[] = await Promise.all(
					results.map(async (result) => {
						const source: ForecastSource = forecastSources[result.id] ?? { series: null, direction: "maximum", basis: "service" };
						if (!historyOn) return forecastHistoryOff(result.id, result.target, source.basis);
						const answer =
							source.series === null
								? null
								: await metricHistoryAnswer(
										{ settings: config.metricsHistory, greptime: substrate.greptime, now, memo: historyMemo },
										new URLSearchParams({ series: source.series, window: FORECAST_WINDOW, step: String(FORECAST_STEP_S) }),
									).catch(() => null);
						const read = bucketedValues(answer);
						if (read === null) return forecastRow(result.id, result.target, source.direction, [], 1, source.basis);
						return forecastRow(result.id, result.target, source.direction, read.values, Math.round(FORECAST_HORIZON_MS / 1000 / read.stepS), source.basis);
					}),
				);
				// 200 either way. A breached objective is information, not a broken service,
				// and a monitor that read this as an outage would page on a slow hour.
				//
				// `breached` lists the catalogue's breaches first, then (uplift-3 N2) the
				// plane and burn ones: the storm-breaker and the runbook read this one
				// list, and a plane that was unavailable for an hour is as much a breach
				// as a slow brief. The per-array detail is unchanged beside it.
				sendJson(res, 200, {
					results,
					breached: [
						...results.filter((result) => result.status === "breached").map((result) => result.id),
						...planes.filter((result) => result.status === "breached").map((result) => result.id),
						...burn.filter((result) => result.status === "breached").map((result) => result.id),
					],
					burn,
					planes,
					admission: admissionSlo,
					docs,
					surfaces,
					capacity,
					served,
					...(indexArchive !== null ? { indexArchive: [indexArchive] } : {}),
					railwayCost,
					forecast,
					history: observability.history(),
				});
				return;
			}

			// uplift-4 S6: the durable metrics history, aggregated numbers only. 404 with
			// the history off or no ledger; the answer (and its validation) lives in `metrics-history.ts`.
			if (req.method === "GET" && url.pathname === "/slo/history") {
				const answer = await metricHistoryAnswer({ settings: config.metricsHistory, greptime: substrate.greptime, now, memo: historyMemo }, url.searchParams);
				send(res, answer.status, JSON.stringify(answer.body), "application/json", answer.headers);
				return;
			}

			// Per-surface A2A Agent Card (Phase 29, CARD-01). Unauthenticated
			// discovery, same exemption class as /healthz: no agent action sits
			// behind it, no audit record, emits nothing. One route serves all 27
			// surfaces; the ?surface= parameter demultiplexes, and its absence
			// is a 400, never a silent default.
			if (req.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
				const cardSurface = url.searchParams.get("surface");
				if (!cardSurface) {
					sendJson(res, 400, { error: "surface query parameter is required" });
					return;
				}
				if (!isKnownCardSurface(cardSurface)) {
					sendJson(res, 400, { error: `unknown surface ${JSON.stringify(cardSurface.slice(0, 80))}` });
					return;
				}
				// A tokened caller's card is its own surface's: another surface's is refused, not described.
				const cardRefusal = surfaceClaimRefusal(surface, cardSurface);
				if (cardRefusal !== null) {
					sendJson(res, 403, { error: cardRefusal });
					return;
				}
				sendJson(res, 200, buildAgentCard(cardSurface, await substrate.teachablesForSurface(cardSurface)));
				return;
			}

			if (req.method === "POST" && url.pathname === "/evidence") {
				const raw = await readBody(req);
				const body = raw ? (JSON.parse(raw) as { graph_id?: unknown; format?: unknown; node_id?: unknown }) : {};
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
				if (typeof body.node_id === "string" && body.node_id.length > 0) {
					const node = await substrate.nodeArtifactOf(body.graph_id, body.node_id);
					sendJson(res, 200, { ...bundle, node: "error" in node ? { error: node.error } : node.artifact });
					return;
				}
				sendJson(res, 200, bundle);
				return;
			}

			if (req.method === "POST" && url.pathname === "/brief") {
				const raw = await readBody(req);
				const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
				rememberClaim(claim, body);
				// A tokened caller's brief is its own surface's: a body naming another is refused, not served as theirs.
				const briefRefusal = surfaceClaimRefusal(surface, body.surface);
				if (briefRefusal !== null) {
					sendJson(res, 403, { error: briefRefusal });
					return;
				}
				if (!(await auditedRest(res, observability, surface, "brief", body))) return;
				// uplift-4 S1: an unknown profile is the caller's mistake, refused here
				// and never coerced to one the caller did not ask for.
				const requested = parseBriefProfile(body.profile);
				if (!requested.ok) {
					sendJson(res, 400, { error: requested.error });
					return;
				}
				const { detail: brief, notModified } = await substrate.briefConditional(
					{
						repo: typeof body.repo === "string" ? body.repo : undefined,
						branch: typeof body.branch === "string" ? body.branch : undefined,
						graph_id: typeof body.graph_id === "string" ? body.graph_id : undefined,
						surface: (typeof body.surface === "string" ? (body.surface as Surface) : null) ?? surface ?? "claude-code",
					},
					req.headers["if-none-match"],
					requested.profile,
					// The profile follows the resolved bearer, never the body's `surface` (attribution only).
					surface,
				);
				// uplift-2 R1: the caller can tell a degraded or snapshot brief from a
				// complete one and skip one it already holds. A degraded answer is still
				// 200 — the fail-open contract is unchanged; only the headers say so.
				// `no-cache` means revalidate, not "do not store": the ETag is the validator.
				const headers: Record<string, string> = {
					etag: brief.etag,
					"cache-control": "no-cache",
					"x-substrate-brief": brief.state,
					"x-substrate-brief-profile": brief.profile,
					...(brief.failed.length > 0 ? { "x-substrate-brief-failed": brief.failed.join(",") } : {}),
					// uplift-4 S4: additive; present only when the text is a last-good served inside the stale window.
					...(brief.ageS !== undefined ? { "x-substrate-brief-age": String(brief.ageS) } : {}),
				};
				if (notModified) {
					res.writeHead(304, headers);
					res.end();
					return;
				}
				send(res, 200, brief.text, "text/markdown; charset=utf-8", headers);
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
				// `x-substrate-replay: 1` marks a re-send of an earlier attempt (U5-4a). Read here, honoured
				// (or ignored, under `off`) by `Substrate.emit`.
				const result = await substrate.emit(
					{
						...(body as object),
						surface: attribution.surface,
					} as Parameters<Substrate["emit"]>[0],
					{ replay: req.headers["x-substrate-replay"] === "1" },
				);
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
					...(result.deduplicated ? { deduplicated: true } : {}),
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

			// U7: the push seam. Every consumer polled the ledger before this — collectors
			// reconciled on timers — and the stream changes only the transport: the ledger
			// stays the buffer, each connection keeps its own cursor and one poll timer,
			// and no emit path ever touches subscriber state, so a broken or vanished
			// subscriber costs the server a bounded backlog and nothing else.
			if (req.method === "GET" && url.pathname === "/events/stream") {
				const refusal = streamRefusal(surface, req.socket.remoteAddress);
				if (refusal) {
					sendJson(res, refusal.status, { error: refusal.error });
					return;
				}
				// Last-Event-ID is what an EventSource sends back on reconnect;
				// `?cursor=` is the same name for a consumer that cannot set headers.
				const headerId = req.headers["last-event-id"];
				const requested = (Array.isArray(headerId) ? headerId[0] : headerId) ?? url.searchParams.get("cursor") ?? "";
				const cursorId = requested.trim().slice(0, 128);
				// Audited once per connection, under the name `/events/query` is audited
				// under — the same read, so the trail never grows a second name for one
				// action. Never per frame.
				if (!(await auditedRest(res, observability, surface, "events_query", { cursor: cursorId === "" ? null : cursorId }))) {
					return;
				}
				const greptime = substrate.greptime;
				if (!greptime) {
					sendJson(res, 503, { error: "GREPTIME_URL is not set; there is no ledger to stream" });
					return;
				}
				try {
					await openEventStream(res, greptime, cursorId, {
						pollMs: options.streamPollMs ?? STREAM_POLL_MS,
						idleMs: options.streamIdleMs ?? STREAM_IDLE_MS,
						batch: STREAM_BATCH,
						maxBacklogBytes: options.streamMaxBacklogBytes ?? STREAM_MAX_BACKLOG_BYTES,
					}, substrate.eventBus);
				} catch (cause) {
					// Setup failed before the stream opened, so an ordinary error response
					// is still available — fail-open here means the caller learns the
					// stream did not open, and a 503 names the ledger, not the caller,
					// as the thing that failed.
					if (res.headersSent) throw cause;
					sendJson(res, 503, { error: redact(String(cause)) });
				}
				return;
			}

			if (req.method === "POST" && url.pathname === "/memory") {
				const parsed: unknown = JSON.parse(await readBody(req));
				// Refused before the audit and the gate, as every other REST write route does. A
				// `null` body used to write its audit record and then answer 500 on `body.writer`,
				// and an array or scalar reached the gate and came back as a policy refusal.
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
					sendJson(res, 400, { error: "request body must be a JSON object" });
					return;
				}
				const body = parsed as Record<string, unknown>;
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

		// A read inside an agent's turn: fail-open, so anonymous callers reach
		// the audit gate like every other read and an unreachable plane
		// answers degraded rather than refusing the turn.
		if (req.method === "POST" && url.pathname === "/memory/recall") {
			const parsed: unknown = JSON.parse(await readBody(req));
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
				sendJson(res, 400, { error: "request body must be a JSON object" });
				return;
			}
			if (!("query" in parsed) || typeof parsed.query !== "string") {
				sendJson(res, 400, { error: "query is required" });
				return;
			}
			const repo = "repo" in parsed && typeof parsed.repo === "string" ? parsed.repo : undefined;
			const fields: Record<string, unknown> = { query: parsed.query };
			if (!(await auditedRest(res, observability, surface, "memory_recall", repo === undefined ? fields : { ...fields, repo }))) return;
			sendJson(res, 200, await substrate.recallMemories(fields, surface, repo));
			return;
		}

			// Hooks get the coordination paths over REST for the same reason they get
			// the brief: a hook process has no MCP client. Same service code beneath.
			if (req.method === "POST" && url.pathname === "/handoff") {
				const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
				rememberClaim(claim, body);
				// A tokened caller hands off as its own surface. A body naming another is refused, never re-attributed.
				const handoffRefusal = surfaceClaimRefusal(surface, body.surface);
				if (handoffRefusal !== null) {
					sendJson(res, 403, { error: handoffRefusal });
					return;
				}
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

			// A read inside an agent's turn: fail-open, so anonymous callers reach
			// the audit gate like every other read and an unreachable plane
			// answers degraded rather than refusing the turn.
			if (req.method === "POST" && url.pathname === "/docs/search") {
				const parsed: unknown = JSON.parse(await readBody(req));
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
					sendJson(res, 400, { error: "request body must be a JSON object" });
					return;
				}
				if (!("question" in parsed) || typeof parsed.question !== "string") {
					sendJson(res, 400, { error: "question is required" });
					return;
				}
				const datasets = "datasets" in parsed ? parsed.datasets : undefined;
				const sessionId = "session_id" in parsed ? parsed.session_id : undefined;
				const context = "context" in parsed ? parsed.context : undefined;
				if (
					(datasets !== undefined && !(Array.isArray(datasets) && datasets.every((name) => typeof name === "string"))) ||
					(sessionId !== undefined && typeof sessionId !== "string") ||
					(context !== undefined && typeof context !== "boolean")
				) {
					sendJson(res, 400, { error: "datasets must be a string array, session_id a string and context a boolean" });
					return;
				}
				const fields: Record<string, unknown> = {
					question: parsed.question,
					...(datasets !== undefined ? { datasets } : {}),
					...(sessionId !== undefined ? { session_id: sessionId } : {}),
					...(context !== undefined ? { context } : {}),
				};
				if (!(await auditedRest(res, observability, surface, "docs_search", fields))) return;
				// SPE-19388: the REST search reports into the same process-wide
				// RAG machine as the MCP tool. Replies are unchanged.
				const searchBackend = config.docsBackend;
				ragMachine.transition("STEERING", `docs_search:${searchBackend}`);
				ragMachine.transition("CONTEXT_REFRESH", `docs_search:retrieve:${searchBackend}`);
				try {
					const reply = await substrate.searchDocs(fields, surface);
					if (reply.degraded === true) {
						ragMachine.recordFailure(config.ragMachine, `docs_search: ${reply.reason ?? "degraded"}`);
					} else {
						ragMachine.recordSuccess("docs_search:served");
					}
					sendJson(res, 200, reply);
				} catch (cause) {
					ragMachine.recordFailure(
						config.ragMachine,
						`docs_search threw: ${String(cause instanceof Error ? cause.message : cause).slice(0, 200)}`,
					);
					throw cause;
				}
				return;
			}

			// A publication path other agents read from, so an anonymous caller is
			// refused before the body is read, even on a run that otherwise allows
			// untokened callers. Audited fail-closed under the tool's own name.
			if (req.method === "POST" && url.pathname === "/docs/ingest") {
				if (surface === null) {
					sendJson(res, 401, { error: INGEST_NEEDS_SURFACE });
					return;
				}
				const parsed: unknown = JSON.parse(await readBody(req, DOCS_MAX_BODY_BYTES));
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
					sendJson(res, 400, { error: "request body must be a JSON object" });
					return;
				}
				if (!("dataset" in parsed) || typeof parsed.dataset !== "string") {
					sendJson(res, 400, { error: "dataset is required" });
					return;
				}
				const commit = "commit" in parsed ? parsed.commit : undefined;
				const pages = "pages" in parsed ? parsed.pages : undefined;
				const ingestSession = "session_id" in parsed ? parsed.session_id : undefined;
				const pagesValid =
					Array.isArray(pages) &&
					pages.every(
						(page) =>
							page !== null &&
							typeof page === "object" &&
							!Array.isArray(page) &&
							"path" in page &&
							typeof page.path === "string" &&
							"body" in page &&
							typeof page.body === "string" &&
							(!("source_url" in page) || typeof page.source_url === "string") &&
							(!("real_path" in page) || typeof page.real_path === "string") &&
							(!("heading_path" in page) || typeof page.heading_path === "string") &&
							(!("expected_version" in page) || (typeof page.expected_version === "number" && Number.isInteger(page.expected_version) && page.expected_version >= 0)),
				);
				if (!pagesValid || (commit !== undefined && typeof commit !== "string") || (ingestSession !== undefined && typeof ingestSession !== "string")) {
					sendJson(res, 400, { error: "pages must carry string path and body, and expected_version a non-negative integer; commit and session_id must be strings" });
					return;
				}
				const ingestFields: Record<string, unknown> = {
					dataset: parsed.dataset,
					pages,
					...(commit !== undefined ? { commit } : {}),
					...(ingestSession !== undefined ? { session_id: ingestSession } : {}),
				};
				if (!(await auditedRest(res, observability, surface, "docs_ingest", ingestFields))) return;
				// SPE-19388: the REST ingest reports into the same process-wide
				// RAG machine as the MCP tool. Outcomes are unchanged.
				ragMachine.transition("STEERING", `docs_ingest:${config.docsBackend}`);
				ragMachine.transition("CONTEXT_REFRESH", `docs_ingest:upload:${config.docsBackend}`);
				try {
					const outcome = await substrate.ingestDocs(ingestFields, surface);
					if (outcome.ok) {
						ragMachine.recordSuccess("docs_ingest:served");
					} else if (!ingestRefusalIsGate(outcome.reason)) {
						// A refused request never reached the plane, so it says nothing about the plane's health.
						ragMachine.recordFailure(config.ragMachine, `docs_ingest: ${outcome.reason}`);
					}
					if (!outcome.ok) {
						sendJson(res, outcome.reason === "vm-guest" ? 403 : outcome.reason === "version.stale" ? 409 : 400, outcome);
						return;
					}
					sendJson(res, 200, outcome);
				} catch (cause) {
					ragMachine.recordFailure(
						config.ragMachine,
						`docs_ingest threw: ${String(cause instanceof Error ? cause.message : cause).slice(0, 200)}`,
					);
					throw cause;
				}
				return;
			}
			// SPE-19388 LightRAG query surface (SPE-19384 RAG replacement):
			// REST/JSON over `POST /query`, same Hindsight fallback and
			// idempotency as the `docs_lightrag_query` MCP tool. Read-only
			// like `/docs/search`: anonymous callers reach the audit gate and
			// an unreachable plane degrades rather than refusing the turn.
			if (req.method === "POST" && url.pathname === "/docs/lightrag/query") {
				const parsed: unknown = JSON.parse(await readBody(req));
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
					sendJson(res, 400, { error: "request body must be a JSON object" });
					return;
				}
				if (!("question" in parsed) || typeof parsed.question !== "string" || parsed.question.trim().length === 0) {
					sendJson(res, 400, { error: "question is required" });
					return;
				}
				const record = parsed as Record<string, unknown>;
				const mode = "mode" in record ? record.mode : undefined;
				const topK = "top_k" in record ? record.top_k : undefined;
				const entities = "entities" in record ? record.entities : undefined;
				const relations = "relations" in record ? record.relations : undefined;
				const idempotencyKey = "idempotency_key" in record ? record.idempotency_key : undefined;
				const shapeOk =
					(mode === undefined || (typeof mode === "string" && ["naive", "local", "global", "hybrid", "mix"].includes(mode))) &&
					(topK === undefined || typeof topK === "number") &&
					(entities === undefined || (Array.isArray(entities) && entities.every((entry) => typeof entry === "string"))) &&
					(relations === undefined ||
						(Array.isArray(relations) &&
							relations.every(
								(relation) =>
									relation !== null &&
									typeof relation === "object" &&
									!Array.isArray(relation) &&
									typeof (relation as Record<string, unknown>).source === "string" &&
									typeof (relation as Record<string, unknown>).target === "string" &&
									typeof (relation as Record<string, unknown>).kind === "string",
							))) &&
					(idempotencyKey === undefined || typeof idempotencyKey === "string");
				if (!shapeOk) {
					sendJson(res, 400, { error: "mode/top_k/entities/relations/idempotency_key have the wrong shape" });
					return;
				}
				const fields: Record<string, unknown> = {
					question: record.question,
					...(mode !== undefined ? { mode } : {}),
					...(topK !== undefined ? { top_k: topK } : {}),
					...(entities !== undefined ? { entities } : {}),
					...(relations !== undefined ? { relations } : {}),
					...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
				};
				if (!(await auditedRest(res, observability, surface, "docs_lightrag_query", fields))) return;
				const entityList = Array.isArray(entities) ? (entities as string[]) : [];
				const relationList = Array.isArray(relations)
					? (relations as Array<{ source: string; target: string; kind: string }>)
					: [];
				const key = lightragReplayKey(
					surface,
					{
						question: record.question as string,
						...(typeof mode === "string" ? { mode } : {}),
						...(typeof topK === "number" ? { topK } : {}),
						entities: entityList,
						relations: relationList,
					},
					typeof idempotencyKey === "string" ? idempotencyKey : undefined,
				);
				const replayed = getCachedRagResult(key);
				if (replayed !== undefined) {
					process.stderr.write(
						`${JSON.stringify({ source: "substrate", event: "rag-state", from: replayed.state.state, to: replayed.state.state, reason: "idempotent-replay", duplicate: true })}\n`,
					);
					sendJson(res, 200, withLightragNotice(replayed));
					return;
				}
				const admission = ragMachine.admitQuery(config.ragMachine.halfOpenMs);
				if (admission === "refuse") {
					const held = await hindsightRagFallback(substrate, surface, record.question as string, entityList, relationList, "rag breaker open");
					setCachedRagResult(key, held);
					sendJson(res, 200, withLightragNotice(held));
					return;
				}
				// A probe's attempt ends here, whatever it found: until then no other query reaches the plane.
				try {
					ragMachine.transition("STEERING", `lightrag_query:${config.docsBackend}`);
					const lightrag = config.lightrag;
					if (lightrag === null) {
						ragMachine.transition("CONTEXT_REFRESH", "lightrag_query:unconfigured");
						const degraded = await hindsightRagFallback(
							substrate,
							surface,
							record.question as string,
							entityList,
							relationList,
							"lightrag-not-configured",
						);
						setCachedRagResult(key, degraded);
						sendJson(res, 200, withLightragNotice(degraded));
						return;
					}
					const augmented = augmentRagQuery(record.question as string, entityList, relationList);
					ragMachine.transition("CONTEXT_REFRESH", "lightrag_query:retrieve");
					let lastReason = "lightrag unreachable";
					for (let attempt = 0; attempt <= config.ragMachine.maxRetries; attempt += 1) {
						if (attempt > 0) await ragRetryDelay(config.ragMachine.retryBaseMs, attempt);
						const answered = await queryLightragRest(lightrag, {
							question: augmented,
							...(typeof mode === "string" ? { mode } : {}),
							...(typeof topK === "number" ? { topK } : {}),
						});
						if (answered.ok) {
							const state = ragMachine.recordSuccess("lightrag_query:served");
							const result = {
								backend: "lightrag" as const,
								chunks: answered.chunks,
								graph: ragGraphCounts(answered.chunks, entityList, relationList),
								state,
							};
							setCachedRagResult(key, result);
							sendJson(res, 200, withLightragNotice(result));
							return;
						}
						lastReason = answered.reason;
					}
					ragMachine.recordFailure(config.ragMachine, `lightrag_query: ${lastReason}`);
					const degraded = await hindsightRagFallback(
						substrate,
						surface,
						record.question as string,
						entityList,
						relationList,
						lastReason,
					);
					setCachedRagResult(key, degraded);
					sendJson(res, 200, withLightragNotice(degraded));
				} finally {
					if (admission === "probe") ragMachine.settleProbe();
				}
				return;
			}

			// SPE-19388: the RAG machine snapshot for pollers. Exempt like
			// `/healthz`: it carries counters and a hash, no lesson content.
			// Pollers detect change by comparing `stateHash`.
			if (req.method === "GET" && url.pathname === "/rag/state") {
				sendJson(res, 200, ragMachine.snapshot());
				return;
			}

			// U6 (DOCS-03): the documented refresh triggers, wired. A post-merge hook asks
			// for the `agent-substrate` dataset (the default); the skills-sync tick names
			// `agent-skills`. A refresh first moves documents through the guarded ingest
			// `docs_ingest` serves — the same redaction, refusals and content-hash
			// idempotency, so the conventions cannot drift apart — and only then records
			// the version: a trigger that answered ok while search still held the old
			// files would be recording a refresh that never happened. This deployment
			// ingests the dataset whose checkout it holds; a dataset with no configured
			// ingest root here is a truthful noop, not a fake refresh. Three doors are
			// deliberate: an unauthenticated caller is refused before the body is read,
			// a remote caller is refused even with a valid token (the trigger drives
			// host-local automation and is loopback-only by design), and a repeat
			// carrying the newest version's own commit and content hash re-answers it
			// without ingesting or recording a second version — a webhook retry is
			// cheap by hash. Since uplift-2 R6 the ingest runs in the background: the
			// route answers 202 with a job id at once (its caller, the skills-sync
			// tick, gives up after 3 s while a real parse takes up to a minute per
			// page), and `?wait=1` keeps the synchronous answer for operators.
			if (req.method === "POST" && url.pathname === "/docs/merge-trigger") {
				if (surface === null) {
					sendJson(res, 401, { error: MERGE_TRIGGER_NEEDS_SURFACE });
					return;
				}
				if (!isLoopbackRemote(req.socket.remoteAddress)) {
					sendJson(res, 403, { error: "docs merge-trigger is a loopback route; the caller is not loopback" });
					return;
				}
				// DOCS-02: ingestion accepts only authenticated callers that are not VM
				// guests — a guest that could drive ingest could also create a missing
				// shared dataset through the ensure step below. Same door as
				// memory-retain's guest refusal.
				if (config.vmGuest) {
					sendJson(res, 403, { error: "docs merge-trigger refuses VM guests: guests do not drive ingest" });
					return;
				}
				const parsed: unknown = JSON.parse(await readBody(req));
				if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
					sendJson(res, 400, { error: "request body must be a JSON object" });
					return;
				}
				const body = parsed as Record<string, unknown>;
				const dataset = typeof body.dataset === "string" ? body.dataset : MERGE_TRIGGER_DATASET;
				// hasOwn, not `in`: `in` also accepts the names every object inherits —
				// "constructor", "toString", "__proto__" — and those would pass the
				// known-dataset check and reach the refresh with a dataset the store
				// never held. Only the trigger table's own rows are known.
				if (!Object.hasOwn(DATASET_TRIGGERS, dataset)) {
					sendJson(res, 400, {
						error: `unknown dataset ${JSON.stringify(dataset.slice(0, 80))}; known: ${Object.keys(DATASET_TRIGGERS).join(", ")}`,
					});
					return;
				}
				if (typeof body.commit !== "string" || body.commit.length === 0 || typeof body.content_sha256 !== "string" || body.content_sha256.length === 0) {
					sendJson(res, 400, { error: "commit and content_sha256 are required" });
					return;
				}
				const fields = { dataset, commit: body.commit, content_sha256: body.content_sha256 };
				// Audited under `docs_ingest`, the fail-closed name the write it performs
				// is decided under — a merge-trigger nobody recorded is an unrecorded
				// publication, same as an ingest nobody recorded.
				if (!(await auditedRest(res, observability, surface, "docs_ingest", fields))) return;
				if (config.ragflow === null) {
					// The null-block idiom: no docs plane is configured, so the trigger
					// asks for nothing that exists — answered quietly, no plane call made.
					sendJson(res, 200, { ok: true, dataset, noop: true, reason: "docs-plane-unconfigured" });
					return;
				}
				const newest = await substrate.latestDocsVersion(dataset);
				if (newest && newest.commit === fields.commit && newest.content_sha256 === fields.content_sha256) {
					sendJson(res, 200, { ok: true, version: newest, created: false, idempotent: true });
					return;
				}
				const source = localIngestSource(dataset, config, options.docsIngestBaseDir ?? process.cwd());
				if (source === undefined) {
					// This server holds no checkout of that dataset, so there is nothing it
					// can truthfully ingest: a noop that says so, and no version recorded.
					// The trigger itself is still evidence (skills-sync fast-forwarded).
					substrate.noteDocsTrigger(dataset);
					sendJson(res, 200, { ok: true, dataset, noop: true, reason: "no-configured-ingest-root" });
					return;
				}
				substrate.noteDocsTrigger(dataset);
				// The service reads the checkout's roots and pages, ensures the dataset, runs
				// the guarded ingest and records the version, in that order, in the
				// background; the 202 is audited above like the 200 was. A plane
				// refusal under `?wait=1` is an outage of the docs plane, not a
				// permission decision about the caller: 503 with the reason. A checkout that
				// cannot be read fails the job the same way and the pinned version keeps serving.
				const accepted = await substrate.startDocsRefresh(
					{ ...fields, roots: source.roots, pages: source.pages, head: source.head },
					surface,
					{ wait: url.searchParams.get("wait") === "1" },
				);
				sendJson(res, accepted.status, accepted.body);
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

			// An approval is an operator's decision on what the registry says is published, and it asks the owner's
			// GitHub credential about a pull request. A caller with no surface (401) and one that is not an operator (403;
			// a swarm surface and `substrate` never are) are both refused before the body is read, parsed or audited: an
			// oversize or malformed body, or an audit outage, never changes a refusal into another status.
			if (req.method === "POST" && url.pathname === "/skills/approve") {
				if (surface === null) {
					sendJson(res, 401, { error: APPROVAL_NEEDS_SURFACE });
					return;
				}
				if (!caller.isOperator) {
					sendJson(res, 403, { error: APPROVAL_NEEDS_OPERATOR });
					return;
				}
				const body = JSON.parse(await readBody(req)) as unknown;
				const fields = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
				if (fields && !(await auditedRest(res, observability, surface, "skills_approve", fields))) return;
				const problem = approvalBodyProblem(body);
				if (problem) {
					sendJson(res, 400, { error: problem });
					return;
				}
				try {
					sendJson(res, 200, await substrate.approveSkill(toApprovalRequest(fields ?? {}), { surface, isOperator: caller.isOperator }));
				} catch (cause) {
					const failure = approvalFailure(cause);
					if (failure === null) throw cause;
					sendJson(res, failure.status, failure.body);
				}
				return;
			}

			// The registry read: approved skills by default, any authenticated surface (the projector's is `substrate`).
			// A caller with no surface is refused before the audit and the read.
			if (req.method === "GET" && url.pathname === "/skills") {
				if (surface === null) {
					sendJson(res, 401, { error: LIST_NEEDS_SURFACE });
					return;
				}
				const state = url.searchParams.get("state") ?? undefined;
				if (!(await auditedRest(res, observability, surface, "skills_list", state === undefined ? {} : { state }))) return;
				try {
					sendJson(res, 200, await substrate.listSkills(state === undefined ? {} : { state }, { surface, isOperator: caller.isOperator }));
				} catch (cause) {
					const failure = approvalFailure(cause);
					if (failure === null) throw cause;
					sendJson(res, failure.status, failure.body);
				}
				return;
			}

			if (url.pathname === "/mcp") {
				await handleMcp(req, res, substrate, caller, observability, claim, admission);
				return;
			}

			sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
		} catch (cause) {
			if (cause instanceof BodyTooLargeError && (url.pathname === "/skills/propose" || url.pathname === "/skills/approve" || url.pathname === "/docs/ingest" || url.pathname === "/mcp" || url.pathname === "/memory")) {
				sendJson(res, 413, { error: cause.message });
				return;
			}
			if (cause instanceof InvalidEventError || cause instanceof InvalidHandoffError) {
				if (req.method === "POST" && url.pathname === "/events" && cause instanceof InvalidEventError) {
					eventRefusal = classifyEventRefusal(400, cause.message) ?? "validation";
				}
				sendJson(res, 400, { error: cause.message, ...(cause instanceof IdempotencyRefusal ? { rule: cause.rule } : {}) });
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
	// These bound how long a request may take to arrive, not how long a response may run. There is no connection
	// cap: `/events/stream` holds its connection open by design.
	server.headersTimeout = HEADERS_TIMEOUT_MS;
	server.requestTimeout = REQUEST_TIMEOUT_MS;
	const close = server.close.bind(server);
	server.close = ((callback?: (err?: Error) => void) => {
		anonymousLog.stop();
		refusalLog.stop();
		loopLag.stop();
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
 * The body of one stream frame: the same event shape `/events/query` returns for
 * a read without payload. Mirrors `rowToEvent` in `service.ts` — Greptime hands
 * back loosely typed rows and epoch millis — and adds no redaction of its own,
 * because these rows were redacted on the write path, exactly as for every other
 * read of them. `payload` is not selected, the read path's default.
 */
function ledgerEventFrame(row: Record<string, unknown>): string {
	const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
	return JSON.stringify({
		id: String(row.id),
		ts: new Date(Number(row.ts)).toISOString(),
		surface: String(row.surface),
		session_id: text(row.session_id),
		graph_id: text(row.graph_id),
		node_id: text(row.node_id),
		linear_identifier: text(row.linear_identifier),
		step: row.step === null || row.step === undefined ? null : Number(row.step),
		repo: text(row.repo),
		branch: text(row.branch),
		actor: String(row.actor),
		kind: String(row.kind),
		summary: String(row.summary),
		hash: String(row.hash),
		prev: text(row.prev),
	});
}

/**
 * Open one Server-Sent Events response: resolve the cursor, then hand the
 * response to a poll loop that writes one `id:`/`data:` frame per ledger event,
 * in (ingested_at, id) order, until the client goes away or the stream idles out.
 *
 * Everything before the response headers is setup: a failure there throws, and
 * the route answers an ordinary error — fail-open means the caller learns the
 * stream did not open, not that it silently got nothing. Once the headers are
 * written the failure rule inverts: a ledger that will not answer skips its tick
 * and the connection stays open, because tearing down every consumer on one
 * blip would make the stream less reliable than the polling it replaces.
 *
 * The ledger is the buffer. No fan-out list, no queue beyond the socket's own,
 * and no shared state an emit path could touch: each connection's whole
 * footprint is its cursor, one unref'd interval, and whatever it has not yet
 * flushed.
 */
/**
 * The position an empty ledger starts a cursorless stream at: before every
 * record the ledger can ever hold, so the first later event is strictly after
 * it and is delivered. A null with no boundary would mean "read the tip at the
 * first tick" — and the tip would then name the very event that arrived first.
 */
const LEDGER_START: CursorPosition = { id: "", ingestedAt: 0 };

async function openEventStream(
	res: ServerResponse,
	greptime: GreptimeClient,
	cursorId: string,
	bounds: { pollMs: number; idleMs: number; batch: number; maxBacklogBytes: number },
	bus: EventBus | null,
): Promise<void> {
	// The connection-life listeners go on before any await, because the setup
	// reads below are the first async steps and a cursorless client can vanish
	// while `latestPosition()` is still pending — before the headers, and
	// before anything else would notice. Ending the socket during setup has to
	// leave no timer behind.
	let timer: ReturnType<typeof setInterval> | null = null;
	let closed = false;
	let unsubscribe: (() => void) | null = null;

	const cleanup = (): void => {
		if (closed) return;
		closed = true;
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
		if (unsubscribe !== null) {
			unsubscribe();
			unsubscribe = null;
		}
	};
	// Both ends of the connection's life — a normal end, a client that vanished,
	// a socket error — land here, and the timer never outlives any of them.
	res.on("close", cleanup);
	res.on("error", cleanup);

	// Setup. An id the ledger does not know replays nothing: the stream starts
	// live from the tip, which is also the honest answer for a cursor older than
	// the ledger's memory — there is nothing behind it left to replay.
	let resolved: CursorPosition | null = null;
	if (cursorId !== "") {
		try {
			resolved = await greptime.cursorPosition(cursorId);
		} catch (cause) {
			throw new Error(`the ledger would not resolve the stream cursor: ${redact(String(cause))}`);
		}
	}
	// The live start is captured before the response opens, not on the first
	// tick: a tip read after the first poll would adopt the events that arrived
	// between connect and that tick as the starting cursor — sent to no one —
	// and an empty ledger read late would swallow its first event. "Live" means
	// everything after the position the ledger already had when the caller
	// connected, or from the very first event when it was empty.
	let cursor: CursorPosition;
	if (resolved !== null) {
		cursor = resolved;
	} else {
		try {
			cursor = (await greptime.latestPosition()) ?? LEDGER_START;
		} catch (cause) {
			throw new Error(`the ledger would not resolve the stream start: ${redact(String(cause))}`);
		}
	}
	// The socket died during those reads: the response has nobody left to open
	// for, and a setup that went on to write headers and start the interval
	// would create a timer whose cleanup had already fired. Returning here is
	// the whole point of the listeners sitting above the setup.
	if (closed || res.destroyed) return;

	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		// The stream *is* the response; when it ends the connection has no further
		// use, and closing it lets a server shutdown wait on no idle socket.
		connection: "close",
	});
	// A reconnect hint an EventSource honours; custom consumers ignore it.
	res.write("retry: 5000\n\n");

	let polling = false;
	let wakeAgain = false;
	let lastActivity = Date.now();

	const tick = (): void => {
		if (closed || polling) return;
		polling = true;
		void (async () => {
			try {
				// Checked after the read on purpose, not before it: a client that
				// vanished mid-poll still made its last read, which is what keeps a
				// leaked timer observable — the disconnect test counts ledger reads,
				// and a timer nobody cleared would keep counting after the socket
				// closed.
				if (res.destroyed || res.writableEnded) return;
				if (Date.now() - lastActivity >= bounds.idleMs) {
					// Idle close. The client reconnects with Last-Event-ID and resumes
					// exactly where this cursor stopped; the ledger held the gap, not
					// this process.
					res.end();
					cleanup();
					return;
				}
				const positions = await greptime.eventIdsAfter(cursor, bounds.batch);
				if (positions.length === 0) return;
				// Positions, not ids: each carries `eventTs`, which bounds the row read in time (uplift-2 R5).
				const rows = await greptime.eventsByIds(positions);
				const byId = new Map(rows.map((row) => [String(row.id), row]));
				for (const position of positions) {
					const row = byId.get(position.id);
					// The event row is written before its ingest record, so a position
					// without a row is not a state storage reaches; if it ever lies,
					// stop on it and retry the same cursor rather than skip a frame in
					// silence.
					if (!row || !Number.isFinite(Number(row.ts))) return;
					res.write(`id: ${position.id}\ndata: ${ledgerEventFrame(row)}\n\n`);
					cursor = position;
					lastActivity = Date.now();
					// Slow consumer: the unflushed backlog is the memory this one
					// connection costs the server, and past the cap the connection is
					// worth less than the memory. Destroying it fires `close`, clears
					// the timer, and the client replays from its Last-Event-ID.
					if (res.writableLength > bounds.maxBacklogBytes) {
						res.destroy();
						cleanup();
						return;
					}
				}
			} catch {
				// A ledger that will not answer is a skipped tick, not a torn-down
				// stream: the cursor stays put, and the next poll retries it.
			} finally {
				polling = false;
				if (wakeAgain) {
					wakeAgain = false;
					tick();
				}
			}
		})();
	};

	// Phase 50: a hint reads the ledger now instead of at the next poll. It only wakes the loop; the ledger
	// decides what is sent, so a lost or late hint costs latency and nothing else.
	const wake = (): void => {
		if (polling) wakeAgain = true;
		else tick();
	};

	// The subscription lives as long as the response: cleanup releases it on close, error and idle close alike.
	if (bus !== null) unsubscribe = bus.subscribe(() => wake());
	// Unref'd, like every other timer this server holds: an open stream must not
	// be the thing keeping a closing process alive.
	timer = setInterval(tick, bounds.pollMs);
	timer.unref?.();
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
	admission: Admission,
): Promise<void> {
	if (req.method !== "POST") {
		// Stateless mode has no server-initiated stream to attach to.
		res.writeHead(405, { allow: "POST" }).end();
		return;
	}
	// Refused on the declared size before a byte of the body is read. `readBody`'s cap still holds for a body
	// that declares less than it sends.
	const declared = Number(req.headers["content-length"] ?? 0);
	if (declared > DOCS_MAX_BODY_BYTES) {
		send(res, 413, JSON.stringify({ error: `request body is over ${DOCS_MAX_BODY_BYTES} bytes` }), "application/json", { connection: "close" });
		return;
	}
	const raw = await readBody(req, DOCS_MAX_BODY_BYTES);
	const body: unknown = raw ? JSON.parse(raw) : undefined;
	rememberClaim(claim, body);

	// uplift-3 N3: the batch is costed here, where its members are known — one
	// token per `tools/call` of each member's class — and refused whole before
	// any member runs and before the audit, which records actions, not refusals.
	// One request token alone would let a batch of fifty calls cost one.
	const calls = toolCallsIn(body);
	const refused = await admitBatch(admission, caller.surface, calls);
	if (refused !== null) {
		sendBudgetRefusal(res, refused, budgetRefusal(body, refused));
		return;
	}

	const { denials } = await auditToolCalls(observability, caller.surface, calls);
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
