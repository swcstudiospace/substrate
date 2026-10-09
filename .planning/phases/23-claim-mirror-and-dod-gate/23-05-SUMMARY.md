# 23-05 SUMMARY — Read tools (COMPLETE)

Wave 5 (MIRROR-07). Commit `6e1127f feat(23-05)` on
`gsd/v1.3-p23-claim-mirror`.

## Landed

- `index-store.ts` — `findNodesByLinear` ({linearIssueId?,
  linearIdentifier?}: id query first, then identifier, each `limit 2`)
  plus `LinearNodeMatch` (node row joined to graph repo/branch/status).
  Read-only; no new state write.
- `service.ts` — `findNode` (D23-22: at-least-one-ref validation; zero →
  `found:false` naming the wanted ref; several → `found:false` naming both
  candidates; one → `found:true` with graph/node ids, repo, branch,
  graph_status, node with `lease_id: null`, public lease view via
  `leaseView` — holder, epoch, expiry, never the id) and `getIssue`
  (D23-23: node via `getNode`; Linear text via `mirror.issueText`;
  both fields through the shared `redact()` — no new redactor — capped
  title 500 / description 20000 with `…[truncated]`; exact
  `UNTRUSTED ISSUE TEXT` banner; Linear-off / no-ref / read-failure →
  `found:false` with reason). Both MCP-only, both silent (no emit).
- `mcp.ts` — `graph_find` + `issue_get` registrations with descriptions;
  pass-through to the service.
- `observe.ts` — `KNOWN_TOOLS` gains both names in the MCP section; REST
  section untouched; `event-sources.ts` untouched (Phase 23 silent rows
  used as-is).

## Tests

- `service.test.ts` — 7 tests: neither-ref refusal without index touch,
  id-first match priority, zero/multi ambiguity naming, nulled lease +
  public view + JSON-wide lease-id absence, boundary caps with marker and
  exact banner, `redact()` wiring on both fields (assembled-at-runtime
  `api_key` shape masked), all five `found:false` reasons, emission
  silence throughout.
- `mcp.test.ts` — tools listed; protocol-level refusal without refs;
  pass-through resolution with lease absence and emission silence.
- `observe.test.ts` — `toolLabel` pins for both names.

## Verification

- `bunx tsc --noEmit` clean.
- `bun test mcp.test.ts service.test.ts observe.test.ts` — 283 pass, 0 fail.
- `bun test redact-lock.test.ts vocabulary-lock.test.ts` — 21 pass, 0 fail.

## Next

- Plan 23-06 (rehearsal block, smoke:mirror, coordination docs,
  mirror-proof runbook, phase-close trio, table+doc drift fixes).
- PR into main, Greptile review, merge-if-green. Branch NOT pushed (6
  local commits ahead of origin/main).
