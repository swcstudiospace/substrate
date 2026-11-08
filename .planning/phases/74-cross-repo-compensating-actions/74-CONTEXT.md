# Phase 74 context: cross-repo compensating actions

Goal and success criteria: the integration ROADMAP text for phase 74 (the build wording, introduced by commit d535f8c6). It requires a real operation spanning at least two registered repositories, persisted per-repository step state, compensated or needs-attention results on forced failure, and tests against temporary real repositories.

Requirement: HARD-R1 (`.planning/REQUIREMENTS.md:118`, introduced by commit 23bd0733, the owner-approved phase 71 revision). It reads: "Execute a real operation across at least two registered repositories with a durable per-step transaction log and idempotent retries. Forced failure leaves compensated state or explicit needs-attention state; no silent partial success. Absence of an existing transaction path is not delivery."

## Status: gaps_found

- HARD-R1 is not built. No multi-repo operation with persisted step state exists on this tree.
- Criterion 2 of the old origin/main text (the install-git-hook robustness gap) is delivered separately: commit d65d74fb, with 20 of 20 hook tests passing. It is not the HARD-R1 deliverable.

## Decision for the owner (not made here)

- Build HARD-R1. The candidate is `worktree prune` with persisted step state, since prune is already a multi-repo write. Or,
- Formally waive HARD-R1: amend the requirement and the ROADMAP text, with owner approval, because HARD-R1 is owner-approved text.

## Withdrawn

- D74-1 ("no compensation built in v1.8", recorded under delegation). It was withdrawn after review: it closed phase 74 against owner-approved HARD-R1, which says absence of a transaction path is not delivery. A decision that changes an approved requirement is the owner's, not the orchestrator's.

## Facts used in the review (unchanged)

- Worktree prune (packages/cli/src/worktree/command.ts) and the git hook installer (packages/collectors/src/install-git-hook.ts) are multi-repo writes. Both are idempotent: a re-run repairs a partial failure. Neither keeps durable step state.
- Ingest (packages/cli/src/corpus/ingest.ts) writes to one target.
- Re-running is a repair, not a transaction. HARD-R1 asks for a durable per-step log, so a re-run does not satisfy it.

## Scope on this tree

- Code: packages/collectors/src/install-git-hook.ts and its tests (the hook fix, d65d74fb).
- No HARD-R1 code.
