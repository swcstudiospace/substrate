# 24-02 Summary: Worktree gate (DISP-03)

## Objective
Implement the DISP-03 worktree gate: per-graph-ID worktree reuse, origin
verification, and the 5 GiB free-space refusal, as a pure function over
injected dependencies, proven by tests that use tmp directories and a fake
git runner.

## Files
- `packages/dispatcher/src/worktree.ts` — `ensureWorktree(input, deps)`
  over injected `{ worktreeRoot, checkoutsRoot, statfs, exists, runGit }`.
  Gate order: `GRAPH_ID_PATTERN` (`/^ut-[a-z0-9]+-[0-9a-f]{8}$/`, literal
  copied from `packages/mcp-server/src/service.ts:436` with a pinning test)
  and `REPO_SLUG_PATTERN` (`owner/name` of `[A-Za-z0-9_.-]+`) throw
  `InvalidGraphIdError` / `InvalidRepoError` before any path join, statfs,
  or git call; `bavail * bsize` under `MIN_FREE_BYTES` (5 GiB) returns
  `low-disk` before git runs; an existing path is reused only when
  `git -C <path> remote get-url origin` parses (both
  `https://github.com/<repo>(.git)` and `git@github.com:<repo>(.git)` per
  assumption A3, case-insensitive) to the same slug as `graph.repo`,
  otherwise `path-conflict`, never silent reuse; a missing bare clone
  under `checkouts/<owner>/<name>` (or a null/blank repo) is `no-checkout`
  with no git call and no network clone; non-zero git status or a runner
  throw is `git-failed`. New checkouts run
  `git worktree add -B substrate/<graph_id> <path> origin/main` as an argv
  array with `cwd` set to the base clone — no shell, no token, no
  `/var/lib/substrate` reference in module code. A `joinContained`
  belt-and-braces check keeps joined paths inside their root.
- `packages/dispatcher/src/worktree.test.ts` — bun:test suite on tmp roots
  with a recording fake runner: 11 traversal/malformed ids rejected with
  zero statfs/git calls and empty worktree root; 5 malformed repo slugs
  throw before statfs/git; low-disk asserts no git call and no directory;
  exact-5-GiB boundary proceeds; https + ssh origin reuse, case-insensitive
  match, mismatch/unparseable-origin `path-conflict`, get-url
  failure/throw `git-failed`, missing-clone and null-repo `no-checkout`
  with no git call, exact `worktree add` argv + cwd assertion, add
  failure/throw `git-failed`, and a `parseGitHubSlug` table pinning both
  A3 URL forms.

## Verification
Not run in this pass per assignment constraints (`bun test` and `tsc`
explicitly out of scope here): the plan's `bun test
packages/dispatcher/src/worktree.test.ts` plus `bun test
packages/dispatcher` and `bunx tsc --noEmit` are the merge-gate checks.
No new npm dependencies; no lockfile churn.

## Prohibitions honored
No real git binary, no shell, no `/var/lib/substrate` or `/etc/substrate`
touches (production roots are caller-supplied constants, tests use tmp
only), no network clone, no GitHub token, no hermes spawn, no
`graph_claim`. 24-01 files (`kill-switch`, `lock`, `linear-poll`,
`linear.ts`, `package.json`, `bun.lock`) untouched.

## Deviations
- `require("node:fs")` inline in a test helper replaced with a top-level
  `mkdtempSync` import to comply with the repo `ts-import-type` rule; one
  bad range edit during that fix duplicated three lines, repaired
  immediately. Final file re-read clean.
- Invalid `graph_id`/`repo` throw instead of returning a DISP-02 outcome:
  validation runs before any join, so there is no path to comment on; the
  tick layer maps these programmer/tampering signals to `path-conflict`
  when posting markers.
