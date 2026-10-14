# API Coverage — GitHub (`gh` CLI and git remote) for the skills library

> Full coverage by default. Opt-outs are explicit, reasoned decisions.

Phase 21 reaches GitHub in exactly one place: the `skills_propose` engine. It calls `git` against the library remote and `gh` against `swcstudiospace/agent-skills`, the configured slug. Tests and the harness proof use a throwaway `file://` repository and an injected `gh`.

| capability | decision | reason |
|---|---|---|
| git fetch of `main` into the mirror | INTEGRATE | |
| git push of a new `skill/<surface>/…` branch | INTEGRATE | |
| git remote get-url (origin check before push) | INTEGRATE | |
| gh pr create (`--head <branch> --base main`) | INTEGRATE | |
| gh pr view `<url>` `--json state,url,number` | INTEGRATE | |
| gh pr list `--head <branch> --state open` | INTEGRATE | |
| gh pr merge | OPT-OUT | explicitly out of scope: only the owner merges, and nothing is published live (SKILL-01, Phase 22 live proof) |
| gh pr close / reopen | OPT-OUT | not needed: a close is the owner's decision, read back through `pr view` as `declined`; an operator `reopen` proposes a new branch instead of reopening the PR |
| gh pr edit / comment / review | OPT-OUT | not needed: the PR body is written once at create time |
| gh search (prs, code) | OPT-OUT | explicitly out of scope: the search index is not strongly consistent, so dedupe uses the ledger plus `pr view`/`pr list --head` (September W1) |
| git force push, branch delete, colon refspec | OPT-OUT | explicitly prohibited by SKILL-01 ("never force-pushing"); argv builders are pinned by tests |
| gh repo / admin / workflow / release APIs | OPT-OUT | not needed: the library repository is provisioned already (September 04-02) |
