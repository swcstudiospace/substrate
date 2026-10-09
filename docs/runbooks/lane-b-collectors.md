# Runbook — lane-B collectors cutover (herdr + muse)

| | |
| --- | --- |
| Requirement | LANEB-07 |
| Window | Operator-approved, after this phase merges to `main` |
| Scope | `substrate-collector-herdr.service` and `substrate-collector-muse.service` owning the herdr and brief lanes |
| Untouched | `substrate-collector-grok.service`, `substrate-mcp.service`, `/root/.cursor/hooks.json`, user-scope Muse plugins (until step 5 below) |

## Warning: the units run code that is missing from disk

The installed herdr and muse collector units point at entry files
(`packages/collectors/src/herdr.ts`, `packages/collectors/src/muse.ts`)
that reach `main` only through this phase. Restarting either unit before
the merge fails closed on a missing module. Do not restart them, do not
reinstall them, and do not project the Muse plugin into user scope until
the cutover window below. The isolated proof (`bun run proof:laneb`)
covers the same code against the harness twin without touching these units.

## Operator cutover (six steps, one approved window, after merge)

Run from a session on the host. Names only below — no file in git holds an
environment value.

```sh
# 1. Back up the checkout and the installed units first — the rollback below
#    restores from this tarball. Then pull main, so both entry files exist.
tar -czf "/root/substrate-cutover-backup-$(date +%Y%m%dT%H%M%S).tgz" --exclude=.git -C /root/src/repos/agent-substrate . || exit 1
cp /etc/systemd/system/substrate-collector-herdr.service /etc/systemd/system/substrate-collector-muse.service /root/ 2>/dev/null || true
git -C /root/src/repos/agent-substrate pull --ff-only origin main

# 2. Create the per-collector env files only when absent (root-owned, mode
#    0600). Each holds only the names its process reads: SUBSTRATE_URL and
#    SUBSTRATE_TOKEN. SUBSTRATE_COLLECTOR_STATE and SUBSTRATE_STATE_DIR
#    already ride on the units. A rerun must never truncate files the
#    operator already provisioned — create, then stop and provision the
#    tokens and URL before touching the running services.
for unit in herdr muse; do
  file="/etc/substrate/substrate-collector-${unit}.env"
  if [ ! -e "$file" ]; then install -m 0600 /dev/null "$file"; fi
done
# Provision SUBSTRATE_URL and SUBSTRATE_TOKEN in both files now. Step 4
# restarts the services, so a missing token there fails closed on restart.

# 3. Install both units from the merged tree and reload.
cp infra/vps/substrate-collector-herdr.service /etc/systemd/system/substrate-collector-herdr.service
cp infra/vps/substrate-collector-muse.service /etc/systemd/system/substrate-collector-muse.service
systemctl daemon-reload

# 4. Restart the two collectors.
systemctl restart substrate-collector-herdr substrate-collector-muse

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

Operator only. The first cutover has no collector-bearing commit to check
out: this phase is what introduces `packages/collectors/src/herdr.ts`,
`packages/collectors/src/muse.ts`, both unit files and
`collectors:status`, so checking out the pre-PR commit removes the very
modules the restarted units would exec. Instead, stop the new services and
restore the code and units from the pre-cutover backup the operator took in
step 1 (a tarball of the checkout plus `/etc/systemd/system`). If there was
no previous collector generation to restore, leave the pair stopped and
report the cutover as not in effect — never restart the installed units
against a tree that no longer contains their entry files.

```sh
systemctl stop substrate-collector-herdr substrate-collector-muse
# Restore the pre-cutover backup taken before step 1, then:
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
