---
phase: 06-ledger
checked: 2026-09-26
iteration: 2
checker: gsd-plan-checker (independent; did not write the plans)
plans_checked: [06-01, 06-02, 06-03, 06-04, 06-05, 06-06, 06-07, 06-08, 06-09]
status: passed
blockers: 0
warnings: 1
info: 8
tracking: SPE-3572
---

# Phase 6 (Ledger) plan check, iteration 2

## Verdict

**PASSED: 0 blockers, 1 warning, 8 info.** The planner resolved the iteration-1 blocker (B1) and all six warnings (W1–W6). Of the 15 info items, 11 are closed, 2 remain open as advisories (I11 and I14), and 2 needed no change (I1 and I13). The new early-cutover branch, the smoke-hour gating, the 06-08 → 06-07 reordering, the word-match grep and the `ledger` seam semantics all hold up. The one regression is a WARNING. It comes from the I6 fix and affects one flaky-devnet path in 06-03 Task 2. It does not block execution, but it should be fixed, because a common devnet error can send that path into a gate the executor cannot pass.

## Iteration 1 → resolution

| ID | Iteration-1 finding (short) | Resolution in iteration 2 | Status |
|---|---|---|---|
| B1 | 06-07 T3 required the CLI to import no mcp-server code, which is false once Phases 4 and 5 land | The verify now greps only the lines added since the baseline head: `git diff "$H" -- packages/cli/src/index.ts \| grep -cE '^\+import .*(ledger/src\|greptime\|ledger-verify)'` = 0. It also extracts `cmdVerify` with awk, requires `post("/verify"` inside it, and forbids `fetch(`, `GreptimeClient`, `LedgerVerifier` and `createRpc` there. The action says to leave the Phase 4/5 imports alone. The 06-PATTERNS cli row now lists 05-04's in-process `docs ingest\|search`, and the COVERAGE D-11 row matches. Checked on today's file: the awk extract finds `post("/verify"` once. | Resolved |
| W1 | Static `checkpoint:human-action` in 06-03 stopped even when the airdrop succeeded | 06-03 now has 2 `auto` tasks and no checkpoint task (`autonomous: true`). Task 2's `<precondition>` requires the key's balance to be at least 100 000 000 lamports. That condition fails only when funding failed, and then the executor's precondition-unmet blocking-human checkpoint stops (checkpoints.md:12) with the `user_setup` step. `owner_funding=not_needed\|owner` is recorded. COVERAGE requirement 6 and 06-VALIDATION are updated. | Resolved |
| W2 | The tracer waited for the cutover hour but checked the smoke hour | 06-05 T2 now runs the restart and smoke at minute 01–45, and records `smoke_hour` (the last ingested_at of the smoke graph) and `smoke_hour_equals_cutover_hour`. 06-06 T2 waits until max(cutover hour, smoke hour) + 1 h 5 min, at most 2 h 5 min. When the two hours differ, both are anchored (`anchored_hours ≥ 2`). The live smoke-hour row check stays. | Resolved |
| W3 | No branch for an early cutover in 06-05 T1 | A mismatch against the snapshot now leads to `early_cutover=true` only when two things hold. First, the live schema equals the post-migrate target (ingested_at FIELD timestamp(3); anchors with 11 columns, 0 TAG columns, time index period_start, 0 rows). Second, the service started after the first `(06-04)` commit. The branch then records `ddl_run=skipped_early_cutover`. Any other mismatch stops the plan. The verify has matching `if/else` branches. | Resolved (regression review below) |
| W4 | The stub grep `insertEvent\(` missed property overrides | Both the action and the verify now use `grep -rlwE 'lastHash\|insertEvent' packages/*/src --include=*.ts`. The action names Phase 5's throwing `insertEvent:` override and says how to migrate it. I checked on this host: the word match catches `insertEvent:` and `.insertEvent(` but not `insertEvents:`. Today it lists exactly the 8 expected sites. | Resolved |
| W5 | The `ledger` seam defaulted to a production verifier, so tests depended on the clock or reached the network | The semantics are stated explicitly. With no stores object (production `new Substrate(config)`), the service builds a `LedgerVerifier`. With a stores object, it uses `stores.ledger ?? null`, and null means no anchor check at all. The named test "no ledger seam skips the anchor check" stubs `globalThis.fetch` and asserts 0 calls. No Phase 4 or 5 plan edits `index.ts` (grep), so production keeps the verifier. | Resolved |
| W6 | Nothing checked that Phases 4 and 5 had landed | 06-01 T1's precondition and action gate on 04- and 05-VERIFICATION.md `status: passed`, or on an orchestrator acceptance recorded with a verbatim note. They also require `phase45-symbols=present` (`"skill.propose"`, `"docs.ingest"`, `skills propose`, `docs ingest`), and the verify re-greps those four symbols. See I-a for a small gap. | Resolved |
| I1 | The "no `$`/`%`" rule is broader than necessary | Unchanged. It is safe, and all 7 inline `bun -e` snippets still contain neither character (rescanned). | No change needed |
| I2 | `fixture-graphs=0` could pass | The fails_when list now includes "fixture-graphs is 0". | Resolved |
| I3 | Latency was proven only for server-timed events | The 7-way live burst now includes 3 client-ts events on distinct keys, so the guard's `eventsAtKeys` round runs inside the timed batch. | Resolved |
| I4 | No branch for `multirow_insert_atomic=no` | 06-05 T1's precondition requires `multirow_insert_atomic=yes`. On `no` the plan stops and escalates before any DDL. | Resolved |
| I5 | The curl retry loops broke on 429, RPC errors or null results | Loops now use `curl -sf`, require `.result != null`, and fail through `test -n "$R"`. I checked the loop against devnet with a bogus signature: attempt 1 returned `result:null`, attempt 2 timed out, rc=1. | Resolved |
| I6 | The 1-lamport fallback ran on any non-zero exit | The plan now checks the listing first (a transaction that landed despite the error is adopted), retries 0 lamports once on transient errors, and falls back to 1 lamport only on a simulation or program refusal. | Resolved, but introduces W-a |
| I7 | The re-run could straddle HH:05 | 06-06's precondition keeps the run and the re-run between minute 06 and 55. | Resolved |
| I8 | The 7419 verify-only instance was a second writer | The plan now records `unverified_window_chain_breaks=0`: verifyGlobalChain runs over every hour the instance was alive. | Resolved |
| I9 | 06-07 and 06-08 were in the same wave, so D-14 exposure depended on run order | Reordered: 06-07 now declares `depends_on: ["06-06", "06-08"]` and sits in wave 6. Its precondition requires `first_tick_result=success`. | Resolved |
| I10 | A read at `finalized` could race the row written after `confirmed` | 06-09 T1 retries an `unverified` answer 3 times, 10 s apart. | Resolved |
| I11 | ROADMAP SC1 was not annotated | Still open. The ROADMAP Phase 6 section still carries the original SC1 and "Depends on: Phase 1", and `**Plans**: TBD`. This is the orchestrator's job (CONTEXT L12), and 06-09 records `sc1_rescope=D-01`. | Open (INFO, orchestrator) |
| I12 | No mechanical check that server.ts/mcp.ts were untouched; weak test-count gates | 06-04 T3 and 06-07 T2 now run `git diff --quiet "$H" -- …/server.ts …/mcp.ts` and grep for named tests ("post-cutover interleaved sessions verify as one global hour", "no ledger seam skips the anchor check", "reports the chain failure and the anchor mismatch together"). | Resolved |
| I13 | 10 files in each of 06-02 and 06-04 | Unchanged. The files are src/test pairs, and estimate-check puts both under budget. | No change needed |
| I14 | Live targets are missing from `files_modified` | Unchanged. It is optional, and a manual check still finds no same-wave overlap. | Open (INFO) |
| I15 | The dead-RPC run could meet an empty hour | 06-08 T2 now requires `failure_path_dry_run_hours ≥ 1` first, and otherwise waits for the next window. | Resolved |

## New findings (iteration 2)

| ID | Severity | Plan / task | Issue (evidence) | Required property | Required fix (one route) |
|---|---|---|---|---|---|
| W-a | WARNING | 06-03 T2 (action, `<automated>`); 06-06 T2 precondition | The I6 fix added this branch: when `solana transfer … --output json` exits non-zero but getSignaturesForAddress shows the memo landed, the executor should "use its signature, keep `spike_amount=0` and send nothing more". The next sentence still says "From the successful stdout record `spike_output_json_keys=`". In this branch there is no successful stdout, yet the verify requires `^spike_output_json_keys=.*signature`, and 06-06's precondition stops unless that key contains "signature". "Unable to confirm transaction" after a successful send is a common devnet flake (the research records 15–20 s timeouts), so the branch is plausible. When it happens, the executor must either break the send-once guard to capture the output shape or fail the gate. | Every branch the plan marks as legitimate has a way to satisfy its gates without breaking its own guards. | For the landed-after-error branch, allow a distinct value such as `spike_output_json_keys=unobserved_landed_after_error` in the verify. Then move the output-shape proof to the first real CLI anchor in 06-06: its successful `--output json` stdout feeds parseSignature, and the tracer records the keys. Change 06-06's precondition to accept that value. Alternatively, allow exactly one extra spike send with a new stamp, recorded under `## Failed runs`, whose only purpose is to observe the output keys. |
| I-a | INFO | 06-01 T1 `<automated>` | The verify reads `phase4-verification` and `phase5-verification` only from 06-BASELINE.md. It does not re-read `status:` in 04- and 05-VERIFICATION.md, so a hand-written `passed` would pass. The symbol greps partly cover this. | — | When the value is `passed`, add `grep -qx 'status: passed'` against each VERIFICATION.md. |
| I-b | INFO | 06-05 T1/T2 | Two effects of the `(06-04)` grep. First, the precondition expects "its three commits", but the executor's SUMMARY commit (`docs(06-04): …`) also matches, which makes four, and RESTORE route (1) reverts that commit too. Harmless, but the count wording is inexact. Second, an early restart after 06-04 T2 (new migrate) but before T3 (old emit) is labelled `early_cutover=true` even though the chain has not cut over yet. T2's restart still records genesis correctly. | — | Say "at least its three `feat(06-04)` commits" and grep `feat(06-04)` in the revert route. Rename the key or note the T2-only case under Gaps. |
| I-c | INFO | 06-06 T2 with the early-cutover branch | If an early cutover happened more than 24 h before 06-06 runs, `MAX_HOURS_PER_RUN = 24` means the first run does not reach the smoke hour and the re-run is not a no-op (`rerun_nothing=true` fails). This is unlikely because 06-04 → 06-05 → 06-06 run back to back. | — | In the early-cutover case, allow `cli.ts anchor --max-hours N` with N covering the gap, and record it. |
| I-d | INFO | 06-07 T1/T2 after the reorder | The hourly timer is live during 06-07 and runs `packages/ledger/src/cli.ts` from the working tree. That file imports `mcp-server/src/config.ts`, which 06-07 T1 edits. A tick that fires mid-edit fails, and the next tick retries (fail-closed). Nothing is corrupted, but the anchor for that hour is delayed by an hour. | — | Optionally note this under 06-07 Gaps, or edit config.ts between HH:06 and HH:55. |
| I-e | INFO | 06-04 (single-writer rule) | `packages/mcp-server/src/backfill-run.ts:44` builds `new Substrate(loadConfig())` in a second process. Today it only calls `registerGraph`, which does not emit (checked), so it is not a writer. Any future emit from it would fork the global chain. The chain.ts class comment documents the rule. | — | Optionally mention backfill-run in that comment as a non-emitting constructor. |
| I11 | INFO | ROADMAP | Carried from iteration 1: SC1 is not annotated for D-01, and "Depends on: Phase 1" differs from the plans' order (after Phases 4 and 5). | — | The orchestrator annotates ROADMAP. |
| I14 | INFO | frontmatter | Carried from iteration 1: live targets are not in `files_modified`. | — | Optional. |

## Regression review of the iteration-2 changes

- **Early-cutover branch (06-05 T1).** I found no path that skips DDL wrongly. A migrate that ran only partway (ALTER applied, anchors not re-created) leaves a schema that is neither the snapshot nor the target, so the plan stops, which is conservative. RESTORE route (2) (DROP COLUMN only while no row has ingested_at) cannot be used after an early cutover, but route (1) (revert) still works, and the plan's objective already describes that trade-off. Labelling edge case: I-b.
- **Smoke-hour gating.** The minute window 01–45 in 06-05 T2, the max-of-two-hours wait in 06-06, and the smoke-hour row check agree with one another. A smoke graph that spans two hours is handled: `smoke_hour` is its last hour, and all its hours up to that one are anchored before 06-07.
- **06-08 → 06-07.** The waves are 0:[06-01] 1:[06-02,06-03] 2:[06-04] 3:[06-05] 4:[06-06] 5:[06-08] 6:[06-07] 7:[06-09]. `phase-plan-index 6` returns `conflicts: null`, and the graph is acyclic. Timeline check: 06-06 anchors H at H+1:06+. The timer's first tick at H+2:00 has nothing to anchor, because H+1 closes at H+2:05, and it exits with success. The dead-RPC run at minute 06–58 then finds H+1 waiting. 06-07 runs with the timer live, so hours that close during it are anchored before D-14's 3 h threshold. See I-d.
- **Word-match grep.** The `-w` behaviour was confirmed with GNU grep on this host (see W4). The scope `packages/*/src --include=*.ts` covers mcp-server and every Phase 4 or 5 package source.
- **`ledger` seam.** Production passes no stores object, and no Phase 4 or 5 plan edits `index.ts`, so the anchor check stays on in production. 06-07 T3's live `anchor <smoke_hour> anchored` line would catch a silent loss of the check.
- **Single writer.** Phase 4's `skills propose` and Phase 5's `docs ingest` both emit through `post("/events")` (checked in 04-03 and 05-04), not through an in-process Substrate, so no second IngestChain exists. The 7419 instance is checked by `unverified_window_chain_breaks=0`.

## Checks re-run (read-only, this host)

- `verify.plan-structure`: valid for all 9 plans, 0 errors, 0 warnings. Tasks per plan: 2/3/2/3/2/2/3/2/3.
- All 22 `<automated>` blocks were run as written. Each exits non-zero at its first missing artifact, for the reason its fails_when gives. Examples: 06-01 T1 prints "baseline missing or duplicate phase4-verification", 06-03 T2 prints "spike missing … owner_funding", 06-05 T2 prints "cutover missing … smoke_hour_equals_cutover_hour", and 06-08 T2 prints "smoke missing … failure_path_dry_run_hours". The code-task verifies fail at their first `grep` or at `sed` on the baseline file, which does not exist yet.
- Inline systemd-run `bun -e` snippets: 7, none containing `$` or `%`.
- The 06-07 T3 cmdVerify extraction was run against today's CLI and found `post("/verify"` once.
- The devnet retry loop was exercised read-only (see I5).
- Coverage (SC1 per D-01, SC2, SC3, the D-12 proof, D-01..D-16 and the discretion items) and the safety checklist from iteration 1 still hold. The companion documents are consistent with the new waves and task numbers (06-VALIDATION task map, execution note, COVERAGE rows, 06-PATTERNS cli row).

Nothing live was changed, no commit was made, and no secret was printed.
