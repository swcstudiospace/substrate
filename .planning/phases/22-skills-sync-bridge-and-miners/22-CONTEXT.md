# Phase 22: Skills sync, bridge and miners - Context

**Gathered:** 2026-10-09
**Status:** Ready for planning
**Mode:** Smart discuss, auto-accepted under the v1.3 run rules (`.planning/STATE.md`, "v1.3 decisions"). Recommended answers that change a user-visible contract relative to September's `acc30a8` are used by the plan and listed for the operator under "Open for the operator".

<domain>
## Phase Boundary

One PR on agent-substrate (SKILL-02, SKILL-03, SKILL-04, SKILL-05, SKILL-07). A skill mined anywhere on the host becomes a PR on `swcstudiospace/agent-skills`, never a direct publish; once the owner merges it, every agent sees it within one sync tick. Everything runs from the pinned release on `main` (`/opt/agent-substrate/current`, PR #23).

1. **Port, not merge.** Read the sources with `git show acc30a8:<path>` and re-express them on main:
   - `packages/projector/src/skills.ts` (projector) and `skills-sync.ts` (the timer's tick), with tests;
   - `packages/projector/omp/substrate-skills.ts` (the Omp extension), with its test;
   - `packages/miner/` (Python: `substrate_miner/{__init__,__main__,bridge,monitor}.py`, `pyproject.toml`, `tests/`, `skills/substrate-skill-miner/SKILL.md`, `hermes/substrate-skill-miner-monitor.sh`);
   - `infra/vps/substrate-skills-{sync,bridge}.{service,timer}`.
   September manifests are never merged; `packages/projector/package.json` keeps main's content.
2. **Clients of Phase 21's route.** Every proposal goes to `POST /skills/propose` with a surface bearer token (D21-01: the `x-substrate-propose-key` header is gone). The token's surface is the proposal's surface (D21-03).
3. **Built on earlier phases.** Phase 17's vocabulary (`skills.sync.refused` row: `warning`, fixed surface `substrate`, `action: "skills.sync"`, `runtime: "skills-sync"`, periodic, no `repo`); Phase 18's `redact.ts`; Phase 19's Cursor `stop` hook (transcripts in `/var/lib/substrate/transcripts/cursor/<conversation_id>.jsonl`, override `SUBSTRATE_TRANSCRIPTS_DIR`); Phase 20's bearer resolver (`packages/cli/src/token.ts`, order: `SUBSTRATE_TOKEN`, the token-file variable, `<tokens dir>/<surface>`) and the client manifest `infra/identity/clients.json`; Phase 21's `skills_propose` (statuses, codes, `SKILL_NAME_RE`, `SUBSTRATE_SKILLS_STATE`, `dry_run`, the harness `--skills-fixture`).

**Proof.** Isolated first (unit tests, pytest, and one smoke against the Phase 16 harness with Phase 21's skills fixture). SKILL-07 is live and operator-approved: GitHub, the owner's merge, Hermes model quota, a real Cursor session and the production timers.

**Out of scope:**
- `skills_propose` itself (Phase 21), the Cursor `stop` hook and the Muse projector (Phase 19), token provisioning (Phase 20).
- Agent Cards and teachable moments (Phase 29). Phase 29 may extend the miner's `SKILL.md`; this phase ports it and points it at main's code.
- Any new `EVENT_KINDS`/`SURFACES` entry (Phase 17 lock). No new `EVENT_SOURCES` row is needed (D22-05).
- Patching skill-autonomy (D22-14), hermes-agent, or Omp itself.
- docs-scraper publishing through `substrate skills propose --dir` (September D-14): no v1.3 requirement.

**Depends on code not yet on `main`:** Phases 19, 20 and 21. Execution starts from a base that holds all three (plan 01 checks it).

</domain>

<decisions>
## Implementation Decisions

### Skills sync and projection (SKILL-02)
- **D22-01: Port `skills-sync.ts` and `skills.ts` with September's mechanics intact.** Refuse a dirty tree or a branch other than `main` before any fetch; `git fetch origin main`; refuse a non-fast-forward; else `git merge --ff-only origin/main`; then project on every tick that got that far, so a deleted link self-heals. Runner is `execFile` with an argv, never a shell. The projector's planner and executor (`link-new`, `repoint`, `backup-then-link`, `remove-own-link`, `skip-warn`), atomic link replacement, `RESTORE.md`/`MANIFEST.sha256` backups, enable/disable flags, `--check` and `--root` stay as they are. The roots stay September's: Claude Code `/root/.claude/skills`, Grok Build `/root/.grok/skills` (with `GROK_KNOWN_REAL`), `.agents` (Cursor) `/root/.agents/skills`, Muse `/root/.config/muse/skills` (created), OpenClaw `/root/.openclaw/skills` and `/root/.openclaw/workspace/skills` (repoint-only), and `/root/.cursor/skills` behind its enable flag.
- **D22-02: Build artefacts do not make the checkout dirty.** The dirty check uses `git status --porcelain --untracked-files=all`. An untracked (`??`) path with a `__pycache__` segment or a `.pyc` suffix is ignored; any other untracked path, and any tracked change (including a tracked `.pyc`), still refuses. Agents run skill scripts through the projected links, so Python writes `__pycache__` into `/root/agent-skills` repeatedly; this is the root cause, and the September projector already ignores the same two patterns in `sameTree`. Additionally a draft PR adds `__pycache__/` and `*.pyc` to agent-skills' `.gitignore` (live step L3). The code fix does not depend on that PR, because a refused tick never fetches it.
- **D22-03: Every event the sync and the projector send is a host-job event.** Surface `substrate`, `actor: "agent"`, `payload.action: "skills.sync"`, `payload.runtime: "skills-sync"`, `payload.reason`, no `repo`, `session_id` `skills-sync:<UTC yyyy-mm-ddThh>`. The projector's skip-warn keeps its fields (`root`, `name`, `path`, `link_target`) and uses reasons `real-dir-differs`, `foreign-link`, `stray-real-dir`. September sent these under each root's agent surface (`claude-code`, `grok-build`, `cursor`, `muse`); a `substrate` token cannot do that (`attributedSurface` refuses it).
- **D22-04: The bearer is the `substrate` token** through Phase 20's resolver (`resolveBearer("substrate", env)`), replacing September's raw `process.env.SUBSTRATE_TOKEN`. Posting stays fail-open with a 3 s timeout; a refused post never changes the tick's outcome.
- **D22-05: Warn on a change of state, not on every tick.** A small state file under `SUBSTRATE_SKILLS_STATE` records the current refusal reason, when it began and when it was last warned. A tick sends a warning when the reason differs from the recorded one, or once per UTC day while it persists, so a standing refusal stays visible in the brief without 288 warnings a day. A tick that clears the refusal logs `[skills-sync] cleared <reason>` and emits nothing (a successful sync is silent, `docs/event-vocabulary.md`). The projector keeps its per-`(root, name, reason)` dedupe. Both map onto the existing `skills.sync.refused` row, so `EVENT_SOURCES` and the vocabulary doc do not change; a test asserts the emitted kind, surface, action and runtime equal that row.
- **D22-06: Exit codes stay September's.** A policy refusal (dirty, branch, diverged) exits 0; a failed git step (status, fetch, merge-base, rev-parse, merge) warns and exits 1; an empty library refuses to project and exits 1. The journal lines stay `[skills-sync] ff <old>..<new> | current <sha> | refused <reason> | cleared <reason>` and `[projector] …`.
- **D22-07: Every path is a seam.** Production defaults are September's. Overrides exist for the library dir, the home that the roots live under, the state dir (`SUBSTRATE_SKILLS_STATE`, shared with Phase 21; the warned state, the sync state and the enable/disable flags live there) and the backup dir, so the smoke and the tests never touch `/root/agent-skills`, `/root/.*` or `/var/lib/substrate`. Exact variable names are Claude's discretion; they are documented.

### Hermes bridge and queues (SKILL-03)
- **D22-08: Port `bridge.py` with its grouping and replay intact.** Load `~/.hermes/pending/skills/*.json` (never `pending/memory`), group by skill name, wait for 120 s of quiet, propose only a library skill replayed onto its library copy or a new name whose first record is a foreground create, hold everything else with one logged reason per record (`bridge-held.json`, `bridge-log.jsonl` under `/var/lib/substrate/miner`), and send only changed files plus `SKILL.md` and a `remove` list.
- **D22-09: Each queue is proposed under its own surface's token.** Hermes records go out as `hermes`, the Omp queue (`/root/.omp/agent/substrate-pending`) as `omp`, the Grok queue (`/root/.grok/plugin-data/skill-autonomy/pending`) as `grok-build`. A small Python resolver mirrors Phase 20's order for the tokens dir only: `<SUBSTRATE_TOKENS_DIR or /etc/substrate/tokens>/<surface>`, first line, 4 KiB cap, surface checked against `^[a-z0-9][a-z0-9-]{0,63}$`, any error means "no token", the value is never logged. Because one process serves three surfaces, the bridge refuses to run (exit 1, one line naming the variable, never a value) when `SUBSTRATE_TOKEN` or the token-file variable is set in its environment (the herdr precedent, D20-05). This keeps September's attribution: branches stay `skill/hermes/…`, `skill/omp/…`, `skill/grok-build/…`. Phase 20 already provisions tokens-dir files for `hermes`, `omp` and `grok-build`.
- **D22-10: A record is deleted only on a final reply.** Final: 200 with `opened`, `existing`, `unchanged` or `declined`; 400 (refused, logged with rule names). 413 or an over-cap body holds a Hermes group as `oversize` and moves a queue file to `rejected/`. Not final, so everything is kept: transport errors, no token, 401, 403 (a surface mismatch is a configuration error), 502 (`ProposeFailed`), 503 (audit refused), any other status and the `dry_run` status. 401, 403 and a missing token end the tick with exit 1, so the timer shows red.
- **D22-11: The 120 s quiet applies to the queues too,** by file mtime. A queue file is a complete body, but skill-autonomy writes it in two steps (create, then write), so a tick could read a half-written file and move it to `rejected/`.
- **D22-12: `bridge --once --dry-run`** classifies and builds every proposal, posts it with `dry_run: true` (Phase 21 validates, redacts and counts without pushing), prints one line per group or file (name, surface, classification, record ids, the reply status) and never deletes, moves or holds anything. The operator reviews it before the first live tick (L4).
- **D22-13: The held-record hint changes with the CLI.** The September hint names `substrate skills propose --dir … --surface hermes`; Phase 21's CLI has no `--surface` flag and takes the surface from the token. The hint names the CLI and the `hermes` token file in prose (the store lock forbids `SUBSTRATE_TOKEN*=<path>` spellings). A library skill is still never `/skills approve`d.

### Miners propose, never publish (SKILL-04, SKILL-05)
- **D22-14: skill-autonomy is not changed.** Its `propose.py` sends only the retired key header, so the route answers 401 and it stages the exact body in the Grok queue; once the key file is retired (L7) it stages without calling. The bridge proposes it as `grok-build` within one tick plus 120 s. The repository has no remote, so a change could not go through a PR.
- **D22-15: The Omp extension authenticates with the `omp` token.** It stays standalone (no import from the repo or Omp): a copied resolver with Phase 20's order for surface `omp`. It intercepts `manage_skill` create/update (block with a reason naming the PR) and `learn`'s skill payload (strip it, keep the lesson, name the PR in `additionalContext`); delete and every other tool pass through; the 25 s abort stays. 400 and 413 are final (block, nothing queued). No token, transport errors, timeouts, 401, 403 and 5xx queue the exact body under `/root/.omp/agent/substrate-pending/<name>-<UTC ts>.json` (0600 in a 0700 dir) for the bridge. The token is never logged, queued or put in a reason. It is installed as a symlink from `~/.omp/agent/extensions/substrate-skills.ts` to the file under `/opt/agent-substrate/current` (L5); the dangling symlink into the checkout is replaced.
- **D22-16: The Hermes miner runs main's code.** `monitor.py` is ported as it is (stable output with no timestamps, the newest 100 transcripts sorted by id, plus `day <UTC date>`), reading `SUBSTRATE_TRANSCRIPTS_DIR` when set, like Phase 19's hook. The shipped monitor script runs `python3 -m substrate_miner monitor` with `PYTHONPATH` under `/opt/agent-substrate/current` and `PYTHONDONTWRITEBYTECODE=1`. Hermes suppresses the model run when the monitor's output is byte-identical to the previous tick's, which is how an unchanged hour skips the model.
- **D22-17: "At most 3" is the miner's instruction, pinned by a test.** `SKILL.md` keeps "at most 3" skills per run through `skill_manage` and stays free of any path into the live checkout. Hermes stages every `skill_manage` call while `skills.write_approval` is on, so the miner cannot publish. A hard cap in the bridge is Claude's discretion and only if research finds a reliable per-run provenance field in the staged records; foreground Hermes writes must not be capped by it.
- **D22-18: `skills.write_approval` and `memory.write_approval` stay true.** A read-only check (part of the skills doctor, D22-21) reads `~/.hermes/config.yaml` and reports both flags; the live proof records them. Nothing in this phase writes Hermes configuration except the operator's cron update (L6).

### Units, release path and docs
- **D22-19: The four units run from the pinned release.** `WorkingDirectory=/opt/agent-substrate/current`; `ConditionPathExists=` on the entry under `current`, so a missing entry skips a tick instead of failing it; `StartLimitIntervalSec=0`; the bridge sets `PYTHONPATH=/opt/agent-substrate/current/packages/miner/src` and `PYTHONDONTWRITEBYTECODE=1` (a release tree is immutable). The timers keep `OnUnitActiveSec=5min`, `AccuracySec=30s` and their boot delays. Neither service loads `/etc/substrate/substrate.env`: each gets a drop-in `10-environment.conf` with its own root-only env file (`/etc/substrate/skills-sync.env`, `/etc/substrate/skills-bridge.env`), holding names only as documented in `infra/vps/README.md`. The bridge's file must not define `SUBSTRATE_TOKEN` or the token-file variable (D22-09). The hardening lines stay. `doctor-units.ts` reports no finding for the four units (a test pins it).
- **D22-20: `deploy-release.sh` does not restart the timers.** Oneshot services pick up `current` on their next tick, so a deploy needs no restart. Its default unit list and its `-m` handling stay as they are; the README says the timers follow `current` and how to roll them back with the release.
- **D22-21: A read-only skills doctor,** `bun run skills:doctor` (`scripts/skills-doctor.ts`): checkout state of the library (clean modulo D22-02, on `main`, ahead or behind `origin/main` from local refs only, no fetch), projection drift (`skills.ts --check`), the Omp extension link's target, the Hermes approval flags, the monitor script path the cron would run when it can be read from Hermes' job file, and the env-file rule (D22-09) for the bridge. It never calls systemd, GitHub or the substrate, never prints a value, and exits 1 on any finding. The operator runs it after each live step.
- **D22-22: Identity manifest rows move from dormant to live.** Phase 20's `infra/identity/clients.json` gets the sync (`substrate`, env file), the bridge (`hermes`, `omp`, `grok-build` via the tokens dir, with the no-single-token rule) and the Omp extension (`omp`, tokens dir). If the base models these rows differently, follow the base.
- **D22-23: Root `test:py`.** `package.json` gains `"test:py": "python3 -m pytest packages/miner"` (system `python3` 3.12 with `httpx` and `pytest` already present; no venv). The ported pytest suites use injected `httpx` transports and tmp dirs only.
- **D22-24: Docs.** New `docs/skills-plane.md`: the flow (miners → pending/queues → bridge → route → PR → owner merge → sync → projection), the roots table, the refusal and warning rules, the bridge's final/non-final replies, the token sources per client, the state files, the overrides, and the cutover and rollback runbook (L1–L8). Edits: `infra/vps/README.md` (units table and env files; the "Code that reaches main through v1.3" paragraph for skills is resolved), `docs/skills-propose.md` (its clients), `docs/collectors.md` or Phase 19's equivalent only if it names the transcripts consumer.

### Proof
- **D22-25: Unit tests.** Ported `skills.test.ts`, `skills-sync.test.ts` (fake runner; real filesystem in tmp dirs), `omp/substrate-skills.test.ts` (fake fetch; tmp token dir), `test_bridge.py`, `test_monitor.py` (`httpx.MockTransport`), plus new tests for D22-02, D22-03, D22-05, D22-09 (per-surface token, refusal when a single-token variable is set), D22-10, D22-11, D22-12, D22-17 (`SKILL.md` pins) and the four unit files under `doctor-units`. No test references a production path outside a seam default (PITFALLS 13).
- **D22-26: Isolated smoke, `bun run smoke:skills-plane` (`scripts/skills-plane-smoke.ts`).** Against `rehearsal up --name p22 --skills-fixture` with a tokens dir in the run directory for `hermes`, `omp`, `grok-build` and `substrate`; refuses port 7410 and any non-loopback host, like Phase 16's guards. Steps: (a) stage one Hermes pending record, one Omp queue file and one Grok queue file in scratch dirs, all older than 120 s; `bridge --once --dry-run` deletes nothing; `bridge --once` opens three PRs in the fixture with branches `skill/hermes/…`, `skill/omp/…`, `skill/grok-build/…` and removes the three records; (b) a fresh record younger than 120 s is kept; (c) fast-forward the fixture's `main` to one branch (the owner's merge), clone it as a scratch library, run `skills-sync.ts` once with scratch roots: the skill is linked in the Claude Code and Grok Build roots and in the others September projects, and no config file under the scratch home changes; (d) an untracked `__pycache__/x.pyc` in the scratch library leaves the next tick green; an untracked `notes.txt` refuses with exactly one `substrate` warning across two ticks (read back through `POST /events/query`); (e) the Omp handler against the harness answers with a PR and, with the server stopped, queues a body the next bridge tick proposes.
- **D22-27: Live proof SKILL-07 (operator-approved, L8).** A real Cursor session ends; Phase 19's hook copies its transcript; the next hourly Hermes cron run (model quota) stages at most 3 skills; the bridge opens the PR; the owner merges; within one sync tick (≤ 5 min) the skill is linked in `/root/.claude/skills` and `/root/.grok/skills` and Grok Build lists it, with the mtimes of both agents' config files unchanged; `systemctl` shows both services' last runs successful on the release and the cron's last status ok. The evidence goes to `22-PROOF.md`.
- **D22-28: Baseline discipline.** Results are compared with the base's `bun test`, `bunx tsc --noEmit`, `bun run check:phase-close` and `bun run test:py`; failures already present at the base are recorded, not fixed.

### Claude's Discretion
- File split inside `packages/projector/src` (for example a `skills-env.ts` for the overrides) and inside `substrate_miner` (for example `token.py`).
- The override variable names (D22-07) and the sync state file's name and shape.
- Whether the sync's daily reminder (D22-05) keys on the UTC day or on 24 h since the last warning.
- Whether the bridge caps the miner's proposals in code (D22-17), only on evidence from research.
- How the smoke simulates the owner's merge (a `git update-ref`/`push` in the fixture repository) and how it reads back events.
- Plan split, for example: (1) base check and projector/sync port; (2) miner package and bridge; (3) Omp extension; (4) units, doctor, manifest and docs; (5) smoke; (6) live runbook and proof record.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `acc30a8` sources (sizes): `projector/src/skills.ts` 468 + test 565; `skills-sync.ts` 137 + test 144; `omp/substrate-skills.ts` 251 + test 287; `miner/src/substrate_miner/bridge.py` 598, `__main__.py` 51, `monitor.py` 30; `tests/test_bridge.py` 523, `test_monitor.py` 43; `skills/substrate-skill-miner/SKILL.md` 68; `hermes/substrate-skill-miner-monitor.sh` 2; units 29/12/34/12 lines.
- Main: `packages/mcp-server/src/redact.ts` (`redact`, Phase 18 skill engine), `packages/mcp-server/src/types.ts` (`EventInput`, `Surface` with `substrate`), `event-sources.ts` (`skills.sync.refused`), `packages/projector/src/cursor.ts` and `swarm-workspace.ts` (projector style), `scripts/doctor-units.ts` (handles `python3 -m` entries), `infra/vps/deploy-release.sh`, `scripts/rehearsal.ts`.
- After the base merges: Phase 20 `packages/cli/src/token.ts` (`resolveBearer`), `infra/identity/clients.json`, `scripts/identity-check.ts`; Phase 21 `packages/mcp-server/src/skills/propose.ts` (`SKILL_NAME_RE`, statuses), the route and the harness `--skills-fixture` (bare repo, mirror, recording `gh`); Phase 19 `packages/collectors/src/cursor-stop.ts`.
- Host (read-only facts from research): `/root/agent-skills` at `df0db4e`, untracked `parallel-common/scripts/__pycache__/`; 4 records in `~/.hermes/pending/skills`; Hermes cron `substrate-skill-miner` (`0c172431cf5b`) failing on `No module named substrate_miner.__main__`; `~/.omp/agent/extensions/substrate-skills.ts` dangling; skill-autonomy@`394d5ea` stages on any non-2xx other than 400/413; system `python3` 3.12.3 with `httpx` 0.28.1 and `pytest` 9.1.1.

### Established Patterns
- Units run from `/opt/agent-substrate/current`, each with its own env file through a drop-in; the shared server env file is for `substrate-mcp` only (PR #23).
- Host jobs emit as `substrate` with `payload.runtime`; refusals carry rule names and reasons, never values (Phase 17).
- Clients take an injected runner, `fetch` or `httpx` transport; state paths are seams; live work is a separate script run with approval (PITFALLS 13).
- Token paths appear in prose, never as `SUBSTRATE_TOKEN*=<path>` (store lock, Phase 20 spelling rule).
- Tests colocated as `*.test.ts` under Bun; Python tests under `packages/<pkg>/tests` with `pythonpath = ["src"]`.

### Integration Points
- New: `packages/projector/src/{skills,skills-sync}.ts` and tests; `packages/projector/omp/substrate-skills.ts` and test; `packages/miner/**`; `infra/vps/substrate-skills-{sync,bridge}.{service,timer}` and their `.d/10-environment.conf`; `scripts/skills-doctor.ts`, `scripts/skills-plane-smoke.ts` and tests; `docs/skills-plane.md`.
- Edited: `package.json` (`test:py`, `skills:doctor`, `smoke:skills-plane`), `infra/vps/README.md`, `infra/identity/clients.json`, `docs/skills-propose.md`, `scripts/doctor-units.test.ts` (the new units), possibly `scripts/rehearsal.ts`/`rehearsal-env.ts` (a tokens dir for the smoke).

</code_context>

<specifics>
## Specific Ideas

- Nothing writes `/root/agent-skills` except the sync's fast-forward; the miner's `SKILL.md` says so, and the bridge never approves a held library-skill record.
- The first live bridge tick turns the 4 records already staged in `~/.hermes/pending/skills` (and any queued Omp or Grok bodies) into real PRs. The dry run (D22-12) is how the operator sees them first.
- Results never name a value: tokens are read per request and never logged; refusals carry rule names.

</specifics>

<deferred>
## Deferred Ideas

- Patching skill-autonomy to send a bearer directly (it has no remote; staging plus the bridge covers SKILL-05).
- docs-scraper publishing through `substrate skills propose --dir` (September D-14).
- A per-run cap on Hermes miner proposals enforced outside the miner's instructions, unless research finds a provenance field (D22-17).
- Moving the units off root and `ProtectHome=false` (PR #23 already records this as a later operator decision).

</deferred>

## Live steps (each waits for operator approval)

- **L1 Deploy** a release tag containing this phase with `deploy-release.sh <tag>` (writes `/opt`; restarts only `substrate-mcp` and the Grok collector, as today). Then `bun scripts/doctor-units.ts --release /opt/agent-substrate/current` (read-only).
- **L2 Install units:** create `/etc/substrate/skills-sync.env` and `/etc/substrate/skills-bridge.env` (0600, names in the README), install the four unit files and two drop-ins, `systemctl daemon-reload`, enable and start `substrate-skills-sync.timer` only (PR #23 step 1 paused both). Write.
- **L3 agent-skills `.gitignore`:** open a draft PR on `swcstudiospace/agent-skills` adding `__pycache__/` and `*.pyc`; the owner merges. GitHub write on another repo.
- **L4 Bridge first run:** `bridge --once --dry-run` against production (posts `dry_run` proposals; no push), the operator reviews the list and may `/skills reject` any Hermes record; then enable `substrate-skills-bridge.timer`. The first real tick opens PRs on agent-skills. Write (GitHub).
- **L5 Omp extension:** repoint `~/.omp/agent/extensions/substrate-skills.ts` to the file under `/opt/agent-substrate/current`. Write (`~/.omp`).
- **L6 Hermes cron:** point job `substrate-skill-miner`'s monitor script and skill at the release copies and clear its failure streak with Hermes' own cron commands; read `skills.write_approval` and `memory.write_approval` (both true). Write (`~/.hermes`).
- **L7 Retire the propose key:** move `/var/lib/substrate/skills/propose.key` into the phase backup directory (D21 deferred this here). Write.
- **L8 SKILL-07 proof (D22-27):** a real Cursor session, Hermes model quota, a PR on agent-skills, the owner's merge, then read-only checks (`skills:doctor`, link targets, `grok` listing, config mtimes, `systemctl show` of both services, the cron's last status).

## Open for the operator

Recommended answers the plan uses; each changes a user-visible contract relative to September.

1. **Bridge attribution by per-surface tokens (D22-09).** The bridge reads the `hermes`, `omp` and `grok-build` token files and refuses to run with a single-token variable set. Why: Phase 21 takes the proposal's surface from the token, so one `substrate` token would turn every branch into `skill/substrate/…` and 403 the queued Omp and Grok bodies. Recommendation: per-surface tokens (September's branch names stay). Alternative: the `substrate` token, with queued bodies re-attributed to `substrate`.
2. **Dirty-tree fix (D22-02).** The sync ignores untracked `__pycache__`/`.pyc` paths, and a draft `.gitignore` PR goes to agent-skills. Why: skill scripts run through the links write caches into the checkout, and a refused tick never fetches the `.gitignore` fix. Recommendation: both. Alternative: `.gitignore` PR only, after the operator deletes the cache once by hand.
3. **Warning cadence and surface (D22-03, D22-05).** Refusals warn on change and at most once a UTC day while they persist; projector warnings move from each agent's surface to `substrate`. Why: 288 warnings a day buried the brief, and the host-job token is bound to `substrate`. Recommendation: as written.
4. **skill-autonomy stays as it is (D22-14).** Grok Build proposals go through its staging queue and the bridge (up to one tick plus 120 s later) instead of a direct POST. Why: its repository has no remote, and staging already exists and is tested. Recommendation: no change. Alternative: a local commit adding bearer support.
5. **The staged backlog becomes PRs (L4).** The first bridge tick proposes the 4 Hermes records already staged and any queued bodies. Recommendation: review the dry-run list first, then enable the timer.
