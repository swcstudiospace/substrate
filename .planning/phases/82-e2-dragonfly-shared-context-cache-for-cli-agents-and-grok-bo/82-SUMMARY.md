# Phase 82: E2 Dragonfly shared-context cache for CLI Agents and Grok Bot — summary

**Status:** Complete. Substrate + tests only; E1 (Phase 83) and E3 (Phase 84) consume the shared keys. No commit (orchestrator verifies).

## What shipped

A `shared` lane on the existing `ReadThroughCache` — one namespaced key class, per-kind TTLs, a Lua claim-once, and a tested durable fallback. No second client, no second connection, no new Redis command.

### Namespace — `substrate:v1:shared:<agent>:<graph>:<kind>:<stable-key>`

- `packages/mcp-server/src/fabric/shared-context.ts:13` `SHARED_PREFIX = substrate:v1:shared:`; `sharedKey()` (`shared-context.ts:63`) builds the full key, `parseSharedKey()` (`shared-context.ts:68`) is its exact inverse. Agents are the closed `herdr | claude-code | grok | reminiscent` (`shared-context.ts:16`), kinds `context | output | recall` (`shared-context.ts:20`), `graph`/`stableKey` are `[A-Za-z0-9._-]` segments (`"-"` is the agent-global graph spelling). Bad segments throw `TypeError` — a programmer error, never a runtime fallback.
- `stableSharedKey(args)` (`shared-context.ts:80`) is hex `sha256(canonical(args))` for callers holding arguments.
- `classOf()` names every such key `"shared"`: `CACHE_CLASSES` gained `"shared"` (`cache.ts:78`), so the lane rides `substrate.cache.operations{class}` and `scripts/cache-stats.ts` with no new accounting. The two closed-set parity syncs moved with it, per the `emb` precedent: `CACHE_METRIC_CLASSES` (`packages/observability/src/instruments.ts:101`, pinned by `cache.test.ts:2185`) and `EXPECTED_CLASSES` (`packages/mcp-server/src/cache-conformance.test.ts:14`, pinned by `cache-conformance.test.ts:75`).

### Per-kind TTL — output 60 s, context 300 s, recall 600 s

- `SHARED_KIND_TTL = { output: 60, context: 300, recall: 600 }` (`shared-context.ts:26`), `sharedTtlS(kind)` (`shared-context.ts:29`). Every `put` and every claim slot carries its kind's TTL (`shared-context.ts:123`, `shared-context.ts:159`); `CACHE_TTL.shared = 300` (`cache.ts:61`) is only the class ceiling, never a write TTL. The lane shape is any JSON round-trippable value (`cache.ts:1412`): context is text, output/recall are objects.

### Lua atomic claim-once — one round trip, won/lost

- `SHARED_CLAIM_SCRIPT` (`cache.ts:522`): `if redis.call("exists", KEYS[1]) == 1 then return 0 end; redis.call("set", KEYS[1], ARGV[1], "EX", ARGV[2]); return 1` — `KEYS[1]` is the slot, `ARGV[1]` the caller's `claimId`, `ARGV[2]` the kind TTL. `ReadThroughCache.claimShared()` (`cache.ts:1195`) sends it through the existing `eval` seam (`cache.ts:195`, `bunRedis` `cache.ts:457`) inside the gated, deadline-bound `run()` — the `run()` op union is untouched, so the conformance pin `'"get" | "mget" | "set" | "incr" | "eval"'` (`cache-conformance.test.ts:104`) still passes.
- `SharedContextStore.claim()` (`shared-context.ts:149`) returns `"won"` / `"lost"` / `"bypass"`; the claim holds the bare `claimId` on the value key plus `:claim` (`shared-context.ts:85`), values stay on the value key as `{ v }` envelopes. `claimId` must be 1–256 chars else `TypeError`. The claim is advisory: a `"lost"` caller answers from its own durable `load()` and writes nothing, so correctness never depends on winning. Claim counters (`claimsWon`/`claimsLost`/`claimBypasses`) are the store's own; hit/miss/bypass/error stay single-owned by the cache primitives (`shared-context.ts:166` `health()`).

### Fallback — gate or expiry answers the durable load, never stale, bypass counted

- `getShared()` (`cache.ts:1150`): cache off → one `bypass`, `null`; gate blocked → one `bypass`, `null` (unlike `peek`, whose caller already counted one — the lane's fallback read is this call, so the bypass belongs here); expired/absent → one `miss`, `null`; malformed envelope → `error` + `bypass`, `null`; failed command → `fail(cause, true)`, `null`. Never throws.
- `SharedContextStore.getOrLoad()` (`shared-context.ts:130`): `getShared` first (gated + counted by the cache), then on any null `await load()` (the durable `request.load()`, never the stale value) and stores with the kind TTL only while `cache.gateAllows()` still holds — a gate-blocked load is never stored, matching the read-through cache's own blocked path (`cache.ts:658`). `get()`/`put()` (`shared-context.ts:116`, `shared-context.ts:123`) are the `peek`/`writeKey` equivalents.
- Gate-aware by construction: `ReadThroughCache.gateAllows()` is public since E2 (`cache.ts:600`) and the cache is the single gate owner — `createReadThroughCache` wires it from `SUBSTRATE_DRAGONFLY_GATE` (`cache.ts:515`), and the store has no gate of its own, so reads, write-skips and claims cannot disagree. `off` behaves exactly as today (no verdict read); under `enforce` the last DG-1a verdict must be `ok` or `degraded` (`degraded` serves), while `unavailable`/`unconfigured` (including no probe yet) bypass to the durable read. Writes are not gate-blocked (DG-1b leaves the write path for the probe), so an entry written under a block is never read back until the gate allows.

## Files

| File | Change |
| --- | --- |
| `.planning/phases/82-…/82-PLAN.md` | 3 tasks (lane, store, tests+summary) |
| `.planning/phases/82-…/82-SUMMARY.md` | This file |
| `packages/mcp-server/src/fabric/shared-context.ts` | New: namespace, TTL map, `SharedContextStore`, factory (174 lines) |
| `packages/mcp-server/src/fabric/shared-context.test.ts` | New: 19 tests, fakes only (368 lines) |
| `packages/mcp-server/src/cache.ts` | `shared` class + `SHARED_CLAIM_SCRIPT` + `getShared`/`putShared`/`claimShared` + public `gateAllows` |
| `packages/mcp-server/src/cache.test.ts` | `FakeRedis` gained TTL expiry + claim-`eval`; new `describe("shared lane")` block, 8 tests (`cache.test.ts:2348`) |
| `packages/observability/src/instruments.ts` | `CACHE_METRIC_CLASSES` + `"shared"` |
| `packages/mcp-server/src/cache-conformance.test.ts` | `EXPECTED_CLASSES` + `"shared"` |

`82-CONTEXT.md` was already present (pre-existing, not written by this phase).

## Verification (loop harness, verbatim)

- `bun test packages/mcp-server/src/fabric/shared-context.test.ts packages/mcp-server/src/cache.test.ts packages/mcp-server/src/cache-conformance.test.ts` — **224 pass, 1 skip, 0 fail** (225 tests; 1434 expects). The 1 skip is the pre-existing live loopback redis case, disabled when `SUBSTRATE_CONFORMANCE_REDIS_URL` is unset.
- `bun test packages/mcp-server/src/fabric/ packages/observability/src/instruments.test.ts` — **150 pass, 0 fail** (7 files, 549 expects).
- `tsc --noEmit -p tsconfig.json` — clean (exit 0).
- `bun run lint` (biome, 1879 files) — clean (exit 0). No formatter run: the repo's `lint` script is lint-only (`package.json:45`), and the phase leaves formatting exactly as written.
- `bun run check:phase-close` — **pass**: 239 lock tests green; `EVENT_KINDS` unchanged at 12 against `ab62c91`; `SURFACES` equals baseline plus `substrate` at 42.

New tests: `fabric/shared-context.test.ts` 19 (namespace build/parse, `TypeError` pins, order-independent `stableSharedKey`, TTL map, miss→load→hit with `SET` TTLs `[60, 300, 600]`, expired→reload never stale, falsy-hit, cache-off, failing-server bypass, gate matrix `off`/`ok`/`degraded`/`unavailable`/`unconfigured`/no-verdict, claim won/lost/other-slot, gate-blocked and no-`EVAL` bypass, bad `claimId`); `cache.test.ts` shared-lane block 8 (classOf, exact-key round-trip, expiry-as-miss, malformed→error+bypass, claim 3×1-each, bypass without `EVAL` + no-command gate block, gate-blocked `getShared`, cache-off). No live server, no real sleep anywhere.

## One design correction during implementation

The first draft gave the store its own `gateMode` alongside the cache's. The gate-matrix tests caught the split: a store built with `enforce` over a cache built `off` served what the verdict forbade. The fix made `ReadThroughCache.gateAllows()` public and deleted the store's gate entirely — the cache is the single gate owner, reads are gated and counted inside `getShared`, and the store only asks the cache before writing or claiming. `82-PLAN.md` Task 2 was corrected to that wording before this summary was written.
