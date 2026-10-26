---
phase: 61-session-rollback
milestone: v1.6
requirements: [SOTA-17]
status: implemented on gsd/v16-int (ff51cc7, a26841d, 99ec7e3, 824ceda, 979b5e2, plus 3d95e3e, the --omp-session flag); partial; not merged; no live rehearsal
---

# 61-SUMMARY: Session rollback to an exact chat moment with file revert

## What was built

- **61a, `packages/worktree-snapshot` (ff51cc7, 24 files).** Exact file-state snapshots (tracked, modified, untracked, executable bits, symlinks, `.planning/` allowlisted; credential-shaped files, `.git`, build directories and files over 50 MiB excluded and listed as skipped), a restore plan and a journaled, per-file atomic `restore` with `recoverRestore`, a worktree lock, path safety (no escape and no write through a symlink), and `pinSnapshot` / `listPinned` as parentless commits under `refs/substrate/checkpoints/`.
- **Server tools (a26841d, `session-rollback.ts`, `memory-forget-plane.ts`).** `session_checkpoint` appends a `session.checkpoint` note as the caller's surface and attaches the ledger chain head itself; `session_rollback_plan` (read) answers the target, later checkpoints, the anchor verdict (never blocking) and a `plan_digest`; `session_rollback_commit` records a refused rollback or commits one the client carried out, forgetting memory in bounded idempotent batches and appending one `session.rollback` note with real counts. Admission and the audit policy list them (`admission.ts`, `packages/audit/src/policy.ts`). The server never touches a worktree and never reads a transcript.
- **CLI (99ec7e3, 979b5e2).** `substrate session checkpoint | checkpoints | rollback | recover | sync` (`packages/cli/src/session`), a pending journal with replay (`sync`), exit codes 0 to 4, an omp fork adapter (`omp-fork.ts`) and a transcript port (`transcript-port.ts`), transcript references for cursor and grok (`packages/collectors/src/transcript-ref.ts`). The rollback order: recover, resolve the target from local refs, plan (a dry run stops here), refuse on drift or an anchor `mismatch` unless `--force`, take a pre-restore checkpoint and a safety ref, restore, then commit to the server.
- **`--omp-session FILE` (3d95e3e).** `substrate session checkpoint --omp-session FILE` reads an omp session JSONL (at most 32 MiB) and records a transcript reference to its last physical entry (entry id, parent id, user-turn count, prefix digest, base name only); an unreadable or unparseable file still gives a checkpoint, without a reference, and says why. Documented in `docs/runbooks/session-rollback.md`.
- **Runbook** `docs/runbooks/session-rollback.md`, **ADR 0005** (rollback semantics) and **ADR 0007** (checkpoint triggers and sibling hook proposals).

## Key decisions

- Local files are the facts and the ledger records them (ADR 0005); the local registry is git refs, so rollback works offline and reports unanchored.
- Forgotten, not deleted: later memory is marked through the phase 57 marker.
- No TimescaleDB step; no REST twin.

## Deviations from the plan

- **Criterion 3 is partial:** the trigger values exist (`turn`, `plan-step`, `steering`, `manual`, `pre-restore`, `baseline`), the CLI takes `manual` and `pre-restore`, and no hook takes `turn`, `plan-step` or `steering` automatically. Hooks are proposals in ADR 0007; Swarm's tool allowlist (`agent-swarm` `omp/src/guard.ts`) does not include the new tools, and no sibling repository was changed.
- The ROADMAP's TimescaleDB opt-in schema step was not built; ROADMAP Phase 61 target files are corrected.
- ROADMAP lists Phase 58 as a dependency; the built phase uses none of its code.

## Findings (defects found and fixed)

- A checkpoint recorded late (server offline) cut memory at the record time, silently keeping memory written in between: `taken_at_ms` was added and the server cuts at the earlier of the record time and the taken-at time (824ceda).
- A commit delivered late would have forgotten memory written after the local rollback, which belongs to the new timeline: `until_ms` bounds the plan and the commit (824ceda).
- A path below a directory that the plan turned into a file raised `ENOTDIR` in the restore; found by the seeded property test (`worktree-snapshot/src/property.test.ts`, 60 seeded random trees) and fixed in `apply.ts` (`lstatOrNull` treats `ENOTDIR` as absent) with a regression test; the case `restore.test.ts` "files deleted under a directory that the target holds as one file restore exactly" looks like it, but which test is the regression test was not confirmed (UNVERIFIED).
- The CLI now maps the server's not-found to the `target-not-found` refusal (824ceda).

## Findings not fixed (residual)

- The multi-process checkpoint sequence race: two processes taking a checkpoint for one session at once can collide on `seq` (no lock).
- Resuming an omp forked session file is unverified for the installed omp.
- A checkpoint's `verified` memory status proves a hash and an anchored cited event, not that the event concerns the entry.
- Rollback was not rehearsed against the live server or ledger.

## What remains

- Hooks that take `turn`, `plan-step` and `steering` checkpoints; Swarm's allowlist; the live rehearsal; the `substrate session` commands are not yet used by any sibling.
