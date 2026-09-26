# Coverage — Phase 4 (Skills)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> Plans: 04-01 (baselines, rollback area, external git baselines, rivet mount spike), 04-02 (skill redactor, scan report, private repo, mirror, checkout swap),
> 04-03 (propose core, CLI, route, MCP tool, caller check — tracer near end), 04-04 (sync timer, Claude/Grok projection, tracer merge and arrival — tracer far end),
> 04-05 (Cursor .agents, Muse, OpenClaw, Grok copies), 04-06 (VM mounts or D-08 copy), 04-07 (Hermes projection, bridge, cron miner), 04-08 (Omp extension and config),
> 04-09 (Grok skill-autonomy), 04-10 (docs-scraper publish), 04-11 (Cursor transcript capture), 04-12 (proof).
> Revised after `04-PLAN-CHECK.md` (B1, B2, W1-W10): the former 04-03 is split into 04-03 + 04-04 and the later plans are renumbered.
> Task references are `plan / task` (e.g. 04-03 T1).

## ROADMAP success criteria and proof → plan/task

| Criterion | Covered by | Evidence key(s) |
|---|---|---|
| SC-1 `/root/agent-skills` is a git checkout of `swcstudiospace/agent-skills` with the real content vendored — all 26 symlinks dereferenced, no dangling links for any agent | 04-01 T1 (inventory: 41 entries, 26 links, dangling-link list), 04-02 T1 (vendor scratch: links 0, pyc 0), 04-02 T3 (repo, push, swap) | 04-02-SMOKE.md `checkout_links=0`, `checkout_skill_md=40`, `new_dangling_links=0`, `grok_script_paths_missing=0`, `repo_visibility=PRIVATE` |
| SC-2 The docs-scraper pipeline publishes into the repo instead of its own exports dir | 04-03 T1 (CLI `skills propose --dir`, `--allow-doc-examples`, `--dry-run`), 04-10 T1 (`_propose_skill`, no symlinks, no README rewrite), 04-10 T2 (live) | 04-10-SMOKE.md `unchanged_status=unchanged`, `docs_scraper_skill_status` (opened/existing PR whose only file is docs-scraper/SKILL.md, built outside the checkout — B1), `workspace_skill_link` unchanged, `no_symlink_writes=true`, `library_clean=true` |
| SC-3 Projection: Claude Code and Grok Build symlinks | 04-04 T1 (projector, timer), 04-04 T3 (tracer arrival), 04-05 T1/T2 (Grok identical copies → links) | 04-04-TRACER.md `claude_library_links=40`, `grok_library_links=30`, `claude_init_lists=true`, `grok_inspect_lists=true`; 04-05-SMOKE.md `grok_backups=10` |
| SC-3 Hermes `skills.external_dirs` | 04-07 T1 (write_approval on before external_dirs — W11) | 04-07-SMOKE.md `external_dirs_set=true`, `write_approval_before_external_dirs=true`, `foreground_library_write_staged=true`, `hermes_links_removed=33`, `hermes_lists_all_library=true` |
| SC-3 Omp | 04-08 T2 (`skills.customDirectories`) | 04-08-SMOKE.md `custom_directories=/root/agent-skills`, `omp_library_loaded` = `library_count` |
| SC-3 Muse | 04-05 T1/T2 (`~/.config/muse/skills` links) | 04-05-SMOKE.md `muse_library_links`, `muse_lists_library=true` |
| SC-3 Cursor `.agents/skills` | 04-05 T1/T2 (links), 04-12 T2/T3 (owner confirms Cursor lists them; D-20 flags), 04-12 T4/T5 (menu re-checked after any flag change — W8) | 04-05-SMOKE.md `agents_library_links`; 04-PROOF.md `cursor_skill_menu`, `d20_action`, `cursor_menu_final`, `sc3_cursor_visible=true` |
| SC-3 rivet-agentos VM writes | 04-01 T3 (spike), 04-06 T1/T2 (read-only mounts per new VM, or D-08's copy at VM boot when the spike says none — W7) | 04-01-SPIKE.md `mount_route`; 04-06-SMOKE.md `vm_library_listed`, `vm_read_sha_match=true`, `vm_mounted_write≠succeeded` (mount routes) or `vm_copy_ms` (copy), `host_library_clean=true` |
| SC-4 Hermes `/learn` → `skills.propose` (branch + PR, not live) | 04-03 T1/T2 (propose core, route), 04-07 T2 (bridge: library-scoped, changed files only), 04-07 T3 (gate-staged write → PR; Hermes-local write held) | 04-07-SMOKE.md `staged_via_gate=true`, `bridge_status=opened`, `bridge_pr_changed_files=1`, `held_local_status=held`, `hermes_local_write=false` |
| SC-4 Omp skill creator → `skills.propose` | 04-08 T1 (extension), 04-08 T2 (live Omp session) | 04-08-SMOKE.md `omp_blocked_with_pr=true`, `omp_managed_skill_written=false` |
| SC-4 Grok Build `/autolearn` → `skills.propose` | 04-09 T1 (plugin), 04-09 T2 (reinstall, live propose and pending) | 04-09-SMOKE.md `grok_propose_status`, `grok_pending_status=pending`, `grok_new_real_skill_dirs=0` |
| SC-4 MCP name `skills_propose` | 04-03 T2 | 04-03-TRACER.md `mcp_tools_list_has_skills_propose=true`, `mcp_anonymous_refused=true`, `route_anonymous=401` (VM guests refused — W4) |
| SC-5 Hermes runs hourly as primary miner | 04-07 T2 (monitor precheck), 04-07 T3 (cron `0 * * * *` bound to the shim, no manual run), 04-12 T1 (scheduled ticks since 04-07 read back, one suppressed — W5), 04-12 T3 (miner run in the proof) | 04-07-SMOKE.md `cron_schedule=0 * * * *`, `cron_skill=substrate-skill-miner`, `cron_monitor_bound`, `cron_manual_runs=0`; 04-PROOF.md `sched_suppressed_ticks≥1`, `sched_docs_off_schedule=0`, `t_miner_run` |
| SC-5 `skills.write_approval` and `memory.write_approval` on | 04-07 T3 | 04-07-SMOKE.md `skills_write_approval=true`, `memory_write_approval=true`, pending-memory count unchanged |
| **Proof** — a skill mined from a Cursor session is merged and appears in Claude Code and Grok Build without either being touched | 04-11 T1/T2 (capture), 04-07 T2/T3 (miner, bridge), 04-04 T1 (timer, projector), 04-12 T1–T5 | 04-PROOF.md `proof_skill_source=cursor:<id>`, `claude_init_lists=true`, `grok_inspect_lists=true`, `claude_grok_touched=false`, `manual_sync_after_merge=false`, `proof_result=pass` |

## Decisions D-01..D-21 → plan/task

| Decision | Covered by | How |
|---|---|---|
| D-01 private repo `swcstudiospace/agent-skills`, default `main` | 04-02 T3 | `gh repo create --private` under `env -i HOME=/root` (in-plan, research Q6); visibility and default branch verified |
| D-02 vendor exactly the 40 entries + README, deref links, drop pyc, plain git | 04-01 T1 (counts), 04-02 T1 (scratch vendor + scan), 04-02 T3 (commit by explicit path) | 40 SKILL.md, 0 links, 0 pyc in checkout |
| D-03 scratch build, snapshot old dir with RESTORE, replace by clone, paths stay valid | 04-02 T3 | snapshot + manifest + RESTORE.d/04-02.md; clone-then-two-renames; Grok script paths checked |
| D-04 agents never write the checkout; 5-min ff-only sync timer, refuse dirty/diverged with a warning | 04-04 T1 (skills-sync.ts, units), 04-04 T3 (delivery), 04-10 T2 (docs-scraper skill proposed from a scratch copy, never through its workspace symlink into the checkout — B1), 04-07 T1/T2/T3 (Hermes: write_approval before external_dirs, held library records never approved locally, clean checkout and no dirty sync refusal across the plan — W11) | `decide()` tests; timer enabled; checkout clean checks in every later plan |
| D-05 projection per agent (Claude/Grok links; `.agents` for Cursor; Hermes external_dirs; Omp customDirectories; Muse) | 04-04 T1 (Claude, Grok), 04-05 (`.agents`, Muse), 04-07 T1 (Hermes), 04-08 T2 (Omp), 04-12 T2/T4 (Cursor reads it) | Muse via `~/.config/muse/skills` links (research Q3), plugin `capabilities.skills` untouched |
| D-06 collisions: never overwrite real dirs; identical copies backed up then linked; differing skipped + warning; export links repointed (Grok, OpenClaw) | 04-04 T1 (Grok repoint, skip-warn), 04-05 T1/T2 (backup-then-link, OpenClaw repoint) | Hermes' export links are removed rather than repointed (D-07; research Q13 correction) |
| D-07 Hermes local beats external: remove shadowing links; library canonical for anda-ecosystem | 04-07 T1 | 33 links removed after external_dirs verified (Pitfall 2); anda moved to backup after content equality |
| D-08 VMs get ultrathink skills + library, read per VM creation; prefer read-only mount, otherwise copy; Phase-3 seed tests green | 04-01 T3 (spike), 04-06 T1/T2 | nested/sibling mounts, or on `mount_route=none` the copy route in vm.ts `onVmStart` (W7 — no stop branch; marker written only after a complete copy, parent dirs created — I17); seed.ts/tasks.ts and their tests unchanged since the baseline head |
| D-09 `skills_propose` + `POST /skills/propose`; validation, redaction, scratch clone, branch, PR, `skill.propose` event; CLI `--dir` shares the path | 04-03 T1 (core, CLI), 04-03 T2 (route, tool, event, caller check) | mirror + shared clone (research Q11); ledger idempotence via `gh pr view`/`gh pr list --head` (W1); owner-closed identical content answered `declined`, not re-opened (I19); overlay tree semantics, `remove`, CLI-only `--replace` (W2); authenticated surface or host propose key, VM guests refused (W4); 30 s budget recorded for Omp |
| D-10 Hermes write_approval ×2; bridge rebuilds from pending, proposes, rejects the pending entry; memory left to the owner | 04-07 T2 (bridge), 04-07 T3 (config, live) | pending/memory never read; unlink = Hermes' reject semantics, only after a 200 or 400 reply; Hermes-local and unproposable writes held for the owner (W3); 413/oversize held (W2); write_approval on before external_dirs, and a held library-skill record is resolved only by a propose PR or a rejection, never `/skills approve` (W11) |
| D-11 Omp autolearn on; tool_call intercept of manage_skill/learn; block local write; return PR URL | 04-08 T1, 04-08 T2 | location per D-17; learn strips the skill so the memory lands |
| D-12 skill-autonomy git baseline; write_skill + Stop hook → propose; rule updated; pending when down; reinstall | 04-01 T2 (baseline: every non-ignored file incl. `.grok-plugin/`, `.gitignore` kept, porcelain empty — B2), 04-09 T1, 04-09 T2 | pending drained by the 04-07 bridge |
| D-13 Hermes cron `substrate-skill-miner` hourly with a precheck; mines Cursor transcripts, events, other sessions; writes via staged skill_manage | 04-03 T1 (miner skill as the tracer), 04-07 T2 (monitor), 04-07 T3 (cron), 04-12 T3 | precheck = deterministic `--monitor-script` output (unchanged hour → no LLM run) plus a daily `day` line so other surfaces are still mined |
| D-14 docs-scraper publishes via `substrate skills propose --dir`; no symlinks, no README rewrite; baseline commit first | 04-01 T2 (baseline), 04-10 T1 (snapshot + RESTORE first — W6), 04-10 T2 | path-scoped script commit in the OpenClaw workspace; its own skill update reaches the library only as a PR (B1) |
| D-15 Cursor stop hook reads stdin, copies redacted transcript, emits session.end with the ref; try headless CLI, else owner session; never synthetic | 04-11 T1/T2, 04-12 T1 (cursor-agent status), 04-12 T2 (owner session) | live checks use null/out-of-root paths only |
| D-16 owner merges library PRs | 04-04 T2, 04-12 T4 | the executor never merges; smoke PRs listed for the owner |
| D-17 Omp interception in a standalone substrate extension symlinked into `~/.omp/agent/extensions/`; omp-ultrathink stays disabled | 04-08 T1, 04-08 T2 | verify reads the plugin lock (enabled false); omp-ultrathink not in any files_modified |
| D-18 vendor raw after owner-reviewed scan; `redactSkillContent` on every propose; `--allow-doc-examples pem,jwt` for docs-scraper; event redactor unchanged | 04-02 T1 (redactor + scan), 04-02 T2 (review), 04-03 T1/T2 (every propose; route never allows examples), 04-10 T1/T2 | existing redact tests untouched and green |
| D-19 add `docs-scraper` to SURFACES | 04-03 T1 | types.ts; used by 04-10 |
| D-20 keep `~/.agents/skills` links; drop only if Cursor lists duplicates | 04-05 T1 (flag files), 04-12 T2/T3, 04-12 T4 (re-check after a flag change) | `disable-agents-root` removes only the projector's own links on the next tick |
| D-21 owner checkpoints: scan report, tracer merge, one Cursor session, proof merge | 04-02 T2, 04-04 T2, 04-12 T2, 04-12 T4 | four blocking checkpoints; the W8 Cursor re-check rides on the proof-merge checkpoint, so no fifth owner stop (repo creation is in-plan) |

## Standing rules → plan/task

| Rule | Covered by |
|---|---|
| Two-sided gates against a measured `04-BASELINE.md` | 04-01 T1; every code task's `<automated>` (bun + tsc; dispatcher in 04-04 T1 and 04-07 T2; skill-autonomy in 04-09 T1; miner in 04-07 T2) |
| Snapshot under `/var/lib/substrate/phase4-baseline/` with a RESTORE route before any live edit | 04-01 T1 (index, t0), then RESTORE.d/04-02 … 04-11 (04-03: propose key; 04-04: sync units; 04-07: bridge units, monitor shim, cron, write_approval — W6; 04-10: batch script — W6); the projector's per-run RESTORE.md |
| Read `/var/lib/substrate/phase1-baseline/RESTORE.md` before touching a Phase 1 file | none touched (D-17 keeps omp-ultrathink unedited); stated in the RESTORE index |
| Never print secrets; substrate.env only via `sudo grep -c` | 04-02 T3 (`gh_token_in_env_file=0`), evidence token-shape greps in every live verify |
| Explicit-path staging; `Refs SPE-2734` + `Refs SPE-3576` | every task action; commit subjects checked in 04-01 T1/T2, 04-09 T1, 04-10 T1 |
| Fail open on every hook; redact before emitting | 04-11 (Cursor stop hook), 04-08 (Omp handler never throws), projector/sync warnings fail-open |

## Capability coverage (INTEGRATE / OPT-OUT)

| capability | decision | reason |
|---|---|---|
| GitHub: `gh repo create --private` | INTEGRATE | D-01, 04-02 |
| GitHub: git push of the vendored main (47 MB, once) | INTEGRATE | 04-02 |
| GitHub: bare mirror clone + fetch main | INTEGRATE | propose path, 04-02/04-03 |
| GitHub: `gh pr create`, `gh pr list --head <branch>`, `gh pr view`, `gh pr diff` | INTEGRATE | propose idempotence (ledger + strongly consistent lookups, W1), checkpoints, proof |
| GitHub: `gh pr list --search` (search index) | OPT-OUT | eventually consistent — would open duplicate PRs on an immediate re-propose (checker W1) |
| GitHub: merge, branch deletion, force push, repo delete | OPT-OUT | explicitly out of scope — the owner merges (D-16); no force; delete is an owner-only RESTORE route |
| GitHub: webhook for instant sync | OPT-OUT | deferred — needs public ingress (CONTEXT § Deferred) |
| substrate-mcp: `skills_propose` MCP tool, `POST /skills/propose` | INTEGRATE | D-09, 04-03 |
| substrate-mcp: host propose key (`x-substrate-propose-key`, /var/lib/substrate/skills/propose.key) for propose only | INTEGRATE | checker W4 — keeps anonymous rivet VM guests from spending the PAT without turning on global bearer auth; 04-03, used by 04-07/04-08/04-09 |
| substrate-mcp: `skill.propose` event kind, `docs-scraper` surface | INTEGRATE | D-09, D-19 |
| substrate-mcp: `SUBSTRATE_TOKEN_*` bearer auth for every route | OPT-OUT | not needed yet — anonymous loopback (127.0.0.1 bind checked); enabling it would 401 every Phase 1 surface; propose alone is gated by the host key above (an authenticated surface is also accepted there) |
| Claude Code: `~/.claude/skills` symlinks; init `slash_commands` probe | INTEGRATE | 04-04 |
| Grok Build: `~/.grok/skills` symlinks; `grok inspect`; `grok plugin update` | INTEGRATE | 04-04, 04-05, 04-09 |
| Grok Build: `[skills] paths` config | OPT-OUT | not needed — per-skill links hot-reload and keep Grok's own skills in place |
| Hermes: `skills.external_dirs`, `skills.write_approval`, `memory.write_approval`, `hermes cron create --monitor-script --skill`, `skill_manage` gate | INTEGRATE | 04-07 |
| Hermes: approving pending memory writes | OPT-OUT | explicitly out of scope — left to the owner's `/memory pending` (D-10) |
| Omp: extension `tool_call` (block / input / additionalContext), `skills.customDirectories`, `autolearn.enabled` | INTEGRATE | 04-08 |
| Omp: omp-ultrathink plugin | OPT-OUT | D-17 — stays disabled and unedited |
| Muse: `~/.config/muse/skills` symlinks | INTEGRATE | 04-05 (research Q3 probe) |
| Muse: plugin `capabilities.skills` / `muse skills install` | OPT-OUT | not needed — copies 47 MB and reinstalls per sync (research Q3) |
| Cursor: `~/.agents/skills` links; `stop` hook stdin (`conversation_id`, `transcript_path`) | INTEGRATE | 04-05, 04-11 |
| Cursor: `~/.cursor/skills` links | INTEGRATE (conditional) | only if the owner reports Cursor ignores `~/.agents/skills` (flag in 04-05, set in 04-12) |
| Cursor: headless `cursor-agent` | OPT-OUT | not signed in and fires no hooks in print mode (research Summary 4); status recorded in 04-12 |
| OpenClaw: repoint export links; `skills.load.extraDirs` | INTEGRATE | 04-05 (repoint); extraDirs already names /root/agent-skills (unchanged) |
| rivet agentOS: `host_dir` read-only mounts per VM | INTEGRATE | 04-01 spike, 04-06 |
| rivet agentOS: copying the library into VMs per VM boot (`onVmStart`) | INTEGRATE (conditional) | D-08's "otherwise copy": used only when 04-01's spike records `mount_route=none`; planned in 04-06 without Phase-3 file edits (checker W7) |
| Codex / OpenCode / Pi / Gemini projection | OPT-OUT | explicitly out of scope — CONTEXT § Deferred |
| Absorbing each agent's own authored skills into the library | OPT-OUT | explicitly out of scope — CONTEXT § Deferred; the 04-07 bridge holds Hermes-local writes instead of proposing them (checker W3) |
| Scheduling the docs-scraper crawl | OPT-OUT | explicitly out of scope — CONTEXT § Deferred |
