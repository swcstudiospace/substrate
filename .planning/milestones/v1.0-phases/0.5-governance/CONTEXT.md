# Phase 0.5 — Governance (v0.3 SOTA insert): Context

**Gathered:** 2026-10-01 (from Notion v0.3 locked addendum + user brief)
**Status:** Ready for planning
**Source:** Agent Substrate — Build Plan v0.3 SOTA Addendum (locked by Ove 30 Sep 2026). Companion to v0.2. Inserts before Lane B scale.

## Phase Boundary
Enterprise / production upgrades for memory governance, coordination (leases/signed handoffs/drift), observability/evidence (OTLP/SLOs/MCP audit), Grok Bot production loop. Does not replace v0.2 planes — inserts Phase 0.5 and hardens 1–6.

Locked scope (full v0.3): memory governance · leases / signed handoffs / drift · OTLP / SLOs / evidence · Grok Bot production loop.

## Implementation Decisions
### Memory governance (policy gate in front of every memory.write)
- Default-deny RBAC: surface × scope × kind
- Conflict strategies: last-write-wins (todos) · versioned (decisions) · require-review (global)
- Provenance: origin session, model id, derived_from, trust + decay (needs_reverification)
- Exactly-once writes: idempotency key + verified_persisted ack
- Quarantine for secrets / PII / speculative plans (never silent drop)
**API contract:** memory_write returns accepted | conflict | quarantined | denied + remedy.
**Fail mode:** fail-open on events.emit; fail-closed on memory other agents will act on.

### DragonflyDB (Railway)
- Brief snapshot cache
- Write outbox
- Circuit breakers for degraded mode

### Multi-tenant
- tenant=swc on every row (multi-tenant-ready schema)

### Coordination foundations (with Phase 2)
- Single-holder lease on Graph nodes: CAS + TTL + heartbeat; stolen claims auto-release
- Signed handoff packets (not free text): goal, files, DoD, blockers, prev_event_hash

### Observability foundations
- OTLP from substrate-mcp + connector
- SLOs: brief p95 < 800ms · emit success ≥ 99.5% · lease-steal rate · quarantine rate
- Hash-chained MCP audit (allowed/denied tool calls)

## Existing Code Insights
- mcp-server/src/service.ts , mcp.ts , memory paths (from baseline)
- Greptime for events, Postgres for index (external Railway)
- Redact.ts already in path
- Current substrate.env has GREPTIME, PG, RAGFLOW; add DRAGONFLY_URL etc.
- Phase 0 shipped memory_brief/write with basic redaction.

## Specific Ideas
- Policy YAML loader + gate before any memory.write in mcp.
- Dragonfly client (ioredis or official) for snapshot/outbox.
- Update types, add tests for return codes and quarantine.
- Expose in substrate.yaml and projector for all agents.
- Tenant column + filter in queries.

## Deferred Ideas
- Full 2.x/4.x/6.x in later phases.
- App-specific (hindsight) teachable integration in cross phase.

## Risks / Production
- Performance on every write (cache policy).
- Fail-closed must not deadlock agents.
- Dragonfly private/Tailscale only (like Timescale).
- Audit trail for compliance (enterprise).

## Acceptance (from v0.3 + roadmap)
- Policy enforced in production substrate-mcp.
- Quarantine and exactly-once verified live.
- Dragonfly snapshot used in smoke (Greptime down).
- Runbooks added.
- No regression on Phase 0 proofs.
