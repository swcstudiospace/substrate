# Interoperability + tracking design — Wave 4 (n5 SPE-38288) · 2026-11-26

Consumes inventory (n1), decomposition (n2), matrix F1–F7 (n3), defaults (n4: Linear authoritative).

## Shared identity / time / correlation

- Entity/event IDs: `source-system:entity-type:stable-key` (LightRAG already uses `repo:relpath`); sha256 content hash = dedup key; correlation = graph_id/request id propagated through mcp-server planes into logs.
- Time: UTC `timestamptz`, ms precision (existing schemas); ordering `(occurred_at, seq)` — `graph_history` (v50) + `ordered_event_log` (v52) PKs enforce monotonicity per graph.
- Lineage: LightRAG run_id + manifest hash per batch; checkpoint never advances on failure (sync tool semantics, verified).

## Authority (no duplicated source of truth)

| Data | Owner | Cached/projected at |
|---|---|---|
| events/ledger | GreptimeDB | Timescale Merkle root only |
| graph/leases/memory | TimescaleDB plain tables | Dragonfly hints only (never leases) |
| docs retrieval | LightRAG (derived) | source docs + `corpus_documents` manifest |
| memory recall | Hindsight banks | LightRAG context join (46) |
| hot reads | Dragonfly cache-aside | TTL 300/600/60 → re-read owner |

## Tracking (Linear/Notion programming)

Per outstanding phase (10): parent Linear Issue + Notion row, composite key `substrate:m<ver>:p<num>`, sha256 idempotent sync, 3-retry + ledger audit (`notion-linear-mapping.md` §1–6). Graph rows SPE-38284…90 + 47 sub-issues already exist (Notion task `Implementing` 2026-11-26). New per-feature sub-issues create only after Wave-3 sync gate (Notion DB ID + Linear team confirmation). Feature rows: F1–F7 with stable keys `GSD-p<phase>-F<n>`.

## LightRAG continuation (F6/F7)

Resume per-repo sync (bg runs), idempotent hash-skip, quarantine-on-failure, per-batch retrieval check (naive today; `retrieval_evals` harness after v52 apply). 4 repos pending: agent-substrate (889), agent-swarm (1752), autonogrammer (3480), claude-ultrathink (1252).

## Quality posture

Typed clients, env config, parameterized queries, secret redaction (Biome/tsconfig strict is the standard). No new framework. Failure isolation: single-resource outage → owner re-read / degraded status, never silent; queues/checkpoints preserved.
