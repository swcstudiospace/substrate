# 25-02 Summary: ingest pipeline, atomic manifest, version cutter

**Wave:** 2 · **Plans:** DOCS-02 core + DOCS-03 version semantics · **Live proof:** EXPLICITLY NOT RUN (no network calls; see §5)

## 1. What was built

- **Task 1 — strip/split/hash** (`docs/ingest.ts` + test): `stripImages()` removes
  markdown inline/reference/shortcut images, `<img>`, whole `<picture>`
  elements, lone `<source>` tags, and `data:` URIs — each replaced by
  `[image: <alt>]` or nothing, with a pinned count; definition lines owned
  solely by stripped images are dropped, link-owned definitions survive, links
  (`[text](url)`, `[ref][label]`) are kept. `splitSections()` cuts at H1–H3
  fence-aware (fenced `#` lines and H4 never split), preamble as section 0,
  breadcrumb-prefixed text, per-section metadata (source_url with heading
  anchor, heading_path, commit, title, path, content_sha256, section_index);
  title is explicit > first H1 > file name. `hashPage()` is SHA-256 over final
  stripped/redacted text plus normalised path — commit excluded, so an
  unchanged page at a new commit hashes the same.
- **Task 2 — fixed pipeline** (`ingestPage()`, D25-10 order): (1) writer check
  via `surface` + `isSubstrateOrOperator` (routes/MCP enforce D25-07 in 25-04;
  refusal reason `forbidden`, outside the content closed list); (2)
  shape/roots/caps — `https://github.com/<slug>/blob/<commit>/<path>` with
  40-hex commit equality, glob include/exclude, normalisation refusing
  `..`/`.`/empty segments/backslashes/percent-encoded slashes, text-extension
  gate (`.md/.mdx/.markdown/.txt`), NUL + lone-surrogate `not-text`, title 200
  chars; (3) strip, with the 256 KiB cap measured **post-strip**; (4)
  `redactSkillContent` — any high-confidence finding refuses as `secret` with
  `findings: [{line, rule}]` and no values, contextual hits redact in place
  and count; (5) hash/split/idempotency/upload/parse under the per-dataset
  in-process lock — `dry_run` stops after hash+split with zero RAGFlow calls
  and zero manifest writes. RAGFlow failures return `failed` with the
  `ragflow-timeout/unreachable/error/bad-response` mapping, never throw.
- **Task 3 — manifest** (`docs/manifest.ts` + test): per-dataset
  `<stateDir>/<dataset>/manifest.json` (`SUBSTRATE_DOCS_STATE`, default
  `/var/lib/substrate/docs`), temp-file + rename as the only write path under
  `withDatasetLock`, document name + snake_case `meta_fields` recording
  path/hash/source/heading/commit/title/section, rebuild-from-RAGFlow with
  corruption fallback (never throws on a bad file), search helpers
  `lookupPath` / `lookupDocumentMeta` / `currentDocumentIds` (the D25-17
  post-filter set for 25-04).
- **Task 4 — versions** (`docs/versions.ts` + test): `finalize(dataset,
  commit, pathsPresent)` verifies every present page's documents report `run:
  DONE` (queued/failed/missing blocks the cut), appends the version keeping
  the last five, deletes RAGFlow documents belonging to none of the last
  five, and writes the manifest once at the end — any failure keeps the
  previous version current. Unchanged pages ride in with no upload/parse.
  Attributed as `docs_ingest` under the same writer rule.

## 2. Must-haves, observable

- D25-08: `bun test …/ingest.test.ts -t "outside-roots"` — host/slug/commit/
  traversal/encoded-slash/glob/exclude refusals, all with zero fake calls.
- D25-09: `-t "too-large"` / `-t "non-text"` — post-strip 256 KiB boundary
  (exact cap uploads, +1 refuses), 200-char title, 201 sections, NUL/lone
  surrogate, non-text extension.
- D25-10: `-t "never reach RAGFlow"` — every refusal asserts
  `fake.totalCalls() === 0` and an empty state dir; `-t "dry_run"` asserts no
  upload/parse/manifest-write/RAGFlow-call; secret tests assert the planted
  value appears nowhere.
- D25-11: `-t "stripImages"` — six-class fixture, pinned count 6, alt text
  kept (and an alt-carried secret refuses as `secret`, proving alt text joins
  the redacted stream); links kept with definitions.
- D25-15: `-t "short-circuit"` + `-t "concurrent"` — hash stable across
  commits, 5 concurrent identical ingests yield 1 upload (1 uploaded + 4
  unchanged); name/meta_fields carry path + hash.
- D25-16: `-t "splitSections"` — breadcrumb, anchors, 7-field metadata,
  fence awareness.
- D25-17: `bun test …/versions.test.ts` — cut marks current, absent pages
  leave `currentDocumentIds` and are pruned, six versions leave five with old
  documents deleted, FAIL/UNSTART/CANCEL/missing parses and list/delete
  failures keep the previous version.

## 3. Verification (run once at end, per plan)

- `bun test packages/mcp-server/src/docs/` → **100 pass, 0 fail** (6 files;
  48 mine: 26 ingest + 14 manifest + 8 versions; rest are 25-01/25-03 suites).
- `bunx tsc --noEmit` → only the 3 pre-existing `@substrate/ledger`
  resolution errors in untouched files (`greptime.ts`, `service.ts`,
  `service.test.ts`), identical to the 25-01 baseline; nothing in
  `docs/` errors.
- Rebuilt-file check: `git status` shows only this plan's six new files;
  sibling 25-03 (`search.ts`, committed as `3c3348a`) untouched — it defines
  its manifest lookup locally and never imports `manifest.ts`, so no
  interface conflict.

## 4. Files

New: `packages/mcp-server/src/docs/{ingest.ts,ingest.test.ts,manifest.ts,
manifest.test.ts,versions.ts,versions.test.ts}`.
Not touched (later plans): routes, tools, CLI, timer, harness fixture,
`service.ts` injection seam. `DocsRagflow` seam (in `manifest.ts`) is
structurally satisfied by the real `RagflowClient` — asserted at compile time
in `ingest.test.ts`; fakes implement the seam with full call counters.

## 5. Live proof — NOT RUN

No `RAGFLOW_URL` traffic was made: no live RAGFlow exists in this
environment and the contract forbids it. Operator live steps outstanding:
first `substrate docs refresh` per dataset creating missing datasets with
the confirmed embedding model and chunk method (CONTEXT live step 3), and
the D25-17 preferences 1–2 confirmation (post-filter used unless the live
step proves otherwise).

## 6. Open / risks

- `forbidden` is a seventh attribution reason beside the six content
  refusals; 25-04 maps it to 403 (anonymous stays 401 at the door).
- `finalize` cuts an empty version when none of `pathsPresent` was ingested
  (all-refused run); 25-05 must exit 1 without calling `finalize` in that
  case, per D25-19/D25-20.
- Rebuild-from-RAGFlow restores idempotency + metadata but leaves `current`
  null (recency is unrecoverable from metadata); the next refresh +
  finalize restores currency, costing at most one redundant upload per page.
- Partial manifest-write crash leaves the old manifest plus an ignored
  `.tmp-*` file; a delete that fails midway can leave partially pruned old
  documents while the version pointer stays — next finalize retries the
  prune.
