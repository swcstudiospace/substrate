# Research Proposal: Self-Improving Memory Bank + DB Schema Upgrades + Realtime Event Model (n5/n6/n7/n8)

> **Status:** Research proposal. Nothing in it is implemented on `main`. The Tier 1 storage decision is recorded below in [Decision (2026-10-07)](#decision-2026-10-07-tier-1-storage-for-the-lessons-bank).

**Graph**: ut-muovla5o-7fc9086d
**PR**: https://github.com/swcstudiospace/agent-substrate/pull/10
**Date**: 2026-10-01. Re-grounded on `origin/main` (`7a0e66c`) on 2026-10-07.
**Scope**: Proposal and design only. No migrations, no new services, no ROADMAP/STATE edits.

The first draft was written against a stub branch from an autonomous "v1.0" run, and it described some of that branch's stubs as shipped infrastructure. They were not shipped. The production substrate landed on `main` as PRs #3–#7, #9 and #11–#13. Every inventory statement below was re-checked against `origin/main`.

## Current State (inventory of `origin/main`)

**No in-repo database engine or migration tool.** There is no sqlite, prisma, alembic, `schema.sql`, `migrations/` or docker-compose. All persistence goes through `substrate-mcp` (`packages/mcp-server`), which creates its own tables on boot (`IndexStore.migrate`, `GreptimeClient.migrate`).

**GreptimeDB: the events ledger** (`packages/mcp-server/src/greptime.ts`, `docs/greptime-ledger.md`; PRs #3/#4)
- `agent_events` is created `WITH ('append_mode' = 'true')`. Its primary key is `(surface, repo, graph_id, kind)` and `ts` is the time index (`greptime.ts` migrate).
- **`payload` is a `STRING` column.** The event payload is serialised with `JSON.stringify` on insert (`greptime.ts`, the `payload` branch of the row builder). It is JSON text, not JSONB, and Greptime cannot index or filter inside it.
- `hash` and `prev` are computed on ingest by `event.ts`, which chains each event to the previous one *in the same session*. Every field except `hash` is hashed, `kind` included. `assertAppendOnly` refuses UPDATE, DELETE, ALTER and RENAME before any statement is sent.
- Migrate also creates an empty Greptime `anchors` table (`period_start, period_end, root, tx_sig, event_count`), but nothing on `main` writes to it. No Merkle or Solana anchoring job exists.
- No data TTL or compaction policy is configured. The only TTL in `greptime.ts` is a 30 s cache on the append-mode probe (`APPEND_MODE_TTL_MS`).

**Postgres / TimescaleDB: the index** (`packages/mcp-server/src/index-store.ts` migrate)
- Graph tables: `graph_index`, `graph_nodes`, `graph_edges`, `graph_steps`, `graph_bindings`.
- Memory tables: `memory_entries` (`id, scope, kind, body, source_event, writer, trust, ttl, created`, plus the governance columns `subject, actor, session_id, graph_id, repo, conflict_key, version, supersedes, superseded_by, entry_hash, reverify_after, idempotency_key`), `memory_writes` (the idempotency ledger), `memory_quarantine` and `memory_reviews`.
- Indexes include `memory_fts_idx`, a GIN index on `to_tsvector('english', body)`.
- **There is no `anchors` table in the index, and no JSONB column anywhere on `main`.** No Timescale hypertable exists either.

**Leases** (`packages/mcp-server/src/lease.ts`, `index-store.ts`, `docs/coordination.md`; PR #6)
- `graph_nodes` has the columns `lease_id`, `lease_expires_at`, `lease_heartbeat_at` and `lease_epoch`. **There are no token leases and no token column.**
- A change of hold is fenced on `lease_epoch`, and it is checked against Postgres' clock. Heartbeat, release and complete are fenced on `lease_id`, and release and complete also check `lease_epoch`.
- TTL: `DEFAULT_LEASE_TTL_SECONDS = 900`, `MIN_LEASE_TTL_SECONDS = 30`, `MAX_LEASE_TTL_SECONDS = 86_400`.
- A heartbeat is refused with `lost`, `expired` or `unheld` (`HeartbeatRefusal`). An expired lease is re-claimed, never revived.
- Each lease action writes an existing event kind: `claim` for granted or reclaimed, `warning` for stolen, forced or expired, and `note` for released (`coordination.md`). The lease tools are MCP-only; `server.ts` has no REST lease route.

**Memory governance** (`packages/mcp-server/src/memory-write.ts`, `memory-policy.ts`, `memory-classify.ts`, `docs/memory-governance.md`; PRs #5, #9, #12, #13)
- Every write passes `governMemoryWrite` in this order: shape, then default-deny RBAC, then quarantine, then the idempotency key, then the conflict strategy, the insert and a read-back.
- `MEMORY_KINDS = ["decision", "fact", "warning", "handoff", "todo"]` (`types.ts`). **`teachable` is not a memory kind**, and it is refused before any grant is consulted (`memory-governance.md`; `memory-write.test.ts`).
- `DEFAULT_GRANTS` (`memory-policy.ts`) cover every known surface:

  | Grant | Scope | Kinds |
  |---|---|---|
  | `graph-any` | `graph` | all five |
  | `repo-working` | `repo` | decision, fact, warning, todo |
  | `agent-self` | own `agent:` only | fact, warning, todo, handoff |
  | `global-standing` | `global` | decision, fact, warning |

  `person:` scopes have no grant, and an unauthenticated writer (`unknown`) holds none.
- Conflict strategy (`conflictPlan`):
  - A `decision` with a subject is **versioned**. The writer must send `expected_version`, and a stale one gets `conflict` with `current_version`.
  - A `todo` with a subject is last-write-wins.
  - Everything else, `fact` included, **appends**.
  - `global` is **require-review**: an unreviewed write is parked in `memory_reviews` and answered `conflict` / `review.required`.
- Quarantine: secrets, PII and speculation are parked in `memory_quarantine`. A `decision` or `fact` whose text matches the hedging pattern (`probably`, `might`, `likely`, `assume`, `seems to`, `plan to`, …; `memory-classify.ts`) is quarantined.
- Exactly-once: an explicit `idempotency_key` never expires, and a derived key dedupes for 24 h (`DERIVED_KEY_WINDOW_MS`).
- A write is durable only when `outcome === "accepted"` **and** `verified_persisted === true`, which means the read-back returned the same `entry_hash`.
- `store-lock.test.ts` rule 4: the set of `insertEntry` callers is exactly `index-store.ts` and `memory-write.ts`, and no file outside the MCP server names a memory table in SQL.
- `memory_search` (MCP) runs full-text search over `body` only, with an optional scope, newest first and `limit` ≤ 100 (default 20). Superseded, quarantined and unreviewed entries are excluded.

**Brief** (`packages/mcp-server/src/brief.ts`)
- The brief is composed from the index (graphs, nodes, leases), Greptime (recent actions) and memory. The memory section shows **only "Decisions in force" and "Warnings"**; facts are not briefed.
- A missing source drops its section. The CLI writes `.substrate/BRIEF.md` as the file fallback (`packages/cli/src/index.ts`).

**Events** (`packages/mcp-server/src/types.ts`)
- `EVENT_KINDS` is a **closed** set of 12: `session.start, prompt, claim, tool.call, file.edit, shell, commit, pr, handoff, session.end, note, warning`.
- It stays closed because `kind` participates in the hash and `drift_scan` keys its findings off particular kinds (ADR 0001, plane map). Specific types ride in the payload, as swarm events do with `payload.swarm_type` (`docs/swarm-correlation.md`).

**Not on `main`:**
- **DragonflyDB.** No client, no brief snapshot, no degraded-write outbox, no policy cache and no lease mirror. `git grep -i dragonfly origin/main` matches only a receipt that lists Dragonfly as untouched. The stub branch this research started from carried a Dragonfly helper and `infra/railway/*` configs, but the helper had no runtime caller. Everything Dragonfly-related here is a proposal, not infrastructure.
- **Push transport.** There is no outbox, SSE, websocket or LISTEN/NOTIFY.
- **Embeddings or vectors**, and **Hindsight** wiring.
- **Teachables, A2A AgentCards** and **Solana anchoring**.

**File layer:** `.planning/{STATE,ROADMAP,PROJECT}.md`, `.planning/config.json`, `.planning/phases/*` and the `.planning/milestones/v1.1-*` archive are git-tracked. Phase SUMMARY files and explicit "Lesson" notes are where lessons would be extracted from.

**Gaps relevant to n5/n6:**
- No lesson records with phase/milestone linkage, citation ids, scoring or digests.
- No phase lifecycle events.
- No realtime transport.
- No similarity search.

## n5: Self-Improving Memory Bank Proposal

The storage design below is the original proposal. **It was superseded by the Decision section**, which maps every field onto governed `fact` entries. The proposal's ideas are kept because they record what the bank is for.

**Record (proposal):** `{id, phase_id, milestone_id, timestamp, type (lesson|decision|edge|outcome|observation), summary_text, outcome (success|partial|blocked|deferred), success_score 0–1, source_path, tags[], citation_id}`. The original draft extended `memory_entries`, added a `memory_records` table and emitted a `memory.record` event kind. None of that is possible on `main`:
- store-lock forbids a new memory table or insert path.
- `MEMORY_KINDS` and `EVENT_KINDS` are closed.
- `memory_entries` has no tag, score, phase or metadata column.

**Write triggers:**
- Automatic: extraction from a finalized phase SUMMARY (lessons, outcome, edge cases).
- Manual: `## Lesson` or `## Edge` blocks in CONTEXT/PLAN.
- Both write through the governed gate. Lessons are never injected at runtime behind the user's back.

**Retrieval:** only at the discuss step. The top K lessons, ranked by recency × score × keyword/tag match, are injected visibly into CONTEXT.md. Every use in a PLAN.md cites the lesson's id, and the user can audit or veto by id.

**Pruning / self-improving (gated):**
- Nothing is deleted; old lessons are rolled into a milestone digest.
- A score rises when a lesson is cited and a good outcome is observed.
- Agent-driven weighting or pruning needs explicit user sign-off first.

**Proof for the proposal:** a past phase SUMMARY produces a citable lesson; discuss injects it with its id; PLAN cites it; a digest rolls up older lessons.

## n6: Database Schema Upgrades + Realtime Event Model

**Recommendation:** extend what exists, the Postgres index and the Greptime ledger behind `substrate-mcp`, rather than introduce SQLite. This is not zero-infra for realtime, though. Every realtime piece below is **new work**, because no outbox, snapshot cache or push path exists on `main`.

**Phase lifecycle as events (proposal, later tier):**
- Lifecycle steps would be `note` events with a payload type field: `payload.lifecycle_type` ∈ `phase.started | phase.blocked | phase.awaiting_decision | phase.completed | plan.generated | acceptance_criteria.passed | acceptance_criteria.failed`, plus graph, node and phase refs. This follows the `payload.swarm_type` pattern. `EVENT_KINDS` is not widened.
- `lease.stolen` and signed handoffs already have events: a `warning` from the lease path, and `handoff` from `coord_handoff`.
- Because `payload` is a `STRING`, a query by lifecycle type means reading payloads client-side. Alternatively, a server-side filter would have to be added to `events_query`.
- An optional derived `phase_lifecycles` table in the index would be a new table. Its DDL would live in `index-store.ts` migrate.

**Realtime transport (proposal, later tier):**
- A polling consumer over `events_query` needs no new infrastructure.
- An outbox, an SSE/websocket tail or webhook fan-out would each be a new component. Dragonfly would be a new dependency, not an extension.
- Exactly-once delivery can lean on the per-session hash chain for ordering and tamper evidence. A consumer still has to dedupe on event `id` itself.
- No LISTEN/NOTIFY without a decision on the Postgres primary.

**Underused features:**
- Timescale hypertables or continuous aggregates, for phase duration and block rate. Today's tables are plain.
- Greptime retention or compaction settings. None are configured today.

**Tradeoffs:**
- **Polling over the existing ledger:** lowest risk, latency of seconds, no new service.
- **New outbox/SSE service:** push latency, but a new component to run, plus a new dependency if it is backed by Dragonfly.
- **Postgres LISTEN/NOTIFY:** needs the primary confirmed and approval.
- **SQLite:** duplicates the index and adds a new client and migration path. Not recommended.

## n7: Critique — What's Missing/Ambiguous

1. **DB inventory.** Confirmed: there is no in-repo engine, and the backing stores are reached only through `substrate-mcp`. The first draft's inventory was wrong about Dragonfly, JSONB, anchors, token leases and teachables. It has been corrected above.
2. **Hindsight.** Not wired on `main`. Confirm whether a specific library is intended.
3. **Sequencing.** The lessons bank was deferred out of v1.1 pending a storage decision (`.planning/milestones/v1.1-REQUIREMENTS.md`, "Deferred"). It is a next-milestone candidate in `.planning/PROJECT.md`.
4. **Self-improving automation.** Writes are human-gated by default. Agent auto-weighting needs a separate sign-off.
5. **Integration point.** The substrate CLI has no memory command (`brief, emit, run, verify, drift, handoff, evidence`; `packages/cli/src/index.ts`). Discuss-time retrieval runs in the GSD workflow or a hook outside this repo, and it still has to be chosen.

**Open for user:** the integration point, and Hindsight. The storage question is closed; see the Decision section.

## n8: Prioritized Proposal + Sign-Off

**Tier 1 (approved storage; see Decision):**
- Lessons as governed `fact` entries, extracted from SUMMARY files.
- Cite-by-id in discuss and plan.
- Read-time scoring and milestone digests as `fact` entries.

**Tier 2 (later, separate approval):**
- Phase lifecycle as `note` events with `payload.lifecycle_type`, and a polling consumer.
- An outbox with an SSE or webhook dashboard. This is a new component, and Dragonfly only if it is approved as a new dependency.
- Timescale hypertables and continuous aggregates.

**Tier 3 (deferred):**
- Vector similarity (pgvector).
- LISTEN/NOTIFY push.
- Agent-driven weighting or pruning beyond the human gate.

**Before scheduling Tier 2:** decide whether realtime is needed at all beyond polling, and whether Dragonfly is approved as a dependency.

## Decision (2026-10-07): Tier 1 storage for the lessons bank

Approved by the user. **Each lesson is one governed `fact` entry, written through the existing `memory_write` gate**: MCP `memory_write`, or REST `POST /memory` (`server.ts`), both of which reach `governMemoryWrite` (`memory-write.ts`).

**What it rules out:**
- No lessons table, no new memory kind and no new `insertEntry` caller. `store-lock.test.ts` rule 4 fails on any of them.

**How a lesson is written:**
- **Identity.** `subject = lesson:<milestone>/<phase>/<slug>`. `normalizeSubject` lowercases it and caps it at 200 characters.
- **Idempotency key.** `idempotency_key` is derived from the source path and the content, e.g. `lesson:` + sha256 of `source_path` + `\n` + `text`. An explicit key never expires, so re-running extraction replays rather than duplicates.
- **Body.** A structured header carries phase, milestone, outcome, tags and source path, followed by the lesson text. The total stays within `MAX_MEMORY_TEXT` (4000). Search is over `body`, so the header terms are searchable.
- **Scope.** The default is `repo:<owner/name>`, granted by `repo-working`. `global` is require-review, so a global lesson is a proposal parked in `memory_reviews` until a reviewer releases it.
- **Phrasing.** Lessons are declarative. A hedged `fact` is quarantined (`memory-classify.ts`), and a quarantined lesson is shown to the human rather than retried.

**How a lesson is cited and found:**
- **Citation id.** The returned `entry.id` (`mem_…`). It is used only when `outcome === "accepted" && verified_persisted === true`; any other outcome yields no citation.
- **Retrieval.** `memory_search {query, scope, limit ≤ 100}` at discuss time. The client filters to `lesson:` subjects and ranks by recency × keyword/tag match × score.
  - Facts are not shown in the brief (`brief.ts`), so lessons reach a session only through this explicit retrieval.
- **Scores.** Computed at read time from outcome facts appended later, each naming the lesson's entry id. Scores are never mutated in place: `fact` appends, and last-write-wins is `todo`-only (`conflictPlan`).
- **Digest.** A milestone digest is itself a `fact` with `subject = lesson-digest:<milestone>`, and its body lists the entry ids it rolls up. The originals stay, since there is no delete path, and the client excludes digested lessons from ranking.
- **Sign-off.** The human reviews the extracted lessons before they are written, and can veto any of them by subject.

**Moved to a later tier:** the realtime and outbox half. That covers phase lifecycle events, the outbox/SSE stub, `phase_lifecycles` and any Dragonfly use. When it is picked up, lifecycle events are `note` events with a payload type field, not new `EVENT_KINDS`.

---

**Verification for this revision:** every inventory claim was checked with `git show origin/main:<path>` / `git grep … origin/main` against the files cited inline.
