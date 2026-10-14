---
phase: 17-event-vocabulary-and-audit-policy
verified: 2026-10-09T00:00:00Z
status: passed
score: 11/11 must-haves verified
covered_files: [".planning/phases/17-event-vocabulary-and-audit-policy/17-01-PLAN.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-01-SUMMARY.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-02-PLAN.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-02-SUMMARY.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-03-PLAN.md", ".planning/phases/17-event-vocabulary-and-audit-policy/17-03-SUMMARY.md"]
covered_digest: "v3:sha256:638666471a62972e3c874af64a0bd5d50369c8ca1e41e26ce3c8617ae260bbec"
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
**Verified:** 2026-10-09
**Status:** passed
**Re-verification:** Yes — after rebase onto new `main` (`9ddfc77`, PR #23 merge containing PR #22 identity bridge, Phase 16 #24, PR #23 pinned releases) with p17 commits replayed on top, plus `69272f1` fixing main's tsc error. Prior verification (passed 11/11 at `20687f1`) predates the rebase; every truth below was re-checked against HEAD `69272f1`.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | EVENT_KINDS equals its v1.2 literal (12, ordered) and SURFACES equals v1.2 literal plus `substrate` last (27, ordered) under plain bun test | ✓ VERIFIED | `vocabulary-lock.test.ts` 2 pass; direct import read: kinds=12, surfaces=27, last=`substrate` |
| 2 | Every EVENT_SOURCES sample passes normalizeEvent unchanged in kind, surface and payload, host-job rows on fixed `substrate` | ✓ VERIFIED | `event-sources.test.ts` 46 pass — round-trip deep-equal, coverage, repo-rule, no-content, surface-rule |
| 3 | A `substrate` token resolves to `substrate`, emits as `substrate`, refused otherwise on /events and via attributedSurface; other non-swarm tokens keep body-first attribution | ✓ VERIFIED | `authority.test.ts` 36 pass; `mcp.ts` attributedSurface wiring intact (32 substrate/attributedSurface refs) |
| 4 | Doc marked table and table name same ids, kinds, surfaces, actions | ✓ VERIFIED | Drift test compares kind+surface+actions per row; markers `<!-- event-sources:start/end -->` at `docs/event-vocabulary.md:51/92` |
| 5 | Every roadmap source has ≥1 row; no periodic row carries repo | ✓ VERIFIED | Prefix guards for `skills.sync`, `dispatch.`, `lanea.`, `mirror.`, `dod.`, `lease.`; direct read: 27 emitting + 9 silent rows |
| 6 | Each of 8 planned tools explicitly in decided set, absent from other, auditMode returns decided mode | ✓ VERIFIED | `policy.test.ts` 14 pass via independent PLANNED_V13 literal; `policy.ts` shows 3 fail-closed + 5 fail-open planned names |
| 7 | Every served registerTool and auditedRest name sits in exactly one set | ✓ VERIFIED | Scan guard test passes; 19 `registerTool` calls in `mcp.ts`, `auditedRest` route guard in `server.ts` |
| 8 | Audit docs record planned tools by phase with reasons and link vocabulary doc | ✓ VERIFIED | `docs/mcp-audit.md:235` links event-vocabulary; `swarm-correlation.md:169` link sentence; store-lock 18 pass |
| 9 | check:phase-close exits 0 here, 2 on missing lock/absent baseline, 1 with diff on any kind/surface change | ✓ VERIFIED | **Re-run by this verifier** at HEAD: exit 0, 80 pass, 12 kinds vs ab62c91, surfaces 27 (baseline + substrate) |
| 10 | One sample per EVENT_SOURCES row stored over wire, zero refusals, read back N/N | ✓ VERIFIED | **Re-run live by this verifier** on own harness `p17-verify2` (port 0, commit 69272f1): 27/27 stored 202, refusals 0, 27/27 read back, 28/28 checks passed; `rehearsal down` removed containers, no leftovers |
| 11 | Both package.json scripts resolve; teardown leaves no container or run dir | ✓ VERIFIED | `smoke:vocabulary` + `check:phase-close` entries confirmed; teardown observed live this run (pid stopped, 2 containers removed) |

**Score:** 11/11 truths verified (0 present, behavior-unverified)

### Rebase-Combination Regression (new main → HEAD)

The rebase replayed p17 onto `9ddfc77`. The one semantic conflict area, `config.ts`/`config.test.ts` (PR #22's `SUBSTRATE_ALLOW_ANONYMOUS` bridge vs WR-01's substrate refusal), was combined, not overwritten — verified in code and tests, not by commit message:

| Item | Bridge (PR #22) present | WR-01 (p17) present |
|------|------------------------|---------------------|
| `config.ts isOperator` | bare-local-run + bridge comments, `allowAnonymous` handling, `unmappedBearer` intact | `&& named !== "substrate"` refusal; docblock names host-job threat model |
| `config.ts configWarnings` | swarm-token listed warning intact | added substrate-listed warning branch, names surface never token |
| `config.ts swarmTokenWarnings` | swarm-seat missing-token message intact | added substrate missing-token (`SUBSTRATE_TOKEN_SUBSTRATE`) branch |
| `config.test.ts` (3 → **11 pass**) | 8 bridge tests (unset/0/1, bridge-not-operator, unmapped bearer, `.env.example` switch) | 3 WR-01 tests (listed substrate refused force, boot names surface without token value, swarm+substrate side-by-side) |
| `.env.example` | `SUBSTRATE_ALLOW_ANONYMOUS=` line 98 | `SUBSTRATE_TOKEN_SUBSTRATE=` line 136, pinned by IN-01 test |
| `authority.test.ts` 36 pass | bridge-era attribution tests green | substrate 27-surface pin + binding + warning tests green |
| `scripts/rehearsal.ts` | — | `69272f1` guards undefined `ss` stdout (TS18048); `bunx tsc --noEmit` exit 0 confirms |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/event-sources.ts` | SurfaceRule/EventSource/EVENT_SOURCES/SILENT_SOURCES, imports only ./types.ts | ✓ VERIFIED | Single type-only import (line 15); 27 emitting + 9 silent rows by direct read |
| `packages/mcp-server/src/event-sources.test.ts` | round-trip, drift, coverage, repo, no-content, surface-rule tests | ✓ VERIFIED | 46 pass |
| `packages/mcp-server/src/vocabulary-lock.test.ts` | ordered-literal pins 12 kinds / 27 surfaces | ✓ VERIFIED | 2 pass |
| `packages/mcp-server/src/types.ts` | substrate appended last, kinds unchanged | ✓ VERIFIED | Direct read confirms; lock still green |
| `packages/mcp-server/src/mcp.ts` | attributedSurface binds substrate callers | ✓ VERIFIED | Wiring refs intact; PR #22's mcp changes did not displace it |
| `packages/mcp-server/src/config.ts` | bridge + WR-01 exclusion + IN-02 warning | ✓ VERIFIED | Combined isOperator, both warning branches, no token values leaked |
| `packages/mcp-server/src/config.test.ts` | bridge + WR-01 pins | ✓ VERIFIED | 11 pass (8 bridge + 3 substrate) |
| `packages/mcp-server/src/authority.test.ts` | 27-surface pin + binding + warning tests | ✓ VERIFIED | 36 pass |
| `.env.example` | bridge switch + blank SUBSTRATE_TOKEN_SUBSTRATE line | ✓ VERIFIED | Both lines present, both pinned by tests |
| `docs/event-vocabulary.md` | reviewed mapping + marked table + silent rows + non-normative herdr | ✓ VERIFIED | Markers present; silent +2; herdr rephrased |
| `packages/audit/src/policy.ts` | 8 planned entries, auditMode unchanged | ✓ VERIFIED | 3 closed + 5 open planned names; 14 pass |
| `packages/audit/src/policy.test.ts` | PLANNED_V13 + scan guard | ✓ VERIFIED | 14 pass |
| `docs/mcp-audit.md` / `docs/swarm-correlation.md` | planned table + links | ✓ VERIFIED | Links at mcp-audit.md:235, swarm-correlation.md:169 |
| `scripts/phase-close-check.ts` + test | gate + pure helpers + IN-04 guards | ✓ VERIFIED | 16 pass, gate exit 0 |
| `scripts/vocabulary-smoke.ts` + test | smoke + guards | ✓ VERIFIED | 10 pass; live 28/28 this run |
| `scripts/rehearsal.ts` | 69272f1 undefined-stdout guard | ✓ VERIFIED | tsc exit 0; harness up/smoke/down all worked |
| `package.json` | two script entries only | ✓ VERIFIED | Both scripts ran this verification |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| samples | normalizeEvent | write-path gate round-trip test | WIRED | deep-equal per row, 46 pass |
| doc table | EVENT_SOURCES | event-sources markers parse test | WIRED | id/kind/surface/action equality |
| substrate token | substrate surface | tokenEnvName, surfaceForToken, attributedSurface | WIRED | unit + /events tests |
| substrate token | operator refusal | isOperator + configWarnings (bridge-aware) | WIRED | config.test.ts 11 pass (bridge + WR-01 side by side) |
| PLANNED_V13 literal | policy sets | independent literal test | WIRED | editing either side fails |
| policy sets | mcp.ts/server.ts names | scan guard regex | WIRED | membership-only, counts-free |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| event-sources.ts samples | sample() payloads | literal per-row fixtures through real normalizeEvent | ✓ | FLOWING (proven, not mocked) |
| phase-close-check | EVENT_KINDS/SURFACES | git show ab62c91 baseline + live import | ✓ | FLOWING |
| vocabulary-smoke | stored/readback counts | live harness POST /events + events/query on p17-verify2 | ✓ | FLOWING (this-run transcript: 27/27, 0 refusals) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| lock tests green | `bun test ./packages/mcp-server/src/vocabulary-lock.test.ts` | 2 pass 0 fail | ✓ PASS |
| samples green | `bun test ./packages/mcp-server/src/event-sources.test.ts` | 46 pass 0 fail | ✓ PASS |
| config green (combined) | `bun test ./packages/mcp-server/src/config.test.ts` | 11 pass 0 fail | ✓ PASS |
| authority green | `bun test ./packages/mcp-server/src/authority.test.ts` | 36 pass 0 fail | ✓ PASS |
| policy green | `bun test ./packages/audit/src/policy.test.ts` | 14 pass 0 fail | ✓ PASS |
| gate helpers green | `bun test ./scripts/phase-close-check.test.ts` | 16 pass 0 fail | ✓ PASS |
| smoke guards green | `bun test ./scripts/vocabulary-smoke.test.ts` | 10 pass 0 fail | ✓ PASS |
| store-lock green | `bun test ./packages/mcp-server/src/store-lock.test.ts` | 18 pass 0 fail | ✓ PASS |
| 8-file phase battery | `bun test` on the 8 phase files | 153 pass 0 fail | ✓ PASS |
| full suite (regression) | `bun test` | 1421 pass, 56 skip, 1 pre-existing fail (52 files) | ✓ PASS with noted exception |
| tsc clean | `bunx tsc --noEmit` | exit 0 | ✓ PASS |
| gate green | `bun run check:phase-close` | exit 0, 80 pass, 12 kinds / 27 surfaces | ✓ PASS |
| live smoke | `rehearsal up --name p17-verify2 --port 0` + `smoke:vocabulary` + `rehearsal down` | 27/27 stored, 0 refusals, 27/27 read back, 28/28 checks; teardown clean | ✓ PASS |

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
| changed source files | — | No TODO/FIXME/XXX/TBD/placeholder/`Not implemented` in any phase source/test/script file or doc | — | Clean scan this run |

Prohibitions (all three plans) re-confirmed: `event-sources.ts` imports only `./types.ts`; no EVENT_KINDS/normalizeEvent/MEMORY_KINDS/hash-chain change; no `registerTool`/`KNOWN_TOOLS`/`auditedRest` additions in 17-02 scope (PR #22's mcp/server changes predate the rebase base and the scan guard passes over them); smoke reads URL/bearer only from the named instance's consumer.env; no secret values in any touched file.

### Known Pre-Existing Failure (not a phase gap)

`packages/audit/src/log.test.ts` > "the scan does not go quadratic once the window is full" timed out (5000ms) under host load during this run's full suite. Per assignment brief this timing test also fails on `main` under current host load; its code is unchanged since PR #7 and it exercises the audit ring-scan, not phase 17's policy sets (`policy.test.ts` 14/14 green). Recorded as environmental, not a gap. Full-suite tally with it excluded: 1421 pass, 56 skip, 0 real fail.

### Human Verification Required

None. All truths have automated behavioral evidence (unit suites + gate + live harness transcript run by this verifier). No visual, real-time, or external-service behavior is asserted.

### Gaps Summary

No gaps. Phase goal achieved at HEAD `69272f1`: the closed vocabulary (12 kinds, 27 surfaces with `substrate`) is typed, locked, drift-tested against its document, proven over the wire with zero refusals on a fresh harness run, and the eight planned tools carry explicit audit modes guarded against undecided registration. The rebase onto new main combined cleanly — PR #22's anonymous bridge and WR-01's substrate refusal coexist in `config.ts` with both test families green (config.test.ts 3 → 11), and `69272f1` keeps `tsc` clean. Later phases implement against `EVENT_SOURCES`/`SILENT_SOURCES` and re-run `check:phase-close`.

---
_Verified: 2026-10-09_
_Verifier: Reverify17b (gsd-verifier)_
