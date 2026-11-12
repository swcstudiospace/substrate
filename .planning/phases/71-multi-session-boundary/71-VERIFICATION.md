---
phase: 71-multi-session-boundary
verified: "2026-10-31"
status: human_needed
local_status: passed
score: "5/5 roadmap success criteria verified locally"
requirements_verified_locally: [HARD-S1]
behavior_unverified: 0
behavior_unverified_items: []
gaps: []
overrides_applied: 0
external_gate: "Desk Quality / Programming Lead review WAIVED by the user on 2026-11-12 (answers what=not_real, needs=greptile_only). Remaining gate: Greptile review with no open threads, not yet observed."
human_verification:
  - item: "Greptile review of the phase 71 remediation on PR #199 reaches 5/5 with no open threads"
    expected: "Review observed; findings addressed; a FAILED, SKIPPED or unavailable review is not a pass"
    reason: "Greptile is the only remaining delivery gate after the user's Desk waiver"
    status: "open"
  - item: "Local gates re-run 2026-11-12 at commit 033c9694 (docs-only change after code commit 067f094b)"
    expected: "bunx tsc --noEmit exit 0; bun run lint exit 0 (1727 files); bun run check:phase-close exit 0; npm run test:py 341 passed"
    reason: "Recorded as evidence for the waiver; full bun test was last run at 067f094b (11,901 pass, 0 fail, 282 skip)"
    status: "passed"
---

# Phase 71: Multi-Session Boundary — Independent Verification

**Goal:** Enforce authenticated bindings on private live-session reads/writes; make foreign and unknown targets indistinguishable; issue unguessable, never-reused live identities; preserve operator-only steering writes and the redacted repository-wide context digest.

**Decision: local implementation and exercised acceptance PASSED; overall sign-off HUMAN_NEEDED.** All five corrected roadmap success criteria and HARD-S1 are met within the isolated local scope described below. No remaining evidence-backed implementation gap was found. This is **not** an external-review pass, a deployment/recovery certification, phase-completion authorization, or a merge-ready claim. `71-VALIDATION.md` requires the Desk Quality / Programming Lead Greptile gate; no successful review of the new draft is observed. That outstanding delivery gate is why the overall status is `human_needed`, despite the local score of 5/5.

## Evidence boundary and method

Independent goal-backward inspection used the installed verifier role, `71-CONTEXT.md` decisions D71-01..10, `.planning/REQUIREMENTS.md` HARD-S1 and delivery requirements, corrected `.planning/ROADMAP.md` Phase 71, all four PLAN/SUMMARY pairs, `71-04-DOCS-SUMMARY.md`, `71-VALIDATION.md`, the previous verification, implemented consumers, substantive test assertions, and the parent's actual final log outputs. Execution summaries were treated as implementation inventories, **not** proof of passing tests. Their earlier pending/failed wording is retained history, superseded for local execution only by the final evidence here.

This verifier ran **no** tests, builds, linters, formatters, installations, runtime probes, SQL commands, git writes, or production operations. Only this report was written. Counts below are parent-executed results, inspected from the supplied logs. Ephemeral log locations and credential paths are intentionally not repository links; evidence is identified by command label, output, and repository-relative source/test paths. No verification fingerprint or automated decision-coverage command was executed or fabricated.

## Goal achievement

### Corrected roadmap success criteria

| # | Required truth | Status | Substantive implementation and exercised evidence |
|---|---|---|---|
| 1 | Every private read/write has indistinguishable not-found denial and no refused effects, including directives, wait, MCP, docs transitions and augmentation | VERIFIED locally | `packages/mcp-server/src/planning/steering-tools.ts` provides the shared typed refusal and checked boundary. `service.ts` routes lifecycle, directives, waits, docs and brief through it; `server.ts` and `mcp.ts` call those consumers. `live-session-isolation.test.ts` compares status, body and application headers across missing/wrong/sibling proof, foreign surface, unknown, expired and closed targets; checks inbox/audit effect counts and unchanged authority state. `mcp.steering.test.ts` exercises the actual HTTP MCP interceptor and registered tools. These cases passed in the 602-test acceptance rerun and final root suite. |
| 2 | Explicit operator permissions remain; refusal audit is hash-only; principal admission precedes lookup | VERIFIED locally | `LiveSessionBoundary.reserve/prepareBatch/prepareReserved` charges surface/read-write buckets before authority or directive inference. `service.ts` prepares before its injected generic audit, consumes one-use argument/caller-bound dispatch entries, and rechecks before effects. `observe.ts` omits private live targets from plaintext generic context. Actual REST/HTTP-MCP/direct-service tests passed for off/shadow/cache-outage limiting, no lookup/audit on 429, target refusal before audit outage, required-audit-before-effect, duplicate invocations, batch cancellation and preserved historical batches. Operator private-read/close/queue/ack overrides are explicit; owner transition/heartbeat cannot borrow them. |
| 3 | CSPRNG identities, durable owner/tombstone/non-reuse across restart, unavailable authority fails closed | VERIFIED locally | `planning/steering-sessions-store.ts` independently draws two 32-byte values, hashes proof with a separate domain, inserts without upsert, bounds collision retries, locks rows and obtains SQL wall time after the lock. `index-store.ts` migration 42 and `IndexStore.liveSessions` are real mandatory factory wiring. Controlled PostgreSQL authority/restart suites actually passed with independent pools, cache migration off, reconnect, collisions, expiry-after-lock, close races, legacy rows, missing schema, disconnected authority and lost commit responses. No in-memory helper is used as the durability proof. |
| 4 | Operator queue/ack and legacy unkeyed shapes preserved; all affected callers migrate without bypass aliases | VERIFIED locally | Queue/ack retain existing inbox allowlist/confirmation/audit policy through `queueSteering` and `acknowledgeSteeringWithState`; REST acknowledgement still infers the target from the directive only after principal admission. CLI `steer/index.ts`, `steer/client.ts`, private `binding-record.ts` and session hook consumers use exact selected credentials. Historical labels remain separate. Removed registry/cache granting APIs and TTL configuration are not compatibility authorization shims. CLI/HTTP tracer, actual native CLI smoke, hook/client tests, steering/delivery tests and root regression passed. |
| 5 | Public-redacted context preserved; steering regression and new isolation/revocation/restart cases exercised | VERIFIED locally | `service.ts` uses `authority.listMetadata` for public context, not fake operator credentials; `session-context.ts` remains the public assembler. Existing digest, historical/public and operator tests run in the final complete root suite. New release tests cover docs retrieval/ledger awaits, brief full/fast/snapshot/last-good/conditional paths, durable history and held/immediate/queued/timeout/closed waits. Final root result: 11,596 pass, 2 unrelated opt-in skips, 0 fail. Acceptance rerun: 602 pass, 0 fail, no skips. |

**Local score: 5/5.** No truth is credited solely for file existence, export presence, mocked route success, a proposed command, or an earlier preliminary pass.

### Original S1 facets and accepted protocol

The S1-* names are the research/validation facets of **HARD-S1**, not additional upstream requirements.

| Facet | Met/unmet locally | Evidence and scope |
|---|---|---|
| S1-IDENTITY | MET | Server-only issuance in `planning/steering-sessions-store.ts`; independent 256-bit public ID/private proof, domain-separated hash and timing-safe fixed-length comparison. Authority unit/PG tests cover entropy failure, active/terminal collisions, bounded exhaustion and no caller-selected adoption. |
| S1-BINDING | MET | SQL read/transition/heartbeat/close plus shared boundary on actual REST/MCP/service consumers. Same-surface sibling isolation requires proof even when the public ID is discovered. Direct docs/brief calls without trusted live context refuse; historical attribution alone grants nothing. |
| S1-NOTFOUND | MET | Common `{status:"refused",error:{code:"not-found"}}`; REST 404 and equal application headers, MCP same typed tool result with `isError` in its normal JSON-RPC envelope. MCP HTTP itself remains the normal transport status, not a fabricated REST 404. Syntax 400, bearer 401, operator-required 403, principal 429 and authority 503 remain separate. |
| S1-DURABLE | MET | Mandatory migration 42 `live_session_bindings`, global primary key, immutable adapter owner/repo, retained terminal rows, no legacy backfill or runtime cache grant. Controlled PG reconstructs separate services/pools and preserves active state and tombstones. Applied migration digest contract passes; parent records versions 1..41 unchanged, 42 appended. Non-reuse depends on retaining complete authority history; lost/stale backup is not covered. |
| S1-LIVENESS | MET | SQL wall clock after row lock; owner-proof heartbeat/ordinary transition renew, operator observation/queue/ack do not. Closed/expired identity cannot revive. Bounded wait rechecks use at most 1000 ms slices and no transaction held across socket wait. Controlled independent-instance close/expiry/outage release cases and cleanup passed. |
| S1-LIMITER | MET | Mandatory bounded principal/class map in `planning/steering-tools.ts`, independent of general admission/cache. HTTP MCP reserves all live costs before target resolution; release rechecks do not recharge. Spies and actual transport tests assert zero target/inference/audit work after 429. |
| S1-AUDIT | MET | `target_sha256` uses the refusal-specific domain; no raw requested live identifier/body/proof in refusal fields. Generic live audit context excludes live `session_id`; canonical argument values remain a digest, not plaintext. Real generic audit delegation is injected in `index.ts`. Refused target remains identical if refusal/generic sinks fail; admitted required mutations fail closed. |
| S1-COMPAT | MET | Operator-only unkeyed queue/ack/confirm/allowlist and public-redacted context retained. CLI/hooks explicitly distinguish historical `--session` from live `--steering-session`; exact URL/surface/handle record selection, no sibling fanout, no proof argv/reset. Existing historical event/checkpoint/query authorization and previously published rows remain unchanged; no retroactive confidentiality is claimed. |
| HARD-S1 proof privacy | MET | SQL stores only proof hash; public discovery selects metadata only, including for operators. Private docs bypass shared docs/memory-result storage, brief private sections stay outside reusable snapshots, proof is absent from prompts/events/audit/cache/output. Actual producer/query tests inspect new transition/ack/retrieval/close events through sibling REST and HTTP MCP payload queries. Native CLI confirms proof not printed and retained file 0600 then removed on close. |

**Requirements coverage:** HARD-S1 is locally satisfied, with no waived facet. Phases 72..78 and the eight-feature milestone/audit are not certified by this report.

## Artifact substance and consumer reachability

| Producer / artifact | Real consumer / key link | Verification result |
|---|---|---|
| `index-store.ts` migration 42 and `liveSessions()` | `Substrate` constructor → `bunLiveSessionAuthority` on the existing SQL pool | WIRED. Migration is additive, not opt-in; authority failures do not grant from cache. Controlled factory/PG/restart cases exercise this exact path. |
| `planning/steering-sessions-store.ts` seven-method authority | Boundary reads; lifecycle mutations; caller-filtered discovery; public `listMetadata` | SUBSTANTIVE + WIRED. Real transactional insert/read/update/heartbeat/terminal close/list queries, not an unused port. |
| `planning/steering-tools.ts` and `service.ts` | REST handlers; registered MCP wrappers; direct service methods | WIRED. `prepareLiveBatch` → `auditPreparedBatch` → one-use `executeLiveCall` → final SQL check/effect. Missing/failed required audit is a typed refusal, not no-op success. |
| `server.ts`, `mcp.ts`, production `index.ts` | Header-only REST proof; validated MCP proof; trusted bearer caller; original audit implementation | WIRED. Native/real HTTP plus HTTP MCP tests cover transport and interception, not helper-only invocation. |
| `service.ts` docs/brief/directives/wait orchestration | Checked snapshot before private retrieval/augmentation; recheck after retrieval/history/cache/brief/wait awaits | WIRED. Private denial escapes degraded/fallback/ETag paths; test barriers close/expire/fail authority before final release. |
| `planning/session-state.ts`, steering delivery/waiters | Authoritative acknowledgement-driven transitions; explicit close wakes; independent-instance SQL polling | WIRED. Ack may remain effective while transition refuses; no fabricated hint. No historical session-end revocation or writable registry remains. |
| `event.ts` safe payload and service/docs producers; `observe.ts` context policy | Actual new ledger events and generic audit sink → sibling historical queries | WIRED. Safe allowlists are used at real producers; actual queried rows omit synthetic private markers. Historical query authorization and old rows are intentionally unchanged. |
| CLI `steer/{index,client,binding-record}.ts` | Native CLI entrypoint and `session/hook.ts` | WIRED. Exact record validation, atomic private persistence, proof header, typed terminal refusal, heartbeat expiry update, matching removal on close. Native smoke adds actual process-to-HTTP-to-PG evidence. |
| Existing runbooks, environment/config reference | Implemented lifecycle/recovery/operator procedures | SUBSTANTIVE. `docs/live-steering.md`, `docs/data-planes.md`, `docs/event-vocabulary.md`, `docs/coordination.md`, `docs/runbooks/{session-rollback,index-archive,rollback-compat}.md`, `.env.example`, `docs/config-reference.md` document the cutover, lease and real limits. Their unverified wording is an earlier publication-state caveat, not production evidence. |

### Concurrency and truthful receipts

The final accepted distinction is enforced and exercised: **private reads linearize at the final authority check; committed writes return truthful public metadata receipts**. A later close/outage does not turn an already committed queue/update/renewal into a false no-effect 404. Issuance returns the once-only creator proof even if a concurrent close already made it terminal; it cannot revive that identity. Acknowledgement already committed is not rolled back if subsequent state movement refuses; movement already committed remains truthfully reported, while a failed final check withholds its private checkpoint hint.

The actual queue-race probe initially returned not-found with one retained inbox record; after correction the unchanged probe returned `{"response":"queued","queued":1}`. Permanent REST queue/issuance receipt tests and controlled two-pool transition/queue/heartbeat/close races passed in the final evidence. This is not a new distributed transaction, automatic retry, proof recovery or rollback guarantee.

## Checks actually exercised by parent — final evidence

| Command / evidence label | Observed result | What it proves / limitation |
|---|---|---|
| Frozen dependency install | PASS, parent-attested | Existing frozen lock installation prerequisite; not run by this verifier, no new dependency claimed. |
| Final acceptance rerun, `bun test --timeout 30000` over the 14 acceptance/authority/CLI files | **602 pass, 0 fail**, 4,043 assertions, **39.10 s**, no skips | Includes actual HTTP/MCP/CLI consumer matrices, lifecycle/private records/hooks, authority unit tests and controlled PG authority/restart suites. |
| Final complete root Bun suite | **11,596 pass, 2 skip, 0 fail**; 11,598 tests across **427 files**, 214,985 assertions, **360.84 s** | Covers the existing planning/steering/server/digest/brief/CLI regression file set and additional MCP/docs/policy/config/audit/migration cases. This is the final full-root run, not a claim that the earlier broad command independently reported these counts. |
| Remaining repository components: `bun scripts/verify.ts --skip "install,tests" --keep-going` | **PASS: types, lint, python, locks** | Final log: Typecheck 22.7 s; Biome 1.3 s, **0 warnings/0 infos**; Python miner/dispatcher 3.3 s; repo locks 1.1 s. |
| Native CLI smoke, actual `packages/cli/src/index.ts` process against ephemeral HTTP + native PostgreSQL 16 / real IndexStore, migration 42 and durable inbox SQL audit | `cliOpen:0`, `cliList:0`, `cliHeartbeat:0`, `cliClose:0`; closed list exit **3**; same-surface unproved **404**; old closed proof **404**; file **0600**, removed; durable tombstone **true**, hash-only **true**, proof printed **false** | Real native entrypoint evidence beyond the in-runner command tracer. Not a deployed endpoint or real host credential test. |
| Independent `Phase71CodeSecurity` source review | Parent reports no remaining evidence-backed findings after final corrections | SOURCE ONLY. Not an executed security probe, independent test run, or Desk Quality Greptile gate. |

The two final root skips are precisely the externally guarded rehearsal-twin round-trip and live Redis conformance (`SUBSTRATE_CONFORMANCE_REDIS_URL` unset). **Neither is a PostgreSQL S1 case.** Controlled PostgreSQL authority and service-restart cases have explicit passing rows in both the acceptance rerun and final root run; they are not silently credited from skip-capable test declarations.

The original single `bun run verify` attempt timed out its test step; it is **not** recorded as a successful monolithic command. Final gate recovery comprises the complete successful root test run plus separately successful frozen install and remaining repository components. No omitted test failure is hidden by `--skip "install,tests"`.

### Test-quality assessment

| Coverage family | Evidence strength | Disposition |
|---|---|---|
| `live-session-isolation.test.ts`, `mcp.steering.test.ts`, `live-session-boundary.test.ts` | Multi-step real HTTP/registered-MCP workflows; exact refusal fingerprints; no-effect/sink/lookup assertions; emitted event queries | Behavioral/value-level, exercised, not existence-only. Deterministic authority seams test policy; they are not offered as SQL durability proof. |
| `planning/live-session-authority.pg.test.ts`, `live-session-restart.pg.test.ts` | Actual migration/factory, independent pools/services, reconstructed authority, SQL rows and deterministic lock/release barriers | Behavioral durable proof, exercised with no S1 skips; no shared-map substitute. |
| `brief-fast-path.test.ts`, steering/delivery/waiter suites | Close/expiry/outage during full/fast/snapshot/last-good/conditional release; ack effect/state/hint correlation and cleanup | Behavioral invariant coverage passed in final root run. |
| CLI binding/client/index/hook suites and native smoke | File permissions/content/selection/overwrite safety; header/output secrecy; retained proof across heartbeat; removal/terminal refusal; historical split | Behavioral filesystem/transport coverage, plus actual native process evidence. |
| Existing digest, migration-contract, policy/config/audit/event suites | Public output/provenance/caps, digest fixture enforcement, explicit safe projections, method classes and audit policy | Existing regression coverage passed. Digest consistency alone is not the claim that earlier baseline history is immutable; that also relies on the parent's preserved 1..41 change inventory. |

No disabled-only S1 requirement, circular generated-expected-output proof, helper-only substitute, or insufficient existence-only assertion was identified in the inspected acceptance sources. PG guards exist but their cases actually ran. Scoped incomplete-marker inspection found no TODO/FIXME/TBD/XXX/placeholder/disabled-test markers in the authority, boundary, state port, principal acceptance suites or credential-record implementation. This is scoped inspection, not a claim that every repository line was audited.

## Decision coverage

Source/artifact inspection honors D71-01..10: retain unkeyed/operator policy and seven other phases; use approved available-tool GSD artifacts; reuse bearer/operator/index infrastructure; uniform denial/hash audit; mandatory server issuance and durable terminal authority; public digest unchanged; no operational production actions; separate per-session credential and migrated callers; independent 32-byte values/public ID/OS limitation; explicit historical/live separation. No decision is silently replaced by the research's superseded surface-only alternative. Automated decision-coverage tooling was not run, so no machine-gate count is claimed.

Parent reconciliation remains necessary for stale ROADMAP/REQUIREMENTS/STATE/VALIDATION/SUMMARY completion flags. This verifier intentionally changes none of those files and does not infer completed status from their existence.

## External / operator gates still outstanding

1. **BLOCKER TO UNQUALIFIED DELIVERY SIGN-OFF: mandated draft review.** Parent must open the draft PR into the default branch and route it through Desk Quality / Programming Lead's Greptile gate. No successful new-draft review is observed. Address findings and record the actual outcome; unavailable, skipped or failed review stays a blocker. Independent source review cannot substitute. **No merge, auto-merge, force-push or branch deletion.**
2. **Not exercised, operator-gated:** deployed migration/rehearsal, complete PostgreSQL-native backup/restore including every issued identity/tombstone, real host hooks/timers and delivery, real credential/flag enablement, deployment/funding/devnet. These are explicit release/environment exclusions, not missing local S1 implementation tests. Do not mark them green from the controlled PG/native CLI result.
3. **Recovery limit:** the closed logical archive does not cover live bindings/tombstones. Lost or stale tombstone history cannot be declared safe for identity reuse; quiescence/complete-history recovery and invalidating restored active credentials remain operator procedures in the runbooks. Same-OS-account/root record compromise is outside the network-session isolation guarantee.

**Implementation gaps:** none found within the accepted local contract. **External gap:** review evidence/sign-off unavailable. No new implementation gap-closure plan is recommended solely for that external gate. Other hardening phases and the milestone audit remain separate.

### Advisory (new scope, unevidenced)

None. No speculative architecture concern was promoted into a new blocker or used to narrow the accepted criteria.

## Dated history — earlier gaps and gate recovery (2026-10-31)

### Preliminary ownership-gate verification: gaps_found

These are **historical results for preliminary code**, not evidence for the final credential cutover:

| Earlier check | Earlier observed result |
|---|---|
| Targeted ownership/steering HTTP tests, 7 files | 177 passed, zero failed |
| Broader planning/steering/session-context/brief/CLI/hook tests, 38 files | 1,076 passed, 10 skipped, zero failed |
| `bunx tsc --noEmit --pretty false` | Passed after missing fixture-port repair |
| `bun run lint` | Passed; no fixes applied |
| Real ephemeral HTTP server | Owner 200; foreign 403; unknown 403; equal foreign/unknown JSON bodies |

The historical broader command was:

```text
bun test --timeout 30000 packages/mcp-server/src/planning packages/mcp-server/src/server.steering.test.ts packages/mcp-server/src/session-context.test.ts packages/mcp-server/src/brief-sessions.test.ts packages/cli/src/steer packages/cli/src/session/hook.test.ts
```

It was not identical to the archived 575-test/7-skip baseline; their counts cannot be compared as identical suites. No live production stores/deployed endpoint were exercised.

Seven original gaps were: (1) 403 instead of required 404; (2) caller-chosen reusable identities; (3) process-local authority with best-effort persistence; (4) incomplete docs/live-consumer map; (5) raw requested identifiers in refusal audit; (6) unproven principal-before-lookup ordering; (7) missing CONTEXT/PLAN execution sequence. The current source, four plans/summaries and final exercised evidence close those local gaps; the earlier passes did not.

**Original launcher recovery:** the detached three-worktree gate launcher never created its logs. Its watcher was stopped; the claimed launch was not validation evidence. Fresh tracked checks produced the preliminary results above. No implementation phase or milestone was marked complete by that historical record.

### Integrated failures and later recovery

The first integrated acceptance run was **588 pass / 13 fail** across 14 files, with typecheck/lint failures. Its subsequent fixture/parser corrections and narrow 107-test pass were not a full-gate pass. A repository-wrapper test step later timed out at **900.1 s**; a subsequent complete root run reported **11,574 pass / 22 fail / 2 skip**. Those are retained failures, not relabeled green. Corrections included real fixture transport/timestamp issues, missed partial-index test seams, and restoration of ordinary untokened REST brief attribution compatibility without changing trusted live authorization.

Only the final rerun outputs in the evidence table establish current local passing status: acceptance **602/0**, root **11,596 pass / 2 unrelated skips / 0 fail**, and **types/lint/python/locks passed**, followed by the actual native CLI smoke. No previous code's pass, narrow correction run, unlogged launch, or source-only review is used as a substitute.
