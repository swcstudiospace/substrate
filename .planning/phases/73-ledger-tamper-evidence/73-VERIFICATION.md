---
phase: 73-ledger-tamper-evidence
verified: 2026-11-06T00:43:54Z
status: human_needed
score: 8/8 must-haves verified (T2 counted as PASSED override)
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", "docs/greptime-ledger.md", "packages/cli/src/capsule.ts", "packages/ledger/src/heads.test.ts", "packages/ledger/src/heads.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/mcp-server/src/anchor-verify-deps.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/checkpoint-verify.test.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index-store.test.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/memory-policy.test.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/memory-record.ts", "packages/mcp-server/src/memory-retain.ts", "packages/mcp-server/src/memory-verify.ts", "packages/mcp-server/src/memory-write.test.ts", "packages/mcp-server/src/memory-write.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.ts", "packages/mcp-server/src/session-rollback.ts", "packages/mcp-server/src/types.ts"]
covered_digest: "v3:sha256:61575b3c0be05a8cbaf81d22b94fe33f07f3ebf4df7f6e1daa052fd4bed9c083"
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
  previous_verified: 2026-11-05T07:59:55Z
  previous_scope: "worktree /root/src/worktrees/as-gsd-v18-all, HEAD 6e5d766e. The in-repo frontmatter digest after aef8a351 is v3:sha256:3ecc5bf0 (refreshed after 884e0753); the prior body's v3:sha256:27614237 is the 6e5d766e figure and is stale in the body text."
  scope: "worktree /root/src/worktrees/as-gsd-v18-all, HEAD a46d42c3 (clean). Range 6e5d766e..a46d42c3. Covered paths changed in range: packages/mcp-server/src/service.ts (884e0753, f0f3c04e), packages/mcp-server/src/greptime.ts (f0f3c04e), packages/mcp-server/src/event.ts (a46d42c3), packages/cli/src/capsule.ts (9b793653). The covered list is unchanged (31 paths). covered_digest moved to v3:sha256:43e38d36 for those four content changes."
  gaps_closed: []
  gaps_remaining:
    - "W-L3: session_id and repo at the 512-unit cut (event.ts:435, :441 use normalizeKey). Owner item, open as listed."
    - "W-L4: branch, node_id and linear_identifier accept a lone surrogate on write, per the owner list. Code now refuses them (assertWriteTextFields, event.ts:310-321). Owner item, open as listed; the decision is not re-taken here."
    - "W-M1: a repo over the 512-unit cut in the memory plane. Code refuses it at write (memory-write.ts:494, index-store.ts:1175, :2448, :2505). memory-write.test.ts has no testcase in gate r36, so this is code-read only. Owner item, open as listed."
    - "W-L3b: branch, node_id and linear_identifier take the 512-unit cut without a dangling-high trim (event.ts:437, :438, :442, unchanged). Owner item, open as listed. Also the pre-existing row repair decision."
    - "W-K1: pre-existing unnormalised reads and writes. Session_id reads are normalised (checkpoint lookup, anchor-verify-deps.ts). Owner item, open as listed."
    - "W-K3: Postgres graph_register repo write (index-store.ts:1175, then raw write). Narrowed, not closed. Not probed. Owner item, open as listed."
    - "HARD-S3: scope owner item. Open as listed."
    - "N6, N8, W3, W4 (label), W5: fix or accept each open gap in the 73 record. Owner items, open as listed (STATE.md Needs-Human table, row 73). W-N8 is the budget measurement in human verification item 5."
    - "Stored graph ids over 512 bytes, containing NUL, or with a lone surrogate: operator scan, then owner repair decision. Blocks live anchoring on such a store. Open as listed."
    - "O-S1: pre-change straddled rows. docs/greptime-ledger.md records the 2026-11-04 owner decision to leave them. The live count is not run. Stays open."
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
**Verified:** 2026-11-06T00:43:54Z
**Status:** human_needed
**Re-verification:** Yes, after the 6e5d766e record. Scope is HEAD a46d42c3. Prior status human_needed, score 8/8. Line numbers below are at a46d42c3.

Evidence base: gate r36. `/root/src/worktrees/backups/gate-r36-junit.xml`: 12,317 testcases, 0 failures, 0 errors, 2 skipped (12,315 pass). `/root/src/worktrees/backups/gates-int-r36.log` records `head=a46d42c3`, `TSC_EXIT=0`, `LINT_EXIT=0`, `BUNTEST_EXIT=0`, `PHASECLOSE_EXIT=0`, `GATE_INT7_RC=0`. A test title counts below only if it is a testcase in that JUnit with no failure, error or skipped child. No test was run by this pass, and no live or operator-gated behaviour is claimed as observed.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| T1 | SC1: an edited payload, a deleted middle event, truncated last events and a full rewrite are each compared with the saved head; the first differing or first missing id is named | ✓ VERIFIED | r36 (classname "heads trust (D73-03, D73-04) > verifyGraph hour report", service.test.ts): "an edited payload parts the chain at that event: first_differing_event_id"; "a deleted middle event is first_missing_event_id, and the verdict fails"; "truncated last events are first_missing_event_id at the first one gone, and the verdict fails"; "a full rewrite with every hash and prev recalculated parts at the first event, and the verdict fails"; "sessions verify one by one, and the verdict is the same for every read order". Verdict code unchanged: `verifyGraph` service.ts:8081, `hourReport` :8185, `trustHour` :8578; `verifyChain` event.ts:623 (body unchanged). |
| T2 | SC2: each graph's chain head is recorded in the hourly anchor and the recorded head is the trusted proof | ✓ PASSED (override) | Memo v2 `heads_root`: `packages/ledger/src/memo.ts:11-12` (`MEMO_PREFIX_V2`, `MEMO_V2_RE`), `formatMemoV2` used by `anchor.ts:501`. Leaves before the row: `anchor.ts:504-506` (unchanged, not in the changed list). r36: `anchor.test.ts` 76 testcases, `memo.test.ts` 31, `heads.test.ts` 18, all pass; "anchored happy path: chain ok, hour anchored, ok true" (service.test.ts). Owner override 2026-11-02, commitment reading only; carried, acceptance not re-obtained here. |
| T3 | G1: an anchored hour removed from `agent_events`, `event_ingest` and `graph_chain_leaves` fails the verdict and is named | ✓ VERIFIED for pointer-listed hours (Q8 and N5 accepted limits) | r36 (classname "v3 pointers: each hour of a graph is named by its own pointer"): "G1Probe, variant 1a: a trailing hour whose rows, ingest and leaves are gone fails the verdict naming it, though its anchors row is kept"; "G1Probe, variant 1b: the same with its anchors row removed too: the verdict still names the hour, through its pointer"; "with no pointer either, a graph whose only hour is gone has no events on chain: ok, untrusted, no events (design 6, row 6)". |
| T4 | The hourly job sends every closed hour's pointers for every graph id the write path accepts, so the job does not halt on a valid event | ✓ VERIFIED | Graph id refusals: NUL `graph_id_nul` event.ts:235; over-cap `graph_id_too_long` event.ts:225; `normalizeGraphId` event.ts:330. `appendChained` (service.ts:3150) runs `assertWriteTextFields` (:3152) and `normalizeGraphId` (:3154) before the replay lookup and the chain tip read. Handoff runs `normalizeGraphId` at service.ts:7705 and `assertWriteTextFields` at :7706, before `placeOf` (:7714) and the tip read (:7723). r36: "refuses a NUL in the graph id before it reads the chain tip" (classname "emit"); "refuses a lone surrogate in the summary before it reads the chain tip" (emit); "refuses a lone surrogate in the handoff summary before it reads the chain tip" (handoff); "refuses a lone high surrogate in each of the six fields, by name" (event.test.ts). |
| T5 | N1/W2: the hour is sent, then pointers, then the row; a pointer failure stores no row; an unanchored mismatch stores no row | ✓ VERIFIED | `anchor.ts` anchor sequence unchanged in this range (anchor.ts not in the changed list). r36: `anchor.test.ts` 76 testcases, all pass. "unanchored past 3 h: no row, fails naming the hour" (service.test.ts). |
| T6 | N2: the adoption window covers the lookback's newer transactions | ✓ VERIFIED | `ADOPT_LOOKBACK_HOURS = 168` at `anchor.ts:94`, unchanged. r36: `anchor-verify-deps.test.ts` 56 testcases, all pass. |
| T7 | N3: verify counts only job-key pointers that succeeded; other entries are ignored; a job-key pointer naming another hour still fails | ✓ VERIFIED (verify side) | r36 (classname "v3 pointers: each hour of a graph is named by its own pointer", service.test.ts): "a pointer the job key did not sign, or that failed on chain, is ignored: not a mismatch, and the hour has no pointer of its own"; "a pointer signed by another key is ignored: not a mismatch, and the hour has no pointer of its own"; "a foreign-payer pointer does not fail a valid hour: the job key's own pointer verifies it"; "an errored pointer does not fail a valid hour: the job key's own pointer verifies it"; "a job-key pointer whose hour transaction names another hour is still a mismatch of its hour". Anchor-side adoption pointer filter still untested: W-N3c. |
| T8 | Refused `SOLANA_RPC_URL`: no chain read, `ok` false, `trusted` false, a named reason | ✓ VERIFIED | Guard at `service.ts:8130-8133` (`this.config.solana.problem !== null` returns before `hourReport`). r36: "a refused SOLANA_RPC_URL makes no chain read and fails closed, naming the devnet guard" (service.test.ts, verifyGraph hour report). |

**Score:** 8/8 truths verified (T2 counted as PASSED override). Behavior unverified: 0. Presence-only truths: none.

### Re-verification of the prior record's checks

| #  | Check | Status | Evidence |
| -- | ----- | ------ | -------- |
| R1 | Six-field refusal: a lone surrogate in summary, session_id, repo, branch, node_id or linear_identifier is refused at write by name, before any hash or store write | ✓ VERIFIED | `assertWriteTextFields` event.ts:310-321 (six `refuseLoneSurrogate` calls, then `assertRepoLength`). Called first in `appendChained` (service.ts:3152) and in `normalizeEvent`. r36: "refuses a lone high surrogate in the branch, by name, with its code unit", "... in the node id ...", "... in the linear identifier ...", "... in the repo ...", "... in the session id ..." (event.test.ts, classname "lone surrogates in the other write text field"); "refuses a lone low surrogate in the summary, by name". |
| R2 | The refusal runs before the sessioned chain-tip read, the replay lookup, the buffer and the append-mode probe | ✓ VERIFIED | `appendChained` service.ts:3150; assert :3152, graph id :3154, replay lookup from :3160. `append` (service.ts:3069) routes to `appendChained` unchanged (:3078-3079). Handoff refuses before `placeOf` and the tip read (:7705-7723). |
| R3 | normalizeKey read and write parity for the LEDGER (session_id and repo) | ✓ VERIFIED | Write: `event.ts:435` (session_id), `:441` (repo). Reads: `service.ts:3073` (append), `:7715` (handoff). Checkpoint lookup `anchor-verify-deps.ts` (normalizeKey, unchanged). r36: "a checkpoint written under a straddling session id is found by that id and verifies as anchored" (checkpoint-verify.test.ts, 61 testcases, all pass). |
| R4 | A session_id that straddles 512 units round-trips: stored, looked up and read back in one form | ✓ VERIFIED (carried) | r36: "a session id straddling the cap is stored, looked up and read back in one form"; "a repo longer than the cap is refused at write, naming the rule, and nothing is stored" (service.test.ts). |
| R5 | 4b84e50c regression test: a row with repo `owner/name` plus a lone high surrogate is not visible to a caller granted `owner/name`; a scope spelled with a surrogate keeps it | ✓ VERIFIED (carried) | r36: "a repo keeps its exact spelling for visibility: a lone high surrogate is not trimmed into the granted repo" (memory-policy.test.ts, 42 testcases, all pass). `memory-policy.ts` unchanged in range. |

## Re-audit of the chain and anchor paths at a46d42c3 (this pass)

**Scope check.** `git diff --name-only 6e5d766e..a46d42c3` intersected with the 31 covered paths gives four files. Commits in range touching them: `884e0753` and `f0f3c04e` (service.ts), `f0f3c04e` (greptime.ts), `a46d42c3` (event.ts), `9b793653` (capsule.ts). Not changed in range, so the chain, anchor, memo and verify modules are byte-identical to 6e5d766e: `anchor.ts`, `anchor-verify-deps.ts`, `packages/ledger/src/*`, `brief.ts`, `memory-*.ts`, `index-store.ts`, `session-context.ts`, `session-rollback.ts`, `types.ts`, `docs/greptime-ledger.md`.

**Chain write (`appendChained`, `append`).** No hunk of `git diff 6e5d766e..a46d42c3 -- service.ts` falls in `append` (now :3069) or `appendChained` (:3150-3242). Unchanged: the assert (:3152), the graph id refusal (:3154), the replay lookup, the buffer, the chain tip read, `build(prev)` and the append. The only service.ts hunks inside `emit()` are the sync-lag block (see below). **Verdict: the chain write is unchanged.**

**Verify path (`verifyGraph`, `hourReport`, `trustHour`, the head comparison, `verifyChain`, `compareToAnchoredHead`).** No service.ts hunk falls at or after old line 7760, so `verifyGraph` (:8081), `hourReport` (:8185), `trustHour` (:8578), the `headsRoot` comparison (:8628) and `compareToAnchoredHead` (:8665) are unchanged. `event.ts` changed only at old :812-816 (below). `verifyChain` (event.ts:623), `compareToAnchoredHead` (event.ts:587) and `inChainOrder` (event.ts:469) are unchanged. **Verdict: the verify logic is unchanged.**

**Changes on the chain/verify neighbourhood, each classified:**

1. **`service.ts` `emit()`, the sync-lag hook (884e0753, service.ts:3016-3019).** Block is `if (result.stored || result.buffered === true || result.deadLettered === true) { const seconds = this.corpusSlo.recordSyncLag(result.event.payload); if (seconds !== null) this.observer.syncLag?.({ seconds }); }`. It runs after `this.append(...)` has returned (`emit` :2988-2991). A deduplicated replay returns earlier (:2992-2996), so it is not reached. `recordSyncLag` (`corpus/slo.ts:72`) only reads the payload and sets the in-memory lag. `observer.syncLag` (`service.ts:1061`) is wired to `instruments.setCorpusSyncLag` (`observe.ts:399`, `instruments.ts:679`). It writes no ledger row and does not alter `result`. **Not on the chain write or the verify path.**
2. **`service.ts` `emit()` routing, f0f3c04e.** The `emit()` body is unchanged there. Its hunks are `.catch(() => undefined)` becoming `.catch((cause) => reportSilent(site, cause))` at the caller sites (steering :2252 and :2283, publish hint :3033, teachable :3500, retain :3530 and :3606, trackRetain :3881, and the handover release :7784). `reportSilent` (`silent-failures.ts:29`) writes one stderr line per site and returns void. The rejection is still swallowed, so the control flow is unchanged. **Not on the chain path.**
3. **`greptime.ts` `sql()` reply parse (f0f3c04e, greptime.ts:872-930). This is a read-path change on both the write and the verify path, and it is not "unchanged".** `sql()` feeds `lastHash` (greptime.ts:1489, the chain tip read in `appendChained` and handoff) and `readEvents` (greptime.ts:1678, read by `verifyGraph` service.ts:8091 and `graphTeachables`). Before: a JSON array or scalar body had `body.output` undefined, so it yielded zero rows. For the tip read that meant `prev = null`, which starts a second chain beside the stored one. For verify it meant an empty event set. After: a non-object body (array, scalar or null) throws `GreptimeError("greptime returned a non-object body")`, and non-array `rows` throws. For the tip read the existing `tipError` path refuses the write (`appendChained` returns `stored: false`). For verify the error propagates, so no verdict is produced. This is fail-closed. Reachability against the real Greptime service is [INFERENCE] and was not probed. The cited r36 test covers only the null body: "a reply that is not an object is refused with the module error, not a TypeError" (greptime.test.ts). The array-body and non-array-rows branches are code-read only.
4. **`event.ts`, a46d42c3.** Removes `isPlanningUpdate` (old :812-816). There is no remaining reference in `packages/` (grep). Dead code only. The six-field refusal, normalizeKey and normalizeIdentifier call sites (event.ts:435-442) are unchanged.
5. **`cli/src/capsule.ts`, 9b793653 (:518).** `payload: draft.payload as unknown as Record<...>` becomes `payload: { ...draft.payload }`. `CapsuleEventDraft.payload` is a typed record (`mcp-server/src/capsule.ts:488`), so the copy carries the same own enumerable keys and the canonical-JSON hash is unchanged [INFERENCE on hash equality, from the types]. r36: "round trip: pages the read, writes a 0600 capsule that imports, records ONE note, prints digest, count and root" (packages/cli/src/capsule.test.ts).
6. **`service.ts` handoff, f0f3c04e (:7784).** The `handover.release` catch becomes `reportSilent`. The lease release still runs after the durable emit, as before. Not on the chain write.

**Verdict of the audit:** the chain write and the verify logic are unchanged. Change 3 is the one read-path change that touches both paths. It makes both fail closed, and it does not change any truth.

**Test evidence, by file (r36, no non-pass in any file listed):** service.test.ts 324, event.test.ts 84, anchor.test.ts 76, checkpoint-verify.test.ts 61, anchor-verify-deps.test.ts 56, memory-policy.test.ts 42, memo.test.ts 31, heads.test.ts 18, index-store.test.ts 18, greptime.test.ts 187, service-event-buffer.test.ts 19. `memory-write.test.ts` has no testcase in r36, so W-M1's refusal and memory-write behaviour are code-read only in this record.

**Sync-lag negative branch.** A note the server did not take (not stored, not buffered, not dead-lettered) leaves the gauge as it was: code-read at service.ts:3016 and tested at the slo level by "the sync lag is the lag of the newest docs.sync note the server took that carries a usable one, and any other note leaves it in place" (corpus/slo.test.ts). There is no named test of the emit gate's negative branch.

**Fingerprint.** `covered_files` is the 31 paths, verbatim. `covered_digest` was computed with `gsd_run query verification.fingerprint .planning/phases/73-ledger-tamper-evidence <29 implementation paths>` from the worktree: `v3:sha256:43e38d361c8af96c83f9406fd03579652f8c56ce95d0321c8acdd50c3e5ad49f`. The in-repo frontmatter value at HEAD (`3ecc5bf0`) predates the 9b793653, f0f3c04e and a46d42c3 content changes.

## Judgement notes (carried, unchanged in substance)

**Judgement 1 (six-field refusal, repo cap).** VERIFIED for caller-supplied lone surrogates in all six fields and for an over-512 repo on the ledger write path. Memory-plane refusal (memory-write.ts:494) is code-read only (see above).

**Judgement 2 (W-L3b, straddle for branch, node_id, linear_identifier).** event.ts:437, :438 and :442 keep the 512-unit cut without a dangling-high trim. Fail-closed: `verifyChain` reports a hash mismatch on an untampered row. Owner item, open as listed.

**Judgement 3 (normalizeKey read and write parity).** Session_id and repo use `normalizeKey` on the write (event.ts:435, :441) and on the reads named above. W-K1 is listed open as an owner item, not closed here. W-K3 (Postgres `graph_register`) is narrowed and open.

**Judgement 4 (pre-existing straddling rows, O-S1).** Unchanged by this range. Rows that straddled 512 units before 8a604455 are stored as 511 units plus U+FFFD, already fail `verifyChain`, and are not found by a read of the same id. `docs/greptime-ledger.md` ("Identifiers at the 512-unit cut") records the 2026-11-04 owner decision to leave them. The live count is not run.

**Judgement 5 (memory-plane straddle, W-M1).** Refused at write, code-read only in r36 (memory-write.test.ts has no testcase in the JUnit). Reads still cut a repo filter to fit (`parseScope`), which can miss a refused row, but no such row can be stored. Owner item, open as listed.

**Owner list in force, kept open as listed.** STATE.md's Needs-Human table, row 73, is the owner list. Several of its rows describe code that now refuses (W-L4, W-M1, and part of W-K1). This record notes that code state. It does not close any owner item, and it does not re-take an owner decision.

**Schema hash dependence (ebabe6ef).** Carried. Nothing in 6e5d766e..a46d42c3 touches `index-store.ts` or `index-archive-spec.ts`. The ledger archive does not depend on `schemaHash`.

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

Changed since 6e5d766e: `emit()` sync-lag hook (884e0753), `sql()` reply shape checks (f0f3c04e, read path for the chain tip and for verify), `capsule.ts` payload copy (9b793653), `isPlanningUpdate` removal (a46d42c3), and the `reportSilent` call sites (f0f3c04e). None changes the chain write or the verify logic, and none changes a truth. No new gap.

---

_Verified: 2026-11-06T00:43:54Z_
_Verifier: V73-2 (gsd-verifier procedure; read-only; draft, not committed)_
