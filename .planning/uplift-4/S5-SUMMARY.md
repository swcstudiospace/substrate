# S5 Cross-session recall in the brief (BP-5.0): warm snapshot plus Hindsight inventory and gauges (summary)

Edited only; nothing was run (no tsc, tests, formatter). Branch `u4/s5`, worktree `/root/src/repos/.wt/u4-s5`.

## What changed
- **New `packages/mcp-server/src/recall-snapshot.ts`** (imports no plane client; the recall is an injected function): `loadRecallConfig` (`SUBSTRATE_BRIEF_RECALL*`), the snapshot value (`RecallSnapshot {bank, at, hits[≤3]}`, zod-parsed on read), `snapshotState` (cold / fresh / stale at 2× TTL), `recallBriefResult`, `recallKey(mode)` (empty under `off`), `recallSection` (the `Recalled context (derived, Hindsight bank <bank>, <age> old):` section, id `recall`), `buildRecallQuery` / `buildRecallLines` (own-bank filter, exact `repo:<repo>` scope post-filter, redaction, 3 × 240 caps, dedupe), `WantedRegistry` (64 pairs LRU, 1 h expiry, known surfaces only, repo ≤ 200 chars, ≤ 3 subjects × 80 chars), `TimerSeam`/`withDeadline`, and `RecallPrefetcher` (`tick`, debounced `noteRetain`/`flush`, `start`/`stop`; single-flight slot; ≤ 2 pairs per tick, ≤ 8 per retain flush; skip on open breaker / no bank; failed or empty refresh never overwrites; timers unref'd, cleared by `stop()` which awaits the refresh in flight).
- **New `hindsight-inventory.ts`**: `loadInventoryConfig`, `HindsightInventory` (single-flight, 60 s memo, one shared 10 s `AbortSignal` handed to every call so the deadline fires inside the gated fetch, stops after the first plane-unwell failure, no call while the breaker is open), drift report (`missing`, `unconfigured`, `notChunks`; ≤ 20 names per list, `safeBankName`), `health()` block, `gauges()` (label `bank` only from the configured list, ≤ 16 banks).
- `planes/hindsight.ts`: read-only `listBanks` (≤ 50 per page, ≤ 200 banks, `truncated`), `bankStats`, `bankConfig`; `hindsightOp` gained `bank-list` and `bank-stats` (`bank-config` already existed).
- `brief-profile.ts`: `recall` in `BRIEF_SECTION_PRIORITY` (7, lowest) and `OMIT_LABEL` (`recalled`). `brief.ts`: `BriefOptions.recall {read, ttlS}` and `noteSubjects`; the snapshot read starts beside the four source reads and is not one of them (a failed read omits the section, never degrades the brief); the section is pushed before the empty check.
- `service.ts`: `briefDetailed` (mode in `args`, so in the answer key and the brief-snapshot key; one `peekQuiet` read per brief started early; `substrate.brief.recall` per answered brief), `readRecall`/`recallBriefOptions`/`noteBriefRecall`, `afterLiveRetain(surface)` hook, `startRecall`/`stopRecall`, `runRecallTick`/`flushRecallRetain`/`refreshHindsightInventory` entry points, `hindsightInventoryHealth`, `hindsightGauges`, `noteHindsightOutbox`; observer gained `briefRecall`, `recallPrefetch`, `hindsightOutbox`.
- `cache.ts`: class `recall-snapshot` (TTL constant 900, `CACHE_CLASSES`, `shapeOk`); `instruments.ts`: mirrored in `CACHE_METRIC_CLASSES`, `substrate.brief.recall`, `substrate.recall.prefetch`, `setHindsightOutbox` (three gauges), closed result sets; `observe.ts` maps the three observer methods; `config.ts`, `index.ts` (warnings, start after listen, stop in the shutdown bound); `server.ts` (additive `hindsight` block in `/healthz`, bank gauges in `/metrics.gauges`); `hindsight-fake.ts` serves the list and stats GETs; `memory-recall.ts` header and `memory-recall.test.ts` gate updated.
- Docs: `data-planes.md` (§ Recall in the brief), `memory-governance.md`, `observability.md` (metrics, routes, env, § outbox gauges, inventory and drift), `grok-bot.md` (§ Recalled context in the brief). Env: `env-notes/S5.md`.

## Flags and defaults
`SUBSTRATE_BRIEF_RECALL=off` (default), `_INTERVAL_S=120` (floor 30), `_TTL_S=900`, `_BUDGET_MS=1500`; `SUBSTRATE_HINDSIGHT_INVENTORY=off` (default), `_INTERVAL_S=60` (floor 30). The outbox gauges have no flag.

## Gauge mechanism (S7 overlap)
`registry.gauge` carries no labels, so: the three **unlabelled** outbox gauges use `registry.gauge` (in the `metrics` array, via `SubstrateInstruments.setHindsightOutbox`, set at boot, on park, on drain, after a live retain and on every `/metrics` read, always on). The four **per-bank** gauges need a `bank` label, so they use S7's `gauges` key on `/metrics` (`hindsightGauges()` beside `freshnessGauges`), only with the inventory on.

## Decisions and deviations (from evidence)
- Snapshot cache key is `surface` + `{repo, bank}`, not surface + repo only: the bank prefix is an operator setting that changes the answer (Greptile rule 5).
- The brief reads with `cache.peekQuiet`, not `peek`: `peek` counts a miss on every cold brief into the shared hit ratio S4 is trying to raise. Same read, nothing counted, failure silent.
- The cache entry lives 2 x `SUBSTRATE_BRIEF_RECALL_TTL_S`: age <= TTL `fresh` (included), TTL..2xTTL `stale` (omitted, counted: the prefetcher is behind), beyond `cold`. A pair is not recalled twice within 30 s (tick or post-retain flush).
- Review fixes: recall is active only when the bearer surface equals the brief's `surface` (else `disabled`, recall-off keys, nothing registered); the prefetcher skips (`skipped_cache`) and boot warns when the cache is unusable; `listBanks` trusts `total` over a short page and is bounded to 40 pages.
- Enforce, a fresh snapshot, but a cached brief composed before it warmed: counted `cold` (the served text carries no section); documented.
- Constants renamed `OUTBOX_*_METRIC` (not `HINDSIGHT_*`): `store-lock.test.ts` forbids the token `HINDSIGHT_` outside `packages/mcp-server/src`.
- Scope filter accepts exactly `repo:<repo>`; `global` and `graph:` hits are not kept (the index sections already carry those).
- A `recall` section placed before the empty check: a brief with recalled context never says "you are the first session here".

## Failure behaviour
Cache read fails or is cold/stale: no section, brief unchanged, `cold`/`stale` counted. Recall fails, times out (a plane failure through the gate), breaker open, Hindsight unconfigured, surface without bank: the previous snapshot stays (aging out), the attempt is counted, nothing reaches a brief. The post-retain hook is wrapped in try/catch and never fails the retain. Inventory failures are a fixed reason word in `/healthz.hindsight`, never plane text, and drop the bank gauges until the next good probe.

## Rollback
`SUBSTRATE_BRIEF_RECALL=off`, `SUBSTRATE_HINDSIGHT_INVENTORY=off` and a restart (operator steps). Snapshots are cache-only and expire; the pre-S5 cache keys stand again.

## Verify (main agent)
```
bunx tsc --noEmit
bun test packages/mcp-server/src/recall-snapshot.test.ts packages/mcp-server/src/hindsight-inventory.test.ts packages/mcp-server/src/brief-recall.test.ts packages/mcp-server/src/memory-recall.test.ts
bun test packages/mcp-server/src/brief-profile.test.ts packages/mcp-server/src/brief-fast-path.test.ts packages/mcp-server/src/cache.test.ts packages/mcp-server/src/cache-swr.test.ts packages/mcp-server/src/retain-outbox.test.ts packages/mcp-server/src/store-lock.test.ts packages/mcp-server/src/http.test.ts packages/mcp-server/src/planes/hindsight.test.ts
bun test packages/observability scripts/cache-stats.test.ts
bun test
bun run check:phase-close
```
Tests added: `recall-snapshot.test.ts` (config, keys, state, results, parse, own-bank/scope/redaction/caps, query bounds, section + compact-drop exact count, registry LRU/expiry/refusals/subjects, `withDeadline`, prefetcher off/two-per-tick/own-bank request/half-TTL skip/breaker/unconfigured/failed keeps previous/empty/deadline/single-flight/start-stop-unref/debounce/rearm), `brief-recall.test.ts` (off parity and zero calls, shadow, enforce section with bank and age, stale/cold/failing, failed prefetch, no plane call from a brief, degraded snapshot carries the section, mode in keys, compact drop first, own bank only with four banks configured, scope and redaction in the stored snapshot, open breaker, unconfigured, `afterLiveRetain` end to end, outbox gauges, cache class), `hindsight-inventory.test.ts` (closed op labels, paging and 200 cap, failure, config, hostile names, drift, gauges and labels, 16-bank cap, 20-name cap, shared deadline, stall timeout, halt, breaker, memo and single-flight, start/stop, `/healthz` and `/metrics` over a socket), `recall-metrics.test.ts` (observability: closed sets, class, gauges). `memory-recall.test.ts` gate extended to `brief.ts`, `brief-profile.ts`, `recall-snapshot.ts`.

## Residual risks
- Nothing was executed; type and test errors are possible. Places to look first: the `Map` constructor inference in `HindsightInventory.probe`; `withDeadline`'s closure-assigned `timer` narrowing; `FakeStore` + `Object.assign` in `brief-recall.test.ts` (`retainWorld`, needs `repo` scope grants to accept the write); the exact redacted text `deploy token [REDACTED] rotates weekly`; the compact-cap arithmetic in `brief-recall.test.ts` (needs the cold compact text above the 512-byte floor, which the fixture's long entries give); `SUBSTRATE_BREAKER_FAILURES=1` opening the breaker on one 500.
- One real 1 ms `AbortSignal.timeout` in the stall test (no seam for the probe deadline's clock).
- A cached brief can carry a recall section up to brief TTL + snapshot TTL old (1200 s at the defaults, an estimate); the age in the title is as of composition.
- The prefetch query only sees decision/warning subjects of briefs composed since the process started (it is not read back from the index, to avoid a second `memory.expired` count); a pair with no composed brief yet queries on the repo name alone.
- `/healthz` memoises its body for `SUBSTRATE_HEALTHZ_CACHE_MS` (5 s), so the `hindsight` block can lag the probe by that much.
- Inventory `unconfigured` drift lists every `sub-*` bank not in `HINDSIGHT_BANKS`, the surfaces' own `sub-<surface>` banks included, until they are listed (by design: that is the unreconciled state K8 asked to see).
- I used a relative path once at the start (`read` of `packages/mcp-server/src/brief.ts`), which resolved to the shared checkout; it was a read only, nothing under `/root/src/repos/agent-substrate` was written.
