import { describe, expect, test } from "bun:test";
import { loadObservabilityConfig, parseKeyValueList } from "./config.ts";

describe("parseKeyValueList", () => {
	test("reads the OTEL_EXPORTER_OTLP_HEADERS form", () => {
		expect(parseKeyValueList("authorization=Bearer abc,x-scope=substrate")).toEqual({
			authorization: "Bearer abc",
			"x-scope": "substrate",
		});
	});

	test("keeps a value containing '='", () => {
		// A base64 header value ends in padding; splitting on every '=' would truncate it.
		expect(parseKeyValueList("authorization=Basic dXNlcjpwYXNz==")).toEqual({ authorization: "Basic dXNlcjpwYXNz==" });
	});

	test("ignores junk rather than throwing", () => {
		expect(parseKeyValueList("novalue,=noKey,  a = 1 ")).toEqual({ a: "1" });
		expect(parseKeyValueList(undefined)).toEqual({});
	});
});

describe("loadObservabilityConfig", () => {
	test("export is off with no endpoint, but collection is not", () => {
		// The SLOs and the evidence bundle have to work with no collector at all.
		const config = loadObservabilityConfig({});
		expect(config.exportEnabled).toBe(false);
		expect(config.otlp.resource.serviceName).toBe("substrate-mcp");
	});

	test("the metrics-specific endpoint wins over the generic one", () => {
		const config = loadObservabilityConfig({
			OTEL_EXPORTER_OTLP_ENDPOINT: "https://generic.example",
			OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://metrics.example",
		});
		expect(config.otlp.endpoint).toBe("https://metrics.example");
		expect(config.exportEnabled).toBe(true);
	});

	test("strips a path an operator pasted from a collector's docs", () => {
		// Appending `/v1/metrics` to an endpoint that already ends in it would 404 on
		// every export, and the failure would be silent because export fails open.
		expect(loadObservabilityConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://c.example/v1/metrics" }).otlp.endpoint).toBe(
			"https://c.example",
		);
		expect(loadObservabilityConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://c.example/" }).otlp.endpoint).toBe(
			"https://c.example",
		);
	});

	test("clamps the sample ratio to [0, 1] and falls back on nonsense", () => {
		expect(loadObservabilityConfig({ SUBSTRATE_TRACE_SAMPLE_RATIO: "2" }).sampleRatio).toBe(1);
		expect(loadObservabilityConfig({ SUBSTRATE_TRACE_SAMPLE_RATIO: "-1" }).sampleRatio).toBe(1);
		expect(loadObservabilityConfig({ SUBSTRATE_TRACE_SAMPLE_RATIO: "0.25" }).sampleRatio).toBe(0.25);
		expect(loadObservabilityConfig({ SUBSTRATE_TRACE_SAMPLE_RATIO: "banana" }).sampleRatio).toBe(1);
	});

	test("an unset threshold is undefined, so the SLO default stands", () => {
		const config = loadObservabilityConfig({});
		expect(config.slo.briefP95Ms).toBeUndefined();
		expect(loadObservabilityConfig({ SUBSTRATE_SLO_BRIEF_P95_MS: "400" }).slo.briefP95Ms).toBe(400);
		expect(loadObservabilityConfig({ SUBSTRATE_SLO_BRIEF_P95_MS: "" }).slo.briefP95Ms).toBeUndefined();
	});

	test("refuses an export interval short enough to be its own load problem", () => {
		expect(loadObservabilityConfig({ SUBSTRATE_OTLP_INTERVAL_MS: "10" }).intervalMs).toBe(30_000);
		expect(loadObservabilityConfig({ SUBSTRATE_OTLP_INTERVAL_MS: "5000" }).intervalMs).toBe(5000);
	});

	test("carries the standard resource attributes through", () => {
		const config = loadObservabilityConfig({
			OTEL_SERVICE_NAME: "substrate-mcp-canary",
			SUBSTRATE_INSTANCE_ID: "vps-1",
			SUBSTRATE_ENV: "prod",
			OTEL_RESOURCE_ATTRIBUTES: "team=infra",
		});

		expect(config.otlp.resource).toMatchObject({
			serviceName: "substrate-mcp-canary",
			serviceInstanceId: "vps-1",
			deploymentEnvironment: "prod",
			extra: { team: "infra" },
		});
	});
});
