# U5-3 — request-path efficiency for `memory.brief` and `/healthz`

Slice branch `u5/s3`. Edit-only: nothing below was executed (no tsc, no `bun test`).

## What changed

| File | Change |
| --- | --- |
| `packages/mcp-server/src/config.ts` | `requestPath` settings (`briefGraphRead`, `cacheBumpScope`, `healthzIndexCapacityMemoS`, `problems`), `loadRequestPathSettings`, `requestPathConfigWarnings`, `MAX_HEALTHZ_INDEX_CAPACITY_MEMO_S = 300`. Appended `// uplift-5 U5-3` blocks at the end of the type and of `loadConfig`'s object. |
| `packages/mcp-server/src/index.ts` | `requestPathConfigWarnings(config)` joins the boot warning list (the seam every flag uses). |
| `packages/mcp-server/src/cache.ts` | `RECALL_GENERATION_KEY` (`substrate:v1:gen:recall`, class `gen`, no new key class). |
| `packages/mcp-server/src/index-store.ts` | `getGraphForBrief` (plane op `graph.brief`): `graph_index` and `graph_nodes` through `Promise.allSettled`, `steps`/`edges` empty. `capacity()` computes `pg_total_relation_size` once (inner select, ordered on `relations.total_bytes`, the number; same output columns and shape). |
| `packages/mcp-server/src/brief.ts` | `BriefOptions.graphRead`; the graph read uses `getGraphForBrief` only when it is `lite`. |
| `packages/mcp-server/src/service.ts` | `briefOptions.graphRead`; `narrowBumps`; brief generations drop the graph key under `narrow`; the post-retain and outbox-replay bumps move to `RECALL_GENERATION_KEY` under `narrow`; the merged search and recall search list the recall generation under `narrow`; `/healthz` capacity memo (`indexCapacityForHealth`). |
| `packages/mcp-server/src/server.ts` | `/healthz` single flight (`healthFlight`, cleared in `finally`). |
| `packages/mcp-server/src/request-path.test.ts` | New tests (below). |
| `packages/mcp-server/src/index-store.capacity.test.ts` | One test: the size function is evaluated once and the sort is numeric. |
| `docs/data-planes.md`, `docs/observability.md` | § Request-path flags with the per-class dependency table; § Verifying the request-path flags; three configuration rows. |
| `.planning/uplift-5/env-notes/S3.md` | The `.env.example` lines. |

## Flags

| Flag | Default | Values |
| --- | --- | --- |
| `SUBSTRATE_BRIEF_GRAPH_READ` | `full` | `full` \| `lite` |
| `SUBSTRATE_CACHE_BUMP_SCOPE` | `legacy` | `legacy` \| `narrow` |
| `SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S` | `0` | integer seconds `0..300` (larger: capped and named; negative / non-numeric: `0` and named) |

Unset or empty is silent. Unknown values keep the default and are reported by `requestPathConfigWarnings` at boot; nothing throws at request time. Flags unset: no key, statement, text or response changes. (One non-flag change: the `capacity()` statement text; same columns, same sort order, result identical.)

## Cache classes: inputs and what covers them

Under `legacy` nothing below differs from today. `narrow` differences marked.

| Class | Inputs that change the answer | Covered by |
| --- | --- | --- |
| Brief (`brief`; `brief-snapshot` is generation-free with the same args) | repo, branch, graph id, expiry mode, recall mode and bank, surface (all in the key); memory rows; graph rows (status, surface, PR link, nodes, claims); lease expiry baked into the text | key args for the first group; `gen:memory` for memory writes; `gen:graphs` for every `bumpGraph` and the reaper; `refreshAt` (earliest lease expiry / reverify / expiry) for time. The per-graph key is listed under `legacy` only. Heartbeat bumps nothing else; `describeNode` prints `claimed_at`, never the lease expiry, and `decideHeartbeat` refuses an expired lease so a heartbeat can never turn a printed "expired/free" line back into "held". The recall section is read from the generation-free `recall-snapshot`, so neither `gen:memory` nor `gen:recall` covers it and it is unaffected. |
| Paged memory search (`memory-search`) | query, scope, cursor, limit, superseded, expiry mode, surface; memory rows; graph status for `ttl: graph` entries | key args; `gen:memory`; `gen:graphs`. Index only: no recall generation. |
| Merged memory search (`memory-search`) | the above plus the Hindsight recall merged in | the above plus `gen:recall` under `narrow` (under `legacy` the retain bumps `gen:memory`, already listed). |
| Recall search (`memory-search`, `memory_recall`) | query, banks, surface; what Hindsight holds | key args; `gen:memory` (accept, before the retain lands); `gen:recall` under `narrow` (retain / replay landing). |
| Graph view (`graph-view`) | graph id, surface, every node and lease column | the graph's own key: bumped by `bumpGraph` **and** by a heartbeat, under both scopes (the view prints lease expiry). |

Writers of the per-graph key, checked in `service.ts`: `bumpGraph` (always with `gen:graphs`), the reaper (graph key per graph, then `gen:graphs`), and `heartbeatNode` (key alone). So dropping the key from the brief loses nothing except heartbeats.

## Tests (`request-path.test.ts`) and what each proves

- Config: unset is today's defaults with no warnings; vocabulary is case/space tolerant and the memo floored; unknown values keep defaults and are named; memo capped at 300 and negative refused.
- Graph read: for five graph shapes (no nodes, 40 nodes with held/lapsed/done/canceled/linked, held+lapsed, PR link, missing graph) `lite` text, `refreshAt` and failed sources equal `full`'s, and each shape renders its expected fragments (so equality is not vacuous). Statement counts with a spy connection: `full` = 4 serial statements; `lite` = 2, both open before either is answered. Failure parity for `graph_index`/`graph_nodes` failures and the no-row case. The service picks `getGraphForBrief` only under the flag.
- Cache scope, each run under `legacy` and `narrow` through `Substrate` with a held-retain Hindsight fake: brief (accept seen at once; retain flush legacy only; MEMORY `2` vs `1` and `gen:recall` only under narrow), paged search, merged and recall search (a recall cached in the gap between accept and retain is flushed by the retain, so a stale read is impossible), heartbeat (graph view always flushed and current; briefs unflushed under narrow with identical text), graph write (briefs, merged search, graph view all flushed and current), accept flushes a cached recall, outbox replay (recall current; brief and paged search flush only under legacy), default is legacy (MEMORY `2`, no recall key).
- `/healthz`: six concurrent probes → one ping and identical bodies (`stale: false`), next probe is the memo; a rejected compute fails its joiners (500) and the next probe computes again (flight cleared in `finally`); memo off → every probe computes. Capacity memo: unset measures each body; TTL boundary (59.999 s reuse, 60 s remeasure), one runway sample per measurement; 300 s cap; a failure stores nothing; concurrent bodies join one measurement.
- `index-store.capacity.test.ts`: one `pg_total_relation_size(` call in the statement, numeric sort.

Existing `cache.test.ts:1008` (MEMORY `2` after a write plus retain) is the legacy expectation and is unchanged; the narrow variant is in the new file.

## Smoke commands for the orchestrator

```
bun test packages/mcp-server/src/request-path.test.ts packages/mcp-server/src/index-store.capacity.test.ts packages/mcp-server/src/cache.test.ts packages/mcp-server/src/brief-fast-path.test.ts packages/mcp-server/src/retain-outbox.test.ts packages/mcp-server/src/memory-expiry-config.test.ts
bun run check:phase-close
```
Expected: all pass; `memory-expiry-config.test.ts` reads `index.ts` source and still matches (the warning array gained one spread after it).

Live (operator, after merge): `SUBSTRATE_BRIEF_GRAPH_READ=lite` → `/metrics` `substrate.plane.duration{op="graph.brief"}` appears; `SUBSTRATE_CACHE_BUMP_SCOPE=narrow` → `gen:recall` counter present in redis and `brief` misses per accepted write drop from 2 to 1.

## Operator steps

None are performed by code. To enable: set the variables in the unit's environment file and restart `substrate-mcp`; to roll back, unset and restart.

## Deviations, limits, unknowns

- `getGraphForBrief` uses `Promise.allSettled`: a hung `graph_nodes` statement delays surfacing a `graph_index` failure (and its plane/breaker sample) until the brief deadline, unlike the serial `full` read. Brief text and failed-source result are unchanged.
- `SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S`: a fractional value is floored and named at boot (so `0.5` is `0`, named); the memo treats a negative age (wall clock stepped back) as expired.
- Review fixes: the staleness paragraph now states the `recall-snapshot` bound under `SUBSTRATE_BRIEF_RECALL=enforce`.
- Greptime prelude and index ping left serial (SUMMARY says so as the brief allowed): concurrency would change which plane's failure is reported first and the breaker sample order.
- `legacy` "would have avoided" counter: not added (optional, not cheap without a metric label row). No new metric, label or plane name other than the plane op label `graph.brief`; `op` is a free-form per-call-site label (checked: no closed list contains `graph.get`).
- Capacity memo: a reused report is not offered to the runway ring again (one sample per measurement), so with a memo the ring sees one sample per window.
- Capacity statement: the inner select orders by `relations.total_bytes` (numeric). Not run against Postgres; the live test file has no capacity test, so the statement text is verified only by the fake-pool test. Nothing in the scratch-Postgres suite executes `capacity()`, so hit `/healthz` against the scratch database once to confirm `capacity.index.tables` still lists the largest relations in order.
- Tests were not executed. The healthz concurrency test counts arrivals through an accessor on `config.healthzCacheMs` (read once per `/healthz` request) and polls with `setImmediate` turns, not timers.
- The brief's recorded claim that `lease_expires_at` is never printed was checked against `describeNode`: true. The recent-actions Greptime read, pool keepalive and `kind` filter in `memoryForBrief` were not touched (lane L8 rejected them).
