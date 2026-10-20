# Phase 36 SUMMARY: degraded-mode-exactly-once

## What changed (files)
- `packages/mcp-server/src/index-store.memory-exactly-once.test.ts` (new, 129 lines). Live-PG
  regression, skipped without `SUBSTRATE_TEST_PG_URL`. Isolated by a run-scoped `MARKER`.
  Cases: same explicit key twice = one row and the original entry; keyless new content writes
  each time and a keyless identical retry dedupes as today; a commit-then-drop outage followed by
  a same-key retry gives `conflict / write.in-flight` with one row.
- `packages/mcp-server/src/memory-outage-status.test.ts` (new, 55 lines). Outage through
  `Substrate.writeMemory` then `memoryWriteStatus`: a refused claim (`store.write-failed`) and an
  absent index (`store.unavailable`) both give 503. A policy refusal with the index present gives
  403.
- `.planning/phases/36-degraded-mode-exactly-once/{CONTEXT,PLAN,SUMMARY}.md`.
- No production code changed. Memory already has the key; skills are deliberately not changed
  (see GREY_AREA 1).

## Deviation from PLAN.md (recorded, not hidden)
PLAN.md named T1-T3 for `memory-write.test.ts` and T4 for `server.test.ts`. Edits to those two
tracked files did not persist: at 14:10:09 both were reset to HEAD (reflog: `reset: moving to
HEAD`), and the edit tool's cached hash disagreed with disk. I did not re-apply through the cache.
The same cases went into the two new files above. `memory-write.test.ts` and `server.test.ts`
are unchanged on this branch (`git diff` clean). The orchestrator should confirm that no other
process ran a reset in this worktree.

## Tests added
- Same explicit key replayed twice: one row, same entry id, `deduplicated: true` (live PG).
- Keyless write of new content writes each time; keyless identical retry dedupes (live PG).
- Commit-then-drop outage, same-key retry: `conflict / write.in-flight`, one row (live PG).
- Refused claim and absent index both return 503 through `writeMemory` (fake, no PG).
- A policy refusal stays 403 (fake, no PG).

## Findings the orchestrator should know
- Lessons CLI maps a 503 to `denied` (`packages/cli/src/lessons.ts:759-760`). It is not reported
  as unreachable, and the caller gets no degraded signal. This is a dependent-client bug.
  Not fixed here: it changes a user-facing status name and belongs with step 3.
- Skills propose already has a queue on the Omp side (`packages/projector/omp/substrate-skills.ts:205-240`),
  drained by the bridge. It was not in scope.

## GREY_AREA decisions (for the orchestrator)
1. **Skills get no explicit key (step 2 deviation).** Approve is exactly-once on
   (repo, name, pr_number) in one transaction. A repeat returns `exists`, not the original status
   `approved`. Propose is exactly-once by content hash through the ledger. A literal key store
   would need a `skills_idempotency` table, a response snapshot, a pre-gh lookup and a new
   validation field, with no in-repo caller. **Recommended default: no key for skills.** Override
   if you want the literal "original result" for approve.
2. **Step 3, lessons-CLI queue: STOPPED, not built.** It needs choices the spec does not make:
   - Where the queue persists. Recommended default: `$SUBSTRATE_STATE_DIR/lessons-queue.jsonl`,
     0600, one JSON line per write, with the write's own deterministic key.
   - What triggers the drain. The CLI is one-shot. Recommended default: drain at the start of
     every `substrate lessons` invocation, in FIFO order, stopping at the first 503. No daemon.
   - How "degraded" is shown. Recommended default: a stderr line and exit 0 for a queued write,
     plus a `queued` status in the JSON report.
   - Bounds. Recommended default: 500 lines, then refuse with a non-zero exit.
   - Whether a replayed lesson can conflict with a later writer. Recommended default: replay
     under the same key and let the gate answer, never re-derive the content.
3. **Keyless behaviour.** The brief says "a write without a key still writes each time". Today a
   keyless identical retry dedupes for 24 h (`memory-write.ts:66`, `:358-365`). I kept today's
   behaviour and tested it. Recommended default: keep it.

## NOT verified by me: tests, tsc
I did not run `bun test`, `bunx tsc --noEmit` or any formatter. The orchestrator runs them once,
with `SUBSTRATE_TEST_PG_URL` set for the live file. Expected to exercise only the new files, since
the tracked files are unchanged.
