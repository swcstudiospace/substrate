---
phase: 65-doc-watch
verified: 2026-11-06T06:12:26Z
status: human_needed
score: 5/5 must-haves verified by code at df31c749 (success criteria 1-5; SC2 and SC3 against the owner-amended text dated 2026-11-05; SC5 unchanged since 5e304ef8; SC1's new test title passes in r43)
covered_files:
  - ".planning/phases/65-doc-watch/65-SUMMARY.md"
  - "docs/corpus-eval.md"
  - "docs/corpus-watch.md"
  - "docs/runbooks/corpus-sync.md"
  - "docs/runbooks/docs-rag-operations.md"
  - "infra/vps/substrate-corpus-reconcile.service"
  - "infra/vps/substrate-corpus-reconcile.service.d/30-sandbox.conf.example"
  - "infra/vps/substrate-corpus-reconcile.timer"
  - "infra/vps/substrate-corpus-sync.service"
  - "infra/vps/substrate-corpus-sync.timer"
  - "infra/vps/substrate-corpus-watch.service"
  - "packages/cli/src/corpus/events.ts"
  - "packages/cli/src/corpus/render-sync.ts"
  - "packages/cli/src/corpus/sync.test.ts"
  - "packages/cli/src/corpus/sync.ts"
  - "packages/cli/src/corpus/watch-commands.test.ts"
  - "packages/cli/src/corpus/watch-commands.ts"
  - "packages/cli/src/corpus/watch-loop.ts"
  - "packages/cli/src/corpus/watch-settings.ts"
  - "packages/collectors/src/install-git-hook.test.ts"
  - "packages/collectors/src/install-git-hook.ts"
  - "packages/corpus/src/coalesce.test.ts"
  - "packages/corpus/src/coalesce.ts"
  - "packages/corpus/src/hints.ts"
  - "packages/corpus/src/mirror.test.ts"
  - "packages/corpus/src/mirror.ts"
  - "packages/corpus/src/view.test.ts"
  - "packages/corpus/src/view.ts"
  - "packages/corpus/src/watch.test.ts"
  - "packages/corpus/src/watch.ts"
  - "packages/mcp-server/src/corpus/ingest.ts"
  - "packages/mcp-server/src/corpus/reconcile.test.ts"
  - "packages/mcp-server/src/corpus/reconcile.ts"
  - "packages/mcp-server/src/corpus/service.ts"
  - "packages/mcp-server/src/corpus/slo.test.ts"
  - "packages/mcp-server/src/corpus/slo.ts"
  - "packages/mcp-server/src/corpus/sync-event.test.ts"
  - "packages/mcp-server/src/corpus/sync-event.ts"
  - "packages/mcp-server/src/docs-freshness.test.ts"
  - "packages/mcp-server/src/docs-freshness.ts"
  - "packages/mcp-server/src/event-buffer.ts"
  - "packages/mcp-server/src/event-sources.ts"
  - "packages/mcp-server/src/flag-registry.ts"
  - "packages/mcp-server/src/mcp.ts"
  - "packages/mcp-server/src/observe.ts"
  - "packages/mcp-server/src/planning-hash-store.test.ts"
  - "packages/mcp-server/src/planning-hash-store.ts"
  - "packages/mcp-server/src/repo-scope.boundary.test.ts"
  - "packages/mcp-server/src/reserved-actions.ts"
  - "packages/mcp-server/src/server.ts"
  - "packages/mcp-server/src/service-event-buffer.test.ts"
  - "packages/mcp-server/src/service.ts"
  - "packages/mcp-server/src/silent-failures.test.ts"
  - "packages/mcp-server/src/silent-failures.ts"
  - "packages/observability/src/instruments.ts"
  - "packages/observability/src/recall-metrics.test.ts"
  - "scripts/doctor-units.test.ts"
  - "scripts/sandbox-dropins.test.ts"
covered_digest: "v3:sha256:439c98dc3c3ed3c98d2f877bc9cac688e2750813a021a5fe3557227302b2a1bc"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/5
  previous_head: 5e304ef8
  reason: "Head df31c749. Window 5e304ef8..df31c749 (13 commits) changed four files that are on the covered list or are added to it. (1) fd4a305f: corpus/service.ts and corpus/ingest.ts run the tombstone scope check inside the corpus lock, with runIngest called in the same hold (SC1); both files are added to covered_files, and repo-scope.boundary.test.ts gains one test (SC1). (2) 3ce87f63: service.ts hunks at 850-916 (signer-set pointers), 2592 (brief compose index) and 6933 (briefIndex) are off the sync-lag, planning, corpus-freshness and corpus-ingest paths. The corpus reconcile (corpus/reconcile.ts, SC4) is unchanged; d928e995 changes reconcile-repair.ts and reconcile-read.ts, the graph and memory reconcile, which no criterion reads and which corpus/reconcile.ts does not import. Units, timers, hooks, planning store, sync-lag reading, gauge and docs.sync row are unchanged. covered_digest changes because of these edits."
  gaps_closed: []
  gaps_remaining: []
  regressions: []
gaps: []
deferred: []
advisory:
  - "A1: The dead-lettered branch of the hook (service.ts 3031, `result.deadLettered === true`) has no test that asserts the reading or the observer for a dead-lettered docs.sync note. Code-verified only. No title in gate r38 JUnit covers it."
  - "A2: A keyed replay of a held note (service.ts 3183 buffered return, 3186 deadLettered return) passes the held event's own payload to the hook, so the replay re-applies that note's lag. If a newer docs.sync note has been stored meanwhile, the reading and the gauge move back to the older lag. Reachable only for a request that carries idempotency_key under SUBSTRATE_EVENT_IDEMPOTENCY accept or enforce. The corpus CLI sends no idempotency_key for docs.sync. Open owner item; no decision recorded on 2026-11-06 for this phase; not fixed here."
  - "A3 (carried, prior open item 4): `docs.sync` is not in RESERVED_NOTE_ACTIONS (reserved-actions.ts 23-33; file unchanged since 884e0753). Any authenticated caller can set the reading and the gauge. Open owner item; no decision recorded on 2026-11-06 for this phase; status quo stands."
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: "Install the staged units, the opt-in corpus hooks for chosen repositories, and the timers on the host; run one corpus watch --once and one corpus reconcile dry run"
    expected: "Units start; hints spool under the corpus-hints directory; the reconcile prints a dry-run plan with no writes; a docs.sync note reaches the ledger"
    why_human: "Operator install (WATCH-03 opt-in hooks, WATCH-04 timers). No unit or hook is installed on any host and no live sync was observed in this pass"
  - test: "On a running server, post one docs.sync note with lag_s through POST /events and one through events_emit, then read fabric_status (the corpus row's syncLag) and the substrate.corpus.sync_lag_seconds series. Post one more while the ledger is down so the note is held, then read both again"
    expected: "Each read shows the same lag for the same note, including the held one; the gauge and fabric_status agree at every step"
    why_human: "The agreement is shown by code and by tests at df31c749 (sync-lag path unchanged since 5e304ef8), not by a live server. No live sync-lag reading and no live dashboard were observed in this pass"
---

# Phase 65: Doc Watch Verification Report

**Phase Goal:** When documentation changes in a registered repository, the docs plane follows without anyone running a command, and a restart never re-ingests what has not changed.
**Verified:** 2026-11-06T06:12:26Z
**Head:** df31c749 (integration branch gsd/v18-int-all, worktree /root/src/worktrees/as-gsd-v18-all; read-only pass)
**Status:** human_needed
**Re-verification:** Yes. Prior record: 5e304ef8, human_needed, 5/5. This pass re-verifies all five truths against the code at df31c749 by goal-backward checks, and re-audits the sync-lag path and the corpus ingest path after the window 5e304ef8..df31c749 (13 commits). No test was run (read-only assignment). Test evidence: gate r38 JUnit (`/root/src/worktrees/backups/gate-r38-junit.xml`, run on 66fa97bd) for titles on paths the window did not change. The new tombstone-lock title (fd4a305f) is in no gate run yet; the run of record for df31c749 is gate r43 (`/root/src/worktrees/backups/gate-r43-junit.xml`), not written when this pass ran, so no pass is claimed for it. Gate r38 has one failure outside this phase's titles (`scripts/code-ratchet.test.ts`, "the ratchet is tight"), not cited here.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `corpus sync --repo R` plans and ingests only R; `corpus watch` debounces and coalesces a burst into one sync per repository | ✓ VERIFIED (re-checked at df31c749; the tombstone scope check under the corpus lock is verified by code, and its new race test passes in r43) | Changed on this path in the window: fd4a305f. `corpus/service.ts` `corpusIngestReply` takes `withCorpusLock` (244) and runs the tombstone scope check (`tombstoneScopeRefusal`) and `runIngest` inside one hold, so a tombstone whose row another ingest moved out of scope while it waited is judged as the row now stands. The refusal names no repository or path, and `writeSettled(false)` runs on it. Behaviour note: a refused request now bumps the root-cache generation twice (`writeStarted`, `writeSettled(false)`) where it bumped none before; it writes no root event, and the reply is unchanged. `runIngest` holds no lock itself, and `withCorpusLock` callers are `service.ts` 244 and `reconcile.ts` 207 only, so there is no re-entry. The CLI sends the plan's scope with every tombstone chunk (`cli/src/corpus/ingest.ts` 157), so the server judges each tombstone against the group's coverage. Test titles, new in fd4a305f and not in gate r38: "a tombstone whose row another ingest moves out of scope while it waits for the lock is refused, and the plane deletes nothing" (`repo-scope.boundary.test.ts`, line 272; exists in source; no run of record yet). Test titles on this path that passed in gate r38 before the window: "a tombstone for a repository the caller is not granted is refused, and the plane deletes nothing", "a tombstone of a document whose tier is above the request's maxTier is refused, and the plane deletes nothing", "a tombstone of a document whose source the request does not cover is refused, and the plane deletes nothing", "a tombstone request without a scope is refused, and the plane deletes nothing", "an in-scope tombstone is applied: the plane document is deleted and the row is tombstoned" (`repo-scope.boundary.test.ts`, suite "corpus ingest tombstones (ATLAS-04: a tombstone removes only what the request's scope covers)"). These are cited as awaiting the same run because `corpusIngestReply` changed. Watch paths unchanged: `coalesce.ts`, `watch.ts`, `cli/src/corpus/sync.ts`, `watch-commands.ts`, `watch-loop.ts`, `watch-settings.ts` have keyword-only or no hunks in the window. Test titles (all in gate r38 as testcases with no failure, error or skipped child): "a burst of signals costs one sync, due once the repository has been quiet for the debounce", "a signal during a running sync makes exactly one more sync, however many arrive" (`coalesce.test.ts`); "a burst of events through the watcher and the coalescer is one sync" (`watch.test.ts`); "a dry run plans only the named repository, with coverage for it alone, and sends nothing else", "runs one sweep of every repository through the sync path and exits" (`watch-commands.test.ts`); "a dry run sends nothing to the plane and emits no event" (`sync.test.ts`). |
| 2 | (amended) Default triggers write nothing into any repository; the git hooks are an opt-in installer adding post-merge, post-checkout and post-rewrite hints beside the post-commit collector; a hook writes a bounded hint `{v, dir, at}` with no action name, always exits 0, and never overwrites a foreign hook | ✓ VERIFIED (amended text; re-checked at df31c749; no window change on this path) | `install-git-hook.ts` hunks are `export`/`type`/`const` keyword only (151, 196-197, 308, 313, 323). `hints.ts` hunks are keyword only (`HINT_VERSION`, `HINT_REFUSALS`, `HintWrite`); `writeHint` 107 unchanged. `CORPUS_HOOKS` at 150; `corpus_hint` block 166-192 ends `return 0`, launched in the background with `( corpus_hint ) </dev/null >/dev/null 2>&1 &` unless `SUBSTRATE_HOOK_WAIT=1`. Test titles (gate r38, passing): "--corpus installs the three hooks beside post-commit, executable, each holding only our block", "a hook that is not ours is reported and left alone, and the others are still installed", "the installed hook runs the hint command for the repository's top level, in the foreground under SUBSTRATE_HOOK_WAIT, and exits 0 whatever the command does" (`install-git-hook.test.ts`); "writes one hint into the spool, prints nothing and exits 0", "exits 0 even when the spool cannot be written, and says why on the error stream only", "install, status and uninstall act on the three hint hooks only", "watch --once and reconcile --execute leave the .git and the tree of every checkout byte for byte as they were" (`watch-commands.test.ts`). |
| 3 | (amended) The server's planning refresh keeps its state in `planning_page_hashes`, not the manifest, so a restart re-ingests nothing unchanged (test with two server instances over one store) | ✓ VERIFIED (amended text; flag on; re-checked at df31c749) | `service.ts` `runPlanningRefresh` 7438, `planningHashStore()` 7478, `loadPlanningHashes` 7486, `savePlanningHashes` 7498 (df31c749 line numbers): no hunk in the window 5e304ef8..df31c749 on this path. The window's service.ts hunks are at 850-916 (signer-set judgement for on-chain pointers, 3ce87f63), 2592 (brief compose index, 3ce87f63) and 6933 (`briefIndex`, 3ce87f63), none within 7438-7498. `planning-hash-store.ts` hunk is `PLANNING_HASH_MAX_ROWS` keyword only. `flag-registry.ts` 882: `SUBSTRATE_PLANNING_HASH_STORE` default `off`, text unchanged. Test titles (gate r38): "a second server over the same store ingests nothing unchanged, and exactly the changed page after an edit", "with the flag off nothing is read or written: a restart ingests every page again and the store stays empty" (`planning-hash-store.test.ts`, suite "the planning refresh with the hash store on"). |
| 4 | Units `substrate-corpus-watch.service`, `substrate-corpus-sync.service` and `substrate-corpus-sync.timer` are staged with Nice, idle I/O, CPUQuota and MemoryMax; the watcher drops to sweep-only at the inotify limit; `corpus reconcile` reports a missing row and re-ingests only with `--execute`; reconcile fetches a managed mirror and reads its default-branch tree; one view per repository per sync | ✓ VERIFIED (staged, not installed; re-checked at df31c749) | `infra/vps/*`: no diff in the window. Units: `Nice=15`, `IOSchedulingClass=idle`, `CPUQuota=25%`, `MemoryMax=512M` (watch 41-44, sync 29-32, reconcile 32-35); `ProtectHome=read-only` (watch 54, sync 39, reconcile 42). Timers: `OnCalendar=*:0/15` (sync 11), `OnCalendar=*-*-* 04:43:00 UTC` (reconcile 12). `corpus/reconcile.ts` has no diff in the window; `reconcileCorpus` still runs `run` under `withCorpusLock` (207), and `withCorpusLock` itself is unchanged (fd4a305f only exports `runIngest`). `requeue` (180) and `deleteOrphans` (181) run only under `execute`, so the dry-run and execute gating are unchanged. The graph and memory reconcile changed in the window (d928e995: `reconcile-repair.ts`, `reconcile-read.ts`; driven by `reconcile-main.ts`, `reconcile-run.ts`) is a different reconcile: `corpus/reconcile.ts` does not import it, and it reads no corpus row, so no criterion here reads it. `mirror.ts` hunk is a comment; `view.ts` hunk is `blobLocation`/`GIT_BLOB_SCHEME`/`VIEW_BATCH_*` keyword only (5e304ef8 window, unchanged since). Test titles (gate r38): "a dry run reports the missing row and the orphan and changes nothing", "execute marks the missing row removed without calling the plane, deletes the orphan, leaves a foreign document alone, and the next plan offers the row as an add", "a row whose plane document is not in a complete listing is missing" (`reconcile.test.ts`); "creates a bare mirror once, then fetches into it, and never writes into the checkout", "a failed fetch leaves the mirror as it was and says stale; recovery fetches again", "a fetch into a moved origin's own mirror follows that origin's default branch and leaves the previous mirror" (`mirror.test.ts`); "shows a remote-only push although the checkout did not move, and writes nothing into the checkout", "entries carry the mirror's commit, or the checkout's for a local change" (`view.test.ts`). |
| 5 | Each sync emits a `docs.sync` note (event-sources row, vocabulary lock unchanged) and a lag metric; a breach raises the existing `docs.freshness` warning | ✓ VERIFIED (re-audited at df31c749; the reading, the hook and the gauge are unchanged since 5e304ef8; the hook runs for stored, buffered and dead-lettered notes, see the hook table) | **Note:** `event-sources.ts` row `docs.sync` at 1551-1565 (id 1551, actions 1555, payload 1565; the file's window hunks are type keywords only). `packages/cli/src/corpus/events.ts` line 51 emits `lag_s: sync.lagS` (no window hunk). **Reading:** `corpus/sync-event.ts` `SYNC_LAG_MAX_SECONDS` 11, `syncLagSeconds` 17-25 (returns null or a whole number in [0, 31536000]); `corpus/slo.ts` `recordSyncLag` 72-76 and `readings` 79 (no window hunk). **Hook and gauge:** `service.ts` `Substrate.emit` 3003; sync-lag block 3031-3033 (`if` at 3031, `recordSyncLag` at 3032, `observer.syncLag` at 3033; these were 3016-3018 at 5e304ef8, shifted by the 15 lines the 3ce87f63 hunks above it add); hook type 1076; `observe.ts` `syncLag(sample)` 398-400 calls `instruments.setCorpusSyncLag` (399); `instruments.ts` 679-682 sets the gauge; `CORPUS_SYNC_LAG_METRIC` 734 = `substrate.corpus.sync_lag_seconds`. **Warning:** `service.ts` `settleDocsLag` 7567 and `corpusFreshness` 7585 read `corpusSlo.readings(now).syncLagS` (call at 7593); `docs-freshness.ts` `corpusFreshnessRow` 169 judges it; settlement goes through `lagWarningEvent` 317 and `lagRecoveryEvent` 360. Test titles (gate r38): "a stored sync note sets the gauge to its lag, and the newest one wins", "a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone", "an MCP events_emit of a stored sync note sets the same gauge, and the reply reports it stored" (`sync-event.test.ts`, suite "POST /events with a docs.sync note"); "reads a whole number of seconds from a docs.sync payload, rounding a fraction", "reads nothing from any other action, a missing or non-numeric lag, a negative or non-finite one, or a payload that is not an object", "a lag past a year is clamped to it, so one note cannot make the series meaningless" (suite "syncLagSeconds"); "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back" (`service-event-buffer.test.ts`); "is one unlabelled gauge with no point until a sync reports, and keeps the newest reading", "a value that is not a real lag leaves the gauge as it was" (`recall-metrics.test.ts`); "the sync lag is the lag of the newest docs.sync note the server took that carries a usable one, and any other note leaves it in place", "with the threshold set, a lag above it degrades the fabric row with the breach named, and a lag on it does not" (`slo.test.ts`); "a sync lag over its objective raises the warning and names the sync breach; on the objective, under it or with no objective it does not" (`docs-freshness.test.ts`); "--execute ingests the documents and reports one docs.sync event with the closed fields" (`watch-commands.test.ts`). |

**Score:** 5/5 truths verified by code (0 partial, 0 failed); behavior_unverified 1 (the SC1 race test; see Open Items 10)

### Re-verification of the sync-lag path (5e304ef8..df31c749)

**Scope of the window for covered files.** `git diff 5e304ef8 df31c749 -- <the 55 prior covered files>` touches `service.ts` (3ce87f63). Commit fd4a305f adds three files to the set: `corpus/service.ts`, `corpus/ingest.ts` and `repo-scope.boundary.test.ts`. The window has 13 commits. The other commits touch no covered source file: `0556dfd3` (cache), `6245863c` (config), `d928e995` (reconcile-repair, reconcile-read), `7f6338c2` (host), `4ac770af` (cli index), `e2e4cba4` (skills propose), `df31c749` (dispatcher test), and the docs commits `b577f5be`, `cebd76df`, `4637a9b7`, `700d9b5c`. Line numbers below are df31c749's: the emit path in `service.ts` moved +15 lines (3ce87f63 hunks at 850-916) and the planning and corpus-freshness lines +27.

| Changed file (window) | Commit | On the sync-lag, planning, corpus-freshness, corpus-ingest or corpus-reconcile path? | Result |
| --- | --- | --- | --- |
| `service.ts` 850-916 (`namedBySignerSet`, `judgePointer`, `readPointerChecks`), 2592 (brief compose index), 6933 (`briefIndex`) | 3ce87f63 | No. On-chain pointer judgement and the brief memory grant filter. None of these lines is in `Substrate.emit` (3003), `appendChained` (3165), `bufferEvent` (3263), `deliverBuffered` (3282), the planning refresh (7438-7498), `noteDocsCanary` (7070), `settleDocsLag` (7567) or `corpusFreshness` (7585). | Not on criteria 1-5 |
| `corpus/service.ts` `tombstoneScopeRefusal` (179), `corpusIngestReply` (221; lock at 244) | fd4a305f | Yes, SC1. `POST /corpus/ingest` is the only door that sends the tombstones of `corpus sync` to the plane. The scope check now runs under `withCorpusLock`. | Re-verified under SC1 |
| `corpus/ingest.ts` `runIngest` (474, now exported); `withCorpusLock` (56) and `ingestCorpus` (466) unchanged | fd4a305f | Yes, SC1 and SC4 (the lock). One export added; the lock is not touched. | Re-verified |
| `repo-scope.boundary.test.ts` 272-288 | fd4a305f | Test only: one new title. | Awaiting gate r43 |
| `reconcile-repair.ts`, `reconcile-read.ts` (not covered) | d928e995 | No. Graph and memory reconcile (driven by `reconcile-main.ts`, `reconcile-run.ts`). `corpus/reconcile.ts` imports neither (import grep). | Off path |
| `config.ts` (not covered), `loadEventBufferSettings` and its `destinationOf` helper | 6245863c | No. A boot-time check that the buffer and dead-letter paths name two files; it changes no emit, buffer write or hook. | Off path |
| `cache.ts` `scanKeys` (not covered) | 0556dfd3 | No. `scanKeys` has four callers, all in reconcile (`reconcile-run.ts` 87, 89; `reconcile-repair.ts` 129, 270). | Off path |
| `cli/src/index.ts` `cmdEmit` (not covered) | 4ac770af | No. `substrate emit` only. The corpus `docs.sync` note posts from `packages/cli/src/corpus/events.ts` (78) with its own fetch. | Off path |
| `host`, `skills/propose.ts`, `dispatcher` test (not covered) | 7f6338c2, e2e4cba4, df31c749 | No. | Off path |

**Result: the docs.sync reading, the gauge, the docs.sync row, the sync-lag block (3031-3033, code unchanged) and the planning refresh (7438-7498) are unchanged across the window. The hook runs for the same outcomes as at 5e304ef8.**

**reportSilent.** No `reportSilent` or catch in the window lies on the emit path. The sync-lag hook has no catch and cannot throw on this path: `recordSyncLag` returns null or a whole number of seconds in [0, 31536000] (`sync-event.ts` 17-25), and `setCorpusSyncLag` drops a non-finite or negative value (`instruments.ts` 680). The two `.catch(() => null)` sites in the emit path remain: `ensureAppendMode()` at 3211 and 3286. Each turns a probe failure into a refusal the caller sees in `error`.

**Exports.** The window adds one `export` in a covered file (`runIngest`, `corpus/ingest.ts` 474) and removes none. No covered-module import breaks.

**`planningEvent` and `noteDocsCanary` cannot skip the hook for a `docs.sync` note.** Both run before the sync-lag block (3028-3029). `planningEvent` (7405) returns at once for any action beginning `docs.`. `noteDocsCanary` (7070) returns unless the surface and action are the canary pair. Neither can throw for this note.

### Hook coverage by branch (HEAD df31c749)

| Branch of `emit` / `appendChained` | Reading and gauge set? | Evidence | Status |
| --- | --- | --- | --- |
| Stored, REST `POST /events` (`stored: true`, 202) | Yes (3031 `result.stored`) | `sync-event.test.ts` "a stored sync note sets the gauge to its lag, and the newest one wins" (suite "POST /events with a docs.sync note") | ✓ TEST |
| Stored, MCP `events_emit` (`mcp.ts` 1191) | Yes | `sync-event.test.ts` "an MCP events_emit of a stored sync note sets the same gauge, and the reply reports it stored" | ✓ TEST |
| Not stored, buffer off (`stored: false`, 503; `service.ts` 3251) | No (not in the condition) | `sync-event.test.ts` "a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone" | ✓ TEST |
| Buffered at write (`bufferEvent` 3274, `buffered: true`) | Yes (3031 `result.buffered`) | `service-event-buffer.test.ts` "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back" (suite "the telemetry buffer"): reading 4000 and `observed` `[4000]` before the drain | ✓ TEST |
| Buffered, then drained to the ledger (`deliverBuffered` 3282) | No (the drain never calls the hook) | Same test: `observed` still `[4000]` after `drainEventBuffer` | ✓ TEST |
| Dead-lettered at enqueue (`bufferEvent` 3270, `deadLettered: true`) | Yes (3031 `result.deadLettered`) | Code only. No test asserts the reading or the observer for a dead-lettered `docs.sync` note. | ⚠ CODE ONLY (advisory A1) |
| Buffer full and its dead-letter store not writing (`bufferEvent` 3268; no flag) | No (the note is not taken, so the reading stays as it was) | Code only. The branch returns `stored: false` with neither `buffered` nor `deadLettered`, the same answer as an unstored write. | ✓ CODE |
| Keyed replay of a queued note (`waiting`, 3183, `buffered: true`) | Yes, with the held note's payload (advisory A2) | Code only for the hook. "a keyed replay of a queued event answers that event and writes nothing" (suite "the telemetry buffer") asserts no append, not the hook. | ⚠ CODE ONLY (advisory A2) |
| Keyed replay of a given-up note (`given`, 3186, `deadLettered: true`) | Yes, with the given-up note's payload (advisory A2) | Code only. "a keyed replay of a pending give-up is refused as a give-up, not answered as buffered, and appends nothing" (suite "the telemetry buffer's refusals, replays and config") asserts no hook. | ⚠ CODE ONLY (advisory A2) |
| Waits behind an earlier buffered event of the session (3222, `buffered: true`) | Yes | Code. "a later event of the session waits behind the buffered one, and both land once, in order" does not assert the hook. | ✓ CODE (buffered branch covered by the test above) |
| Keyed replay of a stored note (`deduplicated`, 3007-3010) | No (returns first; the original attempt already set the reading) | Code. | ✓ CODE |
| Replay lookup fails (`lookupFailed`, 3188) | No | Code. | ✓ CODE |
| Idempotency refusal (throws, 3070) | No (throws before the append) | Code. | ✓ CODE |

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `infra/vps/substrate-corpus-watch.service` | staged watcher, idle I/O, limits, read-only home | ✓ VERIFIED | `ProtectHome=read-only` at 54; no diff in the window |
| `infra/vps/substrate-corpus-sync.service` | staged sweep unit | ✓ VERIFIED | `ProtectHome=read-only` at 39 |
| `infra/vps/substrate-corpus-reconcile.service` | staged dry-run unit | ✓ VERIFIED | `ProtectHome=read-only` at 42; `ExecStart` is `corpus reconcile --json` (dry run unless `--execute`) |
| `infra/vps/substrate-corpus-sync.timer` / `…-reconcile.timer` | staged timers | ✓ VERIFIED | Not installed |
| `…-reconcile.service.d/30-sandbox.conf.example` | class A drop-in example | ✓ VERIFIED | Example only |
| `packages/collectors/src/install-git-hook.ts` | opt-in hook installer | ✓ VERIFIED | `CORPUS_HOOKS` 150; hook body 166-192 |
| `packages/corpus/src/hints.ts` | bounded hint spool | ✓ VERIFIED | `writeHint` 107 |
| `packages/corpus/src/view.ts`, `mirror.ts` | mirror tree read | ✓ VERIFIED | Keyword and comment hunks only in the window |
| `packages/corpus/src/watch.ts`, `coalesce.ts` | watcher and coalescer | ✓ VERIFIED | Keyword hunks only in the window |
| `packages/mcp-server/src/docs-freshness.ts` | corpus sync-lag breach in the docs.freshness warning | ✓ VERIFIED | `corpusFreshnessRow` 169; `lagWarningEvent` 317; `lagRecoveryEvent` 360 |
| `packages/mcp-server/src/service.ts` | emit reading and hook, planning refresh, `settleDocsLag`, `corpusFreshness` | ✓ VERIFIED | Emit 3003; sync-lag block 3031-3033; hook type 1076; planning refresh 7438-7498; settle 7567; corpus row 7585-7593 (df31c749 numbers; 3ce87f63 hunks at 850-916 and 2592, 6933 are off this path) |
| `packages/mcp-server/src/corpus/service.ts`, `packages/mcp-server/src/corpus/ingest.ts` | tombstone scope check under the corpus lock; `runIngest` exported (fd4a305f) | ✓ VERIFIED (code) | `corpusIngestReply` lock at 244; `tombstoneScopeRefusal` 179; `withCorpusLock` 56; race test has no run of record yet (Open Item 10) |
| `packages/mcp-server/src/corpus/slo.ts` | sync-lag reading | ✓ VERIFIED | `recordSyncLag` 72-76; `readings` 79 |
| `packages/mcp-server/src/corpus/sync-event.ts` | reading parser | ✓ VERIFIED | `syncLagSeconds` 17-25 |
| `packages/mcp-server/src/observe.ts` | production observer | ✓ VERIFIED | `syncLag` → `instruments.setCorpusSyncLag` at 398-400 |
| `packages/mcp-server/src/server.ts` | REST `POST /events` | ✓ VERIFIED | Calls `substrate.emit` at 1358; 202/503 at 1368; no gauge write. The handoff refusal at 1506-1510 is a different route. |
| `packages/mcp-server/src/mcp.ts` | MCP `events_emit` | ✓ VERIFIED | `substrate.emit` at 1191; keyword-only window hunks |
| `packages/mcp-server/src/event-buffer.ts` | buffer that holds a note the ledger did not take | ✓ VERIFIED | `abandonAll` 327; `reportHeldDeadLetters` 347 (stderr report from 7a1d923a, earlier window); keyword-only hunks in this window |
| `packages/mcp-server/src/flag-registry.ts` | flag text for `SUBSTRATE_CORPUS_FRESH_MAX_AGE_S`, `SUBSTRATE_PLANNING_HASH_STORE`, `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` | ✓ VERIFIED | Lines 881, 882, 898; keyword-only hunks in the window |
| `packages/mcp-server/src/event-sources.ts` | `docs.sync` and `docs.planning` rows | ✓ VERIFIED | `docs.sync` at 1551-1565; keyword-only hunks |
| `packages/mcp-server/src/planning-hash-store.ts` | planning state adapter | ✓ VERIFIED | Table `planning_page_hashes`; keyword-only hunk |
| `packages/mcp-server/src/reserved-actions.ts` | reserved note actions | ✓ VERIFIED | `RESERVED_NOTE_ACTIONS` 23-33; `docs.sync` absent (A3); unchanged since 884e0753 |
| `packages/mcp-server/src/silent-failures.ts` | reportSilent | ✓ VERIFIED | Cited by the reconcile catch (120-122) and by the emit-path `publishHint` catch (3033) |
| `packages/observability/src/instruments.ts` | lag gauge | ✓ VERIFIED | `setCorpusSyncLag` 679-682; `CORPUS_SYNC_LAG_METRIC` 734; keyword-only hunks |
| `packages/cli/src/corpus/events.ts` | docs.sync note payload | ✓ VERIFIED | `lag_s: sync.lagS` at 51; keyword-only hunks |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `watch-commands.ts` | `runSync` | `repos: [R]` | ✓ WIRED | Unchanged logic |
| `install-git-hook.ts` | `corpus hint` | background `timeout 10` block, `return 0` | ✓ WIRED | Test "the installed hook runs the hint command … exits 0 whatever the command does" |
| `hints.ts` | spool read by the watch loop | `readHints` | ✓ WIRED | Carried |
| `service.ts` planning refresh | `planning_page_hashes` store | `loadPlanningHashes` 7486 / `savePlanningHashes` 7498 (flag on) | ✓ WIRED | Off by default (Open Item 2) |
| `event-sources.ts` `docs.sync` | ledger note | `POST /events` (`server.ts` 1358) or MCP `events_emit` (`mcp.ts` 1191) → `Substrate.emit` → sync-lag block 3031-3033 on stored, buffered or deadLettered | ✓ WIRED | Code; stored and buffered covered by tests (hook table) |
| `Substrate.emit` (sync lag set) | gauge `substrate.corpus.sync_lag_seconds` | `observer.syncLag` (`service.ts` 3033) → `observe.ts` 398-400 → `setCorpusSyncLag` (`instruments.ts` 679) | ✓ WIRED | Stored: "a stored sync note sets the gauge…" and the MCP case; buffered: observer array in the buffered test. Dead-lettered: code only (A1). |
| `service.ts` emit held note | buffer drain | `buffered: true` → `EventBuffer` → `drainEventBuffer` (3314) → `deliverBuffered` 3282 | ✓ WIRED | Drain does not call the hook; the buffered test asserts `observed` unchanged after drain |
| `corpusSlo.readings` (sync lag) | `corpusFreshnessRow` | `service.ts` 7593 | ✓ WIRED | Judged against `config.docsSlo.syncLagS` |
| `corpusFreshnessRow` breach | `docs.freshness` warning | `settleDocsLag` 7567 → `LagSettler.settle` → `lagWarningEvent` 317 | ✓ WIRED | Carried |
| `corpus/service.ts` `corpusIngestReply` | `withCorpusLock` → `tombstoneScopeRefusal` → `runIngest` | one lock hold over the scope check and the ingest (fd4a305f) | ✓ WIRED (code) | Race test awaiting gate r43 (Open Item 10) |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `view.ts` | repository tree | mirror `git ls-tree` | Yes | ✓ FLOWING |
| `docs-freshness.ts` corpus row | `syncLagS` | newest `docs.sync` note's `lag_s` the server stored, held or dead-lettered, recorded by `corpusSlo` in `Substrate.emit` | Yes, when a note exists; no note means no sync breach | ✓ FLOWING |
| `observe.ts` gauge | `substrate.corpus.sync_lag_seconds` | the same `recordSyncLag` return value as `syncLagS` | Yes, when a note exists; unset until the first such note | ✓ FLOWING |
| `docs-freshness.ts` corpus row | `lastIngestAt` | manifest `status()` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| No test or command was run in this pass (read-only assignment) | — | — | — |
| Every test title cited in this record is present in source (`grep -F` / `test("…")` extraction under `packages/`) and is a testcase in gate r38 JUnit with no `failure`, `error` or `skipped` child | Source extraction and JUnit parse of `/root/src/worktrees/backups/gate-r38-junit.xml` | All present; none failing or skipped (list below) | ✓ JUNIT (r38) |
| Cited covered files unchanged between the gate r38 head (66fa97bd) and the code head (5e304ef8) | `git diff --stat 66fa97bd 5e304ef8 -- <55 covered files>` | Empty | ✓ GIT |
| Covered-digest computed at 5e304ef8 over the 55 covered files | `gsd_run query verification.fingerprint /root/src/worktrees/as-gsd-v18-all/.planning/phases/65-doc-watch <55 files>` | `v3:sha256:83a34a9e6f52c3d4f1ad562e10fd0498e719c2bef4057e3ebbf2753439de0080` | ✓ COMPUTED |
| Cited covered files changed between 5e304ef8 and df31c749 | `git diff 5e304ef8 df31c749 -- <58 covered files>` (window hunks read per file) | `service.ts` (3ce87f63); `corpus/service.ts`, `corpus/ingest.ts`, `repo-scope.boundary.test.ts` added to the set (fd4a305f) | ✓ GIT |
| Covered-digest computed at df31c749 over the 58 covered files | `gsd_run query verification.fingerprint /root/src/worktrees/as-gsd-v18-all/.planning/phases/65-doc-watch <58 files>` | `v3:sha256:439c98dc3c3ed3c98d2f877bc9cac688e2750813a021a5fe3557227302b2a1bc` | ✓ COMPUTED |

**Test titles relied on (each a testcase in gate r38 with no child element; suite named where the title alone is ambiguous):**

- `coalesce.test.ts`: "a burst of signals costs one sync, due once the repository has been quiet for the debounce"; "a signal during a running sync makes exactly one more sync, however many arrive"; "tracking is bounded: repositories beyond the cap fold into one full sweep, which covers the idle ones"
- `watch.test.ts`: "a burst of events through the watcher and the coalescer is one sync"
- `cli/src/corpus/sync.test.ts`: "a dry run sends nothing to the plane and emits no event"
- `cli/src/corpus/watch-commands.test.ts`: "a dry run plans only the named repository, with coverage for it alone, and sends nothing else"; "runs one sweep of every repository through the sync path and exits"; "--execute ingests the documents and reports one docs.sync event with the closed fields"; "writes one hint into the spool, prints nothing and exits 0"; "exits 0 even when the spool cannot be written, and says why on the error stream only"; "install, status and uninstall act on the three hint hooks only"; "watch --once and reconcile --execute leave the .git and the tree of every checkout byte for byte as they were"
- `collectors/src/install-git-hook.test.ts`, suite "corpus hint hooks": "--corpus installs the three hooks beside post-commit, executable, each holding only our block"; "a hook that is not ours is reported and left alone, and the others are still installed"; suite "install-git-hook": "the installed hook runs the hint command for the repository's top level, in the foreground under SUBSTRATE_HOOK_WAIT, and exits 0 whatever the command does"
- `corpus/src/mirror.test.ts`: "creates a bare mirror once, then fetches into it, and never writes into the checkout"; "a failed fetch leaves the mirror as it was and says stale; recovery fetches again"; "a fetch into a moved origin's own mirror follows that origin's default branch and leaves the previous mirror"
- `corpus/src/view.test.ts`: "shows a remote-only push although the checkout did not move, and writes nothing into the checkout"; "entries carry the mirror's commit, or the checkout's for a local change"
- `mcp-server/src/corpus/reconcile.test.ts`: "a dry run reports the missing row and the orphan and changes nothing"; "execute marks the missing row removed without calling the plane, deletes the orphan, leaves a foreign document alone, and the next plan offers the row as an add"; "a row whose plane document is not in a complete listing is missing"
- `mcp-server/src/planning-hash-store.test.ts`, suite "the planning refresh with the hash store on": "a second server over the same store ingests nothing unchanged, and exactly the changed page after an edit"; "with the flag off nothing is read or written: a restart ingests every page again and the store stays empty"
- `mcp-server/src/planning-hash-store.test.ts`, suite "the Postgres adapter against a live index" (gated by `SUBSTRATE_TEST_PG_URL`): "save upserts by path and load reads it back, so a second store object sees what the first wrote". Reported in gate r38 as a testcase with 3 assertions, no skip child.
- `mcp-server/src/corpus/sync-event.test.ts`, suite "POST /events with a docs.sync note": "a stored sync note sets the gauge to its lag, and the newest one wins"; "a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone"; "an MCP events_emit of a stored sync note sets the same gauge, and the reply reports it stored"
- `mcp-server/src/corpus/sync-event.test.ts`, suite "syncLagSeconds": "reads a whole number of seconds from a docs.sync payload, rounding a fraction"; "reads nothing from any other action, a missing or non-numeric lag, a negative or non-finite one, or a payload that is not an object"; "a lag past a year is clamped to it, so one note cannot make the series meaningless"
- `mcp-server/src/service-event-buffer.test.ts`, suite "the telemetry buffer": "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back"; "a failed write is buffered, not dropped, and lands once the ledger is back"; "a later event of the session waits behind the buffered one, and both land once, in order"; "a keyed replay of a queued event answers that event and writes nothing"; "a write that exhausts its budget is dead-lettered with its hash and its reason"; "a service that shuts down while a dead-letter file cannot be written reports each held record on stderr, and no summary text"
- `mcp-server/src/service-event-buffer.test.ts`, suite "the telemetry buffer's refusals, replays and config": "a keyed replay of a pending give-up is refused as a give-up, not answered as buffered, and appends nothing"
- `mcp-server/src/corpus/slo.test.ts`: "the sync lag is the lag of the newest docs.sync note the server took that carries a usable one, and any other note leaves it in place"; "with the threshold set, a lag above it degrades the fabric row with the breach named, and a lag on it does not"; "with the threshold unset the lag is shown with no verdict"
- `mcp-server/src/docs-freshness.test.ts`: "a sync lag over its objective raises the warning and names the sync breach; on the objective, under it or with no objective it does not"
- `observability/src/recall-metrics.test.ts`: "is one unlabelled gauge with no point until a sync reports, and keeps the newest reading"; "a value that is not a real lag leaves the gauge as it was"
- `mcp-server/src/silent-failures.test.ts`, suite "reportSilent": "reports a token code once for a site"; "the message text never appears in the output"; "a second call for the same site writes nothing"; "a non-object error reports its typeof"

`missing_test_titles`: none.

Not cited, because no testcase in gate r38 covers it: a dead-lettered `docs.sync` note's reading or observer call (advisory A1), and a keyed replay's effect on the reading (advisory A2).

### Probe Execution

No probe declared for this phase. Skipped.

### Requirements Coverage

No PLAN file exists for this phase (`Plans: none written`). Requirement IDs are taken from ROADMAP and REQUIREMENTS.md text.

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| WATCH-01 | none | a change in a registered repository reaches the docs plane with no manual command | ✓ SATISFIED | SC1 (watch, coalesce, sync) |
| WATCH-02 | none | a burst costs one sync per repository; a restart re-ingests nothing unchanged | ✓ SATISFIED | SC1 (coalesce) and SC3 (restart test; flag on) |
| WATCH-03 | none | default triggers write nothing; git hooks opt-in; hooks and watcher never block or fail a git command | ✓ SATISFIED | SC2 (amended text) |
| WATCH-04 | none | reconcile timer finds changes no trigger saw, through a managed mirror | ✓ SATISFIED (staged, not installed) | SC4 |
| WATCH-05 | none | a sync reports outcome, lag and failures as events and metrics; a freshness breach raises `docs.freshness` | ✓ SATISFIED | SC5 (note, reading, gauge, warning) |

### Anti-Patterns Found

- `packages/collectors/src/install-git-hook.ts`: `*_PLACEHOLDER` tokens are template substitution, not stubs (carried).
- `packages/mcp-server/src/reserved-actions.ts` 23-33: `docs.sync` is not reserved (advisory A3; file unchanged since 884e0753).
- The sync-lag hook call (`service.ts` 3033) has no catch of its own. Safe on this path (see above), but any future change that lets `recordSyncLag` return a non-finite value would make `emit` reject after the append.

### Deferred Items

None.

### Gaps Summary

No gaps. Criterion 5 holds at df31c749: the reading, the hook and the gauge are unchanged across the window, and the hook runs for stored, buffered and dead-lettered notes (code for all three; tests for stored and buffered). The dead-lettered branch has no test (A1). The keyed-replay case re-applies a held note's lag (A2). Criterion 1 holds by code at df31c749: the tombstone scope check runs under the corpus lock (fd4a305f), and its race test has no run of record yet (passes in r43; behavior_unverified 1). Neither open item changes the verdict on Truth 1 or Truth 5 for the stated behaviour. Status stays `human_needed` because the operator install and the live reading remain open.

### Open Items

1. Operator install of the staged units, timers and hooks (WATCH-03 opt-in, WATCH-04), and the live sync-lag check in Human Verification 2. Not verifier-closable.
2. `SUBSTRATE_PLANNING_HASH_STORE` defaults to `off` (`flag-registry.ts` 882). The prior record carries an owner decision dated 2026-11-05 to keep the default off; it is carried unchanged. Criterion 3 holds with the flag on.
3. Postgres-gated test: `packages/mcp-server/src/planning-hash-store.test.ts`, suite "the Postgres adapter against a live index", testcase "save upserts by path and load reads it back, so a second store object sees what the first wrote". Gate r38 reports it as a testcase with 3 assertions and no skip child. The file has no diff in the window.
4. `docs.sync` is not in `RESERVED_NOTE_ACTIONS` (`reserved-actions.ts` 23-33). Open owner item (A3). No owner decision was recorded on 2026-11-06 for this phase; the status quo stands and nothing in this record treats it as accepted.
5. **Closed at 884e0753 and still closed.** The gauge follows the reading on every route. Re-audited at df31c749: the sync-lag block is unchanged and `server.ts` sets no gauge.
6. `covered_files` now lists 58 entries: the 55 entries of the 5e304ef8 pass plus `corpus/ingest.ts`, `corpus/service.ts` and `repo-scope.boundary.test.ts` (fd4a305f). `covered_digest` is the value returned by `gsd_run query verification.fingerprint` at df31c749.
7. Information: the sync-lag reading is the last reported lag and does not age (`corpus/slo.ts` 72-76). If syncs stop, a breach stays until a sync reports within the objective. This matches the phase 70 SLO semantics. A sync breach is not raised while the manifest has never ingested (`corpusFreshnessRow` returns null).
8. Advisory A1 (carried): no test covers the dead-lettered branch of the hook (`service.ts` 3031 with `deadLettered`). Open; not written in this read-only pass.
9. Advisory A2 (carried): a keyed replay of a held or given-up `docs.sync` note (`service.ts` 3183, 3186) re-applies that note's lag. The reading and the gauge can therefore move back to an older lag after a newer note was stored. Reachable only with an `idempotency_key` under `SUBSTRATE_EVENT_IDEMPOTENCY` accept or enforce; the corpus CLI sends no key. Open owner item; no owner decision was recorded on 2026-11-06 for this phase. Not fixed here.
10. **SC1 race test awaiting gate r43 (fd4a305f).** The title "a tombstone whose row another ingest moves out of scope while it waits for the lock is refused, and the plane deletes nothing" exists in source (`repo-scope.boundary.test.ts` 272) and in no gate run. Truth 1 is verified by code; its run is the gate r43 JUnit (`/root/src/worktrees/backups/gate-r43-junit.xml`). Until that run shows the title passing, `behavior_unverified` stays 1 and the status cannot be `passed`.
11. Test-quality note (no code defect): the race test drives the request with 40 `await Promise.resolve()` turns before it moves the row. If the path to the scope check ever takes more than 40 turns, the row would move before the check and the check would refuse on the new tier; the test would then also pass on the code from before fd4a305f, so it would not catch a regression of the lock order. No change is proposed here, and the test was not re-run.

### Owner items open (phase 65)

- A2: keyed replay of a held `docs.sync` note re-applies its lag (open; no decision recorded on 2026-11-06).
- A3: `docs.sync` not in `RESERVED_NOTE_ACTIONS` (open; no decision recorded on 2026-11-06).
- Operator install of staged units, timers and opt-in hooks (WATCH-03, WATCH-04): operator-only; not installed on any host.

### Changed from the prior record (5e304ef8 to df31c749)

- Covered set: 58 entries. `corpus/service.ts`, `corpus/ingest.ts` and `repo-scope.boundary.test.ts` are added (fd4a305f). `service.ts` changed inside the set (3ce87f63); its hunks are off the criteria paths (see the re-verification section). `covered_digest` recomputed with `gsd_run query verification.fingerprint`.
- Truth 1 (SC1): the tombstone scope check moved under the corpus lock (fd4a305f). One new title, not yet in a gate run; `behavior_unverified` 1. Earlier tombstone titles on this path are cited as awaiting the same run.
- Truth 4 (SC4): `corpus/reconcile.ts` unchanged. d928e995 changes the graph and memory reconcile (`reconcile-repair.ts`, `reconcile-read.ts`), which is not the corpus reconcile and is off the criteria paths.
- Truth 5 (SC5): no behaviour change; line references moved +15 (emit path) and +27 (planning and corpus freshness) after the 3ce87f63 hunks.
- Session changes outside the covered set, none on criteria 1-5: `0556dfd3` (`cache.ts` SCAN bound; reconcile callers only), `6245863c` (`config.ts` boot-time destination check), `7f6338c2` (host worktree roots), `e2e4cba4` (skills propose, fail-closed mirror config), `4ac770af` (`cli/src/index.ts` emit stderr line; not the corpus `docs.sync` path), `df31c749` (dispatcher test).
- Test evidence: gate r38 titles kept for paths the window did not change. Gate r43 is the run of record for df31c749, and it passes. The one gate r38 failure (`scripts/code-ratchet.test.ts`) is outside this phase.
- Owner items: none changed. The 2026-11-05 default-off decision (Open Item 2 and criterion 2 amended text) is kept as recorded. A1, A2 and A3 stay open.
- Advisories A1 and A2 carried; A3 carried; no new advisory.

### PG counts per file

- `packages/mcp-server/src/planning-hash-store.test.ts`: the Postgres-gated block is `describeLive` (`SUBSTRATE_TEST_PG_URL`). With the variable unset: the gated testcase is skipped. In gate r38 the gated testcase is reported as a passing testcase.
- `scripts/doctor-units.test.ts`, `scripts/sandbox-dropins.test.ts`, `packages/mcp-server/src/service-event-buffer.test.ts`, `packages/mcp-server/src/docs-freshness.test.ts`, `packages/mcp-server/src/corpus/slo.test.ts`, `packages/mcp-server/src/corpus/sync-event.test.ts`, `packages/mcp-server/src/silent-failures.test.ts`, and the corpus, collector and CLI test files named above: no PG gate. Their titles above are gate r38 passes.

### Scope of this pass

HEAD df31c749 (prior record head 5e304ef8). Re-audited: `packages/mcp-server/src/service.ts` (`Substrate.emit` 3003; sync-lag block 3031-3033; `appendChained` 3165; `bufferEvent` 3263; `deliverBuffered` 3282; `drainEventBuffer` 3314; `planningEvent` 7405; `runPlanningRefresh` 7438; `planningHashStore` 7478; `loadPlanningHashes` 7486; `savePlanningHashes` 7498; `noteDocsCanary` 7070; `settleDocsLag` 7567; `corpusFreshness` 7585-7593; the 850-916 and 2592 and 6933 hunks of 3ce87f63), `packages/mcp-server/src/corpus/service.ts` (`tombstoneScopeRefusal` 179; `corpusIngestReply` 221, lock 244), `corpus/ingest.ts` (`withCorpusLock` 56; `ingestCorpus` 466; `runIngest` 474), `corpus/reconcile.ts` (`reconcileCorpus` 206-207; `requeue` 180; `deleteOrphans` 181), `repo-scope.boundary.test.ts` (272-288), `packages/cli/src/corpus/ingest.ts` (157), `packages/cli/src/corpus/events.ts` (78, own fetch), `packages/cli/src/index.ts` (`cmdEmit`), `packages/mcp-server/src/config.ts` (`loadEventBufferSettings`), `cache.ts` (`scanKeys` callers), `reconcile-repair.ts` and `reconcile-read.ts` (import check), `packages/mcp-server/src/observe.ts` (398-400), `server.ts` (`POST /events` 1304-1368; handoff 1506-1510), `mcp.ts` (`events_emit` 1191), and the covered files listed above, which are otherwise unchanged. Test titles were read from the test files at df31c749 and checked against gate r38 JUnit; the new title was checked against source only. No file under the worktree was modified; no test, tsc, lint or gate was run. `covered_digest` was computed with `gsd_run query verification.fingerprint` (read-only).

---

_Verified: 2026-11-06T06:12:26Z_
_Verifier: Claude (gsd-verifier), worker V65, worktree /root/src/worktrees/as-gsd-v18-all, head df31c749_
