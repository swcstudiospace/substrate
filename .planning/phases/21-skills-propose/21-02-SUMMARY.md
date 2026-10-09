---
phase: 21-skills-propose
plan: "02"
subsystem: service
tags: [service, events, authority, fail-open]

requires:
  - phase: 21-skills-propose plan 01
    provides: the plan before this one, as sequenced in the roadmap
provides:
  - Substrate.proposeSkill(request, caller): the one method every door ends in, with the 401 and 403 authority checks, the engine call and the fail-open events
  - SkillProposalDenied (status 401 or 403) and SkillProposalRequest
  - the skills.propose.failed EVENT_SOURCES row and its docs/event-vocabulary.md entry

key-files:
  modified: []

requirements-completed: [SKILL-01]

coverage:
  - id: D1
    description: "proposeSkill authority checks (401, 403 mismatch, 403 operator-only, any authenticated surface) run before the proposer and emit nothing"
    requirement: "SKILL-01"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/service.test.ts — proposeSkill (17 cases)"
        status: pass
    human_judgment: false
  - id: D2
    description: "events: note, refused warning with rule names only, failed warning with the redacted reason, silence on dry run, a failing or throwing emit never changes the answer; each event's kind and action equal its EVENT_SOURCES row"
    requirement: "SKILL-01"
    verification:
      - kind: unit
        ref: "bun test packages/mcp-server/src/service.test.ts and event-sources.test.ts (77)"
        status: pass
    human_judgment: false

completed: 2026-10-09
status: complete
---

# Phase 21 Plan 02 Summary

**One method owns the git and gh path, authority comes before anything runs, and every outcome is recorded without ever changing the answer.**

- An anonymous caller is refused 401 before the proposer runs. A body `surface` that differs from the token's is refused 403 and never re-attributed. `mode: replace`, `reopen` and `allow_doc_examples` need an operator token. Any authenticated surface, swarm and `substrate` included, may propose. None of these refusals emits an event.
- An outcome emits a `note` from the caller with the configured repo and `{ action, name, status, pr_url, content_sha256, redactions (a count) }`, never content. A refusal emits a `warning` carrying rule names only. A failed git or gh step emits a `warning` with the redacted reason. A dry run emits nothing. A proposal without a session gets its own one-event session, so a sessionless event cannot share a chain.
- Every emit ends in a fail-open catch: an event that cannot be stored, or that throws outright, never changes the proposal's result or its error.
- The `skills.propose.failed` row sits beside Phase 17's two `skills.propose` rows; the generic event-sources tests cover it, and a dedicated test pins the three rows' kinds and payload keys.

## Task Commits

1. `527357e` feat(21-02): add the skills.propose.failed event source row
2. `1d307d3` feat(21-02): add Substrate.proposeSkill with authority checks and fail-open events

## Mutation checks

Disabling the 401 check failed 2 tests; emitting on dry runs failed 1; removing the rule-name de-duplication failed 1; removing the fail-open catch survived until a test made `emit` itself throw (the ledger-failure case never reaches it, because `emit` already swallows ledger errors), after which it failed 1. The file was restored each time.

## Self-Check: PASSED

The commits above exist; the commands named under each coverage entry passed in the final run (tsc exit 0; full suite 1851 pass / 57 skip / 0 fail).
