/**
 * Lease expiry sweeper: keeps lapsed node leases visible without any caller.
 *
 * Expiry is honoured lazily everywhere — a lapsed lease already reads as free — so the only caller of
 * `coord_reap_leases` today is whoever asks. That leaves the rows naming a holder that is gone, and no
 * ledger warning says the node is free again. This sweeper runs the existing `service.reapExpiredLeases`
 * on an unref'd timer (`SUBSTRATE_LEASE_REAP_INTERVAL_MS`, default 30 s, `0` disables it), so a lapsed
 * lease is reaped within about one interval of lapsing, with no `coord_reap_leases` call.
 *
 * The shape mirrors `SteeringExpirySweeper` (`planning/steering-delivery.ts`): one pass at a time (a tick
 * during a pass shares it), no pass starts after `stop`, and `idle` waits for a pass in flight. A pass
 * never rejects: a failure is logged once per change of line, redacted, and the next pass tries again —
 * `reapExpiredLeases` is idempotent. It adds no schema and calls no new service method.
 */
import { redact } from "./redact.ts";

/** The environment variable that sets the reap interval. */
export const LEASE_REAP_INTERVAL_ENV = "SUBSTRATE_LEASE_REAP_INTERVAL_MS";
/** The production reap interval: a lapsed lease is reaped within about 30 s of lapsing. */
export const DEFAULT_LEASE_REAP_INTERVAL_MS = 30_000;
/** The longest reap interval: one hour. Longer values clamp to it. */
export const MAX_LEASE_REAP_INTERVAL_MS = 3_600_000;
/** The shortest non-disabled reap interval: a tighter interval only hammers the index. */
export const MIN_LEASE_REAP_INTERVAL_MS = 1_000;

export interface LeaseReapSettings {
	/** Milliseconds between reap passes; `0` disables the sweeper. */
	intervalMs: number;
}

/**
 * Read the reap interval from an environment map. Unset, blank, unparseable or non-integer falls back
 * to {@link DEFAULT_LEASE_REAP_INTERVAL_MS}; `0` disables; out-of-range values clamp to
 * `MIN..MAX_LEASE_REAP_INTERVAL_MS`. Never throws: a bad value must not refuse the boot, since lazy
 * expiry still holds.
 */
export function loadLeaseReapSettings(env: Readonly<Record<string, string | undefined>>): LeaseReapSettings {
	const raw = env[LEASE_REAP_INTERVAL_ENV]?.trim();
	if (raw === undefined || raw === "") return { intervalMs: DEFAULT_LEASE_REAP_INTERVAL_MS };
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) return { intervalMs: DEFAULT_LEASE_REAP_INTERVAL_MS };
	if (parsed === 0) return { intervalMs: 0 };
	if (parsed < MIN_LEASE_REAP_INTERVAL_MS) return { intervalMs: MIN_LEASE_REAP_INTERVAL_MS };
	if (parsed > MAX_LEASE_REAP_INTERVAL_MS) return { intervalMs: MAX_LEASE_REAP_INTERVAL_MS };
	return { intervalMs: parsed };
}

/** The handle a reap timer returns. Opaque: it is only passed back to `clearInterval`. */
export type LeaseTimerHandle = unknown;

/** The timers the sweeper schedules its passes with. Production uses the global, unref'd timers; a test injects its own. */
export interface LeaseTimers {
	setInterval(run: () => Promise<unknown>, ms: number): LeaseTimerHandle;
	clearInterval(timer: LeaseTimerHandle): void;
}

function stderrReport(line: string): void {
	process.stderr.write(`${line}\n`);
}

const GLOBAL_TIMERS: LeaseTimers = {
	setInterval: (run, ms) => {
		const timer = setInterval(run, ms);
		timer.unref();
		return timer;
	},
	clearInterval: (timer: LeaseTimerHandle) => clearInterval(timer as ReturnType<typeof setInterval>),
};

/** The service surface the sweeper reaps through: the existing `coord_reap_leases` method, unscoped. */
export interface LeaseReapService {
	reapExpiredLeases(): Promise<readonly unknown[]>;
}

export interface LeaseExpirySweeperDeps {
	/** The service whose `reapExpiredLeases` each pass runs. */
	service: LeaseReapService;
	/** Milliseconds between passes (`loadLeaseReapSettings().intervalMs`); must be positive. */
	intervalMs: number;
	/** The timers. Omitted: the global ones, unref'd. A test injects its own. */
	timers?: LeaseTimers;
	/** Where a reap or a failed pass is reported. Omitted: stderr. */
	report?: (line: string) => void;
}

/**
 * Reaps lapsed leases on an unref'd timer. One pass at a time (a tick during a pass shares it), no pass
 * starts after `stop`, and `idle` waits for a pass in flight. A pass never rejects: a failure is
 * reported once per change of line, and the next pass tries again, since `reapExpiredLeases` is idempotent.
 */
export class LeaseExpirySweeper {
	private timer: LeaseTimerHandle | undefined;
	private running: Promise<readonly unknown[] | null> | null = null;
	private stopped = false;
	private lastLine: string | null = null;
	private readonly timers: LeaseTimers;
	private readonly reporter: (line: string) => void;

	constructor(private readonly deps: LeaseExpirySweeperDeps) {
		if (!Number.isSafeInteger(deps.intervalMs) || deps.intervalMs < 1) throw new RangeError("intervalMs must be a positive integer number of milliseconds");
		this.timers = deps.timers ?? GLOBAL_TIMERS;
		this.reporter = deps.report ?? stderrReport;
	}

	/** Start the timer. False when it is already started or has been stopped: a stopped sweeper never starts again. */
	start(): boolean {
		if (this.timer !== undefined || this.stopped) return false;
		this.timer = this.timers.setInterval(() => this.pass(), this.deps.intervalMs);
		return true;
	}

	/** Clear the timer and start no further pass. A pass in flight finishes; `idle` waits for it. */
	stop(): void {
		this.stopped = true;
		if (this.timer !== undefined) this.timers.clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Resolves once no pass is in flight. Never rejects. */
	async idle(): Promise<void> {
		while (this.running !== null) await this.running;
	}

	/** One pass. A call during a pass shares it. After `stop` it does nothing and resolves null. */
	pass(): Promise<readonly unknown[] | null> {
		if (this.stopped) return Promise.resolve(null);
		if (this.running !== null) return this.running;
		const run = this.passOnce().finally(() => {
			this.running = null;
		});
		this.running = run;
		return run;
	}

	private async passOnce(): Promise<readonly unknown[] | null> {
		try {
			const reaped = await this.deps.service.reapExpiredLeases();
			if (reaped.length > 0) this.say(`[substrate] lease expiry: ${reaped.length} reaped`);
			else this.lastLine = null;
			return reaped;
		} catch (cause) {
			this.say(`[substrate] lease expiry pass failed: ${redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 200)}`);
			return null;
		}
	}

	/** A line is said when it differs from the last one, so a failure that repeats each pass is reported once. */
	private say(line: string): void {
		if (line === this.lastLine) return;
		this.lastLine = line;
		this.reporter(line);
	}
}
