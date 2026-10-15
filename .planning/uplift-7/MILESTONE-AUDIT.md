# Milestone audit (uplift-7, 2026-10-15)

Each criterion from the planning spec is graded PASS, FAIL, or WAIVED. WAIVED needs your decision, and none is recorded yet. A row marked "proposed WAIVED" is a request, not a decision. Any unresolved FAIL blocks MILESTONE_COMPLETE, which is not run.

## Milestone

| Criterion | Grade | Evidence |
| --- | --- | --- |
| Every roadmap phase, including appended ones, has CONTEXT, PLAN, and SUMMARY, or is BLOCKED or DEFERRED with a decision request | FAIL | Phases 0 and 0.5 lack SUMMARY and PLAN artifacts (planning inventory). The three workstreams were not appended to ROADMAP.md (default applied; SCOPE_CHANGE pending). |
| Every legacy or archived phase found is listed with its source and disposition | PASS | `.planning/uplift-7/PLANNING-INVENTORY.md`, corrected legacy table (in this PR). The earlier note `LEGACY-DISPOSITION.md` is on PR #70 and is superseded by that table. |
| Each completed phase has STATE.md and ROADMAP.md updates in phase order | FAIL | This run completed no roadmap phase and recorded no STATE or ROADMAP entry for its workstreams. The workstreams are not in ROADMAP.md (SCOPE_CHANGE pending). STATE frontmatter is 18/18 complete; its Session Continuity section is stale at phase 18 (see PLANNING-INVENTORY.md). |
| Each discuss, plan, and execute step ran as its own flat Skill() call, with no nesting | FAIL | The phase loop was not run for the appended workstreams. Work was done directly and by subagents. |
| Each pause is labeled with exactly one PAUSE_POLICY category | PASS | Closeout labels: GREY_AREA (panel host, answered), VALIDATION_REQUEST (SVM go/no-go), EXTERNAL_EFFECT (merges, anchor funding, rotation), SCOPE_CHANGE (appends; DISPUTED items) |
| The audit report grades each criterion; MILESTONE_COMPLETE only with no unresolved FAIL | PASS | This file. MILESTONE_COMPLETE is not run. |
| CLEANUP removed only this run's temp files; archives and legacy material intact | FAIL | Not yet run. Worktrees and temp files remain until PRs 70–72 are merged. |

## Substrate

| Criterion | Grade | Evidence |
| --- | --- | --- |
| HEALTH_REPORT has PASS or NOT_APPLICABLE per category check, or lists each FAIL with a fix or decision | PASS | `.planning/uplift-7/SUBSTRATE-HEALTH.md` lists every FAIL with an action |
| Cross-agent check: a record written by client A is readable by client B, with attribution intact | FAIL | Not run live. The baseline reports visibility PARTIAL (`agent:<surface>` memories are excluded from the brief). |
| Invalid writes are rejected, with nothing partially persisted | FAIL | Shape refusals exist in code; the round-trip check was not run in an isolated namespace |
| A stale concurrent update is rejected or resolved under the documented policy | FAIL | Memory decisions have `expected_version`. Skills and docs do not. |
| With the substrate unavailable, a dependent client finishes degraded; queued writes apply exactly once | FAIL | 503 behavior exists; no queued replay for memory or skills; not tested |
| Each fixed defect has a regression test where a test setup exists | PASS | PR #72 adds three tests (413 with nothing stored; cut to 4000 with flag; no flag under cap). The fix is on the PR branch, not merged. |

## Omp UI

Evidence: PR #70 at `aad5347`. `bun test packages/projector/omp/` 68 pass, including the Greptile regressions. Live read-only check on loopback, 2026-10-15.

| Criterion | Grade | Evidence |
| --- | --- | --- |
| With an observed client and no events in the window, the headline reads NOT_OBSERVED_IN_WINDOW, never IN_USE | PASS | Test "NOT_OBSERVED_IN_WINDOW while omp is unchanged, never IN_USE". Live footer read `NOT_OBSERVED_IN_WINDOW`. |
| A substrate write by an observed client appears in the activity feed within the documented refresh latency | FAIL | The 30-second poll bound is tested (throttle test). The write-to-footer check needs a real write, and the agent makes no production writes. Operator step. |
| A known but uninstrumented client shows NOT_INSTRUMENTED, never inactive | PASS | Live coverage: `codex`, `grok-build`, `opencode`, `pi` are NOT_INSTRUMENTED. Known list is the token file names. |
| With the event source stopped, the panel shows ERROR, last-known data, and a retry control. No zero counts appear for unknown values | PASS | Tests for ERROR with and without a good poll. Live closed-port read: `ERROR (unreachable) · no data yet · /substrate retries`. The retry control is `/substrate`. |
| Credential-like values seeded into test records do not appear in the panel | PASS | Test "a credential-like value in a health record never reaches the summary or the footer". The panel shows counters and names only; it never renders record content. |
| Injected markup in a test record renders as text and does not execute | PASS | The terminal host interprets no markup. Control and bidi-override characters are removed from names (test "control characters in a surface name are not printed"). |
| Every control works with keyboard alone; focus is visible | WAIVED (proposed; decision needed) | The terminal host has no focusable controls. The only control is typing `/substrate`. |
| Status changes are announced without moving focus; reduced motion is honored | WAIVED (proposed; decision needed) | The footer updates in place: no focus move and no animation. The terminal host has no live region, so nothing is announced. |
| Text and status indicators meet WCAG 2.2 AA contrast | WAIVED (proposed; decision needed) | The extension sets no colour; the colours come from the user's terminal theme. WCAG is a web criterion and cannot be measured here. |
| The usage definition is visible on screen | PASS | `/substrate` prints the definition (test "the summary states the usage definition on screen"). |

## SVM and Solana

| Criterion | Grade | Evidence |
| --- | --- | --- |
| The memo answers "could we" directly, with one verdict per hosting option and a recommended path | PASS | `.planning/uplift-7/SOLANA-FEASIBILITY.md` |
| Each claim cites a primary source with an access date, or is marked UNVERIFIED | PASS | Sources S1–S8, dated 2026-10-15, flagged as search excerpts |
| The memo states the ledger role it evaluated and the open question about it | PASS | Anchor role (q2 default); defer option stated |
| A labeled cost estimate with its assumptions | PASS | Validator cost section |
| During the run, no Railway service was created, no networked key was generated, no funds moved, and nothing was pushed to a remote | FAIL | Branches were pushed and PRs opened. The airdrop attempts failed; no funds moved. The pushes were the approved repo PR path; a waiver is needed to record that. |
| The go/no-go recommendation appears as a VALIDATION_REQUEST at closeout | PASS | Closeout report |

## Summary

- Unresolved FAILs: 10 (milestone 4, substrate 4, Omp UI 1, SVM 1). MILESTONE_COMPLETE is blocked.
- Proposed WAIVED, awaiting your decision: 3 (Omp terminal-host accessibility rows).
- Documented gaps, not criteria: the STALE state (needs event times); activity-feed rows and filters (the panel shows counts, not records, and the window is fixed at five minutes); a server-side last-seen value per surface.
- Decisions that clear the FAILs: waive or fix the accessibility rows; decide the appended-phase SCOPE_CHANGE; waive the SVM "nothing pushed" row; accept or schedule the substrate gaps (cross-agent, invalid writes, concurrency, degraded mode); run the write-to-footer check (operator); approve MILESTONE_COMPLETE and CLEANUP.
