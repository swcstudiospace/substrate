---
phase: 18-guard-rails-and-shared-redactor
verified: 2026-11-12T08:27:16Z
status: passed
score: 21/21 must-haves verified
covered_files: ["packages/mcp-server/src/redact.ts", "packages/mcp-server/src/redact.test.ts", "packages/mcp-server/src/redact-lock.test.ts", "packages/mcp-server/src/redact-adversarial.test.ts", "packages/mcp-server/src/redact-contract.test.ts", "packages/mcp-server/src/memory-classify.ts", "packages/mcp-server/src/memory-classify.test.ts", "packages/mcp-server/src/store-lock.test.ts", "packages/cli/src/lessons.ts", "docs/redaction.md", "docs/greptime-ledger.md", "docs/memory-governance.md", "docs/observability.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-01-PLAN.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-01-SUMMARY.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-02-PLAN.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-02-SUMMARY.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-03-PLAN.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-03-SUMMARY.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-04-PLAN.md", ".planning/milestones/v1.3-phases/18-guard-rails-and-shared-redactor/18-04-SUMMARY.md"]
covered_digest: "v3:sha256:b6723f424cba5e3f77d1cee3f92667fee7acc878da7f50c5daf082350a5c7c67"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 21/21 must-haves verified
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 18: Guard Rails and Shared Redactor Verification Report

**Phase Goal:** One redactor protects every v1.3 publication path: the collectors, `docs_ingest`, `skills_propose` and anything anchored all import it, and it keeps main's counter exemption.
**Verified:** 2026-11-12T08:27:16Z
**Status:** passed
**Re-verification:** Yes — verifier re-run at HEAD `33c400d1`. The prior report (2026-10-11, `ed696ef`) is superseded. Its line numbers were stale: `redact.ts` now has 39 rules (prior: 30) and `redact-lock.test.ts` is 876 lines (prior: 580), from later commits. All phase must-haves still hold at HEAD.

## Preconditions

- `18-SECURITY.md`: `status: verified`, `threats_open: 0`. Not a blocker.
- Roadmap success criteria (ROADMAP.md Phase 18, SC1 and SC2) are covered by truths 1–4, 9–12 and 14–16. The PLAN must-haves (21 truths across 18-01..18-04) are all checked.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | D18-01: D-04 shapes redact in September order (private-tag first, api-key-lower after assignment, provider shapes before jwt, pk-rk narrowed) | ✓ VERIFIED | `packages/mcp-server/src/redact.ts:133` private-tag first in `RULES`; `assignment` `:157`, `api-key-lower` `:161`; `aws` `:185` … `openai-proj` `:197`; `pk-rk` `:213`; `jwt` `:219`. Order pinned by `redact.test.ts` "event rule order follows September (D18-01)" (pass). |
| 2 | D18-02: `redactValue` keeps SENSITIVE_KEY, COUNTER_KEY, isCount, null/undefined pass-through | ✓ VERIFIED | `redact.ts:274` COUNTER_KEY, `:291-299` redactValue. Spot-check (`bun run`): `{input_tokens:1200, output_tokens:"340", tokens:<key>, api_key:"short"}` → `{"input_tokens":1200,"output_tokens":"340","tokens":"[REDACTED]","api_key":"[REDACTED]"}` |
| 3 | D18-03: every event rule has a unique stable name exported read-only; `redact()` signature unchanged | ✓ VERIFIED | `redact.ts:224-227` (`RedactionRuleName`, `REDACTION_RULES`). Spot-check: 39 rules, 39 unique names. |
| 4 | D18-04: one fixture per rule name; removal, idempotence, reachable via redactValue; coverage test | ✓ VERIFIED | `redact.test.ts:460` "one fixture per named rule" (pass). `bunx tsc --noEmit` exit 0 at repo root, so `FIXTURES: Record<RedactionRuleName,…>` totality is compile-enforced. |
| 5 | D18-05: counter keys keep numeric/digit-string values; `{tokens: fixture}` and short `api_key` redact whole | ✓ VERIFIED | `redact.test.ts:505` "D-04 counter exemption" (pass); spot-check output above. |
| 6 | D18-06: September near-misses stay unredacted | ✓ VERIFIED | `redact.test.ts:520` "D-04 near-misses stay unredacted" and `:184` "over-redaction guards" (pass). |
| 7 | D18-17: `<private>` and D-04 memory bodies classify secret / unreleasable | ✓ VERIFIED | `memory-classify.ts:151-160` (`reason: "secret"`, `reviewable: false` when `redact(text) !== text`); `memory-classify.test.ts` "secrets" group (pass): private-tag, D-04-shaped, digit-bearing pk- quarantined; word-only slugs not. |
| 8 | D18-21: pk-rk requires a digit in the tail; digit keys redact, word-only slugs survive | ✓ VERIFIED | `redact.ts:213` narrowed pattern, `:119` `redactPkRk`. Spot-check: `pk-live1234567890abcdefghij` → `[REDACTED]`; `pk-this-is-a-word-only-slug-xx` unchanged. `redact.test.ts:759` "skill pk-rk needs a digit in the tail" (pass). |
| 9 | D18-07: September skill engine (`SKILL_RULES`, `redactSkillContent`, `scanSkillFiles`) lives in `redact.ts`; event pass stays liberal | ✓ VERIFIED | `redact.ts:368-550` skill types and rules; `:634` `redactSkillContent`; `:741` `scanSkillFiles`. `redact.test.ts:706` "event redactor stays liberal" (pass). |
| 10 | D18-08: high-confidence skill findings for google/slack/npm/gitlab/digitalocean/openai-proj; pk-rk/private-tag/api-key-lower contextual with placeholder handling | ✓ VERIFIED | `redact.ts:402` `SKILL_HIGH_CONFIDENCE_RULES`; placeholder logic `:560-591`. `redact.test.ts:608` and `:713` (pass). |
| 11 | D18-09: parity test fails on a named event rule with no same-name skill rule and not excluded | ✓ VERIFIED | `redact.ts:546` `SKILL_EXCLUSIONS`; `redact.test.ts:778` "event/skill parity (D18-09)" (pass). |
| 12 | D18-10: `scanSkillFiles` is the only publication-path scan | ✓ VERIFIED | `redact.ts:741` is the only `scan*` export; `redact-contract.test.ts` (pass). |
| 13 | D18-11: `redactKnown` longest-first, ignores empties; `lessons.ts` uses it, tests unchanged | ✓ VERIFIED | `redact.ts:323` `redactKnown`; `packages/cli/src/lessons.ts` imports it; `redact.test.ts:88` "redactKnown" (pass). Spot-check: `redactKnown("token ABC123 and ABC", ["ABC","ABC123"])` → `token [REDACTED] and [REDACTED]`. |
| 14 | D18-12: `redact-lock.test.ts` beside `store-lock.test.ts`, asserts offender lists `[]`, runs under plain `bun test` | ✓ VERIFIED | `redact-lock.test.ts:512` "redaction lock" group (pass); `store-lock.test.ts` in the same `bun test` run (pass). |
| 15 | D18-13: import-away, redactor definitions, markers/replaces, credential-shape detectors fail the lock | ✓ VERIFIED | `redact-lock.test.ts:513-553` rules 1–4 pass on the tree; `:615` detector self-tests (pass). |
| 16 | D18-14: audit/observability injected seams allowlisted with cycle reason; constructions pass shared `redact` | ✓ VERIFIED | `redact-lock.test.ts:568` "injected-seam allowlist is exactly the three cycle-bound files"; `:586` AuditLog/OtlpExporter construction check (pass). |
| 17 | D18-15: each detector fails planted offenders and passes non-offenders | ✓ VERIFIED | `redact-lock.test.ts:762-854` self-tests (pass). |
| 18 | D18-16: no advance exemption for Phase 19's installed-path hook; lock checks repository only | ✓ VERIFIED | `redact-lock.test.ts:559` "lock scope holds the shebang hook and never the shared module or a test file" (pass). |
| 19 | D18-18: `docs/redaction.md` complete; three pointers; no CHANGELOG | ✓ VERIFIED | `docs/redaction.md` present; `greptime-ledger.md`, `memory-governance.md`, `observability.md` in covered_files. `redact.test.ts` "docs/redaction.md matches the module" (rule table = module; pointers present) passes. |
| 20 | D18-19: suite and tsc vs baseline; named tests run; round trip runs when `scripts/rehearsal.ts` is on base, else skip | ✓ VERIFIED | `bun test` on the 6 redaction/lock/classify/store-lock files: **354 pass / 1 skip / 0 fail** (17.6 s). `bunx tsc --noEmit` at repo root: exit 0. Round trip (`describeRoundTrip`, gated on `SUBSTRATE_URL` / rehearsal twin) was skipped in this run and not exercised; the skip is the plan-defined outcome without the twin. |
| 21 | D18-20: SUMMARY and PR body carry the restart line | ✓ VERIFIED | `18-04-SUMMARY.md:70` and `:153`: "Redaction widens on the production write path at the operator's next approved restart of `substrate-mcp`; nothing restarts in this PR." |

**Score:** 21/21 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/redact.ts` | Labelled RULES, skill engine, redactKnown, counter exemption | ✓ VERIFIED | 756 lines. RULES, SKILL_RULES, `redactValue`, `redactKnown`, `redactSkillContent`, `scanSkillFiles` present. No TBD/FIXME/XXX. `PLACEHOLDER_VALUE` (`:560`) is an identifier, not a debt marker. |
| `packages/mcp-server/src/redact.test.ts` | Fixture corpus, parity, skill, counter tests | ✓ VERIFIED | 873 lines; corpus, coverage, parity, counter, skill and docs-match suites pass. |
| `packages/mcp-server/src/redact-lock.test.ts` | Repo lock beside store-lock | ✓ VERIFIED | 876 lines; rules 1–4 pass on tree; self-tests pass. |
| `packages/mcp-server/src/memory-classify.ts` | Secret quarantine via `redact(text) !== text` | ✓ VERIFIED | `:151-160`. |
| `packages/cli/src/lessons.ts` | Uses `redactKnown` | ✓ VERIFIED | Imports shared module (lock rule 1 passes). |
| `docs/redaction.md` | Rule table, lock rules, how-to | ✓ VERIFIED | Rule-table-matches-module test passes. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `RULES` table | `redact()` loop → `redactValue()` | `redact.ts:230-237`, `:291-299` | ✓ WIRED | Spot-checks above. |
| `redact()` widening | `memory-classify.ts` quarantine | `memory-classify.ts:151-160` | ✓ WIRED | memory-classify tests pass. |
| `SKILL_RULES` names | parity test → `REDACTION_RULES` | `redact.test.ts:778` | ✓ WIRED | Pass. |
| `lessons.ts` diagnostics | `redactKnown` | `lessons.ts` import | ✓ WIRED | Lock rule 1 and lessons tests pass. |
| `redact-lock.test.ts` detectors | every package source → shared `redact.ts` | `redact-lock.test.ts:512-586` | ✓ WIRED | Lock passes on tree. |

### Data-Flow Trace (Level 4)

Not applicable: the phase delivers a pure transform module and a repo lock; no rendered data.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Counter exemption + sensitive key | `bun run` script calling `redactValue` | `input_tokens:1200`, `output_tokens:"340"` kept; `tokens`, `api_key` → `[REDACTED]` | ✓ PASS |
| pk-rk digit rule | `bun run` script calling `redact` | digit key redacted; word-only slug kept | ✓ PASS |
| `<private>` block | `bun run` script calling `redact` | block replaced with `[REDACTED]`, surrounding text intact | ✓ PASS |
| `redactKnown` longest-first | `bun run` script | `[REDACTED]` for both needles | ✓ PASS |
| Rule names unique and exported | `bun run` script | 39 rules, 39 unique names | ✓ PASS |
| Phase test set | `bun test` on redact.test.ts, redact-lock.test.ts, redact-contract.test.ts, redact-adversarial.test.ts, memory-classify.test.ts, store-lock.test.ts | 354 pass / 1 skip / 0 fail | ✓ PASS |
| Typecheck | `bunx tsc --noEmit` (repo root) | exit 0 | ✓ PASS |

### Probe Execution

No probe scripts declared or conventional for this phase (no `scripts/*/tests/probe-*.sh` referenced by PLAN/SUMMARY). Skipped.

### Requirements Coverage

| Requirement | Source Plan | Status | Evidence |
|-------------|-------------|--------|----------|
| LANEB-06 | 18-01..18-04 | ✓ SATISFIED | Truths 1–21 above. REQUIREMENTS.md marks LANEB-06 `[x]`. |

No orphaned requirements: ROADMAP maps only LANEB-06 to Phase 18.

### Anti-Patterns

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | No TBD/FIXME/XXX/TODO markers in the phase's implementation or doc files | — | None |

### Notes

- Not exercised this run: the gated harness round trip in `redact.test.ts` (needs the rehearsal twin). The prior report ran it live; that result is not re-established here.
- Not re-read this run: `18-REVIEW.md` and `18-REVIEW-DISPOSITION.md`. Status does not depend on them.
- Later commits changed `redact.ts` (39 rules now vs 30 in the prior report). All phase must-haves still hold at HEAD. No regression found.
- Unrelated: the working tree has uncommitted VERIFICATION.md edits for phases 16, 74, 76–78 and an untracked file for phase 73. Not touched by this run.

## Human Verification Required

None. Status is `passed` per the decision tree. The round-trip skip is a planned outcome, not a human item.

## Gaps Summary

No gaps. All 21 must-haves verified at HEAD `33c400d1`.
