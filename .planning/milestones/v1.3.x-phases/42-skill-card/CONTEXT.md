---
phase: 42-skill-card
requirements: [F-D3, F-D4]
depends_on: [D-T3]
status: scoped in-repo on origin/main acb6767. The live fast-forward proof is operator-gated
---

# 42-CONTEXT: SKILL-CARD

## Scope (ROADMAP)

- F-D3: `skills_list` and an approve/decline audit trail (§5.1).
- F-D4: skills become searchable through `docs_search` after each `agent-skills` fast-forward re-ingest.

## State on main (acb6767)

- `skills_list` exists: `packages/mcp-server/src/mcp.ts` (line 1164), REST `/skills` (`admission.ts:176`).
- The approve/decline trail exists: `skills_approve` (`mcp.ts:1128`), the state machine in `skills/registry.ts:23-30`, events `skill.approve`, `skill.decline`, `skill.approve.refused` (`server.ts:2891-3001`). Policy: approve is fail-closed, list is fail-open (`policy.ts:28,62`).
- The fast-forward trigger exists: `projector/src/skills-sync.ts:72` posts `/docs/merge-trigger` after a fast-forward, with a retry queue (`refresh-pending.json`).
- The re-ingest does not run for `agent-skills`. `server.ts:307` sets `LOCALLY_INGESTED_DATASET` to `agent-substrate`, and `server.ts:1492-1498` returns `{noop: true, reason: "no-configured-ingest-root"}` for any other dataset, recording no version. `server.test.ts:574-584` asserts zero uploads for that case.
- Dataset triggers and version retention exist: `docs-datasets.ts:27-36` (`DATASET_TRIGGERS`, `DATASET_VERSION_RETENTION = 5`), `recordVersion` at `:56-58`. `degradedAgentSkillsServe` serves the pinned version with its age until a trigger arrives (`docs-datasets.ts:378-415`).

## Decisions (conservative defaults, stated here)

- D42-1. A new config `SUBSTRATE_AGENT_SKILLS_ROOT` is the absolute path of a local checkout of the agent-skills repository. Unset means the trigger stays the no-op it is today, so there is no behaviour change without configuration.
- D42-2. When set, the `agent-skills` trigger runs the same guarded ingest the agent-substrate trigger runs, over that checkout: pages from `SKILL.md` and `references/`, using the existing `scanIngestPages` rules. It records a dataset version with the commit and content digest, under the existing retention of five.
- D42-3. Ingest roots become a per-dataset map: `agent-substrate` keeps its current base directory and roots, byte for byte in behaviour. `agent-skills` uses `SUBSTRATE_AGENT_SKILLS_ROOT`.
- D42-4. F-D3 needs no code change. Criterion 1 is proven by the existing tests, cited in the records. The gap noted in FEATURES (how `declined` is reported) stays as it is.
- D42-5. Fail closed. If the checkout cannot be read, the trigger records a failure and the pinned version keeps serving with its age, as `degradedAgentSkillsServe` already does.
- D42-6. The fake RAGFlow in tests stands in for the plane. A test proves that `docs_search` returns a document from the new agent-skills version after the refresh.

## Out of scope

- Creating the RAGFlow `agent-skills` dataset, RAGFlow keys, installing the `substrate-skills-sync` unit on the host, and a live fast-forward proof. These are operator-gated.
- Changing the decline-reporting semantics.
