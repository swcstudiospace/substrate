---
phase: 64-embedding-fabric
verified: 2026-11-06T06:12:45Z
status: human_needed
score: 4/4 must-haves verified
covered_files: [".planning/phases/64-embedding-fabric/64-SUMMARY.md","docs/corpus.md","docs/data-planes.md","docs/embedding-fabric.md","packages/cli/src/corpus/client.ts","packages/cli/src/corpus/index.ts","packages/cli/src/corpus/neardup.test.ts","packages/cli/src/corpus/neardup.ts","packages/cli/src/corpus/render.ts","packages/cli/src/index.ts","packages/corpus/src/protocol.ts","packages/corpus/src/similarity.test.ts","packages/corpus/src/similarity.ts","packages/mcp-server/src/cache-breaker.test.ts","packages/mcp-server/src/cache-conformance.test.ts","packages/mcp-server/src/cache.test.ts","packages/mcp-server/src/cache.ts","packages/mcp-server/src/config.test.ts","packages/mcp-server/src/config.ts","packages/mcp-server/src/corpus/ingest.ts","packages/mcp-server/src/corpus/neardup.test.ts","packages/mcp-server/src/corpus/neardup.ts","packages/mcp-server/src/corpus/service.ts","packages/mcp-server/src/corpus/validate.ts","packages/mcp-server/src/db-endpoints.ts","packages/mcp-server/src/embed.test.ts","packages/mcp-server/src/embed.ts","packages/mcp-server/src/fabric-mcp.test.ts","packages/mcp-server/src/fabric/compliance.test.ts","packages/mcp-server/src/fabric/compliance.ts","packages/mcp-server/src/fabric/fixtures.ts","packages/mcp-server/src/fabric/gather.test.ts","packages/mcp-server/src/fabric/gather.ts","packages/mcp-server/src/fabric/status.test.ts","packages/mcp-server/src/fabric/status.ts","packages/mcp-server/src/fabric/types.ts","packages/mcp-server/src/flag-registry.ts","packages/mcp-server/src/planes/tei.test.ts","packages/mcp-server/src/planes/tei.ts","packages/mcp-server/src/server.ts","packages/mcp-server/src/service.ts","packages/mcp-server/src/store-lock.test.ts","packages/observability/src/breaker.ts"]
covered_digest: "v3:sha256:4d4c245a3b72d48a31fe3d912909859703618a7f81d44078485dd39937164f22"
head_refresh: "c37d194a: text-only changes in covered files (packages/cli/src/index.ts emit stderr wording; packages/mcp-server/src/reconcile-run.ts comment; packages/mcp-server/src/flag-registry.ts readBy; docs/config-reference.md regenerated from the registry). covered_digest refreshed from verification.fingerprint; verdict, title list and behaviour unchanged; gate r45 on c37d194a is the run of record for the tests."
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 4/4
  previous_covered_digest: "v3:sha256:9cb4837aac309d8f2160804a084f19ee73ac37517ab3d79fc798b6fbd38a9c8e"
  gaps_closed: []
  gaps_remaining: []
  regressions: []
advisory:
  - finding: "cache.ts issues SCAN and UNLINK (bunRedis run union at line 420; scanKeys at 1087, unlinkKeys at 1115); D64-3 says no new redis command"
    category: architectural
    reason: "Not in phase 64's tree. At 87903465 bunRedis ran get, mget, set, incr and eval only. SCAN and UNLINK were added by 3ad7bc12 feat(78) (2026-11-02) for the reconcile report and its confirmed repair, after this phase closed. 0556dfd3 bounds the SCAN walk and adds no command; the union is unchanged. The emb class uses only MGET (readAll, cache.ts:1246-1250, reached from peekMany at :985) and SET (writeKey, :1046; putEntry at :1022). The test 'bunRedis commands are get, mget, set, incr, and eval' (cache-conformance.test.ts:102) asserts that the string '\"get\" | \"mget\" | \"set\" | \"incr\" | \"eval\"' occurs in cache.ts; the union at line 420 contains it as a prefix, so the test passes with SCAN and UNLINK present and does not enforce D64-3. CONTEXT.md D64-3 cites cache.ts:48 and :69; those lines are now :49 and :72. Owner item open (2026-11-06)."
    evidence_status: "read at df31c749; git log -S on UNLINK and \"scan\" in cache.ts gives 3ad7bc12 only; the test title is 'pass' in gate r38 JUnit, and 0556dfd3 does not change the asserted string."
  - finding: "withDeadline's reporting branch (cache.ts:719) has no test; a late rejection after a positive budget is still silent"
    category: test-coverage
    reason: "f0f3c04e changed only the ms <= 0 branch (cache.ts:717-720) to call reportSilent('cache.deadline-load', cause) at :719. No JUnit testcase names that site, and no test passes deadlineMs <= 0 with onDeadline (cache.test.ts uses deadlineMs 25 and 5_000 with onDeadline at lines 1664-1752; deadlineMs 1 without onDeadline at line 1767). The ms > 0 race (cache.ts:725-726) still drops a load's rejection after the timer has won, because Promise.race attaches a handler to the load. This is outside every phase 64 truth; the emb path does not reach withDeadline."
    evidence_status: "read at df31c749 (cache.ts:696, 703, 716-726); a source grep at df31c749 finds 'cache.deadline' only in cache.ts; the prior JUnit grep for 'deadline-load' and 'cache.deadline' returned nothing (r38); the ms > 0 behaviour follows from Promise.race semantics, not from running code."
  - finding: "The no-drop clause of truth 4 ('no document is dropped on that signal alone') has no testcase that names it"
    category: test-coverage
    reason: "Evidence is code reading: cli/src/corpus/index.ts plan() (lines 672-705) prints the plan unchanged and appends the near-duplicate section; mcp-server/src/corpus/neardup.ts header (line 5) says the signal is advisory. The JUnit tests for the pairs and the skip list pass but do not assert the no-drop property."
    evidence_status: "read at df31c749; not a test."
  - finding: "Naming drift: status.ts line 92 says 'The eight rows' and status.test.ts:208 is titled 'counts add up to the eight rows'; the code and the bodies use nine (FABRIC_RESOURCES)"
    category: maintainability
    reason: "Comment and title only; the assertions use FABRIC_RESOURCES.length and pass. Still present at df31c749."
    evidence_status: "grep at df31c749; JUnit title present and passing in gate r38."
  - finding: "No test drives the emb path during the connect cooldown (f1266a9c changed what a cooldown refusal is)"
    category: test-coverage
    reason: "f1266a9c makes the cooldown refusal a CacheCooldownError (cache.ts:344, raised at 423 in bunRedis's run, mapped to breakerRetryAfterMs in script at 1077). The emb path is fail-open by code reading: peekMany's catch returns the misses (cache.ts:1012-1014) and writeKey's catch returns false (:1049-1051), so embed.ts calls TEI. The cooldown test 'during the connect cooldown a fail-closed read is refused without a connect attempt' (cache.test.ts:1283) covers a fail-closed class, not emb; no embed.test.ts title mentions a cooldown."
    evidence_status: "read at df31c749; the cooldown test title is 'pass' in gate r38 JUnit; grep for 'cooldown' in embed.test.ts returns nothing at df31c749."
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
**Verified:** 2026-11-06T06:12:45Z
**Status:** human_needed
**Re-verification:** Yes. Previous record: the 5e304ef8 pass (cebd76df; human_needed, 4/4). This pass reads code head `df31c749` (worktree HEAD at read; the worktree is read-only for this pass). The covered list and `covered_digest` are the output of `gsd_run query verification.fingerprint` at df31c749. The fingerprint input is the previous covered set plus the five files this pass cites that were not in it: `packages/mcp-server/src/service.ts`, `packages/cli/src/index.ts`, `packages/mcp-server/src/corpus/service.ts`, `packages/mcp-server/src/corpus/ingest.ts`, `packages/mcp-server/src/config.test.ts`. `cache.test.ts` was already in the covered list; the earlier statement that it was not is withdrawn.

**Owner decisions (2026-11-06):** The owner decisions of 2026-11-06 in the brief (items 1 to 6) name no phase 64 decision, and none is in the repository for this phase. Two items are open and recorded here with that date:
1. Cache adapter SCAN and UNLINK versus D64-3 ("no new redis command"). Open. The command set was widened by phase 78 (3ad7bc12), not by this phase. 0556dfd3 bounds the SCAN walk and adds no command. The owner must either amend D64-3 to allow the reconcile path's SCAN and UNLINK, or move them out of the `emb` cache adapter. Advisory 1. This pass does not decide it.
2. Live TEI proof is operator-only. Open. TEI has not been contacted live, and the model and dimension pins are not recorded in the repo. Human items 1 and 2.

For the record, not an open item: CONTEXT.md D64-2 says the model and dimension are "pinned by flag"; SUMMARY.md "D64-2 refined" and flag-registry.ts (lines 807-808, default `learned`) say a pin is optional and the first `/info` answer is learned and held.

**Must-haves:** no PLAN.md exists for this phase; the truths are the four ROADMAP Phase 64 success criteria. Requirements EMB-01 to EMB-04 are mapped to this phase in REQUIREMENTS.md.

**Evidence policy for this pass:** No tests, tsc, lint, gates or services were run, and no `gsd_run` verification writer was used. The repository was read with read-only git, read-only grep and read, and the fingerprint query. Test evidence:
- The run of record for the title added by 0556dfd3 is `/root/src/worktrees/backups/gate-r43-junit.xml`. It passes (12,332 pass, 0 fail, 2 skip). This pass claims no result for it.
- Titles whose code is unchanged since 5e304ef8 cite the earlier run named in the previous record: gate r38 (`/root/src/worktrees/backups/gate-r38-junit.xml`, ran on `66fa97bd`). Its one failure, the `as_unknown_as` ratchet check ("the ratchet is tight: no source counter sits below its baseline"), was fixed at `5e304ef8` by lowering `scripts/code-ratchet.baseline.json` to 22. Its skipped testcases are `live loopback redis (SUBSTRATE_CONFORMANCE_REDIS_URL unset)` and `D-04 fixtures do not survive the write path while counts do` (redact.test.ts).
- `gate-r39-junit.xml` also exists in the backups directory. This pass does not cite it, because the brief names r38 as the earlier run.
- Each cited title was grepped in source at df31c749 in this pass. All match except `docs keep the idempotency mirror as a target, not a current key`, which is listed under "Titles not matched".

## Changes since the last record (5e304ef8..df31c749)

`git diff --stat 5e304ef8 HEAD` lists 43 changed files. Of the covered set, three changed: `cache.ts`, `cache.test.ts` and `config.ts`. `config.test.ts` is not covered and is cited below. These are not in the range diff: `embed.ts` (last change b8cbdeac), `planes/tei.ts` (b8cbdeac), `corpus/neardup.ts` (ba7cc010), `corpus/validate.ts`, `packages/corpus/src/similarity.ts` (4c576e5e), `cli/src/corpus/*` (last change d9d0a401), `fabric/status.ts`, `fabric/gather.ts`, `fabric/compliance.ts` (87903465) and `flag-registry.ts` (b8cbdeac). No export is removed from a covered file in the range; the covered-file diffs add `MAX_SCAN_ROUNDS` only.

| File | Commit(s) | Change | Phase 64 impact |
| ---- | --------- | ------ | --------------- |
| `packages/mcp-server/src/cache.ts` | 0556dfd3 | `MAX_SCAN_ROUNDS = 200` (line 258). `scanKeys` also stops after that many SCAN rounds (`rounds < MAX_SCAN_ROUNDS`, line 1103) and reports `truncated`; its doc comment is widened (1082-1085). No command is added or removed: the `run` union at line 420 is unchanged. | Criterion 2 re-audited (see criterion 2). `scanKeys` is called only by the reconcile modules (`reconcile-run.ts`, `reconcile-repair.ts`, `reconcile-main.ts`); the `emb` class does not call it. No effect on `emb`. |
| `packages/mcp-server/src/cache.test.ts` | 0556dfd3 | +15: `describe("scanKeys round bound")` with one test (lines 2173-2185). | Test only. The new title is the watch item under criterion 2. Its result is in the r43 run of record, not claimed here. |
| `packages/mcp-server/src/config.ts` | 6245863c | `loadEventBufferSettings` compares `destinationOf(path)` instead of `resolve(path)` (line 2615). New helpers `destinationOf` and `linkTargetOf` (2631-2658) follow symlinks; imports `readlinkSync`, `realpathSync`, `basename`, `dirname`, `join` (line 8). | None. The TEI and EMBED settings are in no hunk (hunks at 8, 2615, 2631-2658). This is the event buffer (phase 76). |
| `packages/mcp-server/src/config.test.ts` (not covered before; in the fingerprint now) | 6245863c | +48: a `describe` for the telemetry buffer and dead-letter paths (phase 76) with three tests, appended after line 862. | None. Test only; cites no phase 64 title. Named because the `config.ts` row cites it. |
| `packages/mcp-server/src/service.ts` (not covered before; in the fingerprint now) | 3ce87f63 | `namedBySignerSet` and the `judgePointer` checks (lines 850-862, 888-890, 900-901, 919-920); `briefIndex` (6936-6947); a single-line hunk at 2595 that contains none of the keywords below. | None. No hunk names tei, fabric, neardup, embed or emb. The TEI gate (`this.planes.gate("tei")`, line 1965) and `fabricSources()` (9174-9235) are outside every hunk. |
| `packages/cli/src/index.ts` (not covered before; in the fingerprint now) | 4ac770af | `cmdEmit` writes one stderr line when `post("/events")` answers null (lines 235-240). | None. Not a phase 64 command. The corpus plan and `--neardup` are in `cli/src/corpus/index.ts`, which is unchanged. |
| `packages/mcp-server/src/corpus/service.ts`, `packages/mcp-server/src/corpus/ingest.ts` (not covered before; in the fingerprint now) | fd4a305f | The tombstone scope check runs under the ingest lock; `runIngest` is exported. | None. Neither file names neardup, tei, embed or emb. `corpus/neardup.ts` and `corpus/validate.ts` are unchanged. |
| Other changed files, not covered and not phase 64 paths: `packages/host/*` (7f6338c2), `packages/dispatcher/tests/test_worktree.py` (df31c749), `packages/mcp-server/src/reconcile-read.ts`, `reconcile-repair.ts` and their tests (d928e995), `packages/mcp-server/src/skills/propose.ts` and its test (e2e4cba4), `packages/mcp-server/src/service.test.ts` and `repo-scope.boundary.test.ts` (3ce87f63, fd4a305f), and the docs and planning commits (700d9b5c, 4637a9b7, cebd76df, b577f5be) | 7f6338c2, df31c749, d928e995, e2e4cba4, 3ce87f63, fd4a305f, 700d9b5c, 4637a9b7, cebd76df, b577f5be | Not phase 64 paths. | None. A keyword check over every added and removed line of the non-doc files in the range (`tei`, `embed`, `emb`, `neardup`, `fabric`, `peekMany`, `putEntry`, `withDeadline`, `nearDup`, `corpus plan`) returns no line. A debt-marker check (`TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, `PLACEHOLDER`) over added lines in the range also returns no line. |

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | TEI client batches to the server limit, times out, retries with backoff, opens a breaker; model or dimension other than the pins is refused with a closed reason; fake covers each path | ✓ VERIFIED (carried forward; re-checked at df31c749) | `planes/tei.ts` is not in the 5e304ef8..df31c749 diff (last change b8cbdeac, an `export` removal with the same line count). `TEI_REASONS` (tei.ts:29, eight reasons); `backoffMs` (:190); `AbortSignal.timeout` (:248, :315); batch `Math.max(1, Math.min(config.batch, batchLimit ?? config.batch))` (:392); model refusals (:346, :353, :357, :405, :430); dimension refusals (:185, :402). JUnit (r38), `tei.test.ts`: "splits to the server's max_client_batch_size, keeps the order and reads /info once"; "SUBSTRATE_TEI_BATCH lowers the batch below the server's limit, and the server's limit lowers it below the flag"; "a 429 is retried after the jittered backoff, and the call then succeeds"; "successive failures wait exponentially longer, and a 5xx that never clears ends as unavailable after the attempt bound"; "a request that times out answers timeout at once, with no retry"; "5xx until the breaker opens ends as breaker-open, and the next call sends nothing"; "a TEI that serves another model than the pin is refused before any vector is requested"; "a vector of another length than the pinned dimension is refused, on every response"; "the closed reason list is exactly the eight the callers switch on"; "a transport error is retried, and one that persists is unavailable without its text". All pass. |
| 2 | `SUBSTRATE_EMBED_CACHE=on` caches vectors in Dragonfly under class `emb`, keyed by model and sha256, every key TTL'd, cache-conformance test passes | ✓ VERIFIED (re-audited at df31c749 after 0556dfd3); D64-3 open with the owner (advisory 1) | `CACHE_TTL.emb = 604_800` (cache.ts:57); `CACHE_CLASSES` includes `"emb"` (:72); the `emb` value check (`shapeOk`, :1283-1286) and `embeddingEntryOk` (:1321) are outside every diff hunk (0556dfd3's hunks are at :257-258 and :1082-1103). `embed.ts` depends on `Pick<ReadThroughCache, "peekMany" \| "putEntry">` (:21), calls `peekMany` (:84) and `putEntry("emb", embeddingDigest(model, text), …, deps.ttlS)` (:131); digest `sha256(model + "\n" + text)` (embed.ts:49-51). The commands the `emb` class issues are MGET (`readAll`, cache.ts:1246-1250, via `peekMany` at :985-1016) and SET (`writeKey`, :1046; `putEntry` at :1022). `scanKeys` (SCAN, from :1087) and `unlinkKeys` (:1115) are called only by the reconcile modules, so 0556dfd3's round bound does not reach `emb`. Under the connect cooldown (f1266a9c) both fall through: `peekMany`'s catch returns the misses (:1012-1014) and `writeKey`'s catch returns false (:1049-1051), so `embed.ts` calls TEI. `peekMany` and `putEntry` do not reach `withDeadline`, whose only call sites are `loadShared` (cache.ts:696, :703), so the f0f3c04e reporting change cannot alter the `emb` path. JUnit (r38), `embed.test.ts`: "every write carries the TTL, however many are written"; "the key names the model: another model never reads these vectors"; "a dead Redis falls through on read and on write"; "a cache store that throws is treated as a miss and a refused write"; "the digest is the sha256 of the model, a newline and the text"; "a failed TEI call returns its reason and writes nothing". JUnit (r38), `cache-conformance.test.ts`: "closed key classes exclude an idempotency mirror"; "bunRedis commands are get, mget, set, incr, and eval" (passes by substring; see advisory 1); "admission does not carry an idempotency payload key". The live case is skipped in r38 (testcase "live loopback redis (SUBSTRATE_CONFORMANCE_REDIS_URL unset)"). The title "docs keep the idempotency mirror as a target, not a current key" was removed in f0f3c04e and is not in source. Watch item from 0556dfd3: "a scan whose pages all come back empty with a nonzero cursor stops at the round bound and reports truncated" (`cache.test.ts:2174`) is new since r38 and tests `scanKeys` only, not `emb`. It is cited against the r43 run of record (`/root/src/worktrees/backups/gate-r43-junit.xml`); this pass claims no result for it. |
| 3 | `fabric_status` has a `tei` resource (health, model, dimension, breaker); compliance fails a non-private TEI URL; fixtures and order tests updated | ✓ VERIFIED (carried forward; tei row unchanged in behaviour at df31c749) | `fabric/status.ts` `teiRow` (lines 112-116) sets `breaker: facts.services.tei.breaker` (:116); `fabric/gather.ts` line 135 `breaker: breakerOf(breakers.tei)`; `fabric/compliance.ts` `teiEndpointCheck` (line 72) fails a direct endpoint under policy and is not applicable when unset. `service.ts` `fabricSources()` (starts at 9174; `tei:` at 9193 and 9202; `breakers.tei` at 9204; `tei: this.config.tei !== null` at 9227) lies outside every hunk of 5e304ef8..df31c749 (hunks at 850-920, 2595 and 6936-6947). `db-endpoints.ts` is not in the 5e304ef8..df31c749 diff. JUnit (r38): "an open TEI breaker is reported on the row, and the row is still unavailable" (`status.test.ts`); "a closed TEI breaker is reported as closed, and the row is ok"; "reports exactly the nine resources, in report order, tei between hindsight and the proxy layer, the corpus last"; "a configured TEI that does not answer or whose breaker is open is unavailable, a half-open one degraded"; "a TEI with no pin and no embed yet still shows the model /info named, and says it was only observed"; "a TEI URL that is neither loopback nor an allowed proxy fails the TEI endpoint check; loopback and proxy pass; unset is not applicable"; "fabric_status reports the nine resources, and a resource nothing configures is never ok" (`fabric-mcp.test.ts`); "a TEI URL that is neither loopback nor allowed is a direct endpoint: the row says so, the compliance check fails, and no host is printed; an allowed proxy passes"; "the embedding service rides the tei plane's breaker: open, it answers breaker-open without a request; the fabric reads it; the six reported planes are unchanged"; "an open TEI breaker makes the row unavailable even though the last probe answered" (`gather.test.ts`). All pass. |
| 4 | `nearDuplicates` in `@substrate/corpus` returns pairs above a threshold with similarity; `POST /corpus/neardup` embeds excerpts through TEI client; `substrate corpus plan --neardup` prints pairs; no document dropped on that signal alone | ✓ VERIFIED (carried forward; no-drop clause by code reading, advisory 3) | `corpus/src/similarity.ts:144` `nearDuplicates`; `mcp-server/src/corpus/neardup.ts:66` `corpusNeardupReply`; `cli/src/corpus/index.ts` `plan()` (672-705). `similarity.ts` (last change 4c576e5e, an export removal), `mcp-server/src/corpus/neardup.ts` (ba7cc010) and `cli/src/corpus/index.ts` (d9d0a401) are not in the 5e304ef8..df31c749 diff. JUnit (r38): "returns every pair at or above the threshold, most similar first, ties by key, never the zero vector" (`similarity.test.ts`); "the threshold is inclusive and a high one leaves only the identical direction"; "a pair at or above the threshold is returned and one below it is not, with the default threshold 0.92"; "nothing to embed is a 200 that never calls the embedding service and names no model" and "no reply, success or failure, carries an excerpt" (`corpus/neardup.test.ts`); "leaves the threshold out when none was given, so the server's default applies" (`cli/src/corpus/neardup.test.ts`). All pass. |

**Score:** 4/4 truths verified (0 present-behavior-unverified, 0 overrides).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/planes/tei.ts` | TEI client | ✓ VERIFIED | Not in the 5e304ef8..df31c749 diff; last change b8cbdeac (`export` removal); `tei.test.ts` titles pass (r38) |
| `packages/mcp-server/src/embed.ts` | Cached embedding path, `emb` class | ✓ VERIFIED | Not in the 5e304ef8..df31c749 diff; e62bc17b (reporting only) and b8cbdeac (exports) earlier; `embed.test.ts` titles pass (r38) |
| `packages/mcp-server/src/cache.ts` | `emb` class with TTL, `putEntry`, `withDeadline` | ✓ VERIFIED | Changed by 0556dfd3 (`scanKeys` round bound; not on the `emb` path), f1266a9c (cooldown error type) and b8cbdeac (exports); `emb` lines unchanged |
| `packages/mcp-server/src/fabric/status.ts` | `tei` row with breaker | ✓ VERIFIED | `teiRow` (112-116) unchanged; `export` removal only (b8cbdeac) |
| `packages/mcp-server/src/fabric/types.ts` | `breaker?` on resource status | ✓ VERIFIED | `FabricTeiDetail` unchanged in behaviour; `export` removals only |
| `packages/mcp-server/src/fabric/gather.ts` | `breakers.tei` mapped into facts | ✓ VERIFIED | Line 135; `Read<T>` no longer exported |
| `packages/mcp-server/src/fabric/compliance.ts` | TEI endpoint check | ✓ VERIFIED | `teiEndpointCheck` at line 72; not in change set |
| `packages/corpus/src/similarity.ts` | `nearDuplicates` | ✓ VERIFIED | Line 144; not in change set |
| `packages/mcp-server/src/corpus/neardup.ts` | `POST /corpus/neardup` path | ✓ VERIFIED | `corpusNeardupReply` (66); not in change set |
| `packages/cli/src/corpus/index.ts` | `plan --neardup` section | ✓ VERIFIED | `plan()` 672-705; not in change set |
| `packages/mcp-server/src/flag-registry.ts` | Flag entries for TEI, cache | ✓ VERIFIED | Lines 607-608 and 807-808 unchanged; not in change set |
| `packages/mcp-server/src/cache-conformance.test.ts` | Static conformance cases | ✓ VERIFIED (static) / ⚠ live skipped | Three static titles pass in r38; the live title is skipped (operator-gated) |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `fabric/gather.ts` | `fabric/status.ts` | `tei` facts: `breakers.tei` → `teiRow` breaker | WIRED | gather.ts:135; status.ts:112-116 |
| `service.ts` `fabricSources()` | `gatherFabricFacts` | `breakers.tei`, `tei` facts | WIRED | service.ts 9193-9204, 9227; no hunk in range |
| `fabric/status.ts` | `fabric_status` MCP reply | `resources` JSON | WIRED | unchanged |
| `embed.ts` | `cache.ts` | `peekMany`, `putEntry("emb")` | WIRED | embed.ts:84, :131 |
| `planes/tei.ts` | `service.ts` | `gatedFetch(planes.gate("tei"))` | WIRED | service.ts:1965 |
| `corpus/neardup.ts` | `similarity.ts` | `nearDuplicates` call | WIRED | unchanged |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `fabric/status.ts` tei row | `breaker`, `detail.model/dimension/latencyMs` | `facts.services.tei`, `facts.tei` from `gatherFabricFacts` | Yes (live breaker read at call time; answer from the probe) | ✓ FLOWING |
| `fabric/status.ts` corpus row | `syncLag` reading | corpus SLO facts | Yes; `null` reading is not a breach | ✓ FLOWING |

### Behavioral Spot-Checks

No command was run in this pass (brief: no tests, tsc, lint or services). The JUnit titles above are the evidence. Checks done by reading and by read-only search:
- The `ms > 0` late-rejection claim in advisory 2 follows from `Promise.race` semantics, not from an execution.
- The `emb` isolation (criterion 2) follows from the call graph: `withDeadline` has two call sites, both in `loadShared`; `emb` uses only `peekMany` (MGET) and `putEntry` (SET). `grep -rn scanKeys packages` finds callers only in `reconcile-run.ts`, `reconcile-repair.ts` and `reconcile-main.ts` and their tests.
- The cooldown fall-through for `emb` (advisory 5) follows from the catch sites in `peekMany` and `writeKey`.
- The `bunRedis` command union at df31c749 (cache.ts:420) is `get | mget | set | incr | eval | scan | unlink`. `git log -S` on `UNLINK` and `"scan"` in cache.ts gives 3ad7bc12 only.

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
| `packages/mcp-server/src/cache.ts` | 420, 445-446 | SCAN and UNLINK in the `bunRedis` run union and adapter | ⚠️ Warning | Advisory 1 (D64-3, owner item); not a failure of criterion 2 |
| `packages/mcp-server/src/cache.ts` | 719 | Reporting line with no test on the `ms <= 0` branch; `ms > 0` late rejection still silent | ⚠️ Warning | Advisory 2; outside phase 64 truths |
| `packages/mcp-server/src/cache.ts` | 1012-1014, 1049-1051 | `emb` fall-through on refusal, not exercised by any test | ℹ️ Info | Advisory 5 |
| `packages/mcp-server/src/fabric/status.ts` | 92 | "The eight rows in report order"; the function returns nine | ℹ️ Info | Comment drift; advisory 4 |
| `packages/mcp-server/src/fabric/status.test.ts` | 208 | Title "counts add up to the eight rows"; body uses `FABRIC_RESOURCES.length` (nine) | ℹ️ Info | Title drift; advisory 4 |

Debt-marker gate: no `TBD`, `FIXME` or `XXX` in any covered file; no `TODO`, `HACK` or `PLACEHOLDER` added by the changes above.

### Titles not matched

These cited strings are not testcases in gate r38, or do not exist as test titles. They are listed so the orchestrator does not count them as evidence.

- `live loopback redis matches the command set`: exists in `cache-conformance.test.ts`, but is registered only when `SUBSTRATE_CONFORMANCE_REDIS_URL` is set, so it has no testcase in r38. Human item 3.
- `The eight rows in report order`: a source comment (status.ts:92), not a test title.
- `docs keep the idempotency mirror as a target, not a current key`: removed in f0f3c04e; not in source (grep at df31c749 finds no match).
- `cache.deadline-load`: a `reportSilent` site name, not a test title.
- `gaps_found: TEI never contacted live; criterion 3 partial`: a ROADMAP.md status string (line 1080), not a test title. It disagrees with this record; the roadmap owner decides.

### Human Verification Required

These are operator-gated and do not change the verified count. They route the status to `human_needed`.

1. **Live TEI reach.** Test: point `TEI_URL` at a real TEI via a forwarder listed in `SUBSTRATE_DB_PROXY_ALLOW`, restart, call `fabric_status`. Expected: `tei` row `ok`, `detail.model` shows the `/info` model, `breaker` `closed`. Why human: external service; TEI has never been contacted (SUMMARY). Owner item open (2026-11-06).
2. **Pins match the live service.** Test: copy the observed model into `SUBSTRATE_TEI_MODEL` and dimension into `SUBSTRATE_TEI_DIM`, then embed a probe text. Expected: no `model-mismatch` or `dim-mismatch`. Why human: the model and dimension are not recorded in the repo; both flags default to `learned`.
3. **Dragonfly `emb` class and the live conformance branch.** Test: `SUBSTRATE_EMBED_CACHE=on`, run `bun scripts/cache-stats.ts`; and set `SUBSTRATE_CONFORMANCE_REDIS_URL` to a loopback Redis. Expected: `emb` hits and TTLs present; "live loopback redis matches the command set" passes instead of skipping. Why human: the production Dragonfly is not reachable from this worktree; in r38 the live branch is skipped.
4. **Near-duplicate quality.** Test: `substrate corpus plan --neardup` on real documents. Expected: sensible pairs at 0.92. Why human: judgment on real content.

### Gaps Summary

No gaps in the four criteria. Every phase 64 truth is verified by carried-forward or re-audited evidence at df31c749. The changes since 5e304ef8 that touch covered files are the `scanKeys` round bound in `cache.ts` (0556dfd3, off the `emb` path, which uses only MGET and SET) and the buffer destination check in `config.ts` (6245863c, not a phase 64 setting). Neither changes a phase 64 criterion.

Advisories 1 to 5 remain open for the owner or for test work. Advisory 1 is the owner item on D64-3; the SCAN and UNLINK commands came in with phase 78, so the owner decision belongs to that boundary, and 0556dfd3 does not change it. Human verification items 1 to 4 remain open, so the status is `human_needed`, not `passed`.

Limitation on the JUnit: the run of record for the title added by 0556dfd3 (r43, df31c749) is not written yet, and gate r38, the named earlier run, ran on `66fa97bd`, before `5e304ef8` and `0556dfd3`. The changes to covered code since 5e304ef8 are checked by reading and by the static checks above (the `scanKeys` callers, the `emb` call graph, and the keyword and debt-marker checks over the range), not by a run.

---

_Verified: 2026-11-06T06:12:45Z_
_Verifier: Claude (gsd-verifier)_
