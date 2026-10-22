/**
 * Conflict detection: keyed on parsed phase and plan ids, one event per conflicting phase, nothing
 * auto-resolved, and an unknown view blocks conflict-sensitive writes until a full scan completes.
 */
import { describe, expect, test } from "bun:test";
import {
	detectConflicts,
	gateConflictSensitiveWrite,
	PLANNING_CONFLICT,
	type ConflictInput,
	type SessionScan,
} from "./conflicts.ts";
import type { PlanningErrorRecord, PlanningFileRecord, PlanningRecord } from "./index.ts";
import type { ClassifiedSession } from "./presence.ts";

const NOW = 1_000_000;
const MAX_AGE = 30_000;
const HASH = "a".repeat(64);

function session(sessionId: string, status: "active" | "stale" = "active", activePhase: string | null = "53"): ClassifiedSession {
	return {
		sessionId,
		worktree: `/work/${sessionId}`,
		branch: `gsd/${sessionId}`,
		activePhase,
		lastHeartbeatMs: NOW,
		status,
		ageMs: 0,
	};
}

function planDoc(path: string, phase: string, plan: string): PlanningFileRecord {
	return { path, kind: "phase", sha256: HASH, bytes: 10, phase, plan };
}

function phaseDoc(path: string, phase: string): PlanningFileRecord {
	return { path, kind: "phase", sha256: HASH, bytes: 10, phase };
}

function scanOk(sessionId: string, scannedAtMs: number, records: PlanningRecord[], truncated = false): SessionScan {
	return { sessionId, scannedAtMs, result: { ok: true, index: { records, truncated } } };
}

function scanFailed(sessionId: string, scannedAtMs: number): SessionScan {
	return { sessionId, scannedAtMs, result: { ok: false, code: "planning-dir-unavailable" } };
}

function input(sessions: ClassifiedSession[], scans: SessionScan[], overrides: Partial<ConflictInput> = {}): ConflictInput {
	return { sessions, scans, nowMs: NOW, maxScanAgeMs: MAX_AGE, ...overrides };
}

describe("detectConflicts: keyed on parsed phase and plan ids", () => {
	test("two sessions on the same phase and plan produce one conflict event carrying both ids", () => {
		const report = detectConflicts(
			input(
				[session("worker-a"), session("worker-b")],
				[
					scanOk("worker-a", NOW, [planDoc(".planning/phases/53-x/53-01-PLAN.md", "53", "53-01-PLAN")]),
					scanOk("worker-b", NOW, [planDoc("/other/.planning/phases/53-x/53-01-PLAN.md", "53", "53-01-PLAN")]),
				],
			),
		);

		expect(report.conflicts).toEqual([
			{
				kind: PLANNING_CONFLICT,
				status: "open",
				phase: "53",
				plans: ["53-01-PLAN"],
				sessionIds: ["worker-a", "worker-b"],
				detectedAtMs: NOW,
			},
		]);
	});

	test("the same phase with different plans is one phase conflict with no shared plan", () => {
		const report = detectConflicts(
			input(
				[session("worker-a"), session("worker-b")],
				[
					scanOk("worker-a", NOW, [planDoc("p/53-01-PLAN.md", "53", "53-01-PLAN")]),
					scanOk("worker-b", NOW, [planDoc("p/53-02-PLAN.md", "53", "53-02-PLAN")]),
				],
			),
		);
		expect(report.conflicts).toHaveLength(1);
		expect(report.conflicts[0]).toMatchObject({ phase: "53", plans: [], sessionIds: ["worker-a", "worker-b"] });
	});

	test("the same path with different parsed phases does not conflict: the key is the phase field, not the path", () => {
		const report = detectConflicts(
			input(
				[session("worker-a"), session("worker-b", "active", "54")],
				[
					scanOk("worker-a", NOW, [phaseDoc("shared/STATE.md", "53")]),
					scanOk("worker-b", NOW, [phaseDoc("shared/STATE.md", "54")]),
				],
			),
		);
		expect(report.conflicts).toEqual([]);
	});

	test("different phases with different documents do not conflict", () => {
		const report = detectConflicts(
			input(
				[session("worker-a", "active", "52"), session("worker-b", "active", "53")],
				[scanOk("worker-a", NOW, [phaseDoc("a.md", "52")]), scanOk("worker-b", NOW, [phaseDoc("b.md", "53")])],
			),
		);
		expect(report.conflicts).toEqual([]);
	});

	test("conflicts are reported once per phase, sorted by phase", () => {
		const report = detectConflicts(
			input(
				[session("w1", "active", "53"), session("w2", "active", "53"), session("w3", "active", "54"), session("w4", "active", "54")],
				[
					scanOk("w1", NOW, [phaseDoc("a", "53"), phaseDoc("b", "54")]),
					scanOk("w2", NOW, [phaseDoc("c", "53")]),
					scanOk("w3", NOW, [phaseDoc("d", "54")]),
					scanOk("w4", NOW, [phaseDoc("e", "54")]),
				],
			),
		);
		expect(report.conflicts.map((conflict) => [conflict.phase, conflict.sessionIds])).toEqual([
			["53", ["w1", "w2"]],
			["54", ["w3", "w4"]],
		]);
	});

	test("a session claims only its active phase: shared historical phases produce no conflict", () => {
		const historical = [phaseDoc("old-52.md", "52"), phaseDoc("old-53.md", "53"), phaseDoc("old-54.md", "54")];
		const report = detectConflicts(
			input(
				[session("worker-a", "active", "53"), session("worker-b", "active", "54")],
				[scanOk("worker-a", NOW, historical), scanOk("worker-b", NOW, historical)],
			),
		);
		expect(report.conflicts).toEqual([]);
		expect(report.views).toEqual([
			{ sessionId: "worker-a", status: "known", scannedAtMs: NOW, phases: [{ phase: "53", plans: [] }] },
			{ sessionId: "worker-b", status: "known", scannedAtMs: NOW, phases: [{ phase: "54", plans: [] }] },
		]);
	});
});

describe("detectConflicts: nothing is auto-resolved", () => {
	test("a conflict stays open across detections, and both sessions stay active and known", () => {
		const sessions = [session("worker-a"), session("worker-b")];
		const scans = [scanOk("worker-a", NOW, [phaseDoc("a", "53")]), scanOk("worker-b", NOW, [phaseDoc("b", "53")])];

		const first = detectConflicts(input(sessions, scans));
		const second = detectConflicts(input(sessions, scans));

		expect(second).toEqual(first);
		expect(first.conflicts).toHaveLength(1);
		expect(first.conflicts[0]?.status).toBe("open");
		expect(first.views.map((view) => view.status)).toEqual(["known", "known"]);
	});

	test("stale sessions take no part in detection and get no view", () => {
		const report = detectConflicts(
			input(
				[session("worker-a"), session("worker-b", "stale")],
				[scanOk("worker-a", NOW, [phaseDoc("a", "53")]), scanOk("worker-b", NOW, [phaseDoc("b", "53")])],
			),
		);
		expect(report.conflicts).toEqual([]);
		expect(report.views.map((view) => view.sessionId)).toEqual(["worker-a"]);
	});
});

describe("planning view status and the conflict-sensitive write gate", () => {
	test("a failed scan is unknown and blocks writes until a full scan completes", () => {
		const sessions = [session("worker-a")];
		const failed = detectConflicts(input(sessions, [scanFailed("worker-a", NOW)]));
		expect(failed.views).toEqual([{ sessionId: "worker-a", status: "unknown", reason: "scan-failed" }]);
		expect(gateConflictSensitiveWrite(failed.views, "worker-a")).toEqual({
			ok: false,
			code: "planning-view-unknown",
			reason: "scan-failed",
		});

		const repaired = detectConflicts(
			input(sessions, [scanFailed("worker-a", NOW - 10), scanOk("worker-a", NOW, [phaseDoc("a", "53")])]),
		);
		expect(repaired.views[0]?.status).toBe("known");
		expect(gateConflictSensitiveWrite(repaired.views, "worker-a")).toEqual({ ok: true });
	});

	test("a later failed scan overrides an earlier good one", () => {
		const report = detectConflicts(
			input([session("worker-a")], [scanOk("worker-a", NOW - 10, [phaseDoc("a", "53")]), scanFailed("worker-a", NOW)]),
		);
		expect(report.views[0]).toMatchObject({ status: "unknown", reason: "scan-failed" });
	});

	test("a truncated scan is unknown", () => {
		const report = detectConflicts(input([session("worker-a")], [scanOk("worker-a", NOW, [phaseDoc("a", "53")], true)]));
		expect(report.views[0]).toMatchObject({ status: "unknown", reason: "scan-truncated" });
	});

	test("a scan holding an unreadable record is unknown, because that record cannot be keyed", () => {
		const unreadable: PlanningErrorRecord = {
			path: ".planning/phases/53-x/53-02-PLAN.md",
			sha256: null,
			bytes: null,
			error: { code: "too-large", detail: "exceeds 262144 bytes" },
		};
		const report = detectConflicts(input([session("worker-a")], [scanOk("worker-a", NOW, [unreadable])]));
		expect(report.views[0]).toMatchObject({ status: "unknown", reason: "scan-has-errors" });
	});

	test("a scan older than the threshold is unknown; one exactly at the threshold is still known", () => {
		const old = detectConflicts(input([session("worker-a")], [scanOk("worker-a", NOW - MAX_AGE - 1, [phaseDoc("a", "53")])]));
		expect(old.views[0]).toMatchObject({ status: "unknown", reason: "scan-stale" });

		const edge = detectConflicts(input([session("worker-a")], [scanOk("worker-a", NOW - MAX_AGE, [phaseDoc("a", "53")])]));
		expect(edge.views[0]?.status).toBe("known");
	});

	test("a session with no scan is unknown and cannot be a conflict party", () => {
		const report = detectConflicts(
			input([session("worker-a"), session("worker-b")], [scanOk("worker-b", NOW, [phaseDoc("b", "53")])]),
		);
		expect(report.views).toEqual([
			{ sessionId: "worker-a", status: "unknown", reason: "no-scan" },
			{ sessionId: "worker-b", status: "known", scannedAtMs: NOW, phases: [{ phase: "53", plans: [] }] },
		]);
		expect(report.conflicts).toEqual([]);
	});

	test("a session that is not active has no view, and its writes are refused as not active", () => {
		const report = detectConflicts(input([session("worker-a", "stale")], []));
		expect(gateConflictSensitiveWrite(report.views, "worker-a")).toEqual({
			ok: false,
			code: "planning-view-unknown",
			reason: "no-active-session",
		});
	});

	test("invalid detection bounds are rejected", () => {
		expect(() => detectConflicts(input([], [], { maxScanAgeMs: 0 }))).toThrow(RangeError);
		expect(() => detectConflicts(input([], [], { nowMs: Number.NaN }))).toThrow(RangeError);
	});
});
