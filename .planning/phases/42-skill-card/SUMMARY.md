---
phase: 42-skill-card
requirements: [F-D3, F-D4]
status: in review (draft PR). F-D3 satisfied by existing code and tests. F-D4 satisfied in-repo with a fake RAGFlow. The live fast-forward proof is operator-gated and not run
---

# 42-SUMMARY: SKILL-CARD

## Built

- **Config.** `SUBSTRATE_AGENT_SKILLS_ROOT` names a local checkout of the agent-skills repository. A relative path is treated as unset and named at boot. Unset, the trigger stays the no-op it was (D42-1).
- **Per-dataset ingest.** The merge-trigger route reads the dataset's local checkout through `localIngestSource`. `agent-substrate` keeps its base directory and roots unchanged (D42-3). `agent-skills` reads the configured checkout. Any other dataset keeps the truthful no-op.
- **Skill roots.** Each directory `<name>/` at the checkout root is a skill, with roots `<name>/SKILL.md` and `<name>/references/`. Dot-directories and links are not skills. Pages are still read by the existing `scanIngestPages`.
- **Version and search.** A successful agent-skills refresh records a dataset version under the existing retention of five. `docs_search` answers from it (D42-2).
- **Degraded fallback.** A checkout that cannot be read fails that refresh alone. The pinned version keeps serving with its age (D42-5).

## Deviations from the plan

1. **Roots are per skill, not literal `SKILL.md` and `references/` at the top level.** The library layout is `<name>/SKILL.md` at the checkout root (`skills/registry.ts`, `propose.ts` `writeTree`). Literal top-level roots would match no page in a real checkout, so every refresh would end in `no-pages`. `docs-search-ingest.md` already describes "every SKILL.md and references/", which fits per-skill roots.
2. **Roots travel with the request.** `ingestDocs` checked every page against the global `docsIngestRoots`, so agent-skills pages would be refused as `outside-roots`. Roots are now an optional part of the refresh request (`DocsRefreshRequest.roots`). `agent-substrate` still gets `config.docsIngestRoots`, so its behaviour is unchanged. This touches `service.ts`, which the plan did not list.
3. **The pin age survives a failed agent-skills refresh (D42-5).** The route marks the dataset's sync live before the job runs. Without a change, a failed refresh would serve the old pin with no `pin_age_ms`. `docsSkillsRefreshFailed` is set on any agent-skills job failure and cleared on success, and `degradedDatasets` reads it.

`docs/docs-search-ingest.md` also changed, because the rehearsal sentence there became false. The plan did not list it.

## Criteria

- **F-D3 (criterion 1: `skills_list` and an approve/decline audit trail).** Satisfied by existing code and tests, with no change: `skills_list` (`mcp.ts`), `skills_approve` and the `skill.approve`, `skill.decline` and `skill.approve.refused` events (`server.ts`), and the fail-closed and fail-open policy classes (`policy.ts`, pinned by `policy.test.ts`). The gap noted in FEATURES, how `declined` is reported, is unchanged.
- **F-D4 (criterion 2: searchable through `docs_search` after each fast-forward re-ingest).** Satisfied in-repo: `docs_search` answers from the new agent-skills version after a refresh, proven with a fake RAGFlow.

## Tests added

- `server.test.ts`: the agent-skills trigger ingests the checkout and records the version when the root is set; the trigger is a truthful no-op with no uploads when it is unset; it fails with `checkout-unreadable` when the named checkout is gone. This replaces the noop-only assertion.
- `docs-search.test.ts`: `docs_search answers from the new agent-skills version after the refresh`, and `a checkout that cannot be read keeps the pinned version serving, with its age`.
- `config.test.ts`: unset names no checkout and warns nothing; an absolute path is the checkout, trimmed, with no warning; a relative path is treated as unset and named at boot.

## Operator-gated (not run)

- Creating the RAGFlow `agent-skills` dataset, and its keys.
- Installing the `substrate-skills-sync` unit on the host (`infra/vps/substrate-skills-sync.service.d/30-sandbox.conf.example` is an example only), and setting `SUBSTRATE_AGENT_SKILLS_ROOT`.
- A live fast-forward proof on the host.
