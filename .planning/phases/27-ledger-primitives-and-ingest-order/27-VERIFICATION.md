---
phase: 27-ledger-primitives-and-ingest-order
verified: 2026-10-09T10:37:48Z
status: passed
score: 18/18 must-haves verified
covered_files: [".planning/phases/27-ledger-primitives-and-ingest-order/27-01-PLAN.md", ".planning/phases/27-ledger-primitives-and-ingest-order/27-01-SUMMARY.md", ".planning/phases/27-ledger-primitives-and-ingest-order/27-02-PLAN.md", ".planning/phases/27-ledger-primitives-and-ingest-order/27-02-SUMMARY.md", ".planning/phases/27-ledger-primitives-and-ingest-order/27-03-PLAN.md", ".planning/phases/27-ledger-primitives-and-ingest-order/27-03-SUMMARY.md", ".planning/phases/27-ledger-primitives-and-ingest-order/27-04-PLAN.md", ".planning/phases/27-ledger-primitives-and-ingest-order/27-04-SUMMARY.md", "README.md", "bun.lock", "docs/greptime-ledger.md", "packages/ledger/src/index.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/ledger/src/period.ts", "packages/ledger/src/rpc.ts", "packages/ledger/src/solana.ts", "packages/mcp-server/package.json", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "scripts/greptime-smoke.ts"]
covered_digest: "v3:sha256:fdd3330f7557877c965f6970da4da8de3ea52b452c75a751e114b77aeb832f4b"
behavior_unverified: 1
overrides_applied: 0
re_verification:
  previous_status: none
  previous_score: n/a
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 27: Ledger Primitives and Ingest Order Verification Report

**Phase Goal:** Every closed hour has one deterministic Merkle root over its events in server ingest order, computed without changing `agent_events`.
**Verified:** 2026-10-09T09:58:16Z (HEAD `03f45d2` plus this report)
**Status:** passed, with one behaviour that cannot be proved before deploy (listed under Behavior Not Verified).
**Base:** `gsd/v1.3-base-18`, which is Phase 18's rebased tip on top of `main` at `28b5b99`.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1: an event's hour and position are decided by server ingest order, recorded append-only; `agent_events` rows, hashes and columns are unchanged | ✓ VERIFIED | `event_ingest` (`append_mode`, no primary key) is written by `insertEvent` after the event row, with a server-side clock stamp. `git diff gsd/v1.3-base-18...HEAD` shows no change to `types.ts`, `event.ts`, `EVENT_COLUMNS` or the `agent_events` DDL; the only DDL lines added are `event_ingest` and `anchors`. |
| 2 | SC1: reads go through typed methods and `store-lock.test.ts` stays green, unedited | ✓ VERIFIED | `hourLeaves` is the only new reader and lives in `greptime.ts`; `service.ts` has no `SELECT`, `sql:` or `.sql(` line. `store-lock.test.ts` 18 pass, no diff against the base. `vocabulary-lock` and `redact-lock` (15 pass) also unedited. |
| 3 | SC2: a closed hour yields an RFC 6962 root over event hashes in ingest order and the memo `substrate:v1:<period_start>:<root>:<count>` | ✓ VERIFIED | `Substrate.hourDigest` calls `merkleRootHex` and `formatMemo` from `@substrate/ledger`. A single leaf digests to `sha256(0x00 ‖ hash)` (computed independently in the test); the memo matches `^substrate:v1:\d{4}-…:[0-9a-f]{64}:\d+$` and parses back with `parseMemo`. |
| 4 | SC2: recomputing the hour gives the same root and memo | ✓ VERIFIED | Service tests: identical across calls; identical for three shufflings of the server's rows through a real `GreptimeClient` subclass; scratch smoke: identical twice over a live 12-event hour. |
| 5 | D27-01: the five ledger modules and their 45 tests are ported byte-identical from `acc30a8` | ✓ VERIFIED | `git show acc30a8:packages/ledger/src/<f>` compared with `cmp` for `merkle`, `memo`, `period`, `rpc`, `solana` and their tests: all ten identical. RFC 6962 reference vectors pass. |
| 6 | D27-05: `mcp-server` imports the five pure functions and reimplements none | ✓ VERIFIED | `service.ts` and `greptime.ts` import `formatMemo, hourEnd, hourIso, hourStart, isClosed, merkleRootHex` from `@substrate/ledger`; no local copy; `bunx tsc` resolves the workspace link. |
| 7 | D27-09: a failed ingest record never un-stores the event | ✓ VERIFIED | `append` branches first on `IngestNotRecorded`: `stored: true`, a warning, no `error`, one redacted journal line naming the event. Six service tests; disabling the branch fails four of them (mutation). A failure before the event row lands is still `stored: false`. |
| 8 | D27-10: membership is the hour of the first record; position is the rank by (`ingested_at`, `event_id`); duplicates collapse; earlier-hour records exclude; collector `ts` plays no part | ✓ VERIFIED | `hourLeaves` unit cases (shuffled rows, duplicate E1/E5, backdated E3, earlier-record E4); service-level shuffle test; scratch smoke recomputes the order from raw rows and the backdated event (ts 2026-09-01) lands in its ingest hour while the September hour is empty. |
| 9 | D27-13: leaves are `agent_events` hashes looked up by id; a missing row, a hash that is not 64 lowercase hex, two hashes for one id, or a non-numeric time fails naming the event and never returns a partial root | ✓ VERIFIED | Five `hourLeaves` failure cases plus two service cases. The non-numeric-time guard (`epochMs`) was added by this phase's self-review. |
| 10 | D27-15: `hourDigest` refuses a start that is not a whole UTC hour or not a safe integer, refuses an open hour, returns a null root and memo for an empty hour | ✓ VERIFIED | Service tests over `H10+1`, `1.5`, `NaN`, `Infinity`, `MAX_SAFE_INTEGER`, `2**60`; closed exactly at end + lag (`CLOSED-1` refused, `CLOSED` accepted); empty hour equals `{event_count: 0, root: null, memo: null, event_ids: []}`. |
| 11 | D27-16: the lag is 300 000 ms and a record landing after its hour closed writes a journal line naming the event and the hour | ✓ VERIFIED | `INGEST_LAG_MS = 300_000` asserted; the late-record test checks the line; ignoring the lag fails a test (mutation). |
| 12 | D27-17: the canonical `anchors` DDL is production's shape, verified live | ✓ VERIFIED | Operator-approved read-only probe 2026-10-08 (recorded in `27-CONTEXT.md`) and repeated 2026-10-09 through the append-only-guarded client: 11 columns in order, `ENGINE=mito`, no options, 0 rows; `event_ingest` name free. |
| 13 | D27-19/20: `migrate()` never alters `anchors`, warns only on a definite shape mismatch, and nothing in this phase reads or writes `anchors` rows | ✓ VERIFIED | Six `migrate` cases (including silent-when-unreadable); `rg 'INTO "anchors"|FROM "anchors"'` over non-test sources finds nothing. |
| 14 | D27-03/04: `event_ingest` is created in `append_mode` with no plain-`CREATE` fallback | ✓ VERIFIED | The "warns without a plain-CREATE fallback" test; the scratch server accepted the DDL. |
| 15 | D27-12: no backfill | ✓ VERIFIED | No code path writes records for stored events; documented in `docs/greptime-ledger.md`. |
| 16 | D27-22: the scratch run is recorded with image tag and the v1.1.4 gap | ✓ VERIFIED | `greptime/greptimedb:v0.14.4`, `postgres:16`, 28/28 including 12 new checks; instance torn down, no containers left. `27-04-SUMMARY.md` and the docs record the gap. |
| 17 | D27-23: the deploy that first creates `event_ingest` in production is not executed by this phase | ✓ VERIFIED | No production request beyond the approved read-only probe; recorded as an operator step in `27-04-SUMMARY.md`. |
| 18 | Prohibitions: the memo never carries event content; no ingest record is written before its event row | ✓ VERIFIED | Memo regex test rejects an `evt_` id in the memo; the greptime test "sends the event row before the ingest record" pins statement order. |

**Score:** 18/18 truths verified.

### Behavior Not Verified

- How production **GreptimeDB v1.1.4** parses the new `event_ingest` DDL and the hour reads. Scratch runs v0.14.4. This is only observable at the post-merge restart, which is an operator deploy; `migrate()` reports a problem as a boot warning and never fails boot, and `emit` degrades to stored-with-warning.

## Gate Evidence

| Gate | Result |
|---|---|
| `bun install --frozen-lockfile` | no changes |
| `bunx tsc --noEmit` | exit 0 |
| full `bun test` | 1719 pass / 57 skip / 0 fail (59 files) |
| flake probe, `--rerun-each 3` on `packages/ledger`, `greptime.test.ts`, `service.test.ts`, `store-lock.test.ts` | 759 pass / 0 fail |
| `bun run check:phase-close` | pass (4 lock files; `EVENT_KINDS` unchanged at 12; `SURFACES` = baseline + `substrate`) |
| `redact-lock.test.ts` | 15 pass |
| scratch harness proof (`rehearsal up --name p27`, `stores.env`, `smoke:greptime`, `down`) | 28/28 on GreptimeDB v0.14.4; torn down |
| mutations (ingest branch off; leaves reversed; lag ignored) | 4, 2 and 1 service tests fail respectively |

### Perf gate (hot path: `insertEvent` gained a second `INSERT`)

200 sequential `POST /events` and `POST /brief` on isolated rehearsal twins, base commit `ab62ba4` against this phase's head, four interleaved rounds (the host was noisy: single rounds ranged p95 10.3–19.7 ms on both sides):

| Endpoint | Median-of-rounds p50 before → after | Median-of-rounds p95 before → after |
|---|---|---|
| `POST /events` | 8.6 → 9.3 ms (+8%) | 11.0 → 11.6 ms (+5%) |
| `POST /brief` | 7.7 → 7.1 ms | 9.7 → 9.4 ms |

No p95 regression above the 15% bar. Worst case worth knowing: if the ledger stalls *after* the event row lands, the two ingest attempts add up to two client timeouts (5 s each) to that `emit`; the caller still gets `stored: true`.

## Review

- **Code review (self, no subagent available):** 0 critical. One warning fixed (a non-numeric `ingested_at` or `event_ts` produced an unstable order or a bare `RangeError`; now names the event, 3 tests). Info noted, not changed: the hash read's time bounds span the batch's `event_ts` range, so a batch mixing a September backdated event with current ones scans a wide time window.
- **Security review:** every ingest value goes through the dialect-aware `quote`; `graph_id` null renders `NULL`; ids are server-minted; every statement passes `assertAppendOnly`; no new route, tool, token, dependency or environment variable; `hourDigest` has no network surface (no REST route or MCP tool), so no new authorization question; journal and warning text name event ids and hours only, and the cause is redacted.
- **Nyquist validation:** `27-VALIDATION.md` set to `validated`, `nyquist_compliant: true`; every requirement-level behaviour has an automated command that passed; the one manual-only row (v1.1.4 acceptance) is an operator deploy step.

## Operator Steps Recorded

1. **Deploy** the merged build; `migrate()` creates `event_ingest` on first boot. Check the boot log for migrate warnings.
2. Phase 28's first devnet transaction checks the memo program-id claim carried over from September (unverified here).
3. Phase 28 decides the first anchored hour (no backfill) and adopts `anchors` rows with a read-before-write.

## Re-verification after restacking (2026-10-09)

Phase 18's review round 2 changed the redactor this phase builds on, and `main` gained the verification-gate PR, so the branch was restacked onto Phase 18's new tip. Nothing in this phase changed. Gate on the restacked head: bun run verify: install, types, tests, locks all ok; 1785 pass / 57 skip / 0 fail. The report's fingerprint was refreshed (the base now carries the verification-gate PR and Phase 18's review fixes).

