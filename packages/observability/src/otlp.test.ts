import { describe, expect, test } from "bun:test";
import { Counter, Histogram, MetricRegistry } from "./metrics.ts";
import { OtlpExporter, PeriodicExporter, anyValue, encodeMetrics, encodeSpans, keyValues, unixNanoString } from "./otlp.ts";
import { SPAN_KIND, SPAN_STATUS, type SpanRecord } from "./trace.ts";

const RESOURCE = {
	serviceName: "substrate-mcp",
	serviceVersion: "0.1.0",
	serviceInstanceId: "vps-1",
	deploymentEnvironment: "prod",
};

describe("unixNanoString", () => {
	test("builds the digits by string arithmetic, not by a float multiply", () => {
		// A unix nanosecond timestamp is past Number.MAX_SAFE_INTEGER, so `ms * 1e6` is
		// not an exactly representable integer — it prints correctly today only because
		// the nearest double happens to round-trip that way. The string is exact by
		// construction, which is what a wire format should rest on.
		expect(unixNanoString(1_790_186_361_859)).toBe("1790186361859000000");
		expect(Number.isSafeInteger(1_790_186_361_859 * 1e6)).toBe(false);
	});

	test("keeps the sub-millisecond part", () => {
		expect(unixNanoString(1_790_186_361_859.25)).toBe("1790186361859250000");
	});

	test("never produces more than nine digits of fraction", () => {
		expect(unixNanoString(1_790_186_361_859.9999999)).toHaveLength("1790186361859".length + 6);
	});

	test("refuses a nonsense timestamp rather than emitting NaN", () => {
		expect(unixNanoString(Number.NaN)).toBe("0");
		expect(unixNanoString(-1)).toBe("0");
	});
});

describe("attribute encoding", () => {
	test("types each value the way OTLP JSON expects", () => {
		expect(anyValue("omp")).toEqual({ stringValue: "omp" });
		expect(anyValue(true)).toEqual({ boolValue: true });
		expect(anyValue(7)).toEqual({ intValue: "7" });
		expect(anyValue(0.5)).toEqual({ doubleValue: 0.5 });
	});

	test("sorts keys, so two exports of the same series are byte-identical", () => {
		expect(keyValues({ b: "2", a: "1" }).map((pair) => pair.key)).toEqual(["a", "b"]);
	});
});

describe("encodeMetrics", () => {
	function snapshot() {
		const registry = new MetricRegistry(1000);
		registry.counter("substrate.emit.total", { unit: "{event}" }).add(3, { surface: "omp", outcome: "stored" });
		registry.counter("substrate.cost.usd", { valueType: "double" }).add(0.125, { surface: "omp" });
		registry.histogram("substrate.brief.duration", { bounds: [10, 100], unit: "ms" }).record(42, { surface: "omp" });
		return registry.snapshot();
	}

	test("64-bit fields are strings", () => {
		// A number would lose precision above 2^53, and `timeUnixNano` is ~1.8e18 today.
		const { body } = encodeMetrics(snapshot(), RESOURCE, 1000, 2000) as {
			body: { resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Array<Record<string, any>> }> }> };
		};
		const metrics = body.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
		const sum = metrics.find((metric) => metric.name === "substrate.emit.total")!;
		const histogram = metrics.find((metric) => metric.name === "substrate.brief.duration")!;

		expect(sum.sum.dataPoints[0].asInt).toBe("3");
		expect(sum.sum.dataPoints[0].timeUnixNano).toBe("2000000000");
		expect(sum.sum.dataPoints[0].startTimeUnixNano).toBe("1000000000");
		expect(histogram.histogram.dataPoints[0].count).toBe("1");
		expect(histogram.histogram.dataPoints[0].bucketCounts).toEqual(["0", "1", "0"]);
	});

	test("a double counter uses asDouble, not asInt", () => {
		const { body } = encodeMetrics(snapshot(), RESOURCE, 1000, 2000) as { body: any };
		const cost = body.resourceMetrics[0].scopeMetrics[0].metrics.find(
			(metric: any) => metric.name === "substrate.cost.usd",
		);

		expect(cost.sum.dataPoints[0].asDouble).toBeCloseTo(0.125, 10);
		expect(cost.sum.dataPoints[0].asInt).toBeUndefined();
	});

	test("counters are cumulative and monotonic, which is what makes a missed export harmless", () => {
		const { body } = encodeMetrics(snapshot(), RESOURCE, 1000, 2000) as { body: any };
		const sum = body.resourceMetrics[0].scopeMetrics[0].metrics.find(
			(metric: any) => metric.name === "substrate.emit.total",
		);

		expect(sum.sum.aggregationTemporality).toBe(2);
		expect(sum.sum.isMonotonic).toBe(true);
	});

	test("carries explicitBounds so a collector can recompute the quantile itself", () => {
		const { body } = encodeMetrics(snapshot(), RESOURCE, 1000, 2000) as { body: any };
		const histogram = body.resourceMetrics[0].scopeMetrics[0].metrics.find(
			(metric: any) => metric.name === "substrate.brief.duration",
		);

		expect(histogram.histogram.dataPoints[0].explicitBounds).toEqual([10, 100]);
	});

	test("names the service on the resource, not on every point", () => {
		const { body } = encodeMetrics(snapshot(), RESOURCE, 1000, 2000) as { body: any };
		const attributes = body.resourceMetrics[0].resource.attributes.map((pair: any) => pair.key);

		expect(attributes).toContain("service.name");
		expect(attributes).toContain("service.instance.id");
		expect(attributes).toContain("deployment.environment");
	});

	test("omits instruments that have no series", () => {
		const registry = new MetricRegistry(1000);
		registry.counter("never.used");
		const { body, items } = encodeMetrics(registry.snapshot(), RESOURCE, 1000, 2000) as { body: any; items: number };

		expect(items).toBe(0);
		expect(body.resourceMetrics[0].scopeMetrics[0].metrics).toEqual([]);
	});
});

describe("encodeSpans", () => {
	const span: SpanRecord = {
		traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
		spanId: "00f067aa0ba902b7",
		parentSpanId: null,
		name: "POST /brief",
		kind: SPAN_KIND.server,
		startEpochMs: 1_790_186_361_859,
		endEpochMs: 1_790_186_361_873.5,
		attributes: { surface: "omp" },
		status: { code: SPAN_STATUS.ok },
	};

	test("ids stay hex and times become nano strings", () => {
		const { body } = encodeSpans([span], RESOURCE) as { body: any };
		const encoded = body.resourceSpans[0].scopeSpans[0].spans[0];

		expect(encoded.traceId).toBe(span.traceId);
		expect(encoded.startTimeUnixNano).toBe("1790186361859000000");
		expect(encoded.endTimeUnixNano).toBe("1790186361873500000");
	});

	test("a root span omits parentSpanId rather than sending all-zeros", () => {
		// Some collectors reject the explicit all-zero form; the spec treats an absent
		// parent as the root either way.
		const { body } = encodeSpans([span], RESOURCE) as { body: any };
		expect("parentSpanId" in body.resourceSpans[0].scopeSpans[0].spans[0]).toBe(false);
	});

	test("a child span carries its parent", () => {
		const { body } = encodeSpans([{ ...span, parentSpanId: "aaaaaaaaaaaaaaaa" }], RESOURCE) as { body: any };
		expect(body.resourceSpans[0].scopeSpans[0].spans[0].parentSpanId).toBe("aaaaaaaaaaaaaaaa");
	});

	test("an error status carries its message", () => {
		const { body } = encodeSpans([{ ...span, status: { code: SPAN_STATUS.error, message: "boom" } }], RESOURCE) as {
			body: any;
		};
		expect(body.resourceSpans[0].scopeSpans[0].spans[0].status).toEqual({ code: 2, message: "boom" });
	});
});

describe("OtlpExporter", () => {
	const config = {
		metricsEndpoint: "https://collector.example",
		tracesEndpoint: "https://collector.example",
		headers: { "x-key": "k" },
		timeoutMs: 100,
		resource: RESOURCE,
	};

	function registryWithOnePoint() {
		const registry = new MetricRegistry(1000);
		registry.counter("c").add(1);
		return registry;
	}

	test("posts to /v1/metrics and /v1/traces with the configured headers", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const exporter = new OtlpExporter(config, {
			fetch: async (url, init) => {
				calls.push({ url, headers: init.headers as Record<string, string> });
				return new Response("", { status: 200 });
			},
		});

		await exporter.exportMetrics(registryWithOnePoint().snapshot(), 1000);
		await exporter.exportSpans([
			{
				traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
				spanId: "00f067aa0ba902b7",
				parentSpanId: null,
				name: "s",
				kind: SPAN_KIND.internal,
				startEpochMs: 1,
				endEpochMs: 2,
				attributes: {},
				status: { code: SPAN_STATUS.ok },
			},
		]);

		expect(calls.map((call) => call.url)).toEqual([
			"https://collector.example/v1/metrics",
			"https://collector.example/v1/traces",
		]);
		expect(calls[0]?.headers["content-type"]).toBe("application/json");
		expect(calls[0]?.headers["x-key"]).toBe("k");
	});

	test("sends nothing when there is nothing to send", async () => {
		let called = false;
		const exporter = new OtlpExporter(config, {
			fetch: async () => {
				called = true;
				return new Response("", { status: 200 });
			},
		});

		expect(await exporter.exportMetrics(new MetricRegistry().snapshot(), 1000)).toEqual({ ok: true, items: 0 });
		expect(await exporter.exportSpans([])).toEqual({ ok: true, items: 0 });
		expect(called).toBe(false);
	});

	test("a collector that is down does not throw", async () => {
		// The substrate fails open. A collector being unreachable is not a reason for a
		// prompt to be.
		const exporter = new OtlpExporter(config, {
			fetch: async () => {
				throw new Error("connect ECONNREFUSED");
			},
		});

		const result = await exporter.exportMetrics(registryWithOnePoint().snapshot(), 1000);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("ECONNREFUSED");
		expect(exporter.failures).toBe(1);
	});

	test("a rejected batch is reported with its status, and the body is redacted", async () => {
		const exporter = new OtlpExporter(config, {
			fetch: async () => new Response("bad token hunter2", { status: 401 }),
			redact: (text) => text.replace("hunter2", "[REDACTED]"),
		});

		const result = await exporter.exportMetrics(registryWithOnePoint().snapshot(), 1000);
		expect(result).toMatchObject({ ok: false, status: 401 });
		expect(result.error).toBe("bad token [REDACTED]");
	});

	test("each signal goes to its own endpoint", async () => {
		const calls: string[] = [];
		const exporter = new OtlpExporter(
			{
				metricsEndpoint: "https://metrics.example",
				tracesEndpoint: "https://traces.example",
				headers: {},
				timeoutMs: 100,
				resource: RESOURCE,
			},
			{
				fetch: async (url) => {
					calls.push(url);
					return new Response("", { status: 200 });
				},
			},
		);

		await exporter.exportMetrics(registryWithOnePoint().snapshot(), 1000);
		await exporter.exportSpans([
			{
				traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
				spanId: "00f067aa0ba902b7",
				parentSpanId: null,
				name: "s",
				kind: SPAN_KIND.internal,
				startEpochMs: 1,
				endEpochMs: 2,
				attributes: {},
				status: { code: SPAN_STATUS.ok },
			},
		]);

		expect(calls).toEqual(["https://metrics.example/v1/metrics", "https://traces.example/v1/traces"]);
	});

	test("a signal with no endpoint is not sent anywhere", async () => {
		// Rather than to the other signal's collector, which is where they used to go.
		let called = false;
		const exporter = new OtlpExporter(
			{ metricsEndpoint: "https://metrics.example", tracesEndpoint: "", headers: {}, timeoutMs: 100, resource: RESOURCE },
			{
				fetch: async () => {
					called = true;
					return new Response("", { status: 200 });
				},
			},
		);

		expect(
			await exporter.exportSpans([
				{
					traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
					spanId: "00f067aa0ba902b7",
					parentSpanId: null,
					name: "s",
					kind: SPAN_KIND.internal,
					startEpochMs: 1,
					endEpochMs: 2,
					attributes: {},
					status: { code: SPAN_STATUS.ok },
				},
			]),
		).toEqual({ ok: true, items: 0 });
		expect(called).toBe(false);
	});

	test("a success resets the failure streak", async () => {
		let fail = true;
		const exporter = new OtlpExporter(config, {
			fetch: async () => {
				if (fail) throw new Error("down");
				return new Response("", { status: 200 });
			},
		});

		await exporter.exportMetrics(registryWithOnePoint().snapshot(), 1000);
		expect(exporter.failures).toBe(1);
		fail = false;
		await exporter.exportMetrics(registryWithOnePoint().snapshot(), 1000);
		expect(exporter.failures).toBe(0);
	});
});

describe("PeriodicExporter", () => {
	test("drains the tracer and snapshots the registry on flush", async () => {
		const registry = new MetricRegistry(1000);
		registry.counter("c").add(1);
		let drained = 0;
		const exporter = new OtlpExporter(
			{
				metricsEndpoint: "https://collector.example",
				tracesEndpoint: "https://collector.example",
				headers: {},
				timeoutMs: 100,
				resource: RESOURCE,
			},
			{ fetch: async () => new Response("", { status: 200 }) },
		);

		const periodic = new PeriodicExporter({
			exporter,
			snapshot: () => registry.snapshot(),
			drainSpans: () => {
				drained++;
				return [];
			},
			startedAt: 1000,
			intervalMs: 1000,
		});

		const result = await periodic.flush();
		expect(result.metrics.ok).toBe(true);
		expect(result.metrics.items).toBe(1);
		expect(drained).toBe(1);
	});

	test("stop is safe before start and idempotent after", () => {
		const periodic = new PeriodicExporter({
			exporter: new OtlpExporter({ metricsEndpoint: "x", tracesEndpoint: "x", headers: {}, timeoutMs: 1, resource: RESOURCE }),
			snapshot: () => [],
			drainSpans: () => [],
			startedAt: 0,
			intervalMs: 1000,
		});

		periodic.stop();
		periodic.start();
		periodic.start();
		periodic.stop();
		periodic.stop();
	});
});

describe("instrument reuse across exports", () => {
	test("a counter's total carries forward, so a lost export costs nothing", () => {
		const counter = new Counter("c");
		counter.add(1);
		const first = counter.snapshot().points[0]?.value;
		counter.add(1);

		expect(first).toBe(1);
		expect(counter.snapshot().points[0]?.value).toBe(2);
	});

	test("the same is true of a histogram", () => {
		const histogram = new Histogram("h", [100]);
		histogram.record(1);
		histogram.snapshot();
		histogram.record(1);

		expect(histogram.snapshot().points[0]?.count).toBe(2);
	});
});
