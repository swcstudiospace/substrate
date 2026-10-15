# Omp substrate status

An Omp extension that shows Agent Substrate usage in the Omp TUI: a footer
status, a widget with recent activity, and a `/substrate` command. Read-only and
fail-open.

## What the numbers mean

The numbers are the server's own counters since its `startedAt`. The extension
polls `GET /metrics` and `GET /healthz` on loopback and reports the change
between consecutive polls for surface `omp`.

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
- `substrate · unreachable (<reason>)`: the last probe failed. Reasons are
  `timeout`, `http <status>`, `unreachable` or `parse`.
- `substrate · checking`: no probe has finished yet.

Widget, below the editor: the last three polls with a nonzero omp change, as
`HH:MM  +N req  +M emit  +K tool` in local time. Cleared when empty.

`/substrate`: one fresh probe, bounded by 1000 ms. Shows one row per surface
(omp first), plane states with breaker state, cache hits and misses, ledger rows,
and anchors rows. When unreachable, it also shows the age of the last good
snapshot.

## Refresh

Polls run at session start, every 30 seconds, after each agent turn, and on
`/substrate`. A failed probe keeps the last good snapshot.

## Install

Symlink the extension into Omp's auto-discovered directory, as `substrate-skills.ts`
is installed:

`ln -s "$PWD/packages/projector/omp/substrate-status.ts" ~/.omp/agent/extensions/substrate-status.ts`

Remove the symlink to disable it.

## Configuration and the token rule

- `SUBSTRATE_URL`: base URL. Default `http://127.0.0.1:7410`.
- The bearer is resolved on every probe in this order: `SUBSTRATE_TOKEN`, then
  the file named by `SUBSTRATE_TOKEN_FILE`, then the file `omp` in
  `SUBSTRATE_TOKENS_DIR` (default `/etc/substrate/tokens`). This matches
  `substrate-skills.ts` and `packages/cli/src/token.ts`.
- The bearer goes only in the `Authorization` header. It is never stored,
  logged, or put in any footer, widget, notification, or reason string.
- `/metrics` and `/healthz` answer on loopback without a token. A token is sent
  only when one resolves.

## Fail-open

Nothing throws into Omp. Probe failures become a status line. The extension
makes only the two GETs above and never writes to the substrate. If the server
is down, the footer says so and the session continues.
