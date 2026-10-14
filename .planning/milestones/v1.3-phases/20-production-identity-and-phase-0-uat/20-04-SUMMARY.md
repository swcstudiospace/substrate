---
phase: 20-production-identity-and-phase-0-uat
plan: "04"
subsystem: uat
tags: [phase0-uat, harness-proof, regression-doc, bun-test]

# Dependency graph
requires:
  - phase: 20-production-identity-and-phase-0-uat
    provides: "plan 20-02 resolver bearer, plan 20-03 uat:phase0 package entry and manifest"
  - phase: 16-production-parity-and-rehearsal-harness
    provides: "rehearsal harness, PRODUCTION_PORTS, refuseSmokeUrl, free-port helper"
provides:
  - "Repeatable Phase 0 UAT script (`bun run uat:phase0`) with guards and safe reports"
  - "Notion-rows fixture with placeholder ids"
  - "Regression doc (`docs/uat.md`) for later phases"
  - "Isolated harness proof: scenarios 1, 3, 4, 6, 7, 8 pass with evidence"
  - "Result records: 0-UAT.md (6/2) plus 20-UAT.md evidence links"
affects: [20-06-live-window, later-phase-regression]

# Actuals — pairs with the plan's `estimate` to calibrate future estimates.
actuals:
  tokens: 7200
  tasks: 2
  commits: 1

# Tech tracking
tech-stack:
  added: []
  patterns: [target-classifier-delegating-to-phase16-guard, run-tagged-writes, evidence-only-reports]

key-files:
  created: [scripts/uat-phase0.ts, scripts/uat-phase0.test.ts, scripts/uat/fixtures/notion-rows.json, docs/uat.md, .planning/phases/20-production-identity-and-phase-0-uat/20-UAT.md]
  modified: [.planning/milestones/v1.0-phases/00-brief/0-UAT.md]

key-decisions:
  - "Classifier delegates to refuseSmokeUrl (import, never copy): refused means production"
  - "Scenario 1 registers its probe graph so the chain is verifiable in one run; all writes run-tagged"
  - "Failing scenarios stay failed, never re-scoped; production scenarios live-gated for 20-06"

requirements-completed: [UAT-01, UAT-02, UAT-04]

# Coverage metadata — one entry per shipped deliverable.
coverage:
  - id: D1
    description: "uat-phase0.ts runs any scenario subset against any target with run tags and safe reports"
    requirement: "UAT-02"
    verification:
      - kind: unit
        ref: "scripts/uat-phase0.test.ts (25 pass / 0 fail: classifier, live-guard refusals, parsing, tag format, renderer safety, canned expectations)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Scenario expectations match current surfaces, tools, headers and hook contracts"
    requirement: "UAT-01"
    verification:
      - kind: integration
        ref: "harness proof uat-p20proof2: 6/6 pass with per-scenario evidence"
        status: pass
    human_judgment: false
  - id: D3
    description: "Harness scenarios 1, 3, 4, 6, 7 and 8 pass isolated with evidence recorded"
    requirement: "UAT-04"
    verification:
      - kind: integration
        ref: "/tmp/p20-uat-harness.md (+ .json), 20-UAT.md evidence table"
        status: pass
    human_judgment: false
  - id: D4
    description: "Later phases can reuse the script as a regression check"
    requirement: "UAT-04"
    verification:
      - kind: other
        ref: "docs/uat.md (regression loop, scenario table, live rule, report format)"
        status: pass
    human_judgment: false

# Metrics
duration: single-session
completed: 2026-10-09
status: complete
---

# Phase 20 plan 04: Repeatable Phase 0 UAT Summary

**Eight deferred scenarios become one guarded script: `bun run uat:phase0` with target classification, run-tagged writes, evidence-only reports, and a 6/6 isolated harness proof**

## Performance

- **Duration:** single agent session
- **Started:** 2026-10-09
- **Completed:** 2026-10-09
- **Tasks:** 2
- **Files modified:** 6 (5 created, 1 extended) plus this summary

## Accomplishments

- `scripts/uat-phase0.ts` (869 lines): HTTP+MCP client of the target URL with the resolver bearer, outside the store lock (no store keys/clients); `--scenarios`, `--report`, `--tag`, `--live` flags; `classifyTarget` delegating to Phase 16's `refuseSmokeUrl` (production ports + non-loopback ⇒ production, where writes refuse without a live approval reference); scenario 7 target-independent with its own dead port and accept-and-hang listener; every write run-tagged (`uat-<tag>`) in graph/session/repo; reports carry ids/counts/statuses/booleans/timings only
- Per-scenario expectations per D20-16: tools-list superset of the nine v1.0 names plus four REST routes; healthz/query reads; harness backfill-run over exported rows vs production operator-export reads; installed-plugin fetchBrief with prompt-context header check and no model quota (plugin version+commit recorded); substrate MCP entry config check; Cursor checks plus synthetic-envelope hook runs in a scratch repo matched by surface/kind/repo/since plus the real-session production path; outage bounds for plugin/CLI/hooks; cross-surface brief with run-tagged repo
- `scripts/uat/fixtures/notion-rows.json`: placeholder graph ids (`UAT_FIXTURE_GRAPH_A`) substituted at run time, run-tagged repos, no real identifiers
- `docs/uat.md`: regression loop (rehearsal up → source consumer env → harness set with report path → rehearsal down), per-scenario table per D20-17, production live-reference rule, report format
- Isolated harness proof (run `uat-p20proof2`): `rehearsal up --name p20 --port 0` → twin `http://127.0.0.1:39295`, consumer.env sourced, 6/6 scenarios pass, `rehearsal down --name p20` removed the containers; production stores untouched by construction
- Records: `0-UAT.md` status partial, 6 pass (1,3,4,6,7,8 with D20-16 expected wording and evidence), 2 pending live-gated (2,5), summary 6/2; `20-UAT.md` links the reports with the evidence table and marks production live-gated for 20-06

## Task Commits

1. **Task 1: uat-phase0 script, tests and fixture** — commit `feat(20-04)` (below, with Task 2)
2. **Task 2: Regression doc plus harness proof and result records** — same commit

## Files Created/Modified

- `scripts/uat-phase0.ts` (new), `scripts/uat-phase0.test.ts` (new, 25 pass server-free)
- `scripts/uat/fixtures/notion-rows.json` (new)
- `docs/uat.md` (new)
- `.planning/milestones/v1.0-phases/00-brief/0-UAT.md` — D20-16 expected wording, 6 pass + 2 live-gated, summary 6/2
- `.planning/phases/20-production-identity-and-phase-0-uat/20-UAT.md` (new) — harness evidence rows, production marked live-gated

## Decisions Made

- Classifier goes through the exported `refuseSmokeUrl` guard (plus a re-exported `PRODUCTION_PORTS` reference) rather than re-importing the unexported loopback set: one guard, never a copy; unparseable URLs classify as production (fail-safe direction)
- `runRepo` is owner/name-shaped (`uat/<tag>-repo`) so the post-commit hook's origin-derived repo matches the run repo exactly
- Scenario 1 registers its probe graph (run-tagged) so the register→verify chain is proven in one run
- Scenario 6's synthetic commit uses the hook's real `SUBSTRATE_HOOK_WAIT=1` synchronous mode (already used by the hook's own tests)

## Deviations from Plan

None material. Four implementation choices (above) within the action's latitude; no scope change. One reviewer fix post-handoff: the `source:` frontmatter line of `0-UAT.md` was mangled to a self-reference by an edit slip — restored to the v1.0 ROADMAP path before commit.

## Issues Encountered

- `rehearsal up --name p20` default port collision (17410 already listening — another phase's work) → `--port 0` twin on 39295; no interference either way
- No scenario failed; nothing was re-scoped

## Evidence

- `bun test scripts/uat-phase0.test.ts` → **25 pass, 0 fail, 66 expect() calls**
- Harness proof → exit 0, **6/6 pass** (1,3,4,6,7,8) with per-scenario evidence lines in `/tmp/p20-uat-harness.md` (+ `.json`)
- `rehearsal status --name p20` after teardown → no instance; remaining containers belong to other phases' work
- Report safety: ids/counts/statuses/booleans/timings only — bearer grep over all new files clean, no brief bodies or summaries

## User Setup Required

- Production UAT (scenarios 1, 2, 3, 5, 6, optionally 8) plus the anchors SQL step wait for the operator-approved 20-06 live window — human-gated, NOT done here

## Next Phase Readiness

- Later phases run `docs/uat.md`'s loop as a regression check with no new harness knowledge
- 20-06 artifacts prepared: the script refuses production writes without `--live <approval-ref>`; scenario 7 never touches the target; 20-UAT.md's production section is ready to receive switch evidence

---
*Phase: 20-production-identity-and-phase-0-uat, plan 04*
*Completed: 2026-10-09*
