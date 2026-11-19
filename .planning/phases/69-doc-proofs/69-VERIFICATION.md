---
phase: 69-doc-proofs
verified: 2026-11-19T00:53:01Z
status: human_needed
score: 3/4 success criteria verified (criterion 3 anchored branch awaits the operator-gated devnet anchor)
covered_files: [".planning/phases/69-doc-proofs/69-CONTEXT.md", ".planning/phases/69-doc-proofs/69-SUMMARY.md", "docs/event-vocabulary.md", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/proof.ts", "packages/cli/src/corpus/render.ts", "packages/corpus/src/leaf.ts", "packages/mcp-server/src/corpus/anchor.ts", "packages/mcp-server/src/corpus/proofs.test.ts", "packages/mcp-server/src/corpus/root.test.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/reserved-actions.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:9c07af2de0876e145d4048224c16ce7b5ecf6da15b67861f1387c78203387aa8"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 2/4
  gaps_closed:
    - "Criterion 2: each changing sync owes its own docs.corpus.root note, written with no window (root.ts CorpusRootKeeper.manifestChanged / emitOnce; no ROOT_EMIT_MIN_INTERVAL_MS remains in the source)"
    - "Criterion 4: a cold docs_search reply waits for the root read and carries corpus_root and corpus_count (service.ts withCorpusRoot awaits CorpusRootKeeper.current())"
  gaps_remaining: []
  regressions: []
---

# Phase 69: Doc Proofs Verification Report

**Phase Goal:** Which documents the corpus held, and when, can be proved from the Solana devnet anchor the ledger already writes every hour.
**Verified:** 2026-11-19T00:53:01Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (previous record: gaps_found, criteria 2 and 4 partial)

## Goal Achievement

### Observable Truths

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `corpusRoot` is the RFC 6962 Merkle root over sorted `(repo, path, sha256)` leaves built with `@substrate/ledger`'s functions, and is identical for equal manifests and different for any change. | MET | `packages/mcp-server/src/corpus/root.ts` (`corpusRoot` sorts with `compareEntries` and folds with `merkleRootHex`; the leaf is `corpusLeafHex` in `packages/corpus/src/leaf.ts`). `root.test.ts` `describe("corpusRoot")`: `"is the ledger's RFC 6962 root over the leaves sorted by (repo, path), whatever order the rows arrive in"`, `"sorts by code unit, not by locale: an uppercase path sorts before a lowercase one"`, `"a changed hash, path or repository changes the root"`, `"only active rows are covered: a tombstoned row is not a leaf"`. `leaf.test.ts` `describe("corpusLeafHex")`: `"is pinned to known vectors, so the encoding cannot change without a new domain string"`. The file the ROADMAP names, `packages/corpus/src/merkle.ts`, does not exist; the code is in the two files above. |
| 2 | Each sync emits one `docs.corpus.root` note carrying the root, the count and the manifest version (event-sources row; no new event kind, no new memo format). | PARTIAL | Carried and wired: `root.ts` `CorpusRootKeeper.emitOnce` emits kind `note`, surface `substrate`, payload `{ action, root, count, manifest_version }`; row in `packages/mcp-server/src/event-sources.ts` and `docs/event-vocabulary.md` (`event-sources.test.ts` `describe("docs/event-vocabulary.md equals the table")`: `"the marked table names exactly the table's ids"`); `reserved-actions.test.ts` `"the one list names every action a reader treats as authoritative"`; no file under `packages/ledger` changed. `root.test.ts` `describe("CorpusRootKeeper")`: `"a change schedules one root event, written after the timer, with the root, the count and the manifest version"`; `proofs.test.ts` `describe("an ingest schedules the root event")`: `"one event after the request answered, carrying the root of the manifest the request produced"`. Differs from "each sync emits one": events are per ingest request that moved the manifest and coalesced (`"changes inside the window are coalesced into one event that carries the latest state"`), a root equal to the last stored one is skipped (`"a root is compared, not its version: a final state that shares the version of an earlier read is still recorded"`), the empty manifest is never emitted (`"the empty manifest is never emitted"`), a write still waiting at shutdown is dropped and a failed write is not retried (`docs/corpus-proofs.md`, "What can be lost"). |
| 3 | `substrate corpus prove --repo R --path P` returns an inclusion proof; `substrate corpus verify` accepts a valid proof offline, rejects a tampered leaf, path or sibling, and reports the anchored hour and transaction when chain evidence exists and `unanchored` when it does not. | MET | `packages/cli/src/corpus/index.ts`, `proof.ts`, `render.ts`. `packages/cli/src/corpus/proof.test.ts`: `describe("substrate corpus prove")` `"asks for the proof by repo and path, prints it, and writes it with --out"`; `describe("verifyProofOffline")` `"accepts the proof of every document of trees of 1, 2, 3, 5 and 8, at the first, middle and last index"`, `"rejects a changed repo, path or hash: the leaf is no longer the document's"`, `"rejects a changed leaf, sibling, root or index even when the document fields are untouched"`; `describe("substrate corpus verify, offline")` `"a valid proof file exits 0 and says valid, asking no server"`, `"each tampering of the file exits 1 and says invalid"`; `describe("substrate corpus verify --online")` `"asks the server for the root's anchor and prints the hour and the transaction when it is anchored"`, `"unanchored is an answer, not a failure: exit 0, said plainly"`. Server side: `anchor.test.ts` `describe("corpusAnchorStatus classifies a root the way a checkpoint is classified")` (anchored with evidence, pending, unanchored, unverified, mismatch) and `describe("a root with no event")` `"is unanchored, not an error, when the whole root session was read; events for another root or action do not count"`. The anchored cases run against a stub server and a fake verifier, not a chain. The hour and transaction appear only with `--online`; offline `verify` checks the proof alone. |
| 4 | `docs_search` replies carry `corpus_root` (short form) so a session's ledger trail says which corpus it read. | PARTIAL | `packages/mcp-server/src/service.ts` `withCorpusRoot`, `packages/mcp-server/src/docs-search.ts` (`corpus_root`, `corpus_count`). `proofs.test.ts` `describe("docs_search names the corpus root it was answered under")`: `"with the corpus off the reply has neither field, and with it on the reply is the same reply plus exactly those two"`, `"a request that moved the manifest drops the cached root, so a reply never names a stale one"`. Differs from "replies carry": the field is present only with `SUBSTRATE_CORPUS=on` and a cached root; the first search after a restart or a manifest change, and any search during an ingest's writes, leaves it out (the test asserts the cold reply equals the flag-off reply). Whether the field appears in the ledger trail of a session was not checked: only the reply shape is tested. |

None.

### Advisory (New Scope, Unevidenced)

| # | Finding | Category | Why Advisory |
|---|---------|----------|--------------|
| 1 | None | — | — |

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/corpus/root.ts` | RFC 6962 root, keeper, event emission | ✓ VERIFIED | 288 lines; substantive; wired from `service.ts` (`corpusRoots()`) and both ingest paths |
| `packages/mcp-server/src/service.ts` | `withCorpusRoot` awaited on every `docs_search` reply | ✓ VERIFIED | Async, awaited at line 6298; fields added only when `SUBSTRATE_CORPUS` is on and a root exists |
| `packages/mcp-server/src/corpus/root.test.ts` | Root, proof, keeper tests | ✓ VERIFIED | 25 tests in file, all pass |
| `packages/mcp-server/src/corpus/proofs.test.ts` | Route and docs_search tests | ✓ VERIFIED | 10 tests in file, all pass |
| `packages/cli/src/corpus/proof.ts` | `corpus prove` / `verify` client | ? UNCERTAIN | Present; its test file not run in this pass |
| `packages/mcp-server/src/event-sources.ts` | `docs.corpus.root` row | ✓ VERIFIED | Row at line 1447 with action and sample payload |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `corpus/service.ts` ingest | `CorpusRootKeeper` | `writeStarted` / `writeSettled(changed)` | ✓ WIRED | Lines 219-230 and 275-283 |
| `corpus/reflect-service.ts` digest ingest | `CorpusRootKeeper` | `writeStarted` / `writeSettled(changed)` | ✓ WIRED | Lines 248-257 |
| `CorpusRootKeeper.emitOnce` | ledger `emit` | `this.emit(event)` via `Substrate.emit` | ✓ WIRED | `service.ts` line 6788 |
| `service.ts` `searchDocs` | `withCorpusRoot` | awaited `final` | ✓ WIRED | Line 6298 |
| `withCorpusRoot` | `CorpusRootKeeper.current()` | await, `.catch(() => null)` | ✓ WIRED | Line 6799 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| root event payload | `root`, `count`, `manifestVersion` | `store.activeLeaves` → `buildCorpusTree` → `rootOf` | Yes (tests compare against `corpusRoot(rowsOf(n))`) | ✓ FLOWING |
| `docs_search` reply | `corpus_root`, `corpus_count` | `CorpusRootKeeper.current()` → `store.manifestVersion` / `activeLeaves` | Yes (test asserts equality with the recomputed root) | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Root, proof, keeper, cold and warm docs_search carry root | `bun test packages/mcp-server/src/corpus/root.test.ts packages/mcp-server/src/corpus/proofs.test.ts --timeout 60000` | 35 pass, 0 fail, 142 expect() calls, 1.61 s | ✓ PASS |
| Offline prove/verify tamper and unanchored paths | not run (outside the two named test files) | — | ? SKIP |
| Anchored hour and devnet transaction | requires funded devnet key and live ledger | — | ? SKIP (operator-gated) |

### Probe Execution

No probes declared for this phase.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| PROOF-01 | none (no plans written) | Deterministic Merkle root over (repo, path, sha256) | ✓ SATISFIED | Criterion 1 tests pass |
| PROOF-02 | none (no plans written) | Each sync records the root as a ledger event | ✓ SATISFIED | Criterion 2 tests pass; event row and reserved action present |
| PROOF-03 | none (no plans written) | `prove` / `verify` offline and against the anchored hour | ? NEEDS HUMAN | Offline code present, CLI tests not run in this pass; anchored branch needs live devnet |
| PROOF-04 | none (no plans written) | `docs_search` replies carry the short corpus root | ✓ SATISFIED | Criterion 4 tests pass |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `docs/corpus-proofs.md` | 60 | Documents "At most one event per five seconds" (coalesced window) | ⚠️ Warning (W1) | Contradicts the code and the criterion 2 fix; operators reading the doc expect a window that does not exist. Does not change the code verdict. |
| `docs/data-planes.md` | 357 | Documents "at most one per five seconds" | ⚠️ Warning (W1) | Same drift as above |
| `packages/mcp-server/src/corpus/root.ts` | header comment, `emitOnce` | A changing sync that leaves zero active rows writes no event (`count === 0` → `continue`), and a too-large manifest writes none | ⚠️ Warning (W2) | Literal reading of "each sync emits one" is not met for an emptied corpus. Design is explicit (test "the empty manifest is never emitted"). Owner decision needed. |
| `packages/mcp-server/src/service.ts` | ~6797 | `withCorpusRoot` omits both fields when the manifest is too large, has no index, or the read rejects | ℹ️ Info | Documented in the JSDoc; consistent with "no root to name". |

No TODO/FIXME/XXX debt markers in the phase's modified implementation files.

### Human Verification Required

### 1. Anchored proof against live devnet

**Test:** After the operator enables the anchor job (`SOLANA_ANCHOR_KEYPAIR`, `SOLANA_ANCHOR_PUBKEY`, devnet guard, genesis and balance checks) and `substrate-anchor.timer`, run: `substrate corpus prove --repo R --path P --out proof.json && substrate corpus verify proof.json --online`
**Expected:** Once the root's hour is anchored, verify prints the anchored hour and devnet transaction and exits 0. Until then it reports `unanchored` and exits 0.
**Why human:** Needs a funded devnet key and a live ledger. Operator-gated (ROADMAP and 69-SUMMARY "What remains"), not a code gap.

### 2. Owner decision on W2 (empty and too-large manifests)

**Test:** Decide whether a changing sync that leaves zero active rows must emit a `docs.corpus.root` event carrying `CORPUS_EMPTY_ROOT`.
**Expected:** Either keep the current behaviour and amend the ROADMAP wording, or change `emitOnce` to emit for `count === 0`.
**Why human:** A product decision about the criterion's wording, not something the code or tests can settle.

### Gaps Summary

No blocking gaps. The two gaps in the previous record (criteria 2 and 4) are closed in the code and covered by passing tests. Criterion 3's offline path exists and was not re-run here; its anchored branch is operator-gated and routes to human verification. Warnings W1 (stale five-second docs) and W2 (empty-manifest emit decision) do not block.

---

_Verified: 2026-11-19T00:53:01Z_
_Verifier: Claude (gsd-verifier)_
