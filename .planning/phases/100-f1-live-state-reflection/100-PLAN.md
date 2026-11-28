# Phase 100 (F1) — Live STATE Reflection — PLAN

**Goal:** Post-write hook ingests STATE.md + phase SUMMARY transitions to LightRAG with run lineage; `state_freshness_lag_seconds` gauge makes stale states detectable. FSM states-as-docs stay current in realtime.
**Context:** `100-CONTEXT.md` (decisions + code context binding). **No code edits in this unit — plan only.**

## Constraints (from CONTEXT, binding)
- Hook point: reuse existing post-write/git hook path (collector/projector), NOT a new daemon. Hook emits ingest event with run lineage (`graph_id`, `phase`, `commit`).
- Ingest target: LightRAG `documents/texts` endpoint via existing client (`packages/mcp-server/src/planes/lightrag.ts`); failures degrade to last-good + freshness timestamp, never silent.
- SLI: `state_freshness_lag_seconds` gauge = `now − max(STATE mtime, last successful ingest)`; alert threshold documented only, no new alerting infra.
- Patterns: fail-open reads, redaction on write path, fake-only tests for new modules. Cache-aside + TTL + fallback-to-durable per `.planning/execution-plan.md` Lane patterns.
- Integration: shares `docs_ingest` plane path that F3 (Phase 102) consumes — no breaking change to that contract.

## Task 1 (tracer first) — Hook emission with lineage
**Target files (exact):**
- `packages/mcp-server/src/state-reflect.ts` (NEW — pure builder: `buildStateReflectEvent({ stateMd, summaryTransition?, lineage })` → redacted payload; no I/O)
- `packages/mcp-server/src/service.ts` (EDIT — wire builder into existing post-write/git hook path; hook fires on STATE.md write + phase SUMMARY transition only)
- Existing collector/git hook module under `packages/mcp-server/src/` (EDIT — discovered in tracer; referenced as "hook call-site" — do not invent a new daemon entrypoint)
- `packages/mcp-server/src/state-reflect.fake.test.ts` (NEW — fake-only, no live server)

**Change:**
1. Tracer: locate the one existing post-write/git hook call-site that observes STATE.md writes; confirm event shape it already emits.
2. Add `state-reflect.ts` builder: inputs `STATE.md` content + optional SUMMARY transition + lineage `{ graph_id, phase, commit }`; redacts via existing `redact` on the write path before returning payload.
3. Wire call-site → builder → emit ingest event; hook failures are fail-open (log + keep last-good, never block the write).

**Acceptance:**
- Writing STATE.md or completing a phase SUMMARY transition emits exactly one ingest event carrying `{ graph_id, phase, commit }` + redacted body.
- Hook throw/failure never fails the underlying write (fail-open proven by test).

## Task 2 — LightRAG ingest with last-good fallback
**Target files (exact):**
- `packages/mcp-server/src/planes/lightrag.ts` (READ/REUSE — `documents/text` upload path; no signature change)
- `packages/mcp-server/src/state-ingest.ts` (NEW — cache-aside ingest: upload → poll `track_status` → record success; on failure serve last-good)
- `.lightrag_ingest_state.json` (EDIT — add `last_good_state_reflect: { track_id, doc_ids?, ingested_at, commit, graph_id, phase }` + `last_attempt` freshness timestamp)
- `packages/mcp-server/src/state-ingest.fake.test.ts` (NEW — fake `fetchImpl`; covers 409-same-name, poll-timeout, failure→last-good paths)
- `scripts/lightrag_ingestion_orchestrator.py` (READ-ONLY precedent — state-machine pattern reference, not edited)

**Change:**
1. `state-ingest.ts` calls existing LightRAG client upload (`POST /documents/text`, multipart fallback per `lightrag.ts` contract), then `track_status` poll; bounded retries with TTL per Lane cache-aside pattern.
2. On success: update `last_good_state_reflect` + `last_attempt`. On failure: keep last-good, stamp `last_attempt` + reason (no secret), return `{ ok: false, reason, last_good }` — never throw into agent turn, never silent.
3. `docs_ingest` plane contract unchanged so Phase 102 (F3) reuses the same path.

**Acceptance:**
- Successful ingest updates last-good + freshness timestamp; failed ingest returns last-good with reason and leaves last-good intact.
- 409 (same-name document) handled via explicit delete-first path already in client, not a new route.

## Task 3 — Freshness SLI gauge + health exposure
**Target files (exact):**
- `packages/mcp-server/src/state-freshness.ts` (NEW — `state_freshness_lag_seconds = now − max(stateMtime, lastSuccessIngest)`; threshold constant + doc string)
- `packages/mcp-server/src/service.ts` (EDIT — expose gauge via existing health/planes snapshot; reuse `observe.ts`/`metrics-history.ts` pattern if the gauge lives there — one place only)
- `packages/mcp-server/src/state-freshness.fake.test.ts` (NEW — mtime/ingest clock matrix incl. stale > threshold)
- `docs/` threshold note (EDIT — one existing observability/SLO doc; threshold value + "no new alerting infra" statement)

**Change:**
1. Compute gauge from STATE.md mtime vs `.lightrag_ingest_state.json:last_good_state_reflect.ingested_at`.
2. Document alert threshold (e.g. `> 300s` stale — final value set in implementation, recorded in the doc edit) with no new alerting pipeline.
3. Fail-open: missing state file or clock skew yields gauge + `unknown` reason, never an exception.

**Acceptance:**
- Health snapshot carries `state_freshness_lag_seconds`; stale STATE (no successful ingest within threshold) is distinguishable from fresh.
- Threshold documented; no new alerting infra introduced.

## Verification harness (run once, after all tasks land)
```bash
bun test packages/mcp-server/src/state-reflect.fake.test.ts packages/mcp-server/src/state-ingest.fake.test.ts packages/mcp-server/src/state-freshness.fake.test.ts
bun test packages/mcp-server/src/planes/lightrag.contract.test.ts
# live-state loop: write STATE.md fixture → hook fires → fake LightRAG records lineage event → kill backend → write again → last-good served + lag gauge rises
```
Gate: all green + `docs_ingest` plane contract unchanged (Phase 102 unblocked).

## SUMMARY spec (what the implementation SUMMARY.md must contain)
- Hook call-site path + trigger conditions (STATE.md write, SUMMARY transition).
- Lineage fields emitted (`graph_id`, `phase`, `commit`) with one example event.
- Ingest path used (`documents/text`), `track_id` vs doc-id handling, 409 behavior.
- Last-good fallback semantics + freshness timestamp location in `.lightrag_ingest_state.json`.
- `state_freshness_lag_seconds` definition, where exposed, threshold value + doc link.
- Verification harness output (commands + pass/fail).

## Out of scope (explicitly NOT this phase)
- New daemon/watcher/timer for reflection (reuse hook path only).
- New alerting infra (threshold doc only).
- Graph/hybrid retrieval tuning (belongs to Phase 46 debt).
- F3 event-driven refresh beyond keeping the shared `docs_ingest` contract stable (Phase 102 owns it).
- Live LightRAG server calls in tests (fake-only).
