# Roadmap: Agent Substrate

## Milestones

- ⚠️ **v1.0 build plan (phases 0-6 + 0.5)** — closed 2026-10-01 with known gaps. Archive: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md) · audit: [milestones/v1.0-MILESTONE-AUDIT.md](milestones/v1.0-MILESTONE-AUDIT.md)
- ✅ **v1.1 Swarm correlation, governed memory and orchestrate integrations** — Phases 7-10 with inserted 8.1, shipped 2026-10-07 (ADR 0001 S1 and S3). Archive: [milestones/v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md)
- ✅ **v1.2 Swarm leases, workspace install and lessons bank** — Phases 11-15, shipped 2026-10-08 (ADR 0001 S2, S4, SPE-5830). Archive: [milestones/v1.2-ROADMAP.md](milestones/v1.2-ROADMAP.md) · audit: [milestones/v1.2-MILESTONE-AUDIT.md](milestones/v1.2-MILESTONE-AUDIT.md)
- 🚧 **v1.3 Build plan completion** — Phases 16–33, in progress. Tracking: [SPE-8292](https://linear.app/swcstudio/issue/SPE-8292/n7-final-ordered-execution-plan-in-waves)

## Phases

<details>
<summary>⚠️ v1.0 build plan (Phases 0-6, with 0.5) — CLOSED 2026-10-01 with known gaps</summary>

- [x] Phase 0: Brief — complete and live
- Phase 0.5: Governance — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 1: Lane B — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 2: Claims and dispatch — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 3: Lane A — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 4: Skills — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 5: Docs and desktop — closed in archive; see [MILESTONES.md](MILESTONES.md)
- Phase 6: Ledger — closed in archive; see [MILESTONES.md](MILESTONES.md)

Phase details: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md) · audit: [milestones/v1.0-MILESTONE-AUDIT.md](milestones/v1.0-MILESTONE-AUDIT.md) · phase folders: `milestones/v1.0-phases/`

</details>

<details>
<summary>✅ v1.1 Swarm correlation, governed memory and orchestrate integrations (Phases 7-10, with 8.1) — SHIPPED 2026-10-07</summary>

- [x] Phase 7: Database structures (1/1 plans) — completed 2026-10-07
- [x] Phase 8: Memory structures (1/1 plans) — completed 2026-10-07
- [x] Phase 8.1: Version conflicts carry the standing version (INSERTED) (1/1 plans) — completed 2026-10-07
- [x] Phase 9: claude-ultrathink integration (1/1 plans) — completed 2026-10-07
- [x] Phase 10: Swarm orchestrate integration (1/1 plans) — completed 2026-10-07

Phase details: [milestones/v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md) · requirements: [milestones/v1.1-REQUIREMENTS.md](milestones/v1.1-REQUIREMENTS.md) · audit: [milestones/v1.1-MILESTONE-AUDIT.md](milestones/v1.1-MILESTONE-AUDIT.md) · phase folders: `milestones/v1.1-phases/`

</details>

<details>
<summary>✅ v1.2 Swarm leases, workspace install and lessons bank (Phases 11-15) — SHIPPED 2026-10-08</summary>

- [x] Phase 11: Lease authority (1/1 plans) — completed 2026-10-07
- [x] Phase 12: Swarm lease bridge (1/1 plans) — completed 2026-10-07
- [x] Phase 13: Signed handoffs (1/1 plans) — completed 2026-10-07
- [x] Phase 14: Workspace install (1/1 plans) — completed 2026-10-07
- [x] Phase 15: Lessons bank (1/1 plans) — completed 2026-10-07

Phase details: [milestones/v1.2-ROADMAP.md](milestones/v1.2-ROADMAP.md) · requirements: [milestones/v1.2-REQUIREMENTS.md](milestones/v1.2-REQUIREMENTS.md) · audit: [milestones/v1.2-MILESTONE-AUDIT.md](milestones/v1.2-MILESTONE-AUDIT.md) · phase folders: `milestones/v1.2-phases/`

</details>

### 🚧 v1.3 Build plan completion (In Progress)

**Milestone Goal:** Land on `main` everything the Notion build plan still lacks, each part ending in a proof run for real: Linear-driven dispatch with mirrored claims, the docs and memory planes, the hourly Solana devnet anchor, the skills library with propose-only miners and Agent Cards, `desktop_run`, the Lane A host, and the deferred Phase 0 UAT.

Each phase ships as one pull request. Critical path: 16 → 18 → 19 → 20 → 23 → 24 → 31 → 32 → 33. Side chains: 18 → 21 → 22 → 25 → 26 (skills, then docs and memory); 18 → 27 → 28 → 29 (ledger, then Agent Cards, which also need 21); 17 and 18 → 30 (`desktop_run`, floating).

- [x] **Phase 16: Production parity and rehearsal harness** - Production `substrate-mcp` serves `main`, and an isolated twin exists for every later proof (completed 2026-10-08)
- [ ] **Phase 17: Event vocabulary and audit policy** - Every v1.3 event source is mapped onto the existing kinds and surfaces before any of them ships
- [ ] **Phase 18: Guard rails and shared redactor** - One redactor, carrying the September rules and main's counter exemption, guards every publication path
- [ ] **Phase 19: Lane B collectors** - herdr, Muse and the Cursor `stop` hook emit from `main` under main's vocabulary, and each Muse repo carries a fresh brief
- [ ] **Phase 20: Production identity and Phase 0 UAT** - Every production client holds its own token, and the eight Phase 0 scenarios pass against `main`
- [ ] **Phase 21: skills_propose** - An authenticated surface can propose a skill as a PR on agent-skills, with secrets and duplicates refused
- [ ] **Phase 22: Skills sync, bridge and miners** - Mined skills reach every agent through propose, owner merge and sync, all from code on `main`
- [ ] **Phase 23: Claim mirror and DoD gate** - Linear and Notion follow every lease transition, and only the Definition-of-Done gate can mark an issue Done
- [ ] **Phase 24: substrate-dispatcher** - A `dispatch:hermes` label starts a lease-correct Hermes session on the issue's Graph ID in its own worktree
- [ ] **Phase 25: Docs search and ingest (RAGFlow)** - Agents get cited docs answers through the substrate, and ingest refuses secrets and unsourced pages
- [ ] **Phase 26: Hindsight recall and Dragonfly cache** - Accepted memories are recalled across surfaces and repeated reads are cached, without slowing or staling the brief
- [ ] **Phase 27: Ledger primitives and ingest order** - Every closed hour has one deterministic Merkle root over its events in server ingest order
- [ ] **Phase 28: Hourly anchor job and verify** - Each closed hour is anchored once on Solana devnet, and `verify` checks a graph against those anchors
- [ ] **Phase 29: Agent Cards and teachable moments** - Each surface publishes a valid A2A Agent Card listing its accepted teachables, which sit inside anchored hours
- [ ] **Phase 30: desktop_run** - Authenticated agents drive the dedicated webtop through a closed, audited vocabulary
- [ ] **Phase 31: Lane A runtime: spike, packaging and VM host** - `substrate-host` runs from `main` with one agentos VM per Graph ID, inside the host's disk and port limits
- [ ] **Phase 32: Lane A host core** - A host task works its node under the `claude-code` lease, survives a restart and keeps credentials on the host
- [ ] **Phase 33: Lane A dispatch route and approvals** - `dispatch:claude-code` takes an issue to a gated Done through a Lane A VM, with human approval of permissions

## Phase Details

### Phase 16: Production parity and rehearsal harness

**Goal**: Production `substrate-mcp` serves the code on `main`, and every later proof has an isolated twin of it to rehearse against before anything live runs.
**Depends on**: Nothing (first v1.3 phase)
**Repos**: agent-substrate (rehearsal harness, `infra/vps` unit files, runbook)
**Requirements**: [FOUND-01, FOUND-03]
**Success Criteria** (what must be TRUE):

  1. One command starts main's `substrate-mcp` on a scratch port against scratch Postgres and GreptimeDB with configurable surface tokens, and one command tears it down.
  2. With `SUBSTRATE_URL` pointed at the harness, a brief, an emit and a claim succeed, and the production stores receive no row from the run.
  3. After the operator's approved window, the PID of `substrate-mcp.service` owns `127.0.0.1:7410`, the unit has stopped restarting, and `/healthz` answers from `main`.
  4. A runbook records the parity check (unit PID owns the port, `/healthz` answers) and its rollback, and running the check read-only reproduces criterion 3.

**Proof**: The harness is proven in isolation: start, brief, emit, claim, tear down, with production row counts unchanged. Parity needs the live system: the operator retires the stray process in an approved window (agents do not kill processes), and the check afterwards is read-only (`systemctl`, `ss`, `/healthz`).
**Plans**: TBD
- [x] 16-01-PLAN.md
- [x] 16-02-PLAN.md
- [x] 16-03-PLAN.md
- [x] 16-04-PLAN.md
- [x] 16-05-PLAN.md

### Phase 17: Event vocabulary and audit policy

**Goal**: Every event source v1.3 adds lands on the existing vocabulary, decided and documented once in a reviewed PR, so no later phase adds an event kind; the audit policy records whether each planned tool fails open or closed.
**Depends on**: Phase 16
**Repos**: agent-substrate (`packages/mcp-server`, `packages/audit`, `docs/`)
**Requirements**: [FOUND-02]
**Success Criteria** (what must be TRUE):

  1. A mapping document names, for each new v1.3 event source (herdr, Muse, Cursor `stop`, skills propose, docs ingest, desktop actions, anchoring, teachables), the existing kind and the surface it uses; host jobs (anchor, skills sync, dispatcher) use the one added system surface `substrate`.
  2. `EVENT_KINDS` is identical to its v1.2 value, `SURFACES` equals the v1.2 list plus `substrate` only, and against the Phase 16 harness one sample event per mapped source is stored with zero refusals.
  3. A phase-close check runs `packages/mcp-server/src/store-lock.test.ts` and diffs `EVENT_KINDS` against v1.2, and it passes on this phase and is part of every later phase's verification.
  4. `packages/audit/src/policy.ts` records fail-open or fail-closed for every MCP tool v1.3 plans to add (`skills_propose`, `docs_search`, `docs_ingest`, `graph_find`, `issue_get`, `desktop_run` and any recall tool), and a policy test fails when a planned tool has no entry or has the opposite decision.

**Proof**: Isolated, against the Phase 16 harness: the sample emits and the phase-close check. No live system.
**Plans**: TBD
- [x] 17-01-PLAN.md
- [x] 17-02-PLAN.md
- [x] 17-03-PLAN.md

### Phase 18: Guard rails and shared redactor

**Goal**: One redactor protects every v1.3 publication path: the collectors, `docs_ingest`, `skills_propose` and anything anchored all import it, and it keeps main's counter exemption.
**Depends on**: Phase 16
**Repos**: agent-substrate (`packages/mcp-server/src/redact.ts`, store-lock and repo checks)
**Requirements**: [LANEB-06]
**Success Criteria** (what must be TRUE):

  1. main's `redact.ts` redacts every September D-04 pattern, with one test per rule, and still leaves `COUNTER_KEY` counts such as `input_tokens` unredacted.
  2. The skill-content redaction and scan come from the same module, and a repo check fails when any package redacts through anything other than it, so Phases 19, 21, 25 and 28 inherit the shared redactor.

**Proof**: Isolated: `redact.test.ts` over a fixture corpus with one planted secret per rule, plus the repo check. No live system.
**Plans**: TBD

### Phase 19: Lane B collectors

**Goal**: What herdr panes, Muse and Cursor sessions do on this host reaches the event log under main's vocabulary from code on `main`, and every Muse repo carries a fresh, redacted brief.
**Depends on**: Phase 17, Phase 18
**Repos**: agent-substrate (`packages/collectors`, `packages/projector`, `infra/vps`)
**Requirements**: [LANEB-01, LANEB-02, LANEB-03, LANEB-04, LANEB-05, LANEB-07, SKILL-06]
**Success Criteria** (what must be TRUE):

  1. A herdr pane going working → idle in repo R appears in `events_query(repo=R)` within 10 s as a `note` with `payload.status` and `runtime: herdr`, under the surface herdr detected and R's origin slug; detection and exit appear as `session.start` and `session.end`.
  2. A Muse tool call in R appears as `tool.call` from surface `muse` with repo and branch from git, emitted by a hook that imports the redactor from a stable installed path.
  3. R's `.substrate/BRIEF.md` lists both events on its next 5-minute refresh, `AGENTS.md` keeps exactly one pointer however often the writer runs, and a failed `/brief` fetch leaves the last good file in place.
  4. A stopped substrate never blocks herdr, Muse or Cursor; collectors resume from saved offsets after a restart; refused emits are counted where the operator can see them and are zero in the proof run.
  5. Cursor's `stop` hook, run from `main`, copies a redacted transcript to `/var/lib/substrate/transcripts/cursor` and emits `session.end`.

**Proof** (LANEB-07): Isolated, against the Phase 16 harness with the local herdr and Muse. Restarting the production collector units onto main's code after merge is an operator-approved step, not part of the proof.
**Plans**: TBD

### Phase 20: Production identity and Phase 0 UAT

**Goal**: Every client of production `substrate-mcp` is identified by its own token, and the eight deferred Phase 0 brief scenarios pass against `main` with fresh evidence.
**Depends on**: Phase 19 (the Cursor `stop` hook for scenario 6), Phase 16 (production serving `main`)
**Repos**: agent-substrate (UAT script, identity runbook), claude-ultrathink (`ultrathink-kickoff` `graph_register`); `/etc/substrate/substrate.env` is edited by the operator, by name only
**Requirements**: [FOUND-04, UAT-01, UAT-02, UAT-03, UAT-04]
**Success Criteria** (what must be TRUE):

  1. A runbook lists every client of `substrate-mcp` with the token it needs; per-surface tokens, the operator token, `SUBSTRATE_HANDOFF_KEY` and `SUBSTRATE_AUDIT_PATH` exist by name in `/etc/substrate/substrate.env` with no value in the repo, and no listed client is left without a token at switch-on.
  2. A repeatable UAT script runs all eight scenarios from `milestones/v1.0-phases/00-brief/0-UAT.md` against any `SUBSTRATE_URL`, with expectations updated to today's surface, and records pass or fail with evidence per scenario.
  3. Scenario 5 passes: Claude Code's `substrate` MCP entry names its token variable, and `ultrathink-kickoff` registers each new graph through `graph_register`.
  4. Scenario 6 passes: the Cursor hooks, including `stop`, and the git post-commit collector are installed and emit live.

**Proof**: Needs the live system in an operator-approved window: token switch-on and scenarios 2, 3, 5 and 6 run against production. Scenarios 1, 4, 7 and 8 run on the Phase 16 harness; scenario 7 (outage) uses a scratch instance and never stops production.
**Plans**: TBD

### Phase 21: skills_propose

**Goal**: Any authenticated surface can propose a skill and get a reviewable PR on `swcstudiospace/agent-skills`, and nothing secret, malformed or duplicate gets through.
**Depends on**: Phase 17, Phase 18
**Repos**: agent-substrate (`packages/mcp-server` skills, `packages/cli`)
**Requirements**: [SKILL-01]
**Success Criteria** (what must be TRUE):

  1. `skills_propose` over MCP, `POST /skills/propose` and `substrate skills propose` accept a valid skill from a token-authenticated surface and open branch `skill/<surface>/<name>-<ts>-<hex>` with a PR through `gh`, after checking the origin and without force-pushing.
  2. A bad name, path or frontmatter is refused, a planted secret is refused after redaction and scan, and identical content resubmitted answers `existing`, `declined` or `unchanged` instead of opening a second PR.
  3. An anonymous call is refused, and the tool is registered in `mcp.ts`, `observe.ts` and the audit policy.

**Proof**: Isolated, against the Phase 16 harness with an injected runner and a throwaway repository. The first real PR on agent-skills is Phase 22's live proof.
**Plans**: TBD

### Phase 22: Skills sync, bridge and miners

**Goal**: A skill mined anywhere on the host becomes a PR, never a direct publish, and once the owner merges it every agent sees it within one sync tick, all from code on `main`.
**Depends on**: Phase 21 (the route before its clients), Phase 19 (Cursor transcripts), Phase 20 (production identity)
**Repos**: agent-substrate (`packages/projector`, `packages/miner`, `infra/vps`), agent-skills (dirty-tree fix); Hermes cron and skill-autonomy configuration on the host
**Requirements**: [SKILL-02, SKILL-03, SKILL-04, SKILL-05, SKILL-07]
**Success Criteria** (what must be TRUE):

  1. `substrate-skills-sync`, run from `main`, fast-forwards `/root/agent-skills` and projects symlinks for Claude Code, Grok Build, `.agents` (Cursor), Muse and the OpenClaw roots with backup and restore; a dirty, off-branch or diverged checkout is refused with a `warning` event.
  2. The Hermes bridge, every 5 minutes, drains `~/.hermes/pending/skills` and the Omp and Grok queues into `skills_propose` after 120 s of quiet and deletes a queued record only on a final reply.
  3. No miner publishes directly: skill-autonomy posts to `/skills/propose` (or stages), the Omp extension intercepts `manage_skill` and `learn`, and Hermes `skill_manage` output goes pending → bridge.
  4. The hourly Hermes miner runs main's code, skips the model run on an unchanged hour, proposes at most 3 skills, and leaves `skills.write_approval` and `memory.write_approval` true.
  5. A skill mined from a Cursor session is proposed as a PR, merged by the owner, and within one sync tick (≤ 5 min) appears in Claude Code and Grok Build with neither agent's config changed; both timers and the cron run green.

**Proof** (SKILL-07): Live, operator-approved: GitHub, the owner's merge, Hermes model quota, a real Cursor session and the production timers.
**Plans**: TBD

### Phase 23: Claim mirror and DoD gate

**Goal**: Linear and Notion show who holds each node as its lease changes, the lease stays authoritative when a tracker fails, and only the Definition-of-Done gate can mark an issue Done.
**Depends on**: Phase 17, Phase 20 (production identity for attributed claims)
**Repos**: agent-substrate (`packages/mcp-server`)
**Requirements**: [MIRROR-01, MIRROR-02, MIRROR-03, MIRROR-04, MIRROR-05, MIRROR-06, MIRROR-07, MIRROR-08]
**Success Criteria** (what must be TRUE):

  1. A granted or reclaimed lease moves the Linear issue to its team's first `started` state, adds `agent:<surface>` and removes every `dispatch:*` in one update, posts one `Claimed by …` comment per session and sets the Notion `Agent`; a steal moves the label; a release, reap or forced release returns Linear to `unstarted` and clears `agent:*` and Notion `Agent`; a renewal writes nothing. A `swarm-*` holder's transitions only post the comment and never change state, labels or the Notion row, and a test pins that exception.
  2. `graph_complete` with `dod` puts the node in `started_review` and Linear in In Review and posts to `{HERMES_LINEAR_URL}/v1/complete-issue`; only the connector moves the issue to Done; on refusal or error the node stays in review with the lease kept.
  3. A failed tracker write never rolls the lease back and yields one `warning` per failed target, a losing claimant writes nothing, startup logs `mirror: linear on|off, notion on|off`, and Notion writes touch only the four allowed properties on `NOTION_TASK_GRAPH_DS` Issue rows, read-then-write.
  4. `graph_find` maps a Linear id or identifier to one node (`found: false` for zero or several), `issue_get` returns redacted, capped, untrusted-marked text, and no reply, comment or tracker field carries a `lease_id`.
  5. On a real Linear issue and its Notion row, a claim, a second surface's refused claim, a release, a complete without DoD and a complete with DoD each produce exactly the tracker state above within 60 s.

**Proof** (MIRROR-08): Rehearsed against the Phase 16 harness first; the proof itself needs the live system in an operator-approved window: Linear, Notion, hermes-linear-connector and production surface tokens.
**Plans**: TBD

### Phase 24: substrate-dispatcher

**Goal**: Labelling a Linear issue `dispatch:hermes` starts a lease-correct Hermes session on the issue's Graph ID in its own worktree, and every issue it does not dispatch says why.
**Depends on**: Phase 23
**Repos**: agent-substrate (`packages/dispatcher`, `infra/vps`)
**Requirements**: [DISP-01, DISP-02, DISP-03, DISP-04, DISP-05, DISP-06, DISP-07, DISP-08]
**Success Criteria** (what must be TRUE):

  1. `substrate-dispatcher.service`, run from `main`, reads unstarted `dispatch:*` issues every 30 s under a flock and re-reads `SUBSTRATE_DISPATCH_DISABLED` every tick; every non-dispatch leaves exactly one marker comment naming its outcome.
  2. Each Graph ID gets a worktree at `/var/lib/substrate/worktrees/<graph_id>` on `substrate/<graph_id>`, reused when present, verified by origin URL and refused below 5 GiB free; `hermes` launches headless with an allowlisted environment, `claude-code` goes to the Lane A host, and any other surface gets `not-dispatchable`.
  3. The launched agent claims with its own surface token, heartbeats inside the TTL and completes with its `lease_id` and DoD fields or releases; the dispatcher never claims for it, authenticates its own calls, and never puts issue text in the prompt (the session reads it through `issue_get` as untrusted).
  4. A claim that has not landed after 900 s stops the session (SIGTERM, then SIGKILL); an exit without a claim comments, removes the label and gives the issue up, and the given-up set survives a restart.
  5. In a bounded window, `dispatch:hermes` launches within 30 s, the claim lands under the Hermes token, Linear shows `agent:hermes` and Notion Agent hermes, a Claude Code brief names the claim within 60 s of labelling, the run ends in a gated Done or a release, and the kill switch is back on afterwards.

**Proof** (DISP-08): A `--once --dry-run` rehearsal runs isolated; the proof needs the live system in an operator-approved, bounded kill-switch-off window: Linear, Notion and Hermes model quota.
**Plans**: TBD

### Phase 25: Docs search and ingest (RAGFlow)

**Goal**: Agents answer docs questions from RAGFlow with citations, through the substrate only, and no secret or unsourced page is ingested.
**Depends on**: Phase 18 (redactor), Phase 22 (skills-sync fast-forward drives the agent-skills refresh)
**Repos**: agent-substrate (`packages/mcp-server` RAGFlow client, `packages/cli`, `docs/data-planes.md`)
**Requirements**: [DOCS-01, DOCS-02, DOCS-03]
**Success Criteria** (what must be TRUE):

  1. `docs_search` (MCP and `POST /docs/search`) queries explicit dataset ids and returns at most 10 results, each with title, source URL, heading path, commit, a redacted snippet of at most 1,200 characters, score and ids; the reply is marked untrusted, one event lists the returned URLs, and an error yields an empty result with a reason.
  2. `docs_ingest` (MCP, `POST /docs/ingest`, `substrate docs ingest`) redacts before upload, strips remote images and is idempotent by content hash; it refuses a page without a source URL, outside the configured roots or over the size caps, and any unauthenticated caller.
  3. The datasets `docs/data-planes.md` lists exist and refresh as it says (`agent-substrate` on merge, `agent-skills` after each skills-sync fast-forward, `programming-desk`, one per product), keeping the last five versions.

**Proof**: The refusal and error-path tests run isolated against a fake; search and ingest against the deployed RAGFlow need the live system in an operator-approved window.
**Plans**: TBD

### Phase 26: Hindsight recall and Dragonfly cache

**Goal**: Accepted memories are recallable across surfaces and repeated reads are cached, without either plane slowing the brief, hiding a fresh claim or holding a credential outside `substrate.env`.
**Depends on**: Phase 25
**Repos**: agent-substrate (`packages/mcp-server` Hindsight and Dragonfly clients, runbook)
**Requirements**: [DOCS-04, DOCS-05, DOCS-06, DOCS-07]
**Success Criteria** (what must be TRUE):

  1. Hindsight retains a memory only after the governance gate returns `accepted` with `verified_persisted`, redacted and carrying a `receipt_path` or `source`, into the writer's `sub-<surface>` bank; recall is a tool or derived-marked `memory_search` results and never runs inside the brief's 1.5 s budget.
  2. Dragonfly serves only as a read-through cache, `/healthz` reports `{enabled, connected, hits, misses, bypasses}`, the same answers come back uncached while Dragonfly is down, and a cached brief never hides a claim older than 60 s.
  3. Plane credentials live only in `substrate.env`, a plaintext non-loopback `redis://` Dragonfly URL is refused, and a runbook covers the Tailscale forwarder hop.
  4. A headless session holding only the substrate MCP answers a docs question with a source URL `docs_search` returned and readable back from its event; a memory retained by one surface is recalled by another with its source; a second identical brief is a cache hit, and with Dragonfly down it returns uncached.

**Proof** (DOCS-07): Live, operator-approved: RAGFlow, Hindsight and Dragonfly (once its private hop exists) with a headless session.
**Plans**: TBD

### Phase 27: Ledger primitives and ingest order

**Goal**: Every closed hour has one deterministic Merkle root over its events in server ingest order, computed without changing `agent_events`.
**Depends on**: Phase 18 (store-lock guard rails)
**Repos**: agent-substrate (`packages/ledger`, `packages/mcp-server` Greptime reads)
**Requirements**: [ANCHOR-01, ANCHOR-02]
**Success Criteria** (what must be TRUE):

  1. Which hour an event belongs to, and its position, are decided by server ingest order and recorded append-only; `agent_events` rows and hashes are unchanged, reads go through typed methods, and `store-lock.test.ts` stays green.
  2. A closed hour yields an RFC 6962 Merkle root over its event hashes in ingest order and the memo `substrate:v1:<period_start>:<root>:<count>`, and recomputing the hour gives the same root and memo.

**Proof**: Isolated: unit tests and the Phase 16 harness's scratch GreptimeDB. No live system.
**Plans**: TBD

### Phase 28: Hourly anchor job and verify

**Goal**: Each closed hour is anchored exactly once on Solana devnet, and anyone can check a graph's events against those anchors.
**Depends on**: Phase 27
**Repos**: agent-substrate (`packages/ledger`, `packages/cli`, `packages/mcp-server` `/verify`, `infra/vps`)
**Requirements**: [ANCHOR-03, ANCHOR-04, ANCHOR-05, ANCHOR-06]
**Success Criteria** (what must be TRUE):

  1. An hourly timer (`OnCalendar=hourly`, `Persistent=true`) anchors the previous hour idempotently: a re-run adopts an existing signer-checked memo, and a root mismatch raises an alarm and exits 1.
  2. The anchor is sent through the solana CLI with only the keypair path on the command line, on devnet only, and writes an `anchors` row with all ten fields; the DDL matches the table already live in production.
  3. `substrate verify <graph_id>` and `POST /verify` check the chain and, per hour, compare the recomputed root with the memo read back by `tx_sig`; an hour is `pending` for up to 3 h after it closes and `unverified` when devnet cannot be read.
  4. A closed hour is anchored on devnet with a memo root equal to the recomputed root; altering one event on a scratch ledger makes `verify` exit 1 naming that hour; an untouched graph verifies with every hour anchored; re-running the timer adopts the existing memo.

**Proof** (ANCHOR-06): The tamper test runs on a scratch ledger; the devnet anchor needs the live system in an operator-approved window and a devnet key the operator has funded.
**Plans**: TBD

### Phase 29: Agent Cards and teachable moments

**Goal**: Each agent surface publishes a spec-valid A2A Agent Card whose skills include what it has been taught, and every teachable is covered by the hourly anchor.
**Depends on**: Phase 21 (skill frontmatter), Phase 28 (hourly anchor)
**Repos**: agent-substrate (`packages/mcp-server`)
**Requirements**: [CARD-01, CARD-02, CARD-03, CARD-04]
**Success Criteria** (what must be TRUE):

  1. Each agent surface has an A2A v1.0 Agent Card on loopback at `/.well-known/agent-card.json` that validates against the spec (id, name, description, supported interfaces, capabilities, default modes, `skills[]`).
  2. A teachable moment is a tagged governed `fact` written through `memory_write`, with no new memory kind, and each accepted teachable appears as an entry in its surface's card `skills[]`.
  3. Teachable writes emit events inside the hourly anchor's coverage, and `verify` reports the hour holding a teachable as anchored.
  4. A teachable recorded from a session appears in that surface's Agent Card, and its event sits inside an anchored hour.

**Proof** (CARD-04): Card validation and teachable mapping run isolated; the anchored hour needs a devnet anchor, so the proof runs in an operator-approved window.
**Plans**: TBD

### Phase 30: desktop_run

**Goal**: An authenticated agent can drive the dedicated webtop desktop and see the result, through a closed vocabulary that leaves an audit trail and exposes nothing else on the host.
**Depends on**: Phase 17, Phase 18
**Repos**: agent-substrate (`packages/mcp-server` desktop, `infra/desktop`)
**Requirements**: [DESK-01, DESK-02, DESK-03, DESK-04, DESK-05]
**Success Criteria** (what must be TRUE):

  1. `desktop_run` accepts only click, type, key and screenshot, at most 50 actions, a 1–120 s timeout, a fixed `docker exec` argv and one run at a time; screenshots return as MCP image blocks and are kept at mode 0600 for 200 runs or 7 days.
  2. Each action produces one event under an existing kind, typed text is recorded only as its length and sha256, and no image block enters the audit record.
  3. `desktop_run` serves only surfaces on an operator-maintained allowlist: an unlisted surface holding a valid token, an anonymous caller and a VM guest are each refused, with a test for each, and `desktop_run` is fail-closed in the audit policy.
  4. The lifecycle script runs the container only with ≥ 10 GiB free, `--pull never`, loopback port 6081 behind basic auth, unprivileged and without the Docker socket, and never touches `recruitment-desktop`.
  5. A headless session's `desktop_run` returns a screenshot whose pixels show the typed marker.

**Proof** (DESK-05): Isolated, against the Phase 16 harness and the local `substrate-desktop` container; no production service or store is touched.
**Plans**: TBD

### Phase 31: Lane A runtime: spike, packaging and VM host

**Goal**: `substrate-host` runs from `main` and gives each Graph ID its own agentos VM on this host, within the disk and port limits the host actually has.
**Depends on**: Phase 24
**Repos**: agent-substrate (`packages/host` packaging and VM runtime, `infra/sandbox`, `infra/vps`)
**Requirements**: [LANEA-01, LANEA-05]
**Success Criteria** (what must be TRUE):

  1. `substrate-host.service` serves `POST /tasks` on loopback port 7411 with the rivet engine on loopback, and the engine container already bound to port 6420 keeps running untouched.
  2. Tasks for two Graph IDs run in two separate rivet-agentos VMs, each with a Docker sandbox for native tools.
  3. With less than 10 GiB free, any image build or pull is refused in code before it starts.

**Proof**: Read-only host checks first; installing the host and pulling or building the sandbox image on this host needs the owner's approval and an operator-approved window.
**Plans**: TBD

### Phase 32: Lane A host core

**Goal**: A host task works its node under the `claude-code` lease from start to finish, survives a host restart, and keeps every credential on the host.
**Depends on**: Phase 31, Phase 23 (Linear and Notion clients)
**Repos**: agent-substrate (`packages/host`)
**Requirements**: [LANEA-02, LANEA-03, LANEA-07]
**Success Criteria** (what must be TRUE):

  1. `openTask(graphId)` reads the node, claims it as `claude-code` with that surface's token, keeps the `lease_id` and heartbeats while turns run, seeds the brief, skills and MCP config with a sha256 read-back, opens the session with permission policy "ask", and releases the claim on any failure.
  2. After the host restarts mid-session, a continuation prompt keyed `<graph_id>:<node_id>:resume:<n>` resumes the same work.
  3. The VM holds no tokens; host functions commit and push (never force, never `.substrate-*` files), open the PR and sync PR fields through the substrate's Linear and Notion clients.

**Proof**: Against the Phase 16 harness on an isolated graph with a throwaway repository; the VM session spends Claude Code model quota and Docker capacity on this host, so it runs in an operator-approved window.
**Plans**: TBD

### Phase 33: Lane A dispatch route and approvals

**Goal**: A `dispatch:claude-code` label takes a Linear issue all the way to a gated Done through a Lane A VM, with a human approving each permission request.
**Depends on**: Phase 32, Phase 24
**Repos**: agent-substrate (`packages/dispatcher`, `packages/host`)
**Requirements**: [LANEA-04, LANEA-06, LANEA-08]
**Success Criteria** (what must be TRUE):

  1. The dispatcher routes `dispatch:claude-code` to `POST /tasks`, and a refusal becomes a once-only Linear comment.
  2. Permission requests reach a human through single-use Approve/Deny buttons on the existing Telegram stop-notify path, and an unanswered request times out.
  3. `dispatch:claude-code` on a fresh issue opens a VM that claims and heartbeats; restarting `substrate-host` mid-session resumes the same session; a real push and PR land, the PR fields sync, and the issue reaches a gated Done.

**Proof** (LANEA-08): Live, operator-approved: Linear, Notion, GitHub, the model route, the approvals channel and ≥ 10 GiB free disk.
**Plans**: TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 16. Production parity and rehearsal harness | v1.3 | 5/5 | Complete    | 2026-10-08 |
| 17. Event vocabulary and audit policy | v1.3 | 3/3 | In Progress | - |
| 18. Guard rails and shared redactor | v1.3 | 0/? | Not started | - |
| 19. Lane B collectors | v1.3 | 0/? | Not started | - |
| 20. Production identity and Phase 0 UAT | v1.3 | 0/? | Not started | - |
| 21. skills_propose | v1.3 | 0/? | Not started | - |
| 22. Skills sync, bridge and miners | v1.3 | 0/? | Not started | - |
| 23. Claim mirror and DoD gate | v1.3 | 0/? | Not started | - |
| 24. substrate-dispatcher | v1.3 | 0/? | Not started | - |
| 25. Docs search and ingest (RAGFlow) | v1.3 | 0/? | Not started | - |
| 26. Hindsight recall and Dragonfly cache | v1.3 | 0/? | Not started | - |
| 27. Ledger primitives and ingest order | v1.3 | 0/? | Not started | - |
| 28. Hourly anchor job and verify | v1.3 | 0/? | Not started | - |
| 29. Agent Cards and teachable moments | v1.3 | 0/? | Not started | - |
| 30. desktop_run | v1.3 | 0/? | Not started | - |
| 31. Lane A runtime: spike, packaging and VM host | v1.3 | 0/? | Not started | - |
| 32. Lane A host core | v1.3 | 0/? | Not started | - |
| 33. Lane A dispatch route and approvals | v1.3 | 0/? | Not started | - |
