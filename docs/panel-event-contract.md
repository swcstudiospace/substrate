# Panel event contract

This is the minimum event record a client or panel needs to show substrate use honestly. Other CLI agents and Grok-based bots can opt in against it later. It does not change any emitter.

## What the Omp panel reads today

The Omp status panel (`packages/projector/omp/substrate-status.ts`) reads the server's counters from `GET /metrics`: per surface, the request, emit, and tool-call totals since `startedAt`. It reads no event rows. A client shows a panel row by emitting into those counters. A known client with no counters shows NOT_INSTRUMENTED.

## The minimum record

The server stores each event as a `SubstrateEvent` (`packages/mcp-server/src/types.ts`). The fields a panel can use:

| Panel field | Source on the stored event | Notes |
| --- | --- | --- |
| Event id (dedupe) | `id` | Unique per event. Drop repeats by this id. |
| Timestamp | `ts` | Server ingest time, unless the collector supplies one (`EventInput.ts`). |
| Client | `surface` | The authenticated surface. Never the viewer's clock. |
| Category | `kind` | One of `EVENT_KINDS`. |
| Actor | `actor` | Who acted, as stored. |
| Action | not a field | Carry it under a declared payload key, `payload.action`. |
| Item identifier | not a field | Carry an opaque id under `payload.item`. Never a title or a body. |
| Outcome | not a field | Carry it under `payload.outcome`. |

Two gaps against the spec. Action, item identifier, and outcome are not first-class fields, so until they are, a client must declare its payload keys. Making them first-class is a substrate change.

## What a panel must never show

- `summary` or `payload` as text. Either can hold content. A panel may show a payload key only when that key is declared safe.
- Record bodies, memory text, document text, or any credential-like value.
- Any row it cannot attribute to a surface. Such rows are flagged, not dropped.

## Rules for a reader

- Read-only. A panel never writes.
- Redact before display. Control and bidirectional-override characters are removed from every name shown.
- The window and the last-seen time use the event source's clock when the source gives one. The Omp panel's counters carry no event times, so it uses the viewer's poll clock and says so on screen.
- Dedupe on `id`, so a retried emit is not counted twice.

## Opting in

1. Emit through `POST /events` with the surface's own token.
2. Put action, item, and outcome under declared payload keys. Never put a body, a prompt, a credential, or a document in `payload`.
3. Set `idempotency_key` when a retry is possible. The server honours it only under `SUBSTRATE_EVENT_IDEMPOTENCY=accept` or `enforce`.
4. A counter-based panel row needs nothing more: each accepted emit increments `substrate.emit.total` for the surface.

## Read path for a future feed

`POST /events/query` (read scope, audited) returns stored events with their `ts`. It filters on `session_id`, `graph_id`, `node_id`, `linear_identifier`, `repo`, `branch`, and `surface`. A panel that reads it could show a server-clock window, a last-seen time, and an activity feed. The Omp panel does not use it today. Choosing it is an open decision.
