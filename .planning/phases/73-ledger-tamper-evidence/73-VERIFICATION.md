---
phase: 73-ledger-tamper-evidence
verified: 2026-11-03T16:04:08Z
status: human_needed
score: 8/8 must-haves verified (T2 counted as PASSED override)
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", "docs/greptime-ledger.md", "packages/cli/src/capsule.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/mcp-server/src/anchor-verify-deps.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/memory-policy.test.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/memory-record.ts", "packages/mcp-server/src/memory-retain.ts", "packages/mcp-server/src/memory-verify.ts", "packages/mcp-server/src/memory-write.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.ts", "packages/mcp-server/src/session-rollback.ts", "packages/mcp-server/src/types.ts"]
covered_digest: "v3:sha256:2fb20e5721b7b7b69e446610b7a27ef3bb20c66bb6bb5cd3262a2352bde9455c"
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "The chain head for each graph is recorded in the hourly anchor. That recorded head is the trusted earlier proof criterion 1 compares against; a head recomputed from the stored rows is never the proof."
    reason: "Owner accepted the commitment reading on 2026-11-02: each graph head is committed on chain by the memo v2 heads_root and recovered only through stored leaves that reproduce it. Carried from the prior record; acceptance not re-obtained here. This override covers the commitment reading only. It does not cover the write-path items W-L3b, W-K1 and W-K3 below."
    accepted_by: "owner"
    accepted_at: "2026-11-02"
re_verification:
  previous_status: human_needed
  previous_score: 8/8 (T2 counted as PASSED override)
  previous_verified: 2026-11-03T15:41:41Z
  previous_scope: "worktree /root/src/worktrees/as-gsd-v18-all, HEAD 8a604455 (9b0fa1f9 records only on top)"
  scope: "worktree /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 4b84e50c (the only code commit since 8a604455; it changes the repo access and visibility comparisons and the session-context parse)"
  reason: "4b84e50c reverts the repo access and visibility comparisons to exact normalizeIdentifier on both sides (memory-policy.ts parseScope, grantedToCaller, visibleToCaller; index-store.ts memorySearch and memoryForBrief; memory-write.ts repo; service.ts recall, memoryRead, recallMemories and memoryVerify caller repo; session-context.ts parse; capsule.ts repo filter). Ledger write (event.ts:407) and every ledger read stay on normalizeKey. The pass re-checks the six-field refusal, the normalizeKey parity for the ledger, the straddle items, and the chain-verify carried truths for regression."
  gaps_closed:
    - "No phase 73 gap closed by 4b84e50c. Its regression for the access leak is in phase 72's scope; the ledger write path is unchanged."
  gaps_remaining:
    - "W-L3b: branch, node_id and linear_identifier still take the 512-unit cut without the dangling-high trim (unchanged, event.ts:403, :404, :408)"
  gaps_new:
    - "W-M1 (memory plane, WARNING): a repo scope or memory repo spelled with a lone high surrogate at the 512-unit cut is now kept untrimmed (parseScope, memory-policy.ts:69-71; memory-write.ts:565). The memory entry hash covers the scope, so the stored row no longer reproduces its entry_hash and memory verify reports hash-mismatch. Fail-closed; no tamper is hidden. Introduced by 4b84e50c relative to 8a604455."
  regressions: []
human_verification:
  - test: "Devnet 0-lamport pointer probe: send a 0-lamport pointer to an unfunded index address and record the refusal text"
    expected: "The refusal text decides POINTER_REFUSED_RE (anchor.ts:85) and whether the funded path is ever needed. Record the answer in the phase."
    why_human: "Needs devnet, a funded test key and a live send. The verifier does not send transactions."
  - test: "Live devnet send of one pointer whose graph id is 512 UTF-8 bytes, read back with transactionMemo"
    expected: "The transaction serialises within the 1,232-byte limit, and the measured size replaces the hand-counted 251-byte overhead (memo.test.ts:231-241)."
    why_human: "Needs a live send. The overhead is hand-counted and not measured from transferArgv."
  - test: "Scan the live agent_events store: graph_id over 512 bytes, any graph_id containing a NUL byte, any graph_id or summary, session_id, repo, branch, node_id or linear_identifier containing a U+FFFD, and v2 memos in the anchor listings"
    expected: "Zero rows, or an owner decision on each. A stored U+FFFD cannot be told from a lone-surrogate write by the scan alone. The scan is the only way to size the pre-change straddling rows (owner item O-S1 below)."
    why_human: "Needs read access to the live store."
  - test: "RPC history depth for index addresses (N5): find the oldest signature still listed on a job-key address and on an index address"
    expected: "The depth is known. The owner decides whether a pruned pointer for an old hour is acceptable, as the accepted limit already states. The depth is still unmeasured."
    why_human: "Needs live RPC. The acceptance is recorded; the depth is not."
  - test: "Budget measurement for a year-old graph (W-N8): time verifyGraph under the 30 s default (config.ts:1207)"
    expected: "A measured time. The default changes only if the measurement exceeds 30 s."
    why_human: "Needs live data at realistic size."
  - test: "Owner decision on stored graph ids over 512 bytes or containing NUL, and on pre-fix rows with a lone surrogate (no data repair decided)"
    expected: "A recorded decision. Until then a live anchor run against a store holding over-512 or NUL rows halts at the first such hour (anchor.ts:958-967)."
    why_human: "Data-repair policy. Owner call."
  - test: "O-S1 (owner data decision): pre-change straddling rows. Decide between (a) accepting that a pre-change session_id, repo, branch, node_id or linear_identifier that straddled 512 units is a fail-closed verdict, recorded as accepted, or (b) a read alias that also matches the pre-change stored spelling. agent_events is append-only (assertAppendOnly, greptime.ts:446), so no in-place repair is available."
    expected: "A recorded decision for each of the five fields. Under (b): one named alias, and a test that a pre-change row is found by its id. Under (a): the verdict is recorded as accepted."
    why_human: "Data decision. The owner's list covers session_id and repo only; the three other fields are not on it yet."
  - test: "W-L3b owner decision: branch, node_id and linear_identifier take the same dangling-high trim as session_id and repo at the 512-unit cut (a stored-form and read-key change for node_id and linear_identifier queries), or the fail-closed verdict is recorded as accepted"
    expected: "A recorded decision. If trimmed: normalizeKey on those three at event.ts:403, 404, 408, every read site for node_id and linear_identifier moved to the same key, and a test that a 512-unit id with a pair at the cut round-trips. If accepted: recorded as accepted."
    why_human: "Scope decision the owner has not yet taken. 8a604455 refuses caller lone surrogates in these fields but leaves the cut alone."
  - test: "W-M1 owner decision: a repo scope (memory-policy.ts parseScope) and a memory repo (memory-write.ts:565) spelled with a lone high surrogate at the 512-unit cut. Either refuse a lone surrogate in those two fields at write, by name, as the six-field rule does, so the stored form is the hashed form, or record the memory verify hash-mismatch for such rows as accepted"
    expected: "A recorded decision. Trimming the stored scope is not an option: it would make a repo:owner/name+surrogate row visible to a caller granted owner/name, the leak 4b84e50c closes. If refused: a named test that a straddling repo scope is refused and that the stored scope equals the hashed scope."
    why_human: "Policy choice between a write refusal and an accepted verdict. Owner call. The hash-mismatch on a stored U+FFFD is [INFERENCE] until a live row is read back."
  - test: "W-K1 owner or maintainer decision: checkpoint_verify's session_id (mcp.ts:992, up to 512 units) is searched raw (anchor-verify-deps.ts:216). Route it through normalizeKey, or record the not-found outcome for a straddling or redacted session_id as accepted."
    expected: "A recorded decision. If routed: one normaliser on the lookup, and a test that a 512-unit session_id with a pair at the cut finds its checkpoint."
    why_human: "The commit's claim that anything reading by these columns goes through normalizeKey does not hold for this site. Maintainer call."
  - test: "W-K3 decision: graph_index.repo (Postgres) is written raw by graph_register (index-store.ts:1175; mcp.ts:1288 has no length cap) and read through normalizeKey (claimedNodesForRepo, service.ts:3973 and index-store.ts:1757). Write the normalised repo, or accept the mismatch for repos over 511 units or redacted spellings."
    expected: "A recorded decision and, if written normalised, a migration note that existing graph_index rows keep their raw spelling."
    why_human: "Postgres index, outside the ledger. Owner call on whether the read or the write moves."
  - test: "HARD-S3: decide whether scheduled verification is in this phase or a later one, and name the trusted earlier proof for it"
    expected: "A decision recorded against REQUIREMENTS.md:114 and :135."
    why_human: "Scope decision. Still open."
  - test: "W4: restate or retire the recorded label 'No verdict-level payload test'"
    expected: "A restated gap that names the missing test, or retirement of the label. service.test.ts:5386 asserts verdict-level fields."
    why_human: "The label has no definition in the repo beyond the prior record. Owner call."
  - test: "W-O1 wording: the commit body says a refused write reads nothing from the store. Either restate it as 'the six text fields are refused before the tip read', or move the graph id check (normalizeGraphId) ahead of the tip read for unkeyed sessioned writes"
    expected: "The commit record matches the code. Under the move: one test that a graph id with a lone surrogate, a NUL or over the byte cap is refused with lastHash uncalled."
    why_human: "Wording or a small ordering change. Owner call; no integrity effect either way."
---

# Phase 73: Ledger tamper evidence Verification Report

**Phase Goal:** A rewrite, reorder, deletion or tail truncation of the event ledger is detected by recomputing the chain from stored rows, and the verified head is anchored.
**Verified:** 2026-11-03T16:04:08Z
**Status:** human_needed
**Re-verification:** Yes, after 4b84e50c. Scope: the repo access and visibility change (its effect on phase 73's ledger read paths and on the carried truths), the six-field refusal and the straddle items as carried. Carried truths T1 to T8 get a regression check, not a re-judgement.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| T1 | SC1: an edited payload, a deleted middle event, truncated last events and a full rewrite are each compared with the saved head; the first differing or first missing id is named | ✓ VERIFIED (carried) | Named runs: `service.test.ts:5494` (first_differing), `:5506` (middle deletion), `:5522` (truncation, first_missing), `:5621` (full rewrite). `headRecordsFromLeaves` event.ts:512, `compareToAnchoredHead` event.ts:553, `verifyChain` event.ts:589-603 unchanged. 4b84e50c does not touch the chain check or its tests. |
| T2 | SC2: each graph's chain head is recorded in the hourly anchor and the recorded head is the trusted proof | ✓ PASSED (override) | Memo v2 `heads_root` present (`packages/ledger/src/memo.ts:12`, `MEMO_V2_RE`). Owner override 2026-11-02, commitment reading only; carried, acceptance not re-obtained here. |
| T3 | G1: an anchored hour removed from `agent_events`, `event_ingest` and `graph_chain_leaves` fails the verdict and is named | ✓ VERIFIED for pointer-listed hours, bounded by Q8 and N5 (accepted limits) | Carried: `service.test.ts:5918`, `:5927`, `:5935` (pointer-listed hours), `:5702` and `:5752` (rows and ingest removed, leaves kept), `:5951` (Q8: no pointer, ok, untrusted). Q8 and N5 are accepted limits, not closed. |
| T4 | The hourly job sends every closed hour's pointers for every graph id the write path accepts, so the job does not halt on a valid event | ✓ VERIFIED (carried, graph id); the text-field write path is refused or trimmed as judged below | Graph id: NUL `event.ts:299`, lone surrogate `event.ts:300-301`, `memo.ts:103`; tests `event.test.ts`, `memo.test.ts:156-166`, `anchor.test.ts:1519`. The six-field refusal (Judgement 1) adds to this at write. |
| T5 | N1/W2: the hour is sent, then pointers, then the row; a pointer failure stores no row; an unanchored mismatch stores no row | ✓ VERIFIED (carried) | Whole-file pass of `anchor.test.ts` at 046fbe05, unchanged since. Code `anchor.ts:868-896`, `:1044-1056`. |
| T6 | N2: the adoption window covers the lookback's newer transactions | ✓ VERIFIED (carried) | `anchor.test.ts:1404`; `anchor.ts:315`, `:850`; `greptime.ts:1900-1905`. |
| T7 | N3: verify counts only job-key pointers that succeeded; other entries are ignored; a job-key pointer naming another hour still fails | ✓ VERIFIED (verify side, carried) | `service.test.ts:5985`, `:5997`, `:6006`, `:6015`, `:6024`, `:6034`; code `service.ts:875-893`, `:924-960`. Anchor side (`anchor.ts:633`, `:643`) still untested (W-N3c). |
| T8 | Refused `SOLANA_RPC_URL`: no chain read, `ok` false, `trusted` false, a named reason | ✓ VERIFIED (carried) | `service.test.ts:4391`; `service.ts:8024-8026` (refusal before any RPC call). |

**Score:** 8/8 truths verified (T2 counted as PASSED override). Presence-only truths: none. Behavior unverified: 0.

The checks from the prior record, judged again at 4b84e50c:

| #  | Check | Status | Evidence |
| -- | ----- | ------ | -------- |
| R1 | Six-field refusal: a lone surrogate in summary, session_id, repo, branch, node_id or linear_identifier is refused at write by name, before any hash or store write | ✓ VERIFIED (unchanged code) | `assertWriteTextFields` event.ts:277-286; called from `normalizeEvent` event.ts:392, before the hash at :416. 4b84e50c does not touch event.ts. Targeted run below. |
| R2 | The refusal runs before the sessioned chain-tip read, the replay lookup, the buffer and the append-mode probe | ✓ VERIFIED for the six fields (unchanged code) | `service.ts:3093` assert is the first statement of `appendChained` (:3091); tip read `lastHash` :3119. Line numbers unchanged: 4b84e50c is count-neutral in service.ts. |
| R3 | normalizeKey read and write parity for the LEDGER (session_id and repo) | ✓ VERIFIED for the ledger write and every ledger read; the prior site list is stale for memory-plane sites moved by 4b84e50c (see Judgement 3) | Write: `event.ts:401`, `:407` (normalizeKey, unchanged). Ledger reads on normalizeKey: `brief.ts:448`; `service.ts:3014`, `:3297`, `:3973` (sessionContext re-normalises with normalizeKey before the ledger read at `:4020`), `:4095`, `:4628`, `:4663`, `:4924`, `:7612`, `:7803`/`:7823`; `session-rollback.ts:287`; `cli/src/capsule.ts:414` (session filter). |
| R4 | A session_id or repo that straddles 512 units round-trips: stored, looked up and read back in one form | ✓ VERIFIED (targeted run) | Named tests "a session id straddling the cap is stored, looked up and read back in one form" and "a repo straddling the cap is stored and read back in one form" pass in the run below. |
| R5 | 4b84e50c regression test: a row with repo `owner/name` plus a lone high surrogate is not visible to a caller granted `owner/name`; a scope spelled with a surrogate keeps it | ✓ VERIFIED (targeted run) | `memory-policy.test.ts` "a repo keeps its exact spelling for visibility ..." passes. It is a phase 72 access test; it is recorded here because it sets the memory-plane spelling that Judgement 5 finds. |

### Judgement 1: the six-field refusal (8a604455, unchanged at 4b84e50c)

**Code.** `assertWriteTextFields` (event.ts:277-286) checks the six fields by name. It runs in `normalizeEvent` (event.ts:392) and as the first statement of `appendChained` (service.ts:3093). The check runs on `redact(text)`, the text that gets stored before the cap.

**Targeted run (one command, this pass).** `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test packages/mcp-server/src/event.test.ts packages/mcp-server/src/service.test.ts packages/mcp-server/src/memory-policy.test.ts -t "surrogate|straddl|normalizeKey|assertWriteTextFields|exact spelling" --timeout 30000`: 28 pass, 0 fail, 415 filtered. The prior run was 27 pass on the first two files; the one addition is the 4b84e50c regression test. The "fail before, pass after" claims are carried, not re-run.

**Verdict:** VERIFIED for caller-supplied lone surrogates in all six fields, and for the refusal's place before the tip read.

### Judgement 2: the cap straddle for branch, node_id and linear_identifier (W-L3b, open, unchanged)

`event.ts:403` and `:404` keep `normalizeIdentifier` (node_id, linear_identifier) and `:408` keeps `clean` (branch). None trims a dangling high at the 512-unit cut. Prior probe (8a604455, same code, carried): a 511-unit prefix plus a pair gives a stored trailing U+D83D, a wire form containing U+FFFD (URLSearchParams in `greptime.ts` `send`), and a hash of the stored form that differs from the in-memory hash. `verifyChain` (event.ts:593-597) then reports `hash does not match contents`. This is a false verify on an untampered event; it fails closed. No test covers the straddle for these three fields.

**Verdict:** WARNING, open, named W-L3b. Owner item.

### Judgement 3: normalizeKey read and write parity (ledger), and what 4b84e50c moved

**Ledger (phase 73 scope).** The ledger write uses `normalizeKey` for session_id and repo (event.ts:401, :407). Every ledger read the chain and pointer code and the brief/session-context paths use is still on `normalizeKey`: `brief.ts:448` (`WHERE "repo" = normalizeKey(repo)`), `service.ts:3297` (`filterText("repo", ..., normalizeKey)`), and `sessionContext` (service.ts:3972-4020). `sessionContext` takes the parse-level value, which is now `normalizeIdentifier` (session-context.ts:413), and re-normalises it at service.ts:3973 with `normalizeKey` before `recentForRepo(stored)` at :4020. `normalizeKey(normalizeIdentifier(x)) === normalizeKey(x)` because `withoutDanglingHigh` is applied last, so the ledger read matches the ledger write. The brief path (service.ts:4095) and the drift path (service.ts:7803, :7823) are also on `normalizeKey`. No ledger read was moved to `normalizeIdentifier` by 4b84e50c.

**Memory plane (moved by 4b84e50c, by design).** These sites now use `normalizeIdentifier` for repo, per the commit's access rule: `memory-policy.ts:69-71` (parseScope), `:431`, `:452-453` (grantedToCaller, visibleToCaller); `memory-write.ts:565`; `index-store.ts:2650`, `:2682`; `service.ts:2501`, `:3647`, `:3735`, `:4592`; `session-context.ts:413`; `capsule.ts` repo filter; `types.ts` doc. The prior record listed some of them as ledger-parity sites; that listing is withdrawn. Their effect on the memory plane is Judgement 5.

**Reads that do not go through the key (unchanged, named):**

- **W-K1, pre-existing, not in 4b84e50c.** `checkpoint_verify` takes `session_id` (mcp.ts:992, `max(512)`) and passes it raw: `service.ts:4557` → `verifyCheckpointRef` → `findCheckpoint` (anchor-verify-deps.ts:213-217, `match: { kind: "note", session_id: lookup.sessionId }`). Not-found for straddling or token-shaped ids; fails closed.
- **W-K2, `[INFERENCE]`, low.** Live-session reads (`service.ts:6594` and the comparisons in `session-context.ts`) compare the raw session id. `SESSION_ID_RE` (`planning/presence.ts:18`) bounds it, so no straddle is reachable.
- **W-K3, pre-existing, Postgres, outside the ledger.** `graph_register` writes `plan.repo` raw (`index-store.ts:1175`), `claimedNodesForRepo` reads `normalizeKey(repo)` (`service.ts:3973`, `index-store.ts:1757`).

**Verdict on parity:** VERIFIED for every ledger read path and the ledger write path. PARTIAL for W-K1, W-K2, W-K3 as named. The memory-plane change is a separate judgement.

### Judgement 4: the pre-existing straddling rows (open owner item O-S1, unchanged)

Unchanged by 4b84e50c. Rows whose session_id, repo, branch, node_id or linear_identifier straddled 512 units before the change are stored as 511 units plus U+FFFD (transport), already fail `verifyChain`, and are not found by a read of the same id. `assertAppendOnly` (greptime.ts:446-458) blocks any in-place repair. Owner options (a) accepted fail-closed verdict or (b) read alias are unchanged. Five fields, not two.

### Judgement 5: memory-plane straddle introduced by 4b84e50c (W-M1, new, WARNING)

4b84e50c moved parseScope's repo id from `normalizeKey` (trims a dangling high) to `normalizeIdentifier` (keeps it). Probe (read-only `bun` script under `/tmp`, not a test, removed after the run):

| Input | Units | Last unit | Wire (URLSearchParams) |
| ----- | ----- | --------- | ---------------------- |
| `normalizeIdentifier('a'.repeat(511) + U+1F600)` | 512 | U+D83D | contains U+FFFD |
| `normalizeKey(same)` | 511 | U+0061 | no U+FFFD |

Consequence chain, from the code:

1. `parseScope` (memory-policy.ts:69-71) has no length cap, so `repo:<511 units + pair>` gives `canonical` = `repo:` + the 512-unit id with a lone high.
2. The entry hash covers `scope.canonical` (`contentHash` over `scope.canonical`, memory-write.ts ~590-602; `contentOf` in memory-record.ts:122-123 includes `scope`). The write is accepted and hashed over the lone-high form.
3. The stored scope is written to the memory index. Read back, it is the U+FFFD form `[INFERENCE: postgres.js UTF-8 encoding, as with the ledger transport; not read back live]`.
4. `verifyMemoryRecord` recomputes `entryHashFor(contentOf(entry))` (memory-verify.ts:173-183) and returns `hash-mismatch`: "the row changed after the gate wrote it".

Before 4b84e50c (8a604455), parseScope used `normalizeKey` for repo, so the stored scope and the hashed scope agreed. The new behaviour is a regression at this commit, not a pre-existing condition. It is fail-closed: a legitimately written memory row is reported as tampered. No tamper is hidden. The memory repo (memory-write.ts:565) has the same untrimmed form in its request hash (`requestHash`, not the content hash), which is not verified in this pass.

Trimming the stored scope is not an acceptable repair: it would make a `repo:owner/name` plus surrogate row visible to a caller granted `owner/name`, which is the leak 4b84e50c closes. The choices are the owner's: refuse a lone surrogate in a repo scope and a memory repo at write, by name, as the six-field rule does (so stored form equals hashed form), or record the memory hash-mismatch for such rows as accepted.

**Verdict:** WARNING (new). Not a FAILED truth: phase 73's must-haves are ledger truths, and the ledger is unchanged by this commit. Logged as the owner item W-M1. Not a re-verification blocker because no phase 73 truth depends on the memory plane.

## Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/event.ts` | Six-field refusal, normalizeKey, graph id refusal, cap trim, verdict helpers | ✓ VERIFIED (unchanged at 4b84e50c) | `normalizeKey` :216-218; `clean`/`normalizeIdentifier` :180-209 (W-L3b at :403, :404, :408); `refuseLoneSurrogate` :267-271; `assertWriteTextFields` :277-286; `normalizeGraphId` :296-305; `normalizeEvent` :381-417; `withoutDanglingHigh` :190-196; `headRecordsFromLeaves` :512; `compareToAnchoredHead` :553; `verifyChain` :589-603. |
| `packages/mcp-server/src/event.test.ts` | Named tests for the refusal, the key and the straddle | ✓ VERIFIED (targeted run) | No straddle test for branch, node_id or linear_identifier (W-L3b). |
| `packages/mcp-server/src/service.ts` | Refusal before tip read; normalizeKey at the ledger sites | ✓ VERIFIED for the appendChained order and the ledger sites | `appendChained` :3091-3093; `lastHash` :3119; `build` :3125. Changed by 4b84e50c at :2501, :3647, :3735, :4592 (memory plane, count-neutral). `checkpointVerify` :4557 passes raw session id (W-K1). |
| `packages/mcp-server/src/service.test.ts` | Refusal before tip read; straddle round trip | ✓ VERIFIED (targeted run) | Both "before it reads the chain tip" tests pass. File unchanged by 4b84e50c. |
| `packages/mcp-server/src/memory-policy.ts` | Repo scope id (parseScope) | ⚠️ WARNING (W-M1) | `parseScope` :69-71 now `normalizeIdentifier` for repo; the scope is hashed; see Judgement 5. |
| `packages/mcp-server/src/memory-policy.test.ts` | Exact-spelling visibility regression | ✓ VERIFIED (targeted run) | Passes. Does not cover the stored-scope hash for a straddling repo (W-M1). |
| `packages/mcp-server/src/memory-write.ts` | Memory repo (request hash) | ⚠️ WARNING (W-M1, request hash) | `repo = normalizeIdentifier(request.repo)` :565; not verified against the request hash in this pass. |
| `packages/mcp-server/src/anchor-verify-deps.ts` | Checkpoint lookup session id | ✗ NOT NORMALISED (W-K1) | `findCheckpoint` :213-217, `verifyCheckpointRef` :598. Not touched by 4b84e50c. |
| `packages/mcp-server/src/index-store.ts` | normalizeKey for graph_index repo reads | ⚠️ PARTIAL (W-K3) | `registerGraph` writes raw repo at :1175. Memory reads at :2650, :2682 now `normalizeIdentifier` (memory plane). |
| `packages/mcp-server/src/session-context.ts` | Ledger context read | ✓ VERIFIED (via service re-normalisation) | :413 parse now `normalizeIdentifier`; service.ts:3973 re-normalises with `normalizeKey` before the ledger read at :4020. |
| `packages/mcp-server/src/types.ts` | MemoryReadOptions doc | ✓ VERIFIED | Doc only (4b84e50c). |
| `packages/ledger/src/memo.ts` | v2 heads_root memo; v3 pointer memo; graph id refusal | ✓ VERIFIED (carried) | `MEMO_V2_RE` :12; v3 at :98; lone surrogate :96-106. |
| `packages/mcp-server/src/greptime.ts` | Single INSERT path with JSON payload; append-only guard | ✓ VERIFIED | `insertEvent` payload `JSON.stringify` :1276; `assertAppendOnly` :446. |
| `packages/mcp-server/src/anchor.ts` | Pointer send and refusal before send | ✓ VERIFIED (carried) | `pointerPlans` :553-562; pre-send :958-967; post-read-back pointers :1044-1056; `POINTER_REFUSED_RE` :85. |
| `packages/mcp-server/src/memory-verify.ts` | Memory entry hash check | ⚠️ WARNING (W-M1) | `hash-mismatch` :173-183 reachable for a straddling repo scope. |
| `docs/greptime-ledger.md` | Memo v3 section and accepted limits | ✓ VERIFIED (carried, not changed by 4b84e50c) | The field-level refusal and the cap trim are not described there. Not a verdict input. |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `normalizeEvent` | `assertWriteTextFields` | first check after shape checks, event.ts:392 | ✓ WIRED | Before the hash at :416. |
| `appendChained` | `assertWriteTextFields` | first statement, service.ts:3093 | ✓ WIRED | Before the replay lookup :3100 and the tip read :3119. |
| `normalizeEvent` | `normalizeKey` | session_id and repo, event.ts:401, :407 | ✓ WIRED | One key for write and for the ledger read sites. |
| `normalizeEvent` | `normalizeIdentifier` | node_id, linear_identifier, branch (`clean`), event.ts:403, :404, :408 | ⚠️ PARTIAL | No dangling-high trim at the cut (W-L3b). |
| `normalizeEvent` | `normalizeGraphId` | graph_id, event.ts:402 | ✓ WIRED | NUL, lone surrogate and byte cap refused. Refusal runs after the tip read on unkeyed sessioned writes (W-O1). |
| `sessionContext` | ledger `recentForRepo` | `normalizeKey(request.repoId)`, service.ts:3973 → :4020 | ✓ WIRED | Parse-level `normalizeIdentifier` is re-normalised before the ledger read. |
| `parseScope` (repo) | memory entry hash | `scope.canonical`, memory-policy.ts:69-71 → memory-write.ts content hash | ⚠️ PARTIAL | Untrimmed lone high reaches the hash (W-M1). |
| `checkpointVerify` | `findCheckpoint` | raw `session_id`, service.ts:4557, anchor-verify-deps.ts:216 | ✗ NOT_WIRED to the key | W-K1. |
| `graph_register` | `graph_index.repo` | raw `plan.repo`, index-store.ts:1175 | ⚠️ PARTIAL | W-K3. |
| `insertEvent` | stored text fields | URLSearchParams body (`send`) | ✓ WIRED for the six fields | Lone surrogates no longer reach it from the six fields. The three cap-straddle fields still can (W-L3b). |
| `verifyChain` | stored row | `eventHash(rest)` recompute, event.ts:593 | ✓ WIRED | The source of the false verify for W-L3b and O-S1 rows. |

## Data-Flow Trace (Level 4)

Chain and pointer data come from the store (`readEvents`, `hourLeaves`, `graphChainLeafHours`) and from RPC (`addressSignaturePage`, `transactionMemo`). Real queries, not static returns: ✓ FLOWING (carried). The `checkpoint_verify` lookup (W-K1) is a real query with the un-normalised key: ✓ FLOWING but mis-keyed for the affected spellings. The memory entry verify (W-M1) recomputes from the stored row: ✓ FLOWING, with a fail-closed mismatch for straddling repo scopes.

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Six-field refusal, straddle, key and exact-spelling tests, targeted | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test packages/mcp-server/src/event.test.ts packages/mcp-server/src/service.test.ts packages/mcp-server/src/memory-policy.test.ts -t "surrogate\|straddl\|normalizeKey\|assertWriteTextFields\|exact spelling" --timeout 30000` | 28 pass, 0 fail, 415 filtered | ✓ PASS |
| Straddle at 512 for repo scope (memory plane) | read-only `bun` probe of `normalizeIdentifier` and `normalizeKey` (not a test; removed) | 512 units, last U+D83D, wire has U+FFFD; `normalizeKey` gives 511 | ✗ FAIL (W-M1) |
| Straddle at 512 for branch, node_id, linear_identifier | prior probe, 8a604455, code unchanged at 4b84e50c | stored trailing U+D83D; wire contains U+FFFD | ✗ FAIL (W-L3b, carried) |
| Straddle at 512 for session_id, repo (ledger) | prior probe, 8a604455, ledger write unchanged | stored 511 units; hash of the stored form matches | ✓ PASS |
| Each of six fields refused by name | prior probe, 8a604455, code unchanged | six `<field>_lone_surrogate` refusals | ✓ PASS |
| Fail-before for the commit tests | parent checkout | not run in this pass | ? SKIP (carried from the commit record) |
| Carried truths T1 to T8 | not re-run in this pass (one targeted command, used above) | carried from 8a604455 record; no code or test change on their paths in 4b84e50c | ✓ CARRIED |

## Probe Execution

No probe scripts declared or present for this phase (`scripts/*/tests/probe-*.sh` not declared in the phase plan). Not applicable.

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-S3 | 73-01 | Chain canonical checksums; on-demand and scheduled verification detect modified, deleted, gapped or reordered entries and report the first bad position; name the trusted earlier proof | ? NEEDS HUMAN (open) | On-demand verify is present; criterion 1 named tests pass. Scheduled verification was not judged in this pass. The trusted earlier proof is named: the anchored on-chain head (T2 override). `REQUIREMENTS.md:114` and `:135`. |

Orphaned requirements: none. `REQUIREMENTS.md:135` is the only row mapped to phase 73.

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/event.ts` | 403, 404, 408 | `node_id`, `linear_identifier`, `branch` cut at 512 without the dangling-high trim | ⚠️ Warning | W-L3b: a legitimate write is stored with U+FFFD and fails `verifyChain`. Fail-closed. |
| `packages/mcp-server/src/event.test.ts` | straddle describe | No straddle test for branch, node_id or linear_identifier | ⚠️ Warning | Coverage gap behind W-L3b. |
| `packages/mcp-server/src/memory-policy.ts` | 69-71 | Repo scope id kept untrimmed at the cut; no surrogate refusal on scope | ⚠️ Warning | W-M1: a legitimate memory row is reported `hash-mismatch`. Fail-closed. New at 4b84e50c. |
| `packages/mcp-server/src/anchor-verify-deps.ts` | 213-217 | `checkpoint_verify` session lookup not normalised | ⚠️ Warning | W-K1: `not-found` for straddling or token-shaped session ids. Pre-existing. |
| `packages/mcp-server/src/service.ts` | 3091-3125 | Unkeyed sessioned write reads the tip before a graph id refusal | ⚠️ Warning | W-O1: wording and ordering; no row written; no integrity effect. |
| `packages/mcp-server/src/index-store.ts` | 1175 | `graph_register` writes repo raw | ⚠️ Warning | W-K3: Postgres, pre-existing. |
| `packages/mcp-server/src/service.ts` | 6594 | Raw session id read and equality filter | ℹ️ Info | W-K2: bounded by `SESSION_ID_RE`; low. |
| `packages/mcp-server/src/anchor.ts` | 633-643 | Anchor-side payer and err skip in `completePointers` untested | ⚠️ Warning | W-N3c (carried). |
| `packages/ledger/src/memo.test.ts` | 231-241 | Transaction overhead hand-counted, not measured from `transferArgv` | ⚠️ Warning | B1 model unverified (carried). |

## Human Verification Required

Listed in the frontmatter. The items that are new in this pass:

1. **W-M1, the memory-plane straddle introduced by 4b84e50c.** A repo scope and a memory repo with a lone high at the cut. Refuse at write, or record the hash-mismatch as accepted. Trimming is excluded.
2. **O-S1, the pre-change straddling rows.** Five fields, unchanged; not widened further by this commit (the new rows are W-M1, not pre-change rows).

Carried, unchanged: W-L3b, W-K1, W-K3, W-O1, the devnet and live-store items, N5, W-N8, the stored-id decision, HARD-S3, W4.

## Gaps Summary

No truth is FAILED. No artifact is MISSING or STUB. No must-have is blocked. The status is `human_needed` because the human-verification list is non-empty.

Against the commit's own claims:

- The ledger parity claim holds: 4b84e50c moved no ledger read or write off `normalizeKey`, and the one ledger read that starts from a moved value (session context) is re-normalised before the ledger query.
- The prior record's R3 list of ledger-parity sites is stale for the memory-plane sites the commit moved. Withdrawn as ledger evidence; recorded as the memory plane in Judgement 3.
- New WARNING W-M1: a repo scope with a lone high at the cut is hashed untrimmed and reported `hash-mismatch` on a memory read. Fail-closed. Owner decision.
- Open and unchanged: W-L3b, W-K1, W-K2, W-K3, W-O1, O-S1, and the carried accepted limits.

## Verdict

**Status: human_needed.** Score 8/8 truths verified (T2 by override). The ledger truths and checks R1, R2, R4 verify at 4b84e50c; R3 verifies for the ledger, with the memory-plane sites moved by the commit stated separately. R5 (the 4b84e50c regression test) verifies. W-M1 is a new WARNING for the owner. W-L3b, W-K1, W-K3, W-O1 and O-S1 remain open as named. Q8 and N5 remain accepted limits, not closed.

---

_Verified: 2026-11-03T16:04:08Z_
_Verifier: Claude (gsd-verifier)_
