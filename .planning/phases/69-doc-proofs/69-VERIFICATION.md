---
phase: 69-doc-proofs
verified: 2026-11-04T23:00:16Z
status: human_needed
score: 3/7 truths verified (2 present but behavior-unverified, 2 warnings)
covered_files: [".planning/phases/69-doc-proofs/69-SUMMARY.md", "docs/corpus-proofs.md", "docs/event-vocabulary.md", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/proof.test.ts", "packages/cli/src/corpus/proof.ts", "packages/cli/src/corpus/render.ts", "packages/corpus/src/index.ts", "packages/corpus/src/leaf.test.ts", "packages/corpus/src/leaf.ts", "packages/corpus/src/protocol.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/corpus/anchor.test.ts", "packages/mcp-server/src/corpus/anchor.ts", "packages/mcp-server/src/corpus/proofs.test.ts", "packages/mcp-server/src/corpus/root.test.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/corpus/store.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/reserved-actions.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:1ec294a5c71acb2b150e04a9501e7e94b4ef6d80789c6f2a9fcab2296a96c91c"
behavior_unverified: 2
overrides_applied: 0
behavior_unverified_items:
  - truth: "Anchored-hour and transaction are reported by `substrate corpus verify --online` when a real anchored hour exists (SC3, online half)"
    test: "After the operator enables the anchor job and an hour containing a docs.corpus.root event is anchored: run `substrate corpus prove --repo R --path P --out FILE`, then `substrate corpus verify FILE --online`"
    expected: "Report names the anchored hour and the devnet transaction; the memo of that transaction carries the same root"
    why_human: "anchor.test.ts classifies anchor evidence through fake readers only; no anchored hour exists on this host and the anchor job, its key and its timer are operator-gated"
  - truth: "The owed docs.corpus.root event is written during SIGTERM shutdown through drainCorpusRoots, before the event drain, inside SHUTDOWN_RETAIN_MS (PROOF-02 end to end)"
    test: "Run the server with SUBSTRATE_CORPUS=on, ingest one document, send SIGTERM before the 5 s root window elapses, then query the ledger for session corpus-root"
    expected: "Exactly one docs.corpus.root event for the final manifest state is in the ledger after the process exits"
    why_human: "Substrate.drainCorpusRoots is exercised by proofs.test.ts (3139c948), but the index.ts SIGTERM handler that calls it (index.ts:257) has no test; the signal path needs a live process and ledger"
human_verification:
  - test: "Decide whether SC2 / PROOF-02 'Each sync emits one docs.corpus.root note' is met by the shipped behavior: one event per manifest-changing ingest, coalesced inside a 5 s window, skipped when the root equals the last stored one, never for the empty manifest or over 100,000 rows, and not retried after a failed write"
    expected: "Owner records either acceptance of this wording (as an override or a ROADMAP edit) or a request for a per-sync event"
    why_human: "The literal wording says each sync; the implementation and 69-SUMMARY.md deviations say each changing ingest, coalesced. This is a scope decision, not a code check"
  - test: "Decide whether SC4 / PROOF-04 'docs_search replies carry corpus_root' is met when the field appears only with SUBSTRATE_CORPUS=on and a cached root, and is absent on the first search after a restart or manifest change"
    expected: "Owner records acceptance of the cached-only behavior or requests a computed root on the request path"
    why_human: "Literal wording says replies carry the root; the shipped behavior omits it on the first reply after a restart or manifest change (69-SUMMARY.md deviation)"
  - test: "Confirm the owed root is not lost when an ingest is still writing at shutdown"
    expected: "Owner accepts that flush() skips the write while writers > 0 (root.ts flush: `if (this.owed && this.writers === 0)`), or requests that flush await the ingest"
    why_human: "No test covers shutdown during an in-flight ingest; the design choice is recorded only in code comments"
  - test: "Operator first real run from docs/corpus-proofs.md 'How a third party verifies': enable SUBSTRATE_CORPUS=on, ingest, prove, wait for the hour to be anchored, verify --online, read the memo"
    expected: "Anchored hour and transaction reported, memo root equals the proof root; before anchoring every root reads unanchored"
    why_human: "Requires the funded devnet key, the anchor timer and a real anchored hour, none of which exist in this environment (operator-gated)"
---

# Phase 69: Doc proofs, a Merkle root over the corpus manifest: Verification Report

**Phase Goal:** Which documents the corpus held, and when, can be proved from the Solana devnet anchor the ledger already writes every hour.
**Verified:** 2026-11-04T23:00:16Z
**Status:** human_needed
**Re-verification:** No (initial mode: the prior 69-VERIFICATION.md had no `gaps:` list)
**Head:** 9e71f263 (worktree /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all)

## Scope and sources

- Must-haves: ROADMAP Phase 69 success criteria 1 to 4 (no PLAN.md exists for this phase; "Plans: none written"), plus PROOF-02's shutdown invariant from commits 44fdd48a and 3139c948.
- Requirements: PROOF-01 to PROOF-04 (REQUIREMENTS.md lines 67 to 70, phase map row line 100).
- SUMMARY.md claims were not treated as evidence; each truth was checked against code and the targeted test runs below.
- Postgres: no Postgres-gated files in this phase; SUBSTRATE_TEST_PG_URL unset for every run; no Postgres counts are claimed.
- Gates not run here (tsc, lint, full suite, formatters) per assignment. No code was edited and nothing was committed.
- Change since the 504da465 report: commit 3139c948 added `shutdown writes the root event still owed` (proofs.test.ts:239), which observes `Substrate.drainCorpusRoots`. The index.ts SIGTERM wiring is unchanged and still unobserved.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: `corpusRoot` is the RFC 6962 root over sorted `(repo, path, sha256)` leaves built with `@substrate/ledger`, identical for equal manifests, different for any change | ✓ VERIFIED | `packages/mcp-server/src/corpus/root.ts` imports `merkleRootHex`/`merkleProofHex` from `@substrate/ledger` (ledger `merkle.ts` is the RFC 6962 tree); `buildCorpusTree` sorts with `compareEntries`, leaf from `corpusLeafHex` in `packages/corpus/src/leaf.ts` (domain-separated, pinned vectors in `leaf.test.ts`). Targeted run: root.test.ts, proofs.test.ts and anchor.test.ts pass together (56 pass, 0 fail). |
| 2 | SC2: each sync emits one `docs.corpus.root` note with root, count, manifest version (event-sources row, no new kind, no memo format) | ⚠️ WARNING (not verified; human decision) | Wired: `CorpusRootKeeper.emitOnce` emits kind `note`, surface `substrate`, session `corpus-root`, payload `{action, root, count, manifest_version}`; row `docs.corpus.root` phase 69 in `packages/mcp-server/src/event-sources.ts` (sample) and `docs/event-vocabulary.md:120`; reserved in `reserved-actions.ts`. Deviation from literal wording: one event per manifest-changing ingest, coalesced in a 5 s window (`ROOT_EMIT_MIN_INTERVAL_MS`), skipped when the root equals the last stored root, never for the empty or over-100,000 manifest, not retried after a refused or failed write (69-SUMMARY.md deviations). |
| 3 | SC3 (offline half): `substrate corpus prove` returns an inclusion proof; `substrate corpus verify` accepts a valid proof offline and rejects a tampered repo, path, leaf or sibling | ✓ VERIFIED | `packages/cli/src/corpus/index.ts`, `proof.ts` (`verifyProofOffline`, `conflictWith`), `render.ts`. Targeted run: `packages/cli/src/corpus/proof.test.ts` with `packages/corpus/src/leaf.test.ts` pass (28 pass, 0 fail). Offline verification reuses `verifyMerkleProofHex` from `@substrate/ledger`. |
| 4 | SC3 (online half): `verify` reports the anchored hour and transaction when chain evidence exists, `unanchored` when it does not | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Present and wired: `packages/mcp-server/src/corpus/anchor.ts` (`corpusAnchorStatus` reads the `corpus-root` session newest first, judges via `verifyEventRef`; no transaction sent). Named tests in `anchor.test.ts` (e.g. "the first anchored one is reported, newest first", "is unanchored, not an error, when the whole root session was read") now pass in the same run as truth 1 (56 pass, 0 fail), but they use fake readers only. No real anchored hour exists on this host (operator-gated). Routed to human verification. |
| 5 | SC4: `docs_search` replies carry `corpus_root` (short form) so the ledger trail says which corpus was read | ⚠️ WARNING (not verified; human decision) | Wired: `docs-search.ts` `SearchReply.corpus_root`/`corpus_count`; `service.ts` `withCorpusRoot` (called from the docs search path, service.ts ~6394) fills them with `shortRoot(snapshot.root)` from the cache only. Targeted run: proofs.test.ts "docs_search names the corpus root it was answered under" passes. Deviation: field only with `SUBSTRATE_CORPUS=on` and a cached root; the first search after a restart or manifest change omits it (69-SUMMARY.md). |
| 6 | PROOF-02 keeper invariant: an owed root is written at shutdown by `flush()` exactly once, through `Substrate.drainCorpusRoots`; a second drain writes nothing more (commits 44fdd48a, 3139c948) | ✓ VERIFIED | `root.ts` `flush()` (~line 310): awaits an in-flight emission, advances `timerToken` and clears `timerPending`, then `emitRoot()` if `owed && writers === 0`; the timer callback returns early on a stale token. `service.ts` `drainCorpusRoots` (~6889) races `flush()` with `Bun.sleep(timeoutMs)`. Named tests: root.test.ts:172 "flush writes the owed root now, without the timer, exactly once" (keeper level); proofs.test.ts:239 "drainCorpusRoots writes an owed root once and leaves the armed timer disarmed; a second drain writes nothing more" (service level, added in 3139c948). The proofs test proves no second write after `clock.fire()` and a second drain; it does not observe the timer disarm directly (per the commit message). The before-state (no flush) was not observed red in this pass. Both files pass in the run for truth 1. |
| 7 | PROOF-02 end-to-end wiring: SIGTERM shutdown awaits `drainCorpusRoots` after the retain drain and before the event drain, bounded by `SHUTDOWN_RETAIN_MS` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Present and wired: `packages/mcp-server/src/index.ts:257` `await substrate.drainCorpusRoots(SHUTDOWN_RETAIN_MS)` between `drainPendingRetains` (:255) and `drainPendingEvents` (:260); `SHUTDOWN_RETAIN_MS = 10_000` (index.ts:221). The method itself is now observed by proofs.test.ts (truth 6). The index.ts SIGTERM handler and its order are not exercised by any test; the signal path is not run. Routed to human verification. |

**Score:** 3/7 truths verified (2 present but behavior-unverified: truths 4 and 7; 2 warnings: truths 2 and 5)

### Deferred Items

None. No later milestone phase in ROADMAP addresses corpus root emission, proofs or docs_search corpus fields (Step 9b matched nothing).

### Advisory (New Scope, Unevidenced)

Not applicable: initial verification, not re-verification.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/corpus/src/leaf.ts` | leaf encoding, `CORPUS_EMPTY_ROOT`, `shortRoot` | ✓ VERIFIED | exists; pinned vectors in `leaf.test.ts` (run passes) |
| `packages/corpus/src/protocol.ts` | wire types for root/proof/anchor responses | ✓ VERIFIED | exists; exported via `packages/corpus/src/index.ts` |
| `packages/mcp-server/src/corpus/root.ts` | tree, proof, `CorpusRootKeeper` with `flush` | ✓ VERIFIED | exists, substantive (root, proof, keeper, timer token, owed flag, flush) |
| `packages/mcp-server/src/corpus/anchor.ts` | anchor classification | ✓ VERIFIED (file) | exists; positive online path behavior ⚠️ see truth 4 |
| `packages/mcp-server/src/corpus/service.ts` | corpus doors, ingest bracket | ✓ VERIFIED | exists; `corpusRootReply`, `corpusProofReply`, `corpusAnchorReply` |
| `packages/mcp-server/src/service.ts` | `corpusRoot`, `drainCorpusRoots`, `withCorpusRoot` | ✓ VERIFIED | exists; `drainCorpusRoots` observed by proofs.test.ts (truth 6); its SIGTERM caller is not (truth 7) |
| `packages/cli/src/corpus/proof.ts`, `render.ts`, `index.ts` | prove, verify, offline verification | ✓ VERIFIED | exists; offline path tested and passing |
| `docs/corpus-proofs.md`, `docs/event-vocabulary.md` | docs and table row | ✓ VERIFIED | exists; row at event-vocabulary.md:120 |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `index.ts` SIGTERM handler | `Substrate.drainCorpusRoots` | `await substrate.drainCorpusRoots(SHUTDOWN_RETAIN_MS)` | ✓ WIRED (not behavior-tested) | index.ts:257; no test runs the handler |
| `drainCorpusRoots` | `CorpusRootKeeper.flush` | `Promise.race([flush(), Bun.sleep(timeoutMs)])` | ✓ WIRED | service.ts ~6889-6891; exercised by proofs.test.ts:239 |
| `flush` | ledger emit | `emitRoot` -> `emitOnce` -> `deps.emit` (`this.emit`) | ✓ WIRED | root.ts ~312; service.ts keeper construction ~6884; `emit` spied in proofs.test.ts |
| `docs_search` reply | `corpus_root` field | `withCorpusRoot` -> `shortRoot(snapshot.root)` | ✓ WIRED | service.ts ~6394, ~6898-6906 |
| `corpusRoot` | `@substrate/ledger` tree | `merkleRootHex` | ✓ WIRED | root.ts import line 14 |
| CLI `prove`/`verify` | server proof route | client | ? NOT TRACED | covered by proof.test.ts run (passing); not traced separately in this pass |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `CorpusRootKeeper.emitOnce` | `read.snapshot.root` | `CorpusStore.activeLeaves` manifest read | Yes (store query, tree built from rows) | ✓ FLOWING |
| `withCorpusRoot` | `corpus_root` | keeper cache (`peek()`) | Yes when cached; absent otherwise (by design, truth 5) | ⚠️ CONDITIONAL |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Root determinism, keeper emit/coalesce, flush invariant, drainCorpusRoots writes the owed root once, docs_search corpus fields, anchor classification | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/corpus/root.test.ts packages/mcp-server/src/corpus/proofs.test.ts packages/mcp-server/src/corpus/anchor.test.ts` | 56 pass, 0 fail, 194 expect() calls | ✓ PASS |
| Offline prove/verify, leaf vectors | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/cli/src/corpus/proof.test.ts packages/corpus/src/leaf.test.ts` | 28 pass, 0 fail, 119 expect() calls | ✓ PASS |
| Live SIGTERM shutdown drain writes the owed root | not run: requires a live process and ledger | — | ? SKIP (routed to human, truth 7) |
| Anchored hour reported on real chain | not run: no anchored hour exists | — | ? SKIP (routed to human, truth 4) |

Postgres-gated tests: none in this phase; SUBSTRATE_TEST_PG_URL unset for every run. No Postgres evidence is claimed.

### Probe Execution

Step 7c: SKIPPED (phase is not a migration or tooling phase and declares no probes).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| PROOF-01 | none (no PLAN.md) | deterministic Merkle root over (repo, path, sha256) | ✓ SATISFIED | truth 1 |
| PROOF-02 | none (no PLAN.md) | each sync records the root as a ledger event, covered by the hourly anchor | ? NEEDS HUMAN | keeper flush and `drainCorpusRoots` VERIFIED (truth 6); literal "each sync" is a human decision (truth 2); SIGTERM wiring unexercised (truth 7) |
| PROOF-03 | none (no PLAN.md) | `prove` gives a proof; `verify` checks offline and against the anchored hour when evidence exists | ✓ SATISFIED (offline) / ? NEEDS HUMAN (online) | truths 3 and 4 |
| PROOF-04 | none (no PLAN.md) | `docs_search` replies carry the short corpus root | ? NEEDS HUMAN | truth 5 (cached-only behavior) |

Orphaned requirements: none. REQUIREMENTS.md maps PROOF-01 to PROOF-04 to phase 69 (line 100); all four are claimed by 69-SUMMARY.md frontmatter.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (all phase-69 added lines, c9fccab8, 44fdd48a and 3139c948, excluding .planning) | - | TBD / FIXME / XXX / TODO / HACK / PLACEHOLDER | none found | No debt-marker blocker |
| `packages/mcp-server/src/corpus/root.ts` | flush | `owed && writers === 0` skips the write while an ingest is in flight | ℹ️ Info | Residual design limit; human item 3 |

### Human Verification Required

1. **SC2 / PROOF-02 wording.** Test: decide whether "each sync emits one docs.corpus.root" is satisfied by coalesced per-changing-ingest events (69-SUMMARY deviations). Expected: owner accepts the wording or requests a per-sync event. Why human: scope decision.
2. **SC4 / PROOF-04 wording.** Test: decide whether the cached-only `corpus_root` (absent on the first reply after a restart or manifest change) satisfies "replies carry". Expected: owner accepts or requests a computed root. Why human: scope decision.
3. **Shutdown during an in-flight ingest.** Test: confirm that an owed root is dropped when an ingest is still writing at shutdown (`writers > 0`). Expected: owner accepts, or requests flush to await the ingest. Why human: no test; design choice.
4. **Live SIGTERM drain.** Test: run with `SUBSTRATE_CORPUS=on`, ingest, SIGTERM inside the 5 s window, query ledger session `corpus-root`. Expected: one `docs.corpus.root` event for the final manifest state. Why human: needs a live process and ledger; the index.ts signal handler is untested (`drainCorpusRoots` itself is tested, proofs.test.ts:239).
5. **Real anchored hour (operator).** Test: follow docs/corpus-proofs.md "How a third party verifies" after enabling the anchor job. Expected: `verify --online` reports the anchored hour and transaction; memo root equals the proof root. Why human: funded devnet key and timer are operator-gated.

### Gaps Summary

No truth FAILED and no artifact is missing, stub or unwired; the phase goal's code path is present, wired and passes its targeted tests (56 + 28 pass, 0 fail). Status is `human_needed` rather than `passed` because two literal success-criterion wordings (SC2, SC4) differ from the shipped behavior, which the owner must accept or reject, and two behavior-dependent truths have no exercising test in this environment: the real anchored hour (truth 4) and the SIGTERM handler that calls `drainCorpusRoots` (truth 7). The shutdown drain itself is now observed by proofs.test.ts (3139c948), so truth 6 is VERIFIED.

---

_Verified: 2026-11-04T23:00:16Z_
_Verifier: Claude (gsd-verifier)_
