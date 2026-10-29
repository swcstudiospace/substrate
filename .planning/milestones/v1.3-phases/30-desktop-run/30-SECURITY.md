---
phase: 30
slug: desktop-run
status: verified
threats_open: 0
asvs_level: 1
block_on: high
created: 2026-10-11
register_authored_at_plan_time: true
---

> Recovered 2026-10-29 from an uncommitted worktree of branch swarm/v13-autonomous-integration (HEAD 76a4b2c3).
> Written 2026-10-11 to 2026-10-12 during the v1.3 autonomous integration; it describes that run and was not re-verified against main.
> Its paths and line references point at the 2026-10-11 tree, not at main.

# Phase 30 — Security

## SECURED

**Phase:** 30 — desktop_run, DESK-01..05.
**Threats Closed:** 28/32.
**High-severity threats:** 16/16 closed.
**Blocking threats open:** 0.
**Open non-blocking threats:** 4, all proposed accept dispositions without an approved acceptance record.
**ASVS Level:** 1. **Block threshold:** high, unchanged.

This is a source-security verdict for the isolated integration implementation, not production approval, main-branch completion, a release approval, or whole-milestone completion. The parent alone persists this artifact. The auditor performed only static reads/searches, wrote no files, ran no tests/checks/scans/scripts, and performed no runtime, Docker, HTTP, model, credential or production actions. Test references establish actual assertions in source; executable results below belong to the parent.

## Configuration and Canonical Register Provenance

`/root/src/worktrees/agent-substrate-v13-autonomous/.planning/config.json:1-12` defines neither workflow.security_asvs_level nor workflow.security_block_on. Native secure-phase defaults therefore apply: **ASVS 1**, **high** threshold. The assignment-required end-to-end boundary trace supplements the default verification depth without changing policy.

The canonical register is the union of the seven live PLAN `<threat_model>` blocks, not the historical aggregate RESEARCH register. Preserve the literal live-plan IDs `T-30-01` through `T-30-31` plus reserved `T-30-SC` (T30 shorthand in the assignment). Numeric IDs are unique. The same low/accept supply-chain row appears in all seven plans and is consolidated once. Original categories, severities, dispositions and current plan ownership are retained; no aggregate historical ID overrides a live-plan meaning.

| Plan | Canonical numeric IDs |
|------|-----------------------|
| 30-01 | 01, 02, 05, 06, 09, 10, 11 |
| 30-02 | 03, 15, 16 |
| 30-03 | 08, 12, 14, 17 |
| 30-04 | 04, 18, 19, 20, 21 |
| 30-05 | 22, 23 |
| 30-06 | 07, 13, 24, 25 |
| 30-07 | 26, 27, 28, 29, 30, 31 |

All seven also contribute the single reserved T-30-SC. There are no transfer dispositions. Research intent, runbook “accepted by design” wording and CONTEXT approval of UX recommendations do not constitute an authorized Accepted Risks Log entry.

## Trust Boundaries

| Boundary | Data and control |
|----------|------------------|
| Client → token identity | Bearer resolves to a configured surface before body handling. Unknown/missing bearer is refused where authentication is required. |
| Token identity → audit → MCP dispatcher | Audit append precedes dispatcher connection. desktop_run is fail-closed. Arguments become key names plus canonical digest, not stored values/results. |
| Strict input → service gate → driver | Four strict actions; no caller-supplied shell, program, session, surface or screenshot path. Anonymous/unlisted/unwired/no-ledger refusal precedes driver execution. |
| Driver → Docker client → display | Fixed argv, PATH/HOME-only child environment, positive local-unix endpoint evidence before geometry/input/capture, then geometry/bounds checks. |
| Operator lifecycle → Docker daemon | Root/disk gates, bounded positive locality proof, local-image refusal, role-gated reuse and constrained creation. |
| Display → PNG storage → caller | XWD decode/PNG encode, generated run directories, numeric filenames, private modes, retention; images only in tool reply. |
| Executed action → ledger | Explicit authenticated surface and desktop:<run_id> session; text/key-content hashes and screenshot hashes/dimensions; no title/path/text/base64. Unstored event stops further actions. |
| Harness → proof output → owned cleanup | Harness-only URL/token files, per-run screenshot directory, read-only unrelated-container snapshots and owned teardown. |

## Threat Register

CLOSED means the declared mitigation exists at its actual source boundary within its stated scope. It does not authorize unapproved residual risks or production operation.

| Threat ID | Plan | Category | Component | Severity | Disposition | Evidence / mitigation | Status |
|-----------|------|----------|-----------|----------|-------------|-----------------------|--------|
| T-30-01 | 30-01 | Elevation | Action argv/local desktop execution | high | mitigate | Fixed EXEC and strict fields, numeric serialization, text/key option terminators, xdotool/xwd only: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/actions.ts:9-111`. Shell-free execFile: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.ts:74-92`. Repaired locality rejects timeout, nonzero result, empty endpoint and non-unix endpoint before geometry/input/capture at same file `:343-362`; regression assertions at `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.test.ts:415-531`. | CLOSED |
| T-30-02 | 30-01 | Information disclosure | Child environment | high | mitigate | childEnv returns PATH/HOME only and is actually passed to execFile: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.ts:74-92`. Poisoned-parent assertions: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.test.ts:125-147`. | CLOSED |
| T-30-03 | 30-02 | Elevation | Allowlist parsing | high | mitigate | Empty list means nobody; only known surfaces enter set; unknown names dropped: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/config.ts:367-377,416-419`. Gate ignores operator authority: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.ts:746-760`. Explicit operator-marked unlisted refusal asserts zero runner/events: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/http.test.ts:1729-1736`. | CLOSED |
| T-30-04 | 30-04 | Spoofing | Surface self-attribution | high | mitigate | Strict object is directly registered and handler uses callerSurface: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/mcp.ts:933-948`; strict schema at `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/actions.ts:20-50`. MCP extra-surface refusal: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/tool.test.ts:158-168`. Real-HTTP test isolates spoofed attribution/proposal headers with a valid body and asserts zero execution/events: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/http.test.ts:1710-1727`. | CLOSED |
| T-30-05 | 30-01 | Information disclosure | Action event payloads | high | mitigate | Tightened non-shift-modifier/fixed-nonprinting key rule, otherwise keys_len/keys_sha256: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.ts:260-304`. Actual action details use text_len/text_sha256 and keyFields; actual emitted payload omits title/path/images: same file `:390-395,436-454`. Fixed failure diagnostics prevent child-stderr/argv text leakage at `:85-92,232-240`. Printable-key hashing assertions: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.test.ts:104-122,219-241`. Unsalted hash residual warning remains documented, not accepted by this audit. | CLOSED |
| T-30-06 | 30-01 | Information disclosure | Screenshot files | medium | mitigate | Generated run directory, fixed numeric PNG name, 0700 directory and 0600 file: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.ts:404-412,483-484`; 200-run/7-day constants and prune at `:49-50,243-255,468-472`. Mode/retention assertions remain in `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.test.ts`. | CLOSED |
| T-30-07 | 30-06 | Information disclosure | Desktop network egress residual | medium | accept | `/root/src/worktrees/agent-substrate-v13-autonomous/docs/runbooks/desktop.md:118-125` documents egress and bridge-gateway access. No approved Phase 30 Accepted Risks Log entry exists. “Accepted by design” is a proposal, not authorization. | OPEN — below high threshold (non-blocking) |
| T-30-08 | 30-03 | Information disclosure | Basic-auth env file | high | mitigate | Generate-once, umask 077, mktemp, chmod 600, rename, no credential echo: `/root/src/worktrees/agent-substrate-v13-autonomous/infra/desktop/substrate-desktop.sh:53-67`. Existing-file/output/private-mode assertions: `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/substrate-desktop.test.ts:303-323`. No real credential file read by auditor. | CLOSED |
| T-30-09 | 30-01 | Denial of service | Deadlines and exclusion | medium | mitigate | Timeout/actions schema caps: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/actions.ts:48-50`. Timer race, not-started deadline stop, min(remaining, action budget), settle clamp and finally release: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.ts:320-332,377-400,424-429,477-497`. Host-wide atomic loopback mutex: same file `:137-225`. New deadline and geometry-failure/action-timeout/unstored-event release assertions: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.test.ts:585-649,726-804`. The contract stops not-yet-started actions, not a hard 120s response guarantee; post-action title read retains its declared budget. | CLOSED |
| T-30-10 | 30-01 | Tampering | Run IDs/pruning | medium | mitigate | RUN_ID filter confines deletion to generated run names; timestamp/random-hex ID is generated by server: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.ts:61,243-255,483-484`. No caller-supplied run ID or screenshot name in strict schema. | CLOSED |
| T-30-11 | 30-01 | Information disclosure | Failure diagnostics | medium | mitigate | Fixed not-running/exit/storage diagnostics, no argv-bearing error.message fallback, shared redact and 300-char event-error cap: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.ts:85-92,232-240,414-418,452`. Failure-text regression assertions: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.test.ts:653-670`. | CLOSED |
| T-30-12 | 30-03 | Tampering | Unrelated desktop ownership | high | mitigate | Lifecycle targets substrate-desktop only: `/root/src/worktrees/agent-substrate-v13-autonomous/infra/desktop/substrate-desktop.sh:20-25,98-137`; stub clean-argv assertions: `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/substrate-desktop.test.ts:175-184`. Proof unrelated-container operations are exact-name read-only inventory/inspect at `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/desktop-smoke.ts:271-290`. Separate corrected parent proof observed absent→absent; no create/start/stop/change. | CLOSED |
| T-30-13 | 30-06 | Tampering | In-container input after timeout | low | accept | Residual documented, not resolved by local-client timeout: `/root/src/worktrees/agent-substrate-v13-autonomous/docs/runbooks/desktop.md:127-135`. No approved accepted-risk entry. | OPEN — below high threshold (non-blocking) |
| T-30-14 | 30-03 | Tampering | Lifecycle local image/flags | high | mitigate | Bounded positive locality gate now has a refusing failure branch before image/env-file/create/start: `/root/src/worktrees/agent-substrate-v13-autonomous/infra/desktop/substrate-desktop.sh:76-105`. Role reuse check, --pull never, loopback-only publish, named volume, no privileged/socket/host-bind creation flags: same file `:107-123`. Failed-probe assertions explicitly require nonzero exit, no image/run/start and no env file: `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/substrate-desktop.test.ts:282-291`. | CLOSED |
| T-30-15 | 30-02 | Tampering | Screenshot directory config | medium | mitigate | Absolute override or default with warning: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/config.ts:377,417-419,657-665`; relative/absolute assertions: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/config.test.ts:49-61`. | CLOSED |
| T-30-16 | 30-02 | Information disclosure | Desktop boot warnings | medium | mitigate | Warnings derive from dropped names/rejected path, not token values, and startup wires sibling warnings: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/config.ts:648-665`; `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/index.ts:46-47`. Token-value absence assertion: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/config.test.ts:34-46`. | CLOSED |
| T-30-17 | 30-03 | Denial of service | Disk gate | medium | mitigate | Root and 10 GiB free gate precede locality/image/container operations: `/root/src/worktrees/agent-substrate-v13-autonomous/infra/desktop/substrate-desktop.sh:98-104`. Readiness geometry exec bounded by remaining time: same file `:126-135`; below/exact disk threshold assertions: `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/substrate-desktop.test.ts:241-253`. | CLOSED |
| T-30-18 | 30-04 | Elevation | Anonymous/unlisted/VM refusal | high | mitigate | Identity established and missing/unmapped bearer rejected before body/dispatch: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/server.ts:400-410,463-467`. Anonymous/unlisted/unwired/no-ledger service refusal precedes driver: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/service.ts:746-760`. HTTP 401/zero-run/zero-audit and unlisted zero-run/zero-events: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/http.test.ts:1679-1708`; operator bypass regression at `:1729-1736`. MCP anonymous refusal remains in `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/tool.test.ts:145-156`. | CLOSED |
| T-30-19 | 30-04 | Information disclosure | Audit content/order | high | mitigate | Audit awaited before MCP connection/dispatch: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/server.ts:850-870`; append/denial boundary: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/observe.ts:380-438`. Record stores arg_keys/arg_digest, not args/results: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/audit/src/record.ts:180-194,224-247`. Policy entry: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/audit/src/policy.ts:16-30`. Current HTTP audit-denial and exact canonical submitted-argument digest/no-text/no-base64 assertions: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/http.test.ts:1738-1772`. | CLOSED |
| T-30-20 | 30-04 | Information disclosure | Image blocks | medium | mitigate | Handler separates images and returns them only as MCP image blocks: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/mcp.ts:948-957`. Driver events have hashes/dimensions, not image bytes; unstored emit clears images and stops: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.ts:410-413,436-464`. | CLOSED |
| T-30-21 | 30-04 | Information disclosure | Handler errors | medium | mitigate | Shared redact plus 400-char refusal cap: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/mcp.ts:959-960`. Driver diagnostic controls cited under T-30-11 apply before event publication. | CLOSED |
| T-30-22 | 30-05 | Elevation | Harness desktop-surfaces flag | high | mitigate | Flag rejects anonymous use, unknown names and names outside tokened surfaces: `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/rehearsal.ts:180-206`. Env builder independently verifies subset: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/rehearsal-env.ts:189-194,231`. Assertions: `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/rehearsal.test.ts:250-270`. | CLOSED |
| T-30-23 | 30-05 | Tampering | Harness screenshot path | low | mitigate | Always runDir/desktop, not inherited operator override: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/rehearsal-env.ts:232-257`. Owned directory removal on down paths: `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/rehearsal.ts:1268-1311`. | CLOSED |
| T-30-24 | 30-06 | Elevation | Capture-fix argv | high | mitigate | No capture fix needed; xwd root capture remains fixed: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/actions.ts:102-104`; actual decode/encode capture flow: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.ts:396-412`. Exact builder/no-shell assertions: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/actions.test.ts:75-112`. Parent measured three fresh as-ported repeats. | CLOSED |
| T-30-25 | 30-06 | Tampering | Spike ownership | high | mitigate | Fixed input/capture target: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/actions.ts:9,79-111`. Parent spike evidence attributes activity to role-verified dedicated desktop and own mutex/terminals; no unrelated-container mutation. | CLOSED |
| T-30-26 | 30-07 | Information disclosure | Smoke/proof reporting | high | mitigate | Harness tokens used for authorization, not printed; child env PATH/HOME only: `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/desktop-smoke.ts:237-266`. Snapshot output is state/length-only, not metadata/raw errors: same file `:341-361`. Digest/count/size reports and escaped typed-text/base64 absence checks remain in the final proof implementation. Real proof record contains only permitted evidence. | CLOSED |
| T-30-27 | 30-07 | Information disclosure | Credentialless auth probe | high | mitigate | Empty-token getStatus omits Authorization; fixed loopback6081 check requires 401: `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/desktop-smoke.ts:390-410,802`. No basic-auth credential file is read by smoke/auditor. Parent corrected run observed webtop401. | CLOSED |
| T-30-28 | 30-07 | Tampering | Unrelated-container snapshots | high | mitigate | Exact-name list/inspect; absent only on successful empty inventory; probe failure/missing/empty inspect is error; equality excludes all errors and only accepts absent/absent or identical present fingerprints: `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/desktop-smoke.ts:271-338`. Pure state assertions: `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/desktop-smoke.test.ts:217-263`. Unused injected-runner export and its wiring-only tests removed. Corrected parent proof separately observed successful absent→absent. | CLOSED |
| T-30-29 | 30-07 | Information disclosure | Egress residual disclosure | medium | mitigate | The declared mitigation is residual disclosure, not new firewalling. Warning is present at `/root/src/worktrees/agent-substrate-v13-autonomous/docs/runbooks/desktop.md:118-125`; loopback publication actually configured at `/root/src/worktrees/agent-substrate-v13-autonomous/infra/desktop/substrate-desktop.sh:25,118`. Closure does not assert air-gapping or approve T-30-07. | CLOSED |
| T-30-30 | 30-07 | Denial of service | 50-screenshot reply size | medium | accept | 50 actions remain allowed; handler returns images without a new cap: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/actions.ts:49`; `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/mcp.ts:951-957`. Warning at `/root/src/worktrees/agent-substrate-v13-autonomous/docs/runbooks/desktop.md:134-135`. No approved accepted-risk entry. | OPEN — below high threshold (non-blocking) |
| T-30-31 | 30-07 | Information disclosure | Proof screenshot cleanup | medium | mitigate | Harness path confined under runDir and owned teardown removes it: `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/rehearsal-env.ts:256`; `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/rehearsal.ts:1268-1311`. Parent corrected runtime down exit0 removed two owned stores; all owned terminals closed; dedicated desktop remains running. | CLOSED |
| T-30-SC | all seven | Tampering | Dependencies | low | accept | No-new-dependency/built-in-codec/existing-transport rationale remains proposed. No approved Phase 30 accepted-risk entry. Rationale alone does not authorize acceptance. | OPEN — below high threshold (non-blocking) |

## Focused Re-Audit: Two Former Blocking Gaps Closed

### T-30-01 — positive locality proof now precedes every desktop effect

At `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.ts:353-360`, the context probe must return successfully and supply a nonempty unix endpoint. TIMEOUT, nonzero code, empty output and non-unix endpoint each throw. The first geometry call is later at line362; input and capture are later still. A throwing runner becomes a failed result in call() and is therefore refused too. Missing locality no longer authorizes execution.

Current tests at `/root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/desktop/driver.test.ts:415-531` assert only contextArgv was called and no event emitted for remote, failed, empty, malformed, throwing and hung probes; the successful local case still proceeds. The old proceed-on-failed-probe expectation/comment is absent. This is actual source closure, not a promise to fix.

The parent reports its real failed-probe fixture previously executed one key and emitted one event after code1; the corrected fixture reports refusal true, **zero input actions and zero events**, corroborated by `local://v13-final-runtime-evidence.json` actual_failure_after. The auditor did not replay either operation.

### T-30-14 — lifecycle locality failure now refuses before side effects

At `/root/src/worktrees/agent-substrate-v13-autonomous/infra/desktop/substrate-desktop.sh:86-95`, context inspection is bounded by timeout10 and the failure branch calls die. Successful empty or non-unix output also calls die. cmd_up invokes this gate at line103 before image inspection at104, credential-file handling at105 and container start/create afterward. Root/disk/image/role/no-pull/loopback/unprivileged/named-volume/no-socket constraints remain intact.

The replacement assertion at `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/substrate-desktop.test.ts:282-291` requires failed endpoint discovery to exit nonzero with no image inspection, run/start or env-file creation. The old successful broken-probe expectation is absent. Parent shell syntax and shellcheck results are exit0 in the final green evidence; no shell command was run by this auditor.

## End-to-End Boundary Trace

1. **Identity:** server resolves bearer to caller surface and refuses unmapped/missing credentials before reading the MCP body on authenticated configurations. An anonymous transport cannot bypass runDesktop's null-surface refusal. Operator marking and spoofed attribution headers cannot widen the allowlist; the final real-HTTP tests isolate these cases with valid bodies.
2. **Audit:** handleMcp awaits the fail-closed audit before dispatcher connection. Record builder stores sanitized metadata, key names and canonical submitted-argument digest only. The final G8 HTTP case asserts the exact digest of the actual actions object, rejects the empty-object digest and checks no typed text/base64. Audit failure prevents the runner.
3. **Schema/gate:** strict four-action input rejects extra caller surface/program/shell/path/session fields. Service checks anonymous, unlisted, unwired and no-ledger before delegation. Driver reparses and acquires module/host exclusion. Geometry and all click bounds are checked before any input; after repair even geometry requires positive locality first.
4. **Execution/display:** fixed Docker argv pins DISPLAY=:1 and the dedicated container name, uses only xdotool/xwd for effects and terminates text/key options. No shell interpreter or default session is introduced. PATH/HOME-only environment excludes inherited service secrets. Operator lifecycle requires positive local endpoint evidence before image/env-file/container operations and retains local image/no-pull, role-gated reuse, loopback publication, no privilege, named-volume-only creation and no Docker socket.
5. **Image/storage:** root XWD is decoded/reencoded as PNG, stored under generated private directories/numeric filenames and returned in MCP image blocks. Real exact-RGB evidence shows the as-ported path is fresh; no title-based substitute or capture fix is used.
6. **Ledger:** explicit authenticated surface, actor agent, kind tool.call and session desktop:<generated-run_id>. Text is length/hash; printable-key injection is length/hash unless every chord matches the tightened safe-verbatim rule; screenshot is hash/dimensions. Event payload excludes title/path/text/base64. Raw child/storage failures cannot enter payload diagnostics; shared redact/caps apply. Unstored/throwing emit stops subsequent actions and clears returned images. Not-started deadline actions produce no event.
7. **Deadline/mutex:** remaining-time budgets stop new actions; settle is clamped; title completion follows its declared post-action budget. Host bind plus module flag excludes concurrent processes/calls; finally releases on success and failure. Current tests include geometry failure, hung action and unstored event followed by successful reacquisition, not merely a happy-path mutex test.
8. **Proof/cleanup:** harness-only target guard and private token files precede requests. Snapshot uses read-only exact-name inventory/inspect with distinct absent/present/error semantics. Parent teardown owns only its twin, stores/run directory and terminals; dedicated desktop remains running and unrelated container remains unchanged.

## Parent Evidence and Attribution

### Pixel spike — observed three fresh as-ported repeats

`local://v13-phase30-spike-evidence.json` and `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/30-desktop-run/30-N1-SPIKE.md` record three measured root-XWD→PNG repeats, each **9120 exact-RGB pixels**, **baseline0**, solid **480×19** rectangle. Terminal settle5000ms/type settle200ms, per-argv wall timings and host-steal samples are recorded; every owned terminal closed. `n1_reproduced=false`, fresh-as-ported true. No capture fix needed. These are parent observations, not auditor actions.

### Corrected real desktop proof — separate PASS20/20

`local://v13-final-runtime-evidence.json` and `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/30-desktop-run/30-PROOF.md` record the corrected separate parent run on revision **4df30a0 plus owned source corrections**: desktop smoke **exit0,20/20**, two image blocks, five successful logged actions, five hash-only ledger rows, marker9120/baseline0/solid480×19, matching returned/stored/event image hashes, two content-free fail-closed audit records, tokenless MCP401 and credentialless webtop401. Successful exact-name inventory showed unrelated desktop **absent→absent**. Probe errors do not count as absence. Up/down each exit0; two owned store containers removed; all owned terminals closed; dedicated role-verified desktop remains up, loopback6081,1280×800,unprivileged,no Docker socket.

The first actual run remains **FAILED18/20,exit1**. Its two inspect failures are preserved in PROOF's history; successful zero-row inventory diagnosis did not retroactively convert it to a pass. The corrected20/20 is a distinct later observation.

### Final source-union checks — current parent results

`local://v13-final-green-evidence.json` reports final **2719 pass / 58 skip / 0 fail**,96 files,exit0; types exit0; phase-close locks **108 pass / 0 fail**,4 files,exit0,EVENT_KINDS12/SURFACES27; bash syntax exit0 and shellcheck exit0. No formatter configured/run. Source state is owned corrections pending commit at execution, not proof of a later main commit.

These current final-green results supersede the earlier “finalgreen pending” sentence retained in the runtime artifact and the earlier same-implementation2670/58/0 evidence. Do not portray historical numbers as another final Phase30 run. The auditor consumed receipts but ran none of these checks.

### Retained evidence-scope limitation — refusal event comparison

At `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/desktop-smoke.ts:789-797`, the before/after event queries use opts.surface while the refused probe uses the unlisted token. Thus the recorded **5→5** is a listed-surface comparison, not by itself proof that no event exists under every possible surface. Retain this attribution limit when describing the smoke. It is not an observed authorization bypass or an additional blocking source threat: actual service refusal is present, and real-HTTP unlisted/header/operator tests explicitly assert **zero runner calls and zero written events**. No new all-surface query feature or expanded security contract is imposed by this focused re-audit.

Production MCP/model/main/other-container mutation actions were not part of this audit. Production identity/client/UAT checkpoints, exposed Cursor credential rotation and operator-owned steps retain their own pending status; local desktop security does not complete identity provisioning or the milestone.

## Unregistered Flags

No `## Threat Flags` section or explicit unregistered flag was found in the seven live SUMMARY files. Their absence was not used to assume unchanged attack surface. Docker-locality probes map to T-30-01/T-30-14; host-wide mutex and deadline coverage to T-30-09; printable-key/error disclosure protections to T-30-05/T-30-11; snapshot correction to T-30-12/T-30-28; exact submitted-argument digest to T-30-19. No unrelated new vulnerability scan or historical-ID register was substituted.

## Accepted Risks Log

**No approved accepted risks.**

| Threat | Severity | Proposed disposition | Missing evidence | Status |
|--------|----------|----------------------|------------------|--------|
| T-30-07 | medium | accept | Authorized accepted-risk entry for egress/bridge reachability | open — below high threshold (non-blocking) |
| T-30-13 | low | accept | Authorized accepted-risk entry for in-container input surviving client timeout | open — below high threshold (non-blocking) |
| T-30-30 | medium | accept | Authorized accepted-risk entry for uncapped 50-screenshot reply size | open — below high threshold (non-blocking) |
| T-30-SC | low | accept | Authorized accepted-risk entry for dependency/supply-chain rationale | open — below high threshold (non-blocking) |

No Accepted By/Date is fabricated. “Accepted by design” prose is not acceptance. T-30-29 closes only its declared residual-disclosure/publication mitigation and does not approve T-30-07. None of these four counts toward the unchanged high-severity blocking gate.

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open Blocking | Open Non-blocking | Run By | Scope |
|------------|---------------|--------|---------------|-------------------|--------|-------|
| 2026-10-11 | 32 | 26 | 2 | 4 | NativeGSD security auditor | Initial static audit found failed-locality fallthrough in driver and lifecycle; then-current corrected snapshot/final evidence pending |
| 2026-10-11 | 32 | 28 | 0 | 4 | NativeGSD security auditor | Focused final static re-audit closes T-30-01/T-30-14; current snapshot/HTTP/digest/deadline/mutex source inspected; corrected parent20/20 and final2719/58/0 receipts consumed |

`threats_open = 0`: no OPEN threat has severity at or above high. Four below-threshold unapproved accept proposals remain OPEN. No severity is missing or unparseable, no threshold changed and no risk was accepted by the auditor.

## Sign-Off

- [x] All32 unique canonical live-plan threats enumerated with original severity/disposition.
- [x] Every high mitigation traced to actual boundary/source evidence;16/16 closed.
- [x] Former driver and lifecycle locality blockers closed in code, not merely documented.
- [x] Current snapshot state/error behavior and relevant final HTTP/digest/deadline/mutex changes statically re-audited.
- [x] Corrected parent20/20 is separately attributed; historical18/20 retained as failure.
- [x] Current final parent gates supplied with correct source-state attribution.
- [x] Four below-threshold proposed accept risks retained without fabricated approval.
- [x] `threats_open: 0` confirmed under unchanged high threshold.
- [x] `status: verified` for this security gate only.

**Approval:** SECURED for the declared Phase30 source-security gate. Parent owns artifact persistence and overall phase advancement. No production, main-branch, identity, release or milestone approval is implied.
