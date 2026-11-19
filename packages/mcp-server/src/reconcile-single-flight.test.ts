import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { ReadThroughCache, type CacheRedis } from "./cache.ts";
import { Substrate } from "./service.ts";
import { defined } from "./test-support.ts";

const INTERVAL_MS = 60_000;
const REPORT_PREFIX = "[substrate] reconcile {";

describe("the scheduled reconcile single-flight guard (phase 78)", () => {
	let live: Substrate | null = null;
	afterEach(() => {
		live?.stopReconcile();
		live = null;
	});

	test("two overlapping ticks run one pass; a tick after it settles runs another", async () => {
		// The first ledger read of a pass is the gate: `reached` signals the pass is in flight, and it stays there until `release`.
		let ledgerReads = 0;
		const reached = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const ledger = {
			queryEvents: async () => {
				ledgerReads += 1;
				reached.resolve();
				await released.promise;
				return [];
			},
		};
		const index = {
			reconcileHolds: async () => [],
			reconcileHeldNodes: async () => ({ rows: [], truncated: false }),
			reconcileMemoryIds: async () => ({ rows: [], truncated: false }),
			reconcileGraphIds: async () => ({ rows: [], truncated: false }),
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
		const substrate = new Substrate(loadConfig({ SUBSTRATE_RECONCILE_INTERVAL_S: "60" }), {
			index: index as never,
			greptime: ledger as never,
			cache: new ReadThroughCache({ redis, enabled: true, log: () => {} }),
		});
		live = substrate;

		// Capture the callback startReconcile hands to setInterval, so the test fires the real timer's tick by hand.
		const realSetInterval = globalThis.setInterval;
		let tick: (() => void) | undefined;
		const intervals = spyOn(globalThis, "setInterval").mockImplementation(((handler: () => void, ms: number) => {
			if (ms === INTERVAL_MS) tick = handler;
			return realSetInterval(handler, ms);
		}) as unknown as typeof setInterval);
		const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			expect(substrate.startReconcile()).toBe(true);
			const fire = defined(tick);
			const seam = substrate as unknown as { reconcilePass: Promise<void> | null; reconcileTick(): Promise<void> };

			// The first tick starts the pass; it blocks at the gate.
			fire();
			await reached.promise;
			const readsWhileInFlight = ledgerReads;
			const inFlight = defined(seam.reconcilePass);

			// Two overlapping ticks, one from the timer callback and one direct: both reuse the pass in flight and start nothing.
			fire();
			expect(seam.reconcileTick()).toBe(inFlight);
			expect(seam.reconcilePass).toBe(inFlight);
			expect(ledgerReads).toBe(readsWhileInFlight);

			// Release the pass: it finishes once, logs one report line, and clears the guard.
			released.resolve();
			await inFlight;
			expect(seam.reconcilePass).toBeNull();
			expect(stdout.mock.calls.filter((call) => String(call[0]).startsWith(REPORT_PREFIX))).toHaveLength(1);
			expect(stderr.mock.calls).toHaveLength(0);

			// The guard is released: the next tick starts a fresh pass.
			fire();
			await defined(seam.reconcilePass);
			expect(ledgerReads).toBeGreaterThan(readsWhileInFlight);
			expect(stdout.mock.calls.filter((call) => String(call[0]).startsWith(REPORT_PREFIX))).toHaveLength(2);
		} finally {
			intervals.mockRestore();
			stdout.mockRestore();
			stderr.mockRestore();
		}
	});
});
