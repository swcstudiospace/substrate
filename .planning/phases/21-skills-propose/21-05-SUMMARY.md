---
phase: 21-skills-propose
plan: "05"
subsystem: harness
tags: [rehearsal, fixture, smoke, isolated-proof]

requires:
  - phase: 21-skills-propose plan 04
    provides: the plan before this one, as sequenced in the roadmap
provides:
  - rehearsal up --skills-fixture: a throwaway bare library, the proposer's mirror and a recording gh, inside the run directory
  - SUBSTRATE_SKILLS_STATE always set inside the run directory
  - bun run smoke:skills-propose: the isolated end-to-end proof, 47/47

key-files:
  modified: []

requirements-completed: [SKILL-01]

coverage:
  - id: D1
    description: "the fixture builder, the fake gh and the env builder's isolation rules"
    requirement: "SKILL-01"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/rehearsal-skills.test.ts (15), rehearsal-env.test.ts (21), scripts/rehearsal.test.ts (73)"
        status: pass
    human_judgment: false
  - id: D2
    description: "the three doors end to end against a fixture twin, with real git"
    requirement: "SKILL-01"
    verification:
      - kind: integration
        ref: "bun run rehearsal up --name p21 --skills-fixture; bun run smoke:skills-propose — 47/47; bun run rehearsal down --name p21"
        status: pass
    human_judgment: false
  - id: D3
    description: "the smoke's parsers cannot turn a failing proof green"
    requirement: "SKILL-01"
    verification:
      - kind: unit
        ref: "bun test scripts/skills-propose-smoke.test.ts (11)"
        status: pass
    human_judgment: false

completed: 2026-10-09
status: complete
---

# Phase 21 Plan 05 Summary

**The phase gate: all three doors proved over the wire, with real git, against a throwaway library, with nothing able to reach GitHub or the host's skills state.**

- The fixture library is `rehearsal/agent-skills` (not a real owner), refusing non-fast-forwards and deletions and logging every ref update. The recording `gh` answers only `pr create`, `pr view` and `pr list --head` and records every call, supported or not. The env builder accepts exactly four fixture settings and refuses any value outside the run directory.
- `bun run rehearsal up --name p21 --skills-fixture` then `bun run smoke:skills-propose` printed **47/47**: opened on each door with the promised branch shape and one recorded `gh pr create` each; `existing`, `declined` (after the fake `gh` closed the PR) and `unchanged`, each pushing nothing; refusals for a bad name, a `..` path, missing and mismatched frontmatter and a planted secret, with no branch and no gh call; 401 on the route and on `/mcp`, 403 for a mismatched surface and for replace, reopen and doc examples; a dry run that pushed nothing; a reflog with no update; the note and warning events and 17 audit records over both transports; and the planted secret in none of the response, the ledger, the events, the audit file, the gh calls or the library's refs.
- The rest of the chain: full suite 1851 pass / 57 skip / 0 fail; `tsc` 0; `check:phase-close` pass; `rehearsal down` left no container and no run directory.

## Task Commits

1. `fe3107d` feat(21-05): add the skills fixture and a recording gh to the rehearsal harness
2. `cda31c7` test(21-05): add bun run smoke:skills-propose, the isolated end-to-end proof

## Baseline comparison (21-BASELINE.md)

The base ran 1605 pass / 57 skip / 1 fail (the audit ring timing test, already on `main`, fixed separately in the verification-gate PR). The final run on this branch: 1851 pass / 57 skip / 0 fail. No failure was introduced and none was hidden.

## Deviations

The library slug is `rehearsal/agent-skills` as D21-21 says; an earlier draft used a real-looking owner and was changed before the proof run so a mistaken real `gh` call would find nothing to touch.

## Self-Check: PASSED

The commits above exist; the commands named under each coverage entry passed in the final run (tsc exit 0; full suite 1851 pass / 57 skip / 0 fail).
