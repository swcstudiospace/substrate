# Phase 106: F7 15-repo ingest verification + steering test — PLAN

**Context:** `106-CONTEXT.md` (live test phase, discuss skipped)
**Boundary:** Ingest all 15 repos to live LightRAG with per-repo evidence (operator live window granted), then prove the full loop: doc edit → event → refresh → state update → steering injection observed.
**Safety:** Scratch repos only; no production doc mutation. Live window recorded in SUMMARY.

## Tracer first

Before Task 1, confirm the live seam in one read-only pass (no mutation):
- `scripts/lightrag_ingestion_orchestrator.py --help` resolves `LIGHTRAG_URL` / `SUBSTRATE_LIGHTRAG_URL` (+ `LIGHTRAG_API_KEY`) against the live window; record which env provided the URL.
- Read `.lightrag_ingest_state.json` and note all `mock-track-*` ids are dry-run artifacts to be superseded (do not delete; live run overwrites/appends).
- Confirm live `GET /documents/pipeline_status` reachable (one curl, no submit). If unreachable, stop and report — do not fall back to `--dry-run` and call it evidence.

## Task 1 — Live ingest all 15 repos with per-repo evidence

**Files (exact):**
- `scripts/lightrag_ingestion_orchestrator.py` (reuse, no edits; `--all` live run)
- `.lightrag_ingest_state.json` (live-updated state; real track/doc ids replace mock rows)
- `.planning/15-repos-lightrag-ingest-evidence.md` (rewrite per-repo rows from live state — real docs counts + sample query results, not mock)

**Steps:**
1. Record live window (operator grant timestamp, LightRAG URL source env, date) at top of run log.
2. Run `python3 scripts/lightrag_ingestion_orchestrator.py --all` (live; no `--dry-run`). Resume from partial state on failure; failed repos queue and retry per orchestrator policy.
3. Per repo (all 15: `agent-realm`, `agent-substrate`, `agent-swarm`, `auctioning`, `autonogrammer`, `claude-ultrathink`, `ClippyOS`, `desklanes`, `hypergrok`, `motion-playbook`, `trading-desk`, `spectrumwebco-marketing`, `token-optimisation`, `programming-desk`, `purpleteam`): capture status, docs count, ≥1 sample entity/relation query result (global mode). Empty-doc repos (`desklanes`, `token-optimisation`, `trading-desk` per dry-run) must show live `discovered docs=0` explicitly, not inherited mock counts.
4. Rewrite `.planning/15-repos-lightrag-ingest-evidence.md` from live state only; flag any repo not reaching `completed`.

**Acceptance:** All 15 rows `completed` with real (non-`mock-track-*`) ids and sample outputs, or an explicit failed-repo list with queue/retry outcome. No mock ids presented as live evidence.

## Task 2 — E2E steering proof in a scratch repo

**Files (exact):**
- Scratch repo only (e.g. `/tmp/as-wave9/scratch-steering-probe/` — create under scratch, never under `/root/src/repos/` production docs)
- Live session under test (steering session handle + TODO surface; observed, not edited by hand)
- `.planning/phases/106-f7-repo-ingest-and-steering-test/SUMMARY.md` (proof record — see spec below)

**Steps (tracer-first: walk the seam before asserting it):**
1. Open a live test steering session; record its handle/binding.
2. Controlled doc edit in the scratch repo (single markdown fact with a unique probe string, e.g. `F7-PROBE-<date>`).
3. Observe: ingest/refresh event fires → state refresh picks up the edit → STATE/SUMMARY reflects it → steering injection lands the probe fact in the live test session's TODOs.
4. Capture each hop with timestamp + artifact pointer (event id / query output / TODO screenshot-or-transcript excerpt). A hop with no observable artifact is a gap, not a pass.

**Acceptance:** Probe string traceable end-to-end: scratch edit → event → refreshed state → TODO injection, each with cited evidence. Any break is recorded as a named gap with the last-good hop identified (ties F1–F6 together; does not re-implement them).

## Verification harness (loop, not one-shot)

- `python3 scripts/lightrag_ingestion_orchestrator.py --help` clean (pre-flight).
- Live state audit: script asserting every repo in `.lightrag_ingest_state.json` has `status=completed`, `docs_count` integer, non-mock track ids, and ≥1 sample result; fails on any `mock-track-*` remnant claimed as live.
- E2E probe check: `docs_search`/query for `F7-PROBE-*` returns the scratch doc post-refresh; steering session TODOs contain the probe fact.
- Re-run harness after any retry/resume; green only when ingest audit + probe check both pass in the same run.

## SUMMARY spec (`.planning/phases/106-f7-repo-ingest-and-steering-test/SUMMARY.md`)

- Live window: grant timestamp, LightRAG endpoint source, operator.
- Per-repo evidence table (15 rows: status, docs count, sample excerpt) + pointer to live `.lightrag_ingest_state.json`.
- E2E proof chain: edit → event → refresh → state update → TODO injection, each with timestamp + artifact id.
- Gaps: any failed repo or broken hop, named with last-good evidence. No fabricated passes.

## Out of scope

- No code edits to orchestrator, F1–F6 paths, or steering/session machinery (observe and record only).
- No production doc mutation; no new repos beyond the 15 + one scratch probe.
- No gates/formatters/linters; no re-ingest of already-live repos for cosmetics.
- No fixing F1–F6 defects found en route — file as gaps, close the Wave 9 loop with evidence.
