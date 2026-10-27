---
phase: 52-planning-awareness-core
requirements: [SOTA-08]
status: core tasks done on gsd/p52-planning-core; wiring tasks W1-W6 wait for phase 51
---

# 52-PLAN: planning index, presence and change diffs

## Tasks (done in this phase)

- T1. `planning/config.ts`: env-only settings, typed errors, defaults 90 s / 500 files / 262144 bytes.
- T2. `planning/index.ts` and `planning/fs.ts`: bounded, read-only index of `.planning/` through the
  `PlanningFs` port; `nodePlanningFs()` is the production adapter.
- T3. `planning/diff.ts`: add, change, remove by path and sha256.
- T4. `planning/presence.ts`: session schema, pure `classifySessions`, store, history and clock ports.
- T5. `planning/presence-dragonfly.ts`: Dragonfly adapter with server-side TTL; no host clock for expiry.
- T6. `planning/events.ts`: planning-change event on the existing vocabulary; publish through the bus port.

## Acceptance

- Every module has a test beside it, asserting behaviour only. `git diff --stat origin/main` shows only new files
  under `packages/mcp-server/src/planning/` and `.planning/phases/52-planning-awareness-core/`.
- No edit to `mcp.ts`, `server.ts`, `packages/audit/src/policy.ts`, `flag-registry.ts`, `cache.ts`, `ROADMAP.md`, `STATE.md`.

## Wiring (after phase 51 lands)

- W1. A presence backend module (its own client, like `event-bus.ts`) implementing `PresenceBackend`:
  `get`, `SET ... EX`, and a bounded SCAN loop for `keysWithPrefix`. Do not add these to `cache.ts`:
  `cache-conformance.test.ts` closes its command set.
- W2. Register read-only `planning_status` (index summary, `planningIndex` records and errors) and
  `planning_sessions` (`presenceSnapshot`, or the Dragonfly list when the server TTL is the only clock)
  in `mcp.ts`. Settings come from `loadPlanningSettings(process.env)`, the only env read.
- W3. Policy entries for both tools in `packages/audit/src/policy.ts`. Both are read-only: choose
  fail-open or fail-closed explicitly and state why.
- W4. Flags for the four `SUBSTRATE_PLANNING_*` variables in `flag-registry.ts` and `docs/config-reference.md`.
- W5. Decide the presence clock: add a bounded server-time read to the presence backend and use it for
  `PresenceClock`, or keep classification off in production and report presence as server-TTL only.
- W6. Ledger write of `planningChangeEvent` output through the existing ingest path, with a
  `event-sources.ts` row and `docs/event-vocabulary.md` entry; history table in TimescaleDB implementing `HistorySink`.
