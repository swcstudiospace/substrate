/**
 * The weekly mental-model refresh (`HINDSIGHT_MENTAL_MODELS`).
 *
 * A mental model is a stored answer to one source query over a Hindsight bank.
 * A refresh asks Hindsight to re-run that query and rewrite the content. Under
 * `HINDSIGHT_MENTAL_MODELS=<bank>=<id>[,<id>...]` this job refreshes each named
 * model once every seven days and nothing else: with nothing named, no timer starts.
 *
 * The refresh endpoint is asynchronous. It answers `{operation_id, status}`, so
 * `ok` in the ledger means Hindsight accepted the job; the rebuild itself is not
 * awaited here. The first pass is seven days after start, never at boot.
 *
 * Fail-open, like every host job: a failed model never stops the others, a ledger
 * write that fails is ignored, and nothing here throws. One pass at a time: a tick
 * while a pass runs starts nothing.
 */
import type { MentalModelRef } from "./config.ts";
import type { TimerApi } from "./metrics-history.ts";
import { send, type FetchLike, type HindsightConfig } from "./planes/hindsight.ts";
import { reportSilent } from "./silent-failures.ts";
import type { EventInput } from "./types.ts";

/** Seven days, no jitter: the job's one cadence. */
export const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Bound on one refresh request. The plane answers at once; the rebuild is async on its side. */
const REFRESH_TIMEOUT_MS = 8_000;
/** The ledger action every per-model note carries (`payload.action`). */
export const REFRESH_ACTION = "memory.mental_model.refresh";

interface MentalModelRefreshDeps {
	/** The named models, already validated by `loadConfig`. */
	models: readonly MentalModelRef[];
	/** The Hindsight plane's config, or null when the plane is unconfigured (or this process is a guest). */
	hindsight: () => HindsightConfig | null;
	/** The fetch every plane call goes through; production passes the breaker-gated one. */
	fetchImpl: FetchLike;
	/** Records one ledger note; `index.ts` passes `Substrate.emit`. */
	emit: (event: EventInput) => Promise<unknown>;
	now?: () => Date;
	timers?: TimerApi;
}

/** How one model's refresh ended. `reason` is a fixed vocabulary, never plane text. */
type RefreshOutcome = { status: "ok" } | { status: "failed"; reason: string };

/** The ISO-8601 week of a UTC date, as `YYYY-Www`. */
export function isoWeek(date: Date): string {
	const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	// Monday is 1 and Sunday is 7; the Thursday of this week decides the week's year.
	day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
	const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
	const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
	return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The fixed reason for a non-2xx answer. Mirrors `statusKind` in `planes/hindsight.ts`, which stays private. */
function statusReason(status: number): string {
	if (status === 401 || status === 403) return "auth";
	if (status === 404) return "not-found";
	if (status === 429) return "rate-limit";
	if (status >= 400 && status < 500) return "bad-request";
	return "server";
}

/** The refresh answers `{operation_id, status}`; a non-empty `operation_id` is what proves Hindsight took the job. */
function isAccepted(body: unknown): boolean {
	if (typeof body !== "object" || body === null || !("operation_id" in body)) return false;
	return typeof body.operation_id === "string" && body.operation_id.length > 0;
}

/** The job: one timer, one pass at a time, one ledger note per model per pass. */
export class MentalModelRefresh {
	private readonly timers: TimerApi;
	private handle: { unref(): unknown } | null = null;
	/** The pass in flight; a tick while one runs starts nothing. */
	private pass: Promise<void> | null = null;

	constructor(private readonly deps: MentalModelRefreshDeps) {
		this.timers = deps.timers ?? { setInterval: (handler, ms) => setInterval(handler, ms), clearInterval: (handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]) };
	}

	/** Schedule the weekly pass. Nothing is scheduled with no models named, and no pass runs at boot. Idempotent; the timer is unref'd. */
	start(): boolean {
		if (this.handle !== null) return true;
		if (this.deps.models.length === 0) return false;
		this.handle = this.timers.setInterval(() => void this.run(), REFRESH_INTERVAL_MS);
		this.handle.unref();
		return true;
	}

	/** Clear the timer. A pass in flight finishes; `flush()` awaits it. */
	stop(): void {
		if (this.handle === null) return;
		this.timers.clearInterval(this.handle);
		this.handle = null;
	}

	/** Wait for a pass in flight; never rejects. */
	async flush(): Promise<void> {
		if (this.pass !== null) await this.pass.catch(() => undefined);
	}

	/** One pass over the named models, single-flight. */
	private run(): Promise<void> {
		this.pass ??= this.refreshAll().finally(() => {
			this.pass = null;
		});
		return this.pass;
	}

	private async refreshAll(): Promise<void> {
		const week = isoWeek(this.deps.now?.() ?? new Date());
		const config = this.plane();
		for (const model of this.deps.models) {
			const outcome = await this.refreshOne(config, model);
			await this.record(model, week, outcome);
		}
	}

	private plane(): HindsightConfig | null {
		try {
			return this.deps.hindsight();
		} catch (cause: unknown) {
			reportSilent("mental-model.plane", cause);
			return null;
		}
	}

	private async refreshOne(config: HindsightConfig | null, model: MentalModelRef): Promise<RefreshOutcome> {
		if (config === null) return { status: "failed", reason: "unconfigured" };
		const path = `/v1/default/banks/${encodeURIComponent(model.bank)}/mental-models/${encodeURIComponent(model.id)}/refresh`;
		try {
			// An empty body runs the model in its own trigger mode; `mode: "full"` is never sent.
			const result = await send(config, "POST", path, {}, { fetchImpl: this.deps.fetchImpl, timeoutMs: REFRESH_TIMEOUT_MS });
			if (!result.ok) return { status: "failed", reason: result.error.kind };
			if (result.value.status < 200 || result.value.status > 299) return { status: "failed", reason: statusReason(result.value.status) };
			return isAccepted(result.value.body) ? { status: "ok" } : { status: "failed", reason: "invalid-response" };
		} catch {
			return { status: "failed", reason: "unexpected" };
		}
	}

	/** One ledger note for this model's outcome; a failed write is ignored, since the refresh already ran. */
	private async record(model: MentalModelRef, week: string, outcome: RefreshOutcome): Promise<void> {
		const payload: Record<string, unknown> = { action: REFRESH_ACTION, bank: model.bank, mental_model_id: model.id, status: outcome.status };
		if (outcome.status === "failed") payload.reason = outcome.reason;
		const named = `${model.bank}/${model.id}`;
		const event: EventInput = {
			surface: "substrate",
			kind: outcome.status === "ok" ? "note" : "warning",
			summary: outcome.status === "ok" ? `mental model refresh accepted: ${named}` : `mental model refresh failed (${outcome.reason}): ${named}`,
			session_id: `mental-model:${model.bank}:${model.id}:${week}`,
			payload,
		};
		try {
			await this.deps.emit(event);
		} catch {
			// Fail-open: the other models still get their pass and their notes.
		}
	}
}
