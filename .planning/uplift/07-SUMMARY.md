# Uplift 07 SUMMARY — Loopback SSE event stream

**Graph:** `ut-mv5r71hp-65f7b012` · **Plan:** `07-PLAN.md` · **Refs:** SPE-10477 · **Date:** 2026-10-13

## What shipped

- **`GET /events/stream`** (`server.ts`): Server-Sent Events over the existing Bun.serve stack — `text/event-stream`, `no-cache/no-transform`, retry hint, one JSON ledger event per `id:`/`data:` frame (same shape and write-path redaction `/events/query` returns).
- **Auth/order**: 401 untokened before anything (route-level, holds even under `SUBSTRATE_ALLOW_ANONYMOUS=1` — the `/docs/merge-trigger` choice), then 403 non-loopback via the existing `isLoopbackRemote`. Audited once per connection under the existing `events_query` action — one action never grows a second trail name, never per frame.
- **Cursor semantics**: cursor = the `event_ingest` first-record position (`ingested_at`, `event_id`) — NOT collector-supplied `ts` (backdatable). Client sends `Last-Event-ID` (or `?cursor=`); unknown id or no cursor → live from tip. Window opens AT the cursor millisecond so duplicate ingest records collapse TypeScript-side (the D27-10 first-record rule), strictly-after filter, ordered ascending, capped. New pure helpers in `greptime.ts`: `cursorPosition`, `latestPosition`, `eventIdsAfter`, `eventsByIds`.
- **Bounds (the ledger is the buffer)**: no fan-out list, no in-memory queue. Constants (exported, test seams override): `STREAM_POLL_MS=500`, `STREAM_BATCH=200` rows/poll, `STREAM_IDLE_MS=5min` without delivered rows closes the stream server-side (client reconnects with Last-Event-ID), `STREAM_MAX_BACKLOG_BYTES=1MB` unflushed → slow consumer destroyed. Disconnect/error clears the interval (unref'd; read-count-proven in test).
- **Fail-open**: setup failures (cursor resolution, no ledger) answer ordinary 503 JSON; once headers are written a ledger blip only skips a tick. Emit paths never touch subscriber state. Poll-timer metrics hook moved `finish`→`close` so a destroyed (cut-off) response still lands in the histogram/span. Route registered in `KNOWN_ROUTES` (own metric series).
- **Known duplication (recorded)**: `rowToLedgerEvent` framing mirrors the private `service.ts` mapper — commented as the one unavoidable duplication under the file allowlist.

## Harness fixes (orchestrator)

- `streamText` typed `AbortController` (callers passed the controller), and a destroyed-socket read (ECONNRESET from the server-side cutoff) ends the helper's read loop instead of throwing — the cutoff path is the expected end.

## Verification (exercised)

- `bun test packages/mcp-server` — **0 fail** (9 new stream tests: refusal order, replay order + live append, `?cursor=` parity, idle timeout, disconnect-timer proof via read counts, slow-consumer cutoff, 250-row two-poll replay with `STREAM_BATCH`, cursor-failure 503, other routes unaffected during an open stream)
- `bunx tsc --noEmit` clean; `bun run check:phase-close` pass; full suite green mod recorded F-01

## Deferred / surprises

- Consumers still poll by default; switching collectors/lessons to the stream is follow-on work outside this item's scope (the seam is additive — both paths work).
