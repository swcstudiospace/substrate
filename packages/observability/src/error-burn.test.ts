/** Fake-only tests for the phase-86 error/timeout burn detector. No I/O. */
import { describe, expect, test } from "bun:test";
import { MetricRegistry, type MetricSnapshot } from "./metrics.ts";
import type { PlaneOutcome } from "./breaker.ts";
import { SubstrateInstruments } from "./instruments.ts";
import { evaluateErrorBurn, evaluateErrorBurnFromSnapshot, ERROR_BURN_ID } from "./error-burn.ts";

describe("evaluateErrorBurn", () => {
	test("healthy planes read ok", () => {
		const result = evaluateErrorBurn({ ok: 990, error: 5, timeout: 3, open: 1 });
		expect(result.id).toBe(ERROR_BURN_ID);
		expect(result.status).toBe("ok");
		expect(result.samples).toBe(999);
		expect(result.observed).toBeCloseTo(9 / 999, 9);
	});
	test("error/timeout storms breach", () => {
		const result = evaluateErrorBurn({ ok: 900, error: 60, timeout: 40, open: 0 });
		expect(result.status).toBe("breached");
		expect(result.observed).toBeCloseTo(0.1, 9);
	});
	test("sparse data is insufficient-data, never ok", () => {
		const result = evaluateErrorBurn({ ok: 5, error: 0, timeout: 0, open: 0 });
		expect(result.status).toBe("insufficient-data");
		expect(result.samples).toBe(5);
	});
	test("boundary: exactly at target is ok, one more bad call breaches", () => {
		expect(evaluateErrorBurn({ ok: 99, error: 1, timeout: 0, open: 0 }).status).toBe("ok");
		expect(evaluateErrorBurn({ ok: 98, error: 2, timeout: 0, open: 0 }).status).toBe("breached");
	});
	test("defensive sums: negatives and NaN read as zero", () => {
		const result = evaluateErrorBurn({ ok: 100, error: -5, timeout: Number.NaN, open: 0 });
		expect(result.status).toBe("ok");
		expect(result.samples).toBe(100);
	});
});

describe("evaluateErrorBurnFromSnapshot", () => {
	function snapshotWith(outcome: PlaneOutcome, count: number): MetricSnapshot[] {
		const instruments = new SubstrateInstruments();
		for (let i = 0; i < count; i++) {
			instruments.recordPlane({ plane: "greptime", op: "read", outcome, durationMs: 10 });
		}
		return instruments.snapshot();
	}
	test("fires breached on fake error/timeout histograms", () => {
		const instruments = new SubstrateInstruments();
		for (let i = 0; i < 180; i++) instruments.recordPlane({ plane: "greptime", op: "read", outcome: "ok", durationMs: 10 });
		for (let i = 0; i < 15; i++) instruments.recordPlane({ plane: "greptime", op: "read", outcome: "timeout", durationMs: 900 });
		for (let i = 0; i < 5; i++) instruments.recordPlane({ plane: "greptime", op: "read", outcome: "error", durationMs: 900 });
		const result = evaluateErrorBurnFromSnapshot(instruments.snapshot());
		expect(result.status).toBe("breached");
		expect(result.samples).toBe(200);
	});
	test("absent histogram is insufficient-data", () => {
		const result = evaluateErrorBurnFromSnapshot(new MetricRegistry().snapshot());
		expect(result.status).toBe("insufficient-data");
		expect(result.observed).toBeNull();
	});
	test("healthy histogram reads ok", () => {
		const result = evaluateErrorBurnFromSnapshot(snapshotWith("ok", 100));
		expect(result.status).toBe("ok");
	});
});
