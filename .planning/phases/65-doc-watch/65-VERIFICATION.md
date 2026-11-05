---
phase: 65-doc-watch
verified: 2026-11-05T01:19:50Z
status: human_needed
score: 5/5 must-haves verified (success criteria 1-5, SC2 and SC3 against the 2026-11-04 amended text)
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
  - "packages/mcp-server/src/event-sources.ts"
  - "packages/mcp-server/src/flag-registry.ts"
  - "packages/mcp-server/src/planning-hash-store.ts"
  - "packages/mcp-server/src/service.ts"
  - "packages/observability/src/instruments.ts"
  - "scripts/doctor-units.test.ts"
  - "scripts/sandbox-dropins.test.ts"
covered_digest: "v3:sha256:b738b1fe42562d182165e6cc13ea6439c3e807df8efd42d1db839ad7472cbff5"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 2/5
  gaps_closed:
    - "Criterion 2 (amended 2026-11-04, owner decision d): the hook writes the bounded hint {v, dir, at} with no action name; installer, hint writer and tests match the amended text"
    - "Criterion 3 (amended 2026-11-04, owner decision d): planning state lives in planning_page_hashes; the two-server restart test passes"
    - "Criterion 5 (commit 42dcb4c6, owner decision 2026-11-04): the corpus row of docs.freshness names sync_lag when the newest docs.sync lag is over SUBSTRATE_DOCS_SLO_SYNC_LAG_S; the flag text and runbook say so; tests pass"
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
**Verified:** 2026-11-05T01:19:50Z
**Head:** ca9d02ec (integration branch gsd/v18-int-all, worktree /root/src/worktrees/as-gsd-v18-all)
**Status:** human_needed
**Re-verification:** Yes. Prior record: c40ffc9a, gaps_found, 2/5. Criteria 2 and 3 are judged against the owner-amended text (2026-11-04); criterion 5 is judged after commit 42dcb4c6 (owner decision 2026-11-04).

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `corpus sync --repo R` plans and ingests only R; `corpus watch` debounces and coalesces a burst into one sync per repository | ✓ VERIFIED | `packages/corpus/src/coalesce.ts` (trailing debounce, maximum wait, one running sync per repository); `watch.ts` marks repositories dirty and reads nothing. Behavioural tests pass: `coalesce.test.ts` ("a burst of signals costs one sync"; "a signal during a running sync makes exactly one more sync"), `watch.test.ts` ("a burst of events through the watcher and the coalescer is one sync"), `packages/cli/src/corpus/sync.test.ts` and `watch-commands.test.ts` (no Postgres gate; all ran). Code in these files unchanged since c40ffc9a |
| 2 | (amended) Default triggers write nothing into any repository; the git hooks are an opt-in installer adding post-merge, post-checkout and post-rewrite hints beside the post-commit collector; a hook writes a bounded hint `{v, dir, at}` with no action name, always exits 0, and never overwrites a foreign hook | ✓ VERIFIED (amended text) | `install-git-hook.ts`: `CORPUS_HOOKS = post-merge, post-checkout, post-rewrite`; a foreign hook is reported `foreign` and left byte-for-byte (`install-git-hook.test.ts` line 103 and 147); the block runs `timeout 10 … corpus hint --repo "$top"` in the background and ends `return 0` (test line 194: exits 0 whatever the command does). `hints.ts` `writeHint` writes `{v, dir, at}` (no action name, `docs.changed` appears nowhere in code), bounded by the spool file cap (`hints.test.ts`). The watcher and view write nothing into a checkout (`watch.test.ts` "reads nothing"; `view.test.ts` "writes nothing into the checkout") |
| 3 | (amended) The server's planning refresh keeps its state in `planning_page_hashes`, not the manifest, so a restart re-ingests nothing unchanged (test with two server instances over one store) | ✓ VERIFIED (amended text) | `service.ts` 7342–7359: `loadPlanningHashes` / `planningIngestTrigger` / `savePlanningHashes` through `PlanningHashStore`; `index-store.ts` step 39 creates `planning_page_hashes`; `planning-hash-store.ts` holds the port, the memory adapter and the Postgres adapter. Test "a second server over the same store ingests nothing unchanged, and exactly the changed page after an edit" (`planning-hash-store.test.ts` line 125, outside the Postgres gate) passes. Caveats in Open Items 2 and 3 (flag default off; the Postgres adapter's live block not run) |
| 4 | Units `substrate-corpus-watch.service`, `substrate-corpus-sync.service` and `substrate-corpus-sync.timer` are staged with Nice, an idle I/O class, CPUQuota and MemoryMax; the watcher drops to sweep-only at the inotify limit; `corpus reconcile` reports a missing row and re-ingests only with `--execute`; reconcile fetches a managed mirror and reads its default-branch tree; one view per repository per sync | ✓ VERIFIED (staged, not installed) | All three base units: `Nice=15`, `IOSchedulingClass=idle`, `CPUQuota=25%`, `MemoryMax=512M`, `ReadWritePaths=/var/lib/substrate/corpus-mirrors /var/lib/substrate/corpus-hints`, `ProtectHome=read-only` (watch 41–54, sync 29–39, reconcile 32–42). Timers: sync `OnCalendar=*:0/15`, reconcile `04:43 UTC`, both `Persistent=true`. Watcher: `degraded: "inotify-limit"` closes every watch (`watch.test.ts` "the inotify limit closes every watch and leaves the command in sweep-only mode"). Reconcile dry run is the default; `execute` needed to act (`reconcile.test.ts` "a dry run reports the missing row and the orphan and changes nothing"; "execute marks the missing row removed…"). Mirror tree read via `git ls-tree` / `cat-file` (`view.test.ts` "shows a remote-only push although the checkout did not move"). `doctor-units`, `sandbox-dropins` and `doctor-sandbox` tests ran and pass. The reconcile, view and mirror tests were not re-run in this pass; their code is unchanged since c40ffc9a (Open Item 6) |
| 5 | Each sync emits a `docs.sync` note (event-sources row, vocabulary lock unchanged) and a lag metric; a breach raises the existing `docs.freshness` warning | ✓ VERIFIED | Note: `event-sources.ts` row `docs.sync` (line 1551, action `docs.sync`), `cli/corpus/events.ts` emits `lag_s`; lag measured from the first change signal to the end of the sync (`cli/corpus/sync.ts` line 312). Server: a stored note calls `corpusSlo.recordSyncLag` (`service.ts` 2961). Gauge: `substrate.corpus.sync_lag_seconds` (`observability/src/instruments.ts` 734). Warning: `docs-freshness.ts` `corpusFreshnessRow` adds `sync_lag` when the newest lag is strictly over `syncLagMaxS`; `lagWarningEvent` emits `kind: warning`, `payload.action: docs.freshness`, `dataset: corpus`, `breaches: ["sync_lag"]` (or both with `ingest_age`), `sync_lag_seconds`, `sync_threshold_seconds`, summary "sync lag N s, over the M s objective"; `lagRecoveryEvent` emits the recovery note. `service.ts` `corpusFreshness` (7483–7491) judges sync when `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` is set, even at `SUBSTRATE_CORPUS_FRESH_MAX_AGE_S=0`. Tests (ran, pass): `docs-freshness.test.ts` 1053 ("over, on, under, unset": one warning, one recovery note, no event on or under or unset) and 1085 ("age only; age plus sync; sync alone"); `corpus/slo.test.ts` 436–456 (a stored `docs.sync` note moves the reading) |

**Score:** 5/5 truths verified (0 partial, 0 failed); behavior_unverified 0

### Deferred Items

None.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `infra/vps/substrate-corpus-watch.service` | staged watcher, idle I/O, limits, read-only home | ✓ VERIFIED | Lines 41–54 |
| `infra/vps/substrate-corpus-sync.service` | staged sweep unit | ✓ VERIFIED | Lines 29–39 |
| `infra/vps/substrate-corpus-reconcile.service` | staged dry-run unit | ✓ VERIFIED | Lines 32–42; dry run unless `--execute` |
| `infra/vps/substrate-corpus-sync.timer` / `…-reconcile.timer` | staged timers | ✓ VERIFIED | Not installed |
| `…-reconcile.service.d/30-sandbox.conf.example` | class A drop-in example | ✓ VERIFIED | Example only; matches `ProtectHome=read-only` |
| `packages/collectors/src/install-git-hook.ts` | opt-in hook installer | ✓ VERIFIED | Refuses foreign hook; background, exit 0 |
| `packages/corpus/src/hints.ts` | bounded hint spool | ✓ VERIFIED | `{v, dir, at}` |
| `packages/corpus/src/view.ts`, `mirror.ts` | mirror tree read | ✓ VERIFIED | Carried forward; no change since c40ffc9a |
| `packages/corpus/src/watch.ts`, `coalesce.ts` | watcher and coalescer | ✓ VERIFIED | Tests pass |
| `packages/mcp-server/src/docs-freshness.ts` | corpus sync-lag breach in the docs.freshness warning | ✓ VERIFIED | `corpusFreshnessRow`, `lagWarningEvent`, `lagRecoveryEvent` |
| `packages/mcp-server/src/service.ts` | `corpusFreshness` reads the sync objective | ✓ VERIFIED | 7483–7491 |
| `packages/mcp-server/src/flag-registry.ts` | flag text for `SUBSTRATE_CORPUS_FRESH_MAX_AGE_S` and `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` | ✓ VERIFIED | Text states that a set sync objective is judged at age 0 |
| `packages/mcp-server/src/event-sources.ts` | `docs.sync` and `docs.planning` rows | ✓ VERIFIED | 1551, 1584 |
| `packages/mcp-server/src/planning-hash-store.ts` | planning state adapter | ✓ VERIFIED | Table `planning_page_hashes`, not the manifest (as amended) |
| `packages/observability/src/instruments.ts` | lag gauge | ✓ VERIFIED | `substrate.corpus.sync_lag_seconds` |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `watch-commands.ts` | `runSync` | `repos: [R]` | ✓ WIRED | Carried forward; unchanged |
| `install-git-hook.ts` | `corpus hint` | background `timeout 10` block, `return 0` | ✓ WIRED | Test line 194 |
| `hints.ts` | spool read by the watch loop | `readHints` | ✓ WIRED | Carried forward |
| `service.ts` planning refresh | `planning_page_hashes` store | `loadPlanningHashes` / `savePlanningHashes` (flag on) | ✓ WIRED | Off by default (Open Item 2) |
| `event-sources.ts` `docs.sync` | ledger note | `POST /events` → `recordSyncLag` on stored | ✓ WIRED | `service.ts` 2961 |
| `corpusSlo.readings` (sync lag) | `corpusFreshnessRow` | `service.ts` 7491 | ✓ WIRED | Judged against `config.docsSlo.syncLagS` |
| `corpusFreshnessRow` breach | `docs.freshness` warning | `settleDocsLag` → `LagSettler` → `lagWarningEvent` | ✓ WIRED | `service.ts` 7468–7474 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `view.ts` | repository tree | mirror `git ls-tree` | Yes | ✓ FLOWING |
| `docs-freshness.ts` corpus row | `syncLagS` | newest stored `docs.sync` note (`lag_s`), recorded by `corpusSlo` | Yes, when a note exists; no note means no sync breach | ✓ FLOWING |
| `docs-freshness.ts` corpus row | `lastIngestAt` | manifest `status()` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Sync-lag breach raises, recovers and stays silent on or under the objective; the age and sync combinations | `env -u SUBSTRATE_TEST_PG_URL bun test packages/mcp-server/src/docs-freshness.test.ts packages/mcp-server/src/corpus/slo.test.ts packages/mcp-server/src/corpus/sync-event.test.ts` | 80 pass, 0 fail (3 files, 1.08 s) | ✓ PASS |
| SC1–SC4 targeted run: hook installer, hint spool, watcher, coalescer, sync, watch commands, planning restart test, unit and drop-in checks | `env -u SUBSTRATE_TEST_PG_URL bun test packages/collectors/src/install-git-hook.test.ts packages/corpus/src/hints.test.ts packages/corpus/src/watch.test.ts packages/corpus/src/coalesce.test.ts packages/cli/src/corpus/sync.test.ts packages/cli/src/corpus/watch-commands.test.ts packages/mcp-server/src/planning-hash-store.test.ts scripts/sandbox-dropins.test.ts scripts/doctor-units.test.ts scripts/doctor-sandbox.test.ts` | 200 pass, 3 skip (the Postgres-gated live block), 0 fail (10 files, 16.4 s) | ✓ PASS |

### Probe Execution

No probe declared for this phase (no `scripts/*/tests/probe-*.sh` referenced in the PLAN, SUMMARY or CONTEXT). Skipped.

### Requirements Coverage

No PLAN file exists for this phase (`Plans: none written`). Requirement IDs are taken from ROADMAP and REQUIREMENTS.md text, which numbers them differently from the criteria, so each row names its criterion.

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| WATCH-01 | none | a change in a registered repository reaches the docs plane with no manual command | ✓ SATISFIED | SC1 (watch, coalesce, sync) |
| WATCH-02 | none | a burst costs one sync per repository; a restart re-ingests nothing unchanged | ✓ SATISFIED | SC1 (coalesce) and SC3 (two-server restart test; flag on) |
| WATCH-03 | none | default triggers write nothing; git hooks opt-in; hooks and watcher never block or fail a git command | ✓ SATISFIED | SC2 (amended text) |
| WATCH-04 | none | reconcile timer finds changes no trigger saw, through a managed mirror | ✓ SATISFIED (staged, not installed) | SC4 |
| WATCH-05 | none | a sync reports outcome, lag and failures as events and metrics; a freshness breach raises `docs.freshness` | ✓ SATISFIED | SC5 (note, gauge, warning); outcome event in `cli/corpus/events.ts` |

No orphaned requirements: REQUIREMENTS.md maps WATCH-01 to WATCH-05 to phase 65 and all five appear above.

### Anti-Patterns Found

Scan of the covered files for `TBD|FIXME|XXX` (no match) and `TODO|HACK|PLACEHOLDER`: the only hits are `SRC_PLACEHOLDER` and `CLI_PLACEHOLDER` in `install-git-hook.ts`, which are substitution tokens in the baked hook template, not stubs. No debt marker blocks this phase.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/collectors/src/install-git-hook.ts` | 37, 155 | `*_PLACEHOLDER` tokens | ℹ️ Info | Template substitution; not a stub |
| `packages/mcp-server/src/event-sources.ts` / `reserved-actions.ts` | — | `docs.sync` not in `RESERVED_NOTE_ACTIONS` | ⚠️ Warning | Any authenticated caller can post a `docs.sync` note and move the lag reading and the warning (Open Item 4) |

### Human Verification Required

1. **Install the staged triggers and run one sync and one reconcile dry run**
   - **Test:** Install the three units and two timers, the opt-in hooks (`corpus hook install --corpus` for chosen repositories), then run `corpus watch --once` and `corpus reconcile`.
   - **Expected:** Units start; hints spool under the corpus-hints directory and are consumed; the reconcile prints a dry-run plan with no writes; a `docs.sync` note reaches the ledger.
   - **Why human:** Operator installation (WATCH-03 opt-in, WATCH-04). Nothing is installed on any host and no live sync was observed.

### Gaps Summary

No gaps. Criteria 2 and 3 are judged against the owner-amended text and match it. Criterion 5 now routes the sync-lag breach to `docs.freshness` (42dcb4c6), and the previous PARTIAL is closed. Criterion 1 and criterion 4 are unchanged code since c40ffc9a and remain verified. Status is `human_needed` only because the operator install is a human step.

### Open Items

1. Operator install of the staged units, timers and hooks (WATCH-03 opt-in, WATCH-04). Not verifier-closable.
2. `SUBSTRATE_PLANNING_HASH_STORE` defaults to `off` (`flag-registry.ts`). In the default configuration a restart re-ingests unchanged planning pages (`planning-hash-store.test.ts` line 154). Criterion 3 holds with the flag on. Owner decision needed on enabling it by default.
3. The Postgres-gated block of `planning-hash-store.test.ts` (3 tests, `describeLive`) did not run: no database was assigned to this item. The table persistence leg is verified only through the memory adapter. Live counts: 0 pass, 3 skip.
4. `docs.sync` is not in `RESERVED_NOTE_ACTIONS` (`reserved-actions.ts`). Owner decision recorded as "reservation held", so the status quo stands. Consequence: a `docs.sync` note with a large `lag_s` posted by any authenticated caller raises the corpus warning.
5. `covered_files` was extended in this pass with `docs-freshness.ts`, `docs-freshness.test.ts`, `service.ts`, `flag-registry.ts` and `scripts/sandbox-dropins.test.ts` (prior record item 5). `planning-hash-store.test.ts` is not fingerprinted, as before.
6. Carried forward, not re-run in this pass: `reconcile.test.ts`, `view.test.ts`, `mirror.test.ts`, `sync-event.test.ts` beyond the SC5 run. Their code is unchanged since c40ffc9a.
7. Information: the sync-lag reading is the last reported lag and does not age. If syncs stop, a breach stays until a sync reports within the objective. This matches the phase 70 SLO semantics. A sync breach is also not raised while the manifest has never ingested (`corpusFreshnessRow` returns null).

### PG counts per file

- `packages/mcp-server/src/planning-hash-store.test.ts`: Postgres-gated (`describeLive` when `SUBSTRATE_TEST_PG_URL` is set). No database assigned: 0 pass, 3 skip, with the variable unset. The non-gated tests in the file, including the two-server restart test, pass within the 200 pass.
- `scripts/doctor-units.test.ts`, `scripts/doctor-sandbox.test.ts`, `scripts/sandbox-dropins.test.ts`: no PG gate. Ran with the variable unset: pass.
- `packages/cli/src/corpus/sync.test.ts`: no PG gate (grep count 0). Ran with the variable unset: pass.

### Scope of this pass

HEAD ca9d02ec. Changed since c40ffc9a in the phase 65 covered paths: `docs-freshness.ts`, `docs-freshness.test.ts`, `service.ts` (`corpusFreshness` only), `flag-registry.ts` (flag text), `docs/runbooks/corpus-sync.md`, `docs/corpus-eval.md` (42dcb4c6). No change to `infra/vps`, `packages/cli/src/corpus`, `packages/corpus/src`, `install-git-hook.ts`, `hints.ts`, `planning-hash-store.ts`, `index-store.ts` or `event-sources.ts` since c40ffc9a.

---

_Verified: 2026-11-05T01:19:50Z_
_Verifier: Claude (gsd-verifier), reverify4-1, worktree /root/src/worktrees/as-gsd-v18-all, head ca9d02ec_
