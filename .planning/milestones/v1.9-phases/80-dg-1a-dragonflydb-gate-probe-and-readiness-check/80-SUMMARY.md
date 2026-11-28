# Phase 80 Summary: DG-1a DragonflyDB Gate Probe and Readiness Check

## Gate outcome

Implementation is complete for Tasks 1→2→3 in work order. The probe verdict at ship time is the one `probeDragonflyReadiness` produces for a configured cache: `state: "ok"` on a real `PONG` with passing headroom, no eviction growth and a passing write round-trip; `degraded` on headroom breach or eviction growth; `unavailable` on liveness/write timeout, throw or mismatch; `unconfigured` when `dragonflyUrl` is unset, `dragonflyRefused` is set or `cacheEnabled` is false. Verdict shape, verbatim: `{ state, reasons, metrics, checkedAt }` where `metrics` carries `used_memory_bytes`, `maxmemory_bytes`, `headroom_ratio`, `evicted_keys`, `evicted_keys_baseline`, plus `dbsize`/`scan_keys` when the client answers them. Absent INFO fields (unbounded server) are `null` (`unknown`) in metrics and never flip the state.

Per the phase contract no builds/tests/linters were run mid-flight; the orchestrator/verifier runs the loop harness once after all tasks land (see Tests below). No commit was made.

## Live evidence

Runtime truth by probes, not by intent:

- `docker inspect substrate-prod-dragonfly --format '{{.State.Health.Status}}'` → `healthy` (recorded 2026-11-28).
- `bun scripts/cache-stats.ts` could not be run from the executor worktree: the unbuilt `@substrate/observability` dependency is missing there (`Cannot find module '@substrate/observability' from '.../packages/mcp-server/src/cache.ts'`). The script was not edited (out of scope). The verifier should re-run it where dependencies are installed and paste the INFO excerpt.
- `healthz` `cache.readiness` body excerpt and the fabric `dragonfly` row are wired but were not captured live in this worktree for the same reason; expected shapes are `cache.readiness: { state, reasons, metrics, checkedAt }` (body-only, status code unchanged) and a `dragonfly` row with `source: "health().dragonflyReadiness"`.
- Any L7-vs-docker disagreement is stated, not smoothed over: there is currently none observed (docker reports the container healthy; the L7 probe path could not be executed here).

## DG-1b recommendation

Docker health reports the container `healthy`, so the DG-1b chain (Phase 81) can proceed to the implement-or-document decision grounded in the observed gate: with the gate in place, Phase 81 should document that Dragonfly readiness is now measured by DG-1a and implement the E2 cache only behind a green `ok` verdict, treating any `unavailable` verdict as blocking enablement and any `degraded` verdict as naming the capacity/eviction follow-up (raise `maxmemory` or the 0.80 headroom budget) rather than failing the gate. If the DG-1a gate ever reads `unavailable` while docker reports `healthy`, that L7-vs-docker disagreement must be resolved before enablement, not smoothed over.

## Files changed

- `packages/mcp-server/src/cache.ts` — `CacheRedis` extended with optional `ping`/`info`/`probeSet`/`dbsize`; `bunRedis` implements them through the existing gated, deadline-bound `run` (new op names `ping`/`info`/`dbsize`, `probeSet` via `run("set", …)`; `PING`/`INFO`/`DBSIZE` via `redis.send`).
- `packages/mcp-server/src/fabric/dragonfly-readiness.ts` (new) — `probeDragonflyReadiness`, `makeDragonflyProbe`, `resetDragonflyReadinessBaseline`, constants `HEADROOM_THRESHOLD` (0.80), `READINESS_TTL_S` (60), `READINESS_PREFIX`; INFO parsing reuses the `cache-stats.ts` keyset; in-memory `evicted_keys` baseline.
- `packages/mcp-server/src/fabric/types.ts` — `DragonflyReadinessState`/`DragonflyReadinessVerdict`, optional `FabricSources.dragonflyProbe`, optional `FabricFacts.dragonflyReadiness`.
- `packages/mcp-server/src/fabric/gather.ts` — probe read under `FABRIC_SOURCE_DEADLINE_MS` (timeout/failed synthesizes an `unavailable` verdict for its row alone); `dragonfly` row follows the verdict when present, today's `health().cache` row otherwise; facts carry the verdict.
- `packages/mcp-server/src/service.ts` — `Substrate.dragonflyReadiness()` over the cache's own `redisClient()` (no second client, timeout from `cacheCommandTimeoutMs`); `fabricSources()` exposes it as `dragonflyProbe`.
- `packages/mcp-server/src/server.ts` — `GET /healthz` body gains `cache.readiness` when a verdict exists (body-only; `healthStatus` unchanged); probe failure omits the field.
- `packages/mcp-server/src/fabric/fixtures.ts` — verdict fixture helpers (`okReadiness`, `degradedReadiness`, `unavailableReadiness`, `unconfiguredReadiness`).
- `packages/mcp-server/src/fabric/dragonfly-readiness.test.ts` (new), `packages/mcp-server/src/fabric/gather.test.ts`, `packages/mcp-server/src/fabric/status.test.ts`, `packages/mcp-server/src/cache.test.ts` (fake-server `PING`/`INFO`/`DBSIZE` answers plus one socket-level probe test).
- `docs/data-planes.md` — DG-1a probe section replacing the stale no-ping limitation.
- `packages/mcp-server/src/config.ts` — untouched (no new flags; thresholds are constants).

## Tests

Written (counts to be confirmed by the loop harness): `dragonfly-readiness.test.ts` 10 tests (unconfigured/refused/off short-circuit with no socket, PONG ok, non-PONG/throw/hung unavailable, absent INFO unknown, maxmemory 0 unknown, headroom pass/breach, eviction flat/growth, write round-trip pass/mismatch/throw, unavailable-beats-degraded, dbsize/scan metrics-only); `gather.test.ts` 4 new tests (probe ok, degraded/unavailable/unconfigured mapping with other rows untouched, missing/null source keeps today's row, probe timeout is its row's unavailable); `status.test.ts` 1 new test (probe-derived reading shapes); `cache.test.ts` 1 new socket test (ping/info/probeSet/dbsize through `bunRedis`). No test touches a live server; no real sleeps (bounded by injected `commandTimeoutMs`).

Loop harness (orchestrator/verifier):

```bash
bun test packages/mcp-server/src/fabric/dragonfly-readiness.test.ts packages/mcp-server/src/cache.test.ts packages/mcp-server/src/fabric/gather.test.ts packages/mcp-server/src/fabric/status.test.ts packages/mcp-server/src/fabric/compliance.test.ts packages/mcp-server/src/fabric/optimize.test.ts
tsc --noEmit -p packages/mcp-server/tsconfig.json
bun run lint
bun run check:phase-close
```
