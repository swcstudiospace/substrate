# Phase 101 SUMMARY — F2 Hindsight Relationship Learning

**Goal achieved:** deterministic relation extractor records TS/JS imports,
markdown links, and phase `Depends on` edges as typed Hindsight episodes
with provenance; recall joins relationship context as metadata; new evidence
updates relations (self-improvement loop). F6 (Phase 105) consumes enriched recall.

## Extractor coverage

`packages/mcp-server/src/planes/relations.ts` (new) — all deterministic, no LLM:

| Extractor | Forms covered | Skipped |
|---|---|---|
| `extractTsImports` | `import x from`, `import {} from`, side-effect `import`, `export … from` / `export * from`, dynamic `import()`, `require()` | Bare packages kept as-is (raw specifier recorded, no resolution) |
| `extractMdLinks` | relative links, `./sub/c.md#sec` with anchor, `#frag` anchors | `https://`, `mailto:` (not file edges); reference-style links (v1 out of scope) |
| `extractPhaseDeps` | `Depends on: A`, `**Depends on**: A, B`, trailing `(note)` stripped, `Nothing` skipped | — |

Raw specifiers/targets are kept verbatim as `to` (no path resolution);
duplicates collapse to one edge per (kind, from, to).
`extractRelations(from, source)` runs all three (each matches only its own
syntax) with cross-extractor dedupe.

## Relation payload schema

- `RetainItem`: `content: "relation {kind} {from} -> {to}"`,
  `tags: ["relation", "relation:{kind}"]`,
  `metadata: { relation_kind, from, to, source_path (= from), commit }` —
  provenance is path + commit SHA only, never secret content.
- Bank owner: `relationBank(config) = bankForSurface(config, RELATION_BANK_SURFACE)`
  (`"relations"` surface constant added to `planes/hindsight.ts`);
  one bank write per relation, no dual-write.
- `RetainItem.metadata` passthrough already existed in `retainMemories`
  — no change needed there (verified: fake stores string metadata,
  recall returns it, `edgesFromRelationHits` parses it back).
- Idempotence key: `relationDocumentId(from, to, kind) = "rel:{kind}:{from}:{to}"`
  (colon-safe: document endpoints `encodeURIComponent` the id).
  `retainMemories` upserts with `update_mode: "replace"`; re-retain of the
  same set sends a byte-identical body (proven in test).

## Recall join + update loop

- `DerivedMemoryHit` gains optional `related?: RelatedRef[]` where
  `RelatedRef = { kind, to, source_path, commit }` (`to` = the edge's other
  endpoint). Example: hit `document_id: "b.ts"` with edge `a.ts --import--> b.ts`
  yields `related: [{ kind: "import", to: "a.ts", source_path: "a.ts", commit: "abc" }]`.
- `attachRelated(hits, edges)` matches either endpoint, caps at
  `MAX_RELATED_PER_HIT (= MAX_RECALL_PER_BANK)` per hit, returns hits
  untouched (same array) when edges are empty, and never mutates `text`
  (same string reference travels through).
- `recallMemories` applies the join via new optional `RecallDeps.relations`;
  absent/empty disables it. The brief fan-out path is untouched.
- `edgesFromRelationHits` parses recalled relation episodes back into edges
  (non-relation hits skipped) — the lookup half of the join.
- `diffRelations(old, fresh)` → `{ added, removed }` keyed by episode id.
  `syncRelations` retains added (skips the call when empty — `retainMemories`
  forbids empty retains) and `deleteDocument`s removed ids; re-sync of an
  unchanged set issues zero plane calls (idempotent).

## F6 handoff (Phase 105)

1. Recall the relations bank (`relationBank(config)`) for candidate edges.
2. `edgesFromRelationHits(relationHits)` → `RelationEdge[]`.
3. Pass as `RecallDeps.relations` to `recallMemories` (or call
   `attachRelated` on any `DerivedMemoryHit[]` directly).
4. Read `hit.related[]` — metadata only; `hit.text` is byte-identical.

## Files changed

- NEW `packages/mcp-server/src/planes/relations.ts` — extractors, ids,
  retain items, diff, edge parsing, `syncRelations`.
- NEW `packages/mcp-server/src/planes/relations.test.ts` — 14 tests,
  fake-only (`HindsightFake` + injected `FetchLike`, no live calls).
- EDIT `packages/mcp-server/src/planes/hindsight.ts` — added
  `RELATION_BANK_SURFACE = "relations"` (one-line, minimal diff).
- EDIT `packages/mcp-server/src/memory-recall.ts` — `RelatedRef`,
  `DerivedMemoryHit.related`, `MAX_RELATED_PER_HIT`, `attachRelated`,
  `RecallDeps.relations`, one-line join in `recallMemories`; import block
  split into value + `import type` per style rule.

## Verification

- `bun test src/planes/relations.test.ts` — 14 pass, 0 fail (43 expects).
- Neighbors `hindsight.test.ts`, `memory-recall.test.ts`,
  `brief-recall.test.ts`, `brief-recall-fanout.test.ts` — 222 pass, 0 fail.
- Manual tracer: `toRetainItems([{kind:"import",from:"a.ts",to:"b.ts"}],{commit:"abc"})`
  → fake `retainMemories` receives one item with the stable `document_id`
  and provenance metadata; repeat call sends an identical body.
- Recall check: fake `recallBank` hit for `b.ts` → reply `related`
  contains the `a.ts` edge; `text` byte-identical pre/post join.

## Out of scope (deferred per PLAN)

LLM-based inference, new Hindsight server features, live-bank writes in
tests, F6 consumer implementation (Phase 105), gates/formatters.
