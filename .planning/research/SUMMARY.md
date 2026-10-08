# Project Research Summary

**Project:** Agent Substrate — milestone v1.3 "Build plan completion" (tracking: SPE-8292)
**Domain:** Multi-agent substrate on one VPS: Bun/TS `substrate-mcp` + collectors, Python dispatcher/miner, Node 24 Lane A host, Railway data planes, Solana devnet anchor; Linear/Notion as control plane
**Researched:** 2026-10-08
**Confidence:** HIGH for port map, host and repo facts; MEDIUM for phase sizing and external API shapes; LOW where a source marks `[UNVERIFIED]`/`[INFERENCE]`

Source files: STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md (all in `.planning/research/`), `.planning/PROJECT.md` § Current Milestone v1.3. Every claim below names its file; nothing here goes beyond them. Recommendations written by this summary are labelled **[synthesis]**.

## Executive Summary

v1.3 is mostly a **port plus re-implementation** onto `main`, not greenfield. The September work was deployed from a feature branch and never merged; production now runs from a checkout of `main`, so several installed units point at code that is no longer on disk (PITFALLS P1; FEATURES P2; ARCHITECTURE "Pitfalls observed on the host"). The primary port source is branch **`docs/data-planes-tailscale` at `acc30a8`**, a strict superset of `substrate/ut-mughkkc0-73909228`, with 276 commits not on main (ARCHITECTURE scope correction; STACK headline). It was built on the **pre-lease claim model**, so leaf modules port as-is while every call into `Substrate` must be rewritten against main's v1.2 `lease_id` model (FEATURES Port sources; ARCHITECTURE Anti-Pattern 1; PITFALLS 2).

The recommended approach: first restore production parity and land the cross-cutting guards (unit files with crash-loop guards, policy enums and fail-open/closed table, store-lock extensions, test-isolation convention, disk gate) as small separate PRs (PITFALLS 1, 2, 3, 7, 8, 13, 14). Then port area by area along the critical path **baseline → claim mirror → dispatcher → Lane A**, with collectors → skills → A2A cards and ledger → A2A cards as side chains, and docs plane and `desktop_run` floating (ARCHITECTURE Suggested Build Order). Almost no new dependencies are needed: `fetch`, Bun built-ins (`RedisClient`, `CryptoHasher`), solana-cli argv, `git`/`gh` argv, `docker exec`, and Python `httpx`; only Lane A adds `@rivet-dev/agentos` under Node 24 (STACK headline).

Key risks: merging to main is a deploy (PITFALLS 1); cherry-picked core hunks reintroduce unfenced ownership (PITFALLS 2); fail-open/closed misassignment (PITFALLS 3); `lease_id` leaks and lapsed leases not mirrored (PITFALLS 4); publication paths (RAGFlow ingest, devnet memos) leaking content (PITFALLS 6); a 95%-full disk with no KVM (PITFALLS 11); and stubs recorded as complete (PITFALLS 15). Each phase below therefore ends in an observable proof, isolated first and live only with operator approval.

## Port sources and status

| Source | Status | Use | File |
|---|---|---|---|
| `acc30a8`, branch `docs/data-planes-tailscale` (merge-base `31d236a`; superset of `ut-mughkkc0`) | Real GSD runs of phases 01–06 with live proofs (01 passed 10/10; 02 proof run 5 approved; 03 83/91; 04 6/6; 05 22/25, docs half skipped; 06 46/48, anchoring skipped; 07 14/19; 08 0/7). ~35.7k insertions under `packages/` and `infra/`. No `lease.ts`. | **Primary** port source for A, B, C, E, F, G, H. Port leaf modules whole; rewrite call sites; never cherry-pick `service.ts`/`mcp.ts`/`index-store.ts`/`server.ts`/`types.ts` hunks; never port `.planning/` archives (they contain hostnames) | FEATURES Port sources; ARCHITECTURE Port Map; PITFALLS 2, 14; STACK |
| `substrate/ut-mughkkc0-73909228` | Ancestor of `acc30a8`; where both have a file, D's copy is newer | Don't port separately; its 0-UAT results (2026-09-24: 5 pass, 4 partial, 5 and 6 issues) feed the UAT phase | ARCHITECTURE scope correction, row pl-2 |
| `21652a2` (`claude/greptime-events-ledger-7j1so8`) | **Stubs**: RAGFlow retrieval without `dataset_ids` returning raw body; Hindsight recall inside the brief with 4 s timeout; hand-rolled RESP Dragonfly client never called; devnet memo carrying free text; `teachable.ts` stubs; `prev_event_hash: "TODO-chain"` | Not cherry-picked. **Exception:** the only source for the D-plane clients: keep `planesFromEnv`, `parseRedisUrl`, `hindsightRecall`, `ragflowSearch` as adapted helpers split into `planes/`; replace RESP with Bun `RedisClient`; drop `anchorMemoOnDevnet` and `teachable.ts` | FEATURES Port sources; ARCHITECTURE Port Map B; STACK headline, D |
| **Greenfield (on no branch)** | — | Hourly **anchor job** `anchor.ts` + timer + `verify` anchor wiring + a new ledger package entry point (`index.ts`, which no branch has); **A2A Agent Cards** (only stub types in `8db99f9`/`21652a2`, not spec-valid); **docs plane on main** (`docs_search` with citations, redacting/refusing `docs_ingest`, governed Hindsight retain/recall, Dragonfly cache); B-T3 mirroring of lease expiry/steal/force; durable dispatch record; lease-aware launcher prompt and host client | STACK E, F; ARCHITECTURE Component Responsibilities (A2A row), Port Map E; FEATURES D-T1, B-T3, E-T3, F-D1; PITFALLS 5 |

## Production hazards and the phase that addresses each

| Hazard | Evidence | Addressed in |
|---|---|---|
| Stray `bun` process running the mcp-server entry point (pid 3149064, from operator checkout, started 2026-10-01) holds `127.0.0.1:7410`; `substrate-mcp.service` crash-loops "Is port 7410 in use?", `NRestarts=119596` | ARCHITECTURE host pitfalls. **Conflict:** FEATURES P1 says `substrate-mcp` "runs main, active since 16:27:21 UTC"; ARCHITECTURE's journal line is 16:30:33. Re-check read-only at Phase 16 start | **Phase 16** (operator resolves, with approval; agents do not kill processes) |
| `substrate-collector-herdr`/`-muse` run from memory (since 2026-09-29), code absent on main; next restart fails | FEATURES P2; PITFALLS 1 | Guards **16**; code restored **20** |
| `substrate-dispatcher` points at `packages/dispatcher/src` holding only `__pycache__`; `NRestarts=114888`; idles on `SUBSTRATE_DISPATCH_DISABLED=1` | PITFALLS 1; ARCHITECTURE row 64 | Guards **16**; code **24**; kill switch stays on until C proof approved |
| `substrate-host` enabled but inactive, 40 restarts; `WorkingDirectory` is the operator checkout | PITFALLS 1; ARCHITECTURE Port Map H | Guards **16**; code **31–33** |
| `substrate-skills-sync`/`-bridge` timers fail every 5 min (`Module not found …skills-sync.ts`, `No module named substrate_miner.__main__`); Hermes cron `substrate-skill-miner` failure_streak 198; 4 proposals staged; Omp extension symlink dangling | PITFALLS 1; FEATURES P4 | **21** (route first) then **22** (timers, bridge, miner package) |
| Cursor `stop` hook runs missing `cursor-stop.ts` and swallows the failure | FEATURES P5 | **20** |
| Production env has **no** `SUBSTRATE_TOKEN_*`, operator tokens, handoff key or audit path → anonymous mode, unsigned handoffs, in-memory audit, no `force` | FEATURES P1, M11 | Rollout plan in **16**; operator rollout gate before first attributed live proof (**23**); every client must carry a token first (ARCHITECTURE Anti-Pattern 4) |
| Live producers send vocabulary main rejects (`herdr`, `agent.*`, `brief.delivered`, `hermes-eng-board`); fail-open clients swallow 4xx | FEATURES P3; PITFALLS 2 | **17** |
| Devnet key `/etc/substrate/ledger-devnet.json` at **0 SOL** (2026-10-08); September airdrops refused | PITFALLS 9; FEATURES P12 | Operator funding gate in **28** |
| Production Greptime already has D's `ingested_at` and 11-column period-keyed `anchors` (0 rows); D-era global-chain rows (2026-09-27 → 10-01) may fail main's per-session verify `[INFERENCE]` | ARCHITECTURE Pattern 4; FEATURES P-notes | **27/28** |
| Disk 95% (22 GB free), journal 1.0 GB, no `/dev/kvm`, ~75% CPU steal | PITFALLS 11; STACK H | Gate helper **18**; **30**, **31** |
| Rivet engine port 6420 already held by another project's container | STACK H | **31** |
| Railway forwarders not on tailnet; `DRAGONFLY_URL` plaintext `redis://` | FEATURES P7 | **26** |
| `/root/agent-skills` dirty (untracked `__pycache__`) → skills-sync would refuse every tick (288 warnings/day) | PITFALLS 12 | **22** |
| grok-hermes-connector v0.4 live but unpushed; 5 cross-repo repos have no remote | FEATURES P8, Cross-repo | **19** (cross-repo draft PRs listed separately) |

## Key Findings

### Recommended Stack (STACK.md)

No new npm packages for A, B, D, E, F, G. Keep pins in a port milestone (no MCP SDK, TypeScript 7, dockerode 5, sandbox-agent 0.5 bumps). Port files, never whole `package.json` manifests (D's manifests drop main's workspaces `observability`, `audit`, `evidence`).

- **Bun 1.4.0** — mcp-server, CLI, collectors, projector, ledger; built-in `RedisClient` replaces the RESP parser that breaks on `\r\n` in bulk values.
- **Node 24.18** — `packages/host` only (`@rivet-dev/agentos` 0.2.21 pinned, 0.2.22 latest; native `better-sqlite3`; own `package-lock.json`; declare `@agentos-software/claude-code@0.2.7` explicitly).
- **solana-cli 4.2.2 (absolute path) + `fetch` JSON-RPC** — key never enters process memory (D-06); `@solana/kit` only if anchoring moves off-host.
- **RFC 6962 Merkle** from `acc30a8:packages/ledger/src/merkle.ts` — domain-separated, odd leaf promoted.
- **Python 3.12 system + httpx 0.28.1 + pytest 9.1.1** — no venv; add a root `test:py` script (main has no Python test entry point).
- **RAGFlow HTTP `/api/v1/retrieval`** behind `docs_search`, not RAGFlow MCP (v0.26.1 Python MCP broken, #16369).
- **A2A v1.0 static Agent Card JSON** at `/.well-known/agent-card.json`; no SDK. Current `makeAgentCard` output is not spec-valid.
- **Webtop + `docker exec` xdotool/xwd** for `desktop_run`; not cua (7.89 GB image, no KVM/runsc).

### Expected Features (FEATURES.md)

**Must have (P1, all areas A–I in scope; shrinking needs explicit user approval):**
- Cross-cutting: production identity (P1), event-vocabulary decision (P3), restoring live units onto main (P2, P4, P5).
- A-T1…T5 collectors; B-T1…T7 mirror + DoD gate + `graph_find`/`issue_get`; C-T1…T8 + C-D1 (label → brief ≤ 60 s; September missed by 5 s); D-T1…T6; E-T1…T6; F-T1…T6 + F-D1/F-D2 (Agent Cards, teachables — PROJECT.md target); G-T1…T4 + G-D2 (pixel-true screenshots); H-T1…T7; I-T1…T3.

**Should have (v1.3.x, after validation):** A-D1, B-D1, B-D3, C-D2, C-D4, D-D1, D-D3, D-D4, E-D1, E-D2, F-D3, F-D4, H-D1, H-D3, I-D1.

**Defer (v2+):** A-D2 herdr-hosted dispatch, A-D3 Orca tee, B-D2 Linear Agent Sessions, C-D3 extra launchers, D-D2 ingest on merge, G-D1 cua, H-D2 Codex/OpenCode/Pi VMs.

**Anti-features to hold:** substrate sending Done itself; `labelIds` overwrite; rolling back a lease on tracker failure; dispatcher claiming for the agent; issue text in prompts; RAGFlow MCP as backend; Hindsight as store of record; Dragonfly as queue/lock; recall inside the synchronous brief; event contents on chain; porting `chain.ts`; auto-merging skills; stopping production for UAT scenario 7; proof rows in the production ledger.

### Architecture Approach (ARCHITECTURE.md)

All side effects hang off main's lease verdicts (`claimNode`/`releaseNode`/`completeNode`); the mirror never decides ownership; DoD gate runs before the lease-fenced release and on failure keeps the lease (Pattern 1). Every new tool needs four registrations: `mcp.ts`, `observe.ts KNOWN_TOOLS`, `audit/src/policy.ts` fail-open/closed set, and `KNOWN_ROUTES`/`auditedRest` for REST twins (Pattern 2). Every out-of-process piece is a thin REST client with its own surface token in a 0600 env file (Pattern 3). Anchoring stamps server-side `ingested_at` outside the hash and anchors closed UTC ingest hours over the existing per-session chain (Pattern 4). Keep D's file layout so installed units are repaired without unit changes.

**Major components:** `substrate-mcp` (auth, tools, leases, ledger, mirror) · mirror (`mirror/linear/notion/dod-gate.ts`) · `substrate-dispatcher` (Python) · collectors · projector (Muse, skills sync, Omp ext) · miner (Python) · `planes/` (new split) · ledger (+ new `anchor.ts`) · desktop · `substrate-host` (Node) · A2A cards (new).

### Critical Pitfalls (PITFALLS.md)

1. **Merge = deploy; orphaned units** — land unit files with `ConditionPathExists` + `StartLimitBurst`; each PR states its live effect; server route before client (Pitfall 1).
2. **Porting by merge** — reference implementations only; policy enum changes in a dedicated PR (Pitfall 2).
3. **Fail-open/closed misassignment** — per-tool table in `docs/mcp-audit.md` + `policy.ts` tests; DoD gate fail-closed; mirror fail-open after the claim (Pitfall 3).
4. **Lease authority vs mirror/dispatcher** — mirror off lease events (never `renewed`), no `lease_id` in any payload, agent claims with its own token (Pitfall 4).
5. **Publication paths** — `docs_ingest` refuses on findings; memos only `substrate:v1:<hour>:<root>:<count>`; one shared redactor (Pitfall 6). Plus double dispatch (5), store-lock bypass (8), devnet funding/verify semantics (9), RAGFlow churn (10), disk (11), test isolation (13), PR size ≤ ~1,500 added lines (14), stubs as complete (15), brief cache hiding claims (16), `desktop_run` reach (17).

## Implications for Roadmap

**Reconciliation [synthesis].** ARCHITECTURE's order (16 baseline+UAT → 17 collectors+redact → 18 skills → 19 mirror+DoD → 20 dispatcher → 21 docs → 22 anchor → 23 A2A/teachables/miner → 24 desktop_run → 25 Lane A) is kept as the dependency spine. PITFALLS' Phase 16 foundation items (parity, enums/policy, store lock, redaction library, disk gate, test convention, env names, cross-repo decisions) are too many concerns for one PR (PITFALLS 14), so they become Phases 16–18 ahead of UAT. Areas whose source exceeds ~1,500 changed lines are split (skills, docs, ledger, Lane A) using the file sizes in ARCHITECTURE/FEATURES. Size figures are estimates from those LOC counts **[INFERENCE]**. Result: 18 phases, 16–33.

| New | ARCH # | Area | Depends on |
|---|---|---|---|
| 16 Production parity and unit guards | 16 (part) | PITFALLS 1 | — |
| 17 Policy: vocabulary and fail-open/closed table | 16 (part) | PITFALLS 2, 3 | 16 |
| 18 Guard rails: store lock, redaction library, disk gate, test isolation, env names | 16 (part) | PITFALLS 6, 7, 8, 11, 13 | 16 |
| 19 Phase 0 UAT and isolated harness | 16 (part) | I | 16–18 |
| 20 Lane B collectors | 17 | A | 17, 18 |
| 21 `skills_propose` server side | 18 (part) | F | 18 |
| 22 Skills sync, bridge, miner package, timers | 18 (part) | F | 21 |
| 23 Claim mirror and DoD gate | 19 | B | 17 |
| 24 substrate-dispatcher | 20 | C | 23 |
| 25 Docs search and ingest (RAGFlow) | 21 (part) | D | 18 |
| 26 Hindsight recall/retain and Dragonfly cache | 21 (part) | D | 25 |
| 27 Ledger primitives, ingest order, anchors DDL | 22 (part) | E | 18 |
| 28 Hourly anchor job and verify | 22 (part) | E | 27 |
| 29 A2A Agent Cards, teachables, Hermes hourly miner | 23 | F2, E | 22, 28 |
| 30 `desktop_run` | 24 | G | 17 |
| 31 Lane A go/no-go spike and packaging | 25 (part) | H | 24 |
| 32 Lane A host core (lease-aware client) | 25 (part) | H | 31, 23 |
| 33 Lane A dispatch route, `issue_get`, approvals | 25 (part) | H | 32, 24, 22 |

**Critical path:** 16 → 17 → 23 → 24 → 31 → 32 → 33. Side chains: 18 → 21 → 22 → 29 and 18 → 27 → 28 → 29. Floating after foundations: 25–26, 30 (ARCHITECTURE critical path, renumbered).

### Phase 16: Production parity and unit guards
**Rationale:** every later live proof needs production on main; merge is deploy (ARCHITECTURE 16; PITFALLS 1).
**Delivers:** every installed `substrate-*` unit file in `infra/vps/` matching `systemctl cat`; `ConditionPathExists` on entry points; `StartLimitBurst`/`IntervalSec` (keep `substrate-mcp`'s `StartLimitIntervalSec=0`); PR "live effect" line; recorded operator steps: resolve stray bun on :7410, keep `SUBSTRATE_DISPATCH_DISABLED=1`, token rollout plan. Re-derive `command -v bun` for unit paths (STACK A).
**Avoids:** Pitfall 1. **Size:** small (unit files + docs).
**Proof:** no `failed` substrate units; every enabled `ExecStart` path either in `git ls-files` or guarded. **Live:** yes, read-only `systemctl`/`ss` after operator action.

### Phase 17: Policy — event vocabulary and per-tool fail-open/closed table
**Rationale:** collectors, skills, docs and desktop emit kinds main rejects; adding kinds is a chain-affecting, fail-closed policy change needing its own PR (PITFALLS 2, 3; FEATURES P3).
**Delivers:** vocabulary per decision D1 in `types.ts`; `docs/mcp-audit.md` table (fail-open: `docs_search`, `issue_get`, recall, brief, cache, collector emits; fail-closed: `graph_find`, `docs_ingest`, `skills_propose`, `desktop_run`, anchor write, `graph_*`) encoded in `policy.ts` as tools land; refused-emit counting convention.
**Proof:** `policy.test.ts`, collector smoke `stored: true` per kind. **Live:** no (isolated).

### Phase 18: Guard rails
**Rationale:** new planes reach around the store lock; tests must never touch production (PITFALLS 7, 8, 13).
**Delivers:** store-lock rules (plane credential names with literal values, 64-byte keypair arrays, `-----BEGIN`, no RAGFlow/Hindsight MCP in agent configs, `RAGFLOW_*`/`HINDSIGHT_*`/`DRAGONFLY_*` read only in `mcp-server/src`, `SOLANA_*` only in the anchor module, Hindsight retain only via memory-write); production-path scan for tests and `SUBSTRATE_TEST_<PLANE>_*` convention; shared disk-gate helper (5 GiB worktree, 10 GiB image); redaction merge into main's `redact.ts` — D-04 rules + `redactSkillContent`/`scanSkillFiles`, base58 and hostname rules, **keep `COUNTER_KEY`** (ARCHITECTURE Anti-Pattern 2); `.env.example` reconciled to `SOLANA_ANCHOR_KEYPAIR` and the chosen Hindsight bank variable (STACK E; PITFALLS 9).
**Note:** ARCHITECTURE puts the redact merge in its collectors phase; PITFALLS puts the shared library in foundation. Placed here so 20, 21, 25 all consume it [synthesis]. If it exceeds ~1,500 lines, split redaction into its own PR.
**Proof:** `bun test store-lock`, `redact.test.ts` (incl. `input_tokens` not redacted). **Live:** no.

### Phase 19: Phase 0 UAT and isolated harness (area I)
**Rationale:** 8 scenarios pending since v1.0; the harness serves every later rehearsal (FEATURES I-T1…T3; PITFALLS 15).
**Delivers:** scratch substrate-mcp + scratch Postgres/Greptime harness (I-T2); updated expectations (19 tools, `## Agent Substrate brief` header, `fetchBrief` at `src/claude/hook.ts:412`); re-run all 8; separate cross-repo draft PRs: claude-ultrathink `fetchBrief`/`graph_register` + `substrate` MCP entry, post-commit hook, Cursor hooks (ARCHITECTURE 16; FEATURES Cross-repo).
**Proof:** `0-UAT.md` 8/8 with fresh evidence. **Live:** scenarios 2 (real data counts), 3 (Notion read), 5 (kickoff writes) need production; 1, 4, 6, 7, 8 isolated; scenario 7 per decision D21.

### Phase 20: Lane B collectors (area A)
**Rationale:** repairs units running from memory (ARCHITECTURE 17: ~1.5k LOC, mostly as-is).
**Delivers:** `herdr.ts`, `herdr-map.ts`, `collectors/muse.ts`, `projector/muse.ts`, `cursor-stop.ts` + `cursor.ts` hunk; the two collector units (trim dead `SUBSTRATE_COLLECTOR_STATE`; `SUBSTRATE_MUSE_REPOS`); repo as slug (A-T2/A-T3); atomic `BRIEF.md` write; stable `redact` import path for the Muse hook; per-unit surface token.
**Avoids:** Pitfalls 1, 2, 12 (pin herdr protocol 22, Muse 1.4.x contract fixtures).
**Proof:** herdr status transition and Muse `tool.call` in `events_query(repo=R)` ≤ 10 s; `BRIEF.md` refreshed ≤ 5 min; refused emits 0 (FEATURES proof A). **Live:** local herdr/Muse only; rehearsable against scratch.

### Phase 21: `skills_propose` server side (area F, part 1)
**Rationale:** route must exist before the bridge POSTs to it (PITFALLS 1); skill-autonomy already posts here (FEATURES F-T1).
**Delivers:** `skills/{propose,propose-auth,frontmatter}.ts` (640+38+20 LOC + tests) on main's `McpCaller`; `Substrate.proposeSkill`; MCP tool + `POST /skills/propose`; CLI `skills propose`; remove hard-coded `Refs SPE-2734`; four registrations.
**Proof:** a draft PR on a throwaway repo via injected runner; refusal on planted secret. **Live:** a real PR on `swcstudiospace/agent-skills` needs `gh` auth and owner merge.

### Phase 22: Skills sync, bridge, miner package, timers (area F, part 2)
**Rationale:** turns the two failing timers and the Hermes cron green (FEATURES P4).
**Delivers:** `projector/src/{skills,skills-sync}.ts`, `omp/substrate-skills.ts`; `packages/miner` (`bridge.py` 598, `monitor.py`, tests); the 4 units; root `test:py`; dirty-tree resolution (decision D18).
**Proof:** timers green on main's code, no `refuse-dirty` every tick, 4 staged proposals drained. **Live:** yes (timers run on production after merge).

### Phase 23: Claim mirror and DoD gate (area B)
**Rationale:** the dispatcher's label swap is `mirror.claim` (ARCHITECTURE 19).
**Delivers:** `linear.ts`, `notion.ts`, `mirror.ts`, `dod-gate.ts` as-is; `hermesLinearUrl`/`dodGateTimeoutMs` config; mirror hooks off `granted`/`reclaimed`/`released`/`stolen`/`forced`/expiry, never `renewed` (B-T3 is new); `graph_complete` optional `dod`; rewritten `service.test.ts`; no-`lease_id`-leak test; swarm-surface rule (D7).
**Size risk:** ~1.4k LOC ported incl. tests plus the service rewrite — at the limit; split Notion into its own PR if over [INFERENCE].
**Proof:** FEATURES proof B (started state + `agent:S` + one comment without `lease_id`; Notion Agent; release reverts; complete without DoD stays In Review; with DoD → Done). **Live:** Linear, Notion, hermes-linear-connector :8792, and production surface tokens (operator gate).

### Phase 24: substrate-dispatcher (area C)
**Rationale:** depends on 23 (ARCHITECTURE 20).
**Delivers:** `findNodesByLinear` + `graph_find`; `packages/dispatcher` with bearer auth, lease-aware prompt with heartbeat, agent's own token, durable dispatch record (Timescale unique key), worktree per (graph, node) or serialized nodes, refuse multi-`dispatch:*`, paginated poll, rate-limit backoff, echo tagging (PITFALLS 5); unit with token line; `SUBSTRATE_HERMES_BIN` fixed.
**Size risk:** the Python package plus 7 test files is likely > 1,500 lines; split into (a) `graph_find` + `findNodesByLinear`, (b) package + unit [INFERENCE].
**Proof:** label `dispatch:hermes` → launch ≤ 30 s, claim under Hermes token, `agent:hermes`, Notion Agent hermes, brief shows it ≤ 60 s; restart mid-launch does not re-dispatch. **Live:** Linear, Notion, Hermes quota, a bounded kill-switch-off window; `--once --dry-run` rehearsal isolated.

### Phase 25: Docs search and ingest — RAGFlow (area D, part 1)
**Rationale:** independent of 23–24 (ARCHITECTURE 21).
**Delivers:** `planes/ragflow.ts`; `docs_search` with explicit `dataset_ids`, `{chunk, heading_path, source_url, commit}`, `{chunks: [], degraded}` on error; `docs_ingest` + `POST /docs/ingest` that scans and **refuses** on findings, sets metadata, polls parse status; datasets resolved by name/alias with pinned embedding model; ingest triggered from the VPS (PITFALLS 10). Query the deployed RAGFlow version first.
**Proof:** headless session cites a URL that `docs_search` returned; planted-secret ingest refused; version-swap test against a fake. **Live:** RAGFlow.

### Phase 26: Hindsight and Dragonfly (area D, part 2)
**Delivers:** `planes/hindsight.ts` (recall outside the 1.5 s brief or as cached async section; retain only after `accepted` via the gate); `planes/dragonfly.ts` on Bun `RedisClient`; `/healthz` hit/miss/bypass; claims section never served from cache (PITFALLS 16); private hop/TLS before enabling (D-T6).
**Proof:** cross-surface recall with source; second brief a cache hit; Dragonfly down → bypass; claim visible in another surface's brief ≤ 60 s. **Live:** Hindsight, Dragonfly (after private hop).

### Phase 27: Ledger primitives, ingest order, anchors DDL (area E, part 1)
**Delivers:** `packages/ledger/src/{merkle,memo,period,rpc,solana}.ts` (411 LOC) + tests + new `index.ts`; `ingested_at` stamping declared in `CREATE`; D's 11-column `anchors` DDL canonical in `migrate()`; typed `greptime.ts` period reads (`hourEvents`, `lastEventBefore`); `verifyGlobalChain` or legacy-segment marking for the 2026-09-27 → 10-01 window. Drop `chain.ts`.
**Proof:** unit tests; deterministic-root and late-event tests. **Live:** no.

### Phase 28: Hourly anchor job and verify (area E, part 2)
**Delivers:** `anchor.ts` + `substrate-ledger-anchor.{service,timer}` (hourly, `Persistent=true`, lag, idempotent adopt-existing-memo); store-lock-compliant placement (D13); one warning per hour when unfunded, never airdrop loops; `substrate verify` / `POST /verify` reporting anchored / pending / late / mismatch / cluster-reset / unverified.
**Proof:** tamper on scratch Greptime → verify exits 1 naming the hour; untouched graph all anchored; memo matches `MEMO_RE`; tests on `solana-test-validator`. **Live:** funded devnet key (**operator gate**) + one approved devnet anchor.

### Phase 29: A2A Agent Cards, teachables, Hermes hourly miner (area F2/E)
**Rationale:** needs the library (22) and anchoring (28); only stubs exist, so this is new design (ARCHITECTURE 23).
**Delivers:** `agent-card.ts`; `GET /.well-known/agent-card.json` and `/agents/<surface>/agent-card.json` (A2A v1.0 fields; teachable → `AgentSkill` mapping per STACK F); teachables as governed `fact` entries with a tag; teachables anchored via the hourly root (or as a hash), never text; Hermes cron `substrate-skill-miner/SKILL.md`.
**Proof:** card validates against v1.0 required fields; teachable appears as skill; F proof (Cursor-mined skill merged → appears in Claude Code and Grok Build ≤ 5 min, no config mtime change). **Live:** GitHub, owner merge, Hermes quota, a Cursor session.

### Phase 30: `desktop_run` (area G)
**Delivers:** `desktop/{actions,driver}.ts` (111+359 + tests); event kind per D1; `runDesktop`; fail-closed audit; operator-listed surfaces; screenshot hashes not bytes; typed text as length+sha256; fix stale xwd pixels (G-D2); `substrate-desktop.sh` with 10 GiB gate, `--pull never`.
**Proof:** PNG pixels show the typed marker; one event per action; no image bytes in events; unlisted surface refused. **Live:** Docker only (local container).

### Phase 31: Lane A go/no-go spike and packaging (area H, part 1)
**Rationale:** heaviest and riskiest; goes last (ARCHITECTURE 25; PITFALLS 11).
**Delivers:** spike record: no-KVM confirmation, per-VM disk budget, rivet engine :6420 decision (D16); `packages/host/package.json` + lock (npm, outside Bun install), explicit `@agentos-software/claude-code`; `infra/sandbox/Dockerfile`; host unit with token line and non-checkout path.
**Proof:** spike result recorded; disk gate unit tests. **Live:** host read-only checks; owner install approval.

### Phase 32: Lane A host core (area H, part 2)
**Delivers:** host sources (~4.3k LOC total, so this may need a further split) with `substrate.ts` rewritten (token, `lease_id` persisted 0600, heartbeat per task), `seed.ts` MCP entry with headers, `main.ts` without hard-coded checkout; `sync.ts` Linear/Notion folded into B-T1 client.
**Proof:** VM survives `systemctl restart substrate-host` on an isolated graph. **Live:** Docker, ≥ 10 GB free.

### Phase 33: Lane A dispatch route, `issue_get`, approvals (area H, part 3)
**Delivers:** `host.py` + `test_host.py`; `issue_get` + `POST /issue` (untrusted-text cap/banner); Telegram approvals (`SUBSTRATE_APPROVAL_*`).
**Proof:** `dispatch:claude-code` → VM → claim under claude-code token → restart survives → PR → gated Done. **Live:** Linear, Notion, GitHub, model route, approvals channel, disk.

### Phase Ordering Rationale

- Foundations first because every later live proof needs production on main and closed policy sets (PITFALLS 1–3; ARCHITECTURE 16).
- Mirror before dispatcher before Lane A because the label swap lives in the mirror and Lane A is a dispatcher route (ARCHITECTURE critical path; FEATURES Dependency Notes).
- Server routes before clients (21 before 22) so timers do not POST to 404s (PITFALLS 1).
- Splits keep each PR ≤ ~1,500 added lines and one concern (PITFALLS 14).

### Research Flags

Need `--research-phase` during planning:
- **19:** cross-repo dependencies (claude-ultrathink v1.4 unmerged; kickoff dry-run unknown).
- **23:** mirror on lease events is new (B-T3); Notion rate limit `[UNVERIFIED]`.
- **24:** poller rate budget and echo behaviour `[UNVERIFIED]`; durable dispatch schema.
- **25/26:** deployed RAGFlow/Hindsight versions, parse endpoint and `meta_fields` `[UNVERIFIED]`; bank model; Bun `RedisClient` API on 1.4 `[UNVERIFIED]`.
- **28:** memo program ID written by solana-cli 4.2.2 `[UNVERIFIED]`; devnet history retention.
- **29:** A2A v1.0 extension shape `[UNVERIFIED]`; teachables vs gate.
- **31:** agentos without KVM `[UNVERIFIED]`; Bun workspace vs host lock.

Standard patterns (skip research): **16, 17, 18, 20, 21, 22, 27, 30** — ports of tested leaf modules or repo-local guard work.

## Decisions needed (consolidated)

| # | Decision | Recommended default | Changes user-visible behaviour? | Sources |
|---|---|---|---|---|
| D1 | Event vocabulary: extend `EVENT_KINDS`/`SURFACES` (`herdr`, `agent.*`, `brief.delivered`, `skill.propose`, `docs.ingest`, `desktop.action`) or map onto existing kinds | **Sources conflict.** FEATURES recommends mapping (v1.1 precedent: `session.start`/`session.end`/`note` with `runtime: herdr`); ARCHITECTURE adds kinds; PITFALLS requires a dedicated reviewed PR either way. Default [synthesis]: map onto existing kinds, decided in Phase 17 | Yes — kinds seen in `events_query`, brief, evidence | FEATURES Open 1, A anti-features; ARCHITECTURE row 97; PITFALLS 2 |
| D2 | Production identity rollout (surface tokens, operator tokens, handoff key, audit path) | Operator rollout after every internal client carries its token (20, 22, 24) and before B's attributed live proof | Yes — anonymous calls start returning 401; handoffs signed | FEATURES Open 2, P1; ARCHITECTURE Anti-Pattern 4 |
| D3 | Stray bun on :7410 | Operator stops it in an approved window so `substrate-mcp.service` owns the port | Yes — brief restart of production MCP | ARCHITECTURE host pitfalls |
| D4 | Orphaned units: port vs disable | Port and keep enabled behind `ConditionPathExists`; dispatcher kill switch on until C proof | No (restores intended behaviour) | PITFALLS 1 |
| D5 | Dispatcher MCP identity | Its own surface, not `hermes` | No | ARCHITECTURE Pattern 3 |
| D6 | Lane A claim surface: `claude-code` vs `rivet-agentos` | `claude-code` | Yes — Linear `agent:` label | ARCHITECTURE flow 2; FEATURES H-T2 |
| D7 | Do `swarm-*` claims mirror to Linear | No state/label changes; note only; pinned in a test | Yes — Linear board | PITFALLS 4 |
| D8 | Hindsight banks: `HINDSIGHT_BANK` (live env, 21652a2) vs `HINDSIGHT_BANK_PREFIX` per-surface `sub-<surface>` (main, docs) | Per-surface prefix; operator edits `substrate.env` | No | STACK D; ARCHITECTURE B; PITFALLS 9 |
| D9 | Who owns plane calls (substrate-only vs desk gateway direct); `memory_search` merging Hindsight | Substrate-only; retain as async forward after `accepted`; no plane MCP in agent configs | Yes — Grok Bot gateway route | FEATURES Open 4, D anti-features; PITFALLS 8 |
| D10 | Cache TTLs and claim freshness | `data-planes.md` TTLs (brief 5 min, search/recall 10 min); claims section composed fresh | No | FEATURES Open 4; PITFALLS 16 |
| D11 | Dragonfly transport | Bypass until private hop/TLS exists; RAGFlow/Hindsight may start on public HTTPS with bearer key | No | FEATURES D-T6, P7; STACK D |
| D12 | `docs/data-planes.md` (forwarders, prefix) vs live env | Fix the doc to the chosen state; remove forwarder machine names (desk rule) | No | STACK D; PITFALLS Security |
| D13 | Anchor job placement: separate process reading Greptime directly vs through substrate-mcp | **Sources conflict.** ARCHITECTURE: separate process with operator creds; FEATURES E-T6/PITFALLS 8: typed methods in mcp-server. Default: store-lock compliant (timer → loopback route or typed methods) | No | ARCHITECTURE Internal Boundaries; FEATURES E-T6; PITFALLS 8 |
| D14 | Hour membership and leaf order | ARCHITECTURE Pattern 4: `ingested_at` (already live) ordered by (`ingested_at`, `id`) with lag; PITFALLS alternative: sort by hash. Default ARCHITECTURE's; record anchored ids/digest | No | ARCHITECTURE Pattern 4; PITFALLS 9; FEATURES Open 3 |
| D15 | Devnet funding route and Solana env name | Operator funds once (GitHub faucet or transfer); `SOLANA_ANCHOR_KEYPAIR` canonical | No | PITFALLS 9; STACK E |
| D16 | Rivet engine :6420: share the running engine or move one | Spike decides in Phase 31 | No | STACK H |
| D17 | Teachables storage and anchoring | Governed `fact` with a teachable tag; anchored inside the hourly root (hash only, never text) | Yes — Agent Cards list teachables | FEATURES Open 5, F-D2; ARCHITECTURE Pattern 4; PITFALLS 6 |
| D18 | `agent-skills` dirty tree | `.gitignore` PR in agent-skills (alternative: skills-sync ignores `__pycache__/`) | No | PITFALLS 12 |
| D19 | Dispatched agents run as root with `substrate.env` readable | Dedicated user where supported; else record accepted risk | No | PITFALLS 7; FEATURES C-T4 |
| D20 | Orca vs herdr as Lane B runtime | herdr (owner correction 2026-09-24); record as Key Decision | No | PITFALLS 12; FEATURES A-T1 |
| D21 | UAT scenario 7 | **Sources differ.** FEATURES: dead-port `fetchBrief` + scratch instance, never stop production; ARCHITECTURE/PITFALLS: approved outage window. Default: scratch | No (default); Yes if production is stopped | FEATURES I anti-features; PITFALLS 15 |
| D22 | Linear capacity (Free plan 250 active issues) and rate budget shared with the 2 s poller | Archive to free slots before B/C/H proofs; measure poller rate; back off on headers | No | FEATURES Open 7, P11; PITFALLS 5 |
| D23 | Lane A packaging and pins | Keep 0.2.21; host out of Bun install; owner re-approves install | No | FEATURES Open 6; STACK H |
| D24 | `desktop_run` callers | Fail-closed; operator-listed surfaces only; never `swarm-*` | Yes — who may call it | PITFALLS 17; ARCHITECTURE Pattern 2 |
| D25 | Disk recovery (e.g. unused 5.91 GB `hindsight-api:0.9.1` image) | Operator decision; agents never prune | No | STACK D; PITFALLS 11 |

## Confidence Assessment

| Area | Confidence | Notes |
|---|---|---|
| Stack | HIGH | Versions from host commands and git objects; external API shapes MEDIUM |
| Features | HIGH / MEDIUM | Existence checked in git and on host; port effort and design choices MEDIUM |
| Architecture | HIGH / MEDIUM | Port map verified against git objects; phase sizing MEDIUM |
| Pitfalls | HIGH / MEDIUM | Repo/host facts cited; Linear/Solana/RAGFlow limits from public docs |

**Overall confidence:** HIGH for what to port and in what order; MEDIUM for PR sizing.

### Gaps to Address

- **:7410 state conflict** (FEATURES P1 vs ARCHITECTURE): re-check read-only at Phase 16 start.
- **Live `anchors` shape** `[UNVERIFIED]` in FEATURES, asserted from D's 06-05 SUMMARY in ARCHITECTURE: confirm with a read-only `DESCRIBE` in 27.
- **Mixed-chain verify breaks** `[INFERENCE]`: run `events_verify` read-only on a D-era graph in 19.
- Deployed RAGFlow / Hindsight versions; RAGFlow `dataset_ids` requirement and parse path; Bun `RedisClient` behaviour on 1.4.
- Muse plugin CLI contract `[UNVERIFIED]`; Muse version (1.4.3 STACK vs 1.4.4 PITFALLS).
- Whether hermes-linear-poller starts work on state changes (second dispatch path) `[UNVERIFIED]`.
- agentos without KVM, and Bun workspace interaction with the host lock `[UNVERIFIED]`.
- Which hermes binary the dispatcher should run (`/usr/local/bin` default vs `/root/.local/bin`).

## Sources

### Primary (HIGH confidence)
- Git objects in `/root/src/worktrees/agent-substrate-v13`: `acc30a8`, `substrate/ut-mughkkc0-73909228`, `21652a2`, `8db99f9`, `origin/main` (ARCHITECTURE, STACK, FEATURES, PITFALLS Sources).
- Read-only host checks 2026-10-08: `systemctl`, `journalctl`, `ss -ltnp`, `df`, `docker`, tool `--version`s, `solana balance -u devnet`, variable names in `substrate.env` (all four files).
- Repo docs: `docs/{data-planes,coordination,greptime-ledger,memory-governance,mcp-audit,observability,grok-bot}.md`, ADR 0001, `store-lock.test.ts`.

### Secondary (MEDIUM confidence)
- RAGFlow HTTP API and MCP docs; Hindsight API reference; A2A v1.0 specification; Linear rate limiting; Solana faucet and Anza clusters; solana.com memo cookbook (STACK, PITFALLS).
- `npm view` / PyPI version checks (STACK).

### Tertiary (LOW confidence)
- Items marked `[UNVERIFIED]` / `[INFERENCE]` in the source files, listed under Gaps.

---
*Research completed: 2026-10-08*
*Ready for roadmap: yes*
