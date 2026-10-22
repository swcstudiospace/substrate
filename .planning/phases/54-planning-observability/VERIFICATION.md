---
phase: 54-planning-observability
verified: 2026-10-22
status: passed
score: 3 of 3 criteria PASS in-repo
verified_on: gsd/p54-complete at ca9cf9fcb297c1121e9875e2d434d96cdeea9653 (delta re-verification after the wiring merge c3d6e3e; prior verifications at e4257c3, ec67976, 7f13909 and 063e78f; base gsd/p52-wiring 3126296f7ac58544fc1f2409c96126af70ef5473)
covered_files: ["packages/mcp-server/src/planning/observer.ts", "packages/mcp-server/src/planning/observer.test.ts", "packages/mcp-server/src/planning/states.ts", "packages/mcp-server/src/planning/telemetry.ts", "packages/mcp-server/src/planning/read.ts", "packages/mcp-server/src/planning/config.ts", "packages/mcp-server/src/metrics-history.ts", "packages/mcp-server/src/greptime.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/index.ts", "docs/runbooks/railway-migration-inventory.md", "infra/vps/substrate.slice", "infra/vps/journald-substrate.conf", "infra/vps/deploy-release.sh", ".env.example"]
---

# 54-VERIFICATION: Planning observability and migration inventory (SOTA-10)

## Gates

Not run by the verifier; orchestrator gates pending. The orchestrator reports a gate on head ca9cf9f (tsc clean; 356 pass, 0 fail; phase-close 185 pass, 0 fail). That report is the orchestrator's, not this verifier's.

## Criteria

Criteria are the three supplied for this verification. The branch's `.planning/ROADMAP.md` has no phase 54 entry, so they are not checked against a roadmap file.

| criterion | verdict | evidence (file:line) |
| --- | --- | --- |
| SC1. Each phase transition emits the `planning.transition` GreptimeDB metric, with a stdout fallback when GreptimeDB is disabled or unreachable. | PASS | **Allow-list:** `metrics-history.ts:117` (`"planning.transition"`, core tier, label `outcome`, values `TRANSITION_OUTCOME_VALUES`); `EVENT_METRIC_SERIES` at `metrics-history.ts:121`. **Series and outcomes:** `telemetry.ts:28`, `telemetry.ts:31`. **Identity at the transition path:** `observer.ts:212` and `observer.ts:219` call `transitionRecord({ phaseId: PLANNING_TRANSITION_PHASE, from: current.state, to: state, outcome, incomplete }, ...)`; `PLANNING_TRANSITION_PHASE` is `observer.ts:37`. **Stdout line keeps from and to:** `telemetry.ts:130-137` builds the `TransitionLine` with `from: record.from` (`telemetry.ts:133`) and `to: record.to` (`telemetry.ts:134`); `stdoutMetricSink` is `telemetry.ts:126-146`. **Scheduling and bound:** `observer.ts:236-247` (`schedule`), primary `tracked ? this.deps.metrics : fallback` at `observer.ts:239`, bound `MAX_PENDING_TRANSITIONS` at `observer.ts:58` and `observer.ts:238`. **Write path to GreptimeDB:** `service.ts:1452-1461` builds `PlanningObserver` with `metrics = greptimeMetricSink(rows => transitionWriter.recordMetricSamples(...))` when `config.metricsHistory.enabled` and a Greptime client exists; `telemetry.ts:87-111` builds one row `{series, labels: {outcome}, value 1}`; `greptime.ts:2214` `recordMetricSamples`. **Disabled fallback:** `service.ts:1461` `stdoutMetricSink()`. **Unreachable fallback:** `greptime.ts:2254-2256` catches the write and returns `stored: 0` with drops; `telemetry.ts:104-108` returns refused; `telemetry.ts:183` `emitTransition` calls the fallback once. **Default fallback:** `observer.ts:237` (`this.deps.fallback ?? stdoutMetricSink()`). **Shutdown wait:** `index.ts:202`, `index.ts:232`. **Identity caveat:** the Greptime row labels only `outcome` (`telemetry.ts:94`), so `from` and `to` are absent from the metric and present only on the stdout line. **Trigger caveat (still holds):** a record is written only when a scan detects a planning change: `observer.ts:181` and `observer.ts:191` set `outcome`; `unpublishedOutcome` returns null for a complete unchanged diff (`observer.ts:285`); the schedule conditions are `observer.ts:210` and `observer.ts:218`. The read path records nothing: `observer.ts:13-16` header, and `read.ts` contains no transition call. |
| SC2. The session view reports exactly one of LOADING, EMPTY, STALE, DEGRADED, ERROR, SUCCESS. | PASS | **Member list:** `states.ts:15` `SESSION_STATES = ["LOADING", "EMPTY", "STALE", "DEGRADED", "ERROR", "SUCCESS"]`; type at `states.ts:16`. The set equals the six names; no extra or missing member. **Single derivation:** `deriveSessionState` at `states.ts:43-65`, each return naming one member (ERROR `states.ts:45`, LOADING `states.ts:47`, DEGRADED `states.ts:51`, EMPTY `states.ts:54`, STALE `states.ts:58`, SUCCESS `states.ts:64-65`). **Single attachment:** `read.ts:139-141` `sessions()` returns `{ ...body, view: sessionViewOf(body) }`; `sessionViewOf` at `read.ts:186-197` returns one `deriveSessionState` result per branch. The planning index state (DEGRADED, EMPTY, SUCCESS) is `observer.ts:297` and is not part of the session view. **Caveat:** LOADING is never returned by the session view, because every call passes `loaded: true` (`read.ts:189`, `191`, `193`, `194`, `197`). |
| SC3. The migration inventory separates disk state from Railway-hosted state and lists every host-bound path and unit. | PASS | **Split:** `docs/runbooks/railway-migration-inventory.md:41` (section 2), table header with the "Railway-hosted?" column at `:45`. Railway-hosted rows: `:47` (ledger), `:48` (metrics), `:52` (Hindsight), `:53` (RAGFlow). Local-disk rows: `:54` onward. Partly: `:68` (backups). **Rows added in 365595e:** `:31` `substrate.slice`; `:32` `journald-substrate.conf`; `:33` `deploy-release.sh`. **Each path exists in the repo:** `infra/vps/substrate.slice` (`MemoryLow=2G` line 23, `CPUWeight=300` line 38, `IOWeight=300` line 39, `ManagedOOMPreference=avoid` line 43); `infra/vps/journald-substrate.conf` (`SystemMaxUse=400M` line 22; install target lines 4-5); `infra/vps/deploy-release.sh` (release path line 70, `daemon-reload` line 267, env-name-only `grep -q` checks lines 440, 480, 487). None of these three files changed between 063e78f and ca9cf9f. Section 4 (cutover and DNS out of scope): `:104`. |

## Gaps

None.

## Operator-gated

- The GreptimeDB rehearsal of `planning.transition` has not run. The in-repo write path (`service.ts:1452-1461`, `telemetry.ts:87-111`, `greptime.ts:2214`) and the stdout fallback (`telemetry.ts:126-146`, `telemetry.ts:177-189`) pass in-repo. Not counted as FAIL.
- Live observation of the stdout fallback on the VPS has not run (operator-gated, not counted).
- Cutover, DNS change, Railway deploy, and any change to a live unit or environment file are out of scope (`docs/runbooks/railway-migration-inventory.md:5`, `:104-106`).

## Residual risks

- **Trigger scope (SC1, still holds).** A transition record is written only when a scan detects a planning-document change (`observer.ts:181`, `observer.ts:191`, `observer.ts:210`, `observer.ts:218`). A session-view or index-state move with no document change writes nothing. The phase id is fixed to `"planning"` (`observer.ts:37`), so transitions are not labelled per phase number.
- **Identity absent from GreptimeDB (SC1).** The metric row carries `outcome` only (`telemetry.ts:94`). The transition's `from` and `to` are on the stdout line only (`telemetry.ts:133-134`).
- **Partial diffs (SC1).** `unpublishedOutcome` counts added and changed paths only (`observer.ts:284-287`). Removals in an incomplete diff are not counted.
- **Shutdown bound (SC1).** Records still in flight after `SHUTDOWN_TRANSITION_MS` (`index.ts:202`) may not be delivered before exit. Past `MAX_PENDING_TRANSITIONS` (`observer.ts:58`), a record goes to the fallback alone (`observer.ts:238-239`).
- **LOADING unreachable (SC2).** Only `deriveSessionState` returns LOADING (`states.ts:47`); no caller passes `loaded: false` (`read.ts:189-197`).
- **Scan cadence change (delta).** The scan interval is now `SUBSTRATE_PLANNING_SCAN_INTERVAL_MS`, default 15000, bounds 1000 to 3600000 (`planning/config.ts:16`, bounds `config.ts:30`, default `config.ts:22`). The timer keeps its `unref()` in the production seam (`observer.ts:48-55`). It is only documented as a commented line in `.env.example:932`. This is not a planning-transition gap, but it is a new operator-facing knob.
- **Greptile P2 test (SC1).** The test for the "directory failures hide transitions" finding is `observer.test.ts:689-700` (after the wiring merge; it was `:660-671` at 063e78f). It asserts `outcome: "refused"` and `incomplete: true`, with no published events, against `unpublishedOutcome` at `observer.ts:284-287`. I read it and did not run it. Whether it passes is for the orchestrator's gate.
- **Criterion source.** The branch has no phase 54 entry in `.planning/ROADMAP.md`. The criteria here come from the verification request.
- **Units not verified on a host.** Checks are against repo files, not against an installed VPS.
