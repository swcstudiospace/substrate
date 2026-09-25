# API Coverage — Phase 3 (rivet agentOS 0.2.21 + sandbox-agent 0.4.2, Docker Engine, Telegram Bot API, Linear GraphQL, Notion REST, GitHub, shunt, substrate-mcp)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> Plans: 03-01 (D-09 spike, sandbox provider, image), 03-02 (issue_get, Hermes prompt, D-16), 03-03 (substrate-host tracer),
> 03-04 (VM policy tests, SC-2 tracker MCP config, tracker proxy, tests route), 03-05 (dispatcher route + dispatch tracer),
> 03-06 (restart resume, containment audit), 03-07 (git/PR host functions, sync by tracker route),
> 03-08 (Telegram approvals), 03-09 (proof setup, D-14), 03-10 (proof run).
> Route-conditional rows follow `route_choice=`, `tracker_route=` and `tests_route=` in 03-01-SPIKE.md; the plan that implements each branch is named.

| capability | decision | reason |
|---|---|---|
| rivet: agentOS() actor definition (software, permissions, mounts, sandbox) | INTEGRATE | 03-03 vm.ts; spiked in 03-01 |
| rivet: setup({use}).start() with the local engine | INTEGRATE | 03-03 main.ts under substrate-host.service (D-05), RIVET_RUN_ENGINE and RIVETKIT_STORAGE_PATH; engine bound to 127.0.0.1 |
| rivet: createClient + vm.getOrCreate([graph_id]) | INTEGRATE | one VM per Graph ID (D-06), 03-03 tasks.ts |
| rivet: resolveOptions per actor key | INTEGRATE | per-graph worktree mount and sandbox provider, 03-03 |
| rivet: host_dir mount | INTEGRATE | /home/agentos/work → /var/lib/substrate/worktrees/<gid>, 03-03 |
| rivet: permissions.network rules + loopbackExemptPorts | INTEGRATE | D-12 allowlist and the D-09 loopback route, 03-01 / 03-03; 127.0.0.1:7412 (tracker proxy) only on tracker_route vm_mcp, 03-04 |
| rivet: permissions.hostFunction scope | INTEGRATE | allow only the substrate and sandbox collections, 03-03 |
| rivet: hostFunctions collection (agentos-substrate …) | INTEGRATE | issue-get/release/complete (s:hostfn), git-push, pr-create, sync, commit (c:hostfn_commit), model-fetch (a:hostfn_proxy), run-tests (tests_route oneshot) — 03-03 / 03-04 / 03-07 |
| rivet: sessions.open (claude agent, permissionPolicy ask) | INTEGRATE | 03-03; env limited to five keys (D-08), mcpServers without headers, static additionalInstructions |
| rivet: sessions.prompt with idempotencyKey | INTEGRATE | first prompt and resume prompts, 03-03 / 03-06 |
| rivet: sessions.get and readHistory | INTEGRATE | task status, restart evidence, proof, 03-03 / 03-06 / 03-10 |
| rivet: sessions.cancelPrompt | INTEGRATE | terminate(), 03-03 |
| rivet: sessions.unload | INTEGRATE | kill(), 03-03 |
| rivet: sessions.delete | OPT-OUT | not needed — kill keeps the VM and its history (D-07 durability, proof evidence) |
| rivet: respondPermission | INTEGRATE | only from an authorised Telegram tap, 03-08 (D-13) |
| rivet: respondPermission with the allow_always option | OPT-OUT | explicitly out of scope — D-13 needs a tap on every tool call; after allow_always the adapter answers later matching calls itself |
| rivet: onSessionEvent (permission_request) | INTEGRATE | 03-03 records, 03-08 posts to Telegram |
| rivet: process.exec in a VM | INTEGRATE | spike probes and live checks only (03-01, 03-03, 03-06, 03-07); never exposed to guests |
| rivet: VM filesystem write/read | INTEGRATE | seed files and read-back with sha256, 03-03 |
| rivet: permissionPolicy allow_all | OPT-OUT | explicitly out of scope for dispatched sessions — D-13 locks ask; allow_all is used only by the 03-01 spike's probe sessions |
| rivet: inspector UI on :6420/ui | OPT-OUT | not needed — the engine stays loopback-bound and unused by operators |
| rivet: @agentos-software/claude-code 0.2.7 agent package | INTEGRATE | the only Claude adapter agentos-core 0.2.21 loads; its --bare behaviour is measured by 03-01 (b) |
| rivet: custom agent package without --bare (agentos-toolchain pack) | OPT-OUT | not needed yet — research escalation only; the host-side sync route covers bare mode |
| rivet: @agentos-software/git WASM git | INTEGRATE | route-conditional: installed and added to software only on c:vm_git (03-07); probed in 03-01 |
| rivet: Codex, OpenCode and Pi agent packages | OPT-OUT | explicitly out of scope — CONTEXT Deferred Ideas |
| sandbox-agent: SandboxProvider interface (create, destroy, getUrl) | INTEGRATE | custom substrateDocker, 03-01 sandbox-provider.ts |
| sandbox-agent: stock docker() provider | OPT-OUT | security — publishes `--no-token --host 0.0.0.0` on every interface with the firewall off |
| sandbox-agent: `server --token` inside the container | INTEGRATE | per-container token, 03-01 |
| sandbox-agent: agentos-sandbox run-command from the VM | INTEGRATE | bun, git and tests in the sandbox, 03-01 / 03-03 |
| sandbox-agent: cloud providers (e2b, daytona, …) | OPT-OUT | not needed — D-01 uses the local Docker sandbox |
| Docker Engine: container create/start/inspect/remove via dockerode | INTEGRATE | substrateDocker and the boot sweep (label substrate.graph_id only), 03-01 / 03-03 |
| Docker Engine: internal network create | INTEGRATE | route-conditional on sandbox_net=internal (container egress blocked), 03-01 |
| Docker Engine: local image build (buildx, named build context) | INTEGRATE | D-02 substrate-sandbox:0.1, 03-01 |
| Docker Engine: one-shot test container (--rm, --network none, read-only binds) | INTEGRATE | route-conditional on tests_route=oneshot: probed in 03-01, run-tests host function in 03-04 |
| Docker Engine: base image pull node:24-bookworm-slim | INTEGRATE | the only pull, behind the D-03 gate, 03-01 |
| Docker Engine: push to a registry | OPT-OUT | explicitly out of scope — D-02 builds locally, nothing is published |
| Docker Engine: prune / rmi / rm of anything not labelled substrate.graph_id | OPT-OUT | explicitly out of scope — D-04 |
| Telegram: getMe | INTEGRATE | startup check, 03-08 |
| Telegram: sendMessage with inline_keyboard | INTEGRATE | approval requests with Approve (allow_once) and Deny (reject_once) buttons only, 03-08 |
| Telegram: getUpdates long poll (callback_query only) | INTEGRATE | 03-08; offset persisted |
| Telegram: answerCallbackQuery | INTEGRATE | 03-08 |
| Telegram: editMessageReplyMarkup and editMessageText | INTEGRATE | remove buttons and show the outcome, 03-08 |
| Telegram: setWebhook / webhook delivery | OPT-OUT | not needed — no public ingress; D-13's dedicated bot is long-polled |
| Telegram: deleteWebhook | OPT-OUT | not needed — the new bot never has a webhook |
| Telegram: text-command or reply-based approvals | OPT-OUT | not needed — buttons with single-use keys only, authorised by chat and user |
| Telegram: the Hermes bot token | OPT-OUT | explicitly out of scope — D-13; the Hermes gateway consumes its update stream |
| Linear: issue(id) { identifier title description } | INTEGRATE | issue_get, 03-02 (D-15) |
| Linear: attachmentLinkURL (fallback attachmentCreate) | INTEGRATE | PR link from host-side sync, 03-07 |
| Linear: issue attachments read | INTEGRATE | read-only model-sync check on tracker_route vm_mcp, 03-07 |
| Linear: issueArchive | INTEGRATE | D-14 proof capacity only, 03-09 |
| Linear: issueUnarchive | INTEGRATE | recorded undo for 03-09's archives |
| Linear: issueCreate | INTEGRATE | the one D-14 proof issue, 03-09 |
| Linear: issueUpdate addedLabelIds (dispatch:claude-code) | INTEGRATE | proof label, 03-10 |
| Linear: issues pagination (count, pool selection) and issue history read | INTEGRATE | 03-09 / 03-10 |
| Linear: issueUpdate stateId from sync (In Review / Done) | OPT-OUT | explicitly out of scope — Phase 2 D-06/D-07: Done only through graph_complete and the DoD gate; sync writes the PR link only |
| Linear: remote MCP mcp.linear.app with a credential stored in the VM | OPT-OUT | security — keys would sit in rivet's plaintext storage (D-08) |
| Linear: MCP from the VM via the host loopback tracker proxy (:7412) | INTEGRATE | SC-2 entry seeded on every route; live only on tracker_route vm_mcp for the in-VM ultrathink kickoff/sync (D-10), Linear state changes refused by the proxy — 03-04 / 03-07 |
| Notion: data source query (Level Task, Graph ID) | INTEGRATE | host-side sync and the read-only model-sync check, 03-07 |
| Notion: page update PR URL, PR #, PR State, Repo, Branch | INTEGRATE | host-side sync (D-10), 03-07; SYNC_WRITABLE |
| Notion: page create (Task and Issue rows) | INTEGRATE | proof setup only, 03-09 |
| Notion: page read | INTEGRATE | proof evidence, 03-10 |
| Notion: Task-row merged, checks and reviewer updates | OPT-OUT | not needed yet — Phase 3 sync covers the PR-opened transition (PR State Open); PR State/Status Merged, Checks and Reviewers stay with ultrathink-sync on the owner's sessions |
| Notion: remote MCP mcp.notion.com with a credential stored in the VM | OPT-OUT | security — 8 h OAuth token and plaintext rivet storage (research Pitfall 8, D-08) |
| Notion: MCP from the VM via the host loopback tracker proxy (:7412) | INTEGRATE | SC-2 entry on every route; live only on vm_mcp: in-VM kickoff (Task → Implementing) and sync (PR fields); terminal Status and Completed refused by the proxy — 03-04 / 03-07 |
| ultrathink-mcp serve notion/linear on the host (refreshed OAuth store) | INTEGRATE | child processes of the tracker proxy, tracker_route vm_mcp only, 03-04 |
| GitHub: git push over https with the host's gh credential helper | INTEGRATE | git-push host function, 03-07 |
| GitHub: gh pr create | INTEGRATE | pr-create host function, 03-07 |
| GitHub: gh pr view | INTEGRATE | proof evidence, 03-10 |
| GitHub: aio greptile_review | INTEGRATE | proof, 03-10 |
| GitHub: aio github_merge_pull_request | INTEGRATE | proof decision (ii) only, after allowsMerge, 03-10 |
| GitHub: aio github_create_repo | INTEGRATE | proof decision (iii) only, 03-09 |
| GitHub: API or git credentials inside the VM or container | OPT-OUT | security — the owner PAT (admin:org, delete_repo) never leaves the host |
| GitHub: force push, branch deletion, PR close | OPT-OUT | not needed — no host function exposes them |
| shunt: Anthropic Messages API through ANTHROPIC_BASE_URL | INTEGRATE | model route a:loopback (or the a:hostfn_proxy relay), 03-01 / 03-03 |
| shunt: GET /v1/models | INTEGRATE | spike reachability probe, 03-01 |
| Anthropic API direct (api.anthropic.com) | OPT-OUT | not needed unless 03-01 falls to (a3) with an owner-supplied key and D-12 amended at that checkpoint |
| substrate-mcp: issue_get MCP tool | INTEGRATE | new, 03-02 (D-15) |
| substrate-mcp: POST /issue | INTEGRATE | new, 03-02 (D-15) |
| substrate-mcp: graph_* tools and POST /brief | INTEGRATE | graph_get, graph_find, graph_register, graph_claim, graph_release, graph_complete and /brief — host (03-03), dispatcher (03-05), proof (03-09/03-10) |
| substrate-mcp: SUBSTRATE_TOKEN_* bearer auth | OPT-OUT | not needed yet — anonymous loopback today; enabling it would 401 every Phase 1 surface |
| hermes-linear-connector: DoD gate (via graph_complete) | INTEGRATE | the only path to Linear Done, observed in 03-10 |
| npm registry installs into packages/host | INTEGRATE | 03-01 behind the blocking legitimacy checkpoint, `--workspaces=false`, pinned versions |
