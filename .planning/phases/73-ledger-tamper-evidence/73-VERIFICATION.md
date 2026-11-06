---
phase: 73-ledger-tamper-evidence
verified: 2026-11-06T02:56:10Z
status: human_needed
score: 8/8 must-haves verified (T2 counted as PASSED override)
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", "docs/greptime-ledger.md", "packages/cli/src/capsule.ts", "packages/cli/src/index.ts", "packages/ledger/src/heads.test.ts", "packages/ledger/src/heads.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/mcp-server/src/anchor-verify-deps.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/checkpoint-verify.test.ts", "packages/mcp-server/src/corpus/slo.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index-store.test.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/memory-policy.test.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/memory-record.ts", "packages/mcp-server/src/memory-retain.ts", "packages/mcp-server/src/memory-verify.ts", "packages/mcp-server/src/memory-write.test.ts", "packages/mcp-server/src/memory-write.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.ts", "packages/mcp-server/src/session-rollback.ts", "packages/mcp-server/src/silent-failures.ts", "packages/mcp-server/src/skills/propose.test.ts", "packages/mcp-server/src/skills/propose.ts", "packages/mcp-server/src/types.ts", "packages/observability/src/instruments.ts"]
covered_digest: "v3:sha256:ef7fa28bbc7e8d8824ca6a151085d045974a0cfa53bd976af20f880dc4cbc1b7"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof criterion 1 compares against; a head recomputed from the stored rows is never the proof."
    reason: "Owner accepted the commitment reading on 2026-11-02: each graph head is committed on chain by the memo v2 heads_root and recovered only through stored leaves that reproduce it. Carried from the prior record; acceptance not re-obtained here. This override covers the commitment reading only. It does not cover the write-path items W-L3b and W-K3 below."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: 8/8 (T2 counted as PASSED override)
  previous_verified: 2026-11-06T02:56:10Z
  previous_scope: "worktree /root/src/worktrees/as-gsd-v18-all, HEAD 5e304ef8 (clean). Range a46d42c3..5e304ef8. Covered paths changed in range (18): docs/greptime-ledger.md, packages/cli/src/capsule.ts, packages/ledger/src/memo.ts, and fifteen packages/mcp-server/src files. Changes: export keywords removed, comment lines, reportSilent at memory-write.ts catch sites, a retainDocumentId narrowing, the phase 63 manifestCommit lookup, one docs sentence. No chain write, verify, memo or anchor logic changed."
  scope: "worktree /root/src/worktrees/as-gsd-v18-all, HEAD 4637a9b7 (clean). Range 5e304ef8..4637a9b7. Covered paths changed in range: packages/mcp-server/src/skills/propose.ts (e2e4cba4). Cited and added to covered_files in this pass: packages/mcp-server/src/skills/propose.test.ts (e2e4cba4), packages/cli/src/index.ts (4ac770af). Changes: mirrorOriginUrl throws ProposeFailed when the mirror config cannot be read (fail closed; owner decision 4, 2026-11-06), with tests; the reportSilent import is removed from propose.ts; cmdEmit writes one stderr line when a dropped emit has no answer and the spool is off. No chain write, verify, memo or anchor logic changed."
  gaps_closed:
    - "propose.ts mirror origin, fail-open: closed as a recorded fix. Owner decision 4 (2026-11-06): an unreadable mirror config refuses the skill proposal. Implemented in e2e4cba4 with its tests; not an override. See the 4637a9b7 section."
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
  gaps_new: []
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
---

# Phase 73: Ledger tamper evidence Verification Report

**Phase Goal:** A rewrite, reorder, deletion or tail truncation of the event ledger is detected by recomputing the chain from stored rows, and the verified head is anchored. Criterion 1 is proven by tests against a head saved before the change. Criterion 2 requires each graph's chain head to be recorded in the hourly anchor, and that recorded head is the only trusted proof.
**Verified:** 2026-11-06T04:09:31Z
**Status:** human_needed
**Re-verification:** Yes, after the 5e304ef8 record. Scope is HEAD 4637a9b7. Prior status human_needed, score 8/8. Line numbers in the chain sections are unchanged at 4637a9b7. Covered code changed since 5e304ef8: `skills/propose.ts` (e2e4cba4); its cited lines are in the 4637a9b7 section.

Evidence base: gate r38, `/root/src/worktrees/backups/gate-r38-junit.xml` (run on 66fa97bd). Its one failure is the `repository ratchet` check ("the ratchet is tight: no source counter sits below its baseline", scripts/code-ratchet.test.ts), which head 5e304ef8 addresses (`as_unknown_as` ratchet lowered to 22). Its two skips are outside this phase (redact.test.ts, cache-conformance.test.ts). Every test title cited in the 5e304ef8 sections is a passing testcase in that file and a `test(...)` or `describe(...)` title in source. The three `propose.test.ts` titles added by e2e4cba4 are not in that file (r38 ran before the commit); they are cited from source only, in the 4637a9b7 section. The gate r42 on 4637a9b7 is in progress and writes `/root/src/worktrees/backups/gate-r42-junit.xml`; this record claims no pass count from it. No live or operator check was run, and this pass ran no tests.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| T1 | SC1: an edited payload, a deleted middle event, truncated last events and a full rewrite are each compared with the saved head; the first differing or first missing id is named | ✓ VERIFIED | r38 (classname "heads trust (D73-03, D73-04) > verifyGraph hour report", service.test.ts:5413 and :4296): "an edited payload parts the chain at that event: first_differing_event_id"; "a deleted middle event is first_missing_event_id, and the verdict fails"; "truncated last events are first_missing_event_id at the first one gone, and the verdict fails"; "a full rewrite with every hash and prev recalculated parts at the first event, and the verdict fails"; "sessions verify one by one, and the verdict is the same for every read order". Verdict code unchanged: `verifyGraph` service.ts:8081, `hourReport` :8185, `trustHour` :8578; `verifyChain` event.ts:624 (body unchanged). |
| T2 | SC2: each graph's chain head is recorded in the hourly anchor and the recorded head is the trusted proof | ✓ PASSED (override) | Memo v2 `heads_root`: `packages/ledger/src/memo.ts:11-12` (`MEMO_PREFIX_V2`, `MEMO_V2_RE`, now module-private), `formatMemoV2` (memo.ts:42) used by `anchor.ts:501`. Leaves before the row: `storeAnchor` at `anchor.ts:505-507` (body unchanged; anchor.ts changed only by export removal). r38: "anchored happy path: chain ok, hour anchored, ok true" (service.test.ts); `anchor.test.ts`, `memo.test.ts` and `heads.test.ts` cited titles are passing in r38. Owner override 2026-11-02, commitment reading only; carried, acceptance not re-obtained here. |
| T3 | G1: an anchored hour removed from `agent_events`, `event_ingest` and `graph_chain_leaves` fails the verdict and is named | ✓ VERIFIED for pointer-listed hours (Q8 and N5 accepted limits) | r38 (classname "v3 pointers: each hour of a graph is named by its own pointer (design 5)", service.test.ts:5895): "G1Probe, variant 1a: a trailing hour whose rows, ingest and leaves are gone fails the verdict naming it, though its anchors row is kept"; "G1Probe, variant 1b: the same with its anchors row removed too: the verdict still names the hour, through its pointer"; "with no pointer either, a graph whose only hour is gone has no events on chain: ok, untrusted, no events (design 6, row 6)". |
| T4 | The hourly job sends every closed hour's pointers for every graph id the write path accepts, so the job does not halt on a valid event | ✓ VERIFIED | Graph id refusals: NUL `graph_id_nul` event.ts:236; over-cap `graph_id_too_long` event.ts:226; `normalizeGraphId` event.ts:331. `appendChained` (service.ts:3150) runs `assertWriteTextFields` (:3152) and `normalizeGraphId` (:3154) before the replay lookup (:3160) and the chain tip read (:3180). Handoff runs `normalizeGraphId` at service.ts:7705 and `assertWriteTextFields` at :7706, before `placeOf` (:7714) and the tip read (:7723). r38: "refuses a NUL in the graph id before it reads the chain tip" (classname "emit", service.test.ts); "refuses a lone surrogate in the summary before it reads the chain tip" (service.test.ts); "refuses a lone surrogate in the handoff summary before it reads the chain tip" (service.test.ts); "refuses a lone high surrogate in each of the six fields, by name" (event.test.ts). |
| T5 | N1/W2: the hour is sent, then pointers, then the row; a pointer failure stores no row; an unanchored mismatch stores no row | ✓ VERIFIED | `anchor.ts` anchor sequence unchanged in this range (anchor.ts changed only by export removal, b8cbdeac). r38: "unanchored past 3 h: no row, fails naming the hour" (service.test.ts); `anchor.test.ts` titles cited in this record are passing. |
| T6 | N2: the adoption window covers the lookback's newer transactions | ✓ VERIFIED | `ADOPT_LOOKBACK_HOURS = 168` at `anchor.ts:94`, unchanged in value; the change in range is the export keyword only. `anchor-verify-deps.test.ts` is in the covered set; no cited title in this record depends on a changed line. |
| T7 | N3: verify counts only job-key pointers that succeeded; other entries are ignored; a job-key pointer naming another hour still fails | ✓ VERIFIED (verify side) | r38 (classname "v3 pointers: each hour of a graph is named by its own pointer (design 5)", service.test.ts): "a pointer the job key did not sign, or that failed on chain, is ignored: not a mismatch, and the hour has no pointer of its own"; "a pointer signed by another key is ignored: not a mismatch, and the hour has no pointer of its own"; "a foreign-payer pointer does not fail a valid hour: the job key's own pointer verifies it"; "an errored pointer does not fail a valid hour: the job key's own pointer verifies it"; "a job-key pointer whose hour transaction names another hour is still a mismatch of its hour". Anchor-side adoption pointer filter still untested: W-N3c. |
| T8 | Refused `SOLANA_RPC_URL`: no chain read, `ok` false, `trusted` false, a named reason | ✓ VERIFIED | Guard at `service.ts:8130-8133` (`this.config.solana.problem !== null` returns before `hourReport` at :8134). r38: "a refused SOLANA_RPC_URL makes no chain read and fails closed, naming the devnet guard" (service.test.ts, verifyGraph hour report). |

**Score:** 8/8 truths verified (T2 counted as PASSED override). Behavior unverified: 0. Presence-only truths: none.

### Re-verification of the prior record's checks

| #  | Check | Status | Evidence |
| -- | ----- | ------ | -------- |
| R1 | Six-field refusal: a lone surrogate in summary, session_id, repo, branch, node_id or linear_identifier is refused at write by name, before any hash or store write | ✓ VERIFIED | `assertWriteTextFields` event.ts:311-321 (six `refuseLoneSurrogate` calls at :314-319, then `assertRepoLength` at :320). Called first in `appendChained` (service.ts:3152) and in `normalizeEvent` (event.ts:427). r38: "refuses a lone high surrogate in the branch, by name, with its code unit", "... in the node id, by name, with its code unit", "... in the linear identifier, by name, with its code unit", "... in the repo, by name, with its code unit", "... in the session id, by name, with its code unit" (event.test.ts, classname "lone surrogates in the other write text fields"); "refuses a lone low surrogate in the summary, by name". |
| R2 | The refusal runs before the sessioned chain-tip read, the replay lookup, the buffer and the append-mode probe | ✓ VERIFIED | `appendChained` service.ts:3150; assert :3152, graph id :3154, replay lookup from :3160. `append` (service.ts:3069) routes to `appendChained` unchanged (:3078-3079). Handoff refuses before `placeOf` and the tip read (:7705-7723). |
| R3 | normalizeKey read and write parity for the LEDGER (session_id and repo) | ✓ VERIFIED | Write: `event.ts:436` (session_id), `:442` (repo). Reads: `service.ts:3073` (append), `:7715` (handoff). Checkpoint lookup `anchor-verify-deps.ts:217` (normalizeKey, unchanged). r38: "a checkpoint written under a straddling session id is found by that id and verifies as anchored" (checkpoint-verify.test.ts). |
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

Source grep at 4637a9b7 finds all three titles. They are not in the r38 JUnit, which ran on 66fa97bd, before e2e4cba4. A targeted run on the content of 4637a9b7, reported to this pass by the orchestrator, ran `propose.test.ts` with 110 pass and 0 fail; this pass did not re-run it. The gate r42 on 4637a9b7 is in progress and writes `/root/src/worktrees/backups/gate-r42-junit.xml`. That file was absent when this pass ran, and this record claims no result from it.

**Verdicts at this head.** Changed verdicts: none. T1-T8 and R1-R5 stand as written. The T2 override is unchanged. Status stays `human_needed`, because the owner and operator items in the Human Verification section remain open.

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

## Gaps Summary

No blocker. No truth is FAILED, no artifact is missing or a stub, and no key link is broken. Status is `human_needed` because owner and operator items remain open (above).

Warnings carried, not blocking:
- W-L3, W-L4, W-M1, W-L3b, W-K1, W-K3, HARD-S3, N6, N8, W3, W4 (label), W5: owner items, open as listed.
- Stored graph ids over 512 bytes, NUL, or lone surrogate: operator scan and owner repair decision, open.
- O-S1, Q8, N5: recorded decisions or accepted limits, open as recorded.

Changed since 5e304ef8 (this pass): `skills/propose.ts` and `propose.test.ts` (e2e4cba4, mirror config refusal) and `packages/cli/src/index.ts` (4ac770af, stderr line on a dropped emit). None changes the chain write, the verify logic, the memo or anchor logic, or a truth. No new gap. Earlier, a46d42c3..5e304ef8: export keyword removals (no behaviour), comment lines (event.ts:77 shifts later event.ts lines by +1), `reportSilent` at memory-write.ts catch sites (same return values), `retainDocumentId` signature narrowed (memory-retain.ts), the phase 63 `manifestCommit` lookup (service.ts:6421, docs citation path), and one docs sentence (docs/greptime-ledger.md).

---

_Verified: 2026-11-06T04:09:31Z_
_Verifier: V73b (gsd-verifier procedure; read-only; draft, not committed)_
