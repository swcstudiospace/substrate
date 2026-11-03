---
phase: 71-multi-session-boundary
verified: "2026-11-03T16:04:32Z"
status: human_needed
score: "3/5 roadmap success criteria verified on this tree (1, 2, 4); criteria 3 and 5 verified in-process; their PostgreSQL restart clauses are behavior-unverified by this verifier (orchestrator evidence cited, not upgraded)"
covered_files: [".planning/phases/71-multi-session-boundary/71-01-PLAN.md", ".planning/phases/71-multi-session-boundary/71-01-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-02-PLAN.md", ".planning/phases/71-multi-session-boundary/71-02-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-03-PLAN.md", ".planning/phases/71-multi-session-boundary/71-03-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-04-DOCS-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-04-PLAN.md", ".planning/phases/71-multi-session-boundary/71-04-SUMMARY.md", ".planning/phases/71-multi-session-boundary/71-05-SUMMARY.md", "packages/cli/src/steer/binding-record.ts", "packages/mcp-server/src/index-store.ts", "packages/mcp-server/src/live-session-boundary.test.ts", "packages/mcp-server/src/live-session-isolation.test.ts", "packages/mcp-server/src/live-session-restart.pg.test.ts", "packages/mcp-server/src/mcp.steering.test.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planning/live-session-authority.pg.test.ts", "packages/mcp-server/src/planning/live-session-authority.test.ts", "packages/mcp-server/src/planning/session-state.ts", "packages/mcp-server/src/planning/steering-idempotency.pg.test.ts", "packages/mcp-server/src/planning/steering-rest.ts", "packages/mcp-server/src/planning/steering-sessions-store.ts", "packages/mcp-server/src/planning/steering-tools.test.ts", "packages/mcp-server/src/planning/steering-tools.ts", "packages/mcp-server/src/server.steering.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/session-context.test.ts", "packages/mcp-server/src/session-context.ts"]
covered_digest: "v3:sha256:e542f42e3619bc45cc5c96dabfe65ab9585498140d3e08f5fb84e3f3df9ad053"
behavior_unverified: 2
behavior_unverified_items:
  - truth: "Criterion 3: server-issued identities survive restart with durable ownership and tombstones; a closed identity cannot be reissued after a second service instance starts; unavailable authority fails closed"
    test: "packages/mcp-server/src/live-session-restart.pg.test.ts and packages/mcp-server/src/planning/live-session-authority.pg.test.ts against PostgreSQL (SUBSTRATE_TEST_PG_URL set)"
    expected: "Pre-9ab6f111 per-file orchestrator logs: restart 16 pass / 0 fail / 0 skip; authority 13 pass / 0 fail / 0 skip. The r23 full-suite gate log at 4b84e50c records PG_READY head=4b84e50c and bun 12223 pass / 2 skip / 0 fail, with no per-file counts. Not re-run by this verifier. Closed and expired identities stay terminal across instances; a disconnected authority returns session-unavailable."
    why_human: "PG-gated. Evidence is orchestrator logs, not this verifier's run. No phase 71 boundary code changed after the per-file logs were written (service.ts and index-store.ts changed at 4b84e50c only on memory and brief repo spellings). Kept open per owner instruction."
  - truth: "Criterion 5: restart failure-injection and revocation cases pass on PostgreSQL, including steering-idempotency.pg.test.ts"
    test: "Same PostgreSQL run, plus packages/mcp-server/src/planning/steering-idempotency.pg.test.ts"
    expected: "Per-file orchestrator log pg-perfile-steering-idempotency.pg.test.log (2026-11-02 18:37:04): 4 pass / 0 fail / 0 skip. Same r23 same-head gate as above, no per-file counts. Not re-run by this verifier."
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
  - test: "PostgreSQL run of the three phase 71 PG files on HEAD 4b84e50c: packages/mcp-server/src/live-session-restart.pg.test.ts, packages/mcp-server/src/planning/live-session-authority.pg.test.ts, packages/mcp-server/src/planning/steering-idempotency.pg.test.ts"
    expected: "All pass with none skipped. Record pass and skip counts per file against 4b84e50c. Prior per-file logs (restart 16/0/0, authority 13/0/0, steering-idempotency 4/0/0) predate 9ab6f111 and are not attributed to HEAD."
    why_human: "PG-gated. Not run by this verifier; no Postgres started and no second bun command used. Owner-held item kept open."
  - test: "Complete the mandated draft-PR review for PR 199 through Desk Quality / Programming Lead (Greptile gate), including the discovery-expiry advisory."
    expected: "Review observed, findings addressed, gate disposition recorded. A FAILED, SKIPPED or unavailable review is not a pass."
    why_human: "External review gate. Not observed or queried by this verifier."
---

# Phase 71: Multi-Session boundary — Re-verification at HEAD 4b84e50c

**Phase goal (ROADMAP.md:1232):** Enforce authenticated bindings on live session-scoped reads and writes. Foreign and unknown targets return indistinguishable not-found responses. Live session identifiers are unguessable and never reused. Preserve operator-only steering writes and the redacted repository-wide `session_context` digest.

**Verified:** 2026-11-03T16:04:32Z
**Status:** human_needed
**Re-verification:** Yes. The prior `71-VERIFICATION.md` (HEAD 8a604455) was read, then overwritten.

**Tree:** /root/src/worktrees/as-gsd-v18-all, branch gsd/v18-int-all, HEAD 4b84e50c (code tree clean; only `.planning/**/VERIFICATION.md` files show as modified in the working tree). `8a604455` and `97defd59` are ancestors of HEAD. No code edits, no commits, no Postgres started, no full suite, no tsc, lint or formatters. One targeted `bun test` command was run (8 files, see Targeted Tests). Only this phase's VERIFICATION.md was written, in the worktree.

**Changes since the prior record (8a604455..4b84e50c):** Commit `4b84e50c` (fix 72,73) reverts access and visibility repo comparisons from `normalizeKey` to exact `normalizeIdentifier`. Eight files changed (39 insertions, 18 deletions). Two of them are in this phase's covered implementation set, and one is evidence for criterion 5 outside the set:

- `packages/mcp-server/src/index-store.ts` (2 lines): `memorySearch` `agentRepo` (`:2650`) and `memoryForBrief` `normalizedRepo` (`:2682`).
- `packages/mcp-server/src/service.ts` (4 lines): `briefUncounted` `recallRepo` (`:2501`), `memoryRead` `callerRepo` (`:3647`, callers `:3571`, `:3619`, memory search and read only), `recallMemories` (`:3735`), and the memory-verify `reader.repo` (`:4592`).
- `packages/mcp-server/src/session-context.ts` (2 lines, outside the covered list, included in the fingerprint): `parseSessionContextArgs` returns `normalizeIdentifier(spelled) ?? spelled` (`:413`, previously `normalizeKey`).

Every hunk keeps its line count, so the line anchors in the prior record still hold for these files. I read every hunk of the covered files and of `session-context.ts`. I searched their added and removed lines for the boundary identifiers (`liveSessions`, `LiveSession`, `liveBoundary`, `executeLiveCall`, `prepareLiveBatch`, `listLiveSessions`, `readLiveDirectives`, `waitLiveDirectives`, `listMetadata`, `liveCallKey`, `liveInvocationFor`, `binding`, `proof`, `authority`). There are 0 hits. Over `97defd59..4b84e50c` the only covered implementation files that changed are `index-store.ts` and `service.ts`. The steering, transport, observe, session-state, binding-record, live-session test and PG test files are byte-identical to 97defd59. The other changed files (`capsule.ts`, `memory-policy.ts`, `memory-policy.test.ts`, `memory-write.ts`, `types.ts`) are outside the phase 71 path.

**Why the revert does not change any criterion.** The `session_id` and live-session repo keys on the boundary path are not touched by this commit. The live repository key is `scopeRepoId` (a slug regex, `event.ts:650-657`). The digest's repo argument is a slug before it reaches line 413: `parseSessionContextArgs` rejects any input with `scopeRepoId(spelled) === ""` (`session-context.ts:401`). For every slug, `normalizeIdentifier` and `normalizeKey` return the same string, so the `:413` change is value-neutral on the parsed digest path. The same holds for `service.ts:3973` (`stored`, still `normalizeKey`, used only for the graph-claims read `claimedNodesForRepo`, outside this phase). The live-session identifiers are `ls_` plus 64 lowercase hex, so they never straddle.

**Docs checked at HEAD:**

- `REQUIREMENTS.md:133` (HARD-S1 traceability row) reads "Human-needed: 3 of 5 criteria verified on gsd/v18-int-all; Postgres restart clauses pending". Matches this verdict.
- `ROADMAP.md:1234` and the progress row at `ROADMAP.md:1419` still name commit `046fbe05`, not HEAD `4b84e50c`. Stale commit id, flagged, not edited.

## Criteria source (no silent choice)

- **Used: this tree's ROADMAP `### Phase 71`**, `ROADMAP.md:1230-1250`. The five success criteria text is unchanged from the prior record (re-read at HEAD).
- **Requirement:** HARD-S1, `.planning/REQUIREMENTS.md:112` (checklist unchanged).

## Method

Goal-backward inspection of source at HEAD 4b84e50c, with the five criteria as the contract. Line numbers are HEAD line numbers. Points re-read at HEAD in this run are marked **[V]**. Points that rest only on orchestrator logs are marked **[O]**. Points carried from the prior record without re-reading are marked **[C]**.

- **[V]** `packages/mcp-server/src/planning/steering-tools.ts` (unchanged since 97defd59): `SESSION_BINDING_INPUT` `:15`; schema uses `:19`, `:21`, `:24`, `:26`, `:29`, `:32`; `LiveSessionRefusal` `:36`; `liveSessionNotFound()` `:40`; `LiveSessionBoundaryError` `:41-43`; `LiveSessionInvocation` `:46-48`; `reserve` `:59-72`; `prepare` and `prepareBatch` (reserve before lookup) `:73-82`; `prepareReserved` `:83-104` (directive resolution and deny `:90-92`; not-found deny `:97`; operator queue or ack without operator rights records a denial and returns `forbidden operator-required` `:99-101`); `recheck` `:110-119`; `read` `:120-123`; `deny` and `recordDenial` `:124-128` (target digest `:126`, audit record `:127`, refusal identical on audit failure `:127`).
- **[V]** `packages/mcp-server/src/planning/steering-sessions-store.ts` (unchanged): `randomBytes` import `:7`; `LIVE_ID` and `LIVE_PROOF` `:122-123`; `DUMMY_BINDING_HASH` `:124`; `OPERATOR_OPERATIONS` `:125-127`; `notFound` `:128`; `bindingHash` `:131-133`; `authorized` `:135-145` (unknown-row dummy comparison `:137-141`; operator bypass `:143`; owner match `:144`); `expireDue` `:177-188`; `expireDueBeforeIssue` `:194-200` (failure written to stderr with correlation id and failure kind only, `:198`); `locked` `:221-236` (`for update` `:227`, separate clock statement `:229`, not-found `:232-234`); `listing` `:238-260` (no expiry call; public columns `:246-247`; open and unexpired filter `:249`; repository filter `:251`); `issue` `:262-301` (expiry before issue `:267`; ID and proof draws `:269-270`; length guard `:271`; `ls_` ID `:272`; proof `:273`; proof hash `:274`; commit `:282-293`; `:295` returns plaintext proof once); `read` `:302-312`; `transition` `:313-349`; `listVisible` `:389`; `listMetadata` `:390`.
- **[V]** `packages/mcp-server/src/service.ts` at 4b84e50c: `liveCallKey` `:1596-1598` (SHA-256 over canonical JSON including the proof, process memory only); `liveInvocationFor` `:1599-1619` (`docs_search` and `memory_brief` private-read path only when `steering_session_id` is present, `:1612-1616`); `liveSessions` getter `:1790-1793`; authority source `:2022`; `resolveLive` `:2024`; boundary construction `:2025-2033`; steering wiring and `LiveSessionStatePort` `:2044`; `prepareLiveBatch` `:2157-2171`; `auditPreparedBatch` `:2173-2191`; `executeLiveCall` `:2193-2217` (prepare `:2201`, audit `:2210`, recheck `:2215`, effect `:2216`); `updateLiveSession` `:2219-2245` (repo gate `:2227`, checked-state branch `:2232-2233`); heartbeat `:2247-2256`; close `:2258-2269`; `listLiveSessions` `:2271-2280`; `readLiveDirectives` `:2282-2291` (recheck `:2288`); `waitLiveDirectives` `:2293-2309` (rechecks `:2300`, `:2305`); `sessionContext` `:3972-3995` (scope `:3974`, steering read `:3993`, `listMetadata` only); `appendChained` `:3091` with `assertWriteTextFields` `:3093`.
- **[V]** `packages/mcp-server/src/event.ts` (unchanged since 8a604455): `normalizeIdentifier` `:207`, `normalizeKey` `:216`, `FieldLoneSurrogateError` `:255`, `assertWriteTextFields` `:277`, `scopeRepoId` `:650-657`.
- **[V]** `packages/mcp-server/src/session-context.ts` `parseSessionContextArgs` `:397-414` (slug gate `:401`, `normalizeIdentifier` `:413`).
- **[V]** Migration 42, `packages/mcp-server/src/index-store.ts:882-905` (`live_session_bindings`, indexes `:901-905`); factory `index-store.ts:1047`.
- **[V]** Transports (files unchanged since 97defd59): `server.ts:734-736` (`sendSteeringResult`), `:739` (binding header), `:764-771` (`sendLiveFault`), `:2257` and `:2268` (queue and ack routes), `:2420` (`LiveSessionBoundaryError` to refusal), `:2428` (`InvalidEventError` to 400); `planning/steering-rest.ts:34-37` (`requiredSession`), `:128`, `:251`, `:265` (`steeringHttpStatus`); `mcp.ts:626-628`, `:717`, `:1604`, `:1617-1627`, `:2414`, `:2434`.
- **[V]** Audit: `packages/audit/src/record.ts:180` (`argDigest`), `:225`.
- **[V]** Runbook `docs/runbooks/index-archive.md:8`, `:28`, `:161`, `:172` (carried; file unchanged).
- **[V]** Artifacts and key links, re-run at HEAD on the four plans. See Required Artifacts and Key Link Verification.
- **[V]** Boundary-identifier scan of the 8a604455..4b84e50c added and removed lines: 0 hits. Debt-marker scan of the covered files at HEAD: 0 hits.
- **[V]** One targeted `bun test` command, listed under Targeted Tests.
- **[O]** PostgreSQL per-file logs (pre-9ab6f111) and the r23 gate log at 4b84e50c. Not re-run.

**Phase-note check: discovery expiry advisory on PR 199. Still fixed at HEAD. [V]**

- Expiry is not in discovery. `listing()` (`steering-sessions-store.ts:238-260`) has no expiry call, selects only public columns (`:246-247`), filters `closed_at is null and expires_at > clock_timestamp()` (`:249`), and performs no write. The three `expireDue*` references in the file are at `:177`, `:194-196` and `:267`, all in the issuance path.
- The only expiry caller is `expireDueBeforeIssue` (`:194-200`), called from `issue()` at `:267`. A failure is written to stderr under a correlation id with the failure kind only (`:198`), and issuance continues.
- Discovery (`service.ts:2271-2280`) and the digest (`service.ts:3972`, `:3993`) reach only `listing`.
- The Greptile gate for PR 199 stays a human item. Not observed.

## Goal achievement — roadmap success criteria

| # | Criterion (ROADMAP, this tree) | Verdict | Evidence (HEAD 4b84e50c, file:line) and test result |
|---|---|---|---|
| 1 | Foreign and unknown live session IDs give the same 404 status, body and headers on every private read or write. No directive, acknowledgement or state changes on refusal. | **VERIFIED** [V] | One refusal value: `liveSessionNotFound()` (`steering-tools.ts:40`), thrown as `LiveSessionBoundaryError` (`:41-43`). The authority returns `notFound()` for an absent row, a foreign or wrong-proof row, and an expired or closed row (`steering-sessions-store.ts:232-234`, `authorized` `:135-145`, `read` `:302-312`). Unknown rows still run the constant-time comparison against a dummy hash (`:137-141`). Boundary: `prepareReserved` maps not-found to `deny` (`steering-tools.ts:97`) and an unresolvable or mismatched directive to `deny` (`:92`). No state changes on refusal: `deny` records an audit only and returns the refusal (`:124-128`). Per-operation recheck before effect (`service.ts:2215`, `:2288`, `:2300`, `:2305`). Test: targeted run below, 484 pass / 0 fail (includes `live-session-isolation.test.ts`, `live-session-boundary.test.ts`, `server.steering.test.ts`, `mcp.steering.test.ts`, `service.test.ts`). |
| 2 | Operator authority stays explicit and permitted cross-session operations stay available. Refusal audits hash requested identifiers and record no private session body. Principal-keyed limiting runs before binding lookup. | **VERIFIED** (audit best-effort, Residual 1) [V] | Operator bypass is the explicit map `OPERATOR_OPERATIONS` = private-read, close, operator-queue, operator-ack (`steering-sessions-store.ts:125-127`), applied in `authorized()` at `:143` after the row is loaded. Owner transitions and heartbeat are not in the map. Operator queue or ack without operator rights records a denial and returns `forbidden operator-required` after the read (`steering-tools.ts:99-101`). The refusal audit payload carries `target_sha256`, a domain-separated SHA-256 of at most 128 target characters (`steering-tools.ts:126-127`). Rate limiting `reserve` runs before any lookup (`steering-tools.ts:59-78`). Test: targeted run. |
| 3 | Session identities have at least 128 bits of cryptographic randomness. Durable ownership and closed-session tombstones prevent reissue or cross-surface takeover, including after restart. An unavailable authority fails closed. | **PRESENT_BEHAVIOR_UNVERIFIED** for the restart clause [O]; in-process clauses VERIFIED [V] | Entropy: `randomBytes` from `node:crypto` (`steering-sessions-store.ts:7`, default `:217`). Issuance draws two independent 32-byte values, the ID and the proof (`:269-270`), with a length guard (`:271`). ID = `ls_` + 64 hex (`:272`), 256 bits. Proof = 64 hex (`:273`), 256 bits. Only the domain-separated proof hash is stored (`:131-133`, `:274`; column `binding_proof_hash`, migration 42 `index-store.ts:882-905`). Durable ownership: `live_session_bindings` rows keyed by session ID with `owner_surface`, closed rows kept as tombstones (`closed_at`, `close_reason`; `locked` `:221-236`). Unavailable authority: `validLease` and catch paths return `session-unavailable` (`:240`, `:304`, `:315`; `read` catch `:309-310`); the boundary maps a missing authority to `session-unavailable` (`steering-tools.ts:84`, `:112`). In-process tests cover entropy, expiry-on-issue and failing expiry (targeted run). Restart: no second-instance run in this verifier; see Behavior-unverified below. |
| 4 | The operator-only queue/ack contract and legacy unkeyed command shape remain unchanged. All affected callers migrate to the explicit session identity lifecycle; no alias silently bypasses binding checks. | **VERIFIED** (one deliberate contract change, Residual 4) [V] | `session_binding` is optional in every input schema (`steering-tools.ts:15` `SESSION_BINDING_INPUT`, used at `:19`, `:21`, `:24`, `:26`, `:29`, `:32`), so the command shape is unchanged. Operator queue and ack need no proof for an operator (`steering-sessions-store.ts:126`, `:143`). Dispatch maps each tool to one explicit operation and session target (`service.ts:1599-1619`). No alias: `docs_search` and `memory_brief` take the private-read path only when `steering_session_id` is present (`service.ts:1612-1616`). The owner unkeyed refusal (`authorized()` `:138-144`) is the one deliberate behavior change, recorded at Residual 4. |
| 5 | The redacted repo-wide `session_context` digest remains available as designed in Phase 67. Re-run the recorded steering regression file set and the new isolation/revocation/restart failure-injection cases; record pass/skip counts and any deliberate contract changes. | **VERIFIED for digest and in-process isolation [V]; restart failure injection PRESENT_BEHAVIOR_UNVERIFIED [O]** | Digest: `sessionContext` (`service.ts:3972`) reads steering through `this.liveSessions.listMetadata({ repoId: scope, limit: 200 })` (`:3993`), where `scope = scopeRepoId(request.repoId)` (`:3974`); this resolves to `listing(null, …)` (`steering-sessions-store.ts:390`). The SQL selects only `session_id, owner_surface, repo_id, state, updated_at, expires_at` (`:246-247`) and filters on open and unexpired rows (`:249`). The digest repo argument is a slug before the parse returns (`session-context.ts:401`, `:413`), so the 4b84e50c normalizer change there is value-neutral. Test: targeted run includes `session-context.test.ts`. Restart and revocation failure injection on PostgreSQL: [O] only. |

**Score:** 3/5 criteria verified (1, 2, 4). Criteria 3 and 5 are verified for their in-process clauses. Their restart clauses are behavior-unverified by this verifier. `behavior_unverified: 2`.

## Requirements coverage

| Requirement | Source | Description | Status | Evidence |
|---|---|---|---|---|
| HARD-S1 | ROADMAP Phase 71 `Requirements:` line; checklist `.planning/REQUIREMENTS.md:112` (unchanged) | Session boundary enforcement | **Satisfied in-process; PostgreSQL durability clauses open (human). Owner-held; stays open.** | Per-operation recheck: `steering-tools.ts:73-78`, `:110-119`; `service.ts:2215`, `:2288`, `:2300`. Cryptographic IDs and proofs: `steering-sessions-store.ts:269-273`. Only domain-separated proof hashes persisted: `:131-133`, `:274`. Durable ownership and tombstones: migration 42 (`index-store.ts:882-905`). Discovery: public columns only (`steering-sessions-store.ts:246-247`). Dispatch key: `liveCallKey` (`service.ts:1596-1598`) is a SHA-256 over canonical JSON that includes the proof, held in process memory only. Open decision below. |
| HARD-S1 traceability row | `.planning/REQUIREMENTS.md:133` | Status column | **Consistent at HEAD.** | Row reads "Human-needed: 3 of 5 criteria verified on gsd/v18-int-all; Postgres restart clauses pending", matching this verification. |

## Required artifacts and wiring (Steps 4 and 5)

Artifact check (`gsd_run query verify.artifacts`, re-run at HEAD 4b84e50c on each plan):

| Plan | Artifacts | Result |
|---|---|---|
| 71-01 | 3 | 3/3 exist, no issues (`all_passed: true`) |
| 71-02 | 3 | 3/3 exist, no issues (`all_passed: true`) |
| 71-03 | 5 | 5/5 exist, no issues (`all_passed: true`) |
| 71-04 | 4 | 4/4 exist, no issues (`all_passed: true`) |

Level 2 (substantive): the artifacts carry the logic read at the lines cited above. None is a stub.

| Artifact | Wiring | Status |
|---|---|---|
| `planning/steering-sessions-store.ts` (`bunLiveSessionAuthority`) | `index-store.ts:56` (import), factory `index-store.ts:1047`, `IndexStore` → `service.ts:2022` | WIRED [V] |
| `planning/steering-tools.ts` (`LiveSessionBoundary`, `liveSessionNotFound`) | `service.ts:2025-2033` (boundary); `server.ts:69` (import) and `:2420` (catch); `mcp.ts:626-628` (`liveReply`) | WIRED [V] |
| `planning/steering-rest.ts` (`steeringHttpStatus`) | `server.ts` `sendSteeringResult` (`:734-736`) | WIRED [V] |
| Migration 42 `live_session_bindings` (`index-store.ts:882-905`) | Mandatory, no opt-in | WIRED [V] |
| `service.ts` lazy `liveSessions` getter (`:1790-1793`) | Constructor never reads the index | WIRED [V] |
| `planning/session-state.ts` (`LiveSessionStatePort`) | Injected at `service.ts:2044`; reads authority per call | WIRED [V] |
| `planning/event.ts` helpers (`normalizeKey`, `assertWriteTextFields`), changed at 8a604455 | `service.ts:3093` (write refusal before replay lookup and tip read); `index-store.ts:12` import | WIRED [V] (ledger path only; not on the live boundary path) |
| `service.ts` memory and brief repo spellings, reverted at 4b84e50c (`:2501`, `:3647`, `:3735`, `:4592`) and `index-store.ts` memory scopes (`:2650`, `:2682`) | Memory and brief paths only (`memoryRead` callers `:3571`, `:3619`) | WIRED [V] (not on the live boundary path; no boundary identifier in the diff) |
| CLI `steer/binding-record.ts`, `steer/client.ts`, `session/hook.ts` | `steer/index.ts:43` imports binding-record; `hook.ts:47` imports client; client paths match server routes (`server.ts:2210-2302`) | WIRED [V] |
| `packages/cli` native process against PostgreSQL | Not run here | UNVERIFIED on this tree |

Level 4 (data flow): the steering and digest paths read authority-backed rows (`steering-sessions-store.ts:246-253`) and return them unchanged (`service.ts:2276-2278`, `:3993-3995`). No hardcoded or static source found.

### Key Link Verification

`gsd_run query verify.key-links` was re-run at HEAD for all four plans. It reported 0/3, 0/3, 0/4 and 0/3, with "not found" on every link. As before, that is a tool limitation: the check does not match type-only imports, route paths or harness imports. I checked each declared link by hand at HEAD.

| Plan | From | To | Via (plan) | Tool | Manual (HEAD) | Status |
|---|---|---|---|---|---|---|
| 71-01 | `index-store.ts` | `planning/steering-sessions-store.ts` | `IndexStore.liveSessions` | not found | `index-store.ts:56` import, `:1047` factory | WIRED |
| 71-01 | `steering-sessions-store.ts` | `event.ts` | `nextSteeringSession` | not found | `steering-sessions-store.ts` import line and `nextSteeringSession` call sites (`:275`, `:329`) | WIRED |
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
| 71-04 | `docs/live-steering.md` | `cli/src/steer/index.ts` | documentation of the contract | not found | The doc describes the binding contract (`docs/live-steering.md:9`, `:11`, `:13`, `:23`) but does not name the CLI file | **WARNING** (documentary link, not a code path; contract text present) |

## Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `service.ts` `sessionContext` | steering items | `listMetadata` → `live_session_bindings` (`steering-sessions-store.ts:246-253`) | Yes | ✓ FLOWING |
| `steering-tools.ts` `listSteering` path | directives | `inbox` + `durableAcknowledgedFor` (`service.ts:2282-2291`) | Yes (existing phases) | ✓ FLOWING |

## Behavioral Spot-Checks (Step 7b)

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Foreign and unknown IDs share one 404; boundary, isolation, MCP steering, authority (discovery no-write, expiry-on-issue, failing expiry, entropy), REST, digest and `service.test.ts` private-read and steering-precedence files | Command A (below) | 484 pass, 0 fail, 0 skip across 8 files, 3098 expect() calls, 17.16 s, exit 0. Raw output `artifact://4309` | ✓ PASS [V] |
| `service.ts` private-read path ("private reads under the request budget and the docs steering precedence", `service.test.ts:6252`) | Inside Command A (whole file) | Whole file passes with 0 fail. The 4b84e50c `recallRepo` change on the brief path is value-neutral for slugs and is exercised by the file run | ✓ PASS [V] (file-level; per-test count not isolated) |
| Restart and durable tombstones survive a second instance (`live-session-restart.pg.test.ts`) | Orchestrator per-file run, pre-9ab6f111 (16/0/0); r23 full-suite gate at 4b84e50c (PG_READY head=4b84e50c; 12223 pass, 2 skip, 0 fail; no per-file counts) | [O] PASS, not re-run here; kept open |
| Authority durability and terminal identities (`planning/live-session-authority.pg.test.ts`) | Orchestrator per-file run, pre-9ab6f111 (13/0/0); r23 same-head gate | [O] PASS, not re-run here; kept open |
| Steering idempotency PG (`planning/steering-idempotency.pg.test.ts`) | Orchestrator per-file run (4/0/0); r23 same-head gate | [O] PASS, not re-run here; kept open |

The r23 gate log (`/root/src/worktrees/backups/gates-int-r23.log`) shows `PG_READY port=39319 head=4b84e50c` before its bun run, then `12223 pass`, `2 skip`, `0 fail`, `Ran 12225 tests across 446 files`. Its output includes stderr blocks headed `packages/mcp-server/src/live-session-restart.pg.test.ts:` and an abort-trace block from `live-session-isolation.test.ts` (steer client), which suggests the restart PG block executed [INFERENCE]. The log has no per-file pass counts for the authority or idempotency PG files, and no per-file lines for them by name. It is recorded as orchestrator evidence and does not upgrade criteria 3 or 5.

## Probe Execution (Step 7c)

No probes declared. `find scripts -path '*/tests/probe-*.sh' -type f` returned nothing, and no PLAN or SUMMARY for this phase declares one. Not applicable.

## Anti-Patterns

- Debt-marker scan (`TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, `PLACEHOLDER`) over the covered implementation files at HEAD, including `service.ts`, `index-store.ts`, `session-context.ts` and `event.ts`: 0 matches. The added lines of the 8a604455..4b84e50c diff contain no debt marker.
- Stub-pattern hits in the boundary files are not stubs: `steering-tools.ts:71` is `reserve()` (`:59-72`) admitting a call; `steering-sessions-store.ts:151-152` is the invalid-row guard that throws on a malformed stored row.
- Debt-marker gate: not triggered. No blocker.

## Targeted tests run (this verifier; no Postgres; TMPDIR=/root/src/worktrees/backups/gate-tmpfs; `SUBSTRATE_TEST_PG_URL` unset)

| # | Command | Result | Log |
|---|---|---|---|
| A | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/live-session-isolation.test.ts packages/mcp-server/src/live-session-boundary.test.ts packages/mcp-server/src/mcp.steering.test.ts packages/mcp-server/src/planning/live-session-authority.test.ts packages/mcp-server/src/planning/steering-tools.test.ts packages/mcp-server/src/server.steering.test.ts packages/mcp-server/src/session-context.test.ts packages/mcp-server/src/service.test.ts` | **484 pass, 0 skip, 0 fail**, 3098 expect() calls, 8 files, 17.16 s, exit 0 | `artifact://4309` |

Arithmetic check [INFERENCE]: the prior record's seven files gave 163 pass (97defd59 and 8a604455). `service.test.ts` has 321 `test(`/`it(` declarations (grep count). 163 + 321 = 484, matching the run's total, so the per-file split is consistent with the run, though bun did not print per-file counts.

Command A is the only `bun test` command this verifier ran. The PG files were not run: running them would need Postgres, which is outside this verifier's scope.

## Residuals (reported, not blocking)

1. **Denial audit is best-effort.** `recordDenial` swallows audit errors (`steering-tools.ts:127`). A refusal still returns the identical 404 when its audit fails. Rate-limited refusals (`reserve`, `:59-72`) are not audited, because they run before any lookup and carry no target identifier.
2. **Audit digest embeds the proof for MCP calls that carry `session_binding`.** `argDigest` = SHA-256 of canonical call args (`packages/audit/src/record.ts:180-192`, used at `:225`). MCP calls such as `steering_list`, `steering_queue`, `steering_acknowledge` and heartbeat/close carry `session_binding` in `args`, so the stored digest is a hash of the 256-bit proof. The REST audit path passes `{session_id, status}` without the binding. No plaintext is stored. Flagged for the owner, not failed.
3. **Malformed vs unknown IDs.** A syntactically invalid `session_id` gets REST 400 before lookup (`steering-rest.ts:34-37`, `requiredSession`, used at `:128`, `:251`), and MCP zod failures return `invalid arguments` (`server.ts:765-771`). Well-formed unknown or foreign IDs get 404. The 400 reveals only the format, not existence.
4. **Owner unkeyed calls are refused.** The owner path in `authorized()` (`steering-sessions-store.ts:138-144`) requires a matching proof. An owner who never sends a proof gets not-found on read, transition, heartbeat and close. Operator calls keep the explicit bypass. The schema shape is unchanged. Deliberate behavior change; criterion 5 asks that it be recorded.
5. **Operator bypass without proof.** `authorized()` (`:143`) lets an operator read, close, queue and ack without a proof, for the operations listed at `:125-127`. This is the explicit operator authority that criterion 2 requires, and `PLAN 71-01` specifies it. Recorded, not a defect.
6. **Test-count and status drift.** `ROADMAP.md:1234` and `:1419` name `046fbe05`, not HEAD `4b84e50c`. Test counts in circulation are not reconciled: 11,626 pass / 2 skip (`71-05-SUMMARY.md`), 11,596 (`.planning/STATE.md`), r17 at 9ab6f111 (12169 pass / 2 skip / 0 fail), r18 at 97defd59 (12189 / 2 / 0), r22 at 8a604455 (12222 / 2 / 0), and r23 at 4b84e50c (12223 pass / 2 skip / 0 fail, 12225 tests across 446 files). None is reconciled here.
7. **`71-CONTEXT.md`** says the preliminary implementation is incomplete. That is stale relative to the criteria and the code. Not resolved.
8. **Key-link metadata.** Two declared links are not literally present (`steering-delivery.ts` → `session-state.ts`, reversed in code; `docs/live-steering.md` → `cli/steer/index.ts`). The wiring they describe exists elsewhere (see Key Link Verification). Plan metadata correction is for the parent. Not edited here.
9. **Digest session IDs.** `session_context` lists `session_id`, surface, state and timestamps for every open session in the repository to any caller of the digest. This is the Phase 67 design, and criterion 5 requires it. IDs are not credentials: a proof is still required for every private operation (`authorized()`, `:135-145`). Informational.
10. **Lone-surrogate refusal ordering (from 8a604455, unchanged).** `FieldLoneSurrogateError` (an `InvalidEventError`, so HTTP 400 at `server.ts:2428`) is raised only inside `appendChained`. On the live path that is reached only after admission: foreign and unknown callers are refused at `prepare` (`service.ts:2201`) before audit (`:2210`) and effect (`:2216`). An admitted owner whose audit write is refused gets `audit-unavailable` (`auditPreparedBatch` catch, `:2183-2184`). No foreign-visible difference was found [INFERENCE: the audit payload's fields were not traced further].
11. **Session_id and repo straddle data (from 8a604455, unchanged).** Pre-change rows whose `session_id` or `repo` straddled 512 code units can be stored with a lone high surrogate and will not match a read by the same id. This is the owner's data decision named in the commit. It does not touch live session IDs (`ls_` plus 64 hex) or the live repository key (`scopeRepoId`), so it does not affect this phase's boundary.
12. **New at 4b84e50c: access-comparison revert (outside phase 71).** The revert of repo access and visibility comparisons to `normalizeIdentifier` (fix 72,73) touches no boundary code (0 boundary identifiers in the diff). Owner items named in that commit remain open and are outside phase 71: the ledger row written with scope off keeps the trimmed repo (`event.ts`); pre-existing straddling rows (`session_id`, `repo`, `branch`, `node_id`, `linear_identifier`) are open data items; `branch`, `node_id` and `linear_identifier` still cut at 512 units without the trim (W-L3b). `service.ts:3973` keeps `normalizeKey` for the graph-claims read; value-neutral for slugs and not a phase 71 surface.

## Human Verification Required

1. **PostgreSQL per-file run of the three phase 71 PG files on HEAD 4b84e50c.** Restart, authority and steering-idempotency. Prior per-file logs (16/0/0, 13/0/0, 4/0/0) predate 9ab6f111 and are not attributed to HEAD. The r23 same-head gate (12223 pass, 2 skip, 0 fail, PG_READY head=4b84e50c) is orchestrator evidence without per-file counts. Owner-held; kept open. Not upgraded by this verifier.
2. **PR 199 Greptile gate via Desk Quality / Programming Lead.** Includes the discovery-expiry advisory, which is fixed in code at HEAD (`steering-sessions-store.ts:238-260`, `:194-200`). Not observed or queried here. A FAILED, SKIPPED or unavailable review is not a pass.

## Open decisions (kept open, not upgraded)

- **Recovery limit (D71-08, costly to reverse):** the closed logical archive does not cover `live_session_bindings`. `docs/runbooks/index-archive.md:8`, `:28` and `:161` exclude active and terminal rows; `:172` states that lost or stale tombstone history cannot be declared safe for identity reuse. Quiescence and complete-history recovery remain operator procedures. Open.
- **Operator-only, not exercised:** deployed migration 42, complete PostgreSQL backup and restore including tombstones, real host hooks and timers, real credential enablement. Open.
- **Malformed-ID response (400 vs 404):** owner decision on whether "unknown" covers syntactically invalid IDs (Residual 3). Open.
- **Digest-of-proof in the audit record and the in-process dispatch key:** owner decision on whether a hash of the proof in `argDigest` (`record.ts:180-192`) and in `liveCallKey` (`service.ts:1596-1598`) is acceptable under HARD-S1's "never leak proofs through … audit" and "cache keys". Open.
- **Owner unkeyed calls refused (Residual 4):** owner acceptance of this behavior change is required under criterion 5. Open.
- **Operator close and bypass scope (Residual 5):** recorded as the explicit operator authority in `PLAN 71-01`; owner confirmation that operator close without proof is intended. Open.
- **Test-count reconciliation (Residual 6):** open for the parent to reconcile.
- **ROADMAP status commit id (`ROADMAP.md:1234`, `:1419`):** names `046fbe05`, not HEAD `4b84e50c`. For the orchestrator to update to the HEAD the status tracks. Open.
- **Lone-surrogate and straddle data (Residuals 11 and 12):** owner data decisions, outside this phase's boundary. Open.
- **Closed:** the HARD-S1 traceability row discrepancy (`REQUIREMENTS.md:133`) is consistent at HEAD.

## Gaps

None. No criterion is FAILED. The behavior-unverified items are routed to human verification, not counted as verified. The two key-link WARNINGs are not gaps. Deferred items: none. Regressions since 8a604455: none found.

---

_Verified: 2026-11-03T16:04:32Z_
_Verifier: Claude (gsd-verifier), integration-tree re-verification on HEAD 4b84e50c_
