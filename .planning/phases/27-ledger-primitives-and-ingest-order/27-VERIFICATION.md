---
phase: 27-ledger-primitives-and-ingest-order
verified: 2026-10-11T00:00:00Z
status: passed
score: 18/18 must-haves verified
covered_files: [".planning/phases/27-ledger-primitives-and-ingest-order/27-01-PLAN.md", ".planning/phases/27-ledger-primitives-and-ingest-order/27-01-SUMMARY.md", ".planning/phases/27-ledger-primitives-and-ingest-order/27-02-PLAN.md", ".planning/phases/27-ledger-primitives-and-ingest-order/27-02-SUMMARY.md", ".planning/phases/27-ledger-primitives-and-ingest-order/27-03-PLAN.md", ".planning/phases/27-ledger-primitives-and-ingest-order/27-03-SUMMARY.md", ".planning/phases/27-ledger-primitives-and-ingest-order/27-04-PLAN.md", ".planning/phases/27-ledger-primitives-and-ingest-order/27-04-SUMMARY.md", ".planning/phases/27-ledger-primitives-and-ingest-order/27-BASELINE.md", ".planning/phases/27-ledger-primitives-and-ingest-order/27-CONTEXT.md", ".planning/phases/27-ledger-primitives-and-ingest-order/COVERAGE.md", "README.md", "bun.lock", "docs/greptime-ledger.md", "packages/ledger/src/index.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.test.ts", "packages/ledger/src/merkle.ts", "packages/ledger/src/period.test.ts", "packages/ledger/src/period.ts", "packages/ledger/src/rpc.test.ts", "packages/ledger/src/rpc.ts", "packages/ledger/src/solana.test.ts", "packages/ledger/src/solana.ts", "packages/mcp-server/package.json", "packages/mcp-server/src/greptime.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/redact-lock.test.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/store-lock.test.ts", "scripts/greptime-smoke.ts"]
covered_digest: "v3:sha256:3baef714e8c9c78d547037885964829eca161d85a60b79ed8c33d8c735f6d25f"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 18/18
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 27: Ledger Primitives and Ingest Order Verification Report

**Phase Goal:** Every closed hour has one deterministic Merkle root over its events in server ingest order, computed without changing `agent_events` (ANCHOR-01/ANCHOR-02).
**Verified:** 2026-10-11 (source-first re-verification on integration branch `swarm/v13-autonomous-integration`, source commit `76a4b2c`; parent committed green after source final proof; this verifier ran zero tests/builds — metadata CLI only)
**Status:** passed
**Re-verification:** Yes — after corrected source union; previous 2026-10-09 report was `passed` 18/18; all 18 must-haves preserved and re-checked, no scope reduction.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Event hour/position decided by server ingest order, recorded append-only; `agent_events` rows, hashes, columns unchanged | ✓ VERIFIED | `greptime.ts:727-728` event `INSERT` via `EVENT_COLUMNS`/`EVENT_COLUMN_LIST` precedes ingest write; `greptime.ts:761-764` ingest `INSERT` second with fresh `this.clock()` stamp per attempt (`:759`); no `ALTER` of `agent_events` (only `CREATE IF NOT EXISTS` for `event_ingest` `:556` and `anchors` `:567`); `EVENT_COLUMNS` (`:57-77`) holds no `ingested_at`; D-era column explicitly unused (`docs/greptime-ledger.md:133-135`) |
| 2 | Reads go through typed methods; `store-lock.test.ts` green unedited | ✓ VERIFIED | `hourLeaves` lives in `greptime.ts:889`; `service.ts` composes it via `hourDigest` (`service.ts:2485`); parent final gates: locks 108/0, `EVENT_KINDS` 12, `SURFACES` 27 (green evidence); review confirms service adds no raw SQL |
| 3 | Closed hour yields RFC 6962 root over event hashes in ingest order + memo `substrate:v1:<period_start>:<root>:<count>` | ✓ VERIFIED | `service.ts:2506-2507` `merkleRootHex(leaves…)` + `formatMemo({periodStartMs, rootHex, count})`; `merkle.ts:44` pins 64-hex leaves; `memo.ts:9` `MEMO_RE` pins exact memo shape; imports from `@substrate/ledger` (`service.ts:10`), nothing reimplemented |
| 4 | Recomputing the hour gives same root and memo | ✓ VERIFIED | Smoke digests every touched hour twice (`greptime-smoke.ts:235-237`); parent scratch 47/47 (28 ingest/ledger + 19 fake-chain) on real v0.14.4; validation maps shuffle-invariance to `service.test.ts:1933-1980` via real-client subclass |
| 5 | Five ledger modules + five tests ported; pure, compilable | ✓ VERIFIED | All 11 files present under `packages/ledger/src/`; historical `cmp` 10/10 identical recorded in 27-01-SUMMARY; security re-audit confirms historical port, attributes later RPC genesis-hash edit to Phase 28 (`28-01-SUMMARY.md:123-124`) — not falsely claimed byte-identical at HEAD |
| 6 | `mcp-server` imports five pure functions, reimplements none | ✓ VERIFIED | `service.ts:10` imports `formatMemo, hourEnd, hourIso, hourStart, isClosed, merkleRootHex`; `greptime.ts` imports period helpers; `INGEST_LAG_MS` lives in `greptime.ts:42` keeping `period.ts` byte-identical |
| 7 | Failed ingest record never un-stores the event | ✓ VERIFIED | `greptime.ts:741,747-748,782` every post-store failure throws `IngestNotRecorded(event.id, …)`; `service.ts:913-921` branches first → `stored:true` + `INGEST_NOT_RECORDED` warning (+ dedup caveat), one redacted journal line; other errors stay `stored:false` (`:923`) |
| 8 | Membership = hour of first record; position = rank by (`ingested_at`, `event_id`); duplicates collapse; earlier-hour exclusion; collector `ts` plays no part | ✓ VERIFIED | `greptime.ts:903-914` first-record collapse + code-unit sort; `:919-922` unbounded earlier-record exclusion per ≤500-id batch; backdated membership pinned in smoke (`:261-271`: September-`ts` event in ingest hour, September hour empty `:272-277`); hash-lookup bounds only use `event_ts` (`:930-933`) |
| 9 | Leaves are `agent_events` hashes by id; missing row / non-64-hex / two hashes / non-numeric time fail naming event, never partial root | ✓ VERIFIED | `greptime.ts:910-911` non-numeric time names event; `:938` two-hashes throw; `:944-945` missing row / bad hash throw naming event; `service.ts:2498-2507` awaits full leaf read before any root |
| 10 | `hourDigest` refuses non-whole-UTC / unsafe-integer starts and open hours; empty hour → null root/memo | ✓ VERIFIED | `service.ts:2486-2495` safe-integer + `hourStart` whole-hour + `isClosed` refusal; `:2505` empty → `{root:null, memo:null}` with zero count + ids |
| 11 | Lag is 300 000 ms; record landing after its hour closed writes journal line naming event + hour | ✓ VERIFIED | `greptime.ts:42` `INGEST_LAG_MS = 300_000`; `:770-774` `isClosed(hour, this.clock(), INGEST_LAG_MS)` late-record diagnostic naming event + hour; validation pins CLOSED-1 silent / CLOSED warn via actual `insertEvent` (`greptime.test.ts:1120-1149`); fresh cross-hour retry stamp pinned (`:1012-1036`) |
| 12 | Canonical `anchors` DDL is production's shape, verified live (historical) | ✓ VERIFIED | `greptime.ts:567-580` 11-column DDL (period_start TIME INDEX … stale_hashes, no PK, no append_mode); historical APPROVED probe 2026-10-08 retained in `27-CONTEXT.md:209-242`, repeated 2026-10-09 (`27-04-SUMMARY.md:66-72`): 11 columns in order, `ENGINE=mito`, no options, 0 rows, `event_ingest` name free. No fresh live claim this turn |
| 13 | `migrate()` never alters `anchors`, warns only on definite mismatch; phase writes/reads no `anchors` rows | ✓ VERIFIED | `greptime.ts:586-601` silent on empty/failed reads, warns only on definite shape mismatch; never `ALTER/DROP/recreate`; Phase-27-added `hourLeaves`/`hourDigest`/`insertEvent` contain no `anchors` row I/O (row APIs at HEAD are Phase 28 layers per review diff isolation) |
| 14 | `event_ingest` created `append_mode` with no plain-`CREATE` fallback | ✓ VERIFIED | `greptime.ts:556` `WITH ('append_mode'='true')`, no PK; `:558-563` failure warns, no fallback; `:622-628` + `:684-751` refuse/skip ingest on definite non-append or exhausted budget via `IngestNotRecorded`, never silent dedup |
| 15 | No backfill | ✓ VERIFIED | No code path synthesizes records for stored events; `docs/greptime-ledger.md:335-336` "no backfill … first anchored hour is Phase 28's decision"; `firstIngestMs` (`greptime.ts:1006`) defines coverage start as earliest record |
| 16 | Scratch run recorded with image tag and v1.1.4 gap | ✓ VERIFIED | `scripts/greptime-smoke.ts:187-277` §5 burst/backdated/twice-identical/subset-order/chain-intact; parent runtime evidence: real v0.14.4, ledger 47/47 (28+19), up/down 0, 2 owned containers removed; docs state v0.14.4-only scope + v1.1.4 gap |
| 17 | Deploy that first creates `event_ingest` in production NOT executed by this phase | ✓ VERIFIED | No production write beyond historical read-only probe; operator deploy step recorded in 27-04-SUMMARY and docs; this verifier performed zero network/production actions |
| 18 | Prohibitions: memo never carries event content; no ingest record before its event row | ✓ VERIFIED | `MEMO_RE` admits only period/root/count; `formatMemo` takes no content; event `INSERT` (`:728`) strictly precedes ingest loop (`:730-731` comment + code); failure diagnostic names event/hour only, cause scrubbed (`scrub` = `redactKnown` empty-only + `redact`, `:390-404,437-438`); parent confirms corrected opaque failure: errors without echo, smoke exit 1 truthful |

**Score:** 18/18 truths verified (0 present-behavior-unverified, 0 overrides).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/ledger/src/{merkle,memo,period,rpc,solana}.ts` + 5 tests + `index.ts` | Pure primitives, byte-identical port | ✓ VERIFIED | All present; historical identity proved; later RPC delta attributed to Phase 28, not claimed as Phase 27 |
| `packages/mcp-server/src/greptime.ts` | DDL, ingest write, hourLeaves, guards | ✓ VERIFIED | Substantive + wired (see truths 1,7-9,11-14) |
| `packages/mcp-server/src/service.ts` | append mapping, hourDigest | ✓ VERIFIED | Substantive + wired (truths 7,10,3) |
| `packages/mcp-server/src/greptime.test.ts` + `service.test.ts` | Ordering/retry/refusal/determinism cases incl. G27-01/G27-02 + isolated drift cases | ✓ VERIFIED | Cited ranges reviewed via validation; parent full suite 2718/58/0 green |
| `scripts/greptime-smoke.ts` | §5 ingest-order proof | ✓ VERIFIED | Subset-order, twice-identical, backdated, chain-intact |
| `docs/greptime-ledger.md` + `README.md` | Both DDLs, guarantees, gap, primitives line | ✓ VERIFIED | DDLs match code; dedup/d-era/gap recorded |
| `27-BASELINE.md` + `COVERAGE.md` | Base record, no-new-API declaration | ✓ VERIFIED | Present |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `service.ts`/`greptime.ts` | `@substrate/ledger` | `merkleRootHex, formatMemo, hourStart, hourEnd, isClosed` imports | WIRED | No local reimplementation |
| `insertEvent` | `event_ingest` | Event row first, fresh-stamp retry, `IngestNotRecorded` | WIRED | `service.append` maps to stored-with-warning |
| `hourLeaves` | `hourDigest` | Typed leaves → root/memo | WIRED | Fail-closed, no partial root |
| `migrate()` | `event_ingest` + `anchors` | Post-`agent_events` DDL, shape warning | WIRED | No ALTER/DROP; silent-when-unanswerable |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `hourLeaves` | `HourLeaf.hash` | `agent_events.hash` by id, bounded `IN` lookup | Yes — missing/bad/double hash throws, never partial | ✓ FLOWING |
| `hourLeaves` | membership/order | `event_ingest.ingested_at` + `event_id` first-record collapse | Yes — server order independent | ✓ FLOWING |
| `hourDigest` | `root`/`memo` | `merkleRootHex` + `formatMemo` over ordered leaves | Yes — independent single-leaf oracle + literal RFC vectors | ✓ FLOWING |

### Behavioral Spot-Checks

Not run by this verifier (contract: zero tests/builds/runtime). Behavior is attributed to parent-owned gates: full suite 2718/58/0 across 96 files, types 0, locks 108/0 (`local://v13-final-green-evidence.json` — latest 2718 after tautology deletion; preceding 2719 is the real earlier run, not inferred); ledger scratch 47/47 real v0.14.4 (28 ingest + 19 authorized fake-chain), up/down 0, 2 owned containers removed (`local://v13-final-runtime-evidence.json`); opaque-credential failure: errors without echo, smoke exit 1 truthful; shell 0/shellcheck 0; formatter none configured, none claimed.

### Probe Execution

No phase-declared `probe-*.sh` for Phase 27. Scratch proof is `scripts/greptime-smoke.ts` via parent-owned rehearsal (see above). Not re-executed here.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| ANCHOR-01 | 27-02, 27-03, 27-04 | Server ingest order, append-only, `agent_events` untouched, typed methods, lock green | ✓ SATISFIED | Truths 1,2,7,8,11-15,17 |
| ANCHOR-02 | 27-01, 27-03, 27-04 | RFC 6962 root in ingest order + `substrate:v1` memo per closed hour | ✓ SATISFIED | Truths 3-6,9,10,16 |
| ANCHOR-03/04/05/06 | — | Timer, solana send, verify, live proof | — OUT OF SCOPE | Phase 28 / operator; memo program-ID unverified per D27-06; v1.1.4 deploy open per D27-23. Not waived, not faked |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | `TBD/FIXME/XXX/TODO/placeholder/stub` in phase-touched source | None found | — |
| `greptime.ts:187` | comment | `placeholder` (pre-existing `withoutLiterals` commentary) | ℹ️ Info | Untouched by this phase |
| Review IN-02..IN-05 | — | Non-whole-hour `hourLeaves` input; `pubkeyArgv` asymmetry; shape-check silence semantics; `rpc.ts` header-level review limit | ℹ️ Info | Observations, not defects; no code change required |

Timestamp-fallback note: review IN-01's earlier `Date.parse` proposal is **withdrawn** — strict numeric fail-closed (`epochMs` NaN → named-event throw) is the declared D27-10/D27-13 contract. No lenient parsing invented.

### Human Verification Required

None. All 18 in-scope truths are source-verified with parent-owned green gates attributed.

### Operator Steps Retained (explicit, not gaps)

1. **Production deploy** (D27-23): post-merge restart first creates `event_ingest` on live v1.1.4 — operator action, not executed here. New-statement behavior on v1.1.4 unobserved; scratch proves v0.14.4 only.
2. **Memo program-ID claim** (D27-06): `memo.ts` comment stays unverified; Phase 28's real devnet transaction is the first check. The 19 fake-chain checks are supplementary, not devnet proof.
3. **First anchored hour / adopt-before-write** (D27-12/D27-20): Phase 28 decides; no backfill.
4. **Low-severity supply-chain acceptance** (T-27-SC): authored accept rationale exists in plan/summary but canonical log entry missing — open, non-blocking, below high threshold. No acceptance fabricated.

### Gaps Summary

No gaps. Phase goal achieved: every closed hour has one deterministic Merkle root over its events in server ingest order, computed without changing `agent_events`. Follow-ons above are deliberately operator-owned per existing plans, not scope shrink.

---

_Verified: 2026-10-11_
_Verifier: Claude (gsd-verifier, Phase27GoalVerifier)_
_Native gates: 27-REVIEW.md 0 critical/0 warning/5 info (IN-01 corrected); 27-SECURITY.md SECURED 10/11 high 0 open (T-27-SC low open, no fabrication); 27-VALIDATION.md validated, nyquist_compliant true, G27-01/G27-02 closed._
