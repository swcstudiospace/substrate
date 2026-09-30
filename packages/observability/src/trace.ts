/**
 * Spans, and the W3C trace context that joins them up across surfaces.
 *
 * A brief fetched by `claude-ultrathink`'s uplift hook, forwarded through
 * `grok-hermes-connector` and answered by `substrate-mcp` is one causal chain
 * across three processes. Accepting `traceparent` on the way in and propagating it
 * is what makes that chain one trace rather than three unrelated spans — and it is
 * the only way a latency question ("where did the 900 ms go?") has an answer.
 *
 * Completed spans go into a bounded buffer that the exporter drains. Bounded
 * because the substrate must fail open: a collector that stops accepting spans
 * costs the traces, never the host's memory.
 */
import { randomBytes } from "node:crypto";
import type { Attributes, AttributeValue } from "./metrics.ts";
import { cleanAttributes } from "./metrics.ts";

/** OTLP span kinds. Only the three the substrate produces are named. */
export const SPAN_KIND = { internal: 1, server: 2, client: 3 } as const;
export type SpanKind = (typeof SPAN_KIND)[keyof typeof SPAN_KIND];

/** OTLP status codes. */
export const SPAN_STATUS = { unset: 0, ok: 1, error: 2 } as const;
export type SpanStatusCode = (typeof SPAN_STATUS)[keyof typeof SPAN_STATUS];

export interface SpanContext {
	traceId: string;
	spanId: string;
	sampled: boolean;
}

export interface SpanRecord {
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	name: string;
	kind: SpanKind;
	/** Wall-clock epoch milliseconds, fractional. `otlp.ts` converts to nanos. */
	startEpochMs: number;
	endEpochMs: number;
	attributes: Attributes;
	status: { code: SpanStatusCode; message?: string };
}

const ALL_ZERO_TRACE = "0".repeat(32);
const ALL_ZERO_SPAN = "0".repeat(16);

export function newTraceId(random: (bytes: number) => Buffer = randomBytes): string {
	return random(16).toString("hex");
}

export function newSpanId(random: (bytes: number) => Buffer = randomBytes): string {
	return random(8).toString("hex");
}

/**
 * Parse a `traceparent` header.
 *
 * Only version `00` is accepted, and the all-zero ids are rejected — the spec
 * says both are invalid, and treating them as a parent would graft every
 * surface's work onto one meaningless trace.
 */
export function parseTraceparent(header: string | null | undefined): SpanContext | null {
	if (!header) return null;
	const parts = header.trim().split("-");
	if (parts.length < 4) return null;
	const [version, traceId, spanId, flags] = parts;
	if (version !== "00") return null;
	if (!traceId || !/^[0-9a-f]{32}$/.test(traceId) || traceId === ALL_ZERO_TRACE) return null;
	if (!spanId || !/^[0-9a-f]{16}$/.test(spanId) || spanId === ALL_ZERO_SPAN) return null;
	if (!flags || !/^[0-9a-f]{2}$/.test(flags)) return null;
	return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 0x01) === 0x01 };
}

export function formatTraceparent(context: SpanContext): string {
	return `00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`;
}

/**
 * Head sampling, decided from the trace id so every process in a trace agrees.
 *
 * The low 8 hex digits of the trace id are a uniform 32-bit value, and the same
 * trace id gives the same answer in `substrate-mcp` as it would in the connector.
 * A trace is therefore sampled whole or not at all, which is the only useful kind.
 */
export function shouldSample(traceId: string, ratio: number): boolean {
	if (ratio >= 1) return true;
	if (ratio <= 0) return false;
	const tail = Number.parseInt(traceId.slice(-8), 16);
	if (!Number.isFinite(tail)) return true;
	return tail / 0x1_0000_0000 < ratio;
}

export interface Span {
	readonly context: SpanContext;
	setAttribute(key: string, value: AttributeValue | null | undefined): void;
	setAttributes(attributes: Record<string, AttributeValue | null | undefined>): void;
	/** Mark the span failed and attach the cause's message. */
	fail(message: string): void;
	/** Close the span. Idempotent — a second call is ignored, not a second record. */
	end(): void;
}

export interface TracerOptions {
	/** Spans held for the next export before the oldest are dropped. */
	maxSpans?: number;
	/** Head-sampling ratio for traces this process starts. Inherited traces obey their flag. */
	sampleRatio?: number;
	now?: () => number;
	random?: (bytes: number) => Buffer;
}

export class Tracer {
	private readonly buffer: SpanRecord[] = [];
	private readonly maxSpans: number;
	private readonly sampleRatio: number;
	private readonly now: () => number;
	private readonly random: (bytes: number) => Buffer;
	/** Spans discarded because the buffer was full. Exported as a metric, not hidden. */
	private droppedSpans = 0;

	constructor(options: TracerOptions = {}) {
		this.maxSpans = options.maxSpans ?? 2048;
		this.sampleRatio = options.sampleRatio ?? 1;
		this.now = options.now ?? (() => Date.now());
		this.random = options.random ?? randomBytes;
	}

	get dropped(): number {
		return this.droppedSpans;
	}

	get pending(): number {
		return this.buffer.length;
	}

	startSpan(
		name: string,
		options: {
			kind?: SpanKind;
			attributes?: Record<string, AttributeValue | null | undefined>;
			parent?: SpanContext | null;
		} = {},
	): Span {
		const parent = options.parent ?? null;
		const traceId = parent?.traceId ?? newTraceId(this.random);
		const context: SpanContext = {
			traceId,
			spanId: newSpanId(this.random),
			sampled: parent ? parent.sampled : shouldSample(traceId, this.sampleRatio),
		};

		const record: SpanRecord = {
			traceId,
			spanId: context.spanId,
			parentSpanId: parent?.spanId ?? null,
			name,
			kind: options.kind ?? SPAN_KIND.internal,
			startEpochMs: this.now(),
			endEpochMs: 0,
			attributes: cleanAttributes(options.attributes ?? {}),
			status: { code: SPAN_STATUS.unset },
		};

		let ended = false;
		const now = this.now;
		const emit = (span: SpanRecord) => this.finish(span, context.sampled);

		return {
			context,
			setAttribute(key, value) {
				if (value === null || value === undefined) return;
				record.attributes[key] = value;
			},
			setAttributes(attributes) {
				Object.assign(record.attributes, cleanAttributes(attributes));
			},
			fail(message) {
				record.status = { code: SPAN_STATUS.error, message };
			},
			end() {
				if (ended) return;
				ended = true;
				// Clamped to the start: a clock that steps backwards mid-span must not
				// produce a negative duration in the exported trace.
				record.endEpochMs = Math.max(record.startEpochMs, now());
				emit(record);
			},
		};
	}

	/**
	 * A span is buffered only if its trace is sampled. Dropping the oldest rather
	 * than refusing the newest keeps the buffer useful during an outage, when the
	 * spans that explain it are the ones arriving now.
	 */
	private finish(record: SpanRecord, sampled: boolean): void {
		if (!sampled) return;
		if (record.status.code === SPAN_STATUS.unset) record.status = { code: SPAN_STATUS.ok };
		if (this.buffer.length >= this.maxSpans) {
			this.buffer.shift();
			this.droppedSpans++;
		}
		this.buffer.push(record);
	}

	/** Hand every buffered span to the caller and clear the buffer. */
	drain(): SpanRecord[] {
		return this.buffer.splice(0, this.buffer.length);
	}
}

/**
 * Time a function, closing the span and recording the failure either way.
 *
 * `fail` is set from the cause and the cause is rethrown: a span is a record of
 * what happened, never a reason for it to happen differently.
 */
export async function withSpan<T>(
	span: Span,
	run: (span: Span) => Promise<T>,
	describe: (cause: unknown) => string = String,
): Promise<T> {
	try {
		return await run(span);
	} catch (cause) {
		span.fail(describe(cause));
		throw cause;
	} finally {
		span.end();
	}
}
