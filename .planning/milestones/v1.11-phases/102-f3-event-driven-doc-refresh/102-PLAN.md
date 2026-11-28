# Phase 102: F3 Greptime event-driven doc refresh — Plan

**Context:** `102-CONTEXT.md` in this directory (boundary, decisions, code context).
**Goal:** File/change events in Greptime `agent_events` trigger debounced, coalesced LightRAG re-ingest of affected docs through the F1 ingest writer; failures go to a dead-letter store after bounded retries; no event loss across restarts (durable offset). F5 steering consumes refresh events.

## Constraints (from CONTEXT + established patterns)
- Event source: Greptime `agent_events` filtered to file/change kinds only; cursor (durable offset) persisted to disk, survives restarts.
- Debounce/coalesce: per-doc window (default 60s); bursts for the same doc collapse to one re-ingest.
- Reuse: F1 ingest path (`executeIngest` in `packages/cli/src/corpus/ingest.ts`) is the single writer — no second ingest implementation.
- Backfill of historical events is out of scope (forward-only from stored cursor).
- Patterns: append-only ledger; fail-open reads; fake-only tests (injectable fetch/query fake, no live Greptime/LightRAG in tests).
- DLQ precedent: `packages/mcp-server/src/event-dead-letter.ts` (+ `event-buffer.ts` backoff discipline).

## Task 1 — Greptime subscription with durable offset (tracer first)
**Files:**
- NEW `packages/mcp-server/src/planes/doc-refresh.ts` — `pollAgentEvents(query, { since })` Greptime query filtered to file/change kinds; `DocRefreshEvent { docKey, cursor }`; `loadCursor/storeCursor(path)` file-backed durable offset (0600 JSON, atomic write); `filterFileChangeKinds(rows)` kind filter.
- NEW `packages/mcp-server/src/planes/doc-refresh.test.ts` — fake-only tests: kind filter drops non-file/change rows; cursor round-trips through a temp file; restart resumes from stored cursor (no re-delivery); fake query records calls, no live URL.

**Tracer:** one hardcoded fake Greptime row (`kind: file-change`, doc `a.md`, cursor `42`) flows `pollAgentEvents → filter → storeCursor` before generalizing the query/poll loop.
**Done when:** file/change rows map to doc events with monotonic cursor; cursor file survives simulated restart; non-matching kinds ignored.

## Task 2 — Per-doc debounce/coalesce + ingest reuse + DLQ
**Files:**
- EDIT `packages/mcp-server/src/planes/doc-refresh.ts` (same file as Task 1) — `DebounceCoalescer` per-doc window (default 60s, injectable clock): bursts for one `docKey` collapse to a single due item; `refreshDue(docKey)` calls F1 `executeIngest` with a single-doc plan; bounded retries with backoff per `event-buffer.ts` discipline (`EVENT_DRAIN_TICK_MS` / `outboxBackoffMs`); after budget spent, `DeadLetterStore` record (`packages/mcp-server/src/event-dead-letter.ts` reused, reason `exhausted`) carrying doc key, cursor, attempts, last reason.
- EDIT `packages/mcp-server/src/planes/doc-refresh.test.ts` (same file as Task 1) — fake-only tests: 5 rapid events for one doc → 1 ingest call; distinct docs → distinct calls; window expiry → second call; exhausted retries → one DLQ record with replay fields; ingest called via injected `executeIngest`-shaped fake (assert single-writer shape, no direct LightRAG writes).

**Done when:** burst coalescing proven by fake clock; re-ingest goes through the F1 writer interface only; every permanently failed doc has a replayable DLQ record; nothing silently dropped.

## Verification harness (no gates/formatters)
- `bun test packages/mcp-server/src/planes/doc-refresh.test.ts` — all pass, fakes only (assert no network: fake query/ingest record calls, no live Greptime/LightRAG URL).
- Manual tracer check: fake row `{kind:"file-change", doc:"a.md", cursor:42}` → one due item after window → ingest fake receives single-doc plan for `a.md`; `loadCursor()` returns `42` after simulated restart.
- Coalesce check: 5 fake events for `a.md` within 60s (fake clock) → exactly 1 ingest call; DLQ check: forced ingest failure × budget → `DeadLetterStore` holds 1 record with `{docKey:"a.md", cursor, attempts, last_reason}`.
- Failure-injection check: Greptime query fake throws → poll resolves to held/skipped (fail-open), cursor not advanced, no ingest call.

## SUMMARY spec (what lands in phase SUMMARY.md)
- Subscription table (Greptime table + kind filter, poll shape, cursor file path/mode) + files changed.
- Debounce contract (window default 60s, per-doc key, coalesce semantics, clock injection) + retry budget/backoff values.
- Ingest reuse proof (F1 `executeIngest` call shape, single-writer statement) + DLQ record schema (fields, reasons, replay path).
- F5 handoff: refresh-event shape F5 steering consumes (doc key, outcome, cursor).

## Out of scope
- Historical backfill (forward-only from cursor; explicitly deferred).
- New Greptime tables, LightRAG server features, schema migrations, live-service writes in tests.
- F5 steering consumer implementation (Phase 104); F1 ingest logic changes (reuse as-is).
- Gates, formatters, CI runs (verification harness only).
