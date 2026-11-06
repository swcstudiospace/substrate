---
phase: 69-doc-proofs
verified: 2026-11-06
status: human_needed
score: 5/7 truths verified (2 present but behavior-unverified)
covered_files: [".planning/phases/69-doc-proofs/69-SUMMARY.md", "docs/corpus-proofs.md", "docs/event-vocabulary.md", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/proof.test.ts", "packages/cli/src/corpus/proof.ts", "packages/cli/src/corpus/render.ts", "packages/corpus/src/index.ts", "packages/corpus/src/leaf.test.ts", "packages/corpus/src/leaf.ts", "packages/corpus/src/protocol.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/corpus/anchor.test.ts", "packages/mcp-server/src/corpus/anchor.ts", "packages/mcp-server/src/corpus/proofs.routes.test.ts", "packages/mcp-server/src/corpus/proofs.test.ts", "packages/mcp-server/src/corpus/root.test.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/corpus/store.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/reserved-actions.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:1a294546c9e0b94e49c38ac54047d0524dc849166b71f15468236f38f4a99acf"
behavior_unverified: 2
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/7
  previous_head: 6e5d766e
  gaps_closed:
    - "A root the ledger refused is not retried (69-SUMMARY 'What remains'): closed by e3914640, backoff 5/10/20/40/60 s, tested by proofs.test.ts:309-359"
    - "A buffered root is written twice on a later identical state: closed by e3914640, root.ts:370-372, proofs.test.ts:361"
  gaps_remaining:
    - "Owed root dropped at shutdown while an ingest is writing (root.ts:400, owner-open)"
    - "Anchored hour (operator-gated)"
    - "SIGTERM handler live run (operator-gated; index.ts:257 untested)"
  regressions: []
  change_since_prior: "6e5d766e..a46d42c3. Covered files changed: corpus/root.ts and corpus/proofs.test.ts (e3914640: retry, buffered handling, reportOnce); service.ts (f0f3c04e, 884e0753: silent-failure reporting, sync-lag reading after a buffered or dead-lettered note; `emit` at service.ts:2988 still returns EmitResult; corpusRoots/drainCorpusRoots/withCorpusRoot unchanged in substance); docs-search.ts (885e73ce: citation manifest-commit scan; SearchReply corpus_root/corpus_count at :217-218 unchanged); server.ts (f0f3c04e: null bodies; no corpus route changed). index.ts, corpus/service.ts, corpus/anchor.ts, corpus/store.ts, corpus/validate.ts, corpus/anchor.test.ts, proofs.routes.test.ts and root-ledger code paths are unchanged in the covered diff. Not in the covered list and changed in the range: corpus/ingest.ts (FAILURE_REASONS removed, a46d42c3), corpus/slo.ts (recordSyncLag returns a number, 884e0753), cli/src/corpus/testkit.ts (async stop). None touches the root event, the keeper or the proof path."
behavior_unverified_items:
  - truth: "Anchored-hour and transaction are reported by `substrate corpus verify --online` when a real anchored hour exists (SC3, online half)"
    test: "After the operator enables the anchor job and an hour containing a docs.corpus.root event is anchored: run `substrate corpus prove --repo R --path P --out FILE`, then `substrate corpus verify FILE --online`"
    expected: "Report names the anchored hour and the devnet transaction; the memo of that transaction carries the same root"
    why_human: "anchor.test.ts classifies anchor evidence through fake readers only; no anchored hour exists on this host and the anchor job, its key and its timer are operator-gated (not re-probed in this pass)"
  - truth: "The owed docs.corpus.root event is written during SIGTERM shutdown through drainCorpusRoots, before the event drain, inside SHUTDOWN_RETAIN_MS (PROOF-02 end to end)"
    test: "Run the server with SUBSTRATE_CORPUS=on, ingest one document, send SIGTERM before the 5 s root window elapses, then query the ledger for session corpus-root"
    expected: "Exactly one docs.corpus.root event for the final manifest state is in the ledger after the process exits"
    why_human: "Substrate.drainCorpusRoots is exercised by proofs.test.ts:279, but the index.ts SIGTERM handler that calls it (index.ts:257) has no test; the signal path needs a live process and ledger"
human_verification:
  - test: "Operator first real run from docs/corpus-proofs.md 'How a third party verifies': enable SUBSTRATE_CORPUS=on, ingest, prove, wait for the hour to be anchored, verify --online, read the memo"
    expected: "Anchored hour and transaction reported, memo root equals the proof root; before anchoring every root reads unanchored"
    why_human: "Requires the funded devnet key, the anchor timer and a real anchored hour, none of which were observed here (operator-gated). Covers SC3 online half (truth 4)"
  - test: "Run the server with SUBSTRATE_CORPUS=on, ingest one document, send SIGTERM inside the 5 s root window, then query ledger session corpus-root"
    expected: "Exactly one docs.corpus.root event for the final manifest state after the process exits"
    why_human: "The index.ts SIGTERM handler (index.ts:257) is untested; drainCorpusRoots itself is tested (proofs.test.ts:279). Covers truth 7"
  - test: "Confirm the owed root is not lost when an ingest is still writing at shutdown"
    expected: "Owner accepts that flush() skips the write while writers > 0 (root.ts:400 `if (this.owed && this.writers === 0)`), or requests that flush await the in-flight ingest"
    why_human: "No test covers shutdown during an in-flight ingest; the design choice is recorded only in code comments. Owner-open design point, not a success-criterion wording item"
---

# Phase 69: Doc proofs, a Merkle root over the corpus manifest: Verification Report

**Phase Goal:** A Merkle root over the corpus manifest, recorded so the existing hourly anchor covers it, with proofs and verification. It does not send a transaction and does not change the memo format (69-CONTEXT.md D69-1 to D69-4). Must-haves: ROADMAP Phase 69 success criteria 1 to 4 (owner amendments dated 2026-11-05 for SC2 and SC4), plus PROOF-02's shutdown invariant.
**Verified:** 2026-11-06
**Status:** human_needed
**Re-verification:** Yes, at HEAD a46d42c3 (clean), after the prior record at 6e5d766e (5/7, human_needed). Focus: SC2 after e3914640 and the correction that a buffered or dead-lettered root is not written again.

## Scope and sources

- Must-haves: ROADMAP Phase 69 SC1 to SC4 and PROOF-02's shutdown invariant; the owner's correction for buffered and dead-lettered roots. No PLAN.md exists ("Plans: none written"); 69-SUMMARY.md is not evidence.
- Evidence: gate r36 JUnit `/root/src/worktrees/backups/gate-r36-junit.xml` (12,317 testcases, 0 failures, 0 errors, 2 skipped). The two `<skipped />` children are at JUnit lines 8332 and 10702, outside every phase 69 testcase cited below. A title counts only if it appears as a self-closing testcase (no `<failure>`, `<error>` or `<skipped>` child). Each title below was grepped and checked.
- Tests were NOT run in this pass (assignment). Tool used: `gsd_run query verification.fingerprint .planning/phases/69-doc-proofs <28 files>` (read-only).
- Covered list unchanged from the prior record (28 files). Digest recomputed: `v3:sha256:58a7fcaa…074c` (prior `v3:sha256:39dfb340…`).
- SUMMARY staleness: 69-SUMMARY.md "Deviations" and "What remains" say a refused or failed root "is not retried until the next change". That is no longer true after e3914640. The SUMMARY is not evidence and is not edited here.
- Postgres: no Postgres-gated files in the covered list; no Postgres counts claimed.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: `corpusRoot` is the RFC 6962 root over sorted `(repo, path, sha256)` leaves built with `@substrate/ledger`, identical for equal manifests, different for any change | ✓ VERIFIED | `packages/mcp-server/src/corpus/root.ts:13` imports `corpusLeafHex` from `@substrate/corpus`; `root.ts:14` imports `merkleRootHex` and `merkleProofHex` from `@substrate/ledger`; `corpusRoot` at root.ts:92 folds `merkleRootHex` (root.ts:85). Tests (JUnit, pass): root.test.ts "is the ledger's RFC 6962 root over the leaves sorted by (repo, path), whatever order the rows arrive in"; "a changed hash, path or repository changes the root"; leaf.test.ts "is pinned to known vectors…". |
| 2 | SC2 (amended 2026-11-05): one `docs.corpus.root` note per changing ingest, coalesced in a 5 s window, carrying root, count and manifest version. After the correction: a buffered or dead-lettered root is not written again | ✓ VERIFIED | Trigger: `corpus/service.ts:242` `deps.roots.writeStarted()`; `:250` `changed = counts.ingested + counts.updated + counts.tombstoned + counts.failed > 0`; `:253` `writeSettled(changed)` (in `finally`) → `manifestChanged()` (root.ts:289-293) → `scheduleEmit()` (root.ts:299-303). Window: `ROOT_EMIT_MIN_INTERVAL_MS` = 5,000 (root.ts:25), measured from the last write attempt (root.ts:301, 358). Payload `{action, root, count, manifest_version}`, kind `note`, session `corpus-root` (root.ts:361-366). Retry: `ROOT_RETRY_MAX_MS` = 60,000 (root.ts:28); `rootRetryMs` = min(5 s·2^(n-1), 60 s) (root.ts:31-33); armed on refusal at root.ts:382. Answer handling (root.ts:368-374): stored → `lastEmittedRoot = root`, `failures = 0`, return (owed stays cleared); buffered → `lastEmittedRoot = root`, `failures = 0`, return (not owed, no timer); dead-lettered → `failures = 0`, return (not owed, no timer, `lastEmittedRoot` unchanged). Refused or thrown → `owed = true`, backoff (root.ts:379-382). The server side of buffered/dead-lettered is `service.ts:3016` (taken-responsibility check), `:3171` and `:3255` (`deadLettered: true` from the dead-letter store), `service.ts:655-657` (`EmitResult.buffered` / `deadLettered` contract). Tests (JUnit, pass, all in `describe("a root the ledger refused is retried with backoff (v1.7 phase 69, PROOF-02)")`, proofs.test.ts:308): "a root write that fails once is retried five seconds later, and lands exactly once" (:309; attempts at 0, 5 s); "a root write that keeps failing does not spin: in 120 s it is tried once and retried four times, and none lands" (:319; attempts 0, 5, 15, 35, 75 s); "after a stored write that followed refusals, a change waits the five-second window, and a refusal after it backs off from five seconds again" (:329); "each distinct failure code is reported to stderr once, with the repository count and the code, and never the thrown message" (:345); "a root the server buffered is not written again, so the ledger holds one root" (:361). Coalescing and the single-write rules: root.test.ts "changes inside the window are coalesced into one event that carries the latest state" (:186), "the next event waits out the rest of the five-second window, and one change never writes two" (:201), "a root write that outlives the window is never repeated for its version, and a newer version is written after it" (:310). Dead-lettered branch: code-read only (root.ts:370-373); no test drives a `deadLettered` answer (grep of proofs.test.ts and root.test.ts: none). |
| 3 | SC3 (offline half): `substrate corpus prove` returns an inclusion proof; `substrate corpus verify` accepts a valid proof offline and rejects a tampered repo, path, leaf or sibling | ✓ VERIFIED | `packages/cli/src/corpus/proof.ts` (`verifyProofOffline`, `conflictWith`), `render.ts`; reuses `verifyMerkleProofHex` from `@substrate/ledger`. Tests (JUnit, pass): root.test.ts "every leaf of trees of 1, 2, 3, 5, 8 and 9 documents proves against the root, at its first, middle and last index"; "a tampered sibling, leaf or index fails". The CLI `proof.test.ts` is not cited by title here. |
| 4 | SC3 (online half): `verify` reports the anchored hour and transaction when chain evidence exists, `unanchored` when it does not | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Present: `packages/mcp-server/src/corpus/anchor.ts` (`corpusAnchorStatus`, no transaction sent). `anchor.test.ts` uses fake readers only. No real anchored hour observed; the anchor job, its key and its timer are operator-gated (D69-4). Not re-probed in this pass. Routed to human verification. |
| 5 | SC4 (amended 2026-11-05): `docs_search` replies carry `corpus_root` (short form), read from the cache, so an uncached reply carries none | ✓ VERIFIED | `docs-search.ts:217-218` `corpus_root` / `corpus_count`. `service.ts:6468` calls `withCorpusRoot`; definition `service.ts:6974-6983` calls `roots.peek()` (accessor `corpusRoots()` at service.ts:6959-6961); on null it only starts `roots.warm()`. Test (JUnit, pass): proofs.test.ts "with the corpus off the reply has neither field, and with it on the reply is the same reply plus exactly those two" (:237); "a request that moved the manifest drops the cached root, so a reply never names a stale one" (:261). |
| 6 | PROOF-02 keeper invariant: an owed root is written at shutdown by `flush()` exactly once, through `Substrate.drainCorpusRoots`; a second drain writes nothing more | ✓ VERIFIED | `root.ts:396-401` `flush()`: awaits an in-flight emission, advances `timerToken`, clears `timerPending`, then `emitRoot()` if `owed && writers === 0` (root.ts:400). `service.ts:6965-6968` `drainCorpusRoots` races `flush()` against `Bun.sleep(timeoutMs)`; no-op when no keeper was made. Test (JUnit, pass): proofs.test.ts:279 "drainCorpusRoots writes an owed root once and leaves the armed timer disarmed; a second drain writes nothing more". Also root.test.ts "flush writes the owed root now, without the timer, exactly once: the root and the count go out a single time" (:172). |
| 7 | PROOF-02 end-to-end wiring: SIGTERM shutdown awaits `drainCorpusRoots` after the retain drain and before the event drain, bounded by `SHUTDOWN_RETAIN_MS` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Present: `packages/mcp-server/src/index.ts:257` `await substrate.drainCorpusRoots(SHUTDOWN_RETAIN_MS)`, between `drainPendingRetains` (:255) and `drainPendingEvents` (:260); `SHUTDOWN_RETAIN_MS = 10_000` (index.ts:221). `index.ts` unchanged since 6e5d766e (empty diff in the range). No test runs the handler; live signal path not run. Routed to human verification. |

**Score:** 5/7 truths verified (2 present but behavior-unverified: truths 4 and 7). Truths 2 and 5 remain VERIFIED. Truth 2 now covers the correction: the buffered branch is test-verified (proofs.test.ts:361); the dead-lettered branch is code-verified only.

### Correction check: buffered and dead-lettered roots

- Buffered: not owed (root.ts:370 clears nothing further, `owed` was cleared at root.ts:343), no timer armed (`writeRoot` returns before `arm`), counted as emitted (`lastEmittedRoot = root`, root.ts:371). Test-verified: proofs.test.ts:361 ("attempts [0]", "clock.timers toEqual []", one root event after the buffer lands).
- Dead-lettered: not owed, no retry timer (root.ts:370-373); `lastEmittedRoot` not set, so a later changing ingest that yields the same root writes it again. That is the intended reading of "one note per changing ingest" when the ledger holds no copy; it is a difference in handling from buffered, stated here, not a defect. No test.
- Edge (info): a buffered root sets `lastEmittedRoot`, so if the buffer later gives up on it (dead-letter record) and the manifest returns to that same root before any other root is stored, the identical root is skipped (root.ts:344). The ledger then holds no copy, but the server holds a dead-letter record. Consistent with the owner's rule that a buffered root counts as emitted; no test.

### Deferred Items

None. No later milestone phase in ROADMAP addresses corpus root emission, proofs or docs_search corpus fields.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/corpus/root.ts` | root, proof, keeper, retry, drain | ✓ VERIFIED | 402 lines. Changed by e3914640 (retry, `writeRoot`, `reportOnce`, `refusalCode`/`thrownCode` at root.ts:35-46). |
| `packages/mcp-server/src/corpus/proofs.test.ts` | keeper, retry, drain and door tests | ✓ VERIFIED | 15 testcases in the file (JUnit suite `tests="15" failures="0"`); retry describe at :308-377 added by e3914640. |
| `packages/mcp-server/src/corpus/root.test.ts` | keeper and tree tests | ✓ VERIFIED | 28 testcases in the file (JUnit `tests="28" failures="0"`). |
| `packages/mcp-server/src/corpus/service.ts` | ingest bracket | ✓ VERIFIED | `writeStarted` :242, `writeSettled` :253 in `finally`. Unchanged in covered diff. |
| `packages/mcp-server/src/service.ts` | `corpusRoots`, `drainCorpusRoots`, `withCorpusRoot`, `emit` | ✓ VERIFIED | `corpusRoots` 6959-6961; `drainCorpusRoots` 6965-6968; `withCorpusRoot` 6974-6983; `emit` 2988 (`EmitResult` contract 626-657). Changed in f0f3c04e / 884e0753 off the root path. |
| `packages/mcp-server/src/index.ts` | SIGTERM calls the drain | ⚠️ PRESENT (truth 7) | `drainCorpusRoots` at :257; no test runs the handler. |
| `packages/mcp-server/src/docs-search.ts` | `corpus_root` / `corpus_count` | ✓ VERIFIED | :217-218. |
| `packages/mcp-server/src/corpus/anchor.ts` | anchored-hour classification | ⚠️ PRESENT (truth 4) | Fake-reader tests only. |
| `packages/cli/src/corpus/proof.ts`, `render.ts`, `index.ts`, `client.ts` | prove, verify, offline verification | ✓ VERIFIED | Offline path tested; online path depends on truth 4. |
| `docs/corpus-proofs.md`, `docs/event-vocabulary.md` | docs and table row | ✓ VERIFIED | Present, unchanged in the covered diff. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| changed ingest | root event | `writeSettled(changed)` → `manifestChanged` → `scheduleEmit` → `emitRoot` → `emitOnce` → `writeRoot` | ✓ WIRED | corpus/service.ts:242-253; root.ts:289-383 |
| refused / thrown root write | backoff retry | `writeRoot` → `arm(rootRetryMs(failures))` | ✓ WIRED | root.ts:379-382, 306-316; tested proofs.test.ts:309-359 |
| buffered / dead-lettered answer | no further write | `writeRoot` returns before `arm` | ✓ WIRED | root.ts:370-374; buffered tested proofs.test.ts:361; dead-lettered code-only |
| `writeRoot` emit | ledger | `deps.emit` = `Substrate.emit` | ✓ WIRED | service.ts:6960; `EmitResult` service.ts:626-657 |
| `index.ts` SIGTERM | `flush` | `drainCorpusRoots` → `Promise.race([flush(), Bun.sleep])` | ✓ WIRED (not behavior-tested for the signal) | index.ts:257; service.ts:6965-6968; flush exercised by proofs.test.ts:279 |
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
| Retry, buffered, coalesce, flush and drain tests | grep of gate r36 JUnit for each title (below); no test run | each title present as a self-closing testcase | ✓ PASS (evidence, not re-run) |
| Live SIGTERM shutdown drain writes the owed root | not run: requires a live process and ledger | — | ? SKIP (routed to human, truth 7) |
| Anchored hour reported on real chain | not run: no anchored hour | — | ? SKIP (routed to human, truth 4) |

JUnit titles relied on (each a self-closing testcase in gate-r36-junit.xml, no child element):
- proofs.test.ts:309 "a root write that fails once is retried five seconds later, and lands exactly once" (line 17809)
- proofs.test.ts:319 "a root write that keeps failing does not spin: in 120 s it is tried once and retried four times, and none lands" (17810)
- proofs.test.ts:329 "after a stored write that followed refusals, a change waits the five-second window, and a refusal after it backs off from five seconds again" (17811)
- proofs.test.ts:345 "each distinct failure code is reported to stderr once, with the repository count and the code, and never the thrown message" (17812)
- proofs.test.ts:361 "a root the server buffered is not written again, so the ledger holds one root" (17813)
- proofs.test.ts:279 "drainCorpusRoots writes an owed root once and leaves the armed timer disarmed; a second drain writes nothing more" (17806)
- root.test.ts:186 "changes inside the window are coalesced into one event that carries the latest state" (17262)
- root.test.ts:201 "the next event waits out the rest of the five-second window, and one change never writes two" (17263)
- root.test.ts:172 "flush writes the owed root now, without the timer, exactly once: the root and the count go out a single time" (17261)
- root.test.ts:232 "a write the ledger refused is not remembered as written: the same state goes out again on the next event" (17265)

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
| `packages/mcp-server/src/corpus/root.ts` | 370-373 | dead-lettered branch has no test | ℹ️ Info | Code-verified only |
| `packages/mcp-server/src/corpus/root.ts` | 344 | identical root after a buffered-then-given-up write is skipped (see Edge) | ℹ️ Info | Consistent with owner rule; no test |
| `.planning/phases/69-doc-proofs/69-SUMMARY.md` | "Deviations", "What remains" | states a failed root is not retried | ℹ️ Info | Stale after e3914640; not evidence |

### Human Verification Required

1. **Real anchored hour (operator).** Follow docs/corpus-proofs.md "How a third party verifies" after enabling the anchor job. Expected: `verify --online` reports the anchored hour and transaction; memo root equals the proof root. Why human: funded devnet key and timer are operator-gated (truth 4).
2. **Live SIGTERM drain.** Run with `SUBSTRATE_CORPUS=on`, ingest, SIGTERM inside the 5 s window, query ledger session `corpus-root`. Expected: one `docs.corpus.root` event for the final manifest state. Why human: needs a live process and ledger; index.ts:257 is untested (truth 7).
3. **Shutdown during an in-flight ingest.** Confirm that an owed root is dropped when an ingest is still writing at shutdown (`writers > 0`, root.ts:400). Expected: owner accepts, or requests flush to await the ingest. Why human: no test; owner-open design point.

### Open items

- Owner-open: an owed root is dropped when an ingest is still writing at shutdown (root.ts:400, `flush()`; emitOnce skips at root.ts:340 and :342). Unchanged in substance; line moved from :317 to :400. Not an SC wording item.
- Operator-gated anchored hour (truth 4; SC3 online half). Unchanged; not re-probed.
- SIGTERM handler unexercised (truth 7; index.ts:257). Unchanged.
- Closed since prior record: a refused root is retried with backoff (e3914640); a buffered root is not written again (e3914640, proofs.test.ts:361). The 69-SUMMARY "What remains" text is stale on this point.
- Remaining gap (not an SC): a root event lost at shutdown is not retried; after a restart the current root may be stored once more (69-SUMMARY "What remains", second half).

### Gaps Summary

No truth FAILED and no artifact is missing, stub or unwired. Status is `human_needed` rather than `passed` because two behavior-dependent truths have no exercising test here: the real anchored hour (truth 4, operator-gated) and the SIGTERM handler that calls `drainCorpusRoots` (truth 7). The retry and buffered behaviour that e3914640 added are covered by named JUnit testcases; the dead-lettered branch is covered by code reading only.

---

_Verified: 2026-11-06_
_Verifier: Claude (gsd-verifier, V69 draft)_
