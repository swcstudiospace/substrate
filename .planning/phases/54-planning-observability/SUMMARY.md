---
phase: 54-planning-observability
reconstructed: true
branch: gsd/p54-complete
head: 7f1390929cfcc9650a84218aaf8cebc68e76102f
pull_request: 111
---

> **RECONSTRUCTED AFTER EXECUTION.** Written after the phase's commits landed, from the branch and PR 111's body. No `gsd-execute-phase` run produced it. Updated at the fix-up head for the re-verification.

# Phase 54 summary: planning observability and migration inventory (SOTA-10)

## What the branch contains

**Session STATES (SC2).** `packages/mcp-server/src/planning/states.ts` defines `SESSION_STATES` as LOADING, EMPTY, STALE, DEGRADED, ERROR, SUCCESS (`states.ts:15`) and the pure function `deriveSessionState` (`states.ts:43-65`), which returns exactly one state with a text line. The planning reader attaches that one state to every sessions answer (`read.ts:139-141`, mapping `read.ts:186-197`).

**Transition telemetry (SC1).** `packages/mcp-server/src/planning/telemetry.ts` defines the `planning.transition` series (`telemetry.ts:28`), the outcomes `applied` and `refused` (`telemetry.ts:31`), a GreptimeDB sink (`telemetry.ts:87-111`), a stdout sink (`telemetry.ts:126-146`), and `emitTransition`, which tries the primary once and the fallback once only on failure (`telemetry.ts:177-189`). The series is in the core allow-list with label `outcome` (`metrics-history.ts:117`).

**Observer (moved in the fix-ups).** The transition pipeline lives in `packages/mcp-server/src/planning/observer.ts`, not `read.ts`. The observer scans on a timer and writes a transition record when a scan detects a planning change (`observer.ts:191`, `observer.ts:198`). Records are handed to their sinks without being awaited (`observer.ts:56-66`). The reader records nothing. `observer.ts` also holds the fix for the directory-failure finding (`unpublishedOutcome`, `observer.ts:263-266`), tested at `observer.test.ts:660-671`.

**Wiring.** `service.ts:1452-1461` builds `PlanningObserver` with the GreptimeDB sink only when metrics history is enabled and a Greptime client exists, and with the stdout sink otherwise. `index.ts:232` waits for in-flight records within `SHUTDOWN_TRANSITION_MS` (`index.ts:202`).

**Dashboards and docs.** `scripts/dashboards.ts` draws the series; `infra/vps/dashboards/substrate-data-planes.json` carries it; `docs/dashboards.md` and `docs/observability.md` describe it.

**Migration inventory (SC3).** `docs/runbooks/railway-migration-inventory.md` has four sections: host-bound units and files on the VPS (section 1, including `substrate.slice`, `journald-substrate.conf` and `deploy-release.sh` at `:31-33`, added in 365595e), disk versus Railway-hosted state (section 2, `:41`), an environment-only configuration census with follow-ups F1 to F10, and a cutover and DNS out-of-scope statement (section 4, `:104`).

## Fix-ups since the first verification

- 365595e: three host-bound rows added to the inventory (`:31-33`).
- 3ec5e9d: `changeKey` takes the path records the observer produces; the key's JSON shape is unchanged (`observer.ts:256`).
- 36e23da, f158b1e, 7f13909: merges of phase 52 wiring (instrument fix, fs test fix, gauge fix), which moved the transition pipeline into the observer.

## Test fixes in the phase

Per PR 111 body: the desktop harness takes an ephemeral host-mutex port (commit 7793001, `http.test.ts`), and the disabled-root contract asserts the session view (commit 7527418). Both are test-only changes.

## Not done in this phase

No cutover, no DNS change, no production deploy, no change to a live Railway service, VPS unit or environment file (runbook `:5`; PR 111 body). The GreptimeDB rehearsal of `planning.transition` has not run.

## Verification status

See `VERIFICATION.md` (status `passed`, re-verified at 7f13909). The gates have not been run by the verifier; the orchestrator runs them.
