---
phase: 47-forecast-preload
verified: 2026-10-21
status: passed in-repo. Live forecast accuracy and the live Dragonfly warm-up are not exercised
score: 2 of 2 acceptance criteria proven in-repo (predictive rows on /slo; pattern-based preload)
verified_on: gsd/v15-47-forecast on its final tree, based on origin/main f2138e1
covered_files: ["packages/observability/src/forecast.ts", "packages/observability/src/forecast.test.ts", "packages/observability/src/index.ts", "packages/mcp-server/src/metrics-history.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/slo-history.test.ts", "packages/mcp-server/src/preload.ts", "packages/mcp-server/src/preload.test.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/index.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", ".env.example", "docs/observability.md", "docs/data-planes.md", "docs/config-reference.md"]
---

# 47-VERIFICATION: Predictive SLO rows and pattern-based cache preload

## Gates on the final tree

| Check | Command | Result |
|---|---|---|
| Typecheck | `bunx tsc --noEmit` | exit 0 |
| Config reference | `bun run config:reference -- --check` | up to date |
| Targeted | forecast, preload, slo-history (11), brief-recall | pass |
| Full bun suite | `bun test` against `substrate_test_p47`, on the review-fixed tree | 5916 pass, 2 skip, 0 fail (5918 tests, 221 files) |
| Repo locks | `bun run check:phase-close` | pass: 4 lock files green; EVENT_KINDS unchanged at 12; SURFACES unchanged at 27 |

## Acceptance criteria

| Criterion | Evidence in repo | Status |
|---|---|---|
| `/slo` has predictive rows | `forecast` key with one row per objective; statuses predicted-breach, ok, insufficient-data, history-off; the trend and breach arithmetic tested on fixed series; the breached list is identical with and without a predicted breach | Proven in-repo |
| The cache preloads based on patterns | Top-K selection by request count within the hour; repos beyond the window drop out; the 256-repo cap evicts least recent; the switch off starts no timer and no compose; a tick composes exactly the top K with their last surfaces; a failed compose is counted and the next tick runs; stop clears the timer; the warm-up never counts itself | Proven in-repo against fake timers and a fake compose |

## Not proven

- Forecast accuracy on real history. The tests use fixed series.
- The live Dragonfly warm-up effect and its hit-rate change. The tests use fakes.
- The amplification consequence of the surface-as-bearer design under real traffic. It is bounded by K and the interval, and recorded for review.
