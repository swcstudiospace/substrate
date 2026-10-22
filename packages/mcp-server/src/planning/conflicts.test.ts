/**
 * Conflict detection over presence snapshot records: a phase key and a plan key, one open event per key, nothing auto-resolved,
 * and an unknown view that takes no part and blocks conflict-sensitive writes.
 */
import { describe, expect, test } from "bun:test";
import {
	conflictEvent,
	detectConflicts,
	gateConflictSensitiveWrite,
	PLANNING_CONFLICT,
	type ConflictInput,
	type PlanningConflict,
} from "./conflicts.ts";
import type { ClassifiedSession, PlanningReport, UnknownViewReason } from "./presence.ts";

const NOW = 1_000_000;
const MAX_AGE = 30_000;

function session(sessionId: string, activePhase: string | null, planning: PlanningReport | undefined, status: "active" | "stale" = "active"): ClassifiedSession {
	return {
		sessionId,
		worktree: `/work/${sessionId}`,
		branch: `gsd/${sessionId}`,
		activePhase,
		lastHeartbeatMs: NOW,
		status,
		ageMs: 0,
		...(planning === undefined ? {} : { planning }),
	};
}

/** A known report over `phases`, each entry a phase and the plan ids its index holds under it. */
function known(phases: Array<[string, string[]]>, scannedAtMs = NOW): PlanningReport {
	return { status: "known", scannedAtMs, phases: phases.map(([phase, plans]) => ({ phase, plans })) };
}

function unknown(reason: UnknownViewReason, scannedAtMs = NOW): PlanningReport {
	return { status: "unknown", scannedAtMs, reason };
}

function input(sessions: ClassifiedSession[], overrides: Partial<ConflictInput> = {}): ConflictInput {
	return { sessions, nowMs: NOW, maxScanAgeMs: MAX_AGE, ...overrides };
}

describe("detectConflicts: the phase key", () => {
	test("two sessions on the same active phase emit one open phase event naming the plans they share", () => {
		const report = detectConflicts(
			input([
				session("alpha", "53", known([["53", ["53-01", "53-02"]]])),
				session("beta", "53", known([["53", ["53-01", "53-03"]]])),
			]),
		);
		expect(report.conflicts).toEqual([
			{
				kind: PLANNING_CONFLICT,
				status: "open",
				key: { by: "phase", phase: "53" },
				phases: ["53"],
				plans: ["53-01"],
				sessionIds: ["alpha", "beta"],
				detectedAtMs: NOW,
			},
		]);
	});

	test("the same phase with no shared plan is one phase event with no plans named", () => {
		const report = detectConflicts(
			input([session("alpha", "53", known([["53", ["53-01"]]])), session("beta", "53", known([["53", ["53-02"]]]))]),
		);
		expect(report.conflicts).toEqual([expect.objectContaining({ key: { by: "phase", phase: "53" }, plans: [] })]);
	});

	test("a single session emits no conflict", () => {
		const report = detectConflicts(input([session("alpha", "53", known([["53", ["53-01"]]]))]));
		expect(report.conflicts).toEqual([]);
		expect(report.views).toEqual([expect.objectContaining({ sessionId: "alpha", status: "known" })]);
	});

	test("a session claims only its active phase: a phase its index merely contains is not a claim", () => {
		const report = detectConflicts(
			input([session("alpha", "53", known([["52", ["52-01"]], ["53", []]])), session("beta", "52", known([["52", ["52-01"]]]))]),
		);
		expect(report.conflicts).toEqual([]);
	});

	test("conflicts are sorted: phase keys by phase, before plan keys", () => {
		const report = detectConflicts(
			input([
				session("a", "54", known([["54", []]])),
				session("b", "54", known([["54", []]])),
				session("c", "53", known([["53", []]])),
				session("d", "53", known([["53", []]])),
			]),
		);
		expect(report.conflicts.map((conflict) => conflict.key)).toEqual([
			{ by: "phase", phase: "53" },
			{ by: "phase", phase: "54" },
		]);
	});
});

describe("detectConflicts: the plan key", () => {
	test("two sessions on different active phases that share a plan id emit one open plan event", () => {
		const report = detectConflicts(
			input([session("alpha", "53", known([["53", ["shared-plan"]]])), session("beta", "54", known([["54", ["shared-plan"]]]))]),
		);
		expect(report.conflicts).toEqual([
			{
				kind: PLANNING_CONFLICT,
				status: "open",
				key: { by: "plan", plan: "shared-plan" },
				phases: ["53", "54"],
				plans: ["shared-plan"],
				sessionIds: ["alpha", "beta"],
				detectedAtMs: NOW,
			},
		]);
	});

	test("a plan shared inside one phase is covered by that phase's event and gets no second event", () => {
		const report = detectConflicts(
			input([
				session("alpha", "53", known([["53", ["53-01"]]])),
				session("beta", "53", known([["53", ["53-01"]]])),
				session("gamma", "54", known([["54", ["53-01"]]])),
			]),
		);
		expect(report.conflicts.map((conflict) => conflict.key)).toEqual([
			{ by: "phase", phase: "53" },
			{ by: "plan", plan: "53-01" },
		]);
		expect(report.conflicts[1]).toMatchObject({ phases: ["53", "54"], sessionIds: ["alpha", "beta", "gamma"] });
	});

	test("different phases with different plan ids do not conflict", () => {
		const report = detectConflicts(
			input([session("alpha", "53", known([["53", ["53-01"]]])), session("beta", "54", known([["54", ["54-01"]]]))]),
		);
		expect(report.conflicts).toEqual([]);
	});
});

describe("detectConflicts: unknown views take no part", () => {
	test("a session without a report is unknown with no-scan and is excluded", () => {
		const report = detectConflicts(input([session("alpha", "53", undefined), session("beta", "53", known([["53", []]]))]));
		expect(report.views).toEqual([
			{ sessionId: "alpha", status: "unknown", reason: "no-scan" },
			expect.objectContaining({ sessionId: "beta", status: "known" }),
		]);
		expect(report.conflicts).toEqual([]);
	});

	test("a truncated or otherwise unknown report is excluded from detection and reports its reason", () => {
		const report = detectConflicts(
			input([session("alpha", "53", unknown("scan-truncated")), session("beta", "53", known([["53", ["53-01"]]]))]),
		);
		expect(report.views).toContainEqual({ sessionId: "alpha", status: "unknown", reason: "scan-truncated" });
		expect(report.conflicts).toEqual([]);
	});

	test("a report older than the threshold is stale; exactly the threshold is still known", () => {
		const stale = detectConflicts(input([session("alpha", "53", known([["53", []]], NOW - MAX_AGE - 1)), session("beta", "53", known([["53", []]]))]));
		expect(stale.views[0]).toEqual({ sessionId: "alpha", status: "unknown", reason: "scan-stale" });
		expect(stale.conflicts).toEqual([]);

		const edge = detectConflicts(input([session("alpha", "53", known([["53", []]], NOW - MAX_AGE)), session("beta", "53", known([["53", []]]))]));
		expect(edge.views[0]).toMatchObject({ sessionId: "alpha", status: "known" });
		expect(edge.conflicts).toHaveLength(1);
	});

	test("a stopped session takes no part in detection and gets no view", () => {
		const report = detectConflicts(input([session("alpha", "53", known([["53", []]]), "stale"), session("beta", "53", known([["53", []]]))]));
		expect(report.views.map((view) => view.sessionId)).toEqual(["beta"]);
		expect(report.conflicts).toEqual([]);
	});

	test("the write gate refuses a conflict-sensitive write from an unknown view, and allows a known one", () => {
		const report = detectConflicts(input([session("alpha", "53", unknown("scan-failed")), session("beta", "53", known([["53", []]]))]));
		expect(gateConflictSensitiveWrite(report.views, "alpha")).toEqual({ ok: false, code: "planning-view-unknown", reason: "scan-failed" });
		expect(gateConflictSensitiveWrite(report.views, "beta")).toEqual({ ok: true });
		expect(gateConflictSensitiveWrite(report.views, "gamma")).toEqual({
			ok: false,
			code: "planning-view-unknown",
			reason: "no-active-session",
		});
	});
});

describe("detectConflicts: nothing is auto-resolved", () => {
	test("a conflict stays open across detections of the same state", () => {
		const snapshot = input([session("alpha", "53", known([["53", ["53-01"]]])), session("beta", "53", known([["53", ["53-01"]]]))]);
		const first = detectConflicts(snapshot);
		const second = detectConflicts(snapshot);
		expect(second.conflicts).toEqual(first.conflicts);
		expect(second.conflicts.every((conflict) => conflict.status === "open")).toBe(true);
		expect(second.views.every((view) => view.status === "known")).toBe(true);
	});
});

describe("conflictEvent", () => {
	const phaseConflict: PlanningConflict = {
		kind: PLANNING_CONFLICT,
		status: "open",
		key: { by: "phase", phase: "53" },
		phases: ["53"],
		plans: ["53-01"],
		sessionIds: ["alpha", "beta"],
		detectedAtMs: NOW,
	};

	test("names the phase and the shared plans, and is a warning on the substrate surface", () => {
		const event = conflictEvent(phaseConflict, "owner/name");
		expect(event).toMatchObject({ surface: "substrate", kind: "warning", repo: "owner/name" });
		expect(event.summary).toContain("phase 53");
		expect(event.payload).toMatchObject({ kind: PLANNING_CONFLICT, key: { by: "phase", phase: "53" }, plans: ["53-01"], sessionIds: ["alpha", "beta"] });
	});

	test("names no repo when the origin is unknown", () => {
		expect(conflictEvent(phaseConflict, null)).not.toHaveProperty("repo");
	});

	test("caps the id lists and keeps the full counts", () => {
		const many = Array.from({ length: 40 }, (_, index) => `53-${String(index).padStart(2, "0")}`);
		const event = conflictEvent({ ...phaseConflict, plans: many }, null);
		expect(event.payload).toMatchObject({ planCount: 40, plans: many.slice(0, 32) });
	});
});
