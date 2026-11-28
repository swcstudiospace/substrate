# Phase 106 SUMMARY — F7 15-repo ingest verification + steering test (LIVE)

**Status: done with named gaps. No fabricated passes; every hop cites an artifact.**

## Live window

- Operator grant: live LightRAG ingest + scratch-only e2e, 2026-11-28 ~18:53 UTC.
- Endpoint: `http://127.0.0.1:9621`, LightRAG 1.5.7 (`/health`: healthy, auth_mode
  disabled, pipeline idle at start). URL source: operator file
  `/etc/substrate/substrate.env` (`LIGHTRAG_URL`); API key from the same file,
  present, redacted everywhere, never committed.
- Tracer pre-flight: `scripts/lightrag_ingestion_orchestrator.py --help` clean;
  `.lightrag_ingest_state.json` pre-run held only `last_good_state_reflect`/`last_attempt`
  (no mock ids to supersede); live `GET /documents/pipeline_status` reachable
  (`busy:false`). No `--dry-run` presented as evidence.
- Strict TS / redaction / fail-closed devnet / no commits honored: no code edits,
  no production doc mutation, no gates/formatters run (orchestrator verifies).

## Task 1 — live ingest, per-repo evidence

- Run: `python3 scripts/lightrag_ingestion_orchestrator.py --all` (live),
  2026-11-28 18:53–18:55 UTC, exit 0, 152s. Log: `/tmp/as-wave9-106-live-run.log`.
- Orchestrator verdict: 6 completed, 9 failed. Failure split: 8× `no tracks from
  submit` (every upload `409 Conflict` — docs already live from prior runs);
  1× `poll failed or timeout` (agent-realm, 30 tracks submitted).
- Inventory sweep (all 18,963 docs, prefix `<project>__`, ~18:57 UTC):
  `/tmp/probe_found.json`. Sample queries (live `POST /query`, mix/top_k 5,
  `What is {repo}?`): `/tmp/probe_query_short.json` (+ targeted re-queries
  `/tmp/probe_query_targeted.json`). Note: global-mode entity phrasing returns
  `[no-context]` on this instance (also inside the orchestrator's sample step);
  mix short-form retrieves — recorded as an observation, not a defect.
- Full per-repo table (status, docs, samples): `.planning/15-repos-lightrag-ingest-evidence.md`
  (rewritten from live state only). 12/15 repos return ≥1 own-repo reference;
  all 15 return 5 references.
- Failed-repo retry outcomes: agent-realm 30/30 `processed` post-run → closed as
  complete (state file left as the orchestrator wrote it; correction lives here).
  All-409 repos verified present in inventory with processed counts in the evidence
  doc. New-doc `failed` processing for auctioning (5) and claude-ultrathink (3)
  `dup-*` docs; historical docs carry retrievability.
- Gaps (named, last-good hop each): ClippyOS — 28 docs present, 0 processed
  (parsing/pending since 11-23), 0 own-refs; motion-playbook — 13 prefix docs all
  `failed` (corpus-namespace copies retrievable, 2 own-refs); trading-desk —
  5 historical docs all `failed`, 0 local docs, 0 own-refs; autonogrammer —
  1,310 processed but 0 own-refs for tested phrasings (retrieval, not coverage).

## Task 2 — e2e steering proof (scratch only)

Probe: `F7-PROBE-20261128-steering` in `/tmp/as-wave9/scratch-steering-probe/probe-doc.md`
(created 18:59:49Z; never under `/root/src/repos/` production docs).
Live test steering session: `ls_c4b6253c09a49f7fb08abdc49deb5a30fe2a16083568313bdc9df5162977a107`
(repo `local/scratch-steering-probe`, ACTIVE 18:59:49Z, binding `28d4d0a8…2e3d74`;
heartbeat CONTEXT_REFRESH 19:04:26Z, `event_stored:true` both).

- Edit → artifact: scratch file write 18:59:49Z (chain head).
- Event → `file.edit` ledger receipt `evt_aa56931851a248ee962610e7d9be7ea9`
  (stored:true, hash `3eff50cb…`), re-readable via `events_query`
  (repo `local/scratch-steering-probe`, count 1).
- Refresh → `POST /documents/text` live receipt
  `track_id: insert_20261128_190001_8cfbfbfd` → `track_status` resolved
  `doc-3410b503d0e882b2ffb65eda40817279` (`pending` → `parsing`; scan skipped,
  pipeline busy with backlog).
- State update → probe doc `processed` ~19:09Z (polled `pending`→`parsing`→
  `processed`). Live `POST /query` naive mode returns
  `scratch-steering-probe__F7-PROBE-20261128.md` as a reference (mix still
  `[no-context]` for this phrasing — graph-vs-chunk retrieval observation).
- TODO/steering injection → steering-bound `docs_search`
  (session `ls_c4b6253c…`, binding `28d4d0a8…`, steering text = probe fact)
  returns the probe doc as reference 1 with the full fact text
  ("relay lattice routes probe traffic via conduit seven"; artifact
  `/tmp/probe_steering.json`). Chain edit → event → refresh → state →
  injection fully cited, scratch-only.

## Ledgered intelligence proof (curated devnet promotion + verify-on-recall)

- Curated promotion (explicit content hash, rationale, session identity):
  `memory_write` repo:agent-substrate fact `f7-probe-20261128-steering`,
  source_event `evt_aa56931851a248ee962610e7d9be7ea9`, idempotency
  `f7-probe-20261128-steering-v1` → `accepted`, `verified_persisted:true`,
  entry `mem_ee4578ec2f344ab5bb51633153996e48`, entry_hash `964779c8…`,
  created 19:02:30Z.
- Duplicate hash spends nothing: same key replayed → `idempotent.replay`,
  `deduplicated:true`, same entry, nothing written again.
- Verify: `memory_verify` → `pending`: content hash recomputed and MATCHES;
  anchor pending (hour 2026-11-28T18:00Z not closed yet). Fail-closed honored:
  no `verified` claimed before the root publishes.
- Verify-on-recall: governed `memory_search` returns the entry with full
  provenance (id/hash/source_event/subject v1) while the Hindsight bank leg
  degraded (`recall-timeout`, then `circuit open`) — degrade-per-leg holds;
  governed index authoritative. Hindsight recall outage recorded as gap
  (last-good: governed hit + hash-match).

## Temporal + cache proofs

- Temporal (live): `memory_search` "phase" limit 3 → page1
  (`mem_ee45…` 19:02:30Z, `mem_ab7c…`, `mem_b575…`); cursor page
  (`before`+`before_id`) → 3 strictly-older disjoint ids, descending `created`.
  Windowed recency reconciles without dupes. RAG machine live: `IDLE`,
  `consecutiveFailures: 0`, hash `34a4a3dd`.
- Cache (live): same query with limit 4 → first 3 ids in identical order with
  identical provenance (entry hashes, source events); repeat identical call
  byte-identical per harness dedupe. Ranking stable = version-keyed cache
  consistent. Invalidation-on-state-version-bump remains code-path only
  (Phase 105 fake tests) — not exercised live, recorded as such.

## Files

- Rewrote: `.planning/15-repos-lightrag-ingest-evidence.md` (live-only rows).
- New: `.planning/phases/106-f7-repo-ingest-and-steering-test/106-SUMMARY.md` (this file).
- Scratch (untracked, uncommitted): `/tmp/as-wave9/scratch-steering-probe/probe-doc.md`.
- Run artifacts (outside repo, cited): `/tmp/as-wave9-106-live-run.log`,
  `/tmp/probe_found.json`, `/tmp/probe_query_short.json`,
  `/tmp/probe_query_targeted.json`, `/tmp/as-wave9-106-state-backup.json`.
- Touched live (append-only/expected): `.lightrag_ingest_state.json`
  (orchestrator-written); no commits (per instructions).
