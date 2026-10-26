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

## Addendum: audit-found changes (2026-10-24)

Three commits after this phase's verification restored or added exactly-once coverage. `5b5f68f` is test-only. `c74fa07` changes skills production code. `7cf8d44` adds the memory test below and changes docs-ingest's refusal body (see the Phase 35 addendum).

**Commit `5b5f68f`: restores the tests a worktree reset removed.** This supersedes the statement above that `memory-write.test.ts` and `server.test.ts` are unchanged on this branch.
- `packages/mcp-server/src/memory-write.test.ts:2047` (the explicit-key replay), `:2063` (the keyless write) and `:2077` (the outage-then-replay), all in the `exactly-once across a degraded substrate` describe block.
- `packages/mcp-server/src/server.test.ts:2079` and `:2093`: 503 tests through `Substrate.writeMemory` (an index outage, and no index at all).
- Re-run on HEAD 5b5f68f in this run (2026-10-24): `bun test` of memory-write.test.ts and server.test.ts gave 204 pass, 0 fail, 0 skip.

**Commit `c74fa07`: an identical versioned skill proposal answers from the ledger, not 409.**
- The stale check runs after the ledger replay (`packages/mcp-server/src/skills/propose.ts:966-970`; `packages/mcp-server/src/service.ts:3225-3264`). A retry that carries the `expected_version` it first applied gets the ledger answer.
- Tests: `packages/mcp-server/src/skills/propose.test.ts:517` (the versioned retry of an open proposal is answered from the ledger) and `:528` (a refused `beforeWork` opens nothing). `packages/mcp-server/src/http.test.ts` also changed in this commit.

**Commit `7cf8d44`: a keyed memory replay after a newer version is in force.**
- `packages/mcp-server/src/memory-write.test.ts:1653`: a keyed replay after a newer version returns the original entry and writes no row. The test sits in the `exactly-once` describe block.
- No memory production code changed in this commit.

## Files changed
- `packages/mcp-server/src/memory-write.test.ts` (`5b5f68f`, `7cf8d44`).
- `packages/mcp-server/src/server.test.ts` (`5b5f68f`; `7cf8d44` also adds the docs 409 test, see Phase 35).
- `packages/mcp-server/src/service.ts` and `packages/mcp-server/src/skills/propose.ts` (`c74fa07`).
- `packages/mcp-server/src/skills/propose.test.ts`, `packages/mcp-server/src/http.test.ts` and `packages/mcp-server/src/skills-approve.test.ts` (`c74fa07`).
- `packages/mcp-server/src/docs-ingest.ts` (`7cf8d44`, refusal body only).

## Behavior changes
- Skills: an identical versioned proposal replayed with the same `expected_version` returns the ledger answer, not 409 (`c74fa07`).
- Docs: a stale refusal carries `outcome: "conflict"` (`7cf8d44`, see Phase 35).
- Memory: none. The restored and added tests cover behavior that already existed.

## Tests added (not run in this addendum)
- `memory-write.test.ts:2047`, `:2063`, `:2077`, `:1653`: keyed replay, keyless, outage-then-replay, and keyed replay after a newer version.
- `server.test.ts:2079`, `:2093`: 503 for an index outage and for no index.
- `skills/propose.test.ts:517`, `:528`: ledger replay answers before `beforeWork`; refused `beforeWork` opens nothing.

## Rollback
Revert `7cf8d44`, `c74fa07` and `5b5f68f`, in any order. `c74fa07` and `7cf8d44` change production code: reverting `c74fa07` restores the 409 on an identical versioned retry, and reverting `7cf8d44` drops the `outcome` field from the docs stale refusal. `5b5f68f` only removes restored tests. No schema change in any of the three commits.
