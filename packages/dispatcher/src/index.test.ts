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
import {
	DISPATCHER_INTERVAL_MS,
	emptyDryRunWrites,
	runDispatcher,
	runDispatcherOnce,
	type DispatcherSeams,
} from "./index.ts";
import type { PollIssue } from "./linear-poll.ts";
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

function heldLock(released: { count: number }) {
	return {
		held: true,
		release: () => {
			released.count += 1;
		},
	};
}

describe("runDispatcher", () => {
	test("--once --dry-run prints classifications and records zero writes", async () => {
		const writes = emptyDryRunWrites();
		const lines: string[] = [];
		let locks = 0;
		let ticks = 0;
		const canary = "CANARY-TITLE-do-not-print";
		const queue: PollIssue[] = [
			{ id: "i1", identifier: "SPE-1", labels: [] },
			{ id: canary, identifier: "SPE-2", labels: [{ id: "lab-hermes", name: "dispatch:hermes" }] },
			{
				id: "i3",
				identifier: "SPE-3",
				labels: [
					{ id: "lab-a", name: "dispatch:hermes" },
					{ id: "lab-b", name: "dispatch:claude-code" },
				],
			},
			{ id: "i4", identifier: "SPE-4", labels: [{ id: "lab-cc", name: "dispatch:claude-code" }] },
			{ id: "i5", identifier: "SPE-5", labels: [{ id: "lab-nope", name: "dispatch:not-a-surface" }] },
		];

		const code = await runDispatcher(["--once", "--dry-run"], {
			dryRunIssues: queue,
			dryRunWrites: writes,
			stdout: (line) => lines.push(line),
			acquireLock: () => {
				locks += 1;
				return { held: true, release: () => {} };
			},
			runTick: async () => {
				ticks += 1;
				return [];
			},
			buildDeps: () => {
				throw new Error("dry-run built production deps");
			},
		});

		expect(code).toBe(0);
		expect(lines).toEqual([
			"SPE-1 not-dispatchable",
			"SPE-3 not-dispatchable",
			"SPE-5 not-dispatchable",
			"SPE-2 dispatch:hermes",
			"SPE-4 dispatch:claude-code",
		]);
		expect(lines.join("\n")).not.toContain(canary);
		expect(writes).toEqual(emptyDryRunWrites());
		expect(locks).toBe(0);
		expect(ticks).toBe(0);
	});

	test("a disabled resident pass sleeps without ticking and re-reads the switch", async () => {
		const envFile = "/tmp/dispatcher-entry-disabled.env";
		const seen: string[] = [];
		let ticks = 0;
		let builds = 0;
		const sleeps: number[] = [];
		const released = { count: 0 };
		let locks = 0;

		const code = await runDispatcher([], {
			envFile,
			maxPasses: 2,
			isDisabled: (file) => {
				seen.push(file);
				return seen.length === 1;
			},
			acquireLock: (lockFile) => {
				locks += 1;
				expect(lockFile).toBe(DEFAULT_DISPATCHER_LOCK_FILE);
				return heldLock(released);
			},
			buildDeps: () => {
				builds += 1;
				return fakeDeps();
			},
			runTick: async () => {
				ticks += 1;
				return [];
			},
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});

		expect(code).toBe(0);
		expect(seen).toEqual([envFile, envFile]);
		expect(ticks).toBe(1);
		expect(builds).toBe(1);
		expect(sleeps).toEqual([DISPATCHER_INTERVAL_MS, DISPATCHER_INTERVAL_MS]);
		expect(locks).toBe(1);
		expect(released.count).toBe(1);
		expect(DISPATCHER_INTERVAL_MS).toBe(30_000);
	});

	test("a busy resident lock exits 0 without sleeping or ticking", async () => {
		let slept = 0;
		let ticks = 0;
		const released = { count: 0 };
		const code = await runDispatcher([], {
			envFile: "/tmp/dispatcher-entry-busy.env",
			isDisabled: () => false,
			maxPasses: 3,
			acquireLock: () => ({
				held: false,
				release: () => {
					released.count += 1;
				},
			}),
			runTick: async () => {
				ticks += 1;
				return [];
			},
			sleep: async () => {
				slept += 1;
			},
		});

		expect(code).toBe(0);
		expect(slept).toBe(0);
		expect(ticks).toBe(0);
		expect(released.count).toBe(1);
	});

	test("--once exits 0 on a tick and 1 when the tick throws", async () => {
		const ok = await runDispatcher(["--once"], {
			envFile: "/tmp/dispatcher-entry-once.env",
			isDisabled: () => false,
			acquireLock: () => ({ held: true, release: () => {} }),
			buildDeps: () => fakeDeps(),
			runTick: async () => [],
		});
		const errors: string[] = [];
		const failed = await runDispatcher(["--once"], {
			envFile: "/tmp/dispatcher-entry-once.env",
			isDisabled: () => false,
			acquireLock: () => ({ held: true, release: () => {} }),
			buildDeps: () => fakeDeps(),
			runTick: async () => {
				throw new Error("tick failed");
			},
			stderr: (line) => errors.push(line),
		});

		expect(ok).toBe(0);
		expect(failed).toBe(1);
		expect(errors).toEqual(["tick failed"]);
	});

	test("unknown flags and a bare --dry-run exit 1 with usage", async () => {
		const errors: string[] = [];
		const stderr = (line: string) => errors.push(line);
		const unknown = await runDispatcher(["--live"], { stderr });
		const bare = await runDispatcher(["--dry-run"], { stderr });
		const doubled = await runDispatcher(["--once", "--once"], { stderr });

		expect(unknown).toBe(1);
		expect(bare).toBe(1);
		expect(doubled).toBe(1);
		expect(errors).toEqual([
			"usage: substrate-dispatcher [--once [--dry-run]]",
			"usage: substrate-dispatcher [--once [--dry-run]]",
			"usage: substrate-dispatcher [--once [--dry-run]]",
		]);
	});
});
