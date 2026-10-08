---
phase: "15"
slug: lessons-bank
status: verified
register_authored_at_plan_time: false
threats_open: 0
threats_open_total: 0
threats_closed: 15
asvs_level: 1
block_on: high
accepted_risks: 0
created: "2026-10-07"
verified: "2026-10-08T02:07:11Z"
verified_revision: "f956ec22e36401219d71c01562693261f0094f63"
tested_code_revision: "439fb50"
fresh_delta_verifications: 4
retained_historical_closures: 11
---

# Phase 15 — Security

> Current bounded delta verdict: **SECURED** at published head `f956ec2`, tested code `439fb50`. P15SecurityClosure independently closes F-15-02 and reconfirms T-15-04, T-15-12 and T-15-14; eleven unchanged threats retain qualified historical closure. All fifteen are closed, with zero open or accepted risks. The documentation-only follow-on changes no implementation/tests. This is mitigation-presence assessment depth 1, not a full ASVS certification or shipping receipt.

## Scope and evidence standard

- Implementation inspected: `/root/src/worktrees/agent-substrate-p15`. Planning artifacts and this report: `/root/src/worktrees/agent-substrate-v12/.planning/phases/15-lessons-bank/`.
- Source references below are relative to the implementation worktree. Earlier line anchors identify the initial seven-fix inspection; the diagnostic remediation shifted later CLI lines. The F-15-01 closure section cites the final implementation directly. Parent identifies the tested corrections as committed and pushed in `900a679` (`address greptile review feedback`).
- Read `15-01-PLAN.md`, `15-01-SUMMARY.md`, `15-VERIFICATION.md`, the GSD `secure-phase.md` workflow, `templates/SECURITY.md`, and `agents/subagents/gsd-security-auditor.md`. The plan has no `<threat_model>` and the summary has no `## Threat Flags`. The register is reconstructed from real code, not inferred clean from absent planning material.
- ASVS level 1 is the configured mitigation-presence depth, **not a claim of complete OWASP ASVS certification**. CLOSED below means the concrete mitigation was located at the cited boundary; runtime evidence is separately qualified.
- No product edits, tests, builds, scanners, deployment, commits, or runtime commands were performed by this report author. No signed verdict/envelope is fabricated. Parent-owned runtime evidence is explicitly attributed below.
- PR [#17](https://github.com/swcstudiospace/agent-substrate/pull/17) remains subject to fresh review and release gates. Historical summary language such as “What shipped,” earlier passed rows, and prior test totals is not evidence that this corrected branch has merged or shipped.

## Trust Boundaries

| Boundary | Description | Data crossing / security meaning |
|---|---|---|
| TB-1: operator/SUMMARY → CLI | `runLessons`, SUMMARY extraction, explicit text, flags, repo-derived scope | Untrusted lesson prose and metadata; local paths are inputs, not executable instructions. Dry-run intentionally displays the proposed body locally and is not a server redaction guarantee. |
| TB-2: CLI → HTTP/MCP transport | `httpMemory`: writes use `POST /memory`; reads use `tools/call memory_search` at `/mcp` | Bearer credential, scope, fact subject/body/key, query and cursor. A configured URL is an operator trust choice; this feature does not establish TLS or authenticate an arbitrary supplied server. |
| TB-3: authenticated transport → governance | `server.ts` and `mcp.ts` derive writer from the token, then `Substrate.writeMemory` calls `governMemoryWrite` | Body `writer`/tool `surface` cannot acquire another writer's grant. Anonymous transport, when explicitly configured, maps memory writer to `unknown`, not the supplied identity. |
| TB-4: governance → PG accepted/parked rows | Shape → default-deny RBAC → classification → idempotency/conflict → insert/read-back | Secrets, PII and speculative facts are classified before acceptance; denied callers do not even create quarantine rows. Global facts require review. Facts append; neither a digest nor an outcome edits its source lesson. |
| TB-5: MCP search → parser → parameterized PG | Typed tool schema and `parseMemorySearch` precede `IndexStore.searchMemoryPage` | Literal subject prefix, exact optional scope predicate, bounded page size, validated calendar/timezone cursor, `(created,id)` keyset. Search reads `memory_entries`, not quarantine/review tables. |
| TB-6: persisted facts → recall/ranking/citations | `BankReader`, citable parsers, digest exclusion, outcome scoring, renderer | Persisted ids become consumer citations. Unverified write responses cannot create a recorded/duplicate success. Stale trust is displayed as needing re-verification. Digest retirement is read-time filtering, not physical deletion. |
| TB-7: failures → local diagnostic/audit output | CLI stdout/stderr; service refusal audit and error redaction | The server redacts refusal audit fields and excludes the rejected body. CLI diagnostics now sanitize URL userinfo/query/fragment, scrub configured secrets, and use canonical redaction before truncation; F-15-01 is closed with actual-CLI and real-HTTP regression evidence. |

### Explicit limits of these boundaries

Scope is a search selector and write-policy class, **not a per-repository read-authorization boundary**. `memory_search` deliberately accepts an omitted scope; the feature must not be advertised as tenant isolation. Known writers can author repo facts under the existing grants. A phase/milestone header or outcome score is therefore an attributable claim, not a signed assertion that the named phase passed. `verified_persisted` proves matching storage/read-back, not truth, prompt safety, or human approval. `--unchecked` explicitly skips target-existence checking but still uses the same governed write path; it grants no additional write permission.

“Lossless history” means original facts are retained and readable, not that a generated digest reproduces every original character or that every query has exhaustive recall. Generated excerpts are capped at 200 characters each; explicit summaries are author-reviewed content. The CLI warns at 50 pages/family and on legacy newest-100 fallback. Those documented bounds must remain visible rather than becoming an unqualified completeness claim.

## Threat Register

All dispositions are **mitigate**. No threat is silently transferred or accepted.

| Threat ID | STRIDE category | Component / abuse | Severity | Disposition | Mitigation and evidence | Status |
|---|---|---|---|---|---|---|
| T-15-01 | Spoofing | Caller supplies another writer to acquire grants | high | mitigate | `server.ts:219-255,374-386`, `memoryWriter:89-90`; `mcp.ts:58-59,255-256` derive writer solely from token/`unknown`; `memory-policy.ts:149-164` rejects unknown wildcard and enforces self-scope. | CLOSED — source |
| T-15-02 | Elevation of privilege | Lessons become an ungoverned write, new memory kind, or raw-event storage bypass | high | mitigate | `lessons.ts:818-826,1101-1107,1303,1383-1386` sends only governed `fact` writes; `service.ts:659-705` invokes `governMemoryWrite`; `store-lock.test.ts:168-207` defines the existing single-write-path checks. Refusal events at `service.ts:719-748` contain decision metadata, never the lesson body. | CLOSED — source |
| T-15-03 | Information disclosure | Quarantined secrets/PII or unreviewed global content enters recall | high | mitigate | `memory-write.ts:355-436` grants before classification and stores redacted quarantine; `memory-classify.ts:151-159` makes secrets non-reviewable. `index-store.ts:1241-1247` reads only accepted entries and excludes superseded entries by default. Parked tables are not joined. | CLOSED — source |
| T-15-04 | Tampering | A denied/quarantined/unverified write is represented as durable and citable | high | mitigate | `USABLE`, `interpret` and `writeGoverned` require accepted plus `verified_persisted` plus entry id, with one unchanged-request retry only for unverified acceptance. Exact parked ids remain diagnostic and non-usable. Diagnostic normalization cannot create a false durable success. | CLOSED — source and parent behavioral evidence |
| T-15-05 | Tampering | Query/prefix/cursor injects SQL or `%`, `_`, `\\` widens subject selection | high | mitigate | `index-store.ts:1235-1250` builds fixed tagged-SQL fragments with values bound as parameters; prefix uses `left(subject,char_length(prefix)) = prefix`, not LIKE. `mcp.ts:273-307` supplies typed inputs and bounded limit. | CLOSED — source |
| T-15-06 | Information disclosure | A scoped lesson lookup crosses into another scope or an id-prefix neighbor | medium | mitigate | `BankReader.pages` always passes its scope (`lessons.ts:1168-1175`); `index-store.ts:1244` applies exact equality; digest/outcome existence checks read the same bank (`1255-1277,1335-1353`); `outcomesFor:1313-1318` compares the full lesson id after prefix search. This closes accidental scoped selection leakage, not absent tenant authorization. | CLOSED — source |
| T-15-07 | Denial of service | Impossible calendar values reach PG and become database errors | medium | mitigate | `service.ts:374-401,430-454` validates leap years, month/day, clock, zero-year, fractional midnight and displacement before the index; original valid strings retain their microseconds and zones. `mcp.ts:306-307` converts `InvalidSearchError` to structured refusal. | CLOSED — source and parent-reported final suite |
| T-15-08 | Tampering | Paging skips/duplicates old lessons, digests or outcomes and corrupts derived decisions | high | mitigate | `index-store.ts:1235-1254` uses direct strict tuple bounds, deterministic `created desc,id desc`, and server-rendered microsecond cursor; `lessons.ts:1168-1182,1198-1214` follows all three families with explicit cap warnings. | CLOSED — source, final suite and parent-reported live proof |
| T-15-09 | Denial of service | Deep scoped pages repeatedly scan/sort the full prefix history | medium | mitigate | `index-store.ts:268-270` adds `(scope,created desc,id desc)` index; `1233-1249` exposes scope and tuple bounds rather than nullable OR predicates. CLI has 100-entry pages, 50-page cap and timeout. Parent reports paired/before-only/history IndexScan evidence with scope and cursor in Index Cond; see audit trail. Sparse predicates/unscoped scans are not claimed constant-cost. | CLOSED — source and parent-reported isolated PG evidence |
| T-15-10 | Tampering | A later partial digest erases unrelated earlier digest coverage from recall | high | mitigate | `lessons.ts:406-419` retains disjoint and overlapping batches until a newer digest of the same milestone is a full superset. `lessons.test.ts:601-624` asserts citations and topic recall before and after a covering digest. | CLOSED — source and parent-reported final suite |
| T-15-11 | Tampering | Oversized digest retires originals while retaining only ids/generic text, destroying useful recall | high | mitigate | `digestBody:215-231` requires content for every generated excerpt, or explicit nonempty summary; header with every id must fit 4000. `digest:1290-1295` refuses without writing if not. `lessons.test.ts:626-670` covers topic retention, unchecked ids and oversized id lists. | CLOSED — source and parent-reported final suite |
| T-15-12 | Repudiation / Tampering | Old landed-report retries undo a newer correction, or retries multiply votes | high | mitigate | `outcome` validates exact bounded report identity before reads/writes. Its scoped key depends only on scope, lesson, citing milestone/phase and report id; stored history, result and note never alter it. Same valid payload replays; changed valid payload conflicts; fresh ids append. Stored metadata uses SHA-256(report id), while JSON reports preserve the original. `scoreOf` counts one latest report per phase in server order. Existing facts remain readable. Replay is bounded to an already-persisted report in the same body format, not logical-time fencing or cross-format duplicates. | CLOSED — source, focused suite and parent committed-response-loss proof |
| T-15-13 | Tampering | Millisecond conversion reorders equal-time outcomes, selecting an older verdict | medium | mitigate | `scoreOf:339-341` keeps the first server-newest record on a parsed-time tie and replaces only on a strictly newer timestamp. `lessons.test.ts:520-526` covers equal milliseconds and lost microsecond precision. | CLOSED — source and parent-reported final suite |
| T-15-14 | Tampering | Outcome note is silently cut while the key/report implies complete evidence | medium | mitigate | `outcome` measures the entire body, including the fixed 64-character report digest, against 4000 characters before dry-run output/write; prerequisite reads can occur first. Regression “outcomes accept exactly 4000 body characters and refuse 4001 before writing” passes in the parent 60-test run. Historical 4109-character proof is not relabeled as a hashed-header execution. | CLOSED — source and parent boundary suite |
| T-15-15 | Information disclosure | Transport failures echo credential-bearing URLs or unsanitized upstream diagnostics to stdout/stderr | medium | mitigate | `lessons.ts:786-814,878-889` collects configured/encoded/decoded/JSON-escaped secrets, recursively normalizes object/array diagnostics and scrubs before the cap. Null reasons retain fallback; only reason preserves `review.required`; IDs/decisions are untouched. `lessons.test.ts:993-1147` and parent 4/4 actual-CLI before/after closure checks support the source trace. | CLOSED — P15SecurityClosure, F-15-02 fixed without waiver |

Current counts: **15 threats; 15 closed (4 freshly reassessed, 11 retained historical); 0 open; 0 accepted risks**. All six STRIDE categories are represented. This is a bounded source-and-runtime-evidence assessment, not a clean scanner result.

## Seven PR #17 corrections: security/integrity assessment

| Correction | Consumer risk addressed | What the inspected correction establishes | What it does not establish |
|---|---|---|---|
| Retain partial digest batches | Prior knowledge silently vanishes after a later partial batch | Whole-batch same-milestone superset test; disjoint/overlapping digests remain candidates (T-15-10). | Does not authenticate an author's choice of ids or guarantee an arbitrary summary's semantic quality. |
| Refuse oversized digest without useful summary | Original ids excluded with no useful replacement | All ids and explicit summary fit; generated path retains an excerpt per lesson; impossible input is refused (T-15-11). | Excerpts are not full original text; originals, not summaries, preserve full history. |
| Explicit report-identity outcome corrections | Old landed-report retry overrides a newer verdict, or a new correction reuses an old key | Scoped identity-only key; already-persisted same-payload replay keeps the original id and newer score; new ids append corrections. Stored SHA-256 metadata cannot become a hedge; the note remains governed (T-15-12). | Not logical-time fencing for first/concurrent commits, and not duplicate compatibility across different body formats; server order remains authoritative. |
| Preserve server order at timestamp ties | Older verdict wins because JavaScript dates discard precision | First tied entry stays latest; unit cases deliberately oppose id order (T-15-13). | Client cannot recover finer timestamp ordering from a preexisting unsorted legacy result. |
| Reject outcome body over 4000 | Persisted note differs from consumer's evidence | Full body measured before write; exact boundary and dry-run covered (T-15-14). | No new general server text-size policy; this protects this CLI's complete outcome body. |
| Scoped index and direct tuple bounds | Scaled bank makes reads excessively expensive | Scope-leading ordered index and indexable cursor; parent reports actual deep-seek query plans (T-15-09). | Does not eliminate sparse-prefix/full-text filtering cost or guarantee ordered seek for unscoped queries. |
| Validate calendar fields before PG | Malformed cursor causes database exception rather than refusal | Calendar, precision, timezone and strict pairing accepted/refused before index (T-15-07); final full suite includes the service-boundary regressions. | Schema syntax alone is insufficient; closure uses service validation, not only regex matching. |

## Requirement and boundary proof assignments

These are identified tests and proof obligations. Suites and live executions were performed by Main, not the report author; the audit trail distinguishes each evidence source. The current CLI HTTP fixture uses the production fact classifier but simulates governance/storage, so that suite alone cannot prove production RBAC or PostgreSQL behavior. Named real-store checks and the retained 31-check bank flow supply distinct runtime evidence. Edge cases without a named smoke remain source/regression evidence, not separately executed actual-CLI scenarios.

| Criterion / plan tasks | Source and exact existing coverage | Proof obligation / evidence scope |
|---|---|---|
| LES-01: governed fact, dedupe, accepted+verified only; tasks 2,4,6,7 | `lessonBody`, `lessonKey`, `interpret`, `writeGoverned`; `lessons.test.ts` tests “each SUMMARY lesson is one fact at repo scope, and adding them again yields the same entries”, “a hedged lesson is reported as quarantined, sent once, and given no citable id”, denied/unverified tests at 436-461. Inherited `memory-write.test.ts`: “nothing is written before RBAC runs, not even a quarantine row”, “a secret is parked and stored redacted”, “a reviewer's token does not release a secret”, read-back/replay cases at 1325-1360. | Actual CLI → real server → PG: accepted+verified id, same-key duplicate same id, quarantine absent from search, refused write not treated as durable. Include no-bypass lock results from the final branch. |
| LES-02: SUMMARY extraction and human review; tasks 1,2,3,6,7 | `parseSummary:559-606`, `runLessons`, add; `lessons.test.ts` “one lesson per top-level bullet under ## Lessons, with continuations, tags, outcome and a slug from the bold lead”, frontmatter key-decisions test, and SUMMARY-without-lessons error at 493. | Real CLI dry-run and accepted write of a selected SUMMARY lesson; dry-run output is operator-visible raw proposal, not proof it is safe to persist. |
| LES-03: ranked, scoped, cited recall; tasks 5,6,7,9 | `rankLessons`, `renderPriorLessons`, `BankReader`; `lessons.test.ts` “recall returns a Prior Lessons block citing each matching entry id, best match first”, “recall pages through all 130 lessons, so the oldest relevant ones are all considered”, “a search the server refuses is not mistaken for an empty bank”. `index-store.search.test.ts:82-213` covers literal metacharacters, 257 rows with shared microseconds, scope, history and missing cursor-anchor row. `mcp.test.ts:500-575` covers invalid calendar refusal and preserved valid cursor bytes. | Actual CLI cites an old lesson behind >100 newer records; PG pages have no gap/repeat; invalid timestamp yields structured refusal before DB work; unauthorized read is not mistaken for empty success. F-15-01 diagnostic canary must be absent. |
| LES-04: digest cites every selected id; deletes nothing; tasks 2,5,6,7 | `digestBody`, `rankLessons`, `digest`; tests at `lessons.test.ts:579-670`, including partial disjoint/overlapping batches and oversized/unchecked refusal. | Actual CLI partial-batch and explicit-summary scenarios; verify originals remain readable and recall uses the proper active digest coverage. No ids-only success for an oversized batch. |
| LES-05: appended outcomes, derived score and retry-safe correction; tasks 5,6,7 | `outcome`, `outcomesFor`, `scoreOf`; current 60-test suite covers required report identities, history-independent keys, landed-response-loss retry, payload conflict, new-id corrections, boundary refusal, immutable originals and server-order timestamp ties. | Parent 18-check real-store flow: already-committed success loses its reply, fresh failure scores 1/3, retry returns original id without a third fact or score rollback, new success scores 2/3; opaque report identity accepted/replayed while speculative note remains quarantined. |
| PROOF-04: source lesson → recalled citation → outcome → milestone digest; tasks 6,8 and phase proof | Historical links in `15-01-SUMMARY.md:56-60`; workflow conventions in `docs/lessons-bank.md`; implementations above. | Bind fresh actual-CLI/PG evidence to the final corrected revision, retain verifiable lesson/citation/outcome/digest ids, and distinguish historical cross-phase citation from a new demonstration. |
| No new write path/raw-event bypass; task 9 is read-side only | `service.ts:678`, three CLI `fact` write callsites, `store-lock.test.ts:168-207`; docs `lessons-bank.md:7-12` and `memory-governance.md:18-47`. | Final full suite and typecheck, plus runtime governance rejection/read-back proof; no claim that static lock tests alone validate actual write behavior. |

Task 8 documentation is supporting contract material, not substitute implementation evidence. Task 1 argument extraction is not a new authority boundary; its callers enter the same `runLessons` validation/write paths.

## Findings and Closure

### F-15-01 — Medium: CLI transport diagnostics disclosed configured URL credentials

- **Threat:** T-15-15. **Status:** CLOSED at `900a679`; mitigated, not accepted. Parent assigned implementation to `FixLessonSemantics`; this author changed only this report.
- **Original source:** `packages/cli/src/lessons.ts`, pre-fix `httpMemory.send` catch embedded `${base}${path}` and command failure paths printed it. Raw upstream error snippets also bypassed server redaction.
- **Failing scenario:** Configured URL `http://user:canary-secret@127.0.0.1:1`, actual `lessons recall`, captured stderr. Parent observed `canary-secret` in the diagnostic. The userinfo-bearing fetch was rejected, but interpolation exposed the secret without a successful request.
- **Final implementation inspected:** `lessons.ts:760-771` removes URL username/password/query/fragment for diagnostics. `786-810` scrubs configured bearer and URL secrets in literal/encoded/decoded forms and applies canonical `redact` before the 200-character cap. `822,838,844-859,869-878` covers fetch errors, malformed/non-JSON replies, HTTP/JSON-RPC/tool refusals, invalid result JSON and governed write diagnostic fields. Actual endpoint, authorization header, request body and successful entry payload remain on their original paths.
- **Passing actual-CLI evidence:** Main reports the previously failing command now emits an endpoint-only diagnostic beginning `http://127.0.0.1:1/mcp did not answer...`, with no userinfo, configured token or `canary-secret`; recall still exits 0 and does not fabricate recalled ids.
- **Passing regression evidence:** Nine real-HTTP tests in `lessons.test.ts` under `lesson transport diagnostics`, including userinfo/query/fragment failure, five search error shapes, non-JSON write refusal with redact-before-cap, governed refusal reason/remedy, and successful governed payload preservation, are included in Main's final 1138-pass run. The source checks credential absence and retained HTTP/refusal semantics; no mock-only echo is presented as live-server proof.

### F-15-02 — Medium: structured upstream write diagnostics bypass credential redaction

- **Threat:** T-15-15. **Status:** CLOSED. LessonSecurityDelta identified the string-only normalization gap at `e7be626`; P15SecurityClosure independently verified its mitigation at tested code `439fb50` / documentation head `f956ec2`. No risk acceptance.
- **Boundary:** upstream unknown HTTP JSON → `httpMemory.write` → `interpret` → human/JSON report. All three diagnostic fields now normalize non-null non-strings with `JSON.stringify(redactValue(value))`, then use the shared credential scrubber before the cap (`lessons.ts:878-884`; `redact.ts:98-110`).
- **Closure:** configured secrets include JSON-escaped variants (`lessons.ts:786-808`); URL/configured/canonical credentials are scrubbed before `slice(0,200)` (`809-814`). Only exact reason `review.required` is exempt (`880`); null retains error fallback; outcome/verification/entry/conflict/review/quarantine fields remain exact.
- **Parent runtime evidence:** three actual CLI confidentiality scenarios fail before and pass after the fix: JSON object reason/array remedy denial, human array-error/null-reason refusal, and JSON nested-object error refusal. A fourth check proves unchanged authorization and exactly three POSTs/no retries. The 60 focused/1146 full-live-PG tests and 18 real-store checks pass. Auditor read tests/source only; no new scanner or signed clearance.

### Evidence limits and remaining release gates

1. The final full Bun and typecheck results below supersede the earlier 1129-pass/typecheck-pending checkpoint. F-15-01 now has both source remediation and actual-CLI closure evidence.
2. Existing toy-gate tests do not replace PostgreSQL/governance proof. The retained 31-check live flow and three actual PG query-plan checks supply that distinct evidence; `index-store.search.test.ts` still requires `SUBSTRATE_TEST_PG_URL` when rerun.
3. The new PR #17 review is pending. Security verification of this phase does not assert a Greptile score, review approval, merge, deployment or archive. Those remain parent-owned release gates and are not unresolved threat mitigations.

## Accepted Risks Log

**No accepted risks.** F-15-01 was fixed and verified rather than waived. Documented scope limits are not risk acceptance entries, and no vendor transfer is asserted.

## Security Audit Trail

| Audit date | Threats total | Closed | Open | Run by / evidence class |
|---|---:|---:|---:|---|
| 2026-10-07 | 15 | 14 | 1 medium; 0 high/critical | Formal15Security: read-only source/contract/test inspection; retroactive STRIDE. No tests, scanners or runtime execution by report author. |
| 2026-10-07 | 15 | 15 | 0 | Formal15Security final source review plus Main's executed regression/typecheck/CLI/PG evidence; verified revision `900a679`. |
| 2026-10-08 | 15 | 14 | 1 medium; 0 high/critical | LessonSecurityDelta read-only source/test/contract review reopens T-15-15 as F-15-02; SHA-256 report metadata introduces no identified new threat. Parent runtime remediation pending. |
| 2026-10-08 | 15 | 15 | 0 | P15SecurityClosure mitigation-only reassessment at `f956ec2` / code `439fb50`: four fresh delta verifications, eleven qualified historical closures; parent 60/1146 tests, 18 real-store and 4 controlled-upstream CLI checks attributed separately. No auditor execution or waiver. |

### Historical evidence — not newly executed

`15-01-SUMMARY.md:49-60` records 1090 pass / 0 fail with live PG, 1044 pass / 55 skip without DB, an earlier clean typecheck, and `/tmp/p15-lessons-proof.sh` with 31/31 twice. It also records lesson `mem_43bc8ddeb0244fc69758a24005e42f75` cited by Phase 14 and digest `mem_2c3f2eb6a24842e1bbef46759fa5c35e`. Those are historical artifact claims, not post-seven-fix execution evidence or a fresh production result. At initial inspection `15-VERIFICATION.md` said `gaps_found`; its older passed table was not used to override the then-open finding. Parent owns reconciliation of that separate artifact with final evidence.

### Historical parent evidence — `900a679`

- **Final revision:** Main reports all ten edited implementation/test/documentation files committed and pushed as `900a679`, `address greptile review feedback`. This report author did not commit or ship anything.
- **Final full Bun and typecheck:** Main reports **1138 pass, 0 fail, 4254 expectations, 39 files, 6.10 seconds**, and clean TypeScript checking in **artifact 1741**. The nine new diagnostic tests are included. This supersedes the earlier 1129-pass checkpoint and pending type-test correction.
- **Retained actual CLI/live stores:** **31/31** at `/tmp/p15-proof-1791411493`, reported by Main. This covers the existing real CLI/governance/PostgreSQL flow; it is not represented as 31 newly rerun checks after the diagnostic-only correction.
- **Additional actual CLI outcomes:** Main reports success→failure→success produced **three unique correction ids**, each identical retry was a duplicate, and scores were **2/3 → 1/3 → 2/3**. A **4109-character** outcome body exited **1** and stored no extra outcome.
- **Additional actual CLI outage:** Main reports a multi-SUMMARY run made **one HTTP attempt**, produced **six reports**, and stopped sending after the first unreachable write.
- **Deep PG seek:** paired cursor, timestamp-only cursor and history queries each used IndexScan with scope plus cursor in `Index Cond`, **100 rows, 9 buffers, no Sort**, on a **200,000-row** isolated fixture rolled back afterward, reported by Main. This supports T-15-09 without claiming globally constant cost.
- **Actual CLI diagnostic closure:** Main reran the previously failing configured-userinfo canary scenario; stderr now shows only `http://127.0.0.1:1/mcp did not answer...`, no userinfo/token/canary, with recall exit **0** preserved. F-15-01 is closed.

No command transcript, signed security envelope, clean SAST/dependency/secret scan, final merge result, or archived-release claim is implied by these reports.

## Historical Sign-Off — `900a679`

- [x] All reconstructed threats have a category, severity, disposition, boundary and mitigation evidence or explicit gap.
- [x] All six STRIDE categories and seven PR #17 corrections are assessed.
- [x] Accepted risks explicitly documented as none.
- [x] Severity-filtered `threats_open: 0` and total open count zero confirmed; all 15 threats closed.
- [x] F-15-01 corrected and closed with source inspection, real-HTTP regressions and parent actual-CLI redaction evidence.
- [x] Parent-owned final full Bun and typecheck passed; live-store and actual-CLI evidence is recorded with its scope and provenance.
- [x] `status: verified` set for `900a679`; no risk waiver or fabricated signed verdict used.

**Historical approval: security verified 2026-10-07 for `900a679`, ASVS assessment depth 1.** This does not close the current F-15-02 delta. No Greptile approval, merge, deployment or archive is claimed.

## Current Sign-Off — `f956ec2` / tested code `439fb50`

- P15SecurityClosure returned **SECURED**, ASVS assessment depth 1, `block_on: high`, all 15 dispositions `mitigate`, 15 closed, zero blocking/non-blocking open, zero accepted risks/waivers, no unmapped flag observed within the assigned delta.
- Fresh source checks: T-15-04 (`lessons.ts:668-693,1005-1024`), T-15-12 (`1395-1407,1430-1473,334-347`), T-15-14 (`1438-1460`) and T-15-15 (`763-889,1027-1036`); eleven unchanged backend/digest/order threats retain their earlier qualified source/runtime evidence, not fifteen fresh scans.
- Current parent evidence: 60 focused tests / 468 assertions; 1146 full/live-PG / 4385 assertions / 39 files; clean typecheck and CLI LSP; 18 current real-store actual-CLI checks (`artifact://68`); 4 current controlled-upstream diagnostic checks with defect-sensitive pre-fix control. These last four are not PostgreSQL executions.
- Retained unchanged-path bank evidence: 31/31 at `e7be626`, `/tmp/p15-proof-1791422085`. PROOF-04 source/citation/outcome/digest and all six originals were read-only rechecked; no duplicate historical close write.
- Published head `f956ec2` changes only JSON-report documentation after tested code `439fb50`. Scope remains a selector, not tenant isolation; first/concurrent report ordering and different body formats are not fenced by report identity. Page caps, legacy fallback, digest excerpt limits and same-account isolation assumptions remain disclosed.
- Parent records the independent verdict and its provenance. No full ASVS certification, new scan, signed envelope, fabricated user approval, production deployment, release tag, PR merge or milestone archive is asserted by this security record.
