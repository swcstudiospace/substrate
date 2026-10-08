# Architecture Research

**Domain:** Agent Substrate v1.3 "Build plan completion". This milestone ports the unmerged September Phase 1–6 code onto `main` and builds what was never written.
**Researched:** 2026-10-08
**Confidence:** HIGH for the port map and the integration points, which were checked against git objects and `origin/main` source. MEDIUM for the phase sizing. LOW where a line is marked `[UNVERIFIED]` or `[INFERENCE]`.

> **Scope correction.** The brief named `substrate/ut-mughkkc0-73909228` (U) and `21652a2` (P) as the unmerged code, but the main port source is a third branch.
>
> **`docs/data-planes-tailscale`** (`acc30a8`, the same commit locally and on `origin`; merge-base with main `31d236a`):
> - It has 276 commits that are not on main.
> - It is a strict superset of U: `git merge-base --is-ancestor substrate/ut-mughkkc0-73909228 docs/data-planes-tailscale` returns true.
> - Beyond U it adds Phase 3 Lane A, Phase 4 skills, Phase 5 `desktop_run`, Phase 6 ledger primitives, the global chain, and Phase 7 redaction.
> - Main took only its docs, as `ace4a62`, by way of `docs/data-planes-tailscale-clean` (#2).
>
> In this file **D** means `acc30a8`. Wherever U and D both contain a file, D's copy is the newer one and the one to port.
>
> **Where the two missing timer sources live:**
>
> | File | Introduced by | Branches that contain it |
> |---|---|---|
> | `packages/projector/src/skills-sync.ts` | `354310c` "feat(04-04): skills sync timer and Claude/Grok projector" | only `docs/data-planes-tailscale` (local and origin) |
> | `substrate_miner` | `be77187` "feat(04-07): Hermes pending-skill bridge, queue drain and cron precheck" | same |
>
> Sources: `git log --all --oneline -- packages/projector/src/skills-sync.ts`, `git log --all -S substrate_miner`, `git branch -a --contains`.

## Standard Architecture

### System Overview (target state at the end of v1.3)

```
┌──────────────────────────── Control plane (source of truth) ─────────────────────────────┐
│  Linear (labels dispatch:<s> / agent:<s>, state, comments)    Notion Agent Task Graph    │
│  hermes-linear-connector :8792 (/v1/complete-issue = DoD gate)                           │
└───────▲──────────────────────────▲───────────────────────────────▲───────────────────────┘
        │ poll + label swap        │ mirror (claim/release/done)   │ Agent / Status
┌───────┴─────────┐   ┌────────────┴───────────────────────────────┴───────────────────────┐
│ substrate-      │   │                substrate-mcp 127.0.0.1:7410 (bun)                  │
│ dispatcher (py) │──▶│  server.ts: bearer→surface, auditedRest, /mcp (McpCaller)          │
│ graph_find      │   │  mcp.ts tools ── service.ts `Substrate` ──┬── IndexStore (Postgres)│
│ worktree/<gid>  │   │   + graph_find, issue_get, docs_search,   │   leases (lease.ts)     │
│ launch:         │   │     docs_ingest, skills_propose,          ├── GreptimeClient        │
│  hermes chat ───┼─┐ │     desktop_run                           │   agent_events, anchors │
│  host /tasks ───┼┐│ │  mirror.ts→linear.ts/notion.ts/dod-gate.ts├── planes/ (RAGFlow,     │
└─────────────────┘││ │  desktop/ (docker exec substrate-desktop) │   Hindsight, Dragonfly) │
                   ││ │  skills/propose.ts (git+gh → agent-skills)└── observer/audit       │
                   ││ └───────▲───────────────▲───────────────▲────────────────────────────┘
                   ││         │ POST /events  │ POST /brief   │ POST /skills/propose
┌──────────────────┴┴───┐ ┌───┴────────────┐ ┌┴─────────────┐ ┌┴───────────────────────────┐
│ substrate-host (node) │ │ collectors     │ │ collector-   │ │ skills plane               │
│ :7411 /tasks          │ │ grok, herdr    │ │ muse →       │ │ skills-sync.timer (ff+proj)│
│ agentOS VM per gid    │ │ (socket),      │ │ .substrate/  │ │ skills-bridge.timer (py)   │
│ (Lane A, claude-code) │ │ cursor-stop    │ │ BRIEF.md     │ │ Omp ext, Hermes cron miner │
└───────────────────────┘ └────────────────┘ └──────────────┘ └────────────────────────────┘
┌──────────────────────────── Ledger plane ────────────────────────────────────────────────┐
│ packages/ledger: merkle/memo/period/rpc/solana + NEW anchor.ts (hourly timer)            │
│ → Solana devnet memo (solana CLI argv) → Greptime `anchors`; `substrate verify` re-checks │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Owns | Implementation (where it comes from) |
|---|---|---|
| `substrate-mcp` (`packages/mcp-server`) | auth, MCP tools, REST, leases, ledger writes, mirror side effects | main's code (class `Substrate` in `service.ts`). Every port attaches to main's lease-fenced `claimNode` / `releaseNode` / `completeNode` (`service.ts` :892/:1033/:1090 on main). |
| Mirror (`mirror.ts`, `linear.ts`, `notion.ts`, `dod-gate.ts`) | Linear state, `agent:<surface>` label, a one-line comment, removal of `dispatch:*`; the Notion `Agent`/`Status`; the DoD gate | D's files, mostly as-is (D `mirror.ts`:195-221). Call sites are rewritten onto main. |
| `substrate-dispatcher` (`packages/dispatcher`, Python) | Linear poll, `graph_find`, a worktree per Graph ID, launching the session, the landed-claim check | D's package. `mcp.py` gets a bearer token; `launcher.py` gets a prompt that handles leases. |
| Collectors (`packages/collectors`) | herdr socket → `agent.*` events; Muse brief writer → `.substrate/BRIEF.md`; Cursor stop transcript | D's `herdr.ts`, `herdr-map.ts`, `muse.ts`, `cursor-stop.ts` as-is, plus additions to `types.ts`. |
| Projector (`packages/projector`) | Muse plugin, Cursor hooks, per-skill symlinks, skills sync | D's `muse.ts`, `skills.ts`, `skills-sync.ts` and `omp/substrate-skills.ts`, plus the `cursor.ts` hunk. |
| Miner (`packages/miner`, Python) | Hermes pending-skill bridge, Omp/Grok queue drain, the Hermes hourly precheck | D's `substrate_miner/*`. P's `teachable.ts` is dropped. |
| Planes (`packages/mcp-server/src/planes/`, new) | RAGFlow retrieval/ingest, Hindsight recall/retain, Dragonfly cache | Pure helpers from P's `planes.ts`, reshaped to main's `docs/data-planes.md` contract. |
| Ledger (`packages/ledger`) | Merkle root, memo v1, hour buckets, solana argv, RPC reader, **anchor job** | D's primitives as-is. `anchor.ts` and the verify integration are **new**. |
| Desktop (`mcp-server/src/desktop/`) | `desktop_run` against the `substrate-desktop` webtop over `docker exec` with xdotool and xwd | D's files. The guard moves to main's `McpCaller`. |
| `substrate-host` (`packages/host`, node) | Lane A: one agentOS VM per Graph ID, `/tasks` API, resume, the approvals broker | D's package (`@rivet-dev/agentos` 0.2.21). Its substrate client is rewritten for tokens, `lease_id` and heartbeat. |
| A2A Agent Cards (new) | one card per surface, with skills from the library and teachable moments | **Not on any branch.** `8db99f9` has only stub types (`types.ts`:155-167) and `miner/src/teachable.ts`. Build it new. |

## Recommended Project Structure (delta on main)

```
packages/
├── mcp-server/src/
│   ├── mirror.ts, linear.ts, notion.ts, dod-gate.ts   # B: from D, as-is
│   ├── planes/ragflow.ts, hindsight.ts, dragonfly.ts  # D: split from P planes.ts
│   ├── skills/{propose,propose-auth,frontmatter}.ts   # F: from D
│   ├── desktop/{actions,driver}.ts                    # G: from D
│   ├── agent-card.ts                                  # F2: new (A2A cards)
│   └── (edits) types.ts, config.ts, mcp.ts, service.ts, server.ts, redact.ts,
│               greptime.ts, event.ts, index-store.ts, observe.ts
├── audit/src/policy.ts            # every new tool goes in FAIL_OPEN or FAIL_CLOSED
├── collectors/src/{herdr,herdr-map,muse,cursor-stop}.ts   # A (+F feed)
├── projector/src/{muse,skills,skills-sync}.ts, projector/omp/substrate-skills.ts
├── dispatcher/ (python: substrate_dispatcher/*, tests/)   # C (+host.py in H)
├── miner/ (python: substrate_miner/*, skills/, hermes/)   # F
├── ledger/src/{merkle,memo,period,rpc,solana,anchor,index}.ts  # E
└── host/ (node + package-lock.json)                         # H
infra/
├── vps/substrate-{collector-herdr,collector-muse,dispatcher,host}.service
├── vps/substrate-skills-{sync,bridge}.{service,timer}
├── vps/substrate-ledger-anchor.{service,timer}    # new, hourly
├── desktop/substrate-desktop.sh                    # G
└── sandbox/Dockerfile                              # H
```

### Structure Rationale

- **Keep D's file layout.** The units already installed in `/etc/systemd/system` point at these exact paths. For example, `substrate-collector-herdr` runs `bun packages/collectors/src/herdr.ts --watch` (`systemctl show`). Porting to the same paths repairs those units with no unit change.
- **Split `planes.ts` into `planes/`.** P's single file mixes three clients, a CLI-shaped solana runner and a dead `dragonflyCommand`. One module per plane matches the per-plane fail-open budget in `docs/data-planes.md` §"Fail-open budget".
- **The Python packages stay Python.** The dispatcher and the miner come with 149 passing pytest cases on D (`11ba60f` baseline: "dispatcher 149/0"). A rewrite in TypeScript buys nothing.

## Port Map

Legend:
- **fits** = take D's (or U's) file unchanged.
- **adapt** = take the file, change the named main module.
- **rewrite** = reimplement the intent on main's code.
- **drop** = do not port.

"Main changed" means `git diff 31d236a origin/main -- <file>` is non-empty.

### A. Every file changed on `substrate/ut-mughkkc0-73909228` vs `31d236a` (104 files)

| # | File (U LOC) | Main changed? | Verdict | Target / reason |
|---|---|---|---|---|
| 1 | `AGENTS.md` (+5) | yes | **drop** | Main already carries the same substrate-brief block plus desk rules. |
| pl-1 (5 files) | `.planning/PROJECT.md` (+3), `.planning/ROADMAP.md` (+85), `.planning/STATE.md` (+195), `.planning/WINDOWS.md` (+92), `.planning/state.json` (+43) | yes for PROJECT, ROADMAP and STATE (main rewrote them for v1.1–v1.3) | **drop** | September GSD state. v1.3 has its own. |
| pl-2 (1) | `.planning/phases/00-brief/0-UAT.md` (67 lines changed) | main keeps an older copy at `milestones/v1.0-phases/00-brief/0-UAT.md` (8 pending) | **drop the file; carry its results into phase 16** | U/D record the UAT run on 2026-09-24: `status: complete`, 5 passed (1, 2, 3, 7, 8), 4 partial, 5 and 6 issues. Scenario 4: the `fetchBrief` hook lives on claude-ultrathink PR #1, which is not merged. Scenario 5: the `ultrathink-kickoff` SKILL.md does not call `graph_register`. Scenario 6: no `.git/hooks/post-commit` and no substrate entries in `~/.cursor/hooks.json`. These are cross-repo fixes, not substrate code. |
| pl-3 (1) | `.planning/phases/00-brief/0-VERIFICATION.md` (+157) | n/a | **drop** (reference) | Historical evidence. |
| pl-4 (28) | `.planning/phases/01-lane-b/`: `01-01..01-10-PLAN.md` (10), `01-01..01-10-SUMMARY.md` (10), `01-10-PROOF.md`, `01-BASELINE.md`, `01-PATTERNS.md`, `01-PROOF.md`, `01-RESEARCH.md`, `01-VALIDATION.md`, `01-VERIFICATION.md`, `CONTEXT.md` | n/a (main has a different `milestones/v1.0-phases/01-lane-b/CONTEXT.md`) | **drop** (reference) | Record of the real Phase 1 (`passed`, 10/10). Read it for the herdr and Muse decisions; do not copy it into `.planning/phases`. |
| pl-5 (31) | `.planning/phases/02-claims-and-dispatch/`: `02-01..02-09-PLAN.md` (9), `02-01..02-07` and `02-09-SUMMARY.md` (8), `02-01-TRACER.md`, `02-09-TRACER.md`, `02-03-BASELINE.md`, `02-05-SMOKE.md`, `02-06-SMOKE.md`, `02-BASELINE.md`, `02-CONTEXT.md`, `02-LINEAR-ARCHIVED.md`, `02-NOTION-SCHEMA.md`, `02-PATTERNS.md`, `02-PROOF.md`, `02-RESEARCH.md`, `02-VALIDATION.md`, `COVERAGE.md` | n/a | **drop** (reference) | Phase 2 record (`passed`, 65/65). Read `02-NOTION-SCHEMA.md` and `02-CONTEXT.md` D-05/D-06 before phase 19. |
| 62 | `infra/vps/substrate-collector-herdr.service` (36) | no | **fits** | Already installed and running since 2026-09-29 from code that is no longer on disk on main. Porting the file restores it. |
| 63 | `infra/vps/substrate-collector-muse.service` (35) | no | **fits** (trim) | Remove the dead `SUBSTRATE_COLLECTOR_STATE` line, which `muse.ts` never reads. Needs `SUBSTRATE_MUSE_REPOS` in `substrate.env`. |
| 64 | `infra/vps/substrate-dispatcher.service` (46) | no | **adapt** | Add a token env line (`SUBSTRATE_TOKEN_*`) for the dispatcher's own MCP calls. The installed unit has `NRestarts=114888` and currently idles on `SUBSTRATE_DISPATCH_DISABLED=1` (journal). |
| 65 | `packages/collectors/src/herdr-map.ts` (105) | no | **adapt** (`types.ts`) | Maps herdr events to `agent.detected`, `agent.status`, `agent.exited` and `note`. Add those kinds to `EVENT_KINDS` and `herdr` to `SURFACES`. |
| 66 | `packages/collectors/src/herdr-map.test.ts` (75) | no | **fits** | — |
| 67 | `packages/collectors/src/herdr.ts` (357) | no | **fits** | herdr 0.9.1 ND-JSON over its Unix socket (`herdr --version` → 0.9.1 on the host). POSTs `/events` with `SUBSTRATE_TOKEN`, as main's `grok.ts` does. |
| 68 | `packages/collectors/src/muse.ts` (198) | no | **adapt** (`types.ts`) | Writes `<repo>/.substrate/BRIEF.md` from `POST /brief` (main returns text/markdown) and emits `brief.delivered`. Add that kind. |
| 69 | `packages/collectors/src/muse.test.ts` (120) | no | **fits** | — |
| 70 | `packages/dispatcher/pyproject.toml` (28) | no | **fits** | httpx ≥ 0.27, pytest. |
| 71 | `…/substrate_dispatcher/__init__.py` (11) | no | **fits** | — |
| 72 | `…/__main__.py` (151; D 162) | no | **fits** (take D) | flock plus a 30 s reap→tick loop. D adds the `HostClient` wiring (phase H). Known gap: the session registry is in memory only (Greptile P1). |
| 73 | `…/dispatch.py` (227; D 279) | no | **adapt** | `DISPATCHABLE_SURFACES = {"hermes","claude-code"}` (D :24). Keep it. Phase C ships hermes only; claude-code is wired in phase H. |
| 74 | `…/launcher.py` (192; D 222) | no | **adapt** (leases) | `PROMPT_TEMPLATE` tells Hermes to call `graph_claim`/`graph_complete` with no bearer token and no `lease_id`. Main's `graph_release`/`graph_complete` need the holder's `lease_id`, and main's leases expire after `ttl_seconds` (default 900, `lease.ts`), so the prompt must also call `graph_heartbeat`. Pass the surface token through the env allowlist. |
| 75 | `…/linear.py` (165) | no | **fits** | Additive `removedLabelIds` only (D :160). |
| 76 | `…/mcp.py` (147) | no | **adapt** (auth) | Sends no `Authorization`. Main answers 401 when any `SUBSTRATE_TOKEN_*` is set (`server.ts` :254). |
| 77 | `…/sessions.py` (247; D 251) | no | **fits** | The landed-claim test reads `graph_get` `claimed_by`/`claim_session`. Main's `graph_get` still returns those and strips only `lease_id`. |
| 78 | `…/worktree.py` (147) | no | **fits** | `/var/lib/substrate/worktrees/<gid>` on branch `substrate/<gid>`. Refuses below 5 GiB free; this is the Lane B half of the disk gate. |
| 79–84 | `packages/dispatcher/tests/test_{clients,dispatch,launcher,main,sessions,worktree}.py` | no | **fits** (take D); `test_launcher`, `test_clients` **adapt** | They follow the source verdicts above. |
| 85 | `packages/mcp-server/src/config.ts` (+3; D +13) | **yes** (+268) | **adapt** (`config.ts`) | Re-add `hermesLinearUrl` (`HERMES_LINEAR_URL`, default `http://127.0.0.1:8792`) and `dodGateTimeoutMs` (`SUBSTRATE_DOD_GATE_TIMEOUT_MS`) to main's `loadConfig`. Main already has the `linearApiKey`/`notionApiKey`/`notionTaskGraphDataSource` fields, but nothing reads them. |
| 86 | `packages/mcp-server/src/dod-gate.ts` (80; D 91) | no | **fits** (take D) | `POST {HERMES_LINEAR_URL}/v1/complete-issue`. Never throws. Port 8792 is listening on the host (`ss -ltnp`). |
| 87 | `packages/mcp-server/src/index-store.ts` (+25) | **yes** (+1202) | **adapt** (leases in `index-store.ts`) | Take `findNodesByLinear` and `LinearNodeMatch`; return `toNode()` with `lease_id` stripped. **Drop** U's `releaseNode` CAS on (`claimed_by`, `claim_session`): main's lease-fenced `releaseNode` supersedes it, and main has deliberately no `setNodeState` (`index-store.ts` :732; tripwire in `service.test.ts` :216). |
| 88 | `packages/mcp-server/src/index.ts` (+1) | **yes** (+42) | **adapt** | One boot line logging `mirror.describe()` in main's rewritten entry point. |
| 89 | `packages/mcp-server/src/linear.ts` (201; D 225) | no | **fits** (take D) | `LinearClient`: labels, additive `issueUpdate`, `commentCreate`, and `issueText`, which phase H's `issue_get` needs. |
| 90 | `packages/mcp-server/src/mcp.ts` (+57) | **yes** (+654) | **adapt + rewrite** (tool registration in `mcp.ts`) | **Adapt** `graph_find` (read-only). **Rewrite** U's `graph_release`/`graph_complete` signatures (`session_id`, `surface`, `dod`): keep main's `{lease_id, force, state}` and add only an optional `dod` object to `graph_complete`. **Drop** `ownerSurface`. Each new tool also goes into `observe.ts` `KNOWN_TOOLS` and `audit/src/policy.ts` (unknown tools are fail-closed). |
| 91 | `packages/mcp-server/src/mirror.ts` (211; D 240) | no | **fits** (take D) | Its API is `Mirror.claim/release/review/done/linearState`. Its inputs (`GraphNode.linear_issue_id`, `linear_identifier`, `notion_page`) all exist on main. Only the call sites change. |
| 92 | `packages/mcp-server/src/mirror.test.ts` (442) | no | **fits** | — |
| 93 | `packages/mcp-server/src/notion.ts` (165) | no | **fits** | Writes only `Agent`, `Status`, `Linear State` and `Completed`. Refuses pages outside `NOTION_TASK_GRAPH_DS`. |
| 94 | `packages/mcp-server/src/notion.test.ts` (229) | no | **fits** | — |
| 95 | `packages/mcp-server/src/service.ts` (+239) | **yes** (+1392) | **rewrite** (`service.ts`) | U rebuilds release and complete around `ownershipRefusal` (surface, session) and `setNodeState`. Main uses `lease_id`, epoch CAS, `decideClaim`, and claims that fail closed when the ledger misses (`requireRecordedClaims`). Re-express the mirror and the DoD gate as side effects of main's verdicts: (1) mirror the claim only when `decision === "granted"`, after the event lands; (2) `completeNode` calls `DodGate` **before** the lease-fenced release, and on a fail returns `completed:false` with the lease kept; (3) mirror failures become `warning` events, never errors. Port `findNode` as-is. |
| 96 | `packages/mcp-server/src/service.test.ts` (+618) | **yes** (+1653) | **rewrite** | Its fakes assume `setNodeState` and session ownership. |
| 97 | `packages/mcp-server/src/types.ts` (+7) | **yes** (+284) | **adapt** (`EVENT_KINDS`, `SURFACES`) | Add `herdr` to `SURFACES` and `agent.detected`, `agent.status`, `agent.exited`, `brief.delivered` to `EVENT_KINDS`. **Drop** U's `release` and `complete` kinds: main already records release and complete as `note`/`warning` with `payload.action` (`service.ts` :1033). |
| 98 | `packages/projector/src/muse.ts` (189) | no | **fits** | Muse plugin with a PostToolUse hook emitting `tool.call`. `muse` is at `/root/.local/bin/muse`. The CLI contract for `muse plugins install` is `[UNVERIFIED]`. |

Totals: 104 files = 66 planning or state files (pl-1..pl-5, all dropped; the 0-UAT results feed phase 16) + 38 code, infra and test files (rows 1 and 62–98; rows 79–84 group the 6 dispatcher test files).

### B. Every file in commit `21652a2` (P)

| File (Δ) | Main changed? | Verdict | Target / reason |
|---|---|---|---|
| `.env.example` (+21/−4) | yes | **adapt** | Main already lists `DRAGONFLY_URL`, `HINDSIGHT_URL`/`HINDSIGHT_API_KEY`, `HINDSIGHT_BANK_PREFIX` and `RAGFLOW_DATASET_ID`. P's single `HINDSIGHT_BANK` contradicts main's per-surface `sub-<surface>` banks (`docs/data-planes.md` §Hindsight banks). The host's `substrate.env` defines `HINDSIGHT_BANK` and not the prefix, so decide which one wins and record it in REQUIREMENTS. |
| `packages/cli/src/index.ts` (+33/−12) | yes | **rewrite** | The hunk edits `docs`/`anchor` stub cases from `8db99f9` that main does not have. Main's CLI switch is at `cli/src/index.ts` :369 (brief, emit, run, verify, drift, handoff, evidence, lessons). Add `docs search`, `docs ingest` and `skills propose`, and extend `verify`. Do not add `anchor --graph`. |
| `packages/mcp-server/src/config.ts` (+7) | yes | **adapt** (`config.ts`) | Re-add `planesFromEnv` fields by hand. The hunk context relies on `8db99f9`'s `loadMemoryPolicy`, which main lacks. |
| `packages/mcp-server/src/mcp.ts` (+26) | yes | **rewrite** (tool registration) | P's `docs_search` returns raw `{ok,status,body}`. Main's contract requires chunk, heading path, source URL and commit, with a 10-minute Dragonfly cache. It also needs registration in `KNOWN_TOOLS` and the audit policy (FAIL_OPEN). |
| `packages/mcp-server/src/planes.ts` (+194) | n/a (new) | **adapt** → `planes/` | Keep `planesFromEnv`, `parseRedisUrl`, `hindsightRecall` and `ragflowSearch` (`POST {RAGFLOW_URL}/api/v1/retrieval`, which needs `dataset_ids` `[UNVERIFIED]`). Replace the raw RESP client, which has no TLS for `rediss://` and no caller, with Bun's built-in Redis client `[UNVERIFIED API in bun 1.4]`. Drop `anchorMemoOnDevnet`: it uses `solana` from PATH with no `--output json` and scrapes the signature with a regex. D's `ledger/src/solana.ts` uses an absolute path, `--fee-payer` and JSON output. |
| `packages/mcp-server/src/planes.test.ts` (+55) | n/a | **adapt** | Follows the split. |
| `packages/mcp-server/src/service.ts` (+10) | yes | **rewrite** (`service.ts`) | Main's `brief()` wraps `composeBrief` in observer/SLO timing. Add Hindsight recall as a fail-open section inside the 1.5 s brief budget (`docs/data-planes.md` §Fail-open), reading cross-bank as the docs specify. |
| `packages/miner/src/teachable.ts` (+18/−6) | n/a (no `packages/miner` on main) | **drop** | It depends on `8db99f9` stub types (`TeachableMoment`, `AgentCard`), and its per-teachable memo `substrate:<graph_id>:<framing>` cannot be checked by D's `memo.ts` `parseMemo`. Teachable anchoring is redesigned below (E). |

### C. Port map for D-only files (Phases 3–7; not on U)

| Area | Files (LOC) | Verdict | Target / reason |
|---|---|---|---|
| A | `packages/collectors/src/cursor-stop.ts` (220) + test | **fits** | Cursor stop hook: copies a redacted transcript and emits `session.end` (already a kind). It feeds the miner. |
| A/F | `packages/projector/src/cursor.ts` (+25) | **fits** | Main's file is unchanged since `31d236a`, so the hunk applies. Ship it with `cursor-stop.ts`. |
| F | `mcp-server/src/skills/propose.ts` (640), `propose-auth.ts` (38), `frontmatter.ts` (20), tests | **adapt** (`redact.ts`, `service.ts`, `mcp.ts`, `server.ts`) | git + `gh pr create --repo swcstudiospace/agent-skills` through `execFile`, with gh's stored credential (`/usr/bin/gh`). `propose-auth` is rebuilt on main's `McpCaller`: an authenticated surface, or the `x-substrate-propose-key` header for the root-only key file. Remove the hard-coded `Refs SPE-2734` from the commit message. |
| F | `mcp-server/src/redact.ts` (+209), `redact.test.ts` | **adapt** (merge) | Add D's D-04 rules (`<private>`, lowercase api-key, AWS/Google/Slack/npm/GitLab/DO/`sk-proj`/`pk-`/`rk-`) and the `redactSkillContent`/`scanSkillFiles` engine. **Keep** main's `COUNTER_KEY`/`isCount`: D would redact `input_tokens` counts. |
| F | `projector/src/skills.ts` (468), `skills-sync.ts` (137), `omp/substrate-skills.ts` (251), tests | **fits** | Fixes the failing `substrate-skills-sync.timer` without changing the unit. |
| F | `packages/miner/**` (`substrate_miner/{__init__,__main__,bridge,monitor}.py`, `pyproject.toml`, tests, `skills/substrate-skill-miner/SKILL.md`, `hermes/substrate-skill-miner-monitor.sh`) | **fits** | Fixes the failing `substrate-skills-bridge.timer`. The Hermes cron skill is the "hourly miner". |
| F | `infra/vps/substrate-skills-{sync,bridge}.{service,timer}` | **fits** | Identical to the installed units, which fire every 5 min and fail (`systemctl list-units`). |
| G | `mcp-server/src/desktop/actions.ts` (111), `driver.ts` (359), tests; `infra/desktop/substrate-desktop.sh` (146) | **adapt** (`types.ts` `desktop.action`; `mcp.ts`; `service.ts` `runDesktop`; audit and `KNOWN_TOOLS`) | Without `desktop.action` in `EVENT_KINDS`, `normalizeEvent` rejects the driver's events and the failure is swallowed, leaving zero audit rows. Guard: `caller.surface !== null`. This does not depend on Phase 4 `propose-auth`. |
| H | `packages/host/src/{api,audit,hostfns,main,mcp-proxy,options,sandbox-options,sandbox-provider,seed,substrate,sync,tasks,telegram,vm}.ts` (~4.3k), `package.json`, `package-lock.json` | **adapt**, with `substrate.ts` **rewritten** | `substrate.ts` is an anonymous JSON-RPC client with no `lease_id` and no heartbeat. `tasks.ts` must persist the `lease_id` (0600) and run a heartbeat per task. `seed.ts` writes an MCP entry with no headers. `main.ts` hard-codes the operator checkout path. `api.ts`, `telegram.ts` and `mcp-proxy.ts` fit. Pinned to `@rivet-dev/agentos` 0.2.21, with workarounds for three of its defects in `vm.ts`; npm latest is 0.2.22 per the scout's `npm view`. |
| H | `dispatcher/.../host.py` (224) + `test_host.py`; `infra/vps/substrate-host.service` (52); `infra/sandbox/Dockerfile` (60) | **fits** after C; the unit needs **adapt** | Unit: add a token line. Its `WorkingDirectory` is the operator checkout's `packages/host`; the unit is inactive and dead now. |
| H | `server.ts` `POST /issue`, `mcp.ts` `issue_get`, `service.ts` `getIssue` (D hunks) | **adapt** (`server.ts` via `auditedRest`) | Untrusted-text cap and banner (`ISSUE_TEXT_NOTICE`). Needs `linear.ts` `issueText`. |
| E | `packages/ledger/src/{merkle,memo,period,rpc,solana}.ts` (411) + tests | **fits** | Pure primitives: RFC 6962 Merkle; memo `substrate:v1:<hour>:<root>:<count>`; the solana CLI argv at `/root/.local/share/solana/install/active_release/bin/solana` (present). Nothing on D calls them. |
| E | `packages/ledger/package.json` | **adapt** | `main: src/index.ts` exists on no branch. Add `src/index.ts`. |
| E | `mcp-server/src/chain.ts` (253) + test | **drop** (keep the idea) | A global `IngestChain` conflicts with main's per-session `lastHash`/`chainTip`, `ensureAppendMode` and the `EmitResult` shape. See the ledger decision below. |
| E | `greptime.ts` (+187/−51), `event.ts` (+120), `fixtures/pre-cutover-rows.json` | **adapt selectively** | Take `rowToEvent`, `hourEvents`, `lastEventBefore` and `verifyGlobalChain` (needed to verify the D-era segment), plus the period-keyed `anchors` DDL. Drop `insertEvents`/`chainHead`, and the `lastHash` removal (main's `append` and `handoff` still call it). |
| E | `cli/src/index.ts` (D +203) | **adapt** | Hour lines in `verify` and `SUBSTRATE_VERIFY_TIMEOUT_MS`. `skills propose` belongs to F. |
| — | `README.md`, `docs/railway-tailscale.md`, `docs/data-planes.md` | **drop** | Main already took them in `ace4a62`. |

## Architectural Patterns

### Pattern 1: Side effects hang off main's lease verdicts, never a second ownership model

**What:** Linear and Notion mirroring, the DoD gate and the dispatcher's label swap all run after main's `claimNode`/`releaseNode`/`completeNode` decide. None of them decides ownership.

**When to use:** phases B, C and H.

**Trade-offs:** Mirror failures leave Linear briefly stale. They are surfaced as `warning` events, and drift is caught by `coord_drift_scan`. The alternative, U's `ownershipRefusal`, would reintroduce the unfenced (surface, session) ownership that SPE-5053 removed.

```typescript
// service.ts (main) — sketch
const result = await this.index.claimNode(/* … lease … */);
const verdict = decideClaim(/* … */);
if (verdict.decision === "granted" && result.action !== "renewed") {
  const failures = await this.mirror.claim({ graphId, nodeId, surface, sessionId, node: result.node, repo, branch });
  await this.warn(failures, "claim", { surface, graph_id: graphId, node_id: nodeId });
}
// completeNode: gate first, lease-fenced release second
const gate = await this.dodGate.completeIssue(node, dod);           // never throws
if (!gate.ok) return { completed: false, reason: gate.reason, lease };  // claim kept, issue In Review
return this.releaseNode(graphId, nodeId, { lease_id }, caller, "completed");
```

### Pattern 2: A new tool takes four registrations

**What:**
1. `mcp.ts` `server.registerTool`, with its guard on `McpCaller`.
2. `observe.ts` `KNOWN_TOOLS` (:309).
3. `audit/src/policy.ts` `FAIL_CLOSED_TOOLS` or `FAIL_OPEN_TOOLS`; `policy.test.ts` pins both sets as exhaustive.
4. A REST twin also needs `KNOWN_ROUTES` (:52) and `auditedRest`.

**Classification:**
- Fail-closed: `graph_find`, `skills_propose`, `docs_ingest`, `desktop_run`. `desktop_run` is fail-closed because it acts on a desktop; D's view that it could be fail-open is rejected here.
- Fail-open: `docs_search`, `issue_get`.

**Trade-offs:** it is boilerplate. It is also the only way the v1.0-era tools stay audited.

### Pattern 3: Collectors and timers are thin REST clients with a surface token

**What:** every out-of-process piece posts to `/events`, `/brief`, `/skills/propose` or `/issue` with `Bearer $SUBSTRATE_TOKEN`. The token is a `SUBSTRATE_TOKEN_<SURFACE>` value, written to a 0600 env file per unit, the pattern v1.2 used for swarm tokens. This covers the collectors (herdr, muse, cursor-stop), the projector, the miner, the dispatcher and the host.

**Trade-offs:** each unit needs its own surface token. New surfaces: `herdr`. The dispatcher should get its own surface rather than borrow `hermes`'s; that is a decision for REQUIREMENTS. D's `docs-scraper` is not needed.

### Pattern 4: Ledger anchoring uses ingest time over the existing per-session chain

**What:**
- Keep main's per-session `hash`/`prev` chain. Its hash input does not change.
- Stamp a server-side `ingested_at` at insert, outside the hash.
- Anchor each closed UTC ingest hour: the Merkle root over the event hashes ordered by (`ingested_at`, `id`), with a lag.
- Write the memo through D's `solana.ts` and store the row in `anchors`.

**Why:**
- `ts` is collector-supplied. The Grok collector replays old offsets, so an hour bucketed on `ts` keeps changing after it is anchored (`greptime.ts` :524 comment).
- Moving an event between hours by editing `ingested_at` changes both hours' roots, so `ingested_at` does not need to be hashed.

**Production state that forces the shape:**
- D's 06-05 cutover already added `agent_events.ingested_at` (`FIELD timestamp(3)`) to production Greptime.
- It also replaced `anchors` with a period-keyed table: 11 columns, 0 tags, 0 rows. Source: `acc30a8:.planning/phases/06-ledger/06-05-SUMMARY.md`.
- Main's `CREATE TABLE IF NOT EXISTS "anchors" … PRIMARY KEY ("root")` is a no-op there, but it would build a different schema on a fresh store. Make D's 11-column DDL canonical in main's `migrate()`.
- Fresh stores also need the `ingested_at` column, which `assertAppendOnly` (`APPEND_ONLY_VERBS`, :197) refuses to `ALTER`. Two options: allow one exact `ALTER TABLE "agent_events" ADD COLUMN "ingested_at"` statement in `migrate`, or declare the column in `CREATE`. The second is enough because `CREATE IF NOT EXISTS` is a no-op on production.

**Teachable anchors:** a teachable moment is an event (a memory `fact` write plus an event row), so the hourly root anchors it with everything else. No per-teachable transaction.

**Trade-off:** rows written between 2026-09-27 (the genesis event `evt_5d1b8c40…`) and the 2026-10-01 switch carry D's global `prev`. Main's per-session `verifyChain` will report those sessions as broken `[INFERENCE: no Greptime read was done]`. Port `verifyGlobalChain` for that window, or mark the window as a legacy segment in `verify`.

## Data Flow

### Key Data Flows

1. **Dispatch (C + B)**
   1. A human adds `dispatch:hermes` to an unstarted issue.
   2. The dispatcher tick (every 30 s) runs the `linear.py` candidate query.
   3. It resolves the issue with MCP `graph_find`, which returns (gid, nid) or `ambiguous`.
   4. It creates `worktree.py` `/var/lib/substrate/worktrees/<gid>`, with the 5 GiB floor.
   5. `launcher.py` starts `hermes chat` with an ids-only prompt and the session's surface token.
   6. Hermes calls `graph_claim`. Main grants the lease and emits the claim event, then `mirror.claim` runs: Linear goes to In Progress, `agent:hermes` is added, every `dispatch:*` label is removed (D `mirror.ts` :203-205), a one-line comment is posted, and the Notion `Agent` is set to hermes.
   7. `sessions.py` sees the landed claim through `graph_get`.
   8. Hermes heartbeats and finally calls `graph_complete {lease_id, dod}`. `DodGate` posts to `:8792/v1/complete-issue`. A pass sets Done, releases the lease and marks the Notion row Completed. A fail keeps the issue In Review and the claim held.
2. **Lane A (H)**
   1. `dispatch:claude-code` routes through `make_launch_fn` to `host.py` `POST 127.0.0.1:7411/tasks`.
   2. `tasks.ts` calls `graph_get`, then `graph_claim(surface=claude-code` or `rivet-agentos` — a decision; main already has `rivet-agentos` in `SURFACES`), then `/brief`, then seeds the VM.
   3. `vmFor(gid)` gives one agentOS actor per Graph ID, with `permissionPolicy: "ask"`.
   4. The host heartbeats the lease while the VM works, and the host functions commit, push and open the PR.
3. **Docs (D)**
   - `docs_search(query)`: a Dragonfly cache lookup (10 min). On a miss, RAGFlow `/api/v1/retrieval` with `RAGFLOW_DATASET_ID`. It returns `{chunk, heading_path, source_url, commit}`. Any error returns an empty result with a reason (fail-open).
   - `docs_ingest(path|repo)`: `redact()` plus the D-04 rules run, then the RAGFlow dataset upload and parse. It emits `docs.ingest` and is fail-closed for the caller. `POST /docs/ingest` is the GitHub Action route that `docs/data-planes.md` §What goes where describes.
4. **Brief recall (D):** `brief()` asks Hindsight for recall across banks within the remaining part of the 1.5 s budget. The result is cached in Dragonfly for 10 min, and the brief snapshot for 5 min. A Dragonfly outage counts as a bypass, reported in `/healthz` as hit/miss/bypass.
5. **Skills (F)**
   1. Omp, Grok or Hermes produce a skill. The Omp extension or `bridge.py` posts it to `POST /skills/propose`.
   2. `propose.ts` redacts, scans and locks; works in a shared clone; pushes `skill/<surface>/<name>-<ts>`; and runs `gh pr create`.
   3. A human merges.
   4. `skills-sync.timer` fast-forwards `/root/agent-skills` and projects symlinks into `~/.claude/skills`, `~/.grok/skills`, `~/.agents/skills` and `~/.config/muse/skills`.
   5. The `agent-skills` RAGFlow dataset is re-ingested (D).
6. **Anchor (E)**
   1. `substrate-ledger-anchor.timer` fires hourly.
   2. For each closed hour without an anchor: read the hour's hashes by ingest time, compute `merkleRootHex`, `formatMemo`, run `solana transfer … --with-memo … --output json`, and insert into `anchors` (with `slot`, `signer`, `cluster`).
   3. `substrate verify <gid>` recomputes each hour that holds the graph's events, compares with `anchors.root`, and fetches the transaction through `rpc.ts` `getTransaction` to match the memo.
7. **A2A Agent Cards (F2):**
   - `GET /.well-known/agent-card.json` serves the substrate's own card, the A2A discovery path `[UNVERIFIED against the current A2A spec version]`.
   - `GET /agents/<surface>/agent-card.json` builds `skills[]` from the library's `SKILL.md` frontmatter (`skills/frontmatter.ts`) plus teachable moments, which are governed memory `fact` entries tagged teachable.
   - It is read-only and fail-open.

### New surface area (summary)

| Kind | Added | Phase |
|---|---|---|
| MCP tools | `graph_find`, `skills_propose`, `docs_search`, `docs_ingest`, `desktop_run`, `issue_get` | C, F, D, D, G, H |
| Tool changes | `graph_complete` gains optional `dod`. `events_verify` (and `/verify`) gain an anchor and hour report. | B, E |
| REST (substrate-mcp) | `POST /skills/propose`, `POST /docs/ingest`, `POST /issue`, `GET /.well-known/agent-card.json`, `GET /agents/<surface>/agent-card.json` | F, D, H, F2 |
| REST (substrate-host :7411) | `GET /healthz`, `POST`/`GET /tasks`, `GET /tasks/<gid>/<nid>`, `POST …/terminate`, `POST …/kill` | H |
| CLI | `substrate skills propose`, `substrate docs search` / `docs ingest`, `verify` hour and anchor lines; `bun packages/ledger/src/anchor.ts --once`; `python3 -m substrate_dispatcher`; `python3 -m substrate_miner bridge --once` / `monitor` | F, D, E, C |
| Event kinds | `agent.detected`, `agent.status`, `agent.exited`, `brief.delivered`, `skill.propose`, `docs.ingest`, `desktop.action` | A, A, A, A, F, D, G |
| Surfaces | `herdr`, plus a dispatcher surface (decision) | A, C |
| Postgres | No new tables. `findNodesByLinear` uses existing `graph_nodes` columns. | C |
| Greptime | `agent_events.ingested_at` (already live), period-keyed `anchors` (already live, empty) made canonical in `migrate()` | E |
| systemd | `substrate-collector-herdr`, `-collector-muse`, `-dispatcher`, `-skills-sync` (+timer), `-skills-bridge` (+timer), `-host`, **new** `-ledger-anchor` (+hourly timer). Hermes hourly miner = Hermes cron skill. `substrate-desktop` = Docker `restart=unless-stopped`. | A, C, F, H, E, G |
| Env names | `HERMES_LINEAR_URL`, `SUBSTRATE_DOD_GATE_TIMEOUT_MS`, `SUBSTRATE_MUSE_REPOS`, `SUBSTRATE_PROPOSE_KEY_FILE`, `RAGFLOW_URL`/`RAGFLOW_API_KEY`/`RAGFLOW_DATASET_ID`, `HINDSIGHT_URL`/`HINDSIGHT_API_KEY`/`HINDSIGHT_BANK[_PREFIX]`, `DRAGONFLY_URL`, `SOLANA_RPC_URL`, `SOLANA_ANCHOR_KEYPAIR`, `SOLANA_ANCHOR_PUBKEY`, `SUBSTRATE_VERIFY_TIMEOUT_MS`, `SUBSTRATE_HOST_URL`, `SUBSTRATE_DISPATCH_DISABLED`, `SUBSTRATE_DISPATCH_MODEL`, plus the host set (`SUBSTRATE_HOST_ROUTE`, `RIVETKIT_STORAGE_PATH`, `SUBSTRATE_APPROVAL_*`, …) | all |

## Suggested Build Order (phases from 16; one reviewable PR each)

| # | Phase | Areas | Depends on | Ships | Why here |
|---|---|---|---|---|---|
| **16** | Production baseline and Phase 0 UAT | I | — | Re-run the 8 UAT scenarios against main (19 tools now, not 9), starting from the September results (5 pass; 4 partial; 5 and 6 issue). Close 4–6 with cross-repo changes: merge the claude-ultrathink `fetchBrief` PR #1, add a `graph_register` call to the `ultrathink-kickoff` skill, install the post-commit hook and the Cursor hook appends (`projector/src/cursor.ts`, `collectors/src/install-git-hook.ts`). The operator resolves the stray `substrate-mcp` holding :7410 so the unit runs main. Scenario 7 (outage) runs under approval. | Every later live proof needs production on main, and today it is not (see Pitfalls). No dependency on substrate code. The other-repo PRs are the long pole. |
| **17** | Lane B collectors | A | 16 | `types.ts` (`herdr`, `agent.*`, `brief.delivered`); `redact.ts` merge of the D-04 rules (keep `COUNTER_KEY`); `herdr*.ts`, `muse.ts`, `projector/muse.ts`, `cursor-stop.ts` + the `cursor.ts` hunk; the two collector units | Repairs units already running from code that is gone from main. The redact merge lands first because every later phase emits through it. About 1.5k LOC, mostly as-is. |
| **18** | Skills sync, propose and bridge | F (part 1) | 17 (redact) | Skill redaction engine; `skills/*`; `Substrate.proposeSkill`; `skills_propose` and `POST /skills/propose` on `McpCaller`; CLI `skills propose`; projector `skills.ts`/`skills-sync.ts`; Omp extension; `packages/miner`; the 4 units | Stops the two timers that fail every 5 minutes. Self-contained. |
| **19** | Claim mirror and DoD gate | B | 16 | `linear.ts`, `notion.ts`, `mirror.ts`, `dod-gate.ts`; config fields; mirror hooks in main's claim/release/complete; `graph_complete.dod`; a rewritten `service.test.ts` | The dispatcher's label swap is `mirror.claim` removing `dispatch:*`, so this phase must come first. |
| **20** | substrate-dispatcher | C | 19 | `findNodesByLinear` + `graph_find`; `packages/dispatcher` with bearer auth and a lease-aware prompt (heartbeat); the unit; the dispatcher surface token | Proof: label an issue `dispatch:hermes`; a session claims, Linear shows `agent:hermes`, Notion shows Agent hermes. |
| **21** | Docs plane | D | 17 (redact) | `planes/` (RAGFlow, Hindsight, Dragonfly); `docs_search` with citations and cache; redacting `docs_ingest` and `POST /docs/ingest`; brief recall; `/healthz` cache stats; CLI `docs` | Independent of 19–20; can run in parallel. Its bank-model decision comes from REQUIREMENTS. |
| **22** | Ledger anchor and verify | E | 16 | `packages/ledger` primitives + `index.ts`; `ingested_at` stamping; canonical `anchors` DDL; `anchor.ts` and the hourly timer; `verify` checking anchors through `rpc.ts`; the legacy D-segment verifier | Independent. The live devnet run needs operator approval and a funded `SOLANA_ANCHOR_PUBKEY`; funding was owner-skipped in 06-03. |
| **23** | A2A Agent Cards, teachable moments, Hermes hourly miner | F (part 2), E (teachable) | 18, 22 | `agent-card.ts` and its routes; teachable `fact` writes; the Hermes cron miner with `substrate-skill-miner/SKILL.md` | Needs the library (18) and anchoring (22) for "teachable anchors". Only stubs exist anywhere, so this is new design. |
| **24** | desktop_run | G | 17 | `desktop/*`, `desktop.action` kind, `runDesktop`, a fail-closed audit entry, `substrate-desktop.sh` | Small and independent. Could run in parallel from 18 onward. |
| **25** | Lane A host | H | 20 (dispatcher), 19 (`issue_get` needs `linear.ts`), 18 (skill library mounts) | `packages/host` with the client rewritten (token, `lease_id`, heartbeat); `host.py`; `issue_get` and `/issue`; the host unit; the sandbox image; the disk gate (≥10 GiB for images, 5 GiB worktree floor) | Heaviest and riskiest: pinned 0.2.21, approvals off, and 22 GB free on `/`. It goes last so the earlier proofs do not wait on it. |

**Critical path:** 16 → 19 → 20 → 25. 17 → 18 → 23 and 22 → 23 are side chains. 21 and 24 float.

## Scaling Considerations

| Scale | Adjustment |
|---|---|
| Today: one VPS, about 10 surfaces, 2 concurrent dispatched sessions | Single `substrate-mcp`. The dispatcher caps at 2 (`sessions.py`). The host runs one VM per open Graph ID. |
| More dispatch | Disk breaks before CPU: worktrees plus sandbox images on a 95%-full `/`. Prune worktrees on `graph_complete`. |
| More events | Anchoring is O(events per hour) once an hour, which is trivial. The verify read path (`hourEvents`) needs bounded windows. |

### Scaling Priorities

1. **First bottleneck:** free disk (22 GB). The worktree gate (5 GiB), the image gate (10 GiB) and the desktop gate (10 GiB) must all hold together.
2. **Second bottleneck:** Linear API rate limits from the dispatcher poll (30 s) plus the mirror writes. Tune the cadence and do not poll faster.

## Anti-Patterns

### Anti-Pattern 1: Cherry-picking U/D `service.ts` / `mcp.ts`

**What people do:** apply the September hunks.
**Why it's wrong:** they bring back session-based ownership and `setNodeState`, which main removed on purpose, with a tripwire test. Main's `releaseNode` then loses its fencing.
**Do this instead:** port the standalone modules whole, then write the call sites fresh against `lease_id`.

### Anti-Pattern 2: Taking D's `redact.ts` whole

**What people do:** overwrite main's file to get the D-04 rules.
**Why it's wrong:** main's `COUNTER_KEY` exemption is lost, `input_tokens` counts get redacted, and the cost and token metrics break.
**Do this instead:** merge the rules and the skill API into main's file.

### Anti-Pattern 3: A second global hash chain

**What people do:** port `chain.ts` to get anchoring.
**Why it's wrong:** it replaces main's `emit`/`EmitResult` and the per-session `lastHash` used by `handoff`, and it duplicates what `append_mode` plus `ensureAppendMode` already guarantee.
**Do this instead:** stamp `ingested_at` and anchor by hour (Pattern 4).

### Anti-Pattern 4: Anonymous internal clients

**What people do:** keep D's dispatcher, host and seed clients without `Authorization`.
**Why it's wrong:** main returns 401 as soon as any `SUBSTRATE_TOKEN_*` exists, so they fail silently in production.
**Do this instead:** give each unit its own surface token through its env file.

## Integration Points

### External Services

| Service | Integration | Notes |
|---|---|---|
| Linear GraphQL | `linear.ts` (server), `linear.py` (dispatcher) | Label changes are additive only (`addedLabelIds`/`removedLabelIds`), never `labelIds`. `LINEAR_API_KEY` is in `substrate.env`. |
| Notion API | `notion.ts` | Writes only 4 properties. Refuses pages outside `NOTION_TASK_GRAPH_DS`. |
| hermes-linear-connector | `dod-gate.ts` → `:8792/v1/complete-issue` | Listening on loopback. The 35 s timeout must exceed the connector's own 30 s. |
| RAGFlow / Hindsight / Dragonfly | `planes/*` over Tailscale forwarders | Fail-open, except `docs_ingest`. Production endpoint names are in `docs/railway-tailscale.md`. |
| Solana devnet | `ledger/solana.ts` (CLI argv) + `rpc.ts` (fetch) | Uses the absolute CLI path, because systemd's PATH lacks it. Keypair path from `SOLANA_ANCHOR_KEYPAIR`; `/etc/substrate/ledger-devnet.json` exists. |
| GitHub `swcstudiospace/agent-skills` | git + `gh` (stored credential, `HOME=/root`) | No token env var. |
| herdr 0.9.1 | Unix socket ND-JSON | Not the CLI. |
| agentOS (`@rivet-dev/agentos` 0.2.21) | in-process actor, engine on :6420 | No KVM needed (V8/WASM, per D `03-CONTEXT` D-01). |
| Docker | `substrate-desktop` webtop (6081), `substrate-sandbox:0.1` | `--pull never`. The keep label stops the daily prune from removing them. |

### Internal Boundaries

| Boundary | Communication | Notes |
|---|---|---|
| dispatcher ↔ substrate-mcp | MCP JSON-RPC over `/mcp`, with a bearer token | Reads only: `graph_find`, `graph_get`. |
| dispatched session ↔ substrate-mcp | MCP with the session's surface token | The session itself claims, heartbeats and completes; the dispatcher never claims for it. |
| host ↔ substrate-mcp | MCP plus `/brief` and `/issue` | The host holds the lease for its VM tasks and heartbeats it. |
| collectors, miner, projector ↔ substrate-mcp | REST, `Bearer $SUBSTRATE_TOKEN` | Fail-open on the client side. |
| substrate-mcp ↔ ledger | in-process import of `packages/ledger` from verify; the anchor job is a separate process | The anchor job reads Greptime directly with the operator store credentials. |

## Pitfalls observed on the host (2026-10-08, read-only)

- **Production is not on main.** `127.0.0.1:7410` is held by a stray `bun packages/mcp-server/src/index.ts`:
  - pid 3149064, started 2026-10-01 01:18, parent 1, cgroup `user.slice/session-240.scope`;
  - cwd is the operator checkout (`ss -ltnp`, `/proc/<pid>/cwd`).
  - `substrate-mcp.service` crash-loops on "Failed to start server. Is port 7410 in use?" with `NRestarts=119596` (journal 16:30:33).
  - Phase 16 has to resolve this, with operator approval.
- **Units installed from D run code that is absent from main:**
  - `substrate-collector-herdr` and `-muse` have been active since 2026-09-29 from modules already loaded in memory; their next restart fails.
  - `substrate-dispatcher` has `NRestarts=114888`.
  - `substrate-host` is inactive.
  - The operator checkout still holds untracked `packages/{dispatcher,miner,host/node_modules}` leftovers.
- **Production Greptime has D's schema:** `ingested_at` and the period-keyed `anchors`. It also has D-era global-chain rows (Pattern 4).

## Sources

- Git (worktree `/root/src/worktrees/agent-substrate-v13`):
  - `git diff --stat 31d236a substrate/ut-mughkkc0-73909228`
  - `git diff --stat 31d236a acc30a8`
  - `git diff substrate/ut-mughkkc0-73909228 acc30a8`
  - `git show --stat 21652a2`, `8db99f9`
  - `git merge-base --is-ancestor`, `git branch -a --contains 354310c be77187`
- Main source: `origin/main` `packages/mcp-server/src/{types,mcp,service,config,server,observe,index-store,lease,greptime,event,redact}.ts`, `packages/audit/src/policy.ts`, `packages/cli/src/index.ts`, `infra/vps/*`
- D planning: `acc30a8:.planning/phases/0{0..7}-*/…-VERIFICATION.md`, `06-ledger/06-05-SUMMARY.md`, `03-*`/`05-*` summaries (via the read-only worktree `/root/src/worktrees/agent-substrate-p15` at `6708cc3`; `git diff --stat 6708cc3 acc30a8 -- packages infra` is empty)
- Build plan: `local://build-plan-v02.md` §3.3, §3.4, §4.1, §4.4, §5.1, §7, §10; `local://build-plan-v03.md` §6, §8
- Repo docs: `docs/data-planes.md`, `.planning/PROJECT.md` (v1.3), `.planning/MILESTONES.md`, `.planning/milestones/v1.0-phases/00-brief/0-UAT.md`
- Host: `systemctl show/list-units/list-timers substrate-*`, `journalctl -u substrate-mcp|substrate-dispatcher`, `ss -ltnp`, `df -h /`, `herdr --version`, `which orca solana gh muse hermes`
- npm: `@rivet-dev/agentos` latest is 0.2.22 (scout `npm view`). Pinned at 0.2.21 in D `packages/host/package.json`.

---
*Architecture research for: Agent Substrate v1.3 build plan completion*
*Researched: 2026-10-08*
