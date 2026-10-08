---
phase: "14"
slug: "workspace-install"
status: verified
threats_open: 0
asvs_level: 1
block_on: high
register_authored_at_plan_time: false
created: "2026-10-07"
audit_verdict: SECURED
execution_status: parent-post-fix-gates-passed
---

# Phase 14 — Security

> Retroactive STRIDE register for workspace projection/install and own-agent credential delivery. All four discovered in-scope findings are fixed and verified; zero blocking or non-blocking open threats remain. Parent executed final gates and runtime proof. This report author performed source/artifact review only, no product edits or executions. No risks are accepted by this report.

## Scope, authority, and provenance

The full `14-01-PLAN.md`, `14-01-SUMMARY.md`, `14-VERIFICATION.md`, and `CONTEXT.md` were read. Neither the plan nor summary contains an authored formal threat register; this report constructs one from the actual implementation, including the later omp guard fix. Both security and Nyquist gates are enabled by the assignment; ASVS L1 checks presence of mitigation at the cited code boundary. A closed L1 entry below is not a certification of exhaustive race resistance, process isolation, remote-provider behavior, or unexecuted tests.

Source shorthand:

- **S**: `/root/src/worktrees/agent-substrate-p14`, observed HEAD `02018a69a3891a751140cda075f8c55948761524`.
- **W**: `/root/src/worktrees/agent-swarm-p14`, observed HEAD `e9217744d4a44778861fe517ef531cd89c6fe6a8`.
- **P**: `/root/src/worktrees/agent-substrate-v12/.planning/phases/14-workspace-install`.

Original full hashes identify the inspected phase branches. **Final tested remediation revisions are S `fe946a1` and W `8bbe668`**, reported by Main after committing the tested tree with no intervening source changes. Baseline discovery references are retained separately from updated mitigation references.

Historical proof provenance: `P/14-01-SUMMARY.md:54-67` reports 1066 substrate tests, 743 Python tests, 1378 omp tests, and 51 live checks; `P/14-VERIFICATION.md:15-38` records their bounded interpretation. The report author directly read `/tmp/p14-proof-1791408555/drive.log:3-79` (51 passed/0 failed), `/tmp/p14-proof.sh`, and the deterministic `/tmp/p14-omp-provider.ts`. The historical live script uses real smoke Postgres/GreptimeDB and real MCP calls, but a stub agent CLI for the swarm task. It does not run a full multi-agent LLM DAG or paid Grok/omp generation.

At the initial checkpoint Main reported passing baseline suites, then reproduced outside-sentinel overwrite through the projector backup symlink and Python temporary symlink, plus a token directory left 0777. Those failures established the need for remediation; the baseline passes were not used to waive them. Final closure evidence follows.

### Final parent security gate — verified 2026-10-07

After Phase 13 security integration, Main reports W **828 Python tests passing in 105.30s**, generated agents up to date, TS contract **1 test / 6 expectations passing**, and changed-file Ruff clean. Post-workspace-fix omp passed **1378 tests** (5 isolated extension + 1373 other tests). S passed **1074 Bun tests / 0 failures** with TypeScript clean (`artifact://1702`). Parent actual security smokes preserve outside victims and refuse a 0777 token directory without credential writes.

Main's final actual `/tmp/p14-proof.sh`, using S/W roots and port 7499, passed **51/51 in 7.38s** at `/tmp/p14-proof-1791412718`. This author directly inspected `drive.log:3-79`: private token files, idempotence/spec parity, Claude connected at $0, Grok trust doctor, **real omp guarded own-identity event and denied operator call**, real runner own-token claim/completion/ledger/non-empty A09 brief, and no secret workspace/log output. No full multi-agent LLM run is claimed.

**SEC14-01..04 / T-14-03,04,09,10 are closed in both repositories.** Intermediate checkpoints below are retained as audit history, not outstanding work. The requirement's same-account isolation limitation remains explicit; it is not a new accepted risk or a claim of technical isolation.

### Remediation evidence — substrate projector

Main reports **1074 Bun tests passing, 0 failures, 3786 expectations across 38 files; TypeScript clean** on S, evidence `artifact://1702`. Its actual exported-projector smoke rejects the planted backup symlink, keeps the outside victim `UNCHANGED` and the config unchanged; the pre-fix smoke overwrote that victim with `{}`. No production Postgres/Greptime service was touched.

Updated source and all eight added regressions were inspected by this author, without running gates. `S/packages/projector/src/swarm-workspace.ts:294-313` checks regular-file identity with no-follow reads; `:339-395` pins destination directories and creates randomized exclusive/no-follow staging; `:403-450` stages/checks the entire write set and publishes; `:452-498` restores its own unchanged files/backups on recoverable failure, preserves intervening external changes and explicitly reports recovery conflicts. Crash-atomic multi-file durability is not claimed.

Existing-test command remains `bun test packages/projector/src/swarm-workspace.test.ts`. Added tests at `:217-392` are exactly `refuses a planted backup symlink without touching its victim or earlier files`; `ignores old predictable temp links and refuses a collision at its exclusive staging path`; `rechecks final and parent symlinks introduced after planning`; `a late staging write failure leaves all configs and existing backups untouched`; `a later commit failure rolls back configs, replaced backups, and their modes`; `a later commit failure removes only files and directories it created`; `rollback preserves an intervening external config edit and explicitly reports the conflict`; `a directory replaced inside a commit syscall cannot redirect writes through its symlink`.

At this intermediate checkpoint S portions of SEC14-01/SEC14-04 were closed and W awaited integration. Final parent evidence above now closes both portions. Original S discovery references below describe the pre-fix baseline, not the fixed implementation.

### Remediation evidence — Python source review

Main's actual exported-code smoke confirmed the Python temporary symlink leaves the outside victim `UNCHANGED`; a pre-existing 0777 token directory is refused with no credential written. Main's post-workspace-fix omp suite passed **1378 tests**. The full Python and 51-check proof prerequisites are now complete as recorded above. The fixer's self-run of 33 tests is **not accepted as parent gate evidence**.

Inspected W mitigations: `workspace.py:101-150,161-207` pins no-follow directory/file descriptors and checks current-user/private token directory during preflight/read; `:210-229,244-331` creates random exclusive/no-follow 0600 stages and rolls back its unchanged publications while preserving intervening operator edits. `_install_substrate.py:276-285,340-358` preflights directory safety and stages all token/config/backup writes before commit. `workspace.py:63-79` verifies exact parsed projected JSON/TOML, and `swarm_run.py:238-260` gates Grok trust/Claude flags/omp marker with it. Multi-file crash atomicity is not claimed.

New behavioral tests inspected at `tests/test_install_substrate.py:236-393`: `test_atomic_config_write_ignores_predictable_and_exclusive_staging_symlink_collisions`; `test_atomic_config_write_rechecks_links_after_staging`; `test_private_directory_refusal_precedes_tokens_preflight_and_dry_run`; `test_later_publish_failure_rolls_back_tokens_configs_and_backups`; `test_failed_install_preserves_intervening_operator_config_edits`. At `tests/test_agent_token.py:108-141,206-256`: `test_grok_does_not_auto_trust_unrelated_malformed_or_nonprojected_configs`; `test_grok_trust_accepts_an_exact_projection_among_other_settings`; `test_projected_config_through_a_symlink_does_not_unlock_trust`; `test_valid_0600_token_in_nonprivate_directory_refuses_without_environment_fallback`; `test_token_staging_is_private_before_any_byte_and_replaces_atomically`; `test_claude_does_not_unlock_substrate_flags_for_unrelated_or_invalid_configs`.

All four W mitigations and regression assertions were inspected and are now covered by parent final full Python/runtime gates. The original baseline evidence remains for traceability; the current register is closed. Descriptor-based reads supersede the baseline lstat/read design. This is ASVS L1 source verification plus concrete regression/runtime evidence, not an exhaustive concurrency certification.

## Trust Boundaries

| Boundary | Description | Data crossing / authority |
|---|---|---|
| Projector CLI → workspace configuration | Operator-supplied workspace/runtime selection meets existing JSON/TOML and filesystem paths | Config documents, server name ownership, directories, symlinks, backups, temporary files |
| Private projector → public installer | Python installer vendors Bun projector spec instead of importing a private repo | Runtime→path mapping and exact `${SUBSTRATE_URL}` / `${SUBSTRATE_TOKEN}` templates; parity checked in live proof |
| Installer environment → external token files | Installer reads per-surface variables but never reads server `substrate.env` | Fifteen secrets, one file per workspace/agent; realpath-derived namespace, 0600 files, intended 0700 directory |
| Runner environment → child process | Runner may hold A01/operator/other-surface secrets; each child must receive only its own substrate token | Filtered environment, resolved credential source, runtime argv, `SWARM_AGENT` and `SWARM_SUBSTRATE_AGENT` |
| Workspace config → runtime MCP loader | Claude explicit strict config, Grok persistent trust, omp project config and extension guard | Endpoint/header expansion and tool exposure; directory trust is broader than merely a server name |
| Agent identity → omp `tool_call` authorization | Runner establishes exact projected config + own token marker; guard authorizes the matching session | Exact substrate API names only; operator devices/namespace lookalikes denied; A01 depth cap has priority |
| Shared credential lookup → lease transport / event tee | Runner acts for the executing agent rather than borrowing A01 identity | Agent file (or explicit same-surface override when absent), MCP lease bearer, REST event bearer, attribution |
| Generated files and diagnostics → source control / operator output | Workspace is typically a git checkout; logs/dry-runs must not expose credential values | Config templates, backups, run output, tracked-file secret scanner |
| Same OS account → sibling credentials | POSIX owner permissions separate accounts, not processes under one uid | Existing declared limitation: attributable identities are not unforgeable among same-account agents |

## Threat Register

`closed` means the required in-scope mitigation is present and verified against the final parent gates. T-14-12 closes the requirement to state the same-account boundary honestly, not the out-of-scope absence of process isolation. No risk acceptance or third-party transfer is claimed. `threats_open` counts high/critical open entries; none remain.

| Threat ID | STRIDE category | Component / tasks / requirements | Severity | Disposition | Mitigation / evidence | Status |
|---|---|---|---|---|---|---|
| T-14-01 | Tampering | Projector/spec and installer; Tasks 1,2,4,5,8 / INST-01, INST-02 | high | mitigate | Fixed variable templates, owned-entry equality/refusal and append/reparse preservation; S projector and W `_install_substrate.py`; final full suites plus live cross-repo spec parity/idempotence. Baseline detailed citations remain below. | closed |
| T-14-02 | Denial of service / Tampering | Malformed input and unsupported executor preflight; Tasks 1,2,5,8 / INST-01, INST-04 | medium | mitigate | Config parsing/runtime allowlist and workspace refusals precede writes; W `_install_substrate.py:263-298`, `build_agents.py:336-365`, `_install_omp.py:513-541`; S CLI/refusal tests; final full suites. | closed |
| T-14-03 | Tampering / Elevation of privilege | Auxiliary write paths escape workspace; Tasks 1,2,5,8 / INST-01, INST-04 | high | mitigate | S `swarm-workspace.ts:294-498` and W `workspace.py:108-185,210-331`: pinned directory descriptors, no-follow regular-file snapshots, random exclusive stages, complete transaction. Parent before/after outside-victim smokes; final adversarial suites and live install. | closed |
| T-14-04 | Tampering / Information disclosure / Denial of service | Token directory/file boundary; Tasks 4,5,8 / INST-03 | medium | mitigate | W `workspace.py:101-150,188-229` validates current-user private directory and file, exclusive staging is 0600 from first byte; `_install_substrate.py:276-285` refuses unsafe directory before tokens. Owner/type/mode regressions, parent 0777 refusal smoke, final live 0700/0600 proof. | closed |
| T-14-05 | Information disclosure / Spoofing | Child credential delivery; Tasks 4,6,8 / INST-03 | high | mitigate | Shared own-surface file-first lookup and invalid-file refusal; strips all `SUBSTRATE_TOKEN*` and `SUBSTRATE_OPERATOR_TOKENS`; no runner-token fallback; `swarm_run.py:230-235` discards inherited authorization marker. Final Python suite and actual own-token child proof; same-uid boundary remains explicit. | closed |
| T-14-06 | Spoofing / Elevation of privilege | Lease calls borrow wrong surface; Tasks 7,8 / INST-03, PROOF-03 | high | mitigate | W `substrate_lease.py:124-137` calls the same lookup and returns refusal before network on no usable own credential, strips inherited credentials before MCP call. Workspace reaches claim/Lease/bridge/settlement (`:149-160,277-299,318-324`, `orch_status.py:68`). Tests exercise missing/0644/wrong-surface rewritten file; live proof records A05 granted holder. | closed |
| T-14-07 | Repudiation / Spoofing | Tee rows misattributed to runner; Tasks 7,8 / INST-03, PROOF-03 | medium | mitigate | W `substrate_tee.py:368-403` uses `workspace.credential`, removes inherited credential variables before POST, refuses sending a row without own token with one stderr note per agent. Deliberately fail-open locally, per CONTEXT:98 and prior v1.1 lesson, not silent borrowing of A01. | closed |
| T-14-08 | Elevation of privilege | omp actual tool execution bypasses operator deny/depth cap; Task 6 / INST-01, INST-03, PROOF-03 | high | mitigate | W `swarm_run.py:232,243-251`: discard inherited marker; exact projected JSON + own resolved credential needed to set own slug. `omp/src/guard.ts:89-122`: anchored known substrate API regex, matching identity/marker/token, deny all other MCP tool/device routes, depth cap first. `omp/src/index.ts:39-55`: registered tool-call handler applies guard, errors fail closed in established swarm context. Historical real tool loop, not discovery alone, proves allowed A05 event and denied operator device. | closed (bounded exact allowance, no claim of same-uid sandbox) |
| T-14-09 | Elevation of privilege / Tampering | Runtime flags on config-only workspaces; Tasks 6,8 / INST-01, INST-04 | medium | mitigate | W `workspace.py:63-79` requires exact parsed projected JSON/TOML through safe reads; `swarm_run.py:238-260` gates Grok trust/Claude flags/omp marker accordingly. Unrelated, malformed, operator-token and symlink cases tested; final Python suite and real runtime proof pass. | closed |
| T-14-10 | Tampering / Denial of service | Partial install on recoverable late failure; Tasks 1,2,5,8 / INST-01, INST-04 | medium | mitigate | S `swarm-workspace.ts:403-498`; W `workspace.py:244-331`, `_install_substrate.py:340-358`: whole write-set staging, rechecks, conditional rollback and preserved external edits. Late publication/staging failure regressions pass; crash-atomic filesystem durability is not claimed. | closed |
| T-14-11 | Information disclosure | Workspace/config/log/committed token leakage or Greptime bypass; Tasks 1,2,3,5,6,8 / INST-02, INST-03 | high | mitigate | Literal-variable templates, secret-free diagnostics and tracked-assignment scanner; existing sentinel tests plus final 1074/828 suites and live no-token/no-Greptime checks. Scanner scope remains bounded as documented below. | closed |
| T-14-12 | Spoofing / Elevation of privilege | Misstating same-account isolation; Task 9 / INST-05 | high | mitigate (document required boundary) | `.planning/REQUIREMENTS.md:45,75`, CONTEXT:20,41,126 and both workspace docs expressly state that 0600 separates accounts, not processes of one uid. No claim of unforgeable sibling identity. Per-agent OS isolation remains explicitly out of scope, not newly accepted by this report. | closed for documentation/boundary requirement; process isolation NOT implemented |

**Counts:** 12 registered threats; 12 in-scope dispositions closed; 0 open; **0 blocking open**. T-14-12 records the existing requirement boundary, not a technical claim that sibling impersonation is prevented. No accepted risks.

## Verified Mitigation Detail and Exact Tests

Run commands are in the final section. The following names refer to existing tests that were read; existence does not mean this author ran them.

### Projection and config ownership — T-14-01/02

- S `packages/projector/src/swarm-workspace.test.ts:81-166`: `gets one substrate entry per runtime file, naming the token's variable and never its value`; `keeps every entry and key it had, and a second run changes nothing`; `--check reports pending additions with exit 1 and writes nothing`; `an identical hand-written entry counts as present, whatever its key order`.
- Refusal case table at `:169-199` covers unparsable JSON/TOML, differing substrate/token-value entries, inline `mcp_servers`, symlinked config directory, dangling destination symlink; named tests at `:201-212` cover unsupported runtime and missing workspace.
- W `tests/test_install_substrate.py`: `test_a_fresh_workspace_gets_an_entry_per_runtime_file` (:58); `test_existing_entries_are_kept_and_a_second_run_changes_nothing` (:73); `test_a_runtime_that_cannot_call_mcp_is_refused_as_an_executor` (:172); `test_refusals_hold_with_every_token_given_and_write_nothing` (:181); `test_dry_run_prints_the_additions_and_the_env_files_and_writes_nothing` (:203); `test_dry_run_with_a_missing_token_still_prints_the_plan_and_exits_2` (:217); `test_no_substrate_installs_the_rest_without_tokens` (:226).
- `/tmp/p14-proof.sh:240-247` compares emitted `--spec` to vendored spec and checks the Python installation with Bun projector `--check`; directly observed historical passes at `drive.log:26-27`. Public installation does not require access to the private substrate checkout.

### Token provisioning/delivery — T-14-04/05

- W provisioning tests cover fresh private files, missing-token no-write refusal, operator-created files, 0644 refusal and checkout/workspace exclusion; new `tests/test_install_substrate.py:287-322` covers existing directory permissions, ownership and symlink states with and without held files. All are included in final 828 Python tests.
- Own-token child tests and new `tests/test_agent_token.py:206-239` verify invalid-directory refusal without fallback and 0600 staging before bytes. Final runtime proof independently verifies each child uses its own token.
- Updated `workspace.py:101-150,161-207` pins no-follow directory/file reads and rejects unsafe directory/file ownership or group/other permissions. Existing file parsing still ignores blank lines and does not require exact owner bits; generated files are one-line 0600 as required. This is not a claim of a same-uid security sandbox.
- Workspace token namespace and outside-checkout checks remain enforced; installer secrets originate in its own environment, never server `/etc/substrate/substrate.env`.

### Leases and tee use the same lookup — T-14-06/07

- W `tests/test_substrate_lease.py:378-419`: `test_refused_claim_is_not_dispatched` asserts no request/no dispatch and file-naming refusal; `test_without_an_env_file_the_agents_own_server_side_variable_is_used`; `test_lease_calls_carry_the_token_in_the_agents_env_file`; `test_an_env_file_others_can_read_is_not_used`.
- `test_a_refusal_stops_the_session_with_its_tabled_reason[not-holder]` (`:571-588`) rewrites A05's credential to A06 and observes the policy stop. The lease uses current file contents, not a retained runner credential.
- W `tests/test_substrate_tee.py:309-344`: `test_a_row_without_its_agents_token_stays_local` asserts no `/events` call and one stderr note; `test_a_row_goes_out_with_its_agents_env_file_token` asserts A05 authorization/surface with only A01 in runner env; `test_a_bad_env_file_is_not_bypassed_by_the_surface_variable` denies invalid-file fallback.
- Runner-owned graph registration/binding and its own memory brief remain A01 operations, not executing-agent lease/event operations (`docs/substrate-workspace.md:98-99`; lease unknown-node registration at `substrate_lease.py:161-166`). Do not incorrectly require those A01 control-plane operations to borrow a worker's identity.

### Runtime execution and narrow omp exception — T-14-08/09

- W `tests/test_agent_token.py:84-131`: `test_claude_gets_the_workspace_mcp_config_and_the_substrate_tools`; `test_an_unwired_workspace_gets_no_mcp_flags`; `test_grok_clears_folder_trust_for_the_workspace_it_runs_in`; `test_omp_runs_where_the_entry_is_and_its_tools_list_names_only_builtins`; `test_omp_guard_scope_requires_the_projected_own_token_entry` (projected, absent, operator-token, invalid-json, plus no own credential).
- W `omp/test/guard.test.ts:831-872`: `S4 scoped substrate: the registered guard admits own-token calls but not another agent or operator MCP`; `S4 scoped substrate: a token alone, missing token, or mismatched scope never unlocks MCP`; `S4 scoped substrate: namespace lookalikes and mixed device targets remain blocked`; `S4 scoped substrate: A01's depth cap still precedes the own-token exception`.
- Guard matches exact case-sensitive known substrate API names, not arbitrary `mcp__substrate_*` suffixes. Query/subpath/operator lookalikes and mixed device targets are denied. Its scope marker is checked against runtime session identity, not just presence of any bearer.
- Real historical omp proof is `/tmp/p14-proof.sh:349-369` and `drive.log:42-45`: deterministic local provider traverses actual tool loop → `tool_call` guard → device → MCP transport; the ledger receives A05 event, operator Notion call is denied, output has no token. This closes the earlier discovery-only integration issue cited in SUMMARY:72, but does not grant a sandbox against same-uid compromise.
- Claude receives `--mcp-config <ws>/.mcp.json --strict-mcp-config` plus allowed tools; generated agent tools also name `mcp__substrate` (`build_agents.py:89-93`). Historical Claude init confirms connection/tools at $0. Grok historical doctor confirms untrusted→healthy with `--trust`, which persists a workspace trust grant, including hooks. T-14-09 tracks over-broad existence-based gating.

### Output and tracked secret scanning — T-14-11

- S test `no generated file names Greptime as an MCP server, and no file under the workspace holds a token` (`swarm-workspace.test.ts:101-117`) and W `test_no_greptime_server_anywhere_and_no_token_under_the_workspace` (`test_install_substrate.py:98-108`) check generated artifacts using sentinels.
- S `store-lock.test.ts` exact tests: `no agent config registers Greptime as an MCP server` (:227); `no tracked file assigns a substrate token a value` (:324); `the token scan catches a value under either name, in an env file or a config` (:335); `the token scan does not fire on a blank, a placeholder, a reference or a short fixture` (:347).
- Scope is important: the token regex detects literal assignments of at least 16 permitted token characters, within one line, comments included; it deliberately excludes its own fixture test file. It is not a complete arbitrary-secret detector. The Greptime config scan omits projector `*.test.ts` because those tests must mention the forbidden server; generated-output checks cover what is written. Existing unrelated operator config is preserved, not removed.

## Remediated Findings and Closure Evidence

The original defects below were found on the baseline branches; final tested revisions S `fe946a1` / W `8bbe668` close all four. No finding was waived.

### SEC14-01 / T-14-03 — High — CLOSED

**Original evidence:** S `swarm-workspace.ts:249-250,268-273` checked config paths but followed auxiliary backup/temp symlinks; W `_install_substrate.py:290-294` used predictable temporary `write_text`. Parent reproduced external-file overwrite on both paths.

**Closure:** S `swarm-workspace.ts:294-498` and W `workspace.py:108-185,210-331` now use pinned no-follow paths and exclusive random stages. This author inspected regression assertions for backup/temp collisions, destination/ancestor swaps and unchanged victims. Parent actual exported-code smokes preserve outside victims; full substrate 1074/Python 828 gates and actual install proof pass.

### SEC14-02 / T-14-04 — Medium — CLOSED

**Original evidence:** W `workspace.py:104` left pre-existing token directory 0777; location checks did not enforce owner/mode.

**Closure:** W `workspace.py:101-150,205-207`, `_install_substrate.py:276-285` reject unsafe directories before token installation/read. Regressions cover mode/owner/symlink, held/missing files and refusal without fallback. Parent actual 0777 smoke refuses without credentials; live proof verifies successful 0700 directory/0600 files. This was fixed, not accepted under the same-account limitation.

### SEC14-03 / T-14-09 — Medium — CLOSED

**Original evidence:** W `swarm_run.py:238-241,264-266` equated config existence with wiring, granting persistent Grok trust and Claude substrate flags to unrelated config files.

**Closure:** W `workspace.py:63-79` parses and compares exact projected JSON/TOML; runner `:238-260` gates flags and preserves own-token omp marker rules. New unrelated/malformed/changed-token/symlink tests are in the passing 828 suite. Final real Claude/Grok/omp checks pass; deliberate Grok persistent trust is limited to the correctly wired case.

### SEC14-04 / T-14-10 — Medium — CLOSED

**Original evidence:** S `swarm-workspace.ts:268-274` and W `_install_substrate.py:330-358` published sequentially without whole-plan recoverable rollback.

**Closure:** S `swarm-workspace.ts:403-498`, W `workspace.py:244-331` and `_install_substrate.py:340-358` stage entire write sets and conditionally restore their own versions after failure. Tests cover late staging/publication failures, existing/new files and backups/modes, and intervening operator edits; final suites pass. This is recoverable transaction behavior, not crash-atomic multi-file durability; external changes are preserved and incomplete recovery is reported.

## Accepted Risks Log

**No accepted risks.** All four discovered in-scope findings were remediated; none was waived or transferred. The same-OS-account 0600 limitation is an explicit original requirement/scope boundary (`.planning/REQUIREMENTS.md:45,75`; CONTEXT:20,41,126), not an acceptance decision made by this audit. Per-agent OS principals/brokers remain outside Phase 14; the report does not imply they were implemented.

## Task and Requirement Coverage

| Numbered task | Requirements | Threats |
|---|---|---|
| 14-01-01 projector library/CLI | INST-01, INST-02, INST-04 | T-14-01,02,03,10,11 |
| 14-01-02 projector CLI tests | INST-01, INST-02, INST-04 | T-14-01,02,03,10,11 |
| 14-01-03 tracked token scan | INST-02 | T-14-11 |
| 14-01-04 spec / credentials module | INST-01, INST-03 | T-14-01,04,05,06,07 |
| 14-01-05 installer / generated Claude tools | INST-01, INST-02, INST-03, INST-04 | T-14-01,02,03,04,10,11 |
| 14-01-06 runner / runtime flags / actual guard | INST-01, INST-03, INST-04, PROOF-03 | T-14-05,08,09,11 |
| 14-01-07 workspace-aware leases/status | INST-03, PROOF-03 | T-14-06,07 |
| 14-01-08 integration tests and tee identity | INST-01, INST-02, INST-03, INST-04, PROOF-03 | T-14-01..11 |
| 14-01-09 documentation | INST-05 | T-14-12; boundary explanations for all threats |

## Scope Limits / Unregistered Flags

- The plan had no formal threat model; all twelve threats are retroactively registered. Summary deviations (vendored spec, tee lookup correction, Grok trust, own-token omp exception, explicit shared-account limit) are now mapped rather than treated as automatically safe.
- ASVS L1 source review is not a full L2/L3 data-flow/race audit, dependency audit, penetration test, or certification of server auth/RBAC from other phases. Actual credential ownership is determined server-side; a malicious same-uid process can still read sibling files and inherit/forge process state.
- Updated descriptor-based reads and owner/directory regressions supersede the original lstat/read design. The report does not claim exact 0600 owner bits on every pre-existing file, every ancestor owner-only, a crash journal or comprehensive race/sandbox certification.
- Historical live proof helper depends on uncommitted `/tmp/p14-omp-provider.ts` and installed omp internals. Its Grok trust cleanup restores a pre-existing trust file but does not delete a newly created trust file when none existed (`/tmp/p14-proof.sh:91-98`). Parent must isolate/restore that operator state; the helper is not side-effect-free.
- No full multi-agent LLM run was performed by the historical proof or this audit. Claude connection/init, Grok doctor/discovery, deterministic omp actual tool execution, and the real runner with an MCP-calling stub are deliberately separate claims.

## Exact Parent Gate Commands

Reproduction commands from the stated cwd. Final parent full-suite/generator/TS/Ruff and actual-runtime results are recorded above; this list does not claim every focused subset ran separately. No command was executed by this report author.

**S:**

```sh
bun test packages/projector/src/swarm-workspace.test.ts packages/mcp-server/src/store-lock.test.ts
bun test
bun run check
```

**W:**

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

**Isolated runtime proof, only with smoke dependencies already available and a confirmed free non-production port:**

```sh
SERVER_WT=/root/src/worktrees/agent-substrate-p14 SUB_WT=/root/src/worktrees/agent-substrate-p14 SWARM_WT=/root/src/worktrees/agent-swarm-p14 PORT=7499 /tmp/p14-proof.sh
```

Script refuses :7410 and an already-serving chosen port. Use another free port rather than disrupting a service. Preserve/redact proof output; never print credentials from generated token/env files. Require actual omp allowed event + denied operator call and real A05 claim/ledger/non-empty A09 brief, not only CLI exit/discovery.

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Blocking Open | Run By |
|---|---:|---:|---:|---:|---|
| 2026-10-07 | 12 | 8 | 4 | 1 | Formal14; static retroactive audit plus cited historical artifacts and parent-observed reproductions; no execution by this author |
| 2026-10-07 final | 12 | 12 | 0 | 0 | Parent full gates/security smokes and 51/51 actual proof; Formal14 inspected remediation/tests and final drive.log; no executions by report author |

## Sign-Off

- [x] Every threat has severity and disposition; all nine tasks and six requirements mapped.
- [x] Existing shared-account limitation cited without accepting any new risk.
- [x] Historical proof provenance and actual-runtime versus discovery distinction recorded.
- [x] S portions of SEC14-01/SEC14-04 closed through inspected code/regressions and parent post-fix full gates/actual smoke.
- [x] SEC14-01 closed by inspected code/regressions and parent adversarial verification.
- [x] SEC14-02..04 fixed and verified; no risk acceptance.
- [x] Parent final full gates and actual-runtime smoke complete.
- [x] `threats_open: 0` confirmed.
- [x] `status: verified` justified.

**Approval: verified 2026-10-07 from parent final gates, inspected remediations and directly inspected 51/51 live proof. SECURED — zero open in-scope threats; no accepted risks.**
