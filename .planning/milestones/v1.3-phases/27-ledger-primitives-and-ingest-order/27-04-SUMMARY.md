---
phase: 27-ledger-primitives-and-ingest-order
plan: "04"
subsystem: database
tags: [greptime, anchoring, smoke, scratch-proof, docs]

requires:
  - phase: 27-ledger-primitives-and-ingest-order plan 03
    provides: hourLeaves, hourDigest and the append mapping the smoke drives
provides:
  - scripts/greptime-smoke.ts section 5, the ingest-order proof, run 28/28 on scratch GreptimeDB v0.14.4
  - production anchors shape recorded as verified against live (read-only, operator-approved)
  - docs/greptime-ledger.md schema, guarantee, smoke and verification-status entries for event_ingest, anchors and ingest order
affects: [phase-28 (adopt-before-write on anchors, first anchored hour, first devnet transaction)]

actuals:
  tasks: 3
  commits: 2

key-files:
  modified:
    - scripts/greptime-smoke.ts
    - docs/greptime-ledger.md
    - README.md

key-decisions:
  - "The scratch proof extends scripts/greptime-smoke.ts, the named store-lock exemption, so no new exemption is argued"
  - "The burst is asserted as a subset of each hour in ingest order recomputed from the raw rows, never against an exact count, because the earlier smoke events share the hour"
  - "The post-merge restart that first creates event_ingest in production is a deploy and is not executed by this phase"

requirements-completed: [ANCHOR-01, ANCHOR-02]

coverage:
  - id: D1
    description: "On a real GreptimeDB, each of nine burst events from three sessions leaves exactly one ingest record; the digest of every touched hour is identical twice and holds the burst in ingest order; a backdated event is a member of its ingest hour and the September hour is empty; the chain verifies and no stored hash changes"
    requirement: "ANCHOR-02"
    verification:
      - kind: integration
        ref: "bun run rehearsal up --name p27, source stores.env, bun run smoke:greptime — 28/28 on greptime/greptimedb:v0.14.4; instance torn down, no containers left"
        status: pass
    human_judgment: false
  - id: D2
    description: "Production anchors matches the canonical DDL"
    requirement: "ANCHOR-01"
    verification:
      - kind: manual
        ref: "operator-approved read-only check 2026-10-08 (27-CONTEXT.md, Production schema probe), repeated 2026-10-09 through the append-only-guarded client: 11 columns in the D27-17 order, ENGINE=mito, no options, 0 rows, event_ingest absent"
        status: pass
    human_judgment: false

duration: ~1h
completed: 2026-10-09
status: complete
---

# Phase 27 Plan 04: Scratch proof, production check and ledger docs Summary

**The ingest-order path is proved on a real GreptimeDB (scratch, v0.14.4), production's anchors shape is confirmed read-only, and the ledger docs now say what Phase 28 inherits.**

## Task 1: scratch proof

`bun run rehearsal up --name p27 --port 0`, `set -a; . .../p27/stores.env; set +a`, `bun run smoke:greptime`, `bun run rehearsal down --name p27`. Images: `postgres:16`, `greptime/greptimedb:v0.14.4`. Result: **28/28 checks**, including the 12 new ones (9 events appended across three sessions; exactly one ingest record each; an identical root and memo over a 12-event hour twice; the burst in ingest order; the backdated event in its ingest hour with the September hour empty; chain intact and hashes unchanged). The instance was torn down (two containers removed, none left). The report printed the loopback host and the database only.

**Scope of the proof.** Scratch runs v0.14.4 and production runs v1.1.4. How v1.1.4 parses the new statements is not yet proved; the statements use only plain `SELECT`, `INSERT`, `IN` lists and ISO literals that the older server's documentation shows working. The first v1.1.4 evidence is the post-deploy boot, below.

## Task 2: production anchors check (checkpoint)

**APPROVED and run.** Read-only, through the append-only-guarded client path (`SHOW TABLES`, `DESCRIBE`, `SHOW CREATE TABLE`, `SELECT count(*)`); no write; no host or credential recorded.

- First run 2026-10-08 with the operator's approval, recorded in `27-CONTEXT.md` (Production schema probe).
- Repeated 2026-10-09 for this record, same approved statements: tables `agent_events`, `agent_events_pre_append_20260930`, `anchors`; `anchors` has 11 columns in the order `period_start` (TIME INDEX), `period_end`, `root`, `event_count`, `memo`, `tx_sig`, `signer`, `cluster`, `slot`, `anchored_at`, `stale_hashes` with types `TimestampMillisecond`, `String`, `Int64`; `ENGINE=mito`, no options; 0 rows; the name `event_ingest` is free.
- The D27-18 deferral does not apply.

## Task 3: docs

`docs/greptime-ledger.md` carries both DDLs, the first-record membership and position rules, no backfill, the lag, the `anchors` last-write-wins property Phase 28 must adopt, the ignored `agent_events.ingested_at` column, the smoke checks with the scratch command, and a verification-status entry stating the v0.14.4-only scope. README's `packages/ledger` line now names the pure primitives.

## Operator steps recorded, not executed

- **Deploy.** The post-merge restart of `substrate-mcp` is the first time production creates `event_ingest` (`migrate()` runs at boot). It is a deploy and needs the operator.
- **Memo program id.** The comment in `packages/ledger/src/memo.ts` that solana-cli 4.2.2 writes the v4 memo program id is carried over from September unverified; Phase 28's first devnet transaction is the first chance to check it.
- **No backfill.** Events stored before the table exists belong to no hour; Phase 28 decides the first anchored hour.

## Task Commits

1. `6611b99` test(27-04): extend the Greptime smoke with ingest order and the hour digest
2. `8cc4198` docs(27-04): record event_ingest, the canonical anchors table and ingest order

## Self-Check: PASSED

Both commits exist; `tsc` exit 0; `store-lock.test.ts` 18 pass; the smoke ran 28/28 and was torn down.
