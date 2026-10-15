# Omp substrate status

An Omp extension that shows Agent Substrate usage in the Omp TUI: a footer
status, a widget with recent activity, and a `/substrate` command. Read-only and
fail-open.

## What the numbers mean

The numbers are the server's own counters since its `startedAt`. The extension
polls `GET /metrics` and `GET /healthz`, reports the change between consecutive
polls for surface `omp`, and reports the coverage of every known client.

**Omp tool calls are not counted.** Omp has no substrate MCP server
(`mcp.json` has no substrate entry), so a tool call made inside Omp never reaches
the substrate. What is counted is the traffic the substrate attributes to
surface `omp`:

- `req`: `substrate.request.total` for `omp`, summed over routes.
- `emit`: `substrate.emit.total` for `omp`, summed over kinds.
- `tool`: `substrate.tool.calls` for `omp`. Shown in the widget and in `/substrate`, not in the footer.

Monitoring routes (`/healthz`, `/metrics`, `/livez`, `/slo`, `/slo/history`) are
not counted as requests. Otherwise this extension's own polls would show up as
omp requests, and the footer would never reach `NOT_OBSERVED_IN_WINDOW`.

## Usage and coverage

- **IN_USE**: at least one omp read or write counted by the substrate in the
  last five minutes. **NOT_OBSERVED_IN_WINDOW**: none in that window. **UNKNOWN**
  (in `/substrate` only): the source is unavailable. `/substrate` prints this
  definition on screen.
- The window and every time shown are this viewer's poll clock. `/metrics`
  carries no per-event timestamps, so a change is dated by the poll that saw it.
- **Known clients** are the regular files named in `SUBSTRATE_TOKENS_DIR` (default `/etc/substrate/tokens`); symlinks are followed and folders are skipped. `omp` is always included. A name that is not a plain identifier is left out. The list is the configuration, not a guess.
- Each known client has one coverage status:
  - `OBSERVED`: counted, with a change in the window.
  - `NO_ACTIVITY_IN_WINDOW`: counted, with no change in the window.
  - `NOT_INSTRUMENTED`: known, with no counts. Never shown as inactive.
- A counted surface outside the known list is `UNREGISTERED_CLIENT`. It is shown and flagged, not dropped.
- When any known client is `NOT_INSTRUMENTED`, `/substrate` prints a banner
  saying the headline covers observed clients only.

## Surfaces

Footer, one line under 80 columns:

- `substrate · IN_USE · omp +N req +M emit · planes ok · HH:MM`: a change in the
  window. `HH:MM` is the last good poll.
- `substrate · NOT_OBSERVED_IN_WINDOW · …`: no omp change in the last five minutes.
- `… · <plane> down` or `… · N planes down`: a plane in `/healthz` reports `ok: false`.
- `substrate · ERROR (<reason>) · last good HH:MM · /substrate retries`: the last
  probe failed. The time is the last good poll. With no good poll yet, the footer
  reads `no data yet`. Counts are never replaced by zeros.
- `substrate · ACCESS_DENIED auth required` or `auth failed`: the server answered
  401 or 403. No counts are shown.
- `substrate · checking`: before the first probe completes.

Widget, below the editor: a caption that states the feed cap (the last three
polls) and the refresh interval (30 seconds), then one row per poll with a
nonzero omp change, as `HH:MM  +N req  +M emit  +K tool` in local time. Hidden
when empty.

`/substrate`: runs one fresh probe, or waits up to 4 seconds for the poll
already in flight. It shows the probe state with `updated HH:MM`, the usage
definition, the omp counters with their basis, the coverage banner, one row per
known client, any unregistered surfaces, plane states with breaker state, cache
hits and misses, ledger rows, and anchors rows. On a failed probe the counters
and planes are labelled `last known`, and the output says to run `/substrate`
again. On an auth failure it shows no counters, and one hint line that names
where the token comes from.

## Refresh

Polls run at session start, every 30 seconds, after each agent turn, and on
`/substrate`. Each request has a 3-second timeout. Overlapping refreshes share
one poll. A failed probe keeps the last good snapshot.

A write that changes an omp counter shows on the first poll after it: at most
30 seconds, plus up to 3 seconds for the probe. The throttle is covered by a test.
The end-to-end check, a real write seen in the footer, is an operator step.

## Install

Symlink the extension into Omp's auto-discovered directory, as
`substrate-skills.ts` is installed:

`ln -s "$PWD/packages/projector/omp/substrate-status.ts" ~/.omp/agent/extensions/substrate-status.ts`

Remove the symlink to disable it.

## Configuration and the token rule

- `SUBSTRATE_URL`: base URL. Default `http://127.0.0.1:7410`.
- `SUBSTRATE_TOKENS_DIR`: the known-client list and the omp token file. Default `/etc/substrate/tokens`.
- `/metrics` may require the omp bearer once the server has tokens configured.
  An unauthenticated loopback GET answered 200 when checked on 2026-10-15, so the
  extension does not assume the bearer is required.
- The omp bearer is sent on both polls whenever one resolves, in this order:
  1. `SUBSTRATE_TOKEN`
  2. the file named by `SUBSTRATE_TOKEN_FILE`
  3. the file `omp` in `SUBSTRATE_TOKENS_DIR`
- The bearer goes only in the `Authorization` header. It is resolved on every
  poll and never stored, logged, or put in any footer, widget, or notification.
- Panel text is plain text. Control and bidirectional-override characters in a
  surface or plane name are removed before display.

## Limits

- `STALE` is not shown. A stale state needs an event time, and `/metrics` does not
  carry one. A per-surface last-seen counter on the server would fix this; it is a
  server change, and it is pending a decision.
- The panel shows counts, not records. No record body or activity feed row can
  reach it, so credential-like values in records cannot appear.
- Filters and a time-window selector are not provided. The window is fixed at
  five minutes.

## Fail-open

Nothing throws into Omp. Probe failures become a status line. The extension
makes only the two GETs above and never writes to the substrate.
