/**
 * Ledger-native SLO notifications (uplift-3 N2).
 *
 * Nothing announced a breach: `/slo` had to be read, and the dispatcher's
 * `[quota-burn]` marker was the only alert on the host. The notifier is a
 * timer that judges the catalogue, the planes, the burn ceilings, the capacity
 * runway and every breaker each `SUBSTRATE_SLO_NOTIFY_S`, and turns a
 * **sustained** condition into exactly one event per transition:
 *
 *   - an objective `breached`, or a breaker `open` (half-open counts as still
 *     open: it is one probe away from either), held for
 *     `SUBSTRATE_SLO_NOTIFY_SUSTAIN_S` → one `warning` with
 *     `payload.action = "slo.transition"`, `state = "breached" | "open"`;
 *   - the condition gone for the same sustain → one `note`, `state =
 *     "recovered"`. The sustain applies both ways so an objective sitting on
 *     its threshold cannot pair a breach and a recovery every minute.
 *
 * The last state emitted per objective lives in the SLO checkpoint
 * (`Observability.notifyRecords`), not only in this process: a restart that
 * restores the checkpoint finds the breach already announced and says nothing
 * until it recovers. Without a checkpoint a restart re-announces after one
 * sustain, which is the documented cost of running without one.
 *
 * Events go through `Substrate.emit` as surface `substrate` with
 * `payload.runtime = "slo"`, like every host job (`docs/event-vocabulary.md`);
 * the kinds are the existing `warning` and `note`, the surface is the server's
 * own. The optional webhook gets the same payload once per transition, bounded
 * to five seconds, never retried: a webhook that is down must not become a
 * second incident, and the ledger already has the event.
 *
 * Off unless `SUBSTRATE_SLO_NOTIFY=1`: nothing is scheduled, nothing is emitted.
 */
import type { BreakerSnapshot, BurnResult, CapacitySloResult, NotifyRecord, NotifyState, PlaneName, PlaneSloResult, SloResult } from "@substrate/observability";
import type { SloNotifySettings } from "./config.ts";
import type { EventInput } from "./types.ts";

/** Longest summary an event carries; the sentence is for a brief, not a report. */
export const NOTIFY_SUMMARY_MAX = 200;
/** How long one webhook POST may take. One attempt, never a retry. */
const WEBHOOK_TIMEOUT_MS = 5000;
/** The `session_id` every transition carries, so they chain in one place on the ledger. */
export const NOTIFY_SESSION = "slo:notify";

/** One objective's current condition, as the evaluators report it this tick. */
interface NotifyCondition {
	objective: string;
	/** The state this condition announces when sustained; `null` means the condition is clear. */
	state: Exclude<NotifyState, "recovered"> | null;
	observed: number | null;
	target: number | null;
}

/** Everything the notifier judges in one tick. */
export interface NotifyInputs {
	catalogue: SloResult[];
	planes: PlaneSloResult[];
	burn: BurnResult[];
	capacity: CapacitySloResult[];
	breakers: Record<PlaneName, BreakerSnapshot | null>;
}

/** What one transition emitted: the event, and whether the webhook took it. */
interface NotifyTransition {
	objective: string;
	state: NotifyState;
	event: EventInput;
	webhook: "sent" | "failed" | "skipped";
}

interface SloNotifierDeps {
	settings: SloNotifySettings;
	/** The evaluators, read fresh each tick; `/slo` serves the same arrays. */
	evaluate(): NotifyInputs;
	/** `Substrate.emit`; a rejection is logged and the transition is still recorded, since a retry would store a second event. */
	emit(event: EventInput): Promise<unknown>;
	/** `Observability.notifyRecords`, mutated in place and saved with the checkpoint. */
	records: Record<string, NotifyRecord>;
	now?: () => number;
	fetchImpl?: typeof fetch;
	/** Where failures go; defaults to one stderr line each. */
	log?: (line: string) => void;
}

/**
 * The conditions one tick judges: every objective id with whether it is
 * breached, and `breaker.<plane>` for every breaker that is not closed.
 * Unconfigured, unmeasurable and insufficient-data objectives are clear —
 * they are not breaches, and a plane this deployment lacks must not recover
 * from anything.
 */
export function notifyConditions(inputs: NotifyInputs): NotifyCondition[] {
	const objectives: Array<{ id: string; status: string; observed: number | null; target: number | null }> = [
		...inputs.catalogue,
		...inputs.planes,
		...inputs.burn,
		...inputs.capacity,
	];
	const conditions: NotifyCondition[] = objectives.map((result) => ({
		objective: result.id,
		state: result.status === "breached" ? "breached" : null,
		observed: result.observed,
		target: result.target,
	}));
	for (const [plane, breaker] of Object.entries(inputs.breakers)) {
		if (breaker === null) continue;
		conditions.push({
			objective: `breaker.${plane}`,
			state: breaker.state === "closed" ? null : "open",
			observed: breaker.failures,
			target: null,
		});
	}
	return conditions;
}

function fmt(value: number | null): string {
	if (value === null) return "n/a";
	return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/** The event one transition emits: bounded summary, the payload shape the vocabulary pins. */
export function transitionEvent(condition: Pick<NotifyCondition, "objective" | "observed" | "target">, state: NotifyState): EventInput {
	const summary = `slo ${state}: ${condition.objective} (observed ${fmt(condition.observed)}, target ${fmt(condition.target)})`;
	return {
		surface: "substrate",
		kind: state === "recovered" ? "note" : "warning",
		summary: summary.length > NOTIFY_SUMMARY_MAX ? summary.slice(0, NOTIFY_SUMMARY_MAX) : summary,
		session_id: NOTIFY_SESSION,
		payload: {
			action: "slo.transition",
			runtime: "slo",
			objective: condition.objective,
			state,
			observed: condition.observed,
			target: condition.target,
		},
	};
}

export class SloNotifier {
	/** When each objective's current condition was first seen, by objective; cleared when the condition changes. */
	readonly #since = new Map<string, { state: NotifyState; at: number }>();
	#timer: ReturnType<typeof setInterval> | null = null;
	#inFlight: Promise<NotifyTransition[]> | null = null;
	/** Webhook failures are logged once per reason, so a dead endpoint is one line, not one per transition. */
	readonly #loggedWebhookFailures = new Set<string>();
	readonly #now: () => number;
	readonly #fetch: typeof fetch;
	readonly #log: (line: string) => void;

	constructor(private readonly deps: SloNotifierDeps) {
		this.#now = deps.now ?? Date.now;
		this.#fetch = deps.fetchImpl ?? fetch;
		this.#log = deps.log ?? ((line) => process.stderr.write(`[substrate] ${line}\n`));
	}

	/** Schedule the evaluator. Nothing is scheduled unless `SUBSTRATE_SLO_NOTIFY=1`. */
	start(): boolean {
		if (!this.deps.settings.enabled || this.#timer !== null) return false;
		this.#timer = setInterval(() => void this.tick(), this.deps.settings.intervalS * 1000);
		this.#timer.unref();
		return true;
	}

	stop(): void {
		if (this.#timer !== null) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}

	get scheduled(): boolean {
		return this.#timer !== null;
	}

	/**
	 * One evaluation. Returns the transitions it emitted, in objective order.
	 * Serialised: a tick that is still emitting is joined, never doubled.
	 */
	tick(): Promise<NotifyTransition[]> {
		this.#inFlight ??= this.#evaluate().finally(() => {
			this.#inFlight = null;
		});
		return this.#inFlight;
	}

	async #evaluate(): Promise<NotifyTransition[]> {
		const now = this.#now();
		const sustainMs = this.deps.settings.sustainS * 1000;
		const transitions: NotifyTransition[] = [];
		for (const condition of notifyConditions(this.deps.evaluate())) {
			const last = this.deps.records[condition.objective];
			// The state this condition would announce: its own when active, `recovered`
			// when clear and something was announced before. A clear objective that was
			// never announced has nothing to recover from.
			const wanted: NotifyState | null =
				condition.state !== null ? condition.state : last !== undefined && last.state !== "recovered" ? "recovered" : null;
			if (wanted === null || last?.state === wanted) {
				this.#since.delete(condition.objective);
				continue;
			}
			const seen = this.#since.get(condition.objective);
			if (seen === undefined || seen.state !== wanted) {
				this.#since.set(condition.objective, { state: wanted, at: now });
				if (sustainMs > 0) continue;
			} else if (now - seen.at < sustainMs) {
				continue;
			}
			this.#since.delete(condition.objective);
			// Recorded before the emit resolves: a ledger that is slow or down must
			// not have the same transition emitted again next tick. The event is
			// fail-open at the ledger like every other, and the checkpoint carries the
			// record either way.
			this.deps.records[condition.objective] = { state: wanted, at: now };
			const event = transitionEvent(condition, wanted);
			try {
				await this.deps.emit(event);
			} catch (cause) {
				this.#log(`slo transition ${condition.objective} ${wanted} not stored: ${cause instanceof Error ? cause.message : String(cause)}`);
			}
			transitions.push({ objective: condition.objective, state: wanted, event, webhook: await this.#webhook(event, now) });
		}
		return transitions;
	}

	/** One bounded POST of the payload. Never throws; a failure is one log line per reason, and never the URL. */
	async #webhook(event: EventInput, at: number): Promise<NotifyTransition["webhook"]> {
		const url = this.deps.settings.webhookUrl;
		if (url === null) return "skipped";
		let failure: string | null = null;
		try {
			const response = await this.#fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...event.payload, summary: event.summary, at: new Date(at).toISOString() }),
				signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
			});
			if (!response.ok) failure = `HTTP ${response.status}`;
		} catch (cause) {
			failure = cause instanceof Error ? cause.name === "TimeoutError" ? "timed out" : cause.message : String(cause);
		}
		if (failure === null) return "sent";
		if (!this.#loggedWebhookFailures.has(failure)) {
			this.#loggedWebhookFailures.add(failure);
			this.#log(`slo webhook failed (${failure}); the transition is on the ledger and is not retried`);
		}
		return "failed";
	}
}
