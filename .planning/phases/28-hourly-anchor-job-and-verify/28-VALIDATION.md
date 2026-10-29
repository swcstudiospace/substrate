---
phase: 28
slug: hourly-anchor-job-and-verify
status: validated
nyquist_compliant: false
wave_0_complete: false
local_source_coverage: partial
phase_completion: human_needed
manual_gate_status: blocked
source_commit: 76a4b2c
created: 2026-10-11
validated: 2026-10-11
validation_mode: static_reconciliation_of_parent_execution_evidence
executed_by_this_auditor: false
---

# Phase 28 — Hourly Anchor Job and Verify Validation

## Authority and evidence boundary

This is a **local Nyquist coverage audit, not a phase-completion seal**. All four real plans and summaries were read. The owned validation file was absent in the integration phase directory; this reconstructs it under validate-phase State B. No implementation, test, fixture, root requirement, verification, or other phase artifact was changed. No test, build, formatter, lint, smoke, runtime, gate, network, production, operator, or Git command was executed by this auditor.

The authoritative requirements are in `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/REQUIREMENTS.md:85-88`: **ANCHOR-03, ANCHOR-04, ANCHOR-05, and ANCHOR-06 remain unchecked/Pending**. Historical SUMMARY `requirements-completed` and `status: complete` fields describe delivered slices; they do not clear those root requirements, the live proof, or the phase seal. The parent reports Phase 27 sealed and dependency-eligible; this is not evidence that the Phase 28 units are installed or any live anchor exists.

The binding live contract is `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/28-hourly-anchor-job-and-verify/28-04-PLAN.md:16-17,92-106,138-158`: **each L1–L10 step requires separate operator approval in an approved window with a funded key**, including read-only steps. T-28-16 explicitly makes deferred live proof block the seal. Historical outcomes are all DEFERRED. This audit makes **no new approval, waiver, or deferral** and performs none of those steps.

### Parent-executed evidence, not a second run

| Evidence | Actually reported result | Authority and limit |
|---|---|---|
| `local://v13-final-green-evidence.json` | Latest full suite **2718 pass / 58 skip / 0 fail**, 96 files, exit 0; type check exit 0; phase-close checks **108 pass / 0 fail**, 4 files | Parent execution. Earlier 2719 is historical and is not the latest result. The artifact retains an earlier HEAD plus dirty-correction provenance; do not relabel that field as a new run. |
| `local://v13-final-runtime-evidence.json:40-44,80-96` | Ledger **47/47**, exit 0; real isolated v0.14 Greptime with **19 fake-chain checks**; latest source gates explicitly identify **76a4b2c** and the same 2718/58/0 result | Real local storage behavior with fake CLI/loopback RPC, not real devnet. Parent context supplies the 19-check decomposition; it is included within 47, not an additional 19 passes. |
| Same runtime artifact, `down` | Exit 0; owned store containers removed | Parent cleanup evidence. This audit starts no runtime. |
| Four Phase 28 SUMMARYs | Historical slice tests, isolated 47/47, all L steps DEFERRED | Useful implementation/deviation history only. Historical full-suite counts and historical doctor findings are not substituted for the fresh parent evidence. |

**Green-parent** below means a meaningful existing assertion mapped into that parent-run source suite or recorded isolated proof. It does not mean this auditor ran a targeted command, that all skipped suite tests ran, or that the entire requirement is satisfied. **Static** means source/docs inspected, not behavioral execution. **Partial** means a concrete named consumer/proof behavior lacks an exercised assertion. **Blocked** means the named human gate remains uncleared. There is no observed red implementation test in this audit; missing coverage is not fabricated as a demonstrated defect.

## Test infrastructure and command inventory

Framework: `bun:test`; runner/type-check scripts are defined in `/root/src/worktrees/agent-substrate-v13-autonomous/package.json:18-36`. Existing injected Runner/Rpc/store stubs and real scratch ledger harness are reused; no new framework or dependency is needed. Project skill directories were absent in this integration worktree. Read skill/workflow: `gsd-validate-phase`, `/root/.agents/gsd-core/workflows/validate-phase.md`, its required UI reference, and `/root/.agents/gsd-core/references/verifier-evidence-gate.md`.

All commands below are **mapping/reproduction instructions for the parent or test owner only**, not commands executed here. Full-suite parent command was `bun test`, with working directory `/root/src/worktrees/agent-substrate-v13-autonomous`; parent type-check command was `bunx tsc --noEmit` in that directory. No duration or targeted case count is inferred from those aggregate results.

| ID | Existing automated command | Coverage kind |
|---|---|---|
| C1 | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/anchor.test.ts` | Injected job behavioral unit tests |
| C2 | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/greptime.test.ts` | Typed client tests with HTTP/SQL replies replaced |
| C3 | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.test.ts` | Digest, chain, hour report, and bounded-read behavior |
| C4 | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/ledger/src/rpc.test.ts /root/src/worktrees/agent-substrate-v13-autonomous/packages/ledger/src/solana.test.ts /root/src/worktrees/agent-substrate-v13-autonomous/packages/ledger/src/period.test.ts` | Memo-program filtering, retries, path-only argv, UTC/lag boundaries |
| C5 | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/config.test.ts` | Configuration parsing, not entry-point process behavior |
| C6 | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/store-lock.test.ts /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/rehearsal-env.test.ts` | Existing source-boundary locks and isolated environment behavior |
| C7 | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/server.test.ts /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/mcp.test.ts /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/observe.test.ts` | Existing transport/audit/chain tests; does not by itself prove nonempty hour verdict passthrough |
| C8 | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/scripts/doctor-units.test.ts /root/src/worktrees/agent-substrate-v13-autonomous/infra/vps/deploy-release.test.ts` | Repo unit parsing, dry-run diagnostics and release refusal fixtures, not live systemd |
| C9 | `bun /root/src/worktrees/agent-substrate-v13-autonomous/scripts/greptime-smoke.ts` | Integration proof only inside the parent's separately provisioned, isolated scratch environment; bare invocation is not permission to access a configured store |

No new permanent source-wiring, hash-clone, incidental-default, or exact-argv-copy test is proposed. The existing ledger builder test already owns its actual transfer contract. Sampling continuity for local tasks is provided by the existing source suite; docs are checked statically, not by meaningless keyword-count tests. Any future coverage additions must be exercised by their owner under the parent's isolation policy. Live sampling is never automatic and must stop before each L gate.

## Per-task verification map — every real plan task

Commands refer to the absolute inventory above. Threat references are the existing plan IDs, not a new threat register.

| Task ID | Plan / wave | Requirement | Threat ref | Meaningful verification and boundary | Command | Status |
|---|---|---|---|---|---|---|
| 28-01-01 | 01 / 1 | ANCHOR-03,04 | T-28-01,03 | Typed window/single-period reads, 11-column insert with NULL stale_hashes, earliest coverage read; genesis-hash result and invalid response; existing SQL-door lock | C2,C4,C6 | Green-parent for tested client contracts; production DDL reconciliation is inherited historical Phase 27 evidence, not a new production read |
| 28-01-02 | 01 / 1 | ANCHOR-03,04 | T-28-01..05 | Candidate ordering/cap, empty/damaged-hour starvation, send/adopt/alarm, durable dedup, pre-send gates, systemic stop, emit failure refusal | C1,C3,C4 | Green-parent for named assertions below; actual chain/timer operation remains blocked |
| 28-01-03 | 01 / 1 | ANCHOR-04 | T-28-03,04 | Config/parser tests exist; entry checks missing config before constructing clients | C1,C5 | **Partial — G1**: actual entry exit 2 + zero effects not asserted |
| 28-01-04 | 01 / 1 | ANCHOR-03,04 | T-28-03,05 | Existing SQL lock passes in parent suite; rollback and Phase 27 dependency outcome recorded in 28-01-SUMMARY:146-150 | C6 | Green-parent lock + static rollback record; no independent historical diff verification |
| 28-02-01 | 02 / 2 | ANCHOR-05 | T-28-08 | graphIngest reads stored graph ID, collapses shuffled duplicates to earliest record and rejects malformed time naming event | C2,C6 | Green-parent |
| 28-02-02 | 02 / 2 | ANCHOR-05 | T-28-06..10 | Five statuses, first-ingest/legacy/uncovered rules, missing/deleted/moved rows, bounded refresh races and slow reads | C3,C4 | Green-parent for existing cases; **Partial — G4** for completed-prefix plus later timeout report |
| 28-02-03 | 02 / 2 | ANCHOR-05 | T-28-09,10 | HTTP and MCP delegate to verifyGraph; CLI reads additive verdict; existing MCP tests cover chain only | C7 | **Partial — G2,G3**: nonempty consumer reports/CLI exits lack exercised assertions |
| 28-02-04 | 02 / 2 | ANCHOR-05 | T-28-08 | Existing SQL lock; revert-to-four-field rollback recorded in 28-02-SUMMARY:150-153 | C6 | Green-parent lock + static rollback record |
| 28-03-01 | 03 / 3 | ANCHOR-03 | T-28-11,13 | Repo doctor asserts anchor release cwd, shared env and no restart; current doctor test asserts no findings; literal timer/service fields inspected | C8 | Green-parent fixtures + static timer shape; **L6/L8/L10 live timer/single-instance proof blocked** |
| 28-03-02 | 03 / 3 | ANCHOR-03,05 | T-28-12,13 | README trigger rule, production-key boundary and lag timing; config naming inspected, not keyword-count proof | C5,C8 | Static doc contract + Green-parent related tests; install/readiness not claimed |
| 28-03-03 | 03 / 3 | ANCHOR-03,05 | T-28-12 | Ledger docs state schedule, candidates, row/event shapes, five states, legacy/uncovered and unchanged D-era behavior | C6 | Static documentation reconciliation + Green-parent lock; documentation is not live proof |
| 28-04-01 | 04 / 4 | ANCHOR-06 | T-28-14,15 | Parent scratch 47/47 includes 19 fake checks: crash after send, adopt, no resend, untouched anchored, post-anchor append mismatch with chain intact | C9,C6 | Green-parent **isolated membership-change proof only**; **Partial — G5** for literal changed existing event + process exit |
| 28-04-02 | 04 / 4 | ANCHOR-06 (also 03–05 live authority) | T-28-14..16 | Named blocking-human L1–L10 gates; real funded key/devnet, deploy/unit/timer, memo readback and process verify/adopt evidence | **MANUAL — no authorized automated command** | **Blocked — B1**, every L step remains uncleared |
| 28-04-03 | 04 / 4 | ANCHOR-06 | T-28-16 | Ledger verification-status entry separates fake chain from live DEFERRED, leaves zero-amount/program ID open and records additive rollback | C6 | Static honest proof record + Green-parent lock; does not satisfy ANCHOR-06 |

## Behavioral coverage ledger

Test file paths are the command inventory paths. Line references identify assertions read during this audit, not new executions.

| Required behavior | Existing assertions that can fail | Current limit |
|---|---|---|
| Closure/ingest-lag boundary | `period.test.ts:22-35` checks end+lag−1/end+lag; `service.test.ts:1849-1863` rejects open digest without reading leaves, permits exact closure | Pure/service boundary covered; a fake clock is not timer scheduling proof |
| Earliest coverage and first-record membership | `greptime.test.ts:1419-1428` earliest/null read; `1436-1456` shuffled duplicate graph records return earliest time; `1213-1220` excludes earlier-hour IDs and orders tied ingest by ID; `service.test.ts:1969-1980` uses real client logic with permuted replies | Covered client composition; no backfill or legacy-as-anchored claim |
| Closed, nonempty, ascending, 24 cap | `anchor.test.ts:141-147` zero writes/emits/CLI for empty hour; `200-244` asserts 24 digest selections ascending and 24 anchored; `259-272` empty 24-hour gap still reaches later event; `541-561` 24 damaged hours do not starve healthy hour | Constants test is supporting evidence only. Pre-coverage case at 150-168 uses `every` and may observe an empty set; coverage start is therefore supported by client/source and scratch proof, not that vacuous assertion alone. Seven-day bound is source/constants evidence, not a claimed dedicated sweep-boundary run. |
| Existing/durable anchor idempotency | `anchor.test.ts:356-394` row found after sweep plus aged-out listing yields zero invocations/writes; `867-911` explicit-period adoption leaves row untouched; `914-954` older-than-lookback anchored period sends/writes nothing | All fake ports; no observed live signature/balance invariance |
| Boundary preconditions before transfer | `anchor.test.ts:684-729` wrong genesis, mismatched key and unfunded balance refuse transfer; source `anchor.ts:217-260` enforces absolute path → keygen identity → devnet genesis → balance. `solana.test.ts:57-75` refuses invalid path/amount/memo and accepts nonexistent key path without opening it | Keypair builder behavior tested; no claim that these tests observed the production key or real CLI zero-amount acceptance |
| Adopt/readback/alarm | `anchor.test.ts:416-445` adoption records found signature/slot with zero CLI, mismatch records found root, warning, ALARM and code 1; `448-484` alarm preserves later adoption with failing aggregate; `516-536` unreadable matching hint refuses resend; `979-1002` wrong-cluster memo never adopted. `rpc.test.ts:57-88` memo program parsing excludes other programs | Real devnet attribution/program ID remains L8/L9; source guards are not expanded into purported unrun negative tests |
| Partial job success vs systemic failure | `anchor.test.ts:590-624` bad member continues with anchored=1/failed=1/code=1, store-down stops before any send; `627-681,765-832` failed event persistence and row recheck fail closed, retain written row without resending | Covered job result/persistence semantics; not live restart/crash reproduction |
| Root/count/row/memo report | `service.test.ts:3479-3494` recomputed root+count, signature, slot, chain and top-level success; `3548-3625` root, signer, period, row disagreement and missing member produce mismatch/failure | Recomputed service verdict asserted; consumer serialization and CLI outcome need G2/G3 |
| Pending/open/unanchored | `service.test.ts:3497-3545` inside window, open hour with no digest, expired no-row fails naming hour; `3871-3892` exhausted budget does not turn open hour unverified | Covers both sides of window, not a newly claimed exact three-hour epsilon test |
| Fail-closed unreadable/unknown identity/wrong chain | `service.test.ts:3628-3677,4087-4103` RPC exception, missing transaction, unset pubkey and non-devnet genesis all fail | Stubs; no actual devnet read allowed here |
| Legacy/unrecorded-ingest refusal | `service.test.ts:3680-3717` counts old legacy and names new uncovered; `3720-3781` one refresh settles a real race but permanently record-less event still fails; `4005-4040` fresh sibling without ingest never makes graph successful | Empty-coverage behavior is a historical documented rule, not a waiver for post-coverage uncovered events |
| Deleted/moved/freshly restored content | `service.test.ts:3800-3818,3912-3930,4043-4084,4106-4173` retained membership forces checking absent rows; restored edited hash and open-hour deletions fail naming IDs | Exercises chain and retained membership, not changed existing anchored leaf with a recomputed valid hash |
| Bounded/partial verify results | `rpc.test.ts:129-156` bounded retries; `service.test.ts:3821-3868` exhausted/never-resolving reads yield unverified instead of hanging; `3895-3909` quick reads fit scaled allowance; `4176-4237` reread/event-read spends request budget; `3720-3754,3933-3961` anchored+pending report survives refresh | **G4**: no multi-closed-hour assertion combines a completed anchored prefix with slow later read and untouched remaining closed hours |
| Evidence stays chain-only | `service.test.ts:3784-3790` anchors:false works with only readEvents and empty hours; `observe.test.ts:683-700` distinguishes unreachable ledger from verified bundle; source `observe.ts:571-575` passes anchors:false | Service behavior and source call reviewed; do not call the old bundle stubs a dedicated assertion of this option |
| Public doors | `mcp.test.ts:190-220` exercises MCP chain ok/broken with empty ingest coverage; `server.ts:735-745`, `mcp.ts:447-459`, `cli/index.ts:168-219` inspected | **G2/G3**: service tests cannot substitute for actual hour-report consumer tests |
| Timer/env trust boundary | `doctor-units.test.ts:272-329` parses repo units and dry-run behavior; service:12, timer:9-11, drop-in:7 inspected; rehearsal-env test `parent production values never reach the built env` and exact allowlist | Real enabled timer, persistent catch-up, production key and trigger serialization remain human-only |
| Fake/live authority | `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/greptime-smoke.ts:388-478` scratch-only gate, temp CLI and loopback RPC; `494-586` actual outcome assertions; ledger docs:602-619 call `ok:false` exit-equivalent and live DEFERRED | Real storage plus fake chain is valuable integration coverage, not real send, live unit, or CLI exit proof |

## Unfilled local consumer/proof coverage — actionable, not invented red defects

These are **WARNING / PARTIAL** findings: related tests passed in parent evidence, but named behavioral edges are not asserted by those tests. None is marked FILLED or silently SKIP. Only the parent/test owner may add and execute tests; this audit is artifact-only.

| Gap | Task / contract | Assertion boundary observed | Required next owner action |
|---|---|---|---|
| G1 | 28-01-03 / D28-11 / ANCHOR-04 | Config tests assert parsed fields; parser tests assert options/errors. Neither invokes `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/anchor-run.ts`. Entry source:35-45 rejects absent settings before construction, but the plan explicitly requires test-pinned process exit 2, usage, zero effects. | **Test owner:** isolated child with empty HOME/XDG, no env-file or inherited credentials; missing GREPTIME_URL, missing identity settings; assert exit 2 and usage plus no fake CLI/store/RPC side effect. Do not read real key/config or invoke devnet. |
| G2 | 28-02-03 / D28-19 / ANCHOR-05 | No CLI verify process test was found in the existing CLI test files. `service.test.ts` asserts `ok:false`, not process exit or streams. SUMMARY:97-103 already records the CLI harness gap. | **Test owner:** run actual CLI against isolated loopback verdict server; intact chain + mismatch must name hour and exit 1 without falsely saying chain broken; unverified must name hour on stderr and exit 1; anchored+pending exits 0; missing graph exits 2 and unreachable endpoint exits 1. Assert semantic verdict/output, not incidental formatting/defaults beyond the required hour diagnosis. |
| G3 | 28-02-03 / D28-13,14 / ANCHOR-05 | MCP tests assert only ok/events/brokenAt/reason on empty coverage. No POST /verify hour-report assertion found. Source delegation alone does not prove serialized nonempty report equality or failure preservation. | **Test owner:** through real HTTP and MCP transports, use a meaningful local verdict with anchored+unverified or mismatch hours, uncovered ID and chain.ok=true; assert identical hour/signature/root/count/ID fields and top-level ok=false. Reuse existing transport fixtures; no production MCP. |
| G4 | 28-02-02 / D28-18 / ANCHOR-05 | Slow/budget tests assert a single hour; two-hour tests assert anchored+pending, not an anchored prefix followed by a hung closed-hour read and a third unreached closed hour. | **Test owner:** three closed ingest hours; first transaction succeeds, second stalls against bounded fake clock/runtime, third must not begin a devnet check after exhaustion. Assert all three periods remain in order, first retains anchored root/signature, later two are unverified, ok=false, bounded return. No retry or telemetry feature is requested. |
| G5 | 28-04-01 / D28-20 / ANCHOR-06 | Scratch check asserts append after anchor changes membership with chain.ok=true and mismatch/ok=false. It does **not** alter an existing event with a recomputed hash or invoke `substrate verify` to observe exit 1. The append deviation is explicitly documented in 28-04-SUMMARY:30,91-95 and is not erased. | **Test/proof owner:** preserve the existing append proof as such; satisfy the named existing-event alteration + process exit criterion in an isolated scratch fixture that permits the specified tamper without mutating production or weakening the normal append-only gate. Assert valid session chain, changed recomputed root against the retained anchor, hour diagnosis and actual CLI exit 1. Never claim the membership-append/ok:false assertion already did this. |

Existing supporting source-only details (for example sweep lookback or a bundle call option) are not promoted into new implementation blockers or a list of mechanical hash/source-clone tests. No failed behavioral test or reproducible defect output was produced here. The verifier evidence gate does not demote the carried named live proof: that remains blocked independently of any new-scope opinion.

## Manual-only verifications — all ten gates remain uncleared

**B1 — BLOCKER / ESCALATED to operator and parent goal verifier:** ANCHOR-03..06 cannot be marked satisfied or Phase 28 sealed from fake-chain evidence. The operator owns every approval and execution below. The parent owns eventual evidence reconciliation and goal verification. A funded key/approved window are prerequisites, not credentials to request or inspect from this audit.

Every row inherits historical **DEFERRED; no new decision**. Instructions below identify the evidence needed, not authorization or executable commands.

| Gate | Required operator action after separate approval | Evidence required / unmet criterion |
|---|---|---|
| L1 | Names-only live env presence, key owner/mode and CLI/keygen identity check | Names/mode/version/equality without secret values; key remains path-only. Even this read-only step is gated. |
| L2 | Read devnet balance after its own approval | Funding need determined from real approved read; fake balance cannot satisfy it. |
| L3 | Operator funds key if needed | Funded devnet signer ready for approved proof; no agent funding transaction. |
| L4 | Approve each required live env/config change | Necessary names/config delivered by operator; no values in repo, report, or transcript. |
| L5 | Approve deployment of Phase 27+28 release | Real ingest coverage start and reconciled DDL/dependency recorded without destructive table operations. No deploy/restart by this auditor. |
| L6 | Approve units/drop-in installation and timer enablement | Actual hourly/Persistent/oneshot configuration plus approved doctor result; repo unit parsing is not installation evidence. |
| L7 | Approve fresh proof-graph writes to live ledger | Identified real proof graph and closed ingest hour; fake graph is not substituted. |
| L8 | Approve first real timer/send, recording any approved start fallback | Real devnet signature/slot, closed-hour root/count and signer; resolve real zero-lamport acceptance and memo program ID D27-06. Both remain UNVERIFIED. A manually started send alone does not establish natural timer behavior. |
| L9 | Obtain **separate** approval for readback and CLI verification | Memo by tx_sig equals recomputed hour root/count with signer/program confirmation; actual CLI exits 0 and every proof hour is anchored. Read-only is not an exemption. |
| L10 | Obtain **separate** approval for repeat unit trigger and explicit-period adoption | Before/after signature list and balance unchanged; no send, row unchanged, one adopted:true event. Do not delete a production row to reproduce the crash; crash recovery was isolated-only. |

**Runbook reconciliation required (parent/documentation owner):** `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/28-hourly-anchor-job-and-verify/28-04-SUMMARY.md:109` says L9 has “none beyond L8” for its gate, and L10:110 does not spell a separate gate. The binding PLAN and summary preamble require every step's own approval. Before any live execution, the owner must present and record separate L9/L10 approval too; the permissive line is not permission. No summary or runbook was edited by this auditor.

ANCHOR-06's scratch tamper requirement is also limited by G5 above; successful live readback alone cannot fill it. Conversely, filling G1–G5 locally cannot clear B1. Production-key isolation is preserved: fake chain never supplies live-chain authority, the key is never opened here, and no live crash proof may delete an anchors row.

## Validation sign-off

- [x] All four plans' 14 real tasks mapped; root ANCHOR-03..06 read as Pending.
- [x] Existing source/test assertions inspected, including candidate cap/starvation, first-ingest membership, legacy/uncovered, partial outcomes and root mismatch.
- [x] Parent full/source and real scratch evidence attributed once with correct 2718/58/0 and 47/47 including 19 fake-chain checks.
- [x] Source implementation and all other ownership surfaces unchanged; no command execution or new test files.
- [x] Every uncovered local consumer/proof criterion assigned to test/proof owner; no missing assertion claimed passing.
- [x] Manual L1–L10 gate retained explicitly; no new waiver, approval or deferral.
- [ ] G1–G5 behavioral coverage filled and actually exercised by their owner.
- [ ] L1–L10 separately approved and required real devnet/timer/CLI evidence recorded by operator.
- [ ] `wave_0_complete: true` and `nyquist_compliant: true` justified.
- [ ] Phase 28 completion seal / root requirements satisfied.

**Disposition: PARTIAL local Nyquist coverage; phase completion pending human evidence.** No code bug is declared without a failing test; no partial proof is promoted to completion. The parent's eventual goal verifier may record human_needed while B1 remains open.

## Validation Audit

- Mode: State B reconstruction from four real plans/summaries, root requirements, source/assertion reads and already-executed parent evidence.
- Local findings: five WARNING coverage limitations (G1–G5); no new test, no rerun, no red implementation result.
- Carried manual criterion: one BLOCKER group (B1), all ten L gates uncleared, plus explicit L9/L10 runbook approval reconciliation for the owning parent.
- Gaps filled by this auditor: 0. Existing passing assertions mapped, not newly exercised or re-counted.
- Artifact for parent commit only: `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/28-hourly-anchor-job-and-verify/28-VALIDATION.md`.
