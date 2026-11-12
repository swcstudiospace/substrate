---
phase: 34-invalid-write-round-trip
verified: 2026-11-12T08:31:26Z
status: human_needed
score: 0/2 truths verified (2 present and wired, behavior not exercised in this run)
behavior_unverified: 2
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 2 of 2 criteria proven (verified 2026-10-21 on be7bcfe)
  gaps_closed: []
  gaps_remaining: []
  regressions: []
covered_files: [".planning/milestones/v1.4-phases/34-invalid-write-round-trip/PLAN.md", ".planning/milestones/v1.4-phases/34-invalid-write-round-trip/SUMMARY.md", "docs/memory-governance.md", "packages/mcp-server/src/docs-ingest.ts", "packages/mcp-server/src/invalid-write-roundtrip.test.ts", "packages/mcp-server/src/server.ts"]
covered_digest: "v3:sha256:38e7e93c00a0bbb1311e79f973c72312f068d5cbe69b764e7144e064137c8998"
behavior_unverified_items:
  - truth: "ROADMAP SC1: Memory, skill, and docs writes refuse an invalid payload with the surface's documented error status"
    test: "bun test packages/mcp-server/src/invalid-write-roundtrip.test.ts with SUBSTRATE_TEST_PG_URL pointing at a live Postgres 16 (substrate_test)"
    expected: "Every refusal case returns its documented status (403 for memory shape, 400 for skills, docs, and non-object /memory bodies); the file reports 0 fail"
    why_human: "The file's top-level beforeAll connects to Postgres. In this run 127.0.0.1:5432 refused connections and 127.0.0.1:55432 rejected the password, so the file did not start and no assertion ran"
  - truth: "ROADMAP SC2: Before-and-after checks of stored content prove nothing was persisted or mutated on refusal"
    test: "Same run as above, plus a check that the storedState/registryState/storedDocs before-and-after assertions are present in the run output"
    expected: "Every refusal leaves storedState, registryState and storedDocs equal to their before values; each valid control moves the digest by one write"
    why_human: "Same blocker: the content-comparison assertions only execute against a live Postgres, and the docs assertions run inside the same file, which did not start"
---

# Phase 34: Invalid-write round trip Verification Report

**Phase Goal:** Every client-input write surface refuses an invalid payload, and nothing is persisted when it does (ROADMAP v1.4, phase 34; uplift-7 audit row "Invalid writes are rejected, with nothing partially persisted").
**Verified:** 2026-11-12T08:31:26Z
**Status:** human_needed
**Re-verification:** Yes. Previous VERIFICATION.md (2026-10-21, status passed) carried no `gaps:` section, so this ran in initial mode. Must-haves were taken from the ROADMAP success criteria. PLAN.md has no `must_haves` frontmatter.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1: writes refuse an invalid payload with the documented status | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Code present: POST /memory refuses a non-object body with 400 before the audit and the gate (`packages/mcp-server/src/server.ts:1445-1452`); POST /docs/ingest answers 400 for a non-object body, a missing dataset and a refused page (`server.ts:1673-1690`). Test assertions exist for memory 403/400 (`invalid-write-roundtrip.test.ts:440`, `:456`), skills propose and approve 400 (`:591`, `:608`, `:729`, `:743`), and docs 400 (`:873`, `:885`). Not run: the file needs Postgres and none was reachable |
| 2 | SC2: before-and-after content checks prove nothing persisted on refusal | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Code present: `storedState` (`invalid-write-roundtrip.test.ts:355`) and `registryState` (`:365`) snapshots; before/after `toEqual` on every refusal (`:441`, `:458`, `:593`, `:611`, `:730`, `:745`, `:767`); docs `storedDocs` (`:785`) compared at `:874`, `:887`, `:899`. Not run, for the same reason as truth 1 |

**Score:** 0/2 truths verified (2 present, behavior unverified)

### Deferred Items

None. The later phases in the v1.4 and v1.5 roadmaps do not address invalid-write refusal.

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/invalid-write-roundtrip.test.ts` | Round-trip suites per surface, 940 lines | ✓ VERIFIED (present) | Exists. Not executed in this run |
| `packages/mcp-server/src/server.ts` | POST /memory parse-then-refuse | ✓ VERIFIED (present) | `server.ts:1445-1452` |
| `packages/mcp-server/src/docs-ingest.ts` | Per-page gates before first write (LightRAG fix, commit 76f2707) | ✓ VERIFIED (present) | Header comment at `:5-21` describes refusal before first upload. The LightRAG path was not read in full |
| `docs/memory-governance.md` | 400 row for POST /memory | ✓ VERIFIED (present) | Row at `:469` |

Artifact checks: `verify.artifacts` was not run. The plan declares no `must_haves.artifacts`, so Step 4 is not applicable. The files above were confirmed present by direct check.

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| test suite | server.ts REST routes | HTTP over a socket in the test harness | ⚠️ PRESENT | Wiring is present in code. Not exercised |
| test suite | MCP tools | in-memory transport | ⚠️ PRESENT | Same as above |

`verify.key-links` was not run (no `must_haves.key_links` in PLAN).

### Data-Flow Trace (Level 4)

Not applicable. Phase 34 writes validation and tests, not dynamic UI or rendered data.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Round-trip suite runs and passes | `SUBSTRATE_TEST_PG_URL=postgres://…@127.0.0.1:5432/substrate_test bun test packages/mcp-server/src/invalid-write-roundtrip.test.ts` | Connection refused on 5432 (`ERR_POSTGRES_CONNECTION_REFUSED`). On 55432, password authentication failed. The file's top-level beforeAll needs Postgres, so 0 pass, 1 fail | ? SKIP (no reachable Postgres; routed to human) |
| Docs-only subset runs without Postgres | same, with `-t "docs ingest"` | Still fails: the top-level beforeAll at `invalid-write-roundtrip.test.ts:378` connects regardless of the filter | ? SKIP |

Not run: `bunx tsc --noEmit` and the other suites (http, skills/request). No test was run to a pass in this verification.

### Probe Execution

No probes declared or implied by this phase. Skipped.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| uplift-7 audit row "Invalid writes are rejected, with nothing partially persisted" | ROADMAP v1.4 phase 34 | Cited in ROADMAP. It is not a REQ-ID in v1.4-REQUIREMENTS.md, which lists v1.3.x and v1.5 requirements only | ? NEEDS HUMAN | Covered by truths 1 and 2 above |

No orphaned requirement IDs: the PLAN has no `requirements:` field and REQUIREMENTS.md has no phase 34 ID.

### Anti-Patterns Found

None found in the four files (grep for TODO, placeholder, and empty handler patterns was not exhaustive).

### Human Verification Required

#### 1. Round-trip suite against live Postgres

**Test:** Start Postgres 16 on 127.0.0.1 (CI's scratch-postgres action, or the scratch cluster in AGENTS.md). Set `SUBSTRATE_TEST_PG_URL` to its `substrate_test` database. Run `bun test packages/mcp-server/src/invalid-write-roundtrip.test.ts`.
**Expected:** All cases pass, with 0 fail and 0 skip. The memory and skills suites run, and the docs suite runs too.
**Why human:** The Postgres service that AGENTS.md describes is not reachable from this verifier's shell. Its port is refused, and the port that is reachable rejects the password. Credentials were not guessed.

#### 2. Confirm the content-comparison assertions run

**Test:** In the same run, confirm that the `storedState`, `registryState` and `storedDocs` before-and-after assertions execute (no `.skip`, no `describeLive` skip). Also run `bunx tsc --noEmit`.
**Expected:** Assertions are reported as executed, and tsc exits 0.
**Why human:** Needs the live run above.

### Gaps Summary

No gaps are established. Both success criteria are present and wired in code, and the test file enumerates the refusal cases. Neither criterion is behaviorally proven in this run, because the test file cannot start without Postgres. Per the verifier rules, presence alone does not give VERIFIED, so both truths are PRESENT_BEHAVIOR_UNVERIFIED and the status is human_needed.

The 2026-10-21 `passed` result rested on a run at be7bcfe (71 pass, 0 fail). It is not evidence for the current HEAD. Line references in the old report were also stale: `server.ts:1070-1085` is now `:1445-1452`.

Security gate: no `34-SECURITY.md` exists in the phase directory, so the draft-or-open-threats check did not block.

---

_Verified: 2026-11-12T08:31:26Z_
_Verifier: Claude (gsd-verifier)_
