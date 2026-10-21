---
phase: 48-tailscale-proxy
verified: 2026-10-21
status: passed in-repo. The forwarders and the live cutover are operator-gated and were not run
score: 2 of 2 acceptance criteria proven in-repo (all DB endpoints classified and enforceable; boot audit events for access)
verified_on: gsd/v15-48-proxy on its final tree, based on origin/main 4c2c48e
covered_files: ["packages/mcp-server/src/db-endpoints.ts", "packages/mcp-server/src/db-endpoints.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/event-sources.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/index.ts", ".env.example", "docs/event-vocabulary.md", "docs/data-planes.md", "docs/railway-tailscale.md", "docs/config-reference.md"]
---

# 48-VERIFICATION: Secure proxy layer for the data planes

## Gates on the final tree

| Check | Command | Result |
|---|---|---|
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Config reference | `bun run config:reference -- --check` | up to date |
| Targeted | classifier, config, event-sources, flag-registry, store-lock | 222 and 79 pass, 0 fail |
| Full bun suite | `bun test` against `substrate_test_p48`, on the tree merged with the current main (phase 50 included) | 6015 pass, 2 skip, 0 fail (6017 tests, 224 files) |
| Repo locks | `bun run check:phase-close` | pass: 4 lock files green; EVENT_KINDS unchanged at 12; SURFACES unchanged at 27; the new db.endpoint row matches the vocabulary doc |

## Acceptance criteria

| Criterion | Evidence in repo | Status |
|---|---|---|
| All DBs accessed via a secure proxy | The classifier gives loopback, proxy or direct per plane; in enforce mode a direct endpoint refuses boot naming its variable; a Dragonfly URL is accepted only as loopback or an allow-listed proxy; tests cover each class and both policies | Proven in-repo. The live forwarders are not run (operator-gated) |
| Audit events for access | One `db.endpoint` event per configured plane at boot, carrying plane, class and policy and nothing secret; the event row and its doc row match; per-call access stays on the plane metrics | Proven in-repo for the boot events. Per-call audit is deliberately not added (D48-e) |

## Not proven

- The Tailscale forwarders, their ACL, the allow list values and the cutover (operator-gated).
- RBAC and connection pooling (deferred, D48-f).
