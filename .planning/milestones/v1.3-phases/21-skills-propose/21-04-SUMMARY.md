---
phase: 21-skills-propose
plan: "04"
subsystem: cli
tags: [cli, http-client]

requires:
  - phase: 21-skills-propose plan 03
    provides: the plan before this one, as sequenced in the roadmap
provides:
  - substrate skills propose --dir PATH, an HTTP client of /skills/propose with SUBSTRATE_TOKEN
  - readSkillDir with September's refusal rules, the 1 MB pre-flight cap, the 180 s timeout

key-files:
  modified: []

requirements-completed: [SKILL-01]

coverage:
  - id: D1
    description: "the CLI's body, refusals, output and exit codes against a stub server over a real socket, and as a spawned command"
    requirement: "SKILL-01"
    verification:
      - kind: integration
        ref: "bun test packages/cli/src/skills.test.ts (30)"
        status: pass
    human_judgment: false

completed: 2026-10-09
status: complete
---

# Phase 21 Plan 04 Summary

**The third door keeps no git path of its own: it reads the directory, posts it and prints what the server answered.**

- A symlink, a special file or non-UTF-8 content refuses the whole directory, naming the path; a body over the route's cap is refused before posting; no token is exit 1 on stderr with nothing posted; `--surface` is refused outright.
- The body uses exactly the route's snake_case keys and never a `surface`. Output is `key=value` lines and one `finding=<file>:<line> <rule>` per finding. Exit 0 for the five successes; 1 for a refusal, a failure, a 401, 403, 413 or 5xx, or an unreachable or slow server. The timeout defaults to 180 s (`SUBSTRATE_SKILLS_TIMEOUT_MS`).

## Task Commits

1. `8c4e7d1` feat(21-04): add substrate skills propose as an HTTP client of /skills/propose

## Mutation checks

Adding a `surface` key failed 2; skipping the cap failed 1; returning 0 for server errors failed 4; ignoring a missing token failed 2.

## Self-Check: PASSED

The commits above exist; the commands named under each coverage entry passed in the final run (tsc exit 0; full suite 1851 pass / 57 skip / 0 fail).
