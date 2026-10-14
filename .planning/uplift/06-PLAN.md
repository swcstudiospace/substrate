# Uplift 06 PLAN — Knowledge freshness automation

**Graph:** `ut-mv5r71hp-65f7b012` · **Proposal:** `.planning/UPLIFT_PROPOSAL.md` §U6 · **Refs:** SPE-10477

## Scope (files)

- `packages/projector/src/skills-sync.ts` (+ test) — trigger dataset re-ingest on successful fast-forward
- `packages/mcp-server/src/server.ts` (+ server.test.ts) — token-authed loopback-only `POST /docs/merge-trigger` route
- `packages/mcp-server/src/docs-datasets.ts` — reuse existing refresh entry (no redesign; exported hook if one is missing)

## Change

1. skills-sync: after a successful fast-forward, POST the dataset refresh (loopback substrate URL + the projector's surface token), fire-and-forget with counted refusal (fail-open — sync success never depends on ingest). Unconfigured docs plane → silent no-op (existing null-block idiom).
2. New route `POST /docs/merge-trigger`: bearer surface-token auth, loopback bind check, triggers the `agent-substrate` dataset refresh through the same `docs-datasets` entry; refusal reasons per DOCS-02 conventions; idempotent by content hash (existing).
3. Both paths reuse `docs_ingest` redaction/refusal rules by construction (they call the same code).

## Acceptance (orchestrator-verified)

- `bun test packages/mcp-server` green: route 401 without token, non-loopback bind refused, refresh called with dataset id, unconfigured plane no-op
- `bun test packages/projector` green: fast-forward fires exactly one refresh POST; dirty-tree sync fires none; POST failure never fails the sync
- tsc clean; phase-close pass; full `bun test` no new failures
