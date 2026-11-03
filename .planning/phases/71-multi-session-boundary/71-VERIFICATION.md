---
phase: 71-multi-session-boundary
verified: "2026-11-03T10:31:36Z"
status: human_needed
score: "3/5 roadmap success criteria verified on this tree (1, 2, 4); criteria 3 and 5 verified in-process; their PostgreSQL restart clauses are behavior-unverified by this verifier (orchestrator evidence cited, not upgraded)"
covered_files: [".planning/phases/71-multi-session-boundary/71-01-PLAN.md", ".planning/phases/71-multi-session-boundary/71-01-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-02-PLAN.md", ".planning/phases/71-multi-session-boundary/71-02-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-03-PLAN.md", ".planning/phases/71-multi-session-boundary/71-03-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-04-DOCS-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-04-PLAN.md", ".planning/phases/71-multi-session-boundary/71-04-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-05-SUMMARY.md", "packages/cli/src/steer/binding-record.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/live-session-boundary.test.ts", "packages/mcp-server/src/live-session-isolation.test.ts", "packages/mcp-server/src/live-session-restart.pg.test.ts", "packages/mcp-server/src/mcp.steering.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planning/live-session-authority.pg.test.ts", "packages/mcp-server/src/planning/live-session-authority.test.ts", "packages/mcp-server/src/planning/session-state.ts", "packages/mcp-server/src/planning/steering-idempotency.pg.test.ts", "packages/mcp-server/src/planning/steering-rest.ts", "packages/mcp-server/src/planning/steering-sessions-store.ts", "packages/mcp-server/src/planning/steering-tools.test.ts", "packages/mcp-server/src/planning/steering-tools.ts", "packages/mcp-server/src/server.steering.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.test.ts"]
covered_digest: "v3:sha256:df61b123b5dea7b0e4d4f6c24d403cad9b759628bc76b6eb267130435678e425"
behavior_unverified: 2
behavior_unverified_items:
  - truth: "Criterion 3: server-issued identities survive restart with durable ownership and tombstones; a closed identity cannot be reissued after a second service instance starts; unavailable authority fails closed"
    test: "packages/mcp-server/src/live-session-restart.pg.test.ts and packages/mcp-server/src/planning/live-session-authority.pg.test.ts against PostgreSQL (SUBSTRATE_TEST_PG_URL set)"
    expected: "Per-file orchestrator logs (pre-9ab6f111): restart 16 pass / 0 fail / 0 skip; authority 13 pass / 0 fail / 0 skip. The r18 full-suite gate log at 97defd59 records PG_READY at head 97defd59 and bun 12189 pass / 2 skip / 0 fail, with no per-file counts. Not re-run by this verifier. Closed and expired identities stay terminal across instances; a disconnected authority returns session-unavailable."
    why_human: "PG-gated. Evidence is orchestrator logs, not this verifier's run. The restart file imports service.ts, which changed after its per-file log was written. Kept open per owner instruction."
  - truth: "Criterion 5: restart failure-injection and revocation cases pass on PostgreSQL, including steering-idempotency.pg.test.ts"
    test: "Same PostgreSQL run, plus packages/mcp-server/src/planning/steering-idempotency.pg.test.ts"
    expected: "Per-file orchestrator log pg-perfile-steering-idempotency.pg.test.log (2026-11-02 18:37:04): 4 pass / 0 fail / 0 skip. Same r18 same-head gate as above, no per-file counts. Not re-run by this verifier."
    why_human: "PG-gated; orchestrator-only evidence. Kept open per owner instruction."
gaps: []
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: "3/5"
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "PostgreSQL run of the three phase 71 PG files on HEAD 97defd59: packages/mcp-server/src/live-session-restart.pg.test.ts, packages/mcp-server/src/planning/live-session-authority.pg.test.ts, packages/mcp-server/src/planning/steering-idempotency.pg.test.ts"
    expected: "All pass with none skipped. Record pass and skip counts per file against 97defd59. Prior per-file logs (restart 16/0/0, authority 13/0/0, steering-idempotency 4/0/0) predate 9ab6f111 and are not attributed to HEAD."
    why_human: "PG-gated. Not run by this verifier; no Postgres started and no third bun command used. Owner-held item kept open."
  - test: "Complete the mandated draft-PR review for PR 199 through Desk Quality / Programming Lead (Greptile gate), including the discovery-expiry advisory."
    expected: "Review observed, findings addressed, gate disposition recorded. A FAILED, SKIPPED or unavailable review is not a pass."
    why_human: "External review gate. Not observed or queried by this verifier."
---

# Phase 71: Multi-Session boundary — Re-verification at HEAD 97defd59

**Phase goal (ROADMAP.md:1232):** Enforce authenticated bindings on live session-scoped reads and writes. Foreign and unknown targets return indistinguishable not-found responses. Live session identifiers are unguessable and never reused. Preserve operator-only steering writes and the redacted repository-wide `session_context` digest.

**Verified:** 2026-11-03T10:31:36Z
**Status:** human_needed
**Re-verification:** Yes. The prior `71-VERIFICATION.md` (HEAD 9ab6f111) was read, then overwritten.

**Tree:** /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 97defd59 (2026-11-03 09:26:24 +0000). `9ab6f111` is an ancestor of HEAD. No code edits, no commits, no Postgres started, no full suite, no tsc, lint or formatters. Only the phase's VERIFICATION.md was written, in the worktree.

**Changes since the prior record (9ab6f111..97defd59):** 19 files, +444 / -78. Two commits: `d05ae871` (phase 78 reconcile bound) and `97defd59` (phase 73 memo v3 round 4). Only one file in this phase's covered implementation set changed: `packages/mcp-server/src/service.ts` (+15 / -8). Every hunk is in the anchor and pointer-verification path:

- `judgePointer` (`service.ts:875`): candidacy check first. A listed entry the job key did not sign, or that failed on chain, is `ignored`. The old `failed` results for those cases are gone.
- `readPointerChecks` (`service.ts:903`): an ignored pointer is neither verified nor a failure.
- `anchor` verify (`service.ts:8022`): a refused `SOLANA_RPC_URL` returns `ok:false` before any RPC call.

I read every hunk and searched its added and removed lines for the boundary identifiers (`liveSessions`, `LiveSessionBoundary`, `executeLiveCall`, `prepareLiveBatch`, `listLiveSessions`, `readLiveDirectives`, `waitLiveDirectives`, `sessionContext`, `listMetadata`, `liveCallKey`, `binding`, `proof`). None appears. No other covered file changed in the range (`observe.ts`, `index-store.ts`, `steering-tools.ts`, `steering-sessions-store.ts`, `steering-rest.ts`, `session-state.ts`, `server.ts`, `mcp.ts`, `binding-record.ts`, the live-session tests and PG tests are byte-identical to 9ab6f111). `service.test.ts` changed (not in the covered set; command B below runs it).

The covered digest changed from `9ddc2683…` to `df61b123…` because `service.ts` changed. Computed with `gsd_run query verification.fingerprint` at HEAD; the values above are its output, copied verbatim.

**Docs checked at HEAD:**

- `REQUIREMENTS.md:112` (HARD-S1 checklist) unchanged.
- `REQUIREMENTS.md:133` (traceability row) reads "Human-needed: 3 of 5 criteria verified on gsd/v18-int-all; Postgres restart clauses pending". Matches this verdict.
- `ROADMAP.md:1234` and the progress row at `ROADMAP.md:1419` still name commit `9ee12695`, not `9ab6f111` or `97defd59`. Stale commit id, flagged, not edited.

## Criteria source (no silent choice)

- **Used: this tree's ROADMAP `### Phase 71`**, `ROADMAP.md:1230-1250`. The five success criteria are the same text as the prior record.
- **Requirement:** HARD-S1, `.planning/REQUIREMENTS.md:112`.

## Method

Goal-backward inspection of source at HEAD 97defd59, with the five criteria as the contract. Line numbers are HEAD line numbers. Points I re-read on HEAD are marked **[V]**. Points that rest only on orchestrator logs are marked **[O]**.

- **[V]** `packages/mcp-server/src/planning/steering-tools.ts` (unchanged; cited lines re-read): refusal value and error class `:40-43`, principal reservation `:59-72`, `prepare` and `prepareBatch` (reserve before lookup) `:73-82`, `prepareReserved` `:83-104`, `read` `:120-123`, `deny` and `recordDenial` `:124-128`, `recheck` `:110-119`.
- **[V]** `packages/mcp-server/src/planning/steering-sessions-store.ts` (unchanged): entropy `:7`, `:215-217`; expiry pass `:177-200`; `issue` `:262-301`; `read` `:302-312`; `transition` `:313-349`; `listing` `:238-260`; `listMetadata` `:390`; `authorized` `:135-145`; `locked` `:221-236`; `OPERATOR_OPERATIONS` `:125-127`; `bindingHash` `:131-133`.
- **[V]** Migration 42, `packages/mcp-server/src/index-store.ts:878-905`; factory `index-store.ts:1047`.
- **[V]** `packages/mcp-server/src/service.ts` at 97defd59: `liveCallKey` and `liveInvocationFor` `:1596-1619`; `liveSessions` getter `:1790-1793`; authority source `:2022`; boundary construction `:2025-2033`; steering wiring `:2034-2042`; `prepareLiveBatch` `:2157-2171`; `auditPreparedBatch` `:2173-2191`; `executeLiveCall` `:2193-2217` (prepare `:2201`, recheck `:2215`, effect `:2216`); `updateLiveSession` `:2219-2245`; heartbeat `:2247-2256`; close `:2258-2269`; `listLiveSessions` `:2271-2280`; `readLiveDirectives` `:2282-2291`; `waitLiveDirectives` `:2293-2309`; `sessionContext` `:3970-3994`, steering source `:3989-3994`.
- **[V]** Transports (unchanged files): `server.ts:734-736` (`sendSteeringResult`), `:739` (binding header), `:765-771` (`sendLiveFault`), `:2210-2283` (session, directive, queue, acknowledge and wait routes), `:2420` (catch); `planning/steering-rest.ts:34-37`, `:128`, `:251`, `:265-293` (status mapping); `mcp.ts:626-628`, `:717`, `:1604`, `:1617-1627`, `:2414`, `:2434`.
- **[V]** Audit: `packages/audit/src/record.ts:180-192` (`argDigest`), `:225`.
- **[V]** Runbook `docs/runbooks/index-archive.md:8`, `:28`, `:161`, `:172`.
- **[V]** Artifacts and key links, re-run at HEAD on the four plans (`gsd_run query verify.artifacts` and `verify.key-links`). See Required Artifacts and Key Link Verification.
- **[V]** Two targeted `bun test` commands (the permitted maximum), listed under Targeted Tests. Run with `env -u SUBSTRATE_TEST_PG_URL` and `TMPDIR=/root/src/worktrees/backups/gate-tmpfs`.
- **[O]** PostgreSQL per-file logs (pre-9ab6f111) and the r18 gate log at 97defd59. Not re-run.

**Phase-note check: discovery expiry advisory on PR 199. Still fixed at HEAD. [V]**

- Expiry is not in discovery. `listing()` (`steering-sessions-store.ts:238-260`) has no expiry call, selects only public columns (`:246-247`), filters `closed_at is null and expires_at > clock_timestamp()` (`:249`), and performs no write.
- The only expiry caller is `expireDueBeforeIssue` (`:194-200`), called from `issue()` at `:267`. A failure is written to stderr under a correlation id with the error class and SQLSTATE only (`:198`, `failureKind` `:203-206`), and issuance continues.
- Discovery (`service.ts:2271-2280`) and the digest (`service.ts:3970-3994`) reach only `listing`.
- The Greptile gate for PR 199 stays a human item. Not observed.

## Goal achievement — roadmap success criteria

| # | Criterion (ROADMAP, this tree) | Verdict | Evidence (HEAD 97defd59, file:line) and test result |
|---|---|---|---|
| 1 | Foreign and unknown live session IDs give the same 404 status, body and headers on every private read or write. No directive, acknowledgement or state changes on refusal. | **VERIFIED** [V] | One refusal value: `liveSessionNotFound()` (`steering-tools.ts:40`), thrown as `LiveSessionBoundaryError` (`:41-43`). The authority returns `notFound()` for an absent row, a foreign or wrong-proof row, and an expired or closed row (`steering-sessions-store.ts:232-234`, `authorized` `:135-145`, `read` `:302-312`). Unknown rows still run the constant-time comparison against a dummy hash (`:137-141`). Boundary: `prepareReserved` maps not-found to `deny` (`steering-tools.ts:97`), an unresolvable or mismatched directive to `deny` (`:92`), and a repository mismatch on owner transition to `deny` (`:98`). Admission refusals run in `prepare` (`service.ts:2201-2203`), before any effect. Phase 72 repository-grant refusals run inside the effect, before any write, and answer the same not-found (`service.ts:2227-2230`, discovery `:2275`). REST renders the refusal with `sendSteeringResult` (`server.ts:734-736`) and `steeringHttpStatus` (`steering-rest.ts:280-281`, not-found to 404). MCP renders it with `liveReply` (`mcp.ts:626-628`) and `isError`. Command A, isolation file, includes "every denied target has identical bytes, application headers and no effect even with failed audit" (`live-session-isolation.test.ts:52`) across eight operations. Denial audit is best-effort (Residual 1). |
| 2 | Operator authority stays explicit and permitted cross-session operations stay available. Refusal audits hash requested identifiers and record no private session body. Principal-keyed limiting runs before binding lookup. | **VERIFIED** (audit best-effort, Residual 1) [V] | Operator bypass is the explicit map `OPERATOR_OPERATIONS` = private-read, close, operator-queue, operator-ack (`steering-sessions-store.ts:125-127`), applied in `authorized()` at `:143` after the row is loaded. Owner transitions and heartbeat are not in the map. Operator queue or ack without operator rights records a denial and returns `forbidden operator-required` after the read (`steering-tools.ts:99-101`). The refusal audit payload carries `target_sha256`, a domain-separated SHA-256 of at most 128 characters of the target, plus action, operation, surface and operator flag. No session body (`steering-tools.ts:125-127`). Principal reservation runs first: `reserve()` (`:59-72`) is called before any lookup in `prepare` (`:74`) and `prepareBatch` (`:78`). Limits are process-local buckets (`:54`). Tests: "explicit operator override is real but cannot target unknown, expired or closed identities" (`live-session-isolation.test.ts:97`), in command A. |
| 3 | Session identities have at least 128 bits of cryptographic randomness. Durable ownership and closed-session tombstones prevent reissue or cross-surface takeover, including after restart. An unavailable authority fails closed. | **PRESENT_BEHAVIOR_UNVERIFIED** for the restart clause [O]; in-process clauses VERIFIED [V] | Entropy: `randomBytes` from `node:crypto` (`steering-sessions-store.ts:7`, default `:217`). Issuance draws two independent 32-byte values, the ID and the proof (`:269-270`), with a length guard (`:271`). ID = `ls_` + 64 hex (`:272`), 256 bits. Proof = 64 hex (`:273`), 256 bits. Only the domain-separated proof hash is stored (`:131-133`, `:274`, insert `:282-293`, column `binding_proof_hash`, migration 42 `index-store.ts:890`). Durable ownership and tombstones: migration 42 is mandatory, with no opt-in (`index-store.ts:878-905`). Its comment says terminal identities are retained permanently. `session_id text primary key` (`:887`). Reissue is blocked by `on conflict (session_id) do nothing` (`steering-sessions-store.ts:290`), with four attempts and then `session-unavailable` (`:268`, `:297`). Close and expiry set `closed_at` and keep the row (`:184-185`, `:376-377`). No runtime code deletes from `live_session_bindings`; the only deletes are in PG test files and their cleanup. Fail closed: the `liveSessions` getter (`service.ts:1790-1793`) returns `null` with no index (`:2022`, `index-store.ts:1047`), and the boundary returns `session-unavailable` on a null authority (`steering-tools.ts:84`, `:112`). Read and issuance errors also become `session-unavailable` (`steering-sessions-store.ts:298-299`, `:309-310`, `:347-348`). `planning/session-state.ts` keeps no volatile registry (no `Map` or fallback) and reads the authority per call. Restart clause: PG-gated (`live-session-restart.pg.test.ts:20`, `describeLive`). See the two `behavior_unverified_items`. |
| 4 | The operator-only queue/ack contract and legacy unkeyed command shape remain unchanged. All affected callers migrate to the explicit session identity lifecycle; no alias silently bypasses binding checks. | **VERIFIED** (one deliberate contract change, Residual 4) [V] | `session_binding` is optional in every input schema (`steering-tools.ts:15`, `:19`, `:21`, `:24`, `:26`, `:29`, `:32`), so the command shape is unchanged. Operator queue and ack need no proof for an operator (`steering-sessions-store.ts:126`, `:143`). Dispatch maps each tool to one explicit operation and session target (`service.ts:1599-1619`). No alias: `docs_search` and `memory_brief` take the private-read path only when `steering_session_id` is present (`service.ts:1612-1616`, `:2463`, `:6261`). Callers: REST routes all go through the boundary (`server.ts:2210-2283`). MCP tools (`mcp.ts:1617-1627`, `:2414`, `:2434`). CLI sends the proof in `X-Substrate-Session-Binding` (`cli/src/steer/client.ts:416`), and the server reads that header (`server.ts:739`). Owner unkeyed calls are refused (Residual 4). This is a deliberate change under criterion 5. |
| 5 | The redacted repo-wide `session_context` digest remains available as designed in Phase 67. Re-run the recorded steering regression file set and the new isolation/revocation/restart failure-injection cases; record pass/skip counts and any deliberate contract changes. | **VERIFIED for digest and in-process isolation [V]; restart failure injection PRESENT_BEHAVIOR_UNVERIFIED [O]** | Digest: `sessionContext` (`service.ts:3970`) reads steering through `this.liveSessions.listMetadata({ repoId: scope, limit: 200 })` (`:3991`), which is `listing(null, …)` (`steering-sessions-store.ts:390`). The SQL selects only `session_id, owner_surface, repo_id, state, updated_at, expires_at` (`:246-247`) and filters on open, unexpired and repository (`:249`, `:251`). It never selects `steering` or `planning_hash`. `metadataOf` (`:157-166`) rejects malformed rows. Digest and isolation tests: command A (163 pass) and command B (9 pass), both 0 fail. Restart failure injection: see the second `behavior_unverified_items` entry. Contract changes recorded: Residual 4 and Residual 5. |

**Score:** 3/5 criteria verified (1, 2, 4). Criteria 3 and 5 are verified for their in-process clauses. Their restart clauses are behavior-unverified by this verifier. `behavior_unverified: 2`.

## Requirements coverage

| Requirement | Source | Description | Status | Evidence |
|---|---|---|---|---|
| HARD-S1 | ROADMAP Phase 71 `Requirements:` line; checklist `.planning/REQUIREMENTS.md:112` (unchanged) | Session boundary enforcement | **Satisfied in-process; PostgreSQL durability clauses open (human). Owner-held; stays open.** | Per-operation recheck: `steering-tools.ts:73-78`, `:110-119`; `service.ts:2215`, `:2288`, `:2300`. Cryptographic IDs and proofs: `steering-sessions-store.ts:269-273`. Only domain-separated proof hashes persisted: `:131-133`, `:274`. Durable ownership and tombstones: migration 42 (`index-store.ts:878-905`). Discovery: public columns only (`steering-sessions-store.ts:246-247`). Dispatch key: `liveCallKey` (`service.ts:1596-1598`) is a SHA-256 over canonical JSON that includes the proof, held in process memory only. Open decision below. |
| HARD-S1 traceability row | `.planning/REQUIREMENTS.md:133` | Status column | **Consistent at HEAD.** | Row reads "Human-needed: 3 of 5 criteria verified on gsd/v18-int-all; Postgres restart clauses pending", matching this verification. |

## Required artifacts and wiring (Steps 4 and 5)

Artifact check (`gsd_run query verify.artifacts`, re-run at HEAD on each plan):

| Plan | Artifacts | Result |
|---|---|---|
| 71-01 | 3 | 3/3 exist, no issues |
| 71-02 | 3 | 3/3 exist, no issues |
| 71-03 | 5 | 5/5 exist, no issues |
| 71-04 | 4 | 4/4 exist, no issues |

Level 2 (substantive): the artifacts carry the logic read at the lines cited above. None is a stub.

| Artifact | Wiring | Status |
|---|---|---|
| `planning/steering-sessions-store.ts` (`bunLiveSessionAuthority`) | `index-store.ts:56` (import), factory `index-store.ts:1047`, `IndexStore` → `service.ts:2022` | WIRED [V] |
| `planning/steering-tools.ts` (`LiveSessionBoundary`, `liveSessionNotFound`) | `service.ts:2025-2033` (boundary); `server.ts:69` (import) and `:2420` (catch); `mcp.ts:626-628` (`liveReply`) | WIRED [V] |
| `planning/steering-rest.ts` (`steeringHttpStatus`) | `server.ts` `sendSteeringResult` (`:734-736`) | WIRED [V] |
| Migration 42 `live_session_bindings` (`index-store.ts:878-905`) | Mandatory, no opt-in | WIRED [V] |
| `service.ts` lazy `liveSessions` getter (`:1790-1793`) | Constructor never reads the index | WIRED [V] |
| `planning/session-state.ts` (`LiveSessionStatePort`) | Injected at `service.ts:2044`; reads authority per call | WIRED [V] |
| CLI `steer/binding-record.ts`, `steer/client.ts`, `session/hook.ts` | `steer/index.ts:43` imports binding-record; `hook.ts:47` imports client; client paths match server routes (`server.ts:2210-2302`) | WIRED [V] |
| `packages/cli` native process against PostgreSQL | Not run here | UNVERIFIED on this tree |

Level 4 (data flow): the steering and digest paths read authority-backed rows (`steering-sessions-store.ts:246-253`) and return them unchanged (`service.ts:2276-2278`, `:3991-3993`). No hardcoded or static source found.

### Key Link Verification

`gsd_run query verify.key-links` was run at HEAD for all four plans. It reported 0 of 13 links, with "Target not referenced in source" on every one. That result is a tool limitation: the check does not match these link forms (type-only imports, route paths, harness imports). I checked each declared link by hand.

| Plan | From | To | Via (plan) | Tool | Manual (HEAD) | Status |
|---|---|---|---|---|---|---|
| 71-01 | `index-store.ts` | `planning/steering-sessions-store.ts` | `IndexStore.liveSessions` | not found | `index-store.ts:56` import, `:1047` factory | WIRED |
| 71-01 | `steering-sessions-store.ts` | `event.ts` | `nextSteeringSession` | not found | `steering-sessions-store.ts:8` import | WIRED |
| 71-01 | `service.ts` | `index-store.ts` | consumes `liveSessions` | not found | `service.ts:128` import, `:2022` | WIRED |
| 71-02 | `cli/src/steer/index.ts` | `steer/binding-record.ts` | record load and save | not found | `steer/index.ts:43` import | WIRED |
| 71-02 | `cli/src/steer/client.ts` | `mcp-server/src/server.ts` | HTTP routes | not found | client paths (`client.ts:490-530`) match server routes (`server.ts:2210-2302`); no import, by design | WIRED (route level) |
| 71-02 | `cli/src/session/hook.ts` | `cli/src/steer/client.ts` | client use | not found | `hook.ts:47` import | WIRED |
| 71-03 | `service.ts` | `planning/steering-sessions-store.ts` | authority types and factory | not found | `service.ts:218` type import, `:2022` factory | WIRED |
| 71-03 | `server.ts` | `planning/steering-tools.ts` | boundary calls | not found | `server.ts:69` import | WIRED |
| 71-03 | `mcp.ts` | `service.ts` | `Substrate` methods | not found | `mcp.ts:42` import | WIRED |
| 71-03 | `planning/steering-delivery.ts` | `planning/session-state.ts` | declared direction | not found | **Reversed.** `session-state.ts:3` imports the port type from `steering-delivery.ts`. `steering-delivery.ts:19` mentions `session-state.ts` in a comment only. The production wiring is `service.ts:2044`. | **WARNING** (plan link direction mismatch; the consumer is wired) |
| 71-04 | `live-session-isolation.test.ts` | `server.ts` | HTTP harness | not found | `live-session-isolation.test.ts:9` imports `live-session-consumer.test-support.ts`, which imports `createHttpServer` from `server.ts:8` | WIRED (indirect) |
| 71-04 | `live-session-restart.pg.test.ts` | `index-store.ts` | IndexStore | not found | `:9` import | WIRED |
| 71-04 | `docs/live-steering.md` | `cli/src/steer/index.ts` | documentation of the contract | not found | The doc describes the binding contract (`docs/live-steering.md:11`, `:17`, `:33`) but does not name the CLI file | **WARNING** (documentary link, not a code path; contract text present) |

Result: 11 of 13 declared links wired on HEAD, 2 WARNING. Neither WARNING is a goal blocker: the boundary behavior they describe is verified through other wiring (`service.ts:2044` and the transport tests). Not counted as a gap.

### Wiring patterns

- **Component → API:** the CLI client calls the routes listed above (`client.ts:490-530`), and the server routes match (`server.ts:2210-2302`).
- **API → database:** the authority issues real SQL (`steering-sessions-store.ts:246-253`, `:282-293`).
- **Form → handler and state → render:** the MCP tools (`mcp.ts:1617-1627`) reach `Substrate` methods, which call the authority. Verified by command A.

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|---|---|---|---|---|
| `service.ts` `sessionContext` | steering items | `listMetadata` → `live_session_bindings` (`:246-253`) | Yes | ✓ FLOWING |
| `steering-tools.ts` `listSteering` path | directives | `inbox` + `durableAcknowledgedFor` (`service.ts:2282-2291`) | Yes (existing phases) | ✓ FLOWING |

## Behavioral Spot-Checks (Step 7b)

| Behavior | Command | Result | Status |
|---|---|---|---|
| Foreign and unknown IDs share one 404; boundary, isolation, MCP steering, authority (discovery no-write, expiry-on-issue, failing expiry, entropy), REST and digest files | Command A | 163 pass, 0 fail, 0 skip across 7 files, 1944 expect() calls, 33.68 s, exit 0. Log `/root/src/worktrees/backups/verify-p71-97defd59-cmdA.log` | ✓ PASS [V] |
| `service.ts` private-read path (`describe` "private reads under the request budget"): authority-backed brief and docs-search steering precedence | Command B | 9 pass, 0 fail, 0 skip, 307 filtered out (the file has 316 tests at 97defd59; 310 at 9ab6f111, from the file's own changes in the range). Log `/root/src/worktrees/backups/verify-p71-97defd59-cmdB.log` | ✓ PASS [V] |
| Restart and durable tombstones survive a second instance (`live-session-restart.pg.test.ts`) | Orchestrator per-file run, pre-9ab6f111 (16/0/0); r18 full-suite gate at 97defd59 (PG_READY at head 97defd59; 12189 pass, 2 skip, 0 fail; no per-file counts) | [O] PASS, not re-run here; kept open |
| Authority durability and terminal identities (`planning/live-session-authority.pg.test.ts`) | Orchestrator per-file run, pre-9ab6f111 (13/0/0); r18 same-head gate | [O] PASS, not re-run here; kept open |
| Steering idempotency PG (`planning/steering-idempotency.pg.test.ts`) | Orchestrator per-file run (4/0/0); r18 same-head gate | [O] PASS, not re-run here; kept open |

The r18 gate log (`/root/src/worktrees/backups/gates-int-r18.log`) shows `PG_READY port=40715 head=97defd59` before its bun run. Its totals are 2 skips and 0 fail. The PG-gated describe blocks skip when `SUBSTRATE_TEST_PG_URL` is unset (`live-session-restart.pg.test.ts:20`, `live-session-authority.pg.test.ts:10`), so with 2 total skips the PG blocks most likely ran in that run [INFERENCE]. The log has no per-test or per-file pass counts. It is recorded as orchestrator evidence and does not upgrade criteria 3 or 5.

## Probe Execution (Step 7c)

No probes declared. `find scripts -path '*/tests/probe-*.sh' -type f` returned nothing, and no PLAN or SUMMARY declares one. Not applicable.

## Anti-Patterns

- No `TBD`, `FIXME`, `XXX`, `TODO`, `HACK` or `PLACEHOLDER` markers in the covered implementation files at HEAD (`binding-record.ts`, `index-store.ts`, `mcp.ts`, `observe.ts`, `session-state.ts`, `steering-rest.ts`, `steering-sessions-store.ts`, `steering-tools.ts`, `server.ts`, `service.ts`: 0 each).
- No added line in the `service.ts` diff of 9ab6f111..97defd59 carries a debt marker.
- Stub-pattern hits in the boundary files are not stubs: `steering-tools.ts:71` is `reserve()` admitting a call; `steering-sessions-store.ts:46` is the invalid-row guard.
- Debt-marker gate: not triggered. No blocker.

## Targeted tests run (this verifier; no Postgres; TMPDIR=/root/src/worktrees/backups/gate-tmpfs; `SUBSTRATE_TEST_PG_URL` unset)

| # | Command | Result | Log |
|---|---|---|---|
| A | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/live-session-isolation.test.ts packages/mcp-server/src/live-session-boundary.test.ts packages/mcp-server/src/mcp.steering.test.ts packages/mcp-server/src/planning/live-session-authority.test.ts packages/mcp-server/src/planning/steering-tools.test.ts packages/mcp-server/src/server.steering.test.ts packages/mcp-server/src/session-context.test.ts` | **163 pass, 0 skip, 0 fail**, 1944 expect() calls, 7 files, exit 0 | `/root/src/worktrees/backups/verify-p71-97defd59-cmdA.log` |
| B | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/service.test.ts -t "private reads under the request budget"` | **9 pass, 0 skip, 0 fail**, 307 filtered out, exit 0 | `/root/src/worktrees/backups/verify-p71-97defd59-cmdB.log` |

Both commands are the permitted maximum. The PG files were not run: running them would need a third `bun test` command and a Postgres instance, and both are outside this verifier's scope.

## Residuals (reported, not blocking)

1. **Denial audit is best-effort.** `recordDenial` swallows audit errors (`steering-tools.ts:127`). A refusal still returns the identical 404 when its audit fails. Rate-limited refusals (`reserve`, `:59-72`) are not audited, because they run before any lookup and carry no target identifier.
2. **Audit digest embeds the proof for MCP calls that carry `session_binding`.** `argDigest` = SHA-256 of canonical call args (`packages/audit/src/record.ts:180-192`, used at `:225`). MCP calls such as `steering_list`, `steering_queue`, `steering_acknowledge` and heartbeat/close carry `session_binding` in `args`, so the stored digest is a hash of the 256-bit proof. The REST audit path passes `{session_id, status}` without the binding. No plaintext is stored. Flagged for the owner, not failed.
3. **Malformed vs unknown IDs.** A syntactically invalid `session_id` gets REST 400 before lookup (`steering-rest.ts:34-37`, `requiredSession`, used at `:128`, `:251`), and MCP zod failures return `invalid arguments` (`server.ts:765-771`). Well-formed unknown or foreign IDs get 404. The 400 reveals only the format, not existence.
4. **Owner unkeyed calls are refused.** The owner path in `authorized()` (`steering-sessions-store.ts:138-144`) requires a matching proof. An owner who never sends a proof gets not-found on read, transition, heartbeat and close. Operator calls keep the explicit bypass. The schema shape is unchanged. Deliberate behavior change; criterion 5 asks that it be recorded.
5. **Operator bypass without proof.** `authorized()` (`:143`) lets an operator read, close, queue and ack without a proof, for the operations listed at `:125-127`. This is the explicit operator authority that criterion 2 requires, and `PLAN 71-01` specifies it. Recorded, not a defect.
6. **Test-count and status drift.** `ROADMAP.md:1234` and `:1419` still name `9ee12695`. Test counts in circulation are not reconciled: 11,626 pass / 2 skip (`71-05-SUMMARY.md`), 11,596 (`.planning/STATE.md`), r17 at 9ab6f111 (12169 pass / 2 skip / 0 fail), and r18 at 97defd59 (12189 pass / 2 skip / 0 fail). None is reconciled here.
7. **`71-CONTEXT.md`** says the preliminary implementation is incomplete. That is stale relative to the criteria and the code. Not resolved.
8. **Key-link metadata.** Two declared links are not literally present (`steering-delivery.ts` → `session-state.ts`, reversed in code; `docs/live-steering.md` → `cli/steer/index.ts`). The wiring they describe exists elsewhere (see Key Link Verification). Plan metadata correction is for the parent. Not edited here.
9. **Digest session IDs.** `session_context` lists `session_id`, surface, state and timestamps for every open session in the repository to any caller of the digest. This is the Phase 67 design, and criterion 5 requires it. IDs are not credentials: a proof is still required for every private operation (`authorized()`, `:135-145`). Informational.

## Human Verification Required

1. **PostgreSQL per-file run of the three phase 71 PG files on HEAD 97defd59.** Restart, authority and steering-idempotency. Prior per-file logs (16/0/0, 13/0/0, 4/0/0) predate 9ab6f111 and are not attributed to HEAD. The r18 same-head gate (12189 pass, 2 skip, 0 fail, PG_READY) is orchestrator evidence without per-file counts. Owner-held; kept open. Not upgraded by this verifier.
2. **PR 199 Greptile gate via Desk Quality / Programming Lead.** Includes the discovery-expiry advisory, which is fixed in code at HEAD (`steering-sessions-store.ts:238-260`, `:194-200`). Not observed or queried here. A FAILED, SKIPPED or unavailable review is not a pass.

## Open decisions (kept open, not upgraded)

- **Recovery limit (D71-08, costly to reverse):** the closed logical archive does not cover `live_session_bindings`. `docs/runbooks/index-archive.md:8`, `:28` and `:161` exclude active and terminal rows; `:172` states that lost or stale tombstone history cannot be declared safe for identity reuse. Quiescence and complete-history recovery remain operator procedures. Open.
- **Operator-only, not exercised:** deployed migration 42, complete PostgreSQL backup and restore including tombstones, real host hooks and timers, real credential enablement. Open.
- **Malformed-ID response (400 vs 404):** owner decision on whether "unknown" covers syntactically invalid IDs (Residual 3). Open.
- **Digest-of-proof in the audit record and the in-process dispatch key:** owner decision on whether a hash of the proof in `argDigest` (`record.ts:180-192`) and in `liveCallKey` (`service.ts:1596-1598`) is acceptable under HARD-S1's "never leak proofs through … audit" and "cache keys". Open.
- **Owner unkeyed calls refused (Residual 4):** owner acceptance of this behavior change is required under criterion 5. Open.
- **Operator close and bypass scope (Residual 5):** recorded as the explicit operator authority in `PLAN 71-01`; owner confirmation that operator close without proof is intended. Open.
- **Test-count reconciliation (Residual 6):** open for the parent to reconcile.
- **ROADMAP status commit id (`ROADMAP.md:1234`, `:1419`):** still names `9ee12695`. For the orchestrator to update to the HEAD the status tracks. Open.
- **Closed:** the HARD-S1 traceability row discrepancy (`REQUIREMENTS.md:133`) is consistent at HEAD.

## Gaps

None. No criterion is FAILED. The behavior-unverified items are routed to human verification, not counted as verified. The two key-link WARNINGs are not gaps. Deferred items: none.

---

_Verified: 2026-11-03T10:31:36Z_
_Verifier: Claude (gsd-verifier), integration-tree re-verification on HEAD 97defd59_
