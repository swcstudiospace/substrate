# Phase 22: Skills sync, bridge and miners - Context

**Gathered:** 2026-10-10
**Status:** Ready for planning
**Mode:** Autonomous discuss-equivalent under the v1.3 run rules (`.planning/STATE.md`, "v1.3 decisions"): grey areas auto-accept unless they change a user-visible contract, and each is recorded below as a decision with its source. No operator questions were asked; items needing a live system are marked OPERATOR-GATED in the plans, not resolved here.

<domain>
## Phase Boundary

One PR on agent-substrate (SKILL-02, SKILL-03, SKILL-04, SKILL-05, SKILL-07). Mined skills reach every agent through propose, owner merge and sync, all from code on `main`.

1. **The route before its clients.** Phase 21's `Substrate.proposeSkill` (MCP `skills_propose`, `POST /skills/propose`, `substrate skills propose --dir`) is the only code that touches git or `gh`. Everything in this phase — the Hermes bridge, the Omp extension, skill-autonomy, the Hermes miner — is a client of that wire contract (21-CONTEXT D21-06..D21-11). No new git/`gh` path is created.
2. **Port, not merge.** `packages/projector/src/{skills,skills-sync}.ts`, `packages/projector/omp/substrate-skills.ts`, `packages/miner/src/substrate_miner/{bridge,monitor,__main__}.py`, the miner SKILL.md and the four unit files come from `acc30a8` (`git show acc30a8:<path>`), onto main's v1.2 surface-token model. September's `x-substrate-propose-key` credential is **not** ported (D22-01).
3. **Guards come from earlier phases.**
   - Redaction and the secret scan: Phase 18's `redact.ts` (`redactSkillContent`, `scanSkillFiles`); the bridge never sees a secret because the route refuses it.
   - The event mapping: Phase 17's `EVENT_SOURCES` rows (`skills.propose*`); sync refusals are `warning` events from the `substrate` surface.
   - Fail-closed audit for `skills_propose`: Phase 17/21 `policy.ts`.
   - Tokens-dir bearer resolution: Phase 20's `packages/cli/src/token.ts` pattern (D20-04) — host jobs read a surface token file, never an env value.
   - Cursor transcripts: Phase 19's `cursor-stop.ts` (`/var/lib/substrate/transcripts/cursor`).
4. **Rehearsal-first, then gated live.** Every behavior is proven against the Phase 16 harness (twin at a `:1741x`-class port, detached worktree, `file://` fixture library, recording fake `gh`) before any live step. The real agent-skills PR, the owner merge, and the production unit restarts are OPERATOR-GATED steps the executor stops at (SKILL-07 proof needs GitHub, the owner's merge, Hermes model quota, a real Cursor session and the production timers).

**Out of scope:**
- Any change to `skills/propose.ts`, `frontmatter.ts`, the route, tool or CLI (Phase 21 owns them; this phase only calls them).
- Any new `EVENT_KINDS` or `SURFACES` entry (Phase 17 lock).
- New redaction rules (Phase 18 owns `redact.ts`).
- The docs plane RAGFlow `agent-skills` dataset refresh trigger (Phase 25 consumes the sync fast-forward; this phase only documents the hook point).
- A per-surface proposal allowlist or rate limit (deferred in Phase 21).
- Removing `/var/lib/substrate/skills/propose.key` from the host (done here as D22-01 cutover cleanup, operator-gated: the file is deleted only after the bridge cutover is proven).
- Production token values (Phase 20 provisioned them by name; this phase only reads the token files).

**Depends on code already on `main`:**
- Phase 16: `scripts/rehearsal.ts`, `packages/mcp-server/src/rehearsal-env.ts`, `--skills-fixture` (throwaway bare repo + recording `gh`).
- Phase 17: `event-sources.ts`, `policy.ts`, `docs/event-vocabulary.md`, `substrate` surface.
- Phase 18: `redact.ts` skill engine, `redact-lock.test.ts`, store-lock rules.
- Phase 19: `cursor-stop.ts` transcripts, `docs/collectors.md`.
- Phase 20: `infra/identity/clients.json` dormant:22 rows (skills-sync, bridge, miner), `packages/cli/src/token.ts` resolver, `docs/runbooks/production-identity.md`.
- Phase 21: `Substrate.proposeSkill` + wire contract, `docs/skills-propose.md`.
</domain>

<decisions>
## Implementation Decisions

### Authentication cutover (the one September-to-main break)
- **D22-01: Host skill clients authenticate with the `substrate` surface token, never the propose key.**
  - Source: 21-CONTEXT D21-01 (propose key dropped; host clients move to a token in Phase 22) + 20-CONTEXT D20-07 (dormant host jobs hold `SUBSTRATE_TOKEN_SUBSTRATE` by name).
  - September's bridge sent `x-substrate-propose-key` from `/var/lib/substrate/skills/propose.key`; the Omp extension read the same key per call; skill-autonomy posted with it. On main the route has no such header (21-VERIFICATION truth 8), so all three are ported to resolve a bearer for surface `substrate` through the Phase 20 resolver order (`SUBSTRATE_TOKEN` env, else `SUBSTRATE_TOKEN_FILE`, else the tokens-dir file), and queue the exact propose body when no bearer or a 401/5xx/transport error occurs.
  - The 401/queue/held semantics stay September's: unlink or delete a queued record only on a final reply (`opened`/`existing`/`unchanged`/`declined`/400); keep on 401, 5xx, transport error, 413, oversize.
  - The host `propose.key` file is deleted by the operator after the cutover proof (gated step in plan 22-04); no code references it. Grey area (key-file lifetime) auto-accepted: leave-then-delete is the only order that cannot strand a tick.
- **D22-02: The bridge posts as surface `hermes`; the Omp extension as `omp`; skill-autonomy as `grok-build`.**
  - Source: ROADMAP SKILL-03/SKILL-05 (named queues) + 21-CONTEXT D21-03 (the token's surface names the branch and PR).
  - Each client resolves its own surface's token file. The branch `skill/<surface>/…` therefore records which miner found the skill. No body-supplied surface override (D21-03 forbids re-attribution).

### Sync and projection
- **D22-03: Port the September sync gate unchanged: dirty → off-branch → diverged refusals, else fetch + `merge --ff-only`, then project every tick that got that far.**
  - Source: research §2 (`skills-sync.ts` 137 lines, `decide()` + `runSync()` + injected `Runner`) + ROADMAP SKILL-02.
  - The runner keeps September's shape (argv-only `execFile`, 120 s, allowlisted env) but main's Phase 20 rule applies: store URLs, surface tokens and the handoff key never reach a child process (child env allowlist `PATH`, `HOME`, `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`, per 21-CONTEXT D21-15).
  - Every refusal ends the tick with one `warning` event from surface `substrate` and exit 0 (a policy outcome); a failed git step exits 1. Log lines keep September's `[skills-sync] ff <old>..<new> | current <sha> | refused <reason>` shape.
  - Grey area (detached-HEAD wording: September refuses any branch ≠ `main`, including `HEAD`) auto-accepted: keep September's exact predicate.
- **D22-04: Port the September projector unchanged: six roots, five actions, backup-and-restore.**
  - Source: research §2 (`skills.ts` 468 lines; ROOTS claude/grok/agents/muse/openclaw/openclaw-ws/cursor) + ROADMAP SKILL-02.
  - Actions `link-new`, `repoint`, `backup-then-link`, `remove-own-link`, `skip-warn`; flags `disableFlag` (agents root) and `enableFlag` (cursor root); atomic link replace; undo lines in `<backupDir>/RESTORE.md`. `--check` is drift-clean for `check:phase-close`.
  - Grey area (whether the Grok `knownReal` list still matches the host) auto-accepted with a guard: plan 22-01 re-derives `GROK_KNOWN_REAL` against the September baseline list and records any drift as a `skip-warn`, never a link.
- **D22-05: The dirty-tree refusal stays a refusal; the host's untracked `__pycache__` is cleaned once by the operator.**
  - Source: research SUMMARY PITFALLS 12 (`/root/agent-skills` dirty → sync refuses every tick) + ROADMAP SKILL-02.
  - The sync never ignores dirt to "get green": that would hide a real divergence. Plan 22-04 carries the one-time gated cleanup (remove untracked cache files and/or land a `.gitignore`) as an operator step with proof (one tick prints `current` or `ff`, zero `refused`).
  - Grey area (gitignore vs delete-only) auto-accepted: do both — delete the untracked files, add `__pycache__/` + `*.pyc` to the library `.gitignore` in the same step so the refusal cannot recur. The `.gitignore` change goes through the normal owner-reviewed PR path on agent-skills, not a direct push.

### Bridge and queues
- **D22-06: Port the September bridge semantics unchanged, minus the propose key.**
  - Source: research §3 (`bridge.py` 598 lines + `test_bridge.py` 523) + ROADMAP SKILL-03.
  - Keep: pending-only reads (never `pending/memory`); grouping by skill name; 120 s quiet (`QUIET_S`); propose-only repayable library skills in `created_at` order plus new-name foreground creates; hold-everything-else with one logged reason per record, never deleted; send only differing files + SKILL.md plus `remove`; unlink only on final reply; Omp + Grok queue drains with the same final-reply rule; held-state and JSONL bridge log paths.
  - Change: bearer from the tokens-dir file for the client's surface (D22-01/02) instead of the propose-key header; `SUBSTRATE_URL` default loopback retained.
  - Grey area (quiet-window tuning) auto-accepted: keep 120 s; it is September-proven and no requirement asks to change it.
- **D22-07: Queue file contract is September's: a file holding exactly the propose body, 0600.**
  - Source: research §3 (04-03 contract) + Omp ext behavior on the branch.
  - Paths stay September's (`~/.omp/agent/substrate-pending`, Grok `plugin-data/skill-autonomy/pending`) so already-queued September bodies still drain. The bridge validates each file against the Phase 21 body shape before posting; an unparseable file is held with a logged reason, never posted, never deleted.

### Miners propose-only
- **D22-08: No miner publishes directly — three interceptions, all ported from the branch.**
  - Source: ROADMAP SKILL-05 + research §4.
  - (a) skill-autonomy (Grok plugin): reinstall/configure so its output posts to `POST /skills/propose` with the `grok-build` bearer, or stages to its pending dir when the substrate is unreachable (September 04-09 evidence: live rule + 0600 queued body). No direct library write.
  - (b) Omp extension (`packages/projector/omp/substrate-skills.ts`): `manage_skill` create/update → propose then block with the PR reason; `learn` with a skill payload → propose, strip the payload so the memory lesson still lands, name the PR; delete and other tools pass through; no Omp-package imports (structural types only). Bearer per D22-01 with queue-on-401/5xx/timeout; 400/413 final.
  - (c) Hermes `skill_manage` output → pending → bridge (D22-06): with `skills.write_approval` on, Hermes stages instead of writing; the bridge is the only path to a PR. The miner SKILL.md keeps September's text (at most 3 skills, frontmatter contract, never-write rules) with the auth paragraph updated to surface tokens.
- **D22-09: The hourly Hermes miner runs main's code with the September precheck.**
  - Source: ROADMAP SKILL-04 + research §4 (`monitor.py`, SKILL.md 68 lines).
  - `monitor` prints newest-100 Cursor transcripts + today's date, no timestamps; unchanged hour skips the model run; at most 3 proposals; `skills.write_approval` and `memory.write_approval` stay true (asserted in the plan's proof, never flipped by this phase).
  - Grey area (cron scheduler mechanics: Hermes cron job binding) auto-accepted: rebind the existing `substrate-skill-miner` cron entry to main's monitor + SKILL.md paths; no new scheduler.

### Units, timers, proof
- **D22-10: The four unit files are ported with Phase 20 token carriage; restarts are operator-gated.**
  - Source: 20-CONTEXT D20-07 (dormant:22 rows hold `SUBSTRATE_TOKEN_SUBSTRATE` by name in per-unit env files) + research §5.
  - `substrate-skills-sync.{service,timer}`, `substrate-skills-bridge.{service,timer}` land in `infra/vps/` with `EnvironmentFile` for the per-unit env plus the tokens-dir read; `ConditionPathExists` guards per Phase 16 convention so a missing code path fails safe. The Hermes cron rebind is a host-config step, not a repo file.
  - Plans stage the files and prove them in rehearsal (systemd `--user` dry or timer-content test, never touching production units). `systemctl restart` of the three dormant units + cron rebind are OPERATOR-GATED steps in plan 22-04.
- **D22-11: Proof is rehearsal-first; SKILL-07's live tail is explicit and gated.**
  - Source: ROADMAP SKILL-07 + v1.3 run rules (live runs wait for operator approval).
  - Rehearsal (no approval): harness twin + fixture library + recording `gh` proves propose→branch→PR, dirty/off-branch/diverged refusals, quiet-window grouping, queue drains, projector links per root, and a simulated merge→sync tick→links-appear loop.
  - Gated (executor stops, operator approves): the real agent-skills PR from a Cursor-mined skill, the owner merge, and the production tick in which the skill appears in Claude Code and Grok Build with configs unchanged; production restarts of skills-sync/bridge and the Hermes cron rebind.
</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `acc30a8:packages/projector/src/skills.ts` (468) + `skills.test.ts` (565) — projector, planner/executor split, six roots.
- `acc30a8:packages/projector/src/skills-sync.ts` (137) + `skills-sync.test.ts` (144) — `decide()`, `runSync()`, injected `Runner`.
- `acc30a8:packages/projector/omp/substrate-skills.ts` (251) + `.test.ts` (287) — interception extension, session_id forwarding (741249b).
- `acc30a8:packages/miner/src/substrate_miner/{bridge.py (598), monitor.py (30), __main__.py (51)}` + `tests/{test_bridge.py (523), test_monitor.py (43)}`.
- `acc30a8:packages/miner/skills/substrate-skill-miner/SKILL.md` (68) — miner prompt.
- `acc30a8:infra/vps/substrate-skills-{sync,bridge}.{service,timer}` — four unit files.
- Main: `packages/mcp-server/src/skills/propose.ts` (`SKILL_NAME_RE` shared literal), Phase 21 `POST /skills/propose` + `SUBSTRATE_SKILLS_*` config, `packages/cli/src/token.ts` bearer resolver, `infra/identity/clients.json` dormant:22 rows, Phase 16 `--skills-fixture` harness, Phase 19 `cursor-stop.ts` transcripts.

### Established Patterns
- Port leaf modules whole; rewrite only the auth call sites (propose key → surface-token bearer).
- Pure argv builders + injected `Runner` (September `hostfns.ts` shape; Phase 21 engine).
- Tests colocated (`*.test.ts`, Bun; `test_*.py`, pytest with root `test:py` script to be added).
- Refusals record rule names, never values; side-effect events never fail the action.
- Detached worktrees for proof runs; the harness refuses the production checkout and port 7410.

### Integration Points
- New on main: `packages/projector/src/{skills,skills-sync}.{ts,test.ts}`, `packages/projector/omp/substrate-skills.{ts,test.ts}`, `packages/miner/src/substrate_miner/{bridge,monitor,__main__}.py`, `packages/miner/tests/test_{bridge,monitor}.py`, `packages/miner/skills/substrate-skill-miner/SKILL.md`, `infra/vps/substrate-skills-{sync,bridge}.{service,timer}`, `scripts/skills-sync-smoke.*`, `docs/skills-sync-bridge-miners.md`.
- Edited: `package.json` (`test:py`, smoke scripts), `docs/rehearsal.md`, `docs/event-vocabulary.md` (only if a new status is needed — none planned), `.env.example` (only if a new `SUBSTRATE_SKILLS_*` key is needed — none planned), `infra/identity/clients.json` (dormant:22 rows flip to live only after the gated restarts — NOT in this phase's PR).
</code_context>

<specifics>
## Specific Ideas

- The phase is "the clients of the route": every miner path ends in `POST /skills/propose` with a surface bearer or a 0600 queued body the bridge drains. The wire contract (21-CONTEXT D21-07..D21-11) is what they code against — especially the 1 MB cap (queues must hold, not split, oversize bodies) and final vs keep reply classes.
- September's Phase 4 live evidence (agent-skills#5 via the bridge, #4 via skill-autonomy, #7 via the Omp route, then projection into Claude Code and Grok Build) is the rehearsal script for SKILL-07, replayed against the fixture library first.
- `/root/agent-skills` is read-only for everything except the sync timer; the miner SKILL.md's never-write rules are the mechanism, the sync gate is the backstop.
</specifics>

<deferred>
## Deferred Ideas

- A per-surface proposal allowlist or rate limit if the owner's review queue gets noisy (deferred in Phase 21; unchanged here).
- Skill exports over 1 MB (deferred in Phase 21; queues hold oversize bodies for the owner rather than splitting them).
- Mirror bootstrap as a command (`substrate skills init`): the host mirror exists; a fresh host still follows September's 04-02 bootstrap by hand.
- RAGFlow `agent-skills` dataset auto-refresh on sync fast-forward (Phase 25's trigger; this phase only documents the hook point where the sync tick would call it).
- Library-in-VM mounts (September 04-06 D-08): not a v1.3 requirement; not re-planned here.
</deferred>

## Open for the operator (gated steps, not questions)

**All decided below as written; each waits for operator approval at execution time.** They are locked, not open.

1. **The real agent-skills PR + owner merge (SKILL-07).** A Cursor-mined skill is proposed through the production route and merged by the owner. Alternative: none — the requirement is explicitly live.
2. **Production restarts of `substrate-skills-sync`, `substrate-skills-bridge` and the Hermes `substrate-skill-miner` cron rebind.** Alternative: none — dormant units stay failing until restarted onto main's code.
3. **One-time `/root/agent-skills` cleanup + `.gitignore` PR.** Removes the untracked cache files behind the dirty-tree refusal and proposes the ignore rule through the owner-reviewed path. Alternative: leave dirty and let every tick warn (288 warnings/day) — rejected.
4. **Deleting `/var/lib/substrate/skills/propose.key`.** Only after the bridge cutover proof. Alternative: leave the file; harmless but confusing — rejected as the end state, accepted as the interim.
</domain>
