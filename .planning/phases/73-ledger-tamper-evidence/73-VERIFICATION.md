---
phase: 73-ledger-tamper-evidence
verified: 2026-11-05T07:59:55Z
status: human_needed
score: 8/8 must-haves verified (T2 counted as PASSED override)
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", "docs/greptime-ledger.md", "packages/cli/src/capsule.ts", "packages/ledger/src/heads.test.ts", "packages/ledger/src/heads.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/mcp-server/src/anchor-verify-deps.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/checkpoint-verify.test.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index-store.test.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/memory-policy.test.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/memory-record.ts", "packages/mcp-server/src/memory-retain.ts", "packages/mcp-server/src/memory-verify.ts", "packages/mcp-server/src/memory-write.test.ts", "packages/mcp-server/src/memory-write.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.ts", "packages/mcp-server/src/session-rollback.ts", "packages/mcp-server/src/types.ts"]
covered_digest: "v3:sha256:27614237279ea4991a8fe337c389a959f0f0f3f64f9fe921a07c8e513875425f"
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
  previous_verified: 2026-11-05T07:11:11Z
  previous_scope: "worktree /root/src/worktrees/as-gsd-v18-all, HEAD 42e3cf13 (covered_digest v3:sha256:ec6a146f)"
  scope: "worktree /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 6e5d766e. Covered paths changed since 42e3cf13: packages/mcp-server/src/service.ts only (commit b4bdd0fc, +2 -1: the sync-lag hook in emit() also fires for a note the buffer holds or dead-letters). The covered list is unchanged (31 paths, verbatim). covered_digest moved from v3:sha256:ec6a146f to v3:sha256:27614237 because of that one file. The ledger write (appendChained), the handoff refusal, the chain tip, memo, graph_chain_leaves, verifyGraph and trustHour paths are unchanged apart from a one-line shift (+1 from line 3006 on). Non-covered changes in this range (event-buffer.ts, cache.ts, worktree.py, docs, tests) touch no phase 73 claim; see the section Re-verification at 6e5d766e."
  gaps_closed: []
  gaps_remaining:
    - "W-L3b: branch, node_id and linear_identifier still take the 512-unit cut without the dangling-high trim (event.ts:437, :438, :442, unchanged). Accepted limit, per the orchestrator's binding list and docs/greptime-ledger.md 'Not covered'. Stays open."
    - "O-S1: pre-change straddled rows. docs/greptime-ledger.md records the 2026-11-04 owner decision that they are left as they are. No live scan has been run to size them. Stays open."
    - "Q8 and N5: no pointer, and RPC history depth. Accepted limits; stay open as recorded."
    - "W-K3: Postgres graph_register repo write outside the ledger. Narrowed, not closed. index-store.ts:1175 and :2448 are unchanged since c40ffc9a (re-read at 6e5d766e, not probed). Stays open."
    - "HARD-S3: scope owner item (STATE.md:846). Stays open as recorded."
  gaps_new: []
  regressions: []
human_verification:
  - test: "Devnet 0-lamport pointer probe: send a 0-lamport pointer to an unfunded index address and record the refusal text"
    expected: "The refusal text confirms or refutes POINTER_REFUSED_RE (anchor.ts:91) and whether the funded path is needed. The narrowed pattern rests on the local solana-cli text; the full devnet line is [INFERENCE] until this runs."
    why_human: "Needs devnet, a funded test key and a live send. The verifier does not send transactions."
  - test: "Live devnet send of one pointer whose graph id is 512 UTF-8 bytes, read back with transactionMemo"
    expected: "The transaction serialises within the 1,232-byte limit, and the measured size replaces the hand-counted overhead (memo.test.ts)."
    why_human: "Needs a live send."
  - test: "Scan the live agent_events store: graph_id over 512 bytes, any graph_id containing a NUL byte, any graph_id, summary, session_id, repo, branch, node_id or linear_identifier ending in U+FFFD at 512 units, and v2 or v3 memos in the anchor listings"
    expected: "Zero rows, or an owner decision on each. The docs detection SQL is NOT RUN; verify character_length and substring against the store first."
    why_human: "Needs read access to the live store."
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
    why_human: "Needs read access to the live store."
  - test: "W-L3b owner decision: decide whether branch, node_id and linear_identifier take the dangling-high trim, or record the fail-closed verdict as accepted"
    expected: "A recorded decision; if trimmed, the change is listed in the W-L3b entry."
    why_human: "Stored-form and read-key change. Owner call."
---

# Phase 73: Ledger tamper evidence Verification Report

**Phase Goal:** A rewrite, reorder, deletion or tail truncation of the event ledger is detected by recomputing the chain from stored rows, and the verified head is anchored. Criterion 1 is proven by tests against a head saved before the change. Criterion 2 requires each graph's chain head to be recorded in the hourly anchor, and that recorded head is the only trusted proof.
**Verified:** 2026-11-05T07:59:55Z
**Status:** human_needed
**Re-verification:** Yes, after the 42e3cf13 record. Scope is HEAD 6e5d766e. Prior status human_needed, score 8/8. Line numbers below are at 6e5d766e.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| T1 | SC1: an edited payload, a deleted middle event, truncated last events and a full rewrite are each compared with the saved head; the first differing or first missing id is named | ✓ VERIFIED | Gate r33 JUnit (named passes, no skipped child): "a full rewrite with every hash and prev recalculated parts at the first event, and the verdict fails" (classname "heads trust (D73-03, D73-04) > verifyGraph hour report") and "sessions verify one by one, and the verdict is the same for every read order". This pass, targeted run 2 (regex includes `verif`, `rewrite`, `truncat`, `edited payload`): 0 fail. Earlier passes named "a deleted middle event is first_missing_event_id" and "truncated last events are first_missing_event_id". `event.test.ts` in full passes (run 1). Code: `compareToAnchoredHead` event.ts:587 (unchanged), `verifyGraph` service.ts:8049, `trustHour` service.ts:8546. |
| T2 | SC2: each graph's chain head is recorded in the hourly anchor and the recorded head is the trusted proof | ✓ PASSED (override) | Memo v2 `heads_root` present: `packages/ledger/src/memo.ts:11-12` (`MEMO_PREFIX_V2`, `MEMO_V2_RE`); `formatMemoV2` used by `anchor.ts` (`anchorRow`, ~line 501); `graph_chain_leaves` written before the anchor row (`anchor.ts:506`). `memo.test.ts`, `heads.test.ts` and `anchor.test.ts` pass (run 1). Owner override 2026-11-02, commitment reading only; carried, acceptance not re-obtained here. |
| T3 | G1: an anchored hour removed from `agent_events`, `event_ingest` and `graph_chain_leaves` fails the verdict and is named | ✓ VERIFIED for pointer-listed hours (Q8 and N5 accepted limits) | Gate r33 JUnit (named passes): "G1Probe, variant 1a: a trailing hour whose rows, ingest and leaves are gone fails the verdict naming it, though its anchors row is kept" and "G1Probe, variant 1b: the same with its anchors row removed too: the verdict still names the hour, through its pointer" (classname "v3 pointers: each hour of a graph is named by its own pointer"). This pass, run 2 matched `G1Probe` and `pointer`: 0 fail. "with no pointer either, a graph whose only hour is gone has no events on chain: ok, untrusted, no events" (`service.test.ts`, line 5971, unchanged file). Q8 (no pointer) and N5 (RPC depth) stay open as accepted limits. |
| T4 | The hourly job sends every closed hour's pointers for every graph id the write path accepts, so the job does not halt on a valid event | ✓ VERIFIED | Graph id refusals: NUL `event.ts` (`graph_id_nul`, event.ts:235) and over-cap `graph_id_too_long` (event.ts:225); both run before the chain tip read: `appendChained` (service.ts:3137) runs `assertWriteTextFields` (:3139) and `normalizeGraphId` (:3141) first, and the handoff path runs `normalizeGraphId` at service.ts:7676 before `placeOf` (:7685). Gate r33 JUnit (named passes): "refuses a NUL in the graph id before it reads the chain tip" (classname "emit", `service.test.ts:738`) and "refuses a lone surrogate in the handoff summary before it reads the chain tip" (classname "handoff", `service.test.ts:1669`). Both are in run 2's regex and pass. |
| T5 | N1/W2: the hour is sent, then pointers, then the row; a pointer failure stores no row; an unanchored mismatch stores no row | ✓ VERIFIED | Run 1: `anchor.test.ts` in full passes. Code: `anchor.ts` anchor sequence (hour, pointers, row) unchanged since 504da465 except POINTER_REFUSED_RE. |
| T6 | N2: the adoption window covers the lookback's newer transactions | ✓ VERIFIED | `anchor.test.ts` in full (run 1); `ADOPT_LOOKBACK_HOURS` `anchor.ts` unchanged in this range. |
| T7 | N3: verify counts only job-key pointers that succeeded; other entries are ignored; a job-key pointer naming another hour still fails | ✓ VERIFIED (verify side) | Run 2 regex includes `pointer`: "a pointer the job key did not sign, or that failed on chain, is ignored", "a pointer signed by another key is ignored", "a foreign-payer pointer", "an errored pointer", "a job-key pointer whose hour transaction names another hour" (`service.test.ts`, unchanged file). Anchor side (`anchor.ts` adoption pointer filter) still untested: W-N3c. |
| T8 | Refused `SOLANA_RPC_URL`: no chain read, `ok` false, `trusted` false, a named reason | ✓ VERIFIED | Run 2 regex includes `SOLANA_RPC_URL`: 0 fail. Code: `service.ts:8099` (guard message, refusal before any RPC call). |

**Score:** 8/8 truths verified (T2 counted as PASSED override). Behavior unverified: 0. Presence-only truths: none.

### Re-verification of the prior record's checks

| #  | Check | Status | Evidence |
| -- | ----- | ------ | -------- |
| R1 | Six-field refusal: a lone surrogate in summary, session_id, repo, branch, node_id or linear_identifier is refused at write by name, before any hash or store write | ✓ VERIFIED | `assertWriteTextFields` event.ts:310 (calls `assertRepoLength` as its last check); called from `normalizeEvent` (event.ts:426) and as the first statement of `appendChained` (service.ts:3139). `event.test.ts` in full passes (run 1). event.ts unchanged in this range. |
| R2 | The refusal runs before the sessioned chain-tip read, the replay lookup, the buffer and the append-mode probe | ✓ VERIFIED | `service.ts:3139` (assert) and `:3141` (graph id) are the first statements of `appendChained` (declared :3137), before the buffer stores and the tip read. Handoff refuses before `placeOf` and the tip read (service.ts:7676 and :7685). The b4bdd0fc hunk is in `emit()` (service.ts:3006), after `append()` returns, so it is not on this path. |
| R3 | normalizeKey read and write parity for the LEDGER (session_id and repo) | ✓ VERIFIED | Write: `event.ts:435` (session_id) and `:441` (repo), both `normalizeKey`. Checkpoint lookup: `anchor-verify-deps.ts` findCheckpoint `normalizeKey(lookup.sessionId)` (bb428f94). Named test "a checkpoint written under a straddling session id is found by that id and verifies as anchored" (`checkpoint-verify.test.ts`) passes (run 1). |
| R4 | A session_id that straddles 512 units round-trips: stored, looked up and read back in one form | ✓ VERIFIED (carried) | "a session id straddling the cap is stored, looked up and read back in one form" and "a repo longer than the cap is refused at write, naming the rule, and nothing is stored" (`service.test.ts`, 504da465 pass; not in this range's changed code). |
| R5 | 4b84e50c regression test: a row with repo `owner/name` plus a lone high surrogate is not visible to a caller granted `owner/name`; a scope spelled with a surrogate keeps it | ✓ VERIFIED (carried) | "a repo keeps its exact spelling for visibility ..." (`memory-policy.test.ts`). Not re-run this pass; `memory-policy.ts` unchanged in this range. |

### Judgement 1: the six-field refusal and the repo cap (8a604455, 4b84e50c, f1138c65)

**Code.** `assertWriteTextFields` (event.ts:310) checks the six fields by name, then the repo length (`assertRepoLength` event.ts:290, `RepoTooLongError`, `repo_too_long`, 512 code units, measured on the redacted text before any cap). It runs in `normalizeEvent` and as the first statement of `appendChained` (service.ts:3139). The index store (`index-store.ts:1175`, `:2448`, each `assertRepoLength(...)`) and the memory write (`memory-write.ts` decide(), `repoOverCap` plus `repoScopeOverCap`) refuse the same length before any store write.

**Verdict:** VERIFIED for caller-supplied lone surrogates in all six fields and for an over-512 repo on every write path read. The memory-plane refusal is code-verified only; `memory-write.test.ts` was not run in this pass or the prior one.

### Judgement 2: the cap straddle for branch, node_id and linear_identifier (W-L3b, open, accepted limit)

`event.ts:437` and `:438` keep `normalizeIdentifier` (node_id, linear_identifier); `:442` keeps `clean` (branch). None trims a dangling high at the 512-unit cut. event.ts is unchanged in this range. It fails closed (`verifyChain` reports `hash does not match contents` on an untampered row). No test covers the straddle for these three fields.

**Verdict:** WARNING, open, accepted limit (orchestrator's binding list). Owner item.

### Judgement 3: normalizeKey read and write parity (ledger)

Write: `session_id` and `repo` use `normalizeKey` (`event.ts:435`, `:441`). Reads through `normalizeKey` are as recorded at 4b84e50c; the checkpoint lookup is the one site that moved (bb428f94). W-K1 is closed for session_id. Token-shaped ids (`SESSION_ID_RE`) are not reachable as a straddle (W-K2, [INFERENCE], low).

**Verdict:** VERIFIED for the ledger write path and the ledger reads named in the prior record. W-K3 (Postgres `graph_register` raw repo write, `index-store.ts:1175` preceded by `assertRepoLength`) is narrowed: a repo over 512 units is refused, but a 512-unit repo ending in a caller-supplied lone high surrogate is still stored raw there. Pre-existing, outside the ledger. `index-store.ts` has no commit since c40ffc9a (checked at 6e5d766e), so this site was re-read, not probed.

### Judgement 4: the pre-existing straddling rows (O-S1)

Unchanged by this range. Rows whose session_id, repo, branch, node_id or linear_identifier straddled 512 units before 8a604455 are stored as 511 units plus U+FFFD, already fail `verifyChain`, and are not found by a read of the same id. `assertAppendOnly` (greptime.ts) blocks in-place repair. `docs/greptime-ledger.md` ("Identifiers at the 512-unit cut", line 370) records the owner decision of 2026-11-04 that they are left as they are. That is option (a) of the O-S1 list. The live scan that sizes them has not been run.

### Judgement 5: memory-plane straddle (W-M1)

Closed by refusal. A repo over 512 code units is refused at write (f1138c65), so `parseScope` and the memory write no longer store a cut repo, and the entry hash reproduces. Reads still cut a repo filter to fit (`parseScope`), which can miss a row whose repo was refused; no such row can be stored.

### Schema hash dependence (ebabe6ef): carried, re-checked at 6e5d766e

Question: does the ledger archive, or any phase 73 verify claim, depend on the index archive's `schemaHash` value?

**Answer: no.** Carried from the 835a2742 re-check; nothing in 42e3cf13..6e5d766e touches `index-store.ts` or `index-archive-spec.ts` (`git log c40ffc9a..6e5d766e` on both files is empty).

- The "index archive gained corpus_documents" change is ebabe6ef (feat(63)). It is an ancestor of the 835a2742 baseline, not part of this range. `corpus_documents` is in the index-store table list (`index-store.ts:702`, migration down/up at :704 and :804-806), and `corpus_documents` appears in the index-archive spec through that commit.
- `schemaHash()` (`index-archive-spec.ts:266`) is consumed by `index-archive.ts` only (manifest write `:502`, verify kind `schema` at `:694-695`). The other occurrence, `event-sources.ts:1021`, is a `HEX_64` literal inside a sample `index.archive` event, not a check.
- The ledger archive (`ledger-archive.ts`, `ledger-run.ts`, `substrate ledger verify-archive`) does not import `index-archive-spec.ts` and does not contain `schemaHash`. Its verify checks per-file SHA-256, line counts, event hashes, the chain, the hourly RFC 6962 roots and the anchors. No index schema change can alter its verdict.
- `graph_chain_leaves` is not in `ARCHIVE_TABLES` (0 matches in `index-archive-spec.ts`), so the index schema hash does not cover the ledger leaves table, and the index archive does not archive ledger data.

**Consequence:** the index archive's pre-ebabe6ef archives fail `verify-archive` (kind `schema`), which is the accepted behavior. No ledger archive or phase 73 verdict is affected. Note, not a gap: the ledger manifest records no schema or version, so the ledger archive has no schema-level compatibility check. That is a property of the ledger archive as built in uplift-3, not a phase 73 criterion.

## Re-verification at 42e3cf13 (carried)

Scope check at 42e3cf13: `git diff 835a2742..42e3cf13` over the 31 covered paths lists `service.ts` only (+53 −8: H-1 in-process last-good brief and the forget mark, commits 9e6fa1f2 and 9c86ffab). Not on the ledger write, handoff refusal, chain tip, memo, `verifyGraph` or `trustHour` path. Carried; see the 6e5d766e section for the current state.

## Re-verification at 6e5d766e

**Scope check.** `git diff 42e3cf13..6e5d766e --name-only` intersected with the 31 covered paths: `packages/mcp-server/src/service.ts` only. Commit b4bdd0fc (fix(70)), hunk `@@ -3002,7 +3002,8 @@` in `emit()`:

```
-		if (result.stored) this.corpusSlo.recordSyncLag(result.event.payload);
+		// The sync-lag reading follows a note the server took: stored, held in the buffer for a later write, or given up with a dead-letter record. A note the server did not take leaves the reading as it was.
+		if (result.stored || result.buffered === true || result.deadLettered === true) this.corpusSlo.recordSyncLag(result.event.payload);
```

Reading the hook. `emit()` (service.ts:2978) awaits `this.append(input, idem)` first (`append` at :3056 → `appendChained` at :3137). The hook runs after that call returns, with the same `result.stored` gate as before plus the two buffered and dead-lettered cases. It writes only the corpus SLO reading (`corpus/slo.ts:69` `recordSyncLag`, unchanged), not the ledger. The ledger chain write, `assertWriteTextFields`, `normalizeGraphId`, the chain tip read and the leaves and anchor code are unchanged. The added lines carry no TODO, FIXME, XXX, HACK or PLACEHOLDER.

Line moves at 6e5d766e (each located by grep; the code at each is unchanged): recordSyncLag 3005 to 3006; appendChained 3136 to 3137; its assert 3138 to 3139; its graph id refusal 3140 to 3141; handoff `normalizeGraphId` 7675 to 7676 and `placeOf` use 7684 to 7685; verifyGraph 8048 to 8049; Solana guard 8098 to 8099; trustHour 8545 to 8546; headsRoot comparison 8595 to 8596; compareToAnchoredHead call 8632 to 8633.

**Non-covered changes in the range, checked against the phase 73 claims:**

- `packages/mcp-server/src/event-buffer.ts` (commit 49b9aece, fix(76)): `abandonAll` now gives up the in-flight entry too and records it at once. The record goes through `onDeadLetter`, which `service.ts:2115` wires to `deadLetters.record`. `event-dead-letter.ts` has no reference to `appendChained`, `greptime` or `ledger` (grep). So the record is written to the dead-letter store, not the chain. If the in-flight delivery lands after shutdown, the event is in the ledger once and in the dead-letter store under the same id and hash: at-least-once, detectable, owner decision in force. No chain change.
- `cache.ts` (d1a5e89b), `flag-registry.ts`, `worktree.py` (b4fe6bfe), `docs/*` (6e5d766e), `docs/greptime-ledger.md` (not changed in range), the phase records, and tests `event-buffer.test.ts`, `service-event-buffer.test.ts`, `cache-breaker.test.ts`: none is a covered path, and none touches the chain write, leaves, memo or verify code.

**Targeted runs this pass** (non-Postgres, two commands, from `packages/mcp-server`, `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`):

1. `bun test --timeout 30000 src/event.test.ts src/anchor.test.ts src/checkpoint-verify.test.ts src/ledger-archive.test.ts src/ledger-chain.test.ts`. Result: 248 pass, 0 fail, 1436 expect() calls, 5 files. Same counts as 42e3cf13 and 835a2742.
2. `bun test --timeout 30000 src/service.test.ts src/service-event-buffer.test.ts -t "verif|trust|first_differing|first_missing|anchored|straddl|NUL|surrogate|SOLANA_RPC_URL|pointer|G1Probe|ledger|rewrite|truncat|edited payload|sync|lag|buffer|dead|emit|abandon|shutdown"`. Result: 191 pass, 0 fail, 659 expect() calls, 2 files. This filter is wider than the 42e3cf13 filter (which gave 145 in `service.test.ts` alone), so the counts are not comparable. It covers the changed emit hook through the new test "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back" (`service-event-buffer.test.ts`, not a covered file). Per-name itemisation was not taken in this pass; the named passes cited above come from gate r33.

Not run this pass (carried): `memory-policy.test.ts`, `memory-write.test.ts`, `packages/ledger` tests (their files are unchanged in this range), full `bun test`, tsc, lint and formatters (out of assignment).

**Postgres.** No covered test file gates on `SUBSTRATE_TEST_PG_URL`. `service.test.ts` matches the word "postgres" only inside fake error strings (for example line 99, 668, 1402) and a fake invalid DSN constant (line 6179); none of these is a Postgres-gated test. The named passes above are from gate r33 (`/root/src/worktrees/backups/gate-r33-junit.xml`, 12290 testcases); each cited entry has no `<skipped/>` or failure child. No Postgres counts are claimed. W-K3 stays narrowed and open and was not re-probed.

**Fingerprint.** `covered_files` is the 31 paths, verbatim, from `gsd_run query verification.fingerprint .planning/phases/73-ledger-tamper-evidence` given the 29 non-PLAN and non-SUMMARY paths (the command adds the phase's own PLAN and SUMMARY). `covered_digest` is `v3:sha256:27614237279ea4991a8fe337c389a959f0f0f3f64f9fe921a07c8e513875425f` (previously `v3:sha256:ec6a146f`). The change is from the `service.ts` content change above, not from a change to the covered list.

## Human Verification Required

### 1. Devnet 0-lamport pointer probe
**Test:** Send a 0-lamport pointer to an unfunded index address; record the refusal text.
**Expected:** The text confirms or refutes `POINTER_REFUSED_RE` (anchor.ts:91). The narrowed pattern rests on the local solana-cli text; the full devnet line is [INFERENCE] until this runs.
**Why human:** Needs devnet, a funded key and a live send.

### 2. Live devnet send, 512-byte graph id
**Test:** Send one pointer whose graph id is 512 UTF-8 bytes; read it back with transactionMemo.
**Expected:** Serialises within 1,232 bytes; the measured size replaces the hand-counted overhead (memo.test.ts).
**Why human:** Needs a live send.

### 3. Live store scan
**Test:** Scan `agent_events` for graph ids over 512 bytes or with NUL, the six fields ending in U+FFFD at 512 units, and v2 or v3 memos in the anchor listings.
**Expected:** Zero rows, or an owner decision on each. The docs SQL is NOT RUN; check the store's functions first.
**Why human:** Needs read access to the live store.

### 4. RPC history depth (N5)
**Test:** Find the oldest signature listed on a job-key address and on an index address.
**Expected:** The depth is known. The accepted limit stays as recorded.
**Why human:** Needs live RPC.

### 5. Budget measurement (W-N8)
**Test:** Time `verifyGraph` for a year-old graph against the 30 s default.
**Expected:** A measured time; the default changes only if it exceeds 30 s.
**Why human:** Needs live data at realistic size.

### 6. Stored graph ids over 512 bytes or with NUL; pre-fix lone surrogates in those fields
**Test:** Record an owner decision.
**Expected:** A recorded decision. Until then a live anchor run against such rows halts at the first such hour.
**Why human:** Data-repair policy. Owner call.

### 7. O-S1 sizing
**Test:** Run the live scan for straddled rows in all five fields and record the counts against the 2026-11-04 decision in `docs/greptime-ledger.md`.
**Expected:** A count per field.
**Why human:** Needs read access to the live store.

### 8. W-L3b owner decision
**Test:** Decide whether branch, node_id and linear_identifier take the dangling-high trim, or record the fail-closed verdict as accepted.
**Expected:** A recorded decision; if trimmed, the change is listed in the W-L3b entry above.
**Why human:** Stored-form and read-key change. Owner call.

## Gaps Summary

No blocker. No truth is FAILED, no artifact is missing or a stub, and no key link is broken. Status is `human_needed` because live items remain (sections 1 to 8 above), per the decision tree in Step 9.

Warnings carried, not blocking:
- W-L3b (branch, node_id, linear_identifier at the 512-unit cut): accepted limit.
- Q8 and N5 (no pointer; RPC depth): accepted limits.
- O-S1 (pre-change straddled rows): decision recorded in docs 2026-11-04; the live count is missing.
- W-K3 (Postgres `graph_register` repo write, outside the ledger): narrowed, not closed.
- HARD-S3: owner scope item, open.

Changed since 42e3cf13: the sync-lag hook (b4bdd0fc) is outside the ledger path; it is covered by the wider run 2 and does not change any truth. No new gap.

---

_Verified: 2026-11-05T07:59:55Z_
_Verifier: Claude (gsd-verifier)_
