# Runbook — lane-B collectors cutover (herdr + muse)

| | |
| --- | --- |
| Requirement | LANEB-07 |
| Window | Operator-approved, after this phase merges to `main` |
| Scope | `substrate-collector-herdr.service` and `substrate-collector-muse.service` owning the herdr and brief lanes |
| Untouched | `substrate-collector-grok.service`, `substrate-mcp.service`, `/root/.cursor/hooks.json`, user-scope Muse plugins (until step 5 below) |

## Status

> Historical receipt (recorded 2026-10-10, preserved as-is): cut over on
> 2026-10-10 (operator-approved) — both collectors run `main`'s code from
> the pinned release (`WorkingDirectory=/opt/agent-substrate/current`)
> with collector-only env files, and a release deploy restarts them with
> the other release units (infra/vps/README.md). This record does not claim
> the current editing session installed or restarted anything; all installs
> and restarts remain operator hands in an approved window. The steps below
> are that procedure.

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
#    Current lineage (must match before install): WorkingDirectory
#    /opt/agent-substrate/current; ExecStart
#    /root/.local/share/reflex/bun/bin/bun
#    packages/collectors/src/{herdr,muse}.ts --watch; drop-in
#    10-environment.conf carrying only
#    EnvironmentFile=/etc/substrate/substrate-collector-<name>.env; state
#    via StateDirectory=substrate plus SUBSTRATE_COLLECTOR_STATE and
#    SUBSTRATE_STATE_DIR under /var/lib/substrate. Static lint before any
#    install: systemd-analyze verify on both unit files (parent observed
#    exit 0 on 2026-10-10).
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
  projected hook with operator approval) is manual-only. The real-runtime
  proof drives the installed hook via `muse plugins hook test` under a
  scratch HOME with a fixture and no model.
- Global Cursor credential rotation is operator-only; the root credential
  disclosure is contained in the test fixture and rotation is not marked
  done here.

## Isolated proof evidence (SC-2 style)

Full record: `.planning/phases/19-lane-b-collectors/19-PROOF.md`
(parent-observed 2026-10-10, tag `p19-mv2i83ok`). Only hosts, ports, key
names and booleans are recorded here; no secret values.

### Real-runtime proof (current, supersedes the fixture run)

- `bun run proof:laneb` **41/41, exit 0**, under owned HOME/XDG/TMPDIR
  (fresh proof-owned twin name — never the pre-existing global `p19`):
  real named herdr (`herdr 0.9.1`, proof-owned `substrate-proof-*` session
  only); `workspace.create`, `pane.report_agent` working, own
  watching-collector stop/restart with saved state, `pane.report_agent`
  idle, `pane.close`; scratch-HOME Muse install (`validate` /
  `install-or-update` / `approve` / `inspect`, `trusted_enabled`) with
  installed redactor/config readback and the real installed hook-test CLI;
  installed-config URL-equality guard before hook execution.
- Boundary observations: URL refusal checked before execution;
  start/note/end/tool.call each within ten seconds of its own action;
  zero refused emits; operator Muse cache paths unchanged; proof-owned
  session stopped/deleted and temp dirs removed in `finally`
  (`up` exit 0 / `down` exit 0).
- Brief writer: `BRIEF.md` lists the note and the tool call, one pointer
  block across five reruns, closed-port run byte-identical.
- Cursor stop: synthetic envelope with a runtime-assembled shape; 0600
  redacted copy; `session.end` names the copy. Dead-url hook runs exit 0
  with empty stdout inside the bound.
- `collectors:status` reports zero refused. Guard checks refuse port 7410
  and non-loopback hosts with exit 2 before any request.
- Production touch: none. The proof never connects to the live default
  session (child envs carry no HERDR entries), never installs a user-scope
  plugin, performs no production restart/cutover, runs no model turns, and
  performs no credential rotation.

### Original fixture run (historical, 2026-10-09 — superseded, preserved)

`bun run proof:laneb` 27/27 against the `p19` harness twin with two
fixture-scoped substitutions: a loopback snapshot stub in place of a real
herdr server, and the hook file executed directly instead of the
installed `muse plugins hook test` path. Details remain in
`19-05-SUMMARY.md`; the `Known Stubs: None` assertion for that run is
withdrawn there.
