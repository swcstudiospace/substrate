---
phase: 07-database-structures
verified: 2026-10-07T15:00:00Z
status: passed
score: 9/9 must-haves verified
---

# Phase 7 Verification: Database structures

Goal: a swarm correlation id maps to one Graph ID in the index, and a swarm token can only speak as its own surface.

## Success criteria (ROADMAP)
| # | Criterion | Evidence | Result |
|---|-----------|----------|--------|
| 1 | `graph_bindings` with unique `correlation_id`; `graph_bind` create / forward / reverse; concurrent binds give one winner | `index-store.ts` migrate DDL; `graph-bind.test.ts`; live: 10 concurrent `graph_bind` over HTTP -> 1 created / 9 existing / 1 winner / 1 Postgres row; reverse lookup returns the correlation id | passed |
| 2 | 15 swarm surfaces in `SURFACES`; `.env.example` names 15 tokens | `types.ts`, `.env.example`, boot warning in `config.ts`/`index.ts`; tests in S1 suite | passed |
| 3 | `swarm-a05-be` token refused emitting/claiming as `swarm-a09-rev` | `authority.test.ts`, `server.authority.test.ts`, `mcp.test.ts`; live: REST 403 and MCP `isError` (incl. `graph_claim`), as itself 202 | passed |
| 4 | `EVENT_KINDS` unchanged; `store-lock.test.ts` passes | No kind added (binding uses `note`); full suite 992 pass / 0 fail (live PG), 954 pass / 44 skip / 0 fail (no DB) | passed |

## Requirements
| ID | Evidence | Status |
|----|----------|--------|
| DB-01 | Criterion 1; re-plan in live smoke reused binding, one row | satisfied |
| DB-02 | Forward + reverse via `graph_bind`; live reverse lookup | satisfied |
| ID-01 | Criterion 2 | satisfied |
| ID-02 | Criterion 3; non-swarm surfaces unchanged (documented in `docs/swarm-correlation.md`) | satisfied |
| ID-03 | Criterion 4 | satisfied |
| PROOF-01 (shared with phase 10) | `/tmp/s1-live-smoke.sh` 24/24: `orch_plan` bound a Graph ID, 13 nodes registered, 3 events under `swarm-a01-orch` with working prev chain, `events_verify` `{ok:true, events:3}`, A05-as-A09 refused | satisfied (server side) |

## Deliberate exclusions
- No versioned migration runner (existing idempotent `IndexStore.migrate` kept).
- No `POST /graph`, no single agent-swarm surface, no new event kinds (ADR 0001).

## Status
Shipped as agent-substrate PR #11 (`feat/s1-swarm-identity-binding`, 933f970 + 05f15dd); Greptile review in progress.
