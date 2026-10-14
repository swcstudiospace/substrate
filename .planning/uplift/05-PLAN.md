# Uplift 05 PLAN — Replayable signed dispatch handoffs + pre-launch drift gate

**Graph:** `ut-mv5r71hp-65f7b012` · **Proposal:** `.planning/UPLIFT_PROPOSAL.md` §U3 · **Refs:** SPE-10477

## Scope (files)

- `packages/dispatcher/src/substrate_dispatcher/handoff.py` (new) — build + post the signed handoff packet
- `packages/dispatcher/src/substrate_dispatcher/launcher.py` — compose context as packet; post before launch; drift scan call
- `packages/dispatcher/src/substrate_dispatcher/mcp.py` — client calls for `coord_drift_scan` (and the handoff route, if it is a REST twin rather than an MCP tool — read `handoff.ts`/`server.ts` for the exact surface)
- `packages/dispatcher/tests/test_handoff.py` (new), `packages/dispatcher/tests/test_launcher.py` (if present, extend)

## Change

1. Before launching, the dispatcher composes the dispatch context (goal, DoD lines, files, graph/node ids) and posts it as a signed `coord_handoff` packet through the substrate (the server signs when `SUBSTRATE_HANDOFF_KEY` is set; unsigned fallback = server's existing behavior, warning recorded). The packet — not inline prompt text — is the replayable record: a killed session's context rebuilds from the ledger alone.
2. Pre-launch, run `coord_drift_scan` for the worktree; a drift finding appends a stale-brief warning line to the marker comment (once-only comment machinery reused).
3. The launch prompt keeps fetching issue text at run time via `issue_get` (DISP-07 unchanged); the packet carries pointers and DoD, never issue prose.

## Acceptance (orchestrator-verified)

- `bun run test:py` green: failure-injection (kill after packet post → replay path rebuilds context from ledger); drift warning appended to marker; handoff signing absent → unsigned fallback warning; no issue prose in prompt or packet
- Full `bun test` no new failures; tsc clean
