# Collectors

How the host tells the substrate what agents just did. Collectors and hooks
post events through `substrate-mcp`. None of them opens the ledger itself.
The event rows below are the Phase 17 mapping in
[`docs/event-vocabulary.md`](event-vocabulary.md).

## Shared emit

`packages/collectors/src/emit.ts` posts one event and never throws. A 202 is
stored, a 4xx is refused, and a 5xx, a network error or a timeout is failed.
By default there is no retry queue: a failed event is dropped and counted. With
`SUBSTRATE_EVENT_SPOOL=on` a failed event is parked and replayed instead; see
[Event spool](#event-spool).

A refusal appends one JSON line to `refused-emits.jsonl` under the state
directory. The line has only `ts`, `collector`, `source`, `kind`, `surface`,
`status` and `error`. The error is redacted and cut to 200 characters. The
event summary and payload are not written there. The same line is printed to
stderr. The file is capped: at `SUBSTRATE_REFUSED_EMITS_MAX_BYTES` (default
1048576, at least 4096, at most 64 MiB) it is renamed to
`refused-emits.jsonl.1`, replacing the previous rotated file, and a new file
starts. Two files at most exist. `bun run collectors:status` reads both.

`bun run collectors:status` reads the counters in each state file and the
refused lines since `--since`. It changes nothing and exits 0.

`POST /events` can dedupe a replay (`SUBSTRATE_EVENT_IDEMPOTENCY`, default `off`;
`docs/greptime-ledger.md` § Idempotent replay). A client that re-sends an event after a
timed-out first attempt sends the same `ts` (a keyed replay without it is refused), an
`idempotency_key` and `x-substrate-replay: 1`, and checks that `/healthz` reports `idempotency` as `accept` or
`enforce` first: against `off` (or a server without the field) a replay appends a second
row. Enable the server in `accept` before any client sends a replay. This paragraph is
the server contract; the collectors above still have no retry queue.

## Environment

Names only. Values stay in the operator's env files, never in the repo or in
a Muse bundle.

| Name | What it selects |
| --- | --- |
| `SUBSTRATE_URL` | Substrate base URL. Unset means the local substrate. |
| `SUBSTRATE_TOKEN` | Bearer token for collectors that read the environment. |
| `SUBSTRATE_STATE_DIR` | Directory for `refused-emits.jsonl`, `event-spool.jsonl` and the muse default state file. herdr and grok ignore it for their state files (next row). |
| `SUBSTRATE_COLLECTOR_STATE` | One collector's state file, when a unit overrides the default path. The only way to relocate or isolate herdr and grok state. |
| `SUBSTRATE_MUSE_REPOS` | Colon-separated absolute repo roots for the brief writer. Required. |
| `SUBSTRATE_MUSE_TOKEN_FILE` | File the Muse hook reads for a `SUBSTRATE_TOKEN` line. |
| `MUSE_PLUGIN_DIR` | Where the Muse projector writes the bundle. |
| `HERDR_SOCKET_PATH` | herdr socket. Wins over the session name. |
| `HERDR_SESSION` | herdr session name, used when the socket path is unset. |
| `SUBSTRATE_CURSOR_ROOT` | Root a Cursor transcript must stay inside. |
| `SUBSTRATE_TRANSCRIPTS_DIR` | Directory the stop hook copies transcripts into. |
| `SUBSTRATE_CURSOR_STOP` | Stop-hook script the Cursor projector writes into `hooks.json`. |
| `SUBSTRATE_REFUSED_EMITS_MAX_BYTES` | Size at which `refused-emits.jsonl` rotates. Default 1048576. |
| `SUBSTRATE_EVENT_SPOOL` | `off` (default) or `on`. See [Event spool](#event-spool). |
| `SUBSTRATE_EVENT_SPOOL_MAX` | Spool line cap. Default 5000. |
| `SUBSTRATE_EVENT_SPOOL_MAX_BYTES` | Spool size cap. Default 8388608. |
| `SUBSTRATE_EVENT_SPOOL_TTL_H` | Hours a parked event is kept. Default 48. |
| `SUBSTRATE_EVENT_SPOOL_MAX_ATTEMPTS` | Delivery attempts before a parked event is dropped. Default 12. |

## State files

The muse state file lives under the state directory unless
`SUBSTRATE_COLLECTOR_STATE` names another path. herdr and grok always use
their own default files and only `SUBSTRATE_COLLECTOR_STATE` moves them —
setting `SUBSTRATE_STATE_DIR` alone leaves those two where they are.

| File | Collector |
| --- | --- |
| `herdr-offsets.json` (`/var/lib/substrate` unless overridden) | herdr pane map and counters |
| `muse-offsets.json` (under the state directory unless overridden) | brief writer, per-repo last success, last failure and the last brief `ETag` |
| `grok-offsets.json` (`/var/lib/substrate` unless overridden) | grok tail offsets and counters |
| `refused-emits.jsonl` (always under the state directory) | every collector and hook that was refused, and every spooled event that was dropped (`kind` `dropped`) |
| `event-spool.jsonl` (always under the state directory) | events parked for replay; present only after `SUBSTRATE_EVENT_SPOOL=on` parked one |

## herdr

`packages/collectors/src/herdr.ts` treats socket pushes as a signal to
snapshot. The snapshot is what gets emitted. Rows in
[`docs/event-vocabulary.md`](event-vocabulary.md):

| Source | Kind |
| --- | --- |
| `herdr.agent_detected` | `session.start` |
| `herdr.status_changed` | `note` |
| `herdr.pane_exited` | `session.end` |
| `herdr.other` | `note` |

`pane.output_matched` is mapped and not subscribed. Its text is redacted and
it carries no `repo`.

The agent table is `HERDR_AGENT_SURFACES` in
`packages/collectors/src/herdr-map.ts`, the same rows as the vocabulary doc:

| herdr agent | surface |
| --- | --- |
| `claude` | `claude-code` |
| `codex` | `codex` |
| `opencode` | `opencode` |
| `pi` | `pi` |
| `omp` | `omp` |
| `hermes` | `hermes` |
| `cursor` | `cursor` |
| `grok` | `grok-build` |
| `muse` | `muse` |

Any other agent id is counted as unmapped and not emitted.

herdr's unit env and its per-collector env file must not define the bare
client bearer variable: herdr resolves each event's bearer per surface from
the tokens dir at emit time, so one shared value would send every event
under a single surface. `bun run identity:check` flags the variable when it
is present; `docs/runbooks/production-identity.md` lists the per-surface
token files the operator provisions instead.

## Muse brief writer

`packages/collectors/src/muse.ts` emits nothing. `muse.brief_writer` is a
silent source in [`docs/event-vocabulary.md`](event-vocabulary.md): a note
per repo would change the brief and run the writer again. The trail is
`<repo>/.substrate/BRIEF.md` and the counters in `muse-offsets.json`.

One `GET /healthz` per pass. Unless the ledger is up, every repo counts
`fetch_failed` with reason `ledger_unavailable` and no brief is fetched. A
repo with no origin slug counts `no_slug` and is skipped. A good brief is
redacted and written by tmp plus rename. A failed fetch leaves `BRIEF.md`
unchanged and still ensures the `AGENTS.md` pointer. The pointer is one
marker block. `.substrate/` is added to the exclude file `git rev-parse
--git-path info/exclude` names.

The writer keeps the `ETag` of the last 200 per repo in its state file and
sends it as `If-None-Match` on the next pass, while `BRIEF.md` still exists.
A 304 counts `unchanged`, records `last_success`, and leaves `BRIEF.md`
byte-identical without reading or redacting a body; a 200 replaces the file
and the tag. A server that sends no `ETag` is handled as before. The pointer
and exclude handling do not depend on which answer came back. The server-side
contract (`ETag`, `X-Substrate-Brief`, 304) is in `docs/observability.md`.

## Muse tool hook

`muse.tool_call` in [`docs/event-vocabulary.md`](event-vocabulary.md) is
`tool.call` on surface `muse`, with `repo` and `branch`. The hook is
generated by `packages/projector/src/muse.ts` into `MUSE_PLUGIN_DIR`
(default `/var/lib/substrate/muse-plugin`):

| Path | Contents |
| --- | --- |
| `.muse-plugin/plugin.json` | Native plugin manifest, PostToolUse only |
| `hooks/post-tool-use.ts` | The hook |
| `hooks/redact.ts` | A byte copy of `packages/mcp-server/src/redact.ts` plus a header naming the source commit and sha256 |
| `hooks/substrate.json` | `url`, `tokenFile`, `stateDir` |

The hook imports `./redact.ts`. It does not read `SUBSTRATE_URL` or
`SUBSTRATE_TOKEN` from the environment, because Muse strips those. It reads
`hooks/substrate.json` beside itself, then the `SUBSTRATE_TOKEN` line of
`tokenFile`. A missing token file posts with no authorization. The projector
refuses to write a token value into the bundle.

`repo` is the origin slug. `branch` is the git branch in the hook's working
directory. The payload is `tool`, plus `outcome`, `duration_ms` and
`tool_use_id` when the envelope has them, all through `redactValue`. The
summary is `muse called <tool>`. Actor is `agent`. The timeout is 1.5
seconds. A 4xx appends a refused line under `stateDir`. Stdout stays empty
and the process exits 0.

The projector validates, installs or updates with user scope, then approves.
`--bundle-only` writes and validates without installing. `--check` compares
the installed hook, redactor and config and requires `trusted_enabled`. It
changes nothing and exits 1 on drift.

## Cursor stop

`cursor.stop` in [`docs/event-vocabulary.md`](event-vocabulary.md) is
`session.end` on surface `cursor` with actor `human`.
`packages/collectors/src/cursor-stop.ts` copies the transcript only when all
of these hold:

- the conversation id matches `^[A-Za-z0-9-]{8,128}$`;
- the realpath stays under the Cursor root;
- the file is a regular file, not a symlink to somewhere else;
- the file is at most 20 MB.

The copy is redacted, mode `0600`, in a `0700` directory, written by tmp
plus rename. The event carries `conversation_id`, `transcript_ref`, `status`
and `reason`. Stdout stays empty and the process exits 0. Emit uses the
shared client with the 1.5 second hook timeout.

`packages/projector/src/cursor.ts` writes the stop command as
`bun` plus the stop script, discarding stdout and stderr and ignoring a
failure, so a substrate outage cannot stall the turn. `--print-desired`
prints the entries and does not open the hooks file. `--check` reports
whether the live file already matches.

## Grok

`packages/collectors/src/grok.ts` tails Grok session logs and posts as
surface `grok-build`. It is older than the Phase 17 source table. The kinds
it emits are `tool.call`, `prompt`, `note` and `warning`, under the same
mapping rules in [`docs/event-vocabulary.md`](event-vocabulary.md). Offsets
live in `grok-offsets.json`. `GROK_SESSIONS_DIR` overrides the log root.

## Git hook

`packages/collectors/src/install-git-hook.ts` installs a post-commit hook
that emits `commit` and fails open. It will not replace a hook it did not
write. `--check` only reports.

## Event spool

Until now an event that failed on an outage was gone: the Grok collector even
advanced its offsets past it. With `SUBSTRATE_EVENT_SPOOL=on` the shared emit
parks the event and replays it later. The spool is the client half of
idempotent replay; the server half is `SUBSTRATE_EVENT_IDEMPOTENCY`.

### Enable order

1. Set `SUBSTRATE_EVENT_IDEMPOTENCY=accept` on the substrate and restart it.
   `GET /healthz` then reports `"idempotency": "accept"`.
2. Add `SUBSTRATE_EVENT_SPOOL=on` as an operator env line to each collector's
   env file, one collector at a time, and restart that unit. No new unit is
   needed: the collector units already have `StateDirectory=substrate`. A hook
   (the git post-commit hook, the Cursor stop hook, `substrate emit`) reads the
   same variable from the environment it runs in.
3. Re-run `bun packages/collectors/src/install-git-hook.ts <repo>` to refresh
   an installed post-commit hook: the installer writes this checkout's
   collectors directory into the copy, which is how the hook finds `emit.ts`.
   Without that the hook keeps today's behaviour and parks nothing.

With the flag `off`, which is the default, nothing reads or writes the spool
file, the event body is sent exactly as before, and a failed event is dropped
and counted. An unknown value is `off` with one warning on stderr.

### What is parked

At the first attempt `emit.ts` redacts the event, fixes its `ts` (the caller's,
else now) and an idempotency key, and sends `{ ...event, ts, idempotency_key }`.
The key is `ik1:` plus the sha256 of
`collector|surface|session|kind|ts|summary|repo|branch|graph|node|linear|step|actor|payload`
(payload canonical, keys sorted), unless the caller supplies a stable key. The
Grok collector does: `gk1:` plus the sha256 of file, session, byte offset and
the line, so a re-read of one log line carries one key.

| Outcome of the live attempt | Spooled |
| --- | --- |
| Network error, timeout, 5xx, 503 with `stored:false` | yes |
| Any 4xx | no: a refusal, logged to `refused-emits.jsonl` |
| 202 | no |
| Body over the server's 1 MB cap | no: a `dropped` line |

The spool never holds a token, header or URL: the bearer is resolved again at
replay time. It holds the redacted body only, because an event has no source
to re-read. `memory_write`, `graph_claim`, `coord_handoff`, `skills_*` and
Hindsight retains do not go through this client and are never spooled.

### The file

`event-spool.jsonl` is one JSON object per line, mode `0600`, in the state
directory. Hooks and the CLI only append: one lock, one write, no network, no
replay. Long-running collectors (herdr, grok) replay on a 30 second tick that
is `unref`'d, single-flight and cleared on every exit path; `substrate spool
flush` replays on demand. A spool that is full, expired or exhausted drops the
oldest entries and says so:

| Cap | Default | A drop leaves |
| --- | --- | --- |
| `SUBSTRATE_EVENT_SPOOL_MAX` lines | 5000 | `spool-overflow` |
| `SUBSTRATE_EVENT_SPOOL_MAX_BYTES` | 8 MB (minimum 1024) | `spool-bytes` |
| `SUBSTRATE_EVENT_SPOOL_TTL_H` | 48 | `spool-ttl` |
| `SUBSTRATE_EVENT_SPOOL_MAX_ATTEMPTS` | 12 | `spool-attempts` |

A drop writes a line with `kind` `dropped` to `refused-emits.jsonl` (the same
seven keys, `status` 0, `error` `spool-<cause>`, never the summary or payload)
and one stderr line. A drop of many entries at once writes up to 20 lines and
one `more=<n>` summary line. An unwritable spool (`spool-write_failed`) drops
the event as it always did. The line cap is enforced to within a tenth of its
value between size checks. Cap parsing, for each of the four caps and
`SUBSTRATE_REFUSED_EMITS_MAX_BYTES`: unset or blank is the default, silently; a
value that is not a positive integer (including `0`) is the default with one
warning; a value below the minimum (spool bytes 1024, refused journal 4096) is
raised to the minimum with one warning; a value above the ceiling (100000 lines,
64 MB, 720 h, 100 attempts, 64 MB for the journal) is clamped to the ceiling
with one warning. `substrate spool status` reports the effective values.

Replay waits 30 s, then doubles per attempt to a one hour cap, with 20 %
jitter. Connection refused and an unreachable or unready server stop the pass
without consuming an attempt; a 401 skips the rest of that credential's entries
for the pass (kept, no attempt consumed, no further request for that credential)
and the pass continues with other credentials; a 403 leaves that one entry
untouched and the pass goes on to the next; a timeout or 5xx consumes an
attempt, and three in a row stop the pass. A herdr transition that was parked advances like a stored
one: the spool owns it, so it is not emitted again. Collector counters still
count the live attempt as `failed`.

### Replay rules

Before any replay the client first drops expired and attempt-exhausted entries
(a local step that needs no server). It then asks `GET /healthz` (a successful
answer is cached for 15 seconds per URL and credential), sending a credential
the replay itself would use: a deployment with surface tokens answers
`/healthz` 401 to a caller without one. The capability is server-wide, so the
credentials of the entries that are eligible to replay (due and unexpired) are
tried in turn, at most four distinct ones, until one is not refused. Only when
every one is refused with 401 or 403 does the spool hold as `healthz-auth`,
logged once a minute, with no attempt consumed. A refusal is never cached, so a
corrected or rotated token is tried at once. The client replays only when `idempotency` is `accept` or `enforce` and the
ledger is up and taking writes (`greptime` is not `false`, and neither
`eventsWritable` nor `ledger.writable` is `false`). With the server at `off`,
an older server without the field, a ledger that is down or refusing writes, an
unreachable server or a `/healthz` that is not 200, the spool is kept, one line
is logged and the replay is tried again later; no attempt is consumed. A replay
sends the same body and the header `x-substrate-replay: 1`, with this
process's bearer for the event's surface. What each answer does to the entry:

| Answer | Entry |
| --- | --- |
| 202 (deduplicated or not) | removed |
| 401 | kept, no attempt; the rest of that credential's entries in the pass are skipped without a request and the pass goes on to other credentials. If every entry was skipped the pass reports held (`unauthorized`) |
| 403 (an attribution refusal: this process's token is for another surface) | kept untouched, no attempt, the pass goes on to the next entry; only the TTL ends it |
| any other 4xx (a validation refusal such as `replay_ts_missing`, 413, 422) | logged as a refusal and removed |
| 5xx, timeout | kept, one attempt consumed, backed off |
| connection refused | kept, no attempt, the pass stops |

A crash between a 202 and the rewrite of the file leaves the entry, and the
next replay is answered `deduplicated`.

### Inspecting it

`substrate spool status [--json]` prints depth, bytes, the oldest entry's age,
how many are due, the caps, and the drop counts by cause read from
`refused-emits.jsonl` and its rotated `.1` file (so the counts cover only the
retained journal and fall when a rotation discards the older file). It never prints an event body or key, changes nothing,
and works with the flag off. It exits 0.

`substrate spool flush [--json] [--budget-ms N]` replays now, ignoring the
backoff schedule but not the replay rules above. With the flag off it does
nothing. It exits 0 whether the spool drained, was kept or was held, and 1 on a
usage error.

### Limits

- The key is derived from the event's content. Under the server's `enforce`,
  two genuinely identical events with the same millisecond `ts` collapse into
  one; a caller that needs both passes its own stable key (the Grok collector
  does).
- The `dropped` lines, like every line in `refused-emits.jsonl`, and the rotated
  `.1` file keep the existing file mode (0644 by default umask): they hold no
  summary or payload. Only `event-spool.jsonl` is created 0600.
- A hook's park can wait up to 0.5 s for the spool's lock and, when a cap was
  just crossed, rewrite the file, so it can run slightly past the hook's emit
  timeout.
- Dedupe applies only to replay-marked requests (or any keyed request with the
  server in `enforce`) within the same surface, repo, graph, kind and `ts`
  cell. `_ik` is a reserved payload key. Each replay costs the server one
  ledger read.
- With the server at `off` a replay can write a second row, which is why the
  client checks `/healthz` first. A server switched to `off` after the check
  can still receive a replay for up to 15 seconds.
- Redaction here uses the shared redactor on the identifier fields, the summary
  and the payload; the server redacts again when it stores the event.
- The lock that serialises appends and rewrites is a lock file. One left by a
  crashed process is taken over after 10 seconds; if a second process takes it
  over in the same instant, an event appended at that moment can be lost.
- The Muse tool hook has its own inline emit (it cannot import `emit.ts` from
  the Muse cache) and does not spool.
- A hook whose append waits on a busy lock for more than half a second gives up
  and drops the event as before.

## Recorded gaps

`/healthz` and `/brief` are two requests. The ledger can be up for the check
and down for the brief, and `/brief` can still return 200. The writer stores
that body. The server marks such an answer `X-Substrate-Brief: degraded` or
`snapshot` (a snapshot body starts with a dated banner line); the writer does
not act on the header, so a degraded 200 is written like any other brief.

Muse `PostToolUse` runs only after a successful tool call. Failures go to
`PostToolUseFailure`, which this hook does not subscribe to, so `outcome` is
usually absent.

## Finding a refused sender

`/metrics` counts refused event posts by reason (`substrate.events.refused`). Once an hour substrate-mcp also writes one stderr line per window:

```text
[substrate] refused events: reason=validation status=400 caller=untokened surface=muse kind=unrecognised:brief.delivered 335
```

`caller` is the token's surface, `untokened`, or `unmapped-bearer`. For a body the server parsed, `surface` and `kind` are the names it claimed: a known name as-is, an unknown name as `unrecognised:<name>` only when it is a short slug, and `unrecognised:invalid` otherwise. A `reason=auth` row is refused before the body is read, so it always shows `surface=none kind=none`. The line has no summary, payload, or token. After 50 distinct keys in one window, the rest are counted as `other`. `journalctl -u substrate-mcp | grep 'refused events'` names the sender to fix.
