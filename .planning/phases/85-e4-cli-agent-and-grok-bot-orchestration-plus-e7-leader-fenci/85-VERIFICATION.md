---
phase: 85-e4-cli-agent-and-grok-bot-orchestration-plus-e7-leader-fenci
verified: 2026-11-28T09:07:28Z
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
  previous_status: none
  previous_score: none
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 85 Verification: E4 CLI Agent and Grok Bot orchestration plus E7 Leader fencing

**Verified:** 2026-11-28T09:07:28Z
**Worktree:** `/tmp/agent-substrate-wave8`
**HEAD:** `8ea4bc1d` (uncommitted tree per `git status --porcelain`; no commit, per assignment)
**Scope:** Goal-backward verification against `85-CONTEXT.md` + `85-PLAN.md` (3 tasks). Read-only; no product code, STATE, or ROADMAP edits. This verifier re-ran the focused loop (`orchestration.test.ts` + `service-orchestration.test.ts`: 24 pass / 0 fail), `bunx tsc --noEmit`, `bun run lint`, and `bun run check:phase-close`, and edited nothing outside this file.

## Verdict summary

**Status: `passed`** — all five must-haves hold in code and tests at current HEAD. Delegation handoffs are namespaced `agent:<surface>` with Phase 72 allowlist permission checked fail-closed and one audit note per delegation; denials store nothing. The leader fence issues `{lease_id, epoch, observed_epoch}` tokens, rejects stale epochs for the same holder after a TTL bump and strangers as `not-holder`, and never runs the write function on rejection. The delegation queue uses a 900s default TTL, moves expired entries to the dead-letter list with reason `ttl-expired` and failed entries with reason `failed` (never silently dropped), surfaced via `queueDeadLetters`. No new store/tool/admission change; `EVENT_KINDS` unchanged at 12. The loop is green. One behavior-unverified item: the production ledger wiring (fake-only doctrine), recorded above.

## Criterion verdicts

| # | Criterion | Verdict | Evidence (file:line at HEAD) |
|---|---|---|---|
| 1 | Namespace `agent:<surface>` + permission via Phase 72 allowlist fail-closed + audit note per delegation; denials store nothing | **passed** | `orchestration.ts:40` `agentNamespace` returns `agent:${surface}`. `orchestration.ts:49` `checkDelegationPermission` requires both sessions granted the repo via `allowlistFor`; `allowlist.size === 0` → `empty-allowlist` (fail-closed); never throws. `orchestration.ts:83` `buildDelegation` reuses `buildHandoff` with receiver as the `to` party. `orchestration.ts:108` `recordDelegationAudit` appends one row via `DelegationAuditPort`. `service.ts:4430` `delegateHandoff` parses allowlist from env (`repoAllowlistFromEnv`, parse failure → empty → deny), checks permission before any store, routes through `this.handoff`, then appends one fail-open `note` (payload `delegation`). Tests: granted → 1 handoff + 1 audit note with namespace; denied → `emitted` length 0; empty allowlist → deny, `emitted` length 0 (`service-orchestration.test.ts:53-86`). |
| 2 | Fence token `{lease_id, epoch, observed_epoch}`; stale epoch rejected for same holder after TTL bump; stranger `not-holder`; write fn not run on reject | **passed** | `orchestration.ts:145` `LeaderFence` per-worktree `LeaseSnapshot`; `acquire` wraps `decideClaim` (`lease.ts:218`), `renew` wraps `decideHeartbeat` (`lease.ts:312`), token minted with `observed_epoch` (`orchestration.ts:171`). `orchestration.ts:193` `assertFresh`: holder mismatch → `not-holder`; `token.epoch !== current.epoch` → `stale-epoch` (epoch CAS). `orchestration.ts:202` `fencedWrite` returns the denial before calling `fn`. Tests: stranger while held → `held-not-holder`; renew keeps epoch; after TTL expiry new acquire bumps epoch, old token → `stale-epoch` with write fn never run (`orchestration.test.ts:117,146-172`); service-level stale write rejected (`service-orchestration.test.ts:125`). |
| 3 | TTL 900s default; expired → `listDead` `ttl-expired`; `fail()` → `failed`; never dropped; surfaced via `queueDeadLetters` | **passed** | `orchestration.ts:240` `DelegationQueue`; `enqueue` stamps 900s TTL (`DEFAULT_LEASE_TTL_SECONDS`, `orchestration.ts:244`); `dequeue` moves expired to dead list with `reason: "ttl-expired"` (`orchestration.ts:259`); `fail` moves with `reason: "failed"` (`orchestration.ts:273`); `listDead`/`deadCount`/`pendingCount` (`orchestration.ts:278-286`). `service.ts:4497` `queueDeadLetters` returns `{dead_letters, dead_count}`. Tests: expired entries surface in `queueDeadLetters` with count and `reason: "ttl-expired"` (`service-orchestration.test.ts:98-109`); `deadCount()` matches `listDead().length`. |
| 4 | No new store/tool/admission change; `EVENT_KINDS` unchanged at 12 | **passed** | `types.ts:69` `EVENT_KINDS` is the 12-kind list; `service.ts:4430-4526` adds `delegateHandoff`/`enqueueDelegation`/`dequeueDelegations`/`queueDeadLetters`/`fenceAcquire`/`fenceRenew`/`fenceWrite` on `Substrate` with owned `delegationQueue`/`leaderFence` (`service.ts:1709-1710`); no new MCP tool, no admission/route-policy change. `check:phase-close` re-run: **pass** — EVENT_KINDS unchanged at 12 against `ab62c91`; SURFACES baseline + substrate at 42. Audit events reuse kind `note` (payload `delegation`), so no vocabulary change. |
| 5 | Loop green: 24/0, tsc/lint/phase-close | **passed** | Re-run by this verifier at HEAD: `bun test packages/mcp-server/src/orchestration.test.ts packages/mcp-server/src/service-orchestration.test.ts` → **24 pass, 0 fail** (83 expects). `bunx tsc --noEmit` clean (exit 0). `bun run lint` clean (1903 files, exit 0). `bun run check:phase-close` pass (239 pass, 4 lock files; EVENT_KINDS unchanged at 12). Matches `85-SUMMARY.md:14-19`. |

## Decision coverage

All four `85-CONTEXT.md` Implementation Decisions are honored:

| Decision | Status | Evidence |
|---|---|---|
| Handoff packet: reuse signed `coord_handoff` + namespace (`agent:<surface>`) + permission model (Phase 72 allowlist) | honored | `orchestration.ts:40,49,83`; `service.ts:4430` |
| E7 fencing: `leaderFence.acquire` issues a fencing token on lease renewal (`lease_id` + epoch CAS); stale tokens rejected — single-writer guaranteed | honored | `orchestration.ts:145-202`; token shape `:131` |
| TTL queueing + DLQ: default 900s lease TTL; expired/dead entries move to dead-letter surface (count + list), never silently dropped | honored | `orchestration.ts:240-286`; `service.ts:4497` `queueDeadLetters` |
| Audit: every handoff/fence event appended to ledger with actor/surface/session attribution | honored | `service.ts:4430` delegation `note` (namespace, from/to, repo, handoff_id); `service.ts:4505` fence-acquire `note` (holder, epoch) |

## Gaps

None blocking.

## Notes

- Deferred per CONTEXT and correctly absent: fair-queue priorities beyond TTL expiry; CLI `substrate handoff`/`substrate queue` surfaces reuse existing commands in a later phase (no new MCP tool here). `85-SUMMARY.md:21-23`.
- Fail-closed holds: empty/unparseable allowlist denies every delegation (`service.ts` parse failure → `EMPTY_REPO_ALLOWLIST`); unknown session denies (`not-allowed`); permission check precedes any store, so denials emit nothing.
- `fencedWrite` is check-then-run within the returned promise; the fence is in-memory per `Substrate` instance (no new coordination store, per CONTEXT).

_Verified: 2026-11-28T09:07:28Z — Verifier: GSD verifier, HEAD 8ea4bc1d_
