---
phase: 61-session-rollback
verified: 2026-10-26
status: gaps_found
score: 5 of 6 success criteria MET in the repository, 1 PARTIAL (criterion 3); no live rehearsal
verified_on: gsd/v16-int at 979b5e2 plus the uncommitted --omp-session flag (phase commits ff51cc7, a26841d, 99ec7e3, 824ceda, 979b5e2)
---

# 61-VERIFICATION: Session rollback to an exact chat moment with file revert

## Gates

Not run by the author of this record. Orchestrator figures for `gsd/v16-int` at 979b5e2: 7480 pass, 2 skip, 0 fail; audit gate 0 unlisted; `check:phase-close` pass; config-reference check pass. The `--omp-session` flag and its tests were uncommitted at that count. Evidence below was read from files and test names.

## Success criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Snapshot, mutate and restore yields tree-hash equality including added, deleted, renamed, mode-changed, symlinked and untracked files; a failed or interrupted restore ends at the pre-rollback or target state after recovery, never partial, and a retry succeeds | MET | `packages/worktree-snapshot/src/restore.test.ts` (`"restores tracked, modified, deleted, renamed, chmod, symlink and untracked files byte for byte"`, `restore: failure handling`, `restore: path safety`); `crash.test.ts` `describe("crash at every operation index")` and `describe("recoverRestore")`; `property.test.ts` (60 seeded random trees restore exactly); `snapshot.test.ts`, `pinned.test.ts`, `policy.test.ts`. Commit ff51cc7. |
| 2 | A dry-run lists the exact changes; drift outside the session is detected and refused without an explicit force; a safety snapshot is always taken first | MET | `packages/cli/src/session/rollback.test.ts`: `describe("dry run")` (`"says a real run would refuse for drift, and still writes nothing to the ledger"`), `describe("drift")` (`"is refused (and reported), then goes through with force and the drifted state is kept in the pre-restore checkpoint"`), `"the pre-restore checkpoint makes the rollback itself undoable, with no drift right after it"`, `describe("a restore that goes wrong")` (`"... is reported honestly with the safety ref"`). |
| 3 | Checkpoints are created at defined boundaries (turn, plan step, steering event, manual) and carry an opaque transcript reference, the git tree, the manifest digest and the ledger chain head | PARTIAL | Carried fields: `session-events.test.ts` `describe("CheckpointPayload")` and `describe("TranscriptRef")`; `cli/src/session/checkpoint.test.ts` (pins, numbers and chains a checkpoint, records it on the server); `session-rollback.test.ts` `describe("session_checkpoint")` (the server attaches `chain_head`); transcript references: `packages/collectors/src/transcript-ref.test.ts`, `cli/src/session/omp-fork.test.ts` (`ompTranscriptRef`), `--omp-session` in `command.ts`. Not met: only `manual` and `pre-restore` are taken (by `substrate session checkpoint` and by `substrate session rollback`). `turn`, `plan-step`, `steering` and `baseline` are accepted values that no code or hook creates automatically (`docs/adr/0007-checkpoint-triggers-and-sibling-hooks.md`). |
| 4 | A rollback appends `session.rollback`; entries and Hindsight documents written after the checkpoint are superseded or forgotten, recall after the rollback excludes them, and the rolled-back history stays retrievable for audit | MET | `session-rollback.test.ts` `describe("session_rollback_commit: committed")` (`"forgets what the caller wrote after the checkpoint, keeps the rest, deletes the plane documents and records the totals once"`, `"a repeat of the same rollback id answers the earlier result without forgetting again"`, `until_ms` and late-recorded cases); `session-rollback-e2e.test.ts` (the real CLI flow against the in-process server; a second run changes nothing); `service-forget.test.ts` `describe("Substrate.memoryForget: recall, the brief and memory search stop serving a forgotten entry")` with `include_superseded` still returning the row. |
| 5 | Transcripts are handled per surface: omp moves its session leaf; other surfaces get a marker event; no transcript is rewritten | MET | `cli/src/session/transcript-port.test.ts` (`omp: fork written once, original untouched`, `omp: stale, not found, unsupported`, `other surfaces and wiring`); `omp-fork.test.ts` (`forkOmpSession: immutability, determinism, round trip`); `rollback.test.ts` `describe("the transcript step")`. omp is handled by writing a new forked session file, not by editing the original. |
| 6 | With the chain unreachable, a rollback still works from local checkpoints and reports them as unanchored | MET | `rollback.test.ts` `describe("the server is not there")`: `"unreachable at plan time: the rollback works from the local refs, says unanchored, queues the commit, and sync delivers it once"`, `"--offline never contacts the server and says so"`; `cli/src/session/pending.test.ts`; exit code 4 (files restored, ledger commit pending). |

## Residual risks

- **Criterion 3:** no hook calls the CLI at turn, plan-step or steering boundaries. Swarm's tool allowlist (`agent-swarm` `omp/src/guard.ts`) does not include the new tools and a Swarm lane's guard blocks `git checkout` and `git restore` in the lane. Hooks are proposals in ADR 0007; no sibling repository was changed.
- Rollback was never rehearsed against the live server or the live ledger.
- The multi-process checkpoint `seq` race has no lock.
- Resuming an omp forked session file is UNVERIFIED for the installed omp; the omp bucket name for a working directory outside the home and temp roots was not checked against a real directory.
- A `verified` memory status in a checkpoint view proves a hash and an anchored cited event, not that the event concerns the entry.
- `refs/substrate/*` can hold untracked files and ignored `.planning/` notes; they must never be pushed (`docs/runbooks/session-rollback.md`, "The checkpoint refs: do not publish them").
- A rollback is crash-recoverable and verified, not atomic across files: a crash leaves the worktree partly restored until `substrate session recover`.
- No REST twin of the three tools exists, so a client without MCP cannot use them.

## Operator-gated

Any rollback against the live server and ledger; enabling the hooks in the sibling repositories; merging.
