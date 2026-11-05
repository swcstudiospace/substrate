---
phase: 69-doc-proofs
verified: 2026-11-05T07:59:53Z
status: human_needed
score: 5/7 truths verified (2 present but behavior-unverified)
covered_files: [".planning/phases/69-doc-proofs/69-SUMMARY.md", "docs/corpus-proofs.md", "docs/event-vocabulary.md", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/proof.test.ts", "packages/cli/src/corpus/proof.ts", "packages/cli/src/corpus/render.ts", "packages/corpus/src/index.ts", "packages/corpus/src/leaf.test.ts", "packages/corpus/src/leaf.ts", "packages/corpus/src/protocol.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/corpus/anchor.test.ts", "packages/mcp-server/src/corpus/anchor.ts", "packages/mcp-server/src/corpus/proofs.routes.test.ts", "packages/mcp-server/src/corpus/proofs.test.ts", "packages/mcp-server/src/corpus/root.test.ts", "packages/mcp-server/src/corpus/root.ts", "packages/mcp-server/src/corpus/service.ts", "packages/mcp-server/src/corpus/store.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/reserved-actions.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:87999d7eba280c27dc7fa8ed07f4196b050bc5d65c59afc2a6b682e02abde1da"
behavior_unverified: 2
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/7
  previous_head: 42e3cf13
  gaps_closed: []
  gaps_remaining: []
  regressions: []
  change_since_prior: "42e3cf13..6e5d766e (5 commits: 49b9aece, b4bdd0fc, d1a5e89b, b4fe6bfe, 6e5d766e). Of the covered list only packages/mcp-server/src/service.ts changed, in b4bdd0fc (+2/-1, the docs.sync sync-lag reading in emit). It does not touch the corpus root, keeper, drain, withCorpusRoot or the docs_search corpus fields, and does not change any root event (see Scope). 6e5d766e re-dated the SC2/SC4 owner amendments in ROADMAP.md and REQUIREMENTS.md to 2026-11-05 (wording unchanged). No truth changed status; no regression."
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

**Phase Goal:** A Merkle root over the corpus manifest, recorded so the existing hourly anchor covers it, with proofs and verification. It does not send a transaction and does not change the memo format (69-CONTEXT.md D69-1 to D69-4). Must-haves: ROADMAP Phase 69 success criteria 1 to 4 (owner amendments dated 2026-11-05 for SC2 and SC4), plus PROOF-02's shutdown invariant (commits 44fdd48a, 3139c948).
**Verified:** 2026-11-05T07:59:53Z
**Status:** human_needed
**Re-verification:** Yes — at HEAD 6e5d766e, after the prior record at 42e3cf13 (5/7, human_needed)

## Scope and sources

- Must-haves: ROADMAP Phase 69 success criteria 1 to 4 and PROOF-02's shutdown invariant. No PLAN.md exists for this phase ("Plans: none written"); the SUMMARY (69-SUMMARY.md) is not evidence.
- Requirements: PROOF-01 to PROOF-04 (REQUIREMENTS.md, Doc Proofs section).
- Change since the prior record (42e3cf13): `git diff 42e3cf13..HEAD -- <covered list>` reports one file, `packages/mcp-server/src/service.ts` (+2 / -1), from b4bdd0fc: the sync-lag reading in `emit` now also follows a note the ledger buffered or dead-lettered. Checked for phase 69: `Substrate.emit` still returns the same `EmitResult`, and the keeper still decides on `written.stored` (`corpus/root.ts:303`), which is unchanged. The sync-lag path is `corpusSlo.recordSyncLag` → `syncLagSeconds` (`corpus/sync-event.ts:17-20`), which returns null unless `payload.action === "docs.sync"`; the root event's action is `docs.corpus.root`, so no root event changes the reading. Inherited from the prior record: the H-1 hunks (9e6fa1f2, before 42e3cf13) are on the brief path and the forget path only, not the corpus code.
- Other commits since 42e3cf13 are outside the covered list and were not re-audited for phase 69: 49b9aece (`event-buffer.ts`), d1a5e89b (`cache.ts`), b4fe6bfe (`dispatcher/worktree.py`), 6e5d766e (`docs/corpus.md` tombstone-scope sentence, `docs/reconcile.md`, and the phase 63/65/69/70/75 record and planning files). 6e5d766e changed `.planning/ROADMAP.md` and `.planning/REQUIREMENTS.md` only in the amendment dates and the ATLAS-03 / Phase 63 wording; the phase 69 SC2 and SC4 and PROOF-02 and PROOF-04 wording is unchanged in substance (dated 2026-11-05 instead of 2026-11-04, the "(d)" tag dropped). Planning-root docs are inert for the fingerprint (#4623).
- Covered list: the 28 files of the prior record, unchanged. The fingerprint covered_digest changed from `v3:sha256:f3c11ceb…` (42e3cf13 record) to `v3:sha256:87999d7e…` because of the b4bdd0fc `service.ts` change; no covered content other than that changed.
- Line numbers at 6e5d766e: `service.ts` shifted by the H-1 hunks (listed below); `root.ts`, `index.ts`, `proofs.test.ts`, `root.test.ts`, `docs-search.ts` (fields at 215-216), `corpus/service.ts` and `anchor.ts` have not changed since the prior record.
- Postgres: no Postgres-gated files in this phase (`grep -l "SUBSTRATE_TEST_PG_URL\|postgres://"` over the 28 covered files: no matches). `SUBSTRATE_TEST_PG_URL` was unset for the run. No Postgres counts are claimed.
- Gate evidence cross-check: `/root/src/worktrees/backups/gate-r33-junit.xml` (12290 testcases) contains the phase 69 named tests cited below, each without a `<skipped/>` child.
- Gates not run here (tsc, lint, full suite, formatters) per assignment. No code was edited and nothing was committed.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: `corpusRoot` is the RFC 6962 root over sorted `(repo, path, sha256)` leaves built with `@substrate/ledger`, identical for equal manifests, different for any change | ✓ VERIFIED | `packages/mcp-server/src/corpus/root.ts:14` imports `merkleProofHex`/`merkleRootHex` from `@substrate/ledger`; `buildCorpusTree` sorts with `compareEntries` (root.ts:59); `corpusRoot` at root.ts:68 folds `corpusLeafHex` leaves (`packages/corpus/src/leaf.ts`, pinned vectors in `leaf.test.ts`). Named tests passing at 6e5d766e: root.test.ts "is the ledger's RFC 6962 root over the leaves sorted by (repo, path), whatever order the rows arrive in" and "a changed hash, path or repository changes the root"; leaf.test.ts "is pinned to known vectors…" (JUnit gate-r33: pass). |
| 2 | SC2 (amended 2026-11-05): one `docs.corpus.root` note per changing ingest, coalesced in a 5 s window, carrying root, count and manifest version (event-sources row; no new kind; no new memo format) | ✓ VERIFIED | Trigger: `corpus/service.ts:242` `writeStarted()` before the ingest; `:250` `changed = counts.ingested + counts.updated + counts.tombstoned + counts.failed > 0`; `:253` `writeSettled(changed)`, which calls `manifestChanged()` (root.ts:246-250) that sets `owed` and arms one timer through `scheduleEmit()` (root.ts:253-264). The wait is `ROOT_EMIT_MIN_INTERVAL_MS` (5,000, root.ts:25) counted from the last write attempt (root.ts:255). `emitOnce` (root.ts:285-307) emits kind `note`, surface `substrate`, session `corpus-root`, payload `{action: docs.corpus.root, root, count, manifest_version}` (root.ts:295-301); it skips when the manifest is writing, when count is 0, or when the root equals `lastEmittedRoot` (root.ts:292); `MAX_CORPUS_LEAVES` = 100,000 (root.ts:31, :207). Row: `packages/mcp-server/src/event-sources.ts:1447-1459`; `docs/event-vocabulary.md:120`. Named tests passing at 6e5d766e: root.test.ts "a change schedules one root event, written after the timer…" (:157), "changes inside the window are coalesced into one event that carries the latest state" (:186), "the next event waits out the rest of the five-second window, and one change never writes two" (:201), "the empty manifest is never emitted" (:224). Re-audit at 6e5d766e: none of these lines changed; the only covered change (b4bdd0fc) does not affect the event (see Scope). |
| 3 | SC3 (offline half): `substrate corpus prove` returns an inclusion proof; `substrate corpus verify` accepts a valid proof offline and rejects a tampered repo, path, leaf or sibling | ✓ VERIFIED | `packages/cli/src/corpus/index.ts`, `proof.ts` (`verifyProofOffline`, `conflictWith`), `render.ts`; offline verification reuses `verifyMerkleProofHex` from `@substrate/ledger`. Named tests passing at 6e5d766e: root.test.ts "every leaf of trees of 1, 2, 3, 5, 8 and 9 documents proves against the root, at its first, middle and last index" (JUnit: pass) and "a tampered sibling, leaf or index fails"; `packages/cli/src/corpus/proof.test.ts` and `leaf.test.ts` in the same 92-test run. |
| 4 | SC3 (online half): `verify` reports the anchored hour and transaction when chain evidence exists, `unanchored` when it does not | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Present and wired: `packages/mcp-server/src/corpus/anchor.ts` (`corpusAnchorStatus` reads the `corpus-root` session newest first, judges via `verifyEventRef`; no transaction is sent). `anchor.test.ts` passes in the 92-test run but uses fake readers only. No real anchored hour exists on this host; the anchor job, its key and its timer are operator-gated (D69-4; carried forward from the prior record, not re-probed in this pass). Routed to human verification. |
| 5 | SC4 (amended 2026-11-05): `docs_search` replies carry `corpus_root` (short form) and the value is read from the cache, so an uncached reply carries none | ✓ VERIFIED | `docs-search.ts:215-216` `SearchReply.corpus_root` / `corpus_count`. `service.ts:6441` calls `withCorpusRoot` on the `docs_search` reply path; its definition (`service.ts:6945-6954`) calls `roots.peek()` (accessor `corpusRoots()` at 6930-6933); on null it only calls `roots.warm()` and returns the reply unchanged, otherwise it adds `shortRoot(snapshot.root)` and `snapshot.count`. Named tests passing at 6e5d766e: proofs.test.ts "with the corpus off the reply has neither field, and with it on the reply is the same reply plus exactly those two" (:197; asserts the fields are absent while nothing is cached) and "a request that moved the manifest drops the cached root, so a reply never names a stale one" (:221; JUnit gate-r33: pass). |
| 6 | PROOF-02 keeper invariant: an owed root is written at shutdown by `flush()` exactly once, through `Substrate.drainCorpusRoots`; a second drain writes nothing more (commits 44fdd48a, 3139c948) | ✓ VERIFIED | `root.ts` `flush()` (root.ts:313-318): awaits an in-flight emission, advances `timerToken`, clears `timerPending`, then `emitRoot()` if `owed && writers === 0` (root.ts:317); a stale timer token returns early (root.ts:260). `service.ts` `drainCorpusRoots` (6936-6939) races `this.corpusRootKeeper.flush()` against `Bun.sleep(timeoutMs)` (6938) and does nothing when no keeper was made. Named test, commit 3139c948: proofs.test.ts:239 "drainCorpusRoots writes an owed root once and leaves the armed timer disarmed; a second drain writes nothing more" (describe "shutdown writes the root event still owed (v1.7 phase 69)"): JUnit gate-r33 pass, no `<skipped/>`; it also passes in the 92-test run at 6e5d766e. Keeper level: root.test.ts:172 "flush writes the owed root now, without the timer, exactly once" (pass). Both commits (44fdd48a, 3139c948) are ancestors of 42e3cf13 and HEAD. |
| 7 | PROOF-02 end-to-end wiring: SIGTERM shutdown awaits `drainCorpusRoots` after the retain drain and before the event drain, bounded by `SHUTDOWN_RETAIN_MS` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Present and wired: `packages/mcp-server/src/index.ts:257` `await substrate.drainCorpusRoots(SHUTDOWN_RETAIN_MS)` sits between `drainPendingRetains` (:255) and `drainPendingEvents` (:260); `SHUTDOWN_RETAIN_MS = 10_000` (index.ts:221). `index.ts` has not changed since 44fdd48a. The method is observed by proofs.test.ts (truth 6). The SIGTERM handler and its order are not exercised by any test; the live signal path was not run (per assignment it stays unobserved). Routed to human verification. |

**Score:** 5/7 truths verified (2 present but behavior-unverified: truths 4 and 7). Truths 2 and 5 remain VERIFIED against the amended ROADMAP text.

### Deferred Items

None. No later milestone phase in ROADMAP addresses corpus root emission, proofs or docs_search corpus fields (Step 9b matched nothing).

### Advisory (New Scope, Unevidenced)

None. The b4bdd0fc sync-lag change and the 6e5d766e docs are scope-checked above and raise no new-scope concern for phase 69.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/corpus/root.ts` | root, proof, keeper, drain | ✓ VERIFIED | 319 lines; exists, substantive, wired (service.ts:6930-6939; corpus/service.ts:242-253). Unchanged since the prior record. |
| `packages/corpus/src/leaf.ts`, `protocol.ts`, `index.ts` | leaf encoding and wire types | ✓ VERIFIED | Pinned vectors (leaf.test.ts) pass. |
| `packages/mcp-server/src/service.ts` | `corpusRoots`, `drainCorpusRoots`, `withCorpusRoot` | ✓ VERIFIED | Exists and wired. `corpusRoots` 6930-6933, `drainCorpusRoots` 6936-6939 (observed by proofs.test.ts; truth 6), `withCorpusRoot` 6945-6954 (called at 6441). The 42e3cf13→6e5d766e change (b4bdd0fc, emit at 3002-3006) does not touch them. Prior H-1 hunks (rememberLastGood 2499, inProcessLastGood 2517, briefForgottenAtMs 1648, degraded read 2724, forget mark 4546) are off the corpus path. |
| `packages/mcp-server/src/index.ts` | SIGTERM calls the drain | ⚠️ PRESENT (truth 7) | `drainCorpusRoots` at :257; handler not run by any test. |
| `packages/mcp-server/src/docs-search.ts` | `corpus_root` / `corpus_count` on `SearchReply` | ✓ VERIFIED | :215-216. |
| `packages/mcp-server/src/corpus/store.ts`, `validate.ts`, `admission.ts`, `server.ts`, `reserved-actions.ts`, `event-sources.ts` | manifest read, validation, route classes, `GET /corpus/*`, event row | ✓ VERIFIED (carried forward) | Unchanged since the prior record; exercised through the targeted run (proofs.routes.test.ts: 8 tests). |
| `packages/mcp-server/src/corpus/anchor.ts` | anchored-hour classification | ⚠️ PRESENT (truth 4) | Fake-reader tests only; no real anchored hour. |
| `packages/cli/src/corpus/proof.ts`, `render.ts`, `index.ts`, `client.ts` | prove, verify, offline verification | ✓ VERIFIED | Offline path tested and passing; online path depends on truth 4. |
| `docs/corpus-proofs.md`, `docs/event-vocabulary.md` | docs and table row | ✓ VERIFIED | Exist; row at event-vocabulary.md:120. |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `index.ts` SIGTERM handler | `Substrate.drainCorpusRoots` | `await substrate.drainCorpusRoots(SHUTDOWN_RETAIN_MS)` | ✓ WIRED (not behavior-tested) | index.ts:257; no test runs the handler |
| `drainCorpusRoots` | `CorpusRootKeeper.flush` | `Promise.race([flush(), Bun.sleep(timeoutMs)])` | ✓ WIRED | service.ts:6938; exercised by proofs.test.ts:239 |
| `flush` | ledger emit | `emitRoot` → `emitOnce` → `deps.emit` | ✓ WIRED | root.ts:313-318; keeper built in service.ts (6930-6933), `emit` → `Substrate.emit` (service.ts:2978); spied in proofs.test.ts |
| changed ingest | root event | `writeSettled(changed)` → `manifestChanged` → `scheduleEmit` → `emitOnce` | ✓ WIRED | corpus/service.ts:242-253; root.ts:246-307; coalesced by `ROOT_EMIT_MIN_INTERVAL_MS`; tested in root.test.ts:157-224 |
| `docs_search` reply | `corpus_root` field | `withCorpusRoot` → `roots.peek()` → `shortRoot(snapshot.root)` | ✓ WIRED | service.ts:6441 (call), 6945-6954 (definition) |
| `corpusRoot` | `@substrate/ledger` tree | `merkleRootHex` / `merkleProofHex` | ✓ WIRED | root.ts:14 import |
| CLI `prove`/`verify` | server proof route | client | ✓ WIRED (offline path tested) | proof.test.ts passes; online path depends on truth 4 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `CorpusRootKeeper.emitOnce` | `read.snapshot.root` | `CorpusStore.activeLeaves` manifest read, tree built by `buildCorpusTree` | Yes (store query, tree built from rows) | ✓ FLOWING |
| `withCorpusRoot` | `corpus_root` | keeper cache (`peek()`) | Yes when cached; absent otherwise (by amended SC4) | ✓ FLOWING (cache-gated by design) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Root determinism, keeper coalesce and flush, drainCorpusRoots writes the owed root once, docs_search corpus fields (cached only), proof-route gates and audit, anchor classification, offline prove/verify, leaf vectors | `cd /root/src/worktrees/as-gsd-v18-all && env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/corpus/root.test.ts packages/mcp-server/src/corpus/proofs.test.ts packages/mcp-server/src/corpus/proofs.routes.test.ts packages/mcp-server/src/corpus/anchor.test.ts packages/cli/src/corpus/proof.test.ts packages/corpus/src/leaf.test.ts` | 92 pass, 0 fail, 340 expect() calls, 2.26 s (at 6e5d766e) | ✓ PASS |
| Named gate evidence (no run): drainCorpusRoots test, coalesce test, flush test, docs_search stale-root test, leaf vectors, proof leaves | grep of `/root/src/worktrees/backups/gate-r33-junit.xml` | each named testcase present with no `<skipped/>` child | ✓ PASS |
| Live SIGTERM shutdown drain writes the owed root | not run: requires a live process and ledger | — | ? SKIP (routed to human, truth 7) |
| Anchored hour reported on real chain | not run: no anchored hour exists | — | ? SKIP (routed to human, truth 4) |

Targeted-run budget: one non-Postgres `bun test` command (6 files) at 6e5d766e; the Postgres-gated tests were not started, and none exist in this phase.

### Probe Execution

Step 7c: SKIPPED (phase is not a migration or tooling phase and declares no probes).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| PROOF-01 | none (no PLAN.md) | deterministic Merkle root over (repo, path, sha256) | ✓ SATISFIED | truth 1 |
| PROOF-02 | none (no PLAN.md) | each changing ingest records the root as a ledger event, coalesced in a 5 s window, covered by the hourly anchor (amended 2026-11-05) | ✓ SATISFIED (amended wording); shutdown end-to-end ? NEEDS HUMAN | truths 2 and 6 VERIFIED; truth 7 is the unobserved SIGTERM wiring |
| PROOF-03 | none (no PLAN.md) | `prove` gives a proof; `verify` checks offline and against the anchored hour when evidence exists | ✓ SATISFIED (offline) / ? NEEDS HUMAN (online) | truths 3 and 4 |
| PROOF-04 | none (no PLAN.md) | `docs_search` replies carry the short corpus root, read from the cache (amended 2026-11-05) | ✓ SATISFIED | truth 5 |

Orphaned requirements: none. REQUIREMENTS.md maps PROOF-01 to PROOF-04 to phase 69; 69-SUMMARY.md frontmatter claims all four.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (all covered non-markdown implementation and test files, and the b4bdd0fc / H-1 `service.ts` additions) | - | TBD / FIXME / XXX / TODO / HACK / PLACEHOLDER | none found | No debt-marker blocker (grep over the added lines at 6e5d766e: 0 matches) |
| `packages/mcp-server/src/corpus/root.ts` | 317 | `owed && writers === 0` skips the write while an ingest is in flight | ℹ️ Info | Residual design limit; human item 3 |
| `packages/mcp-server/src/corpus/root.ts` | 292 | a changed ingest whose root equals `lastEmittedRoot` emits nothing | ℹ️ Info | Consistent with "one note per changing ingest" only as far as the root changes; no test change needed |
| `packages/mcp-server/src/corpus/root.ts` | 303 | a root the ledger refused is not retried until the next change | ℹ️ Info | Recorded as a gap in 69-SUMMARY.md "What remains"; not an SC |

### Human Verification Required

1. **Real anchored hour (operator).** Test: follow docs/corpus-proofs.md "How a third party verifies" after enabling the anchor job. Expected: `verify --online` reports the anchored hour and transaction; memo root equals the proof root. Why human: funded devnet key and timer are operator-gated (truth 4).
2. **Live SIGTERM drain.** Test: run with `SUBSTRATE_CORPUS=on`, ingest, SIGTERM inside the 5 s window, query ledger session `corpus-root`. Expected: one `docs.corpus.root` event for the final manifest state. Why human: needs a live process and ledger; the index.ts signal handler is untested (truth 7). Per assignment this path stays unobserved.
3. **Shutdown during an in-flight ingest.** Test: confirm that an owed root is dropped when an ingest is still writing at shutdown (`writers > 0`). Expected: owner accepts, or requests flush to await the ingest. Why human: no test; owner-open design point (root.ts:317). Not a success-criterion wording item.

### Open items

- Operator-gated anchored hour (truth 4; SC3 online half). Unchanged.
- SIGTERM handler unexercised (truth 7; index.ts:257). Unchanged; per assignment it stays unobserved.
- Owner-open design: an owed root is dropped when an ingest is still writing at shutdown (root.ts:317). Unchanged.
- Known gap (not an SC): a root event lost to a failed write is not retried; after a restart the current root may be stored once more (69-SUMMARY.md "What remains").
- SC2 and SC4 wording: dated 2026-11-05 in ROADMAP.md and REQUIREMENTS.md (6e5d766e); substance unchanged from the 2026-11-04 amendments. No owner decision outstanding for them.

### Gaps Summary

No truth FAILED and no artifact is missing, stub or unwired. Status is `human_needed` rather than `passed` because two behavior-dependent truths have no exercising test in this environment: the real anchored hour (truth 4, operator-gated) and the SIGTERM handler that calls `drainCorpusRoots` (truth 7). The amended SC2 and SC4 wordings are met by the shipped behaviour.

---

_Verified: 2026-11-05T07:59:53Z_
_Verifier: Claude (gsd-verifier)_
