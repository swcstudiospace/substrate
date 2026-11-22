---
phase: 21-skills-propose
verified: 2026-11-18T00:00:00Z
status: human_needed
score: 2/3 roadmap success criteria verified in code and tests; SC1 live-PR leg needs a human
covered_files: [".planning/milestones/v1.3-phases/21-skills-propose/21-01-PLAN.md", ".planning/milestones/v1.3-phases/21-skills-propose/21-01-SUMMARY.md", ".planning/milestones/v1.3-phases/21-skills-propose/21-02-PLAN.md", ".planning/milestones/v1.3-phases/21-skills-propose/21-02-SUMMARY.md", ".planning/milestones/v1.3-phases/21-skills-propose/21-03-PLAN.md", ".planning/milestones/v1.3-phases/21-skills-propose/21-03-SUMMARY.md", ".planning/milestones/v1.3-phases/21-skills-propose/21-04-PLAN.md", ".planning/milestones/v1.3-phases/21-skills-propose/21-04-SUMMARY.md", ".planning/milestones/v1.3-phases/21-skills-propose/21-05-PLAN.md", ".planning/milestones/v1.3-phases/21-skills-propose/21-05-SUMMARY.md", ".planning/milestones/v1.3-phases/21-skills-propose/21-06-PLAN.md", ".planning/milestones/v1.3-phases/21-skills-propose/21-06-SUMMARY.md", "docs/skills-propose.md", "packages/audit/src/policy.test.ts", "packages/audit/src/policy.ts", "packages/cli/src/skills.test.ts", "packages/cli/src/skills.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/skills/propose.git.test.ts", "packages/mcp-server/src/skills/propose.test.ts", "packages/mcp-server/src/skills/propose.ts", "scripts/skills-propose-smoke.test.ts", "scripts/skills-propose-smoke.ts"]
covered_digest: "v3:sha256:3181680de17689e34e12b829cff405dfb7cc05bce3b00e17293644c616b8e920"
behavior_unverified: 0
overrides_applied: 0
gaps: []
human_verification:
  - test: "Propose one valid test skill through `substrate skills propose --dir <dir>` (or POST /skills/propose) from a configured surface token against the production library swcstudiospace/agent-skills, then inspect the PR."
    expected: "status=opened; the PR targets main; branch matches skill/<surface>/<name>-<ts>-<hex>; no force push; the PR is closed or left for owner review afterwards."
    why_human: "Opens a real PR on the production library through production gh and the owner's GitHub credential. This is a live external action; no automated check here performs it. The archived 2026-10-11 record defers the same proof to Phase 22."
re_verification:
  previous_status: passed (archived record, .planning/milestones/v1.3-phases/21-skills-propose/21-VERIFICATION.md, verified at ed696ef)
  note: "Verified again at HEAD 357d6b15. 524 commits separate ed696ef from HEAD. propose.ts, skills/registry.ts and request.ts, mcp.ts, server.ts and observe.ts all changed after the archived record."
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 21: skills_propose Verification Report

**Phase Goal:** Any authenticated surface can propose a skill and get a reviewable PR on `swcstudiospace/agent-skills`, and nothing secret, malformed or duplicate gets through.
**Verified:** 2026-11-18
**Status:** human_needed
**Commit under test:** `357d6b15` (branch `gsd/autonomous-rerun`)

Scope: this run reads the code and runs targeted test files only. The live stack was not run, and no PR was opened. The archived phase record (`.planning/milestones/v1.3-phases/21-skills-propose/21-VERIFICATION.md`) was not edited. Its SUMMARY files are treated as claims and were checked against the code, not trusted.

## Goal Achievement

### Roadmap success criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| SC1 | `skills_propose` over MCP, `POST /skills/propose` and `substrate skills propose` accept a valid skill from a token-authenticated surface and open branch `skill/<surface>/<name>-<ts>-<hex>` with a PR through `gh`, after checking the origin and without force-pushing. | ⚠️ UNCERTAIN (code path VERIFIED; live PR not observed) | Code: `propose.ts` `branchName()` builds `skill/${surface}/${name}-${ts}-${hex}` (ts is an ISO timestamp with separators stripped, hex is 2 random bytes). `proposeSkill()` runs `originMatches(origin, library.repo)` before `pushArgv` (`git push origin <branch>`, no force flag, no refspec colon). `prCreateArgv` runs `gh pr create --repo --head --base main`. MCP: `mcp.ts` `registerTool("skills_propose")` calls `substrate.proposeSkill`. REST: `server.ts` `POST /skills/propose` (about line 2195) calls `substrate.proposeSkill`. CLI: `packages/cli/src/skills.ts` posts to `${url}/skills/propose`. Tests: `bun test` on `propose.test.ts`, `propose.git.test.ts` and `policy.test.ts` gave 126 pass and 0 fail. `propose.git.test.ts` runs against a local bare fixture, with a fake `gh`. `cli/src/skills.test.ts` posts with the token and snake_case keys: 11 pass across the targeted run, 0 fail. Branch shape: `skills-propose-smoke.test.ts` `branchPattern` pins the shape. **Not observed:** a real `gh` call against `swcstudiospace/agent-skills` with the production credential. The `gh` runner is faked in every automated test. Moved to Human Verification. |
| SC2 | A bad name, path or frontmatter is refused, a planted secret is refused after redaction and scan, and identical content resubmitted answers `existing`, `declined` or `unchanged` instead of opening a second PR. | ✓ VERIFIED | `validateProposal()` in `propose.ts` refuses: name not matching `SKILL_NAME_RE` (`^[a-z0-9][a-z0-9-]{0,63}$`); paths that are absolute, contain backslash/NUL/`..`/dot-segment/`__pycache__`/`.pyc`; SKILL.md with no parseable frontmatter, a name that differs from the skill name, or no description (`frontmatter.ts`). Secrets: `scanSkillFiles()` in `redact.ts` returns `findings`, and any finding throws `ProposeRefused`. Redaction also runs on the redacted text before the hash. Free-text fields (`session_id`, `graph_id`, paths, removals) go through `refuseSecretText`. Tests: `propose.test.ts` "refuses a credential in a path, a removal, a session id or a graph id without echoing it", "a ghp_ token shape is refused with a github finding and the refusal never carries it", and "refuses frontmatter that redaction would stop being a string" all pass. Idempotence: the ledger replay in `fromLedger()` returns `existing` when an open PR exists, `declined` for a closed PR the owner has not asked to reopen, and `unchanged` when `git diff --quiet` finds no change. Tests: `propose.git.test.ts` "resubmitting identical content is existing with no second push or PR" (one `gh pr create` only); `propose.test.ts` declined tests at lines 551 and 968; unchanged tests at lines 580–644. |
| SC3 | An anonymous call is refused, and the tool is registered in `mcp.ts`, `observe.ts` and the audit policy. | ✓ VERIFIED | Anonymous: `server.ts` returns 401 on `POST /skills/propose` when `surface === null`, before the body is read. `service.ts` `proposeSkill()` throws `SkillProposalDenied(401)` for a null surface. `mcp.ts` returns an error reply for an anonymous caller: `mcp.test.ts` "an anonymous caller is refused as an error and nothing is proposed" passes. The 401 path on `/skills/propose` is checked by `scripts/skills-propose-smoke.ts` (line 279) and its test file. Registration: `mcp.ts` line 2077 `registerTool("skills_propose")`; `observe.ts` lines 89 and 671 (`KNOWN_TOOLS` and the route list); `packages/audit/src/policy.ts` line 27 (`FAIL_CLOSED_TOOLS`, Phase 21). `admission.ts` line 261 also has `skills_propose: "write"`. `policy.test.ts` line 156 "skills_propose is served on both doors and explicitly fail-closed" passes. |

**Score:** 2/3 criteria VERIFIED. SC1 remains UNCERTAIN until the live PR is observed (see Human Verification).

### Required artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/skills/propose.ts` | Validate, redact, branch, push, PR, ledger | ✓ VERIFIED | 1047 lines; `proposeSkill` main flow matches the documented order (validate → ledger → beforeWork → mirror fetch → clone → write → diff → commit → origin check → push → ledger → gh pr create) |
| `packages/mcp-server/src/server.ts` | `POST /skills/propose`, 401 when anonymous | ✓ VERIFIED | Line 2195–2215 |
| `packages/mcp-server/src/mcp.ts` | `skills_propose` tool | ✓ VERIFIED | Line 2077 |
| `packages/mcp-server/src/observe.ts` | Known tool and route | ✓ VERIFIED | Lines 89, 671 |
| `packages/audit/src/policy.ts` | Fail-closed policy entry | ✓ VERIFIED | Line 27 |
| `packages/cli/src/skills.ts` | `substrate skills propose` | ✓ VERIFIED | Refuses without `SUBSTRATE_TOKEN`; posts to `/skills/propose` |
| `scripts/skills-propose-smoke.ts` | Isolated end-to-end proof | ⚠️ NOT RUN HERE | Its pure helpers pass (`skills-propose-smoke.test.ts`). The smoke itself drives a live twin and was not run in this verification |

### Key link verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `mcp.ts` `skills_propose` | `service.ts` `proposeSkill` | `substrate.proposeSkill(request, {surface, isOperator})` | ✓ WIRED | `mcp.test.ts` skills_propose suite: 11 pass |
| `server.ts` `/skills/propose` | `service.ts` `proposeSkill` | `substrate.proposeSkill(toProposalRequest(...))` | ✓ WIRED | Route code read directly |
| `service.ts` `proposeSkill` | `propose.ts` `proposeSkill` | `skills` proposer seam | ✓ WIRED | `createSkillProposer` binds run and library |
| `cli/skills.ts` | `/skills/propose` | `fetch` with `SUBSTRATE_TOKEN` | ✓ WIRED | `cli/src/skills.test.ts` |
| `propose.ts` push | origin check | `originMatches` before `pushArgv` | ✓ WIRED | Line order confirmed in `proposeSkill` |

### Requirements coverage

| Requirement | Source Plan | Status | Evidence |
|-------------|------------|--------|----------|
| SKILL-01 | Phase 21 plans 01–06 | ⚠️ PARTIAL | SC2 and SC3 verified. SC1 needs the live-PR observation above |

### Anti-patterns scan (phase-owned files)

No `TBD`, `FIXME` or `XXX` markers were found in the files listed above. No `TODO` debt markers were added in this run. Not a blocker.

### Probe execution

No probes are declared for this phase. Skipped.

## Tests run (targeted, at HEAD 357d6b15)

| Command | Result |
|---------|--------|
| `bun test packages/mcp-server/src/skills/propose.test.ts packages/mcp-server/src/skills/propose.git.test.ts packages/audit/src/policy.test.ts` | 126 pass, 0 fail |
| `bun test packages/mcp-server/src/mcp.test.ts -t skills_propose` | 11 pass across the run, 0 fail (`-t` applied to all three files) |
| `bun test packages/cli/src/skills.test.ts scripts/skills-propose-smoke.test.ts packages/mcp-server/src/observe.test.ts` | 128 pass, 0 fail |

Not run: the full suite, `scripts/skills-propose-smoke.ts` (live twin), and the Postgres-gated `invalid-write-roundtrip.test.ts` (`describeLive`, skipped without `PG_URL`).

## Drift since the archived record

The archived record (`verified: 2026-10-11`, at `ed696ef`) says the phase-owned source was byte-identical at that point. Since then, phase 35 (expected-version) and other work have changed `propose.ts` (+24/−6), `skills/registry.ts` (+494), `skills/request.ts`, `mcp.ts`, `server.ts`, `observe.ts` and `policy.ts`, across 524 commits. The targeted tests above were run against HEAD, so this record reflects the current code and not the old snapshot.

## Human Verification Required

### 1. Live proposal to the production library

**Test:** From a configured surface token, run `substrate skills propose --dir <a throwaway test skill>` against `swcstudiospace/agent-skills`.
**Expected:** `status=opened`, the PR targets `main`, branch `skill/<surface>/<name>-<ts>-<hex>`, no force push. Close the PR afterwards unless the owner wants to keep it.
**Why human:** The proof needs the production `gh` and the owner's GitHub credential, and it writes to a shared repository. This is a live external action, which the phase verification rules route to a human. The archived record defers the same proof to Phase 22.

## Gaps Summary

No gaps. No criterion failed in code or tests. SC1 is UNCERTAIN only on its live leg, and that leg needs an operator action.

---

_Verified: 2026-11-18_
_Verifier: Claude (gsd-verifier)_
