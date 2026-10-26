---
phase: 42-skill-card
verified: 2026-10-21
status: human_needed
score: 2 of 2 criteria proven in-repo
verified_on: gsd/v13x-42-skill-card as a merge of origin/main 3466c50 (phase 41 merged) into 786d1ef, which holds the batching commit. Typecheck and full suite run on that merged tree (merge commit 02261d7)
covered_files: ["packages/mcp-server/src/config.ts", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/server.test.ts", "packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/docs-ingest.test.ts", "packages/mcp-server/src/git.ts", "packages/mcp-server/src/service.ts", "packages/mcp-server/src/docs-search.test.ts", "packages/mcp-server/src/docs-plane-hardening.test.ts", ".env.example", "docs/config-reference.md", "docs/data-planes.md", "docs/docs-search-ingest.md"]
---

> Status detail, kept verbatim from the original frontmatter: passed in-repo. The live fast-forward proof is not run (operator-gated)

# 42-VERIFICATION: SKILL-CARD

## Proven in-repo

| Claim | Evidence |
|---|---|
| Typecheck is clean | `bunx tsc --noEmit` exit 0 on the merged tree 02261d7 |
| Full suite passes | `bun test` against the verification Postgres on 02261d7: 5823 pass, 2 skip (`cache-conformance.test.ts:127`, `redact.test.ts:813`, both pre-existing), 0 fail. 5825 tests in 217 files, 148 s, no `ENOSPC`. The config-reference generator and the redaction lock run in the same suite and pass |
| Trigger ingests the agent-skills checkout and records a version | `server.test.ts`: root set, real git checkout |
| Trigger is a truthful no-op when unset | `server.test.ts`: root unset, no uploads |
| Unreadable checkout fails that refresh, pin keeps serving with its age | `server.test.ts` (`checkout-unreadable`); `docs-search.test.ts` |
| A checkout that moved on records no version | `server.test.ts` (`commit-mismatch`); `docs-plane-hardening.test.ts` (queued refresh) |
| An unreadable references directory fails the refresh | `docs-search.test.ts`; `docs-ingest.test.ts` |
| A folder without SKILL.md is not a skill | `docs-ingest.test.ts` |
| Preflight refuses a bad page before any upload, and batches the rest | `docs-plane-hardening.test.ts` batching tests |
| docs_search answers from the new version | `docs-search.test.ts`: fake RAGFlow, after the refresh |
| Config parses the root | `config.test.ts`: unset, absolute, relative |
| Existing approve and decline trail still holds | the existing `policy.test.ts` and `server.test.ts` cases cited in SUMMARY (unchanged) |

## Success criteria

| # | ROADMAP criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | `skills_list` and an approve/decline audit trail (§5.1) | PASS by existing code and tests. No change in this phase | SUMMARY (criteria) |
| 2 | Skills become searchable through `docs_search` after each `agent-skills` fast-forward re-ingest | PASS in-repo with a fake RAGFlow. The live fast-forward is not run | `docs-search.test.ts` |

## Not proven

- The live fast-forward on the host: the `substrate-skills-sync` unit is not installed, `SUBSTRATE_AGENT_SKILLS_ROOT` is not set, and the RAGFlow `agent-skills` dataset is not created (operator-gated).
- A dirty working tree in a skills checkout is still ingested under its committed name. Recorded as a known gap in SUMMARY.
- Partial dataset state after a failed batch: earlier batches stay uploaded while no version is recorded, and the job is marked `stored`. Recorded in SUMMARY.
- The degraded pin-age behaviour under a real skills-sync failure. Only the fake-plane tests cover it.

## Requirement coverage re-verification (2026-10-24)

Tests were not run in this task; the orchestrator runs them. Code and test names below were confirmed by read and grep only.

### F-D3

- Requirement (ROADMAP Phase 42 criterion 1): "`skills_list` and an approve/decline audit trail (§5.1; v0.3 "4.x Skill approve audit")." (REQUIREMENTS.md line 40 carries the same text.)
- Implementing code (confirmed by grep in `packages/mcp-server/src`):
  - `mcp.ts:1925` tool `skills_approve` (approve, decline or retire); `mcp.ts:1961` tool `skills_list` (read-only, default approved rows).
  - `server.ts:1846` `POST /skills/approve` runs `auditedRest(... "skills_approve" ...)` before the decision; `server.ts:1870` `GET /skills` runs `auditedRest(... "skills_list" ...)`.
  - `service.ts:3375` `approveSkill`: 401/403 gates (`service.ts:3381`, `3384`), refusal event `skill.approve.refused` (`service.ts:3351`), decision event `skill.${decision}` (`service.ts:3458`; `skill.approve`, `skill.decline`, `skill.retire`), and the status mapping (`service.ts:3438`).
  - `service.ts:3485` `listSkills`: 401 without a surface (`service.ts:3487`), 403 for a non-approved state without an operator (`service.ts:3494`).
  - `event-sources.ts:199-233` maps the `skill.approve` and `skill.decline` actions into the event sources.
  - `skills/registry.ts` holds the transition rules (`transition`) and the `skills_list` answer shape.
- Tests (exact names):
  - `packages/mcp-server/src/skills-approve.test.ts`: "an operator approves and lists; the list tool is read-only, the approve tool is not"; "the default is the approved rows of this library, sorted by name, in the six-field shape, for any surface"; "every other state is an operator action, and says where each row stands"; "approving a merged proposal records the merge commit, who decided, and one note"; "declining needs a closed, unmerged pull request and emits a note without a merge sha"; "a refused attempt's event names the rule only: an invalid name is never echoed into the ledger"; "a registry write that fails is 503: no event, and the next attempt is not blocked"; "it is audited as skills_approve, fail-closed: an unwritable chain is 503 with no gh call and no row".
  - `packages/mcp-server/src/skills/registry.test.ts`: `expect(transition(null, "decline", null)).toEqual({ kind: "apply", to: "declined" })` (`registry.test.ts:54`) is the decline transition case.
- Evidence status: `in-repo proven`. Phase SUMMARY (line 32) says the approve and decline trail is unchanged in this phase and that the policy classes are pinned by `policy.test.ts`. That file is at `packages/audit/src/policy.test.ts`; its cases were not re-read here.
- Known gap, unchanged from SUMMARY line 32: how `declined` is reported (the FEATURES gap). Not a live proof item.
- Live proof remaining: none recorded in phase VERIFICATION for F-D3. [INFERENCE] `PENDING_VALIDATION` is not claimed here, because the phase VERIFICATION does not name an operator check for this criterion.

### F-D4

- Requirement (ROADMAP Phase 42 criterion 2): "Skills become searchable through `docs_search` after each `agent-skills` fast-forward re-ingest." REQUIREMENTS.md line 42 and its traceability row (line 113, Phase 42, Pending) carry "Skills become searchable through `docs_search`".
- Implementing code:
  - `packages/mcp-server/src/config.ts:302` `agentSkillsRoot`; `config.ts:1238-1242` `agentSkillsRootFromEnv` reads `SUBSTRATE_AGENT_SKILLS_ROOT` (absolute path only).
  - `packages/mcp-server/src/server.ts:345-360` `localIngestSource`: `agent-skills` reads the checkout through `skillsCheckoutRoots` and `readSkillsCheckoutPages`, and checks `checkoutHead`; any other dataset is a noop.
  - `packages/mcp-server/src/server.ts:1724` `POST /docs/merge-trigger` (the refresh trigger; the version is recorded only after the guarded ingest).
  - `packages/mcp-server/src/docs-ingest.ts:132` `readSkillsCheckoutPages`; `docs-ingest.ts:159` `skillsCheckoutRoots`.
  - `packages/mcp-server/src/git.ts:96` `checkoutHead`.
  - `packages/mcp-server/src/service.ts:4883-4884` `commit-mismatch` and `checkout-unreadable` checks (`service.ts:4910`, `4931`).
- Tests (exact names):
  - `packages/mcp-server/src/server.test.ts`: "POST /docs/merge-trigger ingests the agent-skills checkout when SUBSTRATE_AGENT_SKILLS_ROOT names one, then records the version"; "POST /docs/merge-trigger for agent-skills refuses a checkout that moved past the requested commit: commit-mismatch, nothing recorded"; "POST /docs/merge-trigger for agent-skills is a truthful noop when SUBSTRATE_AGENT_SKILLS_ROOT is unset"; "POST /docs/merge-trigger for agent-skills fails with checkout-unreadable when the named checkout is gone".
  - `packages/mcp-server/src/docs-search.test.ts`: "docs_search answers from the new agent-skills version after the refresh"; "a checkout that cannot be read keeps the pinned version serving, with its age"; "an unreadable references directory fails the refresh: the pinned version keeps serving and no version is recorded".
  - `packages/mcp-server/src/docs-ingest.test.ts`: "a folder whose name fails the skill-name rule is not a skill, even with SKILL.md and references/"; "an unreadable references directory fails the skills scan; the skip scan keeps the rest".
  - `packages/mcp-server/src/docs-plane-hardening.test.ts`: "an agent-skills trigger is the fast-forward evidence: its citations stop carrying pin_age_ms"; "a queued refresh whose checkout moved on records no version and reports commit-mismatch".
  - `packages/mcp-server/src/config.test.ts`: "unset names no checkout and warns nothing"; "an absolute path is the checkout, trimmed, and warns nothing"; "a relative path is treated as unset and named at boot".
- Evidence status: `in-repo proven` (code and tests both found; RAGFlow is a fake plane).
- Live proof remaining: `PENDING_VALIDATION`. Phase VERIFICATION "Not proven" lists the operator steps: install the `substrate-skills-sync` unit; set `SUBSTRATE_AGENT_SKILLS_ROOT` to an absolute path of the `agent-skills` checkout; create the RAGFlow `agent-skills` dataset; fast-forward the checkout and let the trigger run. Operator check: after the fast-forward, `docs_search` for a term that exists only in the new skill version must return it from the new version (the `agent-skills` version recorded by `POST /docs/merge-trigger`).

### Scope note

- Nothing in this block changes the frontmatter status, the score line, or the criteria table above.
