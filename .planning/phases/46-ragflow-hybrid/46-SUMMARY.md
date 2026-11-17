---
phase: 46-ragflow-hybrid
plan: 46
type: summary
wave: 1
requirements: [SOTA-02]
status: code-landed (SC1–SC4 build; SC6 checkpoints documented; live steps operator-gated)
---

# 46-SUMMARY — LightRAG hybrid RAG migration path

Ported target = origin/main (phase 46 pending there; criterion 4 gap). This commit is self-contained for cherry-pick onto a main-based branch: one commit, additive hunks only, no dependency on other branch-only commits.

## What landed

| Artifact | Purpose |
|---|---|
| `packages/mcp-server/src/docs-archive.ts` + test | SC2 build: `archiveRagflow` writes `inventory/<dataset>.json` (dataset + document list with echoed ingest metadata and the page hash read from git at the recorded commit, digested with the ingest's own sha256-over-UTF-8 construction), `state/docs-ingest.json` (verbatim state copy or an explicit absence marker), `baseline/<query-id>.json` (RAGFlow citations for the frozen sample), `manifest.json` last. Refusals before any write: non-empty target; root-filesystem target unless `SUBSTRATE_RAGFLOW_ARCHIVE_ALLOW_ROOTFS` (mirrors the index-archive gate). `verifyArchive` recomputes sha256 + byte length, refuses unlisted files and escaping manifest paths. |
| `packages/mcp-server/src/docs-parity.ts` + test | SC4 build: `parityGate` — ordered gate. Part A record mapping (dataset logical name + source_url + per-URL version; zero mismatches; missing/changed/extra/malformed mismatches; redaction: dataset + source_url only) gates Part B, the frozen 20-query sample (baseline top-1 in LightRAG top-5, degraded/empty is a miss, ≥ 17/20 at `PARITY_MIN_MATCH_RATE` 0.85). Skipped Part B never passes. `parityDelta` = SC5 delta pass, same zero-mismatch rule over delta subsets, extras not flagged. |
| `fixtures/parity/parity-queries.json` | The frozen sample: 20 entries, exactly `{id, question}`, verbatim from the plan. sha256 below. |
| `scripts/lightrag-probe.ts` + test | SC3 build: timed `/health` probe reading reach only through `lightragFromEnv`; OD-5 defaults (`--samples 20 --window-s 60 --timeout-ms 1000 --p95-max-ms 500`); p50/p95/max + failure count as JSON; exit 0 only all-2xx and p95 within bound, 1 otherwise, 2 before any socket when `LIGHTRAG_URL` is unset or flags are junk. Host printed only for loopback or `RAILWAY_PRIVATE_DOMAIN`; the key never appears in output. |
| `scripts/docs-migrate.ts` + test | SC5 groundwork: dry-run by default. Every mode re-verifies the archive first. Dry run maps every archived RAGFlow record to its expected LightRAG record (id → logical name via the inventory; unmapped ids surface as Part A mismatches) and runs Part A with Part B skipped, zero fetch, zero writes; `--answers` runs the full ordered gate. `--apply` refuses without the recorded Part A pass (`--part-a` file carrying the `parity-gate:part-a:passed records=<N>` marker), then replays pages at their recorded commits per dataset per commit through the existing LightRAG ingest (`ingestDocs`, backend `lightrag`), carries the archived per-URL versions onto the `lightrag::` keys, records LightRAG dataset pins from the archived RAGFlow pins, persists the state file, and emits the cutover note event (`note`, `payload.action = "docs.cutover"`, from/to/at/parity_sha) on the same seam the service uses. `--rehearsal` writes no state and notes nothing. Exit 0/1/2 per mode. |
| `packages/mcp-server/src/docs-search.test.ts` | Task 1 (SC1 tests): a describe named for the LightRAG backend — `context: true` names `backend: "lightrag"`, serves the plane's chunk, and attaches recalled memories (best-three by score) plus the session's last five ledger events under the untrusted notice; without the flag the reply has no `context` key and neither recall nor the ledger is read. |
| `packages/mcp-server/src/planes/ragflow.ts` + test | `listDocuments` client for the archive inventory (`GET /api/v1/datasets/{id}/documents`, the documented route; shape per `ragflow-fake.ts`), reasons not throws. |
| `packages/mcp-server/src/flag-registry.ts`, `.env.example`, `docs/config-reference.md` | Rows + `NAME=` lines for `SUBSTRATE_RAGFLOW_ARCHIVE_DIR` and `SUBSTRATE_RAGFLOW_ARCHIVE_ALLOW_ROOTFS` (documented), plus three previously unregistered reads now locked (`SUBSTRATE_PLANNING_REFUSAL_COOLDOWN_MS`, `RAGFLOW_MCP_URL`, `SUBSTRATE_LIGHTRAG_QUERY_MODE` — `documented: false`, they have no `.env.example` lines). `config-reference.md` regenerated (`bun run config:reference`). Main's `SUBSTRATE_GREPTIME_TIMEOUT_MS` row and its lines are untouched. |

SC1's runtime path (docs_search → searchDocsLightrag → retrieveForSearch, hybrid default, context attached after chunks) was already implemented at HEAD; the plan marks it Implemented and this phase only adds its LightRAG-backend tests (Task 1, above). No `service.ts`/`config.ts` edits were needed; the cooldown fix is undisturbed. Zero new dependencies; Bun 1.4.0 only. Event vocabulary unchanged: `EVENT_KINDS` stays at 12 (`vocabulary-lock.test.ts` green); the cutover reuses the `note` kind.

## Frozen sample digest

`fixtures/parity/parity-queries.json` sha256, recorded before any gate run:
`aceb203a248a0a31d33b0eb39f96d5c6502f0dd3e1a05d978d770f698fda5cdd` (recompute with `bun -e 'console.log(new Bun.CryptoHasher("sha256").update(require("fs").readFileSync("fixtures/parity/parity-queries.json")).digest("hex"))'` if in doubt — this file is frozen; do not edit it).

## Verification (offline, run on this tree)

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | clean (no output) |
| `bun test` on docs-archive.test.ts, docs-parity.test.ts, planes/lightrag.test.ts, lightrag-probe.test.ts, docs-migrate.test.ts, docs-search.test.ts, flag-registry.test.ts | 164 pass, 0 fail (686 expect calls; docs-search 68 pass including the two new LightRAG-backend context tests; planes/lightrag 37 pass; docs-archive 10; docs-parity 8; lightrag-probe 8; docs-migrate 8; flag-registry 25) |
| `bun run config:reference -- --check` | up to date |
| `vocabulary-lock.test.ts` | 0 fail (12 event kinds) |
| docs-migrate dry-run gate on a fixture archive | Part A passed with 6 records, zero mismatches, zero fetch calls, marker emitted |

Not run here, by contract: every live step (below). Pre-existing failures at HEAD are untouched and remain recorded in STATE.md.

## SC6 — operator-gated checkpoints (each runs only after that run's approval)

1. **Archive read (Task 4, SC2 proof)** — "Approve one read-only archive of the RAGFlow plane: dataset and document inventory, docs state file, 20 baseline answers, and page hashes from git. Writes only to the off-box archive directory named in `SUBSTRATE_RAGFLOW_ARCHIVE_DIR`. No RAGFlow write, no delete." Record: manifest sha256, file count, total bytes, `verifyArchive` result, path as `<archive-dir>`. Re-verify immediately before Task 16.
2. **LightRAG production deploy + timed probe (Task 6, SC3)** — "Approve deploying LightRAG to the production Railway project at a pinned image tag or digest (name the tag in this approval, not latest), and running the timed probe with the OD-5 thresholds. The deploy adds a service and does not change docs_search, which stays on RAGFlow until Task 13." Record: pinned tag, probe JSON (p50/p95/max/failures), exit status.
3. **Rehearsal ingest + PARITY_GATE Part B (Task 10, SC4)** — "Approve loading the archived migration set into a rehearsal LightRAG, separate from production, and running the frozen 20-query sample against it. Writes go only to the rehearsal instance. Production docs_search is unchanged." Record: gate output, match rate, per-query misses, sample sha256.
4. **Production ingestion (Task 12, SC4)** — "Approve the production ingestion of the archived migration set into LightRAG. This writes documents to the production LightRAG. docs_search stays on RAGFlow until the cutover approval (Task 13)." Record: records written, pipeline status, refusals; re-run the dry run and confirm Part A still passes.
5. **Cutover, delta pass, reversal test (Task 13, SC5)** — "Approve setting `SUBSTRATE_DOCS_BACKEND=lightrag` in production, restarting the substrate service, then running the delta pass. Reversal is `SUBSTRATE_DOCS_BACKEND=ragflow` with a restart. RAGFlow stays deployed through the soak window set in this approval (OD-7)." Confirm one `docs.cutover` note per switch (reversal included), one `docs_search` with `backend: "lightrag"`, delta pass zero mismatches.
6. **RAG-dependent phase gate (Task 14, OD-3)** — record for 25, 40, 42, 51 whether each VERIFICATION names a live RAGFlow check and whether that check stays needed post-migration.
7. **RAGFlow code removal + storage deletion (Tasks 15–16)** — only after SC1–SC4 pass, the delta pass and the RAG-dependent phase list pass; `verifyArchive` re-run passes immediately before deletion.

### RAGFlow removal checklist (for Task 15, after the gates)

- `packages/mcp-server/src/planes/ragflow.ts` (+ `ragflow.test.ts`, `ragflow-fake.ts`, `rehearsal-ragflow.ts`, `rehearsal-ragflow-server.ts`, `rehearsal-ragflow.test.ts`)
- `docs-search.ts`: the RAGFlow dispatch branch and `hindsight` fallback wiring keyed to it; keep the LightRAG path and `lightragFallback`
- `docs-ingest.ts`: the RAGFlow ingest branch, `recordKey` non-prefixed keys, `deleteDocuments`/`pollParseStatus` RAGFlow imports; keep `lightragRecordKey` and the LightRAG path
- `service.ts`: `ragflowFetch` wiring, `config.ragflow`, dataset-list cache keyed on RAGFlow datasets
- `config.ts`: `DOCS_BACKENDS` narrows to `["lightrag"]`, `resolveDocsBackend` reach rule simplifies, `loadRagflowRetrievalSettings` (vector weight / rerank_id) goes with the plane
- `railway.ts`: RAGFlow URL/key constants and the dataset list source
- `flag-registry.ts` + `.env.example` + regenerated `docs/config-reference.md`: `RAGFLOW_URL`, `RAGFLOW_API_KEY`, `RAGFLOW_DATASET_ID`, `RAGFLOW_MCP_URL` rows and lines
- scripts: `docs-smoke.ts` RAGFlow fixture arms (`RAGFLOW_FIXTURE_SCRIPT`), `parity-check.ts` if RAGFlow-keyed
- store-lock / scan expectations that name RAGFlow imports; `docs/data-planes.md` + `docs/docs-plane.md` plane sections
- Storage deletion is the operator's step; nothing in this commit deletes anything.

## Notes for the next operator/agent

- Part B has never run against a real LightRAG: the rehearsal answers come from the operator's Task 10 run, fed back through `bun scripts/docs-migrate.ts --archive <dir> --answers <answers.json>` (full ordered gate) or directly into `parityGate`.
- The archived per-URL versions are metadata the migration carries forward, not data the replay renumbers — `docs-migrate --apply` writes them onto the `lightrag::` keys so Part A's triple compares equal and post-cutover replacements increment from the right generation.
- The `git show` page-hash check reports (never silently accepts) pages whose bytes changed since ingest; a real archive with such pages should reconcile the commits before apply, not widen the gate.


## Review-round addendum (2026-11-10, Greptile rounds 2-5 on PR #214)

Five apex-tier review rounds drove four fix rounds; each round's findings were fixed and tested:

- Round 2 (a76dc918 review): cooldown scope split — gate refusals ride the configured 24 h cooldown, transient plane faults ride a short 30 s backoff window; both reset on content change; an empty filtered attempt set notes nothing. Validated archive parses replaced the last unchecked `JSON.parse(...) as T` casts (ratchet baseline stays 45/26).
- Round 3 (157d1c4 review): the events emit never throws — a lost or timed-out POST can no longer discard upload progress; the replay accepts exactly the paths each dataset's archive records (their top-level directory as the ingest root), never the substrate-wide defaults.
- Round 4 (37a8da19 review): per-dataset roots distinguish shared directory segments (`docs/`) from lone top-level files (`README.md`); each archived commit replays through batchPagesForIngest (one commit can exceed the 5 MB call limit); the RAGFlow document listing paginates past the first page.
- Round 5 (d2e82d42 review): roots derive from each archived path's directory part; replay selects each source URL's current copy (the archive lists superseded copies first), so old bodies never land under a sibling's version; a rehearsal apply never POSTs even when an endpoint is configured.
- Round 6 finding: the Part A approval is now bound to the loaded archive's digest (dataset ids/names plus record keys) — a stale or foreign Part A summary can no longer authorize a replay; an unreadable saved state refuses the apply instead of being overwritten (round 2 finding).

Still operator-gated: the live SC6 sequence and criteria 2/6 + LightRAG graph/hybrid modes (see above).
