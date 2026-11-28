# 15 Repos LightRAG Ingest Evidence — LIVE (Phase 106, F7)

Live run: `python3 scripts/lightrag_ingestion_orchestrator.py --all` (no `--dry-run`),
2026-11-28 18:53–18:55 UTC, exit 0, wall 152s. Full log: `/tmp/as-wave9-106-live-run.log`
(state backup pre-run: `/tmp/as-wave9-106-state-backup.json`).

Live window: operator-granted. Endpoint `http://127.0.0.1:9621` (LightRAG 1.5.7,
source: operator file `/etc/substrate/substrate.env`, `LIGHTRAG_URL`); API key
present via same file, redacted everywhere, never committed. Pre-flight
`GET /documents/pipeline_status` reachable, pipeline idle (`busy:false`).
No `--dry-run` artifact is presented as live evidence below; mock ids
(`mock-track-*`) appear nowhere in this run.

Inventory sweep: `POST /documents/paginated` (200/page, all 18,963 docs),
2026-11-28 ~18:57 UTC, prefix `<project>__`. Per-repo sample: live `POST /query`
(mix, top_k 5). Global-mode entity phrasing (`list the primary entities…`)
returns `[no-context]` on this instance — including inside the orchestrator's own
sample step (empty entities/relations for all 3 queried repos in-run); mix-mode
short-form questions (`What is {repo}?`) retrieve with references. Evidence rows
cite mix-mode results.

## Per-repo rows (orchestrator status + live annotation)

- agent-realm: discovered=30, live tracks=30 (`insert_…`, 0× 409). Orchestrator
  marked `failed` (poll timeout) — retry outcome: all 30 `processed` in inventory
  (created 2026-11-28, e.g. `agent-realm__docs__data__models.md`). EFFECTIVELY
  COMPLETE. Query `What is agent-realm?` → 5 refs, 1 own-repo
  (`agent-realm__.planning__PROJECT.md`).
- agent-substrate: discovered=30, 1 new live track + 29× 409 (already present).
  `completed`. Prefix inventory 898 docs (889 processed). Query → 5 refs, 1 own
  (`agent-substrate__.substrate__BRIEF.md`).
- agent-swarm: discovered=30, 0 tracks (30× 409), `failed: no tracks from submit`.
  Retry outcome: 1,790 prefix docs present (1,690 processed). Query → 5 refs,
  1 own-topic (`autonogrammer__plugins__agent-swarm__README.md`).
- auctioning: discovered=6, 5 tracks, `completed`. New 5 docs status `failed`
  (`dup-*`, e.g. `auctioning__docs__TOS.md`); 20 historical processed. Query →
  5 refs, 4 own (`corpus:swcstudiospace/auctioning:AUCTIONING.md` + issues).
  New-doc failure recorded as gap; repo queryable via historical docs.
- autonogrammer: discovered=30, 0 tracks (30× 409), `failed`. 3,508 prefix docs
  (1,310 processed). Query `What is autonogrammer?` → 5 refs, 0 own-repo
  (`aut-dev__README*.md`, corpus hypergrok); targeted re-query also 0 own.
  Retrieval gap (docs present+processed, not surfaced for these phrasings).
- claude-ultrathink: discovered=30, 3 tracks, `completed`. New 3 `failed`
  (`dup-*`); 1,202 historical processed. Query → 5 refs, 2 own
  (`claude-ultrathink__docs__validation__results__claude-code.md`,
  `claude-ultrathink__docs__install__claude-code.md`).
- ClippyOS: discovered=5, 0 tracks (5× 409), `failed`. 28 prefix docs, **0
  processed** (13 parsing / 1 analyzing / 14 pending, stuck since 2026-11-23).
  Query → 5 refs, 0 own-repo. GAP: ingested but unprocessable/unqueryable.
- desklanes: discovered=0 → `completed` (empty, correct: no `docs/` dir).
  Historical 2 docs `failed`. Query → 5 refs, 1 own
  (`corpus:swcstudiospace/desklanes:README.md`).
- hypergrok: discovered=4, 0 tracks (4× 409), `failed`. 79 prefix (2 processed).
  Query → 5 refs, 5 own (`corpus:hypergrok:README/SETUP/CHANGELOG/SKILL`).
- motion-playbook: discovered=10, 0 tracks (10× 409), `failed`. 13 prefix docs,
  **0 processed (all `failed`, since 2026-11-23)**. Query → 5 refs, 2 own via
  corpus namespace (`corpus:motion-playbook:SKILL.md`, `README.md`). GAP (prefix
  namespace); corpus-namespace copies ARE retrievable.
- trading-desk: discovered=0 → `completed` (empty, correct). Historical 5 docs
  all `failed`. Query → 5 refs, 0 own-repo (corpus:hypergrok only). GAP.
- spectrumwebco-marketing: discovered=30, 0 tracks (30× 409), `failed`.
  664 prefix (663 processed). Query → 5 refs, 1 own
  (`spectrumwebco-marketing__content__blog__introducing-spectrum-web-co.md`).
- token-optimisation: discovered=0 → `completed` (empty, correct). 11 prefix
  (1 processed). Query → 5 refs, 2 own (`corpus:token-optimisation:…PROJECT.md`,
  `RESEARCH-SELECTION.md`).
- programming-desk: discovered=10, 0 tracks (10× 409), `failed`. 386 prefix
  (179 processed). Query → 5 refs, 5 own (`corpus:swcstudiospace/programming-desk`
  planning/docs rows + case-study).
- purpleteam: discovered=30, 0 tracks (30× 409), `failed`. 358 prefix
  (316 processed). Query → 5 refs, 1 own (`purpleteam__docs__GETTING_STARTED.md`).

## Failed-repo list with retry outcome (no mock ids)

`failed: no tracks from submit` (all uploads 409-duplicate, docs already live):
agent-swarm, autonogrammer, ClippyOS, hypergrok, motion-playbook,
programming-desk, purpleteam, spectrumwebco-marketing. Outcome: presence verified
in the 18,963-doc inventory sweep; processed counts above. `failed: poll timeout`:
agent-realm — verified 30/30 processed post-run, closed as complete.
New-doc `failed` processing: auctioning (5), claude-ultrathink (3) — historical
docs carry retrievability; recorded as gap. `.lightrag_ingest_state.json` left
exactly as the orchestrator wrote it (real non-`mock-track-*` ids only);
status corrections live in this doc + phase SUMMARY, not in hand-edited state.

## State pointers

- Live state: `.lightrag_ingest_state.json` (orchestrator-written, this run).
- Run log: `/tmp/as-wave9-106-live-run.log` (per-doc 409 lines, track ids, samples).
- Inventory: `/tmp/probe_found.json` (per-repo id/status/file_path).
- Query evidence: `/tmp/probe_query_short.json` (15× mix), `/tmp/probe_query_targeted.json`.
