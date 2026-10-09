/**
 * Tests for the dispatcher entry (DISP-01, DISP-08).
 *
 * Every host seam is a fake: the kill switch, the lock, the dep build,
 * and the tick. Nothing here reads the real env file, takes the real
 * lock, or spawns Hermes.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_DISPATCHER_ENV_FILE } from "./kill-switch.ts";
import { DEFAULT_DISPATCHER_LOCK_FILE } from "./lock.ts";
import { runDispatcherOnce, type DispatcherSeams } from "./index.ts";
import type { TickDeps } from "./tick.ts";

function fakeDeps(): TickDeps {
	return {
		linear: {
			listUnstartedIssues: async () => ({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }),
			graphql: async <T>(): Promise<T> => {
				throw new Error("no graphql in entry tests");
			},
			createComment: async () => {},
			updateIssue: async () => {},
		},
		substrate: {
			findNode: async () => ({ found: false as const, reason: "unused" }),
			getGraph: async () => null,
			emitEvent: async () => {},
		},
		givenUpDir: "/nonexistent-entry-test",
		worktree: async () => {
			throw new Error("no worktree in entry tests");
		},
		readHermesConfig: () => {
			throw new Error("no hermes config in entry tests");
		},
		dialClaudeCode: async () => "host-unreachable",
		spawn: () => {
			throw new Error("no spawn in entry tests");
		},
		childEnvSource: {},
		substrateUrl: "http://127.0.0.1:7410",
		hermesToken: "",
		isAlive: () => false,
		signalProcess: () => {},
		sleep: async () => {},
	};
}
describe("runDispatcherOnce", () => {
	test("a disabled switch returns before the lock, the build, or the tick", async () => {
		let lockCalls = 0;
		let builds = 0;
		let ticks = 0;
		const seams: DispatcherSeams = {
			envFile: "/nonexistent-entry-test/dispatcher.env",
			isDisabled: () => true,
			acquireLock: () => {
				lockCalls += 1;
				return { held: true, release: () => {} };
			},
			buildDeps: () => {
				builds += 1;
				return fakeDeps();
			},
			runTick: async () => {
				ticks += 1;
				return [];
			},
		};

		const status = await runDispatcherOnce(seams);

		expect(status).toBe("disabled");
		expect(lockCalls).toBe(0);
		expect(builds).toBe(0);
		expect(ticks).toBe(0);
	});

	test("a busy lock returns without building deps or ticking, and releases", async () => {
		let released = 0;
		let builds = 0;
		let ticks = 0;
		const status = await runDispatcherOnce({
			envFile: "/nonexistent-entry-test/dispatcher.env",
			isDisabled: () => false,
			acquireLock: () => ({
				held: false,
				release: () => {
					released += 1;
				},
			}),
			buildDeps: () => {
				builds += 1;
				return fakeDeps();
			},
			runTick: async () => {
				ticks += 1;
				return [];
			},
		});

		expect(status).toBe("lock-busy");
		expect(builds).toBe(0);
		expect(ticks).toBe(0);
		expect(released).toBe(1);
	});

	test("an enabled, held pass ticks once with the built deps and releases", async () => {
		const deps = fakeDeps();
		let released = 0;
		const seen: { tickDeps: TickDeps | null } = { tickDeps: null };
		const status = await runDispatcherOnce({
			envFile: "/nonexistent-entry-test/dispatcher.env",
			isDisabled: () => false,
			acquireLock: (lockFile) => {
				expect(lockFile).toBe(DEFAULT_DISPATCHER_LOCK_FILE);
				return {
					held: true,
					release: () => {
						released += 1;
					},
				};
			},
			buildDeps: () => deps,
			runTick: async (tickDeps) => {
				seen.tickDeps = tickDeps;
				return [];
			},
		});

		expect(status).toBe("ticked");
		expect(seen.tickDeps).toBe(deps);
		expect(released).toBe(1);
	});

	test("the production defaults point at the unit contract paths", () => {
		expect(DEFAULT_DISPATCHER_ENV_FILE).toBe("/etc/substrate/dispatcher.env");
		expect(DEFAULT_DISPATCHER_LOCK_FILE).toBe("/var/lib/substrate/dispatcher.lock");
	});
});
