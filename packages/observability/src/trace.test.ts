import { describe, expect, test } from "bun:test";
import {
	SPAN_KIND,
	SPAN_STATUS,
	Tracer,
	formatTraceparent,
	parseTraceparent,
	shouldSample,
	withSpan,
} from "./trace.ts";

describe("traceparent", () => {
	test("round-trips", () => {
		const context = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true };
		expect(parseTraceparent(formatTraceparent(context))).toEqual(context);
	});

	test("reads the sampled flag", () => {
		expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00")?.sampled).toBe(false);
		expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")?.sampled).toBe(true);
	});

	test("tolerates the trailing fields a future version may add", () => {
		expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra")).not.toBeNull();
	});

	test("rejects the all-zero ids the spec calls invalid", () => {
		// Accepting them would graft every surface's work onto one meaningless trace.
		expect(parseTraceparent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`)).toBeNull();
		expect(parseTraceparent(`00-4bf92f3577b34da6a3ce929d0e0e4736-${"0".repeat(16)}-01`)).toBeNull();
	});

	test("rejects a version it does not understand, a short id and nothing at all", () => {
		expect(parseTraceparent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull();
		expect(parseTraceparent("00-4bf92f-00f067aa0ba902b7-01")).toBeNull();
		expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-zz")).toBeNull();
		expect(parseTraceparent(null)).toBeNull();
		expect(parseTraceparent("")).toBeNull();
	});
});

describe("shouldSample", () => {
	test("is decided from the trace id, so every process in a trace agrees", () => {
		const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
		expect(shouldSample(traceId, 0.5)).toBe(shouldSample(traceId, 0.5));
	});

	test("takes everything at 1 and nothing at 0", () => {
		expect(shouldSample("0".repeat(24) + "ffffffff", 1)).toBe(true);
		expect(shouldSample("0".repeat(24) + "00000000", 0)).toBe(false);
	});

	test("splits on the low 32 bits of the id", () => {
		expect(shouldSample("0".repeat(24) + "00000001", 0.5)).toBe(true);
		expect(shouldSample("0".repeat(24) + "fffffffe", 0.5)).toBe(false);
	});
});

describe("Tracer", () => {
	test("a child span joins its parent's trace", () => {
		const tracer = new Tracer();
		const parent = tracer.startSpan("POST /mcp", { kind: SPAN_KIND.server });
		const child = tracer.startSpan("substrate.emit", { parent: parent.context });
		child.end();
		parent.end();

		const [first, second] = tracer.drain();
		expect(first?.name).toBe("substrate.emit");
		expect(first?.traceId).toBe(parent.context.traceId);
		expect(first?.parentSpanId).toBe(parent.context.spanId);
		expect(second?.parentSpanId).toBeNull();
	});

	test("an inherited trace obeys the caller's sampling flag, not this process's ratio", () => {
		// Otherwise a trace would be sampled in one process and dropped in the next,
		// which is worse than not sampling: the trace exists but is missing its middle.
		const tracer = new Tracer({ sampleRatio: 0 });
		const span = tracer.startSpan("child", {
			parent: { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true },
		});
		span.end();

		expect(tracer.drain()).toHaveLength(1);
	});

	test("an unsampled span is not buffered", () => {
		const tracer = new Tracer({ sampleRatio: 0 });
		tracer.startSpan("dropped").end();

		expect(tracer.drain()).toEqual([]);
	});

	test("a span with no explicit status ends as ok", () => {
		const tracer = new Tracer();
		tracer.startSpan("s").end();

		expect(tracer.drain()[0]?.status.code).toBe(SPAN_STATUS.ok);
	});

	test("end is idempotent", () => {
		const tracer = new Tracer();
		const span = tracer.startSpan("s");
		span.end();
		span.end();

		expect(tracer.drain()).toHaveLength(1);
	});

	test("drops the oldest span when the buffer is full, and counts what it dropped", () => {
		// Bounded because the substrate fails open: a collector that stops accepting
		// spans costs the traces, never the host's memory.
		const tracer = new Tracer({ maxSpans: 16 });
		for (let i = 0; i < 20; i++) tracer.startSpan(`s${i}`).end();

		const spans = tracer.drain();
		expect(spans).toHaveLength(16);
		expect(tracer.dropped).toBe(4);
		expect(spans[0]?.name).toBe("s4"); // the newest are kept — they explain the outage
	});

	test("a clock that steps backwards does not produce a negative duration", () => {
		let clock = 1000;
		const tracer = new Tracer({ now: () => clock });
		const span = tracer.startSpan("s");
		clock = 500;
		span.end();

		const [record] = tracer.drain();
		expect(record?.endEpochMs).toBe(record?.startEpochMs);
	});

	test("attributes can be set at start and after", () => {
		const tracer = new Tracer();
		const span = tracer.startSpan("s", { attributes: { surface: "omp", graph_id: null } });
		span.setAttribute("substrate.stored", true);
		span.setAttribute("dropped", undefined);
		span.setAttributes({ route: "/events" });
		span.end();

		expect(tracer.drain()[0]?.attributes).toEqual({ surface: "omp", "substrate.stored": true, route: "/events" });
	});
});

describe("withSpan", () => {
	test("records the failure and rethrows", async () => {
		// A span is a record of what happened, never a reason for it to happen
		// differently.
		const tracer = new Tracer();
		const span = tracer.startSpan("s");

		await expect(
			withSpan(span, async () => {
				throw new Error("postgres is down");
			}),
		).rejects.toThrow("postgres is down");

		const [record] = tracer.drain();
		expect(record?.status.code).toBe(SPAN_STATUS.error);
		expect(record?.status.message).toContain("postgres is down");
	});

	test("closes the span on success and returns the value", async () => {
		const tracer = new Tracer();
		const value = await withSpan(tracer.startSpan("s"), async () => 42);

		expect(value).toBe(42);
		expect(tracer.drain()[0]?.status.code).toBe(SPAN_STATUS.ok);
	});

	test("the failure message passes through the describer, so it can be redacted", async () => {
		const tracer = new Tracer();
		await withSpan(
			tracer.startSpan("s"),
			async () => {
				throw new Error("postgres://user:hunter2@host/db refused");
			},
			() => "postgres://user:[REDACTED]@host/db refused",
		).catch(() => undefined);

		expect(tracer.drain()[0]?.status.message).not.toContain("hunter2");
	});
});
