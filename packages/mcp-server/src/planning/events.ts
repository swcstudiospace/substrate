/**
 * Planning-change events (phase 52, SOTA-08).
 *
 * The event uses an existing vocabulary entry: kind `note` on the `substrate` host-job surface.
 * `EVENT_KINDS` is frozen at twelve and gains nothing here. The payload is
 * `{ kind: "planning.changed", repo, sessionId, added, removed, changed, truncated }`. Its lists hold paths
 * only, never file text, and are budgeted to the ledger's payload limit; `truncated` counts the paths left out per list.
 * Both the summary and the payload pass through the existing redactor.
 *
 * The publish port wraps the existing event bus. The bus carries wake-up hints only (D50-b), so a
 * hint has no payload. The ledger write that stores the full event is a wiring step, not done here.
 */
import type { EventBus, EventHint } from "../event-bus.ts";
import { MAX_PAYLOAD_BYTES } from "../event.ts";
import { redact, redactValue } from "../redact.ts";
import type { EventInput } from "../types.ts";
import { diffPlanningIndex, type PlanningDiff, type PlanningSnapshot } from "./diff.ts";
import { SESSION_ID_RE } from "./presence.ts";

export const PLANNING_CHANGED = "planning.changed";

/** A list in the payload holds at most this many paths. The summary states the full counts. */
export const MAX_EVENT_PATHS = 100;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type PlanningChangePayload = {
	kind: "planning.changed";
	repo: string;
	sessionId: string;
	added: string[];
	removed: string[];
	changed: string[];
	/** How many paths of each list were not listed. Present only when at least one list was truncated. */
	truncated?: Record<"added" | "removed" | "changed", number>;
};

export interface PlanningChangeInput {
	/** `owner/name`. A malformed repo is a configuration error and throws. */
	repo: string;
	sessionId: string;
	diff: PlanningDiff;
}

/** Keep order when the payload is budgeted: each list in turn, path by path. */
const LISTS = ["added", "removed", "changed"] as const;
type ListName = (typeof LISTS)[number];

/** Bytes of a value as the ledger stores it: UTF-8 JSON. */
function jsonBytes(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * The event for a diff, or null when nothing changed. Throws a TypeError on a malformed repo or session id.
 *
 * Paths are kept in order until the next one would push the payload past the ledger's payload limit (`MAX_PAYLOAD_BYTES`,
 * measured after redaction) or a list reaches `MAX_EVENT_PATHS`. The rest are counted in `truncated`, per list, and the
 * summary states them. The counts in the summary are always the full counts of the diff.
 */
export function planningChangeEvent(input: PlanningChangeInput): EventInput | null {
	if (!REPO_RE.test(input.repo)) throw new TypeError("planning repo must be owner/name");
	if (!SESSION_ID_RE.test(input.sessionId)) throw new TypeError("planning sessionId is not a valid session id");
	const { added, removed, changed } = input.diff;
	if (!input.diff.complete || removed === null) throw new TypeError("a partial planning diff is not an event");
	if (added.length + removed.length + changed.length === 0) return null;

	const lists: Record<ListName, string[]> = { added, removed, changed };
	const kept: Record<ListName, string[]> = { added: [], removed: [], changed: [] };
	const payloadWith = (truncated: Record<ListName, number> | null): PlanningChangePayload => ({
		kind: PLANNING_CHANGED,
		repo: input.repo,
		sessionId: input.sessionId,
		added: kept.added,
		removed: kept.removed,
		changed: kept.changed,
		...(truncated === null ? {} : { truncated }),
	});
	// The check counts each list's full length as its truncation, which has as many digits as any real count: a bound.
	const fullTruncation = { added: lists.added.length, removed: lists.removed.length, changed: lists.changed.length };
	let budgetSpent = false;
	for (const name of LISTS) {
		for (const path of lists[name]) {
			if (!budgetSpent && kept[name].length < MAX_EVENT_PATHS) {
				kept[name].push(path);
				if (jsonBytes(redactValue(payloadWith(fullTruncation))) <= MAX_PAYLOAD_BYTES) continue;
				kept[name].pop();
				budgetSpent = true;
			}
		}
	}
	const truncated: Record<ListName, number> = {
		added: lists.added.length - kept.added.length,
		removed: lists.removed.length - kept.removed.length,
		changed: lists.changed.length - kept.changed.length,
	};
	const omitted = truncated.added + truncated.removed + truncated.changed;
	const note = omitted > 0 ? `; paths not listed: ${truncated.added} added, ${truncated.removed} removed, ${truncated.changed} changed` : "";
	const summary = `planning changed in ${input.repo}: ${added.length} added, ${removed.length} removed, ${changed.length} changed${note}`;
	return {
		surface: "substrate",
		kind: "note",
		summary: redact(summary),
		repo: input.repo,
		session_id: input.sessionId,
		payload: redactValue(payloadWith(omitted > 0 ? truncated : null)),
	};
}

/** The publish port. Resolves true when the event was handed to the bus, false when it was not. */
export interface PlanningPublisher {
	publish(event: EventInput): Promise<boolean>;
}

export interface HintDeps {
	newId: () => string;
	nowIso: () => string;
}

/** The publisher over the existing bus. Only the hint fields cross: the payload never reaches the bus. */
export function busPublisher(bus: Pick<EventBus, "publish">, deps: HintDeps): PlanningPublisher {
	return {
		publish: (event) => {
			const hint: EventHint = {
				v: 1,
				id: deps.newId(),
				kind: event.kind,
				surface: event.surface,
				graph_id: event.graph_id ?? null,
				ts: deps.nowIso(),
			};
			return bus.publish(hint);
		},
	};
}

export type PlanningEmitOutcome = "unchanged" | "incomplete" | "published" | "not-published";

/** Build the event for a diff and publish it. An unchanged diff publishes nothing; a partial one is never published, since its absences prove nothing. */
export async function emitPlanningChange(publisher: PlanningPublisher, input: PlanningChangeInput): Promise<PlanningEmitOutcome> {
	if (!input.diff.complete) return "incomplete";
	const event = planningChangeEvent(input);
	if (event === null) return "unchanged";
	return (await publisher.publish(event)) ? "published" : "not-published";
}

export interface ObservedPlanning {
	outcome: "baseline" | PlanningEmitOutcome;
	/** What the next scan is compared with: this scan, except that a failed publish holds the previous baseline. See `observePlanningChange`. */
	baseline: PlanningSnapshot;
}

export interface ObservePlanningInput {
	previous: PlanningSnapshot | null;
	next: PlanningSnapshot;
	repo: string;
	sessionId: string;
	publisher: PlanningPublisher;
}

/**
 * One observation: diff the scan against the previous baseline, publish the change only when the diff is complete, and
 * choose the next baseline by outcome.
 *
 * The rule: a failed publish (`not-published`) holds the previous baseline, so the same change is diffed and sent again
 * on the next read. Every other outcome advances the baseline to this scan: `baseline` (the first scan ever), `unchanged`,
 * `incomplete` (nothing is published, and this is what ends an unreadable interval rather than repeating it forever) and
 * `published`. The first scan ever emits nothing.
 */
export async function observePlanningChange(input: ObservePlanningInput): Promise<ObservedPlanning> {
	const { previous, next } = input;
	if (previous === null) return { outcome: "baseline", baseline: next };
	const diff = diffPlanningIndex(previous, next);
	const outcome = await emitPlanningChange(input.publisher, { repo: input.repo, sessionId: input.sessionId, diff });
	return { outcome, baseline: outcome === "not-published" ? previous : next };
}
