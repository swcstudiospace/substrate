/**
 * Liveness for the systemd watchdog (uplift-4 S3).
 *
 * Today a hung event loop is invisible: `Restart=always` only reacts to an exit,
 * and `/healthz` awaits every store plane, so it cannot tell "the process is
 * wedged" from "Railway is slow". This module holds the three pieces that can:
 *
 * - `LoopLagMonitor`: event-loop lag from a fixed-interval timer, kept in a
 *   fixed-size ring so the number is the worst lag inside a time window, not an
 *   unbounded history.
 * - `livezBody`: the answer of `GET /livez` (`server.ts`). It reads only the lag
 *   monitor and the process clock: no store, no plane, no cache, no audit.
 * - `Watchdog`: opt-in (`SUBSTRATE_WATCHDOG=1`, and only when systemd gave this
 *   process a `NOTIFY_SOCKET`). It sends `READY=1` once and then `WATCHDOG=1`
 *   every WatchdogSec/3, but only when the measured lag is under a threshold AND
 *   a loopback fetch of this process's own `/livez` answered in time. A loop that
 *   cannot run this code sends nothing, WatchdogSec expires, and systemd kills
 *   the unit; `Restart=always` brings it back.
 *
 * No FFI: the datagram is sent by spawning `systemd-notify`, which inherits
 * `NOTIFY_SOCKET`. The child is not the unit's main PID, so the unit needs
 * `NotifyAccess=all` (`infra/vps/substrate-mcp.service.d/20-watchdog.conf.example`).
 * Every spawn has a hard timeout and a stuck child is killed.
 *
 * Flag off, or `NOTIFY_SOCKET` unset: `start()` returns false and creates no
 * timer, no child and no request. This module never reads `/healthz`.
 */
import { spawn as spawnProcess } from "node:child_process";

/** What the watchdog says to systemd. Closed: nothing user-controlled is ever sent. */
export type NotifyMessage = "READY=1" | "WATCHDOG=1";

/** Sends one message; true when the notifier reported success. Never rejects in production. */
export type Notifier = (message: NotifyMessage, signal: AbortSignal) => Promise<boolean>;

export interface ProbeResult {
	ok: boolean;
	/** The `loop_lag_ms` the answer reported, or null when it was not a usable `/livez` body. */
	loopLagMs: number | null;
}

/** One loopback fetch of this process's own `/livez`. */
export type Probe = (signal: AbortSignal) => Promise<ProbeResult>;

/** Repeating timer seam: returns its canceller. Production timers are unref'd. */
export interface Scheduler {
	every(ms: number, fn: () => void): () => void;
}

export const realScheduler: Scheduler = {
	every(ms, fn) {
		const timer = setInterval(fn, ms);
		timer.unref?.();
		return () => clearInterval(timer);
	},
};

// ── Event-loop lag ───────────────────────────────────────────────────────────

/** Sampling period. 250 ms resolves a 1 s stall four times over and costs four wakeups a second. */
export const LAG_SAMPLE_MS = 250;
/** Default ring window: at least one default watchdog tick (WatchdogSec=30 → 10 s). */
export const LAG_WINDOW_MS = 10_000;
/** Hard cap on the ring, whatever window was asked for. */
const LAG_RING_MAX = 4096;

export interface LoopLagOptions {
	intervalMs?: number;
	/** The window `lagMs()` reports the worst lag over. Make it at least the slowest reader's period. */
	windowMs?: number;
	/** Monotonic milliseconds. */
	now?: () => number;
	scheduler?: Scheduler;
}

/** What `Watchdog` needs from a lag source; `LoopLagMonitor` satisfies it. */
export interface LagSource {
	start(): void;
	stop(): void;
	lagMs(): number;
}

/**
 * Worst event-loop lag over the last `windowMs`, from a timer that expects to
 * fire every `intervalMs`. The ring has a fixed size, so memory is bounded and
 * the oldest sample is the one overwritten. `lagMs()` also counts the stall in
 * progress: a reader that runs the moment a long block ends sees the block
 * before the next sample has had a chance to record it.
 */
export class LoopLagMonitor implements LagSource {
	private readonly intervalMs: number;
	private readonly now: () => number;
	private readonly scheduler: Scheduler;
	private readonly ring: number[];
	private index = 0;
	private last: number;
	private cancel: (() => void) | null = null;

	constructor(options: LoopLagOptions = {}) {
		this.intervalMs = Math.max(1, options.intervalMs ?? LAG_SAMPLE_MS);
		this.now = options.now ?? (() => performance.now());
		this.scheduler = options.scheduler ?? realScheduler;
		const windowMs = Math.max(this.intervalMs, options.windowMs ?? LAG_WINDOW_MS);
		this.ring = new Array<number>(Math.min(LAG_RING_MAX, Math.ceil(windowMs / this.intervalMs))).fill(0);
		this.last = this.now();
	}

	start(): void {
		if (this.cancel !== null) return;
		this.last = this.now();
		this.cancel = this.scheduler.every(this.intervalMs, () => this.sample());
	}

	stop(): void {
		this.cancel?.();
		this.cancel = null;
	}

	/** One timer tick. Public so a test can drive it with a fake clock. */
	sample(): void {
		const at = this.now();
		this.ring[this.index] = Math.max(0, at - this.last - this.intervalMs);
		this.index = (this.index + 1) % this.ring.length;
		this.last = at;
	}

	lagMs(): number {
		let worst = this.cancel === null ? 0 : Math.max(0, this.now() - this.last - this.intervalMs);
		for (const sample of this.ring) if (sample > worst) worst = sample;
		return worst;
	}
}

// ── /livez ───────────────────────────────────────────────────────────────────

export interface LivezBody {
	ok: true;
	uptime_s: number;
	loop_lag_ms: number;
}

/** The whole answer of `GET /livez`. Reads the lag source and the process clock, nothing else. */
export function livezBody(lag: { lagMs(): number }, uptimeSeconds: number = process.uptime()): LivezBody {
	return { ok: true, uptime_s: Math.floor(uptimeSeconds), loop_lag_ms: Math.round(lag.lagMs()) };
}

/**
 * Whether a connection is this host talking to itself: a loopback peer, or a
 * peer whose address is the address it connected to (the server bound to a
 * concrete local address). A remote client cannot have either.
 */
export function isLocalPeer(remoteAddress: string | undefined, localAddress: string | undefined): boolean {
	if (remoteAddress === undefined || remoteAddress === "") return false;
	if (remoteAddress === "::1" || remoteAddress.startsWith("127.") || remoteAddress.startsWith("::ffff:127.")) return true;
	return localAddress !== undefined && remoteAddress === localAddress;
}

// ── Settings ─────────────────────────────────────────────────────────────────

/** Gap between READY=1 attempts when systemd armed no watchdog (no WATCHDOG_USEC). */
export const READY_RETRY_MS = 5000;
export const DEFAULT_LAG_THRESHOLD_MS = 5000;
export const DEFAULT_PROBE_TIMEOUT_MS = 2000;
export const DEFAULT_NOTIFY_TIMEOUT_MS = 3000;
const MIN_PING_INTERVAL_MS = 1000;

export interface WatchdogSettings {
	/** `SUBSTRATE_WATCHDOG=1` and a `NOTIFY_SOCKET`. False makes the whole module a no-op. */
	enabled: boolean;
	/** Between pings: WATCHDOG_USEC / 3. Null when systemd armed no watchdog for this process: READY=1 only. */
	pingIntervalMs: number | null;
	lagThresholdMs: number;
	probeTimeoutMs: number;
	notifyTimeoutMs: number;
}

/** A whole number in [100, 60000], else the default. */
function boundedMs(raw: string | undefined, fallback: number): number {
	const text = raw?.trim();
	if (text === undefined || !/^[0-9]{1,5}$/.test(text)) return fallback;
	const value = Number(text);
	return value >= 100 && value <= 60_000 ? value : fallback;
}

/**
 * `SUBSTRATE_WATCHDOG` (only the literal `1` turns it on), systemd's own
 * `NOTIFY_SOCKET` and `WATCHDOG_USEC` / `WATCHDOG_PID`, and the three
 * tunables `SUBSTRATE_WATCHDOG_{LAG,PROBE,NOTIFY}_MS`. `pid` is this process's:
 * a `WATCHDOG_PID` naming another process means the watchdog is not ours to ping.
 */
export function watchdogSettings(env: Record<string, string | undefined>, pid: number = process.pid): WatchdogSettings {
	const socket = env.NOTIFY_SOCKET?.trim() ?? "";
	const enabled = env.SUBSTRATE_WATCHDOG?.trim() === "1" && socket !== "";
	const usecText = env.WATCHDOG_USEC?.trim() ?? "";
	const usec = /^[0-9]{1,15}$/.test(usecText) ? Number(usecText) : 0;
	const pidText = env.WATCHDOG_PID?.trim() ?? "";
	const ours = pidText === "" || Number(pidText) === pid;
	return {
		enabled,
		pingIntervalMs: usec > 0 && ours ? Math.max(MIN_PING_INTERVAL_MS, Math.floor(usec / 3000)) : null,
		lagThresholdMs: boundedMs(env.SUBSTRATE_WATCHDOG_LAG_MS, DEFAULT_LAG_THRESHOLD_MS),
		probeTimeoutMs: boundedMs(env.SUBSTRATE_WATCHDOG_PROBE_MS, DEFAULT_PROBE_TIMEOUT_MS),
		notifyTimeoutMs: boundedMs(env.SUBSTRATE_WATCHDOG_NOTIFY_MS, DEFAULT_NOTIFY_TIMEOUT_MS),
	};
}

// ── Notifier: the `systemd-notify` child ─────────────────────────────────────

export interface NotifyChild {
	exited: Promise<number>;
	kill(): void;
}

/** Starts `argv` with no stdio. Throws when the binary cannot be started. */
export type SpawnNotify = (argv: readonly string[]) => NotifyChild;

const spawnSystemdNotify: SpawnNotify = (argv) => {
	const [command, ...args] = argv;
	const child = spawnProcess(command ?? "systemd-notify", args, { stdio: "ignore" });
	const { promise: exited, resolve, reject } = Promise.withResolvers<number>();
	child.once("error", reject);
	child.once("exit", (code) => resolve(code ?? -1));
	return {
		exited,
		kill: () => {
			child.kill("SIGKILL");
		},
	};
};

export interface SystemdNotifierOptions {
	/** Hard bound on one child; a child still running at this point is killed and counts as a failure. */
	timeoutMs: number;
	spawn?: SpawnNotify;
}

/**
 * `systemd-notify <message>` as a child with a deadline. The timer is unref'd
 * and cleared on every exit path; the child is killed on timeout and on abort.
 * A spawn failure or a non-zero exit is `false`, never a throw.
 */
export function createSystemdNotifier(options: SystemdNotifierOptions): Notifier {
	const start = options.spawn ?? spawnSystemdNotify;
	return (message, signal) => {
		const { promise, resolve } = Promise.withResolvers<boolean>();
		if (signal.aborted) {
			resolve(false);
			return promise;
		}
		let child: NotifyChild | null = null;
		let done = false;
		const finish = (ok: boolean): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve(ok);
		};
		const onAbort = (): void => {
			child?.kill();
			finish(false);
		};
		const timer = setTimeout(() => {
			child?.kill();
			finish(false);
		}, options.timeoutMs);
		timer.unref?.();
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			child = start(["systemd-notify", message]);
		} catch {
			finish(false);
			return promise;
		}
		child.exited.then(
			(code) => finish(code === 0),
			() => finish(false),
		);
		return promise;
	};
}

// ── Probe: this process's own /livez ─────────────────────────────────────────

/** A `/livez` body is a few dozen bytes; anything past this is not one. */
const PROBE_BODY_MAX = 1024;

/** The body, read at most `limit` bytes, then the stream is cancelled. */
async function readBounded(res: Response, limit: number): Promise<string> {
	const reader = res.body?.getReader();
	if (reader === undefined) return "";
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
}

/**
 * One fetch of `url` bounded by `timeoutMs`. `ok` needs HTTP 200 and a body
 * with `ok: true`; the answer's `loop_lag_ms` is returned for the lag gate.
 * Never rejects: a refused connection, a timeout and a bad body are all `ok: false`.
 */
export function createLoopbackProbe(url: string, timeoutMs: number, fetchImpl: typeof fetch = fetch): Probe {
	return async (signal) => {
		const controller = new AbortController();
		const onAbort = (): void => controller.abort();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		timer.unref?.();
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", onAbort, { once: true });
		try {
			const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
			const text = await readBounded(res, PROBE_BODY_MAX);
			if (res.status !== 200) return { ok: false, loopLagMs: null };
			const body: unknown = JSON.parse(text);
			if (typeof body !== "object" || body === null) return { ok: false, loopLagMs: null };
			const record = body as { ok?: unknown; loop_lag_ms?: unknown };
			const lag = typeof record.loop_lag_ms === "number" && Number.isFinite(record.loop_lag_ms) ? record.loop_lag_ms : null;
			return { ok: record.ok === true && lag !== null, loopLagMs: lag };
		} catch {
			return { ok: false, loopLagMs: null };
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		}
	};
}

// ── The watchdog ─────────────────────────────────────────────────────────────

export interface WatchdogDeps {
	notify: Notifier;
	probe: Probe;
	lag: LagSource;
	scheduler?: Scheduler;
	/** One short fixed line; nothing user-controlled is ever passed. */
	log?: (line: string) => void;
}

export type TickReason =
	| "pinged"
	| "ready-only"
	| "ready-failed"
	| "lag"
	| "livez"
	| "notify-failed"
	| "busy"
	| "stopped";

export interface TickOutcome {
	reason: TickReason;
	/** True when `WATCHDOG=1` was sent and the notifier reported success on this tick. */
	pinged: boolean;
	/** Whether `READY=1` has been delivered (now or earlier). */
	ready: boolean;
}

const SKIP_LOG: Readonly<Partial<Record<TickReason, string>>> = {
	"ready-failed": "READY=1 was not delivered (systemd-notify failed or timed out)",
	lag: "event-loop lag over the threshold; WATCHDOG=1 withheld",
	livez: "loopback /livez did not answer; WATCHDOG=1 withheld",
	"notify-failed": "WATCHDOG=1 was not delivered (systemd-notify failed or timed out)",
};

export class Watchdog {
	private cancelTimer: (() => void) | null = null;
	private inflight: Promise<TickOutcome> | null = null;
	private readySent = false;
	private started = false;
	private stopped = false;
	private lastReason: TickReason | null = null;
	private readonly abort = new AbortController();
	private readonly scheduler: Scheduler;

	constructor(
		private readonly settings: WatchdogSettings,
		private readonly deps: WatchdogDeps,
	) {
		this.scheduler = deps.scheduler ?? realScheduler;
	}

	/**
	 * Arm the timer and send `READY=1` now. The timer is registered before the
	 * first await. Returns false, having done nothing at all, when the flag is
	 * off, `NOTIFY_SOCKET` is unset, or this watchdog already started or stopped.
	 */
	start(): boolean {
		if (!this.settings.enabled || this.started || this.stopped) return false;
		this.started = true;
		this.deps.lag.start();
		this.cancelTimer = this.scheduler.every(this.settings.pingIntervalMs ?? READY_RETRY_MS, () => {
			void this.tick();
		});
		void this.tick();
		return true;
	}

	/**
	 * One heartbeat decision. Single-flight: a tick that arrives while one is
	 * still running is dropped as `busy`, so a slow notifier never stacks children.
	 * `READY=1` goes first and is not gated on health; `WATCHDOG=1` needs the lag
	 * under the threshold and an answered `/livez`.
	 */
	tick(): Promise<TickOutcome> {
		if (this.stopped) return Promise.resolve({ reason: "stopped", pinged: false, ready: this.readySent });
		if (this.inflight !== null) return Promise.resolve({ reason: "busy", pinged: false, ready: this.readySent });
		const run: Promise<TickOutcome> = this.run().finally(() => {
			if (this.inflight === run) this.inflight = null;
		});
		this.inflight = run;
		return run;
	}

	/** Cancel the timer, abort and kill any in-flight child or fetch, and wait for the tick to end. Idempotent. */
	async stop(): Promise<void> {
		this.stopped = true;
		this.cancelTimer?.();
		this.cancelTimer = null;
		this.abort.abort();
		if (this.started) this.deps.lag.stop();
		const pending = this.inflight;
		if (pending !== null) await pending.catch(() => undefined);
	}

	private async run(): Promise<TickOutcome> {
		const outcome = await this.decide();
		this.report(outcome.reason);
		return outcome;
	}

	private async decide(): Promise<TickOutcome> {
		const signal = this.abort.signal;
		const done = (reason: TickReason, pinged = false): TickOutcome => ({ reason, pinged, ready: this.readySent });
		if (!this.readySent) {
			if (!(await this.send("READY=1", signal))) return done("ready-failed");
			this.readySent = true;
			if (this.settings.pingIntervalMs === null) {
				// No watchdog armed: READY=1 was the whole job, so stop retrying.
				this.cancelTimer?.();
				this.cancelTimer = null;
				return done("ready-only");
			}
		}
		if (this.settings.pingIntervalMs === null) return done("ready-only");
		if (this.stopped) return done("stopped");
		// `!(x <= t)` so a NaN lag fails closed.
		if (!(this.readLag() <= this.settings.lagThresholdMs)) return done("lag");
		const probe = await this.runProbe(signal);
		if (!probe.ok) return done("livez");
		if (probe.loopLagMs !== null && !(probe.loopLagMs <= this.settings.lagThresholdMs)) return done("lag");
		// Re-checked after the await: a stop that arrived during the probe must not ping.
		if (this.stopped) return done("stopped");
		if (!(await this.send("WATCHDOG=1", signal))) return done("notify-failed");
		return done("pinged", true);
	}

	private readLag(): number {
		try {
			return this.deps.lag.lagMs();
		} catch {
			return Number.POSITIVE_INFINITY;
		}
	}

	private async send(message: NotifyMessage, signal: AbortSignal): Promise<boolean> {
		try {
			return await this.deps.notify(message, signal);
		} catch {
			return false;
		}
	}

	private async runProbe(signal: AbortSignal): Promise<ProbeResult> {
		try {
			return await this.deps.probe(signal);
		} catch {
			return { ok: false, loopLagMs: null };
		}
	}

	/** One line per change of state, never one per tick. */
	private report(reason: TickReason): void {
		if (reason === "busy" || reason === "stopped" || reason === this.lastReason) return;
		const previous = this.lastReason;
		this.lastReason = reason;
		const line = SKIP_LOG[reason];
		try {
			if (line !== undefined) this.deps.log?.(`[substrate] watchdog: ${line}\n`);
			else if (previous !== null && SKIP_LOG[previous] !== undefined) this.deps.log?.("[substrate] watchdog: heartbeat resumed\n");
		} catch {
			// A failing log sink must not turn a heartbeat into a failure.
		}
	}
}

/**
 * The production watchdog: settings from the environment, `systemd-notify`
 * as the notifier, the server's own loopback `/livez` as the probe, and a lag
 * monitor whose window is one ping interval. Nothing runs until `start()`, and
 * `start()` does nothing unless the flag is on and `NOTIFY_SOCKET` is set.
 */
export function createWatchdog(
	env: Record<string, string | undefined>,
	livezUrl: string,
	log?: (line: string) => void,
): { watchdog: Watchdog; settings: WatchdogSettings } {
	const settings = watchdogSettings(env);
	const watchdog = new Watchdog(settings, {
		notify: createSystemdNotifier({ timeoutMs: settings.notifyTimeoutMs }),
		probe: createLoopbackProbe(livezUrl, settings.probeTimeoutMs),
		lag: new LoopLagMonitor({ windowMs: settings.pingIntervalMs ?? LAG_WINDOW_MS }),
		...(log === undefined ? {} : { log }),
	});
	return { watchdog, settings };
}

/** The URL this process fetches for its own `/livez`: the bound address, or loopback for a wildcard bind. */
export function livezUrlFor(host: string, port: number): string {
	const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	const target = bare === "" || bare === "0.0.0.0" || bare === "::" ? "127.0.0.1" : bare;
	return `http://${target.includes(":") ? `[${target}]` : target}:${port}/livez`;
}
