# Feature Research

**Domain:** Agent Substrate v1.3 "Build plan completion": the shared runtime, memory, skills and ledger planes for every agent on one VPS. It is keyed by ultrathink Graph IDs, and Notion and Linear are the control plane.
**Researched:** 2026-10-08
**Confidence:** HIGH for what exists, which was checked in git objects, unit files and host state. MEDIUM for port effort and design choices. Anything not checked is marked [UNVERIFIED], and conclusions drawn without direct observation are marked [INFERENCE].

**Users:**
- the operator (Ove);
- the agent surfaces (Claude Code, Hermes, Omp, Muse Code, Grok Build, Cursor, Grok Bot);
- the Programming Desk, which calls the substrate through its gateway.

**Sources of truth:**
- Notion Build Plan v0.2 §3–§7 and the §10 build order (`local://build-plan-v02.md`), plus the v0.3 addendum (`local://build-plan-v03.md`).
- `docs/data-planes.md`.
- `.planning/PROJECT.md` § "Current Milestone: v1.3".

**Area labels used throughout:**
- **A** Lane B collectors
- **B** claim mirror
- **C** dispatcher
- **D** docs plane
- **E** ledger anchor
- **F** skills plane
- **G** `desktop_run`
- **H** Lane A
- **I** Phase 0 UAT

## Baseline: what main and the host already have

### On main (`ab62c91`): what the new features build on

The other tables cite these rows by their IDs (M1, M2, …).

| ID | Capability on main | Where | Areas that build on it |
|---|---|---|---|
| M1 | **v1.2 lease authority**: `graph_claim` takes a lease (CAS on `lease_epoch`, TTL default 900 s, holder = surface + `session_id`). Only the holder ever sees the `lease_id`. Heartbeat, release and complete are fenced on `lease_id` and the token's surface; complete is a single statement. Only an operator token may `force`. A release emits `note`; a steal or an expiry emits `warning` | `packages/mcp-server/src/{lease,index-store,service}.ts`, `docs/coordination.md` | B, C, H |
| M2 | Signed HMAC handoff packets, `coord_drift_scan` and graph edges. The edges live **only in the index** and are not mirrored to Linear (`docs/coordination.md:321-325`) | `handoff.ts`, `drift.ts` | B, C |
| M3 | Memory governance gate with 5 stages and default-deny RBAC. The reply is `accepted` / `conflict` / `quarantined` / `denied`, plus `verified_persisted`. **`teachable` is refused as a kind** (`docs/memory-governance.md:80`) | `memory-{policy,classify,write}.ts` | D, F |
| M4 | Hash-chained MCP + REST audit; arguments are never stored. It is **in memory only** unless `SUBSTRATE_AUDIT_PATH` is set (`docs/mcp-audit.md`) | `packages/audit` | every new tool |
| M5 | OTLP metrics and traces, SLOs, `/metrics`, `/slo` | `packages/observability` | A, D |
| M6 | Evidence bundle: `substrate evidence --graph`, `POST /evidence` | `packages/evidence` | B, E |
| M7 | Lessons bank: `substrate lessons add / recall / digest / outcome` over governed `fact` entries | `docs/lessons-bank.md` | F (the boundary between lessons and skills) |
| M8 | Greptime ledger:<br>• append-only guard; only `select / insert / create / show / describe / explain / with` pass (`greptime.ts:197`)<br>• **per-session** hash chain<br>• `substrate verify`<br>• `anchors` DDL, keyed by root with 5 columns; nothing writes it (`greptime.ts:391-398`) | `greptime.ts`, `event.ts`, `docs/greptime-ledger.md` | E, A |
| M9 | **Store lock**:<br>• only `packages/mcp-server/src` (plus `scripts/greptime-smoke.ts`) may import the Greptime client, name `agent_events` in SQL or read `GREPTIME_*`<br>• only `greptime.ts` and `brief.ts` compose SQL | `store-lock.test.ts:22-41,107-156` | E, D |
| M10 | **Closed vocabularies**: 11 agent surfaces plus the swarm surfaces, and 12 event kinds. `normalizeEvent` rejects any unknown surface or kind (`types.ts:30-63`, `event.ts:124-131`) | `types.ts` | A, B, D, F, G |
| M11 | **Identity**: `SUBSTRATE_TOKEN_<SURFACE>` maps a token to a surface. Anonymous calls are allowed **only when no tokens are configured** (`config.ts:120-127,173-182`). The v1.2 workspace install gives each agent a 0600 token file (`docs/swarm-workspace.md`) | `config.ts`, `projector/src/swarm-workspace.ts` | B, C, F, G, H |
| M12 | CLI: `brief [--write]` writes `.substrate/BRIEF.md`; also `run <surface>`, `verify`, `drift`, `handoff`, `evidence`, `lessons` | `packages/cli/src/index.ts:76-160` | A, E, I |
| M13 | Cursor projector: appends `sessionStart` / `postToolUse` / `stop` commands to `hooks.json` | `projector/src/cursor.ts:44-46` | F, I |
| M14 | Notion-rows → index backfill. It takes rows as JSON and contains no Notion client | `backfill.ts`, `backfill-run.ts` | I |
| M15 | 19 MCP tools: `memory_*`, `events_*`, `graph_{get,register,bind,claim,heartbeat,release,complete}`, `coord_*`. REST: `/healthz /metrics /slo /evidence /brief /events /events/query /memory /handoff /drift /verify /mcp` | `mcp.ts`, `server.ts` | all |

**Not on main:**
- a Linear or Notion client: `LINEAR_API_KEY` and `NOTION_API_KEY` are read by `config.ts:170-171` and used by nothing;
- the dispatcher and the miner;
- the herdr and Muse collectors, the Muse projector and `cursor-stop`;
- skills, docs/RAG-backend, Hindsight, Dragonfly and desktop;
- the anchor job and the Lane A host. `packages/host` and `packages/ledger` hold only a `package.json`.

### Production state that changes the work (read-only checks, 2026-10-08)

| ID | Fact | Evidence | Consequence |
|---|---|---|---|
| P1 | `substrate-mcp` runs main and has been active since 16:27:21 UTC. Its only env file, `/etc/substrate/substrate.env`, defines **no** `SUBSTRATE_TOKEN_*`, `SUBSTRATE_OPERATOR_TOKENS`, `SUBSTRATE_HANDOFF_KEY` or `SUBSTRATE_AUDIT_PATH` (variable names checked, values not read) | `systemctl show substrate-mcp`; grep of variable names | Production runs **anonymous** (`config.ts:176`):<br>• handoffs are recorded unsigned (`coordination.md:231-233`)<br>• the audit chain lives in memory<br>• operator `force` is unavailable<br>The v1.2 identity features exist on main but are not switched on in production. |
| P2 | Three units run September code **from memory**, and their source is gone from the checkout:<br>• `substrate-collector-herdr` and `substrate-collector-muse`, active since 2026-09-29 16:39 UTC<br>• `substrate-dispatcher`, active since 2026-10-08 10:47:59 UTC, with `PYTHONPATH=…/packages/dispatcher/src`, which now holds only `__pycache__`; the journal says "dispatch disabled" on every tick | `systemctl show`, `systemctl cat`, `journalctl` | Any restart or reboot fails. The dispatcher unit has `Restart=always`, `RestartSec=5` and `StartLimitIntervalSec=0`, so it would crash-loop. For A, C and F the work is **restore and port**, not greenfield. |
| P3 | Live producers now send vocabulary that main rejects:<br>• the herdr collector: surface `herdr`, kinds `agent.*`<br>• the Muse writer: `brief.delivered`<br>• hermes-engineering-board: surface `hermes-eng-board` (`substrate_client.py:24`) | `event.ts:124-131`, `types.ts:30-63` | Their events are refused (4xx), and the fail-open clients swallow the refusal, so the events are lost [INFERENCE; no live call made]. |
| P4 | Broken skills pipeline:<br>• `substrate-skills-sync` and `substrate-skills-bridge` exit non-zero every 5 min<br>• Hermes cron `substrate-skill-miner` (`0c172431cf5b`) has `failure_streak 198`, error "No module named substrate_miner.__main__"<br>• 4 proposals are staged in `~/.hermes/pending/skills`<br>• `~/.omp/agent/extensions/substrate-skills.ts` is a dangling symlink into the checkout | `systemctl show`, `~/.hermes/cron/jobs.json` | The skills plane has been down since about 2026-09-30 [INFERENCE from 198 hourly failures and the 09-30 checkout switch in the reflog]. |
| P5 | `/root/.cursor/hooks.json` has 3 substrate-managed entries. The `stop` entry runs `packages/collectors/src/cursor-stop.ts`, which is absent on main, and swallows the failure (`… \|\| true`) | `hooks.json` | No Cursor `session.end` events and no transcripts reach the miner. This blocks the F proof and UAT scenario 6. |
| P6 | Host resources:<br>• `substrate-host` is inactive<br>• the `substrate-desktop` container (`linuxserver/webtop:ubuntu-xfce`) is up on loopback :6081<br>• the only Docker runtime is runc (no gVisor/runsc)<br>• there is no `/dev/kvm`<br>• `/` is 95% used, with 22 GB free | `systemctl`, `docker ps`, `docker info`, `df` | The Lane A image build needs the disk gate. cua's newer default (gVisor) and the QEMU path both fail on this host. |
| P7 | Neither Railway Tailscale forwarder is on the tailnet:<br>• RAG-backend and Hindsight are reached only over public HTTPS<br>• `DRAGONFLY_URL` is plaintext `redis://` with a password, pointing at a non-tailnet address | `tailscale status`, URL shapes only (PlanesDigest scout) | The `docs/railway-tailscale.md` cutover has not happened. Dragonfly cannot be used until the hop is private. |
| P8 | `grok-hermes-connector` has been active since 2026-10-01 06:40 UTC from the `/root/src/repos/mcp` working tree. That branch holds the v0.4 commits and is 4 commits ahead of origin | `systemctl show`, `git status -sb` | Connector v0.4 is live but unpushed. |
| P9 | herdr 0.9.1 runs as a bare `herdr server` process, not a unit. Its CLI has `agent start / prompt / wait / read`, `worktree create / open` and `api snapshot / schema` | `herdr --version`, `herdr agent --help` | herdr can host dispatched sessions (A-D2). |
| P10 | Claude Code:<br>• the ultrathink plugin 0.3.0 is enabled (`gitCommitSha 85ca1ac`, a local-only branch)<br>• no MCP server is named `substrate`, globally or in any project, in `~/.claude.json`<br>• a `hindsight` MCP server is registered globally | `installed_plugins.json`, `~/.claude.json` | The kickoff `graph_register` never fires (UAT scenario 5). |
| P11 | Linear Free plan caps active issues at 250, and the cap was hit in September. There are two workspaces, with team keys SWC (the connector) and SPE (the backfilled nodes) | `acc30a8:.planning/phases/02-claims-and-dispatch/02-LINEAR-ARCHIVED.md` | Proof issues need free slots. Identifiers must not be hard-coded. |
| P12 | The devnet key `/etc/substrate/ledger-devnet.json` exists. In September it held 0 lamports: RPC airdrops were refused and the PoW faucet did not build. The owner skipped anchoring (D-17) | `acc30a8:.planning/phases/06-ledger/06-CONTEXT.md:80` | E's live proof needs a funded key. Today's balance is [UNVERIFIED]. |

The ledger now probably mixes two chain semantics:
- The September global ingest chain went live on 2026-09-27 (`06-05-CUTOVER.md`).
- Main chains per session.

Graphs with events from that window may report breaks under main's `events_verify` [INFERENCE; not run]. This touches UAT scenario 1 (`/verify`) and E.

### Port sources

| Ref | What it is | Use |
|---|---|---|
| `acc30a8`, branch `docs/data-planes-tailscale` | 276 commits not in main, merge-base `31d236a` (2026-09-24); it is `6708cc3` plus one docs commit (operator reflog). It holds real GSD runs of phases 01–06 with live proofs:<br>• 01: passed, 10/10<br>• 02: proof run 5 approved<br>• 03: gaps_found, 83/91<br>• 04: passed, 6/6<br>• 05: gaps_found, 22/25 (docs half skipped)<br>• 06: gaps_found, 46/48 (anchoring skipped)<br>• 07: gaps_found, 14/19 (skipped)<br>• 08: planned, 0/7<br>Its code is 124 files and about 35.7k insertions under `packages/` and `infra/`. **It is built on the pre-lease claim model** (no `lease.ts`). | Primary port source. Use its contracts and tests; rebase every claim path on M1. |
| `21652a2`, branch `claude/greptime-events-ledger-7j1so8` (2026-10-02) | An autonomous stub run:<br>• `planes.ts`: RAG-backend retrieval with no `dataset_ids` that returns the raw body; Hindsight recall run inside the brief with a 4 s timeout; a Dragonfly RESP client that is never called; a devnet memo<br>• `teachable.ts` stubs<br>• `graph_handoff` with `prev_event_hash: "TODO-chain"` | Do not cherry-pick it. At most, use it as a list of names. |
| `/root/src/worktrees/agent-substrate-p15` | A read-only view of `6708cc3` on disk | Convenient for reading. |

## Feature Landscape

### Table Stakes (Users Expect These)

Missing any of these means the area's build-plan proof cannot pass, or the area stays broken in production.

#### A. Lane B collectors: herdr, Muse, Muse projector (area complexity: MEDIUM)

| ID | Feature | Why Expected | Complexity | Depends on (main) | Notes |
|---|---|---|---|---|---|
| A-T1 | The herdr collector lands on main as a systemd unit:<br>• bootstrap with `session.snapshot`<br>• one `events.subscribe` per pane connection (`pane.agent_detected`, `agent_status_changed`, `exited`)<br>• reconcile every 5 s, with dedupe offsets<br>• fail-open `POST /events` | The owner made herdr the persistent Lane B runtime (`milestones/v1.0-phases/01-lane-b/CONTEXT.md`, corrected 2026-09-24). The unit is live from memory (P2). | MEDIUM | M10, M11, M15, `redact.ts` | Port `acc30a8:packages/collectors/src/{herdr,herdr-map}.ts` (+7 tests) and `infra/vps/substrate-collector-herdr.service`. Two limits found live on herdr 0.9.1: a second subscribe resets the connection, and one bad `pane_id` kills the call. |
| A-T2 | Herdr events speak main's vocabulary:<br>• surface = the agent herdr detected<br>• repo = the slug of the pane cwd's origin<br>• kinds map onto existing kinds: detected → `session.start`, exited → `session.end`, status → `note` with `payload.status` and `runtime: herdr` | Main rejects `herdr` and `agent.*` (P3). The brief reads by repo slug. In September repo was a path (Phase 1 D-02), so herdr rows never reached a brief. | LOW-MEDIUM | M10, M12 (the `repoSlug` pattern) | This follows the v1.1 precedent, which mapped 13 swarm types onto the existing kinds (PROJECT.md Validated). |
| A-T3 | The Muse brief writer, for each repo in `SUBSTRATE_MUSE_REPOS`:<br>• calls `POST /brief` (surface `muse`, repo **slug**)<br>• writes a redacted `<repo>/.substrate/BRIEF.md` and an idempotent AGENTS.md pointer<br>• refreshes every 5 min, keeping the last good file on failure | Build plan §5.4: `.substrate/BRIEF.md` is the fallback for every surface, and Muse has no hook API. | LOW | M12 (`brief --write` writes the same file), M15 | Port `acc30a8:packages/collectors/src/muse.ts` (+7 tests) and its unit. Replace `brief.delivered` with `note` (P3). September keyed the brief by checkout path while events were keyed by slug, so they never met (`01-10-PROOF.md`). |
| A-T4 | The Muse native plugin is projected and approved; its PostToolUse hook emits `tool.call` (surface `muse`, repo and branch from git) | This is the §5.4 Muse emit path. Muse's plugin CLI (`muse plugins validate / install / approve`) was verified live in September. | MEDIUM | M10, M15 | Port `acc30a8:packages/projector/src/muse.ts`. The installed hook imports `redact.ts` from the operator checkout by absolute path; give it a stable path instead. |
| A-T5 | Fail-open and restart-safe:<br>• collectors never block an agent<br>• offsets survive restarts<br>• refused emits are counted, not silently dropped | "Hooks fail open" (PROJECT.md Constraints). September's fail-open emit hid 400s (01-04 deviation 3), which is how P3 went unnoticed. | LOW | M5 | Publish a count or periodic warning of refused emits. |

#### B. Claim mirror to Linear and Notion, and the DoD gate (area complexity: HIGH)

| ID | Feature | Why Expected | Complexity | Depends on (main) | Notes |
|---|---|---|---|---|---|
| B-T1 | A Linear GraphQL client inside substrate-mcp:<br>• issue context<br>• the workflow state by **type** per team<br>• `ensureLabel` (team, then workspace, then create)<br>• additive label edits only<br>• comments with an idempotency check | Prerequisite: main has no Linear client (`docs/coordination.md:321-325`). | MEDIUM | M11 | Port `acc30a8:packages/mcp-server/src/linear.ts` (225 lines). Resolve every state through the issue's own team, because SWC and SPE are different workspaces (P11). |
| B-T2 | Claim grant or reclaim mirrors to the trackers:<br>• Linear moves to the first `started` state<br>• `agent:<surface>` is added and every `dispatch:*` removed, in **one** `issueUpdate`<br>• one comment per session: `Claimed by <surface> — session <sid> (graph <g>, node <n>)`<br>• the Notion Issue row's `Agent` is set to the surface | Build plan §3.3, and the v1.3 target. | MEDIUM | M1 (hook the `granted` and `reclaimed` decisions), M11 (take the surface from the token) | Port `acc30a8:packages/mcp-server/src/mirror.ts`. **Never put a `lease_id` in Linear or Notion**: only the holder may see it (`coordination.md:64-104`). |
| B-T3 | Every other lease transition on main is mirrored too:<br>• renewed → no-op<br>• stolen → move the label to the new holder<br>• released, reaped by `coord_reap_leases`, or operator-forced → Linear back to `unstarted`, `agent:*` removed, Notion `Agent` cleared | Main's leases end in ways September never had (TTL expiry, steal, force). Without this, Linear keeps showing a stale In Progress. | MEDIUM-HIGH | M1, M2 | New work. September mirrored only claim, release, review and done, on the pre-lease model. |
| B-T4 | `graph_complete` passes the DoD gate:<br>1. the node goes to `started_review` and Linear to In Review<br>2. `POST {HERMES_LINEAR_URL}/v1/complete-issue` with `{linear_issue_id, summary, tests_pass, review_pass}`<br>3. **only the connector** moves the issue to Done<br>4. on refusal or error the node stays in review and the lease is kept<br>5. then main's one-statement fenced completion runs | §3.3: "completion still goes through the Definition-of-Done gate that hermes-linear-connector enforces". | HIGH | M1 (single-statement complete, `lease_id` fence), M4, M6 | Port `acc30a8:packages/mcp-server/src/dod-gate.ts` (91 lines, 35 s timeout, fail-closed). The connector route exists at `hermes-linear-connector@6e532fe` `webhook_app.py:126` and runs as `hermes-linear-api` on :8792, but it is unpushed. Do not reuse the name `dod`: handoff packets already use `dod` as a `string[]`. |
| B-T5 | Failure semantics:<br>• the lease is authoritative and is never rolled back when a mirror write fails<br>• each failed target produces one `warning` event `{target, action, reason}`<br>• a losing claimant writes nothing<br>• startup logs `mirror: linear on/off, notion on/off` | September D-02 and D-04. A tracker outage must never block an agent. | LOW-MEDIUM | M8, M10 | Tests exist: `acc30a8:packages/mcp-server/src/mirror.test.ts`, 442 lines. |
| B-T6 | Notion writes are limited to **Agent / Status / Linear State / Completed**, only on Issue rows whose parent data source is the Agent Task Graph (`NOTION_TASK_GRAPH_DS`), and always as GET then PATCH | The Notion PAT is workspace-wide (02-06 deviation 1). PR fields and Task rows belong to `ultrathink-sync` (D-07). | MEDIUM | M14 (`config.ts:172` already holds the data source id) | Port `acc30a8:packages/mcp-server/src/notion.ts` (Notion-Version 2025-09-03). |
| B-T7 | `graph_find` maps a Linear id or identifier to a node, returning `found:false` for zero or several matches. `issue_get` returns the issue text redacted, capped and framed as untrusted | The dispatcher (C) and Lane A (H) need both. Neither is among main's 19 tools. | LOW-MEDIUM | M1 (strip lease ids from node payloads), M4 | Port from `acc30a8` `service.ts` and `mcp.ts`. |

#### C. substrate-dispatcher (area complexity: HIGH)

| ID | Feature | Why Expected | Complexity | Depends on (main) | Notes |
|---|---|---|---|---|---|
| C-T1 | A polling loop on main:<br>• every 30 s, fetch unstarted issues carrying a `dispatch:` label<br>• a flock keeps it single-instance<br>• the kill switch `SUBSTRATE_DISPATCH_DISABLED` is re-read every tick and **defaults on** outside proof windows<br>• runs as a systemd unit | §3.4. September D-10 chose polling because there is no public ingress. The unit is live from memory (P2). | MEDIUM | — | Port `acc30a8:packages/dispatcher` (Python: `dispatch`, `launcher`, `linear`, `mcp`, `sessions`, `worktree`, `host`, `__main__`; 7 test files) and `infra/vps/substrate-dispatcher.service`. |
| C-T2 | A decision table backed by once-only marker comments: `not-dispatchable`, `no-node`, `already-claimed`, `low-disk`, `no-checkout`, `path-conflict`, `git-failed`, `host-refused`/`host-unreachable`, `exited-unclaimed`, `claim-timeout` | The operator can see what happened from Linear, without log access. | MEDIUM | B-T7, M1 | A marker is posted only if none of the last 50 comments already carries it. |
| C-T3 | A per-Graph-ID worktree at `/var/lib/substrate/worktrees/<graph_id>` on branch `substrate/<graph_id>`:<br>• reused if present<br>• the repo is verified by its origin URL<br>• refused under 5 GiB free | §3.4: "inside a per-Graph-ID worktree". The disk is 95% full (P6). | MEDIUM | — | Port `worktree.py` (D-12). |
| C-T4 | Launchers:<br>• `hermes`: headless `hermes chat --query-file … -Q --pass-session-id --source substrate-dispatcher --max-turns 60 --run-budget 3600 -t terminal,file`, with an allowlisted environment<br>• `claude-code`: the Lane A host (H-T4)<br>• anything else: a `not-dispatchable` comment | §3.4. September D-11 and D-13. | MEDIUM | M11 | Port `launcher.py`. Hermes runs as root and can still read `substrate.env` (IN-01); keep that on record. |
| C-T5 | A lease-correct session contract:<br>• the launched agent claims **with its own surface token** and keeps the `lease_id`<br>• it heartbeats well inside the 900 s TTL<br>• it completes with the `lease_id` and the DoD fields, or releases<br>• the dispatcher never claims on the agent's behalf | On main, a claim made for another surface locks the claimant out (`coordination.md:93-99`). The September prompt used anonymous `curl` with no `lease_id` and no heartbeat. | HIGH | M1, M11 (per-agent token files from the v1.2 install), B-T4 | Rewrite steps 2–5 of the launcher prompt. Production needs surface tokens first (P1). |
| C-T6 | A claim watch:<br>• the claim has landed once `graph_get` shows the target surface holding a live lease, or the node has moved on<br>• after 900 s: SIGTERM, then SIGKILL 10 s later<br>• an exit without a claim produces a comment, removes the label and gives up the issue<br>• no retry | September D-14. The 900 s timeout covers Hermes' 600 s back-off after a 429. | MEDIUM | M1 | Port `sessions.py`. Persist the `given_up` set: it lives only in memory today, so a restart re-dispatches. |
| C-T7 | The label swap `dispatch:<surface>` → `agent:<surface>` happens inside the claim mirror's single update | §3.4: "the label is removed and `agent:<surface>` added when the claim lands" | LOW | B-T2 | Needs no dispatcher code. |
| C-T8 | Issue text never enters the prompt template; the session fetches it at run time through `issue_get` and treats it as untrusted | Prompt-injection boundary (`acc30a8 launcher.py:104-105`) | LOW | B-T7 | September's final fix (`launcher.py:73-79`) never ran live [UNVERIFIED]. |

#### D. Docs plane: RAG-backend, Hindsight, Dragonfly (area complexity: HIGH)

| ID | Feature | Why Expected | Complexity | Depends on (main) | Notes |
|---|---|---|---|---|---|
| D-T1 | `docs_search`, over MCP and as `POST /docs/search`:<br>• calls RAG-backend `POST /api/v1/retrieval` with **explicit `dataset_ids`** and `page_size ≤ 10`<br>• each result carries title, source URL, heading path, commit, a redacted snippet of at most 1,200 chars, score, `document_id` and `chunk_id`<br>• the reply carries an untrusted-docs notice and one event listing the returned URLs<br>• any error yields an empty result and a reason | §5.1. `data-planes.md:50`: "callers cite the source, not the chunk". The Grok Bot gateway already falls back to a substrate `docs_search` that does not exist (`docs/grok-bot.md:29,47`). | MEDIUM | M4, M10, M15, the null-block config idiom (`config.ts:153-175`) | Greenfield on main. 21652a2 omits the `dataset_ids` that RAG-backend requires and returns the raw body. Start from the contract in the `acc30a8` 05-04/05-05 plans. |
| D-T2 | `docs_ingest`, over MCP, as `POST /docs/ingest` and as `substrate docs ingest`:<br>• redact before upload and strip remote images<br>• idempotent by content hash (skip unchanged pages, replace changed ones)<br>• refuse a page that has no source URL<br>• accept only paths under the configured roots<br>• enforce size caps<br>• accept only authenticated callers that are not VM guests | §5.1: "ingestion runs the connector's redactor first". data-planes "Never" column: no secrets, receipts or transcripts. | HIGH | `redact.ts` (new rules for `RAG-backend-…`, `sk-proj-` and similar), M11 | Phase 05 decisions D-08 to D-10, D-17 and D-19. |
| D-T3 | Datasets as `data-planes.md` lists them:<br>• `agent-substrate`<br>• `agent-skills`, refreshed after each skills-sync fast-forward<br>• `programming-desk`<br>• one per product<br>Keep the last five versions. | `data-planes.md:41-48` | MEDIUM | F-T2 | Ingest-on-merge needs an authenticated path to a loopback-only service; this is an open decision. |
| D-T4 | Hindsight retain and recall, **behind the gate**:<br>• retain only after `accepted` with `verified_persisted`, redacted, carrying `receipt_path` or `source`, into the `sub-<surface>` banks<br>• a recall tool, or merged `memory_search` results marked as derived<br>• never inside the 1.5 s brief path | `data-planes.md:27,34-39`. §5.0 says Hindsight feeds `memory.brief`. | HIGH | M3 (the gate stays the system of record), M4 | Re-implement. 21652a2 is recall-only, uses one global `HINDSIGHT_BANK`, and waits 4 s inside the brief. Main's `.env.example` names `HINDSIGHT_BANK_PREFIX`. Avoid Hindsight 0.10.1, which has a recall hang ([vectorize-io/hindsight#4696](https://github.com/vectorize-io/hindsight/issues/4696)). |
| D-T5 | Dragonfly as a read-through cache **only**:<br>• caches the brief, search and recall results, per-surface counters, and a 24 h idempotency mirror<br>• `/healthz` reports cache `{enabled, connected, hits, misses, bypasses}`<br>• during an outage, the same answers come back uncached | `data-planes.md:26`; owner decision 2026-09-26 | MEDIUM | M5, `Substrate.brief` | Nothing usable exists: the 21652a2 client is never called, and phase 08 executed 0/7 plans. The TTL policy is an open decision. |
| D-T6 | A private hop to the planes: the Tailscale forwarders, or at least TLS for Dragonfly. Keys live only in `substrate.env`. | `docs/railway-tailscale.md`; P7 | MEDIUM (INFRA) | — | Prerequisite for D-T5. RAG-backend and Hindsight can start over public HTTPS with a bearer key. |

#### E. Ledger anchor (area complexity: MEDIUM-HIGH)

| ID | Feature | Why Expected | Complexity | Depends on (main) | Notes |
|---|---|---|---|---|---|
| E-T1 | An hour's membership is decided by **server ingest order**, not the collector's `ts` | `ts` is supplied by the collector, and backfills land in past hours (`docs/greptime-ledger.md:177-198`). A closed hour's leaf set could change after it is anchored. | HIGH (schema decision) | M8, M9 | `assertAppendOnly` refuses `ALTER`, and September D-09 needed `ALTER ADD ingested_at`. Options:<br>• an append-only ingest-order table written beside each insert<br>• recreate the table from the operator console |
| E-T2 | An RFC 6962 Merkle root over the hour's event hashes, ordered by ingest order and then `id`; memo `substrate:v1:<period_start>:<root>:<count>` | §7; September D-10 | LOW | M8 | Port `acc30a8:packages/ledger/src/{merkle,memo,period}.ts` and their tests (pure, no dependencies). |
| E-T3 | An hourly timer (`OnCalendar=hourly`, `Persistent=true`, about 5 min lag) that is idempotent: it adopts an existing signer-checked memo for the period, and raises an ALARM and exits 1 on a root mismatch | §2: an hourly VPS systemd timer. D-07, D-13, D-15. | MEDIUM | M9 | Not built in September: `anchor.ts` and the unit are missing (06-VERIFICATION gaps). |
| E-T4 | Send through the solana CLI, passing only the keypair **path** (a 0-lamport self-transfer with the memo, falling back to 1 lamport), then write the anchors row `{period_start, period_end, root, event_count, memo, tx_sig, signer, cluster, slot, anchored_at}` | §7; D-06, D-08; devnet only | MEDIUM | M8 | Main's DDL is keyed by root with 5 columns. The live table may be September's 11-column version [UNVERIFIED]. Port `solana.ts` and `rpc.ts`. Needs a funded key (P12). |
| E-T5 | `substrate verify <graph_id>` = the chain check plus a per-hour anchor check: recompute the root, read the memo by `tx_sig` and compare. An hour is `pending` for up to 3 h after it closes, and `unverified` (fail-closed) when devnet cannot be read | §7: verify "checks its roots against the recorded signatures". D-11, D-14, D-16. | MEDIUM-HIGH | M8, M12, M6 | Extend `POST /verify` and the CLI. |
| E-T6 | The job complies with the store lock: it reads hashes and writes anchors through typed methods inside `packages/mcp-server`, while `packages/ledger` keeps only the pure libraries and the RPC client | Otherwise `store-lock.test.ts` fails the build (ADR 0001 non-goal 1). | MEDIUM | M9 | The job runs as a substrate-mcp entry point or route, not as a second Greptime client. |

#### F. Skills plane (area complexity: HIGH in volume, MEDIUM in risk because it was already proven)

| ID | Feature | Why Expected | Complexity | Depends on (main) | Notes |
|---|---|---|---|---|---|
| F-T1 | `skills_propose`, over MCP, as `POST /skills/propose` and as `substrate skills propose`:<br>• validates the name, paths and frontmatter<br>• redacts and secret-scans, refusing on a finding<br>• dedupes through a content-hash ledger (`existing` / `declined` / `unchanged`)<br>• opens branch `skill/<surface>/<name>-<ts>-<hex>` and a PR on `swcstudiospace/agent-skills` via `gh`<br>• checks the origin and never force-pushes | §5.1 and §6.2: "proposals become branches and pull requests". skill-autonomy already posts to this route. | HIGH | M4, M10, M11 (fold auth into tokens; September accepted a bearer surface or `x-substrate-propose-key`), `redact.ts` | Port `acc30a8:packages/mcp-server/src/skills/{propose,propose-auth,frontmatter}.ts` (640 + 38 + 20 lines; `propose.test.ts` is 583 lines). |
| F-T2 | `substrate-skills-sync` runs from main:<br>• fast-forward-only fetch of `/root/agent-skills`<br>• refuses a dirty, off-branch or diverged checkout with a `warning` event<br>• projects symlinks for Claude Code, Grok Build, `.agents` (Cursor), Muse, Cursor and the OpenClaw roots, with backup and restore | The §6.1 projection table. The timer fails every 5 min (P4). | MEDIUM | M10 | Port `acc30a8:packages/projector/src/{skills,skills-sync}.ts` and their timers. `/root/agent-skills` has been at `df0db4e` with no fast-forward since 2026-09-27. |
| F-T3 | The Hermes bridge, every 5 min, drains `~/.hermes/pending/skills` (4 records waiting) and the Omp and Grok queues into `skills_propose` after 120 s of quiet, deleting a record only on a final reply | §6.2: miners propose, they do not publish | MEDIUM | F-T1 | Port `acc30a8:packages/miner` (`bridge.py` 598 lines; tests 523 lines). |
| F-T4 | The Hermes hourly miner cron runs on main's code:<br>• a monitor shim skips the LLM run in an unchanged hour<br>• at most 3 skills per run, through `skill_manage`<br>• `skills.write_approval` and `memory.write_approval` stay true | §6.2: Hermes "runs hourly as a cronjob". The job is failing (P4). | LOW-MEDIUM | F-T3 | Port `monitor.py` and `SKILL.md`. Job `0c172431cf5b` already exists. |
| F-T5 | All three miners propose instead of writing live:<br>• skill-autonomy (installed) posts, or stages the proposal<br>• the Omp extension intercepts `manage_skill` and `learn` (its symlink is dangling today)<br>• Hermes `skill_manage` → pending → bridge | §6.2 "three miners" | MEDIUM | F-T1 | Omp's extension is `acc30a8:packages/projector/omp/substrate-skills.ts`. Meanwhile Omp `autolearn` writes local `lesson-*` skills (SkillsLedger scout) [INFERENCE on timing]. |
| F-T6 | Cursor transcripts reach the miner: the `stop` hook copies a redacted transcript into `/var/lib/substrate/transcripts/cursor` and emits `session.end` | The build-plan proof starts from a Cursor session, and `hooks.json` points at a missing file (P5). | LOW | M13 | Port `acc30a8:packages/collectors/src/cursor-stop.ts` (220 lines). |

#### G. `desktop_run` (area complexity: LOW-MEDIUM)

| ID | Feature | Why Expected | Complexity | Depends on (main) | Notes |
|---|---|---|---|---|---|
| G-T1 | `desktop_run` drives the dedicated `substrate-desktop` webtop:<br>• a closed vocabulary of click, type, key and screenshot<br>• at most 50 actions, timeout 1–120 s<br>• a fixed `docker exec` argv (xdotool, xwd)<br>• one run at a time<br>• PNG screenshots returned as MCP image blocks and kept at mode 0600 (200 runs or 7 days) | §4.4. §5.1: `desktop.run(task, steps)` returns screenshots and output. | MEDIUM | M4 (keep image blocks out of the audit record), M10 | Port `acc30a8:packages/mcp-server/src/desktop/{actions,driver}.ts` and the tests (22 pass per 05-VERIFICATION). The container is running (P6). |
| G-T2 | One event per action; typed text is recorded only as its length and sha256 | A trail that cannot leak typed secrets | LOW | M10 | September used the kind `desktop.action`: map it to an existing kind or add it (open decision). |
| G-T3 | Only authenticated surfaces may call it, never VM guests or anonymous callers | September D-19. Production is anonymous today (P1). | LOW | M11 | September gated it on Phase 4's propose auth; rebuild the gate on tokens. |
| G-T4 | A container lifecycle script:<br>• requires ≥ 10 GiB free<br>• `--pull never`<br>• loopback :6081 with basic auth<br>• unprivileged, no `docker.sock`<br>• never touches `recruitment-desktop` | §4.4; the disk is 95% full | LOW | — | `acc30a8:infra/desktop/substrate-desktop.sh`. A daily `docker image prune -af` cron once deleted an image (03-11). |

#### H. Lane A: the rivet-agentos host (area complexity: HIGH)

| ID | Feature | Why Expected | Complexity | Depends on (main) | Notes |
|---|---|---|---|---|---|
| H-T1 | A `substrate-host` unit:<br>• one `@rivet-dev/agentos` VM per Graph ID (V8/WASM, so no KVM is needed)<br>• a Docker sandbox for native tools<br>• loopback API `POST /tasks` on :7411<br>• the rivet engine on loopback :6420 | §4.1 and §9 `packages/host`, which is an empty stub on main | HIGH | — | Port `acc30a8:packages/host` (about 4.3k non-test lines). Packaging issues:<br>• agentos 0.2.21 is pinned; 0.2.22 is the latest<br>• `@agentos-software/claude-code` is imported but not declared<br>• an 8,498-line npm lock sits in a bun workspace |
| H-T2 | `openTask` keyed by Graph ID:<br>1. `graph_get`<br>2. `graph_claim` as `claude-code` with that surface's token, then **keep the `lease_id` and heartbeat while turns run**<br>3. fetch the brief<br>4. seed `SUBSTRATE_BRIEF.md`, the skills and the `.claude.json` MCP entries, with a sha256 read-back<br>5. `sessions.open` with permissionPolicy "ask"<br>6. send the prompt<br>Release the claim on any failure. | The §4.1 sketch and the v1.3 target | HIGH | M1, M11 | September's `substrate.ts:141-167` called anonymously, never stored the `lease_id` and never heartbeated, so under main it would lose the lease at 900 s. |
| H-T3 | Durable sessions in rivet storage. After a host restart, a continuation prompt keyed `<gid>:<nid>:resume:<n>` resumes the work. | Phase 3 proof: "the session survives a host restart" | MEDIUM | — | Proven by 03-06-SMOKE (`restart_survived=true`). There is no process snapshot (D-07). |
| H-T4 | The dispatcher routes `dispatch:claude-code` to `POST /tasks`; a refusal becomes a once-only Linear comment | Phase 3: "dispatcher routes `dispatch:claude-code` there" | MEDIUM | C-T1, C-T2 | `acc30a8 .../host.py` (224 lines). |
| H-T5 | A disk gate **in code**: at least 10 GiB free before any image build or pull | §12: check free disk before the rivet images. September enforced this by hand only. | LOW | — | September's npm install cost about 2.2 GB and the image about 1 GB (03-01-SPIKE). 22 GB are free today. |
| H-T6 | Approvals reach a human: permissionPolicy "ask" goes to a Telegram bot on the stop-notify path, with single-use Approve/Deny buttons | Phase 3: "approvals surfaced to Telegram". In September it stayed off, so requests waited forever. | MEDIUM | — | `acc30a8 telegram.ts` needs the three `SUBSTRATE_APPROVAL_*` keys. |
| H-T7 | Credentials stay on the host:<br>• the VM holds no tokens<br>• host functions commit, push (never force, never `.substrate-*` files), open the PR and sync the PR fields | September D-08 | MEDIUM | M11 | `hostfns.ts`. `sync.ts` contains a second Linear/Notion client; fold it into B-T1. |

#### I. Phase 0 UAT (area complexity: LOW-MEDIUM)

| ID | Feature | Why Expected | Complexity | Depends on (main) | Notes |
|---|---|---|---|---|---|
| I-T1 | Re-run all 8 scenarios against main and record pass or fail, with evidence, in `0-UAT.md` | Deferred since the v1.1 close (`MILESTONES.md:28,45`) | LOW | M1–M15 | Detail is in the UAT table below. |
| I-T2 | An isolated rehearsal harness:<br>• main's substrate-mcp on a scratch port with scratch Postgres and Greptime<br>• `SUBSTRATE_URL` pointed at it | PROJECT.md: phase proofs use isolated stores. Production runs from the operator checkout. | MEDIUM | M8, M14, the `SUBSTRATE_TEST_PG_URL` pattern | A Greptime image pull has to pass the disk gate. |
| I-T3 | Update the expected values to match main:<br>• 19 tools, not 9<br>• the header `## Agent Substrate brief` instead of `<SUBSTRATE_BRIEF>` (an accepted deviation)<br>• `fetchBrief` now lives in `src/claude/hook.ts:412` | Stale expectations would fail a correct system | LOW | — | The deviation is recorded in `acc30a8:.planning/phases/00-brief/0-VERIFICATION.md`. |

### Differentiators (Competitive Advantage)

| ID | Area | Feature | Value Proposition | Complexity | Notes |
|---|---|---|---|---|---|
| A-D1 | A | Infer the graph from the per-Graph-ID worktree path for herdr and Muse events | Lane B events reach the graph's brief and evidence without agents passing ids | LOW | Needs C-T3. |
| A-D2 | A/C | Run dispatched Lane B sessions inside herdr panes (`herdr worktree create`, then `herdr agent start / prompt / wait`) | Makes herdr the persistent runtime in practice: sessions outlive dispatcher restarts, and the collector sees their status | MEDIUM-HIGH | It changes the kill switch: stopping the unit would no longer end sessions (September relied on `KillMode`). |
| A-D3 | A | An Orca `endpoint.env` tee | Uniform tool events, Codex included | MEDIUM | It shares every agent's live status path (01 CONTEXT, option A). The owner chose the native floor first. |
| B-D1 | B | Mirror graph edges (`requires` / `blocks` / `gated_by`) into Linear relations | Closes `coordination.md:321` "Not done" | MEDIUM | |
| B-D2 | B/C | Linear Agent Sessions: delegate the issue, post a `thought` within 10 s, then post activities | Linear's native agent UI, following its [AIG](https://linear.app/developers/aig) | HIGH | Needs an OAuth app actor. Per-activity mutations exhaust the hourly rate budget ([cyrus#1490](https://github.com/cyrusagents/cyrus/issues/1490)). |
| B-D3 | B | Put mirror outcomes in `substrate evidence` per node | One artifact shows claim → Linear → Notion → DoD | LOW | M6 |
| C-D1 | C | Label → brief in ≤ 60 s | September missed by 5 s (65 s): the 30 s poll plus Hermes' 30 s `pre_llm_call` hook (`02-PROOF.md:1208,1247`) | MEDIUM | Poll faster within Linear's rate limits, read `hermes-linear-poller`'s 2 s poll state, or skip uplift for dispatched runs. |
| C-D2 | C | Dispatch as a signed handoff packet (goal from the issue, DoD lines, files) | The dispatched context can be replayed from the ledger (v0.3 §2) | LOW-MEDIUM | M2 |
| C-D3 | C | Launchers for Omp, Muse and Grok Build (`omp -p`, `muse`, `grok -p -r`) | §3.4 lists them; September opted out (D-11) | MEDIUM each | |
| C-D4 | C | Run `coord_drift_scan` on the worktree before launch | A stale-brief warning before acting (v0.3 §2) | LOW | M2 |
| D-D1 | D | Cross-surface recall in the brief: a bounded, cached fan-out over the `sub-*` banks | `data-planes.md:34` | MEDIUM | `agentId:"*"` is an Agentmemory idiom, and Hindsight banks are isolated ([docs](https://docs.hindsight.vectorize.io/memory-banks/)). |
| D-D2 | D | Ingest on merge to main (a GitHub Action calling `POST /docs/ingest`) | Docs stay current without a human | MEDIUM | Needs authenticated ingress to a loopback service. |
| D-D3 | D | Retire Claude Code's global `hindsight` stdio MCP and Hermes supermemory once the `sub-*` banks answer, with restore routes recorded first | One memory plane (the §5.0 no-silo rule) | MEDIUM | P10 |
| D-D4 | D | A weekly `reflect` per bank | Mental models replace stale detail (`data-planes.md:27,39`) | LOW | |
| E-D1 | E | Anchors in the evidence bundle: a tx signature and an explorer link per hour | PR and incident evidence anyone can check outside the system (v0.3 6.x) | LOW | M6 |
| E-D2 | E/F | Anchor teachable moments (graph id plus an observation digest) | A user addition carried in the brief's area E | MEDIUM | Needs F-D2 and E-T4. |
| F-D1 | F | A2A Agent Cards per agent at a loopback `/.well-known/agent-card.json`, with teachable moments as `AgentSkill` entries (`id`, `name`, `description`, `tags` including `teachable-moment`, `examples`) | Interop. PROJECT.md v1.3 names it as a target. | MEDIUM | Nothing is implemented anywhere (21652a2 has a stub; acc30a8 has none). Spec: [a2a-protocol.org](https://a2a-protocol.org/latest/specification/). v0.3 renamed `agent.json` to `agent-card.json`; v1.0 adds `supportedInterfaces[]`. |
| F-D2 | F | A store for teachable moments | "Reverse skills" learned from sessions | MEDIUM | The gate refuses the kind `teachable` (M3). Either store them as governed `fact` entries with a tag, or add a kind through the gate. Overlaps the lessons bank (M7). |
| F-D3 | F | `skills_list` and an approve/decline audit trail | §5.1; v0.3 "4.x Skill approve audit" | LOW-MEDIUM | In September, approval meant the owner merging the PR (D-16). How `declined` is reported was left unspecified. |
| F-D4 | F/D | Re-ingest the `agent-skills` dataset after each fast-forward | Skills become searchable through `docs_search` | LOW | D-T3 |
| G-D1 | G | cua on the Docker path (`Image.linux(kind="container")`, `local=True`) | Ephemeral desktops per run; it was the build plan's first choice | HIGH | The newer cua default is gVisor and there is no runsc on this host; the older default is QEMU and there is no KVM. cua is not installed and needs Python ≥ 3.11 ([cua docs](https://cua.ai/docs/cua-sdk/reference/python/image)). |
| G-D2 | G | Fresh screenshot pixels (fix the stale xwd output, N1) | A GUI smoke test can assert on pixels rather than window titles | LOW-MEDIUM | |
| H-D1 | H | An enforced egress allowlist for the sandbox container | September N3: the container could reach example.com | MEDIUM | |
| H-D2 | H | Codex, OpenCode and Pi in VMs | They are §4.1 built-ins | MEDIUM each | Outside the September scope. |
| H-D3 | H | Re-adopt running tasks after a dispatcher restart (N4) | No orphaned VMs | LOW-MEDIUM | |
| I-D1 | I | The UAT as a repeatable script run against any `SUBSTRATE_URL` | A regression check for every later phase | LOW-MEDIUM | |

### Anti-Features (Commonly Requested, Often Problematic)

| Area | Feature | Why Requested | Why Problematic | Alternative |
|---|---|---|---|---|
| A | A new `herdr` surface and new `agent.*` / `brief.delivered` kinds | Faithful to herdr's own names | Main's vocabulary is closed. v1.1 mapped new sources onto existing kinds. Every consumer (brief, drift, evidence, SLOs) would have to learn the new ones. | Map them to `session.start`, `session.end` and `note`, with `runtime: herdr` |
| A | `pane.output_matched` with regex `.` | "Capture everything" | Every terminal line becomes a `note` in an append-only log that nothing reclaims, and output can contain secrets | Status transitions only |
| A | The Orca tee as the first collector | One seam covers 4 agents | A wrong tee silently loses status for every agent (01 CONTEXT) | The native floor first, the tee later |
| B | The substrate sends Done, or re-implements DoD | Fewer moving parts | It bypasses the connector's gate (§3.3, D-06) | In Review, then `/v1/complete-issue` |
| B | `issueUpdate labelIds` or `replaceTeamLabels` | A simpler API | Both overwrite labels other tools set (D-03) | `addedLabelIds` / `removedLabelIds` |
| B | Roll the lease back when a tracker write fails | Consistency | A tracker outage would then block agents. The index is a cache and the trackers are the truth (D-02). | Keep the lease, emit a `warning`, and re-mirror on re-claim |
| B | New `release` / `complete` kinds (September D-08) | Explicit kinds | Main already writes `note` / `warning` with `payload.action`, so the ledger would hold two conventions | Keep main's convention |
| B | Per-agent Linear bot users for claims | An open question in §12 | Seats and setup cost; the label already names the surface | `agent:<surface>` labels; revisit with B-D2 |
| C | Linear webhooks | Lower latency | They need public ingress to a loopback host (D-10) | Poll, or read `hermes-linear-poller`'s state |
| C | Retry automatically after a claim timeout or an unclaimed exit | Resilience | Retries loop and burn model quota (September runs 2–4 hit Anthropic 429s) | A once-only marker comment; a human re-labels |
| C | The dispatcher claims for the agent | The claim lands sooner | Under v1.2 the lease then belongs to the named surface, and the dispatcher's token is refused on every later call | The agent claims with its own token |
| C | Issue text in the prompt template, `--yolo`, or `dispatch_handoff_to_hermes.sh` | Convenience | Prompt injection, and unbounded permissions (D-13) | `issue_get` at run time, treated as untrusted |
| D | RAG-backend's MCP server (`RAG-backend_retrieval`) | §5.1 names it | Self-host mode serves the tenant's datasets to any caller, and there is no control over datasets (05 D-01, D-03) | The HTTP retrieval API behind `docs_search` |
| D | RAG-backend chat, agents, GraphRAG, RAPTOR or rerank | Better answers | They need a paid chat model and are non-deterministic (05 D-05) | Retrieval only, with TEI bge-small |
| D | `memory_write` → Hindsight `retain` as the store of record | A literal reading of `data-planes.md:27` | Hindsight rewrites facts through an LLM, and its recall is non-deterministic. It would bypass the gate's read-back, versioning and quarantine (M3). | Postgres stays the governed store; retain is an async forward after `accepted` |
| D | Dragonfly as a queue, outbox, lock or session store (21652a2 ADR-0002) | A degraded write mode | The owner's 2026-09-26 decision makes it cache-only, and these uses need durability | Cache only |
| D | Recall inside the synchronous brief (21652a2, 4 s) | A richer brief | It breaks the 1.5 s fail-open budget (07 D-07) | A separate tool or a cached async section |
| D | Plane keys held by agents or Grok Bots; a silent local substitute when a plane is skipped | Simpler wiring | Contradicts the data-planes access path; 05-02 and 07-02 forbid silent fallbacks | The substrate (or the desk gateway) holds the keys; report "unconfigured" |
| E | Event contents on chain; mainnet; a paid RPC | A stronger proof | §11: roots only, on devnet | Root and count in the memo |
| E | Port September's global ingest chain (`chain.ts`) wholesale | It worked in September | It changes `prev` for every new row (main chains per session), needs a second recorded cutover, and its dedup and nudge logic assumes a deduplicating table | Keep per-session chains; add ingest order for anchoring only |
| E | The tamper proof by overwriting a row through dedup | September's method | The ledger is `append_mode` now, so an overwrite is impossible, and a forged row in production would be permanent | Run the tamper proof on a scratch Greptime |
| F | Auto-merge, live publishing, or Hermes `/skills approve` on library skills | Speed | v0.3 §4: "never auto-enable"; D-16; W11 | PRs that the owner merges |
| F | Deduplicate through GitHub search | Easy | The search index lags (W1) | A local ledger plus `gh pr view` / `gh pr list --head` |
| G | Free-form shell or program arguments in `desktop_run` | Flexibility | Arbitrary execution (D-13) | The closed vocabulary |
| G | A QEMU path, or cua's default image on this host | A build-plan option | There is no `/dev/kvm` and no runsc | The webtop via `docker exec` |
| H | Tokens or `substrate.env` inside the VM; auto-approved permissions | Fewer prompts | Violates D-08 and D-13 | Host functions and the "ask" policy |
| H | Prune other projects' Docker data to free disk | The disk is 95% full | Violates D-04 | Gate the build and stop |
| I | Prove scenario 7 by stopping production `substrate-mcp` | The literal wording of the scenario | Production runs from the operator's checkout | A dead-port `fetchBrief` plus a scratch instance |
| I | Proof rows written into the production ledger | Realism | The ledger is append-only, so they stay forever (September left `uat-xsurface-*` rows behind) | Scratch stores; production only with the operator's approval |
| all | Cherry-pick 21652a2 | It "connects live planes" | It is a stub written against the pre-v1.2 server | Re-implement from the acc30a8 contracts and `data-planes.md` |

## Build-plan proofs as acceptance checks

| Area | Build-plan proof (source) | Observable acceptance check | Live systems needed | Isolated rehearsal | September result |
|---|---|---|---|---|---|
| A | Phase 1 proof (§10): "Hermes finishes node n2 from a Grok Bot handoff; Omp's next prompt in that repo lists both the handoff and the claim". v1.3 scope: the collectors. | **Given** the herdr and Muse collectors and the Muse plugin running from main.<br>**When** an agent in a herdr pane goes working → idle in repo R, and a Muse session calls a tool in R.<br>**Then** `events_query(repo=R)` returns the status transition (≤ 10 s) and the `tool.call`, under main-valid surfaces and kinds; R's `.substrate/BRIEF.md` lists them on its next refresh (≤ 5 min); and the count of refused emits is 0. | None external: local herdr server, Muse install, a substrate instance | Yes (point `SUBSTRATE_URL` at a scratch instance) | The units have been live since 2026-09-24. "No real agent-status transition observed"; no model session ever quoted a brief (owner-accepted). |
| B | §3.3; Phase 2 proof | **Given** node n on issue I, unstarted, and a surface token for S.<br>**When** S calls `graph_claim`.<br>**Then**, within 60 s: I is in a `started`-type state and labelled `agent:S` with no `dispatch:*` label; I has exactly one "Claimed by S — session …" comment, which contains no `lease_id`; the Notion Issue row shows Agent = S; and a second surface's claim returns the holder and writes nothing.<br>**Then** `graph_release` returns I to `unstarted`, removes the label and clears Agent.<br>**Then** `graph_complete` without DoD leaves I in In Review, the node in `started_review` and the lease held.<br>**Then** `graph_complete` with DoD (summary, `tests_pass`) leads the connector to move I to Done, and the node becomes `completed`. | Linear (a free slot under the 250 cap), the Notion Agent Task Graph, `hermes-linear-api` | Partly: unit tests with recorded GraphQL fixtures. The live smoke needs the operator's approval. | Proven on SWC-465 and SWC-467 (2026-09-25), on the pre-lease model |
| C | Phase 2 proof (§10): "Label SWC-233 `dispatch:hermes`: a Hermes session starts, claims n3, the Notion Issue row shows Agent hermes, and Claude Code's brief shows it within a minute" | **Given** the kill switch off for a bounded window.<br>**When** the label is added.<br>**Then**: launch ≤ 30 s; the claim lands under the Hermes token; the label flips to `agent:hermes` in one update; Notion shows Agent = hermes; `POST /brief` (surface claude-code) contains "n3 … started by hermes" ≤ 60 s after labelling; the session heartbeats; and the run ends in a gated Done or a release. The kill switch is back on afterwards. | Linear, Notion, Hermes (model quota), the kill-switch window | Partly: the `--once --dry-run` decision table against a fake Linear | Run 5 on SWC-467: 65 s; the operator called complete; owner-approved (`02-PROOF.md:1196-1247`) |
| D | Phase 5 proof (§10): "An agent answers a docs question with a citation", plus `data-planes.md` | **Given** the `agent-substrate` dataset ingested through `docs_ingest`, with a redaction fixture stored as `[REDACTED]`.<br>**When** a headless session with only the substrate MCP (session-scoped `--mcp-config --strict-mcp-config`) asks a docs question.<br>**Then** its answer contains a source URL that `docs_search` returned, and an event listing that URL can be read back from Greptime.<br>**Hindsight:** an `accepted` memory is retained into `sub-<surface>`, and recall from another surface returns it with its source.<br>**Dragonfly:** the second brief is a cache hit (`hits` +1); with Dragonfly down, the same brief comes back uncached (`bypasses` +1). | RAG-backend (dataset, embedding model), Hindsight, Dragonfly (private hop) | Partly: fake HTTP servers. The proof itself needs the live planes. | Owner-skipped: the docs half of 05, all of 07 and 08 |
| E | Phase 6 proof (§10): "Alter one event row; `verify` flags the graph", plus the hourly devnet anchor | **Given** a closed hour H with an anchors row and a devnet memo whose root equals the recomputed root.<br>**When** one event in H is altered on a **scratch** ledger, its hash recomputed consistently.<br>**Then** `substrate verify <graph>` exits 1 and names H with a root mismatch, while an untouched graph verifies with every hour "anchored". A re-run of the timer adopts the existing memo instead of re-sending. | A funded devnet key, devnet RPC; a scratch Greptime for the tamper | The Merkle/memo/period code is pure: unit tests plus a fake RPC. The anchor itself needs devnet. | The chain-only tamper proof passed (2026-09-27); anchoring skipped (D-17) |
| F | Phase 4 proof (§10): "A skill mined from a Cursor session is merged and appears in Claude Code and Grok Build without either being touched" | **Given** a Cursor session's transcript copied by the `stop` hook.<br>**When** the hourly Hermes miner proposes it through `skills_propose` and the owner merges the PR.<br>**Then** within one sync tick (≤ 5 min) Claude Code lists the skill at init and `grok inspect` shows it, and no agent config's mtime changes. All timers and the cron are green on main's code. | GitHub (`gh` auth), the owner's merge, Hermes model quota, a Cursor session | Partly: `skills_propose` against a throwaway repo | Proven with an **Omp** source instead (D-22): PR #7, projected 126 s later (`04-PROOF.md`) |
| G | Phase 5 proof (§10): "a GUI smoke test runs in a sandbox" | A headless session calls `desktop_run` with click / type / key / screenshot. The returned PNG's **pixels** show the typed marker; one event per action lands; `recruitment-desktop` is untouched. | Docker only (a local container) | Yes | Passed 2026-09-27, but asserted on the window title because of stale pixels (N1) |
| H | Phase 3 proof (§10): "A labelled issue opens a VM, the session survives a host restart, the PR lands and `ultrathink-sync` closes the loop" | `dispatch:claude-code` on a fresh issue → the host opens a VM for the graph → claims n1 under the claude-code token and heartbeats → `systemctl restart substrate-host` mid-session → the same session resumes → a real push and PR → review → the PR fields are synced → gated Done. | Linear, Notion, GitHub, the model route (shunt on loopback :3001), approvals (Telegram or a chosen route), ≥ 10 GB free disk, Docker | Partly: the restart survival (03-06) and the seed tracers rerun on throwaway graphs | 83/91. The end-to-end run (03-10) never happened; Telegram stayed off. |
| I | Phase 0 proof (§10): "Edit in Cursor, start Claude Code on the VPS: the uplift echo shows the brief naming the edit and the open graphs in that repo" | See the UAT table below | Production only for scenarios 2 (real data), 3 (Notion read) and 5 (kickoff writes) | Scenarios 1, 4, 6, 7 and 8 yes | 7/8 passed after closure on 2026-09-24; scenario 5 "landed, not yet live" (`acc30a8:.planning/phases/00-brief/0-VERIFICATION.md`) |

## Phase 0 UAT (area I): the eight deferred scenarios

The scenarios come from `milestones/v1.0-phases/00-brief/0-UAT.md`, where all 8 are `pending`.

| # | Scenario | What it needs on main today | Without production? | State and blockers |
|---|---|---|---|---|
| 1 | substrate-mcp serves both surfaces: the tools plus `GET /healthz`, `POST /brief`, `POST /events`, `POST /verify` | Main now has **19** tools, so the check becomes "the 9 named tools are present" (I-T3). Production was restarted on main at 16:27 UTC. | Yes: main on a scratch port. A read-only probe of production is optional. | September evidence (9 tools; 200 / 202 / 200) is out of date. `/verify` on mixed-chain graphs may fail [INFERENCE]. |
| 2 | The schemas exist and hold real data (Postgres `graph_*` and `memory_entries`; Greptime `agent_events` and `anchors`; all on Railway) | `migrate()` on boot. "Real data on Railway" needs read-only counts against production. | Schemas yes; real data no | The live `anchors` table may be September's period-keyed version, while main's DDL is keyed by root. `CREATE IF NOT EXISTS` keeps whichever already exists [UNVERIFIED]. |
| 3 | The index is backfilled from the Notion Agent Task Graph | A read-only Notion query exports the rows as JSON, then `bun packages/mcp-server/src/backfill-run.ts rows.json` (M14). Main has no Notion client. | Yes with exported rows in scratch Postgres. "Real graphs" needs a Notion read, which is low-risk. | The mapping is tested (`backfill.test.ts`). |
| 4 | The brief reaches a Claude Code session before the Graph of Thought | claude-ultrathink calls `fetchBrief` at `origin/main` `src/claude/hook.ts:412` (not `hooks/uplift.ts`) under the header `## Agent Substrate brief` (an accepted deviation). The installed plugin is 0.3.0 (`gitCommitSha 85ca1ac`). | Yes: both `origin/main` (`src/substrate/brief.ts:44-48`) and the installed 0.3.0 honour `SUBSTRATE_URL`, so point it at a scratch instance and run one prompt | Done in source. Record which plugin version served the run. |
| 5 | `ultrathink-kickoff` calls `graph_register` | Kickoff's `SKILL.md:83` registers **only when an MCP server named `substrate` is connected**, and none is registered for Claude Code (P10). It needs a `substrate` MCP entry (projector) and a kickoff run, which writes real Notion and Linear rows. | No, unless kickoff is run with its tracker writes stubbed [UNVERIFIED whether a dry-run exists] | **Fails today**: it never fires. `c2c12a8` exists only on a local branch; v1.4 (9 commits ahead) is unmerged. |
| 6 | Cursor hooks and the git post-commit collector are installed | `hooks.json`'s `stop` entry points at `cursor-stop.ts`, which is missing (P5): port it (F-T6) or re-project with main's `cursor.ts`. `sessionStart` runs `brief --surface cursor --write`, which is fine. The post-commit hook exists in the operator checkout. | Yes: a scratch repo with hooks reading `SUBSTRATE_URL` | Half-broken: the stop hook fails silently. |
| 7 | A substrate outage blocks no agent | `fetchBrief` against a dead port returns `""` within 1.5 s (September: 2 ms; `brief.test.ts` 7 pass) | Yes, and it must stay that way: never stop production (Anti-Features, I) | Expected to pass. Re-record it. |
| 8 | Phase proof: a cross-surface brief keyed by Graph ID | Emit a `file.edit` as cursor on graph G, then `POST /brief` as hermes for G. The edit appears together with the claims of other surfaces. | Yes, with scratch Postgres and Greptime. A production run leaves permanent rows. | September passed (`ut-mucem4mc-ec70360f`, about 2 s). Re-run it against main. |

## Cross-repo build-plan items

Repos are under `/root/src/repos`. Checks were read-only on 2026-10-08, by me and by the XRepoStatus scout.

| Item (build plan) | Repo @ ref | Status | Evidence | Gap / v1.3 dependency |
|---|---|---|---|---|
| Hermes redesign (§9; hermes-plugin `PROJECT.md`): `pre_llm_call` → TS engine → brief, uplift XML and graph; Kanban retired as a tracker | **claude-ultrathink**, not hermes-plugin | **Done in a different repo; partial overall** | `/root/.hermes/plugins/ultrathink` → `claude-ultrathink/hosts/hermes`, which runs `hooks/engine.ts` through bun (`bridge.py:5`) and calls `fetchBrief` from `src/host/plan.ts`. Hermes config enables `ultrathink` and `hermes_eng_board` (`config.yaml:176,182`), but the `kanban` toolset is **still enabled** (`:238`). hermes-plugin@`7a1fc16` has no remote, is not installed and still calls `hermes_kanban_create`. hermes-engineering-board@`19dd375` (no remote) emits with **surface `hermes-eng-board`, which main rejects** (P3). | Map the eng-board surface to `hermes`. Decide on the `kanban` toolset. Archive hermes-plugin. The engine runs from the unmerged v1.4 working tree. |
| omp-ultrathink `memory_brief` discovery step (§5.4) | omp-ultrathink@`0d0d017` (master) | **Partial: code only, not live** | `swe.ts:95-100` calls `memory_brief`; `:164-169` calls `events_emit`. The repo has **no git remote**. It is not installed: Omp loads only the agent-swarm extension, and `~/.omp/agent/mcp.json` has no substrate entry. | Push it, install it, and give it Omp's surface token. |
| Grok Build ultrathink `/brief` hook (§4.3/§5.4) | `ultrathink` repo (`cb5154b`, no substrate code on any branch) → superseded by claude-ultrathink | **Done by a different route** | `~/.grok/hooks/ultrathink.json` `UserPromptSubmit` runs `claude-ultrathink/hooks/uplift.ts` with `ULTRATHINK_HOST=grok-build`, and `~/.grok/plugins/ultrathink` → claude-ultrathink, so the `fetchBrief` path applies. The September route (01-08: repo `claude-ultrathink-grok`, kind `brief.delivered`) no longer exists. | Unconfirmed whether the model actually sees the hook context [UNVERIFIED]. This is a v1.4 merge dependency. |
| grok-hermes-connector v0.4 forwarding tools (§2, §4.3) | mcp@`63fd450` on `feat/linear-parentid-got-cot` | **Partial: live but unpushed and unmerged** | Version 0.4.0. `server.py:631` `memory_brief`, `:656` `memory_write`, `:685` `events_emit`, `:718` `graph_get`. `handoff_to_hermes` emits `handoff` with `graph_id`, node and repo (`:614-624`). The branch is 4 commits ahead of origin and 5 ahead of `origin/main`. The service has run from the working tree since 2026-10-01. All four target tools exist on main [INFERENCE: compatible]. | Push it and open a PR. Add `docs_search` / `skills_*` forwarding once D and F land. Give the connector a `grok-bot` token. |
| skill-autonomy `skills.propose` (§6.2) | skill-autonomy@`394d5ea` | **Partial: blocked on F** | `propose.py` POSTs `<substrate>/skills/propose` with `x-substrate-propose-key`; otherwise it stages the proposal under `<plugin-data>/pending/`. It is installed for Grok Build (`~/.grok/installed-plugins/registry.json`). The repo has **no remote**. | Main has no `/skills/propose`, so every proposal gets a 404 [UNVERIFIED whether a 404 stages or is treated as final]. Needs F-T1 and F-T3. |
| claude-ultrathink `graph_register` in kickoff (§5.4, §9) | claude-ultrathink `origin/main` `ace7f84`; branch `feat/v1.4-session-native-planning` `38679e1` (9 ahead, unmerged) | **Partial** | `SKILL.md:83` makes `graph_register` optional: it runs only if an MCP server named `substrate` is connected, and none is (P10). `fetchBrief` is at `src/claude/hook.ts:412` and `src/host/plan.ts:159`. The only emit is a planning `note`. There is **no `graph_claim`** anywhere, and **no `pr` or `session.end` emits**. The installed Claude plugin is 0.3.0. | Register a `substrate` MCP entry. Add `graph_claim` to kickoff, plus `pr` / `session.end` emits (§5.4). Merge v1.4 and refresh the installed plugin. |
| Extras (§6.2): Omp creator → propose; Hermes `/learn` → propose; Hermes hourly miner | acc30a8 (Omp extension, miner) | **Missing or failing** | The Omp extension symlink is dangling. `/ultrathink-learn` saves lessons, not skills (`bridge.py:1005`). The cron fails (P4). | F-T3, F-T4, F-T5 |

Five of these repos have **no git remote** at all: hermes-plugin, hermes-engineering-board, hermes-linear-connector, omp-ultrathink and skill-autonomy. Production services run straight from those working trees.

## Feature Dependencies

```
[Prod identity: SUBSTRATE_TOKEN_* / operator / audit path / handoff key (M11, P1)]
    └──required by──> B-T2 (label surface from token), C-T5, F-T1 auth, G-T3, D-T2 gate, H-T2

[Event vocabulary decision (M10, P3)]
    └──required by──> A-T2, A-T3, F-T1 (skill.propose), G-T2 (desktop.action), D-T1 events, eng-board

[B-T1 Linear client] ──> [B-T2..B-T6 mirror + DoD gate] ──> [C-T7 label swap] ──> [C dispatcher]
[B-T7 graph_find / issue_get] ──> [C-T2, C-T8] ──> [H-T4 claude-code route] ──> [H-T2 openTask]
[C-T3 worktrees] ──enhances──> [A-D1 graph attribution]
[A-D2 herdr-hosted sessions] ──conflicts──> [C kill switch via unit KillMode]

[F-T1 skills_propose] ──> [F-T3 bridge] ──> [F-T4 miner]
                      └──> [cross-repo: skill-autonomy, Omp extension]
[F-T6 cursor-stop] ──> [F proof (Cursor-sourced skill)]
[F-T2 skills-sync] ──> [D-T3 agent-skills dataset] ──> [F-D4]

[D-T6 private hop] ──> [D-T5 Dragonfly cache]
[M3 governance] ──> [D-T4 Hindsight retain] ; [F-D2 teachables] ──> [F-D1 Agent Cards]
[E-T1 ingest order] ──> [E-T2..E-T5] ; [funded devnet key] ──> [E-T4]
[E-T4] + [F-D2] ──> [E-D2 teachable anchors]

[I-T2 isolated harness] ──enhances──> every area's rehearsal (A, B unit, D fakes, E scratch ledger, G)
```

### Dependency Notes

- **Restoring the running units comes first.** A-T1, A-T3, C-T1, F-T2, F-T3, F-T4 and F-T6 replace units and hooks that are live today from memory or already failing (P2, P4, P5). Until they land on main, a reboot takes out herdr, Muse and the dispatcher, and the skills pipeline stays down.
- **The claim mirror requires leases first.** B-T2 and B-T3 hook main's lease decisions (`granted`, `reclaimed`, `stolen`, `released`, `expired`, `forced`). The September `mirror.ts` hooked the pre-lease `claimNode`, so it is ported for its tracker logic, not its call sites.
- **The dispatcher requires the claim mirror.** The label swap (C-T7) and `graph_find` / `issue_get` (B-T7) live in substrate-mcp, and C's proof ("the Notion Issue row shows Agent hermes") is B's mirror.
- **Lane A requires the dispatcher and leases.** H-T4 is a dispatcher route. H-T2 must keep the `lease_id` and heartbeat (M1).
- **Hindsight retain requires the governance gate.** Retaining anything the gate did not accept would re-open the second memory door that `store-lock.test.ts` exists to close. `docs/grok-bot.md:21` records a different route, where the desk gateway calls Hindsight and RAG-backend directly (Ming's Q2 decision). D must settle who owns those calls before building D-T4.
- **The anchor requires ingest order.** E-T1 decides whether membership is stable. Without it, E-T5 reports false mismatches for backfilled events.
- **Teachables conflict with the current gate** (M3 refuses the kind) until F-D2 settles their storage. Agent Cards (F-D1) and teachable anchors (E-D2) both wait on that decision.
- **A-D2 (herdr-hosted dispatch) conflicts with the September kill switch.** The kill switch relied on `KillMode=control-group` to end sessions, so with A-D2 it needs an explicit herdr stop.

**Area × main capability matrix** (what each area must respect or reuse):

| Area | Leases (M1-M2) | Governance (M3) | MCP audit (M4) | Evidence (M6) | Lessons (M7) | Ledger and store lock (M8-M9) | Tokens (M11) |
|---|---|---|---|---|---|---|---|
| A | — | — | REST emits audited | events show when the graph is known (A-D1) | — | `/events` only, closed vocabulary | collector surface tokens |
| B | **core**: hook every decision; never leak `lease_id` | — | `graph_find` / `issue_get` audited | mirror outcomes (B-D3) | — | `warning` events | **core**: label surface from the token |
| C | **core**: claim / heartbeat / complete contract | — | — | dispatch trail | — | events | **core**: per-agent token files |
| D | — | **core**: retain after `accepted` | docs tools | — | — | a key rule like the Greptime lock | ingest gate |
| E | — | — | — | anchors in the bundle | — | **core** | — |
| F | — | teachables vs the gate | `skills_propose` | — | boundary: lessons are governed facts, skills are SKILL.md | events | propose auth |
| G | — | — | **core** (image blocks) | — | — | events | caller gate |
| H | **core**: the VM keeps and heartbeats its lease | — | host calls audited | PR evidence | — | — | claude-code token |
| I | all | all | all | — | — | — | — |

## MVP Definition

Every area A–I is in v1.3 scope (PROJECT.md). Shrinking any of them needs the user's explicit approval. "MVP" here means the smallest set with which each area's proof passes.

### Launch With (v1.3)

- [ ] **Cross-cutting prerequisites:**
  - production identity (P1);
  - the event-vocabulary decision (P3);
  - restoring the live units onto main (P2, P4, P5).
  Without these, the proofs cannot be attributed and production keeps degrading.
- [ ] A-T1 … A-T5. herdr is the declared Lane B runtime, and its units are live from memory.
- [ ] B-T1 … B-T7. This is the v1.3 claim mirror, and C and H depend on it.
- [ ] C-T1 … C-T8 and C-D1. The §10 proof says "within a minute", and September missed it by 5 s.
- [ ] D-T1 … D-T6. PROJECT.md names `docs_search`, `docs_ingest`, Hindsight recall and the Dragonfly cache.
- [ ] E-T1 … E-T6. The hourly anchor and verify are the v1.3 ledger target.
- [ ] F-T1 … F-T6, F-D1 and F-D2. PROJECT.md: "A2A Agent Cards carry teachable moments".
- [ ] G-T1 … G-T4 and G-D2. A GUI smoke test should assert on pixels.
- [ ] H-T1 … H-T7. This is the Lane A target, including the disk gate.
- [ ] I-T1 … I-T3. These are the deferred UAT scenarios.

### Add After Validation (v1.3.x)

- [ ] A-D1. Add once dispatcher worktrees exist in production.
- [ ] B-D1, B-D3. Add once the mirror has been stable over a week of claims.
- [ ] C-D2, C-D4. Add once dispatched sessions are routine.
- [ ] D-D1, D-D3, D-D4. Add once the `sub-*` banks answer recall.
- [ ] E-D1, E-D2. Add once anchors have run for 24 h.
- [ ] F-D3, F-D4. Add once the propose flow is green on main.
- [ ] H-D1, H-D3, I-D1.

### Future Consideration (v2+)

- [ ] A-D2 (herdr-hosted dispatch). It changes the kill switch's semantics.
- [ ] A-D3 (the Orca tee). It carries risk to the live status path.
- [ ] B-D2 (Linear Agent Sessions). It needs an OAuth app actor and a rate-budget design.
- [ ] C-D3 (Omp, Muse and Grok Build launchers). They are opt-outs carried over from September.
- [ ] D-D2 (ingest on merge). It needs ingress.
- [ ] G-D1 (cua). It does not run on this host without runsc or KVM.
- [ ] H-D2 (Codex, OpenCode and Pi in VMs).

## Feature Prioritization Matrix

| Feature group | User Value | Implementation Cost | Priority |
|---|---|---|---|
| Restore live units onto main (A collectors, C dispatcher, F timers, miner, `cursor-stop`) | HIGH | MEDIUM | P1 |
| Production identity and the event-vocabulary decision | HIGH | LOW | P1 |
| B: claim mirror on leases plus the DoD gate | HIGH | HIGH | P1 |
| C: lease-correct dispatcher, ≤ 60 s | HIGH | HIGH | P1 |
| F: `skills_propose`, sync, bridge, miner | HIGH | MEDIUM (port) | P1 |
| I: Phase 0 UAT harness and run | HIGH | LOW | P1 |
| D: `docs_search` and `docs_ingest` | HIGH | MEDIUM | P1 |
| D: governed Hindsight retain and recall | MEDIUM | HIGH | P1 (in scope); the bank/routing decision comes first |
| D: Dragonfly cache plus a private hop | MEDIUM | MEDIUM | P1 (in scope); the transport is a prerequisite |
| E: hourly anchor plus verify | MEDIUM | MEDIUM-HIGH | P1 (in scope); needs a funded key |
| G: `desktop_run` | MEDIUM | LOW | P1 |
| H: Lane A host | MEDIUM | HIGH | P1 (in scope); ordered last |
| F-D1, F-D2: Agent Cards and teachables | MEDIUM | MEDIUM | P1 (PROJECT.md target); needs a governance decision |
| A-D1, B-D1, B-D3, C-D2, C-D4, D-D1, D-D3, D-D4, E-D1, E-D2, F-D3, F-D4, H-D1, H-D3, I-D1 | MEDIUM | LOW-MEDIUM | P2 |
| A-D2, A-D3, B-D2, C-D3, D-D2, G-D1, H-D2 | LOW-MEDIUM | HIGH | P3 |

**Priority key:**
- **P1**: must have for the milestone. Deferring one needs explicit approval.
- **P2**: add when possible.
- **P3**: future.

## Competitor Feature Analysis

| Feature | Linear Agents (native delegation) | GitHub Copilot cloud agent | Cursor cloud agents via Linear | Our approach |
|---|---|---|---|---|
| Trigger | Delegate or mention, which creates an Agent Session webhook | Assign the issue to Copilot | Assign to Cursor or mention `@Cursor`; a `repo` label group picks the repository | A `dispatch:<surface>` label, polled every 30 s (no public ingress) |
| Acknowledgement | A `thought` within 10 s; move to the first `started` state; set the delegate | A draft `[WIP]` PR | A branch and a draft PR | The claim mirror: a `started` state, the `agent:<surface>` label and one session comment |
| Progress visibility | Activities (thought / action / elicitation / response / error) and session states | Session logs; commits carry an `Agent-Logs-Url` trailer | An agent session in Linear | The events ledger, the cross-agent brief and the evidence bundle |
| Completion | A `response` activity | A review request on the PR | The PR becomes ready for review | The hermes-linear-connector DoD gate moves the issue to Done |
| Isolation | The agent's own | An ephemeral Actions environment | A remote VM | A per-Graph-ID worktree (Lane B) or a rivet VM (Lane A) |
| Exclusivity across agents | One delegate | One assignee | Users reported duplicate agents per issue | A lease CAS with TTL and a `lease_id` only the holder sees |
| Tamper evidence | — | Signed commits | — | Per-session hash chain plus hourly RFC 6962 roots anchored to devnet, like a [Certificate Transparency](https://www.rfc-editor.org/rfc/rfc6962) tree head |

## Open decisions the roadmap must carry

1. **Event vocabulary.** Should new sources (herdr, Muse, skills, desktop, docs, eng-board) map onto the existing kinds and surfaces, as the v1.1 precedent did, or should main's closed sets be extended?
2. **Production identity rollout.** Tokens, operator tokens, the audit path and the handoff key have to be in place before the live proofs of B, C, F and H can be attributed (P1).
3. **E's ingest-order mechanism and anchor schema.** Choose between:
   - a new append-only table;
   - recreating the table from the console;
   - a reworked September global chain.
   The live `anchors` table shape must also be reconciled with main's DDL, and a devnet funding route found, since the faucet refused in September.
4. **Who owns the D plane calls.** `data-planes.md` says substrate-only, while `docs/grok-bot.md:21` records the gateway calling directly. Related questions:
   - Does `memory_search` merge Hindsight results?
   - Per-surface banks or one shared bank?
   - Cache TTLs: 5 min / 10 min (data-planes) or 30 s with generation bumps (08 D-05)?
   - Is `docs_search` cached?
   - Transport: forwarders first?
5. **Teachables storage.** Choose a governed `fact` with a tag or a new kind, decide the Agent Card route (loopback `/.well-known/agent-card.json`), and decide whether anchors cover teachables.
6. **Lane A packaging.** An npm lock sits inside a bun workspace, and the rivet packages need the owner's install approval again (03-01-SUMMARY).
7. **Linear capacity.** The Free plan caps active issues at 250, and every live proof in B, C and H consumes slots.

## Sources

- Build plan v0.2 (Notion, §0–§13) and the v0.3 addendum: `local://build-plan-v02.md`, `local://build-plan-v03.md`.
- Worktree `/root/src/worktrees/agent-substrate-v13`:
  - `.planning/{PROJECT,MILESTONES}.md`
  - `.planning/milestones/v1.0-ROADMAP.md`
  - `.planning/milestones/v1.0-phases/*`
  - `docs/{data-planes,railway-tailscale,coordination,greptime-ledger,memory-governance,mcp-audit,grok-bot}.md`
  - `packages/mcp-server/src/{types,event,config,greptime,service,store-lock.test,mcp,server}.ts`
  - `packages/cli/src/index.ts`, `packages/projector/src/cursor.ts`
- Unmerged refs, inspected with `git show`:
  - `acc30a8:.planning/phases/{00..08}-*` (CONTEXT, PROOF, VERIFICATION, COVERAGE, SUMMARY docs);
  - `acc30a8:packages/{collectors,dispatcher,host,ledger,miner,projector,mcp-server}`;
  - commit `21652a2` (planes, teachable).
  - Scout digests: `agent://ResearchFeatures.{LaneBClaimsDigest,LaneADesktopDigest,SkillsLedgerDigest,PlanesDigest,XRepoStatus}`.
- Host (read-only, 2026-10-08):
  - `systemctl show` / `systemctl cat` / `journalctl` for the substrate units;
  - `docker ps` / `docker info`, `df -h /`, `herdr --version` / `--help`;
  - `/root/.cursor/hooks.json`, `~/.claude.json` (MCP server names only), `~/.claude/plugins/installed_plugins.json`, `~/.hermes/config.yaml`, `~/.hermes/cron/jobs.json`, `~/.grok/hooks/ultrathink.json`;
  - the variable names in `/etc/substrate/substrate.env` (never the values);
  - operator checkout reflog;
  - `git log` / `remote` / `status` of the cross-repo checkouts.
- External:
  - Linear agents: [developers/agents](https://linear.app/developers/agents), [agent-best-practices](https://linear.app/developers/agent-best-practices), [AIG](https://linear.app/developers/aig)
  - GitHub Copilot cloud agent: [docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github)
  - Cursor + Linear: [docs](https://cursor.com/docs/integrations/linear)
  - cua image reference: [docs](https://cua.ai/docs/cua-sdk/reference/python/image)
  - A2A specification: [latest](https://a2a-protocol.org/latest/specification/)
  - Hindsight API: [reference](https://hindsight.vectorize.io/api-reference)
  - RAG-backend HTTP API: [reference](https://RAG-backend.io/docs/http_api_reference)
  - RFC 6962: [rfc-editor](https://www.rfc-editor.org/rfc/rfc6962)

---
*Feature research for: Agent Substrate v1.3 build-plan completion (areas A–I)*
*Researched: 2026-10-08*
