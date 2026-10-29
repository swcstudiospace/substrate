# Runbook — production identity for substrate-mcp

| | |
| --- | --- |
| Requirement | FOUND-04 |
| Manifest | `infra/identity/clients.json` (tracked, names only, no values) |
| Check | `scripts/identity-check.ts`, run as `bun run identity:check` |
| Window | Operator-approved client-first switch-on; incident rotation needs a separately approved two-restart window |
| Scope | Every client of production `substrate-mcp` and the token it holds at switch-on |
| Untouched | `EVENT_KINDS`, `SURFACES`, `redact.ts`, the dispatcher and host code (their bearer support lands in their own phases) |

## What this runbook proves, and how

Switch-on is client first, server last: every live client holds its token
before the server starts demanding one, so no listed client is left without
a token, and one restart rolls everything back. This runbook is the human
half of that guarantee; `identity:check` is the machine half. The commands
below are an operator packet, not a record that they were executed.
Secret-handling steps run only in a private local operator shell, never an
agent tool, chat, recorded terminal or CI job. Disable shell tracing and
debug logging; never paste values, env files, headers or raw client config.

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
External deliveries remain `external` in names mode and `unchecked` in
values mode: neither is proof that those clients can authenticate. A PASS
must be paired with readiness and real per-client evidence. Names-only
checks inspect token-file metadata and env assignment names, not bearer
equality; they may fail until the proposed server names exist in staging.

## Local paths and inputs

The manifest fixes the server file at `/etc/substrate/substrate.env`.
The default tokens dir is `/etc/substrate/tokens`, with first-line files
named for each surface (`cursor`, `claude-code`, `grok-build`, `hermes`,
`muse`, `codex`, `opencode`, `pi`, `omp` and any installed surface).
The operator file is `$HOME/.config/substrate/operator.token`; its bearer
must appear in both `SUBSTRATE_TOKEN_CLAUDE_CODE` and
`SUBSTRATE_OPERATOR_TOKENS`. No swarm bearer belongs in the operator list.

External env files and their exact variables are in the manifest:
`/etc/grok-hermes/connector.env`, `/etc/desk-gateway/gateway.env`,
`/etc/substrate/collector-grok.env` and
`/etc/substrate/substrate-collector-muse.env` hold `SUBSTRATE_TOKEN`.
Dormant per-unit files hold `SUBSTRATE_TOKEN_SUBSTRATE`.
`/etc/substrate/substrate-collector-herdr.env` must not hold a shared
`SUBSTRATE_TOKEN`; preserve its `SUBSTRATE_URL` when removing that line.

Server lists use `SUBSTRATE_TOKEN_<SURFACE>` with uppercase letters and
hyphens replaced by underscores: `SUBSTRATE_TOKEN_CURSOR`,
`SUBSTRATE_TOKEN_CLAUDE_CODE`, `SUBSTRATE_TOKEN_GROK_BUILD`,
`SUBSTRATE_TOKEN_GROK_BOT`, `SUBSTRATE_TOKEN_HERMES`,
`SUBSTRATE_TOKEN_MUSE`, `SUBSTRATE_TOKEN_SUBSTRATE`, and the corresponding
names for the installed roster. Distinct bearers may share one surface
list, but one bearer must not be assigned to two surfaces.
Required global names are `SUBSTRATE_OPERATOR_TOKENS`,
`SUBSTRATE_HANDOFF_KEY` and `SUBSTRATE_AUDIT_PATH`. Set a non-secret
`SUBSTRATE_HANDOFF_KEY_ID` for the new key; preserve the prior key/ID pair
when rotating. Keep the existing durable audit path rather than inventing
a new production path. No Swarm signing variables are required here.

In a private Bash shell, set paths and non-secret references only:

```sh
set +x
set -euo pipefail
umask 077
export SUBSTRATE_REPO=/root/src/worktrees/agent-substrate-v13-autonomous
export RECOVERED_CLIENT=/root/src/worktrees/claude-ultrathink-p20
export SERVER_ENV=/etc/substrate/substrate.env
export TOKENS_DIR=/etc/substrate/tokens
export SUBSTRATE_TOKENS_DIR="$TOKENS_DIR"
export OPERATOR_TOKEN_FILE="$HOME/.config/substrate/operator.token"
test -d "$HOME/.config/substrate" || install -d -m 0700 "$HOME/.config/substrate"
export WINDOW_DIR="$(mktemp -d "$HOME/.config/substrate/identity-window.XXXXXXXX")"
chmod 700 "$WINDOW_DIR"
export STAGED_SERVER_ENV="$WINDOW_DIR/substrate.env.staged"
```

The CLI's source-derived local production default is
`http://127.0.0.1:7410`; for this host's established local service, set
`export SUBSTRATE_URL=http://127.0.0.1:7410` only after confirming that is
the approved target. Do not alter a differently configured client target.
If a local env file already holds `SUBSTRATE_URL`, reuse the private
extraction command below with `CLIENT_VAR=SUBSTRATE_URL` and a new
`TOKEN_FILE="$WINDOW_DIR/substrate-url"`; then load it without displaying:
`IFS= read -r SUBSTRATE_URL < "$TOKEN_FILE"; export SUBSTRATE_URL`.
Alternatively retrieve the existing client's `substrate.url` in the
private local editor. No URL or credential needs to be pasted into chat.
For client commands, `SUBSTRATE_TOKEN` overrides
`SUBSTRATE_TOKEN_FILE`, which overrides
`SUBSTRATE_TOKENS_DIR/<surface>`. Inspect and refresh the effective source
locally; a stale direct env bearer will override a newly rotated file.
Do not source the whole systemd server env into a client shell: its format
is not a shell contract, and clients do not need store keys.

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

Operator only, private shell. Each new bearer or handoff key is 32 random
bytes. Generate into a new private file, never over an existing credential:

```sh
export TOKEN_FILE="$WINDOW_DIR/cursor.new"
(set -C; openssl rand -hex 32 > "$TOKEN_FILE") || { echo "new credential generation failed; stop" >&2; exit 1; }
chmod 600 "$TOKEN_FILE"
```

Change only the filename for each other new credential. Stop on failure;
do not disable the no-clobber guard. To provision an absent first-line
surface file, after staging its server list and approving delivery:

```sh
export CLIENT_TOKEN_FILE="$SUBSTRATE_TOKENS_DIR/cursor"
test ! -e "$CLIENT_TOKEN_FILE" || { echo "client credential exists; use reuse or rotation" >&2; exit 1; }
install -o root -g root -m 0600 "$TOKEN_FILE" "$CLIENT_TOKEN_FILE"
```

If the target exists, reuse its locally held value or follow Rotation;
do not overwrite it with a freshly generated value. The operator file
likewise needs a distinct value and both server-list memberships.
Root-owned surface files must be readable by the actual client service
account under the approved ownership model; mode 0600 alone does not
establish client access.

To reuse a value from an existing external env file, extract it directly
into a new private file with the checker's existing parser. Set
`CLIENT_ENV_FILE` to one manifest path and `CLIENT_VAR` to its exact
variable; `TOKEN_FILE` must name a new file under `WINDOW_DIR`:

```sh
export CLIENT_ENV_FILE=/etc/desk-gateway/gateway.env
export CLIENT_VAR=SUBSTRATE_TOKEN
export TOKEN_FILE="$WINDOW_DIR/gateway.existing"
bun -e '
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnvValues } from "/root/src/worktrees/agent-substrate-v13-autonomous/scripts/identity-check.ts";
try {
  const e = process.env;
  const value = parseEnvValues(readFileSync(e.CLIENT_ENV_FILE, "utf8")).get(e.CLIENT_VAR);
  if (!value || /[\r\n]/.test(value)) throw new Error();
  writeFileSync(e.TOKEN_FILE, value + "\n", { mode: 0o600, flag: "wx" });
} catch { console.error("private credential extraction failed"); process.exit(1); }
'
```

For an existing first-line credential, use `TOKEN_FILE` pointing at that
file; no extraction or display is needed. These inputs are file paths,
not requests for secret values.

Make a new staged env copy; this does not modify the live file:

```sh
test ! -e "$STAGED_SERVER_ENV" || { echo "staged file exists; preserve it and stop" >&2; exit 1; }
install -m 0600 "$SERVER_ENV" "$STAGED_SERVER_ENV"
```

The following private command edits only a staged copy under `WINDOW_DIR`.
It reuses `parseEnvNames`/`parseEnvValues` rather than sourcing systemd env
syntax. Set `ASSIGNMENT_VAR` to the actual server list name and
`ASSIGNMENT_MODE=add` to append the value held by `TOKEN_FILE`. Re-run for
each client on its surface list; add the operator value to both its
surface list and `SUBSTRATE_OPERATOR_TOKENS`. Never assign the same value
to different surfaces. For a new bare client env entry or handoff key,
use `ASSIGNMENT_MODE=set` on that env file's staged copy; this refuses to
replace a nonempty existing assignment. No credential goes in argv or stdout:

```sh
export STAGED_ENV_FILE="$STAGED_SERVER_ENV"
export ASSIGNMENT_VAR=SUBSTRATE_TOKEN_CURSOR
export ASSIGNMENT_MODE=add
bun -e '
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { parseEnvNames, parseEnvValues } from "/root/src/worktrees/agent-substrate-v13-autonomous/scripts/identity-check.ts";
try {
  const e = process.env, path = resolve(e.STAGED_ENV_FILE);
  if (!path.startsWith(resolve(e.WINDOW_DIR) + sep)) throw new Error();
  const name = e.ASSIGNMENT_VAR, mode = e.ASSIGNMENT_MODE;
  if (!/^(SUBSTRATE_TOKEN(?:_[A-Z0-9_]+)?|SUBSTRATE_OPERATOR_TOKENS|SUBSTRATE_HANDOFF_KEY)$/.test(name)) throw new Error();
  const text = readFileSync(path, "utf8"), names = parseEnvNames(text);
  if ((names.get(name)?.count ?? 0) > 1 || /\\\s*$/m.test(text)) throw new Error();
  const value = readFileSync(e.TOKEN_FILE, "utf8").trim();
  if (!value || /[\s,]/.test(value)) throw new Error();
  const old = parseEnvValues(text).get(name) ?? "";
  let next;
  if (mode === "set") { if (old) throw new Error(); next = value; }
  else {
    if (!/^(SUBSTRATE_TOKEN_[A-Z0-9_]+|SUBSTRATE_OPERATOR_TOKENS)$/.test(name)) throw new Error();
    const list = old.split(/[\s,]+/).filter(Boolean);
    if (mode === "add") next = [...new Set([...list, value])].join(",");
    else if (mode === "remove") {
      if (!list.includes(value)) throw new Error();
      next = list.filter(item => item !== value).join(",");
      if (!next) throw new Error();
    } else throw new Error();
  }
  const lines = text.split(/\r?\n/).filter(line =>
    !new RegExp("^\\s*" + name + "\\s*=").test(line));
  while (lines.at(-1) === "") lines.pop();
  lines.push(name + "=" + next, "");
  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
} catch { console.error("private staged assignment refused"); process.exit(1); }
'
chmod 600 "$STAGED_ENV_FILE"
```

For a client env file, first copy it to a distinct staged path under
`WINDOW_DIR`, preserve every other setting, and set `STAGED_ENV_FILE` to
that copy. Existing client credentials stay unchanged on initial rollout;
use the extracted value for the server list instead. Delivery/promotion is
an explicit operator action, not part of the staging command. Server lists
stay comma-separated on one line: duplicate or wrapped assignments must be
resolved privately before the checker can pass.

In a private editor without swap/history (`vim -n -i NONE
"$STAGED_SERVER_ENV"`), preserve the existing audit path and all unrelated
settings, set the non-secret handoff key ID, and set
`SUBSTRATE_ALLOW_ANONYMOUS=0` for enforcement. Generate a handoff key only
when absent; rotation preserves the prior key and ID as described below.
Do not print the file or attach it as evidence.

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
3. Record a names-only baseline against the live file; do not call an
   expected missing-name result a pass. Prepare the STAGED server file,
   leaving the live file unchanged, then run both explicit checks:

   ```sh
   bun "$SUBSTRATE_REPO/scripts/identity-check.ts" --manifest "$SUBSTRATE_REPO/infra/identity/clients.json" --server-env "$STAGED_SERVER_ENV" --tokens-dir "$SUBSTRATE_TOKENS_DIR" --json
   # Operator only: reads credential values internally, emits verdicts only.
   bun "$SUBSTRATE_REPO/scripts/identity-check.ts" --manifest "$SUBSTRATE_REPO/infra/identity/clients.json" --server-env "$STAGED_SERVER_ENV" --tokens-dir "$SUBSTRATE_TOKENS_DIR" --values --json
   ```

   Both must return exit 0 with no stranded live client. `unchecked`
   external clients still need the separate client-readiness evidence.
   Keep the live server file untouched until the approved promotion.
4. Client-readiness gate: the claude-ultrathink registration change is
   merged AND the installed plugin refreshed from it, the MCP entry writer
   check run, the git post-commit hook installed in the listed repos, and
   the Cursor hooks checked. Pre-refresh clients cannot send file-based
   bearers and would 401 from the restart until refreshed, so the
   values-mode PASS in step 3 plus this gate is what the soak depends on.
5. The staged server variables are promoted to the server env file and
   `substrate-mcp` restarts once, optionally with the repo unit installed
   per `production-parity.md`.

   ```sh
   # Only after client readiness, both checks and window approval.
   test ! -e "$SERVER_ENV.bak-pre-switch" || { echo "backup exists; stop before promotion" >&2; exit 1; }
   install -o root -g root -m 0600 "$SERVER_ENV" "$SERVER_ENV.bak-pre-switch"
   install -o root -g root -m 0600 "$STAGED_SERVER_ENV" "$SERVER_ENV"
   systemctl restart substrate-mcp
   env -u SUBSTRATE_TOKEN SUBSTRATE_TOKEN_FILE="$OPERATOR_TOKEN_FILE" bun "$SUBSTRATE_REPO/scripts/parity-check.ts" --json
   ```

   Stop if the backup guard fails: preserve the existing backup, choose a
   new approved backup path and use that same path for rollback. Do not
   promote after a failed backup or checker. Optional unit installation is
   a separate operator action under `production-parity.md`, not implicit
   in this packet.
6. Post-switch evidence below, then a 30-minute soak covering one Muse
   writer tick and at least one real prompt per live client.
7. Production UAT only in its approved window, using the explicit scenario
   commands below. Scenarios 1, 3, 6 and 8 are write-gated by the actual
   script; scenario 1 is not a read-only production probe. A real scenario-5
   kickoff also writes tracker and graph rows before its readback.

The ordering above is deliberately client-first (D20-09): every live client
holds and can send its token before the server starts demanding one. It
supersedes the draft D20-20 numbering, which placed enforcement before
client readiness. Client provisioning, hook installation and plugin refresh
are also state changes, even if an anonymous server ignores the bearer.
If production already enforces tokens, do not use initial switch-on to
replace a held credential: use the list-form Rotation sequence.

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

Create a private curl header file, with stdout unused. Do not run the
`substrate headers` helper in chat, even as a test: it prints a bearer.
The helper is for private consumption by the client only. This metrics
command reads the operator file directly instead:

```sh
export METRICS_HEADERS="$WINDOW_DIR/metrics.headers"
bun -e '
import { readFileSync, writeFileSync } from "node:fs";
try {
  const value = readFileSync(process.env.OPERATOR_TOKEN_FILE, "utf8").split("\n", 1)[0].trim();
  if (!value || /[\r\n]/.test(value)) throw new Error();
  writeFileSync(process.env.METRICS_HEADERS, "Authorization: Bearer " + value + "\n", { mode: 0o600, flag: "wx" });
} catch { console.error("private metrics header preparation failed"); process.exit(1); }
'
curl --fail --silent --show-error --header @"$METRICS_HEADERS" "$SUBSTRATE_URL/metrics" | jq '[.metrics[] | select(.name == "substrate.request.total") | .points[] | select(.attributes.surface == "unattributed" and .attributes.status == "4xx") | .value] | add // 0'
```

`OPERATOR_TOKEN_FILE` and `SUBSTRATE_URL` are resolved privately as above.
Require successful HTTP and jq exits (enable shell `pipefail`); no empty or
error response counts as zero requests. Keep the header file private,
never dump it, and re-create it at a new path if the operator token rotates.
The same counter's 2xx values summed per surface show authentication,
brief callers included. Correlate with one real action for each client:
a surface aggregate alone cannot distinguish two clients on that surface.

```sh
curl --fail --silent --show-error --header @"$METRICS_HEADERS" "$SUBSTRATE_URL/metrics" | jq '[.metrics[] | select(.name == "substrate.request.total") | .points[] | select(.attributes.status == "2xx") | {surface: .attributes.surface, value: .value}] | group_by(.surface) | map({surface: .[0].surface, requests: (map(.value) | add)})'
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

Operator only. Rollback restores the pre-switch backup, taken before
switch-on, so the anonymous-access setting comes back with the tokens —
but keeps the window's handoff key and IDs for verification:

```sh
bun -e '
import { readFileSync, writeFileSync } from "node:fs";
try {
  const path = process.env.SERVER_ENV;
  const live = readFileSync(path, "utf8");
  const handoff = live.split(/\r?\n/).filter(line => /^\s*SUBSTRATE_HANDOFF_KEY(?:_ID|_PREV|_PREV_ID)?=/.test(line));
  const backup = readFileSync(path + ".bak-pre-switch", "utf8");
  const kept = backup.split(/\r?\n/).filter(line => !/^\s*SUBSTRATE_HANDOFF_KEY(?:_ID|_PREV|_PREV_ID)?=/.test(line));
  writeFileSync(path, kept.join("\n") + "\n" + handoff.join("\n") + "\n", { mode: 0o600 });
} catch { console.error("private rollback preparation failed"); process.exit(1); }
'
chmod 600 "$SERVER_ENV"
systemctl restart substrate-mcp
env -u SUBSTRATE_TOKEN SUBSTRATE_TOKEN_FILE="$OPERATOR_TOKEN_FILE" bun "$SUBSTRATE_REPO/scripts/parity-check.ts" --json
```

The pre-switch backup predates the provisioned key: a whole-file restore
alone leaves handoffs created during the window at `no-keys-configured`.
Take that backup before switch-on:

```sh
test ! -e "$SERVER_ENV.bak-pre-switch" || { echo "backup exists; stop before promotion" >&2; exit 1; }
install -o root -g root -m 0600 "$SERVER_ENV" "$SERVER_ENV.bak-pre-switch"
```

Commenting only the token lines is not a rollback: with
`SUBSTRATE_ALLOW_ANONYMOUS=0` still set, the server requires a
recognized bearer while none exists, and every route — including
`healthz` and the parity check — answers 401. `SERVER_ENV` is the
server env file. The commands above name variables only, never values.

## Rotation

Token values rotate using the existing list-form contract, not by replacing
the sole server value or overwriting a client's held credential first.
Approval must explicitly cover **two server restarts**, client delivery,
any client process refresh/restart, and the 30-minute soak:

1. Keep the current client source and server list unchanged. For Cursor,
   privately back up `/etc/substrate/tokens/cursor` (or its actual effective
   env/file source) into `WINDOW_DIR` at mode 0600. If the effective source
   is an env assignment, use the private extraction command to retain its
   old **bare value** in `cursor.old`, not a `KEY=value` line. For the
   default first-line file, a private mode-0600 copy is already suitable.
   Generate `cursor.new` using the no-clobber generation command. Make a
   fresh staged server copy named `rotation-add.env` under `WINDOW_DIR`.
2. Set `STAGED_ENV_FILE` to that copy, `TOKEN_FILE` to `cursor.new`,
   `ASSIGNMENT_VAR=SUBSTRATE_TOKEN_CURSOR`, `ASSIGNMENT_MODE=add`, then run
   the staged-assignment command. It keeps all existing entries. Run both
   identity checks with `--server-env` pointing at `rotation-add.env`;
   live clients still hold the old token, which must remain a match.
3. Only after approval and successful checks, promote and restart once:

   ```sh
   export STAGED_SERVER_ENV="$WINDOW_DIR/rotation-add.env"
   install -o root -g root -m 0600 "$STAGED_SERVER_ENV" "$SERVER_ENV"
   systemctl restart substrate-mcp
   ```

   Check parity and real client authentication; record start epoch and
   summed metrics, then soak for 30 minutes covering a Muse writer tick
   and a real prompt per live client. Stop on a stranded live client;
   do not remove the old entry to force progress.
4. Privately refresh the effective credential of **every** consumer of the
   old Cursor bearer: Cursor hooks, herdr's cursor events, the git hook and
   any local env/token-file overrides. For the default surface-file source,
   this is a separately authorized delivery, after the first restart:

   ```sh
   install -o root -g root -m 0600 "$WINDOW_DIR/cursor.new" "$SUBSTRATE_TOKENS_DIR/cursor"
   ```

   Do not use that command if an env or token-file override is the actual
   source. Edit that client's private staged env/file instead and promote
   it explicitly, preserving other settings. Restart/relaunch clients
   that cached an env value under the approved window; file-based readers
   must prove they now resolve the new file. Re-run the operator values
   check against the current server and obtain fresh real-client evidence.
   External `unchecked` rows are not delivery proof.
5. Copy the now-live server env to a new `rotation-remove.env` under
   `WINDOW_DIR` at mode 0600. Set `STAGED_ENV_FILE` to it, `TOKEN_FILE` to
   the private **old** token file, `ASSIGNMENT_VAR=SUBSTRATE_TOKEN_CURSOR`,
   `ASSIGNMENT_MODE=remove`, and run the same staged-assignment command.
   Require both checks and proof all consumers use the new token before
   promotion. It removes just the old member, not the entire surface list:

   ```sh
   export STAGED_SERVER_ENV="$WINDOW_DIR/rotation-remove.env"
   install -o root -g root -m 0600 "$STAGED_SERVER_ENV" "$SERVER_ENV"
   systemctl restart substrate-mcp
   env -u SUBSTRATE_TOKEN SUBSTRATE_TOKEN_FILE="$OPERATOR_TOKEN_FILE" bun "$SUBSTRATE_REPO/scripts/parity-check.ts" --json
   ```

   Record revocation and successful new-token client evidence after the
   second restart. If removing an operator bearer, remove its old member
   from both its surface list and `SUBSTRATE_OPERATOR_TOKENS`; keep the
   replacement in both before refreshing the operator file.

**Incident recorded 2026-10-11:** an earlier unsafe, pre-existing CLI test
read the actual Cursor substrate credential and exposed its value in
failure output. The fixture is now isolated; that is containment of the
test, not production revocation. The operator must rotate/revoke the
exposed credential through this approved list-form window. Any earlier
decline of rotation predates this incident and does not authorize leaving
the newly exposed credential valid. Do not reproduce, print or paste the
value; assess and restrict the prior secret-bearing output privately.
Rotation/revocation is **not performed** by this documentation update.

When rotating the handoff key, move the old key to
`SUBSTRATE_HANDOFF_KEY_PREV` and its active ID to
`SUBSTRATE_HANDOFF_KEY_PREV_ID`. Put the fresh key in
`SUBSTRATE_HANDOFF_KEY` and give `SUBSTRATE_HANDOFF_KEY_ID` a new ID.
Drop the previous key only once no remaining handoff still verifies
under the old ID — `coord_handoff_list` verifies each packet against
the currently loaded keys, and handoffs carry no expiry, so a soak
alone does not make retirement safe. The audit path is not a secret and
rotates by mere replacement.

## Cross-repo delivery and installed-client readiness (20-06 Task 2)

Recovery evidence recorded **2026-10-11**, supplied by the parent:
`/root/src/worktrees/claude-ultrathink-p20` was restored at `9006476` on
`gsd/v1.3-p20-identity-uat`. Frozen install exited 0; the four targeted
files reported **159 pass / 0 fail**, and typecheck exited 0. Two actual
registrations against scratch MCP read back one node `n1` and step
`n1/1`, surface `claude-code`, without duplicate nodes or steps. A wrong
bearer returned HTTP 401 while the fail-open CLI still exited 0; disabled
integration reported skipped. This proves recovered source/scratch
behavior, **not** remote delivery, main landing, installed-plugin refresh
or production acceptance. No such action is recorded as done.

Only the operator may execute the delivery steps below after approval.
No force-push, main push, merge bypass, auto-merge or branch deletion:

```sh
git -C "$RECOVERED_CLIENT" --no-optional-locks show -s --format='%H %s' HEAD
git -C "$RECOVERED_CLIENT" --no-optional-locks branch --show-current
# After confirming the recovered revision/branch and reviewing all changes:
git -C "$RECOVERED_CLIENT" push --set-upstream origin gsd/v1.3-p20-identity-uat
gh -R swcstudiospace/claude-ultrathink pr create --draft --base main --head gsd/v1.3-p20-identity-uat --title "feat: Phase 20 substrate registration and identity client" --body "Recovered client at 9006476; installed refresh and production UAT pending. Request Programming Lead / Desk Quality review."
```

Use the existing PR rather than create another if this branch already has
one. Inspect the remote privately; do not print credentialed remote URLs.
Every PR requires the **Desk Quality Greptile gate via Programming Lead**.
FAILED, SKIPPED or unavailable review is a blocker; open findings are not
merge-ready. The human, not an agent, decides and performs a normal merge
after the required gates. There is deliberately no merge command here.

Only after the human records approved main landing, refresh the established
stable checkout and plugin. The local marketplace source recorded in the
Phase 20 context is `/root/src/repos/claude-ultrathink`; do not repoint it
to the recovered worktree or a transient plugin cache:

```sh
export STABLE_CLIENT=/root/src/repos/claude-ultrathink
git -C "$STABLE_CLIENT" --no-optional-locks branch --show-current
git -C "$STABLE_CLIENT" --no-optional-locks status --short
# Continue only on a clean main checkout; otherwise stop, preserving its work.
git -C "$STABLE_CLIENT" pull --ff-only origin main
claude plugin marketplace update ultrathink > "$WINDOW_DIR/marketplace-update.private" 2>&1
claude plugin update ultrathink@ultrathink > "$WINDOW_DIR/plugin-update.private" 2>&1
```

Restart Claude Code in the approved client window. Record the installed
version and commit, not just the checkout HEAD. A missing installed-plugin
record or the UAT checker's stable-checkout fallback is not refresh proof.
The existing upgrade guide in the recovered client documents refreshes
for other installed hosts; use only their actual installed source and
approved restart path. Do not run a blanket setup to alter unrelated hosts.

With `SUBSTRATE_URL` privately retrieved from local config and a locally
resolved `claude-code` bearer, write the opt-in entry from the stable clone:

```sh
bun "$STABLE_CLIENT/scripts/mcp-register.ts" --hosts claude --substrate --dry-run > "$WINDOW_DIR/substrate-entry-plan.private" 2>&1
# Review the private plan, then explicitly approve the user-config write.
bun "$STABLE_CLIENT/scripts/mcp-register.ts" --hosts claude --substrate > "$WINDOW_DIR/substrate-entry-apply.private" 2>&1
claude mcp get substrate > "$WINDOW_DIR/substrate-entry-status.private" 2>&1
```

Require `added`, `replaced` or a verified matching `unchanged` entry;
`claude: not on PATH, skipped` can exit 0 and is **not** success.
Do not use `--replace` automatically on a foreign entry. Locally verify
user scope, HTTP type, the configured target's `/mcp`, a static header
that names the token variable, and the helper path into the stable clone.
Share only those booleans/statuses. These private files may hold config
details or a URL; never paste them into chat. The helper's bearer output
is consumed privately by Claude Code, never invoked for agent-visible
diagnostics. Keep config backups private at mode 0600.

Install/check hooks using the existing sources after approved code delivery.
Use the actual operator-approved repo roster from `SUBSTRATE_MUSE_REPOS`
in `/etc/substrate/substrate-collector-muse.env` (colon-separated absolute
roots), per D20-19; it is not a hard-coded list supplied by an agent.
For each approved `HOOK_REPO` in that roster:

```sh
: "${HOOK_REPO:?set to one approved absolute repo root from the local roster}"
bun "$SUBSTRATE_REPO/packages/collectors/src/install-git-hook.ts" "$HOOK_REPO"
bun "$SUBSTRATE_REPO/packages/collectors/src/install-git-hook.ts" --check "$HOOK_REPO"
bun "$SUBSTRATE_REPO/packages/projector/src/cursor.ts" --check
```

Require **`present` for every repo**, not exit 0 alone: a missing hook
prints `not installed` and may exit 0. A foreign hook stays untouched and
is a blocker, never an instruction to clobber it. The Cursor projector
must report `already current` for `sessionStart`, `postToolUse`, and
`stop`; if not, the operator may apply the same projector without
`--check` after reviewing the proposed change and its backup. Its default
hook commands use the stable substrate checkout; verify that checkout
contains the approved client code before installation. Worktrees share
git hooks, so this is not an agent-owned scratch write.

The repo implements projector `--check` and installer `--check`, **not**
a repo `--check-hooks` flag. If an operator uses an external host's
`--check-hooks`, exit 0 still does not establish presence: require its
explicit present/current result and the repo checks above. Bare commits
default to `cursor`/`human`; agent wrappers must set their actual
`SUBSTRATE_SURFACE` and `SUBSTRATE_ACTOR`, not impersonate the operator.

## Production UAT packet (20-06 Task 3)

Task 1 switch-on/rotation and Task 2 installed-client readiness must be
proven first. All production contact in this packet requires the operator
window; readback approval is not approval to create tracker/graph/event
rows. Obtain a real kickoff graph and its session-state path from the
actual host prompt; confirm free Linear issue slots before the kickoff.
Do not generate a synthetic production state as acceptance evidence.

In the real project directory, using the stable client and its local
configuration, the approved kickoff/register step is:

```sh
: "${STATE_FILE:?set to the real kickoff sessions/id.json path}"
"$STABLE_CLIENT/bin/ultrathink-mcp" substrate register --state "$STATE_FILE"
```

Require the actual **`substrate: registered <graphId>`** line and a
subsequent `graph_get` readback of that exact graph. Failed and skipped
registrations exit 0; do not equate that exit with success. Check
`claude-code` attribution, real node/step IDs and tracker identifiers,
with no duplicate nodes or steps. A real kickoff can create permanent
Notion/Linear and substrate rows even though the later readback is read-only.

For the UAT script, privately set `SUBSTRATE_URL` from the existing local
server/client configuration and a readable token-file path. The operator
bearer is suitable for the privileged window; a stale direct env bearer
must not override that path. The flag values below are non-secret evidence
references, not credential requests:

```sh
: "${LIVE_REF:?set to the actual approval reference covering production writes}"
: "${KICKOFF_GRAPH:?set to the actual registered kickoff graph ID}"
export UAT_TAG="p20-$(date -u +%Y%m%dT%H%M%SZ)"
export SUBSTRATE_TOKEN_FILE="$OPERATOR_TOKEN_FILE"
unset SUBSTRATE_TOKEN
cd "$SUBSTRATE_REPO"
# Scenario 5 reads the already-created real graph; not a substitute for kickoff.
bun run uat:phase0 --tag "$UAT_TAG" --scenarios 2,5 --graph "$KICKOFF_GRAPH" --report "$WINDOW_DIR/readback.md"
# Explicit approved production set; scenario 1 includes probe writes.
bun run uat:phase0 --tag "$UAT_TAG" --scenarios 1,2,3,5,6 --live "$LIVE_REF" --graph "$KICKOFF_GRAPH" --report "$WINDOW_DIR/production-uat.md"
```

The script write-gates scenarios `1,3,6,8` with `--live`. Do not copy the
old plan wording that calls production scenario 1 read-only; scenario 3
also needs the live-reference flag under the actual script contract.
Scenario 6 additionally needs a **real Cursor session and real commit**
by the operator, plus matching event evidence; its config-check result
alone is not proof of those actions. Cursor `sessionStart` writes the
brief file rather than emitting a `session.start` event. Scenario 8 is
optional and permanent-write; no automatic extension of approval.
Operator-approved anchor SQL/schema counts and Notion export references
remain separate evidence, never new store credentials in this script.
Require report target `production`, actual installed version/commit,
each required scenario verdict and its evidence; failures remain failed.
Counts/IDs/booleans only enter the UAT records.

## Checkpoint status and static handoff (recorded 2026-10-11)

All three 20-06 human actions remain **operator-blocked, completed 0/3**:
identity/incident revocation and soak; reviewed cross-repo main landing,
installed plugin/MCP/hooks; and production UAT with durable evidence.
Scratch registration and the 159/0/typecheck recovery do not clear them.
No Phase 20 completion, milestone closure or merge-ready claim is made.

The parent may verify command spelling without reading any credentials:
read `scripts/identity-check.ts` (`main`, `checkValues`, parsers),
`infra/identity/clients.json`, `packages/mcp-server/src/config.ts`
(`tokenConfig`, `readHandoffKeys`, anonymous flag),
`packages/projector/src/cursor.ts`,
`packages/collectors/src/install-git-hook.ts`,
`scripts/uat-phase0.ts` (`WRITE_SCENARIOS`, `parseOptions`, scenarios 5/6),
and the recovered client's `src/substrate/brief.ts`, `src/mcp/cli.ts`,
`scripts/mcp-register.ts` and upgrade guide. These are static source reads;
this documentation task ran no script, test, build, formatter, network or
runtime check. After parent authorization, a names-only checker result is
safe to share; values checks, entry plans/status, headers and env contents
remain private operator work.

The unresolved operator facts are the approved two-restart window and
approval reference; current effective client overrides/accounts and the
active repo roster; clean stable-checkout/main/PR gate and installed-plugin
provenance; the real kickoff state/graph and available issue slots; and
production metrics/audit/handoff/UAT evidence. Path defaults, variable
names and flags above are derived from source, not unknown secret inputs.

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
