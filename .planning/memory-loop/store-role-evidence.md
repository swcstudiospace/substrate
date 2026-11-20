# Store role evidence for the memory loop

Scope: read-only discovery. Specification of record: `/root/.omp/agent/ultrathink/sessions/01a1d01f-29fb-745f-a2d2-9bce5b3f2926.xml` (Graph ut-f35e12d58f-ed1087ea). Repository: `/root/src/repos/agent-substrate`. No tests, typecheck, lint or formatters were run.

Membership test used below: a store is `confirmed` as a memory-loop member only when code or docs show it holds or is the authority for governed memory (memory entries, recall banks, or the candidate/Context Matrix rows), or sits on the memory write or recall path in a way that changes what memory returns. Otherwise `unconfirmed`, with the reason.

## 1. Quoted spec text

### Mapping A (spec line 313)

> Define Mapping A (specialist roles): LightRAG holds graph structure, DragonflyDB the hot cache, GreptimeDB telemetry, TimescaleDB recall and teachable-moment records, and Hindsight the Context Matrix. Hindsight's actual capabilities are unverified, so this mapping is a candidate until the repo confirms them.

### Mapping B (spec line 314)

> Define Mapping B (authority-consolidated): TimescaleDB is the durable system of record for the Context Matrix, teachable-moment records, and candidate staging as append-only rows with a status column. LightRAG holds graph structure only and is rebuildable from .planning documents. DragonflyDB is cache only, GreptimeDB holds telemetry, and Hindsight is an index derived from the authoritative store.

Spec line 319 records Mapping B as the "Recommended candidate, pending the repo check".

### Gate G1 (spec line 384)

> G1 (blocks store wiring for Tracks 03, 04, and 06): confirm which three of the five databases form the memory loop, the role of Hindsight, and Mapping A or Mapping B. Default: hold all Wave 3 units and W4-B; the memory read path falls back to .planning files and the Context Matrix file only, and output is marked degraded. Tracks 01, 02, 05, and 07 continue.

## 2. Repository references (rg -c, term match, case-insensitive, over `packages/` and `scripts/`, node_modules excluded)

Counts are matching lines summed across files, and include tests and fixtures. They measure how much the name appears, not whether it is a memory-loop member.

| Store | Term | Matching lines | Files |
|---|---|---|---|
| DragonflyDB | `dragonfly` | 383 | 50 |
| TimescaleDB | `timescale` | 28 (of which `timescaledb` 25) | 15 |
| GreptimeDB | `greptime` | 2399 (of which `greptimedb` 13) | 204 |
| Hindsight | `hindsight` | 1789 | 129 |
| LightRAG | `lightrag` | 2475 | 121 |

TimescaleDB is the lowest count, but its code is named by its role (`index-store.ts`, `SUBSTRATE_PG_URL`, "Postgres index"), so the term count understates it. The docs call the index "plain Postgres tables, no hypertables" (`docs/data-planes.md:27`), so the term "timescale" is not a reliable proxy for the store.

## 3. Per-store evidence

### 3.1 DragonflyDB

- **Role per code:** `packages/mcp-server/src/cache.ts:2-6`: "Dragonfly read-through cache. ... Cache only." It also says "Nothing here is a queue, a lock, a session or a pub/sub channel". `cache.ts:84` defines `MEMORY_GENERATION_KEY`, so memory writes invalidate cached memory reads through a generation counter.
- **Role per docs:** `docs/data-planes.md:4` ("2026-09-26 (Dragonfly is a cache, not a queue)"); `docs/data-planes.md:28` (Cache row: brief, memory search, graph view, brief snapshot, budgets); `docs/data-planes.md:224` ("Dragonfly holds no authoritative state").
- **Deployment note:** `docs/data-planes.md:16` and `:113` say the Railway Dragonfly is idle and production uses a co-located loopback redis for the cache. This does not change the cache role.
- **Membership:** `unconfirmed`. Docs and code establish a cache role, not a store of governed memory. It sits on the memory read path only as a cache of memory-search and brief results.

### 3.2 TimescaleDB (plain Postgres index, reached via `SUBSTRATE_PG_URL`)

- **Role per docs:** `docs/data-planes.md:27` ("Index: plain Postgres tables ... governance tables `memory_entries`, `memory_writes` (idempotency ledger), `memory_reviews`, `memory_quarantine` ... written by `substrate-mcp` only (`memory_write`, the governance gate)"). `docs/data-planes.md:29` (Memory row: "Postgres index inside Timescale ... Index rows follow the governance gate").
- **Role per code:** `packages/mcp-server/src/index-store.ts:455-465` creates `memory_entries`. `index-store.ts:495` creates `memory_writes`, `:517` creates `memory_quarantine`, `:538` creates `memory_reviews`.
- **Candidate staging and Context Matrix:** `index-store.ts:1067` ("Context matrix entries: one row per candidate decision, fact, warning or todo extracted from a planning source document"). `index-store.ts:1078` creates `context_matrix_entries`. `index-store.ts:2600` inserts candidates. `index-store.ts:2620` moves a row `status = 'candidate'` to `status = 'accepted'`, so the status column exists in the code.
- **Governed store statement:** `docs/memory-governance.md:594` ("The index is the governed store; Hindsight holds a *derived* copy of every accepted entry").
- **Teachables:** `docs/agent-cards.md:5-6` (a teachable is a governed `fact` with subject `teachable:`, written through `memory_write`). `packages/mcp-server/src/teachable.ts:1-10` says the same. Teachables therefore live in `memory_entries`, the Timescale index. `docs/greptime-ledger.md:531` lists each teachable's `event_id` and anchor status in the ledger's evidence bundle, which records that a teachable is anchored, not where its content is stored.
- **Membership:** `confirmed`. Code and docs both establish the index as the authoritative store for memory entries, Context Matrix rows, and teachable records.

### 3.3 GreptimeDB

- **Role per code:** `packages/mcp-server/src/greptime.ts:4-5`: "Greptime holds the append-only event ledger and nothing else. It is not the source of record for memory — that is the Postgres/Timescale index".
- **Role per docs:** `docs/data-planes.md:26` (Events: `agent_events`, append-only with hash chain, 180-day retention). Every write and read goes through `substrate-mcp` (`packages/mcp-server/src/greptime.ts:6-7`).
- **Membership:** `unconfirmed`. The code comment explicitly denies a memory source-of-record role. The docs place it in the ledger/event plane. It may record memory events, but a record of an event is not a memory store.

### 3.4 Hindsight

- **Role per docs, recall and derived copy:** `docs/memory-governance.md:594-599`: "The index is the governed store; Hindsight holds a *derived* copy of every accepted entry". `memory_recall` and the list form of `memory_search` "fan out over the substrate's `sub-*` banks ... and append each hit *after* the index rows with `derived: true`".
- **Role per docs, banks written by the desk:** `docs/data-planes.md:17` (Hindsight, memory / recall). `docs/data-planes.md:39-46` (bank table: `sub-<surface>` written by the surface through the substrate; `pd-desk`, `pd-<seat>`, `pd-lead-reports` written by the Programming Desk gateway). `docs/data-planes.md:46`: "`memory_write` accepts into the Postgres index and forwards gate-accepted memories to the writer's bank", and "Hindsight's own Postgres is its private store and is not read by anything else".
- **Role per code:** `packages/mcp-server/src/planes/hindsight.ts:1-9`: reached only through `substrate-mcp` (D26-01). Recall fans out over explicit `sub-*` banks. `hindsight.ts:12-17` says the client is ported from the ultrathink client and that "recall inside the brief [is] deliberately not ported".
- **Role statement:** Hindsight is the recall plane for memory. For substrate memory it is a *derived* index: a copy of gate-accepted index entries, read at recall time and merged after the index rows. For the Programming Desk it is also a separately written bank. It is not an authority for governed memory.
- **Membership:** `confirmed` as a recall-path member of the memory loop (docs above; `memory_search`, `memory_recall`, and the brief recall path in `docs/data-planes.md:50-62`). This confirms its role as derived, not as authoritative.
- **Context Matrix:** no evidence that Hindsight holds Context Matrix rows. Search for `context matrix` / `contextMatrix` across `packages/mcp-server/src` (non-test) returned only `index-archive-spec.ts:213` and `index-store.ts:1067-2620`, all in the Timescale index. `planes/hindsight.ts` contains no Context Matrix reference.

### 3.5 LightRAG

- **Role per docs:** `docs/data-planes.md:18` and `:30` ("Documents + Planning Graph: repo docs, .planning/ ... LightRAG is the live docs plane since 2026-10-28 (Run 11) ... retrieval in naive mode"). `docs/data-planes.md:115` and `:236` (LightRAG is read by `substrate-mcp` `planes/lightrag.ts`; graph and hybrid modes wait on an operator LLM decision).
- **Role per code:** `packages/mcp-server/src/planes/lightrag.ts:1-20`: the client `POST /query` with modes including `hybrid` and `mix` (graph modes), and `POST /documents/upload` for ingest. It holds documents and the planning graph, not governed memory.
- **Read-path code:** `packages/mcp-server/src/tandem-recall.ts:2-5` (phase 57c): "LightRAG chunks and Hindsight memory in ONE answer, with provenance". This is a read-time merge in a docs answer, so LightRAG touches the recall path. I did not verify that the production docs path calls `mergeTandem`.
- **Graph structure:** Mapping A and B both say LightRAG "holds graph structure". Docs say the planning graph exists, but graph and hybrid modes are not enabled in production (`docs/data-planes.md:30`, `:115`). Graph structure is therefore not confirmed as used in production.
- **Membership:** `unconfirmed` as a store in the memory loop. It holds documents and planning-graph hints, not governed memory. It touches the recall read path only through the tandem merge.

## 4. Hindsight role (stated)

Hindsight is the recall plane. For substrate memory it is a derived index of gate-accepted entries, which the index is authoritative over (`docs/memory-governance.md:594-599`; `docs/data-planes.md:46`). For the Programming Desk it is also a separately written bank (`docs/data-planes.md:39-46`). It holds no Context Matrix rows (see 3.4).

## 5. Which mapping the evidence supports

**Evidence supports Mapping B, with two Mapping A claims contradicted.** Specifically:

1. **TimescaleDB as system of record (B: yes; A: partly).** The index is the governed authority for `memory_entries`, `memory_writes`, `memory_reviews`, `memory_quarantine`, and Context Matrix rows with a status column that moves `candidate` to `accepted` (`index-store.ts:455, 495, 517, 538, 1067-1078, 2600, 2620`; `docs/memory-governance.md:594`). Mapping A says TimescaleDB holds "recall ... records", but in the code recall reads from Hindsight and the index merges the two (`docs/memory-governance.md:594-599`). Mapping A's "recall" role is not supported as a Timescale role.
2. **Hindsight as derived index (B: yes; A: contradicted).** Mapping A says Hindsight holds "the Context Matrix". The code has no Hindsight path for Context Matrix rows (see 3.4). Mapping B's "derived index" matches `docs/memory-governance.md:594-595`.
3. **DragonflyDB cache only (B: yes; A: partly).** Mapping A's "hot cache" agrees with the cache role, but Mapping B's "cache only" is the stronger statement and matches `cache.ts:2-6` and `docs/data-planes.md:224`.
4. **GreptimeDB telemetry (A and B: yes).** `greptime.ts:4-5` and `docs/data-planes.md:26`.
5. **LightRAG graph structure (A and B: partly).** Docs describe documents and a planning graph, rebuilt on merge (`docs/data-planes.md:30`). Mapping B's "rebuildable from .planning documents" matches the re-ingest rule in that row, though "rebuildable" as a word is not used there. Graph modes are not on in production, so "graph structure only" is not confirmed.
6. **Teachable-moment records (B: yes; A: partly).** Teachables are `memory_entries` facts in the Timescale index (`docs/agent-cards.md:5-6`; `teachable.ts:1-10`), so Timescale holds them as Mapping B says. Mapping A says the same for "recall and teachable-moment records" but also puts recall there.

**Conclusion:** Mapping B is the mapping the repository supports. This is evidence, not a decision: G1 still requires the operator to confirm it (spec line 384).

## 6. What G1 needs that the evidence cannot settle

- **Confirmed memory-loop members:** TimescaleDB (index) and Hindsight (recall, derived). That is two of the three.
- **Third member:** `unconfirmed` for all remaining stores. DragonflyDB is a cache, GreptimeDB is the event ledger (its code denies a memory role), and LightRAG holds documents and planning hints with a read-time tandem merge. None is established as a memory store. The operator must choose the third, or confirm that the loop is two stores plus a cache.
- **Hindsight role:** stated in section 4 and supported by the docs. The operator must confirm it.
- **Mapping:** Mapping B supported; the operator must confirm.

Unresolved: whether `mergeTandem` is on the production docs path; whether graph modes of LightRAG will be enabled; whether the Railway Dragonfly will be repurposed (`docs/data-planes.md:113`, an operator decision).
