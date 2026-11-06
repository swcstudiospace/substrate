/**
 * The schedule behind the docs merge-trigger lag warning (uplift-4 S7).
 *
 * `/slo` and `/metrics` only READ the freshness verdicts. The `warning` / `note`
 * transitions and the state-file writes behind them run here, on an unref'd
 * interval, so a breach is announced even when nobody reads `/slo`, and a monitor
 * GET never emits or writes. A pass is cheap and non-blocking: the service
 * hydrates, evaluates and starts the single-flight background settle (`LagSettler`),
 * which bounds every emit by a deadline and retries a failed delivery no sooner
 * than a minute later.
 */
import type { TimerApi } from "./metrics-history.ts";

interface DocsLagTimerDeps {
	/** `Substrate.settleDocsLag`: hydrate, evaluate, start the background settle; never throws. */
	settle: () => Promise<void>;
	/** Resolves when no settle pass is in flight (`Substrate.docsLagIdle`). */
	idle: () => Promise<void>;
	/** `SUBSTRATE_DOCS_LAG_CHECK_S`, already bounded by `loadConfig`. */
	intervalS: number;
	timers?: TimerApi;
}

export class DocsLagTimer {
	private readonly timers: TimerApi;
	private handle: { unref(): unknown } | null = null;
	private pass: Promise<void> | null = null;

	constructor(private readonly deps: DocsLagTimerDeps) {
		this.timers = deps.timers ?? { setInterval: (handler, ms) => setInterval(handler, ms), clearInterval: (handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]) };
	}

	/** Schedule the passes and run the first now. Idempotent; the timer is unref'd. */
	start(): boolean {
		if (this.handle !== null) return true;
		this.handle = this.timers.setInterval(() => void this.run(), this.deps.intervalS * 1000);
		this.handle.unref();
		void this.run();
		return true;
	}

	/** Clear the timer. A pass in flight finishes; `flush()` awaits it. */
	stop(): void {
		if (this.handle === null) return;
		this.timers.clearInterval(this.handle);
		this.handle = null;
	}

	/** Wait for the hydrate/evaluate step and for the settle it started; never rejects. */
	async flush(): Promise<void> {
		if (this.pass !== null) await this.pass.catch(() => undefined);
		await this.deps.idle().catch(() => undefined);
	}

	/** One pass, single-flight: a tick while one is running starts nothing. */
	private run(): Promise<void> {
		this.pass ??= this.deps.settle().finally(() => {
			this.pass = null;
		});
		return this.pass;
	}
}
