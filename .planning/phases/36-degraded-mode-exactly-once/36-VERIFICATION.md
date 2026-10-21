---
phase: 36-degraded-mode-exactly-once
verified: 2026-10-21T06:17Z
status: gaps_found
score: 2 pass, 1 recorded decision awaiting acceptance, 1 partial (criterion 1 met for memory only; skills have no idempotency key)
verified_on: origin/main efa3ee4 (code tree b8f8331; PR #79 merged earlier)
covered_files: [".planning/phases/36-degraded-mode-exactly-once/PLAN.md", ".planning/phases/36-degraded-mode-exactly-once/SUMMARY.md", ".planning/phases/36-degraded-mode-exactly-once/CONTEXT.md", "packages/mcp-server/src/index-store.memory-exactly-once.test.ts", "packages/mcp-server/src/memory-outage-status.test.ts"]
---

# 36-VERIFICATION: Degraded-mode exactly-once replay

Verified by the orchestrator on 2026-10-21. Status is `gaps_found`. Criterion 1 is not met for skills, and the phase's own CONTEXT records that as a grey area awaiting the user's decision. Phase 36 is not closed.

## Proven in-repo

| Claim | Evidence |
|---|---|
| Both phase test files pass on a throwaway Postgres 16, with no skips | `bun test packages/mcp-server/src/index-store.memory-exactly-once.test.ts packages/mcp-server/src/memory-outage-status.test.ts`: 6 pass, 0 fail, 2 files, 0 skip, 0 todo (efa3ee4) |
| Types clean | `bunx tsc --noEmit` exit 0 on efa3ee4 |
| Skill approve replay | `skills-approve.test.ts:374`: asking again for the same approval answers `exists` with the same state and merge_sha, with no second row and no second event. This is natural-key dedupe. It does not re-issue the original response |

## Success criteria

| # | ROADMAP criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | A memory or skill write carrying an idempotency key applies once across replays and returns the original result | PARTIAL: memory PASS, skills NOT MET | Memory: the same explicit key replayed twice writes one row and returns the original entry (`index-store.memory-exactly-once.test.ts:95`). An outage after the row commits, then a same-key retry, never writes a second row (`:132`). Skills: no idempotency key exists. Replays dedupe on natural keys (`skills-approve.test.ts:374`), which returns `exists`, not the original result. The phase's decision D2 chose this and recorded it as a grey area (CONTEXT.md, "Decisions taken") |
| 2 | A write without a key behaves exactly as it does today | PASS | Keyless new content writes each time; a keyless identical retry dedupes as today (`index-store.memory-exactly-once.test.ts:114`) |
| 3 | The 503 path is covered by a test | PASS | Index refuses the claim: store.write-failed gives 503 (`memory-outage-status.test.ts:18`). No index: store.unavailable gives 503, not 403 (`:34`). A policy refusal with the index present stays 403 (`:45`) |
| 4 | The dependent client's local queue is built for the identified client, or recorded as a decision request with a default | RECORDED, not built | Recorded as GREY_AREA in CONTEXT.md, with the default that skills get no new key store. The Omp skill client already queues outside this phase (CONTEXT.md, Omp client note). Acceptance is pending the user's decision |

## Not proven / open

- Criterion 1 for skills. Decision needed: (a) accept natural-key dedupe as the skills answer and amend criterion 1's wording to "returns the existing record", which the approve replay already does; or (b) add skill idempotency keys as new work in a new phase.
- Skill propose replay dedupe: the ledger dedupe is recorded in CONTEXT but no test in this run exercises it.
- uplift-7 audit row 25 stays FAIL until the decision is made.
