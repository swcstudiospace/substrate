# Live Steering

Live Steering lets an operator tell a running agent session what to do next, and lets a session see what the other sessions of its repository are doing. It is two small mechanisms, a way to read both from a terminal, and a hook that closes the loop on the session's worktree. Nothing here acts on a session by itself: every directive is a message a session reads and answers.

## What it is

**The state machine.** The server holds one state per live session (surface and session id): `ACTIVE`, `CONTEXT_REFRESH`, `PAUSED`, `RESUMED`. A session reports its own state with `docs_steering_session`; the server enforces the legal moves. By default the registry is process memory (capped at 1,000 sessions); with `SUBSTRATE_STEERING_SESSIONS_TABLE` on it is also written to the `steering_sessions` table and read back at boot, inside a time-to-live.

**The directive inbox.** An operator queues a *directive* for a session: an `action` (`pause`, `redirect` or `annotate`), a `body` (up to 4,096 characters, redacted before it is stored) and a `priority`. The directive waits until someone acknowledges it as `applied` or `declined`. Acknowledging an applied `pause` moves the session to `PAUSED`, an applied `redirect` to `CONTEXT_REFRESH`; `annotate` and `declined` move nothing. A move that actually changed the state also returns a `checkpoint_hint` (`{ "trigger": "steering", "directive_id": "..." }`): the session may take a checkpoint of its worktree for that directive (see [session rollback](runbooks/session-rollback.md#the-steering-trigger-and-the-checkpoint_hint-reader)). A directive nobody acknowledges within a day is closed as declined with reason `timeout`.

**The context digest.** `session_context` (MCP tool) and `GET /session/context` return a bounded, redacted digest of the other live sessions of the caller's repository: presence, worktree and branch, claims, recent events, handoffs and planning changes. Every item carries its `source` and `age_s`, so a reader can tell a heartbeat from a minute ago from a claim from yesterday. It is part of the sessions feature set behind `SUBSTRATE_BRIEF_SESSIONS`: with the flag off the tool answers the typed refusal `session-context.disabled`, the route answers 503 with the same reason, and nothing is read. With it on, `memory_brief` also carries the same material as `sessions`, `steering` and `handoffs` sections inside its existing size bound, read under the brief's own deadline (a section not ready in time is replaced by one line that names it) and also shown when the brief is served from its last-good snapshot.

**The long poll.** `GET /steering/wait?session_id=&after=&timeout_ms=` holds the request until a directive for that session arrives (HTTP 200 `{ "directive": ..., "wait_ms": N }`) or the wait ends (HTTP 204 with an `X-Steering-Wait-Ms` header). A `timeout_ms` above `SUBSTRATE_STEERING_WAIT_MAX_MS` is clamped to it, not refused, and `wait_ms` says the wait the request got. `after` is a place in the order directives entered the inbox, so a clock that steps back never hides a queued directive. `substrate steer listen` loops on it.

## Who may do what

| Role | May | May not |
| --- | --- | --- |
| Operator (an operator token whose surface is on `SUBSTRATE_PLANNING_STEERING_PRINCIPALS`) | queue and acknowledge directives; read everything below | exceed 10 directives a minute per target session (`SUBSTRATE_PLANNING_STEERING_RATE_PER_MIN`) |
| Agent (any other token) | report its state; read the directives for its session and wait for them; read the context digest | author a directive, or acknowledge one |

Agents never author directives: the server refuses a queue or an acknowledgement from a caller that is not an operator on the allow-list, before anything is stored. A directive is audited before it is queued, so a queue the audit sink cannot record is refused rather than half done.

## The flags

All of them are off or empty by default; with every one unset the server behaves as it did before this feature. The full rows (default, allowed values, what unset means) are in [config-reference.md](config-reference.md).

| Variable | Effect |
| --- | --- |
| `SUBSTRATE_PLANNING_STEERING` | turns the directive inbox and the `/steering/*` routes on; off: no steering tool or route exists and a client sees 404 |
| `SUBSTRATE_PLANNING_STEERING_PRINCIPALS` | the operator surfaces allowed to queue and acknowledge; empty means nobody can queue |
| `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE` | makes the audit (and so the inbox) durable in `planning_steering_audit`; without it a restart forgets queued directives and writes fail closed |
| `SUBSTRATE_BRIEF_SESSIONS` | the sessions feature set: adds the `sessions`, `steering` and `handoffs` sections to `memory_brief`, and serves `session_context` and `GET /session/context` (off: both refuse with `session-context.disabled`) |
| `SUBSTRATE_WORKTREE_REGISTRY` | (phase 68, [worktree-fleet.md](worktree-fleet.md)) with the registry on, `memory_brief` also appends the `worktrees` section below when the request names `repo` and `session_id`; it does not need `SUBSTRATE_BRIEF_SESSIONS` |
| `SUBSTRATE_STEERING_SESSIONS_TABLE` | persists the session state registry in `steering_sessions` and loads it at boot; the session's free text (`steering`, `planning_hash`) is redacted before it is written and in `GET /steering/sessions` |
| `SUBSTRATE_STEERING_SESSION_TTL_S` | how old a persisted session may be when it is loaded at boot (default seven days); read only with the table on |
| `SUBSTRATE_STEERING_WAIT_MAX_MS` | the longest one `GET /steering/wait` holds a request (default 30,000 ms); a longer `timeout_ms` is clamped to it and the answer reports the wait it got |

The CLI reads `SUBSTRATE_URL` for the server and a bearer for the surface from `SUBSTRATE_TOKEN` (or the token file and per-surface files the other commands use). `--surface S` picks the token of surface `S`; the default is `claude-code`.

## The commands

```
substrate steer sessions [--repo R] [--limit N] [--json]
substrate steer status [--repo R] [--session ID] [--json]
substrate steer queue --session ID --action pause|redirect|annotate --body TEXT [--priority low|normal|high] [--conflicts] [--json]
substrate steer ack DIRECTIVE (--applied | --declined) [--confirm] [--json]
substrate steer list --session ID [--status queued|acknowledged|all] [--json]
substrate steer listen --session ID [--once] [--max-wait-ms N] [--after DIRECTIVE] [--json]
substrate steer context [--repo R] [--session ID] [--limit N] [--format text|json]
```

`--repo` defaults to the `owner/name` of the working directory's `origin` remote, as `substrate brief` resolves it. Human output is one compact line per item and says how old each is (`updated 5m ago`, `[presence, 12s old]`); text that came from the server (names, directive bodies and the server's error messages alike) has its control characters replaced before it reaches the terminal, while `--json` prints the values as they came. `--limit` is a whole number from 1 to 100, the server's own bound, and a directive id (the `ack` argument and `--after`) must be letters, digits and `. _ : -` (at most 128 characters, the first a letter or digit): a value the server would refuse is a usage error before any request.

| Exit | Meaning |
| --- | --- |
| 0 | done (`listen` also exits 0 when interrupted or when its bound passes) |
| 1 | failed: the server was not reached, answered with an error, or sent a body that is not a valid reply (the message names the field that was wrong) |
| 2 | usage: a wrong flag is refused before anything is sent |
| 3 | refused by the server, or the server is not set up for steering: not an operator, a principal that is not allowed, rate limited, a directive that needs `--confirm`, a bad token, a typed `misconfigured` or `not-configured` answer, steering switched off (a 404 on a steering route) |

A reply is classified by its typed body before its HTTP status. The tools' typed answers `forbidden`, `refused`, `misconfigured` and `not-configured` are the server saying no or that it is not set up for steering, so they are exit 3 whatever the status: the server sends `misconfigured` and `not-configured` with 503, and for `queue` and `ack` the reply is printed as the refusal it is. Only a 5xx with no typed body is a failure (exit 1). A 404 whose body is not typed means the route is missing: the server predates this feature, or its flag is off; the message says so and the exit is 3. The one 404 that is not that is the typed refusal an `ack` gets for a directive that does not exist (`refused (not-found)`, exit 3), which says the route works and the directive is missing. A reply to `queue` or `ack` counts as a success only when it carries what its status promises (`queued` a `directive_id`; `acknowledged` a `directive_id` and an `outcome`); an incomplete reply or a status the tools do not have is a bad response (exit 1).

`steer listen` prints each directive as it arrives, remembers the last id (sent as `after`) and every id it already printed (the last 1,000), so a server that restarted and replays a directive it still holds does not print it twice, backs off (1 s, doubling to 30 s) after a connection error or a 5xx and starts over after the next good answer, and stops on Ctrl-C, after the first directive with `--once`, or when `--max-wait-ms` has passed. `--max-wait-ms` is one budget for the whole command: every request is cut where it ends (a request is allowed its long poll plus 5 s, or what is left of the budget if that is less), no pause or backoff runs past it, and the command then ends with exit 0 like any other end of listening, so a stalled connection cannot hold it past the limit. Ctrl-C ends a backoff or a pause at once. Each poll asks for 25 s; the server clamps that to `SUBSTRATE_STEERING_WAIT_MAX_MS` and reports what it applied (`wait_ms` in a delivered answer, `X-Steering-Wait-Ms` on a 204), and the next poll asks for no more than that, so a short server ceiling is not an error. A 400 or other refusal ends the loop with exit 3 rather than being retried. It cannot be made to spin: a server that answers a long poll at once is paced.

## A worked example

An operator wants session `sess-7` of `acme/widgets` to stop and look at the parser.

```sh
# 1. See who is running and what is waiting.
substrate steer status --repo acme/widgets
#   sessions (2):
#     sess-7  surface=omp  state=ACTIVE  repo=acme/widgets  updated 40s ago  pending=0
#     sess-9  surface=claude-code  ...
#   context digest (generated ...): sessions 2, claims 1, events 20, handoffs 0, planning 1

# 2. Queue the directive (an operator token; the server picks the id).
substrate steer queue --session sess-7 --action redirect --priority high --body "Stop the refactor; first make the parser tests pass."
#   queued directive dir_01...

# 3. The session side. A host that wants to see it at once runs, in the session's worktree:
substrate steer listen --session sess-7 --once
#   dir_01...  queued  redirect/high  by operator-1  2s ago
#       Stop the refactor; first make the parser tests pass.

# 4. The operator acknowledges it as applied once the session has acted on it (acknowledging is an operator action).
substrate steer ack dir_01... --applied
#   acknowledged directive dir_01...
#   session state: applied -> CONTEXT_REFRESH
#   checkpoint hint: the session's steering hook will take a steering checkpoint for dir_01...

# 5. The session's steering hook (run by the host after the session applied the directive) reads that hint and writes the checkpoint of the worktree as it stood.
substrate session hook steering --session sess-7 --surface omp </dev/null
substrate session checkpoints --session sess-7
#   sess-7  seq 4  ckpt_...  steering  ...
```

A session that does not run `listen` still sees the directive: the server announces a queued directive with a note in the ledger and `docs_search` with a `session_id` returns the pending notice. `listen` and the long poll make it prompt instead of pull-only.

To see the digest a session would be handed:

```sh
substrate steer context --repo acme/widgets --session sess-7
#   Live context for acme/widgets (for session sess-7), generated ...
#   sessions:
#   - [presence, 12s old] session_id=sess-9 surface=claude-code worktree=... branch=feat/x
#   events:
#   - [ledger, 4s old] kind=commit summary=...
```

## Worktree overlap in the brief

With the worktree registry on (`SUBSTRATE_WORKTREE_REGISTRY`) and a `memory_brief` request that names both `repo` and its own `session_id`, the brief appends a `worktrees` section: other sessions' worktrees of the same repository that touch files the asking session's worktree touches. No new variable: the section follows the registry flag plus the request, and it is absent (and nothing is read) without either.

- **The caller's files** are the union of the reported `files` of the registry rows of that repository whose `session_id` is the request's `session_id`. No session named: no section, never a guess. A caller with no such row, or whose rows carry no files, gets one line (`your own worktree has not reported its files ...`) so the section never silently vanishes.
- **The others** are rows of the same repository (matched case-insensitively, as the brief scopes it) that name a session other than the caller's (an unattributed row is never "another session"), are not the primary checkout, were last seen within 24 hours and reported their files (`files: null` is unknown, not "touches nothing"). Those whose files intersect the caller's are listed, most overlapping files first, then most recently seen, at most **5**.
- **Each entry** gives the host and path as the registry holds them, the branch, the session id, dirty or clean with `+ahead/-behind`, how long ago it was seen, and the overlapping files (at most 5, then `and N more`). Only files in the caller's own set are ever named; nothing of a worktree that is not in the caller's repository appears.
- **Bounds and safety.** One registry query per brief, at most 100 rows of the repository, newest first; the matching is in memory. The section is at most 1,200 characters like the other live sections and says `... and N more worktrees` when it cuts. Every string passes the redactor and control characters are shown as `\xNN`. It is read under the brief's own deadline: not ready in time, it is replaced by a one-line note (`Live worktrees not included: not ready before the brief's deadline.`), and a registry read that fails is replaced by `Live worktrees not included: the read failed.`; the rest of the brief is never held or lost.
- **Never cached, never in the snapshot.** Like the other live sections it is built per request for this caller and appended after the cached text, so it is in no cache key and no stored last-good snapshot.

The lists come from `substrate worktree scan --report` ([worktree-fleet.md](worktree-fleet.md#the-changed-files-in-a-report)); a worktree no report has attributed to a session cannot be matched to one. The attribution comes from a live claim on the worktree's graph that names one session, or from `--session ID` (or `SUBSTRATE_SESSION_ID`) given to the scan that runs in the session's worktree ([worktree-fleet.md](worktree-fleet.md#which-session-a-worktree-belongs-to)); the newest report wins, so a session's hook re-sends it with each report.

## The hooks

`substrate session hook` has two triggers that read these routes. Both are fail-open: the host never waits on them for more than the hook's 10-second budget and they always exit 0.

- `steering` reads the session's acknowledged directives and writes the checkpoint each `checkpoint_hint` names, once. See [session rollback](runbooks/session-rollback.md#the-steering-trigger-and-the-checkpoint_hint-reader).
- `context` prints the digest for the session's repository as at most 4,000 characters of text, so a host that injects a hook's stdout into the session at start or at prompt submit can show the session its neighbours. On any error it prints nothing.

`substrate session hook-config context` prints the script to wire; `substrate session hook-config steering` is the other.

## Limits

- **Pull, not push.** A directive reaches a session only when the session (or its host) asks: by `listen`, by the long poll, by `docs_search`, or by the steering hook. The server never writes into a session's worktree or process.
- **A directive is advice.** The session decides what to do and acknowledges it. A session that never acknowledges leaves the directive queued until it times out as declined after a day.
- **State is per server.** Without `SUBSTRATE_STEERING_SESSIONS_TABLE` a restart forgets the session registry; without `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE` it also forgets queued directives, and `GET /steering/directives` can then answer only from memory (its `history` field says `memory-only`). With the audit table on, a restart restores the open directives and the route reads the session's latest 100 acknowledged directives back from the table. The table records the acknowledgement but not what it did to the session, so a directive read back after a restart carries no `checkpoint_hint`: a hook that had not consumed its hint before the restart takes no steering checkpoint for that directive. The registry holds at most 1,000 sessions and drops the oldest.
- **The digest is bounded and approximate.** Each list is capped, anything cut is named in `truncated` (including a full 200-event ledger window and a handoff read that did not cover every graph), a source that failed is named in `notes`, and every line states its age; a session that stopped heartbeating stays in the list until its age says so.
- **A malformed handoff is skipped, not trusted.** `events_emit` takes any payload, so a `handoff` event can carry a packet with no goal or one of the wrong type. The digest's and the brief's handoff readers keep only packets with a non-empty goal, `files`, `dod` and `blockers` as lists of strings, a named `from` and `to` surface, and every field inside the bounds `coord_handoff` applies; any other row is one fewer packet, and the rest are listed as usual.
- **Rate limit.** At most 10 directives a minute per target session by default.
- **The checkpoint hint is a hint.** It is attached only when an acknowledgement actually changed the session's state, on every route: a redirect applied while the session is `PAUSED` (a move the session refuses) or a pause for a session already paused carries none, on the acknowledgement reply and on the list alike. The checkpoint itself is taken by the hook, and is skipped when the worktree has not changed since the last one.

## What is still operator-gated

- **Installing hooks in a host.** `hook-config` only prints text; no command here edits a host's settings. Which host event runs the `steering` and `context` hooks is the operator's choice (ADR 0007 maps no event to them). Until it is done, no session reads its hints or sees the digest on its own.
- **Turning the flags on, creating the tables and setting the principals.** Each flag is an operator decision; the opt-in tables migrate only when their flag is on.
- **Operator tokens.** Which surfaces may author and acknowledge directives is `SUBSTRATE_PLANNING_STEERING_PRINCIPALS`; issuing the tokens is outside this repository.
- **Delivery to a real session end to end** has to be exercised by an operator with a host wired as above; the tests here run against a fake server.

See also [coordination](coordination.md) (leases, handoffs and drift, the other cross-session mechanisms) and [session rollback](runbooks/session-rollback.md).
