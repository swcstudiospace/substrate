# Phase 101: F2 Hindsight Relationship Learning — Plan

**Context:** `101-CONTEXT.md` in this directory (boundary, decisions, code context).
**Goal:** Deterministic relation extractor records TS/JS imports, markdown links, and phase `Depends on` edges as typed Hindsight episodes with provenance; recall joins relationship context as metadata; new evidence updates relations (self-improvement loop). F6 (Phase 105) consumes enriched recall.

## Constraints (from CONTEXT + established patterns)
- Extractor scope v1: TS/JS static imports + markdown links + phase `Depends on` edges only. Deterministic, no LLM.
- Storage: Hindsight episodes with typed relation payloads; bank owner = extractor surface; no dual-write (one bank write per relation).
- Provenance metadata-only: source path + commit SHA on every episode; never secret content.
- Recall join: relationship context appended as metadata, never mixed into recalled content text.
- Tests: fake-only (injectable `FetchLike` fake, no live Hindsight in tests).
- Bank = owner; reuse `bankForSurface` / `retainMemories` / `recallBank` from `packages/mcp-server/src/planes/hindsight.ts`.

## Task 1 — Relation extractor + typed retain (tracer first)
**Files:**
- NEW `packages/mcp-server/src/planes/relations.ts` — pure deterministic extractors (`extractTsImports`, `extractMdLinks`, `extractPhaseDeps`) returning `{ kind: "import"|"md-link"|"phase-dep", from, to }[]`; `relationDocumentId(from,to,kind)` stable id for idempotent upsert; `toRetainItems(relations, { commit })` → `RetainItem[]` with metadata `{ relation_kind, from, to, source_path, commit }`.
- EDIT `packages/mcp-server/src/planes/hindsight.ts` — export `RELATION_BANK_SURFACE = "relations"` (or reuse `bankForSurface`) + `RetainItem` metadata passthrough only if currently stripped (minimal diff).
- NEW `packages/mcp-server/src/planes/relations.test.ts` — fake-only unit tests: extractor fixtures (TS import forms incl. `import x from`, `import()`, `export from`; md links incl. relative/anchor; `Depends on` edge), stable document_id idempotence, provenance fields present.

**Tracer:** one hardcoded relation (`a.ts --import--> b.ts`, commit `test`) round-trips through `toRetainItems` → fake `retainMemories` before generalizing extractors.
**Done when:** extractors pass fixture tests; retain items carry typed payload + provenance; no live calls.

## Task 2 — Recall join + self-improvement update loop
**Files:**
- EDIT `packages/mcp-server/src/memory-recall.ts` — after `recallBank` fan-out, lookup relations touching recalled `document_id`s (bounded: cap N, same `MAX_RECALL_PER_BANK` discipline) and append as `related: [{ kind, to, source_path, commit }]` metadata on each hit; content text untouched.
- EDIT `packages/mcp-server/src/planes/relations.ts` (same file as Task 1) — `diffRelations(old, fresh)` returning `{ added, removed }`; stale relations removed via existing `deleteDocument`, new ones retained with `update_mode: "replace"` (idempotent upsert already in `retainMemories`).
- EDIT `packages/mcp-server/src/planes/relations.test.ts` (same file as Task 1) — fake-only tests: recall hit gains `related` metadata without content mutation; diff adds/removes; removed relation triggers `deleteDocument`, re-retain is idempotent.

**Done when:** recall replies carry relationship metadata separately from content; re-extraction updates (adds + deletes) relations without duplicates; F6 can read `related` off hits.

## Verification harness (no gates/formatters)
- `bun test packages/mcp-server/src/planes/relations.test.ts` — all pass, fake `FetchLike` only (assert no network: fake records calls, no live URL).
- Manual tracer check: `toRetainItems([{kind:"import",from:"a.ts",to:"b.ts"}],{commit:"abc"})` → `retainMemories` fake receives one item with `document_id === relationDocumentId(...)` and metadata `{relation_kind:"import",source_path:"a.ts",commit:"abc"}`; repeat call yields identical payload (idempotent).
- Recall check: fake `recallBank` hit for `b.ts` returns `related` containing the `a.ts` edge with provenance, `text` byte-identical to pre-join.

## SUMMARY spec (what lands in phase SUMMARY.md)
- Extractor coverage table (TS import forms, md link forms, phase-dep syntax) + files changed.
- Relation payload schema (fields, bank owner, provenance) + idempotence key.
- Recall join shape (`related[]` metadata example, content-untouched proof) + update-loop semantics (add/remove/idempotent).
- F6 handoff: how Phase 105 reads `related` metadata.

## Out of scope
- LLM-based relation inference (explicitly deferred).
- New Hindsight server features, schema migrations, live-bank writes in tests.
- UI, docs bundles, F6 consumer implementation (Phase 105).
- Gates, formatters, CI runs (verification harness only).
