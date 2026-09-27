---
phase: 04-skills
verified: 2026-09-27T05:43:48Z
status: passed
score: 6/6 must-haves verified
covered_files:
  - .planning/phases/04-skills/04-01-PLAN.md
  - .planning/phases/04-skills/04-01-SPIKE.md
  - .planning/phases/04-skills/04-01-SUMMARY.md
  - .planning/phases/04-skills/04-02-PLAN.md
  - .planning/phases/04-skills/04-02-SCAN.md
  - .planning/phases/04-skills/04-02-SMOKE.md
  - .planning/phases/04-skills/04-02-SUMMARY.md
  - .planning/phases/04-skills/04-03-PLAN.md
  - .planning/phases/04-skills/04-03-SUMMARY.md
  - .planning/phases/04-skills/04-03-TRACER.md
  - .planning/phases/04-skills/04-04-PLAN.md
  - .planning/phases/04-skills/04-04-SUMMARY.md
  - .planning/phases/04-skills/04-04-TRACER.md
  - .planning/phases/04-skills/04-05-PLAN.md
  - .planning/phases/04-skills/04-05-SMOKE.md
  - .planning/phases/04-skills/04-05-SUMMARY.md
  - .planning/phases/04-skills/04-06-PLAN.md
  - .planning/phases/04-skills/04-06-SMOKE.md
  - .planning/phases/04-skills/04-06-SUMMARY.md
  - .planning/phases/04-skills/04-07-PLAN.md
  - .planning/phases/04-skills/04-07-SMOKE.md
  - .planning/phases/04-skills/04-07-SUMMARY.md
  - .planning/phases/04-skills/04-08-PLAN.md
  - .planning/phases/04-skills/04-08-SMOKE.md
  - .planning/phases/04-skills/04-08-SUMMARY.md
  - .planning/phases/04-skills/04-09-PLAN.md
  - .planning/phases/04-skills/04-09-SMOKE.md
  - .planning/phases/04-skills/04-09-SUMMARY.md
  - .planning/phases/04-skills/04-10-PLAN.md
  - .planning/phases/04-skills/04-10-SMOKE.md
  - .planning/phases/04-skills/04-10-SUMMARY.md
  - .planning/phases/04-skills/04-11-PLAN.md
  - .planning/phases/04-skills/04-11-SMOKE.md
  - .planning/phases/04-skills/04-11-SUMMARY.md
  - .planning/phases/04-skills/04-12-PLAN.md
  - .planning/phases/04-skills/04-12-SUMMARY.md
  - .planning/phases/04-skills/04-BASELINE.md
  - .planning/phases/04-skills/04-CHECK.md
  - .planning/phases/04-skills/04-CONTEXT.md
  - .planning/phases/04-skills/04-PATTERNS.md
  - .planning/phases/04-skills/04-PROOF.md
  - .planning/phases/04-skills/04-RESEARCH.md
  - .planning/phases/04-skills/04-VALIDATION.md
  - .planning/phases/04-skills/COVERAGE.md
  - infra/vps/substrate-skills-bridge.service
  - infra/vps/substrate-skills-bridge.timer
  - infra/vps/substrate-skills-sync.service
  - infra/vps/substrate-skills-sync.timer
  - packages/cli/src/index.ts
  - packages/collectors/src/cursor-stop.test.ts
  - packages/collectors/src/cursor-stop.ts
  - packages/host/src/main.ts
  - packages/host/src/options.test.ts
  - packages/host/src/options.ts
  - packages/host/src/vm.ts
  - packages/mcp-server/src/mcp.test.ts
  - packages/mcp-server/src/mcp.ts
  - packages/mcp-server/src/redact.test.ts
  - packages/mcp-server/src/redact.ts
  - packages/mcp-server/src/server.test.ts
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/service.test.ts
  - packages/mcp-server/src/service.ts
  - packages/mcp-server/src/skills/frontmatter.ts
  - packages/mcp-server/src/skills/propose-auth.ts
  - packages/mcp-server/src/skills/propose.test.ts
  - packages/mcp-server/src/skills/propose.ts
  - packages/mcp-server/src/types.ts
  - packages/miner/hermes/substrate-skill-miner-monitor.sh
  - packages/miner/pyproject.toml
  - packages/miner/skills/substrate-skill-miner/SKILL.md
  - packages/miner/src/substrate_miner/__init__.py
  - packages/miner/src/substrate_miner/__main__.py
  - packages/miner/src/substrate_miner/bridge.py
  - packages/miner/src/substrate_miner/monitor.py
  - packages/miner/tests/test_bridge.py
  - packages/miner/tests/test_monitor.py
  - packages/projector/omp/substrate-skills.test.ts
  - packages/projector/omp/substrate-skills.ts
  - packages/projector/src/cursor.ts
  - packages/projector/src/skills-sync.test.ts
  - packages/projector/src/skills-sync.ts
  - packages/projector/src/skills.test.ts
  - packages/projector/src/skills.ts
covered_digest: "v1:sha256:b616508e4c767c7bfe48774f4a2ac506f77b94337c660dd73d173391d93b3c96"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 4: Skills Verification Report

**Phase Goal:** One git-backed library every agent reads; the three existing miners propose into it.
**Verified:** 2026-09-27T05:43:48Z
**Status:** passed
**Re-verification:** No (initial verification)
**Tracking:** SPE-3970

Must-haves are the five ROADMAP success criteria plus the re-scoped Proof. Plan frontmatter truths
restate these criteria, so they were deduplicated into them. No plan declares `requirements:` and
there is no `.planning/REQUIREMENTS.md`, so there are no requirement IDs to cross-reference.

Owner acceptances that shape this verification (verbatim):

- **D-22** (2026-09-26, the proof source is Omp): "We're suppose to be builidng this using Omp not Cursor Agent. If we use Cursor Agent we can't use our Claude Pro Max 20x plan". ROADMAP Proof was re-scoped in 84c2ebc. SC-3's Cursor projection is checked at file level instead of through the Cursor `/` menu.
- **04-12 merge delegated** (one-time exception to D-16): "Authorize agent to merge #7". The option text was: "You authorize a one-time exception to D-16: I run `gh pr merge 7 --squash` and the proof records `owner_merge=delegated` with your answer verbatim." This is recorded in 04-PROOF.md as `owner_merge=delegated`.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC-1: `/root/agent-skills` is a git checkout of `swcstudiospace/agent-skills` with the real content vendored. All 26 symlinks are dereferenced and no agent has a dangling link. | ✓ VERIFIED | Live: `origin` is `https://github.com/swcstudiospace/agent-skills.git`, HEAD is `df0db4e` (the PR #7 merge), porcelain shows 0 lines, and `find -type l` outside `.git` finds 0 links. There are 42 `SKILL.md` files (the 40 vendored plus #1 and #7). `find -xtype l` finds 0 dangling links in `~/.claude/skills`, `~/.grok/skills`, `~/.agents/skills`, `~/.config/muse/skills`, `~/.openclaw/skills` and `~/.hermes/skills`. Vendor commit `6e34790` reads "40 skills …, symlinks dereferenced". 04-01 counted 26 links before the swap and 04-02-SMOKE records `checkout_links=0` and `new_dangling_links=0`. |
| 2 | SC-2: the docs-scraper pipeline publishes into the repo instead of its own exports dir. | ✓ VERIFIED | `batch_docs_skills.py` (workspace commit `0d7c2d6`) builds `propose_argv`, which is `bun packages/cli/src/index.ts skills propose --dir <export> --surface docs-scraper --allow-doc-examples pem,jwt --replace`, and `_propose_skill` runs it through `subprocess.run` with no shell. The script has 0 `os.symlink`/`symlink_to` calls. The CLI accepts every flag (index.ts:9-10, 248-255). 04-10-SMOKE: a real export re-proposed as `unchanged`, the docs-scraper skill was proposed as PR #2 (only file `docs-scraper/SKILL.md`), and `no_symlink_writes=true`. Live: PR #2 is OPEN and waiting for the owner (D-16). |
| 3 | SC-3: each agent gets a projection. Claude Code and Grok Build have symlinks, Hermes has `skills.external_dirs`, and Omp, Muse, Cursor `.agents/skills` and rivet-agentos VMs are covered. | ✓ VERIFIED | Live: the claude, grok, agents and muse roots each hold 42 links into `/root/agent-skills/`, matching the 42 skills. `hermes config get skills.external_dirs` returns `/root/agent-skills`, and no Hermes-local skill name shadows a library name (the intersection is empty). `omp config get skills.customDirectories` returns `["/root/agent-skills"]`. For Cursor, per D-22: 42 `~/.agents/skills` links, no `disable-agents-root`/`enable-cursor-root` flag file, and 04-PROOF has `sc3_cursor_file_level=true` and `agents_link=true`. For rivet: `main.ts` defaults `libraryDir=/root/agent-skills` with mount route `nested`, `vm.ts:431` adds `libraryMounts()` to every VM's mounts, and `options.ts` `hostDirMount` is `readOnly: true` at both levels. The host journal shows `library /root/agent-skills mounts nested` (latest start 15:10Z) and `vm skills ut-mui646lx-8f314a85 mounted 41 (nested)`. 04-06-SMOKE: `vm_read_sha_match=true`, a guest write failed with EROFS, and `host_library_clean=true`. `substrate-skills-sync.timer` is active on a 5-minute cadence, with `actions=0 warnings=0` at every tick in the last 30 minutes. |
| 4 | SC-4: Hermes `/learn`, Omp's skill creator and Grok Build `/autolearn` all call `skills.propose`, which opens a branch and PR rather than publishing live. | ✓ VERIFIED | **Hermes:** `/learn` → `build_learn_prompt`, which authors only through `skill_manage` (learn_prompt.py:2-6, 172-184). `skill_manage` stages behind `write_approval` (skill_manager_tool.py:615-628, now `true`). `bridge.py` drains `~/.hermes/pending/skills` into `POST /skills/propose`. 04-07-SMOKE: `staged_via_gate=true` → PR #5, `hermes_local_write=false`. **Omp:** the extension symlink resolves to `packages/projector/omp/substrate-skills.ts`, which blocks `manage_skill` create/update and `learn` skill payloads and proposes them. `managed-skills` is absent. PR #3 (04-08) and PR #7 (the proof, a real session) came from it. **Grok:** `skill_write.py`/`improve.py` call `propose_skill` → `/skills/propose` and queue to pending when the substrate is down. The installed plugin matches the source (`diff -rq -x __pycache__` exit 0). The live CLI propose opened PR #4. **Branch + PR:** live, #3/#4/#5 are OPEN on `skill/<surface>/…` heads with one `SKILL.md` each, and none is in the library. Anonymous `POST /skills/propose` returns 401. |
| 5 | SC-5: Hermes runs hourly as the primary miner, and `skills.write_approval` and `memory.write_approval` are on. | ✓ VERIFIED | Live: `hermes cron list` shows `substrate-skill-miner` on `0 * * * *` with the monitor `substrate-skill-miner-monitor.sh`, last run 2026-09-27T15:00:20+10:00 `ok`. The job directory holds 20 hourly output docs since creation on 2026-09-26, 18 of them `no_change (agent run suppressed)`. Both `write_approval` keys return `true`. The bridge timer is active on a 5-minute cadence. |
| 6 | Proof (re-scoped by D-22): a skill mined from a real Omp session is merged and appears in Claude Code and Grok Build without either being touched. | ✓ VERIFIED | 04-PROOF.md has `proof_result=pass`. Omp session `01a0dfe8-…` made a blocked `manage_skill` create, which became PR #7 with body `surface: omp` and `session_id: 01a0dfe8-…`. Live, `gh pr view 7` shows MERGED at 2026-09-27T03:26:59Z. The timer, not a manual sync, fast-forwarded to `df0db4e` and linked claude/grok/agents/muse at 03:29:05Z, 126 s after the merge. `grok inspect` went from 0 to 1 and the Claude init lists the skill. Config mtimes are unchanged (1790356194 and 1790447779, both at or before the merge epoch). Live now: the `substrate-skills-sync-audit` links exist in all four roots (part of the 42/42). |

**Score:** 6/6 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/mcp-server/src/skills/propose.ts`, `propose-auth.ts`, `server.ts`, `mcp.ts` | Propose core, `POST /skills/propose`, `skills_propose` tool, host-key gate | ✓ VERIFIED | Route at server.ts:156 and tool at mcp.ts:144, both gated. Live anonymous request is refused with 401. `propose.test.ts` passes. |
| `packages/cli/src/index.ts` | `skills propose --dir …` | ✓ VERIFIED | Wired to docs-scraper and to the Hermes bridge's publish hint. |
| `packages/projector/src/skills.ts`, `skills-sync.ts`, `cursor.ts`; `infra/vps/substrate-skills-sync.*` | ff-only sync and per-root projection, plus the Cursor hook entry | ✓ VERIFIED | Units are byte-equal to `/etc/systemd/system`. The timer is active. The projector journal shows `actions=0 warnings=0`. |
| `packages/host/src/options.ts`, `vm.ts`, `main.ts` | Read-only library in every VM (D-08) | ✓ VERIFIED | Wired at vm.ts:431, with the nested route live. |
| `packages/miner/src/substrate_miner/bridge.py`, `monitor.py`, `hermes/substrate-skill-miner-monitor.sh`; `infra/vps/substrate-skills-bridge.*` | Hermes, Omp and Grok queue drain, and the cron precheck | ✓ VERIFIED | Bridge timer active. Hourly ticks are suppressed while the monitor output is unchanged. |
| `packages/projector/omp/substrate-skills.ts` | Omp `tool_call` intercept with `session_id` provenance | ✓ VERIFIED | Symlinked into `~/.omp/agent/extensions/`. Four `getSessionId` references. |
| `packages/collectors/src/cursor-stop.ts` | Cursor stop hook (off the proof path per D-22) | ✓ VERIFIED | `~/.cursor/hooks.json` `stop` has the substrate entry `bun …/cursor-stop.ts … \|\| true`, beside the pre-existing gsd entry. |
| `/root/src/repos/skill-autonomy/src/skill_autonomy/propose.py` (external repo, commit `394d5ea`) | Grok propose client | ✓ VERIFIED | Installed copy is identical. Repo porcelain shows 0 lines. |
| `/root/.openclaw/workspace/projects/docs-scraper/scripts/batch_docs_skills.py` (external, `0d7c2d6`) | Publishes through propose | ✓ VERIFIED | See truth 2. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| docs-scraper batch | substrate CLI | `subprocess.run(propose_argv(...))` | WIRED | Parses the `status=`/`pr_url=` stdout into batch state. |
| Hermes `/learn` → `skill_manage` | `~/.hermes/pending/skills` | `write_approval.stage_write` | WIRED | `skills.write_approval=true` live. |
| bridge.py | `POST /skills/propose` | `ProposeClient.post` with the key header | WIRED | PR #5 (Hermes) and the proof's `existing` re-post of the Omp queue file (bridge-log). |
| Omp `manage_skill`/`learn` | `/skills/propose`, or `substrate-pending` when that fails | `pi.on("tool_call", handler)` | WIRED | PR #3 and PR #7. |
| Grok `write_skill`/`improve`/SessionEnd | `/skills/propose`, or plugin `pending/` when that fails | `propose_skill` | WIRED | PR #4. `test_improve`/`test_hooks` pass. |
| Library merge | agent roots | `substrate-skills-sync.timer` → `skills-sync.ts` → projector | WIRED | Tracer 71 s (04-04), proof 126 s (04-12). |
| Library | rivet VM | `libraryMounts()` → `host_dir` readOnly | WIRED | `mounted 41 (nested)` journal line. |

### Data-Flow Trace (Level 4)

| Artifact | Data | Source | Produces Real Data | Status |
|----------|------|--------|--------------------|--------|
| Agent skill roots | skill dirs | `git ls` of the library at HEAD after ff | Yes (42 = 42) | ✓ FLOWING |
| PR body provenance | `session_id` | Omp `ctx.sessionManager.getSessionId()` | Yes (PR #7 id = session file id) | ✓ FLOWING |
| VM skills dir | `/home/agentos/.claude/skills/<name>` | `listLibrary(libraryDir)` at VM creation | Yes (in-guest sha256 matches the host) | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Propose core, Omp extension, projector, sync, VM options and Cursor hook tests | `bun test` on the 6 phase test files (omp/substrate-skills, skills/propose, skills-sync, skills, host/options, cursor-stop) | 151 pass, 0 fail | ✓ PASS |
| Hermes bridge and monitor | `uv run pytest -q packages/miner/tests` | 50 passed | ✓ PASS |
| Grok propose, autolearn and hook | `pytest -q tests/test_improve.py tests/test_hooks.py tests/test_propose.py` (skill-autonomy) | 31 passed | ✓ PASS |
| Propose route refuses anonymous callers | `curl -X POST 127.0.0.1:7410/skills/propose` | 401 (healthz 200) | ✓ PASS |
| Services | `systemctl is-active substrate-mcp substrate-host substrate-skills-sync.timer substrate-skills-bridge.timer` | active ×4 | ✓ PASS |
| Hermes gates and cron | `hermes config get …write_approval`; `hermes cron list` | true, true; `0 * * * *`, last run ok | ✓ PASS |
| PR states | `gh pr view 2..7 -R swcstudiospace/agent-skills` | #2–#6 OPEN, #7 MERGED 03:26:59Z | ✓ PASS |

The full suites were not re-run here. The orchestrator's gate at c3aced8 plus 04-12 records bun 534 pass / 0 fail, tsc-exit=0 and dispatcher 149 passed, and 04-12 Task 1 measured 534 as well.

### Probe Execution

None declared. No `scripts/*/tests/probe-*.sh` is referenced by any Phase 4 PLAN or SUMMARY. The phase's runnable checks are the PLAN `<automated>` blocks, recorded in the SMOKE/TRACER/PROOF files, plus the live spot-checks above.

### Requirements Coverage

No requirement IDs: every Phase 4 plan has `requirements: []` and the repo has no `.planning/REQUIREMENTS.md`. The ROADMAP criteria are covered by COVERAGE.md and verified above. Nothing is orphaned.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (all phase code files) | — | `TBD`/`FIXME`/`XXX` | none found | — |
| `packages/mcp-server/src/redact.ts` | 177, 189 | `PLACEHOLDER_PREFIXES` | ℹ️ Info | A redaction allow-list constant, not a stub. |

### Info (non-blocking)

- ROADMAP Phase 4 still reads "11/12 plans executed" and has 04-12 unchecked. This is a bookkeeping lag for the orchestrator, and ROADMAP.md is left out of `covered_files` so that edit does not stale the digest.
- COVERAGE.md's SC-4 Omp row names `proof_pr_status=opened`, but the proof recorded `existing`. That was the queued path: the propose outran the 25 s client timeout, the server opened #7, and the bridge re-post was answered `existing`. The plan accepts this under W3. The PR's `createdAt` falls after `t_omp_start`, and its `session_id` ties it to the session.
- PRs #2, #3, #4, #5 and #6 are still OPEN and waiting for the owner's merge (D-16). SC-2 and SC-4 require a PR rather than live publishing, not a merge.
- Hermes `/learn` was not run as a live prompt turn. Its only writer is `skill_manage`, and the live 04-07 gate → PR run went through that same tool.
- Grok `/autolearn --apply` and a live Grok model session were not run live. The propose client is live (PR #4), and the apply/SessionEnd paths are covered by the passing `test_improve`/`test_hooks`.
- The rivet copy route (`mount_route=none`) is covered by unit tests only, because the spike selected `nested`. VM Claude runs `--bare`, so the library is available by path rather than auto-listed (04-06 Gaps).
- Hermes' own `skill_manage` gate fails open if `tools.write_approval` cannot be imported (upstream Hermes code, not changed in this phase).
- Grok `config.toml` mtime moved between the Setup and the Omp-route baseline, before the proof window. The gating merge → observation window shows no change.

### Human Verification Required

None. The owner decisions that would otherwise need a human (D-22 proof route, the delegated merge of #7) are already recorded verbatim above and in 04-PROOF.md.

### Gaps Summary

No gaps. The library is a clean git checkout with no symlinks and no dangling links in any agent root. Every in-scope agent projects it: Claude/Grok/Cursor/Muse by links, Hermes by `external_dirs`, Omp by `customDirectories`, and rivet VMs by read-only mounts. The docs-scraper, Hermes, Omp and Grok write paths all reach `/skills/propose` and produce branch+PRs. The hourly Hermes miner is live with both write-approval gates on. The D-22 proof passed end to end, with the timer alone delivering an Omp-mined skill to Claude Code and Grok Build 126 s after the merge.

---

_Verified: 2026-09-27T05:43:48Z_
_Verifier: Claude (gsd-verifier)_
