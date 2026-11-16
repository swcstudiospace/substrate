---
phase: 42-skill-card
verified: 2026-11-12T08:36:12Z
status: human_needed
score: 2/2 roadmap criteria verified in-repo; live fast-forward proof human_needed (operator-gated)
behavior_unverified: 0
overrides_applied: 0
covered_files: [".env.example", ".planning/milestones/v1.3.x-phases/42-skill-card/PLAN.md", ".planning/milestones/v1.3.x-phases/42-skill-card/SUMMARY.md", "docs/config-reference.md", "docs/data-planes.md", "docs/docs-search-ingest.md", "packages/mcp-server/src/config.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/docs-ingest.test.ts", "packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/docs-plane-hardening.test.ts", "packages/mcp-server/src/docs-search.test.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/git.ts", "packages/mcp-server/src/server.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service.ts"]
covered_digest: "v3:sha256:963d69a5003849e2973bfc3bc5e8d6078739e3d3308d9c4f13c326019a968f6f"
human_verification:
  - test: "Live fast-forward proof: install the substrate-skills-sync unit, set SUBSTRATE_AGENT_SKILLS_ROOT to the absolute agent-skills checkout path, fast-forward the checkout, let the trigger run, then docs_search for a term that exists only in the new skill version"
    expected: "docs_search returns that document from the new agent-skills version recorded by POST /docs/merge-trigger"
    why_human: "Requires the operator-gated RAGFlow (retired)/LightRAG agent-skills dataset, host keys and a host fast-forward; not runnable in the repo (fake RAGFlow (retired) only)"
---

# Phase 42: SKILL-CARD Verification Report

**Phase Goal:** Skills gain a list tool with an approve/decline audit trail, and the `agent-skills` dataset re-ingests after each fast-forward.
**Verified:** 2026-11-12T08:36:12Z
**Status:** human_needed
**Re-verification:** No — initial verification in this milestone archive (prior VERIFICATION.md had no `gaps:` section)

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `skills_list` and an approve/decline audit trail exist (ROADMAP criterion 1, F-D3) | ✓ VERIFIED | Tools: `packages/mcp-server/src/mcp.ts:2066` (`skills_approve`), `mcp.ts:2102` (`skills_list`). REST audit: `server.ts:2169` (approve audited before decision), `server.ts:2193` (list audited). Service: `service.ts:4834` (`skill.approve.refused`), `service.ts:4858` (`approveSkill`), `service.ts:4968` (`listSkills`). Behavioral: `skills-approve.test.ts` runs in the 283-pass batch (see Behavioral Spot-Checks), including "an operator approves and lists; the list tool is read-only, the approve tool is not" (`skills-approve.test.ts:982`). No change made in this phase. |
| 2 | Skills become searchable through `docs_search` after each `agent-skills` fast-forward re-ingest (ROADMAP criterion 2, F-D4) | ✓ VERIFIED (in-repo, fake RAGFlow (retired)) | Trigger route `server.ts:2047`; per-dataset source `server.ts:405-419` (`agent-skills` reads `config.agentSkillsRoot` via `readSkillsCheckoutPages` and `checkoutHead`); unset is a noop `server.ts:2102-2109` (`no-configured-ingest-root`). Config: `config.ts:1511-1515` (`agentSkillsRootFromEnv`, absolute only). Commit fail-closed: `service.ts:6980-6981` (`commit-mismatch`, `checkout-unreadable`). Behavioral: `docs-search.test.ts:1198` "docs_search answers from the new agent-skills version after the refresh" — PASS (named run). `server.test.ts` agent-skills trigger tests (ingest+record, commit-mismatch, unset noop, checkout-unreadable) — 4 PASS. Live fast-forward against the real docs plane is NOT run (see Human Verification). |

**Score:** 2/2 truths verified in-repo (0 behavior-unverified; live proof human_needed)

### Deferred Items

None.

### Advisory (New Scope, Unevidenced)

None (initial verification).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/config.ts` | `agentSkillsRoot` from `SUBSTRATE_AGENT_SKILLS_ROOT` | ✓ VERIFIED | `config.ts:403`, `:1175`, `:1511-1515`, boot warning `:2195-2197`; `config.test.ts` PASS |
| `packages/mcp-server/src/server.ts` | per-dataset ingest map | ✓ VERIFIED | `server.ts:405-419`, `:2102-2109`; `server.test.ts` agent-skills tests PASS |
| `packages/mcp-server/src/docs-ingest.ts` | skills roots + `readSkillsCheckoutPages` | ✓ VERIFIED | `docs-ingest.ts:134`; `docs-ingest.test.ts` PASS |
| `packages/mcp-server/src/git.ts` | `checkoutHead` | ✓ VERIFIED | `git.ts:96` |
| `packages/mcp-server/src/service.ts` | commit/unreadable checks | ✓ VERIFIED | `service.ts:6980-7028` |
| `.env.example` | entry | ✓ VERIFIED | `.env.example:404` |
| `docs/config-reference.md` | generated row | ✓ VERIFIED | `docs/config-reference.md:226` |
| `packages/mcp-server/src/flag-registry.ts` | flag entry | ✓ VERIFIED | `flag-registry.ts:815` |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `server.ts` merge-trigger | `localIngestSource` | dataset lookup | ✓ WIRED | `server.ts:2102` |
| `localIngestSource` (agent-skills) | `readSkillsCheckoutPages` / `checkoutHead` | checkout read | ✓ WIRED | `server.ts:414-415` |
| `skills_approve` / `skills_list` tools | `service.approveSkill` / `listSkills` | audited call | ✓ WIRED | `mcp.ts:2066,2102`; `server.ts:2169,2193` |
| `agentSkillsRoot` config | trigger | `config.agentSkillsRoot` | ✓ WIRED | `server.ts:413` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `readSkillsCheckoutPages` | skill pages | checkout `SKILL.md` + `references/` on disk | Yes (real git checkout in test) | ✓ FLOWING |
| `docs_search` | results | dataset version from fake RAGFlow (retired) | Yes (fake plane, in-repo test) | ✓ FLOWING (fake plane) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Truth 1 + supporting units | `cd packages/mcp-server && bun test src/config.test.ts src/docs-ingest.test.ts src/skills-approve.test.ts src/skills/registry.test.ts ../audit/src/policy.test.ts` | 283 pass, 0 fail (5 files) | ✓ PASS |
| Truth 2 named test | `bun test src/docs-search.test.ts -t "docs_search answers from the new agent-skills version"` | 1 pass, 0 fail | ✓ PASS |
| Truth 2 trigger invariants | `bun test src/server.test.ts -t "agent-skills"` | 4 pass, 0 fail (ingest+record, commit-mismatch, unset noop, checkout-unreadable) | ✓ PASS |
| Probes | none declared for this phase | — | SKIP (no probe scripts) |

Not run: full `bun test` suite, `bunx tsc --noEmit`, and `bun run verify` (not re-run in this verification). Live-DB tests (`SUBSTRATE_TEST_PG_URL`) not run: Postgres 127.0.0.1:5432 refuses TCP.

### Probe Execution

| Probe | Command | Result | Status |
| ----- | ------- | ------ | ------ |
| none declared | — | — | SKIP |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| F-D3 | 42-PLAN.md | `skills_list` and approve/decline audit trail | ✓ SATISFIED | Truth 1 above |
| F-D4 | 42-PLAN.md | Skills searchable through `docs_search` after each re-ingest | ✓ SATISFIED (in-repo); live proof human_needed | Truth 2 above |

No orphaned requirements: REQUIREMENTS.md maps only F-D3 and F-D4 to Phase 42.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (all covered files) | — | `TBD`/`FIXME`/`XXX` grep | — | None found |

### Known gaps (from SUMMARY, not must-have failures)

- A dirty working tree in a skills checkout is still ingested under its committed commit name (ℹ️ Info).
- After a failed batch, earlier batches stay uploaded with no version recorded; the job is marked `stored` (ℹ️ Info).
- Lock is per batch, so another ingest of the same dataset can interleave between batches (ℹ️ Info).

### Human Verification Required

### 1. Live agent-skills fast-forward proof

**Test:** Install the `substrate-skills-sync` unit (example only: `infra/vps/substrate-skills-sync.service.d/30-sandbox.conf.example`), set `SUBSTRATE_AGENT_SKILLS_ROOT` to the absolute agent-skills checkout, fast-forward the checkout, let the trigger run, then `docs_search` for a term that exists only in the new skill version.
**Expected:** The result comes from the new agent-skills version recorded by `POST /docs/merge-trigger`.
**Why human:** Needs the operator-gated RAGFlow (retired)/LightRAG `agent-skills` dataset, its keys and a host fast-forward. Not run.

### Gaps Summary

No gaps. Both roadmap criteria are proven in-repo against the code and named tests above. Status is `human_needed` only because the live fast-forward proof is operator-gated and was not run.

---

_Verified: 2026-11-12T08:36:12Z_
_Verifier: Claude (gsd-verifier)_
