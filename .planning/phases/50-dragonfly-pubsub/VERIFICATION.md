---
phase: 50-dragonfly-pubsub
verified: 2026-10-21
status: human_needed
score: 1 of 1 acceptance criterion proven in-repo (real-time notifications via Dragonfly, with tests); the owner accepted on 2026-10-22 that event-driven cache invalidation is out of phase 50's scope; the live subscription and wake-up latency are operator-gated
verified_on: gsd/v15-50-pubsub on its final tree, based on origin/main 2495a14
covered_files: ["packages/mcp-server/src/event-bus.ts", "packages/mcp-server/src/event-bus.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/server.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index.ts", ".env.example", "docs/data-planes.md", "docs/config-reference.md"]
---

> Status detail, kept verbatim from the original frontmatter: passed in-repo. A live Dragonfly subscription and a measured wake-up latency are operator-gated and were not run. It was set to gaps_found for the invalidation claim, which the owner then accepted as out of scope on 2026-10-22, so the status is human_needed for the operator-gated proof.

# 50-VERIFICATION: Dragonfly pub/sub for real-time event notifications

## Gates on the final tree

| Check | Command | Result |
|---|---|---|
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Config reference | `bun run config:reference -- --check` | up to date |
| Targeted | event bus (18), config, service, server, flag-registry (332) | pass |
| Full bun suite | `bun test` against `substrate_test_p50`, after the review fixes | 5987 pass, 2 skip, 0 fail (5989 tests, 223 files) |
| Repo locks | `bun run check:phase-close` | pass: 4 lock files green; EVENT_KINDS unchanged at 12; SURFACES unchanged at 27 |

## Acceptance criterion

| Criterion | Evidence in repo | Status |
|---|---|---|
| Real-time notifications for events via Dragonfly | The emit publishes one six-field hint after the ledger write; a fake bus proves the fields and that no summary or payload is sent; a publish failure does not fail the emit; a hint wakes an idle stream before its idle timeout and the event is read from the ledger; with the bus off there is no subscription and no publish | Proven in-repo against fakes |
| Tests | Bus tests (18): publish fields, oversize drop, the 1 s to 30 s backoff sequence, malformed message ignored, stop closes both clients, off or unset gives null; wiring tests as above | Proven in-repo |

## Not proven

- A live Dragonfly subscription and the stream's measured wake-up latency (operator-gated).
- Hint-driven cache invalidation, which the goal names and this phase does not implement (D50-e).
- Detection of a silent subscription drop after it resolved (the interface reports only a rejected subscribe).
