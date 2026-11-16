---
phase: 42-skill-card
requirements: [F-D3, F-D4]
status: planned against the decisions in 42-CONTEXT
---

# 42-PLAN: SKILL-CARD

## Tasks

1. **Config.** `packages/mcp-server/src/config.ts`: add `agentSkillsRoot` from `SUBSTRATE_AGENT_SKILLS_ROOT` (trimmed; null when unset; a non-absolute path adds a boot warning and is treated as unset). Add a flag-registry entry, a `.env.example` entry, and the generated row in `docs/config-reference.md` (follow the generator pattern used by the other entries).
2. **Per-dataset ingest map.** `packages/mcp-server/src/server.ts`: replace the single `LOCALLY_INGESTED_DATASET` check at lines 1492-1499 with a lookup from dataset to `{ baseDir, roots }`. `agent-substrate` keeps `options.docsIngestBaseDir ?? process.cwd()` and `config.docsIngestRoots`. `agent-skills` uses `config.agentSkillsRoot` and the skills roots (`SKILL.md` and `references/`). A dataset with no entry keeps the no-op.
3. **Skills page scan.** Reuse `scanIngestPages` with the skills roots. Add no new scanner.
4. **Trigger path.** The `agent-skills` trigger calls the same `startDocsRefresh` as agent-substrate, with its pages and its base directory. A read failure goes through the existing degraded path (D42-5).
5. **Tests.** `server.test.ts` (around lines 574-584): replace the noop assertion for `agent-skills` with two tests. With the root set, the trigger ingests and records a version. With the root unset, the trigger stays a no-op with no uploads. Add a fake-RAGFlow (retired, superseded by LightRAG) test in `docs-search.test.ts` style: after the refresh, `docs_search` returns a document from the new agent-skills version (criterion 2).
6. **Docs.** `docs/data-planes.md` (the dataset table: the agent-skills ingest root and its fallback) and `docs/docs-plane.md`, only if it describes the no-op.
7. **Records.** `SUMMARY.md` and `VERIFICATION.md`. F-D3 is cited to the existing tests and code, with no change.

## Acceptance

- ROADMAP criterion 1 (F-D3): cited to existing tests and code.
- ROADMAP criterion 2 (F-D4): proven in-repo with the fake RAGFlow (retired, superseded by LightRAG) test.
- The live fast-forward proof is reported as operator-gated and not run.
