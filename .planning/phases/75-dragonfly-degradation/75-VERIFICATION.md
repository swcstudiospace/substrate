---
phase: 75-dragonfly-degradation
verified: 2026-11-06T06:12:17Z
status: human_needed
score: 8/8 truths verified (2/2 ROADMAP success criteria verified as declared; truth 4 verified on its tested cases, scope narrowed by the in-process copy being refused during the connect cooldown, see H-5; the fail-closed read in the cooldown is fixed in f1266a9c; live proofs H-2, H-3, H-4a and owner item H-5 remain; HARD-R2 unowned)
covered_files: ["docs/observability.md", "packages/mcp-server/src/admission.test.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/cache-breaker.test.ts", "packages/mcp-server/src/cache.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/http.admission.test.ts", "packages/mcp-server/src/live-session-consumer.test-support.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-forget.test.ts", "packages/mcp-server/src/service.test.ts", "packages/mcp-server/src/service.ts", "packages/observability/src/instruments.ts", "packages/observability/src/slo.test.ts", "packages/observability/src/slo.ts"]
covered_digest: "v3:sha256:ad4e0902876511728ec202904db167b46c7b369a3bfbaad830ab4527587a635a"
head_refresh: "ad7073c6: service.ts readPointerChecks and judgePointer now run under the verify budget (Greptile P1, 39023247): the anchor pointer path, the hunk family this record already cites for 3ce87f63. Outside this record's truths; verdict unchanged. Earlier, 06d0a5d6 and c37d194a: text-only changes (emit stderr wording, reconcile comment, flag-registry readBy, regenerated config doc) refreshed at c37d194a. covered_digest refreshed from verification.fingerprint; gate r46 on ad7073c6 is the run of record for the tests."
behavior_unverified: 0
overrides_applied: 1
overrides:
  - must_have: "Admission under an open breaker follows a declared policy per class (fail open or closed), set in flags."
    reason: "O1 accepted. The owner accepts the fail-closed read policy consequence (CONTEXT D75-2): with `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed` and the breaker open, `/brief` and `/memory/recall` answer 503 `cache_unavailable` before the authoritative source is consulted. H-4b is closed."
    accepted_by: "owner"
    accepted_at: "2026-11-06T00:00:00Z"
behavior_unverified_items: []
coincidental_reliance_items: []
human_verification:
  - test: 'H-2: With the full stack running and default flags (nothing set), stop the live Dragonfly, then call POST /brief and POST /memory/recall'
    expected: 'Both answer 200 with authoritative source content; each returns within the command timeout (no hang); cache health reports degraded'
    why_human: 'In-process tests inject an open breaker or use an unreachable port (cache-breaker.test.ts openCache, closedGate). A real outage with real sockets, timeouts and breaker transition is not observed. Operator live proof, kept open.'
  - test: 'H-3: Set SUBSTRATE_BUDGETS=enforce and SUBSTRATE_BUDGET_READ_BREAKER=fail-closed. Stop the live Dragonfly, drive connect failures to open the breaker, then call POST /brief'
    expected: 'HTTP 503, body {"error":"cache_unavailable","class":"read","retry_after_s":N}, Retry-After equal to N as an integer, and one substrate.admission.decisions{decision="refused"} increment. A fail-closed read refused inside the 5 s connect cooldown takes the same 503 path (f1266a9c; cache.test.ts:1283, 1282 at r38). Only the connect failure that starts a cooldown is admitted as bypass'
    why_human: 'http.admission.test.ts "an open cache breaker is a bypass for a fail-open class and a 503 for a fail-closed one" (:274) injects a breaker-open outcome. The real breaker opening and closing under a live Dragonfly, and a real connect cooldown, are not observed. Operator live proof, kept open.'
  - test: 'H-4: (a) Check /metrics, the OTel/Greptime export and any dashboard for substrate.admission.decisions{decision="refused"}; (b) the fail-closed read policy consequence (CONTEXT D75-2), decided by the owner'
    expected: '(a) the refused series exists with surface and class labels and is outside the admission limited-rate numerator (slo.ts:360); (b) closed: owner decision O1 accepted on 2026-11-06'
    why_human: 'Delivery to live exporters and dashboards is not in code (operator live proof, H-4a). Kept open. H-4b is closed by the owner decision of 2026-11-06 (O1).'
  - test: 'H-5 (owner item O2, the fail-closed half fixed in f1266a9c): decide whether the in-process last-good brief stays refused during the connect cooldown window (CACHE_CONNECT_COOLDOWN_MS, cache.ts:251)'
    expected: 'Fixed: inside the 5 s cooldown a fail-closed admission read is refused via breakerRetryAfterMs without a connect attempt (cache.test.ts:1283, 1282 at r38, pass in r38). Owner decides the in-process copy: keep it refused in that window (current behaviour: refused as forgotten, cache.ts:919), or serve it while the breaker is open, and directs any change'
    why_human: 'A judgment on the declared rule for a forget mark that cannot be checked during the cooldown: refuse or serve. Not a defect a grep or a targeted test can settle. The refusal reaches the in-process copy path (service.ts:2554). Owner item O2 (open part), kept open.'
---

# Phase 75: DragonflyDB degradation Verification Report

**Phase Goal:** When the cache plane is open or unreachable, reads fall back to the authoritative store without losing state, and admission behaves as declared.
**Verified:** 2026-11-06T06:12:17Z
**Status:** human_needed
**Re-verification:** Yes. Prior record at HEAD `5e304ef8` (covered digest `v3:sha256:9fb013c2d5957d04a1de62c4d48d4bb636784b5a97ad8fa4a8990bf24910d9d5`) is stale by digest: covered files changed after it (`cache.ts`, `config.ts`, `service.ts`, `cache.test.ts`), and `service.test.ts` is now cited and added to the digest. Re-audit at HEAD `df31c749`; worktree clean (`git status` empty). The 2026-11-06 owner decisions are applied (see Inputs and Scope). Draft at `/root/src/worktrees/backups/records/r44/75-VERIFICATION.md`; nothing written in the worktree or committed.

## Inputs and Scope

- Worktree: `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `df31c749`, `git status` clean.
- Must-haves: the two ROADMAP phase 75 success criteria (`.planning/ROADMAP.md:1298-1312`):
  1. With the cache breaker open, brief and recall return authoritative results. A test proves it.
  2. Admission under an open breaker follows a declared policy per class (fail open or closed), set in flags.
- Owner decision in force (H-1, closed; `6e5d766e`, dated 2026-11-05): the in-process last-good brief serves only while the cache breaker is open. A readable forget mark decides. Any other failed mark read, with the breaker closed, refuses the copy. The trade-off (a forget by another process is not seen during an outage) is documented in `docs/observability.md:230`.
- Other owner decisions in force, not reopened here: the planning-hash default stays off; the tombstone scope is the caller's declaration; the in-flight event is recorded at shutdown; a buffered root is not written again.
- **Owner decisions of 2026-11-06 (binding for this phase, answered by the owner on 2026-11-06):**
  - **O1 accepted.** The owner accepts the fail-closed read policy consequence (CONTEXT D75-2): with `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed` and the breaker open, `/brief` and `/memory/recall` answer 503 `cache_unavailable` before the authoritative source is consulted. H-4b is closed.
  - **O2 fixed in `f1266a9c` (fix 75).** During the 5 s connect cooldown a fail-closed admission read is refused via `breakerRetryAfterMs` without a connect attempt (`cache.ts` `CacheCooldownError` `:344`; cooldown refusal `:422-423`; `script` `:1076-1077`). Test: "during the connect cooldown a fail-closed read is refused without a connect attempt", `packages/mcp-server/src/cache.test.ts:1283` (`:1282` at r38), pass in r38. The connect failure that starts the cooldown is still a bypass in every class (same test). Truth 7 and H-5 are updated to match.
  - **Still open (owner item, H-5).** Whether the in-process last-good copy stays refused during the same cooldown window. Kept as an owner item. No code change made for it.
  - H-2, H-3 and H-4a are operator-only live proofs and stay operator items.
- Requirement: HARD-R2 (`.planning/REQUIREMENTS.md:119`, unchecked `[ ]`, mapped to phase 75). Unowned.
- Covered-file fingerprint: `gsd_run query verification.fingerprint /root/src/worktrees/as-gsd-v18-all/.planning/phases/75-dragonfly-degradation` run read-only at `df31c749`, with the 16 covered files of the prior record plus `packages/mcp-server/src/service.test.ts` (cited for the brief-grant evidence, `:6415`, which the prior list lacked). `covered_files` and `covered_digest` in the frontmatter are copied verbatim from that output.
- Evidence: gate r38 JUnit `/root/src/worktrees/backups/gate-r38-junit.xml`, run on `66fa97bd`. That run contains `f1266a9c` (an ancestor of `66fa97bd`), so the O2 test is covered by it. Its one failure is `scripts/code-ratchet.test.ts` (the ratchet check), outside phase 75, and the code head fixes it. Every title cited below as "pass in r38" was checked by parsing the XML: one testcase with that name, in that file and at that line (r38 line numbers, which are one lower for `cache.test.ts` than at the current head), with no `failure`, `error` or `skipped` child.
- Run of record for this head: `/root/src/worktrees/backups/gate-r43-junit.xml`, written by the r43 gate run on `df31c749`. It did not exist when this draft was made, and no result is claimed for it. Two titles first appear after `66fa97bd` and are not in r38: `cache.test.ts:2174` (scan round bound, `0556dfd3`) and `service.test.ts:6415` (brief grant, `3ce87f63`). They are cited as passes in r43 only. If r43 disagrees for any cited title, this record is revisited.
- Each cited title was also grepped in source: the title text is at the cited `file:line` in the worktree (current lines; the `cache.test.ts` lines moved by +1 after `0556dfd3` added an import).
- Postgres: none. No Postgres-gated test is named in phase 75.
- Not run in this pass, by assignment: any test, `tsc`, lint, formatters, docker, databases, any edit, any commit. Read-only git and read-only `gsd_run` queries only.

### Changes since the `5e304ef8` record (checked)

Commits after `5e304ef8` (13): `cebd76df`, `b577f5be`, `e2e4cba4`, `4ac770af`, `4637a9b7`, `700d9b5c`, `0556dfd3`, `6245863c`, `fd4a305f`, `d928e995`, `3ce87f63`, `7f6338c2`, `df31c749`.

Covered-file diff `5e304ef8..df31c749`: exactly four covered files change: `cache.test.ts` (+15), `cache.ts` (+9/-4), `config.ts` (+31/-2), `service.ts` (+33/-6). `admission.ts`, `admission.test.ts`, `cache-breaker.test.ts`, `flag-registry.ts`, `http.admission.test.ts`, `live-session-consumer.test-support.ts`, `server.ts`, `service-forget.test.ts`, `instruments.ts`, `slo.test.ts`, `slo.ts` and `docs/observability.md` have no diff. `docs/config-reference.md` has no diff. Added lines in the four changed files carry no `TODO`, `FIXME`, `XXX`, `HACK`, `PLACEHOLDER` or `TBD`.

Commits that touch no covered file (checked by the covered-file diff above): `cebd76df`, `b577f5be` (records and roadmap), `e2e4cba4` (skills propose, fail-closed mirror config), `4ac770af` (cli emit stderr line), `4637a9b7` and `700d9b5c` (docs), `fd4a305f` (corpus), `d928e995` (reconcile), `7f6338c2` (host worktree roots), `df31c749` (dispatcher test).

The covered-file hunks in the window (only `cache.ts`, `cache.test.ts`, `config.ts` and `service.ts` carry any):

- `0556dfd3` (fix, SCAN bound; `cache.ts` `MAX_SCAN_ROUNDS` `:258`, `scanKeys` `:1087-1105`; new test `cache.test.ts:2174`). Checked against the cache-breaker and degraded-read criteria (truths 1 to 4, 7): `scanKeys` is reached only by reconcile (`reconcile-repair.ts` `scanCounters` and flush, `reconcile-run.ts`), never by brief, recall, admission or the in-process copy. Its SCAN goes through `bunRedis`'s gated `run` (`cache.ts:422-423` cooldown check, then `callPlane`), so with the breaker open the first SCAN is refused before any socket is opened and `scanKeys` throws, as before. The change adds a round counter to the do-loop condition and changes no throw or catch. `getOrLoad` (`:559`), `bump` (`:866`), `markForget` (`:884`), `forgetVerdict` (`:904`), `snapshotSurvivesForget` (`:927`), `script` (`:1076-1077`), `bunRedis` (`:355`) and the cooldown constant (`:251`) are unchanged in logic. The one behavioural change is that a walk that reaches 200 rounds with a nonzero cursor reports `truncated: true`, which reconcile reads as incomplete (fail closed; residual R8). Truths 1 to 4 and 7 do not change.
- `6245863c` (fix, buffer guard; `config.ts` `loadEventBufferSettings` `:2605`, new `destinationOf` `:2638`, `linkTargetOf`). The guard compares real destinations. The loader returns `null` before the guard when `SUBSTRATE_EVENT_BUFFER_PATH` is unset, so it has no effect on admission configuration. `loadAdmissionSettings` (`:1875`) and `breakerPolicyOf` (`:1930-1934`) are unchanged. Truth 8 does not change. Its test is in `config.test.ts`, which is not cited here.
- `3ce87f63` (fix, brief grants and rotated signer; `service.ts`). Two parts. (a) Pointer candidacy (`namedBySignerSet` `:854`, `judgePointer` `:893-921`, `readPointerChecks`): the anchor path, not a phase 75 path. (b) Brief composition: `compose` now reads `this.briefIndex(request.surface)` (`:2595`), and `briefIndex` (`:6940`) returns the index unchanged while `repoScope.enforced` is false. Checked against the brief truths:
  - Scoping off is the state of every phase 75 test. `REPO_SCOPES` is unset, so `repoScopeFromEnv` returns `enforced: false` (`repo-scope.ts:199-200`), and `cache-breaker.test.ts`, `cache.test.ts` and `service-forget.test.ts` contain no `REPO_SCOPES` or `repoScope`. Compose reads the same index as before, so truths 1, 2 and 4 are unaffected.
  - Scoping on: the composed sections, and so the cached value, the last-good copy and the snapshot, carry granted rows only (`memoryReplyInGrant` `:6906`, the rule `memory_search` applies). The cache key includes the surface (`cacheKey` `cache.ts:291`, `snapshotKey` `:302`), and the brief's `getOrLoad`, `peek`, `peekQuiet` and the in-process copy (`inProcessLastGood(request.surface, args)`, `service.ts:2542`) are all keyed by `request.surface`. A grant-filtered brief is therefore not served to another surface.
  - The grant check makes no cache call: `graphGranted` (`:6895`) → `graphRepoOf` (`:6800`) reads `this.index.getGraph` only. So a scoped brief under an open breaker still answers from the index. [INFERENCE] from code reading; no phase 75 test runs the brief with scope on and the breaker open.
  - The prototype-linked copy is safe: `IndexStore` (`index-store.ts:997`) has no `#private` fields and assigns `this.*` only in its constructor (`:1008-1013`; no later assignment found by grep), so reads through the copy see the same state. The index calls in `brief.ts` are `getGraph` or `getGraphForBrief` (lite), `openGraphs` and `memoryForBrief`, and only `memoryForBrief` is wrapped.
  - Residual R7: the commit's own residual. The brief's row limit applies before the grant filter, so ungranted rows can take places in the window. A completeness effect, not a leak. Not a phase 75 truth.
  - Evidence for the grant path: `service.test.ts:6415` "a caller granted only owner/a gets no global decision whose repository is owner/b" (new; passes in r43). It builds a scoped `Substrate` with no cache, so it covers compose with scope on, not the breaker-open path.

Other commits in the window touch no phase 75 path.

### Correction to the `42e3cf13` record (carried)

The `42e3cf13` truth 4 claimed that a mark read that fails with the breaker closed refuses the copy, and it was marked VERIFIED without a test for that case. At `42e3cf13` the code did not do that. The rule was made true by `d1a5e89b` and is test-backed by `cache-breaker.test.ts:242`.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1 (brief): with the cache breaker open, brief is answered from the index on every call and the cache never answers | ✓ VERIFIED | `cache-breaker.test.ts:73` "brief is composed from the index on every call, and the cache never answers it": pass in r38 (file unchanged since `d1a5e89b`). Code: `getOrLoad` `cache.ts:559`; the brief's `getOrLoad` at `service.ts:2641` passes no `deadlineMs`. Since `5e304ef8` the only `cache.ts` hunk is the scan bound (`:258`, `:1087-1105`), which is not on this path; the cooldown hunks of `f1266a9c` (`:344`, `:422-423`, `:1076-1077`) were verified at `5e304ef8` and are not on it either. The brief's index is `briefIndex(request.surface)` (`3ce87f63`, `service.ts:2595`), which is the same index while scoping is off (Changes, `3ce87f63`). Logic unchanged for this test. |
| 2 | SC1 (recall): with the cache breaker open, recall returns the same reply as a substrate with no cache | ✓ VERIFIED | `cache-breaker.test.ts:98` "recall returns the same reply as a substrate with no cache at all": pass in r38. `recallMemories` `service.ts:3813`, `recallUncounted` `:3841`. Recall does not call `briefIndex`; the `service.ts` hunks in the window are at `:854-921`, `:2595` and `:6940`, none on the recall path. |
| 3 | Generation keys: a bump the breaker refused keeps reads on the source after it closes, until a bump lands | ✓ VERIFIED | `cache-breaker.test.ts:117` "generation keys: a bump the breaker refused keeps reads on the source after it closes, until a bump lands": pass in r38. `bump` `cache.ts:866` (failure adds the key to `staleGenerations`, `:874`); `getOrLoad` bypasses a stale generation at `:590`. Residual R1. |
| 4 | Degraded brief, H-1 (owner decision): with the cache breaker open and the live source failing, (a) if this process holds a last-good brief for the arguments that is inside the window and not forgotten, it is served as state `snapshot`, with a header naming the failed sources and the body equal to the complete brief; (b) otherwise state is `degraded`, no snapshot text is served, and the brief does not throw. A readable forget mark, an answering cache with no snapshot, or a mark read that fails while the breaker is closed refuses the copy. | ✓ VERIFIED (tested cases; scope note) | (a) `cache-breaker.test.ts:181` "a brief composed with the breaker closed is served as the snapshot once the breaker opens and the source fails": pass in r38; asserts `snapshot`, `failed` `["graph"]`, header and body equal. (b) `:199` "a snapshot older than the cache window is not served: the degraded brief answers": pass in r38; `degraded`, `snapshotAt` null. (c) `:217` "with the cache readable and no snapshot for the key, the last-good brief is not served: an answering cache is not an outage": pass in r38. (d) `:229` "with the cache readable, a forget another process made after the brief refuses the last-good copy": pass in r38. (e) `:242` "a mark read that fails while the breaker is closed refuses the last-good copy: a mark that cannot be read is not 'no forget'": pass in r38. (f) `service-forget.test.ts:688` "a forget that deletes a plane document refuses the in-process last-good brief while the cache breaker is open": pass in r38; this process's own forget is refused by `briefForgottenAtMs` (`service.ts:2549`, set at `:4578`) before the mark is read. Code: `briefDetailed` `service.ts:2497`; `rememberLastGood` `:2524`; `inProcessLastGood` `:2542`, verdict `:2554`; cache-readable path `:2749`; degraded return `:2751`; write `:2620`. **Scope note (updated by `f1266a9c`):** the copy is served only when the mark read is refused by the breaker (`BreakerOpenError`, `cache.ts:919`). The connect cooldown is checked before `callPlane` (`cache.ts:422-423`). The connect failure that starts a cooldown (`cache.ts:393`) is the usual way a breaker opens (`cache.ts`, failure threshold 5 and open 30 s per `breaker.ts:51-52`). For the 5 s after it, the mark read rejects with `CacheCooldownError` (`cache.ts:344`), which is not `BreakerOpenError`. `forgetVerdict` returns "forgotten" (`cache.ts:919`), so the copy is refused and the brief is `degraded` while the breaker is open. Since `f1266a9c` the same refusal is policed for admission (truth 7); the in-process copy keeps this behaviour. The sequence is shown by `cache.test.ts:1257` "the connect cooldown is reported and expires; a breaker refusal does not start one" (pass in r38 at `:1256`; its gated case at `:1275-1281` needs the cooldown to lapse before `BreakerOpenError`). No test covers a mark read inside the cooldown with the breaker open; `closedGate` in `cache-breaker.test.ts` uses an in-memory store, not `bunRedis`. The outcome is fail-safe (copy refused, never served stale), so truth 4 is kept VERIFIED for the tested cases. Its literal wording "(a) ... is served" holds once the cooldown has lapsed. Raised under H-5 (O2). [INFERENCE] from code reading; not observed live. |
| 5 | SC2: per class, a fail-closed admission class is refused in `enforce` (503 `cache_unavailable`, `Retry-After`), a fail-open class admits as `bypass`, and neither reaches the plane. With no flag set every class is fail-open (D75-1) | ✓ VERIFIED | `admission.test.ts:325` "with no flag set every class is fail-open: an open breaker admits and counts a bypass, as it did before" and `:334` "a fail-closed class is refused in enforce with the breaker's wait, and the other classes stay fail-open": pass in r38. `cache-breaker.test.ts:145` "admission over the open breaker: a fail-closed class is refused, a fail-open class admits, and neither reaches the plane": pass in r38. `http.admission.test.ts:274` "an open cache breaker is a bypass for a fail-open class and a 503 for a fail-closed one": pass in r38. Enforcement: REST `server.ts:977` (`admission.admit`) with `sendBudgetRefusal` `server.ts:632`; MCP `server.ts:2779` (`admitBatch`). Since `f1266a9c` a fail-closed read in the connect cooldown is also refused in `enforce`. That is the composition of `cache.test.ts:1283` (the cooldown refusal carries `breakerRetryAfterMs`) and `admission.test.ts:334` (a `breakerRetryAfterMs` outcome is refused in `enforce`); no single test drives a live cooldown through `admission.admit`. [INFERENCE] for that composition. |
| 6 | A breaker refusal of a fail-closed class is a `bypass` in `shadow` and a `refused` in `enforce` | ✓ VERIFIED | `admission.test.ts:341` "a breaker refusal of a fail-closed class is a bypass in shadow and a refusal in enforce": pass in r38. Code: `admission.ts:386` (refusal branch, `enforce` only). `admission.ts` has no diff since `5e304ef8`; its line numbers are unchanged. |
| 7 | Only a refusal before the command was sent is policed (`breakerRetryAfterMs`): a breaker refusal, and since `f1266a9c` a connect-cooldown refusal. Another cache failure (timeout, the connect error that starts a cooldown, malformed reply) stays `bypass` in a fail-closed class | ✓ VERIFIED | `admission.test.ts:350` "only a breaker refusal is policed: another cache failure stays a bypass in a fail-closed class" (its body: a `connect ECONNREFUSED` outcome with no `breakerRetryAfterMs` is `bypass`): pass in r38. `admission.test.ts:243` "a cache that fails, refuses, or answers nonsense is a recorded bypass, never a refusal": pass in r38. `cache.test.ts:1283` "during the connect cooldown a fail-closed read is refused without a connect attempt": pass in r38 (`:1282`); it asserts that the connect failure that starts the cooldown carries no `breakerRetryAfterMs`, and that a read inside the cooldown is refused with `breakerRetryAfterMs: 4_000` and no socket opened. Gate: `admission.ts:386` reads `outcome.breakerRetryAfterMs`, which both refusals set (`cache.ts:1076-1077`). The title of `admission.test.ts:350` predates the cooldown refusal; its body still holds, and the title is cited as written. The same instanceof rule governs the mark read in truth 4 (`cache.ts:919`), and that is where the owner question H-5 stays open. |
| 8 | Flags: `SUBSTRATE_BUDGET_<CLASS>_BREAKER` parses trimmed and case-insensitively, blank is `fail-open`, and any other value refuses boot with a `ConfigError` naming the variable | ✓ VERIFIED | `admission.test.ts:365` "SUBSTRATE_BUDGET_<CLASS>_BREAKER parses per class, trimmed and case-insensitive; blank is fail-open" and `:375` "an invalid SUBSTRATE_BUDGET_<CLASS>_BREAKER refuses boot and names the variable": pass in r38 (the assertion that `loadConfig` throws is at `:378`). Code: `loadAdmissionSettings` `config.ts:1875` calls `breakerPolicyOf` (`config.ts:1930`), which throws at `:1934`. Registry: `flag-registry.ts:189`, `:219-228`. No behaviour change since `5e304ef8`: the `config.ts` hunk (`6245863c`) is in `loadEventBufferSettings` (`:2605`), and the `flag-registry.ts` diff is absent. |

**Score:** 8/8 truths verified. Truth 4 is verified on its tested cases; its scope is narrowed by the in-process copy being refused during the connect cooldown (H-5, owner question open). Truth 7 now includes the cooldown refusal (O2, fixed in `f1266a9c`). No truth is FAILED. No truth changed verdict in this pass; the window's changes were checked against each row and none alters a tested path.

### Deferred Items

None. No gaps found, so nothing deferred.

### Required Artifacts (manual Levels 1-3)

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/admission.ts` | admission decision, breaker policy | ✓ VERIFIED | No diff since `5e304ef8`. Decision branch `:386` (reads `breakerRetryAfterMs`, so it also sees the cooldown refusal); wired `server.ts:977`, `:2779`. |
| `packages/mcp-server/src/cache.ts` | gated read-through, stale generations, peek/put, forget verdict, connect cooldown | ✓ VERIFIED | Changed since `5e304ef8` by `0556dfd3` (`MAX_SCAN_ROUNDS` `:258`, `scanKeys` `:1087-1105`; reconcile-only, not a breaker or read path). `CacheCooldownError` `:344`, connect cooldown constant `:251`, cooldown start on connect failure `:393`, `bunRedis` `:355`, cooldown refusal `:422-423`, `getOrLoad` `:559` (stale-generation bypass `:590`), `bump` `:866`, `markForget` `:884`, `forgetVerdict` `:904` (instanceof rule `:919`), `snapshotSurvivesForget` `:927`, `peek` `:936`, `peekQuiet` `:967`, `writeKey` `:1035`, `snapshotKey` `:302`, `script` `:1076-1077`, `withDeadline` `:716`, `fail` `:1164`, `attempt` `:1179`. |
| `packages/mcp-server/src/config.ts` | `loadAdmissionSettings`, `breakerPolicyOf` | ✓ VERIFIED | Changed since `5e304ef8` by `6245863c` (buffer guard only: `loadEventBufferSettings` `:2605`, `destinationOf` `:2638`). `loadAdmissionSettings` `:1875`, `breakerPolicyOf` `:1930`, throw `:1934`. |
| `packages/mcp-server/src/flag-registry.ts` | `SUBSTRATE_BUDGET_<CLASS>_BREAKER` family; snapshot TTL row | ✓ VERIFIED | Family `:189`, `:219-228`. Snapshot TTL row `:632`. No diff in the window. |
| `packages/observability/src/instruments.ts` | `ADMISSION_CLASSES` | ✓ VERIFIED | `:170`. No diff in the window. |
| `packages/observability/src/slo.ts` | numerator excludes `refused` | ✓ VERIFIED | Numerator `decision: "limited"` at `:360`. No diff in the window. |
| `packages/mcp-server/src/service.ts` | in-process last-good brief, cache gate, brief snapshot read | ✓ VERIFIED | Changed since `5e304ef8` by `3ce87f63`: the brief's compose index `:2595` and `briefIndex` `:6940` (the grant wrapper, scope-on only); and the pointer-candidacy hunks `:854-921` (not phase 75). Gate `:1963` `planes.gate("cache")`; fields `:1664` (`briefLastGood`), `:1666` (`briefForgottenAtMs`); `MAX_IN_PROCESS_BRIEF_SNAPSHOTS` `:545`; `briefDetailed` `:2497`; `rememberLastGood` `:2524`; `inProcessLastGood` `:2542`, check `:2549`, verdict `:2554`; write `:2620`; brief `getOrLoad` `:2641`; SWR `snapshotSurvivesForget(good.at, true)` `:2683`; snapshot read and decision `:2745-2749`; degraded path `:2751`; forget stamp `briefForgottenAtMs` `:4578`, `markForget` `:4582`. `withDeadline` is not called on the brief path. |
| `packages/mcp-server/src/server.ts` | REST and MCP admission wiring | ✓ VERIFIED | No diff in the window. `sendBudgetRefusal` `:632`, `admit` `:977`, `admitBatch` `:2779`. handleMcp close catches `:2807-2808`. None of these is on the phase 75 truth paths. |
| `packages/mcp-server/src/service-forget.test.ts` (in digest) | forget refuses the in-process copy; snapshot tests | ✓ VERIFIED | Titles at `:592`, `:611`, `:626`, `:648`, `:668`, `:688`: pass in r38. File unchanged since `5e304ef8`. |
| `packages/mcp-server/src/cache-breaker.test.ts` (in digest) | H-1 and SC1 tests | ✓ VERIFIED | Nine testcases, all pass in r38 (titles in the truths table). Unchanged since `d1a5e89b`. |
| `packages/mcp-server/src/cache.test.ts` (in digest) | connect-cooldown tests; scan bound test | ✓ VERIFIED | `:1257` "the connect cooldown is reported and expires; a breaker refusal does not start one": pass in r38 (`:1256`). `:1283` "during the connect cooldown a fail-closed read is refused without a connect attempt": pass in r38 (`:1282`); added by `f1266a9c`. `:2174` "a scan whose pages all come back empty with a nonzero cursor stops at the round bound and reports truncated": new in `0556dfd3`, passes in r43. The `:1257`/`:1283` shift is the added `MAX_SCAN_ROUNDS` import line. |
| `packages/mcp-server/src/service.test.ts` (in digest, new) | brief grant with scope on | ✓ VERIFIED (compose path only) | `:6415` "a caller granted only owner/a gets no global decision whose repository is owner/b": new in `3ce87f63`, passes in r43. Not a breaker-open test. |

### Key Link Verification (manual)

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts:1963` | `cache.ts:355` `bunRedis` → `breaker.ts` `callPlane` | `planes.gate("cache")` | ✓ WIRED | Every cache command is refused before `fn` runs when the breaker is open. The connect-cooldown check (`cache.ts:422`) runs before the gate and is not a breaker refusal; `script` reports it as `breakerRetryAfterMs` (`cache.ts:1076-1077`). |
| `cache.ts:1076-1077` `script` | `admission.ts:386` | `outcome.breakerRetryAfterMs` | ✓ WIRED | Set for a breaker refusal and, since `f1266a9c`, for a connect-cooldown refusal. Only a fail-closed class in `enforce` becomes a refusal. |
| `service.ts:2745-2749` | `cache.ts:936` `peek` | `brief-snapshot` read | ✓ WIRED | A refused read returns null, so the in-process copy path is taken. A readable cache's verdict (`snapshotSurvivesForget`, `cache.ts:927`) decides when the snapshot exists. |
| `service.ts:2554` `inProcessLastGood` | `cache.ts:904` `forgetVerdict` | `=== "unreadable"` | ✓ WIRED | The copy is served only for `unreadable`, which is the breaker's refusal alone (`cache.ts:919`). `clear`, `forgotten`, and any non-breaker failure (including the cooldown error) refuse. |
| `service.ts:2620` | `service.ts:2524` `rememberLastGood` | written before `cache.put` | ✓ WIRED | Written whatever the breaker says; gated by window > 0 and cache enabled. |
| `service.ts:4578` | `service.ts:2549` | `briefForgottenAtMs` | ✓ WIRED | A copy saved at or before this process's last forget is not served. Set only when `touched`. |
| `service.ts:2595` | `service.ts:6940` `briefIndex` | compose index | ✓ WIRED | Identity while scoping is off; the grant wrapper otherwise (Changes, `3ce87f63`). |
| `server.ts:977` / `:2779` | `admission.ts` `admit` / `admitBatch` | per-request and batch admission | ✓ WIRED | `sendBudgetRefusal` (`server.ts:632`) renders 429 or 503. |
| `config.ts:1930` | `config.ts:1875` `loadAdmissionSettings` ← `loadConfig` | `breakerPolicyOf` | ✓ WIRED | A bad value throws `ConfigError` and refuses boot. |

### Data-Flow Trace (Level 4)

Not applicable to admission. For the brief under an open breaker, the answer is the index composition (truth 1) or the in-process last-good text (truth 4a). Both are asserted by the tests above. The process-local copy is a bounded map (`MAX_IN_PROCESS_BRIEF_SNAPSHOTS = 256`, `service.ts:545`).

### Behavioral Spot-Checks

No test was run in this pass. Each "pass in r38" row is the r38 JUnit testcase (`gate-r38-junit.xml`, run on `66fa97bd`), checked for one testcase at that file and line with no `failure`, `error` or `skipped` child. Rows marked "passes in r43" have no r38 result: they were added after `66fa97bd`, and no result is claimed for them.

| Behavior | Testcase (file:line) | Result | Status |
| -------- | -------------------- | ------ | ------ |
| T1a brief answered by index, cache never answers | `cache-breaker.test.ts:73` | r38 pass | ✓ PASS |
| T1b recall equals uncached reply | `cache-breaker.test.ts:98` | r38 pass | ✓ PASS |
| T1c refused bump keeps reads on source until a bump lands | `cache-breaker.test.ts:117` | r38 pass | ✓ PASS |
| T1d fail-closed refused, fail-open admits, neither reaches plane | `cache-breaker.test.ts:145` | r38 pass | ✓ PASS |
| T4a breaker open + source down + in-process copy → `snapshot` | `cache-breaker.test.ts:181` | r38 pass | ✓ PASS |
| T4b breaker open + source down + window elapsed → `degraded`, no throw | `cache-breaker.test.ts:199` | r38 pass | ✓ PASS |
| T4c readable cache, key absent → copy not served | `cache-breaker.test.ts:217` | r38 pass | ✓ PASS |
| T4d readable cache, newer forget mark → copy refused | `cache-breaker.test.ts:229` | r38 pass | ✓ PASS |
| T4e mark read fails, breaker closed → copy refused | `cache-breaker.test.ts:242` | r38 pass | ✓ PASS |
| T4f forget that deletes a plane document refuses the copy | `service-forget.test.ts:688` | r38 pass | ✓ PASS |
| T4g snapshot saved before a forget never served when a live source fails | `service-forget.test.ts:592` | r38 pass | ✓ PASS |
| T4h SWR does not serve a last-good saved before a forget | `service-forget.test.ts:611` | r38 pass | ✓ PASS |
| T4i snapshot saved after the forget still served | `service-forget.test.ts:626` | r38 pass | ✓ PASS |
| T4j mark cannot be read → snapshot refused (source failing, cache readable) | `service-forget.test.ts:648` | r38 pass | ✓ PASS |
| T4k mark cannot be written → every snapshot refused until a later forget | `service-forget.test.ts:668` | r38 pass | ✓ PASS |
| T4l connect cooldown reported, expires; breaker refusal starts none | `cache.test.ts:1257` | r38 pass (at `:1256`) | ✓ PASS (sequence evidence for the scope note) |
| T4m (O2) connect cooldown: fail-closed read refused, no connect attempt | `cache.test.ts:1283` | r38 pass (at `:1282`) | ✓ PASS (fix `f1266a9c`) |
| T4n (new) SCAN round bound reports truncated; stops at `MAX_SCAN_ROUNDS` | `cache.test.ts:2174` | passes in r43 | ⏳ NOT CLAIMED (not a phase 75 truth; reconcile path) |
| T5 default fail-open; fail-closed in enforce; HTTP 503 with integer Retry-After | `admission.test.ts:325`, `:334`; `http.admission.test.ts:274` | r38 pass | ✓ PASS |
| T6 shadow bypass / enforce refusal | `admission.test.ts:341` | r38 pass | ✓ PASS |
| T7 only a breaker refusal is policed; other failures bypass | `admission.test.ts:350`, `:243` | r38 pass | ✓ PASS |
| T8 flag parse and boot refusal | `admission.test.ts:365`, `:375` | r38 pass | ✓ PASS |
| T9 flag registry and config reference match | not re-run; `flag-registry.ts` and `docs/config-reference.md` have no diff in the window | carried | ✓ PASS (carried) |
| T10 (new) brief keeps only granted memory with scope on (compose path) | `service.test.ts:6415` | passes in r43 | ⏳ NOT CLAIMED (not a breaker-open test; grant evidence) |

Mutation evidence: the `d1a5e89b` author's record of a mutation of the forget guard is cited as the author's record, not as an observation here.

### Probe Execution

No `scripts/*/tests/probe-*.sh` exists, and the phase declares none. Not a migration or tooling phase. Not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| HARD-R2 | none (no PLAN.md exists) | Reuse the cache-plane breaker and bounded timeouts; on outage, reads fall back to the documented source or report degradation; writes that cannot be made durable are rejected with retryable errors; no authoritative state lives only in the cache | ? NEEDS HUMAN / ORPHANED (unowned) | The read-fallback clause is evidenced by truths 1 to 5. The write clause ("reject writes that cannot be made durable with retryable errors") is outside the two ROADMAP criteria and no test in this phase covers it. No plan claims HARD-R2. Requirement stays `[ ]`. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (added lines, covered files and tests) | - | `TODO`, `FIXME`, `XXX`, `HACK`, `PLACEHOLDER`, `TBD` | - | None in the lines added since `5e304ef8` in `cache.ts`, `cache.test.ts`, `config.ts` or `service.ts`. |
| `docs/observability.md:230` | - | Window described without the failed-mark-read rule | resolved | `bb6b38b7` added "A forget mark that cannot be read while the breaker is closed refuses the copy too." The gap in the prior record is closed. |
| `docs/observability.md:170-171` | - | The connect cooldown is described (refuses to reconnect for 5 s, `cache.cooldownUntil` in `/healthz`) without its admission effect | ℹ️ Info | `f1266a9c` changed what a fail-closed read gets during the cooldown (503 in `enforce`). The doc does not say so, and `docs/config-reference.md:280` (the `SUBSTRATE_BUDGET_<CLASS>_BREAKER` row) describes the open breaker only. Doc gap, not a code gap. Not edited. |
| `packages/mcp-server/src/admission.ts:386` | - | Comment says "The breaker refused the bucket step" | ℹ️ Info | The branch now also takes the connect-cooldown refusal (`breakerRetryAfterMs`). The code is right; the comment names only the breaker. Not edited. |
| `packages/mcp-server/src/admission.test.ts:350` | - | Title "only a breaker refusal is policed" predates the cooldown refusal | ℹ️ Info | The body (a `connect ECONNREFUSED` outcome is a bypass) still holds. Cited as written. |
| `packages/mcp-server/src/cache.ts:1087-1105` | - | `scanKeys` now stops after `MAX_SCAN_ROUNDS` and reports `truncated` | ℹ️ Info | Reconcile-only. A partial list is reported as partial, so reconcile refuses to call it clean (R8). Not a gap. |
| `docs/config-reference.md` | snapshot TTL row | double period "at once.." | ℹ️ Info | Cosmetic; generator appends `. See` to a text ending in `.`. File unchanged. Not a gap. |
| `75-CONTEXT.md` | D75-2a, Verified facts, R3 | stale anchors: `config.ts:1849` (now `:1875`), `cache.ts:335` (now `:355`), `slo.ts:359` (now `:360`), `service.ts` ranges | ℹ️ Info | Documentation drift only. Not edited. |

### Human Verification Required

H-1 is CLOSED by the owner decision and the commits `9e6fa1f2`, `9c86ffab`, `e185cd8a`, `42e3cf13`, and `d1a5e89b` (failed-mark-read rule and test). It is no longer a human item.

Owner decisions of 2026-11-06 applied here: O1 accepted (H-4b closed); O2's fail-closed half fixed in `f1266a9c` (H-5 updated); the in-process copy question stays open under H-5.

Open human items (none verifiable by grep or targeted tests):

- **H-2** (operator live proof): stop live Dragonfly with default flags; `POST /brief` and `POST /memory/recall` answer 200 with authoritative content, within the timeout, and cache health reports degraded.
- **H-3** (operator live proof): with `SUBSTRATE_BUDGETS=enforce` and `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed`, a real open breaker yields 503 `cache_unavailable` with integer `Retry-After` and one `refused` increment. A fail-closed read inside the 5 s connect cooldown takes the same 503 path (`f1266a9c`). Only the connect failure that starts a cooldown is admitted as bypass.
- **H-4a** (operator live proof): `substrate.admission.decisions{decision="refused"}` is visible in `/metrics`, the OTel/Greptime export and dashboards, with surface and class labels, outside the limited-rate numerator (`slo.ts:360`). Not re-checked in this pass.
- **H-4b**: CLOSED. The owner accepted the fail-closed read policy consequence (O1, 2026-11-06).
- **H-5** (owner item, open part): whether the in-process last-good brief stays refused during the connect cooldown window (CACHE_CONNECT_COOLDOWN_MS, `cache.ts:251`). Today it is refused as "forgotten" (`cache.ts:919`), because only `BreakerOpenError` reads as unreadable. The fail-closed admission half of O2 is fixed in `f1266a9c` (`cache.test.ts:1283`, pass in r38 at `:1282`). Owner decides the in-process copy and directs any change. Kept NOT FIXED.

HARD-R2 write clause: unowned.

### Gaps Summary

No FAILED truth, no MISSING or STUB artifact, no NOT_WIRED link, no blocker anti-pattern. No `gaps:` block is emitted. Status is `human_needed` by the Step 9 rule: human items exist (H-2, H-3, H-4a are operator proofs; H-5 is an open owner item), and HARD-R2 is unowned. `passed` is not valid while the live proofs and the open owner item are open.

The window's changes add no gap. `0556dfd3` and `6245863c` are off every phase 75 truth path. `3ce87f63` is transparent with scope off, which is the state of every phase 75 test; its scope-on behaviour is checked by reading and is not tested with an open breaker (R7).

The truth 4 scope note (connect cooldown, in-process copy) is not a gap in the sense of the Step 9 rule: the copy is refused, never served stale, and the owner item H-5 covers the window. It is recorded so that the literal "(a) served while the breaker is open" is not read as holding during the cooldown.

### Residual Risks

- **R1** (carried, predates phase 75 H-1 work): `staleGenerations` lives in the writing process. After a restart or on another replica, a generation key can still hold its old value, and a brief written before the write can be served until its TTL (`CACHE_TTL["brief"]`, 5 minutes). Tests cover one process only. Follow-up.
- **R4** (owner trade-off, H-1): while the cache cannot be read (breaker open), this process's in-process last-good brief can outlive a forget made by another process. It is bounded by `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` (default 3600 s), held at most 256 argument sets, and refused at once for this process's own forgets. Once the cache is readable again its forget mark decides. Stated in `docs/observability.md:230` and the flag row (`flag-registry.ts:632`).
- **R5** (narrowed by `f1266a9c`): the connect-cooldown window. A fail-closed read inside the window is now refused (`cache.test.ts:1283`, pass in r38 at `:1282`). The in-process last-good copy is still refused in the same window, by the current rule (truth 4 scope note). Fail-safe. Not covered by a test that runs `bunRedis` with the breaker open. Owner item H-5.
- **R6** (updated): the r43 JUnit (`/root/src/worktrees/backups/gate-r43-junit.xml`) is the run of record for `df31c749` and did not exist when this draft was made. Every "pass in r38" title passes in r38, on `66fa97bd`. The two new titles (`cache.test.ts:2174`, `service.test.ts:6415`) are passes in r43. If r43 disagrees for a cited title, this record is revisited.
- **R7** (new, from `3ce87f63`): with repository scoping enforced, the brief's row limit applies before the grant filter, so ungranted rows can crowd granted ones out of the window. Completeness only; no leak, since every row kept is granted. The breaker-open path with scope on is not tested (truth 1 and 4 hold by reading: the grant check makes no cache call).
- **R8** (new, from `0556dfd3`): a SCAN walk that reaches `MAX_SCAN_ROUNDS` (200) with a nonzero cursor reports `truncated`. A sparse pattern over a large keyspace can hit the bound before the walk ends, so reconcile refuses repair for that run. Fail closed; no data is removed on the strength of a partial list.
- The recall-snapshot leg (`SUBSTRATE_BRIEF_RECALL` enforced) has no in-process copy and no cache-breaker-open test in the tree as far as grep shows. Not claimed as covered.
- Load-failure reporting after a positive budget (`cache.ts:716-719`) is not reported; only the zero-budget branch reports (`cache.ts:719`). No phase 75 truth claims reporting. Noted for completeness.

### Self-check

- Covered list and digest copied verbatim from `gsd_run query verification.fingerprint` at `df31c749` (read-only): the 16 covered files of the prior record plus `packages/mcp-server/src/service.test.ts`.
- Every title cited as "pass in r38" was checked against the r38 JUnit by parsing the XML: one match on name, file and line (r38 line), no `failure`, `error` or `skipped` child. Each title was also found in source at its current `file:line`.
- Titles added after `66fa97bd` (`cache.test.ts:2174`, `service.test.ts:6415`) are cited as passes in r43 and carry no claimed result.
- Frontmatter `status: human_needed`, same vocabulary as the prior record. `passed` is not valid: H-2, H-3, H-4a and H-5 are open.
- Owner decisions of 2026-11-06 recorded in Inputs and Scope, and applied in truths 4, 5, 7, the artifacts table and H-4, H-5. O1 kept as the override; O2 fixed in `f1266a9c`; the H-5 open part kept open; H-2, H-3 and H-4a kept as operator items.
- Not run: any test, `tsc`, lint, formatters, any edit or commit in the worktree.

---

_Verified: 2026-11-06T06:12:17Z_
_Verifier: Claude (gsd-verifier)_
