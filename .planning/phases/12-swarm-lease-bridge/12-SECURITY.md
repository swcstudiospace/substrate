---
phase: "12"
slug: "swarm-lease-bridge"
status: verified
threats_open: 0
asvs_level: 1
block_on: high
register_authored_at_plan_time: false
created: "2026-10-07"
audit_mode: retroactive-STRIDE
execution_status: parent-verified-postfix
source_commit: "50b3a788c4faf052624aa2855902905b01e9d489"
historical_proof_commit: "5edd55f74ac75c8193dabb057a1d4a5bed0904b5"
source_working_tree: uncommitted-remediation-over-source_commit
---

# Phase 12 — Security

> **VERIFIED — no open threats.** All 12 retroactive ASVS-L1 threats have scoped mitigations. F12-01/F12-02 close on source-reviewed uncommitted corrections plus parent's post-fix **757 passing Python tests**, TypeScript/changed-Ruff/generator checks and isolated real PostgreSQL/Greptime lease proof **24/24 passing**. No accepted risks. Verification applies to corrected p13, not automatically to a later integration or release commit.

## Audit Origin and Source Provenance

The plan contains no authored `<threat_model>` and the SUMMARY has no formal `## Threat Flags` register. This is not an empty-register pass: threats below were reconstructed from the actual lease/runner trust boundaries. The validate/secure workflows, their auditor roles and both templates under `/root/.agents/gsd-core/` were read; both gates are enabled, ASVS level 1, blocking severity high.

Inputs: complete `12-01-PLAN.md`, `12-01-SUMMARY.md`, `12-VERIFICATION.md`, `CONTEXT.md`, plus the actual modules and behavioral assertions identified below. All eight numbered plan tasks are cross-mapped in `12-VALIDATION.md`; the compact security cross-map below preserves that numbering.

**Worktree drift is material:** `/root/src/worktrees/agent-swarm-p12` is clean local main at observed `840020885ed4bc925fde4a907465caae78e3097d`, a pre-bridge `fix(05)` revision. Its lease/client/tee implementation is absent; nothing in that checkout was certified as the merged bridge. The parent authorized `/root/src/worktrees/agent-swarm-p13`, observed HEAD `50b3a788c4faf052624aa2855902905b01e9d489`, as current source. Unless stated otherwise, `path:line` references are relative to p13, at the inspected pre-remediation snapshot.

Historical proof object `5edd55f74ac75c8193dabb057a1d4a5bed0904b5` was resolved and its lease/client/runner/test code inspected. SUMMARY/VERIFICATION report 688 Python tests, changed-source Ruff success, 24/24 live checks at `/tmp/p12-proof-1791408292`, and merged [agent-swarm PR #9](https://github.com/swcstudiospace/agent-swarm/pull/9), Greptile 5/5, no open threads. Those are historical records, not fresh checks or an independently refreshed PR review. The retained live script and driver were read; their fixture and event files do not alone supply the missing complete stdout transcript.

The p13 checkout also contains Phase 13 handoff additions. This report checks its inherited Phase 12 lease paths; it does not claim a Phase 13 packet audit. Phase 14's per-agent env-file migration and substrate-token stripping are explicitly later work, **not a Phase 12 omission**. No tests, scans, builds, formatters, runtime probes or service operations were run by this auditor. Parent reported a direct HTTP403 heartbeat reproduction and a pre-remediation p14 union pass; only the former establishes a newly observed refusal failure, and neither closes it.

**Audit history:** original finding descriptions and baseline line references remain discovery provenance, not still-missing controls. Source-reviewed uncommitted corrections are recorded below; the final parent evidence section closes the findings for corrected p13 over the observed base. No claim is made that the base commit alone includes these fixes.

## Trust Boundaries

| Boundary | Description | Data Crossing |
|---|---|---|
| A01 runner → substrate MCP | Runner holds each lease on behalf of the selected agent; server authenticates bearer/surface/session and performs authoritative CAS | Agent-specific token in Authorization; graph/node/session IDs; requested TTL; holder-only lease ID for heartbeat/release/complete |
| Local request scheduler → remote authority | A full local semaphore is not evidence that the substrate is unreachable | Busy outcome, two-second total request deadline, four-worker cap, outage back-off |
| Graph lookup/cache → lease dispatch | A01 lookup supplies the authoritative bound graph before the agent's claim; failure classification must survive this prerequisite | Correlation ID, graph ID, refused/busy/unreachable outcomes and negative lookup cache |
| Keeper → live dispatch | Heartbeats/refusals control an untrusted child session and later a runner-owned gate script | Stop reason/callback, TTL, fenced lease state, process-group identity |
| Agent/gate process → Task Store result acceptance | A stopped or interrupted process must not have a result or partial gate verdict accepted | Untrusted result text/metadata, signed gate rows, DispatchWatch lock, lifecycle transitions |
| Manual status CLI → active runner/store | Another process may transition the task, but must not free its node while the live dispatch is writing | Task state, `notes.running`, advisory `notes.lease`, mirrored fence |
| Task Store/run log → substrate event tee | Local mirror is for orchestration, not a public bearer/fence channel; tee is attributable but fail-open | Structured notes, lease-ID redaction, event type/session/graph/summary whitelist |
| Shared host account → agent processes | All Phase 12 lease tokens are intentionally available to the trusted runner; same-account agents are not mutually isolated OS principals | Environment and local task/CLI state; see explicit limitation below |

## Requirement and Numbered-Task Security Map

| Plan task | Requirements | Threats / evidence focus |
|---|---|---|
| 12-01-01 — client outcome classification | LEASE-05, LEASE-09 | T-12-01/02/03/04/11: preserve auth refusal, busy and real outage distinctions at every lease consumer |
| 12-01-02 — session/event mapping | LEASE-05, LEASE-08, LEASE-09 | T-12-01/10/12: bounded replica identity, attribution, no structured fence disclosure |
| 12-01-03 — lease bridge | LEASE-05..09 | T-12-01 through T-12-06, T-12-08/09: claim, TTL, watches, keeper, fenced settle/rework |
| 12-01-04 — runner integration | LEASE-05..09 | T-12-01 through T-12-07, T-12-09: pre-dispatch claim, process teardown, gate/result fencing, signal exits |
| 12-01-05 — reconciliation | LEASE-07, LEASE-09 | T-12-07/08/09: DONE, rework/cap and accepted gate issuers |
| 12-01-06 — manual transition | LEASE-07, LEASE-09 | T-12-06/08/10: defer while running; stop before release; private mirror/public event boundary |
| 12-01-07 — tests | LEASE-05..09 | All threats: baseline assertions plus newly source-reviewed auth-refusal/lifecycle/outage regressions; fresh execution pending |
| 12-01-08 — docs | LEASE-05..09 | All threats: scope and operational contract; G12-05 prose corrections source-reviewed in remediation addendum |

## Threat Register

`closed` means a scoped ASVS-L1 mitigation was found in inspected source and the parent supplied fresh post-fix full-suite/live execution evidence. This report worker performed source review, not execution. All dispositions are **mitigate**; no accepted risks or unverified transfers substitute for closure.

| Threat ID | STRIDE category | Component / threat | Severity | Disposition | Mitigation and evidence | Status |
|---|---|---|---|---|---|---|
| T-12-01 | Spoofing / Elevation of privilege | Agent dispatched under another surface or without a permitted claim; denied holder consumes an attempt/slot | high | mitigate | `substrate_lease.py:138-180` derives mapped surface and session, sends that surface's token, never sends force; `Claim.dispatch` at 100-102 excludes denied/refused/busy. `scripts/swarm_run.py:694-717,732-738` claims in batch construction before CLAIMED. Direct wrong-token/denied/grant tests at `tests/test_substrate_lease.py:322-382`. Prerequisite-lookup bypass separately T-12-02. | closed |
| T-12-02 | Spoofing / Elevation of privilege | Auth-refused graph lookup is converted into unleased dispatch before graph_claim | high | mitigate | F12-01 fixed: `substrate_tee.py:235-272` preserves refusal and avoids negative-cache masking; `substrate_lease.py:350-354,393-413,419-437` refuses lease dispatch/resume; `150-158` preserves registration refusal. New behavioral regressions source-reviewed and passed in parent's corrected-p13 757-test run. | closed |
| T-12-03 | Elevation of privilege / Tampering | Revoked/invalid heartbeat credential leaves active writer running after its authority can expire | high | mitigate | F12-02 fixed: `substrate_lease.py:57,190-204,479-525` routes generic auth refusal into watched-dispatch stop rather than unanswered retry. HTTP401/403/MCP identity regressions cover keeper termination and result rejection; passed in parent's corrected-p13 full suite. | closed |
| T-12-04 | Denial of service / Tampering | Local slot saturation fakes an outage and lets another replica run unleased | high | mitigate | `substrate_client.py:223-259,301-307,402-403` returns busy without starting outage back-off; `substrate_tee.py:249-253` avoids negative cache for busy; bridge defers initial claim and retries busy expiry reclaim at `substrate_lease.py:157-158,379-382,480-488`. Existing real-worker/queued tests at `tests/test_substrate_lease.py:385-461,572-600`. | closed |
| T-12-05 | Tampering / Denial of service | Stale/reclaimed lease permits concurrent ownership or an orphan grant escapes tracking | high | mitigate | TTL request clamps 30..86400 and beats at granted TTL/3 (`substrate_lease.py:25-88,174-176,345-355`); `_refused` stops lost/unheld/not-holder, reclaims expired, defers unanswered/busy and transfers watch to fresh lease (`468-505`). Per-task locks serialize claim/beat/settle and release a grant that cannot be installed. Tests at `tests/test_substrate_lease.py:523-760,1175-1219`. Authoritative CAS is Phase 11; generic auth denial excluded by T-12-03. | closed |
| T-12-06 | Tampering | CANCELLED/FAILED/manual release exposes node while its old process group still writes | high | mitigate | `settle_mirrored` defers on `notes.running` (`substrate_lease.py:265-285`); keeper stops and keeps beating until dispatch ends (`436-466`); runner settles in outer finally (`scripts/swarm_run.py:720-729`). `ChildGroup.stop/close` and `_end_group` SIGTERM, then SIGKILL remaining group before forgetting (`371-472`). Tests `test_cancel_while_a_session_runs_stops_it_before_the_release` and `test_a_stopped_session_is_forgotten_only_once_its_whole_group_is_gone`. | closed |
| T-12-07 | Tampering / Elevation of privilege | Lost lease or interrupted/signal-terminated gate approves partial/stale work | high | mitigate | Whole-dispatch `DispatchWatch` spans spawn, gate and result write (`scripts/swarm_run.py:306-342,744-794`); gate uses watched ChildGroup and rejects stopped/negative/shell-signal exits (`564-597`); shutdown marks late child groups stopped (`383-445`). `swarm/results.py:335-353` refuses approval by an unaccepted issuer. Lease tests `840-981` include committed verdicts followed by interruption and keep target IN_REVIEW. | closed |
| T-12-08 | Tampering | Unfenced DONE/release/rework changes a successor's node; resumed review loses producer lease | high | mitigate | Heartbeat/release/complete send held fence with producer surface; bridge serializes settlement. Existing normal/restart/rework tests plus new stale-mirrored-release regression pass in parent full suite. Direct stale mirrored graph_complete remains a nonblocking unexercised branch, not an absent fence or a claimed executed scenario. | closed |
| T-12-09 | Repudiation / Tampering | Lease failure is silently hidden or bridge becomes a second destructive lifecycle authority | medium | mitigate | Mirror is advisory Task Store notes; denied/refused/unleased/lost/unsettled outcomes emit explicit types and cannot falsely report completion. New full non-dry-run outage test at `tests/test_substrate_lease.py:1326-1380` preserves DAG/budgets/history/results and emits expected warnings; passed in parent's full suite. | closed |
| T-12-10 | Information disclosure | Bearer/fencing identifiers leak into shared run-log or tee events | high | mitigate | Bearer added only to unredirected Authorization (`substrate_client.py:287-291`); redirects refused (`168-170`). `swarm/runlog.py:19-50` recursively removes structured `lease_id`, including JSON-encoded notes; tee constructs a minimal payload whitelist (`substrate_tee.py:329-358`). Lease log test `1103-1113`, tee token/redirect tests `274-330` check observable omission. CLI/store mirror is intentionally private local state, not globally redacted. | closed |
| T-12-11 | Denial of service / Information disclosure | Dead/trickling/oversized endpoint hangs every task, exhausts request workers or redirects credentials | medium | mitigate | Total deadline/worker cap/body cap/socket shutdown and nonredirecting TLS-default opener in `substrate_client.py:29-32,168-259,281-307`; real outage starts bounded back-off. Existing `tests/test_substrate_tee.py` transport tests at `378-578`, plus `test_redirect_is_not_followed`; lease outage test at `tests/test_substrate_lease.py:464-491`. Local saturation is not counted as outage (T-12-04). | closed |
| T-12-12 | Spoofing / Repudiation | Invalid or ambiguous replica/session attributes events/claims to the wrong holder | medium | mitigate | One bounded replica validator/shared session builder (`substrate_tee.py:43-60`), runner fails configuration at start (`scripts/swarm_run.py:831-838`); event is attributed from the source agent and validated kind (`substrate_tee.py:329-358`). Tests `test_replica_and_session_shape`, `test_bad_replica_or_ttl_refuses_the_run_at_start`, `test_tee_event_fields`, `test_tee_default_replica_and_optional_ids`. Unique replica configuration is an operator prerequisite, not protection between same-account hostile processes. | closed |

**Gate calculation:** 12 total; 12 closed; 0 open blocking; 0 open below threshold. `threats_open: 0`, ASVS level 1, `block_on: high`. Closure uses source evidence and parent's verified post-fix execution, not historical green tests or assumed risk acceptance.

## Initial Blocking Findings and Required Regression Evidence

### F12-01 / T-12-02 — graph authorization refusal bypasses claim

- **Location:** `swarm/substrate_tee.py:249-261`; `swarm/substrate_lease.py:379-386`; `scripts/swarm_run.py:709-715`.
- **Trigger:** enabled integration, no durable graph binding in the runner's local cache, and graph_bind returns HTTP401/403 or a structured MCP identity refusal. A lookup by resume or the tee can establish the same negative cache before dispatch.
- **Observed source path:** outcome refusal becomes `got=None`; `_unbound[correlation_id]` is set; lookup returns None; acquire emits `lease.unleased` and returns a dispatchable UNLEASED claim. No graph_claim is required on that path.
- **Impact:** an explicit authorization denial is mistaken for permitted fail-open unavailability. [INFERENCE] A live node holder can be bypassed by a misconfigured/unauthorized replica and both can work concurrently; the audit worker did not run this scenario.
- **Expected mitigation:** preserve refused lookup as a nondispatchable result through the lease boundary, including prior lookup/cache paths, while retaining legitimate absent binding/outage behavior and not breaking the S1 tee's fail-open contract. Do not poison a refusal into an unbound/outage cache.
- **Coverage gap:** existing `test_refused_claim_is_not_dispatched` reaches graph_claim only after fake graph_bind succeeds; the fake ignores caller at `tests/test_substrate_lease.py:125-127`. Add behavioral 401/403/MCP-denial and subsequent-recovery assertions (no attempt/slot spent, no unleased dispatch, no false outage cache). Parent owns implementation/tests.

### F12-02 / T-12-03 — heartbeat auth denial is treated as no answer

- **Location:** `swarm/substrate_lease.py:186-198,459-465`; transport correctly produces refused in `swarm/substrate_client.py:379-396`.
- **Trigger:** a task initially holds a lease, then the credential is revoked or the heartbeat receives HTTP401/403/structured identity refusal without the literal text `not-holder`.
- **Observed source path:** heartbeat returns UNANSWERED rather than a refusal reason; keeper retries and does not invoke the stop callback. **Parent confirmation:** direct current-code HTTP403 reproduction returned `unanswered`; execution artifact has not yet been attached to this report.
- **Impact:** [INFERENCE] after expiry and a successor claim, an active agent or gate can continue work without observing the lease authority's refusal. The refusal/outage distinction implemented for claims is lost during renewals.
- **Expected mitigation:** stop/reject on authenticated heartbeat denial with a defined policy reason; retain fail-open continuation only for unanswered/server-error/local-busy conditions. Keep explicit not-holder, expired reclaim and other lease-reason semantics intact.
- **Coverage gap:** existing table test at `tests/test_substrate_lease.py:534-551` changes a token to another valid surface and receives `ok:false, reason:not-holder`; it never exercises HTTP auth denial. Add HTTP401/403/MCP refusal during a watched dispatch, and contrast them with true outage/busy replies. Parent owns remediation and execution.

## Non-Blocking Validation and Documentation Findings

These are not additional proven security vulnerabilities and are not counted in `threats_open`:

- **G12-03:** added BLOCKED/cap-ESCALATED settlement, refused expired reclaim and stale mirrored release regressions passed. Direct stale mirrored graph_complete remains a nonblocking unexercised branch; normal completion and stale release are not mislabeled as its exact proof.
- **G12-04:** closed by passing full non-dry-run real-child outage comparison through DONE, retaining DAG/budgets/history/results and explicit unleased warnings.
- **G12-05:** corrected top-level `ttl_seconds` and local-slot wait/busy/no-backoff prose source-reviewed in both product docs.
- **G12-06:** closed on parent's fresh corrected-p13 757-test gate and 24/24 isolated live proof, with execution provenance below.

## Accepted Risks Log

**No accepted risks.** No user decision accepting F12-01/F12-02 exists, and this auditor cannot accept risk.

### Explicit existing scope limitations (not new risk acceptances)

- Phase 12's trusted runner is given all executing-agent surface tokens and uses them on the agents' behalf (`docs/substrate-leases.md:38-44,183-187`; `substrate_lease.py:122-127`). This provides attribution, not isolation against hostile processes sharing the same OS account. The existing same-OS-account credential-isolation limitation is acknowledged; it does not close either refusal bug.
- Phase 14 owns per-agent env-file loading and substrate-token stripping from child processes. The Phase 12 signing-key restriction is already separate (`scripts/swarm_run.py:64-67,213-240`; `tests/test_runner_gates.py:66-96`). Do not infer that this older source proves Phase 14 isolation.
- Fail-open availability during a genuine unavailable/failing substrate is explicit LEASE-05/09 behavior. It does not provide exclusive work during a partition, and it is not authority to turn a received authorization refusal or local slot contention into an outage.
- `orch_status --ingest`/in-session Agent-tool dispatch and REST lease endpoints are excluded by the plan. The manual `--transition` path is included and audited.
- Server-side CAS, surface authentication, holder-only reply IDs and no-swarm-operator enforcement are Phase 11 controls. Client tests simulate these; the live proof uses the Phase 11 server. No second server security audit is claimed here.
- Process teardown covers the child's OS process group, including children with independent pipes; it is not an OS sandbox against a hostile same-account process escaping its group. Claims of stopped-group behavior rely on normal kernel signal/process semantics.
- Structured run-log redaction is not an arbitrary free-text secret scanner. The Task Store and `orch_status --json` intentionally expose the local mirror to the local operator; tee event construction is whitelisted.

## Exact Parent Verification Commands

The complete test-name catalog and every numbered-task mapping are in `12-VALIDATION.md`. None of these commands were executed by this report worker. The parent executed the full Python and TS suites in corrected `/root/src/worktrees/agent-swarm-p13`; targeted commands below are reproducible scopes already covered by that full suite, not separate execution claims. Changed-file Ruff passed; no unreported whole-tree Ruff run is inferred. Never use drifted p12/main as Phase 12 source.

```bash
python3 -m pytest tests/test_substrate_lease.py tests/test_substrate_tee.py tests/test_swarm_memory.py tests/test_runner_gates.py -q
python3 -m pytest tests/test_omp_runtime.py::test_signal_to_runner_group_ends_sessions tests/test_omp_runtime.py::test_ignored_sighup_keeps_runner_and_session -q
python3 -m pytest -q
bun test tests/ts
ruff check swarm scripts
```

The new auth-refusal regressions were source-reviewed and passed in the parent's corrected-p13 full suite, including real child termination/result rejection. Parser-only 401/403 tests are not substituted for this dispatch behavior.

Parent's isolated live replay, with existing smoke databases and free :7499:

```bash
SWARM_WT=/root/src/worktrees/agent-swarm-p13 SUB_WT=/root/src/worktrees/agent-substrate-p11 PORT=7499 bash /tmp/p12-lease-live-proof.sh
```

The script starts/stops only its isolated MCP child, refuses :7410 and must not target production. Parent executed this exact isolated replay successfully: 24/24, actual PostgreSQL/Greptime, 34.04 s, artifacts `/tmp/p12-proof-1791412421`. Generic auth-refusal proof comes from the separate passing Python regressions, not this retained live driver. Phase 13's live kill takeover remains separate PROOF-02 evidence. No credentials are included.

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open blocking | Open below threshold | Run By / evidence |
|---|---|---|---|---|---|
| 2026-10-07 | 12 | 10 | 2 | 0 | Formal12, retroactive source/test inspection at p13 HEAD 50b3a788; historical 5edd55f objects and 688/24 artifacts reviewed; no fresh gate execution |
| 2026-10-07 | 12 | 10 | 2 | 0 | Parent confirmed direct HTTP403 heartbeat → unanswered; remediation delegated; post-fix evidence/sign-off not yet supplied |
| 2026-10-07 | 12 | 12 | 0 | 0 | Parent post-fix p13 full Python 757 pass; generator current; TS 1 pass/6 assertions; changed-Ruff pass (batch 94.82 s); actual isolated live lease proof 24/24 in 34.04 s, `/tmp/p12-proof-1791412421`; Formal12 source-reviewed fixes and records parent-authorized closure |

No standalone formal SUMMARY threat flags were omitted: the missing authored register was reconstructed into the 12 threats above. New implementation findings were escalated to the parent immediately; no product files were modified by this worker.

## Sign-Off

- [x] Retroactive STRIDE register covers all six categories and all eight numbered tasks.
- [x] Every threat has severity, mitigate disposition, source evidence and explicit status.
- [x] Accepted Risks Log contains no unauthorized acceptances; later-phase and same-account limits are explicit.
- [x] F12-01/F12-02 fixes source-reviewed; behavioral regressions passed on corrected p13 working tree.
- [x] Fresh suite/live evidence supplied by parent; direct stale mirrored completion explicitly retained as nonblocking coverage limit.
- [x] `threats_open: 0` follows remediation and new passing evidence, not historical inference.
- [x] `status: verified` set on parent's explicit finalization instruction.

**Approval:** parent-authorized Phase 12 security closure for corrected p13. **Security gate: PASS; no open threats or accepted risks.** Later p14 integration and shipment require their own parent-owned gates.

## Remediation Source Review — 2026-10-07

**Provenance:** changed working-tree files in `/root/src/worktrees/agent-swarm-p13`, over observed HEAD `50b3a788c4faf052624aa2855902905b01e9d489`; corrections are **uncommitted**, not content of that commit. This worker performed source/test/prose review only. Parent executed the fresh gate and live proof below; later p14 integration remains separate.

### F12-01 / T-12-02 — closed after parent post-fix execution

- `swarm/substrate_tee.py:235-272`: lease callers can require authenticated lookup; their lookups bypass optional-tee negative entries; explicit auth refusal clears negative cache and raises `GraphLookupRefused`. Optional tee still returns no remote event without losing local logs. Valid cached bindings remain an optimization, followed by ordinary authorized graph_claim for dispatch.
- `swarm/substrate_lease.py:350-354,393-413,419-437`: lookup refusal becomes `Claim(REFUSED)`, a refused mirror/event and no dispatch, including resumed-review lookup handling. `claim_node:150-158` similarly stops on refused dynamic node registration instead of retrying an unknown node into fail-open.
- Source-inspected exact tests: `test_graph_lookup_refusal_never_dispatches_unleased` (`tests/test_substrate_lease.py:402-425`, HTTP401/403/MCP identity × negative-cache presence, followed by recovery); `test_graph_lookup_without_auth_refusal_still_dispatches_unleased` (`428-440`, true unbound/down/server-error); `test_refused_registration_never_turns_an_unknown_node_into_unleased_work` (`1508-1517`); `test_refused_graph_lookup_keeps_local_logs_and_does_not_cache_the_refusal` (`tests/test_substrate_tee.py:745-761`).
- These assert task stays PLANNED, no dispatch/claim follows refused lookup, refusal is visible, and corrected identity recovers. They are behavioral assertions, not outcome-classifier-only tests. Parent supplied a fresh passing full suite containing these regressions; the finding is closed.

### F12-02 / T-12-03 — closed after parent post-fix execution

- `swarm/substrate_lease.py:57,190-204` assigns generic auth refusal an explicit `REFUSED`/`E-POLICY` stop policy, preserving the special `not-holder` response. True unavailability/server-error still returns UNANSWERED.
- `swarm/substrate_lease.py:479-525`: refused renewal goes through `_refused`, drops the held lease, mirrors/emits loss, and invokes the watched stop callback rather than scheduling another heartbeat. Expired reclaim alone retains its separate retry/stop semantics.
- Source-inspected exact tests: `test_auth_refused_heartbeat_stops_dispatch_instead_of_retrying` (`tests/test_substrate_lease.py:612-624`); `test_auth_refusal_kills_the_process_group_and_rejects_its_result` (`876-908`); `test_expired_lease_whose_reclaim_is_refused_stops_dispatch` (`688-699`), each across HTTP401/403/MCP identity refusal.
- The real-child test authors a valid IN_REVIEW result before waiting, then checks FAILED, dead child, no tracked sessions, no IN_REVIEW history and recorded stop reason. This is the necessary keeper/dispatch consequence, not just a parser assertion. Parent confirmed the full suite including auth-stop regressions passed; the finding is closed.

### Non-blocking follow-through

- G12-03 now has BLOCKED/cap-ESCALATED and stale-mirrored-release assertions (`tests/test_substrate_lease.py:1176-1203`) plus refused expired reclaim. **Direct stale mirrored graph_complete remains unexercised**; normal fenced completion and stale release are not described as that exact branch's proof.
- G12-04's real-child, two-task non-dry-run comparison through DONE for disabled versus simulated outage (`tests/test_substrate_lease.py:1326-1380`) passed in parent's full suite, preserving DAG/budgets/history/results and explicit unleased warnings.
- G12-05 source/prose repair is verified: `docs/substrate-leases.md:53,75,85-86,123` and `docs/substrate-tee.md:29-37` correctly describe TTL field, refusal semantics and slot wait/busy behavior.
- Phase 13 handoff race/dedupe/packet corrections in the same working tree belong to the Phase 13 auditor. Their presence does not expand this report into a packet security certification.

### Fresh Parent Execution and Closure

Parent Main explicitly reported and authorized finalization on 2026-10-07: corrected p13 full Python **757 tests passing** (progress 720 + 37), generator up-to-date, TypeScript **1 pass / 6 assertions**, changed-file Ruff all passing; combined gate duration **94.82 s**. Parent also ran `/tmp/p12-lease-live-proof.sh` with `SWARM_WT=/root/src/worktrees/agent-swarm-p13`, `SUB_WT=/root/src/worktrees/agent-substrate-p11`, `PORT=7499`: **24/24 passed**, actual PostgreSQL/Greptime, **34.04 s**.

Evidence directory `/tmp/p12-proof-1791412421` was located by this auditor and contains `drive.py`, `events.json`, `audit.jsonl`, `healthz.json`, `substrate.log` and isolated Task Store files. Passing-count provenance is the parent's observed execution result, not an inference from those files. No new code commit exists: verified source is the observed p13 base **plus uncommitted corrections**.

All 12 threats are closed at the scoped L1 gate; no risks accepted. The exact new behavioral node IDs and reproducible focused command remain in VALIDATION. Direct stale mirrored completion remains explicitly unexercised and nonblocking, as instructed by the parent; no branch execution is fabricated. This closure does not certify a later p14 integration, a release artifact or an unperformed broader security scan.
