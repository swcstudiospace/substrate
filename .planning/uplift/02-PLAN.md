# Uplift 02 PLAN — Quota-burn SLO alerts + dispatch storm-breaker

**Graph:** `ut-mv5r71hp-65f7b012` · **Proposal:** `.planning/UPLIFT_PROPOSAL.md` §U4 · **Refs:** SPE-10477

## Scope (files)

- `packages/observability/src/instruments.ts` (+ `index.ts` if SLO registration lives there) — burn-rate SLOs over the existing `substrate.tokens` / `substrate.cost.usd` series
- `packages/observability/src/` SLO evaluation module (where existing SLOs are computed for `/slo`)
- `packages/mcp-server/src/server.ts` — `/slo` already surfaces snapshots; expose the burn SLOs through the existing mechanism only (no new route)
- `packages/dispatcher/src/substrate_dispatcher/` — pre-launch burn check (new small module `quota.py` + wiring in `dispatch.py`/`launcher.py`)
- `packages/dispatcher/tests/test_quota.py` — new tests

## Change

1. Observability: add two SLOs computed from the token/cost series over a rolling window (default 1 h), thresholds via env (`SUBSTRATE_BURN_TOKENS_PER_HOUR`, `SUBSTRATE_BURN_COST_USD_PER_HOUR`; unset = SLO reported but never breaching). Snapshot shape follows the existing SLO entries at `/slo`.
2. Dispatcher: before launching a session, fetch the substrate `/slo` snapshot with its existing client config; if either burn SLO is breaching, take the `exited-unclaimed`-style refusal path: one once-only marker comment naming the breached SLO, one `warning` event `payload.action: "dispatch.stormbreak"`, label left untouched, no retry, issue given up for this tick. Kill-switch-style override env `SUBSTRATE_STORMBREAK_DISABLED=1` (default off → breaker ON) for proof windows, re-read per tick like `SUBSTRATE_DISPATCH_DISABLED`.
3. Snapshot unreachable → fail-open (launch proceeds) with a stderr note, mirroring the dispatcher's existing fail-open client behavior.

## Acceptance (orchestrator-verified)

- `bun test packages/observability packages/mcp-server` green (SLO math + snapshot shape)
- `bun run test:py` green incl. new `test_quota.py`: breaching snapshot refuses with marker comment + warning event; disabled override launches; unreachable snapshot fails open
- `bunx tsc --noEmit` clean; full `bun test` no new failures
