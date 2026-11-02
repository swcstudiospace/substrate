---
phase: 73-ledger-tamper-evidence
verified: 2026-11-02T02:10:53Z
status: human_needed
score: 1/2 must-haves verified
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", "packages/cli/src/evidence.test.ts", "packages/cli/src/verify.test.ts", "packages/evidence/src/report.ts", "packages/ledger/src/heads.test.ts", "packages/ledger/src/heads.ts", "packages/ledger/src/index.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/ledger/src/solana.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/checkpoint-verify.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/evidence-anchor.test.ts", "packages/mcp-server/src/graph-bind.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/mcp.test.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/reanchor-plan.test.ts", "packages/mcp-server/src/reanchor-plan.ts", "packages/mcp-server/src/reanchor-run.test.ts", "packages/mcp-server/src/reanchor.test.ts", "packages/mcp-server/src/reanchor.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/teachable-anchor.test.ts"]
covered_digest: "v3:sha256:3c755d478b2eb6278591b0539c5d1d4db771bce4fe79f509dbde0549a1002ac6"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Decide whether roadmap criterion 2 ('the chain head for each graph is recorded in the hourly anchor') is met by the heads_root commitment in memo v2, or requires per-graph head values in the anchor."
    expected: "A recorded decision. Commitment reading: criterion 2 becomes VERIFIED and the status can become passed once the live items below are closed. Literal reading: criterion 2 is FAILED and the status becomes gaps_found."
    why_human: "The wording is a semantic reading of the roadmap contract, not a programmatic check. See Gaps Summary W1."
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
**Verified:** 2026-11-02T02:10:53Z
**Status:** human_needed
**Re-verification:** No. Initial verification. The existing 73-VERIFICATION.md was written without this procedure and is not treated as a prior verification (brief rule). The earlier "2 of 2 MET" claim is superseded.

**Scope:** Branch `gsd/v18-p73-ledger-tamper`, worktree `/root/src/worktrees/as-gsd-v18-p73`. The 73-01-SUMMARY was not used as evidence; every claim below is checked against code. Procedure references are present under `~/.claude/gsd-core/references/`, so none were missing. No overrides exist for this phase. Roadmap success criteria 1 and 2 are the must-haves. The PLAN has no frontmatter `must_haves`, so the artifact and key-link queries returned exit 66 (NO_INPUT) and Steps 4 and 5 were evaluated manually. Requirements: none (see Requirements Coverage).

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | Criterion 1. Save the graph's head, then edits to a stored event, a middle deletion, tail truncation and a full rewrite with recalculated hash and prev each report the first differing event id (edits and rewrite) or the first missing event id (deletion and truncation), compared with that saved head. | ✓ VERIFIED | The comparison is `compareToAnchoredHead` (`packages/mcp-server/src/event.ts:399-427`). It requires the stored leaves to reproduce the head first (`event.ts:402-411`). It then walks the committed leaves: an absent event gives `first-missing` (`event.ts:420`), and a recomputed hash or stored hash that differs from the leaf gives `first-differing` (`event.ts:421`). `verifyGraph` maps those to `first_missing_event_id` and `first_differing_event_id` (`packages/mcp-server/src/service.ts:7682-7686`, `7694-7695`). Trust is withheld for any non-ok result (`service.ts:7684-7696`). Verdict `trusted` at `service.ts:7590`. The saved head is the honest fixture's memo and leaves, built before the override is applied (`service.test.ts:5168-5187`, `5229-5230`). Tests: `service.test.ts:5247` (edit), `5259` (middle deletion), `5275` (tail truncation), `5288` (full rewrite). The full rewrite was run as a single named test: **1 pass, 0 fail**. Unit level: `event.test.ts:292-330`. Deviation: the edit test changes `summary`, not `payload` (`service.test.ts:5250`). See W4. |
| 2   | Criterion 2. The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof that criterion 1 compares against. A head recomputed from stored rows is never the proof. | ? UNCERTAIN (WARNING) | Recorded as a commitment: memo v2 `substrate:v2:<period>:<root>:<count>:<heads_root>` (`packages/ledger/src/memo.ts:11-12`, `41-46`). `heads_root` is the Merkle root over per-(graph, session) head records (`packages/ledger/src/heads.ts:59-72`, `29-46`). The anchor writer builds it from stored rows (`packages/mcp-server/src/anchor.ts:396-437`, `455-476`) and stores leaves before the anchor row (`anchor.ts:479-482`, `821-830`). The send path verifies the read-back memo carries the same root (`anchor.ts:811`). The trusted proof is the on-chain value only: `heads_root` is read from the devnet memo (`service.ts:7853`, `7862`, `7891`). Stored leaves must reproduce it before a comparison runs (`service.ts:7653-7655`). Signed-but-unverifiable signers never yield a root (`service.ts:7881-7883`). Literal reading: no per-graph head value is recorded in the anchor. Only one hour-wide root is, and heads are per (graph, session) (D73-02). Trust logic: `service.ts:7603-7630`. Tests: `service.test.ts:5343` ran as a single named test, **1 pass**. Unit: `anchor.test.ts:1118` and `1142`. See W1. |

**Score:** 1/2 truths verified (0 present-but-behavior-unverified)

**Criterion 2 reading used.** I read "recorded in the hourly anchor" as recorded by commitment, the reading D73-01 and D73-04 lock in. The anchor records one `heads_root` that commits to every (graph, session) head, and trust is granted only when the stored leaves reproduce that root. Under this reading the criterion's second sentence holds: the on-chain commitment is the only trusted proof, and a recomputed head is never trusted. The literal reading ("a head value for each graph is recorded") is not met. I resolved criterion 2 as UNCERTAIN (WARNING with a human decision), not FAILED, because "recorded" admits a commitment and the phase chose one. If the human rejects the commitment reading, criterion 2 becomes FAILED and status becomes `gaps_found`.

### Required Artifacts

Step 4 is not applicable: `verify.artifacts` returned exit 66 (NO_INPUT, no `must_haves.artifacts` in the PLAN). The changed code files were checked at Levels 1 to 3 through the key-link table below.

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/ledger/src/heads.ts` | Head records and `headsRoot` | ✓ VERIFIED | Substantive (`heads.ts:59-72`). Wired into `anchor.ts` and `event.ts`. |
| `packages/ledger/src/memo.ts` | v2 memo format and parser | ✓ VERIFIED | `formatMemoV2`, `parseMemo` accepting v1 and v2 (`memo.ts:41-46`, `61-69`). Wired into `anchor.ts:473-475`, `service.ts:7853`. |
| `packages/mcp-server/src/event.ts` | `compareToAnchoredHead`, `orderedLeaves`, `headRecordsFromLeaves` | ✓ VERIFIED | `event.ts:342-427`. Called from `service.ts:7653`, `7682`. |
| `packages/mcp-server/src/anchor.ts` | Head builder, leaves writer, v2 send path | ✓ VERIFIED (with W2) | `buildGraphHeads` (`anchor.ts:396-437`), `readHourHeads` (`455-467`), `storeAnchor` (`479-482`). The adoption path has a gap: see W2. |
| `packages/mcp-server/src/greptime.ts` | `graph_chain_leaves` DDL, writer, readers | ✓ VERIFIED (with W3) | DDL at `greptime.ts:1022-1028`. Writer at `1803-1814`. Reader at `1820-1832`. Reader for deleted hours at `1838-1847`. The DDL runs on every boot: see W3. |
| `packages/mcp-server/src/service.ts` | `verifyGraph` trust and verdict | ✓ VERIFIED | `trustHour` at `7610-7700`. Verdict and `ok` gating at `7565-7590`. |
| `docs/greptime-ledger.md` | Memo v2 and trust rule documented | ✓ VERIFIED | Listed in the branch diff; documentation only, not checked line by line. |

### Key Link Verification

Step 5 is not applicable as a query: `verify.key-links` returned exit 66 (no `must_haves.key_links`). The links below were traced by hand.

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| anchor send path | `greptime.insertGraphChainLeaves` | `storeAnchor` before `insertAnchor` | ✓ WIRED | `anchor.ts:821-830`, `479-482`, `greptime.ts:1803`. |
| anchor send path | memo v2 with the heads root | `anchorMemo(...heads)` then read-back check | ✓ WIRED | `anchor.ts:750-758`, `811`. |
| anchor adoption path | on-chain `heads_root` check | `checkAdopt` root and count only, then `storeAnchor(readHourHeads(...))` | ✗ NOT_WIRED (partial) | `anchor.ts:324` compares root and count only. `anchor.ts:688-698` stores leaves recomputed from rows and writes the row, with no `headsRoot(records) === memo.headsRootHex` check. See W2. |
| `verifyGraph` | per-hour trust | `trustHour` after `checkHourWithBudget` | ✓ WIRED | `service.ts:7560-7563`, `7610`. |
| `trustHour` | stored leaves | `greptime.hourChainLeaves` | ✓ WIRED | `service.ts:7637`, `greptime.ts:1820`. |
| `trustHour` | on-chain root gate | `headsRoot(records) !== onChainHeadsRoot` | ✓ WIRED | `service.ts:7653-7655`. |
| `trustHour` | per-pair comparison | `compareToAnchoredHead` | ✓ WIRED | `service.ts:7682`, `event.ts:399`. |
| `heads_root` source | devnet memo only | `parsed.headsRootHex` from `transactionMemo` | ✓ WIRED | `service.ts:7828`, `7853`, `7862`, `7891`. |
| Boot | `graph_chain_leaves` DDL | `index.ts:120` to `service.migrate` to `greptime.migrate` | ✓ WIRED (but see W3) | `index.ts:120`, `service.ts:1956-1984`, `greptime.ts:1022-1028`. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `trustHour` (`service.ts:7637-7650`) | `leaves` | `greptime.hourChainLeaves`, a SQL SELECT over `graph_chain_leaves` (`greptime.ts:1820-1832`) | Yes | ✓ FLOWING |
| `trustHour` (`service.ts:7668-7673`) | `links` | Event rows from `readEvents`, rehashed with `eventHash` | Yes | ✓ FLOWING |
| `anchorMemo` (`anchor.ts:473-476`) | `headsRootHex` | `readHourHeads` over `eventsByIds` rows (`anchor.ts:455-467`) | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

Run as single named tests through `bun --no-env-file test` inside bwrap, with `/etc/substrate` masked and owned HOME and TMPDIR, per the bun-worktree-credential-isolation skill.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Criterion 1: full rewrite with recalculated hash and prev reports the first differing event (truth 1) | `bun test packages/mcp-server/src/service.test.ts -t "a full rewrite with every hash and prev recalculated parts at the first event"` | 1 pass, 0 fail, 4 expect calls | ✓ PASS |
| Criterion 2: stored leaves that do not reproduce the on-chain heads root give stored-leaves-mismatch for the whole hour, with no pairs trusted (truth 2) | `bun test packages/mcp-server/src/service.test.ts -t "stored leaves that no longer reproduce the on-chain heads root"` | 1 pass, 0 fail, 2 expect calls | ✓ PASS |

The edit, deletion and truncation cases of criterion 1 were not run individually. They are covered by the orchestrator's full suite (11,380 pass, 2 skip, 0 fail) and read at `service.test.ts:5247-5286`.

### Probe Execution

Step 7c skipped. The phase is not a migration or tooling phase, its success criteria do not mention probes, the PLAN and SUMMARY declare none, and no `scripts/*/tests/probe-*.sh` exists.

### Requirements Coverage

The PLAN has no `requirements:` field. `.planning/REQUIREMENTS.md` has no rows for phase 73. Nothing is mapped and nothing is ORPHANED. See I3 for a cross-milestone note.

### Anti-Patterns Found

Debt-marker gate (TBD, FIXME, XXX) over the changed code files: no matches, so the gate passes. TODO, HACK and PLACEHOLDER: no matches.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/greptime.ts` | 414 | Comment "placeholder: an empty literal" in SQL escaping | ℹ️ Info | Not a stub. The function escapes a real value. |
| `packages/mcp-server/src/anchor.ts` | 688-698 | Adoption writes leaves and the row without the heads-root check | ⚠️ Warning | See W2. Verification still fails closed. |
| `packages/mcp-server/src/index.ts` | 120 | Boot runs `substrate.migrate()`, which creates `graph_chain_leaves` | ⚠️ Warning | See W3. Contradicts D73-05 wording. |

### Human Verification Required

### 1. Decide the criterion 2 reading

**Test:** Review roadmap criterion 2 against the heads_root commitment design (D73-01, D73-04). Record whether a commitment satisfies "the chain head for each graph is recorded in the hourly anchor".
**Expected:** A written decision. Commitment reading: criterion 2 becomes VERIFIED. Literal reading: criterion 2 becomes FAILED and status becomes `gaps_found`, with per-graph head values added to the anchor.
**Why human:** This is a semantic reading of the roadmap contract, not a programmatic check.

### 2. Live devnet v2 send

**Test:** Send one v2 memo for a closed hour through the anchor job. Read it back and compare its `heads_root` with the root recomputed from stored `graph_chain_leaves` rows. Run `substrate verify` on that graph.
**Expected:** The read-back matches, and that hour reports `trusted: true`.
**Why human:** Devnet sends are operator-gated (D73-05).

### 3. Live adoption of an already-anchored v2 hour

**Test:** On a live hour whose v2 memo is already on chain, run the adoption path (for example after removing its anchors row). Then compare the stored leaves with the on-chain `heads_root`.
**Expected:** The adoption writes leaves without comparing `heads_root`. The mismatch surfaces only at verify time, as "stored leaves do not reproduce the on-chain heads root".
**Why human:** Depends on live devnet and store state.

### 4. First boot DDL on the live store

**Test:** On first boot of the live service, check that `graph_chain_leaves` exists in append_mode, and that boot output has no `graph_chain_leaves not created in append_mode` warning. Decide whether boot-time DDL is acceptable under D73-05.
**Expected:** The table exists in append_mode. D73-05 is either amended or the DDL moves out of boot.
**Why human:** Production DDL on the live GreptimeDB is operator-gated.

### 5. Live `substrate verify`

**Test:** Run `substrate verify <graph_id>` on a real graph with one v2-anchored hour and one v1-anchored hour.
**Expected:** The v2 hour reports `trusted: true`. The v1 hour reports `trusted: false` with reason "anchored with a v1 memo: no heads commitment on chain". `ok` is true for both.
**Why human:** Needs live GreptimeDB and devnet.

### Gaps Summary

**Blocking gaps: none.** No must-have is FAILED. No artifact is missing or a stub. The phase does not show `gaps_found`. Status is `human_needed` because of the human items above (Step 9, rule 2).

Warnings and deviations:

**W1. Criterion 2 is met only under a commitment reading (UNCERTAIN, human decision).** The anchor memo carries one hour-wide `heads_root` (`memo.ts:11-12`, `anchor.ts:473-476`). The anchors row has no head field. Heads are per (graph, session), not per graph (D73-02), so a graph with two sessions has two heads. Under the commitment reading the criterion holds: the on-chain root is the only trusted proof, and a recomputed head is never trusted. Under the literal reading it fails. The human decides (human item 1). Recommended fix if the literal reading is wanted: add the per-graph heads to the memo or to an on-chain record, within the Solana memo limit.

**W2. The adoption path writes unverified leaves (WARNING).** `checkAdopt` matches on root and count only (`anchor.ts:324`). `anchor.ts:688-698` then stores leaves recomputed from rows and writes the row with the on-chain memo, and emits `adopted: true`. Nothing compares `headsRoot(records)` with the on-chain `heads_root`. Verification still fails closed: `trustHour` recomputes the root from stored leaves and rejects a mismatch (`service.ts:7653-7655`), giving `mismatch` and `ok: false`. The anchor writer does not fail closed. No test covers adopting a v2 memo whose heads root disagrees with the rows (`anchor.test.ts:452` uses a v1 memo). Adoption of a v1 memo also writes leaves that can never be trusted. Recommended fix: compare `headsRoot` with `memo.headsRootHex` before `storeAnchor`, and raise a root-mismatch alarm on disagreement, as the root check already does.

**W3. Deviation from D73-05: boot runs the leaves DDL (WARNING).** D73-05 and the SUMMARY say no production DDL was run. But `packages/mcp-server/src/index.ts:120` calls `substrate.migrate()` on every boot (`service.ts:1956-1984`), which calls `greptime.migrate()` (`greptime.ts:967`) and runs `CREATE TABLE IF NOT EXISTS "graph_chain_leaves" ... WITH ('append_mode' = 'true')` (`greptime.ts:1022-1028`). The statement is idempotent, but on first boot it is production DDL. Decision in human item 4.

**W4. The edit test changes `summary`, not `payload` (WARNING).** Criterion 1 names "edit a stored payload". The verdict-level edit test sets `row.summary` (`service.test.ts:5250`). `eventHash` covers every field, canonicalised (`event.ts:35-37`), so a payload edit takes the same path. No test exercises a payload-column edit at verdict level. The unit test at `event.test.ts:314` changes the recomputed hash, not the payload. Recommended: add a payload-column case to `service.test.ts`. No code change is needed.

**I1. "Saved head" is implicit (Info).** The test fixture builds the honest memo and leaves before any override (`service.test.ts:5168-5187`, `5229-5230`). The override then changes only what is read back. This meets criterion 1 in effect, and D73-07 accepts this harness. There is no separate save step.

**I2. `ok` is true for v1-only anchored hours (Info, by design).** `service.test.ts:5333-5340` shows `trusted: false` with `ok: true`. D73-04 makes trust, not `ok`, the gate for proof. Consumers that read only `ok` will see true for untrusted v1 hours.

**I3. Cross-milestone note (Info).** `.planning/REQUIREMENTS.md:85` (v1.7 out of scope) excludes "a new on-chain memo format". Phase 73 (v1.8, per the ROADMAP) adds memo v2. This is not a phase 73 must-have. The orchestrator should confirm the v1.8 scope allows it.

**I4. Existing `verifyGraph` callers (Info).** Callers at `mcp.ts:1237`, `observe.ts:930` and `server.ts:1505` see additive fields only. I did not test them individually. The orchestrator's full suite covers them.

**Not run (by rule):** the full suite was not re-run. Only two named tests were run. The orchestrator's gates (tsc 0; bun test 11,380 pass, 2 skip, 0 fail; phase-close 236 pass) were taken as given. No devnet send, no production DDL, no live GreptimeDB check.

---

_Verified: 2026-11-02T02:10:53Z_
_Verifier: Claude (gsd-verifier)_
