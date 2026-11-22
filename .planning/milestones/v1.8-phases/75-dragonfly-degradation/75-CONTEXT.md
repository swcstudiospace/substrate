# Phase 75: DragonflyDB degradation - Context

**Gathered:** 2026-11-01
**Status:** Decisions locked by the orchestrator; facts below verified by reading the worktree at `b1b42f92`.

## Phase boundary
When the cache plane is open or unreachable, reads fall back to the authoritative store without losing state, and admission behaves as declared. Two success criteria (ROADMAP.md, Phase 75): (1) with the cache breaker open, brief and recall return authoritative results, proven by a test; (2) admission under an open breaker follows a declared policy per class (fail open or closed), set in flags.

## Decisions
- **D75-1 (default unchanged):** every new flag defaults to today's behaviour. With nothing set, an open cache breaker behaves exactly as before.
- **D75-2 (admission policy per class):** the admission classes are `read`, `write`, `coordination` (`ADMISSION_CLASSES`, `packages/observability/src/instruments.ts:170`). The cache key classes `budget` and `gen` are not admission classes. Each admission class gets `fail-open` or `fail-closed` through `SUBSTRATE_BUDGET_<CLASS>_BREAKER`.
- **D75-2a (value rule, for these three flags only):** unset or blank is `fail-open`. `fail-open` and `fail-closed` (trimmed, case-insensitive) are the only other values. Any other value throws `ConfigError` in `loadAdmissionSettings` (`packages/mcp-server/src/config.ts:1849`), which `loadConfig` calls unguarded, so boot refuses and names the variable. `SUBSTRATE_BUDGETS` is unchanged and keeps its older fallback to `shadow`.
- **D75-3 (authoritative fallback):** brief and recall never depend on the cache for their answer. A refused cache read falls through to the source.
- **D75-4 (generation keys have no flag):** a generation key the breaker refused is treated as unknown, and reads bypass the cache until a bump of that key lands. A fail-closed policy here would refuse every read during an outage, which is not a declared admission policy, so it is not offered.

## Flags
| Flag | Values | Default | Effect |
| --- | --- | --- | --- |
| `SUBSTRATE_BUDGET_READ_BREAKER` | `fail-open` \| `fail-closed` | `fail-open` | Open cache breaker, `read` class |
| `SUBSTRATE_BUDGET_WRITE_BREAKER` | `fail-open` \| `fail-closed` | `fail-open` | Open cache breaker, `write` class |
| `SUBSTRATE_BUDGET_COORDINATION_BREAKER` | `fail-open` \| `fail-closed` | `fail-open` | Open cache breaker, `coordination` class |

`fail-open` admits and records `bypass` (unchanged). `fail-closed` in `enforce` answers 503 with `{"error":"cache_unavailable","class","retry_after_s"}` and `Retry-After` from the breaker, and records a new decision `refused`. In `shadow` it records `shadow_limited` and never refuses. Only a breaker refusal is policed: a timeout, a connect error or a malformed reply stays `bypass` in every class.

## Verified facts (file:line in the worktree)
- Breaker: `CircuitBreaker` `packages/observability/src/breaker.ts:99`; `BreakerOpenError` `:173`; `callPlane` `:215` (refuses with `BreakerOpenError` before calling `fn`, so no command is sent); `PlaneRegistry` `:331`.
- Cache plane gate: `bunRedis` `packages/mcp-server/src/cache.ts:335`, every command through `callPlane` after a cooldown check; the client is built lazily in `open()`, so a refused command opens no socket.
- Construction: `packages/mcp-server/src/service.ts:1698-1705` builds `ReadThroughCache` with `gate: this.planes.gate("cache")`.
- Brief: `service.ts:2127` `cache.getOrLoad({ klass: "brief", ..., load })`. The live compose is the `load`. A last-good `brief-snapshot` is read (`service.ts:2232-2234`) only after the live path degraded, and only if `snapshotSurvivesForget` confirms it.
- Recall: `service.ts:3208` `recallUncounted` → `cache.getOrLoad({ klass: "memory-search", ... })` at `:3222`, whose `load` is `recallMemories` (Hindsight). The recall-snapshot peek at `:2302` degrades to `cold`. The fan-out loads at `:2364`.
- Every cache read and write helper catches a refusal: `peek` `cache.ts:904`, `peekQuiet` `:935`, `peekMany`, `putEntry`, `put`/`writeKey` `:1003`, `bump` `:844`, `markForget`, `snapshotSurvivesForget` `:881`, `script` `:1032`.
- Generation staleness, in process: a refused `bump` adds the key to `staleGenerations` (`cache.ts:852`), and `getOrLoad` bypasses any key in that set before reading it (`cache.ts:568`). Only a successful bump clears it. The existing test `cache.test.ts:328` ("a failed bump keeps later reads on the source until a bump lands") covers this rule with a failing fake.
- Admission: `Admission.admit` `packages/mcp-server/src/admission.ts` (decision branch `:379`), `isRefusal` `:414`, `admitBatch` `:427`, `budgetBody` `:447`. Enforcement: `server.ts:908` (REST) and `server.ts:2647` (MCP batch), refusal response `sendBudgetRefusal` `server.ts:628`.
- Mode default: `SUBSTRATE_BUDGETS` defaults to `shadow` (`config.ts:1796`), so a refusal is never enforced unless the operator sets `enforce`.
- Config: `loadAdmissionSettings` `config.ts:1794`; breakers parsed by `breakerPolicyOf` `config.ts:1849`.
- Registry: `flag-registry.ts` family `SUBSTRATE_BUDGET_<CLASS>_BREAKER` (members `CLASS_BREAKER_NAMES`, prefix `SUBSTRATE_BUDGET_`), generated into `docs/config-reference.md` (hand-rendered; not yet confirmed against the generator).

## Tests
- `packages/mcp-server/src/cache-breaker.test.ts` (new): brief answered by the index with the cache breaker open; recall equal to the uncached reply; generation keys stay on the source after the breaker closes until a bump lands; admission over the real gated cache (`fail-closed` refused, `fail-open` bypass, no breaker failure recorded for the refusals).
- `packages/mcp-server/src/admission.test.ts`: the policy matrix (default fail-open, enforce refused, shadow `shadow_limited`, non-breaker failure stays `bypass`, batch refusal body); flag parsing (valid values, blank is `fail-open`, invalid value throws `ConfigError` naming the variable and refuses `loadConfig`).
- `packages/mcp-server/src/http.admission.test.ts`: over HTTP, fail-open admits (200) and fail-closed answers 503 with `Retry-After`.
- Default path (nothing set): `admission.test.ts` asserts `loadAdmissionSettings({})` is all `fail-open`; `cache-breaker.test.ts` runs the brief and recall with no flags set; `http.admission.test.ts` "a harness with no cache at all" and the existing "a dead cache admits" cases are unchanged.

## Residual risks and follow-ups
- **R1, cross-process staleness after a refused bump (predates this phase).** `staleGenerations` lives in the writing process. The replica gap exists without this phase's change: after a restart, or on another replica, the generation key still holds its old value, and a cached brief written before the write can be served until its TTL. The bound is the 5-minute brief TTL (`CACHE_TTL["brief"]`, `cache.ts:48`). This phase does not fix it; the tests cover one process only. Follow-up: a durable marker for an unconfirmed bump, or a restart-time generation check.
- **R2, resolved in this phase:** an invalid `_BREAKER` value now refuses boot (D75-2a). `SUBSTRATE_BUDGETS` keeps its silent fallback; that is a separate follow-up if the operator wants it changed.
- **R3, `refused` is not in the admission SLO numerator** (`packages/observability/src/slo.ts:359`), which counts `limited` over `allowed + limited + shadow_limited`. A cache outage is the breaker's signal, not a budget breach.
