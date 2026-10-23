---
phase: 40-docs-memory
requirements: [D-D1, D-D3, D-D4]
depends_on: [P10]
status: executed in-repo 2026-10-21; criteria 2 and 3 open (see SUMMARY)
---

# 40-PLAN: DOCS-MEMORY

## Goal (ROADMAP)

The memory planes consolidate into one: cross-surface recall, retirement of the duplicate memory MCPs once the `sub-*` banks answer, and a weekly reflect per bank.

## Decisions carried in (2026-10-21, from CONTEXT)

- **D-D1.** Recall in the brief is a bounded, cached fan-out over the `sub-*` banks. Recall is exempt from the 1200 ms brief budget and capped at 3000 ms. The other four brief reads keep 1200 ms.
- **D-D1 freshness.** The fan-out is keyed on the memory and recall generations (`gen:memory`, `gen:recall`), so a memory write or a retain refreshes the next brief.
- **D-D4.** A weekly refresh of mental models named in config (`HINDSIGHT_MENTAL_MODELS`). Not refresh-all, not deferred. No reflect-only job, because `reflect` persists nothing.
- **D-D3.** Retirement of Claude Code's `hindsight` MCP and Hermes supermemory is planned now. It runs only after a restore drill (operator-run) and operator approval.

## Tasks

1. **D-D1 code.** `memory-recall.ts` (`recallAcrossBanks`, `fanOutBriefRecall`); `recall-snapshot.ts` (`BRIEF_RECALL_CAP_MS`, `fanoutSnapshot`, `buildFanoutLines`); `brief.ts` (`boundedRecall`, the cap outside the 1200 ms budget); `service.ts` (`recallFanout` via `cache.getOrLoad` in class `recall-snapshot`, generations `gen:memory` and `gen:recall`); `cache.ts` class comment.
2. **D-D1 tests.** New `brief-recall-fanout.test.ts`. `brief-recall.test.ts` cases A to J rewritten to the new contract; none deleted.
3. **D-D4 code.** `config.ts` (`mentalModels`, `loadMentalModelConfig`); new `mental-model-refresh.ts` (weekly 7-day unref'd timer, no run at boot, `POST /v1/default/banks/{bank_id}/mental-models/{mental_model_id}/refresh` with body `{}`, one ledger note per model with action `memory.mental_model.refresh`); `planes/hindsight.ts` (exported `send`); `index.ts` (start after recall, stop in shutdown); `flag-registry.ts` (one entry, `documented: false`).
4. **D-D4 tests.** New `mental-model-refresh.test.ts`. `config.test.ts` gains a `HINDSIGHT_MENTAL_MODELS` block.
5. **Catalog and generated docs.** `event-sources.ts` (periodic entry `memory.mental_model.refresh`); `docs/event-vocabulary.md`; `docs/config-reference.md` (one generated row).
6. **Docs.** `docs/data-planes.md` (recall section, fan-out bullet, staleness); `docs/memory-governance.md` (fan-out paragraph; weekly mental-model refresh section).
7. **D-D3 runbook.** `docs/runbooks/memory-mcp-retirement.md`: restore routes for the Claude Code `hindsight` MCP and for Hermes supermemory, plus drill steps. Retirement is not executed.

## Out of scope

- Executing either retirement (needs the drill and approval).
- Live Hindsight writes, or a live `enforce` run.
- Setting `SUBSTRATE_BRIEF_RECALL`, `HINDSIGHT_BANKS` or `HINDSIGHT_MENTAL_MODELS` on the server. That is operator work.

## Acceptance (ROADMAP success criteria, as written)

1. D-D1 (decided 2026-10-21): cross-surface recall in the brief is a bounded, cached fan-out over the `sub-*` banks (`data-planes.md:34`).
2. Claude Code's global `hindsight` stdio MCP and Hermes supermemory are retired once the `sub-*` banks answer, with restore routes recorded first.
3. A weekly `reflect` per bank: mental models replace stale detail (`data-planes.md:27,39`).
