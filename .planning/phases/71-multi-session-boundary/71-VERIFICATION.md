---
phase: 71-multi-session-boundary
verified: "2026-11-06T00:44:16Z"
status: human_needed
score: "5/5 roadmap success criteria verified on this tree (HEAD a46d42c3); the PostgreSQL restart, authority and idempotency clauses are re-cited by suite name from the gate r36 JUnit report (no PostgreSQL started by this verifier); the only human item is the PR 199 Greptile gate, which this verifier did not observe"
covered_files: [".planning/phases/71-multi-session-boundary/71-01-PLAN.md", ".planning/phases/71-multi-session-boundary/71-01-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-02-PLAN.md", ".planning/phases/71-multi-session-boundary/71-02-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-03-PLAN.md", ".planning/phases/71-multi-session-boundary/71-03-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-04-DOCS-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-04-PLAN.md", ".planning/phases/71-multi-session-boundary/71-04-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-05-SUMMARY.md", "docs/live-steering.md", "packages/audit/src/record.ts", "packages/cli/src/steer/binding-record.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/live-session-boundary.test.ts", "packages/mcp-server/src/live-session-isolation.test.ts", "packages/mcp-server/src/live-session-restart.pg.test.ts", "packages/mcp-server/src/mcp.steering.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planning/live-session-authority.pg.test.ts", "packages/mcp-server/src/planning/live-session-authority.test.ts", "packages/mcp-server/src/planning/session-state.ts", "packages/mcp-server/src/planning/steering-idempotency.pg.test.ts", "packages/mcp-server/src/planning/steering-rest.ts", "packages/mcp-server/src/planning/steering-sessions-store.ts", "packages/mcp-server/src/planning/steering-tools.test.ts", "packages/mcp-server/src/planning/steering-tools.ts", "packages/mcp-server/src/server.steering.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.test.ts", "packages/mcp-server/src/session-context.ts"]
covered_digest: "v3:sha256:b0c1fa703f49874caab57e81f33a99a5af87963d130aba14e63112d22dc2819a"
behavior_unverified: 0
overrides_applied: 0
gaps: []
re_verification:
  previous_status: human_needed
  previous_score: "5/5"
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "PR 199 Greptile gate via Desk Quality / Programming Lead, covering the discovery-expiry change."
    expected: "A Greptile result on the PR with no unaddressed finding. A FAILED, SKIPPED or unavailable review is not a pass."
    why_human: "External review gate. Not observed or queried by this verifier."
---

# Phase 71: Multi-Session boundary — Re-verification at HEAD a46d42c3

**Phase Goal:** Enforce authenticated bindings on live session-scoped reads and writes. Foreign and unknown targets return indistinguishable not-found responses. Live session identifiers are unguessable and never reused. Preserve operator-only steering writes and the redacted repository-wide `session_context` digest.
**Verified:** 2026-11-06T00:44:16Z
**Status:** human_needed
**Re-verification:** Yes. The prior `71-VERIFICATION.md` (HEAD 6e5d766e, gate r33) was read. This draft is written to `/root/src/worktrees/backups/records/71-VERIFICATION.md`; the repository record is not replaced by this pass.

**Tree:** /root/src/worktrees/as-gsd-v18-all, HEAD a46d42c3, worktree clean. No repository file edited. No test, tsc, lint, formatter, Docker or database run by this verifier. Evidence: gate r36 JUnit (`/root/src/worktrees/backups/gate-r36-junit.xml`: 12,317 testcases, 0 failures, 0 errors, 2 skipped). The two skipped testcases are `redact.test.ts` ("D-04 fixtures do not survive the write path while counts do") and `cache-conformance.test.ts` (live loopback redis, `SUBSTRATE_CONFORMANCE_REDIS_URL` unset); neither is in phase 71's file set.

**Changes since the prior record (6e5d766e..a46d42c3):** 14 commits. Three touch covered implementation files: `884e0753` (sync-lag reading moved to the emit path and an observer hook, `service.ts`, `observe.ts`, `server.ts`), `f0f3c04e` (null bodies answer 400, `reportSilent`, upstream reply checks; `server.ts`, `service.ts`, `mcp.ts`, `planning/steering-rest.ts`), and `a46d42c3` (dead symbols; `event.ts`, `planning/steering-rest.ts`, `service.ts`). The other commits in range (`e3914640`, `e958e8b1`, `885e73ce`, `7a1d923a`, `c371cece`, `9b793653`, `aef8a351`, `c71a539d`, `403e45f7`, `bb6b38b7`, `b1bb49f2`) do not touch a covered file (`git log -- <covered files>`).

Byte-identical to 6e5d766e (`git diff` empty): `steering-tools.ts`, `steering-sessions-store.ts`, `session-state.ts`, `index-store.ts`, `session-context.ts`, `packages/audit/src/record.ts`, `packages/cli/src/steer/binding-record.ts`, `docs/live-steering.md`, and every covered test file. `ROADMAP.md` and `REQUIREMENTS.md` are unchanged.

## Re-audit after f0f3c04e (scope of this pass)

1. **The 404 value is unchanged.** `liveSessionNotFound()` is still the single not-found refusal (`planning/steering-tools.ts:40`), thrown as `LiveSessionBoundaryError` (`:41-43`) from `checked` (`:107`), `recheck` (`:111`), the steering read paths (`:164`, `:177`) and `deny` (`:124`). The authority returns `notFound()` for an absent, foreign, wrong-proof, expired or closed row (`planning/steering-sessions-store.ts:232-233`). Mapping: `steeringHttpStatus` sends `not-found` to 404 (`planning/steering-rest.ts:271-272`); `server.ts:764` (MCP batch fault, `sendLiveFault`) and `server.ts:2436` (REST outer catch, `sendSteeringResult`) turn the thrown refusal into the reply. No hunk of f0f3c04e touches any of these lines. `steering-tools.ts` and `steering-sessions-store.ts` are unchanged since 6e5d766e.

2. **Refusal audit is unchanged.** `recordDenial` keeps its `try` (`steering-tools.ts:125-127`), so an audit failure still cannot change the refusal. The wiring `recordRefusal: async (event) => (await this.emit(event)).stored` (`service.ts:2044`) is unchanged. The new `reportSilent` calls in `service.ts` sit on emit paths after a committed mutation, not on the refusal path.

3. **Steering receipts keep their boolean.** Two sites changed from `.then(written => written.stored, () => false)` to a handler that calls `reportSilent` and returns `false`: `emit.steering-session` (`service.ts:2252-2255`) and `emit.steering-ended` (`service.ts:2283-2286`). The receipt's `event_stored` is unchanged. `reportSilent` returns `void` and writes one stderr line per site per process with the error code, never its message (`silent-failures.ts:29-33`). Its own tests are `silent-failures.test.ts` ("reports a token code once for a site", "the message text never appears in the output", "a second call for the same site writes nothing", "a non-object error reports its typeof"). No test asserts the stderr line at the two steering sites.

4. **Operator-only writes are unchanged.** A non-operator `operator-queue` or `operator-ack` is refused as `forbidden` / `operator-required` (`steering-tools.ts:99-101`) and answers 403 (`steering-rest.ts:261-262`). The steering routes in `server.ts` (`/steering/sessions` at `:2226`, `/steering/queue` at `:2265`, `/steering/acknowledge` at `:2277`) are not in the diff. Their null-body guard already existed: `plainObject` (`steering-rest.ts:173-175`), `parseQueueBody` (`:193-195`) and `parseAcknowledgeBody` (`:210-212`) answer 400 "request body must be a JSON object". f0f3c04e gives the four legacy routes the same message.

5. **The four routes changed by f0f3c04e.** The guards are at `server.ts:1214-1219` (`/evidence`), `:1501-1505` (`/handoff`), `:1585-1589` (`/drift`) and `:1620-1624` (`/verify`). Each runs before `rememberClaim`, the field checks and `auditedRest`. Effects, by body class:

   | Body | `/drift`, `/verify`, `/evidence` | `/handoff` |
   |---|---|---|
   | JSON `null` | 500 before (TypeError on a property read) → 400 | 500 before → 400 |
   | JSON array, string, number, boolean | 400 with a field message before → 400 with "request body must be a JSON object"; no audit either way | 400 "handoff needs `goal` and `to`" after a `coord_handoff` audit before → 400 before any audit |
   | Invalid JSON text | unchanged (same `JSON.parse` position, outer catch) | unchanged |

   Status changes only from 500 to 400 for `null`. For `/handoff`, a non-object body previously reached `auditedRest` (`server.ts:702`, `auditToolCalls` at `observe.ts:761`) before the 400. It is now refused before the audit, so no `coord_handoff` record is written for it, and if the audit port was unavailable the reply is 400 where it was 503. This is inferred from the code and was not exercised. `http-null-body.test.ts` covers only the literal `null` body. It is not a 404, not a live-session path, and not a phase 71 criterion, but it is a refusal-path change, so it is recorded as Residual 11.

6. **Other covered-file changes, none on the boundary.** `queryEventsFor` accepts `null` (the default covers only `undefined`); `repoRefusal` still answers 403 with the same body. `service.ts` `emit` now calls `observer.syncLag` (`service.ts:3016-3019`, `observe.ts:399`): the docs SLO reading, not a session path. `mcp.ts` gains a `reportSilent` on the Railway write note. `event.ts` `isPlanningUpdate` and `steering-rest.ts` `RestSteeringSession` (type only) were removed; a repository-wide grep finds no remaining reference to either.

7. **Outside the covered set.** `c371cece` changed `packages/host` (the host MCP proxy body read answers 400; error labels). It does not touch the server's session routes and is not part of phase 71.

## Goal achievement — roadmap success criteria

| # | Criterion (ROADMAP.md:1242-1248, unchanged) | Verdict | Evidence (HEAD a46d42c3) |
|---|---|---|---|
| 1 | Foreign and unknown live session IDs produce the same 404 status, body, and headers on every private session read or write, including directive lists, wait/listen, MCP steering tools, docs-session registration/transitions, and session-scoped steering augmentation. No directive, acknowledgement, or session state changes on refusal. | **VERIFIED** | One refusal value, `liveSessionNotFound()` (`steering-tools.ts:40`), mapped to 404 (`steering-rest.ts:271-272`). Authority returns `notFound()` for absent, foreign, wrong-proof, expired and closed rows (`steering-sessions-store.ts:232-233`); unknown rows still run the constant-time comparison against a dummy hash (`:138-141`). JUnit, all with no failure, error or skip child: "same-surface sibling/foreign/malformed/missing proof and unknown IDs are indistinguishable" (`planning/live-session-authority.test.ts`); "steering_list: owner proof succeeds, every invalid binding is the same no-effect refusal before audit" and "steering_queue: owner proof succeeds, every invalid binding is the same no-effect refusal before audit" (`mcp.steering.test.ts`); "MCP and REST owner/sibling refusals are equivalent with trusted ports" (`server.steering.test.ts`); "direct service required writes with failing audit cannot mutate, but denied targets stay404" and "direct service required writes with missing audit cannot mutate, but denied targets stay404" (`live-session-isolation.test.ts`); "explicit service close wakes local waits immediately into terminal404" (`server.steering.test.ts`); "expiry and missing authority are terminal, uniform resource and service failures" (`live-session-boundary.test.ts`). |
| 2 | Operator authority remains explicit; permitted cross-session operations remain available. Refusal audits hash requested identifiers and record no private session body. Principal-keyed limiting runs before binding lookup. | **VERIFIED** (audit best-effort, Residual 1) | Operator bypass is the explicit map `OPERATOR_OPERATIONS` (`steering-sessions-store.ts:125-127`), applied in `authorized()` (`:135-145`); owner transitions and heartbeat are not in the map. Non-operator operator writes return `forbidden` (`steering-tools.ts:99-101`) and 403 (`steering-rest.ts:261-262`). Principal budget before lookup: `reserve` (`steering-tools.ts`, `LiveSessionBoundary.reserve`). JUnit: "operator queue/list/ack works without a proof; owner list requires its independent proof" and "an admitted owner still cannot use operator writes" (`planning/steering-tools.test.ts`); "operators bypass only explicit operations, never owner transitions/heartbeat or terminal state" (`planning/live-session-authority.test.ts`); "bound nonoperator writes403, operator queue and directive-only ack commit state and honest hint" (`server.steering.test.ts`); "mandatory principal budget precedes directive lookup and all audits in off" (`live-session-boundary.test.ts`); "REST and HTTP MCP generic audit records omit live target plaintext" (`live-session-boundary.test.ts`); "failed refusal ledger and generic audit cannot decorate target refusal or log binding material" (`mcp.steering.test.ts`). |
| 3 | Server-issued session identities have at least 128 bits of cryptographic randomness; durable ownership and closed-session tombstones prevent reissue or cross-surface takeover, including after restart. An unavailable authority fails closed rather than accepting a volatile substitute. | **VERIFIED** | Identity is `ls_` plus 64 hex characters (`steering-sessions-store.ts:122`, `:273-274`), drawn from two independent 32-byte values, ID and proof (`:217`, `:273`). Only the domain-separated proof hash is stored (`bindingHash` `:131`, `:276`; column `binding_proof_hash`). A wrong-length draw returns `unavailable()` (`:273`). JUnit, PG suites by name: "factory issuance with cache opt-in off persists hash-only canonical state and survives reconnect", "legacy SQL rows cannot grant an unissued identity or revive a closed binding", "unavailable pool cannot fall back to another adapter's successful cached grant" (`durable live-session authority against controlled PostgreSQL (two independent pools)`, `planning/live-session-authority.pg.test.ts`); "teardown/reconstruction preserves owner proof, canonical state and terminal tombstone with cache migration off", "actual migration37 stale rows cannot grant or revive across reconstructed services without a cache adapter", "a real missing authority schema fails service reads, issuance and mutation closed despite another pool's grant" (`HARD-S1 durable service restart and independent-instance release (controlled PostgreSQL)`, `live-session-restart.pg.test.ts`). |
| 4 | The existing operator-only queue/ack contract and legacy unkeyed command shape remain unchanged. All affected callers migrate to the explicit session identity lifecycle; no alias silently bypasses binding checks. | **VERIFIED** (one deliberate contract change, Residual 4) | `session_binding` is optional in every steering input schema (`steering-tools.ts:15`, `:19`, `:21`, `:24`, `:26`, `:29`, `:32`), so the command shape is unchanged. Operator queue and ack need no proof for an operator (`steering-sessions-store.ts:126`, `:143`). Keyed replay: "a keyed queue commits its audit row and replay record together, and a retry on the other instance replays" (`steering-idempotency.pg.test.ts`, suite `steering replay and delivery sequence against PostgreSQL`); "a key from another operator surface does not replay" (`planning/steering-tools.test.ts`); "the queue body takes an optional idempotency key, and a malformed one is refused by field name only" (`planning/steering-rest.test.ts`). |
| 5 | The redacted repo-wide `session_context` digest remains available as designed in Phase 67. Re-run the recorded steering regression file set and the new isolation/revocation/restart failure-injection cases; record pass/skip counts and any deliberate contract changes. | **VERIFIED** | Digest: `sessionContext` reads steering through `listMetadata`, which selects only `session_id, owner_surface, repo_id, state, updated_at, expires_at` (`steering-sessions-store.ts:246-247`, `:392`); the proof never appears. JUnit: "refuses a missing repo, a bad session id and a limit out of range, naming the field and never the value" (`session-context.test.ts`); "discovery owner/repo/active filters precede limit and public metadata remains text-free" (`planning/live-session-authority.pg.test.ts`); "refuses an over-long repo by name before any statement reaches the driver" (`planning/live-session-authority.test.ts`); "SQL-time expiry overrides an already-admitted independent service and cannot be renewed or re-registered", "a held wait observes close from an independent service without any local wake or shared authority map", "close racing independent-pool heartbeat reports its actual committed effect without revival" (`live-session-restart.pg.test.ts`); "private docs bypass result cache and refuse after a delayed ledger read loses authority" (`live-session-boundary.test.ts`). Recorded file set and counts in the table below. No deliberate contract change in this range. |

## PostgreSQL clauses re-cited (gate r36 JUnit, not re-run)

Source: `/root/src/worktrees/backups/gate-r36-junit.xml`. Each suite element reports `failures="0"` and no `skipped`. Each named testcase is checked by parsing the XML: no `<skipped/>`, `<failure>` or `<error>` child, and the file attribute matches.

| Clause | JUnit suite (file) | Result | Named testcases cited |
|---|---|---|---|
| live-session-restart | `HARD-S1 durable service restart and independent-instance release (controlled PostgreSQL)` (`packages/mcp-server/src/live-session-restart.pg.test.ts`) | 16 pass / 0 fail / 0 skip | "teardown/reconstruction preserves owner proof, canonical state and terminal tombstone with cache migration off"; "close racing independent-pool heartbeat reports its actual committed effect without revival"; "SQL-time expiry overrides an already-admitted independent service and cannot be renewed or re-registered"; "a held wait observes close from an independent service without any local wake or shared authority map"; "actual migration37 stale rows cannot grant or revive across reconstructed services without a cache adapter"; "a real missing authority schema fails service reads, issuance and mutation closed despite another pool's grant" |
| live-session-authority | `durable live-session authority against controlled PostgreSQL (two independent pools)` (`packages/mcp-server/src/planning/live-session-authority.pg.test.ts`) | 13 pass / 0 fail / 0 skip | "factory issuance with cache opt-in off persists hash-only canonical state and survives reconnect"; "close racing heartbeat and transition never resurrects; tombstone persists after reconnect"; "active and terminal collisions retry fresh independent pairs and never change existing binding"; "legacy SQL rows cannot grant an unissued identity or revive a closed binding"; "unavailable pool cannot fall back to another adapter's successful cached grant"; "discovery owner/repo/active filters precede limit and public metadata remains text-free" |
| steering-idempotency | `steering replay and delivery sequence against PostgreSQL` (`packages/mcp-server/src/planning/steering-idempotency.pg.test.ts`) | 4 pass / 0 fail / 0 skip | "a saved replay is returned exactly by a second instance, and the sequence continues from the saved value"; "a claim whose unit fails keeps no replay record on either instance"; "a keyed queue commits its audit row and replay record together, and a retry on the other instance replays"; "two concurrent keyed commands through two instances queue one directive and both get its reply" |

The restart suite's "SQL close before a queued directive's final wait release suppresses private bytes", "SQL expiry before a queued directive's final wait release suppresses private bytes" and "authority outage at immediate wait release is unavailable, never a successful directive/closed/timeout" clauses are cited with the same result (same suite, same file, no skip child).

## Covered test counts (gate r36 JUnit)

Not re-run by this verifier. Counted from the parsed XML for the covered test files:

- Non-PG covered files (`live-session-boundary`, `live-session-isolation`, `mcp.steering`, `server.steering`, `session-context`, `planning/live-session-authority.test`, `planning/steering-tools.test`, `planning/steering`, `planning/steering-rest`, `service.test`, `service-event-buffer.test`, `planning/session-state.test`): 586 testcases, 0 with a failure, error or skip child.
- PG files (`live-session-restart.pg`, `planning/live-session-authority.pg`, `planning/steering-idempotency.pg`): 16 + 13 + 4 = 33 testcases, 0 with a failure, error or skip child.
- Total: 619 testcases, 0 failed, 0 skipped.

The prior record's 618 (gate r33) is one below this count. The covered test files are byte-identical since 6e5d766e, so the difference is in the gate or the counting method, not in a covered file; not investigated further.

## Required artifacts and wiring

- The 34 covered files exist at HEAD. `gsd_run query verification.fingerprint` read them and produced the `covered_digest` below.
- Covered-file list and digest: computed with `gsd_run query verification.fingerprint .planning/phases/71-multi-session-boundary <implementation files>` from the worktree root. The implementation files are the 24 non-PLAN, non-SUMMARY entries of the prior record. The command added the phase's PLAN and SUMMARY files itself.
- The prior digest `v3:sha256:8ca0ac48d7ff36b2ac2072577ed424752d2f23898cbfbb675852819fe3725995` (at 6e5d766e) no longer matches because six covered implementation files changed.

## Anti-patterns

- Debt-marker scan of added lines in the covered implementation files (6e5d766e..a46d42c3): 0 matches for `TBD`, `FIXME`, `XXX`, `TODO`, `HACK`.
- Return-value check: the `.catch` handlers changed to `reportSilent` either return the same value as before (`false`, `null` or `undefined`) or sit where the value is discarded (`publishHint`). `recordDenial` still catches.

## Residuals (reported, not blocking)

1. **Denial audit is best-effort.** `recordDenial` swallows audit errors (`steering-tools.ts:125-127`). Refusals still return the identical 404. Rate-limited refusals are not audited, as they carry no target identifier.
2. **Audit digest embeds the proof for MCP calls that carry `session_binding`.** `argDigest` = SHA-256 of canonical args (`packages/audit/src/record.ts:180-192`). No plaintext stored. Owner-held item (see Open decisions).
3. **Malformed vs unknown IDs.** A syntactically invalid `session_id` gets REST 400 before lookup (`steering-rest.ts:34-37`, `requiredSession`); well-formed unknown or foreign IDs get 404.
4. **Owner unkeyed calls are refused.** `authorized()` (`steering-sessions-store.ts:135-145`) requires a matching proof. Deliberate behavior change; criterion 5 requires it recorded.
5. **Operator bypass without proof.** `authorized()` (`:143`) lets an operator read, close, queue and ack without a proof, for the operations at `:125-127`. Explicit operator authority per `PLAN 71-01`.
6. **Over-long repo refused at issue.** `issue()` calls `assertRepoLength` before the authority's `try` (`steering-sessions-store.ts:265`; helper `event.ts:290`), so an over-long repo is the named `repo_too_long` refusal, not a session-unavailable answer. A refusal of invalid input, not an acceptance.
7. **Digest session IDs.** `session_context` lists `session_id`, surface, state and times for the repo (`steering-sessions-store.ts:246-247`); the proof never appears in the digest.
8. **Lone-surrogate and straddle data:** carried from the earlier record; no change in this range.
9. **Sync-lag hook (`884e0753`, W-1).** A held or dead-lettered `docs.sync` note sets the corpus sync-lag reading through `service.ts:3016-3019` and the `syncLag` observer hook (`observe.ts:399`). This is the docs SLO path, not the live-session path, and it is not a phase 71 criterion.
10. **Stale docs, carried unchanged.** `ROADMAP.md:1234` status ("3 of 5 criteria verified at 4b84e50c ... Postgres restart clauses pending") and the commit id at `:1256`, `:1271`, `:1419` (`4b84e50c`); `REQUIREMENTS.md:133` HARD-S1 row ("Postgres restart clauses pending"). The PG clauses are verified above. Flagged, not edited.
11. **Non-object `/handoff` bodies no longer reach the `coord_handoff` audit (`f0f3c04e`).** Array, string, number and boolean bodies are refused with 400 before `auditedRest`. Previously they were audited first and could answer 503 when the audit port was unavailable (inferred from code, not exercised). No live-session route, 404 or criterion is affected. `http-null-body.test.ts` covers only the literal `null`. Owner decision needed on whether the audit should cover refused non-object bodies.

## Human Verification Required

1. **PR 199 Greptile gate via Desk Quality / Programming Lead.** Covers the discovery-expiry change. The expiry is not in discovery at HEAD: `listing()` (`steering-sessions-store.ts:238`) has no expiry call and performs no write; the only expiry caller is `expireDueBeforeIssue` (`:194`), called from `issue()`. Not observed or queried here. A FAILED, SKIPPED or unavailable review is not a pass. This is the only human item for phase 71, and the sole reason the status is `human_needed`.

## Open decisions (owner-held, carried; not re-opened here)

These are recorded owner-held items. Per the owner decision in force, the PR 199 Greptile gate is the only human item for this phase; the items below are not human-verification entries and do not change the status.

- **Recovery limit (D71-08):** the closed logical archive does not cover `live_session_bindings`. `docs/runbooks/index-archive.md:8` still lists it under "Not covered".
- **Operator-only, not exercised here:** deployed migration 42, complete PostgreSQL backup and restore including tombstones, real host hooks and timers, real credential enablement.
- **Malformed-ID response (400 vs 404):** Residual 3.
- **Digest-of-proof in the audit record and in-process dispatch key:** whether a hash of the proof in `argDigest` (`record.ts:180-192`) and in `liveCallKey` is acceptable under HARD-S1. Residual 2.
- **Owner unkeyed calls refused:** Residual 4.
- **Operator close and bypass scope:** Residual 5.
- **Test-count reconciliation and ROADMAP status commit id:** Residual 10.
- **Lone-surrogate and straddle data:** Residuals 8 and 9.
- **Non-object `/handoff` audit coverage:** Residual 11 (new in this pass).

## Gaps

None. No criterion is FAILED. No behavior-unverified truths remain. Deferred items: none. Regressions against phase 71's criteria since 6e5d766e: none. The 404 and refusal values, the refusal audit, the operator-only checks and the session-context digest are byte-identical in their files since 6e5d766e. The only refusal-path change in range is the non-object body guard on `/handoff`, `/drift`, `/verify` and `/evidence` (Residual 11 for `/handoff`), which does not touch a 404 or a session route.

---

_Verified: 2026-11-06T00:44:16Z_
_Verifier: Claude (gsd-verifier), re-verification at HEAD a46d42c3_
