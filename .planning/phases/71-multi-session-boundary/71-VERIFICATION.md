---
phase: 71-multi-session-boundary
verified: "2026-11-02T22:21:44Z"
status: human_needed
score: "3/5 roadmap success criteria verified on this tree (1, 2, 4); criteria 3 and 5 verified in-process, PostgreSQL restart clauses behavior-unverified by this verifier (orchestrator per-file PG logs cited, not upgraded)"
covered_files: [".planning/phases/71-multi-session-boundary/71-01-PLAN.md", ".planning/phases/71-multi-session-boundary/71-01-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-02-PLAN.md", ".planning/phases/71-multi-session-boundary/71-02-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-03-PLAN.md", ".planning/phases/71-multi-session-boundary/71-03-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-04-DOCS-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-04-PLAN.md", ".planning/phases/71-multi-session-boundary/71-04-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-05-SUMMARY.md", "packages/cli/src/steer/binding-record.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/live-session-boundary.test.ts", "packages/mcp-server/src/live-session-isolation.test.ts", "packages/mcp-server/src/live-session-restart.pg.test.ts", "packages/mcp-server/src/mcp.steering.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planning/live-session-authority.pg.test.ts", "packages/mcp-server/src/planning/live-session-authority.test.ts", "packages/mcp-server/src/planning/session-state.ts", "packages/mcp-server/src/planning/steering-idempotency.pg.test.ts", "packages/mcp-server/src/planning/steering-rest.ts", "packages/mcp-server/src/planning/steering-sessions-store.ts", "packages/mcp-server/src/planning/steering-tools.test.ts", "packages/mcp-server/src/planning/steering-tools.ts", "packages/mcp-server/src/server.steering.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.test.ts"]
covered_digest: "v3:sha256:0079c239b677144ef9baf7507ad5928c65810fcbc26f41cb024c43f1203613a9"
behavior_unverified: 2
behavior_unverified_items:
  - truth: "Criterion 3: server-issued identities survive restart with durable ownership and tombstones; a closed identity cannot be reissued after a second service instance starts; unavailable authority fails closed"
    test: "packages/mcp-server/src/live-session-restart.pg.test.ts and packages/mcp-server/src/planning/live-session-authority.pg.test.ts against PostgreSQL 16 (SUBSTRATE_TEST_PG_URL set)"
    expected: "Orchestrator per-file run: restart 16 pass / 0 fail, authority 13 pass / 0 fail, 0 skip (logs in backups). Not re-run by this verifier. Closed and expired identities stay terminal across instances; disconnected authority returns session-unavailable."
    why_human: "PG-gated. Evidence is the orchestrator's log, not this verifier's run. Kept open per owner instruction."
  - truth: "Criterion 5: restart failure-injection and revocation cases pass on PostgreSQL, including steering-idempotency.pg.test.ts"
    test: "Same PostgreSQL run, plus packages/mcp-server/src/planning/steering-idempotency.pg.test.ts"
    expected: "Pass and skip counts recorded for every PG file in this phase; no PG case skipped"
    why_human: "steering-idempotency.pg.test.ts has no per-file log. The orchestrator's pg-targeted.log (44 pass across four files) does not record file membership, so it cannot be attributed to this phase's files."
gaps: []
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: "3/5"
  gaps_closed:
    - "Discovery expiry write (advisory on PR 199): expiry moved out of listing() and onto issue() by commit 225b5a6c; discovery and the session digest are read-only (re-confirmed on HEAD 9ee12695)"
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "PostgreSQL run of the phase 71 PG files against a controlled PostgreSQL 16 on HEAD 9ee12695: packages/mcp-server/src/live-session-restart.pg.test.ts, packages/mcp-server/src/planning/live-session-authority.pg.test.ts, packages/mcp-server/src/planning/steering-idempotency.pg.test.ts"
    expected: "All pass with none skipped. Orchestrator logs already show restart 16/16 and authority 13/13 (0 skip); steering-idempotency needs its own per-file count. Record pass and skip counts per file."
    why_human: "PG-gated. Not run by this verifier; no Postgres started. Owner-held item kept open."
  - test: "Complete the mandated draft-PR review for PR 199 through Desk Quality / Programming Lead (Greptile gate), including the discovery-expiry advisory."
    expected: "Review observed, findings addressed, gate disposition recorded. A FAILED, SKIPPED or unavailable review is not a pass."
    why_human: "External review gate. Not observed or queried by this verifier."
---

# Phase 71: Multi-Session boundary — Re-verification on integration tree

**Phase goal (ROADMAP, this tree):** Enforce authenticated bindings on live session-scoped reads and writes. Foreign and unknown targets return indistinguishable not-found responses. Live session identifiers are unguessable and never reused. Preserve operator-only steering writes and the redacted repository-wide `session_context` digest.

**Verified:** 2026-11-02T22:21:44Z
**Status:** human_needed
**Re-verification:** Yes. The prior `71-VERIFICATION.md` (HEAD c7788f9d) was read for its human items and open decisions, then overwritten.

**Tree:** /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 9ee12695. `225b5a6c` is an ancestor of HEAD. No edits to code, no commits.

**Changes since the prior record (c7788f9d..9ee12695):** `git diff --name-only c7788f9d HEAD` over the phase 71 code and test paths (`planning/`, `service.ts`, `server.ts`, `mcp.ts`, `index-store.ts`, `cli/src/steer`, `cli/src/session`, `audit/`, the phase 71 test files) lists none. The one file in `packages/mcp-server/src` that changed and is in this phase's covered set is `observe.ts`. I read its diff: `openAuditLog(config)` is a new factory returning `new AuditLog({ path: config.audit.path, redact })`, and `createObservability` now calls it. The constructor arguments are unchanged, so the audit behavior the refusal path relies on is unchanged. The other changed files (`live-session-scope.test.ts`, `repo-scope*`, `reconcile-*`, `worktree-registry*`, `herdr.test.ts`) belong to phases 72, 78 and others and are outside this phase's criteria.

## Criteria source (no silent choice)

- **Used: this tree's ROADMAP `### Phase 71`.** The origin/main text does not match this tree's text, so the brief's rule selects this tree's ROADMAP.
- **Differences, origin/main vs this tree (reported, not resolved):**
  - Status: origin/main reads "Not started"; this tree reads "human_needed: 3 of 5 criteria verified on gsd/v18-int-all c7788f9d; Postgres restart clauses pending; owner items open". The tree line still names c7788f9d, not 9ee12695.
  - Count: origin/main has 4 success criteria; this tree has 5.
  - Criterion 1: origin/main requires refusal "with no write and no acknowledgement" from `/steering/directives`, `/steering/wait`, `steering_list` and `listen`. This tree requires the same 404 status, body and headers on every private read or write (directive lists, wait/listen, MCP steering tools, docs registration/transitions, session-scoped augmentation), plus no state change on refusal.
  - Criterion 2: origin/main says "each refusal is an audited event". This tree says "refusal audits hash requested identifiers". The audit is best-effort (Residual 1).
  - Criterion 3: origin/main is the steering baseline 9b482207 (575 pass). This tree's criterion 3 is the 128-bit identity, durable ownership and tombstone requirement. Not in origin/main.
  - Criterion 4: origin/main is the `session_context` digest test. This tree's criterion 4 is the operator queue/ack contract and the legacy unkeyed command shape. On this tree the digest is criterion 5.
- **Requirement text:** HARD-S1, checklist line `.planning/REQUIREMENTS.md:112`. Byte-identical to owner-approved commit 23bd0733. Binding.

## Method

Goal-backward inspection of source on this tree, with the five criteria as the contract. Points I checked myself on HEAD 9ee12695 are marked **[V]**. Points that rest only on the orchestrator's logs are marked **[O]**.

- **[V]** Authority store `packages/mcp-server/src/planning/steering-sessions-store.ts`: authorization, entropy, issuance, expiry, listing, and the read path (lines 84–312). The transition and close bodies (313–390) were not re-read line by line; their behavior is covered by the in-process suites in command 1.
- **[V]** Boundary `packages/mcp-server/src/planning/steering-tools.ts` lines 1–140: admission order, refusal construction, denial audit.
- **[V]** REST routing and status mapping (`server.ts`, `planning/steering-rest.ts`), MCP refusal rendering (`mcp.ts`), service wrapper `executeLiveCall`, `prepareLiveBatch`, discovery, directive read, wait, digest (`service.ts`).
- **[V]** Migration 42 (`index-store.ts:882-905`), fail-closed authority getter (`service.ts:1658-1663`, `1892-1896`), production wiring (only `IndexStore.liveSessions` reaches the boundary; the other `liveSessions` hits are test kits).
- **[V]** Audit digest (`packages/audit/src/record.ts:180-192`, `:225`).
- **[V]** Runbook limit for D71-08 (`docs/runbooks/index-archive.md:8`, `:30`, `:161`, `:172`).
- **[V]** Artifacts: `gsd_run query verify.artifacts` on the four plans: 15 of 15 exist, no issues.
- **[V]** Three `bun test` commands (the permitted maximum), listed below, with `TMPDIR=/root/src/worktrees/backups/gate-tmpfs` and `SUBSTRATE_TEST_PG_URL` unset. No Postgres started. No code edited.
- **[O]** PostgreSQL per-file runs (orchestrator, scratch PostgreSQL 16): see Targeted tests and Human verification. Not run by this verifier.

**Phase-note check: discovery expiry finding (advisory on PR 199). FIXED on this tree, confirmed by code and test. [V]**
- Commit 225b5a6c moved the expiry pass out of discovery.
- `listing()` (`steering-sessions-store.ts:238-260`) has no expiry call. It selects public columns only (`:246-247`), filters `closed_at is null and expires_at > clock_timestamp()` (`:249`), and issues no write.
- Discovery (`service.ts:2141-2150`) and the digest (`service.ts:3840-3861`, `listMetadata` at `:3861`, which is `listing(null, …)` at `steering-sessions-store.ts:390`) reach only this read path.
- The only expiry caller is `expireDueBeforeIssue` (`:194-200`), reached from `issue()` at `:267`. It is best-effort: failures go to stderr under a correlation id carrying only the error class and SQLSTATE (`:198`, `failureKind` `:203-206`), and issuance continues.
- Test `discovery issues no write statement, so a scan reads the live indexes as they are` (`packages/mcp-server/src/planning/live-session-authority.test.ts:165-171`) asserts exactly one statement, that it is a `select`, and that it reads `live_session_bindings`. It passed in command 3 below.
- The Greptile gate for PR 199 stays a human item. Not observed.

## Goal achievement — roadmap success criteria

| # | Criterion (ROADMAP, this tree) | Verdict | Evidence (file:line, symbol) and test result |
|---|---|---|---|
| 1 | Foreign and unknown live session IDs give the same 404 status, body and headers on every private read or write. No directive, acknowledgement or state changes on refusal. | **VERIFIED** [V] | Every authority-touching call returns the one refusal `liveSessionNotFound()` (`planning/steering-tools.ts:40`), thrown as `LiveSessionBoundaryError` (`:41-43`). Foreign, wrong-proof, expired, closed and unknown rows all reach `notFound()` through `authorized()` and the `locked()`/`read()` predicates (`steering-sessions-store.ts:135-145`, `:221-236`, `:302-312`). The dummy-hash comparison (`:138-141`) keeps the unknown-row path on the same comparison as the foreign-row path. REST: `sendSteeringResult` writes the refusal JSON with status from `steeringHttpStatus` (`server.ts:734-736`; `planning/steering-rest.ts:280-281` maps `not-found` to 404); the catch at `server.ts:2420` sends the same object for every `LiveSessionBoundaryError`. Directive list `GET /steering/directives` (`server.ts:2237-2246`) calls `readLiveDirectives` (`service.ts:2152-2161`), which is admitted by `executeLiveCall` (prepare, then the generic audit, then the dispatch) before any directive is read, and rechecked after the durable read and before it is returned (`:2158`). Wait and the CLI `listen` path (`cli/src/steer/index.ts:12`, long-poll on `/steering/wait`) run through `waitLiveDirectives` (`service.ts:2163-2179`), which rechecks on every loop turn (`:2170`, `:2175`). MCP: `liveReply` (`mcp.ts:626-629`) returns the refusal JSON with `isError: true` for every session-scoped tool (`steering_list`, `steering_queue`, `steering_acknowledge`, `docs_steering_session`, heartbeat, close, `docs_search`, `memory_brief` with `steering_session_id`). Owner transition with a mismatched repo is also a not-found (`steering-tools.ts:98`). Refusal writes nothing and acknowledges nothing: `deny()` only records a hashed denial (`:124-127`). Test: `same-surface sibling/foreign/malformed/missing proof and unknown IDs are indistinguishable` (`live-session-authority.test.ts:175`) and the isolation/boundary files, all in command 1, 0 fail. Malformed IDs differ: see Residual 3. |
| 2 | Operator authority stays explicit and permitted cross-session operations stay available. Refusal audits hash requested identifiers and record no private session body. Principal-keyed limiting runs before binding lookup. | **VERIFIED** (audit is best-effort, Residual 1) [V] | Operator bypass is the explicit map `OPERATOR_OPERATIONS` = private-read, close, operator-queue, operator-ack (`steering-sessions-store.ts:125-127`), applied in `authorized()` at `:143` only after the row is loaded. Owner transitions and heartbeat are never bypassed (not in the map). Operator queue/ack without operator rights returns `forbidden operator-required` after the read (`steering-tools.ts:99-101`) and records a denial (`:100`). Refusal audit: `recordDenial` writes `target_sha256` = SHA-256 of the requested session id, prefixed by a domain tag, with no body and no proof (`steering-tools.ts:125-127`). Principal-keyed limiting: `prepare()` calls `reserve()` before `prepareReserved()` (`:73-75`); `prepareBatch()` reserves all costs before any lookup (`:77-78`); the service batch path does the same (`service.ts:2031`). Tests: command 1 and command 3 (`same-surface sibling`, `operators bypass only explicit operations…` at `live-session-authority.test.ts:186`). |
| 3 | Session identities have at least 128 bits of cryptographic randomness. Durable ownership and closed-session tombstones prevent reissue or cross-surface takeover, including after restart. An unavailable authority fails closed. | **PRESENT_BEHAVIOR_UNVERIFIED** for the restart clause (orchestrator per-file PG evidence [O]); in-process clauses VERIFIED [V] | Entropy: `randomBytes` from `node:crypto` (`planning/steering-sessions-store.ts:7`, default at `:217`). Issuance draws two independent 32-byte values, the ID and the proof (`:269-270`). ID = `ls_` + 64 hex (`:272`), so 256 bits. Proof = 64 hex (`:273`), 256 bits. Wrong length returns `session-unavailable` with no credential (`:271`). Only the domain-separated hash of ID and proof is stored (`:131-133`, `:274`, column `binding_proof_hash` in migration 42, `index-store.ts:890`). Tombstones: close and expiry set `closed_at` and keep the row, so the primary key `session_id` (`index-store.ts:887`) blocks reissue. `issue()` retries on conflict and never upserts over a row (`:268-296`, `on conflict (session_id) do nothing`). Fail closed: the authority getter returns null without an index (`service.ts:1892-1896`), `prepareReserved` refuses with `session-unavailable` (`steering-tools.ts:84`), and any driver error becomes `unavailable()` (`steering-sessions-store.ts:298-300`, `:309-311`). No in-memory substitute exists in production (the `liveSessions` override is test-kit only; `service.ts:1718` comment). Test: `entropy and lost commit responses return no credential` (`live-session-authority.test.ts:107`), `issue draws independent values…` (`:37`), command 3, 0 fail. Restart clause: `live-session-restart.pg.test.ts` 16 of 16 and `planning/live-session-authority.pg.test.ts` 13 of 13 pass on scratch PostgreSQL 16, 0 skip, per the orchestrator's logs [O]. Not run by this verifier. |
| 4 | The operator-only queue/ack contract and legacy unkeyed command shape remain unchanged. All affected callers migrate to the explicit session identity lifecycle; no alias silently bypasses binding checks. | **VERIFIED** (one deliberate contract change recorded, Residual 4) [V] | `session_binding` is optional in every input schema (`SESSION_BINDING_INPUT`, `steering-tools.ts:15`, used at `:19`, `:21`, `:24`, `:26`, `:29`, `:32`), so the command shape is unchanged. Operator queue and ack need no proof for an operator (`steering-sessions-store.ts:125-127`, `:143`). Dispatch maps each tool to one explicit operation and session target (`service.ts:1469-1486`). No alias: `docs_search` and `memory_brief` take the private-read path only when `steering_session_id` is present (`service.ts:1482-1486`, returning `null` otherwise, which does not touch a private session). Owner transitions without proof now return not-found (Residual 4). |
| 5 | The redacted repo-wide `session_context` digest remains available as designed in Phase 67. Re-run the recorded steering regression file set and the new isolation/revocation/restart failure-injection cases; record pass/skip counts and any deliberate contract changes. | **VERIFIED for digest and in-process isolation [V]; restart failure injection PRESENT_BEHAVIOR_UNVERIFIED [O]** | Digest: `sessionContext` (`service.ts:3840`) calls `listMetadata({ repoId: scope, limit: 200 })` (`:3861`) → `listing(null, …)` (`steering-sessions-store.ts:390`). The SQL selects only `session_id, owner_surface, repo_id, state, updated_at, expires_at` (`:246-247`), filtered by `closed_at is null and expires_at > clock_timestamp()` and by repository (`:249`, `:251`). `metadataOf` (`:157-166`) builds exactly those fields. No proof, hash, steering text or planning hash leaves. Test: `session-context.test.ts` and `server.steering.test.ts` (command 2, 55 pass, 0 fail). Discovery and text-free metadata: `discovery SQL filters before cap…` (`live-session-authority.test.ts:152`) and `metadata is cross-surface and text-free…` (`:214`). Restart and revocation injection: `live-session-restart.pg.test.ts` 16 of 16 [O]; the failure-injection cases (`a failing expiry pass…`, `live-session-authority.test.ts:77`) pass in command 3. Contract changes recorded: Residual 4 (owner unkeyed calls refused). |

**Score:** 3/5 criteria verified on this tree (1, 2, 4). Criteria 3 and 5 are verified for their in-process clauses. Their restart clauses are behavior-unverified by this verifier: they rest on the orchestrator's PostgreSQL logs, which are cited but not upgraded here. `behavior_unverified: 2`.

## Requirements coverage

| Requirement | Source | Description | Status | Evidence |
|---|---|---|---|---|
| HARD-S1 | ROADMAP Phase 71 `Requirements:` line; checklist `.planning/REQUIREMENTS.md:112` (identical to 23bd0733) | Session boundary enforcement | **Satisfied in-process; PostgreSQL durability clauses open (human). Owner-held; stays open.** | Per-operation recheck: `steering-tools.ts:73-76`, `:110-119`; `service.ts:2063-2087`. Cryptographic IDs and proofs: `steering-sessions-store.ts:269-273`. Only domain-separated proof hashes persisted: `:131-133`, `:274`. Durable ownership and tombstones: migration 42 (`index-store.ts:882-905`). Logs: expiry failure line carries correlation id and error class only (`steering-sessions-store.ts:198`). Discovery: public columns only (`:246-247`). Cache keys: `liveCallKey` (`service.ts:1466-1467`) is an in-memory dispatch key and is never persisted. Open decision on the proof digest in audit (below). |
| HARD-S1 traceability row | `.planning/REQUIREMENTS.md:133` | Status column reads "Locally verified (5/5); awaiting-review / pending QUALITY" | **Discrepancy, reported, not changed.** | This verification finds 3 of 5 verified and PG clauses open, so the "5/5" traceability text is not supported on this tree. Owner or orchestrator to reconcile. |

## Required artifacts and wiring (Steps 4 and 5)

Artifact check (`gsd_run query verify.artifacts`, run from the worktree on each plan, this verification):

| Plan | Artifacts | Result |
|---|---|---|
| 71-01 | 3 | 3/3 exist, no issues |
| 71-02 | 3 | 3/3 exist, no issues |
| 71-03 | 5 | 5/5 exist, no issues |
| 71-04 | 4 | 4/4 exist, no issues |

Level 2 (substantive): the artifacts carry the logic read at the lines cited above; none is a stub.

| Artifact | Wiring | Status |
|---|---|---|
| `planning/steering-sessions-store.ts` (`bunLiveSessionAuthority`) | `index-store.ts` → `IndexStore.liveSessions` (`index-store.ts:1047`) → `service.ts:1892-1896` boundary authority getter | WIRED [V] |
| `planning/steering-tools.ts` (`LiveSessionBoundary`, `liveSessionNotFound`) | `service.ts` boundary (`:1895`); REST catch (`server.ts:2420`); MCP `liveReply` (`mcp.ts:626-629`) | WIRED [V] |
| `planning/steering-rest.ts` (`steeringHttpStatus`) | `server.ts` `sendSteeringResult` (`:734-736`) | WIRED [V] |
| Migration 42 `live_session_bindings` (`index-store.ts:882-905`) | Mandatory, no opt-in | WIRED [V] |
| `service.ts` lazy `liveSessions` getter (`:1658-1663`) | Constructor never reads the index | WIRED [V] |
| `planning/session-state.ts` | Reads the authority per call | WIRED (from prior record; not re-read this pass) |
| CLI `steer/binding-record.ts`, `session/command.ts` | Exact selected credentials; historical and live flags separated | WIRED (from prior record; not re-read this pass). Not exercised against PostgreSQL here. |
| `packages/cli` native process against PostgreSQL | Not run here | UNVERIFIED on this tree |

Level 4 (data flow): steering and digest paths read authority-backed rows (`steering-sessions-store.ts:246-253`) and return them unchanged. No hardcoded or static source was found.

**Key-link note:** `gsd_run query verify.key-links` reports wiring as not referenced for the import chains (the checker matches literal file names only). The links are checked by hand against the import lines cited above.

## Anti-patterns

No `TBD`, `FIXME`, `XXX`, `TODO`, `HACK` or `PLACEHOLDER` markers were found in the cited files in this pass. No blocker. No stubs found in the cited paths.

## Behavioral spot-checks (Step 7b)

| Behavior | Command | Result | Status |
|---|---|---|---|
| Foreign and unknown IDs share one 404, plus the boundary, isolation, MCP steering and steering-tools suites | command 1 | 108 pass, 0 fail, 0 skip | ✓ PASS [V] |
| `session_context` digest metadata and REST steering routes | command 2 | 55 pass, 0 fail, 0 skip | ✓ PASS [V] |
| Discovery issues no write statement; expiry on issue; failing expiry is reported and does not fail issue; entropy; sibling | command 3 | 5 pass, 0 fail, 0 skip (9 filtered out) | ✓ PASS [V] |
| Restart and durable tombstones survive a second instance (`live-session-restart.pg.test.ts`) | orchestrator per-file run, scratch PostgreSQL 16 | 16 pass, 0 fail, 0 skip, 10.22 s. Log `/root/src/worktrees/backups/pg-perfile-live-session-restart.pg.test.log` | [O] PASS, not re-run here; kept open |
| Authority durability and terminal identities (`planning/live-session-authority.pg.test.ts`) | orchestrator per-file run, scratch PostgreSQL 16 | 13 pass, 0 fail, 0 skip, 4.50 s. Log `/root/src/worktrees/backups/pg-perfile-live-session-authority.pg.test.log` | [O] PASS, not re-run here; kept open |
| Steering idempotency PG (`planning/steering-idempotency.pg.test.ts`) | none recorded per file | not evidenced for this phase | ? → human |

Test-count reconciliation of the orchestrator's restart log: `live-session-restart.pg.test.ts` has 10 static `test(` declarations; four of them are templated over loops (`for (const operation of ["heartbeat","transition"])` = 2, `afterCommit` = 2, `failure` = 3, `release` = 3), giving 10 runs from those four, plus 6 non-templated, for 16. The authority file has 13 static declarations and 13 runs. Both counts reconcile with the logs.

## Probe execution (Step 7c)

No probes declared. `find scripts -path '*/tests/probe-*.sh' -type f` returned nothing, and no PLAN or SUMMARY for this phase declares one. Not applicable.

## Targeted tests run (this verifier; no Postgres; TMPDIR=/root/src/worktrees/backups/gate-tmpfs; `SUBSTRATE_TEST_PG_URL` unset)

| # | Command | Result | Log |
|---|---|---|---|
| 1 | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/live-session-isolation.test.ts packages/mcp-server/src/live-session-boundary.test.ts packages/mcp-server/src/mcp.steering.test.ts packages/mcp-server/src/planning/live-session-authority.test.ts packages/mcp-server/src/planning/steering-tools.test.ts` | **108 pass, 0 skip, 0 fail**, 1556 expect() calls, 5 files, 40.40 s, exit 0 | `/root/src/worktrees/backups/verify-r6-p71-cmd1.log` |
| 2 | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/server.steering.test.ts packages/mcp-server/src/session-context.test.ts` | **55 pass, 0 skip, 0 fail**, 388 expect() calls, 2 files, 6.80 s, exit 0 | `/root/src/worktrees/backups/verify-r6-p71-cmd2.log` |
| 3 | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/planning/live-session-authority.test.ts -t "discovery issues no write statement\|same-surface sibling\|entropy and lost commit\|issue runs exactly one bounded expiry\|a failing expiry pass"` | **5 pass, 0 skip, 0 fail**, 9 filtered out, 38 expect() calls, exit 0 | `/root/src/worktrees/backups/verify-r6-p71-cmd3.log` |

Run 1 covers the five non-PostgreSQL authority, boundary, isolation, MCP steering and steering-tools files. Run 2 covers the REST steering route file and the digest file. Run 3 names the discovery-no-write test, the sibling/unknown indistinguishability test, the entropy test, and the expiry-on-issue tests. The PostgreSQL files were excluded on purpose. The grep for `skip` in all three logs returns 0.

PostgreSQL, orchestrator's evidence (not this verifier's run): restart 16/16 and authority 13/13 on scratch Postgres 16 (per-file logs above). `/root/src/worktrees/backups/pg-targeted.log` (44 pass, 0 fail, 4 files) records no file membership and is not attributed to this phase.

Full gate on this tree: not re-run by this verifier. The orchestrator's `/root/src/worktrees/backups/gates-int-r10.log` (HEAD 9ee12695) records 12075 pass, 2 skip, 0 fail (lines 17097–17099).

## Residuals (reported, not blocking)

1. **Denial audit is best-effort.** `recordDenial` swallows audit errors (`steering-tools.ts:127`). A refusal still returns the identical 404 when its audit fails. Rate-limited refusals (`reserve`, `steering-tools.ts:59-72`) are not audited, because they run before any lookup and carry no target identifier. This is the origin/main-versus-tree wording difference on criterion 2.
2. **Audit digest embeds the proof for MCP calls that carry `session_binding`.** `argDigest` = SHA-256 of canonical call args (`packages/audit/src/record.ts:180-192`, used at `:225`). MCP calls such as `steering_list`, `steering_queue`, `steering_acknowledge` and heartbeat/close carry `session_binding` in `args`, so the stored digest is a hash of the 256-bit proof. The REST audit path passes `{session_id, status}` without the binding (`service.ts:2153`). Plaintext is not stored, and inverting an unkeyed SHA-256 of a 256-bit random value is not practical. Flagged for the owner, not failed.
3. **Malformed vs unknown IDs.** A syntactically invalid `session_id` gets REST 400 before lookup (`steering-rest.ts:34-36`, `requiredSession`, used at `:128`, `:251`), and MCP zod failures return `invalid arguments` (`server.ts:769-770`). Well-formed unknown or foreign IDs get 404. The 400 reveals only the format, not existence.
4. **Owner unkeyed calls are refused.** The owner path in `authorized()` (`steering-sessions-store.ts:138-144`) requires a matching proof. An owner who never sends a proof now gets not-found on read, transition, heartbeat and close. Operator calls keep the explicit bypass. The schema shape is unchanged. This is a deliberate behavior change; criterion 5 asks that it be recorded.
5. **Operator bypass without proof.** `authorized()` (`:143`) lets an operator read, close, queue and ack without a proof, for the operations listed at `:125-127`. This is the explicit operator authority that criterion 2 requires, and `PLAN 71-01` line 73 specifies it. Recorded, not a defect.
6. **Test-count and status drift.** The ROADMAP phase 71 status line still names c7788f9d. Three counts are in circulation and are not reconciled: 11,626 pass / 2 skip (`71-05-SUMMARY.md:37`, and the ROADMAP count), 11,596 (`.planning/STATE.md:778`, source run not located in the phase directory), and 12,021 (the prior record's gate-log figure at c7788f9d). The current orchestrator gate on HEAD 9ee12695 is 12,075 pass / 2 skip / 0 fail. None of these is reconciled here.
7. **`71-CONTEXT.md`** says the preliminary implementation is incomplete. That is stale relative to the criteria and the code. Not resolved.

## Human verification required

1. **PostgreSQL per-file run of the phase 71 PG files on this tree.** Restart (16/16) and authority (13/13) have orchestrator logs on scratch Postgres 16 (0 skip). `packages/mcp-server/src/planning/steering-idempotency.pg.test.ts` has no per-file record. Owner-held; kept open. Not upgraded by this verifier.
2. **PR 199 Greptile gate via Desk Quality / Programming Lead.** This includes the discovery-expiry advisory. Not observed or queried here. A FAILED, SKIPPED or unavailable review is not a pass.

## Open decisions (kept open, not upgraded)

- **Recovery limit (D71-08, costly to reverse):** the closed logical archive does not cover `live_session_bindings`. `docs/runbooks/index-archive.md:8`, `:30` and `:161` exclude active and terminal rows; `:172` states that lost or stale tombstone history cannot be declared safe for identity reuse. Quiescence and complete-history recovery remain operator procedures. Open.
- **Operator-only, not exercised:** deployed migration 42, complete PostgreSQL backup and restore including tombstones, real host hooks and timers, real credential enablement. Open.
- **Malformed-ID response (400 vs 404):** owner decision on whether "unknown" covers syntactically invalid IDs (Residual 3). Open.
- **Digest-of-proof in the audit record and the in-process dispatch key:** owner decision on whether a hash of the proof in `argDigest` (`record.ts:180-192`) and in `liveCallKey` (`service.ts:1466-1467`) is acceptable under HARD-S1's "never leak proofs through … audit" and "cache keys". Open.
- **Owner unkeyed calls refused (Residual 4):** owner acceptance of this behavior change is required under criterion 5. Open.
- **Operator close and bypass scope (Residual 5):** recorded as the explicit operator authority in `PLAN 71-01`; owner confirmation that operator close without proof is intended. Open.
- **Test-count reconciliation** (Residual 6): open for the parent to reconcile.
- **HARD-S1 traceability row** (`REQUIREMENTS.md:133`, "Locally verified (5/5)"): not supported by this verification. Open for the owner or orchestrator to reconcile.

## Gaps

None. No criterion is FAILED. The behavior-unverified items are routed to human verification, not counted as verified.

---

_Verified: 2026-11-02T22:21:44Z_
_Verifier: Claude (gsd-verifier), integration-tree re-verification on HEAD 9ee12695_
