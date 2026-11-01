---
phase: 73-ledger-tamper-evidence
verified: 2026-11-01
status: human_needed
score: 2 of 2 in-repo success criteria MET; live devnet anchoring and live GreptimeDB behaviour remain human-verified (D73-05)
verified_on: branch gsd/v18-p73-ledger-tamper at 299df7cb (base origin/main b1b42f92); files read, nothing run by the author of this record
---

# 73-VERIFICATION: Ledger tamper evidence

## Gates

Not run by the author of this record. The orchestrator's brief states that tsc, Biome, the full `bun test` suite, the Python suites, `check:phase-close` and the audit gate were run serially on this branch. ROADMAP.md line 1268 records those results (11,380 pass, 2 skip, 0 fail; Python 330 pass). This record does not restate them as its own evidence. Its evidence is file paths, line numbers and test titles read at 299df7cb.

## Success criteria

ROADMAP phase 73, success criteria 1 and 2 (ROADMAP.md lines 1274 and 1275).

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Tests save the graph's head before the change, then edit a stored payload, delete a middle event, truncate the last events, and rewrite the whole chain with recalculated `hash` and `prev`. Each is compared with that saved head: the edits and the rewrite report the first differing event id, and truncation reports the first missing event id. | PASS | Comparison: `packages/mcp-server/src/event.ts:399-427` (`compareToAnchoredHead`), trust path `packages/mcp-server/src/service.ts:7610-7700` (`trustHour`). Tests, all in `packages/mcp-server/src/service.test.ts` under "heads trust (D73-03, D73-04)": fixture `v2World` at 5168 builds the memo and stored leaves before any mutation; "an edited payload parts the chain at that event: first_differing_event_id" at 5247; "a deleted middle event is first_missing_event_id" at 5259; "truncated last events are first_missing_event_id" at 5275; "a full rewrite with every hash and prev recalculated parts at the first event" at 5288 (expects `first_differing_event_id` = event 1 and `chain` still `ok`). Unit level, `packages/mcp-server/src/event.test.ts` 270-330: middle delete, truncated tail, edited payload, stored-hash mismatch, extra event, duplicate id, and stored-leaves edit. See the notes below on what the service-level edit actually changes. |
| 2 | The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof criterion 1 compares against; a head recomputed from the stored rows is never used as the proof. | PASS (reading to confirm; see note A) | Writer: `packages/mcp-server/src/anchor.ts:396-437` (`buildGraphHeads`), `:455-467` (`readHourHeads`), `:473-476` (`anchorMemo` emits v2 when a graph owns an event), `:479-482` (`storeAnchor` writes leaves, then the anchors row). Memo: `packages/ledger/src/memo.ts:42` (`formatMemoV2`), `:61` (`parseMemo` accepts v1 and v2, rejects others). Record and root: `packages/ledger/src/heads.ts:25` (`headRecordHash`), `:59` (`headsRoot`, RFC 6962 over records sorted by (graph, session)). Trust: `service.ts:7653-7655` rebuilds records from stored leaves and requires `headsRoot(records) === on-chain heads_root`; `:7682` compares each pair against that verified record. Only the on-chain root is trusted; the recomputed records are bound to it before use. Tests: `anchor.test.ts` 1091 (permuted read order gives identical heads and leaves), 1118 (v2 memo carries the heads root and three leaves are written), 1132 (no-graph hour anchors v1 and writes no leaves), 1142 (a leaves write failure stops the anchor and no row is written); `memo.test.ts` 72-110 (v2 round-trip, malformed v2 refused); `heads.test.ts` 18-93 (hash, order independence, refusal of bad inputs); `service.test.ts` 5232 (honest two-session hour trusted), 5309 (same verdict for three read orders), 5325 (unanchored hour untrusted), 5333 (v1-only hour untrusted, `ok` unchanged), 5343 (stored leaves no longer reproduce the on-chain root, reported as `stored-leaves-mismatch`). |

## Notes on the criteria

**Note A (criterion 2, reading to confirm).** The on-chain memo carries only the 64-hex `heads_root`, a commitment over the per-(graph, session) head records. It does not carry each graph's head id and hash in plain form. Those values sit in the `graph_chain_leaves` table (`greptime.ts:1024` DDL, `:1803` writer, `:1820` reader) and are trusted only after they reproduce the on-chain root. I read "recorded in the hourly anchor" as recorded by commitment, which is what D73-01 and D73-04 specify. The orchestrator should confirm that reading before the ROADMAP item is closed.

**Note B (criterion 1, saved head is implicit).** No test has a separate "save head" step. `v2World` builds the memo, root and stored leaves from the honest hour before any mutation. Each case then overrides only `readEvents`, `hourLeaves` or `hourChainLeaves`, and `hourChainLeaves` is never overridden. The saved head is therefore the fixture state captured before the change, which satisfies the criterion in effect.

**Note C (criterion 1, which field is edited).** The service-level edit test at `service.test.ts:5247-5257` names an "edited payload" but changes the `summary` column (`row.summary = "edited"`). `payload` is hashed like every other field (`types.ts:121-137`; `event.ts:35-37`, `eventHash` over the canonical JSON of all fields except `hash`), so a payload edit takes the same path. No verifyGraph-level test edits the `payload` column itself. The unit test at `event.test.ts:314` covers the edited-content case by changing the recomputed hash.

## Trust rule, as implemented

- An hour is trusted only if it is anchored with a v2 memo, and the stored leaves of every graph in the hour reproduce that memo's `heads_root` (`service.ts:7653-7655`).
- Only then is each (graph, session) pair of the graph being verified compared against its own record (`service.ts:7682`).
- `trusted` at the verdict level (`service.ts:7590`) needs every anchored hour trusted, and rows in the graph, and no read failure.
- `ok` is false on any contradiction with an anchored head, including a full rewrite that passes the local `verifyChain` (D73-03; `docs/greptime-ledger.md`, "Trust").

## Human verification

These items do not change either criterion's status. Each needs an operator, and agents must not run them.

1. **Live devnet anchoring of a v2 memo (D73-05).** Send one real v2 memo for a closed hour through the anchor CLI, read it back from the chain, and confirm that its `heads_root` equals the root computed from the stored rows. Confirm that the memo is the one written to the anchors row.
2. **Live adoption path.** After a lost row write on devnet, re-run the anchor and confirm the adopted row's leaves reproduce the on-chain `heads_root` (see deviation 1 below, which this check would have to cover).
3. **Production DDL at boot (see deviation 2).** After the first boot of this build, confirm that `graph_chain_leaves` exists in production GreptimeDB with `append_mode = 'true'`, and that its columns and types match `greptime.ts:1024`.
4. **Live GreptimeDB behaviour.** The writer, reader, and `graphChainLeafHours` SQL (`greptime.ts:1803-1845`) are tested only against the fake Greptime. Check on a scratch instance: the `period_start` equality match on a TIMESTAMP index, `seq` as BIGINT, the `DISTINCT` query, and the duplicate rows a retried insert leaves (no primary key).
5. **Live verify on a real hour.** Run `substrate verify <graph_id>` on a graph with an anchored v2 hour and confirm `trusted: true`. On a scratch copy, edit one stored payload and confirm `first_differing_event_id`, and delete one row and confirm `first_missing_event_id`.

## Deviations and gaps found

1. **The anchor adoption path does not check the on-chain heads root (not a criterion failure; fix before human item 2).** `checkAdopt` (`anchor.ts:324-326`) matches only root and count. Its caller then stores leaves recomputed from the current rows, with the on-chain v2 memo, at `anchor.ts:688-698`, without comparing `headsRootHex`. The only on-chain heads comparison in the anchor writer is the send-path read-back at `anchor.ts:811`. Verification still fails closed: leaves that do not reproduce the on-chain root give `stored-leaves-mismatch` (`service.ts:7654`, test `service.test.ts:5343`). But the writer stores a row whose leaves it has not checked against the anchor. `reanchor.ts:627` and `:698` already refuse a memo whose heads root differs from the saved one. No anchor test covers an adoption with differing heads. Recommended fix: apply the same refusal in the adopt and alarm paths.
2. **Production DDL runs on boot, which D73-05 does not reflect.** The SUMMARY and D73-05 say no production DDL was run. That holds for the agents, but the code path does run it. `index.ts:120` calls `substrate.migrate()` on every start. `service.ts:1972` calls `greptime.migrate()`. `greptime.ts:1024` runs `CREATE TABLE IF NOT EXISTS "graph_chain_leaves"`, and the `migrate` comment says it is "Safe to run on every boot". So deploying this build creates the production table with no separate operator step. The operator gate in D73-05 is not enforced in code. The operator should decide whether to accept this, and human item 3 should be checked after the first boot.
3. **SUMMARY predates the branch's later fixes.** `73-01-SUMMARY.md` describes U1 to U4. The branch has 14 commits past `b1b42f92`, including `4942b159`, `8d98932d`, `7441a02a` and `caabf61b`, which change behaviour the SUMMARY describes. ROADMAP.md line 1268 lists those fixes. The SUMMARY's Residuals and Decisions sections are not current; this record uses the code, not the SUMMARY, as its source.
4. **Residuals carried from the SUMMARY (not criteria failures).** The leaves table has no primary key, so duplicates collapse only on read. A leaves write that fails after the send can lead to a resend on a later run, which is the same exposure `insertAnchor` has today. The leaves read is bounded to the hour but covers every graph in it. Events with no `graph_id` have no head and are covered only by the hour root.
5. **No end-to-end test of the loop.** No test calls `substrate verify` through the real anchor writer and reader. The fixture builds the memo with `buildGraphHeads`, and the writer's own `anchor.test.ts` cases use fake stores.

## Operator-gated

- Live devnet sends and anchor funding (D73-05).
- Production DDL, which runs at boot (deviation 2).
- Re-anchoring existing v1 hours, which would be a live send (`docs/runbooks/devnet-reset-and-reanchor.md`). Until then, v1 hours stay `trusted: false` with the reason shown.

## Planning records

This record does not edit `STATE.md` or `ROADMAP.md`. The orchestrator updates them after the return.
