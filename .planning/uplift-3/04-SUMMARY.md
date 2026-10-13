# N4 summary — memory lifetime enforcement, report → enforce

## What changed

- **Predicate** (`packages/mcp-server/src/memory-policy.ts`, new `// ── lifetime` section): `memoryExpiry(entry, graph, now): { expired, expires_at, reason }` — `30d` at `created + MEMORY_TTL_30D_MS` (inclusive, with `expires_at`); `graph` expired when `graph === null` (no `graph_index` row: `graph-unindexed`) or its status is in `TERMINAL_GRAPH_STATUSES` (`graph-terminal`; imported from `index-sweep.ts`, so the list cannot drift); `permanent`, an unknown `ttl` and an unparseable `created` never expire. `memoryGraphId(entry)` is the graph an entry lives for: `graph_id`, else the tail of a `graph:` scope, else none (→ unindexed). `isTerminalGraphStatus`, types `MemoryExpiry`, `GraphLifetime`, `MemoryExpiryReason`.
- **Types** (`types.ts`): `MEMORY_EXPIRY_MODES = ["report", "enforce"]`; `MemoryEntry.expired?: boolean`, `expires_at?: string` (set by every serving read; absent on a write reply or a fixture, so no fixture had to change); `MemoryReadOptions { includeExpired?, surface? }`.
- **Config** (`config.ts`, `index.ts`): `memoryExpiry` from `SUBSTRATE_MEMORY_EXPIRY` (trimmed, case-insensitive; default `report`; anything else → `report` and `memoryExpiryRejected` holds the raw value); `memoryExpiryConfigWarnings` in the one boot-warning loop, before `hindsightConfigWarnings` so the existing regex pin still holds.
- **Store** (`index-store.ts`): `IndexStoreOptions.memoryExpiry { mode, observe }` (absent = `report`, uncounted). `searchMemoryPage(search, read?)`, `searchMemory(..., read?)`, `memoryForBrief(repo, graphId, limit?, read?)` all go through private `servable(rows, read)`: `toMemoryEntry`, then ONE extra bounded query `select graph_id, status from graph_index where graph_id in ${sql(ids)}` for the page's distinct `graph`-ttl graph ids (skipped when there are none), then the predicate per row, tagging `expired`/`expires_at`, calling `observe({ surface, kind, mode })` once per expired row, and under `enforce` without `includeExpired` dropping it. The search cursor is taken from the raw page before filtering, so a thinned page still pages correctly. `graphLifetime(entry)` (public, under plane op `memory.expiry`) answers the forward. `readEntry` is untouched: it is the gate's read-back, not a serving read. `sweep({ expiry })` threads the mode into `planSweep`/`executeSweep`.
- **Sweep** (`index-sweep.ts`, `index-sweep-run.ts`): `SWEEP_CLASSES` keeps `entries-ttl-30d`/`entries-ttl-graph` as `report` with no `deleteBatch`; each now carries `underEnforce { mode: "delete", deleteBatch }` (built by `ttlClass`, same `from … where …` as the count, `limit` as the next parameter, `delete … using doomed`). `planSweep(policy, now, { expiry })` swaps them in only for `"enforce"`; `executeSweep` reports `expiry`; `formatSweepReport` prints `ttl classes: <mode>` after `(batch N)`. The graph class's predicate now names the graph as `coalesce(e.graph_id, case when left(e.scope, 6) = 'graph:' then substr(e.scope, 7) end)` — the identity `memoryGraphId` uses, so sweep and reads agree. The runner passes `config.memoryExpiry` and the ledger note carries `memory_expiry`. Header comment rewritten (the "reads do not honour TTL" bullet is gone).
- **Retain forward** (`memory-retain.ts`): `RetainDeps.graphLifetime?: (entry) => Promise<GraphLifetime | null>`; `forwardEntry` refuses `retain.expired` (warning payload `{ ttl, expiry: reason }`, locators only) **in both modes** — `report` is about what the index still serves, and a bank keeps what it is given until replaced. A `graph` entry with no resolver, or a resolver that throws, is forwarded (alive rather than guessed dead). The outbox replay reaches this through `replayRetain` and treats it as permanent.
- **Service** (`service.ts`): `SubstrateObserver.memoryExpired`; the production `IndexStore` is built with `{ mode: config.memoryExpiry, observe → observer.memoryExpired }`; `searchMemory(query, scope, limit, includeSuperseded, surface, includeExpired?)` and `searchMemoryPage(request)` (reads `request.include_expired`) pass `{ surface, includeExpired? }` as read options; cache `args` gain `expiry: "enforce"` only under enforce and `includeExpired: true` only when asked, so every pre-N4 key is unchanged in `report`; `refreshAt` is the nearest of `reverify_after` and `expires_at`; `retainDeps` supplies `graphLifetime` from the index; `teachablesForSurface` attributes its read to the card's surface.
- **MCP** (`mcp.ts`): `memory_search.include_expired` (boolean, optional); `if (request.include_expired && !isOperator) return refusal(INCLUDE_EXPIRED_REFUSED)` — the `force` gate, decided before any read, in both modes. Tool description explains `expired`/`expires_at`.
- **Brief** (`brief.ts`): `staleness()` appends `— expired` for a served expired entry (report mode only; enforce never hands one in); `deadlines` include `expires_at` of live entries so the cached brief refreshes at the nearest expiry; the read is attributed to the brief's surface. **Card** (`agent-card.ts`): an expired teachable (report mode) gets the same "Check this advice before use." prefix.
- **Metrics** (`packages/observability/src/instruments.ts`, `index.ts`, `mcp-server/src/observe.ts`): counter `substrate.memory.expired{surface,kind,mode}` (`MEMORY_EXPIRED_MODES = served|hidden`; `kind` is the closed memory-kind vocabulary; `surface` the token's surface or `unattributed`), `recordMemoryExpired`, wired from the observer hook.
- **Docs**: `docs/memory-governance.md` new § "Lifetime: what `ttl` does on read" (tables for the predicate and the two modes, counter, cache, forward, sweep), `include_expired` in the search-argument table, retention paragraph corrected; `docs/data-planes.md` index row (ttl classes under report/enforce); `docs/observability.md` metric row.

## Files

Created: `packages/mcp-server/src/index-store.memory-expiry.test.ts`, `packages/mcp-server/src/memory-expiry-config.test.ts`, `.planning/uplift-3/{04-PLAN.md,04-SUMMARY.md,env-notes/04.md}`.
Modified: `packages/mcp-server/src/{memory-policy,types,config,index,index-store,index-sweep,index-sweep-run,memory-retain,service,mcp,brief,agent-card,observe}.ts`, `packages/observability/src/{instruments,index}.ts`, `docs/{memory-governance,data-planes,observability}.md`.
Existing tests edited: `memory-policy.test.ts` (+ lifetime describe), `index-sweep.test.ts` (one SQL-identity substring updated for the graph class; + enforce tests), `memory-retain.test.ts` and `retain-outbox.test.ts` (fixture `ttl` → `permanent` so the forwards never age into `retain.expired` after 2026-11-09; + lifetime tests), `mcp.test.ts` (stub records the new read-options argument; + gate test), `instruments.test.ts` (+ counter test). `index-store.sweep.test.ts` is unchanged and still passes: `sweep()` without `expiry` is `report`.

## Flags and defaults

| Variable / argument | Default | Effect |
| --- | --- | --- |
| `SUBSTRATE_MEMORY_EXPIRY` | `report` | `report`: serve + tag + count `served`; sweep ttl classes count. `enforce`: hide + count `hidden`; sweep ttl classes deletable. Anything else: `report` + boot warning. Read by the server and the sweep job. |
| `memory_search.include_expired` | unset | Under `enforce`, also return expired entries. Operator token required (refused otherwise, both modes). |
| `SUBSTRATE_INDEX_SWEEP=apply` + `--apply` | dry-run | Unchanged; still required for any delete, ttl rows included. |

Behaviour that does not depend on the flag: the retain forward refuses expired entries; every served entry carries `expired` (and `expires_at` for `30d`).

## How it is measured

`substrate.memory.expired{surface,kind,mode}` on `/metrics` (and OTLP): `served` is what `enforce` would hide; `hidden` is what it did. Counted where the index is read, not per cache hit. The sweep report (`substrate index sweep`, `--json`, the ledger `note`) shows `ttl classes: report|enforce` and the two classes' `candidates`/`deleted`. `memory_search` replies and the brief show `expired`/`— expired` under `report`.

## Rollback

`SUBSTRATE_MEMORY_EXPIRY` unset or `report` restores serving; nothing was deleted by this item. Reverting the N4 range restores pre-N4 cache keys (they are byte-identical under `report` anyway). Entries the sweep deleted under `enforce` + `apply` are gone, as any sweep delete is — that path is three keys deep.

## Open points

- Under `enforce`, hiding happens after the SQL `limit`, so a page or the brief's ten rows can come back shorter than asked when expired rows crowd the window (paging still reaches every live row; the brief shows at most four warnings/decisions anyway). Pushing the `30d` half into SQL under `enforce` is a follow-up if the counter shows it matters.
- The graph sweep class keeps its `graphsDays` (90 d) cutoff on top of the predicate, so under `enforce` a `graph` entry is hidden the moment its graph finishes but deleted only 90 days later. Intentional (the graph row itself waits that long); noted in the docs.
- A `ttl: graph` entry with neither `graph_id` nor a `graph:` scope is treated as unindexed (expired). The gate does not refuse such a write; tightening that is a gate change, not this item.

## Gates

At the branch head after both waves merged (orchestrator-run, 2026-10-13): `bunx tsc --noEmit` clean · `bun test` with `SUBSTRATE_TEST_PG_URL` (scratch Postgres 16) **3845 pass / 1 skip / 1 fail** — the one failure is the recorded F-01 (`scripts/rehearsal.test.ts` "CLI refusals > --port 7410 exits 2", identical on `main`) · `bun run check:phase-close` pass (EVENT_KINDS 12, SURFACES 27, 4 lock files) · `bun run test:py` 298 pass.
