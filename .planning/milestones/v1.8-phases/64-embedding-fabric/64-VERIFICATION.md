---
phase: 64-embedding-fabric
verified: 2026-11-18T12:20:52Z
status: human_needed
score: 3/4 success criteria verified; criterion 3 partial (tei row carries no explicit breaker or health field)
covered_files: [".planning/phases/64-embedding-fabric/64-CONTEXT.md", ".planning/phases/64-embedding-fabric/64-SUMMARY.md", "packages/cli/src/corpus/neardup.ts", "packages/corpus/src/similarity.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/corpus/neardup.ts", "packages/mcp-server/src/embed.ts", "packages/mcp-server/src/fabric/compliance.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/planes/tei.ts"]
covered_digest: "v3:sha256:2ed6d1181d655d85b6f7da837a4d7de6d915211ad64949f3f0fe73c7e31b7321"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 3 of 4 success criteria MET in the repository, 1 PARTIAL (criterion 3)
  gaps_closed: []
  gaps_remaining:
    - "Criterion 3: breaker and health are reported only through the tei row's derived state, not as their own fields"
  regressions: []
human_verification:
  - test: "Point TEI_URL at a real TEI through the private forwarder and read the fabric tei row"
    expected: "tei row is ok with the live model and dimension; /info returns model_id and max_client_batch_size and /embed accepts the client's body shape; a 429 with Retry-After is honoured"
    why_human: "No live TEI has been contacted. The wire contract is checked only against the fake server in tei.test.ts."
  - test: "Decide whether criterion 3's parenthetical (health, model, dimension, breaker) is met by the current row, or add an explicit breaker reading to the tei row"
    expected: "Either an accepted reading that an open breaker shows as state unavailable and half-open as degraded, or a breaker field added to FabricTeiDetail with a test"
    why_human: "The row has no breaker field. Its effect appears only in state (status.ts serviceState). Whether that suffices is a product decision."
  - test: "Set SUBSTRATE_EMBED_CACHE=on against the production Dragonfly and inspect emb keys"
    expected: "Keys are sha256-named under the emb class, each with a TTL, and a second identical call is a cache hit"
    why_human: "Requires the live Dragonfly. The TTL and key shape are tested only with the fake store in cache-emb.test.ts and embed.test.ts."
  - test: "Run substrate corpus plan --neardup against real documents"
    expected: "Pairs print in the advisory section, the header reads 'no document is dropped on this signal', and the plan writes the same documents as without --neardup"
    why_human: "Requires real documents and the live embedding service."
audit_acknowledged:
  milestone: v1.8
  at: 2026-11-22
  status: human_needed
---

# Phase 64: Embedding fabric: Verification Report

**Phase Goal:** Substrate itself can embed text with the owner's TEI service, cheaply and safely, and uses it to find near-duplicate documents.
**Verified:** 2026-11-18T12:20:52Z
**Status:** human_needed
**Re-verification:** Yes. This replaces the 2026-10-29 record, which read the same phase at ba7cc010 and reported gaps_found.

## Method

Read against the working tree at `357d6b15` (branch `gsd/autonomous-rerun`). `ba7cc010` (PR #183) is an ancestor. The phase's implementation files were last changed in `87903465` (PR #179) or `ba7cc010`, so the code read is the code that shipped.

Tests were located by file and by title or symbol. None were run. The phase's claims are judged on what the code and tests say, not on the SUMMARY.

Corrections to the prior record and SUMMARY:
- `fabric/status.test.ts` line 75 is titled "reports exactly the **nine** resources". The prior record quoted it as "eight". `FABRIC_RESOURCES` (`fabric/types.ts` lines 15-25) has nine entries, and `tei` is the seventh, not the eighth. The SUMMARY repeats the error.

## Goal Achievement

### Observable Truths

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | TEI client batches to `/info` limit, times out, retries with backoff, opens a breaker; model and dimension mismatches refused with a closed reason | ✓ VERIFIED | `packages/mcp-server/src/planes/tei.ts` (`createTeiClient`; `TEI_REASONS` closed set incl. `model-mismatch`, `dim-mismatch`, `timeout`, `breaker-open`). `planes/tei.test.ts`: line 121 "splits to the server's max_client_batch_size, keeps the order and reads /info once"; line 136 "SUBSTRATE_TEI_BATCH lowers the batch below the server's limit..."; line 196 "a 429 is retried after the jittered backoff, and the call then succeeds"; line 205 "successive failures wait exponentially longer..."; line 275 "a request that times out answers timeout at once, with no retry"; line 285 "5xx until the breaker opens ends as breaker-open, and the next call sends nothing" (asserts `registry.gate("tei").breaker` is `open`); line 298 the first-call breaker case; lines 309-374 model/dim mismatch cases. Fake TEI via `fakeTei`. Behavior-dependent (breaker transition) and exercised by named tests, so not downgraded. |
| 2 | `SUBSTRATE_EMBED_CACHE=on` caches vectors in Dragonfly under class `emb`, keyed by model and sha256, every key with a TTL; cache-conformance passes | ✓ VERIFIED | `packages/mcp-server/src/cache.ts` line 56 `emb: 604_800` in `CACHE_TTL`; line 71 `"emb"` in `CACHE_CLASSES`; lines 305-312 key doc (`sha256(model + "\n" + text)`); line 1255 `klass === "emb"` entry validation. `embed.ts` `createEmbeddingService` (one `MGET`, misses embedded in one batch, writes with TTL; dead cache is a miss). `embed.test.ts`: line 128 "a miss embeds and stores under the sha256 key with the TTL..."; line 163 "every write carries the TTL, however many are written"; line 173 "the key names the model..."; line 216 "a dead Redis falls through on read and on write". `cache-emb.test.ts` line 122 refuses wrong-shape writes; line 305 area refuses non-finite vectors. `cache-conformance.test.ts` line 14 `EXPECTED_CLASSES` includes `"emb"`, line 83 builds `emb`. |
| 3 | `fabric_status` has a `tei` resource (health, model, dimension, breaker); compliance fails a TEI URL that is neither loopback nor an allowed proxy; fixtures and order tests updated | ⚠️ PARTIAL, UNCERTAIN (WARNING) | Met: `fabric/types.ts` `FABRIC_RESOURCES` includes `"tei"` (line 19); `fabric/status.ts` `teiRow` (lines 110-116) returns model, modelSource, dimension, latencyMs; `fabric/compliance.ts` `teiEndpointCheck` (id `tei-endpoint-private`, FAIL for a direct endpoint, PASS for loopback or proxy, NOT_APPLICABLE when unset); `compliance.test.ts` line 45 "a TEI URL that is neither loopback nor an allowed proxy fails the TEI endpoint check..."; `status.test.ts` line 75 "reports exactly the nine resources, in report order, tei between hindsight and the proxy layer, the corpus last", lines 83-99 cover unconfigured, healthy, and breaker-open (unavailable) and half-open (degraded); `fixtures.ts` line 36 carries the tei reading. Not met as written: the row has no `breaker` field and no `health` field (`types.ts` `FabricTeiDetail` lines 52-57 is model, modelSource, dimension, latencyMs). Breaker and health reach the operator only through `state` (`status.ts` `serviceState` lines 33-39). Judged as a reporting-shape question for a human, not a FAILED truth, because the breaker effect is real, tested, and visible. |
| 4 | `nearDuplicates` in `@substrate/corpus` returns pairs above a threshold with similarity; `POST /corpus/neardup` embeds excerpts through the TEI client; `substrate corpus plan --neardup` prints them; no document dropped on that signal | ✓ VERIFIED | `packages/corpus/src/similarity.ts` `nearDuplicates` (line 144) and `nearDuplicatesYielding`. `packages/mcp-server/src/corpus/neardup.ts` header: "The signal is advisory. Nothing here ... drops, skips or tombstones anything." `server.ts` line 331 (`"/corpus/neardup": true`), line 1763 (route). `mcp-server/src/corpus/neardup.test.ts`: line 151 "a pair at or above the threshold is returned...", line 177 order-independence, line 262 "when the embedding service cannot answer", line 293 "a large comparison does not hold the event loop". `packages/cli/src/corpus/index.ts` lines 6, 20-21, 98, 294 (`--neardup`, advisory). `cli/src/corpus/index.test.ts` line 872 sends one request, prints the advisory section, and line 890 asserts the header "no document is dropped on this signal". |

**Score:** 3/4 criteria verified; criterion 3 partial. `behavior_unverified: 0`.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/planes/tei.ts` | TEI client | ✓ VERIFIED | Present, substantive, wired via `embed.ts` and `fabric/gather.ts` (`parts.tei`, line 67) |
| `packages/mcp-server/src/embed.ts` | Embedding service with cache | ✓ VERIFIED | Present; the single embed door |
| `packages/mcp-server/src/cache.ts` | `emb` class | ✓ VERIFIED | `CACHE_TTL.emb`, `CACHE_CLASSES`, read/write validation |
| `packages/mcp-server/src/fabric/{types,status,gather,compliance,fixtures}.ts` | tei resource and check | ✓ VERIFIED (criterion 3 partial) | Row present; breaker and health not separate fields |
| `packages/observability/src/breaker.ts` | `AUX_PLANES = ["tei"]` | ✓ VERIFIED | line 34 |
| `packages/corpus/src/similarity.ts` | `nearDuplicates` | ✓ VERIFIED | line 144, plus `nearDuplicatesYielding` |
| `packages/mcp-server/src/corpus/neardup.ts` | route handler | ✓ VERIFIED | advisory, no drop |
| `packages/cli/src/corpus/neardup.ts`, `index.ts` | `plan --neardup` | ✓ VERIFIED | advisory print |
| `packages/mcp-server/src/store-lock.test.ts` | TEI isolation locks | ✓ VERIFIED | line 591 "TEI is reachable only through substrate-mcp"; line 612 no committed TEI credential |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `embed.ts` | `planes/tei.ts` | `createTeiClient` embed call | ✓ WIRED | Summary and test coverage (`embed.test.ts`) |
| `embed.ts` | `cache.ts` `emb` | `peekMany` / `putEntry` | ✓ WIRED | `cache-emb.test.ts` exercises both |
| `fabric/gather.ts` | `planes/tei.ts` | `parts.tei` probe | ✓ WIRED | `gather.ts` lines 61-67, 131-137 |
| `fabric/status.ts` tei row | `FabricTeiDetail` | `teiRow` detail | ✓ WIRED | detail set only when configured |
| `server.ts` | `corpus/neardup.ts` | `POST /corpus/neardup` | ✓ WIRED | line 1763 |
| `cli corpus plan --neardup` | `POST /corpus/neardup` | `neardupRequest` | ✓ WIRED | `cli/src/corpus/index.ts` line 63, `index.test.ts` line 872 |

### Anti-Patterns

No TODO, FIXME, placeholder, or stub markers were found in the phase's implementation files during the read. Scope was limited to the files listed in covered_files.

### Requirements Coverage

EMB-01 (TEI client): ✓ SATISFIED by criterion 1. EMB-02 (cache class): ✓ SATISFIED by criterion 2. EMB-03 (fabric row and check): ⚠️ SATISFIED with criterion 3 partial. EMB-04 (near-duplicates): ✓ SATISFIED by criterion 4.

## Residual Risks

- **Criterion 3:** an operator cannot tell an open breaker from a failed `/health` in `fabric_status` alone; both read as `unavailable`/`degraded` state.
- The TEI wire contract (`/embed` body, `/info` `model_id` and `max_client_batch_size`, `Retry-After`) is checked only against the fake server. TEI has never been contacted live.
- The compliance check classifies the URL (loopback, listed proxy, direct). It cannot see that a loopback forwarder leads to a private service.
- Near-duplicate comparison is pairwise (cap 5000 items in `similarity.ts`; request cap 1000 excerpts). A document whose first 4000 characters match another's is reported even if the rest differs.

## Operator-Gated (human_needed)

These need a live operator action and are not gaps:
1. Pointing `TEI_URL` at a real TEI through the private forwarder, and reading its model and dimension from the fabric row.
2. Enabling `SUBSTRATE_EMBED_CACHE=on` against the production Dragonfly and inspecting the `emb` class keys and TTLs.
3. Running `substrate corpus plan --neardup` against real documents.

Runbook: `docs/embedding-fabric.md`, section "Turning it on".

## Human Verification Required

### 1. Live TEI contact

**Test:** Point `TEI_URL` at the real TEI through the private forwarder; read the fabric `tei` row.
**Expected:** Row is `ok` with the live model and dimension. `/info` returns `model_id` and `max_client_batch_size`, `/embed` accepts the client body, a 429 with `Retry-After` is honoured.
**Why human:** No live TEI has been contacted.

### 2. Criterion 3 reporting shape

**Test:** Decide whether the current `tei` row (state-folded breaker and health, plus model, dimension, latency) satisfies criterion 3, or add an explicit breaker reading.
**Expected:** Either accept the state mapping (open shows `unavailable`, half-open shows `degraded`) or add a `breaker` field to `FabricTeiDetail` with a test.
**Why human:** A product decision about what the operator must see.

### 3. Cache on against production Dragonfly

**Test:** Set `SUBSTRATE_EMBED_CACHE=on`, make the same call twice, inspect `emb` keys.
**Expected:** sha256-named keys under the `emb` class, each with a TTL; the second call is a hit.
**Why human:** Needs the live store.

### 4. Near-duplicates on real documents

**Test:** Run `substrate corpus plan --neardup` on real documents.
**Expected:** Pairs print under the advisory header; the plan writes the same documents as without `--neardup`.
**Why human:** Needs real documents and the live embedding service.

## Gaps Summary

No BLOCKER. The phase goal is achieved in code and is covered by named tests against a fake TEI and a fake Redis/Dragonfly. The status is `human_needed` because:
- criterion 3's parenthetical (breaker and health as explicit fields) is partially met and needs a decision, and
- the live TEI, live cache, and real-document checks are operator-gated.

This verdict differs from the prior record's `gaps_found`. The only shortfall that prior record named was criterion 3, and it is a reporting-shape question, not a missing or unwired behavior.

---

_Verified: 2026-11-18T12:20:52Z_
_Verifier: Claude (gsd-verifier)_
