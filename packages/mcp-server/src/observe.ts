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
	type ClaimDecision,
	type AuditTransport,
} from "@substrate/audit";
import {
	OtlpExporter,
	PeriodicExporter,
	PlaneWindow,
	SPAN_KIND,
	SubstrateInstruments,
	Tracer,
	evaluatePlaneSlos,
	evaluateSlos,
	loadObservabilityConfig,
	parseTraceparent,
	sloCatalogue,
	type ClaimOutcome,
	type MetricSnapshot,
	type PlaneName,
	type PlaneSloResult,
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
const KNOWN_ROUTES = [
	"/brief",
	"/events",
	"/events/stream",
	"/verify",
	"/healthz",
	"/mcp",
	"/metrics",
	"/slo",
	"/evidence",
	"/skills/propose",
	"/docs/search",
	"/docs/ingest",
	"/docs/merge-trigger",
	"/memory/recall",
] as const;

export function normalizeRoute(pathname: string): string {
	return (KNOWN_ROUTES as readonly string[]).includes(pathname) ? pathname : "other";
}

/**
 * The claim metric's outcome, from the substrate's verdict *and* the index's action.
 *
 * A takeover of another surface's expired lease is `decision: "granted"` with the
 * index reporting `action: "stolen"`, and `stolen` is the only outcome that increments
 * `substrate.lease.steals`. Reading the verdict alone mapped every takeover to
 * `granted`, so the lease-steal rate the SLO is stated over could not leave zero no
 * matter how many leases were taken — the objective existed and the numerator did not.
 *
 * The verdict wins where the two disagree: a steal whose event never reached the ledger
 * is `revoked`, and it did not happen, so it is not a steal.
 */
export function claimOutcome(decision: ClaimDecision, action?: string): ClaimOutcome {
	if (decision === "contended") return "contended";
	if (decision === "revoked") return "revoked";
	return action === "stolen" ? "stolen" : "granted";
}

/**
 * Record a withdrawn claim as a denial on the audit chain.
 *
 * The gate in front of the dispatcher records `graph_claim` as `allowed` — which is
 * true of the *call*: it was permitted to run. What happens next is that the claim's
 * event does not reach the ledger and `claimNode` withdraws the hold. Nothing then
 * wrote that to the chain, so the audit and the per-graph evidence bundle showed the
 * claim allowed and said nothing about the withdrawal — the exact opposite of the
 * decision the substrate made, in the document an incident is reconstructed from, and
 * during the one outage this fail-closed behaviour exists for.
 *
 * Appended as its own `denied` record rather than by amending the earlier one: the
 * chain is append-only, and both records are true — the call was allowed and the hold
 * was then withdrawn. `fail-open`, because the withdrawal has already happened and
 * refusing to write it cannot undo it; the reason is on stderr either way, and a
 * failed append is counted like any other.
 *
 * Fire-and-forget, because `SubstrateObserver` is synchronous by contract: nothing in
 * it may fail the turn it is instrumenting. The returned promise is awaited only by
 * tests.
 */
export async function recordClaimWithdrawal(
	audit: AuditLog,
	instruments: SubstrateInstruments,
	sample: { surface: string; graph_id: string; node_id: string; reason: string | null; quarantineReason: string | null },
): Promise<void> {
	const written = await audit
		.append({
			surface: sample.surface,
			tool: "graph_claim",
			transport: "internal",
			decision: "denied",
			mode: "fail-open",
			graph_id: sample.graph_id,
			node_id: sample.node_id,
			reason:
				`the claim was withdrawn after it was allowed: ${sample.reason ?? sample.quarantineReason ?? "no reason given"}`,
		})
		.then((appended) => appended.written)
		.catch(() => false);
	instruments.recordAudit({ decision: "denied", written });
	if (!written) {
		process.stderr.write(
			`[substrate] withdrew claim ${sample.graph_id}/${sample.node_id} for ${sample.surface} and could not record it\n`,
		);
	}
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
	/**
	 * The per-plane availability verdicts over the rolling hour (uplift-2 R2).
	 * `configured` says which planes may be judged; the rest report `unconfigured`.
	 */
	evaluatePlanes(configured: Partial<Record<PlaneName, boolean>>): PlaneSloResult[];
	start(): Promise<string[]>;
	stop(): void;
}

export function createObservability(config: SubstrateConfig, env: Record<string, string | undefined> = process.env): Observability {
	const settings = loadObservabilityConfig(env, SUBSTRATE_VERSION);
	const instruments = new SubstrateInstruments();
	const tracer = new Tracer({ maxSpans: settings.maxSpans, sampleRatio: settings.sampleRatio });
	const audit = new AuditLog({ path: config.audit.path, redact });
	const slos = sloCatalogue(settings.slo);
	/** One window per process: successive `/slo` reads are its samples. */
	const planeWindow = new PlaneWindow();
	/** How much of `tracer.dropped` has already been added to the monotonic counter. */
	let reportedSpanDrops = 0;

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
					//
					// The *delta*, not the total. `tracer.dropped` is itself cumulative, and
					// adding it whole to a monotonic counter every interval multiplies it —
					// five real drops would read as ten after two exports and fifteen after
					// three, turning a diagnostic into a fiction.
					const dropped = tracer.dropped;
					instruments.recordDroppedSpans(dropped - reportedSpanDrops);
					reportedSpanDrops = dropped;
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
		cached(sample) {
			instruments.recordCache(sample);
		},
		plane(sample) {
			instruments.recordPlane(sample);
		},
		admission(sample) {
			instruments.recordAdmission(sample);
		},
		claimed(sample) {
			instruments.recordClaim({
				surface: sample.surface,
				graph_id: sample.graph_id,
				outcome: claimOutcome(sample.decision, sample.action),
			});
			if (sample.quarantineReason) {
				instruments.recordQuarantine({
					surface: sample.surface,
					graph_id: sample.graph_id,
					reason: sample.quarantineReason,
				});
			}
			// A withdrawal is a decision the audit has to carry, and the pre-dispatch gate
			// cannot know about it yet: see `recordClaimWithdrawal`.
			if (sample.decision === "revoked") {
				void recordClaimWithdrawal(audit, instruments, sample);
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
		evaluatePlanes: (configured) =>
			evaluatePlaneSlos(instruments.snapshot(), {
				configured,
				window: planeWindow,
				...(settings.slo.planeAvailability !== undefined ? { target: settings.slo.planeAvailability } : {}),
				...(settings.slo.minSamples !== undefined ? { minSamples: settings.slo.minSamples } : {}),
			}),
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
			if (opened.missingHistory) {
				// Loud, at boot, and not only in a verdict somebody has to ask for. The operator
				// is the one who can say whether this was a rotation, a disk, or someone — and
				// the two cases point at different answers, so they must not read alike. A
				// rewritten file has the *same* count as was committed, so reporting it as
				// missing history printed two equal numbers and sent the reader after a deletion
				// that did not happen.
				const { kind, checkpointSeq, foundSeq } = opened.missingHistory;
				warnings.push(
					kind === "missing"
						? `mcp audit chain is missing history — ${checkpointSeq} record(s) were committed and the file accounts ` +
							`for ${foundSeq}; the chain continues from the checkpoint and every verification will report the gap`
						: `mcp audit chain has been rewritten — the record at seq ${checkpointSeq} is not the one whose hash was ` +
							"checkpointed, so the file holds a different chain than this deployment committed; the decisions it " +
							"shows are not the decisions that were made, and every verification will report it",
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
 * Every tool this substrate actually serves.
 *
 * The `tool` metric attribute is drawn from this list, not from the request. A
 * JSON-RPC `params.name` is an arbitrary caller-supplied string, so using it
 * directly let an authenticated caller mint one metric series per name it invented —
 * past the series cap, which collapses ids but kept `tool`. The audit chain still
 * records the name exactly as sent: that is a log, where the real value is the point,
 * and it is bounded by the file rather than by a process's live series map.
 */
const KNOWN_TOOLS: ReadonlySet<string> = new Set([
	// MCP tools, as `mcp.ts` registers them.
	"memory_brief",
	"memory_write",
	"memory_search",
	"memory_recall",
	"memory_pending",
	"events_emit",
	"events_query",
	"events_verify",
	"graph_get",
	"graph_register",
	"graph_bind",
	"graph_claim",
	"graph_heartbeat",
	"graph_release",
	"graph_complete",
	"graph_find",
	"issue_get",
	"coord_handoff",
	"coord_handoff_verify",
	"coord_handoff_list",
	"coord_drift_scan",
	"coord_reap_leases",
	"skills_propose",
	"docs_search",
	"docs_ingest",
	"desktop_run",
	// REST routes, as `server.ts` audits them. A route audited under a tool's own name
	// (`/memory` as `memory_write`) is covered by that name above and not repeated.
	"brief",
	"events",
	"verify",
	"drift",
	"evidence",
]);

/** The bounded form of a tool name, for a metric attribute. */
export function toolLabel(tool: string): string {
	return KNOWN_TOOLS.has(tool) ? tool : "unrecognized";
}

/**
 * Record each tool call, and report the ones that must not run.
 *
 * A fail-closed tool whose record the chain refuses is denied. The denial is then
 * itself appended as a fail-open record — it will usually be refused too, since the
 * sink is what failed, which is why it is also written to stderr. Recording the
 * attempt matters more than recording it durably: an operator reading the journal
 * still learns that a claim was turned away and why.
 *
 * **Fail-closed calls are recorded first**, whatever order they arrived in. A batch
 * is refused whole, so a denial on the third call means the first two never ran —
 * and recording them as `allowed` before knowing that would put a claim in the trail
 * that the substrate never carried out. Only a fail-closed append can produce a
 * denial, so doing those first means a refused batch leaves no false `allowed`
 * record for any fail-open member. Within the fail-closed group a denial can still
 * follow an earlier success, which is what `batchNotDispatched` is for: the trail
 * gets an explicit record saying those calls were recorded but not dispatched,
 * because an append-only chain is corrected by appending, never by editing.
 */
export async function auditToolCalls(
	observability: Pick<Observability, "audit" | "instruments">,
	surface: Surface | null,
	calls: McpToolCall[],
	transport: AuditTransport = "mcp",
): Promise<AuditOutcome> {
	const denials = new Map<string, string>();
	const ordered = [...calls].sort(
		(a, b) => Number(auditMode(a.tool) === "fail-open") - Number(auditMode(b.tool) === "fail-open"),
	);
	/** The calls this batch has already recorded `allowed`, for a correction to name. */
	const recorded: RecordedCall[] = [];

	for (const call of ordered) {
		const label = toolLabel(call.tool);
		const context = {
			surface: surface ?? "unknown",
			tool: call.tool,
			transport,
			graph_id: stringAt(call.args, "graph_id"),
			node_id: stringAt(call.args, "node_id"),
			session_id: stringAt(call.args, "session_id"),
		};
		// Once the batch is refused, nothing else will be dispatched, so nothing else is
		// recorded as allowed either.
		if (denials.size > 0) {
			observability.instruments.recordToolCall({ surface: context.surface, tool: label, decision: "denied" });
			continue;
		}
		try {
			const appended = await observability.audit.append({
				...context,
				decision: "allowed",
				mode: auditMode(call.tool),
				args: call.args,
			});
			observability.instruments.recordAudit({ decision: "allowed", written: appended.written });
			observability.instruments.recordToolCall({ surface: context.surface, tool: label, decision: "allowed" });
			recorded.push({ surface: context.surface, graph_id: context.graph_id });
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
			observability.instruments.recordToolCall({ surface: context.surface, tool: label, decision: "denied" });
			await batchNotDispatched(observability, transport, recorded);
		}
	}
	return { denials };
}

/** A call already recorded `allowed` in this batch, for the correction to name. */
interface RecordedCall {
	surface: string;
	graph_id: string | null;
}

/**
 * Append a correction when a refused batch had already recorded some calls allowed.
 *
 * The chain is append-only, so the earlier `allowed` records cannot be withdrawn.
 * They are true about what was *asked and permitted*; what changed is that the batch
 * was then refused whole and none of it ran. Saying so in its own record is the only
 * honest way to express that, and it keeps an incident reader from concluding a claim
 * was carried out.
 *
 * **One correction per graph the batch touched**, not one per batch. A record carries a
 * single `graph_id`, and `buildGraphEvidence` selects by exactly that field — so a
 * correction with no graph was filtered out of every bundle while the earlier
 * `allowed` record, which *does* name its graph, was kept. That graph's evidence then
 * showed a claim as allowed with nothing saying it never ran, which is precisely the
 * reading this correction exists to prevent. Each affected graph gets its own, counting
 * only its own calls; a call that named no graph is corrected under a null one, the same
 * place its `allowed` record sits.
 */
async function batchNotDispatched(
	observability: Pick<Observability, "audit" | "instruments">,
	transport: AuditTransport,
	recorded: RecordedCall[],
): Promise<void> {
	if (recorded.length === 0) return;

	const byGraph = new Map<string | null, { surface: string; count: number }>();
	for (const call of recorded) {
		const group = byGraph.get(call.graph_id);
		if (group) group.count++;
		else byGraph.set(call.graph_id, { surface: call.surface, count: 1 });
	}

	for (const [graph_id, { surface, count }] of byGraph) {
		const written = await observability.audit
			.append({
				surface,
				tool: "batch",
				transport,
				graph_id,
				decision: "denied",
				mode: "fail-open",
				reason:
					`the batch was refused whole after ${count} call(s)${graph_id ? " for this graph" : ""} had already ` +
					"been recorded as allowed; none of them was dispatched",
			})
			.then((appended) => appended.written)
			.catch(() => false);
		observability.instruments.recordAudit({ decision: "denied", written });
	}
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

/** How many of one graph's audit records a bundle carries. Beyond this, a note says so. */
export const MAX_EVIDENCE_RECORDS = 5000;

/**
 * Assemble the bundle for one graph.
 *
 * Only audit records naming the graph are included — a record with no `graph_id`
 * belongs to no graph, and folding those in would make every bundle a copy of the
 * whole trail.
 *
 * **One pass over the audit file, not two.** Verifying it and then selecting the
 * graph's records used to be two whole reads and two whole parses, with the request's
 * own record appended between them — so an ordinary authenticated `/evidence` call cost
 * twice a trail that has no compaction, and a few of them in a row could take the MCP
 * process down with the substrate on the critical path of every prompt on the host.
 * `verifiedView` does both in one streaming pass, holds this graph's records rather
 * than all of them, and stops collecting at `MAX_EVIDENCE_RECORDS` — so the cost is
 * proportional to the graph being asked about, whatever the file grew to around it.
 */
export async function buildGraphEvidence(
	observability: Observability,
	substrate: Substrate,
	graphId: string,
	notes: string[] = [],
	/** How many of the graph's records to list. Lowered by tests that exercise the bound. */
	maxRecords: number = MAX_EVIDENCE_RECORDS,
): Promise<EvidenceBundle> {
	const appChain = await substrate
		// Anchors stay out of the bundle (FEATURES E-D1): the evidence chain is
		// the per-session hash check, whatever devnet says about the hour.
		.verifyGraph(graphId, { anchors: false })
		.then((verdict) => ({
			// `state`, not just `ok`. A null `ok` used to mean both "there is no ledger to
			// check" and "the ledger would not answer", and those are opposite facts about
			// an evidence document: one is a deployment that has no app chain, the other is
			// a chain that exists and could not be verified. `substrate evidence` has to
			// exit non-zero on the second and not on the first, so the bundle has to say
			// which — see `chainState` and `cmdEvidence`.
			state: verdict.reason === "greptime not configured" ? ("not-configured" as const) : chainState(verdict.ok),
			ok: verdict.reason === "greptime not configured" ? null : verdict.ok,
			records: verdict.events,
			...(verdict.brokenAt ? { brokenAt: verdict.brokenAt } : {}),
			...(verdict.reason ? { reason: verdict.reason } : {}),
		}))
		.catch((cause: unknown) => ({
			state: "unverifiable" as const,
			ok: null,
			records: 0,
			reason: redact(String(cause)),
		}));

	const {
		verdict: chain,
		records: forGraph,
		total,
		stats,
		matched,
		selector,
	} = await observability.audit.verifiedView(graphId, maxRecords);

	const lost = observability.audit.missingHistory;

	return buildEvidence({
		// The cleaned form, not the string the caller asked with: it is the key both the audit
		// records and the metric attributes are stored under, and this document must not echo
		// a credential that every other field redacted. They are the same string for every
		// ordinary identifier. See `EvidenceInput.graph_id`.
		graph_id: selector,
		service: observability.resource,
		slos: observability.evaluate(),
		appChain,
		audit: {
			chain,
			durable: observability.audit.durable,
			path: observability.audit.path,
			records: forGraph,
			// The tally covers every record naming this graph; `records` is the listed window
			// of them. Deriving the counts from the window would understate a busy graph.
			stats,
			// A cleaned identifier is not a unique key: another graph cleaning to the same
			// string is indistinguishable once stored, so this selection cannot be claimed as
			// one graph's. `substrate evidence` exits non-zero on it.
			attribution: selector === graphId ? "exact" : "ambiguous",
		},
		metrics: observability.snapshot(),
		// Every note names the graph by `selector`, never by the raw `graphId`. A note is
		// bundle content — it lands in the JSON, in the HTML rendered from it, and in whatever
		// archive those end up in — so interpolating the requested identifier there put the
		// credential back into the document that `graph_id` had just been cleaned to keep out.
		notes: [
			...(matched === 0 && total > 0
				? [`No MCP audit record names ${selector}; ${total} record(s) in the chain belong to other graphs or to none.`]
				: []),
			...(matched > forGraph.length
				? [
						`${matched} audit records name ${selector} and the ${forGraph.length} most recent are listed; the tally above ` +
							`counts all ${matched}, and the chain verdict covers all ${total} record(s) in the file.`,
					]
				: []),
			...(selector !== graphId
				? [
						"The identifier this bundle was requested with is not the one named above: redaction or the length cap " +
							"changed it, so the graph is named, keyed and reported here in its stored form. Another graph whose " +
							"identifier cleans to the same string would share this selection, and nothing in the audit file can " +
							"separate them — which is why the attribution is `ambiguous`.",
					]
				: []),
			...(lost
				? [
						lost.kind === "missing"
							? "The MCP audit file is missing history: this process committed more records than the file now accounts " +
								"for, so decisions taken before the loss are not in this bundle and cannot be recovered from it."
							: "The MCP audit file has been replaced: the record at the last checkpointed position is not the one whose " +
								"hash was committed, so the decisions this bundle lists are not the decisions that were made.",
					]
				: []),
			...notes,
		],
	});
}

/** A verdict's three-way state, for the `ok` a bundle carries alongside it. */
export function chainState(ok: boolean | null): "verified" | "broken" | "unverifiable" {
	if (ok === true) return "verified";
	if (ok === false) return "broken";
	return "unverifiable";
}

export { auditStats, renderEvidenceHtml };
