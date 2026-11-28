# Phase 85: E4 CLI Agent and Grok Bot orchestration plus E7 Leader fencing — plan

**Context:** `85-CONTEXT.md` (delegation handoffs with namespace + permission model, per-agent audit; single-writer session mutation gate with TTL'd queueing and dead-letter surfacing). Reuse: Phase 83 `session-registry.ts` ownership view, Phase 58 signed handoffs (`handoff.ts` `buildHandoff`/`signHandoff`, ledger append via `service.handoff` `service.ts:8117`), Phase 72 allowlist (`repo-allowlist.ts` `assertRepoAllowed`, `repoAllowlistFromEnv`, `allowlistFor`), `graph_claim`/`graph_release` holder = `(surface, session_id)` checks (`lease.ts` `decideClaim`/`decideHeartbeat`, `session-registry.ts` `registryTake`/`registryRelease`). No new coordination store, no new tables; EVENT_KINDS unchanged (phase-close lock). Fake-only tests, no DB, no server, no network.

## Task 1 — Delegation handoffs (`orchestration.ts`: namespace + permission + audit)

New `packages/mcp-server/src/orchestration.ts` (pure delegation decisions, like `session-registry.ts` — no I/O in this file):

- `agentNamespace(surface: Surface): "agent:<surface>"` — the delegation namespace.
- `checkDelegationPermission(allowlist: RepoAllowlist, fromSession: string, toSession: string, repoId: string): {ok:true} | {ok:false, reason:"not-allowed"|"empty-allowlist"}` — both sessions must hold a grant for `repoId` in the Phase 72 allowlist (reuse `allowlistFor`/`assertRepoAllowed`); empty or unparseable allowlist denies (fail-closed); unknown session denies. Never throws.
- `buildDelegation(input: DelegationInput)`: reuses `buildHandoff` (redacted/capped/signed by the caller path) with `to: {surface: to_surface, session_id: to_session}`; returns `{ packet, namespace, to_session, repo }`.
- `DelegationAuditPort { appendAudit(entry: DelegationAuditEntry): void | Promise<void> }` — per-agent audit: one call per delegation, entry carries `{ namespace, from_surface, from_session, to_surface, to_session, repo, handoff_id }`. Service wires it to a ledger append (see Task 3); fakes in tests.

Acceptance: `orchestration.test.ts` — namespace is `agent:<surface>`; permission allows only when both sessions are granted the repo; unknown session, unknown repo, and empty allowlist all deny; `buildDelegation` output packet matches `buildHandoff` shape with the `to` party set.

## Task 2 — LeaderFence + TTL queue/DLQ (`orchestration.ts`)

- `LeaderFence`: in-memory per-worktree fence keyed by `worktree_path`, holding a `LeaseSnapshot` per worktree; `acquire(sessionId, surface, worktreePath, nowMs)` wraps `decideClaim` (holder change bumps epoch and mints a new `lease_id`, `lease.ts:218/259`); `renew(token, nowMs)` wraps `decideHeartbeat` (`lease.ts:312`); token is `{ lease_id, epoch, observed_epoch }` — the fencing token on lease renewal. `assertFenceFresh(token, worktreePath)` rejects stale tokens (`token.epoch !== current.epoch` or holder mismatch — epoch CAS); `fencedWrite(token, worktreePath, fn)` refuses before calling `fn` when stale. TTL defaults to `DEFAULT_LEASE_TTL_SECONDS` (900s, `lease.ts:42`).
- `DelegationQueue`: `enqueue(task, {ttlSeconds})` (default 900s), `dequeue(nowMs)` returns non-expired due tasks, `fail(id, reason)` moves an entry to the dead-letter list, expired entries move there too — never silently dropped. `listDead(): DeadLetter[]` + `deadCount()` + `pendingCount()` (the list surface). DLQ entry shape mirrors the Phase 76 `DeadLetterStore` list (`service.ts:696`, `event-buffer.ts:134`).

Acceptance: acquire by a stranger while held is denied; renew keeps epoch; after TTL expiry a new acquire bumps the epoch and the old token is rejected on write (`fencedWrite` returns `{ok:false, reason:"stale-epoch"}` and the write fn is never called); expired queue entries appear in `listDead()` with `reason:"ttl-expired"`, failed entries with `reason:"failed"`; `deadCount()` matches `listDead().length`.

## Task 3 — Service wiring (`service.ts`)

- `Substrate.delegateHandoff(input, env = process.env)`: parses the allowlist from env (the `repoScopeStatus` pattern, `service.ts:7341`; parse failure → empty → deny), calls `checkDelegationPermission` (denied → `{ok:false, reason}`), then `this.handoff(...)` with the `to` party, then — when stored — appends one fail-open audit event (kind `note`, payload `{ delegation: {...} }`, like `bindGraph`'s note) via `this.emit`. No EVENT_KINDS change. Returns `{ ok, packet, namespace, stored, event, gaps }`.
- `Substrate` owns a `DelegationQueue` and a `LeaderFence` (constructed in the constructor beside `deadLetters`/`eventBuffer`, `service.ts:2065`); methods `enqueueDelegation(task)`, `dequeueDelegations(now?)`, `queueDeadLetters()` → `{ dead_letters, dead_count }` (count + list surface), `fenceAcquire(sessionId, surface, worktreePath)` / `fenceRenew(token)` / `fenceWrite(token, worktreePath, fn)`.
- No new MCP tool, no admission/route-policy change (Phase 84 pattern); CLI `substrate handoff`/`substrate queue` surfaces reuse the existing commands in a later phase.


## Verification (fake-only)

- `bun test packages/mcp-server/src/orchestration.test.ts` — task 1 + 2 acceptance.
- `bun test packages/mcp-server/src/service.test.ts` (touched suite) — task 3 regression.
- `bunx tsc --noEmit` — clean. `bun run lint` — clean.
- `bun run check:phase-close` — pass (4 lock files; EVENT_KINDS unchanged at 12).
