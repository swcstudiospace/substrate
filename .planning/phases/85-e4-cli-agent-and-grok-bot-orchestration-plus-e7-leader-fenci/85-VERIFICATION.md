---
phase: 85-e4-cli-agent-and-grok-bot-orchestration-plus-e7-leader-fenci
verified: 2026-11-28T09:13:43Z
status: passed
score: 5/5 must-haves verified
covered_files:
  - .planning/phases/85-e4-cli-agent-and-grok-bot-orchestration-plus-e7-leader-fenci/85-PLAN.md
  - .planning/phases/85-e4-cli-agent-and-grok-bot-orchestration-plus-e7-leader-fenci/85-SUMMARY.md
  - packages/mcp-server/src/orchestration.test.ts
  - packages/mcp-server/src/orchestration.ts
  - packages/mcp-server/src/service-orchestration.test.ts
  - packages/mcp-server/src/service.ts
covered_digest: "v3:sha256:e9e10abfa400c8c89b6c178f4c0f14905bc5aa021e16ad07e38295eba4d0f282"
decision_coverage: { honored: 4, total: 4, not_honored: [] }
behavior_unverified: 1
behavior_unverified_items:
  - truth: "delegateHandoff stores a signed handoff packet and an audit note against a live ledger, and fenceAcquire audits against a live ledger"
    test: "Point the service at a live ledger and run delegateHandoff end-to-end; no fake seam involved"
    expected: "one stored handoff packet signed by the caller path and one fail-open audit note (kind note, payload delegation) in the ledger"
    why_human: "Phase doctrine is fake-only tests (no planes, no ledger, no network in harness); the production wiring (service.ts:4430 delegateHandoff, service.ts:4505 fenceAcquire) is code-reviewed and unit-pinned via fakes but has never run against a real ledger in this phase"
re_verification:
  previous_status: passed
  previous_score: 5/5 must-haves verified
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 85 Verification: E4 CLI Agent and Grok Bot orchestration plus E7 Leader fencing

**Verified:** 2026-11-28T09:13:43Z
**Worktree:** `/tmp/agent-substrate-wave8`
**HEAD:** `841e8b9e` (`docs(85): VERIFICATION + phase complete`), clean tree (`git status --porcelain` empty)
**Scope:** Goal-backward re-verification against `85-CONTEXT.md` + `85-PLAN.md` (3 tasks), same 5 must-haves as the prior pass at `955cc206`. Read-only except this file; no product code, STATE, or ROADMAP edits. This verifier re-ran the focused loop (`orchestration.test.ts` + `service-orchestration.test.ts`: 24 pass / 0 fail), regression loop, `bunx tsc --noEmit`, `bun run lint`, and `bun run check:phase-close`, all green.

## Verdict summary

**Status: `passed`** — all five must-haves hold in code and tests at HEAD `841e8b9e`. Delegation handoffs are namespaced `agent:<surface>` with Phase 72 allowlist permission checked fail-closed and one audit note per delegation; denials store nothing. The leader fence issues `{lease_id, epoch, observed_epoch}` tokens, rejects stale epochs for the same holder after a TTL bump and strangers as `not-holder`, and never runs the write function on rejection. The delegation queue uses a 900s default TTL, moves expired entries to the dead-letter list with reason `ttl-expired` and failed entries with reason `failed` (never silently dropped), surfaced via `queueDeadLetters`. No new store/tool/admission change; `EVENT_KINDS` unchanged at 12. The loop is green. One `behavior_unverified` item (live ledger) is recorded in the frontmatter.

Since the prior pass at `955cc206`, the only change in the tree is this verification document itself (`git diff 955cc206..HEAD --stat` touches only `85-VERIFICATION.md`); product code is byte-identical, so no code drift applies.

## Criterion verdicts

| # | Criterion | Verdict | Evidence (file:line at HEAD `841e8b9e`) |
|---|---|---|---|
| 1 | E4 namespace/permission/audit: `agent:<surface>` + Phase 72 allowlist fail-closed + one audit note per delegation; denials store nothing | **passed** | `orchestration.ts:40` `agentNamespace` returns `` `agent:${surface}` ``. `orchestration.ts:49` `checkDelegationPermission` requires both sessions granted the repo via `allowlistFor`; `allowlist.size === 0` → `empty-allowlist` (fail-closed); never throws. `orchestration.ts:83` `buildDelegation` reuses `buildHandoff` with receiver as the `to` party. `orchestration.ts:108` `recordDelegationAudit` appends one row via `DelegationAuditPort`. `service.ts:4430` `delegateHandoff` parses `repoAllowlistFromEnv` (unparseable → empty), checks permission before any store, routes through `this.handoff`, then appends one fail-open audit `note` with payload `delegation`. `service-orchestration.test.ts` pins granted delegation stores 1 handoff + 1 audit note and denied/empty stores nothing. |
| 2 | E7 fence: stale-epoch / not-holder rejection, write fn never runs on rejection | **passed** | `orchestration.ts:145` `LeaderFence.acquire` wraps `decideClaim` (`lease.ts:218`); holder change bumps epoch. `orchestration.ts:177` `renew` wraps `decideHeartbeat` and maps `not-holder` through. Token `{lease_id, epoch, observed_epoch}` (`orchestration.ts:124-132`) issued on grant and on renewal. `orchestration.ts:193` `assertFresh` is the epoch CAS: holder mismatch → `not-holder`; `token.epoch !== current.epoch \|\| token.lease_id !== current.lease_id` → `stale-epoch`; no hold → `unheld`. `orchestration.ts:202` `fencedWrite` returns the denial before calling `fn`. `service.ts:4505` `fenceAcquire` audits one `note` on grant. `orchestration.test.ts` pins stranger-while-held denied, renew keeps epoch, expiry bumps epoch, stale write rejected with `stale-epoch` and write fn never run. |
| 3 | TTL 900s + DLQ: expired → `ttl-expired`, failed → `failed`, never silently dropped | **passed** | `orchestration.ts:244` `DelegationQueue.enqueue` stamps `ttl_seconds` defaulting to `DEFAULT_LEASE_TTL_SECONDS` = 900s (`lease.ts:42`); duplicate ids throw. `orchestration.ts:254` `dequeue` returns non-expired FIFO and moves expired to the dead list with reason `ttl-expired`. `orchestration.ts:269` `fail` moves a task there with reason `failed`; unknown id → `false`. `orchestration.ts:278` `listDead` + `deadCount` + `pendingCount` are the list surface; `service.ts:4497` `queueDeadLetters` exposes `{dead_letters, dead_count}`. `orchestration.test.ts` pins `ttl_seconds === 900`, FIFO, expiry-to-DLQ, fail-to-DLQ, `deadCount()` matches `listDead().length`. |
| 4 | No surface drift: `EVENT_KINDS` = 12, no new store/tool/admission | **passed** | `types.ts:69` `EVENT_KINDS` is the closed 12-element tuple (`session.start`, `prompt`, `claim`, `tool.call`, `file.edit`, `shell`, `commit`, `pr`, `handoff`, `session.end`, `note`, `warning`), unchanged. `bun run check:phase-close` reports `EVENT_KINDS unchanged at 12 against ab62c91; SURFACES equals baseline plus substrate at 42`. `git diff 955cc206..HEAD` touches only this verification file; the Phase 85 implementation commit `955cc206` touched only the 4 implementation files + phase docs: no `types.ts`, `mcp.ts`, `server.ts`, store, or admission change. `orchestration.ts` is pure (no I/O; fence/queue are in-process memory audited through the ledger) — no new coordination store or table. |
| 5 | Loop green: focused + regression + tsc + lint + phase-close | **passed** | `bun test orchestration.test.ts service-orchestration.test.ts` — **24 pass, 0 fail** (83 expects). `bun test service-orchestration.test.ts handoff.test.ts session-registry.test.ts` — **46 pass, 0 fail** (257 expects). `bun test service.test.ts service-forget.test.ts` — **445 pass, 0 fail** (2112 expects). `bunx tsc --noEmit` — clean (exit 0). `bun run lint` — clean (1904 files, biome). `bun run check:phase-close` — **pass** (239 pass, 4 lock files). |

## Gaps / regressions

None. Prior pass recorded no gaps; this re-verification found no regressions at HEAD `841e8b9e`.

## Behavior unverified (1, human-needed)

Live-ledger writes — see frontmatter `behavior_unverified_items`. Fake-only by phase doctrine; the live wiring has never run against a real ledger in this phase.

## Notes

- `covered_digest` was computed via `gsd_run query verification.fingerprint` over the implementation files above plus the phase PLAN/SUMMARY (auto-included by the command); digests are current for HEAD `841e8b9e`.
- Deferred (out of scope, per CONTEXT): fair-queue priorities beyond TTL expiry; CLI `substrate handoff`/`substrate queue` surfaces reusing existing commands in a later phase (no new MCP tool here).
