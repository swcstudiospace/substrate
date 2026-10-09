---
phase: 21-skills-propose
plan: "06"
subsystem: docs
tags: [docs, validation, handoff]

requires:
  - phase: 21-skills-propose plan 05
    provides: the plan before this one, as sequenced in the roadmap
provides:
  - docs/skills-propose.md, the contract Phase 22 codes against
  - pointers in docs/rehearsal.md, docs/mcp-audit.md, docs/event-vocabulary.md and .env.example
  - the Per-Task Verification Map resolved to the six plans

key-files:
  modified: []

requirements-completed: [SKILL-01]

coverage:
  - id: D1
    description: "the contract doc names the same four keys and the file:// rule config.ts enforces; the docs-versus-table drift test is green"
    requirement: "SKILL-01"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/event-sources.test.ts packages/mcp-server/src/store-lock.test.ts"
        status: pass
    human_judgment: false

completed: 2026-10-09
status: complete
---

# Phase 21 Plan 06 Summary

**The wire contract, the four configuration keys with the file:// rule, the dedupe semantics and the proof chain are documented where the next phase will look for them.**

`docs/skills-propose.md` covers the three doors and the body, authentication and attribution, every status code, what is checked and in what order, duplicates, events, configuration, and the isolated proof. `docs/rehearsal.md` gains `--skills-fixture`; `docs/mcp-audit.md` marks the tool landed; `docs/event-vocabulary.md` explains the three `skills.propose` rows; `.env.example` lists the four settings with the warning that a non-default library needs a `file://` remote and an absolute gh. `21-VALIDATION.md` is `validated` and `nyquist_compliant`, every row resolved to a plan and task. `COVERAGE.md` still matches the shipped gh surface: `pr create`, `pr view` and `pr list --head` are INTEGRATE, and merge, close, search and force-push are reasoned OPT-OUTs.

## Task Commits

1. `(this plan's commit)` docs(21-06): land the skills-propose contract and bring the validation map current

## Self-Check: PASSED

The commits above exist; the commands named under each coverage entry passed in the final run (tsc exit 0; full suite 1851 pass / 57 skip / 0 fail).
