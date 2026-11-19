---
phase: 73-ledger-tamper-evidence
verified: 2026-11-02T02:44:08Z
status: human_needed
score: 2/2 must-haves verified
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", "packages/cli/src/evidence.test.ts", "packages/cli/src/verify.test.ts", "packages/evidence/src/report.ts", "packages/ledger/src/heads.test.ts", "packages/ledger/src/heads.ts", "packages/ledger/src/index.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/ledger/src/solana.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/checkpoint-verify.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/evidence-anchor.test.ts", "packages/mcp-server/src/graph-bind.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/mcp.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/reanchor-plan.test.ts", "packages/mcp-server/src/reanchor-plan.ts", "packages/mcp-server/src/reanchor-run.test.ts", "packages/mcp-server/src/reanchor.test.ts", "packages/mcp-server/src/reanchor.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/teachable-anchor.test.ts"]
covered_digest: "v3:sha256:3c755d478b2eb6278591b0539c5d1d4db771bce4fe79f509dbde0549a1002ac6"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof criterion 1 compares against; a head recomputed from the stored rows is never used as the proof."
    reason: "Owner accepted the commitment reading on 2026-11-02: each graph head is committed on chain by the memo v2 heads_root and recovered only through stored leaves that reproduce it (memo.ts 11 to 12, heads.ts 59 to 72, anchor.ts 473 to 476). Owner also confirmed memo v2 is in v1.8 scope (REQUIREMENTS.md line 85)."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
human_verification:
  - test: "Send one live devnet v2 memo for a closed hour through the anchor job, read it back from the chain, and compare its heads_root with the value recomputed from the stored graph_chain_leaves rows. Then run substrate verify on that graph."
    expected: "Read-back matches the recomputed heads root, and the verdict reports trusted: true for that hour."
    why_human: "A devnet send is operator-gated (D73-05) and cannot be run from the repository."
  - test: "Exercise the anchor adoption path on a live hour whose v2 memo is already on chain (for example after a lost anchors-row write). Then check whether graph_chain_leaves matches the on-chain heads_root."
    expected: "Adoption writes leaves without comparing heads_root (anchor.ts:688-698). Expected result: the mismatch is caught only at verify time, as 'stored leaves do not reproduce the on-chain heads root'. Confirms Gaps Summary W2."
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
**Verified:** 2026-11-02T02:44:08Z
**Status:** human_needed
**Re-verification:** No. Initial mode. The earlier 73-VERIFICATION.md had no `gaps:` section and was not a prior verification under Step 0. It is overwritten.

**Scope:** Branch `gsd/v18-p73-ledger-tamper`, worktree `/root/src/worktrees/as-gsd-v18-p73`, clean at start. Must-haves are the two ROADMAP Phase 73 success criteria, verbatim. The PLAN has no frontmatter `must_haves`, so `verify.artifacts` and `verify.key-links` were not applicable (Steps 4 and 5 traced by hand). The 73-01-SUMMARY was not used as evidence. Procedure references resolved under `/root/.agents/gsd-core/references/`. `~/.claude/gsd-core` is absent here, but the `@` includes were satisfied from the `.agents` tree. Requirements: none mapped to this phase.

**Override applied:** Must-have 2 is carried as `PASSED (override)` by the owner-accepted commitment reading (frontmatter `overrides:`, Step 3b). No other override exists. The must-have text is not narrowed.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | Criterion 1. Save the graph's head, then edits to a stored event, a middle deletion, tail truncation and a full rewrite with recalculated hash and prev each report the first differing event id (edits and rewrite) or the first missing event id (deletion and truncation), compared with that saved head. | ✓ VERIFIED | Comparison is `compareToAnchoredHead` (`packages/mcp-server/src/event.ts:399-427`). It requires the stored leaves to reproduce the anchored head first (`event.ts:402-411`), walks the committed leaves, returns `first-missing` for an absent event (`event.ts:420`) and `first-differing` when the recomputed or stored hash differs from the leaf (`event.ts:421`). `trustHour` gates on the on-chain root (`service.ts:7653-7655`), compares each pair (`service.ts:7682`) and maps the results to `first_differing_event_id` / `first_missing_event_id` (`service.ts:7685-7686`). Each case is a test in `packages/mcp-server/src/service.test.ts`: edit at `:5247`, deletion at `:5259`, truncation at `:5275`, full rewrite at `:5288`. Named test run this pass: "an edited payload parts the chain at that event: first_differing_event_id" → 1 pass, 0 fail, 5 expect calls. See W4: that test edits `summary`, not the `payload` column. |
| 2   | Criterion 2. The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof that criterion 1 compares against. A head recomputed from stored rows is never the proof. | ✓ PASSED (override) | Override: Owner accepted the commitment reading on 2026-11-02: each graph head is committed on chain by the memo v2 heads_root and recovered only through stored leaves that reproduce it (memo.ts 11 to 12, heads.ts 59 to 72, anchor.ts 473 to 476). Owner also confirmed memo v2 is in v1.8 scope (REQUIREMENTS.md line 85) — accepted by owner on 2026-11-02. Cited lines checked: `memo.ts:11-12` defines `MEMO_V2_RE` with `heads_root`; `heads.ts:59-72` is `headsRoot`; `anchor.ts:473-476` is `anchorMemo`, which emits v2 when heads exist. Trust path, for the record: `trustHour` accepts only `report.heads_root` from a signed v2 memo (`service.ts:7625-7630`) and recomputes the root from stored leaves (`service.ts:7653-7654`), so a recomputed head is never trusted (`service.ts:7603-7608`). |

**Score:** 2/2 truths verified (1 VERIFIED, 1 PASSED override; 0 present-but-behavior-unverified)

**Criterion 2 reading applied.** Commitment reading, as the owner accepted it. The literal reading ("a head value for each graph is recorded in the anchor") is not met: the anchors row and memo carry one hour-wide `heads_root`, and heads are per (graph, session) (D73-02). That gap is accepted under the override and is not narrowed here. If the owner later rejects the commitment reading, remove the override and criterion 2 becomes UNCERTAIN/FAILED again.

**Verification of the override's cited lines.** I checked the three references the owner's reason cites. Each does what the reason says. No other claim in the reason was checked.

## Required Artifacts

Step 4 not applicable as a query: `verify.artifacts` has no `must_haves.artifacts` source. Changed code files were checked at Levels 1 to 3 through the key-link table.

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/ledger/src/heads.ts` | Head records and `headsRoot` | ✓ VERIFIED | Substantive: `headRecordHash` (`heads.ts:25-46`), `headsRoot` (`heads.ts:59-72`). Used by `anchor.ts` and `service.ts`. |
| `packages/ledger/src/memo.ts` | v2 memo format and parser | ✓ VERIFIED | `MEMO_V2_RE` (`memo.ts:12`), `formatMemoV2` (`memo.ts:42-46`), `parseMemo` accepts v1 and v2 (`memo.ts:61-68`). |
| `packages/mcp-server/src/event.ts` | `compareToAnchoredHead`, `orderedLeaves`, `headRecordsFromLeaves` | ✓ VERIFIED | `event.ts:342-353`, `359-383`, `399-427`. |
| `packages/mcp-server/src/anchor.ts` | Head builder, leaves writer, v2 send path | ✓ VERIFIED (with W2) | `readHourHeads` (`anchor.ts:455-467`), `anchorMemo` (`anchor.ts:473-476`), `storeAnchor` (`anchor.ts:479-482`), send path read-back check on `headsRootHex` (`anchor.ts:811`). Adoption path has the gap in W2 (`anchor.ts:688-698`). |
| `packages/mcp-server/src/greptime.ts` | `graph_chain_leaves` DDL, writer, readers | ✓ VERIFIED (with W3) | DDL in `migrate` (`greptime.ts:1022-1028`), called from `greptime.ts:967`. Writer `insertGraphChainLeaves` (`greptime.ts:1803-1814`). Reader `hourChainLeaves` (`greptime.ts:1820-1832`). |
| `packages/mcp-server/src/service.ts` | `verifyGraph` trust and verdict | ✓ VERIFIED | `verifyGraph` calls `trustHour` (`service.ts:7560-7563`); `trustHour` at `service.ts:7610-7700`. |
| `docs/greptime-ledger.md` | Memo v2 and trust rule documented | ✓ VERIFIED | Documentation only, not checked line by line. |

## Key Link Verification

Step 5 not applicable as a query: `verify.key-links` has no `must_haves.key_links` source. Links traced by hand.

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| anchor send path | `greptime.insertGraphChainLeaves` | `storeAnchor` before `insertAnchor` | ✓ WIRED | `anchor.ts:479-482`, `greptime.ts:1803`. |
| anchor send path | memo v2 with the heads root | `anchorMemo(...heads)` then read-back check | ✓ WIRED | `anchor.ts:754`, `811`. |
| anchor adoption path | on-chain `heads_root` check | `checkAdopt` compares root and count only (`anchor.ts:324`), then `storeAnchor(readHourHeads(...))` (`anchor.ts:693`) | ⚠️ PARTIAL | Both endpoints are wired: adoption calls `readHourHeads` and `storeAnchor`. The missing piece is the guard `headsRoot(records) === memo.headsRootHex`, which is absent. `checkAdopt` does not return a heads root at all. Classified PARTIAL, a WARNING, not NOT_WIRED: the verification side still fails closed (see W2). |
| `verifyGraph` | per-hour trust | `trustHour` after `checkHourWithBudget` | ✓ WIRED | `service.ts:7560-7563`, `7610`. |
| `trustHour` | stored leaves | `greptime.hourChainLeaves` | ✓ WIRED | `service.ts:7637`, `greptime.ts:1820`. |
| `trustHour` | on-chain root gate | `headsRoot(records) !== onChainHeadsRoot` | ✓ WIRED | `service.ts:7653-7655`. |
| `trustHour` | per-pair comparison | `compareToAnchoredHead` | ✓ WIRED | `service.ts:7682`, `event.ts:399`. |
| `heads_root` source | devnet memo only | `parsed.headsRootHex` from `transactionMemo` | ✓ WIRED | `service.ts:7828`, `7853`, `7862`, `7891`. |
| Boot | `graph_chain_leaves` DDL | `index.ts:120` → `service.migrate` (`service.ts:1956-1984`) → `greptime.migrate` (`greptime.ts:967`) → DDL (`greptime.ts:1022-1028`) | ✓ WIRED (but see W3) | `index.ts` is not changed on this branch; the DDL it reaches is. |

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `trustHour` (`service.ts:7637-7650`) | `leaves` | `greptime.hourChainLeaves`, a SQL SELECT over `graph_chain_leaves` (`greptime.ts:1820-1832`) | Yes | ✓ FLOWING |
| `trustHour` (`service.ts:7668-7673`) | `links` | Event rows from `readEvents`, rehashed with `eventHash` | Yes | ✓ FLOWING |
| `anchorMemo` (`anchor.ts:473-476`) | `headsRootHex` | `readHourHeads` over `eventsByIds` rows (`anchor.ts:455-467`) | Yes | ✓ FLOWING |

## Behavioral Spot-Checks

Run as a single named test under `bwrap` with `/etc/substrate` masked and owned HOME and TMPDIR, per the bun-worktree-credential-isolation skill.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Criterion 1: edit of a stored event reports `first_differing_event_id` (truth 1) | `bun --no-env-file test packages/mcp-server/src/service.test.ts -t "an edited payload parts the chain at that event"` | 1 pass, 0 fail, 5 expect calls | ✓ PASS |

Not re-run in this pass, by rule (one named test per truth): the deletion, truncation and full-rewrite cases of criterion 1 at `service.test.ts:5259`, `:5275`, `:5288`. Their coverage is the orchestrator's full suite (11,380 pass, 2 skip, 0 fail), which was taken as given.

## Probe Execution

Step 7c skipped. The phase is not a migration or tooling phase, its success criteria do not mention probes, the PLAN and SUMMARY declare none, and no `scripts/*/tests/probe-*.sh` applies.

## Requirements Coverage

The PLAN has no `requirements:` field. `.planning/REQUIREMENTS.md` has no rows for phase 73. Nothing mapped, nothing ORPHANED. The cross-milestone note (REQUIREMENTS.md:85, "a new on-chain memo format") is resolved by the owner's confirmation that memo v2 is in v1.8 scope.

## Anti-Patterns Found

Debt-marker gate (TBD, FIXME, XXX) over the changed code files: no matches, so the gate passes. TODO, HACK and PLACEHOLDER: no matches in the changed code files.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/anchor.ts` | 688-698 | Adoption writes leaves and the row without the heads-root check | ⚠️ Warning | W2. Verification still fails closed. |
| `packages/mcp-server/src/greptime.ts` | 1022-1028 | Leaves DDL runs on every boot via `migrate`, contrary to D73-05 wording | ⚠️ Warning | W3. |
| `packages/mcp-server/src/service.test.ts` | 5247-5257 | Test named "an edited payload" edits `summary` | ⚠️ Warning | W4. |

## Human Verification Required

### 1. Live devnet v2 send

**Test:** Send one v2 memo for a closed hour through the anchor job. Read it back and compare its `heads_root` with the root recomputed from stored `graph_chain_leaves` rows. Run `substrate verify` on that graph.
**Expected:** The read-back matches, and that hour reports `trusted: true`.
**Why human:** Devnet sends are operator-gated (D73-05).

### 2. Live adoption of an already-anchored v2 hour

**Test:** On a live hour whose v2 memo is already on chain, run the adoption path (for example after removing its anchors row). Then compare the stored leaves with the on-chain `heads_root`.
**Expected:** The adoption writes leaves without comparing `heads_root` (`anchor.ts:688-698`). The mismatch surfaces only at verify time, as "stored leaves do not reproduce the on-chain heads root".
**Why human:** Depends on live devnet and store state.

### 3. First boot DDL on the live store

**Test:** On first boot of the live service, check that `graph_chain_leaves` exists in append_mode, and that boot output has no `graph_chain_leaves not created in append_mode` warning. Decide whether boot-time DDL is acceptable under D73-05.
**Expected:** The table exists in append_mode. D73-05 is either amended or the DDL moves out of boot.
**Why human:** Production DDL on the live GreptimeDB is operator-gated.

### 4. Live `substrate verify`

**Test:** Run `substrate verify <graph_id>` on a real graph with one v2-anchored hour and one v1-anchored hour.
**Expected:** The v2 hour reports `trusted: true`. The v1 hour reports `trusted: false` with reason "anchored with a v1 memo: no heads commitment on chain". `ok` is true for both.
**Why human:** Needs live GreptimeDB and devnet.

## Gaps Summary

**Blocking gaps: none.** No must-have is FAILED. No artifact is missing or a stub. No key link is NOT_WIRED. No debt marker.

Status derivation (Step 9): rule 1 does not fire. Rule 2 fires: four live human items remain, so `human_needed`. Overrides do not suppress human items. Human item 1 of the prior run (the criterion 2 reading decision) is closed by the override and is removed from the list.

Warnings and deviations:

**W1. Criterion 2 is met only under the commitment reading, now owner-accepted (PASSED override).** The anchor memo carries one hour-wide `heads_root` (`memo.ts:11-12`, `anchor.ts:473-476`). The anchors row has no head field. Heads are per (graph, session), not per graph (D73-02). Under the literal reading, a per-graph head value is not recorded in the anchor. The owner accepted the commitment reading; this is recorded, not hidden. Fix if the literal reading is ever wanted: add per-graph heads to the memo or to an on-chain record within the Solana memo limit.

**W2. The adoption path writes unverified leaves (WARNING; key link PARTIAL).** `checkAdopt` matches on root and count only (`anchor.ts:324`) and does not return a heads root. `anchor.ts:688-698` then stores leaves recomputed from rows and writes the row, with the on-chain memo, and emits `adopted: true`. Nothing compares `headsRoot(records)` with the on-chain `heads_root`. Verification still fails closed: `trustHour` recomputes the root from stored leaves and rejects a mismatch (`service.ts:7653-7655`), giving `mismatch` and `ok: false`. The anchor writer does not fail closed. No test covers adopting a v2 memo whose heads root disagrees with the rows; `anchor.test.ts:452` uses a v1 memo. Adopting a v1 memo also writes leaves that can never be trusted. Recommended fix: compare `headsRoot(records)` with `memo.headsRootHex` in `checkAdopt` and refuse to store on mismatch.

*Classification note.* The prior run labelled this link NOT_WIRED and also WARNING. Those conflict: Step 9 rule 1 makes NOT_WIRED a gaps_found trigger. I classify it PARTIAL: both endpoints exist and are wired, and only one guard is absent, with fail-closed verification downstream. If the orchestrator reads this row as NOT_WIRED, status becomes `gaps_found`. That is the one derivation call that could change the status.

**W3. Deviation from D73-05: boot runs the leaves DDL (WARNING).** D73-05 says no production DDL is applied at this step. But `packages/mcp-server/src/index.ts:120` calls `substrate.migrate()` on every boot (`service.ts:1956-1984`), which calls `greptime.migrate()` (`greptime.ts:967`) and runs `CREATE TABLE IF NOT EXISTS "graph_chain_leaves" ... WITH ('append_mode' = 'true')` (`greptime.ts:1022-1028`). The statement is idempotent, but on first boot it is production DDL. `index.ts` is unchanged on this branch; the DDL it reaches is new. Decision in human item 3.

**W4. The edit test changes `summary`, not `payload` (WARNING).** Criterion 1 names "edit a stored payload". The verdict-level edit test sets `row.summary` (`service.test.ts:5250`). `eventHash` covers the full content, and `trustHour` recomputes the hash from the row's fields (`service.ts:7668-7672`), so a payload edit takes the same comparison path. No test changes the `payload` column at verdict level. The unit test at `event.test.ts:314` changes the recomputed hash, not the payload. Recommended: add a payload-column case to `service.test.ts`. No code change is needed. This does not change the criterion 1 status; it narrows the evidence.

**I1. "Saved head" is implicit (Info).** The fixture builds the honest memo and leaves before any override (`service.test.ts:5168-5187`, `5229-5230`), and the override changes only what is read back. There is no separate save step. This meets criterion 1 in effect, and D73-07 accepts this harness.

**I2. `ok` is true for v1-only anchored hours (Info, by design).** Trust, not `ok`, is the proof gate (D73-04). Consumers that read only `ok` see true for untrusted v1 hours (`service.test.ts:5333-5340`).

**I3. Cross-milestone scope (Info, resolved).** REQUIREMENTS.md:85 excludes "a new on-chain memo format" from the earlier milestone. The owner confirmed memo v2 is in v1.8 scope on 2026-11-02.

**I4. Existing `verifyGraph` callers (Info).** Callers at `mcp.ts:1237`, `observe.ts:930` and `server.ts:1505` see additive fields only. Not tested individually here; the orchestrator's full suite covers them.

**Fingerprint.** `covered_digest` is unchanged from the prior record. Code files are unchanged since the last verification. The report itself is not in the covered set.

**Not run (by rule):** the full suite was not re-run. One named test was run. The orchestrator's gates (tsc 0; bun test 11,380 pass, 2 skip, 0 fail; phase-close 236 pass) were taken as given. No devnet send, no production DDL, no live GreptimeDB check.

---

_Verified: 2026-11-02T02:44:08Z_
_Verifier: Claude (gsd-verifier)_
