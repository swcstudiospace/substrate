/**
 * OTLP and SLO configuration, from the standard `OTEL_*` environment variables
 * plus the `SUBSTRATE_SLO_*` thresholds.
 *
 * Standard names on purpose: the host already runs other OTLP producers, and an
 * operator who sets `OTEL_EXPORTER_OTLP_ENDPOINT` once should not have to learn a
 * substrate-specific spelling. Export is **off** unless an endpoint is set —
 * metrics are still collected and `/metrics` still serves them, so the SLOs and
 * the evidence bundle work with no collector at all.
 */
import { hostname } from "node:os";
import type { Attributes } from "./metrics.ts";
import type { OtlpConfig } from "./otlp.ts";
import type { SloThresholds } from "./slo.ts";

export interface ObservabilityConfig {
	/** True when an OTLP endpoint is configured, so the periodic exporter runs. */
	exportEnabled: boolean;
	otlp: OtlpConfig;
	intervalMs: number;
	sampleRatio: number;
	maxSpans: number;
	slo: SloThresholds;
}

/** `a=1,b=2` → `{a: "1", b: "2"}`, the form OTEL_EXPORTER_OTLP_HEADERS uses. */
export function parseKeyValueList(raw: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of (raw ?? "").split(",")) {
		const index = pair.indexOf("=");
		if (index <= 0) continue;
		const key = pair.slice(0, index).trim();
		const value = pair.slice(index + 1).trim();
		if (key) out[key] = value;
	}
	return out;
}

function numberOr(raw: string | undefined, fallback: number, min = 0): number {
	const value = Number(raw);
	return Number.isFinite(value) && value >= min ? value : fallback;
}

function optionalNumber(raw: string | undefined): number | undefined {
	const value = Number(raw);
	return raw !== undefined && raw.trim() !== "" && Number.isFinite(value) ? value : undefined;
}

/**
 * Strip a trailing slash, and a trailing `/v1/metrics` or `/v1/traces` an operator
 * may have pasted from a collector's docs — appending the path again would 404, and
 * silently, since export fails open.
 */
function normalizeEndpoint(raw: string | undefined): string {
	return (raw ?? "").trim().replace(/\/+$/, "").replace(/\/v1\/(?:metrics|traces)$/, "");
}

export function loadObservabilityConfig(
	env: Record<string, string | undefined> = process.env,
	version = "0.1.0",
): ObservabilityConfig {
	// Metrics and traces get **separate** endpoints, each resolved from its own
	// signal-specific variable and falling back to the generic one.
	//
	// They were one endpoint, taken from whichever of the two was set. A deployment
	// that sends metrics to one collector and traces to another — which is the reason
	// the signal-specific variables exist — would have had its spans posted to the
	// metrics collector's `/v1/traces`, and lost them if it does not serve traces.
	const generic = normalizeEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT);
	const metricsEndpoint = normalizeEndpoint(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) || generic;
	const tracesEndpoint = normalizeEndpoint(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) || generic;

	return {
		// Either signal being configured is enough to run the exporter; each is sent only
		// where it has somewhere to go.
		exportEnabled: metricsEndpoint.length > 0 || tracesEndpoint.length > 0,
		intervalMs: numberOr(env.SUBSTRATE_OTLP_INTERVAL_MS, 30_000, 1000),
		// Traces are sampled; metrics never are. A ratio below 1 loses individual
		// requests from the trace view but cannot move a latency histogram, because
		// the histogram is recorded before the sampling decision is consulted.
		sampleRatio: Math.min(Math.max(numberOr(env.SUBSTRATE_TRACE_SAMPLE_RATIO, 1), 0), 1),
		maxSpans: numberOr(env.SUBSTRATE_TRACE_BUFFER, 2048, 16),
		otlp: {
			metricsEndpoint,
			tracesEndpoint,
			headers: parseKeyValueList(env.OTEL_EXPORTER_OTLP_HEADERS),
			timeoutMs: numberOr(env.OTEL_EXPORTER_OTLP_TIMEOUT, 5000, 100),
			resource: {
				serviceName: env.OTEL_SERVICE_NAME?.trim() || "substrate-mcp",
				serviceVersion: version,
				serviceInstanceId: env.SUBSTRATE_INSTANCE_ID?.trim() || hostname(),
				...(env.SUBSTRATE_ENV?.trim() ? { deploymentEnvironment: env.SUBSTRATE_ENV.trim() } : {}),
				extra: parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES) as Attributes,
			},
		},
		slo: {
			briefP95Ms: optionalNumber(env.SUBSTRATE_SLO_BRIEF_P95_MS),
			emitSuccessRatio: optionalNumber(env.SUBSTRATE_SLO_EMIT_SUCCESS),
			leaseStealRatio: optionalNumber(env.SUBSTRATE_SLO_LEASE_STEAL),
			quarantineRatio: optionalNumber(env.SUBSTRATE_SLO_QUARANTINE),
			minSamples: optionalNumber(env.SUBSTRATE_SLO_MIN_SAMPLES),
			planeAvailability: optionalNumber(env.SUBSTRATE_SLO_PLANE_AVAILABILITY),
		},
	};
}
