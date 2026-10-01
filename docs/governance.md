# Governance Plane — Agent Substrate v0.3 (Phase 0.5)

**Status:** Phase 0.5 insert (additive to v0.2 planes).  
**Owner:** A03 (this doc + ADRs).  
**Consumers:** A05 (mcp-server), A06/A07 (index/ledger), A11 (Railway), A13 (SLOs), all surfaces + apps.  
**Related:** ADR-0001 (policy gate), ADR-0002 (Dragonfly), ADR-0003 (leases), ADR-0004 (apps wiring), ADR-0005 (this doc + infra).

## Principles (Non-negotiables from v0.2 + v0.3)

- **Fail open for agents, fail closed for memory.** Briefs and events must never block a prompt. Memory writes that other agents will act on are fail-closed (quarantine or deny with remedy).
- **Single write path.** Redaction, policy gate, hash chain, provenance all happen inside `substrate-mcp`. No collector, app or hook bypasses.
- **Default deny.** Everything is denied unless an explicit rule allows. Surface × scope × kind.
- **Audit everything.** Quarantine, denies, lease steals, policy decisions are events. No silent drops.
- **No breaking v0.2 planes.** Governance is a gate in front of memory_write + new Dragonfly paths. Existing `/brief`, `/events`, graph ops, MCP tools are unchanged. Old claims without leases are treated as "eternal until release".
- **Boring production.** YAML policy, ioredis/Dragonfly client, existing MCP + Postgres index, no new distributed consensus, no sidecars in first cut.

## Policy Model

Policy is loaded at startup from `policy.yaml` (or env override) and cached (Dragonfly for perf).

### Example policy.yaml (clear, production-ready)

```yaml
version: "0.3.0"
tenant: "swc"
default: deny
cache_ttl_s: 300

rules:
  # Default private read/write for known surfaces (additive to v0.2)
  - surface: "*"
    scope: "private"
    kind: "*"
    action: allow
    comment: "baseline private work; still redacted on emit"

  # Public docs are read-only for most; write requires review
  - surface: "*"
    scope: "public"
    kind: "decision|spec|runbook"
    action: allow
  - surface: "*"
    scope: "public"
    kind: "*"
    action: deny
    remedy: "use private scope or submit for review"

  # Quarantine triggers (never silent)
  - surface: "*"
    scope: "*"
    kind: "secret|credential|pii|token|key"
    action: quarantine
    comment: "redactor catches most; this is belt-and-suspenders"

  - surface: "*"
    scope: "*"
    kind: "speculative|plan|todo"
    action: quarantine
    comment: "only after human review or explicit allow"

  # App surfaces (see wiring section)
  - surface: "hindsight-api|hindsight-control"
    scope: "evidence|trace"
    kind: "*"
    action: allow
  - surface: "dragonfly"
    scope: "snapshot|outbox"
    kind: "*"
    action: allow

  # Strict for global / cross-agent
  - surface: "grok-bot|cursor"
    scope: "global"
    kind: "*"
    action: require-review
    comment: "Grok Bot and Cursor changes to shared state need explicit approval gate"

conflict:
  strategy_by_kind:
    todo: last-write-wins
    decision|spec: versioned
    global: require-review
  default: last-write-wins

provenance:
  required: [origin_session, model_id, graph_id, timestamp]
  trust_decay_days: 30
  needs_reverification_after_days: 7

idempotency:
  key: "idempotency_key"
  window_s: 3600
  verified_persisted: true
```

**Return codes from memory_write (additive):**
- `accepted` (with version or last-write info)
- `conflict` (with current version + resolution strategy)
- `quarantined` (with reason + remedy + quarantine_id)
- `denied` (with rule that matched + remedy)

Exactly-once: client supplies `idempotency_key`; substrate verifies persisted before ack.

## Quarantine

- Never drops. Always writes a row to `quarantine` (or Dragonfly list for hot path) with full payload + redacted form + rule + surface + graph_id.
- Human or approved process can `memory.write_approval` to promote out of quarantine.
- Quarantine rate is an SLO (see observability).
- Visible in briefs (as warning) and in evidence exports.

## Dragonfly (Railway)

Chosen for:
- Brief snapshots (graph_id → compressed brief JSON, 5-15 min TTL)
- Write outbox (when Greptime/Postgres degraded)
- Circuit breaker state (per dependency, open/half-open/closed + counters)
- Lease state mirror (low-latency TTL for claims)

Client: simple ioredis-compatible (boring). Private endpoint only (Tailscale or Railway private net).

Smoke: `bun run smoke:dragonfly` (when Greptime down, brief still works from snapshot; writes queue and drain).

See ADR-0002.

## Leases & Coordination Foundations

For Phase 0.5 (base for Phase 2 full claims/dispatch):

- Lease record: `{ graph_id, node_id, holder_surface, holder_session, expires_at, last_heartbeat }`
- Stored in index + Dragonfly (for speed/TTL).
- `graph.claim` does CAS + sets TTL + heartbeat.
- Steal: previous holder notified via event; new claim wins after grace.
- Signed handoff (future): canonical packet {goal, files, dod, blockers, prev_event_hash} + signature or at least hash chain link. Not free text.
- Drift detection stubbed here; full scan in Phase 2.

Old v0.2 claims have no lease record → treated as held until explicit release.

See ADR-0003.

## Observability Foundations (v0.3)

- OTLP from substrate-mcp + connector-ext.
- SLOs:
  - brief p95 < 800ms (Dragonfly snapshot helps)
  - emit success ≥ 99.5%
  - quarantine rate < 0.1% (or alert)
  - lease steal rate (monitor, not hard SLO yet)
- Hash-chained MCP audit (tool call allowed/denied).
- Hindsight consumes via events (not direct).

## Cross Apps-on-Substrate Wiring Plan

**Goal:** hindsight, ragflow, dragonfly, timescale, greptimedb (backing), es, etc. all go through substrate for memory, events, skills, A2A cards. No silos. Per-app bearer or MCP connector.

### Apps List + Integration Points (no direct raw access from seats)

| App / Service | Surface Name | Integration Points | Auth | Notes |
|---------------|--------------|--------------------|------|-------|
| hindsight-api / control / llm-bridge / worker | hindsight-* | events.emit (traces, evidence), memory.search (for context), docs.search proxy | bearer (per surface) or mcp | Primary evidence consumer. Uses substrate for unified view. |
| dragonfly | dragonfly | brief snapshot read/write, outbox, breaker state, lease mirror | internal private | Substrate client (ioredis). Also caches policy. |
| ragflow (all variants) | ragflow | docs.search (proxied via mcp), docs.ingest (redacted) | bearer | No direct RAGFlow MCP from agents; always via substrate. |
| greptimedb / timescale | (backing only) | N/A (ledger/index) | env secrets in /etc only | Never direct from app code. Substrate is the writer. |
| es / redis / mysql / storage | (aux) | via substrate events or future docs | - | Future phases. |
| tailscale-vpn | (infra) | - | - | Networking only. |

**Wiring rules:**
- Every app gets `SUBSTRATE_MCP_URL` (or `/brief` `/events` HTTP) + surface-specific bearer.
- `substrate.yaml` + projector updated to emit per-app config.
- Policy applies (surface=app-name).
- A2A Agent Cards: apps can publish teachables as reverse skills (Phase 4/6).
- Dragonfly shared for degraded mode across apps + agents.
- Evidence: all app actions appear in Greptime + Hindsight via substrate events.

See ADR-0004. Cross-cutting success: "hindsight/ragflow components use substrate paths".

## Architecture (C4 Context / Component view, Mermaid)

```mermaid
graph TD
    subgraph Agents & Surfaces
        CC[Claude Code]
        GB[Grok Build / Bot]
        H[ Hermes / Omp / Muse ]
        CU[Cursor]
    end
    subgraph Railway Apps
        HIN[Hindsight*]
        RAG[RAGFlow]
        DF[Dragonfly]
        TS[Timescale / Greptime backing]
    end
    subgraph Substrate Governance Plane v0.3
        MCP[substrate-mcp<br/>:7410]
        POL[Policy Gate + RBAC<br/>default-deny YAML]
        Q[Quarantine]
        DR[Dragonfly Client<br/>snapshots/outbox/leases]
        IDX[(Postgres Index<br/>+ leases)]
        LED[Greptime Ledger<br/>(unchanged)]
    end
    subgraph External
        NOT[Notion/Linear<br/>source of truth]
        SOL[Solana devnet<br/>anchors + teachables]
    end

    CC & GB & H & CU -->|memory_brief / POST /brief| MCP
    HIN & RAG & DF -->|bearer + events/memory| MCP
    MCP -->|policy| POL
    POL -->|allow / quarantine / deny| Q
    MCP -->|snapshot / outbox / lease| DR
    MCP -->|graph/leases| IDX
    MCP -->|append hash| LED
    Q -->|promote| MCP
    MCP -.->|teachables A2A| SOL
    IDX -.->|backfill| NOT
```

**Boundaries:**
- Trust boundary at MCP (redaction + policy + redact before emit).
- All apps cross the same boundary.
- No app talks directly to backing stores or each other for memory/events.

## Runbooks (Pointers)

- Redaction: see greptime-ledger.md + connector redactor.
- Quarantine: `substrate quarantine list --graph <id>` ; `substrate memory approve <quarantine_id>`
- Lease steal: monitor `lease_stolen` events; manual release via graph.release if needed.
- Dragonfly degraded: `systemctl status substrate-mcp` ; check Dragonfly private endpoint.
- Policy reload: restart (or future hot-reload endpoint).
- Evidence: `substrate evidence --graph <id>`

## NFR Allocation (from Phase 0.5 CONTEXT + v0.3)

- p95 brief <800ms → Dragonfly snapshot + policy cache
- emit ≥99.5% → outbox + fail-open hooks
- Multi-tenant (tenant=swc) → every row + policy
- No silos for apps → wiring matrix above
- Circuit breakers → Dragonfly
- Audit / compliance → chained events + quarantine + MCP audit

## Next (Phase 1+)

- Full signed handoff packets + drift scan (Phase 2)
- A2A Agent Cards + teachables on Solana (Phase 4/6)
- Hindsight full integration + SLO dashboards (Phase 1)
- OTLP everywhere

**No changes to v0.2 planes.** All additions are behind new flags/paths or additive returns.

See also: `.planning/phases/0.5-governance/CONTEXT.md`, ADRs 0001-0005, `docs/greptime-ledger.md`, ROADMAP.md Phase 0.5.
