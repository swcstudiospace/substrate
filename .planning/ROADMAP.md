# Roadmap: Agent Substrate v1.0

## Overview

Build the four-plane agent substrate (runtime, memory, skills, ledger) per the Notion build
plan, keyed by the Graph ID that `claude-ultrathink` already mints. Seven phases, each ending
in a proof that is **run for real**, not asserted.

## Phases

> **Note on numbering.** GSD's roadmap parser does not recognise phase number
> `0` — `roadmap.analyze` reports 6 phases and starts at 1, so Phase 0 is
> invisible to GSD progress and milestone audits. The numbering is kept as
> 0-6 to match the Notion build plan, which is the source of truth and which
> is cross-referenced throughout. Phase 0 is complete and live; track it here.

**Phase Numbering:** integer phases are planned milestone work; decimal phases (2.1) are
urgent insertions.

- [x] **Phase 0: Brief** — cross-agent briefing on the two surfaces used most, keyed by Graph ID
- [x] **Phase 1: Lane B** — Hermes, Omp, Muse Code, Grok Build and Grok Bot inside the substrate (completed 2026-09-24)
- [x] **Phase 2: Claims and dispatch** — Linear drives who works on what (completed 2026-09-25)
- [ ] **Phase 3: Lane A** — sandboxed, durable sessions per Graph ID via rivet-agentos
- [ ] **Phase 4: Skills** — one library, three miners proposing, Hermes primary
- [ ] **Phase 5: Docs and desktop** — product docs and GUI tasks reachable from any agent
- [ ] **Phase 6: Ledger** — tamper-evident history

## Phase Details

### Phase 0: Brief

**Goal**: A Claude Code prompt on the VPS is preceded by a brief that names what other agents
and surfaces did in that repo, sourced from a real event store and a real index.
**Depends on**: Nothing (first phase)
**Success Criteria** (what must be TRUE):

  1. `substrate-mcp` listens on `127.0.0.1:7410` under systemd and serves `memory.brief`,
     `memory.write`, `memory.search`, `events.emit`, `graph.get`, `graph.register` over MCP,
     plus `POST /brief` and `POST /events` as plain HTTP for hooks.
  2. `graph_index`, `graph_nodes`, `graph_steps` and memory tables exist in the index Postgres;
     `agent_events` exists in GreptimeDB.
  3. The index is backfilled from every Notion Agent Task Graph row carrying a Graph ID and
     from the Linear Spectrum Web Co team.
  4. `claude-ultrathink/hooks/uplift.ts` calls `fetchBrief` before the Graph of Thought and
     injects `<SUBSTRATE_BRIEF>`; it fails open within 1.5 s.
  5. `ultrathink-kickoff` calls `graph.register` after creating rows.
  6. Cursor `hooks.json` has substrate commands **appended** to the GSD-managed arrays, not
     replacing them; a git post-commit hook emits `commit` events.
  7. Stopping `substrate-mcp` leaves every agent working, just unbriefed.

**Proof**: Edit a file in Cursor, then start Claude Code on the VPS — the uplift echo shows a
brief naming that edit and the open graphs in that repo.
**Plans**: TBD

### Phase 1: Lane B

**Goal**: Hermes, Omp, Muse Code, Grok Build and Grok Bot all read the brief and emit events.
**Depends on**: Phase 0
**Success Criteria**:

  1. **Re-scoped by decision D-01 (CONTEXT.md D1).** Hermes reads the brief and emits events
     through an **additive** `/brief` call and `events_emit` injected into the existing
     `on_pre_llm_call` path without restructuring it. The original wording — "Hermes redesign
     per its own `.planning/PROJECT.md`: the Python `pre_llm_call` hook calls the TypeScript
     engine" — cites a shipped v0.3.0 milestone that does not contain that redesign; the real
     TypeScript-engine bridge belongs to the "Ultrathink on Hermes" v1.0 milestone. Lane B does
     not build it and must not claim it.
  2. **Re-scoped by D-01.** Hermes Kanban retirement is **deferred** to that same milestone;
     Lane B asserts only that `hermes_kanban_create` behaviour is *unchanged*.
     `hermes-linear-connector` keeps its Linear→Hermes dispatch, comment mirroring and DoD gate,
     untouched; eng-board auto-ingest additionally points at `events_emit`.
  3. **Settled by D-02.** herdr is the Lane B persistent runtime, already installed and verified
     live (0.9.1); Orca stays alongside as the IDE surface and a collector. This phase stands up
     the herdr `events.subscribe` collector against the corrected 0.9.1 wire contract.
  4. `omp-ultrathink` adds `memory.brief` to its discovery tools; Grok Build's `ultrathink`
     `UserPromptSubmit` hook fetches `/brief` and delivers it via a session file plus a rules
     entry, since Grok Build discards hook stdout; Muse falls back to `.substrate/BRIEF.md`.
  5. `grok-hermes-connector` v0.4 forwards `memory_brief`, `memory_write`, `events_emit`,
     `graph_get`; `handoff_to_hermes` records a `handoff` event with its Graph ID.
**Proof**: Hermes finishes node n2 from a Grok Bot handoff; Omp's next prompt in that repo
lists both the handoff and the claim.
**Plans**: 10/10 plans executed

Plans:

- [x] 01-10-PLAN.md

- [x] 01-01-PLAN.md — Wave 0 rollback safety baseline: git baselines, live-file snapshots, measured test baselines (D-04)
- [x] 01-02-PLAN.md — Phase tracer: Hermes reads the brief and emits one event, additively and fail-open (D-01)
- [x] 01-03-PLAN.md — eng-board auto-ingest forwards session start, tool calls and finalize to `events_emit`
- [x] 01-04-PLAN.md — herdr socket collector: per-pane subscriptions, race-free bootstrap, systemd unit (D-02)
- [x] 01-05-PLAN.md — grok-hermes-connector v0.4: four substrate tools and a Graph ID on `handoff_to_hermes`
- [x] 01-06-PLAN.md — Muse: `.substrate/BRIEF.md` writer, AGENTS.md pointer, PostToolUse event hook
- [x] 01-07-PLAN.md — Omp: substrate-mcp registered as a second MCP endpoint, `memory_brief` in discovery
- [x] 01-08-PLAN.md — Grok Build: brief fetched on UserPromptSubmit, delivered by session file plus rules entry
- [x] 01-09-PLAN.md — Cross-surface proof, full regression sweep, and the STATE.md correction

### Phase 2: Claims and dispatch

**Goal**: Labelling a Linear issue for an agent starts that agent on that node.
**Depends on**: Phase 1
**Success Criteria**:

  1. `graph.claim` moves the Linear issue to `started`, adds `agent:<surface>`, posts a
     one-line comment with the session id, sets `Agent` on the Notion Issue row, and writes
     `claimed_by` in the index. A second agent asking for the same node gets the existing claim.
  2. `graph.release` and `graph.complete` mirror `ultrathink-sync`'s state table; completion
     still passes the `hermes-linear-connector` Definition-of-Done gate.
  3. `substrate-dispatcher` watches `dispatch:<surface>` on unstarted issues and starts a
     session for that Graph ID in a per-Graph-ID worktree; the label is removed and
     `agent:<surface>` added when the claim lands.
**Proof**: Label a real issue `dispatch:hermes` — a Hermes session starts, claims the node, the
Notion Issue row shows Agent hermes, and Claude Code's brief shows it within a minute.
**Plans**: 9/9 plans executed

Plans:
**Wave 1**

- [x] 02-01-PLAN.md — Claim tracer: graph_claim → index → Linear mirror (In Progress, agent:<surface>, dispatch:* removed, session comment), D-02/D-04, graph_find, measured baseline
- [x] 02-03-PLAN.md — hermes-linear-connector POST /v1/complete-issue: Done only through the existing DoD gate (D-06)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 02-04-PLAN.md — Dispatcher package: Linear/MCP clients, D-12 worktree, D-13 launcher (fixed-template prompt, scrubbed env)
- [x] 02-05-PLAN.md — graph_release/graph_complete: ownership check, Linear Todo/In Review, DodGate client, release/complete event kinds (D-05..D-08)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 02-02-PLAN.md — Owner adds NOTION_API_KEY (human-action) and the Agent Task Graph schema is read, or notion_skipped is pinned
- [x] 02-09-PLAN.md — Live dispatch tracer: label → tick → worktree → Hermes → claim, latency measured; decision table and dry-run CLI

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 02-06-PLAN.md — Notion half of the mirror: Agent on claim/release; Status, Linear State, Completed on complete (never PR fields, D-07)
- [x] 02-07-PLAN.md — Supervised 30 s loop, D-14 session registry and claim watch, lock, systemd unit started disabled (D-15)

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 02-08-PLAN.md — Phase proof on a new throwaway issue and graph (D-16), timed, closed through the DoD gate, owner confirms

### Phase 3: Lane A

**Goal**: Sandboxed, durable Claude Code sessions, one VM per Graph ID.
**Depends on**: Phase 2
**Success Criteria**:

  1. Free disk verified before pulling images (host is at 90%).
  2. rivet-agentos host runs; `openTask` writes shared skills, `SUBSTRATE_BRIEF.md` and the
     substrate/notion/linear MCP config into `/home/agentos`.
  3. The dispatcher routes `dispatch:claude-code` to a VM; `permissionPolicy: "ask"` surfaces
     approvals to Telegram through the existing stop-notify path.
  4. `claude-ultrathink` runs inside the VM, so kickoff and sync still write Notion and Linear.

**Proof**: A labelled issue opens a VM, the session survives a host restart, the PR lands and
`ultrathink-sync` closes the loop.
**Plans**: 9/10 plans executed (03-10 blocked: owner keeps Telegram approvals off, 2026-09-26)

Plans:
**Wave 1**

- [x] 03-01-PLAN.md — D-09 spike: baselines, D-03/D-04 gates, owner verify of the rivet packages, install into packages/host, 127.0.0.1 sandbox provider and local image, probes (a) loopback/model, (b) adapter loading, (c) git, durability → 03-01-SPIKE.md route_choice / tracker_route / tests_route

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 03-02-PLAN.md — WR-05/D-15: issue_get MCP tool and POST /issue (redacted, untrusted), Hermes prompt issue_get and release-and-stop steps, D-16 root-trust note beside CHILD_ENV_ALLOW

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 03-03-PLAN.md — Host tracer: substrate-host unit (D-05); POST /tasks claims, briefs, seeds and opens the VM session to a first model event

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 03-04-PLAN.md — Seed/prompt/VM policy tests; substrate/notion/linear MCP entries on every route via the loopback tracker proxy (live on vm_mcp, inert on host); tests route; VM-side issue_get

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 03-05-PLAN.md — Dispatch tracer: dispatcher RemoteTask handle routes dispatch:claude-code to the host; a dispatcher restart keeps the VM task (D-05, D-06)

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 03-06-PLAN.md — D-07 resume on boot and live restart survival; containment audit (D-08 storage scan, D-01 container shape, D-12 egress, D-04)

**Wave 7** *(blocked on Wave 6 completion)*

- [x] 03-07-PLAN.md — Commit/push/PR host functions per the spike's git route; sync by tracker route with a host backstop (D-10)

**Wave 8** *(blocked on Wave 7 completion)*

- [x] 03-08-PLAN.md — D-13 Telegram approvals: owner's new bot (human-action), Approve/Deny only, authorised callbacks, respondPermission *(closed partial: owner skipped the bot; approvals off)*

**Wave 9** *(blocked on Wave 8 completion)*

- [x] 03-09-PLAN.md — Proof setup: "PR lands" decision, D-14 archives recorded in 02-LINEAR-ARCHIVED.md, fresh issue, Notion rows, new graph, dispatch label created but not applied

**Wave 10** *(blocked on Wave 9 completion)*

- [ ] 03-10-PLAN.md — Proof run: trap-closed dispatch window, VM via the dispatcher, host restart under a waiting turn, Telegram approvals, PR, sync, completion through the DoD gate, dispatch off *(deferred: needs an approval route)*

**Cross-cutting constraints:**

- Root suite and tsc are two-sided green against 03-BASELINE.md with more passes than agent-substrate-pass

### Phase 4: Skills

**Goal**: One git-backed library every agent reads; the three existing miners propose into it.
**Depends on**: Phase 1
**Success Criteria**:

  1. `/root/agent-skills` is a git checkout of `swcstudiospace/agent-skills` with the **real
     content vendored** — all 26 symlinks dereferenced, no dangling links for any agent.
  2. The docs-scraper pipeline publishes into the repo instead of its own exports dir.
  3. Projection per agent: Claude Code and Grok Build symlinks, Hermes
     `skills.external_dirs`, Omp, Muse, Cursor `.agents/skills`, and rivet-agentos VM writes.
  4. Hermes `/learn`, Omp's skill creator and Grok Build `/autolearn` all call
     `skills.propose`, which opens a branch and PR rather than publishing live.
  5. Hermes runs hourly as primary miner; `skills.write_approval` and `memory.write_approval`
     are on.
**Proof**: A skill mined from a Cursor session is merged and appears in Claude Code and Grok
Build without either being touched.
**Plans**: 0/12 plans executed (plan-check passed after 3 iterations: `phases/04-skills/04-CHECK.md`)

Plans:
**Wave 0**

- [ ] 04-01-PLAN.md — Baselines (bun, tsc, dispatcher, skill-autonomy) and live inventory in 04-BASELINE.md; phase4-baseline rollback area with RESTORE.md; skill-autonomy git baseline tracking every pre-Phase-4 file; docs-scraper path-scoped baseline; rivet nested read-only mount spike → mount_route

**Wave 1** *(blocked on Wave 0 completion)*

- [ ] 04-02-PLAN.md — Skill-content redactor (D-18) and raw scan report, owner human-verify of the scan; private swcstudiospace/agent-skills created in-plan, vendored push, mirror.git, snapshot and clone-then-rename swap of /root/agent-skills

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 04-03-PLAN.md — Tracer, near half: propose core (validate, redact, overlay on main, ledger idempotence, declined/--reopen), propose-auth VM-guest guard, CLI `skills propose --dir`, `skills_propose` tool and `POST /skills/propose`, `skill.propose` kind and docs-scraper surface

**Wave 3** *(blocked on Wave 2 completion)*

- [ ] 04-04-PLAN.md — Tracer, far half: sync timer and Claude/Grok projection; owner merges the tracer PR and it reaches both agents on the timer alone

**Wave 4** *(blocked on Wave 3 completion)*

- [ ] 04-05-PLAN.md — Projection fan-out: Cursor ~/.agents/skills, Muse ~/.config/muse/skills, OpenClaw repoint, Grok identical copies backed up and linked, D-20 flag files
- [ ] 04-06-PLAN.md — rivet VMs get the library read-only per new VM (D-08), with the onVmStart copy fallback; Phase-3 seed tests untouched; live VM check
- [ ] 04-07-PLAN.md — Hermes: write_approval ×2 before external_dirs, shadowing links removed, anda moved; packages/miner bridge + queue drain + cron precheck; hourly substrate-skill-miner job; gate-staged write → PR
- [ ] 04-08-PLAN.md — Omp: standalone tool_call extension (D-17) blocks manage_skill/learn writes and proposes; customDirectories and autolearn.enabled; live Omp session blocked with a PR URL
- [ ] 04-09-PLAN.md — Grok skill-autonomy: write_skill, /autolearn and Stop-hook live learning propose (pending when down); rule updated; plugin reinstalled; live propose
- [ ] 04-10-PLAN.md — docs-scraper publishes via `substrate skills propose --dir --surface docs-scraper --allow-doc-examples pem,jwt`; symlinks and README rewrite removed; its skill update proposed from a scratch copy
- [ ] 04-11-PLAN.md — Cursor stop hook reads the envelope, keeps a redacted transcript copy for the miner and emits session.end with its ref; hooks.json projected

**Wave 5** *(blocked on Wave 4 completion)*

- [ ] 04-12-PLAN.md — Proof: owner Cursor session (D-20 menu check) → Hermes miner → bridge PR → owner merge → Claude Code and Grok Build list it with neither touched

**Cross-cutting constraints:**

- Root suite and tsc are two-sided green against 04-BASELINE.md; every live edit outside the repo is snapshotted under /var/lib/substrate/phase4-baseline/ with a RESTORE.d route first
- Commit messages carry `Refs SPE-2734` and `Refs SPE-3576`; stage by explicit path only

### Phase 5: Docs and desktop

**Goal**: Product docs and GUI tasks reachable from any agent.
**Depends on**: Phase 0
**Success Criteria**:

  1. `docs.search` proxies the existing RAGFlow MCP endpoint (`ragflow_retrieval`).
  2. `docs.ingest` runs the redactor before ingesting.
  3. `desktop.run` drives cua on the Docker path or the existing `recruitment-desktop` webtop.
     No QEMU path — this host has no `/dev/kvm`.
**Proof**: An agent answers a docs question with a citation; a GUI smoke test runs in a sandbox.
**Plans**: TBD

### Phase 6: Ledger

**Goal**: Tamper-evident history.
**Depends on**: Phase 1
**Success Criteria**:

  1. **Re-scoped by D-01 (06-CONTEXT.md, owner-approved 2026-09-26).** Every event is hashed on
     ingest over the canonical event JSON and carries `prev`. The original wording — "Every collector
     computes `hash` over the canonical event JSON and carries `prev`" — is kept for the record.
  2. An hourly systemd timer Merkle-roots the hour's events into a Solana **devnet** memo and
     records root, signature and event count in an `anchors` table.
  3. `substrate verify <graph_id>` recomputes the chain and checks roots against signatures.

**Proof**: Alter one event row — `verify` flags the graph.
**Plans**: 0/9 plans executed (plan-check passed: `phases/06-ledger/06-CHECK.md`)

Plans:
**Wave 0**

- [ ] 06-01-PLAN.md — Phase-order gate (Phases 4 and 5 landed: VERIFICATION status re-read, symbols present); baselines (bun, tsc, dispatcher, live Greptime/Solana, baseline-ok graphs) in 06-BASELINE.md; phase6-baseline rollback area with RESTORE.md and verbatim DDL; pre-cutover row fixture; Greptime scratch-table spike

**Wave 1** *(blocked on Wave 0 completion)*

- [ ] 06-02-PLAN.md — Ledger core: RFC 6962 Merkle (8 reference roots), memo v1 and all memo program IDs, half-open ingest hours, Solana CLI argv/runner, devnet JSON-RPC reader
- [ ] 06-03-PLAN.md — Dedicated devnet key and guarded substrate.env lines (D-04), airdrop (owner asked only through a funded-key precondition when refused, D-05), send-once 0-lamport devnet memo spike (D-06)

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 06-04-PLAN.md — Global ingest chain code: ingested_at in the hash (absent on old rows, fixture-pinned), guarded Greptime migrate, IngestChain with one multi-row INSERT per turn and the client-ts guard, verify pre/post split; lastHash/insertEvent removed everywhere

**Wave 3** *(blocked on Wave 2 completion)*

- [ ] 06-05-PLAN.md — Cutover: guarded DDL under the old code (early-cutover branch), substrate-mcp restart, cutover event recorded (D-03), live chain/latency/collision smoke, historical graphs still verify

**Wave 4** *(blocked on Wave 3 completion)*

- [ ] 06-06-PLAN.md — Tracer: hour digest over recomputed leaves, anchors store, `ledger anchor` (5 min lag, watermark, adopt-not-re-anchor) anchors the cutover and smoke hours on devnet, proves the CLI output shape on a real send, reads them back; re-run is a no-op

**Wave 5** *(blocked on Wave 4 completion)*

- [ ] 06-08-PLAN.md — substrate-ledger-anchor.{service,timer} (OnCalendar=hourly, Persistent=true), guarded install, first timer tick and dead-RPC failure path

**Wave 6** *(blocked on Wave 5 completion)*

- [ ] 06-07-PLAN.md — `substrate verify` checks every hour's signer-checked devnet memo (pending ≤ 3 h, fail closed as unverified), CLI verify timeout and per-hour lines; live anchored/pending/unverified

**Wave 7** *(blocked on Wave 6 completion)*

- [ ] 06-09-PLAN.md — Proof (D-12): throwaway graph anchored by the timer; tamper (a) stale hash and (b) recomputed hash both flagged by verify; originals restored byte-equal and re-verified

**Cross-cutting constraints:**

- Root suite and tsc are two-sided green against 06-BASELINE.md; every live edit outside the repo is snapshotted under /var/lib/substrate/phase6-baseline/ with a RESTORE.d route first
- Commit messages carry `Refs SPE-3576`; stage by explicit path only; runs after Phases 4 and 5 (gated in 06-01), so the shared mcp-server and cli files are edited additively
