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
| `substrate.admission.decisions` | counter | `surface` (a known surface or `anonymous`), `class` = `read` \| `write` \| `coordination`, `decision` = `allowed` \| `limited` \| `shadow_limited` \| `bypass` |
| `substrate.docs.search` | counter | `surface`, `outcome` = `hit` \| `empty` \| `degraded`, `cached` = `true` \| `false` |
| `substrate.docs.citations` | counter | `provenance` = `recorded` \| `unrecorded` \| `unpinned` |
| `substrate.docs.duration` | histogram, ms (own edges, incl. 2000 and 4000) | `surface`, `cached` |
| `substrate.memory.expired` | counter | `surface`, `kind` (memory kind), `mode` = `served` \| `hidden` — entries past their `ttl` met by an index read (uplift-3 N4; `docs/memory-governance.md` § Lifetime) |
| `substrate.brief.result` | counter | `surface` (a known surface or `unknown`), `state` = `complete` \| `degraded` \| `snapshot`, `result` = `fresh` \| `not_modified` — one per brief answered at either door; `not_modified` is a REST 304 or an MCP `not_modified: true` (uplift-3 N7) |

`status` is a class (`2xx`, `5xx`), not a code, and `route` is one of the known
paths or `other` — an unauthenticated caller walking random URLs must not be able
to mint a metric series per URL it tries. `plane` is one of the five data planes
(`greptime`, `index`, `cache`, `hindsight`, `ragflow`) and `op` is a fixed label per
client — a SQL verb for the ledger, a route-table entry for the HTTP planes
(`recall`, `retain`, `retrieve`, `datasets`, …), a command name for the cache —
never a statement or a URL.

Everything is **cumulative and monotonic**. The exporter pushes the same running
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
> `{"password": 123456}`. A number is not inherently safe; a named count is. The full
> exemption is documented in the counter-exemption section of [`redaction.md`](redaction.md).

## Plane circuit breakers (uplift-2 R2)

Every outbound call to a data plane goes through `callPlane` in
`packages/observability/src/breaker.ts`: ledger SQL (`greptime.ts`), index
queries (`index-store.ts`), cache connects and commands (`cache.ts`), and every
Hindsight and RAGFlow request (the gated `fetch` `Substrate` hands to
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
reason: "ragflow circuit open"}`, and the fail-closed paths (emit, claim) stay
closed. The cache additionally refuses to reconnect for `CACHE_CONNECT_COOLDOWN_MS`
(5 s) after a failed connect, reported as `cache.cooldownUntil` in `/healthz`.

`GET /healthz` carries one row per plane, **report-only** — the status code still
comes from the ledger and the index alone:

```json
"planes": {
  "greptime":  { "ok": true,  "breaker": { "plane": "greptime", "state": "closed", "failures": 0, "openedAt": null, "lastErrorAt": null, "lastError": null }, "lastErrorAt": null },
  "index":     { "ok": true,  "breaker": { "state": "closed", "…": "…" }, "lastErrorAt": null },
  "cache":     { "ok": null,  "breaker": { "…": "…" }, "lastErrorAt": null },
  "hindsight": { "ok": false, "breaker": { "state": "open", "failures": 5, "openedAt": 1791480000000, "lastErrorAt": 1791480000000, "lastError": "hindsight GET /health: timed out" }, "lastErrorAt": 1791480000000 },
  "ragflow":   { "ok": null,  "breaker": null, "lastErrorAt": null }
},
"capacity": { "index": { "databaseBytes": 11534336, "tables": [ { "name": "memory_entries", "totalBytes": 409600, "liveRows": 64, "deadRows": 0 } ] } }
```

`ok` is `null` for a plane that is not configured (and for the cache until its
first command); `breaker` is `null` when `SUBSTRATE_BREAKER=0`. Hindsight and
RAGFlow are probed once each, bounded to 1 s, only when configured; the index is
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
is not a decision and sits in neither the numerator nor the denominator, so a
cache outage can neither breach this objective nor dilute it into `ok`. Only an
enforced refusal (`limited`) is a refusal; in the default `shadow` mode the
rate is 0 whatever `shadow_limited` counts, and that series is what the budgets
are tuned from before `SUBSTRATE_BUDGETS=enforce`. The identity label is the
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

# terminal 2
SUBSTRATE_URL=http://127.0.0.1:7410 SUBSTRATE_TOKEN=… bun run smoke:chaos
```

`--plane index|hindsight|ragflow|cache` (uplift-2 R2) blackholes a different
plane instead (for the loopback cache, stop `redis-server` rather than drop
packets). During the window every tick reads `/healthz`, asks for a brief as
`grok-bot`, and — for Hindsight and RAGFlow — makes the read that plane serves
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
| `GET /metrics` | the snapshot this process holds, in the shape `otlp.ts` encodes |
| `GET /slo` | the verdicts computed from it, the breached ids, `burn`, the per-plane `planes`, the `admission` refusal rate, the `docs` row and the per-surface `surfaces` rows |
| `GET /slo` | the verdicts computed from it, the breached ids (catalogue, plane and burn), `burn`, the per-plane `planes`, the `admission` refusal rate, the `docs` row, the `capacity` runway row and `history` |
| `POST /evidence` | `{ "graph_id": "ut-…", "format": "json" \| "html" }` |
| `GET /healthz` | now also `auditDurable`, `auditRecords`, `planes`, `capacity`, `cachedAt` and `stale` |

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
| `SUBSTRATE_BUDGETS` | `shadow` | `off` \| `shadow` \| `enforce`: whether the admission buckets are skipped, decided and counted only, or answered with 429. |
| `SUBSTRATE_BUDGET_READ_RPS` / `_BURST` | `20` / `40` | Per surface and second, with one second of headroom; reads are the GET routes, `/brief`, `/memory/recall`, `/docs/search`, `/events/query`, `/verify`, `/evidence`, `/drift` and the read tools. |
| `SUBSTRATE_BUDGET_WRITE_RPS` / `_BURST` | `10` / `20` | `/events`, `/memory`, `/docs/ingest`, `/docs/merge-trigger`, `/skills/propose`, `/handoff` and the write tools. |
| `SUBSTRATE_BUDGET_COORDINATION_RPS` / `_BURST` | `30` / `60` | `graph_claim`, `graph_heartbeat`, `graph_release`, `graph_complete`, `coord_reap_leases`: its own bucket, so reads never starve a heartbeat. |
| `SUBSTRATE_BUDGET_ANONYMOUS_RPS` / `_BURST` | `2` / `4` | Every class of the bucket all accepted untokened bridge callers share. |
| `SUBSTRATE_BUDGET_<SURFACE>_<CLASS>_RPS` / `_BURST` | — | Per-surface override (`GROK_BOT`, `SWARM_A01_ORCH`, …, the `SUBSTRATE_TOKEN_*` spelling); a half left unset is the class value. |

An endpoint pasted as `https://collector/v1/metrics` is accepted: the trailing
`/v1/metrics` is stripped, because appending it again would 404 on every export —
and silently, since export fails open.

`SUBSTRATE_AUDIT_PATH` is documented in [`mcp-audit.md`](mcp-audit.md).
