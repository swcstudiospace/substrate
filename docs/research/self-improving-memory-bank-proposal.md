# Self-improving memory bank proposal (SPE-5830)

> **Status:** Research proposal. Nothing in it is implemented on `main`. The Tier 1 storage decision is recorded below in [Decision (2026-10-07)](#decision-2026-10-07-tier-1-storage).

**SPE-5830**

**Wave:** 3 (design phase, read-only proposal based on the wave 2 inventory). Re-grounded on `origin/main` (`7a0e66c`) on 2026-10-07.

The wave 2 inventory was taken on a stub branch from an autonomous "v1.0" run. Some of its findings described stubs as if they were shipped. They were not. The production substrate landed on `main` as PRs #3–#7, #9 and #11–#13. The inventory below replaces the wave 2 findings with what `origin/main` actually contains.

## Inventory (`origin/main`)

### Storage (n2)
**Postgres / TimescaleDB index.** `packages/mcp-server/src/index-store.ts` `migrate` creates these tables:
- Graph tables: `graph_index`, `graph_nodes`, `graph_edges`, `graph_steps`, `graph_bindings`.
  - `graph_nodes` carries `lease_id, lease_expires_at, lease_heartbeat_at, lease_epoch`.
- `memory_entries`: `id, scope, kind, body, source_event, writer, trust, ttl, created`, plus the governance columns `subject, actor, session_id, graph_id, repo, conflict_key, version, supersedes, superseded_by, entry_hash, reverify_after, idempotency_key`.
- `memory_writes`, the idempotency ledger.
- `memory_quarantine` and `memory_reviews`.

Indexes include `memory_scope_idx` and `memory_fts_idx`, a GIN index on `to_tsvector('english', body)`.

**There is no `anchors` table in the index, and no JSONB column on `main`.** No Timescale hypertables exist.

**GreptimeDB ledger.** `packages/mcp-server/src/greptime.ts` creates `agent_events` in `append_mode`.
- `payload` is a `STRING` column holding `JSON.stringify` output, not JSONB.
- `hash` and `prev` form a per-session chain, computed on ingest by `event.ts`. `assertAppendOnly` refuses rewrites.
- Migrate also creates an empty Greptime `anchors` table. Nothing writes to it, and no Solana anchoring job exists.

**Leases** (`lease.ts`, PR #6):
- Fenced by `lease_id` plus `lease_epoch`.
- TTL 900 s default, 30 s minimum, 86,400 s maximum.
- Heartbeat refusals are `lost`, `expired` or `unheld`.
- There are no token leases.

**Not on `main`:**
- **Dragonfly**, in any role: no brief snapshots, no outbox, no lease mirror, no policy cache. The stub branch the wave 2 inventory read carried a Dragonfly helper and `infra/railway/*` configs, but the helper had no runtime caller.
- Vectors and embeddings.
- Teachables and A2A.
- Hindsight wiring.

### Memory governance (n2/n3)
Every memory write passes `governMemoryWrite` in `packages/mcp-server/src/memory-write.ts` (PRs #5, #9, #12, #13). The service file has no write path of its own, and `store-lock.test.ts` rule 4 enforces this. The gate runs these steps in order:

1. **Shape.** An unknown scope or kind is a denial.
2. **RBAC, default-deny** (`memory-policy.ts` `DEFAULT_GRANTS`):
   - `graph-any`: all kinds at `graph:`.
   - `repo-working`: decision, fact, warning, todo at `repo:`.
   - `agent-self`: fact, warning, todo, handoff at the writer's own `agent:`.
   - `global-standing`: decision, fact, warning at `global`.
   - No `person:` grant exists, and `unknown` writes nothing.
3. **Quarantine** (`memory-classify.ts`): secrets, PII, and speculation in a `decision` or `fact` ("probably", "might", "likely", "assume", "seems to", …).
4. **Exactly-once.** An explicit `idempotency_key` never expires, and a derived key dedupes for 24 h.
5. **Conflict** (`conflictPlan`):
   - A `decision` with a subject is versioned. A stale `expected_version` returns `conflict` with `current_version`.
   - A `todo` is last-write-wins.
   - A `fact` appends.
   - `global` is require-review: it is parked in `memory_reviews`, and the reply is `conflict` / `review.required`.
   - After the insert, a read-back sets `verified_persisted`.

`MEMORY_KINDS = ["decision", "fact", "warning", "handoff", "todo"]` (`types.ts`). **`teachable` is not a memory kind** (`docs/memory-governance.md`).

Reading memory:
- `memory_search` runs full-text search over `body` only, with an optional scope, newest first, limit ≤ 100.
- `brief.ts` shows only decisions and warnings from memory, never facts.

### GSD state (n3)
- Planning is file-based and git-tracked: `.planning/{STATE,ROADMAP,PROJECT}.md`, `config.json`, `phases/*`, and the `milestones/v1.1-*` archive. `.substrate/BRIEF.md` is the brief's file fallback (`packages/cli/src/index.ts`).
- Planning files and substrate memory are disjoint today. There is no lesson capture across runs, no success weighting and no pruning.
- The lessons bank was deferred out of v1.1 pending a storage decision (`.planning/milestones/v1.1-REQUIREMENTS.md`, "Deferred").

## Proposed Design: Self-Improving Memory Bank

The bank is an auditable, success-weighted and prunable set of lessons. Lessons are written when a phase closes or added by hand. They are retrieved only at GSD discuss time and cited by id. **Storage follows the Decision section.** The original `lessons` table draft (tags `text[]`, `success_score float`, GIN and FTS indexes) was **withdrawn** in favour of governed `fact` entries, which keep every write behind the one gate. A test does not force this choice; the Decision section lists the alternatives.

### Write Triggers
- Automatic: when a phase SUMMARY.md is finalized, the phase outcome is captured as a lesson.
- Manual: a `## Lesson` block in any artifact.
- Both go through the gate as `fact` entries, with `source_path`, phase and milestone in the body header. They are written only at the discuss/plan boundary, never mid-execute, and only after a human reviews the extracted lessons.

### Retrieval
- At discuss time, before CONTEXT.md is written, recall uses `memory_search`'s read-side `subject_prefix` filter and its keyset cursor `(created, id)` (both added in Tier 1) to page through three prefixes in the scope, so older lessons are not lost behind the newest-100 window and no entry sharing a timestamp at a page boundary is skipped or repeated:
  - `lesson:`, the candidates;
  - `lesson-digest:`, whose listed ids are excluded from ranking;
  - `lesson-outcome:`, which feeds each lesson's read-time score.
- The client ranks the remaining lessons by recency × tag/keyword match × read-time score. The top K go under `## Prior Lessons (from self-improving bank; cite IDs)`.
- PLAN.md cites lessons by entry id.
- Fail-open: if the bank is unreachable, nothing is injected.

### Pruning
- A milestone digest is a `fact` that lists the lesson ids it rolls up.
- The originals stay, since there is no delete path. The client excludes digested lessons from active ranking.

### Loop Integration (GSD)
- Retrieval happens only at discuss. Citation is by id in PLAN.
- The SUMMARY write happens after verification.
- STATE and ROADMAP stay files.
- Where the discuss hook runs is outside this repo, and it still has to be chosen. The substrate CLI has no memory command.

## Tradeoffs
- **+** Lessons accumulate across runs and are fully auditable: an id, a source path, the writer and trust, all through the existing gate.
- **+** No schema change. RBAC, quarantine, exactly-once and the review of global entries all come with the gate.
- **−** Tags, phase and score live in the body and in client-side ranking, not in columns. Today `memory_search` returns at most 100 entries per call with no cursor, so Tier 1 adds a read-side `subject_prefix` filter and a `before` cursor.
- **−** Lessons must be phrased declaratively, or they are quarantined.
- **−** Lessons stay out of the brief, by design: facts are not briefed.
- **−** There is no vector similarity: retrieval is keyword only. This is not a live event bus.

## Verification (for later phases)
- Write a lesson. Confirm `accepted && verified_persisted`, and that a replay under the same key returns the same entry id.
- Retrieve it at discuss and cite its id in a PLAN.
- Append an outcome fact and confirm the read-time score changes.
- Roll a digest and confirm digested lessons drop out of ranking.

## Decision (2026-10-07): Tier 1 storage

Approved by the user. **The self-improving lessons bank is stored as governed `fact` entries, written through the existing `memory_write` gate**: MCP `memory_write`, or REST `POST /memory` (`packages/mcp-server/src/server.ts`).

**What it rules out, and why:**
- No lessons table, no new memory kind and no new `insertEntry` caller. This is a design choice, not something a test forces. `store-lock.test.ts` asserts only that the `insertEntry` callers are exactly `index-store.ts` and `memory-write.ts` and that no memory-table SQL appears outside the MCP server package. A table in `IndexStore.migrate` behind its own gated write path, or a new kind with grants, would pass it.
- Alternatives: a `lessons` table in the server package (typed tags and scores, but a second write door to govern), or a new `lesson` kind (kind-level grants and filtering, but it widens a closed set the policy, the classifier and every grant key on). Governed facts were chosen to keep one write door and add no storage. The price is body-encoded metadata and a read-side search filter.

**How a lesson is written:**
- **Identity.** `subject = lesson:<milestone>/<phase>/<slug>`. It is lowercased and capped at 200 characters by `normalizeSubject`.
- **Idempotency key.** `idempotency_key` is derived from the source path and the content, e.g. `lesson:` + sha256 of `source_path` + `\n` + `text`.
- **Body.** A structured header carries phase, milestone, outcome, tags and source path, followed by the lesson. The whole body is at most 4000 characters.
- **Scope.** The default is `repo:<owner/name>`, granted by `repo-working`. `global` is require-review, so a global lesson is a proposal until a reviewer releases it.
- **Phrasing.** Lessons are declarative. Hedged facts are quarantined, and a quarantined lesson is surfaced to the human, not retried.

**How a lesson is cited and found:**
- **Citation id.** The returned `entry.id`. It is used only when `outcome === "accepted" && verified_persisted === true`.
- **Retrieval.** `memory_search` with a read-side `subject_prefix` filter and a keyset cursor `(created, id)`, paged over `lesson:`, `lesson-digest:` and `lesson-outcome:`; ranking is done client-side.
- **Scores.** Computed at read time from the `lesson-outcome:` facts appended later that name the lesson's entry id. Scores are never mutated in place: `fact` appends, and last-write-wins is `todo`-only.
- **Digest.** A milestone digest is itself a `fact` with `subject = lesson-digest:<milestone>`. Recall reads the digests and excludes every id they list.

**Moved to a later tier:** the realtime and outbox half. That covers phase lifecycle events, the outbox/SSE stub, `phase_lifecycles` and Dragonfly. If lifecycle events are built, they are `note` events with a payload type field, because `EVENT_KINDS` is closed: `kind` participates in the event hash (ADR 0001).

## Citations / Links
- SPE-5830 (this proposal). Research companion: `docs/research/memory-bank-realtime-event-proposal.md` (PR #10).
- `packages/mcp-server/src/`:
  - Storage: `index-store.ts` (migrate, `searchMemory`), `greptime.ts` (migrate, payload), `lease.ts`.
  - Gate: `memory-write.ts`, `memory-policy.ts`, `memory-classify.ts`.
  - Types and enforcement: `types.ts` (`MEMORY_KINDS`, `EVENT_KINDS`), `store-lock.test.ts`.
  - Surfaces: `brief.ts`, `mcp.ts`, `server.ts`.
- `docs/memory-governance.md`, `docs/coordination.md`, `docs/swarm-correlation.md`, `docs/adr/0001-agent-swarm-as-sdlc-mesh-on-substrate.md`.
- `.planning/PROJECT.md` (next-milestone candidates), `.planning/milestones/v1.1-REQUIREMENTS.md` (deferral).
