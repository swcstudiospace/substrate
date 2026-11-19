---
phase: 34-invalid-write-round-trip
verified: 2026-11-18T12:22:41Z
status: human_needed
score: 1/2 truths verified (1 present and wired, behavior not exercised at HEAD)
behavior_unverified: 1
overrides_applied: 0
covered_files: [".planning/milestones/v1.4-phases/34-invalid-write-round-trip/CONTEXT.md", ".planning/milestones/v1.4-phases/34-invalid-write-round-trip/PLAN.md", ".planning/milestones/v1.4-phases/34-invalid-write-round-trip/SUMMARY.md", "docs/memory-governance.md", "packages/mcp-server/src/invalid-write-roundtrip.test.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/skills/request.ts"]
covered_digest: "v3:sha256:48b224c3c91f45bf5eb693b267ea2e0acc77a0fb7b18f459916b6c40a5ec53b6"
behavior_unverified_items:
  - truth: "Before-and-after content checks prove nothing was persisted or mutated on a refusal, for memory records and skills registry rows (Postgres-backed suites)"
    test: "SUBSTRATE_TEST_PG_URL=<throwaway postgres:16 URL> bun test packages/mcp-server/src/invalid-write-roundtrip.test.ts, run alone in packages/mcp-server"
    expected: "All memory and skills refusal cases pass with storedState digests and registryState unchanged on every refusal; the file reports 72 pass, 0 fail, 0 skip"
    why_human: "The memory and skills suites skip without a Postgres URL, and no Postgres server runs on this host. The only live pass is the 2026-10-21 run on an earlier commit (be7bcfe); the test file has changed since (LightRAG case, ClientTransport harness), so HEAD has not been observed passing"
human_verification:
  - test: "Run the round-trip suite at HEAD (357d6b15) against a throwaway Postgres 16 with SUBSTRATE_TEST_PG_URL set, from packages/mcp-server: bun test src/invalid-write-roundtrip.test.ts"
    expected: "72 pass, 0 fail, 0 skip. Memory refusals return 403 (shape, policy) or 400 (non-object body) with storedState unchanged; skills propose and approve refusals return 400 with storedState and registryState unchanged"
    why_human: "Needs a live Postgres. This verifier had none and does not run the live stack"
---

# Phase 34: Invalid-write round trip Verification Report

**Phase Goal:** Every client-input write surface refuses an invalid payload, and nothing is persisted when it does.
**Verified:** 2026-11-18T12:22:41Z
**Status:** human_needed
**Re-verification:** No (the earlier record is the archived 2026-10-21 verification)

**Record location:** the phase is archived in milestone v1.4. Its original verification is `.planning/milestones/v1.4-phases/34-invalid-write-round-trip/34-VERIFICATION.md` (status passed, run against be7bcfe). This record is written to the expected phase directory for the current HEAD (357d6b15). The SUMMARY.md and PLAN.md cited below are the archived copies.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | Memory, skill, and docs writes refuse an invalid payload with the surface's documented error status | ✓ VERIFIED | Route code: `POST /memory` answers 400 for a non-object body before the audit (`packages/mcp-server/src/server.ts:1070-1085`) and 403 when the gate denies a bad shape (`docs/memory-governance.md:467-469` lists 403 "denied by policy" and 400 "not a JSON object"). `POST /skills/propose` answers 400 from `proposalBodyProblem` (`server.ts:2195-2219`). `POST /skills/approve` answers 400 from `approvalBodyProblem` (`server.ts:2224-2240`). `POST /docs/ingest` answers 400 for a non-object body, a missing dataset, or an invalid page (`server.ts:1683-1715`). The test file asserts each of these: memory 200 control, 403, 400 (`invalid-write-roundtrip.test.ts:424`, `:440`, `:456`); skills approve 400 (the `POST /skills/approve` describe, `invalid` and `NON_OBJECT_BODIES` loops). The docs suite ran here and passed (see Behavioral Spot-Checks). Memory and skills status assertions were not re-run at HEAD (see Truth 2) |
| 2 | Before-and-after checks of stored content prove nothing was persisted or mutated on a refusal; row counts are an extra check; isolated namespace per surface | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (memory and skills); ✓ VERIFIED (docs) | Harness is substantive: `storedState` compares per-table row count and md5 digest of every row (`invalid-write-roundtrip.test.ts:355-362`); `registryState` reads `pr_number, state, decided_by, decided_at` (`:365`); `storedDocs` deep-copies uploads with metadata, plane documents and the state file (`:785-787`). Every refusal in the memory, skills propose, and skills approve sections calls these before and after. Namespace is `ut-iwr-<RUN>` marker, cleaned in `afterAll`. The docs section passed here: 21 tests (`storedDocs` before/after for REST and MCP refusals, and the LightRAG batch case with zero LightRAG requests and a null state file) ran green. The memory and skills sections need `SUBSTRATE_TEST_PG_URL`, which is unset here, and no Postgres server is available, so those digests were not observed passing at HEAD. The live pass on 2026-10-21 (`34-VERIFICATION.md` archived, 71 pass on be7bcfe) predates the current test file and server code |

**Score:** 1/2 truths verified (1 present-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/invalid-write-roundtrip.test.ts` | Round-trip suite for memory, skills, docs (REST and MCP) | ✓ VERIFIED | 940 lines. Memory describe at `:412`, MCP memory_write later, skills propose and approve describes, docs describe with LightRAG case at the end. Substantive, not a stub |
| `packages/mcp-server/src/server.ts` | REST and MCP refusal routes with statuses | ✓ VERIFIED | Refusal branches at `:1070-1085` (memory), `:1461`/`:1486` (object-body refusals), `:1683-1715` (docs ingest), `:2195-2245` (skills propose and approve); audit ordering as the test comments describe |
| `packages/mcp-server/src/skills/request.ts` | Skill request validation | ✓ VERIFIED | Present, changed in the phase (18 lines since be7bcfe, not in the scope of this verdict) |
| `docs/memory-governance.md` | Documented `POST /memory` status table | ✓ VERIFIED | Table at `:465-470` lists 200, 202, 409, 422, 403, 503, 400 |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| round-trip test | `POST /memory`, `/skills/propose`, `/skills/approve`, `/docs/ingest` | `http.send` over real `createHttpServer` on an ephemeral port (`startHttp`, `:150`) | ✓ WIRED | Test drives the production door, not an in-process stub |
| round-trip test | MCP tools `memory_write`, `skills_propose`, `skills_approve`, `docs_ingest` | `ClientTransport` over `StreamableHTTPClientTransport` to `POST /mcp` (`ClientTransport` at `:117`, `mcp()` at `:174`) | ✓ WIRED | `refuses()` (`:201`) accepts the SDK input-validation error or a refusal body, and throws on anything else |
| docs refusals | RAGFlow fake and state file | `seeded()` stores one page, then `storedDocs` compares before and after | ✓ WIRED | Docs describe ran green here |

### Data-Flow Trace (Level 4)

Not applicable. This phase adds tests and verifies refusal branches. It renders no dynamic data.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Docs refusals (REST and MCP, invalid pages, LightRAG batch) leave uploads, documents and state file unchanged | `cd packages/mcp-server && bun test src/invalid-write-roundtrip.test.ts -t "docs ingest"` | 21 pass, 51 skip, 0 fail, 112 expect() calls (4.7 s) | ✓ PASS |
| Memory and skills refusals leave Postgres rows and digests unchanged | Same file with `SUBSTRATE_TEST_PG_URL` unset | Skipped by `describeLive`; no Postgres server on this host | ? SKIP (routed to human verification) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes are declared for this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| uplift-7 row 23: "Invalid writes are rejected, with nothing partially persisted" | 34 (archived PLAN.md) | Refusals of invalid writes persist nothing | ? NEEDS HUMAN | Docs part verified by a green run here. Memory and skills part needs the Postgres run listed in human verification |

### Anti-Patterns Found

None found in `invalid-write-roundtrip.test.ts`. The skipped-without-PG `describeLive` is a documented guard, not a stub.

### Human Verification Required

### 1. Round-trip suite at HEAD against live Postgres

**Test:** Start a throwaway Postgres 16, export `SUBSTRATE_TEST_PG_URL` to a URL for it, then run `bun test src/invalid-write-roundtrip.test.ts` from `packages/mcp-server` at commit 357d6b15.
**Expected:** 72 pass, 0 fail, 0 skip. Memory refusals return 403 or 400 with `storedState` unchanged. Skills propose and approve refusals return 400 with `storedState` and `registryState` unchanged.
**Why human:** Needs a live Postgres, which this verifier does not run. The 2026-10-21 pass was on an earlier commit.

## Gaps Summary

No gaps. Nothing the code or test files show is missing or stubbed. Both criteria have implementation and assertions in place. The status is `human_needed` because the Postgres-backed half of criterion 2 is not observed passing at HEAD. This is not a defect report. The docs half of criterion 2 and all the status-code checks are either observed passing here or confirmed by reading the route code.

Unrelated: the worktree has an untracked `.planning/phases/51-enterprise-unified-resource-fabric/` directory. It was not touched.

---

_Verified: 2026-11-18T12:22:41Z_
_Verifier: Claude (gsd-verifier)_
