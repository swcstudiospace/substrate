---
phase: 20-production-identity-and-phase-0-uat
verified: 2026-11-12T08:25:20Z
status: human_needed
score: 3/6 must-haves verified (3 human_needed: operator-gated live proofs; 0 gaps)
covered_files: [".planning/milestones/v1.0-phases/00-brief/0-UAT.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-01-PLAN.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-01-SUMMARY.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-02-PLAN.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-02-SUMMARY.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-03-PLAN.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-03-SUMMARY.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-04-PLAN.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-04-SUMMARY.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-05-PLAN.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-05-SUMMARY.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-06-PLAN.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-06-SUMMARY.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-UAT.md", "docs/runbooks/production-identity.md", "docs/uat.md", "infra/identity/clients.json", "packages/cli/src/cli-auth.test.ts", "packages/cli/src/token.test.ts", "packages/cli/src/token.ts", "packages/collectors/src/emit.ts", "packages/mcp-server/src/authority.test.ts", "packages/mcp-server/src/boot-refusal.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/server.authority.test.ts", "scripts/identity-check.test.ts", "scripts/identity-check.ts", "scripts/parity-check.test.ts", "scripts/parity-check.ts", "scripts/uat-phase0.test.ts", "scripts/uat-phase0.ts"]
covered_digest: "v3:sha256:1b27eb8e013475942bdae2ce5c019e7cabca167f60d0426cc0f8df46072981f7"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 22/22
  gaps_closed: []
  gaps_remaining: []
  regressions: []
---

# Phase 20: Production Identity and Phase 0 UAT — Verification

**Phase Goal:** Every client of production `substrate-mcp` is identified by its own token, and the eight Phase 0 brief scenarios pass against `main` with fresh evidence.
**Status:** human_needed. No gaps. No `*-SECURITY.md` exists in the phase dir, so no threat-gate blocker applies.

Why not `passed`: the roadmap's Proof for this phase requires an operator-approved live window (token switch-on; production scenarios 1, 2, 3, 5, 6). None of that has run. Operator-gated checks are `human_needed`. The prior report (2026-10-11, `passed`, 22/22) counted those rows as verified; this report does not.

## Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Per-surface tokens: list-form entries each authenticate; joined string is 401 | ✓ VERIFIED | `packages/mcp-server/src/server.authority.test.ts`, `authority.test.ts`, `config.ts` (ran: pass, in 233-pass run) |
| 2 | Boot refuses with exit 78, naming variables and never values | ✓ VERIFIED | `packages/mcp-server/src/boot-refusal.test.ts` (ran: pass); `infra/vps/substrate-mcp.service:32` `RestartPreventExitStatus=78` |
| 3 | Resolver env → token-file → tokens-dir, fail-open, never logs values; herdr emits under its own surface token | ✓ VERIFIED | `packages/cli/src/token.ts`, `token.test.ts`, `cli-auth.test.ts` (ran: pass); `packages/collectors/src/emit.ts` (emit tests not re-run this pass) |
| 4 | Runbook lists every client with its token; names only in repo; no client stranded at switch-on | ⏳ HUMAN_NEEDED | Manifest and names verified: `infra/identity/clients.json` (64 clients); `bun run identity:check` → exit 0, `[identity:check] PASS`, 44/44 server names. Switch-on (values mode, restart) not run. Dormant rows `skills-sync`, `bridge`, `miner`, `anchor` report `missing — unreadable` (env files not provisioned; their phases are later) |
| 5 | Scenario 5: Claude Code `substrate` MCP entry names its token; `ultrathink-kickoff` calls `graph_register` | ⏳ HUMAN_NEEDED | Code exists locally on branch `gsd/v1.3-p20-identity-uat` at `9006476` / `978ce72` in `/root/src/repos/claude-ultrathink`, not pushed, no PR. Not re-run here. Production scenario 5 not run |
| 6 | Scenario 6: Cursor hooks incl. `stop` and git post-commit installed and emit live | ⏳ HUMAN_NEEDED | Harness-fresh 6/6 on synthetic envelopes (`20-UAT.md`, run `uat-p2006fresh`). Real Cursor session and production hook installs not run. `git-hook cursor` row reports `not-installed ok` |

**Score:** 3/6 verified (truths 1–3); 3 human_needed (4–6).

## Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `packages/mcp-server/src/config.ts` | ✓ VERIFIED | Token config present; related tests pass |
| `packages/cli/src/token.ts` (+test) | ✓ VERIFIED | `token.test.ts` pass |
| `packages/cli/src/cli-auth.test.ts` | ✓ VERIFIED | Pass |
| `packages/collectors/src/emit.ts` | ✓ PRESENT | Per-event surface token per prior report; emit tests not re-run this pass |
| `scripts/parity-check.ts` (+test) | ✓ VERIFIED | `parity-check.test.ts` present; not run individually this pass (see Not Run) |
| `infra/identity/clients.json` | ✓ VERIFIED | 64 clients, names only; `identity:check` PASS |
| `scripts/identity-check.ts` (+test) | ✓ VERIFIED | Live names-only run exit 0 |
| `docs/runbooks/production-identity.md` | ✓ PRESENT | Not linted this pass |
| `scripts/uat-phase0.ts` (+test) | ✓ VERIFIED | Pass in 233-pass set; 6/6 harness evidence in `20-UAT.md` |
| `docs/uat.md` | ✓ PRESENT | Not separately checked |
| `20-UAT.md` + `milestones/v1.0-phases/00-brief/0-UAT.md` | ✓ PRESENT | Harness evidence recorded; production rows marked live-gated |

## Key Links

| From | To | Via | Status |
|------|----|-----|--------|
| token resolver | CLI / collectors / parity / UAT | `packages/cli/src/token.ts` | ✓ WIRED (per prior grep; not re-grepped this pass) |
| manifest | runbook table | `identity-check` row locks | ✓ WIRED (identity-check tests pass) |
| UAT script | target `SUBSTRATE_URL` | `scripts/uat-phase0.ts` guards | ✓ WIRED (uat tests pass; live refusals covered in test) |

## Requirements Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| FOUND-04 | ⏳ HUMAN_NEEDED | Names, tokens and resolver verified; switch-on with operator approval not run |
| UAT-01 | ⏳ HUMAN_NEEDED | 6/8 scenarios pass in harness; production scenarios 1, 2, 3, 5, 6 (8 optional) not run |
| UAT-02 | ✓ SATISFIED | Repeatable guarded script; `scripts/uat-phase0.test.ts` pass |
| UAT-03 | ⏳ HUMAN_NEEDED | Code on local branch only; PR, merge and production proof pending |
| UAT-04 | ⏳ HUMAN_NEEDED | Harness-only; real session and installs pending |

`.planning/milestones/v1.3-REQUIREMENTS.md` still lists FOUND-04 and UAT-01…04 as `Pending`, consistent with this status. No orphaned requirements.

## Anti-Patterns

No TBD/FIXME/XXX blockers found in the phase's covered test/script files. No stubs. This pass did not grep every covered file, so the scan is partial.

## Human Verification Required (operator window — not run here)

1. **Token switch-on:** `identity:check --values`, provision the listed names, one restart of `substrate-mcp`, 30-minute soak. Confirms truth 4 and FOUND-04.
2. **Production UAT:** `bun run uat:phase0 --live <approval-ref>` for scenarios 1, 2, 3, 5, 6 (8 optional). Confirms truths 5 and 6 and UAT-01.
3. **claude-ultrathink:** push `gsd/v1.3-p20-identity-uat`, open PR, merge, refresh plugin, run the MCP entry writer. Confirms truth 5 and UAT-03.

## Not Run in This Pass

- Full `bun test`, `bunx tsc --noEmit`, `check:phase-close`.
- `claude-ultrathink` test suite.
- Production UAT scenarios and any live identity mutation (operator-gated).

## Gaps Summary

None. Every must-have is either verified or routed to human verification. `gaps: []`.

## Notes

- Verified this pass: `bun test` on 8 identity files (`token`, `cli-auth`, `authority`, `server.authority`, `boot-refusal`, `identity-check`, `parity-check`, `uat-phase0`): 233 pass, 0 fail.
- `bun run identity:check`: exit 0, PASS.
- Prior GAP-20-01 (missing clone worktree) is resolved as a local ref: `/root/src/worktrees/claude-ultrathink-p20` exists on `gsd/v1.3-p20-identity-uat` at `9006476`. Still unpushed.
