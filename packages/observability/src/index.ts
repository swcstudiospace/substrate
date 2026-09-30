/**
 * `@substrate/observability` — OTLP metrics and traces, and the SLOs stated over
 * them.
 *
 * Nothing here reaches a store. The observability plane is deliberately separate
 * from the ledger: Greptime holds the substrate's *application* events, and an
 * agent's latency is not one of them. See `docs/observability.md`.
 */
export {
	type AttributeValue,
	type Attributes,
	type CounterPoint,
	type CounterSnapshot,
	type HistogramPoint,
	type HistogramSnapshot,
	type MetricSnapshot,
	Counter,
	DEFAULT_MAX_SERIES,
	HARD_MAX_SERIES,
	Histogram,
	LATENCY_BUCKETS_MS,
	MAX_ATTRIBUTE_LENGTH,
	MetricRegistry,
	OVERFLOW,
	VOLATILE_ATTRIBUTES,
	attributeKey,
	cleanAttributes,
	exactFractionAtOrBelow,
	exactFractionBelow,
	findCounter,
	findHistogram,
	matches,
	mergeHistogram,
	quantileFromBuckets,
	sumCounter,
} from "./metrics.ts";

export {
	type Span,
	type SpanContext,
	type SpanKind,
	type SpanRecord,
	type SpanStatusCode,
	type TracerOptions,
	SPAN_KIND,
	SPAN_STATUS,
	Tracer,
	formatTraceparent,
	newSpanId,
	newTraceId,
	parseTraceparent,
	shouldSample,
	withSpan,
} from "./trace.ts";

export {
	type ExportResult,
	type FetchLike,
	type OtlpConfig,
	type OtlpResource,
	OtlpExporter,
	PeriodicExporter,
	anyValue,
	encodeMetrics,
	encodeSpans,
	keyValues,
	unixNanoString,
} from "./otlp.ts";

export {
	type ClaimOutcome,
	type Usage,
	CLAIM_OUTCOMES,
	METRIC,
	SubstrateInstruments,
	extractUsage,
} from "./instruments.ts";

export {
	type CounterSelector,
	type SloResult,
	type SloStatus,
	type SloTarget,
	type SloThresholds,
	DEFAULT_THRESHOLDS,
	breaches,
	evaluateSlos,
	sloCatalogue,
} from "./slo.ts";

export { type ObservabilityConfig, loadObservabilityConfig, parseKeyValueList } from "./config.ts";
