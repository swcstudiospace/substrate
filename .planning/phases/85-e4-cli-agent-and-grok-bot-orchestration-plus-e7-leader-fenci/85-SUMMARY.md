# Phase 85: E4 CLI Agent and Grok Bot orchestration plus E7 Leader fencing — summary

**Context:** `85-CONTEXT.md` (delegation handoffs with namespace + permission model, per-agent audit; single-writer session mutation gate with TTL'd queueing and dead-letter surfacing). Reuse: Phase 83 SessionRegistry ownership, Phase 58 signed handoffs, Phase 72 allowlist, `graph_claim`/`graph_release` holder = `(surface, session_id)` checks. No new coordination store, no new tables; EVENT_KINDS unchanged. Done: `orchestration.ts` + `Substrate` wiring, fake-only tests. No commit.

## What shipped

- **Delegation handoffs (E4)** — `packages/mcp-server/src/orchestration.ts:40`: `agentNamespace` (`agent:<surface>`); `checkDelegationPermission` (`orchestration.ts:49`) reuses the Phase 72 allowlist (`allowlistFor`, `repo-allowlist.ts:88`) — both sessions must be granted the repo, empty allowlist grants nothing (fail-closed), never throws; `buildDelegation` (`orchestration.ts:83`) reuses `buildHandoff` (`handoff.ts:260`) with the receiver as the `to` party; `recordDelegationAudit` (`orchestration.ts:108`) appends one per-agent audit row through `DelegationAuditPort`.
- **Service wiring** — `packages/mcp-server/src/service.ts:159` import; `delegateHandoff` (`service.ts:4430`) parses the allowlist from env (the `repoScopeStatus` pattern, `service.ts:7341`, `repoAllowlistFromEnv`), checks permission, routes through `this.handoff` (`service.ts:8117`), then appends one fail-open audit note (kind `note`, payload `delegation`) via `this.emit`. `Substrate` owns `delegationQueue`/`leaderFence` (`service.ts:1709`); `enqueueDelegation`/`dequeueDelegations`/`queueDeadLetters` (`service.ts:4488`) and `fenceAcquire`/`fenceRenew`/`fenceWrite` (`service.ts:4505`) sit beside `listDeadLetters`. No new MCP tool, no admission/route-policy change (Phase 84 pattern).
- **Leader fencing (E7)** — `LeaderFence` (`orchestration.ts:145`): per-worktree `LeaseSnapshot`, `acquire(session, worktree)` wraps `decideClaim` (`lease.ts:218`), `renew` wraps `decideHeartbeat` (`lease.ts:312`); the fencing token is `{ lease_id, epoch, observed_epoch }`, issued on grant and on renewal. `assertFresh` is the epoch CAS (`token.epoch !== current.epoch` → `stale-epoch`); `fencedWrite` refuses before running the write when stale. TTL defaults to `DEFAULT_LEASE_TTL_SECONDS` (900s, `lease.ts:42`).
- **TTL queue + DLQ** — `DelegationQueue` (`orchestration.ts:240`): `enqueue` stamps the 900s TTL (`orchestration.ts:244`), `dequeue` takes ready tasks FIFO and moves expired ones to the dead-letter list, `fail` moves a task there explicitly — never silently dropped; `listDead` (`orchestration.ts:278`) + `deadCount` + `pendingCount` are the list surface, mirroring the Phase 76 `DeadLetterStore` list shape (`event-buffer.ts:134`).

## Verification (fake-only; no planes, no ledger, no network)

- `bun test packages/mcp-server/src/orchestration.test.ts` — **19 pass** (namespace; permission allow/deny/empty; packet receiver; one audit row; fence grant/renew/stranger-denied/epoch-bump-on-expiry/stale-epoch reject with write fn never run; queue FIFO/900s TTL/expiry-to-DLQ/fail-to-DLQ/duplicate refusal).
- `bun test packages/mcp-server/src/service-orchestration.test.ts` — **5 pass**: granted delegation stores 1 handoff + 1 audit note with the namespace; denied delegation stores nothing; empty allowlist denies; TTL expiry surfaces via `queueDeadLetters()` with the count; fence acquire audits once, renew keeps epoch, stale write rejected.
- `bun test … service-orchestration.test.ts handoff.test.ts session-registry.test.ts` — **65 pass, 0 fail** (312 expects).
- `bun test … service.test.ts service-forget.test.ts` (touched suites) — **445 pass, 0 fail** (2112 expects).
- `bunx tsc --noEmit` — clean (one iteration needed: `exactOptionalPropertyTypes` on the enqueue options, `orchestration.ts:244`).
- `bun run lint` — clean (1902 files). `bun run check:phase-close` — **pass** (239 pass, 4 lock files; EVENT_KINDS unchanged at 12; SURFACES baseline + substrate at 42).

## Deferred (out of scope, per CONTEXT)

Fair-queue priorities beyond TTL expiry belong to a later orchestration phase if proven necessary; CLI `substrate handoff`/`substrate queue` surfaces reuse the existing commands in a later phase (no new MCP tool here).

## Loop harness

As above; no commit, per assignment.
