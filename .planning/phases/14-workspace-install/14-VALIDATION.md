---
phase: "14"
slug: "workspace-install"
status: validated
nyquist_compliant: true
wave_0_complete: true
created: "2026-10-07"
execution_status: parent-post-fix-gates-passed
---

# Phase 14 — Validation Strategy

> Retroactive Nyquist audit of all nine tasks in 14-01. Source and tests inspected; the integration owner executed the final gates and actual runtime proof. All four escalated findings are remediated and verified. No tests, builds, formatters, runtime probes, services, or product edits were performed by this report author.

## Scope and provenance

Inputs read in full: `14-01-PLAN.md`, `14-01-SUMMARY.md`, `14-VERIFICATION.md`, and `CONTEXT.md`. Requirements are `.planning/REQUIREMENTS.md:41-45,60,75`: INST-01..05 and PROOF-03. Both workflow gates are enabled by the assignment; security uses ASVS L1 and a high blocking threshold. The validation/security workflows, auditor roles, and report templates were read. No authored wave or threat-model block exists in this plan; the numbered task IDs below are reconstructed directly from Tasks 1–9, not invented execution waves.

Source shorthand throughout this report:

- **S** = `/root/src/worktrees/agent-substrate-p14`; observed HEAD `02018a69a3891a751140cda075f8c55948761524`.
- **W** = `/root/src/worktrees/agent-swarm-p14`; observed HEAD `e9217744d4a44778861fe517ef531cd89c6fe6a8`.
- **P** = `/root/src/worktrees/agent-substrate-v12/.planning/phases/14-workspace-install`.

These revisions identify the source baseline inspected, not a certification of concurrently modified worktrees or a commit attribution for the historical proof.

**Final tested remediation revisions:** S `fe946a1`; W `8bbe668`, reported by Main after committing the tested tree with no intervening source changes. The full baseline hashes above identify the original phase branches; they are not the final remediation revisions.

### Final parent gate evidence — approved 2026-10-07

All prerequisites, including Phase 13 security integration, are complete. Main reports the final W suite **828 Python tests passing in 105.30s**, generated agents up to date, TypeScript contract **1 test / 6 expectations passing**, and changed-file Ruff clean. Post-workspace-fix omp passed **1378 tests** (5 isolated extension + 1373 others). S passed **1074 Bun tests / 0 failures**, with TypeScript clean (`artifact://1702`). Parent exported-code security smokes confirmed external victims unchanged and unsafe 0777 token-directory refusal without credential writes.

Main reran the actual `/tmp/p14-proof.sh` with S/W roots above on port 7499: **51/51 passed in 7.38s**, `/tmp/p14-proof-1791412718`. This author directly read its `drive.log:3-79`: 15 external files at 0600 in 0700 directory; append/idempotence and cross-repo spec parity; no token/Greptime workspace leakage; Claude connected at $0; Grok trust doctor; **actual omp guarded A05 event plus operator-tool denial**; real runner claim/completion/ledger and non-empty A09 brief; no secret log output. This remains deterministic/stub-assisted proof, **not a full multi-agent LLM run**.

**Final disposition:** V14-01..04 closed for both repos; all numbered tasks and requirements covered; no outstanding phase validation gaps. Intermediate audit checkpoints below document how closure was reached, not current pending work.

### Historical and current evidence, kept separate

| Evidence | Provenance | What it establishes / limits |
|---|---|---|
| 1066 substrate tests, zero failures; TypeScript check clean | `P/14-01-SUMMARY.md:54-55` | Historical full suite with live Postgres; this report did not execute it. |
| 743 Python tests; generator up to date; TypeScript contract 1/1; changed-file Ruff clean | `P/14-01-SUMMARY.md:56`; `P/14-VERIFICATION.md:31-32` | Historical swarm checks. The two unrelated E401s in `tests/test_uplift_harness.py` are explicitly outside changed-file Ruff scope. |
| 1378 omp tests (5 isolated extension + 1373 other) | `P/14-01-SUMMARY.md:56`; `P/14-VERIFICATION.md:33` | Historical full omp suite. Must preserve the separate-process extension-test invocation. |
| 51 live checks passed, zero failed | Directly inspected `/tmp/p14-proof-1791408555/drive.log:3-79`; proof logic `/tmp/p14-proof.sh` | Strong historical install/runtime/ledger proof, not a fresh execution or full LLM run. |
| Fresh baseline gates reported by parent during this audit | Main's 2026-10-07 coordination message | Parent reports 1066 Bun/0 failures + tsc clean; 743 Python + generator + TS contract 1; changed-file Ruff PASS. No new omp total was reported in that message. These are pre-fix baselines, not post-fix sign-off. |
| Three filesystem defects reproduced by parent | Main's initial audit message | Projector backup symlink and Python temp symlink overwrote outside sentinels; existing token directory remained 0777. Retained as failing-before provenance; fixes and final parent evidence now close all findings. |

### Remediation checkpoint — substrate projector

Main reports fresh substrate post-fix gates: **1074 Bun tests passing, 0 failures, 3786 expectations across 38 files; TypeScript clean**, evidence `artifact://1702`. Main's actual exported-projector smoke now refuses the planted backup symlink, preserves the external victim as `UNCHANGED`, and preserves the config (before the fix the external victim was overwritten with `{}`). No production Postgres/Greptime service was touched.

This author inspected the updated implementation and all eight new regressions, without executing checks. `S/packages/projector/src/swarm-workspace.ts:294-313,339-395` uses regular-file/no-follow snapshots, pinned directory descriptors and exclusive random staging; `:403-450` prepares/checks the complete write set before publication; `:452-498` rolls back only its own unchanged publications, preserves external edits, and reports incomplete recovery. This is a recoverable transaction, **not crash-atomic multi-file durability**.

New exact tests in `S/packages/projector/src/swarm-workspace.test.ts:217-392`:

- `refuses a planted backup symlink without touching its victim or earlier files`
- `ignores old predictable temp links and refuses a collision at its exclusive staging path`
- `rechecks final and parent symlinks introduced after planning`
- `a late staging write failure leaves all configs and existing backups untouched`
- `a later commit failure rolls back configs, replaced backups, and their modes`
- `a later commit failure removes only files and directories it created`
- `rollback preserves an intervening external config edit and explicitly reports the conflict`
- `a directory replaced inside a commit syscall cannot redirect writes through its symlink`

At this intermediate checkpoint, V14-01/V14-04 were closed for S while W awaited integration. Final parent evidence above now closes both portions. Baseline discovery line references below identify the original source, superseded by the remediation citations here.

### Remediation checkpoint — Python source review

Main's actual exported-code smoke confirmed the Python predictable temporary symlink left the outside victim `UNCHANGED`, and a pre-existing 0777 token directory was refused without credentials written. The post-workspace-fix omp suite passed **1378 tests**. The then-pending Phase 13 prerequisite, full Python gates and 51-check proof are now complete as recorded above. A fixer-reported self-run of 33 tests is **not used as parent gate evidence**.

Source and added behavioral assertions were inspected, not executed by this author:

- `W/swarm/workspace.py:101-150,161-207` now uses pinned no-follow directory/file reads and enforces a private current-user token directory during preflight and reads. `:210-229,244-331` uses random exclusive 0600 staging and a bounded recoverable transaction; it does not claim a crash journal or an atomic multi-file reader view.
- `W/scripts/_install_substrate.py:276-285,340-358` validates the credential directory before planning and stages all changed token/config/backup contents before committing.
- `W/swarm/workspace.py:63-79` parses exact projected JSON/TOML through safe file reads; `W/scripts/swarm_run.py:238-260` uses this check for Grok trust, Claude flags and omp's own-credential scope marker.
- New tests `test_atomic_config_write_ignores_predictable_and_exclusive_staging_symlink_collisions`, `test_atomic_config_write_rechecks_links_after_staging`, `test_private_directory_refusal_precedes_tokens_preflight_and_dry_run`, `test_later_publish_failure_rolls_back_tokens_configs_and_backups`, and `test_failed_install_preserves_intervening_operator_config_edits` are present at `W/tests/test_install_substrate.py:236-393`.
- Runtime/token regressions at `W/tests/test_agent_token.py:108-141,206-256` are `test_grok_does_not_auto_trust_unrelated_malformed_or_nonprojected_configs`, `test_grok_trust_accepts_an_exact_projection_among_other_settings`, `test_projected_config_through_a_symlink_does_not_unlock_trust`, `test_valid_0600_token_in_nonprivate_directory_refuses_without_environment_fallback`, `test_token_staging_is_private_before_any_byte_and_replaces_atomically`, and `test_claude_does_not_unlock_substrate_flags_for_unrelated_or_invalid_configs`.

The W mitigations and regressions below are now parent-verified by the final 828-test suite and 51-check proof. Historical lstat/read-race and missing directory-owner-test caveats are superseded by descriptor-based reads and the added owner regression; exact owner-bit equality and blank-line semantics remain bounded as stated.

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
| Runtime proof | `/tmp/p14-proof.sh`, including `/tmp/p14-omp-provider.ts`, both present and inspected; smoke Postgres :55432 and GreptimeDB :54000, free non-production substrate port, installed Claude/Grok/omp |
| Measured runtime | Parent final Python suite: 105.30s; actual 51-check proof: 7.38s. Historical per-commit latency is not established. |

## Sampling Rate

- Integration owner ran final gates after remediation and the Phase 13 integration prerequisite; this report author ran none mid-flight.
- Final full substrate/Python/omp suites and generator/TS/Ruff checks are recorded above; focused commands below remain reproducible regression entry points.
- Actual installed-runtime proof passed; mounting/discovery alone was not used for approval.
- Feedback-latency and per-commit historical sampling cannot be reconstructed from the artifacts. No claim of original Nyquist sampling continuity is made.

## Per-Task Verification Map

Every row corresponds to an actual numbered task in `14-01-PLAN.md`. `N/A` in Wave means no authored wave. Commands are exact runnable commands from the stated cwd; test names and source boundaries are expanded below. File existence was established by reading the files, not inferred from the summary.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure behavior / source | Test type | Automated command | File exists | Status |
|---|---|---|---|---|---|---|---|---|---|
| 14-01-01 | 01 | N/A | INST-01, INST-02, INST-04 | T-14-01..03, T-14-10 | Projector spec/CLI plus safe recoverable publication; updated S `swarm-workspace.ts:294-498` | CLI integration | S: `bun test packages/projector/src/swarm-workspace.test.ts` | yes | COVERED: S portions of V14-01/V14-04 closed by parent post-fix gates and actual smoke |
| 14-01-02 | 01 | N/A | INST-01, INST-02, INST-04 | T-14-01..03, T-14-11 | Sentinel/refusal checks plus eight adversarial staging/rollback regressions at S `swarm-workspace.test.ts:217-392` | CLI integration | S: `bun test packages/projector/src/swarm-workspace.test.ts` | yes | COVERED: parent full substrate gate 1074 pass, zero fail |
| 14-01-03 | 01 | N/A | INST-02 | T-14-11 | Tracked-file literal detector; excludes projector test sources only from Greptime config scan | Bun regression/security scan | S: `bun test packages/mcp-server/src/store-lock.test.ts` | yes | COVERED: included in parent post-fix full substrate gate |
| 14-01-04 | 01 | N/A | INST-01, INST-03 | T-14-04..07 | Vendored spec; private external token files; shared own-token lookup; updated W `workspace.py:63-331` | pytest integration | W: `python3 -m pytest tests/test_install_substrate.py tests/test_agent_token.py -q` | yes | COVERED: final 828-test Python suite and private-file live proof |
| 14-01-05 | 01 | N/A | INST-01, INST-02, INST-03, INST-04 | T-14-01..04, T-14-10..11 | Preflight, private directory, staged transaction; W `_install_substrate.py:263-368`, `build_agents.py:336-407` | CLI integration | W: `python3 -m pytest tests/test_install_substrate.py tests/test_install_workspace_cli.py tests/test_install_omp.py -q` | yes | COVERED: final parent suite, generator check and actual install proof |
| 14-01-06 | 01 | N/A | INST-01, INST-03, INST-04, PROOF-03 | T-14-05, T-14-08..09 | Exact config gating/own token; W `workspace.py:63-79`, `swarm_run.py:230-263`; actual omp guard | pytest + Bun guard + live runtime | W: `python3 -m pytest tests/test_agent_token.py tests/test_omp_dry_run_parity.py tests/test_omp_runtime.py -q`; `bun test omp/test/guard.test.ts`; live command below | yes | COVERED: Python 828, omp 1378, actual guarded live execution |
| 14-01-07 | 01 | N/A | INST-03, PROOF-03 | T-14-06..07 | Shared workspace-aware lookup, refusal before network and attributed tee | pytest transport/runner integration | W: `python3 -m pytest tests/test_substrate_lease.py tests/test_substrate_tee.py -q` | yes | COVERED: final Python suite and real A05 claim/ledger/brief proof |
| 14-01-08 | 01 | N/A | INST-01, INST-02, INST-03, INST-04, PROOF-03 | T-14-01..11 | Install/refusal/child/lease/tee plus remediation regressions | Combined integration | W: `python3 -m pytest tests/test_install_substrate.py tests/test_agent_token.py tests/test_substrate_lease.py tests/test_substrate_tee.py tests/test_install_omp.py tests/test_install_workspace_cli.py tests/test_omp_dry_run_parity.py tests/test_omp_runtime.py -q` | yes | COVERED: final parent Python 828, omp 1378, proof 51/51 |
| 14-01-09 | 01 | N/A | INST-05 | T-14-12 | Server/client ownership and declared shared-account limitation in both docs, with integration links | Manual documentation review | No automated semantic doc test; review paths below. `python3 scripts/build_agents.py --check` checks generated artifacts only. | yes | Covered by source review; not an automated behavioral test |

The omp exception is a post-plan integration fix named in SUMMARY:72 and VERIFICATION:34; it is mapped to Task 6, not silently omitted because it was absent from the original key-file list.

## Requirement-to-Test Evidence

### INST-01 — projection, append/idempotence, runtime visibility

- `S/packages/projector/src/swarm-workspace.test.ts:81-166`: exact tests `gets one substrate entry per runtime file, naming the token's variable and never its value`; `keeps every entry and key it had, and a second run changes nothing`; `--check reports pending additions with exit 1 and writes nothing`; `an identical hand-written entry counts as present, whatever its key order`.
- `W/tests/test_install_substrate.py:58-93`: `test_a_fresh_workspace_gets_an_entry_per_runtime_file`; `test_existing_entries_are_kept_and_a_second_run_changes_nothing`. These drive `build_agents.py` from a checkout copy and compare existing keys/bytes and backups.
- Runtime tests in `W/tests/test_agent_token.py:84-131`: `test_claude_gets_the_workspace_mcp_config_and_the_substrate_tools`, `test_an_unwired_workspace_gets_no_mcp_flags`, `test_grok_clears_folder_trust_for_the_workspace_it_runs_in`, `test_omp_runs_where_the_entry_is_and_its_tools_list_names_only_builtins`, `test_omp_guard_scope_requires_the_projected_own_token_entry` (projected/absent/operator-token/invalid-json; also denies missing own credential).
- `S/packages/projector/package.json:6` points `main` to the implementation. `W/swarm/substrate_mcp.json:1-34` has the matching version-1 literal-variable contract. Cross-repo spec equality and Python-install→Bun `--check` parity are historical proof checks, `/tmp/p14-proof.sh:240-247` and `drive.log:26-27`; no persistent cross-private/public-repo suite is claimed.

### INST-02 — no generated token literal / native Greptime MCP

- `S/.../swarm-workspace.test.ts:101-117`: `no generated file names Greptime as an MCP server, and no file under the workspace holds a token` scans generated config and backup bytes for the environment sentinel.
- `W/tests/test_install_substrate.py:98-108`: `test_no_greptime_server_anywhere_and_no_token_under_the_workspace` scans workspace outputs and external env files in their respective scopes; token env files intentionally hold the token, whereas workspace files must not.
- `S/packages/mcp-server/src/store-lock.test.ts:95,97-104,226-246,324-361`: `no agent config registers Greptime as an MCP server`; `no tracked file assigns a substrate token a value`; `the token scan catches a value under either name, in an env file or a config`; `the token scan does not fire on a blank, a placeholder, a reference or a short fixture`.
- Detector boundary: assigned `SUBSTRATE_TOKEN*` literals with at least 16 token characters, comments included, single-line separators; environment references and short fixtures excluded. `git ls-files` defines scope and the detector's own test file is excluded from its literal scan. This is not a general-purpose scanner for arbitrary secrets, untracked files, encoded tokens, or arbitrary Authorization strings. Existing operator MCP entries are preserved, not silently sanitized.

### INST-03 — credentials, file boundaries, same identity for child/lease/tee

- `W/tests/test_install_substrate.py:113-167`: `test_each_agent_gets_a_0600_env_file_outside_the_workspace_and_every_checkout`; `test_a_missing_token_says_what_to_create_and_writes_nothing`; `test_a_file_the_operator_created_is_kept_and_a_world_readable_one_is_refused`; `test_env_files_inside_a_checkout_or_the_workspace_are_refused` (git-checkout/workspace). Fresh 0700 coverage does not cover a pre-existing directory's permissions.
- `W/tests/test_agent_token.py:64-81,146-166`: `test_a_session_holds_its_own_token_and_no_other` for Claude/Grok/omp; `test_without_an_env_file_or_its_variable_a_session_gets_no_token_at_all`; `test_without_an_env_file_a_session_gets_its_own_server_side_variable`; `test_the_live_child_gets_only_its_own_token`; `test_dry_run_names_what_is_stripped_and_where_the_token_comes_from_never_its_value`. The “live child” test is a subprocess CLI stub, not an LLM session.
- `W/tests/test_substrate_lease.py:378-419,571-588`: `test_refused_claim_is_not_dispatched`; `test_without_an_env_file_the_agents_own_server_side_variable_is_used`; `test_lease_calls_carry_the_token_in_the_agents_env_file`; `test_an_env_file_others_can_read_is_not_used`; `test_a_refusal_stops_the_session_with_its_tabled_reason[not-holder]` rewrites A05's file to another surface's token and checks the stop transition. The fake transport verifies identity/no-request boundaries; live authority is separate proof.
- `W/tests/test_substrate_tee.py:309-344`: `test_a_row_without_its_agents_token_stays_local` checks zero POSTs and one stderr note; `test_a_row_goes_out_with_its_agents_env_file_token` checks A05 bearer and surface with only A01 in the runner; `test_a_bad_env_file_is_not_bypassed_by_the_surface_variable` checks invalid-file precedence.
- Actual shared lookup `W/swarm/workspace.py:115-157`: existing valid own env file first; an existing unusable file refuses without trying an override; absent file may use that agent's `SUBSTRATE_TOKEN_<SURFACE>`; never falls back to runner `SUBSTRATE_TOKEN`. This is the final CONTEXT:98 decision, superseding the initial file-only wording in Tasks 6–7. Stripping also covers `SUBSTRATE_OPERATOR_TOKENS`.

### INST-04 — refusal and dry run

- `S/.../swarm-workspace.test.ts:169-212`: refusal cases named `unparsable JSON`, `unparsable TOML`, `a differing substrate entry`, `a substrate entry holding a token value`, `an inline mcp_servers table it cannot extend`, `a symlinked config directory`, `a dangling symlink where the file goes`; plus `a runtime with no MCP entry cannot be wired as an executing agent` and `a workspace that does not exist`.
- `W/tests/test_install_substrate.py:172-231`: `test_a_runtime_that_cannot_call_mcp_is_refused_as_an_executor`; `test_refusals_hold_with_every_token_given_and_write_nothing` (bad-json/differing-entry/symlinked-config/home/omp-dir/checkout); `test_dry_run_prints_the_additions_and_the_env_files_and_writes_nothing`; `test_dry_run_with_a_missing_token_still_prints_the_plan_and_exits_2`; `test_no_substrate_installs_the_rest_without_tokens`.
- Source checks: `W/scripts/_install_omp.py:513-541` unsafe destinations; `W/scripts/build_agents.py:336-365` read-only preflight/dry-run before generation; `_install_substrate.py:248-287` runtime/location/config/token refusal. Auxiliary write paths and late failures are not covered by these normal refusal tests (V14-01/V14-04).

### INST-05 — documentation, not an automated string test

- `S/docs/swarm-workspace.md:55-87`: ownership table, server `/etc/substrate/substrate.env` versus client token file, no operator token for agents, generation guidance, 0600 limit. Link at `S/docs/swarm-correlation.md:37-40`.
- `W/docs/substrate-workspace.md:85-121`: shared lookup, server/installer/client ownership, declared same-account non-isolation. Related links/content: `W/docs/substrate-tee.md:44-56`, `W/docs/substrate-leases.md:30-47,188-190`, `W/README.md:87-99`, `W/AGENTS.md:123`, `W/CLAUDE.md:95-98`.
- Documentation assertions of universal no-symlink writes and conditional flags need to track the fixes for V14-01/V14-03; current prose is not proof of implementation.

### PROOF-03 — real run/claim/ledger/another agent's brief

- Direct historical output `/tmp/p14-proof-1791408555/drive.log:48-77` records only A01 in runner env; real `orch_plan` and `swarm_run --once`; one A05 child with its own file token; granted claim as `swarm-a05-be`, session `A05@r0:<graph>`; stored event; completed/unheld node; no lease ID in trail; non-empty A09 brief naming A05 and `P14-be`; no token in workspace or server log.
- `drive.log:42-45` and `/tmp/p14-proof.sh:349-369` additionally prove **actual omp guarded execution**, not just device discovery: deterministic local provider invokes `xd://mcp__substrate_events_emit`, event reaches the ledger as A05, and `xd://mcp__notion_update_page` remains blocked. `W/omp/src/index.ts:39-55` registers the real `tool_call` handler; `W/omp/src/guard.ts:89-122` checks exact API/marker/identity and applies A01 depth cap first.
- Exact persistent guard tests in `W/omp/test/guard.test.ts:831-872`: `S4 scoped substrate: the registered guard admits own-token calls but not another agent or operator MCP`; `S4 scoped substrate: a token alone, missing token, or mismatched scope never unlocks MCP`; `S4 scoped substrate: namespace lookalikes and mixed device targets remain blocked`; `S4 scoped substrate: A01's depth cap still precedes the own-token exception`.
- Limits: Claude proof is init/connection at $0 followed by unavailable-auth behavior, not a successful paid model invocation; Grok is doctor/discovery with and without trust; omp uses a deterministic local provider, no model service; the swarm's agent CLI is a stub that performs a real MCP call. No full multi-agent LLM DAG, no Grok/omp paid model run, and no installed-workspace gates/rework proof is claimed. Those limits do not substitute for the required ledger/claim/brief assertions, which the historical proof does exercise.

## Coverage Gaps and Remediation Closure

Four findings were escalated on the original phase branches. Product owners added fixes/regressions; parent gates and runtime evidence now close all four. This report author modified no product or test file.

| ID | Original severity / task mapping | Original defect | Final closure evidence |
|---|---|---|---|
| V14-01 / T-14-03 | High; Tasks 1,2,5,8; INST-01, INST-04 | Projector backup/temp and Python predictable temp symlink write escape | CLOSED: pinned no-follow directories and random exclusive stages in both repos; adversarial regressions; parent before/after outside-sentinel smokes; final full gates and install proof. |
| V14-02 / T-14-04 | Medium security / blocking acceptance; Tasks 4,5,8; INST-03 | Existing token directory left 0777 | CLOSED: W `workspace.py:101-150,205-207` current-user/private-directory validation and installer preflight; parent actual 0777 refusal with no credential write; owner/type/mode regressions; live 0700/0600 proof. |
| V14-03 / T-14-09 | Medium; Tasks 6,8; INST-01, INST-04 | Claude/Grok flags triggered by config existence without substrate | CLOSED: exact parsed entry at W `workspace.py:63-79`, runner `:238-260`; unrelated/malformed/operator-token/symlink regressions; final Python/omp gates and live Grok/Claude/omp checks. |
| V14-04 / T-14-10 | Medium security / blocking acceptance; Tasks 1,2,5,8; INST-01, INST-04 | Partial installation on late write failure | CLOSED: S `swarm-workspace.ts:294-498`, W `workspace.py:244-331`, `_install_substrate.py:340-358`; late staging/publication rollback and intervening-operator-edit preservation regressions in final passing suites. Recoverable failure semantics, not crash-atomic multi-file durability. |

Bounded limitations, not open phase gaps: cross-repo spec parity is exercised by the actual live harness rather than public CI; historical per-commit sampling is unknown. Existing tokens permit blank lines and disallow group/other permission bits rather than requiring exact owner-bit equality; generated-file tests prove the promised 0600 one-line output. Owner and safe descriptor-path regressions are present and passed within the final suite.

## Wave 0 Requirements

- Existing Bun/pytest infrastructure and all mapped files are present; no framework installation or stub tests are needed.
- Remediation regressions for V14-01..04 are present in existing test files and covered by final parent passing suites.
- Fresh parent full gates and actual-runtime proof are recorded; no missing framework, fixture, regression or phase proof prerequisite remains.

## Manual-Only Verifications and Runtime Limits

| Behavior | Requirement | Why manual / environment bound | Instructions |
|---|---|---|---|
| Correct documented ownership and same-account limit | INST-05 | Prose/operational contract; avoid incidental source-string tests | Review the cited tables and links after fixes; preserve the already-declared limitation, do not accept new risks implicitly. |
| Installed runtime actually reaches substrate through guard/transport | INST-01, INST-03, PROOF-03 | Requires installed CLIs and isolated real substrate stores | Run the live command below after fixes; assert actual omp event plus denied operator call, identity/claim/ledger/A09 brief and no token output. |
| Full multi-agent LLM run | Outside this proof's demonstrated scope | No historical such run; optional `--live-llm` only proves one Claude call, not a DAG | Do not relabel the deterministic/stub proof as a full LLM run. No such run is requested of this report author. |

## Exact Parent Gate Commands

Reproduction commands from each stated cwd. Final full-suite, generator, TS contract, changed-file Ruff and runtime results are recorded above; this list does not claim every focused subset was separately executed.

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

**W/omp:**

```sh
bun run test
```

**Live smoke (any cwd, only after smoke dependencies and port availability are confirmed):**

```sh
SERVER_WT=/root/src/worktrees/agent-substrate-p14 SUB_WT=/root/src/worktrees/agent-substrate-p14 SWARM_WT=/root/src/worktrees/agent-swarm-p14 PORT=7499 /tmp/p14-proof.sh
```

The script refuses :7410 and an already-serving selected port; use another confirmed free non-production port rather than stopping a service. Smoke Postgres :55432 and GreptimeDB :54000 must already be available. It starts/stops its own substrate server, creates temporary credentials/workspace, and invokes installed CLIs; only the parent may execute it. `/tmp/p14-omp-provider.ts` is a required external dependency with machine-local imports, not a committed reproducible fixture. The script restores an existing Grok trust file; if none existed, its cleanup does not remove a newly created one (`p14-proof.sh:91-98`). Isolate/restore that operator state explicitly rather than treating the historical helper as side-effect-free. Never print the generated `server-tokens.env` or agent env files.

## Validation Sign-Off

- [x] All nine tasks and all six phase requirements mapped to source/tests or explicit manual review.
- [x] Existing behavioral tests inspected; historical provenance separated from fresh execution.
- [x] Runtime discovery distinguished from actual guarded execution.
- [x] No watch-mode commands prescribed.
- [x] Substrate portions of V14-01/V14-04 closed: updated source/tests inspected; parent 1074-test/tsc gates and actual backup-symlink smoke recorded.
- [x] V14-01..04 resolved with behavioral regression evidence in both repos.
- [x] Fresh parent post-fix gates and runtime smoke complete.
- [x] Final measured runtimes recorded; original per-commit sampling continuity explicitly not reconstructed.
- [x] `nyquist_compliant: true` justified by complete requirement coverage and final verification.

**Approval: approved 2026-10-07 from parent final gates, inspected remediation/source tests and directly inspected 51/51 live proof.**

## Validation Audit 2026-10-07

| Metric | Count |
|---|---:|
| Numbered plan tasks mapped | 9/9 |
| Phase requirements mapped | 6/6 |
| Implementation/coverage findings escalated | 4 |
| Findings fixed by this report author | 0 |
| Fresh executions by this report author | 0 |
| Historical live assertions directly inspected | 51 passing, 0 failing |
| Final live assertions directly inspected | 51 passing, 0 failing (`/tmp/p14-proof-1791412718`) |
| Escalated findings closed by product owners and parent verification | 4/4 |
