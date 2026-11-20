import { describe, expect, test } from "bun:test";
import { CHAOS_PLANES, degradedIn, degradedReadFor, parseArgs, parseBody, planeOutageIn } from "./chaos-smoke.ts";

describe("parseArgs", () => {
	test("defaults to the ledger, so today's run is unchanged", () => {
		expect(parseArgs([])).toEqual({ plane: "greptime" });
	});

	test("accepts --plane <name> and --plane=<name> for every plane", () => {
		for (const plane of CHAOS_PLANES) {
			expect(parseArgs(["--plane", plane])).toEqual({ plane });
			expect(parseArgs([`--plane=${plane}`])).toEqual({ plane });
		}
	});

	test("refuses an unknown plane, a missing value and an unknown flag", () => {
		expect(parseArgs(["--plane", "dragonfly"])).toMatchObject({ error: expect.stringContaining("unknown plane dragonfly") });
		expect(parseArgs(["--plane"])).toMatchObject({ error: expect.stringContaining("--plane needs") });
		expect(parseArgs(["--plane="])).toMatchObject({ error: expect.stringContaining("--plane needs") });
		expect(parseArgs(["--window", "5"])).toMatchObject({ error: expect.stringContaining("unknown argument --window") });
	});
});

describe("parseBody", () => {
	test("reads bare JSON, the last SSE data frame, or falls back to the text", () => {
		expect(parseBody('{"a":1}')).toEqual({ a: 1 });
		expect(parseBody('event: message\ndata: {"first":1}\n\ndata: {"second":2}\n')).toEqual({ second: 2 });
		expect(parseBody("# a brief")).toBe("# a brief");
	});
});

describe("planeOutageIn", () => {
	const body = (plane: Record<string, unknown>) => ({ index: true, planes: { hindsight: plane } });

	test("ok:false or an open breaker is an outage", () => {
		expect(planeOutageIn(body({ ok: false, breaker: null }), "hindsight")).toBe(true);
		expect(planeOutageIn(body({ ok: true, breaker: { state: "open" } }), "hindsight")).toBe(true);
		expect(planeOutageIn(body({ ok: false, breaker: { state: "open" } }), "hindsight")).toBe(true);
	});

	test("healthy, half-open, unconfigured, a different plane, or an older server is not", () => {
		expect(planeOutageIn(body({ ok: true, breaker: { state: "closed" } }), "hindsight")).toBe(false);
		expect(planeOutageIn(body({ ok: true, breaker: { state: "half-open" } }), "hindsight")).toBe(false);
		expect(planeOutageIn(body({ ok: null, breaker: null }), "hindsight")).toBe(false);
		expect(planeOutageIn(body({ ok: false, breaker: null }), "lightrag")).toBe(false);
		expect(planeOutageIn({ index: false, greptime: false }, "index")).toBe(false);
		expect(planeOutageIn("# not json", "index")).toBe(false);
		expect(planeOutageIn(null, "cache")).toBe(false);
	});
});

describe("degraded reads", () => {
	test("degradedIn reads the fail-open flag and nothing else", () => {
		expect(degradedIn({ chunks: [], degraded: true, reason: "lightrag circuit open" })).toBe(true);
		expect(degradedIn({ results: [], degraded: false })).toBe(false);
		expect(degradedIn({ chunks: [] })).toBe(false);
		expect(degradedIn("text")).toBe(false);
	});

	test("only Hindsight and LightRAG have a read of their own to degrade", () => {
		expect(degradedReadFor("hindsight")).toEqual({ path: "/memory/recall", body: { query: "chaos smoke" } });
		expect(degradedReadFor("lightrag")).toEqual({ path: "/docs/search", body: { question: "chaos smoke" } });
		expect(degradedReadFor("index")).toBeNull();
		expect(degradedReadFor("cache")).toBeNull();
		expect(degradedReadFor("greptime")).toBeNull();
	});
});
