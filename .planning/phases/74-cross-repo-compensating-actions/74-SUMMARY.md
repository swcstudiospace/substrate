# Phase 74 summary: install-git-hook robustness

## 1. What changed

- `packages/collectors/src/install-git-hook.ts`: the repository loop in `main()` is extracted into exported `installRepos(repos, options)`. `main()` calls it and exits 1 when `failures > 0`, otherwise 0. Usage and exit 2 are unchanged.
- Per-repository isolation: each repository runs in its own `try`/`catch`. A throw is recorded and the loop continues, so the remaining repositories still get their hook.
- Distinct-repository count: `failures` counts each repository with a problem once, via a per-repository `problem` flag and a `finally`.
- Redacted reason: `RepoFailure.reason` is the first line of the error, passed through the existing `redact` from `mcp-server/src/redact.ts`, with URLs replaced by `<url>` and capped at 200 characters. No new redactor.
- Result: `{ failures: number, errors: { repo, reason }[] }`. The printed failure line is `✗ <repo> — install failed: <reason>`.
- Tests (`install-git-hook.test.ts`):
  - `installRepos keeps going past a failing repository > one failing repository does not stop the others, which still get their hook`
  - `... > the failing repository is named in the result with a one-line reason`
  - `... > with no failure the result is unchanged: no errors, the same line per repository`
  - `... > the CLI exits 1 for a failing repository, names it, and still installs the others`
  - `... > a repository with several problems is counted once in failures, not once per problem`

## 2. Decisions

- D74-1 (`74-CONTEXT.md`, criterion 1): no cross-repo write path or compensation is built in v1.8. This was an owner-delegated decision, and the owner may reverse it. A reversal opens a new phase.
- D74-2 (`74-CONTEXT.md`, criterion 2): the install-git-hook gap is fixed in this phase. The changes above implement it.

## 3. Verification

Reported by Main from its own runs, not observed by this author. The full suite runs on the integration tree, not in this worktree.

- `install-git-hook.test.ts`: 20 pass, 0 fail.
- `tsc`: 0.
- lint: 0.
- phase-close: 239 pass, 0 fail.

## 4. Not verified

- The throw-after-foreign-hook combination (a repository records a foreign-hook problem, then throws in the corpus step) is not covered by any test. The `finally` applies the same once-per-repository rule, but this path is untested.
- The redaction path itself is not exercised. No fixture was found that produces a secret or URL in an error message.
