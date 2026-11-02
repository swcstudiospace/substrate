---
phase: 71-multi-session-boundary
verified: "2026-11-02T16:07:36Z"
status: human_needed
score: "3/5 roadmap success criteria verified on this tree; criteria 3 and 5 restart clauses behavior-unverified (PostgreSQL-gated, not run)"
covered_files: [".planning/phases/71-multi-session-boundary/71-01-PLAN.md", ".planning/phases/71-multi-session-boundary/71-01-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-02-PLAN.md", ".planning/phases/71-multi-session-boundary/71-02-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-03-PLAN.md", ".planning/phases/71-multi-session-boundary/71-03-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-04-DOCS-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-04-PLAN.md", ".planning/phases/71-multi-session-boundary/71-04-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-05-SUMMARY.md", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/live-session-boundary.test.ts", "packages/mcp-server/src/live-session-consumer.test-support.ts", "packages/mcp-server/src/live-session-isolation.test.ts", "packages/mcp-server/src/mcp.steering.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/planning/live-session-authority.test.ts", "packages/mcp-server/src/planning/session-state.ts", "packages/mcp-server/src/planning/steering-rest.ts", "packages/mcp-server/src/planning/steering-sessions-store.ts", "packages/mcp-server/src/planning/steering-tools.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/steering-wiring.test.ts"]
covered_digest: "v3:sha256:7209dc974ff6d977eb41312e382c7b21713d739824a31970f057c574c80c5012"
behavior_unverified: 2
behavior_unverified_items:
  - truth: "Criterion 3: server-issued identities survive restart with durable ownership and tombstones; unavailable authority fails closed"
    test: "Against a controlled PostgreSQL (SUBSTRATE_TEST_PG_URL set): run packages/mcp-server/src/planning/live-session-authority.pg.test.ts and packages/mcp-server/src/live-session-restart.pg.test.ts, then confirm a closed identity cannot be reissued after a second service instance starts"
    expected: "All PG cases pass (not skipped); closed and expired identities stay terminal across instances and reconnects; disconnected authority returns session-unavailable"
    why_human: "The restart and durability clauses exist only as PostgreSQL-gated tests, which skip without SUBSTRATE_TEST_PG_URL. Not run in this verification."
  - truth: "Criterion 5: the new isolation, revocation and restart failure-injection cases pass"
    test: "Same PostgreSQL run as above, plus the steering-idempotency PG file"
    expected: "Restart and revocation injection cases pass with recorded pass and skip counts; no PG case reported as skipped"
    why_human: "Same reason: PG-gated, skipped in this run, so present but unverified."
gaps: []
overrides_applied: 0
human_verification:
  - test: "Run the phase 71 PostgreSQL cases against a controlled PostgreSQL 16 with SUBSTRATE_TEST_PG_URL set: packages/mcp-server/src/planning/live-session-authority.pg.test.ts, packages/mcp-server/src/live-session-restart.pg.test.ts, packages/mcp-server/src/planning/steering-idempotency.pg.test.ts"
    expected: "All pass with none skipped; pass and skip counts recorded"
    why_human: "PG-gated; skipped on this tree's targeted run. Restart and durability behavior cannot be proven by presence or wiring checks."
  - test: "Complete the mandated draft-PR review through Desk Quality / Programming Lead (Greptile gate)"
    expected: "Review observed, findings addressed, gate disposition recorded; a FAILED, SKIPPED or unavailable review is not a pass"
    why_human: "External review gate. Not observed in this verification and not queried."
---

# Phase 71: Multi-Session boundary — Re-verification on integration tree

**Phase goal (ROADMAP, this tree, owner revision commit 23bd0733):** Enforce authenticated bindings on live session-scoped reads and writes. Foreign and unknown targets return indistinguishable not-found responses. Live session identifiers are unguessable and never reused. Preserve operator-only steering writes and the redacted repository-wide `session_context` digest.

**Tree:** /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 7382ad10. The phase 71 section of `.planning/ROADMAP.md` is identical between HEAD and the working copy and carries the 5 criteria below.

**Status: human_needed.** No gaps found. Three criteria are verified on this tree. Criteria 3 and 5 each have a restart or durability clause that is PostgreSQL-only and was skipped in this run, so it is behavior-unverified. The external Greptile gate is outstanding.

## Method

Goal-backward inspection of the source on this tree, with the 5 roadmap criteria as the contract. Source of truth for decisions: `71-CONTEXT.md` D71-01..10. Prior record `71-VERIFICATION.md` (2026-10-31, branch-era) was read for human items and open decisions, then overwritten. Its counts were not carried forward as evidence. Line numbers below are approximate to within a few lines; the cited symbol is the anchor.

Integration-specific changes judged on this tree:

- **Commit 634b6171, lazy live-session facade.** `Substrate.liveSessions` is a memoised getter (`service.ts:1654`). The constructor stores a thunk with the same precedence as before: the steering-seam override when defined, otherwise `index.liveSessions(...)`, otherwise null (`service.ts:1886`). The boundary reads the authority through `get authority()` (`service.ts:1888-1893`), and `LiveSessionStatePort` reads `this.deps.authority` per call (`planning/session-state.ts:36`). Construction therefore never reads the index. Null authority still fails closed: `planning/steering-tools.ts` `prepareReserved` (line 84) returns `session-unavailable` before any lookup, and `service.ts` (around lines 2083, 2111, 2122) throws the same.
- **Commit 634b6171, `settle()` wall-clock wait.** `live-session-consumer.test-support.ts` (around lines 58-63) polls for up to 3 s in 5 ms ticks, with the assertion unchanged. The eight final-release isolation tests that use it passed in targeted run 1 (below). The helper is test scaffolding and does not change product behavior.
- **Phase 72 edits on the same paths.** `service.ts` (around lines 2083-2095 and 2130-2136) also applies a repo-scope gate that answers the same not-found. Not evaluated as a phase 72 criterion. It does not weaken the phase 71 not-found behavior observed here.

## Goal achievement — roadmap success criteria

| # | Criterion (ROADMAP, this tree) | Verdict | Evidence (file, symbol, approximate line) and test result |
|---|---|---|---|
| 1 | Foreign and unknown live session IDs give the same 404 status, body and headers on every private read or write (directive lists, wait/listen, MCP steering tools, docs registration/transitions, session-scoped augmentation). No directive, acknowledgement or state changes on refusal. | **VERIFIED** | Shared refusal is `liveSessionNotFound` (`planning/steering-tools.ts:40`), thrown as `LiveSessionBoundaryError` (`:41`). Missing, foreign and sibling rows all reach `authorized()` (`planning/steering-sessions-store.ts:135-146`) and return `notFound()` (`:128`). `authorized()` compares against a dummy hash for unknown rows, so timing does not split them. REST maps the refusal to 404 via `steeringHttpStatus` (`planning/steering-rest.ts:265`, not-found case at `:280`), and `server.ts:2420` → `sendSteeringResult`. MCP: `mcp.ts:1611-1627` registers the four session tools through `liveReply`, and `mcp.ts` (around lines 628 and 717) converts the refusal. Tests: `live-session-isolation.test.ts` (per-operation identical bytes, headers and no effect, with failed and missing audit), `mcp.steering.test.ts`, `live-session-boundary.test.ts`, all in targeted run 1: 108 pass, 0 fail. |
| 2 | Operator authority stays explicit and permitted cross-session operations stay available. Refusal audits hash requested identifiers and record no private session body. Principal-keyed limiting runs before binding lookup. | **VERIFIED** | `reserve()` (`steering-tools.ts:59`) runs before `prepareReserved()` in both `prepare` and `prepareBatch` (`:77`), so limiting precedes lookup. `recordDenial` stores only `sha256("substrate.live-session-refusal.v1\0" + target.slice(0,128))`. Operator bypass is limited to `OPERATOR_OPERATIONS` (`planning/steering-sessions-store.ts:125`, applied in `authorized()` at about `:143`). Operator queue/ack without operator rights returns `forbidden` (`steering-tools.ts` `prepareReserved`). Tests in run 1 and run 2 pass. |
| 3 | Server-issued session identities have at least 128 bits of CSPRNG randomness. Durable ownership and closed-session tombstones prevent reissue or cross-surface takeover, including after restart. An unavailable authority fails closed rather than accepting a volatile substitute. | **VERIFIED in-process; restart clause PRESENT_BEHAVIOR_UNVERIFIED** | Issuance draws two independent 32-byte values from `randomBytes` (`planning/steering-sessions-store.ts:217` default, drawn in `issue` at about `:269-270`), i.e. a 256-bit ID and a 256-bit proof. The ID is `ls_` + 64 hex. Insert is `on conflict (session_id) do nothing` with up to 4 fresh attempts, no upsert (about `:290`). Close and expiry set `closed_at` and never delete, so tombstones persist (`expireDue` at `:177`, close at about `:376`). Migration 42 `live_session_bindings` is mandatory with a `session_id` primary key and no opt-in (`index-store.ts:882-905`). Factory is `IndexStore.liveSessions` (`index-store.ts:1047`). Production has no volatile substitute: with no index, `service.ts:1886` yields null and `steering-tools.ts` refuses `session-unavailable`. Non-PG tests in `planning/live-session-authority.test.ts` (run 1: entropy, collisions, lost commit, every method fails closed on SQL failure) pass. **Not exercised in this run:** restart and reconnect durability. Those are PG-gated (`planning/live-session-authority.pg.test.ts`, `live-session-restart.pg.test.ts`) and skip without `SUBSTRATE_TEST_PG_URL`. **Also not directly asserted:** the absent-authority path (null index with steering on). `steering-wiring.test.ts:355` builds a Substrate with `index: null` but does not assert `session-unavailable`. |
| 4 | Operator queue/ack and the legacy unkeyed command shape are unchanged. All affected callers migrate to the explicit session identity lifecycle. No alias bypasses binding checks. | **VERIFIED** | `session_binding` is optional in every input schema (`SESSION_BINDING_INPUT` and the input objects in `planning/steering-tools.ts`), so unkeyed operator commands keep their shape. Operator authority does not need a proof for queue and ack (`OPERATOR_OPERATIONS`, `planning/steering-sessions-store.ts:125`). The CLI separates historical from live identity: `--session` vs `--steering-session` (`packages/cli/src/session/command.ts:73`, `:127`, `:134`, `:779`; `session/hook-config.ts:70`). The binding file is written atomically with mode 0600 and no symlink follow (`packages/cli/src/steer/binding-record.ts:77`, `:118`, `:135`). No removed registry or cache-granting API remains in `service.ts`, `mcp.ts` or `server.ts` (grep for `registerSession`, `grantSession`, steering TTL returned nothing). Tests: `packages/cli/src/steer/*.test.ts` and `session/hook.test.ts` passed in run 2. |
| 5 | The redacted repo-wide `session_context` digest stays as designed in Phase 67. The recorded steering regression file set and the new isolation, revocation and restart failure-injection cases are re-run with pass and skip counts recorded. | **VERIFIED for digest and isolation; restart injection PRESENT_BEHAVIOR_UNVERIFIED** | The digest reads public metadata only: `service.ts:3825` calls `listMetadata`, which selects public columns for every caller (`planning/steering-sessions-store.ts` `listing`, about `:238-260`; `listMetadata` at `:390`). Run 2 ran the recorded regression set (`planning/` directory, `server.steering`, `session-context`, `brief-sessions`, `cli/src/steer`, `session/hook.test.ts`) plus `brief-fast-path` and `steering-wiring`: **1314 pass, 24 skip, 0 fail, 42 files**. Run 1 ran the isolation and revocation cases: **108 pass, 0 fail, 0 skip, 5 files**. Restart and failure-injection PG cases were not run (see criterion 3 and human items). |

**Score:** 3/5 criteria verified on this tree (1, 2, 4). Criteria 3 and 5 are verified for their in-process clauses and are behavior-unverified for their restart clauses, which are PostgreSQL-gated and were not exercised. `behavior_unverified: 2`.

## Targeted tests run (this verifier; no Postgres; TMPDIR=/root/src/worktrees/backups/gate-tmpfs; `SUBSTRATE_TEST_PG_URL` unset)

| # | Command | Result | Log |
|---|---|---|---|
| 1 | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/live-session-isolation.test.ts packages/mcp-server/src/live-session-boundary.test.ts packages/mcp-server/src/mcp.steering.test.ts packages/mcp-server/src/planning/live-session-authority.test.ts packages/mcp-server/src/planning/steering-tools.test.ts` | **108 pass, 0 skip, 0 fail**, 1556 expect() calls, 5 files, 28.11 s | `/root/src/worktrees/backups/v71-cmd1.log` |
| 2 | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/planning packages/mcp-server/src/server.steering.test.ts packages/mcp-server/src/session-context.test.ts packages/mcp-server/src/brief-sessions.test.ts packages/mcp-server/src/brief-fast-path.test.ts packages/mcp-server/src/steering-wiring.test.ts packages/cli/src/steer packages/cli/src/session/hook.test.ts` | **1314 pass, 24 skip, 0 fail**, 57871 expect() calls, 42 files, 304.8 s | `/root/src/worktrees/backups/v71-cmd2.log` |

Skip attribution for run 2: 17 of the 24 skips are declared PG gates in `planning/live-session-authority.pg.test.ts` (13 tests) and `planning/steering-idempotency.pg.test.ts` (4 tests). The other 7 were not attributed from the log. No `test.todo` or other skip mechanism was found in the scanned files. The third permitted command was not run.

Full gate on this tree (not re-run by this verifier; orchestrator run): `/root/src/worktrees/backups/gates-int-r5.log` lines 16978–16982: **12021 pass, 2 skip, 0 fail, 443 files**.

## Artifact and wiring summary

| Artifact | Wiring | Status |
|---|---|---|
| `planning/steering-sessions-store.ts` (`bunLiveSessionAuthority`) | Used by `IndexStore.liveSessions` (`index-store.ts:1047`) and `Substrate` via `service.ts:1886` | WIRED |
| `planning/steering-tools.ts` (`LiveSessionBoundary`) | Constructed in `service.ts` with a lazy authority getter; used by REST (`server.ts`) and MCP (`mcp.ts`) | WIRED |
| Migration 42 `live_session_bindings` (`index-store.ts:882-905`) | Mandatory, no opt-in | WIRED |
| `planning/session-state.ts` | Operator ack transitions (`LiveSessionStatePort`), reads authority per call | WIRED |
| CLI `steer/binding-record.ts`, `session/command.ts`, `session/hook-config.ts` | Exact selected credentials; historical and live flags separated | WIRED |
| `packages/cli` native process against PostgreSQL | Recorded in prior verification; **not re-run here** (no PG) | UNVERIFIED on this tree |

## Anti-patterns

No `TBD`, `FIXME` or `XXX` markers were found in the scanned authority, boundary or identity files (`steering-tools.ts`, `steering-sessions-store.ts`, `server.ts`, `mcp.ts`). No `TODO` or `placeholder` markers were found in those files. No blocker.

## Conflicts between sources (reported, not resolved)

1. **Test count.** ROADMAP phase 71 status cites "one full repository run after the sweep fix (11,626 pass, 2 skip, 0 fail)". `71-VERIFICATION.md` (prior record) and `71-05-SUMMARY.md` cite 11,596 pass. This verifier did not reconcile them. The integration gate log shows 12,021 pass on this tree.
2. **CONTEXT status.** `71-CONTEXT.md` says "preliminary implementation is not complete" and its `<code_context>` describes the pre-fix tree. The roadmap criteria and D71-08 are consistent with the implementation. The CONTEXT status is stale. Not resolved here.

## Human verification required

See frontmatter `human_verification` and `behavior_unverified_items`:

1. **PostgreSQL run of phase 71 PG cases** (`planning/live-session-authority.pg.test.ts`, `live-session-restart.pg.test.ts`, `planning/steering-idempotency.pg.test.ts`) against a controlled PostgreSQL with `SUBSTRATE_TEST_PG_URL` set. Expected: all pass, none skipped, counts recorded.
2. **Desk Quality / Programming Lead Greptile gate** on the draft PR. Not observed here. An unavailable, skipped or failed review is not a pass.

## Open decisions (kept open, not upgraded)

- **Draft-PR Greptile gate** (item 2 above): open.
- **Recovery limit (D71-08 costly to reverse):** the closed logical archive does not cover `live_session_bindings`. Lost or stale tombstone history cannot be declared safe for identity reuse. Quiescence and complete-history recovery remain operator procedures. Open.
- **Operator-only, not exercised:** deployed migration 42, complete PostgreSQL backup and restore including tombstones, real host hooks and timers, real credential enablement. Open.
- **Test-count conflict** between ROADMAP and prior record (Conflicts 1): open for the parent to reconcile.
- **Absent-authority fail-closed** has no non-PG assertion (criterion 3). Open as a test gap.

## Gaps

None. No criterion is FAILED. Behavior-unverified items are routed to human verification, not counted as verified.

---

_Verified: 2026-11-02T16:07:36Z_
_Verifier: Claude (gsd-verifier), integration-tree re-verification_
