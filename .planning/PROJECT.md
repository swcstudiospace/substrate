# Project: Agent Substrate

**Source of truth for architecture:** [Agent Substrate — Build Plan](https://app.notion.com/p/3e4bc1a0c7ae81baafffd1ebd773123d) (Draft v0.2)
**Control plane:** Notion "Agent Task Graph" + Linear team Spectrum Web Co
**Repo:** `swcstudiospace/agent-substrate` (private)

## Current Milestone: v1.3 Build plan completion

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

**Key context:** The September implementation lives on `docs/data-planes-tailscale` (`acc30a8`) and is ported file by file onto `main`'s v1.2 lease model; `21652a2` is treated as stubs. The crash-loop/stray-process state recorded at milestone planning preceded Phase 16 and is historical, not the current service verdict. Current isolated integration has seven canonically verified phases; source corrections at `76a4b2c` are not a production deployment or main merge. Every production/store/devnet/client-install action retains its explicit operator gate.

Shipped before: **v1.2 Swarm leases, workspace install and lessons bank** (2026-10-08; phases 11-15; 25/25 requirements).

## Current State

Shipped **v1.2** (2026-10-08): ADR 0001 S2 (SPE-5053), S4 (SPE-5055) and lessons-bank Tier 1 (SPE-5830).

- **Lease authority:** swarm sessions name their own agent, replica and graph; a `lease_id` reaches only its holder; only the holder's surface can beat, release or complete; a swarm token is never an operator. agent-substrate #16.
- **Swarm lease bridge and signed handoffs:** the runner claims, heartbeats, completes or releases each task's node under a lease for the executing agent; accountable-agent boundaries write signed `coord_handoff` packets that rebuild context from the ledger alone. agent-swarm #9, #10.
- **Workspace install:** one `substrate-mcp` entry per runtime naming the token variable, a 0600 token file per agent outside every checkout, each child given only its own `SUBSTRATE_TOKEN`. agent-substrate #18; agent-swarm #11.
- **Lessons bank:** `substrate lessons add | recall | digest | outcome` over governed `fact` entries, scores computed at read time. agent-substrate #17.

Shipped **v1.1** (2026-10-07): swarm identities and `graph_bind`, the swarm orchestrate tee, governed swarm memory and the ultrathink plan record (ADR 0001 S1 and S3).

## Next Milestone Goals

Candidates after v1.3, not commitments:

- ADR S5 gate verdicts as events (SPE-5056).
- Lessons bank Tier 2: phase lifecycle events, realtime delivery, an outbox and automatic injection at the GSD discuss step.

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

- **Railway project "Ultrathink"** — **TimescaleDB (index and coordination)**: `graph_index`,
  `graph_nodes`, `graph_steps`, memory index, and the Programming Desk tables (`desk_intake`
  queue, `desk_claims`, `desk_idempotency`, `desk_receipts`, `seat_roster`, `tool_pack_state`,
  hypertables). **GreptimeDB (events)**: append-only `agent_events` with a `hash`/`prev` chain.
  **DragonflyDB (cache only)**: brief, search and recall caches, rate counters; falls through on
  outage (owner decision 2026-09-26 stands).
- **Railway project "Agent Substrate"** — **Hindsight (memory)**: banks `sub-<surface>` and
  `pd-<seat>`; replaces Agentmemory (Phase 7) and the local Claude Code `hindsight` stdio server.
  **RAGFlow (docs)**: behind `docs_search`; datasets per repo (Phase 5 docs half re-opened).
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
- ✓ Lane B collectors: snapshot-reconciled herdr events, redacted Muse briefs, installed-bundle Muse hooks and hardened Cursor stop transcripts; actual isolated named-herdr/installed-Muse proof 41/41 with zero refusals — v1.3 Phase 19, branch verification; production cutover remains operator-owned.
- ✓ Skill proposals: three authenticated/audited doors, caller-body1MB boundary without attribution budget loss, safe dedupe/recovery/dry-run and user-approved fixed Git isolation; actual real-Git/recording-gh proof47/47 — v1.3 Phase21 branch verification; first real library PR/owner merge belongs Phase22.
- ✓ Ledger primitives/ingest order: RFC6962 roots, server-stamped membership, fresh cross-hour retry and bounded redacted failure diagnostics; actual v0.14.4 scratch47/47 including19 fake-chain checks — v1.3 Phase27; production v1.1.4 and devnet follow-ons remain operator-owned.
- ✓ Desktop: three measured real fresh-as-ported pixel repeats and separate corrected MCP20/20,9120 solid480×19 pixels/baseline0, hash-only events/images, fail-closed locality/audit/token gates and authoritative unchanged absence — v1.3 Phase30 branch verification; historical18/20 remains failed.
- ✓ Latest shared branch gate:2718pass/58skip/0fail across96files, types0, credential/vocabulary locks108pass/0fail, bash syntax0/shellcheck0. Phase20 has names-only metadata0/PASS and a recovered159-test client, not installed-client/rotation/soak/production-UAT acceptance.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| A swarm token emitting or claiming as another swarm surface is refused, never re-attributed | Token names the caller; silent re-attribution would corrupt attribution | ✓ Good |
| `graph_bind` is MCP-only; no new event kinds, no `POST /graph` door | ADR 0001 forbids a single agent-swarm surface, new event kinds and a `POST /graph` door | ✓ Good |
| Versioned conflicts report `current_version` instead of adding a subject search filter | `memory_search` matches bodies only and returns the newest 100 per scope; the re-read stays only as the older-server fallback | ✓ Good |
| Production parity is the operator's action; agents only read (`parity:check`) and run approved read-only probes | Killing or restarting production processes from an agent session is unrecoverable if wrong; the unit gains `ConditionPathExists` instead of crash-looping | ✓ Good (v1.3 Phase 16) |
| Host jobs get one system surface, `substrate`, instead of borrowing an agent surface | The surface is what briefs and `events_query` show as the actor; borrowing claude-code would misattribute anchors and dispatches (operator, 2026-10-08) | ✓ Good (v1.3 Phase 17) |
| The `pk-`/`rk-` redaction rule requires a digit in the key | Real keys (Langfuse `pk-lf-...`) contain digits; the verbatim September rule also redacted ordinary hyphenated slugs of 20+ characters and quarantined memory text containing them (operator, 2026-10-08) | ✓ Good (v1.3 Phase 18) |
| Real runtime proof is not interchangeable with fixture-only collector coverage | Named herdr lifecycle and installed Muse hook-test exercise the actual protocol and approval boundaries without models or production stores | ✓ Verified (v1.3 Phase 19, 41/41 isolated proof) |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (internal transition workflow):
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
*Last updated: 2026-10-11 after Phases21,27,30; milestone remains active7/18 with operator checkpoints*
