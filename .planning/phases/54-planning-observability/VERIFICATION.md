---
phase: 54-planning-observability
verified: 2026-10-22
status: gaps_found
score: 2 of 3 criteria PASS
verified_on: gsd/p54-complete at e4257c3b774abc7326bc31d19465d71c1873cffc (base gsd/p52-wiring 3126296f7ac58544fc1f2409c96126af70ef5473)
covered_files: ["packages/mcp-server/src/planning/states.ts", "packages/mcp-server/src/planning/telemetry.ts", "packages/mcp-server/src/planning/read.ts", "packages/mcp-server/src/metrics-history.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/index.ts", "scripts/dashboards.ts", "infra/vps/dashboards/substrate-data-planes.json", "docs/runbooks/railway-migration-inventory.md", "docs/dashboards.md", "docs/observability.md", "infra/vps/README.md", "infra/vps/substrate.slice", "infra/vps/journald-substrate.conf", "infra/vps/deploy-release.sh"]
---

# 54-VERIFICATION: Planning observability and migration inventory (SOTA-10)

## Gates

Not run by the verifier; orchestrator gates pending.

## Criteria

Criteria are the three supplied for this verification. The branch's `.planning/ROADMAP.md` has no phase 54 entry, so they are not checked against a roadmap file.

| criterion | verdict | evidence (file:line) |
| --- | --- | --- |
| 1. Each phase transition emits a GreptimeDB metric, with a stdout fallback when GreptimeDB is disabled or unreachable. | PASS | Allow-list: `metrics-history.ts:116` (`"planning.transition"`, core tier, label `outcome`, values `TRANSITION_OUTCOME_VALUES`); `metrics-history.ts:96`. Series constant: `telemetry.ts:28`; outcomes `telemetry.ts:31`. GreptimeDB write path: `telemetry.ts:87-111` builds one row `{series, labels:{outcome}, value 1}` and calls the injected writer; a refused write is `telemetry.ts:104-108`. Writer: `service.ts:1453-1454` passes `greptimeMetricSink((rows)=>transitionWriter.recordMetricSamples(...))`; `greptime.ts:2214` `recordMetricSamples`; `greptime.ts:2378` `validMetricRow` (canonical labels). Disabled path: `service.ts:1453-1455` uses `stdoutMetricSink()` unless `config.metricsHistory.enabled` and a Greptime client exists (`service.ts:1407-1411`). Unreachable path: `greptime.ts:2254-2256` catches the write and returns `stored: 0` with a drop reason, so `telemetry.ts:104-108` returns refused. Stdout fallback: `telemetry.ts:126-146` (one JSON line, `TransitionLine` fields only, `telemetry.ts:114-123`); `telemetry.ts:177-189` `emitTransition` calls the fallback once only when the primary fails, and `read.ts:372` defaults the fallback to stdout. Scheduling: `read.ts:336`, `read.ts:342` (records on detected change), `read.ts:365-382` (not awaited, bounded by `MAX_PENDING_TRANSITIONS` at `read.ts:156`). Shutdown wait: `index.ts:200`, `index.ts:228`. |
| 2. The session view reports exactly one of the STATES: LOADING, EMPTY, STALE, DEGRADED, ERROR, SUCCESS. | PASS | Member list at `states.ts:15`: `["LOADING", "EMPTY", "STALE", "DEGRADED", "ERROR", "SUCCESS"]`, type `states.ts:16`. The set equals the six names; no extra or missing member. Every return in `deriveSessionState` (`states.ts:43-65`) uses one of these names: ERROR `states.ts:45`, LOADING `states.ts:47`, DEGRADED `states.ts:51`, EMPTY `states.ts:54`, STALE `states.ts:58`, SUCCESS `states.ts:64-65`. Attached to the reply once: `read.ts:203-206` (`sessions()` returns `{ ...body, view: sessionViewOf(body) }`); mapping `read.ts:425-446`. Index state `read.ts:419-422` (DEGRADED, EMPTY, SUCCESS). Caveat recorded in Residual risks: LOADING is never produced through the session view, because every call passes `loaded: true` (`read.ts:428`, `430`, `432`, `433`, `440`). |
| 3. A documented inventory separates disk state from Railway-hosted state and lists host-bound paths and units. | FAIL | Disk vs Railway split: `docs/runbooks/railway-migration-inventory.md:38-67`, with a "Railway-hosted?" column (header `:42`). Railway-hosted rows: `:44` (ledger), `:45` (metrics), `:49` (Hindsight), `:50` (RAGFlow); local-disk rows: `:51-60`; partly `:65`. Units and paths named in §1 (`:9-31`) were checked against the repo and all resolve (see Residual risks for the indirect matches). Missing from §1: `infra/vps/substrate.slice` (every `substrate-*` unit names it, `infra/vps/README.md:89`; installed alongside them, `infra/vps/README.md:267`); `infra/vps/journald-substrate.conf`; `infra/vps/deploy-release.sh` (host-run release tool). None is named in the runbook (`grep` finds 0 matches). |

## Gaps

- Criterion 3: §1 of `docs/runbooks/railway-migration-inventory.md` omits three host-bound files that the repo ships to the VPS. The exact missing pieces are: a row for `substrate.slice` (`infra/vps/substrate.slice`), a row for `journald-substrate.conf` (`infra/vps/journald-substrate.conf`), and a row for `deploy-release.sh` (`infra/vps/deploy-release.sh`). The disk-versus-Railway split and the other named units and paths are present and resolve.

## Operator-gated

- GreptimeDB rehearsal of `planning.transition` has not run. The in-repo write path (`telemetry.ts:87-111`, `greptime.ts:2214`) and the stdout fallback (`telemetry.ts:126-146`, `telemetry.ts:177-189`) pass in-repo. This item is not counted as a FAIL.
- Live observation of the stdout fallback on the VPS has not run (operator-gated, not counted).
- Cutover, DNS change, Railway deploy and any change to a live unit or environment file are out of scope for this phase (`docs/runbooks/railway-migration-inventory.md:5`, `:101-103`).

## Residual risks

- **Transition scope (C1).** A record is written only when a planning document change is detected (`read.ts:341-342`; `read.ts:407` returns no outcome for a clean complete diff). A session-view or index-state move with no document change writes nothing. `phaseId` is fixed to `"planning"` (`read.ts:40`), so transitions are not labelled per phase number. The PR 111 body states the same scope.
- **Greptime rows carry no from or to (C1).** The Greptime row labels only `outcome` (`telemetry.ts:94`). The from and to states appear only on the stdout line (`telemetry.ts:130-137`).
- **Partial diffs (C1).** `unpublishedOutcome` counts added and changed paths only (`read.ts:406-409`). Removals in an incomplete diff are not counted (`read.ts:457` sets `removed: null`).
- **Shutdown bound (C1).** Records still in flight after `SHUTDOWN_TRANSITION_MS` (`index.ts:200`) may not be delivered before exit. Past `MAX_PENDING_TRANSITIONS` (`read.ts:156`), a record goes to stdout only.
- **LOADING unreachable (C2).** Only `deriveSessionState` returns LOADING (`states.ts:47`), and no caller passes `loaded: false`. The member is in the set but the view never reports it.
- **PR 111 Greptile finding.** An open P2 finding, "Directory failures hide transitions", is on PR 111 (reviewed at e4257c3). Reading `read.ts:406-409`, incomplete diffs with added or changed paths are refused, which appears to address the cited case. Whether it closes the finding is for the orchestrator's Greptile gate.
- **Criterion source.** The branch has no phase 54 entry in `.planning/ROADMAP.md`. The criteria here come from the verification request.
- **Inventory name check (C3).** Every backticked name in the runbook was searched in the repo. Names matched by literal text: units, most paths, ports, env-variable names. Names not matched by literal text, each resolved as follows:
  - `/root/.claude/settings.json`: `docs/runbooks/memory-mcp-retirement.md:36`. The inventory says it is outside the repo.
  - `/root/.cursor/hooks.json`: `docs/runbooks/lane-b-collectors.md:8`. Outside the repo, as the inventory says.
  - `/root/backups`: `docs/runbooks/lane-b-collectors.md:23`.
  - `hindsight-ui`: `docs/railway-tailscale.md:36`. `docs/data-planes.md` does not name it, although the runbook says service names come from there.
  - `*.timer` units (`substrate-anchor`, `-index-sweep`, `-index-archive`, `-ledger-archive`, `-doctor`, `-docs-canary`, `-skills-sync`, `-skills-bridge`): `infra/vps/*.timer` exist by file name.
  - `/var/lib/substrate/event-spool.jsonl`: `packages/collectors/src/emit.ts:71` (`SPOOL_FILE`) under the state dir.
  - `/var/lib/substrate/*-offsets.json`: `packages/collectors/src/grok.ts:33`, `herdr-state.ts:95`, `muse.ts:40`.
  - `/root/src/repos/<name>`: `packages/dispatcher/src/substrate_dispatcher/worktree.py:22` (`REPOS_ROOT`).
  - `packages/projector/omp/substrate-status.ts`: the file exists.
  - `env.X ?? "..."`: a search pattern in the runbook, not a name.

  No inventory name was left unresolved. The three host-bound files in Gaps are not named at all.
- **Units not verified on a host.** The check is against repo files, not against an installed VPS.
