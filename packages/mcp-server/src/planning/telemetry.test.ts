/**
 * Transition telemetry: each transition emits once; a failing primary falls back once; a failing
 * fallback is a typed failure, not swallowed. The clock, writers and stdout are injected.
 */
import { describe, expect, test } from "bun:test";
import type { MetricWriteResult } from "../greptime.ts";
import type { MetricSampleRow } from "../metrics-history.ts";
import {
	TRANSITION_SERIES,
	emitTransition,
	greptimeMetricSink,
	stdoutMetricSink,
	transitionRecord,
	type MetricSink,
	type SinkResult,
	type TransitionRecord,
} from "./telemetry.ts";

const FIXED = new Date("2026-10-22T12:00:00.000Z");
const CLOCK = () => FIXED;
const INPUT = { phaseId: "54", from: "LOADING", to: "SUCCESS", outcome: "applied" } as const;

function record(): TransitionRecord {
	return transitionRecord(INPUT, CLOCK);
}

/** A sink that records each emit and answers with the given result or throws. */
function countingSink(name: string, answer: SinkResult | Error): MetricSink & { calls: TransitionRecord[] } {
	const calls: TransitionRecord[] = [];
	return {
		name,
		calls,
		async emit(entry) {
			calls.push(entry);
			if (answer instanceof Error) throw answer;
			return answer;
		},
	};
}

const REFUSED: SinkResult = { ok: false, reason: "refused", detail: "rows dropped: invalid=1" };

describe("transitionRecord", () => {
	test("stamps the record from the injected clock", () => {
		expect(record()).toEqual({ phaseId: "54", from: "LOADING", to: "SUCCESS", outcome: "applied", ts: "2026-10-22T12:00:00.000Z" });
	});

	test("rejects a malformed phase id", () => {
		expect(() => transitionRecord({ ...INPUT, phaseId: "54; drop" }, CLOCK)).toThrow(TypeError);
	});

	test("rejects a clock that returns no valid date", () => {
		expect(() => transitionRecord(INPUT, () => new Date("not a date"))).toThrow(TypeError);
	});

	test("rejects a state or outcome outside its closed set", () => {
		expect(() => transitionRecord({ ...INPUT, to: "BOGUS" as never }, CLOCK)).toThrow(TypeError);
		expect(() => transitionRecord({ ...INPUT, outcome: "maybe" as never }, CLOCK)).toThrow(TypeError);
	});
});

describe("emitTransition", () => {
	test("a transition emits once through the primary and never reaches the fallback", async () => {
		const primary = countingSink("primary", { ok: true });
		const fallback = countingSink("fallback", { ok: true });
		const result = await emitTransition(record(), primary, fallback);
		expect(result).toEqual({ status: "primary", sink: "primary" });
		expect(primary.calls).toHaveLength(1);
		expect(fallback.calls).toHaveLength(0);
	});

	test("a refused primary falls back exactly once and reports the primary failure", async () => {
		const primary = countingSink("primary", REFUSED);
		const fallback = countingSink("fallback", { ok: true });
		const result = await emitTransition(record(), primary, fallback);
		expect(result).toEqual({
			status: "fallback",
			sink: "fallback",
			primary: { sink: "primary", reason: "refused", detail: "rows dropped: invalid=1" },
		});
		expect(primary.calls).toHaveLength(1);
		expect(fallback.calls).toHaveLength(1);
	});

	test("a primary that throws falls back once, and the failure is typed by the error's class name only", async () => {
		const primary = countingSink("primary", new RangeError("secret-bearing message must not surface"));
		const fallback = countingSink("fallback", { ok: true });
		const result = await emitTransition(record(), primary, fallback);
		expect(result.status).toBe("fallback");
		if (result.status !== "fallback") throw new Error("expected a fallback");
		expect(result.primary).toEqual({ sink: "primary", reason: "threw", detail: "RangeError" });
		expect(JSON.stringify(result)).not.toContain("secret-bearing");
		expect(fallback.calls).toHaveLength(1);
	});

	test("a failing fallback is a typed failure carrying both reasons, not a swallowed one", async () => {
		const primary = countingSink("primary", REFUSED);
		const fallback = countingSink("fallback", { ok: false, reason: "threw", detail: "TypeError" });
		const result = await emitTransition(record(), primary, fallback);
		expect(result).toEqual({
			status: "failed",
			primary: { sink: "primary", reason: "refused", detail: "rows dropped: invalid=1" },
			fallback: { sink: "fallback", reason: "threw", detail: "TypeError" },
		});
		expect(primary.calls).toHaveLength(1);
		expect(fallback.calls).toHaveLength(1);
	});

	test("a fallback that throws is reported as a failure, never as an exception", async () => {
		const primary = countingSink("primary", REFUSED);
		const fallback = countingSink("fallback", new Error("disk full"));
		const result = await emitTransition(record(), primary, fallback);
		expect(result).toEqual({
			status: "failed",
			primary: { sink: "primary", reason: "refused", detail: "rows dropped: invalid=1" },
			fallback: { sink: "fallback", reason: "threw", detail: "Error" },
		});
	});
});

describe("greptimeMetricSink", () => {
	test("writes one row on the transition series, labelled by outcome, at the record's instant", async () => {
		const rows: MetricSampleRow[][] = [];
		const written: MetricWriteResult = { stored: 1, drops: {} };
		const sink = greptimeMetricSink(async (batch) => {
			rows.push(batch);
			return written;
		});
		expect(await sink.emit(record())).toEqual({ ok: true });
		expect(rows).toEqual([
			[{ tsMs: FIXED.getTime(), series: TRANSITION_SERIES, labels: { outcome: "applied" }, value: 1, count: 1 }],
		]);
	});

	test("a writer that stores nothing is a refusal that names the closed drop reasons", async () => {
		const sink = greptimeMetricSink(async () => ({ stored: 0, drops: { invalid: 1 } }));
		expect(await sink.emit(record())).toEqual({ ok: false, reason: "refused", detail: "rows dropped: invalid=1" });
	});

	test("a writer that throws is a typed failure", async () => {
		const sink = greptimeMetricSink(async () => {
			throw new TypeError("bad");
		});
		expect(await sink.emit(record())).toEqual({ ok: false, reason: "threw", detail: "TypeError" });
	});
});

describe("stdoutMetricSink", () => {
	test("writes exactly one JSON line with the closed fields and nothing else", async () => {
		const lines: string[] = [];
		const sink = stdoutMetricSink((line) => lines.push(line));
		expect(await sink.emit(record())).toEqual({ ok: true });
		expect(lines).toHaveLength(1);
		expect(lines[0]!.endsWith("\n")).toBe(true);
		expect(JSON.parse(lines[0]!)).toEqual({
			metric: TRANSITION_SERIES,
			phaseId: "54",
			from: "LOADING",
			to: "SUCCESS",
			outcome: "applied",
			ts: "2026-10-22T12:00:00.000Z",
		});
	});

	test("a write that throws is a typed failure, not an exception", async () => {
		const sink = stdoutMetricSink(() => {
			throw new Error("EPIPE");
		});
		expect(await sink.emit(record())).toEqual({ ok: false, reason: "threw", detail: "Error" });
	});

	test("when the greptime writer refuses, the stdout fallback writes the line once", async () => {
		const lines: string[] = [];
		const primary = greptimeMetricSink(async () => ({ stored: 0, drops: { invalid: 1 } }));
		const fallback = stdoutMetricSink((line) => lines.push(line));
		const result = await emitTransition(record(), primary, fallback);
		expect(result.status).toBe("fallback");
		expect(lines).toHaveLength(1);
	});
});
