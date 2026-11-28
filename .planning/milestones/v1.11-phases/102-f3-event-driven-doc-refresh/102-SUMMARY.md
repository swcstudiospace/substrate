# Phase 102 Summary: F3 Greptime event-driven doc refresh

**Goal:** File/change events in Greptime `agent_events` trigger debounced,
coalesced LightRAG re-ingest of affected docs through the F1 ingest writer;
failures go to a dead-letter store after bounded retries; no event loss
across restarts (durable offset).

**Status:** Done. `bun test packages/mcp-server/src/planes/doc-refresh.test.ts` —
12 pass, 0 fail, fakes only (no live Greptime/LightRAG in tests).

## Files changed

- NEW `packages/mcp-server/src/planes/doc-refresh.ts` — subscription,
  durable cursor, debounce/coalescer, refresher (Tasks 1+2, one module).
- NEW `packages/mcp-server/src/planes/doc-refresh.test.ts` — 12 fake-only tests.

## Subscription

- **Table:** Greptime `agent_events`; **kind filter:** `FILE_CHANGE_KINDS =
  ["file.edit", "file-change"]` — every other kind is dropped in
  `filterFileChangeKinds`, rows sorted by cursor.
- **Poll shape:** `pollAgentEvents(query, { since })` — injectable
  `GreptimeQuery(sql, { since })`; maps rows to `DocRefreshEvent { docKey,
  cursor }`, returns `{ events, cursor, held }`. Doc key from
  `doc`/`path`/`payload.doc`/`payload.path`, prefixed with `repo:` when present.
- **Cursor file:** path caller-chosen (production: alongside the phase-76
  outbox files); `storeCursor` atomic temp-file + rename, 0600 inside a 0700
  directory; `loadCursor` fail-open (missing/malformed → fallback, default 0).
  Restart resumes from the stored cursor — the fake query's `since` param
  proves no re-delivery.
- **Fail-open:** throwing query → `{ events: [], cursor: since, held: true }`;
  cursor not advanced, no ingest attempted.

## Debounce + retry contract

- **Window:** default 60s (`DEFAULT_DEBOUNCE_WINDOW_MS`), per-doc key.
  `DebounceCoalescer.observe` opens the window on first sight; later bursts
  only refresh the latest cursor (window never restarts — no starvation).
  `due()` emits one item per expired doc; `flush()` drains for shutdown.
- **Clock injection:** `now: () => number` on both coalescer and refresher;
  tests drive a fake clock (5 events in-window → 1 item; expiry → 2nd call).
- **Retry budget:** `DEFAULT_REFRESH_MAX_ATTEMPTS = 5`; pacing via
  `outboxBackoffMs(attempt, { base: 2000, cap: 300000 })` — the exact
  `event-buffer.ts` discipline; `sleep`/`random` injectable (tests assert the
  `outboxBackoffMs` delay sequence with fixed randomness).

## Ingest reuse proof

- Re-ingest calls only the injected `IngestFn(plan: SingleDocRefreshPlan)`,
  shaped as the one-doc narrowing of F1's `executeIngest(input: IngestInput)`
  (`packages/cli/src/corpus/ingest.ts`): `{ docKey, cursor }` in, `void` out.
  Production adapts F1 `executeIngest` (single-doc plan) into this slot —
  no second ingest implementation, no direct LightRAG writes anywhere in the
  module. Tests assert the fake is the sole writer (query + ingest fakes
  record every call; no fetch, no live URL).

## DLQ record schema

- Reuses the phase-76 `DeadLetterStore` (`event-dead-letter.ts`), in-memory
  or JSONL-file backed. Reason is always `exhausted` for refresh give-ups.
- Record carries: ledger-shaped event `doc-refresh:<docKey>:<cursor>`
  (valid `SubstrateEvent`: surface `substrate`, kind `file.edit`,
  sha256 `hash` over canonical JSON), `attempts`, `last_reason` (300-char
  cap), `enqueued_at`/`dead_lettered_at`. Replay fields live in
  `event.payload`: `{ docKey, cursor, attempts, lastReason }`.
- `refreshDoc` never throws for ingest failures: every doc ends
  `refreshed` or `dead-lettered` — nothing silently dropped.

## F5 handoff (Phase 104 consumes)

- `RefreshOutcome { docKey, outcome: "refreshed" | "dead-lettered", cursor,
  attempts }` per finished doc, in `refreshDue` order. F5 steering subscribes
  to this stream for refresh visibility (outcome + position per doc).

## Out of scope (deferred as planned)

- Historical backfill (forward-only from stored cursor); new Greptime tables;
  LightRAG server features; F1 ingest logic changes; F5 consumer (Phase 104).
