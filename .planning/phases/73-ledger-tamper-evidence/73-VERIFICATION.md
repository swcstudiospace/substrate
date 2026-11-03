---
phase: 73-ledger-tamper-evidence
verified: 2026-11-03T11:27:35Z
status: human_needed
score: 8/8 must-haves verified (T2 counted as PASSED override)
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", "docs/greptime-ledger.md", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/mcp-server/src/anchor-verify-deps.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:bcd3614dd262f37440fdff3a1527e8a1e43e3e343aa07cfe271de5256fa06fa6"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof criterion 1 compares against; a head recomputed from the stored rows is never the proof."
    reason: "Owner accepted the commitment reading on 2026-11-02: each graph head is committed on chain by the memo v2 heads_root and recovered only through stored leaves that reproduce it. Carried from the prior record; acceptance not re-obtained here. This override covers the commitment reading only. It does not cover the write-path gap B2 below."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: gaps_found
  previous_score: 7/8
  previous_verified: 2026-11-03T10:34:53Z
  previous_scope: "worktree /root/src/worktrees/as-gsd-v18-all, HEAD 97defd59 (memo v3 round 4, fix(73))"
  scope: "worktree /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD f86388cf (62a25181 NUL refusal; f86388cf doc wording)"
  reason: "Re-verified after 62a25181, which refuses a graph id with a NUL byte at write (event.ts GraphIdNulError, normalizeGraphId) and before any send (anchor.ts pointerPlans). f86388cf changes only the cache-off sentence in docs/greptime-ledger.md, in the buffer section, outside the v3 section."
  gaps_closed:
    - "B2 (NUL byte in a graph id): refused at write (event.ts:230, GraphIdNulError at :215, normalizeGraphId :227-235; normalizeEvent is the only route to insertEvent) and before any send (anchor.ts:556 in pointerPlans; pre-send check at anchor.ts:958-967; adopt path completePointers at anchor.ts:902, caught as send-failed). Named tests: event.test.ts:309-311 and :314; anchor.test.ts:1519. All pass in this pass."
    - "Criterion 1 tests not re-run at 97defd59: service.test.ts:5386, :5398, :5414, :5513, plus G1 :5594 and :5644. All six pass in this pass."
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Devnet 0-lamport pointer probe: send a 0-lamport pointer to an unfunded index address and record the refusal text"
    expected: "The refusal text decides POINTER_REFUSED_RE (anchor.ts:85) and whether the funded path is ever needed. Record the answer in the phase."
    why_human: "Needs devnet, a funded test key and a live send. The verifier does not send transactions."
  - test: "Live devnet send of one pointer whose graph id is 512 UTF-8 bytes, read back with transactionMemo"
    expected: "The transaction serialises within the 1,232-byte limit, and the measured size replaces the hand-counted 251-byte overhead (memo.test.ts:231-241)."
    why_human: "Needs a live send. The overhead is hand-counted and not measured from transferArgv."
  - test: "Scan the live agent_events store: graph_id over 512 bytes, any graph_id containing a NUL byte, and v2 memos in the anchor listings"
    expected: "Zero rows, or an owner decision on each (stored-id decision below). A stored U+FFFD may come from a lone-surrogate write and cannot be told from a real U+FFFD by the scan."
    why_human: "Needs read access to the live store."
  - test: "RPC history depth for index addresses (N5): find the oldest signature still listed on a job-key address and on an index address"
    expected: "The depth is known. The owner decides whether a pruned pointer for an old hour is acceptable. Until then G1 is not fully closed for hours older than that depth."
    why_human: "Needs live RPC, and the acceptance is a policy call."
  - test: "Budget measurement for a year-old graph (W-N8): time verifyGraph under the 30 s default (config.ts:1207)"
    expected: "A measured time. The default changes only if the measurement exceeds 30 s."
    why_human: "Needs live data at realistic size."
  - test: "Owner decision on Q8: a graph whose only hour lost its pointer and rows verifies ok true, trusted false, 'no events' (service.test.ts:5843)"
    expected: "Accept it as a named residual, or change the verdict to fail closed. The test pins the current behaviour."
    why_human: "Policy decision. Not ratified."
  - test: "Owner decision on stored graph ids over 512 bytes or containing NUL (no data repair decided)"
    expected: "A recorded decision. Until then a live anchor run against a store holding such rows halts at the first such hour."
    why_human: "Data-repair policy. Owner call."
  - test: "Owner decision on W-L1: refuse a graph id that is not well-formed UTF-16 at write, as NUL is refused in 62a25181"
    expected: "A recorded decision. If refused: a named error and a test beside event.test.ts:309."
    why_human: "Extends the owner's B1/B2 remedy to a new class of id."
  - test: "HARD-S3: decide whether scheduled verification is in this phase or a later one, and name the trusted earlier proof for it"
    expected: "A decision recorded against REQUIREMENTS.md:114 and :135."
    why_human: "Scope decision. Still open."
---

# Phase 73: Ledger tamper evidence Verification Report

**Phase Goal:** A rewrite, reorder, deletion or tail truncation of the event ledger is detected by recomputing the chain from stored rows, and the verified head is anchored.
**Verified:** 2026-11-03T11:27:35Z
**Status:** human_needed
**Re-verification:** Yes, after 62a25181 (B2 NUL refusal), at f86388cf; previous record at 97defd59, status gaps_found, score 7/8.

## Scope and method

- Worktree `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `f86388cf`. Read-only: no code edits, no commits. The only write is this file.
- Changes since 97defd59: `62a25181` (event.ts, event.test.ts, anchor.ts, anchor.test.ts) and `f86388cf` (docs/greptime-ledger.md, buffer section only, outside the v3 section). `config.ts` is unchanged since `500e4fb3`. `service.ts` and `greptime.ts` are unchanged since 97defd59.
- Mode: re-verification. B2 was the only carried gap, so it gets the full check. Items that passed at 97defd59 get regression by named test.
- Targeted runs (two `bun test` commands, `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`, `--timeout 30000`):
  1. `bun test packages/ledger/src/memo.test.ts packages/mcp-server/src/event.test.ts packages/mcp-server/src/anchor.test.ts`: **143 pass, 0 fail**, 498 expect calls, 3.0 s. This is the 140 from 97defd59 plus the three tests 62a25181 adds. Whole-file coverage: B1 (memo.test 150-241, event.test 277-300), N1 (anchor 1494-1517 and the new 1519), N2 (1404), W2 alarms (473, 495, 518), order (1343, 1363).
  2. `bun test packages/mcp-server/src/service.test.ts -t "v3 pointers|naming the devnet guard|first_differing_event_id|first_missing_event_id|a full rewrite with every hash|a trailing hour whose rows|single anchored hour|no events"`: **32 pass, 0 fail**, 284 filtered. The 97defd59 set was 26. The six added are 5386, 5398, 5414, 5513 (criterion 1, not re-run at 97defd59) and 5594, 5644 (G1 rows-and-ingest removed). Covers the v3 pointers block (G1 1a, 1b, single hour; N3 5877-5926; Q8 5843), the RPC guard (4283) and no-events (5710).
- Ad hoc Bun/Node probes, not test runs (see Behavioral Spot-Checks).
- Debt markers (TBD, FIXME, XXX) in the changed files: none.
- Probes (Step 7c): none declared or present.
- Fingerprint: `gsd-tools query verification.fingerprint` over the 97defd59 file set. The digest moved from `d81d…` to `bcd3…` because implementation files changed.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| T1 | SC1: an edited payload, a deleted middle event, truncated last events and a full rewrite are each compared with the saved head; the first differing or first missing id is named | ✓ VERIFIED | Named runs in this pass pass: `service.test.ts:5386` (first_differing), `:5398` (middle deletion), `:5414` (truncation, first_missing), `:5513` (full rewrite). No chain-check function changed between 97defd59 and f86388cf. |
| T2 | SC2: each graph's chain head is recorded in the hourly anchor and the recorded head is the trusted proof | ✓ PASSED (override) | Memo v2 `heads_root` (`memo.ts:41-46`), per-session head records (`packages/ledger/src/heads.ts`), trust against the on-chain root (`service.ts:8409`, `:8470`). Owner override 2026-11-02, commitment reading only. |
| T3 | G1: an anchored hour removed from `agent_events`, `event_ingest` and `graph_chain_leaves` fails the verdict and is named | ✓ VERIFIED for pointer-listed hours (bounded by N5, Q8) | Pass in this pass: `service.test.ts:5810` (1a), `:5819` (1b), `:5827` (single hour, with pointer), `:5594` and `:5644` (rows and ingest removed, leaves kept). Q8 (`:5843`) pins `ok` true for a graph with no landed pointer; N5 is a pruned listing. Both stay open, below. |
| T4 | The hourly job sends every closed hour's pointers for every graph id the write path accepts, so the job does not halt on a valid event | ✓ VERIFIED for NUL; ⚠️ lone surrogate is a WARNING (W-L1) | NUL: refused at write (`event.ts:230`) and before any send (`anchor.ts:556`, pre-send `:958-967`, adopt `:902` caught). Tests `event.test.ts:309-311`, `anchor.test.ts:1519` pass. Lone surrogate: accepted at write and by the pre-send check, altered in argv (probe). The store path replaces it before storage, so the stored id is well-formed (inference from the transport, see W-L1). |
| T5 | N1/W2: the hour is sent, then pointers, then the row; a pointer failure stores no row; an unanchored mismatch stores no row | ✓ VERIFIED | Whole-file pass of `anchor.test.ts`. Order `:1343`, pointer failure `:1363`, alarm `:473`, `:495`, `:518`. Code: alarm no row `anchor.ts:868-875`, adopt heads mismatch no row `:886-896`, pointers after read-back then row last `:1044-1056`. |
| T6 | N2: the adoption window covers the lookback's newer transactions | ✓ VERIFIED | Whole-file pass; regression `anchor.test.ts:1404`. Code `anchor.ts:850`, `:315` ((1 + g) x 168), `greptime.ts:1900-1905`. Pre-fix failure argued by arithmetic only (not run pre-fix). |
| T7 | N3: verify counts only job-key pointers that succeeded; other entries are ignored; a job-key pointer naming another hour still fails | ✓ VERIFIED (verify side) | Pass in this pass: `service.test.ts:5877`, `:5889`, `:5898`, `:5907`, `:5916`, `:5926`. Code `service.ts:875-893`, `:887-888`. Anchor side (`anchor.ts:633`, `:643`) still has no test (W-N3c). |
| T8 | Refused `SOLANA_RPC_URL`: no chain read, `ok` false, `trusted` false, a named reason | ✓ VERIFIED | Pass in this pass: `service.test.ts:4283`. Code `service.ts:8020-8025` (guard before `hourReport`), `config.ts:906-910`. |

**Score:** 8/8 truths verified (T2 counted as PASSED override). Presence-only truths: none. Behavior unverified: 0.

### B2 judged: closed

- **Write.** `normalizeGraphId` (event.ts:227-235) refuses a stored form containing a NUL byte with `GraphIdNulError` (class at :215, message `graph_id_nul:`). The only INSERT into `agent_events` in `packages/mcp-server/src` and `packages/ledger/src` is `GreptimeStore.insertEvent` (greptime.ts:1248, SQL at :1282). Its callers take events built by `normalizeEvent` (service.ts:3123, then `insertEvent` at :3155). The one exception is the buffer replay at service.ts:3214, which re-inserts durable buffer entries without re-normalizing (see W-B2b).
- **Before any send.** `pointerPlans` refuses a NUL id (anchor.ts:556). The pre-send check (`anchor.ts:958-967`) runs it with the 88-character placeholder before the hour transaction, so the hour stops with `send-failed`, no transaction and no row. The adopt path calls `completePointers` at `anchor.ts:902`, which reaches `pointerPlans` at `:623` inside the try, so a NUL there is caught as `send-failed` and sends nothing. `sendPointer` is the only argv carrier of the memo, and it runs only on plans that passed `pointerPlans`. `graphIndexAddress` is a SHA-256 of the id (graph-index.ts:14-17) and passes nothing through argv.
- **Tests.** `event.test.ts:309-311` (throws `GraphIdNulError`, message `graph_id_nul:`); `:314` (a newline is accepted); `anchor.test.ts:1519` (NUL in stored rows: `calls` [], `txs` [], `log` [], `inserts` [], reason `send-failed`). All pass in this pass.
- **Mechanism confirmed.** `execFile` with a NUL argument throws `ERR_INVALID_ARG_VALUE` (ad hoc probe), which is the B2 stranding path. The guard now stops it before the hour is sent.
- **Not closed by this fix.** A lone surrogate (W-L1). Stored NUL or over-512 rows and pre-fix buffer entries (stored-id item, open).

### Round-4 judgments carried (regression by named test)

- **B1 byte cap:** closed. `normalizeGraphId` and `formatMemoV3` refuse over 512 UTF-8 bytes; `memo.test.ts:150-241`, `event.test.ts:277-300` pass. The 251-byte overhead is still hand-counted (`memo.test.ts:231-241`), and the on-chain size is unobserved (operator item 2).
- **N1/W2:** closed. Pre-send refusal `anchor.ts:958-967`; alarm and adopt paths store no row (`anchor.ts:868-875`, `:886-896`). Whole-file pass.
- **N2:** closed. `anchor.test.ts:1404` passes; `anchor.ts:850`, `:315`; `greptime.ts:1900-1905`.
- **N3:** closed on the verify side. `service.test.ts:5877-5926` pass. The anchor side is still untested (W-N3c).
- **RPC guard:** closed. `service.test.ts:4283` passes; `service.ts:8020-8025`.
- **G1 cases:** 1a, 1b, single hour with pointer, leaves-kept and listed-index variants pass. Q8 (`:5843`) pins `ok` true and stays open. N5 stays open.

## Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/ledger/src/memo.ts` | v3 format, byte-capped id, tail-anchored parse | ✓ VERIFIED (defence-in-depth gap noted) | `:82` cap, `:96-103` format, `:106-122` parse. `formatMemoV3` and `parseMemoV3` still accept a NUL or a lone surrogate. Their only production caller is `pointerPlans` (`anchor.ts:561`), so the upstream refusals govern every send. |
| `packages/mcp-server/src/event.ts` | Write-time byte cap and NUL refusal | ✓ VERIFIED for NUL; ⚠️ lone surrogate not refused | `GraphIdNulError` `:215`, NUL check `:230`, byte cap `:231-233`. A lone surrogate passes (W-L1). |
| `packages/mcp-server/src/anchor.ts` | Pre-send plan, NUL refusal, adopt, alarm, pointers, window | ✓ VERIFIED | `pointerPlans` `:553-562` (NUL `:556`); pre-send `:958-967`; `sendPointer` `:570-606`; `completePointers` `:612-650`; adopt call `:902`; alarm `:868-896`; window `:315`, `:850`. |
| `packages/mcp-server/src/service.ts` | Pointer judgement, RPC guard | ✓ VERIFIED | `:875-893`, `:903-960`, `:8020-8025`. Unchanged since 97defd59. |
| `packages/mcp-server/src/greptime.ts` | `lookbackGraphCount`, sole `agent_events` writer | ✓ VERIFIED | `:1900-1905`; `insertEvent` `:1248`, INSERT `:1282`. Unchanged since 97defd59. |
| `docs/greptime-ledger.md` | Memo v3 section | ⚠️ PARTIAL | `:577-592` covers pointers, job-key rule, cap, pre-index, alarm. It does not state the NUL refusal (W-DOC). `f86388cf` edits the buffer section (`:977`) only, outside this phase. |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `normalizeEvent` | `normalizeGraphId` | `graph_id` at event.ts:330 | ✓ WIRED | NUL refused at write (`:230`). |
| `normalizeGraphId` | `formatMemoV3` | stored id carried whole in the pointer | ⚠️ PARTIAL | Byte cap and NUL linked upstream; `formatMemoV3` itself accepts a NUL (defence in depth). Lone surrogate not linked (W-L1). |
| `pointerPlans` | hour transaction | refusal before any send | ✓ WIRED | NUL `:556`, length and format; pre-send `:958-967`. |
| adopt path | `pointerPlans` | `completePointers` `:902` → `:623` | ✓ WIRED | Inside the try; a refusal is caught as `send-failed`. |
| hour transaction read-back | `sendPointer` per graph | after read-back, before the row | ✓ WIRED | `anchor.ts:1044-1056`. |
| `checkAdopt` window | `lookbackGraphCount` | `(1 + g) x 168` | ✓ WIRED | `anchor.ts:315`, `:850`. |
| `judgePointer` candidacy | `readPointerChecks` | ignored entries neither verified nor failed | ✓ WIRED | `service.ts:887-888`. |
| `verifyGraph` guard | `hourReport` | refused RPC returns before any read | ✓ WIRED | `service.ts:8020-8025`. |
| SQL transport (`insertEvent`) | stored `graph_id` | form-urlencoded body via `URLSearchParams` (greptime.ts:838-892) | ⚠️ INFERENCE | A lone surrogate is serialised as U+FFFD (probe). The stored value is therefore well-formed. Not observed in a live store. |

## Data-Flow Trace (Level 4)

Chain and pointer data come from the store (`readEvents`, `hourLeaves`, `graphChainLeafHours`) and from RPC (`addressSignaturePage`, `transactionMemo`). Real queries, not static returns: ✓ FLOWING. The pointer memo's graph id comes from the store read (`readHourHeads` → `eventsByIds`), so a stored NUL is refused by `pointerPlans` before any send (test `anchor.test.ts:1519`).

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Memo, event and anchor targeted run | `bun test` on memo.test.ts, event.test.ts, anchor.test.ts | 143 pass, 0 fail | ✓ PASS |
| Service named subset (v3 pointers, criterion 1, G1 rows-removed, devnet guard, no events) | `bun test service.test.ts -t "..."` | 32 pass, 0 fail | ✓ PASS |
| NUL id refused at write, by name | `event.test.ts:309-311` (in run 1) | pass | ✓ PASS |
| NUL id refused before any send, nothing sent or stored | `anchor.test.ts:1519` (in run 1) | pass; calls, txs, log, inserts all empty | ✓ PASS |
| Lone surrogate refused at write | ad hoc `normalizeGraphId("g\uD800x")` | returns `"g\ud800x"` (not refused) | ✗ FAIL (W-L1) |
| Lone surrogate through the real `pointerPlans` | ad hoc `pointerPlans` with a head record | accepted; memo keeps the surrogate | ✗ FAIL (W-L1) |
| Lone surrogate through argv | ad hoc `execFileSync(node, [..., memo])` | round trip returns `"g�x"`; not equal | ✗ FAIL (W-L1, the memo would mismatch on read-back) |
| Lone surrogate through the SQL transport | ad hoc `new URLSearchParams({sql: "g\uD800x"}).toString()` | `sql=g%EF%BF%BDx` (replaced before the store) | ✓ PASS (stored value well-formed; inference only for the store's own storage) |
| NUL argv mechanism | ad hoc `execFileSync` with a NUL argument | throws `ERR_INVALID_ARG_VALUE` | ✓ CONFIRMED (the B2 mechanism; now refused before the send) |

## Probe Execution

No probe scripts declared or present for this phase. Not applicable.

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-S3 | 73-01 | Chain canonical checksums; on-demand and scheduled verification detect modified, deleted, gapped or reordered entries and report the first bad position; name the trusted earlier proof | ? NEEDS HUMAN (open) | On-demand verify is present (`service.ts` verifyGraph; criterion 1 named tests pass). Scheduled verification was not re-judged in this pass; the record's open question stands (`REQUIREMENTS.md:114`; `:135` "Preliminary edits validated; not complete"). The trusted earlier proof is named: the anchored on-chain head (T2 override). |

Orphaned requirements: none. `REQUIREMENTS.md:135` is the only row mapped to phase 73.

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/event.ts` | 227-235 | Lone surrogate accepted at write | ⚠️ Warning | W-L1 |
| `packages/ledger/src/memo.ts` | 96-122 | `formatMemoV3` and `parseMemoV3` accept a NUL or a lone surrogate | ⚠️ Warning | Guards are upstream only (defence in depth) |
| `packages/mcp-server/src/anchor.test.ts` | 1494-1530 | NUL test uses stored-row fixtures; no lone-surrogate test | ⚠️ Warning | Tests W-L1 once added |
| `packages/ledger/src/memo.test.ts` | 231-241 | Transaction overhead hand-counted, not measured from `transferArgv` | ⚠️ Warning | B1 model unverified against the CLI's actual layout (operator item 2) |
| `packages/mcp-server/src/anchor.ts` | 633-643 | Anchor-side payer and err skip in `completePointers` untested | ⚠️ Warning | W-N3c |
| `docs/greptime-ledger.md` | 577-592 | v3 section does not state the NUL refusal | ⚠️ Warning | W-DOC |

No 🛑 blockers. Debt markers: none.

## Warnings and new findings (not gaps)

- **W-L1 (new). Lone surrogate in a graph id.** The write path (`normalizeGraphId`) and `pointerPlans` accept a lone UTF-16 surrogate. Argv replaces it (`"g�x"`), so the memo read back from chain would not match the plan. The store path does not reach that: `URLSearchParams` replaces the surrogate with U+FFFD before the SQL leaves the process, so the stored id is well-formed and the pointer path reads a valid id. **No stranding is found on the stored path** [INFERENCE: transport and code reading, not a live store]. The event hash, though, is computed over the surrogate form (`eventHash` over `canonicalJson` of the unhashed event, event.ts:36-37). The stored row therefore recomputes to a different hash, and `verifyGraph` would fail that graph (fail closed, a false alarm). No bypass. Remedy for the owner's decision: refuse a non-well-formed id at write, as NUL is refused, with a named error and a test beside `event.test.ts:309`. Warning; does not block the goal as stated.
- **W-DOC (new). The v3 section of `docs/greptime-ledger.md` (`:577-592`) does not mention the NUL refusal.** The workflow requires docs for a permanent fix. Warning; the doc should state the NUL refusal next to the byte cap.
- **W-B2b (new, stored state). Buffer replay skips normalisation.** `service.ts:3214` re-inserts durable buffer entries through `insertEvent` without `normalizeEvent`, so a pre-fix entry with a NUL or over-512-byte id reaches the store unchecked, and then the pre-send check stops the hour. The buffer is off by default. Part of the stored-id open item.
- **W-N3b (carried).** Third-party grief at a graph's index address. Verify fails closed (budget exhausted, `service.ts:937`). Open.
- **W-N3c (carried).** The anchor-side N3 skip (`anchor.ts:633`, `:643`) has no test.
- **W-N4 (carried; owner decided fail closed).** Verify needs devnet even with no anchored hour (`service.ts:912-916`). Decided; no change in this pass.
- **W-N6 (carried).** `POINTER_REFUSED_RE` (`anchor.ts:85`) matches any "transaction simulation failed". The refusal text is unobserved (operator item 1).
- **W-N7 (carried, partial).** `73-MEMO-V3-DESIGN.md` does not carry the deviations listed in the 9ab6f111 commit message (100-page listing cap, the 88-character signature bound, `addressSignaturePage`, the adopt head check). Open.
- **W-N8 (carried).** Budget not measured for a year-old graph (`config.ts:1207`). Operator item 5.
- **Read-side cut (carried).** `normalizeIdentifier` still cuts a longer id to 512 units on reads (`event.ts:198-200`), so a read of an over-long stored id can match another graph. Open.
- **Stored over-512-byte or NUL graph ids (carried; no data repair decided).** A live anchor run against a store holding such rows halts at the first such hour (pre-send `anchor.ts:958-967`; adopt `:902`), and every later hour waits. Operator check, not run: `SELECT count(*) FROM agent_events WHERE octet_length(graph_id) > 512`, and a scan for NUL in `graph_id`. A stored U+FFFD cannot be attributed to a lone-surrogate write.

## Human Verification Required

Operator items (not run by this verifier; they need devnet, a funded key or a live store):

1. **Devnet 0-lamport pointer probe**
   **Test:** Send a 0-lamport pointer to an unfunded index address; record the refusal text.
   **Expected:** Decides `POINTER_REFUSED_RE` and whether the funded path is needed.
   **Why human:** Devnet and a live send.
2. **Live devnet send of a 512-byte-id pointer**
   **Test:** Send one such pointer and read it back.
   **Expected:** Serialised size within the 1,232-byte limit; measured size replaces the 251-byte model.
   **Why human:** Live send.
3. **Live store scan**
   **Test:** Count `graph_id` over 512 bytes; find any `graph_id` containing NUL; find v2 memos in the anchor listings.
   **Expected:** Zero rows, or an owner decision on each.
   **Why human:** Live store access.
4. **RPC history depth (N5)**
   **Test:** Find the oldest signature still listed for a job-key address and an index address.
   **Expected:** The depth is known. The owner decides whether a pruned pointer for an old hour is acceptable.
   **Why human:** Live RPC; a policy call.
5. **Budget measurement (W-N8)**
   **Test:** Time `verifyGraph` for a year-old graph under the 30 s default.
   **Expected:** A measured time.
   **Why human:** Live data at realistic size.

Owner decisions:

6. **Q8: a graph whose only hour lost its pointer and rows**
   **Test:** Decide whether it may verify `ok` true, `trusted` false, "no events" (`service.test.ts:5843`).
   **Expected:** Accept as a named residual, or change to fail closed.
   **Why human:** Not ratified; the test pins current behaviour.
7. **Stored graph ids over 512 bytes or containing NUL**
   **Test:** Decide the repair (none decided).
   **Expected:** A recorded decision.
   **Why human:** Data-repair policy.
8. **W-L1: a non-well-formed graph id at write**
   **Test:** Decide whether to refuse it as NUL is refused (62a25181).
   **Expected:** A recorded decision; if refused, a named error and a test beside `event.test.ts:309`.
   **Why human:** Extends the owner's B1/B2 remedy to a new class.
9. **HARD-S3 scheduled verification**
   **Test:** Decide whether scheduled verification is in this phase or a later one, and name its trusted earlier proof.
   **Expected:** A decision recorded against `REQUIREMENTS.md:114` and `:135`.
   **Why human:** Scope decision.

## Open items (named, kept open)

Owner decisions and residuals, as named in the assignment. None is decided here.

- **Phase 73 N5.** RPC history retention for index addresses. A pruned listing removes a pointer, so the removed hour passes. Bounds T3 for hours older than the depth. Blocks full G1 closure for old hours. Operator item 4 and owner decision.
- **Phase 73 Q8.** A graph whose only hour lacks a landed pointer, with its rows removed, verifies `ok` true, `trusted` false, "no events" (`service.test.ts:5843`). The owner has not ratified Q8. Before B2 closed, this compounded with stranding; B2 no longer strands new writes.
- **Phase 73 W3.** Boot DDL `CREATE TABLE IF NOT EXISTS "graph_chain_leaves"` runs at every boot (`greptime.ts:1024`); append-mode check incomplete. Unchanged.
- **Phase 73 W4.** No verdict-level payload test. Unchanged.
- **Phase 73 W5.** The evidence bundle attests the app chain from the chain verdict only (`observe.ts:1050` `appChainOf`). Unchanged.
- **Phase 73 HARD-S3.** The scheduled-verification question. Open (operator item 9).
- **Phase 73 N4.** Verify needs devnet even with no anchored hour. Owner decided fail closed. Named behaviour, no code change.
- **Phase 73 N6.** `POINTER_REFUSED_RE` on any "transaction simulation failed". Operator item 1.
- **Phase 73 N8.** Budget not measured. Operator item 5.
- **Stored over-512-byte or NUL graph ids.** No migration or repair decided. Blocks a live anchor run against any store that holds such rows. Operator item 3; owner item 7.
- **Live devnet probe.** Operator items 1 and 2.
- **Live store scan for v2 memos.** Operator item 3.
- **W-L1 (new).** Lone surrogate. Owner item 8.
- **Read-side cut, W-N3b, W-N3c, W-N7, W-B2b, W-DOC (new).** Warnings above.
- **Phase 72, 75, 76, 77, 78 items.** Not re-judged here. `f86388cf`'s cache-off sentence is phase 76's buffer section, not phase 73's.

## Does any open item block the phase goal?

- **B2 no longer blocks the goal.** Its named tests pass and the mechanism is refused at write and before any send.
- **No open item breaks the mechanism the goal names.** The chain recomputation (T1), the hour-head anchoring (T2 override), the pointer detection (T3, T7), the pre-send and no-row discipline (T5, T6, T8) and B1 all pass their named tests.
- **Two open items bound the detection claim and must be decided before the phase is called complete.** N5 means a pruned pointer for an old hour passes, so "an anchored hour removed fails the verdict" holds only for hours whose pointer the RPC still lists. Q8 means a graph whose only hour has no landed pointer verifies `ok` true. These are detection misses, not implementation faults. They are the owner's to accept or fix, and they keep the status at `human_needed`, not `passed`.
- **The stored-id item blocks live anchoring, not the verification code.** Any store already holding a stored over-512-byte or NUL graph id halts the hourly job at that hour, so the anchored-head half of the goal cannot proceed on that store until decided and cleared (operator item 3, owner item 7).
- **W-L1 is a warning.** It does not block the goal: the stored path is well-formed, and the only effect is a fail-closed false verify for a graph written with a lone surrogate. Owner item 8 decides it.

## Gaps Summary

No gaps. No truth is FAILED; no artifact is MISSING or STUB; no key link is NOT_WIRED; no blocker anti-pattern remains. B2 is closed on code and named tests. The status is `human_needed` because the human-verification section is non-empty (operator checks and owner decisions), not because of a failed truth.

## Verdict

**Status: human_needed.** Score 8/8 truths verified (T2 by override). Phase 73 is not `passed`: the owner decisions and operator checks listed above are open, and N5 and Q8 bound the detection claim until decided.

## Self-check

The written status is read back with `gsd-tools query verification.status .planning/phases/73-ledger-tamper-evidence --pick status` from the worktree after this file was written; the printed value is recorded in the final report.

Working-tree note: the worktree has uncommitted edits to other phases' `*-VERIFICATION.md` files. They are not mine and were not touched.

_Verified: 2026-11-03T11:27:35Z_
_Verifier: Claude (gsd-verifier)_
