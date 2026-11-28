/**
 * Read-only session replay to a checkpoint (phase 86, E8).
 *
 * Replay reads the append-only ledger, verifies the hash chain with the
 * existing `verifyChain` path, and re-applies steering/session actions up to
 * a checkpoint — as a fold over events, never as writes. The ledger is never
 * mutated: the input is `readonly`, the output is fresh objects, and a broken
 * chain refuses before any checkpoint is resolved.
 *
 * The replay summary is emitted as a ledger-note body (`formatReplaySummary`)
 * and mirrored to Linear/Notion through injected comment sinks
 * (`mirrorReplaySummary`). Production wiring passes the existing
 * Linear/Notion clients as sinks; the mirror never decides anything and never
 * throws — one target being down is a per-target `failed` outcome, not a
 * replay failure.
 */
import { verifyChain } from "./event.ts";
import { SESSION_CHECKPOINT_ACTION } from "./session-events.ts";
import type { SubstrateEvent } from "./types.ts";

/** How a caller names the checkpoint to replay to. Exactly one should be set. */
export interface ReplayRef {
	checkpointId?: string;
	eventId?: string;
	seq?: number;
}

/** One replayed action, as the summary reports it. Summaries are capped. */
export interface ReplayAction {
	eventId: string;
	kind: string;
	surface: string;
	summary: string;
}

/** The longest single action summary the note carries. */
export const REPLAY_SUMMARY_ACTION_MAX = 300;
/** The most actions the note lists; beyond that it reports the count. */
export const REPLAY_SUMMARY_ACTIONS_MAX = 50;

export interface ReplaySummary {
	checkpointId: string;
	checkpointEventId: string;
	seq: number | null;
	sessionId: string | null;
	graphId: string | null;
	/** Events folded, checkpoint included. */
	eventsReplayed: number;
	actions: ReplayAction[];
	/** Actions folded beyond `REPLAY_SUMMARY_ACTIONS_MAX`. */
	actionsOmitted: number;
	chainHead: { eventId: string; hash: string };
}

export type ReplayResult =
	| { ok: true; summary: ReplaySummary }
	| { ok: false; reason: "chain-broken"; brokenAt: string; detail: string }
	| { ok: false; reason: "not-found"; detail: string }
	| { ok: false; reason: "not-a-checkpoint"; eventId: string; detail: string };

function isCheckpointPayload(payload: Record<string, unknown>): payload is { ckpt_id: unknown; seq: unknown } {
	return payload["action"] === SESSION_CHECKPOINT_ACTION;
}

/**
 * Fold the ledger up to a checkpoint. Read-only: the input array and its
 * events are never mutated (pass a frozen array to prove it).
 */
export function replayToCheckpoint(
	events: readonly SubstrateEvent[],
	ref: ReplayRef,
): ReplayResult {
	const verified = verifyChain(events.slice());
	if (!verified.ok) {
		return { ok: false, reason: "chain-broken", brokenAt: verified.brokenAt, detail: `chain breaks at ${verified.brokenAt}: ${verified.reason}` };
	}
	let index = -1;
	if (ref.checkpointId !== undefined) {
		index = events.findIndex(
			(event) => isCheckpointPayload(event.payload) && event.payload["ckpt_id"] === ref.checkpointId,
		);
		if (index === -1) return { ok: false, reason: "not-found", detail: `no checkpoint ${ref.checkpointId} in ${events.length} events` };
	} else if (ref.eventId !== undefined) {
		index = events.findIndex((event) => event.id === ref.eventId);
		if (index === -1) return { ok: false, reason: "not-found", detail: `no event ${ref.eventId} in ${events.length} events` };
		if (!isCheckpointPayload(events[index]?.payload ?? {})) {
			return { ok: false, reason: "not-a-checkpoint", eventId: ref.eventId, detail: `event ${ref.eventId} carries no session.checkpoint payload` };
		}
	} else if (ref.seq !== undefined) {
		index = events.findIndex(
			(event) => isCheckpointPayload(event.payload) && event.payload["seq"] === ref.seq,
		);
		if (index === -1) return { ok: false, reason: "not-found", detail: `no checkpoint with seq ${ref.seq} in ${events.length} events` };
	} else {
		return { ok: false, reason: "not-found", detail: "replay needs a checkpointId, eventId, or seq" };
	}
	const checkpoint = events[index];
	if (checkpoint === undefined) return { ok: false, reason: "not-found", detail: "checkpoint index out of range" };
	const payload = checkpoint.payload;
	const folded = events.slice(0, index + 1);
	const actions: ReplayAction[] = folded.slice(0, REPLAY_SUMMARY_ACTIONS_MAX).map((event) => ({
		eventId: event.id,
		kind: event.kind,
		surface: event.surface,
		summary: event.summary.slice(0, REPLAY_SUMMARY_ACTION_MAX),
	}));
	return {
		ok: true,
		summary: {
			checkpointId: String(payload["ckpt_id"] ?? ""),
			checkpointEventId: checkpoint.id,
			seq: typeof payload["seq"] === "number" ? payload["seq"] : null,
			sessionId: checkpoint.session_id,
			graphId: checkpoint.graph_id,
			eventsReplayed: folded.length,
			actions,
			actionsOmitted: Math.max(0, folded.length - actions.length),
			chainHead: { eventId: checkpoint.id, hash: checkpoint.hash },
		},
	};
}

export function formatReplaySummary(summary: ReplaySummary): string {
	const listed = summary.actions.slice(0, REPLAY_SUMMARY_ACTIONS_MAX);
	const omitted = summary.actionsOmitted + Math.max(0, summary.actions.length - listed.length);
	const lines = [
		`Session replay to checkpoint ${summary.checkpointId} (${summary.checkpointEventId})`,
		`events replayed: ${summary.eventsReplayed}; actions omitted: ${omitted}`,
		`chain head: ${summary.chainHead.eventId} ${summary.chainHead.hash}`,
	];
	for (const action of listed) {
		lines.push(`- ${action.eventId} ${action.kind} ${action.surface}: ${action.summary.slice(0, REPLAY_SUMMARY_ACTION_MAX)}`);
	}
	return lines.join("\n");
}

/** One mirror target. Production passes the existing Linear/Notion clients behind this shape. */
export interface ReplayMirrorSink {
	postComment(body: string): Promise<void>;
}

export interface ReplayMirrorSinks {
	linear?: ReplayMirrorSink | null;
	notion?: ReplayMirrorSink | null;
}

export type MirrorTargetStatus = "posted" | "skipped" | "failed";

export interface ReplayMirrorOutcome {
	linear: MirrorTargetStatus;
	notion: MirrorTargetStatus;
	reason: string | null;
}

/**
 * Mirror a replay summary to Linear/Notion via the existing reporters' sinks.
 * Report-only: never throws; a down target reads as `failed` with a capped reason.
 */
export async function mirrorReplaySummary(
	summary: ReplaySummary,
	sinks: ReplayMirrorSinks,
): Promise<ReplayMirrorOutcome> {
	const body = formatReplaySummary(summary);
	async function post(sink: ReplayMirrorSink | null | undefined): Promise<MirrorTargetStatus> {
		if (!sink) return "skipped";
		try {
			await sink.postComment(body);
			return "posted";
		} catch {
			return "failed";
		}
	}
	const [linear, notion] = await Promise.all([post(sinks.linear), post(sinks.notion)]);
	const failed = [linear, notion].filter((status) => status === "failed").length;
	return {
		linear,
		notion,
		reason: failed === 0 ? null : `${failed} mirror target(s) failed; replay itself is unaffected`,
	};
}
