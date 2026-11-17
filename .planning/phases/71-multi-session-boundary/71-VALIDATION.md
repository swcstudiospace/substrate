---
phase: "71"
slug: multi-session-boundary
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-31"
---

# Phase 71 — Validation Strategy and Source Coverage

Planning contract only. No product changes, tests, builds, linters, formatters, installations, migrations, git operations or deployed-service checks were performed by this planner. Prior evidence remains in71-VERIFICATION.md with status gaps_found; the earlier passes do not prove the missing lifecycle or stronger same-surface isolation. `nyquist_compliant` and `wave_0_complete` remain false until main records actual evidence.

## Execution DAG and single-writer ownership

| Wave | Plan | Depends on | Exclusive responsibility |
|---|---|---|---|
| 1 | 71-01 | none | Authority port/SQL adapter, index factory/migration42/digest, authority tests and shared issued-session test fixture |
| 1 | 71-02 | none | CLI wire client, private records, lifecycle commands, hook live/historical split, all CLI fixtures/help/tests |
| 2 | 71-03 | 71-01, 71-02 | ONE owner for service.ts/server.ts/mcp.ts AND session-state/tools/REST/delivery/waiters, config/admission/audit/observe integration |
| 3 | 71-04 | 71-03 | Remaining test migrations, complete consumer/failure matrix and existing docs/config/runbook parity |

The two wave1 plans have no overlapping files and share pinned wire/port contracts rather than editing each other's layers. 71-03 alone consumes storage and CLI contracts; service/server/MCP must never be assigned to competing integration owners. 71-04 sends product defects back to that owner. All plans have2-3 tasks and a leading concrete tracer; ownership is intentionally coarse for the inseparable protocol cutover, with named file batches inside tasks rather than competing writers to the same three integration files. No plan claims a storage helper or client fixture alone delivers the phase. Main runs verification once after all slices land, not while siblings are changing interfaces. Parent owns ROADMAP/STATE/REQUIREMENTS/VERIFICATION and final execution-gate state.

## Test infrastructure and commands

| Property | Value |
|---|---|
| Framework | Existing bun:test; repository Bun1.4.0 convention; no package/dependency installation |
| Configuration | Root package.json test/verify/lint scripts; existing controlled PostgreSQL opt-in tests |
| Working directory | Repository root selected by the dispatcher (`.`) |
| Quick boundary group | `bun test --timeout 30000 packages/mcp-server/src/planning/steering-session-gate.test.ts packages/mcp-server/src/planning/session-state.test.ts packages/mcp-server/src/planning/steering-tools.test.ts` |
| New acceptance group | `bun test --timeout 30000 packages/mcp-server/src/live-session-boundary.test.ts packages/mcp-server/src/live-session-isolation.test.ts packages/mcp-server/src/mcp.steering.test.ts` |
| Durable group | `bun test --timeout 30000 packages/mcp-server/src/planning/live-session-authority.test.ts packages/mcp-server/src/planning/live-session-authority.pg.test.ts packages/mcp-server/src/live-session-restart.pg.test.ts packages/mcp-server/src/index-store.migrate.test.ts packages/mcp-server/src/index-store.migrate-contract.test.ts` |
| Recorded broad regression | `bun test --timeout 30000 packages/mcp-server/src/planning packages/mcp-server/src/server.steering.test.ts packages/mcp-server/src/session-context.test.ts packages/mcp-server/src/brief-sessions.test.ts packages/cli/src/steer packages/cli/src/session/hook.test.ts` |
| CLI/hook group | `bun test --timeout 30000 packages/cli/src/steer packages/cli/src/session/command.test.ts packages/cli/src/session/hook.test.ts packages/cli/src/session/hook-config.test.ts packages/cli/src/session/steering-consumed.test.ts` |
| Additional MCP/docs/brief/policy group | `bun test --timeout 30000 packages/mcp-server/src/mcp.test.ts packages/mcp-server/src/mcp.brief.test.ts packages/mcp-server/src/steering-wiring.test.ts packages/mcp-server/src/brief-fast-path.test.ts packages/mcp-server/src/session-context.service.test.ts packages/mcp-server/src/docs-search.test.ts packages/mcp-server/src/docs-plane-hardening.test.ts packages/mcp-server/src/config.test.ts packages/mcp-server/src/flag-registry.test.ts packages/mcp-server/src/admission.test.ts packages/mcp-server/src/http.admission.test.ts packages/mcp-server/src/observe.test.ts packages/mcp-server/src/event-sources.test.ts packages/mcp-server/src/event.test.ts packages/mcp-server/src/session-events.test.ts packages/audit/src/policy.test.ts packages/audit/src/record.test.ts` |
| Config-reference generation | `bun run config:reference` after registry changes, main only; this is a generated tracked document, not a new manual convention |
| Typecheck | `bunx tsc --noEmit --pretty false` |
| Lint | `bun run lint` (no automatic fixes) |
| Full repository gate | `bun run verify` when authorized; inspect its output, do not install dependencies from a sibling planner/executor |
| Durable prerequisite | Controlled non-production SUBSTRATE_TEST_PG_URL using existing guards; never print its value |
| Runtime/feedback latency | Not measured by this planner. timeout30000 is a per-test bound, not a claim that a whole suite finishes in30 seconds. Main records actual duration. |

The broad regression command is copied verbatim from71-VERIFICATION.md:17, which records1,076 passed/10 skipped for the preliminary implementation. That number is historical, not this plan's result, and is not directly comparable to the earlier575-test file set. All new commands are proposed runnable groups, not observed successful runs. Existing paths were located in source; new paths are expressly created by their owning plans.

### Gate sequencing and feedback sampling

1. Executors author implementation and tests in their assigned files without running checks mid-flight. New fixtures/suites are completed within their owning tasks before main invokes them; no empty test scaffold may stand in for acceptance.
2. After all slices integrate, main renders the config reference, then runs new authority/boundary/CLI targeted groups. Run controlled PostgreSQL groups before claiming restart/race/security durability; skipped evidence is a blocker for those truths.
3. Main runs the exact recorded regression command and the additional MCP/docs/brief/policy group, then authorized typecheck/lint/full repository gate. Avoid concurrent test processes against partially edited sources or the same test schema.
4. Record actual commands, test counts, skips/failures, duration and controlled-DB availability in the parent-owned verification record. Do not overwrite earlier failure evidence or claim production exercise.
5. Installed planning frontmatter/structure/decision/source-coverage gates and independent plan check remain parent responsibilities. No planner-side check was executed under this assignment's no-check contract.
6. Desk Quality/Programming Lead owns the Greptile gate; FAILED/SKIPPED/unavailable is a blocker, not a pass. Draft PR only; no merge/auto-merge/force push/branch deletion.

## Per-task automated verification map

Commands below are delegated to main after integration; every task contains a directly runnable automated command. No three-task blind interval exists in the validation design; actual sampling is centralized under the parent execution contract.

| Task | Plan/wave | Requirement | Threat refs | Secure behavior | Suite / command group | File exists | Status |
|---|---|---|---|---|---|---|---|
| 71-01-01 | 01/1 | HARD-S1 | T-71-01,03 | Committed independent issuance, hash-only row, real factory consumer and migration42 | Durable group | authority.pg NEW; migration contract existing | pending |
| 71-01-02 | 01/1 | HARD-S1 | T-71-01,02,03 | Immutable owner/repo, SQL-time lease, transactional state, terminal non-reuse across two pools | Durable group | authority unit/fixture NEW | pending |
| 71-02-01 | 02/1 | HARD-S1 | T-71-04,06 | open stores private proof atomically, does not print it, no overwrite/reset | CLI/hook group | binding-record suite NEW; client/index existing | pending |
| 71-02-02 | 02/1 | HARD-S1 | T-71-04,05 | Exact record/header, metadata-only discovery, typed denial terminates listen, unchanged operator body | CLI/hook group | existing | pending |
| 71-02-03 | 02/1 | HARD-S1 | T-71-04,05 | Stable historical checkpoint labels, separate live handle/proof and consumed-hint namespace | CLI/hook group | existing | pending |
| 71-03-01 | 03/2 | HARD-S1 | T-71-07,09,10,16,17 | Shared real transport boundary, uniform404/503, principal limit before lookup, hashed audits | New acceptance + quick boundary groups | boundary suite NEW; REST/gate existing | pending |
| 71-03-02 | 03/2 | HARD-S1 | T-71-07,08,12 | Docs/brief service and release gate, no private cache/snapshot/ETag bypass, public digest intact | Additional MCP/docs/brief + acceptance | existing suites; boundary NEW | pending |
| 71-03-03 | 03/2 | HARD-S1 | T-71-07,11,12 | Operator-only effects, ack-state race, explicit close only, bounded cross-process wait revoke | New acceptance + broad regression | existing suites; boundary NEW | pending |
| 71-04-01 | 04/3 | HARD-S1 | T-71-13,14,15,18 | Complete denial matrix, actual HTTP/CLI loopback, DB restart/outage/races | New acceptance + durable groups | isolation/restart/MCP steering NEW | pending |
| 71-04-02 | 04/3 | HARD-S1 | T-71-08,09,10,14 | Every old private fixture migrated; policy/config/audit/cache guards and historical/digest compatibility | Recorded broad + additional group | existing | pending |
| 71-04-03 | 04/3 | HARD-S1 | T-71-13,14 | Implemented contract/config/vocabulary and honest backup/rollback/OS boundary | Task03 policy/config/migration/hook command plus doc review | existing | pending |

All plans include T-71-SC: no install/new authentication service/new dependency. Threat IDs01-18 are unique within the phase; SC is the intentional repeated reserved ID. ASVS5.0 V7 Session Management, V8 Authorization and V16 Security Logging/Error Handling are guidance, not an audited-certification claim.

## Complete private-consumer and release matrix

For each applicable row, owner+proof succeeds; same-surface sibling missing/wrong proof, foreign surface, unknown well-shaped ID, expired and closed IDs share the same target-not-found result. Unknown/terminal operator targets also404. A correctly bound owner non-operator queue/ack remains403 operator-required; operator allowlist/confirm/audit stay separate. Initial syntax400/bearer401 and authority503 are not conflated with resource404.

| Entry point / helper | Authorization and release condition | Owning implementation | Acceptance tests |
|---|---|---|---|
| REST POST /steering/sessions; MCP docs_steering_session without ID | Principal bucket, authenticated immutable owner, server-only insert; one-time proof after commit | 01 +03 task1 | authority unit/PG, isolation, mcp.steering |
| MCP docs_steering_session supplied ID | Owner+proof, active SQL row, exact repo/previous state, transactional transition; never create unknown | 01 +03 task1 | mcp.steering, steering-wiring, authority.pg |
| REST heartbeat/close; MCP steering_session_heartbeat/close | Owner proof for heartbeat; owner proof or explicit operator for close; commit before success, terminal/no revive | 01 +03 task1 | isolation, authority.pg, restart.pg, CLI group |
| GET /steering/sessions / listSteeringSessions | SQL-filtered owner/repo/active before cap; unproved metadata only, private operator projection explicit | 01 +03 task1 | server.steering, steering-rest, isolation |
| MCP steering_list / listSteering | Shared proof boundary, returned checked state not raw follow-on registry lookup | 03 task1/3 | steering-tools, mcp.steering, isolation |
| GET /steering/directives / durableAcknowledgedFor | Gate before inbox/history, recheck SQL after awaited history before send | 03 task3 | isolation, server.steering, restart.pg |
| REST/MCP queue | Target gate then existing operator/allowlist/rate/confirm/audit semantics; no target effect on refusal | 03 task3 | steering-tools, REST/MCP isolation |
| REST/MCP acknowledgement and inferred target | Pure parse, mandatory principal admission before inbox target inference, bound existing target, old directive-only REST shape | 03 task3 | steering-rest, steering-tools, delivery, MCP isolation |
| SessionStatePort.applyTransition | Trusted caller/operation context and locked authoritative state; ack stands if transition loses race; no hint | 01 +03 task3 | steering-delivery, authority.pg, restart.pg |
| GET /steering/wait / SteeringWaiters | Gate before hold, bounded local/cross-process lease/revoke wake, SQL final check on directive/timeout/close/immediate path; no held SQL transaction | 03 task3 | waiters, server.steering, isolation/restart.pg |
| MCP/REST/direct Substrate.searchDocs; stored prompt augmentation | Explicit live handle/proof checked in shared service before stored directions are read or used; release recheck; no shared private-result cache | 03 task2 | steering-wiring, mcp.steering, docs-plane-hardening, isolation |
| steeringNoticeOf/docsContextOf/ledgerForContext | Checked live context only, exact live ID/owner filter, no historical-label private lookup, final async check | 03 task2 | docs-search, steering-wiring, isolation |
| brief/briefDetailed/briefConditional/liveBriefSections; REST /brief; MCP memory_brief | Separate trusted caller from attribution, gate before full/fast/cache/snapshot/304 paths and after awaits; no silent omitted-private success | 03 task2 | brief-sessions, brief-fast-path, mcp.brief, isolation |
| Substrate.emit session.end | Historical append only; no live create/bind/revoke side effect, including public victim ID under same token | 03 task3 | isolation, steering-wiring, session-state |
| NEW live transition/search/ended events -> generic REST/MCP events_query(include_payload=true) | Allowlisted public producer projection; no private directions/planning hashes/proofs/body/counts; historical query auth and existing rows unchanged | 03 task1/2 | event/session-events/docs-search plus actual REST and HTTP-MCP sibling queries in isolation |
| HTTP MCP handleMcp / REST auditedRest live wrappers / direct-service executeLiveCall | Mandatory batch principal reservation and target resolution before generic audit; one-use audited dispatch; admitted mutation audit before effect; no double charge; whole-batch failure semantics | 03 task1 | observe, real HTTP-MCP/REST isolation and direct-service audit-outage/batch tests |
| session_context, GET /session/context, Substrate.sessionContext | INTENTIONALLY public-redacted cross-session metadata and historical exclusion; authority.listMetadata, not fake operator caller or proof gate | 01 +03 task2 | session-context and session-context.service |
| CLI sessions/status/list/listen/heartbeat/close | Exact URL/surface/handle record; header proof, no sibling private fanout, terminal404 not old server | 02 tasks1/2 | CLI group and actual HTTP/CLI isolation tracer |
| CLI session hook / unconsumedHints / hook-config | Separate historical --session and live --steering-session; binding-file proof; no live handle means no private query | 02 task3 | hook/command/config/consumed suites |

### Side-effect and ordering assertions

- Principal-keyed mandatory read/write bucket runs before binding lookup, metadata count/list, directive-target inference AND both generic audit and refusal audit. For HTTP MCP: existing general admitBatch -> service.prepareLiveBatch for all live calls -> service.auditPreparedBatch using the injected original auditToolCalls port -> request-local one-use dispatch -> final SQL check/effect/release. REST live wrappers and direct-service calls enter executeLiveCall, which prepares and invokes the same required audit itself when no matching audited dispatch exists.429 performs no lookup or audit; target denial cannot be replaced by generic audit outage. Admitted required-audit mutations still fail closed before effect; no recheck or prepared dispatch double-charges/re-audits. Existing non-live batch audit, fail-closed-first sorting, whole-batch auditRefusal and per-graph corrections remain intact.
- Refusal events and generic audit context contain only hashed live target identification, not raw requested session/directive ID, proof or body. observe.ts currently copies session_id into generic context; tests must cover that interceptor as well as steering.refused. Historical audit session labels stay historical. Canonical argument values remain only a digest; proof is never separately serialized.
- NEW server-emitted live transition/search/ended events use an allowlist at their real producers, including event.ts steeringSessionPayload, session-state/service and both docs-search note paths. No raw/nested steering/planning_hash/proof/proof-hash/directive body/count/privately augmented query reaches shared events_query payloads. Real sibling REST and HTTP-MCP include_payload=true queries verify emitted rows. Generic historical query authorization and old ledger rows remain unchanged; no retroactive confidentiality claim.
- Public proof-free metadata cannot include steering text, planning_hash or private directive counts. Proof/hash never appears in reusable snapshots, discovery, digest, prompts, metrics, cache keys/values, event payloads, thrown messages or CLI output. Issuance is the sole proof-bearing server response; the CLI projects it into a0600 file, not console JSON.
- SQL-time lease checks apply after mutation lock acquisition, across two stores and after awaits; an old transaction timestamp, forged request timestamp, old cache save or presence scan cannot renew/reopen. Only owner-proof activity/heartbeat renews, never operator observation/queue/ack.
- Close/expiry winning before a read's final check yields404; authority failure503. No private bytes are released on failed final check. A read already authorized and released before concurrent close cannot be retracted; tests/documentation use this explicit linearization boundary.
- Two-stage acknowledgement remains honest: accepted audited acknowledgement may stand while its state transition is refused; no checkpoint hint or transition note is fabricated. No new cross-store rollback or idempotency protocol is introduced.

## Wave0 test work included in owning tasks

No separate empty scaffold plan or dependency installation. Before main's first run, the corresponding owner must deliver real suites/fixtures:

- 71-01: planning/live-session-authority.test.ts, planning/live-session-authority.pg.test.ts and planning/live-session.test-support.ts; real SQL integration with existing SUBSTRATE_TEST_PG_URL guard.
- 71-02: steer/binding-record.test.ts plus all actual CLI/hook port/record/proof tests; isolated temp dirs and injected network credentials, no real token-file fallback.
- 71-03: live-session-boundary.test.ts invokes real consumer orchestration, including limiter and final-check spies.
- 71-04: live-session-isolation.test.ts, live-session-restart.pg.test.ts and mcp.steering.test.ts; old granting fixtures and ownership403 expectations migrated with the complete matrix, not selectively removed.

No existing service/private fixture may gain authority solely from a public put/set or historical event. Cache-only tests may exercise legacy cache mechanics explicitly, never as private authorization proof. Missing DB credentials/environment remains a specific parent-owned prerequisite, not permission to mark skipped durable tests green.

## Multi-source coverage audit

Local S1-* labels below are research-derived facets of the actual upstream requirement HARD-S1, not new upstream requirement IDs. The other seven accepted features remain assigned to phases72-78 and are neither silently implemented nor marked complete by this plan set.

| Source | ID / criterion | Coverage | Plan/tasks | Status |
|---|---|---|---|---|
| GOAL | Phase71 authenticated live read/write binding | SQL proof+caller boundary in every private consumer | 01 all;03 all;04 task1/2 | COVERED |
| GOAL | Foreign/unknown not-found indistinguishability | Common404 object/status/headers, no effects or audit-dependent field | 03 task1/3;04 task1/2 | COVERED |
| GOAL | Unguessable never-reused identities | Independent32-byte CSPRNG values, global PK, terminal records | 01 all;04 task1 | COVERED |
| GOAL | Operator-only writes and redacted digest preserved | Explicit operator policy, unchanged unkeyed shape, separate metadata projection | 02 task2;03 task2/3;04 task2/3 | COVERED |
| GOAL | Roadmap success1: all named private routes/tools/async consumers404 | Full consumer matrix above, including docs registration/augmentation and wait | 03 all;04 task1/2 | COVERED |
| GOAL | Roadmap success2: operator overrides, hash audits and prelookup limiter | Explicit operation policy, bounded local caller bucket, refusal and generic-audit protections | 03 task1/3;04 task2 | COVERED |
| GOAL | Roadmap success3: randomness/durable tombstones/restart/failclosed | Migration42 mandatory, SQL authority with no cached grant, controlled DB tests | 01 all;03 task1;04 task1 | COVERED |
| GOAL | Roadmap success4: queue/ack/unkeyed/caller migration/no alias | CLI/hook cutover and no historical or registry authorization alias | 02 all;03 all;04 task2/3 | COVERED |
| GOAL | Roadmap success5: unchanged digest and recorded regression/new failure cases | Existing digest fixtures, exact broad command plus new groups, parent evidence | 03 task2;04 all | COVERED |
| REQ | HARD-S1 each private operation rechecks per-session binding | Shared service/SQL boundary and post-await reauthorization | 01/03/04 | COVERED |
| REQ | HARD-S1 independent CSPRNG ID and proof | Exact32-byte formats, no derivation from token/ID | 01 task1;02 task1;04 task1 | COVERED |
| REQ | HARD-S1 durable owner/revoke/tombstone, no takeover/reuse after restart | Row locks, insert-only issuance, no delete/transfer, cache-independent restart | 01 all;03 task3;04 task1 | COVERED |
| REQ | HARD-S1 foreign/unknown/wrong-proof/expired/closed same404 | Complete same-surface and foreign denial matrix | 03 task1;04 task1 | COVERED |
| REQ | HARD-S1 hash-only authority; no proof logs/discovery/cache/prompts | Strict projections, server audit protection, client private records, capture assertions | 01/02/03;04 task2 | COVERED |
| REQ | HARD-S1 public digest and historical labels separate | Dedicated listMetadata, mixed-request split, explicit close, stable checkpoints | 01/02 task3/03 task2/3/04 | COVERED |
| REQ | v1.8 delivery: context/plans/summary/exercised test-lint-types/no new dep/operator gates | Current context/plans plus required summaries, main-run verification and gates | All plans;04 verification | COVERED |
| RESEARCH | S1-IDENTITY / selected alternative3 | No surface-only recommendation; full independent proof contract and lost-proof behavior | 01/02/03 task1 | COVERED |
| RESEARCH | S1-BINDING complete caller map | Every row named above reaches one service gate; no raw follow-on registry lookup | 03 all;04 task1/2 | COVERED |
| RESEARCH | S1-NOTFOUND and typed unavailable | Uniform404; no schema-required proof oracle; sanitized503 when authority absent | 03 task1/2;04 task1/2 | COVERED |
| RESEARCH | S1-DURABLE migration42, immutable digests and authority recovery | New table/factory, cache distinction, archive exclusion and native security backup | 01 all;04 task1/3 | COVERED |
| RESEARCH | S1-LIVENESS policy/races/waits | Dedicated3600s lease, SQL time, terminal expiry/close, <=1000ms internal wait recheck | 01 task2;02 task2;03 task1/3;04 task1/3 | COVERED |
| RESEARCH | S1-LIMITER | Always-enforced bounded principal map; before target/directive lookup, no second token on release | 03 task1/3;04 task2 | COVERED |
| RESEARCH | S1-AUDIT | Domain-separated requested-ID hash, no raw target in warning or generic live audit context | 03 task1;04 task2/3 | COVERED |
| RESEARCH | S1-COMPAT operator/unkeyed/state/historical/cache boundaries | Existing inbox/nextSteeringSession reused; deliberate create/proof cutover; historical APIs preserved | 01/02/03/04 | COVERED |
| RESEARCH | Config, audit, route and generated reference parity | Typed bounded lease reader/flag row/env/reference; method-aware admission; lifecycle audit/observe labels | 03 task1;04 task2/3 | COVERED |
| RESEARCH | Runtime state inventory / legacy migration | No legacy active backfill; update print-only templates; no deployment/OS change; docs state unobserved production | 01/02 task3/04 task3 | COVERED |
| RESEARCH | New auth/dependency avoidance | Existing surface bearer/operator, node:crypto, Bun SQL; no auth service/new package | All threat models | COVERED |
| RESEARCH | Old A1 identity question | Resolved by owner D71-08; no new checkpoint | All interfaces | COVERED |
| RESEARCH | A2 lease discretion / A3 production recovery not observed | Final lease bounds/cadence documented; controlled DB evidence required, production explicitly not claimed | 03 interfaces;04 task1/3 | COVERED |
| CONTEXT | D71-01 accepted eight features, retain unkeyed | HARD-S1 fully planned; seven other features remain their phases; queue/ack bodies preserved | 02 task2;03 task3;04 | COVERED |
| CONTEXT | D71-02 approved installed available-tool workflows | Independent planner artifacts, dependencies, summaries, parent gates; no provider-auth workaround | All context/output sections | COVERED |
| CONTEXT | D71-03 surface bearer/operator, no new service | Bearer-derived caller, fixed operator policies, existing store patterns | 01/03 | COVERED |
| CONTEXT | D71-04 identical404 and hashed refusal ID | Common result/headers; hash-only warning and generic audit metadata tests | 03 task1;04 task1/2 | COVERED |
| CONTEXT | D71-05 server issuance, durable non-reuse, no volatile authority | Always-migrated SQL authority and failure-injection | 01 all;03 task1;04 task1 | COVERED |
| CONTEXT | D71-06 unchanged public cross-session digest | Dedicated safe metadata source and unchanged assembler/tests | 01 listMetadata;03 task2;04 task2/3 | COVERED |
| CONTEXT | D71-07 no deploy/production migration/timers/funding/devnet; draft PR | Explicit restrictions and parent-only gates, no operational action in tasks | All context/verification;04 task3 | COVERED |
| CONTEXT | D71-08 independent session binding credential selected | Wire names, one-time proof/hash-only authority, every client/consumer, private records, no reset | 01/02/03/04 | COVERED |
| CONTEXT | D71-09 ID is metadata, independent32-byte values, same-OS limit | Crypto contract, sibling-ID tests, secure local record and explicit OS limitation | 01 task1;02;04 task1/3 | COVERED |
| CONTEXT | D71-10 historical/live separate, no implicit historical revocation | Mixed fields, explicit live close only, hook split and historical API regressions | 02 task3;03 task2/3;04 | COVERED |
| VERIFICATION | Gaps1-7 | 404, issuance, durable authority, consumer coverage, hashed audits, prelookup limiter, proper execution artifacts | 01-04 and this strategy | COVERED |
| SECURITY REVIEW | Six evidenced findings | Sibling/duplicate-ID impersonation; discovery text/counts; docs bypass; historical-end revoke; cache authority; wait release/cross-process | 01/02/03 all;04 task1/2 | COVERED |
| PLAN CHECK | Shared-ledger new-live-event escape | Public-safe allowlisted new-event producers, no historical auth redesign, actual sibling REST/HTTP-MCP include_payload tests | 03 task1/2;04 task1/2/3 | COVERED |
| PLAN CHECK | Generic audit interceptors precede boundary | Concrete prepareLiveBatch/auditPreparedBatch/executeLiveCall plus injected LiveSessionAuditPort, actual callsite migration, one-use request dispatch, batch/direct-service/outage/429 tests | 03 task1;04 task1/2/3 | COVERED |
| PLAN CHECK | Per-task required inputs and portable artifacts | Explicit read_first on all11 tasks, new files marked NEW, repository-relative references with checkout selected externally | All four plans and this strategy | COVERED |

No source item assigned to Phase71 is missing. Deferred Phase72-78 features are excluded by current CONTEXT, not waived. No phase or milestone is marked complete by this planning artifact.

## Manual/operator-only items and release limits

All in-phase functional/security behaviors have automated test cases. The following are deliberately NOT executed or certified here: production migration/rehearsal, actual complete-security-state backup/restore, real host hook/timer installation and delivery, enabling flags/issuing real credentials, deploy and external review/merge gates. Existing runbooks must state those operator prerequisites and the non-reuse limitation after lost/stale tombstones. Same-OS-account filesystem compromise is outside network session isolation, not a promised sandbox.

## Validation sign-off — pending main evidence

- [ ] New authority/boundary/record/matrix suites and issuance fixture exist with real assertions, not stubs.
- [ ] All task commands run from the specified worktree after integration; actual pass/skip/fail counts and durations recorded.
- [ ] Controlled PostgreSQL migration/restart/two-pool race/failure cases exercised, not skipped.
- [ ] Complete REST/MCP/service/CLI matrix covers all denied target variants and async release paths.
- [ ] Newly emitted public live-event payloads pass actual sibling REST/HTTP-MCP include_payload queries; historical authorization/old rows remain unchanged.
- [ ] Real MCP interception, REST wrappers and direct-service paths prove preflight-before-audit, required-audit-before-effect, no lookup/audit on429, no double-charge and whole-batch corrections.
- [ ] Recorded broad command and additional MCP/docs/brief/policy/CLI suites exercised.
- [ ] Authorized typecheck/lint/full repository gates and generated config parity pass without hiding failures.
- [ ] Independent plan/security/review gates handled by parent; unavailable Greptile remains a blocker.
- [ ] Four execution summaries and updated parent verification/requirements/state exist with truthful evidence.
- [ ] Only after those conditions: update wave_0_complete/nyquist_compliant/status as warranted; do not set them during planning.

Approval: pending parent execution and gate evidence.
