/** Fake-only tests for the phase-86 correlation helpers. No I/O, no clock. */
import { describe, expect, test } from "bun:test";
import {
	applyCorrelationHeader,
	CORRELATION_HEADER,
	correlationFromHeaders,
	currentCorrelation,
	normalizeCorrelationId,
	safeCorrelationId,
	runWithCorrelation,
} from "./correlation.ts";

describe("normalizeCorrelationId", () => {
	test("accepts the graph-bind alphabet", () => {
		expect(normalizeCorrelationId("graph-1:abc.XY_9")).toBe("graph-1:abc.XY_9");
	});
	test("rejects everything else, and never echoes it", () => {
		for (const bad of [
			"",
			"has space",
			"semi;colon",
			"quote\"x",
			"angle<x>",
			"../escape",
			"x".repeat(201),
			"Bearer secret-token",
			undefined,
			null,
			42,
		]) {
			expect(normalizeCorrelationId(bad)).toBeNull();
			expect(safeCorrelationId(bad)).toBeNull();
		}
	});
});

describe("redaction", () => {
	test("only the validated form is ever emitted", () => {
		expect(safeCorrelationId("ok-1")).toBe("ok-1");
		expect(safeCorrelationId("<script>alert(1)</script>")).toBeNull();
	});
});

describe("ambient correlation", () => {
	test("runs inside, null outside", () => {
		expect(currentCorrelation()).toBeNull();
		const seen = runWithCorrelation("req-1", () => currentCorrelation());
		expect(seen).toBe("req-1");
		expect(currentCorrelation()).toBeNull();
	});
});

describe("applyCorrelationHeader", () => {
	test("sets the header without mutating the input", () => {
		const init = { method: "GET" };
		const out = applyCorrelationHeader(init, "req-9");
		expect(new Headers(out?.headers).get(CORRELATION_HEADER)).toBe("req-9");
		expect(init).toEqual({ method: "GET" });
	});
	test("invalid ids leave the init untouched", () => {
		expect(applyCorrelationHeader({ method: "GET" }, "no good")).toEqual({ method: "GET" });
		expect(applyCorrelationHeader(undefined, null)).toBeUndefined();
	});
});

describe("correlationFromHeaders", () => {
	test("reads Headers and plain records, validates both", () => {
		const headers = new Headers({ [CORRELATION_HEADER]: "a-1" });
		expect(correlationFromHeaders(headers)).toBe("a-1");
		expect(correlationFromHeaders({ [CORRELATION_HEADER]: "b-2" })).toBe("b-2");
		expect(correlationFromHeaders({ [CORRELATION_HEADER]: "has space" })).toBeNull();
		expect(correlationFromHeaders(undefined)).toBeNull();
	});
});
