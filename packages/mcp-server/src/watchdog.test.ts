/**
 * The systemd watchdog's decision logic (injected clock, notifier, probe and
 * scheduler), the notifier's child handling, the loopback probe, and `GET /livez`
 * over a real socket with every store down. Nothing here reads the host: no
 * NOTIFY_SOCKET, no systemd-notify binary, no /etc/substrate.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { loadConfig } from "./config.ts";
import { createObservability } from "./observe.ts";
import { createHttpServer } from "./server.ts";
import { Substrate } from "./service.ts";
import {
	createLoopbackProbe,
	createSystemdNotifier,
	isLocalPeer,
	livezBody,
	livezUrlFor,
	LoopLagMonitor,
	type Notifier,
	type NotifyChild,
	type NotifyMessage,
	type Probe,
	type ProbeResult,
	type Scheduler,
	Watchdog,
	watchdogSettings,
	type WatchdogSettings,
} from "./watchdog.ts";

/** A fixture bearer assembled at runtime so no tracked file carries a token-shaped assignment. */
const SURFACE_BEARER = ["livez", "fixture", "bearer", "0123456789"].join("-");

interface FakeTimer {
	ms: number;
	fn: () => void;
	cancelled: boolean;
}

/** Let every already-resolved promise chain run; no wall-clock wait. */
async function flush(): Promise<void> {
	for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

/** A scheduler the test drives by hand. */
function fakeScheduler(): { scheduler: Scheduler; timers: FakeTimer[] } {
	const timers: FakeTimer[] = [];
	const scheduler: Scheduler = {
		every(ms, fn) {
			const timer = { ms, fn, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
	};
	return { scheduler, timers };
}

const ON: WatchdogSettings = { enabled: true, pingIntervalMs: 10_000, lagThresholdMs: 5000, probeTimeoutMs: 2000, notifyTimeoutMs: 3000 };

interface Rig {
	watchdog: Watchdog;
	sent: NotifyMessage[];
	probes: { count: number };
	lag: { value: number; started: number; stopped: number };
	logs: string[];
	timers: FakeTimer[];
}

function rig(
	settings: WatchdogSettings = ON,
	overrides: { notify?: Notifier; probe?: Probe; lag?: number } = {},
): Rig {
	const { scheduler, timers } = fakeScheduler();
	const sent: NotifyMessage[] = [];
	const probes = { count: 0 };
	const lag = { value: overrides.lag ?? 0, started: 0, stopped: 0 };
	const logs: string[] = [];
	const watchdog = new Watchdog(settings, {
		notify:
			overrides.notify ??
			(async (message) => {
				sent.push(message);
				return true;
			}),
		probe:
			overrides.probe ??
			(async () => {
				probes.count += 1;
				return { ok: true, loopLagMs: 3 };
			}),
		lag: {
			start: () => {
				lag.started += 1;
			},
			stop: () => {
				lag.stopped += 1;
			},
			lagMs: () => lag.value,
		},
		scheduler,
		log: (line) => logs.push(line),
	});
	return { watchdog, sent, probes, lag, logs, timers };
}

describe("watchdogSettings", () => {
	test("only the literal 1 plus a NOTIFY_SOCKET enables it", () => {
		const env = { SUBSTRATE_WATCHDOG: "1", NOTIFY_SOCKET: "/run/systemd/notify", WATCHDOG_USEC: "30000000" };
		expect(watchdogSettings(env).enabled).toBe(true);
		expect(watchdogSettings({ ...env, SUBSTRATE_WATCHDOG: "0" }).enabled).toBe(false);
		expect(watchdogSettings({ ...env, SUBSTRATE_WATCHDOG: "true" }).enabled).toBe(false);
		expect(watchdogSettings({ ...env, SUBSTRATE_WATCHDOG: undefined }).enabled).toBe(false);
		expect(watchdogSettings({ ...env, NOTIFY_SOCKET: undefined }).enabled).toBe(false);
		expect(watchdogSettings({ ...env, NOTIFY_SOCKET: "  " }).enabled).toBe(false);
	});

	test("the ping interval is WATCHDOG_USEC/3, and absent or foreign-pid watchdogs mean READY only", () => {
		const env = { SUBSTRATE_WATCHDOG: "1", NOTIFY_SOCKET: "@x", WATCHDOG_USEC: "30000000" };
		expect(watchdogSettings(env).pingIntervalMs).toBe(10_000);
		expect(watchdogSettings({ ...env, WATCHDOG_USEC: "600000000" }).pingIntervalMs).toBe(200_000);
		expect(watchdogSettings({ ...env, WATCHDOG_USEC: "1000" }).pingIntervalMs).toBe(1000);
		expect(watchdogSettings({ ...env, WATCHDOG_USEC: undefined }).pingIntervalMs).toBeNull();
		expect(watchdogSettings({ ...env, WATCHDOG_USEC: "abc" }).pingIntervalMs).toBeNull();
		expect(watchdogSettings({ ...env, WATCHDOG_PID: "1" }, 4242).pingIntervalMs).toBeNull();
		expect(watchdogSettings({ ...env, WATCHDOG_PID: "4242" }, 4242).pingIntervalMs).toBe(10_000);
	});

	test("tunables take whole milliseconds in range and fall back to the defaults otherwise", () => {
		const base = { SUBSTRATE_WATCHDOG: "1", NOTIFY_SOCKET: "@x" };
		expect(watchdogSettings(base)).toMatchObject({ lagThresholdMs: 5000, probeTimeoutMs: 2000, notifyTimeoutMs: 3000 });
		expect(watchdogSettings({ ...base, SUBSTRATE_WATCHDOG_LAG_MS: "800", SUBSTRATE_WATCHDOG_PROBE_MS: "500", SUBSTRATE_WATCHDOG_NOTIFY_MS: "1500" })).toMatchObject({
			lagThresholdMs: 800,
			probeTimeoutMs: 500,
			notifyTimeoutMs: 1500,
		});
		expect(watchdogSettings({ ...base, SUBSTRATE_WATCHDOG_LAG_MS: "5", SUBSTRATE_WATCHDOG_PROBE_MS: "1e3", SUBSTRATE_WATCHDOG_NOTIFY_MS: "999999" })).toMatchObject({
			lagThresholdMs: 5000,
			probeTimeoutMs: 2000,
			notifyTimeoutMs: 3000,
		});
	});
});

describe("Watchdog: flag off or no NOTIFY_SOCKET is a pure no-op", () => {
	test("start() returns false and creates no timer, notification, probe or lag sampler", async () => {
		const off = rig({ ...ON, enabled: false });
		expect(off.watchdog.start()).toBe(false);
		expect(off.timers).toHaveLength(0);
		expect(off.lag.started).toBe(0);
		await off.watchdog.stop();
		expect(off.sent).toEqual([]);
		expect(off.probes.count).toBe(0);
		expect(off.logs).toEqual([]);
		// The settings a missing NOTIFY_SOCKET produces are exactly this disabled shape.
		const noSocket = rig(watchdogSettings({ SUBSTRATE_WATCHDOG: "1", WATCHDOG_USEC: "30000000" }));
		expect(noSocket.watchdog.start()).toBe(false);
		expect(noSocket.timers).toHaveLength(0);
		expect(noSocket.sent).toEqual([]);
	});
});

describe("Watchdog tick", () => {
	test("READY=1 is sent once, first, then WATCHDOG=1 on every healthy tick", async () => {
		const r = rig();
		expect(await r.watchdog.tick()).toEqual({ reason: "pinged", pinged: true, ready: true });
		expect(await r.watchdog.tick()).toMatchObject({ reason: "pinged", pinged: true });
		expect(await r.watchdog.tick()).toMatchObject({ reason: "pinged", pinged: true });
		expect(r.sent).toEqual(["READY=1", "WATCHDOG=1", "WATCHDOG=1", "WATCHDOG=1"]);
		expect(r.sent.filter((m) => m === "READY=1")).toHaveLength(1);
	});

	test("no WATCHDOG=1 while the measured event-loop lag is over the threshold; it resumes when it drops", async () => {
		const r = rig(ON, { lag: 5001 });
		expect(await r.watchdog.tick()).toMatchObject({ reason: "lag", pinged: false, ready: true });
		expect(r.sent).toEqual(["READY=1"]);
		expect(r.probes.count).toBe(0);
		r.lag.value = 5000;
		expect(await r.watchdog.tick()).toMatchObject({ reason: "pinged" });
		expect(r.sent).toEqual(["READY=1", "WATCHDOG=1"]);
		// One line when it went bad, one when it recovered, none per tick.
		await Promise.resolve();
		expect(r.logs).toEqual(["[substrate] watchdog: event-loop lag over the threshold; WATCHDOG=1 withheld\n", "[substrate] watchdog: heartbeat resumed\n"]);
	});

	test("a NaN or throwing lag source fails closed", async () => {
		const nan = rig(ON, { lag: Number.NaN });
		expect(await nan.watchdog.tick()).toMatchObject({ reason: "lag" });
		const { scheduler } = fakeScheduler();
		const throwing = new Watchdog(ON, {
			notify: async () => true,
			probe: async () => ({ ok: true, loopLagMs: 1 }),
			lag: {
				start() {},
				stop() {},
				lagMs() {
					throw new Error("boom");
				},
			},
			scheduler,
		});
		expect(await throwing.tick()).toMatchObject({ reason: "lag" });
	});

	test("no WATCHDOG=1 when the loopback /livez fails, times out, throws, or reports a lag over the threshold", async () => {
		const sequence: Array<ProbeResult | Error> = [
			{ ok: false, loopLagMs: null },
			new Error("connection refused"),
			{ ok: true, loopLagMs: 9000 },
			{ ok: true, loopLagMs: 4 },
		];
		let i = 0;
		const r = rig(ON, {
			probe: async () => {
				const next = sequence[i++];
				if (next instanceof Error) throw next;
				return next ?? { ok: false, loopLagMs: null };
			},
		});
		expect(await r.watchdog.tick()).toMatchObject({ reason: "livez", pinged: false });
		expect(await r.watchdog.tick()).toMatchObject({ reason: "livez", pinged: false });
		expect(await r.watchdog.tick()).toMatchObject({ reason: "lag", pinged: false });
		expect(r.sent).toEqual(["READY=1"]);
		expect(await r.watchdog.tick()).toMatchObject({ reason: "pinged" });
		expect(r.sent).toEqual(["READY=1", "WATCHDOG=1"]);
	});

	test("a failed READY=1 is retried on the next tick and WATCHDOG=1 waits for it", async () => {
		const attempts: NotifyMessage[] = [];
		let failReady = true;
		const r = rig(ON, {
			notify: async (message) => {
				attempts.push(message);
				return !(failReady && message === "READY=1");
			},
		});
		expect(await r.watchdog.tick()).toEqual({ reason: "ready-failed", pinged: false, ready: false });
		failReady = false;
		expect(await r.watchdog.tick()).toMatchObject({ reason: "pinged", ready: true });
		expect(attempts).toEqual(["READY=1", "READY=1", "WATCHDOG=1"]);
	});

	test("a notifier that fails or throws is not a ping and not an exception", async () => {
		let n = 0;
		const r = rig(ON, {
			notify: async (message) => {
				if (message === "READY=1") return true;
				n += 1;
				if (n === 1) return false;
				throw new Error("spawn failed");
			},
		});
		expect(await r.watchdog.tick()).toMatchObject({ reason: "notify-failed", pinged: false });
		expect(await r.watchdog.tick()).toMatchObject({ reason: "notify-failed", pinged: false });
	});

	test("single-flight: a tick during a running tick is dropped as busy and spawns nothing", async () => {
		let release: (ok: boolean) => void = () => {};
		const sent: NotifyMessage[] = [];
		const r = rig(ON, {
			notify: (message) => {
				const gate = Promise.withResolvers<boolean>();
				sent.push(message);
				release = gate.resolve;
				return gate.promise;
			},
		});
		const first = r.watchdog.tick();
		expect(await r.watchdog.tick()).toMatchObject({ reason: "busy", pinged: false });
		expect(await r.watchdog.tick()).toMatchObject({ reason: "busy", pinged: false });
		expect(sent).toEqual(["READY=1"]);
		release(true);
		await flush();
		release(true);
		expect(await first).toMatchObject({ reason: "pinged" });
	});

	test("with no watchdog armed (no WATCHDOG_USEC) READY=1 is the whole job and its timer is cancelled", async () => {
		const r = rig({ ...ON, pingIntervalMs: null });
		expect(r.watchdog.start()).toBe(true);
		expect(r.timers).toHaveLength(1);
		expect(r.timers[0]?.ms).toBe(5000);
		await r.watchdog.stop();
		const again = rig({ ...ON, pingIntervalMs: null });
		expect(await again.watchdog.tick()).toMatchObject({ reason: "ready-only", ready: true });
		expect(await again.watchdog.tick()).toMatchObject({ reason: "ready-only" });
		expect(again.sent).toEqual(["READY=1"]);
		expect(again.probes.count).toBe(0);
	});
});

describe("Watchdog lifecycle", () => {
	test("start() arms one unref'd-style timer at WatchdogSec/3 and sends READY=1 immediately", async () => {
		const r = rig();
		expect(r.watchdog.start()).toBe(true);
		expect(r.watchdog.start()).toBe(false);
		expect(r.timers).toHaveLength(1);
		expect(r.timers[0]?.ms).toBe(10_000);
		expect(r.lag.started).toBe(1);
		await flush();
		expect(r.sent[0]).toBe("READY=1");
		// The timer firing is a tick.
		r.timers[0]?.fn();
		await flush();
		expect(r.sent).toContain("WATCHDOG=1");
		await r.watchdog.stop();
	});

	test("stop() clears the timer and the lag sampler, sends nothing after, and a second stop is harmless", async () => {
		const r = rig();
		r.watchdog.start();
		await flush();
		const before = [...r.sent];
		await r.watchdog.stop();
		expect(r.timers[0]?.cancelled).toBe(true);
		expect(r.lag.stopped).toBe(1);
		r.timers[0]?.fn();
		expect(await r.watchdog.tick()).toMatchObject({ reason: "stopped", pinged: false });
		await r.watchdog.stop();
		expect(r.sent).toEqual(before);
		expect(r.watchdog.start()).toBe(false);
	});

	test("stop() aborts an in-flight notification, waits for it, and never pings afterwards", async () => {
		const aborted: boolean[] = [];
		const r = rig(ON, {
			notify: (message, signal) => {
				const gate = Promise.withResolvers<boolean>();
				if (message === "READY=1") {
					gate.resolve(true);
					return gate.promise;
				}
				signal.addEventListener("abort", () => {
					aborted.push(true);
					gate.resolve(false);
				});
				return gate.promise;
			},
		});
		const tick = r.watchdog.tick();
		await flush();
		await r.watchdog.stop();
		expect(aborted).toEqual([true]);
		expect(await tick).toMatchObject({ pinged: false });
	});

	test("a stop that lands while the probe is awaited does not ping", async () => {
		let releaseProbe: (result: ProbeResult) => void = () => {};
		const r = rig(ON, {
			probe: () => {
				const gate = Promise.withResolvers<ProbeResult>();
				releaseProbe = gate.resolve;
				return gate.promise;
			},
		});
		const tick = r.watchdog.tick();
		await flush();
		const stopping = r.watchdog.stop();
		releaseProbe({ ok: true, loopLagMs: 1 });
		await stopping;
		expect(await tick).toMatchObject({ reason: "stopped", pinged: false });
		expect(r.sent).toEqual(["READY=1"]);
	});
});

describe("LoopLagMonitor", () => {
	function clocked(options: { windowMs?: number } = {}) {
		const clock = { now: 1000 };
		const { scheduler, timers } = fakeScheduler();
		const monitor = new LoopLagMonitor({ intervalMs: 250, now: () => clock.now, scheduler, ...options });
		return { clock, monitor, timers };
	}

	test("on-time samples are zero lag; a late sample is the worst lag until it leaves the window", () => {
		const { clock, monitor, timers } = clocked({ windowMs: 1000 });
		monitor.start();
		expect(timers).toHaveLength(1);
		expect(timers[0]?.ms).toBe(250);
		for (let i = 0; i < 4; i += 1) {
			clock.now += 250;
			monitor.sample();
		}
		expect(monitor.lagMs()).toBe(0);
		clock.now += 250 + 6000;
		monitor.sample();
		expect(monitor.lagMs()).toBe(6000);
		// Four more on-time samples overwrite the 4-slot ring.
		for (let i = 0; i < 4; i += 1) {
			clock.now += 250;
			monitor.sample();
		}
		expect(monitor.lagMs()).toBe(0);
	});

	test("a stall in progress is visible before its sample is recorded", () => {
		const { clock, monitor } = clocked();
		monitor.start();
		clock.now += 250 + 7000;
		expect(monitor.lagMs()).toBe(7000);
	});

	test("the ring is capped whatever window is asked for, and stop() cancels the timer and zeroes the pending lag", () => {
		// 10^12 ms at a 1 ms period would be a trillion slots; the ring is capped inside.
		expect(new LoopLagMonitor({ intervalMs: 1, windowMs: 10 ** 12 }).lagMs()).toBe(0);
		const { clock, monitor, timers } = clocked();
		monitor.start();
		monitor.start();
		expect(timers).toHaveLength(1);
		monitor.stop();
		expect(timers[0]?.cancelled).toBe(true);
		clock.now += 99_999;
		expect(monitor.lagMs()).toBe(0);
	});
});

describe("livez helpers", () => {
	test("livezBody reads only the lag source and the process clock", () => {
		expect(livezBody({ lagMs: () => 12.6 }, 100.9)).toEqual({ ok: true, uptime_s: 100, loop_lag_ms: 13 });
	});

	test("isLocalPeer accepts loopback and a peer at its own address, and nothing else", () => {
		expect(isLocalPeer("127.0.0.1", "127.0.0.1")).toBe(true);
		expect(isLocalPeer("::1", "::1")).toBe(true);
		expect(isLocalPeer("::ffff:127.0.0.1", "::ffff:127.0.0.1")).toBe(true);
		expect(isLocalPeer("10.0.0.5", "10.0.0.5")).toBe(true);
		expect(isLocalPeer("203.0.113.9", "10.0.0.5")).toBe(false);
		expect(isLocalPeer(undefined, "10.0.0.5")).toBe(false);
		expect(isLocalPeer("", "")).toBe(false);
		expect(isLocalPeer("203.0.113.9", undefined)).toBe(false);
	});

	test("livezUrlFor uses the bound address, loopback for a wildcard, and brackets IPv6", () => {
		expect(livezUrlFor("127.0.0.1", 7410)).toBe("http://127.0.0.1:7410/livez");
		expect(livezUrlFor("0.0.0.0", 7410)).toBe("http://127.0.0.1:7410/livez");
		expect(livezUrlFor("::", 7410)).toBe("http://127.0.0.1:7410/livez");
		expect(livezUrlFor("::1", 7410)).toBe("http://[::1]:7410/livez");
	});
});

describe("createSystemdNotifier", () => {
	const live = new AbortController().signal;

	function child(exit: Promise<number>): { child: NotifyChild; killed: { count: number } } {
		const killed = { count: 0 };
		return {
			child: {
				exited: exit,
				kill: () => {
					killed.count += 1;
				},
			},
			killed,
		};
	}

	test("runs systemd-notify with the message and reports its exit status", async () => {
		const argvs: Array<readonly string[]> = [];
		const ok = createSystemdNotifier({
			timeoutMs: 1000,
			spawn: (argv) => {
				argvs.push(argv);
				return child(Promise.resolve(0)).child;
			},
		});
		expect(await ok("WATCHDOG=1", live)).toBe(true);
		expect(argvs).toEqual([["systemd-notify", "WATCHDOG=1"]]);
		const bad = createSystemdNotifier({ timeoutMs: 1000, spawn: () => child(Promise.resolve(1)).child });
		expect(await bad("READY=1", live)).toBe(false);
	});

	// Real 20 ms timer on purpose: the code under test owns an unref'd setTimeout whose firing is the behaviour.
	test("a child that never exits is killed at the deadline and counts as a failure", async () => {
		const stuck = child(Promise.withResolvers<number>().promise);
		const notify = createSystemdNotifier({ timeoutMs: 20, spawn: () => stuck.child });
		const started = performance.now();
		expect(await notify("WATCHDOG=1", live)).toBe(false);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(stuck.killed.count).toBe(1);
	});

	test("a spawn that throws, a child that errors, and an already-aborted signal are false, not exceptions", async () => {
		const throws = createSystemdNotifier({
			timeoutMs: 1000,
			spawn: () => {
				throw new Error("ENOENT");
			},
		});
		expect(await throws("READY=1", live)).toBe(false);
		const errors = createSystemdNotifier({ timeoutMs: 1000, spawn: () => child(Promise.reject(new Error("spawn error"))).child });
		expect(await errors("READY=1", live)).toBe(false);
		let spawned = 0;
		const never = createSystemdNotifier({
			timeoutMs: 1000,
			spawn: () => {
				spawned += 1;
				return child(Promise.resolve(0)).child;
			},
		});
		const controller = new AbortController();
		controller.abort();
		expect(await never("READY=1", controller.signal)).toBe(false);
		expect(spawned).toBe(0);
	});

	test("aborting while the child runs kills it", async () => {
		const running = child(Promise.withResolvers<number>().promise);
		const notify = createSystemdNotifier({ timeoutMs: 60_000, spawn: () => running.child });
		const controller = new AbortController();
		const result = notify("WATCHDOG=1", controller.signal);
		controller.abort();
		expect(await result).toBe(false);
		expect(running.killed.count).toBe(1);
	});
});

describe("createLoopbackProbe", () => {
	const live = new AbortController().signal;
	const reply = (status: number, body: string): typeof fetch => (async () => new Response(body, { status })) as unknown as typeof fetch;

	test("ok needs HTTP 200 and a body with ok:true and a numeric loop_lag_ms", async () => {
		const good = createLoopbackProbe("http://127.0.0.1:1/livez", 1000, reply(200, '{"ok":true,"uptime_s":5,"loop_lag_ms":7}'));
		expect(await good(live)).toEqual({ ok: true, loopLagMs: 7 });
		for (const [status, body] of [
			[503, '{"ok":true,"loop_lag_ms":1}'],
			[200, "not json"],
			[200, '{"ok":false,"loop_lag_ms":1}'],
			[200, '{"ok":true}'],
			[200, "null"],
		] as const) {
			expect(await createLoopbackProbe("http://127.0.0.1:1/livez", 1000, reply(status, body))(live)).toMatchObject({ ok: false });
		}
	});

	test("a refused connection and a hung server are ok:false inside the timeout, and an oversized body is cut", async () => {
		const refused = createLoopbackProbe("http://127.0.0.1:1/livez", 1000, (async () => {
			throw new TypeError("connection refused");
		}) as unknown as typeof fetch);
		expect(await refused(live)).toEqual({ ok: false, loopLagMs: null });
		// Real 30 ms deadline on purpose: the probe's own abort timer is what is being exercised.
		const hung = createLoopbackProbe("http://127.0.0.1:1/livez", 30, ((_url: unknown, init?: RequestInit) => {
			const gate = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => gate.reject(new Error("aborted")));
			return gate.promise;
		}) as unknown as typeof fetch);
		const started = performance.now();
		expect(await hung(live)).toEqual({ ok: false, loopLagMs: null });
		expect(performance.now() - started).toBeLessThan(1000);
		const huge = createLoopbackProbe("http://127.0.0.1:1/livez", 1000, reply(200, `{"ok":true,"loop_lag_ms":1,"pad":"${"x".repeat(100_000)}"}`));
		expect(await huge(live)).toEqual({ ok: false, loopLagMs: null });
	});
});

describe("GET /livez over a real socket", () => {
	const closers: Array<() => void> = [];
	afterAll(() => {
		for (const close of closers) close();
	});

	/** A store whose every method records the call and throws; reading a property is not a touch. */
	function downStore(touches: string[]): unknown {
		return new Proxy(
			{},
			{
				get(_target, property) {
					if (typeof property === "symbol" || property === "then") return undefined;
					return () => {
						touches.push(property);
						throw new Error("store is down");
					};
				},
			},
		);
	}

	async function start(env: Record<string, string | undefined>, touches: string[]) {
		const config = loadConfig(env);
		const observability = createObservability(config, env);
		await observability.start();
		const substrate = new Substrate(
			config,
			{ index: downStore(touches), greptime: downStore(touches) } as unknown as ConstructorParameters<typeof Substrate>[1],
			observability.observer,
		);
		const server = createHttpServer(substrate, config, observability);
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		const { port } = server.address() as AddressInfo;
		closers.push(() => {
			void server.close();
			observability.stop();
		});
		return `http://127.0.0.1:${port}`;
	}

	test("answers {ok, uptime_s, loop_lag_ms} to a loopback caller with no bearer, touching no store, while the stores are down and /healthz refuses", async () => {
		const touches: string[] = [];
		const base = await start({ SUBSTRATE_TOKEN_SUBSTRATE: SURFACE_BEARER }, touches);
		const before = touches.length;
		const res = await fetch(`${base}/livez`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; uptime_s: number; loop_lag_ms: number };
		expect(body.ok).toBe(true);
		expect(Number.isInteger(body.uptime_s)).toBe(true);
		expect(body.loop_lag_ms).toBeGreaterThanOrEqual(0);
		expect(Object.keys(body).sort()).toEqual(["loop_lag_ms", "ok", "uptime_s"]);
		expect(touches.length).toBe(before);
		// The bearer-gated routes still refuse the same caller: /livez is not a hole in the gate.
		expect((await fetch(`${base}/healthz`)).status).toBe(401);
		expect((await fetch(`${base}/livez`, { method: "POST" })).status).not.toBe(200);
		// The watchdog's own probe, end to end, against this server.
		const probe = createLoopbackProbe(`${base}/livez`, 2000);
		expect(await probe(new AbortController().signal)).toMatchObject({ ok: true });
	});
});
