---
phase: 65-doc-watch
verified: 2026-10-30
status: gaps_found
score: 3 of 5 success criteria MET in the repository (1, 4, 5); 2 PARTIAL (2, 3); no trigger installed on any host, no live sync run
verified_on: commit aa19c926 on main (files read with git show; nothing was run by the author of this record)
---

# 65-VERIFICATION: Doc Watch, four triggers into one idempotent sync

## Gates

Not run by the author of this record. Files, function names and test titles were read at aa19c926 with `git show <sha>:<path>` and `git show --stat`. No test counts or timings are cited, and no test was run. The squash body lists 12 fix commits after the feature commit; it does not record gate results. The gates the orchestrator ran in worktrees before the PR (Biome, tests, `tsc`) and the Greptile merge gate (5/5, no open threads, CI green, squash) come from the orchestrator's brief, not from the commit, and are not verified here. Test titles below are cited as evidence that a test exists, not that it passes.

## Success criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `substrate corpus sync --repo R` plans and ingests only that repository's changes; `substrate corpus watch` watches the registered roots with a debounce and coalesces a burst into one sync per repository (injected clock and fake watcher in the tests) | MET | `packages/cli/src/corpus/watch-commands.ts` `runSyncCommand` passes `repos: [R]` to `runSync`; `packages/corpus/src/coalesce.ts` `Coalescer.signal`, `due`, `finished`; `packages/corpus/src/watch.ts` `createWatcher`; `packages/cli/src/corpus/watch-loop.test.ts` "a burst of file events is one sync per repository, started after the quiet time", "a signal that arrives while a repository syncs becomes exactly one more sync of it"; `packages/cli/src/corpus/sync.test.ts` "ingests a remote-only push from the mirror and writes nothing into the checkout" |
| 2 | The default triggers write nothing into any repository (watcher and reconcile read-only). Git hooks are an opt-in installer adding post-merge, post-checkout and post-rewrite hints beside the post-commit collector; a hook sends a bounded `docs.changed` hint, always exits 0, never overwrites a foreign hook | PARTIAL | Met: `packages/collectors/src/install-git-hook.ts` `installCorpusHooks` (`readExisting` returns "foreign" for a hook without our marker or with a damaged pair; the block runs `corpus hint` under `timeout 10` in the background and `return 0`); `packages/corpus/src/hints.ts` `writeHint` (`MAX_HINT_FILES` 1000, `MAX_HINT_BYTES` 4096, `spool-full` refusal). Not met as worded: no `docs.changed` action exists in `packages/`, `docs/` or `scripts/`; the hint is `{v, dir, at}`. `CORPUS_HOOKS` is `post-merge`, `post-checkout`, `post-rewrite`, with no post-commit. |
| 3 | The planning refresh reads its state from the manifest instead of an in-memory map, so a restart re-ingests nothing unchanged (test with two server instances over one store) | PARTIAL | `packages/mcp-server/src/service.ts` `planningHashStore`, `loadPlanningHashes`, `savePlanningHashes`; the store is table `planning_page_hashes` (migration step 39, `packages/mcp-server/src/index-store.ts`), not the manifest `corpus_documents`. The in-memory `planningHashes` map is still the working set. Test: `packages/mcp-server/src/planning-hash-store.test.ts` "a second server over the same store ingests nothing unchanged, and exactly the changed page after an edit" (the in-memory adapter path is the one named). The Postgres adapter test runs only when `SUBSTRATE_TEST_PG_URL` is set (`describeLive`). Off by default (`SUBSTRATE_PLANNING_HASH_STORE`, `flag-registry.ts`). |
| 4 | `infra/vps` units `substrate-corpus-watch.service`, `substrate-corpus-sync.service` and `substrate-corpus-sync.timer` are staged, with `Nice`, an idle I/O class, `CPUQuota` and `MemoryMax`; the watcher drops to sweep-only at the inotify limit; `substrate corpus reconcile` reports a missing row and re-ingests only with `--execute`; the reconcile fetches into a managed mirror and reads its default-branch tree; one view per repository per sync | MET (staged, not installed) | The three units: `Nice=15`, `IOSchedulingClass=idle`, `CPUQuota=25%`, `MemoryMax=512M`, `ProtectSystem=strict`, writable paths only under the mirror and spool directories. `packages/corpus/src/watch.ts` `degraded: "inotify-limit"`. `packages/mcp-server/src/corpus/reconcile.ts` `diffPlane`, `reconcileCorpus`; `runReconcileCommand` in `watch-commands.ts` (plans with `fetchMirrors: true`; `--execute` runs the server repair, then a sync). `packages/corpus/src/mirror.ts` `ensureMirror` (`git clone --mirror --filter=blob:none`, `git fetch --prune` with `cwd` set to the mirror); `packages/corpus/src/view.ts` header (one view, the checkout's changes laid over the mirror path by path). Nothing is installed; `docs/runbooks/corpus-sync.md` section 3 is the operator step. |
| 5 | Each sync emits a `docs.sync` note (event-sources row, vocabulary lock unchanged) and a lag metric; a breach raises the existing `docs.freshness` warning | MET | `packages/mcp-server/src/event-sources.ts` row `docs.sync` (phase 65, runtime `corpus-sync`); `packages/cli/src/corpus/events.ts` `docsSyncBody`, `createHttpEmitter`; `packages/cli/src/corpus/sync.ts` `runSync` emits only when `execute`; `packages/mcp-server/src/corpus/sync-event.ts` `syncLagSeconds`; `packages/mcp-server/src/server.ts` sets `setCorpusSyncLag` only when `result.stored`; `packages/observability/src/instruments.ts` `CORPUS_SYNC_LAG_METRIC`. Freshness: `packages/mcp-server/src/service.ts` `corpusFreshness`; `packages/mcp-server/src/docs-freshness.test.ts` "a corpus past the limit warns once however many passes the breach lasts". "Vocabulary lock unchanged" is `[INFERENCE]`: the lock test was not read. |

## Requirements

- **WATCH-01** (a change reaches the plane within a lag, no command): met in code through the watcher and the sweep. Not delivered: no trigger is installed.
- **WATCH-02** (coalescing; restart re-ingests nothing unchanged): coalescing met. The restart part holds only with `SUBSTRATE_PLANNING_HASH_STORE=on`. Otherwise every restart re-ingests the planning pages.
- **WATCH-03** (no writes into repositories; hooks opt-in; hooks and watcher never fail git): met in code. `watch` always writes to the docs plane (documented in `docs/corpus-watch.md`).
- **WATCH-04** (a reconcile timer finds changes no trigger saw, including a push from another machine, through a managed mirror): PARTIAL. The sweep finds remote-only pushes through the mirror (`sync.test.ts`, "ingests a remote-only push from the mirror"). No reconcile timer exists; `corpus reconcile` is manual (`infra/vps` contains no unit that runs it; `watch-loop.ts` does not call it).
- **WATCH-05** (outcome, lag and failures as events and metrics; a freshness breach raises `docs.freshness`): met in code. The gauge is last-write-wins and accepts any authenticated caller's `docs.sync` note (`reserved-actions.ts` does not reserve the action).

## Residual risks

- **Triggers are not running anywhere.** Until an operator installs them, nothing syncs automatically. The only automatic path after install is the sweep (900 s by default), so a push from another machine waits up to a sweep interval.
- **Hook set and naming.** No post-commit hint; the hint has no action name; the runbook and ROADMAP say otherwise (see the SUMMARY deviations).
- **Planning state location.** `planning_page_hashes` sits outside the manifest and outside the index archive (`index-store.migrate-contract.test.ts` allowlist). A lost table costs one re-ingest of the planning pages.
- **Migration step 39 always runs, and its repair statement runs on every boot** (`index-store.ts`, `PLANNING_HASH_TABLE_REPAIR`). It drops the table when its primary key lacks `destination`. This matters only for a database that took an earlier draft of step 39.
- **Forgeable lag gauge.** `docs.sync` is not a reserved action, so any authenticated caller can set `substrate.corpus.sync_lag_seconds`. Ingest is not affected.
- **Unscoped `execute` on reconcile.** `POST /corpus/reconcile` with `execute: true` needs an authenticated, non-VM-guest surface and the corpus gate, not the operator. The same as the phase 63 ingest.
- **Reconcile dry run uses the network.** It fetches every mirror first (`runReconcileCommand`, `fetchMirrors: true`).
- **Single process.** The per-repository lock is a file under the mirror directory, and each watcher is one process. Two watchers on one host are coordinated only by that lock and by the spool lock `[INFERENCE: not exercised]`.
- **Watch limit.** When the host runs out of inotify watches the watcher drops to sweep-only, and the loop reports it once (`watch-loop.test.ts`, "when the watch limit is hit the loop says so once and keeps sweeping").
- **Docs drift.** `docs/corpus-watch.md` and `docs/runbooks/corpus-sync.md` describe a `docs.changed` hint, a manifest-backed planning state and a reconcile schedule that the code does not have, as noted above.

## Operator-gated

- Installing the git hooks: `substrate corpus hook install --repo R`, per repository.
- Installing the watch service and the sweep timer, and the environment file they read (`docs/runbooks/corpus-sync.md`, section 3). Sandbox drop-ins are examples only.
- `SUBSTRATE_CORPUS=on` plus a LightRAG backend on the server. Without it every sync and reconcile answers `corpus.disabled` or `corpus.backend-unavailable`.
- `SUBSTRATE_PLANNING_HASH_STORE=on` and a rehearsal of migration step 39 on a restored dump (`docs/runbooks/rollback-compat.md`).
- A reconcile schedule, if one is wanted. None is staged.
- Any live sync, and any ingest it drives into production. None was run.
