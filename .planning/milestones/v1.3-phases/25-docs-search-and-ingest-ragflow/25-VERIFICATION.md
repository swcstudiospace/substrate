---
phase: 25-docs-search-and-ingest-ragflow
verified: 2026-11-12T08:26:02Z
status: human_needed
score: 7/9 must-haves verified (rehearsal scope); live G1-G4 operator-gated, not run
covered_files: ["packages/cli/src/docs.ts", "packages/mcp-server/src/docs-datasets.test.ts", "packages/mcp-server/src/docs-datasets.ts", "packages/mcp-server/src/docs-ingest.test.ts", "packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/docs-search.test.ts", "packages/mcp-server/src/docs-search.ts", "packages/mcp-server/src/mcp.ts", "packages/mcp-server/src/observe.ts", "packages/mcp-server/src/planes/ragflow.test.ts", "packages/mcp-server/src/planes/ragflow.ts", "packages/mcp-server/src/ragflow-fake.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/store-lock.test.ts", "docs/data-planes.md", "docs/docs-search-ingest.md", "docs/runbooks/docs-proof.md", ".planning/milestones/v1.3-phases/25-docs-search-and-ingest-ragflow/25-01-PLAN.md", ".planning/milestones/v1.3-phases/25-docs-search-and-ingest-ragflow/25-01-SUMMARY.md", ".planning/milestones/v1.3-phases/25-docs-search-and-ingest-ragflow/25-02-PLAN.md", ".planning/milestones/v1.3-phases/25-docs-search-and-ingest-ragflow/25-02-SUMMARY.md", ".planning/milestones/v1.3-phases/25-docs-search-and-ingest-ragflow/25-03-PLAN.md", ".planning/milestones/v1.3-phases/25-docs-search-and-ingest-ragflow/25-03-SUMMARY.md"]
covered_digest: "v3:sha256:6091bbe9c8ec03f68d7c62a24bee8f9f687a53c453e8274786476c6264051fa9"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: "9/9 must-haves rehearsal-proven; live G1-G4 OPERATOR-GATED"
  previous_verified: 2026-10-11T02:10:00Z
  gaps_closed: []
  gaps_remaining: []
  regressions: []
  note: "Previous report wrote status passed while roadmap criteria SC3 and the live proofs were operator-gated; this run sets human_needed."
advisory:
  - finding: "Anonymous POST /docs/ingest over REST returns 401 before auditedRest runs, so that refusal is not written as a fail-closed audit event (the service-level refusal is audited)"
    category: security
    reason: "Comment at server.ts:1673 says 'Audited fail-closed under the tool's own name'; the early 401 at server.ts:1674-1676 returns first. Not a must-have; no test in this run pins the REST audit row."
    evidence_status: "none provided"
human_verification:
  - test: "G1 - Live RAGFlow (retired, superseded by LightRAG) reachability and version probe (docs/runbooks/docs-proof.md)"
    expected: "Deployed RAGFlow (retired, superseded by LightRAG) answers; retrieval response matches the U-01 full or minimal shape; U-02 path confirmed; no writes"
    why_human: "Requires the live RAGFlow (retired, superseded by LightRAG) plane in an operator-approved window; not run by this verifier"
  - test: "G2 - Dataset discovery and creation (roadmap SC3, DOCS-03)"
    expected: "agent-substrate, agent-skills, programming-desk and one dataset per product exist by name; creation only on miss; refresh keeps last five versions on the live plane"
    why_human: "Live dataset state cannot be read from the repo; rehearsal covers the logic against the fake only"
  - test: "G3 - Real ingest with planted-secret refusal and real-page round-trip (roadmap SC2)"
    expected: "Planted secret refused with rule names only; real page uploads, parses, and its U-03 metadata reads back"
    why_human: "Writes to a live RAGFlow (retired, superseded by LightRAG) dataset; operator approval required"
  - test: "G4 - Headless session answers a docs question with a docs_search source URL (roadmap SC1 proof)"
    expected: "Session cites a URL returned by docs_search, readable back from its note event"
    why_human: "Needs a live headless agent session and the live plane"
---

# Phase 25: Docs search and ingest (RAGFlow (retired, superseded by LightRAG)) Verification Report

**Phase Goal:** Agents answer docs questions from RAGFlow (retired, superseded by LightRAG) with citations, through the substrate only, and no secret or unsourced page is ingested.
**Verified:** 2026-11-12T08:26:02Z
**Status:** human_needed
**Re-verification:** Yes — prior report (2026-10-11, status passed) re-run from source

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | docs_search returns ≤10 results with title, source_url, heading_path, commit, redacted snippet ≤1,200 chars, score, ids (SC1) | ✓ VERIFIED | `docs-search.ts:79-87` SearchCitation fields; `SNIPPET_CAP = 1200` at `docs-search.ts:74`, applied at `docs-search.ts:508`; `docs-search.test.ts` shape/cap tests pass |
| 2 | Reply marked untrusted; one note event lists returned URLs; error yields empty result + reason | ✓ VERIFIED | `UNTRUSTED_DOCS_NOTICE` `docs-search.ts:68-70`; `urls: chunks.map(...)` `docs-search.ts:843`; `failed()` returns `degraded: true, reason` `docs-search.ts:437-442`; tests pass |
| 3 | Retrieval always carries explicit dataset_ids with page_size ≤10 on the wire (anti-pattern gate) | ✓ VERIFIED | `planes/ragflow.ts:238-241` throws before network on empty dataset_ids; `Math.min(..., MAX_RETRIEVAL_PAGE_SIZE)` at `:241`; `ragflow-fake.ts` refuses retrieval without dataset_ids; `planes/ragflow.test.ts` "every call carries dataset_ids and clamps page_size to 10" passes |
| 4 | docs_ingest redacts before upload, strips remote images, idempotent by content hash (SC2) | ✓ VERIFIED | Pre-upload scan `docs-ingest.ts:558-570`; remote-image strip via `stripRemoteImages` (`docs-ingest.ts:41`); idempotency keyed by dataset+source_url+sha (`docs-ingest.ts:485-510`); `docs-ingest.test.ts` passes |
| 5 | Refuses no source URL, outside roots, over size caps, unauthenticated caller, VM guest (SC2) | ✓ VERIFIED | Refusal reasons `docs-ingest.ts:706-716` (`no-source-url`, `outside-roots`, `page-too-large`, `call-too-large`, `secret-findings`); `docs-ingest.ts:828-829` (`unauthenticated`, `vm-guest`); test "refuses unauthenticated callers and VM guests before any network call" passes with 0 fake requests |
| 6 | Substrate-only door: no RAGFlow (retired, superseded by LightRAG) MCP wiring, no out-of-package client import, no committed credential | ✓ VERIFIED | `store-lock.test.ts` passes in this run; `planes/ragflow` is imported only under `packages/mcp-server/src` |
| 7 | Datasets resolve by name, create on miss, keep last five versions with monotonic numbers (SC3, rehearsal) | ✓ VERIFIED (fake) | `docs-datasets.ts:40` `DATASET_VERSION_RETENTION = 5`; `recordVersion` at `:61`; `docs-datasets.test.ts` passes. Live existence is G2 below |
| 8 | agent-skills refresh degrades explicitly (skills-sync-not-live warning, pin-aged serve) | ✓ VERIFIED | Degradation in `docs-datasets.ts` and pin-age path in `docs-search.ts`; `docs-datasets.test.ts` passes |
| 9 | Live G1–G4 proofs: live probe, live dataset state, real ingest, served search | ? UNCERTAIN (human) | Operator-gated per `docs/runbooks/docs-proof.md`; not run; see Human Verification Required |

**Score:** 7/9 truths verified (rehearsal); 2 require the live operator gate. `behavior_unverified: 0`: each behavior-dependent truth (idempotency, retention, degradation, refusals) has a passing named test in the run below.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planes/ragflow.ts` | RAGFlow (retired, superseded by LightRAG) client, explicit dataset_ids, clamp | ✓ VERIFIED | 576 lines; reads RAGFLOW_URL / RAGFLOW_API_KEY only (`:65-72`) |
| `packages/mcp-server/src/docs-search.ts` | Citation-shaped search | ✓ VERIFIED | 1170 lines; later LightRAG and Phase 72 changes share this file; phase-25 paths pass |
| `packages/mcp-server/src/ragflow-fake.ts` | Recording fake, refuses no-dataset_ids | ✓ VERIFIED | 497 lines |
| `packages/mcp-server/src/docs-ingest.ts` | Six refusals, redaction, hash idempotency | ✓ VERIFIED | 1648 lines; refusals at `:706-716`, `:828-829` |
| `packages/mcp-server/src/docs-datasets.ts` | Dataset lifecycle, retention, degradation | ✓ VERIFIED (fake) | 493 lines |
| `packages/cli/src/docs.ts` | `substrate docs ingest` | ✓ VERIFIED | 217 lines; command documented in `cli/src/index.ts:14`; `docs.test.ts` green in this run |
| `docs/runbooks/docs-proof.md` | G1–G4 gated runbook | ✓ VERIFIED | Present; operator-gated steps unexecuted |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| docs_search MCP tool | retrieveChunks | `mcp.ts:1574-1603` → docs-search → planes/ragflow | ✓ WIRED | Tool registered; scopedDocsRefusal gate before search |
| POST /docs/search | searchDocs | `server.ts:1621-1659` | ✓ WIRED | Same service call as MCP; audited via auditedRest |
| POST /docs/ingest | ingestDocs | `server.ts:1673-1676` (401 for anonymous, before audit) → service | ⚠️ PARTIAL | Wired; anonymous refusal not audited on the REST path (advisory) |
| observe / policy | docs_search, docs_ingest | `observe.ts:674-675`; `audit/src/policy.ts:29,115` | ✓ WIRED | docs_ingest fail-closed; docs_search fail-open |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| docs-search reply | `chunks` | RAGFlow (retired, superseded by LightRAG) retrieval via planes client | Fake only in this run | ✓ FLOWING (rehearsal); live unverified |
| docs-datasets versions | `DatasetVersion[]` | create/list against RAGFlow (retired, superseded by LightRAG) | Fake only | ✓ FLOWING (rehearsal) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Plane client, search, ingest, datasets, store-lock, CLI docs suites | `bun test packages/mcp-server/src/planes/ragflow.test.ts packages/mcp-server/src/docs-search.test.ts packages/mcp-server/src/docs-ingest.test.ts packages/mcp-server/src/docs-datasets.test.ts packages/mcp-server/src/store-lock.test.ts packages/cli/src/docs.test.ts` | 229 pass, 0 fail, 913 expect() calls, 25.5 s | ✓ PASS |
| Probe scripts | `find scripts -path '*/tests/probe-*.sh'` | none present | SKIP (no probes declared) |

Not run: full `bun test`, `bunx tsc --noEmit`, pytest, `check:phase-close`. Not run: any live RAGFlow (retired, superseded by LightRAG) call (G1–G4).

### Probe Execution

No probes declared or present for this phase.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| DOCS-01 | 25-01 | docs_search contract | ✓ SATISFIED (rehearsal) | Truths 1–3 |
| DOCS-02 | 25-02 | docs_ingest gates | ✓ SATISFIED (rehearsal) | Truths 4–6 |
| DOCS-03 | 25-03 | Datasets exist and refresh | ? NEEDS HUMAN (live) | Truths 7–8; G2 |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (all covered files) | — | TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER grep | ℹ️ Info | No matches |
| server.ts | 1673-1676 | Anonymous ingest 401 returns before audit | ⚠️ Warning | Advisory only; refusal still enforced |

### Human Verification Required

### 1. G1 — Live RAGFlow (retired, superseded by LightRAG) reachability and version probe
**Test:** Follow `docs/runbooks/docs-proof.md` G1 against the deployed RAGFlow (retired, superseded by LightRAG).
**Expected:** Reachable; response matches U-01 shape; U-02 path confirmed; no writes.
**Why human:** Live plane, operator-approved window.

### 2. G2 — Dataset discovery and creation (SC3)
**Test:** Run the G2 name-matched dataset list; create only on miss.
**Expected:** agent-substrate, agent-skills, programming-desk and one per product exist by name; refresh keeps last five.
**Why human:** Live dataset state.

### 3. G3 — Real ingest with planted-secret refusal (SC2)
**Test:** Ingest a planted-secret page (expect refusal with rule names only) and a real page; read back U-03 metadata.
**Expected:** Refusal; real page round-trips.
**Why human:** Writes to a live dataset.

### 4. G4 — Served search readable back (SC1 proof)
**Test:** Headless session asks a docs question; confirm it cites a docs_search URL readable from its event.
**Expected:** Source URL matches a docs_search result.
**Why human:** Live agent session.

## Gaps Summary

No gaps found. All rehearsal-scope truths verified against code and passing tests. Status is `human_needed` because roadmap SC3 and the live proofs (G1–G4) are operator-gated and were not run. No `25-SECURITY.md` exists for this phase, so no threats_open check was possible; the threat register in 25-01-PLAN.md is mitigated per the summaries but not independently audited here.

---

_Verified: 2026-11-12T08:26:02Z_
_Verifier: Claude (gsd-verifier)_
