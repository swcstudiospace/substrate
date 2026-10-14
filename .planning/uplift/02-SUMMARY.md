# Uplift 02 SUMMARY — Quota-burn SLO alerts + dispatch storm-breaker

**Graph:** `ut-mv5r71hp-65f7b012` · **Plan:** `02-PLAN.md` · **Refs:** SPE-10477 · **Date:** 2026-10-12

## What shipped

- **Observability:** `packages/observability/src/burn.ts` — rolling-1 h burn-rate ledger over the existing `substrate.tokens` / `substrate.cost.usd` series. SLOs `burn.tokens` / `burn.cost_usd`, thresholds from `SUBSTRATE_BURN_TOKENS_PER_HOUR` / `SUBSTRATE_BURN_COST_USD_PER_HOUR`; unset → `unconfigured`, never judged; malformed → unset + one deduped startup warning. `GET /slo` gains a sibling `burn[]` array; existing `results`/`breached` untouched (id assertions stay exact). Math is window-pruned, reset-aware, inclusive-ceiling (breach strictly greater), 5-min minimum span → `insufficient-data`.
- **Dispatcher:** `quota.py` + tick wiring — once per tick the `/slo` snapshot is read (same base-URL/bearer plumbing as the MCP client); a breach takes the once-only `[quota-burn]` marker-comment path (labels untouched, no launch, marker tag suppresses repeats) plus one `warning` event `payload.action: "dispatch.stormbreak"` naming the breached SLOs. Override `SUBSTRATE_STORMBREAK_DISABLED=1` re-read per tick exactly like the dispatch kill switch (env-file quoting/precedence per the D-15 idiom, shared `_env_switch`). Fail-open by construction: no fetcher, disabled, unreachable, or malformed → stand down, launch proceeds, stderr note.

## Contract changes (recorded)

- **One new once-only Linear marker: `quota-burn`.** The D33-02 lock (`test_claude_code_route.py::EXPECTED_MARKERS`, "zero marker additions") was deliberately extended with a recorded comment: the storm-breaker's refusal is a new reason the operator reads on Linear. Every existing marker text is still pinned unchanged.

## Deviations from the plan

- The plan's "marker comment" inherited the shared once-only machinery — which renders `[marker-id] text` and is locked by D33-02; resolved as above rather than bypassing the shared path (bypassing would have forked the once-only semantics).
- Plan said "no changes to server.ts if SLOs auto-surface" — the `/slo` handler needed the explicit `burn[]` sibling (12 lines), which the plan's scope list anticipated.

## Verification (exercised)

- `bun run test:py` — **272 passed** (12 new `test_quota.py` tests: token/cost/both breach → once-only marker + event + no launch; disabled override launches without reading the probe; unreachable/malformed/predating-substrate fail open; unconfigured never breaches; quota.py units for URL/auth/shape handling)
- `bun test packages/observability packages/mcp-server` — 0 fail (burn math: over/under/exactly-at, unconfigured, malformed, min-span, pruning, reset)
- Full `bun test` — 1 fail = recorded F-01 only; `bunx tsc --noEmit` clean

## Deferred / surprises

- The `/slo` burn read runs once per dispatcher tick that reaches a launch decision — bounded by the existing 30 s poll cadence.
