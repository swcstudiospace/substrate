/**
 * Session-state transition telemetry (phase 54, SOTA-10).
 *
 * A transition is one move of a phase's view from one {@link SessionState} to another. It is
 * a metric, never an event: nothing here writes to `agent_events`, and the event kinds are not
 * touched. Two sinks implement the {@link MetricSink} port:
 *
 *   - `greptimeMetricSink` stores the record through the metrics writer the history sampler
 *     already uses (`GreptimeClient.recordMetricSamples`, injected as `TransitionRecordSamples`).
 *     That writer stores only series in its closed allow-list, with one label key per series.
 *     `planning.transition` is in that allow-list (core tier, label `outcome`), so the writer stores
 *     it. The wiring uses this sink only when the metrics-history switch is on; otherwise records go
 *     to stdout alone. A row the writer refuses is a refusal, and the stdout fallback keeps the record.
 *   - `stdoutMetricSink` writes one JSON line per record. A record carries only the closed
 *     fields below, so the line holds no secrets.
 *
 * `emitTransition` tries the primary sink, and on any failure writes the fallback once. A sink
 * that throws is converted into a typed failure: this module never throws from emit, and a
 * failing fallback is returned to the caller as a typed failure, not swallowed.
 *
 * No env reads here. The clock, the writer and the stdout function are all injected.
 */
import type { MetricWriteResult } from "../greptime.ts";
import type { MetricSampleRow } from "../metrics-history.ts";
import { SESSION_STATES, type SessionState } from "./states.ts";

/** The metric series a transition is stored under. Must be listed in `METRIC_SERIES` for the GreptimeDB sink to store it. */
export const TRANSITION_SERIES = "planning.transition";

/** Whether the transition applied, or was refused by a precondition. A closed set. */
export const TRANSITION_OUTCOMES = ["applied", "refused"] as const;
export type TransitionOutcome = (typeof TRANSITION_OUTCOMES)[number];

const PHASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface TransitionInput {
	/** The phase the view belongs to, for example `54`. */
	phaseId: string;
	from: SessionState;
	to: SessionState;
	outcome: TransitionOutcome;
}

export interface TransitionRecord extends TransitionInput {
	/** ISO-8601 instant, taken from the injected clock. */
	ts: string;
}

/** The time source. Production passes `() => new Date()`; tests pass a fixed instant. */
export type TransitionClock = () => Date;

/** The record for one transition. Throws a TypeError on a malformed phase id, state, outcome or clock reading. */
export function transitionRecord(input: TransitionInput, clock: TransitionClock): TransitionRecord {
	if (!PHASE_ID_RE.test(input.phaseId)) throw new TypeError("transition phaseId is not a valid phase id");
	if (!(SESSION_STATES as readonly string[]).includes(input.from)) throw new TypeError("transition from is not a session state");
	if (!(SESSION_STATES as readonly string[]).includes(input.to)) throw new TypeError("transition to is not a session state");
	if (!(TRANSITION_OUTCOMES as readonly string[]).includes(input.outcome)) throw new TypeError("transition outcome is not a known outcome");
	const instant = clock();
	if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) throw new TypeError("transition clock did not return a valid date");
	return { phaseId: input.phaseId, from: input.from, to: input.to, outcome: input.outcome, ts: instant.toISOString() };
}

/** Why a sink did not deliver: refused by the sink, or its emit threw. */
export type SinkFailureReason = "refused" | "threw";

export type SinkResult = { ok: true } | { ok: false; reason: SinkFailureReason; detail: string };

/** The sink port. `emit` resolves to a result; a sink that throws anyway is recorded by the caller as `threw`. */
export interface MetricSink {
	readonly name: string;
	emit(record: TransitionRecord): Promise<SinkResult>;
}

/** The writer the GreptimeDB sink uses: `GreptimeClient.recordMetricSamples`, bound by the caller. */
export type TransitionRecordSamples = (rows: MetricSampleRow[]) => Promise<MetricWriteResult>;

/** Only the error's class name crosses into a result, so a message from a store never reaches a log line here. */
function threwResult(cause: unknown): { ok: false; reason: "threw"; detail: string } {
	return { ok: false, reason: "threw", detail: cause instanceof Error ? cause.name : "non-error value thrown" };
}

/** A GreptimeDB metric sink over the injected metrics writer. One row per record; the outcome is the only label the series carries. */
export function greptimeMetricSink(recordSamples: TransitionRecordSamples, name = "greptime"): MetricSink {
	return {
		name,
		async emit(record) {
			const row: MetricSampleRow = {
				tsMs: Date.parse(record.ts),
				series: TRANSITION_SERIES,
				labels: { outcome: record.outcome },
				value: 1,
				count: 1,
			};
			let written: MetricWriteResult;
			try {
				written = await recordSamples([row]);
			} catch (cause: unknown) {
				return threwResult(cause);
			}
			if (written.stored >= 1) return { ok: true };
			const drops = Object.entries(written.drops)
				.map(([reason, rows]) => `${reason}=${rows}`)
				.join(", ");
			return { ok: false, reason: "refused", detail: drops === "" ? "no rows stored" : `rows dropped: ${drops}` };
		},
	};
}

/** The fields a stdout line carries. Nothing else is written. */
export interface TransitionLine {
	metric: typeof TRANSITION_SERIES;
	phaseId: string;
	from: SessionState;
	to: SessionState;
	outcome: TransitionOutcome;
	ts: string;
}

/** A stdout sink: one JSON line per record through the injected writer. */
export function stdoutMetricSink(write: (line: string) => void = (line) => process.stdout.write(line), name = "stdout"): MetricSink {
	return {
		name,
		async emit(record) {
			const line: TransitionLine = {
				metric: TRANSITION_SERIES,
				phaseId: record.phaseId,
				from: record.from,
				to: record.to,
				outcome: record.outcome,
				ts: record.ts,
			};
			try {
				write(`${JSON.stringify(line)}\n`);
			} catch (cause: unknown) {
				return threwResult(cause);
			}
			return { ok: true };
		},
	};
}

/** One sink that did not deliver: which sink, why, and the detail. */
export interface DeliveryFailure {
	sink: string;
	reason: SinkFailureReason;
	detail: string;
}

/**
 * What `emitTransition` did:
 *   - `primary`: the primary sink delivered; the fallback was not called.
 *   - `fallback`: the primary failed and the fallback delivered; `primary` says why.
 *   - `failed`: both failed; both reasons are returned, so nothing is swallowed.
 */
export type TransitionEmitResult =
	| { status: "primary"; sink: string }
	| { status: "fallback"; sink: string; primary: DeliveryFailure }
	| { status: "failed"; primary: DeliveryFailure; fallback: DeliveryFailure };

/** Calls one sink, turning a throw into a typed result. */
async function attempt(sink: MetricSink, record: TransitionRecord): Promise<SinkResult> {
	try {
		return await sink.emit(record);
	} catch (cause: unknown) {
		return threwResult(cause);
	}
}

/** Emits one transition: the primary once, and the fallback once only if the primary failed. Never throws. */
export async function emitTransition(record: TransitionRecord, primary: MetricSink, fallback: MetricSink): Promise<TransitionEmitResult> {
	const first = await attempt(primary, record);
	if (first.ok) return { status: "primary", sink: primary.name };
	const primaryFailure: DeliveryFailure = { sink: primary.name, reason: first.reason, detail: first.detail };

	const second = await attempt(fallback, record);
	if (second.ok) return { status: "fallback", sink: fallback.name, primary: primaryFailure };
	return {
		status: "failed",
		primary: primaryFailure,
		fallback: { sink: fallback.name, reason: second.reason, detail: second.detail },
	};
}
