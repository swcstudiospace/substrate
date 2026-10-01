---
gsd_state_version: "1.0"
milestone: v1.0
status: completed
last_updated: "2026-10-01T02:01:24.421Z"
last_activity: 2026-10-01
last_activity_desc: Milestone v1.0 completed and archived
state_head: 5ea070fa103d247e5379929f1fcc74f1d727a881
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 6
  completed_plans: 6
  percent: 0
---

---
gsd_state_version: "1.0"
milestone: v1.0
milestone_name: "Agent Substrate - four planes (runtime, memory, skills, ledger) keyed by Graph ID + v0.3 SOTA governance/A2A"
current_phase: done
current_phase_name: "Milestone complete"
status: v1.0 milestone complete
last_updated: 2026-10-01
progress:[░░░░░░░░░░] 0%
  total_phases: 8
  completed_phases: 8
  total_plans: 8
  completed_plans: 8
  percent: 100

# State

## Current

**Phase 2 (Claims and dispatch +2.x) COMPLETE (2026-10-01).**

- Lease CAS + TTL + heartbeat + token on graph_nodes (index-store + migrate + alter).
- claimNode now supports steal on expiry, returns lease; release/heartbeat impl.
- mcp: graph_claim +ttl, graph_heartbeat, graph_handoff (packet + stub sign).
- service: lease in claim event payload; heartbeat exposed.
- dispatcher stub (TS): handoff packet, sign, claimWithLease, detectDrift.
- Proof: tsc clean, 142 tests (claim paths), dispatcher smoke, health p95.
- Artifacts: CONTEXT/PLAN/SUMMARY in phases/02-claims.

**Phase 1 (Lane B +1.x) COMPLETE (2026-10-01).** 

Substrate-mcp healthy.
**Phase 0.5 (Governance v0.3) complete.** Policy gate skeleton (4 statuses), default-deny RBAC, quarantine, Dragonfly skel, leases, multi-tenant, OTLP/SLO stubs. 5 ADRs + docs/governance.md + infra. Apps wiring plan. A2A in roadmap.

**Phase 1 (Lane B +1.x) COMPLETE (2026-10-01).** 

- Hermes (eng-board + prompt-uplift): already emits via substrate_client ( /events, redaction, token). run_substrate_brief + event in hook.py. pre_llm_call integrates.
- Grok Build collector: running (active), emits.
- Substrate: /brief /events /healthz ready (with p95 timing for OTLP).
- OTLP/SLO added (p95 on brief/events in healthz, windowed, boring). Verified live (after calls) and source test.
- CLI: supports brief/emit --graph G --surface S [--write] ; .substrate/BRIEF.md ; verify. Smokes run.
- GrokBot connector v0.4: packages/connector-ext (memory_brief/write/events_emit/graph_get + handoffEvent for graph handoff). Direct/CLI. tsc/smoke verified.
- GrokBot production loop: example in docs/grokbot-production-loop.md + substrate.yaml + CLI.
- herdr (Orca/herdr): collector runner herdr.ts + herdr-map.ts ; herdr runtime present. Native first.
- substrate.yaml + projector for Lane B surfaces (hermes/omp/muse/grok*/...).
- Proof exercised: tsc clean, 142 tests pass (no reg), CLI brief/emit w/ graph + claim sim flow (emit claim + brief includes graph header), p95 numbers in healthz, verify cmd, health, grok/herdr collectors smoke.
- All additive/fail-open per plan.

Substrate-mcp healthy.

## Phase 0 (complete)

... (prior)

## Deployment

... (prior)

Dragonfly/Timescale/Hindsight private; use Tailscale or proxy.

Phase 1 artifacts: phases/01-lane-b/{CONTEXT,PLAN,SUMMARY}.md

## Current Position

Phase: Milestone v1.0 complete
Plan: —
Status: Awaiting next milestone
Last activity: 2026-10-01 — Milestone v1.0 completed and archived

## Operator Next Steps

- Start the next milestone with /gsd-new-milestone
