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
