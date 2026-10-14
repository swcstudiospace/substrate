# Uplift handoff — 7 engineering-mix improvements delivered

**Graph:** `ut-mv5r71hp-65f7b012` · **Date:** 2026-10-13 · **PR:** #58 (`ultrathink/uplift-7` → `main`)

## Stage 1 — phases and milestone (empty)

Discovery: `.planning/ROADMAP.md` v1.3 shows 18/18 phases complete; VALIDATION verdict PASS at `b3ab09b`; milestone archived at `ab0dff1`; STATE.md `Awaiting next milestone`. Zero remaining phases; the already-closed-milestone branch applied — stage 1 is a verified no-op, uplift started immediately.

## Stage 2 — the 7 improvements (all green, one commit series each)

| # | Item | Commit | Headline effect | Gates at close |
|---|------|--------|-----------------|----------------|
| 01 | Gate verdicts as events (memory plane) | `98b49c6` | every `memory.write` verdict lands on the ledger via the one audit emitter; accepted writes leave a trace for the first time | mcp 0 fail · phase-close pass · tsc |
| 02 | Quota-burn SLOs + dispatch storm-breaker | `62bb510` | `/slo` carries burn.tokens/burn.cost_usd; dispatcher refuses launches on breach (once-only `quota-burn` marker) | test:py 272 · obs+mcp 0 fail · tsc |
| 03 | Host re-adopts VMs after restart | `ac8e40e` | boot reconciliation replaces the D-04 blanket sweep: re-attach known, terminate labeled orphans, report foreign | host 244 · tsc · full suite |
| 04 | Sandbox egress allowlist | `e61b466` | DOCKER-USER enforcement, deny-all default, start-closed stage network, crash-orphan rule GC persisted in sandbox state | host 281 · tsc · full suite |
| 05 | Signed dispatch handoffs + drift gate | `1b93279` | dispatch context posted as `coord_handoff` packets before launch — replayable from the ledger; `coord_drift_scan` pre-launch | test:py 293 · tsc |
| 06 | Knowledge freshness automation | `689bb15` | skills-sync fast-forward triggers the guarded dataset ingest; loopback `POST /docs/merge-trigger` (guest-refusing, idempotent by hash) | projector+mcp 0 fail · phase-close · tsc |
| 07 | Loopback SSE event stream | `4ebbc53` | `GET /events/stream` — ingest-order cursor replay, bounded backlog, idle timeout, disconnect-clean timers | mcp 0 fail · phase-close · tsc |

Greptile round 1 (15 findings) and round 2 (8 findings) fixed in `9a5e144` / `ac57bb7`; round 3's guest-ingest finding fixed in `c1e9d5a` (merge-trigger refuses VM guests per DOCS-02).

## Green-check evidence (final, this head)

- `bun test` — 3283+ pass / 1 fail, the recorded F-01 environment-sensitive guard (v1.3 VALIDATION convention: failures at HEAD recorded, not fixed)
- `bunx tsc --noEmit` — clean
- `bun run test:py` — 298 passed
- `bun run check:phase-close` — pass (EVENT_KINDS 12, SURFACES 27, store/redact/vocabulary/audit locks green)
- Secrets pattern scan per commit — only planted test fixtures

## STATE.md snapshot

`milestone: v1.3 (Awaiting next milestone)` — untouched milestone machinery; post-milestone uplift tracked in STATE.md §Post-milestone uplift (all 7 rows done) + `.planning/uplift/0k-{PLAN,SUMMARY}.md` + `UPLIFT_PROPOSAL.md` progress table.

## Explicitly out of scope (recorded)

- ADR 0001 §S5 swarm-gate verdicts (the PROPER S5 — cross-repo, agent-swarm); this run shipped the memory-plane trail completion only.
- The 43 v1.3 gated live-tail proofs: operator-gated, not absorbed.
- Switching collectors/lessons from polling to the SSE stream (additive seam shipped; adoption is follow-on).
