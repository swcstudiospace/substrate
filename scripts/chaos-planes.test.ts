import { describe, expect, test } from "bun:test";
import { INDEX_CHAOS_WINDOW_MS, chaosPlanesEnabled, runChaosPlanes, type ChaosHealthBody, type ChaosPlanesDeps } from "./chaos-planes.ts";

const loopback = "http://127.0.0.1:9";

function body(indexOk: boolean | null, opts?: { cache?: boolean; hindsight?: boolean | null; lightrag?: boolean | null }): ChaosHealthBody {
	return {
		cache: { enabled: opts?.cache ?? false },
		planes: {
			index: { ok: indexOk },
			hindsight: { ok: opts?.hindsight ?? null },
			lightrag: { ok: opts?.lightrag ?? null },
		},
	};
}

function harness(partial: Partial<ChaosPlanesDeps> & Pick<ChaosPlanesDeps, "enabled" | "healthz">): {
	deps: ChaosPlanesDeps;
	actions: Array<"pause" | "unpause">;
} {
	const actions: Array<"pause" | "unpause"> = [];
	let t = 0;
	const deps: ChaosPlanesDeps = {
		name: "gate",
		substrateUrl: loopback,
		pause: async (action) => {
			actions.push(action);
		},
		brief: async () => ({ status: 200 }),
		now: () => t,
		sleep: async (ms) => {
			t += ms;
		},
		...partial,
	};
	return { deps, actions };
}

describe("chaos planes", () => {
	test("the flag is on only for the exact string 1", () => {
		expect(chaosPlanesEnabled({ SUBSTRATE_GATE_CHAOS_PLANES: "1" })).toBe(true);
		expect(chaosPlanesEnabled({})).toBe(false);
		expect(chaosPlanesEnabled({ SUBSTRATE_GATE_CHAOS_PLANES: "0" })).toBe(false);
		expect(chaosPlanesEnabled({ SUBSTRATE_GATE_CHAOS_PLANES: "true" })).toBe(false);
	});

	test("flag off does not pause", async () => {
		let healthCalls = 0;
		const { deps, actions } = harness({
			enabled: false,
			healthz: async () => {
				healthCalls++;
				return body(false);
			},
		});
		const result = await runChaosPlanes(deps);
		expect(result.exit).toBe(0);
		expect(actions).toEqual([]);
		expect(healthCalls).toBe(0);
	});

	test("cache disabled and hindsight/lightrag ok null are three skips and exit 0", async () => {
		let n = 0;
		const { deps, actions } = harness({
			enabled: true,
			healthz: async () => {
				n++;
				return body(n === 1);
			},
		});
		const result = await runChaosPlanes(deps);
		expect(result.exit).toBe(0);
		expect(result.skips).toHaveLength(3);
		expect(result.skips[0]).toContain("redis");
		expect(result.skips[1]).toContain("hindsight");
		expect(result.skips[2]).toContain("lightrag");
		expect(actions).toEqual(["pause", "unpause"]);
	});

	test("a non-loopback URL refuses and does not pause", async () => {
		const { deps, actions } = harness({
			enabled: true,
			substrateUrl: "http://10.1.2.3:8787",
			healthz: async () => body(false),
		});
		const result = await runChaosPlanes(deps);
		expect(result.exit).toBe(1);
		expect(result.detail).toContain("non-loopback");
		expect(actions).toEqual([]);
	});

	test("index ok then a body with index ok false and brief 200 pauses once and unpauses once", async () => {
		let n = 0;
		const { deps, actions } = harness({
			enabled: true,
			healthz: async () => {
				n++;
				return body(n === 1, { cache: true, hindsight: true, lightrag: true });
			},
		});
		const result = await runChaosPlanes(deps);
		expect(result.exit).toBe(0);
		expect(result.skips).toEqual([]);
		expect(actions.filter((action) => action === "pause")).toHaveLength(1);
		expect(actions.filter((action) => action === "unpause")).toHaveLength(1);
		expect(n).toBeGreaterThan(1);
	});

	test("a pause throw still unpauses", async () => {
		const { deps, actions } = harness({
			enabled: true,
			pause: async (action) => {
				actions.push(action);
				if (action === "pause") throw new Error("docker pause failed");
			},
			healthz: async () => body(false),
		});
		const result = await runChaosPlanes(deps);
		expect(result.exit).toBe(1);
		expect(actions).toEqual(["pause", "unpause"]);
	});

	test("no index outage is exit 1 after unpause", async () => {
		const { deps, actions } = harness({
			enabled: true,
			healthz: async () => body(true, { cache: true, hindsight: true, lightrag: true }),
		});
		const result = await runChaosPlanes(deps);
		expect(result.exit).toBe(1);
		expect(result.detail).toContain("planes.index.ok");
		expect(actions).toEqual(["pause", "unpause"]);
		expect(INDEX_CHAOS_WINDOW_MS).toBeGreaterThan(5_000);
	});
});
