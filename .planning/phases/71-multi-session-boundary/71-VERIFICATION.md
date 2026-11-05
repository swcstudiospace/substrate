---
phase: 71-multi-session-boundary
verified: "2026-11-05T01:30:29Z"
status: human_needed
score: "5/5 roadmap success criteria verified on this tree (HEAD 835a2742); PostgreSQL restart, authority and idempotency clauses re-observed by this verifier on scratch PostgreSQL 16 (substrate_test_v71, not production); the only human item is the PR 199 Greptile gate, which this verifier did not observe"
covered_files: [".planning/phases/71-multi-session-boundary/71-01-PLAN.md", ".planning/phases/71-multi-session-boundary/71-01-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-02-PLAN.md", ".planning/phases/71-multi-session-boundary/71-02-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-03-PLAN.md", ".planning/phases/71-multi-session-boundary/71-03-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-04-DOCS-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-04-PLAN.md", ".planning/phases/71-multi-session-boundary/71-04-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-05-SUMMARY.md", "docs/live-steering.md", "packages/audit/src/record.ts", "packages/cli/src/steer/binding-record.ts", "packages/mcp-server/src/event.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/live-session-boundary.test.ts", "packages/mcp-server/src/live-session-isolation.test.ts", "packages/mcp-server/src/live-session-restart.pg.test.ts", "packages/mcp-server/src/mcp.steering.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planning/live-session-authority.pg.test.ts", "packages/mcp-server/src/planning/live-session-authority.test.ts", "packages/mcp-server/src/planning/session-state.ts", "packages/mcp-server/src/planning/steering-idempotency.pg.test.ts", "packages/mcp-server/src/planning/steering-rest.ts", "packages/mcp-server/src/planning/steering-sessions-store.ts", "packages/mcp-server/src/planning/steering-tools.test.ts", "packages/mcp-server/src/planning/steering-tools.ts", "packages/mcp-server/src/server.steering.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.test.ts", "packages/mcp-server/src/session-context.ts"]
covered_digest: "v3:sha256:e2711da34a87dd721dd35f6695fde398874c5681f6a30cb27792f995324bf2b3"
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

# Phase 71: Multi-Session boundary — Re-verification at HEAD 835a2742

**Phase Goal:** Enforce authenticated bindings on live session-scoped reads and writes. Foreign and unknown targets return indistinguishable not-found responses. Live session identifiers are unguessable and never reused. Preserve operator-only steering writes and the redacted repository-wide `session_context` digest.
**Verified:** 2026-11-05T01:30:29Z
**Status:** human_needed
**Re-verification:** Yes. The prior `71-VERIFICATION.md` (HEAD c40ffc9a) was read, then overwritten.

**Tree:** /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 835a2742. No code edits, no commits, no full suite, no tsc, lint or formatters. Three PostgreSQL runs (one per file) and one non-PostgreSQL targeted run were executed by this verifier. Only this phase's VERIFICATION.md was written, in the worktree.

**Changes since the prior record (c40ffc9a..835a2742):** 7 commits. Among the covered set, only `packages/mcp-server/src/service.ts` changed (+4/-3, one hunk at `:7476-7494`, `corpusFreshness`: the corpus freshness verdict also runs when `SUBSTRATE_DOCS_SLO_SYNC_LAG_S` is set, and passes sync lag to `corpusFreshnessRow`). This is docs/corpus-SLO work outside the live-session path. Every boundary reference cited below sits above line 7476 and is unaffected by the hunk. `steering-sessions-store.ts`, `steering-tools.ts`, `server.ts`, `planning/session-state.ts`, `steering-rest.ts`, `index-store.ts`, `mcp.ts`, `docs/live-steering.md` and the CLI binding files are byte-identical to c40ffc9a (`git diff --quiet`). The covered path list is unchanged (34 entries). The digest changed from `v3:sha256:fb861af5…ea38f` (c40ffc9a) to `v3:sha256:e2711da3…bf2b3` because `service.ts` content changed.

**Docs checked at HEAD:**

- `ROADMAP.md:1234`, `:1256`, `:1271` and `:1419` still name commit `4b84e50c`. HEAD is `835a2742`. Stale, flagged, not edited.
- Phase 71 success-criteria text in `ROADMAP.md` (`:1242-1248`) is unchanged in this range. The `ROADMAP.md` and `REQUIREMENTS.md` hunks in the range belong to other phases (PROOF-02, PROOF-04, EVAL-03, phases 65 and 70).
- `REQUIREMENTS.md:133` HARD-S1 traceability row still reads "3 of 5 criteria verified" (stale wording, not edited).

## Criteria source

- **Used:** this tree's ROADMAP `### Phase 71` success criteria, five items.
- **Requirement:** HARD-S1, `.planning/REQUIREMENTS.md:112`.

## Method

Goal-backward inspection of the covered set, with the five criteria as the contract. The three PostgreSQL files were re-run at HEAD 835a2742 against scratch PostgreSQL 16 (container `substrate-pg-scratch`, port 5439, database `substrate_test_v71`). Production and port 5432 were not touched. The non-PostgreSQL targeted set was re-run once with `SUBSTRATE_TEST_PG_URL` unset. Line references in the steering boundary files are carried from the c40ffc9a record and spot-checked at HEAD (definitions and call sites match).

## Goal achievement — roadmap success criteria

| # | Criterion (ROADMAP, this tree) | Verdict | Evidence (HEAD 835a2742; boundary code unchanged since 9e71f263) |
|---|---|---|---|
| 1 | Foreign and unknown live session IDs give the same 404 status, body and headers on every private read or write. No directive, acknowledgement or state changes on refusal. | **VERIFIED** | One refusal value: `liveSessionNotFound()` (`steering-tools.ts:40`), thrown as `LiveSessionBoundaryError` (`:41-43`) and mapped to one refusal at `server.ts:765` and `:2420`. The authority returns `notFound()` for an absent row, a foreign or wrong-proof row, and an expired or closed row (`steering-sessions-store.ts:232-234`, `authorized` `:135-145`). Unknown rows still run the constant-time comparison against a dummy hash (`:137-141`). `deny()` maps not-found to `liveSessionNotFound()` (`steering-tools.ts:124`); `prepareReserved` maps not-found to `deny` (`:97`). Targeted non-PG run passes (488/0). |
| 2 | Operator authority stays explicit and permitted cross-session operations stay available. Refusal audits hash requested identifiers and record no private session body. Principal-keyed limiting runs before binding lookup. | **VERIFIED** (audit best-effort, Residual 1) | Operator bypass is the explicit map `OPERATOR_OPERATIONS` = private-read, close, operator-queue, operator-ack (`steering-sessions-store.ts:125-127`), applied in `authorized()` at `:143` after the row is loaded. Owner transitions and heartbeat are not in the map. Operator queue or ack without operator rights records a denial and returns `forbidden operator-required` (`steering-tools.ts:99-101`). Refusal audit digests the target with `substrate.live-session-refusal.v1` over `target.slice(0, 128)` (`steering-tools.ts:126`, `recordRefusal` at `:127`), so no session body is recorded. Principal-keyed limiting ordering is as recorded at c40ffc9a (`reserve`, `steering-tools.ts:71`, before binding lookup at `:97`). |
| 3 | Session identities have at least 128 bits of cryptographic randomness. Durable ownership and closed-session tombstones prevent reissue or cross-surface takeover, including after restart. An unavailable authority fails closed. | **VERIFIED** | Entropy: `randomBytes` from `node:crypto` (`steering-sessions-store.ts:7`, default `:217`). Issuance draws two independent 32-byte values, ID and proof (`:271-272`), ID = `ls_` + 64 hex (`:274`, 256 bits), proof 64 hex (`:275`). Only the domain-separated proof hash is stored (`bindingHash` `:131-133`, `:276`; column `binding_proof_hash`, migration 42 `index-store.ts:880-905`). A wrong-length entropy draw returns `unavailable()` (`:273`). Closed or expired rows are tombstones and fail as not-found (`:232-234`). Restart clause re-observed at HEAD: `live-session-restart.pg.test.ts` 16 pass / 0 fail, and `planning/live-session-authority.pg.test.ts` 13 pass / 0 fail. |
| 4 | The operator-only queue/ack contract and legacy unkeyed command shape remain unchanged. All affected callers migrate to the explicit session identity lifecycle; no alias silently bypasses binding checks. | **VERIFIED** (one deliberate contract change, Residual 4) | `session_binding` is optional in every input schema (`steering-tools.ts:15` `SESSION_BINDING_INPUT`, used at `:19`, `:21`, `:24`, `:26`, `:29`, `:32`), so the command shape is unchanged. Operator queue and ack need no proof for an operator (`steering-sessions-store.ts:126`, `:143`). Dispatch maps each tool to one explicit operation and session target (`service.ts:1599-1619`, `liveInvocationFor`; unchanged by the HEAD hunk). |
| 5 | The redacted repo-wide `session_context` digest remains available as designed in Phase 67. Re-run the recorded steering regression file set and the new isolation/revocation/restart failure-injection cases; record pass/skip counts and any deliberate contract changes. | **VERIFIED** | Digest: `sessionContext` (`service.ts:3975`) reads steering through `this.liveSessions.listMetadata({ repoId: scope, limit: 200 })` (`:3996`), `scope = scopeRepoId(request.repoId)` (`:3977`); `listing()` selects only `session_id, owner_surface, repo_id, state, updated_at, expires_at` (`steering-sessions-store.ts:246-247`). Restart failure injection (injected close and expiry failures, logged as `live session expiry pass failed`) and revocation re-observed at HEAD: `live-session-restart.pg.test.ts` 16 pass / 0 fail. Regression file set re-run: 488 pass / 0 fail / 0 skip. Deliberate contract changes are listed in Residuals 4 and 5. |

**Score:** 5/5 criteria verified. `behavior_unverified: 0`.

## Postgres runs (this verifier, HEAD 835a2742)

Each file run separately. `SUBSTRATE_TEST_PG_URL=postgres://postgres:…@127.0.0.1:5439/substrate_test_v71` (password not recorded), `TMPDIR=/root/src/worktrees/backups/gate-tmpfs`. Server: PostgreSQL 16 (scratch container `substrate-pg-scratch`, not production). Bun 1.4.0.

| File | Pass | Fail | Skip | Expect calls | Wall | Log |
|---|---|---|---|---|---|---|
| `packages/mcp-server/src/live-session-restart.pg.test.ts` | 16 | 0 | 0 | 148 | 1.91 s | `/root/src/worktrees/backups/r31-p71-pg-restart.log` |
| `packages/mcp-server/src/planning/live-session-authority.pg.test.ts` | 13 | 0 | 0 | 83 | 438 ms | `/root/src/worktrees/backups/r31-p71-pg-authority.log` |
| `packages/mcp-server/src/planning/steering-idempotency.pg.test.ts` | 4 | 0 | 0 | 12 | 237 ms | `/root/src/worktrees/backups/r31-p71-pg-idempotency.log` |

Stderr lines `[substrate] live session expiry pass failed …` in the restart and authority logs are emitted by the failure-injection cases; those tests pass. The skip count is 0 (no `skip` text in any of the three logs).

Counts match the c40ffc9a record (16/13/4, zero failures) and the expect-call totals match the prior run exactly.

## Targeted tests (non-PG, this verifier; `SUBSTRATE_TEST_PG_URL` unset)

`env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000` over `live-session-isolation.test.ts`, `live-session-boundary.test.ts`, `mcp.steering.test.ts`, `planning/live-session-authority.test.ts`, `planning/steering-tools.test.ts`, `server.steering.test.ts`, `session-context.test.ts`, `service.test.ts` | **488 pass, 0 fail, 0 skip**, 8 files, 19.10 s, exit 0 | `/root/src/worktrees/backups/r31-p71-targeted.log`

Non-PG command count for this verification: this targeted run plus the fingerprint computation. No full suite.

## Fingerprint

`gsd_run query verification.fingerprint .planning/phases/71-multi-session-boundary` with the 24 implementation paths listed in the covered set (the 10 phase PLAN/SUMMARY/DOCS-SUMMARY files are added by the command). The output `covered_files` and `covered_digest` are copied verbatim into the frontmatter. The covered path list is identical to the c40ffc9a record; the digest changed because `service.ts` changed content.

## Required artifacts and wiring (Steps 4 and 5)

Artifact existence (plan artifacts unchanged): 71-01 3/3, 71-02 3/3, 71-03 5/5, 71-04 4/4.

| Artifact | Wiring | Status |
|---|---|---|
| `planning/steering-sessions-store.ts` (`bunLiveSessionAuthority`) | `index-store.ts:56` import, factory `index-store.ts:1048`, `IndexStore` → `service.ts:2022` | WIRED |
| `planning/steering-tools.ts` (`LiveSessionBoundary`, `liveSessionNotFound`) | `service.ts:2025-2033`; `server.ts:69` import, `:765` and `:2420` catch; `mcp.ts:626-628` | WIRED |
| `planning/steering-rest.ts` (`steeringHttpStatus`) | `server.ts` `sendSteeringResult` | WIRED |
| Migration 42 `live_session_bindings` (`index-store.ts:880-905`) | Mandatory, no opt-in | WIRED |
| `planning/session-state.ts` (`LiveSessionStatePort`) | Injected at `service.ts:2044`; reads authority per call | WIRED |
| `planning/event.ts` helpers (`normalizeKey`, `assertWriteTextFields`, repo cap) | `service.ts:3094` write refusal; `index-store.ts:12` import | WIRED (ledger path; not on the live boundary path) |
| CLI `steer/binding-record.ts`, `steer/client.ts`, `session/hook.ts` | `steer/index.ts:43`; `hook.ts:47`; client paths match server routes (`server.ts:2210-2302`) | WIRED (route level) |

Level 4 (data flow): steering and digest paths read authority-backed rows (`steering-sessions-store.ts:246-253`) and return them unchanged (`service.ts:2276-2278`, `:3996-3998`). No hardcoded or static source.

### Key Link Verification

| Plan | From | To | Via (plan) | Status |
|---|---|---|---|---|
| 71-01 | `index-store.ts` | `planning/steering-sessions-store.ts` | `IndexStore.liveSessions` | WIRED |
| 71-01 | `steering-sessions-store.ts` | `event.ts` | `nextSteeringSession` | WIRED |
| 71-01 | `service.ts` | `index-store.ts` | consumes `liveSessions` | WIRED |
| 71-02 | `cli/src/steer/index.ts` | `steer/binding-record.ts` | record load and save | WIRED |
| 71-02 | `cli/src/steer/client.ts` | `mcp-server/src/server.ts` | HTTP routes | WIRED (route level) |
| 71-02 | `cli/src/session/hook.ts` | `cli/src/steer/client.ts` | client use | WIRED |
| 71-03 | `service.ts` | `planning/steering-sessions-store.ts` | authority types and factory | WIRED |
| 71-03 | `server.ts` | `planning/steering-tools.ts` | boundary calls | WIRED |
| 71-03 | `mcp.ts` | `service.ts` | `Substrate` methods | WIRED |
| 71-03 | `planning/steering-delivery.ts` | `planning/session-state.ts` | declared direction | **WARNING** (reversed in code: `session-state.ts` imports the port type from `steering-delivery.ts`; production wiring is `service.ts:2044`) |
| 71-04 | `live-session-isolation.test.ts` | `server.ts` | HTTP harness | WIRED (indirect) |
| 71-04 | `live-session-restart.pg.test.ts` | `index-store.ts` | IndexStore | WIRED |
| 71-04 | `docs/live-steering.md` | `cli/src/steer/index.ts` | documentation of the contract | **WARNING** (documentary link; contract text present) |

## Behavioral Spot-Checks (Step 7b)

| Behavior | Command | Result | Status |
|---|---|---|---|
| Foreign and unknown IDs share one 404; boundary, isolation, MCP steering, authority, REST, digest, `service.test.ts` | Targeted non-PG run above | 488 pass, 0 fail, 0 skip | ✓ PASS |
| Restart and durable tombstones survive a second instance | `live-session-restart.pg.test.ts` on scratch PG | 16 pass / 0 fail / 0 skip | ✓ PASS |
| Authority durability and terminal identities; disconnected authority returns session-unavailable | `planning/live-session-authority.pg.test.ts` on scratch PG | 13 pass / 0 fail / 0 skip | ✓ PASS |
| Steering idempotency across restart | `planning/steering-idempotency.pg.test.ts` on scratch PG | 4 pass / 0 fail / 0 skip | ✓ PASS |

## Probe Execution (Step 7c)

No probes declared. No `scripts/*/tests/probe-*.sh` for this phase. Not applicable.

## Anti-Patterns

- Debt-marker scan: the HEAD hunk in `service.ts` adds no `TBD`, `FIXME`, `XXX`, `TODO` or `HACK` markers (0 matches in the added lines). Unchanged covered files carry forward the c40ffc9a scan (0 markers in the boundary path).
- Stub-pattern hits in the boundary files are not stubs: `steering-tools.ts:71` is `reserve()` admitting a call; `steering-sessions-store.ts:151-152` is the invalid-row guard.
- Debt-marker gate: not triggered. No blocker.

## Residuals (reported, not blocking)

1. **Denial audit is best-effort.** `recordDenial` swallows audit errors (`steering-tools.ts:127`). Refusals still return the identical 404. Rate-limited refusals are not audited, as they carry no target identifier.
2. **Audit digest embeds the proof for MCP calls that carry `session_binding`.** `argDigest` = SHA-256 of canonical args (`packages/audit/src/record.ts:180-192`). No plaintext stored. Owner-held item (see Open decisions).
3. **Malformed vs unknown IDs.** A syntactically invalid `session_id` gets REST 400 before lookup (`steering-rest.ts:34-37`, `requiredSession`); well-formed unknown or foreign IDs get 404.
4. **Owner unkeyed calls are refused.** `authorized()` (`steering-sessions-store.ts:138-144`) requires a matching proof. Deliberate behavior change; criterion 5 requires it recorded.
5. **Operator bypass without proof.** `authorized()` (`:143`) lets an operator read, close, queue and ack without a proof, for the operations at `:125-127`. Explicit operator authority per `PLAN 71-01`.
6. **Over-long repo refused at issue.** `issue()` throws `repo_too_long` before the authority's `try` (`steering-sessions-store.ts:265`). A refusal of invalid input, not an acceptance.
7. **Digest session IDs.** `session_context` lists `session_id`, surface, state and timestamps for every open session in the repository (Phase 67 design; criterion 5). IDs are not credentials; every private operation still requires a proof. Informational.
8. **Lone-surrogate refusal ordering (from 8a604455).** `FieldLoneSurrogateError` is raised only inside `appendChained`, after admission. No foreign-visible difference found.
9. **Session_id and repo straddle data.** Pre-change rows whose `session_id` or `repo` straddled 512 code units can be stored with a lone high surrogate. Owner data decision; does not touch `ls_` IDs or `scopeRepoId`.
10. **Key-link metadata.** Two declared links are not literally present (`steering-delivery.ts` → `session-state.ts`, reversed in code; `docs/live-steering.md` → `cli/steer/index.ts`). Plan metadata correction is for the parent. Not edited here.
11. **Stale references and test counts.** `ROADMAP.md:1234`, `:1256`, `:1271`, `:1419` name `4b84e50c`; HEAD is `835a2742`. Test counts in circulation are not reconciled here.
12. **Archive restore scope.** The restore transaction's `advanceIdentity` and the `corpus_documents` archive table do not add `live_session_bindings` to the archive; see Open decisions.

## Human Verification Required

1. **PR 199 Greptile gate via Desk Quality / Programming Lead.** Covers the discovery-expiry change. The expiry is not in discovery at HEAD: `listing()` (`steering-sessions-store.ts:238-260`) has no expiry call and performs no write; the only expiry caller is `expireDueBeforeIssue` (`:194-200`), called from `issue()` (`:269`). Not observed or queried here. A FAILED, SKIPPED or unavailable review is not a pass. This is the only human item for phase 71, and the sole reason the status is `human_needed`.

## Open decisions (owner-held, carried; not re-opened here)

These are recorded owner-held items. Per the owner decision in force, the PR 199 Greptile gate is the only human item for this phase; the items below are not human-verification entries and do not change the status.

- **Recovery limit (D71-08):** the closed logical archive does not cover `live_session_bindings`. `docs/runbooks/index-archive.md:8` still lists it under "Not covered". Wave 6 added `corpus_documents` to the archive; `live_session_bindings` remains excluded.
- **Operator-only, not exercised here:** deployed migration 42, complete PostgreSQL backup and restore including tombstones, real host hooks and timers, real credential enablement.
- **Malformed-ID response (400 vs 404):** Residual 3.
- **Digest-of-proof in the audit record and in-process dispatch key:** whether a hash of the proof in `argDigest` (`record.ts:180-192`) and in `liveCallKey` (`service.ts:1596-1598`) is acceptable under HARD-S1. Residual 2.
- **Owner unkeyed calls refused:** Residual 4.
- **Operator close and bypass scope:** Residual 5.
- **Test-count reconciliation and ROADMAP status commit id:** Residual 11.
- **Lone-surrogate and straddle data:** Residuals 8 and 9.

## Gaps

None. No criterion is FAILED. No behavior-unverified truths remain. Deferred items: none. Regressions since c40ffc9a: none (the one changed covered file, `service.ts`, changes only the corpus freshness path at `:7476-7494`; the boundary tests pass at 835a2742: 488/0 targeted, 16/13/4 PG).

---

_Verified: 2026-11-05T01:30:29Z_
_Verifier: Claude (gsd-verifier), re-verification at HEAD 835a2742_
