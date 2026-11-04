---
phase: 73-ledger-tamper-evidence
verified: 2026-11-04T23:05:32Z
status: human_needed
score: 8/8 must-haves verified (T2 counted as PASSED override)
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", "docs/greptime-ledger.md", "packages/cli/src/capsule.ts", "packages/ledger/src/heads.test.ts", "packages/ledger/src/heads.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/mcp-server/src/anchor-verify-deps.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/checkpoint-verify.test.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index-store.test.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/memory-policy.test.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/memory-record.ts", "packages/mcp-server/src/memory-retain.ts", "packages/mcp-server/src/memory-verify.ts", "packages/mcp-server/src/memory-write.test.ts", "packages/mcp-server/src/memory-write.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.ts", "packages/mcp-server/src/session-rollback.ts", "packages/mcp-server/src/types.ts"]
covered_digest: "v3:sha256:5b1c40fba260ca45ab69404bfc707bc1e62ac7327118e02f91b62449b57a31ba"
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
  previous_verified: 2026-11-04T22:34:08Z
  previous_scope: "worktree /root/src/worktrees/as-gsd-v18-all, HEAD 504da465"
  scope: "worktree /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 9e71f263. Covered paths changed since 504da465: packages/mcp-server/src/service.test.ts only (94f4bc8e: the phase 78 scheduled reconcile block, clean-tick fixture moved to a helper with assertions unchanged, plus one single-flight test). No covered implementation file changed in that range. covered_digest moved from v3:sha256:f1226fa3 to v3:sha256:5b1c40fb because of that test file. Rows marked 'Run this pass' refer to the 504da465 pass and are carried forward; see 'Re-verification at 9e71f263'. Commits f1138c65, 151adb13, 21d4ab11, a9e477e2, bb428f94 and 42cddae0 are unchanged from the prior record."
  gaps_closed:
    - "W-M1 (memory plane): a repo over 512 code units is refused at write, not cut (f1138c65; memory-write.ts decide(), index-store.ts assertRepoLength). Code read in this pass; memory-write.test.ts was not run here. The memory entry hash no longer depends on a cut repo."
    - "W-K1, session_id form: checkpoint verify looks the session up in its normalizeKey form (bb428f94, anchor-verify-deps.ts findCheckpoint). The named straddling-session test in checkpoint-verify.test.ts passed in this pass. Pre-change straddled rows are unchanged (see O-S1)."
    - "Graph id NUL, over-cap and lone surrogate, and handoff summary text: refused before the chain tip read (a9e477e2, service.ts appendChained and handoff). Named tests passed in this pass."
    - "POINTER_REFUSED_RE no longer matches the bare 'Transaction simulation failed' prefix (42cddae0, anchor.ts:91). Named test passed in this pass."
  gaps_remaining:
    - "W-L3b: branch, node_id and linear_identifier still take the 512-unit cut without the dangling-high trim (event.ts:437, :438, :442). Accepted limit, per the orchestrator's binding list and docs/greptime-ledger.md 'Not covered'."
    - "O-S1: pre-change straddled rows. docs/greptime-ledger.md records the 2026-11-04 owner decision that they are left as they are. No live scan has been run to size them."
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
  - test: "Budget measurement for a year-old graph (W-N8): time verifyGraph under the 30 s default"
    expected: "A measured time. The default changes only if the measurement exceeds 30 s."
    why_human: "Needs live data at realistic size."
  - test: "Owner decision on stored graph ids over 512 bytes or containing NUL, and on pre-fix rows with a lone surrogate in those fields (no data repair decided)"
    expected: "A recorded decision. Until then a live anchor run against a store holding such rows halts at the first such hour (anchor.ts graph id refusal path)."
    why_human: "Data-repair policy. Owner call."
  - test: "O-S1 sizing: run the live scan for straddled rows in all five fields and record the counts against the 2026-11-04 decision"
    expected: "A count per field. The decision (left as they are) is recorded in docs/greptime-ledger.md; the count is the missing input."
    why_human: "Needs read access to the live store. The verifier does not read it."
  - test: "W-L3b owner decision: branch, node_id and linear_identifier take the dangling-high trim as session_id and repo do, or the fail-closed verdict is recorded as accepted"
    expected: "A recorded decision. If trimmed: normalizeKey on those three at event.ts:437, :438, :442, every read site moved to the same key, and a test that a 512-unit id with a pair at the cut round-trips. If accepted: recorded as accepted."
    why_human: "Stored-form and read-key change. Owner call."
---

# Phase 73: Ledger tamper evidence Verification Report

**Phase Goal:** A rewrite, reorder, deletion or tail truncation of the event ledger is detected by recomputing the chain from stored rows, and the verified head is anchored. Criterion 1 is proven by tests against a head saved before the change. Criterion 2 requires each graph's chain head to be recorded in the hourly anchor, and that recorded head is the only trusted proof.
**Verified:** 2026-11-04T23:05:32Z
**Status:** human_needed
**Re-verification:** Yes, after the 504da465 record. Scope is HEAD 9e71f263 (covered paths unchanged from 504da465 except service.test.ts; see "Re-verification at 9e71f263"). Prior status human_needed, score 8/8.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| T1 | SC1: an edited payload, a deleted middle event, truncated last events and a full rewrite are each compared with the saved head; the first differing or first missing id is named | ✓ VERIFIED | Run this pass: `event.test.ts` (whole file) covers `compareToAnchoredHead` for first-missing, first-differing (edit, rewrite, extension) and stored-leaves-mismatch. Run this pass: service-level "an edited payload parts the chain at that event", "a deleted middle event is first_missing_event_id", "truncated last events are first_missing_event_id" (`service.test.ts`). Carried, not run this pass: service-level "a full rewrite with every hash and prev recalculated parts at the first event". Code: `compareToAnchoredHead` event.ts:587, `trustHour` service.ts:8498. |
| T2 | SC2: each graph's chain head is recorded in the hourly anchor and the recorded head is the trusted proof | ✓ PASSED (override) | Memo v2 `heads_root` present: `packages/ledger/src/memo.ts:11-12` (`MEMO_PREFIX_V2`, `MEMO_V2_RE`); `formatMemoV2` used by `anchor.ts` (`anchorRow`, ~line 501); `graph_chain_leaves` written before the anchor row (`anchor.ts:506`). `memo.test.ts`, `heads.test.ts` and `anchor.test.ts` pass in full this pass. Owner override 2026-11-02, commitment reading only; carried, acceptance not re-obtained here. |
| T3 | G1: an anchored hour removed from `agent_events`, `event_ingest` and `graph_chain_leaves` fails the verdict and is named | ✓ VERIFIED for pointer-listed hours (bounded by Q8 and N5, accepted limits) | Run this pass (named subset): "G1Probe, variant 1a", "variant 1b" and the single-anchored-hour pointer test in `service.test.ts`. Carried: `:5971` no-pointer case (accepted limit Q8), `:5981` pre-index v2 hour. Q8 and N5 are accepted limits, not closed. |
| T4 | The hourly job sends every closed hour's pointers for every graph id the write path accepts, so the job does not halt on a valid event | ✓ VERIFIED | Graph id refusals: NUL `event.ts` (`graph_id_nul`, ~line 230-235) and over-cap `graph_id_too_long` (~line 221-225); both run before the chain tip read (`service.ts:3095`, `:7628`). Run this pass: "refuses a NUL in the graph id before it reads the chain tip" and "refuses a lone surrogate in the handoff summary before it reads the chain tip" (`service.test.ts`); `event.test.ts` and `memo.test.ts` in full. |
| T5 | N1/W2: the hour is sent, then pointers, then the row; a pointer failure stores no row; an unanchored mismatch stores no row | ✓ VERIFIED | Run this pass: `anchor.test.ts` in full (252 pass across the five files with `checkpoint-verify.test.ts`, `event.test.ts`, `memo.test.ts`, `heads.test.ts`; 0 fail). Code: `anchor.ts` anchor sequence (hour, pointers, row) unchanged in this range except POINTER_REFUSED_RE. |
| T6 | N2: the adoption window covers the lookback's newer transactions | ✓ VERIFIED | `anchor.test.ts` in full this pass; `ADOPT_LOOKBACK_HOURS` `anchor.ts` unchanged in this range. |
| T7 | N3: verify counts only job-key pointers that succeeded; other entries are ignored; a job-key pointer naming another hour still fails | ✓ VERIFIED (verify side) | Run this pass (named subset): "a pointer the job key did not sign, or that failed on chain, is ignored", "a pointer signed by another key is ignored", "a foreign-payer pointer", "an errored pointer", "a job-key pointer whose hour transaction names another hour". Anchor side (`anchor.ts` adoption pointer filter) still untested: W-N3c. |
| T8 | Refused `SOLANA_RPC_URL`: no chain read, `ok` false, `trusted` false, a named reason | ✓ VERIFIED | Run this pass (named subset, "SOLANA_RPC_URL"/"refused"). Code: `service.ts:8051-8052`, refusal before any RPC call. |

**Score:** 8/8 truths verified (T2 counted as PASSED override). Behavior unverified: 0. Presence-only truths: none.

### Re-verification of the prior record's checks at 504da465

| #  | Check | Status | Evidence |
| -- | ----- | ------ | -------- |
| R1 | Six-field refusal: a lone surrogate in summary, session_id, repo, branch, node_id or linear_identifier is refused at write by name, before any hash or store write | ✓ VERIFIED | `assertWriteTextFields` event.ts:310 (calls `assertRepoLength` as its last check); called from `normalizeEvent` and as the first statement of `appendChained` (service.ts:3093). Run this pass: event.test.ts in full. |
| R2 | The refusal runs before the sessioned chain-tip read, the replay lookup, the buffer and the append-mode probe | ✓ VERIFIED | `service.ts:3093` (assert) and `:3095` (graph id) are the first statements of `appendChained`, before the buffer stores and the tip read. Handoff: `service.ts:7615-7635` refuses before `placeOf` and the tip read. |
| R3 | normalizeKey read and write parity for the LEDGER (session_id and repo) | ✓ VERIFIED | Write: `event.ts:435` (session_id) and `:441` (repo), both `normalizeKey`. Checkpoint lookup: `anchor-verify-deps.ts` findCheckpoint now `normalizeKey(lookup.sessionId)` (bb428f94). Other ledger read sites unchanged in this range. Named passing test: "a checkpoint written under a straddling session id is found by that id and verifies as anchored" (`checkpoint-verify.test.ts`). |
| R4 | A session_id that straddles 512 units round-trips: stored, looked up and read back in one form | ✓ VERIFIED | Run this pass: "a session id straddling the cap is stored, looked up and read back in one form" (`service.test.ts`). A repo over 512 units is no longer cut: it is refused (f1138c65), and "a repo longer than the cap is refused at write, naming the rule, and nothing is stored" passed this pass. The prior repo round-trip expectation is replaced by this refusal rule (151adb13, an owner decision recorded in docs). |
| R5 | 4b84e50c regression test: a row with repo `owner/name` plus a lone high surrogate is not visible to a caller granted `owner/name`; a scope spelled with a surrogate keeps it | ✓ VERIFIED | Run this pass: "a repo keeps its exact spelling for visibility ..." (`memory-policy.test.ts`). `parseScope` unchanged in its cap; the write refusal is `repoScopeOverCap` (memory-policy.ts, used by memory-write.ts decide()). |

### Judgement 1: the six-field refusal and the repo cap (8a604455, 4b84e50c, f1138c65)

**Code.** `assertWriteTextFields` (event.ts:310) checks the six fields by name, then the repo length (`assertRepoLength`, `RepoTooLongError`, `repo_too_long`, 512 code units, measured on the redacted text before any cap). It runs in `normalizeEvent` and as the first statement of `appendChained` (service.ts:3093). The index store (`index-store.ts:1175`, `:2448`) and the memory write (`memory-write.ts` decide(), `repoOverCap` plus `repoScopeOverCap`) refuse the same length before any store write.

**Verdict:** VERIFIED for caller-supplied lone surrogates in all six fields and for an over-512 repo on every write path read. The memory-plane refusal is code-verified only; `memory-write.test.ts` was not run in this pass.

### Judgement 2: the cap straddle for branch, node_id and linear_identifier (W-L3b, open, accepted limit)

`event.ts:437` and `:438` keep `normalizeIdentifier` (node_id, linear_identifier); `:442` keeps `clean` (branch). None trims a dangling high at the 512-unit cut. This is unchanged since 4b84e50c and is named in `docs/greptime-ledger.md` ("Not covered"). It fails closed (`verifyChain` reports `hash does not match contents` on an untampered row). No test covers the straddle for these three fields.

**Verdict:** WARNING, open, accepted limit (orchestrator's binding list). Owner item.

### Judgement 3: normalizeKey read and write parity (ledger)

Write: `session_id` and `repo` use `normalizeKey` (`event.ts:435`, `:441`). Reads through `normalizeKey` are as recorded at 4b84e50c; the checkpoint lookup is the one site that moved (bb428f94). W-K1 is closed for session_id. Token-shaped ids (`SESSION_ID_RE`) are not reachable as a straddle (W-K2, [INFERENCE], low).

**Verdict:** VERIFIED for the ledger write path and the ledger reads named in the prior record. W-K3 (Postgres `graph_register` raw repo write, `index-store.ts:1175` now preceded by `assertRepoLength`) is narrowed: a repo over 512 units is refused, but a 512-unit repo ending in a caller-supplied lone high surrogate is still stored raw there. Pre-existing, outside the ledger, not re-probed.

### Judgement 4: the pre-existing straddling rows (O-S1)

Unchanged by this range. Rows whose session_id, repo, branch, node_id or linear_identifier straddled 512 units before 8a604455 are stored as 511 units plus U+FFFD, already fail `verifyChain`, and are not found by a read of the same id. `assertAppendOnly` (greptime.ts) blocks in-place repair. `docs/greptime-ledger.md` ("Identifiers at the 512-unit cut") records the owner decision of 2026-11-04 that they are left as they are. That is option (a) of the O-S1 list. The live scan that sizes them has not been run.

### Judgement 5: memory-plane straddle (W-M1)

Closed by refusal. A repo over 512 code units is refused at write (f1138c65), so `parseScope` and the memory write no longer store a cut repo, and the entry hash reproduces. Reads still cut a repo filter to fit (`parseScope`), which can miss a row whose repo was refused; no such row can be stored.

## Re-verification at 9e71f263

Scope check. `git diff 504da465 9e71f263` over the covered paths lists one file: `packages/mcp-server/src/service.test.ts` (commit 94f4bc8e). Its diff sits inside the phase 78 `the scheduled reconcile timer` describe block. The clean-tick fixture moved into a helper, `cleanReconcileFixture`, with the same reads, the same write guard and the same assertions; a new test covers overlapping ticks sharing one run. No phase 73 claim (T1 to T8, R1 to R5, judgements 1 to 5, key links, artifacts) is exercised by that block. The other covered paths (`service.ts`, `event.ts`, `anchor.ts`, `greptime.ts` and the rest) are unchanged from 504da465, so every phase 73 claim is carried forward from the 504da465 pass. 'Run this pass' in the tables above means that pass.

Targeted run this pass (non-Postgres, one command): from `packages/mcp-server`, `bun test --timeout 30000 src/service.test.ts -t "scheduled reconcile timer"` with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`. Result: 3 pass, 0 fail, 15 expect() calls. This is evidence for the changed file only, not for a phase 73 claim.

Added lines in that diff on covered paths: no TODO, FIXME, XXX, HACK or PLACEHOLDER.

Postgres: a grep over the covered test files finds no `SUBSTRATE_TEST_PG_URL` gate, so no scratch Postgres run applies to this phase. W-K3 stays narrowed and open and was not re-probed.

Fingerprint: `covered_files` is unchanged (31 paths, verbatim). `covered_digest` from `verification.fingerprint` over the same paths is v3:sha256:5b1c40fb (previously v3:sha256:f1226fa3).

Status stays human_needed. No truth is FAILED. The human items, W-L3b, Q8, N5, W-K3, O-S1 and HARD-S3 remain as recorded: open, unchanged, and not closed by this pass.

## Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/ledger/src/memo.ts` | memo v1 and v2 parse; v2 round-trips | ✓ VERIFIED | `MEMO_V2_RE` line 12; `memo.test.ts` in full passes. |
| `packages/ledger/src/heads.ts` | headRecordHash, headsRoot | ✓ VERIFIED | `heads.test.ts` in full passes. |
| `packages/mcp-server/src/anchor.ts` | buildGraphHeads, v2 anchorRow, leaves before row | ✓ VERIFIED | `anchor.test.ts` in full passes; POINTER_REFUSED_RE narrowed (42cddae0). |
| `packages/mcp-server/src/greptime.ts` | graph_chain_leaves DDL, insertGraphChainLeaves, hourChainLeaves | ✓ VERIFIED | DDL line ~1024; insert ~1842; read ~1853. |
| `packages/mcp-server/src/event.ts` | compareToAnchoredHead, orderedLeaves, headRecordsFromLeaves, refusals | ✓ VERIFIED | `event.test.ts` in full passes. |
| `packages/mcp-server/src/service.ts` | verifyGraph trusted verdict, trustHour | ✓ VERIFIED | Named subset passes; `trustHour` service.ts:8498. |
| `docs/greptime-ledger.md` | memo v2 (line ~622), graph_chain_leaves (~631), v3 memo (~657) | ✓ VERIFIED | Documented in the file as read in this pass; the section "Identifiers at the 512-unit cut" was added by 21d4ab11. |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| anchor.ts anchorRow | memo v2 | formatMemoV2 | ✓ WIRED | anchor.ts:501 |
| anchor.ts | graph_chain_leaves | insertGraphChainLeaves before the anchor row | ✓ WIRED | anchor.ts:506 |
| service.ts trustHour | stored leaves | greptime.hourChainLeaves | ✓ WIRED | service.ts:8498 onward |
| service.ts trustHour | on-chain heads root | headsRoot(records) === onChainHeadsRoot | ✓ WIRED | service.ts:8548 |
| service.ts per-session | compareToAnchoredHead | per (graph, session) pair | ✓ WIRED | service.ts:8580-8589 |
| checkpoint verify | ledger write form | normalizeKey(lookup.sessionId) | ✓ WIRED | anchor-verify-deps.ts findCheckpoint |

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| trustHour | leaves | `greptime.hourChainLeaves` (SQL on `graph_chain_leaves`) | Yes (fake Greptime in tests; live store not read) | ✓ FLOWING |
| trustHour | onChainHeadsRoot | memo v2 read from the anchored transaction | Yes (fake runner in tests; devnet not read) | ✓ FLOWING (fake) |

## Behavioral Spot-Checks

Two targeted `bun test` runs, both with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`. No full suite. Postgres-gated tests were not run; no Postgres evidence is claimed.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Memo v1/v2, heads, chain compare, anchor writer, checkpoint lookup (whole files) | `bun test --timeout 30000 packages/ledger/src/memo.test.ts packages/ledger/src/heads.test.ts packages/mcp-server/src/event.test.ts packages/mcp-server/src/anchor.test.ts packages/mcp-server/src/checkpoint-verify.test.ts` | 252 pass, 0 fail, 1326 expect() calls, 5 files | ✓ PASS |
| Criterion 1 and 2 verify named subset, repo cap, graph id and handoff refusals, memory exact spelling (`-t` regex: straddl, surrogate, normalizeKey, assertWriteTextFields, exact spelling, repo longer than the cap, NUL in the graph id, handoff summary, honest v2, edited payload, deleted middle, truncated last, stored leaves, G1Probe, pointer, SOLANA_RPC_URL, refused, budget, store-failed, v1 memo, pre-index, and others) | `bun test --timeout 30000 packages/mcp-server/src/service.test.ts packages/mcp-server/src/memory-policy.test.ts -t "<regex>"` | 80 pass, 0 fail, 285 filtered out, 2 files | ✓ PASS |
| Not run this pass (carried from the prior record): service-level full rewrite; "an unanchored hour is untrusted"; "a v1-only anchored hour is untrusted"; "sessions verify one by one"; "with no pointer either, ... no events" | not run (targeted-run budget spent) | carried | ? SKIP |

## Probe Execution

No probe scripts apply: `find scripts -path '*/tests/probe-*.sh'` returns nothing, and phase 73's PLAN declares none.

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-S3 | 73-01 | Chain checksums; on-demand and scheduled verification detect modified, deleted, gapped or reordered entries and report the first bad position; state the trusted earlier proof | ? NEEDS HUMAN | Criteria 1 and 2 are met in code and tests within the phase scope. REQUIREMENTS.md still shows HARD-S3 open; STATE.md lists "decide the scope of HARD-S3" as an owner item. Live scheduled verification and the live store are not observed. |

No orphaned phase 73 requirements.

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (added lines, 4b84e50c..504da465, packages and docs) | - | TBD / FIXME / XXX / TODO / HACK / PLACEHOLDER scan | ℹ️ Info | None found in added lines. |

## Human Verification Required

### 1. Devnet 0-lamport pointer probe
**Test:** Send a 0-lamport pointer to an unfunded index address; record the refusal text.
**Expected:** The text confirms or refutes `POINTER_REFUSED_RE` (anchor.ts:91).
**Why human:** Needs devnet, a funded key and a live send.

### 2. Live devnet send, 512-byte graph id
**Test:** Send one pointer whose graph id is 512 UTF-8 bytes; read it back with transactionMemo.
**Expected:** Serialises within 1,232 bytes; the measured size replaces the hand-counted overhead.
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

Closed since 4b84e50c: W-M1 (repo over the cap refused), W-K1 for session_id, the NUL/over-cap/handoff text refusals before the chain tip, and the POINTER_REFUSED_RE narrowing.

---

_Verified: 2026-11-04T22:34:08Z_
_Verifier: Claude (gsd-verifier)_
