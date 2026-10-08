---
phase: "13"
slug: signed-handoffs
status: verified
threats_open: 0
asvs_level: 1
block_on: high
register_authored_at_plan_time: false
created: "2026-10-07"
audit_mode: retroactive-stride
execution_status: passed-parent-gates-and-live-proof
source_commit: ce1334294260224ac0d08c97a60d0c3200ff0a3f
---

# Phase 13 — Security

> Retroactive STRIDE register and ASVS L1 source-evidence review. **SECURED: eight threats closed, zero blocking or non-blocking open findings**, after remediation, parent full regression gates and fresh real-server proof. No risks accepted.

**Final status:** verified at `ce1334294260224ac0d08c97a60d0c3200ff0a3f`. Baseline finding narratives and intermediate pending updates are preserved as chronological audit evidence; the **Final Closure** section supersedes their former open/pending gate states. Original source-line references identify the baseline unless explicitly listed as remediation evidence.

## Scope and evidence rules

Read the complete `13-01-PLAN.md` and `13-01-SUMMARY.md`, historical `13-VERIFICATION.md`, the secure-phase workflow, security auditor role and SECURITY template. The plan contains no authored threat model, and SUMMARY has no dedicated Threat Flags section; this register was constructed from the actual implementation, not inferred as empty/secure. Both security and Nyquist gates are enabled by the assignment, with ASVS level 1 and blocking severity high.

Source root: `/root/src/worktrees/agent-swarm-p13`. Observed HEAD: `50b3a788c4faf052624aa2855902905b01e9d489`. Relative citations below refer to that source snapshot. No product edits, security scanners, tests, builds, live calls or production access were performed. `closed` means a mitigation was found at the stated L1 boundary; it does not mean this worker executed the test or performed an ASVS certification. Static interleaving consequences are explicitly marked [INFERENCE].

The parent confirmed both findings were in scope, assigned a single fix owner, completed regression and live gates, and approved final closure. Remediation evidence and final execution provenance appear below; assignment alone was not used as closure.

## Trust Boundaries

| Boundary | Description | Data crossing / security assumption |
|---|---|---|
| Agent identity → runner token seam → substrate | `substrate_client.own_token`, `substrate_lease.has_own_token/_call`, `HandoffBridge._send` | Sender's own surface token, never a sender-identity request argument. General client fallback exists, but handoff sends must refuse it. Phase 13 runner holds multiple agents' credentials in one process. |
| Local Task Store/verdicts → accountable-agent handoff | Dependency, failed gate and escalation transitions | Goal, outputs/files, receiver acceptance-derived DoD, blockers, graph/node, sessions, first-line boundary key. Signed provenance is not proof that an agent's natural-language content is correct. |
| Runner → signed append-only ledger | `coord_handoff` request and stored response | Authenticated server chooses `from`; server signs packet and records only `lease_handover`, not the lease capability. Durability and signing are server-side dependencies. |
| Lease keeper / reconciliation → graph ownership | Concurrent heartbeat, terminal transition, handoff storage and settlement | Fenced lease capability, holder/session, expiration and epoch. Release-after-storage must account for the concurrently running keeper, not only the explicit settle statement. |
| Ledger → dedupe set | `_ledger_keys` | Sender + boundary key from replayed packets determine whether a boundary will ever be written. Signature verdict must be considered here as well as in context replay. |
| Ledger → receiving agent context/prompt | `reconstruct` and `render` | Exactly two successful read operations (`coord_handoff_list`, `events_query`); verified, explicitly unauthenticated, and rejected packets have distinct treatment. No local Task Store/run-log/cache is needed for standalone reconstruction. |
| Process failure → next replica | Expired leases and ledger recovery | No broker/reaper dependency for reclaim; receiver must call `graph_claim` rather than interpret a historical handover as present ownership. |

## Threat Register

| Threat ID | STRIDE category | Component / requirements / tasks | Severity | Disposition | Mitigation and source evidence | Status |
|---|---|---|---|---|---|---|
| T-13-01 | Spoofing / elevation of privilege | Sender token selection; HAND-01; tasks 1,2,3,6,7,8 | high | mitigate | `swarm/substrate_client.py:61-69` isolates own-token lookup; `swarm/substrate_lease.py:130-134` exposes guard; `swarm/substrate_handoff.py:268-272` refuses missing own token before write; `282-289` sends no `from`/sender surface argument, authenticates through sender surface seam. Misconfigured token is reported at `304-307`, not falsely relabelled. | closed, within trusted-runner boundary |
| T-13-02 | Tampering / repudiation | Signed packet replay; HAND-01/02; tasks 3,6,7,9 | high | mitigate | Baseline `trust_of`/reconstruction/render excludes rejected content while retaining verdict metadata. H01/H10 and fresh live `coord_handoff_verify` cover sender relabelling and signature contract. Final stricter trust predicate at `swarm/substrate_handoff.py:62-68` also protects dedupe. | closed |
| T-13-03 | Tampering / denial of service | Replay identity/dedupe; HAND-01; tasks 3,7,8 | medium | mitigate | Final `swarm/substrate_handoff.py:62-68,244-278` rejects invalid/malformed/wrong-graph entries and scopes marks by sender/node/boundary. Eleven corruption cases and signed/unsigned/no-keys restarts pass in the parent's 757-test suite. | closed after remediation |
| T-13-04 | Tampering / repudiation | Store-before-release ordering; HAND-01, PROOF-02; tasks 2,3,5,7,8,9 | high | mitigate | Final `swarm/substrate_lease.py:342-348,620-625`, `swarm/results.py:283-300`, `scripts/swarm_run.py:684-696`, `swarm/substrate_handoff.py:435-453` share the keeper's reentrant task lock across transition/handoff/settlement. Keeper-enabled 8-case regression matrix and fresh live packet-before-release proof pass. | closed after remediation |
| T-13-05 | Information disclosure | Token and lease capability exposure; HAND-01/02; tasks 1,2,3,7,8,9 | high | mitigate | Transport uses unredirected Authorization header (`swarm/substrate_client.py:288-291`) and refuses redirects (`168-170,241-242`); credentials are not packet fields. Handoff request capability is used only for server release (`swarm/substrate_handoff.py:287-288`), while reconstructed context uses handover boolean (`475`). Packet capability omission is verified by H07 and real historical A14 proof, and depends on server serialization. | closed for accidental transport/packet disclosure; same-account limitation below |
| T-13-06 | Spoofing / repudiation | Unsigned-mode downgrade visibility; HAND-03; tasks 3,4,6,7,8 | medium | mitigate | `swarm/substrate_handoff.py:53,58-63` treats `unsigned`/`no-keys-configured` as unauthenticated, not verified; `302-311` warns once per bridge; `476,487-489` marks prompt UNSIGNED. `swarm/substrate_tee.py:92` maps warning kind. Continuing unsigned is the explicit HAND-03 behavior, not a new risk waiver. | closed for truthful labelling; no authenticity promised when key absent |
| T-13-07 | Denial of service / elevation of privilege | Dead holder, stale ownership and takeover; PROOF-02; tasks 2,7,8,9 | high | mitigate | Per-task keeper serialization, deny-before-expiry/grant-at-TTL/old-holder-drop tests and renderer's explicit claim requirement. Fresh real-server proof: 25.6-second takeover under TTL30, one holder transition across236 samples, epoch+1 and warning; server fencing remains a Phase11 dependency. | closed at L1 contract level |
| T-13-08 | Denial of service / repudiation | Ledger outage, refusal and reconstruction without local state; HAND-01/02/03; tasks 3,4,6,7,8 | medium | mitigate | Client bounded transport (`swarm/substrate_client.py:29-32,232-244`); `_unsent` warns once and queues (`swarm/substrate_handoff.py:234-243`), refused removes queue (`245-250`), `stored` must be true (`290-299`), flush retries (`316-320`), runner flushes each round and at end (`scripts/swarm_run.py:895-898,925-927`). Reconstruction obtains supplied graph/node from only the two ledger reads (`436-477`) and does not invent missing context. | closed within explicitly non-durable, run-local retry scope |

Eight threats: **eight closed, zero high/critical open and zero below-threshold open**. `threats_open: 0`. The two findings below preserve their original discovery evidence; both are now closed by the final remediation and execution evidence.

## Closed Finding History — T-13-04: Keeper Release Ordering

**Evidence:**

1. `swarm/results.py:282` commits the capped rework transition as ESCALATED; the handoff call follows at `288`.
2. The runner keeps the keeper active during normal reconciliation (`scripts/swarm_run.py:889-895`).
3. `swarm/substrate_lease.py:40` puts ESCALATED in `LET_GO`. `beat:445-454` reads that state; with no active dispatch watcher during review, it calls `settle`.
4. `settle:569-592` pops and releases the held lease for this terminal state. Its task lock is not held by reconciliation/handoff across transition and durable storage. `HandoffBridge.escalated:389` only reads the held lease, and the send path does not take that lock.

**[INFERENCE], not freshly reproduced:** A heartbeat between transition and completed `coord_handoff` can release the node first. Another claimant can acquire it while the accountability packet is absent or still in flight. The normal-path “node never reads free without an account of why” claim (`swarm/substrate_handoff.py:377-379`) is therefore not established by current ordering. Severity high reflects violation of the ownership/accountability boundary, not credential theft or an asserted observed exploit.

**Coverage hole:** `tests/test_substrate_handoff.py:189-212,311-326` creates the bridge but never starts the keeper. It proves only the serial happy path. Phase 12's existing settle/reclaim race test covers a different race.

**Required remediation/proof:** Parent/fix owner must coordinate transition plus handoff with keeper terminal-state settlement while preserving the expressly intended fail-open failure path. A deterministic test should pause the storage call and trigger a heartbeat, prove no `graph_release` before the stored packet, and then prove one release/mirror plus receiving A14 claim. Do not merely suppress the keeper or warning. Re-run the live proof and relevant regressions after the fix. No fix or acceptance is claimed by this report.

## Non-Blocking Finding — T-13-03: Rejected Packet Can Suppress a Genuine Boundary

`swarm/substrate_handoff.py:222-228` reads `entry.packet.from.surface` and the first notes line without consulting `entry.verdict`. At `278-280`, that mark produces `duplicate` and no write. Reconstruction correctly rejects the same invalid signature, so send-side and receive-side trust rules disagree.

**[INFERENCE], not freshly reproduced:** A replayed packet with tampered sender/key and `bad-signature` (or another rejected verdict) can seed the target sender/key and suppress the real sender after restart. This requires a corrupted/untrusted replay row; it is not evidence that an ordinary different surface can forge a valid signature. H13 (`tests/test_substrate_handoff.py:430-444`) covers only a different sender's intact packet.

Parent should add a rejected-verdict dedupe regression and apply the same verified/explicitly-unsigned versus rejected distinction when installing dedupe marks. Unsigned packets must remain compatible with the explicit HAND-03 contract. Severity medium: boundary availability/audit integrity, with no claimed credential compromise. No risk acceptance is made.

## Security Verification Map and Exact Commands

All commands are for the parent, from `/root/src/worktrees/agent-swarm-p13`; none were executed by this report worker. The complete nine-task requirement map and all 17 exact handoff test names are in `13-VALIDATION.md`.

| Threat / tasks | Exact existing verification |
|---|---|
| T-13-01 / 1,2,3,6,7 | `python3 -m pytest tests/test_substrate_handoff.py::test_each_boundary_is_written_by_its_sender_and_a05_cannot_sign_as_a14 tests/test_substrate_handoff.py::test_a_sender_without_its_own_token_writes_nothing_rather_than_writing_as_the_runner tests/test_substrate_handoff.py::test_a_token_configured_under_another_agents_name_is_reported -q` |
| T-13-02 / 3,6,7 | `python3 -m pytest tests/test_substrate_handoff.py::test_a_packet_that_does_not_verify_is_listed_but_never_shapes_the_context tests/test_substrate_handoff.py::test_a14_rebuilds_the_patch_from_the_handoff_list_and_the_event_query_alone -q` |
| T-13-03 / 3,7 | `python3 -m pytest tests/test_substrate_handoff.py::test_a_rerun_writes_no_second_packet_for_one_boundary -q`; new rejected-verdict case required, not currently covered. |
| T-13-04 / 2,3,5,7 | `python3 -m pytest tests/test_substrate_handoff.py::test_the_rework_cap_hands_the_lease_over_with_the_packet tests/test_substrate_handoff.py::test_a_failing_gate_hands_its_findings_to_the_producer -q`; new controlled keeper interleaving required. |
| T-13-05 / 1,3,7 | `python3 -m pytest tests/test_substrate_tee.py::test_redirect_is_not_followed tests/test_substrate_tee.py::test_surface_token_override_wins_and_never_leaks tests/test_substrate_handoff.py::test_the_rework_cap_hands_the_lease_over_with_the_packet -q` |
| T-13-06 / 3,4,6,7 | `python3 -m pytest tests/test_substrate_handoff.py::test_with_no_handoff_key_packets_are_unsigned_say_so_and_the_run_completes -q` |
| T-13-07 / 2,7 | `python3 -m pytest tests/test_substrate_lease.py::test_two_replicas_racing_for_a_node_dispatch_it_once tests/test_substrate_lease.py::test_a_dead_replicas_node_is_free_to_the_next_claimant_within_one_ttl -q` |
| T-13-08 / 3,4,6,7 | `python3 -m pytest tests/test_substrate_handoff.py -q -k 'unreachable or unanswered or did_not_store or refused_packet'` |
| Documentation / task 8 | Manual comparison of `docs/substrate-handoffs.md`, `docs/substrate-leases.md`, `docs/substrate-tee.md` to final code, especially the successful store-before-release guarantee and documented fallback. |
| Live proof / task 9 | `SUB_WT=/root/src/worktrees/agent-substrate-v12 SWARM_WT=/root/src/worktrees/agent-swarm-p13 PORT=7499 bash /tmp/p13-proof.sh` |

Consolidated parent gate commands (run once after integrations instead of unnecessarily repeating every selector):

```sh
python3 -m pytest tests/test_substrate_handoff.py tests/test_substrate_lease.py tests/test_substrate_tee.py tests/test_runner_gates.py tests/test_swarm_memory.py -q
python3 -m pytest -q
bun test tests/ts
ruff check swarm scripts tests/test_substrate_handoff.py
```

The live command requires isolated existing smoke Postgres `:55432`, GreptimeDB `:54000`, and vacant loopback `:7499`. Harness refuses production `:7410`. Use the explicit substrate checkout override; the historical wrong-server attempt is not proof. Parent must retain exact commit IDs, exit status and result artifacts. No service changes were made here.

## Historical Evidence and Scope Limits

- `13-01-SUMMARY.md:51-55` and `13-VERIFICATION.md:14-30` report **705 Python tests passing** and **49 live checks passing**, split 34 driver/15 receiver, against substrate `1791393` on `:7496` using real Postgres/GreptimeDB. Final bundle `/tmp/p13-proof-1791408817` exists and its driver/receiver source was inspected.
- Final historical takeover: **25.3 seconds after SIGKILL under 30-second TTL**, r1→r2 only, epoch +1, no overlapping observed holds, one warning. These are reported historical measurements, not new execution. The driver accepts TTL+1 second polling slack and a 0.5-second comparison tolerance; do not claim an exhaustive scheduler/race proof.
- Retained `/tmp/p13-proof3.out` is a distinct earlier successful 49-check run (bundle `1791406169`, 25.5 seconds), not the final timing's transcript. Final result totals/timing are attributed to SUMMARY/VERIFICATION, not silently substituted from the earlier file.
- The final receiver `a14.py:35-66` checks own-token-only environment, signed verdict/key, all four boundary packets, goal/DoD/blockers/files, absence of lease id, no local-state reads, then claims/releases. Its `coord_handoff_verify` and claim are additional proof calls after `reconstruct`; reconstruction itself remains the two-read contract.
- The handoff fake models storage/signature/release (`tests/test_substrate_handoff.py:56-108`); it is not a substitute for Phase 11's server security audit. This review does not independently certify server HMAC key management, authorization, append-only storage or database privilege isolation.
- Live and unit runner exercises stub the agent CLI. **No full LLM run is claimed.** No live NATS broker failure is claimed: the proof uses the local bus/run-log stand-in with no broker process and unavailable receiving-side local state.
- Successful server handoff release is store-before-release; the existing **failure fallback** can release through settle after unsent/refused storage, and `_unsent` drops the retry's lease (`swarm/substrate_handoff.py:235`). This is explicitly documented (`docs/substrate-handoffs.md:76-79,104,162-163`) and must not be conflated with the successful-path keeper race. Pending packets do not survive process exit; persistence was expressly out of phase scope.
- General client `_token` still has A01 fallback. Only the sending handoff seam explicitly refuses it. Receiver own-token behavior is proved with a configured receiver token, not with missing receiver credentials; the report does not assert a new global no-fallback guarantee.
- Packet fitting's final serialized <9 kB bound and key retention for large/multibyte identifiers are unverified (validation G13-03). Additional held-escalation storage-failure coverage is needed (G13-04). These are coverage gaps, not fabricated successful tests.

## Accepted Risks Log

**No new accepted risks.** There is no audit-created waiver for either open finding.

Existing explicitly documented limitation: `docs/substrate-handoffs.md:157-159` states that Phase 13's runner holds all sender tokens in one process; attribution is not unforgeability between agents sharing an OS account. The assignment permits citation of this existing same-OS-account credential-isolation limit. It is a scope assumption, not a newly granted acceptance, proof of process isolation, or permission to extend the risk. Phase 14's per-agent environment-file work is outside this report's product-edit scope.

| Risk ID | Threat ref | Existing limitation / new acceptance | Accepted by | Date |
|---|---|---|---|---|
| Existing same-OS-account credential-isolation limit | T-13-01, T-13-05 | Source documentation and assignment acknowledge it; no new risk accepted or closed on that basis | No new acceptance recorded | Existing phase documentation |

## Unregistered Flags

No dedicated SUMMARY threat flags were authored. The retroactive register maps the source-observed surfaces: multiple sender credentials, signed/unsigned replay, dedupe identity, terminal-state keeper concurrency, lease capability handover, failed storage and standalone reconstruction. The keeper race and rejected-dedupe gap are newly recorded findings, not silently omitted because SUMMARY did not flag them.

## Security Audit Trail

| Audit date | Threats total | Closed L1 | Open blocking | Open non-blocking | Run by / evidence |
|---|---:|---:|---:|---:|---|
| 2026-10-07 | 8 | 6 | 1 high | 1 medium | Formal13 retrospective source/test/docs audit at observed commit; no gate execution |

## Sign-Off

- [x] Retroactive STRIDE register constructed; every threat has severity and disposition.
- [x] All nine plan tasks and four requirements have evidence routes (full map in VALIDATION).
- [x] Existing credential-isolation limitation recorded without new risk acceptance.
- [x] T-13-04 fixed and controlled interleaving regression + live proof pass.
- [x] T-13-03 fixed and rejected-verdict dedupe regression passes.
- [x] Parent confirms fresh consolidated checks and final source provenance.
- [x] `threats_open: 0` confirmed after blocking finding closure.
- [x] `status: verified` justified and set by final approval.

**Approval:** verified 2026-10-07 per parent Main's final gate instruction. Final source and observed live evidence below close both findings; no accepted risks.

## Remediation Source Review — 2026-10-07

The fix owner's result and relevant changed source, behavioral assertions and documentation were inspected. This is source review of working-tree changes after the baseline audit, not new runtime evidence or a newly observed committed revision. Parent reports consolidated Phase 13 gates are running and the changes are being integrated into Phase 14. No checks were run by this reviewer.

| Finding | Present mitigation / updated evidence | Regression assertions inspected | Gate disposition |
|---|---|---|---|
| T-13-04 (high) / G13-01 | `swarm/substrate_lease.py:342-348` returns the keeper's same reentrant task lock. `swarm/results.py:283-300` acquires it before the terminal transition and holds through handoff and settlement; `scripts/swarm_run.py:684-696` does the same for retained max-attempt leases. Escalation itself (`swarm/substrate_handoff.py:435-453`) and acknowledgement (`substrate_lease.py:620-625`) share that lock. | `tests/test_substrate_handoff.py:330-440`, `test_escalation_keeps_the_lease_until_the_packet_attempt_finishes`: real keeper, observed lock contention at a paused escalation, 2 boundary kinds × stored/stored:false/refused/unreachable. No early release; successful packet precedes one release; outage does not pretend release; fallback and retries remain explicit. | L1 mitigation now present; open pending parent regression/live evidence |
| T-13-03 (medium) / G13-02 | `swarm/substrate_handoff.py:62-68,244-278` rejects invalid verdicts and malformed packet fields before dedupe; graph/node/sender/key are checked and node is part of the mark. Explicit unsigned/no-keys mode remains allowed rather than silently upgraded to verified. | `tests/test_substrate_handoff.py:566-610`, `test_rejected_or_malformed_ledger_rows_cannot_suppress_a_real_boundary`, 11 corruptions; `544-563`, `test_a_rerun_writes_no_second_packet_for_one_boundary`, now parameterized for signed/unsigned/no-keys-configured. | L1 mitigation now present; open pending parent execution |
| G13-03, packet identity/size coverage | Builder compacts oversized round/part components (`swarm/substrate_handoff.py:146-157`); `_fit_packet:160-193` includes routing/session bytes, truncates only content and preserves key; send visibly refuses immutable oversize (`339-342`). | `test_large_multibyte_packets_preserve_distinct_boundary_keys_after_restart` (`613-650`) and `test_routing_that_cannot_fit_never_sends_a_packet_with_a_lost_key` (`653-662`) cover byte bounds, server notes fitting, two distinct keys, signed/unsigned restart dedupe and refusal without writes. | Prior missing coverage supplied; execution pending |
| G13-04, held escalation failure coverage | Guarded attempt and settlement preserve existing fail-open semantics; no durable packet is fabricated for an outage. Documentation now explicitly distinguishes successful storage from fallback (`docs/substrate-handoffs.md:76-82`). | Keeper-enabled matrix `330-440` checks all three storage failure modes, fallback lease state, no capability on retry and no retry for refusal. | Prior missing coverage supplied; execution pending |

**Exact packet-bound contract:** the client uses **9,000 UTF-8 bytes**, counting serialized request plus **1,500-byte envelope reserve**. Server packet budget is documented as **12,000 bytes**; server notes cap is **1,200 UTF-16 code units**, not 2,048 bytes. New notes-cap regression uses 2,400 UTF-16LE bytes and checks a final packet no larger than 9,000 bytes. Round/part components beyond 256 UTF-8 bytes are compacted separately to preserve grouping and distinct boundary identity. Updated operator documentation: `docs/substrate-handoffs.md:84-99`; keeper ordering also documented in `docs/substrate-leases.md:104-109`.

Closure-ready focused command (already included by the full handoff-file gate; do not rerun just to duplicate a running check):

```sh
python3 -m pytest tests/test_substrate_handoff.py::test_escalation_keeps_the_lease_until_the_packet_attempt_finishes tests/test_substrate_handoff.py::test_rejected_or_malformed_ledger_rows_cannot_suppress_a_real_boundary tests/test_substrate_handoff.py::test_a_rerun_writes_no_second_packet_for_one_boundary tests/test_substrate_handoff.py::test_large_multibyte_packets_preserve_distinct_boundary_keys_after_restart tests/test_substrate_handoff.py::test_routing_that_cannot_fit_never_sends_a_packet_with_a_lost_key -q
```

**Pending closure action:** parent appends actual regression/full-gate and isolated-live-proof results with final source provenance. Only then close findings, recompute `threats_open`, and set verified approval. `threats_open: 1` is conservatively retained as the pending blocking-verification finding, not a claim that the inspected mitigation is still absent. No new accepted risk, new executed result or final security approval is recorded by this addendum.

## Parent Gate Evidence — Post-Remediation

Parent Main reports fresh full Phase 13 Python suite **PASS, 757 tests** (720 + 37 progress), including all new handoff regressions; generator up to date; TypeScript contract **1 passing test**; changed-file Ruff **PASS**. Consolidated duration: **94.82 seconds**. This is parent-observed execution evidence communicated directly, not execution by this report worker. Corrected source remains uncommitted; no new commit or retained gate-log path was supplied.

This supplies passing regression evidence for T-13-03/T-13-04 and G13-03/04. Final security approval remains held pending the actual Phase 13 real-server 49-check proof, currently running on isolated `:7499`. Parent's separate Phase 12 live result (24 checks passed, 34 seconds) is supporting dependency evidence only. Keep `status: draft` and the conservative pending-verification blocking count until the Phase 13 live result and final source provenance are available; do not report an in-flight proof as passed.

## Final Closure — 2026-10-07

**SECURED.** Parent committed the exact tested remediation as `ce1334294260224ac0d08c97a60d0c3200ff0a3f` (`fix: close lease and handoff security gaps`, 11 files), with no source changes between checks and commit. This worker independently observed the full commit ID. Initial baseline and intermediate uncommitted/pending entries above are historical stages, not unresolved work.

Parent full gates: **757 Python tests passing**, including all new handoff regressions; generator current; TypeScript contract **1 passing**; changed-file Ruff passing; **94.82 seconds**. Fresh Phase13 live proof: **49/49 PASS**, comprising 34 driver +15 receiving-agent checks, **66.86 seconds**. Evidence: `artifact://1731`, read by this worker, and `/tmp/p13-proof-1791412554`.

Actual proof startup identifies `/root/src/worktrees/agent-substrate-p11` on isolated `:7499`, real Postgres and GreptimeDB. That executed server path is distinct from the v12 override suggested in earlier reproduction commands; no new unobserved server commit is asserted. Tested client patch is the final `ce133429...` commit.

The fresh output verifies:

- Eight CPU busy loops; keeper renewals keep r1 holding after35seconds; SIGKILL leads to r2 `stolen` grant in **25.6seconds under30second TTL**, with236 graph samples, exactly one r1→r2 holder transition, no overlapping observed holds, epoch+1 and warning takeover.
- Correct sender and one packet per accountable-agent boundary; signed escalation verifies with key identifier `k1`, carries handover but no lease capability.
- Durable handoff at `22:37:00.480Z` precedes release at `22:37:00.501Z`; the explicit ordering check passes.
- With no broker and local Task Store/run log moved away, a separate A14 process reconstructs ledger-only context, opens no local swarm state, verifies the packet and successfully claims/releases.
- No full LLM run: the agent CLI is stubbed, exactly as scoped in the historical proof.

**Finding disposition:** T-13-04 is closed by the source-reviewed common task lock, passing keeper-enabled delivery matrix and fresh live release/recovery evidence. T-13-03 is closed by trust-aware, node-scoped dedupe and passing corruption/restart regressions. G13-03/04 are resolved by passing packet-bound/key-retention and held-escalation failure regressions. No finding was closed by risk acceptance.

| Final audit date | Total | Closed | Open blocking | Open non-blocking | Evidence |
|---|---:|---:|---:|---:|---|
| 2026-10-07 | 8 | 8 | 0 | 0 | Source remediation review + parent757-test gates + inspected fresh49-check live proof; final commit ce1334294260224ac0d08c97a60d0c3200ff0a3f |

**Final approval:** verified; `threats_open: 0`; **no accepted risks**. The previously documented same-OS-account credential-isolation limitation remains a scope assumption, not a new waiver. Phase14 integration and milestone-wide shipping are separate gates and are not declared complete by this Phase13 report.
