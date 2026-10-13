# Uplift 07 PLAN — Loopback SSE event stream

**Graph:** `ut-mv5r71hp-65f7b012` · **Proposal:** `.planning/UPLIFT_PROPOSAL.md` §U7 · **Refs:** SPE-10477

## Scope (files)

- `packages/mcp-server/src/server.ts` (+ `server.test.ts`) — `GET /events/stream` route
- `packages/mcp-server/src/greptime.ts` — only if a cursor read helper (events after id) is missing; otherwise reuse
- `docs/mcp-server-repository-integration.md` or the REST route docs — register the route where `KNOWN_ROUTES`/audited routes are documented (read `server.ts` for the registration seam)

## Change

1. `GET /events/stream`: Server-Sent Events response; bearer surface-token auth (same auth as `/events` POST); loopback bind only. Replay: client sends `Last-Event-ID` (the ledger event id); server streams events with id > cursor in ingest order, then keeps streaming as rows land (poll the ledger cursor at a short interval — no in-memory fan-out buffer; the ledger is the buffer).
2. Bounds: idle timeout closes the stream; a slow consumer is cut off after a bounded backlog rather than blocking the server; each connection reads its own cursor (no shared state).
3. Fail-open: stream setup failure returns an ordinary error response; emit paths never touch subscriber state.

## Acceptance (orchestrator-verified)

- `bun test packages/mcp-server` green: contract test (order, auth refusal 401, Last-Event-ID replay skips older rows, disconnect cleanup, slow-consumer cutoff); no new EVENT_KINDS/SURFACES
- tsc clean; phase-close pass; full `bun test` no new failures
