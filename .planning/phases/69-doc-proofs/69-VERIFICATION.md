---
phase: 69-doc-proofs
verified: 2026-11-05T01:17:28Z
status: human_needed
score: 5/7 truths verified (2 present but behavior-unverified)
covered_files: [".planning/phases/69-doc-proofs/69-SUMMARY.md", "docs/corpus-proofs.md", "docs/event-vocabulary.md", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/proof.test.ts", "packages/cli/src/corpus/proof.ts", "packages/cli/src/corpus/render.ts", "packages/corpus/src/index.ts", "packages/corpus/src/leaf.test.ts", "packages/corpus/src/leaf.ts", "packages/corpus/src/protocol.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/corpus/anchor.test.ts", "packages/mcp-server/src/corpus/anchor.ts", "packages/mcp-server/src/corpus/proofs.routes.test.ts", "packages/mcp-server/src/corpus/proofs.test.ts", "packages/mcp-server/src/corpus/root.test.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/corpus/store.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/reserved-actions.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:f5febf73a16d97b69e2cbf547f2cc0d8dd082dc9b74ec2d44878145340f7af00"
behavior_unverified: 2
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 3/7
  gaps_closed:
    - "SC2 literal wording 'each sync emits one docs.corpus.root note': amended 2026-11-04 (owner decision d) to one note per changing ingest, coalesced in a 5 s window; shipped behaviour checked against the amended text"
    - "SC4 literal wording 'docs_search replies carry corpus_root': amended 2026-11-04 (owner decision d) to a value read from the cache; shipped behaviour checked against the amended text"
  gaps_remaining: []
  regressions: []
behavior_unverified_items:
  - truth: "Anchored-hour and transaction are reported by `substrate corpus verify --online` when a real anchored hour exists (SC3, online half)"
    test: "After the operator enables the anchor job and an hour containing a docs.corpus.root event is anchored: run `substrate corpus prove --repo R --path P --out FILE`, then `substrate corpus verify FILE --online`"
    expected: "Report names the anchored hour and the devnet transaction; the memo of that transaction carries the same root"
    why_human: "anchor.test.ts classifies anchor evidence through fake readers only; no anchored hour exists on this host and the anchor job, its key and its timer are operator-gated"
  - truth: "The owed docs.corpus.root event is written during SIGTERM shutdown through drainCorpusRoots, before the event drain, inside SHUTDOWN_RETAIN_MS (PROOF-02 end to end)"
    test: "Run the server with SUBSTRATE_CORPUS=on, ingest one document, send SIGTERM before the 5 s root window elapses, then query the ledger for session corpus-root"
    expected: "Exactly one docs.corpus.root event for the final manifest state is in the ledger after the process exits"
    why_human: "Substrate.drainCorpusRoots is exercised by proofs.test.ts:239, but the index.ts SIGTERM handler that calls it (index.ts:257) has no test; the signal path needs a live process and ledger"
human_verification:
  - test: "Operator first real run from docs/corpus-proofs.md 'How a third party verifies': enable SUBSTRATE_CORPUS=on, ingest, prove, wait for the hour to be anchored, verify --online, read the memo"
    expected: "Anchored hour and transaction reported, memo root equals the proof root; before anchoring every root reads unanchored"
    why_human: "Requires the funded devnet key, the anchor timer and a real anchored hour, none of which exist in this environment (operator-gated). Covers SC3 online half (truth 4)"
  - test: "Run the server with SUBSTRATE_CORPUS=on, ingest one document, send SIGTERM inside the 5 s root window, then query ledger session corpus-root"
    expected: "Exactly one docs.corpus.root event for the final manifest state after the process exits"
    why_human: "The index.ts SIGTERM handler (index.ts:257) is untested; drainCorpusRoots itself is tested (proofs.test.ts:239). Covers truth 7"
  - test: "Confirm the owed root is not lost when an ingest is still writing at shutdown"
    expected: "Owner accepts that flush() skips the write while writers > 0 (root.ts:317 `if (this.owed && this.writers === 0)`), or requests that flush await the ingest"
    why_human: "No test covers shutdown during an in-flight ingest; the design choice is recorded only in code comments. Not a success-criterion wording item: an owner-open design point"
---

# Phase 69: Doc proofs, a Merkle root over the corpus manifest: Verification Report

**Phase Goal:** Which documents the corpus held, and when, can be proved from the Solana devnet anchor the ledger already writes every hour.
**Verified:** 2026-11-05T01:17:28Z
**Status:** human_needed
**Re-verification:** No (initial mode per Step 0: the prior 69-VERIFICATION.md had no `gaps:` list). The two owner-open wording items from the prior record (SC2, SC4) were re-judged against the amended ROADMAP text.
**Head:** ca9d02ec (worktree /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all)

## Scope and sources

- Must-haves: ROADMAP Phase 69 success criteria 1 to 4, using the amended text in force since the 8e7cdbb1 amendment (owner decisions 2026-11-04 (d)), plus PROOF-02's shutdown invariant from commits 44fdd48a and 3139c948 (carried from the prior record). No PLAN.md exists for this phase ("Plans: none written").
- Requirements: PROOF-01 to PROOF-04 (REQUIREMENTS.md, Doc Proofs section, with the 2026-11-04 amendments to PROOF-02 and PROOF-04).
- SUMMARY.md claims were not treated as evidence; each truth was checked against code and the targeted test run below.
- Change since the prior record (head c40ffc9a): the only covered file that changed is `packages/mcp-server/src/service.ts`, in one hunk at lines 7476-7494 (`corpusFreshness`, the docs.freshness lag verdict of phase 65). It does not touch the corpus root, proof, drain, or `withCorpusRoot` code (service.ts:6395, 6885-6909). The change is inert for phase 69. All other covered files are byte-identical to c40ffc9a.
- Not in the prior record's covered list: `packages/mcp-server/src/corpus/proofs.routes.test.ts` (160 lines, 8 tests). It is now listed and was run (see Behavioral Spot-Checks).
- Postgres: no Postgres-gated files in this phase (grepped for `SUBSTRATE_TEST_PG_URL`, `postgres://` and PG helpers across the covered test files, including `proofs.routes.test.ts`: no matches). `SUBSTRATE_TEST_PG_URL` was unset for every run. No Postgres counts are claimed.
- Gates not run here (tsc, lint, full suite, formatters) per assignment. No code was edited and nothing was committed.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: `corpusRoot` is the RFC 6962 root over sorted `(repo, path, sha256)` leaves built with `@substrate/ledger`, identical for equal manifests, different for any change | ✓ VERIFIED | `packages/mcp-server/src/corpus/root.ts:14` imports `merkleProofHex`/`merkleRootHex` from `@substrate/ledger`; `corpusRoot` at root.ts:68 sorts by `(repo, path)` and folds `corpusLeafHex` leaves (`packages/corpus/src/leaf.ts`, pinned vectors in `leaf.test.ts`). Targeted run at ca9d02ec: 92 pass, 0 fail (includes root.test.ts). |
| 2 | SC2 (amended 2026-11-04): one `docs.corpus.root` note per changing ingest, coalesced in a 5 s window, carrying root, count and manifest version (event-sources row; no new kind; no new memo format) | ✓ VERIFIED | Trigger: a changed ingest calls `manifestChanged()` (root.ts ~240-248), which sets `owed` and arms one timer through `scheduleEmit()` with a wait of `ROOT_EMIT_MIN_INTERVAL_MS` (5,000, root.ts:25, :255). `emitOnce` (root.ts:285-305) emits kind `note`, surface `substrate`, session `corpus-root`, payload `{action: docs.corpus.root, root, count, manifest_version}`; it skips when count is 0 or the root equals `lastEmittedRoot`, and never when the manifest is over `MAX_CORPUS_LEAVES` (100,000, root.ts:31, :206). Row: `packages/mcp-server/src/event-sources.ts:1447-1459`; reserved action in `reserved-actions.ts`; `docs/event-vocabulary.md`. Named tests: root.test.ts "changes inside the window are coalesced into one event that carries the latest state" (line 186) and "flush writes the owed root now, without the timer, exactly once" (line 172); proofs.test.ts "a later unchanged ingest owes nothing" (line ~293). All pass at ca9d02ec. A refused write is not recorded as the last root (`if (written.stored)`, root.ts:303). |
| 3 | SC3 (offline half): `substrate corpus prove` returns an inclusion proof; `substrate corpus verify` accepts a valid proof offline and rejects a tampered repo, path, leaf or sibling | ✓ VERIFIED | `packages/cli/src/corpus/index.ts`, `proof.ts` (`verifyProofOffline`, `conflictWith`), `render.ts`. Offline verification reuses `verifyMerkleProofHex` from `@substrate/ledger`. Targeted run at ca9d02ec: `packages/cli/src/corpus/proof.test.ts` and `packages/corpus/src/leaf.test.ts` pass in the 92-test run. |
| 4 | SC3 (online half): `verify` reports the anchored hour and transaction when chain evidence exists, `unanchored` when it does not | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Present and wired: `packages/mcp-server/src/corpus/anchor.ts` (`corpusAnchorStatus` reads the `corpus-root` session newest first, judges via `verifyEventRef`; no transaction is sent). `anchor.test.ts` passes in the 92-test run but uses fake readers only. No real anchored hour exists on this host (operator-gated). Routed to human verification. |
| 5 | SC4 (amended 2026-11-04): `docs_search` replies carry `corpus_root` (short form) and the value is read from the cache, so an uncached reply carries none | ✓ VERIFIED | `docs-search.ts:212-216` `SearchReply.corpus_root` / `corpus_count`. `service.ts:6899-6909` `withCorpusRoot` calls `roots.peek()`; on null it only calls `roots.warm()` and returns the reply unchanged, otherwise it adds `shortRoot(snapshot.root)` and `snapshot.count`. Named test: proofs.test.ts "docs_search names the corpus root it was answered under" (line 196) asserts the fields are absent while nothing is cached (line 207) and present from the cache (line 215); "a request that moved the manifest drops the cached root" (line 221). All pass at ca9d02ec. |
| 6 | PROOF-02 keeper invariant: an owed root is written at shutdown by `flush()` exactly once, through `Substrate.drainCorpusRoots`; a second drain writes nothing more (commits 44fdd48a, 3139c948) | ✓ VERIFIED | `root.ts` `flush()` (~line 310-317): awaits an in-flight emission, advances `timerToken`, clears `timerPending`, then `emitRoot()` if `owed && writers === 0`; a stale timer token returns early. `service.ts` `drainCorpusRoots` races `flush()` against `Bun.sleep(timeoutMs)`. Named tests: root.test.ts line 172 (keeper level) and proofs.test.ts:239 "drainCorpusRoots writes an owed root once and leaves the armed timer disarmed; a second drain writes nothing more" (service level). Pass at ca9d02ec. |
| 7 | PROOF-02 end-to-end wiring: SIGTERM shutdown awaits `drainCorpusRoots` after the retain drain and before the event drain, bounded by `SHUTDOWN_RETAIN_MS` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Present and wired: `packages/mcp-server/src/index.ts:257` `await substrate.drainCorpusRoots(SHUTDOWN_RETAIN_MS)` between `drainPendingRetains` (:255) and `drainPendingEvents` (:260); `SHUTDOWN_RETAIN_MS = 10_000` (index.ts:221). The method is observed by proofs.test.ts (truth 6). The SIGTERM handler and its order are not exercised by any test; the signal path was not run (per assignment, this stays unobserved). Routed to human verification. |

**Score:** 5/7 truths verified (2 present but behavior-unverified: truths 4 and 7). Truths 2 and 5 moved from WARNING to VERIFIED because the amended ROADMAP text is in force and the shipped behaviour matches it.

### Deferred Items

None. No later milestone phase in ROADMAP addresses corpus root emission, proofs or docs_search corpus fields (Step 9b matched nothing).

### Advisory (New Scope, Unevidenced)

Not applicable: no new-scope re-verification finding.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/corpus/src/leaf.ts` | leaf encoding, `CORPUS_EMPTY_ROOT`, `shortRoot` | ✓ VERIFIED | exists; pinned vectors in `leaf.test.ts` (pass) |
| `packages/corpus/src/protocol.ts` | wire types for root/proof/anchor responses | ✓ VERIFIED | exists; exported via `packages/corpus/src/index.ts` |
| `packages/mcp-server/src/corpus/root.ts` | tree, proof, `CorpusRootKeeper` with `flush` | ✓ VERIFIED | exists, substantive (root, proof, keeper, timer token, owed flag, flush) |
| `packages/mcp-server/src/corpus/anchor.ts` | anchor classification | ✓ VERIFIED (file) | exists; positive online path is behavior ⚠️ see truth 4 |
| `packages/mcp-server/src/corpus/service.ts` | corpus doors, ingest bracket | ✓ VERIFIED | exists; `corpusRootReply`, `corpusProofReply`, `corpusAnchorReply` |
| `packages/mcp-server/src/corpus/proofs.routes.test.ts` | proof-route gates and audit record | ✓ VERIFIED | 8 tests (401 gate, 503 when corpus off, `GET /corpus/root` and `/corpus/proof`, `GET /corpus/anchor`, audit under `corpus_status`); all pass at ca9d02ec |
| `packages/mcp-server/src/service.ts` | `corpusRoot`, `drainCorpusRoots`, `withCorpusRoot` | ✓ VERIFIED | exists; `drainCorpusRoots` observed by proofs.test.ts (truth 6); its SIGTERM caller is not (truth 7). The c40ffc9a→ca9d02ec change is at 7476-7494 (docs.freshness), outside these methods; inert for phase 69 |
| `packages/mcp-server/src/corpus/store.ts`, `validate.ts`, `admission.ts`, `server.ts` | manifest read, validation, route classes, `GET /corpus/*` | ✓ VERIFIED (carried forward) | unchanged since c40ffc9a; exercised through the targeted runs |
| `packages/cli/src/corpus/proof.ts`, `render.ts`, `index.ts` | prove, verify, offline verification | ✓ VERIFIED | exists; offline path tested and passing |
| `docs/corpus-proofs.md`, `docs/event-vocabulary.md` | docs and table row | ✓ VERIFIED | exists; row in `docs/event-vocabulary.md` |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `index.ts` SIGTERM handler | `Substrate.drainCorpusRoots` | `await substrate.drainCorpusRoots(SHUTDOWN_RETAIN_MS)` | ✓ WIRED (not behavior-tested) | index.ts:257; no test runs the handler |
| `drainCorpusRoots` | `CorpusRootKeeper.flush` | `Promise.race([flush(), Bun.sleep(timeoutMs)])` | ✓ WIRED | service.ts:6891-6892; exercised by proofs.test.ts:239 |
| `flush` | ledger emit | `emitRoot` -> `emitOnce` -> `deps.emit` | ✓ WIRED | root.ts ~317; keeper constructed in service.ts (~6885); `emit` spied in proofs.test.ts |
| changed ingest | root event | `manifestChanged` -> `scheduleEmit` -> `emitOnce` | ✓ WIRED | root.ts ~240-305; coalesced by `ROOT_EMIT_MIN_INTERVAL_MS`; tested in root.test.ts:186 |
| `docs_search` reply | `corpus_root` field | `withCorpusRoot` -> `roots.peek()` -> `shortRoot(snapshot.root)` | ✓ WIRED | service.ts:6395, 6899-6909 |
| `corpusRoot` | `@substrate/ledger` tree | `merkleRootHex` | ✓ WIRED | root.ts:14 import |
| CLI `prove`/`verify` | server proof route | client | ✓ WIRED (offline path tested) | proof.test.ts passes; online path depends on truth 4 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `CorpusRootKeeper.emitOnce` | `read.snapshot.root` | `CorpusStore.activeLeaves` manifest read | Yes (store query, tree built from rows) | ✓ FLOWING |
| `withCorpusRoot` | `corpus_root` | keeper cache (`peek()`) | Yes when cached; absent otherwise (by amended SC4) | ✓ FLOWING (cache-gated by design) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Root determinism, keeper coalesce and flush, drainCorpusRoots writes the owed root once, docs_search corpus fields (cached only), proof-route gates and audit, anchor classification, offline prove/verify, leaf vectors | `cd /root/src/worktrees/as-gsd-v18-all && env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/corpus/root.test.ts packages/mcp-server/src/corpus/proofs.test.ts packages/mcp-server/src/corpus/proofs.routes.test.ts packages/mcp-server/src/corpus/anchor.test.ts packages/cli/src/corpus/proof.test.ts packages/corpus/src/leaf.test.ts` | 92 pass, 0 fail, 340 expect() calls, 811 ms | ✓ PASS |
| Live SIGTERM shutdown drain writes the owed root | not run: requires a live process and ledger | — | ? SKIP (routed to human, truth 7) |
| Anchored hour reported on real chain | not run: no anchored hour exists | — | ? SKIP (routed to human, truth 4) |

The 92-test run is one command over six files, the non-PG budget for this pass. The prior record's 56 (root, proofs, anchor) and 28 (proof, leaf) totalled 84, so the routes file accounts for the other 8 (its `test(` count is 8).

Postgres-gated tests: none in this phase; `SUBSTRATE_TEST_PG_URL` unset for every run. No Postgres evidence is claimed.

### Probe Execution

Step 7c: SKIPPED (phase is not a migration or tooling phase and declares no probes).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| PROOF-01 | none (no PLAN.md) | deterministic Merkle root over (repo, path, sha256) | ✓ SATISFIED | truth 1 |
| PROOF-02 | none (no PLAN.md) | each changing ingest records the root as a ledger event, coalesced in a 5 s window, covered by the hourly anchor (amended 2026-11-04) | ✓ SATISFIED (amended wording); shutdown end-to-end ? NEEDS HUMAN | truths 2 and 6 VERIFIED; truth 7 is the unobserved SIGTERM wiring |
| PROOF-03 | none (no PLAN.md) | `prove` gives a proof; `verify` checks offline and against the anchored hour when evidence exists | ✓ SATISFIED (offline) / ? NEEDS HUMAN (online) | truths 3 and 4 |
| PROOF-04 | none (no PLAN.md) | `docs_search` replies carry the short corpus root, read from the cache (amended 2026-11-04) | ✓ SATISFIED | truth 5 |

Orphaned requirements: none. REQUIREMENTS.md maps PROOF-01 to PROOF-04 to phase 69; 69-SUMMARY.md frontmatter claims all four.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (all covered non-markdown implementation and test files) | - | TBD / FIXME / XXX / TODO / HACK / PLACEHOLDER | none found | No debt-marker blocker (grep at ca9d02ec) |
| `packages/mcp-server/src/corpus/root.ts` | 317 | `owed && writers === 0` skips the write while an ingest is in flight | ℹ️ Info | Residual design limit; human item 3 |
| `packages/mcp-server/src/corpus/root.ts` | 292 | a changed ingest whose root equals `lastEmittedRoot` emits nothing | ℹ️ Info | Consistent with "one note per changing ingest" only as far as the root changes; no test change needed |
| `packages/mcp-server/src/corpus/root.ts` | 303 | a root the ledger refused is not retried until the next change | ℹ️ Info | Recorded as a gap in 69-SUMMARY.md "What remains"; not an SC |

### Human Verification Required

1. **Real anchored hour (operator).** Test: follow docs/corpus-proofs.md "How a third party verifies" after enabling the anchor job. Expected: `verify --online` reports the anchored hour and transaction; memo root equals the proof root. Why human: funded devnet key and timer are operator-gated (truth 4).
2. **Live SIGTERM drain.** Test: run with `SUBSTRATE_CORPUS=on`, ingest, SIGTERM inside the 5 s window, query ledger session `corpus-root`. Expected: one `docs.corpus.root` event for the final manifest state. Why human: needs a live process and ledger; the index.ts signal handler is untested (truth 7).
3. **Shutdown during an in-flight ingest.** Test: confirm that an owed root is dropped when an ingest is still writing at shutdown (`writers > 0`). Expected: owner accepts, or requests flush to await the ingest. Why human: no test; owner-open design point (root.ts:317). Not a success-criterion wording item.

### Open items

- Operator-gated anchored hour (truth 4; SC3 online half). Unchanged.
- SIGTERM handler unexercised (truth 7; index.ts:257). Unchanged; per assignment it stays unobserved.
- Owner-open design: an owed root is dropped when an ingest is still writing at shutdown (root.ts:317). Unchanged.
- SC2 and SC4 wording: resolved by the 2026-11-04 owner amendments now in ROADMAP.md and REQUIREMENTS.md. No owner decision outstanding for them.
- Known gap (not an SC): a root event lost to a failed write is not retried; after a restart the current root may be stored once more (69-SUMMARY.md "What remains").

### Gaps Summary

No truth FAILED and no artifact is missing, stub or unwired. Status is `human_needed` rather than `passed` because two behavior-dependent truths have no exercising test in this environment: the real anchored hour (truth 4, operator-gated) and the SIGTERM handler that calls `drainCorpusRoots` (truth 7). The owner-amended SC2 and SC4 wordings are now met by the shipped behaviour and are no longer human decisions.

---

_Verified: 2026-11-05T01:17:28Z_
_Verifier: Claude (gsd-verifier)_
