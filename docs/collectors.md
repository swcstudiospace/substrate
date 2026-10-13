# Collectors

How the host tells the substrate what agents just did. Collectors and hooks
post events through `substrate-mcp`. None of them opens the ledger itself.
The event rows below are the Phase 17 mapping in
[`docs/event-vocabulary.md`](event-vocabulary.md).

## Shared emit

`packages/collectors/src/emit.ts` posts one event and never throws. A 202 is
stored, a 4xx is refused, and a 5xx, a network error or a timeout is failed.
There is no retry queue.

A refusal appends one JSON line to `refused-emits.jsonl` under the state
directory. The line has only `ts`, `collector`, `source`, `kind`, `surface`,
`status` and `error`. The error is redacted and cut to 200 characters. The
event summary and payload are not written there. The same line is printed to
stderr.

`bun run collectors:status` reads the counters in each state file and the
refused lines since `--since`. It changes nothing and exits 0.

## Environment

Names only. Values stay in the operator's env files, never in the repo or in
a Muse bundle.

| Name | What it selects |
| --- | --- |
| `SUBSTRATE_URL` | Substrate base URL. Unset means the local substrate. |
| `SUBSTRATE_TOKEN` | Bearer token for collectors that read the environment. |
| `SUBSTRATE_STATE_DIR` | Directory for `refused-emits.jsonl` and the muse default state file. herdr and grok ignore it (next row). |
| `SUBSTRATE_COLLECTOR_STATE` | One collector's state file, when a unit overrides the default path. The only way to relocate or isolate herdr and grok state. |
| `SUBSTRATE_MUSE_REPOS` | Colon-separated absolute repo roots for the brief writer. Required. |
| `SUBSTRATE_MUSE_TOKEN_FILE` | File the Muse hook reads for a `SUBSTRATE_TOKEN` line. |
| `MUSE_PLUGIN_DIR` | Where the Muse projector writes the bundle. |
| `HERDR_SOCKET_PATH` | herdr socket. Wins over the session name. |
| `HERDR_SESSION` | herdr session name, used when the socket path is unset. |
| `SUBSTRATE_CURSOR_ROOT` | Root a Cursor transcript must stay inside. |
| `SUBSTRATE_TRANSCRIPTS_DIR` | Directory the stop hook copies transcripts into. |
| `SUBSTRATE_CURSOR_STOP` | Stop-hook script the Cursor projector writes into `hooks.json`. |

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
| `refused-emits.jsonl` (always under the state directory) | every collector and hook that was refused |

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
