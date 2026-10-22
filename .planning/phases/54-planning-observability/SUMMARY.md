---
phase: 54-planning-observability
reconstructed: true
branch: gsd/p54-complete
head: ecd00a86d11a6d5a16888c382687426ebd0e02c3
pull_request: 111
---

> **RECONSTRUCTED AFTER EXECUTION.** Written after the phase's commits landed, from the branch and PR 111's body. No `gsd-execute-phase` run produced it. Updated at the review-merge head for the delta re-verification.

# Phase 54 summary: planning observability and migration inventory (SOTA-10)

## What the branch contains

**Session STATES (SC2).** `packages/mcp-server/src/planning/states.ts` defines `SESSION_STATES` as LOADING, EMPTY, STALE, DEGRADED, ERROR, SUCCESS (`states.ts:15`) and the pure function `deriveSessionState` (`states.ts:43-65`), which returns exactly one state with a text line. The planning reader attaches that one state to every sessions answer (`read.ts:139-141`, mapping `read.ts:186-197`).

**Transition telemetry (SC1).** `packages/mcp-server/src/planning/telemetry.ts` defines the `planning.transition` series (`telemetry.ts:28`), the outcomes `applied` and `refused` (`telemetry.ts:31`), a GreptimeDB sink (`telemetry.ts:87-111`), a stdout sink (`telemetry.ts:126-146`, with `from` and `to` on the line at `telemetry.ts:133-134`), and `emitTransition`, which tries the primary once and the fallback once only on failure (`telemetry.ts:177-189`). The series is in the core allow-list with label `outcome` (`metrics-history.ts:117`).

**Observer.** The transition pipeline lives in `packages/mcp-server/src/planning/observer.ts`, not `read.ts`. The observer scans on a timer and records one transition per detected planning change (`observer.ts:247-266`, `settle`). Records are handed to their sinks without being awaited (`observer.ts:283-296`). The reader records nothing. The review merge (46e7c7e) keeps this pipeline and adds a single-flight scan: a call made while a scan runs shares it (`observer.ts:156`). A change read by a shared scan is recorded by the next scan, one tick later. `unpublishedOutcome` (`observer.ts:331-334`) is the fix for the directory-failure finding, tested at `observer.test.ts:691-702`.

**Scan cadence.** `SUBSTRATE_PLANNING_SCAN_INTERVAL_MS` sets the scan interval (default 15000, bounds 1000 to 3600000; `planning/config.ts:16`, `config.ts:22`, `config.ts:30`). The observer's timer keeps `unref()` (`observer.ts:54`).

**Shutdown.** `service.ts:2873-2876` (`stopPlanning`) clears the timer and awaits the in-flight scan; `index.ts:223` starts it and `index.ts:241-255` bounds it with `SHUTDOWN_FLUSH_MS` (`index.ts:200`). `index.ts:234` waits for in-flight transition records within `SHUTDOWN_TRANSITION_MS` (`index.ts:204`).

**Wiring.** `service.ts:1452-1461` builds `PlanningObserver` with the GreptimeDB sink only when metrics history is enabled and a Greptime client exists, and with the stdout sink otherwise.

**Dashboards and docs.** `scripts/dashboards.ts:123` names the observer as the source of `planning.transition`, and the chart is at `scripts/dashboards.ts:280`. The test at `scripts/dashboards.test.ts:268` checks the committed panel. `infra/vps/dashboards/substrate-data-planes.json` carries the series; `docs/dashboards.md` and `docs/observability.md` describe it.

**Migration inventory (SC3).** `docs/runbooks/railway-migration-inventory.md` has four sections: host-bound units and files on the VPS (section 1, including `substrate.slice`, `journald-substrate.conf` and `deploy-release.sh` at `:31-33`), disk versus Railway-hosted state (section 2, `:41`), an environment-only configuration census with follow-ups F1 to F10, and a cutover and DNS out-of-scope statement (section 4, `:104`).

## Fix-ups since the first verification

- 365595e: three host-bound rows added to the inventory (`:31-33`).
- 3ec5e9d: `changeKey` takes the path records the observer produces; the key's JSON shape is unchanged (`observer.ts:324`).
- 36e23da, f158b1e, 7f13909: merges of phase 52 wiring, which moved the transition pipeline into the observer.
- c3d6e3e (merged as ca9cf9f): scan cadence configuration and the timer seam.
- 82e4233: the dashboard panel's source names the observer, with a behavioural test.
- 46e7c7e, bc4dd3a, b46fe82: the phase 52 review merge (single-flight scan, timers, report and last-scan seams), a balance repair of the observer test file, and metrics dependencies for three review-side observer tests.

## Test fixes in the phase

Per PR 111 body: the desktop harness takes an ephemeral host-mutex port (commit 7793001, `http.test.ts`), and the disabled-root contract asserts the session view (commit 7527418). Both are test-only changes.

## Not done in this phase

No cutover, no DNS change, no production deploy, no change to a live Railway service, VPS unit or environment file (runbook `:5`; PR 111 body). The GreptimeDB rehearsal of `planning.transition` has not run.

## Verification status

See `VERIFICATION.md` (status `passed`, delta re-verified at ecd00a8). The gates have not been run by the verifier; the orchestrator runs them.
