---
phase: 75-dragonfly-degradation
verified: 2026-11-06T02:56:16Z
status: human_needed
score: 8/8 truths verified (2/2 ROADMAP success criteria verified as declared; truth 4 verified on its tested cases, scope narrowed by the in-process copy being refused during the connect cooldown, see H-5; the fail-closed read in the cooldown is fixed in f1266a9c; live proofs H-2, H-3, H-4a and owner item H-5 remain; HARD-R2 unowned)
covered_files: ["docs/observability.md", "packages/mcp-server/src/admission.test.ts", "packages/mcp-server/src/admission.ts", "packages/mcp-server/src/cache-breaker.test.ts", "packages/mcp-server/src/cache.test.ts", "packages/mcp-server/src/cache.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/flag-registry.ts", "packages/mcp-server/src/http.admission.test.ts", "packages/mcp-server/src/live-session-consumer.test-support.ts", "packages/mcp-server/src/server.ts", "packages/mcp-server/src/service-forget.test.ts", "packages/mcp-server/src/service.ts", "packages/observability/src/instruments.ts", "packages/observability/src/slo.test.ts", "packages/observability/src/slo.ts"]
covered_digest: "v3:sha256:9fb013c2d5957d04a1de62c4d48d4bb636784b5a97ad8fa4a8990bf24910d9d5"
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
    expected: 'HTTP 503, body {"error":"cache_unavailable","class":"read","retry_after_s":N}, Retry-After equal to N as an integer, and one substrate.admission.decisions{decision="refused"} increment. A fail-closed read refused inside the 5 s connect cooldown takes the same 503 path (f1266a9c; cache.test.ts:1282). Only the connect failure that starts a cooldown is admitted as bypass'
    why_human: 'http.admission.test.ts "an open cache breaker is a bypass for a fail-open class and a 503 for a fail-closed one" (:274) injects a breaker-open outcome. The real breaker opening and closing under a live Dragonfly, and a real connect cooldown, are not observed. Operator live proof, kept open.'
  - test: 'H-4: (a) Check /metrics, the OTel/Greptime export and any dashboard for substrate.admission.decisions{decision="refused"}; (b) the fail-closed read policy consequence (CONTEXT D75-2), decided by the owner'
    expected: '(a) the refused series exists with surface and class labels and is outside the admission limited-rate numerator (slo.ts:360); (b) closed: owner decision O1 accepted on 2026-11-06'
    why_human: 'Delivery to live exporters and dashboards is not in code (operator live proof, H-4a). Kept open. H-4b is closed by the owner decision of 2026-11-06 (O1).'
  - test: 'H-5 (owner item O2, the fail-closed half fixed in f1266a9c): decide whether the in-process last-good brief stays refused during the connect cooldown window (CACHE_CONNECT_COOLDOWN_MS, cache.ts:251)'
    expected: 'Fixed: inside the 5 s cooldown a fail-closed admission read is refused via breakerRetryAfterMs without a connect attempt (cache.test.ts:1282, pass in r38). Owner decides the in-process copy: keep it refused in that window (current behaviour: refused as forgotten, cache.ts:917), or serve it while the breaker is open, and directs any change'
    why_human: 'A judgment on the declared rule for a forget mark that cannot be checked during the cooldown: refuse or serve. Not a defect a grep or a targeted test can settle. The refusal reaches the in-process copy path (service.ts:2539). Owner item O2 (open part), kept open.'
---

# Phase 75: DragonflyDB degradation Verification Report

**Phase Goal:** When the cache plane is open or unreachable, reads fall back to the authoritative store without losing state, and admission behaves as declared.
**Verified:** 2026-11-06T02:56:16Z
**Status:** human_needed
**Re-verification:** Yes. Prior record at HEAD `a46d42c3` (covered digest `v3:sha256:fdb05c6e...`) is stale by digest: covered files changed after it (`cache.ts`, `server.ts`, `service.ts`, plus export-keyword removals in `admission.ts`, `config.ts`, `flag-registry.ts`, `slo.ts`, `instruments.ts`). Re-audit at HEAD `5e304ef8`; worktree clean (`git status` empty). The 2026-11-06 owner decisions are applied (see Inputs and Scope). Draft at `/root/src/worktrees/backups/records/r39/75-VERIFICATION.md`; nothing written in the worktree or committed.

## Inputs and Scope

- Worktree: `/root/src/worktrees/as-gsd-v18-all`, branch `gsd/v18-int-all`, HEAD `5e304ef8`, `git status` clean.
- Must-haves: the two ROADMAP phase 75 success criteria (`.planning/ROADMAP.md:1298-1312`):
  1. With the cache breaker open, brief and recall return authoritative results. A test proves it.
  2. Admission under an open breaker follows a declared policy per class (fail open or closed), set in flags.
- Owner decision in force (H-1, closed; `6e5d766e`, dated 2026-11-05): the in-process last-good brief serves only while the cache breaker is open. A readable forget mark decides. Any other failed mark read, with the breaker closed, refuses the copy. The trade-off (a forget by another process is not seen during an outage) is documented in `docs/observability.md:230`.
- Other owner decisions in force, not reopened here: the planning-hash default stays off; the tombstone scope is the caller's declaration; the in-flight event is recorded at shutdown; a buffered root is not written again.
- **Owner decisions of 2026-11-06 (binding for this phase, answered by the owner on 2026-11-06):**
  - **O1 accepted.** The owner accepts the fail-closed read policy consequence (CONTEXT D75-2): with `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed` and the breaker open, `/brief` and `/memory/recall` answer 503 `cache_unavailable` before the authoritative source is consulted. H-4b is closed.
  - **O2 fixed in `f1266a9c` (fix 75).** During the 5 s connect cooldown a fail-closed admission read is refused via `breakerRetryAfterMs` without a connect attempt (`cache.ts` `CacheCooldownError` `:342`; cooldown refusal `:420-422`; `script` `:1074`). Test: "during the connect cooldown a fail-closed read is refused without a connect attempt", `packages/mcp-server/src/cache.test.ts:1282`, pass in r38. The connect failure that starts the cooldown is still a bypass in every class (same test). Truth 7 and H-5 are updated to match.
  - **Still open (owner item, H-5).** Whether the in-process last-good copy stays refused during the same cooldown window. Kept as an owner item. No code change made for it.
  - H-2, H-3 and H-4a are operator-only live proofs and stay operator items.
- Requirement: HARD-R2 (`.planning/REQUIREMENTS.md:119`, unchecked `[ ]`, mapped to phase 75). Unowned.
- Covered-file fingerprint: `gsd_run query verification.fingerprint /root/src/worktrees/as-gsd-v18-all/.planning/phases/75-dragonfly-degradation` run read-only at `5e304ef8`, with the 13 covered files plus three files the new evidence cites that the prior list lacked: `packages/mcp-server/src/cache.test.ts` (the O2 test), `packages/mcp-server/src/service-forget.test.ts` (T4f to T4k), and `docs/observability.md` (R4, the docs row). `covered_files` and `covered_digest` in the frontmatter are copied verbatim from that output.
- Evidence: gate r38 JUnit `/root/src/worktrees/backups/gate-r38-junit.xml`, run on `66fa97bd`. That run contains `f1266a9c` (an ancestor of `66fa97bd`), so the O2 test is covered by it. Its one failure is `scripts/code-ratchet.test.ts` (the ratchet check), outside phase 75, and the code head `5e304ef8` fixes it. Every cited title below was checked by parsing the XML: one testcase with that name, in that file and at that line, with no `failure`, `error` or `skipped` child. The r39 run on the current head writes `/root/src/worktrees/backups/gate-r39-junit.xml`; it was not written when this draft was made. If its result for any cited title differs, this record is revisited. No pass count is claimed.
- Each cited title was also grepped in source: the title text is at the cited `file:line` in the worktree.
- Postgres: none. No Postgres-gated test is named in phase 75.
- Not run in this pass, by assignment: any test, `tsc`, lint, formatters, docker, databases, any edit, any commit. Read-only git and read-only `gsd_run` queries only.

### Changes since the `a46d42c3` record (checked)

Commits after `a46d42c3` (14): `0947001e`, `9b951850`, `5041193f`, `f1266a9c`, `14ac787a`, `a2176f96`, `cf4ea4c1`, `e62bc17b`, `b8cbdeac`, `d9d0a401`, `4c576e5e`, `8ec17832`, `66fa97bd`, `5e304ef8`.

Covered-file diff `a46d42c3..5e304ef8`: `git diff` touches `admission.ts`, `cache.ts`, `config.ts`, `flag-registry.ts`, `server.ts`, `service.ts`, `instruments.ts` and `slo.ts`. The export-keyword removals (`b8cbdeac`, `d9d0a401`, `4c576e5e`, `8ec17832`, `66fa97bd`, `5e304ef8`) carry no behaviour change: stripping a leading `export ` from both trees leaves no non-export change in `admission.ts`, `config.ts`, `flag-registry.ts`, `instruments.ts` or `slo.ts`, and their line numbers are unchanged. The test files `admission.test.ts`, `cache-breaker.test.ts`, `http.admission.test.ts`, `slo.test.ts`, `service-forget.test.ts` and `live-session-consumer.test-support.ts` have no change at all. The non-export hunks are these:

- `f1266a9c` (fix 75, O2; in scope; behaviour change). `cache.ts` adds `class CacheCooldownError` (`:342`). The connect-cooldown refusal in `bunRedis`'s `run` (`:420-422`) now rejects with `CacheCooldownError` instead of a plain `Error`. `script` (`:1074`) reports a cooldown refusal as `breakerRetryAfterMs`, where before only `BreakerOpenError` did. The forget verdict is unchanged: `forgetVerdict` returns `unreadable` only for `BreakerOpenError` (`:917`), so the in-process copy is still refused in the cooldown (H-5, open). Admission reads the new field at `admission.ts:386`, a line that did not move. New test `cache.test.ts:1282`. Hunks checked: `cache.ts` `:342-351`, `:420-423`, `:1074-1075`, and the doc comments at `:15` and `:165`. Truths 1-3 and 6 do not touch these hunks; truths 4, 5 and 7 do, as noted in their rows.
- `14ac787a` (REST `/handoff` refuses a `to` outside `SURFACES` with 400 and writes nothing; also `packages/cli` and `http.test.ts`). `server.ts` gains five lines at `:1507-1511`, after the `/handoff` route guard (`:1502`). Not on any phase 75 truth or admission, brief, recall or breaker path. It moves later `server.ts` anchors by +5.
- `0947001e` (`service.ts:6421`, the `manifestCommit` closure, phase 63 path). Not on any phase 75 path; the line count is unchanged.
- `a2176f96` (`index-sweep.ts`, `memory-retain.ts`), `cf4ea4c1`, `e62bc17b` (silent-failure reporting at about forty sites), `5041193f` and `9b951850` (planning and verification records): touch no covered file (checked by name).
- Docs: `docs/observability.md` and `docs/config-reference.md` are unchanged since `a46d42c3`. The sentence at `docs/observability.md:230` ("A forget mark that cannot be read while the breaker is closed refuses the copy too.") is present, from `bb6b38b7`.

### Correction to the `42e3cf13` record (carried)

The `42e3cf13` truth 4 claimed that a mark read that fails with the breaker closed refuses the copy, and it was marked VERIFIED without a test for that case. At `42e3cf13` the code did not do that. The rule was made true by `d1a5e89b` and is test-backed by `cache-breaker.test.ts:242`.

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | SC1 (brief): with the cache breaker open, brief is answered from the index on every call and the cache never answers | ✓ VERIFIED | `cache-breaker.test.ts:73` "brief is composed from the index on every call, and the cache never answers it": pass in r38. Code: `getOrLoad` `cache.ts:557`; the brief's `getOrLoad` at `service.ts:2626` passes no `deadlineMs`. The `cache.ts` hunks since `a46d42c3` (`CacheCooldownError` `:342-351`, cooldown refusal `:420-423`, `script` `:1074`) do not touch `getOrLoad`. Logic unchanged. |
| 2 | SC1 (recall): with the cache breaker open, recall returns the same reply as a substrate with no cache | ✓ VERIFIED | `cache-breaker.test.ts:98` "recall returns the same reply as a substrate with no cache at all": pass in r38. `recallMemories` `service.ts:3798`, `recallUncounted` `:3826`. `service.ts` has no hunk on this path since `a46d42c3` (the one changed line is `:6421`). |
| 3 | Generation keys: a bump the breaker refused keeps reads on the source after it closes, until a bump lands | ✓ VERIFIED | `cache-breaker.test.ts:117` "generation keys: a bump the breaker refused keeps reads on the source after it closes, until a bump lands": pass in r38. `bump` `cache.ts:864` (failure adds the key to `staleGenerations`, `:872`); `getOrLoad` bypasses a stale generation at `:588`. Residual R1. |
| 4 | Degraded brief, H-1 (owner decision): with the cache breaker open and the live source failing, (a) if this process holds a last-good brief for the arguments that is inside the window and not forgotten, it is served as state `snapshot`, with a header naming the failed sources and the body equal to the complete brief; (b) otherwise state is `degraded`, no snapshot text is served, and the brief does not throw. A readable forget mark, an answering cache with no snapshot, or a mark read that fails while the breaker is closed refuses the copy. | ✓ VERIFIED (tested cases; scope note) | (a) `cache-breaker.test.ts:181` "a brief composed with the breaker closed is served as the snapshot once the breaker opens and the source fails": pass in r38; asserts `snapshot`, `failed` `["graph"]`, header and body equal. (b) `:199` "a snapshot older than the cache window is not served: the degraded brief answers": pass in r38; `degraded`, `snapshotAt` null. (c) `:217` "with the cache readable and no snapshot for the key, the last-good brief is not served: an answering cache is not an outage": pass in r38. (d) `:229` "with the cache readable, a forget another process made after the brief refuses the last-good copy": pass in r38. (e) `:242` "a mark read that fails while the breaker is closed refuses the last-good copy: a mark that cannot be read is not 'no forget'": pass in r38. (f) `service-forget.test.ts:688` "a forget that deletes a plane document refuses the in-process last-good brief while the cache breaker is open": pass in r38; this process's own forget is refused by `briefForgottenAtMs` (`service.ts:2534`, set at `:4563`) before the mark is read. Code: `briefDetailed` `service.ts:2482`; `rememberLastGood` `:2509`; `inProcessLastGood` `:2527`, verdict `:2539`; cache-readable path `:2734`; degraded return `:2735-2739`; write `:2605-2606`. **Scope note (updated by `f1266a9c`):** the copy is served only when the mark read is refused by the breaker (`BreakerOpenError`, `cache.ts:917`). The connect cooldown is checked before `callPlane` (`cache.ts:420-423`). The connect failure that starts a cooldown (`cache.ts:391`) is the usual way a breaker opens (`cache.ts`, failure threshold 5 and open 30 s per `breaker.ts:51-52`). For the 5 s after it, the mark read rejects with `CacheCooldownError` (`cache.ts:342`), which is not `BreakerOpenError`. `forgetVerdict` returns "forgotten" (`cache.ts:917`), so the copy is refused and the brief is `degraded` while the breaker is open. Since `f1266a9c` the same refusal is policed for admission (truth 7); the in-process copy keeps this behaviour. The sequence is shown by `cache.test.ts:1256` "the connect cooldown is reported and expires; a breaker refusal does not start one" (pass in r38; its gated case at `:1274-1280` needs the cooldown to lapse before `BreakerOpenError`). No test covers a mark read inside the cooldown with the breaker open; `closedGate` in `cache-breaker.test.ts` uses an in-memory store, not `bunRedis`. The outcome is fail-safe (copy refused, never served stale), so truth 4 is kept VERIFIED for the tested cases. Its literal wording "(a) ... is served" holds once the cooldown has lapsed. Raised under H-5 (O2). [INFERENCE] from code reading; not observed live. |
| 5 | SC2: per class, a fail-closed admission class is refused in `enforce` (503 `cache_unavailable`, `Retry-After`), a fail-open class admits as `bypass`, and neither reaches the plane. With no flag set every class is fail-open (D75-1) | ✓ VERIFIED | `admission.test.ts:325` "with no flag set every class is fail-open: an open breaker admits and counts a bypass, as it did before" and `:334` "a fail-closed class is refused in enforce with the breaker's wait, and the other classes stay fail-open": pass in r38. `cache-breaker.test.ts:145` "admission over the open breaker: a fail-closed class is refused, a fail-open class admits, and neither reaches the plane": pass in r38. `http.admission.test.ts:274` "an open cache breaker is a bypass for a fail-open class and a 503 for a fail-closed one": pass in r38. Enforcement: REST `server.ts:977` (`admission.admit`) with `sendBudgetRefusal` `server.ts:632`; MCP `server.ts:2779` (`admitBatch`). Since `f1266a9c` a fail-closed read in the connect cooldown is also refused in `enforce`. That is the composition of `cache.test.ts:1282` (the cooldown refusal carries `breakerRetryAfterMs`) and `admission.test.ts:334` (a `breakerRetryAfterMs` outcome is refused in `enforce`); no single test drives a live cooldown through `admission.admit`. [INFERENCE] for that composition. |
| 6 | A breaker refusal of a fail-closed class is a `bypass` in `shadow` and a `refused` in `enforce` | ✓ VERIFIED | `admission.test.ts:341` "a breaker refusal of a fail-closed class is a bypass in shadow and a refusal in enforce": pass in r38. Code: `admission.ts:386` (refusal branch, `enforce` only). `admission.ts` has no non-export change since `a46d42c3`; its line numbers are unchanged. |
| 7 | Only a refusal before the command was sent is policed (`breakerRetryAfterMs`): a breaker refusal, and since `f1266a9c` a connect-cooldown refusal. Another cache failure (timeout, the connect error that starts a cooldown, malformed reply) stays `bypass` in a fail-closed class | ✓ VERIFIED | `admission.test.ts:350` "only a breaker refusal is policed: another cache failure stays a bypass in a fail-closed class" (its body: a `connect ECONNREFUSED` outcome with no `breakerRetryAfterMs` is `bypass`): pass in r38. `admission.test.ts:243` "a cache that fails, refuses, or answers nonsense is a recorded bypass, never a refusal": pass in r38. `cache.test.ts:1282` "during the connect cooldown a fail-closed read is refused without a connect attempt": pass in r38; it asserts that the connect failure that starts the cooldown carries no `breakerRetryAfterMs`, and that a read inside the cooldown is refused with `breakerRetryAfterMs: 4_000` and no socket opened. Gate: `admission.ts:386` reads `outcome.breakerRetryAfterMs`, which both refusals set (`cache.ts:1074`). The title of `admission.test.ts:350` predates the cooldown refusal; its body still holds, and the title is cited as written. The same instanceof rule governs the mark read in truth 4 (`cache.ts:917`), and that is where the owner question H-5 stays open. |
| 8 | Flags: `SUBSTRATE_BUDGET_<CLASS>_BREAKER` parses trimmed and case-insensitively, blank is `fail-open`, and any other value refuses boot with a `ConfigError` naming the variable | ✓ VERIFIED | `admission.test.ts:365` "SUBSTRATE_BUDGET_<CLASS>_BREAKER parses per class, trimmed and case-insensitive; blank is fail-open" and `:375` "an invalid SUBSTRATE_BUDGET_<CLASS>_BREAKER refuses boot and names the variable": pass in r38 (the assertion that `loadConfig` throws is at `:378`). Code: `loadAdmissionSettings` `config.ts:1874` calls `breakerPolicyOf` (`config.ts:1909`), which throws at `:1933`. Registry: `flag-registry.ts:189`, `:219-228`. No behaviour change since `a46d42c3` (`config.ts` and `flag-registry.ts` changed by export removal only). |

**Score:** 8/8 truths verified. Truth 4 is verified on its tested cases; its scope is narrowed by the in-process copy being refused during the connect cooldown (H-5, owner question open). Truth 7 now includes the cooldown refusal (O2, fixed in `f1266a9c`). No truth is FAILED.

### Deferred Items

None. No gaps found, so nothing deferred.

### Required Artifacts (manual Levels 1-3)

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `packages/mcp-server/src/admission.ts` | admission decision, breaker policy | ✓ VERIFIED | No non-export change since `a46d42c3`; line numbers unchanged. Decision branch `:386` (reads `breakerRetryAfterMs`, so it now also sees the cooldown refusal); wired `server.ts:977`, `:2779`. |
| `packages/mcp-server/src/cache.ts` | gated read-through, stale generations, peek/put, forget verdict, connect cooldown | ✓ VERIFIED | Changed by `f1266a9c` (`CacheCooldownError` `:342`; cooldown refusal `:420-423`; `script` `:1074`) and export removals. `forgetVerdict` `:902` (instanceof rule `:917`), `snapshotSurvivesForget` `:925`, `getOrLoad` `:557`, `bump` `:864`, `markForget` `:882`, `peek` `:934`, `peekQuiet` `:965`, `writeKey` `:1033`, `snapshotKey` `:300`, `bunRedis` `:353`, connect cooldown constant `CACHE_CONNECT_COOLDOWN_MS` `:251`, cooldown start on connect failure `:391`, `withDeadline` `:714` (report `:717`), `fail` `:1159`, `attempt` `:1174`. |
| `packages/mcp-server/src/config.ts` | `loadAdmissionSettings`, `breakerPolicyOf` | ✓ VERIFIED | No behaviour change since `a46d42c3` (export removals `b8cbdeac`, `5e304ef8`). `:1874`, `:1909`, `:1929-1933`. |
| `packages/mcp-server/src/flag-registry.ts` | `SUBSTRATE_BUDGET_<CLASS>_BREAKER` family; snapshot TTL row | ✓ VERIFIED | Family `:189`, `:219-228`. Snapshot TTL row `:632`, text unchanged since `42e3cf13`. No behaviour change (export removal `b8cbdeac`). |
| `packages/observability/src/instruments.ts` | `ADMISSION_CLASSES` | ✓ VERIFIED | `:170`. No behaviour change (export removal `66fa97bd`). |
| `packages/observability/src/slo.ts` | numerator excludes `refused` | ✓ VERIFIED | Numerator `decision: "limited"` at `:360`. No behaviour change (export removal `66fa97bd`). |
| `packages/mcp-server/src/service.ts` | in-process last-good brief, cache gate, brief snapshot read | ✓ VERIFIED | No hunk on the truth paths since `a46d42c3`; the one changed line is `:6421` (`0947001e`, phase 63 path). Gate `:1948` `planes.gate("cache")`; fields `:1649`, `:1651`; `MAX_IN_PROCESS_BRIEF_SNAPSHOTS` `:545`; `briefDetailed` `:2482`; `rememberLastGood` `:2509`; `inProcessLastGood` `:2527`, verdict `:2539`; write `:2605-2606`; SWR lastGood `:2664-2668`; snapshot read and decision `:2730-2734`; degraded path `:2735-2739`; forget stamp `briefForgottenAtMs` `:4563`, `markForget` `:4567`. `withDeadline` is not called on the brief path. |
| `packages/mcp-server/src/server.ts` | REST and MCP admission wiring; `/handoff` guard | ✓ VERIFIED | `14ac787a` adds five lines at `:1507-1511` (handoff `to` check); later anchors move +5. `sendBudgetRefusal` `:632`, `admit` `:977`, `admitBatch` `:2779`. Body guards: `/evidence` `:1216`, `/handoff` `:1502`, `/drift` `:1591`, `/verify` `:1626`. handleMcp close catches `:2807-2808`. None of these is on the phase 75 truth paths. |
| `packages/mcp-server/src/service-forget.test.ts` (now in the digest) | forget refuses the in-process copy; snapshot tests | ✓ VERIFIED | Titles at `:592`, `:611`, `:626`, `:648`, `:668`, `:688`: pass in r38. File unchanged since `a46d42c3`. |
| `packages/mcp-server/src/cache-breaker.test.ts` (in digest) | H-1 and SC1 tests | ✓ VERIFIED | Nine testcases, all pass in r38 (titles in the truths table). Unchanged since `d1a5e89b`. |
| `packages/mcp-server/src/cache.test.ts` (in digest) | connect-cooldown tests | ✓ VERIFIED | `:1256` "the connect cooldown is reported and expires; a breaker refusal does not start one": pass in r38. `:1282` "during the connect cooldown a fail-closed read is refused without a connect attempt": pass in r38. Added by `f1266a9c`. |

### Key Link Verification (manual)

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `service.ts:1948` | `cache.ts:353` `bunRedis` → `breaker.ts` `callPlane` | `planes.gate("cache")` | ✓ WIRED | Every cache command is refused before `fn` runs when the breaker is open. The connect-cooldown check (`cache.ts:420`) runs before the gate and is not a breaker refusal; `script` reports it as `breakerRetryAfterMs` (`cache.ts:1074`). |
| `cache.ts:1074` `script` | `admission.ts:386` | `outcome.breakerRetryAfterMs` | ✓ WIRED | Set for a breaker refusal and, since `f1266a9c`, for a connect-cooldown refusal. Only a fail-closed class in `enforce` becomes a refusal. |
| `service.ts:2730-2734` | `cache.ts:934` `peek` | `brief-snapshot` read | ✓ WIRED | A refused read returns null, so the in-process copy path is taken. A readable cache's verdict (`snapshotSurvivesForget`, `cache.ts:925`) decides when the snapshot exists. |
| `service.ts:2539` `inProcessLastGood` | `cache.ts:902` `forgetVerdict` | `=== "unreadable"` | ✓ WIRED | The copy is served only for `unreadable`, which is the breaker's refusal alone (`cache.ts:917`). `clear`, `forgotten`, and any non-breaker failure (including the cooldown error) refuse. |
| `service.ts:2605-2606` | `service.ts:2509` `rememberLastGood` | written before `cache.put` | ✓ WIRED | Written whatever the breaker says; gated by window > 0 and cache enabled. |
| `service.ts:4563` | `service.ts:2534` | `briefForgottenAtMs` | ✓ WIRED | A copy saved at or before this process's last forget is not served. Set only when `touched`. |
| `server.ts:977` / `:2779` | `admission.ts` `admit` / `admitBatch` | per-request and batch admission | ✓ WIRED | `sendBudgetRefusal` (`server.ts:632`) renders 429 or 503. |
| `config.ts:1909` | `config.ts:1929` `breakerPolicyOf` | `loadAdmissionSettings` ← `loadConfig` | ✓ WIRED | A bad value throws `ConfigError` and refuses boot. |

### Data-Flow Trace (Level 4)

Not applicable to admission. For the brief under an open breaker, the answer is the index composition (truth 1) or the in-process last-good text (truth 4a). Both are asserted by the tests above. The process-local copy is a bounded map (`MAX_IN_PROCESS_BRIEF_SNAPSHOTS = 256`, `service.ts:545`).

### Behavioral Spot-Checks

No test was run in this pass. Each row is the r38 JUnit testcase (`gate-r38-junit.xml`, run on `66fa97bd`), checked for one testcase at that file and line with no `failure`, `error` or `skipped` child.

| Behavior | Testcase (file:line) | r38 result | Status |
| -------- | -------------------- | ---------- | ------ |
| T1a brief answered by index, cache never answers | `cache-breaker.test.ts:73` | pass | ✓ PASS |
| T1b recall equals uncached reply | `cache-breaker.test.ts:98` | pass | ✓ PASS |
| T1c refused bump keeps reads on source until a bump lands | `cache-breaker.test.ts:117` | pass | ✓ PASS |
| T1d fail-closed refused, fail-open admits, neither reaches plane | `cache-breaker.test.ts:145` | pass | ✓ PASS |
| T4a breaker open + source down + in-process copy → `snapshot` | `cache-breaker.test.ts:181` | pass | ✓ PASS |
| T4b breaker open + source down + window elapsed → `degraded`, no throw | `cache-breaker.test.ts:199` | pass | ✓ PASS |
| T4c readable cache, key absent → copy not served | `cache-breaker.test.ts:217` | pass | ✓ PASS |
| T4d readable cache, newer forget mark → copy refused | `cache-breaker.test.ts:229` | pass | ✓ PASS |
| T4e mark read fails, breaker closed → copy refused | `cache-breaker.test.ts:242` | pass | ✓ PASS |
| T4f forget that deletes a plane document refuses the copy | `service-forget.test.ts:688` | pass | ✓ PASS |
| T4g snapshot saved before a forget never served when a live source fails | `service-forget.test.ts:592` | pass | ✓ PASS |
| T4h SWR does not serve a last-good saved before a forget | `service-forget.test.ts:611` | pass | ✓ PASS |
| T4i snapshot saved after the forget still served | `service-forget.test.ts:626` | pass | ✓ PASS |
| T4j mark cannot be read → snapshot refused (source failing, cache readable) | `service-forget.test.ts:648` | pass | ✓ PASS |
| T4k mark cannot be written → every snapshot refused until a later forget | `service-forget.test.ts:668` | pass | ✓ PASS |
| T4l connect cooldown reported, expires; breaker refusal starts none | `cache.test.ts:1256` | pass | ✓ PASS (sequence evidence for the scope note) |
| T4m (O2) connect cooldown: fail-closed read refused, no connect attempt | `cache.test.ts:1282` | pass | ✓ PASS (fix `f1266a9c`) |
| T5 default fail-open; fail-closed in enforce; HTTP 503 with integer Retry-After | `admission.test.ts:325`, `:334`; `http.admission.test.ts:274` | pass | ✓ PASS |
| T6 shadow bypass / enforce refusal | `admission.test.ts:341` | pass | ✓ PASS |
| T7 only a breaker refusal is policed; other failures bypass | `admission.test.ts:350`, `:243` | pass | ✓ PASS |
| T8 flag parse and boot refusal | `admission.test.ts:365`, `:375` | pass | ✓ PASS |
| T9 flag registry and config reference match | not re-run; `flag-registry.ts` has no non-export change since `a46d42c3`, and `docs/config-reference.md` is unchanged | carried | ✓ PASS (carried) |

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
| (added lines, covered files and tests) | - | `TODO`, `FIXME`, `XXX`, `HACK`, `PLACEHOLDER`, `TBD` | - | None in the `d1a5e89b`, `f0f3c04e`, `a46d42c3` or `f1266a9c` added lines in covered files. |
| `docs/observability.md:230` | - | Window described without the failed-mark-read rule | resolved | `bb6b38b7` added "A forget mark that cannot be read while the breaker is closed refuses the copy too." The gap in the prior record is closed. |
| `docs/observability.md:170-171` | - | The connect cooldown is described (refuses to reconnect for 5 s, `cache.cooldownUntil` in `/healthz`) without its admission effect | ℹ️ Info | `f1266a9c` changed what a fail-closed read gets during the cooldown (503 in `enforce`). The doc does not say so, and `docs/config-reference.md:280` (the `SUBSTRATE_BUDGET_<CLASS>_BREAKER` row) describes the open breaker only. Doc gap, not a code gap. Not edited. |
| `packages/mcp-server/src/admission.ts:386` | - | Comment says "The breaker refused the bucket step" | ℹ️ Info | The branch now also takes the connect-cooldown refusal (`breakerRetryAfterMs`). The code is right; the comment names only the breaker. Not edited. |
| `packages/mcp-server/src/admission.test.ts:350` | - | Title "only a breaker refusal is policed" predates the cooldown refusal | ℹ️ Info | The body (a `connect ECONNREFUSED` outcome is a bypass) still holds. Cited as written. |
| `docs/config-reference.md` | snapshot TTL row | double period "at once.." | ℹ️ Info | Cosmetic; generator appends `. See` to a text ending in `.`. File unchanged. Not a gap. |
| `75-CONTEXT.md` | D75-2a, Verified facts, R3 | stale anchors: `config.ts:1849` (now `:1874`), `cache.ts:335` (now `:353`), `slo.ts:359` (now `:360`), `service.ts` ranges | ℹ️ Info | Documentation drift only. Not edited. |

### Human Verification Required

H-1 is CLOSED by the owner decision and the commits `9e6fa1f2`, `9c86ffab`, `e185cd8a`, `42e3cf13`, and `d1a5e89b` (failed-mark-read rule and test). It is no longer a human item.

Owner decisions of 2026-11-06 applied here: O1 accepted (H-4b closed); O2's fail-closed half fixed in `f1266a9c` (H-5 updated); the in-process copy question stays open under H-5.

Open human items (none verifiable by grep or targeted tests):

- **H-2** (operator live proof): stop live Dragonfly with default flags; `POST /brief` and `POST /memory/recall` answer 200 with authoritative content, within the timeout, and cache health reports degraded.
- **H-3** (operator live proof): with `SUBSTRATE_BUDGETS=enforce` and `SUBSTRATE_BUDGET_READ_BREAKER=fail-closed`, a real open breaker yields 503 `cache_unavailable` with integer `Retry-After` and one `refused` increment. A fail-closed read inside the 5 s connect cooldown takes the same 503 path (`f1266a9c`). Only the connect failure that starts a cooldown is admitted as bypass.
- **H-4a** (operator live proof): `substrate.admission.decisions{decision="refused"}` is visible in `/metrics`, the OTel/Greptime export and dashboards, with surface and class labels, outside the limited-rate numerator (`slo.ts:360`). Not re-checked in this pass.
- **H-4b**: CLOSED. The owner accepted the fail-closed read policy consequence (O1, 2026-11-06).
- **H-5** (owner item, open part): whether the in-process last-good brief stays refused during the connect cooldown window (CACHE_CONNECT_COOLDOWN_MS, `cache.ts:251`). Today it is refused as "forgotten" (`cache.ts:917`), because only `BreakerOpenError` reads as unreadable. The fail-closed admission half of O2 is fixed in `f1266a9c` (`cache.test.ts:1282`, pass in r38). Owner decides the in-process copy and directs any change. Kept NOT FIXED.

HARD-R2 write clause: unowned.

### Gaps Summary

No FAILED truth, no MISSING or STUB artifact, no NOT_WIRED link, no blocker anti-pattern. No `gaps:` block is emitted. Status is `human_needed` by the Step 9 rule: human items exist (H-2, H-3, H-4a are operator proofs; H-5 is an open owner item), and HARD-R2 is unowned. `passed` is not valid while the live proofs and the open owner item are open.

The truth 4 scope note (connect cooldown, in-process copy) is not a gap in the sense of the Step 9 rule: the copy is refused, never served stale, and the owner item H-5 covers the window. It is recorded so that the literal "(a) served while the breaker is open" is not read as holding during the cooldown.

### Residual Risks

- **R1** (carried, predates phase 75 H-1 work): `staleGenerations` lives in the writing process. After a restart or on another replica, a generation key can still hold its old value, and a brief written before the write can be served until its TTL (`CACHE_TTL["brief"]`, 5 minutes). Tests cover one process only. Follow-up.
- **R4** (owner trade-off, H-1): while the cache cannot be read (breaker open), this process's in-process last-good brief can outlive a forget made by another process. It is bounded by `SUBSTRATE_BRIEF_SNAPSHOT_TTL_S` (default 3600 s), held at most 256 argument sets, and refused at once for this process's own forgets. Once the cache is readable again its forget mark decides. Stated in `docs/observability.md:230` and the flag row (`flag-registry.ts:632`).
- **R5** (narrowed by `f1266a9c`): the connect-cooldown window. A fail-closed read inside the window is now refused (`cache.test.ts:1282`, pass in r38). The in-process last-good copy is still refused in the same window, by the current rule (truth 4 scope note). Fail-safe. Not covered by a test that runs `bunRedis` with the breaker open. Owner item H-5.
- **R6** (new): the r39 JUnit (`gate-r39-junit.xml`) was not written when this draft was made. Every cited title passes in r38, on `66fa97bd`. If r39 disagrees for a cited title, this record is revisited.
- The recall-snapshot leg (`SUBSTRATE_BRIEF_RECALL` enforced) has no in-process copy and no cache-breaker-open test in the tree as far as grep shows. Not claimed as covered.
- Load-failure reporting after a positive budget (`cache.ts:714-717`) is not reported; only the zero-budget branch reports (`cache.ts:717`). No phase 75 truth claims reporting. Noted for completeness.

### Self-check

- Covered list and digest copied verbatim from `gsd_run query verification.fingerprint` at `5e304ef8` (read-only), with `cache.test.ts`, `service-forget.test.ts` and `docs/observability.md` added to the 13 covered files.
- Every cited testcase was checked against the r38 JUnit by parsing the XML: one match on name, file and line, no `failure`, `error` or `skipped` child. Each title was also found in source at the cited `file:line`.
- Frontmatter `status: human_needed`, same vocabulary as the prior record.
- Owner decisions of 2026-11-06 recorded in Inputs and Scope, and applied in truths 4, 5, 7, the artifacts table and H-4, H-5.
- Not run: any test, `tsc`, lint, formatters, any edit or commit in the worktree.

---

_Verified: 2026-11-06T02:56:16Z_
_Verifier: Claude (gsd-verifier)_
