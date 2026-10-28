# ADR 0005: Session rollback semantics: append-only, local files, superseded memory, an untouched ledger

- **Status:** Accepted (the design as built on this branch; the live server and ledger have not been exercised by a rollback rehearsal)
- **Date:** 2026-10-26
- **Tickets:** v1.6 phase 61 (SOTA-17); phase 62, success criterion 2
- **Deciders:** Spectrum Web Co platform
- **Affects:** `packages/worktree-snapshot/src`, `packages/cli/src/session/*`, `packages/mcp-server/src/{session-events,session-rollback,memory-forget,checkpoint-verify}.ts`
- **Operator procedure:** `docs/runbooks/session-rollback.md`

## Context

An agent session goes wrong at some chat moment. The operator wants the files back exactly as they were at an earlier point, the chat position recorded, and the memory written after that point to stop influencing recall, with the ledger telling the truth about all of it.

Fixed by earlier decisions: the ledger is append-only and hash-chained (ADR 0004); `EVENT_KINDS` and `SURFACES` do not change; and **decision D52-g**, the substrate stays read-only on session worktrees (`.planning/phases/55-migration-safety/CONTEXT.md`, correction 10). The Swarm guard independently blocks `git checkout` and `git restore` inside a lane (`agent-swarm` `omp/src/guard.ts`, the destructive-git rule), so a server that tried to run git in a lane would be refused where it mattered most.

## Decision

### 1. Append-only

A rollback is a **new** ledger event, never a mutation. `session.rollback` (kind `note`) carries `target_event_id` and `target_hash` pointing at the checkpoint it returns to, the pre-restore tree and checkpoint, file counts, the memory totals and the transcript outcome. A refusal is `session.rollback.refused` (kind `warning`) with a closed reason set. Checkpoints are `session.checkpoint` notes. Contract: `packages/mcp-server/src/session-events.ts`; vocabulary rows: `docs/event-vocabulary.md`. The notes carry ids, counts and digests, never content, and are capped at 16,000 bytes.

### 2. What is restored: files, by tree equality

`restore()` in `packages/worktree-snapshot/src/restore.ts` plans the exact adds, modifications, deletions, mode changes and type changes, applies them one file at a time, and then **verifies that the worktree's git tree equals the target tree**; on a handled failure it reverse-applies the safety snapshot. A snapshot is built through a temporary index (tracked, modified, untracked-not-ignored files, executable bits, symlinks, and `.planning/` even when ignored) and the real index is never touched. The stated limits, all in the restore header and the runbook:

- excluded paths are in neither tree and a restore neither writes nor deletes them: git-ignored paths except the allowlist, `.git`, `node_modules`, `.venv`, `target`, `dist`, `build`, `.next`, `.turbo`, `__pycache__`, `*.log`, files over 50 MiB, credential-shaped files (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*.p12`, `credentials*.json`, `*.keystore`) and nested repositories (shown as directories, not entered). A target path that would have to overwrite an excluded file fails the restore, which rolls itself back;
- empty directories are not restored; directories emptied by a deletion are removed;
- `.gitattributes` conversion (`text`, `eol`, `filter`) can make verification fail, in which case the restore is rolled back and never reports a false success;
- the restore is **not atomic across files**; each file is replaced atomically (temp file, fsync, rename) but a crash leaves the worktree partial until recovery;
- a file written by another process during the restore is not protected: the lock serialises restores, not writers.

### 3. What is superseded: memory, by marker

Memory this surface wrote in the session **after** the checkpoint is taken out of force, not deleted: the index row's `superseded_by` becomes `forgotten:<forget_id>`, the Hindsight plane document is deleted, the row and the ledger stay (`memory-forget.ts`, ADR 0004 section 4). Scope is deliberately narrow: only the **caller's surface**, only that session, only entries created after the checkpoint's cut. Memory written by other surfaces or before the checkpoint is untouched. The cut is the earlier of the checkpoint's ledger record time and its client-supplied `taken_at_ms` (a checkpoint recorded late still cuts at the moment it was taken; honoured from 30 days before to 30 seconds after the record time, else ignored with a warning). The upper bound is `until_ms`: memory created after it belongs to the new timeline and is never forgotten, so a commit delivered late does not erase work done since. Nothing in this tooling re-enables forgotten memory; undoing a rollback restores files only (runbook, "Undoing a rollback").

### 4. What is never touched

The ledger (no deletion or rewrite), every transcript (never rewritten, truncated or deleted), the real git index, `HEAD`, the branch, the stash, and the remote (no push, fetch or commit).

### 5. Who executes

The **CLI**, `substrate session rollback`, under the session's own authority (the surface's bearer, run in the worktree). The **server only plans, verifies and audits** (D52-g): `session_rollback_plan` (read-only; returns the target, the later checkpoints, the anchor verdict, how many memory entries would be forgotten, and a `plan_digest`), then, after the client has restored its own files, `session_rollback_commit` (recomputes the plan, answers `stale-plan` and changes nothing if the digest no longer matches, otherwise forgets the memory and appends `session.rollback`). The digest covers what the rollback decides and not the later checkpoint list, so the pre-restore checkpoint the client takes in between does not invalidate it. `session_checkpoint` records the checkpoint note. The server never reads a transcript either. Evidence: `packages/mcp-server/src/session-rollback.ts` (header), `packages/cli/src/session/rollback.ts`, `packages/mcp-server/src/mcp.ts` (the three tools).

### 6. Crash safety

Order inside a rollback: finish any interrupted restore (`recoverRestore`); resolve the target from the local refs; plan (dry-run stops here); refuse on drift or an anchor `mismatch` unless `--force`; take a **pre-restore checkpoint and a safety ref** (`refs/substrate/safety/<id>`) before any file changes; write the **journal** under the git directory; apply; verify; transcript step; server commit. `substrate session recover` (or the next rollback) completes an interrupted restore **forward** to the target, because every operation is idempotent; the safety ref restores the pre-restore state with a second rollback. A forced rollback still takes both safeguards.

### 7. Offline behaviour

The working registry is **local**: checkpoints are parentless commits pinned under `refs/substrate/checkpoints/<ckpt id>`, with session id, sequence, trigger, transcript pointer and plan reference in the commit message, so listing and rolling back work with the server down. With `--offline` or an unreachable server the rollback runs without a server plan, prints `mode: local only`, reports the checkpoint as **unanchored** (an anchor `mismatch` cannot be detected and the memory preview is unavailable), restores the files the same way, and queues the ledger commit in a **pending journal** (`<git dir>/substrate-pending/`, mode 0600, at most 500 items, never part of a snapshot). The command exits 4 (files restored, ledger commit pending); `substrate session sync` replays with the same idempotency inputs. Until the commit is delivered the session's later memory is still in force. The `taken_at_ms` and `until_ms` bounds in section 3 exist for exactly this case. With the chain down but the server up, the plan's anchor check is bounded (4 s) and fails open: the rollback proceeds and refuses on `mismatch` only, never on `unverified` or `pending` (`docs/runbooks/anchor-chain-outage.md`).

### 8. Transcripts, per surface

No transcript is ever edited. **omp**: a **new** session file holding only the root-to-checkpoint path is written next to the original (exclusive create, mode 0600), outcome `moved-leaf`; a changed prefix or a missing entry (for example after a compaction) is `stale` and writes nothing; an original that cannot be found, read or matched is `unsupported`. **Every other surface**: `marker-only`, the `session.rollback` note being the marker. A checkpoint with no transcript pointer gives `unsupported`, and the files are still restored. A failing transcript step never undoes or fails the file restore. Per-surface locators: `packages/collectors/src/transcript-ref.ts` (an explicit `null` where a surface has no verifiable per-turn id), `packages/cli/src/session/{omp-fork,transcript-port}.ts`.

### 9. Idempotency

A checkpoint is idempotent by `ckpt_id` (a repeat answers `stored: false` with the existing event). A rollback commit is idempotent by `rollback_id` (a repeat answers the earlier result without forgetting again; a pending plane deletion is retried; if the forget cannot complete nothing is recorded and the answer is `forget-incomplete`, retryable). The CLI mints the rollback id once and a replay from the pending journal reuses it. The ledger's own key (`ckpt:<session token>:<seq>`, `rb:<session token>:<rollback id>`) dedupes only under `SUBSTRATE_EVENT_IDEMPOTENCY=accept|enforce`.

### 10. Refusals

Drift (the worktree matches no checkpoint of the session and differs from the newest by changes no checkpoint holds) and an anchor `mismatch` refuse with exit 3 and a `session.rollback.refused` note (fail-open). `--force` overrides both, prints each as a warning, and does not skip the safeguards of section 6.

## Alternatives rejected

- **Server-side revert.** Breaks D52-g, requires the server to reach every worktree on every host, and would make the server a remote write path into agent workspaces. In Swarm lanes the guard blocks the git commands it would need.
- **`git reset --hard`, `git checkout` or `git stash` as the mechanism.** They move `HEAD`, the branch or the index, discard untracked work, offer no journal and no undo, and `stash` mutates the worktree and omits ignored files by default. The temporary-index tree captures untracked files and leaves the real index, `HEAD`, branch and stash alone.
- **Rewriting or truncating transcripts.** Each surface owns its transcript and most have no verified schema (Claude Code's layout, Cursor's per-turn ids and Muse's store were not verifiable here, `/tmp/recon/R7.txt`). Editing them destroys evidence; forking (omp) or marking (the rest) loses none.
- **Deleting memory rows.** Breaks the audit trail, the `entry_hash` verification, capsule roots and ADR 0003's tombstone model. Supersession keeps the history retrievable and the recall clean.
- **Deleting or rewriting ledger events.** Impossible by design (ADR 0004) and defeats the point of anchoring.

## Consequences and open points

- Rollback is crash-recoverable and verified, **not instantaneous or atomic**.
- Snapshot cost on a large worktree has not been measured by this work (UNVERIFIED); it matters for per-turn checkpoints (ADR 0007).
- Whether the installed omp resumes a forked file it did not write is UNVERIFIED; the original is intact either way.
- No rollback was rehearsed against the live server or ledger (runbook, "UNVERIFIED and open").
- `refs/substrate/*` can hold untracked files and ignored `.planning/` notes: never publish them (`git push --mirror`, `--all`).
- Integrity is not truth: a verified, anchored checkpoint says the note and the files are as recorded, not that the work was good.

## References

- `docs/runbooks/{session-rollback,anchor-chain-outage,consistency-verify}.md`, `docs/event-vocabulary.md`
- ADR 0003, ADR 0004, ADR 0006, ADR 0007
