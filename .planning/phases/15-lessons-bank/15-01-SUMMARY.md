---
phase: 15-lessons-bank
plan: 01
one-liner: "Lessons from finished phases become governed, citable memory: substrate lessons add/recall/digest/outcome over fact entries written through memory_write, with recall paging every lesson by subject prefix and a keyset cursor, scores computed at read time and digests that retire lessons without deleting them."
subsystem: cli + mcp-server read path
tags: [memory, lessons-bank, governed-facts, spe-5830]
provides:
  - substrate lessons add (text, or a SUMMARY's ## Lessons section or --key-decisions) as fact entries, subject lesson:<milestone>/<phase>/<slug>, scoped idempotency key, structured header
  - substrate lessons recall - a ## Prior Lessons block citing entry ids, ranked by recency x keyword/tag match x score, digested lessons left out
  - substrate lessons digest <milestone> - one lesson-digest fact listing the ids; nothing deleted
  - substrate lessons outcome <id> - an appended lesson-outcome fact; the score is computed at read time
  - memory_search subject_prefix (literal) and keyset cursor (before, before_id) over created desc, id desc - read path only
key-files:
  created:
    - packages/cli/src/lessons.ts
    - packages/cli/src/lessons.test.ts
    - packages/cli/src/args.ts
    - packages/mcp-server/src/index-store.search.test.ts
    - docs/lessons-bank.md
  modified:
    - packages/cli/src/index.ts
    - packages/mcp-server/src/index-store.ts
    - packages/mcp-server/src/service.ts
    - packages/mcp-server/src/mcp.ts
    - packages/mcp-server/src/mcp.test.ts
    - packages/mcp-server/src/types.ts
    - docs/memory-governance.md
    - README.md
key-decisions:
  - Lessons are governed fact entries through POST /memory; no lessons table, no new kind, no new insertEntry caller (the approved Tier 1 storage)
  - memory_search gains a read-side subject_prefix filter and a keyset cursor so recall pages every lesson, digest and outcome instead of the newest-100 window; with neither parameter the reply is unchanged
  - Keys include the scope, because the server's idempotency keys are global; the same lesson added to a second scope is that scope's own entry
  - A lesson counts only when accepted and verified_persisted; quarantined, denied and conflicting writes are reported once and never retried
  - Score = (1 + sum of outcome weights) / (2 + n) over the newest report per citing phase, computed at read time
  - Cite-by-id is the GSD convention [lesson <id>]; the discuss step runs recall by hand in v1.2 (no change to the installed GSD workflows)
completed: 2026-10-07
status: complete
---

# Plan 15-01 Summary

## What shipped
- `substrate lessons add|recall|digest|outcome` (`packages/cli/src/lessons.ts`). Each lesson is one `fact` with a `[lessonbank]` header (milestone, phase, outcome, tags, source) and a key derived from the scope, the source and the content.
- `memory_search` takes an optional literal `subject_prefix` and a keyset cursor `(before, before_id)`; a full page returns `next`. With neither parameter, the reply is the same bare list as before. No write path changed, and `store-lock.test.ts` stays green.
- Recall pages `lesson:`, `lesson-digest:` and `lesson-outcome:`, then prints a `## Prior Lessons` block that cites ids. On an older server it falls back to body search, with one warning.
- `docs/lessons-bank.md` documents the commands, the discuss-time recipe and the cite-by-id convention.

## Evidence
- Branch rebased on `main` after Phase 11: `bun run check` is clean; 1090 pass / 0 fail with live Postgres and 1044 pass / 55 skip with no database. `index-store.search.test.ts` pages 257 entries in ties of seven at page sizes 100, 33 and 7, with no gap and no repeat.
- Live proof `/tmp/p15-lessons-proof.sh` against a smoke substrate (real Postgres and GreptimeDB): 31/31 PASS, twice on the same database.
  - Five lessons are recorded, accepted and verified, and the hedged lesson is quarantined; a re-add returns the same ids as duplicates.
  - Recall cites only those lessons. An outcome moves a score from 0.50 to 0.67 without changing the lesson.
  - A digest retires the lessons from recall and deletes nothing.
  - One old lesson sits behind 230 newer entries. The plain search's newest-100 window misses it; two cursor pages list all 111 lessons with no gap, and recall cites the old lesson first.
- PROOF-04 citation:
  - Lessons from three v1.1 SUMMARYs were added to a smoke substrate's bank for `repo:swcstudiospace/agent-substrate`.
  - Recall put four of them into Phase 14's CONTEXT.md under `## Prior Lessons`. Phase 14's CONTEXT and 14-01-PLAN cite `[lesson mem_43bc8ddeb0244fc69758a24005e42f75]` for the tee's fail-open rule.
  - The recorded outcome moved that lesson's score from 0.50 to 0.67.

## Deviations
- The read-side `memory_search` filter and cursor were added after review of the research docs showed that recall could lose older lessons behind the newest-100 window.
- The proof's second run exposed global idempotency keys: the same lesson added to a new scope was refused as `idempotency.reused`. Keys now include the scope, and a test covers it.
