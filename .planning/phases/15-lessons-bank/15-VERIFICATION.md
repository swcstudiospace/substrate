---
phase: 15-lessons-bank
verified: 2026-10-07T23:30:00Z
status: passed
score: 5/5 must-haves verified
---

# Phase 15 Verification: Lessons bank

Goal: a lesson from a finished phase becomes governed memory that a later phase can recall and cite by id.

## Success criteria (ROADMAP)
| # | Criterion | Evidence | Result |
|---|-----------|----------|--------|
| 1 | `lessons add` writes one `fact` per lesson through `POST /memory` with subject `lesson:<m>/<p>/<slug>`, an idempotency key and the header; counts only `accepted && verified_persisted`; twice gives one entry; quarantined reported, not retried | `lessons.test.ts`; live: 5 recorded and verified, the hedged lesson quarantined, re-add returns the same ids as duplicates | passed |
| 2 | `lessons recall` prints a `## Prior Lessons` block of top lessons ranked by recency and keyword/tag match, citing ids, digested lessons left out | `lessons.test.ts` ranking and exclusion; live: recall cites only bank lessons, excludes digested ones, and finds the oldest lesson behind 230 newer entries through the keyset cursor | passed |
| 3 | `lessons digest <m>` writes one `lesson-digest:<m>` fact listing the ids and deletes nothing | Live: the digest is a fact listing the five ids, all five lessons are still in the index, and re-running gives the same entry | passed |
| 4 | Scores are computed at read time from appended outcome facts; nothing is mutated | Live: the outcome moves the score 0.50 → 0.67 with the lesson entry unchanged, and recall reads the new score | passed |
| 5 | No new table, kind or write path; `store-lock.test.ts` passes | The `memory_search` change is read-only; full suite 1090 pass / 0 fail with live Postgres | passed |

## Requirements
| ID | Evidence | Status |
|----|----------|--------|
| LES-01 | Criteria 1 and 5 | satisfied |
| LES-02 | Criterion 1 (SUMMARY `## Lessons` and `--key-decisions` sources) | satisfied |
| LES-03 | Criterion 2 | satisfied |
| LES-04 | Criterion 3 | satisfied |
| LES-05 | Criterion 4 | satisfied |
| PROOF-04 | v1.1 lessons → accepted and verified fact ids → recalled into Phase 14's CONTEXT.md → cited in 14-01-PLAN.md as `[lesson mem_43bc8ddeb0244fc69758a24005e42f75]` → outcome recorded (0.50 → 0.67). The v1.2 digest fact is written at the milestone close against the same smoke substrate, and recorded in the milestone audit | satisfied (digest at close) |

## Proof
- `/tmp/p15-lessons-proof.sh`: 31/31 PASS, twice on one database (the scoped-key fix).
- The PROOF-04 citation ran on a smoke substrate (127.0.0.1:7493, real Postgres and GreptimeDB). The production substrate on 7410 is never touched by this milestone's work.
