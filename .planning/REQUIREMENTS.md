# Requirements: Agent Substrate

**Defined:** 2026-10-08
**Core Value:** Every agent on the host shares one brief, one event log, one governed memory plane, one skills library and one Graph ID.

Source of truth for this milestone:

- The Notion build plan v0.2 (§3–§10, build order phases 0–6) and the locked v0.3 addendum, as linked from `.planning/PROJECT.md`.
- `docs/data-planes.md` (owner decisions 2026-09-26 and 2026-09-30) for the docs, memory and cache planes.
- Research for this milestone: `.planning/research/{STACK,FEATURES,ARCHITECTURE,PITFALLS,SUMMARY}.md`.

Decisions confirmed when the milestone was opened (2026-10-08):

- **Scope.** The owner chose "v1.3: finish the build plan": every unfinished build-plan area, in build-plan order, plus the deferred Phase 0 UAT.
- **Port, don't merge.** The September implementation on branch `docs/data-planes-tailscale` (`acc30a8`) is the primary source; it is ported file by file onto `main`. Main's v1.2 lease model is authoritative: every September claim, release and complete path is rebuilt on fenced leases (`lease_id`, heartbeat, holder-only), never on `setNodeState`. Manifests are not copied (they drop main's audit, observability and evidence workspaces). Commit `21652a2` is a list of names, not code to cherry-pick.
- **Vocabulary.** `EVENT_KINDS` stays unchanged (ADR 0001). New sources map onto existing kinds and surfaces, as v1.1 did for the swarm.
- **Proofs.** Each phase proves itself against an isolated substrate (scratch port, scratch Postgres and Greptime) plus the real external system its build-plan proof names. Every live run — production service, real stores, Linear or Notion writes, devnet transactions, GitHub PRs, model quota — waits for the operator's approval.
- **Grey areas** are settled in each phase's discuss step; only choices that change a user-visible contract (MCP tool shape, REST route, CLI, unit behavior) pause for the operator.

## v1.3 Requirements

### Foundation and production parity

- [x] **FOUND-01**: An isolated rehearsal harness starts main's `substrate-mcp` on a scratch port against scratch Postgres and GreptimeDB, with configurable surface tokens, and tears it down. Every v1.3 proof can point `SUBSTRATE_URL` at it, and no production store is touched by it.
- [x] **FOUND-02**: `EVENT_KINDS` is unchanged after every phase, each new event source documents its mapping onto existing kinds and onto the surfaces (the v1.2 list plus one system surface `substrate` for host jobs, operator decision 2026-10-08), and `packages/mcp-server/src/store-lock.test.ts` passes at every phase close. The audit policy records fail-open or fail-closed for every tool v1.3 adds, and a policy test catches a missing or contrary entry.
- [x] **FOUND-03**: Production parity, with operator approval: the stray process holding `127.0.0.1:7410` is retired so `substrate-mcp.service` serves `main`; a runbook records the check (unit PID owns the port, `/healthz` answers) and the rollback.
- [ ] **FOUND-04**: Production identity, with operator approval: a runbook lists every client of `substrate-mcp` and the token it needs; per-surface tokens, the operator token, `SUBSTRATE_HANDOFF_KEY` and `SUBSTRATE_AUDIT_PATH` are provisioned by name in `/etc/substrate/substrate.env` (values never in the repo), and no listed client is left without a token when they switch on.

### Lane B collectors (build plan §5.4–§5.5, Phase 1)

- [x] **LANEB-01**: The herdr collector runs from `main` as `substrate-collector-herdr.service`: it bootstraps from `session.snapshot`, holds one `events.subscribe` per connection, reconciles every 5 s with dedupe offsets, and posts fail-open to `POST /events`.
- [x] **LANEB-02**: herdr events use main's vocabulary: surface = the agent herdr detected, repo = the origin slug of the pane's working directory, detected → `session.start`, exited → `session.end`, status change → `note` with `payload.status` and `runtime: herdr`.
- [x] **LANEB-03**: The Muse brief writer, for each repo in `SUBSTRATE_MUSE_REPOS`, fetches `POST /brief` as surface `muse` keyed by repo slug, writes a redacted `<repo>/.substrate/BRIEF.md` and an idempotent `AGENTS.md` pointer, refreshes every 5 minutes and keeps the last good file when a fetch fails.
- [x] **LANEB-04**: The Muse plugin is projected, validated and approved; its PostToolUse hook emits `tool.call` as surface `muse` with repo and branch from git, importing the redactor from a stable installed path rather than the operator checkout.
- [x] **LANEB-05**: Collectors never block an agent, keep their offsets across restarts, and count refused emits where the operator can see them (a periodic `warning` or a counter), so a vocabulary mismatch can no longer drop events silently.
- [x] **LANEB-06**: One shared redactor: main's `redact.ts` gains the September D-04 rules while keeping its `COUNTER_KEY` exemption, and every collector, `docs_ingest`, `skills_propose` and anything anchored uses it.
- [x] **LANEB-07**: Proof (isolated): a herdr pane going working → idle in repo R and a Muse tool call in R appear in `events_query(repo=R)` within 10 s under main-valid surfaces and kinds, with zero refused emits, and R's `.substrate/BRIEF.md` lists them on its next refresh.

### Skills plane (build plan §6, Phase 4)

- [x] **SKILL-01**: `skills_propose` (MCP tool, `POST /skills/propose`, `substrate skills propose`) validates name, paths and frontmatter; redacts and secret-scans, refusing on a finding; dedupes by content hash (`existing` / `declined` / `unchanged`); and opens branch `skill/<surface>/<name>-<ts>-<hex>` with a PR on `swcstudiospace/agent-skills` through `gh`, checking the origin and never force-pushing. Callers authenticate with their surface token; the tool is registered in `mcp.ts`, `observe.ts` and the audit policy.
- [ ] **SKILL-02**: `substrate-skills-sync` runs from `main`: fast-forward-only fetch of `/root/agent-skills`; a dirty, off-branch or diverged checkout is refused with a `warning` event; symlinks are projected for Claude Code, Grok Build, `.agents` (Cursor), Muse and the OpenClaw roots, with backup and restore.
- [ ] **SKILL-03**: The Hermes bridge runs from `main` every 5 minutes, drains `~/.hermes/pending/skills` and the Omp and Grok queues into `skills_propose` after 120 s of quiet, and deletes a queued record only on a final reply.
- [ ] **SKILL-04**: The Hermes hourly miner cron runs main's code: an unchanged hour skips the model run, a run proposes at most 3 skills through `skill_manage`, and `skills.write_approval` and `memory.write_approval` stay true.
- [ ] **SKILL-05**: All three miners propose instead of publishing: skill-autonomy posts to `/skills/propose` (or stages), the Omp extension intercepts `manage_skill` and `learn`, and Hermes `skill_manage` output goes pending → bridge.
- [x] **SKILL-06**: The Cursor `stop` hook runs from `main`: it copies a redacted transcript to `/var/lib/substrate/transcripts/cursor` and emits `session.end`.
- [ ] **SKILL-07**: Proof (live, approved): a skill mined from a Cursor session is proposed as a PR, merged by the owner, and within one sync tick (≤ 5 min) appears in Claude Code and Grok Build without either agent's config changing; both timers and the cron run green on main's code.

### Claim mirror and DoD gate (build plan §3.3, Phase 2)

- [ ] **MIRROR-01**: A Linear client inside `substrate-mcp` reads issue context, resolves workflow states by type through the issue's own team, ensures labels (team, workspace, create), edits labels additively only, and posts comments idempotently.
- [ ] **MIRROR-02**: A granted or reclaimed lease mirrors to the trackers: Linear moves to the team's first `started` state, `agent:<surface>` is added and every `dispatch:*` removed in one update, one comment per session reads `Claimed by <surface> — session <sid> (graph <g>, node <n>)`, and the Notion Issue row's `Agent` is set. No `lease_id` is ever written to Linear or Notion. Exception (operator decision 2026-10-08): a lease held by a `swarm-*` surface only posts that comment and never changes the issue's state or labels or the Notion row, and a test pins the exception.
- [ ] **MIRROR-03**: Every other lease transition is mirrored: renewed → nothing; stolen → the label moves to the new holder; released, reaped or operator-forced → Linear back to `unstarted`, `agent:*` removed, Notion `Agent` cleared. For a `swarm-*` holder the transition is recorded as a comment only, under the same exception and test as MIRROR-02.
- [ ] **MIRROR-04**: `graph_complete` accepts an optional `dod` and passes the Definition-of-Done gate: the node goes to `started_review` and Linear to In Review; the substrate posts `{linear_issue_id, summary, tests_pass, review_pass}` to `{HERMES_LINEAR_URL}/v1/complete-issue`; only the connector moves the issue to Done; on refusal or error the node stays in review with the lease kept; then main's fenced completion runs.
- [ ] **MIRROR-05**: The lease is authoritative: a failed mirror write never rolls it back and produces one `warning` event `{target, action, reason}` per failed target; a losing claimant writes nothing; startup logs `mirror: linear on|off, notion on|off`.
- [ ] **MIRROR-06**: Notion writes touch only `Agent`, `Status`, `Linear State` and `Completed`, only on Issue rows whose parent data source is `NOTION_TASK_GRAPH_DS`, always read-then-write.
- [ ] **MIRROR-07**: `graph_find` maps a Linear id or identifier to a node (`found: false` for zero or several matches) and `issue_get` returns the issue text redacted, capped and marked untrusted; neither returns a `lease_id`.
- [ ] **MIRROR-08**: Proof (live, approved): on a real Linear issue and its Notion row, a claim, a second surface's refused claim, a release, a complete without DoD and a complete with DoD each produce exactly the tracker state above within 60 s.

### substrate-dispatcher (build plan §3.4, Phase 2)

- [ ] **DISP-01**: The dispatcher runs from `main` as `substrate-dispatcher.service`: every 30 s it reads unstarted issues carrying a `dispatch:*` label, holds a flock so only one instance runs, and re-reads the kill switch `SUBSTRATE_DISPATCH_DISABLED` every tick (on by default outside proof windows).
- [ ] **DISP-02**: Every non-dispatch outcome leaves one once-only marker comment on the issue: `not-dispatchable`, `no-node`, `already-claimed`, `low-disk`, `no-checkout`, `path-conflict`, `git-failed`, `host-refused`, `host-unreachable`, `exited-unclaimed` or `claim-timeout`.
- [ ] **DISP-03**: Each Graph ID gets a worktree at `/var/lib/substrate/worktrees/<graph_id>` on branch `substrate/<graph_id>`: reused when present, its repo verified by origin URL, and refused below 5 GiB free.
- [ ] **DISP-04**: Launchers: `hermes` starts a headless Hermes session with an allowlisted environment; `claude-code` goes to the Lane A host; any other surface gets `not-dispatchable`.
- [ ] **DISP-05**: Sessions are lease-correct: the launched agent claims with its own surface token, keeps the `lease_id`, heartbeats inside the TTL, and completes with the `lease_id` and DoD fields or releases; the dispatcher never claims on an agent's behalf, and its own calls are authenticated.
- [ ] **DISP-06**: A claim watch treats a claim as landed when `graph_get` shows the target surface holding a live lease; after 900 s it stops the session (SIGTERM, then SIGKILL); an exit without a claim comments, removes the label and gives the issue up, and the given-up set survives a restart.
- [ ] **DISP-07**: Issue text never enters the launch prompt; the session fetches it at run time through `issue_get` and treats it as untrusted.
- [ ] **DISP-08**: Proof (live, approved): labelling an issue `dispatch:hermes` in a bounded window launches a session within 30 s; the claim lands under the Hermes token; the label becomes `agent:hermes`; Notion shows Agent hermes; a Claude Code brief names the claim within 60 s of labelling; the run ends in a gated Done or a release; the kill switch is back on afterwards.

### Docs, memory and cache planes (build plan §5, Phase 5; `docs/data-planes.md`)

- [ ] **DOCS-01**: `docs_search` (MCP tool and `POST /docs/search`) calls RAGFlow retrieval with explicit dataset ids and at most 10 results; each result carries title, source URL, heading path, commit, a redacted snippet of at most 1,200 characters, score and ids; the reply is marked untrusted, one event lists the returned URLs, and any error yields an empty result with a reason.
- [ ] **DOCS-02**: `docs_ingest` (MCP tool, `POST /docs/ingest`, `substrate docs ingest`) redacts before upload, strips remote images, is idempotent by content hash, refuses a page without a source URL or outside the configured roots or over the size caps, and accepts only authenticated surfaces.
- [ ] **DOCS-03**: The datasets `docs/data-planes.md` lists exist and refresh as it says (`agent-substrate` on merge, `agent-skills` after each skills-sync fast-forward, `programming-desk`, one per product), keeping the last five versions.
- [ ] **DOCS-04**: Hindsight retains a memory only after the governance gate returns `accepted` with `verified_persisted`, redacted and carrying a `receipt_path` or `source`, into the writer's `sub-<surface>` bank; recall is a tool (or derived-marked `memory_search` results) and never runs inside the brief's 1.5 s budget.
- [ ] **DOCS-05**: Dragonfly is a read-through cache only (brief, search and recall results, per-surface counters, a 24 h idempotency mirror); `/healthz` reports `{enabled, connected, hits, misses, bypasses}`; during an outage the same answers come back uncached; a cached brief never hides a claim older than 60 s.
- [ ] **DOCS-06**: Plane credentials live only in `substrate.env`; the substrate refuses a plaintext, non-loopback `redis://` Dragonfly URL, and a runbook covers the Tailscale forwarder hop for the planes.
- [ ] **DOCS-07**: Proof (live, approved): a headless session holding only the substrate MCP answers a docs question with a source URL that `docs_search` returned and that event can be read back; an accepted memory retained by one surface is recalled by another with its source; a second identical brief is a cache hit and, with Dragonfly down, the same brief returns uncached.

### Ledger anchor (build plan §7, Phase 6)

- [x] **ANCHOR-01**: An hour's events are decided by server ingest order, recorded append-only without altering `agent_events`, through typed methods that keep `store-lock.test.ts` green.
- [x] **ANCHOR-02**: Each closed hour gets an RFC 6962 Merkle root over its event hashes in ingest order, and the memo `substrate:v1:<period_start>:<root>:<count>`.
- [ ] **ANCHOR-03**: An hourly timer (`OnCalendar=hourly`, `Persistent=true`) anchors the previous hour idempotently: a re-run adopts an existing signer-checked memo, and a root mismatch raises an alarm and exits 1.
- [ ] **ANCHOR-04**: The anchor is sent through the solana CLI with only the keypair path on the command line, on devnet only, and writes an `anchors` row `{period_start, period_end, root, event_count, memo, tx_sig, signer, cluster, slot, anchored_at}`; the DDL is reconciled with the table already live in production.
- [ ] **ANCHOR-05**: `substrate verify <graph_id>` and `POST /verify` check the chain and, per hour, recompute the root and compare it with the memo read back by `tx_sig`; an hour is `pending` for up to 3 h after it closes and `unverified` (fail-closed) when devnet cannot be read.
- [ ] **ANCHOR-06**: Proof (live, approved): a closed hour is anchored on devnet with a memo root equal to the recomputed root; altering one event on a scratch ledger makes `verify` exit 1 naming that hour; an untouched graph verifies with every hour anchored; re-running the timer adopts the existing memo.

### Agent Cards and teachable moments (build plan Phase 4 v0.3 user addition)

- [ ] **CARD-01**: Each agent surface has an A2A v1.0 Agent Card served on loopback at `/.well-known/agent-card.json` (per surface), valid against the spec (id, name, description, supported interfaces, capabilities, default modes, `skills[]`).
- [ ] **CARD-02**: A teachable moment is a governed `fact` (tagged, no new memory kind) written through `memory_write` from a session's observations or edge cases, and each accepted teachable appears as an entry in its surface's card `skills[]`.
- [ ] **CARD-03**: Teachable writes emit events that the hourly anchor covers, and `verify` reports the hour holding a teachable as anchored.
- [ ] **CARD-04**: Proof: a teachable recorded from a session appears in that surface's Agent Card and its event sits inside an anchored hour.

### desktop_run (build plan §4.4, Phase 5)

- [x] **DESK-01**: `desktop_run` drives the dedicated `substrate-desktop` webtop with a closed vocabulary (click, type, key, screenshot), at most 50 actions, a 1–120 s timeout, a fixed `docker exec` argv and one run at a time; screenshots return as MCP image blocks and are kept at mode 0600 for 200 runs or 7 days.
- [x] **DESK-02**: Each action produces one event under an existing kind; typed text is recorded only as its length and sha256; image blocks never enter the audit record.
- [x] **DESK-03**: Only surfaces on an operator-maintained allowlist may call `desktop_run` (operator decision 2026-10-08); an unlisted surface with a valid token, an anonymous caller and a VM guest are each refused, with a test for each; it is fail-closed in the audit policy.
- [x] **DESK-04**: A lifecycle script runs the container only with ≥ 10 GiB free, `--pull never`, loopback port 6081 behind basic auth, unprivileged and without the Docker socket, and never touches `recruitment-desktop`.
- [x] **DESK-05**: Proof (isolated): a headless session's `desktop_run` returns a screenshot whose pixels show the typed marker, one event per action lands, and `recruitment-desktop` is untouched.

### Lane A host (build plan §4.1, Phase 3)

- [ ] **LANEA-01**: `substrate-host.service` runs one rivet-agentos VM per Graph ID with a Docker sandbox for native tools, a loopback `POST /tasks` on port 7411 and the rivet engine on loopback, without colliding with the engine container already bound to port 6420.
- [ ] **LANEA-02**: `openTask(graphId)` reads the node, claims it as `claude-code` with that surface's token, keeps the `lease_id` and heartbeats while turns run, seeds the brief, skills and MCP config with a sha256 read-back, opens the session with permission policy "ask", and releases the claim on any failure.
- [ ] **LANEA-03**: Sessions are durable: after a host restart, a continuation prompt keyed `<graph_id>:<node_id>:resume:<n>` resumes the work.
- [ ] **LANEA-04**: The dispatcher routes `dispatch:claude-code` to `POST /tasks`, and a refusal becomes a once-only Linear comment.
- [ ] **LANEA-05**: A disk gate in code refuses any image build or pull with less than 10 GiB free.
- [ ] **LANEA-06**: Permission requests reach a human through single-use Approve/Deny buttons on the existing Telegram stop-notify path, and an unanswered request times out rather than waiting forever.
- [ ] **LANEA-07**: Credentials stay on the host: the VM holds no tokens, and host functions commit and push (never force, never `.substrate-*` files), open the PR and sync PR fields through the substrate's Linear and Notion clients.
- [ ] **LANEA-08**: Proof (live, approved): `dispatch:claude-code` on a fresh issue opens a VM that claims and heartbeats; restarting `substrate-host` mid-session resumes the same session; a real push and PR land; the PR fields sync; the issue reaches a gated Done.

### Phase 0 UAT (deferred since v1.1)

- [ ] **UAT-01**: All eight scenarios in `.planning/milestones/v1.0-phases/00-brief/0-UAT.md` are re-run against `main` with expectations updated to today's surface (the nine named tools among the current set, the `## Agent Substrate brief` header, `fetchBrief`'s current location), and each records pass or fail with evidence.
- [ ] **UAT-02**: The UAT is a repeatable script that runs against any `SUBSTRATE_URL`, so later phases can use it as a regression check.
- [ ] **UAT-03**: Scenario 5 passes: Claude Code has a `substrate` MCP entry naming its token variable, and `ultrathink-kickoff` registers each new graph through `graph_register` (claude-ultrathink change, shipped in that repo).
- [ ] **UAT-04**: Scenario 6 passes: the Cursor hooks and the git post-commit collector are installed and emit live, including the `stop` hook from SKILL-06.

## Future Requirements

Deferred; tracked but not in this roadmap.

- **XREPO-01**: Push grok-hermes-connector v0.4 (repo `mcp`, live from an unpushed branch) and forward `docs_search` and `skills_*` once DOCS and SKILL land.
- **XREPO-02**: claude-ultrathink: `graph_claim` in kickoff plus `pr` and `session.end` emits (build plan §5.4); merge its v1.4 branch and refresh the installed plugin.
- **XREPO-03**: omp-ultrathink `memory_brief` discovery step: give the repo a remote, install it, and give it Omp's surface token.
- **XREPO-04**: hermes-engineering-board emits as surface `hermes` instead of the rejected `hermes-eng-board`; disable the Hermes `kanban` toolset (build plan §3.5).
- **XREPO-05**: Give hermes-plugin, hermes-engineering-board, hermes-linear-connector, omp-ultrathink and skill-autonomy git remotes (five production services run from remote-less working trees).
- **LANEB-08**: herdr-hosted dispatch (herdr `agent start` as a launcher) and an Orca tee collector.
- **MIRROR-09**: Mirror Linear sub-issue state per Chain-of-Thought step; action DAG on sub-issues (v0.3 §2 optional).
- **S5-01**: ADR 0001 S5 gate verdicts as events (SPE-5056).
- **LES-T2**: Lessons bank Tier 2 (phase lifecycle events, realtime delivery, outbox, discuss-step injection).

## Out of Scope

| Feature | Reason |
|---------|--------|
| cua desktop images | The `cua-xfce` image is 7.89 GB compressed with 22 GB free; the build plan allows the existing webtop instead |
| QEMU or KVM paths | The host has no `/dev/kvm` |
| Solana mainnet or testnet anchors | The build plan fixes devnet; roots only, never event contents |
| New event kinds or a second hash chain | ADR 0001 non-goals; anchoring rides main's per-session chain and ingest order |
| Porting `21652a2` code | Stubs: retrieval without dataset ids, a never-called cache client, an unverifiable memo |
| The Autonogrammer client | Build plan §11: dispatch is a Linear label and the board is Notion |
| Raw RAGFlow or Hindsight MCP servers in agent configs | v0.3 §4: docs only through the substrate; agents never hold plane credentials |

## Traceability

Which phases cover which requirements. Filled in by the roadmap.

| Requirement | Phase | Status |
|-------------|-------|--------|
| FOUND-01 | Phase 16 | Complete |
| FOUND-02 | Phase 17 | Complete |
| FOUND-03 | Phase 16 | Complete |
| FOUND-04 | Phase 20 | Pending |
| LANEB-01 | Phase 19 | Complete |
| LANEB-02 | Phase 19 | Complete |
| LANEB-03 | Phase 19 | Complete |
| LANEB-04 | Phase 19 | Complete |
| LANEB-05 | Phase 19 | Complete |
| LANEB-06 | Phase 18 | Complete |
| LANEB-07 | Phase 19 | Complete |
| SKILL-01 | Phase 21 | Complete |
| SKILL-02 | Phase 22 | Pending |
| SKILL-03 | Phase 22 | Pending |
| SKILL-04 | Phase 22 | Pending |
| SKILL-05 | Phase 22 | Pending |
| SKILL-06 | Phase 19 | Complete |
| SKILL-07 | Phase 22 | Pending |
| MIRROR-01 | Phase 23 | Pending |
| MIRROR-02 | Phase 23 | Pending |
| MIRROR-03 | Phase 23 | Pending |
| MIRROR-04 | Phase 23 | Pending |
| MIRROR-05 | Phase 23 | Pending |
| MIRROR-06 | Phase 23 | Pending |
| MIRROR-07 | Phase 23 | Pending |
| MIRROR-08 | Phase 23 | Pending |
| DISP-01 | Phase 24 | Pending |
| DISP-02 | Phase 24 | Pending |
| DISP-03 | Phase 24 | Pending |
| DISP-04 | Phase 24 | Pending |
| DISP-05 | Phase 24 | Pending |
| DISP-06 | Phase 24 | Pending |
| DISP-07 | Phase 24 | Pending |
| DISP-08 | Phase 24 | Pending |
| DOCS-01 | Phase 25 | Pending |
| DOCS-02 | Phase 25 | Pending |
| DOCS-03 | Phase 25 | Pending |
| DOCS-04 | Phase 26 | Pending |
| DOCS-05 | Phase 26 | Pending |
| DOCS-06 | Phase 26 | Pending |
| DOCS-07 | Phase 26 | Pending |
| ANCHOR-01 | Phase 27 | Complete |
| ANCHOR-02 | Phase 27 | Complete |
| ANCHOR-03 | Phase 28 | Pending |
| ANCHOR-04 | Phase 28 | Pending |
| ANCHOR-05 | Phase 28 | Pending |
| ANCHOR-06 | Phase 28 | Pending |
| CARD-01 | Phase 29 | Pending |
| CARD-02 | Phase 29 | Pending |
| CARD-03 | Phase 29 | Pending |
| CARD-04 | Phase 29 | Pending |
| DESK-01 | Phase 30 | Complete |
| DESK-02 | Phase 30 | Complete |
| DESK-03 | Phase 30 | Complete |
| DESK-04 | Phase 30 | Complete |
| DESK-05 | Phase 30 | Complete |
| LANEA-01 | Phase 31 | Pending |
| LANEA-02 | Phase 32 | Pending |
| LANEA-03 | Phase 32 | Pending |
| LANEA-04 | Phase 33 | Pending |
| LANEA-05 | Phase 31 | Pending |
| LANEA-06 | Phase 33 | Pending |
| LANEA-07 | Phase 32 | Pending |
| LANEA-08 | Phase 33 | Pending |
| UAT-01 | Phase 20 | Pending |
| UAT-02 | Phase 20 | Pending |
| UAT-03 | Phase 20 | Pending |
| UAT-04 | Phase 20 | Pending |

**Coverage:**
- v1.3 requirements: 68 total
- Mapped to phases: 68 (Phases 16–33)
- Unmapped: 0 ✓

---
*Requirements defined: 2026-10-08*
*Last updated: 2026-10-08 after the v1.3 roadmap (traceability filled)*
