---
phase: "27"
slug: "ledger-primitives-and-ingest-order"
status: verified
threats_open: 0
asvs_level: 1
block_on: high
register_authored_at_plan_time: true
created: "2026-10-10"
updated: "2026-10-11"
---

> Recovered 2026-10-29 from an uncommitted worktree of branch swarm/v13-autonomous-integration (HEAD 76a4b2c3).
> Written 2026-10-11 to 2026-10-12 during the v1.3 autonomous integration; it describes that run and was not re-verified against main.
> Its paths and line references point at the 2026-10-11 tree, not at main.

# Phase 27 — Security

## SECURED

**Phase:** 27 — Ledger primitives and ingest order  
**Threats Closed:** 10/11  
**ASVS Level:** 1 | **Block threshold:** high  
**Blocking open:** 0 | **Non-blocking open:** 1

`SECURED` is the severity-filtered security-gate verdict, not a claim that every risk is accepted or every production/operator prerequisite is complete. T-27-SC remains open below the high threshold because its authored acceptance is not canonically logged. All eleven authored dispositions and severities are preserved.

This is a static re-audit of the corrected source union. The native workflow defaults are ASVS 1 and `block_on: high`; the integration configuration supplies no override. Source evidence closes implementation mitigations. Parent runtime/check evidence is separately attributed below; no auditor execution is claimed.

## Trust Boundaries

| Boundary | Data crossing / audit scope |
|----------|-----------------------------|
| September source → Phase 27 port | Five ledger modules and their five tests; actual source identity, not summary intent. |
| Workspace dependency → server | Local ledger workspace link; authored supply-chain acceptance requires canonical accepted-risks evidence. |
| Client → Greptime HTTP SQL | Quoted values, append-only statement guard, event-first/ingest-second writes and typed reads. |
| Store → hourDigest | First-record ingest membership/order and stored event hashes; malformed or missing members fail the whole digest. |
| append/migrate → callers and output | Constant caller warnings, scrubbed causes, boot stderr and scratch report publication. |
| Harness → scratch stores | Private scratch environment files and loopback stores without forwarding production store credentials. |
| Operator → historical live schema check | Existing approved read-only record; no newly approved probe, production deployment or write. |

## Threat Register

The mitigation text is retained from the authored plans. The older host-only reporting allowance does not authorize this artifact to publish private hostnames or credentials. The corrected smoke now prints database-only metadata rather than a hostname.

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-27-01 | Tampering | ported ledger modules | high | mitigate | Byte-identity proven with cmp per file; any compile-driven change listed in the summary with its reason per D27-01 | closed |
| T-27-02 | Information disclosure | solana.ts/rpc.ts error text | medium | mitigate | No caller in this phase; Phase 28 must pass quoted output through redact before storing (noted in summary) | closed — Phase 27 scope |
| T-27-SC | Tampering | dependencies | low | accept | No registry package is installed; only the local workspace link plus its one-line lockfile entry | open — below high threshold (non-blocking); canonical acceptance log missing |
| T-27-03 | Tampering | ingest INSERT values and hour-read ids | high | mitigate | Every value quoted through this.q; ids are server-minted or read back; assertAppendOnly refuses batches and non-read/insert verbs | closed |
| T-27-04 | Tampering | event_ingest dedup loss | high | mitigate | append_mode with no plain-CREATE fallback, pinned by a migrate test; verified on scratch that a non-append no-PK table drops same-millisecond rows | closed |
| T-27-05 | Tampering | anchors DDL drift vs production | medium | mitigate | Read-only shape check warns on definite mismatch and stays silent when unanswerable; D27-17 check or D27-18 marked fallback before Phase 28 writes | closed — historical APPROVED branch retained |
| T-27-06 | Tampering | hourLeaves ordering and membership | high | mitigate | Membership by first record and rank by ingested_at plus event_id code-unit order in TypeScript; shuffled-row tests pin server-order independence | closed |
| T-27-07 | Tampering | partial or forged roots | high | mitigate | Missing rows and non-64-hex hashes throw naming the event; two stored hashes for one id throw; never a partial root | closed |
| T-27-08 | Information disclosure | warning and stderr text | medium | mitigate | Causes pass through redact; messages name event ids and hours only; the memo carries hour, root and count and no event content | closed — corrected source re-audited |
| T-27-09 | Information disclosure | scratch and production credentials | high | mitigate | stores.env sourced, never printed or committed; the report and summary name host and db, columns and counts only | closed — corrected source re-audited |
| T-27-10 | Tampering | production tables via the live check | high | mitigate | Read-only statements through the assertAppendOnly client path with operator approval; the phase executes no production write and the deploy stays an operator step | closed — historical authorization and scoped execution evidence |

## Threat Verification

| Threat ID | Category | Severity | Disposition | Evidence |
|-----------|----------|----------|-------------|----------|
| T-27-01 | Tampering | high | mitigate | The first static audit compared actual source snapshots `acc30a8` and Phase 27 port commit `ac74e7a`, returning no differences for all ten explicit module/test paths under `/root/src/worktrees/agent-substrate-v13-autonomous/packages/ledger/src/`. The union comparison showed later differences only in RPC module/test, including the genesis-hash API and defensive response parsing. Thus the historical Phase 27 port is verified; all ten current-union files are not falsely called byte-identical. The later genesis-hash edit is attributed in `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/28-hourly-anchor-job-and-verify/28-01-SUMMARY.md:123-124`. No identity command was repeated in this re-audit. |
| T-27-02 | Information disclosure | medium | mitigate | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.ts:2485-2507` composes pure hash/memo/period functions for Phase 27's digest. The factories/runners do no work on import: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/ledger/src/rpc.ts:95-200` and `/root/src/worktrees/agent-substrate-v13-autonomous/packages/ledger/src/solana.ts:89-103`. The required Phase 28 redaction note is at `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/27-ledger-primitives-and-ingest-order/27-01-SUMMARY.md:149-153`. Current callers belong to later Phase 28 work; caller-side redaction is present, for example, at `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/anchor.ts:229-244`. This does not constitute an exhaustive Phase 28 audit. |
| T-27-03 | Tampering | high | mitigate | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.ts:256-270` rejects disallowed leading verbs and statement batches; literal quoting is at lines 282-286, q delegates at lines 429-430, and sql calls assertAppendOnly before fetch at lines 448-457. Ingest INSERT literals are all quoted at lines 761-764; hour reads quote timestamps and read-back IDs at lines 898-933. Minted event identity is at `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/event.ts:139-140`. Guard/quote assertions were read at `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts:85-161`, not executed by the auditor. The append-only client allows the existing CREATE/read/insert-related verbs; it is not a strictly read-only client. |
| T-27-04 | Tampering | high | mitigate | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.ts:554-563` requires append_mode without a primary key and provides no plain-CREATE fallback for event_ingest. The write path refuses a definite non-append table before ingest insertion at lines 732-744; hour membership refuses false or unknown mode at lines 889-896. The existing DDL/fallback and membership-refusal assertions were reviewed in the initial audit, and the updated migration privacy assertions also retain the no-fallback invariant at `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts:756-811`. Scratch evidence remains attributed to the parent and historical execution, not rerun here. |
| T-27-05 | Tampering | medium | mitigate | The canonical eleven-column DDL is at `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.ts:566-580`; lines 588-604 compare names, types and semantic types, warning only on a definite mismatch and staying silent for failed/empty reads. Updated type-only and semantic-only drift assertions were reviewed at `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts:868-927`. Historical approved schema evidence remains at `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/27-ledger-primitives-and-ingest-order/27-CONTEXT.md:209-242` and `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/27-ledger-primitives-and-ingest-order/27-04-SUMMARY.md:66-72`. D27-18 was not taken; no new approval or deferral is invented. |
| T-27-06 | Tampering | high | mitigate | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.ts:898-926` uses the half-open ingest window, collapses duplicates to the first record, excludes IDs with earlier records using an unbounded lookback, and sorts by ingested_at then event_id code-unit order. Collector event_ts only bounds hash lookup at lines 930-933. The real-client shuffled-row/tie/backdated assertions were reviewed at `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.test.ts:1933-1994`. The updated retry source takes this.clock immediately before each ingest attempt at `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.ts:759-764`; the new-hour retry assertion was also read, not executed. |
| T-27-07 | Tampering | high | mitigate | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.ts:938-945` throws for conflicting hashes, a missing event row and a hash outside 64 lowercase hex, naming the event. `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.ts:2498-2507` awaits the complete leaf read before any root is returned. Existing failure assertions were reviewed in both the client and service tests. |
| T-27-08 | Information disclosure | medium | mitigate | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.ts:389-404,433-438` constructs nonempty configured known values and applies redactKnown followed by redact. Transport, HTTP, non-JSON and SQL-body errors use that control at lines 459-472; migration causes use it at lines 551 and 563; ingest-retry causes use it at lines 766-768. Therefore the previously raw Greptime migration cause is already scrubbed before `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.ts:798-805` forwards it to the boot sink at `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/index.ts:50-52`. Append cause redaction remains at `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.ts:911-927`. Hash-only root and memo composition remains at lines 2498-2507 and `/root/src/worktrees/agent-substrate-v13-autonomous/packages/ledger/src/memo.ts:18-28`. |
| T-27-09 | Information disclosure | high | mitigate | Scratch environment generation and private-file serialization remain at `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/rehearsal-env.ts:161-184,206-239,310-315` and `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/rehearsal.ts:594-597,1231-1241`. The corrected smoke imports the existing redact/redactKnown at `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/greptime-smoke.ts:61`; all diagnostic detail passed through check is scrubbed before recording/printing at lines 72-75. Configured known values and the decoy are collected with only empty values excluded at lines 96-102, then scrubbed before shape redaction at lines 104-105. Migration exception/warning publication is scrubbed at lines 111-117. HourDigest error details now traverse check's scrub at lines 235-239 and 266-279. The banner is database-only at line 108; failed checks still produce exit 1 at lines 593-600. |
| T-27-10 | Tampering | high | mitigate | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.ts:448-457` applies the SQL guard before transport; the shape query at lines 588-591 is a read. Historical authorization and statements remain recorded at `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/27-ledger-primitives-and-ingest-order/27-CONTEXT.md:98-107,209-242` and `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/27-ledger-primitives-and-ingest-order/27-04-SUMMARY.md:66-81`. The initial 2026-10-08 context explicitly describes a direct read-only HTTP probe outside GreptimeClient; the 2026-10-09 summary records a guarded-client repetition. Neither is this turn's action. Final parent evidence explicitly scopes execution to owned scratch stores without production writes. Production restart/deploy remains an operator action. |

## Re-Audit of Previously Open Disclosure Findings

### T-27-09 — Closed after output-boundary correction

The initial source audit found a real absence: migration warnings and hourDigest errors could reach smoke stdout without scrubbing. The parent subsequently reports that an injected opaque-password HTTP 500 actually reproduced credential echo, with truthful exit 1. That observed failure is retained as parent evidence; it is not replaced by a success-only smoke result.

The re-audit found the control in the actual producer and publication paths: Greptime uses configured-known-value scrubbing before pattern redaction; migration and ingest-retry causes use that boundary; smoke check details, migration exceptions and warning output use the same existing functions. Short known credentials are not skipped. `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/redact.ts:290-347` excludes only empty needles, scrubs overlapping occurrences, and preserves only its own emitted markers before the caller's pattern-redaction pass.

The parent reports the corrected injected failure still exits 1 without credential echo, and that mapped Greptime errors/Substrate.errors likewise omit the opaque credential. `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/greptime-smoke.ts:111-115,593-600` confirms source-level failure status was not converted into a pass. Updated migration regression assertions at `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts:756-811` require both diagnostic removal and a real warning/no-deduplicating-fallback result.

**Closure:** implementation mitigation present at the declared output boundaries; original high-severity disposition remains mitigate. No risk acceptance was used.

### T-27-08 — Closed after Greptime diagnostic producer correction

The prior boot path forwarded the newly introduced event_ingest warning's raw cause. `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.ts:563` now scrubs that cause at its producer; SQL causes and ingest-retry causes share the same configured-value/pattern boundary. The unchanged Substrate boot forwarding therefore receives the corrected diagnostic on the previously identified Greptime paths. Append error redaction and period/root/count-only memo composition remain present.

**Closure:** original medium-severity disposition remains mitigate; no acceptance was invented. This is verification of the declared Phase 27 Greptime/error publication vector, not a blanket security claim about unrelated index-store diagnostics.

## Open — Non-Blocking

### T-27-SC — Canonical acceptance evidence remains absent

**Category:** Tampering. **Severity:** low. **Disposition:** accept.  
**Status:** open — below high threshold (non-blocking).  
**Counts toward threats_open:** no.

The authored acceptance rationale is recorded at `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/27-ledger-primitives-and-ingest-order/27-01-PLAN.md:154` and `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/27-ledger-primitives-and-ingest-order/27-01-SUMMARY.md:153`. Source confirms the local workspace dependency at `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/package.json:11` and `/root/src/worktrees/agent-substrate-v13-autonomous/bun.lock:47-61,85`.

The prior canonical SECURITY artifact is now present, but its Accepted Risks Log still contains no acceptance entry establishing provenance. A rationale in a plan/summary is not the canonical log required by the assigned accept-disposition verification rule. Preserve `accept`; do not fabricate an acceptor, date or new approval. This auditor does not accept the risk.

There are **no blocking-open threats**. Only open threats at or above high severity count toward the gate field, so **threats_open: 0**.

## Accepted Risks Log

No canonical acceptance entry was verified. T-27-SC remains an authored accept disposition with missing log evidence and is tracked non-blocking. Historical operator scope decisions are retained below and do not constitute new acceptance of a disclosure gap.

## Unregistered Flags

None. The four Phase 27 summaries have threat-note sections rather than exact `## Threat Flags` headings; those sections were read. The event_ingest INSERT maps to T-27-03/T-27-04, the information_schema read to T-27-05, and ordering/hash/error surfaces to T-27-06/T-27-07/T-27-08. The corrections add controls to those mapped boundaries, not an unmapped new integration.

## Evidence Provenance and Residuals

- **Final source gates — parent only:** `local://v13-final-green-evidence.json` records the corrected source union's full suite at **2719 pass / 58 skip / 0 fail**, types exit **0**, and phase-close/lock suite **108 pass / 0 fail**. These supersede earlier union counts; they are not a separate auditor run. The evidence notes owned source corrections pending commit.
- **Final scratch runtime — parent only:** `local://v13-final-runtime-evidence.json` records fresh real GreptimeDB **v0.14.4**, ledger smoke **47/47**, split into **28 ledger/ingest checks plus 19 authorized fake-chain checks**. Rehearsal up/down exited **0** and **two owned store containers were removed**. The corrected injected ledger failure retained exit **1** without credential echo. The runtime artifact's earlier final-green-pending note is superseded for suite status by the final-green artifact, not silently treated as a fresh failed suite.
- **Before/after failure observation — parent only:** the parent final re-audit instruction reports an actual earlier opaque-password HTTP 500 leak with smoke exit 1, then corrected Substrate.errors/mapped Greptime errors without that credential and smoke exit 1 without credential echo. This auditor read the updated control and regression assertions but did not reproduce or rerun that observation.
- **Historical production approval remains historical:** `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/27-ledger-primitives-and-ingest-order/27-CONTEXT.md:209-242` records the approved 2026-10-08 schema probe; `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/27-ledger-primitives-and-ingest-order/27-04-SUMMARY.md:66-72` records the 2026-10-09 repetition. Eleven columns, period time index, ENGINE=mito, no options/append_mode, no primary-key clause and zero anchors rows remain attributed to those historical records. No new approval, live observation or deferral is claimed.
- **Live version gap remains:** v0.14.4 scratch behavior does not prove new ingest statements on live **v1.1.4**. Historical approval establishes the anchors schema shape, not production rollout/runtime parity.
- **No real devnet send:** the additional nineteen checks use fake-chain scope. The memo program-ID comment remains an explicitly unverified historical claim until the separately authorized real transaction/readback. No audit action sends a transaction.
- **Scratch/live boundary:** `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/greptime-smoke.ts:384-388,587-591` guards the fake-anchor section with the loopback refusal; `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/rehearsal.ts:1388-1399` implements that check. Earlier ledger/ingest smoke sections are not globally scratch-guarded. Correct scratch selection remains an execution boundary, and the parent final evidence scopes these runs to owned scratch stores. Do not claim the entire smoke script is intrinsically incapable of production writes.
- **Approved follow-on exclusions preserved:** production restart/deploy stays an operator action. Coverage starts at deployment without backfill; earlier events belong to no hour; the D-era agent_events.ingested_at column remains unused. Actual anchoring, adopt-before-write, real devnet and the first anchored-hour decision remain Phase 28/operator scope. These are exclusions, not weakened ANCHOR-01/ANCHOR-02 requirements.
- **Requirement scope:** `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/REQUIREMENTS.md:83-84` retains append-only server ingest authority and a closed-hour RFC 6962 hash-only root/memo. This security audit does not write requirement checkboxes, root checkpoints or phase-completion metadata.
- **Separate credential incident/operator rotation:** the pending incident and operator rotation outside the authored Phase 21/27 STRIDE registers are not closed by this verdict. No credential or private hostname is published here.
- **Auditor execution:** initial audit used static reads, scoped greps, test-source review and read-only source-history comparisons. This final re-audit used only static re-reading, scoped greps and regression-test source review. Neither performed runtime scripts, security scan binaries, tests, builds, linters, formatters, smoke, gates, network, commits, configuration, operator or production actions. Implementation and root files remain untouched by the auditor; the orchestrator owns this artifact write.

## Security Audit Trail

| Audit Record | Threats Total | Closed | Open | Blocking Open | Evidence / Run By |
|--------------|---------------|--------|------|---------------|-------------------|
| Prior canonical record, dated 2026-10-10 | 11 | 8 | 3 | 1 | Initial static audit; T-27-09 blocking and T-27-08 non-blocking disclosure controls absent. |
| Final static re-audit, 2026-10-11 | 11 | 10 | 1 | 0 | Native GSD security auditor; corrected producer/publication controls read, with parent final runtime/gate evidence separately attributed. |

## Sign-Off

- [x] All authored threats retain a disposition and severity.
- [x] All ten declared implementation mitigations source-verified at their scoped boundaries.
- [x] Threat-note surfaces mapped; no unregistered flags.
- [ ] T-27-SC accepted-risk provenance documented in the canonical log.
- [x] No open high/critical threats; threats_open: 0.
- [x] Severity-filtered security status verified.

**Security gate:** SECURED at ASVS 1 / block_on high.  
**Residual:** T-27-SC is low-severity, open and non-blocking; no acceptance fabricated.  
**Production/operator approval:** not granted by this audit; historical authorization and remaining operator prerequisites keep their existing scope.

**threats_open:** 0
