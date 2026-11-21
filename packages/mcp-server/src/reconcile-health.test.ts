/**
 * The scheduled reconcile's last run in `/healthz` (phase 78).
 *
 * The run writes one journal line and keeps its verdict in memory: an operator
 * reads `health().reconcile` instead of grepping the journal, and the verdict is
 * also the durable `reconcile.clean` history series. Until the first run
 * finishes the field is present but empty (`null`s), and a failed run leaves the
 * previous verdict standing.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { SubstrateInstruments } from "@substrate/observability";
import { loadConfig } from "./config.ts";
import { ReadThroughCache, type CacheRedis } from "./cache.ts";
import { SampleCollector } from "./metrics-history.ts";
import { Substrate } from "./service.ts";
import { defined } from "./test-support.ts";

type Seam = { reconcileTick(): Promise<void> };

function makeSubstrate(graphIds: () => string[]): { substrate: Substrate; setFailing(failing: boolean): void } {
	let failing = false;
	const ledger = {
		queryEvents: async () => {
			if (failing) throw new Error("ledger down");
			return [];
		},
	};
	const index = {
		reconcileHolds: async () => [],
		reconcileHeldNodes: async () => ({ rows: [], truncated: false }),
		reconcileMemoryIds: async () => ({ rows: [], truncated: false }),
		reconcileGraphIds: async () => ({ rows: graphIds(), truncated: false }),
		reconcileMemoryRowsBefore: async () => 0,
		liveSessions: () => null,
	};
	const redis: CacheRedis = {
		get: async () => null,
		set: async () => {},
		incr: async () => 0,
		eval: async () => null,
		scan: async () => ["0", []],
		unlink: async () => 0,
	};
	const substrate = new Substrate(loadConfig({ SUBSTRATE_RECONCILE_INTERVAL_S: "60", SUBSTRATE_RECONCILE_WINDOW_HOURS: "12" }), {
		index: index as never,
		greptime: ledger as never,
		cache: new ReadThroughCache({ redis, enabled: true, log: () => {} }),
	});
	return {
		substrate,
		setFailing: (value: boolean) => {
			failing = value;
		},
	};
}

/** Run one tick with the journal silenced, the way the single-flight test does. */
async function tick(substrate: Substrate): Promise<void> {
	const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
	const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		await (substrate as unknown as Seam).reconcileTick();
	} finally {
		stdout.mockRestore();
		stderr.mockRestore();
	}
}

describe("health().reconcile (phase 78)", () => {
	let live: Substrate | null = null;
	afterEach(() => {
		live?.stopReconcile();
		live = null;
	});

	test("present but empty before the first run, carrying the schedule it runs on", async () => {
		const { substrate } = makeSubstrate(() => []);
		live = substrate;
		const health = await substrate.health();
		expect(health.reconcile).toEqual({
			lastRunAt: null,
			clean: null,
			counts: {},
			truncated: {},
			unchecked_layers: [],
			graphsNamed: null,
			intervalS: 60,
			windowHours: 12,
		});
	});

	test("filled with the last run's verdict after a tick", async () => {
		const { substrate } = makeSubstrate(() => ["g1", "g2"]);
		live = substrate;
		await tick(substrate);
		const reconcile = (await substrate.health()).reconcile;
		expect(reconcile.clean).toBe(true);
		expect(reconcile.graphsNamed).toBe(2);
		expect(reconcile.counts["index.graphs"]).toBe(2);
		expect(reconcile.unchecked_layers).toEqual([]);
		expect(reconcile.intervalS).toBe(60);
		expect(reconcile.windowHours).toBe(12);
		expect(Number.isFinite(Date.parse(defined(reconcile.lastRunAt)))).toBe(true);
		expect(reconcile.truncated["ledger.leases"]).toBe(false);
	});

	test("a failed run leaves the previous verdict standing", async () => {
		const { substrate, setFailing } = makeSubstrate(() => ["g1"]);
		live = substrate;
		await tick(substrate);
		const before = (await substrate.health()).reconcile;
		expect(before.clean).toBe(true);
		setFailing(true);
		await tick(substrate);
		const after = (await substrate.health()).reconcile;
		expect(after.lastRunAt).toBe(before.lastRunAt);
		expect(after.clean).toBe(before.clean);
		expect(after.counts).toEqual(before.counts);
	});
});

describe("the reconcile.clean history series (phase 78)", () => {
	test("a clean verdict samples as 1, a drifted one as 0, and no run yet samples nothing", () => {
		const clean = new SubstrateInstruments();
		clean.observeReconcileClean(() => 1);
		const cleanRows = new SampleCollector("extended").collect(clean.snapshot(), null, 0);
		expect(cleanRows).toContainEqual({ tsMs: 0, series: "reconcile.clean", labels: {}, value: 1, count: 1 });

		const drifted = new SubstrateInstruments();
		drifted.observeReconcileClean(() => 0);
		const driftedRows = new SampleCollector("extended").collect(drifted.snapshot(), null, 0);
		expect(driftedRows).toContainEqual({ tsMs: 0, series: "reconcile.clean", labels: {}, value: 0, count: 1 });

		const unrunned = new SubstrateInstruments();
		unrunned.observeReconcileClean(() => null);
		const unrunnedRows = new SampleCollector("extended").collect(unrunned.snapshot(), null, 0);
		expect(unrunnedRows.some((row) => row.series === "reconcile.clean")).toBe(false);
	});
});
