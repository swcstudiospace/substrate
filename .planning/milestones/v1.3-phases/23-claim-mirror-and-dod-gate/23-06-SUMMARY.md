# 23-06 SUMMARY — Rehearsal, docs, live-proof runbook (COMPLETE)

Wave 6 (MIRROR-08). Commit `feat(23-06)` on `gsd/v1.3-p23-claim-mirror`.

## Landed

- `rehearsal-env.ts` — opt-in `trackers?` block on `buildRehearsalEnv`:
  `HERMES_LINEAR_URL`/`LINEAR_API_URL`/`NOTION_API_URL` each through
  `assertLoopback`, plus random `rh-linear-*`/`rh-notion-*` scratch keys
  generated per call, never the host's keys (the allowlist never forwards
  those). Off by default; existing rehearsals unchanged.
- `rehearsal-env.test.ts` — 4 tests: absent-by-default, loopback values
  round-tripping through the real `loadConfig`, non-loopback refusal per
  key, randomness + host-key separation across builds.
- `scripts/mirror-smoke.ts` + `bun run smoke:mirror` — sources only
  `consumer.env`, refuses production ports/non-loopback hosts (twin URL
  and scratch PG host), stands loopback fakes (Linear GraphQL state
  machine, Notion pages, connector `/v1/complete-issue` with the versioned
  approval rule) on ephemeral ports, drives the real service layer (real
  `IndexStore` on scratch PG, real mirror/clients/gate, scratch keys):
  claim, refused second claim, release, reclaim, silent heartbeat,
  dod-required, dod-approval, steal (after a 33 s lapse), forced release,
  reap, swarm claim — **38/38 checks green**, asserting the fakes'
  recorded requests (exact state/label/comment effects, zero writes from
  renewed paths and losing claimants, review + In Review effects,
  connector POST fixture shape).
- `index-store.ts` — fixes the 23-03 reaper CTE regression the smoke
  found (trailing comma before `FROM` + dropped `lease_expires_at`/
  `lease_heartbeat_at` CAS columns broke every `reapExpiredLeases` call).
  Live `index-store.lease` tests pass against scratch PG (29/29).
- `event-sources.ts` — drift fixes table-side: `mirror.failed` sample
  `op: "comment"` → `"claim"` (an actually emitted op); the
  `lease.release.dod` sample `{checks:[...]}` → the implemented
  `{tests_pass, review_pass, summary_chars}`. Doc table needs no change
  (kind/surface/action already match).
- `docs/coordination.md` — "Tracker mirror" section replaces the
  no-Linear-client note, covering dod-required, the swarm edge and silent
  releases; tool descriptions updated.
- `docs/runbooks/mirror-proof.md` — MIRROR-08 sequence on `SWC-467` with
  60 s read-only checks, approval gate in the header, zero executed live
  results (NOT RUN).

## Verification

- `bunx tsc --noEmit` clean; `bun test` 2265 pass / 0 fail;
  `bun run check:phase-close` pass; `bun run smoke:mirror` 38/38.
- Live proof NOT RUN (operator-gated, listed in the runbook evidence table).

## Next

- PR into main, Greptile review, merge-if-green. Branch NOT pushed at
  summary time.
