---
phase: 73-ledger-tamper-evidence
verified: 2026-11-02T18:33:35Z
status: gaps_found
score: 1/2 must-haves verified
covered_files: ["docs/greptime-ledger.md", "packages/cli/src/index.ts", "packages/evidence/src/report.ts", "packages/ledger/src/heads.test.ts", "packages/ledger/src/heads.ts", "packages/ledger/src/index.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/checkpoint-verify.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/evidence-anchor.test.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", ".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md"]
covered_digest: "v3:sha256:a0bd518be02bb932e0ae8d6940d47e051fb248dc7d7191928b9f6644256117c3"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof criterion 1 compares against; a head recomputed from the stored rows is never the proof."
    reason: "Owner accepted the commitment reading on 2026-11-02: each graph head is committed on chain by the memo v2 heads_root and recovered only through stored leaves that reproduce it (memo.ts:42-46, heads.ts:59-71, anchor.ts:473-476). Carried from the prior record; acceptance not re-obtained here."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: 2/2 must-haves verified
  previous_verified: 2026-11-02T17:54:45Z
  previous_scope: "integration tree gsd/v18-int-all, HEAD 749e97e3"
  scope: "integration tree gsd/v18-int-all, HEAD c7788f9d (phase 73 code unchanged since d8512fbb, the PR 201 review fixes)"
  reason: "Overwritten on the review-fixed tree. Re-traced whole-hour removal, which the prior record did not trace; that trace is a new gap (G1). Two other new findings (W5, W6) are warnings."
  gaps_closed: []
  gaps_remaining: ["G1: an anchored hour removed whole (rows, ingest records and graph_chain_leaves) is not detected by verifyGraph"]
  regressions: []
gaps:
  - truth: "Criterion 1: a truncation of the ledger's last events is detected against the saved head and reports the first missing event id"
    status: failed
    reason: "When an anchored hour is removed whole from agent_events, event_ingest and graph_chain_leaves, verifyGraph never visits that hour. It reports ok true and trusted true for the remaining hours. Code trace, not executed in this run."
    artifacts:
      - path: "packages/mcp-server/src/service.ts"
        issue: "hourReport takes its hour set only from the graph's rows, ingest records and chain-leaf hours (7973, 8019, 8030, 8038-8040). The anchors table is never read per graph, so the anchor for the removed hour is not consulted. ok (8243) and trusted (8268) then pass."
      - path: "packages/mcp-server/src/service.test.ts"
        issue: "The trailing-hour test (5518) keeps graphChainLeafHours as [H, NEXT]. Its design depends on the leaves surviving. No test removes the leaves."
    missing:
      - "A way for verifyGraph to learn the graph's anchored hours that removing rows, ingest records and leaves cannot erase. The mechanism is an owner and design decision (see Open Decisions)."
      - "A test: remove the trailing anchored hour from rows, ingest and leaves; expect ok false and an untrusted hour naming it."
deferred: []
behavior_unverified_items: []
---

# Phase 73: Ledger tamper evidence Verification Report

**Phase Goal:** A rewrite, reorder, deletion or tail truncation of the event ledger is detected by recomputing the chain from the stored rows, and the verified head is anchored.
**Criteria source:** `origin/main` `.planning/ROADMAP.md`, section "### Phase 73: Ledger tamper evidence" (read with `git show origin/main:.planning/ROADMAP.md`). The two criteria are identical to this tree's ROADMAP. The texts differ only in the Status and Plans lines (origin/main: "Not started", "none written"; this tree: "human_needed", linked to 73-01). Those lines are not criteria, so the choice of source changes nothing.
**Tree:** `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `c7788f9d`. The PR 201 review fixes (`d8512fbb`) are on this tree and are judged here. Phase 73 code is unchanged since `d8512fbb`. `c7788f9d` changed only `service.ts` lines 2969 to 3048 (phase 76), so line numbers below are on `c7788f9d`. Several are 8 lines higher than in the prior record.
**Requirements:** `HARD-S3` (REQUIREMENTS.md:114, mapped to phase 73 at line 135). The prior record said REQUIREMENTS.md had no phase 73 rows. That was wrong. HARD-S3 is assessed in the Requirements Coverage section.
**Verified:** 2026-11-02T18:33:35Z
**Status:** gaps_found

## Verdict summary

- **Must-haves: 1 of 2 verified.** Criterion 2 is PASSED (override, owner-accepted reading). Criterion 1 is FAILED on one case, which is the whole-hour removal below (G1). Criterion 1's enumerated mutations are VERIFIED by tests and code.
- **G1 (new, blocking):** an anchored hour removed from `agent_events`, `event_ingest` and `graph_chain_leaves` together is not detected by `verifyGraph`. It is traced from code and not executed. It needs write access to three tables, which is the attacker model this phase is for. The enumerated tests all keep the leaves, so none reaches it.
- **Warnings:** W2 adoption and alarm paths without a heads-root check (open). W3 leaves DDL on every boot versus D73-05 (open decision). W4 no verdict-level payload-column test. W5 (new) the evidence bundle's app-chain attestation ignores hour trust. W6 (new) `docs/greptime-ledger.md` says `ok` is unchanged for `budget exhausted` and `store-failed`, which the code and tests contradict.
- **Targeted tests:** 86 pass, 0 fail, across three `bun test` commands (below). They confirm the prior counts and that the PR 201 tests are present and passing.
- **Human items:** 5 live or code-read proofs (below). **Open decisions:** criterion 2 reading (override carried), D73-05 boot DDL, the W2 guard, the W4 test, the G1 remedy and its scope, and the HARD-S3 "scheduled verification" scope.
- **Changed from the prior record:** human_needed (2/2) becomes gaps_found (1/2). The reason is G1, traced for the first time in this run.

## PR 201 review fixes judged on this tree (commit d8512fbb)

| Fix | Code (c7788f9d) | Test (run this session) | Verdict |
| --- | --------------- | ----------------------- | ------- |
| `VerifyVerdict.hours_unreadable`: an unreadable chain-leaves read makes the verdict untrusted and the app chain unverifiable, not intact | field `service.ts:753`; set `service.ts:8262` from `leavesUnreadable` (`:8035-8037`, `budget exhausted` or `store-failed`); `ok` requires `leavesUnreadable === null` (`:8243`); `trusted` excludes it (`:8268`); `observe.ts:1050-1057` returns `state: unverifiable, ok: null` | `evidence-anchor.test.ts:400` "an hour list that cannot be read leaves the app chain unverifiable…" PASS; `service.test.ts:5497` and `:5512` assert `ok` false for `store-failed` and `budget exhausted` PASS | Confirmed. The `ok` behaviour is also a W6 docs issue. |
| `withFault` on every unverified or mismatch return in `checkHour` that can follow a digest fault | `withFault` `service.ts:8470`; applied at `8482, 8495, 8501, 8504, 8510, 8513, 8516, 8521, 8528, 8531, 8535, 8538`. The fault-only returns carry `recomputed.fault` at `8488` and `8544`. | The seven ledger-fault tests `service.test.ts:5302-5378` PASS in the "heads trust" run (30 pass) | Confirmed. Returns that cannot follow a digest fault (`pending`, `unanchored`, the signer result after a clean digest) are not wrapped, by design. |
| `compareToAnchoredHead` names the extra linked to the committed tip first | `event.ts:472`: `extras.find((e) => e.prev === last.hash) ?? inChainOrder(extras)[0]` | `event.test.ts:458` "an event past the stored end is first-differing" and `:479` "an edit past the committed end names the event that links to the head…" PASS (in the 43-test run) | Confirmed. |

Other changes in the PR 201 commit are phase 76 buffer and write-path work and are not phase 73 criteria.

## Criterion 1: sub-case verdicts

Tests run in this session are the `heads trust` describe block in `service.test.ts` (`:5175-5645`), the chain-leaves describe block in `event.test.ts` (`:404-493`), and the anchor tests named in the Behavioral Spot-Checks.

| Mutation (criterion 1 wording) | Code path | Test | Result |
| --- | --- | --- | --- |
| Edit a stored payload, then compare with the saved head | `trustHour` rehashes each row (`service.ts:8349-8350`, `eventHash` covers the whole event incl. payload, `event.ts:36-38`); mismatch to leaf is first-differing (`event.ts:466`) | `service.test.ts:5261` and `:5459`, but they change `summary`, not `payload` | ✓ VERIFIED with W4 |
| Delete a middle event: first missing id | `event.ts:465` | `service.test.ts:5273` PASS | ✓ VERIFIED |
| Truncate the last events within an hour: first missing id | `event.ts:465`, leaves in seq order | `service.test.ts:5289` PASS | ✓ VERIFIED |
| Truncate the last hour, rows and ingest gone, leaves kept | hour set from leaves (`service.ts:8038-8040`) | `service.test.ts:5468` PASS | ✓ VERIFIED |
| Truncate or remove a whole anchored hour, leaves also removed | none: the hour is never visited (see G1) | none. The trailing-hour test (`:5518`) keeps `graphChainLeafHours` at `[H, NEXT]` | ✗ FAILED (G1) |
| Rewrite the whole chain with recalculated `hash` and `prev`: first differing id | `event.ts:466`; digest mismatch sets `signedHeads` (`service.ts:8544`, `:8555`) | `service.test.ts:5387` PASS: first differing is event 1, `ok` false, local chain `ok` true | ✓ VERIFIED with W4 (summary rewrite; payload not rewritten) |
| Stored leaves edited against an unchanged on-chain root: `stored-leaves-mismatch` | `event.ts:451`; `trustHour` `service.ts:8332` | `service.test.ts:5442`, `:5567` PASS | ✓ VERIFIED |
| Unanchored hour and v1-only hour: untrusted with reason | `service.ts:8302`, `:8304-8306` | `service.test.ts:5424`, `:5432` PASS | ✓ VERIFIED |
| Reorder (goal wording) | `verifyChain` prev and hash checks (`event.ts:480-494`); unit test `event.test.ts:160` "the hash covers prev, so reordering is detectable" | no verdict-level reorder test; read order only (`service.test.ts:5415-5421`, benign) | Present; behaviour verified at the unit level only (I3) |

### G1 trace (whole-hour removal)

1. `verifyGraph` (`service.ts:7852`) reads the graph's rows by stored graph id. `hourReport` (`:7939`) builds `byHour` from three sources only: ingest records of the graph (`:7973`, `:8019`, `:8030`), and the graph's chain-leaf hours (`:8038-8040`, from `greptime.graphChainLeafHours`, `greptime.ts:1869`).
2. The anchors table is store-wide. The anchor job reads it by window (`greptime.ts:1787`, `anchorsBetween`), and `checkHour` reads it by hour (`greptime.ts:1803`, `anchorForPeriod`). `verifyGraph` never reads it by graph, and `checkHour` runs only for hours in `byHour` (`service.ts:8215-8236`). `anchorsBetween` is an existing store-wide read that a remedy could use.
3. Remove the anchored hour H2 from all three tables. Then `byHour` has only H1. Next, `gap` (`:8059`) is empty, `chain.ok` (`:7865`) is true because H1's prefix is intact, `ok` (`:8243`) is true, and `trusted` (`:8268`) is true if H1 is trusted.
4. The test at `service.test.ts:5518` keeps H2's leaves. The one at `:5468` removes the only hour's rows and ingest but keeps its leaves. Neither removes the leaves of a hour whose rows are also gone.
5. Reachability and outcome are [INFERENCE] from the code above. Confirm by running this on a scratch store: anchor two hours, remove the second from `agent_events`, `event_ingest` and `graph_chain_leaves`, then run `substrate verify`. Expected per the criterion: `ok` false naming H2. The code predicts `ok` true.

### Criterion 2: PASSED (override)

The commitment reading is carried from the prior record. The literal reading is not met: the anchor carries one hour-wide `heads_root` over all (graph, session) records, and per-graph heads are not in the anchor row. The mechanism is present as described. The send path builds the heads from event rows (`anchor.ts:752`), commits them (`anchorMemo` `:473-476`, `formatMemoV2` `memo.ts:42-46`), and requires an exact read-back (`anchor.ts:811`) before storing (`storeAnchor` `:479-482`, `:822`). `trustHour` takes the head only from the devnet memo (`service.ts:8542`, `:8571`) and never from rows (`:8332`). This matches the override's wording.

**Score:** 1 of 2 must-haves verified (criterion 2 PASSED override; criterion 1 FAILED on G1, with its enumerated cases VERIFIED).

## Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/ledger/src/heads.ts` | Head record hash, Merkle heads root | ✓ VERIFIED | `headRecordHash` `:25`, `headsRoot` `:59`; refuses empty input, duplicate pairs and mixed periods. |
| `packages/ledger/src/memo.ts` | v2 format and parser; v1 unchanged | ✓ VERIFIED | `MEMO_V2_RE` `:12`, `formatMemoV2` `:42`, `parseMemo` `:61` accepts v1 and v2. |
| `packages/ledger/src/merkle.ts` | RFC 6962 root | ✓ VERIFIED | `merkleRootHex` `:44`. |
| `packages/mcp-server/src/event.ts` | `chainLeafCommitment` `:378`, `orderedLeaves` `:387`, `headRecordsFromLeaves` `:404`, `compareToAnchoredHead` `:444` | ✓ VERIFIED | Extra-first fix `:472`. `verifyChain` `:480` unchanged. |
| `packages/mcp-server/src/anchor.ts` | Heads builder, leaves writer, v2 send path | ✓ VERIFIED (with W2) | `buildGraphHeads` `:396`, `readHourHeads` `:455`, `anchorMemo` `:473`, `storeAnchor` `:479` (leaves before row), send read-back `:811`. Adoption and alarm gap in W2 (`:324`, `:668-675`, `:691-698`). |
| `packages/mcp-server/src/greptime.ts` | `graph_chain_leaves` DDL, writer, readers | ✓ VERIFIED (with W3) | `migrate` `:967`; DDL `:1024`; writer `insertGraphChainLeaves` `:1834`; reader `hourChainLeaves` `:1851`; hour list `graphChainLeafHours` `:1869`. |
| `packages/mcp-server/src/service.ts` | `VerifyVerdict`, `verifyGraph`, `hourReport`, `trustHour`, `checkHour`, `withFault` | ✓ VERIFIED (G1 in `hourReport`) | `VerifyVerdict` `:743`, `hours_unreadable` `:753`, `verifyGraph` `:7841`, `hourReport` `:7939`, `trustHour` `:8288`, `checkHour` `:8451`, `withFault` `:8470`. |
| `packages/mcp-server/src/observe.ts` | `appChainOf` unverifiable on unreadable hours | ✓ VERIFIED (with W5) | `appChainOf` `:1045-1058`. |
| `packages/cli/src/index.ts` | `substrate evidence` exit on unverifiable chain and unverified hours | ✓ VERIFIED (code-read; human item 5) | Chain exit `:506-512`; unverified-hour exit `:529-536`. |
| `docs/greptime-ledger.md` | Memo v2 and trust rule | ✓ VERIFIED (with W6) | "Memo v2 and per-graph heads" `:545-576`. The trust rule matches code. The `ok` statement at `:575` is wrong. |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| anchor send path | `greptime.insertGraphChainLeaves` | `storeAnchor` before `insertAnchor` | ✓ WIRED | `anchor.ts:479-482`, `:822`. |
| anchor send path | memo v2 with heads root | `anchorMemo` `:758`, read-back `:811` | ✓ WIRED | |
| anchor adoption path | on-chain `heads_root` check | `checkAdopt` compares root and count only (`:324`), then `storeAnchor(readHourHeads(...))` (`:693`) | ⚠️ PARTIAL | Heads-root guard absent. Verification still fails closed (W2). |
| anchor alarm path | on-chain `heads_root` check | `storeAnchor(readHourHeads(...))` at `:670` | ⚠️ PARTIAL | Same as adoption (W2). |
| `verifyGraph` | per-hour trust | `hourReport` then `trustHour` (`service.ts:8239`) | ✓ WIRED | |
| `verifyGraph` | hour set | rows, ingest, leaves (`:7973`, `:8019`, `:8030`, `:8038-8040`) | ✗ INCOMPLETE | Anchors never read per graph: G1. |
| `verifyGraph` | unreadable-hours verdict | `leavesUnreadable` → `ok` `:8243`, `trusted` `:8268`, `hours_unreadable` `:8262` | ✓ WIRED | |
| `trustHour` | stored leaves | `greptime.hourChainLeaves` | ✓ WIRED | `service.ts:8315`, `greptime.ts:1851`. |
| `trustHour` | on-chain root gate | `headsRoot(records) !== onChainHeadsRoot` | ✓ WIRED | `service.ts:8332`. |
| `trustHour` | per-pair comparison | `compareToAnchoredHead` | ✓ WIRED | `service.ts:8360`, `event.ts:444`. |
| `heads_root` source | devnet memo only | `checkHour` sets `heads_root` only from a parsed memo with an accepted signer | ✓ WIRED | `service.ts:8542`, `:8571`. |
| `appChainOf` | evidence bundle | `hours_unreadable` → `state: unverifiable` | ✓ WIRED | `observe.ts:1050-1057`, called `:956-957`. Hour verdicts are not included (W5). |
| `substrate evidence` exit | unverifiable chain | `chainStateOf` → exit 1 "does not attest" | ⚠️ CODE-READ ONLY | `cli/src/index.ts:506-512`. |
| Boot | `graph_chain_leaves` DDL | `index.ts:121` → `service.ts:2253` → `greptime.migrate` `:967` → DDL `:1024` | ✓ WIRED (W3) | Runs on every start. |

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `trustHour` (`service.ts:8331`) | `leaves` | SQL over `graph_chain_leaves` (`greptime.ts:1851`) | Yes | ✓ FLOWING |
| `trustHour` (`service.ts:8349-8350`) | `links` | Event rows, rehashed with `eventHash` | Yes | ✓ FLOWING |
| `anchorMemo` (`anchor.ts:473`) | `headsRootHex` | `readHourHeads` over `eventsByIds` (`anchor.ts:455`) | Yes | ✓ FLOWING |
| `hourReport` (`service.ts:8037`) | `leavesUnreadable` | `outcomeWithin(greptime.graphChainLeafHours)` | Yes; failed or late read is named | ✓ FLOWING |
| `hourReport` (`service.ts:7973`) | `byHour` hour set | rows, ingest, leaves | Yes, but not complete: anchors absent | ✗ INCOMPLETE (G1) |

## Behavioral Spot-Checks (targeted, this tree)

Run under bwrap with `/etc/substrate` masked and `env -i`, with `TMPDIR=/root/src/worktrees/backups/gate-tmpfs` and `HOME=$TMPDIR/home-p73-r8`. `SUBSTRATE_TEST_PG_URL` unset, no Postgres, no full suite. Three `bun` commands in total, serial. Command template:

```
env -i PATH=$PATH HOME=$TMPDIR/home-p73-r8 TMPDIR=$TMPDIR bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --tmpfs /etc/substrate --bind $TMPDIR $TMPDIR -- bun --no-env-file test <files> -t "<pattern>"
```

| # | Files and pattern | Result | Status |
| - | ----------------- | ------ | ------ |
| 1 | `packages/mcp-server/src/service.test.ts -t "heads trust"` | 30 pass, 0 fail, 93 expect calls. Covers criterion 1 verdicts, the v1 and unanchored cases, the stored-leaves mismatch, `store-failed` and `budget exhausted`, and the seven PR 201 ledger-fault tests. Log: `backups/gate-tmpfs/p73-r8-cmd1.log`. | ✓ PASS |
| 2 | `packages/ledger/src/heads.test.ts packages/ledger/src/memo.test.ts packages/mcp-server/src/event.test.ts packages/mcp-server/src/evidence-anchor.test.ts -t "heads\|memo\|v2\|leaves\|anchored head\|hour list that cannot be read"` (the pattern is double-quoted in the run) | 43 pass, 0 fail, 101 expect calls, 4 files. Includes the PR 201 tests in `event.test.ts` and `evidence-anchor.test.ts:400`. Log: `p73-r8-cmd2.log`. | ✓ PASS |
| 3 | `packages/mcp-server/src/anchor.test.ts -t "heads\|leaves\|v2 memo\|same root and count adopts\|re-run over an anchored hour\|same cluster\|another cluster"` | 13 pass, 0 fail, 41 expect calls. Covers heads determinism and order, v2 send, leaves-write failure stopping the anchor, empty hour, and adoption on the same root. Log: `p73-r8-cmd3.log`. | ✓ PASS |

Not run: the full suite, `tsc`, lint, formatters, any Postgres, any devnet send, any production DDL. The G1 trace and the W2 and W3 behaviour are not exercised by these commands.

## Probe Execution

Not applicable. The phase is not a migration or tooling phase. Its criteria do not mention probes, and the PLAN and SUMMARY declare none.

## Requirements Coverage

The PLAN has no `requirements:` field. REQUIREMENTS.md maps **HARD-S3** to phase 73 (line 135, "Preliminary edits validated; not complete"). Its text is at line 114 and is identical at commit `23bd0733`. HARD-S3 is assessed against its own wording:

| Clause | Status | Evidence |
| ------ | ------ | -------- |
| Chain canonical content checksums using a standard hash | ✓ SATISFIED | `eventHash` = SHA-256 of canonical JSON of the whole event (`event.ts:36-38`). |
| On-demand verification detects modified, deleted, gapped or reordered entries and reports the first bad position | ⚠️ PARTIAL | Met for the enumerated cases (`service.test.ts` heads trust). Not met for whole-hour removal (G1). Reorder is detected only at unit level (I3). |
| Scheduled verification detects the same and reports the first bad position | ✗ BLOCKED (owner decision) | No scheduled per-graph verification exists. `verifyGraph` callers are request-driven (`mcp.ts:1260`, `observe.ts:952`, `server.ts:1616`). The hourly timer (`docs/greptime-ledger.md:465`, `infra/vps/substrate-anchor.timer`) runs the store-wide anchor job, which raises `root-mismatch` with no position (`anchor.ts:676-677`). Whether that counts as "scheduled verification" is an owner decision (open). |
| State explicitly which trusted earlier proof supports truncation and rewrite detection | ✓ SATISFIED | `docs/greptime-ledger.md:555-566` ("Only the on-chain root is trusted"). |
| Never claim hashes recomputed solely from modified rows prove the missing history | ✓ SATISFIED in code | `trustHour` never builds the proof from rows (`service.ts:8332`). G1 is the remaining case where history is missing from the tables and the verdict still passes. |

HARD-R1 (phase 74) and HARD-S2 (phase 72) are binding for other phases and are not assessed here. The ledger's own plan has no requirement IDs.

## Anti-Patterns Found

Debt-marker scan (TBD, FIXME, XXX) and warning-level scan (TODO, HACK, PLACEHOLDER) over the phase 73 code files: no matches.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/service.ts` | 8037-8040, 8243, 8268 | Hour set built from mutable stores only; `ok` and `trusted` do not see removed hours | 🛑 Blocker (G1) | Criterion 1 truncation case not detected. |
| `packages/mcp-server/src/anchor.ts` | 324, 668-675, 691-698 | Adoption and alarm write leaves without a heads-root check | ⚠️ Warning | W2. Verification fails closed. |
| `packages/mcp-server/src/greptime.ts` | 1020-1028, 1090-1108 | Leaves DDL on every boot. No append-mode confirmation for `graph_chain_leaves` | ⚠️ Warning | W3. |
| `packages/mcp-server/src/service.test.ts` | 5261, 5387, 5459 | Edits and rewrites change `summary`, not `payload` | ⚠️ Warning | W4. |
| `packages/mcp-server/src/observe.ts` | 1045-1058 | App-chain attestation reads the chain verdict only | ⚠️ Warning | W5. |
| `docs/greptime-ledger.md` | 575 | "`ok` is unchanged" for `budget exhausted` and `store-failed` | ⚠️ Warning | W6. Code (`:8243`) and tests (`:5497`, `:5512`) say `ok` is false. |

## Human Verification Required

Status is gaps_found, so these are kept for the human pass rather than as the status driver.

### 1. Live devnet v2 send
**Test:** Send one v2 memo for a closed hour through the anchor job. Read it back and compare its `heads_root` with the root recomputed from stored `graph_chain_leaves` rows. Run `substrate verify` on that graph.
**Expected:** Read-back matches. That hour reports `trusted: true`.
**Why human:** Devnet sends are operator-gated (D73-05).

### 2. Live adoption of an already-anchored v2 hour
**Test:** On a live hour whose v2 memo is already on chain, run the adoption path (for example after removing its anchors row). Then compare the stored leaves with the on-chain `heads_root`.
**Expected:** Adoption writes leaves without checking `heads_root` (`anchor.ts:691-698`). The mismatch surfaces only at verify time, as "the stored leaves do not reproduce the on-chain heads root".
**Why human:** Depends on devnet and store state. Confirms W2.

### 3. First boot DDL on the live store
**Test:** On first boot of the live service, check that `graph_chain_leaves` exists in append_mode, and that boot output has no `graph_chain_leaves not created in append_mode` warning.
**Expected:** The table exists in append_mode. D73-05 is amended, or the DDL moves out of boot.
**Why human:** Production DDL is operator-gated. Confirms W3.

### 4. Live `substrate verify`
**Test:** Run `substrate verify <graph_id>` on a real graph with one v2-anchored hour and one v1-anchored hour.
**Expected:** The v2 hour reports `trusted: true`. The v1 hour reports `trusted: false` with "anchored with a v1 memo: no heads commitment on chain". `ok` is true for both.
**Why human:** Needs live GreptimeDB and devnet.

### 5. Unverifiable app chain exits non-zero (code-read only)
**Test:** On a graph with anchored hours, make `graph_chain_leaves` unreadable (for example, drop the table in a scratch store), then run `substrate evidence <graph_id>`.
**Expected:** The bundle is written, the app-events chain reads unverifiable, and the command exits 1 with "does not attest to that chain" (`cli/src/index.ts:506-512`).
**Why human:** No test exercises this exit. It needs a store.

## Open Decisions

| ID | Decision | State |
| -- | -------- | ----- |
| Criterion 2 reading | Commitment reading (one hour-wide `heads_root` commits each graph head) versus the literal reading (a head value per graph in the anchor). | Carried as PASSED (override), accepted by the owner on 2026-11-02 per the prior record. Acceptance was not re-obtained here. |
| G1 remedy and scope | Whether removal of a whole anchored hour from all three stores is in threat model, and how `verifyGraph` should learn a graph's anchored hours when those stores can be erased. Options are for the owner and the design; this verifier does not choose one. | **Open.** Blocks criterion 1 as gaps_found. |
| D73-05 boot DDL (W3) | Whether `graph_chain_leaves` DDL on every boot is acceptable, D73-05 is amended, or the DDL moves out of boot. Existing `agent_events` and `event_ingest` DDL already runs on boot. | **Open** (human item 3). |
| Adoption and alarm guard (W2) | Whether adoption and alarm paths check `heads_root` before writing leaves. STATE.md:778 records the owner decision as NOT FIXED. | **Open.** |
| Payload test coverage (W4) | Whether a verdict-level test edits the `payload` column. | **Open.** Test gap, no code change required. |
| HARD-S3 scheduled verification | Whether the hourly anchor job's `root-mismatch` alarm meets "scheduled verification ... report the first bad position", or a scheduled per-graph verify is required. | **Open** (owner). |
| Bundle attestation (W5) | Whether the app-events chain in the evidence bundle should fold in hour trust. | **Open** (design choice). The CLI exit (`index.ts:529-536`) already covers unverified hours. |

## Override provenance

Carried from the prior 73-VERIFICATION.md (on the integration tree at 749e97e3), which records `accepted_by: owner`, `accepted_at: 2026-11-02`. That acceptance is not found in `.planning/*.md` or the phase directories, so this verifier relied on the recorded acceptance and did not re-obtain it. If the owner's acceptance does not stand, remove the override and criterion 2 becomes FAILED.

## Gaps Summary

**G1. Whole anchored hour removal is not detected (Blocker, criterion 1, failed).** Traced in "G1 trace" above. The hour set comes from three mutable tables, and the anchors table is not read per graph. The enumerated tests keep the leaves, so they cannot show this. Confirm on a scratch store. The remedy is an owner and design decision (Open Decisions).

**W2. Adoption and alarm paths lack the heads-root guard (Warning, open).** `checkAdopt` compares root and count only (`anchor.ts:324-327`). The adopt and alarm branches then write `readHourHeads` leaves and the anchors row without comparing `headsRoot` with the memo's `heads_root` (`:670`, `:693`). Verification still fails closed through `stored-leaves-mismatch` (`service.ts:8332`). [INFERENCE] If an earlier send wrote leaves and its row write was lost (`anchor.ts:822` comment), an adopt or alarm run appends conflicting leaves for the same `seq`. `orderedLeaves` then returns null (`event.ts:387-398`), so the hour loses trust. This is fail-closed but can block a valid proof.

**W3. Leaves DDL runs on every boot, and its append-mode check is incomplete (Warning, open decision).** `greptime.migrate` (`:967`) runs `CREATE TABLE IF NOT EXISTS "graph_chain_leaves" ... WITH ('append_mode' = 'true')` at `greptime.ts:1024` on each start (`index.ts:121`). D73-05 (73-CONTEXT.md:29) says no production DDL is applied. The same pattern already runs on boot for other tables. The boot append-mode confirmation covers `agent_events` and `event_ingest` (`greptime.ts:1090-1108`) and not `graph_chain_leaves`. The comment at `:1020-1021` says a table without append_mode would merge rows that share a period and timestamp. Every leaf of an hour shares its `period_start`, so a non-append table would lose leaves without a boot warning. Verification would fail closed (`orderedLeaves`), but the warning would not appear.

**W4. Payload edit tested only through `summary` (Warning).** `service.test.ts:5261` and `:5459` change `summary`, and `:5387` rewrites `summary`. The code path is the same, since `eventHash` covers the whole event (`event.ts:36-38`) and `trustHour` rehashes the full row (`service.ts:8349-8350`). No test changes `payload` at verdict level. Recommended: add a payload-column case once G1's test exists. No code change is needed for W4.

**W5. Evidence bundle attests the app chain from the chain verdict only (Warning, new).** `appChainOf` (`observe.ts:1045-1058`) reads `verdict.chain` and `hours_unreadable`, not the hour trust. A tail truncation that leaves an intact prefix (`chain.ok` true) gives `chains.app_events` `state: verified, ok: true`. At the same time, the anchors list marks the affected hour `unverified` (`anchorEvidenceOf`, `observe.ts:1062-1068`). `substrate evidence` still exits 1 for that case (`cli/src/index.ts:529-536`), so the CLI reports it. A consumer reading only the JSON would see "verified". An edited payload is caught by the chain check (`verifyChain`, since the hash covers the payload), so the app chain reads broken there. No test covers the tail-truncation bundle.

**W6. Documentation contradicts the code on `ok` (Warning, new).** `docs/greptime-ledger.md:575` says `budget exhausted` and `store-failed` leave `ok` unchanged. Since `d8512fbb`, `ok` requires `leavesUnreadable === null` (`service.ts:8243`), and the tests assert `ok` false (`service.test.ts:5497`, `:5512`). The same statement in `73-01-SUMMARY.md` is stale. The docs must be corrected to the code.

**I1. `trusted` ignores rows with no ingest record, while `ok` counts them (Info).** `trusted` (`service.ts:8268`) does not include `uncovered`. `ok` (`:8243`) does. [INFERENCE] A row with no ingest record in a graph with anchored hours could give `ok` false and `trusted` true. Consider whether `trusted` should include `uncovered`.

**I2. A rewrite that also changes event ids reports first-missing (Info).** `event.ts:465` reports the first old id as missing, not first differing, since the rewrite changes the ids. The verdict still fails. Tests use unchanged ids (`service.test.ts:5387`).

**I3. No verdict-level reorder test (Info).** Reorder is caught at unit level (`event.test.ts:160`) and by the chain check (`event.ts:480-494`). Verdict tests cover read order only (`service.test.ts:5415-5421`).

**I4. The saved head is a fixture, not a stored snapshot (Info, accepted).** The fixture builds the honest memo and leaves before each change (`service.test.ts:5183-5201`). This is the accepted harness (D73-07).

**I5. Correction to the prior record.** REQUIREMENTS.md maps HARD-S3 to phase 73 (lines 114, 135). The prior record said there were no phase 73 rows.

**Residuals (from the PLAN SUMMARY, unchanged):** the leaves table has no primary key, so duplicates collapse on read; a leaves write that fails after a send can lead to a resend on the next run (same exposure as `insertAnchor`); the leaves read is bounded to the hour but covers every graph in it; events without a `graph_id` have no head and stay in the hour root only.

## Self-check

`gsd_run query verification.status <phase dir> --pick status` run from the worktree (see the final tool output).

---

_Verified: 2026-11-02T18:33:35Z_
_Verifier: Claude (gsd-verifier)_
