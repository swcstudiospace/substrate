---
phase: 50-dragonfly-pubsub
requirements: [SOTA-06]
status: designed on origin/main 2495a14; not yet implemented
---

# 50-CONTEXT: Dragonfly pub/sub for real-time event notifications

## Scope (ROADMAP and 7-SOTA plan, item 6)

Goal: Dragonfly pub/sub propagates Greptime events to the planes in real time, with event-driven cache invalidation.
Acceptance: real-time notifications for events via Dragonfly; tests.

The goal also names event-driven cache invalidation. That part is decided below (D50-e) and is not claimed as done.

## State on origin/main 2495a14 (scouted)

- `cache.ts` is closed by `cache-conformance.test.ts`: the comment-stripped file must not name `evalsha`, `publish`, `subscribe` or `blpop`. The header says the cache is "not a queue, a lock, a session or a pub/sub channel". The cache's client is Bun's `RedisClient`, which can also publish and subscribe.
- `docs/data-planes.md` says Dragonfly must not hold "queues, locks, sessions, pub/sub". This phase revises that statement (D50-f).
- Cache invalidation is already shared across instances: generation counters are read from Dragonfly on every request (`gen:*` keys, `INCR` on bump). Cross-instance invalidation therefore does not need pub/sub.
- Events: `Substrate.emit` (`service.ts`) writes to the ledger (`agent_events`) and nothing else. No subscriber exists. `/events/stream` (`server.ts`) polls the ledger, with a batch size of 200 and an idle wait between polls (`STREAM_IDLE_MS`).
- Lock tests that bind this work: `vocabulary-lock.test.ts` closes `EVENT_KINDS` at 12; `event-sources.test.ts` requires registered rows and banned payload keys; `store-lock.test.ts` keeps the ledger reads in the service.

## Decisions

- D50-a. The pub/sub connection lives in a new module `event-bus.ts`, never in `cache.ts`, so the cache's command set stays closed by its conformance lock.
- D50-b. The channel is `substrate:v1:events`. A message is a hint with the fields `v`, `id`, `kind`, `surface`, `graph_id` and `ts`. It never carries the summary, the payload, or any text.
- D50-c. The publish happens after the ledger write succeeds. A publish failure is counted and logged, and the emit still succeeds.
- D50-d. The ledger is the source of truth. A hint is a wake-up: `/events/stream` reads the ledger now, instead of waiting for its next idle poll. A missed hint costs latency, not data, because the stream still polls.
- D50-e. Cache invalidation is not driven by hints in this phase. Generation counters remain the only invalidation authority, and they are already shared through Dragonfly. The goal's invalidation claim is recorded as not implemented here.
- D50-f. The statement in `docs/data-planes.md` that Dragonfly must not hold pub/sub is revised: Dragonfly may carry the wake-up hints when `SUBSTRATE_EVENT_BUS=on`. It still holds no authoritative state.
- D50-g. The bus is off by default (`SUBSTRATE_EVENT_BUS`, on or off). It needs a cache endpoint that the endpoint policy accepts (loopback or proxy class). When it is on and the endpoint is missing, the bus is off with a logged reason, fail-open.
- D50-h. A dropped subscription reconnects with a backoff from 1 s to 30 s. A hint larger than 1024 bytes is dropped, not truncated.
- D50-i. No new event kind, no new tool, no new audit class, no schema change.

## Acceptance mapping

- Real-time notifications for events via Dragonfly: a published hint wakes the `/events/stream` reader, which then reads the ledger (D50-b, D50-d).
- Tests: the bus tests with a fake pub/sub client; the stream test that a hint wakes an idle reader before its idle timeout; the publish-failure test that the emit still succeeds.

## Out of scope

- Hint-driven cache invalidation (D50-e).
- A live Dragonfly pub/sub proof (operator-gated).
