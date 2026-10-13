/**
 * The substrate's own instruments, named once so the SLOs, the `/metrics` route
 * and the evidence bundle all refer to the same series.
 *
 * Every latency and error instrument carries `surface` and `graph_id`, which is
 * the pair the substrate is keyed by: `surface` says which of the eight agents on
 * the host, `graph_id` says which uplifted prompt. `graph_id` is unbounded, so
 * `MetricRegistry` collapses it to `_overflow` past the series cap — see
 * `VOLATILE_ATTRIBUTES`.
 */
import type { PlaneSample } from "./breaker.ts";
import type { AttributeValue, Counter, Histogram, MetricSnapshot } from "./metrics.ts";
import { LATENCY_BUCKETS_MS, MetricRegistry, cleanAttributes } from "./metrics.ts";

export const METRIC = {
	briefDuration: "substrate.brief.duration",
	emitDuration: "substrate.emit.duration",
	emitTotal: "substrate.emit.total",
	requestDuration: "substrate.request.duration",
	requestTotal: "substrate.request.total",
	toolCalls: "substrate.tool.calls",
	tokens: "substrate.tokens",
	cost: "substrate.cost.usd",
	claims: "substrate.lease.claims",
	leaseSteals: "substrate.lease.steals",
	quarantines: "substrate.quarantine.total",
	auditAppends: "substrate.audit.appends",
	spansDropped: "substrate.trace.spans_dropped",
	eventsRefused: "substrate.events.refused",
	anonymousRequests: "substrate.anonymous.requests",
	cacheOperations: "substrate.cache.operations",
	planeDuration: "substrate.plane.duration",
	planeErrors: "substrate.plane.errors",
	admissionDecisions: "substrate.admission.decisions",
	docsSearch: "substrate.docs.search",
	docsCitations: "substrate.docs.citations",
	docsDuration: "substrate.docs.duration",
	memoryExpired: "substrate.memory.expired",
} as const;

/** What one docs search answered with. One series each, so the label stays bounded. */
export const DOCS_SEARCH_OUTCOMES = ["hit", "empty", "degraded"] as const;
export type DocsSearchOutcome = (typeof DOCS_SEARCH_OUTCOMES)[number];

/**
 * Where a citation's commit came from (uplift-3 N5): the document's own
 * ingest record (`recorded`), a record uploaded without a commit
 * (`unpinned`), or no record at all (`unrecorded`). The closed set the
 * `dataset-pin:<name>:<marker>` commit markers already define.
 */
export const CITATION_PROVENANCES = ["recorded", "unrecorded", "unpinned"] as const;
export type CitationProvenance = (typeof CITATION_PROVENANCES)[number];

/**
 * The end-to-end docs search histogram's bounds. The shared default set has
 * no edge at the `docs.search.p95` objective (2,000 ms) nor at the default
 * budget (4,000 ms), and a latency objective is only decidable at one of
 * its histogram's own edges (`evaluateLatency`), so this histogram carries
 * both.
 */
export const DOCS_LATENCY_BUCKETS_MS: readonly number[] = [25, 50, 100, 200, 400, 800, 1000, 2000, 4000, 8000];

/** One finished docs search, as the service measured it around the cache wrapper. */
export interface DocsSearchSample {
	surface: string;
	outcome: DocsSearchOutcome;
	/** Whether the answer came from the cache (no plane call) or was loaded. */
	cached: boolean;
	durationMs: number;
	/** How many returned citations carry each provenance; absent keys count zero. */
	citations: Partial<Record<CitationProvenance, number>>;
}

/** What a read did with an expired memory entry: served it tagged (`report`) or left it out (`enforce`). */
export const MEMORY_EXPIRED_MODES = ["served", "hidden"] as const;
export type MemoryExpiredMode = (typeof MEMORY_EXPIRED_MODES)[number];

/** Why a plane call failed. One series each, so the reason stays bounded. */
export const PLANE_ERROR_REASONS = ["timeout", "network", "server", "open", "other"] as const;
export type PlaneErrorReason = (typeof PLANE_ERROR_REASONS)[number];

/**
 * The bounded reason for one failed plane sample.
 *
 * `timeout` and `open` are outcomes the gate already classified. An `error`
 * outcome carries the client's message: a `server <status>` from `gatedFetch`
 * or a `greptime 5xx` is the plane answering broken; a socket-level message is
 * the plane not answering at all; anything else is `other`. The message itself
 * is never an attribute.
 */
export function classifyPlaneReason(sample: PlaneSample): PlaneErrorReason | null {
	if (sample.outcome === "ok") return null;
	if (sample.outcome === "timeout" || sample.outcome === "open") return sample.outcome;
	const reason = sample.reason ?? "";
	if (/\b5\d\d\b/.test(reason)) return "server";
	if (/ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|unreachable|fetch failed|socket|Unable to connect|connection/i.test(reason)) {
		return "network";
	}
	return "other";
}

/**
 * The admission budget classes (uplift-3 N3). `coordination` is its own class so
 * a heartbeat or a release never queues behind a storm of reads; a lease lost to
 * throttling is the failure the budgets must not cause.
 */
export const ADMISSION_CLASSES = ["read", "write", "coordination"] as const;
export type AdmissionClass = (typeof ADMISSION_CLASSES)[number];

/**
 * What the bucket decided. `shadow_limited` is a refusal that was not enforced
 * (`SUBSTRATE_BUDGETS=shadow`); `bypass` is the cache not answering, which admits.
 */
export const ADMISSION_DECISIONS = ["allowed", "limited", "shadow_limited", "bypass"] as const;
export type AdmissionDecision = (typeof ADMISSION_DECISIONS)[number];

/** Why a `POST /events` was refused with 4xx. One series each, so the reason stays bounded. */
export const EVENT_REFUSAL_REASONS = ["auth", "validation", "attribution", "graph_id"] as const;
export type EventRefusalReason = (typeof EVENT_REFUSAL_REASONS)[number];

/**
 * The only 400 whose reason is `graph_id`. Matched whole, because the message
 * of every other 400 can quote a caller-supplied value — `unknown kind: graph_id`
 * is a bad kind, not a bad graph id.
 */
const GRAPH_ID_REFUSAL = "graph_id must be a string";

/**
 * Which refusal bucket a `POST /events` 4xx belongs in.
 *
 * `graph_id` is its own bucket rather than validation: a bad graph id is the
 * checklist Phase 19 reads, and folding it into validation would hide it.
 * Anything that is not a 4xx refusal of the post — a 503 from the ledger, a
 * 200 — is not a refusal and returns null.
 */
export function classifyEventRefusal(status: number, error: string | undefined): EventRefusalReason | null {
	if (status === 401) return "auth";
	if (status === 403) return "attribution";
	if (status !== 400) return null;
	return error === GRAPH_ID_REFUSAL ? "graph_id" : "validation";
}

/** Why a claim ended the way it did. Drives both the lease-steal and quarantine SLOs. */
export const CLAIM_OUTCOMES = ["granted", "contended", "stolen", "revoked"] as const;
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];

/**
 * Token and cost accounting as a collector reports it.
 *
 * The canonical payload shape is `payload.usage = { input_tokens, output_tokens,
 * cost_usd, model }`. The aliases exist because five collectors already speak
 * different dialects — Anthropic's `input_tokens`, OpenAI's `prompt_tokens`, and
 * the connector's own `tokens_in` — and rewriting all of them is not this ticket.
 * Normalising on read costs one function and no coordination.
 */
export interface Usage {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	model: string | null;
}

function numberAt(source: Record<string, unknown>, keys: string[]): number {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
		// A collector that shipped its counts as strings still gets counted.
		if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value)) return Number(value);
	}
	return 0;
}

/**
 * Pull usage out of an event payload, from `payload.usage` or the payload root.
 *
 * `null` when the payload carries no usage at all, so a `shell` or `file.edit`
 * event does not contribute a zero to the token counters and drag the per-graph
 * averages down.
 */
export function extractUsage(payload: Record<string, unknown> | undefined): Usage | null {
	if (!payload) return null;
	const nested = payload.usage;
	const source: Record<string, unknown> =
		nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : payload;

	const inputTokens = numberAt(source, ["input_tokens", "tokens_in", "prompt_tokens"]);
	const outputTokens = numberAt(source, ["output_tokens", "tokens_out", "completion_tokens"]);
	const costUsd = numberAt(source, ["cost_usd", "cost", "usd"]);
	const total = numberAt(source, ["total_tokens", "tokens"]);
	const model = typeof source.model === "string" ? source.model : null;

	if (inputTokens === 0 && outputTokens === 0 && costUsd === 0 && total === 0) return null;
	// A collector that reports only a total is credited on the input side rather
	// than split by a guess: an invented output count would be indistinguishable
	// from a measured one.
	return {
		inputTokens: inputTokens === 0 && outputTokens === 0 ? total : inputTokens,
		outputTokens,
		costUsd,
		model,
	};
}

type Attrs = Record<string, AttributeValue | null | undefined>;

/** Every instrument, plus the recorders each call site uses. */
export class SubstrateInstruments {
	readonly registry: MetricRegistry;

	readonly briefDuration: Histogram;
	readonly emitDuration: Histogram;
	readonly requestDuration: Histogram;
	readonly emitTotal: Counter;
	readonly requestTotal: Counter;
	readonly toolCalls: Counter;
	readonly tokens: Counter;
	readonly cost: Counter;
	readonly claims: Counter;
	readonly leaseSteals: Counter;
	readonly quarantines: Counter;
	readonly auditAppends: Counter;
	readonly spansDropped: Counter;
	readonly eventsRefused: Counter;
	readonly anonymousRequests: Counter;
	readonly cacheOperations: Counter;
	readonly planeDuration: Histogram;
	readonly planeErrors: Counter;
	readonly admissionDecisions: Counter;
	readonly docsSearch: Counter;
	readonly docsCitations: Counter;
	readonly docsDuration: Histogram;
	readonly memoryExpired: Counter;

	constructor(registry: MetricRegistry = new MetricRegistry()) {
		this.registry = registry;
		const ms = { unit: "ms", bounds: LATENCY_BUCKETS_MS };

		this.briefDuration = registry.histogram(METRIC.briefDuration, {
			...ms,
			description: "Time to compose a session brief. The SLO subject: p95 <= 800 ms.",
		});
		this.emitDuration = registry.histogram(METRIC.emitDuration, {
			...ms,
			description: "Time to normalise, chain and append one event.",
		});
		this.requestDuration = registry.histogram(METRIC.requestDuration, {
			...ms,
			description: "Time to serve one substrate-mcp request, by route.",
		});
		this.emitTotal = registry.counter(METRIC.emitTotal, {
			description: "Events accepted by the ledger (outcome=stored) or refused (outcome=dropped).",
			unit: "{event}",
		});
		this.requestTotal = registry.counter(METRIC.requestTotal, {
			description: "substrate-mcp requests by route and HTTP status class.",
			unit: "{request}",
		});
		this.toolCalls = registry.counter(METRIC.toolCalls, {
			description: "MCP tool calls by tool and audit decision (allowed|denied).",
			unit: "{call}",
		});
		this.tokens = registry.counter(METRIC.tokens, {
			description: "Model tokens attributed to a surface and graph, by direction.",
			unit: "{token}",
		});
		this.cost = registry.counter(METRIC.cost, {
			valueType: "double",
			description: "Model spend in USD attributed to a surface and graph.",
			unit: "USD",
		});
		this.claims = registry.counter(METRIC.claims, {
			description: "Node claim attempts by outcome (granted|contended|stolen|revoked).",
			unit: "{claim}",
		});
		this.leaseSteals = registry.counter(METRIC.leaseSteals, {
			description: "Claims granted while another surface's lease was live. The lease-steal SLO numerator.",
			unit: "{claim}",
		});
		this.quarantines = registry.counter(METRIC.quarantines, {
			description: "Nodes withdrawn from dispatch, by reason. The quarantine SLO numerator.",
			unit: "{node}",
		});
		this.auditAppends = registry.counter(METRIC.auditAppends, {
			description: "MCP audit chain appends by decision and whether the chain took the record.",
			unit: "{record}",
		});
		this.spansDropped = registry.counter(METRIC.spansDropped, {
			description: "Spans discarded because the export buffer was full.",
			unit: "{span}",
		});
		this.eventsRefused = registry.counter(METRIC.eventsRefused, {
			description: "POST /events refusals by reason (auth|validation|attribution|graph_id).",
			unit: "{event}",
		});
		this.anonymousRequests = registry.counter(METRIC.anonymousRequests, {
			description: "Untokened requests accepted while anonymous mode is on, by route and claimed surface.",
			unit: "{request}",
		});
		this.cacheOperations = registry.counter(METRIC.cacheOperations, {
			description: "Read-through cache results (hit|miss|bypass|error) and the mode they were counted in.",
			unit: "{operation}",
		});
		this.planeDuration = registry.histogram(METRIC.planeDuration, {
			...ms,
			description: "Time per outbound call to a data plane, by plane, bounded op and outcome (ok|error|timeout|open).",
		});
		this.planeErrors = registry.counter(METRIC.planeErrors, {
			description: "Failed plane calls by plane and reason (timeout|network|server|open|other).",
			unit: "{call}",
		});
		this.admissionDecisions = registry.counter(METRIC.admissionDecisions, {
			description: "Admission budget decisions by surface, class (read|write|coordination) and decision (allowed|limited|shadow_limited|bypass).",
			unit: "{decision}",
		});
		this.docsSearch = registry.counter(METRIC.docsSearch, {
			description: "Docs searches by surface, outcome (hit|empty|degraded) and whether the cache answered (cached=true|false).",
			unit: "{search}",
		});
		this.docsCitations = registry.counter(METRIC.docsCitations, {
			description: "Citations returned by docs searches, by commit provenance (recorded|unrecorded|unpinned).",
			unit: "{citation}",
		});
		this.docsDuration = registry.histogram(METRIC.docsDuration, {
			unit: "ms",
			bounds: DOCS_LATENCY_BUCKETS_MS,
			description: "End-to-end time to answer one docs search, by surface and cached. The docs.search.p95 subject: p95 <= 2000 ms.",
		});
		this.memoryExpired = registry.counter(METRIC.memoryExpired, {
			description:
				"Memory entries past their ttl met by an index read, by caller surface, memory kind and what was done (served|hidden).",
			unit: "{entry}",
		});
	}

	snapshot(): MetricSnapshot[] {
		return this.registry.snapshot();
	}

	recordBrief(sample: { surface: string; graph_id?: string | null; ok: boolean; durationMs: number }): void {
		this.briefDuration.record(
			sample.durationMs,
			cleanAttributes({ surface: sample.surface, graph_id: sample.graph_id, outcome: sample.ok ? "ok" : "error" }),
		);
	}

	/**
	 * One emit: its latency, whether the ledger took it, and any usage it carried.
	 *
	 * `outcome` is `stored` or `dropped` rather than a boolean because it is the
	 * emit-success SLO's selector, and the SLO reads attributes as strings.
	 */
	recordEmit(sample: {
		surface: string;
		graph_id?: string | null;
		kind: string;
		stored: boolean;
		durationMs: number;
		payload?: Record<string, unknown>;
	}): void {
		const attributes = cleanAttributes({ surface: sample.surface, graph_id: sample.graph_id, kind: sample.kind });
		this.emitDuration.record(sample.durationMs, attributes);
		this.emitTotal.add(1, { ...attributes, outcome: sample.stored ? "stored" : "dropped" });
		this.recordUsage({ surface: sample.surface, graph_id: sample.graph_id, payload: sample.payload });
	}

	recordUsage(sample: {
		surface: string;
		graph_id?: string | null;
		payload?: Record<string, unknown>;
	}): Usage | null {
		const usage = extractUsage(sample.payload);
		if (!usage) return null;
		const base: Attrs = { surface: sample.surface, graph_id: sample.graph_id, model: usage.model };
		if (usage.inputTokens > 0) this.tokens.add(usage.inputTokens, cleanAttributes({ ...base, direction: "input" }));
		if (usage.outputTokens > 0) this.tokens.add(usage.outputTokens, cleanAttributes({ ...base, direction: "output" }));
		if (usage.costUsd > 0) this.cost.add(usage.costUsd, cleanAttributes(base));
		return usage;
	}

	recordRequest(sample: { surface: string; route: string; status: number; durationMs: number }): void {
		const attributes = cleanAttributes({
			surface: sample.surface,
			route: sample.route,
			// A status class, not the code: `4xx` keeps the series count flat while
			// still separating a caller's fault from the substrate's.
			status: `${Math.floor(sample.status / 100)}xx`,
		});
		this.requestDuration.record(sample.durationMs, attributes);
		this.requestTotal.add(1, attributes);
	}

	recordToolCall(sample: { surface: string; tool: string; decision: "allowed" | "denied" }): void {
		this.toolCalls.add(1, cleanAttributes({ surface: sample.surface, tool: sample.tool, decision: sample.decision }));
	}

	recordClaim(sample: { surface: string; graph_id?: string | null; outcome: ClaimOutcome }): void {
		const attributes = cleanAttributes({ surface: sample.surface, graph_id: sample.graph_id });
		this.claims.add(1, { ...attributes, outcome: sample.outcome });
		if (sample.outcome === "stolen") this.leaseSteals.add(1, attributes);
	}

	recordQuarantine(sample: { surface: string; graph_id?: string | null; reason: string }): void {
		this.quarantines.add(1, cleanAttributes({ surface: sample.surface, graph_id: sample.graph_id, reason: sample.reason }));
	}

	recordAudit(sample: { decision: "allowed" | "denied"; written: boolean }): void {
		this.auditAppends.add(1, { decision: sample.decision, outcome: sample.written ? "written" : "lost" });
	}

	recordDroppedSpans(count: number): void {
		if (count > 0) this.spansDropped.add(count);
	}

	/** One refused `POST /events`. The reason is the closed set in `EVENT_REFUSAL_REASONS`. */
	recordEventRefusal(sample: { reason: EventRefusalReason }): void {
		this.eventsRefused.add(1, { reason: sample.reason });
	}

	recordCache(sample: { result: "hit" | "miss" | "bypass" | "error"; mode: "off" | "on" | "degraded" }): void {
		this.cacheOperations.add(1, { result: sample.result, mode: sample.mode });
	}

	/**
	 * One outbound plane call, as `callPlane` observed it. `op` is a label the
	 * client fixed — a route-table entry or a SQL verb — never a statement.
	 */
	recordPlane(sample: PlaneSample): void {
		this.planeDuration.record(sample.durationMs, { plane: sample.plane, op: sample.op, outcome: sample.outcome });
		const reason = classifyPlaneReason(sample);
		if (reason !== null) this.planeErrors.add(1, { plane: sample.plane, reason });
	}

	/**
	 * One expired memory entry an index read met (uplift-3 N4). `kind` is the
	 * closed memory-kind vocabulary and `mode` the two-way switch, so the series
	 * count is surfaces × kinds × 2 and nothing a caller types reaches a label.
	 * Counted where the index is read: a cache hit serves a copy and counts nothing.
	 */
	recordMemoryExpired(sample: { surface: string; kind: string; mode: MemoryExpiredMode }): void {
		this.memoryExpired.add(1, cleanAttributes({ surface: sample.surface, kind: sample.kind, mode: sample.mode }));
	}

	/**
	 * One untokened caller that was accepted.
	 *
	 * `claimedSurface` is what the body named, or `none` when it named nobody —
	 * not the surface the server may later default — so the hourly checklist shows
	 * who still needs a token.
	 */
	recordAnonymous(sample: { route: string; claimedSurface: string }): void {
		this.anonymousRequests.add(
			1,
			cleanAttributes({ route: sample.route, claimed_surface: sample.claimedSurface }),
		);
	}

	/**
	 * One admission decision (uplift-3 N3). `surface` is the bucket identity — a
	 * known surface or `anonymous` — never a body-claimed name, so the series stay
	 * bounded by the surface list; the other two labels are closed sets.
	 */
	recordAdmission(sample: { surface: string; klass: AdmissionClass; decision: AdmissionDecision }): void {
		this.admissionDecisions.add(1, { surface: sample.surface, class: sample.klass, decision: sample.decision });
	}

	/**
	 * One finished docs search (uplift-3 N5): its end-to-end latency as the
	 * caller waited for it — cache hit or loaded — its bounded outcome, and
	 * the provenance split of the citations it returned. The citation counter
	 * is per returned citation, so `unrecorded / total` reads directly as the
	 * share of answers the ingest records cannot vouch for.
	 */
	recordDocsSearch(sample: DocsSearchSample): void {
		const cached = sample.cached ? "true" : "false";
		this.docsDuration.record(sample.durationMs, cleanAttributes({ surface: sample.surface, cached }));
		this.docsSearch.add(1, cleanAttributes({ surface: sample.surface, outcome: sample.outcome, cached }));
		for (const provenance of CITATION_PROVENANCES) {
			const count = sample.citations[provenance] ?? 0;
			if (count > 0) this.docsCitations.add(count, { provenance });
		}
	}
}
