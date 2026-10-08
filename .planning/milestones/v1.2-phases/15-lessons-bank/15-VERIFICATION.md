---
phase: 15-lessons-bank
verified: 2026-10-08T02:18:33Z
status: passed
score: 5/5 must-haves verified
---

# Phase 15 Verification: Lessons bank

**Phase Goal:** A lesson from a finished phase becomes governed memory that a later phase can recall and cite by id.
**Verified:** 2026-10-08T02:18:33Z (current-goal reassessment plus parent reconciliation of the unchanged-head merge receipt)
**Status:** passed
**Re-verification:** Yes — after review-driven corrections (report identity, stored header, structured diagnostics)

## Revision under verification

- **Published head:** `f956ec2` ("docs(cli): clarify report identity output", branch `feat/v1.2-p15-lessons-bank`, checkout `/root/src/worktrees/agent-substrate-p15`)
- **Tested code:** `439fb50` ("fix(cli): redact structured lesson diagnostics"). Parent's documentation-only follow-on commit changes one sentence in `docs/lessons-bank.md` (JSON reports, not every human formatter, show the original report identity). Implementation/test sources are unchanged, so the executed `439fb50` gates cover the published head's code; this worker did not run a git comparison.
- **This worker executed nothing** (no builds, tests, linters, commands, scans, or network smoke, per assignment). All runtime results below are parent-reported, read from read-only `local://p15-oct08-final-evidence.json`. Source facts (line anchors, key/header shapes, redaction order, JSON identity passthrough, absence of a write-key shim) were confirmed by direct ranged reads of the current checkout.

## Goal Achievement

### Observable Truths (five ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `lessons add` writes one governed `fact` per lesson (subject `lesson:<m>/<p>/<slug>`, scoped idempotent key, structured header); only `accepted && verified_persisted` counts; re-add duplicates; hedged lessons quarantined, not retried | ✓ VERIFIED | Source: `lessonSubject`/`lessonKey`/`lessonBody` (`lessons.ts:187-194`), `interpret` accepted+verified gate (`:673-691`), single same-key `unverified` retry (`writeGoverned :994-1013`). Parent: 60-test focused pass (468 assertions); 18/18 real-store CLI checks on current code (`artifact://68`), incl. committed-reply-loss retry staying `duplicate` and speculative note still quarantined; 31/31 bank smoke retained from `e7be626` for this unchanged path (bundle `/tmp/p15-proof-1791422085`) |
| 2 | `lessons recall` prints a `## Prior Lessons` block of top lessons ranked by recency × keyword/tag match, citing entry ids, with digested lessons excluded; reaches beyond the latest 100 via paged `subject_prefix` + keyset cursor | ✓ VERIFIED | Source: `scoreOf`/`rankLessons`/`renderPriorLessons`, three-family paging capped at 50 pages with legacy fallback warning. Parent: focused + full/live-PG suites green (1146 pass, 4385 assertions, 39 files, `artifact://68`); bank smoke §5/§8 and 130-lesson/105-outcome regressions; read-only PROOF-04 recheck shows actual CLI recall returning the v1.2 digest, not its retired ids (`artifact://37`, `artifact://38`) |
| 3 | `lessons digest <m>` writes one `lesson-digest:<m>` fact listing the ids and deletes nothing; partial batches stay citable until wholly covered; oversized generated digests refuse with zero writes | ✓ VERIFIED | Source: `digestBody:215-231`, `digest:1290-1295`, `digest:1362-1365` (key over scope+milestone+sorted ids+text). Parent: R1/R2 regressions in the 60-test pass; 18/18 real-store smoke includes digest-without-deletion on current code |
| 4 | Scores compute at read time from appended outcome facts (newest report per citing phase); nothing is mutated; outcome identity is the required case-preserving `--report-id` (`[A-Za-z0-9._:-]{1,200}`, validated pre-network incl. dry-run); key over scope+lesson-id+citing milestone/phase+report-id only; stored header is SHA-256(report-id) while JSON reports carry the original identity; same-payload replay duplicates, new-id corrections append, changed same-id content conflicts | ✓ VERIFIED | Source: `lessons.ts:1397-1399` (identity gate), `:1436` (key), `:1438-1446` (body with `report: sha256(reportId)`), `printPlanned:1049-1056` (JSON spreads original `report`), `outcomesFor` exact-id filter. Parent: report-id/key/replay/conflict/opaque-identity regressions in the 60-test pass; 18/18 real-store checks (lost `mem_45a471bf…` replays `duplicate`, correction `mem_f04f2bf0…` appends, new success `mem_2bfed689…`, opaque `retry-unverified-1` recorded/replayed, `artifact://68`). Predecessor-derived-identity prose (corrections keyed without an explicit report id) is superseded and no longer advertised |
| 5 | No new table, memory kind, or write path; `store-lock.test.ts` passes | ✓ VERIFIED | Source: CLI sends only governed `fact` writes; server change is read-side (`subject_prefix`, keyset cursor); no `memory-write.ts` change, no new `insertEntry` caller. Parent: full/live-PG suite 1146 pass / 0 fail includes `store-lock.test.ts` (`artifact://68`) |

**Score:** 5/5 truths verified (0 present-but-behavior-unverified — every state transition above is exercised by a named regression plus actual-CLI evidence)

### Structured diagnostics (current-code correction, `439fb50`)

- Displayed diagnostic text is normalized and scrubbed (URL userinfo/query/fragment, configured secrets incl. JSON-escaped forms, string/object/array reason/remedy/error) **before** the 200-character cap (`lessons.ts:806-815`); requests, credentials, outcome/verification fields, and successful data are unchanged.
- Protocol decisions and identifiers stay exact: only reason `review.required` keeps its constant (`lessons.ts:880`); `review_id`, `quarantine_id` and `conflict_with` remain exact. Null reasons are not turned into strings, retaining the error fallback in `interpret` (`675-692`).
- Parent: 4/4 controlled-upstream actual-CLI checks pass (object reason/array remedy denial, null-reason array error, nested object error; authorization unchanged, exactly three POSTs, no retries). The pre-fix control failed the three confidentiality checks (1/4), proving defect sensitivity. Regressions include the `review`-bearer-token case with exact `rev_9` / `mem_review_7` / `memq_review_1`.
- No legacy write-key shim exists in `lessons.ts` ("legacy" names only the older-server *search* fallback flag, `BankReader:1198-1220`); persisted outcomes without report headers remain readable with no migration.

### Requirements Coverage

| Requirement | Source | Description | Status | Evidence |
|-------------|--------|-------------|--------|----------|
| LES-01 | 15-01-PLAN tasks 2,4,6,7,9 | Governed lesson facts, accepted+verified only, scoped dedupe, parked results not citable, no new table/kind/write path | satisfied | Criteria 1 + 5 |
| LES-02 | tasks 1,3,4,6 | SUMMARY lesson/key-decision extraction with human review (`--dry-run`/`--skip`) | satisfied | Criterion 1; extraction regressions; 6 key-decision outage-stop proof |
| LES-03 | tasks 5,6,9 | Scoped ranked recall, stable cited ids, paged beyond latest 100 | satisfied | Criterion 2 |
| LES-04 | tasks 2,5,6 | Complete digest citations, no deletion, no partial-batch coverage loss | satisfied | Criterion 3 |
| LES-05 | tasks 5,6 | Append-only outcomes, read-time latest-per-citing-phase score | satisfied | Criterion 4 |
| PROOF-04 | tasks 3,6,8 | Archived source → Phase 14 CONTEXT/PLAN citation → persisted outcome → digest, originals preserved | satisfied | Read-only recheck on smoke 7508, five checks true: archived v1.1 source preserved; original subject preserved; digest `mem_2c3f2eb6a24842e1bbef46759fa5c35e` holds all six citations; all six original facts present; citing Phase 14 outcome `mem_05e1dd19ee8146619f24e05ed3f40768` present (`artifact://37`, `artifact://38`). No duplicate historical close write |

### Historical chronology (retained, explicitly scoped — not current certification)

| Revision | Scope of validity |
|----------|-------------------|
| `900a679` (seven PR #17 findings) | Historical: partial-digest retention, oversized-digest refusal, retry-safe corrections, timestamp-tie order, outcome preflight, keyset seeks, calendar cursors. Evidence: 1138 tests / 4254 assertions (`artifact://1741`), 31/31 smoke on 7497. Superseded for changed outcome/diagnostic paths |
| `a6a824a` (report-id correction) | Historical: 57-test focused pass (446 assertions), 1143-test full pass (4363 assertions, `artifact://30`), 15/15 real-store review smoke, 31/31 bank smoke on 7509 (bundle `/tmp/p15-proof-1791420769`), persisted PROOF-04 recheck. Current retained bank proof is 31/31 at `e7be626`, `/tmp/p15-proof-1791422085`; neither is relabeled as a fresh diagnostic-delta execution |
| `old 900-era proof` (7493 close digest, 0.50→0.67 outcome) | Historical human-workflow proof retained by identifier only; never re-executed, never rewritten |
| `f956ec2` / `439fb50` (current) | Current-code evidence: 60 focused / 468 assertions; 1146 full live-PG / 4385 assertions / 39 files / 6.66s, clean `bun run check`, both CLI LSP diagnostics OK (`artifact://68`); 18/18 real-store CLI checks (`artifact://68`); 4/4 structured-diagnostic checks. Documentation-only follow-on is grounded in parent's commit output, not a worker-executed diff |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | No issue identified in the bounded current-goal check; this worker wrote only the two assigned planning reports and did not edit implementation | — | — |

Stale-wording reconciliation applied by this refresh: "loopback HTTP fixture (real HTTP + production fact classifier, simulated governance/storage replies)" replaces "toy gate" wherever CLI test doubles are meant (the CLI never pre-screens — the gate is the one classifier); predecessor-derived outcome-identity prose is marked superseded (see criterion 4); the `f956ec2` sentence now qualifies JSON reports only.

### Human Verification Required

None for the phase goal — every truth above carries parent-executed behavioral evidence on the current code. Explicitly: **no user UAT response was solicited or fabricated**; lesson-quality and explicit-summary semantic review remain documented operator duties (see 15-VALIDATION.md Manual-Only Verifications), not phase gaps.

### Limits (not certification)

- **Separate security gate:** P15SecurityClosure returned SECURED (4 fresh delta controls, 11 retained historical closures, 15 closed/0 open/0 accepted risks); parent records it in `15-SECURITY.md`. This verifier did not perform that security audit, run scans or claim full ASVS certification.
- **Separate shipping receipt:** configured CLI merged [PR #17](https://github.com/swcstudiospace/agent-substrate/pull/17) at `2026-10-08T02:11:45Z`, squash `746a38a4aaa0cbe25cdea54d64d4babb6bda37bd`, after exact head `f956ec22e36401219d71c01562693261f0094f63` passed Greptile 5/5, zero open comments, round 4. GitHub's configured check is Greptile Review (SUCCESS); no separate build/test CI claimed. No code changed for this receipt reconciliation, so current-goal evidence above remains valid. Remote branch deleted, local Git sync failed; trackers synchronized. No production deployment or milestone-completion claim.
- Production substrate `:7410` never used; smoke ports 7508/7509 and isolated PG/GreptimeDB only; original dirty `/root/src/repos/agent-substrate` status unchanged.

### Gaps Summary

No phase-goal gaps. All five ROADMAP criteria and LES-01..05 + PROOF-04 are supported by source inspection plus parent-executed gates. The independent security reassessment has also returned; PR #17 merge and the remaining milestone deliveries stay parent-owned separate gates.

---

_Verified: 2026-10-08_
_Verifier: P15GoalRefresh (goal-backward; parent evidence as ground truth, no re-execution per assignment)_
