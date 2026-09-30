/**
 * Where the observability and audit planes meet substrate-mcp.
 *
 * All the logic lives in `@substrate/observability` and `@substrate/audit`; this
 * file is the adapter, so the server and the service keep thin diffs and the
 * decisions stay unit-testable without a socket.
 *
 * Two things here are more than plumbing and are worth reading:
 *
 *   - `toolCallsIn` / `auditToolCalls` put the audit **in front of** the MCP
 *     dispatcher rather than inside each tool. A fail-closed tool therefore cannot
 *     run unaudited even by accident, because nothing dispatches it until the chain
 *     has taken the record.
 *   - `normalizeRoute` bounds the `route` attribute. A scanner walking random paths
 *     would otherwise mint one metric series per URL it tried.
 */
import {
	AuditLog,
	AuditUnavailableError,
	auditMode,
	auditStats,
	type AuditRecord,
	type AuditTransport,
} from "@substrate/audit";
import {
	OtlpExporter,
	PeriodicExporter,
	SPAN_KIND,
	SubstrateInstruments,
	Tracer,
	evaluateSlos,
	loadObservabilityConfig,
	parseTraceparent,
	sloCatalogue,
	type MetricSnapshot,
	type SloResult,
	type SloTarget,
	type Span,
	type SpanContext,
} from "@substrate/observability";
import { buildEvidence, renderEvidenceHtml, type EvidenceBundle } from "@substrate/evidence";
import type { IncomingMessage } from "node:http";
import type { SubstrateConfig } from "./config.ts";
import { redact } from "./redact.ts";
import type { Substrate, SubstrateObserver } from "./service.ts";
import type { Surface } from "./types.ts";

/** Kept in step with `packages/mcp-server/package.json`. Reported as `service.version`. */
export const SUBSTRATE_VERSION = "0.1.0";

/** Routes that exist. Anything else is `other`, so the attribute stays bounded. */
const KNOWN_ROUTES = ["/brief", "/events", "/verify", "/healthz", "/mcp", "/metrics", "/slo", "/evidence"] as const;

export function normalizeRoute(pathname: string): string {
	return (KNOWN_ROUTES as readonly string[]).includes(pathname) ? pathname : "other";
}

export interface Observability {
	readonly instruments: SubstrateInstruments;
	readonly tracer: Tracer;
	readonly audit: AuditLog;
	readonly slos: SloTarget[];
	readonly startedAt: number;
	readonly resource: { name: string; version: string; instance: string };
	readonly exporter: PeriodicExporter | null;
	/** The observer handed to `Substrate`, so brief/emit/claim are measured. */
	readonly observer: SubstrateObserver;
	snapshot(): MetricSnapshot[];
	evaluate(): SloResult[];
	start(): Promise<string[]>;
	stop(): void;
}

export function createObservability(config: SubstrateConfig, env: Record<string, string | undefined> = process.env): Observability {
	const settings = loadObservabilityConfig(env, SUBSTRATE_VERSION);
	const instruments = new SubstrateInstruments();
	const tracer = new Tracer({ maxSpans: settings.maxSpans, sampleRatio: settings.sampleRatio });
	const audit = new AuditLog({ path: config.audit.path, redact });
	const slos = sloCatalogue(settings.slo);

	const exporter = settings.exportEnabled
		? new PeriodicExporter({
				exporter: new OtlpExporter(settings.otlp, { redact }),
				snapshot: () => instruments.snapshot(),
				drainSpans: () => tracer.drain(),
				startedAt: instruments.registry.startedAt,
				intervalMs: settings.intervalMs,
				onResult: (result) => {
					// The tracer's own drops are a metric, not a silence: a buffer that is
					// overflowing is a fact about the deployment.
					instruments.recordDroppedSpans(tracer.dropped);
					for (const outcome of [result.metrics, result.traces]) {
						if (!outcome.ok && outcome.items > 0) {
							process.stderr.write(`[substrate] otlp export failed (${outcome.items} items): ${outcome.error ?? outcome.status}\n`);
						}
					}
				},
			})
		: null;

	const observer: SubstrateObserver = {
		briefed(sample) {
			instruments.recordBrief(sample);
		},
		emitted(sample) {
			instruments.recordEmit(sample);
		},
		claimed(sample) {
			instruments.recordClaim({
				surface: sample.surface,
				graph_id: sample.graph_id,
				outcome: sample.decision === "granted" ? "granted" : sample.decision === "contended" ? "contended" : "revoked",
			});
			if (sample.quarantineReason) {
				instruments.recordQuarantine({
					surface: sample.surface,
					graph_id: sample.graph_id,
					reason: sample.quarantineReason,
				});
			}
		},
	};

	return {
		instruments,
		tracer,
		audit,
		slos,
		startedAt: instruments.registry.startedAt,
		resource: {
			name: settings.otlp.resource.serviceName,
			version: settings.otlp.resource.serviceVersion,
			instance: settings.otlp.resource.serviceInstanceId,
		},
		exporter,
		observer,
		snapshot: () => instruments.snapshot(),
		evaluate: () => evaluateSlos(instruments.snapshot(), slos),
		async start() {
			const warnings: string[] = [];
			const opened = await audit.open();
			if (!opened.durable) {
				warnings.push(
					opened.error
						? `mcp audit chain is not durable — ${opened.error}; fail-closed tools will be refused`
						: "mcp audit chain is in memory only (SUBSTRATE_AUDIT_PATH is unset) and ends at the next restart",
				);
			}
			if (!settings.exportEnabled) {
				warnings.push("no OTLP endpoint configured; metrics are collected and served but not exported");
			}
			exporter?.start();
			return warnings;
		},
		stop() {
			exporter?.stop();
		},
	};
}

// ── MCP audit gate ───────────────────────────────────────────────────────────

export interface McpToolCall {
	id: unknown;
	tool: string;
	args: unknown;
}

/**
 * The `tools/call` requests in a JSON-RPC body, batch or single.
 *
 * Anything else — `initialize`, `tools/list`, a notification — is not an action and
 * is not audited: a trail that recorded every handshake would bury the decisions it
 * exists to show.
 */
export function toolCallsIn(body: unknown): McpToolCall[] {
	const elements = Array.isArray(body) ? body : [body];
	const calls: McpToolCall[] = [];
	for (const element of elements) {
		if (!element || typeof element !== "object") continue;
		const message = element as { method?: unknown; id?: unknown; params?: unknown };
		if (message.method !== "tools/call") continue;
		const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
		if (typeof params.name !== "string") continue;
		calls.push({ id: message.id ?? null, tool: params.name, args: params.arguments });
	}
	return calls;
}

function stringAt(args: unknown, key: string): string | null {
	if (!args || typeof args !== "object" || Array.isArray(args)) return null;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

export interface AuditOutcome {
	/** id → message, for the calls that must not be dispatched. */
	denials: Map<string, string>;
}

/**
 * Record each tool call, and report the ones that must not run.
 *
 * A fail-closed tool whose record the chain refuses is denied. The denial is then
 * itself appended as a fail-open record — it will usually be refused too, since the
 * sink is what failed, which is why it is also written to stderr. Recording the
 * attempt matters more than recording it durably: an operator reading the journal
 * still learns that a claim was turned away and why.
 */
export async function auditToolCalls(
	observability: Pick<Observability, "audit" | "instruments">,
	surface: Surface | null,
	calls: McpToolCall[],
	transport: AuditTransport = "mcp",
): Promise<AuditOutcome> {
	const denials = new Map<string, string>();
	for (const call of calls) {
		const context = {
			surface: surface ?? "unknown",
			tool: call.tool,
			transport,
			graph_id: stringAt(call.args, "graph_id"),
			node_id: stringAt(call.args, "node_id"),
			session_id: stringAt(call.args, "session_id"),
		};
		try {
			const appended = await observability.audit.append({
				...context,
				decision: "allowed",
				mode: auditMode(call.tool),
				args: call.args,
			});
			observability.instruments.recordAudit({ decision: "allowed", written: appended.written });
			observability.instruments.recordToolCall({ surface: context.surface, tool: call.tool, decision: "allowed" });
		} catch (cause) {
			if (!(cause instanceof AuditUnavailableError)) throw cause;
			const message = redact(cause.message);
			denials.set(String(call.id), message);
			process.stderr.write(`[substrate] denied ${call.tool} for ${context.surface} — ${message}\n`);
			const written = await observability.audit
				.append({ ...context, decision: "denied", mode: "fail-open", reason: message, args: call.args })
				.then((appended) => appended.written)
				.catch(() => false);
			observability.instruments.recordAudit({ decision: "denied", written });
			observability.instruments.recordToolCall({ surface: context.surface, tool: call.tool, decision: "denied" });
		}
	}
	return { denials };
}

const BATCH_REFUSED =
	"not dispatched: another call in this batch could not be recorded in the MCP audit chain, and the batch is " +
	"refused whole rather than partly applied";

/**
 * The JSON-RPC error body for a refused request.
 *
 * A batch is refused whole. Dispatching the allowed half would leave the caller
 * holding a partial result it has no way to tell from a complete one, and MCP
 * clients send one call per request in practice, so nothing real pays for the
 * strictness.
 */
export function auditRefusal(body: unknown, denials: Map<string, string>): unknown {
	const elements = Array.isArray(body) ? body : [body];
	const responses = elements.map((element) => {
		const id = element && typeof element === "object" ? ((element as { id?: unknown }).id ?? null) : null;
		return {
			jsonrpc: "2.0" as const,
			id,
			error: { code: -32000, message: denials.get(String(id)) ?? BATCH_REFUSED },
		};
	});
	return Array.isArray(body) ? responses : responses[0];
}

// ── request instrumentation ──────────────────────────────────────────────────

export function traceparentOf(req: IncomingMessage): SpanContext | null {
	const header = req.headers.traceparent;
	return parseTraceparent(Array.isArray(header) ? header[0] : header);
}

/** A server span for one request, with the substrate's own attributes on it. */
export function startRequestSpan(
	observability: Pick<Observability, "tracer">,
	req: IncomingMessage,
	route: string,
	surface: Surface | null,
): Span {
	return observability.tracer.startSpan(`${req.method ?? "GET"} ${route}`, {
		kind: SPAN_KIND.server,
		parent: traceparentOf(req),
		attributes: {
			"http.request.method": req.method ?? "GET",
			"http.route": route,
			"substrate.surface": surface,
		},
	});
}

// ── evidence ─────────────────────────────────────────────────────────────────

/**
 * Assemble the bundle for one graph.
 *
 * Only audit records naming the graph are included — a record with no `graph_id`
 * belongs to no graph, and folding those in would make every bundle a copy of the
 * whole trail.
 */
export async function buildGraphEvidence(
	observability: Observability,
	substrate: Substrate,
	graphId: string,
	notes: string[] = [],
): Promise<EvidenceBundle> {
	const appChain = await substrate
		.verifyGraph(graphId)
		.then((verdict) => ({
			ok: verdict.reason === "greptime not configured" ? null : verdict.ok,
			records: verdict.events,
			...(verdict.brokenAt ? { brokenAt: verdict.brokenAt } : {}),
			...(verdict.reason ? { reason: verdict.reason } : {}),
		}))
		.catch((cause: unknown) => ({ ok: null, records: 0, reason: redact(String(cause)) }));

	const chain = await observability.audit.verify();
	const { records } = await observability.audit.readAll();
	const forGraph = records.filter((record: AuditRecord) => record.graph_id === graphId);

	return buildEvidence({
		graph_id: graphId,
		service: observability.resource,
		slos: observability.evaluate(),
		appChain,
		audit: {
			chain,
			durable: observability.audit.durable,
			path: observability.audit.path,
			records: forGraph,
		},
		metrics: observability.snapshot(),
		notes: [
			...(forGraph.length === 0 && records.length > 0
				? [`No MCP audit record names ${graphId}; ${records.length} record(s) in the chain belong to other graphs or to none.`]
				: []),
			...notes,
		],
	});
}

export { auditStats, renderEvidenceHtml };
