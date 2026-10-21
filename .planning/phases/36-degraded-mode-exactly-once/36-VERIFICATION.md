---
phase: 36-degraded-mode-exactly-once
verified: 2026-10-21T06:17Z
status: passed
score: 4 of 4 criteria met. Criterion 1 amended by the project owner's decision on 2026-10-21 (skills dedupe on natural key)
verified_on: origin/main efa3ee4 (code tree b8f8331; PR #79 merged earlier)
covered_files: [".planning/phases/36-degraded-mode-exactly-once/PLAN.md", ".planning/phases/36-degraded-mode-exactly-once/SUMMARY.md", ".planning/phases/36-degraded-mode-exactly-once/CONTEXT.md", "packages/mcp-server/src/index-store.memory-exactly-once.test.ts", "packages/mcp-server/src/memory-outage-status.test.ts", "packages/mcp-server/src/skills/propose.test.ts", "packages/mcp-server/src/skills/propose.git.test.ts", "packages/mcp-server/src/skills-approve.test.ts"]
---

# 36-VERIFICATION: Degraded-mode exactly-once replay

Verified by the orchestrator on 2026-10-21. Criterion 1 was amended by the project owner's decision on 2026-10-21: the skills half accepts natural-key dedupe, because skills have no idempotency key (the phase's decision D2). The amended wording is in ROADMAP.md.

## Proven in-repo

| Claim | Evidence |
|---|---|
| Memory test files pass on a throwaway Postgres 16, no skips | `bun test packages/mcp-server/src/index-store.memory-exactly-once.test.ts packages/mcp-server/src/memory-outage-status.test.ts`: 6 pass, 0 fail, 2 files, 0 skip, 0 todo |
| Skill propose replay tests pass, no skips | `bun test packages/mcp-server/src/skills/propose.test.ts packages/mcp-server/src/skills/propose.git.test.ts`: 101 pass, 0 fail, 2 files, 0 skip, 0 todo |
| Types clean | `bunx tsc --noEmit` exit 0 on efa3ee4 |

## Success criteria

| # | ROADMAP criterion (amended) | Verdict | Evidence |
|---|---|---|---|
| 1 | A memory write carrying an idempotency key applies once across replays and returns the original result. A skill write dedupes on its natural key: a replay answers `existing` (propose) or `exists` (approve) with the existing record, and writes no second row, event, push or PR | PASS | Memory: the same explicit key replayed twice writes one row and returns the original entry (`index-store.memory-exactly-once.test.ts:95`). An outage after the row commits, then a same-key retry, never writes a second row (`:132`). Skills propose: a recorded open PR answers `existing` with no clone, push or create (`propose.test.ts:501`, `:513`). Identical content resubmitted answers `existing` with no second push or PR (`propose.git.test.ts:167`). Skills approve: a repeat answers `exists` with the same state and merge_sha, with no second row or event (`skills-approve.test.ts:374`) |
| 2 | A write without a key behaves exactly as it does today | PASS | Keyless new content writes each time; a keyless identical retry dedupes as today (`index-store.memory-exactly-once.test.ts:114`) |
| 3 | The 503 path is covered by a test | PASS | Index refuses the claim: store.write-failed gives 503 (`memory-outage-status.test.ts:18`). No index: store.unavailable gives 503, not 403 (`:34`). A policy refusal with the index present stays 403 (`:45`) |
| 4 | The dependent client's local queue is built for the identified client, or recorded as a decision request with a default | PASS (recorded) | CONTEXT decision D4 records the step as stopped and reported. SUMMARY.md:37 and :47 give the recommended default: `$SUBSTRATE_STATE_DIR/lessons-queue.jsonl`. The Omp skill client's queue (`packages/projector/omp/substrate-skills.ts:205-240`, per CONTEXT.md) predates this phase and is outside it |

## Notes

- Amendment: criterion 1 wording in ROADMAP.md was changed on 2026-10-21 by the project owner's decision. The original wording required an idempotency key on skill writes, which skills do not have.
- uplift-7 audit row 25 is not edited by this record.
