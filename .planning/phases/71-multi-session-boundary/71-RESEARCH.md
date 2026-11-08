# Phase 71: Multi-Session boundary — Research

**Researched:** 2026-10-31
**Domain:** Existing surface authentication, live-session authorization, durable identifier lifecycle, REST/MCP/CLI integration
**Confidence:** HIGH for inspected repository behavior; MEDIUM for externally documented mechanisms; proposed contracts require the identity-scope decision below.

**Identity decision resolved:** The owner subsequently selected alternative 3: a separate per-session binding credential in addition to existing surface authentication. `71-CONTEXT.md` D71-08 through D71-10 supersede the pending-choice language and the surface-only recommendation below. Implement full shared-token session isolation, not just a surface boundary.

<user_constraints>
## User Constraints (from CONTEXT.md)

The following decisions, discretion, specifics, and deferred work are copied verbatim. [VERIFIED: .planning/phases/71-multi-session-boundary/71-CONTEXT.md:14-27,55-64]

### Locked Decisions

<!-- DATA_c8a41f09_START -->
- **D71-01:** The owner accepted all eight hardening features and retaining unkeyed steering commands. Do not ask again about those decisions.
- **D71-02:** The owner explicitly approved running the installed GSD workflows through available agents/tools in place of the unavailable Skill dispatcher. Preserve CONTEXT, PLAN, SUMMARY, verification, and phase ordering.
- **D71-03:** Keep surface bearer authentication and operator authorization; reuse existing identity and durable index patterns. Alternative: introduce a separate authentication service. Rejected as unnecessary scope.
- **D71-04:** Foreign and unknown target sessions must return the same 404 status/body/headers without exposing ownership or existence. Record internal refusal audit with a hashed identifier, not raw requested session IDs. Alternative: current 403 with ownership reason. Rejected because it does not meet the accepted requirement.
- **D71-05:** Choose a cryptographically generated identifier lifecycle with durable ownership/revocation/non-reuse. Assess existing client-generated IDs and registration before changing contracts. Do not equate UUID-shaped client input with proven server issuance. A volatile cache is not binding authority.
- **D71-06:** The redacted repository-wide digest is intentionally cross-session, not a private steering command list. Keep it unchanged and document that scope distinction.
- **D71-07:** No deployment, production migration, timer installation, funding, or devnet transaction. New PRs remain draft; no merge or auto-merge.
<!-- DATA_c8a41f09_END -->

### Engineer's Discretion

<!-- DATA_6db302ae_START -->
Reuse existing typed errors, PostgreSQL migration/store conventions, event vocabulary, bounded work, and CLI argument patterns. An existing opt-in durable session table is a best-effort restart cache, not an authorization authority; do not silently relabel it durable security state. Preserve current operator-only queue/ack rules.
<!-- DATA_6db302ae_END -->

### Specific Ideas

<!-- DATA_91af65d0_START -->
Complete the security lifecycle before claiming delivery. Do not substitute a standalone registry helper with no routed consumers. Every affected REST/MCP/CLI consumer, test, and runbook must be migrated together.
<!-- DATA_91af65d0_END -->

### Deferred Ideas (OUT OF SCOPE)

<!-- DATA_254ec8b7_START -->
The other seven hardening features remain separate phases. Phase 74 was incorrectly counted as a no-op; absence of an existing multi-repo transaction is not delivery of the requested feature. It must be implemented against a real selected multi-repo operation or explicitly parked after a scope decision.
<!-- DATA_254ec8b7_END -->
</user_constraints>

## Summary

The preliminary implementation is an ownership filter, not the accepted lifecycle: the registry exposes synchronous `get`, `put`, and `end`; it can hold the same ID under different surfaces; capped memory eviction forgets ownership; durable persistence is queued and explicitly best-effort. Registration currently creates or updates whatever `session_id` the client supplies. Read/write refusals expose `forbidden` and `not-session-owner`, and the refusal event includes the requested ID in its summary and `session_id`. These observations come from the implementations, not a rerun of the reported tests. [VERIFIED: packages/mcp-server/src/planning/session-state.ts:116-172,185-240,315-328; packages/mcp-server/src/mcp.ts:1645-1689; packages/mcp-server/src/planning/steering-tools.ts:116-124,171-215]

**Primary recommendation — proposed design:** add one mandatory PostgreSQL-backed live-session authority alongside, not in place of the meaning of, the existing optional restart cache. Mint an ID from 32 CSPRNG bytes, insert its immutable owner binding before returning it, retain terminal tombstones forever, and route all private steering access through one asynchronous boundary. Preserve the existing inbox, operator policy, state machine, audit classes, and redacted repository digest. Explicitly distinguish historical event labels from live steering handles in mixed-purpose APIs. This closes the reachable lifecycle and cross-principal requirements without building another authentication service. The remaining identity-scope decision is real: current surface authentication cannot distinguish two processes sharing the same surface token. [VERIFIED: packages/mcp-server/src/config.ts:395-396,2013-2018; packages/mcp-server/src/mcp.ts:593-611; packages/mcp-server/src/planning/steering.ts:4-21; packages/mcp-server/src/event.ts:337-365] [CITED: https://nodejs.org/api/crypto.html#cryptorandombytessize-callback]

## Architectural Responsibility Map

The following is the proposed responsibility allocation, not a claim that the new interfaces already exist.

| Capability | Primary tier | Secondary tier | Implementation responsibility |
|---|---|---|---|
| Establish authenticated caller/operator | Existing REST/MCP transport | Existing configuration | Reuse bearer resolution; never use body attribution as the authorization identity. |
| Issue handle, bind owner, revoke, lease | API/backend | PostgreSQL index | Await authoritative insert/update; never infer issuance from grammar. |
| Never reuse issued IDs | PostgreSQL index | CSPRNG issuer | Globally unique key and retained tombstone, no owner-changing upsert. |
| Private read/write gate | Shared service boundary | Transport response adapters | Principal limiter, authoritative binding read, operation policy, uniform refusal. |
| State transitions | Existing state machine | Durable authority snapshot | Reuse `nextSteeringSession`, with transactional read/compare/write. |
| Directive author/ack policy | Existing inbox/tools | Existing steering audit sink | Keep operator-only authorship, allowlist, confirmation, audit-before-effect. |
| Long-poll response | REST service | Existing waiter registry | Recheck authorization after waiting and before releasing private data. |
| Local checkpoints | Existing CLI/worktree/ledger | Existing rollback service | Retain historical session labels; explicitly pass a separate live handle for hint reads. |
| Repository context digest | Existing service/context assembler | Existing data sources | Keep bounded redacted cross-session projection and exclusions. |

## Project Constraints (from CLAUDE.md and project rules)

Discovery found no `CLAUDE.md`, `.claude/skills/`, or `.agents/skills/` in this worktree; there is consequently no CLAUDE-derived directive to copy. The inspected project rules require draft PRs only, no secrets, no internal network identifiers, and the Desk Quality/Programming Lead Greptile gate; an unavailable or skipped gate is not a pass. This research assignment additionally forbids product edits, installs, checks, and git writes; only this artifact is written. [VERIFIED: AGENTS.md:7-24; .cursor/rules/desk.mdc:6-14] [ASSUMED: absence is limited to this session's explicit filesystem discovery, not a claim about other checkouts]

New environment readers require registry/documentation parity: the registry says `Adding a flag: add ONE object literal to FLAGS` and describes the generated configuration reference and documented-variable lock. New public operations need both admission classification and audit classification. Applied migration SQL is immutable, and every new table needs archive coverage or a reasoned exclusion. [VERIFIED: packages/mcp-server/src/flag-registry.ts:13-35; packages/audit/src/policy.ts:10-16,49-65,133-142; packages/mcp-server/src/index-store.migrate-contract.test.ts:6-17,133-150]

Before changing exported symbols, the executor must collect LSP references as directed by the parent; the caller inventory below is research evidence, not a substitute for that implementation prerequisite.

<phase_requirements>
## Phase Requirements

These S1 labels are local planning identifiers derived from the corrected accepted criteria, not invented upstream requirement IDs. The corrected roadmap requires `at least 128 bits of cryptographic randomness`, `same 404 status, body, and headers`, and `legacy unkeyed command shape remain unchanged`. [VERIFIED: .planning/ROADMAP.md:1240-1246]

| Local ID | Accepted behavior | Design support |
|---|---|---|
| S1-IDENTITY | Unguessable server issuance, no client-picked-ID adoption | CSPRNG bytes; insert-only authority; explicit create path |
| S1-BINDING | Recheck caller binding on each private session read/write | Shared async boundary; full entrypoint map; explicit operator permissions |
| S1-NOTFOUND | Foreign/unknown indistinguishable; no side effects | One existing typed not-found body; uniform transport mapping |
| S1-DURABLE | Ownership, terminal revocation, non-reuse survive restart | Mandatory authority table; terminal tombstones; no cache fallback |
| S1-LIVENESS | Revoked/expired targets cannot be revived or continue delivery | Server-clock lease predicate; guarded heartbeat; wake/release recheck |
| S1-LIMITER | Principal-keyed limiting before lookup | Mandatory bounded local principal bucket independent of cache availability |
| S1-AUDIT | Hashed refusal identifier, no private body | Shared refusal builder; no raw identifier in any refusal field |
| S1-COMPAT | Operator-only queue/ack, unkeyed commands, digest preserved | Existing inbox retained; explicit historical/live split; CLI migration |
</phase_requirements>

## Standard Stack

No external installation or dependency upgrade is needed or recommended. Versions below are repository declarations, not assertions of latest registry releases. Accordingly no package-legitimacy install audit is applicable. [VERIFIED: package.json:6,22-24,56-63; packages/mcp-server/package.json:7-15]

| Existing component | Version/declaration quoted verbatim | Use |
|---|---|---|
| Bun runtime and test runner | `"packageManager": "bun@1.4.0"`, `"bun": ">=1.4.0"` | Existing runtime, `bun:test`, native SQL |
| TypeScript | `"typescript": "5.9.3"` | Existing typed ports/results |
| Zod | `"zod": "^4.6.7"` | Existing strict MCP/REST input schemas |
| MCP SDK | `"@modelcontextprotocol/sdk": "^1.32.1"` | Existing server registration and tool results |
| PostgreSQL via Bun SQL | Existing `bunSteeringSessionsStore(sql: SQL)` | Add authoritative adapter using current pool, not another connection configuration |
| Crypto | Existing `node:crypto`; official `randomBytes(size[, callback])` | Generate 32 random bytes; use existing `sha256Hex` for refusal correlation |

The existing hash helper is exactly `return new Bun.CryptoHasher("sha256").update(input).digest("hex");`. The current directive issuer uses `randomUUID`; it is not a mandate for live-session IDs. Use 32 raw random bytes for the corrected minimum-randomness requirement, rather than treating UUID width as random-bit count. [VERIFIED: packages/mcp-server/src/event.ts:8,25-27; packages/mcp-server/src/planning/steering-tools.ts:20,224-235] [CITED: https://nodejs.org/api/crypto.html#cryptorandombytessize-callback] [CITED: https://nodejs.org/api/crypto.html#cryptorandomuuidoptions]

## Concrete Public Contract Decision: What Is the Isolated Principal?

**Evidence:** configuration is `tokens: Map<string, Surface>`; `surfaceForToken` returns only the mapped surface; `McpCaller` contains `surface`, `isOperator`, and optional `tokenedSurfaces`, not a credential/session discriminator. Listing exposes every entry whose surface matches, including `session_id`. The repository digest also returns steering session IDs across surfaces. Therefore a server-issued public ID plus surface binding is sufficient for a **surface-principal boundary**, but not isolation between hostile sessions sharing that principal. Even distinct token strings mapped to the same surface are collapsed by the current resolver. This is a deduction from the inspected definitions and disclosure paths, not an assumed threat model. [VERIFIED: packages/mcp-server/src/config.ts:395-396,2013-2018; packages/mcp-server/src/mcp.ts:602-611; packages/mcp-server/src/planning/steering-rest.ts:75-105; packages/mcp-server/src/service.ts:3447-3451; packages/mcp-server/src/session-context.ts:289-299]

Exactly three alternatives belong at the planner's contract checkpoint:

1. **Surface-principal isolation — smallest under the locked existing-auth instruction.** Keep current discovery and digest, bind every issued handle to its authenticated surface, and explicitly document that sessions sharing that surface token share its rights. Do not call this same-surface per-session isolation. This does not require a new credential. It implements the concrete lifecycle design below, but cannot certify an interpretation of S1 that requires mutually untrusted sessions of one surface.
2. **Public ID becomes the only per-session capability.** This requires removing live IDs from same-surface discovery, repository digest, event trails, and other accessible metadata. The evidence above shows why entropy alone is insufficient today. This conflicts with the locked unchanged digest/discovery behavior; do not choose it under the present constraints.
3. **Keep surface auth and add a separate per-session binding proof.** Return a second CSPRNG secret only at issuance; persist its digest, not plaintext; require proof plus the surface bearer on private session operations; never return proof through list/digest/audit. This is not a separate auth service, but it is an additional public credential protocol and client migration, so it cannot be silently inferred as already approved. Discovery must expose metadata only, never private directions/directive counts to same-surface siblings lacking proof; private lists must require proof, not merely `surface` equality. Operator access remains explicit.

**Planning disposition:** implement the common durable lifecycle and transport/caller work regardless. Under the current locked auth contract, recommendation 1 is the smallest authorized interpretation. If the parent establishes that original acceptance requires isolation among shared-token sessions, select 3 explicitly and include its proof plumbing in the same phase; do not mark that criterion met by recommendation 1. No amount of UUID validation or cache persistence resolves this distinction. [VERIFIED: .planning/phases/71-multi-session-boundary/71-CONTEXT.md:19-27; packages/mcp-server/src/config.ts:2013-2018]

### Exact proposed lifecycle and optional proof plumbing

Use these concrete proposed transport names so implementation does not leave an unrouted helper: MCP creation remains `docs_steering_session` with omitted `session_id`; add `steering_session_heartbeat` and `steering_session_close`. REST uses `POST /steering/sessions` for creation, `POST /steering/sessions/heartbeat`, and `POST /steering/sessions/close`. CLI uses `steer open --repo R`, `steer heartbeat --session ID`, and `steer close --session ID`; creation defaults to the existing `ACTIVE` state. Every new name here is proposed. Register each route in JSON-body/admission tables and each MCP tool in admission/audit policy; do not borrow a read audit name for lifecycle writes. Update strict CLI parsing/help and its injected client interface together.

If alternative 3 is chosen, the following is the complete additional public wire contract, not another open-ended design exercise:

- Creation returns `session_id`, expiry, and one-time `session_binding`, all over the existing authenticated transport. Generate the proof independently from another 32 CSPRNG bytes. Store only a domain-separated digest keyed by the issued session ID; do not derive proof from a public identifier or the shared surface token.
- REST private calls carry proof in a proposed `X-Substrate-Session-Binding` header, never query parameters. MCP private tools take a strict optional `session_binding` argument and validate it inside the shared boundary; omission, wrong proof, unknown ID, expiry, and foreign ownership all yield the exact same not-found response. Operator-permitted cross-session reads/queue/ack/close use explicit operator authority, not a forged owner proof. Existing operator queue/ack bodies remain unchanged.
- Mixed docs/brief APIs carry `steering_session_id` plus proof separately from historical attribution. The trusted caller and proof reach service methods, not just transport wrappers. Never put proof into prompt augmentation, cache keys, traces, event payloads, error messages, or tool descriptions/examples containing real values. Existing generic argument-digest auditing may hash the arguments; it must not record plaintext values.
- Non-operator session discovery is metadata-only; private direction text and directive counts are excluded without the session's proof. A proof-authorized targeted read returns private data. This is an intentional change from the current same-surface full listing, not a claim that unchanged listings are safe.
- `steer open` persists proof through a new bounded client binding-record helper using the existing private-file pattern (0700 directory, 0600 temp file, fsync, atomic rename); default stdout/JSON exposes the public handle and record location, not proof. A proposed `--binding-file` selects that record for private CLI reads/heartbeat/close and `session hook --steering-session`; file schema validates server identity, surface, and handle before use. Do not serialize the bearer token into that record, and do not silently select a sibling session's record.
- Missing/corrupt/lost record never becomes surface-only authorization or a proof reset. The host opens a fresh handle; the abandoned one expires or an operator closes it. Concurrent record creation must use the existing exclusive/atomic file conventions rather than last-writer replacement across handles.
- This provides protocol separation to callers that know the same surface token but not each other's binding proofs. It does not provide isolation from an attacker who can already read another process's 0600 files under the same OS account; the OS/process trust boundary remains separate and must not be overclaimed.

The private-file mechanism is source-grounded: the existing writer uses `mkdirSync(dir, { recursive: true, mode: 0o700 })`, `openSync(temporary, "w", 0o600)`, `fsyncSync(fd)`, and `renameSync(temporary, path)`. The new binding-record format/location are proposed, not existing pending-journal entries; do not add secrets to the existing checkpoint replay journal. [VERIFIED: packages/cli/src/session/pending.ts:257-277]

## Existing Interfaces and Complete Private-Access Caller Map

All paths in the tables below are relative to this worktree. Locations are read this session. Quoted tool names, routes, statuses, and methods are existing values, not proposed additions.

| Existing interface/caller | Inspected anchor and current behavior | Required migration (proposed) |
|---|---|---|
| `SteeringSessionRegistry.get`, `put`, `end`, `lookup`, `lookupFor`, `entries`, `loadDurable`, `applyTransition` | `session-state.ts:148-172,175-205,315-362`: synchronous mutable cache; `lookup` returns `"none"`, `"ambiguous"`, or `"one"` | Remove their use as public authorization. Keep raw cache methods private/internal; all externally reachable reads and transitions await authority. No compatibility setter that grants ownership. |
| `SteeringSessionsStore.save/loadNewest/prune/delete`, `bunSteeringSessionsStore` | `steering-sessions-store.ts:30-40,89-121`: `on conflict (surface, session_id) do update`; delete/prune cache rows | Keep restart-cache semantics. Add a distinct authoritative port/adapter, never derive bindings from cache rows. |
| `Substrate` constructor | `service.ts:1782-1795`: `sessions: { owns: ...get(...) !== undefined }`; optional `sessionsStore` | Replace synchronous ownership injection with the authority-backed boundary; inject deterministic authority/clock/randomness in tests. |
| MCP `"docs_steering_session"` | `mcp.ts:1622-1691`: required client `session_id`, get/put create-or-update, state text carried forward | Omitted live ID explicitly issues; supplied ID only updates a previously issued bound live session; move transaction logic into shared service. Unknown supplied UUID is 404, never creation. |
| MCP `"docs_search"` | `mcp.ts:1552-1596`: raw `session_id` both labels event and selects live state; synthetic ``docs-search:${scoped}`` | Separate historical label from explicit live handle; move augmentation behind shared service gate, not tool-only `get`. |
| REST `"/docs/search"` | `server.ts:1512-1563`: forwards arbitrary `session_id` directly to `Substrate.searchDocs` | Same service gate as MCP; no REST-only bypass. |
| `Substrate.searchDocs`, `searchDocsUnmeasured`, `docsContextOf`, `ledgerForContext`, `steeringNoticeOf` | `service.ts:5666-5698,5769-5777,5931-5939,5968-5979,3632-3644`: notices and context ledger lookup use raw ID without binding | Accept trusted caller explicitly and distinguish historical/live fields; no private inbox or session-history read from an unchecked string; recheck after asynchronous retrieval before attaching data. |
| `queueSteering`, `acknowledgeSteering`, `listSteering`, `admitSteeringRead`, `admitSteeringWrite` | `steering-tools.ts:198-215,224-283`: synchronous `owns`; operator bypass reaches unknown IDs | Call one async admission boundary. Operators bypass owner equality only for expressly permitted operations, never existence/liveness or principal limiter. |
| MCP `"steering_queue"`, `"steering_acknowledge"`, `"steering_list"` | `mcp.ts:2452-2512`: queue wakes; ack delegates; list then uses raw registry lookup | Reuse shared results, including not-found/unavailable; build state projection from authorized result, not a second unguarded lookup. |
| REST `"/steering/sessions"` / `listSteeringSessions` | `server.ts:2111-2120`; `steering-rest.ts:75-105`: surface-filtered cache listing, private `steering` text and pending counts | Query authoritative active rows filtered in SQL, bounded/paginated. For identity alternative 3, non-operator discovery is metadata-only unless each record is independently proof-authorized. |
| REST `"/steering/directives"` | `server.ts:2123-2148`: separate gate, then awaited `durableAcknowledgedFor` | Gate before both inbox/history and recheck before release after awaited history read. |
| REST `"/steering/queue"` | `server.ts:2152-2163` | Preserve no-idempotency-key shape; authority gate then existing inbox audit/queue. |
| REST `"/steering/acknowledge"`, `parseAcknowledgeBody` | `server.ts:2167-2175`; `steering-rest.ts:250-265`: infers target with `inbox.get`, sentinel `"unknown"` | Pure parse validates only submitted fields; after principal limiting resolve directive target, then authorize it. Normalize absent directive/foreign target to same 404, no pre-gate side effect. Do not require new session/key fields in the existing operator ack body. |
| REST `"/steering/wait"`, `SteeringWaiters.wait/notify/closeAll` | `server.ts:2179-2218`; `steering-waiters.ts:75-81,104-157`: once-only gate and synchronous private `check` | Waiter is only a wake hint; do final async authority check on directive, timeout, close, and lease-expiry wake before answering. Add per-session wake/cancel, no socket-held SQL transaction. |
| `acknowledgeSteeringWithState`, `SessionStatePort.applyTransition` | `steering-delivery.ts:106-122,144-166`: ack is audited first and stands even when transition is refused | Extend transition context with trusted caller/boundary context; authority-guard state mutation itself. Preserve acknowledged-but-session-transition-refused behavior, no invented distributed transaction. |
| `Substrate.emit` → `endSteeringSession` | `service.ts:2492-2521,2536-2563`: stored `"session.end"` triggers cache delete using event attribution | Historical events must not implicitly create/rebind sessions. Add explicit live-handle close API; handle an existing issued live ID on `session.end` only through the authority gate using `options.caller`, not `event.surface`. Replayed end cannot renew/reopen. |
| `Substrate.liveBriefSections`, `briefDetailed`, `briefConditional` | `service.ts:3533-3594`; `server.ts:1165-1208`: brief surface can be attributed separately; preliminary private section gate then global lookup | Pass authenticated caller separately from request attribution. Explicit live handle requests get typed boundary refusal, not silent omission/200/304. Gate before fast-path/cached brief handling and recheck before releasing per-request private sections. |
| `Substrate.sessionContext`, MCP `"session_context"`, REST `"/session/context"` | `service.ts:3421-3451`; `server.ts:2223-2245`; `session-context.ts:1-20,396-405` | Preserve cross-session digest. Its `session_id` is an exclusion/filter label, not an ownership assertion or private command-list authorization. Only switch the steering metadata source to authoritative active-row projection. |
| `runSteer`, `commandStatus`, `commandWrite`, `commandListen`, `createSteerClient` | `steer/index.ts:243-275,284-298,334-335,398-420`; `steer/client.ts:375-451,454-470` | Existing `--session` denotes live issued handle on private commands; preserve queue/ack shape; recognize typed session 404 on reads/waits as real resource denial, not old server. Add lifecycle client methods/subcommands. |
| `runSession` → `commandHook` → `runHook/execute`, `unconsumedHints` | `session/command.ts:254-277,765-785`; `session/hook.ts:164-184,205-213,263-301` | Keep checkpoint `--session`/envelope history label. Add explicit `--steering-session`/envelope live field for private hint queries and compare hints against that live ID. Do not rewrite checkpoint history into server IDs. |
| `renderHookConfig` / `steering()` | `session/hook-config.ts:51-67,86-103`: generated steering command only supplies historical `--session` | Print both explicitly named IDs for the steering trigger, describe issuance/heartbeat/close integration; still print-only, install nothing. Context trigger keeps historical exclusion label and does not require private binding. |

The source enum and error facts behind these rows are: `SteeringForbiddenReason = "operator-required" | "caller-identity-missing" | "not-session-owner"`; the existing generic error includes `"not-found"`; `SteeringListResult` currently lacks a `refused` branch; HTTP maps `"forbidden"` to 403 and `"refused"` with `error.code === "not-found"` to 404. Extend the shared list result rather than adding a bespoke route-only response. [VERIFIED: packages/mcp-server/src/planning/steering-tools.ts:116-133,156-165; packages/mcp-server/src/planning/steering.ts:208-223; packages/mcp-server/src/planning/steering-rest.ts:299-328]

## Architecture Patterns

### Proposed data flow

```text
Surface bearer -> existing caller resolution
                         |
                  mandatory principal bucket
                         |
             explicit create OR target operation
                  /                     \
        CSPRNG server issuer       authoritative binding read
                  |               + terminal/lease predicate
        INSERT unique ID                   |
                  |              owner OR permitted operator?
          durable commit             /               \
                  |              no/absent         admitted
        return issued handle      hashed audit        |
                                  same 404       existing inbox/state/read
                                                       |
                                             async work completed?
                                                       |
                                              recheck before release
```

Caches, presence, the ledger, and clients never sit above the authorization decision. The existing presence module explicitly defines liveness from `lastHeartbeatMs`/`livenessMs`, and its observer can keep a checkout live without user actions; that is useful presentation evidence, not proof that a caller still holds a live authorization binding. [VERIFIED: packages/mcp-server/src/planning/presence.ts:4-13,70-90,129-151; packages/mcp-server/src/planning/observer.ts:617-620]

### Proposed smallest authority and interface changes

Add a distinct `LiveSessionAuthority` port and Bun SQL adapter in the existing `planning/steering-sessions-store.ts`, with orchestration in `planning/session-state.ts` and service wiring in `service.ts`. Names in this paragraph and schema below are **proposed**, not existing exports.

- `issue(caller, repoId, initialState)` generates internally, persists, returns the committed handle/snapshot/lease expiry. No caller ID parameter. Randomness and clock are injected only as test seams.
- `read(caller, sessionId, operation)` returns an authorized active snapshot or a common boundary failure. Every call consults PostgreSQL; a cached positive authorization is not accepted.
- `transition(caller, sessionId, input)` reads/locks the authoritative row, checks binding, lease, repo, previous state, calls existing `nextSteeringSession`, and commits the new redacted snapshot. Preserve omitted steering/planning hash and current transition rules.
- `heartbeat(caller, sessionId)` extends a still-active binding using database time, never the caller's timestamp; a terminal/expired ID cannot revive.
- `close(caller, sessionId)` commits a terminal tombstone before success, then invalidates local state and wakes waiting readers. Unknown/foreign/terminal resource handling follows the common response policy below.
- `listVisible(caller, query)` queries only authorized, active, unexpired records, applying owner/repo filtering before limit/truncation. A raw cap-limited memory list is not authoritative discovery.

Return the authorized snapshot to the caller instead of returning a boolean and then looking up again. Replace `SteeringSessionOwnership.owns` with an async admission port; migrate every caller in the table, removing the obsolete sync authorization adapter. Internal state transitions receive the trusted caller/context, not a fabricated owner from event attribution. [VERIFIED: packages/mcp-server/src/planning/steering-tools.ts:38-68; packages/mcp-server/src/planning/session-state.ts:338-362; packages/mcp-server/src/planning/steering-delivery.ts:108-122]

### Proposed migration 42 and authority schema

The last inspected migration is exactly `version: 41`, `name: "worktrees_repo_lower_seen_idx"`. The new migration must be **42**, additive/idempotent, `phase: "expand"`, with documentary `down`; never modify migration 37 or its digest. Existing 37 creates `steering_sessions` with `primary key (surface, session_id)` and is gated by `optIn: "steering-sessions"`. Neither that key nor that opt-in can provide the new global authority. [VERIFIED: packages/mcp-server/src/index-store.ts:763-786,869-881; packages/mcp-server/src/index-store.migrate-contract.test.ts:6-17]

**Proposed new table:** `live_session_bindings` (always migrated when the index migrates, not gated by the optional cache flag):

| Proposed column | Constraint/purpose |
|---|---|
| `session_id text primary key` | Global namespace, not composite with owner; exact opaque match, no lowercasing |
| `owner_surface text not null` | Derived from authenticated caller, immutable |
| `repo_id text not null` | Validated normalized repository; immutable for lifetime |
| `issued_at timestamptz not null` | Database clock |
| `last_seen_at`, `expires_at timestamptz not null` | Binding lease, independently checked on every operation |
| `closed_at timestamptz`, `close_reason text` | Terminal marker; once set cannot be cleared |
| `state text`, `steering text`, `planning_hash text`, `updated_at timestamptz` | Redacted authoritative current snapshot; reuse current state validation |
| optional `binding_proof_hash text` | Only if identity-contract alternative 3 is explicitly selected; never plaintext proof |

Keeping the small state snapshot with the new authority makes restart independent of the optional cache, avoids advertising an active binding with missing/stale state, and permits one transaction for state/revocation races. This does **not** turn the old table into security authority. The old optional table remains a best-effort mirror only; loaded rows may refresh a local view only after the new authority independently approves the ID, owner, lease, and canonical snapshot. Prefer simply using the authority snapshot in live paths; old cache persistence/pruning can continue without affecting grants. Do not retain two competing writable state machines. [VERIFIED: packages/mcp-server/src/planning/steering-sessions-store.ts:4-11,30-40; packages/mcp-server/src/planning/session-state.ts:181-204] (Design recommendation.)

Use parameterized templates and the existing SQL pool/transaction conventions. Source precedent is `await this.sql.begin(async (tx) => { ... })` plus `select ... for update`; PostgreSQL documents conflicting row locks and transaction release. [VERIFIED: packages/mcp-server/src/index-store.ts:1143-1157] [CITED: https://bun.sh/docs/runtime/sql] [CITED: https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-ROWS]

### Issuance, non-reuse, tombstones

**Proposed issuer:** a fixed live namespace prefix followed by `randomBytes(32).toString("hex")`. The 32 random bytes contribute 256 random bits; formatting is not proof of issuance. The existing parser grammar is exactly `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`, so such a handle fits without weakening the shared historical-ID grammar. [VERIFIED: packages/mcp-server/src/planning/presence.ts:17-18] [CITED: https://nodejs.org/api/crypto.html#cryptorandombytessize-callback] (256 bits is arithmetic; prefix/length are proposed.)

- Generate on the server, attempt insert with conflict-do-nothing/returning. On collision, generate a different candidate with a small fixed attempt bound; exhaustion is unavailable, never reuse/upsert. Only return after commit. Failed commit or lost response never authorizes a client-selected retry ID; an abandoned committed issuance expires normally.
- Keep the ID, owner, issue time, and terminal marker permanently. Terminal rows may clear free-text snapshot fields; never prune the key or move it to another owner.
- Expiry is terminal logically even before a maintenance write stamps `closed_at`: every read/update includes unclosed and unexpired predicates. Heartbeat uses that predicate and may not extend an already expired row. The primary-key row remains regardless.
- Cap/TTL eviction affects only cache storage. It cannot remove a binding/tombstone or make an ID available again. Owner never changes, including for operators; an operator opens a new identity rather than transferring an old one.
- Historical labels that predate server issuance remain historical labels, not grandfathered issued identities. Legacy cache rows and directive history do not prove issuance. Do not import them as active bindings, even when their strings match the new grammar.

### Liveness and revocation policy

**Proposed policy, not an existing setting:** add a dedicated binding lease setting rather than silently reinterpreting the old cache TTL. Suggested initial default is one hour with heartbeat guidance at five minutes; expose server expiry in issuance/heartbeat replies. Document these as new public policy, not measured operational targets. Add its typed config, bounded parser, flag registry row, `.env.example`, reference text, and tests in one change. The existing cache parser is exactly `boundedInt(env.SUBSTRATE_STEERING_SESSION_TTL_S, 604_800, 60, 31_536_000)`; that remains the cache-load TTL, not caller liveness. [VERIFIED: packages/mcp-server/src/config.ts:1274-1278]

Only owner-authenticated heartbeat or owner state activity renews the lease. Operator observation, queueing a command, discovery, ordinary reads, background presence scans, and cache reload must not renew another caller's authorization. A host that wants a long-lived quiet session must send heartbeats; the CLI lifecycle/host guidance must make this requirement explicit. A network partition may expire the session; the client must open a new handle, not reclaim the old string. No timer installation or deployment is part of this phase.

For alternative 3, heartbeat and owner close additionally require the proof. Do not allow recovery-by-surface to reveal/reset a lost proof for the old session: issue a new session, let the old one expire, or let an operator close it. Otherwise proof-based isolation degenerates to surface-only ownership.

### Concurrent operations and linearization

- Register is insert-only; two callers can never both claim one candidate, and a client never supplies the candidate. Replayed old registration becomes an update to a terminal/unknown ID and returns 404, not recreation.
- Heartbeat, state change, and close lock/conditionally update the same row. Close winning means no later update or cache save reopens it; heartbeat winning merely extends a live row before close terminates it. State validation reads the durable current state inside that transaction, not a stale cache snapshot.
- Private reads linearize at an authoritative admission read. Recheck at release after any long await. A response authorized immediately before a concurrent close may finish after close; no request admitted after successful close may pass. This is the explicit in-flight boundary, not an impossible promise to retract bytes already sent.
- Queue/ack retain existing audit-before-effect semantics. Check current binding before touching the inbox; ensure all inbox effect paths use this admission, including the state-transition port. A close after a valid queue admission may leave a durable command for a now-closed ID; it must never be delivered or reattached to a new ID. Existing timeout/history semantics may retain it; do not invent cross-store atomic rollback.
- A state transition attempted after acknowledgement can lose to close; report existing `session_state: refused`, keep the audited acknowledgement, and emit no checkpoint hint. That is the existing documented two-stage contract, not a reason to resurrect the session. [VERIFIED: packages/mcp-server/src/planning/steering-delivery.ts:139-166]
- Do not hold a SQL transaction or authorization capability for the duration of a long poll. Waiters wake on queue, close, or their lease deadline; then the service reauthorizes before reading/releasing a directive or sending the terminal result. Timeouts also recheck: an expired session is 404, not a fresh successful 204. Local wake/cancel is prompt cleanup; durable lookup at release is the security control across processes.

## Proposed Public Contract Table

Everything labeled proposed here is a deliberate contract addition/change, not an assertion of a current route or enum.

| Operation | Proposed contract | Compatibility consequence |
|---|---|---|
| Issue via existing `docs_steering_session` | Make `session_id` optional; absent means server creates and returns issued ID/snapshot/expiry. Supplied means update only. | Existing client-selected create is intentionally removed; matching UUID or prefix is still unknown. |
| REST issue | Add POST to existing `/steering/sessions` path with validated repository and initial state, no client ID/owner. | Existing GET stays GET. Add body-route classification without renaming old endpoints. |
| Heartbeat/close | Add explicit shared lifecycle operations, exposed through MCP and REST and CLI `steer` subcommands. Require existing issued ID and authenticated owner or permitted operator for close. | Names/strict schemas must be pinned together in tests and docs; no inferred heartbeat from presence. |
| Foreign, unknown, closed, expired, wrong proof | Reuse `{ "status": "refused", "error": { "code": "not-found" } }`; REST 404, MCP `isError: true`. | No `not-session-owner`, no ownership reason, no raw ID, no existence-specific headers. Applies to reads and writes, including operators naming unknown IDs. |
| Owner non-operator queue/ack | Existing 403 `operator-required`. | Operator-only write policy stays unchanged; foreign and unknown are handled as 404 first. |
| Authority not configured/down/schema missing | New shared typed `session-unavailable` result, REST 503 / MCP error; no driver detail. | Explicit availability change: private live access is not a fail-open courtesy. Do not misuse `audit-unavailable` to describe index failure. |
| Principal limit | 429 before target/directive lookup; bounded retry-after unrelated to target existence. | Existing general admission remains; new security admission cannot be disabled by cache outage. |
| `docs_search` and brief mixed IDs | Keep historical `session_id` for event/worktree/claim attribution; add explicit `steering_session_id` for private live augmentation. Raw historical label alone grants no live state, inbox notice, or private session-event context. | This intentionally removes implicit private lookup by historical label. Update descriptions, integration examples, tests, and callers that expected that lookup. No secret alias fallback. |
| Docs `context: true` | Recalled memories remain; per-live-session event context requires authorized live handle and owner-surface filtering. Without it report no live-session events rather than looking up any arbitrary historical label as private context. | Deliberate narrowing of unchecked session-history augmentation; generic historical event query APIs remain separate. |
| Brief private steering | Explicit live handle is gated before cache/ETag early exits; foreign/unknown 404, not silent omitted section. Briefs with only historical label retain ordinary/repo context behavior. | Full brief/digest continues without a live handle; existing collectors are not forced to register historical labels. |
| Existing unkeyed queue/ack | Keep submitted fields and lack of idempotency-key requirement. Ack may continue naming directive only. | Lifecycle is an authorization prerequisite, not a demand to key old command requests. |
| Repository `session_context` | Preserve shape, bounds, redaction, cross-session rows, and historical `session_id` self-exclusion. | No ownership/proof demand on public-redacted digest; it does not return a private command list. |
| Session hook | `--session` remains historical; new explicit `--steering-session` selects private hints. | Missing live handle must not trigger a historical-label private query. It can still take the ordinary requested checkpoint and explain skipped live-hint consumption. |

The reusable refusal body above uses existing values exactly: `"refused"`, `"error"`, `"code"`, `"not-found"`; `SteeringWriteResult` already has `{ status: "refused"; error: SteeringError }`, and `SteeringError` already permits `{ code: "not-found" }`. Extend list result and the CLI read handling to recognize that same body. Keep audit success/failure out of this public 404; the present optional `audit: "unrecorded"` must not make otherwise identical denials differ. [VERIFIED: packages/mcp-server/src/planning/steering-tools.ts:119-133,156-161,182-190; packages/mcp-server/src/planning/steering.ts:208-223; packages/cli/src/steer/client.ts:328-350,419-436]

## Pre-Binding Principal Limiter and Hashed Refusal Audit

Existing REST admission is before handlers, and MCP admission aggregates tool calls; its cache failure deliberately admits/bypasses, while the inbox limiter is per target. Neither fact alone proves a mandatory pre-binding security limit. The exact existing admission modes are `"off" | "shadow" | "enforce"`, and the module says cache failure is a `bypass`. Keep that general load-management behavior; add the session-boundary protection rather than silently changing the entire admission system. [VERIFIED: packages/mcp-server/src/admission.ts:13-25,35-36,398-423; packages/mcp-server/src/server.ts:901-912; packages/mcp-server/src/planning/steering.ts:11-12]

**Proposed smallest implementation:** one bounded in-process bucket per authenticated surface and read/write class, using existing `bucketStep`, `limitFor`, and `retryAfterSeconds`. Enforce it inside the shared live boundary, before ID lookup, directive-target inference, row count, mutation, or refusal audit. The key is caller identity, never a requested ID, repo, body surface, or client address. Surface cardinality is bounded by the existing configured surface vocabulary, so randomized target strings cannot allocate a map entry each. Keep it always enforced for security-boundary requests even if distributed general admission is off/shadow/cache-down; document this distinct purpose. This is a per-process bound, not a claim of fleet-global exact quota. Existing outer admission can still apply first. [VERIFIED: packages/mcp-server/src/admission.ts:38-52,128-149,322-325; packages/mcp-server/src/types.ts:45-63] (Policy recommendation.)

For already accepted long polls, release-time reauthorization does not spend a second principal request token. The original request was limited before admission; release checks are internal safety checks, not caller-controlled new requests. Cache-down behavior is therefore deterministic: requests remain limited locally; binding decisions still consult PostgreSQL.

**Proposed refusal event builder:** reuse `STEERING_REFUSED_ACTION = "steering.refused"`, `kind: "warning"`, and trusted caller surface. Compute a domain-separated SHA-256 of the bounded requested identifier and record it under a hash-specific payload key. Omit raw `session_id`, raw target, directive body, steering text, proof, token, and ownership/existence details from summary, payload, top-level session field, and error logs. Unknown directive IDs should likewise be hashed; do not log a fake sentinel as if it were the requested target. Internal reason may describe the policy decision but must not cause a distinct public reply. Refusal logging failure never authorizes a request; report internally through bounded existing diagnostics, never decorate the 404 with store-dependent fields. [VERIFIED: packages/mcp-server/src/planning/steering-tools.ts:70-71,171-190; packages/mcp-server/src/event-sources.ts:1545-1562; packages/mcp-server/src/event.ts:25-27] (Payload change is proposed.)

The existing generic audit hashes arguments and records argument keys, not complete argument values; keep that pattern and ensure any added proof argument is not separately copied into log/error metadata. Update event vocabulary sample and docs together; do not add another event kind. [VERIFIED: packages/audit/src/record.ts:154-158,191-192; packages/mcp-server/src/types.ts:69-82; packages/mcp-server/src/event-sources.ts:1549-1562]

## Migration and Recovery Behavior

| Situation | Required proposed behavior |
|---|---|
| Fresh install, index healthy | Apply additive migration 42; empty authority is valid; create returns only committed server-issued IDs. Optional old-cache table need not exist. |
| Legacy installation | Do not backfill active authority from caller-controlled old cache/ledger data. Historical rows remain usable by their historical APIs; live clients explicitly issue new handles and retarget commands. Legacy queued commands cannot silently acquire authority. |
| Restart | Read bindings/state from authority on demand; cache hydration is optimization. Durable tombstones and lease time are unchanged; restart neither renews nor clears them. |
| Cache disabled/down/stale/cap-evicted | Local security limiter and PostgreSQL binding checks still operate. No ownership change, false resurrection, or ID release. |
| Optional restart-cache write/delete/prune fails | Existing warning behavior may continue; it does not reverse authoritative close or enable a grant. Stale cache rows cannot be served as active without authority. |
| Index not configured/unreachable/schema missing | All private live create/read/write/renew/close return typed unavailable, not success/404 based on memory. Public-redacted digest retains source-degraded behavior. No emergency volatile authority. |
| Close commit fails | Return unavailable; do not claim durable revocation. Retrying remains safe. Local denial can be stricter, but recovery must consult the durable row, not pretend the failed close persisted. |
| Close commits, response lost | Retry returns same generic terminal/not-found policy; never recreates the ID. New issuance uses new random bytes. |
| Delayed heartbeat/transition/save arrives after close | Guarded update affects zero live rows and returns not-found. Old cache writes may land but cannot authorize/reopen. |
| Lease expires while idle/waiting | Predicate immediately denies even before tombstone materialization; wait response rechecks. Heartbeat cannot revive; issue new handle. |
| Authority unavailable during an outstanding wait/history/docs read | Recheck returns unavailable and releases no private data; no cached positive authorization fallback. |
| Generic index archive/restore | Explicitly classify authority table in migration contract; do not rely on the current closed archive whitelist to back it up. Provide durable PostgreSQL backup/recovery guidance covering bindings and tombstones. |
| Authority/tombstones lost or a stale database restored | Do not recover by cache/ledger ownership inference or enable service as if non-reuse were proven. Quiesce live-session authority, recover complete security records, and invalidate active bindings after recovery. A rollback that omits later tombstones cannot prove permanent non-reuse; report that limitation and require operator-controlled recovery. No deployment/recovery action is executed in this phase. |

The existing archive explicitly says adding a table changes its `schemaHash` and can invalidate earlier archives; the migration contract allows reasoned table exclusions. Therefore the smallest implementation should exclude the new security table from the legacy logical archive with a clear reason and require PostgreSQL-native security-state backup, rather than casually changing old archive compatibility. Permanent tombstones must not be described as reconstructible cache. [VERIFIED: packages/mcp-server/src/index-archive-spec.ts:4-17; packages/mcp-server/src/index-store.migrate-contract.test.ts:33-40,55-68,133-144]

## Runtime State Inventory

This is a security migration, so every category is explicitly assessed. Live systems were not queried; no production-state absence is claimed.

| Category | Source-grounded finding | Planned action |
|---|---|---|
| Stored data | Old `steering_sessions` key is `(surface, session_id)`; optional restart cache deletes/prunes; inbox audit may retain old target IDs. [VERIFIED: packages/mcp-server/src/index-store.ts:776-785; packages/mcp-server/src/planning/steering-sessions-store.ts:89-121; packages/mcp-server/src/planning/steering-rest.ts:171-190] | Add authority, no trusted active backfill. Retain legacy history; require new live issuance. Keep issued-ID tombstones permanently. |
| Live service config | Current cache-only flags and expiry semantics are documented. Actual deployed values were not inspected. [VERIFIED: packages/mcp-server/src/config.ts:756-764,1274-1278] | Document mandatory index and proposed lease setting; operator rolls out config later, no production mutation now. |
| OS-registered state | Hook templates are print-only, and installing is an operator step. Actual installed hooks/timers were not inspected. [VERIFIED: packages/cli/src/session/hook-config.ts:1-11] | Update generated steering template and runbook for distinct historical/live IDs; do not install/repoint timers/services. |
| Secrets/env vars | Current bearer resolver reduces tokens to surface; no token values were read. [VERIFIED: packages/mcp-server/src/config.ts:395-396,2013-2018] | Keep surface tokens. Only explicit selection of identity alternative 3 introduces a session proof; never expose it in digest/audit and never store plaintext server-side. |
| Build artifacts/installed packages | No package installation or artifact rename is proposed; runtime checks observed Bun 1.4.0/Node v24.18.0 only. | Parent builds/tests after integration if authorized; no reinstall or artifact mutation by researcher. |

## Historical Events and Checkpoints: Scope Decision

**Do not reclassify every `session_id` in the ledger as a live steering credential.** Existing generic event queries forward directly to `queryEvents`; the ledger is shared evidence, and the digest deliberately includes cross-session IDs and redacted event summaries. Checkpoints/rollback already bind the checkpoint author to the caller's surface: `ownedBy` is `caller.isOperator || event.surface === caller.surface`, and `resolveTarget` filters visibility before returning `"not-found"`. Checkpoint recording accepts historical labels and explicitly supports offline/late delivery. [VERIFIED: packages/mcp-server/src/server.ts:1293-1305; packages/mcp-server/src/session-context.ts:4-20,289-299; packages/mcp-server/src/session-rollback.ts:336-337,396-405,413-439]

**Proposed boundary:** historical events, checkpoints, rollback, graph claim-session labels, worktree attribution, and planning presence are not live steering identity issuance. Preserve their current surface/holder authorization; changing all of them would be a separate historical-ledger confidentiality/auth migration, with major offline replay consequences. This is not an exemption for a side effect: `session.end` is in this phase precisely because it currently closes live state. Remove historical-label close inference; an explicit issued handle must pass the same close gate. The ordinary event may still be recorded even if it cannot close live state, and must not return a success claim for an uncommitted revocation. [VERIFIED: packages/mcp-server/src/service.ts:2517-2521,2536-2559; packages/mcp-server/src/session-rollback.ts:413-439]

The mixed-use docs/brief fields must be split explicitly as described above: a raw historical event label never selects private live directives or state. If same-surface **historical event confidentiality** is required, identity alternative 3 alone is not enough because the generic event query remains shared; that is an additional accepted-contract scope question, not a property delivered by this steering design.

Known non-live clients: the live/canary golden search bodies currently send exactly ``session_id: `docs-golden:${fixture.id}``` and ``session_id: `docs-canary:${fixture.id}```. Keep those as historical attribution with no implicit live access; they do not need to create steering sessions just to evaluate search relevance. The CLI hook currently reads acknowledged directives with the historical session ID and must migrate its private hint call. [VERIFIED: scripts/docs-golden.ts:373-377,581-585; packages/cli/src/session/hook.ts:263-274]

## Implementation File List

This is the proposed complete integration set; new test/operation names are proposals, not claims that files already exist.

1. **Core authority:** `packages/mcp-server/src/planning/steering-sessions-store.ts` (new distinct port/adapter); `planning/session-state.ts` (issuance/lifecycle orchestration, guarded snapshots, internal cache only); `service.ts` (authority wiring, all private consumers, caller propagation, close/recheck paths).
2. **Persistence:** `packages/mcp-server/src/index-store.ts` (adapter factory and migration 42); `index-store.migrations.digests.json` (append the new digest, do not change prior values); `index-store.migrate-contract.test.ts` (reasoned security-state archive treatment). Use the existing migration-digest generation convention under parent authorization. [VERIFIED: scripts/migration-digests.ts:5-15]
3. **Shared tools and delivery:** `planning/steering-tools.ts`, `planning/steering-rest.ts`, `planning/steering-delivery.ts`, `planning/steering-waiters.ts`; migrate admission/results, ack target inference, state port, and wait release logic together.
4. **Public transports:** `mcp.ts`, `server.ts`; shared issuance/renew/close and private-handle fields; update tool descriptions, `JSON_BODY_ROUTES`, and HTTP result mapping. No tool-only or route-only gate.
5. **Request types/private brief consumers:** existing `brief.ts` request definition and all transport/service consumers; existing docs-search request/reply definitions as discovered by LSP. Do not widen with unvalidated arbitrary fields to avoid migrating callers.
6. **Configuration/classification:** `config.ts`, `flag-registry.ts`, `.env.example`, `docs/config-reference.md`, `admission.ts`, `packages/audit/src/policy.ts`; classify each new operation deliberately and keep general admission semantics distinct from mandatory session admission.
7. **Audit vocabulary:** `event-sources.ts`, `docs/event-vocabulary.md`; update hashed refusal sample/contract and register any new lifecycle actions using existing event kinds. No raw-ID refusal note remains in brief/close helpers.
8. **CLI:** `packages/cli/src/steer/client.ts`, `steer/index.ts`, appropriate `steer/render.ts` changes for lifecycle/expiry, `session/command.ts`, `session/hook.ts`, `session/hook-config.ts`; update help and strict args; preserve checkpoint historical identity. `packages/cli/src/index.ts` changes only if dependency wiring needs new seams, not to introduce another token resolver.
9. **Docs:** `docs/live-steering.md`, `docs/data-planes.md`, the existing session rollback and index archive runbooks referenced by these docs; explain lifecycle, mandatory authority, cache distinction, same-surface limitation/selected proof contract, typed errors, operator permissions, unkeyed shape, heartbeat, legacy migration, and recovery. The researcher makes none of these product/doc edits.
10. **Regression suites to migrate:** `planning/session-state.test.ts`, `planning/session-state.durable.test.ts`, `planning/steering-sessions-store.pg.test.ts`, `planning/steering-tools.test.ts`, `planning/steering-rest.test.ts`, `planning/steering-session-gate.test.ts`, `planning/steering-delivery.test.ts`, `planning/steering-waiters.test.ts`, `server.steering.test.ts`, `mcp.test.ts`, `mcp.steering.test.ts`, `brief-sessions.test.ts`, `brief-fast-path.test.ts`, `session-context.test.ts`, CLI steer and session-hook tests, admission/audit policy/flag/migration locks. Fixtures must issue/seed through an explicit test authority, not a public `put` bypass. (Proposed work based on the inspected caller map.)

## Don't Hand-Roll

| Problem | Do not build | Reuse / proposed minimal addition | Basis |
|---|---|---|---|
| Authentication | New JWT/OAuth/login service | Existing surface bearer/operator resolver; explicit proof only if contract alternative 3 is selected | [VERIFIED: config.ts:2013-2018; mcp.ts:593-619] |
| Steering state | Second transition state machine | `nextSteeringSession`, current states and carry-forward semantics | [VERIFIED: event.ts:337-365,409-433; mcp.ts:1666-1680] |
| Directive policy | Parallel queue, confirmation, or audit protocol | Existing `SteeringInbox` | [VERIFIED: planning/steering.ts:4-21] |
| Rate arithmetic | Another ad hoc counter per session ID | `bucketStep`, `limitFor`, bounded caller-keyed state | [VERIFIED: admission.ts:128-149,322-325] |
| Binding durability | Memory map, Redis TTL, old cache upsert as authority | Insert-only/guarded PostgreSQL authority and permanent tombstones | [VERIFIED: planning/session-state.ts:185-240; planning/steering-sessions-store.ts:89-121] |
| Crypto | Pseudorandom timestamps or shape checks | Official CSPRNG bytes plus durable uniqueness | [CITED: https://nodejs.org/api/crypto.html#cryptorandombytessize-callback] |
| Cross-store transaction | Pretend ack and session state are atomic across every plane | Preserve existing acknowledged/refused-transition result | [VERIFIED: planning/steering-delivery.ts:139-166] |

## Common Pitfalls

1. **UUID-shaped input mistaken for issuance.** Reject unknown supplied IDs; absence creates, presence updates. Tests must include a valid-looking client UUID and a valid-looking generated-prefix ID that never existed. Existing `docs_steering_session` is precisely create-or-update today. [VERIFIED: packages/mcp-server/src/mcp.ts:1633-1682]
2. **Server IDs mistaken for secret capabilities.** Current lists and public-redacted digest reveal IDs, and auth collapses same-surface credentials. Test/disclose the identity-scope choice instead of claiming session uniqueness gives authorization. [VERIFIED: packages/mcp-server/src/config.ts:2013-2018; packages/mcp-server/src/planning/steering-rest.ts:79-105; packages/mcp-server/src/service.ts:3447-3451]
3. **Optional durable cache silently promoted.** Its save can fail/drop while memory proceeds, TTL prune deletes rows, and its primary key permits same ID on multiple surfaces. Add separate authority and fail closed if unavailable. [VERIFIED: packages/mcp-server/src/planning/session-state.ts:225-250; packages/mcp-server/src/planning/steering-sessions-store.ts:89-121]
4. **404 body equal but headers/audit fields differ.** Use one failure object and response helper. Do not expose internal ownership reason or `audit: unrecorded` variance. Existing code currently adds the latter. [VERIFIED: packages/mcp-server/src/planning/steering-tools.ts:182-190]
5. **Gate at transport but not service.** Docs REST goes directly to `searchDocs`, and notice/ledger helpers accept raw ID. Gate the service and private helper inputs; no client/test seam can be a production bypass. [VERIFIED: packages/mcp-server/src/server.ts:1555-1563; packages/mcp-server/src/service.ts:3636-3644,5931-5939,5968-5979]
6. **Wait authorized only when created.** The current waiter `check` is synchronous inbox-only. Treat it as wake-up, reauthorize after it resolves, and wake at lease expiry/close. [VERIFIED: packages/mcp-server/src/planning/steering-waiters.ts:75-81,104-157]
7. **Brief silently strips private section or uses attributed surface.** Preserve generic brief behavior only when no explicit live handle is requested; explicit denied live handle must give the same typed 404 before ETag/cached early return. Existing transport keeps body attribution separate from bearer. [VERIFIED: packages/mcp-server/src/server.ts:1165-1208; packages/mcp-server/src/service.ts:3560-3594]
8. **Refusal log leaks raw target through another field.** Check summary, payload, top-level `session_id`, exception diagnostics, vocabulary sample, and close/brief helpers, not just one payload key. Existing sources demonstrate all three raw-ID placements. [VERIFIED: packages/mcp-server/src/planning/steering-tools.ts:171-179; packages/mcp-server/src/service.ts:2549-2562,3565-3576; packages/mcp-server/src/event-sources.ts:1556-1562]
9. **Archive exclusion treated as backup.** The legacy logical archive intentionally has a closed table set. State the separate backup requirement and refusal to restart with lost authority; do not claim non-reuse after tombstone loss. [VERIFIED: packages/mcp-server/src/index-archive-spec.ts:4-17]

## Code Examples

These are design examples, not existing repository interfaces or tested implementations. Proposed names/literals are deliberately marked so they cannot be mistaken for verified in-repo discrete values.

### Proposed server-only ID issuer

```typescript
// Proposed prefix and length; never accept a client candidate in issue().
// Official mechanism: https://nodejs.org/api/crypto.html#cryptorandombytessize-callback
import { randomBytes } from "node:crypto";
const candidate = `live-${randomBytes(32).toString("hex")}`;
// INSERT candidate + authenticated owner + DB timestamps, no owner-changing UPSERT.
// Return candidate only after the authoritative insert transaction commits.
```

### Existing uniform not-found shape to reuse

```typescript
// Existing union admits these exact values; use one instance/factory for every denial.
// packages/mcp-server/src/planning/steering-tools.ts:126-133
// packages/mcp-server/src/planning/steering.ts:208-223
const missing = { status: "refused", error: { code: "not-found" } } as const;
```

### Proposed guarded renewal predicate

```sql
-- Proposed table/column names. Bind every value with Bun SQL templates.
UPDATE live_session_bindings
SET last_seen_at = clock_timestamp(),
    expires_at = clock_timestamp() + $1::interval
WHERE session_id = $2
  AND owner_surface = $3
  AND closed_at IS NULL
  AND expires_at > clock_timestamp()
RETURNING session_id, expires_at;
-- Zero rows -> same resource-not-found result, not insert/reopen.
-- If proof mode is selected, include proof-digest equality in this predicate.
```

## State of the Art

Use database-backed object authorization and explicit session invalidation, not ID unpredictability as authorization. OWASP ASVS 5.0.0 separates session management, authorization, and security logging; it explicitly requires backend verification and data-specific permissions and describes hashing/masking session-token log values. These are supporting engineering controls, not a claim of ASVS certification or an externally mandated retention period. [CITED: https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x16-V7-Session-Management.md] [CITED: https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x17-V8-Authorization.md] [CITED: https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x25-V16-Security-Logging-and-Error-Handling.md]

## Environment Availability

| Dependency | Observation this session | Planning consequence |
|---|---|---|
| Bun | `bun --version` returned `1.4.0` | Existing runtime available; no install attempted. |
| Node | `node --version` returned `v24.18.0` | Read-only GSD seam available. |
| PostgreSQL connectivity/schema | Not probed; assignment forbids runtime tests and production mutations | Executor must supply controlled test database and migration/restart proof when authorized. No availability claim. |
| Context7 CLI | `command -v ctx7` returned no command, exit 1 | Used official public docs directly; did not auto-install a client. |
| Deployed hooks/timers | Not inspected or changed | Integration instructions only; installation remains operator-only. |

Research provider planning was obtained via the installed read-only `planResearch` seam without creating its normal input file; it selected `context7` for the three documentation questions. The CLI fallback was unavailable, so official Node/Bun/PostgreSQL/OWASP sources were read directly. The confidence seam returned `MEDIUM` for `websearch --verified`. No research cache write was performed because this assignment permits only this artifact to be written. This is an explicit workflow adaptation, not a fabricated provider/cache result.

## Validation Architecture

Validation remains enabled because `.planning/config.json` has no explicit false setting for it. This assignment ran **no tests, builds, linters, formatters, installs, or git writes**. The parent-owned verification record already states `gaps_found`; reported prior passes do not establish the missing lifecycle behavior. [VERIFIED: .planning/config.json:1-10; .planning/phases/71-multi-session-boundary/71-VERIFICATION.md:1-27]

| Property | Existing/proposed value |
|---|---|
| Existing framework | `bun:test`, repository script `"test": "bun test"` [VERIFIED: package.json:22-24; packages/mcp-server/src/index-store.migrate-contract.test.ts:19-21] |
| Parent quick group | `bun test packages/mcp-server/src/planning/steering-session-gate.test.ts packages/mcp-server/src/planning/session-state.test.ts packages/mcp-server/src/planning/steering-tools.test.ts` (proposed command, not exercised or timed) |
| Recorded broad group | `bun test --timeout 30000 packages/mcp-server/src/planning packages/mcp-server/src/server.steering.test.ts packages/mcp-server/src/session-context.test.ts packages/mcp-server/src/brief-sessions.test.ts packages/cli/src/steer packages/cli/src/session/hook.test.ts` [VERIFIED: .planning/phases/71-multi-session-boundary/71-VERIFICATION.md:17] |
| Full repository gate | `bun run verify`, including typecheck/tests/repo locks; parent only, when explicitly authorized [VERIFIED: AGENTS.md:24; package.json:40-54] |
| Live DB prerequisite | Controlled `SUBSTRATE_TEST_PG_URL`, never a production migration [VERIFIED: AGENTS.md:22-24] |

### Requirements → concrete scenarios

All scenarios below are proposed acceptance tests; none were executed by this researcher.

| Requirement | Scenario | Layer / likely suite |
|---|---|---|
| S1-IDENTITY | Issuer called with deterministic 32-byte seam; first collision with active ID then tombstoned ID never returns either; entropy failure/commit failure returns no issued grant | Authority unit + controlled PG integration |
| S1-IDENTITY | Client UUID/new-prefix arbitrary ID supplied to registration is 404; absent ID creates; no unknown/foreign/terminal create-or-update fallback | MCP + REST lifecycle |
| S1-DURABLE | Two independent store instances race inserts for one generated candidate; exactly one owns it; owner never changes | PG integration, not two maps sharing one fake |
| S1-DURABLE | Fresh migration with cache opt-in off, then restart with same index: bound state readable and closed ID still denied | Migration + service restart integration |
| S1-DURABLE | Cap eviction, cache TTL prune, cache write failure, stale cache reload cannot free/reassign/revive ID | Registry/cache failure injection |
| S1-BINDING / S1-NOTFOUND | For each private route/tool: owner succeeds; foreign/unknown/closed/expired return equal 404 body/headers; null/invalid bearer follows existing authentication rule | HTTP loopback + MCP transport matrix |
| S1-BINDING | Same-surface sibling test demonstrates the selected contract: surface mode intentionally shares access; proof mode denies missing/wrong sibling proof even with public ID | Explicit identity decision regression |
| S1-LIVENESS | Database time controls lease; forged client timestamps ignored; expiry boundary tested; old heartbeat cannot revive; owner activity renews; operator read/queue does not renew | Authority deterministic unit + PG |
| S1-DURABLE / S1-LIVENESS | Race heartbeat/state update against close across store instances; close winning prevents later mutation, delayed cache save irrelevant; repeat close never creates | PG concurrency/failure injection |
| S1-BINDING | Docs MCP and REST cannot leak foreign notice/body/state or context events; explicit live handle gated before and after retrieval; historical label alone does not select private data | Docs service + MCP + HTTP |
| S1-NOTFOUND | Explicit live handle in brief denied equally before fast-path, snapshot/last-good path, ETag/304 path; generic brief and repo digest unchanged | Brief/HTTP fast-path suites |
| S1-LIVENESS | Wait starts owned, then close/expiry/authority outage before queue wake or timeout: no directive released; 404/503 as appropriate; timer/listener/request cleanup exactly once | Waiter/service/HTTP suites |
| S1-COMPAT | Operator queue/ack still requires allowlist/confirm/audit; old unkeyed bodies unchanged; non-owner agent 404, owner non-operator 403; operator unknown target 404 | Tools/REST/CLI suites |
| S1-COMPAT | Ack audited, close wins before state application: acknowledgement stands, session_state refused, no checkpoint_hint | Delivery race test |
| S1-LIMITER | Many randomized target IDs consume same caller bucket; lookup spy stays untouched on 429; same on Redis/cache outage and general admission off/shadow | Boundary limiter unit + transport |
| S1-AUDIT | Every refusal audit/log surface contains only target digest, no raw ID/body/proof/token; audit unavailable does not change public 404 or permit effect | Builder + HTTP/MCP failure injection |
| S1-COMPAT | CLI distinguishes typed resource 404 from missing-route 404 on list/wait/write; listen does not retry terminal denial indefinitely | Steer client/listen tests |
| S1-COMPAT | Hook checkpoint historical ID stays stable, live hint ID separate; no live handle means no historical-label private query; checkpoint idempotence retained | Session hook/config tests |
| S1-COMPAT | Repo context still contains cross-session redacted metadata, own-label exclusion, provenance, caps; no private directions/proofs added | Existing session-context fixtures |
| S1-DURABLE | Lost/timed-out close/issue commit response; service never reports a durability guarantee it did not observe; unavailable authority releases no private bytes | Authority/service failure injection |

**Wave 0 gaps:** add the authoritative-store tests and shared issuance fixture first; replace fixtures that call public `put` to grant ownership; update result-union guards and policy/classification locks together. Use the existing controlled PostgreSQL integration convention rather than treating an in-memory fake as restart/concurrency proof. Main verifies once after integrated changes; do not run sibling suites concurrently against half-migrated interfaces.

## Security Domain

Security enforcement is not explicitly disabled in the inspected config. Use ASVS **5.0.0** category numbering, not the older generic template numbering: `V7 Session Management`, `V8 Authorization`, and `V16 Security Logging and Error Handling` are the inspected chapter titles. [VERIFIED: .planning/config.json:1-10] [CITED: https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x16-V7-Session-Management.md] [CITED: https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x17-V8-Authorization.md] [CITED: https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x25-V16-Security-Logging-and-Error-Handling.md]

| Applicable category | Application to this phase (proposed control) |
|---|---|
| V6 Authentication | Preserve existing authenticated surface/operator identity. No new login provider; proof addition only by explicit contract decision. |
| V7 Session Management | Trusted server issuance/verification, lease invalidation, terminal close, documented concurrency/lifetime and shared-token semantics. |
| V8 Authorization | Data-specific live-session gate at trusted service layer and recheck after asynchronous work. |
| V2 Validation and Business Logic | Strict operation schemas, no arbitrary owner field or client-supplied issuance ID, bounded work. |
| V11 Cryptography | CSPRNG bytes and established hash primitive; never homebrew randomness or reversible proof encoding. |
| V16 Logging/Error Handling | Hashed refusal identifiers, generic uniform denial, no failed-authority grant. |

Chapter identities were confirmed from the official stable release inventory; V7/V8/V16 bodies were additionally read. This is a control mapping, not a claim that an ASVS audit has passed. [CITED: https://api.github.com/repos/OWASP/ASVS/contents/5.0/en?ref=v5.0.0]

| Threat | STRIDE | Required proposed mitigation |
|---|---|---|
| Client-chosen ID fixation/takeover | Spoofing / elevation | Insert-only server issuance; immutable owner; no cache adoption |
| Shared-token sibling using discovered ID | Spoofing / information disclosure | Explicit identity-contract choice; proof mode if per-session isolation is required |
| Closed ID resurrected after restart/cache restore | Tampering / elevation | Durable terminal record; authoritative liveness predicate |
| Target existence oracle | Information disclosure | Same refusal object/status/headers and no audit variance |
| Lookup/audit flood with random targets | Denial of service | Principal bucket before lookup/audit, bounded cardinality |
| Late wait/history/docs response after revocation | Information disclosure | Release-time reauthorization and no positive-cache fallback |
| Forged historical event closes another session | Tampering | Explicit live-handle side-effect gate using caller, not event attribution |
| Database outage mistaken for permission success | Elevation | Typed unavailable and no private data/effect |

## Assumptions Log

| # | Claim/policy not established as an accepted fact | Location | Consequence |
|---|---|---|---|
| A1 | Whether original acceptance means isolation between mutually untrusted sessions sharing the same surface credential is unresolved. Current code cannot distinguish them. | Identity-contract decision | Surface mode cannot certify the stronger promise; proof mode requires explicit credential contract selection. |
| A2 | Proposed one-hour binding lease / five-minute heartbeat is a starting engineering policy, not measured or owner-locked. | Liveness policy | Planner must document final bounds/cadence and ensure intended hosts can renew during quiet periods. |
| A3 | Production PostgreSQL availability, installed hooks, and complete recoverable security-state backups were not observed. | Environment/recovery | Controlled integration proof and operator recovery prerequisites remain; no production-readiness claim. |
| A4 | Missing project-instruction/skill files are an observation of targeted discovery only. | Project constraints | No claim about another checkout or runtime profile. |

Proposed API/type/table/field names in this document are recommendations, not asserted current repository values. No package or compatibility claim rests on missing registry metadata.

## Open Questions and Planning Disposition

1. **Identity scope is the one hard contract decision.** The three evidenced alternatives above are exhaustive for this plan's checkpoint. Continue common lifecycle work; do not mark stronger same-surface isolation met without its discriminator/proof and caller coverage.
2. **Finalize lease policy under engineering discretion.** Keep it independent of cache TTL and expose expiry to clients. Do not interpret checkout presence as caller proof.
3. **Recovery prerequisite is operational, not executable here.** Document authoritative-table backup and no stale-tombstone restore; do not deploy or run production migrations in this phase.

## Sources and Metadata

### Primary repository evidence (HIGH confidence for observed behavior)

All source anchors are in `/root/src/worktrees/as-h15-s1`. Inspected core: `planning/session-state.ts`, `planning/steering-sessions-store.ts`, `planning/steering-tools.ts`, `planning/steering-rest.ts`, `planning/steering-delivery.ts`, `planning/steering-waiters.ts`, `service.ts`, `mcp.ts`, `server.ts`, `index-store.ts`, migration-contract/archive definitions, config/admission/audit policy/event sources, CLI steer/session hook paths, and the complete phase context. Exact ranges and verbatim values are attached to claims above.

### Official documentation (MEDIUM per the confidence seam)

- Node crypto: https://nodejs.org/api/crypto.html#cryptorandombytessize-callback — cryptographic byte generation; UUID documentation cross-check.
- Bun SQL: https://bun.sh/docs/runtime/sql — existing tagged-template/transaction mechanism.
- PostgreSQL 16 row locks: https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-ROWS — transaction/row-conflict semantics.
- OWASP ASVS stable 5.0.0: https://asvs.owasp.org/ and official chapter sources linked in Security Domain — category mapping, backend session verification, authorization, hashed/masked token logging. Versioned source selected; no certification claim.

**Confidence breakdown:** stack HIGH (repository declarations, no upgrade); existing call paths HIGH (source inspected); proposed authority mechanics MEDIUM (official mechanisms, not executed); accepted identity scope LOW until checkpoint selection. Research/cache provider fallback and unavailable runtime observations are reported explicitly above.

**Verification performed:** source/document inspection and runtime-version/document-client availability commands only. No tests/builds/lint/formatters/install, no live store probes, no git writes, and no product edits. Parent owns integration and verification. Research should be refreshed if these source interfaces or the identity-contract decision change; it is not evidence that Phase 71 is complete.
