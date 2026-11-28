# Phase 104: F5 Live Session Steering injection v2 — PLAN

**Context:** `104-CONTEXT.md` (subscription filters, idempotent ordered TODO injection, visible failures with retry; built on registry + keyed idempotency)
**Goal:** Omp injects event-driven updates into live sessions' TODOs (steering inbox): only subscribed sessions receive them, each event injects at most once in `(occurred_at, seq)` order per session, and every failure is visible with a retry path. No new coordination store. F7 proves the loop end-to-end.
**Branch:** `gsd/w9-104-steering-injection-v2`
**Tracer-first:** Task 1 lands a thin end-to-end slice (subscribe → one event → one keyed queue → visible in `steering_list`/notice); Tasks 2–3 harden ordering/idempotency and failure visibility around it.

## Task 1 — Tracer: per-session subscription filter + one keyed injection end-to-end

**Do:**
- Add `packages/mcp-server/src/planning/steering-subscriptions.ts`: in-memory per-session subscription record `{ sessionId, eventKinds: string[], pathScope | graphScope, optedIn: boolean }`, default-off (absent record = no injection). Pure match function `matchesSubscription(sub, event): boolean` — kind allow-list AND scope prefix/glob match.
- Add `packages/mcp-server/src/planning/steering-subscriptions.test.ts` (fake-only, no PG): default-off drops everything; kind mismatch drops; scope mismatch drops; kind+scope match passes.
- Wire tracer injection path: new `packages/mcp-server/src/planning/steering-injection.ts` with `injectionKey(eventId, sessionId)` = `keyedDirectiveId("steering-injection", \`${sessionId}:${eventId}\`)` and a `maybeInject(event, subscribers)` that for each matching subscription calls the existing keyed queue path (`steering-tools.ts` queue handler with `idempotency_key`, directive id from `keyedDirectiveId`, fingerprint via `queueFingerprint`) — no new inbox, no new table.
- Subscribe/opt-in surface: minimal `subscribe(sessionId, filter)` / `unsubscribe(sessionId)` used by the tracer test and later tools wiring; validate `sessionId` with existing `SESSION_ID_RE`.
- Tracer test `packages/mcp-server/src/planning/steering-injection.tracer.test.ts`: subscribed session gets exactly one queued directive visible via `steeringNoticeFor`/`recordsFor`; unsubscribed session gets nothing.

**Exact files:**
- NEW `packages/mcp-server/src/planning/steering-subscriptions.ts`
- NEW `packages/mcp-server/src/planning/steering-subscriptions.test.ts`
- NEW `packages/mcp-server/src/planning/steering-injection.ts` (tracer shape only; Tasks 2–3 extend)
- NEW `packages/mcp-server/src/planning/steering-injection.tracer.test.ts`
- READ-ONLY reuse (no edits unless tracer forces): `packages/mcp-server/src/planning/steering.ts`, `steering-idempotency.ts`, `steering-tools.ts`, `steering-delivery.ts`, `steering-sessions-store.ts`, `events.ts`

**Acceptance:**
- `bun test packages/mcp-server/src/planning/steering-subscriptions.test.ts packages/mcp-server/src/planning/steering-injection.tracer.test.ts` — all green.
- Unsubscribed session receives zero directives after an event; subscribed session receives exactly one, carrying the event reference (id, kind, repo/path) in the redacted body.

## Task 2 — Idempotent ordered injection (event id + session id, per-session order)

**Do:**
- Extend `packages/mcp-server/src/planning/steering-injection.ts`:
  - Key: injection key stays `(event id + session id)` via `keyedDirectiveId`; duplicate delivery of the same event replays the stored reply/row (durable log lookup per Phase 77 migration 44/45 pattern) — never a second directive.
  - Ordering: per-session lane via `SteeringIdempotency.serialize(sessionId, …)` (or one lane per session); events applied in `(occurred_at, seq)` order; out-of-order arrival waits/serializes rather than injecting out of order. Sequence continues from the durable value after restart (Phase 77 precedent).
  - Source event: consume Phase 102 refresh events (`planning.changed` shape in `events.ts`) as the first subscribed kind; keep the kind set extensible without changing the injector core.
- Extend `packages/mcp-server/src/planning/steering-injection.test.ts` (NEW; fake-only): duplicate event → one directive; concurrent duplicate → one directive (lane); out-of-order pair → `(occurred_at, seq)` order in inbox; replay after store swap reads durable row, applies nothing twice.

**Exact files:**
- EDIT `packages/mcp-server/src/planning/steering-injection.ts`
- NEW `packages/mcp-server/src/planning/steering-injection.test.ts`
- READ-ONLY: `packages/mcp-server/src/planning/steering-idempotency.ts`, `steering-store.ts`, `steering-delivery.ts`, `events.ts`, `steering-sessions-store.ts` (registry as session authority)

**Acceptance:**
- `bun test packages/mcp-server/src/planning/steering-injection.test.ts` — duplicate, concurrent-duplicate, ordering, and restart-replay cases green.
- Same `(event id, session id)` injected twice yields one directive id; inbox order matches `(occurred_at, seq)` per session.

## Task 3 — Visible failures with bounded retry (never silent, never duplicates)

**Do:**
- Failure model in `steering-injection.ts` (+ `steering-subscriptions.ts` only if filter errors need surfacing): every injection attempt ends in exactly one of `injected | filtered | failed-visible`.
- `failed-visible`: write to the existing steering audit path (`steering-store.ts` audit sink / `SteeringExpirySweeper` precedent), fail-open for reads; the failure is retrievable per session (visible in `steering_list`/notice count or a per-session failure entry — reuse, do not invent a second inbox).
- Bounded retry: fixed attempts with backoff (e.g. `STEERING_AUDIT_ATTEMPTS`-scale, small constant, documented in file header); retry reuses the SAME injection key so a retry can never duplicate; after attempts exhaust, the failure stays visible (dead-letter-style terminal state, Phase 76/102 precedent) with an explicit `retry(sessionId, eventId)` re-entry using the same key.
- Tests in `steering-injection.test.ts` (extend, fake timers/fake audit sink): transient failure → retry succeeds with one directive; persistent failure → terminal visible failure, zero directives, retry with same key later succeeds once.

**Exact files:**
- EDIT `packages/mcp-server/src/planning/steering-injection.ts`
- EDIT `packages/mcp-server/src/planning/steering-injection.test.ts`
- READ-ONLY: `packages/mcp-server/src/planning/steering-store.ts`, `steering-delivery.ts` (notice/expiry precedent), `steering-tools.ts`

**Acceptance:**
- Failure-injection tests green: no silent drops (every failed event has a retrievable record), retries never duplicate, terminal failures remain queryable per session.

## Verification harness (run after all tasks; no gates/formatters)

```bash
bun test packages/mcp-server/src/planning/steering-subscriptions.test.ts \
  packages/mcp-server/src/planning/steering-injection.tracer.test.ts \
  packages/mcp-server/src/planning/steering-injection.test.ts
# plus existing regressions (must stay green):
bun test packages/mcp-server/src/planning/steering-idempotency.test.ts \
  packages/mcp-server/src/planning/steering-delivery.test.ts
# PG-gated (only with SUBSTRATE_TEST_PG_URL): steering-idempotency.pg.test.ts, live-session-authority.pg.test.ts
```

Pass = all fake-only suites green + no new inbox/table/store + F7 hook available (Phase 106 proves the loop; this phase only guarantees subscribed-once-ordered-visible).

## SUMMARY spec (what `SUMMARY.md` must record)

- Subscription schema + default-off rule and scope semantics (kinds + path/graph scope).
- Injection key formula (`keyedDirectiveId("steering-injection", sessionId:eventId)`), per-session ordering key (`occurred_at, seq` + lane), durable replay behavior.
- Failure taxonomy (`injected | filtered | failed-visible`), retry bound/backoff, terminal-state visibility and `retry` entry.
- Files added/edited, test files + case counts, PG-gated suites pass/skip with reason, any deliberate contract deviation.

## Out-of-scope (do NOT do)

- New coordination/offset store (reuse registry + keyed idempotency + existing audit; durable cursor only if Phase 102 already provides it).
- Fair-queue priorities beyond TTL expiry (Wave 8 deferred — stays deferred).
- Historical backfill (forward-only like Phase 102); push transport beyond the existing hint+notice/pull inbox; F7 end-to-end proof (Phase 106).
- Broad refactors of `steering.ts` / `steering-tools.ts` / session authority; repo-wide test runs, lint/format gates.
