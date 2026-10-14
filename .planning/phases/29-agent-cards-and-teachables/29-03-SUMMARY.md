# Phase 29 Plan 03: Anchor coverage proof and docs Summary

**Status:** complete — isolated CARD-04 holds end to end
(session → card → anchored hour on scratch); the live devnet leg is
documented as an operator window, never executed by agents.

## What was built

- `packages/mcp-server/src/teachable-anchor.test.ts` (new, 2 tests):
  drives `writeMemory` for a `teachable:` fact on a scratch Substrate,
  houses the captured `teachable` event in a fixed hour, asserts
  `hourDigest` covers the event id, then `verifyGraph` with a fake-RPC
  read-back of the matching memo reports the hour `anchored` with the event
  inside it (`event_count: 1`, `uncovered` empty). The tamper case anchors a
  foreign root: verify exits non-ok, `mismatch`, naming the hour. No
  `SOLANA_*` env, no CLI, no network — the phase-28 scratch-ledger pattern.
- `agent-card.test.ts` (+1 e2e): session S writes a teachable as surface H
  on a scratch substrate (write-capable + search-capable fake index);
  `buildAgentCard(H, teachablesForSurface(H))` validates clean with one
  `skills[]` entry keyed by the accepted memory id and slug-derived name;
  surface O's card is valid and empty.
- `docs/agent-cards.md` (new, ~30 lines): tag convention with the
  conflict-key and prefix-search rationale, route + A2A fields, the
  coverage argument (normal `note` → ingest hour → anchor → verify, zero
  anchor-code changes), and the explicit operator-window section for the
  live leg (funded devnet key, `substrate verify` shows the hour anchored).

## Verification (all green)

- Plan suite (teachable/anchor/card/server/service/memory-write/
  event-sources): 434 pass
- Full `bun test packages/mcp-server`: 1717 pass, 0 fail (58 skip)
- `bunx tsc --noEmit`: clean
- `bun run check:phase-close`: pass — EVENT_KINDS at 12, SURFACES at 27

## Deviations

None — plans executed as written. No vocabulary drift, no new
dependencies, no anchor-code changes, no devnet contact.

**Commit:** 582d1f6
