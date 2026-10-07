/**
 * HTTP surface for substrate-mcp.
 *
 *   POST /mcp           MCP over streamable HTTP, for agents
 *   POST /brief         the same briefing as plain text, for hooks
 *   POST /events        append an event, for hooks
 *   POST /events/query  read a window of the ledger
 *   POST /memory        write a memory entry through the governance gate
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
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { auditMode } from "@substrate/audit";
import { isOperator, surfaceForToken, type SubstrateConfig } from "./config.ts";
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
import type { Surface } from "./types.ts";

const MAX_BODY_BYTES = 1_000_000;

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
		if (size > MAX_BODY_BYTES) throw new Error("request body too large");
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

export function createHttpServer(substrate: Substrate, config: SubstrateConfig, observability: Observability) {
	return createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
		const authorization = req.headers.authorization ?? null;
		const surface: Surface | null = surfaceForToken(config, authorization);
		// What the transport establishes about the caller, before any request body is
		// read. A signed handoff's sender and a forced release's authority are decided
		// from this and never from an argument.
		const caller: McpCaller = { surface, isOperator: isOperator(config, authorization) };
		const route = normalizeRoute(url.pathname);

		// Measured from `finish` rather than at each `send` call site: that way every
		// exit — a 401 below, a thrown handler, the MCP transport writing its own
		// response — lands in the histogram with the status the client actually saw.
		const started = performance.now();
		const span = startRequestSpan(observability, req, route, surface);
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
		});

		// A configured deployment requires a token that names a surface; a bare local
		// run does not, otherwise the operator is locked out of their own machine.
		//
		// Every authenticated caller therefore has a surface. That is deliberate and
		// load-bearing: a caller with none would reach the authoring routes with no
		// identity, and each of them falls back to the body — so an operator
		// credential could have signed a handoff as any agent it named. An operator
		// token is a *surface* token that is also listed in
		// SUBSTRATE_OPERATOR_TOKENS, so its extra authority never comes at the cost
		// of knowing who used it.
		if (!config.allowAnonymous && surface === null) {
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
				const body = JSON.parse(raw) as Record<string, unknown>;
				if (!(await auditedRest(res, observability, surface, "events", body))) return;
				// A swarm token is its surface: naming another one is refused, not re-attributed.
				// Every other caller keeps the body-first attribution collectors rely on — see
				// `attributedSurface`.
				const attribution = attributedSurface(surface, typeof body.surface === "string" ? body.surface : null);
				if ("refused" in attribution) {
					sendJson(res, 403, { error: attribution.refused });
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
				// authenticated (a bare local run), and never merely because this
				// particular token named no surface.
				const sender = surface ?? (config.allowAnonymous ? bodySurface(body) : null);
				if (!sender) {
					sendJson(res, 403, {
						error: "this token names no surface, so it cannot be a handoff sender",
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
				if (typeof body.graph_id !== "string") {
					sendJson(res, 400, { error: "graph_id is required" });
					return;
				}
				if (!(await auditedRest(res, observability, surface, "verify", body))) return;
				sendJson(res, 200, await substrate.verifyGraph(body.graph_id));
				return;
			}

			if (url.pathname === "/mcp") {
				await handleMcp(req, res, substrate, caller, observability);
				return;
			}

			sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
		} catch (cause) {
			if (cause instanceof InvalidEventError || cause instanceof InvalidHandoffError) {
				sendJson(res, 400, { error: cause.message });
				return;
			}
			if (cause instanceof SyntaxError) {
				sendJson(res, 400, { error: "request body is not valid JSON" });
				return;
			}
			process.stderr.write(`[substrate] ${req.method} ${url.pathname}: ${String(cause)}\n`);
			if (!res.headersSent) sendJson(res, 500, { error: String(cause) });
		}
	});
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
): Promise<void> {
	if (req.method !== "POST") {
		// Stateless mode has no server-initiated stream to attach to.
		res.writeHead(405, { allow: "POST" }).end();
		return;
	}
	const raw = await readBody(req);
	const body: unknown = raw ? JSON.parse(raw) : undefined;

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
