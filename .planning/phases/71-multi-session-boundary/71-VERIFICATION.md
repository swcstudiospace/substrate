---
phase: 71-multi-session-boundary
verified: "2026-11-02T18:27:13Z"
status: human_needed
score: "3/5 roadmap success criteria verified on this tree (1, 2, 4); criteria 3 and 5 verified in-process, restart/PostgreSQL clauses behavior-unverified (not run here)"
covered_files: [".planning/phases/71-multi-session-boundary/71-01-PLAN.md", ".planning/phases/71-multi-session-boundary/71-01-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-02-PLAN.md", ".planning/phases/71-multi-session-boundary/71-02-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-03-PLAN.md", ".planning/phases/71-multi-session-boundary/71-03-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-04-DOCS-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-04-PLAN.md", ".planning/phases/71-multi-session-boundary/71-04-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-05-SUMMARY.md", "packages/cli/src/steer/binding-record.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/live-session-boundary.test.ts", "packages/mcp-server/src/live-session-isolation.test.ts", "packages/mcp-server/src/mcp.steering.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planning/live-session-authority.pg.test.ts", "packages/mcp-server/src/planning/live-session-authority.test.ts", "packages/mcp-server/src/planning/session-state.ts", "packages/mcp-server/src/planning/steering-rest.ts", "packages/mcp-server/src/planning/steering-sessions-store.ts", "packages/mcp-server/src/planning/steering-tools.test.ts", "packages/mcp-server/src/planning/steering-tools.ts", "packages/mcp-server/src/server.steering.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.test.ts"]
covered_digest: "v3:sha256:1b9822970405726075eadbcb8e384ef4ce7601db84f85f90cdf31d1e308943b1"
behavior_unverified: 2
behavior_unverified_items:
  - truth: "Criterion 3: server-issued identities survive restart with durable ownership and tombstones; unavailable authority fails closed"
    test: "Against a controlled PostgreSQL 16 with SUBSTRATE_TEST_PG_URL set: run packages/mcp-server/src/planning/live-session-authority.pg.test.ts and packages/mcp-server/src/live-session-restart.pg.test.ts, then confirm a closed identity cannot be reissued after a second service instance starts"
    expected: "All PG cases pass with none skipped; closed and expired identities stay terminal across instances and reconnects; disconnected authority returns session-unavailable"
    why_human: "The restart and durability clauses exist only as PostgreSQL-gated tests, which skip without SUBSTRATE_TEST_PG_URL. Not run by this verifier (no Postgres started). The orchestrator's pg-targeted.log does not record file membership, so it is not attributed to this phase."
  - truth: "Criterion 5: the restart failure-injection and revocation cases pass on PostgreSQL"
    test: "Same PostgreSQL run as above, plus packages/mcp-server/src/planning/steering-idempotency.pg.test.ts"
    expected: "Restart and revocation injection cases pass with recorded pass and skip counts; no PG case reported as skipped"
    why_human: "PG-gated, skipped in this verifier's runs. Present but not behaviorally proven on this tree."
gaps: []
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: "3/5"
  gaps_closed:
    - "Discovery expiry write (advisory on PR 199): expiry moved out of listing() and onto issue() by commit 225b5a6c; discovery and the session digest are read-only"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Run the phase 71 PostgreSQL cases against a controlled PostgreSQL 16 with SUBSTRATE_TEST_PG_URL set: packages/mcp-server/src/planning/live-session-authority.pg.test.ts, packages/mcp-server/src/live-session-restart.pg.test.ts, packages/mcp-server/src/planning/steering-idempotency.pg.test.ts"
    expected: "All pass with none skipped; pass and skip counts recorded. Commit 225b5a6c changed live-session-authority.pg.test.ts, so this run must use the current tree (HEAD c7788f9d)."
    why_human: "PG-gated; skipped in this verifier's targeted runs. Restart and durability behavior cannot be proven by presence or wiring checks."
  - test: "Complete the mandated draft-PR review for PR 199 through Desk Quality / Programming Lead (Greptile gate). This includes the discovery expiry advisory."
    expected: "Review observed, findings addressed, gate disposition recorded; a FAILED, SKIPPED or unavailable review is not a pass"
    why_human: "External review gate. Not observed or queried by this verifier."
---

# Phase 71: Multi-Session boundary — Re-verification on integration tree

**Phase goal (ROADMAP, this tree):** Enforce authenticated bindings on live session-scoped reads and writes. Foreign and unknown targets return indistinguishable not-found responses. Live session identifiers are unguessable and never reused. Preserve operator-only steering writes and the redacted repository-wide `session_context` digest.

**Verified:** 2026-11-02T18:27:13Z
**Status:** human_needed
**Re-verification:** Yes. The prior `71-VERIFICATION.md` was read for its human items and open decisions, then overwritten.

**Tree:** /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD c7788f9d. `git merge-base --is-ancestor 225b5a6c HEAD` confirmed. The working tree has uncommitted edits to other phases' files (`.planning/phases/74-*`, and others). This verifier did not touch them and did not edit code.

## Criteria source (no silent choice)

- **Used: this tree's ROADMAP `### Phase 71`.** The origin/main text for phase 71 does not match this tree's text, so the brief's rule selects this tree's ROADMAP.
- **Differences, origin/main vs this tree (reported, not resolved):**
  - Status: origin/main reads "Not started"; this tree reads "human_needed (verified on gsd/v18-int-all 7382ad10; live items open)".
  - Count: origin/main has 4 success criteria; this tree has 5.
  - Criterion 1: origin/main requires refusal "with no write and no acknowledgement" from `/steering/directives`, `/steering/wait`, `steering_list` and `listen`. This tree requires identical 404 status, body and headers on every private read or write (including docs registration/transitions and augmentation), plus no state change on refusal.
  - Criterion 2: origin/main says "each refusal is an audited event". This tree says "refusal audits hash requested identifiers". The audit is best-effort (Residual 1).
  - Criterion 3: origin/main is the steering baseline 9b482207 (575 pass). This tree's criterion 3 is the 128-bit identity, durable ownership and tombstone requirement. Not in origin/main.
  - Criterion 4: origin/main is the `session_context` digest test. This tree's criterion 4 is the operator queue/ack contract and the legacy unkeyed command shape. On this tree the digest is criterion 5.
- **Requirement text:** HARD-S1 (`.planning/REQUIREMENTS.md:112`, identical to owner-approved commit 23bd0733). Binding. Status stays open pending the PostgreSQL clauses.

## Method

Goal-backward inspection of source on this tree, with the 5 criteria as the contract. Three `bun test` commands were run (the permitted maximum) with `TMPDIR=/root/src/worktrees/backups/gate-tmpfs` and `SUBSTRATE_TEST_PG_URL` unset. No Postgres was started. No code was edited. The full suite, tsc, lint and formatters were not run.

**Phase-note check: discovery expiry finding (advisory on PR 199). FIXED on this tree, confirmed by code and test.**
- Commit 225b5a6c moved the expiry pass out of discovery.
- `listing()` (`packages/mcp-server/src/planning/steering-sessions-store.ts:238-260`) has no expiry call. It selects public columns (`:246-247`) with `closed_at is null and expires_at > clock_timestamp()` (`:249`) and issues no write. `service.ts:2146` (discovery) and `service.ts:3861` (digest) both reach only this read path.
- The only expiry caller is `expireDueBeforeIssue` (`steering-sessions-store.ts:194-200`), reached from `issue()` at `:267`. Expiry runs before a new session's insert. It is best-effort: a failure is written to stderr under a correlation id carrying only the error class and SQLSTATE (`:198`, `failureKind` `:203-206`), and issuance continues.
- Test `discovery issues no write statement, so a scan reads the live indexes as they are` (`packages/mcp-server/src/planning/live-session-authority.test.ts:165-171`) passed in targeted run 3. It asserts exactly one statement, that it is a select, and that it reads `live_session_bindings`.
- The Greptile gate for PR 199 is kept as a human item and was not observed.

## Goal achievement — roadmap success criteria

| # | Criterion (ROADMAP, this tree) | Verdict | Evidence (file:line, symbol) and test result |
|---|---|---|---|
| 1 | Foreign and unknown live session IDs give the same 404 status, body and headers on every private read or write (directive lists, wait/listen, MCP steering tools, docs registration/transitions, session-scoped augmentation). No directive, acknowledgement or state changes on refusal. | **VERIFIED** | Shared refusal `liveSessionNotFound()` (`planning/steering-tools.ts:40`), thrown as `LiveSessionBoundaryError` (`:41-43`). Status mapping: `not-found` to 404 (`planning/steering-rest.ts:280-281`, `steeringHttpStatus`), written by `sendSteeringResult` (`server.ts:734-736`); REST catch (`server.ts:2420`); MCP steering tools (`mcp.ts:2400-2437`). Every private call passes `LiveSessionBoundary.prepare` (`steering-tools.ts:73-76`, reserve then `prepareReserved`), which denies via `deny()` (`:97`, `:124`). Call sites: `service.ts:2152-2153` (directives), `:2163-2164` (wait), `:2091` (docs_steering_session transition), `:2119` and `:2130` (heartbeat, close), `:2339` and `:6133` (memory_brief and docs_search augmentation), dispatch table `service.ts:1469-1486`. Missing, foreign, wrong-proof, expired and closed rows all return `notFound()` from `locked()` (`planning/steering-sessions-store.ts:221-236`, `:232-233`). `authorized()` (`:135-145`) compares a dummy hash when the row is missing or the proof is malformed (`:124`, `:138-141`). Refusal happens before any effect: `acknowledgeSteeringEffect` (`steering-tools.ts:163-164`) and the queue effect (`:146-148`) only run after `prepare` admits. Tests passed: `live-session-authority.test.ts` ("same-surface sibling/foreign/malformed/missing proof and unknown IDs are indistinguishable"), `live-session-boundary.test.ts`, `live-session-isolation.test.ts` (run 1, 108 pass). |
| 2 | Operator authority stays explicit and permitted cross-session operations stay available. Refusal audits hash requested identifiers and record no private session body. Principal-keyed limiting runs before binding lookup. | **VERIFIED** (audit is best-effort, see Residual 1) | Operator bypass is limited to `OPERATOR_OPERATIONS` = private-read, close, operator-queue, operator-ack (`planning/steering-sessions-store.ts:125-127`), applied in `authorized()` at `:143` only after the row exists. Owner transitions and heartbeat are never bypassed (not in the map). Operator queue or ack without operator rights returns `forbidden operator-required` after the read (`planning/steering-tools.ts:99-101`) and records a denial (`:100`). Principal-keyed limiting: `prepare` calls `reserve` (`steering-tools.ts:73-74`) before `prepareReserved` performs the lookup (`:96`); `prepareBatch` reserves all members before any lookup (`:77-78`). Refusal audit: `recordDenial` stores `target_sha256` = SHA-256 of the requested identifier, sliced to 128 characters (`steering-tools.ts:126-127`), with no session body or proof. Tests passed: `live-session-boundary.test.ts` ("all batch costs reserve before any lookup"; "REST and HTTP MCP generic audit records omit live target plaintext"), `live-session-authority.test.ts` ("operators bypass only explicit operations, never owner transitions/heartbeat or terminal state"). |
| 3 | Server-issued session identities have at least 128 bits of cryptographic randomness. Durable ownership and closed-session tombstones prevent reissue or cross-surface takeover, including after restart. An unavailable authority fails closed rather than accepting a volatile substitute. | **PRESENT_BEHAVIOR_UNVERIFIED** for the restart clause; in-process clauses VERIFIED | Entropy: default `randomBytes` from `node:crypto` (`planning/steering-sessions-store.ts:7`, `:217`). Issuance draws two independent 32-byte values, one for the ID and one for the proof (`:269-270`). The ID is `ls_` plus 64 hex (`:272`), so 256 bits. The proof is 64 hex (`:273`), so 256 bits. Wrong-length entropy returns `session-unavailable` with no credential (`:271`). Tombstones: closed rows keep their primary key. Nothing deletes a row (no `delete`/`truncate` on `live_session_bindings` in any non-test source). Expiry and close set `closed_at` (`:185`, `:376-377`). Issuance inserts with `on conflict (session_id) do nothing` (`:290`) and retries four fresh pairs (`:268`), never upserting an active or tombstone row. Durable table: migration 42 (`packages/mcp-server/src/index-store.ts:882-905`), mandatory, no opt-in. Fail closed: no authority gives `session-unavailable` (`steering-tools.ts:84`); `service.ts:1660-1663` and `:1894-1896` resolve the authority lazily, null when the index is absent; every store method wraps driver failures to `session-unavailable` (boundary `steering-tools.ts:121-122`; store `steering-sessions-store.ts:298-300`, `:309-311`, `:347-349`, `:365-367`, `:385-387`). The legacy `steering_sessions` restart cache has no runtime adapter (`steering-sessions-store.ts:2-4`; `index-store.ts:772`). Tests passed: "entropy and lost commit responses return no credential or driver diagnostics" (`live-session-authority.test.ts:107`), "four active or tombstone conflicts exhaust without upsert" (`:96`), "all private methods fail closed on SQL failure including close commit" (`:117`). Restart clause: PostgreSQL-gated only (`live-session-restart.pg.test.ts:181`; `planning/live-session-authority.pg.test.ts:63`, `:209`, `:240`, `:261`), not run here. |
| 4 | The existing operator-only queue/ack contract and legacy unkeyed command shape remain unchanged. All affected callers migrate to the explicit session identity lifecycle; no alias silently bypasses binding checks. | **VERIFIED** (one deliberate contract change recorded, see Residual 4) | `session_binding` is optional in every input schema (`SESSION_BINDING_INPUT`, `planning/steering-tools.ts:15`, used at `:19`, `:21`, `:24`, `:26`, `:27-31`, `:32`), so the command shape is unchanged. Operator queue and ack need no proof for an operator (`steering-sessions-store.ts:125-127`, `:143`). Dispatch maps each tool to one explicit operation and binding (`service.ts:1469-1486`). No alias exists: `docs_search` and `memory_brief` take the same `private-read` path only when `steering_session_id` is given (`service.ts:1482-1486`). CLI identity separation: `--session` is historical, `--steering-session` is live, and `--binding-file` carries the proof (`packages/cli/src/session/command.ts:68-73`). |
| 5 | The redacted repo-wide `session_context` digest remains available as designed in Phase 67. Re-run the recorded steering regression file set and the new isolation/revocation/restart failure-injection cases; record pass/skip counts and any deliberate contract changes. | **VERIFIED for digest and in-process isolation; restart injection PRESENT_BEHAVIOR_UNVERIFIED** | Digest: `sessionContext` (`packages/mcp-server/src/service.ts:3840`) calls `listMetadata({ repoId: scope, limit: 200 })` (`:3861`). `listMetadata` is `listing(null, …)` (`planning/steering-sessions-store.ts:390`). It selects only `session_id, owner_surface, repo_id, state, updated_at, expires_at` (`:246-247`), with no text, proof or hash, and the metadata projection `metadataOf` (`:157-166`) does the same. Discovery is read-only (see phase-note check). Tests passed: `live-session-authority.test.ts` ("metadata is cross-surface and text-free while visible discovery stays owner filtered"), `session-context.test.ts` (run 2). Counts for the regression set are in the table below; the restart and revocation injection cases are PostgreSQL-gated (Human item 1). |

**Score:** 3/5 criteria verified on this tree (1, 2, 4). Criteria 3 and 5 are verified for their in-process clauses and are behavior-unverified for their restart clauses, which are PostgreSQL-gated and were not exercised. `behavior_unverified: 2`.

## Requirements coverage

| Requirement | Source | Description | Status | Evidence |
|---|---|---|---|---|
| HARD-S1 | ROADMAP Phase 71 `Requirements:` line | Session boundary enforcement (`.planning/REQUIREMENTS.md:112`, text matches commit 23bd0733) | **Satisfied in-process; PostgreSQL durability clauses open (human). Owner-held; stays open.** | Per-operation recheck: `steering-tools.ts:73-76`, `:110-119`. Cryptographic IDs and proofs: `steering-sessions-store.ts:269-273`. Only credential hashes persisted: `binding_proof_hash` (`index-store.ts:889`; `steering-sessions-store.ts:274`). Durable ownership and tombstones: migration 42 (`index-store.ts:882-905`). Logs: the expiry failure line carries correlation id and error class only (`steering-sessions-store.ts:198`). Discovery: public columns only (`:246-247`). Cache keys: `liveCallKey` hashes the binding into an in-process dispatch key (`service.ts:1466-1467`), never stored or returned; see Open decisions. Audit: `argDigest` hashes canonical args including `session_binding` (`packages/audit/src/record.ts:180-192`, `:225`); see Open decisions. Prompts: not examined. |

## Required artifacts and wiring (Steps 4 and 5)

Artifact check (`gsd_run query verify.artifacts`, run from the worktree root on each plan's must_haves):

| Plan | Artifacts | Result |
|---|---|---|
| 71-01 | 3 | 3/3 exist, no issues (`steering-sessions-store.ts`, `index-store.ts`, `live-session-authority.pg.test.ts`) |
| 71-02 | 3 | 3/3 exist, no issues (`cli/src/steer/binding-record.ts`, `cli/src/steer/index.ts`, `cli/src/session/hook.ts`) |
| 71-03 | 5 | 5/5 exist, no issues (`steering-tools.ts`, `service.ts`, `server.ts`, `mcp.ts`, `steering-waiters.ts`) |
| 71-04 | 4 | 4/4 exist, no issues (`live-session-isolation.test.ts`, `live-session-restart.pg.test.ts`, `docs/live-steering.md`, `docs/runbooks/index-archive.md`) |

Level 2 (substantive): artifacts are not stubs. The files carry the logic read at the lines cited above.

| Artifact | Wiring | Status |
|---|---|---|
| `planning/steering-sessions-store.ts` (`bunLiveSessionAuthority`) | `index-store.ts:56` import, `IndexStore.liveSessions` (`index-store.ts:1047`) → `service.ts:1896` boundary authority getter | WIRED |
| `planning/steering-tools.ts` (`LiveSessionBoundary`, `liveSessionNotFound`) | `service.ts:213` import; used by REST (`server.ts:69`, catch `:2420`) and MCP (`mcp.ts:26`) | WIRED |
| `planning/steering-rest.ts` (`steeringHttpStatus`) | `server.ts:68` import, `sendSteeringResult` `:734-736` | WIRED |
| Migration 42 `live_session_bindings` (`index-store.ts:882-905`) | Mandatory, no opt-in | WIRED |
| `service.ts` lazy `liveSessions` getter (`:1660-1663`) | Constructor never reads the index; `resolveLive` at `:1894-1896` | WIRED |
| `planning/session-state.ts` | Reads the authority per call (`LiveSessionStatePort`, `service.ts:1914`) | WIRED |
| CLI `steer/binding-record.ts`, `session/command.ts` | Exact selected credentials; historical and live flags separated (`command.ts:68-73`) | WIRED |
| `packages/cli` native process against PostgreSQL | Not run here (no PG) | UNVERIFIED on this tree |

Level 4 (data flow): steering and digest paths read authority-backed rows (`steering-sessions-store.ts:246-253`) and return them unchanged. No hardcoded or static source was found.

**Key-link note:** `gsd_run query verify.key-links` reported `verified: 0` for the four plans, each link with "Target not referenced in source". The checker matches only literal file names in the source and cannot see the import chain. The links were therefore checked by hand against the import lines cited in the wiring table above. They are reported as WIRED on that manual evidence, not on the checker's output.

## Anti-patterns

No `TBD`, `FIXME`, `XXX`, `TODO`, `HACK` or `PLACEHOLDER` markers in `steering-sessions-store.ts`, `steering-tools.ts`, `steering-rest.ts`, `session-state.ts`, `index-store.ts` or `binding-record.ts`. No blocker. No stubs found in the cited paths.

## Behavioral spot-checks (Step 7b)

| Behavior | Command | Result | Status |
|---|---|---|---|
| Foreign and unknown IDs share one 404, plus the boundary and isolation suites | run 1 (below) | 108 pass, 0 fail, 0 skip | ✓ PASS |
| Discovery issues no write statement (phase-note check) | run 3 (below), `-t "discovery issues no write statement"` among 5 named tests | 5 pass, 0 fail, 0 skip | ✓ PASS |
| `session_context` digest metadata and REST steering routes | run 2 (below) | 55 pass, 0 fail, 0 skip | ✓ PASS |
| Restart and durable tombstones survive a second instance | `live-session-restart.pg.test.ts`, `planning/live-session-authority.pg.test.ts` | not run (PostgreSQL-gated; no Postgres started) | ? SKIP → human |

## Probe execution (Step 7c)

No probes declared. `find scripts -path '*/tests/probe-*.sh' -type f` returned nothing, and no PLAN or SUMMARY for this phase declares one. Not applicable.

## Targeted tests run (this verifier; no Postgres; TMPDIR=/root/src/worktrees/backups/gate-tmpfs; `SUBSTRATE_TEST_PG_URL` unset)

| # | Command | Result | Log |
|---|---|---|---|
| 1 | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/live-session-isolation.test.ts packages/mcp-server/src/live-session-boundary.test.ts packages/mcp-server/src/mcp.steering.test.ts packages/mcp-server/src/planning/live-session-authority.test.ts packages/mcp-server/src/planning/steering-tools.test.ts` | **108 pass, 0 skip, 0 fail**, 1556 expect() calls, 5 files, 16.41 s, exit 0 | `/root/src/worktrees/backups/v71r8-cmd1.log` |
| 2 | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/server.steering.test.ts packages/mcp-server/src/session-context.test.ts` | **55 pass, 0 skip, 0 fail**, 388 expect() calls, 2 files, 2.90 s, exit 0 | `/root/src/worktrees/backups/v71r8-cmd2.log` |
| 3 | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/planning/live-session-authority.test.ts -t "discovery issues no write statement|same-surface sibling|entropy and lost commit|issue runs exactly one bounded expiry|a failing expiry pass"` | **5 pass, 0 skip, 0 fail**, 9 filtered out, 38 expect() calls, exit 0 | `/root/src/worktrees/backups/v71r8-cmd3.log` |

Run 1 covers the five non-PostgreSQL authority, boundary, isolation, MCP steering and steering-tools files. Run 2 covers the REST steering route file and the digest file. Run 3 names the discovery-no-write test, the 404 indistinguishability test, the entropy test, and the two expiry-on-issue tests. The three bun test commands are the permitted maximum. The PostgreSQL files were excluded on purpose. The orchestrator ran the four PG files (44 pass, 0 fail, 0 skip) on a scratch Postgres 16, per `/root/src/worktrees/backups/pg-targeted.log`. That log does not record file membership, so it is not attributed to this phase here.

Full gate on this tree: not re-run by this verifier. The orchestrator runs it.

## Residuals (reported, not blocking)

1. **Denial audit is best-effort.** `recordDenial` swallows audit errors (`steering-tools.ts:127`). A refusal still returns the identical 404 when its audit fails. Rate-limited refusals (`reserve`, `steering-tools.ts:69`) are not audited, because they run before any lookup and carry no target identifier. This is the origin/main-versus-tree wording difference on criterion 2.
2. **Audit digest embeds the proof.** The MCP audit stores `argDigest` = SHA-256 of canonical call args (`packages/audit/src/record.ts:180-192`, `:225`). For `steering_list` and similar calls the args include `session_binding`, so the stored digest is a hash of the 256-bit proof. Plaintext is not stored, and reversing an unkeyed SHA-256 of a 256-bit random value is not practical. HARD-S1 says "never leak proofs through … audit", so this is flagged for the owner's judgement, not failed.
3. **Malformed vs unknown IDs.** A syntactically invalid `session_id` gets REST 400 before lookup (`steering-rest.ts:34-36`, `requiredSession`). Well-formed unknown IDs get 404.
4. **Owner unkeyed calls are refused.** The owner path in `authorized()` (`steering-sessions-store.ts:138-144`) requires a matching proof. Operator calls keep the explicit bypass. The schema shape is unchanged, but owner callers that never sent a proof now get not-found. This is a deliberate behavior change; criterion 5 asks that it be recorded.
5. **Operator bypass without proof.** `authorized()` (`:143`) lets an operator read, close, queue and ack without a proof, for the operations listed at `:125-127`. This is the explicit operator authority that criterion 2 requires. Recorded, not a defect.
6. **Test-count and status drift.** The ROADMAP phase 71 status line still reads "verified on gsd/v18-int-all 7382ad10". The ROADMAP count (11,626) and the prior record (11,596) do not match the gate log (12,021). Not reconciled.
7. **`71-CONTEXT.md`** says the preliminary implementation is incomplete. That is stale relative to the criteria and the code. Not resolved.

## Human verification required

1. **PostgreSQL run of the phase 71 PG cases.** Files: `packages/mcp-server/src/planning/live-session-authority.pg.test.ts`, `packages/mcp-server/src/live-session-restart.pg.test.ts`, `packages/mcp-server/src/planning/steering-idempotency.pg.test.ts`. Run against a controlled PostgreSQL 16 with `SUBSTRATE_TEST_PG_URL` set. Expected: all pass, none skipped, counts recorded. Use the current tree (HEAD c7788f9d), because 225b5a6c changed `live-session-authority.pg.test.ts`.
2. **PR 199 Greptile gate via Desk Quality / Programming Lead.** This includes the discovery-expiry advisory. Not observed or queried here. A FAILED, SKIPPED or unavailable review is not a pass.

## Open decisions (kept open, not upgraded)

- **Draft-PR Greptile gate for PR 199:** open (human item 2).
- **Recovery limit (D71-08, costly to reverse):** the closed logical archive does not cover `live_session_bindings`. Lost or stale tombstone history cannot be declared safe for identity reuse. Quiescence and complete-history recovery remain operator procedures. Open. Carried from the prior record; not re-verified here.
- **Operator-only, not exercised:** deployed migration 42, complete PostgreSQL backup and restore including tombstones, real host hooks and timers, real credential enablement. Open. Carried from the prior record.
- **Malformed-ID response (400 vs 404):** owner decision on whether "unknown" covers syntactically invalid IDs (Residual 3). Open.
- **Digest-of-proof in the audit record and the in-process dispatch key:** owner decision on whether a hash of the proof in `argDigest` (`record.ts:180-192`) and in `liveCallKey` (`service.ts:1466-1467`) is acceptable under "never leak proofs through … audit" and "cache keys". Open.
- **Owner unkeyed calls refused (Residual 4):** owner acceptance of this behavior change is required under criterion 5. Open.
- **Test-count conflict** between the ROADMAP status and the prior record (Residual 6): open for the parent to reconcile.

## Gaps

None. No criterion is FAILED. The behavior-unverified items are routed to human verification, not counted as verified.

---

_Verified: 2026-11-02T18:27:13Z_
_Verifier: Claude (gsd-verifier), integration-tree re-verification_
