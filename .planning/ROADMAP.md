# Roadmap: Agent Substrate

## Milestones

- ⚠️ **v1.0 build plan (phases 0-6 + 0.5)** — closed 2026-10-01 with known gaps. Archive: [milestones/v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md) · audit: [milestones/v1.0-MILESTONE-AUDIT.md](milestones/v1.0-MILESTONE-AUDIT.md)
- ✅ **v1.1 Swarm correlation, governed memory and orchestrate integrations** — Phases 7-10 with inserted 8.1, shipped 2026-10-07 (ADR 0001 S1 and S3). Archive: [milestones/v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md)
- ✅ **v1.2 Swarm leases, workspace install and lessons bank** — Phases 11-15, shipped 2026-10-08 (ADR 0001 S2, S4, SPE-5830). Archive: [milestones/v1.2-ROADMAP.md](milestones/v1.2-ROADMAP.md) · audit: [milestones/v1.2-MILESTONE-AUDIT.md](milestones/v1.2-MILESTONE-AUDIT.md)
- ⚠️ **v1.3 Build plan completion** — Phases 16–33; shipped 2026-10-11, closed 2026-10-21 with accepted debt (8 audit rows and 43 operator-gated live proofs). Closeout: [milestones/v1.3-CLOSEOUT.md](milestones/v1.3-CLOSEOUT.md) · tracking: [SPE-8292](https://linear.app/swcstudio/issue/SPE-8292/n7-final-ordered-execution-plan-in-waves)
- ✅ **v1.4 Substrate contract hardening** — Phases 34-36, completed 2026-10-24 (local, not published). Archive: [milestones/v1.4-ROADMAP.md](milestones/v1.4-ROADMAP.md) · audit: [milestones/v1.4-MILESTONE-AUDIT.md](milestones/v1.4-MILESTONE-AUDIT.md). Source: [.planning/uplift-7/MILESTONE-AUDIT.md](uplift-7/MILESTONE-AUDIT.md) rows 23-25.
- 🚧 **v1.3.x Should-have hardening** — Phases 37-44, open: 44 passed; 37-43 verified in repo with live proofs pending; 40-43 accepted debt (2026-10-23); 37-39 closed by the operator's live-criteria waiver of 2026-10-25. Audit refreshed 2026-10-28: [v1.3.x-MILESTONE-AUDIT.md](v1.3.x-MILESTONE-AUDIT.md).
- 🚧 **v1.5 SOTA enhancements** — Phases 45-54, open. Phase 46 (verified 2026-10-28, `human_needed`): criterion 1 met in the repository; criterion 3 performed live in naive mode in Run 11 (2026-10-28); criterion 4 NOT met (no parity comparator exists); criterion 5 partial (cutover done, RAGFlow removal operator-gated); criteria 2 and 6 need per-run operator approval; phase 46 is not accepted as debt (operator decision 2026-10-23). Phases 52-54 merged to main (PRs #104 and #134, #136, #135; the drafts #109, #110 and #111 were closed and replaced). 45 and 47-50 accepted debt (2026-10-23); 51 complete (PR #108). Audit: [v1.5-MILESTONE-AUDIT.md](v1.5-MILESTONE-AUDIT.md) (status gaps_found).
- 🚧 **v1.6 Contextual Memory, Live Steering and Eternal Rollback** — Phases 55-62, planned 2026-10-26 (Ultrathink graph ut-mvp59le0-8815e6d1). Built 2026-10-26 and merged to main on 2026-10-28: PR #127 (phases 55 and 56), PRs #128 and #129 (phases 57 and 59-61) and PR #130 (phase 62); phase 58 merged as PR #137 (replaces #131, closed). Gap closure merged 2026-10-28: PR #147 (phase 58 criterion 2, verified passed 5/5), PR #150 (phase 59 criterion 5, verified human_needed 6/6 in the repository, live proofs operator-gated) and PRs #146 and #148 (phase 61: the checkpoint sequence lock, `substrate session hook`, trigger policy, printed host configuration); phase 61 criterion 3 stays partial because no host runs the hook until an operator installs the printed configuration (ADR 0007, D55-4). Live steps (a LightRAG deploy, anchor funding and the anchor timer, any devnet send, production migrations) stay operator-gated. Not marked complete or archived: that is an operator decision. Discovery record: [phases/55-migration-safety/CONTEXT.md](phases/55-migration-safety/CONTEXT.md). Audit: [v1.6-MILESTONE-AUDIT.md](v1.6-MILESTONE-AUDIT.md).

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

### ⚠️ v1.3 Build plan completion (closed with accepted debt, 2026-10-21)

**Milestone Goal:** Land on `main` everything the Notion build plan still lacks, each part ending in a proof run for real: Linear-driven dispatch with mirrored claims, the docs and memory planes, the hourly Solana devnet anchor, the skills library with propose-only miners and Agent Cards, `desktop_run`, the Lane A host, and the deferred Phase 0 UAT.

Each phase ships as one pull request. Critical path: 16 → 18 → 19 → 20 → 23 → 24 → 31 → 32 → 33. Side chains: 18 → 21 → 22 → 25 → 26 (skills, then docs and memory); 18 → 27 → 28 → 29 (ledger, then Agent Cards, which also need 21); 17 and 18 → 30 (`desktop_run`, floating).

- [x] **Phase 16: Production parity and rehearsal harness** - Production `substrate-mcp` serves `main`, and an isolated twin exists for every later proof (completed 2026-10-08)
- [x] **Phase 17: Event vocabulary and audit policy** - Every v1.3 event source is mapped onto the existing kinds and surfaces before any of them ships (completed 2026-10-09)
- [x] **Phase 18: Guard rails and shared redactor** - One redactor, carrying the September rules and main's counter exemption, guards every publication path (completed 2026-10-09)
- [x] **Phase 19: Lane B collectors** - herdr, Muse and the Cursor `stop` hook emit from `main` under main's vocabulary, and each Muse repo carries a fresh brief (completed 2026-10-10)
- [x] **Phase 20: Production identity and Phase 0 UAT** - Every production client holds its own token, and the eight Phase 0 scenarios pass against `main` (completed 2026-10-10; rehearsal-first verified, live window operator-gated)
- [x] **Phase 21: skills_propose** - An authenticated surface can propose a skill as a PR on agent-skills, with secrets and duplicates refused (completed 2026-10-09; re-verified 2026-10-10 at e2ad4dc, 24/24, live PR deferred to Phase 22; re-verified 2026-10-11 at ed696ef, 24/24 stand)
- [x] **Phase 22: Skills sync, bridge and miners** - Mined skills reach every agent through propose, owner merge and sync, all from code on `main` (completed 2026-10-11)
- [x] **Phase 23: Claim mirror and DoD gate** - Linear and Notion follow every lease transition, and only the Definition-of-Done gate can mark an issue Done (completed 2026-10-09 via PR #36; verified 2026-10-10 at 60bd0c1, 30/30, live MIRROR-08 proof operator-gated; re-verified 2026-10-11 at ed696ef, 30/30 stand)
- [x] **Phase 24: substrate-dispatcher** - A `dispatch:hermes` label starts a lease-correct Hermes session on the issue's Graph ID in its own worktree (completed 2026-10-10 via PR #47; verified at 974557d, rehearsal scope green, live DISP-08 tail operator-gated)
- [x] **Phase 25: Docs search and ingest (RAGFlow)** - Agents get cited docs answers through the substrate, and ingest refuses secrets and unsourced pages (completed 2026-10-10 via PR #48; verified at 41cb616, rehearsal scope green, live G1-G4 tail operator-gated)
- [x] **Phase 26: Hindsight recall and Dragonfly cache** - Accepted memories are recalled across surfaces and repeated reads are cached, without slowing or staling the brief (completed 2026-10-10 via PR #49; verified at 059939e, rehearsal scope green, live G1-G4 tail operator-gated)
- [x] **Phase 27: Ledger primitives and ingest order** - Every closed hour has one deterministic Merkle root over its events in server ingest order (completed 2026-10-10 via PR #29; re-verified at 3754c6e, unit scope green, production v1.1.4 acceptance operator-gated; re-verified 2026-10-11 at ed696ef, 18/18 stand)
- [x] **Phase 28: Hourly anchor job and verify** - Each closed hour is anchored once on Solana devnet, and `verify` checks a graph against those anchors (completed 2026-10-09 via PR #35; verified at 35c8f5b, 20/20 must-haves, unit scope green, live L1-L10 tail operator-gated; re-verified 2026-10-11 at ed696ef, 20/20 stand)
- [x] **Phase 29: Agent Cards and teachable moments** - Each surface publishes a valid A2A Agent Card listing its accepted teachables, which sit inside anchored hours (completed 2026-10-11)
- [x] **Phase 30: desktop_run** - Authenticated agents drive the dedicated webtop through a closed, audited vocabulary (completed 2026-10-09 via PR #31; verified at f8af263, 12/12 must-haves, unit scope green, live pixel chain + N1 ladder operator-gated; re-verified 2026-10-11 at ed696ef, 12/12 stand, 30-06 reconciled complete-with-gated-remainder for 7/7)
- [x] **Phase 31: Lane A runtime: spike, packaging and VM host** - `substrate-host` runs from `main` with one agentos VM per Graph ID, inside the host's disk and port limits (completed 2026-10-11)
- [x] **Phase 32: Lane A host core** - A host task works its node under the `claude-code` lease, survives a restart and keeps credentials on the host (completed 2026-10-11)
- [x] **Phase 33: Lane A dispatch route and approvals** - `dispatch:claude-code` takes an issue to a gated Done through a Lane A VM, with human approval of permissions (completed 2026-10-11)

### 🚧 v1.4 Substrate contract hardening (Planned)

- [x] **Phase 34: Invalid-write round trip** - every client-input write surface refuses an invalid payload with zero rows persisted, proven in an isolated namespace.
- [x] **Phase 35: expected_version for skills and docs** - a stale skill or docs write is rejected with the memory contract's error; an absent field keeps today's behavior.
- [x] **Phase 36: Degraded-mode exactly-once replay** - a write carrying an idempotency key applies once across replays; the dependent client's queue is built or recorded as a decision.

### 🚧 v1.3.x Should-have hardening (Planned)

- [x] **Phase 37: LANEB** - graph inference from worktree path. Code in repo. Accepted as debt by the operator on 2026-10-25 (waiver); live criteria open.
- [x] **Phase 38: MIRROR** - mirror graph edges into Linear relations and outcomes into evidence. Code in repo. Accepted as debt by the operator on 2026-10-25 (waiver); live criteria open.
- [x] **Phase 39: DISPATCH** - signed handoff packet and coord drift scan before launch. Code in repo. Accepted as debt by the operator on 2026-10-25 (waiver); live criteria open.
- [x] **Phase 40: DOCS-MEMORY** - memory plane consolidation; D-D1 amends DOCS-04 to allow brief recall (decided 2026-10-21). Code on main (PR #92). Accepted as debt by the operator on 2026-10-23; live restore drill and approval open (D-D3). Criterion 3 is the narrower scope the owner accepted on 2026-10-22.
- [x] **Phase 41: ANCHOR** - anchor evidence and teachables. Code on main (PR #93, commit 3466c508). Accepted as debt by the operator on 2026-10-23; live devnet proof open.
- [x] **Phase 42: SKILL-CARD** - skills_list audit trail and the F-D4 re-ingest item. Code on main (PR #94). Accepted as debt by the operator on 2026-10-23; live host fast-forward open.
- [x] **Phase 43: LANE-A** - sandbox egress allowlist and task re-adoption. Complete (PR #97). Accepted as debt by the operator on 2026-10-23; live egress and restart proof open.
- [x] **Phase 44: UAT** - repeatable UAT script against any SUBSTRATE_URL. Complete (PR #95); verification passed.

### 🚧 v1.5 SOTA enhancements (Planned)

- [x] **Phase 45: Railway Resource Orchestrator** - budget ceiling $50 per month, confirmed 2026-10-21 (uplift-7/BLOCKING-UNKNOWNS.md item 8). Accepted as debt on 2026-10-23; live Railway proof open.
- [ ] **Phase 46: LightRAG hybrid RAG with Hindsight context and the RAGFlow migration** - re-scoped 2026-10-23 by operator decision; the migration waves run inside this phase and are not accepted as debt.
- [x] **Phase 47: GreptimeDB + Dragonfly Predictive Analytics & Cache** - SLO burn forecasting and pattern-based cache pre-warming. Accepted as debt on 2026-10-23; live warm-up proof open.
- [x] **Phase 48: TailscaleDB Secure Unified Proxy Layer** - zero-trust database access through one Tailscale proxy with RBAC, audit and pooling. Accepted as debt on 2026-10-23; live forwarders and cutover open.
- [x] **Phase 49: Hindsight Graph Memory with Greptime Events** - graph-structured Hindsight memory with causal recall. Accepted as debt on 2026-10-23; live ledger proof open.
- [x] **Phase 50: Dragonfly Pub/Sub for Real-time Events** - real-time event propagation and event-driven cache invalidation (event-driven cache invalidation narrowed out of scope by the owner on 2026-10-22, D50-e). Accepted as debt on 2026-10-23; live subscription and wake-up latency open.
- [x] **Phase 51: Enterprise Unified Resource Fabric** - one MCP interface across all six resources, depends on phases 45 and 48
- [x] **Phase 52: GSD-Core planning index and cross-session awareness core** - file-first index, session presence and read-only planning tools (Complete: PR #104 merged 2026-10-27 and PR #134 merged 2026-10-28)
- [x] **Phase 53: Steering, conflict control and checkpoint/resume** - audited steering inbox, conflict events and resumable checkpoints (Complete: PR #136, replaced draft #110, merged 2026-10-28)
- [x] **Phase 54: Planning observability and migration inventory** - phase-transition metrics, session STATES and the Railway migration inventory (Complete: PR #135, replaced draft #111, merged 2026-10-28)

### 🚧 v1.6 Contextual Memory, Live Steering and Eternal Rollback (Merged to main 2026-10-28 as PRs #127-#130 and #137; only phase 61 keeps a partial criterion (3); operator-gated live steps open)

- [x] **Phase 55: Migration safety, session event vocabulary and the v1.6 baseline** - contract-tested index migrations, the checkpoint and rollback ledger vocabulary, and the milestone discovery record. Merged in PR #127 (2026-10-28); criteria 1-5 met in repo; production rehearsal operator-run.
- [x] **Phase 56: LightRAG client contract alignment and storage topology** - the client matches upstream v1.5.x and can never emit a clear-all; the hosting topology is decided. No deploy. Merged in PR #127 (2026-10-28); criteria 1-7 met in repo; a P0 clear-all hazard fixed.
- [x] **Phase 57: Tandem memory, LightRAG with Hindsight, with provenance and forget** - shared join keys, merged cited answers, a forget primitive and a cross-store consistency verifier. Merged in PRs #128 and #129 (2026-10-28); flags default off; two live-only items unverified.
- [x] **Phase 58: Live session steering for multi-day GSD-Core sessions** - durable and delivered directives, multi-day liveness, a GSD position model (depends on phases 52-54, now on main). Merged in PR #137 (replaces #131; 2026-10-28); PR #147 (2026-10-28) merged the one state model for `docs_steering_session` and the steering inbox, which closed criterion 2; VERIFICATION passed, 5 of 5, on main 2026-10-28.
- [x] **Phase 59: Eternal logging, verifiable checkpoint and rollback events on Solana devnet** - Merkle inclusion proofs against the anchored hourly root, signer rotation, devnet reset detection. Roots only. Merged in PRs #128 and #129 (2026-10-28); criterion 5 closed by PR #150 (the guarded, operator-run re-anchor executor and the verifier pointer; nothing was sent to any cluster); VERIFICATION human_needed, 6 of 6 criteria met in the repository; live anchoring, key funding, the timer and any devnet send operator-gated.
- [x] **Phase 60: Eternal Memory Knowledge Nexus** - verifiable, versioned memory records and deterministic capsules, informed by Anda and KIP concepts. Merged in PRs #128 and #129 (2026-10-28); criteria 1-4 met in repo; the `ledger-archive` bucket is operator-gated.
- [ ] **Phase 61: Session rollback to an exact chat moment with file revert** - journaled, verified restore through a CLI, memory supersession and an append-only rollback event (depends on phases 55, 57-59). Merged in PRs #128 and #129 (2026-10-28), with PR #146 (checkpoint sequence lock) and PR #148 (`substrate session hook`, trigger policy, printed host configuration, write-ahead pending journal); criterion 3 still partial: no host installs or fires the hook until an operator installs the printed configuration (ADR 0007, D55-4).
- [x] **Phase 62: Soak, runbooks and v1.6 close** - a simulated multi-day run, runbooks and ADRs, and the milestone audit. Merged in PR #130 (2026-10-28); soak, runbooks, ADRs 0004-0007 and the audit are written; completing the milestone is an operator decision.

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
- [x] 19-01-PLAN.md
- [x] 19-02-PLAN.md
- [x] 19-03-PLAN.md
- [x] 19-04-PLAN.md
- [x] 19-05-PLAN.md

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
- [x] 20-01-PLAN.md
- [x] 20-02-PLAN.md
- [x] 20-03-PLAN.md
- [x] 20-04-PLAN.md
- [x] 20-05-PLAN.md
- [x] 20-06-PLAN.md

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
- [x] 21-01-PLAN.md
- [x] 21-02-PLAN.md
- [x] 21-03-PLAN.md
- [x] 21-04-PLAN.md
- [x] 21-05-PLAN.md
- [x] 21-06-PLAN.md

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
**Plans**: 4/4 plans complete

Plans:
- [x] 22-01-PLAN.md — Port the skills projector and ff-only sync gate with staged sync units
- [x] 22-02-PLAN.md — Port the Hermes bridge and monitor with staged bridge units
- [x] 22-03-PLAN.md — Make all three miners propose-only with gated host rebinds
- [x] 22-04-PLAN.md — Rehearsal smoke for the mined-to-projected loop plus the gated SKILL-07 live tail

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
- [x] 23-01-PLAN.md
- [x] 23-02-PLAN.md
- [x] 23-03-PLAN.md
- [x] 23-04-PLAN.md
- [x] 23-05-PLAN.md
- [x] 23-06-PLAN.md

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
**Plans**: 4/4 plans complete

Plans:
- [x] 24-01-PLAN.md — Port the Linear poll, substrate-mcp client and worktree modules with substrate-bearer identity
- [x] 24-02-PLAN.md — Port launch, watch, route and tick modules with give-up persistence and outcome events
- [x] 24-03-PLAN.md — Port the supervised loop, package the module and stage the unit file
- [x] 24-04-PLAN.md — Rehearsal smoke for the label-to-session loop plus the gated DISP-08 live tail

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
**Plans**: 3/3 plans complete
- [x] 25-01-PLAN.md — Substrate-only RAGFlow retrieval with citation-shaped docs_search (DOCS-01)
- [x] 25-02-PLAN.md — Fail-closed docs_ingest with six refusals plus store-lock extension (DOCS-02)
- [x] 25-03-PLAN.md — Dataset lifecycle plus degradation hook plus G1-G4 gated live map (DOCS-03)

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
**Plans**: 3/3 plans complete
- [x] 26-01-PLAN.md — Substrate-side Hindsight recall with fake banks server plus memory_recall tool (DOCS-04 read half)
- [x] 26-02-PLAN.md — Gate-accepted retain forward plus derived-marked memory_search merge plus credential perimeter (DOCS-04 write half)
- [x] 26-03-PLAN.md — Recall cache coverage plus claims-freshness pin plus redis refusal plus G1-G4 gated live map (DOCS-05, DOCS-06, DOCS-07)

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
**Plans**: 3/3 plans complete
- [x] 29-01-PLAN.md — Teachable write path plus accepted-teachable event plus shared fixture corpus (CARD-02 gate half, CARD-03 emit half)
- [x] 29-02-PLAN.md — Per-surface A2A card builder plus fake spec validator plus loopback route (CARD-01, CARD-02 card half)
- [x] 29-03-PLAN.md — Scratch-ledger anchor-coverage proof plus card e2e plus docs plus G1/G2/G3 gated live map (CARD-03, CARD-04)

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
**Plans**: 30-01 (driver+codec), 30-02 (allowlist+dir), 30-03 (lifecycle script), 30-04 (MCP registration), 30-05 (harness flag), 30-06 (N1 spike, live-gated), 30-07 (smoke+proof+docs)
- [x] 30-01-PLAN.md
- [x] 30-02-PLAN.md
- [x] 30-03-PLAN.md
- [x] 30-04-PLAN.md
- [x] 30-05-PLAN.md
- [x] 30-06-PLAN.md
- [x] 30-07-PLAN.md

### Phase 31: Lane A runtime: spike, packaging and VM host

**Goal**: `substrate-host` runs from `main` and gives each Graph ID its own agentos VM on this host, within the disk and port limits the host actually has.
**Depends on**: Phase 24
**Repos**: agent-substrate (`packages/host` packaging and VM runtime, `infra/sandbox`, `infra/vps`)
**Requirements**: [LANEA-01, LANEA-05]
**Success Criteria** (what must be TRUE):

  1. `substrate-host.service` serves `POST /tasks` on loopback port 7411 with the rivet engine on loopback, and the engine container already bound to port 6420 keeps running untouched.
  2. Tasks for two Graph IDs run in two separate rivet-agentos VMs, each with a Docker sandbox for native tools.
  3. With less than 10 GiB free, any image build or pull is refused in code before it starts.

**Proof**: Read-only host checks first (done in 31-RESEARCH.md: /dev/kvm absent, no vmx/svm, 6420 held by gcs-rivet engine, 7411 free, 120 GiB free, sandbox image absent); installing the host and pulling or building the sandbox image on this host needs the owner's approval and an operator-approved window.
**Plans**: 3/3 plans complete
- [x] 31-01-PLAN.md — Gated no-KVM/engine-share spike runner plus read-only asserts plus 31-SPIKE.md verdict tables (LANEA-01 spike half; G1 npm ci, G2 engine session, G3 VM boot gated)
- [x] 31-02-PLAN.md — Host package port (14 modules + tests), substrate.ts bearer/lease rewrite, package.json + lock with declared claude-code dep, sandbox Dockerfile (LANEA-01 packaging half; install-free)
- [x] 31-03-PLAN.md — main.ts checkout fix, 10 GiB in-code disk gate, staged unit file, two-VM fake rehearsal proof, runbook + gated G1-G4 live map (LANEA-01, LANEA-05)

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
- [x] 32-01-PLAN.md
- [x] 32-02-PLAN.md
- [x] 32-03-PLAN.md

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
**Plans**: 3/3 plans complete
- [x] 33-01-PLAN.md — claude-code route rehearsal: fake-host tick to landed claim plus refusal and give-up paths (LANEA-04)
- [x] 33-02-PLAN.md — Approval timeout plus single-use button rehearsal with fake transport (LANEA-06)
- [x] 33-03-PLAN.md — Fake label-to-Done chain plus docs plus G1-G5 gated tail (LANEA-08)

### Phase 34: Invalid-write round trip

**Goal**: Every client-input write surface refuses an invalid payload, and nothing is persisted when it does.
**Depends on**: none (uplift-7 gap, base `main` at `05d8f45`)
**Repos**: agent-substrate (`packages/mcp-server`)
**Requirements**: uplift-7 audit row "Invalid writes are rejected, with nothing partially persisted"
**Success Criteria** (what must be TRUE):

  1. Memory, skill, and docs writes refuse an invalid payload with the surface's documented error status.
  2. Before-and-after checks of stored content (memory records, docs state, uploaded documents) prove nothing was persisted or mutated on a refusal (row count alone is insufficient because `decideSkill` can mutate without changing count, and docs perform uploads + disk writes). Row counts kept as an extra check. Proven in an isolated namespace per surface.
**Plans**: 1/1 plans complete; verified 2026-10-21, all criteria PASS, see 34-VERIFICATION.md

### Phase 35: expected_version for skills and docs

**Goal**: Skill and docs writes enforce the same optimistic-concurrency contract memory decisions already use.
**Depends on**: none (uplift-7 gap, base `main` at `05d8f45`)
**Repos**: agent-substrate (`packages/mcp-server`)
**Requirements**: uplift-7 audit row "A stale concurrent update is rejected or resolved under the documented policy"
**Success Criteria** (what must be TRUE):

  1. A skill or docs write with a stale `expected_version` is rejected with the memory path's error, and the stored row is unchanged.
  2. A matching `expected_version` is accepted and the version increments.
  3. A write without the field behaves exactly as it does today.
**Plans**: 1/1 plans complete

### Phase 36: Degraded-mode exactly-once replay

**Goal**: With the substrate unavailable, a dependent client finishes degraded, and queued writes apply exactly once when it recovers.
**Depends on**: none (uplift-7 gap, base `main` at `05d8f45`)
**Repos**: agent-substrate (`packages/mcp-server`, and the dependent client if identified)
**Requirements**: uplift-7 audit row "With the substrate unavailable, a dependent client finishes degraded; queued writes apply exactly once"
**Success Criteria** (what must be TRUE):

  1. A memory write carrying an idempotency key applies once across replays and returns the original result. A skill approve replay answers `exists` with the existing record and writes no second row or event. A skill propose replay answers `existing` with no second push or PR. Amended 2026-10-21 by the project owner's decision: skills have no idempotency key. A propose replay still emits one `skill.propose` audit event per call (service.ts:2772-2788).
  2. A write without a key behaves exactly as it does today.
  3. The 503 path is covered by a test.
  4. The dependent client's local queue is built for the identified client, or recorded as a decision request with a default.
**Plans**: 1/1 plans complete; verified 2026-10-21, see 36-VERIFICATION.md

### Phase 37: LANEB

**Goal**: Lane B events for a worktree reach that graph's brief and evidence without agents passing ids.

**Depends on**: C-T3

**Repos**: agent-substrate

**Requirements**: [A-D1]

**Success Criteria** (what must be TRUE):

  1. Lane B events reach the graph's brief and evidence without agents passing ids.

**Plans**: 1/1 plans complete (PLAN.md); verified in phases/37-laneb-graph-attribution/VERIFICATION.md, merged in PR #89 (a1b7152)

### Phase 38: MIRROR

**Goal**: Graph edges mirror into Linear relations, and mirror outcomes land in each node's evidence.

**Depends on**: M6

**Repos**: agent-substrate

**Requirements**: [B-D1, B-D3]

**Success Criteria** (what must be TRUE):

  1. Graph edges (`requires` / `blocks` / `gated_by`) mirror into Linear relations, closing `coordination.md:321` "Not done".
  2. One artifact per node shows claim → Linear → Notion → DoD.

**Plans**: 1 plan (PLAN.md); verified in phases/38-mirror/VERIFICATION.md; merged in PR #90 (1d4e4aa)

### Phase 39: DISPATCH

**Goal**: Dispatch is a signed handoff packet, and the worktree is drift-scanned before any session launches.

**Depends on**: M2

**Repos**: agent-substrate

**Requirements**: [C-D2, C-D4]

**Success Criteria** (what must be TRUE):

  1. Dispatch is a signed handoff packet (goal from the issue, DoD lines, files), and the dispatched context can be replayed from the ledger.
  2. `coord_drift_scan` runs on the worktree before launch, giving a stale-brief warning before acting (v0.3 §2).

**Plans**: 1 plan (PLAN.md, verification and records); verified in phases/39-dispatch/VERIFICATION.md; PR #91 merged (acb6767). The C-D2 goal is the issue identifier (DISP-07, decided 2026-10-21)

### Phase 40: DOCS-MEMORY

**Goal**: The memory planes consolidate into one: cross-surface recall, retirement of the duplicate memory MCPs once the `sub-*` banks answer, and a weekly refresh of the config-named mental models.

**Decision (2026-10-21)**: DOCS-04 is amended to allow recall inside the brief, as D-D1 describes (a bounded, cached fan-out over the `sub-*` banks). The original DOCS-04 wording stays in milestones/v1.3-REQUIREMENTS.md:85. Open for the phase 40 discuss step: whether the 1.5 s brief budget named in that wording still applies.

**Depends on**: P10

**Repos**: agent-substrate

**Requirements**: [D-D1, D-D3, D-D4]

**Success Criteria** (what must be TRUE):

  1. D-D1 (decided 2026-10-21): cross-surface recall in the brief is a bounded, cached fan-out over the `sub-*` banks (`data-planes.md:34`).
  2. Claude Code's global `hindsight` stdio MCP and Hermes supermemory are retired once the `sub-*` banks answer, with restore routes recorded first.
  3. A weekly refresh of the config-named mental models through the refresh endpoint, without `reflect`: mental models replace stale detail (`data-planes.md:27,39`). The owner accepted this narrower scope on 2026-10-22 (see phases/40-docs-memory/VERIFICATION.md frontmatter), which supersedes the original weekly `reflect` wording.

**Plans**: 1/1 plans complete; see phases/40-docs-memory/VERIFICATION.md (human_needed; restore drill operator-gated)

### Phase 41: ANCHOR

**Goal**: Hourly anchors appear in the evidence bundle, and teachable moments are anchored.

**Depends on**: M6; F-D2 and E-T4

**Repos**: agent-substrate

**Requirements**: [E-D1, E-D2]

**Success Criteria** (what must be TRUE):

  1. Anchors appear in the evidence bundle: a tx signature and an explorer link per hour, so PR and incident evidence can be checked outside the system (v0.3 6.x).
  2. Teachable moments are anchored with graph id plus an observation digest, a user addition carried in the brief's area E.

**Plans**: 1/1 plans complete; see phases/41-anchor/VERIFICATION.md (human_needed; devnet proof operator-gated)

### Phase 42: SKILL-CARD

**Goal**: Skills gain a list tool with an approve/decline audit trail, and the `agent-skills` dataset re-ingests after each fast-forward.

**Depends on**: D-T3

**Repos**: agent-substrate

**Requirements**: [F-D3, F-D4]

**Success Criteria** (what must be TRUE):

  1. `skills_list` and an approve/decline audit trail (§5.1; v0.3 "4.x Skill approve audit").
  2. Skills become searchable through `docs_search` after each `agent-skills` fast-forward re-ingest.

**Plans**: 1/1 plans complete; see phases/42-skill-card/VERIFICATION.md (human_needed; live fast-forward operator-gated)

### Phase 43: LANE-A

**Goal**: The Lane A sandbox runs under an enforced egress allowlist, and running tasks are re-adopted after a dispatcher restart.

**Depends on**: none stated

**Repos**: agent-substrate

**Requirements**: [H-D1, H-D3]

**Success Criteria** (what must be TRUE):

  1. An enforced egress allowlist for the sandbox container (September N3 found it could reach example.com).
  2. Running tasks are re-adopted after a dispatcher restart, so no orphaned VMs remain (N4).

**Plans**: 1/1 plans complete; see phases/43-lane-a/VERIFICATION.md (human_needed; live egress and restart operator-gated)

### Phase 44: UAT

**Goal**: The Phase 0 UAT runs as a repeatable script against any `SUBSTRATE_URL`.

**Depends on**: none stated

**Repos**: agent-substrate

**Requirements**: [I-D1]

**Success Criteria** (what must be TRUE):

  1. The UAT runs as a repeatable script against any `SUBSTRATE_URL`, a regression check for every later phase (I-D1).

**Plans**: 1/1 plans complete; see phases/44-uat/VERIFICATION.md (passed)

### Phase 45: Railway Resource Orchestrator

**Goal**: Railway services are managed through MCP tools (list, scale, monitor, deploy) using the forwarders, with a basic scale suggestion and a cost report.

**Status**: unparked 2026-10-21. Budget ceiling $50 per month at test scale, confirmed by the project owner (uplift-7/BLOCKING-UNKNOWNS.md item 8 default).

**Depends on**: none (7-SOTA plan on branch feature/7-sota-enhancements)

**Repos**: agent-substrate (target files: packages/mcp-server/src (new railway.ts), docs/data-planes.md, config-reference.md)

**Requirements**: [SOTA-01]

**Success Criteria** (what must be TRUE):

  1. MCP tool lists Railway resources.
  2. Basic scale suggestion.
  3. Cost report in /slo.

**Plans**: 1/1 plans complete; verified 2026-10-21 in phases/45-railway/VERIFICATION.md; live Railway proof operator-gated

### Phase 46: LightRAG hybrid RAG with Hindsight context and the RAGFlow migration

**Goal**: Docs answers come from LightRAG with hybrid search and Hindsight context. The RAGFlow to LightRAG migration runs inside this phase: archive, LightRAG deploy, migration job, parity gate, cutover, then RAGFlow removal after the RAG-dependent phases pass. Each live step needs the operator's approval for that run.

**Depends on**: none (7-SOTA plan on branch feature/7-sota-enhancements)

**Repos**: agent-substrate (target files: packages/mcp-server/src/planes/lightrag.ts, planes/ragflow.ts (removed in the migration), planes/hindsight.ts, docs/docs-plane.md)

**Requirements**: [SOTA-02]

**Success Criteria** (what must be TRUE):

  1. docs_search answers from LightRAG with hybrid search and Hindsight context, with tests.
  2. The RAGFlow dataset is archived, with a verified checksum, before any deletion.
  3. LightRAG is deployed to Agent Substrate production and passes a timed health probe.
  4. The migration job and parity comparator pass PARITY_GATE before any ingestion. PARITY_GATE checks, in order: every migrated record keeps its dataset, source URL and version (zero mismatches allowed); a fixed sample of queries, listed in the phase 46 PLAN, returns citations from the same source documents at the match rate the PLAN sets before the run.
  5. Cutover is a logged, reversible switch with a delta pass. RAGFlow code and service are removed only after cutover, after criteria 1 to 4 pass, and after every other RAG-dependent phase passes. The RAG-dependent phases are 25 and 42, plus any other phase whose VERIFICATION names a live RAGFlow call (the phase 46 PLAN confirms that list before cutover). Storage deletion needs its own approval.
  6. Every live step (deploy, ingestion, cutover, storage deletion) runs only after the operator approves it for that run.

**Plans**: 1 plan (PLAN.md, created 2026-10-24 in phases/46-lightrag-hybrid/). Status partial (VERIFICATION.md, 2026-10-28, `human_needed`): criterion 1 met in the repository; criterion 3 performed live in naive mode in Run 11 (2026-10-28); criterion 4 NOT met (no parity comparator exists); criterion 5 partial (cutover done, RAGFlow removal operator-gated); criteria 2 and 6 need per-run operator approval; not accepted as debt (operator decision 2026-10-23).

**Operator re-scope, 2026-10-25 (reconciliation note, no criterion text changed):** RAGFlow was checked by the operator and is empty: no datasets, and an empty knowledgebase folder. The operator authorized removing RAGFlow and its associated resources. The `ragflow` Railway service was deleted on 2026-10-25; its volumes were not attached and none were detached. LightRAG is the only docs plane. It indexes three sources, and each is re-indexed when it changes: .planning markdown, repository docs, and complete scraped documentation sites. Storage deletion (the `elasticsearch`, `mysql`, `storage` and `redis` services, which may be shared) still needs its own approval, as criterion 5 requires. The live-step approvals in criteria 2 to 6 are unchanged.

### Phase 47: GreptimeDB + Dragonfly Predictive Analytics & Cache

**Goal**: Time-series forecasting predicts SLO burn, and the Dragonfly cache pre-warms from observed patterns.

**Depends on**: none (7-SOTA plan on branch feature/7-sota-enhancements)

**Repos**: agent-substrate (target files: packages/mcp-server/src/cache.ts, greptime code, observability, data-planes.md)

**Requirements**: [SOTA-03]

**Success Criteria** (what must be TRUE):

  1. /slo has predictive rows.
  2. Cache preloads based on patterns.

**Plans**: 1/1 plans complete; verified 2026-10-21 in phases/47-forecast-preload/VERIFICATION.md; live proof operator-gated

### Phase 48: TailscaleDB Secure Unified Proxy Layer

**Goal**: Greptime, Dragonfly and Timescale are reached through one secure Tailscale proxy layer with RBAC, audit and pooling.

**Depends on**: none (7-SOTA plan on branch feature/7-sota-enhancements)

**Repos**: agent-substrate (target files: docs/railway-tailscale.md, data-planes.md, config for DBs)

**Requirements**: [SOTA-04]

**Success Criteria** (what must be TRUE):

  1. All DBs accessed via secure proxy.
  2. Audit events for access.

**Plans**: 1/1 plans complete; verified 2026-10-21 in phases/48-tailscale-proxy/VERIFICATION.md; merged in PR #102; live cutover operator-gated

### Phase 49: Hindsight Graph Memory with Greptime Events

**Goal**: Hindsight memory is graph-structured and built from Greptime events, with causal recall.

**Depends on**: none (7-SOTA plan on branch feature/7-sota-enhancements)

**Repos**: agent-substrate (target files: packages/mcp-server/src/planes/hindsight.ts, memory code, greptime)

**Requirements**: [SOTA-05]

**Success Criteria** (what must be TRUE):

  1. memory_search returns graph-linked results.
  2. Recall uses causal.

**Plans**: 1/1 plans complete; verified 2026-10-21 in phases/49-graph-memory/VERIFICATION.md; live proof operator-gated

### Phase 50: Dragonfly Pub/Sub for Real-time Events

**Goal**: Dragonfly pub/sub propagates Greptime events to the planes in real time, with event-driven cache invalidation (event-driven cache invalidation narrowed out of scope by the owner on 2026-10-22, D50-e).

**Depends on**: none (7-SOTA plan on branch feature/7-sota-enhancements)

**Repos**: agent-substrate (target files: packages/mcp-server/src/cache.ts, event emit code)

**Requirements**: [SOTA-06]

**Success Criteria** (what must be TRUE):

  1. Real-time notifications for events via Dragonfly.
  2. Tests.

**Plans**: 1/1 plans complete; verified 2026-10-21 in phases/50-dragonfly-pubsub/VERIFICATION.md; live subscription operator-gated

### Phase 51: Enterprise Unified Resource Fabric

**Goal**: One MCP interface and set of dashboards covers all six resources on Railway and Tailscale, with cross-resource optimization and compliance reporting.

**Depends on**: Phases 45 and 48 (inferred from the Railway and Tailscale scope of the 7-SOTA plan, item 7; the plan states no dependency)

**Repos**: agent-substrate (target files: packages/mcp-server/src (new fabric/), observability, docs, config-reference)

**Requirements**: [SOTA-07]

**Success Criteria** (what must be TRUE):

  1. New MCP tools for fabric status and optimization suggestions.
  2. Compliance report.

**Plans**: 1/1 plans complete; verified 2026-10-22 in phases/51-enterprise-fabric/VERIFICATION.md; merged in PR #108


### Phase 52: GSD-Core planning index and cross-session awareness core

**Goal**: Agents see other sessions' `.planning` state through the substrate, read-only and file-first: no session writes into another session's `.planning`, and every backing service is optional with a file-only fallback.

**Status**: Complete. Merged to main as PR #104 (core, 2026-10-27; a merge commit, 1dd01347, with two parents) and PR #134 (wiring, 2026-10-28). Draft PR #109 was closed and replaced.

**Depends on**: Phase 50 (existing event bus and pub/sub hints), Phase 17 (frozen event vocabulary; no new event kinds)

**Repos**: agent-substrate (target files: packages/mcp-server/src (new planning/ modules), packages/audit/src/policy.ts, docs, config-reference)

**Requirements**: [SOTA-08]

**Success Criteria** (what must be TRUE):

  1. A deterministic index of `.planning` artifacts keyed by content hash, where a full rebuild equals the incremental result.
  2. Session presence uses a server-time TTL; a stale session is derived at read time and never deleted.
  3. Planning-change diffs publish on the existing event bus carrying paths and hashes, never bodies.
  4. Read-only MCP tools `planning_status` and `planning_sessions` exist, each with an entry in `packages/audit/src/policy.ts`.
  5. File-only mode works with every backing service disabled.
  6. All configuration is environment-only, with documented defaults and no hardcoded hosts, ports or paths.

**Plans**: PLAN.md and SUMMARY.md exist in the phase directory; the phase was built outside gsd-plan-phase (PLAN frontmatter statuses predate the merges)

### Phase 53: Steering, conflict control and checkpoint/resume

**Goal**: Human-authorized steering directives are queued, acknowledged and audited in TimescaleDB before any file change; conflicts between sessions on the same parsed phase or plan id emit events and never auto-resolve; checkpoints at plan-step boundaries resume without duplicate completion.

**Status**: Complete. Merged to main as PR #136 (2026-10-28), which replaced draft PR #110 (closed). Migration 33 is NOT applied. Live delivery into sessions is NOT built by this phase.

**Depends on**: Phase 52 (session index and presence), Phase 20 (per-client identity for attributing directives)

**Repos**: agent-substrate (target files: packages/mcp-server/src (planning steering and checkpoint modules), TimescaleDB index schema, config-reference)

**Requirements**: [SOTA-09]

**Success Criteria** (what must be TRUE):

  1. A directive is queued, then acknowledged, then audited; when the audit write cannot be made, the directive is held and no file changes.
  2. Two sessions touching the same parsed phase or plan id emit a conflict event, and neither side resolves it automatically.
  3. A watcher gap marks the session view unknown until a full rescan.
  4. Kill-and-restart at a plan-step boundary yields exactly one completion record, keyed by phase id, plan step and file hash.

**Plans**: PLAN.md and SUMMARY.md exist in the phase directory; the phase was built outside gsd-plan-phase (PLAN frontmatter statuses predate the merges)

### Phase 54: Planning observability and migration inventory

**Goal**: Every phase transition is observable, and host-bound dependencies are inventoried for a future Railway move, with no cutover, DNS change or production deploy in scope.

**Status**: Complete. Merged to main as PR #135 (2026-10-28), which replaced draft PR #111 (closed). The Greptime rehearsal of `planning.transition` has NOT run.

**Depends on**: Phase 52 (transition source), Phase 53 (steering and checkpoint states)

**Repos**: agent-substrate (target files: packages/observability, docs, config-reference)

**Requirements**: [SOTA-10]

**Success Criteria** (what must be TRUE):

  1. Each phase transition emits a GreptimeDB metric, with a stdout fallback when GreptimeDB is disabled or unreachable.
  2. The session view reports exactly one of the STATES: LOADING, EMPTY, STALE, DEGRADED, ERROR, SUCCESS.
  3. A documented inventory separates disk state from Railway-hosted state and lists host-bound paths and units.

**Plans**: PLAN.md and SUMMARY.md exist in the phase directory; the phase was built outside gsd-plan-phase (PLAN frontmatter statuses predate the merges)

### Phase 55: Migration safety, session event vocabulary and the v1.6 baseline

**Goal**: The substrate evolves its TimescaleDB index and its ledger vocabulary only through contract-tested, documented steps, and the milestone's verified facts, corrected assumptions and quality findings are on record.

**Status**: Complete. Implemented 2026-10-26 on `gsd/v16-int` (tests e8dbe52); merged to main as PR #127 (2026-10-28). Criteria 1 to 5 met in the repository, none needs a live system; the production migration rehearsal in `docs/runbooks/index-migration-rehearsal.md` is operator-run. Discovery recorded in `phases/55-migration-safety/CONTEXT.md`; outcome in `SUMMARY.md` and `VERIFICATION.md` of the same directory.

**Depends on**: Phase 17 (frozen event vocabulary), Phase 26 (index store)

**Repos**: agent-substrate (target files: packages/mcp-server/src/index-store.ts and its tests, event-sources.ts, session-events.ts, rollback-compat.test.ts, docs/event-vocabulary.md, docs/runbooks)

**Requirements**: [SOTA-11]

**Success Criteria** (what must be TRUE):

  1. An offline contract test fails any migration step that is not idempotent, that drops, renames or retypes an object, or whose text changed after it was applied (frozen digests for the applied steps).
  2. A fake-connection harness proves the advisory lock is taken before any DDL, one transaction per step, rollback with no ledger row, zero DDL on a re-run, and resume from a partial ledger.
  3. A rollback-compat test fails when a step added after the reference release is not additive or is not listed in the rollback-compat runbook.
  4. `session.checkpoint`, `session.rollback` and `session.rollback.refused` exist as `note` and `warning` events with validated payload builders, and `bun run check:phase-close` passes with EVENT_KINDS at 12 and SURFACES at 42.
  5. An operator rehearsal runbook for index migrations exists, and every production step in it is marked operator-run.

**Plans**: none written (no gsd-plan-phase run; built in one orchestrated wave of edit-only units, recorded in SUMMARY.md)

### Phase 56: LightRAG client contract alignment and storage topology

**Goal**: The substrate talks to LightRAG v1.5.x correctly and safely before any deploy: the client matches the upstream API, can never emit a clear-all, is contract-tested against a route table, and the hosting topology is decided and written down. Deploy, ingest and cutover stay in Phase 46 (T5-T8).

**Status**: Complete. Implemented 2026-10-26 on `gsd/v16-int` (a573641); merged to main as PR #127 (2026-10-28). Criteria 1 to 7 met against the upstream v1.5.7 source (no LightRAG server existed to test against at that time); the live `/openapi.json` diff, deploy, ingest and cutover are operator-gated (phase 46 T5-T8). The RAGFlow service was deleted on 2026-10-25.

**Depends on**: Phase 46 (client and docs plane; criterion 1 in repo)

**Repos**: agent-substrate (target files: packages/mcp-server/src/planes/lightrag.ts and tests, mcp.ts, server.ts, service.ts, docs/runbooks, docs/data-planes.md, docs/docs-plane.md)

**Requirements**: [SOTA-12]

**Success Criteria** (what must be TRUE):

  1. The client never sends `DELETE /documents` (clear-all upstream). Documents are removed only through `DELETE /documents/delete_document` with real document ids, and a denylist test proves the clear-all route is unreachable.
  2. Pipeline completion is read from the upstream `busy` flag; a fenced workspace (`recovery_required`) and an unknown shape each give an explicit reason, never a silent timeout.
  3. The API key is sent as `X-API-Key` only and never appears in a reason or a log.
  4. An upload's `track_id` resolves to document ids through `track_status`; an HTTP 409 same-name conflict is a typed outcome.
  5. One LightRAG `/query` client remains, behind the breaker and the gated fetch, and a health probe fills `planes.lightrag.ok`.
  6. A route fixture derived from upstream v1.5.7 source, with its provenance stated, and a contract test fail when the client's routes or required request fields drift; the operator step that diffs the fixture against the live `/openapi.json` is documented.
  7. The storage topology decision (a dedicated Postgres with pgvector, `PGTableGraphStorage`, workspace isolation, a pinned image, Dragonfly kept cache-only) and the upgrade and re-index design are written down; no live action is taken.

**Plans**: none written (no gsd-plan-phase run; built in one orchestrated wave of edit-only units, recorded in SUMMARY.md)

### Phase 57: Tandem memory, LightRAG with Hindsight, with provenance and forget

**Goal**: Hindsight and LightRAG answer together with shared provenance and join keys, memory written after a point in a session can be superseded or forgotten without hard-deleting the ledger, and the consistency of the stores can be verified.

**Status**: Complete. Implemented 2026-10-26 on `gsd/v16-int` (77d18bc retain join keys, 084eb69 library layer, a26841d wiring, 2aaa19a verifier, 824ceda and 979b5e2 corrections and CLI); merged to main as PRs #128 and #129 (2026-10-28). Criteria 1 to 5 met in the repository with fakes; every new flag defaults off. Two items are unverified against a live system: the Hindsight document-list route the verifier reads, and what the tandem leg returns from a live LightRAG.

**Depends on**: Phase 56, Phase 49 (graph memory), Phase 26 (Hindsight recall)

**Repos**: agent-substrate (target files: packages/mcp-server/src/memory-retain.ts, memory-recall.ts, a new memory-forget.ts and tandem-recall.ts, docs-search.ts, service.ts, a consistency verifier)

**Requirements**: [SOTA-13]

**Success Criteria** (what must be TRUE):

  1. Retain metadata carries `graph_id`, `session_id` and `node_id` when known; recall hits expose them; document ids are unchanged.
  2. A docs answer with LightRAG up carries LightRAG chunks and Hindsight citations, deduplicated and with provenance; with LightRAG down the existing degraded fallback is unchanged.
  3. A forget primitive removes plane documents for entries superseded by rollback or expiry, by entry id, emits one ledger note per call, and a replayed parked retain for it answers gone; the index keeps the superseded row.
  4. A consistency verifier compares the TimescaleDB memory index, the Hindsight documents and the ledger events, reports drift as JSON with a non-zero exit code, and repairs nothing without an explicit flag.
  5. The brief's recall injection can be scoped to the claimed node's graph, off by default, within its own budget.

**Plans**: none written (no gsd-plan-phase run; built in one orchestrated wave of edit-only units, recorded in SUMMARY.md)

### Phase 58: Live session steering for multi-day GSD-Core sessions

**Goal**: Steering directives are durable, are delivered to the target session and are tied to GSD-Core's position, and sessions that run for days stay alive: liveness is decoupled from planning changes and state survives restarts.

**Status**: Complete. Implemented 2026-10-26 on `gsd/v16-58-live-steering` (7edfd79) and merged to main as PR #137 (2026-10-28), which replaced draft PR #131 (closed); its phase 52-54 dependencies are now on main. PR #147 (23ced3cb, 2026-10-28) merged the one state model for `docs_steering_session` and the steering inbox, which closed criterion 2. `.planning/phases/58-live-steering/VERIFICATION.md` (2026-10-28, main 31a9bb36) is `passed`: 5 of 5 criteria met in the repository. Live steps stay operator-gated: production opt-in of the audit table, enabling steering in production, and any multi-day live proof.

**Depends on**: Phase 52, Phase 53, Phase 54 (merged), Phase 57

**Repos**: agent-substrate (target files: packages/mcp-server/src/planning/*, mcp.ts, event.ts, the TimescaleDB index schema (new opt-in step), config-reference)

**Requirements**: [SOTA-14]

**Success Criteria** (what must be TRUE):

  1. Queued and acknowledged directives survive a restart through a durable store (an opt-in TimescaleDB step), and an unacknowledged directive expires to a `declined:timeout` audit row.
  2. A queued directive reaches the target session within one scan interval through the existing hint channel and the next `docs_search` or brief; the two steering mechanisms (`docs_steering_session` and the inbox) share one state model.
  3. A session quiet for more than 25 hours stays `active` while it heartbeats, and a restart publishes the changes made while the observer was down.
  4. `.planning/STATE.md` and `ROADMAP.md` are parsed into a position (milestone, phase, plan, step) exposed through `planning_status`.
  5. DragonflyDB carries only wake-up hints and ephemeral presence; the durable authority is TimescaleDB and the ledger.

**Plans**: none written (no gsd-plan-phase run; built in one orchestrated wave of edit-only units, recorded in SUMMARY.md)

### Phase 59: Eternal logging, verifiable checkpoint and rollback events on Solana devnet

**Goal**: Every checkpoint and rollback is a ledger event that is provably inside an hourly root anchored on Solana devnet, verifiable without trusting the substrate; devnet resets and signer changes are detected and recoverable. Roots only, devnet only.

**Status**: Complete in the repository; VERIFICATION human_needed (2026-10-28), 6 of 6 criteria met. Implemented 2026-10-26 on `gsd/v16-int` (7b37ea6 proofs and URL guard, 084eb69 verification library, a26841d tools, 2aaa19a re-anchor planner and runbooks, 824ceda signer-set env); merged to main as PRs #128 and #129 (2026-10-28). Criterion 5, partial after those PRs (classification and a read-only re-anchor dry-run existed, the re-anchor send did not), was closed by PR #150 (squash b19ff515): the guarded, operator-run re-anchor executor and the verifier pointer; the send itself is operator-run only and nothing was sent to any cluster. No live devnet proof was run; funding the anchor key, the anchor timer and any devnet send stay operator-gated (phase 41). The devnet genesis hash constant, wrong since phase 28, was corrected in ccbfff2.

**Depends on**: Phase 55 (vocabulary), Phase 41 (anchor job)

**Repos**: agent-substrate (target files: packages/ledger/src, packages/mcp-server/src/anchor.ts, service.ts (verify), config.ts, packages/evidence, docs/runbooks)

**Requirements**: [SOTA-15]

**Success Criteria** (what must be TRUE):

  1. A Merkle inclusion proof for one event hash verifies against the hourly root for every tree size and index, and any tampering fails.
  2. A checkpoint verification command resolves a checkpoint event to its hour root, its proof, its `anchors` row and its devnet transaction, and reports exactly one of anchored, pending, unanchored, unverified or mismatch.
  3. A devnet RPC URL that names mainnet or testnet is refused at configuration load and at RPC construction, in addition to the genesis-hash gate.
  4. A signer set with validity windows lets the verifier accept anchors signed by a rotated key and reject any other, and a rotation is itself a ledger event.
  5. A devnet reset (a changed genesis hash or missing finalized signatures) is classified apart from tampering, a re-anchor procedure with a dry-run exists, and the chain is documented as evidence and not as storage.
  6. No transaction is sent by this phase's code outside operator-run steps; the runbook for those steps exists.

**Plans**: none written (no gsd-plan-phase run; built in one orchestrated wave of edit-only units, recorded in SUMMARY.md)

### Phase 60: Eternal Memory Knowledge Nexus

**Goal**: Memory records are durable, versioned, carry provenance and are verifiable against the anchored ledger; deterministic capsules can be exported and content-addressed, informed by the concepts of Anda and KIP without adopting their chain or code.

**Status**: Complete. Implemented 2026-10-26 on `gsd/v16-int` (084eb69 modules, a26841d `memory_verify`, 979b5e2 `substrate capsule`); merged to main as PRs #128 and #129 (2026-10-28). Criteria 1 to 4 met in the repository with fakes; live use of the `ledger-archive` bucket is operator-gated. ADRs 0002 and 0003.

**Depends on**: Phase 57, Phase 59

**Repos**: agent-substrate (target files: packages/mcp-server/src (memory verification and capsule modules), a blob store interface, docs/adr)

**Requirements**: [SOTA-16]

**Success Criteria** (what must be TRUE):

  1. Each governed memory record exposes a stable id, a version, its supersession chain, its provenance and a content hash; a verify call recomputes the hash and proves the write event is inside an anchored root.
  2. A deterministic capsule export (records plus a manifest and a root digest) round-trips, and its digest is recorded as a ledger event; the blob store interface has a local content-addressed store and an S3-compatible adapter tested against a fake (live use of the `ledger-archive` bucket is operator-gated).
  3. Redaction removes a capsule's content and keeps its hash and a tombstone; the limits that on-chain immutability imposes are documented.
  4. A decision record maps each Anda and KIP concept to adopt, adapt or reject and notes the upstream licenses; no code is copied.

**Plans**: none written (no gsd-plan-phase run; built in one orchestrated wave of edit-only units, recorded in SUMMARY.md)

### Phase 61: Session rollback to an exact chat moment with file revert

**Goal**: A session can be rolled back to a checkpoint: files are restored exactly, the chat position is recorded, memory written after the checkpoint stops influencing recall, and the rollback is an append-only event. The revert runs as a CLI under the session's own authority; the substrate server stays read-only on worktrees.

**Status**: Merged; criterion 3 still partial. Implemented 2026-10-26 on `gsd/v16-int` (ff51cc7 snapshot library, a26841d server tools, 99ec7e3 and 979b5e2 CLI, 824ceda corrections); merged to main as PRs #128 and #129 (2026-10-28). PR #146 (checkpoint sequence lock, 71d308f5) and PR #148 (hook entry point `substrate session hook`, trigger policy, printed host configuration, write-ahead pending journal) are merged. `.planning/phases/61-session-rollback/VERIFICATION.md` (2026-10-28) keeps criterion 3 PARTIAL: no host installs or fires the hook until an operator installs the printed configuration (ADR 0007, decision D55-4); criteria 1, 2, 4, 5 and 6 are met in the repository. No rollback was rehearsed against the live server or ledger. The phase did not need the draft PRs' code; it stacks on nothing.

**Depends on**: Phase 55, Phase 57, Phase 58, Phase 59, the worktree snapshot library

**Repos**: agent-substrate (target files: packages/worktree-snapshot, packages/cli, packages/collectors (transcript references), packages/mcp-server/src (checkpoint and rollback planning), docs/runbooks). The TimescaleDB opt-in schema step this line once listed was NOT built: checkpoints are ledger notes plus local pinned git refs (`refs/substrate/checkpoints/*`, ADR 0005), and no index migration step, table or column was added by phase 61.

**Requirements**: [SOTA-17]

**Success Criteria** (what must be TRUE):

  1. Snapshot, mutate and restore yields tree-hash equality including added, deleted, renamed, mode-changed, symlinked and untracked files; a restore that fails or is interrupted ends at the pre-rollback state or the target state after recovery, never partial, and a retry succeeds.
  2. A dry-run lists the exact changes; drift made outside the session is detected and refused without an explicit force; a safety snapshot is always taken first.
  3. Checkpoints are created at defined boundaries (turn, plan step, steering event, manual) and carry an opaque transcript reference, the git tree, the manifest digest and the ledger chain head.
  4. A rollback appends `session.rollback`; entries and Hindsight documents written after the checkpoint are superseded or forgotten, recall after the rollback excludes them, and the rolled-back history stays retrievable for audit.
  5. Transcripts are handled per surface: omp moves its session leaf; other surfaces get a marker event; no transcript is rewritten.
  6. With the chain unreachable, a rollback still works from local checkpoints and reports them as unanchored.

**Plans**: none written (no gsd-plan-phase run; built in one orchestrated wave of edit-only units, recorded in SUMMARY.md)

### Phase 62: Soak, runbooks and v1.6 close

**Goal**: The milestone is proven for sessions that run for days and is documented for operation.

**Status**: Complete. Written 2026-10-26: the multi-day soak tests, the runbooks, ADRs 0004-0007 and `v1.6-MILESTONE-AUDIT.md`. The soak tests (8752578), the ADRs 0004-0007 and `docs/ussr-integration.md` (a8346f7) and the planning records (a37a805) were committed on `gsd/v16-int` and merged to main as PR #130 (2026-10-28). Completing and archiving the milestone is an operator decision and was not done.

**Depends on**: Phases 55-61

**Repos**: agent-substrate (target files: soak tests, docs/runbooks, docs/adr, .planning)

**Requirements**: [SOTA-18]

**Success Criteria** (what must be TRUE):

  1. A simulated multi-day run with injected clocks shows bounded memory and handle counts and a clean resume after a restart and after a store failover.
  2. Runbooks exist for migration rehearsal, LightRAG hosting, a chain outage and a devnet reset, rollback, and signer key rotation, and decision records exist for store roles, rollback semantics and memo-only anchoring.
  3. STATE.md and ROADMAP.md reflect every phase, and the milestone audit is written.

**Plans**: none written (no gsd-plan-phase run; built in one orchestrated wave of edit-only units, recorded in SUMMARY.md)


## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 16. Production parity and rehearsal harness | v1.3 | 5/5 | Complete    | 2026-10-08 |
| 17. Event vocabulary and audit policy | v1.3 | 3/3 | Complete    | 2026-10-09 |
| 18. Guard rails and shared redactor | v1.3 | 4/4 | Complete    | 2026-10-09 |
| 19. Lane B collectors | v1.3 | 5/5 | Complete    | 2026-10-10 |
| 20. Production identity and Phase 0 UAT | v1.3 | 6/6 | Complete    | 2026-10-11 |
| 21. skills_propose | v1.3 | 6/6 | Complete    | 2026-10-11 |
| 22. Skills sync, bridge and miners | v1.3 | 4/4 | Complete    | 2026-10-11 |
| 23. Claim mirror and DoD gate | v1.3 | 6/6 | Complete    | 2026-10-11 |
| 24. substrate-dispatcher | v1.3 | 4/4 | Complete    | 2026-10-11 |
| 25. Docs search and ingest (RAGFlow) | v1.3 | 3/3 | Complete    | 2026-10-11 |
| 26. Hindsight recall and Dragonfly cache | v1.3 | 3/3 | Complete    | 2026-10-11 |
| 27. Ledger primitives and ingest order | v1.3 | 4/4 | Complete    | 2026-10-10 |
| 28. Hourly anchor job and verify | v1.3 | 4/4 | Complete    | 2026-10-10 |
| 29. Agent Cards and teachable moments | v1.3 | 3/3 | Complete    | 2026-10-11 |
| 30. desktop_run | v1.3 | 7/7 | Complete    | 2026-10-10 |
| 31. Lane A runtime: spike, packaging and VM host | v1.3 | 3/3 | Complete    | 2026-10-11 |
| 32. Lane A host core | v1.3 | 3/3 | Complete    | 2026-10-11 |
| 33. Lane A dispatch route and approvals | v1.3 | 3/3 | Complete    | 2026-10-11 |
| 34. Invalid-write round trip | v1.4 | 1/1 | Complete | 2026-10-21 |
| 35. expected_version for skills and docs | v1.4 | 1/1 | Complete | 2026-10-21 |
| 36. Degraded-mode exactly-once replay | v1.4 | 1/1 | Complete | 2026-10-21 |
| 37. LANEB | v1.3.x | 1/1 | Complete (accepted debt 2026-10-25); live criteria open | 2026-10-25 |
| 38. MIRROR | v1.3.x | 1/1 | Complete (accepted debt 2026-10-25); live criteria open | 2026-10-25 |
| 39. DISPATCH | v1.3.x | 1/1 | Complete (accepted debt 2026-10-25); live criteria open; PR #91 | 2026-10-25 |
| 40. DOCS-MEMORY | v1.3.x | 1/1 | Complete (accepted debt 2026-10-23); live restore drill open | 2026-10-23 |
| 41. ANCHOR | v1.3.x | 1/1 | Complete (accepted debt 2026-10-23); live devnet proof open | 2026-10-23 |
| 42. SKILL-CARD | v1.3.x | 1/1 | Complete (accepted debt 2026-10-23); live host proof open | 2026-10-23 |
| 43. LANE-A | v1.3.x | 1/1 | Complete (PR #97); live egress and restart proof open (accepted debt 2026-10-23) | 2026-10-21 |
| 44. UAT | v1.3.x | 1/1 | Complete (PR #95) | 2026-10-21 |
| 45. Railway Resource Orchestrator | v1.5 | 1/1 | Complete (accepted debt 2026-10-23); live Railway proof open | 2026-10-23 |
| 46. LightRAG hybrid RAG and the RAGFlow migration | v1.5 | 0/1 | Partial: criterion 1 met; 3 live in naive mode (Run 11); 4 NOT met (no comparator); 5 partial (cutover done, removal gated); 2 and 6 need per-run operator approval | - |
| 47. GreptimeDB + Dragonfly Predictive Analytics & Cache | v1.5 | 1/1 | Complete (accepted debt 2026-10-23); live warm-up proof open | 2026-10-23 |
| 48. TailscaleDB Secure Unified Proxy Layer | v1.5 | 1/1 | Complete (accepted debt 2026-10-23); live forwarders and cutover open | 2026-10-23 |
| 49. Hindsight Graph Memory with Greptime Events | v1.5 | 1/1 | Complete (accepted debt 2026-10-23); live ledger proof open | 2026-10-23 |
| 50. Dragonfly Pub/Sub for Real-time Events | v1.5 | 1/1 | Complete (accepted debt 2026-10-23); live subscription proof open | 2026-10-23 |
| 51. Enterprise Unified Resource Fabric | v1.5 | 1/1 | Complete (PR #108) | 2026-10-22 |
| 52. GSD-Core planning index and cross-session awareness core | v1.5 | 1/1 | Complete (PR #104 merged 2026-10-27, PR #134 merged 2026-10-28) | 2026-10-28 |
| 53. Steering, conflict control and checkpoint/resume | v1.5 | 1/1 | Complete (PR #136, replaced draft #110) | 2026-10-28 |
| 54. Planning observability and migration inventory | v1.5 | 1/1 | Complete (PR #135, replaced draft #111) | 2026-10-28 |
| 55. Migration safety, session event vocabulary and the v1.6 baseline | v1.6 | 0/0 | Complete (PR #127); criteria 1-5 met in repo | 2026-10-28 |
| 56. LightRAG client contract alignment and storage topology | v1.6 | 0/0 | Complete (PR #127); criteria 1-7 met in repo; deploy operator-gated | 2026-10-28 |
| 57. Tandem memory, LightRAG with Hindsight, with provenance and forget | v1.6 | 0/0 | Complete (PRs #128, #129); criteria 1-5 met with fakes; flags default off | 2026-10-28 |
| 58. Live session steering for multi-day GSD-Core sessions | v1.6 | 0/0 | Complete (PRs #137, #147); 5 of 5 criteria met in repo (VERIFICATION passed 2026-10-28); live steps operator-gated | 2026-10-28 |
| 59. Eternal logging, verifiable checkpoint and rollback events on Solana devnet | v1.6 | 0/0 | Complete in the repository (PRs #128, #129, #150): criteria 1-6 met, VERIFICATION human_needed (live anchoring, funding, timer and send operator-gated) | 2026-10-28 |
| 60. Eternal Memory Knowledge Nexus | v1.6 | 0/0 | Complete (PRs #128, #129); criteria 1-4 met in repo; bucket use operator-gated | 2026-10-28 |
| 61. Session rollback to an exact chat moment with file revert | v1.6 | 0/0 | Merged (PRs #128, #129, #146, #148); criterion 3 partial: no host installs or fires the hook until an operator installs the printed configuration (ADR 0007, D55-4); criteria 1, 2, 4, 5, 6 met; no live rehearsal | - |
| 62. Soak, runbooks and v1.6 close | v1.6 | 0/0 | Complete (PR #130); milestone completion is an operator decision | 2026-10-28 |
