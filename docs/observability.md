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

`status` is a class (`2xx`, `5xx`), not a code, and `route` is one of the known
paths or `other` — an unauthenticated caller walking random URLs must not be able
to mint a metric series per URL it tries.

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
site getting it right. Attribute values are capped at `MAX_ATTRIBUTE_LENGTH` too,
since a series key is held for the life of the process. The cost is visible in exactly one place, and is
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
> `{"password": 123456}`. A number is not inherently safe; a named count is.

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
| `brief.p95` | p95 of `substrate.brief.duration` ≤ **800 ms** | The brief is on the critical path of every prompt and the uplift hook's budget is 1.5 s, so 800 ms leaves room for the hook. |
| `emit.success` | stored / total ≥ **99.5 %** | Appends are fail-closed at the ledger, so a dropped event is a hole in the trail. |
| `lease.steal_rate` | stolen / claims ≤ **0.5 %** | Two agents believing they hold one node is the failure claims exist to prevent. |
| `quarantine.rate` | quarantines / claims ≤ **1 %** | A node the substrate withdraws is work no agent picks up. |

Read them at `GET /slo`, or in an evidence bundle. `GET /slo` answers **200
either way** — a breached objective is information, not a broken service, and a
monitor that read it as an outage would page on a slow hour.

### Two things the evaluator does on purpose

**The p95 objective is checked as a count, not an interpolation.** 800 is one of the
histogram's own bucket bounds, so the *exact* share of briefs at or below it is
known. That share decides the verdict. The interpolated p95 is reported alongside
for reading, and does not decide anything. A threshold that is not a bucket bound
reports `unmeasurable` rather than being quietly interpolated — a bucketed
histogram genuinely cannot answer it.

**The comparison is `≤`, and the objective is worded to say so.** SPE-4793 states
this as `p95 < 800 ms`. A bucket bound is an *inclusive* upper edge in OTLP — the
800 ms bucket holds `(400, 800]` — so no bucketed histogram can separate 800.000 ms
from 799.999 ms, and `≤ 800 ms` is the strongest claim the data supports. It is
therefore what gets reported, rather than checking `≤` while calling it `<`, which
would hand out a green verdict at the stated failure boundary in silence. The two
differ only for a brief that takes precisely 800.000 ms.

The alternative was to bucket with `<`, making the bound exclusive so the strict
check became exact. That was rejected: it would misreport bucket membership to every
standard collector, and an exported histogram has to mean what OTLP says it means.

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
- **Quarantine** — a node the substrate withdrew from dispatch rather than handing
  out. One reason is emitted today, `unrecorded-claim` (below). Phase 2 adds
  dispatch-failure quarantine.

The counters are process-lifetime totals, so an outage stays visible in `/slo`
after it ends. A rolling window is the collector's job; an SLO that healed itself
the moment the outage stopped would hide the outage from anyone who looked
afterwards.

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

`SUBSTRATE_CLAIM_REQUIRE_LEDGER` forces either way. The default is off when no
ledger is configured at all, so a local run does not have every claim withdrawn.
When the withdrawal itself fails — the index is down too — the refusal says the
node needs a manual release rather than leaving the caller to be refused forever.

### The chaos smoke: Greptime down 60 s

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
for a proof. `CHAOS_WINDOW_MS` and `CHAOS_TICK_MS` shorten the window.

It appends `note` events under a `ut-chaos-…` graph. The ledger is append-only so
they stay; they carry no repo, so no brief shows them.

## Routes

| | |
| --- | --- |
| `GET /metrics` | the snapshot this process holds, in the shape `otlp.ts` encodes |
| `GET /slo` | the verdicts computed from it, plus the breached ids |
| `POST /evidence` | `{ "graph_id": "ut-…", "format": "json" \| "html" }` |
| `GET /healthz` | now also `auditDurable` and `auditRecords` |

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
| `SUBSTRATE_CLAIM_REQUIRE_LEDGER` | derived | Withdraw a claim whose event did not land. |

An endpoint pasted as `https://collector/v1/metrics` is accepted: the trailing
`/v1/metrics` is stripped, because appending it again would 404 on every export —
and silently, since export fails open.

`SUBSTRATE_AUDIT_PATH` is documented in [`mcp-audit.md`](mcp-audit.md).
