---
phase: 17-event-vocabulary-and-audit-policy
verified: 2026-11-12T08:25:40Z
status: human_needed
score: 10/11 must-haves verified
covered_files: [".env.example", ".planning/milestones/v1.3-phases/17-event-vocabulary-and-audit-policy/17-01-PLAN.md", ".planning/milestones/v1.3-phases/17-event-vocabulary-and-audit-policy/17-01-SUMMARY.md", ".planning/milestones/v1.3-phases/17-event-vocabulary-and-audit-policy/17-02-PLAN.md", ".planning/milestones/v1.3-phases/17-event-vocabulary-and-audit-policy/17-02-SUMMARY.md", ".planning/milestones/v1.3-phases/17-event-vocabulary-and-audit-policy/17-03-PLAN.md", ".planning/milestones/v1.3-phases/17-event-vocabulary-and-audit-policy/17-03-SUMMARY.md", "docs/event-vocabulary.md", "docs/mcp-audit.md", "docs/swarm-correlation.md", "package.json", "packages/audit/src/policy.test.ts", "packages/audit/src/policy.ts", "packages/mcp-server/src/authority.test.ts", "packages/mcp-server/src/event-sources.test.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/types.ts", "packages/mcp-server/src/vocabulary-lock.test.ts", "scripts/phase-close-check.test.ts", "scripts/phase-close-check.ts", "scripts/vocabulary-smoke.test.ts", "scripts/vocabulary-smoke.ts"]
covered_digest: "v3:sha256:1c433f939a2d3f3cbba2c7f20e15f17bfd0c8f60e1d2810553c8687f155cb407"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 11/11
  previous_record: "17-VERIFICATION.md dated 2026-10-09 at HEAD 69272f1"
  gaps_closed: []
  gaps_remaining: []
  regressions: []
advisory: []
human_verification:
  - test: "Run the Phase 16 harness live: `rehearsal up --name <name> --port 0`, then `bun run smoke:vocabulary` against it, then `rehearsal down`."
    expected: "Every EVENT_SOURCES row stored with HTTP 202, 0 refusals, all rows read back, and teardown leaves no containers or run dir. Confirm the expected count against the current EVENT_SOURCES table."
    why_human: "Truth 10 is a wire-level proof against running harness containers. The verifier does not start services (Step 7b). The 2026-10-09 transcript predates later commits and is not evidence for HEAD."
  - test: "Confirm that the 15 reviewed swarm surfaces added after phase 17 (swarm-a16-cloud through swarm-a30-custody, listed in REVIEWED_SURFACE_ADDITIONS in scripts/phase-close-check.ts) count toward this phase's SURFACES contract."
    expected: "Accept: SURFACES = 42 at HEAD (v1.2 list + 15 swarm surfaces + substrate) is the current baseline. Reject: SC2 is literal (v1.2 + substrate = 27) and the additions need a fix."
    why_human: "The phase text says 27. The code and vocabulary-lock test now pin 42 by a later reviewed decision. Which one governs is an operator call, not a code check."
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 17: Event vocabulary and audit policy Verification Report

**Phase Goal:** Every event source v1.3 adds lands on the existing vocabulary, decided and documented once in a reviewed PR, so no later phase adds an event kind; the audit policy records whether each planned tool fails open or closed.
**Verified:** 2026-11-12T08:25:40Z
**Status:** human_needed
**Re-verification:** Yes — re-run at HEAD `33c400d1`. The prior report (2026-10-09, passed 11/11 at `69272f1`) predates later commits. Every truth below was re-checked against the current code.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | EVENT_KINDS equals its v1.2 literal (12, ordered) and SURFACES equals the v1.2 list plus `substrate` last | ✓ VERIFIED (drift noted) | `types.ts:69-82` EVENT_KINDS = 12, identical to `git show ab62c91:packages/mcp-server/src/types.ts` lines 50-63. `types.ts:45-62` SURFACES ends with `"substrate"`. **Drift:** SURFACES is now 42, not 27. The 15 extra entries are the later reviewed swarm additions `swarm-a16-cloud` … `swarm-a30-custody` (`scripts/phase-close-check.ts` `REVIEWED_SURFACE_ADDITIONS`). See human item 2. |
| 2 | Every EVENT_SOURCES sample passes normalizeEvent unchanged in kind, surface and payload, host-job rows on fixed `substrate` | ✓ VERIFIED | `event-sources.test.ts` passes in the 8-file run below (386 pass across 8 files, 0 fail). |
| 3 | A `substrate` token resolves to `substrate`, emits as `substrate`, and is refused otherwise on /events and via attributedSurface | ✓ VERIFIED | `config.ts:2111`, `:2124`, `:2240`, `:2277-2279` (substrate refusal and substrate token warning). `authority.test.ts` passes. |
| 4 | Doc marked table and table name agree on ids, kinds, surfaces and actions | ✓ VERIFIED | Markers at `docs/event-vocabulary.md:96` and `:189`. Drift test in `event-sources.test.ts` passes. |
| 5 | Every roadmap source has ≥1 row; no periodic row carries repo | ✓ VERIFIED | `event-sources.test.ts` coverage and repo-rule tests pass. |
| 6 | Each of the 8 planned tools is explicitly in the decided set, absent from the other, and `auditMode` returns the decided mode | ✓ VERIFIED | `policy.ts:25-33` fail-closed: `skills_propose`, `docs_ingest`, `desktop_run`. `policy.ts:115-122` fail-open: `docs_search`, `issue_get`, `graph_find`, `memory_recall`. `policy.test.ts` passes. |
| 7 | Every served registerTool and auditedRest name sits in exactly one set | ✓ VERIFIED | `policy.test.ts` scan guard passes. `mcp.ts` has 57 `registerTool` matches (grep count, not the scan itself). |
| 8 | Audit docs record planned tools by phase and link the vocabulary doc | ✓ VERIFIED | `docs/mcp-audit.md:296` and `docs/swarm-correlation.md:184` link `event-vocabulary.md`. |
| 9 | `check:phase-close` exits 0 at HEAD, and fails on a missing lock or a kind or surface diff | ✓ VERIFIED | **Run by this verifier:** `bun run check:phase-close` exit 0. Output: `EVENT_KINDS unchanged at 12 against ab62c91; SURFACES equals baseline plus substrate at 42`. Failure branches are covered by `phase-close-check.test.ts` (passes). |
| 10 | One sample per EVENT_SOURCES row stored over the wire, zero refusals, read back N/N | ? UNCERTAIN (human) | Not run. It needs the Phase 16 harness started, which Step 7b forbids. The only live transcript is from 2026-10-09 at an older commit. Unit-level pieces pass: `vocabulary-smoke.test.ts` (10 pass, including `isRefused` and `verifyReadBack`). See human item 1. |
| 11 | Both package.json scripts resolve; teardown leaves no container or run dir | ✓ VERIFIED | `package.json:40` `check:phase-close` resolves and runs. The `smoke:vocabulary` entry is present. Live teardown is covered by human item 1. |

**Score:** 10/11 truths verified (0 present-but-behavior-unverified; truth 10 is ? human)

### Deferred Items

None.

### Advisory (New Scope, Unevidenced)

None.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/event-sources.ts` | Rows and types; imports only `./types.ts` | ✓ VERIFIED | Single type-only import at line 15. |
| `packages/mcp-server/src/event-sources.test.ts` | Round-trip, drift, coverage, repo, no-content, surface-rule tests | ✓ VERIFIED | Passes (8-file run). |
| `packages/mcp-server/src/vocabulary-lock.test.ts` | Ordered literal pins for kinds and surfaces | ✓ VERIFIED | Passes. Pins 12 kinds and 42 surfaces at HEAD (see truth 1). |
| `packages/mcp-server/src/types.ts` | `substrate` appended last; kinds unchanged | ✓ VERIFIED | Lines 45-82. |
| `packages/mcp-server/src/mcp.ts` | attributedSurface binds substrate callers | ✓ VERIFIED | 57 `registerTool` matches; substrate wiring present. |
| `packages/mcp-server/src/config.ts` | WR-01 substrate refusal + substrate token warning | ✓ VERIFIED | Lines 2111, 2124, 2240, 2277-2279. |
| `.env.example` | `SUBSTRATE_TOKEN_SUBSTRATE` line | ✓ VERIFIED | Present; pinned by the IN-01 test. |
| `docs/event-vocabulary.md` | Reviewed mapping with markers | ✓ VERIFIED | Markers at lines 96 and 189. |
| `packages/audit/src/policy.ts` | Eight planned entries; `auditMode` unchanged | ✓ VERIFIED | Fail-closed set lines ~25-50; fail-open set lines ~85-135. |
| `packages/audit/src/policy.test.ts` | Independent PLANNED_V13 literal and scan guard | ✓ VERIFIED | Passes. |
| `docs/mcp-audit.md` / `docs/swarm-correlation.md` | Planned table and links | ✓ VERIFIED | Links at mcp-audit.md:296 and swarm-correlation.md:184. |
| `scripts/phase-close-check.ts` + test | Gate and pure helpers | ✓ VERIFIED | Gate exit 0 at HEAD; test passes. |
| `scripts/vocabulary-smoke.ts` + test | Smoke and guards | ✓ VERIFIED | Unit tests pass. The live run is human item 1. |
| `package.json` | Two script entries | ✓ VERIFIED | Line 40 and the smoke entry. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| samples | normalizeEvent | write-path gate round-trip test | WIRED | `event-sources.test.ts` passes. |
| doc table | EVENT_SOURCES | event-sources markers | WIRED | Markers at docs lines 96 and 189. |
| substrate token | substrate surface | tokenEnvName, surfaceForToken, attributedSurface | WIRED | `config.ts` plus `authority.test.ts` pass. |
| PLANNED_V13 literal | policy sets | independent literal test | WIRED | `policy.test.ts` passes. |
| policy sets | mcp.ts/server.ts names | scan guard | WIRED | `policy.test.ts` scan guard passes. |
| check:phase-close | lock files | `REVIEWED_SURFACE_ADDITIONS` diff | WIRED | Exit 0 at HEAD. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| event-sources.ts samples | sample() payloads | literal fixtures through real normalizeEvent | ✓ | FLOWING (unit) |
| phase-close-check | EVENT_KINDS/SURFACES | `git show ab62c91` baseline plus live import | ✓ | FLOWING (re-run this session) |
| vocabulary-smoke | stored/readback counts | live harness POST /events | not run | UNEVALUATED (human item 1) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Phase-close gate | `bun run check:phase-close` | exit 0; kinds 12 vs ab62c91; surfaces 42 | ✓ PASS |
| Eight-file phase battery | `bun test` on vocabulary-lock, event-sources, authority, policy, config, store-lock, phase-close-check, vocabulary-smoke | 386 pass, 0 fail, 8 files | ✓ PASS |
| Constants at HEAD | `bun` import of `types.ts` | kinds 12, surfaces 42, last `substrate` | ✓ PASS |
| Live wire smoke | `rehearsal up` + `smoke:vocabulary` + `rehearsal down` | not run (starts services) | ? SKIP (human item 1) |

Not run this session: full `bun test`, `bunx tsc --noEmit`, the live harness, and probes (none are declared for this phase).

### Probe Execution

No phase-declared or conventional probes for this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| FOUND-02 | 17-01, 17-02, 17-03 | Vocabulary locked, mapping documented, audit policy decided, phase-close gate, zero-refusal proof | ✓ SATISFIED (code); live proof pending (human item 1) | Truths 1-9 and 11 verified at HEAD. REQUIREMENTS.md marks FOUND-02 Complete. |

No orphaned requirements: FOUND-02 is the only ID in the three PLAN frontmatters.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (all phase-modified files; grep `TBD\|FIXME\|XXX`) | — | none found | — | Clean |

### Human Verification Required

### 1. Live wire proof against the Phase 16 harness

**Test:** `rehearsal up --name <name> --port 0`, then `bun run smoke:vocabulary` against it, then `rehearsal down`.
**Expected:** Every EVENT_SOURCES row stored with HTTP 202, 0 refusals, all rows read back, and teardown leaves no containers or run dir. Confirm the expected count against the current EVENT_SOURCES table.
**Why human:** Truth 10 needs running containers and services. The verifier does not start services. The only transcript (2026-10-09) predates later commits.

### 2. SURFACES baseline after later reviewed additions

**Test:** Decide whether the 15 reviewed swarm surfaces (`swarm-a16-cloud` through `swarm-a30-custody`, in `REVIEWED_SURFACE_ADDITIONS`) count toward phase 17's SC2.
**Expected:** Accept: SURFACES = 42 is the current baseline. Reject: SC2 is literal (v1.2 + substrate = 27) and the additions need a fix.
**Why human:** The phase text says 27. The code now pins 42 by a later reviewed decision. Which one governs is an operator call.

### Gaps Summary

No code gaps. Every checked truth holds at HEAD, and `check:phase-close` exits 0. Status is `human_needed` for two reasons: the live wire proof (truth 10) was not run, and the SURFACES count has moved from the literal 27 to 42 through a later reviewed decision (truth 1).

---

_Verified: 2026-11-12T08:25:40Z_
_Verifier: Claude (gsd-verifier)_
