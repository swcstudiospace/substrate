---
phase: 65-doc-watch
verified: 2026-11-05T00:14:02Z
status: gaps_found
score: 2/5 success criteria verified (1, 4); 3 PARTIAL (2, 3, 5)
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
  - "packages/mcp-server/src/event-sources.ts"
  - "packages/mcp-server/src/planning-hash-store.ts"
  - "packages/observability/src/instruments.ts"
  - "scripts/doctor-units.test.ts"
covered_digest: "v3:sha256:b43305c56f53b57bfc1c0bef989995a19638080ad4aff439e4c08fb23f873848"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 3/5
  gaps_closed:
    - "ProtectHome mismatch: the three corpus base units now ship ProtectHome=read-only (11a32402), matching their class A drop-ins; sandbox-dropins.test.ts asserts it"
    - "Reconcile drop-in purpose comment names the reconcile unit (9e71f263, re-checked at c40ffc9a)"
  gaps_remaining:
    - "Criterion 2: docs.changed wording (ROADMAP.md Phase 65 criterion 2) vs the unnamed {v, dir, at} hint; owner decision outstanding"
    - "Criterion 3: planning page state in table planning_page_hashes, not the manifest; owner decision outstanding"
  regressions: []
  reclassified:
    - "Criterion 5 was VERIFIED at 9e71f263. Re-audit at c40ffc9a (phase 70 sync-lag SLO, a4a9a8f0) shows the sync-lag breach raises the corpus-row breach only; the docs.freshness warning is driven by merge-trigger age and corpus ingest age, not by docs.sync lag_s. Now PARTIAL. Not a code regression: the link was never present."
gaps:
  - truth: "Criterion 2: a hook sends a bounded docs.changed hint, always exits 0, never overwrites a foreign hook"
    status: partial
    reason: "The hook installer and the hint writer are present and bounded (exit 0, timeout 10, foreign hook refused). The hint carries no action name: it is {v, dir, at} (packages/corpus/src/hints.ts writeHint), and no docs.changed action exists in packages/, scripts/ or the event vocabulary. The runbook says so (docs/runbooks/corpus-sync.md). The ROADMAP criterion 2 still states the docs.changed wording, so criterion 2 as written is not met. The hook set is post-merge, post-checkout, post-rewrite (CORPUS_HOOKS), with no post-commit hint."
    artifacts:
      - path: "packages/corpus/src/hints.ts"
        issue: "Hint body is {v, dir, at}; no docs.changed action name"
      - path: ".planning/ROADMAP.md"
        issue: "Phase 65 criterion 2 still says a hook sends a docs.changed hint"
    missing:
      - "Owner decision: either emit the hint as docs.changed, or record that the unnamed {v, dir, at} hint satisfies criterion 2 and amend the ROADMAP criterion to match"
  - truth: "Criterion 3: the planning refresh reads its state from the manifest, so a restart re-ingests nothing unchanged"
    status: partial
    reason: "Planning page hashes are kept in table planning_page_hashes (migration step 39, keyed by destination and path), not in the manifest corpus_documents. The in-memory planningHashes map is still the working set. The store is off by default (SUBSTRATE_PLANNING_HASH_STORE). Unchanged since 504da465."
    artifacts:
      - path: "packages/mcp-server/src/index-store.ts"
        issue: "Step 39 creates planning_page_hashes, outside the manifest"
      - path: "packages/mcp-server/src/planning-hash-store.ts"
        issue: "Separate port and adapters; not the manifest"
    missing:
      - "Move planning page state into the manifest, or record an owner decision accepting the separate table for criterion 3"
  - truth: "Criterion 5: each sync emits a docs.sync note and a lag metric; a breach raises the existing docs.freshness warning"
    status: partial
    reason: "The docs.sync note (event-sources row) and the lag gauge (substrate.corpus.sync_lag_seconds) exist. The breach does not raise docs.freshness. Phase 70 (a4a9a8f0) made a sync-lag breach a corpus-row breach ('sync' in SLO_BREACHES, log corpus.slo: breached sync) against SUBSTRATE_DOCS_SLO_SYNC_LAG_S. docs.freshness (packages/mcp-server/src/docs-freshness.ts) is driven by accepted merge-trigger age (lagging = trigger_lag_seconds >= lag threshold, line 148) and corpus ingest age (SUBSTRATE_CORPUS_FRESH_MAX_AGE_S). Neither reads docs.sync lag_s. Only grep evidence needed: no reference to docs.sync or lag_s in docs-freshness.ts."
    artifacts:
      - path: "packages/mcp-server/src/docs-freshness.ts"
        issue: "Warning state is computed from merge-trigger age only; docs.sync lag_s is not read"
      - path: "packages/corpus/src/slo.ts"
        issue: "Sync-lag breach ('sync') is a corpus-row breach, not a docs.freshness warning"
    missing:
      - "Owner decision: route the docs.sync lag breach to docs.freshness (with dedupe and recovery), or amend criterion 5 to the corpus-row breach decided in phase 70 criterion 3"
deferred: []
advisory: []
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: "Install the staged units and git hooks on the host, then run one sync and one reconcile dry run"
    expected: "Units start, hints spool under /var/lib/substrate/corpus-hints, the reconcile prints a dry-run plan with no writes"
    why_human: "Installation is an operator step (WATCH-04); no unit or hook is installed on any host, and no live sync was observed"
---

# Phase 65: Doc Watch Verification Report

**Phase Goal:** When documentation changes in a registered repository, the docs plane follows without anyone running a command, and a restart never re-ingests what has not changed.
**Verified:** 2026-11-05T00:14:02Z
**Head:** c40ffc9a (integration branch gsd/v18-int-all, worktree /root/src/worktrees/as-gsd-v18-all)
**Status:** gaps_found
**Re-verification:** Yes — re-audit at c40ffc9a after wave 6 (prior record: 9e71f263, gaps_found, 3/5)

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `corpus sync --repo R` plans and ingests only R; `corpus watch` debounces and coalesces a burst into one sync per repository | ✓ VERIFIED | Carried forward from 9e71f263 and 504da465. No change since 9e71f263 to `watch-commands.ts`, `coalesce.ts`, `watch.ts`, `sync.ts`. `sync.test.ts` was not part of this pass's targeted run; last passing run 504da465. |
| 2 | Default triggers write nothing into any repository; hooks are opt-in; hint is bounded, exits 0, never overwrites a foreign hook; `docs.changed` hint | ✗ FAILED (PARTIAL, see gaps) | Met: `install-git-hook.ts` refuses a foreign hook; the block runs `timeout 10 corpus hint` in the background and returns 0; `hints.ts` bounds the spool. Not met as worded: ROADMAP criterion 2 names a `docs.changed` hint; the written hint is `{v, dir, at}`; no such action exists. Owner decision open. |
| 3 | The planning refresh reads state from the manifest; a restart re-ingests nothing unchanged | ✗ FAILED (PARTIAL, see gaps) | Carried forward: `planning-hash-store.ts` and `index-store.ts` unchanged since 504da465. State is in `planning_page_hashes`, not the manifest. Restart protection holds only with `SUBSTRATE_PLANNING_HASH_STORE=on` (off by default). |
| 4 | Units `substrate-corpus-watch.service`, `substrate-corpus-sync.service`, `substrate-corpus-sync.timer` staged with Nice, idle I/O, CPUQuota, MemoryMax; watcher drops to sweep-only at the inotify limit; `corpus reconcile` reports a missing row and re-ingests only with `--execute`; reconcile fetches a managed mirror and reads its default-branch tree; one view per repository per sync | ✓ VERIFIED (staged, not installed) | Re-checked at c40ffc9a: all three service units carry `Nice=15`, `IOSchedulingClass=idle`, `CPUQuota=25%`, `MemoryMax=512M`, `ReadWritePaths=/var/lib/substrate/corpus-mirrors /var/lib/substrate/corpus-hints`. Since 9e71f263 the only unit change is `ProtectHome=false` → `read-only` on the three base units (11a32402), plus comments. `view.ts` reads the mirror tree (`git ls-tree -r -z`, then `cat-file --batch`). `watch.ts` sets `degraded: "inotify-limit"`. `runReconcileCommand` plans a dry run unless `--execute`. Timer `OnCalendar=*:0/15` (sync) and `04:43 UTC` (reconcile). Not installed on any host. |
| 5 | Each sync emits a `docs.sync` note (event-sources row) and a lag metric; a breach raises `docs.freshness` | ✗ FAILED (PARTIAL, reclassified; see gaps) | Present: `docs.sync` row in `event-sources.ts` (unchanged since 9e71f263); lag gauge `substrate.corpus.sync_lag_seconds` (`instruments.ts`, `sync-event.ts`). Not met: the sync-lag breach is a corpus-row breach from phase 70 (`SLO_BREACHES` includes `sync`, `SUBSTRATE_DOCS_SLO_SYNC_LAG_S`). `docs.freshness` reads merge-trigger age and corpus ingest age only. The 9e71f263 record marked this VERIFIED on the note and gauge alone; that is withdrawn. |

**Score:** 2/5 truths verified (1, 4); 3 PARTIAL (2, 3, 5); behavior_unverified 0

### Re-verification delta (c40ffc9a vs 9e71f263)

- Criterion 4: `ProtectHome` now `read-only` in all three base units (11a32402). This closes the ProtectHome mismatch recorded as an open item at 9e71f263; the unit and drop-in examples agree.
- Criterion 5: reclassified VERIFIED → PARTIAL. Trigger: phase 70 sync-lag SLO (a4a9a8f0, db4f98f6). Re-audit shows the breach path never reached `docs.freshness`.
- Criteria 2 and 3: unchanged; owner decisions open.
- Criterion 1: carried forward; no code change in its files.

### Deferred Items

None.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `infra/vps/substrate-corpus-watch.service` | staged unit, idle I/O, limits, read-only home | ✓ VERIFIED | `ProtectHome=read-only` (11a32402); Nice/idle/CPUQuota/MemoryMax present |
| `infra/vps/substrate-corpus-sync.service` | staged unit | ✓ VERIFIED | `ProtectHome=read-only` (11a32402) |
| `infra/vps/substrate-corpus-reconcile.service` | staged dry-run unit | ✓ VERIFIED | `ProtectHome=read-only` (11a32402); dry run by default |
| `infra/vps/substrate-corpus-sync.timer` | staged timer | ✓ VERIFIED | `OnCalendar=*:0/15`, `Persistent=true`; not installed |
| `infra/vps/substrate-corpus-reconcile.timer` | staged daily dry-run timer | ✓ VERIFIED | `OnCalendar=*-*-* 04:43:00 UTC`, `Persistent=true`; not installed |
| `infra/vps/substrate-corpus-reconcile.service.d/30-sandbox.conf.example` | example drop-in, class A | ✓ VERIFIED | Example only (`.example`); purpose comment names the reconcile unit; states `ProtectHome=read-only`, now matching the unit |
| `packages/collectors/src/install-git-hook.ts` | opt-in installer, refuses foreign hook | ✓ VERIFIED | Unchanged since 504da465 |
| `packages/corpus/src/hints.ts` | bounded hint writer | ✓ VERIFIED (wording ✗, criterion 2) | Writes `{v, dir, at}`; no action name |
| `packages/corpus/src/view.ts` | mirror tree read | ✓ VERIFIED | `git ls-tree -r -z` + `cat-file --batch`, cwd = mirror |
| `packages/corpus/src/watch.ts` | watcher, sweep-only fallback | ✓ VERIFIED | `degraded: "inotify-limit"` |
| `packages/mcp-server/src/event-sources.ts` | `docs.sync` and `docs.planning` rows | ✓ VERIFIED | Unchanged since 9e71f263 |
| `packages/mcp-server/src/planning-hash-store.ts` | planning state | ⚠️ PRESENT, not manifest (criterion 3) | Separate table |
| `packages/observability/src/instruments.ts` | lag gauge | ✓ VERIFIED | `substrate.corpus.sync_lag_seconds` |
| `scripts/doctor-units.test.ts` | unit inventory | ✓ VERIFIED | Passes (targeted run) |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `watch-commands.ts` | `runSync` | `repos: [R]` | ✓ WIRED | Carried forward |
| `install-git-hook.ts` | `corpus hint` | background `timeout 10` block, `return 0` | ✓ WIRED | Hints bounded |
| `sync-event.ts` | `slo.ts` (phase 70) | `recordSyncLag` (service.ts, server.ts) | ✓ WIRED | Feeds corpus row only |
| `docs-freshness.ts` | `docs.sync` lag_s | none | ✗ NOT_WIRED | Warning state reads merge-trigger age only (criterion 5) |
| `planning-hash-store.ts` | manifest `corpus_documents` | none | ✗ NOT_WIRED | Separate table (criterion 3) |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `view.ts` | repository tree | mirror `git ls-tree` | Yes | ✓ FLOWING |
| `slo.ts` corpus row | `syncLag` | newest stored `docs.sync` note | Yes, when a note exists; `null` until one | ✓ FLOWING (row only) |
| `docs-freshness.ts` warning | `lagging` | accepted merge-trigger age | Yes; not the sync lag | ✓ FLOWING (different signal) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Units ship read-only home and the drop-ins agree (new test) | `env -u SUBSTRATE_TEST_PG_URL bun test scripts/sandbox-dropins.test.ts scripts/doctor-units.test.ts scripts/doctor-sandbox.test.ts packages/mcp-server/src/planning-hash-store.test.ts` | 108 pass, 3 skip, 0 fail (4 files, 111 tests, 2.5 s) | ✓ PASS |
| Sync-lag breach is a corpus-row breach only | read `packages/corpus/src/slo.ts` `sloBreaches`; grep `docs.sync|lag_s` in `docs-freshness.ts` | no reference in `docs-freshness.ts`; `sync` breach only in `SLO_BREACHES` | ✗ FAIL (criterion 5) |

### Probe Execution

No probe declared for this phase (`scripts/*/tests/probe-*.sh` not referenced in PLAN, SUMMARY or CONTEXT; grep this pass). Skipped.

### Requirements Coverage

Mapped to the phase success criteria (REQUIREMENTS.md text not re-read in this pass):

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| WATCH-01 | none (no PLAN) | sync and watch, one sync per repository | ✓ SATISFIED | Criterion 1 |
| WATCH-02 | none | opt-in hooks, bounded hints | ✗ BLOCKED (wording) | Criterion 2 |
| WATCH-03 | none | planning state in the manifest | ✗ BLOCKED (location) | Criterion 3 |
| WATCH-04 | none | staged units and reconcile | ✓ SATISFIED (staged, not installed) | Criterion 4 |
| WATCH-05 | none | `docs.sync` note and lag breach to `docs.freshness` | ✗ BLOCKED (breach route) | Criterion 5 |

### Anti-Patterns Found

Changed files since 9e71f263 (`infra/vps` units, `scripts/sandbox-dropins.test.ts`) scanned for `TBD|FIXME|XXX|TODO|HACK`: none. No new debt markers in covered files.

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| none | - | - | - | - |

### Human Verification Required

1. **Install and run the staged triggers** — install the units and git hooks on the host, run one sync and one reconcile dry run. Expected: units start, hints spool under `/var/lib/substrate/corpus-hints`, reconcile prints a dry-run plan with no writes. Why human: operator step; nothing installed; no live sync observed.

### Gaps Summary

Criteria 2, 3 and 5 are PARTIAL against their wording. Criterion 2 and 3 are owner decisions carried from 9e71f263. Criterion 5 is new in this record: the phase 70 sync-lag breach does not reach `docs.freshness`, so the 9e71f263 VERIFIED was too generous. Criterion 4 is verified as staged; the ProtectHome mismatch is closed.

### Open Items (owner decisions, not verifier-closable)

1. Criterion 2: `docs.changed` wording (ROADMAP Phase 65 criterion 2) vs the unnamed `{v, dir, at}` hint. Emit the name, or record acceptance and amend the ROADMAP criterion.
2. Criterion 3: planning page state in `planning_page_hashes` rather than the manifest.
3. Criterion 5: route the docs.sync lag breach to `docs.freshness`, or amend criterion 5 to the corpus-row breach (`SUBSTRATE_DOCS_SLO_SYNC_LAG_S`, phase 70 criterion 3). New at c40ffc9a.
4. `docs.sync` reserved-action status (held, `RESERVED_NOTE_ACTIONS` in `reserved-actions.ts`).
5. `covered_files` kept verbatim from the record. `scripts/sandbox-dropins.test.ts` (changed in 11a32402, carries the ProtectHome assertion) is not in the list; add it on the next record if the owner wants it fingerprinted.
6. Operator install of the staged units, hooks and timers (WATCH-04). Not verifier-closable.

Closed since 9e71f263: ProtectHome mismatch between the units and the drop-ins (11a32402).

### PG counts per file

- `packages/mcp-server/src/planning-hash-store.test.ts`: Postgres-gated (`describeLive` when `SUBSTRATE_TEST_PG_URL` is set). No database was assigned to this item: the live block was not run. Non-PG run at c40ffc9a with the variable unset: 3 skip, 0 fail (the file's non-live tests pass within the 108-pass total). Prior live evidence at 504da465: 29 pass, 3 skip, 0 fail across `sync.test.ts` and this file.
- `scripts/doctor-sandbox.test.ts`, `scripts/sandbox-dropins.test.ts`, `scripts/doctor-units.test.ts`: no PG gate. Run with the variable unset: part of the 108 pass, 0 fail.

### Scope of this pass

Changed since 9e71f263 in phase 65's covered files: `infra/vps/substrate-corpus-{watch,sync,reconcile}.service` (11a32402, ProtectHome only, plus comments). Changed outside the covered list and re-audited because it touches criterion 5: phase 70 sync-lag SLO (`packages/corpus/src/slo.ts`, `packages/mcp-server/src/corpus/slo.ts`, `packages/mcp-server/src/corpus/telemetry.ts`, `a4a9a8f0`, `db4f98f6`) and the dashboard panel. Changed elsewhere and not touching a phase 65 criterion: `packages/collectors/src/worktree-graph.ts` (comment, phase 68), `packages/mcp-server/src/corpus/telemetry.ts` (steering query text, phase 66). Carried forward.

---

_Verified: 2026-11-05T00:14:02Z_
_Verifier: Claude (gsd-verifier), reverify3-3, worktree /root/src/worktrees/as-gsd-v18-all, head c40ffc9a_
