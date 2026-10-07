---
phase: 10-swarm-orchestrate
verified: 2026-10-07T15:00:00Z
status: passed
score: 4/4 must-haves verified
---

# Phase 10 Verification

Goal: the swarm's event stream reaches the ledger under one Graph ID per run, attributed to the agent that produced it. PR agent-swarm #5 (`feat/s1-substrate-tee`, `2efce2f`).

## Success criteria
| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Every `runlog.emit` record teed with surface, session, graph, node, kind, payload | VERIFIED | pytest; live: 3 events as `swarm-a01-orch`, session `A01@r0:<graph>`, payload `swarm_type`+`msg_id` |
| 2 | Swarm-type table exhaustive; double-publish sends one request | VERIFIED | AST emit-site scan over 13 types; `(surface,msg_id)` 24 h dedupe test |
| 3 | Substrate down -> `orch_plan` completes as before | VERIFIED | live: substrate-mcp stopped, exit 0 in under 1 s |
| 4 | Real PG + GreptimeDB: `events_verify` green for the Graph ID; mismatched token refused | VERIFIED | `/tmp/s1-live-smoke.sh` 24/24; `{ok:true, events:3}`; A05 as A09 -> REST 403 and MCP isError (incl. graph_claim), as itself 202 |

## Requirements
| ID | Status | Evidence |
|----|--------|----------|
| TEE-01 | satisfied | criterion 1 |
| TEE-02 | satisfied | AST scan; unmapped type fails test |
| TEE-03 | satisfied | dedupe test |
| TEE-04 | satisfied | criterion 3; fail-open client, 1.5 s timeout, back-off |
| GID-01 | satisfied | live: bound `ut-muy71rn1-ff2a90b4`-form id, 13 nodes registered under `acme/scratch`; 10 concurrent graph_bind -> 1 created/9 existing/1 winner/1 row; re-plan reused, one binding row |
| PROOF-01 | satisfied (with Phase 7) | criterion 4 |

## Gates
Full pytest pass; `build_agents`/`build_trae_agents --check` up to date; `bun test tests/ts` pass; ruff only the two pre-existing E401 in `tests/test_uplift_harness.py`. Substrate S1 branch: 954 pass/44 skip/0 fail (no DB), 992 pass/0 fail (live PG).

## Deliberate exclusions
No `POST /graph`, no single `agent-swarm` surface, no new event kinds (ADR 0001).

## Note
Greptile hardening round on #5 (redirect-safe bearer, per-surface token override, total-time bound, dry-run no tee, per-server binding cache, pending/sent dedupe, prune index) is in progress on the PR; not part of this verdict.
