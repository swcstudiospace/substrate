---
phase: 65-doc-watch
verified: 2026-11-05T08:01:54Z
status: human_needed
score: 5/5 must-haves verified (success criteria 1-5; SC2 and SC3 against the owner-amended text dated 2026-11-05; SC5 after 42dcb4c6 and b4bdd0fc)
covered_files:
  - ".planning/phases/65-doc-watch/65-SUMMARY.md"
  - "docs/corpus-watch.md"
  - "docs/runbooks/corpus-sync.md"
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
  - "packages/mcp-server/src/corpus/sync-event.ts"
  - "packages/mcp-server/src/docs-freshness.test.ts"
  - "packages/mcp-server/src/docs-freshness.ts"
  - "packages/mcp-server/src/event-buffer.ts"
  - "packages/mcp-server/src/event-sources.ts"
  - "packages/mcp-server/src/flag-registry.ts"
  - "packages/mcp-server/src/planning-hash-store.ts"
  - "packages/mcp-server/src/service-event-buffer.test.ts"
  - "packages/mcp-server/src/service.ts"
  - "packages/observability/src/instruments.ts"
  - "scripts/doctor-units.test.ts"
  - "scripts/sandbox-dropins.test.ts"
covered_digest: "v3:sha256:7ef7c04e2a2bb7eee653ea015f046fd498d40854d1e3c5aabe19a8c402e458d2"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/5
  previous_head: 42e3cf13
  reason: "Head 6e5d766e. Changes since 42e3cf13 that touch phase 65 claims: b4bdd0fc (service.ts emit: the docs.sync sync-lag reading is set for a note the ledger held or dead-lettered; service-event-buffer.test.ts gains a test) and 49b9aece (event-buffer.ts abandonAll: an in-flight entry is recorded at shutdown; the held-note path of SC5 runs through this buffer). event-buffer.ts and service-event-buffer.test.ts are added to covered_files because the SC5 held-note claim depends on them; the list is otherwise the prior list. Not touching phase 65 claims: d1a5e89b (cache.ts), b4fe6bfe (worktree.py), 6e5d766e (docs and planning text: the SC2 and SC3 amendment date moved from 2026-11-04 to 2026-11-05, text unchanged; docs/corpus.md tombstone line). flag-registry.ts and the unit files are unchanged in the window."
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
---

# Phase 65: Doc Watch Verification Report

**Phase Goal:** When documentation changes in a registered repository, the docs plane follows without anyone running a command, and a restart never re-ingests what has not changed.
**Verified:** 2026-11-05T08:01:54Z
**Head:** 6e5d766e (integration branch gsd/v18-int-all, worktree /root/src/worktrees/as-gsd-v18-all)
**Status:** human_needed
**Re-verification:** Yes. Prior record: 42e3cf13, human_needed, 5/5. This pass re-audits every claim that touches a file changed since 42e3cf13 (`service.ts`, `event-buffer.ts`, `service-event-buffer.test.ts`), runs the phase's non-Postgres tests again, and re-cites the Postgres-gated test from the gate JUnit report. Criteria 2 and 3 are judged against the owner-amended text (the wording is unchanged; the amendment date moved to 2026-11-05 in 6e5d766e). Criterion 5 is judged after 42dcb4c6 and b4bdd0fc.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `corpus sync --repo R` plans and ingests only R; `corpus watch` debounces and coalesces a burst into one sync per repository | ✓ VERIFIED | `packages/corpus/src/coalesce.ts` (trailing debounce, maximum wait, one running sync per repository); `watch.ts` marks repositories dirty and reads nothing. Re-run this pass (run 2, below): `coalesce.test.ts` 8/8, `watch.test.ts` 8/8, `watch-loop.test.ts`, `sync.test.ts`, `watch-commands.test.ts` 20/20 (`substrate corpus sync` 7, `substrate corpus watch --once` 3) all pass. Gate JUnit names "a dry run sends nothing to the plane and emits no event" (`sync.test.ts`, line 14480 of `gate-r33-junit.xml`, not skipped) and "a dry run plans only the named repository, with coverage for it alone, and sends nothing else" (`watch-commands.test.ts`) |
| 2 | (amended) Default triggers write nothing into any repository; the git hooks are an opt-in installer adding post-merge, post-checkout and post-rewrite hints beside the post-commit collector; a hook writes a bounded hint `{v, dir, at}` with no action name, always exits 0, and never overwrites a foreign hook | ✓ VERIFIED (amended text) | `install-git-hook.ts` line 150: `CORPUS_HOOKS = post-merge, post-checkout, post-rewrite`; the marked block (lines 170–190) runs `timeout 10 "$@" corpus hint --repo "$top"` in the background by default (in the foreground only under `SUBSTRATE_HOOK_WAIT=1`, the test seam) and ends `return 0`; a foreign hook is refused and left alone. `hints.ts` `writeHint` (line 107) writes `{v, dir, at}`. Re-run this pass: `install-git-hook.test.ts` 24/24 (including "the installed hook runs the hint command for the repository's top level, in the foreground under SUBSTRATE_HOOK_WAIT, and exits 0 whatever the command does"), `hints.test.ts` 10/10, `watch-commands.test.ts` "substrate corpus hook" 3/3 and "the default triggers are read-only toward every repository" 1/1 |
| 3 | (amended) The server's planning refresh keeps its state in `planning_page_hashes`, not the manifest, so a restart re-ingests nothing unchanged (test with two server instances over one store) | ✓ VERIFIED (amended text; flag on) | `service.ts` `runPlanningRefresh` 7382–7420: `loadPlanningHashes` (7388), `planningIngestTrigger` (7389), `savePlanningHashes` (7405). `planningHashStore()` 7422–7427 returns the index's `planning_page_hashes` store when `SUBSTRATE_PLANNING_HASH_STORE` is on and memory otherwise. Migration step 39 creates `planning_page_hashes` (`index-store.ts`); `planning-hash-store.ts` holds the port, the memory adapter and the Postgres adapter. Re-run this pass, `planning-hash-store.test.ts` (run 2: 10 entries, 7 pass, 3 skipped with the URL unset): "a second server over the same store ingests nothing unchanged, and exactly the changed page after an edit", "a page the plane failed is not stored, so the next process sends it again and only it", "with the flag off nothing is read or written: a restart ingests every page again and the store stays empty" and "a store that cannot be read costs one full ingest and the pass still completes" all pass. Note: the two-server test runs over the memory adapter; the Postgres leg is the store round trip (see Postgres section). Default is off (`flag-registry.ts` 882, owner decision: keep the default off), so the restart guarantee holds with the flag on |
| 4 | Units `substrate-corpus-watch.service`, `substrate-corpus-sync.service` and `substrate-corpus-sync.timer` are staged with Nice, an idle I/O class, CPUQuota and MemoryMax; the watcher drops to sweep-only at the inotify limit; `corpus reconcile` reports a missing row and re-ingests only with `--execute`; reconcile fetches a managed mirror and reads its default-branch tree; one view per repository per sync | ✓ VERIFIED (staged, not installed) | Units: all three base units carry `Nice=15`, `IOSchedulingClass=idle`, `CPUQuota=25%`, `MemoryMax=512M`, and `ProtectHome=read-only` (watch line 54, sync line 39, reconcile line 42; the unit files are unchanged since 835a2742). Sweep-only fallback: `watch.test.ts` "the inotify limit closes every watch and leaves the command in sweep-only mode" and "EMFILE counts as the limit too, and a limit error raised later by a live watch degrades the watcher" pass (run 2). **WATCH-04 reconcile dry run:** `watch-commands.test.ts` "a dry run plans, reports the drift and the problems, and repairs nothing" (3/3 "substrate corpus reconcile" pass in run 2; gate JUnit line 14825, not skipped) and `reconcile.test.ts` "a dry run reports the missing row and the orphan and changes nothing" (gate JUnit line 17525, not skipped; the file passes in run 1, which also covers "execute marks the missing row removed without calling the plane, deletes the orphan …"). Mirror and view: `view.test.ts` "shows a remote-only push although the checkout did not move, and writes nothing into the checkout", "alternating local edits and remote pushes without pulling never flips a path that did not change", "a failed fetch changes nothing and keeps reading the stale mirror; recovery brings the push in" (gate JUnit lines 3034, 3037, 3038; `view.test.ts` 16/16 in run 2); `mirror.test.ts` "a failed fetch leaves the mirror as it was and says stale; recovery fetches again" (gate JUnit line 3154; `mirror.test.ts` 16/16 in run 2). **ProtectHome:** `scripts/sandbox-dropins.test.ts` "corpus units" (run 2: 1/1; the gate JUnit names "the three corpus units ship ProtectHome=read-only in the base unit file, not only in their class A drop-ins", line 453, and "Class B keeps ProtectHome=false; Class A is read-only home; both end up with ProtectSystem=strict", line 452) |
| 5 | Each sync emits a `docs.sync` note (event-sources row, vocabulary lock unchanged) and a lag metric; a breach raises the existing `docs.freshness` warning | ✓ VERIFIED (re-anchored; buffered-note path re-audited for b4bdd0fc) | Note: `event-sources.ts` row `docs.sync` (line 1551, action `docs.sync`); `cli/corpus/events.ts` line 51 emits `lag_s: sync.lagS`; lag is measured from the first change signal to the end of the sync (`cli/corpus/sync.ts` line 312). Server reading: `service.ts` line 3006 calls `corpusSlo.recordSyncLag` when the note was **stored, buffered or deadLettered** (b4bdd0fc; the comment is on line 3005). A note the server did not take leaves the reading unchanged. `corpus/slo.ts` `recordSyncLag` (69) keeps the last `lag_s`. Gauge: `substrate.corpus.sync_lag_seconds` (`observability/src/instruments.ts` 734), set in `server.ts` 1362–1363 only when `result.stored` (see Open Item 5). Breach: `docs-freshness.ts` `corpusFreshnessRow` (175) adds `sync_lag` when the newest lag is strictly over `syncLagMaxS`; `lagWarningEvent` (323) emits `kind: warning`; `service.ts` `settleDocsLag` 7511–7521 and `corpusFreshness` 7529–7552 (reading passed as `this.corpusSlo.readings(now).syncLagS`, line 7537). Tests, run 1 and the gate JUnit: "a docs.sync note the ledger could not take still sets the sync-lag reading, and lands once when the ledger is back" (`service-event-buffer.test.ts`, gate JUnit line 9015, self-closing, not skipped; the test asserts reading 4000 s while held and after the drain); `docs-freshness.test.ts`, `corpus/slo.test.ts`, `corpus/sync-event.test.ts` pass in run 1 |

**Score:** 5/5 truths verified (0 partial, 0 failed); behavior_unverified 0

### H-1 and this window's change audit (42e3cf13..6e5d766e)

| Changed commit and file | Phase 65 claim affected? | Result |
| ----------------------- | ------------------------ | ------ |
| `b4bdd0fc` `service.ts` line 3006: the sync-lag reading is set for `stored`, `buffered` or `deadLettered` | Yes: Truth 5 (the reading that drives the `docs.freshness` breach) | Re-audited; the new branch is covered by the named test; the emit result shapes it reads (`buffered`, `deadLettered`) are at `service.ts` 3155–3158 and 3242–3246 |
| `b4bdd0fc` `service-event-buffer.test.ts` | Evidence only | Added to covered_files |
| `49b9aece` `event-buffer.ts` `abandonAll` (an in-flight entry is recorded at shutdown) | Indirectly: the held-note path of Truth 5 goes through the buffer; the reading is set on the `buffered` return before any buffer shutdown, so `abandonAll` does not change it | Re-audited; added to covered_files; `event-buffer.test.ts` passes (run 1) |
| `d1a5e89b` `cache.ts`, `cache-breaker.test.ts` (breaker refusal) | No: the brief path and the cache are not in any phase 65 claim | Out of scope |
| `b4fe6bfe` `worktree.py`, `test_worktree.py` (phase 68 free-space floor) | No | Out of scope |
| `6e5d766e` ROADMAP/REQUIREMENTS: SC2 and SC3 amendment dates 2026-11-04 → 2026-11-05 (text unchanged); docs/corpus.md and docs/reconcile.md (tombstone scope, reconcile refusal) | No: the criteria text is unchanged; `docs/corpus.md` is not covered by phase 65 | Carried forward; SC2/SC3 judged on the same text |
| `flag-registry.ts` (`SUBSTRATE_CORPUS_FRESH_MAX_AGE_S` 881, `SUBSTRATE_PLANNING_HASH_STORE` 882, `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` 898), unit files, `coalesce.ts`, `watch.ts`, `hints.ts`, `install-git-hook.ts`, `view.ts`, `mirror.ts`, `docs-freshness.ts`, `event-sources.ts`, `instruments.ts` | Unchanged in the window (`git diff --stat 42e3cf13..HEAD` over the covered list lists only the three files above); unit files have no diff since 835a2742 | Carried forward and re-run where tests exist |

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
| `packages/corpus/src/view.ts`, `mirror.ts` | mirror tree read | ✓ VERIFIED | Tests pass in run 2 (view 16/16, mirror 16/16) |
| `packages/corpus/src/watch.ts`, `coalesce.ts` | watcher and coalescer | ✓ VERIFIED | Tests pass in run 2 (watch 8/8, coalesce 8/8) |
| `packages/mcp-server/src/docs-freshness.ts` | corpus sync-lag breach in the docs.freshness warning | ✓ VERIFIED | `corpusFreshnessRow` 175, `lagWarningEvent` 323, `lagRecoveryEvent` 366 |
| `packages/mcp-server/src/service.ts` | planning refresh, `recordSyncLag`, `settleDocsLag`, `corpusFreshness` | ✓ VERIFIED | 7382–7420 (refresh), 7422–7427 (store), 3006 (reading), 7511–7521 (settle), 7529–7552 (corpus row) |
| `packages/mcp-server/src/event-buffer.ts` | buffer that holds a note the ledger did not take | ✓ VERIFIED | `abandonAll` 319–331 after 49b9aece; `event-buffer.test.ts` passes (run 1) |
| `packages/mcp-server/src/flag-registry.ts` | flag text for `SUBSTRATE_CORPUS_FRESH_MAX_AGE_S`, `SUBSTRATE_PLANNING_HASH_STORE`, `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` | ✓ VERIFIED | Lines 881, 882, 898; unchanged in the window; `SUBSTRATE_PLANNING_HASH_STORE` default `off` |
| `packages/mcp-server/src/event-sources.ts` | `docs.sync` and `docs.planning` rows | ✓ VERIFIED | 1551, 1584; unchanged in the window |
| `packages/mcp-server/src/planning-hash-store.ts` | planning state adapter | ✓ VERIFIED | Table `planning_page_hashes`, not the manifest (as amended) |
| `packages/observability/src/instruments.ts` | lag gauge | ✓ VERIFIED | `CORPUS_SYNC_LAG_METRIC` line 734 |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `watch-commands.ts` | `runSync` | `repos: [R]` | ✓ WIRED | `watch-commands.test.ts` "a dry run plans only the named repository" passes (run 2) |
| `install-git-hook.ts` | `corpus hint` | background `timeout 10` block, `return 0` | ✓ WIRED | Test "the installed hook runs the hint command … and exits 0 whatever the command does" passes (run 2) |
| `hints.ts` | spool read by the watch loop | `readHints` | ✓ WIRED | `hints.test.ts` 10/10; `watch-loop.test.ts` passes (run 2) |
| `service.ts` planning refresh | `planning_page_hashes` store | `loadPlanningHashes` / `savePlanningHashes` (flag on) | ✓ WIRED | `service.ts` 7388, 7405; off by default (Open Item 2) |
| `event-sources.ts` `docs.sync` | ledger note | `POST /events` → `recordSyncLag` on stored, buffered or deadLettered | ✓ WIRED | `service.ts` 3006 |
| `service.ts` `emit` held note | buffer drain | `buffered: true` → `EventBuffer` → `drainEventBuffer` | ✓ WIRED | `service-event-buffer.test.ts` asserts the reading before and after the drain (run 1; gate JUnit 9015) |
| `corpusSlo.readings` (sync lag) | `corpusFreshnessRow` | `service.ts` 7537 | ✓ WIRED | Judged against `config.docsSlo.syncLagS` |
| `corpusFreshnessRow` breach | `docs.freshness` warning | `settleDocsLag` → `LagSettler.settle` → `lagWarningEvent` | ✓ WIRED | `service.ts` 7511–7521 |
| `server.ts` `POST /events` | gauge `substrate.corpus.sync_lag_seconds` | `setCorpusSyncLag` when `result.stored` | ✓ WIRED (stored only) | `server.ts` 1362–1363; see Open Item 5 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `view.ts` | repository tree | mirror `git ls-tree` | Yes | ✓ FLOWING |
| `docs-freshness.ts` corpus row | `syncLagS` | newest `docs.sync` note's `lag_s` that the server stored, held or dead-lettered, recorded by `corpusSlo` | Yes, when a note exists; no note means no sync breach | ✓ FLOWING |
| `docs-freshness.ts` corpus row | `lastIngestAt` | manifest `status()` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Run 1: SC5 held-note reading, sync-lag breach, planning hash store (non-PG legs), reconcile unit, units' sandbox checks, event buffer | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/service-event-buffer.test.ts packages/mcp-server/src/planning-hash-store.test.ts packages/mcp-server/src/docs-freshness.test.ts packages/mcp-server/src/corpus/slo.test.ts packages/mcp-server/src/corpus/sync-event.test.ts packages/mcp-server/src/corpus/reconcile.test.ts packages/mcp-server/src/event-buffer.test.ts scripts/doctor-units.test.ts scripts/sandbox-dropins.test.ts` | 230 tests, 9 files: 227 pass, 3 skip (the 3 skipped entries are the `describeLive` block of `planning-hash-store.test.ts`, see PG counts), 0 fail (12.7 s) | ✓ PASS |
| Run 2: SC1–SC4 targeted, with a per-test JUnit report | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 --reporter=junit --reporter-outfile=/root/src/worktrees/backups/gate-tmpfs/p65-run2-junit.xml packages/mcp-server/src/planning-hash-store.test.ts scripts/sandbox-dropins.test.ts packages/cli/src/corpus/sync.test.ts packages/cli/src/corpus/watch-commands.test.ts packages/corpus/src/view.test.ts packages/corpus/src/mirror.test.ts packages/collectors/src/install-git-hook.test.ts packages/corpus/src/watch.test.ts packages/corpus/src/coalesce.test.ts packages/corpus/src/hints.test.ts packages/cli/src/corpus/watch-loop.test.ts` | 199 tests, 11 files: 196 pass, 3 skip, 0 fail (41.5 s); `sandbox-dropins.test.ts` 53/53 (0 skipped in this run) | ✓ PASS |

Two targeted non-Postgres commands were used; no other test command was run. Both were run with `SUBSTRATE_TEST_PG_URL` unset, so no database was contacted.

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
| `packages/mcp-server/src/event-sources.ts` / `reserved-actions.ts` | — | `docs.sync` not in `RESERVED_NOTE_ACTIONS` | ⚠️ Warning | Any authenticated caller can post a `docs.sync` note and move the lag reading and the warning (Open Item 4) |
| `packages/mcp-server/src/server.ts` | 1362–1363 | gauge set only on a stored note, the reading also on held notes | ⚠️ Warning | The in-process reading and the gauge can differ during a ledger outage (Open Item 5) |

### Human Verification Required

1. **Install the staged triggers and run one sync and one reconcile dry run**
   - **Test:** Install the three units and two timers, the opt-in hooks (`corpus hook install --corpus` for chosen repositories), then run `corpus watch --once` and `corpus reconcile`.
   - **Expected:** Units start; hints spool under the corpus-hints directory and are consumed; the reconcile prints a dry-run plan with no writes; a `docs.sync` note reaches the ledger.
   - **Why human:** Operator installation (WATCH-03 opt-in, WATCH-04). Nothing is installed on any host and no live sync was observed.

### Gaps Summary

No gaps. Criteria 2 and 3 are judged against the owner-amended text and match it (the amendment date is now 2026-11-05; the words are unchanged). Criterion 5 routes the sync-lag breach to `docs.freshness`; the held-note reading (b4bdd0fc) is covered by a named test. The change window touched no phase 65 claim in a way that changes a verdict. Status is `human_needed` only because the operator install is a human step.

### Open Items

1. Operator install of the staged units, timers and hooks (WATCH-03 opt-in, WATCH-04). Not verifier-closable.
2. `SUBSTRATE_PLANNING_HASH_STORE` defaults to `off` (`flag-registry.ts` line 882). In the default configuration a restart re-ingests unchanged planning pages (the non-Postgres restart tests run with the flag on). Criterion 3 holds with the flag on. Owner decision 2026-11-05: keep the default off.
3. Postgres-gated test: `packages/mcp-server/src/planning-hash-store.test.ts`, suite "the Postgres adapter against a live index", testcase "save upserts by path and load reads it back, so a second store object sees what the first wrote". Cited by name from the gate r33 JUnit report `/root/src/worktrees/backups/gate-r33-junit.xml`, lines 5032–5048: suite `tests="8" failures="0" skipped="0"`, and the named testcase is self-closing (no `<skipped/>` child). No Postgres run was made in this pass (none assigned); the earlier scratch-Postgres run (8 of 8) is not repeated.
4. `docs.sync` is not in `RESERVED_NOTE_ACTIONS` (`reserved-actions.ts`). Owner decision recorded as "reservation held", so the status quo stands. Consequence: a `docs.sync` note with a large `lag_s` posted by any authenticated caller raises the corpus warning.
5. New asymmetry after b4bdd0fc: the in-process sync-lag reading (which drives the `docs.freshness` breach) is set for a held or dead-lettered `docs.sync` note, but the Prometheus gauge `substrate.corpus.sync_lag_seconds` is set in `server.ts` 1362–1363 only when the note was stored, and a held note landing later does not pass through that route. During a ledger outage the gauge keeps the last stored value while the warning reads the held value. SC5 requires a lag metric and a warning; both exist and the warning is correct. Not a gap; recorded so the owner can decide whether the gauge should follow the reading.
6. `covered_files` now includes `packages/mcp-server/src/event-buffer.ts` and `packages/mcp-server/src/service-event-buffer.test.ts` (changed in the window, on the SC5 held-note path). The digest is computed over that list at HEAD 6e5d766e.
7. Information: the sync-lag reading is the last reported lag and does not age. If syncs stop, a breach stays until a sync reports within the objective. This matches the phase 70 SLO semantics. A sync breach is also not raised while the manifest has never ingested (`corpusFreshnessRow` returns null).

### PG counts per file

- `packages/mcp-server/src/planning-hash-store.test.ts`: the Postgres-gated block is `describeLive` (`SUBSTRATE_TEST_PG_URL`, line 190), with one named test and two unnamed hook entries. With the variable unset (both runs in this pass): 7 pass and 3 skipped entries (the named test plus the two `beforeAll`/`afterAll` entries reported as `(unnamed)`). With the URL set in the gate r33 run: 8 of 8 pass, 0 skipped (`gate-r33-junit.xml` line 5032).
- `scripts/doctor-units.test.ts`, `scripts/sandbox-dropins.test.ts`: no PG gate. Ran with the variable unset: pass (run 1: part of 227 pass, 0 fail; run 2: `sandbox-dropins.test.ts` 53/53, 0 skipped).
- `packages/cli/src/corpus/sync.test.ts`, `watch-commands.test.ts`, `packages/corpus/src/*.test.ts` and `packages/collectors/src/install-git-hook.test.ts` in the covered set: no PG gate. Ran with the variable unset: pass (run 2).
- `packages/mcp-server/src/service-event-buffer.test.ts`, `event-buffer.test.ts`, `docs-freshness.test.ts`, `corpus/slo.test.ts`, `corpus/sync-event.test.ts`, `corpus/reconcile.test.ts`: no PG gate (in-memory ledger fakes). Ran with the variable unset: pass (run 1).

### Scope of this pass

HEAD 6e5d766e (prior record head 42e3cf13). Re-audited: the claims touching `packages/mcp-server/src/service.ts` (emit reading at 3006, planning refresh, `settleDocsLag`, `corpusFreshness`), `packages/mcp-server/src/event-buffer.ts` (`abandonAll`, the held-note path), and `packages/mcp-server/src/service-event-buffer.test.ts` (the new SC5 test). Re-anchored every line reference. Targeted non-Postgres runs: two commands (run 1: 9 files, 227 pass, 3 skip, 0 fail; run 2: 11 files, 196 pass, 3 skip, 0 fail; per-test JUnit for run 2 at `/root/src/worktrees/backups/gate-tmpfs/p65-run2-junit.xml`). The Postgres-gated test is cited from the gate r33 JUnit report, not re-run. No code edits; no commits; no full suite; no tsc, lint or formatters; no Docker or database started. Only this record file was written.

---

_Verified: 2026-11-05T08:01:54Z_
_Verifier: Claude (gsd-verifier), worker verify6e5-3, worktree /root/src/worktrees/as-gsd-v18-all, head 6e5d766e_
