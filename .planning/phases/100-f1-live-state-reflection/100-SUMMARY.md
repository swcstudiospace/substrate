# Phase 100 (F1) — Live STATE Reflection — SUMMARY

**Status:** implemented, all green. **No commits** (per assignment).

## Hook call-site + trigger conditions

- Call-site: `Substrate.runPlanningRefresh` (`packages/mcp-server/src/service.ts`,
  the existing post-write/scan hook path that ingests changed `.planning/`
  pages — no new daemon, timer, or entrypoint).
- Trigger filter: `isStateReflectPath` (`state-reflect.ts`) — fires on
  `.planning/STATE.md` writes and phase SUMMARY transitions
  (`.planning/phases/<id>/<N>-SUMMARY.md`) only. All other pages flow through
  the unchanged batch ingest with no reflect event.
- Fail-open: `buildStateReflectEvents` validates T0 provenance (kind
  `context`) then builds the event per page; any refusal is logged and
  skipped, the pass and its `docs.planning` note continue. The builder itself
  never throws (proven by fake test: garbage inputs → structured refusals).

## Lineage fields + example event

Every reflect event carries `{ graph_id, phase, commit }`:
- `graph_id` = planning checkout key (`planningSessionId`, the graph the
  STATE belongs to); `phase` = `summaryPhaseOf(path)` (e.g. `100`) else
  `planningPhaseOf(path)`, `state` for STATE.md itself; `commit` = page
  content sha (LightRAG `"unpinned"` convention when unknown).
- Example (`docs.planning` note payload, `state_reflect: [...]`):
  `{ action: "state.reflect", path: ".planning/STATE.md", body: "<redacted,
  ≤8 KiB>", body_truncated: false,
  content_sha256: "<hex of unredacted body>",
  lineage: { graph_id: "checkout-a", phase: "state", commit: "<sha>" } }`.

## Ingest path, track_id vs doc-id, 409 behavior

- `ingestStateReflectDocument` (`state-ingest.ts`) reuses the existing
  LightRAG client: `uploadDocument` (`POST /documents/text`, multipart
  `/documents/upload` fallback per `lightrag.ts` contract) → then
  `resolveDocumentIds` (`GET /documents/track_status/{track_id}`) lists the
  real doc ids → `scanDocuments` → `pollParseStatus` to idle.
- `track_id` is the enqueue id, NOT a document id; only resolved `doc_ids`
  are recorded/durable. 409 same-name conflict retries once after an explicit
  delete of the previous last-good `doc_ids` (`deleteDocuments` — the
  client's existing delete-first path, not a new route); 409 with no prior
  ids is a failure with last-good intact.

## Last-good fallback + freshness timestamp

- File: `.lightrag_ingest_state.json` (repo root, created this phase):
  `{ last_good_state_reflect: { track_id, doc_ids, ingested_at, commit,
  graph_id, phase } | null, last_attempt: { at, ok, reason } | null }`.
- Success replaces last-good and stamps `last_attempt.ok:true`; any failure
  keeps last-good, stamps `last_attempt` with the (redacted) reason, and
  returns `{ ok:false, reason, last_good }` — never a throw, never silent.
- `docs_ingest` plane contract unchanged (Phase 102/F3 reuses the same path).

## `state_freshness_lag_seconds` definition, exposure, threshold

- Definition (`state-freshness.ts`):
  `lag = now − max(newest STATE.md mtime across planning checkouts,
  last successful planning-pass ingest)`; future refs clamp to 0; missing
  inputs → `unknown`, never an exception.
- Exposed: `GET /healthz` → `stateFreshness: { lagSeconds, stale, reason }`
  (new `SubstrateHealth` field; report-only, never the status code).
- Threshold: `lagSeconds > 300` reads `stale`. Documented in
  `docs/observability.md` § "STATE freshness (Phase 100)" — **no new
  alerting infra** (monitors scrape `/healthz`).

## T0 provenance validation + default-deny (CONTEXT addendum, enforced here first)

- `t0-provenance.ts`: unified contract for `tool|skill|memory|context|
  lesson|teachable-moment` — mandatory `worktree, project, agent/session
  (≥1), event, content_hash (64-hex)`; unknown kind or missing provenance →
  structured `{ ok:false, code, reason, missing? }`, never silent default.
- `authorizeT0Read`: same-scope always allowed; cross-scope denied unless
  explicit `sharedScope: true`. `authorizeT0Supersede`: fresh provenance +
  `supersedes === currentHash`, else `t0.supersede-mismatch`.
- Enforced at the state-reflect hook (kind `context`: worktree = checkout
  root, project = dataset, agent = `substrate`, session =
  `planning-refresh`, event = trigger reason, content_hash = page sha).
  Other planes adopt in follow-ups; memory/context keep their own gates.

## Verification harness output

```bash
bun test packages/mcp-server/src/state-reflect.fake.test.ts \
  packages/mcp-server/src/state-ingest.fake.test.ts \
  packages/mcp-server/src/state-freshness.fake.test.ts \
  packages/mcp-server/src/t0-provenance.fake.test.ts
# 32 pass, 0 fail, 83 expects
bun test packages/mcp-server/src/planes/lightrag.contract.test.ts
# 16 pass, 0 fail (docs_ingest contract unchanged)
bun test packages/mcp-server/src/service.test.ts
# 299 pass, 0 fail (incl. updated full-health toEqual with stateFreshness)
bunx tsc --noEmit
# clean
# live-state loop (inline harness, fake LightRAG): hook emits lineage event →
# alive ingest ok (last_good trk-1, attempt ok) → backend down → ingest fails
# with last_good trk-1 intact + reason; gauge rises with clock skew.
```

## Files

New: `state-reflect.ts`, `state-ingest.ts`, `state-freshness.ts`,
`t0-provenance.ts` + 4 `.fake.test.ts` suites; `.lightrag_ingest_state.json`;
`docs/observability.md` (threshold note). Edited: `service.ts` (hook, gauge,
interface), `service.test.ts` (health expectation).
