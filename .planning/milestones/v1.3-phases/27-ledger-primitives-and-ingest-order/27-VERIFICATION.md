---
phase: 27-ledger-primitives-and-ingest-order
verified: 2026-11-12T08:31:07Z
status: human_needed
score: 16/18 must-haves verified
covered_files: [".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-01-PLAN.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-01-SUMMARY.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-02-PLAN.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-02-SUMMARY.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-03-PLAN.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-03-SUMMARY.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-04-PLAN.md", ".planning/milestones/v1.3-phases/27-ledger-primitives-and-ingest-order/27-04-SUMMARY.md", "README.md", "bun.lock", "docs/greptime-ledger.md", "packages/ledger/src/index.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/ledger/src/period.ts", "packages/ledger/src/rpc.ts", "packages/ledger/src/solana.ts", "packages/mcp-server/package.json", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "scripts/greptime-smoke.ts"]
covered_digest: "v3:sha256:34c2c34634b3e2805420e1336a226dfb53799babf09398df03fd971f1983a90d"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 18/18 must-haves verified
  gaps_closed: []
  gaps_remaining: ["production GreptimeDB v1.1.4 acceptance of event_ingest DDL and hour reads (operator deploy step)"]
  regressions: []
deferred:
  - truth: "D27-20: nothing in this phase reads or writes anchors rows"
    addressed_in: "Phase 28"
    evidence: "Phase 28 scope: ANCHOR-03..06 add the anchor job's anchors reads and writes (greptime.ts ANCHOR_COLUMNS, INSERT INTO \"anchors\"). True at phase-27 merge; no longer true at HEAD by design."
human_verification:
  - test: "After the operator-approved deploy restarts substrate-mcp, run a read-only check: SHOW CREATE TABLE event_ingest, and hourDigest for one closed hour. Also re-run the read-only anchors shape probe (SHOW CREATE TABLE anchors, DESCRIBE anchors)."
    expected: "event_ingest is in append_mode with no primary key; anchors keeps the 11-column period-keyed shape; the digest returns a non-null root and memo that recompute identically."
    why_human: "Production store and deploy are operator-gated. The 2026-10-08/09 probe results are recorded in 27-CONTEXT.md and 27-04-SUMMARY.md; this verifier did not re-run them and does not claim them."
  - test: "Run the scratch proof: rehearsal up --name p27, source stores.env, smoke:greptime, rehearsal down."
    expected: "Smoke exits 0 with 28/28 checks; each touched hour's digest is identical on two runs; the backdated event is a member of its ingest hour."
    why_human: "Needs the Phase 16 rehearsal harness and a scratch GreptimeDB (Docker). Not started by this verifier. The 2026-10-09 record is in 27-04-SUMMARY.md and was not re-run."
  - test: "Phase 28 devnet anchor transaction checks the memo program ID claim carried over from September (D27-06)."
    expected: "The v1 memo transaction is accepted by the memo program in use."
    why_human: "Devnet-only claim; stays unverified until Phase 28 sends a real transaction."
---

# Phase 27: Ledger Primitives and Ingest Order Verification Report

**Phase Goal:** Every closed hour has one deterministic Merkle root over its events in server ingest order, computed without changing `agent_events`.
**Verified:** 2026-11-12T08:31:07Z
**Status:** human_needed
**Re-verification:** Yes — fresh verifier run against the current tree. Previous report (2026-10-11, `ed696ef`) read as history only. No gaps carried forward; the one standing operator item stays open.

## Goal Achievement

### Observable Truths

| #  | Truth | Status | Evidence |
|----|-------|--------|----------|
| 1  | SC1: hour and position decided by server ingest order, recorded append-only; `agent_events` untouched | ✓ VERIFIED | `packages/mcp-server/src/greptime.ts:1016` creates `event_ingest` (`append_mode`, no primary key). `insertEvent` (`greptime.ts:1249`, ingest write at `1307-1337`) writes the record after the event row. |
| 2  | SC1: reads through typed methods; `store-lock.test.ts` green | ✓ VERIFIED | `hourLeaves` is the only new reader (`greptime.ts`, test block `greptime.test.ts:1540`). `grep` finds no `SELECT`, `sql:`, or `.sql(` in `service.ts` outside a `ROLLBACK_SELECTION_LIMIT` constant. `bun test store-lock.test.ts`: 36 pass, 0 fail. |
| 3  | SC2: closed hour yields RFC 6962 root over hashes in ingest order and memo `substrate:v1:<period_start>:<root>:<count>` | ✓ VERIFIED | `Substrate.hourDigest` (`service.ts`, `service.test.ts:2593`) composes `merkleRootHex` and `formatMemo` from `@substrate/ledger`. `formatMemo` (`packages/ledger/src/memo.ts:36-38`) emits only period, root, count. `bun test ledger` (merkle, memo, period, rpc, solana): 87 pass, 0 fail. `service.test.ts -t hourDigest`: 12 pass. |
| 4  | SC2: recomputing an hour gives the same root and memo | ✓ VERIFIED | `service.test.ts:2745` (shuffled server rows, same order); `hourDigest` tests cover identical repeated results. Live twice-run over scratch Greptime was not executed here (see human item 2). |
| 5  | D27-01: five ledger modules and tests ported byte-identical from `acc30a8` | ✓ VERIFIED (historical) — drift noted | `merkle.test.ts`, `period.test.ts`, `solana.test.ts` are byte-identical to `acc30a8`. `merkle.ts`, `memo.ts`, `rpc.ts`, `solana.ts` are not, at HEAD: later phases changed them (`sha256` now exported in `merkle.ts`; memo v2 for D73-01 in `memo.ts`; `assertDevnetRpcUrl` and `RpcUrlError` in `rpc.ts`; `transferMemoArgv` accepts v2 in `solana.ts`). The port was byte-identical at merge; it is not now. No behavior regressed (ledger tests pass). |
| 6  | D27-05: `mcp-server` imports the five pure functions and reimplements none | ✓ VERIFIED | `service.ts:11` imports `formatMemo, hourEnd, hourIso, hourStart, isClosed, merkleRootHex` (plus later phases' names) from `@substrate/ledger`. `greptime.ts:30` imports `HOUR_MS, hourEnd, hourIso, hourStart, isClosed`. No local copy. |
| 7  | D27-09: a failed ingest record never un-stores the event | ✓ VERIFIED | `service.ts:2973-2979`: `IngestNotRecorded` maps to `stored: true` with a warning and no `error`. `bun test service.test.ts -t "emit when the ingest record is not recorded"`: 6 pass, 0 fail. |
| 8  | D27-10: membership = hour of first record; position = rank by (`ingested_at`, `event_id`); duplicates collapse; earlier-hour records excluded; collector `ts` ignored | ✓ VERIFIED | `greptime.test.ts` `hourLeaves` block (line 1540 onward) and `service.test.ts:2745`. `bun test greptime.test.ts -t ingest`: 23 pass, 0 fail. |
| 9  | D27-13: leaves are `agent_events` hashes by id; missing row, malformed hash, duplicate, or non-numeric time fails naming the event; never a partial root | ✓ VERIFIED | `greptime.ts:279` (`epochMs` guard) and the `hourLeaves` failure cases in `greptime.test.ts` (lines ~1602–1629). Included in the 23 passing ingest-filtered tests. |
| 10 | D27-15: `hourDigest` refuses non-whole-hour, non-safe-integer, and open-hour starts; empty hour gives null root and memo | ✓ VERIFIED | `service.test.ts:2619-2632`; empty-hour case within the 12 passing `hourDigest` tests. |
| 11 | D27-16: lag is 300 000 ms; a late record writes a journal line naming the event and hour | ✓ VERIFIED | `INGEST_LAG_MS = 300_000` at `greptime.ts:109`. Late-record test covered by the ingest-filtered run (not run individually). |
| 12 | D27-17: canonical `anchors` DDL matches production's 11-column shape, confirmed live | ? UNCERTAIN (human) | DDL present: `greptime.ts:1038`. The live probe (2026-10-08 and 2026-10-09) is recorded in `27-CONTEXT.md` and `27-04-SUMMARY.md`. Not re-run here. Listed as human item 1. |
| 13 | D27-19/20: `migrate()` never alters `anchors`; warns only on definite shape mismatch; nothing in this phase reads or writes `anchors` rows | ✓ VERIFIED (phase-27 scope) | Shape-mismatch warning at `greptime.ts:1069-1087`; no ALTER/DROP on `anchors`. Phase 28 added `anchors` reads and writes; that is its own scope (see Deferred Items). |
| 14 | D27-03/04: `event_ingest` created in `append_mode` with no plain-`CREATE` fallback | ✓ VERIFIED | `greptime.ts:1016-1023` (warning path, no fallback). `greptime.test.ts:1276` ("creates event_ingest in append_mode with no primary key after agent_events") is in the ingest-filtered run, 23 pass. |
| 15 | D27-12: no backfill | ✓ VERIFIED | The only ingest-record writer is `insertEvent` (`greptime.ts:1249`), which runs on new events. Documented in `docs/greptime-ledger.md`. |
| 16 | D27-22: scratch run recorded with image tag and the v1.1.4 gap | ? UNCERTAIN (human) | `27-04-SUMMARY.md` and `docs/greptime-ledger.md` record `greptime/greptimedb:v0.14.4`, 28/28 checks, and the v1.1.4 gap. Not re-run here. Listed as human item 2. |
| 17 | D27-23: the deploy that first creates `event_ingest` in production is not executed by this phase | ✓ VERIFIED | Recorded as an operator step in `27-04-SUMMARY.md`; no deploy in this verification. |
| 18 | Prohibitions: memo never carries event content; no ingest record written before its event row | ✓ VERIFIED | `greptime.test.ts:1427` ("sends the event row before the ingest record...") passes in the ingest-filtered run. `formatMemo` takes only `periodStartMs`, `rootHex`, `count`. |

**Score:** 16/18 truths verified. Truths 12 and 16 are operator-gated or Docker-scratch evidence that this verifier did not re-run, so they route to human verification rather than passing.

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | D27-20: "nothing in this phase reads or writes anchors rows" (true at merge, superseded at HEAD) | Phase 28 | ROADMAP Phase 28 success criteria 2–3: `anchors` row write, `verify` reads. `greptime.ts` now has `ANCHOR_COLUMNS` and `INSERT INTO "anchors"`. |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/ledger/src/merkle.ts` | RFC 6962 root | ✓ VERIFIED | Exists, substantive, imported by `service.ts`. Drifted from `acc30a8` (`sha256` exported). |
| `packages/ledger/src/memo.ts` | `formatMemo` / `parseMemo` v1 | ✓ VERIFIED | v1 path unchanged in behavior; v2 added later (D73-01). |
| `packages/ledger/src/period.ts` | hour math, `isClosed` | ✓ VERIFIED | Byte-identical to `acc30a8`. |
| `packages/ledger/src/index.ts` | public barrel | ✓ VERIFIED | Re-exports the pure primitives; header states no SQL and no store client. |
| `packages/mcp-server/src/greptime.ts` | `event_ingest`, `hourLeaves`, `insertEvent` ingest write | ✓ VERIFIED | DDL at 1016; ingest write at 1307–1337; `INGEST_LAG_MS` at 109. |
| `packages/mcp-server/src/service.ts` | `hourDigest`, `append` ingest mapping | ✓ VERIFIED | `IngestNotRecorded` branch at 2973. |
| `scripts/greptime-smoke.ts` | scratch proof | ⚠️ NOT RUN | Present; not executed in this verification (human item 2). |
| `docs/greptime-ledger.md` | schema docs | ✓ VERIFIED | Documents `event_ingest` schema (line 69, 74) and the v0.14.4 vs v1.1.4 gap. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `Substrate.hourDigest` | `GreptimeClient.hourLeaves` | method call | ✓ WIRED | `service.ts` hourDigest path. |
| `hourDigest` | `merkleRootHex`, `formatMemo` | `@substrate/ledger` import | ✓ WIRED | `service.ts:11`. |
| `GreptimeClient.insertEvent` | `event_ingest` | ingest write after event row | ✓ WIRED | `greptime.ts:1249`, `1307-1337`. |
| `Substrate.append` | `IngestNotRecorded` | catch → `stored: true` + warning | ✓ WIRED | `service.ts:2973-2979`. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `hourLeaves` | ingest rows + leaf hashes | Greptime SELECT via `this.q` | Yes in tests (real `GreptimeClient` subclass over fixtures); live read not run | ✓ FLOWING (in tests) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Pure primitives (merkle, memo, period, rpc, solana) | `bun test packages/ledger/src/{merkle,memo,period,rpc,solana}.test.ts` | 87 pass, 0 fail | ✓ PASS |
| Store lock unedited and green | `bun test packages/mcp-server/src/store-lock.test.ts` | 36 pass, 0 fail | ✓ PASS |
| hourDigest refusals, root, empty hour | `bun test packages/mcp-server/src/service.test.ts -t hourDigest` | 12 pass, 0 fail | ✓ PASS |
| Ingest failure never un-stores | `bun test packages/mcp-server/src/service.test.ts -t "emit when the ingest record is not recorded"` | 6 pass, 0 fail | ✓ PASS |
| Ingest DDL, hourLeaves, ingest write | `bun test packages/mcp-server/src/greptime.test.ts -t ingest` | 23 pass, 0 fail | ✓ PASS |
| Scratch smoke over live Greptime | `smoke:greptime` (rehearsal harness) | not run | ? SKIP — human item 2 |

### Probe Execution

No probes declared for this phase (no `scripts/*/tests/probe-*.sh` referenced). Step 7c: SKIPPED.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| ANCHOR-01 | 27-01..04 | Hour membership by server ingest order, append-only, `agent_events` untouched, typed reads, `store-lock` green | ✓ SATISFIED | Truths 1, 2, 7, 8, 14, 18. |
| ANCHOR-02 | 27-01..04 | RFC 6962 root over ingest-ordered hashes; memo format; recompute gives the same result | ✓ SATISFIED (unit and service scope) | Truths 3, 4, 9, 10, 11. Live scratch recompute pending (human item 2). |

No orphaned requirements: REQUIREMENTS.md maps only ANCHOR-01 and ANCHOR-02 to Phase 27.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `bun.lock` | 210, 1136, 1178 | `XXX` substring inside base64 integrity hashes | ℹ️ Info | False positive from the debt-marker grep. Not a debt marker. |

No `TBD`, `FIXME`, or `XXX` debt markers in phase source or tests. No blockers.

### Security gate

`27-SECURITY.md` frontmatter: `status: verified`, `threats_open: 0`. Gate passes; no blocker.

### Human Verification Required

### 1. Production `event_ingest` and `anchors` shape (operator deploy)

**Test:** After the operator-approved deploy restarts `substrate-mcp`, run read-only `SHOW CREATE TABLE event_ingest`, `SHOW CREATE TABLE anchors`, `DESCRIBE anchors`, and `hourDigest` for one closed hour.
**Expected:** `event_ingest` is in append_mode with no primary key; `anchors` keeps the 11-column period-keyed shape; the digest returns a non-null root and memo that recompute identically.
**Why human:** Production and deploy are operator-gated. The 2026-10-08/09 probe is recorded but was not re-run here.

### 2. Scratch smoke proof

**Test:** `rehearsal up --name p27`, source `stores.env`, `smoke:greptime`, `rehearsal down`.
**Expected:** exit 0 with 28/28 checks; digests identical across two runs; the backdated event sits in its ingest hour.
**Why human:** Needs the Phase 16 rehearsal harness and Docker scratch GreptimeDB. Not started here.

### 3. Memo program ID (D27-06)

**Test:** Phase 28 devnet anchor transaction.
**Expected:** the memo program accepts the v1 memo.
**Why human:** Devnet-only; unverified until Phase 28 sends a real transaction.

### Gaps Summary

No must-have failed. Sixteen of eighteen truths are verified by code reading and by tests run in this session: 87 (ledger pure modules), 36 (`store-lock`), 12 (`hourDigest`), 6 (ingest-failure branch), and 23 (ingest-filtered `greptime`), all with 0 failures. Two truths (12 and 16) rest on operator-gated or Docker-scratch evidence recorded in earlier summaries, so they route to human verification. The status is `human_needed`, not `passed`.

Drift to note: four ledger modules (`merkle.ts`, `memo.ts`, `rpc.ts`, `solana.ts`) are no longer byte-identical to `acc30a8` because later phases changed them. Tests still pass, so the goal is not affected.

---

_Verified: 2026-11-12T08:31:07Z_
_Verifier: Claude (gsd-verifier)_
