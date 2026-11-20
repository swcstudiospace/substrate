---
phase: 47-forecast-preload
verified: 2026-11-12T08:36:05Z
status: human_needed
score: 2/2 must-haves verified in-repo; live proofs human_needed
behavior_unverified: 0
overrides_applied: 0
covered_files: [".env.example", ".planning/milestones/v1.5-phases/47-forecast-preload/PLAN.md", ".planning/milestones/v1.5-phases/47-forecast-preload/SUMMARY.md", "docs/config-reference.md", "docs/data-planes.md", "docs/observability.md", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/metrics-history.ts", "packages/mcp-server/src/preload.test.ts", "packages/mcp-server/src/preload.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/slo-history.test.ts", "packages/observability/src/forecast.test.ts", "packages/observability/src/forecast.ts", "packages/observability/src/index.ts"]
covered_digest: "v3:sha256:0dc8683dd4b34efa4c012d026e0e98e8a541733bdab8620e3a9f5da55d37d007"
human_verification:
  - test: "Run one live warm-up cycle with SUBSTRATE_CACHE_PRELOAD=on against the live Dragonfly, then compare brief cache hit rate before and after."
    expected: "Warmed brief keys are read as hits by a real request; no change to production stores beyond the cache."
    why_human: "Live Dragonfly and operator-gated rollout; tests use fake timers and a fake compose."
  - test: "Check /slo forecast rows against real history over a multi-day window."
    expected: "predicted-breach and ok statuses track observed breaches closely enough to be useful."
    why_human: "Forecast accuracy on real history is not provable from fixed-series unit tests."
---

# 47-VERIFICATION: Predictive SLO rows and pattern-based cache preload

**Phase Goal:** Time-series forecasting predicts SLO burn, and the Dragonfly cache pre-warms from observed patterns.
**Verified:** 2026-11-12T08:36:05Z
**Status:** human_needed
**Re-verification:** No — initial verification of this phase under the GSD verifier (supersedes the 2026-10-21 record, which is left in place as VERIFICATION.md)

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | /slo has predictive rows (ROADMAP SC 1) | ✓ VERIFIED | `packages/mcp-server/src/server.ts:1128-1174` builds one `forecast` row per catalogue objective via `forecastRow`/`forecastHistoryOff`. `packages/observability/src/forecast.ts:54,82-94` holds `holtForecast` and `forecastRow` with statuses `predicted-breach`/`ok`/`insufficient-data`. `forecast.test.ts` (linear slope, rising breach, flat ok, <12 points, NaN/empty) and `slo-history.test.ts` "/slo.forecast > one row per objective; history off ... never folds into breached" pass. |
| 2 | Cache preloads based on patterns (ROADMAP SC 2) | ✓ VERIFIED | `packages/mcp-server/src/preload.ts:23,49,155,195` (cap 256, `RepoAccess`, `startPreloader`, unref'd timer). `preload.test.ts` covers top-K order, sliding hour, cap eviction, switch-off no timer/no compose, tick composes exactly top K, failure counted and next tick runs, overlap guard, stop idempotent. `service.ts:3895-3906` `startRecall` → `startPreload`; `index.ts:196,238` start/stop wiring. 43 targeted tests pass (see Behavioral Spot-Checks). |
| 3 | Preload settings are parsed with bounds and refuse bad values at boot | ✓ VERIFIED | `config.ts:1629-1666` (`TOP` 1..20, `_S` 10..3600, mode on/off, `ConfigError` naming variable); `config.ts:1130` refuses on-with-no-cache. `preload.test.ts` config block passes. |
| 4 | Forecast never changes `breached` | ✓ VERIFIED | Pinned by `slo-history.test.ts` "/slo.forecast" test (passes). |

**Score:** 2/2 ROADMAP success criteria verified in-repo (4 supporting truths verified, 0 behavior-unverified). Live proofs remain human_needed.

### Deferred Items

None.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/observability/src/forecast.ts` | Holt forecast + row statuses | ✓ VERIFIED | 100 lines; exports present; tested |
| `packages/mcp-server/src/preload.ts` | RepoAccess + startPreloader | ✓ VERIFIED | 206 lines; tested |
| `packages/mcp-server/src/server.ts` | /slo forecast key | ✓ VERIFIED | `forecast` built at 1128-1174, returned at 1174 |
| `packages/mcp-server/src/config.ts` | preload settings | ✓ VERIFIED | 1629-1666 |
| `packages/mcp-server/src/cache.ts` | `refresh` option on getOrLoad | ✓ VERIFIED | `refresh?: boolean` at line 569 |
| `docs/config-reference.md` | regenerated | ✓ VERIFIED | `bun scripts/config-reference.ts --check` → "up to date" |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| server.ts `/slo` | forecast.ts `forecastRow` | import + call | ✓ WIRED | server.ts:55, 1147-1148 |
| service.ts `startRecall` | preload.ts `startPreloader` | `startPreload()` | ✓ WIRED | service.ts:254, 3896, 3906 |
| index.ts shutdown | service `stopPreload` | call | ✓ WIRED | index.ts:238 |
| config.ts preload settings | preload.ts | config object | ✓ WIRED | config.ts:1665-1666 consumed by preloader |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| /slo `forecast` | `read.values` | metrics-history reader (same as /slo/history) | Yes (history on); `history-off` row when off | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Forecast arithmetic and statuses | `bun test packages/observability/src/forecast.test.ts packages/mcp-server/src/preload.test.ts packages/mcp-server/src/slo-history.test.ts` | 43 pass, 0 fail | ✓ PASS |
| Brief path unchanged by refresh/preload refactor | `bun test packages/mcp-server/src/brief-recall.test.ts` | 149 pass, 0 fail | ✓ PASS |
| Config reference in sync | `bun run config:reference -- --check` | "config reference: up to date" | ✓ PASS |

### Probe Execution

No probe scripts declared or conventional for this phase (`scripts/*/tests/probe-*.sh` not found for this phase). Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| SOTA-03 | 47-PLAN.md | GreptimeDB + Dragonfly Predictive Analytics & Cache: /slo has predictive rows; cache preloads based on patterns | ✓ SATISFIED in repo; live proof open | Truths 1-4 above; REQUIREMENTS.md records live proof operator-gated |

No orphaned requirements for Phase 47.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| — | — | No TBD/FIXME/XXX markers in forecast.ts, preload.ts, metrics-history.ts, config.ts, cache.ts, docs changed by the phase | — | None |

### Known limitations (documented by the phase, not gaps)

- Holt treats gapped buckets as evenly spaced (SUMMARY review point; documented).
- `lease.steal_rate` and `quarantine.rate` have no history series and are always `insufficient-data` (documented).
- Surface-as-bearer warm-up is a bounded amplification of caller-visible traffic (documented in data-planes.md).

### Human Verification Required

See frontmatter `human_verification` (live Dragonfly warm-up effect; forecast accuracy on real history). Both are operator-gated and were not run here.

### Gaps Summary

No gaps. Both ROADMAP success criteria are met in the repository. Status is `human_needed` only because the live warm-up effect and forecast accuracy on real history are operator-gated and were not exercised.

### Not run

- Full `bun test` suite and `bunx tsc --noEmit` (not re-run here; the SUMMARY reports them green on the review-fixed tree).
- Any live Postgres/Dragonfly check (127.0.0.1:5432 refuses TCP; not attempted).

---

_Verified: 2026-11-12T08:36:05Z_
_Verifier: Claude (gsd-verifier)_
