---
phase: 64-embedding-fabric
verified: 2026-11-04T22:57:56Z
status: human_needed
score: 4/4 must-haves verified
covered_files: [".planning/phases/64-embedding-fabric/64-SUMMARY.md", "docs/corpus.md", "docs/data-planes.md", "docs/embedding-fabric.md", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/neardup.test.ts", "packages/cli/src/corpus/neardup.ts", "packages/cli/src/corpus/render.ts", "packages/corpus/src/protocol.ts", "packages/corpus/src/similarity.test.ts", "packages/corpus/src/similarity.ts", "packages/mcp-server/src/cache-conformance.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/neardup.test.ts", "packages/mcp-server/src/corpus/neardup.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/db-endpoints.ts", "packages/mcp-server/src/embed.test.ts", "packages/mcp-server/src/embed.ts", "packages/mcp-server/src/fabric-mcp.test.ts", "packages/mcp-server/src/fabric/compliance.test.ts", "packages/mcp-server/src/fabric/compliance.ts", "packages/mcp-server/src/fabric/fixtures.ts", "packages/mcp-server/src/fabric/gather.test.ts", "packages/mcp-server/src/fabric/gather.ts", "packages/mcp-server/src/fabric/status.test.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/fabric/types.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/planes/tei.test.ts", "packages/mcp-server/src/planes/tei.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/store-lock.test.ts", "packages/observability/src/breaker.ts"]
covered_digest: "v3:sha256:af1174e6ba8721c58f15e9795eafa95a79722838fb013fbea7aac69486747083"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 3/4
  gaps_closed:
    - "fabric_status tei row reports the TEI breaker (ROADMAP Phase 64 criterion 3), fixed in 4d142247"
  gaps_remaining: []
  regressions: []
advisory:
  - finding: "cache.ts now issues SCAN and UNLINK (scanKeys, unlinkKeys, bunRedis run ops 'scan' | 'unlink'); D64-3 says no new redis command"
    category: architectural
    reason: "Added by later phase-78 reconcile work. cache-conformance.test.ts 'bunRedis commands are get, mget, set, incr, and eval' still passes only because it substring-matches the old union; its name no longer describes the code. The emb class itself uses only SET and MGET."
    evidence_status: "file read: cache.ts lines 406 and 431-432 (run ops 'scan' | 'unlink'), unchanged since 504da465 per git diff. Not a test failure. Not re-run in this pass."
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
**Verified:** 2026-11-04T22:57:56Z
**Status:** human_needed
**Re-verification:** Yes. Previous record: 64-VERIFICATION.md (gaps_found, 3 of 4; criterion 3 failed on the missing breaker). Head 9e71f263 (worktree `/root/src/worktrees/as-gsd-v18-all`, branch gsd/v18-int-all).

**Must-haves:** no PLAN.md exists for this phase; the truths are the four ROADMAP Phase 64 success criteria. Requirements EMB-01 to EMB-04 are mapped to this phase in REQUIREMENTS.md.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | TEI client batches to the server limit, times out, retries with backoff, opens a breaker; model or dimension other than the pins is refused with a closed reason; fake covers each path | ✓ VERIFIED (carried forward) | `planes/tei.ts` unchanged since 504da465 (git diff empty). Verified at 504da465: batch `min(config.batch, batchLimit)`, `AbortSignal.timeout`, retry/backoff, `TEI_REASONS` closed list, breaker via `gatedFetch(planes.gate("tei"))` in `service.ts`. Not re-run in this pass. |
| 2 | `SUBSTRATE_EMBED_CACHE=on` caches vectors in Dragonfly under class `emb`, keyed by model and sha256, every key TTL'd, cache-conformance test passes | ✓ VERIFIED (carried forward) | `embed.ts`, `cache.ts` (`putEntry("emb")`, `SET … EX`), `CACHE_TTL` and `CACHE_CLASSES` contain `emb`. Files unchanged since 504da465. Live branch of cache-conformance skipped (see Human Verification). Caveat in advisory. |
| 3 | `fabric_status` has a `tei` resource (health, model, dimension, breaker); compliance fails a non-private TEI URL; fixtures and order tests updated | ✓ VERIFIED (re-verified) | `fabric/status.ts` `teiRow` (l.110-116) now sets `breaker: facts.services.tei.breaker` on the row when TEI is configured; `fabric/types.ts` l.80-81 adds `breaker?: BreakerReading` to `FabricResourceStatus`; `gather.ts` l.135 maps the live `breakers.tei` snapshot (`off` when null). `fabric_status` returns the status object as JSON (`mcp.ts` l.2307, 2324), so the field reaches the caller. Two behaviour tests in `status.test.ts` ("an open TEI breaker is reported on the row, and the row is still unavailable": `{state: unavailable, breaker: open}`; "a closed TEI breaker is reported as closed, and the row is ok": `{state: ok, breaker: closed}`) pass. `compliance.ts` `teiEndpointCheck` FAILs a `direct` endpoint; `compliance.test.ts` l.46-47 asserts FAIL. Fixtures and order tests pass. Not exercised by a test: the `half-open` and `off` breaker values on the row (code path is a direct copy of the snapshot, so not a behavioural gap). |
| 4 | `nearDuplicates` in `@substrate/corpus` returns pairs above a threshold with similarity; `POST /corpus/neardup` embeds excerpts through TEI client; `substrate corpus plan --neardup` prints pairs; no document dropped on that signal alone | ✓ VERIFIED (carried forward) | `corpus/src/similarity.ts`, route `server.ts` → `corpus/neardup.ts` → `EmbeddingService.embed`; CLI `plan()` prints the section only. Files unchanged since 504da465. Not re-run in this pass. The "nothing is dropped" property is read from code. |

**Score:** 4/4 truths verified (0 present-behavior-unverified, 0 overrides)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planes/tei.ts` | TEI client | ✓ VERIFIED | Unchanged since 504da465; wired via `service.ts` |
| `packages/mcp-server/src/embed.ts` | Cached embedding service | ✓ VERIFIED | Unchanged since 504da465 |
| `packages/mcp-server/src/cache.ts` (`emb`) | Class and TTL | ✓ VERIFIED | `emb` in both tables, `putEntry`, `embeddingEntryOk` |
| `packages/mcp-server/src/fabric/status.ts` (`teiRow`) | tei row | ✓ VERIFIED | model, dimension, latency and breaker present (4d142247) |
| `packages/mcp-server/src/fabric/types.ts` | `breaker` on resource row | ✓ VERIFIED | `breaker?: BreakerReading` l.80-81 |
| `packages/mcp-server/src/fabric/compliance.ts` | TEI endpoint check | ✓ VERIFIED | `tei-endpoint-private` FAILs direct endpoints |
| `packages/observability/src/breaker.ts` (`AUX_PLANES`) | tei gate | ✓ VERIFIED | `AUX_PLANES = ["tei"]` |
| `packages/corpus/src/similarity.ts` | nearDuplicates | ✓ VERIFIED | Unchanged since 504da465 |
| `packages/mcp-server/src/corpus/neardup.ts` | Route reply | ✓ VERIFIED | `POST /corpus/neardup` in `server.ts` |
| `packages/cli/src/corpus/neardup.ts` | CLI section | ✓ VERIFIED | `plan --neardup` wired in `index.ts` |
| `docs/embedding-fabric.md` | Runbook | ✓ VERIFIED | "Turning it on" present |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts` | `planes/tei.ts` | `createTeiClient(config.tei, { fetch: gatedFetch(planes.gate("tei"), …) })` | ✓ WIRED | l.1937-1938 |
| `planes/tei.ts` | `embed.ts` | `EmbeddingService` is the only consumer of the client | ✓ WIRED | `store-lock.test.ts` locks the import boundary |
| `embed.ts` | `cache.ts` | `putEntry("emb")`, `peekMany` | ✓ WIRED | |
| `gather.ts` `tei` | `fabric/status.ts` `teiRow` | `breakers.tei` → `services.tei.breaker` → row `breaker` | ✓ WIRED | Previously NOT_WIRED; closed by 4d142247 |
| `server.ts` | `corpus/neardup.ts` | `POST /corpus/neardup` | ✓ WIRED | l.1755 |
| `cli/corpus/index.ts` | `POST /corpus/neardup` | `client.neardup(...)` in `plan()` | ✓ WIRED | |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `teiRow` breaker | `facts.services.tei.breaker` | `breakers.tei` from the live `FabricHealthView` snapshot | Yes: `off` when breakers are disabled, else the live state | ✓ FLOWING |
| `teiRow` detail | `facts.tei` | `FabricSources` snapshot / TEI `snapshot()` | Yes (model from `/info` or pin, dim from vectors) | ✓ FLOWING |
| neardup pairs | `EmbeddingService.embed` | TEI `/embed` via cache | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

Targeted run, one command, no server started, no Postgres-gated file in the set (none of the files mention `SUBSTRATE_TEST_PG_URL`; the URL was set to `substrate_test_v64` for the run and no file read it):

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Fabric status (incl. tei breaker rows), gather, compliance, optimize, fabric-mcp | `SUBSTRATE_TEST_PG_URL=postgres://postgres:ci-scratch-only@127.0.0.1:5439/substrate_test_v64 TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/fabric/ packages/mcp-server/src/fabric-mcp.test.ts` | 107 pass, 0 fail, 314 expect() calls, 5 files, 107 tests, 9.10s | ✓ PASS |

Not re-run in this pass: `planes/tei.test.ts`, `embed.test.ts`, `cache-conformance.test.ts`, `store-lock.test.ts`, `similarity.test.ts`, `corpus/neardup.test.ts`, `cli/corpus/neardup.test.ts`. Their source files are unchanged since 504da465 (git diff empty), and their results at 504da465 are carried forward.

Postgres-gated clauses: none in this phase's criterion-3 scope; no PG run performed.

Step 7c (probes): skipped. The phase declares no probes, and `scripts/*/tests/probe-*.sh` finds none.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| EMB-01 | none (no PLAN.md) | TEI client with batching, timeout, retry, breaker; refuses other model or dim | ✓ SATISFIED | Truth 1 |
| EMB-02 | none | Embeddings cached in Dragonfly by model and hash, every key TTL'd | ✓ SATISFIED | Truth 2 |
| EMB-03 | none | `fabric_status` reports TEI health, model, dimension; compliance names a non-private endpoint | ✓ SATISFIED | Truth 3 |
| EMB-04 | none | Near-duplicates by cosine of TEI embeddings; plan shows them; nothing dropped | ✓ SATISFIED | Truth 4 |

No orphaned requirements: REQUIREMENTS.md maps EMB-01 to EMB-04 to phase 64 and all four are claimed here.

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

No gaps remain. The previous blocker (criterion 3: the `tei` row had no breaker reading) is closed by 4d142247: the row carries `breaker` read from the live snapshot, the open and closed cases are covered by tests, and the 107-test fabric run passes. Criterion 3 is satisfied as written in ROADMAP.md.

The advisory on SCAN/UNLINK (D64-3) remains open for the owner. Human verification items 1-4 remain open, so the status is `human_needed`, not `passed`.

---

_Verified: 2026-11-04T22:57:56Z_
_Verifier: Claude (gsd-verifier)_
