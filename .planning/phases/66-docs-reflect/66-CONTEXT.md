# Phase 66: Docs Reflect - Context

**Gathered:** 2026-10-29 (Run 14)
**Status:** Decisions fixed by the orchestrator from the Run 14 scout evidence; the owner's request is in `.planning/STATE.md` (Run 14).

## Phase boundary
The learning loop around retrieval: telemetry, feedback, authority, supersession, digests and gaps. It is deterministic and needs no LLM route.

## Decisions
- **D66-1:** nothing records retrieval feedback today; the only trace of a search is the `docs.search` note listing returned URLs without the query text (`docs-search.ts`, no feedback or usefulness match). Telemetry stores a query hash and a capped, redacted text.
- **D66-2:** Hindsight's self-improving surface is mostly unused. The client (`planes/hindsight.ts`) calls retain (with `document_id` and `update_mode: "replace"`), recall, document get, delete and tag patch, bank create and config, health and version; it never calls reflect, mental-model creation, observations, directives or entities, and the pin is 0.9.1 (`.github/hindsight-pin.json`, 0.10.x is blocked by an upstream recall hang). Digests therefore use the verified retain path; reflect and mental models stay out until their request shapes are verified against the pin.
- **D66-3:** retention goes through the governance gate (`memory-write.ts`): only accepted, verified entries reach Hindsight, and refusals are closed reasons. A digest is a governed `fact` entry at repo scope with a deterministic key.
- **D66-4:** authority is a pure function so it can be tested without a store; the re-rank ships in shadow first (`off|shadow|on`), like the tandem and brief flags.
- **D66-5:** supersession is detected from facts the corpus already has: the same path with a newer sha, a live document and its `milestones/` archive, and an explicit `superseded-by` front-matter marker.
- **D66-6:** a gap is a query that returned no citation or only low scores, aggregated by query hash; it is the corpus telling the owner which documents are missing.

## Canonical references
`memory-retain.ts`, `memory-policy.ts`, `memory-forget-plane.ts`, `docs-search.ts` (citation building at ~1073), `docs/memory-governance.md`, `docs/lessons-bank.md`
