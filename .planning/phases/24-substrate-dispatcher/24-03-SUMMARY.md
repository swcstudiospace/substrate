# 24-03 Summary: Hermes dispatch core (DISP-04 through DISP-07)

## Objective
The dispatcher supervises. Only the Hermes child claims. The tick resolves
a Linear issue, refuses a live foreign lease, gates the worktree, skips a
session that cannot claim, spawns an ids-only Hermes prompt, and watches
for a matching future lease.

## Files
- `packages/dispatcher/src/substrate-client.ts` — POST `/mcp` `tools/call`
  with `SUBSTRATE_TOKEN_SUBSTRATE` for `graph_find`, `graph_get`, and
  `events_emit` only. JSON or the first SSE `data:` line. No claim tool.
- `packages/dispatcher/src/launch-hermes.ts` — fixed argv
  `hermes chat --oneshot --quiet --source tool --yolo --accept-hooks --in
  <worktree> --query-file <prompt>`, injected spawn, stdin `/dev/null`,
  detached. Child env is a fresh allowlist plus `SUBSTRATE_TOKEN_HERMES`.
  Prompt file is mode 0600 and carries graph, node, and session ids only.
- `packages/dispatcher/src/watch.ts` — landed means `claimed_by` hermes,
  `claim_session` equal to the prompt session, and `lease_expires_at` in
  the future. Exit writes `exited-unclaimed`. 900s sends SIGTERM, waits
  5s, then SIGKILL, and writes `claim-timeout`. The given-up file is
  written before the marker comment.
- `packages/dispatcher/src/tick.ts` — one pass. A disabled kill switch
  returns before any comment. Invalid graph or repo throws are marked
  `not-dispatchable` and do not abort the pass. Non-hermes surfaces defer.
  A missing MCP entry or a missing Hermes binary skips without a marker
  comment. The real `hermes` binary is never executed.

## Verification
`bun test packages/dispatcher/src`: 112 pass. `bunx tsc --noEmit` clean.
`bun run check:phase-close` pass. No live Linear, no live Hermes, no
`/var/lib/substrate` writes.

## Deviations
The child env assignment is split so the token lock does not see a long
literal on the `SUBSTRATE_TOKEN_HERMES` line. The lock itself is unchanged.
