# Pitfalls Research

**Domain:** Multi-agent substrate on one VPS (substrate-mcp + Linear/Notion control plane + Railway data planes + Solana devnet anchor). Milestone v1.3 "Build plan completion", areas A–I, phases numbered from 16.
**Researched:** 2026-10-08
**Confidence:** HIGH for repo and host facts (each cites a file, commit or command). MEDIUM for external service limits (Linear, Solana faucet, RAGFlow (retired)), which come from public docs that change without notice.

Area key: **A** Lane B collectors and Muse projector · **B** claim mirror and DoD gate · **C** substrate-dispatcher · **D** docs plane (RAGFlow (retired), Hindsight, Dragonfly) · **E** ledger anchor and `substrate verify` · **F** skills plane, timers, miner, Agent Cards · **G** `desktop_run` · **H** Lane A rivet-agentos host · **I** Phase 0 UAT.

"Phase 16 (foundation)" below means the first v1.3 phase. These pitfalls argue that it must come before any area work, and that it should restore production parity, close the policy enums and extend the guard tests.

Port sources: `acc30a8` (branch `docs/data-planes-tailscale`, a superset of `substrate/ut-mughkkc0-73909228`) and `21652a2`. Both branch from `31d236a`.

---

## Critical Pitfalls

Ordered by severity: blast radius × likelihood × how hard it is to recover.

### Pitfall 1: Merging to `main` deploys to production, and production already runs code that `main` does not have

**What goes wrong:**
The operator checkout `/root/src/repos/agent-substrate` is now on `main` (`ab62c91`). Every substrate unit runs from it: `WorkingDirectory=/root/src/repos/agent-substrate` in `systemctl cat substrate-mcp|substrate-dispatcher|substrate-collector-*|substrate-skills-*`. A merge to `main` therefore goes live on the operator's next pull:
- **Timers:** they pick up new code within 5 minutes, with no restart (`substrate-skills-*.timer` has `OnUnitActiveSec=5min`).
- **Long-running units:** they pick it up on their next restart (`Restart=always`, `RestartSec=3–5`).

Meanwhile four enabled units run code that is not on disk:
- `substrate-dispatcher` (PID since 10:47 today): `packages/dispatcher/src/substrate_dispatcher/` holds only `__pycache__`.
- `substrate-collector-herdr` and `substrate-collector-muse` (up since 2026-09-29): `herdr.ts` and `muse.ts` are absent from `packages/collectors/src` on main.
- `substrate-host`: inactive but enabled, 40 restarts.

Any restart or reboot sends them into a crash loop. The dispatcher has already done this 114,888 times (`NRestarts=114888`; journal: `No module named substrate_dispatcher.__main__`). The two skills timers fail every 5 minutes:
- `error: Module not found "packages/projector/src/skills-sync.ts"`
- `No module named substrate_miner.__main__`

The journal already takes 1.0 GB on a 95%-full disk.

**Why it happens:**
The September work was deployed from a feature-branch checkout and never merged. Switching the checkout to `main` removed the files under running processes. Unit files live in `/etc/systemd/system`, not in the repo, so nothing in `main` describes what is installed.

**How to avoid:**
- Phase 16 lands every installed unit file in `infra/vps/` on `main`, matching `systemctl cat`. It also lands either the code each unit runs, or an explicit decision to disable that unit. Disabling is an operator action that the plan records; agents do not run it.
- Every unit gets a `ConditionPathExists=` on its entry point, plus `StartLimitBurst`/`StartLimitIntervalSec` so a missing file cannot crash-loop.
  - Exception: `substrate-mcp` deliberately sets `StartLimitIntervalSec=0` for network blips. Keep that, and guard it with `ConditionPathExists`.
- Every PR description states its live effect: "next timer tick", "next restart of X", or "none until the operator enables Y".
- Order matters:
  - Land a server route before the client that calls it. `/skills/propose` must be on `main` before the bridge code, or the bridge POSTs to a 404 every 5 minutes.
  - Keep `SUBSTRATE_DISPATCH_DISABLED=1` in `/etc/substrate/substrate.env` until area C's proof is approved. The dispatcher re-reads it every tick (`acc30a8:packages/dispatcher/src/substrate_dispatcher/dispatch.py:64-82`).

**Warning signs:**
- `systemctl list-units 'substrate*'` shows `failed`, or `NRestarts` grows.
- The journal holds `Module not found` or `No module named`.
- An enabled unit's `ExecStart` path is missing from `git ls-files`.

**Phase to address:**
Phase 16 (foundation), before any area phase. Every later phase re-checks it at its proof step.

---

### Pitfall 2: Porting September code by merge instead of re-implementing it against main's lease and identity model

**What goes wrong:**
`git diff --stat 31d236a acc30a8` shows 362 files and +85,579 lines. `main` has also moved: +43,779 lines since `31d236a`. Between `ab62c91` and `acc30a8`, the core files differ by 1,008 insertions and 3,777 deletions across `service.ts`, `mcp.ts`, `index-store.ts`, `server.ts`, `types.ts` and `redact.ts`. Those are the leases, governance, audit and swarm identity that `acc30a8` predates.

Ported as-is, the September dispatcher, mirror and collectors fail without anyone seeing it:
- **Claims:** `service.ts claimNode(graphId, nodeId, surface, sessionId)` is keyed on the session and has no `lease_id`. Main fences release and complete on `lease_id` plus the token's surface (`docs/coordination.md:64-99`).
- **Auth:** `substrate_dispatcher/mcp.py` and `host.py` send no Authorization header. Main answers 401 once tokens are configured.
- **Missing tools:** the dispatcher calls `graph_find` and `issue_get`, which main does not have.
- **Missing kinds and surfaces:** collectors emit kinds `agent.detected|agent.status|agent.exited|brief.delivered|release|complete|docs.ingest|desktop.action|skill.propose` and surfaces `herdr` and `docs-scraper`. None are in main's `EVENT_KINDS`/`SURFACES` (`packages/mcp-server/src/types.ts:30-63`). Collectors fail open, so the refused events disappear without a trace.
- **No store lock:** `acc30a8` has no `store-lock.test.ts` at all.

**Why it happens:**
The branch looks finished: tests pass on the branch, and the v1.0 SUMMARYs say "complete". It is also cheaper to cherry-pick than to re-derive.

**How to avoid:**
- Treat `acc30a8` and `21652a2` as reference implementations. Port leaf modules that have no core coupling: `packages/ledger/src/{merkle,memo,period,rpc,solana}.ts`, `dispatcher/worktree.py`, `projector/src/skills-sync.ts`, `desktop/driver.ts`. Re-implement every call into `Substrate` against main's signatures.
- Never cherry-pick `service.ts`, `mcp.ts`, `index-store.ts`, `server.ts` or `types.ts` hunks.
- Adding kinds and surfaces is a reviewed fail-closed policy change (`docs/adr/0001-*.md:587-590`). It is chain-affecting (`:601`). It belongs in one dedicated Phase 16 PR with tests.

**Warning signs:**
- A port PR touches a core file with more than about 200 changed lines.
- Collector smoke runs show `stored: false` or a 4xx from `/events`.
- `graph_complete` returns `not-holder` or `unheld` in a dispatch proof.

**Phase to address:**
Phase 16 for the enum and surface additions and the port rules. Each area phase then re-implements its own slice: A, B, C, D, E, F, G, H.

---

### Pitfall 3: Fail-open and fail-closed assigned to the wrong calls

**What goes wrong:**
The substrate has two hard rules that pull in opposite directions:
- Hooks, `events.emit` and every read fail open: `docs/data-planes.md:71-73`, `.planning/PROJECT.md:129-130`.
- Everything that grants exclusivity or writes shared state fails closed: `docs/mcp-audit.md:222-231`, `docs/memory-governance.md:6-11`.

v1.3 adds about eight tools and three background jobs. Any of them can land on the wrong side:
- **Unclassified tools.** An unknown tool is fail-closed (`packages/audit/src/policy.ts:77-80`). If `docs_search` or a recall is added without a `FAIL_OPEN_TOOLS` entry, an audit-sink fault refuses docs reads.
- **Mirror rolling back the claim.** A Linear or Notion mirror that throws would undo a granted claim. September made the mirror fail-open after the claim (`acc30a8 mirror.ts` header; `service.ts:300-301`), and that is correct.
- **DoD gate failing open.** A gate that treats a timeout as approval lets a node complete without passing the Definition of Done. September's gate fails closed (`dod-gate.ts`: only `completed: true` counts; a timeout is settled by reading Linear state). Keep that.
- **Silent drops.** Collectors and the Muse hook fail open, so a refused event is dropped without a trace (Pitfall 2).
- **Hindsight around the gate.** A retain sent outside the governance gate becomes a fail-open write path to memory other agents act on.

**Why it happens:**
"Fail open" gets applied to a whole plane instead of to each call. The audit lists in `packages/audit/src/policy.ts` and the tool list in `packages/mcp-server/src/observe.ts:310+` are easy to forget when registering a tool.

**How to avoid:**
Phase 16 writes a per-tool decision table into `docs/mcp-audit.md` and encodes it in `policy.ts`, with tests:

| Fail-open | Fail-closed |
|---|---|
| `docs_search`, `recall`, the brief, the Dragonfly cache, collector emits | `docs_ingest`, `skills_propose`, `desktop_run` (it acts), the anchor write, `graph_*` |

- The mirror and DoD gate rules above stay as they are.
- Collectors count refused and failed emits locally and surface them, as `ledger.silent` already does (`docs/adr/0001-*.md:533-535`).
- Hindsight retain goes only through `memory_write` → `governMemoryWrite`.

**Warning signs:**
- A new tool name is missing from both sets in `policy.ts`.
- `policy.test.ts` "the two lists do not overlap" still passes, but the new tool is in neither.
- The brief p95 SLO (`docs/observability.md:152`) breaches during a RAGFlow (retired) outage.
- Collector logs show 4xx and a silent ledger.

**Phase to address:**
Phase 16 for the table and tests. Each area phase registers its tools against it: B, D, E, F, G.

---

### Pitfall 4: The claim mirror and the dispatcher break lease authority

**What goes wrong:**
Main's v1.2 lease rules (`docs/coordination.md:48-149`):
- The `lease_id` reaches only its holder.
- Heartbeat, release and complete are refused `not-holder` for any other token surface.
- Claiming for another surface locks the claimer out.
- No swarm surface is an operator.

The September design conflicts with these rules in four ways:
1. **Dispatched agents lack credentials.** The dispatcher launches Hermes with an allowlisted environment of HOME, PATH, LANG, LC_ALL, USER, LOGNAME and SHELL (`launcher.py` `CHILD_ENV_ALLOW`). There is no `SUBSTRATE_TOKEN`, so the session's claim is anonymous (401 on main) and it never captures `lease_id` for `graph_complete`.
2. **The dispatcher cannot claim for the agent.** If it claims the node itself, the lease belongs to whatever surface it names, and the dispatcher's token is then refused on every fenced call (`coordination.md:93-99`).
3. **The mirror sees only grants and releases.**
   - Lease expiry (lazy, or `coord_reap_leases`) and forced releases do not mirror, so Linear keeps `started` plus `agent:<surface>` for a holder that is gone.
   - Mirroring `renewed` would post a Linear comment per heartbeat.
   - Swarm surfaces (15 `swarm-*` tokens via the agent-swarm lease bridge) would label Linear issues `agent:swarm-a05-be` and move states unattended.
4. **The `lease_id` can leak.** Writing it into the "one-line session comment", the Notion row or an event hands the fencing token to everyone who can read Linear. `events_query` is readable by every agent, and events carry `lease_epoch`, never the id (`coordination.md:161-162`).

**Why it happens:**
The mirror and dispatcher were designed for the Phase 0 claim, where any session of a surface was the holder and claims never expired (`coordination.md:12-29`).

**How to avoid:**
- **The mirror** runs off the lease's own events: `granted`, `reclaimed`, `released`, `stolen`, `forced` and expiry (`coordination.md:151-162`). It never runs off `renewed`. Its comment carries surface, session and epoch only.
- **The dispatcher** never claims. It launches an agent with that agent's own token, delivered per the v1.2 workspace-install rule (`.planning/PROJECT.md:32`: one 0600 token file per agent, the child gets only its own `SUBSTRATE_TOKEN`). It detects "claim landed" from `graph_get`'s holder surface and session, where `lease_id` is null.
- **Swarm surfaces:** decide explicitly whether they mirror. Recommendation: no Linear state or label changes for `swarm-*`, a note only. Pin that in a test.
- **Leak test:** add a test that no mirror payload or event contains a `lease_id`.

**Warning signs:**
- A dispatch proof shows `claim-timeout` after 900 s.
- `graph_complete` returns `not-holder`.
- Linear issues sit in Started with `agent:*` labels while `graph_get` shows the node free.
- A `lease_id` string matches anything in `events_query` output or in Linear comments.

**Phase to address:**
The area B phase (mirror), and the area C phase (dispatcher), which depends on B.

---

### Pitfall 5: Linear label races and double dispatch

**What goes wrong:**
- **Lost guard state.** The September dispatcher's double-dispatch guards are an in-memory `SessionRegistry` and a `given_up` set (`sessions.py:131-152`). Both are lost on restart, and "02-PROOF run 2 confirms a restart re-enables dispatch". The dispatcher has just restarted 114,888 times.
- **Shared worktrees.** The worktree is per Graph ID (`/var/lib/substrate/worktrees/<gid>`, `worktree.py:20-24`). Two nodes of one graph dispatched together, or an issue carrying both `dispatch:hermes` and `dispatch:claude-code`, put two agents in one working tree.
- **Missed labels.** The poll is `first: 50` with no pagination (`linear.py:16-25`).
- **Label churn.** The label swap is split across processes: the dispatcher removes labels on give-up, and the mirror adds `agent:*` and removes `dispatch:*`. A human relabelling in between gets the issue re-dispatched or stripped.
- **Shared rate limit.** `hermes-linear-poller` already polls every 2 s, about 1,800 requests an hour (`~/.config/hermes-linear/config.yaml` `poll_interval_seconds: 2`). The plan has the dispatcher use "the same Linear credentials" (build plan §2). Linear's API-key limit is 2,500 requests an hour per user, a leaky bucket shared across that user's keys ([Linear rate limiting](https://linear.app/developers/rate-limiting)). Dispatcher polling, mirror writes and comment mirroring can exhaust it.
- **Echo loops.** The poller's `mirror_comments: true` echoes the substrate's claim comment into Hermes. [UNVERIFIED] whether the poller also starts Hermes work on state changes, which would be a second dispatch path.

**Why it happens:**
Linear labels are a UI affordance with no compare-and-swap. Polling plus a process restart gives at-least-once launches.

**How to avoid:**
- Keep a durable dispatch record in TimescaleDB, alongside the existing `desk_idempotency` pattern (`docs/data-planes.md:25`).
  - Key it on (Linear issue id, the label's `createdAt` or the issue's `updatedAt`) behind a unique constraint.
  - Insert it before launch; launch only if the insert wins.
- One worktree per (Graph ID, node), or serialize nodes of one graph.
- More than one `dispatch:*` label on an issue is a refusal comment, not a launch.
- Paginate the poll.
- Read the `X-RateLimit-Requests-Remaining` header and back off.
- Measure the poller's real request rate before adding load.
- Tag substrate comments so the poller and the substrate ignore each other's echoes. The marker pattern already exists in `dispatch.py`.

**Warning signs:**
- Two `session.start` events for one Linear issue within a poll interval.
- `git worktree list` shows one path used by two sessions.
- HTTP 429 or a `RATELIMITED` GraphQL error.
- Hermes Kanban cards appearing for substrate comments.

**Phase to address:**
The area C phase. The rate-limit budget is shared with the area B phase.

---

### Pitfall 6: Unredacted content reaches RAGFlow (retired) or an anchor

**What goes wrong:**
- **Ingest is publication.** Everything ingested is returned verbatim to every agent through `docs_search`.
- **Anchors are public.** A Solana memo is public for as long as the cluster keeps it.
- **21652a2 anchors content.** `anchorTeachableOnSolanaDevnet` writes `substrate:${graph_id}:${teachable.framing}`, which is free text from agent events, into a devnet memo (`21652a2 packages/miner/src/teachable.ts`). That breaks "roots only, never event contents" (`.planning/PROJECT.md:115`; build plan §11).
- **Coverage gaps.** Main's `redact.ts` covers provider token shapes, `*_KEY=` and keypair byte arrays (`packages/mcp-server/src/redact.ts:18-50`). It does not cover base58 secret keys, RAGFlow (retired) or Hindsight key formats [UNVERIFIED formats], or Railway and tailnet hostnames. The desk rules forbid hostnames, and `.planning` docs on `acc30a8` contain them (scout: `05-DISCOVERY.md:61`, `07-RESEARCH-CONTRACTS.md:310`, `08-02-PLAN.md:140`).
- **Three redactors.** The connector's `redactor.py`, main's `redact.ts`, and `acc30a8 redact.ts` with `SKILL_HIGH_CONFIDENCE_RULES`/`scanSkillFiles` will drift apart.

**Why it happens:**
Redaction is tuned for the event write path, where the rule is "redact and keep going". Ingest and anchoring are publication paths where "refuse" is the right answer.

**How to avoid:**
- **`docs_ingest` scans, then refuses on findings** (file, line and rule; never the value), like `skills/propose.ts`. It redacts nothing silently. It is fail-closed.
- **Anchors carry only** `substrate:v1:<hour>:<root>:<count>` (`acc30a8 memo.ts` `MEMO_RE`).
  - A teachable anchor is the SHA-256 of the redacted, canonical teachable JSON, stored with the root. It is never text.
- **One shared redaction module** with a CI gate on every collector, connector and `docs.ingest` (v0.3 §5).
  - Add base58-secret and hostname rules.
  - Port `scanSkillFiles` into main's `redact.ts` instead of keeping two copies.
- **Never ingest** `.planning/` archives, receipts or transcripts (`docs/data-planes.md:28`).

**Warning signs:**
- A memo that does not match `MEMO_RE`.
- A `docs_search` chunk containing `=` followed by a long token, an `up.railway.app` or `rlwy.net` host, or a tailnet machine name.
- `redact.test.ts` and the connector's redactor tests disagree on a fixture.

**Phase to address:**
Phase 16 for the shared redaction library. The area D phase for ingest refusal. The area E and F phases for anchor and teachable memo content.

---

### Pitfall 7: Secrets in generated configs, unit files and spawned agents

**What goes wrong:**
- **Narrow store lock.** It catches only `SUBSTRATE_TOKEN*` literals and Greptime credentials and hosts (`store-lock.test.ts:72-95, 249-362`). A committed `LINEAR_API_KEY`, `NOTION_API_KEY`, `RAGFLOW (retired)_API_KEY`, `HINDSIGHT_API_KEY`, the skills `propose.key` or a Solana keypair array would pass it.
- **Configs outside the repo.** The projector writes configs into agent homes and workspaces that the store lock cannot see (`docs/adr/0001-*.md:603`, "a green substrate test read as a swarm guarantee").
- **`Environment=` values are exposed.** Any `Environment=` value in a unit is printed by `systemctl cat` and `systemctl show`, to any user. The current units correctly use only `EnvironmentFile=/etc/substrate/substrate.env` (0600 root), with path-only `Environment=` lines.
- **Spawned agents run as root.** The dispatcher has no `User=`, and its children run as root and "can still read substrate.env" (`launcher.py:39-45` comment). Token separation is not process isolation (`docs/adr/0001-*.md:605`).
- **Desktop password.** `substrate-desktop.env` holds the webtop password.

**Why it happens:**
The store lock was built around the Greptime and token threats of v1.0–v1.2. The new planes bring new credential names.

**How to avoid:**
- **Extend the store lock** to scan every tracked file:
  - every credential key name in `.env.example` (assigned a literal value);
  - a 64-number byte-array keypair shape;
  - `-----BEGIN` blocks.
- **Projector tests** assert that generated output names variables (`${VAR}`, `env:VAR`) and never values. September's projector tests already show the seam.
- **Units:** keep `EnvironmentFile=` only, with no secret-bearing `Environment=`.
- **Dispatched agents:** run them under a dedicated Linux user where the agent supports it (build plan §4.2). Otherwise record the root boundary as accepted risk in the requirement.
- **Keypair access:** only the anchor job reads the keypair path. Pass it to `solana` as `--keypair <path>` in an argv, never through a shell (`acc30a8 solana.ts:4`), and scrub the path from stderr (`21652a2 planes.ts:175` does).

**Warning signs:**
- `git grep -nE '(LINEAR|NOTION|RAGFLOW (retired)|HINDSIGHT)_API_KEY\s*[:=]\s*\S{16,}'` returns anything.
- A generated `.mcp.json` or `hooks.json` contains a token-shaped value.
- `systemctl show -p Environment substrate-*` shows a non-path value.

**Phase to address:**
Phase 16 (store-lock extension). The area C, F and H phases (units and spawned agents) re-assert it.

---

### Pitfall 8: New planes reach around the store lock

**What goes wrong:**
`packages/mcp-server/src/store-lock.test.ts` pins five invariants:
1. Only `packages/mcp-server/src/` and `scripts/greptime-smoke.ts` import the Greptime client, name `agent_events` in SQL, or read `GREPTIME_*` (`:107-131`).
2. Only `greptime.ts` and `brief.ts` compose ledger SQL, and `mcp.ts`, `server.ts` and `service.ts` hold no `sql:` or `SELECT` (`:141-172`).
3. Memory tables are written only through `index-store.ts` and `memory-write.ts`, and `service.ts` calls `governMemoryWrite` (`:181-224`).
4. No agent config or projector source registers Greptime as an MCP server (`:226-247`).
5. No tracked file carries Greptime credentials, Railway hosts or substrate token literals (`:249-362`).

Each v1.3 area has a natural way to break them:
- **E:** the build-plan sketch `packages/ledger/anchor.ts` runs `greptime.sql(... agent_events ...)` and `INSERT INTO anchors` directly (build plan §7). That breaks invariants 1 and 2.
- **D:** a `planes.ts` Hindsight `retain` is a memory write past the gate. Invariant 3 only matches Postgres table names, so the test does not catch it.
- **D, F:** `substrate.yaml` in the build plan gives `claude-code` and `hermes` a direct `ragflow (retired)` MCP server (§6.3). That is a second, unredacted door, and it contradicts v0.3 §4 ("Only substrate `docs.search`; raw RAGFlow (retired) / Hindsight off seat defaults").
- **Ported docs:** `.planning` docs with Railway hosts fail invariant 5.

**Why it happens:**
The invariants are scoped to Greptime and Postgres. The new stores (RAGFlow (retired), Hindsight, Dragonfly, Solana) are not named in them yet.

**How to avoid:**
- **Area E:** the anchor job calls substrate-mcp. Either add a typed `Substrate.anchorPeriod` and anchors methods in `greptime.ts`, driven by a timer that calls a loopback route, or argue a named exception in the test, the way `SMOKE_HARNESS` was.
- **Phase 16 adds store-lock rules:**
  - only the memory-write path calls Hindsight `retain`;
  - no agent config registers RAGFlow (retired) or Hindsight as an MCP server (extend `:226-247` to `ragflow (retired)|hindsight`);
  - only `mcp-server/src` reads `RAGFLOW (retired)_*`, `HINDSIGHT_*`, `DRAGONFLY_*`;
  - only the anchor module reads `SOLANA_*`.

**Warning signs:**
- `bun test store-lock` fails after a port.
- A new package's `package.json` depends on a Greptime client or a Redis client.
- A projector fixture lists `ragflow (retired)` under `mcpServers`.

**Phase to address:**
Phase 16 (rule extensions). The area D and E phases implement against them.

---

### Pitfall 9: The Solana devnet anchor cannot send, cannot be verified later, or verifies the wrong thing

**What goes wrong:**
- **Unfunded key.** The devnet key at `/etc/substrate/ledger-devnet.json` holds **0 SOL** (`solana balance -u devnet`, run 2026-10-08). In September, 3 RPC airdrops and a retry were refused and the PoW faucet did not build. The owner skipped anchoring (`acc30a8 .planning/phases/06-ledger/06-VERIFICATION.md`, gap SC2).
- **Faucet and RPC limits.** The faucet allows 2 requests per 8 hours anonymously ([faucet.solana.com](https://faucet.solana.com/)). Public devnet RPC is rate-limited per IP.
- **Resets.** Devnet "may be subject to ledger resets" ([Anza clusters](https://docs.anza.xyz/clusters/available)). A reset zeroes the balance. Signatures stop resolving after a reset, and possibly after RPC history pruning [UNVERIFIED for the public devnet RPC].
- **Env name drift.**
  - Keypair: the host defines `SOLANA_ANCHOR_KEYPAIR`/`SOLANA_RPC_URL`/`SOLANA_ANCHOR_PUBKEY`, while main's `.env.example:171-172` and `acc30a8` use `SOLANA_KEYPAIR_PATH`, with a different default file (`anchor-keypair.json` vs `ledger-devnet.json`).
  - Hindsight: `21652a2` falls back between them, but uses `HINDSIGHT_BANK` where `main` and `docs/data-planes.md` use `HINDSIGHT_BANK_PREFIX`.
- **Non-reproducible roots.** RFC 6962 roots depend on leaf order (`acc30a8 merkle.ts`), and the plan sketch orders leaves by `ts`. `ts` is collector-supplied, not append order, and same-millisecond ties come back in arbitrary order (`docs/greptime-ledger.md:177-198, 270`). Late or backdated events (the Grok collector passes source timestamps) land in an hour that is already anchored. A recomputed root then differs, and verify reports tampering that did not happen.
- **Shape-only verify.** `21652a2`'s verify only regex-checks the signature's shape.

**Why it happens:**
Devnet looks free and permanent. The Merkle sketch in the build plan is illustrative.

**How to avoid:**
- **Funding is an operator prerequisite** for area E: GitHub-authenticated faucet or a transfer from a funded wallet. Each anchor is a 0-SOL or 1-lamport self-transfer plus about 5,000 lamports in fees, so 24 a day is about 0.00012 SOL a day [INFERENCE from the standard fee]. One funding lasts years.
  - The job never airdrops in a loop.
  - When unfunded it emits one `warning` per hour and leaves the hours un-anchored, for backfill through `closedHours` (`acc30a8 period.ts`).
- **Pick one env name and one keypair path** in Phase 16 and migrate `.env.example`. The operator edits `substrate.env`.
- **Deterministic leaves:** sort them by hash, or by (session, chain order).
- **Partition by ingest:** anchor a closed hour after a lag. Record `event_count` and the anchored event ids (or a digest of their sorted hashes), so verify can report "late events, not anchored" separately from "altered event".
- **Record the genesis hash per anchor.** Verify then reports `cluster-reset` or `signature-unavailable` as distinct from `mismatch`. It trusts the `anchors` table root and treats the on-chain memo as corroboration.
- **Tests run against `solana-test-validator`** (installed in the agave 4.2.2 bin directory) or injected runners, never against devnet.

**Warning signs:**
- The `anchors` row count stays at 0.
- `solana balance` reads 0.
- verify flags graphs with no corresponding edit.
- `getTransaction` returns null for old signatures.

**Phase to address:**
The area E phase. Funding is listed as an operator gate in its plan.

---

### Pitfall 10: RAGFlow (retired) dataset and version churn breaks `docs_search` and its citations

**What goes wrong:**
- **Churning IDs.** `docs/data-planes.md:41-50` wants a dataset per repo, re-ingested on merge, keeping "the last five dataset versions", so dataset IDs change. `main` has a single `RAGFLOW (retired)_DATASET_ID` (`.env.example:81`).
- **Locked embedding model.** RAGFlow (retired) fixes a dataset's `embedding_model` once it has chunks. `/api/v1/retrieval` refuses datasets with different embedding models in one call, and needs `dataset_ids` or `document_ids` ([RAGFlow (retired) HTTP API](https://ragflow (retired).io/docs/http_api_reference)).
- **21652a2's `ragflow (retired)Search` falls short in three ways:**
  - It sends no `dataset_ids`.
  - It returns `"ragflow (retired) <status>"` as if it were content.
  - It returns only `document_name` and 180 characters, with no source URL, commit or heading path. The citation contract in `data-planes.md:50` needs those.
- **Async parsing.** Parsing runs asynchronously after upload, so "ingested" is not "searchable".
- **Unreachable ingest trigger.** The GitHub-Action ingest trigger cannot reach a loopback `substrate-mcp` or a tailnet-only RAGFlow (retired) (`docs/data-planes.md:28, 52-65`).

**Why it happens:**
RAGFlow (retired)'s dataset is the unit of versioning, embedding and retrieval all at once. Treating it as a stable ID collapses those three.

**How to avoid:**
- **Resolve datasets by name** and an alias (the current version), with a cache in Dragonfly whose fallback is a list call. Never use a fixed ID.
- **Pin one embedding model** (TEI `bge-small`, `data-planes.md:50`) for all datasets, and assert it at resolve time.
- **Version swaps:**
  - create the new version;
  - wait for parse completion (poll document status);
  - swap the alias;
  - delete versions older than five.
- **Set document metadata at ingest:** source URL, commit and heading path.
- **Error handling:** `docs_search` returns `{chunks: [], degraded: reason}` on errors and never puts an error in content.
- **Trigger ingest from the VPS** (the skills-sync timer pattern, or a post-merge pull), not from GitHub-hosted runners.

**Warning signs:**
- `docs_search` returns `ragflow (retired) 4xx` text, or chunks with no URL.
- Retrieval fails after a re-ingest.
- More than five datasets per repo.

**Phase to address:**
The area D phase.

---

### Pitfall 11: Disk at 95% and no KVM sink Lane A, cua and worktrees

**What goes wrong:**
- **Disk.** `df -h /` shows 387 G total, 365 G used, 22 G free (95%). Docker images take 29.4 GB and volumes 21.1 GB (`docker system df`), the journal 1.0 GB, and `/var/lib/substrate/agentos` already 318 M.
- **Thin margins.** The dispatcher's worktree floor is 5 GiB (`worktree.py:117-120`). Lane A VM images, a cua image pull, a `solana-test-validator` ledger and parallel worktrees can each consume what is left.
- **No KVM.** There is no `/dev/kvm` (`ls`), so cua's QEMU path is out.
- **CPU steal.** "~75% CPU steal" was measured on this VPS: 4–7 s per `docker exec` (`acc30a8 packages/mcp-server/src/desktop/driver.ts:40`). It stretches every timeout.
- **Stale evidence.** v1.0 `03-lane-a/SUMMARY.md` records "Disk verified (56% used, 172G free)", which does not match the host.

**Why it happens:**
The build plan sized the host at 90% used with 40 GB free (§1, §12). Usage has grown since, and gates written as "check disk" were never made executable.

**How to avoid:**
- **One shared disk-gate helper with explicit thresholds:**
  - dispatcher worktree: refuse below 5 GiB;
  - host `openTask`: refuse below a VM budget measured in the area H phase;
  - `desktop_run`: no image pulls at all.
- **Use the running `substrate-desktop` webtop** (`docker ps`: `linuxserver/webtop:ubuntu-xfce`, up 9 days) for area G instead of pulling cua images.
- **Area H spike:** confirm that `@rivet-dev/agentos` (latest 0.2.22 on npm; `acc30a8` pins 0.2.21) needs no KVM [UNVERIFIED], and measure per-VM disk before committing.
- **Freeing space is an operator action.** Agents never run `docker prune` or delete volumes; the plan records it.
- **Test validators** run with `--limit-ledger-size` in a tmp directory, and are removed afterwards.

**Warning signs:**
- `df` above 96%.
- `low-disk` markers in Linear comments.
- `ENOSPC` in the journal.
- A desktop or host timeout rate rising together with load average.

**Phase to address:**
Phase 16 (shared gate helper). The area G and H phases. Area H's plan starts with a go/no-go spike.

---

### Pitfall 12: Cross-repo dependencies drift or block silently

**What goes wrong:**
Several v1.3 proofs depend on code outside this repo:
- **`swcstudiospace/agent-skills`**, the PR target for `skills.propose` and the `skills-sync` checkout.
  - It is dirty: an untracked `parallel-common/scripts/__pycache__/`.
  - `acc30a8 skills-sync.ts:55` refuses any non-empty `git status --porcelain`, so once the timer runs real code it refuses every 5 minutes. That is 288 warning events a day.
- **`claude-ultrathink`**: `fetchBrief` and `graph.register` (UAT 4–5).
- **`hermes-plugin`.**
- **`grok-hermes-connector`** (repo `mcp`): `redactor.py` and connector v0.4.
- **`hermes-linear-connector`**: the DoD endpoint `POST /v1/complete-issue` on `:8792`, used without auth (`dod-gate.ts`).
- **`agent-swarm`**: the lease bridge, whose claims hit the mirror (Pitfall 4).
- **`omp-ultrathink`**, and **`ultrathink`** for Grok Build.
- **Runtime versions:**
  - Muse Code is now 1.4.4 (`muse --version`), against 1.3.0 in the build plan §12, and its plugins directory now has `installed.json`.
  - herdr is 0.9.1.
- **Lane B runtime conflict.** PROJECT says "Orca before herdr" (`.planning/PROJECT.md:109`), while v1.3 calls herdr "the persistent runtime".

**Why it happens:**
Each repo has its own review gate and owner. A green test here cannot see them (`docs/adr/0001-*.md:603`).

**How to avoid:**
- **Every external call gets a pinned contract fixture** here: request and response shapes, with the version stamped. Examples: the DoD endpoint, herdr socket events, the Muse plugin hook.
- **Requirements that land in another repo** are listed separately, each with its own draft PR (desk rule: draft only, no merge).
- **Resolve Orca vs herdr** as a Key Decision before area A.
- **Ignore build artefacts in `agent-skills`.** The fix is a `.gitignore` change in agent-skills, through a PR. Alternatively, skills-sync ignores untracked files under `__pycache__/` (decide which).
- **Re-verify runtime versions** at each phase's start.

**Warning signs:**
- A `refuse-dirty` warning on every tick.
- A DoD gate `timedOut` on every completion.
- A Muse hook that stops emitting after an upgrade.

**Phase to address:**
Phase 16 (Orca/herdr decision; contract fixtures). The area A, B and F phases.

---

### Pitfall 13: Unit tests hit live stores or the production host

**What goes wrong:**
A test reaches a real endpoint and writes into production:
- Linear, Notion, RAGFlow (retired), Hindsight, Greptime, Timescale or devnet;
- the production state directories: `/var/lib/substrate/skills/{mirror.git,propose.key,proposals.jsonl}`, `/var/lib/substrate/worktrees`, `/var/lib/substrate/dispatcher/dispatcher.lock`;
- the running `substrate-desktop` container.

On this host `/etc/substrate/substrate.env` is the only env file, so any shell that sourced it, or any test that reads production variable names, hits production. A live test that silently skips also reads as a proof.

**Why it happens:**
The September code used module-level defaults that point at production paths: `LOCK_DIR`, `SKILLS_STATE`, `REDACT_MODULE=/root/src/repos/agent-substrate/...` (`acc30a8 projector/src/muse.ts:29`), and the default `SUBSTRATE_ENV_FILE`.

**How to avoid:**
Keep main's pattern:
- live suites are gated on `SUBSTRATE_TEST_PG_URL`, never `SUBSTRATE_PG_URL`;
- `describeLive = PG_URL ? describe : describe.skip`;
- a stated-skip test, so a skipped suite says so in its own output (`index-store.lease.test.ts:22-31, 535-540`);
- run-scoped markers with cleanup (`index-store.memory.test.ts:37-52`).

For v1.3:
- Every client takes an injected `fetchImpl` or runner. The September dispatcher (pytest with `httpx.MockTransport`) and mirror tests already do.
- Every state-directory path is a test seam that defaults to a tmp directory under test.
- Live variables are named `SUBSTRATE_TEST_<PLANE>_*`.
- Docker, `solana` and `git push`/`gh` are always behind injected runners in unit tests.
- Proofs are separate scripts, the way `scripts/greptime-smoke.ts` is. They run only with operator approval.

**Warning signs:**
- A test file references `LINEAR_API_KEY`, `RAGFLOW (retired)_URL`, `/var/lib/substrate` or `substrate-desktop` outside a seam default.
- New rows appear in production tables after a CI run.
- `bun test` output has skipped live suites but no stated-skip line.

**Phase to address:**
Phase 16 sets the convention and a store-lock-style scan for production paths in tests. Every area phase follows it.

---

### Pitfall 14: PRs too large to review, or mixing policy with plumbing

**What goes wrong:**
- **Size.** The port source is 85,579 lines across 362 files (`acc30a8`). Recent merged feature PRs ran from 111 to 2,147 additions (`gh pr list`: #9 +899, #11 +2,147, #13 +652, #16 +1,350, #18 +1,211). One PR per area would be 5–20× larger than anything the Greptile gate has passed here. [UNVERIFIED] how Greptile's quality degrades on very large diffs.
- **Policy hidden in plumbing.** Changes to `SURFACES`, `EVENT_KINDS` or the audit lists are fail-closed policy decisions (`docs/adr/0001-*.md:587-590`). Bundled into a 5,000-line port, they go unreviewed.
- **Hostnames in archives.** Porting `.planning` archives drags Railway hosts in (Pitfall 8).

**Why it happens:**
"Land the branch" framing, plus a desire to minimize Greptile cycles.

**How to avoid:**
- **Target at most ~1,500 added lines per PR**, one concern each:
  - unit files and parity;
  - policy enums and audit lists;
  - store-lock extensions;
  - one client module with its tests;
  - one MCP tool.
- **Draft PRs only** (desk rule). Stack PRs where they depend on each other.
- **Never port** `acc30a8 .planning/` archives. Summarize what they decided in this milestone's docs instead.
- **Every PR** passes Greptile with zero unaddressed findings. A FAILED or SKIPPED review is a blocker (desk rule).

**Warning signs:**
- A PR touching more than 20 files or more than 2,000 lines.
- A PR whose title names a feature but whose diff touches `types.ts` enums or `policy.ts`.

**Phase to address:**
All phases. The roadmap should size phases by PR count, not by area.

---

### Pitfall 15: Stubs and stale evidence recorded as "complete" (affects the area I UAT and every proof)

**What goes wrong:**
v1.0 phase SUMMARYs mark phases complete on stubs and invented evidence:
- `02-claims/SUMMARY.md`: "signHandoff (sha256 stub)", "Dispatcher stub".
- `03-lane-a/SUMMARY.md`: "core stubs", plus the disk figure that is false today.
- `04-skills-a2a/SUMMARY.md`: "Solana stub", where the `teachable.ts` "devnet-memo style sig" was a string built from `Date.now()`.
- `05-docs-hindsight/SUMMARY.md`: one line, "Stubs added".
- `06-ledger/SUMMARY.md`: "Proofs pass", while `acc30a8 06-VERIFICATION.md` records 0 anchors.

Phase 0 UAT has 8 of 8 scenarios pending (`.planning/milestones/v1.0-phases/00-brief/0-UAT.md:65-72`). Its evidence ("agent_events(8 rows)") dates from 2026-09-23.

**Why it happens:**
Autonomous runs closed phases on a compile-and-smoke basis. Live proofs need the operator, so they were deferred and then reported as done.

**How to avoid:**
- Each v1.3 requirement's acceptance names an observable live artefact. Examples: a Linear issue's label history; a devnet signature that resolves; a `docs_search` chunk with a URL and commit; a PR on agent-skills.
- The proof is run against isolated stores first. Then a live run happens with the operator's approval, recorded in a receipt under `docs/receipts/`.
- Area I re-runs all 8 UAT scenarios against main's current server (main has many more tools than the 9 in test 1).
  - Test 7 (an outage does not block agents) stops production `substrate-mcp`. It needs an approved window.
  - Tests 4–6 depend on `claude-ultrathink` and Cursor hooks on laptops (Pitfall 12).

**Warning signs:**
- A SUMMARY or receipt with no command output, row count, signature or URL.
- A "verified" number that contradicts `df`, `systemctl` or `git` today.

**Phase to address:**
The area I phase, plus the verification step of every area phase.

---

### Pitfall 16: The Dragonfly brief cache hides fresh claims

**What goes wrong:**
The brief is cached for 5 minutes (`docs/data-planes.md:26`). The phase 2 proof requires "Claude Code's brief shows it within a minute" (build plan §10). Since a lapsed lease reads as free everywhere (`coordination.md:105-107`), a cached brief can show a node as held after it lapsed, or as free after it was claimed. That invites duplicate work.

**Why it happens:**
The cache is keyed for read cost, not for coordination freshness.

**How to avoid:**
- Exclude the claims and leases section from the cached brief, and compose it fresh from the index.
- Alternatively, delete the repo and graph brief keys on every `granted`, `released`, `stolen`, `forced` and expiry event.
- A Dragonfly outage falls through, uncached (`data-planes.md:26`).

**Warning signs:**
A brief that names a holder `graph_get` does not show, or the reverse.

**Phase to address:**
The area D phase (cache), checked in the area B/C proof.

---

### Pitfall 17: `desktop_run` gives substrate-mcp host-root reach and leaks pixels

**What goes wrong:**
- **Host-root reach.** `acc30a8 desktop/driver.ts` runs `docker exec` against `substrate-desktop` from inside `substrate-mcp`, which runs as root with `RestrictAddressFamilies=... AF_UNIX`. Docker-socket access is root-equivalent on the host.
- **Unredactable pixels.** Screenshots go back as base64 in MCP image blocks (`driver.ts:194-199, 307`), and pixels cannot be redacted. A desktop showing a secret leaks it to the calling agent, and to the ledger if images are emitted.
- **Recorded keystrokes.** Typed text is recorded in `desktop.action` events (`driver.ts:10`).

**Why it happens:**
The webtop is the cheapest desktop, and driving it through `docker exec` is the simplest route.

**How to avoid:**
- A fixed argv allowlist; no shell. September already does this.
- `desktop_run` is fail-closed, and only operator-listed surfaces may call it.
- Events carry hashes and dimensions of screenshots, never image bytes.
- Typed text is redacted, or recorded only as a length.
- The desktop holds no credentials. Its password lives in `substrate-desktop.env` and never reaches the agent.

**Warning signs:**
- A `desktop.action` payload larger than a few KB.
- Base64 PNG markers in `events_query` output.
- `desktop_run` callable by a `swarm-*` token.

**Phase to address:**
The area G phase.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Cherry-pick `acc30a8` core-file hunks | Fast "port" | Re-introduces session-keyed claims and unauthenticated calls, and bypasses leases (Pitfall 2) | Never. Port leaf modules only |
| Keep production units pointing at a checkout that tracks `main` | No deploy tooling | Every merge is a deploy; files vanish under running processes (Pitfall 1) | Only with `ConditionPathExists` guards and PRs that declare their live effect |
| One `RAGFLOW (retired)_DATASET_ID` | Simple config | Breaks on the first re-ingest or version swap (Pitfall 10) | Area D spike only, never on main |
| In-memory dispatch registry | No schema change | Re-dispatch after every restart (Pitfall 5) | Never. Use a durable, unique-keyed record |
| Teachable text in a devnet memo | Human-readable chain | Publishes agent content permanently (Pitfall 6) | Never. Hash only |
| Widen `EVENT_KINDS`/`SURFACES` inside a feature PR | Collectors work immediately | An unreviewed fail-closed policy change; chain-affecting (ADR 0001:587-601) | Never. Use a dedicated PR |
| Fail-open `docs_ingest` that redacts and continues | Fewer refusals | Silent publication of near-miss secrets | Never. Refuse on findings |
| Shared per-Graph-ID worktree | One path per graph | Two agents in one tree (Pitfall 5) | Only if nodes of a graph are serialized |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Linear GraphQL | Polling `first: 50` without pagination; treating a personal API key as its own budget | Paginate. The 2,500 requests/hour budget is per user across keys, with leaky-bucket refill ([docs](https://linear.app/developers/rate-limiting)). Read `X-RateLimit-*`, and budget against `hermes-linear-poller`'s 2 s poll |
| Linear labels | Creating `agent:<surface>` concurrently; replacing the label set | Look the label up by name, create it, and re-search on a create error (`acc30a8 linear.ts:155-196`). Use only `addedLabelIds`/`removedLabelIds` |
| hermes-linear-connector DoD | Treating a timeout as approval | Only `completed: true` counts. Settle a timeout by reading Linear state (`acc30a8 dod-gate.ts`) |
| Notion | One PATCH per heartbeat | One PATCH per lease transition. Notion's documented average limit is about 3 requests/s [UNVERIFIED current value] |
| RAGFlow (retired) | Retrieval without `dataset_ids`; mixing embedding models; reading "uploaded" as "searchable" | Resolve datasets by alias, use one model, poll parse status, and store URL and commit metadata |
| Hindsight | Calling `retain` from a plane client | Only through the `memory_write` gate. Banks `sub-<surface>`/`pd-<seat>` via `HINDSIGHT_BANK_PREFIX` (`docs/data-planes.md:30-39`) |
| Dragonfly | Using it for locks, queues or sessions | Cache only. Falls through on outage (`docs/data-planes.md:26`) |
| Solana CLI | Airdrop loops; keypair contents in env; memo free text | Fund once (operator). `--keypair <path>` in an argv. Memo matches `MEMO_RE` |
| GitHub (`gh`) for skills PRs | GitHub search for idempotency | `gh pr view`/`gh pr list --head` plus a local ledger (`acc30a8 skills/propose.ts:9-10`) |
| herdr / Muse | Assuming the September socket and plugin APIs | Re-verify against herdr 0.9.1 and Muse 1.4.4. Muse `BRIEF.md` must be written atomically (tmp + rename); September's `writeFileSync` is not atomic |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Brief composed with RAGFlow (retired) and Hindsight calls inline | brief p95 above 800 ms (`docs/observability.md:152`); hook returns `""` at 1.5 s | Recall and docs behind Dragonfly with short timeouts; empty result on timeout | Any RAGFlow (retired) cold start or tailnet hop over ~700 ms |
| `docker exec` per desktop action under CPU steal | 4–7 s per action (`driver.ts:40`); MCP call timeouts | Batch steps per run, cap steps, run serially (`driver.ts:354` queue) | More than ~10 steps per `desktop_run` |
| Crash-looping units writing to the journal | Journal growth on a 95% disk | `ConditionPathExists`, a `StartLimitBurst` | Immediately on the next restart of an orphaned unit |
| Warning event per refused timer tick | Brief "Warnings" buried, ledger noise | Warn on state change, not on every tick | `skills-sync` refusing dirty: 288/day |
| Hourly anchor scanning `agent_events` by `ts` | Slow anchors, missed late events | Bounded period reads through a typed `greptime.ts` method, lag window | Hours with tens of thousands of events |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| `lease_id` in a Linear comment, Notion row or event | Anyone reading Linear can extend, release or complete the node | The mirror carries surface, session and epoch only. Add a leak test |
| Dispatched agents running as root with substrate.env readable | A child reads every credential, including other surfaces' tokens | Dedicated user where supported; otherwise record the boundary as accepted risk |
| A RAGFlow (retired) or Hindsight MCP server in agent configs | A second, unredacted door to the planes (v0.3 §4) | Store-lock rule, plus projector tests |
| `docs_ingest` that redacts and continues | Secrets published to every agent through `docs_search` | Refuse on findings; one shared redactor |
| Tailnet or Railway hostnames in committed docs | A desk-rule violation; it also fails `store-lock.test.ts:268-277` | Do not port `.planning` archives. Note: `docs/data-planes.md:12-16` already names forwarder machine names, which the desk rule forbids; do not add more [observation] |
| `desktop_run` open to every surface | Host-root reach via Docker exec; pixel leaks | Operator-listed surfaces, fail-closed, hashes not images |
| `skills.propose` with the host's `gh` credential and no surface check | Any agent opens PRs as the operator | The surface comes from the token. Propose-key file 0600 (`/var/lib/substrate/skills/propose.key`), read per request |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Dispatch fails silently (claim timeout after 900 s) | The operator labels an issue and nothing visible happens for 15 minutes | One marker comment on the issue per refusal reason (`low-disk`, `exited-unclaimed`, `claim-timeout`), as September does |
| Stale `agent:<surface>` labels after a lease lapses | The Linear board shows dead holders | Mirror expiry and forced release (Pitfall 4) |
| `docs_search` answers without a source | Agents cannot cite; humans cannot check | Return URL, commit and heading path; callers cite the source (`data-planes.md:50`) |
| An agent misprovisioned without a token "works" unbriefed | Looks healthy, does nothing coordinated (`docs/adr/0001-*.md:606`) | The dispatcher refuses to launch without the agent's token file present |

## "Looks Done But Isn't" Checklist

- [ ] **Production parity (Phase 16):** `ExecStart` targets of every enabled `substrate-*` unit are in `git ls-files` on main. Verify with `systemctl cat` plus `git ls-files`.
- [ ] **Policy enums:** collector kinds and surfaces accepted. Verify a collector smoke shows `stored: true` for every kind it emits.
- [ ] **Audit modes:** every new tool is in exactly one of `FAIL_OPEN_TOOLS`/`FAIL_CLOSED_TOOLS` and in `observe.ts`'s tool list.
- [ ] **Claim mirror (B):** expiry and forced release mirror too. Verify by letting a test lease lapse in an isolated graph and checking that the Linear fake received the release.
- [ ] **Dispatcher (C):** a restart does not re-dispatch. Verify by killing the dispatcher mid-launch and checking that one session exists per issue.
- [ ] **Docs plane (D):** chunks carry URL and commit, retrieval survives a dataset version swap, and ingest refuses a planted secret fixture.
- [ ] **Anchor (E):** the signature resolves on devnet, `verify` distinguishes `late`, `mismatch` and `cluster-reset`, and the memo matches `MEMO_RE`. Verify `anchors` has more than 0 rows only after an approved live run.
- [ ] **Skills (F):** the timers are green on main's code, `refuse-dirty` is not firing on every tick, and a proposed skill becomes a draft PR on agent-skills.
- [ ] **Desktop (G):** no image bytes in events; runs refused for unlisted surfaces.
- [ ] **Lane A (H):** the disk gate refuses below budget, and a VM survives a host restart (build plan §10 proof). Verify on an isolated graph.
- [ ] **UAT (I):** all 8 scenarios answered with fresh evidence, test 7 in an approved outage window.
- [ ] **Store lock:** extended rules for the RAGFlow (retired), Hindsight, Dragonfly and Solana env names, keypair arrays and native plane MCP wiring all pass.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Orphaned unit crash-loops after a reboot | LOW | Operator: `systemctl disable --now` the unit, or land its code on main and pull. Vacuum the journal if the disk is critical |
| Double dispatch on one issue | MEDIUM | Lease CAS leaves one holder. Stop the loser session; operator `force` release if needed. Remove the duplicate worktree; reconcile Linear labels |
| `lease_id` leaked to Linear or Notion | MEDIUM | The holder releases and re-claims (new epoch and id). Edit or delete the comment. The ledger cannot be scrubbed; the holder check limits the damage (`coordination.md:101-103`) |
| Secret ingested into RAGFlow (retired) | HIGH | Delete the document and dataset version, rotate the secret, re-ingest from a redacted source, and find who searched it via `events_query` on `docs_search` |
| Content anchored in a devnet memo | HIGH | Cannot be deleted from chain until a reset. Rotate anything sensitive and fix the memo format. Record an incident receipt |
| Devnet reset | LOW | Re-fund the key. `anchors` keeps roots. Verify reports `cluster-reset` for older periods; re-anchor is optional |
| RAGFlow (retired) dataset broken by a model mismatch | MEDIUM | Create a new dataset with the pinned model, re-ingest, swap the alias |
| Disk exhausted | MEDIUM | Operator cleanup (Docker images, journal, worktrees). The gates stop new VMs and worktrees first |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 1 Merge-is-deploy, orphaned units, failing timers | Phase 16 (foundation) | No `failed` substrate units; every `ExecStart` path tracked on main; PR template "live effect" line |
| 2 Port by merge | Phase 16 rules; each area phase | Core-file diffs re-implement against main's signatures; collector smoke `stored: true` |
| 3 Fail-open/closed misassignment | Phase 16; areas B, D, E, F, G | `policy.test.ts` covers every new tool; chaos smoke (Greptime down: emit fail-open, claim fail-closed; v0.3 §5) |
| 4 Lease authority vs mirror and dispatcher | Areas B then C | Lapse/force/steal mirror tests; dispatched agent completes with its own token; no-`lease_id`-leak test |
| 5 Label races and double dispatch | Area C | Restart-mid-launch test; one session per issue; worktree per node; rate-limit header handling tested |
| 6 Redaction before ingest and anchor | Phase 16 library; areas D, E, F | Planted-secret ingest refused; memo regex test; teachable anchor is a hash |
| 7 Secrets in configs, units, spawned agents | Phase 16; areas C, F, H | Extended store-lock scans; projector output tests; `systemctl show -p Environment` audit in the proof |
| 8 Store-lock bypass by new planes | Phase 16; areas D, E | New store-lock rules green; anchor job has no Greptime import outside `mcp-server/src` |
| 9 Devnet funding, resets, verify semantics | Area E (operator funding gate) | Deterministic-root test; late-event test; `solana-test-validator` integration; one approved devnet anchor |
| 10 RAGFlow (retired) churn | Area D | Version-swap test against a fake; citation fields present; model-pin assertion |
| 11 Disk and KVM | Phase 16 gate helper; areas G, H | Gate unit tests; area H go/no-go spike result recorded |
| 12 Cross-repo dependencies | Phase 16 decisions; areas A, B, F | Contract fixtures per dependency; agent-skills dirty-tree resolution; Orca/herdr Key Decision |
| 13 Test isolation | Phase 16 convention; all phases | No production names or paths in tests; stated-skip lines in output |
| 14 Review size | All phases (roadmap sizing) | Each PR ≤ ~1,500 added lines, one concern, Greptile clean |
| 15 Stubs as complete | Area I; every phase's verification | Receipts with live artefacts; UAT 8/8 answered |
| 16 Brief cache vs claims | Area D (with the B/C proof) | Claim visible in another surface's brief within 60 s |
| 17 `desktop_run` reach and pixel leaks | Area G | Surface allowlist test; events carry no image bytes |

## Sources

**This repo and worktree**
- `packages/mcp-server/src/store-lock.test.ts` (read in full).
- `.planning/PROJECT.md`.
- `.planning/milestones/v1.0-phases/*/SUMMARY.md` and `00-brief/0-UAT.md`.
- `docs/coordination.md`, `docs/data-planes.md`, `docs/railway-tailscale.md`, `docs/mcp-audit.md`, `docs/greptime-ledger.md`, `docs/memory-governance.md`, `docs/observability.md`, `docs/swarm-workspace.md`, `docs/adr/0001-agent-swarm-as-sdlc-mesh-on-substrate.md`.
- `packages/audit/src/policy.ts`, `packages/mcp-server/src/{redact.ts,types.ts,observe.ts}`.
- `index-store.*.test.ts` and `graph-bind.test.ts` (skip pattern).

**Port sources** (read-only via `git show`)
- `acc30a8`: `packages/ledger/src/*`, `packages/mcp-server/src/{chain.ts,redact.ts,skills/propose.ts,desktop/driver.ts}`, `packages/projector/src/skills-sync.ts`, `packages/dispatcher/src/substrate_dispatcher/worktree.py`, `.planning/phases/06-ledger/06-VERIFICATION.md`.
- `21652a2`: `packages/mcp-server/src/planes.ts`, `packages/miner/src/teachable.ts`.
- Dispatcher, mirror, linear, dod-gate and collector details are from a scout read of the September-lineage checkout `/root/src/worktrees/agent-substrate-p15` (presumed at or near `acc30a8` [UNVERIFIED exact commit]).

**Host** (read-only, 2026-10-08)
- `df -h /`, `ls /dev/kvm`, `docker ps`, `docker system df`, `journalctl --disk-usage`.
- `systemctl list-units/cat/show` for `substrate-*` and `hermes-linear-*`, with dispatcher and timer journal error lines.
- `git status` of `/root/agent-skills` and of the operator checkout (read-only).
- `solana --version` and `solana balance -u devnet` for the anchor key; `herdr --version`, `muse --version`, `orca --version`.
- `npm view @rivet-dev/agentos`, `pip index versions cua`.
- `gh pr list --state merged`.
- Key names only from `~/.config/hermes-linear/config.yaml` and `/etc/substrate/substrate-desktop.env`.

**Build plan**
- `local://build-plan-v02.md` (§2, §3.3–3.4, §4, §5, §6.3, §7, §10–12) and `local://build-plan-v03.md` (§1, §2, §4, §5).

**External**
- [Linear rate limiting](https://linear.app/developers/rate-limiting)
- [Solana devnet faucet](https://faucet.solana.com/)
- [Anza clusters](https://docs.anza.xyz/clusters/available)
- [RAGFlow (retired) HTTP API](https://ragflow (retired).io/docs/http_api_reference), and [ragflow (retired)#11429](https://github.com/infiniflow/ragflow (retired)/issues/11429) on embedding-model lock-in

---
*Pitfalls research for: agent-substrate v1.3 Build plan completion (areas A–I)*
*Researched: 2026-10-08*
