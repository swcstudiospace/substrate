# Phase 31 Plan 03: Host wiring and rehearsal proof Summary

---
phase: 31-lane-a-runtime
plan: "03"
subsystem: lane-a-host-wiring
tags: [wiring, disk-gate, unit, rehearsal, runbook]
requires: [31-01-spike-runner, 31-02-host-port]
provides: [main-checkout-fix, disk-gate, staged-unit, smoke-host, lane-a-runbook]
affects: [phase-32-lease-choreography, phase-33-dispatch-route]
tech-stack:
  added: []
  patterns: [single-gated-entry, staged-not-installed, fake-based-proof]
key-files:
  created:
    - infra/vps/substrate-host.service
    - scripts/host-smoke.ts
    - scripts/host-smoke.test.ts
    - packages/host/src/sandbox-provider.test.ts
    - docs/runbooks/lane-a-host.md
  modified:
    - packages/host/src/main.ts
    - packages/host/src/sandbox-provider.ts
    - package.json
    - docs/dispatcher.md
decisions:
  - "Share-mode defaults stay UNVERIFIED in code; main.ts refuses RIVET_RUN_ENGINE=1 until G2 records its verdict"
  - "ensureImagePulled is the single build/pull entry: gate first, inspect, pull only when missing"
  - "Pre-existing September unit (enabled, inactive, RIVET_RUN_ENGINE=1) left untouched; G4 replaces it"
metrics:
  duration: "~70 min"
  completed: "2026-10-10"
  tasks: 3
  tests_added: 9
status: complete
---

One-liner: repo-checkout entry point, in-code 10 GiB gate, staged unit, 23-check fake two-VM proof, and the G1-G4 runbook.

## Tasks completed

1. main.ts checkout fix plus 10 GiB disk gate — checkout derived from the file location (env override kept); engine env read (`RIVET_RUN_ENGINE`/`RIVET_RUN_ENGINE_HOST`/`RIVETKIT_STORAGE_PATH`) with share-mode UNVERIFIED defaults and a hard refusal of own-engine mode until G2; `DISK_FLOOR_BYTES`, `checkDiskFloor` (fail-closed), and `ensureImagePulled` (gate → inspect → pull-when-missing) in sandbox-provider.ts, wired at the top of `create()`. New `sandbox-provider.test.ts` (7 tests: refuse-below-floor, allow-above-floor, df-unreadable-refuses, present-skips-pull, pull-after-gate, no-docker-call-on-refusal).
2. Staged unit plus two-VM rehearsal proof — `infra/vps/substrate-host.service` staged (share-mode env, per-unit `EnvironmentFile`, `ConditionPathExists`, Phase 16 crash-loop guards, STAGED ONLY header); `scripts/host-smoke.ts` (`bun run smoke:host`, wired in root `package.json`): two `openTask`s → two actors, `permissionPolicy: ask`, seed read-back, bearer header in the MCP entry, two labeled loopback unprivileged socketless containers with distinct tokens, disk-gate refusal, loopback API bind with `POST /tasks → 400`, main-binds-loopback + unit-staged assertions. `host-smoke.test.ts` (pool isolation + full rehearsal green).
3. Runbook plus dispatcher note plus gated live map — `docs/runbooks/lane-a-host.md` (engine table, budget table, G1-G4 with preconditions/rollback, never-type-secrets); `docs/dispatcher.md` gains the `host-unreachable` → live transition note (no code change).

## Verification (all exercised)

- `bun test packages/host/ scripts/host-smoke.test.ts`: 191 pass / 0 fail across 13 files.
- `bun run smoke:host`: 23 checks green (fakes only).
- `bunx tsc --noEmit`: clean.
- `bun run check:phase-close`: pass (4 locks green, EVENT_KINDS 12, SURFACES 27).
- `systemctl cat substrate-host`: September's unit still installed (enabled, inactive) — untouched; staged file differs (share mode, per-unit env file).
- `docker image inspect substrate-sandbox:0.1`: still absent — no image pulled or built.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fake pool test asserted handle identity**
- **Found during:** Task 2 (`toBe` on fresh wrapper objects)
- **Issue:** `fakeVmPool` caches actors, not handle wrappers — identity was never the contract.
- **Fix:** test asserts one actor per graph id plus filesystem isolation.

**2. [Rule 1 - Bug] Smoke passed a stub ApiService missing status/list/terminate/kill**
- **Found during:** Task 2 (`tsc` error TS2345)
- **Issue:** stub did not satisfy `ApiService`.
- **Fix:** pass the rehearsal's real `TaskService` (it satisfies the interface; the bind test now drives the real transport).

**3. [Rule 1 - Bug] Store-lock secret scan tripped on a fake token-file path**
- **Found during:** Task 2 (`check:phase-close` exit 1, `TOKEN_LITERAL` matched `/tmp/does-not-matter`)
- **Issue:** a 21-char fake path reads as an assigned token value.
- **Fix:** shortened to `/tmp/x`; phase-close green.

**4. [Rule 3 - Blocking] Staged unit tripped the enforced doctor-units gate**
- **Found during:** Task 2 (full-suite `doctor-units` failures: `dev-checkout` finding + unit-list mismatch)
- **Issue:** the staged unit used September's checkout `WorkingDirectory`; the repo gate requires every `infra/vps` unit on the pinned release, and the test enumerates units exactly.
- **Fix:** unit moved to `WorkingDirectory=/opt/agent-substrate/current` + `ExecStart=/usr/bin/node packages/host/src/main.ts` with release-tree `ConditionPathExists` (main.ts derives the checkout from its own location, so both layouts work); test extended with the host block (per-unit env file from the manifest). Doctor 18/18 green.

## Known Stubs

None. G1-G4 remain operator-gated by design; the September unit installed on the host is pre-existing state, not this plan's stub.

## Pre-existing host state (not touched)

- `substrate-host.service` installed from September: enabled, inactive, `RIVET_RUN_ENGINE=1` + shared `substrate.env`. On its next start it would collide with the other project's engine container on 6420 — G4 replaces it with the staged share-mode unit. Flagged for the operator, not fixed (live system change needs approval).

## Self-Check: PASSED
