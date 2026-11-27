# LightRAG checkpoint — Wave 1 (n1, SPE-38284) · 2026-11-26

## Checkpoint identity

- Tool: `/root/lightrag-sync` (`cli.py sync --root /root/src/repos`). Scanner root default `~/src/repos` = `/root/src/repos`.
  **Do NOT pass `--root /src/repos`** — that tree holds only `omp-telegram` and yields 0-file dry-runs.
- Scope: 15 repos, `.md` only, ≤1 MiB, sha256 content ids (`state_store.py`): `repo:relpath`, idempotent skip on unchanged hash.
- Live LightRAG: v1.5.7, PGTableGraphStorage, `/health` 200 `pipeline_busy:false`, TEI BAAI/bge-small-en-v1.5 @8080.
- `status_counts` 2026-11-26: **processed 9665 / failed 1713 / all 11378** (failed grew 1605→1713 while processed grew; extraction failures need triage — see n6).

## Manifests (checkpoint state)

`state/manifests/` (sha256 → doc-id map per repo):

| Repo | Manifest | State |
|---|---|---|
| agent-realm | 558.6K | fully-synced |
| programming-desk | 213.8K | fully-synced |
| spectrumwebco-marketing | 427.7K | fully-synced |
| purpleteam | 181.1K | fully-synced (2026-11-23T17:27Z report: 1 added, 358 unchanged) |
| hypergrok | 34.7K | fully-synced |
| ClippyOS | 166.0K | fully-synced |
| motion-playbook | 5.5K | fully-synced |
| token-optimisation | 5.4K | fully-synced |
| desklanes | 447B | fully-synced (README only) |
| auctioning | 41.8K | **fully-synced** (2026-11-26T14:10:02Z, run 1bbf921f) |
| trading-desk (5 docs) | — | **fully-synced** (2026-11-26T14:10:27Z, run 1bbf921f; 92 skipped) |
| agent-substrate (~889 docs) | 477.7K (897 entries) | **partially-synced** 2026-11-26T16:12Z — 896 skipped, 1 replaced, 4 symlink skips (`.venv`); retrieval verified (naive query cites agent-substrate docs) |
| claude-ultrathink (~1252 docs) | 702.8K (1252 entries) | **partially-synced** 2026-11-26T18:38Z — 1252 skipped, 4 symlink + 1 non-UTF8 skips |
| agent-swarm (~1790 docs) | 913.7K (1790 entries) | **partially-synced** 2026-11-27T17:57Z — retry drained 94-item queue; only 4 symlink skips; retrieval verified |
| autonogrammer (~3516 docs) | 3516 entries | **partially-synced** 2026-11-27 — 3506 skipped, **10 quarantined** (`plugins/agent-swarm/omp/agents/a1*.md`, vendored copies; server-side flush failures, content covered under agent-swarm paths) |
Pending total (dry-run 2026-11-26): **7465 docs** across 6 repos (trading-desk 5, auctioning 87, agent-substrate 889, claude-ultrathink 1252, agent-swarm 1752, autonogrammer 3480).

## Resume semantics (verified)

- Rerunning `sync --repos X` skips unchanged hashes → **resumable after timeout/kill**; checkpoint advances per repo on completion.
- Large repos (ClippyOS-scale) historically required several `sync` invocations (extraction ~slow per doc via bridge); runs must be retried until `fully-synced` + manifest written.
- Reports: `state/reports/sync-*.json` with per-repo `file_counts` + `status_counts` snapshot per run.

## Gaps / blockers

- 13/15 manifested; agent-swarm + autonogrammer failed-but-retrying (163 pending-retry, see below) — ingestion continuation, not restart.
- LightRAG-side `failed` (4304) reconciled 2026-11-27: mostly `dup-*` duplicate rows, not lost data (see Denominator reconciliation).
- Retrieval verification per batch (naive mode today): verified for agent-substrate + claude-ultrathink via direct queries; `retrieval_evals` harness (migration v52, unapplied) is the future gate.

## Denominator reconciliation (2026-11-27, per n6)

- Tool pending-retry totals: 163 (94 agent-swarm + 69 autonogrammer) — genuine PGVector/embedding extraction failures, retry-driven.
- LightRAG global `failed`: 4304. Sampled 50 newest (page 1, all autonogrammer): **50/50 are `dup-*` rows** — "Identical content already exists under another filename. Original doc_id: doc-…", e.g. `Autonogrammer.Native.Tests/bin/Release|Debug/.../skills/*/SKILL.md` build copies. Content IS indexed under the original doc_id; these rows are duplicate/superseded, not lost data.
- Consequence: `failed` count will never drain on rerun (manifest hash-skip skips manifest-ok docs forever; dup rows have no manifest entry). True backlog = tool pending-retry (163), not 4304. Cleanup = delete `dup-*` rows server-side (operator-gated; not attempted).
- Serialization: **unproven**. The 2038→4304 spike coincided with 2-wide bulk ingest, but retries (94+69) at 2-wide prove nothing about bulk concurrency. Rule adopted for future bulk: **single-writer sync lane** until a measured test proves otherwise.
