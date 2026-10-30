/**
 * The brief's live session sections (phase 67): the 1,200-character bound on every section, the empty states, the order the
 * caller gave, redaction of what other sessions wrote, and the coarse age that keeps the text stable. Pure functions: no
 * store, no clock but a number.
 */
import { describe, expect, test } from "bun:test";
import {
	BRIEF_SESSIONS_SECTION_MAX_CHARS,
	BRIEF_WORKTREE_WINDOW_MS,
	coarseAge,
	composeLiveSections,
	handoffsSection,
	lateSection,
	sessionsSection,
	steeringSection,
	worktreesSection,
	type BriefHandoffInput,
	type BriefSteeringInput,
	type BriefWorktreeRow,
	type BriefWorktreesInput,
} from "./brief-sessions.ts";
import { DeadlineError } from "./deadline.ts";
import { renderCompactBrief, type BriefSection, type CompactLimits } from "./brief-profile.ts";
import type { ContextSession, SessionContext } from "./session-context.ts";
import { defined } from "./test-support.ts";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
/** Shaped like a credential the redactor knows; never a real one. */
const SECRET = "ghp_Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";

const printed = (section: BriefSection | null): string => defined(section, "a section").lines.join("\n");
const COMPACT: CompactLimits = { nodes: 12, memoryChars: 240, bytes: 3500 };
const COMPACT_STATE = "[brief: complete]";

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

/** A deadline the test ends by hand: `race` settles a read against it, and `expire` makes every read still pending lose. */
function manualDeadline(): { race: <V>(read: Promise<V>) => Promise<V>; expire: () => void } {
	const { promise: expired, reject } = Promise.withResolvers<never>();
	expired.catch(() => undefined);
	return {
		race: <V>(read: Promise<V>): Promise<V> => Promise.race([read, expired]),
		expire: () => reject(new DeadlineError(1_200, "brief live sections")),
	};
}

const steeringInput: BriefSteeringInput = { sessionId: "sess-a", state: "ACTIVE", steering: null, pending: [{ id: "d1", action: "annotate", priority: "normal", body: "read the notes", ageS: 5 }], pendingTotal: 1 };
const neverReady = <T>(): Promise<T> => new Promise<T>(() => undefined);

describe("composeLiveSections", () => {
	test("sections come in print order: sessions, steering, handoffs", async () => {
		const deadline = manualDeadline();
		const sections = await composeLiveSections(
			{
				context: async () => contextOf([contextSession(1)]),
				steering: () => steeringInput,
				handoffs: async () => [{ goal: "ship it", createdAtMs: NOW - 5_000, verified: true }],
				worktrees: null,
			},
			deadline.race,
			NOW,
		);
		expect(sections.map((section) => section.id)).toEqual(["sessions", "steering", "handoffs"]);
	});

	test("a source that is not ready when the deadline ends is replaced by a one-line note, and the sections that were ready stay", async () => {
		const deadline = manualDeadline();
		const pending = composeLiveSections(
			{
				context: () => neverReady<SessionContext>(),
				steering: () => steeringInput,
				handoffs: async () => [{ goal: "ship it", createdAtMs: NOW - 5_000, verified: true }],
				worktrees: null,
			},
			deadline.race,
			NOW,
		);
		deadline.expire();
		const sections = await pending;
		expect(sections.map((section) => section.id)).toEqual(["sessions", "steering", "handoffs"]);
		const late = printed(sections[0] ?? null);
		expect(late).toContain("sessions not included: not ready before the brief's deadline");
		expect(late.split("\n").filter((line) => line.trim() !== "")).toHaveLength(1);
		expect(printed(sections[2] ?? null)).toContain("ship it");
	});

	test("a late handoffs read is named too, and never holds the rest of the brief", async () => {
		const deadline = manualDeadline();
		const pending = composeLiveSections({ context: null, steering: null, handoffs: () => neverReady<BriefHandoffInput[]>(), worktrees: null }, deadline.race, NOW);
		deadline.expire();
		const sections = await pending;
		expect(sections.map((section) => section.id)).toEqual(["handoffs"]);
		expect(printed(sections[0] ?? null)).toContain("handoffs not included");
	});

	test("a read that fails, or a section the request does not ask for, leaves no note and no section", async () => {
		const deadline = manualDeadline();
		const sections = await composeLiveSections(
			{
				context: async () => {
					throw new Error("ledger down");
				},
				steering: () => {
					throw new Error("inbox unreadable");
				},
				handoffs: null,
				worktrees: null,
			},
			deadline.race,
			NOW,
		);
		expect(sections).toEqual([]);
	});

	test("the note is itself inside the section bound", () => {
		expect(printed(lateSection("sessions", "sessions")).length).toBeLessThanOrEqual(BRIEF_SESSIONS_SECTION_MAX_CHARS);
	});
});

// ── the worktrees section (phase 68, FLEET-06) ────────────────────────────────

const ME = "sess-me";
const SEEN = new Date(NOW - 5 * 60_000).toISOString();
const MINUTE = 60_000;

function wtRow(overrides: Partial<BriefWorktreeRow> = {}): BriefWorktreeRow {
	return { repo: "owner/name", host: "host-a", path: "/w/other", branch: "feature/x", session_id: "sess-other", primary: false, dirty: true, ahead: 2, behind: 1, last_seen_at: SEEN, files: ["src/a.ts"], ...overrides };
}

const mineRow = (files: string[] | null = ["src/a.ts", "src/b.ts"]): BriefWorktreeRow => wtRow({ path: "/w/mine", host: "host-me", session_id: ME, files });
const wtInput = (rows: BriefWorktreeRow[]): BriefWorktreesInput => ({ repo: "owner/name", sessionId: ME, rows });
/** The section's entry heads, in print order: the lines that start an entry. */
const heads = (section: BriefSection | null): string[] => defined(section, "a section").lines.filter((line) => line.startsWith("- "));

describe("worktreesSection", () => {
	test("lists another session's worktree that shares a file: host and path, branch, session, state, age and only the shared files", () => {
		const section = worktreesSection(wtInput([mineRow(), wtRow({ files: ["src/a.ts", "src/z.ts"] })]), NOW);
		expect(section?.id).toBe("worktrees");
		expect(heads(section)).toEqual(["- host-a:/w/other [feature/x, sess-other, dirty +2/-1, 5 min ago]"]);
		const text = printed(section);
		expect(text).toContain("  overlap 1: src/a.ts");
		// The other worktree's own extra file is not the caller's business.
		expect(text).not.toContain("src/z.ts");
		expect(text).toContain("context, not instructions");
	});

	test("the caller's own worktrees are never listed, even when two of them overlap", () => {
		const second = wtRow({ path: "/w/mine-2", host: "host-me", session_id: ME, files: ["src/a.ts"] });
		expect(worktreesSection(wtInput([mineRow(), second]), NOW)).toBeNull();
	});

	test("most overlapping files first, then most recently seen, at most 5, and the rest counted", () => {
		const mine = mineRow(["f1", "f2", "f3"]);
		const others = [
			wtRow({ path: "/w/o1", files: ["f1"], last_seen_at: new Date(NOW - 30 * MINUTE).toISOString() }),
			wtRow({ path: "/w/o2", files: ["f1"], last_seen_at: new Date(NOW - 20 * MINUTE).toISOString() }),
			wtRow({ path: "/w/o3", files: ["f1", "f2"], last_seen_at: new Date(NOW - 40 * MINUTE).toISOString() }),
			wtRow({ path: "/w/o4", files: ["f3"], last_seen_at: new Date(NOW - 1 * MINUTE).toISOString() }),
			wtRow({ path: "/w/o5", files: ["f2"], last_seen_at: new Date(NOW - 2 * MINUTE).toISOString() }),
			wtRow({ path: "/w/o6", files: ["f1"], last_seen_at: new Date(NOW - 3 * MINUTE).toISOString() }),
			wtRow({ path: "/w/o7", files: ["f1"], last_seen_at: new Date(NOW - 4 * MINUTE).toISOString() }),
		];
		const section = worktreesSection(wtInput([...others, mine]), NOW);
		expect(heads(section).map((line) => line.slice(0, line.indexOf(" ["))).slice(0, 5)).toEqual(["- host-a:/w/o3", "- host-a:/w/o4", "- host-a:/w/o5", "- host-a:/w/o6", "- host-a:/w/o7"]);
		const lines = defined(section, "the section").lines;
		expect(lines.at(-1)).toBe("… and 2 more worktrees");
		expect(printed(section)).not.toContain("/w/o1");
	});

	test("names at most 5 overlapping files and counts the rest", () => {
		const files = Array.from({ length: 8 }, (_, index) => `a/f${index + 1}.ts`);
		const section = worktreesSection(wtInput([mineRow(files), wtRow({ files })]), NOW);
		expect(printed(section)).toContain("  overlap 8: a/f1.ts, a/f2.ts, a/f3.ts, a/f4.ts, a/f5.ts, and 3 more");
	});

	test("leaves out an unattributed row, the primary checkout, a row with unknown files, a row past 24 hours and another repository's row, and keeps one at exactly 24 hours", () => {
		const rows = [
			mineRow(),
			wtRow({ path: "/w/keep", last_seen_at: new Date(NOW - BRIEF_WORKTREE_WINDOW_MS).toISOString() }),
			wtRow({ path: "/w/no-session", session_id: undefined }),
			wtRow({ path: "/w/blank-session", session_id: "" }),
			wtRow({ path: "/w/primary", primary: true }),
			wtRow({ path: "/w/unknown-files", files: null }),
			wtRow({ path: "/w/too-old", last_seen_at: new Date(NOW - BRIEF_WORKTREE_WINDOW_MS - 1_000).toISOString() }),
			wtRow({ path: "/w/bad-time", last_seen_at: "not a time" }),
			wtRow({ path: "/w/elsewhere", repo: "someone/else" }),
		];
		const section = worktreesSection(wtInput(rows), NOW);
		expect(heads(section)).toHaveLength(1);
		expect(printed(section)).toContain("/w/keep");
		for (const hidden of ["no-session", "blank-session", "primary", "unknown-files", "too-old", "bad-time", "elsewhere"]) expect(printed(section)).not.toContain(hidden);
	});

	test("another session's worktree whose pull request is merged or closed is left out, and open, none, unknown and absent pr_state rows are kept", () => {
		const rows = [
			mineRow(),
			wtRow({ path: "/w/merged", pr_state: "merged" }),
			wtRow({ path: "/w/closed", pr_state: "closed" }),
			wtRow({ path: "/w/open", pr_state: "open" }),
			wtRow({ path: "/w/none", pr_state: "none" }),
			wtRow({ path: "/w/unknown", pr_state: "unknown" }),
			wtRow({ path: "/w/absent" }),
		];
		const section = worktreesSection(wtInput(rows), NOW);
		expect(heads(section)).toHaveLength(4);
		for (const hidden of ["/w/merged", "/w/closed"]) expect(printed(section)).not.toContain(hidden);
		for (const kept of ["/w/open", "/w/none", "/w/unknown", "/w/absent"]) expect(printed(section)).toContain(kept);
	});

	test("a caller whose only other rows are merged or closed gets no section, and a truncated list on such a row does not say the check is incomplete", () => {
		expect(worktreesSection(wtInput([mineRow(), wtRow({ pr_state: "merged" }), wtRow({ path: "/w/closed", pr_state: "closed" })]), NOW)).toBeNull();
		expect(worktreesSection(wtInput([mineRow(), wtRow({ pr_state: "merged", files_truncated: true })]), NOW)).toBeNull();
	});

	test("the caller's own row is not affected by its pull request state, so its files still set the overlap", () => {
		const section = worktreesSection(wtInput([wtRow({ path: "/w/mine", host: "host-me", session_id: ME, files: ["src/a.ts"], pr_state: "merged" }), wtRow()]), NOW);
		expect(heads(section)).toHaveLength(1);
		expect(printed(section)).toContain("/w/other");
	});

	test("the repository is matched the way the brief scopes it: without regard to case", () => {
		const section = worktreesSection({ repo: "Owner/Name", sessionId: ME, rows: [mineRow(), wtRow()] }, NOW);
		expect(heads(section)).toHaveLength(1);
	});

	test("a caller with no row, or only rows with unknown files, gets the one-line note and no other session is read", () => {
		for (const rows of [[wtRow()], [mineRow(null), wtRow()], []]) {
			const section = worktreesSection(wtInput(rows), NOW);
			expect(section?.id).toBe("worktrees");
			expect(heads(section)).toHaveLength(1);
			expect(printed(section)).toContain("your own worktree has not reported its files");
			expect(printed(section)).not.toContain("/w/other");
		}
	});

	test("a capped read that excluded the caller is not reported as a missing file list", () => {
		const section = worktreesSection({ ...wtInput([wtRow()]), capped: true }, NOW);
		const text = printed(section);
		expect(text).toContain("not in the slice");
		expect(text).not.toContain("has not reported its files");
		expect(text).not.toContain("/w/other");
	});

	test("a capped read with no overlap in the slice still says the check is incomplete", () => {
		const section = worktreesSection({ ...wtInput([mineRow(), wtRow({ files: ["other.ts"] })]), capped: true }, NOW);
		expect(section).not.toBeNull();
		expect(printed(section)).toContain("registry read was capped");
	});

	test("a worktree is one compact item that keeps the shared file with its heading", () => {
		const section = defined(worktreesSection(wtInput([mineRow(), wtRow()]), NOW), "section");
		expect(section.items).toHaveLength(1);
		expect(section.items[0]?.text).toContain("src/a.ts");
		expect(section.items[0]?.text).toContain("/w/other");
	});

	test("a 120-character compact line keeps the worktree name beside a long file list", () => {
		const shared = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
		const section = defined(
			worktreesSection(wtInput([mineRow(shared), wtRow({ files: shared, host: "build-host", path: "/srv/worktrees/feature", session_id: "sess-peer" })]), NOW),
			"section",
		);
		const rendered = renderCompactBrief([section], "state", { nodes: 12, memoryChars: 120, bytes: 3500 });
		expect(rendered).toContain("build-host");
		expect(rendered).toContain("feature");
		expect(rendered).toContain("sess-peer");
		expect(rendered).toContain("a".repeat(8));
	});

	test("a compact name keeps a path bracket, a comma in the session, and a whole emoji", () => {
		const section = defined(
			worktreesSection(
				wtInput([
					mineRow(),
					wtRow({ path: "/w/feature [review]", session_id: "sess, peer" }),
					wtRow({ host: "emoji-host", path: "/w/emoji", session_id: "123456789012345😀", files: ["src/a.ts"] }),
				]),
				NOW,
			),
			"section",
		);
		const names = section.items.map((item) => item.text);
		expect(names.some((text) => text.includes("/w/feature [review]") && text.includes("sess, peer"))).toBe(true);
		expect(names.some((text) => text.includes("😀"))).toBe(true);
		expect(names.some((text) => text.includes("\uD83D") && !text.includes("😀"))).toBe(false);
	});
	test("a caller whose worktree reports an empty list touches nothing, so nothing overlaps and there is no section", () => {
		expect(worktreesSection(wtInput([mineRow([]), wtRow()]), NOW)).toBeNull();
	});

	test("control characters are shown as \\xNN and secrets are redacted in every value the registry holds", () => {
		const hostile = "src/\u0007bell\u001b[31m.ts";
		const section = worktreesSection(
			wtInput([mineRow([hostile]), wtRow({ files: [hostile], path: "/w/\u001b]0;pwned\u0007x", branch: `feature/${SECRET}`, host: "h\nost" })]),
			NOW,
		);
		const text = printed(section);
		expect(text).toContain("\\x07bell\\x1b[31m.ts");
		expect(text).toContain("\\x1b]0;pwned\\x07x");
		expect(text).toContain("h\\x0aost");
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain("\u001b");
		expect(text).not.toContain("\u0007");
	});

	test("a token split from its prefix by a newline is redacted before the newline is escaped", () => {
		const token = `ghp_${"a".repeat(24)}`;
		const path = `/w/\n${token}`;
		const section = worktreesSection(wtInput([mineRow([`src/\n${token}`]), wtRow({ files: [`src/\n${token}`], path })]), NOW);
		const text = printed(section);
		expect(text).toContain("\\x0a");
		expect(text).not.toContain(token);
		expect(text).not.toContain("ghp_");
	});

	test("a truncated file list says the overlap check is incomplete, including when no reported path overlaps", () => {
		const missed = worktreesSection(wtInput([mineRow(["src/a.ts"]), wtRow({ files: ["src/z.ts"], files_truncated: true })]), NOW);
		expect(printed(missed)).toContain("overlap check incomplete");
		expect(heads(missed)).toHaveLength(1);

		const overlapping = worktreesSection(wtInput([mineRow(), wtRow({ files_truncated: true })]), NOW);
		expect(printed(overlapping)).toContain("overlap check incomplete");
		expect(heads(overlapping)).toHaveLength(1);
		expect(printed(overlapping)).toContain("/w/other");
	});

	test("the section stays inside the 1,200-character bound and every line inside 160, however long the values are", () => {
		const files = Array.from({ length: 12 }, (_, index) => `${"deep/".repeat(30)}file-${index}.ts`);
		const others = Array.from({ length: 8 }, (_, index) => wtRow({ path: `/${"p".repeat(300)}${index}`, host: "h".repeat(120), branch: "b".repeat(200), session_id: `${"s".repeat(100)}${index}`, files }));
		const section = defined(worktreesSection(wtInput([mineRow(files), ...others]), NOW), "the section");
		expect(printed(section).length).toBeLessThanOrEqual(BRIEF_SESSIONS_SECTION_MAX_CHARS);
		for (const line of section.lines) expect(line.length).toBeLessThanOrEqual(160);
		// What did not fit is counted, not silently lost: five listed at most, and the closing line names the rest.
		expect(section.lines.at(-1)).toMatch(/^… and \d+ more worktrees$/);
	});
});

describe("composeLiveSections with the worktrees source", () => {
	const rows = [mineRow(), wtRow()];

	test("the worktrees section is printed last, after sessions, steering and handoffs", async () => {
		const sections = await composeLiveSections(
			{
				context: async () => contextOf([contextSession(1)]),
				steering: () => steeringInput,
				handoffs: async () => [{ goal: "ship it", createdAtMs: NOW - 5_000, verified: true }],
				worktrees: async () => wtInput(rows),
			},
			manualDeadline().race,
			NOW,
		);
		expect(sections.map((section) => section.id)).toEqual(["sessions", "steering", "handoffs", "worktrees"]);
	});

	test("a worktrees read the deadline cuts off is one line naming it, and the other sections stay", async () => {
		const deadline = manualDeadline();
		const pending = composeLiveSections({ context: null, steering: () => steeringInput, handoffs: null, worktrees: () => neverReady<BriefWorktreesInput>() }, deadline.race, NOW);
		deadline.expire();
		const sections = await pending;
		expect(sections.map((section) => section.id)).toEqual(["steering", "worktrees"]);
		expect(printed(sections[1] ?? null)).toContain("worktrees not included: not ready before the brief's deadline");
	});

	test("a worktrees read that fails is noted as failed, so it is never mistaken for no overlap, and drops nothing else", async () => {
		const sections = await composeLiveSections(
			{
				context: null,
				steering: () => steeringInput,
				handoffs: null,
				worktrees: async () => {
					throw new Error("postgres is down");
				},
			},
			manualDeadline().race,
			NOW,
		);
		expect(sections.map((section) => section.id)).toEqual(["steering", "worktrees"]);
		const note = printed(sections[1] ?? null);
		expect(note).toContain("Live worktrees not included: the read failed.");
		expect(note).not.toContain("postgres");
		expect(renderCompactBrief([defined(sections[1], "the failed-read note")], COMPACT_STATE, COMPACT)).toContain("the read failed");
	});

	test("a late worktrees note stays visible in the compact profile", async () => {
		const deadline = manualDeadline();
		const pending = composeLiveSections({ context: null, steering: null, handoffs: null, worktrees: () => neverReady<BriefWorktreesInput>() }, deadline.race, NOW);
		deadline.expire();
		const sections = await pending;
		expect(printed(sections[0] ?? null)).toContain("not ready before the brief's deadline");
		expect(renderCompactBrief(sections, COMPACT_STATE, COMPACT)).toContain("not ready before the brief's deadline");
	});

	test("no worktrees source (registry off, no repository or no session) adds no section", async () => {
		const sections = await composeLiveSections({ context: null, steering: null, handoffs: null, worktrees: null }, manualDeadline().race, NOW);
		expect(sections).toEqual([]);
	});
});
