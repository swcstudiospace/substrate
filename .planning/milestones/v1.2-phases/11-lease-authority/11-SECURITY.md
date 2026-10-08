---
phase: "11"
slug: "lease-authority"
status: verified
threats_open: 0
asvs_level: 1
security_block_on: high
register_authored_at_plan_time: false
created: "2026-10-07"
source_commit: "1791393df14e74be9f6808649d78c6df08ffbb05"
fresh_execution: parent_reported
---

# Phase 11 — Security

> Retroactive STRIDE register and ASVS-L1 mitigation-presence audit. No plan-authored threat model existed; this register was reconstructed from actual source, including public/read/replay paths. All eight threat mitigations are present; parent integration repairs and verification close the coverage/documentation findings. No new risk acceptance or signed release-gate claim is granted.

## Scope, method and provenance

- Inputs read in full: `11-01-PLAN.md` (all eight numbered tasks), `11-01-SUMMARY.md`, `11-VERIFICATION.md`, and `CONTEXT.md`. Neither plan nor summary supplies a formal threat register; summary authority/disclosure decisions were mapped below rather than treated as proof.
- Source root: `/root/src/worktrees/agent-substrate-p11`. `git rev-parse HEAD` observed **1791393df14e74be9f6808649d78c6df08ffbb05**. `src/` below means `packages/mcp-server/src/`; docs paths are root-relative. Line references describe this revision.
- Historical provenance: SUMMARY lines 55–60 / VERIFICATION lines 29–34 report 1049 passing tests with real PostgreSQL, clean typecheck, 42 live checks (7499, rerun after review on 7498), and [PR #16](https://github.com/swcstudiospace/agent-substrate/pull/16) merged as `1791393` after Greptile 5/5 and zero open review threads. These are local artifact-reported historical results, not a fresh remote review or security scan.
- **Fresh evidence received from Main during this audit:** full `bun test` in substrate p14, which inherits merged Phase 11 authority, with real `SUBSTRATE_TEST_PG_URL`: **1066 pass / 0 fail**; `bun run check`: **exit 0**. This is integrated p14 evidence, not an assertion that the isolated p11 full suite was rerun. The parent separately ran `/tmp/p11-lease-proof/run.sh` against exact merged p11 `1791393`, real PostgreSQL + GreptimeDB on isolated **7499**: **42 checks PASS plus boot misconfigured-operator warning PASS**, **33 seconds**; server log `/tmp/p11-lease-proof/server.W8kZ.log`. These are parent-reported executions, not runs made by this report author. Parent reports source was not edited.
- No dedicated SAST, dependency, secrets, infrastructure, or penetration scan was run or claimed. L1 closure means the mitigation is present in reviewed source; full security/deployment assurance is not inferred from a passing test suite.
- No product edits, test executions, service changes, commits or credential operations were performed by this auditor. Only the two assigned reports are written.
- **Final parent integration closure:** current p15 extends the existing stranger-oracle lease test with correct/wrong/missing-id release equality and complete-row preservation; docs now distinguish omitted reaper id with `lease_epoch`/`expired_at` from null-id lease views. Parent targeted lease+lesson suite: **81 pass / 0 fail**, typecheck **exit 0** after edits; inherited full-suite totals **1066** and **1129** passing also reported. Authority implementation remains unchanged from P11. These are current integration test/docs repairs, not changes asserted at historical `1791393`.
- **README review completed by parent:** p15 lines 41–48 (holder-token fences), 59 (coordination link), 164–166 (session, holder-only id, no swarm operator and swarm-correlation link) all match current authority; no README change required. This closes task 8's parent-owned review scope.
- Evidence provenance is retained in these reports: observed historical commit, exact live launcher/source/log path, isolated stores/port, parent-reported counts and latency, and current integration repair scope. No new external script is created; no raw stdout or cryptographically signed gate is fabricated.

## Trust Boundaries

| Boundary | Description | Data crossing |
|----------|-------------|---------------|
| Bearer token → transport-established caller | HTTP resolves token surface and operator attribute before parsing tool arguments, rejecting missing/unknown surface tokens when configured | Surface identity and operator capability; credential itself remains private |
| MCP caller → claim attribution/session | Swarm caller cannot name another surface, non-swarm caller cannot claim as swarm; session binds exact uppercase agent, bounded replica and graph | Untrusted `surface`, `session_id`, `graph_id` |
| Service → durable index decisions/CAS | Caller surface accompanies renewal, heartbeat, release and completion; SQL fences decisions against current durable state | Lease id (capability), holder/session, epoch, TTL, completion state |
| Durable node → public graph/drift/replies | Public readers may see holder/session/epoch/expiry, never newly-issued live lease ids except their accepted ownership-proving reply | Internal node rows vs redacted LeaseView/graph |
| Lease actions → shared append-only ledger/replay | New lease events contain epoch, new handoff packets contain intent only; all agents may query events/replay packets | Public event payloads and signed handoff records |
| Handoff sender → signature and optional lease release | Sender comes from authenticated transport; whole stored packet signed; release follows durable append and holder fencing | Signed context, request-only handover id, release result |
| Operator configuration → force permission/logging | Swarm tokens remain non-operators even if mistakenly listed; warning names surface only | Operator token membership, non-sensitive surface names |
| Local process / same OS account → credentials | HTTP token separation does not isolate processes that can read the same account's secret material | Deployment credential-isolation assumption; outside the protocol guarantee |

## Threat Register

All dispositions are `mitigate`. `closed` denotes mitigation presence at ASVS level 1, not fresh independent execution of every individual regression. The parent live proof and integrated suite provide additional runtime evidence as qualified above.

| Threat ID | Category | Component / attack | Severity | Disposition | Mitigation and evidence | Status |
|-----------|----------|--------------------|----------|-------------|-------------------------|--------|
| T-11-01 | Spoofing | Malformed/cross-agent/cross-graph swarm claim impersonates another holder | high | mitigate | `server.ts:219-224,254-257` authenticates surface; `mcp.ts:83-108` constrains attribution; `:112-142` validates exact agent/replica/graph; `:523-532` refuses before index. `authority.test.ts:302-351`, `mcp.test.ts:299-377`, `server.authority.test.ts:433-461` cover non-swarm impersonation, malformed session, unchanged non-swarm/anonymous semantics. | closed |
| T-11-02 | Spoofing / Elevation of privilege | Public holder surface/session reused by another token to renew/reclaim and retrieve live id | high | mitigate | `lease.ts:234-247` denies same-holder requests from a different authenticated surface before renewal or expired reclaim; `index-store.ts:453-468` passes caller and returns public view; `service.ts:796,885-890` preserves caller and hides rejected id. `lease.test.ts:382-435`, `index-store.lease.test.ts:345-381` assert no expiry/epoch/state mutation and holder renewal still succeeds. MCP independently prohibits authenticated cross-swarm attribution. | closed |
| T-11-03 | Information disclosure | Live capability leaks through graph read/register, denial, drift, reaper, event payload or handoff replay | high | mitigate | Public view `lease.ts:441-442`; explicit graph redaction `service.ts:95-96,687-697`; claim redaction `:885-890`; accepted-only heartbeat view `index-store.ts:549-570`; public release/complete `service.ts:965,991-1001`; drift `drift.ts:299,314,341,371,456-462`; reaper rows `index-store.ts:673-680`; events `service.ts:828-832,954-956,1024`; new handoff `handoff.ts:234-254`. Full path matrix below. Legacy records deliberately remain verbatim, not secretly scrubbed. | closed within stated new-record scope |
| T-11-04 | Tampering / Elevation of privilege | Stranger or stale replica uses a known/guessed id to heartbeat, release or complete another live lease; id oracle | high | mitigate | `lease.ts:321-325,401-406` checks stranger before id, including valid-id attacks; `mcp.ts:553-554,598,622` threads transport caller. SQL heartbeat id/expiry fence `index-store.ts:551-558`; release/completion atomic epoch/id fence `:603-611`; service refuses free-node completion `service.ts:991-999`. `lease.test.ts:312-379`, `index-store.lease.test.ts:132-175,297-332`, `server.authority.test.ts:189-214` cover actual authority and unchanged state. Narrow missing wrong-id-release assertion tracked G11-02, not an absent source mitigation. | closed |
| T-11-05 | Spoofing / Tampering | Handoff body forges sender or uses release path to drop foreign lease | high | mitigate | MCP sender cannot be supplied as an arbitrary author; REST derives it from token (`server.ts:404-429`); `service.ts:1116-1130` passes authenticated sender or deliberately anonymous null, never force. `server.authority.test.ts:236-315` tests sender forgery and unknown token; `service.test.ts:1038-1099` tests refused foreign release and anonymous semantics. | closed |
| T-11-06 | Elevation of privilege / Information disclosure | Operator-list misconfiguration permits swarm eviction or prints token in boot warning | high | mitigate | `config.ts:241-245` rejects every recognized swarm surface as operator; `mcp.ts:597,621` checks force before mutation; `config.ts:298-304` warns using surfaces, not tokens; boot loop `index.ts:24-25`. `authority.test.ts:120-145` and `server.authority.test.ts:217-231` cover both forced release and complete. Parent fresh proof additionally reports boot warning and force-denial pass. | closed |
| T-11-07 | Repudiation / Tampering | Changing lease intent or legacy fields bypasses signatures; release without durable handoff loses trail | high | mitigate | `handoff.ts:259-280,304-331` HMAC-signs/verifies the whole stored object with header and constant-time comparison, without rewriting legacy fields. `service.ts:1095-1129` appends before releasing; `:1167-1175` replays original packet with explicit verdict. `handoff.test.ts:110-132,178-202,247-262`, `service.test.ts:988-1021,1102-1114` assert tamper rejection, both legacy shapes, round trip and durability ordering. New epoch-only events preserve correlation without publishing capabilities. | closed |
| T-11-08 | Denial of service / Tampering | Unauthorized renewal prolongs another lease, expired lease revives, reaper clears a renewed lease, or competing claims both win | high | mitigate | TTL normalized with finite bounds (`lease.ts:42-51`); caller binding prevents foreign extension; server-clock renewal/claim fences `index-store.ts:480-509`, heartbeat `:555-558`, reaper snapshot fence `:649-668`. Exact tests `index-store.lease.test.ts:57,75,213,233,253,345` exercise competing connections, expiry and renewal race boundaries. General authenticated request-rate exhaustion is not newly introduced or assessed by this phase. | closed |

**Blocking-open count:** 0 high/critical threats with missing source mitigation identified in the reviewed phase boundary. This does not convert remaining coverage/documentation actions into accepted risks, nor mark the whole milestone security gate passed.

## Public, Event and Replay Disclosure Matrix

| Surface | Production path / mitigation | Behavioral evidence |
|---------|------------------------------|---------------------|
| Granted / renewed / reclaimed claim | `service.ts:885-890`, `index-store.ts:512`; only a standing grant returns holder view; claim node row always nulls id; caller checked on renewal/reclaim | `lease.test.ts:382-435`; `index-store.lease.test.ts:345-381`; `service.test.ts:96-106,153-180`; live proof `:96-100` |
| Denied/withdrawn claim | `lease.ts:236-247`; `index-store.ts:468,518-522`; `service.ts:858-859,885-890` | `lease.test.ts:172`; `service.test.ts:153-180,428-455`; live proof `:119-130` |
| Heartbeat accepted/refused | `index-store.ts:549-570`; service returns selected lease, not raw node (`service.ts:907-915`) | `index-store.lease.test.ts:310-331`; HTTP `server.authority.test.ts:189-214`; live proof `:144-149,246-247` |
| Release / complete replies | `service.ts:961-965,984-1001`; SQL result node never leaves via these service replies | `service.test.ts:264-285,299-327`; live proof `:151-167,248-249` |
| `graph_get` / `graph_register` | `service.ts:95-96,687-697` explicit null ids on all node rows | `mcp.test.ts:404-416`; live proof `:132-142` |
| `coord_drift_scan` / REST `/drift` | `drift.ts:299,314,341,371,456-462` public view for findings and claims; same service underneath | `drift.test.ts:245-269`; live proof `:169-180,241-242` |
| `coord_reap_leases` | `index-store.ts:673-680` explicit output excludes id and returns epoch; service returns rows (`service.ts:1028`) | `index-store.lease.test.ts:198-210`; live proof `:187-199` |
| Claim/steal/release/reaper events | Explicit payloads use `lease_epoch` (`service.ts:828-832,954-956,1024`), never copy raw node or decision | `service.test.ts:122-139,252-261`; live proof `:220-236` includes real expired-reaper warning |
| `events_query` / REST `/events/query` | Both call `service.queryEvents` (`mcp.ts:367`, `server.ts:367-370`, `service.ts:519-545`); protection is at new-event construction, not lossy reader rewriting | Parent fresh whole-response no-id checks from `proof.ts:220-242`; does not claim old payloads are scrubbed |
| New `coord_handoff` / REST `/handoff` packet and stored event | Explicit packet builder emits `lease_handover`, never request-only id (`handoff.ts:234-254`); `service.ts:1095-1107` stores that packet | `handoff.test.ts:233-242`; `service.test.ts:1023-1035`; live proof `:201-214` |
| `coord_handoff_list` replay | `mcp.ts:707`, `service.ts:1159-1178` returns actual signed object with verdict; new packets have no id by construction | `handoff.test.ts:247-262`; live proof `:216-218,241-242`; legacy signatures tested separately |
| Historic event / old signed packet | Kept exactly as stored; may include old id. Cross-surface use fails because caller check precedes id. No stronger cross-session privacy is claimed | `docs/coordination.md:101-103`; legacy JSON/tamper tests `handoff.test.ts:178-202`; pure/PG foreign-known-id fencing tests |

“All public paths” here means server-generated lease authority data from Phase 11 onward. It does not promise to delete a secret a credential-holder deliberately puts in arbitrary user text/payload, scrub immutable historical records, or isolate mutually untrusted processes sharing one OS account.

## Requirement and Numbered-Task Coverage

| Task | Requirements | Threat mapping | Primary executable check |
|------|--------------|----------------|--------------------------|
| 11-01-01: pure holder/view | LEASE-02, LEASE-03 | T-11-02/03/04 | `bun test packages/mcp-server/src/lease.test.ts` |
| 11-01-02: index | LEASE-02, LEASE-03 | T-11-02/03/04/08 | `bun test packages/mcp-server/src/index-store.lease.test.ts` with real PG env |
| 11-01-03: service | LEASE-02, LEASE-03 | T-11-02/03/05/07 | `bun test packages/mcp-server/src/service.test.ts` plus live proof |
| 11-01-04: packet | LEASE-02 | T-11-03/07 | `bun test packages/mcp-server/src/handoff.test.ts` |
| 11-01-05: MCP | LEASE-01, LEASE-02, LEASE-03 | T-11-01/02/03/04 | `bun test packages/mcp-server/src/authority.test.ts packages/mcp-server/src/mcp.test.ts packages/mcp-server/src/server.authority.test.ts` |
| 11-01-06: no swarm operator | LEASE-04 | T-11-06 | `bun test packages/mcp-server/src/authority.test.ts packages/mcp-server/src/server.authority.test.ts` |
| 11-01-07: drift | LEASE-02 | T-11-03 | `bun test packages/mcp-server/src/drift.test.ts` plus live proof |
| 11-01-08: docs | LEASE-01..04 | T-11-01..08 | Manual source-contract comparison; behavioral commands above, not prose tests |
| Invariant: EVENT_KINDS / store lock | Unchanged plan contract | T-11-07 / trust boundary | `bun test packages/mcp-server/src/event.test.ts packages/mcp-server/src/store-lock.test.ts`; inspected `types.ts:50-63` still has twelve original kinds |

Exact behavioral test titles, source assertions and test prerequisites are recorded in `11-VALIDATION.md`; the map above links every task rather than inferring security completion from the requirement list alone.

## Findings and Scope Limits

| ID | Classification | Evidence | Required treatment |
|----|----------------|----------|--------------------|
| G11-02 | Closed coverage finding; no source vulnerability | Historical `lease.test.ts:327-336` omitted wrong-id release equivalence; `lease.ts:401-406` already has correct ordering. | Parent p15 existing case now compares correct/wrong/missing releases and complete unchanged row; targeted lease+lesson suite 81 pass / 0 fail and typecheck exit 0 after edits. |
| G11-03 | Provenance retained; external artifact limitation stated | Cross-surface read/replay/reaper matrix remains `/tmp/p11-lease-proof/proof.ts`; exact-p11 fresh run passed. | This report retains source/root, command, parent result, 33s runtime and `/tmp/p11-lease-proof/server.W8kZ.log`. It does not pretend the external script is a new committed regression or raw logs are embedded. |
| G11-04 | Closed documentation discrepancy | Historical `docs/swarm-correlation.md:138-142` implied null-id reaper rows rather than omitted id with epoch/expired-at. | Parent corrected current-p15 wording and completed README contract review at lines 41–48, 59, 164–166; no README change needed. |

Deliberate boundaries from PLAN/CONTEXT and implemented code:

- Surface-level bearer identity, not session-level authentication. Replicas share a surface/token; claiming the same public session with that same token is the documented recovery/renewal path. Distinct credentials per replica are not implemented or claimed.
- Historic ledger rows and signed packets retain original ids. Another surface's token cannot use them; the same holder surface/credential is not separately isolated. Do not broaden “old ids are useless” to every same-surface replica.
- Anonymous local configuration deliberately has no identity comparison; an authenticated configured deployment rejects unknown tokens. Never use anonymous mode to claim deployment isolation.
- Operator force can drop a foreign hold, but only transport-established non-swarm operator permission reaches it. `Substrate`/`IndexStore` are trusted internal APIs; direct in-process calls are not independent authenticated network entry points.
- `coord_reap_leases` remains callable by any authenticated agent; its SQL affects only expired, unchanged snapshots. Operator-gating it and adding REST lease routes were explicitly excluded.
- Existing same-OS-account credential-isolation limitation: token checks cannot protect secrets from a peer able to read that account's environment/files. This audit cites that limitation; it does **not** newly accept it, assert process isolation, or establish cross-account/container controls.

## Accepted Risks Log

No accepted risks. No threat was closed by acceptance or transfer, and this auditor does not accept risk on the user's behalf. Deliberate scope limits above describe existing contracts, not a new authorization to weaken security.

## Security Audit Trail

| Audit date | Threats total | Closed (L1 source) | Open blocking | Open below threshold | Run by / evidence |
|------------|---------------|--------------------|---------------|----------------------|-------------------|
| 2026-10-07 | 8 | 8 | 0 | 0 | Formal11, retroactive source/test audit at `1791393df14e74be9f6808649d78c6df08ffbb05`; no execution by auditor. Parent-reported p14 integrated 1066-pass suite/typecheck and exact-p11 42-check live proof as above. |
| 2026-10-07 | 8 | 8 | 0 | 0 | Final integration closure reported by Main: p15 assertion/docs fixes, targeted 81-pass suite/typecheck exit 0, inherited 1129-pass full suite, README review complete; no authority implementation change and no newly accepted risk. |

Coverage/documentation findings were resolved by the parent's explicit repair and verification evidence above, not by equating `threats_open: 0` with test completeness.

## Parent Commands and Sign-Off

Commands are given for reproducibility, **not a request to rerun already-passed parent gates merely to confirm them**:

- Exact-p11 live authority proof already reported passing: `WT=/root/src/worktrees/agent-substrate-p11 bash /tmp/p11-lease-proof/run.sh` (isolated 7499; no production 7410).
- Fresh integrated checks already reported passing from p14: `bun test` with securely provided `SUBSTRATE_TEST_PG_URL`; `bun run check`.
- G11-02 scoped reproducibility command: `bun test packages/mcp-server/src/lease.test.ts`; parent has already reported the repaired case included in the 81-pass lease+lesson targeted run, followed by typecheck exit 0. No redundant rerun is requested.
- G11-04 correction and parent README review are complete. Evidence provenance is retained here; no additional security scan or signed gate is claimed.

- [x] Retroactive STRIDE register constructed; every threat has severity/disposition/evidence.
- [x] All eight plan tasks and LEASE-01..04 mapped; public/replay/event boundaries inspected.
- [x] No risk accepted or transferred without authority.
- [x] `threats_open: 0` reflects no missing high/critical source mitigation in assessed scope.
- [x] Fresh parent runtime evidence distinguished from historical and source-only evidence.
- [x] Parent resolved coverage/documentation findings and completed README contract review.
- [x] `status: verified` reflects completed ASVS-L1 phase report with parent fresh execution and repair evidence, not release authorization.

**Approval:** verified 2026-10-07 at ASVS level 1; eight mitigations present, zero blocking-open threats, no accepted risks. This is not a fresh independent security scanner verdict or a fabricated signed gate.
