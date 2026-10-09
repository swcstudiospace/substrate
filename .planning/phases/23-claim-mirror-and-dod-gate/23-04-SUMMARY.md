# 23-04 SUMMARY — DoD gate (COMPLETE)

Wave 4 (MIRROR-04). Commits `f4ae3b7 feat(23-04 partial)` + `dd079ac feat(23-04)`
on `gsd/v1.3-p23-claim-mirror`.

## Landed

- `packages/mcp-server/src/dod-gate.ts` — `runDodGate` (D23-15 steps 2-6):
  already-Done skip, In-Review mirror with continuing warnings, no-dod means
  no connector call (`dod-required`), versioned `6e532fe` connector protocol
  (`POST {url}/v1/complete-issue`, no auth, only explicit `completed:true`;
  non-2xx/unreachable/malformed refuse; timeout settles via Linear state).
  Leaf (imports only mirror types). Never throws.
- `packages/mcp-server/src/dod-gate.test.ts` — 10 tests: zero-call no-dod
  path, request/response/502 fixture pins, timeout settlement both ways,
  already-Done skip, review-failure continuation, connector-body leak check.
- `index-store.ts` — `reviewNode` (single fenced `started_review` UPDATE +
  TTL extension, heartbeat refusal shape; the only new state write) and
  `getNode` read for gating. `:732` rule intact.
- `service.ts` — `emitMirrorFailures` extracted for gate-path reuse;
  `completeNode` gated branch per D23-14 (gate iff non-forced, state
  completed, Linear ref, non-swarm holder, mirror on, lease present; else
  main path; forced/other-state → fenced path + `close` mirror; swarm →
  main path + `done` mirror, comment-only via the mirror; no ref → main
  path unchanged); `releaseNode` optional `dodNote` merged into the release
  emit payload (`payload.dod` {tests_pass, review_pass?, summary_chars},
  never summary text); dod input validation (non-empty summary ≤2000,
  tests_pass boolean → `dod-invalid` before the review write); fenced
  approval with caller lease; post-approval fence failure →
  `completed:false` + main's refusal + one `{action:"dod"}` warning while
  Notion still records Done; every refusal returns main's shape plus dod
  reason fields with node at `started_review` and lease kept.
- `service.ts` public `releaseNode` split from private `fencedRelease`: the
  fence decision (which carries the compared lease id) and the row stay
  inside; tool replies carry the outcome only (D23-04 — the gate leak test
  caught the decision id reaching the reply during development).
- `stores` seam gains `dodGate?` {fetchImpl, hermesLinearUrl, timeoutMs}
  overriding config in tests.
- `mcp.ts graph_complete` — `dod` zod schema (summary 1..2000, tests_pass,
  review_pass?) + description (dod requirement, swarm exception);
  pass-through to completeNode.
- `service.test.ts` — 15 gate tests: ungated no-ref/forced/other-state/
  swarm routing, dod-required parking, approval note shape (`summary_chars`,
  no summary text anywhere but the connector POST), already-Done skip,
  dod-refused/dod-unavailable, timeout settlement both ways, post-approval
  fence failure with Notion Done, review-refusal silence, dod-invalid,
  lease/summary placement leak test.

## Verification

- `bunx tsc --noEmit` clean.
- `bun test dod-gate.test.ts service.test.ts server.authority.test.ts
  index-store.lease.test.ts mirror.test.ts mcp.test.ts` — 275 pass, 0 fail.

## Next

- Plans 23-05 (graph_find/issue_get) and 23-06 (rehearsal block,
  smoke:mirror, coordination docs, mirror-proof runbook, phase-close trio).
- `mirror.failed` sample `op:"comment"` and `lease.release.dod` sample
  `{checks:[...]}` drift fixes belong to 23-06 (table + doc together).
- PR into main, Greptile review, merge-if-green. No PR opened yet; branch
  NOT pushed (5 local commits ahead of origin/main).
