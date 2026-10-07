---
phase: 08-memory-structures
verified: 2026-10-07T15:00:00Z
status: passed
score: 4/4 must-haves verified
---

# Phase 8 Verification: Memory structures

**Goal:** Swarm memory is substrate memory and a refusal is handled, not worked around.

## Success criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | `memory.write` resolves to `memory_write` with documented kind/scope maps | PASS | swarm/memory.py kind map decision/retro/pattern -> decision/fact/fact, scope map graph/repo/agent/global; unit tests (agent-swarm #6); live: retro->fact at repo scope accepted and verified (1 POST) |
| 2 | `denied`, `quarantined`, both `conflict` flavors handled; nothing acts unless `accepted && verified_persisted` | PASS | Live: decision at agent scope -> E-POLICY, nothing stored; token-shaped secret -> quarantined (quarantine.secret), nothing raw in Postgres; rewrite without expected_version -> re-read + resubmit (2 POSTs) -> v2; global pattern -> proposal (review.required), 1 POST, not stored; replay -> idempotency.replay, stored once; unreachable -> unavailable, not ok |
| 3 | Swarm surface writing outside its grant refused, asserted from outside | PASS | agent-substrate #12 tests: refused at another agent's scope and person scope, unknown writer refused, global held for review; live agent-scope decision refused |
| 4 | Swarm suite proves no swarm-side store feeds an agent's context | PASS | AST scan test in agent-swarm suite (#6); full pytest passes |

## Requirements

| ID | Status | Note |
|----|--------|------|
| MEM-01 | Met | Criterion 1 |
| MEM-02 | Met | Criterion 2 |
| MEM-03 | Met | ok only on accepted && verified_persisted; idempotency key sha256(correlation\|task\|attempt\|kind\|scope\|text) reused on retries; live replay stored once |
| MEM-04 | Met (corrected) | Default-deny proven from outside (criterion 3). Requirement text asked for explicit default grants in memory-policy.ts; none added because the 15 swarm surfaces already inherit the wildcard default grants. Requirement correction, not a gap. |
| MEM-05 | Met | Criterion 4 |

## Test runs
- agent-substrate S3 branch: 998 pass / 0 fail (live PG).
- agent-swarm S3 branch: full pytest passes; build_agents/build_trae_agents --check up to date; bun test tests/ts passes; ruff: only the two pre-existing E401 findings in tests/test_uplift_harness.py.
- Live `/tmp/s3-live-smoke.sh`: 7/7 shell + 10/10 client checks (aggregated as one of the 7/7 shell checks); memory_query returned the fact; run_start_context (brief) showed decision v2 in force, not v1.

## Exclusions
- No versioned migration runner, no POST /graph, no new event kinds (ADR 0001).
- Self-improving lessons bank deferred pending user decision.

## Review
- agent-substrate #12 and agent-swarm #6 under Greptile review; round on #12 (doc consistency, stronger assertions) in progress.
