---
phase: 17-event-vocabulary-and-audit-policy
verified: 2026-11-18T12:22:48Z
status: gaps_found
score: 4/7 must-haves verified
covered_files: [".planning/milestones/v1.3-REQUIREMENTS.md", ".planning/milestones/v1.3-phases/17-event-vocabulary-and-audit-policy/17-01-PLAN.md", ".planning/milestones/v1.3-phases/17-event-vocabulary-and-audit-policy/17-01-SUMMARY.md", ".planning/milestones/v1.3-phases/17-event-vocabulary-and-audit-policy/17-02-PLAN.md", ".planning/milestones/v1.3-phases/17-event-vocabulary-and-audit-policy/17-02-SUMMARY.md", ".planning/milestones/v1.3-phases/17-event-vocabulary-and-audit-policy/17-03-PLAN.md", ".planning/milestones/v1.3-phases/17-event-vocabulary-and-audit-policy/17-03-SUMMARY.md", "docs/event-vocabulary.md", "packages/audit/src/policy.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/types.ts", "scripts/phase-close-check.ts"]
covered_digest: "v3:sha256:a22688ee96fad62f1db7da8171e6fb91fb2f4f32cb69ec6d92e339a76cdb27f5"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 11/11
  previous_record: "17-VERIFICATION.md dated 2026-10-09 at HEAD 69272f1"
  gaps_closed: []
  gaps_remaining:
    - "SURFACES equals v1.2 plus substrate only"
    - "check:phase-close passes"
  regressions:
    - "Prior truth 1 (SURFACES = 27 entries, substrate last) no longer holds at HEAD 357d6b15: SURFACES = 42 entries"
    - "Prior truth 9 (check:phase-close exits 0) no longer holds at HEAD 357d6b15: exits 1"
    - "Prior truth 10 (live harness run) was not repeated at HEAD; not re-run in this verification"
gaps:
  - truth: "SURFACES equals the v1.2 list plus `substrate` only (roadmap SC 2; FOUND-02 wording)"
    status: failed
    reason: "HEAD SURFACES has 42 entries: the 26 v1.2 entries (11 named + 15 swarm) plus 15 reviewed swarm surfaces swarm-a16-cloud..swarm-a30-custody plus substrate. The additions came in commit 702ed32e (2026-10-23) and are allow-listed as REVIEWED_SURFACE_ADDITIONS in scripts/phase-close-check.ts, pinned by vocabulary-lock.test.ts (42 in order), and described in docs/event-vocabulary.md. The literal criterion and the FOUND-02 requirement text in .planning/milestones/v1.3-REQUIREMENTS.md (marked Complete) still say v1.2 plus substrate only. EVENT_KINDS is unaffected."
    artifacts:
      - path: "packages/mcp-server/src/types.ts"
        issue: "SURFACES (lines 45-67) includes SWARM_SURFACES a16-a30 and substrate; 42 entries vs 27 specified"
      - path: "scripts/phase-close-check.ts"
        issue: "REVIEWED_SURFACE_ADDITIONS allow-lists the 15 a16-a30 surfaces, so the gate's SURFACES rule no longer equals the success criterion"
      - path: "docs/event-vocabulary.md"
        issue: "Intro (line 3-5) says SURFACES gains exactly one surface, `substrate`; the mapping rules (line 14-18) list 15 more. The document contradicts itself."
      - path: ".planning/milestones/v1.3-REQUIREMENTS.md"
        issue: "FOUND-02 (line 34) still states the v1.2 list plus one system surface; it is marked Complete (line 165)"
    missing:
      - "An explicit operator decision, recorded in .planning, either (a) amending roadmap SC 2, FOUND-02 and the event-vocabulary intro to cover the reviewed A16..A30 swarm surfaces, or (b) removing those surfaces from SURFACES with a migration of their swarm tokens. Until then the literal criterion is not met."
  - truth: "A phase-close check runs store-lock.test.ts and diffs EVENT_KINDS against v1.2, and it passes on this phase"
    status: failed
    reason: "`bun scripts/phase-close-check.ts` exits 1 at HEAD. Four lock files ran 239 tests: 238 pass, 1 fail. The failing test is store-lock.test.ts > 'no secrets in the repo > no tracked file assigns a substrate token a value'. It flags packages/mcp-server/src/cross-repo.routes.test.ts, whose lines 65-66 bind the CLAUDE_CODE and CURSOR token identifiers to token keys. TOKEN_LITERAL (store-lock.test.ts line 116) treats the bare identifier as a value of 16+ word characters. The file came in with 357d6b15 (phase 74 work), not phase 17. The script stops at the failed lock test, so its EVENT_KINDS diff step did not run. An independent diff against ab62c91 shows EVENT_KINDS equal (12 = 12, same order)."
    artifacts:
      - path: "packages/mcp-server/src/cross-repo.routes.test.ts"
        issue: "Lines 20-21 declare string constants for the tokens; lines 65-66 assign those identifiers to SUBSTRATE_TOKEN_* keys, which the guard matches. Not verified whether the constant values are secret-shaped; values were not printed."
      - path: "packages/mcp-server/src/store-lock.test.ts"
        issue: "TOKEN_LITERAL (line 116) lacks an exclusion for bare identifier references, so the guard reads identifier names as literal token values"
    missing:
      - "Either rewrite the cross-repo routes fixture so SUBSTRATE_TOKEN_* keys do not take a 16+ character bare value, or tighten TOKEN_LITERAL to ignore identifier references. Then re-run `bun scripts/phase-close-check.ts` and record exit 0 with the EVENT_KINDS diff result."
deferred: []
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: "Run the Phase 16 harness (`bun run smoke:vocabulary`, or the equivalent sample emitter) on the candidate commit and POST one sample per EVENT_SOURCES row to /events, then read them back."
    expected: "Every row stored with 202, zero refusals, read back in full."
    why_human: "Needs the live scratch substrate and harness. The verifier was told not to run the live stack. The last recorded run (27/27 stored, 0 refusals) was at HEAD 69272f1, before the rebase onto the current candidate and before the swarm-surface amendment."
---

# Phase 17: Event vocabulary and audit policy Verification Report

**Phase Goal:** Every event source v1.3 adds lands on the existing vocabulary, decided and documented once in a reviewed PR, so no later phase adds an event kind; the audit policy records whether each planned tool fails open or closed.
**Verified:** 2026-11-18T12:22:48Z
**Status:** gaps_found
**Re-verification:** Yes, against the prior record. The prior 17-VERIFICATION.md (2026-10-09, passed 11/11 at HEAD 69272f1) is superseded. Every truth was re-checked against the candidate HEAD 357d6b15 on branch gsd/autonomous-rerun. Those 672 commits since 69272f1 include later phases, which changed the vocabulary and added a failing guard.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Mapping document and typed table name each v1.3 source (herdr, Muse, Cursor `stop`, skills propose, docs ingest, desktop actions, anchoring, teachables) with an existing kind and surface; host jobs use `substrate` | ✓ VERIFIED | `packages/mcp-server/src/event-sources.ts` has rows `herdr.agent_detected`/`herdr.status_changed`/`herdr.pane_exited`/`herdr.other`, `muse.tool_call` (line 860), `cursor.stop` (877), `skills.propose` (140, kind note, surface caller), `docs.ingest` (331), `desktop.action` (470, kind tool.call), `anchor.written` (496, surface `{ fixed: "substrate" }`), `teachable.accepted` (611, kind note, surface memory-writer). Host-job rows use `{ fixed: "substrate" }`: `anchor.written`, `anchor.failed`, `dispatch.outcome` (754), and others. `docs/event-vocabulary.md` has `<!-- event-sources:start -->` at line 96 and end at 189. Lock run: `event-sources.test.ts` passed in the 239-test run. |
| 2 | `EVENT_KINDS` is identical to its v1.2 value | ✓ VERIFIED | Independent diff against `git show ab62c91:packages/mcp-server/src/types.ts`: the 12 kinds match in order (`session.start` … `warning`). Current `types.ts` lines 69-82. `vocabulary-lock.test.ts` passed. |
| 3 | `SURFACES` equals the v1.2 list plus `substrate` only | ✗ FAILED (BLOCKER) | Independent diff: baseline 26 entries, HEAD 42, no removals, added = `swarm-a16-cloud` … `swarm-a30-custody` (15) + `substrate`. The additions are reviewed and allow-listed (`REVIEWED_SURFACE_ADDITIONS`, `scripts/phase-close-check.ts` ~line 95), and `vocabulary-lock.test.ts` pins 42. The literal criterion and FOUND-02 are not met. See gap 1. |
| 4 | One sample per mapped source is stored against the Phase 16 harness with zero refusals | ? UNCERTAIN (human_needed) | Not run: this verification does not run the live stack. Only the last recorded run (27/27 stored, 0 refusals, HEAD 69272f1) is known. See human verification. |
| 5 | `store-lock.test.ts` runs in a phase-close check that also diffs `EVENT_KINDS` against v1.2, and passes | ✗ FAILED (BLOCKER) | `bun scripts/phase-close-check.ts` exits 1 (`[phase-close] lock tests failed.`). 238 pass, 1 fail. The failure is in the store-lock "no secrets" guard, which flags `cross-repo.routes.test.ts` (added by 357d6b15). See gap 2. |
| 6 | Each planned v1.3 tool (`skills_propose`, `docs_search`, `docs_ingest`, `graph_find`, `issue_get`, `desktop_run`, recall) has an explicit fail-open/fail-closed decision, and a policy test fails on a missing entry or the opposite decision | ✓ VERIFIED | `packages/audit/src/policy.ts`: FAIL_CLOSED_TOOLS holds `skills_propose`, `docs_ingest`, `desktop_run`. FAIL_OPEN_TOOLS holds `docs_search`, `issue_get`, `graph_find`, `memory_recall`, `agent_card`. `policy.test.ts` `PLANNED_V13` literal (8 entries) passes, along with the explicit-membership test. |
| 7 | The mapping doc and the table cannot drift (same ids, kinds, surfaces, actions) | ✓ VERIFIED | `event-sources.test.ts` drift test passed in the lock run. Doc markers at lines 96 and 189. |

**Score:** 4/7 truths verified (0 present-but-behavior-unverified). Truths 3 and 5 are blockers. Truth 4 needs a human.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| FOUND-02 | 17-01, 17-02, 17-03 | `EVENT_KINDS` unchanged; each source maps onto existing kinds and onto "the v1.2 list plus one system surface `substrate`"; the policy records fail-open/closed | ✗ BLOCKED (literal wording) | The kinds half is met. The surfaces half is contradicted by the 15 reviewed swarm additions. REQUIREMENTS.md still marks FOUND-02 Complete (line 165). |

No orphaned requirements.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `docs/event-vocabulary.md` | Reviewed mapping, marked table | ⚠️ PRESENT, STALE INTRO | Markers present (96/189). Intro lines 3-5 say SURFACES gains exactly one surface; rules list 15 more. |
| `packages/mcp-server/src/event-sources.ts` | Typed EVENT_SOURCES and SILENT_SOURCES | ✓ VERIFIED | Rows for all eight named sources. SILENT_SOURCES at line 1601. |
| `packages/mcp-server/src/types.ts` | EVENT_KINDS and SURFACES | ⚠️ KINDS OK, SURFACES DEVIATES | EVENT_KINDS = 12 (baseline). SURFACES = 42 (see truth 3). |
| `packages/audit/src/policy.ts` | Fail-open/closed decision for planned tools | ✓ VERIFIED | Entries present for every planned tool in the criterion. |
| `scripts/phase-close-check.ts` | Phase-close gate | ✗ FAILING | Exits 1 at HEAD (store-lock). Allow-lists the swarm surfaces. |
| `packages/mcp-server/src/store-lock.test.ts` | Lock test, secrets guard | ✗ 1 FAIL | `no tracked file assigns a substrate token a value` flags `cross-repo.routes.test.ts`. |
| `packages/mcp-server/src/vocabulary-lock.test.ts` | Lock on EVENT_KINDS and SURFACES | ✓ PASSES | Pins SURFACES at 42 (with the swarm additions), not 27. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| docs/event-vocabulary.md marked table | event-sources.ts EVENT_SOURCES | event-sources.test.ts drift test | ✓ WIRED | Test passes. |
| scripts/phase-close-check.ts | store-lock.test.ts | runs the lock tests first | ✓ WIRED | Runs; 1 fail. |
| scripts/phase-close-check.ts | v1.2 baseline ab62c91 | git show, then EVENT_KINDS/SURFACES diff | ✗ NOT REACHED | Script exits at the failed lock test before the diff. Verifier's independent diff: kinds equal, surfaces differ by the 15 reviewed swarm surfaces and `substrate`. |
| policy.test.ts | policy.ts sets | PLANNED_V13 literal | ✓ WIRED | Passes. |

### Data-Flow Trace (Level 4)

Not applicable. Phase 17 is vocabulary and policy data with tests, and no dynamic rendering.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Lock tests (store-lock, vocabulary-lock, event-sources, policy) | `bun scripts/phase-close-check.ts` | 239 tests, 238 pass, 1 fail (store-lock secrets guard); exit 1 | ✗ FAIL |
| EVENT_KINDS vs v1.2 | inline Bun script comparing `types.ts` to `git show ab62c91:...` | kinds equal (12/12, ordered); SURFACES 26 → 42, no removals | ✗ FAIL (SURFACES) / ✓ PASS (KINDS) |
| Live harness, one sample per source | not run | not run | ? SKIP (live stack) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` for this phase. Not applicable.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| packages/mcp-server/src/cross-repo.routes.test.ts | 65-66 | Identifier assigned to a `SUBSTRATE_TOKEN_*` key, flagged as a literal by the guard | 🛑 Blocker | Turns the phase-close gate red |
| docs/event-vocabulary.md | 3-5 vs 14-18 | Intro says one added surface; rules list 15 more | ⚠️ Warning | Doc contradicts itself and the gate |
| .planning/milestones/v1.3-REQUIREMENTS.md | 34 | FOUND-02 says v1.2 list plus `substrate` but is marked Complete | ⚠️ Warning | Requirement wording does not match the code |

No TBD/FIXME/XXX markers were found in the phase-17 files.

### Human Verification Required

### 1. Live harness: one sample per mapped source, zero refusals

**Test:** Start the Phase 16 scratch substrate and run the vocabulary smoke (`bun run smoke:vocabulary` or its equivalent). POST one sample per `EVENT_SOURCES` row to `/events`, then read them back.
**Expected:** 27 (or the current row count) stored with 202, zero refusals, all read back.
**Why human:** Needs the live scratch stack, which this verification was not allowed to start. The last recorded pass (27/27, HEAD 69272f1) predates the swarm-surface amendment and the later rebases.

### 2. Decision on the SURFACES amendment

**Test:** Confirm with the operator whether the 15 reviewed swarm surfaces (`swarm-a16-cloud` … `swarm-a30-custody`, commit 702ed32e) are accepted as part of the phase 17 vocabulary.
**Expected:** A recorded decision. If accepted, amend roadmap SC 2, FOUND-02 and the intro of `docs/event-vocabulary.md`. If not, remove them and migrate the tokens.
**Why human:** This is an operator scope decision. The code cannot settle it.

### Gaps Summary

Phase 17 meets the kinds half of its goal. `EVENT_KINDS` is unchanged from v1.2 and proven so by the lock tests. The eight planned tools carry explicit audit modes. The mapping document and the typed table agree and cover all eight named sources, with host jobs on `substrate`.

Two things block a clean `passed`:

1. **SURFACES is not "v1.2 plus substrate only" at HEAD.** The swarm surfaces A16..A30 (15 entries) were added by 702ed32e, reviewed and allow-listed in the gate, and pinned in the lock test. That is a legitimate later amendment, but it contradicts this phase's literal criterion and FOUND-02, and the intro of the mapping doc. It needs an operator decision and wording to match.
2. **The phase-close gate is red.** `bun scripts/phase-close-check.ts` exits 1 because the store-lock secrets guard reads the CLAUDE_CODE token binding in `cross-repo.routes.test.ts` (added by 357d6b15) as a literal token. The EVENT_KINDS diff never runs. Fix the fixture or tighten the guard, then re-run and record exit 0.

The live harness sample-per-source run is not done here and is a human item.

**Owner decision (2026-11-19): keep_open.** The 15 reviewed swarm surfaces (`swarm-a16-cloud` … `swarm-a30-custody`) stay open in SURFACES. Criterion 3 (SURFACES equals v1.2 plus `substrate` only) remains failed by design until the owner amends that criterion; this decision does not close gap 1.

---

_Verified: 2026-11-18T12:22:48Z_
_Verifier: gsd-verify-queue-2 (gsd-verifier)_
