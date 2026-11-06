---
phase: 64-embedding-fabric
verified: 2026-11-06T02:57:34Z
status: human_needed
score: 4/4 must-haves verified
covered_files: [".planning/phases/64-embedding-fabric/64-SUMMARY.md","docs/corpus.md","docs/data-planes.md","docs/embedding-fabric.md","packages/cli/src/corpus/client.ts","packages/cli/src/corpus/index.ts","packages/cli/src/corpus/neardup.test.ts","packages/cli/src/corpus/neardup.ts","packages/cli/src/corpus/render.ts","packages/corpus/src/protocol.ts","packages/corpus/src/similarity.test.ts","packages/corpus/src/similarity.ts","packages/mcp-server/src/cache-breaker.test.ts","packages/mcp-server/src/cache-conformance.test.ts","packages/mcp-server/src/cache.test.ts","packages/mcp-server/src/cache.ts","packages/mcp-server/src/config.ts","packages/mcp-server/src/corpus/neardup.test.ts","packages/mcp-server/src/corpus/neardup.ts","packages/mcp-server/src/corpus/validate.ts","packages/mcp-server/src/db-endpoints.ts","packages/mcp-server/src/embed.test.ts","packages/mcp-server/src/embed.ts","packages/mcp-server/src/fabric-mcp.test.ts","packages/mcp-server/src/fabric/compliance.test.ts","packages/mcp-server/src/fabric/compliance.ts","packages/mcp-server/src/fabric/fixtures.ts","packages/mcp-server/src/fabric/gather.test.ts","packages/mcp-server/src/fabric/gather.ts","packages/mcp-server/src/fabric/status.test.ts","packages/mcp-server/src/fabric/status.ts","packages/mcp-server/src/fabric/types.ts","packages/mcp-server/src/flag-registry.ts","packages/mcp-server/src/planes/tei.test.ts","packages/mcp-server/src/planes/tei.ts","packages/mcp-server/src/server.ts","packages/mcp-server/src/store-lock.test.ts","packages/observability/src/breaker.ts"]
covered_digest: "v3:sha256:9cb4837aac309d8f2160804a084f19ee73ac37517ab3d79fc798b6fbd38a9c8e"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 4/4
  previous_covered_digest: "v3:sha256:5dba4a575b28a9b7a0c2cafaee4956ddad40f8ba5559e48710e27f01027113a0"
  gaps_closed: []
  gaps_remaining: []
  regressions: []
advisory:
  - finding: "cache.ts issues SCAN and UNLINK (bunRedis run union at line 418; scanKeys at 1084, unlinkKeys at 1110); D64-3 says no new redis command"
    category: architectural
    reason: "Not in phase 64's tree. At 87903465 bunRedis ran get, mget, set, incr and eval only. SCAN and UNLINK were added by 3ad7bc12 feat(78) (2026-11-02) for the reconcile report and its confirmed repair, after this phase closed. The emb class uses only MGET (readAll, cache.ts:1241-1245, reached from peekMany) and SET (writeKey, cache.ts:1044). The test 'bunRedis commands are get, mget, set, incr, and eval' (cache-conformance.test.ts:102) asserts that the string '\"get\" | \"mget\" | \"set\" | \"incr\" | \"eval\"' occurs in cache.ts; the union at line 418 contains it as a prefix, so the test passes with SCAN and UNLINK present and does not enforce D64-3. Owner item open (2026-11-06)."
    evidence_status: "read at 5e304ef8; git log -S on UNLINK and SCAN in cache.ts gives 3ad7bc12 only; the test title is 'pass' in gate r38 JUnit."
  - finding: "withDeadline's reporting branch (cache.ts:717) has no test; a late rejection after a positive budget is still silent"
    category: test-coverage
    reason: "f0f3c04e changed only the ms <= 0 branch (cache.ts:715-718) to call reportSilent('cache.deadline-load', cause). No JUnit testcase names that site, and no test passes deadlineMs <= 0 with onDeadline (cache.test.ts uses deadlineMs 25 and 5_000 with onDeadline at lines 1663-1725, and 1 without it at line 1766). The ms > 0 race (cache.ts:723-724) still drops a load's rejection after the timer has won, because Promise.race attaches a handler to the load. This is outside every phase 64 truth; the emb path does not reach withDeadline."
    evidence_status: "read at 5e304ef8 (cache.ts:694, 701, 715-724); JUnit grep for 'deadline-load' and 'cache.deadline' returns nothing; the ms > 0 behaviour follows from Promise.race semantics, not from running code."
  - finding: "The no-drop clause of truth 4 ('no document is dropped on that signal alone') has no testcase that names it"
    category: test-coverage
    reason: "Evidence is code reading: cli/src/corpus/index.ts plan() (lines 672-705) prints the plan unchanged and appends the near-duplicate section; mcp-server/src/corpus/neardup.ts header (line 5) says the signal is advisory. The JUnit tests for the pairs and the skip list pass but do not assert the no-drop property."
    evidence_status: "read at 5e304ef8; not a test."
  - finding: "Naming drift: status.ts line 92 says 'The eight rows' and status.test.ts:208 is titled 'counts add up to the eight rows'; the code and the bodies use nine (FABRIC_RESOURCES)"
    category: maintainability
    reason: "Comment and title only; the assertions use FABRIC_RESOURCES.length and pass. Still present at 5e304ef8."
    evidence_status: "grep at 5e304ef8; JUnit title present and passing in gate r38."
  - finding: "No test drives the emb path during the connect cooldown (f1266a9c changed what a cooldown refusal is)"
    category: test-coverage
    reason: "f1266a9c makes the cooldown refusal a CacheCooldownError (cache.ts:342, raised at 420-421, mapped to breakerRetryAfterMs in script at 1074). The emb path is fail-open by code reading: peekMany's catch returns the misses (cache.ts:1010-1012) and writeKey's catch returns false (:1047-1049), so embed.ts calls TEI. The cooldown test 'during the connect cooldown a fail-closed read is refused without a connect attempt' (cache.test.ts) covers a fail-closed class, not emb; no embed.test.ts title mentions a cooldown."
    evidence_status: "read at 5e304ef8; the cooldown test title is 'pass' in gate r38 JUnit; grep for 'cooldown' in embed.test.ts returns nothing."
human_verification:
  - test: "Live TEI reach: point TEI_URL at a real TEI via a forwarder listed in SUBSTRATE_DB_PROXY_ALLOW, restart, call fabric_status"
    expected: "tei row state ok, detail.model shows the /info model, breaker closed"
    why_human: "External service; TEI has never been contacted live (SUMMARY). Owner item open (2026-11-06)."
  - test: "Pins match the live service: copy the observed model into SUBSTRATE_TEI_MODEL and dimension into SUBSTRATE_TEI_DIM, then embed a probe text"
    expected: "No model-mismatch or dim-mismatch"
    why_human: "The model and dimension are not recorded in the repo; both flags default to 'learned' (flag-registry.ts lines 807-808)"
  - test: "Dragonfly emb class in production: SUBSTRATE_EMBED_CACHE=on, run bun scripts/cache-stats.ts; and the live cache-conformance branch with SUBSTRATE_CONFORMANCE_REDIS_URL set to a loopback Redis"
    expected: "emb hits and TTLs present; 'live loopback redis matches the command set' passes instead of skipping"
    why_human: "The production Dragonfly is not reachable from this worktree; in gate r38 JUnit the only live-branch testcase is the skipped 'live loopback redis (SUBSTRATE_CONFORMANCE_REDIS_URL unset)', and the matching-commands testcase is registered only when that variable is set"
  - test: "Near-duplicate quality: substrate corpus plan --neardup on real documents"
    expected: "Sensible pairs at 0.92"
    why_human: "Judgment on real content"
---

# Phase 64: Embedding fabric Verification Report

**Phase Goal:** Substrate itself can embed text with the owner's TEI service, cheaply and safely, and uses it to find near-duplicate documents.
**Verified:** 2026-11-06T02:57:34Z
**Status:** human_needed
**Re-verification:** Yes. Previous record: a46d42c3 (human_needed, 4/4). This pass reads code head `5e304ef8` (worktree clean at the read). The stored `covered_files` and `covered_digest` are carried over unchanged, as the brief requires; the orchestrator recomputes them. Their file list does not yet name `packages/mcp-server/src/cache.test.ts`, which this record now cites (advisory 5 and the changes table).

**Owner decisions (2026-11-06):** No owner decision text for phase 64 was supplied with the brief or is in the repository. Two items are open and recorded here with that date:
1. Cache adapter SCAN and UNLINK versus D64-3 ("no new redis command"). Open. The command set was widened by phase 78 (3ad7bc12), not by this phase. The owner must either amend D64-3 to allow the reconcile path's SCAN and UNLINK, or move them out of the `emb` cache adapter. Advisory 1.
2. Live TEI proof is operator-only. Open. TEI has not been contacted live, and the model and dimension pins are not recorded in the repo. Human items 1 and 2.

For the record, not an open item: CONTEXT.md D64-2 says the model and dimension are "pinned by flag"; SUMMARY.md "D64-2 refined" and flag-registry.ts (lines 807-808, default `learned`) say a pin is optional and the first `/info` answer is learned and held.

**Must-haves:** no PLAN.md exists for this phase; the truths are the four ROADMAP Phase 64 success criteria. Requirements EMB-01 to EMB-04 are mapped to this phase in REQUIREMENTS.md.

**Evidence policy for this pass:** no tests, tsc, lint or services were run (brief). Test evidence is the gate r38 JUnit at `/root/src/worktrees/backups/gate-r38-junit.xml`, which ran on `66fa97bd`. Its one failure was the `as_unknown_as` ratchet check ("the ratchet is tight: no source counter sits below its baseline"), fixed at `5e304ef8` by lowering `scripts/code-ratchet.baseline.json` to 22. Its skipped testcases are `live loopback redis (SUBSTRATE_CONFORMANCE_REDIS_URL unset)` and `D-04 fixtures do not survive the write path while counts do` (redact.test.ts). The r39 gate on `5e304ef8` was not yet written when this pass checked the backups directory, so no pass count is claimed. Each cited test title was grepped in source and matched to an r38 JUnit testcase with no failure, error or skipped child, except where listed under "Titles not matched" below.

## Changes since the last record (a46d42c3..5e304ef8)

Of the covered set, these 18 files changed (`git diff a46d42c3 5e304ef8 -- <covered files>`). `cache-conformance.test.ts` did not change in this range:

| File | Commit(s) | Change | Phase 64 impact |
| ---- | --------- | ------ | --------------- |
| `packages/mcp-server/src/cache.ts` | f1266a9c, b8cbdeac | f1266a9c: the connect-cooldown refusal is now a `CacheCooldownError` (line 342), raised in `bunRedis`'s `run` before any socket is touched (lines 420-421); `script` maps it to `breakerRetryAfterMs` (line 1074). The `emb` class is not touched. b8cbdeac: `export` removed from self-only declarations. | Criterion 2 re-audited. `emb` reads and writes go through `peekMany` and `writeKey`, both of which fall through on the refusal (see criterion 2). No test drives that path (advisory 5). |
| `packages/mcp-server/src/embed.ts` | e62bc17b | The peek's `.catch` (line 88) now calls `reportSilent("embed.cache-peek", cause)` before returning `[]` (line 90). | None. The return value is unchanged: a failed peek still falls through to TEI. |
| `packages/mcp-server/src/planes/tei.ts` | b8cbdeac | `export` removed from `TeiReason`, `TeiInfo`, `TeiInfoResult`, `TeiHealthResult`, `TeiSnapshot`, `TEI_MODEL_SOURCES`, `BACKOFF_BASE_MS`. Same line count; no value changed. | None. `TEI_REASONS`, `backoffMs`, `BACKOFF_CAP_MS` and the client stay exported. |
| `packages/mcp-server/src/config.ts` | b8cbdeac, 5e304ef8, others | `export` removed from `DEFAULT_TEI_TIMEOUT_MS`, `DEFAULT_TEI_BATCH`, `DEFAULT_EMBED_CACHE_TTL_S`, `EmbedCacheSettings` and other self-only constants and types. 5e304ef8 also removes it from `DEFAULT_LIGHTRAG_PLANNING_ROOTS`. No value changed. | None. |
| `packages/mcp-server/src/server.ts` | 14ac787a, b8cbdeac | 14ac787a: a REST `/handoff` whose `to` is not in `SURFACES` answers 400 before the claim is remembered (about line 1507). `export` removed from self-only constants. | None. No hunk touches a fabric, tei, emb or neardup route. |
| `packages/mcp-server/src/db-endpoints.ts` | e62bc17b | Two comments added (lines 71 and 89); no code change. | None. |
| `packages/mcp-server/src/fabric/status.ts`, `fabric/types.ts`, `fabric/gather.ts` | b8cbdeac | `export` removed from `serviceState`, `proxyRow`, `FabricTeiDetail`, `SloLine`, `CorpusSloFacts`, `CostReading`, `Read<T>`. Behaviour unchanged. | None. `teiRow` (status.ts:112-116) and gather.ts:135 are untouched. |
| `packages/mcp-server/src/flag-registry.ts` | b8cbdeac | Types no longer exported. | None. The TEI and EMBED flag lines are unchanged (607-608, 807-808). |
| `packages/corpus/src/protocol.ts`, `similarity.ts`; `packages/cli/src/corpus/client.ts`, `index.ts`, `neardup.ts`, `render.ts`; `packages/mcp-server/src/corpus/validate.ts`; `packages/observability/src/breaker.ts` | 4c576e5e (corpus), d9d0a401 (cli), b8cbdeac (validate), 66fa97bd (breaker) | `export` removed from declarations no code outside their file uses. | None. `nearDuplicates` (similarity.ts:144) and `corpusNeardupReply` (neardup.ts:66) remain exported. The removed symbols have no importer (static check below). |

Outside the covered set, checked for overlap with criteria 1 to 4:

- `packages/mcp-server/src/service.ts` (not in the covered set): the hunks are `export` removals, plus one corpus hunk (line 6421, `manifestCommit` now returns the row type `ManifestCommitRecord` that docs-search.ts:362 expects) that is outside phase 64. No changed line mentions tei, fabric, neardup, embed or emb. The TEI gate (`this.planes.gate("tei")`, line 1950) and `fabricSources()` (lines 9147 to 9210, including `tei:` at 9166 and 9175 and `breakers.tei` at 9177) are outside every hunk.
- `packages/cli/src/index.ts` (14ac787a): CLI handoff exits 1 on a refusal. No phase 64 command is in that hunk.
- `packages/mcp-server/src/memory-retain.ts` (a2176f96), `docs/ci.md` (cf4ea4c1), `packages/mcp-server/src/http.test.ts` (14ac787a) and the other silent-catch sites (e62bc17b): none is a phase 64 file or touches a phase 64 path, except `embed.ts` noted above.
- Removed exports, all of them (a46d42c3..5e304ef8, 121 names from the covered files): a static scan of every tracked `packages/**/*.ts` and `scripts/*.ts` import clause and re-export finds no importer of any removed name. The only name match is `parseScope`, which is `memory-policy.ts`'s export and not `corpus/validate.ts`'s private function. `Parsed` in `cli/src/corpus/index.ts` is imported from `./flags.ts`. `BACKOFF_BASE_MS` in `collectors/src/spool.ts` and `mcp-server/src/retain-outbox.ts` is a local constant. No covered test imports a removed symbol.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | TEI client batches to the server limit, times out, retries with backoff, opens a breaker; model or dimension other than the pins is refused with a closed reason; fake covers each path | ✓ VERIFIED (carried forward; re-checked at 5e304ef8) | `planes/tei.ts` changed since a46d42c3 only by `export` removals (same line count). `TEI_REASONS` (tei.ts:29, eight reasons); `backoffMs` (:190); `AbortSignal.timeout` (:248, :315); batch `Math.max(1, Math.min(config.batch, batchLimit ?? config.batch))` (:392); model refusals (:346, :353, :357, :405, :430); dimension refusals (:185, :402). JUnit (r38), `tei.test.ts`: "splits to the server's max_client_batch_size, keeps the order and reads /info once"; "SUBSTRATE_TEI_BATCH lowers the batch below the server's limit, and the server's limit lowers it below the flag"; "a 429 is retried after the jittered backoff, and the call then succeeds"; "successive failures wait exponentially longer, and a 5xx that never clears ends as unavailable after the attempt bound"; "a request that times out answers timeout at once, with no retry"; "5xx until the breaker opens ends as breaker-open, and the next call sends nothing"; "a TEI that serves another model than the pin is refused before any vector is requested"; "a vector of another length than the pinned dimension is refused, on every response"; "the closed reason list is exactly the eight the callers switch on"; "a transport error is retried, and one that persists is unavailable without its text". All pass. |
| 2 | `SUBSTRATE_EMBED_CACHE=on` caches vectors in Dragonfly under class `emb`, keyed by model and sha256, every key TTL'd, cache-conformance test passes | ✓ VERIFIED (re-audited at 5e304ef8); D64-3 open with the owner (advisory 1) | `CACHE_TTL.emb = 604_800` (cache.ts:57); `CACHE_CLASSES` includes `"emb"` (:71); the `emb` value check (:1278) and `emb` entry format (:1312, `embeddingEntryOk` at :1316) are outside every diff hunk. `embed.ts` depends on `Pick<ReadThroughCache, "peekMany" \| "putEntry">` (:21), calls `peekMany` (:84) and `putEntry("emb", embeddingDigest(model, text), …, deps.ttlS)` (:131); digest `sha256(model + "\n" + text)` (embed.ts:49-51). The commands the `emb` class issues are MGET (`readAll`, cache.ts:1241-1245, via `peekMany`) and SET (`writeKey`, :1044); `putEntry` is `writeKey`. Under the connect cooldown (f1266a9c) both fall through: `peekMany`'s catch returns the misses (:1010-1012) and `writeKey`'s catch returns false (:1047-1049), so `embed.ts` calls TEI. `peekMany` and `putEntry` do not reach `withDeadline`, whose only call sites are `loadShared` (cache.ts:694, :701), so the f0f3c04e reporting change cannot alter the `emb` path. JUnit (r38), `embed.test.ts`: "every write carries the TTL, however many are written"; "the key names the model: another model never reads these vectors"; "a dead Redis falls through on read and on write"; "a cache store that throws is treated as a miss and a refused write"; "the digest is the sha256 of the model, a newline and the text"; "a failed TEI call returns its reason and writes nothing". JUnit (r38), `cache-conformance.test.ts`: "closed key classes exclude an idempotency mirror"; "bunRedis commands are get, mget, set, incr, and eval" (passes by substring; see advisory 1); "admission does not carry an idempotency payload key". The live case is skipped in r38 (testcase "live loopback redis (SUBSTRATE_CONFORMANCE_REDIS_URL unset)"). The title "docs keep the idempotency mirror as a target, not a current key" was removed in f0f3c04e and is not in source. |
| 3 | `fabric_status` has a `tei` resource (health, model, dimension, breaker); compliance fails a non-private TEI URL; fixtures and order tests updated | ✓ VERIFIED (carried forward; tei row unchanged in behaviour at 5e304ef8) | `fabric/status.ts` `teiRow` (lines 112-116) sets `breaker: facts.services.tei.breaker` (:116); `fabric/gather.ts` line 135 `breaker: breakerOf(breakers.tei)`; `fabric/compliance.ts` `teiEndpointCheck` (line 72) fails a direct endpoint under policy and is not applicable when unset. `service.ts` `fabricSources()` (9147 to 9210) lies outside every hunk. `db-endpoints.ts` gained two comments only. JUnit (r38): "an open TEI breaker is reported on the row, and the row is still unavailable" (`status.test.ts`); "a closed TEI breaker is reported as closed, and the row is ok"; "reports exactly the nine resources, in report order, tei between hindsight and the proxy layer, the corpus last"; "a configured TEI that does not answer or whose breaker is open is unavailable, a half-open one degraded"; "a TEI with no pin and no embed yet still shows the model /info named, and says it was only observed"; "a TEI URL that is neither loopback nor an allowed proxy fails the TEI endpoint check; loopback and proxy pass; unset is not applicable"; "fabric_status reports the nine resources, and a resource nothing configures is never ok" (`fabric-mcp.test.ts`); "a TEI URL that is neither loopback nor allowed is a direct endpoint: the row says so, the compliance check fails, and no host is printed; an allowed proxy passes"; "the embedding service rides the tei plane's breaker: open, it answers breaker-open without a request; the fabric reads it; the six reported planes are unchanged"; "an open TEI breaker makes the row unavailable even though the last probe answered" (`gather.test.ts`). All pass. |
| 4 | `nearDuplicates` in `@substrate/corpus` returns pairs above a threshold with similarity; `POST /corpus/neardup` embeds excerpts through TEI client; `substrate corpus plan --neardup` prints pairs; no document dropped on that signal alone | ✓ VERIFIED (carried forward; no-drop clause by code reading, advisory 3) | `corpus/src/similarity.ts:144` `nearDuplicates`; `mcp-server/src/corpus/neardup.ts:66` `corpusNeardupReply`; `cli/src/corpus/index.ts` `plan()` (672-705). `similarity.ts` and `mcp-server/src/corpus/neardup.ts` are unchanged since ba7cc010 apart from `export` removal; the CLI changes in range are `export` removals. JUnit (r38): "returns every pair at or above the threshold, most similar first, ties by key, never the zero vector" (`similarity.test.ts`); "the threshold is inclusive and a high one leaves only the identical direction"; "a pair at or above the threshold is returned and one below it is not, with the default threshold 0.92"; "nothing to embed is a 200 that never calls the embedding service and names no model" and "no reply, success or failure, carries an excerpt" (`corpus/neardup.test.ts`); "leaves the threshold out when none was given, so the server's default applies" (`cli/src/corpus/neardup.test.ts`). All pass. |

**Score:** 4/4 truths verified (0 present-behavior-unverified, 0 overrides).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planes/tei.ts` | TEI client | ✓ VERIFIED | Changed since a46d42c3 only by `export` removals; `tei.test.ts` titles pass |
| `packages/mcp-server/src/embed.ts` | Cached embedding path, `emb` class | ✓ VERIFIED | Changed by e62bc17b (reporting only); `embed.test.ts` titles pass |
| `packages/mcp-server/src/cache.ts` | `emb` class with TTL, `putEntry`, `withDeadline` | ✓ VERIFIED | Changed by f1266a9c (cooldown error type; `emb` path fail-open) and b8cbdeac (exports); `emb` lines unchanged |
| `packages/mcp-server/src/fabric/status.ts` | `tei` row with breaker | ✓ VERIFIED | `teiRow` (112-116) unchanged; `export` removal only |
| `packages/mcp-server/src/fabric/types.ts` | `breaker?` on resource status | ✓ VERIFIED | `FabricTeiDetail` unchanged in behaviour; `export` removals only |
| `packages/mcp-server/src/fabric/gather.ts` | `breakers.tei` mapped into facts | ✓ VERIFIED | Line 135; `Read<T>` no longer exported |
| `packages/mcp-server/src/fabric/compliance.ts` | TEI endpoint check | ✓ VERIFIED | `teiEndpointCheck` at line 72; not in change set |
| `packages/corpus/src/similarity.ts` | `nearDuplicates` | ✓ VERIFIED | Line 144; `export` removals only |
| `packages/mcp-server/src/corpus/neardup.ts` | `POST /corpus/neardup` path | ✓ VERIFIED | `corpusNeardupReply` (66); not in change set |
| `packages/cli/src/corpus/index.ts` | `plan --neardup` section | ✓ VERIFIED | `plan()` 672-705; `export` removals only |
| `packages/mcp-server/src/flag-registry.ts` | Flag entries for TEI, cache | ✓ VERIFIED | Lines 607-608 and 807-808 unchanged; type exports removed |
| `packages/mcp-server/src/cache-conformance.test.ts` | Static conformance cases | ✓ VERIFIED (static) / ⚠ live skipped | Three static titles pass in r38; the live title is skipped (operator-gated) |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `fabric/gather.ts` | `fabric/status.ts` | `tei` facts: `breakers.tei` → `teiRow` breaker | WIRED | gather.ts:135; status.ts:112-116 |
| `service.ts` `fabricSources()` | `gatherFabricFacts` | `breakers.tei`, `tei` facts | WIRED | service.ts 9166-9177, 9200; no hunk in range |
| `fabric/status.ts` | `fabric_status` MCP reply | `resources` JSON | WIRED | unchanged |
| `embed.ts` | `cache.ts` | `peekMany`, `putEntry("emb")` | WIRED | embed.ts:84, :131 |
| `planes/tei.ts` | `service.ts` | `gatedFetch(planes.gate("tei"))` | WIRED | service.ts:1950 |
| `corpus/neardup.ts` | `similarity.ts` | `nearDuplicates` call | WIRED | unchanged |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `fabric/status.ts` tei row | `breaker`, `detail.model/dimension/latencyMs` | `facts.services.tei`, `facts.tei` from `gatherFabricFacts` | Yes (live breaker read at call time; answer from the probe) | ✓ FLOWING |
| `fabric/status.ts` corpus row | `syncLag` reading | corpus SLO facts | Yes; `null` reading is not a breach | ✓ FLOWING |

### Behavioral Spot-Checks

No command was run in this pass (brief: no tests, tsc, lint or services). The JUnit titles above are the evidence. Checks done by reading:

- The `ms > 0` late-rejection claim in advisory 2 follows from `Promise.race` semantics, not from an execution.
- The `emb` isolation (criterion 2) follows from the call graph: `withDeadline` has two call sites, both in `loadShared`; `emb` uses only `peekMany` (MGET) and `putEntry` (SET).
- The cooldown fall-through for `emb` (advisory 5) follows from the catch sites in `peekMany` and `writeKey`.
- The `bunRedis` command set at 87903465 and at 5e304ef8 (`git log -S` on `UNLINK` and `SCAN`).

### Probe Execution

No probes are declared for this phase (PLAN/SUMMARY declare none). Step 7c: SKIPPED.

### Postgres evidence

No Postgres-gated test title is cited for this phase. No covered file opens a Postgres connection.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| EMB-01 | (none; ROADMAP-only phase) | TEI client with batching, timeout, retry, breaker; refuses model/dim mismatch | ✓ SATISFIED | Truth 1 |
| EMB-02 | (none) | Dragonfly cache by model and content hash, every key TTL'd | ✓ SATISFIED | Truth 2 (static conformance; live branch skipped; D64-3 open with the owner) |
| EMB-03 | (none) | `fabric_status` reports TEI health, model, dimension; compliance names a non-private endpoint | ✓ SATISFIED | Truth 3 |
| EMB-04 | (none) | Near-duplicates by cosine similarity; plan output shows them; no document dropped on that signal | ✓ SATISFIED | Truth 4 |

ORPHANED requirements: none. REQUIREMENTS.md maps EMB-01 to EMB-04 to phase 64 and all four are claimed here.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/cache.ts` | 418, 443-444 | SCAN and UNLINK in the `bunRedis` run union and adapter | ⚠️ Warning | Advisory 1 (D64-3, owner item); not a failure of criterion 2 |
| `packages/mcp-server/src/cache.ts` | 717 | Reporting line with no test on the `ms <= 0` branch; `ms > 0` late rejection still silent | ⚠️ Warning | Advisory 2; outside phase 64 truths |
| `packages/mcp-server/src/cache.ts` | 1010-1012, 1047-1049 | `emb` fall-through on refusal, not exercised by any test | ℹ️ Info | Advisory 5 |
| `packages/mcp-server/src/fabric/status.ts` | 92 | "The eight rows in report order"; the function returns nine | ℹ️ Info | Comment drift; advisory 4 |
| `packages/mcp-server/src/fabric/status.test.ts` | 208 | Title "counts add up to the eight rows"; body uses `FABRIC_RESOURCES.length` (nine) | ℹ️ Info | Title drift; advisory 4 |

Debt-marker gate: no `TBD`, `FIXME` or `XXX` in any covered file; no `TODO`, `HACK` or `PLACEHOLDER` added by the changes above.

### Titles not matched

These cited strings are not testcases in gate r38, or do not exist as test titles. They are listed so the orchestrator does not count them as evidence.

- `live loopback redis matches the command set`: exists in `cache-conformance.test.ts`, but is registered only when `SUBSTRATE_CONFORMANCE_REDIS_URL` is set, so it has no testcase in r38. Human item 3.
- `The eight rows in report order`: a source comment (status.ts:92), not a test title.
- `docs keep the idempotency mirror as a target, not a current key`: removed in f0f3c04e; not in source.
- `cache.deadline-load`: a `reportSilent` site name, not a test title.
- `gaps_found: TEI never contacted live; criterion 3 partial`: a ROADMAP.md status string (line 1080), not a test title. It disagrees with this record; the roadmap owner decides.

### Human Verification Required

These are operator-gated and do not change the verified count. They route the status to `human_needed`.

1. **Live TEI reach.** Test: point `TEI_URL` at a real TEI via a forwarder listed in `SUBSTRATE_DB_PROXY_ALLOW`, restart, call `fabric_status`. Expected: `tei` row `ok`, `detail.model` shows the `/info` model, `breaker` `closed`. Why human: external service; TEI has never been contacted (SUMMARY). Owner item open (2026-11-06).
2. **Pins match the live service.** Test: copy the observed model into `SUBSTRATE_TEI_MODEL` and dimension into `SUBSTRATE_TEI_DIM`, then embed a probe text. Expected: no `model-mismatch` or `dim-mismatch`. Why human: the model and dimension are not recorded in the repo; both flags default to `learned`.
3. **Dragonfly `emb` class and the live conformance branch.** Test: `SUBSTRATE_EMBED_CACHE=on`, run `bun scripts/cache-stats.ts`; and set `SUBSTRATE_CONFORMANCE_REDIS_URL` to a loopback Redis. Expected: `emb` hits and TTLs present; "live loopback redis matches the command set" passes instead of skipping. Why human: the production Dragonfly is not reachable from this worktree; in r38 the live branch is skipped.
4. **Near-duplicate quality.** Test: `substrate corpus plan --neardup` on real documents. Expected: sensible pairs at 0.92. Why human: judgment on real content.

### Gaps Summary

No gaps in the four criteria. Every phase 64 truth is verified by carried-forward or re-audited evidence at 5e304ef8. The changes since a46d42c3 that touch covered files are cooldown error typing (f1266a9c), a silent-failure report in `embed.ts` (e62bc17b), a handoff refusal on a non-fabric route (14ac787a), and `export` removals. None changes a phase 64 criterion.

Advisories 1 to 5 remain open for the owner or for test work. Advisory 1 is the owner item on D64-3; the SCAN and UNLINK commands came in with phase 78, so the owner decision belongs to that boundary. Human verification items 1 to 4 remain open, so the status is `human_needed`, not `passed`.

Limitation on the JUnit: gate r38 is the source of truth named in the brief, and it ran on `66fa97bd`, one commit before `5e304ef8`. The only change in `5e304ef8` is the ratchet baseline and two `export` removals in files outside phase 64 (`config.ts`, `hindsight-canary-run.ts`), which the static import check above covers.

---

_Verified: 2026-11-06T02:57:34Z_
_Verifier: Claude (gsd-verifier)_
