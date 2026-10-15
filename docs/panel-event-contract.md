# Panel event contract

This is the minimum event record a client or panel needs to show substrate use honestly. Other CLI agents and Grok-based bots can opt in against it later. It does not change any emitter.

## What the Omp panel reads today

The Omp status panel (`packages/projector/omp/substrate-status.ts`) reads the server's counters from `GET /metrics`: per surface, the request, emit, and tool-call totals since `startedAt`. It reads no event rows. A client shows a panel row by emitting into those counters. A known client with no counters shows NOT_INSTRUMENTED.

## The minimum record

The server stores each event as a `SubstrateEvent` (`packages/mcp-server/src/types.ts`). The fields a panel can use:

| Panel field | Source on the stored event | Notes |
| --- | --- | --- |
| Event id (dedupe) | `id` | Unique per stored event. A retry sent with `x-substrate-replay: 1` is stored once; a retry without the header is stored again with a new id and counts again. |
| Event time | `ts` | Source event time. A collector may set it; otherwise it is the ingest time. It is not a guaranteed server ingest time. |
| Attributed client | `surface` | The attributed client, not necessarily the authenticated caller. See the attribution rule below. |
| Category | `kind` | One of `EVENT_KINDS`. |
| Actor | `actor` | Who acted, as stored. |
| Action | not a field | Carry it under a declared payload key, `payload.action`. |
| Item identifier | not a field | Carry an opaque id under `payload.item`. Never a title or a body. |
| Outcome | not a field | Carry it under `payload.outcome`. |

Action, item identifier, and outcome are not first-class fields. Until they are, a client must declare its payload keys. Making them first-class is a substrate change.

## Attribution rule

The server decides the stored `surface` in `attributedSurface` (`packages/mcp-server/src/mcp.ts`):

- Swarm surfaces and the `substrate` surface are bound to their own token. A body that names another surface is refused.
- Every other caller's stored `surface` is the body's declared value, or the token's surface when the body declares none.

So counts for one surface can include events an ordinary caller declared for that surface. A panel reading those counts is attributing by declaration, not by verified identity. This is a known limit, recorded as R17 in `.planning/uplift-7/RISKS-AND-GUARDS.md`.

## What a panel must never show

- `summary` or `payload` as text. Either can hold content. A panel may show a payload key only when that key is declared safe.
- Record bodies, memory text, document text, or any credential-like value.
- Any row it cannot attribute to a surface. Such rows are flagged, not dropped.

## Rules for a reader

- Read-only. A panel never writes.
- Redact before display. Control and bidirectional-override characters are removed from every name shown.
- The window and the last-seen time use the event time (`ts`) when the source provides it. That is source time, not ingest time. The Omp panel's counters carry no event times, so it uses the viewer's poll clock and says so on screen.
- Dedupe on `id`. Count a retried attempt once.

## Opting in

1. Emit with `POST /events` using the surface's own token. The smallest valid body is `{"kind":"note","summary":"substrate activity"}`. `kind` must be in `EVENT_KINDS`, and `summary` must be nonempty. Keep the summary harmless: the panel never displays it.
2. Put action, item, and outcome under declared payload keys. Never put a body, a prompt, a credential, or a document in `payload`.
3. Retries. The first attempt sets an `idempotency_key` and a `ts`. A retry sends the same key, the same `ts`, the same body, and the header `x-substrate-replay: 1`. The server honours the key only under `SUBSTRATE_EVENT_IDEMPOTENCY=accept` or `enforce`. A keyed replay without a `ts` is refused (`replay_ts_missing`), and so is a `ts` more than 24 hours in the future. A retry without the header is stored again as a new event with a fresh `id`, and it counts again.
4. A counter-based panel row needs nothing more. Each accepted emit increments `substrate.emit.total` for the surface.

## Read path for a future feed

`POST /events/query` (read scope, audited) returns the stored events with their `ts`. It filters on `session_id`, `graph_id`, `node_id`, `linear_identifier`, `repo`, `branch`, and `surface`. The `ts` it returns is source event time. A freshness check built on it needs its own ingest time, or it must treat `ts` as source time. The Omp panel does not use this route today. Choosing it is an open decision.
