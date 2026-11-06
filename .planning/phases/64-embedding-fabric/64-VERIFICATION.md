---
phase: 64-embedding-fabric
verified: 2026-11-06T00:47:26Z
status: human_needed
score: 4/4 must-haves verified
covered_files: [".planning/phases/64-embedding-fabric/64-SUMMARY.md", "docs/corpus.md", "docs/data-planes.md", "docs/embedding-fabric.md", "packages/cli/src/corpus/client.ts", "packages/cli/src/corpus/index.ts", "packages/cli/src/corpus/neardup.test.ts", "packages/cli/src/corpus/neardup.ts", "packages/cli/src/corpus/render.ts", "packages/corpus/src/protocol.ts", "packages/corpus/src/similarity.test.ts", "packages/corpus/src/similarity.ts", "packages/mcp-server/src/cache-breaker.test.ts", "packages/mcp-server/src/cache-conformance.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/corpus/neardup.test.ts", "packages/mcp-server/src/corpus/neardup.ts", "packages/mcp-server/src/corpus/validate.ts", "packages/mcp-server/src/db-endpoints.ts", "packages/mcp-server/src/embed.test.ts", "packages/mcp-server/src/embed.ts", "packages/mcp-server/src/fabric-mcp.test.ts", "packages/mcp-server/src/fabric/compliance.test.ts", "packages/mcp-server/src/fabric/compliance.ts", "packages/mcp-server/src/fabric/fixtures.ts", "packages/mcp-server/src/fabric/gather.test.ts", "packages/mcp-server/src/fabric/gather.ts", "packages/mcp-server/src/fabric/status.test.ts", "packages/mcp-server/src/fabric/status.ts", "packages/mcp-server/src/fabric/types.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/planes/tei.test.ts", "packages/mcp-server/src/planes/tei.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/store-lock.test.ts", "packages/observability/src/breaker.ts"]
covered_digest: "v3:sha256:cfcebd1d6ed38ea6d38ab4220eb5ca72088288f46146d3aa7b7ab5f4e64b422b"
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
  - finding: "cache.ts still issues SCAN and UNLINK (run ops, lines 407 and 432-433); D64-3 says no new redis command"
    category: architectural
    reason: "Carried forward from the 6e5d766e record; line numbers moved by one after the reportSilent import (was 406 and 431-432). cache-conformance.test.ts 'bunRedis commands are get, mget, set, incr, and eval' (line 102) passes only because the REDIS_OPS substring still occurs in the union at line 407. The emb class itself uses only SET and MGET (cache.ts putEntry/peekMany, embed.ts:83 and :127)."
    evidence_status: "file read at a46d42c3. Not a test failure: the test is 'pass' in gate r36 JUnit."
  - finding: "withDeadline's new reporting branch (cache.ts:706) has no test; a late rejection after a positive budget is still silent"
    category: test-coverage
    reason: "f0f3c04e changed only the ms <= 0 branch to call reportSilent('cache.deadline-load', cause). No JUnit testcase names that site, and no test passes deadlineMs <= 0 together with onDeadline (cache.test.ts uses 1 without onDeadline at :1729, and 25 and 5_000 with it). The ms > 0 race below it (cache.ts:709 onward) still drops a load's rejection after the timer has won, because Promise.race attaches a handler to the load. This is outside every phase 64 truth; the emb path does not reach withDeadline."
    evidence_status: "read at a46d42c3 (cache.ts:683, 690, 703-706); JUnit grep for 'deadline-load' and 'cache.deadline' returns nothing; the ms > 0 behaviour is from reading Promise.race semantics, not from running code."
  - finding: "The no-drop clause of truth 4 ('no document is dropped on that signal alone') has no testcase that names it"
    category: test-coverage
    reason: "Evidence is code reading: cli/src/corpus/index.ts plan() (lines 672-705) prints the plan unchanged and appends the near-duplicate section; mcp-server/src/corpus/neardup.ts header (line 5) says the signal is advisory. The JUnit tests for the pairs and the skip list pass but do not assert the no-drop property."
    evidence_status: "read at a46d42c3; not a test."
  - finding: "Naming drift: status.ts line 92 says 'The eight rows' and status.test.ts:208 is titled 'counts add up to the eight rows'; the code and the bodies use nine (FABRIC_RESOURCES)"
    category: maintainability
    reason: "Comment and title only; the assertions use FABRIC_RESOURCES.length and pass."
    evidence_status: "grep at a46d42c3; JUnit title present and passing."
human_verification:
  - test: "Live TEI reach: point TEI_URL at a real TEI via a forwarder listed in SUBSTRATE_DB_PROXY_ALLOW, restart, call fabric_status"
    expected: "tei row state ok, detail.model shows the /info model, breaker closed"
    why_human: "External service; TEI has never been contacted live (SUMMARY)"
  - test: "Pins match the live service: copy the observed model into SUBSTRATE_TEI_MODEL and dimension into SUBSTRATE_TEI_DIM, then embed a probe text"
    expected: "No model-mismatch or dim-mismatch"
    why_human: "The model and dimension are not recorded in the repo; both flags default to 'learned' (flag-registry.ts lines 807-808)"
  - test: "Dragonfly emb class in production: SUBSTRATE_EMBED_CACHE=on, run bun scripts/cache-stats.ts; and the live cache-conformance branch with SUBSTRATE_CONFORMANCE_REDIS_URL set to a loopback Redis"
    expected: "emb hits and TTLs present; 'live loopback redis matches the command set' passes instead of skipping"
    why_human: "The production Dragonfly is not reachable from this worktree; the live branch is skipped in the gate r36 JUnit (SUBSTRATE_CONFORMANCE_REDIS_URL unset)"
  - test: "Near-duplicate quality: substrate corpus plan --neardup on real documents"
    expected: "Sensible pairs at 0.92"
    why_human: "Judgment on real content"
---

# Phase 64: Embedding fabric Verification Report

**Phase Goal:** Substrate itself can embed text with the owner's TEI service, cheaply and safely, and uses it to find near-duplicate documents.
**Verified:** 2026-11-06T00:47:26Z
**Status:** human_needed
**Re-verification:** Yes. Previous record: 6e5d766e (human_needed, 4/4). Its stored `covered_digest` (`v3:sha256:5dba4a57...`) reproduces exactly from the tree at `aef8a351`, the commit that refreshed it, using the fingerprint command over the same 37-entry list. The same list over the `6e5d766e` tree gives `v3:sha256:952b38c8...`; the record header's "at 6e5d766e" describes the commit whose files were audited, while the stored digest was taken at `aef8a351` (which also carries the `884e0753` server.ts change). This pass: HEAD `a46d42c3`, worktree clean. `covered_files` and `covered_digest` are the output of `gsd_run query verification.fingerprint` at `a46d42c3`, copied verbatim.

**Must-haves:** no PLAN.md exists for this phase; the truths are the four ROADMAP Phase 64 success criteria. Requirements EMB-01 to EMB-04 are mapped to this phase in REQUIREMENTS.md.

**Evidence policy for this pass:** no tests, tsc, lint or services were run (assignment). Test evidence is the gate r36 JUnit at `/root/src/worktrees/backups/gate-r36-junit.xml` (12,317 testcases; parsed: 0 with `<failure>`, 0 with `<error>`, 2 with `<skipped>`). The two skipped are `live loopback redis (SUBSTRATE_CONFORMANCE_REDIS_URL unset)` (cache-conformance.test.ts:122) and `D-04 fixtures do not survive the write path while counts do` (redact.test.ts). Every title cited below was matched to a JUnit testcase with no failure, error or skipped child.

## Changes since the last record (6e5d766e..a46d42c3)

Of the covered set, five files changed (`git diff --name-only 6e5d766e HEAD` intersected with the covered list):

| File | Commit(s) | Change | Phase 64 impact |
| ---- | --------- | ------ | --------------- |
| `packages/mcp-server/src/cache.ts` | f0f3c04e | Imports `reportSilent` (line 41). `withDeadline`'s `ms <= 0` branch now calls `reportSilent("cache.deadline-load", cause)` (line 706) where it was `work.catch(() => {})`. Return values unchanged. | None on criterion 2: `emb` is not reached (see below). Reporting only; untested (advisory 2). |
| `packages/mcp-server/src/cache-conformance.test.ts` | f0f3c04e | Header comment reworded; the test "docs keep the idempotency mirror as a target, not a current key" removed. | Static cases are unchanged apart from that removal; criterion 2 still rests on the static cases plus the skipped live case. |
| `packages/mcp-server/src/server.ts` | f0f3c04e, 884e0753 | f0f3c04e: a non-object JSON body answers 400 on /evidence, /handoff, /drift and /verify; MCP close handler catches. 884e0753 (phase 70): the sync-lag gauge is no longer set in the POST /events handler. | None. No hunk touches a fabric, tei, emb or neardup route (hunk list checked). |
| `packages/mcp-server/src/config.ts` | a46d42c3 | Comment only (`lightragPollMs` doc). | None. |
| `docs/corpus.md` | 885e73ce, bb6b38b7 | Citation-URL sentence rewritten. | None. No TEI, emb, fabric or near-duplicate claim. |

Outside the covered set, checked for overlap with criteria 1 to 4:

- `packages/mcp-server/src/service.ts` (commits 884e0753, b4bdd0fc, f0f3c04e and others): no changed line mentions tei, fabric, neardup or embed. The TEI gate (`this.planes.gate("tei")`, line 1950) and `fabricSources()` (lines 9147 to 9210, including `breakers.tei` at 9177 and `tei:` at 9166 and 9175) lie outside every hunk.
- `packages/mcp-server/src/fabric/status.ts` and `fabric/types.ts` (a4a9a8f0, phase 70): changes are to the corpus row (`corpusRow`, `SloLine`, `CorpusDetail`). `teiRow` (status.ts:112-116) and `FabricTeiDetail` (types.ts:52-57) are untouched.
- `packages/mcp-server/src/flag-registry.ts`: no line mentioning TEI or EMBED changed since 9e71f263; `SUBSTRATE_EMBED_CACHE` (line 607), `SUBSTRATE_EMBED_CACHE_TTL_S` (608), `SUBSTRATE_TEI_MODEL` (807) and `SUBSTRATE_TEI_DIM` (808) are as before.
- `packages/observability/src/index.ts` (a46d42c3): drops the re-export of `PLANE_AVAILABILITY_ENV`, which has no reference at HEAD. `BreakerOpenError`, `callPlane` and `PlaneGate` (used by cache.ts and tei.ts) remain exported (index.ts:165).
- `packages/mcp-server/src/planes/lightrag.ts` (a46d42c3): removes the unused type export `LightragChunk`; zero references at HEAD.
- Deleted `packages/mcp-server/src/fabric.ts` (a46d42c3): no importer anywhere in the tree (grep for `./fabric`, `../fabric` and `fabric.ts` across .ts, .tsx, .json, .md and .sh). The `fabric/` directory has no `index.ts`, so no import changes its target.
- Removed exports in a46d42c3 (`DEFAULT_FRESHNESS_MAX_AGE_H`, `DEFAULT_TRIGGER_LAG_MIN`, `FAILURE_REASONS`, `FIXTURE_PARSE_BEHAVIOURS`, `LightragChunk`, `PLANE_AVAILABILITY_ENV`, `PlanningScrapeError`, `PlanningScrapeResult`, `RAGFLOW_FIXTURE_READY`, `RagflowFixtureState`, `RestSteeringSession`, `STEERING_AUDIT_TABLE`, `SkillListState`, `buildFixtureSpawnArgv`, `defaultScopedGitRunner`, `fixtureEndpoint`, `hashPlanningPages`, `isPlanningUpdate`, `planningPollTick`, `pollPlanningRefresh`, `scrapePlanningPages`): `git grep -w` over HEAD in packages, scripts, infra and docs returns zero references for each. Positive control: `CACHE_TTL` returns hits in the same search.
- Relative imports of every covered implementation file resolve to an existing file at HEAD. `config.ts` still imports `DEFAULT_INGEST_ROOTS` (docs-ingest.ts:87), which exists.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | TEI client batches to the server limit, times out, retries with backoff, opens a breaker; model or dimension other than the pins is refused with a closed reason; fake covers each path | ✓ VERIFIED (carried forward; re-checked) | `planes/tei.ts` last changed in 87903465 (2026-10-30); no commit since 6e5d766e touches it. `TEI_REASONS` (tei.ts:29, eight reasons); `backoffMs` (:190); `AbortSignal.timeout` (:248); batch `Math.min(config.batch, batchLimit ?? config.batch)` (:392); model refusals (:346, :353, :357, :405, :430). JUnit, `tei.test.ts`: "splits to the server's max_client_batch_size, keeps the order and reads /info once" (:121); "SUBSTRATE_TEI_BATCH lowers the batch below the server's limit, and the server's limit lowers it below the flag" (:136); "a 429 is retried after the jittered backoff, and the call then succeeds" (:196); "successive failures wait exponentially longer, and a 5xx that never clears ends as unavailable after the attempt bound" (:205); "a request that times out answers timeout at once, with no retry" (:275); "5xx until the breaker opens ends as breaker-open, and the next call sends nothing" (:285); "a TEI that serves another model than the pin is refused before any vector is requested" (:306); "a vector of another length than the pinned dimension is refused, on every response" (:353); "the closed reason list is exactly the eight the callers switch on" (:424); "a transport error is retried, and one that persists is unavailable without its text" (:241). All pass. |
| 2 | `SUBSTRATE_EMBED_CACHE=on` caches vectors in Dragonfly under class `emb`, keyed by model and sha256, every key TTL'd, cache-conformance test passes | ✓ VERIFIED (re-audited at a46d42c3) | `CACHE_TTL.emb = 604_800` (cache.ts:57); `CACHE_CLASSES` includes `"emb"` (:72); the `emb` value check (:1266) and `emb` entry format (:1300) are outside every diff hunk. `embed.ts` depends on `Pick<ReadThroughCache, "peekMany" \| "putEntry">` (:20), calls `peekMany` (:83) and `putEntry("emb", embeddingDigest(model, text), …, deps.ttlS)` (:127); digest `sha256(model + "\n" + text)` (:48-49). `peekMany` and `putEntry` do not reach `withDeadline`, whose only call sites are `loadShared` (cache.ts:683, :690). So the f0f3c04e change cannot alter the `emb` path. JUnit, `embed.test.ts`: "a miss embeds and stores under the sha256 key with the TTL, and the next call is a hit that sends nothing" (:128); "every write carries the TTL, however many are written" (:163); "the key names the model: another model never reads these vectors" (:173); "a dead Redis falls through on read and on write" (:216); "a cache store that throws is treated as a miss and a refused write" (:227); "the digest is the sha256 of the model, a newline and the text" (:276); "a failed TEI call returns its reason and writes nothing" (:195). JUnit, `cache-conformance.test.ts`: "closed key classes exclude an idempotency mirror" (:72, includes `emb`), "bunRedis commands are get, mget, set, incr, and eval" (:102), "admission does not carry an idempotency payload key" (:96): all pass. The live case, "live loopback redis (SUBSTRATE_CONFORMANCE_REDIS_URL unset)" (:122), is **skipped** in r36 and remains operator-gated (human item 3). |
| 3 | `fabric_status` has a `tei` resource (health, model, dimension, breaker); compliance fails a non-private TEI URL; fixtures and order tests updated | ✓ VERIFIED (carried forward; tei row unchanged in behaviour) | `fabric/status.ts` `teiRow` (lines 112-116) sets `breaker: facts.services.tei.breaker` (:116); `fabric/gather.ts` line 135 `breaker: breakerOf(breakers.tei)` (gather.ts unchanged since 8af55c5e); `fabric/compliance.ts` `teiEndpointCheck` (line 72, unchanged since 87903465) fails a direct endpoint under policy and is not applicable when unset. `service.ts` `fabricSources()` (9147 to 9210) outside all hunks. JUnit: "an open TEI breaker is reported on the row, and the row is still unavailable" (`status.test.ts:253`); "a closed TEI breaker is reported as closed, and the row is ok" (:258); "reports exactly the nine resources, in report order, tei between hindsight and the proxy layer, the corpus last" (:104); "a configured TEI that does not answer or whose breaker is open is unavailable, a half-open one degraded" (:124); "a TEI with no pin and no embed yet still shows the model /info named, and says it was only observed" (:119); "a TEI URL that is neither loopback nor an allowed proxy fails the TEI endpoint check; loopback and proxy pass; unset is not applicable" (`compliance.test.ts:45`); "fabric_status reports the nine resources, and a resource nothing configures is never ok" (`fabric-mcp.test.ts:70`); "a TEI URL that is neither loopback nor allowed is a direct endpoint: the row says so, the compliance check fails, and no host is printed; an allowed proxy passes" (:269); "the embedding service rides the tei plane's breaker: open, it answers breaker-open without a request; the fabric reads it; the six reported planes are unchanged" (:302); "an open TEI breaker makes the row unavailable even though the last probe answered" (`gather.test.ts:153`). All pass. |
| 4 | `nearDuplicates` in `@substrate/corpus` returns pairs above a threshold with similarity; `POST /corpus/neardup` embeds excerpts through TEI client; `substrate corpus plan --neardup` prints pairs; no document dropped on that signal alone | ✓ VERIFIED (carried forward; no-drop clause by code reading, advisory 3) | `corpus/src/similarity.ts:144` `nearDuplicates`; `mcp-server/src/corpus/neardup.ts:66` `corpusNeardupReply`; `cli/src/corpus/index.ts` `plan()` (672-705). Unchanged: `similarity.ts` and `mcp-server/src/corpus/neardup.ts` last changed in ba7cc010 (2026-10-30); the CLI files are not in the change set. JUnit: "returns every pair at or above the threshold, most similar first, ties by key, never the zero vector" (`similarity.test.ts:47`); "the threshold is inclusive and a high one leaves only the identical direction" (:54); "a pair at or above the threshold is returned and one below it is not, with the default threshold 0.92" (`mcp-server/src/corpus/neardup.test.ts:151`); "nothing to embed is a 200 that never calls the embedding service and names no model" (:246); "no reply, success or failure, carries an excerpt" (:375); "leaves the threshold out when none was given, so the server's default applies" (`cli/src/corpus/neardup.test.ts:250`). All pass. The no-drop clause: `plan()` prints the plan with `renderPlan` and then appends `renderNeardup`, with no filter; the route header states the signal is advisory. |

**Score:** 4/4 truths verified (0 present-behavior-unverified, 0 overrides).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planes/tei.ts` | TEI client | ✓ VERIFIED | Unchanged since 87903465; `tei.test.ts` titles pass |
| `packages/mcp-server/src/embed.ts` | Cached embedding path, `emb` class | ✓ VERIFIED | Unchanged; `embed.test.ts` titles pass |
| `packages/mcp-server/src/cache.ts` | `emb` class with TTL, `putEntry`, `withDeadline` | ✓ VERIFIED | Diff since 6e5d766e: import (line 41) and the `ms <= 0` reporting line (706) only; `emb` lines unchanged |
| `packages/mcp-server/src/fabric/status.ts` | `tei` row with breaker | ✓ VERIFIED | `teiRow` (112-116) unchanged; corpus row changed in a4a9a8f0 (outside criterion 3) |
| `packages/mcp-server/src/fabric/types.ts` | `breaker?` on resource status | ✓ VERIFIED | `FabricTeiDetail` unchanged; corpus types changed (outside criterion 3) |
| `packages/mcp-server/src/fabric/gather.ts` | `breakers.tei` mapped into facts | ✓ VERIFIED | Line 135; unchanged since 8af55c5e |
| `packages/mcp-server/src/fabric/compliance.ts` | TEI endpoint check | ✓ VERIFIED | `teiEndpointCheck` at line 72; unchanged since 87903465 |
| `packages/corpus/src/similarity.ts` | `nearDuplicates` | ✓ VERIFIED | Line 144; unchanged since ba7cc010 |
| `packages/mcp-server/src/corpus/neardup.ts` | `POST /corpus/neardup` path | ✓ VERIFIED | `corpusNeardupReply` (66); unchanged since ba7cc010 |
| `packages/cli/src/corpus/index.ts` | `plan --neardup` section | ✓ VERIFIED | `plan()` 672-705; not in change set |
| `packages/mcp-server/src/flag-registry.ts` | Flag entries for TEI, cache | ✓ VERIFIED | No TEI or EMBED line changed since 9e71f263 |
| `packages/mcp-server/src/cache-conformance.test.ts` | Static conformance cases | ✓ VERIFIED (static) / ⚠ live skipped | Three static titles pass; the live title is skipped (operator-gated) |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `fabric/gather.ts` | `fabric/status.ts` | `tei` facts: `breakers.tei` → `teiRow` breaker | WIRED | gather.ts:135; status.ts:112-116 |
| `service.ts` `fabricSources()` | `gatherFabricFacts` | `breakers.tei`, `tei` facts | WIRED | service.ts 9166-9177, 9200; no hunk in range |
| `fabric/status.ts` | `fabric_status` MCP reply | `resources` JSON | WIRED | unchanged |
| `embed.ts` | `cache.ts` | `peekMany`, `putEntry("emb")` | WIRED | embed.ts:83, :127 |
| `planes/tei.ts` | `service.ts` | `gatedFetch(planes.gate("tei"))` | WIRED | service.ts:1950 |
| `corpus/neardup.ts` | `similarity.ts` | `nearDuplicates` call | WIRED | unchanged |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `fabric/status.ts` tei row | `breaker`, `detail.model/dimension/latencyMs` | `facts.services.tei`, `facts.tei` from `gatherFabricFacts` | Yes (live breaker read at call time; answer from the probe) | ✓ FLOWING |
| `fabric/status.ts` corpus row | `syncLag` reading | corpus SLO facts | Yes; `null` reading is not a breach | ✓ FLOWING |

### Behavioral Spot-Checks

No command was run in this pass (assignment: no tests, tsc, lint or services). The JUnit titles above are the evidence. Two checks were done by reading:

- The `ms > 0` late-rejection claim in advisory 2 follows from `Promise.race` semantics, not from an execution.
- The `emb` isolation (criterion 2) follows from the call graph: `withDeadline` has two call sites, both in `loadShared`; `emb` uses only `peekMany` and `putEntry`.

### Probe Execution

No probes are declared for this phase (PLAN/SUMMARY declare none). Step 7c: SKIPPED.

### Postgres evidence

No Postgres-gated test title is cited for this phase. No covered file opens a Postgres connection.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| EMB-01 | (none; ROADMAP-only phase) | TEI client with batching, timeout, retry, breaker; refuses model/dim mismatch | ✓ SATISFIED | Truth 1 |
| EMB-02 | (none) | Dragonfly cache by model and content hash, every key TTL'd | ✓ SATISFIED | Truth 2 (static conformance; live branch skipped) |
| EMB-03 | (none) | `fabric_status` reports TEI health, model, dimension; compliance names a non-private endpoint | ✓ SATISFIED | Truth 3 |
| EMB-04 | (none) | Near-duplicates by cosine similarity; plan output shows them; no document dropped on that signal | ✓ SATISFIED | Truth 4 |

ORPHANED requirements: none. REQUIREMENTS.md maps EMB-01 to EMB-04 to phase 64 and all four are claimed here.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `packages/mcp-server/src/cache.ts` | 407, 432-433 | SCAN and UNLINK run ops | ⚠️ Warning | Advisory 1 (D64-3); not a failure of criterion 2 |
| `packages/mcp-server/src/cache.ts` | 706 | New reporting line with no test | ⚠️ Warning | Advisory 2; outside phase 64 truths |
| `packages/mcp-server/src/fabric/status.ts` | 92 | "The eight rows in report order"; the function returns nine | ℹ️ Info | Comment drift; advisory 4 |
| `packages/mcp-server/src/fabric/status.test.ts` | 208 | Title "counts add up to the eight rows"; body uses `FABRIC_RESOURCES.length` (nine) | ℹ️ Info | Title drift; advisory 4 |
| `.planning/ROADMAP.md` | 1080 (outside covered set) | Status line still reads "gaps_found: TEI never contacted live; criterion 3 partial" | ℹ️ Info | Disagrees with this record (human_needed; criterion 3 verified). Not edited here; the roadmap owner decides |

Debt-marker gate: no `TBD`, `FIXME` or `XXX` in any covered file; no `TODO`, `HACK` or `PLACEHOLDER` added by the changes above.

### Human Verification Required

These are operator-gated and do not change the verified count. They route the status to `human_needed`.

1. **Live TEI reach.** Test: point `TEI_URL` at a real TEI via a forwarder listed in `SUBSTRATE_DB_PROXY_ALLOW`, restart, call `fabric_status`. Expected: `tei` row `ok`, `detail.model` shows the `/info` model, `breaker` `closed`. Why human: external service; TEI has never been contacted (SUMMARY).
2. **Pins match the live service.** Test: copy the observed model into `SUBSTRATE_TEI_MODEL` and dimension into `SUBSTRATE_TEI_DIM`, then embed a probe text. Expected: no `model-mismatch` or `dim-mismatch`. Why human: the model and dimension are not recorded in the repo; both flags default to `learned`.
3. **Dragonfly `emb` class and the live conformance branch.** Test: `SUBSTRATE_EMBED_CACHE=on`, run `bun scripts/cache-stats.ts`; and set `SUBSTRATE_CONFORMANCE_REDIS_URL` to a loopback Redis. Expected: `emb` hits and TTLs present; "live loopback redis matches the command set" passes instead of skipping. Why human: the production Dragonfly is not reachable from this worktree; the live branch is skipped in gate r36.
4. **Near-duplicate quality.** Test: `substrate corpus plan --neardup` on real documents. Expected: sensible pairs at 0.92. Why human: judgment on real content.

### Gaps Summary

No gaps. Every phase 64 truth is verified by carried-forward or re-audited evidence at a46d42c3. The two covered-file changes that touch cache and server (f0f3c04e) and the export removals (a46d42c3) do not touch any phase 64 criterion. The reporting change in `withDeadline` is outside the phase 64 truths; it is recorded as advisory 2 because it has no test and because the `ms > 0` case it might be read to cover is still silent.

Advisories 1 to 4 remain open for the owner. Human verification items 1 to 4 remain open, so the status is `human_needed`, not `passed`.

Limitation on the JUnit: the file does not state the commit it ran at. It contains the `f0f3c04e` test `http-null-body.test.ts` ("a null JSON body on /handoff, /drift, /verify, /events and /evidence answers 400, not 500"), so it postdates that commit. Whether it ran at `a46d42c3` cannot be confirmed from the file. No covered test imports a removed symbol (static check above).

---

_Verified: 2026-11-06T00:47:26Z_
_Verifier: Claude (gsd-verifier)_
