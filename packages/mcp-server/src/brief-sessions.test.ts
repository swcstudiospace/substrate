/**
 * The brief's live session sections (phase 67): the 1,200-character bound on every section, the empty states, the order the
 * caller gave, redaction of what other sessions wrote, and the coarse age that keeps the text stable. Pure functions: no
 * store, no clock but a number.
 */
import { describe, expect, test } from "bun:test";
import {
	BRIEF_SESSIONS_SECTION_MAX_CHARS,
	coarseAge,
	handoffsSection,
	sessionsSection,
	steeringSection,
	type BriefSteeringInput,
} from "./brief-sessions.ts";
import type { BriefSection } from "./brief-profile.ts";
import type { ContextSession, SessionContext } from "./session-context.ts";
import { defined } from "./test-support.ts";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
/** Shaped like a credential the redactor knows; never a real one. */
const SECRET = "ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";

const printed = (section: BriefSection | null): string => defined(section, "a section").lines.join("\n");

const contextSession = (n: number, overrides: Partial<ContextSession> = {}): ContextSession => ({
	session_id: `wt-${n}-${"x".repeat(40)}`,
	surface: "claude-code",
	worktree: `/w/${n}`,
	branch: `feature/${n}-${"y".repeat(50)}`,
	last_heartbeat: null,
	state: "ACTIVE",
	source: "presence",
	age_s: n * 60,
	...overrides,
});

const contextOf = (sessions: ContextSession[]): SessionContext => ({
	generated_at: new Date(NOW).toISOString(),
	repo_id: "owner/name",
	for_session: null,
	sessions,
	claims: [],
	events: [],
	handoffs: [],
	planning: [],
	truncated: { sessions: false, claims: false, events: false, handoffs: false, planning: false },
	notes: [],
});

describe("coarseAge", () => {
	test("whole minutes, hours and days, so two calls a second apart print the same text", () => {
		expect(coarseAge(0)).toBe("just now");
		expect(coarseAge(59)).toBe("just now");
		expect(coarseAge(60)).toBe("1 min ago");
		expect(coarseAge(119)).toBe("1 min ago");
		expect(coarseAge(3_599)).toBe("59 min ago");
		expect(coarseAge(3_600)).toBe("1h ago");
		expect(coarseAge(86_399)).toBe("23h ago");
		expect(coarseAge(86_400)).toBe("1d ago");
	});
});

describe("empty states", () => {
	test("a section with nothing to say is absent, not an empty heading", () => {
		expect(sessionsSection(contextOf([]))).toBeNull();
		expect(steeringSection({ sessionId: "s", state: null, steering: null, pending: [], pendingTotal: 0 })).toBeNull();
		expect(handoffsSection([], NOW)).toBeNull();
	});
});

describe("the size bound", () => {
	const bounded = (section: BriefSection | null): number => printed(section).length;

	test("a section with many long sessions stays inside 1,200 characters and counts what it left out", () => {
		const section = sessionsSection(contextOf(Array.from({ length: 20 }, (_, n) => contextSession(n))));
		expect(bounded(section)).toBeLessThanOrEqual(BRIEF_SESSIONS_SECTION_MAX_CHARS);
		const last = defined(defined(section, "sessions").lines.at(-1), "the closing line");
		expect(last).toMatch(/^… and \d+ more sessions$/);
		const kept = defined(section, "sessions").lines.filter((line) => line.startsWith("- ")).length;
		expect(kept + Number(/\d+/.exec(last)?.[0])).toBe(20);
	});

	test("the steering section is bounded the same way, directive bodies included", () => {
		const pending = Array.from({ length: 12 }, (_, n) => ({ id: `d-${n}`, action: "annotate", priority: "normal", body: "word ".repeat(100), ageS: 5 }));
		const section = steeringSection({ sessionId: "sess-a", state: "PAUSED", steering: "z".repeat(500), pending, pendingTotal: 12 });
		expect(bounded(section)).toBeLessThanOrEqual(BRIEF_SESSIONS_SECTION_MAX_CHARS);
		expect(printed(section)).toContain("12 queued directives");
		expect(printed(section)).toMatch(/… and \d+ more lines$/);
	});

	test("the handoffs section is bounded the same way", () => {
		const handoffs = Array.from({ length: 30 }, (_, n) => ({ goal: `goal ${n} ${"g".repeat(300)}`, createdAtMs: NOW - n * 1_000, verified: true }));
		const section = handoffsSection(handoffs, NOW);
		expect(bounded(section)).toBeLessThanOrEqual(BRIEF_SESSIONS_SECTION_MAX_CHARS);
		expect(printed(section)).toMatch(/… and \d+ more handoffs$/);
	});

	test("a section that fits prints every line and no closing notice", () => {
		const section = sessionsSection(contextOf([contextSession(1), contextSession(2)]));
		expect(defined(section, "sessions").lines.filter((line) => line.startsWith("- "))).toHaveLength(2);
		expect(printed(section)).not.toContain("more sessions");
	});
});

describe("order, content and safety", () => {
	test("sessions keep the digest's order and show source, surface and a coarse age", () => {
		const section = sessionsSection(
			contextOf([contextSession(2, { session_id: "first", branch: null, state: null, age_s: 120 }), contextSession(1, { session_id: "second", surface: null, source: "steering", age_s: 7_200 })]),
		);
		const lines = defined(section, "sessions").lines.filter((line) => line.startsWith("- "));
		expect(lines[0]).toBe("- first [presence, claude-code], 2 min ago");
		expect(lines[1]).toContain("- second [steering]");
		expect(lines[1]).toContain("2h ago");
	});

	test("the steering section lists the session state first and the directives as quoted data", () => {
		const input: BriefSteeringInput = {
			sessionId: "sess-a",
			state: "PAUSED",
			steering: "hold",
			pending: [{ id: "d1", action: "pause", priority: "high", body: "stop now", ageS: 300 }],
			pendingTotal: 1,
		};
		const lines = defined(steeringSection(input), "steering").lines;
		expect(lines[1]).toContain("1 queued directive for this session, described and not executed");
		expect(lines[2]).toBe("- session sess-a is PAUSED: hold");
		expect(lines[3]).toBe("- d1 pause (high, 5 min ago): stop now");
	});

	test("with a state and no pending directive the title names the state only", () => {
		const section = steeringSection({ sessionId: "sess-a", state: "ACTIVE", steering: null, pending: [], pendingTotal: 0 });
		expect(defined(section, "steering").lines[1]).toBe("Steering state of this session:");
	});

	test("handoffs mark an unverified packet and keep the caller's order", () => {
		const section = handoffsSection(
			[
				{ goal: "newest", createdAtMs: NOW - 30_000, verified: true },
				{ goal: "older", createdAtMs: NOW - 4 * 3_600_000, verified: false },
			],
			NOW,
		);
		const lines = defined(section, "handoffs").lines.filter((line) => line.startsWith("- "));
		expect(lines).toEqual(["- verified, just now: newest", "- UNVERIFIED, 4h ago: older"]);
	});

	test("text another session wrote is redacted before it reaches the brief", () => {
		const sessions = printed(sessionsSection(contextOf([contextSession(1, { branch: `branch-${SECRET}` })])));
		const steering = printed(steeringSection({ sessionId: "s", state: "ACTIVE", steering: SECRET, pending: [{ id: "d1", action: "annotate", priority: "low", body: `use ${SECRET}`, ageS: 1 }], pendingTotal: 1 }));
		const handoffs = printed(handoffsSection([{ goal: `deploy with ${SECRET}`, createdAtMs: NOW, verified: true }], NOW));
		for (const text of [sessions, steering, handoffs]) expect(text).not.toContain(SECRET);
	});
});
