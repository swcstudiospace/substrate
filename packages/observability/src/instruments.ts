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
} as const;

/** Why a `POST /events` was refused with 4xx. One series each, so the reason stays bounded. */
export const EVENT_REFUSAL_REASONS = ["auth", "validation", "attribution", "graph_id"] as const;
export type EventRefusalReason = (typeof EVENT_REFUSAL_REASONS)[number];

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
	return error !== undefined && /\bgraph_id\b/i.test(error) ? "graph_id" : "validation";
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
}
