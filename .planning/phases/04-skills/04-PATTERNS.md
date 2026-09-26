# Phase 4: Skills — Pattern Map

**Mapped:** 2026-09-26 (revised the same day after `04-PLAN-CHECK.md`: 04-03 split into 04-03 + 04-04, later plans renumbered 04-05..04-12, B1/B2/W1-W10 folded in)
**Files analyzed:** 62 (agent-substrate TS 23 + Python 8 + infra 4 + evidence 13; skill-autonomy 13; docs-scraper 1) plus the live files each plan snapshots
**Analogs found:** 59 / 62 (no in-repo analog: systemd `.timer` units, the Omp extension's in-repo home, the Hermes pending-record replay)

All analog paths below were read at HEAD `0e46068` and are git-tracked (`git ls-files` checked for `packages/*/src/*`, `infra/vps/*`, `packages/dispatcher/*`). `packages/miner/` holds only an empty `src/` and is not a root workspace (Python, like `packages/dispatcher`). `packages/projector/package.json` names a missing `src/index.ts`; Phase 4 does not add one (every projector file is its own entry script, as `cursor.ts` is). The root `tsconfig.json` includes `packages/**/*.ts`, so the new `packages/projector/omp/*.ts` and `packages/collectors/src/cursor-stop.ts` are type-checked by the phase gate.

## File Classification

| New/Modified File | Plan | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|---|
| packages/mcp-server/src/redact.ts (M: `redactSkillContent`, `scanSkillFiles`) | 04-02 | utility | transform | itself `RULES` L18-50, `redact()` L53-57 | exact |
| packages/mcp-server/src/redact.test.ts (M) | 04-02 | test | — | itself L1-20 | exact |
| packages/mcp-server/src/types.ts (M: `skill.propose`, `docs-scraper`) | 04-03 | contract | — | itself `SURFACES` L3-16, `EVENT_KINDS` L19-38; precedent: Phase 1 added `herdr` + 3 kinds (STATE Decisions) | exact |
| packages/mcp-server/src/skills/frontmatter.ts (NEW) | 04-03 | utility | transform | `Bun.YAML.parse` (bun 1.4.0, research Standard Stack); shape of `seed.ts` validators L12-26 | role-match |
| packages/mcp-server/src/skills/propose.ts (NEW) | 04-03 | service (credential-spending) | request-response (git/gh via execFile) | `packages/host/src/hostfns.ts` L17-112 (limits, argv builders, `originMatches` L86-91, `Runner`/`execFileRunner` L93-112), L190-230 (`PR_URL_RE`, `prUrlOf`, recorded-URL idempotence) | exact |
| packages/mcp-server/src/skills/propose.test.ts (NEW) | 04-03 | test | — | `packages/host/src/hostfns.test.ts` (fake Runner, argv equality) | exact |
| packages/mcp-server/src/skills/propose-auth.ts (NEW: `readProposeKey`, `proposeAllowed`) | 04-03 | auth guard | request-response | `config.ts` `surfaceForToken` L81-86 (bearer → surface); node:crypto `timingSafeEqual` | role-match |
| packages/mcp-server/src/service.ts (M: `proposeSkill`, `stores.skills` seam) | 04-03 | service | request-response | itself constructor seam L81-92, `emit` L130-138, fail-open warning emit L405-418 | exact |
| packages/mcp-server/src/mcp.ts (M: `skills_propose`) | 04-03 | route | request-response | itself `events_emit` L99-124 (surfaceSchema, callerSurface), `ownerSurface` L30-39 | exact |
| packages/mcp-server/src/mcp.test.ts (M) | 04-03 | test | — | itself `connect()` L19-45 (InMemoryTransport, Substrate stub) | exact |
| packages/mcp-server/src/server.ts (M: `POST /skills/propose`, 413) | 04-03 | route | request-response | itself `/issue` L99-108, catch block L116-127, `readBody` L24-33 | exact |
| packages/mcp-server/src/server.test.ts (M) | 04-03 | test | — | itself L17-71 (ephemeral loopback server, `post()`) | exact |
| packages/cli/src/index.ts (M: `skills propose --dir`) | 04-03 | CLI | batch | itself `cmdEmit` L112-140, `parseArgs` L37-51, `switch` L176-195 | exact |
| packages/miner/skills/substrate-skill-miner/SKILL.md (NEW) | 04-03 | library content (tracer payload) | — | `/root/agent-skills/goal-decompose/SKILL.md` frontmatter shape (`name`, `description`) | role-match |
| packages/projector/src/skills.ts (NEW 04-04, M 04-05) | 04-04 → 04-05 | projector | file-I/O (symlinks) | `packages/projector/src/cursor.ts` L16-110 (`--check`, marker, backup, idempotent re-run, `[projector]` log lines) | role-match |
| packages/projector/src/skills.test.ts (NEW 04-04, M 04-05) | 04-04 → 04-05 | test | — | `packages/collectors/src/muse.test.ts` (tmp dirs) | role-match |
| packages/projector/src/skills-sync.ts (NEW) | 04-04 | job | batch (git ff + projector) | `hostfns.ts` `checkScratch` L119-130 (refuse before any write) + `Runner` L93-112 | role-match |
| packages/projector/src/skills-sync.test.ts (NEW) | 04-04 | test | — | `hostfns.test.ts` fake Runner | exact |
| infra/vps/substrate-skills-sync.service (NEW) | 04-04 | config | — | `infra/vps/substrate-mcp.service` (bun ExecStart, EnvironmentFile, hardening) | role-match (oneshot) |
| infra/vps/substrate-skills-sync.timer, substrate-skills-bridge.timer (NEW) | 04-04, 04-07 | config | — | none in `infra/vps` (research Q11: new pattern) | none |
| packages/host/src/options.ts (M: `skillMounts`, `listLibrary`) | 04-06 | pure option builder | transform | itself `networkPermissions` L98-120, `testRunArgv` L175-189 | exact |
| packages/host/src/options.test.ts (M) | 04-06 | test | — | itself L1-15 imports, `testRunArgv` cases | exact |
| packages/host/src/vm.ts (M: mounts in `resolveOptions`) | 04-06 | provider/config | event-driven | itself `resolveOptions` L361-383 (worktree `host_dir` mount L372), `HostVmConfig` L42-60 | exact |
| packages/host/src/main.ts (M: library dir, reserved names) | 04-06 | entrypoint | — | itself `skillsDir` L62, `loadSkills` L72-92, `createHostVm({…})` L161 | exact |
| packages/miner/pyproject.toml (NEW) | 04-07 | config | — | `packages/dispatcher/pyproject.toml` (testpaths, pythonpath, httpx) | exact |
| packages/miner/src/substrate_miner/bridge.py (NEW) | 04-07 | client + replay | batch/poll + file-I/O | `packages/dispatcher/src/substrate_dispatcher/mcp.py` L17-72 (httpx client, `transport=` seam, error class); research Code Examples "Hermes bridge record → tree" | role-match |
| packages/miner/src/substrate_miner/monitor.py (NEW) | 04-07 | script | transform (deterministic stdout) | none in repo; contract `cron/scheduler_script.py:280-289`, `cron/jobs.py:1672-1680` | partial |
| packages/miner/src/substrate_miner/__init__.py, __main__.py (NEW) | 04-07 | entrypoint | batch | `packages/dispatcher/src/substrate_dispatcher/__main__.py` (argparse `main`) | exact |
| packages/miner/tests/test_bridge.py, test_monitor.py (NEW) | 04-07 | test | — | `packages/dispatcher/tests/test_clients.py` L1-30 (`httpx.MockTransport`) | exact |
| packages/miner/hermes/substrate-skill-miner-monitor.sh (NEW, installed as a real file) | 04-07 | shim | — | none (Pitfall 7: must be a real file in `~/.hermes/scripts/`; `cron/scheduler_script.py:305-309` runs `.sh` with bash, anything else with Hermes' own python) | none |
| infra/vps/substrate-skills-bridge.service (NEW) | 04-07 | config | — | `infra/vps/substrate-dispatcher.service` (python3 + PYTHONPATH) | role-match |
| packages/projector/omp/substrate-skills.ts (NEW) | 04-08 | extension | event-driven (`tool_call`) | out-of-repo analog `~/.omp/agent/extensions/herdr-omp-agent-state.ts` L245 (`export default function (pi)`), L375+ (`pi.on`); result type `@oh-my-pi/pi-coding-agent/src/extensibility/shared-events.ts` L313-343 | role-match |
| packages/projector/omp/substrate-skills.test.ts (NEW) | 04-08 | test | — | `hostfns.test.ts` (injected fakes) | role-match |
| skill-autonomy src/skill_autonomy/propose.py (NEW) | 04-09 | client | request-response | `skill_write.py` L66-98 (the write it replaces); stdlib `urllib.request` | role-match |
| skill-autonomy skill_write.py, improve.py, hooks/stop.py, cli.py (M) | 04-09 | service/hook/CLI | — | themselves: `write_skill` L66-98, `run_improve` L100-147, `handle_stop` L40-69, `build_parser`/`dispatch` L110-165 | exact |
| skill-autonomy tests/test_propose.py (NEW), test_improve.py, test_hooks.py, test_cli.py (M) | 04-09 | test | — | `tests/conftest.py` `grok_home` fixture L20-29; `test_improve.py` L6-33 | exact |
| skill-autonomy rules/skill-autonomy.md, commands/autolearn.md, skills/autolearn/SKILL.md, README.md (M) | 04-09 | docs/instructions | — | themselves (rules L21-23; commands L13; skill L13, L39; README L6, L49) | exact |
| docs-scraper scripts/batch_docs_skills.py (M) | 04-10 | batch script | subprocess | itself `_install_skill` L163-189 (replaced), call site L317-320, README rewrite L330-361 and L415-417 (deleted) | exact |
| docs-scraper skills/docs-scraper (a symlink → /root/agent-skills/docs-scraper; NOT edited — checker B1) | 04-10 | library content (lives in the library checkout) | — | none: the corrected SKILL.md is built from `git -C /root/agent-skills archive HEAD docs-scraper` in a scratch dir under /var/lib/substrate/skills and proposed with `_propose_skill`; nothing writes through the link | n/a |
| packages/collectors/src/cursor-stop.ts (NEW) | 04-11 | hook script | stdin → file-I/O + POST /events | `packages/collectors/src/muse.ts` (redact import L23, `import.meta.main` L180); stdin precedent `~/.cursor/hooks/gsd-cursor-stop.js` L30-45 (timeout, fail-open) | role-match |
| packages/collectors/src/cursor-stop.test.ts (NEW) | 04-11 | test | — | `packages/collectors/src/grok-map.test.ts` | exact |
| packages/projector/src/cursor.ts (M: stop entry → script) | 04-11 | projector | file-I/O | itself `command()` L34-40, `DESIRED` L42-47 | exact |
| .planning/phases/04-skills/04-BASELINE.md (NEW) | 04-01 | evidence | key=value | `.planning/phases/03-lane-a/03-BASELINE.md` | exact |
| .planning/phases/04-skills/04-01-SPIKE.md (NEW) | 04-01 | evidence | key=value | `03-01-SPIKE.md` | exact |
| .planning/phases/04-skills/04-02-SCAN.md, 04-0N-SMOKE.md, 04-03-TRACER.md, 04-04-TRACER.md, 04-PROOF.md (NEW) | all | evidence | key=value + `## Gaps` | `03-07-SMOKE.md`, `03-03-TRACER.md`, `03-PROOF.md` | exact |
| skill-autonomy `.git` baseline (existing 4-line `.gitignore` kept byte-identical; every non-ignored file tracked, `.grok-plugin/` included) | 04-01 | baseline | — | Phase 1 baselines (`hermes-plugin` 65caa2d; STATE Decisions); staging list = `git ls-files -z --others --exclude-standard` | role-match |

## Pattern Assignments

### propose.ts — analog `packages/host/src/hostfns.ts`

Copy the **shape**, not the import: the dependency already runs host → mcp-server (`hostfns.ts` L11 imports `../../mcp-server/src/redact.ts`), so mcp-server must not import host. Copy `Runner`/`RunResult`/`execFileRunner` (L93-112: execFile with an argv, never a shell, 120 s, `maxBuffer` 4 MiB, `env: { ...process.env, HOME: "/root" }`) and `originMatches` (L86-91) into `propose.ts`, and the `PR_URL_RE`/`prUrlOf` pair (L190-199) with the repo fixed to `swcstudiospace/agent-skills`.
```ts
export const LIBRARY_REPO = "swcstudiospace/agent-skills";
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function pushArgv(clone: string, branch: string): string[] {
	return ["git", "-C", clone, "push", "origin", branch]; // never a force flag or a colon refspec (T-03-07-01 carry-over)
}
```
Every guard runs before the first network call (research Pattern 1): name, relative paths, no `..`, no dot-segments, SKILL.md present, frontmatter `name === dir`, non-empty `description`, NUL-free text, byte cap, then the skill redactor's findings. Errors carry at most a 400-character `redact()`ed tail of git/gh output (hostfns `tail()` L113-115). Idempotence is strongly consistent (checker W1): a ledger `/var/lib/substrate/skills/proposals.jsonl` maps `content_sha256` → branch and PR; an OPEN PR from `gh pr view <url>` returns `existing`; a CLOSED (unmerged) one returns `declined` and is never re-opened except by the CLI's `--reopen` (checker I19); a pushed branch without a recorded PR is re-found with `gh pr list --head <branch>` and never pushed twice; `git diff --cached --quiet` exit 0 returns `unchanged` with no push. Never use `gh pr list --search` (eventually consistent). Tree writes overlay the proposed files on `<name>/` from origin/main (unnamed files kept); `remove` lists deletions; only the CLI's `--replace` rewrites the whole tree (checker W2). The verify's force-flag gate counts quoted argv literals such as `"--force"`, so comments may name the rule but code must not carry the literal (checker W9).

### mcp.ts `skills_propose` — analog itself `events_emit` L99-124
```ts
server.registerTool("skills_propose", {
	title: "Propose a skill to the shared library",
	description: "Validates, redacts and opens a branch + PR on swcstudiospace/agent-skills. Never publishes live; the owner merges.",
	inputSchema: { name: z.string(), files: z.record(z.string(), z.string()), rationale: z.string(),
		remove: z.array(z.string()).optional(), surface: surfaceSchema.optional(), session_id: z.string().optional(), graph_id: z.string().optional() },
	annotations: { destructiveHint: false, openWorldHint: true },
}, async (args) => { if (!opts.proposeAllowed) return refusal("needs an authenticated surface or the host propose key"); const owner = ownerSurface(args.surface, callerSurface); /* refusal → text */ return json(await substrate.proposeSkill({ ...args, surface: owner.surface })); });
```
Surface rule is `ownerSurface` L30-39 unchanged (authenticated caller cannot name another surface; anonymous is attributed by payload). Caller rule first (checker W4): `createMcpServer(substrate, callerSurface, { proposeAllowed })` — server.ts computes `proposeAllowed` from a bearer surface or the `x-substrate-propose-key` header against `/var/lib/substrate/skills/propose.key` (`skills/propose-auth.ts`); without it the tool returns an isError refusal and never calls the service (rivet VM guests connect anonymously, `packages/host/src/tasks.ts` L408-409).

### server.ts `POST /skills/propose` — analog itself `/issue` L99-108
Same `readBody` → `JSON.parse` → field checks → `sendJson`. New: `readBody` throws a named `BodyTooLargeError` (L29) that the shared catch (L116-127) maps to **413** before the generic 500; `InvalidEventError` and `SyntaxError` stay 400. Caller check before `readBody`: no bearer surface and no valid `x-substrate-propose-key` → **401** (checker W4). Status map for this route: 200 `opened|existing|unchanged`, 400 validation or secret findings (`{ error, findings: [{ file, line, rule }] }`, never a value), 502 git/gh failure. Add the route to the header docblock L3-9.

### service.ts `proposeSkill` — analog itself constructor seam L81-92 and `emit` L130-138
`stores?.skills` is the test seam (`{ propose(input): Promise<ProposeResult> }`); production builds `createSkillProposer()` from `skills/propose.ts`. After a result, emit `kind: "skill.propose"` through `this.emit(...).catch(() => undefined)` — the side effect never fails the primary op (L405-418 convention).

### cli/index.ts `skills propose` — analog `cmdEmit` L112-140 and the `switch` L176-195
Unlike `brief`/`emit` (always exit 0, hook-safe, docblock L10-13), `skills propose` is operator/batch-facing and exits 1 on a refusal, like `verify`. It reads the directory itself (lstat: no symlinks; fatal UTF-8 decode; skip nothing silently), calls `proposeSkill` from `../../mcp-server/src/skills/propose.ts` in-process (no 1 MB HTTP cap), then POSTs the `skill.propose` event with `post()` L73-84. Output is `key=value` lines (`status=`, `pr_url=`, `branch=`, `content_sha256=`, `redactions=`, `event_status=`).

### projector/src/skills.ts — analog `projector/src/cursor.ts`
Keep cursor.ts's contract: `--check` exits 1 on drift and writes nothing (L101-104); a re-run with nothing to do prints an "already current" line and exits 0 (L96-99); log prefix `[projector]`. Differences: a **pure planner + executor** (`plan(inventory, library, roots) → Action[]`, `apply(actions, ctx)`), per-action backups under `/var/lib/substrate/phase4-baseline/projector/<ts>/` with one RESTORE.md line per action (instead of cursor.ts's single overwritten `.substrate-backup`, L106), and atomic symlink replacement (`<name>.substrate-tmp` + `rename()`).

### skills-sync.ts — analog `hostfns.ts` `checkScratch` L119-130
Refuse before any write: dirty tree, wrong branch, diverged history each end the tick with a `warning` event and no merge. The pure `decide()` is tested with plain objects; the executor takes the `Runner`.

### options.ts `skillMounts` — analog itself and `vm.ts` L372
```ts
{ path: "/home/agentos/work", plugin: { id: "host_dir", config: { hostPath: worktree } } } // vm.ts L372
// per library skill (mount_route nested):
{ path: `/home/agentos/.claude/skills/${name}`, plugin: { id: "host_dir", config: { hostPath: `${libraryDir}/${name}`, readOnly: true } } }
```
Pure builder in options.ts so `options.test.ts` covers it without importing `@rivet-dev/*` (03-PATTERNS rule: no rivet import in any test). `seed.ts` L254-266 keeps writing the four ultrathink skills; `seed.test.ts` L80-90 and `tasks.test.ts` L233-241 are not edited. Copy route (mount_route=none, checker W7): `libraryCopyPlan` (pure, confined to `<libraryDir>/<valid name>/…` from `git ls-files`) and `copyLibraryInto` (structural target) in options.ts; vm.ts wires them in rivet's `onVmStart` (agentos dist/index.d.ts L438) — no Phase-3 file changes. `copyLibraryInto` clears the head marker first, `mkdir(…, { recursive: true })`s every parent dir, checks each `BatchWriteResult.success`, and writes the marker only after a complete copy (checker I17).

### packages/miner — analog `packages/dispatcher`
`pyproject.toml` copies dispatcher's `[tool.pytest.ini_options] testpaths=["tests"] pythonpath=["src"]` and `httpx>=0.27`. The HTTP client copies `mcp.py` L17-72: `DEFAULT_URL`, a `transport=` kwarg for `httpx.MockTransport`, a `BridgeError(RuntimeError)`, errors as `f"...: {type(exc).__name__}"` and `HTTP {status}: {text[:200]}`. The replay follows research § Code Examples (group by name, `created_at` order, `create|edit|write_file|remove_file|patch|batch`, deletes skipped). Scope (checker W3): `hermes_local_names` + `classify` hold every group that is not a library skill or a foreground create of a new name — held records stay in pending/skills with one logged reason, never unlinked. Content (checker W2): `proposal_for` sends changed files plus SKILL.md and a `remove` list; 413 or an oversize body is held. The client sends `x-substrate-propose-key` read per request (checker W4). Held library-skill records are resolved only by a propose PR or a rejection, never by a local `/skills approve` (it replays past the gate into external_dirs, i.e. the checkout); every held line carries that `resolve` hint (checker W11).

### Omp extension — out-of-repo analog `~/.omp/agent/extensions/herdr-omp-agent-state.ts` L245
```ts
export default function (pi: OmpPi) { pi.on("tool_call", (event) => handler(event)); }
```
Result type (verified at `shared-events.ts` L313-343): `{ block?: boolean; reason?: string; input?: Record<string, unknown>; additionalContext?: string }` — `additionalContext` is a **string**, not the array the research sketch shows. No import from `@oh-my-pi/*`; a local structural type keeps root tsc clean.

### skill-autonomy — analog itself
`write_skill` L66-98 keeps `looks_secret_heavy` and the `RESERVED` rename, and replaces the `target.write_text` with an injected `proposer` call. Tests reuse `conftest.py` `grok_home` (L20-29: `GROK_HOME`, `SKILL_AUTONOMY_DATA_DIR`) and assert that nothing appears under `grok_home / "skills"`.

### docs-scraper — analog itself
`_install_skill` L163-189 becomes `_propose_skill`, which shells out to the substrate CLI with an argv list (`subprocess.run(argv, capture_output=True, text=True, timeout=600)`), never a shell string; `_update_agent_skills_readme` L330-361 and its call L415-417 are deleted; the env targets L40-45 are deleted. The argv adds `--replace` (an export is the whole skill; the CLI is the only caller allowed to replace a tree, checker W2). The script is snapshotted with a RESTORE route before the edit (checker W6). The docs-scraper skill itself is not edited in the workspace: `skills/docs-scraper` is a symlink into the library checkout (checker B1).

### collectors/src/cursor-stop.ts — analogs `collectors/src/muse.ts` and `~/.cursor/hooks/gsd-cursor-stop.js`
Stdin with a timeout (gsd-cursor-stop.js L30-45), fail open, print nothing (Cursor's `followup_message` output auto-submits, research Q10). Redaction with `redact()` from `../../mcp-server/src/redact.ts` (muse.ts L23). Pure helpers exported, `if (import.meta.main)` runner (muse.ts L180).

### cursor.ts — analog itself `command()` L34-40
Add a sibling helper for a script entry (`bun <script> >/dev/null 2>&1 || true`, stdin inherited) and point `DESIRED.stop` at `packages/collectors/src/cursor-stop.ts`; sessionStart and postToolUse are unchanged.

### systemd units — analogs `infra/vps/substrate-mcp.service`, `substrate-dispatcher.service`
```ini
[Unit]
Description=Agent Substrate — skills library sync (ff-only) and projection
After=network-online.target substrate-mcp.service
Wants=network-online.target
[Service]
Type=oneshot
EnvironmentFile=/etc/substrate/substrate.env
Environment=HOME=/root
WorkingDirectory=/root/src/repos/agent-substrate
ExecStart=/root/.local/share/reflex/bun/bin/bun packages/projector/src/skills-sync.ts
SyslogIdentifier=substrate-skills-sync
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=false
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
```
Timer: `[Timer] OnBootSec=2min OnUnitActiveSec=5min AccuracySec=30s Unit=substrate-skills-sync.service`, `[Install] WantedBy=timers.target`. Install: `sudo install -m 0644 infra/vps/<unit> /etc/systemd/system/`, `sudo systemctl daemon-reload`, `sudo systemctl enable --now <name>.timer`; the repo copy and `/etc` copy must `diff` clean (research Runtime State Inventory).

## Shared Patterns

- **Credential-spending code = pure argv builders + an executor with an injected Runner** (hostfns.ts; research Pattern 1). gh and git run with `HOME=/root` so `/root/.config/gh/hosts.yml` and `credential.https://github.com.helper=!/usr/bin/gh auth git-credential` answer; `substrate.env` has no `GH_TOKEN`/`GITHUB_TOKEN` (count checked with `sudo grep -cE '^(GH_TOKEN|GITHUB_TOKEN)=' /etc/substrate/substrate.env`). Interactive checks that must prove the service path use `env -i HOME=/root PATH=/usr/bin:/bin gh …` (research Q6) so the shell's `GH_TOKEN` is not what answered. Nothing prints a token.
- **Side effects never fail the primary op**: `.catch(() => undefined)` + a `warning` event (service.ts L405-418); hooks exit 0 always (cli docblock L10-13).
- **Idempotent projectors with markers and backups** (cursor.ts): `--check`, a second run is a no-op, a real directory that differs from the library is never touched (warn instead).
- **Live-file snapshot before edit** (standing rule): `/var/lib/substrate/phase4-baseline/` (0700), created by 04-01 with `RESTORE.md` as the index. Each plan snapshots into `/var/lib/substrate/phase4-baseline/04-NN/<UTC ts>/` with a `MANIFEST.sha256` and writes its routes to its **own** `RESTORE.d/04-NN.md`, so parallel wave-4 plans never share a live file. Units, shims and scripts a plan installs or edits get their undo route written before the install (checker W6: 04-07's bridge units and monitor shim, 04-10's script). The projector writes `projector/<ts>/RESTORE.md` per run. No Phase 1 snapshotted file is touched (D-17 keeps omp-ultrathink unedited); a plan that finds it must, reads `/var/lib/substrate/phase1-baseline/RESTORE.md` first.
- **Two-sided baseline gate** (03-PATTERNS § Shared Patterns, exact pipeline, `B=.planning/phases/04-skills/04-BASELINE.md`): normalized tsc diff against `agent-substrate-tsc-set:`, failing-id diff against `agent-substrate-failing-id:` (a vanished failure fails like a new one), pass count `-gt agent-substrate-pass` when the plan adds TS tests (`-ge` otherwise); dispatcher pytest diff against `dispatcher-failing-id:` with `passed -ge dispatcher-pass`; skill-autonomy the same against `skill-autonomy-*`; miner pytest has no baseline (new package) and must report 0 failed and ≥ the plan's test count.
- **Evidence files**: header `# 04-NN … evidence`, "Recorded from observed output only.", the exact commands in a fenced block, `key=value` lines at column 0, exactly one `## Gaps` heading, repeated runs moved under `## Failed runs` indented 4 spaces (02-PROOF convention). Verify loop: `for k in …; do test "$(grep -c "^$k=" $M)" = "1" || { echo "smoke missing or duplicate $k"; exit 1; }; done`. Evidence never contains a token shape; the verify greps for `gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|sk-ant-|lin_api_|ntn_[A-Za-z0-9]{30,}`.
- **Keyed calls** run under `sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env -E HOME=/root …` (03-PATTERNS). Phase 4 needs no key from substrate.env: gh uses hosts.yml.
- **Staging**: explicit paths only (`git add -- <paths>`), never `git add -A`, in agent-substrate, the library clone (`git add -- <name>`), skill-autonomy and `/root/.openclaw/workspace` (path-scoped to `projects/docs-scraper`). Commit messages carry `Refs SPE-2734` and `Refs SPE-3576`.
- **Contracts shared across wave-4 plans** (declared once, in 04-03's and 04-04's `<interfaces>`):
  - Propose body: `{ name, files: { "<rel path>": "<utf-8 text>" }, remove?: ["<rel path>"], rationale, surface, session_id?, graph_id? }` (files overlaid; SKILL.md required); reply `{ status: "opened"|"existing"|"unchanged"|"declined", pr_url?, pr_number?, branch?, content_sha256, redactions: [{ file, line, rule }] }`; 401 without an authenticated surface or the `x-substrate-propose-key` header; 413 is final for that body; `declined` (owner closed an identical proposal) is final too.
  - Queued proposal (Omp and Grok when substrate is down, answers 401, or the key file is unreadable): one JSON file holding exactly the propose body (never the key), mode 0600, named `<name>-<UTC ts>.json`, in `~/.omp/agent/substrate-pending/` or `~/.grok/plugin-data/skill-autonomy/pending/`; drained by the 04-07 bridge (which sends the key).
  - Cursor transcript copy: `/var/lib/substrate/transcripts/cursor/<conversation_id>.jsonl` (0600, dir 0700), `session.end` payload `{ conversation_id, transcript_ref, status }`.
  - Projector flag files: `/var/lib/substrate/skills/disable-agents-root`, `/var/lib/substrate/skills/enable-cursor-root` (04-05; used by the proof for D-20).

## No Analog Found

| File | Reason / guidance |
|---|---|
| infra/vps/*.timer | No timer units in `infra/vps`. Standard `[Timer]` + `WantedBy=timers.target`; install like the services; `systemctl list-timers` shows the next run. |
| packages/projector/omp/substrate-skills.ts | The in-repo home is new; the loader contract is Omp's (`extensions/loader.ts:547` accepts symlinks; `~/.omp/agent/extensions/` auto-discovered; `toolCallTimeoutMs` 30 000 fail-closed, `settings.ts:152`). Symlink it, do not copy. |
| packages/miner/src/substrate_miner/bridge.py replay | Replays Hermes `skill_manage` payloads (research Q5 payload shapes, `skill_manager_tool.py:633-642`); `patch` uses exact replace with an injected matcher (Pitfall 6); Hermes' `tools/fuzzy_match.py:337` is optional through the Hermes venv python. |

## PATTERN MAPPING COMPLETE
