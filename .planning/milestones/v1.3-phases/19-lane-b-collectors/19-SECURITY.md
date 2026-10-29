---
phase: "19"
slug: "lane-b-collectors"
status: draft
# Severity-filtered blocking gate; total OPEN is 2, both low/non-blocking.
threats_open: 0
asvs_level: 1
block_on: high
register_authored_at_plan_time: true
created: "2026-10-10"
---

> Recovered 2026-10-29 from commit 76a4b2c3.
> Written 2026-10-11 to 2026-10-12 during the v1.3 autonomous integration; it describes that run and was not re-verified against main.
> Its paths and line references point at the 2026-10-11 tree, not at main.

# Phase 19 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail. Current read-only reassessment is **SECURED at the high-severity blocking gate**: 18/20 CLOSED, 2/20 OPEN non-blocking, zero blocking-open threats. No risk acceptance, signed security gate or shipping approval is issued. Parent owns this artifact and final phase status.

---

## Scope and Evidence Standard

Exact authored register: T-19-01 through T-19-20 from the five PLAN.md threat_model blocks; 18 mitigate, 2 accept, no transfer. ASVS L1 verifies invoked mitigation presence in inspected source, not full ASVS certification or L3 bypass assurance. Every threat has its authored severity and disposition; none is dropped or reclassified to make the gate pass.

All relative source references below resolve under `/root/src/worktrees/agent-substrate-v13-autonomous`. Parent owns the final source fingerprint. The source checkout at `/root/src/repos/agent-substrate` was not inspected or modified by this audit. No implementation or shared artifact was written by the auditor.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Collector → POST /events | Conditional bearer and durable outcome classification | Event metadata and authorization |
| Refusal file / journal | Reporting excludes summary/payload and redacts bounded errors | Fixed refusal metadata |
| Pane cwd → git → event | Repository and branch attribution | Directory names and repo slug |
| herdr socket → collector | Pushes schedule snapshot reconciliation, not direct event truth | Pane identity/status |
| EVENT_SOURCES → sample / vocabulary | Repo-carrying exit row stays coordinated | Exit row, sample, doc cell |
| Cursor hook → filesystem | Contained regular bounded transcript read and exclusive redacted copy | Path, conversation ID, transcript text |
| Brief response → repository files | Whole-text redaction and fixed local write targets | Brief and AGENTS pointer |
| Projector → bundle / installed cache | Configuration holds token-file path, not token value | URL, paths, hook/redactor bytes |
| Installed hook → events endpoint | Installed-config equality/refusal guard precedes proof execution | Configured URL and conditional bearer |
| Shared redactor → plugin | Source bytes and installed digest comparison prevent drift | Commit, SHA256, redactor bytes |
| Proof → named runtime | Real proof-owned session and watching collector with finally cleanup | Twin URL, named socket, persisted scratch state |
| Proof → Muse installation scope | Scratch HOME, no XDG, no auto-update; operator cache-path invariance | Plugin install/approval/readback |
| Agent → operator | Approved production unit/plugin/hook cutover remains operator-owned | Deployment instructions |
| Run-tagged repo → ledger | Isolated proof scope and check evidence | Tagged events, refusal status, tally |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation / Source Evidence | Status |
|-----------|----------|-----------|----------|-------------|------------------------------|--------|
| T-19-01 | Information disclosure | recordRefusal refused line | high | mitigate | `packages/collectors/src/emit.ts:89-114` fixed seven keys, redacted 200-char error, no summary/payload; generated counterpart `packages/projector/src/muse.ts:168-190`; exact-key/absence assertions `emit.test.ts:238-273` | closed |
| T-19-02 | Information disclosure | SUBSTRATE_TOKEN handling | high | mitigate | `emit.ts:134-166` call-time conditional bearer; preserved resolver `packages/cli/src/token.ts:33-76` reads without log/write; collectors `muse.ts:125-127`; generated hook `projector/src/muse.ts:128-141,206-225` configured-file conditional bearer | closed |
| T-19-03 | Denial of service | emit timeouts | medium | mitigate | `emit.ts:27-29,134-166` 3000/1500ms AbortSignal and failed transport result; actual calls `grok.ts:223-231`, `herdr.ts:131,219-240`, `cursor-stop.ts:250-259`; generated hook `projector/src/muse.ts:108,225`; no transport retry queue | closed |
| T-19-04 | Tampering | grok state counters key | low | accept | `19-01-PLAN.md:174` is actual plan-time proposed disposition/rationale; `grok.ts:37-65` reserved key and numeric offset filtering exist; existing `19-SECURITY.md:62-67` contains no acceptance entry | open — below high threshold (non-blocking) |
| T-19-05 | Spoofing | herdr pushes | medium | mitigate | `herdr.ts:27-29,148-186,205-212,311-315,367-371` push→dirty, debounce/single-flight, session.snapshot→reconcile, five-second polling | closed |
| T-19-06 | Information disclosure | pane summaries and output_matched text | high | mitigate | `herdr-map.ts:123-157` fixed lifecycle summaries, `:165-191` explicit matched-text redact; `herdr.ts:32-46` excludes output subscription | closed |
| T-19-07 | Denial of service | per-pane connections | medium | mitigate | `herdr.ts:242,318-347` subscriptions synchronized during reconcile; `:367-388` error/close drops affected connection without immediate reconnect loop | closed |
| T-19-08 | Tampering | pane_exited repo amendment | low | mitigate | `packages/mcp-server/src/event-sources.ts:105-121` row and sample carry repo; `docs/event-vocabulary.md:63` coordinated doc cell; `event-sources.test.ts:105-120` conformance assertions. Exact one-commit chronology not independently audited | closed |
| T-19-09 | Information disclosure / Tampering | transcript path traversal and TOCTOU | high | mitigate | `cursor-stop.ts:28-31,74-86,107-126,145-175,200-205` invoked ID/realpath/O_NOFOLLOW/fstat/20MB/exclusive temporary/rename controls; symlink-out test `cursor-stop.test.ts:93-98` | closed |
| T-19-10 | Information disclosure | secrets in transcripts and briefs on disk | high | mitigate | `cursor-stop.ts:153` whole-text redact; collectors `muse.ts:390` redacted brief write; `packages/mcp-server/src/event.ts:65-68,108-112,142-154` server redacts fields/payload; decoy-absence assertion `cursor-stop.test.ts:249` | closed |
| T-19-11 | Tampering | writer scope escape | medium | mitigate | collectors `muse.ts:134-145,409` required absolute root validation; `:240` AGENTS target; `:286-308` git-local exclude; `:329-354,383-390` contained .substrate/BRIEF target | closed |
| T-19-12 | Tampering | stdout injection into Cursor followup | medium | mitigate | `cursor-stop.ts:184-228,247-259` no stdout/exit0; generated hook `projector/src/muse.ts:193-247`; empty-stdout assertions `cursor-stop.test.ts:184-202,245-251`, projector `muse.test.ts:307-310,349-352` | closed |
| T-19-13 | Information disclosure | token value in bundle or cache | high | mitigate | projector `muse.ts:60-65,277-303` path-only config and token collision refusal before writing; `muse.test.ts:161-175` sentinel/config-key/exact-copy assertions | closed |
| T-19-14 | Tampering | hook posting to production | high | mitigate | `scripts/laneb-proof.ts:138-141,559-589` installed config read, invoked equality+smoke guard, return2 on refusal before installed hook test and all subsequent main hook paths; generated hook `projector/src/muse.ts:119-141,206-225` configured-only URL/anonymous missing-file behavior | closed |
| T-19-15 | Information disclosure | redactor drift between repo and bundle | medium | mitigate | projector `muse.ts:256-286,354-393,410-425` exact source/commit/SHA256 and installed digest checks; `muse.test.ts:168-175`; `laneb-proof.ts:577-584` installed redactor readback equals bundle | closed |
| T-19-16 | Elevation of privilege | user-scope install confusion | medium | mitigate | `laneb-proof.ts:65-77,249-255,369-373,519-558` fresh scratch-HOME/HERDR-XDG-free/no-auto-update child env; real projector invocation without bundle-only; projector `muse.ts:428-441` validate/install-or-update/approve; inspect trusted_enabled and installed cache readback; `laneb-proof.ts:295-315,618-619` operator cache paths compared | closed |
| T-19-17 | Tampering (production) | proof targeting | high | mitigate | `laneb-proof.ts:352-355` refusal before requests; `:124-125,406-435,471-478` validated proof-named real server and both named watching collector launches; `herdr.ts:48-59` session resolves before default/env sockets; `laneb-proof.ts:559-589` installed target guard; `:707-732` owned-child stop, guarded session stop/delete, server termination and scratch cleanup | closed |
| T-19-18 | Tampering | unit install | medium | mitigate | `docs/runbooks/lane-b-collectors.md:6,80-96` approved post-merge production installation/restarts/hooks owned by operator; isolated proof contains no production unit restart or hooks.json edit | closed |
| T-19-19 | Repudiation | proof evidence | low | accept | `19-05-PLAN.md:179` is actual plan-time proposed disposition/rationale; `laneb-proof.ts:51-53,358-359,393-394,699-706,735-737` run tag/check output/status/tally exist; existing `19-SECURITY.md:62-67` has no acceptance entry | open — below high threshold (non-blocking) |
| T-19-20 | Information disclosure | decoy transcript in proof | medium | mitigate | `laneb-proof.ts:646-666` runtime-assembled decoy, 0600 and absence assertions; `:707-732` finally removes scratch directory | closed |

**Counts:** 20 authored threats; 18 closed; 2 open total; 0 blocking; 2 non-blocking. All 18 mitigate dispositions are source-backed CLOSED. Neither accept disposition has a documented acceptance. No transfers. No missing/unparseable severity. `threats_open = 0` because the two OPEN severities are low, below high; they are not silently treated as closed.

*Status: closed · open — below high threshold (non-blocking).*  
*Severity order: critical > high > medium > low; only OPEN at or above high counts toward threats_open.*  
*Disposition: mitigate requires implementation; accept requires an existing documented risk entry; transfer requires transfer documentation.*

### Reassessment of Previously Missing Controls

- **T-19-14 CLOSED:** actual installed `hooks/substrate.json` is read and passed to `assertHookTarget(installedUrl, base)` at `laneb-proof.ts:571`; refusal returns2 at `:573-575`. Installed `muse plugins hook test` follows at `:589`. No hook execution precedes this boundary in main; subsequent synthetic Cursor and supplemental dead-hook paths are also after it. The supplementary outage bundle is explicitly configured to the fixed loopback DEAD_URL (`:42,683-693`); it is not evidence for installed-runtime execution and does not introduce a production fallback.
- **T-19-16 CLOSED:** primary invocation now uses real projector default install mode under scratch HOME with no XDG and auto-update disabled, then real CLI inspect/list, installed config/redactor readback and operator cache-path comparison. The later dead-URL bundle-only invocation is a separate supplemental outage check, not a replacement for real installation.
- **T-19-17 CLOSED:** real `herdr --session substrate-proof-* server`, both explicit named watching collector launches, saved-state restart, proofSock RPCs and finally-owned cleanup are present. A fixture snapshot server is no longer the primary runtime driver. Teardown stops/deletes only the validated named session and removes scratch files; harness down is separately parent-owned.

These closures are implementation presence plus separately attributed parent execution evidence, not an acceptance waiver.

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|

**No documented accepted risks.** Existing provenance for the two proposals is `19-01-PLAN.md:174` (T-19-04 reserved counters compatibility) and `19-05-PLAN.md:179` (T-19-19 tagged evidence). The pre-reassessment Phase19 SECURITY log explicitly contained no accepted entries. No approving actor/date was found. The auditor does not self-accept either risk, invent an acceptance date, or borrow an acceptance from another phase. Both remain OPEN, non-blocking.

### Open — Non-Blocking

| Threat ID | Severity | Expected Disposition Evidence | Existing Provenance / Gap |
|-----------|----------|-------------------------------|---------------------------|
| T-19-04 | low | Existing Accepted Risks Log entry | Plan proposes accept; control rationale exists, but approving acceptance record is absent |
| T-19-19 | low | Existing Accepted Risks Log entry | Plan proposes accept; tagged execution evidence exists, but approving acceptance record is absent |

### Open — Blocking

None at block_on high. Outstanding low acceptance documentation does not count toward `threats_open` or block this severity-filtered security gate. It does not authorize an auditor to accept risk.

---

## Summary Threat Flags

All five SUMMARY Threat Flags sections were inspected. Plan01 maps T-19-01..04; Plan02 maps T-19-05..08; Plan03's imprecise “T-19 stop containment” maps T-19-09 by its controls; Plan04 maps T-19-13..15; current Plan05 section maps T-19-17..20. **Unregistered flags: none within this assigned register/summary scope.** No unrelated vulnerability scan was performed. Summary claims and historical fixture adaptations were not substituted for source evidence.

---

## Real-Runtime Evidence and Recorded Provenance

Parent-observed `local://v13-phase19-real-runtime-evidence.json`, dated 2026-10-10:

- Actual corrected real-runtime proof **41/41**, proof exit0, harness up exit0 and down exit0; zero refused emits; own cleanup completed.
- Actual herdr0.9.1 proof-owned named session only: workspace.create, pane.report_agent working, own collector stop/restart with saved state, idle and pane.close. Each start/note/end/tool.call observation is measured within ten seconds of its actual action.
- Actual scratch-HOME Muse validation, install-or-update, approval, inspect trusted_enabled, installed redactor/config readback and installed hook-test CLI. Operator cache paths unchanged.
- No model turns, default-session actions, production probes/store writes, production restarts/cutover or operator-scope hook/plugin installs by parent. Parent did not rotate the Cursor credential.
- Parent recorded typecheck exit0 and current collector unit syntax exit0. Auditor did not execute either.

The original fixture-only27/27 receipt remains historical and is not the real-runtime acceptance proof. Existing runbook status at `docs/runbooks/lane-b-collectors.md:10-14` records a 2026-10-10 operator-approved cutover; retain that operator/date attribution. It is not a parent/auditor production action, current live observation or security approval. Concurrent source-main/production work was not reverted or attributed to this audit.

**Final full-suite green is not claimed.** Parent's targeted run recorded84 pass/1 incidental HTTP-attempt-count assertion failure before the parked original agent's correction; no implementation failure was observed there. Parent must reverify the final union and set the final source fingerprint/status. This audit ran no scripts/builds/tests/lint/smoke/gates/formatters or live probes.

---

## Global Operator Action — Cursor Credential Exposure

**Status: operator_rotation_pending; not accepted; not rotated.** The pre-existing test fallback credential disclosure is contained by the scratch empty-token-directory fixture in `packages/cli/src/token.test.ts:108-109`. Containment does not revoke the exposed credential. Operator must rotate/revoke it and record completion without exposing its value. This global operator action is kept explicit and excluded from the exact20 authored T-19 register counts; it is not hidden, accepted or falsely marked complete. Auditor read no credentials, token files or /etc environment files.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-10-10 | 20 | 15 | 5 (2 blocking, 3 non-blocking) | Previous read-only Phase19 audit recorded in existing SECURITY; fixture-only gaps retained as historical provenance |
| 2026-10-10 | 20 | 18 | 2 (0 blocking, 2 non-blocking) | Current read-only source/grep ASVS L1 reassessment; separate parent real-runtime41/41 evidence |

Auditor verification: source inspection and targeted grep only. No executions, git commands, implementation edits, shared artifact writes, production changes, credential reads or signed Swarm route. The orchestrator persists this text; parent owns final source fingerprint, final union checks, status, commits and STATE/ROADMAP updates.

---

## Sign-Off

- [x] All20 authored threats have their exact category/severity/disposition and explicit source-backed classification.
- [x] All18 mitigate dispositions are verified present in source at ASVS L1.
- [x] T-19-14/T-19-16/T-19-17 real-runtime corrections are source-backed, not closed by waiver.
- [x] Severity-filtered `threats_open: 0` confirmed; total OPEN remains2 low/non-blocking.
- [x] Summary flags mapped; no unmapped flag identified in assigned scope.
- [ ] Accept dispositions have documented Accepted Risks Log entries — T-19-04/T-19-19 remain OPEN non-blocking.
- [ ] Parent final union verification and final source fingerprint recorded.
- [ ] Parent final phase status established — frontmatter remains draft here.

**Verdict:** SECURED for the ASVS L1/block_on high enforcing gate; 18 closed, 2 low non-blocking OPEN, zero blocking-open. This is not an assertion that every threat is closed.

**Approval:** no risk acceptance, signed security gate, release approval or final full-suite/phase-completion claim issued. Parent owns final status. Global Cursor credential rotation remains operator-pending, outside authored-register counts.
