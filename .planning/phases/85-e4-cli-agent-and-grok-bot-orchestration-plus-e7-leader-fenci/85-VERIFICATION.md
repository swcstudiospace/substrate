---
phase: 85-e4-cli-agent-and-grok-bot-orchestration-plus-e7-leader-fenci
verified: 2026-11-28T09:09:36Z
status: passed
score: 5/5 must-haves verified
covered_files:
  - .planning/phases/85-e4-cli-agent-and-grok-bot-orchestration-plus-e7-leader-fenci/85-PLAN.md
  - .planning/phases/85-e4-cli-agent-and-grok-bot-orchestration-plus-e7-leader-fenci/85-SUMMARY.md
  - packages/mcp-server/src/orchestration.ts
  - packages/mcp-server/src/orchestration.test.ts
  - packages/mcp-server/src/service-orchestration.test.ts
  - packages/mcp-server/src/service.ts
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

**Verified:** 2026-11-28T09:09:36Z
**Worktree:** `/tmp/agent-substrate-wave8`
**HEAD:** `955cc206` (`feat(v1.9-p85): E4+E7 orchestration handoffs + Leader fencing`), clean tree (`git status --porcelain` empty)
**Scope:** Goal-backward re-verification against `85-CONTEXT.md` + `85-PLAN.md` (3 tasks), same 5 must-haves as the prior pass at `8ea4bc1d`. Read-only except this file; no product code, STATE, or ROADMAP edits. This verifier re-ran the focused loop (`orchestration.test.ts` + `service-orchestration.test.ts`: 24 pass / 0 fail), regression loop, `bunx tsc --noEmit`, `bun run lint`, and `bun run check:phase-close`, all green.

## Verdict summary

**Status: `passed`** — all five must-haves hold in code and tests at HEAD `955cc206`. Delegation handoffs are namespaced `agent:<surface>` with Phase 72 allowlist permission checked fail-closed and one audit note per delegation; denials store nothing. The leader fence issues `{lease_id, epoch, observed_epoch}` tokens, rejects stale epochs for the same holder after a TTL bump and strangers as `not-holder`, and never runs the write function on rejection. The delegation queue uses a 900s default TTL, moves expired entries to the dead-letter list with reason `ttl-expired` and failed entries with reason `failed` (never silently dropped), surfaced via `queueDeadLetters`. No new store/tool/admission change; `EVENT_KINDS` unchanged at 12. The loop is green. One `behavior_unverified` remains: live-ledger writes (see frontmatter).

Prior verification (`passed`, 5/5 at `8ea4bc1d` uncommitted tree) is superseded: `git diff 8ea4bc1d HEAD -- packages/` is exactly the four Phase 85 implementation files; no code drift since that pass.

## Criterion verdicts

| # | Criterion | Verdict | Evidence (file:line at HEAD `955cc206`) |
|---|---|---|---|
| 1 | E4 namespace/permission/audit: `agent:<surface>` + Phase 72 allowlist fail-closed + one audit note per delegation; denials store nothing | **passed** | `orchestration.ts:40` `agentNamespace` returns `` `agent:${surface}` ``. `orchestration.ts:49` `checkDelegationPermission` requires both sessions granted the repo via `allowlistFor`; `allowlist.size === 0` → `empty-allowlist` (fail-closed); never throws. `orchestration.ts:83` `buildDelegation` reuses `buildHandoff` with receiver as the `to` party. `orchestration.ts:108` `recordDelegationAudit` appends one row via `DelegationAuditPort`. `service.ts:4430` `delegateHandoff` parses `repoAllowlistFromEnv` (unparseable → empty), returns `not-allowed` when `from.session_id` is missing, checks permission before `this.handoff(...)`, and only when `result.stored` emits one `kind: "note"` event with `payload.delegation` carrying the namespace/from/to/repo/`handoff_id` (`.catch(() => null)` — fail-open audit). `service-orchestration.test.ts` pins: granted stores 1 handoff + 1 audit note with namespace; denied and empty-allowlist store nothing. `orchestration.test.ts:20,27,55` pins namespace, allow/deny/empty, packet receiver, one audit row. |
| 2 | E7 fence: stale-epoch / not-holder rejection, write fn never runs on rejection | **passed** | `orchestration.ts:151` `LeaderFence.acquire` wraps `decideClaim`; `orchestration.ts:180` `renew` wraps `decideHeartbeat` and maps `not-holder` through. Token `{lease_id, epoch, observed_epoch}` issued on grant and on renewal. `orchestration.ts:192` `assertFresh` is the epoch CAS: holder mismatch (`surface`/`session_id`) → `not-holder`; `token.epoch !== current.epoch \|\| token.lease_id !== current.lease_id` → `stale-epoch`; no hold → `unheld`. `orchestration.ts:202` `fencedWrite` returns the denial before calling `fn`. `service.ts:4505` `fenceAcquire` audits one `note` on grant. `orchestration.test.ts:100-182` pins stranger-while-held denied (`held-not-holder`), renew keeps epoch, TTL-expiry epoch bump makes the old token `stale-epoch`, stranger token `not-holder`, and in both rejection cases the write spy never runs. |
| 3 | TTL 900s + DLQ: expired → `ttl-expired`, failed → `failed`, never silently dropped | **passed** | `orchestration.ts:244` `DelegationQueue.enqueue` stamps `ttl_seconds` defaulting to `DEFAULT_LEASE_TTL_SECONDS` = 900s (`lease.ts:42`); duplicate ids throw. `orchestration.ts:255` `dequeue` returns non-expired FIFO and moves expired to the dead list with reason `ttl-expired`. `orchestration.ts:268` `fail` moves a task there with reason `failed`; unknown id → `false`. `orchestration.ts:278` `listDead` + `deadCount` + `pendingCount` are the list surface; `service.ts:4497` `queueDeadLetters` exposes `{dead_letters, dead_count}`. `orchestration.test.ts:194` pins `ttl_seconds === 900` and `expires_at === NOW + 900_000`, FIFO, expiry-to-DLQ, fail-to-DLQ; `service-orchestration.test.ts:109` pins TTL expiry surfacing via `queueDeadLetters()` with the count. |
| 4 | No surface drift: `EVENT_KINDS` = 12, no new store/tool/admission | **passed** | `types.ts:69` `EVENT_KINDS` is the closed 12-element tuple (`session.start … warning`), unchanged. `bun run check:phase-close` reports `EVENT_KINDS unchanged at 12 against ab62c91; SURFACES equals baseline plus substrate at 42`. `git show --stat HEAD` touches only the 4 implementation files + phase docs: no `types.ts`, `mcp.ts`, `server.ts`, store, or admission change. `orchestration.ts` is pure (no I/O; header comment at `orchestration.ts:1` states the fence/queue are in-process memory, audited through the ledger) — no new coordination store or table. |
| 5 | Loop green: focused + regression + tsc + lint + phase-close | **passed** | `bun test orchestration.test.ts service-orchestration.test.ts` — **24 pass, 0 fail** (83 expects). `bun test service-orchestration.test.ts handoff.test.ts session-registry.test.ts` — **46 pass, 0 fail** (257 expects: 5 + 30 + 11). `bun test service.test.ts service-forget.test.ts` — **445 pass, 0 fail** (2112 expects). `bunx tsc --noEmit` — clean. `bun run lint` — clean (1904 files, biome). `bun run check:phase-close` — **pass** (239 pass, 4 lock files). |

## Gaps / regressions

None. Prior pass recorded no gaps; this re-verification found no regressions at HEAD `955cc206`.

## Behavior unverified (1, human-needed)

Live-ledger writes — see frontmatter `behavior_unverified_items`. Fake-only by phase doctrine; the live wiring has never run against a real ledger in this phase.

## Notes

- Test-count note vs the prior pass: the regression combo now reads 46 pass (5 service-orchestration + 30 handoff + 11 session-registry), not 65 — the prior report's arithmetic overstated the same files; the fresh run above is authoritative. The focused loop (24) and touched suites (445) match the prior pass exactly.
- Deferred (out of scope, per CONTEXT): fair-queue priorities beyond TTL expiry; CLI `substrate handoff`/`substrate queue` surfaces reusing existing commands in a later phase (no new MCP tool here).
