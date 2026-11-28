# Phase 80 Plan: DG-1a DragonflyDB Gate probe and readiness check

Source of decisions: `80-CONTEXT.md` (probe surface, readiness criteria, fail-closed gate, live evidence, DG-1b handoff). Base: wave8 worktree `/tmp/agent-substrate-wave8`. Branch per GSD (`gsd/v19-p80-dg1a-probe` or executor's default).

Rules for every task: edit only the files named for that task. Do not run builds/tests/linters/formatters mid-plan; the orchestrator/verifier runs the gates once after all tasks land (see `## Verification` loop harness). Do not commit. Do not touch `.planning/STATE.md`, `ROADMAP.md`, or other phases' files. No new HTTP routes. `healthz` never takes its status code from the cache/probe (body field only, as today). Plans only — no code edits in this phase's planning step.

## Context (confirmed in code)

- **Dragonfly client lives in `packages/mcp-server/src/cache.ts`.** Bun `RedisClient` behind the `CacheRedis` seam (`get/set/incr/mget?/eval?/scan?/unlink?/cooldownUntil?`) — **no `ping`/`info` today**. `bunRedis()` owns the lifecycle: `open()` + `cooldownUntil` (5 s `CACHE_CONNECT_COOLDOWN_MS`), per-command `deadline(..., commandTimeoutMs)` (default `COMMAND_TIMEOUT_MS = 250` ms), and `callPlane(gate, op, ...)` so a wedged server is observed as a gate `TimeoutError` and the connection is discarded. `ReadThroughCache` holds a `connected` flag and `health()` returns `{ mode, connected, hits, misses, bypasses, errors, ... }`. `createReadThroughCache(config)` builds the production client from `SubstrateConfig`.
- **Presence precedent** `packages/mcp-server/src/planning/presence-client.ts`: `dragonflyPresenceBackend(url, connectTimeoutMs, makeClient, commandTimeoutMs)` drives Bun's `RedisClient` through raw `redis.send(command, args)` with a **closed command set** `PRESENCE_COMMANDS = ["GET","SET","SCAN","TIME"]`. DG-1a needs `PING`/`INFO` (and optionally `DBSIZE`) through the same `send` path — but must reuse the cache's gate/deadline/cooldown lifecycle, not open a second connection lifecycle.
- **Config** `packages/mcp-server/src/config.ts`: `dragonflyUrl` (endpoint policy already applied — refused URLs set `dragonflyRefused`), `cacheEnabled` (URL set and `SUBSTRATE_CACHE` not `0`), `dragonflyRefused: string | null`, `cacheCommandTimeoutMs` (default 250, `SUBSTRATE_CACHE_COMMAND_TIMEOUT_MS`), `cacheConnectTimeoutMs` (default 250). No new env vars in the tracer; thresholds are constants with test injection (no `flag-registry` churn).
- **Fabric** `packages/mcp-server/src/fabric/{types,status,gather}.ts`: `FabricHealthParts` + `FabricConfigView` (classes and presence only, **no URL**); `gatherFabricFacts` reads each plane under `FABRIC_SOURCE_DEADLINE_MS = 1500` ms via `within()` (timeout/failed never throws) and memos the health computation at `FABRIC_HEALTH_WINDOW_MS = 2000` ms; the `dragonfly` row today reads only `snapshot.cache` (`answered: cache.connected`, `degraded: cache.mode === "degraded"`, `source: "health().cache"`). `buildFabricStatus`'s `serviceState` rules order: not-configured → `unconfigured`; policy-held → `degraded`; breaker open / no true answer → `unavailable`; half-open / own degradation → `degraded`; else `ok`.
- **`healthz`** (`packages/mcp-server/src/server.ts` + `service.ts` `health()`): the `cache` field is body-only; a dead cache never changes the 200/503 driver. The probe result rides in the existing body shape.
- **INFO keyset** `scripts/cache-stats.ts`: `infoFields(text, names)` + `client.send("INFO", [section])` under a wall budget; memory section `used_memory`/`maxmemory`/`maxmemory_policy`, stats section `evicted_keys` → `server: { usedMemoryBytes, maxmemoryBytes, maxmemoryPolicy, evictedKeys }`. DG-1a reuses exactly these fields (`maxmemory_bytes`/`used_memory_bytes`/`evicted_keys` semantics) — no new INFO parsing vocabulary.

### DG-1a verdict spec (binding)

Verdict shape: `{ state, reasons, metrics, checkedAt }` where `state ∈ { ok, degraded, unavailable, unconfigured }`.

1. **Liveness** — `PING → PONG` within the command timeout, routed through `callPlane` + `deadline` (cache's `commandTimeoutMs`, default 250 ms). Any timeout or throw → `unavailable`.
2. **Capacity headroom** — `INFO memory`: `maxmemory_bytes > 0` and `used_memory_bytes / maxmemory_bytes < 0.80`. Field absent (unbounded server) → metric `unknown`, **never** `unavailable` from absence alone.
3. **Eviction pressure** — `INFO stats` `evicted_keys` growth across consecutive probes (in-memory baseline lifted from INFO on first probe) → `degraded`, never `unavailable`.
4. **Write round-trip** — `SET substrate:v1:readiness:<ts> <ts> EX 60` then `GET` matches. Key uses the `substrate:v1:` prefix, one key per probe, 60 s TTL (self-cleaning; no `DEL` needed). Mismatch/throw → `unavailable`.
5. **Optional visibility** — `DBSIZE` and/or one `SCAN MATCH substrate:v1:*` page reported in `metrics` only; never changes `state`.

State precedence (first match wins): `unconfigured` (URL unset, `dragonflyRefused`, or `cacheEnabled === false`) → `unavailable` (liveness/write timeout or throw) → `degraded` (headroom breach **or** eviction growth) → `ok` (all checks pass; absent INFO fields recorded as `unknown`).

The probe is fail-closed and never fabricates: missing endpoint or any error yields `ok:false` with a bounded, redacted reason.

## Tasks (tracer-first)

### Task 1 — Tracer: liveness probe + verdict plumbing (end to end, fakes only)

Goal: thinnest vertical slice — `PING→PONG` through the real `callPlane`/`deadline` seam, verdict carried to fabric and `healthz` body, all branches testable with fakes. No INFO, no write round-trip yet.

Files:
- `packages/mcp-server/src/cache.ts` — extend the `CacheRedis` seam narrowly: add `ping(): Promise<string>` (and `info`/`probeSet` stubs only if the interface demands it — keep the tracer to `ping` alone; INFO and write methods land in Task 2). Implement `ping` in `bunRedis()` as a gated, deadline-bound `run("ping", redis => redis.send("PING", []))` reusing the existing `run` helper so timeout/discard/cooldown semantics are identical to `get`/`set`. Add `"ping"` to the `run` op union. No change to `ReadThroughCache` behaviour; `CacheRedis` stays backward compatible (fakes without `ping` answer `unavailable` from the probe, never throw).
- `packages/mcp-server/src/fabric/dragonfly-readiness.ts` (new) — `DragonflyReadinessDeps` (`ping: () => Promise<string>`, `now`, `commandTimeoutMs`), `DragonflyReadinessVerdict` (`{ state, reasons, metrics, checkedAt }`), `probeDragonflyReadiness(deps, config: { dragonflyUrl, cacheEnabled, dragonflyRefused })`. Tracer implements: `unconfigured` short-circuit (no socket opened), `PING` liveness, state precedence above. No network import of `RedisClient` here — the probe takes a `ping` thunk so tests inject fakes and no second connection lifecycle exists.
- `packages/mcp-server/src/fabric/gather.ts` — add an optional `dragonflyProbe` source (a thunk returning `Promise<DragonflyReadinessVerdict> | null`) read inside the existing `Promise.all` under `within(..., FABRIC_SOURCE_DEADLINE_MS)`; fold it into the `dragonfly` `ServiceReading` (`answered` from `state ∈ { ok, degraded }`, `degraded` when `state === "degraded"`, `source: "health().dragonflyReadiness"`). When the source is absent, the row keeps today's behaviour exactly. Never throws; a probe timeout reads as its own `unavailable` row without touching other planes.
- `packages/mcp-server/src/fabric/types.ts` — add the verdict type and the optional `FabricSources.dragonflyProbe` field. No changes to `FabricHealthParts`/`FabricConfigView` shapes beyond the optional field.
- `packages/mcp-server/src/server.ts` — include the latest probe verdict in the existing `cache` body object as `readiness` (body-only; status code unchanged). Compute lazily per computed `healthz` body (no background timer in the tracer); tolerate a null source by omitting the field.
- Tests: `packages/mcp-server/src/fabric/dragonfly-readiness.test.ts` (new) — unconfigured/refused/off short-circuit opens no socket; PONG → `ok`; non-PONG, throw, and >budget timeout → `unavailable`; timeout is bounded by injected `commandTimeoutMs` (fake timer / deferred promise, no real sleep).

Acceptance: `probeDragonflyReadiness` returns `ok` only on a real PONG; fabric `dragonfly` row and `healthz` body carry the verdict; loop harness (below) passes.

### Task 2 — Capacity, eviction, and write round-trip

Goal: complete the DG-1a verdict spec behind the Task 1 seam. No new files except the test additions.

Files:
- `packages/mcp-server/src/cache.ts` — extend `CacheRedis` with `info(section: "memory" | "stats"): Promise<string>` and `probeSet(key, value, ttlSeconds): Promise<void>` (or reuse `set` if the fake can assert TTL — prefer a `probeSet` thin wrapper calling `run("set", ...)` so the probe never depends on the cache's key/ttl policy). Wire both through `run` op names `"info"` / `"set"` (raw `redis.send("INFO", [section])` for info — there is no typed Bun INFO method; same `send` pattern as `presence-client.ts` and `scripts/cache-stats.ts`).
- `packages/mcp-server/src/fabric/dragonfly-readiness.ts` — add checks (2)–(5): parse `INFO memory`/`INFO stats` with the `cache-stats.ts` `infoFields` keyset (`maxmemory_bytes`, `used_memory_bytes`, `evicted_keys`); headroom ratio `< 0.80` with `maxmemory_bytes > 0`; absent fields → metrics `unknown` (never `unavailable`); eviction growth vs. the previous probe's baseline → `degraded` (module-level baseline keyed by nothing persisted — first probe establishes it, no growth false-positives); write round-trip `SET/GET substrate:v1:readiness:<ts>` `EX 60`; optional `dbsize`/`SCAN` reported in metrics only. Reasons are bounded strings; no URL or socket details leak.
- `packages/mcp-server/src/cache.test.ts` — extend the existing socket-level tests: `ping` through `bunRedis` against the fake/real socket harness the file already uses; a hung server yields the gate `TimeoutError` and drops the connection; `info` parse path covered via the probe tests with the fake (no new socket harness).
- `packages/mcp-server/src/fabric/dragonfly-readiness.test.ts` — headroom pass/breach/absent; `maxmemory_bytes = 0` treated as unknown not breach; eviction flat vs. growing; write round-trip pass/mismatch/throw; optional `dbsize`/`SCAN` never flips state; state precedence (`unavailable` beats `degraded`; absent INFO + passing liveness → `ok`).

Acceptance: all five spec checks plus precedence covered by tests; no test touches a live server; the probe's only production socket is the cache's existing `bunRedis` connection.

### Task 3 — Fabric truth, config truth, and DG-1b handoff surface

Goal: make the verdict the fabric's dragonfly truth (not just a side value), keep config single-sourced, and leave the DG-1b decision evidence in place.

Files:
- `packages/mcp-server/src/fabric/gather.ts` — wire the production `dragonflyProbe` source from `SubstrateConfig` (`dragonflyUrl`/`cacheEnabled`/`dragonflyRefused`/`cacheCommandTimeoutMs`) onto the `ReadThroughCache`'s `bunRedis` client (constructed or injected by the service — reuse the same gate and connection the cache uses; do not open a second `RedisClient`). The `within(..., FABRIC_SOURCE_DEADLINE_MS)` bound and the 2 s `FABRIC_HEALTH_WINDOW_MS` memo stay as they are — the probe is already covered by both. Replace the `dragonfly` row's `answered`/`degraded` inputs with the verdict when a source is present; keep the breaker and `held` inputs unchanged.
- `packages/mcp-server/src/fabric/gather.test.ts`, `packages/mcp-server/src/fabric/status.test.ts` — fabric integration: probe `ok` → row `ok`; `degraded` (headroom/eviction) → row `degraded`; `unavailable` → row `unavailable` (other rows untouched); `unconfigured` → row `unconfigured` (never `ok`); missing source keeps today's row. Add fixtures to `packages/mcp-server/src/fabric/fixtures.ts` for the verdict variants.
- `packages/mcp-server/src/config.ts` — no new flags in this phase (explicit non-goal; thresholds are constants). Document in the probe module header which configs drive it (`DRAGONFLY_URL` endpoint policy, `SUBSTRATE_CACHE`, `SUBSTRATE_CACHE_COMMAND_TIMEOUT_MS`). If the executor finds a threshold that must be tunable, add it as a registered flag in `config.ts` + `flag-registry.ts` + `.env.example` with `flag-registry.test.ts`/`config-reference.test.ts` coverage — otherwise leave config untouched.
- `docs/` — one section in the existing cache/fabric doc found by reading `docs/` (e.g. the doc that documents `fabric_status`/`healthz` cache) describing the verdict shape, the 0.80 headroom rule, the eviction rule, and the probe key convention. No generated docs hand-edited (generator runs where applicable).
- `80-SUMMARY.md` (next section) — records the gate outcome + DG-1b recommendation.

Acceptance: fabric truth flows from the probe in production wiring; no second Redis connection; no config drift; docs state the verdict contract.

## Verification (loop harness — orchestrator/verifier runs once, after all tasks)

```bash
cd /tmp/agent-substrate-wave8
bun test packages/mcp-server/src/fabric/dragonfly-readiness.test.ts packages/mcp-server/src/cache.test.ts packages/mcp-server/src/fabric/gather.test.ts packages/mcp-server/src/fabric/status.test.ts packages/mcp-server/src/fabric/compliance.test.ts packages/mcp-server/src/fabric/optimize.test.ts
tsc --noEmit -p packages/mcp-server/tsconfig.json
bun run lint
bun run check:phase-close
```

Live-evidence check (read-only, recorded in `80-SUMMARY.md`, does not gate the unit loop):

```bash
docker inspect substrate-prod-dragonfly --format '{{.State.Health.Status}}'
bun scripts/cache-stats.ts  # INFO memory/stats evidence (existing script; do not edit it)
```

## SUMMARY spec (`80-SUMMARY.md` — what the executor/verifier must produce)

- **Gate outcome**: the probe verdict at ship time (`state`, `reasons`, `metrics` verbatim including `used_memory_bytes`, `maxmemory_bytes`, ratio, `evicted_keys` baseline + current, `dbsize`/scan visibility if present).
- **Live evidence**: `docker health` status line + `INFO` excerpt + `healthz` `cache.readiness` body excerpt + fabric `dragonfly` row — runtime truth by probes (baseline §4), never by intent. Any L7-vs-docker disagreement is stated, not smoothed over.
- **DG-1b recommendation**: one paragraph — implement-or-document for Phase 81 — grounded in the observed verdict (gate `ok:false` blocks E2 enablement; `degraded` names the capacity/eviction follow-up).
- **Files changed** list matching the task file lists above; **tests** list with pass counts from the loop harness.

## Next commands (executor)

```bash
/gsd-execute-phase 80   # runs Tasks 1 → 2 → 3 in wave order (2 depends on 1's seam; 3 depends on 1–2)
/gsd-verify-work 80     # goal-backward check against the verdict spec + SUMMARY evidence
```

## Out of scope

- DG-1b implement-or-document decision (Phase 81) and E2 cache implementation (Phase 82) — this phase produces the gate, not the cache feature.
- `scripts/cache-stats.ts` edits; any new HTTP route; `healthz` status-code changes; second `RedisClient` lifecycle; persistent probe state (baseline is in-memory, re-established each boot); tunable threshold flags unless Task 3's config task proves one necessary.
- Docker-health probing from Node (recorded as live evidence in SUMMARY only).
