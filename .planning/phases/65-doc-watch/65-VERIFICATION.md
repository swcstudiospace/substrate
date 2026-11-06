---
phase: 65-doc-watch
verified: 2026-11-06T03:00:21Z
status: human_needed
score: 5/5 must-haves verified (success criteria 1-5; SC2 and SC3 against the owner-amended text dated 2026-11-05; SC5 at 5e304ef8)
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
  - "packages/mcp-server/src/corpus/reconcile.test.ts"
  - "packages/mcp-server/src/corpus/reconcile.ts"
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
covered_digest: "v3:sha256:83a34a9e6f52c3d4f1ad562e10fd0498e719c2bef4057e3ebbf2753439de0080"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/5
  previous_head: a46d42c3
  reason: "Head 5e304ef8. Window a46d42c3..5e304ef8 (14 commits) changed 24 covered source files. Every hunk in them is either a keyword change (`export` removed from declarations that no file outside their own module imports, or `export` removed from a re-export list), a comment, a `catch` that now calls `reportSilent` (reconcile.ts, e62bc17b), or the REST handoff refusal (server.ts 1506-1510, 14ac787a), except one non-keyword hunk in service.ts (`manifestCommit`, line 6420, from 0947001e, phase 63), which is off this path. The sync-lag reading, the gauge, the docs.sync row, the planning refresh, the watch/coalesce path, the hook installer and the staged units are unchanged in the window. Cited test titles were checked against source and against gate r38 JUnit; no cited covered file changed between 66fa97bd and 5e304ef8. Covered files increased from 41 to 55 (14 test or source files now cited as evidence). Digest recomputed with gsd_run verification.fingerprint at 5e304ef8. Advisory A1 and A2 carried; A3 carried. Line references are re-anchored to 5e304ef8."
  gaps_closed: []
  gaps_remaining: []
  regressions: []
gaps: []
deferred: []
advisory:
  - "A1: The dead-lettered branch of the hook (service.ts 3016, `result.deadLettered === true`) has no test that asserts the reading or the observer for a dead-lettered docs.sync note. Code-verified only. No title in gate r38 JUnit covers it."
  - "A2: A keyed replay of a held note (service.ts 3168 buffered return, 3171 deadLettered return) passes the held event's own payload to the hook, so the replay re-applies that note's lag. If a newer docs.sync note has been stored meanwhile, the reading and the gauge move back to the older lag. Reachable only for a request that carries idempotency_key under SUBSTRATE_EVENT_IDEMPOTENCY accept or enforce. The corpus CLI sends no idempotency_key for docs.sync. Open owner item; no decision recorded on 2026-11-06 for this phase; not fixed here."
  - "A3 (carried, prior open item 4): `docs.sync` is not in RESERVED_NOTE_ACTIONS (reserved-actions.ts 23-33; file unchanged since 884e0753). Any authenticated caller can set the reading and the gauge. Open owner item; no decision recorded on 2026-11-06 for this phase; status quo stands."
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: "Install the staged units, the opt-in corpus hooks for chosen repositories, and the timers on the host; run one corpus watch --once and one corpus reconcile dry run"
    expected: "Units start; hints spool under the corpus-hints directory; the reconcile prints a dry-run plan with no writes; a docs.sync note reaches the ledger"
    why_human: "Operator install (WATCH-03 opt-in hooks, WATCH-04 timers). No unit or hook is installed on any host and no live sync was observed in this pass"
  - test: "On a running server, post one docs.sync note with lag_s through POST /events and one through events_emit, then read fabric_status (the corpus row's syncLag) and the substrate.corpus.sync_lag_seconds series. Post one more while the ledger is down so the note is held, then read both again"
    expected: "Each read shows the same lag for the same note, including the held one; the gauge and fabric_status agree at every step"
    why_human: "The agreement is shown by code and by tests at 5e304ef8, not by a live server. No live sync-lag reading and no live dashboard were observed in this pass"
---

# Phase 65: Doc Watch Verification Report

**Phase Goal:** When documentation changes in a registered repository, the docs plane follows without anyone running a command, and a restart never re-ingests what has not changed.
**Verified:** 2026-11-06T03:00:21Z
**Head:** 5e304ef8 (integration branch gsd/v18-int-all, worktree /root/src/worktrees/as-gsd-v18-all; read-only pass)
**Status:** human_needed
**Re-verification:** Yes. Prior record: a46d42c3, human_needed, 5/5. This pass re-verifies all five truths against the code at 5e304ef8 and re-audits the sync-lag path after the window a46d42c3..5e304ef8. No test was run (read-only assignment). Test evidence is gate r38 JUnit (`/root/src/worktrees/backups/gate-r38-junit.xml`, run on 66fa97bd). Gate r39 on 5e304ef8 was not yet written when this pass ran, so no pass count is claimed for the code head.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `corpus sync --repo R` plans and ingests only R; `corpus watch` debounces and coalesces a burst into one sync per repository | ✓ VERIFIED (re-checked at 5e304ef8) | Covered-file hunks in the window for `coalesce.ts`, `watch.ts`, `cli/src/corpus/sync.ts`, `watch-commands.ts`, `watch-loop.ts`, `watch-settings.ts` are keyword-only (`export` removed from declarations, one comment in `sync.ts` `ownerAlive`). No logic hunk. Test titles (all in gate r38 as testcases with no failure, error or skipped child): "a burst of signals costs one sync, due once the repository has been quiet for the debounce", "a signal during a running sync makes exactly one more sync, however many arrive" (`coalesce.test.ts`); "a burst of events through the watcher and the coalescer is one sync" (`watch.test.ts`); "a dry run plans only the named repository, with coverage for it alone, and sends nothing else", "runs one sweep of every repository through the sync path and exits" (`watch-commands.test.ts`); "a dry run sends nothing to the plane and emits no event" (`sync.test.ts`). |
| 2 | (amended) Default triggers write nothing into any repository; the git hooks are an opt-in installer adding post-merge, post-checkout and post-rewrite hints beside the post-commit collector; a hook writes a bounded hint `{v, dir, at}` with no action name, always exits 0, and never overwrites a foreign hook | ✓ VERIFIED (amended text; re-checked at 5e304ef8) | `install-git-hook.ts` hunks are `export`/`type`/`const` keyword only (151, 196-197, 308, 313, 323). `hints.ts` hunks are keyword only (`HINT_VERSION`, `HINT_REFUSALS`, `HintWrite`); `writeHint` 107 unchanged. `CORPUS_HOOKS` at 150; `corpus_hint` block 166-192 ends `return 0`, launched in the background with `( corpus_hint ) </dev/null >/dev/null 2>&1 &` unless `SUBSTRATE_HOOK_WAIT=1`. Test titles (gate r38, passing): "--corpus installs the three hooks beside post-commit, executable, each holding only our block", "a hook that is not ours is reported and left alone, and the others are still installed", "the installed hook runs the hint command for the repository's top level, in the foreground under SUBSTRATE_HOOK_WAIT, and exits 0 whatever the command does" (`install-git-hook.test.ts`); "writes one hint into the spool, prints nothing and exits 0", "exits 0 even when the spool cannot be written, and says why on the error stream only", "install, status and uninstall act on the three hint hooks only", "watch --once and reconcile --execute leave the .git and the tree of every checkout byte for byte as they were" (`watch-commands.test.ts`). |
| 3 | (amended) The server's planning refresh keeps its state in `planning_page_hashes`, not the manifest, so a restart re-ingests nothing unchanged (test with two server instances over one store) | ✓ VERIFIED (amended text; flag on; re-checked at 5e304ef8) | `service.ts` `runPlanningRefresh` 7411, `planningHashStore()` 7451, `loadPlanningHashes` 7459, `savePlanningHashes` 7471: no hunk in the window (the service.ts hunks in the window are keyword-only, plus the manifestCommit line at 6420, which belongs to the phase-63 fix 0947001e and is not on this path). `planning-hash-store.ts` hunk is `PLANNING_HASH_MAX_ROWS` keyword only. `flag-registry.ts` 882: `SUBSTRATE_PLANNING_HASH_STORE` default `off`, text unchanged. Test titles (gate r38): "a second server over the same store ingests nothing unchanged, and exactly the changed page after an edit", "with the flag off nothing is read or written: a restart ingests every page again and the store stays empty" (`planning-hash-store.test.ts`, suite "the planning refresh with the hash store on"). |
| 4 | Units `substrate-corpus-watch.service`, `substrate-corpus-sync.service` and `substrate-corpus-sync.timer` are staged with Nice, idle I/O, CPUQuota and MemoryMax; the watcher drops to sweep-only at the inotify limit; `corpus reconcile` reports a missing row and re-ingests only with `--execute`; reconcile fetches a managed mirror and reads its default-branch tree; one view per repository per sync | ✓ VERIFIED (staged, not installed; re-checked at 5e304ef8) | `infra/vps/*`: no diff in the window. Units: `Nice=15`, `IOSchedulingClass=idle`, `CPUQuota=25%`, `MemoryMax=512M` (watch 41-44, sync 29-32, reconcile 32-35); `ProtectHome=read-only` (watch 54, sync 39, reconcile 42). Timers: `OnCalendar=*:0/15` (sync 11), `OnCalendar=*-*-* 04:43:00 UTC` (reconcile 12). `reconcile.ts`: the only non-keyword hunk in the window is the `deleteOrphans` catch at 120-122, which now calls `reportSilent("reconcile.reference-check", cause)` and then `continue`s exactly as before; `deleteOrphans` runs only from `run` under `execute` (181), so the dry-run and execute gating are unchanged. `mirror.ts` hunk is a comment; `view.ts` hunk is `blobLocation`/`GIT_BLOB_SCHEME`/`VIEW_BATCH_*` keyword only. Test titles (gate r38): "a dry run reports the missing row and the orphan and changes nothing", "execute marks the missing row removed without calling the plane, deletes the orphan, leaves a foreign document alone, and the next plan offers the row as an add", "a row whose plane document is not in a complete listing is missing" (`reconcile.test.ts`); "creates a bare mirror once, then fetches into it, and never writes into the checkout", "a failed fetch leaves the mirror as it was and says stale; recovery fetches again", "a fetch into a moved origin's own mirror follows that origin's default branch and leaves the previous mirror" (`mirror.test.ts`); "shows a remote-only push although the checkout did not move, and writes nothing into the checkout", "entries carry the mirror's commit, or the checkout's for a local change" (`view.test.ts`). |
| 5 | Each sync emits a `docs.sync` note (event-sources row, vocabulary lock unchanged) and a lag metric; a breach raises the existing `docs.freshness` warning | ✓ VERIFIED (re-audited at 5e304ef8; the reading, the hook and the gauge are unchanged; the hook runs for stored, buffered and dead-lettered notes, see the hook table) | **Note:** `event-sources.ts` row `docs.sync` at 1551-1565 (id 1551, actions 1555, payload 1565; the file's window hunks are type keywords only). `packages/cli/src/corpus/events.ts` line 51 emits `lag_s: sync.lagS` (window hunks: keyword only). **Reading:** `corpus/sync-event.ts` `SYNC_LAG_MAX_SECONDS` 11, `syncLagSeconds` 17-25 (returns null or a whole number in [0, 31536000]); `corpus/slo.ts` `recordSyncLag` 72-76 and `readings` 79 (window hunk: keyword only). **Hook and gauge:** `service.ts` `Substrate.emit` 2988; sync-lag block 3015-3019 (`if` at 3016, `recordSyncLag` at 3017, `observer.syncLag` at 3018); hook type 1061; `observe.ts` `syncLag(sample)` 398-400 calls `instruments.setCorpusSyncLag` (399); `instruments.ts` 679-682 sets the gauge; `CORPUS_SYNC_LAG_METRIC` 734 = `substrate.corpus.sync_lag_seconds`. **Warning:** `service.ts` `settleDocsLag` 7540 and `corpusFreshness` 7558 read `corpusSlo.readings(now).syncLagS` (call at 7566); `docs-freshness.ts` `corpusFreshnessRow` 169 judges it; settlement goes through `lagWarningEvent` 317 and `lagRecoveryEvent` 360. Test titles (gate r38): "a stored sync note sets the gauge to its lag, and the newest one wins", "a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone", "an MCP events_emit of a stored sync note sets the same gauge, and the reply reports it stored" (`sync-event.test.ts`, suite "POST /events with a docs.sync note"); "reads a whole number of seconds from a docs.sync payload, rounding a fraction", "reads nothing from any other action, a missing or non-numeric lag, a negative or non-finite one, or a payload that is not an object", "a lag past a year is clamped to it, so one note cannot make the series meaningless" (suite "syncLagSeconds"); "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back" (`service-event-buffer.test.ts`); "is one unlabelled gauge with no point until a sync reports, and keeps the newest reading", "a value that is not a real lag leaves the gauge as it was" (`recall-metrics.test.ts`); "the sync lag is the lag of the newest docs.sync note the server took that carries a usable one, and any other note leaves it in place", "with the threshold set, a lag above it degrades the fabric row with the breach named, and a lag on it does not" (`slo.test.ts`); "a sync lag over its objective raises the warning and names the sync breach; on the objective, under it or with no objective it does not" (`docs-freshness.test.ts`); "--execute ingests the documents and reports one docs.sync event with the closed fields" (`watch-commands.test.ts`). |

**Score:** 5/5 truths verified (0 partial, 0 failed); behavior_unverified 0

### Re-verification of the sync-lag path (a46d42c3..5e304ef8)

**Scope of the window for covered files.** `git diff a46d42c3 5e304ef8 -- <the 55 covered files>` touches 24 files of the set. The window has 14 commits. Commits that touch covered files: `e62bc17b` (reportSilent), `14ac787a` (REST handoff, CLI handoff), `b8cbdeac`, `d9d0a401`, `4c576e5e`, `8ec17832`, `66fa97bd`, `5e304ef8` (export keyword), `a2176f96` (memory-retain, index-sweep: not covered), `f1266a9c` (cache.ts: not covered), `0947001e` (service.ts `manifestCommit`, phase 63). `cf4ea4c1`, `5041193f`, `9b951850` touch no covered source file.

| Changed covered file (window) | Commit | Sync-lag reading, gauge, docs.sync row, planning refresh or hook touched? | Result |
| --- | --- | --- | --- |
| `service.ts` `Substrate.emit` 2988-3022 and the sync-lag block 3015-3019 | export keyword commits | No hunk in these lines. The `deduplicated` return (2992-2997), `planningEvent` (3013), `noteDocsCanary` (3014), the sync-lag block and `publishHint` (3033, `emit.bus-hint` reportSilent from f0f3c04e, earlier window) are as at a46d42c3. | Confirmed unchanged |
| `service.ts` `appendChained` 3150-3242, `bufferEvent` 3248-3260, `deliverBuffered` 3267 | export keyword commits | No hunk. Keyed waiting return 3168, given-up return 3171, `ensureAppendMode().catch(() => null)` 3196, not-stored return 3236, buffered return 3259 and dead-letter return 3255 are the same lines as the prior record. | Confirmed unchanged |
| `service.ts` planning refresh 7378-7471, `settleDocsLag` 7540, `corpusFreshness` 7558-7566 | export keyword commits | No hunk in 7378-7566. | Confirmed unchanged |
| `service.ts` 6420 `manifestCommit` | 0947001e (phase 63) | Docs-search provenance wiring, not the sync-lag, planning or corpus-freshness path. Changed from `?.commit ?? null` to `?? null` on the row. | Not related to criteria 1-5 |
| `server.ts` `POST /events` 1304-1368 (`substrate.emit` at 1358; 202/503 at 1368) | none of the window commits touch these lines | No. | Confirmed unchanged |
| `server.ts` handoff route 1506-1510 | 14ac787a | Refuses a `to` outside SURFACES with 400 before `rememberClaim`; a `docs.sync` note never goes through this route. | Not on the reading path |
| `server.ts` export keyword lines (195, 338, 430, 436, 467) | keyword-only commits in the window | Keyword only. | Not related |
| `observe.ts` `syncLag` 398-400 and `instruments.setCorpusSyncLag` call | none in the window | No. The `auditStats` import and its re-export were removed; nothing in `observe.ts` references `auditStats` any longer, and `auditStats` has no importer from this file. | Confirmed unchanged |
| `reconcile.ts` `deleteOrphans` 115-135 | e62bc17b | The catch now reports (stderr) and `continue`s as before. | Not on the reading path; reporting only |
| `event-buffer.ts`, `event-sources.ts`, `flag-registry.ts`, `docs-freshness.ts`, `planning-hash-store.ts`, `slo.ts`, `corpus/sync-event.ts`, `instruments.ts`, `cli/src/corpus/events.ts` | export keyword commits | Keyword only (type or const `export` removed). Row, reading, gauge and flag text unchanged. | Confirmed unchanged |
| `mcp.ts` `events_emit` 1191 | keyword-only commits in the window | Four keyword-only hunks (`Attribution`, `SWARM_REPLICA_PATTERN`, `RagReport`, `RAG_SNIPPET_CAP`). The `events_emit` call at 1191 is unchanged. | Confirmed unchanged |
| `reserved-actions.ts` 23-33 | none since 884e0753 | `docs.sync` absent from `RESERVED_NOTE_ACTIONS`. | Unchanged (A3) |

**Result: the docs.sync reading, the gauge and the docs.sync row are unchanged across the window. The sync-lag block in `Substrate.emit` is unchanged. The hook runs for the same three outcomes as at a46d42c3.**

**reportSilent.** The only covered-file `reportSilent` addition in this window is the reconcile catch. None of the emit-path catches changed. The sync-lag hook has no catch and cannot throw on this path: `recordSyncLag` returns null or a whole number of seconds in [0, 31536000] (`sync-event.ts` 17-25), and `setCorpusSyncLag` drops a non-finite or negative value (`instruments.ts` 680). Two `.catch(() => …)` sites inside the emit path remain: `ensureAppendMode().catch(() => null)` at 3196 and the one at 3271. Each turns a probe failure into a refusal the caller sees in `error`, so neither is a silent drop of a sync note.

**Removed exports.** Every `export` keyword removed in the covered set was checked for importers (`grep` of `import … NAME` plus a `from "…<module>.ts"` match against each covered module). The one hit, `ReconcileDeps`, is imported from `reconcile-run.ts`, not from `corpus/reconcile.ts`, so it is a false positive. No covered-module import is broken by the window.

**`planningEvent` and `noteDocsCanary` cannot skip the hook for a `docs.sync` note.** Both run before the sync-lag block. `planningEvent` (7378) returns at once for any action beginning `docs.`. `noteDocsCanary` (7043) returns unless the surface and action are the canary pair. Neither can throw for this note.

### Hook coverage by branch (HEAD 5e304ef8)

| Branch of `emit` / `appendChained` | Reading and gauge set? | Evidence | Status |
| --- | --- | --- | --- |
| Stored, REST `POST /events` (`stored: true`, 202) | Yes (3016 `result.stored`) | `sync-event.test.ts` "a stored sync note sets the gauge to its lag, and the newest one wins" (suite "POST /events with a docs.sync note") | ✓ TEST |
| Stored, MCP `events_emit` (`mcp.ts` 1191) | Yes | `sync-event.test.ts` "an MCP events_emit of a stored sync note sets the same gauge, and the reply reports it stored" | ✓ TEST |
| Not stored, buffer off (`stored: false`, 503; `service.ts` 3236) | No (not in the condition) | `sync-event.test.ts` "a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone" | ✓ TEST |
| Buffered at write (`bufferEvent` 3259, `buffered: true`) | Yes (3016 `result.buffered`) | `service-event-buffer.test.ts` "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back" (suite "the telemetry buffer"): reading 4000 and `observed` `[4000]` before the drain | ✓ TEST |
| Buffered, then drained to the ledger (`deliverBuffered` 3267) | No (the drain never calls the hook) | Same test: `observed` still `[4000]` after `drainEventBuffer` | ✓ TEST |
| Dead-lettered at enqueue (`bufferEvent` 3255, `deadLettered: true`) | Yes (3016 `result.deadLettered`) | Code only. No test asserts the reading or the observer for a dead-lettered `docs.sync` note. | ⚠ CODE ONLY (advisory A1) |
| Keyed replay of a queued note (`waiting`, 3168, `buffered: true`) | Yes, with the held note's payload (advisory A2) | Code only for the hook. "a keyed replay of a queued event answers that event and writes nothing" (suite "the telemetry buffer") asserts no append, not the hook. | ⚠ CODE ONLY (advisory A2) |
| Keyed replay of a given-up note (`given`, 3171, `deadLettered: true`) | Yes, with the given-up note's payload (advisory A2) | Code only. "a keyed replay of a pending give-up is refused as a give-up, not answered as buffered, and appends nothing" (suite "the telemetry buffer's refusals, replays and config") asserts no hook. | ⚠ CODE ONLY (advisory A2) |
| Waits behind an earlier buffered event of the session (3207, `buffered: true`) | Yes | Code. "a later event of the session waits behind the buffered one, and both land once, in order" does not assert the hook. | ✓ CODE (buffered branch covered by the test above) |
| Keyed replay of a stored note (`deduplicated`, 2992) | No (returns first; the original attempt already set the reading) | Code. | ✓ CODE |
| Replay lookup fails (`lookupFailed`, 3173) | No | Code. | ✓ CODE |
| Idempotency refusal (throws, 3054-3055) | No (throws before the append) | Code. | ✓ CODE |

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
| `packages/mcp-server/src/service.ts` | emit reading and hook, planning refresh, `settleDocsLag`, `corpusFreshness` | ✓ VERIFIED | Emit 2988; sync-lag block 3015-3019; hook type 1061; planning refresh 7411-7471; settle 7540; corpus row 7558-7566 |
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
| `service.ts` planning refresh | `planning_page_hashes` store | `loadPlanningHashes` 7459 / `savePlanningHashes` 7471 (flag on) | ✓ WIRED | Off by default (Open Item 2) |
| `event-sources.ts` `docs.sync` | ledger note | `POST /events` (`server.ts` 1358) or MCP `events_emit` (`mcp.ts` 1191) → `Substrate.emit` → sync-lag block 3015-3019 on stored, buffered or deadLettered | ✓ WIRED | Code; stored and buffered covered by tests (hook table) |
| `Substrate.emit` (sync lag set) | gauge `substrate.corpus.sync_lag_seconds` | `observer.syncLag` (`service.ts` 3018) → `observe.ts` 398-400 → `setCorpusSyncLag` (`instruments.ts` 679) | ✓ WIRED | Stored: "a stored sync note sets the gauge…" and the MCP case; buffered: observer array in the buffered test. Dead-lettered: code only (A1). |
| `service.ts` emit held note | buffer drain | `buffered: true` → `EventBuffer` → `drainEventBuffer` (3299) → `deliverBuffered` 3267 | ✓ WIRED | Drain does not call the hook; the buffered test asserts `observed` unchanged after drain |
| `corpusSlo.readings` (sync lag) | `corpusFreshnessRow` | `service.ts` 7566 | ✓ WIRED | Judged against `config.docsSlo.syncLagS` |
| `corpusFreshnessRow` breach | `docs.freshness` warning | `settleDocsLag` 7540 → `LagSettler.settle` → `lagWarningEvent` 317 | ✓ WIRED | Carried |

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
- The sync-lag hook call (`service.ts` 3018) has no catch of its own. Safe on this path (see above), but any future change that lets `recordSyncLag` return a non-finite value would make `emit` reject after the append.

### Deferred Items

None.

### Gaps Summary

No gaps. Criterion 5 holds at 5e304ef8: the reading, the hook and the gauge are unchanged across the window, and the hook runs for stored, buffered and dead-lettered notes (code for all three; tests for stored and buffered). The dead-lettered branch has no test (A1). The keyed-replay case re-applies a held note's lag (A2). Neither changes the verdict on Truth 5 for the stated behaviour. Status stays `human_needed` because the operator install and the live reading are human steps.

### Open Items

1. Operator install of the staged units, timers and hooks (WATCH-03 opt-in, WATCH-04), and the live sync-lag check in Human Verification 2. Not verifier-closable.
2. `SUBSTRATE_PLANNING_HASH_STORE` defaults to `off` (`flag-registry.ts` 882). The prior record carries an owner decision dated 2026-11-05 to keep the default off; it is carried unchanged. Criterion 3 holds with the flag on.
3. Postgres-gated test: `packages/mcp-server/src/planning-hash-store.test.ts`, suite "the Postgres adapter against a live index", testcase "save upserts by path and load reads it back, so a second store object sees what the first wrote". Gate r38 reports it as a testcase with 3 assertions and no skip child. The file has no diff in the window.
4. `docs.sync` is not in `RESERVED_NOTE_ACTIONS` (`reserved-actions.ts` 23-33). Open owner item (A3). No owner decision was recorded on 2026-11-06 for this phase; the status quo stands and nothing in this record treats it as accepted.
5. **Closed at 884e0753 and still closed.** The gauge follows the reading on every route. Re-audited at 5e304ef8: the sync-lag block is unchanged and `server.ts` sets no gauge.
6. `covered_files` now lists 55 entries: the 41 prior entries plus 14 test or source files cited as evidence in this pass (`cli/src/corpus/sync.test.ts`, `cli/src/corpus/watch-commands.test.ts`, `collectors/src/install-git-hook.test.ts`, `corpus/src/coalesce.test.ts`, `corpus/src/mirror.test.ts`, `corpus/src/view.test.ts`, `corpus/src/watch.test.ts`, `mcp-server/src/corpus/reconcile.test.ts`, `mcp-server/src/mcp.ts`, `mcp-server/src/planning-hash-store.test.ts`, `mcp-server/src/reserved-actions.ts`, `mcp-server/src/silent-failures.test.ts`, `mcp-server/src/silent-failures.ts`, `observability/src/recall-metrics.test.ts`). `covered_digest` is the value returned by `gsd_run query verification.fingerprint` at 5e304ef8.
7. Information: the sync-lag reading is the last reported lag and does not age (`corpus/slo.ts` 72-76). If syncs stop, a breach stays until a sync reports within the objective. This matches the phase 70 SLO semantics. A sync breach is not raised while the manifest has never ingested (`corpusFreshnessRow` returns null).
8. Advisory A1 (carried): no test covers the dead-lettered branch of the hook (`service.ts` 3016 with `deadLettered`). Open; not written in this read-only pass.
9. Advisory A2 (carried): a keyed replay of a held or given-up `docs.sync` note (`service.ts` 3168, 3171) re-applies that note's lag. The reading and the gauge can therefore move back to an older lag after a newer note was stored. Reachable only with an `idempotency_key` under `SUBSTRATE_EVENT_IDEMPOTENCY` accept or enforce; the corpus CLI sends no key. Open owner item; no owner decision was recorded on 2026-11-06 for this phase. Not fixed here.

### Owner items open (phase 65)

- A2: keyed replay of a held `docs.sync` note re-applies its lag (open; no decision recorded on 2026-11-06).
- A3: `docs.sync` not in `RESERVED_NOTE_ACTIONS` (open; no decision recorded on 2026-11-06).
- Operator install of staged units, timers and opt-in hooks (WATCH-03, WATCH-04): operator-only; not installed on any host.

### Changed from the prior record (a46d42c3 to 5e304ef8)

- Line references re-checked at 5e304ef8. They match the prior record except where a line is cited above with its new value (the sync-lag block 3015-3019, `observe.ts` 398-400, `server.ts` handoff 1506-1510).
- Test evidence moved from gate r36 to gate r38 (`/root/src/worktrees/backups/gate-r38-junit.xml`). Pass counts removed; only titles are cited.
- Truth 1 and Truth 2: the "8/8" and "20/20" counts from the prior record are removed. Titles cited instead.
- Truth 4: reconcile dry-run and execute gating cited with titles; the catch in `deleteOrphans` now reports to stderr (e62bc17b) and does not change the decision.
- Truth 3: the Postgres testcase is now reported in gate r38 as passing (3 assertions), not as a count from gate r33.
- Session changes checked against the covered set: connect-cooldown (`f1266a9c`, `cache.ts`), memory-retain narrowing (`a2176f96`), CLI handoff exit (`14ac787a`, `cli/src/index.ts`) are not in the covered set and do not touch the criteria; the REST handoff refusal (`14ac787a`, `server.ts` 1506-1510) is in a covered file but on a route that is not the docs.sync path; the stderr reporting (`e62bc17b`) touches `reconcile.ts` only among covered files; the export-keyword commits (`b8cbdeac`, `d9d0a401`, `4c576e5e`, `8ec17832`, `66fa97bd`, `5e304ef8`) carry no behaviour change in the covered set.
- Unrelated covered-file change in the window: `service.ts` `manifestCommit` (`0947001e`, phase 63) at 6420. Not on criteria 1-5.
- Advisories A1 and A2 carried; A3 carried; no new advisory.

### PG counts per file

- `packages/mcp-server/src/planning-hash-store.test.ts`: the Postgres-gated block is `describeLive` (`SUBSTRATE_TEST_PG_URL`). With the variable unset: the gated testcase is skipped. In gate r38 the gated testcase is reported as a passing testcase.
- `scripts/doctor-units.test.ts`, `scripts/sandbox-dropins.test.ts`, `packages/mcp-server/src/service-event-buffer.test.ts`, `packages/mcp-server/src/docs-freshness.test.ts`, `packages/mcp-server/src/corpus/slo.test.ts`, `packages/mcp-server/src/corpus/sync-event.test.ts`, `packages/mcp-server/src/silent-failures.test.ts`, and the corpus, collector and CLI test files named above: no PG gate. Their titles above are gate r38 passes.

### Scope of this pass

HEAD 5e304ef8 (prior record head a46d42c3). Re-audited: `packages/mcp-server/src/service.ts` (`Substrate.emit` 2988-3022; `appendChained` 3150-3242 buffer and replay returns; `bufferEvent` 3248-3260; `deliverBuffered` 3267; `drainPendingEvents` 3311; `planningEvent` 7378; `runPlanningRefresh` 7411; `planningHashStore` 7451; `loadPlanningHashes` 7459; `savePlanningHashes` 7471; `noteDocsCanary` 7043; `settleDocsLag` 7540; `corpusFreshness` 7558-7566), `packages/mcp-server/src/observe.ts` (398-400), `packages/mcp-server/src/server.ts` (`POST /events` 1304-1368; handoff refusal 1506-1510), `packages/mcp-server/src/mcp.ts` (`events_emit` 1191), `packages/mcp-server/src/corpus/slo.ts`, `corpus/sync-event.ts`, `corpus/reconcile.ts`, `docs-freshness.ts`, `event-buffer.ts`, `event-sources.ts`, `flag-registry.ts`, `reserved-actions.ts`, `silent-failures.ts`, `packages/observability/src/instruments.ts`, `packages/cli/src/corpus/events.ts`, `packages/collectors/src/install-git-hook.ts`, `packages/corpus/src/hints.ts`, `mirror.ts`, `view.ts`, `watch.ts`, `coalesce.ts`, and the `infra/vps` units. Test titles were read from the test files at 5e304ef8 and checked against gate r38 JUnit. No file under the worktree was modified; no test, tsc, lint or gate was run.

---

_Verified: 2026-11-06T03:00:21Z_
_Verifier: Claude (gsd-verifier), worker V65, worktree /root/src/worktrees/as-gsd-v18-all, head 5e304ef8_
