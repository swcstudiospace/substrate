---
phase: 11-lease-authority
verified: 2026-10-07T21:10:00Z
status: passed
score: 5/5 must-haves verified
---

# Phase 11 Verification: Lease authority

Goal: the substrate refuses any lease action a swarm agent is not entitled to. A swarm session names its agent, replica and graph; a `lease_id` reaches only its holder; only the holder's surface can beat, release or complete.

## Success criteria (ROADMAP)
| # | Criterion | Evidence | Result |
|---|-----------|----------|--------|
| 1 | `A05@r1:<graph_id>` granted; another agent, a bad replica or another graph refused with `isError`, never rewritten; non-swarm surfaces unchanged | `authority.test.ts` (`swarmSessionRefusal` shapes), `mcp.test.ts`, `server.authority.test.ts`; live: 4 refusals and 1 grant | passed |
| 2 | No reply shows another holder's live `lease_id`; holder surface, session, epoch and expiry still show; old signed packets still verify | `lease.test.ts`, `index-store.lease.test.ts` (live PG), `service.test.ts`, `drift.test.ts`, `mcp.test.ts`, `handoff.test.ts` (legacy packet verifies); live: 15 disclosing replies plus ledger payloads checked as A09 | passed |
| 3 | Another surface is refused `not-holder` on heartbeat, release and complete even with the right id; anonymous runs unchecked; `force` unchanged | `lease.test.ts`, `index-store.lease.test.ts`, `server.authority.test.ts`; live: A09 refused on all three, A05 still holds, then completes | passed |
| 4 | A swarm token listed in `SUBSTRATE_OPERATOR_TOKENS` is refused `force` and boot warns, naming the surface | `authority.test.ts`, `server.authority.test.ts`; live: boot warning names `swarm-a09-rev` without the token, A09 refused `force` | passed |
| 5 | `EVENT_KINDS` unchanged; `store-lock.test.ts` passes | No kind added; full suite 1035 pass / 0 fail (live PG), 994 pass / 48 skip / 0 fail (no DB) | passed |

## Requirements
| ID | Evidence | Status |
|----|----------|--------|
| LEASE-01 | Criterion 1 | satisfied |
| LEASE-02 | Criterion 2 | satisfied |
| LEASE-03 | Criterion 3 | satisfied |
| LEASE-04 | Criterion 4 | satisfied |

## Proof
`/tmp/p11-lease-proof/run.sh` on the worktree server (127.0.0.1:7499, real Postgres 16 and GreptimeDB): 42/42 PASS.

Re-verified after the claim reply gained `ttl_seconds` (the granted TTL): `service.test.ts` asserts the clamped grant and its absence on a refusal; the branch rebased on `main` after PR #10 gives `tsc` clean and 1035 pass / 0 fail with live Postgres, and the Phase 12 live proof drove its leases from that reply.

## Deliberate exclusions
- Ledger events written before this change keep their ids; the append-only ledger cannot be rewritten, and `not-holder` makes the old ids useless.
- No REST lease routes; executing agents use MCP (ADR 0001 S4 criterion 6).
