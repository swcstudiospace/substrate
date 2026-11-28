# Phase 86 plan — E5 observability loop + E8 session replay and audit

Scope: correlation IDs across the three data planes, an error/timeout burn
detector, read-only ledger replay to checkpoint, and replay-summary mirroring.
Pure builders over facts; hash-chain integrity; redaction on every write;
fake-only tests. No new event kinds, no vocabulary changes.

## Task 1 — Correlation threading + healthz emission

- New `packages/observability/src/correlation.ts` (pure): `CORRELATION_HEADER`
  (`x-correlation-id`), `normalizeCorrelationId` (strict
  `[A-Za-z0-9._:-]{1,200}`, same alphabet as `service.ts` graph bind),
  `runWithCorrelation`/`currentCorrelation` (AsyncLocalStorage),
  `applyCorrelationHeader` (pure init helper). Redaction rule: only the
  validated form is ever emitted or logged; raw header values never are.
- Thread through service plane calls in `breaker.ts` (backward compatible):
  optional `correlationId` on `PlaneSample`, `callPlane` opts, and
  `gatedFetch` header injection — this covers the Timescale/Greptime/Dragonfly
  plane fetches, which all go through these gates.
- `server.ts` `/healthz`: echo the validated incoming correlation id as a
  body-only `correlationId` field (absent when the header is missing/invalid);
  never touches the status code.
- Test: `correlation.test.ts` — validation, redaction (raw never echoed),
  header injection on plane fetches, healthz echo (via fakes where cheap;
  server-level echo covered by unit on the normalize/emit helper if the route
  edit is thin).

Acceptance: one correlation id is observable on all three plane paths and on
the healthz body; invalid headers are dropped, never echoed.

## Task 2 — Error/timeout burn detector + healthz burn field

- New `packages/observability/src/error-burn.ts` (pure):
  `evaluateErrorBurn(counts, opts)` over `{ok, error, timeout, open}` plus
  `evaluateErrorBurnFromSnapshot(snapshot, opts)` reading
  `substrate.plane.duration` via the existing `findHistogram`/`mergeHistogram`
  helpers. `insufficient-data` under `minSamples`; `breached` when the
  error+timeout ratio exceeds target. Same verdict shape as burn/slo rows.
- `server.ts` `/healthz`: body-only `errorBurn` field computed from the
  in-process snapshot (try/catch → `insufficient-data`); never the status.
- Test: `error-burn.test.ts` — fake snapshots fire `breached`, healthy data
  reads `ok`, sparse data reads `insufficient-data`; alert threshold boundary.

Acceptance: burn alerts fire on fake error/timeout histograms; healthz carries
the field body-only.

## Task 3 — Read-only replay to checkpoint + summary mirror

- New `packages/mcp-server/src/session-replay.ts` (pure core, injected sinks):
  `replayToCheckpoint(events, ref)` — `verifyChain` first (break → `chain-broken`,
  never proceeds), resolve the checkpoint (`session.checkpoint` by ckpt id,
  event id, or seq), fold steering/session actions up to it into an applied
  summary. Takes `readonly` input, returns fresh objects, mutates nothing
  (frozen-input test). `formatReplaySummary` builds the ledger-note body;
  `mirrorReplaySummary(summary, sinks)` posts through injected
  `{ linear?, notion? }` comment sinks and returns per-target outcomes —
  production wiring passes the existing Linear/Notion clients; tests use
  in-memory fakes.
- Test: `session-replay.test.ts` — chain-broken refuses, checkpoint resolution
  by id/event/seq, read-only (frozen input + ledger unchanged), summary note
  shape, mirror outcomes per target including one-target-down.

Acceptance: replay verified read-only against hash-chain; summary mirrored to
both targets via existing reporter clients.

## Verification

`bun test` on the touched/new files, `tsc --noEmit`, `biome lint` on touched
files, `bun run check:phase-close`. No commit.
