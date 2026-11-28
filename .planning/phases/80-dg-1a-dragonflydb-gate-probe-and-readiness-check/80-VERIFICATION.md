# Phase 80 Verification: DG-1a DragonflyDB Gate Probe and Readiness Check

**Verified:** 2026-11-28
**Worktree:** `/tmp/agent-substrate-wave8`
**Scope:** Goal-backward check against `80-CONTEXT.md` + `80-PLAN.md` verdict spec. Read-only; no product code, STATE, or ROADMAP edits.

## Verdict summary

**Status: `passed` with `human_needed` gaps** — the shipped probe implements the full DG-1a verdict spec and the loop harness is green (orchestrator-verified: 280 pass, `tsc --noEmit`, `bun run lint`, `bun run check:phase-close`). The only unclosed items are live-evidence capture, which the executor worktree could not perform and the verifier must re-run where dependencies are installed.

## Criterion verdicts

| # | Criterion (from 80-PLAN verdict spec + tasks) | Verdict | Evidence (file:line) |
|---|---|---|---|
| 1 | **Liveness (check 1)** — `PING → PONG` within command timeout via cache `callPlane`/`deadline`; timeout/throw/non-PONG → `unavailable` | **passed** | `packages/mcp-server/src/fabric/dragonfly-readiness.ts:134-141` (liveness block, `pong !== "PONG"`, bounded `deps.ping`); `packages/mcp-server/src/cache.ts:454-458` (`bunRedis ping` through gated `run("ping", redis.send("PING"))`) |
| 2 | **Capacity headroom (check 2)** — `INFO memory`: `maxmemory_bytes > 0` and `used/maxmemory < 0.80`; absent fields → metric `unknown`, never `unavailable` | **passed** | `packages/mcp-server/src/fabric/dragonfly-readiness.ts:30` (`HEADROOM_THRESHOLD = 0.8`); `:143-165` (INFO memory parse, ratio breach → `degraded`, absent → `unknown`); `80-SUMMARY.md:24-25` (keyset reuse) |
| 3 | **Eviction pressure (check 3)** — `INFO stats evicted_keys` growth vs in-memory baseline → `degraded`, never `unavailable` | **passed** | `packages/mcp-server/src/fabric/dragonfly-readiness.ts:55-56` (module baseline), `:159-170` (growth detection, `evicted_keys_baseline` metric); first probe establishes baseline, no false-positive growth |
| 4 | **Write round-trip (check 4)** — `SET substrate:v1:readiness:<ts> <ts> EX 60` then `GET` matches; mismatch/throw → `unavailable` | **passed** | `packages/mcp-server/src/fabric/dragonfly-readiness.ts` (write block after INFO); `packages/mcp-server/src/cache.ts:466` (`probeSet` via `run("set", redis.set(key,value,"EX",ttl))`); prefix/TTL constants in `dragonfly-readiness.ts:30-` region |
| 5 | **Optional visibility (check 5)** — `DBSIZE` / `SCAN MATCH substrate:v1:*` in `metrics` only, never changes `state` | **passed** | `packages/mcp-server/src/fabric/dragonfly-readiness.ts:42-43` (`dbsize`/`scan` deps), metrics-only reporting; `packages/mcp-server/src/cache.ts:467-470` (`dbsize` through `run("dbsize", redis.send("DBSIZE"))`) |
| 6 | **State precedence** — `unconfigured → unavailable → degraded → ok`; verdict `{ state, reasons, metrics, checkedAt }`; fail-closed, no fabricated success, bounded/redacted reasons | **passed** | `packages/mcp-server/src/fabric/dragonfly-readiness.ts:5-21` (spec header), `:119-126` (`unconfigured` short-circuit: URL unset / `dragonflyRefused` / `!cacheEnabled`, no socket opened); `types.ts:166,237`, `gather.ts:62,101,172`; `server.ts:1034`, `service.ts:9528,9548` (wiring) |
| 7 | **Fabric + healthz plumbing, no second client** — probe is the `dragonfly` fabric row truth; `healthz` body-only `cache.readiness` (status code unchanged); single `bunRedis` connection; config untouched (no new flags) | **passed** | `gather.ts:101` (`source: "health().dragonflyReadiness"`; timeout synthesizes per-row `unavailable`); `service.ts:9548` (`dragonflyReadiness()` over `redisClient()`, timeout from `cacheCommandTimeoutMs`); `server.ts:1034` (body-only, failure omits field); `config.ts` untouched per `80-SUMMARY.md:33`; docs `docs/data-planes.md:263` (DG-1a section, 0.80 rule, eviction rule, key convention) |
| 8 | **Loop harness** — focused test files + `tsc --noEmit` + `bun run lint` + `bun run check:phase-close` green | **passed** (orchestrator-verified) | Orchestrator run: **280 pass**, tsc/lint/phase-close pass. Test files present: `fabric/dragonfly-readiness.test.ts` (new), `cache.test.ts`, `fabric/gather.test.ts`, `fabric/status.test.ts` (new cases per `80-SUMMARY.md:37`); `80-PLAN.md:71-79` harness commands. Verifier did not re-run per "orchestrator verified" brief and no-mid-flight rule. |
| 9 | **Live evidence** — `docker health` line + `INFO` excerpt + `healthz cache.readiness` body + fabric `dragonfly` row recorded in `80-SUMMARY.md` | **human_needed** | See Gap 1 below. |
| 10 | **DG-1b handoff** — gate outcome + implement-or-document recommendation recorded | **passed** | `80-SUMMARY.md:18-20` (recommendation: E2 only behind green `ok`; `unavailable` blocks; `degraded` names capacity/eviction follow-up; L7-vs-docker disagreement must be resolved before enablement). Phase 81 decision itself is out of scope. |

## Evidence index (files changed, per `80-SUMMARY.md:22-33`, confirmed in `git status`)

- `packages/mcp-server/src/cache.ts` — `CacheRedis` `ping`/`info`/`probeSet`/`dbsize` (`:199-205`, `:425`, `:454-470`)
- `packages/mcp-server/src/fabric/dragonfly-readiness.ts` (new) — `probeDragonflyReadiness` (`:111`), `makeDragonflyProbe`, `resetDragonflyReadinessBaseline`, `HEADROOM_THRESHOLD` (`:30`)
- `packages/mcp-server/src/fabric/types.ts` — `DragonflyReadinessState`/`Verdict`, `FabricSources.dragonflyProbe` (`:237`), `FabricFacts.dragonflyReadiness` (`:166`)
- `packages/mcp-server/src/fabric/gather.ts` — probe read under `FABRIC_SOURCE_DEADLINE_MS` (`:62`), row mapping (`:101`), facts (`:172`)
- `packages/mcp-server/src/service.ts` — `dragonflyReadiness()` (`:9548`), `fabricSources` (`:9528`)
- `packages/mcp-server/src/server.ts` — `cache.readiness` body (`:1034`)
- `packages/mcp-server/src/fabric/fixtures.ts`, 4 test files — verdict fixtures + coverage per `80-SUMMARY.md:30-31,37`
- `docs/data-planes.md:263` — DG-1a probe contract (verdict shape, 0.80 headroom, eviction, key prefix)
- `packages/mcp-server/src/config.ts` — untouched (no new flags; thresholds are constants)

## Live probe gap note (mandatory per baseline §4: runtime truth by probes, never by intent)

As recorded in `80-SUMMARY.md:9-16` and **not closed by this verification**:

- **Docker health: captured.** `docker inspect substrate-prod-dragonfly --format '{{.State.Health.Status}}'` → `healthy` (recorded 2026-11-28). Evidence exists.
- **`bun scripts/cache-stats.ts` INFO excerpt: NOT captured.** The executor worktree lacks the built `@substrate/observability` dependency (`Cannot find module '@substrate/observability' from '.../cache.ts'`), so `INFO memory/stats` (`used_memory_bytes`, `maxmemory_bytes`, `evicted_keys` baseline+current) could not be pasted. The script was correctly left unedited (out of scope). **Human needed:** re-run `bun scripts/cache-stats.ts` in a worktree with dependencies installed and paste the excerpt into `80-SUMMARY.md` (or a follow-up evidence note).
- **`healthz cache.readiness` body + fabric `dragonfly` row: NOT captured live** for the same reason; only expected shapes are documented. **Human needed:** capture `GET /healthz` `cache.readiness` and the `fabric_status` `dragonfly` row from a running server with the endpoint configured.
- **L7-vs-docker disagreement: none observed, but L7 path unexecuted.** Docker says healthy; the L7 probe could not be run in this worktree. If a re-run shows `unavailable` while docker is `healthy`, that disagreement must be resolved before E2 enablement, not smoothed over (`80-SUMMARY.md:20`).

Until the `cache-stats.ts` excerpt and live `healthz`/fabric captures are pasted, criterion 9 stays **human_needed**; all code criteria (1–8, 10) are **passed**.

## Gaps

1. **Live INFO + healthz/fabric capture** (criterion 9) — re-run where deps are installed; paste evidence. Not a code defect.
2. **DG-1b decision** — intentionally deferred to Phase 81; the gate handoff in `80-SUMMARY.md:18-20` is sufficient for this phase.
