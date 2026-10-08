---
phase: "12"
slug: "swarm-lease-bridge"
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-07"
audit_mode: retrospective-source-and-test-review
execution_status: parent-verified-postfix
source_commit: "50b3a788c4faf052624aa2855902905b01e9d489"
historical_proof_commit: "5edd55f74ac75c8193dabb057a1d4a5bed0904b5"
source_working_tree: uncommitted-remediation-over-source_commit
---

# Phase 12 — Validation Strategy

> **VALIDATED.** All eight tasks and LEASE-05 through LEASE-09 have source-linked verification. Parent confirmed post-fix p13 full Python **757 passing**, generator current, TypeScript **1 test / 6 assertions passing**, changed-file Ruff passing, and isolated real PostgreSQL/Greptime lease proof **24/24 passing**. Corrections remain uncommitted over the observed base. Direct stale mirrored completion remains an explicit nonblocking coverage limit.

## Scope and provenance

- Inputs read in full: `12-01-PLAN.md`, `12-01-SUMMARY.md`, `12-VERIFICATION.md`, `CONTEXT.md`; requirement wording checked at `.planning/REQUIREMENTS.md:27-31`. The validation/security workflows, auditor roles and report templates under `/root/.agents/gsd-core/` were read. Both gates are enabled by the assignment contract.
- **Source-root drift:** the originally assigned `/root/src/worktrees/agent-swarm-p12` is clean local `main` at observed `840020885ed4bc925fde4a907465caae78e3097d`, a pre-bridge `fix(05)` commit. Its bridge/client/tee modules and named lease/memory tests are absent. It was not silently treated as the shipped Phase 12 implementation, and no branch was changed.
- The integration owner authorized `/root/src/worktrees/agent-swarm-p13` as the current source. Its observed HEAD is `50b3a788c4faf052624aa2855902905b01e9d489`. All source and test references below are relative to that root and refer to the inspected snapshot, before any audit-remediation edits.
- Historical object `5edd55f74ac75c8193dabb057a1d4a5bed0904b5` resolves locally with subject `fix(leases): defer busy reclaims without stopping dispatch`. Its bridge, transport, runner and lease tests were inspected; the p13 differences include handoff additions, not a replacement of the Phase 12 lease core. Phase 13 handoff behavior is not certified here.
- The SUMMARY/VERIFICATION record **688 Python tests**, changed-source Ruff success and **24/24 live checks** on `5edd55f`, followed by merged [agent-swarm PR #9](https://github.com/swcstudiospace/agent-swarm/pull/9), Greptile 5/5 and no open threads. These are historical artifact claims, not executions by this auditor or verification of current remote PR status.
- The retained `/tmp/p12-lease-live-proof.sh` and `/tmp/p12-proof-1791408292/drive.py` were inspected. They exercise two-replica selection, attribution, heartbeat, rework trail/epochs, cancellation, completion, and real 30-second expiry followed by busy reclaim/recovery. `events.json` retains the denied-replica event. The retained event file is not an independent 24/24 test transcript.
- **No tests, builds, linters, formatters, services or smoke commands were run by this report worker.** The parent reports a pre-remediation p14 union suite of 743 passing tests plus generator/TS/changed-Ruff checks; those do not cover the newly discovered missing refusal cases and are not this report's sign-off.

**Reading the audit history:** baseline test catalogs and original gap descriptions preserve discovery provenance; the final remediation/execution sections supersede their missing-code/test descriptions. `source_commit` remains the observed pre-remediation HEAD; fixes are uncommitted working-tree corrections, not part of that commit. Parent execution applies to corrected p13, not automatically to later p14 integration or a release commit.

## Test Infrastructure

| Property | Value |
|---|---|
| Framework | pytest, unpinned in CI; Python 3.12 configured in `.github/workflows/ci.yml:15-22`; Bun root TypeScript contract suite |
| Config file | `pyproject.toml:9-11`, `testpaths = ["tests"]`, `addopts = "-q"`; `package.json:5-7` |
| Quick run command | `python3 -m pytest tests/test_substrate_lease.py tests/test_substrate_tee.py tests/test_swarm_memory.py tests/test_runner_gates.py -q` |
| Full suite command | `python3 -m pytest -q` and `bun test tests/ts` |
| Fixtures | `tests/conftest.py:18-24` isolates Task Store directories; `tests/test_substrate_lease.py:213-247` clears substrate/swarm/proxy environment and resets caches. Fake substrate models clock/CAS/session/holder rules; `queued_fake` retains real slot/deadline transport. |
| Runtime coverage | Lease tests include real child process groups and interrupted gate processes; tee tests include loopback HTTP, redirects, timeouts and body limits. They do not replace the real Postgres/ledger live proof. |
| Measured runtime | Parent's complete post-fix Python/generator/TS/changed-Ruff batch: 94.82 s; isolated lease proof: 34.04 s. Individual quick-command latency was not separately reported. |

## Sampling Rate

- Original plan 12-01 specifies a targeted Python run, full Python suite, root Bun tests, Ruff and live proof. It has no per-task authored wave schedule; **wave 1 below is a retrospective grouping**, not invented execution history.
- For the final remediation batch, the integration owner runs the applicable command set once after all edits land. Do not interleave checks with sibling edits.
- Discovery evidence comprises the traced lookup-refusal bypass and parent-reproduced HTTP403 heartbeat → unanswered; post-fix behavioral regressions passed in the full suite. No claim is made that every new regression was executed against old source.
- No watch-mode command is used. Parent measured the post-fix gate batch at 94.82 s and live proof at 34.04 s; these are actual aggregate durations, not per-test latency estimates.

## Per-Task Verification Map

Command IDs are expanded verbatim in the parent command section. Test catalog references give exact existing function names, not merely filenames.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---|---|---|---|---|---|---|---|---|---|
| 12-01-01 | 01 | 1 (reconstructed) | LEASE-05, LEASE-09 | T-12-01, T-12-02, T-12-03, T-12-04, T-12-11 | Distinguish refusal, busy and outage; retain JSON compatibility and bounded transport | Unit + loopback/transport integration | C12-A; catalog A, C, J; full C12-B includes this scope | Yes in p13; absent in drifted p12 | PASS: corrected consumers and new regressions in parent's 757-test run |
| 12-01-02 | 01 | 1 (reconstructed) | LEASE-05, LEASE-08, LEASE-09 | T-12-01, T-12-10, T-12-12 | Valid replica/session identity; attributable warning/note events without lease secrets | Unit + event integration | C12-A; catalog B, I; full C12-B includes this scope | Yes in p13 | PASS: parent full suite |
| 12-01-03 | 01 | 1 (reconstructed) | LEASE-05, LEASE-06, LEASE-07, LEASE-08, LEASE-09 | T-12-01 through T-12-06, T-12-08, T-12-09 | Claim, TTL/keeper/reclaim, settlement fences, advisory mirror, resumed review and unknown-node registration | Fake-transport integration + concurrency + live proof | C12-A, C12-L; catalog A, C–H | Yes in p13 | PASS: parent full suite + 24/24 live; stated stale-completion branch limit |
| 12-01-04 | 01 | 1 (reconstructed) | LEASE-05, LEASE-06, LEASE-07, LEASE-08, LEASE-09 | T-12-01 through T-12-07, T-12-09 | Claim before CLAIMED; no attempt/slot for denied/refused/busy; watch agents/gates/results; stop groups; off/dry-run no lease calls | Runner/process integration | C12-A, C12-S, C12-L; catalog A–F, H | Yes in p13 | PASS: auth-stop and full-run outage regressions in parent full suite; live proof |
| 12-01-05 | 01 | 1 (reconstructed) | LEASE-07, LEASE-09 | T-12-07, T-12-08, T-12-09 | DONE fenced completion; rework releases then claims; cap settles; interrupted issuer rows never approve target | State-machine integration | C12-A; catalog E, G | Yes in p13 | PASS: parent full suite; direct stale mirrored completion not claimed |
| 12-01-06 | 01 | 1 (reconstructed) | LEASE-07, LEASE-09 | T-12-06, T-12-08, T-12-10 | Manual transition settles mirrored fence only after active writer stops; lease ID omitted from events | CLI + Task Store integration | C12-A; catalog F, I | Yes in p13 | PASS: parent full suite and live cancellation |
| 12-01-07 | 01 | 1 (reconstructed) | LEASE-05, LEASE-06, LEASE-07, LEASE-08, LEASE-09 | T-12-01 through T-12-12 | Tests exercise dispatch, refusal/outage/busy, lost lease, process teardown, rework, expiry race and off paths | Unit/integration/process + live | C12-A, C12-S, C12-L; catalog A–J | Yes in p13 | PASS: new regressions included in 757 tests; live 24/24 |
| 12-01-08 | 01 | 1 (reconstructed) | LEASE-05, LEASE-06, LEASE-07, LEASE-08, LEASE-09 | T-12-01 through T-12-12 | Accurate token/session/outcome/refusal/settlement documentation | Manual source-contract review; behavior cross-check | C12-A checks behavior, not prose; D12 manual review below | Both docs exist in p13 | PASS: corrected prose reviewed against source |

## Requirement-to-Behavior Coverage

All named tests below were located and inspected in the baseline; the parent's corrected-p13 full Python run now supplies fresh passing execution, including the new regressions in the remediation section. Baseline line references are historical coordinates, not assertions of unchanged numbering. `L::name` means `tests/test_substrate_lease.py::name`; `T::name` means `tests/test_substrate_tee.py::name`; `M::name` means `tests/test_swarm_memory.py::name`; `G::name` means `tests/test_runner_gates.py::name`. C12-A and the executed full C12-B collect these tests.

### A. LEASE-05 — authenticated claim before dispatch (tasks 1, 3, 4, 7)

- `L::test_grant_dispatches_with_lease_s_from_the_granted_ttl` (322-345): A05 caller, exact session/claim args, requested 120/granted 90, assignment TTL 90, held review mirror.
- `L::test_denied_claim_leaves_the_task_undispatched` (348-360): still PLANNED, attempt 0, holder visible, denial event; `L::test_a_denied_task_does_not_take_a_parallel_slot` (363-370) admits the next candidate.
- `L::test_refused_claim_is_not_dispatched` (373-382): wrong fallback identity is refused rather than silently unleased. This does **not** cover refused graph lookup before claim (G12-01).
- `L::test_an_unregistered_node_is_registered_as_the_orchestrator_then_claimed` (494-501): one A01 node-only registration and two claim attempts, preserving existing graph edges by omission.
- `L::test_mcp_call_outcome_classifies_and_mcp_call_json_is_unchanged` (1268-1291): HTTP 401/403, 500, MCP refusal/thrown error, malformed response, unreachable, success. The outcome parser is correct; consumers in G12-01/02 lose its refusal distinction.
- Source: `substrate_lease.py:138-180,368-400`; `scripts/swarm_run.py:694-717,732-765`; `substrate_client.py:365-405`.

### B. LEASE-05/08/09 — identity and disabled paths (tasks 2, 4, 7)

- `L::test_replica_and_session_shape` (1247-1253), `L::test_bad_replica_or_ttl_refuses_the_run_at_start` (1237-1244), `L::test_no_bridge_when_off_or_dry_run` (1223-1234), `L::test_mcp_call_outcome_is_off_without_a_url` (1294-1296).
- `T::test_tee_event_fields` (816-827) and `T::test_tee_default_replica_and_optional_ids` (830-837): externally visible session, graph, attribution and payload.
- Source: `substrate_tee.py:25-60,83-88,329-358`; `scripts/swarm_run.py:831-838`.

### C. LEASE-05/06/09 — local saturation is not an outage (tasks 1, 3, 4, 7)

- `L::test_saturated_slots_wait_then_dispatch_with_a_lease` (385-408).
- `L::test_saturated_slots_defer_claim_without_unleased_dispatch` (411-442), both cached/uncached graph cases: no dispatch or lease warning, no negative-cache poisoning/back-off, next attempt reaches actual holder.
- `L::test_busy_mcp_outcome_and_event_contention_never_back_off` (445-461): request slots time out as busy without false outage.
- `L::test_expired_reclaim_defers_local_contention_without_stopping_the_session` (572-600): old watch retained, no stop/back-off, later fresh lease.
- Source: `substrate_client.py:223-259,281-307,402-405`; `substrate_tee.py:249-253`; `substrate_lease.py:157-158,379-382,480-488`. Live driver lines 182-215 exercises actual PostgreSQL expiry plus local contention.

### D. LEASE-06 — heartbeat, reclaim and refusal table (tasks 3, 4, 7)

- `L::test_ttl_is_clamped_and_beaten_every_third` (1256-1260), `L::test_the_fake_expires_on_the_granted_ttl` (666-681), `L::test_heartbeat_extends_and_keeps_the_session` (523-531).
- `L::test_a_refusal_stops_the_session_with_its_tabled_reason` (534-551), parameterized `lost`, `unheld`, `not-holder`; `L::test_expired_reclaims_instead_of_beating_and_the_session_carries_on` (554-569); `L::test_expired_whose_reclaim_is_denied_stops_the_session` (603-612); `L::test_no_answer_keeps_the_session_and_retries_sooner` (615-623).
- `L::test_a_lease_lost_before_the_session_starts_stops_it_on_arrival` (626-633), `L::test_between_rounds_a_lost_lease_is_dropped_and_the_task_left_to_a01` (636-648), `L::test_between_rounds_an_unheld_lease_is_reclaimed` (651-655).
- `L::test_many_held_leases_are_all_renewed_within_a_third_of_the_ttl` (684-715) checks concurrent keeper timing; it is bounded observed-load coverage, not a guarantee for unbounded lease counts/latency.
- `L::test_a_settle_racing_a_reclaim_waits_for_it_and_releases_the_fresh_lease` (718-741) and `L::test_a_fresh_claim_that_cannot_be_installed_is_released` (744-760) cover grant/settle concurrency.
- Source: `substrate_lease.py:25-88,186-198,329-355,436-561`. Generic HTTP auth denial during heartbeat is uncovered and misclassified (G12-02).

### E. LEASE-06/07 — real process groups, gates and interrupted results (tasks 3–5, 7)

- `L::test_the_keeper_stops_a_real_session_whose_node_was_taken` (763-786).
- `L::test_a_stopped_session_is_forgotten_only_once_its_whole_group_is_gone` (806-833): independently piped descendant ignores SIGTERM; group must be gone before forgotten.
- `L::test_a_lease_lost_after_the_session_ends_rejects_its_result` (840-863).
- `L::test_a_lease_lost_while_the_gate_script_runs_stops_it_and_rejects_the_result` (866-904).
- `L::test_interrupted_gate_verdicts_are_not_applied_but_findings_are` (907-969), parameterized signal, shell-signal, shutdown and normal findings exit: committed partial verdicts do not approve the target.
- `L::test_group_spawned_after_shutdown_is_marked_stopped` (972-981).
- `G::test_runner_records_gate_after_session` (117-154) exercises a complete runner/gate flow; `G::test_failed_gate_session_records_no_verdict` (203-214); `G::test_headless_gate_without_rows_fails_attempt` (401-411).
- C12-S additionally runs `tests/test_omp_runtime.py::test_signal_to_runner_group_ends_sessions` (431-461) and `::test_ignored_sighup_keeps_runner_and_session` (464-497). These test inherited signal behavior without a live substrate.
- Source: `scripts/swarm_run.py:306-472,499-527,564-597,720-828,883-924`; `swarm/results.py:335-353`.

### F. LEASE-07 — stop before manual release (tasks 3, 4, 6, 7)

- `L::test_failed_releases` (1039-1051).
- `L::test_cancelled_by_orch_status_releases_the_mirrored_lease` (1054-1066): same producer token and mirrored fence.
- `L::test_cancel_while_a_session_runs_stops_it_before_the_release` (1069-1100): status CLI defers; keeper stops and continues beating; release occurs only after session ends; CANCELLED stands.
- Source: `scripts/orch_status.py:58-70`; `substrate_lease.py:265-288,436-466`; `scripts/swarm_run.py:720-729,803-827`. Missing direct BLOCKED/cap-ESCALATED/stale settlement coverage is G12-03, not a claimed runtime failure.

### G. LEASE-07 — completion, rework and review resume (tasks 3–5, 7)

- `L::test_done_goes_through_graph_complete_fenced_on_the_lease` (985-996) and `L::test_a_restarted_runner_completes_as_the_same_holder` (999-1007).
- `L::test_changes_requested_releases_and_reclaims_and_the_rework_reuses_it` (1010-1036): released old fence, new ID and no extra claim at dispatch.
- `L::test_a_resumed_runner_holds_review_leases_again_and_reworks_through_a_release` (1116-1144) verifies renewal, heartbeat and rework of the resumed producer.
- Source: `substrate_lease.py:201-257,402-418,564-621`; `swarm/results.py:276-298,348-353`; `scripts/swarm_run.py:888-895`. The later `handed_over` method is Phase 13 scope.

### H. LEASE-08 — replicas and dead-holder expiry (tasks 2–4, 7)

- `L::test_two_replicas_racing_for_a_node_dispatch_it_once` (1175-1198): two thread-synchronized stores/replicas, one dispatch and one denial.
- `L::test_a_dead_replicas_node_is_free_to_the_next_claimant_within_one_ttl` (1201-1219): denied at TTL−1, stolen at TTL, no reaper, former holder drops after loss. This is simulated-clock expiry, not a live killed agent process.
- Source: `substrate_tee.py:49-60`; `substrate_lease.py:138-180,468-521`. Server atomicity remains Phase 11's responsibility. The Phase 12 live proof covers the real race; the live kill-under-load takeover belongs to Phase 13/PROOF-02 per `12-VERIFICATION.md:18`.

### I. LEASE-05/07/09 — token and lease-ID disclosure (tasks 1–3, 6–8)

- `L::test_orch_status_keeps_lease_ids_out_of_the_run_log` (1103-1113) checks both `notes_json` and raw serialized notes: CLI/store retain the advisory mirror, log does not.
- `T::test_surface_token_override_wins_and_never_leaks` (314-330); `T::test_redirect_is_not_followed` (274-301); `T::test_bearer_is_unredirected` (236-240).
- Source: `swarm/runlog.py:19-50`; `substrate_tee.py:329-358`; `substrate_client.py:61-69,168-175,287-291`. Phase 14 per-agent env-file loading/child-token stripping is intentionally later, not a missing Phase 12 task.

### J. LEASE-09 — additive store and outage compatibility (tasks 1, 3–8)

- `L::test_unreachable_substrate_dispatches_unleased_and_records_it` (464-491), parameterized transport failure/server error: visible warning/mirror, no claimed grant, successful IN_REVIEW result and budget fallback.
- `T::test_orch_plan_unchanged_when_substrate_unreachable_in_process` (1041-1052), `T::test_orch_plan_unchanged_when_substrate_unreachable_subprocess` (1055-1066), `T::test_runlog_survives_a_dead_substrate` (1032-1037).
- `M::test_mcp_call_json_returns_arrays_and_mcp_call_still_only_objects` (597-601), `M::test_run_start_context_is_empty_when_unavailable` (611-621), `M::test_assignment_prompt_is_fail_open` (676-681), `M::test_assignment_prompt_survives_a_dead_substrate` (684-687).
- Source: bridge mirror writes only through `TaskStore.set_notes` (`substrate_lease.py:239-241`); lifecycle/store data remains in `swarm/taskstore.py:62-85,152-169`; no bridge schema deletion/migration was found. Named tests demonstrate planning, individual dispatch and prompt/log compatibility, not a full non-dry-run outage lifecycle or an exhaustive retained-record comparison (G12-04).

## Initial Wave 0 Requirements and Coverage Gaps

At initial inspection, infrastructure was present but Wave 0 was incomplete because of the gaps below. This table is the discovery record; the remediation table and final evidence section document their resolution and the remaining nonblocking branch limit. This report worker changed no product/test files.

| Gap | Tasks / requirement | Classification | Evidence and required resolution |
|---|---|---|---|
| G12-01 | 1, 3, 4, 7 / LEASE-05, LEASE-09 | HIGH implementation finding; MISSING regression; T-12-02 | `substrate_tee.py:249-261` discards `refused`, caches unbound; `substrate_lease.py:379-386` dispatches UNLEASED. Add an uncached graph_bind 401/403/MCP-refusal scenario, including a refusal first observed by the tee/resume path: no dispatch, no attempt, no false outage/unbound cache. Test `FakeSubstrate.tool_graph_bind` at `tests/test_substrate_lease.py:125-127` ignores identity, so existing green tests cannot catch it. |
| G12-02 | 1, 3, 4, 7 / LEASE-06 | HIGH implementation finding; MISSING regression; T-12-03 | `substrate_lease.py:186-198` treats generic auth refusal as UNANSWERED; only `not-holder` text stops work. Parent confirmed HTTP403 → unanswered by direct current-code reproduction. Add HTTP401/403 and structured identity-refusal cases during a watched lease: stop/reject, preserve another holder, never turn refusal into outage continuation. |
| G12-03 | 3–7 / LEASE-06, LEASE-07 | PARTIAL edge coverage, not a proven implementation bug | Existing named lease tests cover FAILED/CANCELLED and normal DONE/rework, but not direct BLOCKED, rework-cap ESCALATED without handoffs, refused expired reclaim, or stale mirrored completion/release against a successor. Add focused parameterized lifecycle/fencing assertions in the existing lease test module or equivalent parent smoke evidence; do not count a fake server's unexercised branch as coverage. |
| G12-04 | 3–7 / LEASE-09 | PARTIAL end-to-end/provenance coverage | The outage test reaches IN_REVIEW; full successful runner test does not deliberately select an unreachable substrate. Parent must compare an isolated real runner invocation with integration off versus unreachable, through terminal reconciliation, preserving DAG, budgets and existing notes/records except expected advisory lease data. Never use `--dry-run` as outage proof because it disables leasing. |
| G12-05 | 8 / LEASE-05, LEASE-06, LEASE-09 | LOW documentation mismatch | `docs/substrate-leases.md:53` says `decision.ttl_seconds`; actual parser reads top-level `reply.ttl_seconds` (`substrate_lease.py:174-175`). `docs/substrate-tee.md:32-36` says full local slots immediately fail/start outage back-off; source waits within deadline and returns busy without back-off. Correct the docs and review D12. |
| G12-06 | 1–8 / all five | Fresh execution/sign-off pending | Historical 688/24 evidence and parent's earlier p14 743-test union pass cannot certify new missing cases or later remediation. Record the final tested revisions, exact outputs and evidence locations after integration. |

## Manual-Only Verifications

These are explicit proof boundaries, not waivers of uncovered behavior.

| Behavior | Requirement | Why separate | Instructions |
|---|---|---|---|
| Real lease authority and ledger trail | LEASE-05 through LEASE-08 | Fake CAS tests do not prove PostgreSQL/ledger behavior | Parent runs C12-L on isolated :7499 and captures 24/24 plus exact source/server revisions. Verify no production :7410 access. |
| Killed live replica takeover | LEASE-08 | Historical Phase 12 only simulates killed keeper; full live probe belongs to Phase 13 | Cross-reference Phase 13 PROOF-02 evidence; do not relabel the Phase 12 race alone as kill-under-load proof. |
| D12: documentation contract | All five | Prose has no meaningful behavioral test | Compare both docs' identity/session, top-level granted TTL, busy/refused/outage, watch/shutdown, settlement and scope paragraphs against cited source after G12-05 repair. |
| Full non-dry-run outage compatibility | LEASE-09 | Authored during remediation, not present in baseline | Completed by parent's passing full suite: `test_full_non_dry_run_outage_preserves_the_disabled_dag_budgets_and_results` uses real child processes through DONE and compares DAG/budgets/history/results. No dry-run or agent intelligence claim. |

## Exact Parent Commands

Run commands only after the parent-selected integrated worktree contains the intended source and regression fixes. The authorized Phase 12 reference root is `/root/src/worktrees/agent-swarm-p13`; parent may consolidate C12-A/B/S/R into the p14 union run, but must record that worktree's actual revision and pending changes. Do not execute from drifted p12/main and report its old suite as Phase 12 coverage.

**C12-A — original plan's targeted behavioral suite, cwd authorized/integrated swarm root:**

```bash
python3 -m pytest tests/test_substrate_lease.py tests/test_substrate_tee.py tests/test_swarm_memory.py tests/test_runner_gates.py -q
```

**C12-S — real runner signal inheritance/teardown, same cwd:**

```bash
python3 -m pytest tests/test_omp_runtime.py::test_signal_to_runner_group_ends_sessions tests/test_omp_runtime.py::test_ignored_sighup_keeps_runner_and_session -q
```

**C12-B — final full suites, same cwd (one post-integration gate):**

```bash
python3 -m pytest -q
bun test tests/ts
```

**C12-R — original plan's source Ruff scope, same cwd:**

```bash
ruff check swarm scripts
```

**C12-L — retained live proof with corrected swarm root:**

```bash
SWARM_WT=/root/src/worktrees/agent-swarm-p13 SUB_WT=/root/src/worktrees/agent-substrate-p11 PORT=7499 bash /tmp/p12-lease-live-proof.sh
```

Prerequisites: smoke Postgres/GreptimeDB already provisioned, compatible Phase 11 server source, port :7499 unused. Script starts/stops its own isolated smoke MCP child and explicitly refuses :7410; it must not be pointed at production or run concurrently against an occupied port. Do not print credentials or substitute a production database. Parent executed C12-L successfully on the corrected p13 source; the full Python gate included G12-01/02 regressions. The targeted commands remain reproducible references, not additional claimed executions.

## Validation Sign-Off

- [x] Every numbered task and every LEASE-05..09 requirement mapped to code and existing tests or explicit gaps.
- [x] Sampling continuity reconstructed: no three consecutive numbered tasks lack a behavioral verification command; prose task has explicit manual check.
- [x] Existing fixtures/commands identified; no watch-mode flags.
- [x] G12-01/02 fixed, source-reviewed and passing regression evidence reported by parent.
- [x] G12-03 edge additions and G12-04 full outage proof passed; direct stale mirrored completion retained as a nonblocking unexercised branch; G12-05 documentation corrected.
- [x] Fresh corrected-p13 Python/Bun/changed-Ruff and isolated live proof recorded below; no broader Ruff execution claimed.
- [x] Actual aggregate gate/live durations recorded; separate quick-check latency not asserted.
- [x] `wave_0_complete: true`, `nyquist_compliant: true`, `status: validated` set following parent's explicit verified-results closure instruction.

**Approval:** parent-authorized Phase 12 validation closure for the corrected p13 working tree. This is not a ship authorization, a new commit assertion, or proof of the later p14 merge.

## Validation Audit 2026-10-07

| Metric | Result |
|---|---|
| Numbered tasks mapped | 8/8 |
| Requirements mapped | 5/5 |
| Open implementation findings | 0; G12-01/02 closed after parent post-fix execution |
| Other coverage/docs gaps | G12-04/05 closed; G12-03 direct stale mirrored completion retained as nonblocking coverage limit |
| Fresh evidence/sign-off gap | G12-06 closed by parent's 757-test and 24/24 live evidence |
| Tests/product files changed by auditor | None |
| Gates run by auditor | None, delegated to parent explicitly |

## Remediation Source Review — 2026-10-07 (Parent-Verified)

The parent requested source verification after `FixLeaseHandoffSecurity` supplied corrections in `/root/src/worktrees/agent-swarm-p13`. This auditor read the changed source, new behavioral assertions and corrected prose. The base remains observed HEAD `50b3a788c4faf052624aa2855902905b01e9d489`; **the corrections below are uncommitted**, and their current line references supersede the earlier baseline references only for this addendum. Porting to p14 and final gate execution are parent-owned.

| Gap / tasks | Source-review result | Current evidence | Execution status |
|---|---|---|---|
| G12-01 / 1, 3, 4, 7 | Refusal mitigation and negative-cache/recovery regressions verified | `substrate_tee.py:235-272`; `substrate_lease.py:350-354,393-413,419-437`; `claim_node:150-158` also preserves registration refusal. | PASS: parent full Python |
| G12-02 / 1, 3, 4, 7 | Auth-refused heartbeat uses stop/refusal path | `substrate_lease.py:57,190-204,479-525`; new tests inspect stop/loss mirror/no extra claim and real child termination/result rejection. | PASS: parent full Python |
| G12-03 / 3–7 | Lifecycle/reclaim/stale-release assertions verified | `tests/test_substrate_lease.py:688-699,1176-1203`; normal fenced completion remains covered by `test_done_goes_through_graph_complete_fenced_on_the_lease`. **Direct stale mirrored graph_complete is not explicitly exercised.** | PASS for authored cases; nonblocking completion-edge limit retained |
| G12-04 / 3–7 | Full non-dry-run outage comparison verified | `tests/test_substrate_lease.py:1326-1380`: two real-child tasks reach DONE both disabled and in outage; DAG/budgets/attempts/histories/results/events preserved, expected unleased warnings present. | PASS: parent full Python |
| G12-05 / 8 | Corrected and source-reviewed | `docs/substrate-leases.md:53,75,85-86,123`; `docs/substrate-tee.md:29-37`. | PASS: manual source/prose review |
| G12-06 / all | Fresh gate and live proof received | Corrected p13: Python 757; generator current; TS 1/6; changed-Ruff pass; real PG/Greptime proof 24/24 at `/tmp/p12-proof-1791412421`. | PASS: parent evidence |

### Newly Authored Behavioral Tests

All names below were found and assertions inspected in the uncommitted correction. They are not invented proposed test names:

- `tests/test_substrate_lease.py::test_graph_lookup_refusal_never_dispatches_unleased` — HTTP401/403/MCP identity refusal, with and without prior negative cache, nondispatch and recovery.
- `tests/test_substrate_lease.py::test_graph_lookup_without_auth_refusal_still_dispatches_unleased` — genuine unbound/outage/server-error behavior retained.
- `tests/test_substrate_tee.py::test_refused_graph_lookup_keeps_local_logs_and_does_not_cache_the_refusal` — optional tee keeps local logs and recovers with corrected identity.
- `tests/test_substrate_lease.py::test_refused_registration_never_turns_an_unknown_node_into_unleased_work` — dynamic-registration refusal cannot bypass dispatch policy.
- `tests/test_substrate_lease.py::test_auth_refused_heartbeat_stops_dispatch_instead_of_retrying` — all three denial forms stop, mark lost, and do not re-claim.
- `tests/test_substrate_lease.py::test_auth_refusal_kills_the_process_group_and_rejects_its_result` — real keeper/child process is stopped, no IN_REVIEW transition or live tracked child remains.
- `tests/test_substrate_lease.py::test_expired_lease_whose_reclaim_is_refused_stops_dispatch` — expired lease plus explicit denial terminates watch.
- `tests/test_substrate_lease.py::test_blocked_and_rework_cap_escalated_tasks_release_their_held_lease` — state-specific terminal release sends the held fence.
- `tests/test_substrate_lease.py::test_a_stale_mirror_cannot_release_a_successor_lease` — old mirrored fence cannot mutate the successor.
- `tests/test_substrate_lease.py::test_full_non_dry_run_outage_preserves_the_disabled_dag_budgets_and_results` — full runner compatibility, not a dry-run or forwarding-only assertion.

The parent full Python run collected the new regressions above. This focused selection is retained for reproducibility, **not** as a separately executed command and not as a request to rerun a successful gate:

```bash
python3 -m pytest tests/test_substrate_lease.py tests/test_substrate_tee.py -q -k 'graph_lookup_refusal or graph_lookup_without_auth_refusal or refused_graph_lookup or refused_registration or auth_refused_heartbeat or auth_refusal_kills or expired_lease_whose_reclaim_is_refused or blocked_and_rework_cap or stale_mirror or full_non_dry_run_outage'
```

## Fresh Parent Execution and Final Disposition

The integration owner explicitly supplied these post-fix results and instructed formal closure on 2026-10-07. Executor: **Main**, not this report worker. Tested swarm source: `/root/src/worktrees/agent-swarm-p13`, observed base `50b3a788c4faf052624aa2855902905b01e9d489` **plus uncommitted corrections**. There is no new remediation commit to cite.

| Evidence | Observed/reported result | Provenance |
|---|---|---|
| Full Python `python3 -m pytest -q` | **757 passed** (parent counted progress 720 + 37); includes auth-stop and full-outage-DAG regressions | Parent's fresh post-fix gate result supplied directly |
| Generated contracts | Up-to-date | Parent gate result; no separate generator command/output invented |
| `bun test tests/ts` | **1 test passed, 6 assertions** | Parent gate result |
| Changed-file Ruff | All checks passed | Parent gate result; does not assert unreported whole-tree `ruff check swarm scripts` execution |
| Gate batch duration | **94.82 s** | Parent measurement for combined Python/generator/TS/changed-Ruff batch |
| C12-L isolated live proof | **24/24 passed**, actual PostgreSQL/Greptime, **34.04 s** | Parent ran `/tmp/p12-lease-live-proof.sh` with `SWARM_WT=p13`, `SUB_WT=p11`, `PORT=7499`; artifacts `/tmp/p12-proof-1791412421` |

The fresh artifact directory was located by this auditor and contains `drive.py`, `events.json`, `audit.jsonl`, `healthz.json`, `substrate.log` and isolated Task Store files. Their presence is not substituted for the parent's observed passing stdout; the **24/24** claim is explicitly parent-execution provenance.

**Final disposition:** F12-01/F12-02 closed by source mitigation plus fresh passing behavioral evidence; G12-04/05/06 closed. Added G12-03 cases pass; direct stale mirrored completion remains a nonblocking unexercised branch, not a claimed executed scenario or accepted vulnerability. No accepted risks. Later integrated-source changes, gated shipment and milestone archival remain the parent's separate responsibilities.
