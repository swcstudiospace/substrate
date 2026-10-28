## What

<!-- One or two sentences: the change and why. -->

## Verification

<!-- Commands you ran and what they printed, or "CI is the authority". See docs/ci.md. -->

## Risk

<!-- What could break, what is irreversible, what an operator must do after merge. "None" is an answer. -->

Tracked: <!-- Linear, Notion or phase link -->

## Checklist

- [ ] Cloud agents: this PR was opened as a draft and is not merged, auto-merged or force-pushed by the agent ([AGENTS.md](../AGENTS.md)).
- [ ] The diff contains no secrets, tokens, keys, tailnet names or internal hostnames; environment variables are referenced by name only.
- [ ] Greptile review is 5/5 with no open threads, and CI is green ([AGENTS.md](../AGENTS.md), [docs/ci.md](../docs/ci.md)). A failed, skipped or unavailable review is a blocker.
- [ ] `bun run verify` passes locally, or CI is the authority ([docs/ci.md](../docs/ci.md)).
- [ ] Files under `.planning/` changed only through a GSD workflow.
- [ ] A deliberate change to a baseline or lock (for example the `check:phase-close` baseline, `.github/audit-accepted-risk.json`) is called out under Risk.
