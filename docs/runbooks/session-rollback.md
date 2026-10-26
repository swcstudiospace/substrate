# Runbook — checkpoint a session, roll the worktree back to a checkpoint, undo a rollback, recover a crashed one

| | |
| --- | --- |
| Question | An agent session went wrong at some point: how do I put the files back exactly as they were at an earlier checkpoint, with the ledger telling the truth about it? |
| Trigger | A bad turn, a plan step that went the wrong way, a steering directive that was applied too eagerly, or a worktree left half restored by a crash |
| Who | The operator working in the worktree, or an agent given the `substrate session` commands. A rollback changes files in **this worktree only**. |
| Scope | One git worktree, one session at a time. Local checkpoints (pinned git refs) are the working registry; the substrate server records the checkpoint and the rollback as ledger notes and, on commit, takes the session's later memory out of force. |
| Blast radius | Files in the worktree (restored to the checkpoint; every file the restore changes is first saved in a pre-restore checkpoint and a safety ref). The ledger gains notes. Memory this surface wrote in the session after the checkpoint is **superseded, not deleted**. The transcript is **never rewritten**. |

## The stance

- **The files are the facts.** The server never touches a worktree and never reads a transcript. `substrate session rollback` does every file operation locally; the server is told ids, digests and counts.
- **Nothing is deleted from the ledger.** A rollback appends a `session.rollback` note (and a `session.rollback.refused` note when it refuses). The checkpoint notes before it stay. The ledger is append-only and hash-chained.
- **Integrity is not truth.** A checkpoint that verifies says the files and the ledger note are the ones recorded at the time. It does not say the work in them was good.
- **Devnet only, roots only.** If the ledger's hourly root was anchored, the anchor lives on Solana devnet and carries a Merkle root, never an event or a file. See "What the ledger and the anchor prove" below.

## What a checkpoint is

`substrate session checkpoint` snapshots the exact file state of the worktree and pins it as `refs/substrate/checkpoints/<ckpt id>` (a parentless commit whose tree is the snapshot). The session id, the sequence number, the trigger, an optional transcript pointer and an optional plan reference travel in the pinned commit's message, so the refs **are** the local checkpoint registry: listing and rolling back work with the server unreachable.

**Boundaries — what a checkpoint holds, and what it never does:**

| Included | Not included |
| --- | --- |
| tracked files, modified files, untracked files that are not ignored, executable bits, symlinks | paths git ignores (except the allowlist, `.planning/` by default) |
| `.planning/` even when it is gitignored (the default allowlist) | `.git`, `node_modules`, `.venv`, `target`, `dist`, `build`, `.next`, `.turbo`, `__pycache__` at any depth |
| | `*.log`, and files above 50 MiB |
| | credential-shaped files: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*.p12`, `credentials*.json`, `*.keystore` |
| | nested git repositories (they appear as directories and are not entered) |

A checkpoint lists what it skipped (`skipped <path> (<reason>)`), so a missing file is explained, not silent. A restore neither writes nor deletes an excluded path: the files a checkpoint does not hold are not touched by a rollback either.

**Triggers** (the `--trigger` value): `turn`, `plan-step`, `steering`, `manual` (the default), `pre-restore`, `baseline`. The CLI takes a checkpoint when you run `substrate session checkpoint`. Which hooks, plan steps or steering integrations call it automatically at this release is **UNVERIFIED**: check what your surface's hook configuration actually runs before relying on a checkpoint existing at a boundary you did not take yourself.

**The ledger sees a checkpoint as** a `session.checkpoint` note: ids, a git tree id, a manifest digest and counts. Never file, transcript or memory content.

## The commands

```
substrate session checkpoint  [--session ID] [--surface S] [--trigger T] [--transcript-ref JSON | --omp-session FILE] [--plan-phase P] [--plan-step S] [--json]
substrate session checkpoints [--session ID] [--surface S] [--offline] [--json]
substrate session rollback <ckpt|seq|previous> [--session ID] [--surface S] [--dry-run] [--force] [--offline] [--json]
substrate session recover [--json]
substrate session sync [--json]
```

| Exit | Meaning |
| --- | --- |
| 0 | done |
| 1 | failed (see the printed code; a failed restore says whether it rolled itself back and prints the `recover` command) |
| 2 | usage: a wrong flag is refused **before** any work |
| 3 | refused: drift, an anchor mismatch, an unknown target, or a target that belongs to another session |
| 4 | **the files were restored** but the ledger commit is pending: run `substrate session sync` |

The session id comes from `--session`. With no flag it is the one session that has local checkpoints in this worktree; with none or several the command refuses and asks for `--session`. `--surface` (default `claude-code`) selects the bearer; the server binds a session to the surface that wrote it.

Every line of output is scrubbed: the bearer, anything the redactor recognises, and absolute paths (`<worktree>`, `~`).

## A worked example

The shapes below follow the command's output format; ids are invented.

```sh
# 1. Take a checkpoint before something risky.
substrate session checkpoint --session sess-demo --trigger manual
#   checkpoint ckpt_01j9xk4m7q2r8s5t3v6w0y1z2a (seq 3) ...
#     tree <40 hex>; 212 file(s)
#     ledger: recorded

# 2. ... the work goes wrong ...

# 3. See what exists.
substrate session checkpoints --session sess-demo
#   sess-demo  seq 3  ckpt_01j9xk4m7q2r8s5t3v6w0y1z2a  manual  2026-10-26T09:00:00.000Z  ledger recorded, anchor pending
#   sess-demo  seq 2  ckpt_...                          turn    ...

# 4. Rehearse. Changes nothing, prints the plan, the drift and what a real run would refuse.
substrate session rollback ckpt_01j9xk4m7q2r8s5t3v6w0y1z2a --session sess-demo --dry-run
#   anchor: pending
#   plan: 2 add, 5 modify, 1 delete, 0 chmod, 0 retype (8 total)
#     modify src/app.ts
#     ...
#   memory: 3 entries would be forgotten
#   dry run: nothing was changed

# 5. Do it.
substrate session rollback ckpt_01j9xk4m7q2r8s5t3v6w0y1z2a --session sess-demo
#   rolled back to ckpt_01j9xk4m7q2r8s5t3v6w0y1z2a (seq 3); ledger event <event id>
#   files: 2 added, 5 modified, 1 deleted; safety ref refs/substrate/safety/<id>
#   pre-restore checkpoint ckpt_... (ledger recorded)
#   transcript: moved-leaf (forked omp session written as ...; resume it with: omp --resume <id> ...)
#   memory: 3 superseded, 3 forgotten
```

`<ckpt|seq|previous>` is a checkpoint id, a sequence number of this session's local checkpoints, or `previous` (the session's newest checkpoint). An unknown target, or a checkpoint of another session, is refused (exit 3) and the refusal is reported to the server, fail-open.

## What a rollback does

1. **Finishes any interrupted restore first** (`recoverRestore`) and tells you. Every run starts here, so the worktree is never left half restored without anyone being told.
2. Resolves the target from the local refs, and asks the server for a plan (the anchor verdict, how many memory entries would be forgotten, a `plan_digest`).
3. Plans the restore: the exact adds, modifications, deletions, mode changes and type changes. `--dry-run` stops here.
4. Refuses on drift or an anchor mismatch unless `--force` (below).
5. **Takes a `pre-restore` checkpoint of the current state and a safety ref before any file is touched.**
6. Restores the files, then verifies that the worktree tree equals the target tree. On a handled failure it reverse-applies the safety snapshot itself.
7. Does the transcript step (the per-surface table below).
8. Commits to the server with the plan digest. The server takes the memory entries **this surface** wrote in the session after the checkpoint **out of force** (recall, search and the brief stop serving them; the rows and the ledger stay), deletes their Hindsight documents, and appends one `session.rollback` note with the real totals.

## What a rollback does NOT do

- **It is not atomic across files.** Each file is replaced atomically (temp file, fsync, rename) but the set of files changes one at a time. A crash in the middle leaves the worktree partially restored **until `substrate session recover`** (or the next `rollback`, which recovers first) completes it. It is crash-recoverable and verified, not instantaneous.
- **It restores file state only:** contents, the executable bit and symlinks. The real git index, `HEAD`, the branch and the stash are never modified.
- **Empty directories are not restored** (git does not track them). Directories emptied by a deletion that the target has no entry under are removed.
- **Excluded paths are not restored** (the table above): secrets, dependency trees, build output, logs and big files are in neither tree. A target path that would have to overwrite an excluded file or directory fails the restore, and the restore rolls itself back, instead of clobbering it.
- **`.gitattributes` conversion** (`text`, `eol`, `filter`) is applied by git when it hashes the worktree. If it makes the re-hash of a restored file differ from its stored blob, verification fails and the restore is rolled back. It never reports a false success; it may refuse a worktree that uses such conversion on a restored path.
- **A file written by another process during the restore is not protected.** The lock serialises restores, not writers.
- **Memory is not deleted.** It is superseded: taken out of force, never erased from the index or the ledger. Memory written by **other surfaces**, and memory written **before** the checkpoint, is untouched.
- **The transcript is never rewritten, truncated or deleted.** See below.
- **It does not push, fetch or commit anything.**

## The transcript, per surface

The port never edits a transcript. It either **forks** (omp) or leaves a **marker** (the `session.rollback` ledger note), and says which.

| Surface | What a checkpoint must carry | Outcome of a rollback |
| --- | --- | --- |
| `omp` | `--omp-session FILE` (below), or a `--transcript-ref` built by `ompTranscriptRef`: the session file's name or id, the entry id, and a digest of the path up to it | `moved-leaf`: a **new** session file holding only the root-to-checkpoint path is written next to the original (exclusive create, mode 0600, never overwriting); the original is not touched. The output names the new file and the line to run. `stale`: the original no longer matches the checkpoint (a prefix digest mismatch, or the entry is gone, for example after a compaction): **no file is written**. `unsupported`: the original is not in this directory's omp bucket, two files match, the ref has no entry id or digest, the bucket is not the default one, or the file cannot be read or written |
| any other surface (`claude-code`, `cursor`, `grok-build`, ...) | a `--transcript-ref` for that surface | `marker-only`: no transcript is touched; the ledger note is the marker |
| any surface, checkpoint taken with no transcript pointer | nothing | `unsupported`: the files are still restored |

The outcome is recorded in the `session.rollback` note (`moved-leaf`, `marker-only`, `unsupported` or `stale`). A failing transcript step never undoes or fails the file restore.

**omp specifics.**
- The original is found by **file name only** in the omp sessions bucket of the working directory (`~/.omp/agent/sessions/<encoded cwd>/`, encoded as `omp://session.md` describes), by an exact match on the locator the ref carries (a file name, with or without `.jsonl`, or the session id). The search lists the directory once and is capped at 20,000 names. It tries the current directory and then the git top level. An omp started with another `--profile` or agent directory keeps its sessions elsewhere: that is reported as `unsupported`, never guessed.
- Run the rollback from the directory omp was started in.
- The fork gets a new session id, a header whose `parentSession` names the original file, and a title slot copied from the original.
- **Resuming a forked file is UNVERIFIED for the installed omp version.** The line printed (`omp --resume <new session id>`) uses omp's documented resume-by-id flag; nothing here proves omp resumes a file it did not write. If it does not, the forked file is still an ordinary, valid session JSONL the original omp tooling can open, and the original is intact.
- **`substrate session checkpoint --omp-session FILE` produces the omp transcript ref** (`ompTranscriptRef` in `packages/cli/src/session/omp-fork.ts`; the flag is handled in `packages/cli/src/session/command.ts`). `FILE` is the omp session JSONL of the session being checkpointed, 1 to 4096 characters. The command reads it (a regular file, at most 32 MiB), parses it as an omp version 3 session, and records a reference to its **last physical entry**, which is how omp defines the leaf on load. That can be a metadata entry (a usage or title record) rather than a chat message; a caller that means a specific message builds the ref with `ompTranscriptRef` and passes `--transcript-ref` instead. The reference holds the file's **base name** as `session_locator` (never the path), the entry id, its parent entry id, `turn_no` (the number of user messages on the path from the root to that entry), and a digest of that path. It holds no message content.
- **A file that cannot be used still gives a checkpoint, without a reference.** If `FILE` cannot be read (a missing file, not a regular file, a permission error: reason `unreadable`), is over 32 MiB (`too-large`), or does not parse as an omp session (the other `OmpForkError` codes, for example `header-invalid`, `malformed-line`, `chain-broken`, `unsupported-version`), the checkpoint is created exactly as if the flag had not been given, and the command says so: the text output starts with `transcript reference NOT recorded (--omp-session: <reason>); the checkpoint was made without one`, and `--json` adds `transcript_ref_skipped: {source: "omp-session", reason}`. Only the reason code is printed, never the path or the file's content. Exit status is still 0. Such a checkpoint rolls back with transcript outcome `unsupported` (the files are still restored).
- `--omp-session` and `--transcript-ref` are mutually exclusive: passing both is a usage error (exit 2) before any work. A hook or extension that takes checkpoints automatically must still call the command with the flag; that hook is **not built here**.
- The fork copies the original's entries byte for byte, so it carries whatever those entries hold. Treat the new file like the original.

## Drift, `--force`, and what blocks a rollback

**Drift** means the worktree is not at any checkpoint of the session: its tree matches none of them, and it differs from the newest by changes no checkpoint holds. Right after a rollback the worktree **is** at the target's tree, so rolling back again is not drift.

A rollback refuses (exit 3, and the refusal is recorded as `session.rollback.refused`, fail-open) when:
- the worktree has drifted (work that no checkpoint holds would be lost), or
- the server says the target's anchor is `mismatch` (a read that succeeded disagrees with the ledger).

Refusing is the point: take a checkpoint first (`substrate session checkpoint`), or pass **`--force`**. `--force` overrides **both** the drift check and an anchor mismatch; each is printed as a warning. It does not skip the pre-restore checkpoint or the safety ref, so a forced rollback is still undoable.

## Undoing a rollback

Every real rollback first took a `pre-restore` checkpoint of the state it replaced and printed its id. To undo:

```sh
substrate session checkpoints --session sess-demo        # the pre-restore checkpoint is listed (trigger pre-restore)
substrate session rollback ckpt_<the pre-restore id> --session sess-demo --dry-run
substrate session rollback ckpt_<the pre-restore id> --session sess-demo
```

That restores the **files** as they were. It does **not** bring back what the first rollback took out of force in memory: those entries stay superseded, and nothing in this tooling re-enables them. Restoring that memory is an operator decision made through the memory governance path, not part of undoing a rollback. The forked omp file from the first rollback is still on disk; it is harmless.

The safety ref (`refs/substrate/safety/<id>`) is a second copy of the pre-restore state, kept by the restore itself. It is what a failed restore rolls back to.

## Offline, exit code 4, and `sync`

- `--offline` (or an unreachable server) makes the rollback run from the local checkpoint refs **without** the server plan: the output says `mode: local only (...); checkpoint is UNANCHORED`. Nothing about the ledger was consulted, so an anchor mismatch cannot be detected, and the memory preview is not available. The files are restored exactly the same way.
- When the ledger commit cannot be delivered (the server is down, or the plan changed twice), the **files stay restored** and the commit is queued in the pending journal under `<git dir>/substrate-pending/` (mode 0600, bounded to 500 items, never part of a snapshot). The command exits **4** and prints `files restored, ledger commit pending (run substrate session sync)`.
- `substrate session sync` delivers the queue. Replay sends the same idempotency inputs as the first attempt (the checkpoint id and seq, or the rollback id), so repeating it is harmless. An item is removed only after the server acknowledges it; a corrupt pending file is reported and skipped, never deleted. A rollback queued without a plan is planned first at replay time.
- Until the commit is delivered, **the session's later memory is still in force**: only the ledger commit takes it out.

## Crash recovery

If the process dies mid-restore, the worktree is partially restored. A journal under the git directory records the restore.

```sh
substrate session recover
#   recovered restore <id> (completed): 2 added, 5 modified, 1 deleted; safety ref refs/substrate/safety/<id>
```

`recover` finds the journal and completes the restore **forward** to the target (every operation is idempotent), or reports `nothing to recover`. `rollback` runs the same recovery first. If a restore fails and cannot roll itself back, the output names the safety ref, whether it rolled back (`yes`, `NO` or `unknown`) and the command to run. The safety ref restores the pre-restore state with a second rollback.

## What the ledger and the anchor prove, and do not

| | Says | Does not say |
| --- | --- | --- |
| `session.checkpoint` / `session.rollback` notes | this surface recorded a checkpoint or a rollback with these ids, digests and counts, in this session's chain, at this time | what the files contained, or that the restore matched (the client reports it; the server never saw a worktree) |
| The hash chain | the notes were not altered or removed after being written | anything about notes that were never written (a rollback made offline and never synced leaves none) |
| An hourly Merkle **root** on Solana **devnet** (`anchored`) | the note existed by that hour | the note's contents (a root holds none), that the checkpoint's files are right, or that devnet will keep it: devnet may reset, and the roots also live in the ledger's own table |
| `pending` / `unanchored` / `unverified` | the hour is not closed yet, no root was written, or the check could not settle it | tampering. These are never verdicts of tampering. Only `mismatch` says a read that succeeded disagrees |

`substrate session checkpoints` prints each checkpoint's ledger state and anchor status (it asks the server about at most the 20 newest). For a single checkpoint, the `checkpoint_verify` MCP tool answers the same question with its evidence.

## The checkpoint refs: do not publish them

A snapshot tree can hold untracked files and gitignored `.planning/` notes. **Never** run `git push --mirror`, `git push --all`, or any refspec that matches `refs/substrate/*` from a repository that holds pins, and do not add `refs/substrate` to a fetch or push refspec. Git does not fetch or push that namespace by default; keep it that way. Pruning old pins is a manual `git update-ref -d refs/substrate/checkpoints/<id>` followed by normal git garbage collection; nothing here deletes a checkpoint for you.

## UNVERIFIED and open

- Whether the installed omp resumes a forked session file (above).
- Which hooks or integrations take `turn`, `plan-step` or `steering` checkpoints automatically at this release.
- Who takes omp checkpoints automatically: `--omp-session` exists, but no shipped hook calling it was verified.
- The omp bucket name for a working directory outside the home directory and the temp root follows the rule in `omp://session.md` (`--<encoded absolute path>--`) but was not checked against a real directory.
- Rollback was not rehearsed against the live server or the live ledger by the work that wrote this runbook.
