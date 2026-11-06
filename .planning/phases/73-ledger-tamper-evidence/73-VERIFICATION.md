---
phase: 73-ledger-tamper-evidence
verified: 2026-11-06T06:11:39Z
status: human_needed
score: 8/8 must-haves verified (T2 counted as PASSED override; T3 and T7 at df31c749: the cited titles pass in r43; the T7 retired-key and incomplete-read sub-cases are untested)
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", "docs/greptime-ledger.md", "packages/cli/src/capsule.ts", "packages/cli/src/index.ts", "packages/ledger/src/heads.test.ts", "packages/ledger/src/heads.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/mcp-server/src/anchor-verify-deps.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/checkpoint-verify.test.ts", "packages/mcp-server/src/corpus/slo.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index-store.test.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/memory-policy.test.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/memory-record.ts", "packages/mcp-server/src/memory-retain.ts", "packages/mcp-server/src/memory-verify.ts", "packages/mcp-server/src/memory-write.test.ts", "packages/mcp-server/src/memory-write.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.ts", "packages/mcp-server/src/session-rollback.ts", "packages/mcp-server/src/silent-failures.ts", "packages/mcp-server/src/skills/propose.test.ts", "packages/mcp-server/src/skills/propose.ts", "packages/mcp-server/src/types.ts", "packages/observability/src/instruments.ts"]
covered_digest: "v3:sha256:f27a018564dd3b27f4d986b092664d626b8e8d094dfaf251b7b448d941932f4a"
behavior_unverified: 2
overrides_applied: 1
overrides:
  - must_have: "The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof criterion 1 compares against; a head recomputed from the stored rows is never the proof."
    reason: "Owner accepted the commitment reading on 2026-11-02: each graph head is committed on chain by the memo v2 heads_root and recovered only through stored leaves that reproduce it. Carried from the prior record; acceptance not re-obtained here. This override covers the commitment reading only. It does not cover the write-path items W-L3b and W-K3 below."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: 8/8 (T2 counted as PASSED override)
  previous_verified: 2026-11-06T04:09:31Z
  previous_scope: "worktree /root/src/worktrees/as-gsd-v18-all, HEAD 4637a9b7 (clean). Range 5e304ef8..4637a9b7. Covered paths changed in range: packages/mcp-server/src/skills/propose.ts (e2e4cba4). Cited and added to covered_files in this pass: packages/mcp-server/src/skills/propose.test.ts (e2e4cba4), packages/cli/src/index.ts (4ac770af). Changes: mirrorOriginUrl throws ProposeFailed when the mirror config cannot be read (fail closed; owner decision 4, 2026-11-06), with tests; the reportSilent import is removed from propose.ts; cmdEmit writes one stderr line when a dropped emit has no answer and the spool is off. No chain write, verify, memo or anchor logic changed."
  scope: "worktree /root/src/worktrees/as-gsd-v18-all, HEAD df31c749 (clean). Range 4637a9b7..df31c749. Covered paths changed in range: packages/mcp-server/src/service.ts and service.test.ts (3ce87f63: pointer candidacy by signer set, brief grant filter). Not covered, changed: packages/mcp-server/src/config.ts and config.test.ts (6245863c, event buffer and dead-letter guard). Other commits in range touch no covered path. The chain write, the memo, the heads comparison and the anchor sequence are unchanged; the verify-side pointer candidacy changed (see the df31c749 section)."
  gaps_closed:
    - "propose.ts mirror origin, fail-open: closed as a recorded fix. Owner decision 4 (2026-11-06): an unreadable mirror config refuses the skill proposal. Implemented in e2e4cba4 with its tests; not an override. See the 4637a9b7 section."
    - "Pointer candidacy for a rotated signer (3ce87f63): an hour whose only pointer was signed by a rotated key read as mismatch. Recorded as a fix with its test (the rotation title); not an override, not an owner decision. See the df31c749 section and owner item 9."
  gaps_remaining:
    - "W-L3: session_id and repo at the 512-unit cut (event.ts:436, :442 use normalizeKey). Owner item, open as listed."
    - "W-L4: branch, node_id and linear_identifier accept a lone surrogate on write, per the owner list. Code now refuses them (assertWriteTextFields, event.ts:311-321). Owner item, open as listed; the decision is not re-taken here."
    - "W-M1: a repo over the 512-unit cut in the memory plane. Code refuses it at write (memory-write.ts:495-496, index-store.ts:1175, :2448, :2505). memory-write.test.ts has no testcase in the r38 JUnit, so this is code-read only. Owner item, open as listed."
    - "W-L3b: branch (event.ts:443), node_id (:438) and linear_identifier (:439) take the 512-unit cut without a dangling-high trim. Owner item, open as listed. Also the pre-existing row repair decision."
    - "W-K1: pre-existing unnormalised reads and writes. Session_id reads are normalised (checkpoint lookup, anchor-verify-deps.ts). Owner item, open as listed."
    - "W-K3: Postgres graph_register repo write (index-store.ts:1175, then raw write). Narrowed, not closed. Not probed. Owner item, open as listed."
    - "HARD-S3: scope owner item. Open as listed."
    - "N6, N8, W3, W4 (label), W5: fix or accept each open gap in the 73 record. Owner items, open as listed (STATE.md Needs-Human table, row 73). W-N8 is the budget measurement in human verification item 5."
    - "Stored graph ids over 512 bytes, containing NUL, or with a lone surrogate: operator scan, then owner repair decision. Blocks live anchoring on such a store. Open as listed."
    - "O-S1: pre-change straddled rows. docs/greptime-ledger.md records the 2026-11-04 owner decision to leave them (line 389). The live count is not run. Stays open."
    - "Q8 and N5: no pointer, and RPC history depth. Accepted limits; stay open as recorded."
  gaps_new: ["T7 candidacy wording: 3ce87f63 admits signer-set keys where the record's N3 wording says job-key only. Owner item 9, open, not decided. Its fail-closed effects are not tested: an out-of-window pointer of a named retired key fails its hour; a non-job-key pointer under an incomplete rotation read makes the graph unreadable."]
  regressions: []
human_verification:
  - test: "Devnet 0-lamport pointer probe: send a 0-lamport pointer to an unfunded index address and record the refusal text"
    expected: "The refusal text confirms or refutes POINTER_REFUSED_RE (anchor.ts:91) and whether the funded path is needed. The narrowed pattern rests on the local solana-cli text; the full devnet line is [INFERENCE] until this runs."
    why_human: "Operator item. Needs devnet, a funded test key and a live send. The verifier does not send transactions."
  - test: "Live devnet send of one pointer whose graph id is 512 UTF-8 bytes, read back with transactionMemo"
    expected: "The transaction serialises within the 1,232-byte limit, and the measured size replaces the hand-counted overhead (memo.test.ts)."
    why_human: "Operator item. Needs a live send."
  - test: "Scan the live agent_events store: graph_id over 512 bytes, any graph_id containing a NUL byte, any graph_id, summary, session_id, repo, branch, node_id or linear_identifier ending in U+FFFD at 512 units, and v2 or v3 memos in the anchor listings"
    expected: "Zero rows, or an owner decision on each. The docs detection SQL is NOT RUN; verify character_length and substring against the store first."
    why_human: "Operator item. Needs read access to the live store."
  - test: "RPC history depth for index addresses (N5): oldest signature still listed on a job-key address and on an index address"
    expected: "The depth is known. Accepted limit (N5) stays as recorded; the depth is still unmeasured."
    why_human: "Needs live RPC."
  - test: "Budget measurement for a year-old graph (W-N8): time verifyGraph against the 30 s default"
    expected: "A measured time; the default changes only if it exceeds 30 s."
    why_human: "Needs live data at realistic size."
  - test: "Owner decision on stored graph ids over 512 bytes or containing NUL, and on pre-fix rows with a lone surrogate in those fields (no data repair decided)"
    expected: "A recorded decision. Until then a live anchor run against such rows halts at the first such hour."
    why_human: "Data-repair policy. Owner call."
  - test: "O-S1 sizing: run the live scan for straddled rows in all five fields and record the counts against the 2026-11-04 decision in docs/greptime-ledger.md"
    expected: "A count per field."
    why_human: "Operator item. Needs read access to the live store."
  - test: "W-L3b owner decision: decide whether branch, node_id and linear_identifier take the dangling-high trim, or record the fail-closed verdict as accepted"
    expected: "A recorded decision; if trimmed, the change is listed in the W-L3b entry."
    why_human: "Stored-form and read-key change. Owner call."
  - test: "Owner decision on pointer candidacy: confirm the T7 wording (job key only, per the record) or direct a revert of 3ce87f63's signer-set candidacy, and decide on its two fail-closed effects"
    expected: "A recorded decision. Until then T7 and T3 stand as code-read at df31c749, and the two effects stay untested."
    why_human: "Candidacy rule and availability effects. Owner call; not decided here."
---

# Phase 73: Ledger tamper evidence Verification Report

**Phase Goal:** A rewrite, reorder, deletion or tail truncation of the event ledger is detected by recomputing the chain from stored rows, and the verified head is anchored. Criterion 1 is proven by tests against a head saved before the change. Criterion 2 requires each graph's chain head to be recorded in the hourly anchor, and that recorded head is the only trusted proof.
**Verified:** 2026-11-06T06:11:39Z
**Status:** human_needed
**Re-verification:** Yes, after the 4637a9b7 record. Scope is HEAD df31c749. Prior status human_needed, score 8/8. Covered code changed since 4637a9b7: `service.ts` and `service.test.ts` (3ce87f63: pointer candidacy, brief grant filter). The service.ts line numbers in the T and R tables are at 4637a9b7 except the rows rewritten at df31c749; the df31c749 numbers are in the section below.

Evidence base: gate r38, `/root/src/worktrees/backups/gate-r38-junit.xml` (run on 66fa97bd). Its one failure is the `repository ratchet` check ("the ratchet is tight: no source counter sits below its baseline", scripts/code-ratchet.test.ts), which head 5e304ef8 addresses (`as_unknown_as` ratchet lowered to 22). Its two skips are outside this phase (redact.test.ts, cache-conformance.test.ts). Every test title cited in the 5e304ef8 sections is a passing testcase in that file and a `test(...)` or `describe(...)` title in source. The three `propose.test.ts` titles added by e2e4cba4 are not in that file (r38 ran before the commit); they are cited from source only, in the 4637a9b7 section. The gate r42 on 4637a9b7 is in progress and writes `/root/src/worktrees/backups/gate-r42-junit.xml`; this record claims no pass count from it. No live or operator check was run, and this pass ran no tests.

The df31c749 pass (section below) cites no run. The run of record for df31c749 is `/root/src/worktrees/backups/gate-r43-junit.xml`; it passes (12,332 pass, 0 fail, 2 skip). Titles first run on the df31c749 code (the rotation title, and the T3 and T7 titles on the changed pointer path) are code-read; their titles pass in r43.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| T1 | SC1: an edited payload, a deleted middle event, truncated last events and a full rewrite are each compared with the saved head; the first differing or first missing id is named | ✓ VERIFIED | r38 (classname "heads trust (D73-03, D73-04) > verifyGraph hour report", service.test.ts:5413 and :4296): "an edited payload parts the chain at that event: first_differing_event_id"; "a deleted middle event is first_missing_event_id, and the verdict fails"; "truncated last events are first_missing_event_id at the first one gone, and the verdict fails"; "a full rewrite with every hash and prev recalculated parts at the first event, and the verdict fails"; "sessions verify one by one, and the verdict is the same for every read order". Verdict code unchanged: `verifyGraph` service.ts:8081, `hourReport` :8185, `trustHour` :8578; `verifyChain` event.ts:624 (body unchanged). |
| T2 | SC2: each graph's chain head is recorded in the hourly anchor and the recorded head is the trusted proof | ✓ PASSED (override) | Memo v2 `heads_root`: `packages/ledger/src/memo.ts:11-12` (`MEMO_PREFIX_V2`, `MEMO_V2_RE`, now module-private), `formatMemoV2` (memo.ts:42) used by `anchor.ts:501`. Leaves before the row: `storeAnchor` at `anchor.ts:505-507` (body unchanged; anchor.ts changed only by export removal). r38: "anchored happy path: chain ok, hour anchored, ok true" (service.test.ts); `anchor.test.ts`, `memo.test.ts` and `heads.test.ts` cited titles are passing in r38. Owner override 2026-11-02, commitment reading only; carried, acceptance not re-obtained here. |
| T3 | G1: an anchored hour removed from `agent_events`, `event_ingest` and `graph_chain_leaves` fails the verdict and is named | ✓ VERIFIED for pointer-listed hours (Q8 and N5 accepted limits). The pointer path changed at df31c749, so this row's behaviour at that head is code-read only (see the df31c749 section). | r38 (classname "v3 pointers: each hour of a graph is named by its own pointer (design 5)", service.test.ts:5899, at 66fa97bd): "G1Probe, variant 1a: a trailing hour whose rows, ingest and leaves are gone fails the verdict naming it, though its anchors row is kept"; "G1Probe, variant 1b: the same with its anchors row removed too: the verdict still names the hour, through its pointer"; "with no pointer either, a graph whose only hour is gone has no events on chain: ok, untrusted, no events (design 6, row 6)". Both 1a and 1b use job-key pointers. |
| T4 | The hourly job sends every closed hour's pointers for every graph id the write path accepts, so the job does not halt on a valid event | ✓ VERIFIED | Graph id refusals: NUL `graph_id_nul` event.ts:236; over-cap `graph_id_too_long` event.ts:226; `normalizeGraphId` event.ts:331. `appendChained` (service.ts:3165) runs `assertWriteTextFields` (:3167) and `normalizeGraphId` (:3169) before the replay lookup (:3176) and the chain tip read (:3195). Handoff runs `normalizeGraphId` at service.ts:7732 and `assertWriteTextFields` at :7733, before `placeOf` (:7741) and the tip read (:7750). All at df31c749. r38: "refuses a NUL in the graph id before it reads the chain tip" (classname "emit", service.test.ts); "refuses a lone surrogate in the summary before it reads the chain tip" (service.test.ts); "refuses a lone surrogate in the handoff summary before it reads the chain tip" (service.test.ts); "refuses a lone high surrogate in each of the six fields, by name" (event.test.ts). |
| T5 | N1/W2: the hour is sent, then pointers, then the row; a pointer failure stores no row; an unanchored mismatch stores no row | ✓ VERIFIED | `anchor.ts` anchor sequence unchanged in this range (anchor.ts changed only by export removal, b8cbdeac). r38: "unanchored past 3 h: no row, fails naming the hour" (service.test.ts); `anchor.test.ts` titles cited in this record are passing. |
| T6 | N2: the adoption window covers the lookback's newer transactions | ✓ VERIFIED | `ADOPT_LOOKBACK_HOURS = 168` at `anchor.ts:94`, unchanged in value; the change in range is the export keyword only. `anchor-verify-deps.test.ts` is in the covered set; no cited title in this record depends on a changed line. |
| T7 | N3: verify counts only job-key pointers that succeeded; other entries are ignored; a job-key pointer naming another hour still fails | ✓ VERIFIED (verify side), code-read at df31c749. The candidacy rule is wider than this wording since 3ce87f63 (signer-set keys in their window). Owner item 9 asks the owner to confirm the wording. | r38 (classname "v3 pointers: each hour of a graph is named by its own pointer (design 5)", service.test.ts:5899, at 66fa97bd): "a pointer the job key did not sign, or that failed on chain, is ignored: not a mismatch, and the hour has no pointer of its own" (:6009); "a pointer signed by another key is ignored: not a mismatch, and the hour has no pointer of its own" (:6021); "a foreign-payer pointer does not fail a valid hour: the job key's own pointer verifies it" (:6047); "an errored pointer does not fail a valid hour: the job key's own pointer verifies it" (:6056); "a job-key pointer whose hour transaction names another hour is still a mismatch of its hour" (:6075). At df31c749 (code-read): the four "ignored" titles still ignore, because their payers are outside the signer set (no operator surfaces, so no rotation read; bootstrap set is the job key) or they fail the first gate; the mismatch title takes the job-key branch. New at df31c749, not in r38: "a rotation keeps an hour anchored by its old-key pointer: the old key is still in the signer set and was valid at the pointer's block time" (:6030). Not tested: a named retired key's pointer outside its window (fails its hour), and a non-job-key pointer under an incomplete rotation read (unverified). Anchor-side adoption pointer filter still untested: W-N3c. |
| T8 | Refused `SOLANA_RPC_URL`: no chain read, `ok` false, `trusted` false, a named reason | ✓ VERIFIED | Guard at `service.ts:8157-8160` (`this.config.solana.problem !== null` returns before `hourReport` at :8161) at df31c749; body unchanged, lines moved by +27 (3ce87f63). r38: "a refused SOLANA_RPC_URL makes no chain read and fails closed, naming the devnet guard" (service.test.ts, verifyGraph hour report). |

**Score:** 8/8 truths verified (T2 counted as PASSED override). Behavior unverified: 2 (T3 and T7: the pointer path changed at df31c749; the cited titles ran in r38 at 66fa97bd, before that change; the cited titles pass in r43; the T7 retired-key and incomplete-read sub-cases are untested). Presence-only truths: none.

### Re-verification of the prior record's checks

| #  | Check | Status | Evidence |
| -- | ----- | ------ | -------- |
| R1 | Six-field refusal: a lone surrogate in summary, session_id, repo, branch, node_id or linear_identifier is refused at write by name, before any hash or store write | ✓ VERIFIED | `assertWriteTextFields` event.ts:311-321 (six `refuseLoneSurrogate` calls at :314-319, then `assertRepoLength` at :320). Called first in `appendChained` (service.ts:3152) and in `normalizeEvent` (event.ts:427). r38: "refuses a lone high surrogate in the branch, by name, with its code unit", "... in the node id, by name, with its code unit", "... in the linear identifier, by name, with its code unit", "... in the repo, by name, with its code unit", "... in the session id, by name, with its code unit" (event.test.ts, classname "lone surrogates in the other write text fields"); "refuses a lone low surrogate in the summary, by name". |
| R2 | The refusal runs before the sessioned chain-tip read, the replay lookup, the buffer and the append-mode probe | ✓ VERIFIED | `appendChained` service.ts:3165 at df31c749 (assert :3167, graph id :3169, replay lookup from :3176; 4637a9b7 numbering was :3150-3160). `append` (service.ts:3084) routes to `appendChained` unchanged (:3093). Handoff refuses before `placeOf` and the tip read (:7732-7750 at df31c749). |
| R3 | normalizeKey read and write parity for the LEDGER (session_id and repo) | ✓ VERIFIED | Write: `event.ts:436` (session_id), `:442` (repo). Reads at df31c749: `service.ts:3088` (append), `:7742` (handoff). Checkpoint lookup `anchor-verify-deps.ts:217` (normalizeKey, unchanged). r38: "a checkpoint written under a straddling session id is found by that id and verifies as anchored" (checkpoint-verify.test.ts). |
| R4 | A session_id that straddles 512 units round-trips: stored, looked up and read back in one form | ✓ VERIFIED (carried) | r38: "a session id straddling the cap is stored, looked up and read back in one form"; "a repo longer than the cap is refused at write, naming the rule, and nothing is stored" (service.test.ts). |
| R5 | 4b84e50c regression test: a row with repo `owner/name` plus a lone high surrogate is not visible to a caller granted `owner/name`; a scope spelled with a surrogate keeps it | ✓ VERIFIED (carried) | r38: "a repo keeps its exact spelling for visibility: a lone high surrogate is not trimmed into the granted repo" (memory-policy.test.ts). `memory-policy.ts` changed in range only by export removal (b8cbdeac). |

## Re-audit of the chain and anchor paths at 5e304ef8 (prior pass)

**Scope check.** `git diff --name-only a46d42c3..5e304ef8` intersected with the covered paths gives 18 files: `docs/greptime-ledger.md`, `packages/cli/src/capsule.ts`, `packages/ledger/src/memo.ts`, `packages/mcp-server/src/{anchor-verify-deps,anchor,brief,event,greptime,index-store,memory-policy,memory-record,memory-retain,memory-verify,memory-write,service,session-context,session-rollback,types}.ts`. Commits in range that touch them: `66fa97bd`, `d9d0a401`, `b8cbdeac` (export keyword removal), `e62bc17b` (comments and `reportSilent` sites in `event.ts`, `greptime.ts`, `index-store.ts`, `memory-write.ts`), `a2176f96` (`memory-retain.ts`), `0947001e` (`service.ts`, phase 63), `5041193f` (`docs/greptime-ledger.md`). Changed paths outside the covered set, and not cited by this record, are not evaluated here: `cache.ts` (f1266a9c), `server.ts` and `cli/src/index.ts` (14ac787a), `index-sweep.ts` (a2176f96).

**Hunk classification.** The non-export, non-comment hunks were isolated by comparing each removed line with the added line after the `export` keyword is stripped. Results:

1. **Export keyword removals (b8cbdeac, d9d0a401, 66fa97bd).** About 158 declarations in the covered files lost `export`. No behaviour change. A search of `packages/` for import statements and re-exports of each removed name found no importer, so no compile break is visible from the covered files. Gate r39 remains the check for compilation.
2. **Comment lines.** `event.ts:77` (one line, in `parseStoredLine`); `greptime.ts:1998` and `:2236`; `index-store.ts:2785`. The `event.ts:77` insertion moves every later `event.ts` line by +1. The line numbers in this record are already at 5e304ef8.
3. **`reportSilent` catch sites (e62bc17b, `memory-write.ts`).** Import at :49; `memory-write.finish-orphan` at :799 and `memory-write.verify-source` at :857-860. Both keep the value the old catch returned (`undefined`, and `false`). Control flow unchanged. Not on the chain write, verify or anchor path. `memory-write.ts` repo-cap refusal is now at :495-496 (was :494), because of the import line.
4. **`retainDocumentId` (a2176f96, `memory-retain.ts:127`).** Parameter narrowed from `MemoryEntry` to `{ scope, kind, subject? }`, the body unchanged, and the function exported for `index-sweep.ts`. It derives the document id for the memory plane. Not on the chain write, verify or anchor path. W-M1 and W-K1 wording is unaffected.
5. **`manifestCommit` (0947001e, `service.ts:6421`).** Now `(await this.corpusStore()?.rowFor(repo, path)) ?? null`, passing the row; `docs-search.ts` applies the chunk `sha12` test to the row (phase 63 fix). Docs citation path only. Not on `appendChained` (:3150-3242), the verify path (`verifyGraph` :8081, `hourReport` :8185, `trustHour` :8578, the `headsRoot` comparison :8628, `compareToAnchoredHead` :8665), or the anchor path.
6. **`docs/greptime-ledger.md` (5041193f).** One bullet extended with the stderr report for dead-letter shutdown. Doc only. The 2026-11-04 decision in "Identifiers at the 512-unit cut" (line 370 onward; decision at line 389) is unchanged.

**Chain write (`appendChained`, `append`).** No hunk of `git diff a46d42c3..5e304ef8 -- packages/mcp-server/src/service.ts` falls in `append` (:3069) or `appendChained` (:3150-3242). **Verdict: the chain write is unchanged.**

**Verify path (`verifyGraph`, `hourReport`, `trustHour`, the head comparison, `verifyChain`, `compareToAnchoredHead`).** No service.ts hunk falls at or after :7760 except the handoff reads already classified in the prior record. `verifyChain` (event.ts:624), `compareToAnchoredHead` (event.ts:588) and `inChainOrder` (event.ts:470) are unchanged in body. **Verdict: the verify logic is unchanged.**

**Carried from the prior record. `sql()` reply parse (f0f3c04e, greptime.ts:872-930) is a read-path change on both the write and the verify path, and it is not "unchanged".** `sql()` feeds `lastHash` (greptime.ts:1489, the chain tip read in `appendChained` and handoff) and `readEvents` (greptime.ts:1678, read by `verifyGraph` service.ts:8091 and `graphTeachables`). Before: a JSON array or scalar body had `body.output` undefined, so it yielded zero rows; for the tip read that meant `prev = null`, which starts a second chain beside the stored one, and for verify an empty event set. After: a non-object body (array, scalar or null) throws `GreptimeError("greptime returned a non-object body")` (greptime.ts:923), and non-array `rows` throws. For the tip read the existing `tipError` path refuses the write (`appendChained` returns `stored: false`). For verify the error propagates, so no verdict is produced. This is fail-closed. Reachability against the real Greptime service is [INFERENCE] and was not probed. The cited r38 title "a reply that is not an object is refused with the module error, not a TypeError" (classname `sql`, greptime.test.ts:305) covers only the null body. The array-body and non-array-rows branches are code-read only. The same title also appears in linear.test.ts and the Notion and error-redaction suites; those do not cover this branch. **Not on the chain write or verify logic as such; it changes what they receive, and it does not change any truth.**

**Other carried changes.** Sync-lag hook in `emit()` (service.ts:3016-3019, 884e0753); `capsule.ts` payload copy (`capsule.ts:518`, 9b793653); `isPlanningUpdate` removal (a46d42c3, no remaining reference in `packages/`). Each was re-checked at this head: none is altered by the range.

**Test evidence.** Titles cited in this record are the r38 passing testcases listed above. `memory-write.test.ts` has no testcase in the r38 JUnit, so W-M1's refusal and memory-write behaviour are code-read only in this record.

**Sync-lag negative branch.** A note the server did not take leaves the gauge as it was: code-read at service.ts:3016 and tested at the slo level by "the sync lag is the lag of the newest docs.sync note the server took that carries a usable one, and any other note leaves it in place" (corpus/slo.test.ts). There is no named test of the emit gate's negative branch.

**Fingerprint.** `covered_files` and `covered_digest` are the output of `gsd_run query verification.fingerprint .planning/phases/73-ledger-tamper-evidence` with the 36 paths of the 5e304ef8 record plus `packages/mcp-server/src/skills/propose.test.ts` and `packages/cli/src/index.ts`, which the re-audit section below cites. Run from the worktree at 4637a9b7 (read-only). Value: `v3:sha256:ef7fa28bbc7e8d8824ca6a151085d045974a0cfa53bd976af20f880dc4cbc1b7`.

## Re-audit at 4637a9b7 (this pass): mirror origin fix and stderr emit line

**Scope check.** `git diff --name-only 5e304ef8..4637a9b7` lists the phase records and `.planning/ROADMAP.md` (none is a covered path) and three code paths: `packages/mcp-server/src/skills/propose.ts` and `propose.test.ts` (e2e4cba4), and `packages/cli/src/index.ts` (4ac770af). The covered path changed in the window is `propose.ts`. `propose.test.ts` and `index.ts` are not in the 5e304ef8 `covered_files`; they are added in this pass because this section cites them.

**Hunk classification.**
1. `propose.ts`, e2e4cba4. The `reportSilent` import is removed; the file has no other use. `mirrorOriginUrl` (:474-498) throws `ProposeFailed` on a config read failure, where it returned null. Its only caller in the proposal path is the origin check at :996-1001. The proposal path writes its own proposal ledger (`ledgerPath`), not `agent_events`, and `propose.ts` imports only Node modules and `redact.ts`, `types.ts` and `frontmatter.ts`. `proposeSkill` (service.ts:4937) is called by the MCP tool (mcp.ts:2068) and the HTTP route (server.ts:2168); no chain, verify, memo or anchor function calls it. Verdict: not on `appendChained` (:3150-3242), `verifyGraph`, `hourReport`, `trustHour` or the anchor path. The behaviour change is on the skills route only.
2. `propose.test.ts`, e2e4cba4. The fixture writes a readable config with no origin, and the mirror-origin tests listed below are added or renamed. Test only.
3. `packages/cli/src/index.ts`, 4ac770af. In `cmdEmit`, the `post("/events")` reply is kept. When it is null (no answer) and the spool is off, one stderr line names the event kind (JSON-quoted, first 64 units). The summary and payload are not printed, and the exit status is unchanged. The chain write is server-side (`POST /events`, `appendChained` at service.ts:3150). `index.ts` holds no chain, verify, memo or anchor code. Verdict: stderr only; no criterion is touched. No test cites the new line; it is code-read only.
4. `packages/cli/src/index.ts`, 14ac787a (before this window; the 5e304ef8 pass left it unevaluated, and it is evaluated here because the file is now covered). The CLI `handoff` exits 1 when the server refuses the packet and 0 when the server cannot be reached; `post` gains a comment. The refusal and the chain write are server-side: `handoff` refuses before `placeOf` and the tip read (service.ts:7705-7723). Verdict: client exit status only; no criterion is touched.

**Is `propose.ts` a covered file for any criterion?** No. None of T1-T8, R1-R5, or the W, N, HARD and operator items depends on `skills/propose.ts`. It is listed in `covered_files` because the record cites it for the mirror origin item, as in the prior record, and that item is now closed. It is a fingerprint entry only.

**Mirror origin fix, recorded (not an override).** Owner decision 4 of 2026-11-06 (an unreadable mirror config refuses the skill proposal, fail closed) is implemented in e2e4cba4. It closes the phase 73 open item on the mirror origin. Cited tests, all in `packages/mcp-server/src/skills/propose.test.ts`, describe "mirror origin":
- "mirrorOriginUrl is null for a readable config that names no origin" (:1110)
- "mirrorOriginUrl throws when the config cannot be read, so the origin cannot be checked" (:1114)
- "a mirror whose config cannot be read is refused before any Runner call" (:1136)

Source grep at 4637a9b7 finds all three titles. They are not in the r38 JUnit, which ran on 66fa97bd, before e2e4cba4. A targeted run on the content of 4637a9b7, reported to this pass by the orchestrator, ran `propose.test.ts` with 110 pass and 0 fail; this pass did not re-run it. The gate r42 on 4637a9b7 is in progress and writes `/root/src/worktrees/backups/gate-r42-junit.xml`. That file was absent when this pass ran, and this record cites its passing titles.

**Verdicts at this head.** Changed verdicts: none. T1-T8 and R1-R5 stand as written. The T2 override is unchanged. Status stays `human_needed`, because the owner and operator items in the Human Verification section remain open.

## Re-audit at df31c749 (this pass): pointer candidacy, rotation, and the brief grant

**Scope check.** `git diff --name-only 4637a9b7..df31c749` intersected with the covered paths gives two files: `packages/mcp-server/src/service.ts` and `packages/mcp-server/src/service.test.ts`, both changed by 3ce87f63 only. `config.ts` and `config.test.ts` (6245863c) are not in `covered_files`; no criterion here cites them, so they are not added to the fingerprint. The other commits in range touch no covered path: 0556dfd3 (cache), fd4a305f (corpus/service.ts, corpus/ingest.ts), d928e995 (reconcile), 7f6338c2 (host), df31c749 (dispatcher test), 700d9b5c (phase records and ROADMAP).

**Hunk classification (3ce87f63, service.ts).**
1. `namedBySignerSet` (new, service.ts:854-862). Reads the signer set and returns true when the read has a gap or names the payer in some window; returns true when the read throws, because it cannot rule the payer out.
2. `judgePointer` candidacy (service.ts:900-901). Before: with a job key configured, a confirmed pointer was judged only when its payer was the job key, it was signed, and it had no error. Now: signed and no-error are still required; a payer other than the job key is also judged when `namedBySignerSet` says so. The rest of `judgePointer` is unchanged in body: the v3 memo, the graph id, the closed hour, then `judgeSigner` (service.ts:832) at block time. An in-window named key verifies. An out-of-window named key is `mismatch`, a `failed` pointer naming its hour when the memo says so. A gap or a failing read is `unverified`, which makes the hours unreadable (fail closed).
3. Doc comment of `readPointerChecks` (service.ts:~918-921) reworded; body unchanged.
4. `briefIndex` (service.ts:6940) and its call in brief composition (service.ts:2595): brief memory rows pass the caller's grant filter (`memoryReplyInGrant`). Not on `appendChained`, the verify path's chain comparison, the memo, the heads comparison or the anchor path. No criterion depends on brief composition. Verdict: no criterion touched.
5. `service.test.ts` (3ce87f63): four import lines at the top (so cited line numbers after line 3 move by +4), the rotation title (:6030) and the brief title (:6415, "a brief carries only the memory its caller is granted (phase 72)"). No existing test body changed.

**Line numbers at df31c749.** `service.ts` moved; `event.ts`, `anchor.ts`, `anchor-verify-deps.ts`, `memo.ts` and `heads.ts` did not. Mapping from the 4637a9b7 numbers used in the T and R tables:
- `append` 3069 to 3084 (routes to `appendChained` at :3093). `appendChained` 3150 to 3165; assert 3152 to 3167; graph id 3154 to 3169; replay lookup 3160 to 3176; tip read 3180 to 3195; normalizeKey read in `append` 3073 to 3088.
- Sync-lag hook in `emit` 3016-3019 to 3031-3034 (`syncLag` at :3033).
- Handoff: `normalizeGraphId` 7705 to 7732; `assertWriteTextFields` 7706 to 7733; `placeOf` 7714 to 7741; tip read 7723 to 7750; normalizeKey read 7715 to 7742.
- `verifyGraph` 8081 to 8108 (its ledger read 8091 to 8119); devnet guard 8130-8133 to 8157-8160; `hourReport` call 8134 to 8161; `hourReport` 8185 to 8212; signer set read 8481-8483; `readPointerChecks` call 8488; `trustHour` 8578 to 8605; heads-root comparison 8628 to 8655; `compareToAnchoredHead` 8665 to 8692.
- `manifestCommit` 6421 to 6436; `proposeSkill` 4937 to 4952.
- New at df31c749: `judgeSigner` 832, `namedBySignerSet` 854, `judgePointer` 893, `readPointerChecks` 922, `briefIndex` 6940.

**Criterion check at df31c749.**
- T1, T2, T4, T5, T6: code paths unchanged. The chain write, `verifyChain` (event.ts:624), `compareToAnchoredHead` (event.ts:588), the memo (memo.ts:11-12, :42), the anchor sequence (anchor.ts:501, :505-507) and the adoption window (anchor.ts:94) are unchanged. The T1 titles run through `verifyGraph`, but the candidacy change alters an outcome only for a non-job-key pointer; the T1 fixtures confirm pointers as the job key (`rpcReturning` returns `PUBKEY` for pointers unless a pointer names a payer), and the one `SomeoneElse` hour fixture (service.test.ts:4551) lists no pointers. Verdict: unchanged.
- T2: the owner override (2026-11-02, commitment reading) is unchanged; the heads_root commitment and its leaves are not touched by 3ce87f63. Override kept as is.
- T3 and T7: the pointer path changed; see the next paragraph and the T7 row. Behaviour at df31c749: the cited titles pass in r43; the untested sub-cases are code-read only.
- T8: guard body unchanged; line numbers moved.
- R1 to R5: unchanged in substance; R2 and R3 rows carry df31c749 numbers. R1's `service.ts:3152` is `:3167` at df31c749.

**Pointer candidacy (3ce87f63): what the code now does, and what is not tested.** A confirmed pointer is judged when its payer is the job key, or when the signer set names its payer in any window; otherwise it is ignored. The window is checked at the pointer's block time by `judgeSigner`. Effects at df31c749:
- A named retired key's pointer within its window verifies the hour it names (the new rotation title, service.test.ts:6030, covers this with a verified hour).
- A named retired key's pointer outside its window is `mismatch`, a `failed` pointer naming its hour. Before 3ce87f63 it was ignored. Not tested.
- A non-job-key pointer while the rotation read has a gap, or the set cannot be read, is `unverified`, which makes the graph's hours unreadable. The rotation read runs only when operator surfaces are configured (`readSignerSet`, anchor-verify-deps.ts:246, returns the bootstrap set with no gap when there are none). Not tested for pointers; the hour-signer analogue is tested at service.test.ts:5355-5371.
- `readPointerChecks` now calls the signer set for every non-job-key pointer, so a rotation read can happen on a graph with no anchored hour. The comment at service.ts:8479-8480 ("a verify with no anchored hour makes no rotation read") no longer holds for that case. Not corrected here; no code changed in this pass.
- Who can post such a pointer: any payer that can send a transaction with a v3-prefixed memo to the index address [INFERENCE: the listing does not filter payers by key; not run].
None of these adds a verified hour. Each adds a failure or an unreadable result. The commit message records the change as deliberate fail-closed behaviour; it is a recorded fix with a test, not an owner decision. Its wording question and its effects are owner item 9.

**Config (6245863c), outside the covered list.** `config.ts` `destinationOf` (about :2631-2660) compares real destinations, following symlinks, for the event buffer and dead-letter paths at boot, where it used resolved spellings before. The buffer is the phase 76 write-retry buffer (service.ts:2121-2140). It is not on the chain write, verify, memo or anchor path, so no criterion here is touched. Its tests (config.test.ts:878, "a dead-letter path reaching the buffer's file through a symlinked directory is refused at load"; :899, "distinct files are accepted, even when one of their directories is a symlink") are not cited by this record. docs/greptime-ledger.md:1051 ("Boot refuses when ... name one file") is still accurate in substance and is not changed here. The record that covers phase 76 should take `config.ts` into its covered list.

**Fingerprint.** Run from the worktree at df31c749, read-only: `gsd_run query verification.fingerprint .planning/phases/73-ledger-tamper-evidence` with the 38 paths of the 4637a9b7 record. `covered_files` is identical in membership and order to the record's list. `covered_digest`: `v3:sha256:f27a018564dd3b27f4d986b092664d626b8e8d094dfaf251b7b448d941932f4a`. The previous digest (ef7fa28b...) covered the 4637a9b7 contents; the change is `service.ts` and `service.test.ts` (3ce87f63). `config.ts` and `config.test.ts` are not added: no evidence in this record cites them.

**Test evidence (this pass).** No test was run in this pass. Titles cited, each grep-confirmed in source at df31c749: the rotation title (service.test.ts:6030); the brief title (:6415); the T3 titles (:5942, :5951); the T7 titles (:6009, :6021, :6047, :6056, :6075). Run of record: r43, `/root/src/worktrees/backups/gate-r43-junit.xml`; it was absent when this pass ran; it passes (12,332 pass, 0 fail, 2 skip). Titles not in source: none (`missing_test_titles` is empty).

**Judgement 6 (pointer candidacy, 3ce87f63).** The change is consistent with its commit message: a rotated signer's valid history no longer reads as mismatch, and a payer the set does not name stays ignored. The fail-closed side effects above are the points the owner must decide on (item 9). Until then T7 is verified against the rule the code now implements, and the wording in the record is flagged rather than changed.

## Judgement notes (carried, unchanged in substance)

**Judgement 1 (six-field refusal, repo cap).** VERIFIED for caller-supplied lone surrogates in all six fields and for an over-512 repo on the ledger write path. Memory-plane refusal (memory-write.ts:495-496) is code-read only (see above).

**Judgement 2 (W-L3b, straddle for branch, node_id, linear_identifier).** event.ts:438, :439 and :443 keep the 512-unit cut without a dangling-high trim. Fail-closed: `verifyChain` reports a hash mismatch on an untampered row. Owner item, open as listed.

**Judgement 3 (normalizeKey read and write parity).** Session_id and repo use `normalizeKey` on the write (event.ts:436, :442) and on the reads named above. W-K1 is listed open as an owner item, not closed here. W-K3 (Postgres `graph_register`) is narrowed and open.

**Judgement 4 (pre-existing straddling rows, O-S1).** Unchanged by this range. Rows that straddled 512 units before 8a604455 are stored as 511 units plus U+FFFD, already fail `verifyChain`, and are not found by a read of the same id. `docs/greptime-ledger.md` ("Identifiers at the 512-unit cut") records the 2026-11-04 owner decision to leave them. The live count is not run.

**Judgement 5 (memory-plane straddle, W-M1).** Refused at write, code-read only in r38 (memory-write.test.ts has no testcase in the JUnit). Reads still cut a repo filter to fit (`parseScope`), which can miss a refused row, but no such row can be stored. Owner item, open as listed.

**Owner list in force.** STATE.md's Needs-Human table, row 73, is the owner list. Several of its rows describe code that now refuses (W-L4, W-M1, and part of W-K1). This record notes that code state. Apart from the mirror origin item, decided on 2026-11-06 (see the decisions paragraph below), it does not close any owner item and does not re-take an owner decision.

**Owner decisions for this phase, 2026-11-06.** The owner's 2026-11-06 decisions cover phases 67, 74 and 75, and for this phase decision 4: an unreadable mirror config refuses the skill proposal, fail closed. That closes the mirror origin item (judgement note below); it is recorded as a fix with its tests, not as an override. The only override in this record stays T2, unchanged. No other phase 73 owner item was decided. W-L3, W-L4, W-M1, W-L3b, W-K1, W-K3, HARD-S3, N6, N8, W3, W4, W5, O-S1, Q8 and N5 stay open as listed. Code changes made in this range are recorded as fixes with their tests, not as decisions.

**Schema hash dependence (ebabe6ef).** Carried. Nothing in a46d42c3..5e304ef8 touches `index-archive-spec.ts`; `index-store.ts` changed only by a comment and export removal. The ledger archive does not depend on `schemaHash`.

**Mirror origin (propose.ts): recorded fix, formerly an open owner item.** The owner decided on 2026-11-06 that an unreadable mirror config refuses the skill proposal, fail closed. Commit e2e4cba4 implements it: `mirrorOriginUrl` (`skills/propose.ts:474-498`) throws `ProposeFailed` when the mirror's `config` cannot be read, and the origin check at :996-1001 is reached only after that, before any Runner call. A readable config that names no origin still proceeds (hand-built state). Tests in `packages/mcp-server/src/skills/propose.test.ts`, describe "mirror origin": "mirrorOriginUrl throws when the config cannot be read, so the origin cannot be checked", "a mirror whose config cannot be read is refused before any Runner call", "mirrorOriginUrl is null for a readable config that names no origin". This is a recorded fix, not an override. The `overrides` frontmatter is unchanged.

## Human Verification Required

Owner and operator items, all open. The verifier does not run them.

1. **Devnet 0-lamport pointer probe (operator).** Send a 0-lamport pointer to an unfunded index address and record the refusal text. Expected: confirms or refutes `POINTER_REFUSED_RE` (anchor.ts:91).
2. **Live devnet send, 512-byte graph id (operator).** Expected: serialises within 1,232 bytes; the measured size replaces the hand-counted overhead (memo.test.ts).
3. **Live store scan (operator).** `agent_events`: graph_id over 512 bytes; graph_id with NUL; the six fields ending in U+FFFD at 512 units; v2 or v3 memos in the anchor listings. Expected: zero rows, or an owner decision on each. The docs detection SQL is not run.
4. **RPC history depth, N5 (operator).** Accepted limit; depth unmeasured.
5. **Budget measurement, W-N8 (operator).** Time `verifyGraph` for a year-old graph against the 30 s default.
6. **Owner decision on stored graph ids over 512 bytes, NUL, or lone surrogate, and on pre-fix rows (owner).** Until decided, a live anchor run against such rows halts at the first such hour.
7. **O-S1 sizing (operator).** Count straddled rows per field against the 2026-11-04 decision.
8. **W-L3b owner decision (owner).** Trim the dangling high for branch, node_id and linear_identifier, or record the fail-closed verdict as accepted.
9. **Pointer candidacy wording and its fail-closed effects (owner; opened by 3ce87f63, not decided).** The record's N3 wording (T7) says verify counts only job-key pointers. Commit 3ce87f63 also counts a pointer whose payer the signer set names (in any window; the window is checked at block time). Owner to confirm the wording, or to direct a revert. Two effects are fail-closed: a named retired key's pointer outside its window fails the hour it names (before: ignored), and a non-job-key pointer while the rotation read is incomplete makes the graph's hours unreadable. Expected: a recorded answer. Until then T7 and T3 stand as code-read at df31c749.

## Gaps Summary

No blocker. No truth is FAILED, no artifact is missing or a stub, and no key link is broken. Status is `human_needed` because owner and operator items remain open (above).

Warnings carried, not blocking:
- W-L3, W-L4, W-M1, W-L3b, W-K1, W-K3, HARD-S3, N6, N8, W3, W4 (label), W5: owner items, open as listed.
- Stored graph ids over 512 bytes, NUL, or lone surrogate: operator scan and owner repair decision, open.
- O-S1, Q8, N5: recorded decisions or accepted limits, open as recorded.

Changed since 5e304ef8 (this pass): `skills/propose.ts` and `propose.test.ts` (e2e4cba4, mirror config refusal) and `packages/cli/src/index.ts` (4ac770af, stderr line on a dropped emit). None changes the chain write, the verify logic, the memo or anchor logic, or a truth. No new gap. Earlier, a46d42c3..5e304ef8: export keyword removals (no behaviour), comment lines (event.ts:77 shifts later event.ts lines by +1), `reportSilent` at memory-write.ts catch sites (same return values), `retainDocumentId` signature narrowed (memory-retain.ts), the phase 63 `manifestCommit` lookup (service.ts:6421, docs citation path), and one docs sentence (docs/greptime-ledger.md).

Changed since 4637a9b7 (this pass, df31c749): `service.ts` and `service.test.ts` (3ce87f63): pointer candidacy admits a non-job-key pointer whose payer the signer set names, with the window checked at block time; the brief composes only the memory its caller is granted. `config.ts` and `config.test.ts` (6245863c) are outside this record's covered list and no criterion cites them. T3 and T7 are code-read at df31c749; their run is pending (r43). No owner item is decided. Status stays `human_needed`.

---

_Verified: 2026-11-06T06:11:39Z_
_Verifier: V73-4 (gsd-verifier procedure; read-only; draft, not committed)_
