# Phase 81 Summary: DG-1b DragonflyDB Gate — Implement (not Document-Only)

## Decision

**Implement.** Enforcement is cheap and correct on the DG-1a probe (`probeDragonflyReadiness` → `ok`/`degraded`/`unavailable`/`unconfigured`), which is `ok` on the shipped probe (docker `healthy` 2026-11-28; fakes green). DG-1b therefore ships a `SUBSTRATE_DRAGONFLY_GATE` flag (`off|enforce`, default `off`) plus a synchronous `dragonflyGateVerdict()` consulted at `ReadThroughCache` enablement. With the flag `off` (the default) nothing changes: the DG-1a verdict stays advisory. With `enforce`, the cache bypasses to its durable read while the last verdict is neither `ok` nor `degraded`; `degraded` still serves; no request ever throws or fails because the gate closed.

## What shipped

- **Flag (Task 1).** `SUBSTRATE_DRAGONFLY_GATE` registered in `packages/mcp-server/src/flag-registry.ts` (`mode`, plane `cache`, default `off`, `readBy: "mcp-server/config.ts, cache.ts"`, documented, `doc: "docs/data-planes.md"`); parsed to `SubstrateConfig.dragonflyGate` in `packages/mcp-server/src/config.ts` (case/space-insensitive; unset/blank is `off`; anything else refuses boot naming the variable); live line + comment in `.env.example`; `docs/config-reference.md` regenerated (one new row, `docs/config-reference.md:165`).
- **Gate verdict (Task 2).** `fabric/dragonfly-readiness.ts` keeps a last-verdict store (`recordDragonflyGateVerdict` / `resetDragonflyGateVerdict` test seams) and a synchronous `dragonflyGateVerdict(mode)` that answers the last probe verdict, or `unconfigured` when the gate is `off` or no probe has recorded one yet. `probeDragonflyReadiness` records every verdict it returns, so healthz (`server.ts:1034`) and the fabric (`service.ts:9528,9548`) feed the gate with no wiring change and no second probe.
- **Enforcement (Task 2).** `cache.ts`: `ReadThroughOptions.gateMode` (absent = `off`), wired from `config.dragonflyGate` in `createReadThroughCache`. `gateAllows()` is true when `off`; under `enforce` the current `dragonflyGateVerdict("enforce").state` must be `ok` or `degraded`. Blocked gates bypass `getOrLoad` (counts a `bypass`, returns `request.load()` — durable read, never stale, never throws) and make `peek`/`peekQuiet`/`peekMany` return `null` (callers compose live). Writes and `redisClient()` are untouched, so the DG-1a probe — which rides `redisClient()` — cannot deadlock against the gate. The verdict is read per call, never baked into `enabled` at construction: the first probe runs after the cache is built, so an enablement-time snapshot would disable the cache for the process lifetime.

## Live evidence

Runtime truth by probes, not by intent:

- `docker inspect substrate-prod-dragonfly --format '{{.State.Health.Status}}'` → `healthy` (recorded 2026-11-28); gate verdict at ship time is therefore expected `ok` once a probe runs.
- No L7-vs-docker disagreement observed: docker reports the container `healthy` and the fakes probe `ok`. The L7 path (`healthz` `cache.readiness` body, fabric `dragonfly` row) is wired since Phase 80 and was not re-captured here where `@substrate/observability` is unbuilt; if it ever reads `unavailable` while docker reports `healthy`, that disagreement must be resolved before enablement, not smoothed over.
- No test touches a live server; no real sleeps (bounded by injected clocks/timeouts).

## Files changed

- `packages/mcp-server/src/flag-registry.ts` — one `FLAGS` row (`SUBSTRATE_DRAGONFLY_GATE`).
- `packages/mcp-server/src/config.ts` — `SubstrateConfig.dragonflyGate: "off" | "enforce"` + `dragonflyGateOr()` parser beside `cacheSwrOr()`.
- `.env.example` — `SUBSTRATE_DRAGONFLY_GATE=off` + comment in the Dragonfly section.
- `docs/config-reference.md` — regenerated (one row).
- `packages/mcp-server/src/fabric/dragonfly-readiness.ts` — `lastGateVerdict` store, `recordDragonflyGateVerdict`, `resetDragonflyGateVerdict`, synchronous `dragonflyGateVerdict(mode)`; `probeDragonflyReadiness` records every verdict (core moved to `probeDragonflyReadinessCore`).
- `packages/mcp-server/src/cache.ts` — `DragonflyGateMode`, `ReadThroughOptions.gateMode`, `gateAllows()`, gate checks in `getOrLoad`/`peek`/`peekQuiet`/`peekMany`, `gateMode` wired in `createReadThroughCache`.
- `packages/mcp-server/src/fabric/dragonfly-readiness.test.ts` — 4 new `dragonflyGateVerdict` tests (off → `unconfigured`; enforce/no-verdict → `unconfigured`; last verdict ok/unavailable/degraded; record + reset seams).
- `packages/mcp-server/src/cache.test.ts` — 6 new gate tests (enforce ok serves, enforce degraded serves, enforce unavailable bypasses + snapshots suppressed, enforce unconfigured bypasses, off unchanged under unavailable, `createReadThroughCache` wires the flag without touching the socket).
- `packages/mcp-server/src/flag-registry.test.ts` — defaults-agreement entry + live row/loader test (unset → `off`, `enforce`/` ENFORCE ` → `enforce`, junk throws, `.env.example` line).
- `scripts/config-reference.test.ts` — DG-1b row renders its `off \| enforce` values.
- `docs/data-planes.md` — DG-1b enforcement paragraph after the DG-1a probe paragraph.

## Tests

Loop harness, all run in this worktree:

```bash
bun test packages/mcp-server/src/fabric/ packages/mcp-server/src/cache.test.ts packages/mcp-server/src/flag-registry.test.ts scripts/config-reference.test.ts
# 330 pass, 0 fail (1822 expect() calls, 8 files)
bunx tsc --noEmit
# 0 errors
bunx biome lint .
# clean, 1873 files
bun run check:phase-close
# pass: 4 lock files green; EVENT_KINDS unchanged at 12; SURFACES 42
```

No commit was made (per phase instructions).
