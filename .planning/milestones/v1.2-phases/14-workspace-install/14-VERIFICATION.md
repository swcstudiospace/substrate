---
phase: 14-workspace-install
verified: 2026-10-08T04:08:00Z
status: passed
score: 5/5 must-haves verified
---

# Phase 14 Verification: Workspace install

Goal: a fresh swarm workspace is wired to `substrate-mcp` by the install alone, and each agent process holds only its own token.

## Source baseline bound by this refresh

- agent-substrate `a9d699e9e70ee7f112a4fe793572852054eff572` (projector + secret scan + docs; integrates shipped lessons PR17).
- agent-swarm `60b181464d2c06413690592cdcb0a764ddbd33b9` (installer, runner, lease, tee, handoff gate; integrates final signed-handoff/P12 corrections from shipped PR10; complete tree `11021d0130bbd8288f0e41c3027968e94988c5a5`, identical to tested pre-history-merge `4d2a4cf`).
- Both source roots immutable; no production `:7410` or user checkout touched by this report.
- Prior reports (`verified: 2026-10-07T22:44:46Z`) were bound to remediation snapshots S `fe946a1` / W `8bbe668`. Those remain qualified historical evidence (remediation gates, adversarial before/after smokes); they are NOT the baseline of this refresh. Current code was re-read at `a9d699e9` / `60b1814` — this refresh reviews current code, not relabeled old evidence.
- This author performed no tests, builds, linters, formatters, scanners, runtime probes, network calls, or git mutations. All execution evidence below is parent-reported shared evidence (`local://p14-oct08-integration-evidence.json`, SUMMARY snapshot `6A1D`); provenance is stated per row. `.py` LSP was unavailable (already attempted); verification is textual source inspection. No commits.

## Success criteria (ROADMAP)

| # | Criterion | Current-source evidence | Result |
|---|-----------|-------------------------|--------|
| 1 | The install appends a `substrate-mcp` entry for each runtime it already configures, keeps existing entries, and changes nothing on a second run. Each runtime's child actually sees the substrate tools: Claude `--mcp-config <ws>/.mcp.json` + `--allowedTools`; Grok `.grok/config.toml` past folder trust without a hand step; omp `<ws>/.mcp.json` with `--tools` not hiding substrate tools | S `packages/projector/src/swarm-workspace.ts:60-64` (`RUNTIME_FILES`), `:68-102` (`jsonEntry`/`tomlBlock`/`spec`), `:235-253` (`plan`: append, idempotent, `trae`/unknown refused), `:322-498` (all-or-nothing apply, backup, atomic rename); W `swarm/substrate_mcp.json:1-34` vendors the same version-1 literal-variable contract; W `scripts/swarm_run.py:217-267` (`headless_command`: Claude `--mcp-config`/`--strict-mcp-config` + `CLAUDE_TOOLS` only when `projected_mcp` wired, Grok `--trust` only when wired, omp `SWARM_SUBSTRATE_AGENT` marker only when wired with own token). Parent current runtime `51/51` (`/tmp/p14-proof-1791430676`, `:7513`, 13.21s): idempotent/spec-identical install, Claude connected at $0, Grok trust boundary, actual guarded omp own-token event + operator refusal | passed |
| 2 | Every generated config names `${SUBSTRATE_TOKEN}` in its headers, never the value. No Greptime MCP server in any generated file, no token literal in any file under the workspace; tracked-file secret scan flags `SUBSTRATE_TOKEN*` | S `swarm-workspace.ts:68-80` (templates name the variable); S `packages/mcp-server/src/store-lock.test.ts:95` (`TOKEN_LITERAL`, single-line, `process.env`/`os.environ`/`Bun.env` excluded, `*.test.ts` projector-glob exclusion for the Greptime scan); W `swarm/substrate_mcp.json:22-31` (vendored headers name the variable). Parent `51/51` bundle: no token and no Greptime under the workspace, before and after the run, none in the server log | passed |
| 3 | One env file per agent outside every git checkout and outside the workspace, mode 0600, holding that agent's `SUBSTRATE_TOKEN` and nothing else. When unwritable, prints what the operator must create and exits non-zero | W `swarm/workspace.py:82-93` (`env_dir` per-workspace hash / `env_file`), `:140-207` (private current-user directory, regular-file/no-follow reads), `:334-341` (0600-from-first-byte atomic `write_token`); W `scripts/_install_substrate.py` (preflight before generation/writes, `MISSING` + exit 2, `--no-substrate` escape). Parent `51/51`: 15 private 0600 files in a 0700 directory outside checkout/workspace, each its own token; dry run lists `MISSING`, exits 2 | passed |
| 4 | Each child starts with only its own `SUBSTRATE_TOKEN` (every other `SUBSTRATE_TOKEN*` stripped); the runner holds that child's lease with the token from the same agent's env file | W `swarm/workspace.py:343-389` (`credential`: env file, else own `SUBSTRATE_TOKEN_<SURFACE>`, never runner `SUBSTRATE_TOKEN`; `child_env` strips via `carries_token`); W `swarm/substrate_lease.py:127-146` (`_call`/`has_own_token` through `workspace.credential`, refusal names the file, no request sent); W `swarm/substrate_tee.py:382-396` (row goes out with attributed agent's token, never runner A01's; fail-open local + one stderr note); W `scripts/swarm_run.py:230-232,566-568` (strip + dry-run token-source line, never a value). Parent `51/51`: real runner with only A01's token claimed/completed A05 through A05's env-file token (claim `03:38:09.293Z`, A05 event `.455Z`, release `.525Z`, graph `ut-muyzku69-40917665`); A09 brief non-empty naming actor/node | passed |
| 5 | Non-MCP executors refused; existing refusals kept; dry run prints additions + env files; docs record the `substrate.env` split and the shared-account 0600 limit | S `swarm-workspace.ts:241-248` (unknown runtime refused as executor) + symlink/unparsable/differing-entry refusals; W `_install_substrate.py` / `build_agents.py --runtimes/--no-substrate` (checkout/`$HOME`/`~/.omp`/symlink refusals kept, dry run prints plan); S `docs/swarm-workspace.md` + W `docs/substrate-workspace.md` (server/agent variable split, owners, generation, 0600-is-OS-accounts-not-processes limit). PR10 final integration did not alter these paths (tree-identical to tested `4d2a4cf`; integration changes limited to recovery-test workspace args + duplicate-test removal) | passed |

## Credential-cutover coherence after final PR10 integration (re-read at `60b1814`)

One lookup serves four consumers — sessions, leases, handoffs, tee — so all four always speak as the same identity:

- Sessions: `child_env` (`workspace.py:382-389`) → `credential`.
- Leases: `substrate_lease._call` + `has_own_token` (`substrate_lease.py:127-146`) → `workspace.credential`; never the runner's `SUBSTRATE_TOKEN`.
- Tee: `substrate_tee.py:393` → `workspace.credential`; A05 row posted with A05's token under an A01-only runner; tokenless row stays local, fail-open.
- Handoffs/reconstruction: `substrate_handoff.py:350-354` gates sends on `substrate_lease.has_own_token` (sender without its own token sends nothing — no false-attribution signed packet); the separate `4/4` signed-handoff proof on server `a9d699e9` (`:7512`, graph `ut-muyzxvyp-16a9cf4e`, rework `hof_e2228419a716494fa688f822ca362536`, lost reply `hof_f9355d4a780543fabe7884f7bad300b2`) ran on the final merged swarm code with four private env files and all per-surface token vars removed, confirming the cutover survives the PR10 merge.
- Spec/runtime guards: `workspace.projected_mcp` (`workspace.py:63-79`, exact parsed entry) gates Claude/Grok flags and omp's `SWARM_SUBSTRATE_AGENT` scope marker (`swarm_run.py:238-260`); unrelated/malformed/operator-token/symlinked configs unlock nothing.

## Requirements

| ID | Evidence | Status |
|----|----------|--------|
| INST-01 | Criterion 1 | satisfied |
| INST-02 | Criterion 2 | satisfied |
| INST-03 | Criteria 3 and 4 + coherence section | satisfied |
| INST-04 | Criterion 5 | satisfied |
| INST-05 | Criterion 5 (docs) | satisfied |
| PROOF-03 | `51/51` current runtime (`/tmp/p14-proof-1791430676`, isolated `:7513`, real Postgres `:55432`/GreptimeDB `:54000`): fresh install with no hand edits, real `orch_plan` + `swarm_run --once` with only A01's token in the runner; A05 session/claim/ledger event/completion via its own env-file token; non-empty A09 brief naming actor/node; no token leakage. Stub agent CLI; no full multi-agent LLM run | satisfied |

The additional `4/4` signed-handoff scenarios are separate-scope evidence (handoff/lease-boundary proof on the same final sources with private agent files only). They are NOT merged into the `51/51` PROOF-03 claim and are recorded independently in SUMMARY/VALIDATION.

## Plan tasks (14-01, Tasks 1–9)

| Task | Content | Current status |
|------|---------|----------------|
| 1 | Projector library + Bun CLI (`swarm-workspace.ts`, `RUNTIME_FILES`, `jsonEntry`/`tomlBlock`/`spec`/`plan`/`apply`/`describe`, `--plan/--check/--apply/--spec`, exit 1/2 semantics) | covered — re-read at `a9d699e9`; parent gate 1171 Bun / 0 fail |
| 2 | Projector CLI integration tests (entries, Greptime/token absence, keep/idempotence, identical-entry accept, refusals exit 2, `trae` refused) + 8 adversarial staging/rollback regressions | covered — parent gate 1171 Bun / 0 fail |
| 3 | `store-lock.test.ts` `TOKEN_LITERAL` scan (names, shapes, placeholder/reference/fixture non-fires; `*.test.ts` Greptime-glob exclusion) | covered — parent gate 1171 Bun / 0 fail |
| 4 | Vendored spec + `swarm/workspace.py` (`SPEC`, `CLAUDE_TOOLS`, `carries_token`/`server_var`/`mcp_config`/`env_dir`/`env_file`, `read_token`/`write_token`/`agent_token`/`child_env`/`credential`) | covered — re-read at `60b1814`; parent gate 842 Python |
| 5 | `_install_substrate.py` (`plan_mcp`/`plan_env`/`location_problem`/`operator_instructions`/`runtime_problem`/`plan`/`preflight`/`install_substrate`) + `build_agents.py --runtimes/--no-substrate`, `render_claude` `mcp__substrate` tools | covered — parent gate 842 Python + generator current |
| 6 | `headless_command` (`child_env`, Claude mcp-config/allowedTools, Grok `--trust`, omp marker, dry-run unsets + token-source line) + omp guard exception | covered — re-read; parent 842 Python + `51/51` actual guarded omp execution/operator refusal |
| 7 | Lease lookup (`_call` workspace-aware, `Lease.workspace`, `claim_node(workspace=)`, `LeaseBridge(root)`, `settle_mirrored(workspace=)`, `orch_status` `ctx.root`) + shared tee lookup | covered — re-read; parent 842 Python + `51/51` real claim/ledger/brief |
| 8 | Swarm integration tests (`test_install_substrate`, `test_agent_token`, `test_substrate_lease`, `test_substrate_tee`, `test_install_omp`) + remediation regressions | covered — parent gate 842 Python; PR10 integration diffs (3 recovery-test workspace args, duplicate refusal-test removal) inspected, credential paths untouched |
| 9 | Docs (S `swarm-workspace.md` + correlation link; W `substrate-workspace.md`, `substrate-tee.md`, `substrate-leases.md`, README, AGENTS.md, CLAUDE.md) | covered by source review; not an automated behavioral test |

## Execution provenance (kept separate, honest scope)

| Evidence | Provenance | Standing |
|----------|------------|----------|
| 1171 Bun, 0 fail, 0 skip, 4489 assertions, 40 files, 7.17s + `bun run check` clean on `a9d699e9` | parent-reported (`artifact://134`), SUMMARY snapshot `6A1D` | current gate, accepted as reported; not executed by this author |
| 842 Python passed, 107.43s + generator current + TS contract 1/1 (6 assertions) + changed-file Ruff clean on `60b1814` | parent-reported (`bg_44`), SUMMARY snapshot `6A1D` | current gate, accepted as reported; not executed by this author |
| `51/51` PROOF-03, 13.21s, `/tmp/p14-proof-1791430676` | parent-executed on current sources; bundle read via shared evidence (claim/event/release timestamps, graph id) | current runtime proof, stub-assisted; no full multi-agent LLM run |
| `4/4` signed-handoff scenarios, 0.61s, `:7512` | parent-executed on final merged code with private files only | separate-scope proof; not PROOF-03, not combined with `51/51` |
| 1378 omp tests (5 isolated + 1373) | retained unchanged-extension evidence from prior gate; NOT rerun on current heads | retained, not claimed as current execution |
| Adversarial filesystem smokes (backup/temp symlink victims `UNCHANGED`, 0777 directory refused) | historical before/after proof at `fe946a1`/`8bbe668` | retained source-qualified evidence; not re-executed |
| 12 security threats closed | prior SECURITY at remediation snapshots | historical closure; current source re-read shows mitigations intact |

## Limits (explicit, no waivers)

- No full multi-agent LLM run; Claude proof is $0 init/connection, Grok is doctor/discovery, omp uses a deterministic local provider, swarm agent CLI is a stub making a real MCP call.
- 0600 separates OS accounts, not processes of one account — documented, not fixed.
- Handled-failure rollback is recoverable, not multi-file crash-atomic.
- Projector PR18 open at exact `a9d699e9` (review pending); swarm workspace source prepared at `60b1814`, not yet shipped. No PR18/workspace-merged or whole-milestone-complete claim.

## Gaps

None. All 5 criteria, 6 requirements, and 9 tasks verified against current sources with parent current gates and runtime proof. No status flip: had any truth failed, it would be reported as a gap, not passed.
