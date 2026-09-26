# Phase 4: Skills - Context

**Gathered:** 2026-09-25
**Status:** Ready for planning

<domain>
## Phase Boundary

One git-backed skills library every agent reads; the three existing miners propose into it.

ROADMAP success criteria:
1. `/root/agent-skills` is a git checkout of `swcstudiospace/agent-skills` with the real content vendored — all 26 symlinks dereferenced, no dangling links for any agent.
2. The docs-scraper pipeline publishes into the repo instead of its own exports dir.
3. Projection per agent: Claude Code and Grok Build symlinks, Hermes `skills.external_dirs`, Omp, Muse, Cursor `.agents/skills`, and rivet-agentos VM writes.
4. Hermes `/learn`, Omp's skill creator and Grok Build `/autolearn` all call `skills.propose` (MCP name `skills_propose`), which opens a branch and PR rather than publishing live.
5. Hermes runs hourly as primary miner; `skills.write_approval` and `memory.write_approval` are on.

Proof: a skill mined from a Cursor session is merged and appears in Claude Code and Grok Build without either being touched.

Depends on Phase 1 only (not Phase 3). Phase 3 is blocked at 03-10 (Telegram approvals off by owner decision, 2026-09-26). Phase 4 must not change Phase 3's pending plans or the substrate-host behaviour those plans rely on, except for the skills source (D-08).

Not in this phase: absorbing each agent's own authored skills into the library; Codex/OpenCode/Pi/Gemini/OpenClaw projection beyond repointing OpenClaw's existing links (D-06); a public ingress/webhook; scheduling the docs-scraper crawl itself.

</domain>

<decisions>
## Implementation Decisions

### Library repo and migration
- **D-01:** Create `swcstudiospace/agent-skills` as a **private** repo, default branch `main`. The scraped third-party docs make public licensing unclear; this matches agent-substrate's visibility. — **Reversibility:** reversible.
- **D-02:** Vendor exactly the 40 entries in `/root/agent-skills`: 14 real dirs plus 26 dereferenced symlinks (25 from the docs-scraper exports dir, `anda-ecosystem` from `~/.hermes/skills/research/`), about 47 MB and 2,421 files. The README comes along too. Plain git, no LFS, no links, no submodules; drop `__pycache__`/`*.pyc`. Each agent's own authored skills stay where they are (Claude 74, Cursor 72, `~/.agents` 80, Hermes 206, Grok 20). — **Reversibility:** reversible.
- **D-03:** Build the repo in a scratch dir and push it. Snapshot the old `/root/agent-skills` (links, README, real dirs) under `/var/lib/substrate/phase4-baseline/` with a `RESTORE.md` entry, then replace it with a clone. Every existing `/root/agent-skills/<name>` path stays valid, including the script paths hardcoded in Grok's copied skills. — **Reversibility:** reversible (restore from the snapshot).
- **D-04:** Agents never write the live checkout `/root/agent-skills`. A `substrate-skills-sync` systemd timer runs every 5 min: `git fetch` and `git pull --ff-only` on `main`, then re-runs the skills projector. It refuses to act on a dirty tree or a diverged branch and emits a warning event. Nothing else writes the checkout. — **Reversibility:** reversible.

### Projection (criterion 3)
- **D-05:** A new idempotent `packages/projector/src/skills.ts`, run by the sync timer, so merged skills reach agents with no agent touched. Mechanism per agent:
  - Per-skill symlinks `<dir>/<name> -> /root/agent-skills/<name>` in `~/.claude/skills` and `~/.grok/skills`. Grok hot-reloads; the planner verifies that Claude Code follows a symlinked skill dir.
  - Symlinks in `~/.agents/skills` for Cursor, per the roadmap. The planner verifies Cursor actually reads it; if not, also link into `~/.cursor/skills`.
  - Hermes: `skills.external_dirs: [/root/agent-skills]`.
  - Omp: `skills.customDirectories: [/root/agent-skills]` in `~/.omp/agent/config.yml`.
  - Muse: the substrate plugin's `capabilities.skills` or `~/.config/muse/skills`, whichever the planner's probe shows actually loads.
  — **Reversibility:** reversible.
- **D-06:** Name collisions:
  - Never overwrite a real dir.
  - Real copies byte-identical to the library copy (e.g. the 10 in `~/.grok/skills`) are backed up to the phase-4 baseline, then replaced by links.
  - Differing real copies are skipped and a warning event is emitted.
  - Existing links into the docs-scraper exports dir are repointed to the library: Hermes 21, Grok 23, and OpenClaw's `~/.openclaw/skills` and `~/.openclaw/workspace/skills`.
  — **Reversibility:** reversible.
- **D-07:** Hermes local skills beat `external_dirs` on name collisions. Remove Hermes' local links that shadow library names. The library becomes canonical for `anda-ecosystem`; Hermes' `research/anda-ecosystem` moves to the backup. — **Reversibility:** reversible.
- **D-08:** rivet-agentos VMs seed the ultrathink plugin skills plus the library, read on every `openTask` rather than once at host boot, so a merged skill reaches the next VM. Prefer a rivet read-only mount if the probe shows it works; otherwise copy (about 47 MB per VM). Phase 3's existing seed tests (`seed.test.ts`, `tasks.test.ts`) must stay green, and the ultrathink skills must still be seeded. — **Reversibility:** reversible.

### skills_propose and the three miners (criteria 4-5)
- **D-09:** substrate-mcp gains an MCP tool `skills_propose` and a `POST /skills/propose` route.
  - Input: `{name, files (SKILL.md + small files, body ≤ 1 MB), surface, session_id?, graph_id?, rationale}`.
  - Checks: frontmatter is valid and `name` equals the dir name; content is redacted with the existing redactor patterns; secret-like content is rejected.
  - Git: work in a scratch clone (never the live checkout) on branch `skill/<surface>/<name>-<ts>`, commit, push, `gh pr create`; return the PR URL.
  - Emits a new `skill.propose` event kind.
  - Large dirs (docs-scraper) go through the CLI `substrate skills propose --dir <path>`, which shares the same git code path.
  — **Reversibility:** reversible.
- **D-10:** Hermes: turn on `skills.write_approval: true` and `memory.write_approval: true`.
  - A Python bridge in `packages/miner` reads `~/.hermes/pending/skills/*.json`, rebuilds the skill from the staged `skill_manage` payload, calls `/skills/propose`, then rejects the pending entry and records the PR URL.
  - Staged memory writes are left for the owner's `/memory pending`.
  — **Reversibility:** reversible.
- **D-11:** Omp: set `autolearn.enabled: true`. An omp-ultrathink extension `tool_call` handler intercepts `manage_skill` create/update (and `learn`'s skill payload), calls propose, blocks the local write and returns the PR URL. omp-ultrathink's baseline is path-scoped, so extend it before editing new files. — **Reversibility:** reversible.
- **D-12:** Grok `/autolearn`:
  - First give `/root/src/repos/skill-autonomy` (no `.git`) a git-init baseline.
  - Patch `skill_write.write_skill` and the Stop-hook live learning to call `/skills/propose` instead of writing `~/.grok/skills`, and update `~/.grok/rules/skill-autonomy.md`.
  - If the substrate is down, stage under `~/.grok/plugin-data/skill-autonomy/pending/`; never publish live.
  - Reinstall the plugin.
  — **Reversibility:** reversible.

### Hermes primary miner, docs-scraper, Cursor proof, merge authority
- **D-13:** Hermes cron job `substrate-skill-miner` at `0 * * * *`.
  - A precheck script skips the LLM run when nothing is new since the last watermark.
  - It mines captured Cursor transcripts, substrate events and other surfaces' sessions.
  - It writes via `skill_manage`, which is staged under D-10; the bridge opens the PR.
  — **Reversibility:** reversible.
- **D-14:** docs-scraper publishes through `substrate skills propose --dir <export>` (branch + PR). It stops symlinking into agent dirs and stops rewriting the agent-skills README. It needs a baseline commit in its repo before any edit. — **Reversibility:** reversible.
- **D-15:** Cursor source:
  - Extend the substrate Cursor stop hook to read hook stdin (`conversation_id`, `transcript_path`), copy the redacted transcript to `/var/lib/substrate/transcripts/cursor/`, and emit `session.end` with that reference.
  - For the proof, first try the bundled headless `cursor-agent` CLI on the VPS. If it is not signed in, the owner runs one short Cursor session (checkpoint:human-action). Never seed a synthetic transcript.
  — **Reversibility:** reversible.
- **D-16:** The owner merges library PRs; that review is the gate. The proof's merge is a checkpoint:human-action. — **Reversibility:** reversible.

### Owner decisions on the research open questions (2026-09-26)
- **D-17 (deviation from D-11, owner-acknowledged):** Omp interception lives in a **standalone extension owned by agent-substrate**, symlinked into `~/.omp/agent/extensions/`. omp-ultrathink stays disabled and is not edited. Reason: the loader skips disabled plugins, so a handler there would never run (04-RESEARCH Summary 1). — **Reversibility:** reversible.
- **D-18 (redaction policy):** Vendor the 40 library entries **raw**, after the owner reviews a scan report (one human-verify checkpoint). Every `skills_propose` uses a skill-content redactor (`redactSkillContent`): it keeps `$VAR` and placeholder forms, redacts real values, and rejects high-confidence secrets. The docs-scraper `--dir` path redacts the 5 known documentation-example PEM/JWT spans instead of rejecting them (`--allow-doc-examples pem,jwt`) and lists them in the PR body. The event redactor is unchanged. — **Reversibility:** reversible.
- **D-19:** Add `docs-scraper` to `SURFACES`. — **Reversibility:** reversible.
- **D-20:** Keep the `~/.agents/skills` links per D-05. Drop them only if the proof shows Cursor listing duplicates. — **Reversibility:** reversible.
- **D-21:** The proof uses owner checkpoints: review the scan report, merge the tracer PR, run one short Cursor session (cursor-agent stays signed out), and merge the proof PR. — **Reversibility:** reversible.

### Standing rules carried forward
- Two-sided test gates against a measured phase baseline (`04-BASELINE.md`); a vanished failure fails the gate like a new one.
- Before editing any live file outside this repo (Hermes/Omp/Grok/Muse/Cursor/OpenClaw config, skill dirs, plugins, docs-scraper), snapshot it under `/var/lib/substrate/phase4-baseline/` and add a `RESTORE.md` route. Read `/var/lib/substrate/phase1-baseline/RESTORE.md` before touching a Phase 1 snapshotted file.
- Never print secrets; probe `/etc/substrate/substrate.env` only with `sudo grep -c`.
- Stage by explicit path or hunk in shared checkouts; never `git add -A`. Commit messages carry `Refs SPE-2734`.
- Fail open on every hook; redact before emitting.

### Claude's Discretion
- Internal module layout of the propose/git code, the bridge's watermarking, the precheck script, the sync timer interval details and the projector's backup format, within D-01..D-16.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/mcp-server/src/mcp.ts:43`: `createMcpServer`, `server.registerTool(...)` pattern (11 tools). `server.ts` routes (`/brief`, `/events`, `/verify`, `/issue`, `/mcp`), 1 MB body cap, bearer→surface auth via `SUBSTRATE_TOKEN_*` (anonymous when none are set).
- `packages/mcp-server/src/types.ts`: `SURFACES` :3-16, `EVENT_KINDS` :19-38. No skill kind yet.
- Redactor port in mcp-server, used on the write path.
- `packages/host/src/hostfns.ts`: git/gh via `execFile` without a shell, `HOME=/root`, 120 s timeout, `gh pr create` argv builder, PR URL regex, idempotence. This is the model for the propose git path.
- `packages/host/src/main.ts:62` `skillsDir` (default ultrathink 0.3.0 skills), `loadSkills` :73 at boot; `seed.ts:254-266` writes `/home/agentos/.claude/skills/<name>/<rel>`.
- `packages/projector/src/cursor.ts` (hooks.json appender with a `substrate-managed` marker and a backup) and `muse.ts` (plugin bundle, `capabilities.skills: []`). `projector/package.json` names a missing `src/index.ts`.
- `packages/miner/src` is empty and not a root workspace (Python, like `dispatcher`).

### Established Patterns
- systemd units in `infra/vps/*.service` reading `/etc/substrate/substrate.env`; live services run from this checkout.
- Fail-open hooks, redaction, events with a hash chain, idempotent projectors with markers and backups.
- Two-sided baselines per phase; owner checkpoints for anything the agent cannot do.

### Integration Points
- Hermes v0.21.4 at `/usr/local/lib/hermes-agent`:
  - `tools/write_approval.py` stages to `~/.hermes/pending/{skills,memory}/<8hex>.json` as `{id, subsystem, action, summary, origin, created_at, payload}`, where payload holds the `skill_manage` kwargs.
  - `/skills pending|approve|reject`.
  - `skills.external_dirs` is read-only, loses collisions to local skills, and the curator does not touch it.
  - `hermes cron create --script --skill --workdir`.
  - The prompt snapshot is rebuilt when SKILL.md signatures change.
- Omp 18.3.1:
  - `manage_skill`/`learn` write `~/.omp/agent/managed-skills/<name>/SKILL.md`; gated by `autolearn.enabled`.
  - Extension `tool_call` handlers can `{block:true}` (`runner.ts:1567-1615`).
  - `skills.customDirectories`.
- Grok 1.0.41:
  - `~/.grok/skills` hot-reloads; `[skills] paths` exists.
  - skill-autonomy 0.1.0: `skill_write.py:66-98`, `cli.py:105`, Stop hook `hooks/stop.py`, installed copy `~/.grok/installed-plugins/skill-autonomy-6d1e8e39`, source `/root/src/repos/skill-autonomy`.
- Claude Code 2.1.278: `~/.claude/skills/<name>/SKILL.md`, live skill change detector [unverified for symlinks].
- Muse 1.4.0: project `.agents/skills`, personal `~/.config/muse/skills` (installed via `muse skills install`); `/skills reload`.
- Cursor: `~/.cursor/hooks.json` substrate-managed sessionStart/postToolUse/stop entries. The hook stdin envelope carries `conversation_id` and `transcript_path`. No transcripts are on disk today. `cursor-agent` 2026.08.11 is bundled under `~/.cursor-server/.../agent-cli/` and is not on PATH.
- docs-scraper at `/root/.openclaw/workspace/projects/docs-scraper`:
  - `batch_docs_skills.py:163-189` `_install_skill` does the symlinking; line 236 is the export dir; line 330 is the README rewrite.
  - Env overrides at :40-45.
  - Its git repo has no commits.
- gh 2.45.0 is signed in as SomeRandmGuyy (scopes repo, admin:org), with active auth from the `GH_TOKEN` env in interactive shells. The service environment must be checked: `substrate.env` has 0 `GITHUB_TOKEN`/`GH_TOKEN`, and the host uses `HOME=/root` with the stored credential.

</code_context>

<specifics>
## Specific Ideas

- Phase baseline at `9eef1ee` (2026-09-25): bun test 338 pass / 0 fail across 22 files, tsc exit 0, dispatcher pytest 149 passed.
- `/` is 95% full (about 21 GB free). The library adds roughly 50-100 MB, plus a scratch clone for propose.
- Hermes has 3 existing `pending/memory` records dated 2026-09-23; leave them.
- Grok's `README.md` in `~/.grok/skills` and the agent-skills README both claim Hermes `external_dirs: [/root/agent-skills]`, which was false until this phase.
- `technical-docs-corpora` exists only in Hermes' `.archive`; it is not in the library scope.

</specifics>

<deferred>
## Deferred Ideas

- Absorbing each agent's own authored skills (Hermes, Grok, Claude, Cursor, `~/.agents`) into the library.
- Scheduling the docs-scraper crawl itself.
- Codex/OpenCode/Gemini projection.
- A GitHub webhook for instant sync (needs public ingress).

</deferred>
