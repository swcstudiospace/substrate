---
phase: "30"
slug: "desktop-run"
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-08"
updated: "2026-10-11"
---

# Phase 30 — Validation Audit

**Verdict: GAPS FILLED for the approved local Phase30 contract.** All 17 real plan tasks and DESK-01..05 are mapped below. G1–G8 are resolved by actual behavioral assertions exercised in the parent's final full suite; corrected real desktop smoke separately passed20/20. No production/main/milestone completion, model turn, credential rotation or operator-window approval is inferred.

## Scope and attribution

- This auditor changed only this file, using static reading. No tests were created/modified/executed here; no scripts, builds, types, lint, formatters, scans, gates, Docker, HTTP, credential, operator or model actions were performed here.
- Read the native `gsd-validate-phase` skill/workflow and bootstrap reference, all seven PLAN/SUMMARY pairs, implementation boundaries and actual assertion ranges. Local project skill directories were absent; configured `agent_skills` was null.
- Final reconciliation reads are additional static reads, not a child rerun. Parent evidence is explicitly attributed. An assertion source plus the parent's exercised final suite supports covered status; declarations, argv copies, mock echoes, source names, file-layout locks and prose counts do not.
- Historic execution-plan rebase/port-diff/source-pin instructions are not outstanding requirements. The approved assignment requires consumer behavior, not forbidden structural tests or broader new features.

## Test infrastructure and commands

Commands are the existing verification routes, not executions by this auditor. Working directory: `/root/src/worktrees/agent-substrate-v13-autonomous`.

| Test family | Automated command |
|---|---|
| Desktop schema/codec/driver/MCP | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/` |
| Real HTTP integration | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/http.test.ts` |
| Tracked lifecycle script with PATH stubs | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/scripts/substrate-desktop.test.ts` |
| Harness environment | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/rehearsal-env.test.ts` |
| Harness CLI | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/scripts/rehearsal.test.ts` |
| Smoke helpers/snapshot consumer states | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/scripts/desktop-smoke.test.ts` |
| Event normalization/document contract | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/event-sources.test.ts` |
| Audit policy | `bun test /root/src/worktrees/agent-substrate-v13-autonomous/packages/audit/src/policy.test.ts` |
| Final source union | Parent observed `bun test`, `bunx tsc --noEmit`, `bun run check:phase-close`, bash syntax and shellcheck; no formatter configured or run |
| Actual desktop proof | Parent named isolated rehearsal up → corrected desktop-smoke → down, as recorded in `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/30-desktop-run/30-PROOF.md:29-71` |

Framework: existing `bun:test`, colocated `*.test.ts`, no dedicated test config. No new timing estimate is asserted.

## Parent evidence chronology

| Evidence | Actual observed result and limits |
|---|---|
| Reused earlier integration gates | `local://v13-phase19-real-runtime-evidence.json:35-55`:2670pass/58skip/0fail, types0, locks112/0. Historical reused evidence, not a separate Phase30 run and not the final source-union count. |
| Actual three-repeat N1 spike | `local://v13-phase30-spike-evidence.json:10-81,83-179,181-187`: each fixed-argv root-XWD→PNG-decode repeat baseline0, exact-RGB9120, solid480x19, terminal settle5000ms/type settle200ms, per-call timings and host steal; own terminals closed. **Fresh-as-ported; n1_reproduced=false; capture fix not needed.** No title substitution. |
| First actual desktop MCP attempt | `local://v13-phase30-runtime-context.json:8-11`: **FAIL18/20, exit1**. Pixel/image/stored/eventhash/auth/audit checks passed; unrelated-desktop inspect criteria failed. Successful exact-name inventory exit0/zero rows established absence. This historical failure is never renamed a pass. |
| Separate corrected actual desktop proof | `local://v13-final-runtime-evidence.json:45-60`: **PASS20/20, exit0**, baseline0, marker9120, solid480x19, two image blocks, five successful actions/hash-only event rows, unlisted count5→5, no-bearer MCP401, unauthenticated webtop401, two audit records, authoritative unrelated-desktop absent→absent. Current `30-PROOF.md:29-85` records this separate result and preserves first FAIL18/20. |
| Real failed-locality refusal | `local://v13-final-runtime-evidence.json:72-77`: parent's corrected failed probe refused with zero actions and zero events. Source now rejects unknown/failed/empty/hung/remote locality before effects; no probe error is accepted as absence or locality proof. |
| Owned cleanup | Final runtime lines5,68-71 and current `30-PROOF.md:55-61`: up/down exit0; two owned scratch stores removed; dedicated desktop remains running; unrelated desktop unchanged; all proof-owned terminals closed. |
| Final source-union gates | **Authoritative later gate receipt:** `local://v13-final-green-evidence.json:5-26`:2719pass/58skip/0fail across96 files, types exit0, locks108pass/0fail/0skip across4 files, phase-close exit0, EVENT_KINDS12/SURFACES27, bash syntax0/shellcheck0. Source state is owned corrections pending commit, not a clean-main claim. |

The runtime receipt's line79 says final green was pending **at that earlier runtime point**. The later final-green receipt supersedes that pending gate statement, not the runtime measurements. Counts2719/108 are current; earlier2670/112 and1735 historical counts are not repinned to them.

## Concrete assertion index

All references below are actual read assertion ranges. Parent final suite supplies execution provenance; no separate child execution is claimed.

| ID | Absolute test path and assertion ranges | Credited behavior |
|---|---|---|
| A | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/actions.test.ts:21-53,58-70,75-97,104-107` | Strict schema/action/text/time boundaries, controls, key grammar, option-looking text after `--`, allowed program/no-shell safety and display edges. Complete builder-copy and constant-only settle tests are gone. |
| P | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/png.test.ts:53-74,79-96,101-147` | Exact independent RGB across packed24/32 byte orders/padding/colormap; unsupported XWD/truncation refusal; DirectColor known pixel31,42,34; PNG CRC/filter rows and RGB round-trip; bad signature/filter; independent valid-CRC IHDR depth/color/interlace semantic refusals. |
| D1 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.test.ts:163-206,219-227,549-580` | Run ID, 0600/0700 filesystem modes, returned/stored digest equality, caller/session/actor and exact hash-only payloads, printable-key hashing; actual click execution/defaults/overrides and allowed click payloads. |
| D2 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.test.ts:230-249,269-272,291-296,315-325,332-340,606-609,641-648` | Real attached bounds emit spy observes zero events/calls to emit, before input; hung action timer, no subsequent capture/title; deadline stops not-started actions without event; type/title budgets; not-running/title failures; actual explicit/default settle and deadline clamp/no subsequent action/event. |
| D3 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.test.ts:343-358,384-393,410-413,702-705,715-747,766-805,833` | Ledger false/throw stop without images, active busy identity and no second input, ≤200/<7d retention/current run, held host mutex refusal, next-run success and rebind after normal completion, geometry failure, hung-action timeout and unstored event; identity reset does not crash. |
| D4 | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.test.ts:138-145,427-529,656-672,852-856` | Poisoned child env PATH/HOME only; remote/failed/empty/malformed/throwing/hung locality refuses before geometry/input/events; proven local endpoint proceeds; ENOENT runner does not echo argv; failed type/storage fixed diagnostics exclude text/path. |
| T | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/tool.test.ts:139-208,225-227,240-267,281-300,331-346,358-362` | In-memory MCP strict/refusal/no-ledger/unwired/busy contract; operator-marked unlisted refused and listed caller attributed to token surface; image reply/stored digest equality; ledger loss no images; driver throw maps through real MCP to redacted error≤400 and no image blocks; visible schema/annotations. |
| H | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/http.test.ts:1683-1695,1704-1726,1732-1747,1759-1771` | Real HTTP bearer401 before runner/audit, valid unlisted refused, **valid-schema** spoof/propose-header cannot widen attribution, operator-marked unlisted bearer refused, audit denial before dispatch, exact submitted arg_keys=['actions'] and canonical submitted-argument digest differing from empty-object digest; typed/image content absent. |
| C | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/config.test.ts:19-65` | Fail-closed empty/valid/unknown allowlist, name-only token-free warnings, relative-dir fallback, absolute override, general warning behavior unchanged. Actual authority behavior comes from T/H, not config declarations alone. |
| L | `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/substrate-desktop.test.ts:190-270,273-299,302-325,331-352,379-387,406-415` | Executed tracked lifecycle script under PATH stubs: create/start/no-touch, emitted loopback/role/no-privilege/no-socket/no-host-bind flags, disk threshold before Docker, foreign-label/image refusals, remote-host/context and failed-locality refusal before image/env-file/run/start, bounded readiness, mode/silence/preservation, status keys and root/usage refusals. |
| E | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/rehearsal-env.test.ts:83-96,121-141,202-206,229-230,277-299` | Generated isolated env through actual loadConfig; directory/allowlist round-trip, empty/anonymous warnings, subset refusal, no parent secret forwarding and exact public env contract. |
| R | `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/rehearsal.test.ts:250-271` | CLI empty/valid subset, unknown/outside-subset and anonymous refusal. Actual named twin boot provides separate server-plumbing proof. |
| V | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/event-sources.test.ts:18-29,35-48,124-132,163-192` | Real normalizeEvent preserves sample contract, banned content keys, marked doc table agrees on IDs/kind/surface/action/runtime. D1 supplies actual driver event proof; doc-sync alone does not. |
| Q | `/root/src/worktrees/agent-substrate-v13-autonomous/packages/audit/src/policy.test.ts:87-99` | Actual auditMode and decided set membership for desktop_run; H separately exercises fail-closed dispatch. |
| S | `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/desktop-smoke.test.ts:44-53,67-70,95-118,126-152,157-168,177-196,201-213` | Smoke arg/loopback target boundary, nonce channel, marker input validity, exact-RGB PNG band/absent/split blob semantics, SSE image and escaped text-leak detection. Parent actual spike/MCP proves keystrokes reached the real surface. |
| N | `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/desktop-smoke.test.ts:219-262` | Successful empty inventory means absent; failed inventory never absent; listed row needs successful/nonempty inspect; identical present and absent states accepted; appearance/disappearance/metadata change and every error blocked. Mock-echo orchestration tests and unused exported runner seam were deleted, not credited. |

Source cross-check: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.ts:345-360` rejects unknown locality before geometry; `/root/src/worktrees/agent-substrate-v13-autonomous/infra/desktop/substrate-desktop.sh:70-95` uses bounded context inspection and fails closed before lifecycle effects. `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/desktop-smoke.ts:309-339` keeps typed present/absent/error and simple private conditional inspect. These source reads support the exercised behavior; they are not standalone passes.

## Every actual plan task mapped

| Task ID | Wave | Requirement | Actual task / evidence | Final local status |
|---|---|---|---|---|
| 30-01-1 | 1 | DESK-01/02 prerequisite | Phase16/17/18 base recorded in30-01-SUMMARY109–115; consumed behavior E/R/V/D4. Presence/symbol commands remain administrative. | Recorded prerequisite; no rebase/main claim |
| 30-01-2 | 1 | DESK-01 | Action/schema/codec A/P; desktop command | covered, parent-green |
| 30-01-3 | 1 | DESK-01/02 | Driver D1–D4; desktop command | covered, G1–G4 filled |
| 30-02-1 | 1 | DESK-03 | Config C plus actual T/H authority; desktop/HTTP commands | covered, parent-green |
| 30-02-2 | 1 | DESK-03 | Parsing/warnings/absolute-dir C; desktop command | covered, parent-green |
| 30-03-1 | 1 | DESK-04 | Actual script safety/transitions L; lifecycle command | covered; historical diff-hunk count not credit |
| 30-03-2 | 1 | DESK-04 | PATH-stub lifecycle L and parent syntax/shellcheck0 | covered, environment caveat retained |
| 30-04-1 | 2 | DESK-01/02/03 | Actual service/MCP gate T/H/D3/Q | covered; source-file-layout pin deleted |
| 30-04-2 | 2 | DESK-01/02/03 | Refusal/image/ledger/error/audit T/H | covered, G5/G6/G8 filled |
| 30-04-3 | 2 | DESK-02/03 | Event normalization/doc V plus actual D1/H and policy Q | covered, parent-green |
| 30-05-1 | 2 | DESK-05 | Harness isolated env/subset E; harness-env command | covered, parent-green |
| 30-05-2 | 2 | DESK-05 | CLI R/E and actual named twin boot | covered, parent-green |
| 30-06-1 | 2 | DESK-05 | Measured real3-repeat N1 exact-RGB capture with timings/steal | parent-observed pass |
| 30-06-2 | 2 | DESK-05 | Same fresh-as-ported actual captures, A/P/D1 | capture fix not needed |
| 30-07-1 | 3 | DESK-05 | Smoke S/N plus actual corrected MCP20/20 | covered, parent-green |
| 30-07-2 | 3 | DESK-05 | Separate real20/20, final source gates and owned up/down cleanup | parent-observed pass; initial18/20 retained FAIL |
| 30-07-3 | 3 | DESK-05 | Runbook operational/residual contract, updated30-PROOF/07-SUMMARY attribution | document-reviewed; prose counts not test proof |

## DESK-01..05 verdict

| Requirement | Behavioral boundaries | Verdict |
|---|---|---|
| DESK-01 | A/P schema/PNG; D1 actual execution/files/images; D2 timeout/error/settle; D3 busy/release; T MCP error/image boundary | covered |
| DESK-02 | D1/D4 hash-only actual events/failure privacy; D2 no not-started events; D3 ledger stop; H submitted audit digest/privacy/denial; V normalized event contract | covered |
| DESK-03 | C fail-closed parsing; T actual anonymous/unlisted/operator/schema/ledger/unwired gate; H401/valid-header/unlisted-operator/audit-denial; Q policy | covered |
| DESK-04 | L executed lifecycle security/gates/transitions; parent role/geometry/loopback/unprivileged/no-socket and syntax/shellcheck observations | covered with environment caveat |
| DESK-05 | E/R isolated harness; S/N consumer smoke states; actual three fresh pixel repeats; separate corrected MCP20/20 with image/file/event hashes, audit/auth/absence; owned teardown | covered locally; operator deployment boundary unchanged |

## Gap resolution, with actual assertions

Each prior gap is **FILLED using parent-executed coverage**, not merely a created test file. Auditor execution/debug iterations:0. No assertion was weakened to hide a failed consumer requirement.

| Gap / task | Requirement | Final assertion range and behavior | Status |
|---|---|---|---|
| G1 /30-01-3 | DESK-01/02 | D1 driver549–580: two actual click actions, correct defaults/overrides and exact allowed payload fields | FILLED |
| G2 /30-01-3 | DESK-01 | D2 driver606–609,641–648: sleep invoked with explicit50ms, default positive wait, deadline-clamped settle, next action refused/no event. No exported-default constant pin demanded. | FILLED |
| G3 /30-01-3/30-04-1 | DESK-01 | D3 driver736–747,766–780,793–805: geometry-failure/actual hung-action timer/unstored event followed by successful same-driver run, event observation and actual lock-port rebind | FILLED |
| G4 /30-01-3 | DESK-01/02 | D2 driver234–249: connected recording emit spy, emitCalls0/events[], runner only preflight/geometry before invalid click | FILLED |
| G5 /30-02-1/30-04-2 | DESK-03 | H1713–1735 valid schema separates ignored header from schema refusal; real unlisted operator bearer refused/no calls/events. T150–157,294–300 corroborates operator context and listed token attribution. | FILLED |
| G6 /30-04-1/2 | DESK-01/03 | T331–346 real MCP catch: generated secret excluded, parsed error value≤400, no image blocks. The seam's observed subprocess is a metadata probe, not proof of actual partial input or rollback; that stronger claim is not required or credited. | FILLED |
| G7 /30-01-2 | DESK-01 | P70–74 independent known DirectColor pixel; P129–147 separate valid-CRC depth/color/interlace cases reject semantically | FILLED |
| G8 /30-04-2 | DESK-02 | H1763–1771 actual HTTP record: arg_keys exactly['actions'], canonical submitted digest equals expected and differs from empty-object digest; typed/image content absent | FILLED |

**P1 resolved:** initial runtime FAIL18/20 remains historical. Corrected real20/20 is a separate observed run; N's error→error test remains false. Actual absent→absent follows successful exact-name inventory, not an inspect/probe-error fallback. The previously proposed runner-wiring/mock-echo cases and export were removed; pure consumer-state tests plus actual proof suffice. No forbidden structural orchestration test is required anew.

No remaining named consumer gap is demonstrated within the approved contract. Environment and operational residuals below are explicit limitations, not hidden passes or reasons to invent new scope.

## Incidental deletion reconciliation

| Earlier finding | Final disposition |
|---|---|
| tool.test source-name/file-layout confinement | Deleted, not allowlist-expanded; current file ends with actual visible-schema assertions at350–364. |
| actions.test complete copied argv table | Deleted, not repinned; targeted option/no-shell boundaries remain75–97. |
| actions.test exported settle constant equality | Deleted; runtime settle assertions now D2. |
| Driver complete auxiliary argv sequence, fake-title/call-number pins, fixed total timeout-call count | Deleted/replaced by actual action counts/outcomes, meaningful title availability, no subsequent capture/title/input and event semantics. No full auxiliary sequence repin. |
| Smoke runner-wiring mocked-output/count echo and unused exported seam | Deleted; N actual state-function inputs/outputs retained and actual corrected parent proof attributed. |
| Historical port diff-hunks, source/prose-name counts and bare tool-label pin | No consumer coverage credit; no replacement structural tests required. |

Exact semantic schema/payload/env contracts, fixed diagnostic privacy, loopback/no-socket flags, filesystem modes, action/event counts and independent PNG/hash assertions remain legitimate. Their retention is not structural repinning.

## Manual/operator residuals and warnings

| Residual | Honest disposition |
|---|---|
| Runtime environment coverage | The real spike/proof validates this actual desktop environment, not arbitrary future host state. No unused spike-ladder replay or capture fix required. |
| Conditional test tooling | Lifecycle root/privilege-drop cases are conditional; shellcheck test returns if unavailable. Parent separately observed syntax0/shellcheck0. Final full suite has58 skips, not58 passes; no blanket statement that all conditional tests ran. This is a WARNING caveat, not an unresolved named consumer gap. |
| Metadata-probe throw fixture wording | T error test names partial input, but invokes only context metadata probe before throwing. Credit error redaction/cap/no-images only, not actual interrupted desktop input or rollback. |
| Production identity/operator windows | Phase20 production identity/allowlist/client/UAT approvals, credential rotation, service restarts and20 operator checkpoints remain separate. No local30 proof closes them. |
| Basic-auth and historical screenshots | Operator alone owns credential file and desired screenshot preservation before production retention. Never read/print credentials to prove privacy. |
| Accepted design risks | Runbook records short-value unsalted-hash inference, bridge egress, stale in-container work after timeout and large50-screenshot replies. Not newly fixed, not broadened into extra feature requirements. |
| Dirty integration source provenance | Final receipts explicitly describe owned corrections pending commit; validation is not a main merge, release or deployment receipt. |

## Validation sign-off

- [x] All7 PLAN/SUMMARY pairs read and17/17 actual tasks mapped.
- [x] DESK-01..05 mapped to actual boundary/schema/error/timeout/busy/release/audit/privacy/PNG/loopback/other-desktop assertions.
- [x] G1–G8 behavioral coverage filled and exercised by parent's final suite.
- [x] Incidental/source/argv/declaration pins deleted without repinning.
- [x] Actual3-repeat fresh-pixel spike credited; capture fix not needed.
- [x] Initial FAIL18/20 preserved; separate corrected parent20/20 observed.
- [x] Final2719/58skip/0fail, types0, locks108/0, syntax0/shellcheck0 attributed.
- [x] No child execution or production/main/milestone completion claim.
- [x] `nyquist_compliant:true` warranted for this local phase contract; residual warnings/operators remain explicit.

## Validation Audit

| Field | Initial audit | Final reconciliation |
|---|---|---|
| Tasks mapped |17/17|17/17|
| Named coverage gaps |G1–G8 open|G1–G8 FILLED with actual assertion ranges and parent execution|
| Runtime blocker |P1 corrected proof pending|P1 resolved by separate real20/20; historical18/20 remains FAIL|
| Auditor-created/executed tests |0|0|
| Parent final source gates |pending|2719pass/58skip/0fail, types0, locks108/0, shell0|
| Nyquist compliance |false|true for approved local contract|
| Only owned file changed | `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/30-desktop-run/30-VALIDATION.md` | same |
