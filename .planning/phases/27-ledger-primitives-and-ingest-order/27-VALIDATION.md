---
phase: "27"
slug: "ledger-primitives-and-ingest-order"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-08"
---

# Phase 27 — Validation Strategy

> Native GSD validation of the already-implemented ANCHOR-01/02 source contract. This audit reviews existing behavioral tests and attributes runtime results to the parent; it does not replay implementation or execute checks.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Existing `bun:test`; TypeScript typecheck. Bun 1.4.0 is the historical phase runner, not newly measured here. |
| **Config file** | `/root/src/worktrees/agent-substrate-v13-autonomous/tsconfig.json`; no separate test config |
| **Quick run command (parent only)** | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/ledger /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.test.ts /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/store-lock.test.ts /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/redact-lock.test.ts` |
| **Full suite command (parent only)** | From `/root/src/worktrees/agent-substrate-v13-autonomous`: `bun test && bunx tsc --noEmit` |
| **Scratch runner (parent only)** | `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/rehearsal.ts` creates an owned instance and its private `stores.env`; `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/greptime-smoke.ts` consumes that environment. Parent owns teardown. No environment values are recorded here. |
| **Historical runtime estimates** | Quick ~15 s, full ~90 s, scratch ~120 s. These are the original estimates, not fresh measurements or a current latency guarantee. |

---

## Sampling Rate

- Original execution sampling: quick behavioral suite after each task commit; full suite after each plan wave; full suite plus owned scratch proof before verify-work.
- Resume sampling: reuse the parent's final corrected-union gates; do not launch sibling checks. No child test/build/lint/smoke/scan/gate/formatter/runtime command was run.
- Historical target feedback latency: 120 seconds; not freshly measured.
- Runtime green is not a substitute for missing assertions. G27-01/G27-02 and isolated schema-drift coverage were reconciled against the actual added assertions and the parent's final passing suite; see the final closure audit.

---

## Per-Task Verification Map

Canonical task IDs are plan/task ordinals, not invented requirement-level IDs. Commands below are mappings for the parent, not executions by this auditor. **P** = parent's final corrected-union source gates: full suite 2719 pass / 58 skip / 0 fail across 96 files, typecheck exit 0, locks 108 pass / 0 fail. **S** = parent's final owned scratch proof, 47/47, comprising 28 ingest/ledger checks and 19 fake-chain anchor checks. Parent evidence explicitly describes owned source corrections pending commit; the old unchanged-revision gates are superseded, not relabeled as final. Evidence provenance is detailed below.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command / Evidence | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|------------------------------|-------------|--------|
| 27-01-01 | 01 | 1 | ANCHOR-02 | — | Prerequisites recorded, never fabricated | static prerequisite record | `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/27-ledger-primitives-and-ingest-order/27-BASELINE.md` (2026-10-09 record) | yes | historical record; inspected |
| 27-01-02 | 01 | 1 | ANCHOR-02 | T-27-01, T-27-02, T-27-SC | RFC 6962 roots, UTC boundaries, memo-only content, RPC memo-program filtering, argv without a shell; workspace API resolves | unit/typecheck | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/ledger`; parent full-suite/typecheck P; byte-identity evidence remains historical in 27-01-SUMMARY | yes | green (P); port identity historical |
| 27-01-03 | 01 | 1 | ANCHOR-02 | T-27-01 | Event INSERT picker survives a second INSERT; no second store/redactor door | unit/lock/static | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/store-lock.test.ts /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/redact-lock.test.ts`; P; plan-scoped COVERAGE record inspected | yes | green (P) |
| 27-02-01 | 02 | 2 | ANCHOR-01 | T-27-04, T-27-05 | Append-only ingest DDL, no plain-CREATE fallback; canonical anchors shape; isolated type/semantic drift warnings without rewriting | unit/integration | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts`; P and S | yes | green (P/S), schema-drift assertions inspected |
| 27-02-02 | 02 | 2 | ANCHOR-01 | T-27-03, T-27-04 | Event row first and exactly once; quoted ingest values/NULL graph; fresh retry stamp; typed failure; exact closure event/hour diagnostic | unit | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts`; P | yes | green (P); G27-01/G27-02 FILLED |
| 27-02-03 | 02 | 2 | ANCHOR-01 | T-27-03, T-27-04, T-27-05 | DDL, isolated shape drift, ordering, retry, rejection, closure warning and known-value privacy cases exercise the actual client via stubbed fetch | unit/lock | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/store-lock.test.ts`; P | yes | green (P); coverage gaps FILLED |
| 27-03-01 | 03 | 3 | ANCHOR-01/02 | T-27-06, T-27-07 | Earliest-record membership, duplicate collapse, previous-hour exclusion, code-unit tie order, bounded batches, named failure instead of partial leaves | unit | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts`; P | yes | green (P) |
| 27-03-02 | 03 | 3 | ANCHOR-01/02 | T-27-07, T-27-08 | Consumer sees stored-with-warning/no re-emit on unconfirmed ingest; invalid/open hours rejected; empty hour nulls root/memo | unit/typecheck | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.test.ts`; P | yes | green (P) |
| 27-03-03 | 03 | 3 | ANCHOR-01/02 | T-27-06, T-27-07, T-27-08 | Real client read logic through hourDigest proves shuffled-row invariance, backdating and named missing/malformed-row failure | unit composition/lock | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.test.ts /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/store-lock.test.ts`; P | yes | green (P) |
| 27-04-01 | 04 | 4 | ANCHOR-01/02 | T-27-09 | Owned real scratch store proves one ingest record per burst event, stable digest, raw-row order, backdated membership, intact chain/hashes | integration | Parent-owned rehearsal + `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/greptime-smoke.ts`; S, no child invocation | yes | green (S), v0.14.4 only |
| 27-04-02 | 04 | 4 | ANCHOR-01 | T-27-05, T-27-10 | Operator-approved read-only reconciliation of canonical 11-column anchors shape | manual historical checkpoint | No automated command; existing APPROVED record dated 2026-10-08, repeated 2026-10-09 in 27-04-SUMMARY | yes | historical approved; not repeated |
| 27-04-03 | 04 | 4 | ANCHOR-01/02 | T-27-09 | Docs preserve both DDLs, ignored D-era column, no backfill, adopt-before-write and version gap; README describes pure primitives | static documentation/lock | `/root/src/worktrees/agent-substrate-v13-autonomous/docs/greptime-ledger.md` and `/root/src/worktrees/agent-substrate-v13-autonomous/README.md` inspected; store-lock included in P | yes | inspected; locks green (P) |

### Behavioral coverage and adversarial robustness

All source/test references in this section are under the absolute integration directory `/root/src/worktrees/agent-substrate-v13-autonomous`; links below name the actual files and assertion ranges.

| Behavior | Actual meaningful tests / assertions | Coverage assessment |
|----------|--------------------------------------|---------------------|
| Half-open UTC boundaries and ascending closed-hour enumeration | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/ledger/src/period.test.ts:8-39` checks first/last millisecond, exact next-hour rollover, ISO end, lag minus one/exact lag, and enumeration stopping before open hours | Concrete expected times, not self-derived roots or mere export existence; green via P |
| Unsafe/non-whole starts, open-hour refusal, exact closure, empty hour | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.test.ts:1839-1875` rejects fractional/NaN/infinite/unsafe starts as InvalidEventError without ledger reads; CLOSED-1 rejects, CLOSED reads; empty result asserts the full public object including ISO period, zero count, null root/memo and empty ids | Consumer-visible contract; green via P. Period primitives themselves are not claimed to validate arbitrary input |
| Independent Merkle oracle | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/ledger/src/merkle.test.ts:4-39` pins eight literal RFC 6962 roots including non-power-of-two sizes, empty rejection and order sensitivity; :66-70 rejects malformed hashes. `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.test.ts:1877-1913` independently computes SHA-256 over 0x00 plus one hash, pins exact memo, and checks reordered/altered leaves change the root | Multi-leaf service expectations reuse the library, but literal vectors and independent single-leaf oracle prevent a wholly circular proof; green via P |
| First record, duplicate collapse, prior-hour exclusion, code-unit ordering and backdating | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts:1176-1220` sends shuffled E1/E5 duplicates, earlier E4, tied E1/E2 and backdated E3; asserts exact leaves and earliest E5 timestamp. :1223-1237 pins half-open ISO SQL and unbounded lookback; :1302-1326 exercises 501 members and two batches. `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.test.ts:1933-1980` runs actual hourLeaves logic through hourDigest under three server permutations and asserts exact ids/root | Client unit stubs do not execute SQL filtering, and the subclass overrides sql; the separate scratch proof supplies actual Greptime parsing. No claim that service re-sorts arbitrary typed leaves; green via P/S |
| Missing row, malformed hash, conflicting stored hashes, malformed time cannot yield a partial digest | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts:1240-1266` requires rejection naming E3/E2/E1; :1250-1252 specifically supplies two different hashes for E1. `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.test.ts:1923-1929,1983-1989` proves propagated rejection and real-client missing/malformed failures | Conflict is directly covered in the actual client, not a fake success path; caller composition uses that client. Green via P |
| Event-first write, retry and typed double failure | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts:982-1051` asserts exact INSERT order, NULL graph, one event INSERT/two ingest attempts, recovered retry, fresh cross-hour ISO retry stamp and eventId-bearing IngestNotRecorded. :1054-1094 refuses deduplicating ingest and verifies an exhausted shared budget does not permit a second full wait. :1120-1149 tests completion at CLOSED-1 and CLOSED, event/hour diagnostic and one captured write | Real client through stubbed fetch, meaningful failure injection; green via P. G27-01/G27-02 FILLED by actual regression assertions, not copied implementation logic |
| Stored-with-warning, dedup caveat, no accidental re-emit, redacted diagnostic | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.test.ts:1731-1813` records one stored event then throws IngestNotRecorded; caller gets stored:true, no error, uncertainty/no-re-emit warning, same hash; dedup warning joins; ordinary pre-row failure stays stored:false; redaction and observer stored:true are asserted | Does not claim an ambiguous timeout proves absence of the record. Matches current consumer contract rather than older summaries' unconditional “not anchored” wording. Green via P |
| Actual isolated ingest/ledger behavior | `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/greptime-smoke.ts:196-289` appends nine events in three lanes, requires stored without warnings, exactly one record/id, checks every touched hour twice, independently sorts raw ingest rows by time/id, asserts backdated membership/empty collector-time hour and unchanged hashes/chain | Subset/order assertions avoid false exact total counts and handle hour rollover. Parent S is real v0.14.4 store evidence, not real Solana/devnet evidence |
| Canonical DDL/shape warning | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts:713-974` asserts append-mode/no-PK placement, fallback warning, canonical column names/no-PK/no-append-mode, canonical/unreadable silence; :868-895 changes only slot data_type to integer; :898-925 changes only root semantic_type to TAG, each requiring an anchors warning | Initial simultaneous-drift caveat resolved with two isolated behavioral cases in P. Exact DDL types/order also remain grounded in the inspected canonical implementation and historical approved record; no fresh live-schema claim |
| Known-value privacy under actual failures | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts:756-811` injects long and short configured values into server failure bodies, requires nonempty warnings and an actual append-mode CREATE, and rejects long values or complete short secret-bearing spans while requiring REDACTED. :239-256 preserves GreptimeError rejection for HTTP/JSON/unparseable/unreachable transport paths; :259-272 preserves database/auth wire behavior | Meaningful assertions avoid banning ordinary single letters in prose or introducing a minimum secret length. Parent reports the actual opaque-credential failure had errors4 without credential echo, smoke exit 1 without echo; privacy success is not a healthy-ledger pass |

## Wave 0 Requirements

Existing infrastructure and all named test files are present. The one-line INSERT-picker hardening and ledger port are completed work, not commands to replay. `wave_0_complete: true` refers to the existing test infrastructure. Added regression tests were authored by the authorized test owner and exercised in the parent's final suite; this child changed no test, fixture, implementation, dependency or root-planning file.

---

## Manual-Only Verifications

| Behavior | Requirement | State / provenance | Operator criterion |
|----------|-------------|--------------------|--------------------|
| Canonical production anchors schema | ANCHOR-01, D27-17 / 27-04-02 | Historical APPROVED: 2026-10-08 context probe; repeated 2026-10-09 in 27-04-SUMMARY. Eleven columns in order: period_start, period_end, root, event_count, memo, tx_sig, signer, cluster, slot, anchored_at, stale_hashes; timestamp/string/bigint shape, ENGINE=mito, no append_mode/PK clause, 0 rows; event_ingest name free then | Accepted record retained, not reapproved or contacted this turn. D27-18 deferral is not substituted for the approved outcome. Historical facts do not assert current live state |
| New ingest DDL/hour reads on production v1.1.4 | ANCHOR-01/02, D27-23 | **Open operator deploy criterion**, explicitly outside this phase's authorized runtime proof | At approved deployment, inspect migration warnings and verify production-version statement behavior. No restart/deploy or production write/read is performed or authorized by this audit |
| Memo program-ID behavior on a real devnet transaction; live anchoring/deployment | Phase28 separate operator criterion, D27-06 | **Not proved** by ledger unit vectors or the 19 fake-chain checks in S | Remains with Phase28's approved real devnet/deployment verification. No waiver, signing-key prerequisite for this source audit, live send, timer installation or inferred deployment success |
| Credential incident/operator rotation outside the authored Phase21/27 STRIDE registries | Separate operator/security obligation | **Pending** under parent scope; source/lock green does not close an incident | Retain the operator obligation; this artifact neither investigates nor silently resolves it |

## Validation Sign-Off

- [x] All twelve canonical plan/task IDs mapped to existing tests, static records or the explicit historical human checkpoint.
- [x] Existing automated task sampling identified; no three consecutive implementation tasks lack automated coverage.
- [x] Existing Wave 0 infrastructure and affected test files reviewed; no missing-file placeholder treated as a pass.
- [x] Commands have no watch flags; execution belongs to the parent only.
- [x] Runtime evidence distinguished from static inspection, historical evidence and separate operator criteria.
- [ ] Fresh feedback latency below 120 s measured (historical estimate only).
- [x] G27-01/G27-02 coverage gaps filled with meaningful behavioral assertions passing in parent P.
- [x] `nyquist_compliant: true` justified for Phase27's source/isolated validation scope; external deployment/devnet criteria remain open, not waived.

**Approval:** original orchestrator approval dated 2026-10-09 is retained as historical evidence, not a new operator approval. Initial native audit dated 2026-10-10 was partial; final static reconciliation dated 2026-10-11 closes the two identified behavioral gaps from actual added assertions plus the parent's final passing suite. This auditor ran no commands. No fresh production-version, devnet or deployment approval is inferred.

## Evidence Provenance

- **Final parent source gates:** parent session evidence `v13-final-green-evidence.json`: typecheck exit 0; locks 108 pass / 0 fail across 4 files, event kinds 12 and surfaces 27; full suite 2719 pass / 58 skip / 0 fail across 96 files, exit 0. Execution HEAD is `4df30a0ce799558ed5ffcfc923003153f0d8f468` plus explicitly owned source corrections pending commit. These are the final corrected-union gates, not a child run or an unchanged-commit claim. Earlier shared Phase19 evidence (2670/58 skip/0 fail, locks112/0) is superseded, not added to the final counts; skips remain skips.
- **Final parent scratch S:** `v13-final-runtime-evidence.json` records owned instance `v13-proof-230c1bd0`, up exit 0, ledger smoke exit 0, 47/47, down exit 0 and exactly two owned store containers removed; real GreptimeDB v0.14.4, 28 ingest/ledger checks plus 19 authorized fake-chain anchor checks. No real devnet send or production ledger/MCP contact. Earlier owned `p27-d8b00608` proof also passed 47/47 with teardown confirmed, but is not claimed as an additional final run. Actual failure-path evidence separately records ledger credential_echo=false and failure exit 1; parent's direct report attributes errors4 without credential echo. Fake-chain checks remain supplementary Phase28 evidence, not expansion of Phase27 requirements.
- **Historical proof (2026-10-09):** `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/27-ledger-primitives-and-ingest-order/27-VERIFICATION.md` records full suite 1719/57 skip/0 fail, flake probe 759/0, scratch 28/28 and historical teardown. Its restacking addendum records 1785/57 skip/0 fail. These counts are not fresh or combined with P.
- **Historical performance (2026-10-09 report):** 200 sequential events/brief requests on isolated rehearsal twins, four interleaved noisy rounds, base `ab62ba4` versus then phase head: events p50 8.6→9.3 ms (+8%), p95 11.0→11.6 ms (+5%); brief p50 7.7→7.1 ms, p95 9.7→9.4 ms. Historical p95 met the 15% bar. No new benchmark was run, and this is not a current performance guarantee. The old report's two full 5 s ingest waits no longer describes the current shared 1 s budget; `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts:1071-1094` pins the budget behavior.
- **Historical schema approval:** `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/27-ledger-primitives-and-ingest-order/27-CONTEXT.md:209-242` and `27-04-SUMMARY.md:66-82` retain the 2026-10-08/09 approved 11-column result. The initial approved statements did not include a server-version query; v1.1.4 is the recorded production-version context, not a freshly observed version.
- **Metadata:** parent supplied canonical threat duplicate_count=0 for Phase27 (also Phase21 and later Phase30), with no waiver. No child metadata runner was invoked. This audit supplies canonical task mapping and source/test evidence, not a signed Swarm runner receipt; signing-key variables are not prerequisites.
- **Workflow constraint:** native validate-phase instructions and canonical template were read. The requested skill workflow alias was missing; the installed skill's declared workflow at `/root/.agents/gsd-core/workflows/validate-phase.md` was loaded instead. No runtime init, audit-append script, commit or config mutation was executed. Project skill-directory discovery found neither named skills directory; no project skill was fabricated.

## Validation Audit — 2026-10-10

| Measure | Result |
|---------|--------|
| Input state | A: existing VALIDATION, four approved PLANs and four completed SUMMARYs |
| Task map | Twelve canonical task IDs, including the historical human checkpoint; requirement-level-only map reconciled |
| Parent runtime evidence | Shared source P green; fresh isolated S 47/47; no child execution |
| Gaps found | 2 focused assertion gaps escalated as coverage WARNINGs |
| Resolved this audit | 0 behavioral gaps; metadata/task mapping and stale file-presence/provenance claims corrected |
| Escalated | 2; no observed implementation failure; no test authorization in this child scope |
| Nyquist outcome | Partial; `status: validated`, `nyquist_compliant: false`, infrastructure complete |

### Initial escalations — historical, superseded by final closure below

| Gap | Task / requirement | Exact evidence and missing behavioral assertion | Classification / next authorized action |
|-----|--------------------|--------------------------------------------------|-----------------------------------------|
| G27-01 | 27-02-02 / 27-02-03; ANCHOR-01, fresh per-attempt stamp in 27-02 Task2 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts:877-905` checks counts/recovery/error but never inspects distinct first/retry ingest timestamps. `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.ts:732-743` visibly reads its clock inside each attempt; this is static evidence, not a passing stamp test | **WARNING, ESCALATED coverage:** authorized test owner must inject successive clocks around a failed first INSERT and assert each actual ingest statement uses its own ISO stamp while event INSERT remains once. Run it under parent ownership; 0 debug iterations here |
| G27-02 | 27-02-02 / 27-02-03; ANCHOR-01/02, D27-16 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts:951-972` asserts only that stderr contains event.id. It does not assert stamped UTC hour, substrate prefix, one line, or no warning just before closure versus a warning exactly at end+lag. `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.ts:749-757` visibly supplies the intended conditional/hour line | **WARNING, ESCALATED coverage:** authorized test owner must pin the full event/hour diagnostic and one-line count, with CLOSED-1 silent and CLOSED warning through insertEvent. Existing period/hourDigest closure tests do not exercise this logging branch. Parent executes; 0 debug iterations here |

The initial caveats are retained as audit history, not current unresolved findings. Final regression closure is documented below. Phase28 real devnet and production deployment remain separate unverified operator criteria.

## Validation Audit — 2026-10-11 Final Reconciliation

| Measure | Result |
|---------|--------|
| Canonical coverage | All twelve task IDs retained; ANCHOR-01/02 consumer behavior mapped to actual tests |
| Parent final P | Full2719 / skip58 / fail0 in 96 files; typecheck0; locks108 / fail0 |
| Parent final S | Real scratch v0.14.4 47/47 (28 ingest/ledger +19 fake-chain), up/down0, two owned containers removed |
| Focused gaps resolved | G27-01 and G27-02 FILLED; isolated type-only and semantic-type-only shape caveats also addressed |
| Current behavioral gaps escalated | 0 within approved Phase27 source/isolated scope |
| Child execution | None; static reading and owned VALIDATION edits only |
| Outcome | `status: validated`, `nyquist_compliant: true`, `wave_0_complete: true` |

### Gap closure evidence

| Gap / caveat | Task / requirement | Meaningful assertion reviewed | Passing evidence |
|---------------|--------------------|-------------------------------|------------------|
| G27-01 — FILLED | 27-02-02 / 27-02-03; ANCHOR-01 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts:1012-1036`: first ingest fails; injected stamp advances across a UTC hour; recorded first/retry INSERTs contain their distinct ISO stamps; retry excludes old stamp; exactly one event INSERT and two ingest INSERTs | Parent final full suite P, not child execution |
| G27-02 — FILLED | 27-02-02 / 27-02-03; ANCHOR-01/02, D27-16 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts:1120-1149`: actual insertEvent at end+lag-1 emits no diagnostic containing the open event; exact end+lag emits closed event ID and stamped UTC hour; only one captured write over both calls. Deleting the branch, ignoring lag or omitting event/hour would fail these expectations | Parent final full suite P. No assertion of an exact presentation prefix or byte-length cap is invented |
| Isolated anchors data-type drift — covered | 27-02-01 / 27-02-03; ANCHOR-01, T-27-05 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts:868-895` keeps canonical names/order/semantics, changes only slot type to integer and requires anchors warning | Parent final full suite P |
| Isolated anchors semantic-type drift — covered | 27-02-01 / 27-02-03; ANCHOR-01, T-27-05 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts:898-925` keeps canonical names/order/types, changes only root FIELD to TAG and requires anchors warning | Parent final full suite P |

**Robustness/provenance:** distinct retry stamps are checked against recorded wire SQL, not echoed fixture objects. Closure tests call actual insertEvent and capture stderr with restoration in finally. Known-value privacy cases assert nonempty failure evidence and secret-bearing spans, including short values, rather than outlawing ordinary prose letters; no minimum-length exception is endorsed. Incidental transport-error text regex expectations were removed, while typed GreptimeError rejection and wire/failure semantics remain verified. The earlier runtime artifact's “finalgreen pending” note precedes the final corrected-union suite; `v13-final-green-evidence.json` plus the parent's final report supply the later successful gate result. No child run, fresh v1.1.4/live schema assertion, real devnet transaction, deployment, credential rotation or operator criterion closure is claimed.

