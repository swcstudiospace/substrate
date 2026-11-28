/** DG-1a gate probe tests (phase 80): fakes only, no live server, no real sleep. */
import { describe, expect, test } from "bun:test";
import { probeDragonflyReadiness, resetDragonflyReadinessBaseline, type DragonflyReadinessDeps } from "./dragonfly-readiness.ts";

const CONFIG = { dragonflyUrl: "redis://loopback:6379", cacheEnabled: true, dragonflyRefused: null };
const NOW = 1_700_000_000_000;
const now = () => NOW;

function deps(overrides: Partial<DragonflyReadinessDeps> = {}): DragonflyReadinessDeps {
	return { ping: async () => "PONG", now, commandTimeoutMs: 50, ...overrides };
}

describe("probeDragonflyReadiness", () => {
	test("unconfigured, refused and off short-circuit without calling ping", async () => {
		for (const config of [
			{ dragonflyUrl: undefined, cacheEnabled: true, dragonflyRefused: null },
			CONFIG,
			{ dragonflyUrl: "redis://loopback:6379", cacheEnabled: false, dragonflyRefused: null },
		]) {
			let calls = 0;
			const verdict = await probeDragonflyReadiness(
				deps({ ping: async () => { calls += 1; return "PONG"; } }),
				config.dragonflyRefused === null && config.cacheEnabled && config.dragonflyUrl !== undefined
					? { ...config, dragonflyRefused: "policy" }
					: { dragonflyUrl: config.dragonflyUrl, cacheEnabled: config.cacheEnabled, dragonflyRefused: config.dragonflyRefused },
			);
			expect(verdict.state).toBe("unconfigured");
			expect(calls).toBe(0);
		}
	});

	test("PONG answers ok with no reasons", async () => {
		const verdict = await probeDragonflyReadiness(deps(), CONFIG);
		expect(verdict.state).toBe("ok");
		expect(verdict.reasons).toEqual([]);
		expect(verdict.checkedAt).toBe(new Date(NOW).toISOString());
	});

	test("a non-PONG, a throw and an over-budget hang are unavailable", async () => {
		expect((await probeDragonflyReadiness(deps({ ping: async () => "NOPE" }), CONFIG)).state).toBe("unavailable");
		expect((await probeDragonflyReadiness(deps({ ping: async () => { throw new Error("boom"); } }), CONFIG)).state).toBe("unavailable");
		const hung = new Promise<string>(() => undefined);
		expect((await probeDragonflyReadiness(deps({ ping: () => hung }), CONFIG)).state).toBe("unavailable");
	});

	test("absent INFO fields stay unknown and never flip ok", async () => {
		const verdict = await probeDragonflyReadiness(deps({ info: async () => "" }), CONFIG);
		expect(verdict.state).toBe("ok");
		expect(verdict.metrics.headroom_ratio).toBeNull();
		expect(verdict.metrics.used_memory_bytes).toBeNull();
	});

	test("maxmemory_bytes of 0 is unknown, not a breach", async () => {
		const info = async (section: "memory" | "stats") =>
			section === "memory" ? "used_memory_bytes:100\r\nmaxmemory_bytes:0" : "evicted_keys:0";
		const verdict = await probeDragonflyReadiness(deps({ info }), CONFIG);
		expect(verdict.state).toBe("ok");
		expect(verdict.metrics.headroom_ratio).toBeNull();
	});

	test("headroom below 0.80 passes and at or above degrades", async () => {
		const mk = (used: number) => async (section: "memory" | "stats") =>
			section === "memory" ? `used_memory_bytes:${used}\r\nmaxmemory_bytes:100` : "evicted_keys:0";
		expect((await probeDragonflyReadiness(deps({ info: mk(70) }), CONFIG)).state).toBe("ok");
		const breach = await probeDragonflyReadiness(deps({ info: mk(80) }), CONFIG);
		expect(breach.state).toBe("degraded");
		expect(breach.metrics.headroom_ratio).toBeCloseTo(0.8);
	});

	test("eviction flat stays ok and growth degrades", async () => {
		resetDragonflyReadinessBaseline();
		let evicted = 10;
		const info = async () => `evicted_keys:${evicted}`;
		expect((await probeDragonflyReadiness(deps({ info }), CONFIG)).state).toBe("ok");
		expect((await probeDragonflyReadiness(deps({ info }), CONFIG)).state).toBe("ok");
		evicted = 11;
		const grown = await probeDragonflyReadiness(deps({ info }), CONFIG);
		expect(grown.state).toBe("degraded");
		expect(grown.metrics.evicted_keys).toBe(11);
		resetDragonflyReadinessBaseline();
	});

	test("write round-trip passes, and a mismatch or throw is unavailable", async () => {
		const store = new Map<string, string>();
		const storeDeps = deps({
			probeSet: async (key, value, ttl) => {
				expect(ttl).toBe(60);
				expect(key).toStartWith("substrate:v1:readiness:");
				store.set(key, value);
			},
			get: async (key) => store.get(key) ?? null,
		});
		expect((await probeDragonflyReadiness(storeDeps, CONFIG)).state).toBe("ok");
		const mismatch = await probeDragonflyReadiness(deps({
			probeSet: async () => undefined,
			get: async () => "other",
		}), CONFIG);
		expect(mismatch.state).toBe("unavailable");
		const throwing = await probeDragonflyReadiness(deps({
			probeSet: async () => { throw new Error("boom"); },
			get: async () => null,
		}), CONFIG);
		expect(throwing.state).toBe("unavailable");
	});

	test("unavailable beats degraded", async () => {
		const info = async () => "used_memory_bytes:95\r\nmaxmemory_bytes:100";
		const verdict = await probeDragonflyReadiness(deps({
			ping: async () => "NOPE",
			info,
		}), CONFIG);
		expect(verdict.state).toBe("unavailable");
	});

	test("dbsize and scan fill metrics only and never flip state", async () => {
		const verdict = await probeDragonflyReadiness(deps({
			dbsize: async () => 42,
			scan: async () => ["0", ["substrate:v1:readiness:1"]],
		}), CONFIG);
		expect(verdict.state).toBe("ok");
		expect(verdict.metrics.dbsize).toBe(42);
		expect(verdict.metrics.scan_keys).toBe(1);
		const failing = await probeDragonflyReadiness(deps({
			dbsize: async () => { throw new Error("boom"); },
			scan: async () => { throw new Error("boom"); },
		}), CONFIG);
		expect(failing.state).toBe("ok");
		expect(failing.metrics.dbsize).toBeNull();
	});
});
