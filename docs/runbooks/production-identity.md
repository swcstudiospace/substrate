# Runbook — production identity for substrate-mcp

| | |
| --- | --- |
| Requirement | FOUND-04 |
| Manifest | `infra/identity/clients.json` (tracked, names only, no values) |
| Check | `scripts/identity-check.ts`, run as `bun run identity:check` |
| Window | Operator-approved switch-on window (client files, checks, one restart, evidence, soak) |
| Scope | Every client of production `substrate-mcp` and the token it holds at switch-on |
| Untouched | `EVENT_KINDS`, `SURFACES`, `redact.ts`, the dispatcher and host code (their bearer support lands in their own phases) |

## What this runbook proves, and how

Switch-on is client first, server last: every live client holds its token
before the server starts demanding one, so no listed client is left without
a token, and one restart rolls everything back. This runbook is the human
half of that guarantee; `identity:check` is the machine half. Commands as
run, from a session on the host. Nothing below prints, logs or writes a
token value, and no command carries a credential.

The check is `scripts/identity-check.ts`, run as `bun run identity:check`:

```sh
bun run identity:check [--values] [--json]
```

It exits `0` when no live client would be stranded, `1` when one would,
`2` when it could not ask. The default mode is agent-safe: it reads
variable names only and reports, per client, whether its delivery target
exists and names the right variable, and whether the server env file names
the token variable of every live-client surface plus the operator, handoff
and audit names. Rows that are `not-installed`, dormant, or gated by the
step-1 collector cutover still list under the server names for visibility
but never fail the verdict: swarm workspaces provision on install.
The `--values` mode is operator only: it compares each client's
value with the server's list in memory and prints only `match`,
`missing` or `mismatch` per client. Neither mode prints, logs or writes a
value. `--json` emits the same verdicts for the evidence table below.

## Where the files live

Client token files live in the tokens dir beneath the substrate config
dir, which defaults to the system tokens path. The server variables live
in the server env file under the substrate config dir. External clients
keep their own convention: the grok-hermes connector env file under the
connector config dir, and the Grok Bot gateway env file under the gateway
config dir, each holding the bare client variable. The operator token
lives in the operator token file under the operator config dir and is
held by nothing else. Per-collector and per-unit env files live under the
substrate config dir beside the server env file.

## Clients

One row per manifest client. The `delivery` column mirrors
`infra/identity/clients.json`: the tokens-dir file for the surface, an
env file plus its variable, the operator token file, or an external note.
A lock test fails when a manifest id is missing from this table, so the
two cannot drift.

<!-- identity-clients:start -->

| id | surface | delivery | state | evidence |
| --- | --- | --- | --- | --- |
| `cursor-hooks` | `cursor` | tokens-dir file for the surface | `live` | metrics 2xx points under surface cursor plus a fresh sessionStart brief write |
| `substrate-cli` | `claude-code` | tokens-dir file for the surface | `live` | metrics 2xx points under surface claude-code |
| `claude-hooks` | `claude-code` | external note: claude-ultrathink hook resolution in its own repo across env, token file and tokens dir | `live` | metrics 2xx points under surface claude-code |
| `claude-mcp` | `claude-code` | external note: opt-in user-scope substrate entry whose header names the token variable | `live` | graph registered by surface claude-code after a real kickoff |
| `grok-hooks` | `grok-build` | external note: claude-ultrathink hook resolution with the grok-build host | `live` | metrics 2xx points under surface grok-build |
| `hermes-engine` | `hermes` | external note: claude-ultrathink engine resolution in its own repo | `live` | metrics 2xx points under surface hermes |
| `connector` | `grok-bot` | connector env file, bare client variable | `live` | metrics 2xx points under surface grok-bot |
| `gateway` | `grok-bot` | gateway env file, bare client variable | `live` | metrics 2xx points under surface grok-bot |
| `collector-grok` | `grok-build` | collector env file /etc/substrate/collector-grok.env, bare client variable | `live` | metrics 2xx points under surface grok-build |
| `operator` | `claude-code` | operator token file in the operator config dir | `live` | parity check passes with the operator token |
| `chaos-smoke` | `grok-bot` | external note: manual script run by the operator with the caller env bearer | `live` | manual run only |
| `parity-check` | `claude-code` | external note: manual script whose bearer comes from the client resolver for surface claude-code | `live` | manual run only |
| `writer-muse` | `muse` | per-collector muse env file, bare client variable | `after-phase-19` | writer tick lands under surface muse |
| `hook-muse` | `muse` | per-collector muse env file, bare client variable | `after-phase-19` | hook emits land under surface muse |
| `herdr-claude-code` | `claude-code` | tokens-dir file for the surface | `after-phase-19` | metrics 2xx points under surface claude-code and no single-surface token in the herdr env |
| `herdr-codex` | `codex` | tokens-dir file for the surface | `after-phase-19` | metrics 2xx points under surface codex and no single-surface token in the herdr env |
| `herdr-opencode` | `opencode` | tokens-dir file for the surface | `after-phase-19` | metrics 2xx points under surface opencode and no single-surface token in the herdr env |
| `herdr-pi` | `pi` | tokens-dir file for the surface | `after-phase-19` | metrics 2xx points under surface pi and no single-surface token in the herdr env |
| `herdr-omp` | `omp` | tokens-dir file for the surface | `after-phase-19` | metrics 2xx points under surface omp and no single-surface token in the herdr env |
| `herdr-hermes` | `hermes` | tokens-dir file for the surface | `after-phase-19` | metrics 2xx points under surface hermes and no single-surface token in the herdr env |
| `herdr-cursor` | `cursor` | tokens-dir file for the surface | `after-phase-19` | metrics 2xx points under surface cursor and no single-surface token in the herdr env |
| `herdr-grok-build` | `grok-build` | tokens-dir file for the surface | `after-phase-19` | metrics 2xx points under surface grok-build and no single-surface token in the herdr env |
| `herdr-muse` | `muse` | tokens-dir file for the surface | `after-phase-19` | metrics 2xx points under surface muse and no single-surface token in the herdr env |
| `dispatcher` | `substrate` | per-unit dispatcher env file, host-job token variable | `dormant:24` | expected 401s counted in unattributed 4xx points until the restoring phase |
| `substrate-host` | `substrate` | per-unit host env file, host-job token variable | `dormant:31` | expected 401s counted in unattributed 4xx points until the restoring phase |
| `skills-sync` | `substrate` | per-unit skills sync env file, host-job token variable | `dormant:22` | expected 401s counted in unattributed 4xx points until the restoring phase |
| `bridge` | `substrate` | per-unit bridge env file, host-job token variable | `dormant:22` | expected 401s counted in unattributed 4xx points until the restoring phase |
| `miner` | `substrate` | per-unit miner env file, host-job token variable | `dormant:22` | expected 401s counted in unattributed 4xx points until the restoring phase |
| `anchor` | `substrate` | per-unit anchor env file, host-job token variable | `dormant:28` | expected 401s counted in unattributed 4xx points until the restoring phase |
| `git-hook` | `cursor` | tokens-dir file for the surface | `not-installed` | install check reports present once installed |
| `swarm-a01-orch` | `swarm-a01-orch` | external note: v1.2 per-agent env files provisioned only when a workspace is installed | `not-installed` | not installed on this host |
| `swarm-a02-req` | `swarm-a02-req` | external note: v1.2 per-agent env files provisioned only when a workspace is installed | `not-installed` | not installed on this host |
| `swarm-a03-arch` | `swarm-a03-arch` | external note: v1.2 per-agent env files provisioned only when a workspace is installed | `not-installed` | not installed on this host |
| `swarm-a04-uxd` | `swarm-a04-uxd` | external note: v1.2 per-agent env files provisioned only when a workspace is installed | `not-installed` | not installed on this host |
| `swarm-a05-be` | `swarm-a05-be` | external note: v1.2 per-agent env files provisioned only when a workspace is installed | `not-installed` | not installed on this host |
| `swarm-a06-fe` | `swarm-a06-fe` | external note: v1.2 per-agent env files provisioned only when a workspace is installed | `not-installed` | not installed on this host |
| `swarm-a07-data` | `swarm-a07-data` | external note: v1.2 per-agent env files provisioned only when a workspace is installed | `not-installed` | not installed on this host |
| `swarm-a08-qa` | `swarm-a08-qa` | external note: v1.2 per-agent env files provisioned only when a workspace is installed | `not-installed` | not installed on this host |
| `swarm-a09-rev` | `swarm-a09-rev` | external note: v1.2 per-agent env files provisioned only when a workspace is installed | `not-installed` | not installed on this host |
| `swarm-a10-sec` | `swarm-a10-sec` | external note: v1.2 per-agent env files provisioned only when a workspace is installed | `not-installed` | not installed on this host |
| `swarm-a11-devops` | `swarm-a11-devops` | external note: v1.2 per-agent env files provisioned only when a workspace is installed | `not-installed` | not installed on this host |
| `swarm-a12-rel` | `swarm-a12-rel` | external note: v1.2 per-agent env files provisioned only when a workspace is installed | `not-installed` | not installed on this host |
| `swarm-a13-obs` | `swarm-a13-obs` | external note: v1.2 per-agent env files provisioned only when a workspace is installed | `not-installed` | not installed on this host |
| `swarm-a14-maint` | `swarm-a14-maint` | external note: v1.2 per-agent env files provisioned only when a workspace is installed | `not-installed` | not installed on this host |
| `swarm-a15-doc` | `swarm-a15-doc` | external note: v1.2 per-agent env files provisioned only when a workspace is installed | `not-installed` | not installed on this host |
| `omp-ultrathink` | `omp` | external note: not installed and out of scope for this phase | `not-installed` | not installed |
| `hermes-prompt-uplift` | `hermes` | external note: not installed and out of scope for this phase | `not-installed` | not installed |
| `hermes-eng-board` | `hermes` | external note: not wired and its own surface name is fixed in its own repo | `not-installed` | not wired |
| `skill-autonomy` | `grok-build` | external note: not wired and out of scope for this phase | `not-installed` | not wired |

<!-- identity-clients:end -->

## Token generation

Operator only. Each value is 32 random bytes, written straight into its
0600 file. No repo script writes system paths: provisioning is this command,
run by the operator, once per token file.

```sh
umask 077
openssl rand -hex 32 > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
```

`TOKEN_FILE` names the target file: one tokens-dir file per surface, or
the operator token file. For a per-collector or per-unit env file, the
operator appends one line naming that file's variable with a fresh value
instead; the file itself stays root-owned at 0600:

```sh
umask 077
: "${BARE_VAR:?set BARE_VAR to the variable that env file carries}"
: "${ENV_FILE:?set ENV_FILE to the target env file}"
printf '%s=%s\n' "$BARE_VAR" "$(openssl rand -hex 32)" >> "$ENV_FILE"
chmod 600 "$ENV_FILE"
```

`BARE_VAR` is the variable that env file carries (the bare client
variable for collector and external-client env files, the host-job token
variable for dormant per-unit env files), and `ENV_FILE` names the env
file. Server-side surface lists hold comma-separated values, so a second
client of the same surface is a second entry on the same variable, added
before the old one is ever removed.

## The ordered window

Operator-approved, in this order. Agents never edit the files named here,
never run the restarts, and never read a value; the names-only check is
the agent-safe step, the values check is operator only.

1. Phase 19's collector cutover has happened (its runbook,
   `lane-b-collectors.md`) and is verified here: `bun run collectors:status`
   shows zero refused AND both collector units active. This verification is
   the procedural cutover gate for this window. The manifest
   `after-phase-19` states stay unchanged per D20-11; they are enforced by
   this gate, not by the checker.
2. The client-side token files and env entries are written, per the table
   above and the generation section, plus the herdr cleanup: remove the bare
   SUBSTRATE_TOKEN line from /etc/substrate/substrate-collector-herdr.env
   provisioned by the lane-b cutover (leave SUBSTRATE_URL), since per-event
   resolution replaces it. The checker flags that line when present.
3. `bun run identity:check` passes names-only (agent) against the live
   server file as today, then the values check (operator) runs against a
   STAGED server file, not the live one:
   a. Write the proposed token lists into a staged copy of the server env
      file, leaving the live file unchanged.
   b. Run `bun run identity:check --values --server-env <staged-path>`
      until it passes.
   c. Keep the live server file untouched until the approved restart in
      step 5; the staged file is what step 5 promotes.
4. Client-readiness gate: the claude-ultrathink registration change is
   merged AND the installed plugin refreshed from it, the MCP entry writer
   check run, the git post-commit hook installed in the listed repos, and
   the Cursor hooks checked. Pre-refresh clients cannot send file-based
   bearers and would 401 from the restart until refreshed, so the
   values-mode PASS in step 3 plus this gate is what the soak depends on.
5. The staged server variables are promoted to the server env file and
   `substrate-mcp` restarts once, optionally with the repo unit installed
   per `production-parity.md`.
6. Post-switch evidence below, then a 30-minute soak covering one Muse
   writer tick and at least one real prompt per live client.
7. The production UAT run: read-only scenarios first, then the approved
   live scenarios.

The ordering above is deliberately client-first (D20-09): every live client
holds and can send its token before the server starts demanding one. It
supersedes the draft D20-20 numbering, which placed enforcement before
client readiness. Because the anonymous server ignores unknown bearers,
step 2 has no effect on production. The server restart is the only state
change.

## Bridge variant (optional)

If the anonymous-bridge change has merged before the window, the bridge
variant applies: set the server token variables plus the bridge flag that
change documents, restart, watch that change's anonymous-request counter
fall to zero across the soak, then remove the bridge flag and restart
once more. Without the bridge change, the client-first ordering above
plus `identity:check` give the same no-strand guarantee, and this section
does not apply. Nothing in this phase names the bridge flag in code.

## Expected dormant 401s

The dormant rows (`dispatcher`, `substrate-host`, `skills-sync`,
`bridge`, `miner`, `anchor`) hold the host-job token by name, but their
code cannot send a bearer yet or is broken until its restoring phase, so
their attempts at switch-on answer 401. That is expected and harmless:
dispatch is disabled, the host is inactive, and sync, bridge and miner
already fail. The runbook records the count instead of hiding it: sum the
unattributed 4xx point values once right after the restart and again after
the 30-minute soak, and attribute any delta to the dormant roster above
or to a stranded client. A delta that names a live client is the failure
case, not dormancy.

The 401 read is `GET /metrics` with the operator token: sum the `value`
fields of the request-total counter points with surface unattributed and
status 4xx (each point is one series, so counting points misses requests;
only the summed values count requests), and confirm the response's start
time is the restart under test:

```sh
curl -s -H "Authorization: Bearer $(head -n 1 $OPERATOR_TOKEN_FILE)" "$SUBSTRATE_URL/metrics" | jq '[.metrics[] | select(.name == "substrate.request.total") | .points[] | select(.attributes.surface == "unattributed" and .attributes.status == "4xx") | .value] | add // 0'
```

`OPERATOR_TOKEN_FILE` is the operator token file and `SUBSTRATE_URL` the
production base URL, both already on the operator shell. The same
counter's 2xx point values summed per surface show each live client's
token resolving, brief callers included:

```sh
curl -s -H "Authorization: Bearer $(head -n 1 $OPERATOR_TOKEN_FILE)" "$SUBSTRATE_URL/metrics" | jq '[.metrics[] | select(.name == "substrate.request.total") | .points[] | select(.attributes.status == "2xx") | {surface: .attributes.surface, value: .value}] | group_by(.surface) | map({surface: .[0].surface, requests: (map(.value) | add)})'
```

Record both summed readings beside the window row in the
evidence table.

## Identity evidence

Dated readings, newest last. The `--json` fields fill one row per run;
the summed metrics readings fill the 401 columns. Both 4xx columns hold
summed request counts (sum of point `value` fields), not point counts.

| Date (UTC) | identity:check | stranded live clients | unattributed 4xx at restart | unattributed 4xx after soak |
| --- | --- | --- | --- | --- |
| | | | | |

## Rollback

Operator only. Commenting the server token lines and restarting returns
to today's anonymous mode; the handoff key and audit path may stay. Back
up the env file first:

```sh
cp "$SERVER_ENV" "$SERVER_ENV.bak-<date>"
sed -i 's/^[[:space:]]*SUBSTRATE_\(TOKEN_\|OPERATOR_TOKENS\)/## &/' "$SERVER_ENV"
systemctl restart substrate-mcp
bun run parity:check
```

`SERVER_ENV` is the server env file. The commented lines name variables
only, never values. Re-applying is the reverse: uncomment, restart,
re-run both checks.

## Rotation

Token values rotate in list form: the operator appends the new value to
the variable's comma-separated list, restarts, confirms the values check
and the metrics evidence, then removes the old value and restarts once
more. The old value stays valid until it is removed, so rotation never
strands a client that has not picked up the new file yet.

The handoff key rotates the same way through its previous variable: the
old key moves to the previous variable, the fresh key takes the primary
one, and the previous line is dropped after the soak. The audit path is
not a secret and rotates by mere replacement.

## External clients

External clients keep their own convention and change nothing at
switch-on: the connector carries the bare client variable in its own env
file, the gateway reuses its existing value as one entry of the grok-bot
server list (its comment naming a non-surface variable is history, not
configuration), and the Grok Build hooks plus the Hermes engine resolve
through the claude-ultrathink resolution in its own repo. Swarm tokens
are provisioned only when a workspace is installed: every swarm row above
is `not-installed` on this host, and stays that way until an install
names its per-agent env files.

## herdr

herdr posts each event with that event's surface token from the tokens
dir, so the operator provisions tokens-dir files for every non-swarm
surface herdr maps, and herdr's own env must not define a
single-surface token. See `docs/collectors.md`.

## Links

- `production-parity.md`: the port-ownership proof and the repo-unit
  install the window optionally includes.
- `lane-b-collectors.md`: the Phase 19 collector cutover that precedes
  this window.

## Who does what

Agents may: run the names-only check at any time, including against the
production manifest and server env names; read the manifest and this
runbook; write repo files in the worktree; run `parity:check`, including
the production `/healthz` GET, within an operator-approved proof step.

Agents never: run the values check or handle a token value in any form;
generate, write, edit or move a token file, env file or unit file under
the system config dirs, the connector or gateway config dirs, or the
operator config dir; run state-changing `systemctl` verbs; comment or
uncomment a server variable; query production stores without approval.

The operator, in an approved window: generates every value with the
command above; writes the client files and env entries; runs the values
check; adds the server variables and restarts once; reads the metrics
evidence; rotates and rolls back as above.
