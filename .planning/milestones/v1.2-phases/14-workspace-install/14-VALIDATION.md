---
phase: "14"
slug: "workspace-install"
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-07"
refreshed: "2026-10-08T04:08:00Z"
execution_status: parent-current-gates-passed
---

# Phase 14 — Validation Strategy

> Retroactive Nyquist audit of all nine tasks in 14-01, refreshed 2026-10-08 against current sources. Source and tests inspected at current heads; the integration owner executed the final gates and actual runtime proofs. The four remediated findings stay closed; no new gap was found. No tests, builds, formatters, runtime probes, services, or product edits were performed by this report author.

## Scope and provenance

Inputs read in full: `14-01-PLAN.md`, `14-01-SUMMARY.md` (snapshot `6A1D`, mtime 2026-10-08T04:01:41Z), `14-VERIFICATION.md` (refreshed 2026-10-08T04:08:00Z), and `CONTEXT.md`. Requirements are `.planning/REQUIREMENTS.md:41-45,60,75`: INST-01..05 and PROOF-03. Both workflow gates are enabled by the assignment; security uses ASVS L1 and a high blocking threshold. The validation/security workflows, auditor roles, and report templates were read. No authored wave or threat-model block exists in this plan; the numbered task IDs below are reconstructed directly from Tasks 1–9, not invented execution waves.

Source shorthand throughout this report:

- **S** = `/root/src/worktrees/agent-substrate-p14`; current HEAD `a9d699e9e70ee7f112a4fe793572852054eff572` (projector + secret scan + docs; integrates shipped lessons PR17).
- **W** = `/root/src/worktrees/agent-swarm-p14`; current HEAD `60b181464d2c06413690592cdcb0a764ddbd33b9` (installer, runner, lease, tee, handoff gate; integrates final signed-handoff/P12 corrections from shipped PR10; complete tree `11021d0130bbd8288f0e41c3027968e94988c5a5`, identical to tested pre-history-merge `4d2a4cf`).
- **P** = `/root/src/worktrees/agent-substrate-v12/.planning/phases/14-workspace-install`.

These revisions identify the source baseline inspected, not a certification of concurrently modified worktrees or a commit attribution for the parent-executed proofs. Both roots are immutable to this author; no production `:7410` or user checkout was touched.

**Historical remediation revisions:** S `fe946a1`; W `8bbe668`, reported by Main after committing the tested tree with no intervening source changes. They are qualified history (remediation gates, adversarial before/after smokes), not the baseline of this refresh. Current code was re-read at `a9d699e9` / `60b1814`; this refresh reviews current code rather than relabeling old evidence.

**Method limits:** `.py` LSP unavailable (already attempted); textual source inspection used throughout. TS language server was available but not needed. No execution of any kind by this author; all run evidence is parent-reported shared evidence (`local://p14-oct08-integration-evidence.json`) and SUMMARY snapshot `6A1D`, with provenance stated per item.

### Current parent gate evidence — reported 2026-10-08

Main reports the final gates on the current heads with no executable-code or test-content changes after them (only operator recovery documentation and content-identical merge history followed):

- S: **1171 Bun tests, 0 failures, 0 skips, 4489 assertions, 40 files, 7.17s**, via `SUBSTRATE_TEST_PG_URL` on an isolated real Postgres; same-source `bun run check` passed (`artifact://134`). Earlier no-PG/partial runs are not the final gate.
- W: **842 Python tests passed in 107.43s** (`python3 -m pytest -q -o addopts=''`, job `bg_44`), generator up to date, TypeScript contract **1/1 with 6 assertions**, changed lease/handoff/tee/workspace/runner/generator and three bridge tests Ruff clean. Earlier 13 fixture failures and duplicate-definition lint errors were corrected, not waived.
- Current PROOF-03: **51/51 in 13.21s**, `/tmp/p14-proof-1791430676`, isolated `:7513`, server `a9d699e9`, real Postgres `:55432`/GreptimeDB `:54000`. Fifteen private 0600 env files in a 0700 directory outside checkout/workspace; idempotent/spec-identical install; Claude connected at $0 with no model tokens; Grok trust boundary; actual guarded omp own-token event plus operator-tool denial; real runner with only A01's token claimed/completed A05 through its own env-file token (graph `ut-muyzku69-40917665`, claim `03:38:09.293Z`, A05 event `.455Z`, release `.525Z`); A09 brief non-empty naming actor/node. Stub agent CLI; no full multi-agent LLM run.
- Additional current integration proof (separate scope, not PROOF-03): **4/4 in 0.61s** on signed server `a9d699e9` at `:7512`, final merged swarm code, four private own-agent env files in a separate temporary `XDG_CONFIG_HOME` outside the task workspace, every per-surface token variable removed, only A01 `SUBSTRATE_TOKEN` in the coordinator. Late queued dispatch and regenerated redispatch preserve rework; lost committed reply remains one actual signed packet; malformed receiving response preserves healthy context (graph `ut-muyzxvyp-16a9cf4e`, rework `hof_e2228419a716494fa688f822ca362536`, lost reply `hof_f9355d4a780543fabe7884f7bad300b2`).
- Retained (not rerun): **1378-test omp gate** (5 isolated extension + 1373 others) as unchanged-extension evidence; adversarial filesystem smokes (planted backup/temp links leave external victims `UNCHANGED`; 0777 token directory refused without credential writes) as historical source-qualified evidence.
- Delivery state: lessons PR17 merged; handoff PR10 merged at `f2686c7` (5/5, zero comments, CI green). Projector PR18 open at exact `a9d699e9`, review pending. Swarm workspace source prepared at `60b1814`, not yet assessed/shipped. No combined phase or milestone delivery claim.

**Final disposition:** all numbered tasks and requirements covered on current sources; no outstanding phase validation gaps. Intermediate audit checkpoints below document how closure was reached, not current pending work.

### Historical and current evidence, kept separate

| Evidence | Provenance | What it establishes / limits |
|---|---|---|
| 1066 substrate tests, zero failures; TypeScript check clean | `P/14-01-SUMMARY.md` historical section | Superseded baseline with live Postgres; this report did not execute it. Current gate is 1171. |
| 743 Python tests; generator up to date; TypeScript contract 1/1; changed-file Ruff clean | Historical swarm checks in prior SUMMARY/VERIFICATION | Superseded baseline; current gate is 842. The two unrelated E401s in `tests/test_uplift_harness.py` remain outside changed-file Ruff scope. |
| 1378 omp tests (5 isolated extension + 1373 other) | Prior full omp suite | Retained unchanged-extension evidence, explicitly NOT rerun on current heads; never counted as current execution. |
| 51 live checks passed, zero failed (`/tmp/p14-proof-1791408555`) | Directly inspected historical `drive.log:3-79` in prior audit | Superseded runtime proof; current proof is `/tmp/p14-proof-1791430676`. |
| Fresh baseline gates reported by parent during the first audit | Main's 2026-10-07 coordination message | Pre-fix baselines, not sign-off; superseded by remediation and current gates. |
| Three filesystem defects reproduced by parent (backup/temp symlink escapes, 0777 directory) | Main's initial audit message | Retained as failing-before provenance; fixes and parent evidence closed all findings. Current source re-read confirms mitigations intact. |

### PR10-integration coherence checkpoint (new in this refresh)

The final swarm merge integrated shipped signed-handoff/P12 corrections (PR10) into the Phase 14 workspace tree. This author inspected the integration effects on current `60b1814`:

- Integration changes (per shared evidence): three newly merged recovery-test calls migrated to `workspace=fake.workspace`; duplicate auth-refusal test definitions removed; second history merge restored to the exact tested tree after automatic obsolete guard/helper/test reintroduction. Parent `git diff --exit-code 4d2a4cf HEAD` returned 0 with both tree hashes `11021d0130bbd8288f0e41c3027968e94988c5a5` — no source change after the successful 842-test gate.
- Per-agent credential cutover re-verified coherent across all four consumers sharing `swarm/workspace.py:343-389` (`credential`: env file, else own `SUBSTRATE_TOKEN_<SURFACE>`, never runner `SUBSTRATE_TOKEN`): sessions via `child_env` (`:382-389`); leases via `substrate_lease._call`/`has_own_token` (`substrate_lease.py:127-146`); tee via `substrate_tee.py:393` (attributed-agent token, fail-open local + one stderr note); handoffs via `substrate_handoff.py:350-354` (`has_own_token` gate — a sender without its own token sends nothing, so no false-attribution signed packet).
- Spec/runtime guards intact: `workspace.projected_mcp` (`workspace.py:63-79`, exact parsed entry) gates Claude flags, Grok `--trust`, and omp's `SWARM_SUBSTRATE_AGENT` marker (`swarm_run.py:238-260`); unrelated/malformed/operator-token/symlinked configs unlock nothing.
- The separate `4/4` handoff proof on the final merged code (private files only, per-surface vars removed) confirms the cutover survives the PR10 merge. It is recorded independently and never combined with the `51/51` PROOF-03 claim.

## Test Infrastructure

| Property | Value |
|---|---|
| Framework | Bun `bun:test`; Python pytest; subprocess CLI integration tests; deterministic real-runtime smoke |
| Config | `S/package.json:18-24`, `S/tsconfig.json`; `W/pyproject.toml:1-11`; `W/omp/package.json:8-9` |
| Quick substrate command (cwd S) | `bun test packages/projector/src/swarm-workspace.test.ts packages/mcp-server/src/store-lock.test.ts` |
| Quick swarm command (cwd W) | `python3 -m pytest tests/test_install_substrate.py tests/test_agent_token.py tests/test_substrate_lease.py tests/test_substrate_tee.py -q` |
| Quick guard command (cwd W) | `bun test omp/test/guard.test.ts` |
| Full substrate checks (cwd S) | `bun test`; `bun run check` |
| Full swarm checks (cwd W) | `python3 -m pytest -q`; `python3 scripts/build_agents.py --check`; `bun test tests/ts` |
| Full omp checks (cwd W/omp) | `bun run test` (runs isolated extension tests before the rest) |
| Runtime proof | `/tmp/p14-proof.sh`, including `/tmp/p14-omp-provider.ts`, both present and inspected in prior audit; smoke Postgres :55432 and GreptimeDB :54000, free non-production substrate port, installed Claude/Grok/omp |
| Measured runtime | Parent current Python suite: 107.43s; current 51-check proof: 13.21s; current 4-check handoff proof: 0.61s. Historical per-commit latency is not established. |

## Sampling Rate

- Integration owner ran final gates after remediation and the Phase 13 integration prerequisite; this report author ran none mid-flight and none in this refresh.
- Final full substrate/Python suites and generator/TS/Ruff checks are recorded above; focused commands below remain reproducible regression entry points.
- Actual installed-runtime proof passed (current `51/51`); mounting/discovery alone was not used for approval.
- Feedback-latency and per-commit historical sampling cannot be reconstructed from the artifacts. No claim of original Nyquist sampling continuity is made.

## Per-Task Verification Map

Every row corresponds to an actual numbered task in `14-01-PLAN.md`. `N/A` in Wave means no authored wave. Commands are exact runnable commands from the stated cwd; test names and source boundaries are expanded below. File existence was established by reading the files, not inferred from the summary. Status reflects current-source inspection plus parent current gates.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure behavior / source | Test type | Automated command | File exists | Status |
|---|---|---|---|---|---|---|---|---|---|
| 14-01-01 | 01 | N/A | INST-01, INST-02, INST-04 | T-14-01..03, T-14-10 | Projector spec/CLI plus safe recoverable publication; current S `swarm-workspace.ts:60-102` (RUNTIME_FILES/spec), `:235-253` (plan), `:294-498` (snapshot/commit/rollback) | CLI integration | S: `bun test packages/projector/src/swarm-workspace.test.ts` | yes | COVERED: re-read at `a9d699e9`; parent current gate 1171 pass, zero fail |
| 14-01-02 | 01 | N/A | INST-01, INST-02, INST-04 | T-14-01..03, T-14-11 | Sentinel/refusal checks plus eight adversarial staging/rollback regressions at S `swarm-workspace.test.ts:217-392` | CLI integration | S: `bun test packages/projector/src/swarm-workspace.test.ts` | yes | COVERED: parent current substrate gate 1171 pass |
| 14-01-03 | 01 | N/A | INST-02 | T-14-11 | Tracked-file literal detector (`TOKEN_LITERAL`, single-line, env-reference exclusions); excludes projector test sources only from Greptime config scan | Bun regression/security scan | S: `bun test packages/mcp-server/src/store-lock.test.ts` | yes | COVERED: included in parent current full substrate gate |
| 14-01-04 | 01 | N/A | INST-01, INST-03 | T-14-04..07 | Vendored spec; private external token files; shared own-token lookup; current W `workspace.py:63-93` (projected_mcp/env paths), `:140-207` (private reads), `:334-389` (atomic write/credential/child_env) | pytest integration | W: `python3 -m pytest tests/test_install_substrate.py tests/test_agent_token.py -q` | yes | COVERED: re-read at `60b1814`; parent current 842-test suite and private-file live proof |
| 14-01-05 | 01 | N/A | INST-01, INST-02, INST-03, INST-04 | T-14-01..04, T-14-10..11 | Preflight, private directory, staged transaction; W `_install_substrate.py` plan/preflight/install, `build_agents.py --runtimes/--no-substrate` | CLI integration | W: `python3 -m pytest tests/test_install_substrate.py tests/test_install_workspace_cli.py tests/test_install_omp.py -q` | yes | COVERED: parent current suite, generator check and actual install proof |
| 14-01-06 | 01 | N/A | INST-01, INST-03, INST-04, PROOF-03 | T-14-05, T-14-08..09 | Exact config gating/own token; W `workspace.py:63-79`, `swarm_run.py:217-267` (headless_command); actual omp guard + `SWARM_SUBSTRATE_AGENT` marker | pytest + Bun guard + live runtime | W: `python3 -m pytest tests/test_agent_token.py tests/test_omp_dry_run_parity.py tests/test_omp_runtime.py -q`; `bun test omp/test/guard.test.ts`; live command below | yes | COVERED: Python 842, retained omp 1378 (not rerun), current `51/51` actual guarded live execution |
| 14-01-07 | 01 | N/A | INST-03, PROOF-03 | T-14-06..07 | Shared workspace-aware lookup, refusal before network and attributed tee; handoff `has_own_token` gate (`substrate_handoff.py:350-354`) | pytest transport/runner integration | W: `python3 -m pytest tests/test_substrate_lease.py tests/test_substrate_tee.py -q` | yes | COVERED: parent current suite; real A05 claim/ledger/brief proof; separate `4/4` handoff proof on final merged code |
| 14-01-08 | 01 | N/A | INST-01, INST-02, INST-03, INST-04, PROOF-03 | T-14-01..11 | Install/refusal/child/lease/tee plus remediation regressions; PR10 integration deltas inspected (recovery-test workspace args, duplicate-test removal; credential paths untouched; tree-identical to tested `4d2a4cf`) | Combined integration | W: `python3 -m pytest tests/test_install_substrate.py tests/test_agent_token.py tests/test_substrate_lease.py tests/test_substrate_tee.py tests/test_install_omp.py tests/test_install_workspace_cli.py tests/test_omp_dry_run_parity.py tests/test_omp_runtime.py -q` | yes | COVERED: parent current Python 842, current proof 51/51 |
| 14-01-09 | 01 | N/A | INST-05 | T-14-12 | Server/client ownership and declared shared-account limitation in both docs, with integration links | Manual documentation review | No automated semantic doc test; review paths below. `python3 scripts/build_agents.py --check` checks generated artifacts only. | yes | Covered by source review; not an automated behavioral test |

The omp exception is a post-plan integration fix named in SUMMARY and VERIFICATION; it is mapped to Task 6, not silently omitted because it was absent from the original key-file list.

## Requirement-to-Test Evidence

### INST-01 — projection, append/idempotence, runtime visibility

- `S/packages/projector/src/swarm-workspace.test.ts:81-166`: exact tests `gets one substrate entry per runtime file, naming the token's variable and never its value`; `keeps every entry and key it had, and a second run changes nothing`; `--check reports pending additions with exit 1 and writes nothing`; `an identical hand-written entry counts as present, whatever its key order`.
- `W/tests/test_install_substrate.py:58-93`: `test_a_fresh_workspace_gets_an_entry_per_runtime_file`; `test_existing_entries_are_kept_and_a_second_run_changes_nothing`. These drive `build_agents.py` from a checkout copy and compare existing keys/bytes and backups.
- Runtime tests in `W/tests/test_agent_token.py:84-131`: `test_claude_gets_the_workspace_mcp_config_and_the_substrate_tools`, `test_an_unwired_workspace_gets_no_mcp_flags`, `test_grok_clears_folder_trust_for_the_workspace_it_runs_in`, `test_omp_runs_where_the_entry_is_and_its_tools_list_names_only_builtins`, `test_omp_guard_scope_requires_the_projected_own_token_entry` (projected/absent/operator-token/invalid-json; also denies missing own credential).
- `S/packages/projector/package.json:6` points `main` to the implementation. `W/swarm/substrate_mcp.json:1-34` has the matching version-1 literal-variable contract (re-read; identical shape to `--spec`). Cross-repo spec equality and Python-install→Bun `--check` parity are live-harness checks (`/tmp/p14-proof.sh:240-247`); no persistent cross-private/public-repo suite is claimed. Current `51/51` re-exercised them on `a9d699e9`/`60b1814`.

### INST-02 — no generated token literal / native Greptime MCP

- `S/.../swarm-workspace.test.ts:101-117`: `no generated file names Greptime as an MCP server, and no file under the workspace holds a token` scans generated config and backup bytes for the environment sentinel.
- `W/tests/test_install_substrate.py:98-108`: `test_no_greptime_server_anywhere_and_no_token_under_the_workspace` scans workspace outputs and external env files in their respective scopes; token env files intentionally hold the token, whereas workspace files must not.
- `S/packages/mcp-server/src/store-lock.test.ts:95,97-104,226-246,324-361`: `no agent config registers Greptime as an MCP server`; `no tracked file assigns a substrate token a value`; `the token scan catches a value under either name, in an env file or a config`; `the token scan does not fire on a blank, a placeholder, a reference or a short fixture`.
- Detector boundary: assigned `SUBSTRATE_TOKEN*` literals with at least 16 token characters, comments included, single-line separators; environment references and short fixtures excluded. `git ls-files` defines scope and the detector's own test file is excluded from its literal scan. This is not a general-purpose scanner for arbitrary secrets, untracked files, encoded tokens, or arbitrary Authorization strings. Existing operator MCP entries are preserved, not silently sanitized.

### INST-03 — credentials, file boundaries, same identity for child/lease/tee/handoff

- `W/tests/test_install_substrate.py:113-167`: `test_each_agent_gets_a_0600_env_file_outside_the_workspace_and_every_checkout`; `test_a_missing_token_says_what_to_create_and_writes_nothing`; `test_a_file_the_operator_created_is_kept_and_a_world_readable_one_is_refused`; `test_env_files_inside_a_checkout_or_the_workspace_are_refused` (git-checkout/workspace).
- `W/tests/test_agent_token.py:64-81,146-166`: `test_a_session_holds_its_own_token_and_no_other` for Claude/Grok/omp; `test_without_an_env_file_or_its_variable_a_session_gets_no_token_at_all`; `test_without_an_env_file_a_session_gets_its_own_server_side_variable`; `test_the_live_child_gets_only_its_own_token`; `test_dry_run_names_what_is_stripped_and_where_the_token_comes_from_never_its_value`. The “live child” test is a subprocess CLI stub, not an LLM session.
- `W/tests/test_substrate_lease.py:378-419,571-588`: `test_refused_claim_is_not_dispatched`; `test_without_an_env_file_the_agents_own_server_side_variable_is_used`; `test_lease_calls_carry_the_token_in_the_agents_env_file`; `test_an_env_file_others_can_read_is_not_used`; `test_a_refusal_stops_the_session_with_its_tabled_reason[not-holder]` rewrites A05's file to another surface's token and checks the stop transition. The fake transport verifies identity/no-request boundaries; live authority is separate proof.
- `W/tests/test_substrate_tee.py:309-344`: `test_a_row_without_its_agents_token_stays_local` checks zero POSTs and one stderr note; `test_a_row_goes_out_with_its_agents_env_file_token` checks A05 bearer and surface with only A01 in the runner; `test_a_bad_env_file_is_not_bypassed_by_the_surface_variable` checks invalid-file precedence.
- Actual shared lookup re-read at `W/swarm/workspace.py:343-381`: existing valid own env file first; an existing unusable file refuses without trying an override; absent file may use that agent's `SUBSTRATE_TOKEN_<SURFACE>`; never falls back to runner `SUBSTRATE_TOKEN`. Handoff sends nothing without its own token (`substrate_handoff.py:350-354` via `has_own_token`). This is the final CONTEXT decision, superseding the initial file-only wording in Tasks 6–7. Stripping also covers `SUBSTRATE_OPERATOR_TOKENS`. Current `51/51` (A05 claim/event/release under an A01-only runner) and the separate `4/4` (final merged code, per-surface vars removed) both exercise this coherence live.

### INST-04 — refusal and dry run

- `S/.../swarm-workspace.test.ts:169-212`: refusal cases named `unparsable JSON`, `unparsable TOML`, `a differing substrate entry`, `a substrate entry holding a token value`, `an inline mcp_servers table it cannot extend`, `a symlinked config directory`, `a dangling symlink where the file goes`; plus `a runtime with no MCP entry cannot be wired as an executing agent` and `a workspace that does not exist`.
- `W/tests/test_install_substrate.py:172-231`: `test_a_runtime_that_cannot_call_mcp_is_refused_as_an_executor`; `test_refusals_hold_with_every_token_given_and_write_nothing` (bad-json/differing-entry/symlinked-config/home/omp-dir/checkout); `test_dry_run_prints_the_additions_and_the_env_files_and_writes_nothing`; `test_dry_run_with_a_missing_token_still_prints_the_plan_and_exits_2`; `test_no_substrate_installs_the_rest_without_tokens`.
- Source checks: `W/scripts/_install_omp.py:513-541` unsafe destinations; `W/scripts/build_agents.py:336-365` read-only preflight/dry-run before generation; `_install_substrate.py:248-287` runtime/location/config/token refusal. Auxiliary write paths and late failures are covered by the V14-01/V14-04 remediation regressions (below), not by these normal refusal tests alone.

### INST-05 — documentation, not an automated string test

- `S/docs/swarm-workspace.md:55-87`: ownership table, server `/etc/substrate/substrate.env` versus client token file, no operator token for agents, generation guidance, 0600 limit. Link at `S/docs/swarm-correlation.md:37-40`.
- `W/docs/substrate-workspace.md:85-121`: shared lookup, server/installer/client ownership, declared same-account non-isolation. Related links/content: `W/docs/substrate-tee.md:44-56`, `W/docs/substrate-leases.md:30-47,188-190`, `W/README.md:87-99`, `W/AGENTS.md:123`, `W/CLAUDE.md:95-98`.
- Documentation assertions of universal no-symlink writes and conditional flags need to track the fixes for V14-01/V14-03; current prose is not proof of implementation.

### PROOF-03 — real run/claim/ledger/another agent's brief

- Current proof `/tmp/p14-proof-1791430676` (parent-executed on `a9d699e9`/`60b1814`, isolated `:7513`, 13.21s): fresh install with no hand edits; real `orch_plan` and `swarm_run --once` with only A01's token in the runner; A05 session held its own file token; claim granted to `swarm-a05-be` as `A05@r0:ut-muyzku69-40917665`; stored A05 event (`.455Z`); completed/unheld node (release `.525Z`); no lease ID in trail; non-empty A09 brief naming actor/node; no token in workspace or server log. Accepted as reported; bundle metadata read via shared evidence, not re-executed by this author.
- Actual omp guarded execution (not just device discovery): deterministic local provider invokes `xd://mcp__substrate_events_emit`, event reaches the ledger as A05, and `xd://mcp__notion_update_page` remains blocked. `W/omp/src/index.ts:39-55` registers the real `tool_call` handler; `W/omp/src/guard.ts:89-122` checks exact API/marker/identity and applies A01 depth cap first.
- Exact persistent guard tests in `W/omp/test/guard.test.ts:831-872`: `S4 scoped substrate: the registered guard admits own-token calls but not another agent or operator MCP`; `S4 scoped substrate: a token alone, missing token, or mismatched scope never unlocks MCP`; `S4 scoped substrate: namespace lookalikes and mixed device targets remain blocked`; `S4 scoped substrate: A01's depth cap still precedes the own-token exception`.
- Limits: Claude proof is init/connection at $0 followed by unavailable-auth behavior, not a successful paid model invocation; Grok is doctor/discovery with and without trust; omp uses a deterministic local provider, no model service; the swarm's agent CLI is a stub that performs a real MCP call. No full multi-agent LLM DAG, no Grok/omp paid model run, and no installed-workspace gates/rework proof is claimed. Those limits do not substitute for the required ledger/claim/brief assertions, which the current proof does exercise.
- The `4/4` handoff scenarios are explicitly separate-scope evidence and are never added to the `51/51` PROOF-03 count.

## Coverage Gaps and Remediation Closure

Four findings were escalated on the original phase branches. Product owners added fixes/regressions; parent gates and runtime evidence closed all four, and this refresh re-read the mitigations at the current heads. This report author modified no product or test file.

| ID | Original severity / task mapping | Original defect | Final closure evidence |
|---|---|---|---|
| V14-01 / T-14-03 | High; Tasks 1,2,5,8; INST-01, INST-04 | Projector backup/temp and Python predictable temp symlink write escape | CLOSED: pinned no-follow directories and random exclusive stages in both repos (S `swarm-workspace.ts:294-498`, W `workspace.py:244-331`); adversarial regressions (S test `:217-392`, W `test_install_substrate.py:236-393`); parent before/after outside-sentinel smokes (historical, retained); current full gates and install proofs. |
| V14-02 / T-14-04 | Medium security / blocking acceptance; Tasks 4,5,8; INST-03 | Existing token directory left 0777 | CLOSED: W `workspace.py:101-150,205-207` current-user/private-directory validation and installer preflight; parent actual 0777 refusal with no credential write (historical, retained); owner/type/mode regressions; live 0700/0600 proof in current `51/51`. |
| V14-03 / T-14-09 | Medium; Tasks 6,8; INST-01, INST-04 | Claude/Grok flags triggered by config existence without substrate | CLOSED: exact parsed entry at W `workspace.py:63-79`, runner `swarm_run.py:238-260`; unrelated/malformed/operator-token/symlink regressions (`test_agent_token.py:108-141,206-256`); current gates and live Grok/Claude/omp checks. |
| V14-04 / T-14-10 | Medium security / blocking acceptance; Tasks 1,2,5,8; INST-01, INST-04 | Partial installation on late write failure | CLOSED: S `swarm-workspace.ts:403-498` (complete write-set check, own-publication rollback, intervening-edit preservation), W `workspace.py:244-331`, `_install_substrate.py:340-358`; late staging/publication rollback and intervening-operator-edit preservation regressions in passing suites. Recoverable failure semantics, not crash-atomic multi-file durability. |

No new gap was found in this refresh. Had one been found, it would be reported as a gap rather than resolved by a status flip. Bounded limitations, not open phase gaps: cross-repo spec parity is exercised by the actual live harness rather than public CI; historical per-commit sampling is unknown. Existing tokens permit blank lines and disallow group/other permission bits rather than requiring exact owner-bit equality; generated-file tests prove the promised 0600 one-line output. Owner and safe descriptor-path regressions are present and passed within the current suite.

## Wave 0 Requirements

- Existing Bun/pytest infrastructure and all mapped files are present; no framework installation or stub tests are needed.
- Remediation regressions for V14-01..04 are present in existing test files and covered by current parent passing suites (1171 / 842).
- Current parent full gates and actual-runtime proofs are recorded; no missing framework, fixture, regression or phase proof prerequisite remains.

## Manual-Only Verifications and Runtime Limits

| Behavior | Requirement | Why manual / environment bound | Instructions |
|---|---|---|---|
| Correct documented ownership and same-account limit | INST-05 | Prose/operational contract; avoid incidental source-string tests | Review the cited tables and links; preserve the already-declared limitation, do not accept new risks implicitly. |
| Installed runtime actually reaches substrate through guard/transport | INST-01, INST-03, PROOF-03 | Requires installed CLIs and isolated real substrate stores | Run the live command below after fixes; assert actual omp event plus denied operator call, identity/claim/ledger/A09 brief and no token output. |
| Full multi-agent LLM run | Outside this proof's demonstrated scope | No such run exists; optional `--live-llm` only proves one Claude call, not a DAG | Do not relabel the deterministic/stub proof as a full LLM run. No such run is requested of this report author. |

## Exact Parent Gate Commands

Reproduction commands from each stated cwd. Current full-suite, generator, TS contract, changed-file Ruff and runtime results are recorded above; this list does not claim every focused subset was separately executed, nor that this author executed any of them.

**S (`/root/src/worktrees/agent-substrate-p14`):**

```sh
bun test packages/projector/src/swarm-workspace.test.ts packages/mcp-server/src/store-lock.test.ts
bun test
bun run check
```

**W (`/root/src/worktrees/agent-swarm-p14`):**

```sh
python3 -m pytest tests/test_install_substrate.py tests/test_agent_token.py tests/test_substrate_lease.py tests/test_substrate_tee.py tests/test_install_omp.py tests/test_install_workspace_cli.py tests/test_omp_dry_run_parity.py tests/test_omp_runtime.py -q
bun test omp/test/guard.test.ts
python3 -m pytest -q
python3 scripts/build_agents.py --check
bun test tests/ts
ruff check scripts/_install_substrate.py scripts/build_agents.py scripts/swarm_run.py scripts/orch_status.py swarm/workspace.py swarm/substrate_lease.py swarm/substrate_tee.py tests/test_install_substrate.py tests/test_agent_token.py tests/test_substrate_lease.py tests/test_substrate_tee.py tests/test_install_omp.py
```

**W/omp (retained evidence only — not rerun on current heads):**

```sh
bun run test
```

**Live smoke (any cwd, only after smoke dependencies and port availability are confirmed):**

```sh
SERVER_WT=/root/src/worktrees/agent-substrate-p14 SUB_WT=/root/src/worktrees/agent-substrate-p14 SWARM_WT=/root/src/worktrees/agent-swarm-p14 PORT=7513 /tmp/p14-proof.sh
```

The script refuses :7410 and an already-serving selected port; use another confirmed free non-production port rather than stopping a service. Smoke Postgres :55432 and GreptimeDB :54000 must already be available. It starts/stops its own substrate server, creates temporary credentials/workspace, and invokes installed CLIs; only the parent may execute it. `/tmp/p14-omp-provider.ts` is a required external dependency with machine-local imports, not a committed reproducible fixture. The script restores an existing Grok trust file; if none existed, its cleanup does not remove a newly created one (`p14-proof.sh:91-98`). Isolate/restore that operator state explicitly rather than treating the helper as side-effect-free. Never print the generated credentials.

## Validation Sign-Off

- [x] All nine tasks and all six phase requirements mapped to current source/tests or explicit manual review.
- [x] Existing behavioral tests inspected; historical provenance separated from current execution.
- [x] Runtime discovery distinguished from actual guarded execution.
- [x] No watch-mode commands prescribed.
- [x] V14-01..04 remain closed on current heads: mitigations re-read at `a9d699e9`/`60b1814`; current 1171/842 gates and retained adversarial smokes recorded.
- [x] PR10 final integration reviewed: credential/lease/tee/handoff cutover coherent; tree-identical to tested `4d2a4cf`; no source change after the gate.
- [x] `51/51` PROOF-03 and separate-scope `4/4` handoff proof recorded without combining counts; retained 1378 never counted as rerun.
- [x] Current measured runtimes recorded; original per-commit sampling continuity explicitly not reconstructed.
- [x] `nyquist_compliant: true` justified by complete requirement coverage and final verification.

**Approval: approved 2026-10-08 from parent current gates on `a9d699e9`/`60b1814`, re-read mitigations/source tests, current `51/51` live proof plus separate `4/4` handoff proof.**

## Validation Audit 2026-10-08

| Metric | Count |
|---|---:|
| Numbered plan tasks mapped | 9/9 |
| Phase requirements mapped | 6/6 |
| Implementation/coverage findings escalated | 4 (historical, all closed) |
| New gaps found in this refresh | 0 |
| Findings fixed by this report author | 0 |
| Fresh executions by this report author | 0 |
| Current parent gates accepted as reported | 1171 Bun / 0 fail; 842 Python; TS 1/1; Ruff clean |
| Current live assertions accepted as reported | 51/51 PROOF-03 (`/tmp/p14-proof-1791430676`) + separate 4/4 handoff proof |
| Retained (not rerun) evidence | 1378 omp; adversarial filesystem smokes; 12 closed threats |
| Escalated findings closed | 4/4 |
