# Phase 77: Steering idempotency and ordering — UAT

**Phase goal:** A steering command carrying an idempotency key applies once across retries and carries a sequence number, so the reader sees delivery order.
**Automated verdict:** `human_needed` — 5/6 truths verified in process; restart durability behavior-unverified.
**Date:** 2026-11-19
**Automated report:** `77-VERIFICATION.md`
code review skipped (Greptile unavailable, owner override 2026-11-19 — CI gates apply)

All items below are operator-gated resume commands. An agent must not deploy, enable flags, or rehearse production migrations — record completion and resume.

## UAT-77-1 — Migration rehearsal (migrations 44, 45)

**Test:** On a restored production dump, apply and roll back migrations 44 (`planning_steering_audit_delivery`, `packages/mcp-server/src/index-store.ts:960`) and 45 (`planning_steering_movements`, `index-store.ts:993`), following `docs/runbooks/rollback-compat.md`.
**Expected:** Both migrations apply and roll back cleanly; comments in `index-store.ts` document this rehearsal requirement.
**Why human:** Operator-gated: production migrations and restored-dump rehearsal are not run by an agent.
**Resume command:** `bun test packages/mcp-server/src/planning/steering-idempotency.pg.test.ts` with `SUBSTRATE_TEST_PG_URL` set to a disposable Postgres — six of six restart cases pass (steering-idempotency.pg.test.ts:166,184,208,223,239,254).

## UAT-77-2 — Restart durability (truth 6)

**Test:** Run `packages/mcp-server/src/planning/steering-idempotency.pg.test.ts` against a disposable Postgres (`SUBSTRATE_TEST_PG_URL` set). Each "restart" swaps `IndexStore`, `Substrate`, and the in-process reply index over the same database.
**Expected:** Six of six restart cases pass — keyed queue and keyed acknowledgement replay after restart with the original reply, same sequence, and no second row.
**Why human:** The verifier had no disposable Postgres; the pg suite was not run. In-process behavior is covered by named tests (prior run: 60/60 passing; tests not re-run this session per SKIP gates instruction).

## UAT-77-3 — Read of "writes nothing"

**Test:** Confirm that a replayed keyed command writing one access-audit row (audit-before-effect in `executeLiveCall`) is acceptable under criterion 1.
**Expected:** Owner accepts the reading ("no steering or session transition"), or opens a separate decision about skipping the access-audit write on replay. Not a fix in this phase.
**Why human:** ROADMAP wording against the house audit-before-effect rule is a policy call.

## UAT-77-4 — Production flag enablement

**Test:** Before `SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE` (`packages/mcp-server/src/planning/steering-store.ts:47`) is enabled in production, confirm migrations 44 and 45 ran and the durable replay path is live (durable sink selected only when the flag is on; `service.ts:1812`).
**Expected:** Operator approval recorded. No flag change or migration performed by an agent.
**Why human:** Production flag and migration change; operator gate.

## Deferred / non-blocking

- `packages/cli/src/steer/client.ts` does not send `idempotency_key` yet — declared non-goal; additive, can follow without a server change.
- `docs/live-steering.md:33` still says "Queue/ack remain **unkeyed**" — stale line, non-blocking, fix separately.
- In-memory index bound: past 10,000 applied keyed acknowledgements the oldest entry is evicted and the durable log (when on) answers the replay (L77-04).
