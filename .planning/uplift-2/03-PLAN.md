# R3 plan — Hindsight: durable retain outbox, bounded recall, cleaner config, doc fixes

## Files touched
- new `packages/mcp-server/src/retain-outbox.ts` (+ `retain-outbox.test.ts`): `RetainOutbox` (memory-only or JSONL-durable), `retainBackoffMs`, `TRANSIENT_RETAIN_REASONS`, `isTransientRetainReason`
- `packages/mcp-server/src/memory-retain.ts`: `forwardRetain` split into gate + `forwardEntry`; new `replayRetain(deps, …)` for the outbox; `RetainDeps.outbox` sink + `retainTimeoutMs`; transient failures enqueue instead of warning; `retain-not-found` evicts the ensured bank and re-ensures once; exported `emitRetainWarning` so the deferred warning keeps today's shape
- `packages/mcp-server/src/memory-recall.ts`: `recall-timeout` reason when the shared budget fires; cross-bank dedupe on `document_id ?? text` keeping the best score
- `packages/mcp-server/src/planes/hindsight.ts`: `forgetEnsuredBank(config, bank)`
- `packages/mcp-server/src/service.ts`: forward block enqueues + forgets on success + recovery drain; `searchMemory` passes the search budget; `recallMemories(input, surface, budgetMs?)`; `drainPendingRetains` also drains the outbox inside the bound; `retainOutboxStats()`; one contiguous R3 private-field block
- `packages/mcp-server/src/index.ts`: `hindsightConfigWarnings` in the boot-warning loop (shutdown drain already covered by `drainPendingRetains`)
- `packages/mcp-server/src/config.ts`: `hindsightBudgets`, `retainOutbox`, `hindsightEnv` fields appended under `// uplift-2 R3`; `hindsightConfigWarnings`
- `infra/vps/substrate-mcp.service`: one `Environment=SUBSTRATE_RETAIN_OUTBOX_PATH=/var/lib/substrate/retain-outbox.jsonl`
- `docs/grok-bot.md` (stale adapter claims), `docs/memory-governance.md` (new "Derived hits and the retain outbox" section)
- new tests: `retain-outbox.test.ts`, `memory-recall-budget.test.ts`, `hindsight-config-warnings.test.ts`; `memory-recall.test.ts` only if an expectation changes

## Knobs (defaults)
`SUBSTRATE_RETAIN_OUTBOX_PATH` unset (memory-only) · `SUBSTRATE_RETAIN_OUTBOX_MAX` 10000 · `SUBSTRATE_RETAIN_MAX_ATTEMPTS` 10 · `SUBSTRATE_RETAIN_DRAIN_MS` 30000 · `HINDSIGHT_RECALL_BUDGET_MS` 4000 · `HINDSIGHT_SEARCH_RECALL_BUDGET_MS` 1500 · `HINDSIGHT_RETAIN_TIMEOUT_MS` 8000
Backoff: 30 s × 2^(attempts−1), base capped at 1 h, ±20 % jitter. `attempts` counts the live try.

## Behaviour
- transient (`retain-timeout|network|server|rate-limit`, and the same kinds from `ensure-bank-*`) → enqueue, no warning yet; permanent (`retain.unsourced`, `retain.unredacted`, `vm-guest`, 4xx ≠ 429) → today's warning, never queued
- replay re-reads the entry by id (`IndexStore.readEntry`, exists); gone/superseded → dropped silently; same `document_id`, `update_mode: replace`
- drain: interval, after the first live success following a gate-held drain, at shutdown inside `SHUTDOWN_RETAIN_MS`; skipped while the breaker is `open` (no attempt consumed); serial, one plane call each
- bound: oldest dropped with warning reason `outbox-full`; last attempt → warning with the last transient reason (today's shape)
- durable file: 0600, dir 0700, append per enqueue, compact rewrite (tmp+rename) after a drain that changed state and once at hydrate
- recall: budget miss → `degraded: true, reason: "recall-timeout: <banks>"` (boolean `degraded` kept: every caller/type reads it as a boolean); dedupe before the sort

## Tests (written, not run)
enqueue per transient kind / never permanent; backoff schedule + jitter bounds (fake random); durable round-trip (mode, hydrate, compact); bound + oldest-dropped warning; replay re-reads by id, skips gone/superseded; exhausted warning shape = today's; drain skipped under open breaker; search/recall budgets with a slow fake bank; dedupe keeps best score; 404 evicts + re-ensures once; boot warnings once each

## Rollback
revert the R3 range; `SUBSTRATE_RETAIN_OUTBOX_PATH` unset = memory-only queue; `SUBSTRATE_RETAIN_MAX_ATTEMPTS=1` = today's one-warning behaviour.

## Verification (orchestrator)
`bun test packages/mcp-server/src/retain-outbox.test.ts packages/mcp-server/src/memory-retain.test.ts packages/mcp-server/src/memory-recall.test.ts packages/mcp-server/src/memory-recall-budget.test.ts packages/mcp-server/src/hindsight-config-warnings.test.ts packages/mcp-server/src/planes/hindsight.test.ts packages/mcp-server/src/cache.test.ts packages/mcp-server/src/service.test.ts packages/mcp-server/src/store-lock.test.ts` · `bunx tsc --noEmit` · `bun run verify`
