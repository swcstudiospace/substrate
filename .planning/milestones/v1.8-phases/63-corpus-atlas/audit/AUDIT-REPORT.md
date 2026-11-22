# Run 14 audit

Read-only audit of main at 9d3f2085 that preceded milestone v1.7 (phases 63 to 70). Companion documents: [CAPABILITY-MATRIX.md](CAPABILITY-MATRIX.md), [RISK-REGISTER.md](RISK-REGISTER.md), [ROSTER-PROPOSAL.md](ROSTER-PROPOSAL.md). The plan itself is in [ROADMAP.md](../../../../ROADMAP.md) and [REQUIREMENTS.md](../../../../milestones/v1.8-REQUIREMENTS.md).

## The two answers

### Live Steering: PARTIAL

Live Steering exists on main, in two parts that share one session registry. The tool `docs_steering_session` stores a session state (ACTIVE, CONTEXT_REFRESH, PAUSED, RESUMED) per surface and session id (`packages/mcp-server/src/mcp.ts:1587-1661`, `planning/session-state.ts:32`). The directive inbox is three tools, `steering_queue`, `steering_acknowledge` and `steering_list` (`mcp.ts:2308-2371`). They are registered only while `SUBSTRATE_PLANNING_STEERING` is on. Only a human operator token on an allow-listed principal may queue or acknowledge; agent authors are refused (`planning/steering-tools.ts:143-146`, `steering.ts:6-9`). The limit is 10 directives per minute per target session. An applied `pause` or `redirect` moves the session state through the shared registry (`steering-delivery.ts:94-97`).

What has never run: delivery to a real session. The phase 58 summary says so, and its verification passed on tests with fakes. No hook is installed in any host (`.planning/STATE.md:207,663`; `docs/runbooks/session-rollback.md:97`). The `checkpoint_hint` that an acknowledged directive returns has no reader (`.planning/STATE.md:210`). Production runs release 5cf930a0, which lacks every pull request from #142 on, so part of this code is not deployed.

Why the owner may not have seen it. There is no `substrate` command for it (`packages/cli/src/index.ts:629-731`) and no REST route (`server.ts` has no steering or planning route). There is no view: the only readers are MCP calls such as `steering_list` and `planning_sessions`. The user-facing document set does not mention it: `docs/coordination.md` has no steering text. The durable inbox is off by default (`SUBSTRATE_PLANNING_STEERING_AUDIT_TABLE`, `docs/config-reference.md:112`). Delivery is pull-only: a session sees a directive only when it calls `docs_search` with its `session_id` (`mcp.ts:1547-1550`, `service.ts:5231-5232`). Session state lives in process memory, capped at 1000 sessions, and a restart forgets it (`planning/session-state.ts:26`).

What phase 67 changes: `substrate steer sessions|status|queue|ack|list|listen` over audited REST routes; `session_context`, a bounded digest of the other live sessions of the caller's repository; `memory_brief` sections for sessions, steering and handoffs; a durable `steering_sessions` table behind an opt-in flag; a hook that reads `checkpoint_hint` and a `context` trigger; and `GET /steering/wait` for long-poll delivery. Directive authors stay human. Evidence: [phase 67 CONTEXT](../../67-live-steering-ga/67-CONTEXT.md).

### Worktrees: PARTIAL

Some parts exist. Multi-repo identity handles linked worktrees: `repoOf` reads the `.git` file and the common directory (`packages/mcp-server/src/planning/checkout.ts:126-180`), and presence records carry repo, branch and worktree (`planning/presence.ts:64-89`). The dispatcher creates one worktree per graph, `<root>/<graph_id>` on branch `substrate/<graph_id>`, and refuses to create one when the root filesystem has less than 5 GiB free (`packages/dispatcher/src/substrate_dispatcher/worktree.py:21-24,106-147,23,119-129`). Rollback snapshots exist in `packages/worktree-snapshot`. A drift scan compares git, the ledger and leases per repository (`service.ts:6039`, `drift.ts:230`).

What is missing: nothing registers worktrees, prunes them, forecasts conflicts between them or maps those under the worktrees root. Claims are per graph node, never per file (`index-store.ts:377-390,1014-1089`). The only path-to-graph mapping is a hard-coded root (`packages/collectors/src/worktree-graph.ts:9,20-25`), so the 106 directories under this host's worktrees root map to no graph. Nothing removes a worktree: the scouts found no `git worktree remove`, prune or rmtree in the dispatcher or infra. The doctor excludes worktrees (`docs/runbooks/disk-pressure.md:140-143`). Drift never compares two worktrees. Planning conflicts compare phase and plan ids only (`planning/conflicts.ts`).

What phase 68 changes: `SUBSTRATE_WORKTREE_ROOTS` replaces the hard-coded root; `@substrate/fleet` discovers worktrees with `git worktree list --porcelain`; a `worktrees` registry table; `substrate worktree prune` (dry run until `--execute`), `conflicts` (merge-tree forecast and merge order) and `provision`; one free-disk floor read by the CLI and the dispatcher. Evidence: [phase 68 CONTEXT](../../68-worktree-fleet/68-CONTEXT.md).

## Method and limits

- Six read-only scouts read main at 9d3f2085 in a separate checkout. No secret value was read and nothing was executed against production.
- Scout topics: docs plane, Hindsight, live steering, worktrees, infrastructure planes, change triggers and conventions. The planning documents of v1.7 were then written from their reports.
- Scouts reported what the code and docs say. Where a doc and the code disagree, or the code cannot answer, the item is labelled UNVERIFIED.
- Production access and secrets are operator-held, so live state was not probed. Each item below needs an operator with that access.

| UNVERIFIED item | Why not probed | Command an operator would run |
|---|---|---|
| TEI reachable from this host; model, dimension, batch limit | Substrate has no TEI client; the URL is not in the repository | `curl -fsS "$TEI_URL/health"` and `curl -fsS "$TEI_URL/info"` |
| The Railway Dragonfly service (idle per `docs/data-planes.md`) | Railway access is operator-held; `fabric_status` reports the configured cache, which in production is the loopback redis, not the Railway service | list the Railway project's services with the Railway CLI or MCP (read-only) and read the Dragonfly service's status |
| Greptime and Timescale versions and editions | Needs database credentials | `select version()` over the Greptime SQL endpoint; `psql "$SUBSTRATE_PG_URL" -c "select version()" -c "select extname from pg_extension"` |
| Anchor key funded, timer state | Key is operator-held; no Substrate timer is installed on this host | `systemctl list-timers 'substrate-*'`; run the anchor entry with `--dry-run`; check the balance of `$SOLANA_ANCHOR_PUBKEY` |
| Production flags | Env file holds secrets | list names only: `sed 's/=.*//' <env file>` |
| Production release | Not read | `git -C <release dir> rev-parse HEAD` (Run 12 record says 5cf930a0) |
| LightRAG live state and embedding binding | docs-plane says cut over 2026-10-28; `docs/runbooks/lightrag-storage-topology.md:24` says no LightRAG service exists in any project | `GET /health` on the LightRAG URL; read the server's embedding settings |
| Hindsight document-listing route on 0.9.1; server size limits | Consistency check marks it UNVERIFIED (`consistency-run.ts:507-528`) | `GET {bank}/documents?limit=1` against the pinned server |
| Whether `substrate-docs-refresh` exists as code | Described in docs; scouts found no code in `scripts/` or `packages/cli` | `grep -r docs-refresh infra scripts packages` |
| CI switched on | `docs/ci.md` says off on 2026-10-09 | read repository variable `CI_ENABLED` |

## Platform

- Language and tooling: Bun 1.4.0 and TypeScript in a monorepo; Biome 2.6.3 with zero tolerated diagnostics; Python (miner, dispatcher) run with `uv`.
- Packages (12): audit, cli, collectors, dispatcher, evidence, host, ledger, mcp-server, miner, observability, projector, worktree-snapshot. v1.7 adds `packages/corpus` and `packages/fleet`.
- CI (`docs/ci.md`): six checks in order: install (`bun install --frozen-lockfile`), types (`bunx tsc --noEmit`), lint (`bunx biome lint`), tests (`bun test`), python (miner and dispatcher suites), locks (`bun run check:phase-close`); a dependency audit is opt-in. The runner is self-hosted; the job runs only when repository variable `CI_ENABLED` is `true`. Postgres tests need `SUBSTRATE_TEST_PG_URL` and skip without it.
- Conventions that bind new code:
  - Flag registry: every environment variable read under `packages/` or `scripts/` needs a row in `packages/mcp-server/src/flag-registry.ts`; an unread row fails too; `docs/config-reference.md` is generated.
  - Migrations contract: append-only `MIGRATION_STEPS` (latest step is 34), idempotent, additive, `phase` and `down` text, digest fixture, rollback-compat table (`index-store.migrate-contract.test.ts`, `rollback-compat.test.ts`). Numbers are taken in merge order.
  - Locks: store lock (only `packages/mcp-server/src` holds data-plane clients), redaction lock, closed event vocabulary of 12 kinds, tool registration in audit policy, admission classes and `KNOWN_TOOLS`.
  - Code ratchet: `scripts/code-ratchet.baseline.json` counters may neither rise nor fall without a deliberate rewrite.
  - Strict compiler flags: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`.
- Supervision on this host, as seen on 2026-10-29: the MCP server, three collectors, the dispatcher and a loopback redis are running. No Substrate systemd timer is installed. The units in `infra/vps` (anchor, docs-canary, doctor, index-archive, index-sweep, ledger-archive, skills-sync, skills-bridge) are staged. Production runs release 5cf930a0 per the Run 12 record.

## Memory and docs planes

- Docs plane: LightRAG v1.5.7 (route list in `packages/mcp-server/src/planes/__fixtures__/lightrag-v1.5.7-routes.json`), cut over from RAG-backend per `docs/docs-plane.md`; the RAG-backend code remains (TODO register D-15).
- Naive mode with an LLM bypass: `infra/railway/lightrag-llm-bypass.ts` answers only `<|COMPLETE|>`, so no graph is built, and the runbook requires `SUBSTRATE_LIGHTRAG_QUERY_MODE=naive` with it. Ingestion therefore sends document text to the embedding model only; no extraction LLM sees it. While that stays true, the egress question for an LLM is moot. It returns the day graph modes are enabled.
- One LightRAG workspace holds every dataset; `dataset` is a record-key label (`docs-search.ts` about 1020-1025, `service.ts:5427`).
- Ingest is serial per page: upload, scan, pipeline poll, track status (`planes/lightrag.ts:548-578`). One dataset lock with a 180 s wait. Write admission is 10 requests per second.
- No delete or rename path for removed pages: the plane's delete (`lightrag.ts:892`) is called only by the opt-in supersede prune (`docs-ingest.ts:1568-1580`). A rename is a new source URL and the old document stays.
- Provenance stored: `source_url`, `commit`, `heading_path` only. No repository, path or kind field; `repo_id` on search tags the cache entry and events, and retrieval is not filtered by repository.
- No retrieval feedback is recorded; the only trace of a search is a `docs.search` note listing returned URLs.
- Hindsight is pinned to 0.9.1 (`.github/hindsight-pin.json:2-7`; 0.10.x blocked by an upstream recall hang). Calls used by `planes/hindsight.ts`: retain (`POST {bank}/memories`, `document_id`, `update_mode` replace, chunks extraction mode), recall (`POST {bank}/memories/recall`, 4 hits per bank), document get, delete and tag patch, bank create, config and stats, health and version. Outside the client file: weekly mental-model refresh for models that already exist (`mental-model-refresh.ts:129`).
- Hindsight features unused: reflect, mental-model creation and reading, observation management, directives, entities and graph, operation polling, disposition and mission.
- Hindsight holds derived memory only; LightRAG is the live docs plane (`docs/memory-governance.md:594`).

## Resources

| Resource | Used for today | Client module | Constraints |
|---|---|---|---|
| Solana devnet | Hourly anchor of the ledger's event hashes | `packages/ledger/src`, `mcp-server/src/anchor.ts`, `anchor-run.ts` | Memo `substrate:v1:<period_start_iso>:<root_hex64>:<count>` for a whole UTC hour (`memo.ts:1-8`); 24 hours per run, 7-day lookback; gated by a funded keypair file, a devnet URL guard, a genesis check and a balance check; the unit `infra/vps/substrate-anchor.timer` is not installed here; devnet can reset |
| GreptimeDB | Event ledger (`agent_events`, `event_ingest`, `anchors`, `substrate_health`, `metric_samples`) | `mcp-server/src/greptime.ts` | Append-only: only select, insert, create, show pass `assertAppendOnly`; `metric_samples` exists only with `SUBSTRATE_METRICS_HISTORY=on`; store lock confines the client |
| TimescaleDB index | Graph index, nodes, edges, memory, skills registry, planning steering audit | `mcp-server/src/index-store.ts` | Plain Postgres: no extension, hypertable or vector column (`data-planes.md`: 0 hypertables measured); LightRAG has its own separate pgvector Postgres |
| DragonflyDB | Read-through cache, admission buckets, event bus, planning presence | `cache.ts`, `event-bus.ts`, `admission.ts`, `planning/presence-dragonfly.ts` | Cache-only by owner decision (no queues, locks or sessions); production uses a loopback redis with 256 MB and `volatile-lru`, no persistence (`infra/vps/redis-substrate.conf`); every non-counter key needs a TTL; the Railway Dragonfly is idle |
| TEI | Nothing in Substrate; LightRAG inside Railway may use it | none | No client, env name or fabric row; a TEI cpu-1.8 service sits in the Railway project (`docs/runbooks/lightrag-storage-topology.md:21-22`); model, dimension and batch limit unverified |

The anchor covers ledger event hashes. A corpus root can ride it only as a ledger event; a new memo format would be a new design, so phase 69 does not add one.

## Corpus

Measured on 2026-10-29, names and sizes only:

| Measure | Value |
|---|---|
| Directories in the repositories directory | 110 |
| Git checkouts / distinct origins | 72 / 44 |
| Non-repository directories (including three worktree and copy collections) | 38 |
| Documentation files (markdown, mdx, rst, adoc) / size | 63,063 / 727 MB |
| Under `.planning/` | 20,358 in 26 directories |
| Under `docs/` | 1,603 |
| Files in the three copy collections | 31,465 |
| GitHub, swcstudiospace | 242 repositories, 165 private, 8 archived |
| GitHub, SomeRandmGuyy | 171 repositories, 69 private |
| Greptile knowledge bases | 23 repositories |
| Directories under the worktrees root | 106 |
| Root filesystem at the start of the run | 98 percent used |

Greptile export: all 23 knowledge bases were exported to a staging directory outside the repository, 486 documents in 6.6 MB, 0 failures; each file was checked against the character count Greptile declared and none was truncated.

Implications:
- About half the files (31,465 of 63,063) sit in copy collections, so de-duplication by origin and content hash comes before anything else.
- `.planning/` holds 32 percent of the files (20,358). Most are phase plans and archives, so tiering is needed (tier 1 and 2 by default).
- A naive ingest is infeasible: one page at a time with a serial pipeline wait would take days at the 10 requests per second write budget, and the 98 percent full disk leaves no room for a second copy. Phase 63 therefore tiers, de-duplicates, batches through `POST /documents/texts` and tombstones.

## Decisions asked of the owner

| Gate | Question | Default if not answered |
|---|---|---|
| (a) Roster and targets | Accept the eight features in [ROSTER-PROPOSAL.md](ROSTER-PROPOSAL.md)? Freshness targets | The eight; 2 minutes p95 for a local edit, 5 minutes for a remote-only push, 15 minutes self-heal |
| (b) Corpus scope and egress | Which documents go in; may text leave the host | Tier 1 and 2 documents of the 44 origins on this host plus the Greptile export; archived repositories out; no extraction LLM is called in naive mode, text goes to embeddings only |
| (c) Backfill budget | Document and byte ceiling for the first run | Set from the `substrate corpus plan` dry-run estimate after phase 63 merges; no token cost in naive mode. Upper bound before tiering: 63,063 files, 727 MB |
| (d) Steering policy | Who may steer, what may a hook do | Advisory only; directives stay human and operator-only; installing the hook is the operator's step |
| (e) Worktree mutation | May the tool remove worktrees | Report and propose only; removal only by an operator command with `--execute` |

Everything else in v1.7 that touches production (deploy, timers, hooks, the live ingest, anchor funding) remains an operator step.
