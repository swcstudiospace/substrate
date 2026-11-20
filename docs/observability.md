# OTLP metrics, traces and SLOs

Tracked as SPE-4793. Owned by `packages/observability`; wired into `substrate-mcp`
by `packages/mcp-server/src/observe.ts`.

## The store lock still holds

The observability plane touches **no store**. Greptime holds the substrate's
*application* events — what agents did — and an agent's latency is not one of
those. Nothing in `packages/observability` imports the ledger client, reads a
`GREPTIME_*` variable or names `agent_events`, which is what
`packages/mcp-server/src/store-lock.test.ts` keeps true.

| | Holds | Reached through |
| --- | --- | --- |
| Application events (`agent_events`) | GreptimeDB | `substrate-mcp` only |
| Memory, graphs, claims | Postgres / TimescaleDB | `substrate-mcp` only |
| Latency, errors, tokens, cost | in-process, pushed over OTLP | `substrate-mcp` only |
| MCP audit (allowed/denied) | local hash-chained JSONL | `substrate-mcp` only |

Langfuse keeps LLM traces. This keeps the substrate's own. No duplication.

## Why it is hand-rolled

Same reason `greptime.ts` is a hand-rolled HTTP client. This code sits on the
critical path of every prompt on the host, it must fail open, and the whole
surface it needs is two instrument kinds and one snapshot. A collector still
receives standard OTLP/HTTP with JSON encoding, so `@opentelemetry/collector`,
Grafana Alloy, Honeycomb and Langfuse's OTLP endpoint all accept it unchanged.

Export never throws. A collector being down is not a reason for a prompt to be.

## Instruments

Every latency and error instrument carries `surface` and `graph_id` — the pair the
substrate is keyed by. `surface` says which of the eight agents on the host;
`graph_id` says which uplifted prompt.

| Metric | Kind | Attributes |
| --- | --- | --- |
| `substrate.brief.duration` | histogram, ms | `surface`, `graph_id`, `outcome` |
| `substrate.emit.duration` | histogram, ms | `surface`, `graph_id`, `kind` |
| `substrate.emit.total` | counter | + `outcome` = `stored` \| `dropped` |
| `substrate.request.duration` | histogram, ms | `surface`, `route`, `status` |
| `substrate.request.total` | counter | as above |
| `substrate.tool.calls` | counter | `surface`, `tool`, `decision` |
| `substrate.tokens` | counter | `surface`, `graph_id`, `model`, `direction` |
| `substrate.cost.usd` | counter, double | `surface`, `graph_id`, `model` |
| `substrate.lease.claims` | counter | `surface`, `graph_id`, `outcome` |
| `substrate.lease.steals` | counter | `surface`, `graph_id` |
| `substrate.quarantine.total` | counter | `surface`, `graph_id`, `reason` |
| `substrate.audit.appends` | counter | `decision`, `outcome` |
| `substrate.trace.spans_dropped` | counter | — |
| `substrate.plane.duration` | histogram, ms | `plane`, `op`, `outcome` = `ok` \| `error` \| `timeout` \| `open` |
| `substrate.plane.errors` | counter | `plane`, `reason` = `timeout` \| `network` \| `server` \| `open` \| `other` |
| `substrate.admission.decisions` | counter | `surface` (a known surface or `anonymous`), `class` = `read` \| `write` \| `coordination`, `decision` = `allowed` \| `limited` \| `shadow_limited` \| `bypass` \| `refused` |
| `substrate.metrics.history.dropped` | counter | `reason` = `breaker_open` \| `unavailable` \| `rejected` \| `ddl` \| `schema` \| `invalid` \| `capped` \| `internal` (rows not stored; registered only with `SUBSTRATE_METRICS_HISTORY=on` and a ledger) |
| `substrate.docs.search` | counter | `surface`, `outcome` = `hit` \| `empty` \| `degraded`, `cached` = `true` \| `false` |
| `substrate.docs.citations` | counter | `provenance` = `recorded` \| `unrecorded` \| `unpinned` |
| `substrate.docs.duration` | histogram, ms (own edges, incl. 2000 and 4000) | `surface`, `cached` |
| `substrate.cache.operations` | counter | `class` = `brief` \| `memory-search` \| `graph-view` \| `brief-snapshot` \| `recall-snapshot` \| `docs-search` \| `emb` \| `budget` \| `gen` \| `unknown`, `result` = `hit` \| `miss` \| `coalesced` \| `stale` \| `refresh` \| `would_serve_stale` \| `bypass` \| `error`, `mode` = `off` \| `on` \| `degraded` (uplift-4 S4: `coalesced` joined another caller's load; `stale` served a last-good brief; `refresh` a background refresh started; `would_serve_stale` only under `SUBSTRATE_CACHE_SWR=shadow`) |
| `substrate.memory.expired` | counter | `surface`, `kind` (memory kind), `mode` = `served` \| `hidden` — entries past their `ttl` met by an index read (uplift-3 N4; `docs/memory-governance.md` § Lifetime) |
| `substrate.events.replay` | counter | `result` = `deduplicated` \| `appended` \| `refused` \| `lookup_failed` — one per `POST /events` that took the idempotency lookup (a replay-marked request under `accept`, any keyed one under `enforce`) or was refused on the idempotency rules; silent while `SUBSTRATE_EVENT_IDEMPOTENCY=off`. A `deduplicated` replay is not counted as an emit (U5-4a; `docs/greptime-ledger.md` § Idempotent replay) |
| `substrate.brief.result` | counter | `surface` (a known surface or `unknown`), `state` = `complete` \| `degraded` \| `snapshot`, `result` = `fresh` \| `not_modified` — one per brief answered at either door; `not_modified` is a REST 304 or an MCP `not_modified: true` (uplift-3 N7) |
| `substrate.brief.profile_bytes_saved` | counter | `surface` (a known surface or `unknown`) — full minus compact UTF-8 bytes of a fresh brief, recorded in `shadow` and `enforce` only and never below zero (uplift-4 S1; `docs/grok-bot.md` § The brief profile) |
| `substrate.brief.profile` | counter | `surface`, `profile` = `full` \| `compact`, `mode` = `off` \| `shadow` \| `enforce` — one per brief answered; `profile` is what was served |
| `substrate.served.tokens_est` | counter | `surface`, `tool` = `brief` \| `recall` \| `docs` — an **estimate**, `ceil(bytes / 4)` of the reply text (fresh briefs only, not a 304); a separate series, never added to the model-reported `substrate.tokens` (uplift-4 S1) |
| `substrate.brief.recall` | counter | `surface` (a known surface or `unknown`), `result` = `included` \| `would_include` \| `cold` \| `stale` (older than `SUBSTRATE_BRIEF_RECALL_TTL_S`, up to twice it) \| `dropped_by_cap` (enforce: the section was composed but the compact profile's byte cap cut it, so the text served carries none; `included` means the served text carries it) \| `disabled` (no repo, no Hindsight, no cache, a bearer that is not the surface named, or an anonymous caller) — one per brief answered while `SUBSTRATE_BRIEF_RECALL` is `shadow` or `enforce`; nothing under `off` (uplift-4 S5; `docs/data-planes.md` § Recall in the brief) |
| `substrate.recall.prefetch` | counter | `surface`, `result` = `ok` \| `empty` \| `error` \| `skipped_breaker` \| `skipped_unconfigured` \| `skipped_cache` — one per recall snapshot refresh attempt (uplift-4 S5; `skipped_cache`: the cache cannot hold a snapshot, so no recall was sent) |
| `substrate.hindsight.retain_outbox.size`, `.oldest_age_seconds`, `.durable` | gauge | none — the retain outbox's depth, the age of its oldest parked forward (0 when empty) and 1 when it survives a restart; read in-process, always present (uplift-4 S5) |
| `substrate.hindsight.bank.facts`, `.pending_operations`, `.failed_operations`, `.last_write_age_seconds` | gauge (served on `GET /metrics` under `gauges`, not in `metrics`) | `bank` — only a bank named in `HINDSIGHT_BANKS`, never a string the plane sent; present only with `SUBSTRATE_HINDSIGHT_INVENTORY=on` and after a probe that answered |
| `substrate.index.archive.age_seconds` | gauge, s (a registry gauge: in `/metrics` `metrics[]` and OTLP, not checkpointed) | — (no attributes; absent until an archive exists, installed only with `SUBSTRATE_INDEX_ARCHIVE_DIR`) |
| `substrate.docs.freshness_seconds` | gauge, s (**`/metrics` `gauges` only**, not in `metrics[]` and not OTLP) | `dataset` (a configured dataset name; absent until the dataset has a recorded version) |
| `substrate.docs.trigger_lag_seconds` | gauge, s (**`/metrics` `gauges` only**, as above) | `dataset`; `0` once the newest accepted merge-trigger's commit has a recorded version |

`status` is a class (`2xx`, `5xx`), not a code, and `route` is one of the known
paths or `other` — an unauthenticated caller walking random URLs must not be able
to mint a metric series per URL it tries. `plane` is one of the five data planes
(`greptime`, `index`, `cache`, `hindsight`, `lightrag`) and `op` is a fixed label per
client — a SQL verb for the ledger, a route-table entry for the HTTP planes
(`recall`, `retain`, `retrieve`, `datasets`, …), a command name for the cache —
never a statement or a URL.

Every counter and histogram is **cumulative and monotonic** (a gauge is a reading, recomputed after a restart and never checkpointed). The exporter pushes the same running
totals every interval and never resets, so a missed export is harmless: the next
one carries what the lost one would have.

### `graph_id` is bounded

`graph_id` is one per uplifted prompt, so a metric keyed by it grows without
limit. Past a per-instrument cap (`DEFAULT_MAX_SERIES`, 500) the volatile
attributes — `graph_id`, `session_id`, `node_id`, `model` — collapse into
`_overflow`, and **the observation is still counted**: dropping it would drift the
emit-success ratio the SLO is computed from.

That soft cap only bounds growth if the attributes it does *not* collapse are
genuinely bounded, which was an assumption each call site had to keep rather than a
property the code enforced — and it did not hold: `tool` came straight from a
caller-supplied JSON-RPC `params.name`, so one series per invented name could be
minted without limit. Two things fix it. `observe.ts` maps an unrecognised tool name
to a single `unrecognized` bucket, drawn from the list of tools the substrate
actually serves — the audit chain still records the name exactly as sent, because
that is a log, where the real value is the point. And `HARD_MAX_SERIES` is a ceiling
past which *every* attribute collapses, so the bound no longer depends on each call
site getting it right. Attribute values are capped too, since a series key is held for
the life of the process.

The cap is **per attribute**, and the attributes a value is *read back by* get a longer
one. `graph_id`, `session_id` and `node_id` are capped at `MAX_IDENTIFIER_ATTRIBUTE_LENGTH`
(512, the same `MAX_FIELD` the event path and the audit record use), because
`substrate evidence` finds a graph's token and cost totals by searching with the full id.
At the general 120-character cap the two ends disagreed: an id longer than that recorded
truncated and its usage could never be found again — and worse, an id of exactly 120
characters received the totals of every longer id sharing its prefix, so one graph's spend
was reported as another's. Anything that still exceeds its cap is shortened by
`boundValue`, which appends a digest of the whole value to the prefix rather than
truncating: bounded, and unique to its input, so two values can no longer collide into one
series.

The cardinality cost is visible in exactly one place, and is
reported there rather than papered over: a graph whose series collapsed has no
separable token or cost total, so `substrate evidence` says so instead of printing
another graph's numbers.

### Tokens and cost

A collector attaches usage to the event payload. The canonical shape:

```json
{ "usage": { "input_tokens": 1200, "output_tokens": 340, "cost_usd": 0.0123, "model": "opus" } }
```

`extractUsage` also reads `tokens_in`/`tokens_out` and `prompt_tokens`/
`completion_tokens`, because five collectors already speak different dialects and
rewriting all of them is not this ticket. Counts must be **numbers**: a string
under a token key is not a count and the redactor treats it as a credential (see
below). An event with no usage contributes nothing rather than a zero, so a
`shell` event does not drag a graph's averages down.

> **A bug this surfaced.** `redactValue`'s sensitive-key rule matched the substring
> `token`, so every `input_tokens` count reached the ledger as `[REDACTED]` —
> invisibly, because a redacted field looks like redaction working. The exemption
> added in `redact.ts` is an explicit list of counter names *and* requires a finite
> numeric value: `{"tokens": "sk-ant-…"}` is still redacted whole, and so is
> `{"<password-key>": 123456}`. A number is not inherently safe; a named count is. The full
> exemption is documented in the counter-exemption section of [`redaction.md`](redaction.md).

## Plane circuit breakers (uplift-2 R2)

Every outbound call to a data plane goes through `callPlane` in
`packages/observability/src/breaker.ts`: ledger SQL (`greptime.ts`), index
queries (`index-store.ts`), cache connects and commands (`cache.ts`), and every
Hindsight and LightRAG request (the gated `fetch` `Substrate` hands to
`planes/*.ts`). One `CircuitBreaker` per plane, closed → open → half-open:

- after `SUBSTRATE_BREAKER_FAILURES` (default **5**) consecutive failures — a
  transport error, a timeout, or a 5xx; a 4xx or a SQL error is the caller's fault
  and does not count — the breaker **opens** and every call fails in microseconds
  with `BreakerOpenError` instead of waiting out a timeout;
- after `SUBSTRATE_BREAKER_OPEN_MS` (default **30000**) it goes **half-open** and
  admits exactly one probe; success closes it, failure re-opens it for another
  window;
- `SUBSTRATE_BREAKER=0` is the kill switch: breakers are `null`, every call runs
  unwrapped exactly as before, and the plane series are still recorded.

A refusal reaches each caller **exactly where a network error would**: the brief
source read fails open, `memory_recall` answers `degraded: true` with a reason
containing `circuit open`, `docs_search` answers `{chunks: [], degraded: true,
reason: "lightrag circuit open"}`, and the fail-closed paths (emit, claim) stay
closed. The cache additionally refuses to reconnect for `CACHE_CONNECT_COOLDOWN_MS`
(5 s) after a failed connect, reported as `cache.cooldownUntil` in `/healthz`.

The cache's admission buckets follow a declared policy while that breaker refuses them. The flags are `SUBSTRATE_BUDGET_READ_BREAKER`, `SUBSTRATE_BUDGET_WRITE_BREAKER`, and `SUBSTRATE_BUDGET_COORDINATION_BREAKER`. Unset or blank is today's `fail-open`: the request is admitted and counted as a `bypass`. `fail-closed` answers `503` with `{"error":"cache_unavailable"}` and the breaker's `Retry-After` only in `enforce`; in `shadow` the same refusal is recorded as a `bypass` and never refuses. The brief and recall never depend on the cache: a refused cache read falls through to the source, so the answer is the source's. A refused generation bump is in-process only (R1): `staleGenerations` lives in the writing process, so after a restart or on another replica a brief written before the write can still be served until the 5-minute brief TTL.

`bun scripts/cache-stats.ts` (uplift-4 S4) is the operator-run, read-only census of the cache's key classes and value bytes and the `maxmemory` they justify: bounded `SCAN`, `TYPE` and `STRLEN`, no value read, loopback URLs only unless `--allow-remote`. The hit, stale and coalesced ratios come from the running service's `/healthz`, which needs the bearer: set `SUBSTRATE_TOKEN` or `SUBSTRATE_TOKEN_FILE` (first entry of a list; it is sent only as an `Authorization` header and never printed); a 401/403 is reported by name in the output.

`GET /healthz` carries one row per plane, **report-only** — the status code still
comes from the ledger and the index alone:

```json
"planes": {
  "greptime":  { "ok": true,  "breaker": { "plane": "greptime", "state": "closed", "failures": 0, "openedAt": null, "lastErrorAt": null, "lastError": null }, "lastErrorAt": null },
  "index":     { "ok": true,  "breaker": { "state": "closed", "…": "…" }, "lastErrorAt": null },
  "cache":     { "ok": null,  "breaker": { "…": "…" }, "lastErrorAt": null },
  "hindsight": { "ok": false, "breaker": { "state": "open", "failures": 5, "openedAt": 1791480000000, "lastErrorAt": 1791480000000, "lastError": "hindsight GET /health: timed out" }, "lastErrorAt": 1791480000000 },
  "lightrag":  { "ok": null,  "breaker": null, "lastErrorAt": null }
},
"capacity": { "index": { "databaseBytes": 11534336, "tables": [ { "name": "memory_entries", "totalBytes": 409600, "liveRows": 64, "deadRows": 0 } ] } }
```

`ok` is `null` for a plane that is not configured (and for the cache until its
first command); `breaker` is `null` when `SUBSTRATE_BREAKER=0`. Hindsight and
LightRAG are probed once each, bounded to 1 s, only when configured; the index is
pinged with the same bound and asked for its size (`capacity.index`, `null` when
it does not answer in time); the cache is never pinged. `/healthz` therefore costs
at most one round trip per configured plane.

## Brief headers and the memoised `/healthz` (uplift-2 R1)

`POST /brief` composes its four source reads — index graph, ledger recent actions,
index open graphs, index memory — together, under one deadline
(`SUBSTRATE_BRIEF_BUDGET_MS`, 1200 ms; `0` = none). A read that misses the deadline
is a failed read: logged on stderr as `brief: <source> unavailable — deadline (…)`,
left out of the text, and the brief still answers. The ledger read carries the same
budget as its own HTTP timeout and is bounded to the last
`SUBSTRATE_BRIEF_RECENT_WINDOW_DAYS` (30) days, so an uncached brief never scans a
repo's whole history. The route answers with:

| Header | Value |
| --- | --- |
| `ETag` | `W/"<first 32 hex of sha256(body)>"` — weak, so a proxy that re-encodes the body still matches |
| `X-Substrate-Brief` | `complete` (every source answered) · `degraded` (some did not; thin live text) · `snapshot` (some did not; the last complete brief for these arguments, from the cache) |
| `X-Substrate-Brief-Failed` | the failed sources, comma-separated (`graph`, `recent actions`, `open graphs`, `memory`); absent when complete |
| `Cache-Control` | `no-cache` — revalidate with the ETag; it does not mean "do not store" |
| `X-Substrate-Brief-Age` | seconds since a last-good brief was composed; present only when it was served stale inside the `SUBSTRATE_CACHE_SWR_WINDOW_S` window (`SUBSTRATE_CACHE_SWR=enforce`, uplift-4 S4); `X-Substrate-Brief` stays `complete` |

A request whose `If-None-Match` lists the current tag (weak comparison, `*` honoured)
is answered **304 with no body** and the same headers. A degraded or snapshot brief is
still **200**: the fail-open contract is unchanged, only the headers say so. A
snapshot's text starts with the line `_(substrate brief snapshot from <ISO time>; live
sources degraded: <sources>)_`; snapshots are written only for complete briefs, kept
for `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` (3600 s; `0` disables both the write and the
read) and never written while any source is down. MCP `memory_brief` returns the same
text; since uplift-3 N7 its `structuredContent` carries the same facts (`etag`,
`state`, `surface`, `failed_sources`, `snapshot_at`) and an `if_none_match` argument
answers `not_modified: true` with no text by the same matcher — see
`docs/grok-bot.md` § The brief contract over MCP. Every answer at either door counts
once in `substrate.brief.result`.

`GET /healthz` is memoised for `SUBSTRATE_HEALTHZ_CACHE_MS` (5000 ms; `0` recomputes
on every call): the body gains `cachedAt` (ISO time it was computed) and `stale`
(`true` when this answer was served from the memo), and the status code is derived
from the memoised body by the unchanged `healthStatus` rule. Collectors polling health
therefore cost one round trip per configured plane per 5 s, not per call. `/metrics`
and `/slo` are not memoised.

Under `SUBSTRATE_HEALTHZ_CACHE_MS` above 0 the computation is also **single-flight** (uplift-5 U5-3): probes that arrive while one is running join it and get its body (`stale: false`, same `cachedAt`), so a burst makes one `substrate.health()` call rather than one per probe, and a computation that throws fails its joiners and is not joined by the next probe. `SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S` (default `0`, at most 300) reuses `capacity.index` for that many seconds. Both are described in `docs/data-planes.md` § Request-path flags.

### Verifying the request-path flags (uplift-5 U5-3)

All three read from `GET /metrics` (bearer required) and `GET /healthz`; none adds a metric name or a label key; the one new value is `op="graph.brief"` on `substrate.plane.duration`.

| Flag | Signal | What a change looks like |
| --- | --- | --- |
| `SUBSTRATE_BRIEF_GRAPH_READ=lite` | `substrate.plane.duration{plane="index",op="graph.brief"}` against `op="graph.get"` | A graph-scoped brief records one `graph.brief` sample (two statements in one round trip) where `full` recorded one `graph.get` sample (four serial statements). `graph.get` still moves for `graph_get`, claims and registrations. `substrate.brief.result` and `X-Substrate-Brief-Failed` are unchanged: a failed graph read is still the `graph` source. Watch `brief.p95` on `/slo`. |
| `SUBSTRATE_CACHE_BUMP_SCOPE=narrow` | `substrate.cache.operations{class="brief",result="miss"}` per accepted write | One accepted, retained write adds one flush of briefs (a miss per distinct brief asked for afterwards), not two, and heartbeats add none for `class="brief"`. The hit ratio is `/healthz.cache` (`hits` / `misses`). |
| `SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S>0` | `substrate.plane.duration{plane="index",op="capacity"}` count; `op="ping"` with `outcome="timeout"` | `capacity` samples drop to about one per memo window however often `/healthz` is polled; a poll burst inside `SUBSTRATE_HEALTHZ_CACHE_MS` makes one `ping` sample. Capacity can be up to the memo old. |

## Traces

Spans carry W3C trace context. `substrate-mcp` reads `traceparent` on the way in,
so a brief fetched by `claude-ultrathink`'s uplift hook, forwarded through
`grok-hermes-connector` and answered here is **one** trace rather than three
unrelated spans — which is the only way "where did the 900 ms go?" has an answer.

Head sampling is decided from the trace id, so every process in a trace agrees and
a trace is sampled whole or not at all. The histograms are recorded before the
sampling decision is consulted, so `SUBSTRATE_TRACE_SAMPLE_RATIO` never moves a
latency number.

Metrics and traces have **separate endpoints**, each resolved from its own
signal-specific variable and falling back to the generic one. A deployment sending
metrics to one collector and traces to another — the reason those variables exist —
would otherwise have had its spans posted to the metrics collector's `/v1/traces`.
Either signal being configured is enough to run the exporter; each is sent only where
it has somewhere to go.

The span buffer is bounded and drops the **oldest** when full, keeping the spans
that explain an outage in progress. Drops are exported as
`substrate.trace.spans_dropped` — as a *delta*, since `tracer.dropped` is itself
cumulative and adding it whole each interval would multiply it. Spans drained for an export that
then fails are lost — traces are best-effort by design; the metrics are the
durable signal.

## SLOs

| Objective | Target | Why |
| --- | --- | --- |
| `brief.p95` | p95 of `substrate.brief.duration` ≤ **800 ms** | The brief is on the critical path of every prompt and the uplift hook's budget is 1.5 s, so 800 ms leaves room for the hook. SPE-4793 words it `< 800 ms`; 800 is an inclusive bucket edge, so `≤` is the strongest form the histogram can decide — see below. |
| `emit.success` | stored / total ≥ **99.5 %** | Appends are fail-closed at the ledger, so a dropped event is a hole in the trail. |
| `lease.steal_rate` | stolen / claims ≤ **0.5 %** | Two agents believing they hold one node is the failure claims exist to prevent. |
| `quarantine.rate` | quarantines / claims ≤ **1 %** | A node the substrate withdraws is work no agent picks up. |

Read them at `GET /slo`, or in an evidence bundle. `GET /slo` answers **200
either way** — a breached objective is information, not a broken service, and a
monitor that read it as an outage would page on a slow hour.

### Per-plane availability, over a rolling hour (uplift-2 R2)

Beside the catalogue (`results`) and the burn ceilings (`burn`), `GET /slo` carries
a `planes` array with one objective per data plane:

| Objective | Statement |
| --- | --- |
| `plane.<name>.availability` | `ok / (ok + error + timeout + open)` of `substrate.plane.duration{plane=<name>}` ≥ **99 %** over the rolling hour |

The threshold is `SUBSTRATE_SLO_PLANE_AVAILABILITY` (default `0.99`); the minimum
sample count is the shared `SUBSTRATE_SLO_MIN_SAMPLES`. An open-breaker refusal
counts against the plane: the caller did not get an answer. Unlike the catalogue,
these are judged over a **rolling hour**, not the process lifetime: `PlaneWindow`
remembers the cumulative counts each `/slo` read sees (same discipline as the burn
ledger — readings in the same 10 s bucket coalesce (the bucket keeps its first reading as the baseline and its newest as the head), so the hour is 360 buckets whatever the scrape rate; a counter reset drops the history), and the
verdict is the share of calls between the oldest reading inside the hour and now.
One reading alone judges nothing. A plane the deployment does not configure
reports `unconfigured`, never `breached`, and plane breaches are **not** folded
into `breached`, which stays the catalogue's own list.

### Admission budgets (uplift-3 N3)

`GET /slo` also carries one `admission` objective, beside the catalogue for the
same reason the plane and burn objectives are:

| Objective | Statement |
| --- | --- |
| `admission.limited_rate` | `limited / (allowed + limited + shadow_limited)` of `substrate.admission.decisions` ≤ **1 %**; `insufficient-data` under 100 decisions |

A `bypass` — the cache plane not answering the bucket, which admits the caller —
and a `refused` — a class set `fail-closed` by `SUBSTRATE_BUDGET_<CLASS>_BREAKER`,
answered 503 while the cache plane is open, in `enforce` mode — are not decisions. In `shadow` the same fail-closed answer is recorded as a `bypass`, so the tuning series holds only the bucket's own decisions.
Both sit in neither the numerator nor the denominator, so a cache outage can
neither breach this objective nor dilute it into `ok`. The numerator is `limited`
alone. In the default `shadow` mode the rate is 0 whatever `shadow_limited`
counts, and that series is what the budgets are tuned from before
`SUBSTRATE_BUDGETS=enforce`. Fewer than 100 decided requests is `insufficient-data`,
so an outage that refuses most traffic can read as insufficient data, not a
breach; the `refused` series is what shows it. The identity label is the
bearer's surface, never one a body named, so the series are bounded by the
surface list plus `anonymous`. The bucket and the 429 a refused caller sees are
described in [`data-planes.md`](data-planes.md) and [`grok-bot.md`](grok-bot.md);
the per-class limits are the `SUBSTRATE_BUDGET_*` variables below.
### Docs search latency (uplift-3 N5)

`GET /slo` also carries a `docs` array with one row, in the catalogue's entry shape:

| Objective | Statement |
| --- | --- |
| `docs.search.p95` | p95 of `substrate.docs.duration` ≤ **2,000 ms** (`SUBSTRATE_SLO_DOCS_SEARCH_P95_MS`), `insufficient-data` below `SUBSTRATE_SLO_MIN_SAMPLES` (20) searches |

The histogram is end to end — what the caller of `docs_search` / `POST /docs/search`
waited for, cache hit or loaded — and carries its own bucket edges
(`25 … 1000, 2000, 4000, 8000` ms) so the 2,000 ms objective and the 4,000 ms
default budget are both exact edges. Judged as a process-lifetime count like the
catalogue, never folded into `breached`. See `docs/docs-search-ingest.md` for the
counters beside it.

### Brief latency per surface (uplift-3 N7)

`GET /slo` also carries a `surfaces` array: one `brief.p95` row per surface, in the
catalogue's entry shape plus `surface`, for every surface whose slice of
`substrate.brief.duration` holds at least `SUBSTRATE_SLO_MIN_SAMPLES` (20)
observations. Same target as the global row (`SUBSTRATE_SLO_BRIEF_P95_MS`, 800 ms),
same evaluator, same inclusive edge. A surface below the floor has no row — the array
is empty until a surface qualifies, and never longer than the surfaces that call — and
a breached row is never folded into `breached`, which stays the catalogue's own list.
The global `brief.p95` blends every caller, so a fast CLI can hide a slow bot; the
bot's own row is the verdict its operator wants, and `bun run smoke:grok` is the
contract check beside it.

### Estimated served tokens per surface (uplift-4 S1)

`GET /slo` also carries a `served` array: one `served.tokens_est` row per surface that has been served anything, in the shape of the `burn` rows plus `surface`, unit `tokens/h (estimated)`. It is the hourly rate of `substrate.served.tokens_est` against `SUBSTRATE_SERVED_TOKENS_PER_HOUR`; unset is `unconfigured` (reported, never judged), as for `burn.tokens`. It is judged like the burn rows: every `/slo` read is a sample, a rate needs two reads at least five minutes apart, and the samples live in the burn ledger under their own `substrate.served.tokens_est|<surface>` keys, so the checkpoint restores them. The row is an estimate of what a surface's model had to read, not what it was billed: `burn.tokens` stays model-reported, and a breached `served` row is never folded into `breached`.

### Predictive SLO rows

`GET /slo` also carries a `forecast` key with one row per objective: `brief.p95`,
`emit.success`, `lease.steal_rate` and `quarantine.rate`. Each row projects the value its
history measures over a horizon and reports whether that projection crosses the
objective's target. Each row carries a `basis`: `service` for a service-wide history
(`emit.success`, `lease.steal_rate`, `quarantine.rate`), and `worst-surface` for
`brief.p95`, whose history is the largest surface value in each bucket, not a
service-wide figure.

The source is the durable metrics history that `/slo/history` reads. The forecast
therefore needs `SUBSTRATE_METRICS_HISTORY=on` and a ledger. With history off, every
row has status `history-off` and `predicted` `null`, and no value is shown.

The model is Holt's double exponential smoothing with alpha 0.5 and beta 0.3. The
horizon is 60 minutes. The window is 2h at a 300-second step. A row needs at least
12 finite points; with fewer it is `insufficient-data`.

| Status | Meaning |
| --- | --- |
| `predicted-breach` | the value at the horizon crosses the objective's target in its direction |
| `ok` | the value at the horizon does not cross the target |
| `insufficient-data` | fewer than 12 finite points in the window |
| `history-off` | history is off; `predicted` is `null` |

The forecast is report-only: it is never folded into `breached`.

`lease.steal_rate` and `quarantine.rate` have no history series, so they are always
`insufficient-data` with `samples` 0.

Missing buckets are not filled in, and Holt treats the values as evenly spaced, so a
gap in the history distorts the trend. Each `/slo` read makes up to two history reads,
which the existing 15-second history memo bounds.

### History across restarts (uplift-3 N2)

The catalogue is a process-lifetime aggregate and the plane and burn windows
are in-memory rings, so until uplift-3 every deploy zeroed `brief.p95` and
left the rolling hour empty for an hour. The server now keeps an **SLO
checkpoint**: one JSON file (`v: 1`) holding every cumulative counter and
histogram point with its attributes, the plane window buckets, the burn
ledger samples, the capacity ring below and the notifier's last emitted state
per objective. It is written every `SUBSTRATE_SLO_CHECKPOINT_S` (60 s; `0`
writes only at shutdown) as `<path>.part` renamed over `<path>`, and once more
on `SIGTERM` inside the same bound as the final OTLP flush.

At boot the file is restored and the process becomes the next **epoch**: the
restored points seed each instrument's *prior* layer, live observations start
from zero on top of it, and every snapshot — `/metrics`, `/slo`, the exporter
— is the merged series. Restoring the same file twice replaces the layer
rather than adding to it, so nothing is double-counted; the registry's start
time (and `/metrics.startedAt`) becomes the history's `since`, so a collector
sees cumulative points that mean what they say. A missing file is a fresh
start with nothing to say; a corrupt one, one over 4 MB, or one of another
version is **one boot line** (`degraded — slo checkpoint … starts fresh`) and
a fresh start, never a refusal to boot. A metric the running release no
longer records, or a histogram whose bucket edges moved, is left out and
named once. Restored points are admitted under the same cardinality caps as live
observations (the caps bound the restored and live series together), so a point
past the cap folds into `_overflow` and is counted in `overflowed`, and repeated
restarts cannot grow the series set. Every write — the timer, `SIGTERM` and a
manual one — goes through one single-flight door: a trigger that arrives while a
write is in flight joins it instead of starting a second `.part` rename. The
`SIGTERM` write alone waits for the write in flight and then runs one fresh
write, so observations made meanwhile are saved.

`GET /slo` carries the state as `history`:

```json
"history": { "epoch": 3, "since": "2026-10-13T09:12:04.118Z", "checkpointAt": "2026-10-14T07:30:00.212Z" }
```

`epoch` is 1 on a fresh start and the checkpoint's epoch + 1 after a restore;
`since` is the oldest sample the merged series reach back to; `checkpointAt`
is the newest write (this process's, else the restored file's; `null` with
neither). The post-deploy check is `/slo.history.epoch ≥ 2` with the
pre-restart `samples` still counted.

The path is `SUBSTRATE_SLO_CHECKPOINT`. Unset, it is
`/var/lib/substrate/slo-checkpoint.json` **only when that directory exists**
(the unit's `StateDirectory`); on a bare local run there is no checkpoint and
the boot says so. `off` disables it; a relative path disables it and is named
at boot, because a checkpoint must never land in the repo by typo.

`breached` also changed: it now lists the catalogue's breaches **and** the
plane and burn breaches (`plane.<name>.availability`, `burn.tokens`,
`burn.cost_usd`), in that order — the storm-breaker and the runbook read one
list, and a plane that was unavailable for an hour is as much a breach as a
slow brief. The per-array detail is unchanged beside it. The admission, docs
and capacity rows are still not folded in.

### Capacity runway (uplift-3 N2)

`GET /healthz` reports the index's size as a point read; `GET /slo` now
carries a `capacity` array with one row fitted over the history of those
reads:

| Objective | Statement |
| --- | --- |
| `capacity.index.runway_days` | `(SUBSTRATE_INDEX_VOLUME_BYTES − databaseBytes) / bytes per day ≥ 14 days` (`SUBSTRATE_SLO_RUNWAY_DAYS`), the rate a least-squares fit over the ring |

Every `/healthz` capacity read that answered in time is offered to a ring of at
most 1,500 samples (`{at, databaseBytes}`), carried in the checkpoint. The ring
keeps at most one sample per fixed 60 s bucket: the first read in a bucket
keeps it, and later reads in that bucket never move its time, so a 5 s poller
and a 60 s one fill it alike and 1,500 is the day's 1,440 minute samples plus
an hour of margin. The fit needs samples spanning at least
**24 h** — one vacuum or one bulk ingest must not read as a trend — and
reports `insufficient-data` with the span until then, and when
`SUBSTRATE_INDEX_VOLUME_BYTES` is unset (the row says which). An index that is
not growing has an unbounded runway (`ok`, `observed: null`, the rate in the
sentence); one at or past the volume has none (`breached`, `observed: 0`).
The row also carries `bytesPerDay`, `currentBytes` and `volumeBytes` so the
runbook's arithmetic is checkable. No `index.pool.wait_p95` row: `IndexStore`
measures statement time through the plane gate, not pool acquisition, and the
row is not invented from a number that is not measured.

`capacity.index.graphNodes` (uplift-4 S2) adds lease-table bloat visibility to the
same read, from `pg_stat_user_tables` and report-only (no objective):
`hotUpdateRatio` is `n_tup_hot_upd / n_tup_upd` and `deadRatio` is
`n_dead_tup / (n_live_tup + n_dead_tup)` for `graph_nodes`, each `null` while its
denominator is 0. Heartbeats rewrite the indexed `lease_expires_at`, so a low HOT
ratio is expected; the numbers say whether it has become a problem. The opt-in
tune is `SUBSTRATE_INDEX_TUNE=apply`.

### Index archive age (uplift-4 S2)

With `SUBSTRATE_INDEX_ARCHIVE_DIR` set, `GET /healthz` carries
`jobs.index = { lastArchiveAt, ageSeconds, snapshot, reason }`, the
`substrate.index.archive.age_seconds` gauge (an OTLP gauge with no attributes,
computed at each metrics snapshot from the newest archive's creation time, so it
grows without anyone polling `/healthz`; not checkpointed) tracks it, and `GET /slo` carries an
`indexArchive` array with one row:

| Objective | Statement |
| --- | --- |
| `index.archive.age` | the newest complete index archive is at most `SUBSTRATE_INDEX_ARCHIVE_MAX_AGE_H` hours old |

The row is `report-only` while that variable is unset; set, it is `ok`, `breached`
(older, or no archive in a readable directory) or `insufficient-data` (the
directory could not be read). It is never folded into `breached`. The read is the
directory's manifests, memoised for 60 s and bounded to the 1 s probe; with the
variable unset the key and the row are absent. The archive itself:
`docs/runbooks/index-archive.md`.

### Railway cost report (Phase 45)

`GET /slo` carries a `railwayCost` key on every 200 response. It is the Railway cost
report from `railway_cost` (D45-d): estimated usage over `SUBSTRATE_RAILWAY_PROJECT_IDS`,
priced with the operator's unit prices, against `SUBSTRATE_RAILWAY_BUDGET_USD`. The key is
report-only: it is never folded into `breached`, so a cost overrun does not page or trip the
storm-breaker. Its `status` is `ok`, `over-budget`, `unpriced`, `unavailable` or `unconfigured`
(no token). A Railway error gives `unavailable` in the key and `/slo` still answers 200. The
report is cached in process for 15 minutes. A failed read is not cached, so a scrape during an outage reaches the Railway API
again; concurrent scrapes share one read.

### Hindsight outbox gauges, inventory and drift (uplift-4 S5)

**Always on, no flag.** `substrate.hindsight.retain_outbox.size`, `.oldest_age_seconds` and
`.durable` are gauges set from the retain outbox's own in-process state (`stats()`), when
the process starts, when a forward is parked, when the outbox drains and when `/metrics`
is read. They make no Hindsight call. They are in the `metrics` array of `GET /metrics`
(a registry gauge); an outbox whose oldest entry keeps growing is a plane that is not
taking retains.

**Opt-in.** `SUBSTRATE_HINDSIGHT_INVENTORY=on` starts a read-only probe every
`SUBSTRATE_HINDSIGHT_INVENTORY_INTERVAL_S` (60, floor 30; also run once at start).
It lists the banks (`GET /v1/default/banks`, 50 per page, at most 200 banks) and, for the
banks named in `HINDSIGHT_BANKS` only (at most 16), reads `GET {bank}/stats` and
`GET {bank}/config`. The probe is single-flight, serves a result younger than 60 s
again, and carries one 10 s deadline inside every breaker-gated call, so a stall
counts as a plane failure; it makes no call while the Hindsight breaker is open and
stops asking after the first call that says the plane itself is unwell.
**Nothing is written to Hindsight**: every call is a `GET`.

What it exports:

- Per configured bank that the plane lists: `substrate.hindsight.bank.facts`,
  `.pending_operations`, `.failed_operations` and `.last_write_age_seconds`, label
  `bank`. Because the registry's gauge instrument carries no labels, these are served
  on `GET /metrics` under `gauges` (the same key the docs freshness gauges use), not in
  the `metrics` array. The `bank` label is always a name from `HINDSIGHT_BANKS`: a bank
  the plane reports under any other name is never a label.
- `GET /healthz` gains an additive `hindsight` block (nothing existing changes, and it
  is absent when the inventory is off; it reads the last probe from memory and never
  calls the plane): `checkedAt`, `ok`, `reason` (a fixed word such as `server`,
  `timeout`, `circuit-open`, `unconfigured`, never plane text), `upstreamBanks`,
  `truncated`, one row per configured bank, and `drift`.
- `drift` names, at most 20 per list with `more` counting the rest: `missing`
  (`HINDSIGHT_BANKS` entries the deployment does not list), `unconfigured` (`sub-*`
  banks it lists that are not configured; a bank outside the `HINDSIGHT_BANKS` list, the
  surfaces' own `sub-<surface>` banks included, shows up here until it is listed) and
  `notChunks` (configured banks whose retain extraction mode is known and is not
  `chunks`). A name from the plane is reduced to `[A-Za-z0-9._:-]` and 64 characters
  before it is reported.

When the plane holds more than 200 banks the listing is cut (`truncated`); a configured bank the listing did not reach is then read directly (`GET {bank}/stats`, within the same 16-bank cap): a 404 is `missing`, an answer is present, and any other outcome leaves its `present` as `null` (unknown, never in `missing`).

`GET /healthz` also carries an additive `recall` block while `SUBSTRATE_BRIEF_RECALL` is not `off`: `{mode, capacity, wanted, saturated}` (the pairs the prefetcher can keep fresh at the configured interval and TTL, the pairs wanted now, and whether a live pair was evicted for room within the hour).

The drift report is a report. Nothing creates, patches, consolidates or deletes a bank,
and the status code of `/healthz` does not move.

### Notifications (uplift-3 N2)

`SUBSTRATE_SLO_NOTIFY=1` schedules an evaluator every `SUBSTRATE_SLO_NOTIFY_S`
(60 s) that judges the catalogue, the planes, the burn ceilings, the capacity
runway and every breaker. A condition — an objective `breached`, or a breaker
`open` (half-open counts as still open) — held for
`SUBSTRATE_SLO_NOTIFY_SUSTAIN_S` (300 s) becomes **one** event on the ledger
through the service's own `emit`, as surface `substrate`:

```json
{ "kind": "warning", "summary": "slo breached: plane.index.availability (observed 0.912, target 0.990)", "session_id": "slo:notify",
  "payload": { "action": "slo.transition", "runtime": "slo", "objective": "plane.index.availability", "state": "breached", "observed": 0.912, "target": 0.99 } }
```

`state` is `breached` or `open`; the condition clearing for the same sustain
is one `note` with `state: "recovered"` and the same payload (the sustain
applies both ways, so an objective sitting on its threshold cannot pair a
breach and a recovery every minute). A breaker's `observed` is its failure
count and its `target` is `null`. The last state emitted per objective is in
the checkpoint, so a restart that restores it says nothing about a breach it
already announced and still announces the recovery; without a checkpoint a
restart re-announces after one sustain. `SUBSTRATE_SLO_WEBHOOK_URL`, when
set, is POSTed the same payload (plus `summary` and `at`) once per
transition, bounded to 5 s and never retried — the ledger has the event, and
a webhook that is down must not become a second incident. The URL is never
printed. Both rows (`slo.transition`, `slo.recovered`) are in
[`event-vocabulary.md`](event-vocabulary.md); the operator view is in
[`runbooks/substrate-red.md`](runbooks/substrate-red.md).

### Durable metrics history (uplift-4 S6)

The checkpoint above keeps the *current* windows across a restart; it cannot
answer "what was `brief.p95` on Tuesday". `SUBSTRATE_METRICS_HISTORY=on`
(default **off**) adds a TTL-bounded table, `metric_samples`, in the same
GreptimeDB the ledger uses, written through the ledger client and nothing else.

**Why this sink, and not OTLP or Prometheus remote-write.** GreptimeDB's OTLP
metrics endpoint takes binary protobuf only; this repo's exporter is JSON by
design (see *Why it is hand-rolled*), and a hand-rolled protobuf encoder would
give up that property for a table Greptime names after the metric and gives no
TTL header for. Prometheus remote-write needs snappy-compressed protobuf and
Bun has no built-in snappy. The `/v1/sql` path the ledger already uses needs
neither, and it lets the TTL sit in the `CREATE TABLE`.

**The table.** Created by the sampler's first write (never at boot, never by a read, never with the flag off),
idempotently:

```sql
CREATE TABLE IF NOT EXISTS "metric_samples" (
  "ts" TIMESTAMP TIME INDEX, "series" STRING, "labels" STRING, "kind" STRING,
  "value" DOUBLE, "count" BIGINT, PRIMARY KEY ("series")
) WITH ('append_mode' = 'true', 'ttl' = '14d')
```

`append_mode` so two series sampled in the same millisecond cannot replace each
other; `ttl` in the `CREATE`, so no new `ALTER` shape exists in the client and
`assertAppendOnly` is unchanged (`create` was already an allowed verb). The TTL is
`SUBSTRATE_METRICS_HISTORY_TTL`: whole days, `1d` to `90d`, default `14d`; anything
else falls back to `14d` and is named at boot. It is re-rendered from the parsed
number before it reaches a statement. **A table that already exists keeps the
retention it has** — changing it later is the operator's `ALTER TABLE … SET 'ttl'`;
the client never sends one for this table, and never `DROP`s it.

**What is sampled.** A fixed allow-list, every `SUBSTRATE_METRICS_HISTORY_INTERVAL_S`
(default 60, floor 15), from the same registry snapshot `/metrics` serves:

| Series | Kind | Label | Value |
| --- | --- | --- | --- |
| `brief.p50`, `brief.p95` | histogram | `surface` (the 42 surfaces, else `other`) | ms, of the interval's briefs |
| `emit.success` | ratio | — | stored / (stored + dropped) |
| `emit.p95` | histogram | — | ms |
| `plane.availability` | ratio | `plane` | ok / every outcome |
| `plane.p95` | histogram | `plane` | ms; refused (`open`) calls carry no duration and are left out |
| `cache.hit_ratio` | ratio | — | hit / (hit + miss) |
| `admission.decisions` | counter | `decision` | count in the interval |
| `docs.search` | counter | `outcome` | count in the interval |
| `docs.p95` | histogram | — | ms |
| `capacity.runway_days` | gauge | — | days, only when the runway is judged |

That is the **`core`** allow-list, the only one unless `SUBSTRATE_METRICS_HISTORY_SERIES=extended`
(uplift-5 S6, default `core`, an unknown value is `core` and named at boot). `extended` adds
`cache.operations`, `brief.profile_bytes_saved`, `brief.recall`, `recall.prefetch`, `memory.expired`
and the gauges (`hindsight.outbox_size`, `hindsight.outbox_oldest_age_s`, `index.archive_age_s`, and the
three `corpus.*` objectives of [`corpus-eval.md`](corpus-eval.md))
for the promotion evidence and the data-plane dashboards; the series, the row-growth estimate against
the 14-day TTL and why it is opt-in are in [`dashboards.md`](dashboards.md). With `core` the sampler,
the rows and the route are exactly those described here.

Counters and histograms are **deltas since the previous sample**, so a row says
what happened in its interval; `count` is the interval's sample count. A value
below the previous one is a reset (a restart) and counts as everything since the
reset — a delta is never negative. The first snapshot after start is a baseline
and writes only the gauge, so a checkpoint-seeded registry cannot draw a spike.
Quantiles come from the interval's bucket counts; one above the top bucket bound
reads as that bound. A series with no activity in an interval writes no row.
`labels` is canonical JSON of the one closed-set label the series carries.

**Rate and size (estimates).** A typical interval writes **20–30 rows** (a few
active surfaces at two rows each, up to five planes at two, the emit, cache, docs
and admission series, the runway), so about **29 000–43 000 rows a day at 60 s**.
The ceiling is the 200-row batch cap: **288 000 rows a day**, about **4 million
over 14 days**, reached only if every surface, plane and label is active at once.
These are estimates from the series count, not measurements, and no per-row size has
been measured: read the real figure from the ledger's `capacity` read (`/healthz`,
the ten largest tables by disk) after a day of running.

**Volume size (operator note).** The Greptime volume is recorded as **500 MB** in
one place (uplift-2 context) and as **5 GB** in the Notion build plan; the
Dragonfly instance is recorded with 5 GB. Nothing here resolves the conflict, and
no claim is made about what share of either the history takes: confirm the real
volume and the measured table size before enabling it, and before raising the TTL.

**Failure behaviour.** Nothing on a request path waits for it. One multi-row
`INSERT` per interval (at most 200 rows), through the ledger's plane gate with the
deadline (3 s) inside the gated call, so a timeout counts as a breaker failure
and an open breaker costs no network. On any failure the batch is **dropped, not
retried**, and counted as `substrate.metrics.history.dropped{reason}` in rows, with
`reason` one of `breaker_open`, `unavailable`, `rejected`, `ddl`, `schema`, `invalid`,
`capped`, `internal`. `schema` is a `metric_samples` table that already exists
without `append_mode` (checked on the live table before the first write, as the
ledger tables are): rows of different labels would replace one another, so nothing
is written, one boot-log line names the table, and an operator must drop and
recreate it — the client never does. A write still in flight when the next tick fires skips that
tick (the deltas accumulate into the next sample, so only a *failed* batch loses
data). The timer is unref'd; shutdown waits for the write in flight and then
takes one fresh sample, within the same two-second bound as the other final
flushes.

**Reading it back.** `GET /slo/history?series=<name>&window=<n><m|h|d>&step=<s>`,
served beside `/slo` (not audited, metered as a read). `series` must be one of the
names above for the mode in force (a 400 lists them; `extended` adds the series in [`dashboards.md`](dashboards.md)); `window` defaults to `1h` and is capped at the
configured TTL (`retentionDays` in the answer says what that is — an existing table
keeps the retention it was created with, see the variable's row below); `step` is
whole seconds or `<n>s|m|h`, clamped to 15 s – 1 day. **The step actually used is
`stepS` in the answer**, and it is raised until `(buckets + 1) × label values` fits
**2000 points**: a bucket can hold one row per label value (28 for `brief.*`, 5 for
`plane.*`), so a day of `brief.p95` runs at about 20-minute buckets and 14 days at
about 5 hours, and the oldest bucket of the window is always present. The answer is
`date_bin` buckets folded per series (`sum` for counters, `max` for p95, `avg` for
p50 and gauges, sample-weighted average for ratios), oldest first, with only the
series' closed label.

With the history off, or no ledger configured, it is `404 {"enabled": false}`; a
store that cannot answer is `503` with a fixed message, never the store's error text.
**A read never creates the table**: only the sampler's first write does, so before
that (or if the history was never on) the answer is an empty list. The route needs a
bearer exactly like `/slo` (unless `SUBSTRATE_ALLOW_ANONYMOUS=1`), and every miss scans
the whole window through the ledger's breaker, so each validated request key is
memoised for 15 s (200 answers only, at most 64 kept) and the read has its own 2.5 s
deadline — a timeout counts as a ledger failure like any other. A request for a key
already being read joins that read, and running reads are held apart from kept
answers, so they are never evicted while they run. At most **16 reads** run at once:
past that a new key starts no read and is answered with its last kept answer if there
is one, else `503 {"enabled": true, "busy": true}` with `Retry-After: 5`. A refused
request is never a key.

**Rollback.** `SUBSTRATE_METRICS_HISTORY=off` (or unset) and restart: no timer,
no write, `/slo/history` answers 404. The table stays and its rows expire on the
TTL; dropping it is an operator action (`DROP TABLE "metric_samples"` run by hand —
the client refuses `DROP`). Turning the flag off after it was on leaves one line in
the next boot's log: the checkpoint still carries the drop counter, which the
running release no longer registers.

### Two things the evaluator does on purpose

**The p95 objective is checked as a count, not an interpolation.** 800 is one of the
histogram's own bucket bounds, so the *exact* share of briefs on each side of it is
known. Those counts decide the verdict. The interpolated p95 is reported alongside
for reading, and does not decide anything. A threshold that is not a bucket bound
reports `unmeasurable` rather than being quietly interpolated — a bucketed
histogram genuinely cannot answer it.

**The threshold is an inclusive bucket edge, and the objective is stated to match.**
SPE-4793 words it `p95 < 800 ms`. A bucket bound is an *inclusive* upper edge in OTLP —
the 800 ms bucket holds `(400, 800]` — so no bucketed histogram can separate 800.000 ms
from 799.999 ms. The at-or-below count is therefore the verdict, and the catalogue
states the objective as `≤ 800 ms` rather than printing `<` and answering something
else:

- at least 95 % **at or below** 800 ms → `ok`;
- fewer than 95 % at or below it → `breached`;
- 800 ms is not one of the histogram's bounds → `unmeasurable`, because a bucketed
  histogram genuinely cannot answer that one. `breaches()` leaves it out, so an
  evidence bundle is not failed on a maybe.

The honesty is kept in the sentence, not in the verdict. When the boundary bucket is
what carries a run over the line — at or below 800 ms, but not provably below it — the
detail says so, names the 400–800 ms bucket, and states that briefs at exactly 800 ms
were counted as meeting the objective. An operator who needs those ruled out narrows
the check with a bucket bound just under the threshold.

Judging on the **below** count instead is much worse than it looks, which is why it was
reverted. It does not make the strict question answerable; it moves the only provable
pass down to the next bound, so `p95 < 800 ms` is enforced as `p95 ≤ 400 ms` and every
healthy run whose p95 lands anywhere in `(400, 800]` — the band the objective exists to
allow — reports `unmeasurable`. A run of 96 briefs at 600 ms and 4 at 3 s meets the
objective comfortably and could not report `ok`. Silently doubling an objective's
strictness is a larger misstatement than counting the single value 800.000 ms as met,
and an SLO no healthy service can pass is not a conservative SLO, it is a broken one.

Bucketing with `<` so the bound became exclusive was the other alternative, and is also
worse: it makes the strict check exact locally, but misreports bucket membership to
every standard collector — an exported histogram has to mean what OTLP says it means.

**An objective with too few samples is never `ok`.** It reports
`insufficient-data` with the count it has. A green SLO computed from three
observations is a claim the data does not support, and an evidence bundle must not
carry one.

The lease-steal and quarantine ceilings are **provisional**. No lease expiry exists
yet — Phase 2 adds it — so there is no baseline to derive them from; they are
chosen to be alarming rather than measured, and `SUBSTRATE_SLO_LEASE_STEAL` /
`SUBSTRATE_SLO_QUARANTINE` move them once there is one.

### What counts as a steal, and as a quarantine

- **Lease steal** — a claim granted to a surface while another surface's claim was
  live. Today this is impossible by construction: `claimNode` grants only when
  `claimed_by` is null or already this surface. The counter exists so the rate is
  observable the moment Phase 2 adds lease expiry, and so the objective is written
  down before there is pressure to weaken it.

  The rate is observable because the *index's action* reaches the observer, not only the
  substrate's verdict. A takeover of another surface's expired lease is
  `decision: "granted"` with `action: "stolen"`, and `stolen` is the only outcome that
  increments `substrate.lease.steals` — so reading the verdict alone mapped every takeover
  to `granted` and the numerator could not leave zero however many leases were taken. An
  objective whose numerator cannot move is not one. Where the two disagree the verdict
  wins: a steal whose event never reached the ledger is `revoked`, and it did not happen.
- **Quarantine** — a node the substrate withdrew from dispatch rather than handing
  out. One reason is emitted today, `unrecorded-claim` (below). Phase 2 adds
  dispatch-failure quarantine.

The counters are cumulative totals — process-lifetime, and since uplift-3 N2
across restarts too when the SLO checkpoint is on (`history.since` says how far
back) — so an outage stays visible in `/slo` after it ends. A rolling window is
the collector's job; an SLO that healed itself the moment the outage stopped
would hide the outage from anyone who looked afterwards.

## Fail open, fail closed

Both halves hit the same unreachable ledger, and they must not behave the same.

**`emit` fails open.** The caller gets its normalised event back with
`stored: false` and a 503 on the REST route. A dropped event costs a line in the
trail, and refusing the turn over it would mean a substrate outage blocking every
prompt on the host.

**`claimNode` fails closed.** A claim whose event did not reach the ledger is
**withdrawn**, counted as `substrate.lease.claims{outcome="revoked"}` and as
`substrate.quarantine.total{reason="unrecorded-claim"}`. A claim is not an event,
it is a lock: its whole purpose is that the second agent to ask learns the node is
taken, and the only way they learn it is the brief, whose recent actions come from
the ledger. A claim the ledger never took is a lock the substrate cannot tell
anyone about — handing it out would be worse than refusing it, because the second
agent would see an idle node and start the same work.

**The withdrawal is recorded on the audit chain**, as its own `denied` record for
`graph_claim` with `transport: "internal"`. The gate in front of the dispatcher has
already recorded the call as `allowed` — which is true of the call: it was permitted to
run. What happens next is that the claim's event does not reach the ledger and the hold is
withdrawn, and nothing wrote that: the trail and the per-graph evidence bundle showed the
claim allowed and said nothing about the withdrawal, which is the opposite of the decision
the substrate made, in the document an incident is reconstructed from, during the one
outage this behaviour exists for. Appended rather than amended, because the chain is
append-only and **both** records are true; fail-open, because the withdrawal has already
happened and refusing to write it cannot undo it. `chaos.test.ts` asserts every allowed
claim has its withdrawal beside it, and that a claim granted on a healthy ledger has none.

`SUBSTRATE_CLAIM_REQUIRE_LEDGER` forces either way. The default is off when no
ledger is configured at all, so a local run does not have every claim withdrawn.
When the withdrawal itself fails — the index is down too — the refusal says the
node needs a manual release rather than leaving the caller to be refused forever.

### The chaos smoke: a plane down for 60 s

The deterministic proof is `packages/audit/src/chaos.test.ts`, which runs in CI
with no network and gates the build. It drives a 60 s outage on a fake clock and
asserts: every emit returns and none throws, every claim is withdrawn and
quarantined, the audit chain records both halves and verifies, the SLOs report the
breach, and claims are granted again on recovery.

`bun run smoke:chaos` runs the same shape against a **live** deployment, which is
the part a unit test cannot reach — that the service really does keep answering
while its store is gone. Blackhole the ledger for the window:

```sh
# terminal 1 — drop, not reject: a dropped packet makes the client wait for its own
# timeout, which is the failure mode a real Railway outage produces. A REJECT returns
# immediately and proves much less.
sudo iptables -I OUTPUT -d <ledger-ip> -j DROP && sleep 60 \
  && sudo iptables -D OUTPUT -d <ledger-ip> -j DROP

# terminal 2 — with SUBSTRATE_TOKEN already exported in this shell
SUBSTRATE_URL=http://127.0.0.1:7410 bun run smoke:chaos
```

`--plane index|hindsight|lightrag|cache` (uplift-2 R2) blackholes a different
plane instead (for the loopback cache, stop `redis-server` rather than drop
packets). During the window every tick reads `/healthz`, asks for a brief as
`grok-bot`, and — for Hindsight and LightRAG — makes the read that plane serves
(`/memory/recall`, `/docs/search`). The run asserts that `/healthz` reported the
plane `ok: false` or its breaker `open` at least once (it **fails** otherwise:
the outage has to have been observed), that every brief answered 200 within
1500 ms, that the plane's own read answered `degraded: true`, that the breaker
opened, and that `/slo` lists `plane.<name>.availability`. Nothing is appended
in this mode.

**It cannot pass without exercising the outage.** Two checks require it: at least
one emit actually refused, and at least one claim actually withdrawn. Run it against
a healthy deployment and it exits non-zero naming which half did not happen — a
smoke that goes green having proven nothing is worse than no smoke.

The claim half needs a node to claim, so the script registers its graph before the
window. Without that, `graph_claim` fails with "unknown node" *before* the
fail-closed logic and every claim comes back not-granted for the wrong reason. The
check reads the claim's own `decision` rather than the absence of a grant: "not
granted" is also what an unknown node, a missing index and a transport error look
like, whereas `revoked` can only come from the withdrawal path running.

`CHAOS_REHEARSAL=1` downgrades those checks to notes, for testing the script itself
against a healthy deployment; the report says so, so a rehearsal cannot be mistaken
for a proof. **Every check that only holds during the outage is one of them**, "no claim
was granted" included: a healthy deployment grants claims, and that is the behaviour, so
a rehearsal that failed on it was failing on the deployment being healthy — which is the
one thing a rehearsal assumes. `CHAOS_WINDOW_MS` and `CHAOS_TICK_MS` shorten the window.
This rehearsal mode is not the scratch rehearsal harness — that twin lives in [`rehearsal.md`](rehearsal.md).

It appends `note` events under a `ut-chaos-…` graph. The ledger is append-only so
they stay; they carry no repo, so no brief shows them.

### The Grok connector smoke (uplift-3 N7)

`bun run smoke:grok` is the chaos smoke's read-only sibling for the `grok-bot`
contract: as the grok-bot bearer it checks that MCP `memory_brief` answers within
1,500 ms with an explicit `state` and `surface`, that `if_none_match` answers
`not_modified` within 500 ms, that `POST /brief` then the conditional `POST /brief`
answers `304` with an empty body, and that `/healthz` shows every configured plane up.
Exit `0` / `1` (`degraded`: a degraded brief or an open breaker) / `2` (`failed`,
unreachable, 401 — the hint names the variables, never a value); `--json` for one
report. It writes nothing. [`docs/grok-bot.md`](grok-bot.md) § Connector smoke has the
checks and the bearer order.

## Routes

| | |
| --- | --- |
| `GET /metrics` | the snapshot this process holds, in the shape `otlp.ts` encodes; the per-bank Hindsight gauges (uplift-4 S5) and the docs freshness gauges (uplift-4 S7) ride beside it under `gauges` |
| `GET /slo` | the verdicts computed from it, the breached ids, `burn`, the per-plane `planes`, the `admission` refusal rate, the `docs` row and the per-surface `surfaces` rows |
| `GET /slo` | the verdicts computed from it, the breached ids (catalogue, plane and burn), `burn`, the per-plane `planes`, the `admission` refusal rate, the `docs` row, the `capacity` runway row and `history` |
| `POST /evidence` | `{ "graph_id": "ut-…", "format": "json" \| "html" }` |
| `GET /healthz` | now also `auditDurable`, `auditRecords`, `planes`, `capacity`, `cachedAt` and `stale`; with `SUBSTRATE_HINDSIGHT_INVENTORY=on` an additive `hindsight` block (uplift-4 S5), absent otherwise |
| `GET /slo/history` | `?series=&window=&step=`: durable, aggregated metric history from `metric_samples` (uplift-4 S6); `404 {"enabled":false}` unless `SUBSTRATE_METRICS_HISTORY=on` and a ledger is configured |

`/metrics` and `/slo` are served whether or not a collector is configured, so an
operator can read the same numbers the SLOs are computed from without standing one
up. They are **not** audited: a trail dominated by a Prometheus scrape is one
nobody reads.

A non-durable audit chain is reported in `/healthz` and is **not** a 503. The
substrate is serving; refusing traffic over it would be worse.

## Configuration

Standard `OTEL_*` names, because the host already runs other OTLP producers and an
operator who sets `OTEL_EXPORTER_OTLP_ENDPOINT` once should not have to learn a
substrate-specific spelling.

| Variable | Default | |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | Base URL. **Export is off when unset**; collection is not. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | — | Metrics only. Wins over the generic one. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | — | Traces only. Wins over the generic one. |
| `OTEL_EXPORTER_OTLP_HEADERS` | — | `k=v,k=v`. Where a collector token goes — it is a credential, so it belongs in `/etc/substrate/substrate.env`. |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | `5000` | ms |
| `OTEL_SERVICE_NAME` | `substrate-mcp` | |
| `OTEL_RESOURCE_ATTRIBUTES` | — | `k=v,k=v` |
| `SUBSTRATE_OTLP_INTERVAL_MS` | `30000` | Floor 1000. |
| `SUBSTRATE_TRACE_SAMPLE_RATIO` | `1` | Traces only; never moves a metric. |
| `SUBSTRATE_TRACE_BUFFER` | `2048` | Spans held for the next export. |
| `SUBSTRATE_INSTANCE_ID` | hostname | `service.instance.id` |
| `SUBSTRATE_ENV` | — | `deployment.environment` |
| `SUBSTRATE_SLO_BRIEF_P95_MS` | `800` | Must be a bucket bound, or the objective reports `unmeasurable`. |
| `SUBSTRATE_SLO_EMIT_SUCCESS` | `0.995` | |
| `SUBSTRATE_SLO_LEASE_STEAL` | `0.005` | Provisional. |
| `SUBSTRATE_SLO_QUARANTINE` | `0.01` | Provisional. |
| `SUBSTRATE_SLO_MIN_SAMPLES` | `20` | Below this an objective is `insufficient-data`. |
| `SUBSTRATE_SLO_PLANE_AVAILABILITY` | `0.99` | Floor for every `plane.<name>.availability` over the rolling hour. |
| `SUBSTRATE_SLO_RUNWAY_DAYS` | `14` | Floor for `capacity.index.runway_days`. |
| `SUBSTRATE_INDEX_VOLUME_BYTES` | — | The index volume's size; unset leaves the runway `insufficient-data` with the reason. |
| `SUBSTRATE_INDEX_ARCHIVE_DIR` | — | Where `substrate index archive` writes (uplift-4 S2). Set on the server too, and `/healthz.jobs.index` and the `index.archive.age` row appear; unset leaves both absent. |
| `SUBSTRATE_INDEX_ARCHIVE_MAX_AGE_H` | — | Hours the newest complete index archive may be old; unset keeps `index.archive.age` report-only (26 once the timer is installed). |
| `SUBSTRATE_INDEX_ARCHIVE_MAX_SECONDS`, `SUBSTRATE_INDEX_ARCHIVE_MAX_BYTES` | `900`, 1 GiB | Bounds on one export; past either the transaction rolls back and nothing is left behind. |
| `SUBSTRATE_INDEX_TUNE` | off | `apply` runs the idempotent `graph_nodes` storage tune at boot (`docs/runbooks/index-archive.md`). |
| `SUBSTRATE_SLO_CHECKPOINT` | `/var/lib/substrate/slo-checkpoint.json` when that directory exists, else off | Absolute path of the SLO checkpoint; `off` disables; a relative path disables and is named at boot. |
| `SUBSTRATE_SLO_CHECKPOINT_S` | `60` | Seconds between checkpoint writes; `0` writes only at shutdown. |
| `SUBSTRATE_SLO_NOTIFY` | off | `1` schedules the transition notifier. |
| `SUBSTRATE_SLO_NOTIFY_S` | `60` | Seconds between evaluations (floor 5). |
| `SUBSTRATE_SLO_NOTIFY_SUSTAIN_S` | `300` | Seconds a breach, an open breaker or a recovery must hold before it is announced; `0` announces at once. |
| `SUBSTRATE_SLO_WEBHOOK_URL` | — | `http(s)` URL POSTed each transition's payload, 5 s, one attempt. Never printed. |
| `SUBSTRATE_BREAKER` | on | `0` \| `false` \| `no` disables every plane breaker (kill switch); calls still measured. |
| `SUBSTRATE_BREAKER_FAILURES` | `5` | Consecutive failures that open a breaker; integer 1–100, else the default. |
| `SUBSTRATE_BREAKER_OPEN_MS` | `30000` | How long an open breaker refuses before one probe; integer 1000–600000, else the default. |
| `SUBSTRATE_CLAIM_REQUIRE_LEDGER` | derived | Withdraw a claim whose event did not land. |
| `SUBSTRATE_BRIEF_BUDGET_MS` | `1200` | Shared deadline for the brief's four source reads; `0` = none. |
| `SUBSTRATE_BRIEF_RECENT_WINDOW_DAYS` | `30` | How far back the brief's recent-actions ledger read looks. |
| `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` | `3600` | How long the last complete brief is kept for the degraded path; `0` = no snapshots. |
| `SUBSTRATE_CACHE_COMMAND_TIMEOUT_MS` | `250` | One cache command; sized for the loopback redis. |
| `SUBSTRATE_CACHE_CONNECT_TIMEOUT_MS` | `250` | One cache connect. |
| `SUBSTRATE_HEALTHZ_CACHE_MS` | `5000` | How long a computed `/healthz` body is served to pollers; `0` = recompute per call. |
| `SUBSTRATE_BRIEF_GRAPH_READ` | `full` | `full` \| `lite` (uplift-5 U5-3): `lite` reads a graph-scoped brief's graph as two concurrent statements (index row, nodes) instead of four serial ones; the text is identical. An unknown value is `full`, named at boot. |
| `SUBSTRATE_CACHE_BUMP_SCOPE` | `legacy` | `legacy` \| `narrow` (uplift-5 U5-3): `narrow` moves the post-retain and outbox-replay bump to a recall-only generation and stops a heartbeat flushing briefs. An unknown value is `legacy`, named at boot. |
| `SUBSTRATE_HEALTHZ_INDEX_CAPACITY_MEMO_S` | `0` | Seconds `/healthz` reuses the index size report; `0` measures on every computed body, capped at 300 (named at boot). |
| `SUBSTRATE_CACHE_SWR` | `shadow` | `off` \| `shadow` \| `enforce` (uplift-4 S4): whether a brief miss after a generation bump may be answered with a last-good younger than the window while one background refresh runs. `shadow` only counts `would_serve_stale`; junk is `shadow`. |
| `SUBSTRATE_CACHE_SWR_WINDOW_S` | `30` | How old a last-good brief may be and still be served stale, seconds; max 300. |
| `SUBSTRATE_BUDGETS` | `shadow` | `off` \| `shadow` \| `enforce`: whether the admission buckets are skipped, decided and counted only, or answered with 429. |
| `SUBSTRATE_BUDGET_READ_RPS` / `_BURST` | `20` / `40` | Per surface and second, with one second of headroom; reads are the GET routes, `/brief`, `/memory/recall`, `/docs/search`, `/events/query`, `/verify`, `/evidence`, `/drift`, `/slo/history`, `/skills` and the read tools. |
| `SUBSTRATE_BUDGET_WRITE_RPS` / `_BURST` | `10` / `20` | `/events`, `/memory`, `/docs/ingest`, `/docs/merge-trigger`, `/skills/propose`, `/skills/approve`, `/handoff` and the write tools. |
| `SUBSTRATE_BUDGET_COORDINATION_RPS` / `_BURST` | `30` / `60` | `graph_claim`, `graph_heartbeat`, `graph_release`, `graph_complete`, `coord_reap_leases`: its own bucket, so reads never starve a heartbeat. |
| `SUBSTRATE_BUDGET_ANONYMOUS_RPS` / `_BURST` | `2` / `4` | Every class of the bucket all accepted untokened bridge callers share. |
| `SUBSTRATE_BUDGET_<SURFACE>_<CLASS>_RPS` / `_BURST` | — | Per-surface override (`GROK_BOT`, `SWARM_A01_ORCH`, …, the `SUBSTRATE_TOKEN_*` spelling); a half left unset is the class value. |
| `SUBSTRATE_BUDGET_<CLASS>_BREAKER` | `fail-open` | What an open cache breaker does to that class: `fail-open` admits the request (a `bypass`); `fail-closed` answers `503` in `enforce`, and in `shadow` admits the request and counts a `bypass`. Blank is `fail-open`; any other value refuses to boot (`SUBSTRATE_BUDGETS` keeps its older fallback to `shadow`). |
| `SUBSTRATE_METRICS_HISTORY` | off | `on` samples the registry into `metric_samples` and serves `/slo/history`; anything else is off. It also needs the ledger: with no ledger configured it stays off, the route answers `404 {"enabled":false}` and boot says why. |
| `SUBSTRATE_METRICS_HISTORY_INTERVAL_S` | `60` | Seconds between samples; floor 15, ceiling 3600. |
| `SUBSTRATE_METRICS_HISTORY_TTL` | `14d` | Whole days `1d`–`90d`, applied when the table is **created**; anything else falls back to `14d`. An existing table keeps the retention it was created with, so a raised value needs an operator `ALTER TABLE "metric_samples" SET 'ttl'='<n>d'` on it; until then `/slo/history` accepts windows up to the configured value (`retentionDays`) but the table holds no more than its own TTL. |
| `SUBSTRATE_METRICS_HISTORY_SERIES` | `core` | `core` \| `extended` (any case; uplift-5 S6). `core` is the 11 series above plus `planning.transition` (phase 54); `extended` also samples and serves the evidence series in [`dashboards.md`](dashboards.md), at an estimated 10 to 17 more rows per 60 s interval in normal use. Opt-in because the volume size is unresolved. Anything else is `core`, named at boot. |
| `SUBSTRATE_BRIEF_RECALL` | `off` | `off` \| `shadow` \| `enforce` (uplift-4 S5, Build Plan BP-5.0): `off` adds no Hindsight traffic and leaves every brief, ETag and cache key as it was; `shadow` runs the prefetcher and counts `would_include` while serving today's text; `enforce` appends the `Recalled context` section. An unknown value is `off`, named at boot. |
| `SUBSTRATE_BRIEF_RECALL_INTERVAL_S` | `120` | Seconds between prefetch ticks (floor 30, ceiling 3600); each tick refreshes `ceil(wanted / ticks per half TTL)` due pairs, at most 8 and at most what fits in 80% of the interval at `SUBSTRATE_BRIEF_RECALL_BUDGET_MS` (docs/data-planes.md § Recall in the brief). |
| `SUBSTRATE_BRIEF_RECALL_TTL_S` | `900` | How long a recall snapshot lives in the `recall-snapshot` cache class (60–86400). The entry lives twice this: fresh up to it, `stale` (omitted from the brief, counted) up to twice it. A pair is refreshed once its snapshot is older than half of it. |
| `SUBSTRATE_BRIEF_RECALL_BUDGET_MS` | `1500` | The deadline of one recall, inside the breaker-gated call (100–10000); a timeout is a plane failure. |
| `SUBSTRATE_HINDSIGHT_INVENTORY` | off | `on` runs the read-only bank inventory (uplift-4 S5): per-bank gauges, the drift report and `/healthz.hindsight`. Anything else is off. The retain outbox gauges do not depend on it. |
| `SUBSTRATE_HINDSIGHT_INVENTORY_INTERVAL_S` | `60` | Seconds between inventory probes (floor 30, ceiling 3600). |

An endpoint pasted as `https://collector/v1/metrics` is accepted: the trailing
`/v1/metrics` is stripped, because appending it again would 404 on every export —
and silently, since export fails open.

`SUBSTRATE_AUDIT_PATH` is documented in [`mcp-audit.md`](mcp-audit.md).

## The unified resource fabric (phase 51)

`fabric_status`, `fabric_optimize` and `fabric_compliance` cover eight resources. Each has a panel on the **Substrate data planes** dashboard (`infra/vps/dashboards/substrate-data-planes.json`), in the row "Fabric resources (phase 51)". The panels are generated by `scripts/dashboards.ts` from `FABRIC_SERIES`, and each reads a series the server records. The fabric itself never writes. When write probes are enabled, its Greptime row reads the last write probe `/healthz` recorded and reads `unavailable` until one exists. With `SUBSTRATE_LEDGER_WRITE_PROBE_S=0`, it uses the metadata-only verdict instead; `ok` does not mean a write was tested.

| Resource | Panel title | Series | Source metric |
| --- | --- | --- | --- |
| `dragonfly` | Fabric: dragonfly | `cache.hit_ratio` | `substrate.cache.operations` |
| `timescaledb-index` | Fabric: timescaledb-index | `capacity.runway_days` | `capacity.index.runway_days` (sampled into the history) |
| `greptime` | Fabric: greptime | `plane.availability` | `substrate.plane.duration`, `plane=greptime` |
| `lightrag` | Fabric: lightrag | `plane.p95` | `substrate.plane.duration`, `plane=lightrag` |
| `hindsight` | Fabric: hindsight | `hindsight.outbox_size` | `substrate.hindsight.retain_outbox.size` (extended series) |
| `tei` | Fabric: tei | `plane.p95` | `substrate.plane.duration`, `plane=tei` (an auxiliary plane: a gate and a metric label, no `/healthz` row or SLO; phase 64) |
| `tailscale-proxy` | Fabric: tailscale-proxy | `endpoint.proxy_planes` | `substrate.endpoint.proxy_planes`, a count of the data planes whose endpoint class is `proxy`, set at boot |
| `corpus` | Fabric: corpus | `corpus.freshness_seconds` | `substrate.corpus.freshness_seconds`, the age of the newest corpus manifest change (extended series) |

The `greptime`, `lightrag` and `tei` panels are per-plane series: each draws one line per plane, and the named line is that resource. The `hindsight` panel shows one total outbox count, not a line per plane. The `tailscale-proxy` panel is one count, not a line per plane, and reads the same endpoint classes as its status row. The `hindsight`, `tailscale-proxy` and `corpus` panels need `SUBSTRATE_METRICS_HISTORY_SERIES=extended`. Regenerate the dashboards with `bun run dashboards:build`.

The `corpus` row (v1.7 phase 70) is the docs plane's three objectives and reads no probe of its own. It is `unconfigured` while `SUBSTRATE_CORPUS` is off. Otherwise its `detail` carries the three readings next to the thresholds they are judged by (`SUBSTRATE_DOCS_SLO_FRESHNESS_S`, `SUBSTRATE_DOCS_SLO_RECALL5`, `SUBSTRATE_DOCS_SLO_INGEST_DOCS_PER_S`), and the row is `degraded` when a reading breaches its threshold (its `source` names which: `corpus.slo: breached freshness,recall5,ingest`) or could not be read within the fabric's per-source deadline (`corpus.slo: timeout` or `corpus.slo: failed`). A reading nobody has taken is `null` and is never a breach: the golden recall is `null` until the docs canary has reported it, the ingest rate is `null` until a request sent documents (a request that found everything unchanged is idle, not slow), and a corpus that has not ingested anything has no freshness. The readings, the series and how to act on a breach are in [`corpus-eval.md`](corpus-eval.md) and [`runbooks/docs-rag-operations.md`](runbooks/docs-rag-operations.md).
