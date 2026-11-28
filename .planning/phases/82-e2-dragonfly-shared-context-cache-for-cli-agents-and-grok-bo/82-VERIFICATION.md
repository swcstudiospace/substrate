---
phase: 82-e2-dragonfly-shared-context-cache-for-cli-agents-and-grok-bo
verified: 2026-11-28T07:31:17Z
status: passed
score: 6/6 must-haves verified
covered_files:
  - packages/mcp-server/src/cache.ts
  - packages/mcp-server/src/cache.test.ts
  - packages/mcp-server/src/cache-conformance.test.ts
  - packages/mcp-server/src/fabric/shared-context.ts
  - packages/mcp-server/src/fabric/shared-context.test.ts
  - packages/observability/src/instruments.ts
  - .planning/phases/82-e2-dragonfly-shared-context-cache-for-cli-agents-and-grok-bo/82-PLAN.md
  - .planning/phases/82-e2-dragonfly-shared-context-cache-for-cli-agents-and-grok-bo/82-SUMMARY.md
covered_digest: "v3:sha256:819f56bcccc79a197c9f1c10c9fbe6dfdc74fedee0599a727401d021859c9b36"
decision_coverage: { honored: 5, total: 5, not_honored: [] }
behavior_unverified: 1
behavior_unverified_items:
  - truth: "Lua claim-once and EX expiry behave identically against a live Dragonfly server"
    test: "Point SUBSTRATE_CACHE_URL at a live Dragonfly and run the shared-lane claim + expiry cases over a real socket"
    expected: "Second claim returns lost; key expires at the kind TTL and getOrLoad reloads durably"
    why_human: "Phase doctrine is fake-only tests (no live server in harness); the 1 skipped conformance case (SUBSTRATE_CONFORMANCE_REDIS_URL unset) is the only live path and was skipped here too"
re_verification:
  previous_status: null
  previous_score: null
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 82 Verification: E2 Dragonfly Shared-Context Cache for CLI Agents and Grok Bot

**Verified:** 2026-11-28T07:31:17Z
**Worktree:** `/tmp/agent-substrate-wave8`
**HEAD:** `fca4b068067d0cad1794303d6dfa52a04a897871` (Phase 81 complete; Phase 82 files uncommitted on top, matching `82-SUMMARY.md`'s file list exactly)
**Scope:** Goal-backward verification against `82-CONTEXT.md` + `82-PLAN.md` (3 tasks). Read-only; no product code, STATE, or ROADMAP edits. Loop harness re-run by the verifier (all green; see criterion 6).

## Verdict summary

**Status: `passed`** — all six must-haves hold in code and tests. A `shared` lane on the existing `ReadThroughCache` (namespaced key class, per-kind TTL 60/300/600, Lua claim-once over the existing `eval` seam, tested durable fallback, single gate owner, no second client), with both closed-set parity syncs moved with the class. One behaviour-unverified item: claim/expiry against a live Dragonfly (fake-only doctrine), recorded above.

## Criterion verdicts

| # | Criterion | Verdict | Evidence (file:line at worktree) |
|---|---|---|---|
| 1 | Namespace `substrate:v1:shared:<agent>:<graph>:<kind>:<stable-key>` | **passed** | `fabric/shared-context.ts:13` `SHARED_PREFIX` (`${CACHE_PREFIX}:shared:`, `CACHE_PREFIX = substrate:v1` at `cache.ts:46`); `sharedKey()` `:63` builds, `parseSharedKey()` `:68` exact inverse (4-part split, closed agent/kind checks, `SEGMENT` re-test `:75`); agents `herdr \| claude-code \| grok \| reminiscent` `:16`, kinds `context \| output \| recall` `:20`, segments `[A-Za-z0-9._-]` `:37`, `"-"` agent-global graph `:61`; bad segments throw `TypeError` (`checkSegment` `:39`, `checkAgent` `:46`, `checkKind` `:53`) — programmer error, never a fallback path. `stableSharedKey()` `:80` = hex `sha256(canonical(args))`. `classOf()` names such keys `"shared"` via `CACHE_CLASSES` (`cache.ts:78`); `cache.test.ts:2348` block asserts `classOf("substrate:v1:shared:…") === "shared"` and `sharedx` → `null`. Parity syncs: `packages/observability/src/instruments.ts:101` and `cache-conformance.test.ts:14` both gained `"shared"`. |
| 2 | Per-kind TTL 60/300/600 on every put/claim | **passed** | `SHARED_KIND_TTL = { output: 60, context: 300, recall: 600 }` (`shared-context.ts:26`), `sharedTtlS()` `:29`; every write/claim passes the kind TTL — `put()` `:124`, `getOrLoad` store `:142`, `claim()` `:159`; `claimShared` floor-to-≥1s (`cache.ts:1198`). `CACHE_TTL.shared = 300` (`cache.ts:61`) is only the class ceiling, never a write TTL (confirmed: `grep sharedTtlS` shows all three call sites; no `CACHE_TTL.shared` read in `shared-context.ts`). Lane shape is any JSON round-trippable value. Tests pin `SET` TTLs `[60, 300, 600]` via the store (`shared-context.test.ts`, miss→load→hit case) and raw `FakeRedis.values` key equals the exact namespaced key. |
| 3 | Lua claim-once via `eval`, one round trip, won/lost | **passed** | `SHARED_CLAIM_SCRIPT` (`cache.ts:522`): `exists KEYS[1] → 0; set … EX ARGV[2]; return 1`. `claimShared()` (`cache.ts:1195`) sends it through `script()` (`cache.ts:1213`, the existing `eval` seam, `cache.ts:195`); `1 → "won"`, `0 → "lost"`, `ok: false` (no `EVAL`, timeout, failure — already counted as `error` by `script()`) → `"bypass"`. Store `claim()` (`shared-context.ts:149`) validates `claimId` 1–256 chars (`TypeError` otherwise), slot key = value key + `:claim` (`:85`), counts `claimsWon`/`claimsLost`/`claimBypasses` (`:160-162`). `run()` op union untouched — the `REDIS_OPS` pin `'"get" \| "mget" \| "set" \| "incr" \| "eval"'` (`cache-conformance.test.ts:18,106-108`) passes; no `idempotency:`/`mirror:` token in new code. Claim is advisory: `lost` callers answer from their own durable `load()` and write nothing (tests: won/lost/other-slot, no-`EVAL` bypass, bad `claimId`). |
| 4 | Fallback: gate `unavailable`/`unconfigured` or expired → durable `load()`, never stale, bypass counted | **passed** | `getShared()` (`cache.ts:1150`): cache off → `bypass`+`null` `:1151-1154`; gate blocked → `bypass`+`null` `:1156-1161`; absent/expired → `miss`+`null` `:1166-1169`; malformed envelope → `error`+`bypass` `:1170-1176`; failed command → `fail(…, true, "shared")` `:1179-1182`; never throws. Store `getOrLoad()` (`shared-context.ts:130`): `getShared` first, any null → `await load()` (durable, never stale) `:140`, store only while `gateAllows()` `:142` (a gate-blocked load is never stored). Tests: expired key → `load` again, stale never served (`shared-context.test.ts:175`); gate matrix off/ok/degraded serve, unavailable/unconfigured/no-verdict bypass to `load` with counted `bypass` (`:252`); falsy-hit, cache-off, and failing-server cases. |
| 5 | Gate-aware single owner, no second client | **passed** | `ReadThroughCache.gateAllows()` is public (`cache.ts:600`): `off` → allow without reading the verdict; `enforce` → last DG-1a verdict must be `ok`/`degraded`, `unavailable`/`unconfigured`/no-verdict blocks (`:601-603`). Wired once from `SUBSTRATE_DRAGONFLY_GATE` via `createReadThroughCache` (`cache.ts:515`); re-read per call, never baked into construction. `SharedContextStore` holds no `gateMode` of its own (`grep gateMode shared-context.ts` → only the doc comment at `:106`), so reads, write-skips (`:142`, `:154`) and claims cannot disagree — this was the implementation's self-corrected design (`82-SUMMARY.md:55-57`; gate-matrix tests caught the split-store fallback). Single `new RedisClient` remains in `cache.ts:395` (inside `bunRedis`); `shared-context.ts` imports only types + `canonical` from `cache.ts`. |
| 6 | Loop harness green (tests + tsc + lint, phase-close) | **passed** (verifier re-run) | Verifier re-ran in this worktree 2026-11-28: `bun test fabric/shared-context.test.ts cache.test.ts cache-conformance.test.ts` → **224 pass, 1 skip, 0 fail** (225 tests, 1434 expects, matches `82-SUMMARY.md:47`; the brief's "220/0" was approximate — see Notes); `bun test instruments.test.ts` → 34 pass, 0 fail; `tsc --noEmit -p tsconfig.json` (root) → exit 0; `bun run lint` (biome, 1880 files) → exit 0. `check:phase-close` taken from `82-SUMMARY.md:51` (pass: 239 lock tests, `EVENT_KINDS` 12, `SURFACES` 42) and not re-run — it asserts repo-wide invariants orthogonal to these files and the brief marks it orchestrator-verified. The 1 skip is the pre-existing live loopback redis case (needs `SUBSTRATE_CONFORMANCE_REDIS_URL`). |

## Decision coverage

All five `82-CONTEXT.md` Implementation Decisions are honored:

| Decision | Status | Evidence |
|---|---|---|
| Reuse `ReadThroughCache`; `shared` lane, no second client | honored | `cache.ts:78` class + `:1150/1188/1195` primitives; single `RedisClient` at `cache.ts:395`; `REDIS_OPS` pin intact. |
| Key namespace `substrate:v1:shared:<agent>\|<graph>\|<kind>:<stable-key>`; per-class TTL 60/300/600 | honored | `shared-context.ts:13,26,63,68`; TTLs `60/300/600` on every put/claim (criterion 2); `CACHE_TTL.shared=300` ceiling only (`cache.ts:61`). |
| Lua atomic slot claim via `eval`, single round trip, won/lost | honored | `cache.ts:522` script + `:1195-1202` mapping; store `claim()` `:149`. |
| Fallback: gate `unavailable`/`unconfigured` or expired → durable read; stale never served; `bypasses` counted | honored | Criterion 4; bypass ownership documented at `cache.ts:1148` (counts here, unlike `peek`). |
| Gate-aware: `off` = today; `enforce` blocks serving on non-ok verdict except `degraded` | honored | `gateAllows()` `cache.ts:600-604`; `degraded` serves, tests at `shared-context.test.ts:252`. |

## Gaps

None. The 224-vs-220 count difference between `82-SUMMARY.md` and the assignment brief is harness scope (3 focused files vs the brief's rounded figure), not a discrepancy — both report 0 failures. `covered_digest` is a sha256 over the eight covered files concatenated in listed order (not `gsd_run verification.fingerprint`, which is unavailable in this worktree).

## Notes

- Design correction worth keeping: the first draft gave the store its own `gateMode`; the phase's own gate-matrix tests caught the split (a store built `enforce` over a cache built `off` served what the verdict forbade), and the fix made the cache the single gate owner (`82-SUMMARY.md:55-57`). This is exactly the failure mode criterion 5 guards against, and it is gone from the tree.
- Writes are intentionally not gate-blocked (DG-1b leaves the write path for the probe): an entry written under a blocked gate sits invisible until the gate allows (`cache.ts:1186`, `shared-context.ts:121`). `getOrLoad` still skips the store when the gate blocks (`shared-context.ts:142`), matching the read-through cache's own barred path.
- Consumers (E1 Phase 83, E3 Phase 84) are out of scope as planned; no store wiring into service code exists or is expected in this phase.

_Verified: 2026-11-28T07:31:17Z — Verifier: GSD verifier (subagent), HEAD fca4b068 (uncommitted Phase 82 tree)_
