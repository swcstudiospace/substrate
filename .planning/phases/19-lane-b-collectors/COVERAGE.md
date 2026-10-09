# API Coverage — Phase 19 (Lane B collectors)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.

Phase 19 integrates two versioned local tool APIs: the herdr 0.9.1 Unix-socket
API (ND-JSON, protocol 22) and the Muse 1.4.4 plugin CLI. Both were
live-probed during research (`herdr api schema --json`; scratch-HOME
`muse plugins validate|install|update|approve|inspect|hook test` runs).
`POST /events`, `POST /brief`, `POST /events/query` and `GET /healthz` are the
project's own loopback HTTP against the Phase 16 harness, not an external API,
so they carry no matrix. Cursor `hooks.json` is a local config file projected
by `packages/projector/src/cursor.ts`, not an API.

## herdr 0.9.1 socket API

| capability | decision | reason |
|---|---|---|
| `session.snapshot` (one-shot, fresh connection) | INTEGRATE | reconciler source of truth (D19-08), bootstrap before subscribe |
| `events.subscribe` global (`pane.agent_detected`, `pane.exited`, `pane.created`, `pane.closed`) | INTEGRATE | lifecycle triggers on one long-lived connection (D19-07) |
| `events.subscribe` per pane (`pane.agent_status_changed` with `pane_id`) | INTEGRATE | status transitions need a per-pane connection (D19-07) |
| `workspace.create` with `cwd` | INTEGRATE | proof-only driver: creates the scratch pane in R (D19-26) |
| `pane.report_agent` (`pane_id`, `source`, `agent`, `state`) | INTEGRATE | proof-only driver: working → idle transitions, no model runs (D19-26) |
| `pane.close` | INTEGRATE | proof-only driver: closes the scratch pane for the `session.end` assertion (D19-26) |
| `herdr --session <name> server` / `server stop` / `session delete` | INTEGRATE | proof isolation: scratch named session, teardown in `finally` (D19-27) |
| `pane.output_matched` subscription | OPT-OUT | D19-12: September's `"."` regex turned every output line into a note and would bury the repo brief; mapper keeps the redacted `herdr.other` row unsubscribed |
| `pane.split`, `send-text`, TUI driving | OPT-OUT | not needed — proof drives the socket directly, deterministic |
| `pane.report_agent` for unknown/`copilot`-class agent ids | OPT-OUT | D19-10: unmapped ids count in `unmapped` by agent id, never emitted |

## Muse 1.4.4 plugin CLI

| capability | decision | reason |
|---|---|---|
| `muse plugins validate --json` | INTEGRATE | projector gate: `valid: true` with zero diagnostics (D19-20) |
| `muse plugins install --scope user` / `update` | INTEGRATE | projector installs then updates the bundle (D19-20); proof uses scratch HOME only |
| `muse plugins approve` / `inspect --json` | INTEGRATE | every install resets approval to `review_needed`; `--check` requires `trusted_enabled` (D19-20) |
| `muse plugins list --json` | INTEGRATE | drift detection: installed hook/redactor sha256 vs projected (D19-20 `--check`) |
| `muse plugins hook test <plugin>:<hook> --fixture` | INTEGRATE | proof-only driver: runs the installed hook with a fixture envelope, no model runs (D19-26) |
| `PostToolUse` hook | INTEGRATE | `tool.call` emission (D19-18) |
| `PostToolUseFailure` hook | OPT-OUT | fires only for failed tool calls; LANEB-04 names PostToolUse only; gap recorded in `docs/collectors.md` (research OQ2) |
| real headless Muse model turn | OPT-OUT | spends model quota; optional operator-approved manual item only, never in the autonomous proof (D19-26, open item 2) |
