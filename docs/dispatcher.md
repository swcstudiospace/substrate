# substrate-dispatcher

Turns a Linear `dispatch:<surface>` label into a Hermes session in a
per-Graph-ID worktree — or one named refusal comment. The dispatcher never
decides ownership: main's lease verdicts stay authoritative. It polls,
prepares a worktree, launches a session, and watches for a landed claim.

## The 30 s loop

`python3 -m substrate_dispatcher` (unit `infra/vps/substrate-dispatcher.service`):

1. Take an exclusive flock on `STATE_DIR/dispatcher.lock`. A second holder
   prints a message and exits 3 without polling.
2. Re-read `SUBSTRATE_ENV_FILE` every tick. `SUBSTRATE_DISPATCH_DISABLED=1`
   stops the tick before any call. Staged default and end state: **on**.
   It is `0` only inside the bounded, operator-approved live window, and
   the proof ends by setting `1` back.
3. Reap (watch, time out, kill) then tick (poll → resolve → decide → act).
4. `--once` without `--dry-run` is refused: a real launch must stay under
   the loop's claim watch. Rehearsal is `--once --dry-run`.

At most 2 dispatched sessions, one per issue. A terminated session keeps
its slot until its process exits or is killed.

## Markers

Each non-dispatch decision posts at most one once-only comment per marker. Body starts
with `substrate-dispatcher:` and carries the stable `[<marker>]` tag; the comment is
skipped when the tag is among the issue's last 50 comments, so a decision repeated on
later ticks (for example `at-capacity`) posts nothing new. A session already running
for the issue posts one `already-running` comment; an issue the registry gave up on is skipped without a comment.

| Marker | Meaning | Retried? |
| --- | --- | --- |
| `not-dispatchable` | surface is not hermes/claude-code | no (comment only) |
| `no-node` | no registered graph node for the issue | next tick |
| `already-claimed` | node already claimed | next tick |
| `invalid-graph-id` | graph id unsafe as worktree name | no |
| `invalid-ids` | identifier/node/graph/repo unsafe for the prompt | no, gives up |
| `no-checkout` | no verified checkout of the repo on this host | next tick |
| `low-disk` | under `SUBSTRATE_WORKTREE_MIN_FREE_GB` (default 5 GiB) free on the filesystem holding the first `SUBSTRATE_WORKTREE_ROOTS` entry, or on `/` when none is set ([worktree-fleet.md](worktree-fleet.md)) | next tick |
| `path-conflict` | worktree path taken by something untracked | next tick |
| `git-failed` | git could not prepare the worktree | next tick |
| `host-refused` | substrate-host refused the task | next tick |
| `host-unreachable` | substrate-host not reachable, or a 401/403 rejection | next tick after a connect failure or a 401/403; after an ambiguous reply, when `readopt()` resolves the kept record; emits nothing |
| `exited-unclaimed` | hermes exited without claiming; label removed | no, gives up |
| `claim-timeout` | no claim in 15 min; label removed | no, gives up |
| `at-capacity` | every dispatch slot is busy (at most 2 sessions); queued, not dispatched | next tick; emits nothing |
| `graph-busy` | this graph already has a running session; queued, not dispatched | next tick; emits nothing |
| `already-running` | a session for this issue is already running; no second launch | next tick; emits nothing |

Give-ups persist in `STATE_DIR/given_up.json` (0600, atomic replace) and survive a restart: a new process never relaunches a given-up issue. A dispatcher restart ends every dispatched Hermes session, by design: the unit keeps the default `KillMode=control-group`, so a stop or restart takes the sessions in its cgroup with it. VM tasks (`dispatch:claude-code`) run on substrate-host outside that cgroup, and the dispatcher re-adopts their persisted records from `vm_tasks.json` under `STATE_DIR` on its next start.

## Session lifecycle

1. `validate_ids`: id regexes before any checkout or worktree.
2. `repo_checkout`: `<root>/<name>` must exist with `.git` and a matching
   origin — else `no-checkout`.
3. Worktree at `/var/lib/substrate/worktrees/<graph_id>` on branch
   `substrate/<graph_id>`: reused iff git registers it, else created.
   Nothing ever deletes a directory or touches the main checkout.
4. Prompt rendered to `STATE_DIR/prompts/<graph>.md` (0600): ids only.
   The session claims with its **own** hermes token, read at session
   runtime from the Phase 20 tokens-dir file — the stored prompt carries
   the path, never a value. It retains the claim reply's `lease_id` and
   passes it to every later call, renewing with `graph_heartbeat` at
   least every 10 minutes (the lease lapses at 15). Issue text is fetched
   at runtime via `issue_get` and labelled UNTRUSTED.

`dispatch:claude-code` opens a VM task on substrate-host through the same
registry contract: the tick routes the candidate through `HostClient`
(`POST /tasks` on the loopback API) and watches the returned `RemoteTask`
with the identical reap — landed-claim evidence counts as success, an
exit-without-claim gives up as `exited-unclaimed`, 900 s without evidence
times out as `claim-timeout`. The POST body carries graph/node/identifier/
repo/worktree ids only with the substrate bearer header, never issue text.

### Live claude-code route (Phase 33)

Proven against fakes in `packages/dispatcher/tests/test_claude_code_route.py`
and `scripts/dispatcher-driver.py` S11–S16, and end to end in
`scripts/lane-a-e2e.ts`: tick → `POST /tasks` 202 → `RemoteTask` →
landed-claim (`claimed_by`, state transition, or mirror comment) → success
with `dispatch.outcome{launched}`; 400/409/502 → `host-refused` once-only
comment (the host's text stays in the journal, never in the comment) and one
`dispatch.failed`; a connect failure → `host-unreachable` comment with no event, retried on a
later tick; a 401 or 403 (the bearer was rejected before any task opened) → the `host-unreachable`
comment with no event, and the record is dropped, so a later tick retries; a reply the host may have
acted on (a 5xx other than 502, which is a refusal; a read failure after send; or a 2xx that cannot be
read) → the same comment, but the task's record stays until `readopt()` resolves it, so
the next tick does not post a second task. The G4 restart flips live
behavior with no dispatcher code change.

### host-unreachable → live transition (Phase 31, no dispatcher code change)

`host-unreachable` is the correct pre-Phase-31 behavior: nothing listens on
`127.0.0.1:7411`, so the `HostClient` refuses and the tick emits nothing. The
transition needs no dispatcher change — after the OPERATOR-GATED G4 restart
(`docs/runbooks/lane-a-host.md`), the same `POST /tasks` starts returning
202s and the `host-unreachable` row goes quiet on its own. If it does not,
suspect the unit (not the dispatcher): `systemctl status substrate-host`,
then `curl -s http://127.0.0.1:7411/healthz`.

## Landed-claim rule

Evidence is any of: the node's `claimed_by` is the session's surface with a
live lease (a stored holder whose `lease_expires_at` passed is stale, not
landed); the node reached `started_review`/`completed` from a state it did
not have at launch; or a new `Claimed by <surface> — session <sid> (graph
<n>)` mirror comment. A claim completed-or-released between two reaps
still counts. `started_review` counts: Phase 23 parks `dod-required`
completions there with the lease held — a live session doing its job.

## Trust assumption

Anyone who can label `dispatch:hermes` in the reached workspace is trusted
with root on this host: the session runs as root with terminal and file
tools and can read host files from disk. The CHILD_ENV_ALLOW list keeps
secrets out of the child's *environment* only. Running dispatched Hermes
as an unprivileged reader is deferred. This is OPERATOR-GATED knowledge,
not a default anyone can widen: labelling is the trust boundary.

## Linear writes

Additive only. At most one idempotent marker comment per non-dispatch; label
removal only of the candidate's own `dispatch:<surface>` label on give-up
paths, via `removedLabelIds`. The `dispatch:*` → `agent:<surface>` move on
landed claims is the Phase 23 mirror's write, never the dispatcher's. No
issue creation, no state moves toward Done.

## Events

One outcome event per launch decision on the existing Phase 17 rows, under
the substrate bearer, fail-open (a refused emit never blocks the tick),
ids only, never issue text:

- launch → `dispatch.outcome{outcome: launched}` (kind `note`)
- terminal non-dispatch / give-up → `dispatch.failed{reason: <marker>}`
  (kind `warning`); `host-unreachable`, `at-capacity`, `graph-busy` and `already-running` (queued retries)
  and already-commented skips emit nothing.

The DISP-08 live proof is an explicit OPERATOR-GATED sequence in
`docs/runbooks/dispatch-proof.md` — the executor stops at every gate.
