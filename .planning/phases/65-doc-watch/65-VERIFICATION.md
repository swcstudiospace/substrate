---
phase: 65-doc-watch
verified: 2026-11-05T08:43:31Z
status: human_needed
score: 5/5 must-haves verified (success criteria 1-5; SC2 and SC3 against the owner-amended text dated 2026-11-05; SC5 after 42dcb4c6, b4bdd0fc and 884e0753)
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
covered_digest: "v3:sha256:6f4e85716d7415bea1f0a59562571509a754aa77fec40297244b0df17a333289"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/5
  previous_head: 6e5d766e
  reason: "Head 884e0753 (W-1, phase 70). The change that touches phase 65 claims is the sync-lag gauge. Before: server.ts POST /events set substrate.corpus.sync_lag_seconds only for a stored note (6e5d766e server.ts 1362-1363), so the gauge and the in-process reading differed for a held or dead-lettered note (prior Open Item 5). After: Substrate.emit (service.ts 3005-3011) sets the reading and calls the new observer hook syncLag (service.ts 1059-1060) in the same branch; observe.ts 398-400 maps the hook to setCorpusSyncLag; the REST block and its import are deleted from server.ts. Prior Open Item 5 is closed by this change. Rows that cited server.ts 1362-1363 or said the gauge was stored-only are rewritten. Files added to covered_files because the change or its docs/tests cite them: corpus/slo.ts, corpus/slo.test.ts, corpus/sync-event.test.ts, observe.ts, server.ts, docs/corpus-eval.md, docs/runbooks/docs-rag-operations.md. Other commits in 6e5d766e..HEAD (403e45f7, bb6b38b7 docs and comments; c71a539d, aef8a351 verification records) touch no file in the covered list. aef8a351 did not refresh this record; this pass does. service.ts anchors after line 3006 moved by +5 between 6e5d766e and 884e0753 (planning refresh 7382 -> 7387); the commit message says two lines, the anchors here were measured at HEAD."
  gaps_closed: []
  gaps_remaining: []
  regressions: []
gaps: []
deferred: []
advisory: []
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: "Install the staged units, the opt-in corpus hooks for chosen repositories, and the timers on the host; run one corpus watch --once and one corpus reconcile dry run"
    expected: "Units start; hints spool under the corpus-hints directory; the reconcile prints a dry-run plan with no writes; a docs.sync note reaches the ledger"
    why_human: "Operator install (WATCH-03 opt-in hooks, WATCH-04 timers). No unit or hook is installed on any host and no live sync was observed in this pass"
  - test: "On a running server, post one docs.sync note with lag_s through POST /events and one through events_emit, then read fabric_status (the corpus row's syncLag) and the substrate.corpus.sync_lag_seconds series. Post one more while the ledger is down so the note is held, then read both again"
    expected: "Each read shows the same lag for the same note, including the held one; the gauge and fabric_status agree at every step"
    why_human: "The agreement is shown by code and by tests at 884e0753, not by a live server. No live sync-lag reading and no live dashboard were observed in this pass"
---

# Phase 65: Doc Watch Verification Report

**Phase Goal:** When documentation changes in a registered repository, the docs plane follows without anyone running a command, and a restart never re-ingests what has not changed.
**Verified:** 2026-11-05T08:43:31Z
**Head:** 884e0753 (integration branch gsd/v18-int-all, worktree /root/src/worktrees/as-gsd-v18-all)
**Status:** human_needed
**Re-verification:** Yes. Prior record: 6e5d766e, human_needed, 5/5. This pass re-audits the sync-lag path changed by 884e0753 (the gauge now follows the reading through `Substrate.emit`), re-anchors every line reference in the record, and closes prior Open Item 5. Criteria 2 and 3 are judged against the owner-amended text (wording unchanged; amendment date 2026-11-05). Criterion 5 is judged after 42dcb4c6, b4bdd0fc and 884e0753. Tests: no test was run in this pass. The targeted non-Postgres results and the mutation check at 884e0753 are the ones the main agent reported; the test titles cited below are read from the test files at HEAD.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `corpus sync --repo R` plans and ingests only R; `corpus watch` debounces and coalesces a burst into one sync per repository | ✓ VERIFIED | `packages/corpus/src/coalesce.ts` (trailing debounce, maximum wait, one running sync per repository); `watch.ts` marks repositories dirty and reads nothing. Run 2 at 6e5d766e (carried; these files have no diff at 884e0753): `coalesce.test.ts` 8/8, `watch.test.ts` 8/8, `watch-loop.test.ts`, `sync.test.ts`, `watch-commands.test.ts` 20/20 (`substrate corpus sync` 7, `substrate corpus watch --once` 3) all pass. Gate JUnit names "a dry run sends nothing to the plane and emits no event" (`sync.test.ts`, line 14480 of `gate-r33-junit.xml`, not skipped) and "a dry run plans only the named repository, with coverage for it alone, and sends nothing else" (`watch-commands.test.ts`) |
| 2 | (amended) Default triggers write nothing into any repository; the git hooks are an opt-in installer adding post-merge, post-checkout and post-rewrite hints beside the post-commit collector; a hook writes a bounded hint `{v, dir, at}` with no action name, always exits 0, and never overwrites a foreign hook | ✓ VERIFIED (amended text) | `install-git-hook.ts` line 150: `CORPUS_HOOKS = post-merge, post-checkout, post-rewrite`; the marked block (lines 170–190) runs `timeout 10 "$@" corpus hint --repo "$top"` in the background by default (in the foreground only under `SUBSTRATE_HOOK_WAIT=1`, the test seam) and ends `return 0`; a foreign hook is refused and left alone. `hints.ts` `writeHint` (line 107) writes `{v, dir, at}`. Run 2 at 6e5d766e (carried): `install-git-hook.test.ts` 24/24 (including "the installed hook runs the hint command for the repository's top level, in the foreground under SUBSTRATE_HOOK_WAIT, and exits 0 whatever the command does"), `hints.test.ts` 10/10, `watch-commands.test.ts` "substrate corpus hook" 3/3 and "the default triggers are read-only toward every repository" 1/1 |
| 3 | (amended) The server's planning refresh keeps its state in `planning_page_hashes`, not the manifest, so a restart re-ingests nothing unchanged (test with two server instances over one store) | ✓ VERIFIED (amended text; flag on) | `service.ts` `runPlanningRefresh` 7387–7421: `loadPlanningHashes` (7393), `planningIngestTrigger` (7394), `savePlanningHashes` (7410). `planningHashStore()` 7427–7432 returns the index's `planning_page_hashes` store when `SUBSTRATE_PLANNING_HASH_STORE` is on and memory otherwise. Migration step 39 creates `planning_page_hashes` (`index-store.ts`); `planning-hash-store.ts` holds the port, the memory adapter and the Postgres adapter. Run 2 at 6e5d766e (carried; `planning-hash-store.test.ts` has no diff at 884e0753): 10 entries, 7 pass, 3 skipped with the URL unset: "a second server over the same store ingests nothing unchanged, and exactly the changed page after an edit", "a page the plane failed is not stored, so the next process sends it again and only it", "with the flag off nothing is read or written: a restart ingests every page again and the store stays empty" and "a store that cannot be read costs one full ingest and the pass still completes" all pass. Note: the two-server test runs over the memory adapter; the Postgres leg is the store round trip (see Postgres section). Default is off (`flag-registry.ts` 882, owner decision: keep the default off), so the restart guarantee holds with the flag on |
| 4 | Units `substrate-corpus-watch.service`, `substrate-corpus-sync.service` and `substrate-corpus-sync.timer` are staged with Nice, an idle I/O class, CPUQuota and MemoryMax; the watcher drops to sweep-only at the inotify limit; `corpus reconcile` reports a missing row and re-ingests only with `--execute`; reconcile fetches a managed mirror and reads its default-branch tree; one view per repository per sync | ✓ VERIFIED (staged, not installed) | Units: all three base units carry `Nice=15`, `IOSchedulingClass=idle`, `CPUQuota=25%`, `MemoryMax=512M`, and `ProtectHome=read-only` (watch line 54, sync line 39, reconcile line 42; the unit files have no diff since 835a2742). Sweep-only fallback: `watch.test.ts` "the inotify limit closes every watch and leaves the command in sweep-only mode" and "EMFILE counts as the limit too, and a limit error raised later by a live watch degrades the watcher" pass (run 2 at 6e5d766e). **WATCH-04 reconcile dry run:** `watch-commands.test.ts` "a dry run plans, reports the drift and the problems, and repairs nothing" (3/3 "substrate corpus reconcile" pass in run 2; gate JUnit line 14825, not skipped) and `reconcile.test.ts` "a dry run reports the missing row and the orphan and changes nothing" (gate JUnit line 17525, not skipped; the file passes in run 1 at 6e5d766e, which also covers "execute marks the missing row removed without calling the plane, deletes the orphan …"). Mirror and view: `view.test.ts` "shows a remote-only push although the checkout did not move, and writes nothing into the checkout", "alternating local edits and remote pushes without pulling never flips a path that did not change", "a failed fetch changes nothing and keeps reading the stale mirror; recovery brings the push in" (gate JUnit lines 3034, 3037, 3038; `view.test.ts` 16/16 in run 2); `mirror.test.ts` "a failed fetch leaves the mirror as it was and says stale; recovery fetches again" (gate JUnit line 3154; `mirror.test.ts` 16/16 in run 2). **ProtectHome:** `scripts/sandbox-dropins.test.ts` "corpus units" (run 2: 1/1; the gate JUnit names "the three corpus units ship ProtectHome=read-only in the base unit file, not only in their class A drop-ins", line 453, and "Class B keeps ProtectHome=false; Class A is read-only home; both end up with ProtectSystem=strict", line 452) |
| 5 | Each sync emits a `docs.sync` note (event-sources row, vocabulary lock unchanged) and a lag metric; a breach raises the existing `docs.freshness` warning | ✓ VERIFIED (re-anchored at 884e0753; the gauge follows the reading on every route) | **Note:** `event-sources.ts` row `docs.sync` (line 1551, action `docs.sync`); `cli/corpus/events.ts` line 51 emits `lag_s: sync.lagS`; lag is measured from the first change signal to the end of the sync (`cli/corpus/sync.ts` line 312). **Reading and gauge, one site:** `service.ts` `Substrate.emit` lines 3005–3011: `corpusSlo.recordSyncLag(result.event.payload)` runs when `result.stored`, `result.buffered === true` or `result.deadLettered === true` (the comment is on 3005), and returns `seconds` from `recordSyncLag`; only a non-null lag calls `this.observer.syncLag?.({ seconds })` (3010). A note the server did not take never reaches that branch, so the reading is unchanged. `corpus/slo.ts` `recordSyncLag` (72–76) keeps the last `lag_s` and returns the lag it recorded, or null. The hook is declared at `service.ts` 1059–1060 (`SubstrateObserver.syncLag`). The production observer maps it at `observe.ts` 398–400 to `instruments.setCorpusSyncLag`; the setter is `observability/src/instruments.ts` 679–681 and the gauge name is `CORPUS_SYNC_LAG_METRIC` (734, `substrate.corpus.sync_lag_seconds`). **No route sets the gauge any more:** the REST block in `server.ts` (the `syncLagSeconds` import and the stored-only `setCorpusSyncLag` call at 6e5d766e 1362–1363) is deleted at 884e0753; `POST /events` (`server.ts` 1352) and MCP `events_emit` (`mcp.ts` 1190) both call `substrate.emit`, so every route sets the reading and the gauge in the same place. A keyed replay of a held or dead-lettered note returns the original buffered event (`service.ts` 3160, 3163), so the reading takes that event's lag, not the replay's. **Asymmetry closed:** a held note and a dead-lettered note reach the same branch (3008) as a stored one, so the reading and the gauge move together; the drain does not re-run this branch (`deliverBuffered`, 3259, does not call `recordSyncLag`), so both stay put when the held note lands. **Breach:** `docs-freshness.ts` `corpusFreshnessRow` (175) adds `sync_lag` when the newest lag is strictly over `syncLagMaxS` (185–188); `lagWarningEvent` (323) emits `kind: warning`; `service.ts` `settleDocsLag` 7516–7526 and `corpusFreshness` 7534–7557 (reading passed as `this.corpusSlo.readings(now).syncLagS`, line 7542). **Tests** (titles as they appear in the files at HEAD; results as reported by the main agent at 884e0753, not re-run here): `corpus/sync-event.test.ts`, describe "POST /events with a docs.sync note": "a stored sync note sets the gauge to its lag, and the newest one wins"; "a note the ledger did not store, another action, or a lag that is not a number leaves the gauge alone"; "an MCP events_emit of a stored sync note sets the same gauge, and the reply reports it stored". `service-event-buffer.test.ts`, describe "the telemetry buffer": "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back" (asserts the observed hook values `[4000]` while held and again after the drain; the gate r33 JUnit line 9015 for this test predates the 884e0753 edit to its body). `docs-freshness.test.ts`, describe "the corpus's freshness (v1.7 phase 65)": "a sync lag over its objective raises the warning and names the sync breach; on the objective, under it or with no objective it does not". This test sets the reading through `corpusSlo.recordSyncLag` directly, so it covers the reading-to-warning path, not the emit-to-gauge link. `corpus/slo.test.ts`, describe "CorpusSloState": "the sync lag is the lag of the newest docs.sync note the server took that carries a usable one, and any other note leaves it in place". `event-idempotency.test.ts` passes in the reported run; no title from it is relied on here. **Mutation check** (reported): with the hook call removed, the REST stored case, the REST not-stored case, the MCP case and the held-note case failed; restored, they pass |

**Score:** 5/5 truths verified (0 partial, 0 failed); behavior_unverified 0

### H-1 and this window's change audit (6e5d766e..884e0753)

| Changed commit and file | Phase 65 claim affected? | Result |
| ----------------------- | ------------------------ | ------ |
| `884e0753` `service.ts` `Substrate.emit` 3005–3011 and the `SubstrateObserver.syncLag` hook 1059–1060 | Yes: Truth 5 (the reading and the gauge that the `docs.freshness` breach reads) | Re-audited. The reading and the hook call share one branch; the held and dead-lettered returns (3160, 3163, 3247, 3251) feed it; the drain (`deliverBuffered`, 3259) does not |
| `884e0753` `observe.ts` 398–400 (`syncLag` → `setCorpusSyncLag`) | Yes: Truth 5 (the production gauge) | Re-audited; the only production caller of `setCorpusSyncLag` |
| `884e0753` `server.ts` (REST block and `syncLagSeconds` import deleted) | Yes: the prior record's wiring row, anti-pattern row and Open Item 5 | Removed. `POST /events` still calls `substrate.emit` (1352) and sends 202 or 503 (1362); no gauge write remains in `server.ts` |
| `884e0753` `corpus/slo.ts` `recordSyncLag` now returns `number \| null` | Yes: the hook's input | Re-read. The reading behaves as before (a null lag leaves the last one in place) |
| `884e0753` `corpus/slo.test.ts`, `corpus/sync-event.test.ts`, `service-event-buffer.test.ts`, `docs-freshness.test.ts` (one-line title and seam edits) | Evidence only | Added to covered_files (the first three); cited under Truth 5 |
| `884e0753` `docs/corpus-eval.md` lines 103 and 105, `docs/runbooks/docs-rag-operations.md` line 146 | Yes: the docs describe the gauge | Now say the gauge is set for each `docs.sync` note the server took (stored, held or dead-lettered) and is the reading `fabric_status` shows. The 6e5d766e text said stored-only; corrected |
| `403e45f7`, `bb6b38b7` (docs and code comments, phases 63, 68, 70) | No: no file in the covered list (`git diff --stat 6e5d766e..HEAD` over the covered list lists only the 884e0753 files) | Out of scope |
| `aef8a351` (covered-digest refresh for 13 records; phase 65 is not among them) and `c71a539d` (the 6e5d766e re-verification) | No | This record is re-verified in this pass and replaces the 6e5d766e record |
| `flag-registry.ts` (881, 882, 898), unit files, `coalesce.ts`, `watch.ts`, `hints.ts`, `install-git-hook.ts`, `view.ts`, `mirror.ts`, `docs-freshness.ts`, `event-sources.ts`, `instruments.ts`, `event-buffer.ts`, `planning-hash-store.ts` | Unchanged in the window (no diff in `6e5d766e..HEAD`) | Carried forward; their test runs at 6e5d766e are carried where the test file also has no diff |

### Deferred Items

None.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `infra/vps/substrate-corpus-watch.service` | staged watcher, idle I/O, limits, read-only home | ✓ VERIFIED | Lines 41–54; `ProtectHome=read-only` at 54 |
| `infra/vps/substrate-corpus-sync.service` | staged sweep unit | ✓ VERIFIED | Lines 29–39; `ProtectHome=read-only` at 39 |
| `infra/vps/substrate-corpus-reconcile.service` | staged dry-run unit | ✓ VERIFIED | Lines 32–42; `ProtectHome=read-only` at 42; dry run unless `--execute` |
| `infra/vps/substrate-corpus-sync.timer` / `…-reconcile.timer` | staged timers | ✓ VERIFIED | Not installed |
| `…-reconcile.service.d/30-sandbox.conf.example` | class A drop-in example | ✓ VERIFIED | Example only; matches `ProtectHome=read-only` |
| `packages/collectors/src/install-git-hook.ts` | opt-in hook installer | ✓ VERIFIED | `CORPUS_HOOKS` 150; background block 170–190, `return 0` |
| `packages/corpus/src/hints.ts` | bounded hint spool | ✓ VERIFIED | `writeHint` 107 writes `{v, dir, at}` |
| `packages/corpus/src/view.ts`, `mirror.ts` | mirror tree read | ✓ VERIFIED | Tests pass in run 2 at 6e5d766e (view 16/16, mirror 16/16); no diff at 884e0753 |
| `packages/corpus/src/watch.ts`, `coalesce.ts` | watcher and coalescer | ✓ VERIFIED | Tests pass in run 2 at 6e5d766e (watch 8/8, coalesce 8/8); no diff at 884e0753 |
| `packages/mcp-server/src/docs-freshness.ts` | corpus sync-lag breach in the docs.freshness warning | ✓ VERIFIED | `corpusFreshnessRow` 175, `lagWarningEvent` 323, `lagRecoveryEvent` 366; no diff at 884e0753 |
| `packages/mcp-server/src/service.ts` | emit reading and hook, planning refresh, `settleDocsLag`, `corpusFreshness` | ✓ VERIFIED | 1059–1060 (`syncLag` hook), 3005–3011 (reading and hook call), 7387–7421 (refresh), 7427–7432 (store), 7516–7526 (settle), 7534–7557 (corpus row) |
| `packages/mcp-server/src/corpus/slo.ts` | sync-lag reading | ✓ VERIFIED | `recordSyncLag` 72–76 keeps the last lag and returns it or null |
| `packages/mcp-server/src/observe.ts` | production observer | ✓ VERIFIED | `syncLag` → `instruments.setCorpusSyncLag` at 398–400 |
| `packages/mcp-server/src/server.ts` | REST `POST /events` | ✓ VERIFIED | Calls `substrate.emit` at 1352; sets no gauge (the 6e5d766e block is deleted) |
| `packages/mcp-server/src/event-buffer.ts` | buffer that holds a note the ledger did not take | ✓ VERIFIED | `abandonAll` 319–331 after 49b9aece; no diff at 884e0753 |
| `packages/mcp-server/src/flag-registry.ts` | flag text for `SUBSTRATE_CORPUS_FRESH_MAX_AGE_S`, `SUBSTRATE_PLANNING_HASH_STORE`, `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` | ✓ VERIFIED | Lines 881, 882, 898; unchanged in the window; `SUBSTRATE_PLANNING_HASH_STORE` default `off` |
| `packages/mcp-server/src/event-sources.ts` | `docs.sync` and `docs.planning` rows | ✓ VERIFIED | 1551, 1584; unchanged in the window |
| `packages/mcp-server/src/planning-hash-store.ts` | planning state adapter | ✓ VERIFIED | Table `planning_page_hashes`, not the manifest (as amended) |
| `packages/observability/src/instruments.ts` | lag gauge | ✓ VERIFIED | `setCorpusSyncLag` 679–681; `CORPUS_SYNC_LAG_METRIC` 734 |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `watch-commands.ts` | `runSync` | `repos: [R]` | ✓ WIRED | `watch-commands.test.ts` "a dry run plans only the named repository" passes (run 2 at 6e5d766e) |
| `install-git-hook.ts` | `corpus hint` | background `timeout 10` block, `return 0` | ✓ WIRED | Test "the installed hook runs the hint command … and exits 0 whatever the command does" passes (run 2 at 6e5d766e) |
| `hints.ts` | spool read by the watch loop | `readHints` | ✓ WIRED | `hints.test.ts` 10/10; `watch-loop.test.ts` passes (run 2 at 6e5d766e) |
| `service.ts` planning refresh | `planning_page_hashes` store | `loadPlanningHashes` / `savePlanningHashes` (flag on) | ✓ WIRED | `service.ts` 7393, 7410; off by default (Open Item 2) |
| `event-sources.ts` `docs.sync` | ledger note | `POST /events` (`server.ts` 1352) or MCP `events_emit` (`mcp.ts` 1190) → `Substrate.emit` → `recordSyncLag` on stored, buffered or deadLettered | ✓ WIRED | `service.ts` 3005–3011 |
| `Substrate.emit` (sync lag set) | gauge `substrate.corpus.sync_lag_seconds` | `observer.syncLag` (`service.ts` 3010) → `observe.ts` 398–400 → `setCorpusSyncLag` | ✓ WIRED (every route) | Replaces the 6e5d766e row that set the gauge in `server.ts` for stored notes only (closed at 884e0753) |
| `service.ts` `emit` held note | buffer drain | `buffered: true` → `EventBuffer` → `drainEventBuffer` | ✓ WIRED | `service-event-buffer.test.ts` "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back" asserts the reading before and after the drain |
| `corpusSlo.readings` (sync lag) | `corpusFreshnessRow` | `service.ts` 7542 | ✓ WIRED | Judged against `config.docsSlo.syncLagS` |
| `corpusFreshnessRow` breach | `docs.freshness` warning | `settleDocsLag` (7516–7526) → `LagSettler.settle` → `lagWarningEvent` | ✓ WIRED | `service.ts` 7516–7526 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `view.ts` | repository tree | mirror `git ls-tree` | Yes | ✓ FLOWING |
| `docs-freshness.ts` corpus row | `syncLagS` | newest `docs.sync` note's `lag_s` that the server stored, held or dead-lettered, recorded by `corpusSlo` in `Substrate.emit` | Yes, when a note exists; no note means no sync breach | ✓ FLOWING |
| `observe.ts` gauge | `substrate.corpus.sync_lag_seconds` | the same `recordSyncLag` return value as `syncLagS` | Yes, when a note exists; unset until the first such note | ✓ FLOWING |
| `docs-freshness.ts` corpus row | `lastIngestAt` | manifest `status()` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Targeted non-Postgres set at 884e0753 (sync-event, service-event-buffer, corpus/slo, docs-freshness, event-idempotency) | Reported by the main agent; not re-run in this pass | 94 + 75 passes, 0 failures; `SUBSTRATE_TEST_PG_URL` unset | ✓ REPORTED |
| Mutation check at 884e0753 (observer call removed, then restored) | Reported by the main agent | Removed: REST stored, REST not-stored, MCP and held-note cases fail. Restored: they pass | ✓ REPORTED |
| Run 1 at 6e5d766e (prior record; superseded for the files changed at 884e0753) | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/service-event-buffer.test.ts packages/mcp-server/src/planning-hash-store.test.ts packages/mcp-server/src/docs-freshness.test.ts packages/mcp-server/src/corpus/slo.test.ts packages/mcp-server/src/corpus/sync-event.test.ts packages/mcp-server/src/corpus/reconcile.test.ts packages/mcp-server/src/event-buffer.test.ts scripts/doctor-units.test.ts scripts/sandbox-dropins.test.ts` | 230 tests, 9 files: 227 pass, 3 skip (the `describeLive` block of `planning-hash-store.test.ts`, see PG counts), 0 fail | ✓ PASS (6e5d766e) |
| Run 2 at 6e5d766e (SC1–SC4 files, none changed at 884e0753) | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 --reporter=junit --reporter-outfile=/root/src/worktrees/backups/gate-tmpfs/p65-run2-junit.xml packages/mcp-server/src/planning-hash-store.test.ts scripts/sandbox-dropins.test.ts packages/cli/src/corpus/sync.test.ts packages/cli/src/corpus/watch-commands.test.ts packages/corpus/src/view.test.ts packages/corpus/src/mirror.test.ts packages/collectors/src/install-git-hook.test.ts packages/corpus/src/watch.test.ts packages/corpus/src/coalesce.test.ts packages/corpus/src/hints.test.ts packages/cli/src/corpus/watch-loop.test.ts` | 199 tests, 11 files: 196 pass, 3 skip, 0 fail (41.5 s); `sandbox-dropins.test.ts` 53/53 (0 skipped in this run) | ✓ PASS (6e5d766e) |

Only the reported 884e0753 run and the two 6e5d766e runs are cited. Every command used `SUBSTRATE_TEST_PG_URL` unset, so no database was contacted.

### Probe Execution

No probe declared for this phase (no `scripts/*/tests/probe-*.sh` referenced in the PLAN, SUMMARY or CONTEXT). Skipped.

### Requirements Coverage

No PLAN file exists for this phase (`Plans: none written`). Requirement IDs are taken from ROADMAP and REQUIREMENTS.md text, so each row names its criterion.

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| WATCH-01 | none | a change in a registered repository reaches the docs plane with no manual command | ✓ SATISFIED | SC1 (watch, coalesce, sync) |
| WATCH-02 | none | a burst costs one sync per repository; a restart re-ingests nothing unchanged | ✓ SATISFIED | SC1 (coalesce) and SC3 (two-server restart test; flag on) |
| WATCH-03 | none | default triggers write nothing; git hooks opt-in; hooks and watcher never block or fail a git command | ✓ SATISFIED | SC2 (amended text) |
| WATCH-04 | none | reconcile timer finds changes no trigger saw, through a managed mirror | ✓ SATISFIED (staged, not installed) | SC4 (reconcile dry run, mirror and view tests) |
| WATCH-05 | none | a sync reports outcome, lag and failures as events and metrics; a freshness breach raises `docs.freshness` | ✓ SATISFIED | SC5 (note, reading, gauge, warning); outcome event in `cli/corpus/events.ts` |

No orphaned requirements: REQUIREMENTS.md maps WATCH-01 to WATCH-05 to phase 65 and all five appear above.

### Anti-Patterns Found

Scan of the covered implementation files for `TODO|FIXME|XXX|HACK|PLACEHOLDER|not implemented`: the only hits are `SRC_PLACEHOLDER` and `CLI_PLACEHOLDER` in `install-git-hook.ts` (lines 37, 46–47, 155, 164), which are substitution tokens in the baked hook template, not stubs. No debt marker blocks this phase.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/collectors/src/install-git-hook.ts` | 37, 155 | `*_PLACEHOLDER` tokens | ℹ️ Info | Template substitution; not a stub |
| `packages/mcp-server/src/reserved-actions.ts` (`RESERVED_NOTE_ACTIONS`, 23–33) | — | `docs.sync` is not in the set | ⚠️ Warning | Any authenticated caller can post a `docs.sync` note through `POST /events` or `events_emit` and move the lag reading, the gauge and the warning (Open Item 4) |

The 6e5d766e row for `server.ts` 1362–1363 (gauge set only on a stored note) is removed: the gauge now follows the reading on every route (Open Item 5, closed).

### Human Verification Required

1. **Install the staged triggers and run one sync and one reconcile dry run**
   - **Test:** Install the three units and two timers, the opt-in hooks (`corpus hook install --corpus` for chosen repositories), then run `corpus watch --once` and `corpus reconcile`.
   - **Expected:** Units start; hints spool under the corpus-hints directory and are consumed; the reconcile prints a dry-run plan with no writes; a `docs.sync` note reaches the ledger.
   - **Why human:** Operator installation (WATCH-03 opt-in, WATCH-04). Nothing is installed on any host and no live sync was observed.

2. **Read the live sync-lag reading and gauge for a stored and a held note**
   - **Test:** On a running server, post one `docs.sync` note with `lag_s` through `POST /events` and one through `events_emit`; then post one while the ledger is down so the note is held; read `fabric_status` (the `corpus` row's `syncLag`) and the `substrate.corpus.sync_lag_seconds` series after each.
   - **Expected:** The reading and the gauge show the same lag at every step, including for the held note.
   - **Why human:** The agreement is established by code and tests at 884e0753. No live server, no live sync-lag reading and no live dashboard were observed in this pass.

### Gaps Summary

No gaps. Criteria 2 and 3 are judged against the owner-amended text and match it (the amendment date is 2026-11-05; the words are unchanged). Criterion 5 routes the sync-lag breach to `docs.freshness`; the held-note reading is covered by a named test; the gauge now follows the reading on every route (884e0753), so the asymmetry recorded at 6e5d766e is closed. Status is `human_needed` only because the operator install and the live reading are human steps.

### Open Items

1. Operator install of the staged units, timers and hooks (WATCH-03 opt-in, WATCH-04), and the live sync-lag check in Human Verification 2. Not verifier-closable.
2. `SUBSTRATE_PLANNING_HASH_STORE` defaults to `off` (`flag-registry.ts` line 882). In the default configuration a restart re-ingests unchanged planning pages (the non-Postgres restart tests run with the flag on). Criterion 3 holds with the flag on. Owner decision 2026-11-05: keep the default off.
3. Postgres-gated test: `packages/mcp-server/src/planning-hash-store.test.ts`, suite "the Postgres adapter against a live index", testcase "save upserts by path and load reads it back, so a second store object sees what the first wrote". Cited by name from the gate r33 JUnit report `/root/src/worktrees/backups/gate-r33-junit.xml`, lines 5032–5048: suite `tests="8" failures="0" skipped="0"`, and the named testcase is self-closing (no `<skipped/>` child). No Postgres run was made in this pass (none assigned). The file has no diff at 884e0753.
4. `docs.sync` is not in `RESERVED_NOTE_ACTIONS` (`reserved-actions.ts`). Owner decision recorded as "reservation held", so the status quo stands. Consequence: a `docs.sync` note with a large `lag_s` posted by any authenticated caller raises the corpus warning and sets the gauge.
5. **Closed at 884e0753.** The prior record noted that the gauge `substrate.corpus.sync_lag_seconds` was set only for a stored note while the in-process reading also followed held and dead-lettered notes. The gauge now follows the reading: `Substrate.emit` sets both in one branch (`service.ts` 3005–3011), the production observer maps the hook to the gauge (`observe.ts` 398–400), and the REST-only write in `server.ts` is removed. The docs (`docs/corpus-eval.md` 103 and 105, `docs/runbooks/docs-rag-operations.md` 146) say the same. Evidence and test titles: Truth 5.
6. `covered_files` now also lists `corpus/slo.ts`, `corpus/slo.test.ts`, `corpus/sync-event.test.ts`, `observe.ts`, `server.ts`, `docs/corpus-eval.md` and `docs/runbooks/docs-rag-operations.md` (changed at 884e0753 on the sync-lag path). `covered_digest` is computed over this list at HEAD 884e0753 with `gsd_run query verification.fingerprint`.
7. Information: the sync-lag reading is the last reported lag and does not age. If syncs stop, a breach stays until a sync reports within the objective. This matches the phase 70 SLO semantics. A sync breach is also not raised while the manifest has never ingested (`corpusFreshnessRow` returns null).

### PG counts per file

- `packages/mcp-server/src/planning-hash-store.test.ts`: the Postgres-gated block is `describeLive` (`SUBSTRATE_TEST_PG_URL`, line 190), with one named test and two unnamed hook entries. With the variable unset (run 1 and run 2 at 6e5d766e): 7 pass and 3 skipped entries (the named test plus the two `beforeAll`/`afterAll` entries reported as `(unnamed)`). With the URL set in the gate r33 run: 8 of 8 pass, 0 skipped (`gate-r33-junit.xml` line 5032).
- `scripts/doctor-units.test.ts`, `scripts/sandbox-dropins.test.ts`: no PG gate. Ran with the variable unset at 6e5d766e: pass (run 1: part of 227 pass, 0 fail; run 2: `sandbox-dropins.test.ts` 53/53, 0 skipped).
- `packages/cli/src/corpus/sync.test.ts`, `watch-commands.test.ts`, `packages/corpus/src/*.test.ts` and `packages/collectors/src/install-git-hook.test.ts` in the covered set: no PG gate. Ran with the variable unset at 6e5d766e: pass (run 2).
- `packages/mcp-server/src/service-event-buffer.test.ts`, `event-buffer.test.ts`, `docs-freshness.test.ts`, `corpus/slo.test.ts`, `corpus/sync-event.test.ts`, `corpus/reconcile.test.ts`: no PG gate (in-memory ledger fakes; `sync-event.test.ts` uses a stub ledger that throws on refusal). Reported pass at 884e0753 (the first five) and at 6e5d766e (`reconcile.test.ts`).

### Scope of this pass

HEAD 884e0753 (prior record head 6e5d766e). Re-audited: the sync-lag path through `packages/mcp-server/src/service.ts` (the `syncLag` hook at 1059–1060, `Substrate.emit` at 3005–3011, the held and dead-lettered returns, `deliverBuffered`), `packages/mcp-server/src/observe.ts` (398–400), `packages/mcp-server/src/server.ts` (the deleted REST block; `POST /events` at 1352), `packages/mcp-server/src/corpus/slo.ts` (`recordSyncLag`), `packages/mcp-server/src/mcp.ts` (`events_emit` at 1190, to confirm it reaches `emit`), and the docs-freshness settle and corpus row. Re-anchored every line reference in the record. Tests: the test titles above were read from the files at HEAD; no test was run in this pass. The 884e0753 results and mutation check are the main agent's report. The Postgres-gated test is cited from the gate r33 JUnit report, not re-run. No code edits; no commits; no full suite; no tsc, lint or formatters; no Docker or database started. Only this record file was written.

---

_Verified: 2026-11-05T08:43:31Z_
_Verifier: Claude (gsd-verifier), worker Verify65W1, worktree /root/src/worktrees/as-gsd-v18-all, head 884e0753_
