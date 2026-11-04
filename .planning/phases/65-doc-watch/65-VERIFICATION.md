---
phase: 65-doc-watch
verified: 2026-11-04T23:05:32Z
status: gaps_found
score: 3/5 success criteria verified (1, 4, 5); 2 PARTIAL (2, 3); WATCH-04 reconcile timer staged in infra/vps, not installed
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
covered_digest: "v3:sha256:ba1ec4bb47f6575b9214b2a095a9abab72c787ac29cf8efc2b9861ecfc6f2830"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 3/5
  gaps_closed:
    - "Criterion 2 artifact: docs/runbooks/corpus-sync.md line 15 named a docs.changed hint; now states the hint is {v, dir, at} with no action name (9e71f263)"
    - "Runbook section 5 described a weekly manual reconcile; now describes the staged daily dry-run timer (9e71f263)"
    - "Reconcile drop-in example purpose comment named the doc-watch sweep; now names the reconcile unit (9e71f263)"
  gaps_remaining:
    - "Criterion 2: docs.changed wording (ROADMAP.md line 1112) still unresolved; owner decision outstanding"
    - "Criterion 3: planning page state in table planning_page_hashes, not the manifest; owner decision outstanding"
  regressions: []
gaps:
  - truth: "Criterion 2: a hook sends a bounded docs.changed hint, always exits 0, never overwrites a foreign hook"
    status: partial
    reason: "The hook installer and the hint writer are present and bounded (exit 0, timeout 10, foreign hook refused). The hint carries no action name: it is {v, dir, at} (hints.ts writeHint line 109), and no docs.changed action exists in packages/, scripts/ or the event vocabulary. The runbook now says so (9e71f263). ROADMAP.md line 1112 still states the docs.changed wording, so criterion 2 as written is not met. The hook set is post-merge, post-checkout, post-rewrite (CORPUS_HOOKS), with no post-commit hint."
    artifacts:
      - path: "packages/corpus/src/hints.ts"
        issue: "Hint body is {v, dir, at}; no docs.changed action name"
      - path: ".planning/ROADMAP.md"
        issue: "Criterion 2 (line 1112) still says a hook sends a docs.changed hint"
    missing:
      - "Owner decision: either emit the hint as docs.changed, or record that the unnamed {v, dir, at} hint satisfies criterion 2 and amend ROADMAP.md line 1112 to match"
  - truth: "Criterion 3: the planning refresh reads its state from the manifest, so a restart re-ingests nothing unchanged"
    status: partial
    reason: "Planning page hashes are kept in table planning_page_hashes (migration step 39, keyed by destination and path), not in the manifest corpus_documents. The in-memory planningHashes map is still the working set. The store is off by default (SUBSTRATE_PLANNING_HASH_STORE, flag-registry.ts). The SUMMARY records this as D65-2 changed. Not changed since 504da465."
    artifacts:
      - path: "packages/mcp-server/src/index-store.ts"
        issue: "Step 39 creates planning_page_hashes, outside the manifest"
      - path: "packages/mcp-server/src/planning-hash-store.ts"
        issue: "Separate port and adapters; not the manifest"
    missing:
      - "Move planning page state into the manifest, or record an owner decision accepting the separate table for criterion 3"
---

# Phase 65: Doc Watch Verification Report

**Phase Goal:** When documentation changes in a registered repository, the docs plane follows without anyone running a command, and a restart never re-ingests what has not changed.
**Verified:** 2026-11-04T23:05:32Z
**Head:** 9e71f263 (integration branch gsd/v18-int-all, worktree /root/src/worktrees/as-gsd-v18-all)
**Status:** gaps_found
**Re-verification:** Yes — re-audit at 9e71f263 after the runbook and drop-in example corrections (prior record: 504da465, gaps_found, 3/5)

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `corpus sync --repo R` plans and ingests only R; `corpus watch` debounces and coalesces a burst into one sync per repository | ✓ VERIFIED | Carried forward from 504da465: no code in the truth's files changed in 504da465..9e71f263. `watch-commands.ts` passes `repos: [R]` to `runSync`; `coalesce.ts` and `watch.ts` unchanged. `sync.test.ts` passed at 504da465 (remote-only push ingested from the mirror, nothing written into the checkout; second sync idempotent). Not re-run this pass. |
| 2 | Default triggers write nothing into any repository; hooks are opt-in; hint is bounded, exits 0, never overwrites a foreign hook; `docs.changed` hint | ✗ FAILED (PARTIAL, see gaps) | Met: `install-git-hook.ts` refuses a foreign hook, the block runs `timeout 10 corpus hint` in the background and `return 0`; `hints.ts` bounds the spool. Changed this pass: runbook line 15 now describes the hint as `{v, dir, at}` with no action name (matches `writeHint`). Not met as worded: ROADMAP.md line 1112 still requires a `docs.changed` hint; no such action exists; no post-commit hint entry. Owner decision open. |
| 3 | The planning refresh reads state from the manifest; a restart re-ingests nothing unchanged | ✗ FAILED (PARTIAL, see gaps) | Carried forward: `planning-hash-store.ts`, `index-store.ts` unchanged since 504da465. State is in `planning_page_hashes`, not the manifest. Restart protection holds only with `SUBSTRATE_PLANNING_HASH_STORE=on` (off by default). The prior in-memory run (`planning-hash-store.test.ts`, 3 skipped) is not repeated: no database supplied (see PG counts). |
| 4 | Units `substrate-corpus-watch.service`, `substrate-corpus-sync.service`, `substrate-corpus-sync.timer` staged with Nice, idle I/O, CPUQuota, MemoryMax; watcher drops to sweep-only at the inotify limit; `corpus reconcile` reports a missing row and re-ingests only with `--execute`; reconcile fetches a managed mirror and reads its default-branch tree; one view per repository per sync | ✓ VERIFIED (staged, not installed) | Units unchanged since 504da465. `view.ts` reads the mirror tree (`git ls-tree -r -z`, then `cat-file --batch`, cwd = mirror). `watch.ts` sets `degraded: "inotify-limit"`. `runReconcileCommand` (watch-commands.ts) plans a dry run unless `--execute`. Reconcile unit: `ExecStart=... corpus reconcile --json` (no `--execute`), `Nice=15`, `IOSchedulingClass=idle`, `CPUQuota=25%`, `MemoryMax=512M`, `ProtectSystem=strict`. Changed this pass: runbook section 5 now describes the staged daily dry-run timer and the operator steps; the claims match `substrate-corpus-reconcile.timer` and `.service`. |
| 5 | Each sync emits a `docs.sync` note (event-sources row) and a lag metric; a breach raises `docs.freshness` | ✓ VERIFIED (code; the reserved decision is held) | Carried forward: `event-sources.ts` row `docs.sync` (line 1551) and `docs.planning` (line 1584); `docs/event-vocabulary.md` lines 121-122; lag gauge in `sync-event.ts` and `instruments.ts`. `docs.sync` is absent from `RESERVED_NOTE_ACTIONS` (`reserved-actions.ts` lines 23-33): held, see open items. |

**Score:** 3/5 truths verified (1, 4, 5); 2 PARTIAL (2, 3); behavior_unverified 0

### WATCH-04 reconcile timer

- `infra/vps/substrate-corpus-reconcile.timer`: `OnCalendar=*-*-* 04:43:00 UTC`, `Persistent=true`, `Unit=substrate-corpus-reconcile.service`. Staged, not installed. Its comment names the operator steps in `docs/runbooks/corpus-sync.md`.
- `infra/vps/substrate-corpus-reconcile.service`: oneshot; dry run by default; `ReadWritePaths=/var/lib/substrate/corpus-mirrors /var/lib/substrate/corpus-hints`; `ProtectHome=false` (see open items).
- `infra/vps/substrate-corpus-reconcile.service.d/30-sandbox.conf.example`: example only (`.example` suffix), class A, ceiling 5.0. Changed this pass (9e71f263): the purpose comment now names the reconcile unit instead of the doc-watch sweep. Its comment still says `ProtectHome=read-only`; the unit has `ProtectHome=false`. The example is not installed; the mismatch is an open owner decision.
- `scripts/doctor-units.test.ts` lists the reconcile unit in the inventory. Re-run this pass with the drop-in tests: 100 pass, 0 fail across `doctor-sandbox.test.ts`, `sandbox-dropins.test.ts`, `doctor-units.test.ts`.
- WATCH-04 code status: the reconcile timer exists and is a dry run by default. The timer is not installed on any host, so no scheduled reconcile runs.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `infra/vps/substrate-corpus-watch.service` | watch unit, sweep-only fallback | ✓ VERIFIED (staged) | Unchanged since 504da465 |
| `infra/vps/substrate-corpus-sync.service` and `.timer` | sweep, 15-minute OnCalendar, Persistent | ✓ VERIFIED (staged) | Unchanged since 504da465; `Slice=substrate.slice` |
| `infra/vps/substrate-corpus-reconcile.service` and `.timer` | daily dry-run reconcile | ✓ VERIFIED (staged) | Dry run by default; not installed |
| `infra/vps/substrate-corpus-reconcile.service.d/30-sandbox.conf.example` | sandbox drop-in example | ✓ VERIFIED (example) | Comment corrected 9e71f263; inventory and parser tests pass (100 pass, this pass) |
| `packages/corpus/src/hints.ts` | bounded hint spool | ✓ VERIFIED (partial vs wording) | Hint is `{v, dir, at}`; no action name |
| `packages/collectors/src/install-git-hook.ts` | opt-in hook installer | ✓ VERIFIED | Refuses foreign hook; exit 0; timeout 10 |
| `packages/mcp-server/src/planning-hash-store.ts` | planning hash store | ✗ PARTIAL | Table, not manifest (criterion 3) |
| `packages/mcp-server/src/event-sources.ts` | `docs.sync` and `docs.planning` rows | ✓ VERIFIED | Lines 1551, 1584 |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `watch-commands.ts` reconcile | `reconcileCorpus` (server) | `ctx.client.reconcile({ execute })` | ✓ WIRED | Dry run unless `--execute` |
| `reconcile.service` | `corpus reconcile --json` | `ExecStart` | ✓ WIRED | No `--execute` in ExecStart |
| `view.ts` | mirror default-branch tree | `git ls-tree -r -z` and `cat-file --batch` in mirror cwd | ✓ WIRED | Checkout not read |
| `hook` block | `corpus hint` | `timeout 10 ... corpus hint` | ✓ WIRED | Background, exit 0 |
| planning refresh | `planning_page_hashes` | `planningHashStore` | ⚠️ WIRED to table, not manifest | Criterion 3 gap |
| `docs.sync` note | lag gauge | `sync-event.ts` to `instruments.ts` | ✓ WIRED | Forgeable: `docs.sync` not reserved |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `runReconcileCommand` | drift | server `POST /corpus/reconcile` | Yes (route in `server.ts`) | ✓ FLOWING |
| `view.ts` | tree entries | `git ls-tree` in the mirror | Yes | ✓ FLOWING |
| lag gauge | `lag_s` | `docs.sync` note body | Yes, but caller-supplied | ⚠️ FLOWING, untrusted input |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Drop-in example and unit inventory after the example comment change (this pass) | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 scripts/doctor-sandbox.test.ts scripts/sandbox-dropins.test.ts scripts/doctor-units.test.ts` | 100 pass, 0 fail, 1047 expects, 5.22 s | ✓ PASS |
| Reconcile dry run default; remote-only push via mirror; planning restart on in-memory store | Recorded at 504da465 (`watch-commands.test.ts` 120 pass across four files; `sync.test.ts` + `planning-hash-store.test.ts` 29 pass, 3 skip, 0 fail). Not re-run this pass: the inputs of those tests did not change in 504da465..9e71f263. | carried forward | ✓ PASS (recorded) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` is declared for this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| WATCH-01 | SUMMARY | change reaches plane without a command | ✓ SATISFIED in code; ✗ not delivered (no trigger installed) | Watch, sweep, sync tests; units staged |
| WATCH-02 | SUMMARY | coalesce; restart re-ingests nothing unchanged | ◐ PARTIAL | Coalescing met; restart needs `SUBSTRATE_PLANNING_HASH_STORE=on` |
| WATCH-03 | SUMMARY | no writes into repos by default; hooks opt-in; never fail git | ✓ SATISFIED | `install-git-hook.ts`; watcher read-only; runbook section 4 matches |
| WATCH-04 | SUMMARY | reconcile timer finds unseen changes via mirror | ◐ PARTIAL (code and staged unit; no installed timer) | Remote-only push test recorded; reconcile unit is dry run by default (a048bc99); runbook section 5 now matches the unit |
| WATCH-05 | SUMMARY | outcome, lag, failures as events and metrics; `docs.freshness` breach | ✓ SATISFIED in code | `docs.sync` row; gauge; reserved decision held |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `docs/runbooks/corpus-sync.md` | 15 | named `docs.changed` hint | ✓ Resolved (9e71f263) | Now states `{v, dir, at}` with no action name |
| `docs/runbooks/corpus-sync.md` | 120 | "run weekly" manual reconcile | ✓ Resolved (9e71f263) | Now describes the staged daily dry-run timer |
| `infra/vps/substrate-corpus-reconcile.service.d/30-sandbox.conf.example` | 1-2 | copied "doc-watch sweep" comment | ✓ Resolved (9e71f263) | Now names the reconcile unit |
| `infra/vps/substrate-corpus-reconcile.service.d/30-sandbox.conf.example` | 13 | `ProtectHome=read-only` text vs unit `ProtectHome=false` | ℹ️ Info | Example only; open owner decision (shared with sync and watch units) |
| `packages/mcp-server/src/reserved-actions.ts` | 23-33 | `docs.sync` not reserved | ⚠️ Warning | Held decision; any authenticated caller can set the lag gauge |

No TBD, FIXME or XXX markers found in the phase 65 implementation files read. No 🛑 blocker anti-pattern.

### Human Verification Required

Operator-gated; not run here:

1. **Install the git hooks per repository** — `substrate corpus hook install --repo R`. Expected: marked block in `post-merge`, `post-checkout`, `post-rewrite`; a `corpus hint` file appears in the spool after a merge.
2. **Install and enable the sweep, watch and reconcile units** — copy the units and `/etc/substrate/substrate-corpus.env`, `systemctl daemon-reload`, `systemctl enable --now substrate-corpus-sync.timer substrate-corpus-watch.service substrate-corpus-reconcile.timer`. Expected: sweeps every 15 min; reconcile dry run daily at 04:43 UTC; no repository written.
3. **Server with `SUBSTRATE_CORPUS=on` and a LightRAG backend** — otherwise every sync and reconcile answers `corpus.disabled` or `corpus.backend-unavailable`.
4. **`SUBSTRATE_PLANNING_HASH_STORE=on`** after a rehearsal of migration step 39 on a restored dump (`docs/runbooks/rollback-compat.md`).
5. **Owner decision on `docs.sync`** — held pending confirmation of the CLI token; reserved-action status open.

### Open Items (owner decisions, not verifier-closable)

1. Criterion 2: `docs.changed` wording (ROADMAP.md line 1112) vs the unnamed `{v, dir, at}` hint. Emit the name, or record acceptance and amend the ROADMAP line.
2. Criterion 3: planning page state in `planning_page_hashes` rather than the manifest.
3. `ProtectHome` mismatch: the corpus units and the reconcile drop-in example say `read-only`/`false` inconsistently (unit `false`, drop-in read-only).
4. `docs.sync` reserved-action status (held).

### PG counts per file

- `packages/mcp-server/src/planning-hash-store.test.ts`: Postgres-gated (`describeLive` when `SUBSTRATE_TEST_PG_URL` is set). No database supplied for this pass: the live block was not run. Prior non-PG run at 504da465: 29 pass, 3 skip, 0 fail across `sync.test.ts` and this file.
- `scripts/doctor-sandbox.test.ts`, `scripts/sandbox-dropins.test.ts`, `scripts/doctor-units.test.ts`: no PG gate (grep: no `SUBSTRATE_TEST_PG_URL`). Run with the variable unset: 100 pass, 0 fail.

### Gaps Summary

Criteria 2 and 3 remain PARTIAL against their wording. This pass closed the runbook half of criterion 2 (line 15 now describes the `{v, dir, at}` hint), and the runbook's reconcile paragraph and the drop-in example comment now match the staged units. The remaining criterion 2 gap is the owner decision on the `docs.changed` wording; criterion 3 is the owner decision on the table. WATCH-04 is code-met and staged but not delivered until an operator installs it. No live sync, no ingest and no installed trigger was observed.

### Scope of this pass

Changed since 504da465 in phase 65's files: `docs/runbooks/corpus-sync.md` and `30-sandbox.conf.example` (re-audited above). Changed elsewhere in the range and not in phase 65's covered files: `corpus/proofs.test.ts` (phase 69), `fabric/status.ts`, `fabric/types.ts`, `fabric/status.test.ts` (phase 64), `service.test.ts` (the phase 78 scheduled reconcile tick, a separate reconcile from the corpus reconcile). None of these affects a phase 65 criterion; carried forward.

---

_Verified: 2026-11-04T23:05:32Z_
_Verifier: Claude (gsd-verifier), rewrite2-1, worktree /root/src/worktrees/as-gsd-v18-all, head 9e71f263_
