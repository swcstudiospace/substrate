---
phase: 17-event-vocabulary-and-audit-policy
verified: 2026-10-09T00:00:00Z
status: passed
score: 11/11 must-haves verified
covered_files: [".env.example", ".planning/REQUIREMENTS.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-01-PLAN.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-01-SUMMARY.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-02-PLAN.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-02-SUMMARY.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-03-PLAN.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-03-SUMMARY.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-REVIEW-DISPOSITION.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-REVIEW.md", "docs/event-vocabulary.md", "docs/mcp-audit.md", "docs/swarm-correlation.md", "package.json", "packages/audit/src/policy.test.ts", "packages/audit/src/policy.ts", "packages/mcp-server/src/authority.test.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/event-sources.test.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/store-lock.test.ts", "packages/mcp-server/src/types.ts", "packages/mcp-server/src/vocabulary-lock.test.ts", "scripts/phase-close-check.test.ts", "scripts/phase-close-check.ts", "scripts/vocabulary-smoke.test.ts", "scripts/vocabulary-smoke.ts"]
covered_digest: "v3:sha256:a4e1fc9e898d0640b352b9e74cc4f8fbaa16f394e8391a2799d389d84ae14283"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 11/11
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 17: Event vocabulary and audit policy Verification Report

**Phase Goal:** Every event source v1.3 adds lands on the existing vocabulary, decided and documented once in a reviewed PR, so no later phase adds an event kind; the audit policy records whether each planned tool fails open or closed.
**Verified:** 2026-10-09T00:00:00Z
**Status:** passed
**Re-verification:** Yes — after 8 review-fix commits (17-REVIEW.md → 17-REVIEW-DISPOSITION.md, all 7 findings fixed). Prior verification (2026-10-08, passed 11/11) predates the fixes; every truth below was re-checked against HEAD `20687f1`.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | EVENT_KINDS equals its v1.2 literal (12, ordered) and SURFACES equals v1.2 literal plus `substrate` last (27, ordered) under plain bun test | ✓ VERIFIED | `vocabulary-lock.test.ts` 2 pass; `types.ts` shows `substrate` appended after `...SWARM_SURFACES` with operator-decision comment |
| 2 | Every EVENT_SOURCES sample passes normalizeEvent unchanged in kind, surface and payload, host-job rows on fixed `substrate` | ✓ VERIFIED | `event-sources.test.ts` 46 pass (was 39; +6 prefix guards +1 surface-rule test from WR-03) — round-trip deep-equal, coverage, repo-rule, no-content |
| 3 | A `substrate` token resolves to `substrate`, emits as `substrate`, refused otherwise on /events and via attributedSurface; other non-swarm tokens keep body-first attribution | ✓ VERIFIED | `authority.test.ts` 36 pass (was 35; +substrate-missing warning test from IN-02); WR-01 exclusion proven in new `config.test.ts` 3 pass |
| 4 | Doc marked table and table name same ids, kinds, surfaces, actions | ✓ VERIFIED | Drift test now compares kind+**surface**+actions per row incl. silent em-dash surfaces (WR-03); markers `<!-- event-sources:start/end -->` present |
| 5 | Every roadmap source has ≥1 row; no periodic row carries repo | ✓ VERIFIED | Prefix guard extended to `skills.sync`, `dispatch.`, `lanea.`, `mirror.`, `dod.`, `lease.` (WR-03); 27 emitting EVENT_SOURCES rows + 9 SILENT (was 7; +`skills.sync`, `mirror` from WR-02) |
| 6 | Each of 8 planned tools explicitly in decided set, absent from other, auditMode returns decided mode | ✓ VERIFIED | `policy.test.ts` 14 pass via independent PLANNED_V13 literal; policy.ts closed/open sets unchanged by review fixes |
| 7 | Every served registerTool and auditedRest name sits in exactly one set | ✓ VERIFIED | Scan guard test passes (19 registerTool + 8 auditedRest names) |
| 8 | Audit docs record planned tools by phase with reasons and link vocabulary doc | ✓ VERIFIED | `docs/mcp-audit.md` Planned-in-v1.3 sub-table + link; `swarm-correlation.md` link sentence; store-lock 18 pass |
| 9 | check:phase-close exits 0 here, 2 on missing lock/absent baseline, 1 with diff on any kind/surface change | ✓ VERIFIED | `bun run check:phase-close` exit 0 (80 pass, was 73; kinds 12 vs ab62c91, surfaces 27); IN-04 guards unit-pinned (lookbehind + whitespace-spread tests, 16 pass in phase-close-check.test.ts) |
| 10 | One sample per EVENT_SOURCES row stored over wire, zero refusals, read back N/N | ✓ VERIFIED | **Re-run live by this verifier** 2026-10-09 on own harness instance `p17-verify` (port 0, commit 20687f1): 27/27 stored 202, refusals 0, 27/27 read back, 28/28 checks passed; `rehearsal down` removed containers |
| 11 | Both package.json scripts resolve; teardown leaves no container or run dir | ✓ VERIFIED | `smoke:vocabulary` + `check:phase-close` entries confirmed; teardown observed live this run (pid stopped, 2 containers removed) |

**Score:** 11/11 truths verified (0 present, behavior-unverified)

### Review-Fix Regression (17-REVIEW.md → HEAD)

All 7 findings recorded `fixed` in 17-REVIEW-DISPOSITION.md with zero open. Each fix re-verified in code, not just in the disposition record:

| Finding | Fix commit | Code evidence | Test evidence |
|---------|-----------|---------------|---------------|
| WR-01 substrate token operator-eligible | 8cd476d | `config.ts` `isOperator` returns `!isSwarmSurface(surface) && surface !== "substrate"`; `configWarnings` names the surface, never the token | new `config.test.ts` 3 pass (refused force, boot warning without token value, swarm+substrate side-by-side) |
| WR-02 skills-sync/mirror success unmapped | 6e323dd | `SILENT_SOURCES` +2 entries (`skills.sync`: synced tree is trail; `mirror`: Linear comment is trail); doc silent section mirrors both | silent-row doc equality assertions in `event-sources.test.ts` pass (46) |
| WR-03 lock tests miss rule-vs-sample + prefixes | 254a328 | — | new "the surface rule" per-row test (fixed must equal sample; herdr-agent samples a SURFACES member; caller/memory-writer/lease-holder sample concrete surfaces) + 6 new prefix guards + surface value in doc-drift test |
| IN-01 env-example test misses substrate line | fe88ecf | — | authority `.env.example` test iterates `[...SWARM_SURFACES, "substrate"]` |
| IN-02 no boot warning for missing substrate token | 82383c7 | `swarmTokenWarnings` appends substrate line when `config.tokens` lacks it | 2 authority tests (missing-substrate warns beside swarm seats; warns alone once seats filled; silent when all present) |
| IN-03 herdr examples read as normative | f4aa6a5 | doc now reads "(expected shape, to be pinned by Phase 19 — e.g. …)" under the `[UNVERIFIED]` marker | — (prose; marker intentionally retained for Phase 19) |
| IN-04 `parseEventKinds` lacks mismatch guard | c25ad88 | kinds regex `(?<![A-Z_])EVENT_KINDS`; spread matcher tolerates `... SWARM_SURFACES` whitespace | 2 new parser tests (longer-identifier rejection, whitespace-spread expansion) |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/event-sources.ts` | SurfaceRule/EventSource/EVENT_SOURCES/SILENT_SOURCES, imports only ./types.ts | ✓ VERIFIED | Single type-only import; 27 emitting + 9 silent rows |
| `packages/mcp-server/src/event-sources.test.ts` | round-trip, drift, coverage, repo, no-content, surface-rule tests | ✓ VERIFIED | 46 pass |
| `packages/mcp-server/src/vocabulary-lock.test.ts` | ordered-literal pins 12 kinds / 27 surfaces | ✓ VERIFIED | 2 pass |
| `packages/mcp-server/src/types.ts` | substrate appended last, kinds unchanged | ✓ VERIFIED | Untouched by fixes; lock still green |
| `packages/mcp-server/src/mcp.ts` | attributedSurface binds substrate callers | ✓ VERIFIED | Untouched by fixes |
| `packages/mcp-server/src/config.ts` | WR-01 exclusion + IN-02 warning | ✓ VERIFIED | `isOperator` substrate refusal; `configWarnings` + `swarmTokenWarnings` substrate branches, no token values leaked |
| `packages/mcp-server/src/config.test.ts` | WR-01 pin | ✓ VERIFIED | New file, 3 pass |
| `packages/mcp-server/src/authority.test.ts` | 27-surface pin + binding + warning tests | ✓ VERIFIED | 36 pass |
| `.env.example` | blank SUBSTRATE_TOKEN_SUBSTRATE line | ✓ VERIFIED | Pinned by IN-01 test |
| `docs/event-vocabulary.md` | reviewed mapping + marked table + silent rows + non-normative herdr | ✓ VERIFIED | Markers present; silent +2; herdr rephrased |
| `packages/audit/src/policy.ts` | 8 planned entries, auditMode unchanged | ✓ VERIFIED | Untouched by fixes; 14 pass |
| `packages/audit/src/policy.test.ts` | PLANNED_V13 + scan guard | ✓ VERIFIED | 14 pass |
| `docs/mcp-audit.md` / `docs/swarm-correlation.md` | planned table + links | ✓ VERIFIED | Untouched by fixes |
| `scripts/phase-close-check.ts` + test | gate + pure helpers + IN-04 guards | ✓ VERIFIED | 16 pass, gate exit 0 |
| `scripts/vocabulary-smoke.ts` + test | smoke + guards | ✓ VERIFIED | 10 pass; live 28/28 this run |
| `package.json` | two script entries only | ✓ VERIFIED | Untouched by fixes |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| samples | normalizeEvent | write-path gate round-trip test | WIRED | deep-equal per row, 46 pass |
| doc table | EVENT_SOURCES | event-sources markers parse test | WIRED | id/kind/**surface**/action equality (surface added by WR-03) |
| substrate token | substrate surface | tokenEnvName, surfaceForToken, attributedSurface | WIRED | unit + /events tests |
| substrate token | operator refusal | isOperator + configWarnings | WIRED | new config.test.ts 3 pass (WR-01) |
| PLANNED_V13 literal | policy sets | independent literal test | WIRED | editing either side fails |
| policy sets | mcp.ts/server.ts names | scan guard regex | WIRED | membership-only, counts-free |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| event-sources.ts samples | sample() payloads | literal per-row fixtures through real normalizeEvent | ✓ | FLOWING (proven, not mocked) |
| phase-close-check | EVENT_KINDS/SURFACES | git show ab62c91 baseline + live import | ✓ | FLOWING |
| vocabulary-smoke | stored/readback counts | live harness POST /events + events/query on p17-verify | ✓ | FLOWING (this-run transcript: 27/27, 0 refusals) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| lock tests green | `bun test ./packages/mcp-server/src/vocabulary-lock.test.ts` | 2 pass 0 fail | ✓ PASS |
| samples green | `bun test ./packages/mcp-server/src/event-sources.test.ts` | 46 pass 0 fail | ✓ PASS |
| policy green | `bun test ./packages/audit/src/policy.test.ts` | 14 pass 0 fail | ✓ PASS |
| authority green | `bun test ./packages/mcp-server/src/authority.test.ts` | 36 pass 0 fail | ✓ PASS |
| config green (new) | `bun test ./packages/mcp-server/src/config.test.ts` | 3 pass 0 fail | ✓ PASS |
| gate helpers green | `bun test ./scripts/phase-close-check.test.ts` | 16 pass 0 fail | ✓ PASS |
| smoke guards green | `bun test ./scripts/vocabulary-smoke.test.ts` | 10 pass 0 fail | ✓ PASS |
| store-lock green | `bun test ./packages/mcp-server/src/store-lock.test.ts` | 18 pass 0 fail | ✓ PASS |
| 8-file phase battery | `bun test` on the 8 phase files | 145 pass 0 fail | ✓ PASS |
| full suite (regression) | `bun test` | 1308 pass, 56 skip, 0 fail (48 files) | ✓ PASS |
| tsc clean | `bunx tsc --noEmit` | exit 0 | ✓ PASS |
| gate green | `bun run check:phase-close` | exit 0, 80 pass, 12 kinds / 27 surfaces | ✓ PASS |
| live smoke | `rehearsal up --name p17-verify --port 0` + `smoke:vocabulary` + `rehearsal down` | 27/27 stored, 0 refusals, 27/27 read back, 28/28 checks; teardown clean | ✓ PASS |

### Probe Execution

No phase-declared or conventional probes for this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| FOUND-02 | 17-01, 17-02, 17-03 | Vocabulary locked, mapping documented/encoded, audit policy decided, phase-close gate + zero-refusal proof | ✓ SATISFIED | All 11 truths verified live against HEAD; REQUIREMENTS.md marks FOUND-02 Complete |

No orphaned requirements: FOUND-02 is the only ID in all three PLAN frontmatters and matches the assignment.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `docs/event-vocabulary.md` | 113 | `[UNVERIFIED]` herdr marker | ℹ️ Info | Intentional honesty marker retained per IN-03 fix; Phase 19 pins identifiers. Not a debt marker. |
| changed source files | — | No TODO/FIXME/XXX/TBD/placeholder/`Not implemented` in any of the 8 fix-touched source/test/script files | — | — |

Prohibitions (all three plans) re-confirmed: `event-sources.ts` imports only `./types.ts`; no EVENT_KINDS/normalizeEvent/MEMORY_KINDS/hash-chain change; no `registerTool`/`KNOWN_TOOLS`/`auditedRest` additions in 17-02 scope; no rehearsal imports, no default URL, git show-only in 17-03; no secret values in any touched file (warning assertions pin absence of token values).

### Human Verification Required

None. All truths have automated behavioral evidence (unit suites + gate + live harness transcript run by this verifier). No visual, real-time, or external-service behavior is asserted.

### Gaps Summary

No gaps. Phase goal achieved at HEAD `20687f1`: the closed vocabulary (12 kinds, 27 surfaces with `substrate`) is typed, locked, drift-tested against its document (now including surface values), proven over the wire with zero refusals on a fresh harness run, and the eight planned tools carry explicit audit modes guarded against undecided registration. The 7 review findings are fixed with pinned tests and introduce no regressions (full suite 1308 pass, 0 fail). Later phases implement against `EVENT_SOURCES`/`SILENT_SOURCES` and re-run `check:phase-close`.

---
_Verified: 2026-10-09T00:00:00Z_
_Verifier: Reverify17 (gsd-verifier)_
