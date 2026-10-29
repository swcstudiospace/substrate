---
phase: 18-guard-rails-and-shared-redactor
verified: 2026-10-11T00:00:00Z
status: passed
score: 21/21 must-haves verified
covered_files: [".planning/phases/18-guard-rails-and-shared-redactor/18-01-PLAN.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-01-SUMMARY.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-02-PLAN.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-02-SUMMARY.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-03-PLAN.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-03-SUMMARY.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-04-PLAN.md", ".planning/phases/18-guard-rails-and-shared-redactor/18-04-SUMMARY.md", "docs/greptime-ledger.md", "docs/memory-governance.md", "docs/observability.md", "docs/redaction.md", "packages/cli/src/lessons.ts", "packages/mcp-server/src/memory-classify.test.ts", "packages/mcp-server/src/redact-adversarial.test.ts", "packages/mcp-server/src/redact-contract.test.ts", "packages/mcp-server/src/redact-lock.test.ts", "packages/mcp-server/src/redact.test.ts", "packages/mcp-server/src/redact.ts", "packages/mcp-server/src/store-lock.test.ts"]
covered_digest: "v1:sha256:1fd95d53a5e4056e7e641811d9c99faa489ccbfd2a989128020785fe280bdc48"
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

## Re-verification after the second rebase (2026-10-09)

Phase 18 was rebased again, onto `main` at `28b5b99` (Phases 16 and 17 merged). No file covered by this report changed content across that rebase (`git diff bak/p18-pre-rebase HEAD` over the covered files is empty), so the 21/21 truths above stand. Fresh evidence on the rebased tree:

| Check | Result |
|-------|--------|
| `bun install --frozen-lockfile` | no changes |
| `bunx tsc --noEmit` | exit 0 |
| `bun test` (full suite) | 1638 pass / 57 skip / 0 fail across 54 files |
| `bun run check:phase-close` | pass (4 lock files, EVENT_KINDS 12 unchanged, SURFACES = v1.2 + `substrate`) |
| Phase 18 files x3 (`redact`, `redact-lock`, `redact-contract`, `memory-classify`, `store-lock`) | 239 pass / 1 skip / 0 fail, three consecutive runs |
| Flake probe (`--rerun-each 3`) | 663 pass / 3 skip / 0 fail |
| Coverage of `packages/mcp-server/src/redact.ts` | 94.44 % lines, 100 % functions |
| Gated harness round trip (own instance `p18-ship`, torn down, no containers left) | 177 pass / 0 fail |

Fingerprint refreshed with `verification.fingerprint` (v3), which covers the declared files plus the phase artifacts.

## Re-verification after Greptile review round 2 (2026-10-09)

Greptile scored the first round 0/5 with six P1 and six P2 findings on the redactor and its lock. Each was reproduced, fixed, and pinned by a test that was mutation-checked against the old behaviour (the old behaviour fails it).

| Finding | Fix | Pinned by |
|---|---|---|
| `redactKnown` trusted any `[REDACTED...]` lookalike | only the three markers the module writes are skipped | `redact-adversarial.test.ts` "a marker-shaped lookalike does not shield a value" |
| Overlapping values left a fragment | every occurrence span, overlapping ones included, replaced as a union | the `CANARY`/`beforeCAN` case, both orders, nested and repeated values |
| `private-tag` and `pk-rk` rescan from every opening (4.25 s for 360 KB; 2.23 s for 120 KB) | single-pass `apply` functions; a missing close ends the scan; the `pk-` run is matched once and tested for its digit | 600-string differential test against the patterns, plus repeated-prefix timing tests; `pem` and `url-password` (a prefilter) got the same treatment |
| `api_key: yoursecretpassword!2024` kept as a placeholder | the value runs to the end of the token and a placeholder is judged whole | punctuation case on both passes |
| a PEM crossing a private block's edge produced no finding | a high-confidence match touching a block is a finding and is replaced with it as one span | three crossing layouts and the doc-example variant, with exact outputs |
| `PLACEHOLDER_VALUE` backtracked exponentially | one parse per word; quote trimming by index | 35, 300 and 3000 repeated words, and 200 000 quotes, each under half a second |
| a file named `__proto__` vanished | the output map has no prototype | the `__proto__`, `constructor` and ordinary-file case |
| lock: dynamic imports escaped | bound names are checked for `require`, `await import` and `.then(({...}) =>` | planted offenders and non-offenders |
| lock: formatted patterns escaped | patterns are read from the whole file and reported on the right line | wrapped `new RegExp(` and a regex literal after a newline |
| lock: `redact: redactLocal` passed | the constructor must hand over `redact` itself | seven planted wrong callbacks |
| lock: older Notion shape escaped | the detector covers `secret_` | one planted case per prefix |
| large skill scans were quadratic | claims checked by binary search; per-rule merge of sorted ranges | 64 000 placeholders, 30 000 private blocks and 20 000 secrets in seconds, not minutes |

Gates on the final head (`a92d798`, rebased onto `main` `b66c453`, which carries the verification-gate PR):

| Gate | Result |
|---|---|
| `bun run verify --audit` (install, tsc, full suite, repo locks, audit) | all ok; 1700 pass / 57 skip / 0 fail |
| full suite with a scratch Postgres sourced (the live tests) | 1748 pass / 0 fail / 0 skip |
| flake probe `--rerun-each 3` over the four redactor test files | 702 pass / 3 skip / 0 fail |
| coverage of `redact.ts` | 100% functions, 100% lines |
| harness: `rehearsal smoke`, `smoke:greptime` | 4/4 and 20/20; instance torn down |
| perf gate (`redact()` is on the event path): 200 sequential `POST /events` and `POST /brief`, base against head, three interleaved rounds | events p50 8.6 to 7.9 ms, p95 12.9 to 10.9 ms; brief unchanged. No regression |
| mutations (marker pattern, the old pk-rk pattern, the old placeholder grammar, the merge-overlap branch; and four in the lock) | each caught by a named test |

Known limit, recorded not fixed: `url-password` stays quadratic on text that repeats `://` with a long colon-led run and no `@`. It predates this phase; it is in `docs/redaction.md` and goes on the follow-up list.

## Re-verification after staleness (2026-10-10)

`verification.status` reported `stale`: covered source files changed after the verifier last ran (digest `0ad07262…`). Cause isolated to two doc files; no phase-18 code file changed:

| Covered file | Changed by | Delta |
|---|---|---|
| `docs/greptime-ledger.md` | Phase 27 (`67cd428`, `event_ingest`/`anchors` sections) + Phase 28 (`589a27c`, anchor-job sections) | +237/-4, purely additive ledger sections |
| `docs/memory-governance.md` | Phase 20 (`96db88c`) | 1 word (`one variable` → `one list-valued variable`) |
| `redact.ts`, all redact tests, `redact-lock.test.ts`, `store-lock.test.ts`, `lessons.ts`, `docs/redaction.md`, `docs/observability.md`, all 8 plan/summary artifacts | — | byte-identical since verification |

Doc-pointer regression check (truth 19): all three `redaction.md` pointers still present — `greptime-ledger.md:225` (line shifted from :157 by the additive sections, link intact), `memory-governance.md:135` (unchanged), `observability.md:121` (unchanged). The added ledger sections contain no credential shapes, token literals, or Railway hosts (store-lock green over docs).

Gates on current HEAD (`dec0951`, pushed fast-forward to `origin/main` in this run, `git pull --ff-only` clean):

| Gate | Result |
|---|---|
| `bunx tsc --noEmit` | exit 0, no errors |
| `bun test` (full suite, 95 files) | 2645 pass / 58 skip / 2 fail |
| Phase-18 files (`redact`, `redact-lock`, `redact-contract`, `memory-classify`, `store-lock`) | 243 pass / 1 skip / 0 fail |
| `redact-adversarial.test.ts` + `lessons.test.ts` | 96 pass / 0 fail |
| `bun run check:phase-close` | pass (4 lock files green; EVENT_KINDS 12 unchanged; SURFACES = baseline + `substrate`) |
| Counter-exemption live proof (`redactValue({input_tokens: 1200, output_tokens: "340"})` survives; `{tokens: fixture}` → `[REDACTED]`) | PASS |
| Anti-pattern grep over phase files | clean (only intentional placeholder-handling symbols) |

Known failures, recorded not fixed (both reproduce; both outside phase-18 scope):

- **F-01** — `scripts/rehearsal.test.ts` "CLI refusals > --port 7410 exits 2 without touching Docker" (cwd-sensitive refusal-order assertion, phase-16-scope).
- **F-02** — `packages/cli/src/token.test.ts` "a directory at the token-file path means no token" (reads the real host Cursor token, owned by Phase 20).

Verdict: 21/21 truths stand, no regressions, no new gaps. Fingerprint refreshed via `verification.fingerprint` (v3) over the same 20-file covered set.

## Re-verification after staleness at 76a4b2c (2026-10-11)

Source commit `76a4b2c` (exact). Stale cause isolated by source-history metadata read (`dec0951..76a4b2c` over the 20 covered files): exactly one covered file changed — `docs/greptime-ledger.md` (+6/-1 in commit `76a4b2c`). The other 19 covered files (`redact.ts`, all redact tests, `redact-lock.test.ts`, `store-lock.test.ts`, `lessons.ts`, `memory-classify.test.ts`, `docs/redaction.md`, `docs/memory-governance.md`, `docs/observability.md`, all 8 plan/summary artifacts) are byte-identical since the `dec0951` verification. Must-haves (21 truths D18-01..D18-21) and reqID `LANEB-06` preserved unchanged; no old mutation claim repeated.

Ledger delta (additive, guard-consistent): a `redactKnown`-before-shape-redaction paragraph for SQL/migration/ingest-retry diagnostics ("Only empty known values are ignored; short values are not exempted" — matches truth D18-11 semantics in `redact.ts:305-317`) plus a smoke-sink boundary sentence, and one doc-hygiene line ("prints the database only — no hostname or credential"). No credential shape, token literal, or Railway/hostname literal added. Doc-pointer regression check (truth D18-19): `greptime-ledger.md:225`, `memory-governance.md:135`, `observability.md:121` all intact.

Source-first guard recheck at `76a4b2c` (read-only): `redact` / `redactValue` / `redactKnown` / `redactSkillContent` / `scanSkillFiles` / `REDACTION_RULES` / `RedactionRuleName` exports present; `lessons.ts:809` still calls shared `redactKnown`; no new rule, signature, plugin, or production cutover in the covered set (redactor diff vs `dec0951` empty).

Fresh scope (no test/build/gate/runtime executed by this child; evidence cited from `local://v13-final-green-evidence.json` at `4df30a0` plus `local://v13-final-runtime-evidence.json` `latest_source_gates` at source commit `76a4b2c`): latest full suite 2718 pass / 58 skip / 0 fail across 96 files (types 0, locks 108/0) includes all redactor/adversarial/skill-boundary tests; isolated runtime skills 47/47, ledger 47/47 (28 ledger/ingest + 19 fake-chain), desktop 20/20, vocabulary 29/29 with 28/28 sources stored and 0 refusals; actual ledger failure path `ledger_credential_echo: false` with `ledger_failure_exit: 1`; listed-surface counts 5→5. Operator limitations and historical provenance preserved: restart-gated production widening only (truth D18-20 restart line unchanged), no operator approvals run, no live-gate steps executed.

Verdict: 21/21 truths stand, no regressions, no new gaps. Fingerprint refreshed via `verification.fingerprint` (v1) over the same 20-file covered set.
