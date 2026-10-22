/**
 * Planning conflicts (phase 53, SOTA-09): a pure detector over the sessions of a presence snapshot.
 *
 * - Each session carries its planning report in its presence record (`report.ts`). Keys are parsed phase and plan ids,
 *   never a file path.
 * - A session claims only its active phase (`activePhase` on its presence record). Phases that its checkout's index merely
 *   contains are history, not work, and never produce a claim.
 * - Phase key: two or more known, active sessions on one active phase. The event names that phase and the plan ids two or
 *   more of those sessions share.
 * - Plan key: two or more known, active sessions that share a plan id under different active phases. The event names the
 *   plan id and the phases. A plan shared inside one phase is covered by that phase's event and gets no second one.
 * - Nothing is auto-resolved. Each conflict is `status: "open"`; the detector reports it and stops.
 * - A session's view is unknown when its report is missing, older than `maxScanAgeMs`, or unknown. An unknown view takes no
 *   part in detection, and conflict-sensitive writes for that session are refused until a later complete scan.
 *
 * The detector reads no clock and does no I/O. Callers pass `nowMs` and the presence snapshot they already hold.
 */
import { redact, redactValue } from "../redact.ts";
import type { EventInput } from "../types.ts";
import type { ClassifiedSession, PlanningReport, UnknownViewReason } from "./presence.ts";

export type { UnknownViewReason } from "./presence.ts";

export const PLANNING_CONFLICT = "planning.conflict";

/** The event's kind in the frozen `EVENT_KINDS` vocabulary (phase 17). A conflict is a warning on the `substrate` surface. */
export const PLANNING_CONFLICT_EVENT_KIND = "warning";

/** Each id list in a conflict payload holds at most this many ids. The payload stays inside the ledger's payload limit. */
export const MAX_CONFLICT_LIST = 32;

export interface PhaseClaim {
	phase: string;
	/** Plan ids seen under this phase, sorted. Empty when the session only touches phase-level documents. */
	plans: string[];
}

export type SessionView =
	| { sessionId: string; status: "known"; scannedAtMs: number; claim: PhaseClaim | null }
	| { sessionId: string; status: "unknown"; reason: UnknownViewReason };

export type ConflictKey = { by: "phase"; phase: string } | { by: "plan"; plan: string };

export interface PlanningConflict {
	kind: typeof PLANNING_CONFLICT;
	status: "open";
	key: ConflictKey;
	/** The active phases of the conflicting sessions, sorted. Exactly one for a phase key. */
	phases: string[];
	/** Plan ids that two or more conflicting sessions share, sorted. A plan key has its own id here. May be empty for a phase key. */
	plans: string[];
	/** The conflicting sessions, sorted. Always two or more. */
	sessionIds: string[];
	detectedAtMs: number;
}

export interface ConflictInput {
	/** A presence snapshot, each record carrying its planning report. Only sessions with `status: "active"` take part. */
	sessions: readonly ClassifiedSession[];
	nowMs: number;
	/** A report older than this is unknown. A report exactly this old is still known. */
	maxScanAgeMs: number;
}

export interface ConflictReport {
	/** One view per active session, sorted by session id. */
	views: SessionView[];
	/** Phase conflicts first, sorted by phase, then plan conflicts sorted by plan id. Empty when nothing conflicts. */
	conflicts: PlanningConflict[];
}

export type ConflictWriteGate =
	| { ok: true }
	| { ok: false; code: "planning-view-unknown"; reason: UnknownViewReason | "no-active-session" };

interface Member {
	sessionId: string;
	phase: string;
	plans: string[];
}

/** One session's view, judged against the clock. A session with no report is `no-scan`. */
export function sessionViewOf(session: ClassifiedSession, nowMs: number, maxScanAgeMs: number): SessionView {
	const report: PlanningReport | undefined = session.planning;
	if (report === undefined) return { sessionId: session.sessionId, status: "unknown", reason: "no-scan" };
	if (nowMs - report.scannedAtMs > maxScanAgeMs) return { sessionId: session.sessionId, status: "unknown", reason: "scan-stale" };
	if (report.status === "unknown") return { sessionId: session.sessionId, status: "unknown", reason: report.reason };
	return { sessionId: session.sessionId, status: "known", scannedAtMs: report.scannedAtMs, claim: claimOf(report, session.activePhase) };
}

export function detectConflicts(input: ConflictInput): ConflictReport {
	assertInput(input);
	const active = input.sessions.filter((session) => session.status === "active");
	const views = active
		.map((session) => sessionViewOf(session, input.nowMs, input.maxScanAgeMs))
		.sort((a, b) => compareText(a.sessionId, b.sessionId));
	return { views, conflicts: conflictsFrom(views, input.nowMs) };
}

/** Whether a conflict-sensitive write may proceed for this session, given the views from `detectConflicts`. */
export function gateConflictSensitiveWrite(views: readonly SessionView[], sessionId: string): ConflictWriteGate {
	const view = views.find((candidate) => candidate.sessionId === sessionId);
	if (view === undefined) return { ok: false, code: "planning-view-unknown", reason: "no-active-session" };
	if (view.status === "unknown") return { ok: false, code: "planning-view-unknown", reason: view.reason };
	return { ok: true };
}

/** Identifies one open conflict across reads: the same key, phases, plans and sessions. A change to any of them is a new conflict. */
export function conflictSignature(conflict: PlanningConflict): string {
	return JSON.stringify([conflict.key, conflict.phases, conflict.plans, conflict.sessionIds]);
}

/** The ledger event for one conflict. The repo is named only when the checkout's origin is known. Both summary and payload are redacted. */
export function conflictEvent(conflict: PlanningConflict, repo: string | null): EventInput {
	const label = conflict.key.by === "phase" ? `phase ${conflict.key.phase}` : `plan ${conflict.key.plan}`;
	const summary = `planning conflict on ${label}: ${conflict.sessionIds.length} sessions`;
	const payload = {
		kind: PLANNING_CONFLICT,
		status: conflict.status,
		key: conflict.key,
		phases: conflict.phases,
		plans: conflict.plans.slice(0, MAX_CONFLICT_LIST),
		planCount: conflict.plans.length,
		sessionIds: conflict.sessionIds.slice(0, MAX_CONFLICT_LIST),
		sessionCount: conflict.sessionIds.length,
		detectedAtMs: conflict.detectedAtMs,
	};
	return {
		surface: "substrate",
		kind: PLANNING_CONFLICT_EVENT_KIND,
		summary: redact(summary),
		...(repo === null ? {} : { repo }),
		payload: redactValue(payload),
	};
}

/** A session claims its active phase, with the plan ids its report lists under that phase. */
function claimOf(report: Extract<PlanningReport, { status: "known" }>, activePhase: string | null): PhaseClaim | null {
	if (activePhase === null) return null;
	const entry = report.phases.find((candidate) => candidate.phase === activePhase);
	return { phase: activePhase, plans: entry === undefined ? [] : [...entry.plans].sort(compareText) };
}

function conflictsFrom(views: readonly SessionView[], detectedAtMs: number): PlanningConflict[] {
	const members: Member[] = [];
	for (const view of views) {
		if (view.status === "known" && view.claim !== null) {
			members.push({ sessionId: view.sessionId, phase: view.claim.phase, plans: view.claim.plans });
		}
	}

	const byPhase = new Map<string, Member[]>();
	for (const member of members) byPhase.set(member.phase, [...(byPhase.get(member.phase) ?? []), member]);
	const phaseConflicts: PlanningConflict[] = [];
	for (const [phase, group] of [...byPhase].sort(([a], [b]) => compareText(a, b))) {
		if (group.length < 2) continue;
		const holders = new Map<string, number>();
		for (const member of group) for (const plan of member.plans) holders.set(plan, (holders.get(plan) ?? 0) + 1);
		phaseConflicts.push({
			kind: PLANNING_CONFLICT,
			status: "open",
			key: { by: "phase", phase },
			phases: [phase],
			plans: [...holders].filter(([, count]) => count >= 2).map(([plan]) => plan).sort(compareText),
			sessionIds: group.map((member) => member.sessionId).sort(compareText),
			detectedAtMs,
		});
	}

	const byPlan = new Map<string, Map<string, string>>();
	for (const member of members) {
		for (const plan of member.plans) {
			const holders = byPlan.get(plan) ?? new Map<string, string>();
			holders.set(member.sessionId, member.phase);
			byPlan.set(plan, holders);
		}
	}
	const planConflicts: PlanningConflict[] = [];
	for (const [plan, holders] of [...byPlan].sort(([a], [b]) => compareText(a, b))) {
		const phases = new Set(holders.values());
		if (holders.size < 2 || phases.size < 2) continue;
		planConflicts.push({
			kind: PLANNING_CONFLICT,
			status: "open",
			key: { by: "plan", plan },
			phases: [...phases].sort(compareText),
			plans: [plan],
			sessionIds: [...holders.keys()].sort(compareText),
			detectedAtMs,
		});
	}

	return [...phaseConflicts, ...planConflicts];
}

function assertInput(input: ConflictInput): void {
	if (!Number.isFinite(input.nowMs)) throw new RangeError("nowMs must be a finite number");
	if (!Number.isFinite(input.maxScanAgeMs) || input.maxScanAgeMs <= 0) {
		throw new RangeError("maxScanAgeMs must be a positive number");
	}
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
