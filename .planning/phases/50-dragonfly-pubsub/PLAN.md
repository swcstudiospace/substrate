---
phase: 50-dragonfly-pubsub
requirements: [SOTA-06]
status: planned; U1 and U2 run in parallel against a fixed interface; U3 follows
---

# 50-PLAN: Dragonfly pub/sub for real-time event notifications

## Shared interface (U1 creates it; U2 uses it)

In `packages/mcp-server/src/event-bus.ts`:
- `export interface EventHint { v: 1; id: string; kind: string; surface: string; graph_id: string | null; ts: string }`
- `export interface EventBusClient { publish(channel: string, message: string): Promise<unknown>; subscribe(channel: string, onMessage: (message: string) => void): Promise<unknown>; close(): void }` (the Bun RedisClient in production; a fake in tests)
- `export interface EventBus { publish(hint: EventHint): Promise<boolean>; subscribe(listener: (hint: EventHint) => void): () => void; stop(): void }`
- `export function createEventBus(deps: { url: string; makeClient: (url: string) => EventBusClient; log: (line: string) => void; now: () => number; setTimer: ..., }): EventBus | null` — returns null when the bus is off or the URL is unset. The constant channel is `substrate:v1:events`.

## Units

### U1 — the bus (new module)

Files: `packages/mcp-server/src/event-bus.ts` (new), `packages/mcp-server/src/event-bus.test.ts` (new).

- Implement the interface above. `publish` returns true on success and false on failure; a failure is logged once per failure run and counted, and never throws. A hint whose JSON exceeds 1024 bytes is dropped and counted, not truncated.
- `subscribe` registers a listener; the first listener opens the subscription; the last unsubscribe does not close it. A dropped subscription reconnects with a backoff of 1 s doubling to 30 s, and a successful reconnect resets it.
- A received message that does not parse as an `EventHint` is ignored and counted.
- Tests with a fake client: publish returns true and sends the channel and a JSON hint with no summary or payload key; a publish error returns false and is counted; an oversize hint is dropped; a listener receives a parsed hint and a malformed message is ignored; a dropped subscription reconnects after the backoff and not before; `stop` closes the client; an off or unset URL yields null.

Acceptance: the event-bus tests pass when the orchestrator runs them.

### U2 — wiring: emit publishes, the stream wakes

Files: `packages/mcp-server/src/service.ts` (the emit path and one constructor-time bus creation only), `packages/mcp-server/src/server.ts` (the `/events/stream` loop only), `packages/mcp-server/src/config.ts` (the event bus settings only), `packages/mcp-server/src/flag-registry.ts` (new rows only), `.env.example` (new lines only), and the existing emit and stream test files (find them by grepping for `/events/stream` and `emit(` under `packages/mcp-server/src/*.test.ts`).

- Settings: `SUBSTRATE_EVENT_BUS` (on or off; default off; any other value refuses boot naming the variable). The bus uses the cache endpoint (`DRAGONFLY_URL`) and is off with a logged reason when that URL is unset or refused by the endpoint policy.
- `emit`: after the ledger write succeeds, publish a hint built from the stored event's `id`, `kind`, `surface`, `graph_id` and `ts`. The publish is awaited only for its result, never before the emit returns to the caller: use a fire-and-forget with a catch that counts the failure. The emit's own result is unchanged.
- `/events/stream`: when the bus is on, the stream subscribes for its lifetime, and a hint resolves the current idle wait early so the loop reads the ledger now. The stream unsubscribes when the response closes. With the bus off, the loop is unchanged.
- Tests: with a fake bus, an emit publishes exactly one hint with no summary or payload key; a publish failure does not fail the emit; a stream with a long idle wait is woken by a hint and returns the new event before its idle timeout; with the bus off there is no subscription and no publish.

Acceptance: the wiring tests pass; with the bus off, existing emit and stream replies are unchanged.

### U3 — documentation and generated reference

Files: `docs/data-planes.md` (the statement that Dragonfly must not hold pub/sub, and a new "Event wake-up hints" subsection), `docs/observability.md` (only if it names the stream), `docs/config-reference.md` (regenerated, not hand-edited).

- Revise the pub/sub statement to D50-f. Document the channel, the hint fields, that hints carry no text, that the ledger is authoritative, the reconnect backoff, the drop of oversize hints, and that cache invalidation is not driven by hints.
- Regenerate the config reference and check it.

Acceptance: `config:reference -- --check` passes; the docs describe exactly what the tests pin.

## Orchestrator gates

- `bunx tsc --noEmit` exit 0.
- Full `bun test` against a phase-50 verification database, plus `bun run check:phase-close`.
- `bun run config:reference -- --check` exit 0.
- Records under `.planning/phases/50-dragonfly-pubsub/`.
