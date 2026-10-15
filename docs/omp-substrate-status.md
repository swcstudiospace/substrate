# Omp substrate status

An Omp extension that shows Agent Substrate usage in the Omp TUI: a footer
status, a widget with recent activity, and a `/substrate` command. Read-only and
fail-open.

## What the numbers mean

The numbers are the server's own counters since its `startedAt`. The extension
polls `GET /metrics` and `GET /healthz` and reports the change between
consecutive polls for surface `omp`.

**Omp tool calls are not counted.** Omp has no substrate MCP server
(`mcp.json` has no substrate entry), so a tool call made inside Omp never reaches
the substrate. What is counted is the traffic the substrate attributes to
surface `omp`:

- `req`: `substrate.request.total` for `omp`, summed over routes.
- `emit`: `substrate.emit.total` for `omp`, summed over kinds.
- `tool`: `substrate.tool.calls` for `omp`. Shown in the widget only.

Monitoring routes (`/healthz`, `/metrics`, `/livez`, `/slo`, `/slo/history`) are
not counted as requests. Otherwise this extension's own polls would show up as
omp requests and the footer would never reach `idle`.

## Surfaces

Footer, one line under 80 columns:

- `substrate · omp +N req · +M emit · healthy`: change since the previous poll.
- `... · idle`: no omp change in the last five minutes.
- `... · degraded (<plane>)`: a plane in `/healthz` reports `ok: false`.
- `substrate · unreachable (<reason>)`: the last probe failed (`timeout`,
  `http <status>`, `unreachable`, `parse`). Shown even before a good snapshot.
- `substrate · auth required`: the server answered 401 or 403 and no token
  resolved. `auth failed`: a token was sent and refused.
- `substrate · checking`: before the first probe completes.

Widget, below the editor: the last three polls with a nonzero omp change, as
`HH:MM  +N req  +M emit  +K tool` in local time. Cleared when empty.

`/substrate`: runs one fresh probe, or waits up to 4 seconds for the poll
already in flight. It shows one row per surface (omp first), plane states with
breaker state, cache hits and misses, ledger rows, and anchors rows. On a failed
probe it shows the age of the last good snapshot. For an auth failure it also
prints one hint line naming where the token comes from.

## Refresh

Polls run at session start, every 30 seconds, after each agent turn, and on
`/substrate`. Each request has a 3-second timeout. Overlapping refreshes share
one poll. A failed probe keeps the last good snapshot.

## Install

Symlink the extension into Omp's auto-discovered directory, as
`substrate-skills.ts` is installed:

`ln -s "$PWD/packages/projector/omp/substrate-status.ts" ~/.omp/agent/extensions/substrate-status.ts`

Remove the symlink to disable it.

## Configuration and the token rule

- `SUBSTRATE_URL`: base URL. Default `http://127.0.0.1:7410`.
- Once the server has tokens configured, `/metrics` requires the omp bearer
  (anonymous access is off by default). `/healthz` accepts a request without one.
- The omp bearer is sent on both polls whenever one resolves, in this order:
  1. `SUBSTRATE_TOKEN`
  2. the file named by `SUBSTRATE_TOKEN_FILE`
  3. the file `omp` in `SUBSTRATE_TOKENS_DIR` (default `/etc/substrate/tokens`)
- The bearer goes only in the `Authorization` header. It is resolved on every
  poll and never stored, logged, or put in any footer, widget, or notification.

## Fail-open

Nothing throws into Omp. Probe failures become a status line. The extension
makes only the two GETs above and never writes to the substrate.
