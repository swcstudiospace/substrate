# Skills plane

How a skill mined anywhere on the host becomes a pull request on the shared
skills library, and how the owner's merge reaches every agent within one sync
tick. Nothing here publishes directly: the owner's merge is the only gate.

## Flow

```text
miners → pending/queues → bridge → route → PR → owner merge → sync → projection
```

1. **Miners.** The Hermes cron job `substrate-skill-miner` runs the monitor
   script, which lists new Cursor transcripts, and proposes at most 3 reusable
   skills per run through `skill_manage`. With `skills.write_approval` on,
   Hermes stages every `skill_manage` call under `~/.hermes/pending/skills`
   instead of writing it. Omp's extension intercepts `manage_skill`
   create/update and `learn` skill payloads and proposes them the same way.
   skill-autonomy stages its bodies in the Grok queue.
2. **Pending and queues.** Hermes records wait in `~/.hermes/pending/skills`
   (never `pending/memory`). The Omp queue lives under
   `~/.omp/agent/substrate-pending`; the Grok queue under the skill-autonomy
   pending directory. Each record or file waits for 120 s of quiet (file mtime
   for queues) so a half-written body is never proposed.
3. **Bridge.** `substrate-skills-bridge.timer` fires every 5 minutes;
   `python3 -m substrate_miner bridge --once` groups Hermes records by skill
   name, proposes library-skill replays and new foreground-created skills, and
   holds everything else with one logged reason per record. Then it drains the
   Omp queue as surface `omp` and the Grok queue as surface `grok-build`.
   `bridge --once --dry-run` classifies and posts with `dry_run` true and never
   deletes, moves or holds anything.
4. **Route.** Every proposal goes to `POST /skills/propose` with a surface
   bearer token (see [skills-propose.md](skills-propose.md)). The token's
   surface names the branch (`skill/<surface>/…`), the PR title and the event.
5. **PR and owner merge.** The route pushes a new branch and opens a PR with
   `gh`. Identical content is never proposed twice (`existing`, `declined`,
   `unchanged`). The owner merges; nothing else can land a skill.
6. **Sync.** `substrate-skills-sync.timer` fires every 5 minutes. The tick
   refuses a dirty tree, a branch other than `main` or a diverged history with
   a warning event; otherwise it fetches and merges `origin/main` fast-forward
   only in `/root/agent-skills`, then runs the projector — so a deleted link
   self-heals on the next tick that gets that far.
7. **Projection.** The projector links every library skill into each root (see
   the roots table). A successful sync is silent.

## Roots

`packages/projector/src/skills.ts` owns this table; the doc follows the code.

| Root | Directory | Surface | Mode |
| --- | --- | --- | --- |
| `claude` | `/root/.claude/skills` | `claude-code` | link |
| `grok` | `/root/.grok/skills` | `grok-build` | link (known-real list kept) |
| `agents` | `/root/.agents/skills` | `cursor` | link, disable flag |
| `muse` | `/root/.config/muse/skills` | `muse` | link, created when missing |
| `openclaw` | `/root/.openclaw/skills` | `claude-code` | repoint-only |
| `openclaw-ws` | `/root/.openclaw/workspace/skills` | `claude-code` | repoint-only |
| `cursor` | `/root/.cursor/skills` | `cursor` | link, enable flag |

Link replacement is atomic with `RESTORE.md`/`MANIFEST.sha256` backups. The
planner actions stay `link-new`, `repoint`, `backup-then-link`,
`remove-own-link` and `skip-warn`. `--check` exits 1 when any non-`skip-warn`
change is pending and writes nothing.

## Refusal and warning rules

- The sync refuses before any fetch on a dirty tree or a branch other than
  `main`, and after fetching on a history that is not a fast-forward. A failed
  git step (status, fetch, merge-base, rev-parse, merge) warns and exits 1; an
  empty library refuses to project and exits 1. Policy refusals exit 0.
- Untracked `__pycache__` paths and `.pyc` files do not make the checkout
  dirty (skill scripts run through the projected links write caches into the
  checkout); any other untracked path, and any tracked change, still refuses.
- Every refusal warning is a host-job event: surface `substrate`, actor
  `agent`, action `skills.sync`, runtime `skills-sync`, a reason, no `repo`,
  session `skills-sync:<UTC yyyy-mm-ddThh>`. This maps onto the existing
  `skills.sync.refused` vocabulary row; no new kind was added.
- Warnings fire on a change of refusal reason, and at most once per UTC day
  while a reason persists. A tick that clears the refusal logs a `cleared`
  line and emits nothing. The projector keeps its own per-`(root, name,
  reason)` dedupe with reasons `real-dir-differs`, `foreign-link` and
  `stray-real-dir`.
- Journal lines stay `[skills-sync] ff <old>..<new> | current <sha> |
  refused <reason> | cleared <reason>` and `[projector] …`. Reasons and rule
  names travel; values never do.

## Bridge replies: final versus kept

A Hermes group or queue file is removed or moved only on a final reply:

- Final: 200 with `opened`, `existing`, `unchanged` or `declined`; 400
  (refused, logged with rule names). 413 or an over-cap body holds a Hermes
  group as `oversize` and moves a queue file to `rejected/`.
- Kept (never deleted, moved or held): transport errors, a missing token, 401,
  403 (a surface mismatch is a configuration error), 502, 503, any other
  status and the `dry_run` status. 401, 403 and a missing token end the tick
  with exit 1 so the timer shows red.

Held Hermes records land in `bridge-held.json` with one logged reason per
record; the per-tick log is `bridge-log.jsonl`. A library skill is never
approved from a held record; the hint names the CLI and the `hermes` token
file in prose.

## Token sources per client

| Client | Surface | Source |
| --- | --- | --- |
| Skills sync | `substrate` | Its env file, through Phase 20's resolver order |
| Bridge, Hermes records | `hermes` | The `hermes` file in the tokens dir, read per request |
| Bridge, Omp queue | `omp` | The `omp` file in the tokens dir, read per request |
| Bridge, Grok queue | `grok-build` | The `grok-build` file in the tokens dir, read per request |
| Omp extension | `omp` | Direct, token-file, then tokens-dir order for surface `omp` |
| skill-autonomy staging | `grok-build` | No token: it stages into the Grok queue and the bridge proposes it |

The tokens dir is the `SUBSTRATE_TOKENS_DIR` value when set, else the built-in
tokens directory. Token files hold one short value (first line, 4 KiB cap);
any error means "no token" and the value is never logged, queued or put in a
reason. Because one bridge process serves three surfaces, it refuses to run
(exit 1, one line naming the variable, never a value) while a single-token
variable is set in its environment — so its env file must never define one.
The identity manifest (`infra/identity/clients.json`) records the sync, the
bridge and the Omp extension as live rows.

## State files

| Path | Contents |
| --- | --- |
| `/var/lib/substrate/skills/` | The sync warned state, the projector warned file and the root enable/disable flags (Phase 21's shared state dir) |
| `/var/lib/substrate/miner/bridge-log.jsonl` | One line per bridge tick |
| `/var/lib/substrate/miner/bridge-held.json` | Held Hermes records with one reason each |
| `/var/lib/substrate/phase4-baseline/projector` | Projector backups (`RESTORE.md`, `MANIFEST.sha256`) |

## Overrides

Production defaults are September's. Every path below is a seam so tests and
the smoke run in tmp dirs and never touch the live paths:

| Variable | Moves |
| --- | --- |
| `SUBSTRATE_SKILLS_LIBRARY` | The library checkout (default `/root/agent-skills`) |
| `SUBSTRATE_SKILLS_HOME` | The home the roots live under (default `/root`) |
| `SUBSTRATE_SKILLS_STATE` | The warned-state and flag dir (default `/var/lib/substrate/skills`) |
| `SUBSTRATE_SKILLS_BACKUP` | The projector backup root |
| `SUBSTRATE_TRANSCRIPTS_DIR` | The transcripts the monitor reads |
| `SUBSTRATE_TOKENS_DIR` | The tokens dir the bridge and the extension read |
| `SUBSTRATE_URL` | The substrate base URL the sync posts warnings to and the bridge proposes to |
| `SUBSTRATE_SKILLS_BRIDGE_ENV` | The bridge env file the doctor checks |

## Units and env files

`substrate-skills-sync.service` runs `packages/projector/src/skills-sync.ts`
with bun; `substrate-skills-bridge.service` runs `python3 -m substrate_miner
bridge --once` with the release miner source on `PYTHONPATH` and bytecode
writes off. Both run from the pinned release with `ConditionPathExists` on
their entry, and both timers tick every 5 minutes (see
[infra/vps/README.md](../infra/vps/README.md)). Neither loads the shared
server env: the sync reads its own env file, the bridge reads its own env
file, and the bridge file must never define a single-token variable. Oneshot
services pick up the release on their next tick, so a deploy never restarts
the timers.

`bun run skills:doctor` (`scripts/skills-doctor.ts`) is the read-only
pre-flight check: library state, projection drift, the Omp link target, the
Hermes approval flags, the monitor script copy and the bridge env-file rule.
It never calls systemd, GitHub or the substrate, never prints a value, and
exits 1 on any finding. Run it after each live step below.

## Cutover and rollback runbook (L1–L8)

Each step waits for operator approval, and the doctor runs after each one.

- **L1 Deploy.** Tag a release containing this phase and publish it with
  `deploy-release.sh <tag>`, then run `doctor-units` read-only against the
  release. The skills timers are not restarted from the deploy script.
- **L2 Install units.** Create the two env files (root-owned, mode 0600, names
  in `infra/vps/README.md`), install the four unit files and the two drop-ins,
  reload systemd, then enable and start `substrate-skills-sync.timer` only.
- **L3 agent-skills `.gitignore`.** Open a draft PR adding the cache ignores;
  the owner merges. Until then the D22-02 ignore rule keeps cache noise from
  refusing ticks.
- **L4 Bridge first run.** Run `bridge --once --dry-run` against production,
  review the per-group list (a Hermes record can be rejected first), then
  enable `substrate-skills-bridge.timer`. The first real tick turns the staged
  backlog into PRs.
- **L5 Omp extension.** Repoint the `~/.omp/agent/extensions/substrate-skills.ts`
  symlink at the release copy.
- **L6 Hermes cron.** Point job `substrate-skill-miner` at the release monitor
  script and skill, clear its failure streak with Hermes' own cron commands,
  and confirm both approval flags read true.
- **L7 Retire the propose key.** Move the propose key file into the phase
  backup directory.
- **L8 Proof.** A real Cursor session ends, the hook copies its transcript, the
  next hourly Hermes run stages at most 3 skills, the bridge opens the PR, the
  owner merges, and within one sync tick the skill is linked for the agents —
  recorded in `22-PROOF.md`.

**Rollback.** The timers follow the release symlink: `deploy-release.sh
rollback` moves `current` back and both ticks pick up the previous tree on
their next fire — no timer restart needed. To remove the plane entirely,
delete the four unit files and the two drop-ins, reload, and revert the
client and doc edits; the library checkout and the projected links stay as
they are (the next sync tick would have re-projected them, and with the timer
gone they simply stop changing).
