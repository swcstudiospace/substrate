---
phase: 15-lessons-bank
plan: 01
one-liner: "Lessons from finished phases become governed, citable memory: substrate lessons add/recall/digest/outcome over fact entries written through memory_write, with recall paging every lesson by subject prefix and a keyset cursor, scores computed at read time and digests that retire lessons without deleting them."
subsystem: cli + mcp-server read path
tags: [memory, lessons-bank, governed-facts, spe-5830]
requirements-completed: [LES-01, LES-02, LES-03, LES-04, LES-05, PROOF-04]
provides:
  - substrate lessons add (text, or a SUMMARY's ## Lessons section or --key-decisions) as fact entries, subject lesson:<milestone>/<phase>/<slug>, scoped idempotency key, structured header
  - substrate lessons recall - a ## Prior Lessons block citing entry ids, ranked by recency x keyword/tag match x score, digested lessons left out
  - substrate lessons digest <milestone> - one lesson-digest fact listing the ids; nothing deleted
  - substrate lessons outcome <id> --report-id R - an appended, retry-stable lesson-outcome fact; the score is computed at read time
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
  - Outcome keys use an explicit case-preserving report id with scope, lesson and citing phase; the same logical report replays and an intentional correction requires a fresh id
  - Cite-by-id is the GSD convention [lesson <id>]; the discuss step runs recall by hand in v1.2 (no change to the installed GSD workflows)
completed: 2026-10-07
status: complete
---

# Plan 15-01 Summary

## Delivered implementation
- `substrate lessons add|recall|digest|outcome` (`packages/cli/src/lessons.ts`). Each lesson is one `fact` with a `[lessonbank]` header (milestone, phase, outcome, tags, source) and a key derived from the scope, the source and the content.
- `memory_search` takes an optional literal `subject_prefix` and a keyset cursor `(before, before_id)`; a full page returns `next`. With neither parameter, the reply is the same bare list as before. No write path changed, and `store-lock.test.ts` stays green.
- Recall pages `lesson:`, `lesson-digest:` and `lesson-outcome:`, then prints a `## Prior Lessons` block that cites ids. On an older server it falls back to body search, with one warning.
- `docs/lessons-bank.md` documents the commands, the discuss-time recipe and the cite-by-id convention.

## Historical implementation evidence
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
  - At v1.2 close, five reviewed phase lessons were accepted and read back. Digest `mem_2c3f2eb6a24842e1bbef46759fa5c35e` (`lesson-digest:v1.2`) rolls up those five plus the cited v1.1 lesson. A second digest returns the same id as `duplicate`; recall lists the digest and none of the six retired lessons. The same smoke substrate on 7493 was used.

## Review correction evidence — 2026-10-08
- PR [#17](https://github.com/swcstudiospace/agent-substrate/pull/17) merged by the configured CLI at `2026-10-08T02:11:45Z`, squash `746a38a4aaa0cbe25cdea54d64d4babb6bda37bd`. Final head `f956ec22e36401219d71c01562693261f0094f63` passed Greptile 5/5, zero open comments, round 4; GitHub's configured check is Greptile Review (SUCCESS), not a separate build/test suite. Tested implementation is `439fb50`; `f956ec2` changes only JSON-output documentation. Remote feature branch was deleted; local Git sync failed, so no local-main update is assumed.
- `outcome` requires `--report-id`, including dry-run. Its scoped key is independent of stored history, result and note. Stored metadata hashes the opaque id; JSON reports keep it exact. Already-persisted same-payload retries return the original fact; fresh-id corrections append; changed content under one identity conflicts. The server orders first/concurrent commits.
- Protocol reason `review.required` and exact entry/conflict/quarantine/review ids survive credential scrubbing. String, object and array diagnostic text is normalized and scrubbed before the cap; null reasons still permit the error fallback. F-15-02 was reproduced in three actual CLI output paths and corrected, not waived.
- Parent gates: 60 focused CLI tests; 1146 full/live-PostgreSQL tests, 4385 assertions across 39 files; clean typecheck and both CLI LSP diagnostics (`artifact://68`). Bank contract proof: 31/31 on isolated port 7509, `/tmp/p15-proof-1791422085` at `e7be626`, before the diagnostic-only delta.
- Eighteen actual-CLI checks against the real isolated store passed on the current implementation. A proxy delayed a committed success reply; a fresh failure scored 1/3; retrying the lost success returned `mem_45a471bfada9484bb9b50b619226f94c`, kept exactly two reports and retained score 1/3. A new success scored 2/3. Opaque identity `retry-unverified-1` recorded/replayed; speculative notes still quarantined. Four additional actual-CLI controlled-upstream checks proved structured diagnostic closure and unchanged authorization/no extra retries.
- Read-only PROOF-04 recheck on port 7508 found the archived SUMMARY source, Phase 14 citing outcome `mem_05e1dd19ee8146619f24e05ed3f40768`, original digest `mem_2c3f2eb6a24842e1bbef46759fa5c35e`, and all six original facts. The actual corrected CLI recalls the digest and excludes its retired ids; no historical close write was repeated.
- Independent P15GoalRefresh verified five criteria/six requirements and Nyquist coverage on the current source. P15SecurityClosure returned SECURED: four fresh delta controls, eleven qualified historical closures, fifteen closed, zero open/accepted risks. Parent recorded both reports; canonical manager projected all five phases complete/passed. Trackers record this PR's merge while overall v1.2 remains implementing.

## Deviations
- The read-side `memory_search` filter and cursor were added after review of the research docs showed that recall could lose older lessons behind the newest-100 window.
- The proof's second run exposed global idempotency keys: the same lesson added to a new scope was refused as `idempotency.reused`. Keys now include the scope, and a test covers it.

## Lessons
- Scope belongs in every governed-memory idempotency key when the backing gate enforces keys globally; otherwise the same valid lesson in a second repo is refused as key reuse.
- A content- or predecessor-derived outcome key cannot distinguish an old lost-response retry from a fresh correction. Give each logical report a stable identity, reuse it on retries, and use a new identity only for a new report.
