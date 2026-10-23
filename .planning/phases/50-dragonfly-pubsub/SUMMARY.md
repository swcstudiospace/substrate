---
phase: 50-dragonfly-pubsub
requirements: [SOTA-06]
status: in review (draft PR). In-repo gates green. A live Dragonfly subscription and its latency gain are operator-gated and not run
---

# 50-SUMMARY: Dragonfly pub/sub for real-time event notifications

## Built

- **The bus (`event-bus.ts`).** A pub/sub connection on the channel `substrate:v1:events`. It publishes a hint after each ledger write and delivers received hints to listeners. A hint carries only `v`, `id`, `kind`, `surface`, `graph_id` and `ts`. It has no summary, payload or text. A publish failure is counted, logged once per run, and never throws. A hint over 1024 bytes is dropped, not truncated. A dropped subscription reconnects with a 1 s backoff, doubling to 30 s.
- **Emit wiring.** The emit publishes one hint after the ledger write succeeds, fire-and-forget. The emit's reply is unchanged, and a rejected publish leaves the emit intact.
- **Stream wiring.** `/events/stream` subscribes for the life of the response and releases the subscription on close. A hint wakes the idle wait early, so the stream reads the ledger at once. With the bus off, the stream is unchanged.
- **Settings.** `SUBSTRATE_EVENT_BUS` is on or off, default off. Any other value refuses boot. The bus is off, with a logged reason, when `DRAGONFLY_URL` is unset, refused by the endpoint policy, or `SUBSTRATE_CACHE` is 0.
- **Docs.** `docs/data-planes.md`: the "never" list no longer names pub/sub; the cache row says Dragonfly may carry the wake-up hints and holds no authoritative state. A new "Event wake-up hints" subsection. The config reference is regenerated.

## Decisions

- D50-a to D50-i in CONTEXT.md. The bus lives outside `cache.ts`, so the cache's conformance lock is untouched. The ledger remains the source of truth. Hints are wake-ups, never state.

## Deviations (from the plan, with reasons)

- **A client adapter.** The subscriber connects before its first command, because a bare client with offline queueing disabled would reject a command sent before connect (the cache has the same need). The adapter is in `service.ts`.
- **Publisher dropped after a failure.** After a publish failure the publisher client is dropped and rebuilt, so one blip does not silence publishing for the life of the process.
- **Counters through `stats()`.** The bus counts its own publish failures, and the emit only guarantees that it never fails.
- **The bus follows `SUBSTRATE_CACHE=0`.** The plan left this open. Turning the cache off means Dragonfly is not to be used, so the bus is off too, with the reason `SUBSTRATE_CACHE is 0`.
- **A reconnect test is narrowed.** The plan's "a successful reconnect resets the backoff" cannot be observed through this interface, because a subscription that resolves cannot later be reported as dropped. The test now asserts what can be observed: a successful reconnect opens no further clients. The reset is covered by the backoff sequence test.

## Verified in-repo

- Typecheck: `bunx tsc --noEmit` exit 0.
- Targeted: the event bus tests (18), the config tests, and the service, server and flag-registry tests (332) pass.
- Full suite: `bun test` 5987 pass, 2 skip (pre-existing), 0 fail, over 5989 tests in 223 files, after the review fixes.
- Repo locks: `bun run check:phase-close` green. Config reference: regenerated and checked.

## Review round (PR 103)

- **Publish deadline.** `PUBLISH_DEADLINE_MS` is 2000. A publish that does not settle in time counts as a failure and drops the client, so a stalled server cannot pile up commands. A test covers a never-settling publish.
- **Publisher identity.** A failed publish clears and closes the publisher only while it is still the client that publish used, so an old failure cannot close a replacement. A test covers it.
- **Counters visible.** `health().eventBus` reports enabled, published, failed, oversize and malformed. Oversize and malformed drops log once per run. The counters are optional on the bus interface, so injected test fakes type-check; production always has them.
- **Busy-stream wake.** A test holds the first ledger read open, wakes twice, and checks that the second read starts without waiting for the poll interval.

## Limits (recorded, not hidden)

- **Cache invalidation is not hint-driven** (D50-e). Generation counters remain the authority and are already shared through Dragonfly. The goal's invalidation claim is not implemented.
- **Silent drops are not detected.** The interface reports a drop only when the subscribe promise rejects. A subscription that drops silently after it resolved is not seen until the next publish fails.
- **Latency gain is unmeasured.** The stream now wakes on a hint, but no live measurement was taken.

## Cleanup

- The worktree `/root/pr-fix/v150-pubsub` stays until close-out, with the other phase worktrees, after the user approves cleanup.
