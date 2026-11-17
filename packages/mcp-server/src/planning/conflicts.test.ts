/**
 * Conflict detection over presence snapshot records: a phase key and a plan key over the pairs each session touched inside the
 * TTL, within one repository, one open event per key, nothing auto-resolved, and an unknown view that takes no part and blocks
 * conflict-sensitive writes.
 */
import { describe, expect, test } from "bun:test";
import { MAX_PAYLOAD_BYTES } from "../event.ts";
import { defined } from "../test-support.ts";
import { conflictEvent, conflictIdempotencyKey, conflictOriginMs, conflictSignature, detectConflicts, gateConflictSensitiveWrite, PLANNING_CONFLICT, type ConflictInput, type PlanningConflict } from "./conflicts.ts";
import type { ClassifiedSession, PlanningReport, TouchedPair, UnknownViewReason } from "./presence.ts";

const NOW = 1_000_000;
const TTL = 30_000;
const REPO = "owner/name";

/** A touched pair observed at `observedAtMs`: a phase, and the plan it named, or null for a phase-level document. */
function pair(phase: string, plan: string | null = null, observedAtMs = NOW): TouchedPair {
	return { phase, plan, observedAtMs };
}

function session(
	sessionId: string,
	touched: TouchedPair[],
	planning: PlanningReport | undefined,
	status: "active" | "stale" = "active",
	repo: string | null = REPO,
): ClassifiedSession {
	return {
		sessionId,
		worktree: `/work/${sessionId}`,
		branch: `gsd/${sessionId}`,
		lastHeartbeatMs: NOW,
		repo,
		touched,
		status,
		ageMs: 0,
		...(planning === undefined ? {} : { planning }),
	};
}

/** A known report. Detection reads only its age and its known status: the pairs carry the claims. */
function known(scannedAtMs = NOW): PlanningReport {
	return { status: "known", scannedAtMs, phases: [] };
}

function unknown(reason: UnknownViewReason, scannedAtMs = NOW): PlanningReport {
	return { status: "unknown", scannedAtMs, reason };
}

function input(sessions: ClassifiedSession[], overrides: Partial<ConflictInput> = {}): ConflictInput {
	return { sessions, nowMs: NOW, ttlMs: TTL, ...overrides };
}

describe("detectConflicts: the phase key", () => {
	test("two sessions that touched one phase emit one open phase event naming the plans they share", () => {
		const report = detectConflicts(
			input([
				session("alpha", [pair("53", "53-01"), pair("53", "53-02")], known()),
				session("beta", [pair("53", "53-01"), pair("53", "53-03")], known()),
			]),
		);
		expect(report.conflicts).toEqual([
			{
				kind: PLANNING_CONFLICT,
				status: "open",
				repo: REPO,
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
			input([session("alpha", [pair("53", "53-01")], known()), session("beta", [pair("53", "53-02")], known())]),
		);
		expect(report.conflicts).toEqual([expect.objectContaining({ key: { by: "phase", phase: "53" }, plans: [] })]);
	});

	test("a phase-level change with no plan counts for the phase key and names no plan", () => {
		const report = detectConflicts(input([session("alpha", [pair("53")], known()), session("beta", [pair("53", "53-01")], known())]));
		expect(report.conflicts).toEqual([expect.objectContaining({ key: { by: "phase", phase: "53" }, plans: [], sessionIds: ["alpha", "beta"] })]);
	});

	test("a single session emits no conflict", () => {
		const report = detectConflicts(input([session("alpha", [pair("53", "53-01")], known())]));
		expect(report.conflicts).toEqual([]);
		expect(report.views).toEqual([expect.objectContaining({ sessionId: "alpha", status: "known" })]);
	});

	test("a session claims only what it touched: a phase its report lists but it did not touch is not a claim", () => {
		const report = detectConflicts(
			input([
				session("alpha", [pair("52", "52-01")], { status: "known", scannedAtMs: NOW, phases: [{ phase: "52", plans: ["52-01"] }, { phase: "53", plans: [] }] }),
				session("beta", [pair("53", "53-01")], known()),
			]),
		);
		expect(report.conflicts).toEqual([]);
	});

	test("conflicts are sorted: phase keys by phase, before plan keys", () => {
		const report = detectConflicts(
			input([
				session("a", [pair("54")], known()),
				session("b", [pair("54")], known()),
				session("c", [pair("53")], known()),
				session("d", [pair("53")], known()),
			]),
		);
		expect(report.conflicts.map((conflict) => conflict.key)).toEqual([
			{ by: "phase", phase: "53" },
			{ by: "phase", phase: "54" },
		]);
	});
});

describe("detectConflicts: repository identity", () => {
	test("repository names that differ only in letter case are one repository, so their shared phase conflict is found", () => {
		const report = detectConflicts(
			input([
				session("alpha", [pair("53", "53-01")], known(), "active", "SomeOrg/Repo"),
				session("beta", [pair("53", "53-01")], known(), "active", "someorg/repo"),
			]),
		);
		expect(report.conflicts).toEqual([
			expect.objectContaining({ repo: "SomeOrg/Repo", key: { by: "phase", phase: "53" }, plans: ["53-01"], sessionIds: ["alpha", "beta"] }),
		]);
	});

	test("repository names that differ only in letter case are one repository, so their shared plan conflict is found", () => {
		const report = detectConflicts(
			input([
				session("alpha", [pair("53", "shared-plan")], known(), "active", "Owner/Name"),
				session("beta", [pair("54", "shared-plan")], known(), "active", "owner/NAME"),
			]),
		);
		expect(report.conflicts).toEqual([
			expect.objectContaining({ repo: "Owner/Name", key: { by: "plan", plan: "shared-plan" }, phases: ["53", "54"], sessionIds: ["alpha", "beta"] }),
		]);
	});
});

describe("conflictSignature: repository identity", () => {
	const conflict: PlanningConflict = {
		kind: PLANNING_CONFLICT,
		status: "open",
		repo: "SomeOrg/Repo",
		key: { by: "phase", phase: "53" },
		phases: ["53"],
		plans: ["53-01"],
		sessionIds: ["alpha", "beta"],
		detectedAtMs: NOW,
	};

	test("repository names that differ only in letter case have the same signature", () => {
		expect(conflictSignature({ ...conflict, repo: "someorg/repo" })).toBe(conflictSignature(conflict));
	});
});

describe("detectConflicts: the plan key", () => {
	test("two sessions that touched a shared plan id under different phases emit one open plan event", () => {
		const report = detectConflicts(
			input([session("alpha", [pair("53", "shared-plan")], known()), session("beta", [pair("54", "shared-plan")], known())]),
		);
		expect(report.conflicts).toEqual([
			{
				kind: PLANNING_CONFLICT,
				status: "open",
				repo: REPO,
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
				session("alpha", [pair("53", "53-01")], known()),
				session("beta", [pair("53", "53-01")], known()),
				session("gamma", [pair("54", "53-01")], known()),
			]),
		);
		expect(report.conflicts.map((conflict) => conflict.key)).toEqual([
			{ by: "phase", phase: "53" },
			{ by: "plan", plan: "53-01" },
		]);
		expect(report.conflicts[1]).toMatchObject({ phases: ["53", "54"], sessionIds: ["alpha", "beta", "gamma"] });
	});

	test("different phases with different plan ids do not conflict", () => {
		const report = detectConflicts(input([session("alpha", [pair("53", "53-01")], known()), session("beta", [pair("54", "54-01")], known())]));
		expect(report.conflicts).toEqual([]);
	});
});

describe("detectConflicts: conflicts stay within one repository", () => {
	test("two repositories that touch the same phase number do not conflict", () => {
		const report = detectConflicts(
			input([
				session("alpha", [pair("53", "53-01")], known(), "active", "owner/one"),
				session("beta", [pair("53", "53-01")], known(), "active", "owner/two"),
			]),
		);
		expect(report.conflicts).toEqual([]);
		expect(report.views).toHaveLength(2);
	});

	test("a session with no repository takes no part in detection", () => {
		const report = detectConflicts(input([session("alpha", [pair("53")], known(), "active", null), session("beta", [pair("53")], known())]));
		expect(report.conflicts).toEqual([]);
		expect(report.views).toEqual([expect.objectContaining({ sessionId: "alpha", status: "known", repo: null }), expect.objectContaining({ sessionId: "beta" })]);
	});

	test("each repository's conflicts name that repository, and are sorted by it", () => {
		const report = detectConflicts(
			input([
				session("alpha", [pair("53")], known(), "active", "owner/two"),
				session("beta", [pair("53")], known(), "active", "owner/two"),
				session("gamma", [pair("53")], known(), "active", "owner/one"),
				session("delta", [pair("53")], known(), "active", "owner/one"),
			]),
		);
		expect(report.conflicts.map((conflict) => [conflict.repo, conflict.sessionIds])).toEqual([
			["owner/one", ["delta", "gamma"]],
			["owner/two", ["alpha", "beta"]],
		]);
	});
});

describe("detectConflicts: touched pairs age out at the TTL", () => {
	test("a pair older than the TTL does not count; a pair exactly the TTL old still does", () => {
		const aged = detectConflicts(input([session("alpha", [pair("53", null, NOW - TTL - 1)], known()), session("beta", [pair("53")], known())]));
		expect(aged.conflicts).toEqual([]);

		const edge = detectConflicts(input([session("alpha", [pair("53", null, NOW - TTL)], known()), session("beta", [pair("53")], known())]));
		expect(edge.conflicts).toHaveLength(1);
	});
});

describe("detectConflicts: unknown views take no part", () => {
	test("a session without a report is unknown with no-scan and is excluded", () => {
		const report = detectConflicts(input([session("alpha", [pair("53")], undefined), session("beta", [pair("53")], known())]));
		expect(report.views).toEqual([
			{ sessionId: "alpha", status: "unknown", reason: "no-scan" },
			expect.objectContaining({ sessionId: "beta", status: "known" }),
		]);
		expect(report.conflicts).toEqual([]);
	});

	test("a truncated or otherwise unknown report is excluded from detection and reports its reason", () => {
		const report = detectConflicts(input([session("alpha", [pair("53")], unknown("scan-truncated")), session("beta", [pair("53", "53-01")], known())]));
		expect(report.views).toContainEqual({ sessionId: "alpha", status: "unknown", reason: "scan-truncated" });
		expect(report.conflicts).toEqual([]);
	});

	test("a report older than the threshold is stale; exactly the threshold is still known", () => {
		const stale = detectConflicts(input([session("alpha", [pair("53")], known(NOW - TTL - 1)), session("beta", [pair("53")], known())]));
		expect(stale.views[0]).toEqual({ sessionId: "alpha", status: "unknown", reason: "scan-stale" });
		expect(stale.conflicts).toEqual([]);

		const edge = detectConflicts(input([session("alpha", [pair("53")], known(NOW - TTL)), session("beta", [pair("53")], known())]));
		expect(edge.views[0]).toMatchObject({ sessionId: "alpha", status: "known" });
		expect(edge.conflicts).toHaveLength(1);
	});

	test("a stopped session takes no part in detection and gets no view", () => {
		const report = detectConflicts(input([session("alpha", [pair("53")], known(), "stale"), session("beta", [pair("53")], known())]));
		expect(report.views.map((view) => view.sessionId)).toEqual(["beta"]);
		expect(report.conflicts).toEqual([]);
	});

	test("the write gate refuses a conflict-sensitive write from an unknown view, and allows a known one", () => {
		const report = detectConflicts(input([session("alpha", [pair("53")], unknown("scan-failed")), session("beta", [pair("53")], known())]));
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
		const snapshot = input([session("alpha", [pair("53", "53-01")], known()), session("beta", [pair("53", "53-01")], known())]);
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
		repo: REPO,
		key: { by: "phase", phase: "53" },
		phases: ["53"],
		plans: ["53-01"],
		sessionIds: ["alpha", "beta"],
		detectedAtMs: NOW,
	};

	test("names the phase and the shared plans, and is a warning on the substrate surface", () => {
		const event = conflictEvent(phaseConflict);
		expect(event).toMatchObject({ surface: "substrate", kind: "warning", repo: REPO });
		expect(event.summary).toContain("phase 53");
		expect(event.payload).toMatchObject({ kind: PLANNING_CONFLICT, key: { by: "phase", phase: "53" }, plans: ["53-01"], sessionIds: ["alpha", "beta"] });
	});

	test("names the repository the conflict is on", () => {
		expect(conflictEvent({ ...phaseConflict, repo: "owner/two" })).toMatchObject({ repo: "owner/two" });
	});

	test("caps the id lists and keeps the full counts", () => {
		const many = Array.from({ length: 40 }, (_, index) => `53-${String(index).padStart(2, "0")}`);
		const event = conflictEvent({ ...phaseConflict, plans: many });
		expect(event.payload).toMatchObject({ planCount: 40, plans: many.slice(0, 32) });
	});

	test("a plan shared across many phases caps the phases, keeps their full count, and stays inside the ledger's payload limit", () => {
		const phases = Array.from({ length: 140 }, (_, index) => `${String(index).padStart(3, "0")}-${"p".repeat(115)}`);
		const event = conflictEvent({ ...phaseConflict, key: { by: "plan", plan: "shared-plan" }, plans: ["shared-plan"], phases });
		expect(event.payload).toMatchObject({ phaseCount: 140, phases: phases.slice(0, 32) });
		expect(Buffer.byteLength(JSON.stringify(event.payload))).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
	});
});

describe("conflictIdempotencyKey, conflictOriginMs and the keyed conflictEvent", () => {
	const phaseConflict: PlanningConflict = {
		kind: PLANNING_CONFLICT,
		status: "open",
		repo: REPO,
		key: { by: "phase", phase: "53" },
		phases: ["53"],
		plans: [],
		sessionIds: ["alpha", "beta"],
		detectedAtMs: NOW,
	};

	test("the key is derived from the conflict's identity alone: the scan time does not change it, a different session set does, and the ledger accepts its shape", () => {
		const key = conflictIdempotencyKey(phaseConflict);
		expect(key).toMatch(/^planning-conflict:[0-9a-f]{40}$/);
		expect(conflictIdempotencyKey({ ...phaseConflict, detectedAtMs: NOW + 5_000 })).toBe(key);
		expect(conflictIdempotencyKey({ ...phaseConflict, repo: "Owner/Name" })).toBe(key);
		expect(conflictIdempotencyKey({ ...phaseConflict, sessionIds: ["alpha", "beta", "gamma"] })).not.toBe(key);
		expect(conflictIdempotencyKey({ ...phaseConflict, key: { by: "phase", phase: "54" }, phases: ["54"] })).not.toBe(key);
	});

	test("the origin is the latest touch on the conflict's key across its sessions, and does not move with the scan time", () => {
		const first = detectConflicts(input([session("alpha", [pair("53", null, NOW - 20_000), pair("54", null, NOW - 1_000)], known()), session("beta", [pair("53", null, NOW - 5_000)], known())]));
		const [conflict] = first.conflicts;
		expect(conflict).toBeDefined();
		expect(conflictOriginMs(defined(conflict), first.views)).toBe(NOW - 5_000);

		const later = detectConflicts(input([session("alpha", [pair("53", null, NOW - 20_000), pair("54", null, NOW - 1_000)], known(NOW + 2_000)), session("beta", [pair("53", null, NOW - 5_000)], known(NOW + 2_000))], { nowMs: NOW + 2_000 }));
		expect(conflictOriginMs(defined(later.conflicts[0]), later.views)).toBe(NOW - 5_000);
	});

	test("a plan-keyed conflict takes its origin from the touches of that plan id", () => {
		const report = detectConflicts(
			input([session("alpha", [pair("53", "shared", NOW - 9_000)], known()), session("beta", [pair("54", "shared", NOW - 3_000), pair("54", "other", NOW - 1_000)], known())]),
		);
		const [conflict] = report.conflicts.filter((candidate) => candidate.key.by === "plan");
		expect(conflictOriginMs(defined(conflict), report.views)).toBe(NOW - 3_000);
	});

	test("a keyed event carries the key and the origin as its ts; an unkeyed one carries neither", () => {
		const keyed = conflictEvent(phaseConflict, NOW - 5_000);
		expect(keyed).toMatchObject({ idempotency_key: conflictIdempotencyKey(phaseConflict), ts: new Date(NOW - 5_000).toISOString() });
		const plain = conflictEvent(phaseConflict);
		expect(plain.idempotency_key).toBeUndefined();
		expect(plain.ts).toBeUndefined();
	});
});
