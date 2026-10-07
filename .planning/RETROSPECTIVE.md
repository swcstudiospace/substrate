# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.1 — Swarm correlation, governed memory and orchestrate integrations

**Shipped:** 2026-10-07
**Phases:** 5 | **Plans:** 5

### What Was Built
- Phase 7 Database structures: 15 swarm surfaces (swarm-a01-orch..swarm-a15-doc) with per-surface tokens and identity refusal (REST 403 / MCP isError, never re-attribution); graph_bindings table and MCP-only graph_bind (race-safe, one winner), binding notes in their own session (agent-substrate #11, cc65cf9).
- Phase 8 Memory structures: no grant change (wildcard defaults already cover swarm surfaces); tests pin swarm write scopes and default-deny (agent-substrate #12, 7eba2fc); swarm/memory.py governed memory client with kind/scope maps, sha256 idempotency key, a handler for every gate outcome, ok only when accepted and verified_persisted (agent-swarm #6, a25c02a; docs #7, 8c11231).
- Phase 8.1 Version conflicts carry the standing version: versioned conflicts report current_version and the swarm client re-submits from it without searching; the re-read is only the older-server fallback (agent-substrate #13, agent-swarm #8).
- Phase 9 claude-ultrathink integration: after planning, one fail-open `note` event carrying the Graph ID (no prompt text), session `<host session>:<graph id>`, bounded by the planning budget (claude-ultrathink #19, adff86c).
- Phase 10 Swarm orchestrate integration: swarm run log teed to the substrate under one Graph ID per run, attributed per agent, 13 swarm types mapped to existing EVENT_KINDS, deduped, fail-open; orch_plan mints/binds/registers the Graph ID; transport hardened over 4 review rounds (agent-swarm #5, bd5494b).

### What Worked
- Re-grounding on origin/main and ADR 0001 instead of the stale PR #10 branch avoided a contract the ADR forbids (a single agent-swarm surface, new event kinds, a POST /graph door).
- Live end-to-end runs against real Postgres + GreptimeDB on the three merged mains (24/24, 7/7 governed swarm memory, 8.1 live regression: 2 POSTs, 0 searches) caught a binding-note session bug that unit tests had missed.
- Greptile review found real transport defects over 4 rounds (redirects, deadlines, proxies, dedupe, error back-off).

### What Was Inefficient
- Stacked PRs were closed when their base branch was deleted at merge; they had to be restored, reopened and retargeted.
- A GitHub push outage (500s on every push for minutes) stalled shipping.
- The ship CLI broke mid-run because another session left an uncommitted edit in the shared claude-ultrathink checkout.
- The MEM-02 gap passed review and the first audit, requiring an inserted gap-closure phase (8.1).

### Patterns Established
- Identity is refused, never re-attributed: a per-surface token cannot emit or claim as another surface.
- Correlation-to-Graph-ID binding is race-safe with exactly one winner; binding notes live in their own session so events_verify stays green.
- Integrations into the substrate are fail-open and map onto existing EVENT_KINDS rather than adding new kinds.
- Versioned conflicts report the standing version so clients re-submit without searching.
- Milestone proof is a live end-to-end run against real Postgres + GreptimeDB on the merged mains.

### Key Lessons
1. A test fake must not be more capable than the real server: the MEM-02 gap passed review and audit because the fake answered subject queries the real server cannot (memory_search matches bodies only, newest 100 per scope).
2. Re-ground on origin/main and the governing ADR before building on an existing branch.
3. Run live end-to-end checks against real backing stores; unit tests missed the binding-note session bug.
4. Do not delete a base branch at merge while stacked PRs depend on it.

### Cost Observations
- Model mix: not tracked
- Sessions: 1
- Notable: the transport client needed 4 Greptile review rounds before merge; each round found real defects.

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.1 | 1 | 5 | Re-grounded on origin/main + ADR 0001; live end-to-end proof on real Postgres + GreptimeDB; gap-closure phase 8.1 inserted after the first audit |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|-------------------|
| v1.1 | Live e2e 24/24 + 7/7 governed memory + 8.1 regression | not tracked | not tracked |

### Top Lessons (Verified Across Milestones)

1. A test fake must not be more capable than the real server (v1.1; not yet verified across milestones).
2. Live end-to-end runs against real backing stores catch what unit tests miss (v1.1; not yet verified across milestones).
