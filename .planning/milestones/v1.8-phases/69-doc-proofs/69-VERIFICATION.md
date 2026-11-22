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
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 69: Doc Proofs Verification Report

**Phase Goal:** Which documents the corpus held, and when, can be proved from the Solana devnet anchor the ledger already writes every hour.
**Verified:** 2026-11-19T00:53:01Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (previous record: gaps_found, criteria 2 and 4 partial)

## Goal Achievement

### Observable Truths

| #   | Truth (ROADMAP Phase 69 success criterion) | Status     | Evidence |
| --- | ------------------------------------------ | ---------- | -------- |
| 1   | `corpusRoot` is the RFC 6962 root over sorted `(repo, path, sha256)` leaves built with `@substrate/ledger`, identical for equal manifests and different for any change | ✓ VERIFIED | `root.ts` uses `merkleRootHex` / `merkleProofHex` from `@substrate/ledger`, sorts with `compareEntries`. `bun test root.test.ts proofs.test.ts`: 35 pass, 0 fail, including "is the ledger's RFC 6962 root ... whatever order the rows arrive in" and "a changed hash, path or repository changes the root". |
| 2   | Each changing sync emits one `docs.corpus.root` note carrying root, count and manifest version (event-sources row; no new kind or memo format) | ✓ VERIFIED (see WARNING W1, W2) | `corpus/service.ts` and `corpus/reflect-service.ts` bracket each ingest with `writeStarted()` / `writeSettled(changed)`. `CorpusRootKeeper.manifestChanged()` increments `owed`; `emitOnce()` writes one `note` per owed change (`surface: substrate`, `session_id: corpus-root`, `payload: { action: docs.corpus.root, root, count, manifest_version }`) and never waits on a window (`scheduleEmit` uses a 0 ms timer). No `ROOT_EMIT_MIN_INTERVAL_MS` or other window exists in `packages/mcp-server/src`. Event-sources row present at `event-sources.ts:1447`; `docs.corpus.root` in `RESERVED_NOTE_ACTIONS` per `docs/event-vocabulary.md:120`. Tests: "a change schedules one root event, written after the timer ..."; "two changing syncs that land before the timer runs each owe and write their own event, on one timer" (expects two events, manifest_version [3, 3]); "a changing sync writes its event at once, not after a window ..."; "every changing sync writes its own event, even when its root is the same as the last one written". All pass. |
| 3   | `substrate corpus prove` returns an inclusion proof; `substrate corpus verify` accepts valid proofs offline, rejects tampered leaf/path/sibling, and reports anchored hour and transaction when chain evidence exists, `unanchored` when not | ? UNCERTAIN (human) | Code present: `packages/cli/src/corpus/proof.ts` and `index.ts` expose prove/verify; the server proof door is covered by `proofs.test.ts` "the proof of a live row verifies against the root the server reports for the same manifest" (pass). Tamper and unanchored tests exist in `packages/cli/src/corpus/proof.test.ts` (lines ~119-127, 176-184, 238-243) but were not run in this pass (outside the two named test files). The anchored branch needs a funded devnet key and a live ledger; see Human Verification. |
| 4   | `docs_search` replies carry `corpus_root` (short form) so a session's ledger trail says which corpus it read | ✓ VERIFIED | `service.ts` `withCorpusRoot` (line ~6797) is async and awaits `this.corpusRoots().current()` before returning, so a cold reply carries the root instead of omitting it. Every `searchDocs` return path flows through it (`final = await this.withCorpusRoot(...)` at line 6298, covering the cached and uncached branches). `docs-search.ts` declares `corpus_root` / `corpus_count`. Test "with the corpus off the reply has neither field, and with it on the reply is the same reply plus exactly those two" asserts the cold reply's `coldRoot` equals `shortRoot(corpusRoot([DOC_A, DOC_B]).root)` and `coldCount` is 2. "a request that moved the manifest drops the cached root" covers the during-ingest reply. All pass. |

**Score:** 3/4 truths verified (criterion 3 UNCERTAIN, routed to human verification)

### Deferred Items

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
