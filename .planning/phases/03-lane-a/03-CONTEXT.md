# Phase 3: Lane A - Context

**Gathered:** 2026-09-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Sandboxed, durable Claude Code sessions, one VM per Graph ID, dispatched from Linear.

ROADMAP success criteria:
1. Free disk verified before pulling images.
2. rivet-agentos host runs; `openTask` writes shared skills, `SUBSTRATE_BRIEF.md` and the substrate/notion/linear MCP config into `/home/agentos`.
3. The dispatcher routes `dispatch:claude-code` to a VM; `permissionPolicy: "ask"` surfaces approvals to Telegram.
4. `claude-ultrathink` runs inside the VM, so kickoff and sync still write Notion and Linear.

Proof: a labelled issue opens a VM, the session survives a host restart, the PR lands and `ultrathink-sync` closes the loop.

Also in scope (carried from the Phase 2 review): WR-05, a read-only issue-text tool plus a "release and stop" prompt step, for both dispatched surfaces.

Not in this phase: Codex/OpenCode/Pi adapters (Lane A roster beyond Claude Code); skills library projection into VMs beyond copying the current skills (Phase 4); running Hermes unprivileged (IN-01, documented only); a Linear plan upgrade.

</domain>

<decisions>
## Implementation Decisions

### Sandbox runtime and disk
- **D-01:** The session runs in a rivet-agentos VM (`@rivet-dev/agentos`, V8/WASM, no KVM) with rivet's Docker sandbox provider mounted at `/mnt/sandbox` for native tools (bun, git, gh, claude-ultrathink). Keeps the roadmap's rivet-agentos host. — **Reversibility:** costly — swapping runtimes later reworks `packages/host` and the dispatcher route.
- **D-02:** One small sandbox image (node + bun + git + gh + claude-ultrathink) is built locally from a Dockerfile under `infra/`, not pulled from a registry. — **Reversibility:** reversible.
- **D-03:** Refuse to build or pull any image unless `/` has at least 10 GB free; record free space before and after each build/pull. Host was 93% used, 30 GB free on 2026-09-25. — **Reversibility:** reversible.
- **D-04:** Do not reclaim other projects' Docker data (the 15.4 GB `asterinas/dev` image and its exited container `bold_rosalind` stay). — **Reversibility:** reversible.

### Host service and durability
- **D-05:** `substrate-host` is a separate systemd service (TypeScript, `packages/host`) running the rivet registry with its local engine on 127.0.0.1:6420 and persistent storage under `/var/lib/substrate/agentos`. It is not a dispatcher child, so a dispatcher restart does not kill VMs. — **Reversibility:** costly.
- **D-06:** The dispatcher routes `dispatch:claude-code` to the host over local HTTP (`openTask(graph_id, node_id, …)`) and receives a handle exposing the `poll()/terminate()/kill()` contract that `SessionRegistry` already uses; D-14's cap, 900 s claim timeout and landed-claim rule apply unchanged. One VM per Graph ID (`vm.getOrCreate(graph_id)`). — **Reversibility:** reversible.
- **D-07:** "Survives a host restart" means VM files under `/home/agentos` and session history persist in the engine's storage; after `substrate-host` (or the machine) restarts, the host resumes the session by sending the next prompt (rivet's resume → load → bounded-history fallback). A process mid-turn restarts. Process snapshotting is out of scope. — **Reversibility:** reversible.
- **D-08:** Credentials in the VM are only what the session needs: model auth (or a route to the shunt gateway), and the substrate, Notion and Linear MCP config. Never copy `/etc/substrate/substrate.env` in; rivet stores VM env and MCP credentials in plaintext in its database. — **Reversibility:** reversible.

### claude-ultrathink inside the VM and network access
- **D-09:** The first plan is a spike that answers: (a) can a rivet network allow rule reach host services bound to 127.0.0.1 (substrate-mcp :7410, shunt :3001); (b) does rivet's Claude adapter load claude-ultrathink's hooks/settings; (c) does git work in the sandbox. Fallback for (a): rivet host functions that proxy those endpoints. — **Reversibility:** reversible.
- **D-10:** claude-ultrathink runs inside the sandbox (bun available there). If the spike shows its hooks do not fire under the adapter, the host runs kickoff/sync on the session's behalf and the proof records that as a deviation. — **Reversibility:** reversible.
- **D-11:** The VM's `/home/agentos/.claude.json` configures an MCP server named exactly `substrate` (kickoff's `graph_register` step calls that name), reachable through the D-09 route. — **Reversibility:** reversible.
- **D-12:** Egress allowlist: Anthropic via shunt, mcp.notion.com, mcp.linear.app, api.greptile.com, github.com (and the GitHub API host). Nothing else. — **Reversibility:** reversible.

### Approvals, proof and Phase 2 carry-overs
- **D-13:** `permissionPolicy: "ask"`. The host posts each `permission_request` to Telegram with Approve/Deny buttons through a **new dedicated bot** the owner creates (the Hermes bot's update stream is consumed by the Hermes gateway), and answers with `respondPermission`. Requests never auto-approve. — **Reversibility:** reversible. Needs an owner checkpoint for the bot token and chat id.
- **D-14:** The proof uses a fresh Linear issue: archive one more duplicate from the Phase 2 owner-approved pool (same selection rules as `02-LINEAR-ARCHIVED.md`, record it there), then create the issue. Only if that fails, reuse SWC-467 with a new graph. — **Reversibility:** reversible.
- **D-15:** Fix WR-05 for both surfaces: a read-only `issue_get` MCP tool (and plain HTTP route for hooks) on substrate-mcp that returns the redacted title/description of the node's Linear issue by graph_id + node_id, and a prompt step "if you cannot do the work, call graph_release with the same session id and stop". Prompts stay ids-only. — **Reversibility:** reversible.
- **D-16:** IN-01: the claude-code route is sandboxed by the VM; dispatched Hermes keeps running as root, and the root trust assumption is documented next to `CHILD_ENV_ALLOW`. — **Reversibility:** reversible.

### Claude's Discretion
- Internal module layout of `packages/host`, the HTTP contract shape between dispatcher and host, and the Dockerfile contents, within D-01..D-16.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `packages/dispatcher`: `dispatch.py` (`DISPATCHABLE_SURFACES`, `make_launch_fn`, `validate_ids`), `sessions.py` (`SessionRegistry`, 900 s claim timeout, landed-claim rule, SIGTERM→SIGKILL), `worktree.py` (`ensure_worktree`, 5 GiB floor), `launcher.py` (Hermes prompt template with `"surface":"hermes"`).
- `packages/mcp-server`: claim/release/complete with Linear + Notion mirror and DoD gate; `graph_find`; `SURFACES` already includes `claude-code` and `rivet-agentos`; `SUBSTRATE_TOKEN_<SURFACE>` auth exists but no tokens are configured.
- `packages/host`: empty stub (`package.json` only).
- claude-ultrathink 0.3.0 plugin at `/root/.claude/plugins/cache/ultrathink/ultrathink/0.3.0`; kickoff step 3 already calls `graph_register` on an MCP server named `substrate`. Credentials: `~/.config/ultrathink/{config.json,mcp-credentials.json}` (0600). MCP servers notion/linear/greptile run via `ultrathink-mcp serve <id>` (stdio, bun).
- Telegram: `/root/.hermes/scripts/telegram_task_wrapup.py` is notify-only; no reply path exists for Claude Code.

### Established Patterns
- Fail open; redact before emitting; never print secrets; keyed calls via `systemd-run -p EnvironmentFile=`.
- systemd units in `infra/vps/`, reading `/etc/substrate/substrate.env`.
- Two-sided test baselines; owner checkpoints for anything the agent cannot do (bot creation).

### Integration Points
- rivet API (docs 2026-09): `agentOS({software, permissions, mounts, sandbox, onSessionEvent})`, `setup({use:{vm}}).start()`, `createClient({endpoint:"http://localhost:6420"}).vm.getOrCreate(key)`, `sessions.open({agent:"claude", cwd, env, mcpServers, permissionPolicy, additionalInstructions})`, `sessions.prompt`, `respondPermission({sessionId, requestId, optionId})`. Codex adapter: `@agentos-software/codex`.
- Claude Code in the VM: skills at `/home/agentos/.claude/skills/<name>/SKILL.md`, MCP config in `/home/agentos/.claude.json`, env `ANTHROPIC_*`.

</code_context>

<specifics>
## Specific Ideas

- Host resources: 8 vCPU, 31 GiB RAM (17 GiB available), node 24, bun 1.4; port 6420 free.
- Linear SWC team is at 250/250 active issues.

</specifics>

<deferred>
## Deferred Ideas

- Codex, OpenCode and Pi adapters in the same host.
- Running dispatched Hermes as an unprivileged user (IN-01).
- Reducing the Hermes `pre_llm_call` 30 s hook stall (Phase 2 latency).

</deferred>
