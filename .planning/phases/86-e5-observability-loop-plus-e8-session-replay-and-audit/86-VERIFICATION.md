---
phase: 86-e5-observability-loop-plus-e8-session-replay-and-audit
verified: 2026-11-28T10:52:03Z
status: passed
score: 5/5 must-haves verified
covered_files:
  - .planning/phases/86-e5-observability-loop-plus-e8-session-replay-and-audit/86-PLAN.md
  - .planning/phases/86-e5-observability-loop-plus-e8-session-replay-and-audit/86-SUMMARY.md
  - packages/observability/src/correlation.ts
  - packages/observability/src/correlation.test.ts
  - packages/observability/src/error-burn.ts
  - packages/observability/src/error-burn.test.ts
  - packages/observability/src/breaker.ts
  - packages/mcp-server/src/session-replay.ts
  - packages/mcp-server/src/session-replay.test.ts
  - packages/mcp-server/src/server.ts
covered_digest: "v3:sha256:correlation-b97f3287:errorburn-fb15dc4e:replay-81889eb6:breaker-dd5c1bdb:server-0fe8029e"
decision_coverage: { honored: 4, total: 4, not_honored: [] }
behavior_unverified: 2
behavior_unverified_items:
  - truth: "one correlation id is observable end to end on live Timescale/Greptime/Dragonfly plane fetches and echoed on a live /healthz response"
    test: "deploy the server, send live plane traffic with x-correlation-id set, and poll /healthz with the header"
    expected: "the same validated id on outgoing plane fetch headers, in gate observations, and in the /healthz body"
    why_human: "Phase doctrine is fake-only tests (no planes, no network in harness); header injection is pinned via fakes and the healthz echo is code-reviewed, but no live plane traffic ran in this phase"
  - truth: "mirrorReplaySummary posts a replay summary to real Linear/Notion targets through the production reporter clients"
    test: "wire the existing Linear/Notion clients behind ReplayMirrorSink and mirror a summary against live workspaces"
    expected: "posted outcomes on both targets with real comment URLs, and a failed (never thrown) outcome when one target is down"
    why_human: "Production mirror wiring is explicitly deferred to a follow-up wiring slice (per SUMMARY); only in-memory fake sinks ran in this phase"
---

# Phase 86 Verification: E5 observability loop + E8 session replay and audit

**Verified:** 2026-11-28T10:52:03Z
**Worktree:** `/tmp/agent-substrate-wave8`
**HEAD:** `cec85035`, working tree holds uncommitted Phase 86 implementation + docs (no commit per assignment)
**Scope:** Goal-backward verification against `86-CONTEXT.md` + `86-PLAN.md` (3 tasks), 5 must-haves. Read-only except this file; no product code, STATE, or ROADMAP edits. This verifier re-ran the focused loop, regression loops, `bunx tsc --noEmit`, `bun run lint`, and `bun run check:phase-close`, all green.

## Verdict summary

**Status: `passed`** — all five must-haves hold in code and tests. Correlation ids thread the service plane calls (`PlaneSample.correlationId`, `callPlane` opts, `gatedFetch` header injection) and echo body-only per-request on `/healthz`, with invalid headers dropped never echoed. The error/timeout burn detector judges plane health (`breached` above the 1% ceiling, `insufficient-data` under 20 samples) and rides the healthz body, never the status. Replay verifies the hash chain first (break refuses, never proceeds), resolves checkpoints by id/event/seq, folds into fresh summaries without mutating frozen input, and mirrors through injected sinks with posted/skipped/failed outcomes, never throwing. The loop is green: 24/0 focused, 140/0 + 98/0 regressions, tsc clean, lint clean (1913 files), phase-close pass. No vocabulary change (`EVENT_KINDS` 12, `SURFACES` 42).

## Criterion verdicts

| # | Criterion | Verdict | Evidence (file:line) |
|---|---|---|---|
| 1 | Correlation id threaded to all three plane paths via gates + validated-only emission | **passed** | `correlation.ts:16` alphabet `[A-Za-z0-9._:-]{1,200}`; `correlation.ts:22` `normalizeCorrelationId` (non-string/invalid → null); `correlation.ts:53` `applyCorrelationHeader` pure, null/invalid returns init unchanged; `breaker.ts:200` `PlaneSample.correlationId`; `breaker.ts:226-231` `callPlane` opts validated then observed on ok/open/timeout/error paths (`breaker.ts:234,241,249,254`); `breaker.ts:304-306` `gatedFetch` header injection via `withCorrelation` (`breaker.ts:335-337` sets `x-correlation-id` on a fresh `Headers`). `correlation.test.ts` pins alphabet, rejection, validated-only emission, ALS scoping, non-mutating injection, invalid-id passthrough (7 tests). |
| 2 | Healthz echoes validated correlation id per-request (body-only, never memoised, never status) | **passed** | `server.ts:1093` computes `redactedCorrelation` per request from `req.headers` after the memoised `compute()` resolves (`server.ts:1075-1090`); spread `...(correlationId !== null ? { correlationId } : {})` keeps invalid/missing headers absent from the body; comment at `server.ts:1091-1093` states "per-request, never memoised". `sendJson(res, memo.status, ...)` — status untouched. `http.test.ts` regression 98/0 confirms no healthz breakage. |
| 3 | Burn detector breached/ok/insufficient-data on fake histograms + body-only healthz field | **passed** | `error-burn.ts:48` `evaluateErrorBurn` over `{ok, error, timeout, open}` (open burns too); defensive sums (negatives/NaN → zero); `error-burn.ts:87` `evaluateErrorBurnFromSnapshot` over `substrate.plane.duration` via `findHistogram`/`mergeHistogram`; absent histogram → zero observations → `insufficient-data`, never `ok` on no data; `DEFAULT_ERROR_BURN_TARGET = 0.01`, `DEFAULT_ERROR_BURN_MIN_SAMPLES = 20` (`error-burn.ts:45-46`). `server.ts:1096-1102` try/catch → `insufficient-data` fallback; field spread body-only, status untouched. `error-burn.test.ts` pins healthy→ok, storm→breached, sparse→insufficient-data, exact-target boundary, fake-histogram breach (8 tests). |
| 4 | Read-only replay to checkpoint (chain-broken refuses, frozen input unmutated) + bounded summary | **passed** | `session-replay.ts:69` `replayToCheckpoint` takes `readonly SubstrateEvent[]`, `verifyChain` first (break → `chain-broken`, never proceeds); resolves by ckpt id / event id / seq; folds into fresh summary, mutates nothing. `session-replay.ts:37-39` caps (300 chars/action, 50 actions); `session-replay.ts:123` `formatReplaySummary` bounds the note. Tests pin ckpt-id/event-id/seq resolution, chain-broken refusal, unknown/non-checkpoint refusal, frozen-input replay with ledger unchanged, note bounds and capping (`session-replay.test.ts:61,71,80,91,105,116,124` — 9 tests). |
| 5 | Loop green: focused + regression + tsc + lint + phase-close; no vocabulary drift | **passed** | Focused: **24 pass, 0 fail** (82 expects, 3 files). Regression: **140 pass, 0 fail** (breaker/slo/gauge/instruments) + **98 pass, 0 fail** (`http.test.ts`). `bunx tsc --noEmit` clean (exit 0). `bun run lint` clean (1913 files, biome, no fixes). `bun run check:phase-close` **pass** (239 pass; 4 lock files green; `EVENT_KINDS` unchanged at 12; `SURFACES` baseline + substrate at 42 — no vocabulary change). |

## Gaps / regressions

None. All five must-haves verified; no regressions found. Two self-caught regressions fixed before landing (per SUMMARY: clobbered `PLANES` export + dropped open-gate path; unbounded note output now capped) — no re-open observed: `breaker.test.ts` (part of the 140-pass regression) and the note-bound tests (`session-replay.test.ts:116,124`) all pass at this HEAD.

## Behavior unverified (2, human-needed)

Live plane traffic + live mirror wiring — see frontmatter `behavior_unverified_items`. Fake-only by phase doctrine; `substrate session replay` CLI wiring and production Linear/Notion sink wiring are explicitly deferred to follow-up slices (per SUMMARY Deferred).

## Notes

- `covered_digest` is a `v3:sha256:` pin of the five implementation files' git-sha256 prefixes at verification time (full hashes in verifier notes); PLAN/SUMMARY digests `d76561ed` / `02b2b72c`.
- Deferred (out of scope, per SUMMARY): `substrate session replay` CLI subcommand (thin dispatch-table addition); production mirror wiring behind `ReplayMirrorSink`.
