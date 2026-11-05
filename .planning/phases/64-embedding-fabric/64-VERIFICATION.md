---
phase: 64-embedding-fabric
verified: 2026-11-05T00:13:12Z
status: human_needed
score: 4/4 must-haves verified
covered_files: [".planning/phases/64-embedding-fabric/64-SUMMARY.md", "docs/corpus.md", "docs/data-planes.md", "docs/embedding-fabric.md", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/neardup.test.ts", "packages/cli/src/corpus/neardup.ts", "packages/cli/src/corpus/render.ts", "packages/corpus/src/protocol.ts", "packages/corpus/src/similarity.test.ts", "packages/corpus/src/similarity.ts", "packages/mcp-server/src/cache-conformance.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/neardup.test.ts", "packages/mcp-server/src/corpus/neardup.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/db-endpoints.ts", "packages/mcp-server/src/embed.test.ts", "packages/mcp-server/src/embed.ts", "packages/mcp-server/src/fabric-mcp.test.ts", "packages/mcp-server/src/fabric/compliance.test.ts", "packages/mcp-server/src/fabric/compliance.ts", "packages/mcp-server/src/fabric/fixtures.ts", "packages/mcp-server/src/fabric/gather.test.ts", "packages/mcp-server/src/fabric/gather.ts", "packages/mcp-server/src/fabric/status.test.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/fabric/types.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/planes/tei.test.ts", "packages/mcp-server/src/planes/tei.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/store-lock.test.ts", "packages/observability/src/breaker.ts"]
covered_digest: "v3:sha256:b6e144e9301f788edbc5f0f495cfc264b3675d3a03be3d52eb1136c8ff3066a8"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 4/4
  gaps_closed: []
  gaps_remaining: []
  regressions: []
advisory:
  - finding: "cache.ts now issues SCAN and UNLINK (scanKeys, unlinkKeys, bunRedis run ops 'scan' | 'unlink'); D64-3 says no new redis command"
    category: architectural
    reason: "Added by later phase-78 reconcile work. cache-conformance.test.ts 'bunRedis commands are get, mget, set, incr, and eval' still passes only because it substring-matches the old union; its name no longer describes the code. The emb class itself uses only SET and MGET."
    evidence_status: "file read at c40ffc9a: cache.ts lines 406 and 431-432 (run ops 'scan' | 'unlink'); cache.ts is not in the diff since 9e71f263. Not a test failure: cache-conformance.test.ts passes in this pass's targeted run. Not changed by this re-verification."
human_verification:
  - test: "Live TEI reach: point TEI_URL at a real TEI via a forwarder listed in SUBSTRATE_DB_PROXY_ALLOW, restart, call fabric_status"
    expected: "tei row state ok, detail.model shows the /info model, breaker closed"
    why_human: "External service; TEI has never been contacted live (SUMMARY)"
  - test: "Pins match the live service: copy the observed model into SUBSTRATE_TEI_MODEL and dimension into SUBSTRATE_TEI_DIM, then embed a probe text"
    expected: "No model-mismatch or dim-mismatch"
    why_human: "The model and dimension are not recorded in the repo"
  - test: "Dragonfly emb class in production: SUBSTRATE_EMBED_CACHE=on, run bun scripts/cache-stats.ts"
    expected: "emb hits and TTLs present"
    why_human: "The production Dragonfly is not reachable from this worktree; the live cache-conformance branch (SUBSTRATE_CONFORMANCE_REDIS_URL) was not run"
  - test: "Near-duplicate quality: substrate corpus plan --neardup on real documents"
    expected: "Sensible pairs at 0.92"
    why_human: "Judgment on real content"
---

# Phase 64: Embedding fabric Verification Report

**Phase Goal:** Substrate itself can embed text with the owner's TEI service, cheaply and safely, and uses it to find near-duplicate documents.
**Verified:** 2026-11-05T00:13:12Z
**Status:** human_needed
**Re-verification:** Yes. Previous record: 64-VERIFICATION.md at 9e71f263 (human_needed, 4/4). Head c40ffc9a (worktree `/root/src/worktrees/as-gsd-v18-all`, branch gsd/v18-int-all).

**Must-haves:** no PLAN.md exists for this phase; the truths are the four ROADMAP Phase 64 success criteria. Requirements EMB-01 to EMB-04 are mapped to this phase in REQUIREMENTS.md.

**What changed since the last record (9e71f263 to c40ffc9a), in covered files:**
- `packages/mcp-server/src/fabric/status.ts`: the corpus row now also judges the sync lag (a4a9a8f0). The `tei` row code is unchanged (`teiRow`, lines 110-116).
- `packages/mcp-server/src/fabric/types.ts`: `SloLine.threshold` becomes nullable and `CorpusDetail` gains `syncLag` (a4a9a8f0). `FabricResourceStatus.breaker?` (lines 80-82) is unchanged.
- `packages/mcp-server/src/config.ts`: comment text only (a4a9a8f0).

Outside the covered set and not touching criteria 1 to 4: `packages/mcp-server/src/service.ts` (corpusSlo wiring, retrieval-row privacy, 75d2ce56 and a4a9a8f0), `slo.ts`, `metrics-history.ts`, `telemetry.ts`, dashboards. Not re-audited here.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | TEI client batches to the server limit, times out, retries with backoff, opens a breaker; model or dimension other than the pins is refused with a closed reason; fake covers each path | ✓ VERIFIED (carried forward) | `planes/tei.ts` and `planes/tei.test.ts` are unchanged since 9e71f263 (not in the diff). Earlier audit at 504da465: batch `min(config.batch, batchLimit)`, `AbortSignal.timeout`, retry/backoff, `TEI_REASONS` closed list, breaker via `gatedFetch(planes.gate("tei"))` in `service.ts`. Targeted run this pass includes `planes/tei.test.ts`: all pass. |
| 2 | `SUBSTRATE_EMBED_CACHE=on` caches vectors in Dragonfly under class `emb`, keyed by model and sha256, every key TTL'd, cache-conformance test passes | ✓ VERIFIED (carried forward) | `embed.ts`, `cache.ts` unchanged since 9e71f263 (not in the diff). `cache.ts` `putEntry("emb")` with `SET … EX`; `CACHE_TTL` and `CACHE_CLASSES` contain `emb`. Targeted run this pass: `cache-conformance.test.ts` and `embed.test.ts` pass; the live branch is `test.skip` at line 127 (`SUBSTRATE_CONFORMANCE_REDIS_URL` unset). Caveat in advisory. |
| 3 | `fabric_status` has a `tei` resource (health, model, dimension, breaker); compliance fails a non-private TEI URL; fixtures and order tests updated | ✓ VERIFIED (re-audited) | `fabric/status.ts` `teiRow` (lines 110-116) sets `breaker: facts.services.tei.breaker` when TEI is configured; `fabric/types.ts` line 82 `breaker?: BreakerReading`; `fabric/gather.ts` line 135 maps `breakers.tei` via `breakerOf` (`off` when null). `fabric/compliance.ts` `teiEndpointCheck` (lines 72-79) FAILs a direct endpoint under policy and is NOT_APPLICABLE when unset. The `status.test.ts` tei-breaker block (lines 216-260) and the nine-resource order test (line 104) pass in the targeted run. The corpus row change (a4a9a8f0) did not alter the tei row. |
| 4 | `nearDuplicates` in `@substrate/corpus` returns pairs above a threshold with similarity; `POST /corpus/neardup` embeds excerpts through TEI client; `substrate corpus plan --neardup` prints pairs; no document dropped on that signal alone | ✓ VERIFIED (carried forward) | `corpus/src/similarity.ts`, `corpus/src/similarity.test.ts`, `mcp-server/src/corpus/neardup.ts`, `mcp-server/src/corpus/neardup.test.ts`, `cli/src/corpus/neardup.ts`, `cli/src/corpus/neardup.test.ts` unchanged since 9e71f263. Targeted run this pass: all pass. The "nothing is dropped" property is read from code. |

**Score:** 4/4 truths verified (0 present-behavior-unverified, 0 overrides)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planes/tei.ts` | TEI client | ✓ VERIFIED | Unchanged since 9e71f263; targeted tests pass |
| `packages/mcp-server/src/embed.ts` | Cached embedding path, `emb` class | ✓ VERIFIED | Unchanged; `embed.test.ts` passes |
| `packages/mcp-server/src/cache.ts` | `emb` class with TTL, `putEntry` | ✓ VERIFIED | Unchanged; SCAN/UNLINK union present (advisory) |
| `packages/mcp-server/src/fabric/status.ts` | `tei` row with breaker; corpus row | ✓ VERIFIED | Changed in a4a9a8f0 (corpus row only); tei row unchanged; 9-row order test passes |
| `packages/mcp-server/src/fabric/types.ts` | `breaker?` on resource status | ✓ VERIFIED | Changed in a4a9a8f0 (SloLine/CorpusDetail); `breaker?` present |
| `packages/mcp-server/src/fabric/gather.ts` | `breakers.tei` mapped into facts | ✓ VERIFIED | Unchanged; `gather.test.ts` passes |
| `packages/mcp-server/src/fabric/compliance.ts` | `tei-endpoint-private` check | ✓ VERIFIED | Unchanged; `compliance.test.ts` passes |
| `packages/corpus/src/similarity.ts` | `nearDuplicates` | ✓ VERIFIED | Unchanged; `similarity.test.ts` passes |
| `packages/mcp-server/src/corpus/neardup.ts` | `POST /corpus/neardup` path | ✓ VERIFIED | Unchanged; `neardup.test.ts` passes |
| `packages/cli/src/corpus/neardup.ts` | `plan --neardup` section | ✓ VERIFIED | Unchanged; CLI `neardup.test.ts` passes |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `fabric/gather.ts` | `fabric/status.ts` | `tei` facts: `breakers.tei` → `teiRow` breaker | WIRED | gather.ts line 135; status.ts line 114 |
| `fabric/status.ts` | `fabric_status` MCP reply | `resources` JSON | WIRED | status object returned as JSON (`mcp.ts` ~2307, 2324); unchanged |
| `embed.ts` | `cache.ts` | `putEntry("emb")` | WIRED | Unchanged |
| `planes/tei.ts` | `service.ts` | `gatedFetch(planes.gate("tei"))` | WIRED | Unchanged in covered set |
| `corpus/neardup.ts` | `similarity.ts` | `nearDuplicates` call | WIRED | Unchanged |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `fabric/status.ts` tei row | `breaker`, `detail.model/dimension/latencyMs` | `facts.services.tei`, `facts.tei` from `gatherFabricFacts` (live snapshot and TEI client facts) | Yes (live breaker read at call time; `answered` from the probe) | ✓ FLOWING |
| `fabric/status.ts` corpus row | `syncLag` reading | `corpusRead` facts (SLO readings) | Yes; `null` reading is not a breach | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Fabric status, tei breaker, compliance, gather, MCP reply, TEI client, embed cache, cache conformance, near-duplicates (server, CLI, library) | `bun test packages/mcp-server/src/fabric packages/mcp-server/src/fabric-mcp.test.ts packages/mcp-server/src/planes/tei.test.ts packages/mcp-server/src/embed.test.ts packages/mcp-server/src/cache-conformance.test.ts packages/mcp-server/src/corpus/neardup.test.ts packages/cli/src/corpus/neardup.test.ts packages/corpus/src/similarity.test.ts packages/mcp-server/src/store-lock.test.ts` | 410 pass, 1 skip (the live redis branch, `test.skip` at cache-conformance.test.ts:127), 0 fail; 1293 expect() calls; 411 tests across 12 files; 10.11 s | ✓ PASS |

### Probe Execution

No probes are declared for this phase (not a migration or tooling phase; PLAN/SUMMARY declare none). Step 7c: SKIPPED (no declared probes).

### Postgres evidence

No Postgres-gated file is in this phase's covered set (the two PG-gated files, `corpus/store.test.ts` and `corpus/reflect-store.test.ts`, are outside it). No scratch Postgres run was made for this phase; database `substrate_test_v64` was not used.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| EMB-01 | (none; ROADMAP-only phase) | TEI client with batching, timeout, retry, breaker; refuses model/dim mismatch | ✓ SATISFIED | Truth 1; targeted tests pass |
| EMB-02 | (none) | Dragonfly cache by model and content hash, every key TTL'd | ✓ SATISFIED | Truth 2; targeted tests pass |
| EMB-03 | (none) | `fabric_status` reports TEI health, model, dimension; compliance names a non-private endpoint | ✓ SATISFIED | Truth 3; tei breaker tests and compliance tests pass |
| EMB-04 | (none) | Near-duplicates by cosine similarity; plan output shows them; no document dropped on that signal | ✓ SATISFIED | Truth 4; targeted tests pass |

ORPHANED requirements: none. REQUIREMENTS.md maps EMB-01 to EMB-04 to phase 64 and all four are claimed here.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/fabric/status.ts` | 1-2 | Module header says "nine fabric resources" and `buildFabricStatus` says "eight rows"; the function returns nine rows | ℹ️ Info | Comment drift, pre-existing; not a behaviour gap |
| `packages/mcp-server/src/cache.ts` | 406, 431-432 | SCAN and UNLINK run ops | ⚠️ Warning | See advisory; not a failure of criterion 2 |

### Human Verification Required

These are operator-gated and do not change the verified count. They route the status to `human_needed`.

1. **Live TEI reach.** Test: point `TEI_URL` at a real TEI via a forwarder listed in `SUBSTRATE_DB_PROXY_ALLOW`, restart, call `fabric_status`. Expected: `tei` row `ok`, `detail.model` shows the `/info` model, `breaker` `closed`. Why human: external service; TEI has never been contacted (SUMMARY).
2. **Pins match the live service.** Test: copy the observed model into `SUBSTRATE_TEI_MODEL` and dimension into `SUBSTRATE_TEI_DIM`, then embed a probe text. Expected: no `model-mismatch` or `dim-mismatch`. Why human: the model and dimension are not recorded in the repo.
3. **Dragonfly `emb` class in production.** Test: `SUBSTRATE_EMBED_CACHE=on`, run `bun scripts/cache-stats.ts`. Expected: `emb` hits and TTLs present. Why human: the production Dragonfly is not reachable from this worktree; the live cache-conformance branch was not run.
4. **Near-duplicate quality.** Test: `substrate corpus plan --neardup` on real documents. Expected: sensible pairs at 0.92. Why human: judgment on real content.

### Gaps Summary

No gaps remain. Criterion 3 (the `tei` row's breaker) stays closed: the row still carries the breaker read from the live snapshot, and the open and closed cases pass in the targeted run. The corpus-row sync-lag change (a4a9a8f0) touched `status.ts` and `types.ts` but not the tei row, and it did not regress any tei test.

The advisory on SCAN/UNLINK (D64-3) remains open for the owner. Human verification items 1-4 remain open, so the status is `human_needed`, not `passed`.

---

_Verified: 2026-11-05T00:13:12Z_
_Verifier: Claude (gsd-verifier)_
