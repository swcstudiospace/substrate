# Runbook — lane-B collectors cutover (herdr + muse)

| | |
| --- | --- |
| Requirement | LANEB-07 |
| Window | Operator-approved, after this phase merges to `main` |
| Scope | `substrate-collector-herdr.service` and `substrate-collector-muse.service` owning the herdr and brief lanes |
| Untouched | `substrate-collector-grok.service`, `substrate-mcp.service`, `/root/.cursor/hooks.json`, user-scope Muse plugins (until step 5 below) |

## Status

Cut over on 2026-10-10 (operator-approved): both collectors run `main`'s code from the pinned release
(`WorkingDirectory=/opt/agent-substrate/current`) with collector-only env files, and a release deploy
restarts them with the other release units (infra/vps/README.md). The steps below are that procedure.

## Operator cutover (one approved window, one collector at a time)

Run from a session on the host. Names only below — no file in git holds an
environment value.

```sh
# 1. Back up the installed units and collector state (timestamped).
B=/root/backups/lane-b-cutover-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$B"
cp -a /etc/systemd/system/substrate-collector-herdr.service /etc/systemd/system/substrate-collector-muse.service "$B"/
cp -a /var/lib/substrate/herdr-offsets.json /var/lib/substrate/muse-offsets.json "$B"/ 2>/dev/null || true

# 2. Create each collector's env file (root-owned, 0600) with only the names
#    its process reads: herdr SUBSTRATE_URL, SUBSTRATE_TOKEN (and optionally
#    HERDR_SOCKET_PATH / HERDR_SESSION); muse SUBSTRATE_URL, SUBSTRATE_TOKEN,
#    SUBSTRATE_MUSE_REPOS. Never point a collector at /etc/substrate/substrate.env.
#    Files: /etc/substrate/substrate-collector-herdr.env, /etc/substrate/substrate-collector-muse.env

# 3. Install a unit and its drop-in from the release tree, then reload.
cd /opt/agent-substrate/current
for c in herdr muse; do
  install -m 0644 infra/vps/substrate-collector-$c.service /etc/systemd/system/
  install -D -m 0644 infra/vps/substrate-collector-$c.service.d/10-environment.conf \
    /etc/systemd/system/substrate-collector-$c.service.d/10-environment.conf
done
systemctl daemon-reload

# 4. Restart one collector, confirm active/running with NRestarts=0, restart it
#    once more to prove it survives, then do the other.
systemctl restart substrate-collector-herdr && systemctl show substrate-collector-herdr -p ActiveState -p SubState -p NRestarts
systemctl restart substrate-collector-muse && systemctl show substrate-collector-muse -p ActiveState -p SubState -p NRestarts

# 5. Project the Muse plugin in user scope, then confirm the Cursor hook.
bun packages/projector/src/muse.ts
bun packages/projector/src/cursor.ts --check

# 6. Read the refusal reporter. Zero refused is the expected line.
bun run collectors:status
```

Step 5 installs (or updates) the `substrate` plugin for the operator user
and approves its `post-tool-use` hook. It is the only step that writes
outside `/etc/systemd/system` and `/etc/substrate`. Step 6 is read-only:
each collector's `stored` counter should climb while `refused` stays 0 —
a refused line names its collector, source, kind, surface and status in
`/var/lib/substrate/refused-emits.jsonl`. The bare SUBSTRATE_TOKEN this cutover provisions in the herdr env file is removed again at the Phase 20 window, where per-event resolution replaces it; see the ordered window in `production-identity.md`.

## Rollback

Operator only. To a previous release: `deploy-release.sh rollback` (it restarts the collectors with
the other release units). To the pre-cutover units: restore them from the step 1 backup and remove the
drop-ins. Never restart a unit whose `WorkingDirectory` has no entry file for it.

```sh
systemctl stop substrate-collector-herdr substrate-collector-muse
cp -a "$B"/substrate-collector-*.service /etc/systemd/system/
rm -rf /etc/systemd/system/substrate-collector-{herdr,muse}.service.d
systemctl daemon-reload
# Restart only what the restored tree actually contains; if the restored
# tree has no herdr/muse collector entry files, leave the pair stopped.
test -f packages/collectors/src/herdr.ts && systemctl restart substrate-collector-herdr || true
test -f packages/collectors/src/muse.ts && systemctl restart substrate-collector-muse || true
bun run collectors:status
```

## Who does what

| Actor | Owns |
| --- | --- |
| Operator | The window, the pull, the env files, the install, the restarts, the user-scope projection, the rollback |
| Agents | The unit files, the proof, this runbook — never `systemctl restart`, never user-scope projection, never `/root/.cursor/hooks.json` |

## Manual-only verifications (never autonomous)

- The cutover window itself: restarting production collector units needs
  operator approval after merge. No task in this phase runs it.
- Projecting into user-scope Muse and editing `/root/.cursor/hooks.json`
  are operator hands only; the proof asserts the operator cache paths are
  identical before and after for exactly this reason.
- The optional real Muse model turn (a live tool call through the
  projected hook with operator approval) is manual-only. The proof drives
  the same hook file with a fixture and no model.

## Isolated proof evidence (SC-2 style)

Proven from the worktree against the `p19` harness twin
(`rehearsal up --surfaces claude-code,cursor,hermes,omp,muse --name p19`);
only hosts, ports, key names and booleans are recorded here.

- `bun run proof:laneb` 27/27: scratch repo under a run-tagged rehearsal
  slug; working → idle → close through the real herdr collector with a
  kill-and-restart between working and idle emitting exactly one
  `session.start`; idle `note` with runtime herdr; Muse `tool.call` with
  the branch via the projected hook; `session.end` with the repo — all
  inside one repo-filtered read within budget.
- Brief writer: `BRIEF.md` lists the note and the tool call, one pointer
  block across five reruns, closed-port run byte-identical.
- Cursor stop: synthetic envelope with a runtime-assembled shape; 0600
  redacted copy; `session.end` names the copy. Dead-url hook runs exit 0
  with empty stdout inside the bound.
- `collectors:status` reports zero refused. Guard checks refuse port 7410
  and non-loopback hosts with exit 2 before any request.
- Production touch: none. The proof never connects to a live herdr
  session (loopback stub source, child envs carry no HERDR entries), never
  installs a user-scope plugin, and leaves the twin up for the
  operator's `rehearsal down --name p19`.
