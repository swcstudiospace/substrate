# Phase 81: DG-1b DragonflyDB gate — plan

**Context:** `81-CONTEXT.md` (implement with fail-open default off, grounded in DG-1a probe from Phase 80). Decision recorded as **implement** (not document-only): the DG-1a probe verdict is `ok` on the shipped probe, so enforcement is cheap and correct.

## Task 1 — `SUBSTRATE_DRAGONFLY_GATE` flag

- `packages/mcp-server/src/flag-registry.ts` — one `FLAGS` row, `mode` kind, plane `cache`, default `off`, allowed `off | enforce` (case/space-insensitive; anything else refuses boot), `readBy: "mcp-server/config.ts, cache.ts"`, `documented: true`, `doc: "docs/data-planes.md"`.
- `packages/mcp-server/src/config.ts` — `SubstrateConfig.dragonflyGate: "off" | "enforce"` + `dragonflyGateOr()` parser beside `cacheSwrOr()` (`config.ts:1644`); unset/blank → `off`; anything else throws `ConfigError` naming the variable (the `loadEventBusSettings` pattern, `config.ts:1703`).
- `.env.example` — live `SUBSTRATE_DRAGONFLY_GATE=off` line + comment in the Dragonfly section (after `SUBSTRATE_CACHE`, `.env.example:235`).
- Regenerate `docs/config-reference.md` via `bun run config:reference` (the `config-reference.test.ts` committed-docs check fails otherwise); no policy block, so `docs/runbooks/flag-promotion.md` is unchanged.
- Tests: `flag-registry.test.ts` — add `SUBSTRATE_DRAGONFLY_GATE: config.dragonflyGate` to the defaults-agreement map (`flag-registry.test.ts:212`) + a live row/loader test (row kind/default, unset → `off`, `enforce` → `enforce`, `ENFORCE` → `enforce`, junk → throws, `.env.example` line, modeled on the live-lease test at `flag-registry.test.ts:257`). `scripts/config-reference.test.ts` — DG-1b row renders with its `off | enforce` values.

Acceptance: `flag-registry.test.ts` passes (lock + not-stale + `.env.example` agreement + defaults agreement); `config-reference.test.ts --check` passes; `config:reference` regeneration leaves no diff except the new row.

## Task 2 — Gate enforcement

- `packages/mcp-server/src/fabric/dragonfly-readiness.ts` — DG-1b store beside the DG-1a probe:
  - `lastGateVerdict` module state; `recordDragonflyGateVerdict(verdict)`; `resetDragonflyGateVerdict()` test seam.
  - `probeDragonflyReadiness` records every verdict it returns (wrapper over the probe core), so `makeDragonflyProbe`/`Substrate.dragonflyReadiness()` (`service.ts:9548`) feed the gate with no second client and no wiring change.
  - `dragonflyGateVerdict(mode: "off" | "enforce"): DragonflyReadinessVerdict` — synchronous; `mode === "off"` or no recorded verdict → synthetic `unconfigured` verdict (reasons are bounded phrases, no URL/error text); otherwise the last recorded verdict.
- `packages/mcp-server/src/cache.ts` — enforcement at `ReadThroughCache` enablement:
  - `ReadThroughOptions.gateMode?: "off" | "enforce"` (absent = `off`); `createReadThroughCache` wires `gateMode: config.dragonflyGate` (`cache.ts:485`).
  - `gateAllows()`: `gateMode !== "enforce"` → allow; else `dragonflyGateVerdict("enforce").state` must be `ok` or `degraded`. A still-unconfigured gate (no probe has run yet — the normal boot state) blocks; the verdict is re-read per call, never baked into `enabled` at construction (construction would permanently disable the cache, since the first probe runs after construction).
  - Gate blocks the read paths: `getOrLoad` counts a `bypass` and returns `request.load()` (durable read, never stale, never throws); `peek`/`peekQuiet`/`peekMany` return `null` (callers compose live). Writes (`put`/`putEntry`) and `redisClient()` are untouched — the DG-1a probe keeps working through `redisClient()`, so the gate cannot deadlock itself.
  - `off` never changes behavior: `gateAllows()` short-circuits before any verdict read.
- Tests:
  - `fabric/dragonfly-readiness.test.ts` — `dragonflyGateVerdict`: off → `unconfigured` even after an `ok` probe; enforce with no verdict → `unconfigured`; enforce after ok/unavailable/degraded probes → last verdict; reset clears.
  - `cache.test.ts` — new `ReadThroughCache` gate block (fakes only): enforce + ok serves a hit; enforce + unavailable/unconfigured bypasses to `load` and `peek` returns `null` even with a stored snapshot; enforce + degraded still serves; off + unavailable still serves a hit. Module state is reset per test.

Acceptance: enforce blocks on `unavailable`/`unconfigured`, serves on `ok`/`degraded`, `off` is byte-identical to today; no throw path is added; `cache.test.ts`, `fabric/*.test.ts`, `flag-registry.test.ts`, `scripts/config-reference.test.ts` green.

## Task 3 — Documentation, summary, verification

- `docs/data-planes.md` — DG-1b section after the DG-1a probe paragraph (`docs/data-planes.md:263`): flag semantics, `dragonflyGateVerdict()`, enforce rule (unavailable/unconfigured bypass, degraded serves), fail-open/durable-read guarantees, E2 (Phase 82) consumption.
- `81-SUMMARY.md` — implement choice + rationale + live verdict snapshot + file:line evidence + loop-harness results.
- Loop harness (orchestrator/verifier): `bun test packages/mcp-server/src/fabric/*.test.ts packages/mcp-server/src/cache.test.ts packages/mcp-server/src/flag-registry.test.ts scripts/config-reference.test.ts`, `tsc --noEmit -p packages/mcp-server/tsconfig.json`, `bun run lint`, `bun run check:phase-close`. No commit.
