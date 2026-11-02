---
phase: 73-ledger-tamper-evidence
verified: 2026-11-02T15:59:31Z
status: human_needed
score: 2/2 must-haves verified
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", "packages/cli/src/evidence.test.ts", "packages/cli/src/verify.test.ts", "packages/evidence/src/report.ts", "packages/ledger/src/heads.test.ts", "packages/ledger/src/heads.ts", "packages/ledger/src/index.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/ledger/src/solana.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/checkpoint-verify.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/evidence-anchor.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:6d416fe34ba9185738fb5999e6961abd24958ca2dbf6028be1b35aec205921d4"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof criterion 1 compares against; a head recomputed from the stored rows is never used as the proof."
    reason: "Owner accepted the commitment reading on 2026-11-02: each graph head is committed on chain by the memo v2 heads_root and recovered only through stored leaves that reproduce it (memo.ts:11-12, heads.ts:59-72, anchor.ts:473-476). Owner also confirmed memo v2 is in v1.8 scope (REQUIREMENTS.md line 85). Carried forward unchanged from the prior record; see Override provenance below."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_verified: 2026-11-02T02:44:08Z
  previous_scope: "branch gsd/v18-p73-ledger-tamper, worktree /root/src/worktrees/as-gsd-v18-p73"
  scope: "integration tree gsd/v18-int-all, HEAD 7382ad10"
  reason: "Re-verified on the integration tree. The prior record was written on the phase branch and is overwritten. Criteria source is origin/main ROADMAP Phase 73."
human_verification:
  - test: "Send one live devnet v2 memo for a closed hour through the anchor job, read it back from the chain, and compare its heads_root with the value recomputed from the stored graph_chain_leaves rows. Then run substrate verify on that graph."
    expected: "Read-back matches the recomputed heads root, and the verdict reports trusted: true for that hour."
    why_human: "A devnet send is operator-gated (D73-05) and cannot be run from the repository."
  - test: "Exercise the anchor adoption path on a live hour whose v2 memo is already on chain (for example after a lost anchors-row write). Then check whether graph_chain_leaves matches the on-chain heads_root."
    expected: "Adoption writes leaves without comparing heads_root (anchor.ts:693). Expected result: the mismatch is caught only at verify time, as 'the stored leaves do not reproduce the on-chain heads root'. Confirms Gaps Summary W2."
    why_human: "Live adoption depends on devnet and store state."
  - test: "On first boot of the live service, check that graph_chain_leaves is created with append_mode = true, and decide whether boot-time DDL is acceptable under D73-05."
    expected: "The table exists in append_mode, and boot output has no 'graph_chain_leaves not created in append_mode' warning. The D73-05 wording is either amended or the DDL moves out of boot."
    why_human: "Production DDL on the live GreptimeDB is operator-gated. The mismatch is a decision. See Gaps Summary W3."
  - test: "Run substrate verify <graph_id> against a real graph with one v2-anchored hour and one v1-anchored hour."
    expected: "The v2 hour reports trusted: true. The v1 hour reports trusted: false with reason 'anchored with a v1 memo: no heads commitment on chain'. Overall ok is true for both."
    why_human: "Needs the live GreptimeDB and devnet."
---

# Phase 73: Ledger tamper evidence Verification Report

**Phase Goal:** A rewrite, reorder, deletion or tail truncation of the event ledger is detected by recomputing the chain from the stored rows, and the verified head is anchored.
**Criteria source:** `origin/main` `.planning/ROADMAP.md`, section "### Phase 73: Ledger tamper evidence" (read with `git show origin/main:.planning/ROADMAP.md`). Phase 73 is present there, so this tree's ROADMAP was not used.
**Tree:** `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `7382ad10`.
**Verified:** 2026-11-02T15:59:31Z
**Status:** human_needed

## Verdict summary

- Must-haves: 2 of 2 verified. Criterion 1 VERIFIED. Criterion 2 PASSED (override).
- Failed: 0. Present but behavior unverified: 0.
- Blocking gaps: none.
- Human items: 4, all operator-gated live proofs (devnet send, adoption on live state, production DDL on boot, live `substrate verify`).
- Open decisions: 2 (D73-05 boot DDL wording, Gaps W3; the adoption check, Gaps W2). Both stay open.
- Warnings: W4 (criterion 1 payload edit tested only through `summary`). Non-blocking.

## Integration facts judged on this tree

- **Steering layer (phase 71 design):** Phase 73 does not use live sessions, historical labels or metadata discovery. Its code is `event.ts`, `anchor.ts`, `greptime.ts`, `memo.ts`, `heads.ts` and `service.ts` `verifyGraph`/`trustHour`. None touches the live-session facade.
- **Commit 634b6171 (lazy live-session facade, `service.ts` constructor and `liveSessions` getter):** does not touch `verifyGraph`, `trustHour` or `checkHourWithBudget`. The 23 heads-trust tests pass on this tree, so the lazy facade does not break phase 73 behaviour.
- **Commit 634b6171 (settle in `live-session-consumer.test-support.ts`):** not used by any phase 73 test. Not a factor here.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | Criterion 1. Save the graph's head before the change, then edit a stored event, delete a middle event, truncate the last events, and rewrite the whole chain with recalculated `hash` and `prev`. Each is compared with that saved head. Edits and the rewrite report the first differing event id; truncation and deletion report the first missing event id. | ✓ VERIFIED (with W4) | The saved head is the on-chain v2 `heads_root` plus the stored `graph_chain_leaves`. `trustHour` reads `report.heads_root` from the memo (`service.ts:8262-8273`), requires stored leaves to reproduce it (`service.ts:8294-8295`), then calls `compareToAnchoredHead` per (graph, session) pair (`service.ts:8323`). Inside that: stored leaves must reproduce the head (`event.ts:440-447`); a leaf with no event gives `first-missing` (`event.ts:456`); a recomputed or stored hash that differs gives `first-differing` (`event.ts:457`). The recomputed hash is `eventHash(content)` over every row field including payload (`service.ts:8310-8313`). Tests, all passing on this tree: edit `service.test.ts:5261` (first_differing at event 2); deletion `:5273` (first_missing); truncation `:5289` (first_missing at the first gone event); full rewrite `:5302` (first_differing at event 1, `chain.ok` true); two sessions and read order `:5323`. |
| 2   | Criterion 2. The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof that criterion 1 compares against. A head recomputed from stored rows is never the proof. | ✓ PASSED (override) | Override carried from the prior record (see Override provenance). The literal reading is not met: the anchor carries one hour-wide `heads_root` over all (graph, session) records (`memo.ts:12`, `anchor.ts:473-476`, `heads.ts:59-72`). Per-graph heads are in `graph_chain_leaves`, not in the anchor row. The recorded heads are trusted only through the on-chain `heads_root`: a head recomputed from rows is never used as proof (`service.ts:8294-8295`, `8262`, `8273`). |

**Score:** 2/2 must-haves verified (1 VERIFIED, 1 PASSED override; 0 failed; 0 present-but-behavior-unverified).

**Criterion 2 reading applied.** The commitment reading, as the owner accepted it. The literal reading is not met and is not narrowed here. If the owner rejects the commitment reading, remove the override and criterion 2 becomes FAILED.

## Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/ledger/src/heads.ts` | Head records, `headRecordHash`, `headsRoot` | ✓ VERIFIED | `headRecordHash` `heads.ts:25`, `headsRoot` `heads.ts:59-72`. Used by `anchor.ts` and `service.ts`. |
| `packages/ledger/src/memo.ts` | v2 memo format and parser | ✓ VERIFIED | `MEMO_V2_RE` `memo.ts:12`, `formatMemoV2` `memo.ts:42-46`, `parseMemo` accepts v1 and v2 `memo.ts:61-69`. |
| `packages/mcp-server/src/event.ts` | `chainLeafCommitment`, `orderedLeaves`, `headRecordsFromLeaves`, `compareToAnchoredHead` | ✓ VERIFIED | `event.ts:369`, `378`, `395`, `435-467`. `verifyChain` unchanged at `event.ts:469`. |
| `packages/mcp-server/src/anchor.ts` | Head builder, leaves writer, v2 send path | ✓ VERIFIED (with W2) | `readHourHeads` `anchor.ts:455`, `anchorMemo` `anchor.ts:473-476`, `storeAnchor` `anchor.ts:479-482`, send-path read-back on `headsRootHex` `anchor.ts:811`. Adoption path gap in W2 (`anchor.ts:693`). |
| `packages/mcp-server/src/greptime.ts` | `graph_chain_leaves` DDL, writer, reader | ✓ VERIFIED (with W3) | DDL in `migrate` `greptime.ts:1024`. Writer `insertGraphChainLeaves` `greptime.ts:1826`. Reader `hourChainLeaves` `greptime.ts:1843`. |
| `packages/mcp-server/src/service.ts` | `verifyGraph` trust and verdict | ✓ VERIFIED | `verifyGraph` `service.ts:7805`; trust gate calls `trustHour` `service.ts:8203`; `trustHour` `service.ts:8251-8340`. |
| `docs/greptime-ledger.md` | Memo v2 and trust rule documented | ✓ VERIFIED | Documentation, checked only for presence. |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| anchor send path | `greptime.insertGraphChainLeaves` | `storeAnchor` before `insertAnchor` | ✓ WIRED | `anchor.ts:479-482`, `greptime.ts:1826`. |
| anchor send path | memo v2 with the heads root | `anchorMemo(...)` at `anchor.ts:758`, then read-back check `anchor.ts:811` | ✓ WIRED | |
| anchor adoption path | on-chain `heads_root` check | `checkAdopt` compares root and count only (`anchor.ts:324`), then `storeAnchor(readHourHeads(...))` (`anchor.ts:693`) | ⚠️ PARTIAL | The heads-root guard is absent. Verification still fails closed (W2). |
| `verifyGraph` | per-hour trust | `trustHour` after `checkHourWithBudget` | ✓ WIRED | `service.ts:8203`. |
| `trustHour` | stored leaves | `greptime.hourChainLeaves` | ✓ WIRED | `service.ts:8278`, `greptime.ts:1843`. |
| `trustHour` | on-chain root gate | `headsRoot(records) !== onChainHeadsRoot` | ✓ WIRED | `service.ts:8295`. |
| `trustHour` | per-pair comparison | `compareToAnchoredHead` | ✓ WIRED | `service.ts:8323`, `event.ts:435`. |
| `heads_root` source | devnet memo only | `report.heads_root` from the parsed transaction memo | ✓ WIRED | `service.ts:8262-8273` (trust gate reads only `report.heads_root`). |
| Boot | `graph_chain_leaves` DDL | `index.ts:121` `substrate.migrate()` → `service.ts:2243` `greptime.migrate()` → DDL `greptime.ts:1024` | ✓ WIRED (but see W3) | Boot runs the DDL on every start. |

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `trustHour` (`service.ts:8291`) | `leaves` | `greptime.hourChainLeaves`, SQL SELECT over `graph_chain_leaves` (`greptime.ts:1843`) | Yes | ✓ FLOWING |
| `trustHour` (`service.ts:8300-8313`) | `links` | Event rows from `readEvents`, rehashed with `eventHash` | Yes | ✓ FLOWING |
| `anchorMemo` (`anchor.ts:473-476`) | `headsRootHex` | `readHourHeads` over `eventsByIds` rows (`anchor.ts:455-467`) | Yes | ✓ FLOWING |

## Behavioral Spot-Checks (targeted, this tree)

Run under bwrap with `/etc/substrate` masked, `TMPDIR=/root/src/worktrees/backups/gate-tmpfs`, `HOME=$TMPDIR/home-p73`, `env -i`, no `SUBSTRATE_TEST_PG_URL`, no Postgres. Three `bun` commands in total, serial.

| # | Command | Result | Status |
| - | ------- | ------ | ------ |
| 1 | `bun --no-env-file test packages/mcp-server/src/service.test.ts -t "heads trust"` | 23 pass, 0 fail, 72 expect calls. Covers truths 1 and 2 at verdict level. | ✓ PASS |
| 2 | `bun --no-env-file test packages/ledger/src/heads.test.ts packages/ledger/src/memo.test.ts packages/mcp-server/src/event.test.ts` | 76 pass, 0 fail, 188 expect calls. | ✓ PASS |
| 3 | `bun --no-env-file test packages/mcp-server/src/anchor.test.ts -t "heads\|leaves\|v2 memo\|same root and count adopts\|re-run over an anchored hour\|same cluster\|another cluster"` | 13 pass, 0 fail, 41 expect calls. Covers anchor heads, v2 send, leaves-write failure and empty hour. | ✓ PASS |

The full suite was not run and was not re-run. The orchestrator's gate on this tree (`/root/src/worktrees/backups/gates-int-r5.log`) was taken as given. The adoption path (W2) and boot DDL (W3) have no test on this tree that exercises the live behaviour.

## Probe Execution

Not applicable. The phase is not a migration or tooling phase, its success criteria do not mention probes, and the PLAN and SUMMARY declare none.

## Requirements Coverage

The PLAN has no `requirements:` field. `.planning/REQUIREMENTS.md` has no rows for phase 73. Nothing mapped, nothing orphaned. The cross-milestone note (REQUIREMENTS.md:85, "a new on-chain memo format") is resolved by the owner's confirmation that memo v2 is in v1.8 scope.

## Anti-Patterns Found

Debt-marker gate (TBD, FIXME, XXX) over the changed code files: no matches in the files read. TODO, HACK and PLACEHOLDER: no matches in the changed code files read.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/anchor.ts` | 693 (`checkAdopt` 324) | Adoption writes leaves without the heads-root check | ⚠️ Warning | W2. Verification still fails closed. |
| `packages/mcp-server/src/greptime.ts` | 1024 | Leaves DDL runs on every boot via `migrate`, contrary to D73-05 wording | ⚠️ Warning | W3. Open decision. |
| `packages/mcp-server/src/service.test.ts` | 5261, 5374 | Tests named "edited payload" change `summary`, not `payload` | ⚠️ Warning | W4. |

## Gaps Summary

**Blocking gaps: none.** No must-have is FAILED. No artifact is missing or a stub. No key link is NOT_WIRED.

**W1. Criterion 2 is met only under the commitment reading, owner-accepted (PASSED override).** See the override and the criterion 2 row. This is the one decision the phase rests on. It is closed by the owner's recorded acceptance, not by this verifier.

**W2. Adoption path lacks the heads-root guard (Warning, open).** `checkAdopt` compares only root and count (`anchor.ts:324`). The `--period` adopt path then writes `readHourHeads(...)` leaves and the anchors row (`anchor.ts:693`) without checking that `headsRoot(records)` equals the on-chain `heads_root`. A mismatch surfaces only at verify time, through the stored-leaves-mismatch verdict. This is a code gap. It is not fixed here, because this verifier does not edit code.

**W3. Leaves DDL runs on every boot (Warning, open decision).** `greptime.migrate` runs `CREATE TABLE IF NOT EXISTS "graph_chain_leaves" ... WITH ('append_mode' = 'true')` at `greptime.ts:1024` on every start (`index.ts:121`). D73-05 says no production DDL is applied. Open decision: amend D73-05, or move the DDL out of boot. Left open.

**W4. Payload edit is tested only through `summary` (Warning).** Criterion 1 names "edit a stored payload". Both tests named for a payload edit (`service.test.ts:5261`, `:5374`) change `summary`. The code path is the same: the recomputed `eventHash` covers the full row content including payload (`service.ts:8310-8313`). No test changes the `payload` column at verdict level. [INFERENCE] a payload edit takes the same path. Recommended: add a payload-column case to `service.test.ts`. No code change is needed. Criterion 1 stays VERIFIED; the evidence is narrower than the wording.

**I1. "Saved head" is implicit (Info).** The fixture builds the honest memo and leaves before each override, and the override changes only what is read back. There is no separate save step. D73-07 accepts this harness.

**I2. `ok` is true for v1-only anchored hours (Info, by design).** Trust, not `ok`, is the proof gate (D73-04).

**I3. Cross-milestone scope (Info, resolved).** REQUIREMENTS.md:85 excludes "a new on-chain memo format" from the earlier milestone. The owner confirmed memo v2 is in v1.8 scope on 2026-11-02.

**I4. Existing `verifyGraph` callers (Info).** Callers at `mcp.ts:1260`, `observe.ts:952` and `server.ts:1616` see additive fields only. Not tested individually here.

**Residuals (from the PLAN SUMMARY, unchanged):** the leaves table has no primary key, so duplicates collapse on read; a leaves write that fails after a send can lead to a resend on the next run (same exposure `insertAnchor` already has); the leaves read is bounded to the hour but covers every graph in it; events without a `graph_id` have no head and stay in the hour root only.

## Human Verification Required

### 1. Live devnet v2 send

**Test:** Send one v2 memo for a closed hour through the anchor job. Read it back and compare its `heads_root` with the root recomputed from stored `graph_chain_leaves` rows. Run `substrate verify` on that graph.
**Expected:** The read-back matches, and that hour reports `trusted: true`.
**Why human:** Devnet sends are operator-gated (D73-05).

### 2. Live adoption of an already-anchored v2 hour

**Test:** On a live hour whose v2 memo is already on chain, run the adoption path (for example after removing its anchors row). Then compare the stored leaves with the on-chain `heads_root`.
**Expected:** The adoption writes leaves without comparing `heads_root` (`anchor.ts:693`). The mismatch surfaces only at verify time, as "the stored leaves do not reproduce the on-chain heads root".
**Why human:** Depends on live devnet and store state.

### 3. First boot DDL on the live store

**Test:** On first boot of the live service, check that `graph_chain_leaves` exists in append_mode, and that boot output has no `graph_chain_leaves not created in append_mode` warning. Decide whether boot-time DDL is acceptable under D73-05.
**Expected:** The table exists in append_mode. D73-05 is either amended or the DDL moves out of boot.
**Why human:** Production DDL on the live GreptimeDB is operator-gated.

### 4. Live `substrate verify`

**Test:** Run `substrate verify <graph_id>` on a real graph with one v2-anchored hour and one v1-anchored hour.
**Expected:** The v2 hour reports `trusted: true`. The v1 hour reports `trusted: false` with reason "anchored with a v1 memo: no heads commitment on chain". `ok` is true for both.
**Why human:** Needs live GreptimeDB and devnet.

## Open Decisions

| ID | Decision | State |
| -- | -------- | ----- |
| Criterion 2 reading | Commitment reading (one hour-wide `heads_root` commits each graph head) versus the literal reading (a head value per graph in the anchor). | Closed by owner acceptance recorded in the prior record (2026-11-02). Carried as PASSED (override). Not upgraded beyond that. |
| D73-05 boot DDL | Whether `graph_chain_leaves` DDL on every boot is acceptable, or D73-05 is amended, or the DDL moves out of boot. | **Open** (W3, human item 3). |
| Adoption guard | Whether the adoption path should check `heads_root` before writing leaves (W2). | **Open.** Code gap; verification fails closed meanwhile. |

## Override provenance

The override is carried forward from the prior 73-VERIFICATION.md (branch `gsd/v18-p73-ledger-tamper`), which records `accepted_by: owner`, `accepted_at: 2026-11-02`. That acceptance is not found anywhere else in the repo that I searched (`.planning/*.md`, phase directories). This verifier relied on the recorded acceptance and did not re-obtain it. If the owner's acceptance does not stand, remove the override and criterion 2 becomes FAILED.

---

_Verified: 2026-11-02T15:59:31Z_
_Verifier: Claude (gsd-verifier)_
