# USSR integration guide: what Ultrathink, Swarm, Realm and omp do with Substrate in v1.6

**Revised:** 2026-10-26. **Audience:** an operator or an agent reading this first. **Rule of this page:** it points at the one document that owns each fact (last section) instead of restating it. Statements about the sibling repositories are from read-only reads of those repositories and the scout report `/tmp/recon/R9.txt` (a working note, not a repository file); anything not read is marked UNVERIFIED.

USSR here means Ultrathink (planning), Substrate (this repository: memory, ledger, coordination), Swarm (`agent-swarm`, the SDLC agents) and Realm (`agent-realm`, the sandbox). omp is the host most of them run in.

## What v1.6 adds, in four lines

1. **Memory in tandem.** Docs answers can carry the caller's Hindsight memory beside LightRAG chunks, and a brief for a graph can carry recall lines about that graph. Both are off by default.
2. **Live steering.** Two steering mechanisms exist on main: `docs_steering_session` (held in process memory) and the durable, delivered, position-aware steering of phase 58 (merged as PR #137 on 2026-10-28). They do not yet share one state model; the join is open (below).
3. **Checkpoints and rollback.** A session's worktree can be checkpointed and rolled back by a CLI; the server plans, verifies and audits. Memory written after the checkpoint is superseded, not deleted.
4. **Eternal logging.** Every checkpoint and rollback is a ledger event inside an hourly Merkle root that an operator-run job writes to Solana devnet. **No anchor has ever been sent**; the chain is evidence, not storage.

## What each component does with Substrate

| Component | How it reaches Substrate today | v1.6 relevance | Not true / not built |
| --- | --- | --- | --- |
| **Ultrathink** (`claude-ultrathink`) | REST only: `POST /brief` (with `repo`, `branch`, `graph_id`, `surface`) and `POST /events`, 1.5 s default timeout, fail-open (`src/substrate/brief.ts`). No substrate MCP tool calls were found (UNVERIFIED exhaustively). Event session id is `${hostSession}:${graphId}` (`src/claude/hook.ts`). | Its brief carries the `graph_id`, so graph-scoped recall applies to it when enabled. Its events join the ledger and the hourly root. | It takes no checkpoints. A Stop-hook checkpoint is a proposal (`docs/adr/0007-checkpoint-triggers-and-sibling-hooks.md`). |
| **Swarm** (`agent-swarm`) | REST (`/events`, `/memory`, `/brief`) and MCP JSON-RPC at `/mcp`: `graph_register`, `graph_bind`, `graph_claim` and the lease calls, `coord_handoff*`, `events_query`, `memory_search`; 30 `swarm-*` surfaces plus A01 as `swarm-a01-orch`; off unless `SUBSTRATE_URL` is set; fail-open (`swarm/substrate_client.py`). A01's run-start context is `POST /brief` with the graph id (`swarm/memory.py`). | Graph-scoped recall reaches A01's brief. Leases already serialise writers per task node. Rollback of a lane must be run by the **controller**, because the lane guard blocks `git checkout` and `git restore` (`omp/src/guard.ts`). | The lane guard's allowlist of substrate MCP tools does **not** include `session_checkpoint`, `session_rollback_*`, `checkpoint_verify` or `memory_verify` (`omp/src/guard.ts`, `SUBSTRATE_TOOL`), so a lane agent cannot call them today. Swarm takes no checkpoints. |
| **Realm** (`agent-realm`) | **None.** No MCP tool, HTTP call or `SUBSTRATE_*` variable (its spec: "Realm provides seams only"). | None through Substrate. Realm has its **own** devnet anchor of a session's audit-log Merkle root (`src/audit/anchor.ts`, `realm anchor --publish`, dry-run by default, key named by `REALM_ANCHOR_KEY_FILE`). It is complementary evidence, not joined to Substrate's hourly roots (ADR 0007). | No Realm surface exists in `SURFACES` and none may be added. No sandbox snapshot primitive (`docs/integration/openshell.md`, PD-08). |
| **omp** (host) | Traffic from omp is attributed to the surface `omp`. omp has no substrate MCP server in its own configuration per `docs/omp-substrate-status.md` (as written; current state UNVERIFIED), so the CLI is its route to checkpoints. | `substrate session rollback` forks an omp session file to the checkpoint's entry (a new file, the original untouched). | Whether omp resumes the forked file is UNVERIFIED. |
| **GSD-Core** | Runs inside the agents; has no Substrate client. | `--plan-phase` and `--plan-step` carry a plan reference on a checkpoint. | No GSD hook calls the CLI. |

## Data flow

```
 agent session (omp / claude-code / cursor / swarm lane / ...)
   |  worktree files                          memory_write
   |      |                                       |
   |  substrate session checkpoint            governance gate --> memory_entries (TimescaleDB index)
   |      |   pinned git refs (local)               |                 \--> Hindsight document (derived)
   |      |   refs/substrate/checkpoints/*          |
   |      v                                         v
   |  session_checkpoint (MCP) ----> ledger note ----+----> GreptimeDB agent_events (append-only, hash chain)
   |                                                              |
   |  substrate session rollback                                  | hourly: closed hour -> Merkle root
   |   plan:   session_rollback_plan (read-only)                  v
   |   files:  restored locally by the CLI              anchor job (operator-run) --> Solana devnet memo v1
   |   commit: session_rollback_commit --> forgets memory,                              (root + count only)
   |           appends session.rollback                           ^
   |                                                              |
   +-- checkpoint_verify / memory_verify (read-only) -------------+  inclusion proof against the anchored root
 docs_search --> LightRAG chunks (+ Hindsight items when SUBSTRATE_DOCS_TANDEM=on)
 /brief       --> index + cache (+ graph-scoped recall when SUBSTRATE_BRIEF_RECALL_SCOPE=graph)
```

| Step | Writes | Reads | Stored where | Reaches the chain |
| --- | --- | --- | --- | --- |
| Checkpoint | local pinned git ref; one `session.checkpoint` note | the worktree | ref in the worktree's git directory; note in the ledger | inside the hour's root, once anchored |
| Rollback | files (CLI); `memory.forget` and `session.rollback` notes; index row marker; Hindsight document deleted | local refs, the plan from the server | worktree; ledger; index | the notes, inside the hour's root |
| Memory write | index row, Hindsight document, `memory.write` note | gate | index, plane, ledger | the note, via the hour root |
| Capsule export | a file (0600) and optionally a local blob; `memory.capsule.export` note | the caller's `memory_search` | file; ledger | the note only |
| Anchor | an `anchors` row and an `anchor.written` note | closed hours | ledger; devnet | the root and count only |

## The exact commands and tools

CLI (`packages/cli/src/index.ts`; flags in `docs/runbooks/session-rollback.md`):

```
substrate session checkpoint  [--session ID] [--surface S] [--trigger T] [--transcript-ref JSON | --omp-session FILE] [--plan-phase P] [--plan-step S] [--json]
substrate session checkpoints [--session ID] [--surface S] [--offline] [--json]
substrate session rollback <ckpt|seq|previous> [--session ID] [--surface S] [--dry-run] [--force] [--offline] [--json]
substrate session recover | sync
substrate memory capsule export --out FILE [--session S] [--repo R] [--since ISO] [--limit N] [--store DIR] | verify FILE [--anchors] | redact FILE --ids a,b --reason TEXT --out FILE2
substrate consistency verify [--json] [--bank B] [--limit N] [--since ISO] [--repair [--repair-orphans]]
substrate verify <graph_id>          substrate evidence --graph <graph_id>
```

Session exit codes: 0 done, 1 failed, 2 usage, 3 refused (drift, an anchor mismatch, an unknown or foreign target), 4 files restored but the ledger commit is pending (`substrate session sync`).

MCP tools (`packages/mcp-server/src/mcp.ts`): `session_checkpoint`, `session_rollback_plan` (read-only), `session_rollback_commit`, `checkpoint_verify` (read-only), `memory_verify` (read-only), `docs_search`, `docs_steering_session`, `memory_brief`, `memory_search`, `memory_write`, `events_emit`, `events_query`, `graph_*`, `coord_*`. There is **no** standalone forget tool: a forget happens inside `session_rollback_commit` (`service.memoryForget`).

Operator-run scripts (never run by an agent or CI): `packages/mcp-server/src/anchor-run.ts`, `reanchor-plan-run.ts` (read-only), `consistency-run.ts`.

Flags, all default off or inert (names only; the registry is `packages/mcp-server/src/flag-registry.ts`, the reference is `docs/config-reference.md`): `SUBSTRATE_DOCS_TANDEM`, `SUBSTRATE_DOCS_TANDEM_LIMIT`, `SUBSTRATE_DOCS_TANDEM_BUDGET_MS`, `SUBSTRATE_BRIEF_RECALL` (must be `enforce` for scoped recall), `SUBSTRATE_BRIEF_RECALL_SCOPE`, `SUBSTRATE_ANCHOR_SIGNER_SET`, `SUBSTRATE_EVENT_IDEMPOTENCY` (replay dedupe needs `accept` or `enforce`), `SOLANA_RPC_URL`, `SOLANA_ANCHOR_KEYPAIR`, `SOLANA_ANCHOR_PUBKEY`. This guide adds no variable.

## Operator-gated (HARD_STOP; nothing here runs automatically)

- Every live anchor step: the read-only genesis preflight first, then funding the key, the `SOLANA_*` environment lines, installing the timer, the first send, any re-anchor, any signer rotation. **A genesis-hash constant error went unnoticed from phase 28 until 2026-10-26 because no live anchor was ever run**; it is corrected in this milestone (`docs/adr/0006-memo-only-anchoring.md`, which also gives the preflight). `anchor-run.ts --dry-run` is not a genesis check.
- LightRAG deploy, ingest and cutover, and the cost approval for its Postgres service (`docs/runbooks/lightrag-storage-topology.md`).
- Production index migrations (`docs/runbooks/index-migration-rehearsal.md`); migration step 33 belongs to phase 53 (merged as PR #136), and applying it in production is operator-run.
- `substrate consistency verify --repair` and `--repair-orphans` (they write to the production Hindsight plane).
- A live blob bucket for capsules (`S3BlobStore` is unwired; ADR 0003).
- Turning any v1.6 flag on in production (`docs/runbooks/flag-promotion.md`).
- Changes in the sibling repositories: ADR 0007 is proposals only; the owners decide.
- Merging, completing or archiving the milestone.

## Phase 58 steering: merged, state-model join still open

Phase 58 (durable steering, delivery to the session, multi-day liveness, the GSD position model in `planning_status`) is merged to main as PR #137 (2026-10-28), on top of phases 52-54 (PRs #104, #134, #136 and #135, all merged; `.planning/ROADMAP.md`, phase 58 "Status"). Its criterion 2 is still partial, so:

- steering has two mechanisms: the in-memory `docs_steering_session` state machine (ACTIVE, CONTEXT_REFRESH, PAUSED, RESUMED), which is lost on a restart and whose text reaches a session only through the next `docs_search`, and the durable steering inbox;
- the `steering` checkpoint trigger exists as a value and nothing calls it;
- the adapter that joins that state machine to the durable steering inbox is not written yet (gap closure in progress). The rollback code contains no steering code beyond the trigger value.

## Honest limits

- Nothing was rehearsed against the live server or ledger by the work that wrote these documents.
- A checkpoint exists at a boundary only if someone or something ran the command; no hook is installed (ADR 0007).
- Rollback is crash-recoverable and verified, not atomic; it restores file state only (ADR 0005).
- Integrity is not truth: an anchored, verified record can still be wrong (ADR 0003).
- `pending`, `unanchored` and `unverified` are never verdicts of tampering.

## Where each fact is documented (the single place)

| Fact | Owner document |
| --- | --- |
| What each store is, and is never allowed to hold | `docs/adr/0004-store-roles.md`; the operating detail in `docs/data-planes.md` |
| Rollback semantics and its alternatives | `docs/adr/0005-rollback-semantics.md` |
| How to checkpoint, roll back, undo, recover, sync | `docs/runbooks/session-rollback.md` |
| Memo format, proofs, resets, rotation, cost, the genesis finding, live-step gates | `docs/adr/0006-memo-only-anchoring.md` |
| Checkpoint triggers and the sibling hook proposals | `docs/adr/0007-checkpoint-triggers-and-sibling-hooks.md` |
| Event payloads and kinds for `session.*`, `memory.forget`, `memory.capsule.*`, `anchor.*` | `docs/event-vocabulary.md` |
| Anchor outage, devnet reset and re-anchor, signer rotation | `docs/runbooks/{anchor-chain-outage,devnet-reset-and-reanchor,anchor-signer-rotation}.md` |
| Memory identity, capsules, redaction, the limits of immutability | `docs/adr/0003-memory-nexus-design.md`, `docs/runbooks/memory-capsules.md` |
| Cross-store consistency | `docs/runbooks/consistency-verify.md` |
| LightRAG topology and operator preflight | `docs/runbooks/lightrag-storage-topology.md` |
| Tandem recall and docs search flags | `docs/docs-search-ingest.md`; graph-scoped recall in `docs/data-planes.md` |
| Swarm leases, handoffs, memory, tee (in the sibling) | `agent-swarm` `docs/substrate-integration.md` and the four documents it links |
| Environment variables | `docs/config-reference.md` and `packages/mcp-server/src/flag-registry.ts` |
