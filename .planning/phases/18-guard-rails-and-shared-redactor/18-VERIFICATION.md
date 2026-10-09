---
phase: 18-guard-rails-and-shared-redactor
verified: 2026-10-09T00:00:00Z
status: passed
score: 21/21 must-haves verified
covered_files: [".planning/phases/18-guard-rails-and-shared-redactor/18-01-PLAN.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-01-SUMMARY.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-02-PLAN.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-02-SUMMARY.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-03-PLAN.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-03-SUMMARY.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-04-PLAN.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-04-SUMMARY.md", "docs/greptime-ledger.md", "docs/memory-governance.md", "docs/observability.md", "docs/redaction.md", "packages/cli/src/lessons.ts", "packages/mcp-server/src/memory-classify.test.ts", "packages/mcp-server/src/redact-contract.test.ts", "packages/mcp-server/src/redact-lock.test.ts", "packages/mcp-server/src/redact.test.ts", "packages/mcp-server/src/redact.ts"]
covered_digest: "v3:sha256:05c9e242956d13bcee87e11c48a810753a1501e1b918f614025adeee45870052"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 18: Guard Rails and Shared Redactor Verification Report

**Phase Goal:** One redactor protects every v1.3 publication path: the collectors, `docs_ingest`, `skills_propose` and anything anchored all import it, and it keeps main's counter exemption.
**Verified:** 2026-10-09
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | D18-01: all 11 D-04 shapes redact on the event path in September order, pk-rk in narrowed form | ✓ VERIFIED | `redact.ts:18-72`: 30 labelled entries; `private-tag` first, `api-key-lower` right after `assignment`, `aws`→`pk-rk` before `jwt`; order pinned by `redact-contract.test.ts` (green) |
| 2 | D18-02: `redactValue` keeps SENSITIVE_KEY, COUNTER_KEY, isCount, null/undefined pass-through | ✓ VERIFIED | `redact.ts:88-143` untouched semantics; spot-checks: counts survive, `{tokens: fixture}` redacts whole |
| 3 | D18-03: every event rule has a unique stable name exported read-only; `redact()` signature/output unchanged | ✓ VERIFIED | `RedactionRuleName` derived type + read-only `REDACTION_RULES` exported; loop only destructures entries; no caller file modified (diff scope: `redact.ts`, tests, `lessons.ts`, docs only) |
| 4 | D18-04: one runtime-assembled fixture per rule name; removal with context intact, idempotent, reachable via redactValue; coverage test fails without fixture | ✓ VERIFIED | `FIXTURES: Record<RedactionRuleName,…>` in `redact.test.ts` (tsc enforces totality); coverage + uniqueness tests green |
| 5 | D18-05: COUNTER_KEY names keep numeric/digit-string values; `{tokens: fixture}` and short `api_key` redact whole | ✓ VERIFIED | D-04 counter test green; spot-checks: `input_tokens: 1200` and `output_tokens: "340"` survive, `tokens: <AKIA>` → `[REDACTED]` |
| 6 | D18-06: September near-misses and over-redaction guards survive | ✓ VERIFIED | Suite green; spot-checks: 15-char AKIA, short pk-, `KEYBOARD_LAYOUT` all survive |
| 7 | D18-17: `<private>` and D-04 memory bodies classify secret/unreleasable | ✓ VERIFIED | `memory-classify.test.ts:29,37,46` secret + `reviewable: false`; prose/slugs null; `memory-classify.ts` unmodified |
| 8 | D18-21: pk-rk requires a digit in the tail; digit keys redact, word-only slugs survive | ✓ VERIFIED | Narrowed pattern in both passes (`redact.ts:67` + skill entry); spot-checks pass; deviation documented in `docs/redaction.md:55` |
| 9 | D18-07: September skill engine lives in `redact.ts`; event pass unchanged/liberal | ✓ VERIFIED | `SKILL_RULES` 29 entries + `redactSkillContent`/`scanSkillFiles` present; liberal-event test green |
| 10 | D18-08: 6 new high-confidence findings; pk-rk/private-tag/api-key-lower contextual with placeholder handling | ✓ VERIFIED | 16 high-confidence rules incl. google/slack/npm/gitlab/digitalocean/openai-proj; spot-check slack finding; placeholder tests green; skill patterns keep `[ \t]` + `d` flag |
| 11 | D18-09: parity test fails on unmatched event rule without reasoned exclusion | ✓ VERIFIED | Parity suite `redact.test.ts:548-564` green; negative-checked both ways (drop npm entry / drop exclusion both fail) |
| 12 | D18-10: `scanSkillFiles` is the only publication-path scan | ✓ VERIFIED | Namespace export-surface test pins `scanSkillFiles` as the only `scan*` export |
| 13 | D18-11: `redactKnown` longest-first ignoring empties; `lessons.ts` migrated, tests unchanged | ✓ VERIFIED | `redactKnown` exported; `lessons.ts:810` calls it; no `replaceAll` with REDACTED remains; `lessons.test.ts` green unmodified; helper tests green |
| 14 | D18-12: `redact-lock.test.ts` beside `store-lock.test.ts`, same idioms, `[]` offenders, plain `bun test` | ✓ VERIFIED | New 579-line file; 13 lock tests green; `store-lock.test.ts` byte-identical (empty diff vs base) |
| 15 | D18-13: imports-away, redactor definitions, markers/replaces, credential detectors fail the lock | ✓ VERIFIED | Four detectors green on tree (each asserts `[]`); planted end-to-end offender failed all four rules (per SUMMARY, reverted) |
| 16 | D18-14: audit/observability injected seams allowlisted with cycle reason; constructions pass shared redact | ✓ VERIFIED | `INJECTED_SEAMS` exactly 3 paths; companion tests pin `observe.ts` as only construction site with shared `redact`; contract test re-pins the 3-file set |
| 17 | D18-15: each detector fails planted offenders, passes non-offenders | ✓ VERIFIED | Self-tests green (offenders per non-null DETECTOR entry + coverage pin); nulling a detector fails the suite (verified live per SUMMARY) |
| 18 | D18-16: no advance exemption for Phase 19's installed-path hook | ✓ VERIFIED | No Phase 19 exemption in lock; allowlist is exactly the 3 cycle-bound files; Muse placeholder template proven as passing non-offender |
| 19 | D18-18: `docs/redaction.md` complete; 3 pointers; no CHANGELOG | ✓ VERIFIED | All 6 required sections + D18-21 deviation + verbatim gaps + pre-restart rows; pointers at anchors with relative links; no CHANGELOG created; store-lock shows no new offender from docs |
| 20 | D18-19: suite/tsc vs baseline; named verification; round trip run or skip recorded | ✓ VERIFIED | Full suite 1404/57/1 (matches expected; 1 fail = HEAD-present `18-PATTERNS.md` flag); tsc clean; targeted 218/1/0; round trip evidenced by 18-04-SUMMARY (instance p18, 174/0/0, twin torn down; Docker barred to verifier per instructions) |
| 21 | D18-20: SUMMARY and PR body carry the restart line | ✓ VERIFIED | Line present verbatim in 18-04-SUMMARY body and PR-body block |

**Score:** 21/21 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/redact.ts` | 30-entry labelled RULES, skill engine, redactKnown | ✓ VERIFIED | 354 lines; 30 RULES, 29 SKILL_RULES, 16 high-confidence, 1 exclusion; all exports present |
| `packages/mcp-server/src/redact.test.ts` | Fixture corpus, skill/parity/round-trip tests | ✓ VERIFIED | 643 lines; corpus + coverage + parity + gated round trip with loopback/not-7410 guards |
| `packages/mcp-server/src/redact-lock.test.ts` | Four-rule lock + seams + self-tests | ✓ VERIFIED | 579 lines, 13 tests, all green on tree |
| `packages/mcp-server/src/redact-contract.test.ts` | Order/line-local/doc-table/scope pins | ✓ VERIFIED | 100 lines, green (validate-phase gap closure, commit e59dee7) |
| `packages/mcp-server/src/memory-classify.test.ts` | Quarantine tests | ✓ VERIFIED | Private-tag, D-04, digit-pk secret; prose/slugs null; `memory-classify.ts` unmodified |
| `packages/cli/src/lessons.ts` | Migrated scrubber | ✓ VERIFIED | Calls `redactKnown`; `REDACTED` import dropped; behavior-identical |
| `docs/redaction.md` | Topic doc | ✓ VERIFIED | 171 lines, all sections, D18-21 + gaps + pre-restart |
| 3 doc pointers | greptime-ledger, memory-governance, observability | ✓ VERIFIED | Relative links at anchors |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `redact.ts` RULES | `redact()` loop → `redactValue()` exemption | table → loop → counter check | ✓ WIRED | Order + exemption spot-checked behaviorally |
| `SKILL_RULES` names | parity test → `REDACTION_RULES` names | `SKILL_RULE_NAMES` vs exclusions | ✓ WIRED | Parity negative-checked both directions |
| `scanSkillFiles` findings | future `skills_propose`/`docs_ingest` refusal | file/line/rule hits, never values | ✓ WIRED | Findings carry no values; no second scan API exists |
| `lessons.ts` diagnostics | `redactKnown` → `redact()` before cap | line 810 | ✓ WIRED | `lessons.test.ts` green unchanged |
| `redact-lock.test.ts` detectors | every package source → shared `redact.ts` | 4 rules + seam companion | ✓ WIRED | Green on tree; fires on planted offenders |
| Gated describe | `consumer.env` → rehearsal twin (never production) | loopback + not-7410 asserts first | ✓ WIRED | Guards precede first fetch; evidenced run on p18 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `redact()` | event text | 30-pattern table applied in order | ✓ FLOWING | Spot-checks: D-04 shapes → `[REDACTED]`, context intact |
| `redactValue()` | usage counts | COUNTER_KEY + isCount exemption | ✓ FLOWING | `input_tokens`/`output_tokens` survive numerically; fixtures redact whole |
| `redactSkillContent` | findings/redactions | SKILL_RULES with placeholder logic | ✓ FLOWING | Slack finding reported; placeholders kept; no values in hits |
| `redactKnown()` | diagnostic strings | caller-known values, longest-first | ✓ FLOWING | Longest-first ordering spot-checked |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| AWS key redacts whole with context | `bun -e` redact AKIA+16 exact token | `"key [REDACTED] end"` | ✓ PASS |
| Counters survive | `redactValue({input_tokens:1200})` / `{"340"}` | `1200` / `"340"` | ✓ PASS |
| `{tokens: fixture}` redacts whole | `redactValue` | `[REDACTED]` | ✓ PASS |
| Word-only pk slug survives, digit pk redacts | `redact()` both | survive / redacted | ✓ PASS |
| Near-miss + KEYBOARD_LAYOUT survive | `redact()` | intact | ✓ PASS |
| `redactKnown` longest-first | `redactKnown("ab abc",…)` | both `[REDACTED]` | ✓ PASS |
| Skill slack finding | `redactSkillContent` | 1 finding | ✓ PASS |

One initial probe FAIL was a probe-side fixture error (24-char AKIA token defeats the trailing `\b`); re-run with the exact 20-char shape passed. The redactor is correct; no code issue.

### Probe Execution

No phase-declared `scripts/*/tests/probe-*.sh` probes exist for this phase. Step 7c: NOT APPLICABLE.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| LANEB-06 | 18-01/02/03/04 | One shared redactor: D-04 rules + COUNTER_KEY exemption; collectors, docs_ingest, skills_propose, anchored all use it | ✓ SATISFIED | SC1: 30-rule table + per-rule fixtures + exemption (truths 1–8). SC2: skill engine in-module + 4-rule lock with no second redactor and no advance exemptions (truths 9–18). Proof recorded (truths 19–21). Future consumers (19/21/25/28) inherit via the lock: the alternative fails `bun test` |

No orphaned requirements: REQUIREMENTS.md maps exactly `[LANEB-06]` to Phase 18, and all four plans carry it. 18-04-SUMMARY marks `requirements-completed: [LANEB-06]`; REQUIREMENTS.md traceability already shows LANEB-06 Complete.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | No TBD/FIXME/XXX, stubs, empty handlers, hardcoded-empty render data, or console-log-only implementations in phase files | — | None |
| `redact.ts:273` | PLACEHOLDER_PREFIXES | Prefix-match placeholder bypass (review WR-02) | 📋 Advisory | September-inherited, D18-08-mandated ("usual placeholder handling"); no production caller yet; open in 18-REVIEW-DISPOSITION, not a must-have violation |
| `redact.ts:252,307` | Skill rule order vs overlap-skip (review WR-01) | Private prose can survive beside an inner high-confidence hit (review probe) | 📋 Advisory | Documented high-confidence-first design; inner shape still reported as finding so a well-behaved caller refuses; open in disposition, not a must-have violation |
| `redact.ts:147-152` | `redactKnown` re-scans markers (review IN-01) | Over-redaction on adversarial needles only; never leaks | ℹ️ Info | — |
| `lessons.ts:808` | Duplicate sort/filter (review IN-02) | Two places encode ordering; behavior-identical | ℹ️ Info | — |
| `docs/redaction.md:52-53` | D-04 row miscount (review IN-03) | Doc wording only; enforcement is in tests | ℹ️ Info | — |
| `redact-lock.test.ts:38,58` | IGNORED misses build/venv (review IN-04) | Local-artifact false-positive risk only | ℹ️ Info | — |
| `redact-lock.test.ts:558-568` | Pipeline self-test granularity (review IN-05) | Two detectors proven via raw-line path only | ℹ️ Info | — |

Review findings WR-01/WR-02 + IN-01..IN-05 remain `open` (untriaged) in 18-REVIEW-DISPOSITION.md. None contradicts a plan must-have (all describe September-inherited behavior the plans explicitly kept, or non-blocking quality notes); none blocks the phase goal. They are recorded here as advisory for the follow-up triage, not as gaps.

### Human Verification Required

None. No visual, user-flow, real-time, external-service, or performance-feel items. The harness round trip (the one behavior needing a live twin) already ran under 18-04 with recorded evidence; Docker is barred to this verifier and the round trip is accepted via 18-04-SUMMARY per assignment instructions.

### Gaps Summary

No gaps. All 21 must-haves verified against the codebase with behavioral evidence; full suite 1404 pass / 57 skip / 1 fail matches the expected HEAD counts (the 1 fail is the HEAD-present store-lock flag on `18-PATTERNS.md`, committed before execution, untouched by this phase); `bunx tsc --noEmit` clean; `store-lock.test.ts` byte-identical to base; no CHANGELOG created (none exists). LANEB-06 is satisfied: the single redactor carries every September D-04 pattern (with the operator-approved D18-21 pk-rk narrowing) plus the counter exemption, the skill pass lives in the same module behind a parity test, and the repo lock fails the build on any second redactor with no exemptions for the future consumers in Phases 19/21/25/28.

---

_Verified: 2026-10-09_
_Verifier: Claude (gsd-verifier)_
