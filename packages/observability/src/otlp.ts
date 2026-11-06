/**
 * OTLP/HTTP with JSON encoding — `POST {endpoint}/v1/metrics` and `/v1/traces`.
 *
 * JSON rather than protobuf so this stays dependency-free, and because every
 * collector that speaks OTLP/HTTP accepts `application/json` on those paths. The
 * encoding rules that are easy to get wrong and are therefore pinned by tests:
 *
 *   - 64-bit integers are **strings** in OTLP JSON (`timeUnixNano`, `count`,
 *     `bucketCounts`, `asInt`). A number would lose precision above 2^53 — and
 *     `timeUnixNano` is ~1.8e18 today, well past it.
 *   - trace and span ids are lowercase hex strings, not base64.
 *   - `aggregationTemporality: 2` is CUMULATIVE, which is what this registry
 *     produces: totals that only grow, so a missed export is not a lost count.
 *
 * Export never throws. The substrate must fail open, and a collector being down is
 * not a reason for a prompt to be.
 */
import type { CounterSnapshot, GaugeSnapshot, HistogramSnapshot, MetricSnapshot, Attributes } from "./metrics.ts";
import type { SpanRecord } from "./trace.ts";

const CUMULATIVE = 2;

interface OtlpResource {
	serviceName: string;
	serviceVersion: string;
	serviceInstanceId: string;
	deploymentEnvironment?: string;
	/** Extra resource attributes from `OTEL_RESOURCE_ATTRIBUTES`. */
	extra?: Attributes;
}

export interface OtlpConfig {
	/**
	 * Base endpoints, without `/v1/...`, one per signal.
	 *
	 * Separate because a deployment may send metrics and traces to different
	 * collectors — which is the whole reason OTEL defines signal-specific endpoint
	 * variables. An empty string means that signal has nowhere to go and is not sent.
	 */
	metricsEndpoint: string;
	tracesEndpoint: string;
	headers: Record<string, string>;
	timeoutMs: number;
	resource: OtlpResource;
}

interface ExportResult {
	ok: boolean;
	/** Data points or spans in the request. Zero means nothing was sent. */
	items: number;
	status?: number;
	/** Redacted. A transport error can quote an endpoint that carries a token. */
	error?: string;
}

type AnyValue = { stringValue: string } | { boolValue: boolean } | { intValue: string } | { doubleValue: number };

/**
 * `1790186361859.25` → `"1790186361859250000"`.
 *
 * String arithmetic rather than `ms * 1e6`. A unix time in nanoseconds is ~1.8e18,
 * past `Number.MAX_SAFE_INTEGER`, so that product is not an exactly representable
 * integer: its decimal form is whatever the nearest double round-trips to. Today
 * that happens to print the right digits for the values a span carries, which is
 * precisely the kind of accident not to build a wire format on — and OTLP JSON
 * wants a string here regardless.
 */
export function unixNanoString(epochMs: number): string {
	if (!Number.isFinite(epochMs) || epochMs < 0) return "0";
	const whole = Math.trunc(epochMs);
	const nanosWithinMs = Math.min(Math.round((epochMs - whole) * 1e6), 999_999);
	return `${whole}${String(nanosWithinMs).padStart(6, "0")}`;
}

export function anyValue(value: string | number | boolean): AnyValue {
	if (typeof value === "string") return { stringValue: value };
	if (typeof value === "boolean") return { boolValue: value };
	return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

export function keyValues(attributes: Attributes): Array<{ key: string; value: AnyValue }> {
	return Object.keys(attributes)
		.sort()
		.map((key) => ({ key, value: anyValue(attributes[key] as string | number | boolean) }));
}

function resourceBlock(resource: OtlpResource) {
	return {
		attributes: keyValues({
			"service.name": resource.serviceName,
			"service.version": resource.serviceVersion,
			"service.instance.id": resource.serviceInstanceId,
			...(resource.deploymentEnvironment ? { "deployment.environment": resource.deploymentEnvironment } : {}),
			...(resource.extra ?? {}),
		}),
	};
}

const SCOPE = { name: "substrate-mcp", version: "0.1.0" };

function counterMetric(metric: CounterSnapshot, startNano: string, nowNano: string) {
	return {
		name: metric.name,
		description: metric.description,
		unit: metric.unit,
		sum: {
			aggregationTemporality: CUMULATIVE,
			isMonotonic: true,
			dataPoints: metric.points.map((point) => ({
				attributes: keyValues(point.attributes),
				startTimeUnixNano: startNano,
				timeUnixNano: nowNano,
				...(metric.valueType === "int" ? { asInt: String(Math.round(point.value)) } : { asDouble: point.value }),
			})),
		},
	};
}

function gaugeMetric(metric: GaugeSnapshot, nowNano: string) {
	return {
		name: metric.name,
		description: metric.description,
		unit: metric.unit,
		gauge: {
			dataPoints: metric.points.map((point) => ({
				attributes: keyValues(point.attributes),
				timeUnixNano: nowNano,
				asDouble: point.value,
			})),
		},
	};
}

function histogramMetric(metric: HistogramSnapshot, startNano: string, nowNano: string) {
	return {
		name: metric.name,
		description: metric.description,
		unit: metric.unit,
		histogram: {
			aggregationTemporality: CUMULATIVE,
			dataPoints: metric.points.map((point) => ({
				attributes: keyValues(point.attributes),
				startTimeUnixNano: startNano,
				timeUnixNano: nowNano,
				count: String(point.count),
				sum: point.sum,
				min: point.min,
				max: point.max,
				bucketCounts: point.bucketCounts.map((value) => String(value)),
				explicitBounds: [...metric.bounds],
			})),
		},
	};
}

export function encodeMetrics(
	snapshot: MetricSnapshot[],
	resource: OtlpResource,
	startedAt: number,
	now: number,
): { body: unknown; items: number } {
	const startNano = unixNanoString(startedAt);
	const nowNano = unixNanoString(now);
	// A metric with no series is omitted: an empty `dataPoints` array is legal but
	// every interval would then carry a dozen empty envelopes for no information.
	const metrics = snapshot
		.filter((metric) => metric.points.length > 0)
		.map((metric) =>
			metric.kind === "counter"
				? counterMetric(metric, startNano, nowNano)
				: metric.kind === "gauge"
					? gaugeMetric(metric, nowNano)
					: histogramMetric(metric, startNano, nowNano),
		);
	const items = snapshot.reduce((total, metric) => total + metric.points.length, 0);
	return {
		body: { resourceMetrics: [{ resource: resourceBlock(resource), scopeMetrics: [{ scope: SCOPE, metrics }] }] },
		items,
	};
}

export function encodeSpans(spans: SpanRecord[], resource: OtlpResource): { body: unknown; items: number } {
	return {
		body: {
			resourceSpans: [
				{
					resource: resourceBlock(resource),
					scopeSpans: [
						{
							scope: SCOPE,
							spans: spans.map((span) => ({
								traceId: span.traceId,
								spanId: span.spanId,
								// Omitted rather than all-zero: the spec treats an all-zero parent
								// as absent, and some collectors reject the explicit form.
								...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
								name: span.name,
								kind: span.kind,
								startTimeUnixNano: unixNanoString(span.startEpochMs),
								endTimeUnixNano: unixNanoString(span.endEpochMs),
								attributes: keyValues(span.attributes),
								status: {
									code: span.status.code,
									...(span.status.message ? { message: span.status.message } : {}),
								},
							})),
						},
					],
				},
			],
		},
		items: spans.length,
	};
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Pushes encoded batches at a collector.
 *
 * `redact` is injected rather than imported: the redactor lives in
 * `packages/mcp-server`, which depends on this package, so importing it back would
 * be a cycle. `substrate-mcp` passes its own; a caller that passes none gets error
 * text truncated but not scrubbed, which is why the default is only safe for tests.
 */
export class OtlpExporter {
	private consecutiveFailures = 0;

	constructor(
		private readonly config: OtlpConfig,
		private readonly deps: { fetch?: FetchLike; redact?: (text: string) => string } = {},
	) {}

	get failures(): number {
		return this.consecutiveFailures;
	}

	async exportMetrics(snapshot: MetricSnapshot[], startedAt: number, now = Date.now()): Promise<ExportResult> {
		if (this.config.metricsEndpoint.length === 0) return { ok: true, items: 0 };
		const { body, items } = encodeMetrics(snapshot, this.config.resource, startedAt, now);
		if (items === 0) return { ok: true, items: 0 };
		return this.send(this.config.metricsEndpoint, "/v1/metrics", body, items);
	}

	async exportSpans(spans: SpanRecord[]): Promise<ExportResult> {
		if (this.config.tracesEndpoint.length === 0 || spans.length === 0) return { ok: true, items: 0 };
		const { body, items } = encodeSpans(spans, this.config.resource);
		return this.send(this.config.tracesEndpoint, "/v1/traces", body, items);
	}

	private async send(endpoint: string, path: string, body: unknown, items: number): Promise<ExportResult> {
		const redact = this.deps.redact ?? ((text: string) => text);
		const call = this.deps.fetch ?? fetch;
		try {
			const response = await call(`${endpoint}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...this.config.headers },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.config.timeoutMs),
			});
			if (!response.ok) {
				this.consecutiveFailures++;
				const text = await response.text().catch(() => "");
				return { ok: false, items, status: response.status, error: redact(text).slice(0, 300) };
			}
			this.consecutiveFailures = 0;
			return { ok: true, items, status: response.status };
		} catch (cause) {
			this.consecutiveFailures++;
			return { ok: false, items, error: redact(String(cause)).slice(0, 300) };
		}
	}
}

/**
 * Drains the registry and the tracer on an interval.
 *
 * `unref` matters: the substrate's own exporter must not be the reason the process
 * refuses to exit when systemd stops it.
 */
export class PeriodicExporter {
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly deps: {
			exporter: OtlpExporter;
			snapshot: () => MetricSnapshot[];
			drainSpans: () => SpanRecord[];
			startedAt: number;
			intervalMs: number;
			onResult?: (result: { metrics: ExportResult; traces: ExportResult }) => void;
		},
	) {}

	start(): void {
		if (this.timer) return;
		// A failed metrics export is retried on the next tick: the snapshot is cumulative. Spans are drained before the export,
		// so a failed span export drops its batch.
		this.timer = setInterval(() => void this.flush().catch(() => undefined), this.deps.intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	async flush(): Promise<{ metrics: ExportResult; traces: ExportResult }> {
		const spans = this.deps.drainSpans();
		const [metrics, traces] = await Promise.all([
			this.deps.exporter.exportMetrics(this.deps.snapshot(), this.deps.startedAt),
			this.deps.exporter.exportSpans(spans),
		]);
		const result = { metrics, traces };
		this.deps.onResult?.(result);
		return result;
	}
}
