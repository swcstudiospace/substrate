---
phase: "13"
slug: signed-handoffs
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-07"
audit_mode: retrospective-source-review
execution_status: passed-parent-gates-and-live-proof
source_commit: ce1334294260224ac0d08c97a60d0c3200ff0a3f
---

# Phase 13 — Validation Strategy

> Retrospective validation contract for HAND-01, HAND-02, HAND-03 and PROOF-02. **Validated and Nyquist-compliant** after source-reviewed remediation, the parent's 757-test full suite and fresh 49/49 real-server proof.

**Final status:** G13-01..04 are resolved. Verified source is `ce1334294260224ac0d08c97a60d0c3200ff0a3f`. Earlier maps/findings and intermediate pending entries below are chronological baseline evidence, preserving original line numbers; the **Final Closure** section supersedes their former pending/partial status. No risk acceptance or full LLM-run claim is made.

## Scope and provenance

- Source root: `/root/src/worktrees/agent-swarm-p13`; `git rev-parse HEAD` observed `50b3a788c4faf052624aa2855902905b01e9d489`.
- Read the complete `13-01-PLAN.md` and `13-01-SUMMARY.md`, plus `13-VERIFICATION.md`. The plan has nine numbered tasks, one plan, no authored wave numbers and no threat model. All rows below use wave `not authored`; no execution ordering is invented.
- Both gates are enabled by the assignment. This report follows the validate-phase workflow, Nyquist auditor role and VALIDATION template. The report-only constraint forbids test creation/execution, builds, lint, formatting and live service activity in this audit.
- Source/test citations below are relative to the source root. Evidence is static unless explicitly marked historical. No product or test files were modified.

## Test Infrastructure

| Property | Value |
|---|---|
| Framework | Python pytest; Bun test runner for the existing TypeScript regressions. Installed versions were not queried. |
| Config file | `pyproject.toml:9-11`: `testpaths = ["tests"]`, `addopts = "-q"` |
| Quick run command | `python3 -m pytest tests/test_substrate_handoff.py -q` |
| Phase integration command | `python3 -m pytest tests/test_substrate_handoff.py tests/test_substrate_lease.py tests/test_substrate_tee.py tests/test_runner_gates.py tests/test_swarm_memory.py -q` |
| Full suite command | `python3 -m pytest -q` |
| Other plan gates | `bun test tests/ts`; `ruff check swarm scripts tests/test_substrate_handoff.py` |
| Runtime | Not measured here. Live takeover proof necessarily includes a 35-second pre-kill hold and up to one 30-second TTL plus harness overhead. |

## Sampling Rate

The historical per-commit feedback cadence cannot be reconstructed from a summary. For the resumed milestone, the parent runs consolidated gates once after sibling edits land; this worker does not run intermediate checks. Run the phase integration command before sign-off and the full plan gates before ship. All nine tasks have an automated behavioral route or an explicit documentation/manual route; the map does not claim every route has fresh green evidence. No watch flags are used. Feedback latency is unmeasured, not asserted under an arbitrary threshold.

## Per-Task Verification Map

`H` below is `tests/test_substrate_handoff.py`. Exact test names appear in the catalogue immediately below. Commands run from the source root. All named existing files were read; `pending` means no fresh execution in this audit.

| Task ID | Plan / wave | Requirement | Threat Ref | Secure behavior / source evidence | Test type / exact automated command | File exists | Status |
|---|---|---|---|---|---|---|---|
| 13-01-01 | 01 / not authored | HAND-01 | T-13-01 | `own_token` strips the per-surface value; `_token` retains the pre-existing general fallback (`swarm/substrate_client.py:61-69`); the sending guard prevents that fallback for handoffs. | `python3 -m pytest tests/test_substrate_tee.py -q -k 'surface_token'` and H02 | yes | Historical coverage; pending |
| 13-01-02 | 01 / not authored | HAND-01, PROOF-02 | T-13-01, T-13-04 | `has_own_token` seam at `swarm/substrate_lease.py:130-134`; `handed_over` drops the held lease and mirrors released/handover at `597-604`. | `python3 -m pytest tests/test_substrate_handoff.py -q -k 'sender_without or rework_cap'` (H02, H07) | yes | Partial: G13-01 race not covered |
| 13-01-03 | 01 / not authored | HAND-01, HAND-02, HAND-03 | T-13-01..08 | Packet builder/fit `swarm/substrate_handoff.py:141-161`; A14/A01 routing `164-173`; sender guard/dedupe/storage `260-314`; boundaries `323-400`; two-read reconstruction and trust `436-500`. | `python3 -m pytest tests/test_substrate_handoff.py -q` (H01-H17) | yes | Partial: G13-01..04 |
| 13-01-04 | 01 / not authored | HAND-01, HAND-03 | T-13-06, T-13-08 | Four `handoff.*` kinds map to `warning` in `swarm/substrate_tee.py:90-93`; unsigned, refused, unsent and misattribution emission paths inspected. | `python3 -m pytest tests/test_substrate_handoff.py -q -k 'token_configured or no_handoff_key or unreachable_substrate or refused_packet'` (H03, H12, H14, H16); existing tee suite also checks emitted-type mappings. | yes | Emission covered; real ledger kind checked by source/history, fresh pending |
| 13-01-05 | 01 / not authored | HAND-01, PROOF-02 | T-13-04 | `swarm/results.py:278-298` captures verified verdicts before transition, hands failing findings to producer and attempts escalation before explicit settle. Keeper interleaving remains unprotected. | `python3 -m pytest tests/test_substrate_handoff.py -q -k 'failing_gate or rework_cap'` (H06, H07) | yes | Partial: G13-01 |
| 13-01-06 | 01 / not authored | HAND-01, HAND-02, HAND-03 | T-13-01, T-13-06, T-13-08 | `scripts/swarm_run.py:673-690` max-attempt escalation; `750-755` sends before prompt; `841-846` bridge only with leases; `895-898,925-927` per-round/final flush; prompt insertion `144-145`. | `python3 -m pytest tests/test_substrate_handoff.py -q -k 'out_of_attempts or no_handoff_key or unreachable_substrate or no_handoffs'` (H08, H12, H14, H17) | yes | Historical coverage; pending |
| 13-01-07 | 01 / not authored | HAND-01, HAND-02, HAND-03, PROOF-02 | T-13-01..08 | Behavioral assertions use a fake transport/server; H09 deletes/moves local state and guards file/sqlite opens; real server proof is separate. | Phase integration command above; exact H01-H17 catalogue below | yes | Partial coverage; no newly executed tests |
| 13-01-08 | 01 / not authored | HAND-01, HAND-02, HAND-03, PROOF-02 | T-13-01..08 | `docs/substrate-handoffs.md:21-163` boundaries, fields, identity, fail-open/recovery/limits; `docs/substrate-leases.md:38-41,57,190-192` seam and handover; `docs/substrate-tee.md:122-125,195-198` warning table and S2 scope. | Manual source-to-document contract review; no invented prose test | yes | Reviewed; G13-01 qualifies success-path release claim |
| 13-01-09 | 01 / not authored | PROOF-02, HAND-01, HAND-02 | T-13-02, T-13-04, T-13-05, T-13-07 | `/tmp/p13-proof.sh` and retained receiver/driver code use real substrate + Postgres + GreptimeDB, kill a live holder, then rebuild with unavailable local state. | `SUB_WT=/root/src/worktrees/agent-substrate-v12 SWARM_WT=/root/src/worktrees/agent-swarm-p13 PORT=7499 bash /tmp/p13-proof.sh` (isolated prerequisites required; parent only) | yes, temporary external harness | Historical 49 checks reported; fresh pending |

## Exact Existing Test Catalogue

All H tests are selected directly with `python3 -m pytest tests/test_substrate_handoff.py::<name> -q`.

| Ref | Exact test name | Evidence and requirement |
|---|---|---|
| H01 | `test_each_boundary_is_written_by_its_sender_and_a05_cannot_sign_as_a14` | `H:216-234`: exact four sender/receiver pairs; no sender argument; sender relabelling invalidates signature. HAND-01. |
| H02 | `test_a_sender_without_its_own_token_writes_nothing_rather_than_writing_as_the_runner` | `237-249`: A01 fallback exists but zero handoff calls; refusal, no retry. HAND-01. |
| H03 | `test_a_token_configured_under_another_agents_name_is_reported` | `252-262`: server's actual identity preserved, misattribution warning. HAND-01. |
| H04 | `test_a_dependency_packet_carries_the_receivers_dod_from_acceptance_and_the_upstreams_files` | `266-290`: goal, files, DoD, blockers, graph, receiving node, both sessions, key, summary; no lease on dependency. HAND-01/02. |
| H05 | `test_a_same_agent_dependency_is_not_a_boundary` | `293-299`: no packet on same-agent edge. HAND-01. |
| H06 | `test_a_failing_gate_hands_its_findings_to_the_producer` | `302-308`: distinct rework keys, findings/blockers, DoD, files. HAND-01. |
| H07 | `test_the_rework_cap_hands_the_lease_over_with_the_packet` | `311-326`: packet then release, no second release, lease id absent, released/handover mirror and A14 claim. HAND-01/PROOF-02; no concurrent keeper. |
| H08 | `test_a_task_out_of_attempts_is_handed_to_a01` | `329-342`: max-attempt escalation A05→A01 and failure blocker. HAND-01. |
| H09 | `test_a14_rebuilds_the_patch_from_the_handoff_list_and_the_event_query_alone` | `346-378`: state unavailable, TaskStore constructor fails, audit hook sees no local opens, exactly two calls as A14, reconstructed values and chronology. HAND-02. |
| H10 | `test_a_packet_that_does_not_verify_is_listed_but_never_shapes_the_context` | `381-387`: tampered sender rejected; prior usable goal/blockers retained. HAND-02. |
| H11 | `test_an_unanswered_ledger_rebuilds_nothing` | `390-393`: unreachable ledger yields no invented context. HAND-02. |
| H12 | `test_with_no_handoff_key_packets_are_unsigned_say_so_and_the_run_completes` | `397-426`: complete `swarm_run.run`, DONE×2, signature null, once-only warning, UNSIGNED prompt; headless agent is stubbed. HAND-03. |
| H13 | `test_a_rerun_writes_no_second_packet_for_one_boundary` | `430-444`: same-process and restarted dedupe; another surface quoting the key cannot suppress genuine sender. HAND-01; no rejected-verdict dedupe case. |
| H14 | `test_an_unreachable_substrate_warns_lets_the_task_run_and_sends_later` | `448-477`: real runner dispatch path with stubbed agent, warning once, later flush stores. HAND-01/03. |
| H15 | `test_a_packet_the_ledger_did_not_store_is_retried` | `480-490`: stored:false dependency later retries successfully. HAND-01; does not exercise held escalation failure. |
| H16 | `test_a_refused_packet_is_recorded_and_not_retried` | `493-503`: refusal is visible and not queued. HAND-01. |
| H17 | `test_no_handoffs_without_leases` | `507-509`: bridge disabled without lease integration. HAND-01/03. |

Additional exact existing tests:

- `tests/test_substrate_tee.py::test_surface_token_falls_back_when_unset_or_blank` (parameterized None/empty/whitespace, lines 304-311) and `::test_surface_token_override_wins_and_never_leaks` (314-330) cover task 1's unchanged general-client fallback and token non-disclosure.
- `tests/test_substrate_lease.py::test_two_replicas_racing_for_a_node_dispatch_it_once` (1175-1198) and `::test_a_dead_replicas_node_is_free_to_the_next_claimant_within_one_ttl` (1201-1219) cover fake-clock mutual exclusion, 29-second denial, 30-second stolen grant, warning and old-holder loss. These do not substitute for SIGKILL under load against the real server.
- `tests/test_substrate_lease.py::test_many_held_leases_are_all_renewed_within_a_third_of_the_ttl`, `::test_a_settle_racing_a_reclaim_waits_for_it_and_releases_the_fresh_lease`, and `::test_the_keeper_stops_a_real_session_whose_node_was_taken` cover Phase 12 keeper regressions reused by the proof, not the new handoff/keeper race.

## Requirement Coverage and Open Gaps

| Requirement | Numbered tasks | Assessment |
|---|---|---|
| HAND-01 | 1,2,3,4,5,6,7,8,9 | Normal boundaries and sender identity have direct assertions; PARTIAL for G13-01/02/03 and failure coverage G13-04. |
| HAND-02 | 3,6,7,8,9 | Direct ledger-only, rejected-packet and unavailable-ledger coverage exists; fresh green execution pending. |
| HAND-03 | 3,4,6,7,8 | Stubbed-agent full runner completion is covered; unsigned is explicitly unauthenticated, not verified. Fresh execution pending. |
| PROOF-02 | 2,5,7,8,9 | Historical live evidence plus real proof harness and fake-clock regression; concurrent handover-order gap G13-01 remains. |

| Gap | Classification | Evidence / required action |
|---|---|---|
| G13-01 | ESCALATED implementation finding; high security T-13-04, static trace, runtime reproduction pending | `swarm/results.py:282-291` commits ESCALATED before network handoff. Active keeper `swarm/substrate_lease.py:40,445-454` treats ESCALATED as releasable and calls settle when no dispatch is watched. `settle:569-592` releases; handoff code does not share that task lock across transition/storage. [INFERENCE] A heartbeat interleaving can free the node before the packet is stored, even when storage later succeeds. H07 never starts a keeper. Parent must pause `coord_handoff`, run `beat(task_id)` while escalation is in flight, assert no release before durable handoff, and fix ordering if reproduced. |
| G13-02 | ESCALATED implementation finding; medium T-13-03 | `_ledger_keys` at `swarm/substrate_handoff.py:222-228` ignores `entry.verdict` when installing sender/key marks, while reconstruction rejects bad signatures at `465`. [INFERENCE] A rejected packet whose sender/key has been tampered can suppress the genuine packet after restart. H13 covers another *untampered* surface only. Add a rejected-verdict sender/key spoof regression; unsigned/no-keys remains a distinct allowed mode. |
| G13-03 | PARTIAL boundary-size coverage | Builder `swarm/substrate_handoff.py:146-160` counts the goal/lists/body but excludes actual key, envelope and session byte sizes; task IDs are not bounded in `swarm/taskstore.py:152-167`. No boundary-size test appears among H01-H17. Parent should exercise long identifiers, multibyte fields and all list limits against final packet fitting, ensuring the first-line dedupe key survives and the claimed <9 kB packet bound holds. This is an unverified bound, not a claimed executed failure. |
| G13-04 | PARTIAL failure-path coverage / documented scope | H15 uses a dependency without a held lease. `_unsent:235` clears the handover lease and `results.py:290-291` explicitly settles after unsuccessful escalation, per `docs/substrate-handoffs.md:76-79,104,162-163`. Add held-escalation stored:false/refused/unreachable coverage to distinguish successful store-before-release from the intentional fail-open fallback. Pending packets are not durable across process exit; persistence was expressly out of scope. |

### Wave 0 Requirements

Existing infrastructure and files exist; no installation or test stubs are needed. Before compliance can become true, the parent must reproduce/remediate G13-01 and G13-02, resolve the packet-size verification gap, exercise the held-escalation failure path, then record fresh gate results. Suggested new regression scenarios above are not falsely presented as existing executable node IDs. No tests were generated under this report-only assignment.

## Historical Proof Provenance

- `13-01-SUMMARY.md:51-55` and `13-VERIFICATION.md:29-30` report the final full Python suite as **705 passing** and live proof as **49/49** (34 driver checks + 15 receiver checks), against merged Phase 11 substrate `1791393` on loopback `:7496`, real Postgres and GreptimeDB, artifact directory `/tmp/p13-proof-1791408817`.
- They report a **25.3-second** takeover after SIGKILL under a **30-second TTL**, r1→r2 only, epoch +1, no overlapping holds and one `warning`. These numbers are historical artifact claims, not freshly measured here.
- The final artifact directory exists and contains `drive.py`, `a14.py`, `r1.py`, `events.json`, health/server artifacts and moved-away swarm state. The driver asserts timeout at TTL+1 second polling slack (`drive.py:171-172`), and its hold comparison allows 0.5-second measurement tolerance (`188-189`). Do not turn those harness tolerances into a new guarantee; the reported final 25.3-second result itself is under 30 seconds.
- Retained `/tmp/p13-proof3.out` is an **earlier**, different successful run: artifact suffix `1791406169`, takeover **25.5 seconds**, receiver 15/0 and driver 34/0. It must not be cited as the final 25.3-second transcript. The three located `.out` files do not contain the final bundle's ID; final total/timing remain sourced to SUMMARY/VERIFICATION.
- SUMMARY says the handoff file has 18 cases; current static source has **17 named test functions** listed above. Collection was not run, so this report does not silently reassert the historical case count.
- Earlier proof against the wrong/older server failed, recorded in `/tmp/p13-proof.out`; SUMMARY acknowledges the mismatch. Do not count that attempt as evidence for success or rerun solely to reconfirm a known failure.
- Live proof uses the actual runner dispatch/reconcile path but stubs the agent CLI (`drive.py:228-233`). H12 also stubs the headless session. **No full LLM run, NATS broker exercise or adversarial same-OS-account isolation proof is claimed.**

## Parent Commands and Manual-Only Verifications

Run from `/root/src/worktrees/agent-swarm-p13`, after integration/remediation:

```sh
python3 -m pytest tests/test_substrate_handoff.py tests/test_substrate_lease.py tests/test_substrate_tee.py tests/test_runner_gates.py tests/test_swarm_memory.py -q
python3 -m pytest -q
bun test tests/ts
ruff check swarm scripts tests/test_substrate_handoff.py
```

Controlled live smoke, **parent only**, after verifying smoke Postgres `:55432`, GreptimeDB `:54000` and vacant loopback `:7499` are available:

```sh
SUB_WT=/root/src/worktrees/agent-substrate-v12 SWARM_WT=/root/src/worktrees/agent-swarm-p13 PORT=7499 bash /tmp/p13-proof.sh
```

The override avoids accidentally using a moved/stale Phase 11 checkout. The harness refuses production `:7410`, starts/stops only its own smoke server and creates temporary proof artifacts. It is outside the repository; archive its relevant evidence through the parent workflow rather than assuming `/tmp` is permanent. No service was started by this audit.

| Manual verification | Requirement | Instructions |
|---|---|---|
| Documentation accuracy | All four | Compare the task-8 pages with final source after fixes, especially release ordering, fail-open limits and packet size. Do not test literal prose. |
| Live takeover/reconstruction | PROOF-02, HAND-02 | Run isolated harness, retain exit code and exact source commits; record 34 driver + 15 receiver results, takeover time, holder/epoch sequence, lease-release order, A14 local-read audit and signed verdict. |
| Source-only findings | HAND-01, PROOF-02 | Parent supplies controlled interleaving and rejected-dedupe regressions described in G13-01/02; document failing-before/passing-after results, without weakening acceptance. |

## Validation Sign-Off

- [x] All nine numbered tasks mapped to requirements, source and explicit verification routes.
- [x] Historical execution distinguished from static review and fresh results.
- [x] No missing referenced existing test files; no watch mode.
- [x] G13-01/02 remedied and regression-proven; G13-03/04 resolved.
- [x] Parent full gates and isolated smoke completed against final source.
- [x] Resumed consolidated feedback measured: 94.82-second gates, 66.86-second live proof; no three consecutive tasks lack a verification route.
- [x] `wave_0_complete: true` and `nyquist_compliant: true` justified by final evidence.

**Approval:** approved 2026-10-07 by parent Main's final gate instruction, supported by the final evidence below. No risk acceptance.

## Remediation Source Review — 2026-10-07

Reviewed the fix owner's result and the changed source/tests/docs without running checks. These are working-tree changes on the previously observed source baseline, not a newly observed committed revision. All baseline evidence and historical numbers above remain historical. Parent has started consolidated gates and is porting the fix to Phase 14; a started run is not a passing result.

| Gap / tasks | Source-reviewed remediation | Exact new/existing regression coverage | Closure state |
|---|---|---|---|
| G13-01 / 2,3,5,6,7 | `swarm/substrate_lease.py:342-348` exposes the same reentrant per-task lock; `swarm/results.py:283-300` holds it across transition→handoff→settle/rework; `scripts/swarm_run.py:684-696` holds it for max-attempt escalation; `swarm/substrate_handoff.py:435-453` and `substrate_lease.py:620-625` share it for escalation/acknowledgement. | `tests/test_substrate_handoff.py::test_escalation_keeps_the_lease_until_the_packet_attempt_finishes` at lines 330-440: 2 boundary kinds × 4 delivery outcomes. Real keeper starts while escalation is paused; observed lock contention proves it reached the critical boundary; assertions prohibit early release and check successful store→release ordering. | Mitigation and consumer-visible regression present; execution/live sign-off pending |
| G13-02 / 3,7 | `swarm/substrate_handoff.py:62-68` requires explicit false + recognized string reason for unsigned; `244-278` excludes rejected/malformed/wrong-graph rows and keys dedupe by sender/node/boundary. | `::test_rejected_or_malformed_ledger_rows_cannot_suppress_a_real_boundary` at 566-610 covers 11 corruption cases; `::test_a_rerun_writes_no_second_packet_for_one_boundary` at 544-563 now covers verified, unsigned and no-keys-configured restarts. | Mitigation/regressions present; execution pending |
| G13-03 / 3,7,8 | `swarm/substrate_handoff.py:146-193,332-342` compacts oversized key components, fits serialized request including routing/session fields and envelope reserve, respects notes cap and visibly refuses immutable oversize. `docs/substrate-handoffs.md:84-99` documents the actual contract. | `::test_large_multibyte_packets_preserve_distinct_boundary_keys_after_restart` at 613-650 (signed/unsigned) checks packet bytes, notes units, distinct retained keys and restart dedupe; `::test_routing_that_cannot_fit_never_sends_a_packet_with_a_lost_key` at 653-662 proves visible refusal/no write/no retry. | Bound regression now present; execution pending |
| G13-04 / 2,3,5,6,7,8 | Same guarded escalation path, preserving intentional post-attempt fallback and clearing retry handover capability. `docs/substrate-handoffs.md:76-82` distinguishes failure from successful stored handover. | The keeper-enabled matrix at 330-440 covers stored:false, refusal and unreachable for both escalation paths: fallback release, unsettled remote lease on outage, retries without lease handover, no retry for refusal. | Previously missing held-escalation cases now present; execution pending |

**Packet limits, corrected precisely:** client fitting budget is **9,000 UTF-8 bytes**, including a **1,500-byte generated-envelope reserve** in its calculation (`PACKET_BUDGET`, `PACKET_OVERHEAD`). The documented server packet budget is **12,000 bytes**, and its notes cap is **1,200 UTF-16 code units** (2,400 UTF-16LE bytes), **not 2,048 bytes**. Key round/part components exceeding 256 UTF-8 bytes are SHA-256 compacted. The new test simulates the server notes cap and checks the resulting packet remains at most 9,000 bytes. Runtime confirmation remains pending.

Exact focused command, if needed in addition to the parent's already running consolidated gate:

```sh
python3 -m pytest tests/test_substrate_handoff.py::test_escalation_keeps_the_lease_until_the_packet_attempt_finishes tests/test_substrate_handoff.py::test_rejected_or_malformed_ledger_rows_cannot_suppress_a_real_boundary tests/test_substrate_handoff.py::test_a_rerun_writes_no_second_packet_for_one_boundary tests/test_substrate_handoff.py::test_large_multibyte_packets_preserve_distinct_boundary_keys_after_restart tests/test_substrate_handoff.py::test_routing_that_cannot_fit_never_sends_a_packet_with_a_lost_key -q
```

Do not duplicate the running full gate solely for this addendum. Parent must append observed results, final source provenance and isolated live proof before checking the pending approval boxes. No new execution or security risk acceptance is recorded here.

## Parent Gate Evidence — Post-Remediation

Parent Main reports fresh consolidated Phase 13 verification against the corrected, still-uncommitted working tree:

| Check | Parent-observed result |
|---|---|
| Full Python suite | PASS, **757 tests** (progress 720 + 37), including all new handoff regressions |
| Generator freshness | Up to date |
| TypeScript contract suite | PASS, **1 test** |
| Changed-file Ruff | PASS |
| Consolidated run duration | **94.82 seconds** |

Provenance: direct parent Main gate-result message; this worker did not execute these checks. No new source commit or retained log path was supplied, so the final provenance remains the observed baseline plus uncommitted remediation. Historical 705-test evidence above is not overwritten by the new 757-test result.

Parent also reports the Phase 12 live proof passed 24 checks in 34 seconds; that is supporting dependency evidence, **not a substitute for Phase 13 PROOF-02**. Phase 13's real 49-check killed-replica/ledger-only reconstruction proof is currently running on isolated `:7499`. Hold final compliance/sign-off until that proof's actual result and final source provenance are recorded. Phase 14 porting remains outside this Phase 13 sign-off.

## Final Closure — 2026-10-07

**Final source:** `ce1334294260224ac0d08c97a60d0c3200ff0a3f`, `fix: close lease and handoff security gaps` (11 files). Parent confirms the exact tested patch was committed after checks with no intervening source changes; this worker independently observed the full commit using `git rev-parse HEAD`. The baseline `50b3a788...` and initial/intermediate pending states above are retained audit history, not the final gate status.

**Fresh execution:** parent full Python suite **757 passing**, generator current, TypeScript contract **1 passing**, changed-file Ruff passing; consolidated duration **94.82 seconds**. Fresh live proof **49/49 PASS** (34 driver + 15 A14 receiver), duration **66.86 seconds**, artifact `artifact://1731`, bundle `/tmp/p13-proof-1791412554`. This worker read the proof output; it did not rerun checks.

The fresh proof's actual startup reports `/root/src/worktrees/agent-substrate-p11` on isolated `:7499` with real Postgres/GreptimeDB. This is the executed server path, distinct from the explicit v12 override proposed in the reproduction command above; no unobserved server commit is asserted. Client source provenance is the tested patch committed as `ce1334294260224ac0d08c97a60d0c3200ff0a3f`.

Observed proof outcomes:

- Eight CPU busy loops; r1 keeper still held the node after 35 seconds, beyond its first TTL.
- SIGKILL followed by r2 `stolen` grant at **25.6 seconds**, below the **30-second TTL**. Across **236 graph_get samples**, exactly one holder transition r1→r2, epoch +1, no overlapping observed holds and warning takeover.
- Exactly one packet per boundary, correct sender, signed/verifiable escalation, handover without lease capability disclosure.
- Ledger handoff at `2026-10-07T22:37:00.480Z`, release at `2026-10-07T22:37:00.501Z`; explicit “release comes after its packet” check passes.
- No broker process. Local sender state/run log moved away; A14's separate process rebuilt goal/DoD/blockers/files from the ledger with no Task Store/run-log/swarm-state opens, verified the signature and claimed/released the node.
- Agent CLI remains stubbed: **no full LLM run is claimed**. Original 705-test/25.3-second historical evidence remains distinct from these fresh 757-test/25.6-second results.

| Final task coverage | Requirements | Disposition |
|---|---|---|
| Tasks 1–7 | HAND-01, HAND-02, HAND-03; task 2/5/7 PROOF-02 support | PASS: source-reviewed implementation, existing behavioral catalogue and new regressions all included in full passing suite |
| Task 8 | HAND-01, HAND-02, HAND-03, PROOF-02 | PASS: documentation source review, including corrected packet limits, trust-aware dedupe and keeper/failure ordering |
| Task 9 | PROOF-02, HAND-01, HAND-02 | PASS: fresh 49-check real-server proof |
| G13-01 / G13-04 | HAND-01, PROOF-02 | CLOSED: keeper-enabled 8-case delivery/boundary matrix passed in full suite; live store-before-release and receiver recovery pass |
| G13-02 | HAND-01 | CLOSED: rejected/malformed/node-isolated dedupe and signed/unsigned/no-keys restart regressions pass |
| G13-03 | HAND-01 | CLOSED: multibyte packet-bound/key-retention and oversized-routing refusal regressions pass |

**Open validation findings: none within this phase scope.** All nine tasks and all four requirements are covered; no Wave 0 references remain missing. Final Nyquist sign-off is approved. Permanent `/tmp` proof archival is a milestone evidence-management responsibility, not a missing Phase 13 behavioral criterion.
