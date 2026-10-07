---
phase: 08-memory-structures
plan: 01
one-liner: "Swarm memory goes through the substrate's governed memory_write: one client with kind and scope maps, idempotency keys and a handler for every gate outcome, with default-deny proven from outside."
subsystem: memory-governance
tags: [memory, governance, swarm, grants, idempotency, adr-0001-s3, SPE-5054]
provides:
  - swarm memory client (swarm/memory.py) mapping memory.write/query onto the substrate gate
  - outside-in tests pinning swarm-surface write scopes and default-deny
  - docs/memory-governance.md swarm section; agent-swarm docs/substrate-memory.md
key-files:
  created:
    - agent-swarm: swarm/memory.py
    - agent-swarm: docs/substrate-memory.md
    - agent-swarm: tests/test_swarm_memory.py
  modified:
    - agent-swarm: scripts/swarm_run.py
    - agent-swarm: swarm/substrate_client.py (mcp_call_json)
    - agent-substrate: docs/memory-governance.md, docs/swarm-correlation.md
    - agent-substrate: packages/mcp-server/src/memory-write.test.ts (swarm surface scopes)
key-decisions:
  - "Requirement correction (MEM-04): no grant change in memory-policy.ts. The 15 swarm surfaces already inherit the wildcard default grants; adding explicit grants would duplicate them. The substance of MEM-04 (default-deny proven from outside) is met by tests."
  - "Kind map decision/retro/pattern -> decision/fact/fact; scope map graph/repo/agent/global; patterns default to repo scope."
  - "Idempotency key = sha256 of the JSON array [correlation, task, attempt, kind, scope, normalized subject, text], reused on unverified retries. Review replaced a '|'-joined key on which subject-only differences and '|' inside fields collided."
  - "quarantined and review.required are returned to the caller, never retried."
  - "No versioned migration runner, no new event kinds, no POST /graph (ADR 0001)."
  - "Self-improving lessons bank deferred pending user decision (governed fact entries vs. changing the single-write-door rule)."
completed: 2026-10-07
status: complete
---

# Plan 08-01 Summary

## What shipped
- **agent-substrate #12** (`feat/s3-swarm-memory-grants`, stacked on #11; e2b49a9 + merge a9ca87a). No gate or grant change. Tests pin what a swarm surface may write: `decision` + `fact` at `graph:` and `repo:`; `fact` only at own `agent:` scope; refused at another agent's scope and at person scope; unknown writer refused; `global` is a `review.required` proposal until a reviewer token releases it. `docs/memory-governance.md` updated.
- **agent-swarm #6** (`feat/s3-swarm-memory`, stacked on #5; 0be9ed6). `swarm/memory.py`: kind/scope maps; sha256 idempotency key reused across retries; `denied -> E-POLICY`; `quarantined`/`review.required` returned, not retried; `version.*` conflict re-read + resubmit with `expected_version`; unverified retried with same key; ok only when `accepted && verified_persisted`; unreachable -> `unavailable`. `memory_query` via `memory_search`; `run_start_context` via `/brief`. `substrate_client.mcp_call_json`. `swarm_run.py` adds a "Substrate memory" prompt section only when the substrate answers. AST scan test: no swarm-side store feeds an agent's context. `docs/substrate-memory.md`.

## Evidence
- agent-substrate S3 branch: 998 pass / 0 fail (live PG).
- agent-swarm S3 branch: full pytest passes; build_agents/build_trae_agents --check up to date; bun test tests/ts passes; ruff only the two pre-existing E401 findings in tests/test_uplift_harness.py (also on origin/main).
- Live S3 smoke (`/tmp/s3-live-smoke.sh`, real gate + Postgres): 7/7 shell + 10/10 client checks (aggregated as one of the 7/7 shell checks).

## Deviations
- MEM-04 text asked for explicit default grants; not needed (wildcard already covers the swarm surfaces). Recorded as requirement correction above.

## Final state
- agent-substrate #12 merged 2026-10-07 as 7eba2fc. Review fixes: 751fd26 and 8416e5f (consistent decision-scope docs; every success asserts verified_persisted and the stored row), 2d3e407 (the decision-at-agent denial stated as the default policy, which operator grants can widen).
- agent-swarm #6 merged 2026-10-07 as a25c02a. Review fixes: 8804823 (unambiguous idempotency key, targeted version re-read, nested-module and TypeScript import scans, `unavailable` documented as an unknown result) and d5b0dc1 (tests moved to the client's `_open` transport seam). Doc follow-up: agent-swarm #7 (8c11231).
- A MEM-02 gap found after the first audit (the version re-read could not find a decision behind 100+ newer entries) is closed by phase 8.1.
