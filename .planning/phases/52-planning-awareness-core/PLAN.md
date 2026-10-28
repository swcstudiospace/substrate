---
phase: 52-planning-awareness-core
requirements: [SOTA-08]
status: core tasks done; wiring W1, W2, W3, W5 and the W6 ledger part done on gsd/p52-wiring; W4 waits for the registry rows merged from gsd/p52-planning-core; TimescaleDB history (W6) blocked
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

The acceptance above describes the core phase. The wiring below edits `mcp.ts`, `policy.ts`, `flag-registry.ts` and the other files it names, on purpose.

- W1. A presence backend module (its own client, like `event-bus.ts`) implementing `PresenceBackend`: `get`, `SET ... EX`, and a bounded SCAN loop for `keysWithPrefix`. Do not add these to `cache.ts`: `cache-conformance.test.ts` closes its command set.
  - Status: done (5c396fd). `planning/presence-client.ts` sends only GET, SET EX, SCAN and TIME. SCAN is bounded per round, per walk and by the caller's limit. `cache.ts` and its conformance lock are unchanged: the presence client is outside that lock by design. No command was added to the cache allow list.
- W2. Register read-only `planning_status` (index summary, `planningIndex` records and errors) and `planning_sessions` (`presenceSnapshot`, or the Dragonfly list when the server TTL is the only clock) in `mcp.ts`. Settings come from `loadPlanningSettings(process.env)`, the only env read.
  - Status: done (23d4503). Both tools are in `planning/read.ts` and registered in `mcp.ts`. Settings come from `loadConfig(env)`, which calls `loadPlanningSettings(env)` once. No other planning code reads the environment.
- W3. Policy entries for both tools in `packages/audit/src/policy.ts`. Both are read-only: choose fail-open or fail-closed explicitly and state why.
  - Status: done (23d4503). Both tools are fail-open in `policy.ts`, read class in `admission.ts`, and labelled in `observe.ts`. Fail-open because both are inspection only and a failed read answers typed. The default for an unlisted tool is fail-closed, so the entries are required.
- W4. Flags for the four `SUBSTRATE_PLANNING_*` variables in `flag-registry.ts` and `docs/config-reference.md`.
  - Status: blocked on the merge. The four rows are on `gsd/p52-planning-core`, which the orchestrator merges into this branch. No row is added here, to avoid a duplicate. After the merge, check the four names in `flag-registry.ts` and their `docs/config-reference.md` rows, and add only what is still missing.
- W5. Decide the presence clock: add a bounded server-time read to the presence backend and use it for `PresenceClock`, or keep classification off in production and report presence as server-TTL only.
  - Status: done. Decision: the presence backend reads the server's `TIME`, stamps each heartbeat with it, and judges staleness against it (`DragonflyPresenceStore.serverNowMs`). The host clock is used for no presence decision. If `TIME` fails, sessions are listed as `unknown` with the reason. The retention is one day, so a stale session stays listed.
- W6. Ledger write of `planningChangeEvent` output through the existing ingest path, with a `event-sources.ts` row and `docs/event-vocabulary.md` entry; history table in TimescaleDB implementing `HistorySink`.
  - Status: ledger part done. A change between two `planning_status` reads is written as one `planning.changed` note (surface `substrate`, no new kind) through `Substrate.emit`, which also sends the bus hint. The row is in `event-sources.ts` and `docs/event-vocabulary.md`.
  - Blocker: the TimescaleDB history table implementing `HistorySink` is not built. It needs a migration, and a migration is an operator-gated production step. No migration is added here.
  - Repo: the event's repo is the `owner/name` of the `origin` remote in the checkout's `.git/config`. Without one, the change is reported as `repo-unknown` and nothing is written.
  - Reviewer decision (explicit, kept): `planning_status` is a read-class tool that can write one `planning.changed` ledger note when the index differs from the last read in this process. It is the only write a read makes, it is fail-open, and it was chosen because the change needs a trigger and no timer exists. The alternative is a periodic job, which needs its own lifecycle and is not built. Reviewer to accept or reject before the phase closes.
  - Partial diffs (core 679064f): when either index side is truncated, `diffPlanningIndex` returns `removed: null`. The reader reports a `partial` change note (`removed: null`, `added: null` when the previous side was truncated, `changed` counted) and writes no ledger note. A removal is never inferred from a truncated side, and an empty list is never used in its place.
