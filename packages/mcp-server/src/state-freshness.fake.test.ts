/**
 * Phase 100 (F1) fake tests: the STATE freshness SLI gauge.
 * Pure module — a clock matrix, no server, no I/O.
 */
import { describe, expect, test } from "bun:test";
import { computeStateFreshnessLag, STATE_FRESHNESS_STALE_AFTER_S } from "./state-freshness.ts";

const NOW = 1_700_000_000_000;

describe("computeStateFreshnessLag", () => {
	test("fresh when the last successful ingest is recent", () => {
		const reading = computeStateFreshnessLag({ stateMtimeMs: NOW - 60_000, lastSuccessIngestAtMs: NOW - 10_000, nowMs: NOW });
		expect(reading).toEqual({ lagSeconds: 10, stale: false, reason: null });
	});

	test("lags on the newer of STATE mtime vs last success", () => {
		const reading = computeStateFreshnessLag({ stateMtimeMs: NOW - 5_000, lastSuccessIngestAtMs: NOW - 60_000, nowMs: NOW });
		expect(reading.lagSeconds).toBe(5);
		expect(reading.stale).toBe(false);
	});

	test("stale past the threshold", () => {
		const reading = computeStateFreshnessLag({
			stateMtimeMs: NOW - (STATE_FRESHNESS_STALE_AFTER_S + 60) * 1000,
			lastSuccessIngestAtMs: NOW - (STATE_FRESHNESS_STALE_AFTER_S + 60) * 1000,
			nowMs: NOW,
		});
		expect(reading.stale).toBe(true);
		expect(reading.lagSeconds).toBe(STATE_FRESHNESS_STALE_AFTER_S + 60);
		expect(reading.reason).toContain("stale");
	});

	test("works with either input alone", () => {
		expect(computeStateFreshnessLag({ stateMtimeMs: NOW - 30_000, nowMs: NOW }).lagSeconds).toBe(30);
		expect(computeStateFreshnessLag({ lastSuccessIngestAtMs: NOW - 30_000, nowMs: NOW }).lagSeconds).toBe(30);
	});

	test("fail-open: missing inputs and clock skew never throw", () => {
		expect(computeStateFreshnessLag({ nowMs: NOW })).toEqual({
			lagSeconds: null,
			stale: false,
			reason: expect.stringContaining("unknown"),
		});
		expect(computeStateFreshnessLag({ stateMtimeMs: null, lastSuccessIngestAtMs: null, nowMs: NOW }).lagSeconds).toBeNull();
		expect(computeStateFreshnessLag({ stateMtimeMs: NOW + 60_000, nowMs: NOW }).lagSeconds).toBe(0);
		expect(computeStateFreshnessLag({ stateMtimeMs: Number.NaN, nowMs: NOW }).lagSeconds).toBeNull();
	});
});
