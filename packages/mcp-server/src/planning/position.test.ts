/**
 * The GSD-Core position model: both STATE.md and ROADMAP.md layouts that occur in this repository, the states a project is
 * in (mid-phase, between phases, milestone complete, no phase), malformed and oversize input, the progress table's mixed
 * status words, byte-stable output, and redaction. Pure text in, position out: no filesystem, no clock.
 */
import { describe, expect, test } from "bun:test";
import { REDACTED } from "../redact.ts";
import { POSITION_MAX_BYTES, POSITION_MAX_ENTRIES, POSITION_STRING_MAX, isDoneStatus, parsePosition, type PositionInput } from "./position.ts";

const TOKEN = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const TOKEN_BODY = "A1b2C3d4E5f6G7h8I9j0";

const NULL_POSITION = { milestone: null, milestone_name: null, phase: null, plan: null, progress: null, status: null, step: null };

/** The older layout: frontmatter with counters, a stale `Current Position` prose, the v1.3.x progress table. */
const STATE_OLD = `---
gsd_state_version: "1.0"
milestone: v1.3.x
milestone_name: Should-have hardening (Planned)
status: "phase 40 in review (draft PR); awaiting the merge decision"
stopped_at: "phase 40 in review (draft PR); awaiting gates and the user's merge decision"
last_updated: "2026-10-21"
progress:
  total_phases: 8
  completed_phases: 2
  total_plans: 3
  completed_plans: 2
  percent: 25
current_phase: 40
current_phase_name: docs-memory
---

# State

## Current

**v1.3 Build plan completion is planned.**

## Current Position

Phase: Milestone v1.3 complete
Plan: —
Status: Awaiting next milestone
Last activity: 2026-10-11 — Milestone v1.3 completed and archived

## Session Continuity

Last session: 2026-10-08T21:29:12Z
Stopped at: Phase 18 complete, ready to plan Phase 19
Resume file: None
`;

const ROADMAP_OLD = `# Roadmap: Agent Substrate

## Milestones

- ✅ **v1.2 Swarm leases** — Phases 11-15, shipped 2026-10-08.
- 🚧 **v1.3.x Should-have hardening** — Phases 37-44, scheduled.

## Phases

### 🚧 v1.3.x Should-have hardening (Planned)

- [x] **Phase 37: LANEB** - Lane B hardening
- [x] **Phase 39: DISPATCH** - dispatcher hardening
- [ ] **Phase 40: DOCS-MEMORY** - the memory planes consolidate into one

## Phase Details

### Phase 39: DISPATCH

**Goal**: The dispatcher is hardened.
**Plans**: 1/1 plans complete

### Phase 40: DOCS-MEMORY

**Goal**: The memory planes consolidate into one.

**Depends on**: P10

**Success Criteria** (what must be TRUE):

  1. D-D1 (decided 2026-10-21): cross-surface recall in the brief is a bounded, cached fan-out.

**Plans**: 0 plans (created by gsd-plan-phase)

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 34. Invalid-write round trip | v1.4 | 1/1 | Complete | 2026-10-21 |
| 37. LANEB | v1.3.x | 1/1 | Complete | 2026-10-21 |
| 38. MIRROR | v1.3.x | 1/1 | Complete | 2026-10-21 |
| 39. DISPATCH | v1.3.x | 1/1 | Complete (PR #91) | 2026-10-21 |
| 40. DOCS-MEMORY | v1.3.x | 0/0 | In review (draft PR) | - |
| 41. ANCHOR | v1.3.x | 0/0 | Not started | - |
| 42. SKILL-CARD | v1.3.x | 0/0 | Partial: live proof open | - |
| 43. LANE-A | v1.3.x | 0/0 | Planned 2026-10-26 | - |
| 44. UAT | v1.3.x | 1/1 | Complete | 2026-10-21 |
`;

/** The newer layout: a v1.6 milestone, phase sections with Status and Plans lines, a plan checklist, no stale prose. */
const STATE_NEW = `---
gsd_state_version: "1.0"
milestone: v1.6
milestone_name: Contextual Memory, Live Steering and Eternal Rollback
status: executing
stopped_at: "58-02-PLAN step 3: position model reviewed, steering wiring next"
last_updated: "2026-10-26T09:00:00.000Z"
progress:
  total_phases: 8
  completed_phases: 2
  total_plans: 4
  completed_plans: 1
  percent: 25
current_phase: 58
current_phase_name: live-session-steering
---

# State

## Current Position

Phase: 58 — Live session steering for multi-day GSD-Core sessions
Plan: 58-02-PLAN
Status: Executing plan 2 of 3
Last activity: 2026-10-26

## Session Continuity

Last session: 2026-10-26T09:00:00Z
Stopped at: a stale line that the frontmatter overrides
`;

const ROADMAP_NEW = `# Roadmap: Agent Substrate

## Milestones

- 🚧 **v1.6 Contextual Memory, Live Steering and Eternal Rollback** — Phases 55-62, planned 2026-10-26.

## Phases

### 🚧 v1.6 Contextual Memory, Live Steering and Eternal Rollback (Planned)

- [x] **Phase 55: Migration safety and the v1.6 baseline** - contract-tested migrations.
- [ ] **Phase 58: Live session steering for multi-day GSD-Core sessions** - durable directives.

## Phase Details

### Phase 58: Live session steering for multi-day GSD-Core sessions

**Goal**: Directives are durable, and the position is known.

#### Success criteria

  1. A fixture tree yields the exact position.

**Status**: In progress, plan 58-02 executing.

**Depends on**: Phase 52

**Plans**: 1/3 plans complete

Plans:
- [x] 58-01-PLAN.md — The position model
- [ ] 58-02-PLAN.md — Wiring
- [ ] 58-03-PLAN.md — Soak

### Phase 59: Eternal logging

**Status**: Planned 2026-10-26.

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 54. Planning observability | v1.5 | 0/0 | In review (draft PR #111) | - |
| 55. Migration safety and the v1.6 baseline | v1.6 | 2/2 | Complete | 2026-10-26 |
| 56. LightRAG client contract | v1.6 | 1/1 | Complete | 2026-10-26 |
| 57. Tandem memory | v1.6 | 3/3 | Complete (PR #200) | 2026-10-26 |
| 58. Live session steering for multi-day GSD-Core sessions | v1.6 | 1/3 | In progress | - |
| 59. Eternal logging | v1.6 | 0/0 | Planned 2026-10-26 | - |
| 60. Eternal Memory Knowledge Nexus | v1.6 | 0/0 | Planned 2026-10-26 | - |
| 61. Session rollback | v1.6 | 0/0 | Planned 2026-10-26 | - |
| 62. Soak, runbooks and v1.6 close | v1.6 | 0/0 | Planned 2026-10-26 | - |
`;

const BETWEEN_STATE = `# State

## Current Position

Phase: 19 — Lane B collectors
Plan: Not started
Status: Ready to plan
Last activity: 2026-10-09 — Phase 18 complete, transitioned to Phase 19
`;

const BETWEEN_ROADMAP = `## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 16. Production parity | v1.3 | 5/5 | Complete | 2026-10-08 |
| 17. Event vocabulary | v1.3 | 3/3 | Complete | 2026-10-09 |
| 18. Guard rails and shared redactor | v1.3 | 4/4 | Complete | 2026-10-09 |
| 19. Lane B collectors | v1.3 | 0/0 | Not started | - |
| 20. Production identity | v1.3 | 0/0 | Not started | - |
`;

const DONE_STATE = `# State

## Current Position

Phase: Milestone v1.1 complete
Plan: —
Status: Awaiting next milestone
Last activity: 2026-10-07 — Milestone v1.1 completed and archived
`;

const DONE_ROADMAP = `## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 7. Swarm correlation | v1.1 | 3/3 | Complete | 2026-10-01 |
| 8. Governed memory | v1.1 | 2/2 | Complete | 2026-10-02 |
| 11. Swarm leases | v1.2 | 0/0 | Not started | - |
`;

function position(input: Partial<PositionInput> & { state: string | null; roadmap: string | null }) {
	return parsePosition(input);
}

function toCrlf(text: string): string {
	return text.replace(/\n/g, "\r\n");
}

describe("parsePosition: the two layouts", () => {
	test("the older layout yields the exact position: the frontmatter wins over the stale prose, the table gives the progress", () => {
		const result = position({ state: STATE_OLD, roadmap: ROADMAP_OLD, phases: ["39-dispatch", "40-docs-memory", "41-anchor"] });
		expect(result).toEqual({
			errors: [],
			ok: true,
			position: {
				milestone: "v1.3.x",
				milestone_name: "Should-have hardening (Planned)",
				phase: { name: "DOCS-MEMORY", number: "40", slug: "docs-memory" },
				plan: null,
				progress: { phases_done: 4, phases_total: 8 },
				status: "phase 40 in review (draft PR); awaiting the merge decision",
				step: "phase 40 in review (draft PR); awaiting gates and the user's merge decision",
			},
		});
	});

	test("the newer layout yields the exact position, with the table's count over the frontmatter's stale one", () => {
		const result = position({ state: STATE_NEW, roadmap: ROADMAP_NEW, phases: ["57-tandem-memory", "58-live-session-steering"], plans: ["58-01-PLAN.md", "58-01-SUMMARY.md", "58-02-PLAN.md"] });
		expect(result).toEqual({
			errors: [],
			ok: true,
			position: {
				milestone: "v1.6",
				milestone_name: "Contextual Memory, Live Steering and Eternal Rollback",
				phase: { name: "Live session steering for multi-day GSD-Core sessions", number: "58", slug: "live-session-steering" },
				plan: "58-02-PLAN",
				progress: { phases_done: 3, phases_total: 8 },
				status: "executing",
				step: "58-02-PLAN step 3: position model reviewed, steering wiring next",
			},
		});
	});

	test("a state with prose only (no frontmatter) is read from its Current Position and Session Continuity sections", () => {
		const state = "# State\n\n## Current Position\n\nPhase: 3 of 8 (Auth)\nPlan: 03-02\nStatus: Executing\n\n## Session Continuity\n\nStopped at: Task 2 of plan 03-02\n";
		const result = position({ state, roadmap: null });
		expect(result.position).toEqual({
			milestone: null,
			milestone_name: null,
			phase: { name: "Auth", number: "3", slug: null },
			plan: "03-02",
			progress: null,
			status: "Executing",
			step: "Task 2 of plan 03-02",
		});
		expect(result.errors).toEqual([{ code: "missing", detail: "ROADMAP.md was not provided", where: "ROADMAP.md" }]);
		expect(result.ok).toBe(false);
	});

	test("bold keys and bullets in the Current Position section are read, and a Status line inside a code block is not", () => {
		const state = "# State\n\n## Current Position\n\n- **Phase:** 7 — Real name\n```\nStatus: fake\n```\n- **Status**: real\n";
		expect(position({ state, roadmap: null }).position).toMatchObject({ phase: { name: "Real name", number: "7" }, status: "real" });
	});

	test("a Current Position section that only appears inside a code block is not a position", () => {
		const state = "# State\n\n```md\n## Current Position\nPhase: 3\n```\n";
		const result = position({ state, roadmap: null });
		expect(result.position).toEqual(NULL_POSITION);
		expect(result.errors.map((error) => error.code)).toEqual(["missing", "no-position"]);
	});

	test("CRLF line endings give the same position as LF", () => {
		const lf = position({ state: STATE_NEW, roadmap: ROADMAP_NEW });
		expect(position({ state: toCrlf(STATE_NEW), roadmap: toCrlf(ROADMAP_NEW) })).toEqual(lf);
	});
});

describe("parsePosition: the states of a project", () => {
	test("mid-phase: the plan comes from the state's Plan line, and the step is where the last session stopped", () => {
		const result = position({ state: STATE_NEW, roadmap: ROADMAP_NEW });
		expect(result.position.plan).toBe("58-02-PLAN");
		expect(result.position.step).toBe("58-02-PLAN step 3: position model reviewed, steering wiring next");
	});

	test("mid-phase with no Plan line: the first plan on disk without a summary is the plan in progress", () => {
		const state = "---\nmilestone: v1.6\ncurrent_phase: 58\n---\n# State\n";
		const plans = ["58-01-PLAN.md", "58-01-SUMMARY.md", "58-02-PLAN.md", "58-03-PLAN.md", "57-01-PLAN.md"];
		expect(position({ state, roadmap: null, plans }).position.plan).toBe("58-02-PLAN");
	});

	test("with no Plan line and every plan on disk summarized, there is no plan in progress, whatever the checklist says", () => {
		const state = "---\nmilestone: v1.6\ncurrent_phase: 58\n---\n# State\n";
		expect(position({ state, roadmap: ROADMAP_NEW, plans: ["58-01-PLAN.md", "58-01-SUMMARY.md"] }).position.plan).toBeNull();
	});

	test("with no Plan line and no plan files, the first unchecked plan of the roadmap's checklist is the plan", () => {
		const state = "---\nmilestone: v1.6\ncurrent_phase: 58\n---\n# State\n";
		expect(position({ state, roadmap: ROADMAP_NEW }).position.plan).toBe("58-02-PLAN");
	});

	test("a Plan line that says there is none is a decision: no fallback to the files", () => {
		const state = "---\nmilestone: v1.6\ncurrent_phase: 58\n---\n# State\n\n## Current Position\n\nPhase: 58\nPlan: —\n";
		expect(position({ state, roadmap: ROADMAP_NEW, plans: ["58-02-PLAN.md"] }).position.plan).toBeNull();
	});

	test("between phases: the next phase with no plan yet, its name and milestone from the roadmap, progress from the table", () => {
		const result = position({ state: BETWEEN_STATE, roadmap: BETWEEN_ROADMAP });
		expect(result).toEqual({
			errors: [],
			ok: true,
			position: {
				milestone: "v1.3",
				milestone_name: null,
				phase: { name: "Lane B collectors", number: "19", slug: null },
				plan: null,
				progress: { phases_done: 3, phases_total: 5 },
				status: "Ready to plan",
				step: null,
			},
		});
	});

	test("milestone complete, from the prose: no phase, no plan, the milestone and the status the state gives", () => {
		const result = position({ state: DONE_STATE, roadmap: DONE_ROADMAP });
		expect(result).toEqual({
			errors: [],
			ok: true,
			position: { milestone: "v1.1", milestone_name: null, phase: null, plan: null, progress: { phases_done: 2, phases_total: 2 }, status: "Awaiting next milestone", step: null },
		});
	});

	test("milestone complete, from the frontmatter status: a stale current_phase does not keep a phase in progress", () => {
		const state = "---\nmilestone: v1.2\nmilestone_name: Swarm leases\nstatus: completed\ncurrent_phase: 15\n---\n# State\n";
		expect(position({ state, roadmap: null }).position).toEqual({
			milestone: "v1.2",
			milestone_name: "Swarm leases",
			phase: null,
			plan: null,
			progress: null,
			status: "completed",
			step: null,
		});
	});

	test("a closed milestone's Phase line does not override a live current_phase from the frontmatter", () => {
		const result = position({ state: STATE_OLD, roadmap: null });
		expect(result.position.phase).toEqual({ name: "docs-memory", number: "40", slug: null });
	});

	test("no phase: `None active` and a range such as `63-66 built` name no phase", () => {
		for (const line of ["None active — v1.3 implementation archived", "63-66 built and verified in code; closeout pending", "v1.3.x phases 37-44 open; phase 46 partial in v1.5", "—"]) {
			const state = `# State\n\n## Current Position\n\nPhase: ${line}\nPlan: —\nStatus: Human verification pending\n`;
			const result = position({ state, roadmap: null });
			expect(result.position).toEqual({ ...NULL_POSITION, status: "Human verification pending" });
		}
	});

	test("a phase number is canonical: leading zeros go, a decimal keeps its place, the directory is matched by number", () => {
		const state = "---\nmilestone: v1.1\ncurrent_phase: \"08.1\"\n---\n# State\n";
		const result = position({ state, roadmap: null, phases: ["08-memory", "08.1-gap-closure", "09-next"] });
		expect(result.position.phase).toEqual({ name: null, number: "8.1", slug: "gap-closure" });
	});

	test("two directories for one phase are ambiguous: no slug, and an error that names both", () => {
		const state = "---\nmilestone: v1.5\ncurrent_phase: 46\n---\n# State\n";
		const result = position({ state, roadmap: null, phases: ["46-ragflow-hybrid", "46-lightrag-hybrid", "47-forecast-preload"] });
		expect(result.position.phase).toEqual({ name: null, number: "46", slug: null });
		expect(result.errors).toContainEqual({ code: "ambiguous-phase-dir", detail: "phase 46 has 2 directories: 46-lightrag-hybrid, 46-ragflow-hybrid", where: "phases" });
	});

	test("a status the roadmap's phase section gives fills a state that has none", () => {
		const state = "---\nmilestone: v1.6\ncurrent_phase: 59\n---\n# State\n";
		expect(position({ state, roadmap: ROADMAP_NEW }).position.status).toBe("Planned 2026-10-26.");
	});

	test("a phase section's status stays with its phase: a deeper heading does not end the section, the next phase does", () => {
		const state = "---\nmilestone: v1.6\ncurrent_phase: 58\n---\n# State\n";
		expect(position({ state, roadmap: ROADMAP_NEW }).position.status).toBe("In progress, plan 58-02 executing.");
	});

	test("an old-style checklist line gives the phase its title", () => {
		const roadmap = "- [x] Phase 0: Brief — complete and live\n- [ ] Phase 1: Lane B\n";
		const state = "---\nmilestone: v1.0\ncurrent_phase: 0\n---\n# State\n";
		expect(position({ state, roadmap }).position.phase).toEqual({ name: "Brief", number: "0", slug: null });
	});
});

describe("parsePosition: missing, malformed and oversize input", () => {
	test("no state: an error and every field null", () => {
		const result = position({ state: null, roadmap: ROADMAP_NEW });
		expect(result).toEqual({ errors: [{ code: "missing", detail: "STATE.md was not provided", where: "STATE.md" }], ok: false, position: NULL_POSITION });
	});

	test("neither file: both are reported, sorted by file", () => {
		const result = position({ state: null, roadmap: null });
		expect(result.errors).toEqual([
			{ code: "missing", detail: "ROADMAP.md was not provided", where: "ROADMAP.md" },
			{ code: "missing", detail: "STATE.md was not provided", where: "STATE.md" },
		]);
		expect(result.position).toEqual(NULL_POSITION);
	});

	test("malformed frontmatter (an unclosed fence) is an error entry with null fields, not an exception", () => {
		const state = "---\nmilestone: v1.6\ncurrent_phase: [unclosed\n# State\n\n## Current Position\n\nPhase: 5\n";
		const result = position({ state, roadmap: ROADMAP_NEW });
		expect(result.position).toEqual(NULL_POSITION);
		expect(result.errors).toEqual([{ code: "malformed-frontmatter", detail: "frontmatter has no closing fence or is not a YAML mapping", where: "STATE.md" }]);
		expect(result.ok).toBe(false);
	});

	test("frontmatter that is YAML but not a mapping is malformed too", () => {
		const result = position({ state: "---\n- a\n- b\n---\n# State\n", roadmap: null });
		expect(result.errors.map((error) => [error.where, error.code])).toEqual([
			["ROADMAP.md", "missing"],
			["STATE.md", "malformed-frontmatter"],
		]);
	});

	test("a malformed roadmap leaves the state's own fields and reports the roadmap", () => {
		const result = position({ state: STATE_NEW, roadmap: "---\nphase: [unclosed\n# Roadmap\n" });
		expect(result.errors).toEqual([{ code: "malformed-frontmatter", detail: "frontmatter has no closing fence or is not a YAML mapping", where: "ROADMAP.md" }]);
		expect(result.position).toMatchObject({ milestone: "v1.6", phase: { number: "58", slug: null }, progress: { phases_done: 2, phases_total: 8 } });
	});

	test("a state with no position in it at all is reported as such", () => {
		const result = position({ state: "# State\n\nNothing here.\n", roadmap: ROADMAP_NEW });
		expect(result.position).toEqual(NULL_POSITION);
		expect(result.errors).toEqual([{ code: "no-position", detail: "no frontmatter position and no Current Position section", where: "STATE.md" }]);
	});

	test("text over the cap is refused with a typed error, before anything is parsed", () => {
		const huge = `---\nmilestone: v1.6\n---\n${"x".repeat(POSITION_MAX_BYTES)}`;
		const result = position({ state: huge, roadmap: "y".repeat(POSITION_MAX_BYTES + 1) });
		expect(result.position).toEqual(NULL_POSITION);
		expect(result.errors).toEqual([
			{ code: "too-large", detail: `ROADMAP.md exceeds ${POSITION_MAX_BYTES} bytes`, where: "ROADMAP.md" },
			{ code: "too-large", detail: `STATE.md exceeds ${POSITION_MAX_BYTES} bytes`, where: "STATE.md" },
		]);
	});

	test("the cap counts bytes, not characters, and a caller's cap replaces the default", () => {
		const state = `---\nmilestone: v1.6\n---\n${"é".repeat(600)}`;
		expect(position({ state, roadmap: null, maxBytes: 1_024 }).errors.map((error) => error.code)).toEqual(["missing", "too-large"]);
		expect(position({ state, roadmap: null }).errors.map((error) => error.code)).toEqual(["missing"]);
	});

	test("one huge line under the cap is cut and capped, and the parse still finishes", () => {
		const state = `---\nmilestone: v1.6\ncurrent_phase: 3\n---\n# State\n\n## Current Position\n\nPhase: 3\nStatus: ${"a ".repeat(100_000)}\n`;
		const result = position({ state, roadmap: null });
		expect(result.position.status?.length).toBeLessThanOrEqual(POSITION_STRING_MAX);
		expect(result.position.status?.endsWith("…")).toBe(true);
	});

	test("more table rows than the bound are cut and reported, and the count is of the rows kept", () => {
		const rows = Array.from({ length: POSITION_MAX_ENTRIES + 50 }, (_unused, index) => `| ${index + 1}. p${index + 1} | v9 | 0/0 | Complete | - |`);
		const roadmap = `| Phase | Milestone | Plans Complete | Status | Completed |\n|---|---|---|---|---|\n${rows.join("\n")}\n`;
		const result = position({ state: "---\nmilestone: v9\ncurrent_phase: 1\n---\n# State\n", roadmap });
		expect(result.position.progress).toEqual({ phases_done: POSITION_MAX_ENTRIES, phases_total: POSITION_MAX_ENTRIES });
		expect(result.errors.map((error) => error.code)).toEqual(["truncated"]);
	});

	test("it never throws: a non-text input, hostile lists, a bad cap and a throwing getter are all answered", () => {
		const notText = parsePosition({ state: 42 as unknown as string, roadmap: null });
		expect(notText.errors).toContainEqual({ code: "unreadable", detail: "STATE.md is not text", where: "STATE.md" });

		const state = "---\nmilestone: v1\ncurrent_phase: 1\n---\n";
		const hostile = parsePosition({ state, roadmap: null, phases: [1, null, "01-ok"] as unknown as string[], plans: "not a list" as unknown as string[], maxBytes: -5 });
		expect(hostile.position.phase).toEqual({ name: null, number: "1", slug: "ok" });

		const input = Object.defineProperty({ roadmap: null, phases: undefined, plans: undefined, maxBytes: undefined }, "state", {
			get(): never {
				throw new Error("boom");
			},
		}) as unknown as PositionInput;
		expect(parsePosition(input)).toEqual({ errors: [{ code: "internal", detail: "the position input could not be read", where: "STATE.md" }], ok: false, position: NULL_POSITION });
	});
});

describe("parsePosition: the progress table's status words", () => {
	const table = [
		"| Phase | Milestone | Plans Complete | Status | Completed |",
		"|-------|-----------|----------------|--------|-----------|",
		"| 1. a | v9 | 1/1 | Complete | 2026-10-01 |",
		"| 2. b | v9 | 1/1 | Complete (PR #91) | 2026-10-02 |",
		"| 3. c | v9 | 0/0 | In review (draft PR) | - |",
		"| 4. d | v9 | 0/1 | Partial: criterion 1 in repo | - |",
		"| 5. e | v9 | 0/0 | Not started | - |",
		"| 6. f | v9 | 0/0 | Planned 2026-10-26 | - |",
		"| 7. g | v9 | 1/1 | ✅ Done | 2026-10-03 |",
		"| 8. h | v8 | 1/1 | Complete | 2026-09-01 |",
		"| 8. h again | v9 | 1/1 | Complete | 2026-09-02 |",
		"| 9. i | v9 | 1/1 | Completed 2026-10-04 | 2026-10-04 |",
		"",
	].join("\n");

	test("a row is done when its status word says complete, done or shipped, and only the state's milestone is counted", () => {
		const result = position({ state: "---\nmilestone: v9\ncurrent_phase: 3\n---\n# State\n", roadmap: table });
		// v9 rows: 1, 2, 3, 4, 5, 6, 7, 8 (first row of phase 8 wins: it is v8, so phase 8 is not v9), 9. Done: 1, 2, 7, 9.
		expect(result.position.progress).toEqual({ phases_done: 4, phases_total: 8 });
	});

	test("the state's milestone is matched with or without a leading v, and in any case", () => {
		const result = position({ state: "---\nmilestone: V9\ncurrent_phase: 3\n---\n# State\n", roadmap: table });
		expect(result.position.progress).toEqual({ phases_done: 4, phases_total: 8 });
		const bare = position({ state: "---\nmilestone: 9\ncurrent_phase: 3\n---\n# State\n", roadmap: table });
		expect(bare.position.progress).toEqual({ phases_done: 4, phases_total: 8 });
	});

	test("with no row for the milestone the frontmatter counters are used, and counters that cannot be right are not", () => {
		const roadmap = "# Roadmap\n";
		const fine = position({ state: "---\nmilestone: v9\ncurrent_phase: 3\nprogress:\n  total_phases: 6\n  completed_phases: 2\n---\n# State\n", roadmap });
		expect(fine.position.progress).toEqual({ phases_done: 2, phases_total: 6 });
		const impossible = position({ state: "---\nmilestone: v9\ncurrent_phase: 3\nprogress:\n  total_phases: 2\n  completed_phases: 5\n---\n# State\n", roadmap });
		expect(impossible.position.progress).toBeNull();
	});

	test("isDoneStatus reads the words the table uses", () => {
		const words: Array<[string, boolean]> = [
			["Complete", true],
			["Complete    ", true],
			["Complete (PR #91)", true],
			["Completed 2026-10-04", true],
			["✅ Done", true],
			["Shipped", true],
			["In review (draft PR)", false],
			["Partial: criterion 1 in repo", false],
			["Not started", false],
			["Planned 2026-10-26", false],
			["Incomplete", false],
			["-", false],
			["", false],
		];
		for (const [word, done] of words) expect([word, isDoneStatus(word)]).toEqual([word, done]);
	});
});

describe("parsePosition: stable output", () => {
	test("the same input twice is byte-identical JSON, and every object's keys are in code-unit order", () => {
		const input = { state: STATE_NEW, roadmap: ROADMAP_NEW, phases: ["58-live-session-steering", "57-tandem-memory"], plans: ["58-02-PLAN.md", "58-01-PLAN.md"] };
		const first = JSON.stringify(parsePosition(input));
		const second = JSON.stringify(parsePosition({ ...input, phases: [...input.phases].reverse(), plans: [...input.plans].reverse() }));
		expect(second).toBe(first);

		const sortedKeys = (value: unknown): boolean => {
			if (value === null || typeof value !== "object") return true;
			const keys = Object.keys(value);
			return [...keys].sort().join("\u0000") === keys.join("\u0000") && Object.values(value).every(sortedKeys);
		};
		expect(sortedKeys(JSON.parse(first))).toBe(true);
	});

	test("errors come out sorted by file, code and detail whatever order they were found in", () => {
		const result = position({ state: "# State\n\nNothing.\n", roadmap: null });
		expect(result.errors.map((error) => `${error.where}:${error.code}`)).toEqual(["ROADMAP.md:missing", "STATE.md:no-position"]);
	});
});

describe("parsePosition: redaction and caps", () => {
	test("a secret-looking token in a step line is redacted, in the prose and in the frontmatter", () => {
		const prose = `# State\n\n## Session Continuity\n\nStopped at: pushed the branch with ${TOKEN} still set\n`;
		const fromProse = position({ state: prose, roadmap: null });
		expect(fromProse.position.step).toBe(`pushed the branch with ${REDACTED} still set`);
		expect(JSON.stringify(fromProse)).not.toContain(TOKEN_BODY);

		const fm = `---\nmilestone: v1\nstopped_at: "deploy with ${TOKEN}"\nstatus: "key ${TOKEN}"\n---\n# State\n`;
		const fromFrontmatter = position({ state: fm, roadmap: null });
		expect(fromFrontmatter.position.step).toBe(`deploy with ${REDACTED}`);
		expect(fromFrontmatter.position.status).toBe(`key ${REDACTED}`);
		expect(JSON.stringify(fromFrontmatter)).not.toContain(TOKEN_BODY);
	});

	test("a token in a roadmap title, status and table is redacted too", () => {
		const roadmap = `### Phase 5: Title ${TOKEN}\n\n**Status**: ${TOKEN} pending\n\n| Phase | Milestone | Plans Complete | Status | Completed |\n|---|---|---|---|---|\n| 5. t | v1 | 0/0 | ${TOKEN} | - |\n`;
		const result = position({ state: "---\nmilestone: v1\ncurrent_phase: 5\n---\n# State\n", roadmap, phases: [`05-${TOKEN}`] });
		const text = JSON.stringify(result);
		expect(text).not.toContain(TOKEN_BODY);
		expect(result.position.phase?.name).toBe(`Title ${REDACTED}`);
		expect(result.position.phase?.slug).toBe(REDACTED);
		expect(result.position.status).toBe(`${REDACTED} pending`);
	});

	test("a string is redacted before it is capped, so the cut cannot hide a token, and the cap ends in an ellipsis", () => {
		const status = `${"a".repeat(290)} ${TOKEN}`;
		const result = position({ state: `---\nmilestone: v1\nstatus: "${status}"\n---\n# State\n`, roadmap: null });
		expect(result.position.status?.length).toBe(POSITION_STRING_MAX);
		expect(result.position.status?.endsWith("…")).toBe(true);
		expect(result.position.status).not.toContain("ghp_");
	});

	test("control characters and runs of whitespace are folded to one space", () => {
		const result = position({ state: "---\nmilestone: v1\nstatus: \"a\\n\\tb   c\\u0007d\"\n---\n# State\n", roadmap: null });
		expect(result.position.status).toBe("a b c d");
	});
});
