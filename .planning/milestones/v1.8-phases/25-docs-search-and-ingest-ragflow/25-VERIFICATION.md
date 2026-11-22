---
phase: 25-docs-search-and-ingest-ragflow
verified: 2026-11-18T12:22:31Z
status: gaps_found
score: 1/3 truths verified fully; criterion 2 verified in code with live proof operator-gated; criterion 1 WAIVED by owner decision (dataset scope superseded, not met); criterion 3 UNCERTAIN (WARNING)
covered_files: [".planning/milestones/v1.3-phases/25-docs-search-and-ingest-ragflow/25-01-PLAN.md", ".planning/milestones/v1.3-phases/25-docs-search-and-ingest-ragflow/25-01-SUMMARY.md", ".planning/milestones/v1.3-phases/25-docs-search-and-ingest-ragflow/25-02-PLAN.md", ".planning/milestones/v1.3-phases/25-docs-search-and-ingest-ragflow/25-02-SUMMARY.md", ".planning/milestones/v1.3-phases/25-docs-search-and-ingest-ragflow/25-03-PLAN.md", ".planning/milestones/v1.3-phases/25-docs-search-and-ingest-ragflow/25-03-SUMMARY.md", "docs/data-planes.md", "docs/docs-search-ingest.md", "packages/cli/src/docs.ts", "packages/mcp-server/src/docs-datasets.ts", "packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/planes/lightrag.ts", "packages/mcp-server/src/planes/ragflow.ts"]
covered_digest: "v3:sha256:af8f520f158f205751c3a3a36566eb16ee1b33005489506e56a49ff8fed75c1a"
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "docs_search queries explicit dataset ids and returns at most 10 results (criterion 1)"
    status: waived
    reason: "The live docs plane is LightRAG (backend `lightrag`, selected when LIGHTRAG_URL is set). LightRAG exposes one knowledge base per server and its client accepts-and-ignores `datasetIds` on the wire, so retrieval is not scoped to explicit dataset ids. The dataset ids only key the search pins and the note payload. The explicit-scope clause holds only on the RAGFlow path, whose service was deleted on 2026-10-25 (ROADMAP Phase 46 operator re-scope; docs/data-planes.md). The criterion text was not changed by that re-scope."
    artifacts:
      - path: "packages/mcp-server/src/planes/lightrag.ts"
        issue: "retrieve path ignores datasetIds (accepted-ignored, lines ~466-478); no dataset scope is sent on the wire"
      - path: "packages/mcp-server/src/docs-search.ts"
        issue: "searchDocsLightrag resolves readable datasets, but passes their ids to a retriever that ignores them (lines ~1050-1120)"
    missing:
      - "Owner decision: either accept the dataset-scope clause as superseded for the LightRAG single-knowledge-base plane (record it as an override or as accepted debt), or re-scope criterion 1 to the LightRAG model and cover it with a test"
      - "If scope is required on the live plane: a LightRAG workspace or per-dataset plane design, which is not in the codebase today"
deferred: []
advisory: []
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: "G1 to G4 live gates from docs/runbooks/docs-proof.md: reachability and version probe, dataset discovery, a real ingest of one page, and a real docs_search served to a headless session"
    expected: "Each gate's proof read in the runbook passes against the deployed plane; a real docs_search reply carries untrusted framing, at most 10 citations with snippets of at most 1,200 characters, and a note event listing the URLs"
    why_human: "Requires the deployed LightRAG service and an operator-approved window; the codebase cannot reach it"
  - test: "Agent-skills refresh evidence: confirm the substrate-skills-sync fast-forward is live and that the merge trigger records a new agent-skills version"
    expected: "Without sync evidence, agent-skills serves its pinned version with a single `skills-sync-not-live` warning (docs-datasets.ts); with it, the next fast-forward records a version"
    why_human: "Depends on the live skills-sync unit on the VPS; the degraded path is verified only by code and tests"
  - test: "Decide the criterion 3 dataset layout for the LightRAG plane"
    expected: "Owner states whether one workspace per dataset (agent-substrate, programming-desk, agent-skills, corpus) or one shared workspace is the target; docs/data-planes.md then matches the decision"
    why_human: "docs/data-planes.md says the layout is not decided for LightRAG; this is a design decision, not a code check"
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: gaps_found
---

# Phase 25: Docs search and ingest (RAGFlow) — Verification Report

**Phase Goal:** Agents answer docs questions from RAGFlow with citations, through the substrate only, and no secret or unsourced page is ingested.
**Verified:** 2026-11-18T12:22:31Z
**Status:** gaps_found
**Re-verification:** No — initial verification at this candidate (branch `gsd/autonomous-rerun`, HEAD 357d6b15)

**Scope note on the goal.** The goal names RAGFlow as the answer source. RAGFlow was deleted on 2026-10-25 and LightRAG has been the only docs plane since the 2026-10-28 cutover (ROADMAP Phase 46 operator re-scope; `docs/data-planes.md`). The RAGFlow code is still present and selected only when `LIGHTRAG_URL` is unset. This report checks each criterion against the code as it runs in production (LightRAG), and notes where the criterion held only on the RAGFlow path.

The phase's own record is archived at `.planning/milestones/v1.3-phases/25-docs-search-and-ingest-ragflow/25-VERIFICATION.md` (rehearsal scope, 2026-10-11). It was not used as evidence. This file was written to the expected active path, `.planning/phases/25-docs-search-and-ingest-ragflow/`.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `docs_search` (MCP and `POST /docs/search`) queries explicit dataset ids, returns at most 10 results with title, source URL, heading path, commit, redacted snippet of at most 1,200 characters, score and ids; the reply is marked untrusted; one event lists the returned URLs; an error yields an empty result with a reason | WAIVED (owner decision; dataset-scope clause superseded by the LightRAG plane design, not met) | Met on the output shape: `SNIPPET_CAP = 1200` and `redactValue(...).slice(0, SNIPPET_CAP)` (`docs-search.ts:74, 508`); `slice(0, 10)` on the LightRAG path (`docs-search.ts` ~line 1094); `UNTRUSTED_DOCS_NOTICE` returned in the reply; `note` event with `urls`, `count`, `dataset_ids` (`docs-search.ts` ~line 1125); `failed()` returns empty chunks with a reason; MCP tool `docs_search` (`mcp.ts:1576`) and route `POST /docs/search` (`server.ts:1631`). **Not met on the live plane:** `planes/lightrag.ts` ~466-478 documents `datasetIds` as "accepted-ignored" (one knowledge base per server), so retrieval is not scoped to explicit dataset ids. Dataset ids key only the pins and the note payload. |
| 2 | `docs_ingest` (MCP, `POST /docs/ingest`, `substrate docs ingest`) redacts before upload, strips remote images, is idempotent by content hash, and refuses a page without a source URL, outside the roots, over the size caps, or from an unauthenticated caller | ✓ VERIFIED (code) — live G3 operator-gated | Refusals `no-source-url`, `outside-roots`, `page-too-large`, `call-too-large`, `secret-findings`, `unauthenticated` (`docs-ingest.ts` lines ~706-716, ~828; `INGEST_PAGE_MAX_BYTES = 1_000_000`, `INGEST_CALL_MAX_BYTES = 5_000_000` at ~77-79). Remote-image strip via `stripRemoteImages` from `@substrate/corpus` (`docs-ingest.ts:709`). Shared gate runs before both backends (`docs-ingest.ts` ~844-862). LightRAG branch `ingestDocsLightrag` carries the seen/locks/sha dedupe (~1432-1466). CLI `substrate docs ingest` (`packages/cli/src/docs.ts`); routes `server.ts:1683`, `:318-319`; MCP `mcp.ts:1631`. Targeted tests: `docs-ingest.test.ts`, `docs-search.test.ts`, `docs-datasets.test.ts` — 166 pass, 0 fail (ran `bun test` on the three files). |
| 3 | The datasets in `docs/data-planes.md` exist and refresh as stated (`agent-substrate` on merge, `agent-skills` after each skills-sync fast-forward, `programming-desk`, one per product), keeping the last five versions | ? UNCERTAIN (WARNING) | Registry and triggers exist: `DATASET_TRIGGERS` (`docs-datasets.ts:28-37`) lists agent-substrate, programming-desk, agent-skills, kanbanos, desklanes, clippyos, auctioning, corpus; retention `DATASET_VERSION_RETENTION = 5` used in `recordVersion` (`docs-datasets.ts:39-40, 61-65`); merge trigger route `POST /docs/merge-trigger` (`server.ts:320`). The agent-skills path degrades to a pinned version with a `skills-sync-not-live` warning until the skills-sync unit produces evidence (`docs-datasets.ts:431, 480`). `docs/data-planes.md` labels its dataset table "historical" and states that the LightRAG workspace layout is not decided. Live refresh is not verified. |

**Score:** 1/3 truths fully verified (criterion 2, with live proof open); criterion 1 WAIVED by owner decision; criterion 3 UNCERTAIN.

### Deferred Items

None. Criterion 1's dataset-scope gap is not addressed by a later phase in ROADMAP.md. Phase 46 covers the RAGFlow→LightRAG answer source, not dataset scope.

### Advisory (New Scope, Unevidenced)

None. This was an initial verification, not a re-verification.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/docs-search.ts` | Substrate-only search, cited shape, untrusted framing, 10-result cap, 1,200 snippet cap | ✓ VERIFIED (shape) / ✗ scope | 1,170 lines; shape present; dataset scope is a no-op on the LightRAG path |
| `packages/mcp-server/src/docs-ingest.ts` | Six refusals, redaction, remote-image strip, hash idempotency | ✓ VERIFIED | 1,648 lines; refusal reasons and caps present; tests pass |
| `packages/mcp-server/src/docs-datasets.ts` | Name resolve, triggers, five-version retention, skills-sync degradation | ✓ VERIFIED (code) | 493 lines; retention 5; `skills-sync-not-live` path present |
| `packages/mcp-server/src/planes/lightrag.ts` | Live docs plane client | ✓ VERIFIED (wiring) | Dataset ids accepted-ignored by design (single knowledge base) |
| `packages/mcp-server/src/planes/ragflow.ts` | RAGFlow client (retired plane) | ⚠️ RETIRED | Still selected only when `LIGHTRAG_URL` is unset; no live service |
| `packages/cli/src/docs.ts` | `substrate docs ingest` HTTP client | ✓ VERIFIED | Posts to `POST /docs/ingest`; refuses on a VM guest before posting |
| `docs/data-planes.md` | Dataset list and refresh triggers | ⚠️ HISTORICAL | Labeled historical; LightRAG workspace layout undecided |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `mcp.ts` `docs_search` | `searchDocs` (`docs-search.ts:711`) | `scopedDocsRefusal` → search | ✓ WIRED | `mcp.ts:1576-1598` |
| `server.ts` `POST /docs/search` | `searchDocs` | route handler | ✓ WIRED | `server.ts:1631` |
| `searchDocsLightrag` | LightRAG retriever with dataset ids | `retrieve(lightrag, q, ids, fetch)` | ✗ NOT_SCOPED | Ids accepted-ignored in `planes/lightrag.ts` ~466-478 |
| `docs_ingest` / `POST /docs/ingest` | `checkIngestPage` gates | `docs-ingest.ts` ~844-862 | ✓ WIRED | Gates before backend branch |
| `POST /docs/merge-trigger` | dataset refresh + version record | `docs-datasets.ts:413` `recordVersion` | ✓ WIRED | Test run logs show `v1 recorded` and `failed — checkout-unreadable` paths |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| docs_search reply | `chunks` | LightRAG `POST /query` via `retrieveForSearchLightrag` | Yes, on the live plane (not run here) | ⚠️ NOT_EXERCISED live |
| docs_ingest reply | `results` | LightRAG upload via `ingestDocsLightrag` | Yes in code; not exercised live | ⚠️ NOT_EXERCISED live |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Search, ingest, and dataset gates pass their targeted tests | `bun test packages/mcp-server/src/docs-ingest.test.ts packages/mcp-server/src/docs-datasets.test.ts packages/mcp-server/src/docs-search.test.ts` | 166 pass, 0 fail, 715 expect() calls | ✓ PASS |
| Dataset scope is a no-op on the live plane | Static read of `planes/lightrag.ts` ~466-478 | `datasetIds` "accepted-ignored" | ✗ FAIL (criterion 1 clause) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` files exist in this repository. Step 7c: SKIPPED (no probes declared or discovered).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| DOCS-01 | 25-01 | docs_search cited, substrate-only retrieval over explicit dataset ids | ✗ BLOCKED (dataset scope on the live plane) | See criterion 1 |
| DOCS-02 | 25-02 | docs_ingest with six refusals, redaction, idempotency | ✓ SATISFIED (code); live proof open | See criterion 2 |
| DOCS-03 | 25-03 | Dataset lifecycle, five-version retention, refresh triggers | ? NEEDS HUMAN (layout decision and live skills-sync) | See criterion 3 |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/docs-search.ts` | ~1125 | Dataset ids reported as "searched" in the note event, though the plane does not scope on them | ⚠️ Warning | The event's `dataset_ids` can mislead a reader into thinking the search was scoped |
| `packages/mcp-server/src/planes/ragflow.ts` | — | Retired plane code kept and selectable | ℹ️ Info | Dead path in production; the `resolveDocsBackend` fallback to `ragflow` when `LIGHTRAG_URL` is unset would fail closed only through `ragflow-not-configured` |

### Human Verification Required

#### 1. G1 to G4 live gates

**Test:** Run each gate in `docs/runbooks/docs-proof.md` against the deployed LightRAG plane in an approved window: reachability and version probe, dataset discovery, one real ingest, one real docs_search served to a headless session.
**Expected:** Each gate's proof read passes; a real docs_search reply has the untrusted framing, at most 10 citations, snippets of at most 1,200 characters, and a note event listing the URLs.
**Why human:** Needs the deployed LightRAG service and operator approval. Not run here.

#### 2. Agent-skills refresh

**Test:** Confirm the substrate-skills-sync fast-forward is live and that the next merge trigger records a new `agent-skills` version.
**Expected:** With sync evidence, the version is recorded; without it, the pinned version serves with one `skills-sync-not-live` warning.
**Why human:** Depends on the live VPS skills-sync unit.

#### 3. Dataset layout decision for criterion 3

**Test:** Owner states whether LightRAG uses one workspace per dataset or one shared workspace.
**Expected:** `docs/data-planes.md` is updated to match the decision.
**Why human:** `docs/data-planes.md` leaves this undecided; it is a design decision.

## Gaps Summary

**Blocker (criterion 1, dataset scope).** The criterion requires `docs_search` to query explicit dataset ids. On the plane that serves production (LightRAG), the dataset ids are accepted and ignored. That is by design for a single knowledge base, so the criterion cannot hold on the live plane as written. It held only on the RAGFlow path, which has been removed. Resolution needs an owner decision: waive the clause as superseded by the Phase 46 re-scope (recorded as an override or accepted debt), or re-scope it to LightRAG and test that. Until then, the note event's `dataset_ids` should not be read as proof of scoped retrieval.

**Waiver (criterion 1, dataset scope).** Owner decision: the dataset-scope clause of criterion 1 is waived. It is superseded by the current plane design, not met. LightRAG runs one knowledge base per server and its client accepts and ignores `datasetIds`, so retrieval on the live plane is not scoped to explicit dataset ids. The explicit-scope clause held only on the RAGFlow path, which was removed on 2026-10-25. The waiver does not count as a pass for that clause; the other clauses of criterion 1 stay verified in code.

**Warning (criterion 3, dataset layout).** Dataset registry, triggers and five-version retention exist in code and pass targeted tests. The layout on the LightRAG plane is undecided per `docs/data-planes.md`, and live skills-sync evidence is absent. Routed to human decision.

**Not a gap (live proof).** G1 to G4 are operator-gated by the phase's own proof plan and by the Phase 46 approvals. They are listed under human verification, not as gaps.

---

_Verified: 2026-11-18T12:22:31Z_
_Verifier: Claude (gsd-verifier)_
