/**
 * The gauge (uplift-4 S2): the one instrument that is a reading rather than a
 * history. It must reach OTLP as a gauge, stay out of the checkpoint, and not
 * exist at all until something sets it.
 */
import { describe, expect, test } from "bun:test";
import { serializeCheckpoint, snapshotCheckpoint } from "./checkpoint.ts";
import { BurnLedger } from "./burn.ts";
import { MetricRegistry } from "./metrics.ts";
import { encodeMetrics } from "./otlp.ts";
import { PlaneWindow } from "./slo.ts";

const RESOURCE = { serviceName: "substrate-mcp", serviceVersion: "0", serviceInstanceId: "test" };

describe("Gauge", () => {
	test("a registry that never sets one has none; setting replaces the reading; a non-finite value is ignored", () => {
		const registry = new MetricRegistry(0);
		expect(registry.snapshot()).toEqual([]);
		const gauge = registry.gauge("substrate.test.reading", { unit: "s", description: "d" });
		expect(registry.gauge("substrate.test.reading")).toBe(gauge);
		// Created but never set: no point, so nothing is exported for it.
		expect(registry.snapshot()[0]).toMatchObject({ kind: "gauge", points: [] });
		gauge.set(10);
		gauge.set(Number.POSITIVE_INFINITY);
		gauge.set(12);
		expect(registry.snapshot()[0]).toMatchObject({ kind: "gauge", name: "substrate.test.reading", unit: "s", points: [{ attributes: {}, value: 12 }] });
	});

	test("OTLP carries it as a gauge data point with no start time, and omits an unset one", () => {
		const registry = new MetricRegistry(0);
		registry.gauge("substrate.test.unset");
		registry.gauge("substrate.test.reading").set(5);
		const { body, items } = encodeMetrics(registry.snapshot(), RESOURCE, 0, 1000);
		const wire = JSON.stringify(body);
		expect(wire).toContain('"name":"substrate.test.reading"');
		expect(wire).not.toContain("substrate.test.unset");
		expect(wire).toContain('"gauge":{"dataPoints"');
		expect(wire).toContain('"asDouble":5');
		expect(wire).not.toContain("startTimeUnixNano");
		expect(items).toBe(1);
	});

	test("the checkpoint never carries a gauge", () => {
		const registry = new MetricRegistry(0);
		registry.gauge("substrate.test.reading").set(5);
		registry.counter("substrate.test.count").add(2);
		const checkpoint = snapshotCheckpoint({ snapshot: () => registry.snapshot() }, new PlaneWindow(), new BurnLedger(), 1, { since: new Date(0).toISOString() });
		expect(checkpoint.metrics.map((metric) => metric.name)).toEqual(["substrate.test.count"]);
		expect(serializeCheckpoint(checkpoint)).not.toContain("substrate.test.reading");
	});

	test("an installed observer is read at every snapshot and wins over set(); null, NaN and a throw read as no point", () => {
		const registry = new MetricRegistry(0);
		const gauge = registry.gauge("substrate.test.reading");
		gauge.set(1);
		let reading: number | null = 10;
		gauge.observe = () => reading;
		expect(registry.snapshot()[0]).toMatchObject({ points: [{ value: 10 }] });
		reading = 11;
		expect(registry.snapshot()[0]).toMatchObject({ points: [{ value: 11 }] });
		for (const bad of [null, Number.NaN]) {
			reading = bad;
			expect(registry.snapshot()[0]).toMatchObject({ points: [] });
		}
		gauge.observe = () => {
			throw new Error("source gone");
		};
		expect(registry.snapshot()[0]).toMatchObject({ points: [] });
	});
});
