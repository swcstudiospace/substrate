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
  **GAP-CLOSURE 19:24 UTC: re-ingest re-attempted, 30× 409 (docs already live;
  log `/tmp/as-wave9-106-gapclosure-autonogrammer.log`; state stays `failed`,
  expected — presence confirmed, 3,508 prefix docs, 1,311 `processed`).
  Retrieval re-verified with corrected ref matcher (prior 0-own was a probe
  artifact: `startswith` check against stringified ref dicts): mix
  `What is autonogrammer?` → 18 refs, 2 own-prefix
  (`autonogrammer__README.md`, `autonogrammer__docs__README.md`); mix
  `What accessibility docs does autonogrammer have?` → 20 refs, 13 own-prefix
  (incl. `autonogrammer__docs__accessibility__statement.md`,
  `autonogrammer__docs__accessibility__README.md`;
  evidence `/tmp/as-wave9-106-gapclosure-evidence.json`). RESOLVED.**
- claude-ultrathink: discovered=30, 3 tracks, `completed`. New 3 `failed`
  (`dup-*`); 1,202 historical processed. Query → 5 refs, 2 own
  (`claude-ultrathink__docs__validation__results__claude-code.md`,
  `claude-ultrathink__docs__install__claude-code.md`).
- ClippyOS: discovered=5, 0 tracks (5× 409), `failed`. 28 prefix docs, **0
  processed** (13 parsing / 1 analyzing / 14 pending, stuck since 2026-11-23).
  Query → 5 refs, 0 own-repo. GAP: ingested but unprocessable/unqueryable.
  **GAP-CLOSURE 19:23 UTC: re-ingest `completed` (5 new tracks
  `insert_20261128_192312_*`, log `/tmp/as-wave9-106-gapclosure-clippyos2.log`).
  Prefix inventory now 33 docs, 33 `processed` (was 28 docs, 0 processed).
  Query (naive) `ClippyOS frontend dogfood` → 19 refs, 1 own-prefix
  (`ClippyOS__docs__superpowers__plans__2026-09-18-clippyos-frontend-dogfood.md`;
  evidence `/tmp/as-wave9-106-gapclosure-evidence.json`). Mix-mode generic
  `What is ClippyOS?` still 0 own (17 cross-repo refs) — retrieval is
  mode/phrasing-dependent. RESOLVED with evidence (mode caveat recorded).**
- desklanes: discovered=0 → `completed` (empty, correct: no `docs/` dir).
  Historical 2 docs `failed`. Query → 5 refs, 1 own
  (`corpus:swcstudiospace/desklanes:README.md`).
- hypergrok: discovered=4, 0 tracks (4× 409), `failed`. 79 prefix (2 processed).
  Query → 5 refs, 5 own (`corpus:hypergrok:README/SETUP/CHANGELOG/SKILL`).
- motion-playbook: discovered=10, 0 tracks (10× 409), `failed`. 13 prefix docs,
  **0 processed (all `failed`, since 2026-11-23)**. Query → 5 refs, 2 own via
  corpus namespace (`corpus:motion-playbook:SKILL.md`, `README.md`). GAP (prefix
  namespace); corpus-namespace copies ARE retrievable.
  **GAP-CLOSURE 19:23 UTC: re-ingest `completed` (10 new tracks
  `insert_20261128_192323_*`, log `/tmp/as-wave9-106-gapclosure-motion.log`;
  pipeline busy → idle attempt 4, ~35s). Prefix inventory now 23 docs, all
  `failed` (instance-side processing failure persists for old+new prefix docs).
  Retrieval re-verified (mix): `motion-playbook frame budget` → 19 refs, 3
  own-topic (`corpus:motion-playbook:docs/02-frame-budget.md`,
  `docs/09-measuring.md`, `SKILL.md`); `What is motion-playbook?` → 17 refs,
  2 own (`SKILL.md`, `README.md`). RESOLVED via corpus namespace with evidence
  (`/tmp/as-wave9-106-gapclosure-evidence.json`); prefix-namespace processing
  failure ACCEPTED (forcing reprocessing needs delete+re-upload, out of bounds).**
- trading-desk: discovered=0 → `completed` (empty, correct). Historical 5 docs
  all `failed`. Query → 5 refs, 0 own-repo (corpus:hypergrok only). GAP.
  **GAP-CLOSURE 19:24 UTC: orchestrator `--project trading-desk` → resume skip
  (`already COMPLETED`); repo has no `docs/` dir (only autonomy/briefs/data/
  journal/proposals/research/strategies/watch/), so there is nothing in-scope
  to ingest. Prefix inventory still 5 docs, all `failed`. Re-queried (mix):
  `What is trading-desk?` → 16 refs, 0 own; `trading-desk risk manager` →
  14 refs, 0 own (hypergrok desk agents/skills only). ACCEPTED gap with reason:
  no local source docs under the orchestrator's `docs/` contract; expanding
  discovery scope is a code change, out of bounds; topic partially covered by
  hypergrok trading-desk content. Evidence
  `/tmp/as-wave9-106-gapclosure-evidence.json`.**
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

## Gap-closure re-run (~19:23–19:25 UTC, same live window)

Auth note: instance now requires `X-API-Key` (key via operator file
`/etc/substrate/substrate.env`, `LIGHTRAG_API_KEY`; redacted, never committed).
An initial keyless `--project ClippyOS` attempt returned 403s
(`/tmp/as-wave9-106-gapclosure-clippyos.log`); all gap-closure runs below used
the key. No state hand-edits; no commits.

- ClippyOS: `completed` (5 new tracks). Prefix 33 docs / 33 `processed`.
  RESOLVED (naive own-prefix ref; mix-mode generic-phrasing caveat recorded).
- motion-playbook: `completed` (10 new tracks). Prefix 23 docs / 23 `failed`.
  RESOLVED via corpus namespace (3 own-topic refs); prefix processing ACCEPTED.
- trading-desk: resume skip (`completed`, no `docs/` dir — nothing in-scope to
  ingest). Prefix 5 docs / 5 `failed`; queries 0 own. ACCEPTED with reason.
- autonogrammer: `failed` (30× 409, already live — expected). Prefix 3,508 docs /
  1,311 `processed`; queries return own-prefix refs (2 and 13). RESOLVED (prior
  0-own was a probe-matcher artifact).

## State pointers

- Live state: `.lightrag_ingest_state.json` (orchestrator-written, this run).
- Run log: `/tmp/as-wave9-106-live-run.log` (per-doc 409 lines, track ids, samples).
- Inventory: `/tmp/probe_found.json` (per-repo id/status/file_path).
- Query evidence: `/tmp/probe_query_short.json` (15× mix), `/tmp/probe_query_targeted.json`.
- Gap-closure logs: `/tmp/as-wave9-106-gapclosure-clippyos2.log`,
  `/tmp/as-wave9-106-gapclosure-motion.log`,
  `/tmp/as-wave9-106-gapclosure-autonogrammer.log`
  (+ keyless 403 attempt `/tmp/as-wave9-106-gapclosure-clippyos.log`).
  State backup pre-gap-closure: `/tmp/as-wave9-106-gapclosure-state-backup.json`.
- Gap-closure evidence: `/tmp/as-wave9-106-gapclosure-evidence.json` (per-prefix
  inventory + per-query full ref paths/own counts), probe
  `/tmp/probe_gapclosure.py`.
