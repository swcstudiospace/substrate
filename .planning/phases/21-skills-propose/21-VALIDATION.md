---
phase: "21"
slug: "skills-propose"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-10-08"
---

# Phase 21 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `bun:test` (Bun 1.4.0); typecheck with `bunx tsc --noEmit` |
| **Config file** | none (`package.json` `"test": "bun test"`); `tsconfig.json` |
| **Quick run command** | `bun test ./packages/mcp-server/src/skills/propose.test.ts` (and each touched test file, one file per invocation) |
| **Full suite command** | `bun test && bunx tsc --noEmit` (record the execution base's own numbers first, per D21-23; the v1.3 baseline at `ab62c91` was 1129 pass / 56 skip / 0 fail, tsc clean) |
| **Estimated runtime** | quick about 3 s; full about 120 s; harness proof about 90 s |

---

## Sampling Rate

- **After every task commit:** run each touched test file on its own, then `bunx tsc --noEmit`.
- **After every plan wave:** run `bun test && bunx tsc --noEmit`.
- **Before `/gsd:verify-work`:**
  - the full suite is green against the base, with only new passes;
  - `store-lock.test.ts` and `redact-lock.test.ts` are green;
  - `bun run check:phase-close` exits 0;
  - the harness proof chain has run: `rehearsal up --name p21 --skills-fixture` → `smoke:skills-propose` → `rehearsal down --name p21`;
  - afterwards no container carries `substrate.rehearsal=p21` and the run directory is gone.
- **Max feedback latency:** 120 seconds.

---

## Per-Task Verification Map

Task IDs are assigned by the plans; each row maps a SKILL-01 behaviour to its automated command.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| engine | 01 | 1 | SKILL-01 SC1 | T-21 git | No argv has a force flag, colon refspec or search query; the origin is checked before the push; the PR URL slug is checked; child env is the allowlist | unit | `bun test ./packages/mcp-server/src/skills/propose.test.ts` | ❌ W0 | ⬜ pending |
| engine-git | 01 | 1 | SKILL-01 SC1 | T-21 git | Real git with a fake-gh runner on a temp bare repo: `opened`, branch present, no non-fast-forward reflog entry | integration | `bun test ./packages/mcp-server/src/skills/propose.git.test.ts` | ❌ W0 | ⬜ pending |
| refusals | 01 | 1 | SKILL-01 SC2 | T-21 input | Bad name, path or frontmatter, NUL, cap, remove rules and a planted secret are refused before any Runner call; findings are `{file,line,rule}` and carry no value | unit | `bun test ./packages/mcp-server/src/skills/propose.test.ts` | ❌ W0 | ⬜ pending |
| dedupe | 01 | 1 | SKILL-01 SC2 | — | `existing`/`declined`/`unchanged`; `pushed` re-found; concurrent identical proposals give one `gh pr create` | unit | `bun test ./packages/mcp-server/src/skills/propose.test.ts` | ❌ W0 | ⬜ pending |
| config | 01 | 1 | SKILL-01 | T-21 cred | Defaults; non-default only with `file://` and an absolute `gh`; an invalid combination warns and refuses proposals without crashing | unit | `bun test ./packages/mcp-server/src/config.test.ts` | ❌ W0 | ⬜ pending |
| auth | 02 | 2 | SKILL-01 SC3 | T-21 authn | Anonymous gets 401 (route), `isError` (MCP), exit 1 (CLI); surface mismatch and operator-only options get 403; no proposer call | unit/socket | `bun test ./packages/mcp-server/src/server.test.ts` and `bun test ./packages/mcp-server/src/mcp.test.ts` | ✅ (new describes ❌) | ⬜ pending |
| codes | 02 | 2 | SKILL-01 | T-21 dos | 413 oversize, 502 redacted ≤ 400 chars, 503 audit denial | socket | `bun test ./packages/mcp-server/src/server.test.ts` | ✅ (new describes ❌) | ⬜ pending |
| registration | 02 | 2 | SKILL-01 SC3 | T-21 audit | `skills_propose` in `listTools`, `KNOWN_TOOLS`, `KNOWN_ROUTES`, explicitly in `FAIL_CLOSED_TOOLS` | unit | `bun test ./packages/mcp-server/src/observe.test.ts` and `bun test ./packages/audit/src/policy.test.ts` | ✅ (new tests ❌) | ⬜ pending |
| events | 02 | 2 | SKILL-01 | T-21 leak | note / refused warning / failed warning match the `EVENT_SOURCES` rows; none on dry_run, 403, malformed or anonymous; a failed emit never changes the answer | unit | `bun test ./packages/mcp-server/src/service.test.ts` and `bun test ./packages/mcp-server/src/event-sources.test.ts` | ✅ (new tests ❌) | ⬜ pending |
| cli | 03 | 2–3 | SKILL-01 SC1 | T-21 input | `readSkillDir` refusals, the 1 MB cap, flag mapping, exit codes, token header, against a stub server | unit | `bun test ./packages/cli/src/skills.test.ts` | ❌ W0 | ⬜ pending |
| harness | 04 | 3 | SKILL-01 | T-21 isolation | `SUBSTRATE_SKILLS_STATE` is always set to the run dir; fixture keys only with `--skills-fixture`; the fixture has deny settings, `logAllRefUpdates` and the mirror refspec; fake gh transitions | unit | `bun test ./packages/mcp-server/src/rehearsal-env.test.ts` and `bun test ./packages/mcp-server/src/rehearsal-skills.test.ts` | ✅ / ❌ W0 | ⬜ pending |
| locks | all | all | SKILL-01 | T-21 leak | No `GREPTIME_` outside mcp-server, no second redactor | repo | `bun test ./packages/mcp-server/src/store-lock.test.ts` and `bun test ./packages/mcp-server/src/redact-lock.test.ts` | ✅ (redact-lock from Phase 18) | ⬜ pending |
| proof | 04 | 3 | SKILL-01 SC1–3 | all | D21-22 (a)–(f) over the wire against the harness twin | live-isolated | `bun run rehearsal up --name p21 --skills-fixture && bun run smoke:skills-propose; bun run rehearsal down --name p21` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/mcp-server/src/skills/propose.test.ts`: the September port. It assembles the JWT and token fixtures at runtime and adds the library, env-allowlist, missing-mirror and commit-message cases.
- [ ] `packages/mcp-server/src/skills/propose.git.test.ts`: the engine against real git, using the fixture builder.
- [ ] `packages/mcp-server/src/config.test.ts`: the skills block.
- [ ] `packages/mcp-server/src/rehearsal-skills.test.ts`: the fixture builder and the fake `gh`.
- [ ] `packages/cli/src/skills.test.ts`: `readSkillDir`, the cap, flags and exit codes, plus one spawn against a stub server.
- [ ] `scripts/skills-propose-smoke.test.ts`: the smoke's pure helpers.
- [ ] New describes in `server.test.ts`, `mcp.test.ts`, `service.test.ts`, `observe.test.ts`, `policy.test.ts`, `event-sources.test.ts`, `rehearsal-env.test.ts` and `scripts/rehearsal.test.ts`.
- No framework install is needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| A real PR on `swcstudiospace/agent-skills` through production `gh` | SKILL-07 (Phase 22) | It is a live GitHub write on another repo, which needs operator approval and belongs to Phase 22's live proof | None in this phase |

*Every Phase 21 behaviour has an automated check. The live PR is Phase 22's.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
