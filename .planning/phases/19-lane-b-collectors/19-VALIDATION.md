---
phase: "19"
slug: "lane-b-collectors"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-08"
---

# Phase 19 — Validation Strategy

> Re-validation, iteration 2: **automated phase coverage accepted** — 15/15 tasks mapped, seven/seven requirement IDs covered, G19-01 through G19-07 FILLED on parent-observed evidence with the explicit coverage caveats below. The original PARTIAL audit is preserved as history, not rewritten as a pass. This auditor ran **no** tests, scripts, builds, lint, formatters, live probes or model turns. Compliance is not a production cutover approval, a merge-ready claim, or the parent's final phase-completion decision.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `bun:test`; beside-source `*.test.ts`; `package.json` requires Bun >= 1.4.0 |
| **Config file** | `package.json` scripts and `tsconfig.json`; no separate test config |
| **Quick run command** | `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/collectors/src/emit.test.ts` (replace with the mapped absolute test path; one file per invocation) |
| **Full suite command** | `bun --no-env-file test` followed by `bun --no-env-file run check` |
| **Phase gates** | `bun --no-env-file run check:phase-close`; mapped redaction/store lock tests; `bun --no-env-file run proof:laneb` (now real named herdr and installed scratch-scope Muse CLI proof, without models or production writes) |
| **Estimated runtime** | Original planning estimates: quick ~2 s, suite ~120 s, proof ~90 s. Current elapsed durations were not supplied; estimates are not measurements. |

**Execution scope:** Parent alone runs commands, with working directory `/root/src/worktrees/agent-substrate-v13-autonomous`; never the user checkout. Commands below are verification instructions, not executions by this auditor. `--no-env-file` does not isolate token-file fallback: parent-dispatched fixtures must explicitly select scratch token/state directories and child environments.

### Observed evidence and limits

Current authoritative result source: `local://v13-phase19-real-runtime-evidence.json`, parent-observed on 2026-10-10 after the corrected union landed. `19-PROOF.md` and `19-05-SUMMARY.md` retain the earlier 84/1 correction checkpoint; their pending-final-suite language is superseded **for this coverage audit** by the evidence ledger's final 85/0 and 2670/58/0 results. Historical task executions, commits and per-file counts in all five SUMMARYs remain historical; none is retroactively claimed as a new task-by-task run.

| Parent-observed check | Result | What it establishes |
|-----------------------|--------|---------------------|
| Final targeted behavioral union | exit 0; **85 pass / 0 fail across 6 files** | Corrected scheduling/reconnect/recovery, projection trust/drift/redaction/config diagnostics and proof-guard tests passed. No independent per-file counts are supplied or invented. |
| `bun --no-env-file run check` | final exit **0** | Current union typecheck passed; package script maps to `bunx tsc --noEmit`. |
| `bun --no-env-file run check:phase-close` | exit 0; **112 pass / 0 fail**; 12 event kinds, 27 surfaces | Current vocabulary/phase-close locks passed. |
| `bun --no-env-file test` | exit 0; **2670 pass / 58 skip / 0 fail across 96 files** | Existing collector, projector, normalization, redaction/store-lock and doctor consumer edges are green in the parent's suite. Skipped tests are not counted as requirement proof. No separate current per-task invocation is inferred. |
| Proof-owned harness up → real `proof:laneb` → down | all exit **0**; **41/41**; zero refused; own cleanup completed | Actual herdr 0.9.1 named server and watching collector process, saved-state stop/restart, workspace/report/close RPCs, scratch-HOME Muse validate/install-or-update/approve/inspect and installed hook-test CLI. This is genuine external-tool integration, **not** a socket fixture, direct-hook substitution, production exercise or model turn. |
| `systemd-analyze verify /root/src/worktrees/agent-substrate-v13-autonomous/infra/vps/substrate-collector-herdr.service /root/src/worktrees/agent-substrate-v13-autonomous/infra/vps/substrate-collector-muse.service` | current exit **0** | Static syntax of the current unit files, not installation or a production restart. |

The pre-final targeted 84/1 result was an exact disconnected `/healthz` GET attempt-count assertion: Bun may retry that idempotent GET. Its removal did not weaken the preserved BRIEF bytes, pointer, failure accounting, request-body, no-event or timeout assertions. The parent then actually ran the corrected union; the earlier failure is neither hidden nor carried forward as a current implementation failure.

The initial audit used `local://v13-phase19-parent-evidence.json`: types exit 0, locks 112/0, suite 2647/58/0 across 95 files, and a **fixture-scoped 27/27** proof. That proof did not close the external-runtime requirements. Original 19-05 executor counts (1781/57/0 and 27/27) are likewise historical, not contradictory current acceptance counts.

Current units/drop-ins and the dated runbook document later release-based cutover lineage, superseding D19-23's original checkout-based deployment shape without reverting another actor's changes. Historical actor/operator cutover receipts retain their recorded date and attribution. The parent performed **no production probes/store writes, service restarts, operator-scope plugin installs, credential rotation, model turns or PR merges**; its proof restarted only its own scratch collector. Neither static files nor earlier actors' receipts self-approve this run's manual deployment gates.

---

## Sampling Rate

- **After every task commit (parent):** mapped single-file test plus `bun --no-env-file run check`.
- **After every plan wave (parent):** full suite, the redaction/store locks, and `bun --no-env-file run check:phase-close`.
- **Before `/gsd:verify-work`:** parent-observed final local gates and the real 41/41 proof satisfy the isolated implementation proof; the old fixture 27/27 is historical only.
- **Sampling metadata:** all 15 PLAN tasks contain `<automated>` verification commands, including the docs task's non-behavioral typecheck. No three-consecutive-task command gap exists in the declared map. Actual historical after-every-task execution continuity and the original 120-second feedback-latency target are not established by aggregate totals and are not invented or demanded as a replay of completed plans.

---

## Per-Task Verification Map

Task IDs below use the canonical `19-<plan>-<ordinal>` form, assigned by source order: each of the five PLANs declares three tasks (15 total). Plan requirement frontmatter supplies the primary IDs; cross-requirement attribution is explicit. No task or checkpoint is deleted or rewritten.

**Status semantics:** `green` means the mapped behavior passed on the parent's current targeted/full-suite or real-runtime proof, not a fresh standalone invocation for every task. `green (static review)` distinguishes documentation inspection from a behavioral automated test. Warnings delimit oracle breadth/environment; they do not mark skipped or unexecuted tests green. Threat references remain the PLAN registers, not a new security verdict.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 19-01-01 | 01 | 1 | LANEB-05; supports LANEB-02 | T-19-01/02/03 | Stored/refused/failed classification, bounded hung-server failure, call-time bearer, redacted exact refusal keys; real temporary git attribution | unit + loopback/filesystem integration | `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/collectors/src/emit.test.ts`; separately `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/collectors/src/git-context.test.ts`; typecheck | yes | green — parent full suite + types |
| 19-01-02 | 01 | 1 | LANEB-05 | T-19-01 | Aggregate counters/unmapped, since filtering, malformed-line handling; scratch status CLI exits 0 | unit + CLI integration | `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/collectors/src/status.test.ts`; typecheck | yes | green — parent suite; WARNING: directory-entry oracle, not existing-file byte comparison |
| 19-01-03 | 01 | 1 | LANEB-05 | T-19-04 | Grok accepted/refused/failed counters coexist with flat offsets; shared emitter consumer remains green | unit + filesystem integration | `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/collectors/src/grok-map.test.ts`; separately `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/collectors/src/grok.test.ts`; typecheck | yes | green — parent full suite + types |
| 19-02-01 | 02 | 2 | LANEB-01, LANEB-02 | T-19-06/08 | Pinned enum/muse row, wire spelling/release, normalized kinds/surfaces and repo-carrying end; matched text redacted | unit + vocabulary lock | `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/collectors/src/herdr-map.test.ts`; separately `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/event-sources.test.ts`; phase-close | yes | green — parent suite/locks; real seam in G19-01 |
| 19-02-02 | 02 | 2 | LANEB-01, LANEB-02; supports LANEB-05 | T-19-05 | Silent seed/reload, stable session, unknown suppression, pane/agent swap, stored/refused commit and failed retry including half-committed reload | unit + filesystem integration | `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/collectors/src/herdr-state.test.ts`; typecheck | yes | green — parent behavioral union/suite; actual process restart in G19-01 |
| 19-02-03 | 02 | 2 | LANEB-01, LANEB-02 | T-19-05/07 | Single subscribe, bad-pane isolation, debounce/single-flight, timer-only repair, outage reconnect and restart-safe emissions | Unix-socket integration + real-runtime e2e | `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/collectors/src/herdr.test.ts`; typecheck; real proof below | yes | green — G19-01/G19-04 FILLED |
| 19-03-01 | 03 | 2 | LANEB-03 | T-19-10/11 | Slug/branch redacted briefs, one pointer, local exclude, scheduled refresh/restart, byte preservation and failure accounting for ledger/health/hung-I/O faults, no events | unit + repo/real-HTTP CLI integration | `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/collectors/src/muse.test.ts`; typecheck | yes | green — G19-04/G19-06 FILLED |
| 19-03-02 | 03 | 2 | SKILL-06; supports LANEB-05 | T-19-09/10/12 | Containment/regular-file/FIFO/id/size guards, redacted 0600 copy in 0700 dir, session.end, refusal, empty stdout/exit 0 | unit + spawned synthetic hook/store integration | `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/collectors/src/cursor-stop.test.ts`; typecheck; real-store proof below | yes | green — parent suite + proof; operator-installed hook remains M19-01 |
| 19-03-03 | 03 | 2 | SKILL-06 | T-19-12 | Desired stop string, equal/stale fixture check exits 0/1; other entries retained | CLI fixture integration | `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/projector/src/cursor.test.ts`; typecheck | yes | green — parent suite; historical live check not replayed or reattributed |
| 19-04-01 | 04 | 3 | LANEB-04 | T-19-13/14/15/16 | Byte-copied redactor/path-only config, fail-closed validation, install/update/approve, independent drift/trust rejection | bundle/CLI branch integration + lock + real installed proof | `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/projector/src/muse.test.ts`; separately `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/redact-lock.test.ts`; typecheck | yes | green — G19-02/G19-05 FILLED |
| 19-04-02 | 04 | 3 | LANEB-04 | T-19-13/14/15 | Real installed hook-test tool.call with slug/branch; local redaction/refusal/dead URL and missing/malformed config diagnostics with no emit | generated-hook spawn + installed scratch CLI integration | `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/projector/src/muse.test.ts`; typecheck; real proof below | yes | green — parent union/suite + G19-02/G19-05; local stub not used as external proof |
| 19-04-03 | 04 | 3 | LANEB-04; documents all seven IDs | — | Topic doc has env names/state/vocabulary/agent table/Cursor guards and recorded race/PostToolUse-only opt-outs; README links once | static documentation review; typecheck non-behavioral | `bun --no-env-file run check` (source-declared verify; content separately inspected) | yes | green (static review) — doc/README inspected; types exit 0 is not a doc test |
| 19-05-01 | 05 | 4 | LANEB-07; supports LANEB-01/03 | T-19-18 | Current release units/state paths and collector-only drop-ins; current syntax passes; original checkout lineage retained as historical | static syntax + unit diagnostics | `systemd-analyze verify /root/src/worktrees/agent-substrate-v13-autonomous/infra/vps/substrate-collector-herdr.service /root/src/worktrees/agent-substrate-v13-autonomous/infra/vps/substrate-collector-muse.service`; supplemental `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/scripts/doctor-units.test.ts` | yes | green — current syntax exit 0 + parent suite; G19-07 FILLED |
| 19-05-02 | 05 | 4 | LANEB-07; exercises LANEB-01/02/03/04/05, SKILL-06 | T-19-17/19/20 | Real named herdr/watching collector restart, installed Muse CLI, per-action deadline/config guard, store events/brief, synthetic Cursor, zero refused and owned cleanup | real external-tool/store e2e + guard unit tests | `bun --no-env-file run proof:laneb`; supplemental `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/scripts/laneb-proof.test.ts` | yes | green — parent real proof 41/41; G19-01/02/03 FILLED |
| 19-05-03 | 05 | 4 | LANEB-07; gates all seven IDs | T-19-18 | Corrected full suite/types/locks/proof green; release lineage/runbook inspected; deployment/model/credential actions not self-approved | suite + locks + documentation review; separate manual gates | `bun --no-env-file test`; `bun --no-env-file run check`; `bun --no-env-file run check:phase-close`; separately `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/redact-lock.test.ts` | yes | green — parent final union; D19-24 manual window outside isolated phase proof |

`typecheck` and `phase-close` above mean the exact commands in Test Infrastructure. The companion `bun --no-env-file test /root/src/worktrees/agent-substrate-v13-autonomous/packages/mcp-server/src/store-lock.test.ts` is a source-declared phase lock covered by the parent's suite, not a new standalone auditor run. These locks cover repository conventions, not external plugin execution.

### Requirement-to-behavior cross-reference

| Requirement | Current behavioral coverage | Acceptance / disposition |
|-------------|-----------------------------|--------------------------|
| LANEB-01 | Transport/state/timer/reconnect tests plus real named herdr pane working → idle → close and watching collector restart | COVERED — G19-01/G19-04 FILLED; deployment M19-01 remains separate |
| LANEB-02 | Git-context, enum/wire mapper/normalization/reconciler tests; real pane cwd R produces run-tagged slug/branch and repo-filtered start/note/end | COVERED — real attribution supplements local foreground-cwd fallback tests, not a claim that every fallback was live-driven |
| LANEB-03 | Redacted writer/pointer/exclude tests, scheduled CLI source refresh/restart, real hung headers/body and ledger/health-fault preservation, real-store BRIEF | COVERED — G19-04/G19-06 FILLED; documented degraded-200 race unchanged; deployment M19-01 separate |
| LANEB-04 | Bundle/collision/diagnostics/drift/trust/redaction tests and actual scratch installed/approved Muse hook-test with git attribution | COVERED — G19-02/G19-05 FILLED; operator projection M19-01 separate, model turn M19-02 optional |
| LANEB-05 | Emitter timeout/refusal, grok offsets/counters, status, herdr commit/reload/recovery; actual collector process restart and zero-refused proof | COVERED — suite + real restart, not object reconstruction alone; status no-write oracle caveat below |
| LANEB-07 | Real external drivers/store consumers 41/41, per-action deadlines/target guard, zero refused, owned cleanup, current unit syntax and final suite/types/locks | COVERED — G19-01/02/03/07 FILLED; D19-24 explicitly excludes autonomous production cutover/model approval |
| SKILL-06 | Hardened synthetic transcript/hook tests, current projector fixtures and real-store synthetic stop with redacted 0600 copy/session.end | COVERED for the authored hook contract — not a claim that the operator's currently installed hook was exercised; M19-01 separate |

### Original gaps and exact parent remediation requests (historical)

The following original PARTIAL finding table is preserved as the initial audit record. Its source line references and **ESCALATED** classifications described that earlier tree, **not** the corrected current source. Initial debug iterations were **0/3** for every item; this auditor generated no tests or executions. Current dispositions and remaining caveats follow the table.

| Gap | Classification | Task / requirements | Source-backed limitation | Parent-owned remediation and acceptance |
|-----|----------------|---------------------|--------------------------|-----------------------------------------|
| G19-01 | BLOCKER | 19-02-03, 19-05-02; LANEB-01/02/05/07 | `scripts/laneb-proof.ts:202-261` makes a local socket server and edits fixture panes; `runPass()` and reconstructed objects replace a watching collector process and actual process restart. `COVERAGE.md:21-24` and D19-26/D19-27 require real herdr operations. | Implement the existing proof's named scratch `herdr --session substrate-proof-<tag> server` driver; start the actual collector with scratch state before driving `workspace.create(cwd=R)`, `pane.report_agent` working → idle and `pane.close`. Kill/restart that collector process between working/idle, retain exactly one session.start and correct repo/branch/runtime/status/end. Use explicit scratch HOME/socket, no inherited HERDR entries, no model, and server stop + session delete in `finally`, including failure paths. The default session must remain untouched. |
| G19-02 | BLOCKER | 19-04-01/02, 19-05-02; LANEB-04/07 | `scripts/laneb-proof.ts:123-133,263-289` validates `--bundle-only`, then spawns Bun on the hook file. No scratch-scope install/approve/inspect or `muse plugins hook test` occurs. Unit tests deliberately stub `MUSE_BIN`. | In the existing isolated proof use actual Muse CLI under scratch HOME, XDG unset, no-auto-update. Validate, install/update, approve, inspect `trusted_enabled`, and execute the installed PostToolUse hook via `muse plugins hook test <plugin>:<hook> --fixture` in R. Query actual tool.call with repo/branch. Assert installed redactor bytes/config path and unchanged operator cache paths; never install in operator scope or run a model. This is an automated external-runtime gap, NOT the optional model-turn gate. |
| G19-03 | BLOCKER | 19-05-02; LANEB-07; T-19-14/17/19 | `scripts/laneb-proof.ts:88-96,246-303` begins polling after the drivers, not at each transition; one query has its own 10 s timeout and no remaining-deadline bound. `hookUrl` is read but not compared before `runHook`. Fixture passes cannot prove the required transition-to-observation latency or pre-hook config guard. | Record monotonic time before each real transition/tool invocation, bound requests by remaining time, and fail unless the repo-filtered event is observed within 10 s of that action. Assert installed hook config URL equals the already-guarded twin URL BEFORE execution; on mismatch refuse before any request. Add behavioral delayed-response and wrong-config negative cases in proof tests/fixtures chosen by parent; no source-text assertion or mock echo. Retain exit-2 production/non-loopback guard, zero-refused status, and teardown on failure. |
| G19-04 | WARNING | 19-02-03, 19-03-01; LANEB-01/03 | `herdr.test.ts` proves push debounce/single-flight, not recovery without a push on the 5 s timer. `muse.test.ts` asserts `POLL_MS` and calls `pass()` explicitly, not a scheduled 5-minute watch refresh. Existing proof drives explicit passes too. | Extend existing behavioral tests: seed, change snapshot WITHOUT a push, observe exactly one watch-timer transition; sever subscription then observe timer-driven reconnect/recovery with no duplicate start or concurrent passes. For Muse, run scratch watch and observe a second scheduled fetch/refresh with one pointer and preserved state; advance a supported test clock or observe the real interval, never assert only a constant. Parent chooses runner mechanics; no new product scheduling surface. |
| G19-05 | WARNING | 19-04-01/02; LANEB-04; T-19-13/15 | Existing projector tests cover invalid=false-result validation, harmless sentinel absence and hook/manifest drift; not `valid:true` with diagnostics, token collision refusal, redactor-only drift or secret-bearing hook payload. The untrusted check runs after hook drift, so it cannot isolate trust rejection. | Extend `/root/src/worktrees/agent-substrate-v13-autonomous/packages/projector/src/muse.test.ts`: valid true + nonempty diagnostics must prevent install/approve; a token value deliberately colliding with config must refuse before bundle write; mutate ONLY installed redactor bytes and require check exit 1; matching bytes + `review_needed` must independently fail; generated hook with runtime-assembled decoys in tool/outcome/tool_use_id and refusal error must transmit/store/log redacted values, preserving innocuous fields, empty stdout and bounded fail-open. Keep fake CLI for these local branch tests; it cannot close G19-02. |
| G19-06 | WARNING | 19-03-01; LANEB-03 | `muse.test.ts:173-207` covers HTTP/empty/throwing-fetch byte preservation, but the down-ledger case starts without an existing BRIEF and no hung-server timeout is exercised. | Extend `/root/src/worktrees/agent-substrate-v13-autonomous/packages/collectors/src/muse.test.ts` using scratch repos with a known good BRIEF: greptime false/health failure and a healthy healthz followed by a genuinely hung brief request must retain identical bytes, record failure, preserve one pointer and issue no /events call. Observe bounded timeout with real loopback I/O, not an immediate throwing fetch substitute. Preserve the separately documented healthz-then-degraded-200 race; do not silently broaden the requirement to fixing it. |
| G19-07 | WARNING | 19-05-01/03; LANEB-07; supports LANEB-01/03 | SUMMARY's unit syntax exit 0 predates the current release/drop-in shape. Parent's current full suite covers doctor assertions, not `systemd-analyze verify`. Frozen D19-23 names checkout-based paths while current units/runbook describe later release cutover. | Parent obtains current unit syntax result with the mapped absolute command and reconciles dated plan/summary vs current release lineage in verification evidence (no revert of others' changes). Credit historical unit checks as historical only; do not infer installation/restarts from file contents or convert repo cutover prose to this run's manual acceptance. |

Supporting limitations, not new product scope: docs-only task verifies typechecking rather than documentation behavior; parent must review those acceptance statements. The status test's directory-entry comparison is narrower than a byte-for-byte no-write oracle. These caveats do not convert the named external-runtime gaps into passing coverage.

### Gap reconciliation — iteration 2 (current)

Evidence is the parent's final corrected union and real-runtime ledger, cross-checked against the corrected source. All seven gaps resolve to **FILLED**; none is waived as SKIP or disguised as a pass from the historical fixture proof. Warnings below preserve narrower regression or environmental coverage without inventing an unmet LANEB criterion. Auditor debug iterations remain **0/3**: no child ran a script or test.

| Gap | Current status | Task / requirements | Executed evidence and source |
|-----|----------------|---------------------|------------------------------|
| G19-01 | FILLED | 19-02-03, 19-05-02; LANEB-01/02/05/07 | Parent real proof 41/41. `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/laneb-proof.ts:401-513` starts the proof-named server/actual watching collector, seeds scratch state, creates R's pane, reports working, stops/restarts that collector with saved offsets, reports idle, closes pane and asserts exactly one start. `:707-732` owns finally cleanup. No default-session, model or production substitute. |
| G19-02 | FILLED | 19-04-01/02, 19-05-02; LANEB-04/07 | Parent 41/41 uses actual scratch-HOME Muse validate/install-or-update/approve/inspect (`trusted_enabled`), cache/config/redactor readback and installed hook-test CLI in R; operator cache paths unchanged. Proof source `:515-619`; local projector stubs are complementary negative-case coverage, not external integration evidence. |
| G19-03 | FILLED; WARNING on regression breadth | 19-05-02; LANEB-07 | Parent observed start/note/end/tool.call within ten seconds from each actual action, and installed config guarded before execution. Proof `:90-142` bounds query abort by remaining deadline; action timestamps precede reports/close/hook (`:453`, `:485`, `:497`, `:588`); `:571-575` returns before hook execution on mismatch. `/root/src/worktrees/agent-substrate-v13-autonomous/scripts/laneb-proof.test.ts:4-38` exercises elapsed-budget, unsafe/mismatched target, ownership and env guards. It does **not** independently drive delayed-query or wrong-installed-config e2e failure scenarios; clock is `Date.now()` (wall-clock), not monotonic. Observed timing passes do not prove clock-jump immunity. |
| G19-04 | FILLED; WARNING on scheduling environment | 19-02-03, 19-03-01; LANEB-01/03 | Parent targeted union/full suite green. `/root/src/worktrees/agent-substrate-v13-autonomous/packages/collectors/src/herdr.test.ts:240-414` observes timer-only missing-push repair and severed-subscription/outage recovery, exact events/session/dedupe and single-flight gating. `/root/src/worktrees/agent-substrate-v13-autonomous/packages/collectors/src/muse.test.ts:608-681` runs a real writer CLI/HTTP source, advances only child sleep to 299999+1 ms, verifies no early refresh, new redacted bytes/branch, one unchanged pointer and persisted state after process restart. Herdr uses a shortened supported poll interval; Muse sleep is virtual, not a five-minute wall-clock soak. Neither test merely asserts a constant or calls `pass()` for the scheduled behavior. |
| G19-05 | FILLED; WARNING on decoy-field breadth | 19-04-01/02; LANEB-04 | Parent union/suite green. `/root/src/worktrees/agent-substrate-v13-autonomous/packages/projector/src/muse.test.ts:235-271` refuses diagnostics despite valid true, refuses token collision before write, isolates redactor-only drift and byte-matching untrusted status. `:398-463` proves planted tool-name decoy absent from posted envelope/refusal file/stderr; `:275-323` pins benign payload fields. Separate planted decoys in outcome/tool_use_id are not independently demonstrated. `:465-542` additionally verifies missing/unparseable config yields exit 0, empty stdout, one non-secret diagnostic and no event/refusal emit. Real installed execution is G19-02, not these fake-CLI branches. |
| G19-06 | FILLED | 19-03-01; LANEB-03 | Parent corrected behavioral union green. `/root/src/worktrees/agent-substrate-v13-autonomous/packages/collectors/src/muse.test.ts:683-736` first stores known good bytes, then schedules ledger-down, health HTTP/disconnect, hung brief headers and hung body over actual loopback I/O. It checks identical BRIEF/pointer bytes, one marker, preserved success, incremented persisted fetch_failed/last_failure, correct bodies, no other routes/events, and real abort elapsed 2500–6500 ms for hung requests. Incidental GET attempt totals were removed; these behavioral assertions remain. |
| G19-07 | FILLED | 19-05-01/03; LANEB-07; supports LANEB-01/03 | Parent current `systemd-analyze verify` exit 0 and doctor coverage in the 2670/58/0 suite. Current unit files use `/opt/agent-substrate/current`, guarded release entry points and state paths; collector-only `10-environment.conf` drop-ins and the runbook retain later release-cutover lineage and historical receipt attribution. D19-23's original checkout/shared-env arrangement is recorded as superseded, not declared byte-identical to today's deployment or replayed. No current install/restart is inferred. |

**Genuine remaining limits, explicitly not self-approved:** M19-01 deployment checks need their operator window/evidence; M19-02 is optional and unperformed; M19-03 global credential rotation is still pending and outside Phase 19's authored requirement count. Original source doc/no-write caveats remain: the docs task has static inspection rather than a behavioral doc test, and the passing status test compares directory entries, not every existing file byte (current `status.ts` imports only `readFileSync` from fs). Historical execution cadence and full-suite latency are not measured by this ledger. These limits do not invalidate the executed isolated requirement proof or require re-running historical plans.


---

## Wave 0 Requirements

- [x] Existing `/root/src/worktrees/agent-substrate-v13-autonomous/packages/collectors/src/{emit,git-context,herdr-map,herdr-state,herdr,muse,cursor-stop,status}.test.ts` and grok outcome/mapper tests inspected.
- [x] Existing `/root/src/worktrees/agent-substrate-v13-autonomous/packages/projector/src/{muse,cursor}.test.ts` inspected.
- [x] Pinned 17-id enum and underscore/dotted/release envelopes present in mapper tests.
- [x] `proof:laneb` and `collectors:status` scripts present in `/root/src/worktrees/agent-substrate-v13-autonomous/package.json`.
- [x] Real installed Muse hook-test and real named herdr driver observed by parent (G19-01/G19-02; 41/41).
- [x] G19-03 deadline/guard and G19-04 through G19-06 behavioral edges have parent-run evidence; narrower regression/environment caveats above retained.
- Framework install: none needed. Existing infrastructure plus corrected real-runtime proof covers the phase's isolated requirements; `wave_0_complete: true` records coverage availability and executed evidence, not approval of manual production gates.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| M19-01 — Production services running accepted main/release code, operator-scope Muse projected/approved, installed Cursor stop hook current | Deployment follow-through for LANEB-01/03/04 and SKILL-06, outside isolated phase proof | Live system; operator-approved post-merge window (D19-24). **Not performed or self-approved by this parent/auditor.** Existing dated historical receipts remain separately attributed. | Operator follows `/root/src/worktrees/agent-substrate-v13-autonomous/docs/runbooks/lane-b-collectors.md` in the approved deployment scope and supplies dated service/projection/check evidence. Do not replay another actor's cutover or invent a current approval for coverage closure. |
| M19-02 — A real Muse model turn emits tool.call | Optional LANEB-04 demonstration, not isolated-proof acceptance | Spends model quota and requires separate operator approval. **Not performed by this run.** | After separately approved projection, operator may supply repo-filtered model-turn evidence. Genuine no-model installed hook-test proof already closes G19-02; no autonomous turn is authorized. |
| M19-03 — Credential disclosure response | Safety follow-up, not an extra Phase 19 requirement | Parent reported a pre-existing unsafe token-resolver test disclosure; fixture isolation fixed, operator rotation **pending**. | Operator rotates the affected Cursor credential through approved procedures and records non-secret completion evidence. Do not read/repeat credential values. Green token tests are not evidence of rotation. |

G19-01/G19-02 are now closed by real isolated external tools **without production or models**; they were not waived by moving them into this manual section. D19-24 makes deployment follow-through and optional model turns separate from the phase's isolated authored proof. Global credential rotation stays pending, not an invented eighth requirement or LANEB acceptance blocker. Existing explicit opt-outs remain: herdr output_matched unsubscribed, Muse PostToolUseFailure not integrated, healthz/brief degraded-200 race documented. No new opt-out or risk acceptance is granted.

---

## Validation Sign-Off

- [x] All 15 source-declared tasks mapped with their `<automated>` commands and current coverage/evidence limits.
- [x] Sampling-command availability: every task declares automated verification; no three-consecutive-task command gap. Historical per-task execution continuity is unobserved, not fabricated.
- [x] Wave 0 covers all original MISSING driver/test references with executed parent evidence.
- [x] No mapped test runner uses watch mode; collector watch is the tested behavior.
- [ ] Feedback latency < 120s measured — current elapsed suite durations were not supplied; not a new implementation acceptance gate.
- [x] `nyquist_compliant: true` and `wave_0_complete: true` set for isolated phase coverage, with explicit warnings/manual exclusions.
- [x] Real named herdr and actual installed Muse hook-test accepted on parent 41/41, with per-action ten-second observations and pre-execution target guard.
- [ ] Current manual deployment/model approvals — not performed by this run; D19-24 scopes them outside isolated phase acceptance. Credential rotation remains operator-pending.

**Coverage verdict:** accepted for the phase's isolated implementation and seven named IDs on the parent's final green evidence. No current meaningful implementation criterion failed in the supplied final results. This auditor approves only this coverage reconciliation, **not** production cutover, model spending, credential response completion, merge readiness or the parent's final security/review/verifier/phase-close decision.

---

## Validation Audit

**2026-10-10 — Phase19NyquistAudit, artifact-only gate**

| Metric | Result |
|--------|--------|
| Source PLANs / SUMMARYs read | 5 / 5; all preserved |
| Source task rows mapped | 15 / 15 |
| Requirement IDs mapped | 7 / 7: LANEB-01/02/03/04/05/07 and SKILL-06 |
| Gaps found | 7 grouped source-backed gaps |
| Resolved in this audit | 0; no new tests or verification executions |
| Escalated | 7: 3 BLOCKER proof-contract gaps, 4 WARNING coverage/evidence gaps |
| Debug iterations | 0/3 for each gap; no fabricated failing run |
| Manual items | M19-01/M19-02 pending this run; M19-03 operator rotation pending |
| Compliance | `status: validated` means audited; `nyquist_compliant: false`, `wave_0_complete: false` mean **PARTIAL** |

Only this validation artifact was changed. Product/test files, PLAN/SUMMARY/COVERAGE, STATE/ROADMAP/REQUIREMENTS, installed configuration and credentials were not changed by this auditor. Parent alone owns remediation dispatch, all verification, commits and completion decisions. Re-run validation after real behavioral evidence lands; unchanged fixture proof output does not resolve missing drivers.

---

## Validation Audit

**2026-10-10 — Phase19ValidationReconcile, iteration 2, source/evidence-only**

| Metric | Result |
|--------|--------|
| PLANs / SUMMARYs consulted | 5 / 5; source-order 3 tasks per plan preserved |
| Current task coverage | 15 / 15; docs acceptance explicitly static review, not a fabricated behavioral test |
| Requirement coverage | 7 / 7: LANEB-01/02/03/04/05/07, SKILL-06 |
| Original gaps reconciled | 7 / 7 FILLED; 0 current BLOCKER/ESCALATED; 0 SKIP |
| Parent final targeted / types | 85 pass / 0 fail across 6 files; types exit 0 |
| Parent final locks / full suite | 112 pass / 0 fail; 2670 pass / 58 skip / 0 fail across 96 files |
| Parent real runtime / lifecycle | 41/41; own up/proof/down exit 0; zero refused; operator cache paths unchanged; own cleanup complete |
| Parent current static unit syntax | exit 0 on both current unit files; deployment lineage explained, no installation inference |
| Auditor executions / debug iterations | 0 / 0; no tests, scripts, lint, builds, probes, model/service/credential actions, commits or PR operations |
| Remaining warnings | Deadline negative-e2e/clock-jump breadth; accelerated/virtual scheduler environment; decoy-field breadth; status byte oracle; doc automation; historical cadence/latency evidence limits |
| Manual scope | Historical actor receipts preserved; no current operator gate self-approved; optional model turn unperformed; global credential rotation pending outside authored-register counts |
| Compliance | `status: validated`, `nyquist_compliant: true`, `wave_0_complete: true` — coverage accepted; final phase completion remains parent-owned |

Only `/root/src/worktrees/agent-substrate-v13-autonomous/.planning/phases/19-lane-b-collectors/19-VALIDATION.md` changed in this assignment. Original PARTIAL audit/table remains an honest historical record; no fixture-only pass is relabelled as genuine external integration, and no task execution/commit or current manual approval is fabricated. The ledger's final results supersede pre-final aggregate counts, not historical lineage. SPE-10000/SPE-9999 are context links, not issues edited or closed by this auditor.

