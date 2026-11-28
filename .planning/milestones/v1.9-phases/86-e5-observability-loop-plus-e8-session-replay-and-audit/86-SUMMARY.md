# Phase 86 summary — E5 observability loop + E8 session replay and audit

Final Wave-8 phase. Correlation IDs thread the service plane calls, an
error/timeout burn detector judges plane health, and the ledger replays
read-only to a checkpoint with the summary mirrored out. Closes the milestone.

## What landed

**Task 1 — correlation threading + healthz emission.**
`packages/observability/src/correlation.ts:1` — `CORRELATION_HEADER`,
`normalizeCorrelationId`, `redactedCorrelation`, `runWithCorrelation`,
`applyCorrelationHeader`, `correlationFromHeaders`. Redaction rule: only the
validated `[A-Za-z0-9._:-]{1,200}` form is ever emitted; raw header values are
dropped. Threaded in `packages/observability/src/breaker.ts:186`
(`PlaneSample.correlationId`), `breaker.ts:220` (`callPlane` opts),
`breaker.ts:286` (`gatedFetch` header injection) — covering the
Timescale/Greptime/Dragonfly plane fetches. `GET /healthz` echoes the
validated id body-only, per-request (never memoised), in
`packages/mcp-server/src/server.ts:1088`; invalid headers are absent, never
echoed.

**Task 2 — burn detector + healthz burn field.**
`packages/observability/src/error-burn.ts:1` — `evaluateErrorBurn` over
`{ok, error, timeout, open}` and `evaluateErrorBurnFromSnapshot` over
`substrate.plane.duration`; `insufficient-data` under 20 samples, `breached`
above the 1 % ceiling. `GET /healthz` carries the verdict body-only in
`packages/mcp-server/src/server.ts:1093`; never the status code.

**Task 3 — read-only replay + summary mirror.**
`packages/mcp-server/src/session-replay.ts:69` — `replayToCheckpoint` verifies
the hash chain via `verifyChain` first (break → `chain-broken`, never
proceeds), resolves by checkpoint id / event id / seq, folds events into a
fresh summary; input is `readonly` and never mutated.
`session-replay.ts:122` — `formatReplaySummary` bounds the note (300 chars /
50 actions, hash only). `session-replay.ts:162` — `mirrorReplaySummary` posts
through injected Linear/Notion comment sinks; per-target
posted/skipped/failed, never throws.

## Evidence

- New tests, fake-only, 24 pass: `correlation.test.ts` (7), `error-burn.test.ts` (8), `session-replay.test.ts` (9).
- Regression: `breaker/slo/gauge/instruments` 140 pass; `http.test.ts` 98 pass; combined final round 144 pass, 0 fail.
- `tsc --noEmit` clean; `biome lint` clean on all 9 touched files.
- `bun run check:phase-close` pass: 4 lock files green, `EVENT_KINDS` unchanged at 12, `SURFACES` baseline + substrate at 42 — no vocabulary change.
- Two self-caught regressions fixed before landing: a clobbered `PLANES` export + dropped `if (!gate) return fn()` path, and unbounded note output now capped at the writer boundary.

## Deferred

- `substrate session replay` CLI wiring: the replay core is pure and tested;
  the subcommand is a thin dispatch-table addition for a follow-up slice.
- Production mirror wiring (existing Linear/Notion clients behind
  `ReplayMirrorSink`) likewise left to the wiring slice; fakes prove the contract.
- No commit per assignment; working tree holds the 86-PLAN, code, tests, and this summary.
