/**
 * Planning conflicts (phase 53, SOTA-09): a pure detector over active sessions and their planning indexes.
 *
 * - Keys are the parsed phase and plan ids on index records (`phase`, `plan`), never a file path.
 * - A session claims only its active phase (`activePhase` on its presence record). Phases that its checkout's index
 *   merely contains are history, not work, and never produce a claim.
 * - Two or more known, active sessions on the same active phase produce one conflict event for that phase. The
 *   event lists the plan ids that two or more of those sessions share. A plan id is only meaningful inside
 *   its phase, so the phase is the unit of the event.
 * - Nothing is auto-resolved. Each event is `status: "open"`; the detector reports it and stops.
 * - A session's view is `unknown` when its scan is missing, failed, truncated, holds unreadable records, or is
 *   older than `maxScanAgeMs`. An unknown view cannot be trusted for conflicts, so it is excluded from
 *   detection and conflict-sensitive writes for that session are refused until a later full scan completes.
 *
 * The detector reads no clock and does no I/O. Callers pass `nowMs` and the scans they already hold.
 */
import { isErrorRecord, type PlanningFileRecord, type PlanningIndexResult, type PlanningRecord } from "./index.ts";
import type { ClassifiedSession } from "./presence.ts";

export const PLANNING_CONFLICT = "planning.conflict";

/** One session's planning index, with the time it was taken. `result.ok === false` is a failed scan. */
export interface SessionScan {
	sessionId: string;
	scannedAtMs: number;
	result: PlanningIndexResult;
}

export type UnknownViewReason = "no-scan" | "scan-failed" | "scan-truncated" | "scan-has-errors" | "scan-stale";

export interface PhaseClaim {
	phase: string;
	/** Plan ids seen under this phase, sorted. Empty when the session only touches phase-level documents. */
	plans: string[];
}

export type SessionView =
	| { sessionId: string; status: "known"; scannedAtMs: number; phases: PhaseClaim[] }
	| { sessionId: string; status: "unknown"; reason: UnknownViewReason };

export interface PlanningConflict {
	kind: typeof PLANNING_CONFLICT;
	status: "open";
	phase: string;
	/** Plan ids that two or more of the conflicting sessions share, sorted. May be empty. */
	plans: string[];
	/** The conflicting sessions, sorted. Always two or more. */
	sessionIds: string[];
	detectedAtMs: number;
}

export interface ConflictInput {
	/** A presence snapshot. Only sessions with `status: "active"` take part. */
	sessions: readonly ClassifiedSession[];
	scans: readonly SessionScan[];
	nowMs: number;
	/** A scan older than this is `unknown`. A scan exactly this old is still known. */
	maxScanAgeMs: number;
}

export interface ConflictReport {
	/** One view per active session, sorted by session id. */
	views: SessionView[];
	/** Sorted by phase. Empty when nothing conflicts. */
	conflicts: PlanningConflict[];
}

export type ConflictWriteGate =
	| { ok: true }
	| { ok: false; code: "planning-view-unknown"; reason: UnknownViewReason | "no-active-session" };

interface PhaseGroup {
	sessionIds: Set<string>;
	plans: Map<string, Set<string>>;
}

export function detectConflicts(input: ConflictInput): ConflictReport {
	assertInput(input);
	const latest = latestScanBySession(input.scans);
	const activeSessions = new Map<string, ClassifiedSession>();
	for (const session of input.sessions) if (session.status === "active") activeSessions.set(session.sessionId, session);
	const views = [...activeSessions.keys()]
		.sort(compareText)
		.map((sessionId) => viewFor(sessionId, latest.get(sessionId), activeSessions.get(sessionId)?.activePhase ?? null, input));
	return { views, conflicts: conflictsFrom(views, input.nowMs) };
}

/** Whether a conflict-sensitive write may proceed for this session, given the views from `detectConflicts`. */
export function gateConflictSensitiveWrite(views: readonly SessionView[], sessionId: string): ConflictWriteGate {
	const view = views.find((candidate) => candidate.sessionId === sessionId);
	if (view === undefined) return { ok: false, code: "planning-view-unknown", reason: "no-active-session" };
	if (view.status === "unknown") return { ok: false, code: "planning-view-unknown", reason: view.reason };
	return { ok: true };
}

function viewFor(sessionId: string, scan: SessionScan | undefined, activePhase: string | null, input: ConflictInput): SessionView {
	if (scan === undefined) return unknown(sessionId, "no-scan");
	if (input.nowMs - scan.scannedAtMs > input.maxScanAgeMs) return unknown(sessionId, "scan-stale");
	if (!scan.result.ok) return unknown(sessionId, "scan-failed");
	if (scan.result.index.truncated) return unknown(sessionId, "scan-truncated");
	if (scan.result.index.records.some(isErrorRecord)) return unknown(sessionId, "scan-has-errors");
	return {
		sessionId,
		status: "known",
		scannedAtMs: scan.scannedAtMs,
		phases: phaseClaims(scan.result.index.records, activePhase),
	};
}

function unknown(sessionId: string, reason: UnknownViewReason): SessionView {
	return { sessionId, status: "unknown", reason };
}

/** A session claims only its active phase. Historical phases in its checkout's index are not work it is doing. */
function phaseClaims(records: readonly PlanningRecord[], activePhase: string | null): PhaseClaim[] {
	if (activePhase === null) return [];
	const plans = new Set<string>();
	for (const record of records) {
		if (isErrorRecord(record) || record.phase !== activePhase) continue;
		const identity = planIdentity(record);
		if (identity !== undefined) plans.add(identity);
	}
	return [{ phase: activePhase, plans: [...plans].sort(compareText) }];
}

/**
 * A plan's identity is the plan id its parsed content declares, so the same plan under two filenames is one plan. A document
 * whose content declares none keeps its filename-derived id. A document that is neither a plan nor declares one has none.
 */
function planIdentity(record: PlanningFileRecord): string | undefined {
	const declared = record.frontmatter?.plan;
	if (typeof declared === "string" && declared.length > 0) return declared;
	if (typeof declared === "number") return String(declared);
	return record.plan;
}

function conflictsFrom(views: readonly SessionView[], detectedAtMs: number): PlanningConflict[] {
	const groups = new Map<string, PhaseGroup>();
	for (const view of views) {
		if (view.status !== "known") continue;
		for (const claim of view.phases) {
			const group = groups.get(claim.phase) ?? { sessionIds: new Set<string>(), plans: new Map<string, Set<string>>() };
			group.sessionIds.add(view.sessionId);
			for (const plan of claim.plans) {
				const holders = group.plans.get(plan) ?? new Set<string>();
				holders.add(view.sessionId);
				group.plans.set(plan, holders);
			}
			groups.set(claim.phase, group);
		}
	}

	return [...groups]
		.filter(([, group]) => group.sessionIds.size >= 2)
		.sort(([a], [b]) => compareText(a, b))
		.map(([phase, group]): PlanningConflict => ({
			kind: PLANNING_CONFLICT,
			status: "open",
			phase,
			plans: [...group.plans]
				.filter(([, holders]) => holders.size >= 2)
				.map(([plan]) => plan)
				.sort(compareText),
			sessionIds: [...group.sessionIds].sort(compareText),
			detectedAtMs,
		}));
}

/** The most recent scan per session. A later failed scan overrides an earlier good one. */
function latestScanBySession(scans: readonly SessionScan[]): Map<string, SessionScan> {
	const latest = new Map<string, SessionScan>();
	for (const scan of scans) {
		const current = latest.get(scan.sessionId);
		if (current === undefined || scan.scannedAtMs >= current.scannedAtMs) latest.set(scan.sessionId, scan);
	}
	return latest;
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
