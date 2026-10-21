# Memory MCP retirement runbook (Phase 40, D-D3)

Retires Claude Code's global `hindsight` stdio MCP and the Hermes supermemory
integration once the `sub-*` banks answer. Restore routes are recorded first.

Status:

- Restore routes: recorded (section 1). Checked on this host, 2026-10-21.
- Restore drill: OPERATOR-RUN (section 2). Not run by this phase.
- Retirement: NOT EXECUTED in this phase (section 3). No MCP config is changed here.

This file holds names and paths only. No secret value, token, or hostname is
recorded. Env var values come from the operator's secret store.

## 1. Restore routes (recorded first)

### 1a. Claude Code global `hindsight` stdio MCP

Found: yes.

- Live config file: `/root/.claude.json`.
- Key path: `.mcpServers.hindsight`. No project-scoped `hindsight` entry exists
  under `.projects.*.mcpServers`.
- Backup copies with the same key path, type `stdio`:
  `/root/.claude/backups/.claude.json.backup.1792583421451` and
  `/root/.claude/backups/.claude.json.backup.1792582352811`.
- Transport: `type` = `stdio`.
- Command: `node`. Args: one element, the server file
  `/root/.hindsight/coding-agents/dist/mcp-server.js`.
- Env names set in the entry: `HINDSIGHT_MCP_HARNESS` (value not recorded).
- Env names the server file reads (from its `process.env` references): `HINDSIGHT_CHANNEL_ID`,
  `HINDSIGHT_CONFIG`, `HINDSIGHT_DIAG_FILE`, `HINDSIGHT_DISABLE_HOOKS`,
  `HINDSIGHT_LOG_FILE`, `HINDSIGHT_LOG_LEVEL`, `HINDSIGHT_USER_ID`. The entry sets
  only `HINDSIGHT_MCP_HARNESS`. Which of the others are required is not verified.
- Related hook commands that reference hindsight (not the MCP; key paths only), in
  `/root/.claude/settings.json`: `hooks.SessionStart.4.hooks.0.command`,
  `hooks.UserPromptSubmit.1.hooks.0.command`, `hooks.Stop.2.hooks.0.command`.
  The MCP restore does not touch them. Retirement must decide them separately.

Restore route: copy the object at `.mcpServers.hindsight` from a backup copy
above into `/root/.claude.json`, then set the env names listed above. The
operator writes the values from the secret store. Do this on a scratch copy of
the config first (section 2).

### 1b. Hermes supermemory integration

Found on this host: not found as a configured MCP or memory provider.

Checked, names and key paths only:

- `/root/.hermes/config.yaml`: no `supermemory` key. The `mcp_servers` keys are
  `notion`, `linear`, `greptile`, `railway`, `rea`. The `memory` block has no
  provider key.
- `/root/.hermes/config.yaml.bak-ultrathink-mcp-20261019-104340`: no `supermemory`
  match.
- `/root/.hermes/.env`: no `SUPERMEMORY_*` env var names.
- No supermemory-named file outside the plugin catalog and upstream docs.
- Catalog only (not host config): `/root/.hermes/hermes-agent/plugin-catalog/supermemory.yaml`
  names the env var `SUPERMEMORY_API_KEY`.

Restore route: none. Nothing is configured on this host, so there is no host
config to restore. If the operator knows of a supermemory configuration elsewhere,
the operator must record its file and key path before section 3 applies. This
phase does not invent one.

## 2. Restore drill (OPERATOR-RUN)

Run in a non-production profile. The live `/root/.claude.json` is not touched.

1. Claude Code `hindsight`:
   a. Make a scratch copy of the config and load it in a non-production profile.
   b. Copy `.mcpServers.hindsight` from a backup copy (section 1a) into the scratch config.
   c. Set the env names `HINDSIGHT_MCP_HARNESS` and any other required names
      from the secret store. Do not paste values into logs or this file.
   d. Start a non-production session. Confirm `hindsight` shows as connected, then
      confirm it answers one read-only call. Record pass or fail, with the name of
      the call used and the time.
2. Hermes supermemory: confirm section 1b still holds (nothing configured). If the
   operator has a prior configuration location, restore it there and confirm it
   answers. Otherwise record "drill not applicable: nothing configured on host".

The drill passes only if every restore that applies answers. A failed drill
blocks section 3.

## 3. Retirement steps (NOT EXECUTED in this phase)

Preconditions, all required: the drill in section 2 passed, the condition in
section 4 holds, and the operator approved the removal. This phase executes none
of these steps.

1. Remove `.mcpServers.hindsight` from `/root/.claude.json`. NOT EXECUTED.
2. Decide the three hook command entries in `/root/.claude/settings.json` (key
   paths in section 1a). NOT EXECUTED.
3. Hermes supermemory: remove only if a configuration is confirmed to exist. None
   was found on this host, so no step applies. NOT EXECUTED.
4. Keep the backup copies in section 1a in place. NOT EXECUTED.

## 4. Condition: the `sub-*` banks answer (operator check)

Banks are the documented `sub-*` set: `sub-claude-code`, `sub-hermes`, `sub-omp`,
`sub-muse`, `sub-grok-build`, `sub-cursor` (`docs/data-planes.md`). The bank
prefix and list are set by the documented env names `HINDSIGHT_BANK_PREFIX` and
`HINDSIGHT_BANKS` (`docs/config-reference.md`).

For each bank, the operator runs `memory_search` scoped to that bank through the
surface's substrate tool. The condition holds only if every call returns without
error. Record the bank name and status (ok or error) only. Do not record results
or values.

## 5. Rollback

- Claude Code `hindsight`: re-add `.mcpServers.hindsight` from a backup copy
  (section 1a), set the env names from the secret store, then start a new session
  and confirm it connects.
- Hermes supermemory: nothing is removed on this host, so rollback does not apply.
  If a configuration is later removed, restore it from the operator's recorded
  route (section 1b).
