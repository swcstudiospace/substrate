# Project: Agent Substrate

**Source of truth for architecture:** [Agent Substrate — Build Plan](https://app.notion.com/p/3e4bc1a0c7ae81baafffd1ebd773123d) (Draft v0.2)
**Control plane:** Notion "Agent Task Graph" + Linear team Spectrum Web Co
**Repo:** `swcstudiospace/agent-substrate` (private)

## Current State

**In progress: v1.8 Hardening: Multi-Session, Ledger Integrity, Degradation and Reconciliation** (phases 71-78). The eight accepted features and full criteria are recorded in [REQUIREMENTS.md](REQUIREMENTS.md). Phase 71's independent-credential session boundary is locally verified; sign-off remains `human_needed`, awaiting Desk Quality / Programming Lead review. No v1.8 phase or milestone is signed off. Progress and the review blocker are in [STATE.md](STATE.md) and [ROADMAP.md](ROADMAP.md).

**Prior v1.7 Docs Atlas, Self-Improving Context, Live Steering GA and Worktree Fleet** (phases 63-70, defined 2026-10-29, Run 14): phases shipped with recorded gaps and owner decisions still open; the milestone is not complete. Its eight features ingest documentation and keep it current (Corpus Atlas, Doc Watch), use TEI (Embedding fabric), improve retrieval context (Docs Reflect), expose Live Steering and cross-session context, optimise worktrees (Worktree Fleet), prove the corpus from hourly devnet anchors (Doc Proofs), and guard docs quality (Docs SLO and eval). Existing production/operator limitations below remain in force.

Shipped **v1.3.x, v1.5 and v1.6** (2026-10-28, override closeouts): Should-have hardening (phases 37-44), SOTA enhancements (phases 45-54) and Contextual Memory, Live Steering and Eternal Rollback (phases 55-62). Each closed on the owner's decision of 2026-10-28 with its open items recorded as accepted debt (`STATE.md`, "Accepted debt (owner decision, 2026-10-28)"); archives are in `.planning/milestones/`.

- **Docs plane:** LightRAG is the live production docs backend in naive mode since 2026-10-28 (Run 11; release `5cf930a0`, `SUBSTRATE_DOCS_BACKEND=lightrag`); the `ragflow` Railway service was deleted on 2026-10-25, and RAGFlow stays only as the legacy fallback when `LIGHTRAG_URL` is unset. The LightRAG client matches upstream v1.5.7 and can never emit a clear-all (v1.6 phase 56, PR #127). Graph and hybrid modes need a real LLM route.
- **Planning plane:** a file-first GSD-Core planning index with session presence and read-only planning tools, an audited steering inbox with conflict events and resumable checkpoints, and phase-transition metrics (v1.5 phases 52-54: PRs #104, #134, #136, #135); v1.6 added durable steering directives, multi-day liveness and a GSD position model (phase 58: PRs #137, #147).
- **Memory:** tandem memory with shared join keys, a forget primitive that marks rather than hard-deletes, a cross-store consistency verifier, versioned memory records with `memory_verify` and deterministic capsules (v1.6 phases 57 and 60: PRs #128, #129). The tandem flags default off.
- **Eternal logging and session rollback:** checkpoints and rollbacks are ledger events with Merkle inclusion proofs against the anchored hourly root, signer rotation and devnet reset detection (phase 59: PRs #128, #129, #150), and `substrate session checkpoint | checkpoints | rollback | recover | sync | hook` restores exact file state (phase 61: PRs #128, #129, #146, #148). Per the v1.6 audit, no anchor transaction was ever sent and the re-anchor executor has never run against any cluster.
- **Lane A and Lane B hardening (v1.3.x):** graph attribution from the worktree path, Linear relations mirrored from graph edges with a per-node artifact (`substrate evidence --node`, PR #159), the pre-launch drift gate and signed handoff packets, brief recall fan-out and a weekly mental-model refresh behind flags, `anchors` and `teachables` in the evidence bundle, VM-task re-adoption after a dispatcher restart, and a repeatable UAT that passed 6 of 6 scenarios on a scratch twin (PRs #89-#95, #97).
- **Resource planes (v1.5, in the repository):** the Railway orchestrator with gated writes, the endpoint classifier and policy, SLO forecast rows, cache preload, graph-structured Hindsight memory, the Dragonfly pub/sub event bus and the unified resource fabric (PR #108; a `lightrag` resource in PR #158). The live proofs of phases 45 and 47-50 are accepted debt.
- **Quality gates (Run 12):** an AST-based code ratchet whose baseline only falls (PR #145), Biome as a blocking step of the single verify gate with `noImplicitOverride`, `noImplicitReturns`, `noUnusedLocals` and `noUnusedParameters` (PR #155), Biome errors from 102 to 0 (PRs #149, #151, #152), and CODEOWNERS, a PR template, CONTRIBUTING and SECURITY (PR #156).
- **Production:** runs release `5cf930a0` (the merge of #139), which lacks every PR from #142 to #159, so none of the Run 12 behaviour changes is live until the operator deploys main.

Closed with accepted debt (each item stays open and is not marked passed):

- **v1.3.x:** phases 37-39 waived on 2026-10-25 and phases 40-43 accepted as debt on 2026-10-23 (live proofs open; phases 37-43 stay `human_needed`); D-D3, the restore drill and the retirement of the old memory path, was never delivered in the repository, only its runbook.
- **v1.5:** SOTA-02 phase 46 criteria 2, 4, 5 and 6 and the LightRAG graph and hybrid modes (criterion 4: the parity comparator is not built; criterion 5: the cutover is done and the RAGFlow code removal is gated); phases 45 and 47-50 (live Railway, forecast and warm-up, proxy cutover, graph-memory ledger rows and pub/sub proofs), accepted on 2026-10-23.
- **v1.6:** phase 61 criterion 3 (SOTA-17: PR #148 shipped `substrate session hook`, the trigger policy and the printed host configuration, but no host runs the hook until an operator installs the printed configuration, ADR 0007 D55-4) and phase 59's live proofs (SOTA-15: anchor key funding, the anchor timer, any devnet send, the Eternal Memory bucket).

Shipped **v1.2** (2026-10-08): ADR 0001 S2 (SPE-5053), S4 (SPE-5055) and lessons-bank Tier 1 (SPE-5830).

- **Lease authority:** swarm sessions name their own agent, replica and graph; a `lease_id` reaches only its holder; only the holder's surface can beat, release or complete; a swarm token is never an operator. agent-substrate #16.
- **Swarm lease bridge and signed handoffs:** the runner claims, heartbeats, completes or releases each task's node under a lease for the executing agent; accountable-agent boundaries write signed `coord_handoff` packets that rebuild context from the ledger alone. agent-swarm #9, #10.
- **Workspace install:** one `substrate-mcp` entry per runtime naming the token variable, a 0600 token file per agent outside every checkout, each child given only its own `SUBSTRATE_TOKEN`. agent-substrate #18; agent-swarm #11.
- **Lessons bank:** `substrate lessons add | recall | digest | outcome` over governed `fact` entries, scores computed at read time. agent-substrate #17.

Shipped **v1.1** (2026-10-07): swarm identities and `graph_bind`, the swarm orchestrate tee, governed swarm memory and the ultrathink plan record (ADR 0001 S1 and S3).

<details>
<summary>v1.3.x, v1.5 and v1.6 goals (archived)</summary>

**Goal:** Land on `main` everything the Notion build plan still lacks, each part ending in a proof run for real: Linear-driven dispatch with mirrored claims, the docs and memory planes, the hourly Solana devnet anchor, the skills library with propose-only miners and Agent Cards, `desktop_run`, the Lane A host, and the deferred Phase 0 UAT.

**Target features:**
- Lane B collectors: herdr (the persistent runtime) and Muse collectors, plus the Muse projector with its `.substrate/BRIEF.md` fallback.
- Claim mirror: `graph_claim` / `graph_release` / `graph_complete` mirror to Linear (state, `agent:<surface>` label, one-line session comment) and to the Notion Issue row's `Agent`; completion passes the `hermes-linear-connector` Definition-of-Done gate.
- `substrate-dispatcher`: a `dispatch:<surface>` label on an unstarted Linear issue starts a session for that Graph ID in a per-Graph-ID worktree; the label becomes `agent:<surface>` when the claim lands.
- Docs plane: `docs_search` over RAGFlow with citations and a redacting `docs_ingest`; Hindsight recall and the Dragonfly cache as `docs/data-planes.md` specifies.
- Ledger anchor: an hourly Merkle root of `agent_events` written to a Solana devnet memo and an `anchors` table; `substrate verify` checks roots against their signatures.
- Skills plane: `skills.propose` opens a branch and PR on `swcstudiospace/agent-skills`; the skills sync and Hermes bridge timers run from code on `main`; A2A Agent Cards carry teachable moments.
- `desktop_run` on cua's Docker path or the existing webtop container.
- Lane A: a rivet-agentos host whose `openTask` is keyed by Graph ID, reached from `dispatch:claude-code`, gated on free disk.
- The eight deferred Phase 0 UAT scenarios (`milestones/v1.0-phases/00-brief/0-UAT.md`).

**Key context:** The September implementation of build-plan phases 1–6 lives on the unmerged branch `docs/data-planes-tailscale` (`acc30a8`, a superset of `substrate/ut-mughkkc0-73909228`); it is ported file by file onto `main`'s v1.2 lease model, and commit `21652a2` is treated as stubs. `substrate-mcp.service` points at the operator's checkout (now on `main`) but crash-loops, because a stray process started 2026-10-01 still holds `127.0.0.1:7410` and serves that day's code; the herdr and Muse collector, dispatcher and host units point at code `main` lacks, and the skills timers fail every five minutes. Phase proofs use isolated stores, and every live run (production service, real stores, devnet, Linear labels) waits for the operator's approval.

Shipped before: **v1.2 Swarm leases, workspace install and lessons bank** (2026-10-08; phases 11-15; 25/25 requirements).

</details>

## Next Milestone Goals

Carried into v1.7: the `checkpoint_hint` reader and the `steering` and `baseline` hook triggers (STEER-05; the printed configuration covers all four checkpoint triggers since Run 13, PR #166, and a host install stays operator-gated).

Candidates after v1.7, not commitments (the first two are carried over from the v1.3 list):

- ADR S5 gate verdicts as events (SPE-5056).
- Lessons bank Tier 2: phase lifecycle events, realtime delivery, an outbox and automatic injection at the GSD discuss step.
- A caller for `S3BlobStore`, which has no caller outside its own test (the CLI opens only `LocalBlobStore`).
- Callers for `memoryForget` expiry and operator reasons; only the rollback commit calls it today.
- The phase 46 parity comparator (criterion 4) and the RAGFlow code removal (criterion 5, gated on its own approvals).
- The LightRAG LLM route that graph and hybrid modes need (`shunt login xai` or `hermes auth add xai-oauth --type oauth`, plus a network path from Railway).
- Funding the anchor key and the first live re-anchor rehearsal (also what makes Doc Proofs anchored rather than `unanchored`).
- Deploying main: production runs release `5cf930a0`, which lacks every PR from #142 on; the v1.7 operator steps (first corpus ingest, staged timers) need that deploy.

## What this is

Four planes — runtime, memory, skills, ledger — bound by **MCP** for agent-to-substrate and
**ACP** for client-to-agent, so that every agent on this VPS shares one briefing, one event
log, one skills library and one task key.

Agents in scope: Claude Code, Codex, OpenCode, Pi (Lane A, rivet-agentos) · Hermes, Omp,
Muse Code, Grok Build (Lane B, Orca) · Cursor and Grok Bot (Lane C).

## The task key

`claude-ultrathink` already mints a **Graph ID** — `ut-<ts36>-<8hex>` — for every uplifted
prompt, and writes:

- one Notion **Task** row per prompt,
- one Linear **issue** per Graph-of-Thought node (`n1`…`n8`),
- one Linear **sub-issue** per Chain-of-Thought step.

The substrate adopts that key unchanged. Every event, memory entry, claim and session carries
`graph_id`; node-level work also carries `linear_identifier` (`SWC-123`) and `node_id`;
step-level work carries `step`.

Notion and Linear stay the **source of truth**. Postgres is only an index — a cache so the
brief does not call either API on every prompt.

## Components

| Package | Language | Role |
|---|---|---|
| `mcp-server` | TS | `substrate-mcp` on `127.0.0.1:7410` — brief, memory, events, graph, skills, docs, desktop. MCP streamable HTTP **plus** `POST /brief` and `POST /events` for hooks |
| `cli` | TS | `substrate brief \| emit \| run \| verify` |
| `host` | TS | rivet-agentos host; `openTask` keyed by Graph ID |
| `dispatcher` | Py | Linear `dispatch:<surface>` label → session |
| `collectors` | TS | Orca tee, grok tail, muse tail, git post-commit, agentos stream |
| `projector` | TS | `substrate.yaml` → per-agent config, hook appends, symlinks |
| `ledger` | TS | Greptime writer, hourly Merkle anchor, verify |
| `connector-ext` | Py | grok-hermes-connector v0.4 forwarding tools (lands in repo `mcp`) |
| `miner` | Py | Hermes cron job; staged-skill → PR watcher |

## Data

Revised 2026-09-30 — policy in `docs/data-planes.md`, network in `docs/railway-tailscale.md`.

- **Railway project "Ultrathink"** — **TimescaleDB (index and coordination)**: plain Postgres
  tables with no hypertables, continuous aggregates or Timescale policies (0 hypertables
  measured 2026-10-13, `docs/data-planes.md`): `graph_index`, `graph_nodes`, `graph_steps`, the
  memory index (`memory_entries` and the governance tables). The Programming Desk tables
  (`desk_intake`, `desk_claims`, `desk_idempotency`, `desk_receipts`, `seat_roster`,
  `tool_pack_state`) are **not in this repository**; earlier revisions of this line called some
  of them hypertables, which this repository cannot support. **GreptimeDB (events)**: the
  append-only authoritative event ledger, `agent_events` with a `hash`/`prev` chain
  (`docs/adr/0004-store-roles.md`).
  **DragonflyDB (cache only)**: brief, search and recall caches, rate counters; falls through on
  outage (owner decision 2026-09-26 stands).
- **Railway project "Agent Substrate"** — **Hindsight (memory)**: banks `sub-<surface>` and
  `pd-<seat>`; replaces Agentmemory (Phase 7) and the local Claude Code `hindsight` stdio server.
  **RAGFlow (docs)**: was behind `docs_search`; **the RAGFlow service was deleted on 2026-10-25**.
  **LightRAG** is the docs plane since the 2026-10-28 cutover (Run 11: v1.5.7 on a dedicated pgvector Postgres,
  naive query mode on the LLM bypass service; graph and hybrid modes wait on the operator's LLM route; `docs/runbooks/lightrag-storage-topology.md`, `docs/docs-plane.md`).
- All five are reached from the VPS over a Tailscale Forwarder deployed inside each project; no
  public TCP proxy or public database domain after cutover.
- **Langfuse** keeps LLM traces; Greptime holds the substrate's own log. No duplication.
- The Programming Desk consumes these planes through its own gateway on the VPS
  (`desk.swcstudio.space`, loopback `:8791`), which calls `substrate-mcp` over loopback with
  `SUBSTRATE_TOKEN_DESK_GATEWAY`; Grok Bots never hold plane credentials.

## Departures from the Notion brief (§11), carried forward

- The Autonogrammer client is out of scope. Dispatch is a **Linear label**; the board is the
  Notion Command Center; ACP's client role is held by `substrate-dispatcher`.
- **No new planning layer.** The ultrathink family already does uplift, graph, tracking and
  idempotency by Graph ID. The substrate adds one fetch and three calls.
- **Orca before herdr.** Orca already runs and already hooks five agents.
- Grok Bot goes through the existing `grok-hermes-connector` (OAuth, redactor, audit log).
- The skills library is `/root/agent-skills`; the three existing miners are redirected, not
  replaced.
- `rivet-agentos` is named that way everywhere, to avoid the Agno `agentos-api` container on
  the same host.
- Solana **devnet**, not testnet. Roots only, never event contents.

## Corrections found on the VPS (2026-09-23)

- `claude-ultrathink` is **enabled**, not disabled — Notion §1 is stale on this point.
- `/root/agent-skills` is **not** a git checkout: 14 real dirs + 26 symlinks pointing into
  `/root/.openclaw/.../docs-scraper/exports/skills/` and `/root/.hermes/skills/`. Phase 4
  vendors the real content.
- RAGFlow and GreptimeDB are on a **Railway account this MCP connection cannot see**. Both are
  consumed as external endpoints via `/etc/substrate/substrate.env`.
- Ports 7410 and 6420 are free. Disk is at 90% (40 GB free) — gates Phase 3.

## Constraints

- **Hooks fail open.** A substrate outage must never block a prompt on any surface.
  `fetchBrief` returns `""` on any error, with a 1.5 s timeout.
- **Hooks cannot call MCP tools**, which is why `/brief` and `/events` are also plain HTTP.
- **Redact before emitting.** Reuse the connector's `redactor.py` patterns. No Linear, Notion,
  Railway or Greptime credentials in `agent_events`.
- **No KVM on this host** — cua runs the Docker path; the QEMU path is out.
- Secrets live in `/etc/substrate/substrate.env` (0600, root), never in the repo.

## Validated

- ✓ Swarm identity: 15 per-surface swarm tokens; cross-surface emit/claim refused (REST 403 / MCP `isError`), other surfaces unchanged — v1.1
- ✓ Binding: `graph_bind` (MCP-only) binds correlation id ↔ Graph ID, race-safe with one winner; binding notes in their own session keep `events_verify` green — v1.1
- ✓ Tee: swarm run log teed per agent, 13 swarm types mapped to existing `EVENT_KINDS`, deduped, fail-open; hardened transport (no redirects, deadline, proxies, dry runs never tee) — v1.1
- ✓ Graph ID: `orch_plan` mints, binds and registers one Graph ID per run — v1.1
- ✓ Memory: swarm memory through the governance gate (kind/scope maps, idempotency key, every gate outcome handled, ok only when accepted and verified_persisted); versioned conflicts carry `current_version` — v1.1
- ✓ ultrathink: one fail-open `note` event with the Graph ID after planning, session `<host session>:<graph id>` — v1.1
- ✓ Proof: live end-to-end 24/24 and 7/7 on real Postgres + GreptimeDB, plus the 8.1 regression — v1.1
- ✓ Lease authority: holder-only `lease_id`, `not-holder` refusals on heartbeat/release/complete, swarm tokens never operators — v1.2
- ✓ Swarm lease bridge: claim before dispatch, heartbeat, complete on DONE, release and re-claim on rework; one grant per node across replicas — v1.2
- ✓ Signed handoffs: one `coord_handoff` packet per accountable-agent boundary; context rebuilt from `coord_handoff_list` and `events_query` alone — v1.2
- ✓ Workspace install: per-runtime `substrate-mcp` entries, 0600 per-agent token files, one token per child — v1.2
- ✓ Lessons bank: governed lesson facts with recall citations, read-time scores and non-destructive digests — v1.2
- ✓ Rehearsal harness: `bun run rehearsal up|smoke|down` runs main's `substrate-mcp` against scratch Postgres and GreptimeDB with per-surface tokens; production stores saw no harness row — v1.3 Phase 16
- ✓ Production parity: `substrate-mcp.service` owns `127.0.0.1:7410` and serves `main`; `bun run parity:check` and `docs/runbooks/production-parity.md` record the check and the rollback — v1.3 Phase 16
- ✓ Event vocabulary: every v1.3 event source maps onto the unchanged `EVENT_KINDS`; host jobs emit as the one added system surface `substrate`, whose token is never an operator; `bun run check:phase-close` pins both — v1.3 Phase 17
- ✓ Audit policy: every MCP tool v1.3 adds has a fail-open or fail-closed entry before it ships, with a test that catches a missing or contrary entry — v1.3 Phase 17
- ✓ Shared redactor: one `redact.ts` with the September D-04 shapes, main's `COUNTER_KEY` exemption and a digit-requiring `pk-`/`rk-` rule guards events, memory, lessons and skill content; `redact-lock.test.ts` fails the build when any package redacts another way — v1.3 Phase 18

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| A swarm token emitting or claiming as another swarm surface is refused, never re-attributed | Token names the caller; silent re-attribution would corrupt attribution | ✓ Good |
| `graph_bind` is MCP-only; no new event kinds, no `POST /graph` door | ADR 0001 forbids a single agent-swarm surface, new event kinds and a `POST /graph` door | ✓ Good |
| Versioned conflicts report `current_version` instead of adding a subject search filter | `memory_search` matches bodies only and returns the newest 100 per scope; the re-read stays only as the older-server fallback | ✓ Good |
| Production parity is the operator's action; agents only read (`parity:check`) and run approved read-only probes | Killing or restarting production processes from an agent session is unrecoverable if wrong; the unit gains `ConditionPathExists` instead of crash-looping | ✓ Good (v1.3 Phase 16) |
| Host jobs get one system surface, `substrate`, instead of borrowing an agent surface | The surface is what briefs and `events_query` show as the actor; borrowing claude-code would misattribute anchors and dispatches (operator, 2026-10-08) | ✓ Good (v1.3 Phase 17) |
| The `pk-`/`rk-` redaction rule requires a digit in the key | Real keys (Langfuse `pk-lf-...`) contain digits; the verbatim September rule also redacted ordinary hyphenated slugs of 20+ characters and quarantined memory text containing them (operator, 2026-10-08) | ✓ Good (v1.3 Phase 18) |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-10-31 for v1.8 and Phase 71 local verification; external sign-off remains pending*
