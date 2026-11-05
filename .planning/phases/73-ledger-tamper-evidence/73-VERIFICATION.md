---
phase: 73-ledger-tamper-evidence
verified: 2026-11-05T01:26:19Z
status: human_needed
score: 8/8 must-haves verified (T2 counted as PASSED override)
covered_files: [".planning/phases/73-ledger-tamper-evidence/73-01-PLAN.md", ".planning/phases/73-ledger-tamper-evidence/73-01-SUMMARY.md", "docs/greptime-ledger.md", "packages/cli/src/capsule.ts", "packages/ledger/src/heads.test.ts", "packages/ledger/src/heads.ts", "packages/ledger/src/memo.test.ts", "packages/ledger/src/memo.ts", "packages/ledger/src/merkle.ts", "packages/mcp-server/src/anchor-verify-deps.ts", "packages/mcp-server/src/anchor.test.ts", "packages/mcp-server/src/anchor.ts", "packages/mcp-server/src/brief.ts", "packages/mcp-server/src/checkpoint-verify.test.ts", "packages/mcp-server/src/event.test.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/index-store.test.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/memory-policy.test.ts", "packages/mcp-server/src/memory-policy.ts", "packages/mcp-server/src/memory-record.ts", "packages/mcp-server/src/memory-retain.ts", "packages/mcp-server/src/memory-verify.ts", "packages/mcp-server/src/memory-write.test.ts", "packages/mcp-server/src/memory-write.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.ts", "packages/mcp-server/src/session-rollback.ts", "packages/mcp-server/src/types.ts"]
covered_digest: "v3:sha256:3a115587b0f7b64c36084413f66ea695a60155b3dd84bbd6ab2adc4cb5f617be"
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
  previous_verified: 2026-11-05T00:14:00Z
  previous_scope: "worktree /root/src/worktrees/as-gsd-v18-all, HEAD c40ffc9a (covered_digest v3:sha256:c7a1858e)"
  scope: "worktree /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 835a2742. Covered paths changed since c40ffc9a: packages/mcp-server/src/service.ts only (one hunk at 7476-7494, the docs.freshness corpusFreshness route for SUBSTRATE_DOCS_SLO_SYNC_LAG_S; commits 42dcb4c6 and related wave 7 work). Its changed lines are not on the ledger write, chain tip, memo, graph_chain_leaves, verifyGraph or trustHour path. covered_files is unchanged (31 paths, verbatim). covered_digest moved from v3:sha256:c7a1858e to v3:sha256:3a115587 because of that one file. Non-covered wave 7 changes (flag-registry.ts, docs-freshness.ts, reconcile-*.ts, dispatcher test_worktree.py, docs/config-reference.md, docs/corpus-eval.md, docs/runbooks/corpus-sync.md, the phase 63-78 VERIFICATION records, ROADMAP.md, REQUIREMENTS.md) were checked for phase 73 criteria: none touches a phase 73 claim. The phase 73 text in ROADMAP and REQUIREMENTS is unchanged; HARD-S3 remains open (REQUIREMENTS.md:114 and :135, STATE.md:846)."
  gaps_closed: []
  gaps_remaining:
    - "W-L3b: branch, node_id and linear_identifier still take the 512-unit cut without the dangling-high trim (event.ts:437, :438, :442, unchanged). Accepted limit, per the orchestrator's binding list and docs/greptime-ledger.md 'Not covered'. Stays open."
    - "O-S1: pre-change straddled rows. docs/greptime-ledger.md records the 2026-11-04 owner decision that they are left as they are. No live scan has been run to size them. Stays open."
    - "Q8 and N5: no pointer, and RPC history depth. Accepted limits; stay open as recorded."
    - "W-K3: Postgres graph_register repo write outside the ledger. Narrowed, not closed. index-store.ts:1175 and :2448 are unchanged since c40ffc9a and were not re-probed. Stays open."
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
**Verified:** 2026-11-05T01:26:19Z
**Status:** human_needed
**Re-verification:** Yes, after the c40ffc9a record. Scope is HEAD 835a2742. Prior status human_needed, score 8/8. Line numbers below are at 835a2742.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| T1 | SC1: an edited payload, a deleted middle event, truncated last events and a full rewrite are each compared with the saved head; the first differing or first missing id is named | ✓ VERIFIED | Run this pass (`service.test.ts`, targeted run 2 below): "a full rewrite with every hash and prev recalculated parts at the first event, and the verdict fails" (line 5641) and "sessions verify one by one" (5662) pass. Earlier passes: "an edited payload parts the chain at that event", "a deleted middle event is first_missing_event_id", "truncated last events are first_missing_event_id". `event.test.ts` in full passes (run 1). Code: `compareToAnchoredHead` event.ts:587, `trustHour` service.ts:8500. |
| T2 | SC2: each graph's chain head is recorded in the hourly anchor and the recorded head is the trusted proof | ✓ PASSED (override) | Memo v2 `heads_root` present: `packages/ledger/src/memo.ts:11-12` (`MEMO_PREFIX_V2`, `MEMO_V2_RE`); `formatMemoV2` used by `anchor.ts` (`anchorRow`, ~line 501); `graph_chain_leaves` written before the anchor row (`anchor.ts:506`). `memo.test.ts`, `heads.test.ts` and `anchor.test.ts` pass (run 1). Owner override 2026-11-02, commitment reading only; carried, acceptance not re-obtained here. |
| T3 | G1: an anchored hour removed from `agent_events`, `event_ingest` and `graph_chain_leaves` fails the verdict and is named | ✓ VERIFIED for pointer-listed hours (Q8 and N5 accepted limits) | Run this pass: "G1Probe, variant 1a", "variant 1b", the single-anchored-hour pointer test, and "with no pointer either, a graph whose only hour is gone has no events on chain: ok, untrusted, no events" (line 5971) pass in run 2. Q8 (no pointer) and N5 (RPC depth) stay open as accepted limits. The pre-index v2 hour (`:5981`) is carried from the 504da465 pass. |
| T4 | The hourly job sends every closed hour's pointers for every graph id the write path accepts, so the job does not halt on a valid event | ✓ VERIFIED | Graph id refusals: NUL `event.ts` (`graph_id_nul`, ~line 230-235) and over-cap `graph_id_too_long` (~line 221-225); both run before the chain tip read (`service.ts:3095` graph id refusal, after `assertWriteTextFields` at `:3094`, both at the top of `appendChained`, service.ts:3092; and the handoff refusal near `:7617-7637`). Run this pass: "refuses a NUL in the graph id before it reads the chain tip" and "refuses a lone surrogate in the handoff summary before it reads the chain tip" (`service.test.ts`, run 2). |
| T5 | N1/W2: the hour is sent, then pointers, then the row; a pointer failure stores no row; an unanchored mismatch stores no row | ✓ VERIFIED | Run 1: `anchor.test.ts` in full passes. Code: `anchor.ts` anchor sequence (hour, pointers, row) unchanged since 504da465 except POINTER_REFUSED_RE. |
| T6 | N2: the adoption window covers the lookback's newer transactions | ✓ VERIFIED | `anchor.test.ts` in full (run 1); `ADOPT_LOOKBACK_HOURS` `anchor.ts` unchanged in this range. |
| T7 | N3: verify counts only job-key pointers that succeeded; other entries are ignored; a job-key pointer naming another hour still fails | ✓ VERIFIED (verify side) | Run 2: "a pointer the job key did not sign, or that failed on chain, is ignored", "a pointer signed by another key is ignored", "a foreign-payer pointer", "an errored pointer", "a job-key pointer whose hour transaction names another hour". Anchor side (`anchor.ts` adoption pointer filter) still untested: W-N3c. |
| T8 | Refused `SOLANA_RPC_URL`: no chain read, `ok` false, `trusted` false, a named reason | ✓ VERIFIED | Run 2 ("SOLANA_RPC_URL", "refused"). Code: `service.ts:8053` (guard message at 8053), refusal before any RPC call. |

**Score:** 8/8 truths verified (T2 counted as PASSED override). Behavior unverified: 0. Presence-only truths: none.

### Re-verification of the prior record's checks

| #  | Check | Status | Evidence |
| -- | ----- | ------ | -------- |
| R1 | Six-field refusal: a lone surrogate in summary, session_id, repo, branch, node_id or linear_identifier is refused at write by name, before any hash or store write | ✓ VERIFIED | `assertWriteTextFields` event.ts:310 (calls `assertRepoLength` as its last check); called from `normalizeEvent` (event.ts:426) and as the first statement of `appendChained` (service.ts:3094). `event.test.ts` in full passes (run 1). |
| R2 | The refusal runs before the sessioned chain-tip read, the replay lookup, the buffer and the append-mode probe | ✓ VERIFIED | `service.ts:3094` (assert) and `:3095` (graph id) are the first statements of `appendChained` (declared :3092), before the buffer stores and the tip read. Handoff refuses before `placeOf` and the tip read (service.ts ~7617-7637). Unchanged logic; the wave 7 `+1` line shift at 7479 is the only change in this range that reaches it. |
| R3 | normalizeKey read and write parity for the LEDGER (session_id and repo) | ✓ VERIFIED | Write: `event.ts:435` (session_id) and `:441` (repo), both `normalizeKey`. Checkpoint lookup: `anchor-verify-deps.ts` findCheckpoint `normalizeKey(lookup.sessionId)` (bb428f94). Named test "a checkpoint written under a straddling session id is found by that id and verifies as anchored" (`checkpoint-verify.test.ts`) passes (run 1). |
| R4 | A session_id that straddles 512 units round-trips: stored, looked up and read back in one form | ✓ VERIFIED | "a session id straddling the cap is stored, looked up and read back in one form" and "a repo longer than the cap is refused at write, naming the rule, and nothing is stored" (`service.test.ts`, 504da465 pass; not in this range's changed code). |
| R5 | 4b84e50c regression test: a row with repo `owner/name` plus a lone high surrogate is not visible to a caller granted `owner/name`; a scope spelled with a surrogate keeps it | ✓ VERIFIED (carried) | "a repo keeps its exact spelling for visibility ..." (`memory-policy.test.ts`). Not re-run this pass; `memory-policy.ts` unchanged in this range. |

### Judgement 1: the six-field refusal and the repo cap (8a604455, 4b84e50c, f1138c65)

**Code.** `assertWriteTextFields` (event.ts:310) checks the six fields by name, then the repo length (`assertRepoLength` event.ts:290, `RepoTooLongError`, `repo_too_long`, 512 code units, measured on the redacted text before any cap). It runs in `normalizeEvent` and as the first statement of `appendChained` (service.ts:3094). The index store (`index-store.ts:1175`, `:2448`) and the memory write (`memory-write.ts` decide(), `repoOverCap` plus `repoScopeOverCap`) refuse the same length before any store write.

**Verdict:** VERIFIED for caller-supplied lone surrogates in all six fields and for an over-512 repo on every write path read. The memory-plane refusal is code-verified only; `memory-write.test.ts` was not run in this pass or the prior one.

### Judgement 2: the cap straddle for branch, node_id and linear_identifier (W-L3b, open, accepted limit)

`event.ts:437` and `:438` keep `normalizeIdentifier` (node_id, linear_identifier); `:442` keeps `clean` (branch). None trims a dangling high at the 512-unit cut. event.ts is unchanged in this range. It fails closed (`verifyChain` reports `hash does not match contents` on an untampered row). No test covers the straddle for these three fields.

**Verdict:** WARNING, open, accepted limit (orchestrator's binding list). Owner item.

### Judgement 3: normalizeKey read and write parity (ledger)

Write: `session_id` and `repo` use `normalizeKey` (`event.ts:435`, `:441`). Reads through `normalizeKey` are as recorded at 4b84e50c; the checkpoint lookup is the one site that moved (bb428f94). W-K1 is closed for session_id. Token-shaped ids (`SESSION_ID_RE`) are not reachable as a straddle (W-K2, [INFERENCE], low).

**Verdict:** VERIFIED for the ledger write path and the ledger reads named in the prior record. W-K3 (Postgres `graph_register` raw repo write, `index-store.ts:1175` preceded by `assertRepoLength`) is narrowed: a repo over 512 units is refused, but a 512-unit repo ending in a caller-supplied lone high surrogate is still stored raw there. Pre-existing, outside the ledger. `index-store.ts` is unchanged since c40ffc9a, so this site was not re-probed.

### Judgement 4: the pre-existing straddling rows (O-S1)

Unchanged by this range. Rows whose session_id, repo, branch, node_id or linear_identifier straddled 512 units before 8a604455 are stored as 511 units plus U+FFFD, already fail `verifyChain`, and are not found by a read of the same id. `assertAppendOnly` (greptime.ts) blocks in-place repair. `docs/greptime-ledger.md` ("Identifiers at the 512-unit cut", line 370) records the owner decision of 2026-11-04 that they are left as they are. That is option (a) of the O-S1 list. The live scan that sizes them has not been run.

### Judgement 5: memory-plane straddle (W-M1)

Closed by refusal. A repo over 512 code units is refused at write (f1138c65), so `parseScope` and the memory write no longer store a cut repo, and the entry hash reproduces. Reads still cut a repo filter to fit (`parseScope`), which can miss a row whose repo was refused; no such row can be stored.

### Schema hash dependence (ebabe6ef): re-checked at 835a2742

Question: does the ledger archive, or any phase 73 verify claim, depend on the index archive's `schemaHash` value?

**Answer: no.** Re-checked at HEAD by grep; the answer is unchanged.

- `schemaHash()` (`index-archive-spec.ts:266`) is consumed by `index-archive.ts` only: written into the index manifest (`index-archive.ts:502`) and compared by verify (`index-archive.ts:694-695`, kind `schema`). A new table or column changes it, so earlier index archives fail `verify-archive` (the accepted consequence, owner decision 3). The other occurrence, `event-sources.ts:1021`, is a `HEX_64` literal inside a sample `index.archive` event, not a check.
- The ledger archive (`ledger-archive.ts`, `ledger-run.ts`, `substrate ledger verify-archive`) does not import `index-archive-spec.ts` and does not contain `schemaHash` (grep at 835a2742: no match). Its `ManifestSchema` (`ledger-archive.ts:554`) has no schema or version field. Its verify checks per-file SHA-256, line counts, event hashes, the chain, the hourly RFC 6962 roots and the anchors. No index schema change can alter its verdict.
- The phase 73 verify claims (`verifyGraph` service.ts:8003, `trustHour` service.ts:8500, `compareToAnchoredHead` event.ts:587, memo v2, heads, checkpoint verify) reference no schema hash. Their inputs are `agent_events`, `event_ingest` and `graph_chain_leaves` in Greptime, plus the on-chain memo. `graph_chain_leaves` is not in `ARCHIVE_TABLES` (0 matches in `index-archive-spec.ts`), so the index schema hash does not cover the ledger leaves table, and the index archive does not archive ledger data.
- The only covered file that imports the spec is `index-store.ts` (line 23: `exportedColumns`, `tableSpec` and types). Its ebabe6ef-era edits (`PG_TYPE` gains `smallint` and `jsonb`, `advanceIdentity`) are restore-path code. They do not change the hash inputs (table names, column names and types, keys, withheld lists). `index-store.ts` and `index-archive-spec.ts` have no change since c40ffc9a.

**Consequence:** the index archive's pre-ebabe6ef archives fail `verify-archive` (kind `schema`), which is the accepted behavior. No ledger archive or phase 73 verdict is affected. Note, not a gap: the ledger manifest records no schema or version, so the ledger archive has no schema-level compatibility check. That is a property of the ledger archive as built in uplift-3, not a phase 73 criterion, and nothing in this change made it worse.

## Re-verification at 835a2742

Scope check. `git diff c40ffc9a 835a2742` over the 31 covered paths lists one file:

- `packages/mcp-server/src/service.ts` (+4 −3, one hunk at 7476-7494): `corpusFreshness` (service.ts:7483) now also runs when `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` is set and passes `syncLagS` and `syncLagMaxS` into `corpusFreshnessRow`. This is the docs.freshness sync-lag route (v1.7 phase 65 SC5). It reads `this.corpusSlo.readings(now)` and writes nothing to the ledger. It is not on T1 to T8, R1 to R5, the appendChained path (3092 to 3095), the recordSyncLag call (2961), the handoff refusal (~7617-7637), `verifyGraph` (8003), `trustHour` (8500), the Solana guard (8053) or the `compareToAnchoredHead` call (8587). The net `+1` line shift applies to every service.ts line after 7479; each line cited in this record has been re-read at 835a2742 and carries the shifted number.

Added lines in that hunk: no TODO, FIXME, XXX, HACK or PLACEHOLDER.

Other covered paths: unchanged since c40ffc9a. `event.ts`, `anchor.ts`, `greptime.ts`, `memo.ts`, `heads.ts`, `merkle.ts`, `anchor-verify-deps.ts`, `index-store.ts`, `docs/greptime-ledger.md` and `checkpoint-verify.test.ts` have no change in this range.

Non-covered wave 7 changes, checked against phase 73 criteria: `flag-registry.ts` (age-limit flag and worktree-roots text), `docs-freshness.ts` and its test, `reconcile-*.ts` and tests (phase 78), `packages/dispatcher/tests/test_worktree.py`, `docs/config-reference.md`, `docs/corpus-eval.md`, `docs/runbooks/corpus-sync.md`, the phase 63 to 78 VERIFICATION records, `ROADMAP.md` and `REQUIREMENTS.md`. None touches a phase 73 claim. The phase 73 entries in ROADMAP and REQUIREMENTS are unchanged; HARD-S3 remains open at REQUIREMENTS.md:114 and :135 and STATE.md:846.

Targeted runs this pass (non-Postgres, two commands, `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`):

1. From `packages/mcp-server`: `bun test --timeout 30000 src/event.test.ts src/anchor.test.ts src/checkpoint-verify.test.ts src/ledger-archive.test.ts src/ledger-chain.test.ts`. Result: 248 pass, 0 fail, 1436 expect() calls, 5 files. Same counts as c40ffc9a. The last two files are adjacent ledger tests, not covered files.
2. From `packages/mcp-server`: `bun test --timeout 30000 src/service.test.ts -t "verif|trust|first_differing|first_missing|anchored|straddl|NUL|surrogate|SOLANA_RPC_URL|pointer|G1Probe|ledger|rewrite|truncat|edited payload"`. Result: 145 pass, 0 fail, 488 expect() calls, 1 file. Same counts as c40ffc9a. This run is the one that executes the changed service.ts, and it covers the four service-level checks carried from the prior record (the full rewrite at service.test.ts:5641, "sessions verify one by one" at 5662, "an unanchored hour is untrusted" at 5678, "a v1-only anchored hour is untrusted" at 5686) and the no-pointer case at 5971. All passed. `service.test.ts` itself is unchanged, so its line numbers are unchanged.

Not run this pass: `memory-policy.test.ts`, `memory-write.test.ts`, `packages/ledger` tests (carried from the prior pass, unchanged files), full `bun test`, tsc, lint and formatters (out of assignment). "pre-index v2 hour" (`service.test.ts:5981`) is carried from the 504da465 pass.

Postgres: no covered test file references `SUBSTRATE_TEST_PG_URL` (grep over the covered `.test.ts` files finds none). `index-store.test.ts` uses a local probe socket and fake `postgres://` URLs for refusal checks; it has no env gate. The scratch database `substrate_test_v73` was therefore not used, and no Postgres counts are claimed. W-K3 stays narrowed and open and was not re-probed.

Fingerprint: `covered_files` is the prior 31 paths, verbatim, from `gsd_run query verification.fingerprint .planning/phases/73-ledger-tamper-evidence` with the 31 paths listed (the command adds the phase's own PLAN and SUMMARY, which are already in the list). `covered_digest` is `v3:sha256:3a115587b0f7b64c36084413f66ea695a60155b3dd84bbd6ab2adc4cb5f617be` (previously `v3:sha256:c7a1858e`). The change is from the `service.ts` content change above, not from a change to the covered list.

Status stays human_needed. No truth is FAILED. The open items, W-L3b, Q8, N5, W-K3, O-S1 and HARD-S3, remain as recorded: open, not closed by this pass.

## Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/ledger/src/memo.ts` | memo v1 and v2 parse; v2 round-trips | ✓ VERIFIED | `MEMO_V2_RE` line 12; `memo.test.ts` in full passes (run 1 and prior). Unchanged. |
| `packages/ledger/src/heads.ts` | headRecordHash, headsRoot | ✓ VERIFIED | `heads.test.ts` in full passes. Unchanged. |
| `packages/mcp-server/src/anchor.ts` | buildGraphHeads, v2 anchorRow, leaves before row | ✓ VERIFIED | `anchor.test.ts` in full passes (run 1); POINTER_REFUSED_RE at `anchor.ts:91` narrowed (42cddae0). Unchanged. |
| `packages/mcp-server/src/greptime.ts` | graph_chain_leaves DDL, insertGraphChainLeaves, hourChainLeaves | ✓ VERIFIED | DDL line ~1024; insert ~1842; read ~1853. Unchanged in this range. |
| `packages/mcp-server/src/event.ts` | compareToAnchoredHead, orderedLeaves, headRecordsFromLeaves, refusals | ✓ VERIFIED | `event.test.ts` in full passes (run 1). Unchanged in this range. |
| `packages/mcp-server/src/service.ts` | verifyGraph trusted verdict, trustHour | ✓ VERIFIED | Targeted run 2 passes (145). `verifyGraph` :8003, `trustHour` :8500. The one changed hunk (7476-7494, docs.freshness sync-lag route) is outside the ledger path. |
| `docs/greptime-ledger.md` | memo v2, graph_chain_leaves, v3 memo, "Identifiers at the 512-unit cut" | ✓ VERIFIED | Section at line 370; memo v2 and graph_chain_leaves sections as read in the prior pass. Unchanged in this range. |

## Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| anchor.ts anchorRow | memo v2 | formatMemoV2 | ✓ WIRED | anchor.ts:501 |
| anchor.ts | graph_chain_leaves | insertGraphChainLeaves before the anchor row | ✓ WIRED | anchor.ts:506 |
| service.ts trustHour | stored leaves | greptime.hourChainLeaves | ✓ WIRED | service.ts:8500 onward |
| service.ts trustHour | on-chain heads root | headsRoot(records) === onChainHeadsRoot | ✓ WIRED | service.ts:8550 |
| service.ts per-session | compareToAnchoredHead | per (graph, session) pair | ✓ WIRED | service.ts:8582-8591 (call at 8587) |
| checkpoint verify | ledger write form | normalizeKey(lookup.sessionId) | ✓ WIRED | anchor-verify-deps.ts findCheckpoint |

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| trustHour | leaves | `greptime.hourChainLeaves` (SQL on `graph_chain_leaves`) | Yes (fake Greptime in tests; live store not read) | ✓ FLOWING |
| trustHour | onChainHeadsRoot | memo v2 read from the anchored transaction | Yes (fake runner in tests; devnet not read) | ✓ FLOWING (fake) |

## Behavioral Spot-Checks

Two targeted `bun test` runs at 835a2742, both with `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs`. No full suite. No Postgres evidence is claimed.

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Memo, heads, chain compare, anchor writer, checkpoint lookup, ledger archive and chain (five files) | `bun test --timeout 30000 src/event.test.ts src/anchor.test.ts src/checkpoint-verify.test.ts src/ledger-archive.test.ts src/ledger-chain.test.ts` (from packages/mcp-server) | 248 pass, 0 fail, 1436 expect() calls | ✓ PASS |
| Criterion 1 and 2 verify named subset, graph id and handoff refusals, pointer and G1Probe, SOLANA_RPC_URL refusal, full rewrite, unanchored and v1-only untrusted, no-pointer case | `bun test --timeout 30000 src/service.test.ts -t "<regex>"` (from packages/mcp-server) | 145 pass, 0 fail, 488 expect() calls | ✓ PASS |
| Not run this pass (carried from the prior record): "a repo keeps its exact spelling for visibility" (memory-policy); "pre-index v2 hour" (`service.test.ts:5981`) | not run | carried | ? SKIP |

## Probe Execution

No probe scripts apply: `find scripts -path '*/tests/probe-*.sh'` returns nothing, and phase 73's PLAN declares none.

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-S3 | 73-01 | Chain checksums; on-demand and scheduled verification detect modified, deleted, gapped or reordered entries and report the first bad position; state the trusted earlier proof | ? NEEDS HUMAN | Criteria 1 and 2 are met in code and tests within the phase scope. REQUIREMENTS.md still shows HARD-S3 open (lines 114 and 135); STATE.md lists "decide the scope of HARD-S3" as an owner item (line 846). Live scheduled verification and the live store are not observed. Stays open. |

No orphaned phase 73 requirements.

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (added lines, c40ffc9a..835a2742, service.ts) | - | TBD / FIXME / XXX / TODO / HACK / PLACEHOLDER scan | ℹ️ Info | None found in added lines. |

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
- HARD-S3: owner scope item, open.

Schema hash (ebabe6ef): no dependence found in the ledger archive or in any phase 73 verify claim. Not a gap.

Closed since 4b84e50c: W-M1 (repo over the cap refused), W-K1 for session_id, the NUL/over-cap/handoff text refusals before the chain tip, and the POINTER_REFUSED_RE narrowing.

---

_Verified: 2026-11-05T01:26:19Z_
_Verifier: Claude (gsd-verifier)_
