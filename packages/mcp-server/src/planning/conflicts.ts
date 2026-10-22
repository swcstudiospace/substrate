/**
 * Planning conflicts (phase 53, SOTA-09): a pure detector over the sessions of a presence snapshot.
 *
 * - Each session carries its planning report in its presence record (`report.ts`), which says whether its view is known.
 * - Each session also carries its touched pairs (`presence.ts`): the phase and plan of each document its complete observations
 *   changed. A pair counts only while it is inside the presence TTL. Keys are parsed phase and plan ids, never a file path.
 * - A session carries the repository it names (`owner/name`). Conflicts are detected within one repository only: two checkouts
 *   of unrelated repositories that touch the same phase number do not conflict. A session with no repository takes no part.
 * - A session claims exactly its touched pairs. A phase its checkout's index merely contains, and it did not touch, is not a claim.
 * - Phase key: two or more known, active sessions of one repository that touched one phase. The event names that phase and the
 *   plan ids two or more of those sessions touched under it.
 * - Plan key: two or more known, active sessions of one repository that touched one plan id under different phases. The event
 *   names the plan id and those phases. A plan shared inside one phase is covered by that phase's event and gets no second one.
 * - Nothing is auto-resolved. Each conflict is `status: "open"`; the detector reports it and stops.
 * - A session's view is unknown when its report is missing, older than the TTL, or unknown. An unknown view takes no part in
 *   detection, and conflict-sensitive writes for that session are refused until a later complete scan.
 *
 * The detector reads no clock and does no I/O. Callers pass `nowMs`, the TTL and the presence snapshot they already hold.
 */
import { redact, redactValue } from "../redact.ts";
import type { EventInput } from "../types.ts";
import { touchedWithin, type ClassifiedSession, type PlanningReport, type TouchedPair, type UnknownViewReason } from "./presence.ts";

export type { UnknownViewReason } from "./presence.ts";

export const PLANNING_CONFLICT = "planning.conflict";

/** The event's kind in the frozen `EVENT_KINDS` vocabulary (phase 17). A conflict is a warning on the `substrate` surface. */
export const PLANNING_CONFLICT_EVENT_KIND = "warning";

/** Each id list in a conflict payload holds at most this many ids. The payload stays inside the ledger's payload limit. */
export const MAX_CONFLICT_LIST = 32;

export type SessionView =
	| { sessionId: string; status: "known"; scannedAtMs: number; repo: string | null; touched: TouchedPair[] }
	| { sessionId: string; status: "unknown"; reason: UnknownViewReason };

type KnownView = Extract<SessionView, { status: "known" }>;

export type ConflictKey = { by: "phase"; phase: string } | { by: "plan"; plan: string };

export interface PlanningConflict {
	kind: typeof PLANNING_CONFLICT;
	status: "open";
	/** The repository both sessions name. A conflict never spans two repositories. */
	repo: string;
	key: ConflictKey;
	/** The phases of the conflicting sessions' touched pairs, sorted. Exactly one for a phase key. */
	phases: string[];
	/** Plan ids that two or more conflicting sessions share, sorted. A plan key has its own id here. May be empty for a phase key. */
	plans: string[];
	/** The conflicting sessions, sorted. Always two or more. */
	sessionIds: string[];
	detectedAtMs: number;
}

export interface ConflictInput {
	/** A presence snapshot, each record carrying its planning report, touched pairs and repository. Only active sessions take part. */
	sessions: readonly ClassifiedSession[];
	nowMs: number;
	/**
	 * The presence TTL, in milliseconds. A report older than this is unknown, and a touched pair counts only while it is at most
	 * this old. A report or pair exactly this old still counts.
	 */
	ttlMs: number;
}

export interface ConflictReport {
	/** One view per active session, sorted by session id. */
	views: SessionView[];
	/** Per repository, phase conflicts first (sorted by phase), then plan conflicts (sorted by plan id). Empty when nothing conflicts. */
	conflicts: PlanningConflict[];
}

export type ConflictWriteGate =
	| { ok: true }
	| { ok: false; code: "planning-view-unknown"; reason: UnknownViewReason | "no-active-session" };

/** One session's view, judged against the clock. A session with no report is `no-scan`. */
export function sessionViewOf(session: ClassifiedSession, nowMs: number, ttlMs: number): SessionView {
	const report: PlanningReport | undefined = session.planning;
	if (report === undefined) return { sessionId: session.sessionId, status: "unknown", reason: "no-scan" };
	if (nowMs - report.scannedAtMs > ttlMs) return { sessionId: session.sessionId, status: "unknown", reason: "scan-stale" };
	if (report.status === "unknown") return { sessionId: session.sessionId, status: "unknown", reason: report.reason };
	return {
		sessionId: session.sessionId,
		status: "known",
		scannedAtMs: report.scannedAtMs,
		repo: session.repo ?? null,
		touched: touchedWithin(session.touched ?? [], nowMs, ttlMs),
	};
}

export function detectConflicts(input: ConflictInput): ConflictReport {
	assertInput(input);
	const active = input.sessions.filter((session) => session.status === "active");
	const views = active
		.map((session) => sessionViewOf(session, input.nowMs, input.ttlMs))
		.sort((a, b) => compareText(a.sessionId, b.sessionId));
	const byRepo = new Map<string, KnownView[]>();
	for (const view of views) {
		if (view.status !== "known" || view.repo === null) continue;
		byRepo.set(view.repo, [...(byRepo.get(view.repo) ?? []), view]);
	}
	const conflicts = [...byRepo]
		.sort(([a], [b]) => compareText(a, b))
		.flatMap(([repo, group]) => [...phaseConflictsOf(group, repo, input.nowMs), ...planConflictsOf(group, repo, input.nowMs)]);
	return { views, conflicts };
}

/** Whether a conflict-sensitive write may proceed for this session, given the views from `detectConflicts`. */
export function gateConflictSensitiveWrite(views: readonly SessionView[], sessionId: string): ConflictWriteGate {
	const view = views.find((candidate) => candidate.sessionId === sessionId);
	if (view === undefined) return { ok: false, code: "planning-view-unknown", reason: "no-active-session" };
	if (view.status === "unknown") return { ok: false, code: "planning-view-unknown", reason: view.reason };
	return { ok: true };
}

/** Identifies one open conflict across reads: the same repository, key, phases, plans and sessions. A change to any of them is a new conflict. */
export function conflictSignature(conflict: PlanningConflict): string {
	return JSON.stringify([conflict.repo, conflict.key, conflict.phases, conflict.plans, conflict.sessionIds]);
}

/** The ledger event for one conflict, on the repository the conflict names. Both summary and payload are redacted. */
export function conflictEvent(conflict: PlanningConflict): EventInput {
	const label = conflict.key.by === "phase" ? `phase ${conflict.key.phase}` : `plan ${conflict.key.plan}`;
	const summary = `planning conflict on ${label}: ${conflict.sessionIds.length} sessions`;
	const payload = {
		kind: PLANNING_CONFLICT,
		status: conflict.status,
		key: conflict.key,
		phases: conflict.phases.slice(0, MAX_CONFLICT_LIST),
		phaseCount: conflict.phases.length,
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
		repo: conflict.repo,
		payload: redactValue(payload),
	};
}

/** Phase key: for each phase two or more sessions touched, the plan ids two or more of them touched under it. */
function phaseConflictsOf(known: readonly KnownView[], repo: string, detectedAtMs: number): PlanningConflict[] {
	const byPhase = new Map<string, Map<string, Set<string>>>();
	for (const view of known) {
		for (const { phase, plan } of view.touched) {
			const sessions = byPhase.get(phase) ?? new Map<string, Set<string>>();
			const plans = sessions.get(view.sessionId) ?? new Set<string>();
			if (plan !== null) plans.add(plan);
			sessions.set(view.sessionId, plans);
			byPhase.set(phase, sessions);
		}
	}
	const conflicts: PlanningConflict[] = [];
	for (const [phase, sessions] of [...byPhase].sort(([a], [b]) => compareText(a, b))) {
		if (sessions.size < 2) continue;
		const holders = new Map<string, number>();
		for (const plans of sessions.values()) for (const plan of plans) holders.set(plan, (holders.get(plan) ?? 0) + 1);
		conflicts.push({
			kind: PLANNING_CONFLICT,
			status: "open",
			repo,
			key: { by: "phase", phase },
			phases: [phase],
			plans: [...holders]
				.filter(([, count]) => count >= 2)
				.map(([plan]) => plan)
				.sort(compareText),
			sessionIds: [...sessions.keys()].sort(compareText),
			detectedAtMs,
		});
	}
	return conflicts;
}

/** Plan key: for each plan id two or more sessions touched under two or more phases, the phases and sessions that touched it. */
function planConflictsOf(known: readonly KnownView[], repo: string, detectedAtMs: number): PlanningConflict[] {
	const byPlan = new Map<string, Map<string, Set<string>>>();
	for (const view of known) {
		for (const { phase, plan } of view.touched) {
			if (plan === null) continue;
			const sessions = byPlan.get(plan) ?? new Map<string, Set<string>>();
			const phases = sessions.get(view.sessionId) ?? new Set<string>();
			phases.add(phase);
			sessions.set(view.sessionId, phases);
			byPlan.set(plan, sessions);
		}
	}
	const conflicts: PlanningConflict[] = [];
	for (const [plan, sessions] of [...byPlan].sort(([a], [b]) => compareText(a, b))) {
		const phases = new Set<string>();
		for (const touched of sessions.values()) for (const phase of touched) phases.add(phase);
		if (sessions.size < 2 || phases.size < 2) continue;
		conflicts.push({
			kind: PLANNING_CONFLICT,
			status: "open",
			repo,
			key: { by: "plan", plan },
			phases: [...phases].sort(compareText),
			plans: [plan],
			sessionIds: [...sessions.keys()].sort(compareText),
			detectedAtMs,
		});
	}
	return conflicts;
}

function assertInput(input: ConflictInput): void {
	if (!Number.isFinite(input.nowMs)) throw new RangeError("nowMs must be a finite number");
	if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) throw new RangeError("ttlMs must be a positive number");
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
