---
phase: 69-doc-proofs
verified: 2026-11-06
status: human_needed
score: 5/7 truths verified (2 present but behavior-unverified)
covered_files: [".planning/phases/69-doc-proofs/69-SUMMARY.md", "docs/corpus-proofs.md", "docs/event-vocabulary.md", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/proof.test.ts", "packages/cli/src/corpus/proof.ts", "packages/cli/src/corpus/render.ts", "packages/corpus/src/index.ts", "packages/corpus/src/leaf.test.ts", "packages/corpus/src/leaf.ts", "packages/corpus/src/protocol.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/corpus/anchor.test.ts", "packages/mcp-server/src/corpus/anchor.ts", "packages/mcp-server/src/corpus/proofs.routes.test.ts", "packages/mcp-server/src/corpus/proofs.test.ts", "packages/mcp-server/src/corpus/root.test.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/corpus/store.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/reserved-actions.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:69b0a13b2cf69f765e8410f48c9bc439431030369ab2928b823f482c6787d728"
behavior_unverified: 2
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/7
  previous_head: a46d42c3
  head: 5e304ef8
  gaps_closed: []
  gaps_remaining:
    - "Owed root dropped at shutdown while an ingest is writing (root.ts:400, owner-open)"
    - "Anchored hour (operator-gated)"
    - "SIGTERM handler live run (operator-gated; index.ts:258 untested)"
  regressions: []
  change_since_prior: "a46d42c3..5e304ef8 (14 commits; the prior record's head was a46d42c3). Covered files changed: root.ts, corpus/service.ts, corpus/slo.ts, corpus/store.ts, corpus/validate.ts, corpus/sync-event.ts, service.ts, docs-search.ts, server.ts, admission.ts, event-sources.ts, cli/src/corpus/client.ts, index.ts, render.ts, corpus/src/leaf.ts, protocol.ts. In every hunk touching root.ts, corpus/service.ts, service.ts (corpus root hooks), leaf.ts and the CLI proof path, the only change is removal of the `export` keyword (commits b8cbdeac, d9d0a401, 4c576e5e, 8ec17832, 66fa97bd); no line of the root, keeper, retry, flush, drain, anchor or proof logic changed. Behaviour changes in covered files outside this record's criteria: index.ts (e62bc17b: reportSilent import at :50 and a catch at the shutdown exporter flush, :273; the shutdown drain sequence is unchanged and shifted one line); docs-search.ts (885e73ce: citation commit scan, `citableCommit`, `ManifestCommitRecord`; e62bc17b: reportSilent at two catches); service.ts (0947001e: manifestCommit lookup at :6421 now returns the record; e62bc17b: silent-failure reporting elsewhere); server.ts (14ac787a: REST handoff refuses a `to` outside SURFACES with 400 at :1507-1510; no corpus route changed). Retry and buffered handling (e3914640) were already in the prior record. Not in the covered list and changed in the range: corpus/ingest.ts, corpus/slo.ts (number return), cli/src/corpus/testkit.ts, cache.ts (f1266a9c), memory-retain.ts and index-sweep.ts (a2176f96); none is on the root event, keeper, proof or anchor path. The 69-SUMMARY 'What remains' and 'Deviations' text that says a failed root is not retried is stale (see Open items)."
behavior_unverified_items:
  - truth: "Anchored-hour and transaction are reported by `substrate corpus verify --online` when a real anchored hour exists (SC3, online half)"
    test: "After the operator enables the anchor job and an hour containing a docs.corpus.root event is anchored: run `substrate corpus prove --repo R --path P --out FILE`, then `substrate corpus verify FILE --online`"
    expected: "Report names the anchored hour and the devnet transaction; the memo of that transaction carries the same root"
    why_human: "anchor.test.ts classifies anchor evidence through fake readers only (FakeLedger, anchor.test.ts:51); no anchored hour exists on this host and the anchor job, its key and its timer are operator-gated (not re-probed in this pass)"
  - truth: "The owed docs.corpus.root event is written during SIGTERM shutdown through drainCorpusRoots, before the event drain, inside SHUTDOWN_RETAIN_MS (PROOF-02 end to end)"
    test: "Run the server with SUBSTRATE_CORPUS=on, ingest one document, send SIGTERM before the 5 s root window elapses, then query the ledger for session corpus-root"
    expected: "Exactly one docs.corpus.root event for the final manifest state is in the ledger after the process exits"
    why_human: "Substrate.drainCorpusRoots is exercised by proofs.test.ts:279, but the index.ts SIGTERM handler that calls it (index.ts:258) has no test; the signal path needs a live process and ledger"
human_verification:
  - test: "Operator first real run from docs/corpus-proofs.md 'How a third party verifies': enable SUBSTRATE_CORPUS=on, ingest, prove, wait for the hour to be anchored, verify --online, read the memo"
    expected: "Anchored hour and transaction reported, memo root equals the proof root; before anchoring every root reads unanchored"
    why_human: "Requires the funded devnet key, the anchor timer and a real anchored hour, none of which were observed here (operator-gated). Covers SC3 online half (truth 4)"
  - test: "Run the server with SUBSTRATE_CORPUS=on, ingest one document, send SIGTERM inside the 5 s root window, then query ledger session corpus-root"
    expected: "Exactly one docs.corpus.root event for the final manifest state after the process exits"
    why_human: "The index.ts SIGTERM handler (index.ts:258) is untested; drainCorpusRoots itself is tested (proofs.test.ts:279). Covers truth 7"
  - test: "Confirm the owed root is not lost when an ingest is still writing at shutdown"
    expected: "Owner accepts that flush() skips the write while writers > 0 (root.ts:400 `if (this.owed && this.writers === 0)`), or requests that flush await the in-flight ingest"
    why_human: "No test covers shutdown during an in-flight ingest; the design choice is recorded only in code comments. Owner-open design point, not a success-criterion wording item"
---

# Phase 69: Doc proofs, a Merkle root over the corpus manifest: Verification Report

**Phase Goal:** A Merkle root over the corpus manifest, recorded so the existing hourly anchor covers it, with proofs and verification. It does not send a transaction and does not change the memo format (69-CONTEXT.md D69-1 to D69-4). Must-haves: ROADMAP Phase 69 success criteria 1 to 4 (owner amendments dated 2026-11-05 for SC2 and SC4), plus PROOF-02's shutdown invariant.
**Verified:** 2026-11-06
**Status:** human_needed
**Re-verification:** Yes, at HEAD 5e304ef8, after the prior record at a46d42c3 (5/7, human_needed). Focus: each criterion re-checked against the code at the current head; the change range a46d42c3..5e304ef8 checked hunk by hunk on the covered files.

## Scope and sources

- Must-haves: ROADMAP Phase 69 SC1 to SC4 and PROOF-02's shutdown invariant; the owner's correction for buffered and dead-lettered roots (2026-11-05). No PLAN.md exists ("Plans: none written"); 69-SUMMARY.md is not evidence.
- Test evidence: `/root/src/worktrees/backups/gate-r38-junit.xml` (run on 66fa97bd; its only failure was a ratchet check, fixed at the code head by 5e304ef8, which changes only `scripts/code-ratchet.baseline.json`, `config.ts` and `hindsight-canary-run.ts`, none of them covered here). The r39 run on the current head was not yet written (`gate-r39-junit.xml` absent at this pass), so no pass count is claimed. Each title below is grepped in source under the worktree and appears in gate-r38 as a testcase with no `<failure>`, `<error>` or `<skipped>` child.
- Tests were NOT run in this pass (assignment).
- Code head: 5e304ef8 (clean worktree). Recorded commit for this verification: a46d42c3 (prior record head). Diff used: `git diff a46d42c3 HEAD -- <covered files>`.
- SUMMARY staleness: 69-SUMMARY.md "Deviations" and "What remains" say a refused or failed root "is not retried until the next change". That is no longer true after e3914640 (in a46d42c3). The SUMMARY is not evidence and is not edited here.
- Postgres: no Postgres-gated files in the covered list; no Postgres counts claimed.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: `corpusRoot` is the RFC 6962 root over sorted `(repo, path, sha256)` leaves built with `@substrate/ledger`, identical for equal manifests, different for any change | ✓ VERIFIED | `packages/mcp-server/src/corpus/root.ts:13` imports `corpusLeafHex` from `@substrate/corpus`; `root.ts:14` imports `merkleRootHex` and `merkleProofHex` from `@substrate/ledger`; `corpusRoot` at root.ts:89 folds `merkleRootHex` (root.ts:85). Unchanged at head except the `export` keyword (see Change check). Tests (gate-r38, pass): root.test.ts "is the ledger's RFC 6962 root over the leaves sorted by (repo, path), whatever order the rows arrive in"; "a changed hash, path or repository changes the root"; leaf.test.ts "is pinned to known vectors, so the encoding cannot change without a new domain string". |
| 2 | SC2 (amended 2026-11-05): one `docs.corpus.root` note per changing ingest, coalesced in a 5 s window, carrying root, count and manifest version. After the correction: a buffered or dead-lettered root is not written again | ✓ VERIFIED | Trigger: `corpus/service.ts:242` `deps.roots.writeStarted()`; `:250` `changed = counts.ingested + counts.updated + counts.tombstoned + counts.failed > 0`; `:253` `writeSettled(changed)` (in `finally`) → `manifestChanged()` (root.ts:289-294) → `scheduleEmit()` (root.ts:299-303). Reconcile bracket at `corpus/service.ts:298/:306` uses the same pair. Window: `ROOT_EMIT_MIN_INTERVAL_MS` = 5,000 (root.ts:25), measured from the last write attempt (root.ts:301, `lastWriteMs` set at :358). Payload `{action, root, count, manifest_version}`, kind `note`, session `corpus-root` (`CORPUS_ROOT_SESSION` root.ts:22; payload root.ts:366). Retry: `rootRetryMs` (root.ts:31) with `ROOT_RETRY_MAX_MS` (root.ts:28), armed at root.ts:382 after a refused or thrown write. Buffered or dead-lettered: root.ts:368-374, not owed, no timer; buffered sets `lastEmittedRoot` (root.ts:371). Tests (gate-r38, pass): root.test.ts "changes inside the window are coalesced into one event that carries the latest state"; "the next event waits out the rest of the five-second window, and one change never writes two"; "a write the ledger refused is not remembered as written: the same state goes out again on the next event"; proofs.test.ts "a root write that fails once is retried five seconds later, and lands exactly once"; "a root write that keeps failing does not spin: in 120 s it is tried once and retried four times, and none lands"; "after a stored write that followed refusals, a change waits the five-second window, and a refusal after it backs off from five seconds again"; "each distinct failure code is reported to stderr once, with the repository count and the code, and never the thrown message"; "a root the server buffered is not written again, so the ledger holds one root". |
| 3 | SC3 (offline half): `substrate corpus prove` returns an inclusion proof; `substrate corpus verify` accepts a valid proof offline and rejects a tampered repo, path, leaf or sibling | ✓ VERIFIED | `packages/cli/src/corpus/proof.ts:30` `verifyProofOffline`, `:51` `conflictWith`; `render.ts` unchanged except `export` removal; reuses `verifyMerkleProofHex` from `@substrate/ledger`. Tests (gate-r38, pass): root.test.ts "every leaf of trees of 1, 2, 3, 5, 8 and 9 documents proves against the root, at its first, middle and last index"; "a tampered sibling, leaf or index fails". The CLI `proof.test.ts` is not cited by title here. |
| 4 | SC3 (online half): `verify` reports the anchored hour and transaction when chain evidence exists, `unanchored` when it does not | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Present: `packages/mcp-server/src/corpus/anchor.ts:176` `corpusAnchorStatus` (no transaction sent). `anchor.test.ts` uses fake readers only (FakeLedger at anchor.test.ts:51). No real anchored hour observed; the anchor job, its key and its timer are operator-gated (D69-4). anchor.ts and anchor.test.ts unchanged in the range. Not re-probed in this pass. Routed to human verification. |
| 5 | SC4 (amended 2026-11-05): `docs_search` replies carry `corpus_root` (short form), read from the cache, so an uncached reply carries none | ✓ VERIFIED | `docs-search.ts:218` `corpus_root?`, `:219` `corpus_count?` (were :217-218; the interface is unchanged). `service.ts:6468` calls `withCorpusRoot`; definition `service.ts:6974-6983` calls `roots.peek()` (accessor `corpusRoots()` at service.ts:6959-6961); on null it only starts `roots.warm()`. Range change: `docs-search.ts` citation scan (885e73ce) and `service.ts:6421` manifest lookup (0947001e) change which commit a corpus chunk is cited at, not the root fields; hunk check confirms no change to lines 6468 or 6959-6983. Test (gate-r38, pass): proofs.test.ts "with the corpus off the reply has neither field, and with it on the reply is the same reply plus exactly those two"; "a request that moved the manifest drops the cached root, so a reply never names a stale one". |
| 6 | PROOF-02 keeper invariant: an owed root is written at shutdown by `flush()` exactly once, through `Substrate.drainCorpusRoots`; a second drain writes nothing more | ✓ VERIFIED | `root.ts:396-401` `flush()`: awaits an in-flight emission, advances `timerToken`, clears `timerPending`, then `emitRoot()` if `owed && writers === 0` (root.ts:400). `service.ts:6965-6968` `drainCorpusRoots` races `flush()` against `Bun.sleep(timeoutMs)`; no-op when no keeper was made. Unchanged in the range. Tests (gate-r38, pass): proofs.test.ts "drainCorpusRoots writes an owed root once and leaves the armed timer disarmed; a second drain writes nothing more" (proofs.test.ts:279). Also root.test.ts "flush writes the owed root now, without the timer, exactly once: the root and the count go out a single time" (:172). |
| 7 | PROOF-02 end-to-end wiring: SIGTERM shutdown awaits `drainCorpusRoots` after the retain drain and before the event drain, bounded by `SHUTDOWN_RETAIN_MS` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Present: `packages/mcp-server/src/index.ts:258` `await substrate.drainCorpusRoots(SHUTDOWN_RETAIN_MS)`, between `drainPendingRetains` (:256) and `drainPendingEvents` (:261); `SHUTDOWN_RETAIN_MS = 10_000` (index.ts:222). Changed in the range (was `:257`, `:255`, `:260`, `:221`): an import of `reportSilent` at :50 and a catch on the shutdown exporter flush at :273 (e62bc17b). The drain sequence and its ordering are unchanged. No test runs the handler; live signal path not run. Routed to human verification. |

**Score:** 5/7 truths verified (2 present but behavior-unverified: truths 4 and 7). Truths 1, 2, 3, 5 and 6 remain VERIFIED at the current head. Truth 2 covers the correction: the buffered branch is test-verified (proofs.test.ts:361); the dead-lettered branch is code-verified only.

### Correction check: buffered and dead-lettered roots

- Buffered: not owed (`owed` cleared at root.ts:343; root.ts:370 takes the buffered branch and returns before the `this.owed = true` at root.ts:379), no timer armed (`writeRoot` returns before `arm` at root.ts:382), counted as emitted (`lastEmittedRoot = root`, root.ts:371). Test-verified: proofs.test.ts:361 ("attempts [0]", "clock.timers toEqual []", one root event after the buffer lands).
- Dead-lettered: not owed, no retry timer (root.ts:370-374); `lastEmittedRoot` not set, so a later changing ingest that yields the same root writes it again. That is the intended reading of "one note per changing ingest" when the ledger holds no copy; it is a difference in handling from buffered, stated here, not a defect. No test: `deadLettered` appears in neither proofs.test.ts nor root.test.ts.
- Edge (info): a buffered root sets `lastEmittedRoot`, so if the buffer later gives up on it (dead-letter record) and the manifest returns to that same root before any other root is stored, the identical root is skipped (root.ts:344). The ledger then holds no copy, but the server holds a dead-letter record. Consistent with the owner's rule that a buffered root counts as emitted; no test.

### Change check (a46d42c3..5e304ef8, covered files)

- `corpus/root.ts`: 11 hunks, every one a removal of the `export` keyword (ROOT_RETRY_MAX_MS, rootRetryMs, MAX_CORPUS_LEAVES, CorpusTree, CorpusInclusion, CorpusRootSnapshot, CorpusRootAnswer, CorpusRootRead, systemRootClock, RootEmitAnswer, CorpusRootKeeperDeps). Line count unchanged. Keeper, retry, flush, drain and reportOnce logic: no hunk.
- `corpus/service.ts`: two `export` removals (CorpusRefusalReason, CorpusRefusal). The ingest bracket (writeStarted :242, writeSettled :253 in `finally`) has no hunk.
- `service.ts`: one `export` removal (`EmitOptions`) and the docs_search `manifestCommit` lambda at :6421 (now returns the record, not its commit, per 0947001e). No hunk in `emit` (:2988), `corpusRoots` (:6959-6961), `drainCorpusRoots` (:6965-6968) or `withCorpusRoot` (:6974-6983).
- `index.ts`: changed, not unchanged as the prior record said (see truth 7).
- `docs-search.ts`: 86 lines. `corpus_root`/`corpus_count` interface unchanged (now :218-219). Hunks: `ManifestCommitRecord` and `citableCommit` (885e73ce), `reportSilent` at two catches (e62bc17b), export removals.
- `server.ts`: export removals, and one REST `/handoff` hunk (14ac787a, :1504-1510) refusing a `to` outside SURFACES with 400 before anything is written. No corpus route changed.
- `corpus/leaf.ts`: `CORPUS_SHORT_ROOT_LENGTH` (value 12) and `LeafRefusal` lose `export`; `shortRoot` (leaf.ts:73-74) unchanged. `corpus/protocol.ts`, `corpus/store.ts`, `corpus/validate.ts`, `corpus/sync-event.ts`, `admission.ts`, `event-sources.ts`, `cli/src/corpus/client.ts`, `index.ts`, `render.ts`: `export` removals only.
- `corpus/slo.ts`, `corpus/ingest.ts`, `cli/src/corpus/testkit.ts`, `cache.ts` (f1266a9c), `memory-retain.ts`, `index-sweep.ts` (a2176f96): changed in the range, not in the covered list and not on the root, keeper, proof or anchor path.
- `cli/src/corpus/proof.ts`, `proof.test.ts`, `anchor.ts`, `anchor.test.ts`, `proofs.routes.test.ts`, `root.test.ts`, `proofs.test.ts`, `corpus/src/index.ts`, `leaf.test.ts`, `docs/corpus-proofs.md`, `docs/event-vocabulary.md`, `69-SUMMARY.md`: no change in the range.

### Deferred Items

None. No later milestone phase in ROADMAP addresses corpus root emission, proofs or docs_search corpus fields.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/corpus/root.ts` | root, proof, keeper, retry, drain | ✓ VERIFIED | 402 lines. Retry, `writeRoot`, `reportOnce`, `refusalCode`/`thrownCode` (root.ts:36, :42) from e3914640 (in a46d42c3). Range change: export removals only. |
| `packages/mcp-server/src/corpus/proofs.test.ts` | keeper, retry, drain and door tests | ✓ VERIFIED | Retry describe at :308-377 (five tests: :309, :319, :329, :345, :361). Titles cited below exist in source and in gate-r38. |
| `packages/mcp-server/src/corpus/root.test.ts` | keeper and tree tests | ✓ VERIFIED | Titles cited below exist in source and in gate-r38. |
| `packages/mcp-server/src/corpus/service.ts` | ingest bracket | ✓ VERIFIED | `writeStarted` :242, `writeSettled` :253 in `finally`. Export removal only. |
| `packages/mcp-server/src/service.ts` | `corpusRoots`, `drainCorpusRoots`, `withCorpusRoot`, `emit` | ✓ VERIFIED | `corpusRoots` 6959-6961; `drainCorpusRoots` 6965-6968; `withCorpusRoot` 6974-6983; `emit` 2988 (`EmitResult` contract 626-657). No corpus-root hunk in the range. |
| `packages/mcp-server/src/index.ts` | SIGTERM calls the drain | ⚠️ PRESENT (truth 7) | `drainCorpusRoots` at :258; no test runs the handler. Changed in the range by e62bc17b (import :50, catch :273), drain sequence unchanged. |
| `packages/mcp-server/src/docs-search.ts` | `corpus_root` / `corpus_count` | ✓ VERIFIED | :218-219. |
| `packages/mcp-server/src/corpus/anchor.ts` | anchored-hour classification | ⚠️ PRESENT (truth 4) | Fake-reader tests only. Unchanged in the range. |
| `packages/cli/src/corpus/proof.ts`, `render.ts`, `index.ts`, `client.ts` | prove, verify, offline verification | ✓ VERIFIED | Offline path tested; online path depends on truth 4. Range change: export removals in client.ts, index.ts, render.ts. |
| `docs/corpus-proofs.md`, `docs/event-vocabulary.md` | docs and table row | ✓ VERIFIED | Present, unchanged in the range. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| changed ingest | root event | `writeSettled(changed)` → `manifestChanged` → `scheduleEmit` → `emitRoot` → `emitOnce` → `writeRoot` | ✓ WIRED | corpus/service.ts:242-253; root.ts:289-383 |
| refused / thrown root write | backoff retry | `writeRoot` → `arm(rootRetryMs(failures))` | ✓ WIRED | root.ts:379-382, 306-316; tested proofs.test.ts:309-359 |
| buffered / dead-lettered answer | no further write | `writeRoot` returns before `arm` | ✓ WIRED | root.ts:370-374; buffered tested proofs.test.ts:361; dead-lettered code-only |
| `writeRoot` emit | ledger | `deps.emit` = `Substrate.emit` | ✓ WIRED | service.ts:6960; `EmitResult` service.ts:626-657 |
| `index.ts` SIGTERM | `flush` | `drainCorpusRoots` → `Promise.race([flush(), Bun.sleep])` | ✓ WIRED (not behavior-tested for the signal) | index.ts:258; service.ts:6965-6968; flush exercised by proofs.test.ts:279 |
| `flush` | in-flight ingest | `if (this.owed && this.writers === 0)` | ⚠️ GAP (owner-open) | root.ts:400; no await for `writers > 0` |
| `docs_search` reply | `corpus_root` | `withCorpusRoot` → `roots.peek()` → `shortRoot` | ✓ WIRED | service.ts:6468, 6974-6983 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `CorpusRootKeeper.emitOnce` | `read.snapshot.root` | `CorpusStore.activeLeaves` manifest read → `buildCorpusTree` | Yes | ✓ FLOWING |
| `withCorpusRoot` | `corpus_root` | keeper cache (`peek()`) | Yes when cached; absent otherwise (SC4 as amended) | ✓ FLOWING (cache-gated) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Retry, buffered, coalesce, flush and drain tests | grep of each title in source; presence as a testcase without a failure/error/skipped child in gate-r38-junit.xml; no test run | all 17 cited titles present, none failing or skipped | ✓ PASS (evidence, not re-run) |
| Live SIGTERM shutdown drain writes the owed root | not run: requires a live process and ledger | — | ? SKIP (routed to human, truth 7) |
| Anchored hour reported on real chain | not run: no anchored hour | — | ? SKIP (routed to human, truth 4) |

Test titles relied on (each in `packages/mcp-server/src/corpus/*.test.ts` or `packages/corpus/src/leaf.test.ts`, and a self-closing testcase in gate-r38-junit.xml):

- proofs.test.ts:279 "drainCorpusRoots writes an owed root once and leaves the armed timer disarmed; a second drain writes nothing more"
- proofs.test.ts:309 "a root write that fails once is retried five seconds later, and lands exactly once"
- proofs.test.ts:319 "a root write that keeps failing does not spin: in 120 s it is tried once and retried four times, and none lands"
- proofs.test.ts:329 "after a stored write that followed refusals, a change waits the five-second window, and a refusal after it backs off from five seconds again"
- proofs.test.ts:345 "each distinct failure code is reported to stderr once, with the repository count and the code, and never the thrown message"
- proofs.test.ts:361 "a root the server buffered is not written again, so the ledger holds one root"
- proofs.test.ts:237 "with the corpus off the reply has neither field, and with it on the reply is the same reply plus exactly those two"
- proofs.test.ts:261 "a request that moved the manifest drops the cached root, so a reply never names a stale one"
- root.test.ts:35 "is the ledger's RFC 6962 root over the leaves sorted by (repo, path), whatever order the rows arrive in"
- root.test.ts:53 "a changed hash, path or repository changes the root"
- root.test.ts:82 "every leaf of trees of 1, 2, 3, 5, 8 and 9 documents proves against the root, at its first, middle and last index"
- root.test.ts:95 "a tampered sibling, leaf or index fails"
- root.test.ts:172 "flush writes the owed root now, without the timer, exactly once: the root and the count go out a single time"
- root.test.ts:186 "changes inside the window are coalesced into one event that carries the latest state"
- root.test.ts:201 "the next event waits out the rest of the five-second window, and one change never writes two"
- root.test.ts:232 "a write the ledger refused is not remembered as written: the same state goes out again on the next event"
- leaf.test.ts:10 "is pinned to known vectors, so the encoding cannot change without a new domain string"

Note: the describe block at proofs.test.ts:308 holds five tests. Four are the retry tests (:309, :319, :329, :345); the fifth (:361) is the buffered test.

### Probe Execution

Step 7c: SKIPPED (phase is not a migration or tooling phase and declares no probes).

### Requirements Coverage

| Requirement | Description | Status | Evidence |
| ----------- | ----------- | ------ | -------- |
| PROOF-01 | deterministic Merkle root over (repo, path, sha256) | ✓ SATISFIED | truth 1 |
| PROOF-02 | each changing ingest records the root as a ledger event, coalesced in a 5 s window, covered by the hourly anchor (amended 2026-11-05); a refused root is retried; a buffered or dead-lettered root is not written again | ✓ SATISFIED (amended wording, retry, buffered); shutdown end-to-end ? NEEDS HUMAN | truths 2 and 6 VERIFIED; truth 7 unobserved |
| PROOF-03 | `prove` gives a proof; `verify` checks offline and against the anchored hour when evidence exists | ✓ SATISFIED (offline) / ? NEEDS HUMAN (online) | truths 3 and 4 |
| PROOF-04 | `docs_search` replies carry the short corpus root, read from the cache (amended 2026-11-05) | ✓ SATISFIED | truth 5 |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/corpus/root.ts` | 400 | `owed && writers === 0` drops the owed root when an ingest is writing at shutdown | ℹ️ Info | Owner-open; human item 3 |
| `packages/mcp-server/src/corpus/root.ts` | 370-374 | dead-lettered branch has no test | ℹ️ Info | Code-verified only |
| `packages/mcp-server/src/corpus/root.ts` | 344 | identical root after a buffered-then-given-up write is skipped (see Edge) | ℹ️ Info | Consistent with owner rule; no test |
| `.planning/phases/69-doc-proofs/69-SUMMARY.md` | "Deviations", "What remains" | states a failed root is not retried | ℹ️ Info | Stale after e3914640; not evidence |

### Human Verification Required

1. **Real anchored hour (operator).** Follow docs/corpus-proofs.md "How a third party verifies" after enabling the anchor job. Expected: `verify --online` reports the anchored hour and transaction; memo root equals the proof root. Why human: funded devnet key and timer are operator-gated (truth 4).
2. **Live SIGTERM drain.** Run with `SUBSTRATE_CORPUS=on`, ingest, SIGTERM inside the 5 s window, query ledger session `corpus-root`. Expected: one `docs.corpus.root` event for the final manifest state. Why human: needs a live process and ledger; index.ts:258 is untested (truth 7).
3. **Shutdown during an in-flight ingest.** Confirm that an owed root is dropped when an ingest is still writing at shutdown (`writers > 0`, root.ts:400). Expected: owner accepts, or requests flush to await the in-flight ingest. Why human: no test; owner-open design point.

### Open items

- Owner-open: an owed root is dropped when an ingest is still writing at shutdown (root.ts:400, `flush()`; emitOnce skips at root.ts:340 and :342). Unchanged in substance.
- Operator-gated anchored hour (truth 4; SC3 online half). Unchanged; not re-probed.
- SIGTERM handler unexercised (truth 7; index.ts:258). Unchanged in substance; the line moved from :257 and the file gained the reportSilent catch (e62bc17b).
- Closed before a46d42c3 (not new in this pass): a refused root is retried with backoff (e3914640); a buffered root is not written again (e3914640, proofs.test.ts:361). The 69-SUMMARY "What remains" text is stale on this point.
- Remaining gap (not an SC): a root event lost at shutdown is not retried; after a restart the current root may be stored once more (69-SUMMARY "What remains", second half).

### Owner items (no owner decision for phase 69)

- In-flight shutdown item (root.ts:400, owed root dropped while `writers > 0`): OPEN. The owner has made no decision on this item for phase 69 (owner decisions of 2026-11-06 cover phases 67, 74 and 75 only). Nothing is accepted or waived here, and no `overrides:` entry exists. Choices for the owner: accept the drop as recorded (would need a structured override), or have `flush()` await the in-flight ingest.
- SIGTERM handler live run and the anchored-hour proof: operator-only (verification by an operator run, not an owner decision). Both remain OPEN until an operator run is recorded.

### Gaps Summary

No truth FAILED and no artifact is missing, stub or unwired. Status is `human_needed` rather than `passed` because two behavior-dependent truths have no exercising test here: the real anchored hour (truth 4, operator-gated) and the SIGTERM handler that calls `drainCorpusRoots` (truth 7). The retry and buffered behaviour that e3914640 added are covered by named gate-r38 testcases; the dead-lettered branch is covered by code reading only. Nothing in a46d42c3..5e304ef8 changes a root, keeper, proof or anchor line.

---

_Verified: 2026-11-06_
_Verifier: Claude (gsd-verifier, V69 re-verification draft at 5e304ef8)_
