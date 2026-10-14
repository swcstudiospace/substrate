# Uplift 5 — recon record (read-only)

**Date:** 2026-10-14 · **Graph:** `ut-mv7mtq2j-b41cedcc` (Notion task https://app.notion.com/p/3f9bc1a0c7ae81eeaccbc39783bef373; nodes n1 [SPE-11977](https://linear.app/swcstudio/issue/SPE-11977) scope · n2 [SPE-11978](https://linear.app/swcstudio/issue/SPE-11978) audit · n3 [SPE-11980](https://linear.app/swcstudio/issue/SPE-11980) candidates · n4 [SPE-11979](https://linear.app/swcstudio/issue/SPE-11979) failure modes · n5 [SPE-11982](https://linear.app/swcstudio/issue/SPE-11982) select seven · n6 [SPE-11981](https://linear.app/swcstudio/issue/SPE-11981) clarifications · n7 [SPE-11983](https://linear.app/swcstudio/issue/SPE-11983) partition · n8 [SPE-11984](https://linear.app/swcstudio/issue/SPE-11984) waves). Nine read-only lanes: L1 VPS hardening, L2 flag promotion, L3 release gate, L4 skills governance, L5 dashboards, L6 durable events, L7 claim dependencies, L8 request path, L9 first-deploy risk.

## GSD state

`.planning/ROADMAP.md` v1.3 is complete and archived; as for uplifts 1-4 this is a standalone post-close series under `.planning/uplift-5/` with STATE.md rows and no new ROADMAP milestone. The operator re-issued the same prompt a sixth time (after uplifts 3 and 4 merged) and, asked at the proposal gate on 2026-10-14, chose **"Accept all 7 and implement"** and **"Merge only; operator deploys"** (nothing is deployed to the VPS by this series). The graph's auto-plan was partly boilerplate (planning degraded); its generic candidates (namespaced cache keys, unified observability, provider retry/backoff, a pooler, engine swaps, paid tiers) were superseded by the evidence-cited seven because those areas are already delivered, external, or out of the cost-neutral rule.

## What is delivered and must not be re-proposed

Uplifts 1-4 (see `.planning/uplift-3/CONTEXT.md`, `.planning/uplift-4/HANDOFF.md`): breakers and budgets, ledger/index archives, SLO history (`/slo/history`), drift doctor, cache single-flight and stale-while-revalidate (shadow), brief profile (shadow), recall-in-brief (off), Hindsight inventory (off), docs freshness. Production runs release `9231f43` (uplift 2); uplifts 3 and 4 are merged and undeployed.

## Per-lane findings that shaped the seven

| Lane | Finding | Evidence |
|---|---|---|
| L1 VPS | All units share one hardening block; `systemd-analyze security` 8.1 for mcp/dispatcher/grok collector. Class B units (muse, dispatcher, herdr, host) write `.git/info/exclude` and run `git worktree add` in operator repos, so `ProtectHome=false` must stay; Class A can take `ProtectHome=read-only`, `ProtectSystem=strict`. No test calls `systemd-analyze`; the doctor's property list has no hardening fields. | `infra/vps/*.service`; `muse.ts:310-331`; `worktree.py:22,134-147`; `doctor-runtime.ts:128` |
| L2 flags | About 20 shadow/report/off flags; evidence series exist for most but the history allow-list lacks would-serve-stale, profile and recall series; names read ~223 vs `.env.example` ~179; a registry must live in `packages/mcp-server/src` because of the `HINDSIGHT_` token lock (precedent `legacy-env.ts`). `admission.limited_rate` reads 0 in shadow by design. | `slo.ts:341-358`; `metrics-history.ts:90-102` |
| L3 release gate | CI has two jobs both gated `vars.CI_ENABLED`; `verify.test.ts` pins the `run:` lines and exactly two `if:` lines; the rehearsal harness is isolated, `--pull never`, refuses production ports, but has no pause/unpause, and `chaos-smoke` needs a real outage. | `ci.yml`; `verify.test.ts:186-232`; `rehearsal.ts:50,117,949-960` |
| L4 skills | `skills_list`/`skills_approve` do not exist; approval is an owner merge; state is a host-local JSONL; operator concept (`isOperator`) and the audit/admission/observe/event-sources registries are closed and test-pinned. | `service.ts:~2453-2570`; `skills/propose.ts:41`; `config.ts:983` |
| L5 dashboards | OTLP exporter JSON-only and off; `/metrics` is JSON; `/slo/history` is the dashboard-ready feed; no dashboard assets in the repo. | `otlp.ts`; `metrics-history.ts:565-701` |
| L6 events | Collectors drop on outage; `EventInput` has no key; `agent_events` is append-only with no ALTER; per-session emit chain exists; precedent spool `retain-outbox.ts`. | `emit.ts:10-12`; `event.ts:140`; `greptime.ts:411-415`; `service.ts:1597-1614` |
| L7 claim deps | edges only returned by `getGraph`; `graph_claim` does not enforce; the docs explain why. **Not selected.** | `docs/coordination.md:315-318`; ADR 0001 |
| L8 request path | cache key = sha256(surface, generation, args); one write bumps MEMORY twice; heartbeat bumps the graph key although briefs never print a lease expiry; `getGraph` 4 serial statements; `/healthz` memoised not single-flight. | `service.ts:1786,1806,2819-2826`; `index-store.ts:602-616`; `server.ts:663-668` |
| L9 first deploy | `deploy-release.sh` never runs the new config loader pre-swap; rollback restart not health-checked; boot order loadConfig → `await migrate()` → listen; no rollback-compat tests; all seven timers unref'd and bounded. | `deploy-release.sh:621,630-647`; `index.ts`; `index-store.ts:314-510` |

## Build Plan citable index (Notion, re-read 2026-10-14: v0.2 last edited 2026-09-30, v0.3 addendum 2026-09-30, unchanged)

Ids as in `.planning/uplift-2/CONTEXT.md:35-57` (BP-1, BP-2, BP-3.2, BP-5.0, BP-5.1, BP-5.4, BP-7, A-1, A-3, A-4, A-5, A-7). Items map to: U5-1 → A-5c, A-7 #5, N-OPS; U5-2 → BP-1/BP-2, A-5; U5-3 → A-3, BP-5.0d; U5-4 → A-5b, A-5c; U5-5 → v0.3 §4, §6 "4.x", A-4d; U5-6 → A-3, A-7 #3, BP-7; U5-7 → A-3, A-5.

## Guardrails that bound the work (unchanged)

`bunx tsc --noEmit`, `bun test` (F-01 `--port 7410` guard is shared-checkout-only), `bun run check:phase-close`, `bun run test:py`; store lock; `EVENT_KINDS` 12 / `SURFACES` 27 closed; audit-policy entry for every new write; nothing deletes production data; flags default off or shadow; units, timers, drop-ins and Railway variables are operator steps; merge path PR → CI `verify` → Greptile 5/5 with no open threads → `ultrathink-ship` squash. Greptile's recurring defect classes on PRs 58-61 and on the uplift-3/4 PRs (auth before side effects, partial-failure ordering, unguarded timers and writers, cache keys missing a dimension, unbounded growth including seeded state, mount/path assumptions, verification soundness, clock-skew assumptions, doc accuracy) are every implementer's preflight checklist.
