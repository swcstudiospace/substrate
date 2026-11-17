---
phase: 71-multi-session-boundary
plan: "04"
status: locally-verified-awaiting-quality
requirements-addressed: [HARD-S1]
requirements-completed: []
verification: local-passed-external-quality-pending
---

# 71-04 Consumer Test Execution Summary

**Parent verification update:** All local acceptance and final root gates now pass; current exercised evidence is in `71-VERIFICATION.md`. Earlier failing runs and unexecuted correction notes below remain development history. Overall sign-off is still `human_needed`: Desk Quality / Programming Lead review has not been observed. No deployment, security certification, phase-completion authorization or merge readiness is claimed.

## Consumer/failure matrix authored

- New `packages/mcp-server/src/live-session-isolation.test.ts` invokes the production CLI command/client against a real ephemeral HTTP server: open, private 0600 retained file, owner list, sibling denial, renewed persisted expiry, explicit close, removal of the exact file, terminal old proof, and proof-free output across the full command sequence. All credentials/network/filesystem contexts are injected temporary fixtures, not host credential resolvers.
- The same suite parameterizes REST and direct-service private consumers over missing proof, wrong proof, a same-surface sibling's distinct proof, foreign surface, unknown well-shaped identity, expiry, and terminal close. REST comparisons include complete application headers/status/body, normalizing only transport-generated connection/date/request-tracing fields. Denial assertions include unchanged canonical authority snapshots, no inbox audit effects, and no generic audit invocation even when the required audit sink is unavailable. Operator-only policy, terminal operator target refusal, directive-only unkeyed acknowledgement, and separate syntax400/authentication401/authority503 remain explicit.
- New `packages/mcp-server/src/mcp.steering.test.ts` uses actual HTTP `/mcp`, real registered tools, real preflight/audit interception and one-use dispatch. It covers the eight private tools, full denied-target variants, complete fixed-ID response/application-header equality, mixed-batch no dispatch, notifications without fabricated replies, principal429 before authority/inbox/discovery/refusal/generic audit, general admission off/shadow plus cache outage, duplicate calls with separate debit/entries and exactly one batch audit, reused/mismatched contexts, arguments changed between actual HTTP preflight and dispatch, fail-closed-first whole-batch audit failure, failed refusal sinks without target/proof diagnostics, and unchanged historical-only batches.
- New `packages/mcp-server/src/live-session-consumer.test-support.ts` factors the existing focused suite's real-server harness into a reusable test-only consumer fixture. It records actual service-produced/queryable ledger rows, delegates the fourth constructor audit port to actual `auditToolCalls` and its isolated real audit chain, exposes bounded retrieval/ledger barriers, and has explicit per-suite cleanup. No authority put/import/reset or fake successful generic-audit bypass was introduced.
- Existing `live-session-boundary.test.ts` now uses that shared harness. Its event-query case issues and transitions a real identity, queues and acknowledges a directive with actual state movement, privately steers docs retrieval, explicitly closes, and queries the emitted rows as a same-surface sibling through REST and HTTP MCP with `include_payload=true`. Exact producer metadata allowlists exclude direction/planning-hash/proof/hash/directive-body/count/augmented-question markers. A previously published historical checkpoint payload remains readable and unchanged. The integration owner separately appended committed queue/issuance race regressions in this file after ownership coordination.
- Docs final-release cases cross real REST/HTTP-MCP retrieval and context-ledger awaits with close, expiry and authority outage. They capture the actual augmented retrieval input, forbid proof in it, and require terminal404 or sanitized503 rather than private success/degradation. The domain suite adds full/fast-cache/snapshot/last-good brief release barriers crossed with close/expiry/outage; conditional requests must not escape as text or304.

## Controlled PostgreSQL proofs authored

New `packages/mcp-server/src/live-session-restart.pg.test.ts` is guarded only by the existing controlled `SUBSTRATE_TEST_PG_URL` convention. It uses independent SQL pools, real `IndexStore.liveSessions` factories/service instances, optional historical cache migration off, and actual audit delegation. It covers reconstruction of active/terminal identities, SQL expiry, close-versus-heartbeat/transition effects and receipts, deterministic postcommit transition/queue barriers, cross-instance wait revocation without shared notifications, immediate/queued/timeout/closed release authority failures and cleanup, actual isolated migration37 legacy rows that cannot grant/revive, and missing-schema fail-closed behavior. Cleanup targets test-owned SQL rows/schema only; no production tombstone-delete API exists.

The already-authored storage authority suite remains the owner of deterministic active/tombstone entropy collisions, post-lock SQL-time expiry, stale previous-state races, disconnected-pool failure, and lost committed issuance/close responses (`planning/live-session-authority.pg.test.ts`). These are executable dependencies, not claimed exercised results. Removed cache-only APIs are not reconstructed merely to manufacture cache-eviction tests: real historical SQL rows are tested as non-authority instead.

## Existing fixture migration inventory

Changed existing planning/server suites:

- `packages/mcp-server/src/planning/session-state.test.ts`
- `packages/mcp-server/src/planning/steering-tools.test.ts`
- `packages/mcp-server/src/planning/steering-session-gate.test.ts`
- `packages/mcp-server/src/planning/steering-delivery.test.ts`
- `packages/mcp-server/src/planning/steering-rest.test.ts`
- `packages/mcp-server/src/planning/steering-durable.test.ts`
- `packages/mcp-server/src/planning/steering-waiters.test.ts`
- `packages/mcp-server/src/server.steering.test.ts`

Changed domain/MCP/docs/digest suites:

- `packages/mcp-server/src/mcp.test.ts`
- `packages/mcp-server/src/mcp.brief.test.ts`
- `packages/mcp-server/src/steering-wiring.test.ts`
- `packages/mcp-server/src/brief-fast-path.test.ts`
- `packages/mcp-server/src/session-context.service.test.ts`
- `packages/mcp-server/src/docs-search.test.ts`

Changed policy/config/admission/observability/event/audit suites:

- `packages/mcp-server/src/config.test.ts`
- `packages/mcp-server/src/flag-registry.test.ts`
- `packages/mcp-server/src/admission.test.ts`
- `packages/mcp-server/src/http.admission.test.ts`
- `packages/mcp-server/src/observe.test.ts`
- `packages/mcp-server/src/event-sources.test.ts`
- `packages/mcp-server/src/event.test.ts`
- `packages/mcp-server/src/session-events.test.ts`
- `packages/audit/src/policy.test.ts`
- `packages/audit/src/record.test.ts`

These fixtures issue through the shared test authority and inject trusted caller/proof plus actual audit delegation for private calls. Public-only partial-index fixtures explicitly inject unavailable live authority, preserving their actual public behavior rather than adding an optional-method fallback to the production factory. Private transitions preserve omitted fields and authoritative previous-state checks; durable acknowledgements/history/hints and waiter cleanup retain their real consumers. The new lease loader/registry/environment parity, method-aware lifecycle admission, mandatory limits, hash-only live audit contexts, historical attribution, exact new live-event projections, generic batch ordering/corrections, and public digest provenance/caps/self-exclusion remain behavioral assertions.

### Additional public-only partial-index fixtures

The parent explicitly expanded caller migration to these additional existing files. Changes add only an explicit unavailable test authority seam (`history: null`, `liveSessions: null` where no steering seam previously existed), merging rather than overwriting other injected options. Existing public behavior assertions and actual SQL factories remain intact.

```text
packages/mcp-server/src/agent-card.test.ts
packages/mcp-server/src/brief-profile.test.ts
packages/mcp-server/src/brief-recall.test.ts
packages/mcp-server/src/brief-worktrees.service.test.ts
packages/mcp-server/src/cache-swr.test.ts
packages/mcp-server/src/cache.test.ts
packages/mcp-server/src/evidence-anchor.test.ts
packages/mcp-server/src/fabric-mcp.test.ts
packages/mcp-server/src/graph-bind.test.ts
packages/mcp-server/src/graph-edges.mirror.test.ts
packages/mcp-server/src/http.test.ts
packages/mcp-server/src/mcp-verify-tools.test.ts
packages/mcp-server/src/memory-expiry-cache.test.ts
packages/mcp-server/src/memory-outage-status.test.ts
packages/mcp-server/src/node-artifact.read.test.ts
packages/mcp-server/src/request-path.test.ts
packages/mcp-server/src/retain-outbox.test.ts
packages/mcp-server/src/rollback-compat.test.ts
packages/mcp-server/src/server.authority.test.ts
packages/mcp-server/src/server.test.ts
packages/mcp-server/src/service-forget.test.ts
packages/mcp-server/src/service.test.ts
packages/mcp-server/src/session-rollback.testkit.ts
packages/mcp-server/src/skills-approve.test.ts
packages/mcp-server/src/slo-history.test.ts
packages/mcp-server/src/soak.testkit.ts
packages/mcp-server/src/teachable-anchor.test.ts
packages/mcp-server/src/teachable.test.ts
packages/mcp-server/src/watchdog.test.ts
packages/mcp-server/src/worktree-claims.test.ts
```

`invalid-write-roundtrip.test.ts` intentionally retains its real controlled-PG `IndexStore` path. Actual authority-factory tests are not replaced with null seams. The strict production factory remains mandatory.

## Intentional removals and compatibility boundaries

Deleted only obsolete suites exclusively pinning the removed registry/cache implementation:

- `packages/mcp-server/src/planning/session-state.durable.test.ts`
- `packages/mcp-server/src/planning/steering-sessions-store.pg.test.ts`

Migration37 SQL/history/table compatibility remains intact and testable through actual isolated SQL. Removed `StubSessionMachine`, registry object-identity/process-local authority assertions, caller-chosen registration/resurrection grants, historical-label private-ledger lookup, unchecked private durable-history helper calls, and fabricated successful audit-append mocks. They were replaced by issued-authority/checked-consumer/real-chain behavior, not repinned to replacement implementation text. Removed obsolete cache TTL behavior rather than retaining dead configuration or aliases.

Intentionally unchanged pure/public suites: `brief-sessions.test.ts`, `session-context.test.ts`, and `docs-plane-hardening.test.ts`. Historical REST/MCP events and checkpoint/rollback labels, ordinary no-live docs/brief, public redacted repository digest, and unkeyed operator queue/ack remain historical/public and proof-free. CLI-owned suites were not edited in this lane; the real CLI-to-HTTP tracer imports production CLI consumers without changing their tests.

## Concurrent write clarification

Parent's later policy clarification takes precedence over old final-recheck expectations for committed writes: a committed queue/update/heartbeat returns a truthful public metadata receipt despite a later close/outage; it must not claim404 while hiding a real effect. Issuance returns its one-time proof to the creator even if an independently committed close already made that proof terminal. Private reads/docs/brief/waits retain final rechecks. An acknowledgement stands if its subsequent state transition loses to close; a state movement that already committed remains truthfully applied, but a later failed authorization suppresses its checkpoint hint. No distributed rollback/reset/revival behavior was added. Race assertions correlate actual SQL/inbox effects with these receipts.

## Evidence, gates and limitations

**No tests, builds, typechecks, lint, formatters, installs, code generation, git writes, SQL connections or runtime smoke commands were run by this test lane or its workers.** Parent separately supplied the first integrated gate evidence above; it is not a final passing result. No production credentials were read, production schema changed, hook/timer installed, deployment sent, or devnet transaction performed.

### Corrections following the parent-owned first gate

- Corrected imported `EventInput`, literal refusal types, optional payload/expiry/response guards, and unused/non-null assertions in the reported owned tests; existing behavior assertions remain.
- The shared ledger fixture now returns Greptime-shaped epoch-millisecond timestamps instead of ISO event timestamps from `queryEvents`/`readEvents`; this fixes the actual row-conversion cause of the REST event-query503 without weakening production parsing.
- Two focused async cases previously constructed Bun's eager rejection matcher before closing the binding. Their assertions now run after the actual reader barrier, close and release; no arbitrary delay or weaker final authorization result was introduced.
- Context recall legitimately caches the original public question, not the augmented private query. Release tests now inspect actual cache arguments and resolved values for private direction/hash/proof/live-ID absence and pin the public recall question, while still forbidding shared docs-result caching.
- An over-capacity batch refuses atomically without spending an available single token. The MCP flood case now spends that remaining token through a real proved owner request, resets recordings, and checks all subsequent429 requests with an injected fixed principal clock and no lookup/audit/effect.
- Parent's complete unmodified transport baseline returned three separate successful SSE response frames for three ping request IDs and no notification response. The inherited helper's `.at(-1)` discarded earlier valid responses. The shared helper now collects every JSON-RPC response frame, validates exact request/response identities for batches, preserves single-call objects and empty notification behavior, and returns the actual batch responses without fabricating or wrapping a lone result. Strong duplicate-entry/once-per-batch-audit/all-ID assertions remain; an explicit real SSE ping/notification regression was added. No production protocol change was needed. The earlier object-only observation was a partial-parser observation, not an established wire limitation.

### Corrections following the parent-owned full root run

The test lane changed only `mcp.brief.test.ts`, `server.test.ts`, `http.test.ts` and this summary for this correction pass:

- Deleted REST/MCP invalid-profile error-copy pins, retaining validation refusal and adding no-composition/no-ETag assertions. The unknown-surface public REST200 compatibility test remains intact; its observed400 is a separately assigned product regression, not an assertion to weaken.
- Migrated historical-only docs-context coverage to the approved split: the historical label remains ordinary attribution, the public memory recall still returns its seeded memory, no private ledger read occurs, and context events are empty. Removed the invalid-context error-message wording pin while preserving400 and no recall/ledger effects.
- The deeply nested unknown-field brief request is now correctly rejected by validation before audit. Fail-open audit-fault tests therefore use a valid public brief request and explicitly inject an unexpected `audit.append` exception. They assert the actual append attempt, HTTP200/nonempty brief, no written audit row, and allowed/lost versus denied/lost metrics. The real deep-encoder fail-closed memory tests remain unchanged.

Parent owns the additional missed partial-index fixtures, planning-title/ratchet adjustments, product unknown-surface compatibility fix and final integrated rerun. No test, typecheck, lint or other check was rerun by this lane.

Main must execute the exact planned acceptance/controlled-DB/CLI/regression/policy groups after all files land, including:

```text
bun test --timeout 30000 packages/mcp-server/src/live-session-boundary.test.ts packages/mcp-server/src/live-session-isolation.test.ts packages/mcp-server/src/mcp.steering.test.ts
bun test --timeout 30000 packages/mcp-server/src/planning/live-session-authority.test.ts packages/mcp-server/src/planning/live-session-authority.pg.test.ts packages/mcp-server/src/live-session-restart.pg.test.ts packages/mcp-server/src/index-store.migrate.test.ts packages/mcp-server/src/index-store.migrate-contract.test.ts
bun test --timeout 30000 packages/mcp-server/src/planning packages/mcp-server/src/server.steering.test.ts packages/mcp-server/src/session-context.test.ts packages/mcp-server/src/brief-sessions.test.ts packages/cli/src/steer packages/cli/src/session/hook.test.ts
```

Also run the additional MCP/docs/brief/policy/CLI groups and authorized generated-reference/type/lint/full repository gates recorded in `71-VALIDATION.md`. Missing/skipped controlled PostgreSQL coverage is an acceptance blocker, not a pass. Parent alone records actual commands/counts/failures/skips in `71-VERIFICATION.md` and reconciles ROADMAP/STATE/REQUIREMENTS. Desk Quality/Programming Lead's Greptile gate remains external: FAILED/SKIPPED/unavailable/unaddressed review is a blocker. Draft PR only; no merge or auto-merge.
