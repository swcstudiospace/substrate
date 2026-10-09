---
phase: 18-guard-rails-and-shared-redactor
verified: 2026-10-09T05:29:09Z
status: passed
score: 21/21 must-haves verified
covered_files: [".planning/phases/18-guard-rails-and-shared-redactor/18-01-PLAN.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-01-SUMMARY.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-02-PLAN.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-02-SUMMARY.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-03-PLAN.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-03-SUMMARY.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-04-PLAN.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-04-SUMMARY.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-REVIEW.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-REVIEW-DISPOSITION.md", "docs/greptime-ledger.md", "docs/memory-governance.md", "docs/observability.md", "docs/redaction.md", "packages/cli/src/lessons.ts", "packages/mcp-server/src/memory-classify.test.ts", "packages/mcp-server/src/redact-contract.test.ts", "packages/mcp-server/src/redact-lock.test.ts", "packages/mcp-server/src/redact.test.ts", "packages/mcp-server/src/redact.ts", "packages/mcp-server/src/store-lock.test.ts"]
covered_digest: "v1:sha256:b5f1cf1535a41a6740e3d5334bce316c1d63b774b66028c866ba90693af157be"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 21/21
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 18: Guard Rails and Shared Redactor Verification Report

**Phase Goal:** One redactor protects every v1.3 publication path: the collectors, `docs_ingest`, `skills_propose` and anything anchored all import it, and it keeps main's counter exemption.
**Verified:** 2026-10-09T05:29:09Z
**Status:** passed
**Re-verification:** Yes — re-verified against current HEAD after rebase onto main (merge-base `9ddfc77`, includes PR #22 identity bridge, PR #24 Phase 16 harness, PR #23 pinned releases) plus the seven review-fix commits (`1190d4e` WR-01, `a6971c4` WR-02, `fd13c83` IN-01, `d216599` IN-02, `ff2adf1` IN-03, `dae72e3` IN-04, `7316071` IN-05) with `18-REVIEW-DISPOSITION.md` showing 0 open / 7 fixed.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | D18-01: all 11 D-04 shapes redact on the event path in September order, pk-rk in narrowed form | ✓ VERIFIED | `redact.ts` 30 labelled entries; `private-tag` first, `api-key-lower` after `assignment`, `aws`→`pk-rk` before `jwt`; order pinned by `redact-contract.test.ts` (green in 216-file run) |
| 2 | D18-02: `redactValue` keeps SENSITIVE_KEY, COUNTER_KEY, isCount, null/undefined pass-through | ✓ VERIFIED | Counter semantics untouched; spot-checks: `input_tokens: 1200` and `output_tokens: "340"` survive, `{tokens: fixture}` redacts whole |
| 3 | D18-03: every event rule has a unique stable name exported read-only; `redact()` signature/output unchanged | ✓ VERIFIED | `RedactionRuleName` derived type + read-only `REDACTION_RULES`; no caller file modified (diff scope vs `9ddfc77`: `redact.ts`, tests, `lessons.ts`, docs only) |
| 4 | D18-04: one runtime-assembled fixture per rule name; removal with context intact, idempotent, reachable via redactValue; coverage test fails without fixture | ✓ VERIFIED | `FIXTURES: Record<RedactionRuleName,…>` (tsc enforces totality); coverage + uniqueness tests green |
| 5 | D18-05: COUNTER_KEY names keep numeric/digit-string values; `{tokens: fixture}` and short `api_key` redact whole | ✓ VERIFIED | D-04 counter tests green in the 216-file run |
| 6 | D18-06: September near-misses and over-redaction guards survive | ✓ VERIFIED | Suite green; 15-char AKIA, short pk-, `KEYBOARD_LAYOUT` survive (re-spot-checked via counter/near-miss tests passing) |
| 7 | D18-17: `<private>` and D-04 memory bodies classify secret/unreleasable | ✓ VERIFIED | `memory-classify.test.ts` secret + `reviewable: false`; prose/slugs null; `memory-classify.ts` unmodified (83/83 lessons+classify green) |
| 8 | D18-21: pk-rk requires a digit in the tail; digit keys redact, word-only slugs survive | ✓ VERIFIED | Narrowed pattern in both passes; deviation documented in `docs/redaction.md:52-62` with D-04 classes now named explicitly (IN-03 fix `ff2adf1`) |
| 9 | D18-07: September skill engine lives in `redact.ts`; event pass unchanged/liberal | ✓ VERIFIED | `SKILL_RULES` + `redactSkillContent`/`scanSkillFiles` present; liberal-event test green |
| 10 | D18-08: 6 new high-confidence findings; pk-rk/private-tag/api-key-lower contextual with placeholder handling | ✓ VERIFIED | 16 high-confidence rules; WR-01 fix (`1190d4e`): private blocks claimed first, inner high-confidence shapes reported as findings — live-checked (`github` finding inside `<private>` block). WR-02 fix (`a6971c4`): `PLACEHOLDER_VALUE` is now a full-shape alternation — live-checked (real value starting with a placeholder word redacts; true `placeholder-key-here` kept with 0 hits) |
| 11 | D18-09: parity test fails on unmatched event rule without reasoned exclusion | ✓ VERIFIED | Parity suite green; exclusion list exactly `keypair-array` |
| 12 | D18-10: `scanSkillFiles` is the only publication-path scan | ✓ VERIFIED | Namespace export-surface test pins `scanSkillFiles` as the only `scan*` export |
| 13 | D18-11: `redactKnown` longest-first ignoring empties; `lessons.ts` migrated, tests unchanged | ✓ VERIFIED | `redactKnown` exported; `lessons.ts:809` calls it; no `replaceAll` with REDACTED remains. IN-01 fix (`fd13c83`): single alternation applied per non-marker segment, markers never rescanned — live-checked (needle `RED` inside `[REDACTED]` no longer splices, output idempotent). IN-02 fix (`d216599`): duplicated ordering dropped from `lessons.ts`; `lessons.test.ts` green unmodified |
| 14 | D18-12: `redact-lock.test.ts` beside `store-lock.test.ts`, same idioms, `[]` offenders, plain `bun test` | ✓ VERIFIED | 580-line file; lock tests green; `store-lock.test.ts` unmodified by phase (no diff vs `9ddfc77` on that file) |
| 15 | D18-13: imports-away, redactor definitions, markers/replaces, credential detectors fail the lock | ✓ VERIFIED | Four detectors green on tree; IN-04 fix (`dae72e3`): `IGNORED` now also skips `dist|build|.venv|venv|__pycache__` so local artifacts cannot fail the lock |
| 16 | D18-14: audit/observability injected seams allowlisted with cycle reason; constructions pass shared redact | ✓ VERIFIED | `INJECTED_SEAMS` pins the cycle-bound files; companion tests pin `observe.ts` as the only construction site with shared `redact` |
| 17 | D18-15: each detector fails planted offenders, passes non-offenders | ✓ VERIFIED | Self-tests green. IN-05 fix (`7316071`): self-test now asserts `patternCandidates` extraction reaches each detector (`extracted: true` per rule), closing the raw-line-only gap |
| 18 | D18-16: no advance exemption for Phase 19's installed-path hook | ✓ VERIFIED | No Phase 19 exemption in lock; lock checks the repository only |
| 19 | D18-18: `docs/redaction.md` complete; 3 pointers; no CHANGELOG | ✓ VERIFIED | All required sections + D18-21 deviation with named D-04 classes + verbatim gaps + pre-restart rows; pointers at anchors with relative links (`greptime-ledger.md:157`, `memory-governance.md:135`, `observability.md:121`); no CHANGELOG exists |
| 20 | D18-19: suite/tsc vs baseline; named verification; round trip run | ✓ VERIFIED | Targeted 4-file run: **216 pass / 1 skip / 0 fail**. Full suite: **1521 pass / 57 skip / 1 fail** — the 1 fail is the known pre-existing timing test `packages/audit/src/log.test.ts` "the scan does not go quadratic once the window is full" (fails on main under host load, code unchanged since PR #7; not a phase gap). `bunx tsc --noEmit` reports exactly one error, `scripts/rehearsal.ts(430,21) TS18048`, in a Phase 16 file this phase never touches — pre-existing on main, fixed on Phase 17's branch (commit `69272f1`, not ancestor of this HEAD); not a phase gap. Round trip: verifier ran it live on own twin (`--name p18-verify`, `SUBSTRATE_REHEARSAL_PG_IMAGE=postgres:16` since only `postgres:16` is cached locally and the harness never pulls): `redact.test.ts -t "round trip"` **1 pass**, full file under twin env **177 pass / 0 fail**; twin torn down (`no instance`) |
| 21 | D18-20: SUMMARY and PR body carry the restart line | ✓ VERIFIED | `Redaction widens on the production write path at the operator's next approved restart of `substrate-mcp`; nothing restarts in this PR.` present verbatim in 18-04-SUMMARY (line 70) and PR-body block |

**Score:** 21/21 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/redact.ts` | 30-entry labelled RULES, skill engine, redactKnown | ✓ VERIFIED | 30 RULES, 29 SKILL_RULES, 16 high-confidence, 1 exclusion; WR-01/WR-02/IN-01 fixes present and behaviorally checked |
| `packages/mcp-server/src/redact.test.ts` | Fixture corpus, skill/parity/round-trip tests | ✓ VERIFIED | Corpus + coverage + parity + gated round trip with loopback/not-7410 guards; round trip passes live |
| `packages/mcp-server/src/redact-lock.test.ts` | Four-rule lock + seams + self-tests | ✓ VERIFIED | 580 lines; IN-04/IN-05 fixes present; green on tree |
| `packages/mcp-server/src/redact-contract.test.ts` | Order/line-local/doc-table/scope pins | ✓ VERIFIED | Green in targeted run |
| `packages/mcp-server/src/memory-classify.test.ts` | Quarantine tests | ✓ VERIFIED | Private-tag, D-04, digit-pk secret; prose/slugs null; `memory-classify.ts` unmodified |
| `packages/cli/src/lessons.ts` | Migrated scrubber | ✓ VERIFIED | Calls `redactKnown` (line 809); IN-02 dedup applied; behavior-identical, tests green unchanged |
| `docs/redaction.md` | Topic doc | ✓ VERIFIED | All sections incl. named D-04 classes (IN-03), gaps, pre-restart |
| 3 doc pointers | greptime-ledger, memory-governance, observability | ✓ VERIFIED | Relative links at anchors |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `redact.ts` RULES | `redact()` loop → `redactValue()` exemption | table → loop → counter check | ✓ WIRED | Order + exemption covered by contract and counter tests |
| `SKILL_RULES` names | parity test → `REDACTION_RULES` names | `SKILL_RULE_NAMES` vs exclusions | ✓ WIRED | Parity green; exclusion exactly `keypair-array` |
| `scanSkillFiles` findings | future `skills_propose`/`docs_ingest` refusal | file/line/rule hits, never values | ✓ WIRED | Findings carry no values; no second scan API exists |
| `lessons.ts` diagnostics | `redactKnown` → `redact()` before cap | `diagnostic()` | ✓ WIRED | `lessons.test.ts` green unchanged |
| `redact-lock.test.ts` detectors | every package source → shared `redact.ts` | 4 rules + seam companion | ✓ WIRED | Green on tree; self-tests prove detectors fire |
| Gated describe | `consumer.env` → rehearsal twin (never production) | loopback + not-7410 asserts first | ✓ WIRED | Verifier ran it live on `p18-verify`; guards precede first fetch |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `redact()` | event text | 30-pattern table applied in order | ✓ FLOWING | D-04 shapes → `[REDACTED]`, context intact |
| `redactValue()` | usage counts | COUNTER_KEY + isCount exemption | ✓ FLOWING | Counts survive numerically; fixtures redact whole |
| `redactSkillContent` | findings/redactions | SKILL_RULES with shape-match placeholder logic | ✓ FLOWING | Inner-block `github` finding live-checked; placeholders kept |
| `redactKnown()` | diagnostic strings | caller-known values, longest-first, markers skipped | ✓ FLOWING | Longest-first + marker-safety live-checked |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Private block with inner github shape → block redacted + github finding | `bun -e` redactSkillContent | text has `[REDACTED]`, findings `["github"]` | ✓ PASS |
| Real value starting with placeholder word still redacts | `bun -e` redactSkillContent | finding/redaction reported | ✓ PASS |
| True `placeholder-key-here` kept with 0 hits | `bun -e` redactSkillContent | kept, 0 hits | ✓ PASS |
| `redactKnown` needle inside `[REDACTED]` does not splice; idempotent | `bun -e` redactKnown | no splice, idempotent | ✓ PASS |
| Gated round trip against own twin | `bun test redact.test.ts -t "round trip"` under `p18-verify` consumer.env | 1 pass, 22 expects | ✓ PASS |

### Probe Execution

No phase-declared `scripts/*/tests/probe-*.sh` probes exist for this phase. Step 7c: NOT APPLICABLE.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| LANEB-06 | 18-01/02/03/04 | One shared redactor: D-04 rules + COUNTER_KEY exemption; collectors, docs_ingest, skills_propose, anchored all use it | ✓ SATISFIED | SC1: 30-rule table + per-rule fixtures + exemption (truths 1–8). SC2: skill engine in-module + 4-rule lock with no second redactor and no advance exemptions (truths 9–18). Proof recorded with live round trip (truths 19–21). Future consumers (19/21/25/28) inherit via the lock |

No orphaned requirements: REQUIREMENTS.md maps exactly `[LANEB-06]` to Phase 18, and all four plans carry it.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | No TBD/FIXME/XXX, stubs, empty handlers, hardcoded-empty render data, or console-log-only implementations in phase files (grep clean apart from the intentional placeholder-handling symbols) | — | None |

All seven review findings (WR-01/WR-02, IN-01..IN-05) are `fixed` in `18-REVIEW-DISPOSITION.md` (0 open) and each fix was verified present in code plus behaviorally spot-checked where runtime-observable (WR-01, WR-02, IN-01). No advisory items remain.

### Human Verification Required

None. No visual, user-flow, real-time, external-service, or performance-feel items. The harness round trip (the one behavior needing a live twin) was run live by this verifier on instance `p18-verify` with recorded evidence above; the twin was torn down afterwards.

### Gaps Summary

No gaps. All 21 must-haves verified against current HEAD with behavioral evidence; the rebase onto main introduces no regressions (targeted redaction/lock/contract/store-lock files 216 pass / 1 skip / 0 fail; full suite 1521 pass / 57 skip / 1 fail where the single failure is the known pre-existing audit timing test; the single tsc error is pre-existing in Phase 16's `scripts/rehearsal.ts` and untouched by this phase). LANEB-06 is satisfied: the single redactor carries every September D-04 pattern (with the operator-approved D18-21 pk-rk narrowing) plus the counter exemption, the skill pass lives in the same module behind a parity test, and the repo lock fails the build on any second redactor with no exemptions for the future consumers in Phases 19/21/25/28.

---

_Verified: 2026-10-09T05:29:09Z_
_Verifier: Claude (gsd-verifier)_
