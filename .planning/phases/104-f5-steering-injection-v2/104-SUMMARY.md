# Phase 104 Summary: F5 Live Session Steering injection v2

**Goal:** Omp injects event-driven updates into live sessions' TODO inboxes:
only subscribed sessions receive them, each event injects at most once per
session in `(occurred_at, seq)` order, and every failure is visible with a
retry path. No new coordination store.

**Status:** Done. `bun test` on the three new suites — 23 pass, 0 fail,
fake-only (no PG, no live bus). Regressions
`steering-idempotency.test.ts` + `steering-delivery.test.ts` — 48 pass,
0 fail. `tsc --noEmit` reports no errors in the new modules.

## Files

- NEW `packages/mcp-server/src/planning/steering-subscriptions.ts` — registry + pure `matchesSubscription`.
- NEW `packages/mcp-server/src/planning/steering-subscriptions.test.ts` — 10 tests.
- NEW `packages/mcp-server/src/planning/steering-injection.ts` — `SteeringInjector`, `injectionKey`.
- NEW `packages/mcp-server/src/planning/steering-injection.tracer.test.ts` — 4 tests.
- NEW `packages/mcp-server/src/planning/steering-injection.test.ts` — 9 tests.
- READ-ONLY reuse, unedited: `steering.ts` (inbox), `steering-idempotency.ts`
  (keyed ids, fingerprints, lanes), `steering-delivery.ts` (notice),
  `steering-store.ts` (durable keyed rows), `events.ts`, `presence.ts`
  (`SESSION_ID_RE`).

## Subscription schema

`{ sessionId, eventKinds[], pathScope?, graphScope?, optedIn }`, validated
against `SESSION_ID_RE`, non-empty kinds. Default-off: an absent record (or
`optedIn: false`) matches nothing, so `maybeInject` returns `[]` and writes
nothing. Kind allow-list AND every configured scope must match; scopes are
optional glob prefixes (`*`, `prefix*`, exact/prefix); no scope matches any
event of an allowed kind. Steering's own `steering.*` kinds never match
(loop guard at the filter layer).

## Injection key, ordering, durable replay

- Key: `injectionKey(eventId, sessionId)` =
  `keyedDirectiveId("steering-injection", sessionId:eventId)` (phase-77
  `idem-<sha256>` directive id). Same key replays: open inbox row first,
  then durable `savedKeyedQueue` row (restart), else the in-memory applied
  set — never a second directive. Fingerprint mismatch under a held key is a
  `failed-visible` `idempotency-conflict`, never a silent overwrite.
- Ordering: per-session buffer + hold-back (default one macrotask yield) so
  concurrent arrivals settle, then drain in `(occurred_at, seq, id)` order
  inside the per-session `SteeringIdempotency` lane. Sequential arrivals keep
  producer order. `queuedFor` reads back in delivery sequence.
- First subscribed kind: `planning.changed` (`INJECTION_DEFAULT_KINDS`);
  kind→action map (`ACTION_BY_KIND`, default `annotate`) is the extension
  point — the injector core never changes per kind.

## Failure taxonomy, retry, terminal visibility

Every attempt ends `injected | filtered | failed-visible`. `filtered`
reasons: `kill-switch`, `action-not-allowed`, `instruction-injection`,
`loop-guard`, `rate-limited`, `no-such-failure` (retry of nothing),
`superseded` (co-arrival already drained). `failed-visible` carries
`reason` (`enqueue-threw:<code>`, `enqueue-<refusal>`,
`durable-unavailable:<code>`, `idempotency-conflict`) and `attempts`.

- Retry: `STEERING_INJECTION_MAX_ATTEMPTS = 3`, backoff
  `min(100 * 2^(attempt-1), 1000)` ms (both injectable; tests use immediate
  sleep and assert `calls == 3`). Retries reuse the SAME key — a retry can
  never duplicate. `retry(sessionId, eventId)` re-enters a terminal failure.
- Terminal visibility: per-session in-memory failure log, queryable via
  `failuresFor` (oldest-first copies) and `failureCountFor` (notice-count
  hook for F7/106). Deliberate deviation: failures are NOT audit-sink rows —
  the audit entry schema is closed (`queued | acknowledged`) — so the log
  lives beside the injector; production surfaces counts through the existing
  notice path, no second inbox.

## Safety addendum (enforced in `precheck` + construction)

Allowlisted actions only (`annotate`, `redirect`; `pause` never
auto-proposed); bodies redacted and capped at 1,024 chars; summaries matching
instruction-injection patterns filter; propose-only (queue, never
acknowledge) with one-step revert (`revertInjection` → acknowledge
`declined`); per-session rate limit (default 30/min) + `setEnabled(false)`
kill switch; loop guards at filter and event-content layers.

## PG-gated suites

Skipped: `steering-idempotency.pg.test.ts`,
`live-session-authority.pg.test.ts` — no `SUBSTRATE_TEST_PG_URL` in this
environment. Nothing in this phase needs PG: replay is proven against the
durable-port fake and the inbox-held row.

## F7 handoff (Phase 106)

`SteeringInjector.maybeInject(event)` over `{ inbox, subscriptions }` is the
loop entry; `failuresFor`/`failureCountFor` feed the notice; `retry` is the
operator re-entry. Forward-only, no backfill, no push transport beyond the
existing hint+notice.
