---
phase: "21"
slug: "skills-propose"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
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

Plan and task ids are the six-plan split's (21-01 … 21-06); each row maps a SKILL-01 behaviour to the automated command that proves it.

| Task ID | Plan | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | Status |
|---------|------|-------------|------------|-----------------|-----------|-------------------|--------|
| engine | 21-01 T2 | SKILL-01 SC1 | T-21 git | No argv has a force flag, colon refspec or search query; the origin is checked before the push; the PR URL slug is checked; the child env is the allowlist | unit | `bun test ./packages/mcp-server/src/skills/propose.test.ts` | ✅ green |
| engine-git | 21-01 T2 | SKILL-01 SC1 | T-21 git | Real git with a fake-gh runner on a temp bare repo: `opened`, branch present, no non-fast-forward reflog entry | integration | `bun test ./packages/mcp-server/src/skills/propose.git.test.ts` | ✅ green |
| refusals | 21-01 T2 | SKILL-01 SC2 | T-21 input | A bad name, path or frontmatter, NUL, cap, remove rules and a planted secret are refused before any Runner call; findings are `{file,line,rule}` with no value | unit | `bun test ./packages/mcp-server/src/skills/propose.test.ts` | ✅ green |
| dedupe | 21-01 T2 | SKILL-01 SC2 | n/a | `existing`, `declined`, `unchanged`; `pushed` re-found; concurrent identical proposals give one `gh pr create` | unit | `bun test ./packages/mcp-server/src/skills/propose.test.ts` | ✅ green |
| config | 21-01 T3 | SKILL-01 | T-21 cred | Defaults; non-default only with `file://` and an absolute `gh`; an invalid combination warns and refuses without crashing | unit | `bun test ./packages/mcp-server/src/config.test.ts` | ✅ green |
| auth | 21-02 T1, 21-03 T1 | SKILL-01 SC3 | T-21 authn | Anonymous is 401 (route), an `isError` reply (MCP) and exit 1 (CLI); a surface mismatch and operator-only options are 403; no proposer call | unit, socket | `bun test ./packages/mcp-server/src/service.test.ts ./packages/mcp-server/src/http.test.ts ./packages/mcp-server/src/mcp.test.ts ./packages/cli/src/skills.test.ts` | ✅ green |
| codes | 21-03 T1 | SKILL-01 | T-21 dos | 200 per status; 400 with findings; 413 oversize; 502 redacted to 400 characters; 503 on audit denial | socket | `bun test ./packages/mcp-server/src/http.test.ts ./packages/mcp-server/src/skills/request.test.ts` | ✅ green |
| registration | 21-03 T2 | SKILL-01 SC3 | T-21 audit | `skills_propose` in `listTools`, `KNOWN_TOOLS`, `KNOWN_ROUTES` and explicitly in `FAIL_CLOSED_TOOLS`; the route is audited under its own name | unit | `bun test ./packages/mcp-server/src/mcp.test.ts ./packages/mcp-server/src/observe.test.ts ./packages/audit/src/policy.test.ts` | ✅ green |
| events | 21-02 T1, T2 | SKILL-01 | T-21 leak | The note, the refused warning and the failed warning match the `EVENT_SOURCES` rows; none on dry run, 403, malformed or anonymous; a failed or throwing emit never changes the answer | unit | `bun test ./packages/mcp-server/src/service.test.ts ./packages/mcp-server/src/event-sources.test.ts` | ✅ green |
| cli | 21-04 T1, T2 | SKILL-01 SC1 | T-21 input | `readSkillDir` refusals, the 1 MB cap, flag mapping, exit codes and the token header, against a stub server and as a spawned command | unit | `bun test ./packages/cli/src/skills.test.ts` | ✅ green |
| harness | 21-05 T1 | SKILL-01 | T-21 isolation | `SUBSTRATE_SKILLS_STATE` is always inside the run dir; fixture keys only with `--skills-fixture` and only inside the run dir; the fixture has the deny settings, `logAllRefUpdates` and the mirror refspec; the fake `gh` answers three questions and refuses the rest | unit | `bun test ./packages/mcp-server/src/rehearsal-skills.test.ts ./packages/mcp-server/src/rehearsal-env.test.ts ./scripts/rehearsal.test.ts` | ✅ green |
| locks | all | SKILL-01 | T-21 leak | No `GREPTIME_` outside mcp-server, no second redactor, the vocabulary unchanged | repo | `bun run check:phase-close` and `bun test ./packages/mcp-server/src/redact-lock.test.ts` | ✅ green |
| proof | 21-05 T2, T3 | SKILL-01 SC1–3 | all | The smoke's checks (a) to (f) over the wire against a fixture twin, with real git | live-isolated | `bun run rehearsal up --name p21 --skills-fixture`, `bun run smoke:skills-propose`, `bun run rehearsal down --name p21` | ✅ green (47/47) |
| docs | 21-06 T1 | SKILL-01 | n/a | The contract doc names the same four keys and the `file://` rule `config.ts` enforces | review | `docs/skills-propose.md`, the pointers in `docs/rehearsal.md`, `docs/mcp-audit.md`, `docs/event-vocabulary.md` and `.env.example` | ✅ done |

*Status: ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `packages/mcp-server/src/skills/propose.test.ts`: the September port. It assembles the JWT and token fixtures at runtime and adds the library, env-allowlist, missing-mirror and commit-message cases.
- [x] `packages/mcp-server/src/skills/propose.git.test.ts`: the engine against real git, using the fixture builder.
- [x] `packages/mcp-server/src/config.test.ts`: the skills block.
- [x] `packages/mcp-server/src/rehearsal-skills.test.ts`: the fixture builder and the fake `gh`.
- [x] `packages/cli/src/skills.test.ts`: `readSkillDir`, the cap, flags and exit codes, plus one spawn against a stub server.
- [x] `scripts/skills-propose-smoke.test.ts`: the smoke's pure helpers.
- [x] New describes in `http.test.ts` (the route tests live there), `skills/request.test.ts`, `mcp.test.ts`, `service.test.ts`, `observe.test.ts`, `policy.test.ts`, `event-sources.test.ts`, `rehearsal-env.test.ts` and `scripts/rehearsal.test.ts`.
- No framework install is needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| A real PR on `swcstudiospace/agent-skills` through production `gh` | SKILL-07 (Phase 22) | It is a live GitHub write on another repo, which needs operator approval and belongs to Phase 22's live proof | None in this phase |

*Every Phase 21 behaviour has an automated check. The live PR is Phase 22's.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 120s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-10-09 by the orchestrator. Every Phase 21 behaviour has an automated check that passed in the final run (tsc 0; full suite 1851 pass / 57 skip / 0 fail; smoke 47/47). The live PR on `agent-skills` is Phase 22's.
