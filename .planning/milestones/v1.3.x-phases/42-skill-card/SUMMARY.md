---
phase: 42-skill-card
requirements: [F-D3, F-D4]
status: merge-ready on 02261d7 (CI, Greptile and threads to be re-confirmed on the pushed head). F-D3 satisfied by existing code and tests. F-D4 satisfied in-repo with a fake RAGFlow (retired). The live fast-forward proof is operator-gated and not run
---

# 42-SUMMARY: SKILL-CARD

## Built

- **Config.** `SUBSTRATE_AGENT_SKILLS_ROOT` names a local checkout of the agent-skills repository. A relative path is treated as unset and named at boot. Unset, the trigger stays the no-op it was (D42-1).
- **Per-dataset ingest.** The merge-trigger route reads the dataset's local checkout through `localIngestSource`. `agent-substrate` keeps its base directory and roots unchanged (D42-3). `agent-skills` reads the configured checkout. Any other dataset keeps the truthful no-op.
- **Skill roots.** A directory `<name>/` at the checkout root is a skill only when `<name>/SKILL.md` is a regular file and its name passes the skill-name check. Its roots are `<name>/SKILL.md` and `<name>/references/`. Dot-directories, links and folders without `SKILL.md` are not skills.
- **Fail closed on the checkout.** The refresh reads the checkout's HEAD before and after the scan. A HEAD that moved since the trigger was accepted fails the refresh with `commit-mismatch`, and no version is recorded under the requested commit. An unreadable HEAD fails with `checkout-unreadable`. An unreadable `references/` directory fails the refresh (`readSkillsCheckoutPages`), so a version never looks fresh with fewer pages.
- **Preflight, then batches.** Every page passes the ingest gates (outside roots, page size, secret findings) before the first upload (`preflightIngestPages`), so a content refusal leaves the plane as it was. The pages are then sent in consecutive batches, each measured on its stripped body, which is the size the ingest's own cap enforces (`batchIngestPages`, `INGEST_CALL_MAX_BYTES`, 5 MB). One ingest call per batch. A corpus under the cap is still exactly one call.
- **Version and search.** The dataset version is recorded only after every batch succeeds, under the existing retention of five. `docs_search` answers from it (D42-2).
- **Degraded fallback.** Any failed agent-skills refresh keeps the pinned version serving with its age (D42-5). A failure after some batches were uploaded is marked `stored` on the job, so it reads as partial.

## Deviations from the plan

1. **Roots are per skill, not literal `SKILL.md` and `references/` at the top level.** The library layout is `<name>/SKILL.md` at the checkout root (`skills/registry.ts`, `propose.ts` `writeTree`). Literal top-level roots would match no page in a real checkout, so every refresh would end in `no-pages`.
2. **Roots travel with the refresh request.** `ingestDocs` checked every page against the global `docsIngestRoots`, so agent-skills pages would be refused as `outside-roots`. Roots are now an optional part of the refresh request. `agent-substrate` still gets `config.docsIngestRoots`, unchanged. This touches `service.ts`, which the plan did not list.
3. **The pin age survives a failed agent-skills refresh (D42-5).** `docsSkillsRefreshFailed` is set on any agent-skills job failure and cleared on success, and `degradedDatasets` reads it.
4. **Review fixes on PR #94.** A moved checkout, an unreadable `references/` directory and a folder without `SKILL.md` each fail or are skipped as above (commit 0f82a4d). The scan function was renamed `readSkillsCheckoutPages`, because the redaction lock treats any `scanSkill*` name as a second redactor. That was a false positive on a page reader, and the lock itself is unchanged.
5. **Batching was authored by another actor on this branch (786d1ef).** A review thread asked for batching under the 5 MB cap. The batching commit on this branch was pushed by another actor, under the host git identity that this phase also uses. This phase did not author it. This phase had written its own batching on a local branch, `backup/p42-batching-local-330d78a`, which was never pushed. The pushed version is kept, because it adds the preflight gate that the local version lacked.
6. **Merge with main.** `origin/main` moved through 6b7c4f2 (phase 40) and 3466c50 (phase 41). The `config.test.ts` block conflicted once, with both blocks kept, in merge 9932abc. The later merge of 3466c50 into the branch (02261d7) was clean.

`docs/docs-search-ingest.md` also changed, because the rehearsal sentence there became false, and it now describes batching. The plan did not list it.

## Criteria

- **F-D3 (criterion 1: `skills_list` and an approve/decline audit trail).** Satisfied by existing code and tests, with no change: `skills_list` (`mcp.ts`), `skills_approve` and the `skill.approve`, `skill.decline` and `skill.approve.refused` events (`server.ts`), and the fail-closed and fail-open policy classes (`policy.ts`, pinned by `policy.test.ts`). The gap noted in FEATURES, how `declined` is reported, is unchanged.
- **F-D4 (criterion 2: searchable through `docs_search` after each fast-forward re-ingest).** Satisfied in-repo: `docs_search` answers from the new agent-skills version after a refresh, proven with a fake RAGFlow (retired).

## Known gaps

- **A dirty working tree still passes.** The HEAD check proves the commit, not the content. Uncommitted edits in a skills checkout are ingested under the committed commit name. The skills-sync checkout is a fast-forward-only clone, so this needs tampering or a manual edit. A dirty-tree refusal would close it.
- **Partial dataset state after a failed batch.** Earlier batches stay uploaded when a later batch is refused, and no version is recorded. Until the next successful refresh, `docs_search` can return documents from the new batches alongside the pinned version. The job is marked `stored`, and the reason says so. A rollback would need a delete path, which this phase does not add.
- **Lock per batch.** Each batch takes the dataset lock on its own, so another ingest of the same dataset can run between batches. Each batch is safe alone.

## Tests

- `server.test.ts`: the agent-skills trigger ingests a real git checkout and records the version when the root is set; it is a truthful no-op with no uploads when unset; it fails with `checkout-unreadable` when the checkout is gone; it refuses a checkout that moved past the requested commit (`commit-mismatch`, nothing recorded).
- `docs-search.test.ts`: `docs_search answers from the new agent-skills version after the refresh`; `a checkout that cannot be read keeps the pinned version serving, with its age`; `an unreadable references directory fails the refresh: the pinned version keeps serving and no version is recorded`.
- `docs-plane-hardening.test.ts`: `a queued refresh whose checkout moved on records no version and reports commit-mismatch`, and the batching tests added with the batching commit.
- `docs-ingest.test.ts`: a directory without `SKILL.md` contributes no roots; a skill with no `references/` yields its `SKILL.md` alone; an unreadable `references/` fails the skills scan while the skip scan keeps the rest; an unreadable `SKILL.md` check fails the roots listing.
- `config.test.ts`: unset names no checkout and warns nothing; an absolute path is the checkout, trimmed, with no warning; a relative path is treated as unset and named at boot. The merge with main kept both this phase's block and the HINDSIGHT_MENTAL_MODELS block.

## Incidents, recorded

- **A subagent's edit reached the user's checkout.** During the review-fix pass, a subagent's first edit used a relative path and wrote a 10-line insertion (`checkoutHead`) into the user's own checkout, `packages/mcp-server/src/git.ts`. The insertion was reversed exactly with `git apply -R` on the saved patch. The checkout's remaining WIP was verified unchanged. The phase worktree holds the intended change.
- **Commits this phase did not make.** Commits `e30cd37` and `786d1ef` on this branch, and `fa37dfa` and `1c4c7ed` on PR #92 before its merge, were pushed under the host's git identity, which this phase's commits also use. This phase did not author them. Its own duplicate batching commits remain on the local backup branch and were never pushed.

## Operator-gated (not run)

- Creating the RAGFlow (retired) `agent-skills` dataset, and its keys.
- Installing the `substrate-skills-sync` unit on the host (`infra/vps/substrate-skills-sync.service.d/30-sandbox.conf.example` is an example only), and setting `SUBSTRATE_AGENT_SKILLS_ROOT`.
- A live fast-forward proof on the host.
