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
	Histogram,
	type GaugeSnapshot,
	IDENTIFIER_ATTRIBUTES,
	LATENCY_BUCKETS_MS,
	MAX_ATTRIBUTE_LENGTH,
	MAX_IDENTIFIER_ATTRIBUTE_LENGTH,
	MetricRegistry,
	OVERFLOW,
	VOLATILE_ATTRIBUTES,
	attributeKey,
	boundValue,
	cleanAttributes,
	limitFor,
	exactFractionAtOrBelow,
	exactFractionBelow,
	findCounter,
	findHistogram,
	mergeHistogram,
	quantileFromBuckets,
	sumCounter,
} from "./metrics.ts";

export {
	type Span,
	type SpanContext,
	type SpanRecord,
	SPAN_KIND,
	SPAN_STATUS,
	Tracer,
	formatTraceparent,
	parseTraceparent,
	shouldSample,
	withSpan,
} from "./trace.ts";

export {
	type OtlpConfig,
	OtlpExporter,
	PeriodicExporter,
	anyValue,
	encodeMetrics,
	encodeSpans,
	keyValues,
	unixNanoString,
} from "./otlp.ts";

export {
	type AdmissionClass,
	type AdmissionDecision,
	type BriefResult,
	type BriefState,
	type ClaimOutcome,
	type EventRefusalReason,
	type EventReplayResult,
	ADMISSION_CLASSES,
	ADMISSION_DECISIONS,
	CACHE_METRIC_CLASSES,
	CACHE_METRIC_RESULTS,
	BRIEF_RESULTS,
	BRIEF_STATES,
	type CitationProvenance,
	type DocsSearchSample,
	CITATION_PROVENANCES,
	DOCS_LATENCY_BUCKETS_MS,
	DOCS_SEARCH_OUTCOMES,
	MEMORY_EXPIRED_MODES,
	METRIC,
	PLANE_ERROR_REASONS,
	SubstrateInstruments,
	INDEX_ARCHIVE_AGE_METRIC,
	classifyEventRefusal,
	classifyPlaneReason,
	extractUsage,
} from "./instruments.ts";

export {
	type BriefProfile,
	type BriefProfileMode,
	type ServedTokenTool,
	BRIEF_PROFILES,
	BRIEF_PROFILE_MODES,
	SERVED_TOKEN_TOOLS,
	estimateTokens,
	CORPUS_FRESHNESS_METRIC,
	CORPUS_GOLDEN_RECALL5_METRIC,
	CORPUS_INGEST_RATE_METRIC,
} from "./instruments.ts";

export {
	type BriefRecallMode,
	type BriefRecallResult,
	type RecallPrefetchResult,
	BRIEF_RECALL_MODES,
	BRIEF_RECALL_RESULTS,
	CORPUS_SYNC_LAG_METRIC,
	ENDPOINT_PROXY_PLANES_METRIC,
	OUTBOX_DURABLE_METRIC,
	OUTBOX_OLDEST_METRIC,
	OUTBOX_SIZE_METRIC,
	RECALL_PREFETCH_RESULTS,
} from "./instruments.ts";

export {
	type ServedTokensResult,
	SERVED_TOKENS_ENV,
	servedTokensBySurface,
} from "./slo.ts";

export {
	type BreakerSettings,
	type BreakerSnapshot,
	type BreakerState,
	type PlaneFetch,
	type PlaneGate,
	type PlaneName,
	type PlaneSample,
	AUX_PLANES,
	BreakerOpenError,
	CircuitBreaker,
	DEFAULT_BREAKER_SETTINGS,
	PLANES,
	PlaneRegistry,
	callPlane,
	gatedFetch,
	loadBreakerSettings,
} from "./breaker.ts";

export {
	type CapacitySample,
	type CapacitySloResult,
	type PlaneCountSample,
	type PlaneSloResult,
	type SloResult,
	type SloTarget,
	type SloThresholds,
	type SurfaceSloResult,
	ADMISSION_SLO,
	CAPACITY_RING_MAX,
	CAPACITY_RUNWAY_ID,
	CapacityRing,
	DEFAULT_THRESHOLDS,
	INDEX_VOLUME_ENV,
	PLANE_BUCKET_MS,
	PLANE_WINDOW_MS,
	PlaneWindow,
	breaches,
	briefBySurfaceObjectives,
	evaluateAdmissionSlo,
	evaluateCapacitySlos,
	docsSearchObjective,
	evaluateDocsSlos,
	evaluatePlaneSlos,
	evaluateSlos,
	type DocsFreshnessReading,
	DOCS_FRESHNESS_ID,
	evaluateDocsFreshnessSlo,
	sloCatalogue,
} from "./slo.ts";

export {
	type BurnResult,
	type BurnSample,
	BurnLedger,
	BURN_MAX_SAMPLES,
	BURN_MIN_SPAN_MS,
	BURN_WINDOW_MS,
	TOKENS_BURN_ENV,
	evaluateBurnSlos,
	loadBurnThresholds,
	sharedBurnLedger,
} from "./burn.ts";

export {
	type NotifyRecord,
	type NotifyState,
	type SloCheckpoint,
	CHECKPOINT_VERSION,
	CheckpointError,
	MAX_CHECKPOINT_BYTES,
	restoreCheckpoint,
	serializeCheckpoint,
	snapshotCheckpoint,
} from "./checkpoint.ts";

export { loadObservabilityConfig, parseKeyValueList } from "./config.ts";

export {
	type ForecastDirection,
	type ForecastRow,
	FORECAST_ALPHA,
	FORECAST_BETA,
	FORECAST_HORIZON_MS,
	FORECAST_MIN_POINTS,
	FORECAST_STEP_S,
	FORECAST_WINDOW,
	forecastHistoryOff,
	forecastRow,
	holtForecast,
} from "./forecast.ts";
