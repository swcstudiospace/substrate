# N4 plan — memory lifetime enforcement, report → enforce

## What
One pure predicate decides whether a memory entry is past its `ttl`; every serving read applies it; the mode (`SUBSTRATE_MEMORY_EXPIRY=report|enforce`, default `report`) decides whether an expired entry is served tagged or left out; the retain forward refuses expired entries in both modes; the sweeper's two `entries-ttl-*` classes become deletable only under `enforce` (and still only on `apply`). Nothing is deleted by default.

## Where
- `packages/mcp-server/src/memory-policy.ts`: `memoryExpiry(entry, graph, now)`, `memoryGraphId`, `isTerminalGraphStatus`, `MEMORY_TTL_30D_MS`, types `MemoryExpiry`, `GraphLifetime`, `MemoryExpiryReason`
- `types.ts`: `MEMORY_EXPIRY_MODES`/`MemoryExpiryMode`; `MemoryEntry.expired?`, `expires_at?`; `MemoryReadOptions { includeExpired?, surface? }`
- `config.ts`: `memoryExpiry`, `memoryExpiryRejected`, `memoryExpiryConfigWarnings`; `index.ts` boot-warning loop
- `index-store.ts`: `IndexStoreOptions.memoryExpiry { mode, observe }`; `servable()` shared by `searchMemoryPage` and `memoryForBrief` (one bounded `graph_index` lookup per page, predicate, tag, hide/count); `graphLifetime(entry)` for the forward; `sweep({ expiry })`
- `index-sweep.ts`: `SweepClass.underEnforce`, `ttlClass`, `planSweep(policy, now, { expiry })`, `executeSweep(..., { expiry })`, `SweepReport.expiry`, header comment rewritten; the graph class names the graph the way `memoryGraphId` does
- `index-sweep-run.ts`: passes `config.memoryExpiry`; ledger note carries `memory_expiry`
- `memory-retain.ts`: `RetainDeps.graphLifetime`; `retain.expired` refusal in both modes
- `service.ts`: observer hook `memoryExpired`; store built with the mode + observer; `searchMemory(..., includeExpired)`, `searchMemoryPage` reads `include_expired`; cache keys carry `expiry: enforce`/`includeExpired` only when set; refresh deadlines include `expires_at`; `retainDeps` supplies `graphLifetime`; the card read is attributed
- `mcp.ts`: `memory_search.include_expired`, refused for non-operators like `force`
- `brief.ts`: `— expired` marker under report; refresh at nearest `expires_at`; read attributed to the surface
- `observe.ts` + `packages/observability/src/instruments.ts`: counter `substrate.memory.expired{surface,kind,mode=served|hidden}`
- docs: `docs/memory-governance.md` (§ Lifetime, search args, retention), `docs/data-planes.md` (index row), `docs/observability.md` (metric row)

## Flags (defaults)
`SUBSTRATE_MEMORY_EXPIRY=report` (anything else → report + boot warning). Sweep deletion of ttl rows additionally needs `SUBSTRATE_INDEX_SWEEP=apply` and `--apply`. `include_expired` needs an operator token.

## Tests
- `memory-policy.test.ts`: 30d day 29/30/31 with `expires_at`; graph open / null status / every terminal status / unindexed; permanent, unknown ttl, undatable; terminal list is the sweeper's; `memoryGraphId` fallback
- `index-store.memory-expiry.test.ts` (new, `describeLive`): report tags + counts served and brief/search agree; enforce hides + counts hidden + `includeExpired` restores; scope fallback in reads and `graphLifetime`; default store is report, uncounted; enforce paging reaches every live row once; retain forward refuses the same rows in both modes; ttl sweep classes count under report, delete under enforce in a rolled-back transaction, dry-run deletes nothing
- `index-sweep.test.ts`: `planSweep` default/report keep report, enforce flips; executeSweep dry-run under enforce counts only, apply under report counts only, apply under enforce deletes; SQL identity assertion updated; `underEnforce` statement shape
- `memory-retain.test.ts`: `retain.expired` at day 31 / forward at day 29; graph entry vs open/terminal/unindexed resolver; no resolver or failing resolver → forwarded
- `mcp.test.ts`: `include_expired` refused for a surface token on both shapes before any read, honoured for an operator, flag travels as a read option
- `memory-expiry-config.test.ts`: parsing, rejection + warning, boot loop wiring
- `instruments.test.ts`: counter series and labels
