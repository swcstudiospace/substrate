# SELF_IMPROVING_MEMORY_BANK_PROPOSAL

**SPE-5830**

**Wave:** 3 (design phase, read-only proposal based on wave 2 inventory)

**Status:** Draft proposal. No implementation.

## Assumptions (Explicitly Stated from Inventory)

- Inventory limited to wave 2 findings only (n2-db-inventory + n3-memory-map). No assumptions about unconfirmed DBs, features, vector stores, Dragonfly wiring, or realtime surfaces.
- Postgres (via packages/mcp-server/src/index-store.ts) is the only current backing for memory_entries + FTS + graph state. anchors table uses jsonb for teachable_anchors. No vector indexes or similarity native.
- GreptimeDB (packages/mcp-server/src/greptime.ts) is append-only for agent_events (with hash/prev) + teachable anchors support. Events + teachables are event-sourced.
- Dragonfly (redis compat) is planned/configured in infra/railway/* and docs/governance.md, .planning/PROJECT.md but "not wired" in mcp-server/src/{config.ts,service.ts,index-store.ts,greptime.ts}.
- GSD state (n3) is strictly file-based: .planning/ artifacts (singleton STATE.md, ROADMAP.md, PROJECT.md, config.json + per-phase phases/*/{CONTEXT.md,PLAN.md,SUMMARY.md}), .substrate/BRIEF.md fallbacks. Substrate memory plane is DB-backed.
- Gaps per n3 (no cross-run similarity/success weighting, file overwrite risk on singletons like STATE/ROADMAP, no pruning of artifacts).
- Memory kinds include "teachable" (types.ts); teachables reverse skills from sessions (anchored on Solana in ledger).
- All memory writes go through policy gate (service.ts); brief composes from index (memoryForBrief) + greptime.
- Citations limited to inspected files in n2/n3: packages/mcp-server/src/{index-store.ts,greptime.ts,types.ts,service.ts,brief.ts,mcp.ts}, .planning/{STATE.md,ROADMAP.md,PROJECT.md,phases/*/*}, docs/*, infra/railway/* . No other sources.
- Proposal is additive; integrates with existing memory.write/search, GSD discuss/plan flow. Manual gate default (per q3?).
- Postgres is "index/cache" (Notion/Linear = source of truth per PROJECT.md).

## Current Inventory (Wave 2: n2 + n3)

### n2 DB Inventory (Postgres + Greptime + Planned Dragonfly; No Vector)
From direct inspection of allowed paths only (packages/mcp-server/src/index-store.ts, greptime.ts, config.ts, service.ts, types.ts, docs/greptime-ledger.md, governance.md, .planning/PROJECT.md, substrate.yaml, infra/railway/* etc).

- **Postgres (Bun SQL, SUBSTRATE_PG_URL)**: 
  - Tables (index-store.ts:38-110 migrate):
    - graph_index, graph_nodes (with leases: lease_expires_at etc), graph_steps.
    - memory_entries (id text pk, scope, kind, body, source_event, writer, trust, ttl, created; indexes: memory_scope_idx, memory_fts_idx using gin(to_tsvector('english', body)) ).
    - anchors (id, hour, merkle_root, solana_sig, event_count, teachable_anchors jsonb, created).
  - Writes: writeMemory (redact + insert), searchMemory (FTS plainto_tsquery + scope + order by created desc).
  - Usage: brief (memoryForBrief scopes: global/repo:/graph:), handoff via memory.
- **GreptimeDB (HTTP, append-only)**: agent_events (TIME INDEX, PK surface+repo+graph+kind, hash/prev chain for ledger), anchors table. No update/delete. teachable support via events + Solana.
- **Dragonfly**: Planned (ioredis) for brief snapshots (ttl), outbox, circuit breakers, lease mirror, policy cache. Config in infra/railway/dragonfly-client.example.env, substrate-governance.railway.yaml, governance.md, PROJECT.md. Not present in mcp src wiring (config/service/index/greptime use only pg+greptime).
- **No vector**: Confirmed absent in all inspected.
- **Other**: Timescale mentioned as possible PG backing (PROJECT.md) but no hypertables/DDL exercised. All via single-writer substrate-mcp. Redaction pre-store. Fail-open on brief.

Citations: packages/mcp-server/src/index-store.ts:84 (memory_entries), :100 (anchors jsonb), :286 (search FTS), greptime.ts, .planning/PROJECT.md:48-52, docs/governance.md, infra/railway/* .

### n3 GSD State Inventory (File-Based + DB-Backed Substrate)
From ONLY .planning/*, phases/*/*.{md}, .substrate/BRIEF.md, packages/mcp-server/src/{service.ts,brief.ts,mcp.ts}.

- **File-based GSD/planning artifacts**:
  - Singleton: .planning/STATE.md (yaml: gsd_state_version, current_phase, milestone, progress, refs to phase artifacts), .planning/ROADMAP.md (phases list + details), .planning/PROJECT.md (arch), .planning/config.json (workflow).
  - Per-phase: phases/<id>/{CONTEXT.md (goal/current/success), PLAN.md (breakdown), SUMMARY.md (delivered/evidence/artifacts)}.
  - Fallbacks: .substrate/BRIEF.md (written by sessions; Muse fallback), SUBSTRATE_BRIEF.md (injected to VMs/disk).
  - Git for drift/skills library.
- **DB-backed substrate memory/state** (delegated, observed in mcp files):
  - Memory: writeMemory/searchMemory/memoryForBrief -> Postgres memory_entries (DB-backed).
  - Graph/claims/leases: claimNode (CAS+TTL on graph_nodes Postgres), events to Greptime.
  - Brief: compose from index (DB) + greptime (runtime, degrades).
  - In-proc: policy gate (quarantine etc before DB write).
- **Gaps** (explicit per n3, relative to self-improving/realtime):
  - No cross-run similarity/success weighting.
  - File overwrite risk (singleton STATE/ROADMAP, phase files).
  - No pruning (artifacts accumulate).
  - Additional: no phase lifecycle in events (n4 cross-ref), write-only events (no push), planning state separate from substrate memory (no unified learning), teachables in kinds but no auto cross-phase recall/weighting.
- Classification table (excerpt): Memory entries/Graph state = DB-backed (Postgres); Planning/brief fallbacks/STATE = file-based; Events = Greptime append.

Citations: .planning/STATE.md:2 (gsd_state_version), .planning/ROADMAP.md:5, phases/02-claims/PLAN.md, phases/*/SUMMARY.md, service.ts:215 (writeMemory), brief.ts: (compose), mcp.ts:45 (memory_write).

Substrate memory plane (DB) and GSD planning (files) are disjoint; no automatic lesson capture across runs.

## Proposed Design: Self-Improving Memory Bank

Augments existing memory_entries (Postgres FTS) + events (Greptime) + file artifacts with auditable, weighted, prunable "lessons" bank. Self-improving via write on phase close + manual, retrieval injected at GSD discuss only, success-weighted over time.

Integrates without replacing: uses/extends memory_entries or new table; anchors for teachables.

### Write Triggers
- Automatic: On phase SUMMARY.md write (GSD execute close) — capture phase outcome as lesson.
- Manual: In any artifact, user adds `## Lesson` block (parsed on next discuss?); or explicit memory.write with special tag.
- Both produce entry with source_path (e.g. phases/02-claims/SUMMARY.md), phase_id, milestone_id.
- Gated by existing memory policy; redacted; success_score seeded (e.g. from summary "complete" indicators or default 0.5).
- Only at discuss/plan boundary; not mid-execute.

### Schema
Auditable extension (new table or jsonb in memory_entries or anchors; Postgres for queryability).

Proposed (additive to memory_entries or new `lessons` table in index-store migrate):

```sql
create table if not exists lessons (
  id text primary key,
  phase_id text not null,           -- e.g. "02-claims"
  milestone_id text not null,       -- e.g. "v1.0"
  ts timestamptz not null default now(),
  type text not null,               -- "auto-summary" | "manual-lesson" | "teachable"
  summary text not null,
  outcome text,                     -- "success" | "partial" | "blocked" | ...
  source_path text not null,        -- ".planning/phases/02-claims/SUMMARY.md" or event id
  tags text[],                      -- ["lease","drift","success"]
  success_score float default 0.5,  -- 0-1; updated on later use/feedback
  -- provenance: graph_id, writer, etc from existing
);
create index lessons_phase_idx on lessons (phase_id);
create index lessons_tags_gin on lessons using gin (tags);
-- FTS on summary/outcome
create index lessons_fts on lessons using gin (to_tsvector('english', summary || ' ' || coalesce(outcome,'')));
```

Stored in Postgres (consistent with memory_entries); linkable from anchors jsonb if needed. Auditable (ts, source_path immutable on write).

Use existing MemoryEntry where possible (add fields?); or dedicated for bank.

### Retrieval
- Query: recency (created desc) + tag filter + success_weight (order by success_score desc, recency) + keyword/FTS (reuse to_tsvector or extend).
- API: extend memory_search or new `memory.lessons(query, tags?, min_score?, limit)` or via brief injection.
- In CONTEXT: top-K relevant lessons injected (cite by ID: e.g. `## Lessons from prior (id:les_xxx, score:0.8): ...`).
- Only success-weighted for self-improving (higher score first); decay? (future).

### Pruning
- Roll to digest: after N entries per phase/milestone (config), summarize into "digest" lesson entry (type=digest), archive originals (move to lessons_archive table or mark archived=true + compress?).
- Archive originals: keep in DB but exclude from active retrieval (or separate table); retain for audit/ledger.
- No file rm (avoid overwrite risk); use DB for bank.
- Trigger: periodic (e.g. on new phase) or manual; preserves teachables.

### Loop Integration (GSD)
- **Only at discuss**: On gsd-discuss-phase (or equivalent), before CONTEXT.md, fetch relevant lessons (recency+tag+success+FTS scoped to current milestone/phase/repo), inject under `## Prior Lessons (from self-improving bank; cite IDs)` into CONTEXT.
- **Cite by ID in PLAN**: In generated PLAN.md, reference lesson IDs (e.g. "adopt lease from les_abc per prior").
- **Manual-gated per q3 default**: Injection is read-only proposal; writes require human review/approval in discuss (q3?); default off or gated (no auto-write without gate). Fail-open: missing bank = no injection.
- Updates to STATE/ROADMAP remain file; lessons augment (DB) for cross-run.
- Phase SUMMARY triggers write post-verify.

Cites: integrate with existing brief compose (brief.ts), memory tools (mcp.ts), GSD artifacts (phases/*/CONTEXT.md writes).

## Tradeoffs
- **+ Self-improving**: Captures lessons across runs (GSD file + DB memory); success weighting improves retrieval over time; pruning keeps growth bounded.
- **+ Auditable**: Every lesson has id, source_path, ts, score; traceable to SUMMARY or manual.
- **+ Low risk**: Manual gate default, only at discuss, additive (no change to memory_entries writes or GSD file writes), uses existing FTS/anchors.
- **- Complexity**: New schema/triggers/retrieval in index; parsing ## Lesson; integration point in GSD discuss (external).
- **- Latency**: Retrieval at discuss may add time (mitigate: cache or limit K=5, timeout).
- **- Adoption**: Relies on consistent SUMMARY + manual lessons; file artifacts still risk overwrite until pruning unified.
- **- Scope**: No vector/similarity (per inventory); keyword+weighted only. Dragonfly not assumed.
- **- vs full realtime**: Bank is for hindsight lessons (discuss); not live event pubsub.
- Boring: Prefer extend Postgres FTS/anchors over new systems.

## Verification (for later phases)
- After design: read proposal; confirm cites only n2/n3 files.
- Later: implement in wave, smoke discuss injection, write lesson, retrieve by score, prune roll.
- Evidence in future SUMMARY: "lessons bank used in CONTEXT cite ID:les_xxx".

## Citations / Links
- SPE-5830 (this proposal)
- n2 inventory: packages/mcp-server/src/index-store.ts (memory_entries FTS, anchors jsonb), greptime.ts, .planning/PROJECT.md
- n3 inventory: .planning/STATE.md (singleton), phases/*/{SUMMARY,PLAN,CONTEXT}.md , service.ts/brief.ts (DB delegation), gaps list
- Related: SPE-5829 (n3), ROADMAP Phase 0.5/4/6 (teachables/governance), types.ts:76 (MEMORY_KINDS incl teachable)
- ADR-0001 (memory governance)

All content derived strictly from provided wave 2 inventory summaries + confirmed file reads. No implementation changes.