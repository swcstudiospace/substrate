---
phase: 64-embedding-fabric
verified: 2026-11-05T07:59:23Z
status: human_needed
score: 4/4 must-haves verified
covered_files: [".planning/phases/64-embedding-fabric/64-SUMMARY.md", "docs/corpus.md", "docs/data-planes.md", "docs/embedding-fabric.md", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/neardup.test.ts", "packages/cli/src/corpus/neardup.ts", "packages/cli/src/corpus/render.ts", "packages/corpus/src/protocol.ts", "packages/corpus/src/similarity.test.ts", "packages/corpus/src/similarity.ts", "packages/mcp-server/src/cache-breaker.test.ts", "packages/mcp-server/src/cache-conformance.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/neardup.test.ts", "packages/mcp-server/src/corpus/neardup.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/db-endpoints.ts", "packages/mcp-server/src/embed.test.ts", "packages/mcp-server/src/embed.ts", "packages/mcp-server/src/fabric-mcp.test.ts", "packages/mcp-server/src/fabric/compliance.test.ts", "packages/mcp-server/src/fabric/compliance.ts", "packages/mcp-server/src/fabric/fixtures.ts", "packages/mcp-server/src/fabric/gather.test.ts", "packages/mcp-server/src/fabric/gather.ts", "packages/mcp-server/src/fabric/status.test.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/fabric/types.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/planes/tei.test.ts", "packages/mcp-server/src/planes/tei.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/store-lock.test.ts", "packages/observability/src/breaker.ts"]
covered_digest: "v3:sha256:5ed0368f71c2fd1e956779ae35ef0cc80ab0f2c096c4ceff17489710e7331cad"
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
    evidence_status: "file read at 6e5d766e: cache.ts lines 406 and 431-432 (run ops 'scan' | 'unlink'), unchanged by the 42e3cf13..6e5d766e commits (their cache.ts hunk is at lines 881-917 only). Not a test failure: cache-conformance.test.ts passes in this pass's targeted run (445 pass, 1 skip, 0 fail across 14 files). Not changed by this re-verification."
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
**Verified:** 2026-11-05T07:59:23Z
**Status:** human_needed
**Re-verification:** Yes. Previous record: 64-VERIFICATION.md at 42e3cf13 (human_needed, 4/4; covered_digest v3:sha256:1d6d152d...). Head 6e5d766e (worktree `/root/src/worktrees/as-gsd-v18-all`, branch gsd/v18-int-all).

**Must-haves:** no PLAN.md exists for this phase; the truths are the four ROADMAP Phase 64 success criteria. Requirements EMB-01 to EMB-04 are mapped to this phase in REQUIREMENTS.md.

**What changed since the last record (42e3cf13 to 6e5d766e), against covered files:**
- `packages/mcp-server/src/cache.ts` (commit d1a5e89b, phase 75): one hunk, `forgetVerdict` at lines 881-917. The catch arm now returns `forgotten` for any failure except `BreakerOpenError` (which still returns `unreadable`). `forgetVerdict` has three callers, all in `service.ts` (lines 2529, 2658, 2724) or through `snapshotSurvivesForget`; none is on the `emb` path. Re-audited for criterion 2: `CACHE_TTL.emb` (line 56), `CACHE_CLASSES` including `"emb"` (line 71), the `emb` value check (line 1265), `putEntry("emb", …)` in `embed.ts` line 127 and the run ops at lines 406 and 431-432 are all unchanged. Criterion 2 is unaffected.
- `docs/corpus.md` (commit 6e5d766e): one sentence added to the tombstone section (line 309: the `scope` is the caller's declaration, not an access control). It states no TEI, `emb`, fabric-row or near-duplicate claim; criteria 1 to 4 are unaffected.
- `packages/mcp-server/src/cache-breaker.test.ts` (commit d1a5e89b): one new test for the `forgetVerdict` change. It is not a phase 64 file, but it is now listed in `covered_files` because it is the evidence for the changed `cache.ts` behaviour, and it passes in this pass (see Behavioral Spot-Checks). The covered list therefore differs from the 42e3cf13 list by this one entry, and the digest differs for that reason and for the two hunks above.
- Outside the covered set, checked for overlap with criteria 1 to 4: `packages/mcp-server/src/service.ts` (commit b4bdd0fc, lines 3005-3006: the docs.sync sync-lag reading now also follows a note the ledger buffered or dead-lettered). This touches the corpus row's sync-lag reading (`corpusSlo.recordSyncLag`), not the `tei` row, `fabricSources()`, the TEI client or the near-duplicate route; the `fabricSources()` hunk does not appear in the diff. `event-buffer.ts`, `event-buffer.test.ts`, `service-event-buffer.test.ts`, `worktree.py`, `test_worktree.py`, `docs/reconcile.md` and the other phase records changed too; none is a phase 64 claim.
- Every other covered file is byte-identical to the 42e3cf13 record: `git diff 42e3cf13..6e5d766e` restricted to the covered set returns only `cache.ts` and `docs/corpus.md`. `flag-registry.ts` and `planes/`, `embed.ts`, `fabric/`, `corpus/`, `observability/src/breaker.ts` are unchanged.

Carried forward unchanged: the criterion 1, 3 and 4 evidence (their cited files are byte-identical to 42e3cf13), and the criterion 2 evidence, re-read at 6e5d766e as described above.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | TEI client batches to the server limit, times out, retries with backoff, opens a breaker; model or dimension other than the pins is refused with a closed reason; fake covers each path | ✓ VERIFIED (carried forward) | `planes/tei.ts` and `planes/tei.test.ts` unchanged since 9e71f263. Batch `Math.min(config.batch, batchLimit ?? config.batch)` (tei.ts line 392); `AbortSignal.timeout` (line 248); backoff `backoffMs` (line 190) and retry loop (line 241); `TEI_REASONS` closed list (line 29, eight reasons). Gate r33 JUnit names, no `<skipped/>`: "splits to the server's max_client_batch_size, keeps the order and reads /info once" (tei.test.ts:121), "a 429 is retried after the jittered backoff, and the call then succeeds" (:196), "a request that times out answers timeout at once, with no retry" (:275). Targeted run at 6e5d766e passes these files. |
| 2 | `SUBSTRATE_EMBED_CACHE=on` caches vectors in Dragonfly under class `emb`, keyed by model and sha256, every key TTL'd, cache-conformance test passes | ✓ VERIFIED (re-audited at 6e5d766e) | `cache.ts` `CACHE_TTL.emb = 604_800` (line 56) and `CACHE_CLASSES` includes `"emb"` (line 71); the d1a5e89b change (lines 881-917, forget-mark verdict) does not touch these, and no `emb` code path calls `forgetVerdict`. `embed.ts` line 127 `putEntry("emb", embeddingDigest(model, text), …, deps.ttlS)`; digest is sha256 of model, newline, text (embed.test.ts:276). Gate r33 JUnit names, no `<skipped/>`: "every write carries the TTL, however many are written" (embed.test.ts:163), "the key names the model: another model never reads these vectors" (:173), "a dead Redis falls through on read and on write" (:216). `cache-conformance.test.ts` passes; its one skip is the live branch at line 127 (`SUBSTRATE_CONFORMANCE_REDIS_URL` unset). |
| 3 | `fabric_status` has a `tei` resource (health, model, dimension, breaker); compliance fails a non-private TEI URL; fixtures and order tests updated | ✓ VERIFIED (carried forward; tei breaker re-run) | `fabric/status.ts` `teiRow` (lines 112-117) sets `breaker: facts.services.tei.breaker` when TEI is configured; `fabric/types.ts` line 82 `breaker?: BreakerReading`; `fabric/gather.ts` line 135 `breaker: breakerOf(breakers.tei)`; `fabric/compliance.ts` `teiEndpointCheck` (lines 72-79) FAILs a direct endpoint under policy and is NOT_APPLICABLE when unset. Gate r33 JUnit, suite "the tei row's breaker (phase 64)" (status.test.ts:216, tests=2, skipped=0): "an open TEI breaker is reported on the row, and the row is still unavailable" (:253), "a closed TEI breaker is reported as closed, and the row is ok" (:258). The nine-resource order test (`status.test.ts`) and `fabric-mcp.test.ts` pass in this pass. |
| 4 | `nearDuplicates` in `@substrate/corpus` returns pairs above a threshold with similarity; `POST /corpus/neardup` embeds excerpts through TEI client; `substrate corpus plan --neardup` prints pairs; no document dropped on that signal alone | ✓ VERIFIED (carried forward) | `corpus/src/similarity.ts`, `corpus/src/similarity.test.ts`, `mcp-server/src/corpus/neardup.ts`, `mcp-server/src/corpus/neardup.test.ts`, `cli/src/corpus/neardup.ts`, `cli/src/corpus/neardup.test.ts` unchanged since 9e71f263. Gate r33 JUnit, suite `nearDuplicates` (similarity.test.ts:37, skipped=0): "returns every pair at or above the threshold, most similar first, ties by key, never the zero vector" (:47), "the threshold is inclusive and a high one leaves only the identical direction" (:54). "Nothing is dropped" is read from code: `mcp-server/src/corpus/neardup.ts` line 5 states the route "drops, skips or tombstones nothing: the reply" carries pairs only; no filter on the signal exists in the route. Not a behavior-dependent truth. |

**Score:** 4/4 truths verified (0 present-behavior-unverified, 0 overrides)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planes/tei.ts` | TEI client | ✓ VERIFIED | Unchanged since 9e71f263; `tei.test.ts` passes |
| `packages/mcp-server/src/embed.ts` | Cached embedding path, `emb` class | ✓ VERIFIED | Unchanged; `embed.test.ts` passes |
| `packages/mcp-server/src/cache.ts` | `emb` class with TTL, `putEntry` | ✓ VERIFIED | `emb` TTL and class lines unchanged; d1a5e89b hunk at 881-917 re-audited, unrelated to `emb`; SCAN/UNLINK union present (advisory) |
| `packages/mcp-server/src/fabric/status.ts` | `tei` row with breaker; corpus row | ✓ VERIFIED | Tei row unchanged; nine-row order test passes; corpus row's sync-lag input changed in b4bdd0fc (outside criterion 3) |
| `packages/mcp-server/src/fabric/types.ts` | `breaker?` on resource status | ✓ VERIFIED | `breaker?` at line 82 |
| `packages/mcp-server/src/fabric/gather.ts` | `breakers.tei` mapped into facts | ✓ VERIFIED | Line 135; unchanged since 9e71f263 |
| `packages/mcp-server/src/fabric/compliance.ts` | `tei-endpoint-private` check | ✓ VERIFIED | `teiEndpointCheck` at line 72; unchanged |
| `packages/corpus/src/similarity.ts` | `nearDuplicates` | ✓ VERIFIED | Unchanged; `similarity.test.ts` passes |
| `packages/mcp-server/src/corpus/neardup.ts` | `POST /corpus/neardup` path | ✓ VERIFIED | Unchanged; `neardup.test.ts` passes |
| `packages/cli/src/corpus/neardup.ts` | `plan --neardup` section | ✓ VERIFIED | Unchanged; CLI `neardup.test.ts` passes |
| `packages/mcp-server/src/flag-registry.ts` | Flag entries for TEI, cache, docs age limit | ✓ VERIFIED | Unchanged since 42e3cf13; `SUBSTRATE_TEI_MODEL` (807), `SUBSTRATE_TEI_DIM` (808), `SUBSTRATE_EMBED_CACHE` (607) entries present; `flag-registry.test.ts` passes |
| `packages/mcp-server/src/cache-breaker.test.ts` | Test for the forget-mark verdict | ✓ VERIFIED | New test "a mark read that fails while the breaker is closed refuses the last-good copy" passes in this pass (0 fail) |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `fabric/gather.ts` | `fabric/status.ts` | `tei` facts: `breakers.tei` → `teiRow` breaker | WIRED | gather.ts line 135; status.ts `teiRow` lines 112-117 |
| `fabric/status.ts` | `fabric_status` MCP reply | `resources` JSON | WIRED | status object returned as JSON; unchanged |
| `embed.ts` | `cache.ts` | `putEntry("emb")` | WIRED | embed.ts line 127 |
| `planes/tei.ts` | `service.ts` | `gatedFetch(planes.gate("tei"))` | WIRED | Unchanged in covered set; `service.ts` is outside the covered set; its 6e5d766e hunk (lines 3005-3006, sync-lag) and 42e3cf13 H-1 changes do not touch `fabricSources()` |
| `corpus/neardup.ts` | `similarity.ts` | `nearDuplicates` call | WIRED | Unchanged |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `fabric/status.ts` tei row | `breaker`, `detail.model/dimension/latencyMs` | `facts.services.tei`, `facts.tei` from `gatherFabricFacts` (live snapshot and TEI client facts) | Yes (live breaker read at call time; `answered` from the probe) | ✓ FLOWING |
| `fabric/status.ts` corpus row | `syncLag` reading | `corpusRead` facts (SLO readings) | Yes; `null` reading is not a breach | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Fabric status, tei breaker, compliance, gather, MCP reply, TEI client, embed cache, cache conformance, cache forget-mark breaker test (changed covered file), near-duplicates (server, CLI, library), store lock, flag registry | `env -u SUBSTRATE_TEST_PG_URL TMPDIR=/root/src/worktrees/backups/gate-tmpfs bun test --timeout 30000 packages/mcp-server/src/fabric packages/mcp-server/src/fabric-mcp.test.ts packages/mcp-server/src/planes/tei.test.ts packages/mcp-server/src/embed.test.ts packages/mcp-server/src/cache-conformance.test.ts packages/mcp-server/src/cache-breaker.test.ts packages/mcp-server/src/corpus/neardup.test.ts packages/cli/src/corpus/neardup.test.ts packages/corpus/src/similarity.test.ts packages/mcp-server/src/store-lock.test.ts packages/mcp-server/src/flag-registry.test.ts` (run at 6e5d766e, 14.19 s, one command, non-PG) | 445 pass, 1 skip (live redis branch, `test.skip` at cache-conformance.test.ts:127), 0 fail; 446 tests across 14 files | ✓ PASS |

### Probe Execution

No probes are declared for this phase (not a migration or tooling phase; PLAN/SUMMARY declare none). Step 7c: SKIPPED (no declared probes).

### Postgres evidence

No Postgres-gated file is in this phase's covered set. Checked at 6e5d766e: no covered `.ts` file opens a Postgres connection or reads `SUBSTRATE_TEST_PG_URL`; `flag-registry.ts` line 1124 names the variable only as a registry entry (a string). `store-lock.test.ts` mentions Postgres only in a comment. No PG run was made for this phase; no database was started and production was not touched.

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
| `.planning/ROADMAP.md` (phase 64 lines 129, 1080, 1412, outside covered set) | Status line | Still reads "gaps_found: TEI never contacted live; criterion 3 partial" | ℹ️ Info | Disagrees with this record (human_needed; criterion 3 verified). Not edited here; the roadmap owner decides |

Debt-marker gate: no `TBD`, `FIXME` or `XXX` in any covered file. No `TODO`, `HACK` or `PLACEHOLDER` in any covered file.

### Human Verification Required

These are operator-gated and do not change the verified count. They route the status to `human_needed`.

1. **Live TEI reach.** Test: point `TEI_URL` at a real TEI via a forwarder listed in `SUBSTRATE_DB_PROXY_ALLOW`, restart, call `fabric_status`. Expected: `tei` row `ok`, `detail.model` shows the `/info` model, `breaker` `closed`. Why human: external service; TEI has never been contacted (SUMMARY).
2. **Pins match the live service.** Test: copy the observed model into `SUBSTRATE_TEI_MODEL` and dimension into `SUBSTRATE_TEI_DIM`, then embed a probe text. Expected: no `model-mismatch` or `dim-mismatch`. Why human: the model and dimension are not recorded in the repo; both flags default to `learned`.
3. **Dragonfly `emb` class in production.** Test: `SUBSTRATE_EMBED_CACHE=on`, run `bun scripts/cache-stats.ts`. Expected: `emb` hits and TTLs present. Why human: the production Dragonfly is not reachable from this worktree; the live cache-conformance branch was not run.
4. **Near-duplicate quality.** Test: `substrate corpus plan --neardup` on real documents. Expected: sensible pairs at 0.92. Why human: judgment on real content.

### Gaps Summary

No gaps remain. Criterion 2 is re-audited against the d1a5e89b cache.ts hunk (lines 881-917): the `emb` class, its TTL and its write path are unchanged, and the targeted cache and embed tests pass at 6e5d766e. Criterion 3 (the `tei` row's breaker) stays closed. The covered-file changes since the prior record (cache.ts forget-verdict hunk, docs/corpus.md sentence) do not touch a phase 64 criterion, and their tests pass.

The advisory on SCAN/UNLINK (D64-3) remains open for the owner. Human verification items 1-4 remain open, so the status is `human_needed`, not `passed`.

---

_Verified: 2026-11-05T07:59:23Z_
_Verifier: Claude (gsd-verifier)_
