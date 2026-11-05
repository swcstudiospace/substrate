---
phase: 64-embedding-fabric
verified: 2026-11-05T07:10:56Z
status: human_needed
score: 4/4 must-haves verified
covered_files: [".planning/phases/64-embedding-fabric/64-SUMMARY.md", "docs/corpus.md", "docs/data-planes.md", "docs/embedding-fabric.md", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/neardup.test.ts", "packages/cli/src/corpus/neardup.ts", "packages/cli/src/corpus/render.ts", "packages/corpus/src/protocol.ts", "packages/corpus/src/similarity.test.ts", "packages/corpus/src/similarity.ts", "packages/mcp-server/src/cache-conformance.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/neardup.test.ts", "packages/mcp-server/src/corpus/neardup.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/db-endpoints.ts", "packages/mcp-server/src/embed.test.ts", "packages/mcp-server/src/embed.ts", "packages/mcp-server/src/fabric-mcp.test.ts", "packages/mcp-server/src/fabric/compliance.test.ts", "packages/mcp-server/src/fabric/compliance.ts", "packages/mcp-server/src/fabric/fixtures.ts", "packages/mcp-server/src/fabric/gather.test.ts", "packages/mcp-server/src/fabric/gather.ts", "packages/mcp-server/src/fabric/status.test.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/fabric/types.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/planes/tei.test.ts", "packages/mcp-server/src/planes/tei.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/store-lock.test.ts", "packages/observability/src/breaker.ts"]
covered_digest: "v3:sha256:1d6d152df40442f76b70770a12e2609048bd92b5c836754aafc4c0a1f605573b"
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
    reason: "Added by later phase-78 reconcile work. cache-conformance.test.ts 'bunRedis commands are get, mget, set, incr, and eval' (line 104) still passes only because it substring-matches the old union; its name no longer describes the code. The emb class itself uses only SET and MGET."
    evidence_status: "file read at 42e3cf13: cache.ts lines 406 and 431-432 (run ops 'scan' | 'unlink'), unchanged by the H-1 commits (their only cache.ts hunk is at lines 881-917). Not a test failure: cache-conformance.test.ts passes in this pass's targeted run (436 pass across 13 files, 1 skip, 0 fail). Not changed by this re-verification."
human_verification:
  - test: "Live TEI reach: point TEI_URL at a real TEI via a forwarder listed in SUBSTRATE_DB_PROXY_ALLOW, restart, call fabric_status"
    expected: "tei row state ok, detail.model shows the /info model, breaker closed"
    why_human: "External service; TEI has never been contacted live (SUMMARY)"
  - test: "Pins match the live service: copy the observed model into SUBSTRATE_TEI_MODEL and dimension into SUBSTRATE_TEI_DIM, then embed a probe text"
    expected: "No model-mismatch or dim-mismatch"
    why_human: "The model and dimension are not recorded in the repo; both flags default to 'learned' (flag-registry.ts lines 807-808)"
  - test: "Dragonfly emb class in production: SUBSTRATE_EMBED_CACHE=on, run bun scripts/cache-stats.ts"
    expected: "emb hits and TTLs present"
    why_human: "The production Dragonfly is not reachable from this worktree; the live cache-conformance branch (SUBSTRATE_CONFORMANCE_REDIS_URL) was not run"
  - test: "Near-duplicate quality: substrate corpus plan --neardup on real documents"
    expected: "Sensible pairs at 0.92"
    why_human: "Judgment on real content"
---

# Phase 64: Embedding fabric Verification Report

**Phase Goal:** Substrate itself can embed text with the owner's TEI service, cheaply and safely, and uses it to find near-duplicate documents.
**Verified:** 2026-11-05T07:10:56Z
**Status:** human_needed
**Re-verification:** Yes. Previous record: 64-VERIFICATION.md at 835a2742 (human_needed, 4/4; covered_digest v3:sha256:d7b85f56...). Head 42e3cf13 (worktree `/root/src/worktrees/as-gsd-v18-all`, branch gsd/v18-int-all).

**Must-haves:** no PLAN.md exists for this phase; the truths are the four ROADMAP Phase 64 success criteria. Requirements EMB-01 to EMB-04 are mapped to this phase in REQUIREMENTS.md.

**What changed since the last record (835a2742 to 42e3cf13), against covered files:**
- `packages/mcp-server/src/cache.ts` (commit 9e6fa1f2, phase 75 H-1; the test commit 9c86ffab changes no covered file): the only hunk is at lines 881-917. `forgetVerdict` is new (returns `clear` | `forgotten` | `unreadable`), and `snapshotSurvivesForget` now wraps it and returns true only for `clear`, so its boolean behaviour is unchanged. Nothing in the hunk touches the `emb` class: `CACHE_TTL.emb` (line 56), `CACHE_CLASSES` including `emb` (line 71), `putEntry` and its `emb` caller (`embed.ts` line 127), and the run ops at lines 406 and 431-432 are all unchanged. Criterion 2 is re-audited against this and is unaffected.
- `packages/mcp-server/src/flag-registry.ts` (commit 9e6fa1f2): one line changed, line 632, the `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` text. It is not a TEI, `emb`, fabric-row, compliance or near-duplicate entry. The `SUBSTRATE_TEI_MODEL` (line 807), `SUBSTRATE_TEI_DIM` (line 808) and `SUBSTRATE_EMBED_CACHE` (line 607) entries are unchanged. `flag-registry.test.ts`: 26 pass, 0 fail in this pass.
- `packages/mcp-server/src/service.ts`, `service-forget.test.ts`, `cache-breaker.test.ts`, `docs/observability.md`, `docs/config-reference.md`: outside the phase 64 covered set (the covered set has no `service.ts`); they touch no phase 64 criterion. Their in-process last-good brief path does not reach the TEI client, `emb` class, fabric `tei` row or near-duplicate route.
- Every other covered file is byte-identical to the 835a2742 record (`git diff 835a2742..HEAD` restricted to the covered set returns only cache.ts and flag-registry.ts).

Carried forward unchanged: the criterion 1, 3 and 4 evidence in the prior record (the covered files they cite are unchanged since 835a2742 apart from the flag-registry line above), and the criterion 2 evidence, re-read at 42e3cf13 as described.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | TEI client batches to the server limit, times out, retries with backoff, opens a breaker; model or dimension other than the pins is refused with a closed reason; fake covers each path | ✓ VERIFIED (carried forward) | `planes/tei.ts` and `planes/tei.test.ts` unchanged since 9e71f263. Batch `Math.min(config.batch, batchLimit ?? config.batch)` (tei.ts line 392); `AbortSignal.timeout` (line 248); backoff `backoffMs` (line 190) and retry loop (line 241); `TEI_REASONS` closed list (line 29, eight reasons). Behavioral tests pass this pass (targeted run below): "splits to the server's max_client_batch_size" (tei.test.ts:121), "a 429 is retried after the jittered backoff" (:196), "a request that times out answers timeout at once" (:275), and the breaker-open path. |
| 2 | `SUBSTRATE_EMBED_CACHE=on` caches vectors in Dragonfly under class `emb`, keyed by model and sha256, every key TTL'd, cache-conformance test passes | ✓ VERIFIED (re-audited at 42e3cf13) | `cache.ts` `CACHE_TTL.emb = 604_800` (line 56) and `CACHE_CLASSES` includes `"emb"` (line 71); the H-1 change in cache.ts (lines 881-917, forget-mark verdict) does not touch these. `embed.ts` line 127 `putEntry("emb", embeddingDigest(model, text), …, deps.ttlS)`; digest is sha256 of model, newline, text (embed.test.ts:276). Behavioral tests pass this pass: "every write carries the TTL, however many are written" (embed.test.ts:163), "the key names the model" (:173), "a dead Redis falls through on read and on write" (:216). `cache-conformance.test.ts` passes; its live branch is `test.skip` at line 127 (`SUBSTRATE_CONFORMANCE_REDIS_URL` unset). Caveat in advisory. |
| 3 | `fabric_status` has a `tei` resource (health, model, dimension, breaker); compliance fails a non-private TEI URL; fixtures and order tests updated | ✓ VERIFIED (carried forward; tei breaker re-run) | `fabric/status.ts` `teiRow` (lines 112-117) sets `breaker: facts.services.tei.breaker` when TEI is configured; `fabric/types.ts` line 82 `breaker?: BreakerReading`; `fabric/gather.ts` line 135 `breaker: breakerOf(breakers.tei)`; `fabric/compliance.ts` `teiEndpointCheck` (lines 72-79) FAILs a direct endpoint under policy and is NOT_APPLICABLE when unset. Tests pass this pass: the tei-breaker block "the tei row's breaker (phase 64)" (`status.test.ts` lines 216-260, open and closed cases), the nine-resource order test (`status.test.ts:104`; `fabric-mcp.test.ts:70`), compliance and gather tests. |
| 4 | `nearDuplicates` in `@substrate/corpus` returns pairs above a threshold with similarity; `POST /corpus/neardup` embeds excerpts through TEI client; `substrate corpus plan --neardup` prints pairs; no document dropped on that signal alone | ✓ VERIFIED (carried forward) | `corpus/src/similarity.ts`, `corpus/src/similarity.test.ts`, `mcp-server/src/corpus/neardup.ts`, `mcp-server/src/corpus/neardup.test.ts`, `cli/src/corpus/neardup.ts`, `cli/src/corpus/neardup.test.ts` unchanged since 9e71f263. Targeted run this pass: all pass. "Nothing is dropped" is read from code: `mcp-server/src/corpus/neardup.ts` line 5 states the route "drops, skips or tombstones nothing: the reply" carries pairs only; no filter on the signal exists in the route. Not a behavior-dependent truth. |

**Score:** 4/4 truths verified (0 present-behavior-unverified, 0 overrides)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planes/tei.ts` | TEI client | ✓ VERIFIED | Unchanged since 9e71f263; `tei.test.ts` passes |
| `packages/mcp-server/src/embed.ts` | Cached embedding path, `emb` class | ✓ VERIFIED | Unchanged; `embed.test.ts` passes |
| `packages/mcp-server/src/cache.ts` | `emb` class with TTL, `putEntry` | ✓ VERIFIED | `emb` TTL and class lines unchanged; H-1 hunk at 881-917 re-audited, unrelated to `emb`; SCAN/UNLINK union present (advisory) |
| `packages/mcp-server/src/fabric/status.ts` | `tei` row with breaker; corpus row | ✓ VERIFIED | Corpus row changed in a4a9a8f0 (before c40ffc9a); tei row unchanged; nine-row order test passes |
| `packages/mcp-server/src/fabric/types.ts` | `breaker?` on resource status | ✓ VERIFIED | `breaker?` at line 82 |
| `packages/mcp-server/src/fabric/gather.ts` | `breakers.tei` mapped into facts | ✓ VERIFIED | Line 135; unchanged since 9e71f263 |
| `packages/mcp-server/src/fabric/compliance.ts` | `tei-endpoint-private` check | ✓ VERIFIED | `teiEndpointCheck` at line 72; unchanged |
| `packages/corpus/src/similarity.ts` | `nearDuplicates` | ✓ VERIFIED | Unchanged; `similarity.test.ts` passes |
| `packages/mcp-server/src/corpus/neardup.ts` | `POST /corpus/neardup` path | ✓ VERIFIED | Unchanged; `neardup.test.ts` passes |
| `packages/cli/src/corpus/neardup.ts` | `plan --neardup` section | ✓ VERIFIED | Unchanged; CLI `neardup.test.ts` passes |
| `packages/mcp-server/src/flag-registry.ts` | Flag entries for TEI, cache, docs age limit | ✓ VERIFIED | Changed in 9e6fa1f2 (line 632, the snapshot TTL text; not a phase 64 entry); TEI and cache entries unchanged; `flag-registry.test.ts` 26 pass |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `fabric/gather.ts` | `fabric/status.ts` | `tei` facts: `breakers.tei` → `teiRow` breaker | WIRED | gather.ts line 135; status.ts `teiRow` lines 112-117 |
| `fabric/status.ts` | `fabric_status` MCP reply | `resources` JSON | WIRED | status object returned as JSON; unchanged |
| `embed.ts` | `cache.ts` | `putEntry("emb")` | WIRED | embed.ts line 127 |
| `planes/tei.ts` | `service.ts` | `gatedFetch(planes.gate("tei"))` | WIRED | Unchanged in covered set; `service.ts` is outside the covered set and its H-1 changes do not touch `fabricSources()` |
| `corpus/neardup.ts` | `similarity.ts` | `nearDuplicates` call | WIRED | Unchanged |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `fabric/status.ts` tei row | `breaker`, `detail.model/dimension/latencyMs` | `facts.services.tei`, `facts.tei` from `gatherFabricFacts` (live snapshot and TEI client facts) | Yes (live breaker read at call time; `answered` from the probe) | ✓ FLOWING |
| `fabric/status.ts` corpus row | `syncLag` reading | `corpusRead` facts (SLO readings) | Yes; `null` reading is not a breach | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Fabric status, tei breaker, compliance, gather, MCP reply, TEI client, embed cache, cache conformance, near-duplicates (server, CLI, library), store lock, flag registry (changed covered file) | `bun test packages/mcp-server/src/fabric packages/mcp-server/src/fabric-mcp.test.ts packages/mcp-server/src/planes/tei.test.ts packages/mcp-server/src/embed.test.ts packages/mcp-server/src/cache-conformance.test.ts packages/mcp-server/src/corpus/neardup.test.ts packages/cli/src/corpus/neardup.test.ts packages/corpus/src/similarity.test.ts packages/mcp-server/src/store-lock.test.ts packages/mcp-server/src/flag-registry.test.ts` (run at 42e3cf13, 13.27 s, one command, non-PG) | 436 pass, 1 skip (the live redis branch, `test.skip` at cache-conformance.test.ts:127), 0 fail; 1514 expect() calls; 437 tests across 13 files | ✓ PASS |

### Probe Execution

No probes are declared for this phase (not a migration or tooling phase; PLAN/SUMMARY declare none). Step 7c: SKIPPED (no declared probes).

### Postgres evidence

No Postgres-gated file is in this phase's covered set, and none was re-run for this record. `flag-registry.ts` mentions the `SUBSTRATE_TEST_PG_URL` name only as a registry entry (a string, not a connection). `store-lock.test.ts` mentions Postgres only in a comment (line 170). The two PG-gated files, `corpus/store.test.ts` and `corpus/reflect-store.test.ts`, are outside this phase's covered set. No scratch Postgres run was made for this phase; production was not touched.

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
| `packages/mcp-server/src/fabric/status.ts` | 2 and 92 | Header says "nine fabric resources"; the `buildFabricStatus` doc comment at line 92 says "The eight rows in report order"; the function returns nine rows | ℹ️ Info | Comment drift, pre-existing; not a behaviour gap |
| `packages/mcp-server/src/cache.ts` | 406, 431-432 | SCAN and UNLINK run ops | ⚠️ Warning | See advisory; not a failure of criterion 2 |
| `.planning/ROADMAP.md` (phase 64 Status line, outside covered set) | Status line | Still reads "gaps_found: TEI never contacted live; criterion 3 partial" | ℹ️ Info | Disagrees with this record (human_needed; criterion 3 verified). Not edited here; the roadmap owner decides |

Debt-marker gate: no `TBD`, `FIXME` or `XXX` in any covered file. No `TODO`, `HACK` or `PLACEHOLDER` in any covered file.

### Human Verification Required

These are operator-gated and do not change the verified count. They route the status to `human_needed`.

1. **Live TEI reach.** Test: point `TEI_URL` at a real TEI via a forwarder listed in `SUBSTRATE_DB_PROXY_ALLOW`, restart, call `fabric_status`. Expected: `tei` row `ok`, `detail.model` shows the `/info` model, `breaker` `closed`. Why human: external service; TEI has never been contacted (SUMMARY).
2. **Pins match the live service.** Test: copy the observed model into `SUBSTRATE_TEI_MODEL` and dimension into `SUBSTRATE_TEI_DIM`, then embed a probe text. Expected: no `model-mismatch` or `dim-mismatch`. Why human: the model and dimension are not recorded in the repo; both flags default to `learned`.
3. **Dragonfly `emb` class in production.** Test: `SUBSTRATE_EMBED_CACHE=on`, run `bun scripts/cache-stats.ts`. Expected: `emb` hits and TTLs present. Why human: the production Dragonfly is not reachable from this worktree; the live cache-conformance branch was not run.
4. **Near-duplicate quality.** Test: `substrate corpus plan --neardup` on real documents. Expected: sensible pairs at 0.92. Why human: judgment on real content.

### Gaps Summary

No gaps remain. Criterion 2 is re-audited against the H-1 cache.ts hunk (lines 881-917): the `emb` class, its TTL and its write path are unchanged, and the targeted cache and embed tests pass at 42e3cf13. Criterion 3 (the `tei` row's breaker) stays closed. The covered-file changes since the prior record (cache.ts forget-verdict hunk, flag-registry.ts one line) do not touch a phase 64 criterion, and their tests pass.

The advisory on SCAN/UNLINK (D64-3) remains open for the owner. Human verification items 1-4 remain open, so the status is `human_needed`, not `passed`.

---

_Verified: 2026-11-05T07:10:56Z_
_Verifier: Claude (gsd-verifier)_
