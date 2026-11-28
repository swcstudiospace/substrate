---
phase: 86-e5-observability-loop-plus-e8-session-replay-and-audit
verified: 2026-11-28T16:00:53Z
status: passed
score: 5/5 must-haves verified
covered_files:
  - .planning/phases/86-e5-observability-loop-plus-e8-session-replay-and-audit/86-PLAN.md
  - .planning/phases/86-e5-observability-loop-plus-e8-session-replay-and-audit/86-SUMMARY.md
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/session-replay.test.ts
  - packages/mcp-server/src/session-replay.ts
  - packages/observability/src/breaker.ts
  - packages/observability/src/correlation.test.ts
  - packages/observability/src/correlation.ts
  - packages/observability/src/error-burn.test.ts
  - packages/observability/src/error-burn.ts
covered_digest: "v3:sha256:2487ea7aedc636f0728b81ea56e3acb0320534b359d93f900f512a21950300d3"
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
re_verification:
  previous_status: passed
  previous_score: 5/5
  gaps_closed: []
  gaps_remaining:
    - "Live plane traffic correlation (fake-only doctrine)"
    - "Production Linear/Notion mirror wiring (deferred wiring slice)"
  regressions: []
---

# Phase 86 Verification: E5 observability loop + E8 session replay and audit

**Verified:** 2026-11-28T16:00:53Z
**Worktree:** `<repo-root>`
**HEAD:** `10b5ba82` (working tree = HEAD + uncommitted `safeCorrelationId` rename + path-sanitization nits; no logic changes).
**Scope:** Sequential re-verification (86 of 80/86) against `86-CONTEXT.md` + `86-PLAN.md` (3 tasks), 5 must-haves. Read-only except this file; no product code edits. This verifier re-ran the focused + regression suites and `tsc`, and recomputed `covered_digest` with the canonical gate algorithm (`gsd_run query verification.fingerprint` over the 8 impl/test files; PLAN/SUMMARY auto-unioned, report self-filtered under v3).

## Verdict summary

**Status: `passed` — 5/5.** Correlation ids thread the service plane calls (`PlaneSample.correlationId`, `callPlane` opts, `gatedFetch` header injection) and echo body-only per-request on `/healthz`, with invalid headers dropped never echoed. The error/timeout burn detector judges plane health (`breached` above the 1% ceiling, `insufficient-data` under 20 samples) and rides the healthz body, never the status. Replay verifies the hash chain first (break refuses, never proceeds), resolves checkpoints by id/event/seq, folds into fresh summaries without mutating frozen input, and mirrors through injected sinks with posted/skipped/failed outcomes, never throwing. The `redactedCorrelation` → `safeCorrelationId` rename is behavior-identical (pure rename, same `normalizeCorrelationId` delegation; all 4 touch points updated, zero stale references). Loop green at HEAD: focused **24 pass, 0 fail**; regression **238 pass, 0 fail**; `tsc` clean; `biome lint` clean on the renamed files.

## Criterion verdicts

| # | Criterion | Verdict | Evidence (file:line at HEAD) |
|---|---|---|---|
| 1 | Correlation id threaded to all three plane paths via gates + validated-only emission | **passed** | `correlation.ts` alphabet `[A-Za-z0-9._:-]{1,200}`, `normalizeCorrelationId` (non-string/invalid → null), `safeCorrelationId` (`:33`, pure delegation), `applyCorrelationHeader` pure, `correlationFromHeaders`. `breaker.ts:188` `PlaneSample.correlationId`; `:222` `callPlane` opts validated then observed on ok/open/timeout/error paths; `:290-308` `gatedFetch` header injection via `withCorrelation` (`:335` sets `x-correlation-id` on fresh `Headers`) — covering Timescale/Greptime/Dragonfly fetches. `correlation.test.ts` pins alphabet, rejection, validated-only emission, ALS scoping. Re-run at HEAD: pass (part of 24) |
| 2 | Healthz echoes validated correlation id per-request (body-only, never status) | **passed** | `server.ts:1092-1093` computes `safeCorrelationId` per request from `req.headers` after the memoised `compute()` resolves; spread keeps invalid/missing headers absent from the body; status untouched via `sendJson(res, memo.status, ...)`. `http.test.ts` regression 98/0 at HEAD confirms no healthz breakage |
| 3 | Burn detector breached/ok/insufficient-data on fake histograms + body-only healthz field | **passed** | `error-burn.ts` `evaluateErrorBurn` over `{ok, error, timeout, open}`; defensive sums; `evaluateErrorBurnFromSnapshot` over `substrate.plane.duration` via `findHistogram`/`mergeHistogram`; absent histogram → `insufficient-data`, never `ok` on no data; 1% ceiling, 20-sample floor. `server.ts:1096-1100` try/catch → `insufficient-data` fallback; field spread body-only, status untouched. `error-burn.test.ts` pins healthy→ok, storm→breached, sparse→insufficient-data, exact-target boundary. Re-run at HEAD: pass (part of 24) |
| 4 | Read-only replay to checkpoint (chain-first, frozen input unmutated) + bounded summary | **passed** | `session-replay.ts:69` `replayToCheckpoint` takes `readonly` events, `verifyChain` first (`:73`, break → `chain-broken`, never proceeds); resolves by ckpt id / event id / seq; folds into a fresh summary, mutates nothing. `formatReplaySummary` (`:123`) bounds the note (300 chars/action, 50 actions, hash only). Tests pin ckpt-id/event-id/seq resolution, chain-broken refusal, unknown/non-checkpoint refusal, frozen-input replay with ledger unchanged, note bounds and capping. Re-run at HEAD: pass (part of 24) |
| 5 | Summary mirror posted/skipped/failed never throws + loop green, no vocabulary drift | **passed** | `mirrorReplaySummary` (`session-replay.ts:159`) posts through injected `{ linear?, notion? }` sinks; missing sink → `skipped`, throwing sink → `failed`; never throws (try/catch per target). Focused **24 pass, 0 fail** (82 expects). Regression **238 pass, 0 fail** (breaker/slo/gauge/instruments + `http.test.ts`: 140 + 98, this verifier at HEAD). `npx tsc --noEmit -p tsconfig.json` → exit 0. `biome lint` clean on the 4 rename-touched files. `bun run check:phase-close` taken from the prior green run (no vocabulary/config change in this re-verification: `EVENT_KINDS` at 12, no new event kinds) |

## Decision coverage

All four `86-CONTEXT.md` Implementation Decisions are honored:

| Decision | Status | Evidence |
|---|---|---|
| Correlation propagation: `correlationId` threaded through service plane calls into Timescale/Greptime/Dragonfly reads; emitted on `healthz`/logs (redacted) | honored | `breaker.ts` threading + `withCorrelation`; `server.ts:1093` per-request validated echo via `safeCorrelationId`; raw header values never emitted |
| Burn alerts: SLO burn detector over `agent_events` error/timeout histograms; pure function, fake-testable | honored | `error-burn.ts` pure `evaluateErrorBurn`/`evaluateErrorBurnFromSnapshot`; `server.ts:1096-1100` body-only healthz field |
| E8 replay: reads append-only ledger, hash-chain verify first, re-applies up to a checkpoint; read-only, never mutates the ledger | honored | `replayToCheckpoint` (`session-replay.ts:69`); `verifyChain` gate; `readonly` input; frozen-input test green |
| Post-hoc summary: replay summary as ledger note, mirrored to Linear/Notion via existing reporters (read-only, never source of truth) | honored | `formatReplaySummary` bounded note + `mirrorReplaySummary` injected sinks; production client wiring deferred per SUMMARY |

## Gaps

None blocking. `behavior_unverified: 2` (live plane traffic + live mirror wiring, fake-only doctrine + deferred wiring slice — see frontmatter).

## Notes

- `covered_digest` rotated with the canonical v3 gate digest (`gsd_run query verification.fingerprint <phaseDir> <8 impl/test files>`): `v3:sha256:2487ea7a…` replaces `v3:sha256:6afe4d10…`. The rotation is solely the `redactedCorrelation` → `safeCorrelationId` rename in the two covered files it touches (`correlation.ts` definition, `server.ts` import + call-site); all covered content is otherwise byte-identical, and the rename is behavior-identical (same delegation, `tsc` + 262 tests green).
- `86-SUMMARY.md:11` still names `redactedCorrelation`: it is the historical ship record and is intentionally not edited; this verification is the rename-aware record.
- Deferred (out of scope, per SUMMARY): `substrate session replay` CLI subcommand (thin dispatch-table addition); production mirror wiring behind `ReplayMirrorSink`.
- Sequential re-verification (86 of 80/86); final Wave-8 phase; no commit per assignment.

_Verified: 2026-11-28T16:00:53Z — Verifier: sequential re-verification at HEAD 10b5ba82_
