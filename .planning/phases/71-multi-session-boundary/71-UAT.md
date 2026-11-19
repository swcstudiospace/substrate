# Phase 71: Multi-Session boundary — UAT

**Phase goal:** Enforce authenticated bindings on live session-scoped reads and writes. Foreign and unknown targets return indistinguishable not-found responses. Live session identifiers are unguessable and never reused. Preserve operator-only steering writes and the redacted repository-wide `session_context` digest.
**Automated verdict:** `human_needed` — 3/5 truths verified in process (SC1, SC2, SC4 behavior-verified by executed tests); SC3 and SC5 behavior-unverified (PostgreSQL restart durability not exercised).
**Date:** 2026-11-19
**Automated report:** `71-VERIFICATION.md`
code review skipped (Greptile unavailable, owner override 2026-11-19 — CI gates apply)

All items below need a human-controlled environment or an owner decision. An agent must not deploy, install systemd units/timers, run Railway writes, devnet sends, anchor funding, hook installs, live LightRAG LLM route, production migrations, or live ingest. Record completion and resume.

## UAT-71-1 — Restart durability (SC3 / HARD-S1)

**Test:** Against a controlled disposable PostgreSQL with `SUBSTRATE_TEST_PG_URL` set, run:
`bun test --timeout 30000 packages/mcp-server/src/live-session-restart.pg.test.ts packages/mcp-server/src/planning/live-session-authority.pg.test.ts`
Each restart swaps the service and SQL pool over the same database, with the optional cache disabled.
**Expected:** Both suites execute (not skip) with 0 failures. Closed identities stay permanently closed, issuance cannot reuse a retained session_id, and unavailable SQL returns session-unavailable, never a grant. (This session: 0 pass / 18 skip and 0 pass / 15 skip — no PG URL was available.)
**Why human:** The verifier had no disposable Postgres; state-transition and restart invariants cannot be established by presence checks.
**Resume command:** `SUBSTRATE_TEST_PG_URL=<disposable-postgres> bun test --timeout 30000 packages/mcp-server/src/live-session-restart.pg.test.ts packages/mcp-server/src/planning/live-session-authority.pg.test.ts`

## UAT-71-2 — Regression completion, digest, and contract acceptance (SC5)

**Test:** (a) Re-run the full `71-VALIDATION.md` recorded steering regression group with `SUBSTRATE_TEST_PG_URL` set and record per-file pass/skip counts. (b) Verify migration 42 digest by running the pure digest generator over `packages/mcp-server/src/index-store.migrations.digests.json` and compare key `"42"`. (c) Record owner acceptance that `packages/mcp-server/src/planning/session-state.durable.test.ts` and `packages/mcp-server/src/planning/steering-sessions-store.pg.test.ts` (listed in `71-04-PLAN.md`) are removed as obsolete with coverage in `live-session-authority.pg.test.ts` / `live-session-restart.pg.test.ts`. (d) Confirm D71-01 operator private-read override: an operator may read any live session's private snapshot without its proof (`authorized()` in `packages/mcp-server/src/planning/steering-sessions-store.ts:143`).
**Expected:** Zero failures and zero PG skips; generator output equals the recorded digest for key 42; owner acceptance and override confirmation recorded. (This session non-PG runs: `live-session-isolation.test.ts` 34 pass, `mcp.steering.test.ts` 21 pass, `admission.test.ts` 58 pass — 113 pass / 0 fail.)
**Why human:** Requires a controlled DB environment, the generator run, and owner policy decisions.
**Resume command:** `cd /root/src/repos/agent-substrate` then run the gate commands named in `.planning/phases/71-multi-session-boundary/71-VALIDATION.md` with `SUBSTRATE_TEST_PG_URL` set to a disposable Postgres; do not run production migrations.

## UAT-71-3 — Greptile review (PR #199 remediation)

**Test:** Observe a completed Greptile review of the phase 71 remediation on PR #199 (`gsd/v18-p71-greptile-fixes`) with no open threads.
**Expected:** Completed review with all findings addressed; a FAILED, SKIPPED, or unavailable review is a blocker, not a pass.
**Why human:** code review skipped (Greptile unavailable, owner override 2026-11-19 — CI gates apply); an agent cannot substitute for the external review gate. CI gates apply instead.
**Resume command:** Obtain the Greptile review result for PR #199 through the repository's normal review flow; record it in `71-VERIFICATION.md`.

## UAT-71-4 — Operator gates (deferred, not performed)

**Test:** Confirm none of the following were performed in this verification: deploy, systemd unit/timer installs, Railway writes, devnet sends, anchor funding, hook installs, live LightRAG LLM route, production migrations, live ingest.
**Expected:** None performed. If the operator later directs any of them, run only the directed command and record the outcome.
**Why human:** Operator-only gates; an agent must not perform them.
**Resume command:** None for this phase unless the operator issues a separate directed task.

## Deferred / non-blocking

- Executed this session (no PG needed): `live-session-isolation.test.ts` 34 pass / 0 fail; `mcp.steering.test.ts` 21 pass / 0 fail; `admission.test.ts` 58 pass / 0 fail. Source edits: none. Greptile: not invoked.
