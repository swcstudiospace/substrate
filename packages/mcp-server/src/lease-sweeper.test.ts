/**
 * LeaseExpirySweeper tests: a lapsed lease is reaped by the timer alone, the timer is started once and
 * stopped cleanly, concurrent ticks share one pass, and a failing reap is logged, not thrown.
 */
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_LEASE_REAP_INTERVAL_MS,
	LEASE_REAP_INTERVAL_ENV,
	LeaseExpirySweeper,
	loadLeaseReapSettings,
	type LeaseReapService,
	type LeaseTimers,
} from "./lease-sweeper.ts";
import { REDACTED } from "./redact.ts";

class FakeTimers implements LeaseTimers {
	runs: Array<() => Promise<unknown>> = [];
	intervals: number[] = [];
	cleared = 0;

	setInterval(run: () => Promise<unknown>, ms: number): number {
		this.runs.push(run);
		this.intervals.push(ms);
		return this.runs.length;
	}

	clearInterval(): void {
		this.cleared += 1;
	}
}

function fakeService(impl: () => Promise<readonly unknown[]> = async () => []): { service: LeaseReapService; calls: number } {
	const state = { calls: 0 };
	const service: LeaseReapService = {
		reapExpiredLeases: async () => {
			state.calls += 1;
			return impl();
		},
	};
	return { service, calls: state.calls };
}

function sweeperOver(options: { service?: LeaseReapService; intervalMs?: number; report?: (line: string) => void } = {}) {
	const fake = fakeService();
	const timers = new FakeTimers();
	const lines: string[] = [];
	const sweeper = new LeaseExpirySweeper({
		service: options.service ?? fake.service,
		intervalMs: options.intervalMs ?? 5_000,
		timers,
		report: options.report ?? ((line) => lines.push(line)),
	});
	return { timers, sweeper, lines };
}

describe("loadLeaseReapSettings", () => {
	test("unset, blank and unparseable fall back to the 30 s default", () => {
		expect(loadLeaseReapSettings({}).intervalMs).toBe(DEFAULT_LEASE_REAP_INTERVAL_MS);
		expect(DEFAULT_LEASE_REAP_INTERVAL_MS).toBeLessThanOrEqual(30_000);
		expect(loadLeaseReapSettings({ [LEASE_REAP_INTERVAL_ENV]: "" }).intervalMs).toBe(DEFAULT_LEASE_REAP_INTERVAL_MS);
		expect(loadLeaseReapSettings({ [LEASE_REAP_INTERVAL_ENV]: "   " }).intervalMs).toBe(DEFAULT_LEASE_REAP_INTERVAL_MS);
		expect(loadLeaseReapSettings({ [LEASE_REAP_INTERVAL_ENV]: "often" }).intervalMs).toBe(DEFAULT_LEASE_REAP_INTERVAL_MS);
		expect(loadLeaseReapSettings({ [LEASE_REAP_INTERVAL_ENV]: "1.5" }).intervalMs).toBe(DEFAULT_LEASE_REAP_INTERVAL_MS);
	});

	test("0 disables; a whole interval within bounds is used as-is", () => {
		expect(loadLeaseReapSettings({ [LEASE_REAP_INTERVAL_ENV]: "0" }).intervalMs).toBe(0);
		expect(loadLeaseReapSettings({ [LEASE_REAP_INTERVAL_ENV]: "5000" }).intervalMs).toBe(5_000);
		expect(loadLeaseReapSettings({ [LEASE_REAP_INTERVAL_ENV]: " 60000 " }).intervalMs).toBe(60_000);
	});

	test("out-of-range values clamp to 1000..3600000 ms", () => {
		expect(loadLeaseReapSettings({ [LEASE_REAP_INTERVAL_ENV]: "1" }).intervalMs).toBe(1_000);
		expect(loadLeaseReapSettings({ [LEASE_REAP_INTERVAL_ENV]: "-5" }).intervalMs).toBe(1_000);
		expect(loadLeaseReapSettings({ [LEASE_REAP_INTERVAL_ENV]: "99999999" }).intervalMs).toBe(3_600_000);
	});
});

describe("LeaseExpirySweeper", () => {
	test("rejects an interval that is not a positive integer", () => {
		const { service } = fakeService();
		for (const intervalMs of [0, -1, 1.5, Number.NaN]) {
			expect(() => new LeaseExpirySweeper({ service, intervalMs })).toThrow(RangeError);
		}
	});

	test("start is idempotent: one timer at the configured interval, a second start does nothing", () => {
		const { sweeper, timers } = sweeperOver();
		expect(sweeper.start()).toBe(true);
		expect(sweeper.start()).toBe(false);
		expect(timers.intervals).toEqual([5_000]);
	});

	test("a pass reaps through the service and returns the reaped leases", async () => {
		const lease = { graph_id: "g1", node_id: "n1" };
		let calls = 0;
		const service: LeaseReapService = {
			reapExpiredLeases: async () => {
				calls += 1;
				return [lease];
			},
		};
		const { sweeper, lines } = sweeperOver({ service });
		expect(await sweeper.pass()).toEqual([lease]);
		expect(calls).toBe(1);
		expect(lines).toEqual(["[substrate] lease expiry: 1 reaped"]);
	});

	test("nothing reaped, nothing said", async () => {
		const { sweeper, lines } = sweeperOver();
		expect(await sweeper.pass()).toEqual([]);
		expect(lines).toEqual([]);
	});

	test("a tick that arrives during a pass shares it: one reap for two concurrent passes", async () => {
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const service: LeaseReapService = {
			reapExpiredLeases: async () => {
				calls += 1;
				await release.promise;
				return [{ graph_id: "g1", node_id: "n1" }];
			},
		};
		const { sweeper } = sweeperOver({ service });
		const first = sweeper.pass();
		const second = sweeper.pass();
		expect(second).toBe(first);
		release.resolve();
		expect(await first).toHaveLength(1);
		expect(calls).toBe(1);
	});

	test("stop clears the timer and no pass starts after it", async () => {
		let calls = 0;
		const service: LeaseReapService = {
			reapExpiredLeases: async () => {
				calls += 1;
				return [];
			},
		};
		const { sweeper, timers } = sweeperOver({ service });
		sweeper.start();
		const tick = timers.runs[0];
		sweeper.stop();
		expect(timers.cleared).toBe(1);
		expect(await tick?.()).toBeNull();
		expect(await sweeper.pass()).toBeNull();
		expect(calls).toBe(0);
		expect(sweeper.start()).toBe(false);
	});

	test("idle waits for a pass in flight and then resolves", async () => {
		const release = Promise.withResolvers<void>();
		const service: LeaseReapService = {
			reapExpiredLeases: async () => {
				await release.promise;
				return [];
			},
		};
		const { sweeper } = sweeperOver({ service });
		void sweeper.pass();
		let idle = false;
		const waiting = sweeper.idle().then(() => {
			idle = true;
		});
		await Promise.resolve();
		expect(idle).toBe(false);
		release.resolve();
		await waiting;
		expect(idle).toBe(true);
	});

	test("a failing reap resolves null and is logged redacted, never thrown", async () => {
		const service: LeaseReapService = {
			reapExpiredLeases: async () => {
				throw new Error("connect failed for postgresql://user pk-1234567890abcdef1234567890 with token");
			},
		};
		const { sweeper, lines } = sweeperOver({ service });
		expect(await sweeper.pass()).toBeNull();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("lease expiry pass failed");
		expect(lines[0]).toContain(REDACTED);
		expect(lines[0]).not.toContain("pk-1234567890abcdef1234567890");
	});

	test("a failure that repeats is reported once; recovery and a new failure are reported again", async () => {
		let fail = true;
		const service: LeaseReapService = {
			reapExpiredLeases: async () => {
				if (fail) throw new Error("index down");
				return [];
			},
		};
		const { sweeper, lines } = sweeperOver({ service });
		expect(await sweeper.pass()).toBeNull();
		expect(await sweeper.pass()).toBeNull();
		expect(lines).toHaveLength(1);
		fail = false;
		expect(await sweeper.pass()).toEqual([]);
		fail = true;
		expect(await sweeper.pass()).toBeNull();
		expect(lines).toHaveLength(2);
	});
});

describe("LeaseExpirySweeper via timers", () => {
	test("a due tick alone reaps with no coord_reap_leases call: one interval, one reap", async () => {
		let calls = 0;
		const service: LeaseReapService = {
			reapExpiredLeases: async () => {
				calls += 1;
				return [{ graph_id: "g1", node_id: "n1" }];
			},
		};
		const { sweeper, timers } = sweeperOver({ service, intervalMs: 30_000 });
		sweeper.start();
		await timers.runs[0]?.();
		expect(calls).toBe(1);
	});
});
