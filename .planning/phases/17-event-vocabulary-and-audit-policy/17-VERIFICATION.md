---
phase: 17-event-vocabulary-and-audit-policy
verified: 2026-10-08T23:59:00Z
status: passed
score: 11/11 must-haves verified
covered_files: [".env.example", ".planning/REQUIREMENTS.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-01-PLAN.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-01-SUMMARY.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-02-PLAN.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-02-SUMMARY.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-03-PLAN.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-03-SUMMARY.md", "docs/event-vocabulary.md", "docs/mcp-audit.md", "docs/swarm-correlation.md", "package.json", "packages/audit/src/policy.test.ts", "packages/audit/src/policy.ts", "packages/mcp-server/src/authority.test.ts", "packages/mcp-server/src/event-sources.test.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/types.ts", "packages/mcp-server/src/vocabulary-lock.test.ts", "scripts/phase-close-check.test.ts", "scripts/phase-close-check.ts", "scripts/vocabulary-smoke.test.ts", "scripts/vocabulary-smoke.ts"]
covered_digest: "v3:sha256:c25a0cc270363ef3571ef9a944bf0a44e8bc1c2e64f8f65be51f2d5a08bbcbd0"
behavior_unverified: 0
overrides_applied: 0
re_verification: null
---

# Phase 17: Event vocabulary and audit policy Verification Report

**Phase Goal:** Every event source v1.3 adds lands on the existing vocabulary, decided and documented once in a reviewed PR, so no later phase adds an event kind; the audit policy records whether each planned tool fails open or closed.
**Verified:** 2026-10-08T23:59:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | EVENT_KINDS equals its v1.2 literal (12, ordered) and SURFACES equals v1.2 literal plus `substrate` last (27, ordered) under plain bun test | ✓ VERIFIED | `vocabulary-lock.test.ts` 2 pass; `types.ts` shows `substrate` appended after `...SWARM_SURFACES` with operator-decision comment |
| 2 | Every EVENT_SOURCES sample passes normalizeEvent unchanged in kind, surface and payload, host-job rows on fixed `substrate` | ✓ VERIFIED | `event-sources.test.ts` 39 pass (round-trip deep-equal, coverage, repo-rule, no-content) |
| 3 | A `substrate` token resolves to `substrate`, emits as `substrate`, refused otherwise on /events and via attributedSurface; other non-swarm tokens keep body-first attribution | ✓ VERIFIED | `authority.test.ts` 35 pass incl. POST /events substrate binding tests |
| 4 | Doc marked table and table name same ids, kinds, actions | ✓ VERIFIED | Drift test in `event-sources.test.ts` passes; markers `<!-- event-sources:start/end -->` present at doc lines 51/90 |
| 5 | Every roadmap source has ≥1 row; no periodic row carries repo | ✓ VERIFIED | Roadmap-prefix coverage + repo-rule tests pass in `event-sources.test.ts` (27 EVENT_SOURCES rows, 7 SILENT) |
| 6 | Each of 8 planned tools explicitly in decided set, absent from other, auditMode returns decided mode | ✓ VERIFIED | `policy.test.ts` 14 pass via independent PLANNED_V13 literal; policy.ts lines 27-29 closed, 74-78 open |
| 7 | Every served registerTool and auditedRest name sits in exactly one set | ✓ VERIFIED | Scan guard test passes (19 registerTool + 8 auditedRest names) |
| 8 | Audit docs record planned tools by phase with reasons and link vocabulary doc | ✓ VERIFIED | `docs/mcp-audit.md` Planned-in-v1.3 sub-table + link; `swarm-correlation.md` link sentence; store-lock 18 pass |
| 9 | check:phase-close exits 0 here, 2 on missing lock/absent baseline, 1 with diff on any kind/surface change | ✓ VERIFIED | `bun run check:phase-close` exit 0 (73 pass, kinds 12 vs ab62c91, surfaces 27); pure-helper failure paths unit-proven in 14 pass `phase-close-check.test.ts`; live exit-1/exit-2 paths recorded in 17-03-SUMMARY |
| 10 | One sample per EVENT_SOURCES row stored over wire, zero refusals, read back N/N | ✓ VERIFIED | Proof transcript in 17-03-SUMMARY: 27/27 stored 202, refusals 0, 27/27 read back, instance p17 (not re-run per assignment) |
| 11 | Both package.json scripts resolve; teardown leaves no container or run dir | ✓ VERIFIED | `smoke:vocabulary` + `check:phase-close` entries confirmed in package.json; teardown evidence in 17-03-SUMMARY |

**Score:** 11/11 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/event-sources.ts` | SurfaceRule/EventSource/EVENT_SOURCES/SILENT_SOURCES, imports only ./types.ts | ✓ VERIFIED | Single type-only import line 15; 27+7 rows |
| `packages/mcp-server/src/event-sources.test.ts` | round-trip, drift, coverage, repo, no-content tests | ✓ VERIFIED | 39 pass |
| `packages/mcp-server/src/vocabulary-lock.test.ts` | ordered-literal pins 12 kinds / 27 surfaces | ✓ VERIFIED | 2 pass |
| `packages/mcp-server/src/types.ts` | substrate appended last, kinds unchanged | ✓ VERIFIED | Confirmed lines 30-46 |
| `packages/mcp-server/src/mcp.ts` | attributedSurface binds substrate callers | ✓ VERIFIED | Lines 93-113, 357 |
| `packages/mcp-server/src/authority.test.ts` | 27-surface pin + binding tests | ✓ VERIFIED | 35 pass |
| `.env.example` | blank SUBSTRATE_TOKEN_SUBSTRATE line | ✓ VERIFIED | Line 130 |
| `docs/event-vocabulary.md` | reviewed mapping + marked table | ✓ VERIFIED | Markers present |
| `packages/audit/src/policy.ts` | 8 planned entries, auditMode unchanged | ✓ VERIFIED | Lines 27-29, 74-78 |
| `packages/audit/src/policy.test.ts` | PLANNED_V13 + scan guard | ✓ VERIFIED | 14 pass |
| `docs/mcp-audit.md` / `docs/swarm-correlation.md` | planned table + links | ✓ VERIFIED | Present |
| `scripts/phase-close-check.ts` + test | gate + pure helpers | ✓ VERIFIED | 14 pass, gate exit 0 |
| `scripts/vocabulary-smoke.ts` + test | smoke + guards | ✓ VERIFIED | 10 pass |
| `package.json` | two script entries only | ✓ VERIFIED | Lines 25-26 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| samples | normalizeEvent | write-path gate round-trip test | WIRED | deep-equal per row, 39 pass |
| doc table | EVENT_SOURCES | event-sources markers parse test | WIRED | id/kind/action equality |
| substrate token | substrate surface | tokenEnvName, surfaceForToken, attributedSurface | WIRED | unit + /events tests |
| PLANNED_V13 literal | policy sets | independent literal test | WIRED | editing either side fails |
| policy sets | mcp.ts/server.ts names | scan guard regex | WIRED | membership-only, counts-free |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| event-sources.ts samples | sample() payloads | literal per-row fixtures through real normalizeEvent | ✓ | FLOWING (proven, not mocked) |
| phase-close-check | EVENT_KINDS/SURFACES | git show ab62c91 baseline + live import | ✓ | FLOWING |
| vocabulary-smoke | stored/readback counts | live harness POST /events + events/query | ✓ | FLOWING (17-03 transcript) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| lock tests green | `bun test ./packages/mcp-server/src/vocabulary-lock.test.ts` | 2 pass 0 fail | ✓ PASS |
| samples green | `bun test ./packages/mcp-server/src/event-sources.test.ts` | 39 pass 0 fail | ✓ PASS |
| policy green | `bun test ./packages/audit/src/policy.test.ts` | 14 pass 0 fail | ✓ PASS |
| authority green | `bun test ./packages/mcp-server/src/authority.test.ts` | 35 pass 0 fail | ✓ PASS |
| gate helpers green | `bun test ./scripts/phase-close-check.test.ts` | 14 pass 0 fail | ✓ PASS |
| smoke guards green | `bun test ./scripts/vocabulary-smoke.test.ts` | 10 pass 0 fail | ✓ PASS |
| store-lock green | `bun test ./packages/mcp-server/src/store-lock.test.ts` | 18 pass 0 fail | ✓ PASS |
| tsc clean | `bunx tsc --noEmit` | exit 0 | ✓ PASS |
| gate green | `bun run check:phase-close` | exit 0, 73 pass, 12 kinds / 27 surfaces | ✓ PASS |

### Probe Execution

No phase-declared or conventional probes for this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| FOUND-02 | 17-01, 17-02, 17-03 | Vocabulary locked, mapping documented/encoded, audit policy decided, phase-close gate + zero-refusal proof | ✓ SATISFIED | All 11 truths verified; REQUIREMENTS.md marks FOUND-02 Complete |

No orphaned requirements: FOUND-02 is the only ID in all three PLAN frontmatters and matches the assignment.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | None: no TODO/FIXME/XXX/TBD/placeholder across all 6 new + 8 touched source/doc files | — | — |

Prohibitions (all three plans) confirmed: `event-sources.ts` imports only `./types.ts`; no EVENT_KINDS/normalizeEvent/MEMORY_KINDS/hash-chain change; no `registerTool`/`KNOWN_TOOLS`/`auditedRest` additions in 17-02; no rehearsal imports, no default URL, git show-only in 17-03; no secret values in any touched file (store-lock green).

### Human Verification Required

None. All truths have automated behavioral evidence (unit suites + gate + recorded harness transcript). The over-the-wire proof was recorded by the 17-03 executor and explicitly excluded from re-run by this assignment.

### Gaps Summary

No gaps. Phase goal achieved: the closed vocabulary (12 kinds, 27 surfaces with `substrate`) is typed, locked, drift-tested against its document, proven over the wire with zero refusals, and the eight planned tools carry explicit audit modes guarded against undecided registration. Later phases implement against `EVENT_SOURCES` and re-run `check:phase-close`.

---
_Verified: 2026-10-08T23:59:00Z_
_Verifier: Execute17.Verify17 (gsd-verifier)_
