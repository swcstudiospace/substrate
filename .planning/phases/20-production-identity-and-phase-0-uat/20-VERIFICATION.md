---
phase: 20-production-identity-and-phase-0-uat
verified: 2026-11-18T12:22:25Z
status: human_needed
score: 2/5 truths verified (2 present-and-wired with live behavior unexercised; 1 freshness truth uncertain)
covered_files: [".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-01-PLAN.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-01-SUMMARY.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-02-PLAN.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-02-SUMMARY.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-03-PLAN.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-03-SUMMARY.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-04-PLAN.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-04-SUMMARY.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-05-PLAN.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-05-SUMMARY.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-06-PLAN.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-06-SUMMARY.md", ".planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-UAT.md", ".planning/milestones/v1.0-phases/00-brief/0-UAT.md", "packages/cli/src/token.ts", "packages/cli/src/token.test.ts", "packages/cli/src/cli-auth.test.ts", "packages/mcp-server/src/config.ts", "packages/mcp-server/src/authority.test.ts", "packages/mcp-server/src/server.authority.test.ts", "packages/mcp-server/src/boot-refusal.test.ts", "packages/collectors/src/emit.ts", "scripts/identity-check.ts", "scripts/identity-check.test.ts", "scripts/parity-check.ts", "scripts/uat-phase0.ts", "scripts/uat-phase0.test.ts", "infra/identity/clients.json", "docs/runbooks/production-identity.md", "docs/uat.md"]
covered_digest: "v3:sha256:5fa071b91ae617434b38ee7c9dd38bf66fa93dced06dc643636268253e8a54a9"
behavior_unverified: 2
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 22/22 (2026-10-11 record, v1.3 milestone archive)
  gaps_closed: []
  gaps_remaining: []
  regressions: []
behavior_unverified_items:
  - truth: "SC3: Claude Code substrate MCP entry names its token variable, and ultrathink-kickoff registers each new graph through graph_register"
    test: "Run /ultrathink-kickoff on a new plan in a session where the substrate MCP server is connected, then run scripts/uat-phase0.ts --scenarios 5 --graph <gid>"
    expected: "graph_get returns the new graph with its nodes and Linear identifiers, registered by surface claude-code"
    why_human: "Config shape is verified statically today; the registration of a new graph is a live call against production, and the last live proof is dated 2026-10-10"
  - truth: "SC4: Cursor hooks (sessionStart, postToolUse, stop) and the git post-commit collector are installed and emit live"
    test: "In a real Cursor session, end a turn (stop) and make one real commit in a registered repo; then run scripts/uat-phase0.ts --scenarios 6"
    expected: "stop exits 0 with empty stdout; one commit event matched by surface cursor, kind, repo and since; BRIEF.md written at sessionStart without an event"
    why_human: "Installation is verified today; emission needs a real Cursor session and a real commit, which are live actions"
coincidental_reliance_items: []
human_verification:
  - test: "Confirm the production switch-on record and the identity guarantee at the operator shell: run bun run identity:check (names-only) and, in the operator window, bun run identity:check --values"
    expected: "exit 0; zero stranded live clients; every live client delivery matches"
    why_human: "Values mode reads secret values and is operator-only; this verifier never reads values"
  - test: "Run the full eight-scenario UAT against production: scripts/uat-phase0.ts --tag <run-tag> --scenarios 1,2,3,4,5,6,7,8 --report <path> with --live <approval-ref> for write scenarios"
    expected: "Each scenario recorded pass or fail with evidence against the current main; report written"
    why_human: "Write scenarios refuse on production without an operator approval reference; the last full set of production passes is dated 2026-10-10 and predates 628 commits"
  - test: "Reconcile the archived records: 20-VERIFICATION.md (2026-10-11) says the switch-on and production scenarios were never run; docs/runbooks/production-identity.md and 0-UAT.md record a switch-on window on 2026-10-10 14:22Z and production passes for scenarios 2 and 5"
    expected: "One consistent account in the milestone archive"
    why_human: "Both records are historical and the operator owns which one is accurate"
---

# Phase 20: Production Identity and Phase 0 UAT Verification Report

**Phase Goal:** Every client of production `substrate-mcp` is identified by its own token, and the eight deferred Phase 0 brief scenarios pass against `main` with fresh evidence.
**Verified:** 2026-11-18T12:22:25Z
**Status:** human_needed
**Re-verification:** Yes, against HEAD `357d6b15` (branch `gsd/autonomous-rerun`). Prior record: `.planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-VERIFICATION.md` (2026-10-11, status passed). That record is left untouched.

**Location note:** `init.phase-op` reports `.planning/phases/20-production-identity-and-phase-0-uat/` as the expected directory. That directory did not exist; the phase's plans, summaries and UAT evidence live in `.planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/`. This record was written to the expected path and cites the archived files.

## Goal Achievement

### Observable Truths

| # | Truth (ROADMAP success criterion) | Status | Evidence |
|---|-----------------------------------|--------|----------|
| 1 | SC1: runbook lists every client with its token; per-surface tokens, operator token, `SUBSTRATE_HANDOFF_KEY`, `SUBSTRATE_AUDIT_PATH` exist by name in `/etc/substrate/substrate.env` with no value in the repo; no listed client left without a token at switch-on | ✓ VERIFIED | `docs/runbooks/production-identity.md` (client table between `identity-clients:start/end` markers); `infra/identity/clients.json` holds 64 clients, names only; `SUBSTRATE_HANDOFF_KEY` and `SUBSTRATE_AUDIT_PATH` listed in the manifest; `.env.example` lines 193-547 carry blank per-surface names. `bun scripts/identity-check.ts` run today (names-only, read-only): exit 0, "server /etc/substrate/substrate.env: 44/44 names present", every live client delivery `ok` or `external`. Dormant rows (`skills-sync`, `bridge`, `miner`, `anchor`) report unreadable env files and do not fail the verdict, per the runbook. Caveat: `--values` (operator-only) was not run; the 2026-10-10 switch-on record conflicts with the 2026-10-11 archive (see Human Verification item 3). |
| 2 | SC2: repeatable UAT script runs all eight scenarios from `0-UAT.md` against any `SUBSTRATE_URL`, with expectations updated to today's surface, and records pass or fail with evidence per scenario | ✓ VERIFIED | `scripts/uat-phase0.ts`: `ALL_SCENARIOS = [1..8]` (line 37), `SCENARIO_RUNNERS` for 1-8 (line 951), `--report` writes the Markdown table and `.json` (`docs/uat.md`). Expectations: `V1_TOOLS` (scenario 1) lists nine names; each of `memory_brief`, `memory_write`, `memory_search`, `events_emit`, `graph_get`, `graph_register`, `graph_claim`, `graph_release`, `graph_complete` is defined in `packages/mcp-server/src`. `bun test scripts/uat-phase0.test.ts scripts/identity-check.test.ts` run today: 97 pass, 0 fail. Freshness of a live run is covered by Human Verification item 2. |
| 3 | SC3: Claude Code `substrate` MCP entry names its token variable; `ultrathink-kickoff` registers each new graph through `graph_register` | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Config: `~/.claude.json` `mcpServers.substrate` is `{type: http, url: http://127.0.0.1:7410/mcp}` with an `Authorization` header that names a `${VAR}` (checked today, values not printed). Skill: `/root/src/repos/claude-ultrathink/skills/ultrathink-kickoff/SKILL.md` step 3 calls `graph_register` when the `substrate` MCP server is connected; the same text is on `origin/main`. Live registration of a new graph was last shown on 2026-10-10 (`ut-mugbqivi-752f2dad`, per `0-UAT.md` scenario 5). No new kickoff was run. |
| 4 | SC4: Cursor hooks, including `stop`, and the git post-commit collector are installed and emit live | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED | Installed: `bun packages/projector/src/cursor.ts --check` run in `/root/src/repos/agent-substrate` (HEAD `34f34210`): "`/root/.cursor/hooks.json` already current (6 gsd-managed entries untouched)", exit 0. `stop` entry points at `packages/collectors/src/cursor-stop.ts` (file present). `bun packages/collectors/src/install-git-hook.ts --check .` in the same checkout: "✓ . — present", exit 0. Emission (a real Cursor session and a real commit) was not exercised today. Last emission evidence is the 2026-10-10 twin run (scenario 6). |
| 5 | Goal clause: the eight scenarios pass against `main` with fresh evidence | ? UNCERTAIN (warning) | Last recorded passes: 2026-10-09/10 twin runs (scenarios 1, 3, 4, 6, 7, 8 on `main` 1ee0b11, plus 2 and 5 on production per `0-UAT.md`). Since `1ee0b11` there are 628 commits, including changes to `scripts/uat-phase0.ts` (+68), `scripts/identity-check.ts` (+8), `packages/collectors/src/install-git-hook.ts` (+247) and `packages/collectors/src/git/post-commit` (+24). None of the eight scenarios has been re-run against HEAD. |

**Score:** 2/5 truths verified (SC1, SC2). SC3 and SC4 are present and wired, with live behavior unexercised (routed to human verification, not counted). Truth 5 is uncertain (warning).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `docs/runbooks/production-identity.md` | Client list with tokens and switch-on ordering | ✓ VERIFIED | Exists; lock-tested client table; switch-on order described |
| `infra/identity/clients.json` | Names-only manifest | ✓ VERIFIED | Exists; 64 clients; read by `identity-check.ts` |
| `scripts/identity-check.ts` | Names-only check, exit 0/1/2 | ✓ VERIFIED | Ran today: exit 0, 44/44 server names |
| `scripts/uat-phase0.ts` | Eight-scenario UAT with report | ✓ VERIFIED | All eight scenario runners present; report writer present |
| `scripts/uat-phase0.test.ts` | Unit coverage of the UAT | ✓ VERIFIED | Part of 97/97 passing run today |
| `docs/uat.md` | Operator doc for the UAT | ✓ VERIFIED | Exists; describes scenarios, live-reference rule, exits |
| `.env.example` | Names only, no values | ✓ VERIFIED | Per-surface names with blank values (lines 193-547) |
| `packages/projector/src/cursor.ts` | Cursor hook installer with `stop` | ✓ VERIFIED | `DESIRED` has `sessionStart`, `postToolUse`, `stop`; `--check` current on the live checkout |
| `packages/collectors/src/install-git-hook.ts` | Post-commit installer with `--check` | ✓ VERIFIED | `--check` reports present |
| `packages/collectors/src/cursor-stop.ts` | Stop script | ✓ VERIFIED | Present (12.8K) |
| `/root/.cursor/hooks.json` | Installed entries | ✓ VERIFIED (presence) | `sessionStart`, `postToolUse`, `stop` substrate-managed entries present |
| `~/.claude.json` substrate entry | Token variable named in header | ✓ VERIFIED (shape) | HTTP transport to `127.0.0.1:7410/mcp`; header names a variable; value not read |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| runbook client table | `infra/identity/clients.json` | lock test on ids | ✓ WIRED | Covered by `identity-check.test.ts` (part of 97/97) |
| `identity-check.ts` | `/etc/substrate/substrate.env` | names-only read | ✓ WIRED | 44/44 names present today |
| `uat-phase0.ts` scenario 5 | `~/.claude.json` | config read | ✓ WIRED | Same entry shape as verified above |
| `uat-phase0.ts` scenario 6 | `cursor.ts --print-desired` | child process | ✓ WIRED | Desired entries include `stop` |
| `ultrathink-kickoff` step 3 | `graph_register` MCP tool | skill instruction | ✓ WIRED (conditional) | Runs only when `substrate` is connected; otherwise skipped silently by design |

### Data-Flow Trace (Level 4)

Not applicable: this phase's artifacts are checks, scripts and runbooks, not rendered dynamic data.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| UAT and identity unit tests | `bun test scripts/uat-phase0.test.ts scripts/identity-check.test.ts` | 97 pass, 0 fail | ✓ PASS |
| Identity names check | `bun scripts/identity-check.ts` | exit 0; 44/44 server names | ✓ PASS |
| Cursor desired entries | `bun packages/projector/src/cursor.ts --print-desired` | sessionStart, postToolUse, stop | ✓ PASS |
| Cursor hooks installed (live checkout) | `cd /root/src/repos/agent-substrate && bun packages/projector/src/cursor.ts --check` | already current, exit 0 | ✓ PASS |
| Git post-commit installed | `bun packages/collectors/src/install-git-hook.ts --check .` | present, exit 0 | ✓ PASS |
| Live UAT scenarios | not run | live stack and production writes are operator-gated | ? SKIP |

### Probe Execution

No probes declared for this phase. Not applicable.

### Requirements Coverage

| Requirement | Source | Description | Status | Evidence |
|-------------|--------|-------------|--------|----------|
| FOUND-04 | Phase 20 roadmap | Production `substrate-mcp` clients each identified by own token | ✓ SATISFIED (names-only) | Runbook, manifest, `identity-check` exit 0 today. Switch-on confirmation is Human item 1. |
| UAT-01 | Phase 20 roadmap | Repeatable UAT script for eight scenarios | ✓ SATISFIED | `scripts/uat-phase0.ts` and tests passing |
| UAT-02 | Phase 20 roadmap | Expectations updated to today's surface | ✓ SATISFIED | `V1_TOOLS` names present in `packages/mcp-server/src` |
| UAT-03 | Phase 20 roadmap | Scenario 5 passes | ? NEEDS HUMAN | Config verified; live kickoff registration is Human item 2 |
| UAT-04 | Phase 20 roadmap | Scenario 6 passes | ? NEEDS HUMAN | Installed verified; live emission is Human item 2 |

Requirement IDs are taken from the roadmap section. `.planning/REQUIREMENTS.md` has no matching `**FOUND-04**`/`**UAT-0x**` rows for phase 20; this is not a gap for this verification.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `.planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-VERIFICATION.md` | frontmatter | Contradicts runbook and `0-UAT.md` on whether the switch-on and production scenarios ran | ⚠️ Warning | Historical records disagree; not changed here |
| `.planning/milestones/v1.0-phases/00-brief/0-UAT.md` | scenarios 2, 5 | Production pass evidence (2026-10-10) predates 628 commits | ⚠️ Warning | Evidence is stale against HEAD |
| Working tree of `/root/src/repos/agent-substrate` | n/a | Uncommitted edits in `docs/config-reference.md`, `packages/mcp-server/src/flag-registry.ts` and others | ℹ️ Info | Not part of this phase's files; the installed-hook checks above ran against that checkout |

No stub, placeholder, or TODO markers were found in the phase's scripts (`scripts/uat-phase0.ts`, `scripts/identity-check.ts`) by grep for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER`.

### Human Verification Required

### 1. Switch-on identity confirmation (operator shell)

**Test:** `bun run identity:check` (names-only) and, in the operator window, `bun run identity:check --values`
**Expected:** exit 0 and zero stranded live clients; each live client's value `match`
**Why human:** `--values` reads secret values and is operator-only. This verifier never reads values.

### 2. Fresh eight-scenario UAT against HEAD

**Test:** Run `scripts/uat-phase0.ts --tag <run-tag> --scenarios 1,2,3,4,5,6,7,8 --report <path>` against the target. Write scenarios (1, 3, 6, 8) on production need `--live <approval-ref>`. Scenarios 5 and 6 need a real kickoff graph and a real Cursor session and commit.
**Expected:** each scenario recorded pass or fail with evidence; report written; `.json` verdicts match
**Why human:** Live stack and production writes are operator-gated. The last production passes are dated 2026-10-10.

### 3. Reconcile the archived switch-on record

**Test:** Compare `.planning/milestones/v1.3-phases/20-production-identity-and-phase-0-uat/20-VERIFICATION.md` ("switch-on not run", "zero live execution") with `docs/runbooks/production-identity.md` (switch-on 2026-10-10 14:22Z) and `0-UAT.md` (production scenarios 2 and 5 passed 2026-10-10)
**Expected:** One accurate account
**Why human:** Both are historical operator records

## Gaps Summary

No BLOCKER. No must-have is FAILED. All four success criteria have their artifacts present and wired, and the artifacts' unit tests pass today. The phase cannot be marked `passed` because:

1. SC3 and SC4 require a live kickoff and a live Cursor session plus commit to show emission; the last evidence is dated 2026-10-10.
2. The goal's "fresh evidence against `main`" is not met: 628 commits have landed since the evidence commit `1ee0b11`, including the UAT script and the git hook installer.
3. The archived records disagree on whether the switch-on and production scenarios ran.

Verification commands were read-only or local: `identity-check` (names only), `cursor.ts --check` and `--print-desired`, `install-git-hook.ts --check`, and two unit-test files. No live stack was started, no production write was made, no secret value was read.

---

_Verified: 2026-11-18T12:22:25Z_
_Verifier: Claude (gsd-verifier)_
