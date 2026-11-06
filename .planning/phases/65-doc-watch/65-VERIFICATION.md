---
phase: 65-doc-watch
verified: 2026-11-06T00:45:14Z
status: human_needed
score: 5/5 must-haves verified (success criteria 1-5; SC2 and SC3 against the owner-amended text dated 2026-11-05; SC5 after 884e0753, f0f3c04e and a46d42c3)
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
  - "packages/cli/src/corpus/sync.ts"
  - "packages/cli/src/corpus/watch-commands.ts"
  - "packages/cli/src/corpus/watch-loop.ts"
  - "packages/cli/src/corpus/watch-settings.ts"
  - "packages/collectors/src/install-git-hook.ts"
  - "packages/corpus/src/coalesce.ts"
  - "packages/corpus/src/hints.ts"
  - "packages/corpus/src/mirror.ts"
  - "packages/corpus/src/view.ts"
  - "packages/corpus/src/watch.ts"
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
  - "packages/mcp-server/src/observe.ts"
  - "packages/mcp-server/src/planning-hash-store.ts"
  - "packages/mcp-server/src/server.ts"
  - "packages/mcp-server/src/service-event-buffer.test.ts"
  - "packages/mcp-server/src/service.ts"
  - "packages/observability/src/instruments.ts"
  - "scripts/doctor-units.test.ts"
  - "scripts/sandbox-dropins.test.ts"
covered_digest: "v3:sha256:ae02c2cfee5de017c2888203faf36e1c27c5a96ed83dfa9ff7dd24a603d41b8d"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/5
  previous_head: 884e0753
  reason: "Head a46d42c3. Window 884e0753..a46d42c3 changed six covered files: service.ts (f0f3c04e reportSilent conversions, a46d42c3 dead-code removal), server.ts (f0f3c04e null-body guards, handleMcp close catch), observe.ts (f0f3c04e claim-withdrawal catch), docs-freshness.ts (a46d42c3 removed two unused constants), event-buffer.ts (7a1d923a abandonAll reports held records on stderr), service-event-buffer.test.ts (7a1d923a new test). None of these changes touches the sync-lag reading, the gauge, or the docs.sync row. The sync-lag block in Substrate.emit is textually unchanged. Line references are re-anchored; Truth 5 is re-audited. Two new advisory items (dead-letter branch untested; keyed replay re-applies a held note's lag)."
  gaps_closed: []
  gaps_remaining: []
  regressions: []
gaps: []
deferred: []
advisory:
  - "A1: The dead-lettered branch of the hook (service.ts 3016, `result.deadLettered === true`) has no test that asserts the reading or the observer for a dead-lettered docs.sync note. Code-verified only. No test title in the gate r36 JUnit covers it."
  - "A2: A keyed replay of a held note (service.ts 3168 buffered return, 3171 deadLettered return) passes the held event's own payload to the hook, so the replay re-applies that note's lag. If a newer docs.sync note has been stored meanwhile, the reading and the gauge move back to the older lag. Reachable only for a request that carries idempotency_key under SUBSTRATE_EVENT_IDEMPOTENCY accept or enforce. The corpus CLI sends no idempotency_key for docs.sync. Owner decision needed; not fixed here."
  - "A3 (carried, prior open item 4): `docs.sync` is not in RESERVED_NOTE_ACTIONS (reserved-actions.ts 23-33; file unchanged since 884e0753). Any authenticated caller can set the reading and the gauge."
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: "Install the staged units, the opt-in corpus hooks for chosen repositories, and the timers on the host; run one corpus watch --once and one corpus reconcile dry run"
    expected: "Units start; hints spool under the corpus-hints directory; the reconcile prints a dry-run plan with no writes; a docs.sync note reaches the ledger"
    why_human: "Operator install (WATCH-03 opt-in hooks, WATCH-04 timers). No unit or hook is installed on any host and no live sync was observed in this pass"
  - test: "On a running server, post one docs.sync note with lag_s through POST /events and one through events_emit, then read fabric_status (the corpus row's syncLag) and the substrate.corpus.sync_lag_seconds series. Post one more while the ledger is down so the note is held, then read both again"
    expected: "Each read shows the same lag for the same note, including the held one; the gauge and fabric_status agree at every step"
    why_human: "The agreement is shown by code and by tests at a46d42c3, not by a live server. No live sync-lag reading and no live dashboard were observed in this pass"
---

# Phase 65: Doc Watch Verification Report

**Phase Goal:** When documentation changes in a registered repository, the docs plane follows without anyone running a command, and a restart never re-ingests what has not changed.
**Verified:** 2026-11-06T00:45:14Z
**Head:** a46d42c3 (integration branch gsd/v18-int-all, worktree /root/src/worktrees/as-gsd-v18-all; clean at start of pass)
**Status:** human_needed
**Re-verification:** Yes. Prior record: 884e0753, human_needed, 5/5. This pass re-audits the sync-lag path after the emit-adjacent changes in f0f3c04e (reportSilent) and the other covered-file changes in the window 884e0753..a46d42c3. No test was run (read-only assignment). Test titles were checked as testcases in `/root/src/worktrees/backups/gate-r36-junit.xml` (12,317 testcases, 0 failures, 0 errors, 2 skipped).

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `corpus sync --repo R` plans and ingests only R; `corpus watch` debounces and coalesces a burst into one sync per repository | ✓ VERIFIED (carried) | `packages/corpus/src/coalesce.ts`, `watch.ts`, `packages/cli/src/corpus/sync.ts`, `watch-commands.ts`, `watch-loop.ts`: none in the window (41-file covered diff, `git diff --stat 884e0753 a46d42c3`, lists only the six files in the re-verification reason). Carried from the 884e0753 record (6e5d766e run, no diff since): `coalesce.test.ts` 8/8, `watch.test.ts` 8/8, `watch-commands.test.ts` 20/20. Gate r36 testcases (no child element): "a dry run sends nothing to the plane and emits no event", "a dry run plans only the named repository, with coverage for it alone, and sends nothing else" (`sync.test.ts`, `watch-commands.test.ts`). |
| 2 | (amended) Default triggers write nothing into any repository; the git hooks are an opt-in installer adding post-merge, post-checkout and post-rewrite hints beside the post-commit collector; a hook writes a bounded hint `{v, dir, at}` with no action name, always exits 0, and never overwrites a foreign hook | ✓ VERIFIED (amended text, carried) | `packages/collectors/src/install-git-hook.ts` and `packages/corpus/src/hints.ts` have no diff in the window. `CORPUS_HOOKS` at line 150; background block 170–190 ends `return 0`; `writeHint` at `hints.ts` 107. |
| 3 | (amended) The server's planning refresh keeps its state in `planning_page_hashes`, not the manifest, so a restart re-ingests nothing unchanged (test with two server instances over one store) | ✓ VERIFIED (amended text; flag on, carried) | `service.ts` `runPlanningRefresh` 7411; `planningHashStore()` 7451 (moved from 7427, +24 from the window's edits above it); `loadPlanningHashes` 7459; `savePlanningHashes` 7471. No hunk falls inside 7387–7432 of the 884e0753 numbering, so the body is unchanged. `planning-hash-store.ts` has no diff. Migration step 39 (`index-store.ts`) unchanged. |
| 4 | Units `substrate-corpus-watch.service`, `substrate-corpus-sync.service` and `substrate-corpus-sync.timer` are staged with Nice, idle I/O, CPUQuota and MemoryMax; the watcher drops to sweep-only at the inotify limit; `corpus reconcile` reports a missing row and re-ingests only with `--execute`; reconcile fetches a managed mirror and reads its default-branch tree; one view per repository per sync | ✓ VERIFIED (staged, not installed, carried) | `infra/vps/*` and `packages/corpus/src/mirror.ts`, `view.ts`: no diff in the window. Units: `Nice=15`, `IOSchedulingClass=idle`, `CPUQuota=25%`, `MemoryMax=512M`, `ProtectHome=read-only` (watch 54, sync 39, reconcile 42). |
| 5 | Each sync emits a `docs.sync` note (event-sources row, vocabulary lock unchanged) and a lag metric; a breach raises the existing `docs.freshness` warning | ✓ VERIFIED (re-audited at a46d42c3; the reading, the hook and the gauge are unchanged; the hook runs for stored, buffered and dead-lettered notes, see the hook table) | **Note:** `event-sources.ts` row `docs.sync` at 1551–1555 (unchanged). `packages/cli/src/corpus/events.ts` line 51 emits `lag_s: sync.lagS`. **Reading:** `corpus/sync-event.ts` `syncLagSeconds` 17–25 (unchanged; returns null or a whole number in [0, 31536000]); `corpus/slo.ts` `recordSyncLag` 72–76 and `readings` 79 (unchanged file). **Hook and gauge:** `service.ts` `Substrate.emit` 2988; sync-lag block 3015–3019 (`if` at 3016, `recordSyncLag` at 3017, `observer.syncLag` at 3018); hook type 1061; `observe.ts` 399–401 maps it to `instruments.setCorpusSyncLag` (400); `instruments.ts` 679–682 sets the gauge; metric name `CORPUS_SYNC_LAG_METRIC` 734 = `substrate.corpus.sync_lag_seconds`. **Warning:** `service.ts` `corpusFreshness` 7558 reads `corpusSlo.readings(now).syncLagS` (call at 7566); `docs-freshness.ts` `corpusFreshnessRow` 169 judges it at 178–179; `settleDocsLag` 7540 settles through `lagWarningEvent` 317 / `lagRecoveryEvent` 360. The `docs.freshness` breach path is unchanged. |

**Score:** 5/5 truths verified (0 partial, 0 failed); behavior_unverified 0

### Re-verification of the sync-lag path (884e0753..a46d42c3)

**Scope of the window for covered files.** `git diff --stat 884e0753 a46d42c3 -- <the 41 covered files>` lists six files: `service.ts`, `server.ts`, `observe.ts`, `docs-freshness.ts`, `event-buffer.ts`, `service-event-buffer.test.ts`. The changing commits are `f0f3c04e`, `a46d42c3` and `7a1d923a`. Other window commits (`c371cece`, `9b793653`, `e3914640`, `e958e8b1`, `885e73ce`) touch no covered file.

| Changed file (window) | Commit | Sync-lag reading, gauge or docs.sync row touched? | Result |
| --- | --- | --- | --- |
| `service.ts` `Substrate.emit` 2988–3022 | f0f3c04e | No. The `deduplicated` return (2992–2997), the sync-lag block (3015–3019) and the `emitted`/`eventReplay` calls are textually identical to 884e0753. The f0f3c04e hunk nearest the emit body is the `publishHint` catch (3033), which runs after the hook. | Confirmed unchanged |
| `service.ts` `appendChained`, `bufferEvent`, `deliverBuffered`, `drainPendingEvents` | f0f3c04e, a46d42c3 | No hunk in these ranges. The only buffer-related change is the `EventBuffer` constructor option `deadLetters` (2121–2123), which is not a branch. | Confirmed unchanged |
| `service.ts` `corpusFreshness`, `settleDocsLag`, `runPlanningRefresh` | a46d42c3 (none here) | No hunk in 884e0753 numbering 7387–7552. Moved +24 by the edits above. | Confirmed unchanged |
| `service.ts` docs telemetry retention sweep (884e0753 6583–6609), `queryEventsFor` (6845), lease expiry (7601), handover release (7762) | f0f3c04e, a46d42c3 | Not on the path (retention sweep, repo refusal, lease expiry, handover release). | Not related |
| `server.ts` `POST /events` 1304–1368 | f0f3c04e (hunks at 1211, 1497, 1582, 1617, 2776 only) | No. The handler still calls `substrate.emit` at 1358 and answers `result.stored ? 202 : 503` at 1368. | Confirmed unchanged |
| `server.ts` `handleMcp` close | f0f3c04e | Not on the path. | Not related |
| `observe.ts` import (69) and `recordClaimWithdrawal` catch (~429) | f0f3c04e | No. `syncLag` (399–401) and the `instruments.setCorpusSyncLag` call are unchanged. | Confirmed unchanged |
| `docs-freshness.ts` lines 28–33 | a46d42c3 | Two unused constants removed (`DEFAULT_FRESHNESS_MAX_AGE_H`, `DEFAULT_TRIGGER_LAG_MIN`). Grep finds no remaining reference. `corpusFreshnessRow` (169) is unchanged. | Confirmed unchanged for this path |
| `event-buffer.ts` `abandonAll` 327, `reportHeldDeadLetters` 347 | 7a1d923a | No. Adds a stderr report of held dead-letter records at shutdown (identifiers only). Does not call the observer and does not change the reading. | Not on the reading path |
| `service-event-buffer.test.ts` | 7a1d923a | Adds one test (234). Line 115 test body is unchanged. | Evidence only |

**Result: the docs.sync reading, the gauge and the docs.sync row are unchanged across the window. The sync-lag block in `Substrate.emit` is unchanged. The hook runs for the same three outcomes as at 884e0753.**

**reportSilent.** f0f3c04e changed no statement inside `Substrate.emit` or the sync-lag block. The sync-lag hook itself is not wrapped in `reportSilent` and has no catch, and the record does not claim it is. It cannot throw on this path: `recordSyncLag` returns null or a whole number of seconds in [0, 31536000] (`sync-event.ts` 17–25), and `setCorpusSyncLag` also drops a non-finite or negative value (`instruments.ts` 680). The emit neighbours that f0f3c04e converted are `publishHint` (`emit.bus-hint`, 3033) and the callers of `emit` (for example `emit.steering-session` 2253, `emit.retain-warning` 3606, `emit.mirror-failed` 5514). Two `.catch(() => …)` sites inside the emit path remain: `ensureAppendMode().catch(() => null)` at 3196 and 3271. Each turns a probe failure into an `APPEND_MODE_UNKNOWN` error result that the reply reports, so no rejection is dropped. `hasEvent(…).catch(() => false)` at 3463 belongs to a memory trust read, not to `emit`.

**`planningEvent` and `noteDocsCanary` cannot skip the hook for a `docs.sync` note.** Both run before the sync-lag block. `planningEvent` (7378) returns at once for any action beginning `docs.`. `noteDocsCanary` (7043) returns unless the surface and action are the canary pair. Neither can throw for this note.

### Hook coverage by branch (HEAD a46d42c3)

| Branch of `emit` / `appendChained` | Reading and gauge set? | Evidence | Status |
| --- | --- | --- | --- |
| Stored, REST `POST /events` (`stored: true`, 202) | Yes (3016 `result.stored`) | `sync-event.test.ts` "a stored sync note sets the gauge to its lag, and the newest one wins" (POST /events suite) | ✓ TEST |
| Stored, MCP `events_emit` (`mcp.ts` 1191) | Yes | `sync-event.test.ts` "an MCP events_emit of a stored sync note sets the same gauge, and the reply reports it stored" | ✓ TEST |
| Not stored, buffer off (`stored: false`, 503; `service.ts` 3236) | No (not in the condition) | `sync-event.test.ts` "a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone" | ✓ TEST |
| Buffered at write (`bufferEvent` 3259, `buffered: true`) | Yes (3016 `result.buffered`) | `service-event-buffer.test.ts` "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back" (line 115): reading 4000 and `observed` `[4000]` before the drain | ✓ TEST |
| Buffered, then drained to the ledger (`deliverBuffered` 3267) | No (the drain never calls the hook) | Same test: `observed` still `[4000]` after `drainEventBuffer` | ✓ TEST |
| Dead-lettered at enqueue (`bufferEvent` 3255, `deadLettered: true`) | Yes (3016 `result.deadLettered`) | Code only. No test asserts the reading or the observer for a dead-lettered `docs.sync` note. | ⚠ CODE ONLY (advisory A1) |
| Keyed replay of a queued note (`waiting`, 3168, `buffered: true`) | Yes, with the held note's payload (advisory A2) | Code only for the hook. "a keyed replay of a queued event answers that event and writes nothing" (line 183) asserts no append, not the hook. | ⚠ CODE ONLY (advisory A2) |
| Keyed replay of a given-up note (`given`, 3171, `deadLettered: true`) | Yes, with the given-up note's payload (advisory A2) | Code only. "a keyed replay of a pending give-up is refused as a give-up, not answered as buffered, and appends nothing" (line 391) asserts no hook. | ⚠ CODE ONLY (advisory A2) |
| Waits behind an earlier buffered event of the session (3207, `buffered: true`) | Yes | Code. "a later event of the session waits behind the buffered one, and both land once, in order" (line 97) does not assert the hook. | ✓ CODE (buffered branch covered by line 115) |
| Keyed replay of a stored note (`deduplicated`, 2992) | No (returns first; the original attempt already set the reading) | Code. | ✓ CODE |
| Replay lookup fails (`lookupFailed`, 3173) | No | Code. | ✓ CODE |
| Idempotency refusal (throws, 3054–3055) | No (throws before the append) | Code. | ✓ CODE |

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `infra/vps/substrate-corpus-watch.service` | staged watcher, idle I/O, limits, read-only home | ✓ VERIFIED | `ProtectHome=read-only` at 54; no diff in the window |
| `infra/vps/substrate-corpus-sync.service` | staged sweep unit | ✓ VERIFIED | `ProtectHome=read-only` at 39 |
| `infra/vps/substrate-corpus-reconcile.service` | staged dry-run unit | ✓ VERIFIED | `ProtectHome=read-only` at 42; dry run unless `--execute` |
| `infra/vps/substrate-corpus-sync.timer` / `…-reconcile.timer` | staged timers | ✓ VERIFIED | Not installed |
| `…-reconcile.service.d/30-sandbox.conf.example` | class A drop-in example | ✓ VERIFIED | Example only |
| `packages/collectors/src/install-git-hook.ts` | opt-in hook installer | ✓ VERIFIED | `CORPUS_HOOKS` 150; background block 170–190 |
| `packages/corpus/src/hints.ts` | bounded hint spool | ✓ VERIFIED | `writeHint` 107 |
| `packages/corpus/src/view.ts`, `mirror.ts` | mirror tree read | ✓ VERIFIED | No diff in the window |
| `packages/corpus/src/watch.ts`, `coalesce.ts` | watcher and coalescer | ✓ VERIFIED | No diff in the window |
| `packages/mcp-server/src/docs-freshness.ts` | corpus sync-lag breach in the docs.freshness warning | ✓ VERIFIED | `corpusFreshnessRow` 169; `lagWarningEvent` 317; `lagRecoveryEvent` 360 (two unused constants removed in a46d42c3) |
| `packages/mcp-server/src/service.ts` | emit reading and hook, planning refresh, `settleDocsLag`, `corpusFreshness` | ✓ VERIFIED | Emit 2988; sync-lag block 3015–3019; hook type 1061; planning refresh 7411–7471; settle 7540; corpus row 7558 |
| `packages/mcp-server/src/corpus/slo.ts` | sync-lag reading | ✓ VERIFIED | `recordSyncLag` 72–76; `readings` 79 (unchanged file) |
| `packages/mcp-server/src/corpus/sync-event.ts` | reading parser | ✓ VERIFIED | `syncLagSeconds` 17–25 (unchanged file) |
| `packages/mcp-server/src/observe.ts` | production observer | ✓ VERIFIED | `syncLag` → `instruments.setCorpusSyncLag` at 399–401 |
| `packages/mcp-server/src/server.ts` | REST `POST /events` | ✓ VERIFIED | Calls `substrate.emit` at 1358; 202/503 at 1368; no gauge write |
| `packages/mcp-server/src/event-buffer.ts` | buffer that holds a note the ledger did not take | ✓ VERIFIED | `abandonAll` 327; `reportHeldDeadLetters` 347 (a46d42c3 stderr report, not on the reading path) |
| `packages/mcp-server/src/flag-registry.ts` | flag text for `SUBSTRATE_CORPUS_FRESH_MAX_AGE_S`, `SUBSTRATE_PLANNING_HASH_STORE`, `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` | ✓ VERIFIED | Unchanged in the window; `SUBSTRATE_PLANNING_HASH_STORE` default `off` |
| `packages/mcp-server/src/event-sources.ts` | `docs.sync` and `docs.planning` rows | ✓ VERIFIED | `docs.sync` at 1551; unchanged |
| `packages/mcp-server/src/planning-hash-store.ts` | planning state adapter | ✓ VERIFIED | Table `planning_page_hashes`; no diff |
| `packages/observability/src/instruments.ts` | lag gauge | ✓ VERIFIED | `setCorpusSyncLag` 679–682; `CORPUS_SYNC_LAG_METRIC` 734; unchanged file |
| `packages/cli/src/corpus/events.ts` | docs.sync note payload | ✓ VERIFIED | `lag_s: sync.lagS` at 51; no diff |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `watch-commands.ts` | `runSync` | `repos: [R]` | ✓ WIRED | Carried from 884e0753 (no diff) |
| `install-git-hook.ts` | `corpus hint` | background `timeout 10` block, `return 0` | ✓ WIRED | Carried |
| `hints.ts` | spool read by the watch loop | `readHints` | ✓ WIRED | Carried |
| `service.ts` planning refresh | `planning_page_hashes` store | `loadPlanningHashes` 7459 / `savePlanningHashes` 7471 (flag on) | ✓ WIRED | Off by default (Open Item 2) |
| `event-sources.ts` `docs.sync` | ledger note | `POST /events` (`server.ts` 1358) or MCP `events_emit` (`mcp.ts` 1191) → `Substrate.emit` → sync-lag block 3015–3019 on stored, buffered or deadLettered | ✓ WIRED | Code; stored and buffered covered by tests (hook table) |
| `Substrate.emit` (sync lag set) | gauge `substrate.corpus.sync_lag_seconds` | `observer.syncLag` (`service.ts` 3018) → `observe.ts` 399–401 → `setCorpusSyncLag` (`instruments.ts` 679) | ✓ WIRED | Stored: "a stored sync note sets the gauge…" and the MCP case; buffered: observer array in line 115 test. Dead-lettered: code only (A1). |
| `service.ts` emit held note | buffer drain | `buffered: true` → `EventBuffer` → `drainEventBuffer` (3299) → `deliverBuffered` 3267 | ✓ WIRED | Drain does not call the hook; test line 115 asserts `observed` unchanged after drain |
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
| Gate r36 JUnit contains every test title relied on below as a testcase with no `failure`, `error` or `skipped` child, and each enclosing suite reports `failures="0" skipped="0"` (`the telemetry buffer`, `POST /events with a docs.sync note`, `syncLagSeconds`, `silent-failures.test.ts`) | JUnit parse of `/root/src/worktrees/backups/gate-r36-junit.xml` | All present, none failing or skipped (list below) | ✓ JUNIT |
| Covered-digest computed at HEAD over the 41 covered files | `gsd_run query verification.fingerprint .planning/phases/65-doc-watch <41 files>` run from the worktree | `v3:sha256:7911674a0fe4fcec397cf93ed83c55965af29ac6f21a0110718cf89821fe0e84` | ✓ COMPUTED |

**Test titles relied on (each a testcase in gate r36 with no child element):**

- `service-event-buffer.test.ts`, suite "the telemetry buffer": "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back"; "a failed write is buffered, not dropped, and lands once the ledger is back"; "a later event of the session waits behind the buffered one, and both land once, in order"; "a keyed replay of a queued event answers that event and writes nothing"; "a write that exhausts its budget is dead-lettered with its hash and its reason"; "a service that shuts down while a dead-letter file cannot be written reports each held record on stderr, and no summary text"
- `service-event-buffer.test.ts`, suite "the telemetry buffer's refusals, replays and config": "a keyed replay of a pending give-up is refused as a give-up, not answered as buffered, and appends nothing"
- `corpus/sync-event.test.ts`, suite "POST /events with a docs.sync note": "a stored sync note sets the gauge to its lag, and the newest one wins"; "a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone"; "an MCP events_emit of a stored sync note sets the same gauge, and the reply reports it stored"
- `corpus/sync-event.test.ts`, suite "syncLagSeconds": "reads a whole number of seconds from a docs.sync payload, rounding a fraction"; "reads nothing from any other action, a missing or non-numeric lag, a negative or non-finite one, or a payload that is not an object"; "a lag past a year is clamped to it, so one note cannot make the series meaningless"
- `silent-failures.test.ts`: "reports a token code once for a site"; "the message text never appears in the output"; "a second call for the same site writes nothing"; "a non-object error reports its typeof"

Not cited, because no testcase in gate r36 covers it: a dead-lettered `docs.sync` note's reading or observer call (advisory A1), and a keyed replay's effect on the reading (advisory A2).

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

- `packages/collectors/src/install-git-hook.ts` lines 37, 155: `*_PLACEHOLDER` tokens are template substitution, not stubs (carried).
- `packages/mcp-server/src/reserved-actions.ts` 23–33: `docs.sync` is not reserved (advisory A3; file unchanged since 884e0753).
- The sync-lag hook call (`service.ts` 3018) has no catch of its own. Safe on this path (see above), but any future change that lets `recordSyncLag` return a non-finite value would make `emit` reject after the append.

### Deferred Items

None.

### Gaps Summary

No gaps. Criterion 5 holds at a46d42c3: the reading, the hook and the gauge are unchanged across the window, and the hook runs for stored, buffered and dead-lettered notes (code for all three; tests for stored and buffered). The dead-lettered branch has no test (A1). The keyed-replay case re-applies a held note's lag (A2). Neither changes the verdict on Truth 5 for the stated behaviour. Status stays `human_needed` because the operator install and the live reading are human steps.

### Open Items

1. Operator install of the staged units, timers and hooks (WATCH-03 opt-in, WATCH-04), and the live sync-lag check in Human Verification 2. Not verifier-closable.
2. `SUBSTRATE_PLANNING_HASH_STORE` defaults to `off` (`flag-registry.ts` 882). Owner decision 2026-11-05: keep the default off. Criterion 3 holds with the flag on.
3. Postgres-gated test: `packages/mcp-server/src/planning-hash-store.test.ts`, suite "the Postgres adapter against a live index", testcase "save upserts by path and load reads it back, so a second store object sees what the first wrote". Cited from gate r33 JUnit (`gate-r33-junit.xml`, suite `tests="8" failures="0" skipped="0"`). No Postgres run in this pass. The file has no diff in the window.
4. `docs.sync` is not in `RESERVED_NOTE_ACTIONS` (`reserved-actions.ts` 23–33). Owner decision recorded as "reservation held", so the status quo stands (advisory A3).
5. **Closed at 884e0753 and still closed.** The gauge follows the reading on every route. Re-audited at a46d42c3: the sync-lag block is unchanged and `server.ts` sets no gauge.
6. `covered_files` unchanged (41 entries). `covered_digest` recomputed at HEAD a46d42c3 with `gsd_run query verification.fingerprint`, because six covered files changed in the window.
7. Information: the sync-lag reading is the last reported lag and does not age (`corpus/slo.ts` 72–76). If syncs stop, a breach stays until a sync reports within the objective. This matches the phase 70 SLO semantics. A sync breach is not raised while the manifest has never ingested (`corpusFreshnessRow` returns null).
8. Advisory A1 (new): no test covers the dead-lettered branch of the hook (`service.ts` 3016 with `deadLettered`). A test that posts a `docs.sync` note with the buffer's give-up path and asserts `syncLagS` and the observer would close it. Not written here (read-only assignment).
9. Advisory A2 (new): a keyed replay of a held or given-up `docs.sync` note (`service.ts` 3168, 3171) re-applies that note's lag. The reading and the gauge can therefore move back to an older lag after a newer note was stored. Reachable only with an `idempotency_key` under `SUBSTRATE_EVENT_IDEMPOTENCY` accept or enforce; the corpus CLI sends no key. Decide whether a replay should set the reading (for example, only on first buffering). Not fixed here.

### PG counts per file

- `packages/mcp-server/src/planning-hash-store.test.ts`: the Postgres-gated block is `describeLive` (`SUBSTRATE_TEST_PG_URL`). With the variable unset: 7 pass and 3 skipped entries. With the URL set in the gate r33 run: 8 of 8 pass.
- `scripts/doctor-units.test.ts`, `scripts/sandbox-dropins.test.ts`, `packages/mcp-server/src/service-event-buffer.test.ts`, `event-buffer.test.ts`, `docs-freshness.test.ts`, `corpus/slo.test.ts`, `corpus/sync-event.test.ts`, `silent-failures.test.ts`: no PG gate. Their titles above are gate r36 passes.

### Scope of this pass

HEAD a46d42c3 (prior record head 884e0753). Re-audited: `packages/mcp-server/src/service.ts` (`Substrate.emit` 2988–3022; `appendChained` 3150–3242 buffer and replay returns; `bufferEvent` 3248–3260; `deliverBuffered` 3267; `drainPendingEvents` 3311; `corpusFreshness` 7558; `settleDocsLag` 7540; `planningEvent` 7378; `noteDocsCanary` 7043), `packages/mcp-server/src/observe.ts` (399–401), `packages/mcp-server/src/server.ts` (`POST /events` 1304–1368), `packages/mcp-server/src/mcp.ts` (`events_emit` 1191), `packages/mcp-server/src/corpus/slo.ts`, `corpus/sync-event.ts`, `docs-freshness.ts`, `event-buffer.ts`, `silent-failures.ts`, `packages/observability/src/instruments.ts`, `packages/cli/src/corpus/events.ts`. Test titles were read from the test files at HEAD and checked in the gate r36 JUnit. No test, build, lint or Postgres run was made. No file under the worktree was written.

---

_Verified: 2026-11-06T00:45:14Z_
_Verifier: Claude (gsd-verifier), worker V65, worktree /root/src/worktrees/as-gsd-v18-all, head a46d42c3_
