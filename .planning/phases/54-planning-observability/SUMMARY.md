---
phase: 54-planning-observability
reconstructed: true
branch: gsd/p54-complete
head: ca9cf9fcb297c1121e9875e2d434d96cdeea9653
pull_request: 111
---

> **RECONSTRUCTED AFTER EXECUTION.** Written after the phase's commits landed, from the branch and PR 111's body. No `gsd-execute-phase` run produced it. Updated at the wiring-merge head for the delta re-verification.

# Phase 54 summary: planning observability and migration inventory (SOTA-10)

## What the branch contains

**Session STATES (SC2).** `packages/mcp-server/src/planning/states.ts` defines `SESSION_STATES` as LOADING, EMPTY, STALE, DEGRADED, ERROR, SUCCESS (`states.ts:15`) and the pure function `deriveSessionState` (`states.ts:43-65`), which returns exactly one state with a text line. The planning reader attaches that one state to every sessions answer (`read.ts:139-141`, mapping `read.ts:186-197`).

**Transition telemetry (SC1).** `packages/mcp-server/src/planning/telemetry.ts` defines the `planning.transition` series (`telemetry.ts:28`), the outcomes `applied` and `refused` (`telemetry.ts:31`), a GreptimeDB sink (`telemetry.ts:87-111`), a stdout sink (`telemetry.ts:126-146`, with `from` and `to` on the line at `telemetry.ts:133-134`), and `emitTransition`, which tries the primary once and the fallback once only on failure (`telemetry.ts:177-189`). The series is in the core allow-list with label `outcome` (`metrics-history.ts:117`).

**Observer.** The transition pipeline lives in `packages/mcp-server/src/planning/observer.ts`, not `read.ts`. The observer scans on a timer and writes a transition record when a scan detects a planning change (`observer.ts:212`, `observer.ts:219`). Records are handed to their sinks without being awaited (`observer.ts:236-247`). The reader records nothing. `unpublishedOutcome` (`observer.ts:284-287`) is the fix for the directory-failure finding, tested at `observer.test.ts:689-700`.

**Scan cadence.** The wiring merge (c3d6e3e, ca9cf9f) makes the scan interval `SUBSTRATE_PLANNING_SCAN_INTERVAL_MS`, default 15000, bounds 1000 to 3600000 (`planning/config.ts:16`, `config.ts:22`, `config.ts:30`). The observer takes a timer seam (`observer.ts:43-55`), keeps `unref()` on the production timer, and starts with no argument. The transition pipeline is unchanged by the merge.

**Wiring.** `service.ts:1452-1461` builds `PlanningObserver` with the GreptimeDB sink only when metrics history is enabled and a Greptime client exists, and with the stdout sink otherwise. `index.ts:232` waits for in-flight records within `SHUTDOWN_TRANSITION_MS` (`index.ts:202`).

**Dashboards and docs.** `scripts/dashboards.ts` draws the series; `infra/vps/dashboards/substrate-data-planes.json` carries it; `docs/dashboards.md` and `docs/observability.md` describe it.

**Migration inventory (SC3).** `docs/runbooks/railway-migration-inventory.md` has four sections: host-bound units and files on the VPS (section 1, including `substrate.slice`, `journald-substrate.conf` and `deploy-release.sh` at `:31-33`, added in 365595e), disk versus Railway-hosted state (section 2, `:41`), an environment-only configuration census with follow-ups F1 to F10, and a cutover and DNS out-of-scope statement (section 4, `:104`).

## Fix-ups since the first verification

- 365595e: three host-bound rows added to the inventory (`:31-33`).
- 3ec5e9d: `changeKey` takes the path records the observer produces; the key's JSON shape is unchanged (`observer.ts:277`).
- 36e23da, f158b1e, 7f13909: merges of phase 52 wiring (instrument fix, fs test fix, gauge fix), which moved the transition pipeline into the observer.
- c3d6e3e (merged as ca9cf9f): scan cadence configuration and the timer seam, as above.

## Test fixes in the phase

Per PR 111 body: the desktop harness takes an ephemeral host-mutex port (commit 7793001, `http.test.ts`), and the disabled-root contract asserts the session view (commit 7527418). Both are test-only changes.

## Not done in this phase

No cutover, no DNS change, no production deploy, no change to a live Railway service, VPS unit or environment file (runbook `:5`; PR 111 body). The GreptimeDB rehearsal of `planning.transition` has not run.

## Verification status

See `VERIFICATION.md` (status `passed`, delta re-verified at ca9cf9f). The gates have not been run by the verifier; the orchestrator runs them.
