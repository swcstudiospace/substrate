import { describe, expect, test } from "bun:test";
import {
	BreakerOpenError,
	CircuitBreaker,
	DEFAULT_BREAKER_SETTINGS,
	PLANES,
	PlaneRegistry,
	callPlane,
	gatedFetch,
	loadBreakerSettings,
	type PlaneGate,
	type PlaneSample,
} from "./breaker.ts";

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
	let now = start;
	return { now: () => now, advance: (ms: number) => (now += ms) };
}

function abortError(name: "AbortError" | "TimeoutError"): Error {
	const error = new Error(name);
	error.name = name;
	return error;
}

describe("loadBreakerSettings", () => {
	test("defaults to on, five failures, thirty seconds", () => {
		expect(loadBreakerSettings({})).toEqual(DEFAULT_BREAKER_SETTINGS);
		expect(DEFAULT_BREAKER_SETTINGS).toEqual({ enabled: true, failureThreshold: 5, openMs: 30_000 });
	});

	test("SUBSTRATE_BREAKER=0|false|no is the kill switch; anything else leaves it on", () => {
		for (const off of ["0", "false", "NO", " no "]) expect(loadBreakerSettings({ SUBSTRATE_BREAKER: off }).enabled).toBe(false);
		for (const on of ["1", "yes", "off", ""]) expect(loadBreakerSettings({ SUBSTRATE_BREAKER: on }).enabled).toBe(true);
	});

	test("bounds the threshold and the open window, falling back on bad values", () => {
		expect(loadBreakerSettings({ SUBSTRATE_BREAKER_FAILURES: "3", SUBSTRATE_BREAKER_OPEN_MS: "5000" })).toMatchObject({
			failureThreshold: 3,
			openMs: 5000,
		});
		for (const bad of ["0", "101", "2.5", "abc", "-1"]) {
			expect(loadBreakerSettings({ SUBSTRATE_BREAKER_FAILURES: bad }).failureThreshold).toBe(5);
		}
		for (const bad of ["999", "600001", "x", "1e3"]) {
			expect(loadBreakerSettings({ SUBSTRATE_BREAKER_OPEN_MS: bad }).openMs).toBe(30_000);
		}
		expect(loadBreakerSettings({ SUBSTRATE_BREAKER_OPEN_MS: "1000" }).openMs).toBe(1000);
		expect(loadBreakerSettings({ SUBSTRATE_BREAKER_OPEN_MS: "600000" }).openMs).toBe(600_000);
	});
});

describe("CircuitBreaker", () => {
	test("opens on the threshold-th consecutive failure and refuses while open", () => {
		const c = clock();
		const breaker = new CircuitBreaker("greptime", { failureThreshold: 3, openMs: 1000 }, c.now);
		breaker.onFailure("one");
		breaker.onFailure("two");
		expect(breaker.state()).toBe("closed");
		expect(breaker.allow()).toBe(true);
		breaker.onFailure("three");
		expect(breaker.state()).toBe("open");
		expect(breaker.allow()).toBe(false);
		expect(breaker.snapshot()).toEqual({
			plane: "greptime",
			state: "open",
			failures: 3,
			openedAt: c.now(),
			lastErrorAt: c.now(),
			lastError: "three",
		});
	});

	test("a success resets the consecutive count", () => {
		const breaker = new CircuitBreaker("index", { failureThreshold: 2 }, clock().now);
		breaker.onFailure("a");
		breaker.onSuccess();
		breaker.onFailure("b");
		expect(breaker.state()).toBe("closed");
		expect(breaker.snapshot().failures).toBe(1);
	});

	test("half-open exactly at the openMs boundary, and only one probe is admitted", () => {
		const c = clock();
		const breaker = new CircuitBreaker("hindsight", { failureThreshold: 1, openMs: 1000 }, c.now);
		breaker.onFailure("down");
		c.advance(999);
		expect(breaker.state()).toBe("open");
		expect(breaker.allow()).toBe(false);
		c.advance(1);
		expect(breaker.state()).toBe("half-open");
		expect(breaker.allow()).toBe(true);
		// The probe is in flight: nobody else gets through.
		expect(breaker.allow()).toBe(false);
		expect(breaker.allow()).toBe(false);
	});

	test("a successful probe closes; a failed probe re-opens for a fresh window", () => {
		const c = clock();
		const breaker = new CircuitBreaker("ragflow", { failureThreshold: 1, openMs: 1000 }, c.now);
		breaker.onFailure("down");
		c.advance(1000);
		expect(breaker.allow()).toBe(true);
		breaker.onFailure("still down");
		expect(breaker.state()).toBe("open");
		expect(breaker.retryAfterMs()).toBe(1000);
		c.advance(1000);
		expect(breaker.allow()).toBe(true);
		breaker.onSuccess();
		expect(breaker.state()).toBe("closed");
		expect(breaker.allow()).toBe(true);
		expect(breaker.snapshot()).toMatchObject({ failures: 0, openedAt: null, lastError: "still down" });
	});

	test("truncates the recorded reason to 200 characters", () => {
		const breaker = new CircuitBreaker("cache", {}, clock().now);
		breaker.onFailure("x".repeat(500));
		expect(breaker.snapshot().lastError?.length).toBe(200);
	});
});

function gateFor(plane: PlaneGate["plane"], breaker: CircuitBreaker | null): { gate: PlaneGate; samples: PlaneSample[] } {
	const samples: PlaneSample[] = [];
	return { gate: { plane, breaker, observe: (sample) => samples.push(sample) }, samples };
}

describe("callPlane", () => {
	test("without a gate it just runs the function", async () => {
		expect(await callPlane(null, "sql", async () => 7)).toBe(7);
		expect(await callPlane(undefined, "sql", async () => 8)).toBe(8);
	});

	test("ok: success observed with a duration, breaker closed", async () => {
		const { gate, samples } = gateFor("greptime", new CircuitBreaker("greptime"));
		expect(await callPlane(gate, "select", async () => "rows")).toBe("rows");
		expect(samples).toHaveLength(1);
		expect(samples[0]).toMatchObject({ plane: "greptime", op: "select", outcome: "ok" });
		expect(samples[0]?.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("error: counted, observed as error with the reason, rethrown unchanged", async () => {
		const { gate, samples } = gateFor("index", new CircuitBreaker("index"));
		const boom = new Error("connect ECONNREFUSED");
		await expect(callPlane(gate, "query", async () => Promise.reject(boom))).rejects.toBe(boom);
		expect(samples[0]).toMatchObject({ outcome: "error", reason: "connect ECONNREFUSED", op: "query" });
		expect(gate.breaker?.snapshot().failures).toBe(1);
	});

	test("timeout: an AbortError or TimeoutError is observed as timeout", async () => {
		const { gate, samples } = gateFor("hindsight", new CircuitBreaker("hindsight"));
		await expect(callPlane(gate, "recall", () => Promise.reject(abortError("TimeoutError")))).rejects.toThrow();
		await expect(callPlane(gate, "recall", () => Promise.reject(abortError("AbortError")))).rejects.toThrow();
		expect(samples.map((sample) => sample.outcome)).toEqual(["timeout", "timeout"]);
	});

	test("open: the function is never called, open is observed with no duration, BreakerOpenError thrown", async () => {
		const c = clock();
		const { gate, samples } = gateFor("ragflow", new CircuitBreaker("ragflow", { failureThreshold: 1, openMs: 30_000 }, c.now));
		await expect(callPlane(gate, "retrieve", () => Promise.reject(new Error("down")))).rejects.toThrow("down");
		let called = false;
		const refused = callPlane(gate, "retrieve", async () => {
			called = true;
			return 1;
		});
		await expect(refused).rejects.toBeInstanceOf(BreakerOpenError);
		expect(called).toBe(false);
		expect(samples[1]).toEqual({ plane: "ragflow", op: "retrieve", outcome: "open", durationMs: 0 });
		await refused.catch((error: BreakerOpenError) => {
			expect(error.plane).toBe("ragflow");
			expect(error.retryAfterMs).toBe(30_000);
			expect(error.message).toContain("circuit open");
		});
	});

	test("isFailure false: the error is rethrown but the breaker is not charged", async () => {
		const { gate, samples } = gateFor("greptime", new CircuitBreaker("greptime", { failureThreshold: 1 }));
		await expect(
			callPlane(gate, "sql", () => Promise.reject(new Error("syntax error")), { isFailure: () => false }),
		).rejects.toThrow("syntax error");
		expect(gate.breaker?.state()).toBe("closed");
		expect(samples[0]?.outcome).toBe("ok");
	});

	test("a disabled registry has null breakers, and calls still run and are measured", async () => {
		const samples: PlaneSample[] = [];
		const registry = new PlaneRegistry({ enabled: false, failureThreshold: 1, openMs: 1000 }, (sample) => samples.push(sample));
		const gate = registry.gate("cache");
		expect(gate.breaker).toBeNull();
		for (let i = 0; i < 3; i++) await expect(callPlane(gate, "get", () => Promise.reject(new Error("no")))).rejects.toThrow("no");
		// Still every call reaches the plane: no BreakerOpenError, ever.
		expect(await callPlane(gate, "get", async () => "value")).toBe("value");
		expect(samples.map((sample) => sample.outcome)).toEqual(["error", "error", "error", "ok"]);
		expect(registry.snapshots()).toEqual({ greptime: null, index: null, cache: null, hindsight: null, ragflow: null });
	});

	test("the registry hands out one gate per plane, and snapshots every plane", () => {
		const registry = new PlaneRegistry(DEFAULT_BREAKER_SETTINGS);
		expect(registry.gate("index")).toBe(registry.gate("index"));
		registry.gate("index").breaker?.onFailure("x");
		const snapshots = registry.snapshots();
		expect(Object.keys(snapshots).sort()).toEqual([...PLANES].sort());
		expect(snapshots.index?.failures).toBe(1);
		expect(snapshots.greptime?.state).toBe("closed");
	});
});

describe("gatedFetch", () => {
	const opOf = (method: string, url: string): string => `${method} ${new URL(url).pathname}`;

	test("without a gate it is the fetch it was given", () => {
		const fetchImpl = async () => new Response("x");
		expect(gatedFetch(null, fetchImpl, opOf)).toBe(fetchImpl);
	});

	test("a 5xx counts as a failure yet is returned to the caller; a 4xx counts as ok", async () => {
		const { gate, samples } = gateFor("ragflow", new CircuitBreaker("ragflow", { failureThreshold: 2 }));
		let status = 503;
		const fetchImpl = gatedFetch(gate, async () => new Response("", { status }), opOf);
		const first = await fetchImpl("http://plane.test/api/v1/datasets");
		expect(first.status).toBe(503);
		status = 404;
		const second = await fetchImpl("http://plane.test/api/v1/datasets", { method: "GET" });
		expect(second.status).toBe(404);
		expect(samples.map((sample) => sample.outcome)).toEqual(["error", "ok"]);
		expect(samples[0]?.reason).toBe("server 503");
		expect(samples[0]?.op).toBe("GET /api/v1/datasets");
	});

	test("transport errors reject through, and an open breaker rejects with BreakerOpenError before fetching", async () => {
		const { gate } = gateFor("hindsight", new CircuitBreaker("hindsight", { failureThreshold: 1 }));
		let calls = 0;
		const fetchImpl = gatedFetch(
			gate,
			async () => {
				calls += 1;
				throw new Error("fetch failed");
			},
			opOf,
		);
		await expect(fetchImpl("http://plane.test/health")).rejects.toThrow("fetch failed");
		await expect(fetchImpl("http://plane.test/health")).rejects.toBeInstanceOf(BreakerOpenError);
		expect(calls).toBe(1);
	});

	test("derives the method from the init or the Request", async () => {
		const { gate, samples } = gateFor("hindsight", new CircuitBreaker("hindsight"));
		const fetchImpl = gatedFetch(gate, async () => new Response("{}"), opOf);
		await fetchImpl("http://plane.test/a", { method: "post" });
		await fetchImpl(new Request("http://plane.test/b", { method: "PATCH" }));
		await fetchImpl(new URL("http://plane.test/c"));
		expect(samples.map((sample) => sample.op)).toEqual(["POST /a", "PATCH /b", "GET /c"]);
	});

	test("a body that stalls past the deadline is a timeout failure, not a success with headers", async () => {
		// Greptile round 1: headers arrived, so the gate used to record ok and the
		// caller timed out alone. The body is now read inside the gate under the
		// request's own signal.
		const { gate, samples } = gateFor("ragflow", new CircuitBreaker("ragflow", { failureThreshold: 1 }));
		const stalled = new ReadableStream<Uint8Array>({ start: () => {} });
		const fetchImpl = gatedFetch(gate, async () => new Response(stalled, { status: 200, headers: { "content-type": "application/json" } }), opOf);
		const started = performance.now();
		await expect(fetchImpl("http://plane.test/api/v1/retrieval", { method: "POST", signal: AbortSignal.timeout(30) })).rejects.toThrow();
		expect(performance.now() - started).toBeLessThan(1000);
		expect(samples).toHaveLength(1);
		expect(samples[0]?.outcome).toBe("timeout");
		expect(gate.breaker?.snapshot().failures).toBe(1);
		expect(gate.breaker?.state()).toBe("open");
	});

	test("a buffered answer keeps its status and headers and still parses downstream", async () => {
		const { gate, samples } = gateFor("hindsight", new CircuitBreaker("hindsight"));
		const fetchImpl = gatedFetch(
			gate,
			async () => new Response(JSON.stringify({ results: [1, 2] }), { status: 201, headers: { "x-plane": "yes", "content-type": "application/json" } }),
			opOf,
		);
		const response = await fetchImpl("http://plane.test/v1/x", { signal: AbortSignal.timeout(1000) });
		expect(response.status).toBe(201);
		expect(response.headers.get("x-plane")).toBe("yes");
		expect(await response.json()).toEqual({ results: [1, 2] });
		expect(samples[0]?.outcome).toBe("ok");

		const empty = gatedFetch(gate, async () => new Response(null, { status: 204 }), opOf);
		expect((await empty("http://plane.test/v1/y")).status).toBe(204);
	});
});
